'use strict';

const {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} = require('node:fs');
const { dirname, join } = require('node:path');

const OFFICIAL_BUNDLES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
]);

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === 'string' && value))];
}

function createPluginGuard(profileDir) {
  const packageFile = join(profileDir, 'package.json');
  const marketStateFile = join(profileDir, '.dsh-market', 'state.json');
  const guardStateFile = join(profileDir, '.dsh-desktop-plugin-guard.json');

  function manifest() {
    const value = readJson(packageFile, null);
    if (!value || typeof value !== 'object') throw new Error(`invalid profile manifest: ${packageFile}`);
    value.dependencies ??= {};
    value.dsh ??= {};
    value.dsh.profile ??= {};
    value.dsh.profile.bundles = uniqueStrings(value.dsh.profile.bundles);
    return value;
  }

  function guardState() {
    const value = readJson(guardStateFile, {});
    return {
      disabled: value && typeof value.disabled === 'object' && !Array.isArray(value.disabled)
        ? value.disabled
        : {},
      lastHealthyBundles: uniqueStrings(value?.lastHealthyBundles),
      lastHealthyVersions: value && typeof value.lastHealthyVersions === 'object'
        ? value.lastHealthyVersions
        : {},
      lastHealthyAt: typeof value?.lastHealthyAt === 'string' ? value.lastHealthyAt : null,
    };
  }

  function marketState() {
    const value = readJson(marketStateFile, {});
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function protectedBundle(name) {
    return OFFICIAL_BUNDLES.has(name) || name === 'dshmarket';
  }

  function listPlugins() {
    const pkg = manifest();
    const guard = guardState();
    const state = marketState();
    const bundles = pkg.dsh.profile.bundles;
    const known = new Set([
      ...bundles.filter((name) => !OFFICIAL_BUNDLES.has(name)),
      ...Object.keys(guard.disabled),
      ...uniqueStrings(state.disabled),
    ]);
    return [...known]
      .filter((name) => Object.prototype.hasOwnProperty.call(pkg.dependencies, name) || name === 'dshmarket')
      .map((name) => ({
        name,
        version: pkg.dependencies[name] ?? '(bundled)',
        enabled: bundles.includes(name),
        protected: protectedBundle(name),
        disabledAt: guard.disabled[name]?.disabledAt ?? null,
        reason: guard.disabled[name]?.reason ?? null,
      }))
      .sort((a, b) => Number(b.protected) - Number(a.protected) || a.name.localeCompare(b.name));
  }

  function setEnabled(name, enabled, reason = 'changed from Electron Plugin Manager') {
    if (typeof name !== 'string' || !name) throw new Error('plugin name is required');
    if (protectedBundle(name)) throw new Error(`${name} is protected and cannot be disabled`);

    const pkg = manifest();
    const guard = guardState();
    const state = marketState();
    const bundles = pkg.dsh.profile.bundles;
    const currentIndex = bundles.indexOf(name);
    if (!Object.prototype.hasOwnProperty.call(pkg.dependencies, name)) {
      throw new Error(`${name} is not installed in the electron profile`);
    }

    if (enabled) {
      if (currentIndex < 0) {
        const savedIndex = Number.isInteger(guard.disabled[name]?.index)
          ? guard.disabled[name].index
          : bundles.length;
        bundles.splice(Math.max(2, Math.min(savedIndex, bundles.length)), 0, name);
      }
      delete guard.disabled[name];
    } else {
      if (currentIndex >= 0) {
        guard.disabled[name] = {
          index: currentIndex,
          version: pkg.dependencies[name],
          disabledAt: new Date().toISOString(),
          reason,
        };
        bundles.splice(currentIndex, 1);
      } else if (!guard.disabled[name]) {
        guard.disabled[name] = {
          index: bundles.length,
          version: pkg.dependencies[name],
          disabledAt: new Date().toISOString(),
          reason,
        };
      }
    }

    const disabled = new Set(uniqueStrings(state.disabled));
    if (enabled) disabled.delete(name);
    else disabled.add(name);
    state.disabled = [...disabled];

    writeJsonAtomic(packageFile, pkg);
    writeJsonAtomic(guardStateFile, guard);
    writeJsonAtomic(marketStateFile, state);
    return listPlugins();
  }

  function disableMany(names, reason) {
    const disabled = [];
    for (const name of uniqueStrings(names)) {
      if (protectedBundle(name)) continue;
      try {
        setEnabled(name, false, reason);
        disabled.push(name);
      } catch {
        // A stale name from an error message should not prevent recovery of
        // the other positively identified bundles.
      }
    }
    return disabled;
  }

  function recordHealthy() {
    const pkg = manifest();
    const guard = guardState();
    guard.lastHealthyBundles = pkg.dsh.profile.bundles.slice();
    guard.lastHealthyVersions = { ...pkg.dependencies };
    guard.lastHealthyAt = new Date().toISOString();
    writeJsonAtomic(guardStateFile, guard);
  }

  function installedCommunityBundles() {
    return new Set(
      manifest().dsh.profile.bundles.filter((name) => !protectedBundle(name) && !OFFICIAL_BUNDLES.has(name)),
    );
  }

  function extractCandidates(logText) {
    const log = String(logText || '');
    const installed = installedCommunityBundles();
    const found = new Set();
    const patterns = [
      /failed to import loader entry[^\n]*\(([^()]+)\)/gi,
      /cannot resolve profile bundle\s+["']([^"']+)["']/gi,
      /entry did not activate\s+([^:\s]+)\s*:\s*pending/gi,
      /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/\s]+\/)?[^/\s]+)\/[^\s]+/gi,
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(log)) !== null) {
        const name = match[1].replace(/\\/g, '/');
        if (installed.has(name)) found.add(name);
      }
    }

    if (found.size === 0) {
      const pkg = manifest();
      const guard = guardState();
      const healthy = new Set(guard.lastHealthyBundles);
      for (const name of installed) {
        if (!healthy.has(name) || guard.lastHealthyVersions[name] !== pkg.dependencies[name]) found.add(name);
      }
    }
    return [...found];
  }

  return {
    disableMany,
    extractCandidates,
    listPlugins,
    profileDir,
    recordHealthy,
    setEnabled,
  };
}

module.exports = { createPluginGuard };
