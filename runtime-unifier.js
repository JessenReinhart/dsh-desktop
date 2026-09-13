'use strict';

const {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs');
const { dirname, join, resolve } = require('node:path');

const SCOPE = '@deepseek-ai';
const LOCK_STALE_MS = 120_000;

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

function packageVersion(packageDir) {
  return readJson(join(packageDir, 'package.json'), {}).version || null;
}

function packageNames(scopeDir) {
  if (!existsSync(scopeDir)) return [];
  return readdirSync(scopeDir, { withFileTypes: true })
    .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink())
      && existsSync(join(scopeDir, entry.name, 'package.json')))
    .map((entry) => entry.name)
    .sort();
}

function sameRealPath(left, right) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

function runtimeNodeModules(dshInstallDir) {
  const manifest = readJson(join(dshInstallDir, 'package.json'), null);
  if (!manifest || manifest.name !== '@deepseek-ai/dsh') {
    throw new Error(`invalid DSH installation directory: ${dshInstallDir}`);
  }
  return dirname(dirname(resolve(dshInstallDir)));
}

function statePaths(profileDir) {
  return {
    stateFile: join(profileDir, '.dsh-desktop-runtime-links.json'),
    backupRoot: join(profileDir, '.dsh-desktop-peer-backups'),
    lockDir: join(profileDir, '.dsh-desktop-runtime-links.lock'),
  };
}

function readState(profileDir) {
  const { stateFile } = statePaths(profileDir);
  const value = readJson(stateFile, {});
  return {
    links: value && typeof value.links === 'object' && !Array.isArray(value.links)
      ? value.links
      : {},
    lastUnifiedAt: typeof value?.lastUnifiedAt === 'string' ? value.lastUnifiedAt : null,
    runtimeVersion: typeof value?.runtimeVersion === 'string' ? value.runtimeVersion : null,
    runtimeDir: typeof value?.runtimeDir === 'string' ? value.runtimeDir : null,
  };
}

function acquireLock(profileDir) {
  const { lockDir } = statePaths(profileDir);
  try {
    mkdirSync(lockDir);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const age = Date.now() - lstatSync(lockDir).mtimeMs;
    if (age <= LOCK_STALE_MS) throw new Error('another runtime peer unification is already running');
    rmSync(lockDir, { recursive: true });
    mkdirSync(lockDir);
  }
  return () => {
    try { rmdirSync(lockDir); } catch {}
  };
}

function backupName(name) {
  return `${SCOPE.slice(1)}__${name}__${Date.now()}-${process.pid}`;
}

function replaceWithLink(source, target, backupRoot, linkState) {
  mkdirSync(dirname(source), { recursive: true });
  mkdirSync(backupRoot, { recursive: true });
  const temporary = `${source}.dsh-link-${process.pid}`;
  try { rmSync(temporary, { recursive: true, force: true }); } catch {}
  symlinkSync(target, temporary, 'dir');

  let backupPath = null;
  try {
    if (existsSync(source) || lstatExists(source)) {
      const current = lstatSync(source);
      const managedSymlink = current.isSymbolicLink() && linkState.managed === true;
      if (managedSymlink) {
        renameSync(temporary, source);
        return null;
      }
      backupPath = join(backupRoot, backupName(source.split('/').pop()));
      renameSync(source, backupPath);
    }
    renameSync(temporary, source);
    return backupPath;
  } catch (error) {
    try { rmSync(temporary, { recursive: true, force: true }); } catch {}
    if (backupPath && !existsSync(source) && existsSync(backupPath)) {
      try { renameSync(backupPath, source); } catch {}
    }
    throw error;
  }
}

function lstatExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function inspectRuntimePeers(profileDir, dshInstallDir) {
  const runtimeModules = runtimeNodeModules(dshInstallDir);
  const profileScope = join(profileDir, 'node_modules', SCOPE);
  const runtimeScope = join(runtimeModules, SCOPE);
  const runtimeNames = new Set(packageNames(runtimeScope));
  const state = readState(profileDir);
  const peers = packageNames(profileScope)
    .filter((name) => runtimeNames.has(name))
    .map((name) => {
      const profilePackage = join(profileScope, name);
      const runtimePackage = join(runtimeScope, name);
      return {
        name: `${SCOPE}/${name}`,
        profileVersion: packageVersion(profilePackage),
        runtimeVersion: packageVersion(runtimePackage),
        unified: sameRealPath(profilePackage, runtimePackage),
        profilePath: profilePackage,
        runtimePath: runtimePackage,
        managed: Boolean(state.links[name]),
      };
    });
  return {
    runtimeVersion: packageVersion(dshInstallDir),
    runtimeDir: resolve(dshInstallDir),
    peers,
    mismatches: peers.filter((peer) => !peer.unified),
  };
}

function unifyRuntimePeers(profileDir, dshInstallDir) {
  const releaseLock = acquireLock(profileDir);
  try {
    const runtimeModules = runtimeNodeModules(dshInstallDir);
    const runtimeVersion = packageVersion(dshInstallDir);
    const profileScope = join(profileDir, 'node_modules', SCOPE);
    const runtimeScope = join(runtimeModules, SCOPE);
    const runtimeNames = new Set(packageNames(runtimeScope));
    const state = readState(profileDir);
    const { stateFile, backupRoot } = statePaths(profileDir);
    const changed = [];

    for (const name of packageNames(profileScope)) {
      if (!runtimeNames.has(name)) continue;
      const profilePackage = join(profileScope, name);
      const runtimePackage = join(runtimeScope, name);
      if (sameRealPath(profilePackage, runtimePackage)) continue;
      const previous = state.links[name] || { backups: [], managed: false };
      const backupPath = replaceWithLink(profilePackage, runtimePackage, backupRoot, previous);
      if (backupPath) previous.backups = [...(previous.backups || []), backupPath];
      state.links[name] = {
        ...previous,
        target: runtimePackage,
        targetVersion: packageVersion(runtimePackage),
        linkedAt: new Date().toISOString(),
        managed: true,
      };
      changed.push(`${SCOPE}/${name}`);
    }

    state.lastUnifiedAt = new Date().toISOString();
    state.runtimeVersion = runtimeVersion;
    state.runtimeDir = resolve(dshInstallDir);
    writeJsonAtomic(stateFile, state);

    const inspection = inspectRuntimePeers(profileDir, dshInstallDir);
    if (inspection.mismatches.length > 0) {
      throw new Error(`runtime peer unification incomplete: ${inspection.mismatches.map((item) => item.name).join(', ')}`);
    }
    return { ...inspection, changed, stateFile, backupRoot };
  } finally {
    releaseLock();
  }
}

function restoreRuntimePeers(profileDir) {
  const releaseLock = acquireLock(profileDir);
  try {
    const state = readState(profileDir);
    const profileScope = join(profileDir, 'node_modules', SCOPE);
    const restored = [];
    for (const [name, entry] of Object.entries(state.links)) {
      const backups = Array.isArray(entry.backups) ? entry.backups : [];
      const backupPath = [...backups].reverse().find((candidate) => lstatExists(candidate));
      const profilePackage = join(profileScope, name);
      if (!backupPath) continue;
      if (lstatExists(profilePackage)) rmSync(profilePackage, { recursive: true, force: true });
      renameSync(backupPath, profilePackage);
      restored.push(`${SCOPE}/${name}`);
      delete state.links[name];
    }
    const { stateFile } = statePaths(profileDir);
    state.lastUnifiedAt = null;
    state.runtimeVersion = null;
    state.runtimeDir = null;
    writeJsonAtomic(stateFile, state);
    return { restored };
  } finally {
    releaseLock();
  }
}

if (require.main === module) {
  const [action, profileDir, dshInstallDir] = process.argv.slice(2);
  try {
    let result;
    if (action === '--apply') result = unifyRuntimePeers(profileDir, dshInstallDir);
    else if (action === '--inspect') result = inspectRuntimePeers(profileDir, dshInstallDir);
    else if (action === '--restore') result = restoreRuntimePeers(profileDir);
    else throw new Error('usage: runtime-unifier.js --apply|--inspect <profile-dir> [dsh-install-dir]');
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`[dsh-desktop] runtime peer unification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  inspectRuntimePeers,
  restoreRuntimePeers,
  runtimeNodeModules,
  unifyRuntimePeers,
};
