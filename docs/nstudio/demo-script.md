# Kody Lab demo script (macOS)

About five minutes. Everything runs from the local Kody Lab build next to the
published Kody app, driven by the `@nstudio/nativescript-github-dashboard`
package app.

## Setup before recording

- Kody Lab signed in, this Mac registered, **Allow commands** and **Lab › Allow
  simulators** on.
- `simdeck`, Xcode, an iOS simulator, and (optionally) an Android emulator
  installed.
- Dashboard synced; pick a PR that is awaiting workflow approval and one
  critical PR.
- Editor (VS Code or Xcode) frontmost, Kody Lab windows closed.

## 1. Quick panel without leaving your editor (60 s)

1. In the editor, press ⌥Space. The panel appears over the editor; the editor
   keeps the menu bar.
2. Point out the status line: "typing over Visual Studio Code".
3. Type `awaiting`: "Workflows awaiting approval (N)". Type `critical`, then a
   PR number such as `#11633`.
4. Esc: the editor still has focus, the cursor is where it was.

Talking point: Electron cannot show a keyboard-focusable panel without
activating the app (electron/electron#52915). Kody Lab subclasses nothing and
patches nothing: the NativeScript macOS runtime makes AppKit available in the
main process, and the panel is made key with `makeKeyAndOrderFront` directly.

## 2. Notifications (30 s)

1. Show a macOS notification: "#N needs workflow approval" (or a critical PR /
   failing CI / toolbox run).
2. Click it: the review panel opens for that PR.

## 3. Review beside the simulator (2 min)

1. ⌥Space, `#<pr>`, ⌘↩ opens the review panel docked to the right of the screen.
2. Approve the held workflows from the panel; CI starts.
3. **Run on iOS**: the toolbox runner (a Kody job routed to this Mac) checks out
   the PR, installs, and launches `apps/toolbox` on the simulator through
   `kody.simulator.*`. The log streams in the panel.
4. Click into the simulator and use the app. Then type notes: keystrokes go to
   the review panel while the simulator stays frontmost. ⌘1–9 ticks checklist
   items generated from what the PR touches.
5. **Screenshot** / **Inspect** attach the simulator's screen and NativeScript
   view tree to the review.
6. ⌘↩ posts the review to GitHub with the checklist; show it on the PR page.

## 4. Simulators as a permissioned capability (45 s)

1. Lab menu (or the Kody website's This machine page): Allow simulators is a
   separate switch from Allow commands.
2. Show the execution context audit log: each `kody.simulator.*` call is
   recorded like a host command.
3. Explain: packages and agents get typed actions (list, boot, install, launch,
   screenshot, describe) instead of shell text, and the server change upstream
   would be a grant of its own.

## 5. Close (15 s)

Kody Lab runs beside the published app with its own name, data, and no
auto-update. Windows and Linux fall back to normal windows; the native panel
path is macOS (Apple Silicon) for now.
