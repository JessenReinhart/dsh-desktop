'use strict';

// A persistent, versioned DSH runtime cache.  `bunx` is deliberately used only
// as a downloader: the running application never resolves modules from its
// volatile /tmp/bunx-* directory.

const { spawn } = require('node:child_process');
const {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { homedir, tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const LOCK_STALE_MS = 120_000;

function defaultRuntimeStoreRoot(env = process.env) {
  const dataHome = env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(dataHome, 'dsh-desktop', 'runtimes');
}

function validVersion(value) {
  return typeof value === 'string' && VERSION_PATTERN.test(value);
}

function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

function runtimeDir(storeRoot, version) {
  if (!validVersion(version)) throw new Error(`invalid DSH version: ${version}`);
  return join(resolve(storeRoot), version);
}

function dshInstallDir(storeRoot, version) {
  return join(runtimeDir(storeRoot, version), 'node_modules', '@deepseek-ai', 'dsh');
}

function isSafeRelativeFile(value) {
  return typeof value === 'string'
    && value.length > 0
    && !value.startsWith('/')
    && !value.split(/[\\/]+/).includes('..');
}

function validateRuntimeDir(directory, expectedVersion = null) {
  const root = resolve(directory);
  const packageDir = join(root, 'node_modules', '@deepseek-ai', 'dsh');
  const manifest = readJson(join(packageDir, 'package.json'));
  if (!manifest || manifest.name !== '@deepseek-ai/dsh') {
    throw new Error(`runtime ${root} has no valid @deepseek-ai/dsh manifest`);
  }
  if (expectedVersion && manifest.version !== expectedVersion) {
    throw new Error(`runtime ${root} contains DSH ${manifest.version}, expected ${expectedVersion}`);
  }
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh;
  if (!isSafeRelativeFile(bin) || !existsSync(join(packageDir, bin))) {
    throw new Error(`runtime ${root} has no valid DSH executable`);
  }
  return {
    version: manifest.version,
    runtimeDir: root,
    dshInstallDir: packageDir,
    bin: join(packageDir, bin),
    binRelative: bin,
  };
}

function inspectRuntime(storeRoot, version) {
  if (!validVersion(version)) return null;
  const directory = runtimeDir(storeRoot, version);
  if (!existsSync(directory)) return null;
  try { return validateRuntimeDir(directory, version); } catch (error) {
    return { version, runtimeDir: directory, valid: false, error: error.message };
  }
}

function findRuntime(storeRoot, version) {
  const result = inspectRuntime(storeRoot, version);
  return result && result.valid !== false ? result.dshInstallDir : null;
}

function listRuntimes(storeRoot) {
  const root = resolve(storeRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && validVersion(entry.name))
    .map((entry) => inspectRuntime(root, entry.name))
    .sort((left, right) => String(right.version).localeCompare(String(left.version)));
}

function lockDir(storeRoot, version) {
  return join(resolve(storeRoot), '.locks', `${version}.lock`);
}

async function acquireLock(storeRoot, version) {
  const directory = lockDir(storeRoot, version);
  mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_STALE_MS;
  while (true) {
    try {
      mkdirSync(directory, { mode: 0o700 });
      writeFileSync(join(directory, 'owner.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      return () => { try { rmdirSync(directory, { recursive: true }); } catch {} };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let stale = false;
      try { stale = Date.now() - statSync(directory).mtimeMs > LOCK_STALE_MS; } catch {}
      if (stale) {
        try { rmSync(directory, { recursive: true, force: true }); } catch {}
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for DSH ${version} runtime preparation`);
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 200));
    }
  }
}

function sourceDshDirectory(version) {
  const candidates = [];
  try {
    for (const entry of readdirSync(tmpdir(), { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('bunx-')) continue;
      const candidate = join(tmpdir(), entry.name, `dsh@${version}`, 'node_modules', '@deepseek-ai', 'dsh');
      try {
        const manifest = readJson(join(candidate, 'package.json'));
        if (manifest?.name === '@deepseek-ai/dsh' && manifest.version === version) {
          candidates.push({ candidate, mtimeMs: statSync(join(candidate, 'package.json')).mtimeMs });
        }
      } catch {}
    }
  } catch {}
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.candidate || null;
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const append = (chunk) => { output = `${output}${chunk}`.slice(-20_000); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectRun(new Error(`${command} timed out while downloading DSH\n${output.trim()}`));
    }, options.timeoutMs || 120_000);
    child.once('error', (error) => { clearTimeout(timer); rejectRun(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolveRun(output.trim());
      else rejectRun(new Error(`${command} exited with code=${code}, signal=${signal}\n${output.trim()}`));
    });
  });
}

function copyRuntimeFromBunx(sourceDshDir, stagingDir, version) {
  const sourceModules = dirname(dirname(resolve(sourceDshDir)));
  const destinationModules = join(stagingDir, 'node_modules');
  // Copy the whole module graph: DSH's packages use ordinary Node resolution
  // and cannot safely be split from their sibling host packages.
  cpSync(sourceModules, destinationModules, { recursive: true, dereference: false, errorOnExist: true });
  const validated = validateRuntimeDir(stagingDir, version);
  const metadata = {
    version,
    materializedAt: new Date().toISOString(),
    source: 'bunx',
    manifest: { name: '@deepseek-ai/dsh', version: validated.version, bin: validated.binRelative },
  };
  writeFileSync(join(stagingDir, '.dsh-desktop-runtime.json'), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
}

async function materializeRuntime({ version, storeRoot = defaultRuntimeStoreRoot(), bunPath = 'bun', homeDir = homedir() }) {
  if (!validVersion(version)) throw new Error(`invalid DSH version: ${version}`);
  const existing = findRuntime(storeRoot, version);
  if (existing) return existing;

  const release = await acquireLock(storeRoot, version);
  let stagingDir = null;
  try {
    const afterLock = findRuntime(storeRoot, version);
    if (afterLock) return afterLock;
    mkdirSync(resolve(storeRoot), { recursive: true, mode: 0o700 });
    const stagingRoot = join(resolve(storeRoot), '.staging');
    mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
    stagingDir = join(stagingRoot, `${version}-${process.pid}-${Date.now()}`);
    mkdirSync(stagingDir, { mode: 0o700 });

    await run(bunPath, ['x', `@deepseek-ai/dsh@${version}`, '--version'], {
      cwd: homeDir,
      timeoutMs: 120_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    });
    const source = sourceDshDirectory(version);
    if (!source) throw new Error(`DSH ${version} was downloaded but Bun's temporary installation was not found`);
    copyRuntimeFromBunx(source, stagingDir, version);
    // rename is atomic because staging lives beneath the same runtime store.
    const destination = runtimeDir(storeRoot, version);
    if (existsSync(destination)) {
      // Never overwrite a potentially useful broken runtime. Keep it for
      // diagnostics and promote the fully validated staging directory instead.
      const quarantineRoot = join(resolve(storeRoot), '.quarantine');
      mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
      renameSync(destination, join(quarantineRoot, `${version}-${Date.now()}-invalid`));
    }
    renameSync(stagingDir, destination);
    stagingDir = null;
    return validateRuntimeDir(destination, version).dshInstallDir;
  } finally {
    if (stagingDir) {
      try { rmSync(stagingDir, { recursive: true, force: true }); } catch {}
    }
    release();
  }
}

function cleanupRuntimeStore(storeRoot = defaultRuntimeStoreRoot(), { keepVersions = [] } = {}) {
  const root = resolve(storeRoot);
  const keep = new Set(keepVersions.filter(validVersion));
  const removed = [];
  for (const item of listRuntimes(root)) {
    if (keep.has(item.version)) continue;
    const target = runtimeDir(root, item.version);
    // Only delete direct version directories belonging to this store.
    if (dirname(target) !== root || !lstatSync(target).isDirectory()) continue;
    rmSync(target, { recursive: true, force: true });
    removed.push(item.version);
  }
  return { root, kept: [...keep], removed };
}

function parseCli(argv) {
  const [action, version, ...rest] = argv;
  const storeIndex = rest.indexOf('--store');
  const storeRoot = storeIndex >= 0 ? rest[storeIndex + 1] : defaultRuntimeStoreRoot();
  if (!storeRoot) throw new Error('--store requires a directory');
  return { action, version, storeRoot, rest };
}

if (require.main === module) {
  (async () => {
    const { action, version, storeRoot, rest } = parseCli(process.argv.slice(2));
    let result;
    if (action === '--materialize') {
      const installDir = await materializeRuntime({ version, storeRoot, bunPath: process.env.BUN_PATH || 'bun' });
      result = validateRuntimeDir(runtimeDir(storeRoot, version), version);
      result.dshInstallDir = installDir;
    } else if (action === '--inspect') {
      result = version ? inspectRuntime(storeRoot, version) : { root: resolve(storeRoot), runtimes: listRuntimes(storeRoot) };
    } else if (action === '--cleanup') {
      const keep = [];
      for (let index = 0; index < rest.length; index += 1) {
        if (rest[index] === '--keep' && rest[index + 1]) keep.push(...rest[index + 1].split(','));
      }
      result = cleanupRuntimeStore(storeRoot, { keepVersions: keep });
    } else {
      throw new Error('usage: runtime-store.js --materialize <version> [--store <dir>] | --inspect [version] [--store <dir>] | --cleanup [--keep v1,v2] [--store <dir>]');
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  })().catch((error) => {
    process.stderr.write(`[dsh-desktop] runtime store failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  cleanupRuntimeStore,
  defaultRuntimeStoreRoot,
  dshInstallDir,
  findRuntime,
  inspectRuntime,
  listRuntimes,
  materializeRuntime,
  runtimeDir,
  validateRuntimeDir,
  validVersion,
};
