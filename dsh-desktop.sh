#!/usr/bin/env bash
# dsh-desktop.sh — launcher used by the Electron wrapper to start DSH web.
# Bundled next to main.js so we can set the env (PATH, NINEROUTER_API_KEY)
# exactly the way the desktop app expects, without polluting shell rc files.
set -euo pipefail

DSH_DESKTOP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Ensure common toolchain locations are in PATH (Electron inherits a stripped env).
export PATH="$HOME/.bun/bin:$HOME/.nvm/versions/node/$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin${PATH:+:$PATH}"

# 9router (which jessen uses as the LLM provider) needs this URL exported.
export NINEROUTER_BASE_URL="${NINEROUTER_BASE_URL:-http://localhost:20128/v1}"
export NINEROUTER_API_KEY="${NINEROUTER_API_KEY:-not-required}"

# dsh web reads its config from $DSH_HOME (defaults to ~/.dsh).
export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

# The Electron updater stores its selected version outside the app bundle so
# upgrades and rollbacks remain writable even for packaged builds.
DSH_RUNTIME_FILE="$DSH_HOME/profiles/electron/.dsh-desktop-runtime.json"
DSH_DESKTOP_VERSION="$(node -e '
  try {
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (typeof value.currentVersion === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.currentVersion)) {
      process.stdout.write(value.currentVersion);
    }
  } catch {}
' "$DSH_RUNTIME_FILE")"
DSH_DESKTOP_VERSION="${DSH_DESKTOP_VERSION:-0.1.1-rc.2}"

# Materialize DSH into the wrapper's persistent, versioned runtime store, then
# point every profile-local official host package at that exact installation.
# `bunx` is only a downloader now: /tmp/bunx-* is never used to run DSH.
DSH_INSTALL_DIR="$(node "$DSH_DESKTOP_DIR/runtime-store.js" --materialize "$DSH_DESKTOP_VERSION" | node -e '
  let source = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { source += chunk; });
  process.stdin.on("end", () => {
    try {
      const value = JSON.parse(source);
      if (typeof value.dshInstallDir === "string") process.stdout.write(value.dshInstallDir);
      else process.exitCode = 1;
    } catch { process.exitCode = 1; }
  });
')"
if [[ -z "$DSH_INSTALL_DIR" ]]; then
  echo "dsh-desktop: could not locate materialized DSH $DSH_DESKTOP_VERSION" >&2
  exit 1
fi
node "$DSH_DESKTOP_DIR/runtime-unifier.js" --apply "$DSH_HOME/profiles/electron" "$DSH_INSTALL_DIR" >/dev/null

# Launch the already-materialized binary directly. Calling bunx again here
# needlessly repeats its install/resolve phase and could select a different
# physical module graph than the one unified above.
DSH_BIN_RELATIVE="$(node -e '
  const manifest = require(process.argv[1]);
  const value = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.dsh;
  if (typeof value === "string") process.stdout.write(value);
' "$DSH_INSTALL_DIR/package.json")"
if [[ -z "$DSH_BIN_RELATIVE" || ! -f "$DSH_INSTALL_DIR/$DSH_BIN_RELATIVE" ]]; then
  echo "dsh-desktop: could not locate the DSH executable in $DSH_INSTALL_DIR" >&2
  exit 1
fi
exec node "$DSH_INSTALL_DIR/$DSH_BIN_RELATIVE" --profile electron --no-open --port 0
