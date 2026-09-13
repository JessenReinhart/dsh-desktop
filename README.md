# DeepSeek Harness Desktop

Electron-based standalone wrapper for the DeepSeek Harness (`dsh web`) on Linux.

## Features

- Runs the same web UI as the browser, but inside a desktop window.
- Spawns `dsh web` automatically, kills it when the app actually quits.
- Restarts the DSH server from **DeepSeek Harness → Restart DSH Server**, the tray menu, or `Ctrl+Alt+R`.
- Picks a free OS port so it never conflicts with an existing `dsh web` server.
- Uses the same config/sessions as the browser version (`~/.dsh`).
- Works with the existing 9router model setup.
- Native desktop notifications for assistant turns and DSH failures.
- Runs in the background (close-to-tray) like Codex — reopen from the tray
  icon to restore the live `dsh web` session.
- Keeps the Electron shell alive when a plugin prevents DSH from booting, then
  offers to disable the likely culprit and restart without uninstalling it.
- Includes a native Plugin Manager with enable/disable and compatibility checks.
- Updates the pinned DSH runtime with a plugin preflight, health-confirmation
  window, and automatic rollback when the new runtime cannot boot cleanly.
- Unifies profile-local `@deepseek-ai/*` host packages with the selected DSH
  runtime, preventing Symbol/service identity splits that break every tool call.
- Runs DSH from a persistent, verified runtime store rather than volatile
  `/tmp/bunx-*` directories.
- Verifies the rendered UI and DSH host RPC after boot; repeated early failures
  automatically enter reversible Safe Mode instead of crash-looping.
- Includes an accessible Recovery Center, keyboard-first Plugin Manager,
  reduced-motion support, and high-contrast support.

## Desktop capabilities

### Notifications

`window.dshDesktop.notify({ title, body, silent?, icon? })` shows a native OS
toast via Electron's `Notification` API. The wrapper also fires toasts on its
own when:

- the DSH child crashes or exits unexpectedly (so background-mode users
  notice the failure), and
- the window is hidden to the tray for the first time (so the user knows
  where the window went).

The capability is exposed to the page through `preload.js` over the standard
`ipcRenderer.invoke` bridge.

### Background mode (close-to-tray)

By default the wrapper starts with **Run in background** enabled. Closing the
window hides it to the system tray instead of quitting the app — the `dsh web`
child stays alive, so reopening from the tray restores the same live session.

Tray menu:

- **Show DeepSeek Harness** — restore the window.
- **Run in background** — toggle close-to-tray behavior.
- **Restart DSH Server** — bounce the `dsh web` child without quitting.
- **DSH & Plugin Manager…** — update DSH or manage Electron-profile plugins.
- **Quit** — kill the child and exit.

The renderer can also control background mode at runtime:

```js
await window.dshDesktop.setBackgroundMode(true); // or false
const { backgroundMode } = await window.dshDesktop.getBackgroundMode();
```

## Files

- `main.js` — Electron main process (launches DSH child, opens window, routes
  links, owns the tray and notifications).
- `preload.js` — contextBridge surface for notifications and background mode.
- `plugin-guard.js` — last-known-good state and reversible plugin quarantine.
- `dsh-updater.js` — npm version discovery, compatibility preflight, and
  transactional DSH version/rollback state.
- `runtime-store.js` — staged, validated persistent DSH runtimes at
  `~/.local/share/dsh-desktop/runtimes/`.
- `runtime-unifier.js` — reversible host-package identity repair and health check.
- `health-supervisor.js` — persistent crash-loop tracking, Safe Mode policy,
  and post-boot host RPC probe.
- `plugin-manager.html` — wrapper-native plugin management window.
- `recovery-center.html` — recovery actions available even when DSH itself
  cannot load.
- `dsh-desktop.sh` — helper script that starts `dsh web --no-open --port 0`.
- `start-dsh-desktop.sh` — launcher used by the `.desktop` entry.
- `dsh.desktop` — Linux application menu entry.
- `icon.png` — 512×512 app icon (also used as tray icon).
- `index.html` — minimal renderer splash used during restarts.

## Run

From a terminal in a graphical session:

```bash
/home/jessen/projects/dsh-desktop/start-dsh-desktop.sh
```

Or open the app from the GNOME/DE app launcher via **DeepSeek Harness**.

## Development

```bash
cd /home/jessen/projects/dsh-desktop
npm start     # dev mode with console output
npm run build # build AppImage + deb
```

## Troubleshooting

- **Icon not showing:** run `update-desktop-database ~/.local/share/applications` and restart GNOME Shell (`Alt+F2` → `r`).
- **DSH child never starts:** make sure `bun` is in `$HOME/.bun/bin` and the 9router provider is reachable (the launcher sets `NINEROUTER_BASE_URL` to `http://localhost:20128/v1` by default).
- **GPU/sandbox crashes:** the launcher keeps Chromium's sandbox disabled on Linux for compatibility, while leaving GPU acceleration enabled. If a driver-specific crash happens, inspect the GPU status first instead of disabling it globally.

## Bonus: built-in headless one-shot mode

If you just want to run a single task from the terminal without a UI:

```bash
dsh --profile headless "your task here"
```

That needs no browser either.

## Plugin management

The Electron wrapper uses the pinned compatibility profile `electron` with
`@deepseek-ai/dsh@0.1.1-rc.2`. Add or remove its plugins with the same pinned
DSH version so they are not installed into the separate default `web` profile:

```bash
# install a plugin
bunx @deepseek-ai/dsh@0.1.1-rc.2 plugin --profile electron add <plugin>@<version>

# list plugins
bunx @deepseek-ai/dsh@0.1.1-rc.2 plugin --profile electron list

# remove a plugin
bunx @deepseek-ai/dsh@0.1.1-rc.2 plugin --profile electron remove <plugin>
```

Do not install a marketplace plugin into this profile unless it explicitly
supports DSH `0.1.1-rc.2`; the launcher stays pinned to keep the desktop app
bootable.

The wrapper repairs a second class of incompatibility automatically: plugins
may install their own byte-identical copies of DSH host packages, but DSH uses
identity-bearing Symbols and service objects that cannot cross those duplicate
module graphs. Before every boot, shared `@deepseek-ai/*` packages are linked to
the exact selected runtime. Originals are preserved under
`~/.dsh/profiles/electron/.dsh-desktop-peer-backups`, and the manager shows the
current identity health plus a manual **Repair runtime & restart** action.

### Crash-safe plugin recovery

Open **DeepSeek Harness → DSH & Plugin Manager…** or press `Ctrl+Shift+P`. Disabling
a plugin removes it from the active profile bundle list but leaves its package
installed, so it can be re-enabled later. The wrapper stores this reversible
state in `~/.dsh/profiles/electron/.dsh-desktop-plugin-guard.json` and mirrors
disabled names to dshmarket's state file.

If DSH exits before its UI is ready, the Electron process remains open. It
examines the captured boot log and the last healthy bundle set, then offers
**Disable plugin(s) & Restart**, **Open Plugin Manager**, or **Quit**. Plugins
that merely stay pending after the server starts get the same recovery choice
without taking down the working UI.

### Safe Mode and Recovery Center

After three startup, early-exit, or post-boot health failures in ten minutes,
the wrapper automatically starts in **Safe Mode**. It temporarily disables only
enabled, non-core plugins; no plugin package, chat, or workspace is deleted.
Choose **Restart normally (restore plugins)** from the tray/menu after fixing
the cause, or open **DeepSeek Harness → Recovery Center…** for diagnosis,
runtime repair, Safe Mode, and Plugin Manager actions.

The post-boot check requires both the DSH web UI and its side-effect-free
`host.describe` RPC to respond. A listening port alone is never treated as a
healthy runtime.

### Persistent runtimes

Every selected DSH version is downloaded once into a wrapper-owned versioned
store, validated, staged, and atomically promoted before it can boot:

```text
~/.local/share/dsh-desktop/runtimes/<version>/
```

The launcher never executes DSH from Bun's temporary cache. You can inspect
the store with:

```bash
node /home/jessen/projects/dsh-desktop/runtime-store.js --inspect
```

### Dynamic Cordis plugin scanner

The Plugin Manager scans retained DSH session logs for model-authored
`cordis_define` definitions. A **Dynamic Cordis plugins** section shows their
name, purpose, whether they ran, and whether they contain browser/client code.

For a trusted **Host-only** definition, choose **Install permanently**. The
wrapper writes a transparent local bundle under
`~/.dsh/profiles/electron/.dsh-desktop-local-plugins/`, links it into the
Electron profile, adds it to the normal bundle roster, and restarts DSH. It
then appears in the regular Plugin Manager and can be disabled safely like any
other community plugin.

Dynamic plugins with Client code are intentionally marked **Review required**:
their browser bundle needs a reviewed static build and is never silently
converted into executable permanent code.

### Safe DSH updates

The same manager includes a **DSH Runtime** section. Pick a published version,
run **Compatibility preflight**, then choose **Install & restart**. The updater:

1. downloads/materializes the target DSH version,
2. compares the current and target plugin peer-contract reports through
   dshmarket,
3. performs an isolated candidate boot against the current Electron profile
   with its own unified host-package graph to catch undeclared/internal API
   incompatibilities,
4. blocks newly introduced hard incompatibilities (or offers to temporarily
   disable the affected non-core plugins), then retests the candidate with
   those blockers disabled before changing the active version,
5. switches the runtime version and restarts DSH, and
6. confirms the update only after DSH and its plugins stay healthy.

If startup or plugin activation fails during that health window, the wrapper
automatically restores the previous DSH version and any plugins it disabled for
the attempted update. Runtime state and the short update history live in
`~/.dsh/profiles/electron/.dsh-desktop-runtime.json`.
