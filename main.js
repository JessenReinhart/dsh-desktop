// main.js — Electron wrapper for DeepSeek Harness (dsh web)
//
// Boots a child `dsh web` process, parses the listening URL from its stdout,
// then opens a BrowserWindow pointing at that URL. Kills the child when the
// app is actually quitting. Also supports restarting the DSH child on demand
// (menu item, Ctrl+Alt+R, or IPC) without closing the app window.
//
// Additional capabilities layered on top of the wrapper:
//   - Native desktop notifications via Electron's Notification API (renderer
//     asks main to display a notification).
//   - System tray icon with "Show", "Run in background" toggle, and "Quit".
//     When "Run in background" is on, closing the window hides it to the tray
//     instead of quitting the app — the dsh web child keeps running so a
//     later tray click restores the conversation with the same backend state
//     (the same pattern Codex uses).
//
// No build pipeline; pure CommonJS, no bundler needed.

const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  shell,
  Notification,
  Tray,
  nativeImage,
} = require('electron');
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const net = require('node:net');
const { createPluginGuard } = require('./plugin-guard');
const { createDshUpdater } = require('./dsh-updater');
const { unifyRuntimePeers } = require('./runtime-unifier');
const { createHealthSupervisor } = require('./health-supervisor');
const { promoteDynamicPlugin, scanDynamicCordisPlugins } = require('./cordis-plugin-scanner');

// The launcher uses --no-sandbox for Linux environments where Chromium's
// sandbox is unavailable. Keep Chromium's default GPU path enabled: this app
// is a normal BrowserWindow and disabling it makes the DSH UI CPU-rendered.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
}

const APP_NAME = 'DeepSeek Harness';
const START_TIMEOUT_MS = 90_000;
const SESSIONS_FILE = join(process.env.HOME || '', '.dsh', 'sessions.json');
const CONNECT_TIMEOUT_MS = 30_000;
const TERM_GRACE_MS = 5_000;
const ICON_PATH = resolve(__dirname, 'icon.png');
const DEFAULT_DSH_VERSION = '0.1.1-rc.2';
const DSH_HOME_DIR = join(process.env.HOME || '', '.dsh');
const DSH_SESSIONS_DIR = join(DSH_HOME_DIR, 'sessions');
const ELECTRON_PROFILE_DIR = join(DSH_HOME_DIR, 'profiles', 'electron');
const BUN_PATH = join(process.env.HOME || '', '.bun', 'bin', 'bun');
const pluginGuard = createPluginGuard(ELECTRON_PROFILE_DIR);
const healthSupervisor = createHealthSupervisor(ELECTRON_PROFILE_DIR);
const dshUpdater = createDshUpdater({
  profileDir: ELECTRON_PROFILE_DIR,
  homeDir: DSH_HOME_DIR,
  defaultVersion: DEFAULT_DSH_VERSION,
  bunPath: existsSync(BUN_PATH) ? BUN_PATH : 'bun',
});

let dshChild = null;
let mainWindow = null;
let tray = null;
let pluginManagerWindow = null;
let recoveryCenterWindow = null;
let childStdout = '';
let resolvedUrl = null;
let restarting = false;
let quitting = false;
let pluginIssuePromptScheduled = false;
let warnedPluginIssueSignature = '';
let updateRollbackInProgress = false;
const runtimePluginIssues = new Set();

// Background-mode state. When enabled (default ON), closing the window only
// hides it to the tray instead of quitting the app. The dsh web child stays
// alive so reopening the tray restores the live session.
let backgroundMode = true;
let trayHintShown = false;

// Session management
function loadSessions() {
  const { readFileSync } = require('node:fs');
  try {
    const content = readFileSync(SESSIONS_FILE, 'utf8');
    return JSON.parse(content);
  } catch {
    return [];
  }
}

function saveSessions(sessions) {
  const { writeFileSync } = require('node:fs');
  try {
    const { dirname } = require('node:path');
    const fs = require('node:fs');
    if (!fs.existsSync(dirname(SESSIONS_FILE))) {
      fs.mkdirSync(dirname(SESSIONS_FILE), { recursive: true });
    }
    writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
    return true;
  } catch {
    return false;
  }
}

function listSessions() {
  return loadSessions();
}

function createSession(name) {
  const sessions = loadSessions();
  const existing = sessions.find(s => s.name === name);
  if (existing) return { ok: false, reason: 'name-exists' };
  sessions.push({
    id: Date.now().toString(36),
    name,
    createdAt: new Date().toISOString(),
  });
  const saved = saveSessions(sessions);
  return saved ? { ok: true } : { ok: false, reason: 'write-failed' };
}

function deleteSession(id) {
  const sessions = loadSessions();
  const idx = sessions.findIndex(s => s.id === id);
  if (idx === -1) return { ok: false, reason: 'not-found' };
  sessions.splice(idx, 1);
  const saved = saveSessions(sessions);
  return saved ? { ok: true } : { ok: false, reason: 'write-failed' };
}

function updateSessionLastUsed(id) {
  const sessions = loadSessions();
  const session = sessions.find(s => s.id === id);
  if (!session) return false;
  session.lastUsed = Date.now();
  return saveSessions(sessions);
}

function switchSession(id) {
  const sessions = loadSessions();
  const session = sessions.find(s => s.id === id);
  if (!session) return { ok: false, reason: 'not-found' };
  session.lastUsed = Date.now();
  saveSessions(sessions);
  return { ok: true, session };
}

function getLastUsedSessions(maxCount = 5) {
  const sessions = loadSessions();
  return sessions
    .slice()
    .sort((a, b) => (b.lastUsed || b.createdAt || 0) - (a.lastUsed || a.createdAt || 0))
    .slice(0, maxCount);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findDshLauncher() {
  // Prefer the wrapper script shipped next to this app (handles env, logging,
  // PATH); fall back to system PATH if absent (e.g. dev runs).
  // External Node executes this shell script, so packaged builds use Electron's
  // unpacked asset directory rather than a virtual app.asar path.
  const unpacked = process.resourcesPath
    ? join(process.resourcesPath, 'app.asar.unpacked', 'dsh-desktop.sh')
    : null;
  if (unpacked && existsSync(unpacked)) return unpacked;
  const script = resolve(__dirname, 'dsh-desktop.sh');
  return existsSync(script) ? script : 'dsh';
}

function probePort(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const socket = net.createConnection({ host, port }, () => {
      socket.end();
      resolve();
    });
    socket.on('error', () => {
      socket.destroy();
      if (Date.now() - start > timeoutMs) reject(new Error(`timeout probing ${host}:${port}`));
      else setTimeout(() => probePort(host, port, timeoutMs).then(resolve, reject), 250);
    });
  });
}

async function waitForUrl(url, timeoutMs) {
  let host;
  let port;
  try {
    const u = new URL(url);
    host = u.hostname;
    port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  } catch {
    throw new Error(`invalid URL from dsh: ${url}`);
  }
  await probePort(host, port, timeoutMs);
  return url;
}

function extractUrlFromLine(line) {
  // dsh web prints something like "Local: http://127.0.0.1:5173/" — accept any
  // http(s) URL in stdout, first wins.
  const match = line.match(/https?:\/\/[^\s)]+/i);
  return match ? match[0].replace(/\/+$/, '') : null;
}

function waitForChildUrl(child, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const start = Date.now();
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      fn(arg);
    };
    const check = () => {
      if (done) return;
      const url = extractUrlFromLine(childStdout);
      if (url) finish(resolvePromise, url);
      else if (Date.now() - start > timeoutMs) {
        finish(rejectPromise, new Error(`timed out after ${timeoutMs}ms waiting for dsh web URL`));
      } else setTimeout(check, 200);
    };
    // A spawn failure (missing binary, etc.) must reject promptly, not after
    // the full timeout.
    child.once('error', (err) => finish(rejectPromise, err));
    child.once('exit', (code, signal) => {
      finish(
        rejectPromise,
        new Error(`dsh web exited before startup (code=${code}, signal=${signal})`),
      );
    });
    check();
  });
}

// The launcher `exec`s into bunx, but dsh web may keep grandchildren (vite,
// pnpm) alive after a bare SIGTERM. Spawn the child in its own process group
// and signal the whole group so a restart never leaves orphans behind.
function signalChildGroup(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

function markIntentionalStop(child) {
  if (child) child.__intentionalStop = true;
}

function killChild(signal = 'SIGTERM') {
  // Fire-and-forget stop for quit paths.
  if (dshChild && dshChild.exitCode === null && !dshChild.killed) {
    markIntentionalStop(dshChild);
    signalChildGroup(dshChild, signal);
  }
  dshChild = null;
}

function stopChild(timeoutMs = TERM_GRACE_MS) {
  // Awaited stop for restarts: TERM, wait, then KILL.
  return new Promise((resolveStop) => {
    const child = dshChild;
    dshChild = null;
    if (!child || child.exitCode !== null || child.killed) {
      resolveStop();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveStop();
    };
    const timer = setTimeout(() => {
      signalChildGroup(child, 'SIGKILL');
      setTimeout(finish, 1_000);
    }, timeoutMs);
    child.once('exit', finish);
    markIntentionalStop(child);
    signalChildGroup(child, 'SIGTERM');
  });
}

function splashUrl(state) {
  return `file://${resolve(__dirname, 'index.html')}#${state}`;
}

function loadSplash(state) {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve();
  return mainWindow.loadURL(splashUrl(state)).catch(() => {});
}

async function checkPlugins() {
  try {
    const modulePath = join(
      ELECTRON_PROFILE_DIR,
      'node_modules',
      'dshmarket',
      'lib',
      'compatibility.js',
    );
    if (!existsSync(modulePath)) throw new Error('dshmarket is not installed in the electron profile');
    const { assessCompatibility } = await import(pathToFileURL(modulePath).href);
    const version = dshUpdater.currentVersion();
    const dshInstallDir = dshUpdater.findInstallDir(version) || await dshUpdater.materialize(version);
    const result = await assessCompatibility(ELECTRON_PROFILE_DIR, {
      dshInstallDir,
      homeDir: DSH_HOME_DIR,
    });
    const runtimePeerHealth = await dshUpdater.runtimePeerHealth(version);
    return {
      dshVersion: version,
      risks: result.risks || [],
      warnings: result.warnings || [],
      duplicateNames: result.duplicateNames || [],
      runtimeIssues: [...runtimePluginIssues],
      runtimePeerHealth: {
        runtimeVersion: runtimePeerHealth.runtimeVersion,
        total: runtimePeerHealth.peers.length,
        unified: runtimePeerHealth.peers.length - runtimePeerHealth.mismatches.length,
        mismatches: runtimePeerHealth.mismatches,
      },
    };
  } catch (err) {
    return {
      dshVersion: dshUpdater.currentVersion(),
      risks: [],
      warnings: [],
      duplicateNames: [],
      runtimeIssues: [...runtimePluginIssues],
      error: err.message,
    };
  }
}

async function installDshUpdate(version, disableIncompatible = false) {
  const updateState = dshUpdater.state();
  if (updateState.pendingUpdate) {
    return { started: false, blocked: true, reason: `DSH ${updateState.pendingUpdate.to} is still in its health-check window` };
  }
  if (updateState.currentVersion === version) {
    return { started: false, blocked: true, reason: `DSH ${version} is already active` };
  }
  const assessment = await dshUpdater.assess(version);
  const pluginRows = pluginGuard.listPlugins();
  const disabledNames = new Set(pluginRows.filter((plugin) => !plugin.enabled).map((plugin) => plugin.name));
  const disableableNames = new Set(pluginRows.filter((plugin) => !plugin.protected).map((plugin) => plugin.name));
  const blockers = (assessment.introducedRisks || []).filter((risk) => !disabledNames.has(risk.plugin));
  let runtimeBlockers = [];
  if (assessment.smokeTest && !assessment.smokeTest.ok) {
    runtimeBlockers = assessment.smokeTest.pluginCandidates || [];
    if (runtimeBlockers.length === 0) {
      try { runtimeBlockers = pluginGuard.extractCandidates(assessment.smokeTest.output); } catch {}
    }
    assessment.runtimeIssues = runtimeBlockers;
    if (runtimeBlockers.length === 0) {
      return {
        started: false,
        blocked: true,
        reason: assessment.smokeTest.reason || 'target DSH failed its isolated boot test',
        assessment,
        incompatiblePlugins: [],
      };
    }
  }
  const blockerNames = [...new Set([
    ...blockers.map((risk) => risk.plugin).filter(Boolean),
    ...runtimeBlockers,
  ])];
  const protectedBlockers = blockerNames.filter((name) => !disableableNames.has(name));

  if (protectedBlockers.length > 0) {
    return {
      started: false,
      blocked: true,
      reason: `protected plugins are incompatible: ${protectedBlockers.join(', ')}`,
      assessment,
      incompatiblePlugins: blockerNames,
    };
  }
  if (blockerNames.length > 0 && !disableIncompatible) {
    return { started: false, blocked: true, assessment, incompatiblePlugins: blockerNames };
  }

  const disabledPlugins = disableIncompatible
    ? pluginGuard.disableMany(blockerNames, `disabled for DSH ${version} compatibility`)
    : [];
  const disableFailures = blockerNames.filter((name) => !disabledPlugins.includes(name));
  if (disableIncompatible && disableFailures.length > 0) {
    for (const plugin of disabledPlugins) {
      try { pluginGuard.setEnabled(plugin, true, 'restored after update preparation failed'); } catch {}
    }
    return {
      started: false,
      blocked: true,
      reason: `could not safely disable: ${disableFailures.join(', ')}`,
      assessment,
      incompatiblePlugins: blockerNames,
    };
  }
  if (disabledPlugins.length > 0) {
    const postDisableSmoke = await dshUpdater.smokeTest(version);
    assessment.postDisableSmokeTest = postDisableSmoke;
    if (!postDisableSmoke.ok) {
      for (const plugin of disabledPlugins) {
        try { pluginGuard.setEnabled(plugin, true, 'restored after candidate still failed without blockers'); } catch {}
      }
      return {
        started: false,
        blocked: true,
        reason: postDisableSmoke.reason || 'candidate DSH still failed after incompatible plugins were disabled',
        assessment,
        incompatiblePlugins: postDisableSmoke.pluginCandidates || [],
      };
    }
  }
  try {
    dshUpdater.beginUpdate(version, disabledPlugins);
  } catch (err) {
    for (const plugin of disabledPlugins) {
      try { pluginGuard.setEnabled(plugin, true, 'restored after update state write failed'); } catch {}
    }
    throw err;
  }
  refreshMenus();
  const result = await restartDsh();
  return {
    ...result,
    assessment,
    disabledPlugins,
    currentVersion: dshUpdater.currentVersion(),
  };
}

async function rollbackFailedUpdate(failureDetail) {
  if (updateRollbackInProgress) return { started: false, reason: 'rollback-already-running' };
  const pending = dshUpdater.state().pendingUpdate;
  if (!pending) return { started: false, reason: 'no-pending-update' };
  updateRollbackInProgress = true;
  try {
    dshUpdater.rollback('new DSH version failed startup or plugin activation health check');
    for (const plugin of pending.disabledPlugins || []) {
      try { pluginGuard.setEnabled(plugin, true, 'restored after DSH update rollback'); } catch {}
    }
    runtimePluginIssues.clear();
    warnedPluginIssueSignature = '';
    refreshMenus();
    const result = await restartDsh();
    if (result.started) {
      showNotification({
        title: 'DSH update rolled back',
        body: `DSH ${pending.to} failed its health check. Restored ${pending.from}.`,
      });
      await showErrorDialog(
        'DSH update rolled back safely',
        `DSH ${pending.to} failed to start cleanly, so the wrapper restored ${pending.from}.\n\n${failureDetail}`,
      );
    }
    return { ...result, rolledBack: true, from: pending.to, to: pending.from };
  } finally {
    updateRollbackInProgress = false;
  }
}

function openPluginManager() {
  if (pluginManagerWindow && !pluginManagerWindow.isDestroyed()) {
    pluginManagerWindow.show();
    pluginManagerWindow.focus();
    return;
  }
  pluginManagerWindow = new BrowserWindow({
    width: 780,
    height: 720,
    minWidth: 620,
    minHeight: 460,
    title: `${APP_NAME} DSH & Plugin Manager`,
    backgroundColor: '#0b0b0f',
    autoHideMenuBar: true,
    icon: existsSync(ICON_PATH) ? ICON_PATH : undefined,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  pluginManagerWindow.on('closed', () => { pluginManagerWindow = null; });
  pluginManagerWindow.loadFile(join(__dirname, 'plugin-manager.html')).catch((err) => {
    console.error(`[dsh-desktop] failed to open Plugin Manager: ${err.message}`);
  });
}

function openRecoveryCenter() {
  if (recoveryCenterWindow && !recoveryCenterWindow.isDestroyed()) {
    recoveryCenterWindow.show();
    recoveryCenterWindow.focus();
    return;
  }
  recoveryCenterWindow = new BrowserWindow({
    width: 780,
    height: 700,
    minWidth: 560,
    minHeight: 480,
    title: `${APP_NAME} Recovery Center`,
    backgroundColor: '#0b0b0f',
    autoHideMenuBar: true,
    icon: existsSync(ICON_PATH) ? ICON_PATH : undefined,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  recoveryCenterWindow.on('closed', () => { recoveryCenterWindow = null; });
  recoveryCenterWindow.loadFile(join(__dirname, 'recovery-center.html')).catch((err) => {
    console.error(`[dsh-desktop] failed to open Recovery Center: ${err.message}`);
  });
}

function refreshMenus() {
  buildMenu();
  refreshTrayMenu();
}

function safeModeStatus() {
  return healthSupervisor.state().safeMode;
}

function applySafeModeIfNeeded(force = false) {
  const safeMode = safeModeStatus();
  if ((!safeMode.active && !force) || safeMode.applied) return safeMode;
  const enabledCommunityPlugins = pluginGuard.listPlugins()
    .filter((plugin) => plugin.enabled && !plugin.protected)
    .map((plugin) => plugin.name);
  const disabledPlugins = pluginGuard.disableMany(
    enabledCommunityPlugins,
    'temporarily disabled by DSH Desktop Safe Mode after a crash loop',
  );
  const next = healthSupervisor.markSafeModeApplied(disabledPlugins).safeMode;
  console.error(`[dsh-desktop] Safe Mode enabled; disabled bundles: ${disabledPlugins.join(', ') || '(none)'}`);
  return next;
}

function restoreNormalMode() {
  const safeMode = safeModeStatus();
  for (const name of safeMode.disabledPlugins || []) {
    try { pluginGuard.setEnabled(name, true, 'restored when leaving DSH Desktop Safe Mode'); } catch {}
  }
  const next = healthSupervisor.clearSafeMode();
  runtimePluginIssues.clear();
  warnedPluginIssueSignature = '';
  refreshMenus();
  return next;
}

function captureDshOutput(text) {
  childStdout = `${childStdout}${text}`.slice(-100_000);
  if (/failed to import|cannot resolve profile bundle|did not activate[^\n]*pending/i.test(text)) {
    try {
      for (const plugin of pluginGuard.extractCandidates(text)) runtimePluginIssues.add(plugin);
    } catch (err) {
      console.error(`[dsh-desktop] plugin issue inspection failed: ${err.message}`);
    }
    if (dshChild?.__ready) {
      if (dshUpdater.state().pendingUpdate) {
        rollbackFailedUpdate(`Plugin activation issue(s):\n${[...runtimePluginIssues].join('\n')}`).catch((err) => {
          console.error(`[dsh-desktop] update rollback failed: ${err.message}`);
        });
      } else schedulePluginIssuePrompt();
    }
  }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

function showNotification({ title, body, silent, urgency, icon }) {
  try {
    if (!Notification.isSupported()) return { ok: false, reason: 'unsupported' };
    const notification = new Notification({
      title: String(title || APP_NAME).slice(0, 200),
      body: String(body || '').slice(0, 1000),
      silent: Boolean(silent),
      urgency,
      icon: typeof icon === 'string' && icon.length ? icon : undefined,
    });
    notification.show();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// ---------------------------------------------------------------------------
// Tray / background mode
// ---------------------------------------------------------------------------

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (resolvedUrl) createWindow(resolvedUrl);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function hideWindow() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    mainWindow.hide();
  }
}

function setBackgroundMode(enabled) {
  backgroundMode = Boolean(enabled);
  refreshTrayMenu();
  // If we just turned background mode off while the window is hidden, surface
  // it so the user isn't stranded with no visible UI.
  if (!backgroundMode && (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible())) {
    showWindow();
  }
}

function buildTrayMenu() {
  const recentSessions = getLastUsedSessions(5);
  const safeMode = safeModeStatus();
  const template = [
    {
      label: 'Show DeepSeek Harness',
      click: () => showWindow(),
    },
    { type: 'separator' },
    {
      label: 'Run in background',
      type: 'checkbox',
      checked: backgroundMode,
      click: (item) => setBackgroundMode(item.checked),
    },
    { type: 'separator' },
    {
      label: 'Restart DSH Server',
      click: () => { restartDsh(); },
    },
    {
      label: 'DSH & Plugin Manager…',
      click: () => openPluginManager(),
    },
    {
      label: 'Recovery Center…',
      click: () => openRecoveryCenter(),
    },
    ...(safeMode.active ? [
      {
        label: 'Safe Mode active',
        enabled: false,
      },
      {
        label: 'Restart normally (restore plugins)',
        click: async () => { restoreNormalMode(); await restartDsh(); },
      },
    ] : []),
    { type: 'separator' },
    {
      label: 'Sessions',
      submenu: [
        ...recentSessions.map(s => ({
          label: s.name,
          click: () => switchSession(s.id),
        })),
        { type: 'separator' },
        {
          label: 'New Session...',
          click: () => createSession(`Session ${Date.now()}`),
        },
      ],
    },
    {
      label: 'Quit',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ];
  return Menu.buildFromTemplate(template);
}

function refreshTrayMenu() {
  if (tray && !tray.isDestroyed()) {
    try {
      tray.setContextMenu(buildTrayMenu());
      tray.setToolTip(backgroundMode ? `${APP_NAME} (background)` : APP_NAME);
    } catch {}
  }
}

function ensureTray() {
  if (tray && !tray.isDestroyed()) return tray;
  let image;
  if (existsSync(ICON_PATH)) {
    image = nativeImage.createFromPath(ICON_PATH);
    if (image.isEmpty()) image = nativeImage.createEmpty();
  } else {
    image = nativeImage.createEmpty();
  }
  try {
    tray = new Tray(image);
  } catch (err) {
    // Some headless Linux sessions reject tray creation. Log and continue;
    // notifications still work without a tray.
    console.error(`[dsh-desktop] failed to create tray: ${err.message}`);
    tray = null;
    return null;
  }
  try {
    tray.setToolTip(APP_NAME);
    tray.setContextMenu(buildTrayMenu());
    tray.on('click', () => showWindow());
    tray.on('double-click', () => showWindow());
    tray.on('right-click', () => tray.popUpContextMenu(buildTrayMenu()));
  } catch {}
  return tray;
}

function destroyTray() {
  if (tray && !tray.isDestroyed()) {
    try { tray.destroy(); } catch {}
  }
  tray = null;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    title: APP_NAME,
    backgroundColor: '#0b0b0f',
    autoHideMenuBar: true,
    icon: existsSync(ICON_PATH) ? ICON_PATH : undefined,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Forward web links to the system browser instead of opening inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('http://') || target.startsWith('https://')) {
      shell.openExternal(target);
    }
    return { action: 'deny' };
  });

  // External navigations: open in the system browser. Local file:// splash
  // navigations (restart feedback) stay inside the window.
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (target.startsWith('file://')) return;
    if (!target.startsWith('http://localhost') && !target.startsWith('http://127.')) {
      event.preventDefault();
      shell.openExternal(target);
    }
  });

  // Close-to-tray: when background mode is on and a tray exists, hide the
  // window instead of quitting. The dsh web child stays alive; click the tray
  // icon to reopen.
  mainWindow.on('close', (event) => {
    if (!quitting && backgroundMode && tray && !tray.isDestroyed()) {
      event.preventDefault();
      hideWindow();
      // First time we hide, pop a quiet toast so the user knows where the
      // window went. We only do this once per session.
      if (!trayHintShown) {
        trayHintShown = true;
        showNotification({
          title: APP_NAME,
          body: 'Still running in the background. Click the tray icon to reopen.',
          silent: true,
        });
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Only kill the child when the window is truly closed (not when hidden).
    // If the app is quitting, before-quit handles child cleanup.
    if (quitting) killChild();
  });

  return mainWindow.loadURL(url);
}

function bootDsh() {
  applySafeModeIfNeeded();
  healthSupervisor.beginBoot();
  const launcher = findDshLauncher();
  const argv = launcher.endsWith('dsh-desktop.sh')
    ? []
    : ['--profile', 'electron'];

  childStdout = '';
  const child = spawn(launcher, argv, {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: process.env.HOME,
    detached: true, // own process group so signalChildGroup can stop the tree
  });
  child.__ready = false;
  child.__bootAt = Date.now();
  child.__failureRecorded = false;
  dshChild = child;

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    captureDshOutput(text);
    process.stdout.write(`[dsh] ${text}`);
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    captureDshOutput(text);
    process.stderr.write(`[dsh] ${text}`);
  });
  child.on('error', () => {
    // Surfaced through waitForChildUrl's 'error' rejection; dialogs live in
    // the caller (startup / restart) so the message is shown exactly once.
  });
  child.on('exit', (code, signal) => {
    if (dshChild !== child || child.__intentionalStop || quitting || restarting) return;
    dshChild = null;
    // Startup failures are handled by waitForChildUrl, which has fuller
    // recovery choices and must own the only dialog for that failure.
    if (child.__ready) {
      const early = Date.now() - child.__bootAt < healthSupervisor.earlyCrashMs;
      if (early && !child.__failureRecorded) {
        child.__failureRecorded = true;
        healthSupervisor.recordFailure(`early process exit (code=${code}, signal=${signal})`, 'early-crash');
      }
      showDshExitedDialog(code, signal, child.__failureRecorded);
    }
  });
  return child;
}

/**
 * Open a child BrowserWindow that renders an error message with selectable
 * and copyable text. `dialog.showErrorBox` and `showMessageBox` lock their
 * `detail` strings into a non-selectable native control, which is hostile
 * when the user needs to grab a stack trace and paste it elsewhere.
 *
 * @param {string} message - short headline shown above the log.
 * @param {string} detail - long body (captured stdout, stack trace, etc.).
 * @param {object} [options] - forwarded to `showErrorDialog`'s result; used
 *   by callers that need custom buttons.
 * @returns {Promise<number | undefined>} the index of the chosen button, or
 *   undefined if the window is gone before the user clicks.
 */
function showErrorDialog(message, detail, options = {}) {
  // Render the dialog in its own BrowserWindow so the text is real DOM the
  // user can highlight and Ctrl+C. Keep it modal to the main window (when
  // present) so the rest of the app stays inert until acknowledged.
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const win = new BrowserWindow({
    width: 720,
    height: 460,
    parent,
    modal: Boolean(parent),
    title: APP_NAME,
    backgroundColor: '#0b0b0f',
    autoHideMenuBar: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Escape the message/detail so any HTML metacharacters in the captured
  // stdout don't break the page.
  const escape = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const buttons = Array.isArray(options.buttons) && options.buttons.length > 0
    ? options.buttons
    : ['Close'];
  const defaultId = typeof options.defaultId === 'number' ? options.defaultId : 0;
  const cancelId = typeof options.cancelId === 'number' ? options.cancelId : buttons.length - 1;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escape(APP_NAME)}</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; padding: 0; height: 100%; background: #0b0b0f; color: #eee;
               font: 13px/1.45 ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace; }
  body { display: flex; flex-direction: column; padding: 14px; box-sizing: border-box; }
  h1 { margin: 0 0 10px; font: 600 15px/1.3 system-ui, sans-serif; color: #f0a4a4; }
  .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
  button { background: #1f1f2a; color: #eee; border: 1px solid #333; border-radius: 4px;
           padding: 6px 14px; font: 13px system-ui, sans-serif; cursor: pointer; }
  button.primary { background: #2c4a6e; border-color: #3a5e88; }
  button:hover { background: #2a2a36; }
  button.primary:hover { background: #345a82; }
  textarea { flex: 1; width: 100%; resize: none; background: #11111a; color: #d6d6d6;
             border: 1px solid #2a2a36; border-radius: 4px; padding: 10px;
             font: inherit; white-space: pre; tab-size: 4; user-select: text; -webkit-user-select: text; }
  textarea:focus { outline: 1px solid #3a5e88; }
  .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
  .toolbar small { color: #888; font: 12px system-ui, sans-serif; }
</style>
</head>
<body>
  <h1>${escape(message)}</h1>
  <div class="toolbar">
    <small>Selectable — Ctrl/Cmd+A then Ctrl/Cmd+C to copy.</small>
  </div>
  <textarea id="log" readonly spellcheck="false">${escape(detail)}</textarea>
  <div class="actions">
    ${buttons.map((label, i) => `<button class="${i === defaultId ? 'primary' : ''}" data-idx="${i}">${escape(label)}</button>`).join('')}
  </div>
<script>
  const buttons = document.querySelectorAll('button');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.idx);
      window.dshDesktop.errorDialogResult(idx);
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      window.dshDesktop.errorDialogResult(-1);
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      window.dshDesktop.errorDialogResult(${defaultId});
    }
  });
  // Make sure the textarea is fully selected on Ctrl/Cmd+A while focused.
  const log = document.getElementById('log');
  log.focus();
  log.setSelectionRange(0, 0);
  log.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      log.select();
    }
  });
</script>
</body>
</html>`;

  let resolvePromise;
  const settled = new Promise((resolve) => { resolvePromise = resolve; });

  // Single-shot handler — each dialog window registers once, then the main
  // side forwards the button index back.
  const ipcHandler = (_event, idx) => {
    if (!win || win.isDestroyed()) return;
    if (typeof idx === 'number' && idx >= 0 && idx < buttons.length) {
      resolvePromise(idx);
    } else {
      resolvePromise(cancelId);
    }
    win.close();
  };
  ipcMain.on('dsh-desktop:errorDialogResult', ipcHandler);

  win.on('closed', () => {
    ipcMain.removeListener('dsh-desktop:errorDialogResult', ipcHandler);
    // If the window was closed without a button click (X / Esc), fall through
    // to the cancel button so callers still get a deterministic response.
    resolvePromise(cancelId);
  });

  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    .catch(() => {});

  return settled;
}

function markDshReady(child) {
  if (child) child.__ready = true;
  if (runtimePluginIssues.size > 0) {
    if (dshUpdater.state().pendingUpdate) {
      rollbackFailedUpdate(`Plugin activation issue(s):\n${[...runtimePluginIssues].join('\n')}`).catch((err) => {
        console.error(`[dsh-desktop] update rollback failed: ${err.message}`);
      });
      return;
    }
    schedulePluginIssuePrompt();
    return;
  }
  // A listening port is not enough: ask the rendered web UI and the typed host
  // API to respond before declaring this build healthy.  The check is
  // side-effect free; an unattended tool call would require a configured LLM
  // and would create a durable user-visible session.
  setTimeout(async () => {
    if (dshChild !== child || child.exitCode !== null) return;
    if (runtimePluginIssues.size === 0) {
      try {
        const health = await healthSupervisor.probe(resolvedUrl);
        const peerHealth = await dshUpdater.runtimePeerHealth();
        if (peerHealth.mismatches.length > 0) {
          throw new Error(`runtime host packages diverged: ${peerHealth.mismatches.map((item) => item.name).join(', ')}`);
        }
        pluginGuard.recordHealthy();
        dshUpdater.confirmHealthy();
        healthSupervisor.recordHealthy(health);
      } catch (err) {
        const detail = `Post-boot health check failed: ${err.message}\n\nCaptured output:\n${childStdout.slice(-5000)}`;
        console.error(`[dsh-desktop] ${detail}`);
        if (child) child.__failureRecorded = true;
        healthSupervisor.recordFailure(err.message, 'health-probe');
        if (dshUpdater.state().pendingUpdate) {
          rollbackFailedUpdate(detail).catch((rollbackError) => {
            console.error(`[dsh-desktop] update rollback failed: ${rollbackError.message}`);
          });
        } else {
          await stopChild();
          await handleBootFailure('DSH failed its post-boot health check', detail, { alreadyRecorded: true });
        }
      }
    } else schedulePluginIssuePrompt();
  }, 1_500);
}

function schedulePluginIssuePrompt() {
  if (pluginIssuePromptScheduled || runtimePluginIssues.size === 0) return;
  const signature = [...runtimePluginIssues].sort().join('\n');
  if (signature === warnedPluginIssueSignature) return;
  pluginIssuePromptScheduled = true;
  setTimeout(async () => {
    pluginIssuePromptScheduled = false;
    if (runtimePluginIssues.size === 0) return;
    const plugins = [...runtimePluginIssues].sort();
    warnedPluginIssueSignature = plugins.join('\n');
    const response = await showErrorDialog(
      'Plugin did not activate',
      `DSH started, but these plugins reported a startup problem:\n\n${plugins.join('\n')}\n\nYou can disable them without uninstalling their packages.`,
      {
        buttons: ['Disable & Restart', 'Open Plugin Manager', 'Keep Enabled'],
        defaultId: 0,
        cancelId: 2,
      },
    );
    if (response === 0) {
      pluginGuard.disableMany(plugins, 'disabled after a runtime activation failure');
      runtimePluginIssues.clear();
      refreshMenus();
      await restartDsh();
    } else if (response === 1) {
      openPluginManager();
    }
  }, 700);
}

async function handleBootFailure(message, detail, options = {}) {
  if (!options.alreadyRecorded) {
    const child = dshChild;
    if (child && !child.__failureRecorded) child.__failureRecorded = true;
    if (!child || !child.__failureRecorded || !options.childAlreadyCounted) {
      healthSupervisor.recordFailure(message, 'startup');
    }
  }
  // After a repeated failure, recover automatically with only core bundles.
  // The package dependencies remain installed and "Restart normally" restores
  // exactly the bundles Safe Mode disabled.
  if (safeModeStatus().active && !safeModeStatus().applied) {
    const safeMode = applySafeModeIfNeeded();
    showNotification({
      title: `${APP_NAME} Safe Mode`,
      body: `Crash loop detected. Started with ${safeMode.disabledPlugins.length} community plugin(s) disabled.`,
    });
    return restartDsh();
  }
  let suspects = [];
  try {
    suspects = pluginGuard.extractCandidates(detail);
  } catch (err) {
    detail += `\n\nPlugin guard could not inspect the profile: ${err.message}`;
  }
  for (const plugin of suspects) runtimePluginIssues.add(plugin);

  const buttons = suspects.length > 0
    ? ['Disable plugin(s) & Restart', 'Open Plugin Manager', 'Quit']
    : ['Retry', 'Open Plugin Manager', 'Quit'];
  const suspectText = suspects.length > 0
    ? `\n\nLikely incompatible plugin(s):\n${suspects.join('\n')}\n\nDisabling keeps the package installed so it can be enabled again later.`
    : '\n\nNo single plugin could be identified automatically.';
  const response = await showErrorDialog(message, `${detail}${suspectText}`, {
    buttons,
    defaultId: 0,
    cancelId: 2,
  });

  if (response === 0) {
    if (suspects.length > 0) {
      pluginGuard.disableMany(suspects, 'disabled after preventing DSH startup');
      runtimePluginIssues.clear();
      refreshMenus();
    }
    return restartDsh();
  }
  if (response === 1) {
    openPluginManager();
    return { started: false, reason: 'plugin-manager-opened' };
  }
  quitting = true;
  app.quit();
  return { started: false, reason: 'quit' };
}

function showDshExitedDialog(code, signal, alreadyRecorded = false) {
  const detail = `dsh web exited (code=${code}, signal=${signal}).\n\nCaptured output:\n${childStdout.slice(-5000)}`;
  showNotification({
    title: `${APP_NAME} stopped`,
    body: 'dsh web exited unexpectedly. Recovery options are ready.',
  });
  if (dshUpdater.state().pendingUpdate) {
    rollbackFailedUpdate(detail).catch((err) => {
      console.error(`[dsh-desktop] update rollback failed: ${err.message}`);
    });
    return;
  }
  handleBootFailure('dsh web stopped unexpectedly', detail, { alreadyRecorded }).catch((err) => {
    console.error(`[dsh-desktop] recovery failed: ${err.message}`);
  });
}

async function restartDsh() {
  if (restarting) return { started: false, reason: 'already-restarting' };
  restarting = true;
  let failure = null;
  try {
    await loadSplash('restarting');
    await stopChild();
    resolvedUrl = null;
    runtimePluginIssues.clear();
    const child = bootDsh();
    const url = await waitForChildUrl(child, START_TIMEOUT_MS);
    await waitForUrl(url, CONNECT_TIMEOUT_MS);
    resolvedUrl = url;
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.loadURL(url);
    } else {
      await createWindow(url);
    }
    markDshReady(child);
    return { started: true };
  } catch (err) {
    failure = {
      message: 'Restart failed',
      detail: `Restart failed: ${err.message}\n\nCaptured output:\n${childStdout.slice(-5000)}`,
      reason: err.message,
    };
    await loadSplash('failed');
  } finally {
    restarting = false;
  }
  if (failure) {
    if (dshUpdater.state().pendingUpdate && !updateRollbackInProgress) {
      return rollbackFailedUpdate(failure.detail);
    }
    await handleBootFailure(failure.message, failure.detail);
    return { started: false, reason: failure.reason };
  }
  return { started: false, reason: 'unknown failure' };
}

function buildMenu() {
  const safeMode = safeModeStatus();
  const template = [
    {
      label: APP_NAME,
      submenu: [
        {
          label: 'Restart DSH Server',
          accelerator: 'CommandOrControl+Alt+R',
          click: () => { restartDsh(); },
        },
        {
          label: 'DSH & Plugin Manager…',
          accelerator: 'CommandOrControl+Shift+P',
          click: () => openPluginManager(),
        },
        {
          label: 'Recovery Center…',
          accelerator: 'CommandOrControl+Shift+R',
          click: () => openRecoveryCenter(),
        },
        ...(safeMode.active ? [{
          label: 'Restart normally (restore Safe Mode plugins)',
          click: async () => { restoreNormalMode(); await restartDsh(); },
        }] : []),
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// IPC (exposed to the renderer through preload.js)
// ---------------------------------------------------------------------------

ipcMain.handle('dsh-desktop:restart', () => restartDsh());

ipcMain.handle('dsh-desktop:plugins:list', () => ({
  plugins: pluginGuard.listPlugins(),
  profileDir: ELECTRON_PROFILE_DIR,
}));

ipcMain.handle('dsh-desktop:plugins:toggle', async (_event, name, enabled) => {
  pluginGuard.setEnabled(name, Boolean(enabled));
  runtimePluginIssues.delete(name);
  warnedPluginIssueSignature = '';
  refreshMenus();
  return restartDsh();
});

ipcMain.handle('dsh-desktop:plugins:check', () => checkPlugins());

ipcMain.handle('dsh-desktop:dynamic-plugins:list', async () => ({
  plugins: await scanDynamicCordisPlugins({ sessionsDir: DSH_SESSIONS_DIR }),
}));

ipcMain.handle('dsh-desktop:dynamic-plugins:promote', async (_event, id) => {
  const promoted = await promoteDynamicPlugin({
    profileDir: ELECTRON_PROFILE_DIR,
    sessionsDir: DSH_SESSIONS_DIR,
    id: String(id),
  });
  return { ...promoted, ...(await restartDsh()) };
});

ipcMain.handle('dsh-desktop:runtime:repair', async () => {
  const version = dshUpdater.currentVersion();
  const dshInstallDir = await dshUpdater.materialize(version);
  const result = unifyRuntimePeers(ELECTRON_PROFILE_DIR, dshInstallDir);
  const restart = await restartDsh();
  return {
    ...restart,
    runtimeVersion: result.runtimeVersion,
    total: result.peers.length,
    unified: result.peers.length - result.mismatches.length,
    changed: result.changed,
  };
});

ipcMain.handle('dsh-desktop:safe-mode:status', () => ({
  ...safeModeStatus(),
  failures: healthSupervisor.state().failures,
  lastHealth: healthSupervisor.state().lastHealth,
}));

ipcMain.handle('dsh-desktop:safe-mode:restart', async () => {
  applySafeModeIfNeeded(true);
  return restartDsh();
});

ipcMain.handle('dsh-desktop:safe-mode:restart-normal', async () => {
  restoreNormalMode();
  return restartDsh();
});

ipcMain.handle('dsh-desktop:plugins:open', () => {
  openPluginManager();
  return { ok: true };
});

ipcMain.handle('dsh-desktop:recovery:open', () => {
  openRecoveryCenter();
  return { ok: true };
});

ipcMain.handle('dsh-desktop:updates:info', (_event, refresh) => dshUpdater.info(Boolean(refresh)));

ipcMain.handle('dsh-desktop:updates:preflight', (_event, version) => dshUpdater.assess(String(version)));

ipcMain.handle('dsh-desktop:updates:install', (_event, version, disableIncompatible) => (
  installDshUpdate(String(version), Boolean(disableIncompatible))
));

ipcMain.handle('dsh-desktop:notify', (_event, payload) => showNotification(payload || {}));

ipcMain.handle('dsh-desktop:setBackground', (_event, enabled) => {
  setBackgroundMode(Boolean(enabled));
  return { ok: true, backgroundMode };
});

ipcMain.handle('dsh-desktop:getBackground', () => ({ backgroundMode }));

ipcMain.handle('dsh-desktop:listSessions', () => {
  return loadSessions();
});

ipcMain.handle('dsh-desktop:createSession', (_event, name) => {
  return createSession(name);
});

ipcMain.handle('dsh-desktop:deleteSession', (_event, id) => {
  return deleteSession(id);
});

ipcMain.handle('dsh-desktop:switchSession', (_event, id) => {
  return switchSession(id);
});

ipcMain.handle('dsh-desktop:showWindow', () => {
  showWindow();
  return { ok: true };
});

ipcMain.handle('dsh-desktop:hideWindow', () => {
  hideWindow();
  return { ok: true };
});

ipcMain.handle('dsh-desktop:quit', () => {
  quitting = true;
  app.quit();
  return { ok: true };
});

ipcMain.handle('dsh-desktop:ready', () => ({
  ok: true,
  backgroundMode,
  platform: process.platform,
  notificationsSupported: Notification.isSupported(),
  dshVersion: dshUpdater.currentVersion(),
  safeMode: safeModeStatus(),
}));

// ---------------------------------------------------------------------------
// App bootstrap
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  // AppUserModelId improves Windows toast identification; harmless elsewhere.
  if (process.platform === 'win32') app.setAppUserModelId('com.jessen.dsh.desktop');

  buildMenu();
  ensureTray();
  dshUpdater.info(false).then((info) => {
    if (info.updateAvailable) {
      showNotification({
        title: `DSH ${info.latestVersion} is available`,
        body: `Current version: ${info.currentVersion}. Open Plugin Manager to preflight the update.`,
        silent: true,
      });
    }
  }).catch((err) => {
    console.error(`[dsh-desktop] update check failed: ${err.message}`);
  });
  runtimePluginIssues.clear();
  const child = bootDsh();
  try {
    resolvedUrl = await waitForChildUrl(child, START_TIMEOUT_MS);
    await waitForUrl(resolvedUrl, CONNECT_TIMEOUT_MS);
    await createWindow(resolvedUrl);
    markDshReady(child);
  } catch (err) {
    killChild();
    const detail = `Could not start: ${err.message}\n\nCaptured output:\n${childStdout.slice(-5000)}`;
    if (dshUpdater.state().pendingUpdate) await rollbackFailedUpdate(detail);
    else await handleBootFailure('Could not start DSH', detail);
  }
});

app.on('window-all-closed', () => {
  // On macOS the convention is to keep the app alive. On Linux/Windows we
  // honor background mode: if a tray exists and background mode is on, stay
  // alive and let the user reopen from the tray.
  if (process.platform === 'darwin') return;
  if (!quitting && backgroundMode && tray && !tray.isDestroyed()) return;
  killChild();
  app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  killChild();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && resolvedUrl) {
    createWindow(resolvedUrl);
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    showWindow();
  }
});

app.on('will-quit', () => {
  destroyTray();
});
