# Kody desktop: native surfaces (nstudio local build)

Local branch `nstudio/native-surfaces` of kody-hq/kody. Goal: a macOS build we
use daily and demo in one video, then ask the maintainers whether they want any
of it before opening PRs (CLA required per commit). Windows and Linux follow
once macOS is solid.

## Findings that shape the design

- Desktop 0.1.35 is Electron 45.2.0, plain CommonJS, `asar: false`,
  `npmRebuild: false`. Node-API modules load without an Electron rebuild, so
  `@nativescript/macos-node-api` (Apple Silicon, ~8 MB) can be lazy-loaded in
  the main process.
- Every window loads kody.codes; the preload bridge is a fixed action list. New
  surfaces get their own desktop-owned pages and their own narrow bridges
  instead of widening `kodyDesktop` on the website.
- `kody.command.*` runs in the daemon: the CLI's local runtime bridge intercepts
  the call and only asks the server to authorize and audit
  (`kody.command.authorize`). A `kody.simulator.*` namespace can be added the
  same way with no server change.
- Prototype (scratchpad `ns-electron-proto`): an Electron `type: 'panel'`
  BrowserWindow is already non-activating (styleMask 143). Calling AppKit
  `makeKeyAndOrderFront` through NativeScript instead of Electron's `focus()`
  makes it key with page focus while another app stays frontmost — the behavior
  electron/electron#52915 asks for.

## Features

1. **Quick panel (⌥Space).** Non-activating web panel over whatever app is
   frontmost: search packages, apps and guides, pending approvals, machine
   status (pause/resume), recent package apps. Enter opens the result in a Kody
   window; Esc dismisses without the frontmost app losing focus. Fallback off
   macOS: a normal focused window.
2. **Native notifications.** Runs on this machine finishing or failing (from the
   supervised daemon), approvals waiting (polled through the bundled CLI with
   the desktop login), simulator sessions ready. Clicking opens the relevant
   page. Plain Electron `Notification`; no NativeScript.
3. **Simulators capability.** `kody.simulator.*` in the daemon (list, boot,
   shutdown, install, launch, openUrl, screenshot, describe, stream URL), backed
   by `xcrun simctl`, `adb`/`emulator`, and SimDeck when installed. Each call is
   authorized and audited through the existing command-authorize hop and also
   needs a local opt-in (`kody context simulators on`, Machine › Allow
   simulators). The dashboard's toolbox runner uses it when present.
4. **Review panel.** A floating non-activating panel next to the simulator
   showing the PR under test (CI state, blast radius factors, critical reasons,
   a review checklist) that takes notes and keystrokes while the simulator stays
   frontmost, then submits a GitHub review (comment, approve, request changes)
   through the NativeScript dashboard. Opened from the quick panel ("review
   #11633") or a global shortcut.

## Phases

0. Fork, install, prototype, baseline `npm run desktop:dev`. _(prototype done)_
1. Notifications (2) — smallest, no new runtime.
2. NativeScript loader + quick panel (1): lazy runtime load, panel helper,
   desktop-owned panel page and bridge, search/approvals/machine actions via the
   bundled CLI.
3. Simulators capability (3): CLI namespace, local opt-in, desktop toggle,
   dashboard runner switch.
4. Review panel (4): dashboard review view + review endpoint, desktop panel,
   shortcut and quick-panel entry.
5. Local packaged build with its own app id and data directory so it runs beside
   the installed Kody; demo script and video.
6. Windows and Linux fallbacks.

## Out of scope until maintainers respond

Signing/notarization, auto-update of the local build, server-side grants for
simulators, PRs upstream.
