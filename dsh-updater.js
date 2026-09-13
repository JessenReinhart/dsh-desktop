'use strict';

const { spawn } = require('node:child_process');
const {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} = require('node:fs');
const { dirname, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { inspectRuntimePeers, unifyRuntimePeers } = require('./runtime-unifier');
const { defaultRuntimeStoreRoot, findRuntime, materializeRuntime } = require('./runtime-store');

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

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

function validVersion(value) {
  return typeof value === 'string' && VERSION_PATTERN.test(value);
}

function compareVersions(left, right) {
  const parse = (value) => {
    const [coreAndPre] = value.split('+');
    const separator = coreAndPre.indexOf('-');
    const core = separator < 0 ? coreAndPre : coreAndPre.slice(0, separator);
    const prerelease = separator < 0 ? '' : coreAndPre.slice(separator + 1);
    return { core: core.split('.').map(Number), prerelease: prerelease.split('.').filter(Boolean) };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    if (a.prerelease[index] === b.prerelease[index]) continue;
    const aNumber = /^\d+$/.test(a.prerelease[index]);
    const bNumber = /^\d+$/.test(b.prerelease[index]);
    if (aNumber && bNumber) return Number(a.prerelease[index]) > Number(b.prerelease[index]) ? 1 : -1;
    if (aNumber !== bNumber) return aNumber ? -1 : 1;
    return a.prerelease[index].localeCompare(b.prerelease[index]);
  }
  return 0;
}

function riskKey(item) {
  return `${item.plugin}\0${item.peer}\0${item.direction || item.reason || ''}`;
}

function pluginCandidates(logText) {
  const found = new Set();
  const patterns = [
    /failed to apply loader entry[^\n]*\(([^()]+)\)/gi,
    /failed to import loader entry[^\n]*\(([^()]+)\)/gi,
    /cannot resolve profile bundle\s+["']([^"']+)["']/gi,
    /entry did not activate\s+([^:\s]+)\s*:\s*pending/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(String(logText || ''))) !== null) found.add(match[1]);
  }
  return [...found];
}

function createDshUpdater({ profileDir, homeDir, defaultVersion, bunPath, runtimeStoreRoot = defaultRuntimeStoreRoot() }) {
  const stateFile = join(profileDir, '.dsh-desktop-runtime.json');
  const compatibilityModule = join(profileDir, 'node_modules', 'dshmarket', 'lib', 'compatibility.js');
  let registryCache = null;

  function state() {
    const value = readJson(stateFile, {});
    return {
      currentVersion: validVersion(value?.currentVersion) ? value.currentVersion : defaultVersion,
      lastHealthyVersion: validVersion(value?.lastHealthyVersion) ? value.lastHealthyVersion : defaultVersion,
      pendingUpdate: value?.pendingUpdate && validVersion(value.pendingUpdate.from)
        && validVersion(value.pendingUpdate.to)
        ? value.pendingUpdate
        : null,
      history: Array.isArray(value?.history) ? value.history.slice(-20) : [],
    };
  }

  function save(next) {
    writeJsonAtomic(stateFile, next);
    return state();
  }

  function currentVersion() {
    return state().currentVersion;
  }

  function findInstallDir(version) {
    return validVersion(version) ? findRuntime(runtimeStoreRoot, version) : null;
  }

  async function materialize(version) {
    if (!validVersion(version)) throw new Error(`invalid DSH version: ${version}`);
    return materializeRuntime({ version, storeRoot: runtimeStoreRoot, bunPath, homeDir });
  }

  async function smokeTest(version) {
    if (!validVersion(version)) throw new Error(`invalid DSH version: ${version}`);
    const targetDir = await materialize(version);
    const activeDir = await materialize(currentVersion());
    // The candidate must be tested with its own host-package identities. The
    // currently running server already has its modules loaded, so temporarily
    // retargeting filesystem links is safe; always restore them afterward.
    const targetPeerHealth = unifyRuntimePeers(profileDir, targetDir);
    try {
      const result = await new Promise((resolve) => {
        const manifest = readJson(join(targetDir, 'package.json'), {});
        const relativeBin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh;
        if (!relativeBin || !existsSync(join(targetDir, relativeBin))) {
          resolve({
            ok: false,
            reason: `candidate DSH ${version} has no executable`,
            output: '',
            pluginCandidates: [],
          });
          return;
        }
        const child = spawn(process.execPath, [
          join(targetDir, relativeBin),
          '--profile',
          'electron',
          '--no-open',
          '--port',
          '0',
        ], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
          cwd: homeDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        });
        let output = '';
        let settled = false;
        let readyTimer = null;
        let timeout = null;

        const stop = () => {
          if (child.exitCode !== null || child.killed) return;
          try {
            if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
            else child.kill('SIGTERM');
          } catch {}
        };
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (readyTimer) clearTimeout(readyTimer);
          stop();
          resolve({
            ...result,
            output: output.slice(-12_000),
            pluginCandidates: pluginCandidates(output),
          });
        };
        const inspect = (chunk) => {
          output = `${output}${chunk}`.slice(-20_000);
          if (/plugin tree failed to load|failed to apply loader entry|failed to import loader entry|cannot resolve profile bundle|entry did not activate[^\n]*pending/i.test(output)) {
            finish({ ok: false, reason: 'candidate DSH reported a plugin activation failure' });
            return;
          }
          if (!readyTimer && /dsh web:\s*https?:\/\//i.test(output)) {
            // Keep observing briefly: some loader errors arrive just after the
            // listener becomes reachable.
            readyTimer = setTimeout(() => finish({ ok: true, reason: null }), 2_000);
          }
        };
        child.stdout.on('data', (chunk) => inspect(chunk.toString()));
        child.stderr.on('data', (chunk) => inspect(chunk.toString()));
        child.once('error', (err) => finish({ ok: false, reason: err.message }));
        child.once('exit', (code, signal) => {
          finish({ ok: false, reason: `candidate exited before becoming healthy (code=${code}, signal=${signal})` });
        });
        timeout = setTimeout(() => {
          finish({ ok: false, reason: 'candidate DSH did not become healthy within 60 seconds' });
        }, 60_000);
        });
      return {
        ...result,
        peerHealth: {
          runtimeVersion: targetPeerHealth.runtimeVersion,
          total: targetPeerHealth.peers.length,
          unified: targetPeerHealth.peers.length - targetPeerHealth.mismatches.length,
          mismatches: targetPeerHealth.mismatches,
        },
      };
    } finally {
      unifyRuntimePeers(profileDir, activeDir);
    }
  }

  async function registry(refresh = false) {
    if (registryCache && !refresh) return registryCache;
    const response = await fetch('https://registry.npmjs.org/@deepseek-ai%2Fdsh', {
      signal: AbortSignal.timeout(20_000),
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    });
    if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
    const packument = await response.json();
    const versions = Object.keys(packument.versions || {})
      .filter(validVersion)
      .sort((a, b) => compareVersions(b, a));
    registryCache = {
      tags: packument['dist-tags'] || {},
      versions,
      checkedAt: new Date().toISOString(),
    };
    return registryCache;
  }

  async function info(refresh = false) {
    const available = await registry(refresh);
    const latestVersion = available.tags.latest || available.versions[0] || null;
    const current = state();
    return {
      ...current,
      ...available,
      latestVersion,
      updateAvailable: Boolean(latestVersion && compareVersions(latestVersion, current.currentVersion) > 0),
    };
  }

  async function runtimePeerHealth(version = currentVersion()) {
    const installDir = await materialize(version);
    return inspectRuntimePeers(profileDir, installDir);
  }

  async function assess(version) {
    if (!existsSync(compatibilityModule)) {
      throw new Error('dshmarket is required for update compatibility checks');
    }
    const current = currentVersion();
    const [currentDir, targetDir] = await Promise.all([
      materialize(current),
      materialize(version),
    ]);
    const { assessCompatibility } = await import(pathToFileURL(compatibilityModule).href);
    const currentReport = await assessCompatibility(profileDir, { dshInstallDir: currentDir, homeDir });
    const targetReport = await assessCompatibility(profileDir, { dshInstallDir: targetDir, homeDir });
    const currentRisks = new Set((currentReport.risks || []).map(riskKey));
    const currentWarnings = new Set((currentReport.warnings || []).map(riskKey));
    const smokeTestResult = await smokeTest(version);
    return {
      fromVersion: current,
      toVersion: version,
      risks: targetReport.risks || [],
      warnings: targetReport.warnings || [],
      introducedRisks: (targetReport.risks || []).filter((risk) => !currentRisks.has(riskKey(risk))),
      introducedWarnings: (targetReport.warnings || []).filter((warning) => !currentWarnings.has(riskKey(warning))),
      duplicateNames: targetReport.duplicateNames || [],
      smokeTest: smokeTestResult,
      checkedAt: new Date().toISOString(),
    };
  }

  function beginUpdate(toVersion, disabledPlugins = []) {
    if (!validVersion(toVersion)) throw new Error(`invalid DSH version: ${toVersion}`);
    const current = state();
    if (current.pendingUpdate) throw new Error('another DSH update is still awaiting health confirmation');
    if (current.currentVersion === toVersion) throw new Error(`DSH ${toVersion} is already active`);
    current.pendingUpdate = {
      from: current.currentVersion,
      to: toVersion,
      startedAt: new Date().toISOString(),
      disabledPlugins: [...new Set(disabledPlugins)],
    };
    current.currentVersion = toVersion;
    return save(current);
  }

  function confirmHealthy() {
    const current = state();
    const pending = current.pendingUpdate;
    current.lastHealthyVersion = current.currentVersion;
    current.pendingUpdate = null;
    if (pending) {
      current.history.push({
        from: pending.from,
        to: pending.to,
        status: 'installed',
        at: new Date().toISOString(),
      });
    }
    return save(current);
  }

  function rollback(reason = 'update failed health check') {
    const current = state();
    const pending = current.pendingUpdate;
    if (!pending) return { rolledBack: false, state: current };
    current.currentVersion = pending.from;
    current.lastHealthyVersion = pending.from;
    current.pendingUpdate = null;
    current.history.push({
      from: pending.from,
      to: pending.to,
      status: 'rolled-back',
      reason,
      at: new Date().toISOString(),
    });
    return { rolledBack: true, from: pending.to, to: pending.from, state: save(current) };
  }

  return {
    assess,
    beginUpdate,
    confirmHealthy,
    currentVersion,
    findInstallDir,
    info,
    materialize,
    rollback,
    runtimePeerHealth,
    smokeTest,
    state,
    stateFile,
  };
}

module.exports = { compareVersions, createDshUpdater, validVersion };
