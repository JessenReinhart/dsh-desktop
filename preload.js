// preload.js — safe bridge between Electron main and the DSH web renderer.
// Exposes only the IPC channels we explicitly handle on the main side; no
// direct node access is granted to the page.
const { contextBridge, ipcRenderer } = require('electron');

const bridge = {
  platform: process.platform,

  // Returns { started: true } on success, { started: false, reason: string } otherwise.
  restartDsh: () => ipcRenderer.invoke('dsh-desktop:restart'),

  // Fail-safe plugin controls for the pinned electron profile. Disabling a
  // plugin removes it from active bundles but keeps the dependency installed.
  listPlugins: () => ipcRenderer.invoke('dsh-desktop:plugins:list'),
  togglePlugin: (name, enabled) => ipcRenderer.invoke(
    'dsh-desktop:plugins:toggle',
    String(name),
    Boolean(enabled),
  ),
  checkPlugins: () => ipcRenderer.invoke('dsh-desktop:plugins:check'),
  listDynamicPlugins: () => ipcRenderer.invoke('dsh-desktop:dynamic-plugins:list'),
  promoteDynamicPlugin: (id) => ipcRenderer.invoke('dsh-desktop:dynamic-plugins:promote', String(id)),
  repairRuntimePeers: () => ipcRenderer.invoke('dsh-desktop:runtime:repair'),
  getSafeModeStatus: () => ipcRenderer.invoke('dsh-desktop:safe-mode:status'),
  restartInSafeMode: () => ipcRenderer.invoke('dsh-desktop:safe-mode:restart'),
  restartNormally: () => ipcRenderer.invoke('dsh-desktop:safe-mode:restart-normal'),
  openPluginManager: () => ipcRenderer.invoke('dsh-desktop:plugins:open'),
  openRecoveryCenter: () => ipcRenderer.invoke('dsh-desktop:recovery:open'),
  getDshUpdateInfo: (refresh = false) => ipcRenderer.invoke('dsh-desktop:updates:info', Boolean(refresh)),
  preflightDshUpdate: (version) => ipcRenderer.invoke('dsh-desktop:updates:preflight', String(version)),
  installDshUpdate: (version, disableIncompatible = false) => ipcRenderer.invoke(
    'dsh-desktop:updates:install',
    String(version),
    Boolean(disableIncompatible),
  ),

  // Display a native desktop notification through Electron.
  //   notify({ title?: string, body?: string, silent?: boolean, icon?: string })
  // returns { ok: boolean, reason?: string }
  notify: (payload) => ipcRenderer.invoke('dsh-desktop:notify', payload || {}),

  // Toggle / inspect "run in background" mode (close-to-tray). Persists for
  // the current app session; main returns the new state.
  setBackgroundMode: (enabled) => ipcRenderer.invoke('dsh-desktop:setBackground', !!enabled),
  getBackgroundMode: () => ipcRenderer.invoke('dsh-desktop:getBackground'),

  // Window control helpers — useful for tray-driven "reopen" flows.
  showWindow: () => ipcRenderer.invoke('dsh-desktop:showWindow'),
  hideWindow: () => ipcRenderer.invoke('dsh-desktop:hideWindow'),

  // Truly quit the wrapper (including killing the dsh web child).
  quit: () => ipcRenderer.invoke('dsh-desktop:quit'),

  // Handshake used by the page to discover capabilities.
  ready: () => ipcRenderer.invoke('dsh-desktop:ready'),

  // Notify main of the chosen button in an error dialog window. Send-only
  // (fire-and-forget); main resolves the dialog's Promise.
  errorDialogResult: (index) => ipcRenderer.send('dsh-desktop:errorDialogResult', Number(index)),
};

contextBridge.exposeInMainWorld('dshDesktop', bridge);

// Fire-and-forget capability probe so the page can decide whether to wire
// notifications without first awaiting an explicit ready() call.
ipcRenderer
  .invoke('dsh-desktop:ready')
  .then((info) => {
    contextBridge.exposeInMainWorld('dshDesktopInfo', {
      platform: info && info.platform,
      backgroundMode: !!(info && info.backgroundMode),
      notificationsSupported: !!(info && info.notificationsSupported),
    });
  })
  .catch(() => {});
