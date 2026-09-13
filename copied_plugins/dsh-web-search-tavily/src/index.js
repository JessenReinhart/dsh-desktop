import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { WebError } from "@deepseek-ai/dsh-web";

/** Stable provider id used by the web seam. */
const TAVILY_PROVIDER_ID = "tavily";

/** Cordis plugin name used by loader diagnostics. */
const name = "web-search-tavily";

/** The web seam this provider registers into. */
const inject = ["web"];

const DEFAULT_API_KEY_ENV = "TAVILY_API_KEY";
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_SEARCH_DEPTH = "basic";
const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const USER_AGENT = "deepseek-harness/dsh-web-search-tavily/0.1.0";

const Config = z.object({
  apiKey: z.string().role("secret").default(""),
  apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV),
  maxResults: z.number().step(1).min(1).max(20).default(DEFAULT_MAX_RESULTS),
  searchDepth: z.string().default(DEFAULT_SEARCH_DEPTH),
});

const WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE = settingsNamespace("web-search-tavily");

/**
 * Project one resolved section into the options the provider serves its next
 * search with. The literal `apiKey` wins over `resolveApiKey`; the credentials
 * seam wins over the process environment.
 */
function resolveOptions(ctx, config) {
  const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV);
  const literalApiKey =
    config.apiKey !== undefined && String(config.apiKey).length > 0
      ? String(config.apiKey)
      : undefined;
  return {
    ...(literalApiKey === undefined ? {} : { apiKey: literalApiKey }),
    resolveApiKey: async () => {
      const credentials = ctx.get("credentials");
      if (credentials !== undefined) {
        const resolved = await credentials.resolve(apiKeyEnv);
        if (resolved && resolved.value && resolved.value.length > 0) return resolved.value;
      }
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv);
      if (ambient !== undefined && ambient.value.length > 0) return ambient.value;
      return undefined;
    },
    apiKeyEnv,
    maxResults: config.maxResults ?? DEFAULT_MAX_RESULTS,
    searchDepth: config.searchDepth ?? DEFAULT_SEARCH_DEPTH,
    recordRequest: (request) => {
      ctx.get("agents")?.currentInitiator()?.session.append("web/tavily-search-request", request);
    },
  };
}

/** Throw the provider's stable cancellation error. */
function searchAborted(signal, fallback) {
  return new WebError("Tavily search aborted", "WEB_ABORTED", {
    cause: signal?.aborted === true ? signal.reason : fallback,
  });
}

function throwIfSearchAborted(signal) {
  if (signal?.aborted === true) throw searchAborted(signal);
}

function isAbortError(error) {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Map a parsed Tavily response into the seam's normalized result shape. */
function mapTavilyResponse(payload) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const sources = [];
  for (const item of results) {
    if (typeof item?.url !== "string" || item.url.length === 0) continue;
    const source = { url: item.url };
    if (typeof item.title === "string" && item.title.length > 0) source.title = item.title;
    if (typeof item.content === "string" && item.content.length > 0) source.snippet = item.content;
    if (typeof item.published_date === "string" && item.published_date.length > 0) {
      source.publishedAt = item.published_date;
    }
    sources.push(source);
  }
  return { sources, truncated: false };
}

/** The Tavily-backed search provider. */
class TavilySearchProvider {
  resolveOptions;
  id = TAVILY_PROVIDER_ID;

  constructor(resolveOptions) {
    this.resolveOptions = resolveOptions;
  }

  available() {
    const options = this.resolveOptions();
    const hasKey =
      (typeof options.apiKey === "string" && options.apiKey.length > 0) ||
      typeof options.resolveApiKey === "function";
    return hasKey && Number.isInteger(options.maxResults) && options.maxResults > 0;
  }

  async search(request, signal) {
    const options = this.resolveOptions();
    throwIfSearchAborted(signal);
    const apiKey = await this._apiKey(options, signal);
    throwIfSearchAborted(signal);
    const body = {
      api_key: apiKey,
      query: request.query,
      max_results: options.maxResults,
      search_depth: options.searchDepth,
    };
    options.recordRequest?.({
      endpoint: TAVILY_ENDPOINT,
      body: { ...body, api_key: "<redacted>" },
    });
    throwIfSearchAborted(signal);
    let response;
    try {
      response = await fetch(TAVILY_ENDPOINT, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "accept": "application/json",
          "user-agent": USER_AGENT,
        },
        body: JSON.stringify(body),
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) {
        throw searchAborted(signal, error);
      }
      throw new WebError(`Tavily search request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
    }
    if (!response.ok) {
      let detail = `Tavily API error (HTTP ${response.status})`;
      try {
        const parsed = await response.json();
        if (typeof parsed?.detail === "string" && parsed.detail.length > 0) detail = parsed.detail;
        else if (typeof parsed?.error === "string" && parsed.error.length > 0) detail = parsed.error;
      } catch {
        // ignore body parse errors
      }
      throw new WebError(detail, "WEB_PROVIDER_ERROR");
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
      throw new WebError(`Tavily returned an unprocessable response body: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
    }
    const mapped = mapTavilyResponse(payload);
    if (request.maxResults !== undefined && mapped.sources.length > request.maxResults) {
      return {
        sources: mapped.sources.slice(0, request.maxResults),
        truncated: true,
      };
    }
    return mapped;
  }

  async _apiKey(options, signal) {
    throwIfSearchAborted(signal);
    if (typeof options.apiKey === "string" && options.apiKey.length > 0) return options.apiKey;
    const resolved = await options.resolveApiKey?.();
    if (typeof resolved === "string" && resolved.length > 0) return resolved;
    throw new WebError(
      `Tavily search has no API key for "${options.apiKeyEnv ?? DEFAULT_API_KEY_ENV}"; store it through the credentials service, export it in the launching environment, or set a literal "apiKey" in the web-search-tavily config`,
      "WEB_PROVIDER_CREDENTIAL_MISSING"
    );
  }
}

/** Register the Tavily search provider with `ctx.web`. */
function apply(ctx, config) {
  let current = () => config;
  installSettingsSection(ctx, WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => {
      current = source;
    },
    onChange: () => {},
  });
  ctx.web.registerSearchProvider(
    new TavilySearchProvider(() => resolveOptions(ctx, current()))
  );
}

export {
  Config,
  DEFAULT_API_KEY_ENV,
  DEFAULT_MAX_RESULTS,
  DEFAULT_SEARCH_DEPTH,
  TAVILY_PROVIDER_ID,
  TavilySearchProvider,
  WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE,
  apply,
  inject,
  mapTavilyResponse,
  name,
};
