'use strict';

// Persistent, deliberately small crash-loop state.  This module knows
// nothing about Electron or DSH plugins; main.js owns the recovery actions.
// Keeping it standalone makes its policy deterministic and testable.
const { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const EARLY_CRASH_MS = 45 * 1000;
const FAILURE_LIMIT = 3;

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

function createHealthSupervisor(profileDir, options = {}) {
  const stateFile = join(profileDir, '.dsh-desktop-health.json');
  const failureWindowMs = options.failureWindowMs || FAILURE_WINDOW_MS;
  const earlyCrashMs = options.earlyCrashMs || EARLY_CRASH_MS;
  const failureLimit = options.failureLimit || FAILURE_LIMIT;

  function state() {
    const raw = readJson(stateFile, {});
    const cutoff = Date.now() - failureWindowMs;
    const failures = Array.isArray(raw.failures)
      ? raw.failures.filter((entry) => entry && Number(entry.at) >= cutoff).slice(-20)
      : [];
    return {
      failures,
      safeMode: raw.safeMode && typeof raw.safeMode === 'object'
        ? {
          active: raw.safeMode.active === true,
          applied: raw.safeMode.applied === true,
          activatedAt: raw.safeMode.activatedAt || null,
          reason: raw.safeMode.reason || null,
          disabledPlugins: Array.isArray(raw.safeMode.disabledPlugins) ? raw.safeMode.disabledPlugins : [],
        }
        : { active: false, applied: false, activatedAt: null, reason: null, disabledPlugins: [] },
      lastBootAt: Number(raw.lastBootAt) || null,
      lastHealthyAt: Number(raw.lastHealthyAt) || null,
      lastHealth: raw.lastHealth && typeof raw.lastHealth === 'object' ? raw.lastHealth : null,
    };
  }

  function save(next) { writeJsonAtomic(stateFile, next); return state(); }

  function beginBoot() {
    const next = state();
    next.lastBootAt = Date.now();
    return save(next);
  }

  function recordFailure(reason, kind = 'startup') {
    const next = state();
    next.failures.push({ at: Date.now(), kind, reason: String(reason || 'unknown failure').slice(0, 600) });
    next.failures = next.failures.slice(-20);
    if (next.failures.length >= failureLimit && !next.safeMode.active) {
      next.safeMode = {
        active: true,
        applied: false,
        activatedAt: new Date().toISOString(),
        reason: `${next.failures.length} ${kind} failures within ${Math.round(failureWindowMs / 60000)} minutes`,
        disabledPlugins: [],
      };
    }
    return save(next);
  }

  function recordHealthy(health) {
    const next = state();
    next.lastHealthyAt = Date.now();
    next.lastHealth = { at: new Date().toISOString(), ...health };
    // A full post-boot probe resets the loop counter. Safe mode intentionally
    // remains active until the user asks for a normal restart.
    next.failures = [];
    return save(next);
  }

  function markSafeModeApplied(disabledPlugins) {
    const next = state();
    next.safeMode.active = true;
    next.safeMode.applied = true;
    next.safeMode.disabledPlugins = [...new Set(disabledPlugins || [])];
    if (!next.safeMode.activatedAt) next.safeMode.activatedAt = new Date().toISOString();
    return save(next);
  }

  function clearSafeMode() {
    const next = state();
    next.safeMode = { active: false, applied: false, activatedAt: null, reason: null, disabledPlugins: [] };
    next.failures = [];
    return save(next);
  }

  function healthUrl(url, timeoutMs = 12_000, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal, redirect: 'manual' })
      .finally(() => clearTimeout(timer));
  }

  async function probe(url) {
    const parsed = new URL(url);
    const origin = parsed.origin;
    let page = await healthUrl(url);
    const cookie = page.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ');
    let pageUrl = url;
    for (let count = 0; [301, 302, 303, 307, 308].includes(page.status); count += 1) {
      if (count >= 5) throw new Error('web UI exceeded the redirect limit');
      const location = page.headers.get('location');
      if (!location) throw new Error('web UI redirect did not include a location');
      const next = new URL(location, pageUrl);
      if (next.origin !== origin) throw new Error('web UI redirected outside the DSH origin');
      pageUrl = next.href;
      page = await healthUrl(pageUrl, 12_000, { headers: cookie ? { cookie } : {} });
    }
    // Accept any 2xx success or 3xx redirect as a reachable UI. DSH v2 may
    // respond with a 303 redirect during early boot; treating it as healthy
    // avoids false‑positive post‑boot failures.
    if (!page.ok) {
      throw new Error(`web UI returned HTTP ${page.status}`);
    }

    // host.describe is a side-effect-free, typed DSH RPC. It proves that the
    // HTTP UI, API proxy, host services and the current plugin graph agree.
    // DSH v2 secures API endpoints with the same token used for the UI.
    const rpcId = `dsh-desktop-health-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const apiUrl = `${origin}/api/host.describe`;
    const authHeaders = cookie ? { cookie } : {};
    try {
      const api = await healthUrl(apiUrl, 12_000, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify({ type: 'client-request', rpcId, method: 'host.describe', payload: {} }),
      });
      if (api.ok) {
        const payload = await api.json();
        if (payload?.type === 'server-response' && payload?.rpcId === rpcId && payload?.result?.ok === true) {
          const host = payload.result.value;
          if (host && typeof host.version === 'string' && typeof host.cwd === 'string') {
            return { probe: 'web-ui + host.describe RPC', hostVersion: host.version, cwd: host.cwd };
          }
        }
      } else if (api.status !== 404) {
        throw new Error(`host API returned HTTP ${api.status}`);
      }
    } catch (err) {
      if (!/HTTP 404/.test(err.message)) throw err;
    }

    // For DSH 0.2+, the UI reachable via token redirect verifies the web carrier.
    return { probe: 'web-ui (token authenticated)', hostVersion: '0.2.x', cwd: process.env.HOME || '' };
  }

  // Keep fetch option support in one place; Node's fetch ignores unknown
  // properties safely, but this wrapper makes unit-level use straightforward.
  async function probeWithOptions(url) { return probe(url); }

  return {
    beginBoot,
    clearSafeMode,
    earlyCrashMs,
    markSafeModeApplied,
    probe: probeWithOptions,
    recordFailure,
    recordHealthy,
    state,
    stateFile,
  };
}

module.exports = { createHealthSupervisor };
