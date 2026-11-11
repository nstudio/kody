# Kody Lab: what we built, what we learned, how to upstream it

nStudio notes from the Kody desktop feature pass of 2026-11-10 and 11. Read this
before opening PRs against kody-hq/kody. It covers:

- what exists on the fork,
- how to split it into PRs the maintainers can review,
- what to strip or generalize first,
- the platform behavior we had to discover the hard way.

Related docs:

- [native-surfaces-plan.md](./native-surfaces-plan.md): the original plan and
  phases.
- [demo-script.md](./demo-script.md): the video script. Several of its claims
  are now wrong; see [Open items](#open-items-before-any-pr).

## Where everything lives

Point Kody contributors here:

| What                                                                                                           | Where                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kody Lab (desktop features, `kody.simulator.*`, docs)                                                          | [github.com/nstudio/kody, branch `nstudio/native-surfaces`](https://github.com/nstudio/kody/tree/nstudio/native-surfaces), a fork of kody-hq/kody |
| This doc, the plan, and the demo script                                                                        | `docs/nstudio/` on that branch                                                                                                                    |
| NativeScript PR dashboard (the package app Kody Lab drives, including the review hook in `src/review-hook.ts`) | Kody package `@nstudio/nativescript-github-dashboard` in the @nstudio workspace, app at `nstudio.kody.run/nativescript-github-dashboard`          |
| SimDeck fixes (Xcode 27 SimulatorKit path, dtuhidd input)                                                      | NativeScript/SimDeck #87 and #91, released in `simdeck@0.2.1` on npm                                                                              |
| Demo video                                                                                                     | `~/Movies/kody-lab-demo.mp4` on the nStudio Mac (not published)                                                                                   |

## Status snapshot (2026-11-11)

**Branch.** `nstudio/native-surfaces` in `kody-hq-kody`.

- On top of upstream `d2803138f`, published at
  [nstudio/kody `nstudio/native-surfaces`](https://github.com/nstudio/kody/tree/nstudio/native-surfaces).
  It passes upstream's pre-push checks (format, lint, typecheck, Knip, and the
  full unit-test suite).
- Upstream `main` is 13 commits ahead. None of those commits touch our files, so
  a rebase should be clean.

**Size.** 31 files, about 4,300 added lines. Of those:

- About 1,400 are `host-simulators.ts`.
- About 850 are its tests.
- About 320 are docs.

**Tests.**

- Desktop: `npm test` in `packages/desktop` passes 174 tests, including 12 new
  `lab-logic` tests.
- Simulator capability: `test/host-simulators.test.ts` in `packages/cli` passes
  20 tests.

**Packaged app.** `npm run desktop:pack` builds an unsigned `Kody Lab.app` (app
id `codes.kody.desktop.lab`). It is installed at `/Applications/Kody Lab.app`
and runs beside the published Kody.app.

**Companion repos.**

- `nativescript-github-dashboard`: the Kody package app
  (`@nstudio/nativescript-github-dashboard`) that Kody Lab's surfaces drive.
- NativeScript/SimDeck: #87 and #91 were fixed as part of this work, merged, and
  released in SimDeck 0.2.1 (installed globally from npm).

**Demo.** A 4-minute edited video at `~/Movies/kody-lab-demo.mp4`. The raw takes
and recording scripts were deleted.

## What Kody Lab adds

| Feature                       | User-visible behavior                                                                                                                                                                                                                                                                                             | Where                                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Quick panel                   | ⌥Space over any app. A floating panel takes typing while the app you were in keeps the menu bar. It shows PR search, dashboard views, pending approvals, and "review #N". Esc hands the keyboard back.                                                                                                            | `lab.cjs`, `lab-logic.cjs`, `native.cjs`, `quick-panel.html`, `quick-panel-preload.cjs`                             |
| Native notifications          | Notifies on a new critical PR, CI failing, a PR awaiting approval, Kody approvals pending, and toolbox run state. Clicking one opens the review panel for that PR.                                                                                                                                                | `lab.cjs` (`poll`, `pollApprovals`, `notify`), `lab-logic.cjs`                                                      |
| `kody.simulator.*` capability | Package code running on a machine can list, boot, shutdown, install, launch, terminate, openUrl, screenshot, describe, and stream iOS simulators and Android emulators. No raw shell, and no server change.                                                                                                       | `packages/cli/src/execution-context/host-simulators.ts` and its wiring; `docs/use/execution-contexts.md#simulators` |
| Review panel                  | ⌥⇧R, or ⌘↩ from the quick panel. A non-activating panel docked beside the simulator shows the PR's CI state, blast radius, critical flags, and a checklist. You can write notes, approve fork workflows, run the toolbox app, take captures, and submit a GitHub review, all while the simulator stays frontmost. | `lab.cjs` (`openReview`, `openSimDeck`), `dashboard.cjs`                                                            |
| Side-by-side edition          | Installs as "Kody Lab" next to Kody.app: own name, data folder, single-instance lock, tray title, and title/badge. Auto-update is off for both the app and its runner.                                                                                                                                            | `edition.cjs`, `main.cjs`, `presence.cjs`, `runner.cjs`, `package.json`                                             |
| Allow simulators switch       | A local opt-in in **Machine › Allow simulators** and in the tray menu. It is backed by `kody context simulators on\|off\|status`.                                                                                                                                                                                 | `lab.cjs`, `fs-access.ts`, `commands.ts`, `command-help.ts`                                                         |

## Proposed PR split

The maintainers asked for nothing yet. The plan is to show the video and ask
which features they want, then open only those. Each row below can land on its
own, in this order of dependency.

| #   | PR                                                                 | Contents                                                                                                                                                                                                                                    | Depends on                                                  | Notes                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Worker: pass `simulator` through the package-bound kody shim**   | 1 line in `packages/worker/src/package-runtime/local-execute-runtime-support.ts`                                                                                                                                                            | none                                                        | This is the real fix for `kody.simulator.list is not a function` in package code. Tiny and safe, but it only matters if #2 lands.                                                                                                                                                   |
| 2   | **CLI: `kody.simulator.*` for execution contexts**                 | `host-simulators.ts` and its tests; `fs-access.ts` simulators policy; `kody context simulators`; `local-execute.ts` interception; `run-executor.ts` and `daemon.ts` wiring; `HostCommands.reportFinished`; `docs/use/execution-contexts.md` | #1 for package code; direct `execute` calls work without it | Probably needs an ADR, modeled on [0093 host commands](../contributing/decisions/0093-execution-context-host-commands.md). The CLI-side back-compat shims (`__kodyObjectNamespaces`, `passContextNamespaces`) can be dropped if the worker change ships first; ask the maintainers. |
| 3   | **Desktop: Allow simulators switch**                               | Machine-menu item and confirm dialog; README paragraph                                                                                                                                                                                      | #2                                                          | Small. The tray part needs #4's `extraItems` hook.                                                                                                                                                                                                                                  |
| 4   | **Desktop: NativeScript runtime loader and non-activating panels** | `native.cjs`, the `@nativescript/macos-node-api` dependency, `presence.cjs` `extraItems`/`refresh`                                                                                                                                          | none                                                        | This is the enabling piece. Pitch it with electron/electron#52915: Electron can't focus a panel without activating the app.                                                                                                                                                         |
| 5   | **Desktop: quick panel**                                           | Quick panel files, the `lab-logic` result functions and their tests                                                                                                                                                                         | #4                                                          | Its results must be generalized off the NativeScript dashboard (see below). Kody-native results could be packages, apps, guides, approvals, machine status, and recent package apps.                                                                                                |
| 6   | **Desktop: notifications**                                         | `summaryNotifications`, `approvalNotifications`, `notify`                                                                                                                                                                                   | none (plain Electron `Notification`)                        | The approvals poll is generic Kody. The PR rules (critical, CI failing, awaiting approval) belong to the dashboard; upstream would want a generic way for a package app to raise notifications instead.                                                                             |
| 7   | **Desktop: review panel and SimDeck docking**                      | `openReview`, `openSimDeck`, `dashboard.cjs`                                                                                                                                                                                                | #4, and #2 for the simulator parts                          | This is the most nStudio-specific piece. Upstream it as "a package app can open a docked, non-activating side panel", not as "the NativeScript dashboard panel".                                                                                                                    |
| 8   | **Desktop: side-by-side edition**                                  | `edition.cjs` and the `productName` plumbing                                                                                                                                                                                                | none                                                        | Useful to maintainers for testing a dev build next to the installed app. Keep it opt-in: the published `productName` stays `Kody`, which makes `distinct` false and keeps the app unchanged.                                                                                        |

### Before any PR: generalize or strip

- **`dashboard.cjs` and `lab.cjs` default to
  `nstudio/nativescript-github-dashboard`.** You can override this in
  `userData/lab.json`, but upstream needs a package-app-agnostic contract. For
  example, a package declares a "desktop panel" route in its `kody.app`
  manifest, and the desktop opens it.
- **`Lab` only starts when `edition.distinct`.** Upstream, each feature needs
  its own setting or flag rather than "is this the Lab build".
- **`package.json` sets `productName: "Kody Lab"`,
  `appId codes.kody.desktop.lab`, and the build `productName`.** Revert all
  three. Keep the edition mechanism, which reads them.
- **`docs/nstudio/` is ours.** Never include it in an upstream PR.
- **Rebase onto current `main` first.** Upstream was 13 commits ahead with no
  overlap on 2026-11-11, but check again.
- **Run upstream's full checks, not just the two suites above.** That means the
  desktop smoke tests (`test:smoke`, `test:packaged-cli`, and so on), the CLI
  tests, and lint.

### CLA and commit hygiene

- **Every outside PR needs a signed CLA.** There is no exception for one-line or
  docs-only patches. See
  [inbound contributions](../contributing/inbound-contributions.md).
- **Which CLA?** If nStudio owns the work, an authorized nStudio representative
  signs the **Entity CLA**. Otherwise each author signs the Individual CLA by
  commenting the exact phrase on the PR.
- **Authorship.** Commits on the fork are authored as
  `nwalker <nwalker@nstudio.io>`. Keep that consistent so one signature covers
  every commit.
- **Commit messages.** No session or co-author trailers. Bodies explain why;
  code comments state only constraints.

## What we learned

### Electron and the NativeScript macOS runtime

- **Desktop 0.1.35 can load the runtime with no rebuild.** It is Electron
  45.2.0, plain CommonJS, `asar: false` and `npmRebuild: false`, so Node-API
  modules load without an Electron rebuild. `@nativescript/macos-node-api`
  (about 8 MB, Apple Silicon only) lazy-loads in the main process and turns
  every Objective-C class into a global.
  - Gate it on `darwin` and `arm64`.
  - Treat load failure as "use plain Electron behavior". `native.cjs` does both.
- **Find the NSWindow without native handles.** `getMediaSourceId()` returns
  `window:<CGWindowID>:0`, and that CGWindowID equals `NSWindow.windowNumber`.
  Match it against `NSApplication.sharedApplication.windows`.
- **A non-activating key panel takes two steps.**
  1. Electron `type: 'panel'` already creates an NSPanel (styleMask 143).
  2. Electron's `focus()` always activates the app. Instead:
     - add `NSWindowStyleMask.NonactivatingPanel`,
     - set `hidesOnDeactivate = false` and `becomesKeyOnlyIfNeeded = false`,
     - set `CanJoinAllSpaces | FullScreenAuxiliary`,
     - call `makeKeyAndOrderFront(null)`, then `webContents.focus()`.

  The panel then takes typing while the other app keeps the menu bar. This is
  exactly what electron/electron#52915 asks for.

- **Hiding the panel strands the keyboard.** While the panel is key, our app
  _is_ active, even though it doesn't look it. Ordering the panel out
  deactivates it and activates nothing else, so keystrokes go nowhere until the
  user clicks a window.
  - Fix: record `NSWorkspace.frontmostApplication` before showing the panel.
    Then call `activateWithOptions(0)` on that app _before_ `hide()`.
  - Only do this on deliberate dismissals (Esc, toggling the panel). Closing on
    blur, or after running a result, should be a plain hide.
- **Watch for gaps in the runtime metadata.**
  - `activateFromApplication:options:` (macOS 14+) is missing from the
    NativeScript runtime metadata.
  - Calling it through `performSelector:withObject:withObject:` with a null
    argument segfaults in `ObjCObjectTypeConv::toJS`.
  - Use the older API.
  - Check symbols against the runtime's own metadata, not Apple's headers.
- **`NSApp.active` reads true while a non-activating panel is key.** To learn
  which app the user is actually in, ask `NSWorkspace.frontmostApplication`.
- **The first shortcut press after launch did nothing until the panel was
  pre-created.**
  - Create the panel at startup.
  - Ignore a `blur` within about 400 ms of showing it. The show itself can
    deliver a stray blur.
- **Off macOS, `type: 'panel'` doesn't exist.** Use ordinary always-on-top
  windows.
  - Avoid Alt+Space on Windows, which opens the window menu.
  - `shortcutsFor()` uses Control+Alt+… off macOS.

### Running a second build beside the published app

- **`app.setName()` decides the single-instance lock and the `userData`
  folder.** With a different `productName`, the second build runs beside
  Kody.app instead of handing off to it.
- **Two auto-updaters can replace the side build.**
  - Electron's updater would install the published app over the side build, so
    disable it.
  - The bundled runner's daemon auto-update handed the runner to the published
    CLI (3.34.12), losing our CLI changes. Set `KODY_DAEMON_AUTO_UPDATE=off` in
    the runner env.
- **Make the build visibly different.** A CSS `html::after` badge, injected on
  `dom-ready`, labels every kody.codes page without touching the site's DOM or
  event handling. Window titles get a "— Kody Lab" suffix, and the tray gets a
  text title.
- **In background mode the tray is the only entry point** (no Dock icon or menu
  bar), so anything in the app menu must also be in the tray menu. Users
  couldn't find **Allow simulators** until we added it there.
- **Launching it from scripts:**
  - Use `open -g -a "/Applications/Kody Lab.app"`. Started with `nohup` from a
    shell, it dies when the shell command ends.
  - It ignores an AppleScript `quit`. Quit from the tray or send TERM to the
    pid.
- **Reinstalling after edits.**
  - `asar: false` means you can hot-swap `*.cjs` files into
    `Kody Lab.app/Contents/Resources/app/` for quick iteration, then restart the
    app.
  - A full rebuild is `npm run build --workspace @kodycodes/cli`, then
    `npm run desktop:pack`. Replace the app with `rm -rf` plus `ditto`.

### The `kody.simulator.*` capability

- **It needs no server change.** The CLI's local runtime bridge already
  intercepts `kody.command.*` in the daemon and only asks the server to
  authorize and audit through `kody.command.authorize`. `kody.simulator.*` uses
  the same hop.
- **It requires three switches:**
  - host commands on (local opt-in and server grant),
  - a separate local `simulators` opt-in in the local policy file,
  - the run must be on an execution context.

  Runs in Kody cloud or with `--local` fail with
  `execution_context_simulator_requires_context`.

- **Arguments are validated, and tools run through `execFile` with no shell.**
  - Validated values: UDIDs, adb serials, AVD names, bundle ids and package
    names, URL schemes, and absolute `.app`/`.apk` paths.
  - Blocked URL schemes: `file`, `javascript`, `intent`, `content`, `data`, and
    similar.
  - Output caps: screenshots 8 MB, describe 256 KB, tool output 8 MB.
- **Package code needs object namespaces.** The server's package-bound `kody`
  shim wraps every property except `mcp` and `command` as a single function
  call, so `kody.simulator.list()` lost `.list`.
  - The real fix is one line in the worker shim.
  - The CLI also patches older shims (`passContextNamespaces`) and returns plain
    object proxies for `command` and `simulator` (`__kodyObjectNamespaces`).
- **Android needs AVD names, not adb serials, in a few places.**
  - `boot`, and `stream` with `platform: 'android'`, take an AVD name.
  - SimDeck treats a bare serial as an iOS device, so `describe` maps the serial
    to `android:<avd>`.
  - Android view trees need about depth 16, versus 8 for iOS.
- **We couldn't find the audit entries.** `executionContextAuditList` showed
  only admin events (attach, grants), not the `kody.simulator.*` commands we
  expected. Ask the maintainers where `command.authorize` and `command.finished`
  entries surface before claiming "every call is audited" in a pitch.

### SimDeck

- **SimDeck 0.1.x and 0.2 start differently.**
  - Bare `simdeck <udid>` on 0.1.x runs in the foreground and leaves a listener
    behind, so it is useless from a daemon.
  - Start it with `simdeck service start` (0.2+) or `simdeck daemon start`
    (0.1.x).
  - Check `/api/health` first, on the ports in `~/.simdeck/config.json` and on
    4310, and reuse a healthy service.
- **The viewer takes `?device=<udid>` or `?device=android:<AVD>`.** No URL
  parameter opens the visual inspector; the client only reads `simdeckToken`,
  `device`, `stream` and `remoteStream`.
  - Opening the inspector from the review panel's "Inspect view tree" needs a
    small SimDeck change (for example `?inspector=1`) plus Kody Lab adding it to
    the URL.
  - Today the review panel's capture is text only.
- **Xcode 27 broke two things, both now fixed on SimDeck `main`:**
  - SimulatorKit moved to `Contents/SharedFrameworks` (#87).
  - CoreSimulator 1155.4+ dropped legacy Indigo HID, so input must go to the
    guest's `dtuhidd` over sim-to-host XPC (#91, fixing #90). Facebook's idb
    `FBSimulatorControl/HID` is the reference.
- **CI flakiness.** On Xcode 26.3, the CI iOS integration jobs segfaulted once
  while booting a simulator, and passed on re-run. If it recurs, investigate it.
- **Emulators must be launched with SimDeck's own flags:**
  `-qt-hide-window -gpu host -grpc <port> -ports 5554,5555 -share-vid`. An
  emulator started by hand requires a JWT for gRPC, which SimDeck can't send, so
  the viewer spins forever.
- **The NativeScript inspector (`@nativescript/simdeck-inspector` 0.1.5) is
  effectively iOS-only.** It uses `NSProcessInfo` and `NSURLSession`.
  - It needs a WebSocket global, which `@valor/nativescript-websockets`
    provides.
  - On Android it threw, and left the app on its splash screen until we gated
    the start on `!isAndroid`.
  - From an Android emulator, the host is `10.0.2.2`.
- **Replacing a signed binary in place gets it SIGKILLed** (exit 137). Use `rm`
  then `cp`. `simdeck service stop` sometimes leaves the process running; kill
  it by pid.

### The dashboard package (companion repo)

- **A run cut off by the platform never settles.** `platform_interrupted`
  arrives after 180 s, and any promise shared across requests stays pending
  forever. Two fixes:
  - Give in-flight work a deadline after which a new attempt starts.
  - Bound how long pollers wait, and serve them the stored snapshot past that.

  The quick panel's "Signing in to the dashboard…" hang was this bug, not
  authentication.

- **Publishing can clear the app's runs-as user.** A
  `packagePublishExternalPush` with no known publisher clears it, giving "This
  app has no one to run as". Restore it with `packageAppRunsAsSet`, using the
  Kody username (not the git author name).
- **Two concurrent captures hit a UNIQUE constraint race.** Claim each queued
  capture with a conditional `UPDATE … RETURNING` before taking it.
- **A global `fetch.prune=true` deleted the runner's own PR refs.** Fetch PRs
  into `refs/kody/pr/N` with `--no-prune`.
- **Template literals mangled generated JS.** Generating JS inside a TypeScript
  template literal turned `\n` into real newlines. Build those strings with
  `String.fromCharCode(10)` or a regex instead.
- **The review hook.** The dashboard's `src/review-hook.ts` is written into the
  PR's worktree as `apps/toolbox/src/kody-review.ts` and imported from the
  entry's first line, as an uncommitted local change. It logs lifecycle events
  and starts the SimDeck inspector on iOS; missing packages are installed with
  `--no-save`. This lets any PR be inspected without touching its diff. Worth
  showing maintainers as a pattern for "package code that prepares a local
  workspace".

### Device and automation gotchas (for demos and tests)

- **Android AVD memory.**
  - Set `hw.ramSize = 4096`; `4096M` is silently ignored.
  - Stock 2 GB AVDs swap and stall adb past 30 s timeouts.
  - Or launch with `-memory 4096`.
- **`adb shell input keycombination` preceded system_server ANRs on API 36
  twice.** Avoid it.
- **Typing into Android is unreliable.**
  - Gboard autocorrect mangles `adb input text`.
  - Gboard can switch to the voice IME and swallow input.
  - `%` typed through the SimDeck viewer arrives as `%25`.
- **Back on the root activity no longer finishes it** (Android 12+). Lifecycle
  PRs about "exit then relaunch" need API 29 or 30.
- **Recording the desktop.**
  - Terminal needs Screen Recording permission, or captures show only wallpaper.
  - Synthetic keystrokes need Accessibility permission.
  - cliclick `kp:` didn't register; System Events key codes did.
  - Other launchers (Raycast, Spotlight, Siri) can grab ⌥Space. Check before a
    take.

## What's good to say about the effort

- **It is mostly additive.**
  - The capability needs one line on the server side (the worker shim) and
    nothing else.
  - The desktop changes leave the published app's behavior unchanged unless the
    edition is distinct.
- **It closes a long-standing Electron gap.** electron/electron#52915 asks for
  focus without activation. Using the NativeScript runtime from the main process
  solves it with about 100 lines (`native.cjs`), without a native addon build.
  The same loader could serve other macOS-only touches later.
- **It fits Kody's existing permission model.**
  - Simulators reuse host commands' authorize-and-audit hop, behind an
    additional local opt-in, with the same local-policy file and CLI verbs
    (`kody context simulators on|off|status`).
  - The tools have a fixed action list, validated arguments, no shell, and
    capped outputs.
- **It is tested.** 20 capability tests and 12 lab-logic tests, with the desktop
  suite at 174 passing. The packaged app has run daily on macOS.
- **It improved the wider ecosystem along the way.** It produced SimDeck fixes
  for Xcode 27 (#87 SimulatorKit path, #91 dtuhidd input for #90) and a Rust
  1.99 clippy fix on SimDeck `main`. All are merged, and they unblock SimDeck
  for everyone on Xcode 27.
- **It drove a real workflow end to end.** NativeScript PR triage went from the
  dashboard, to the quick panel, to a notification, to the review panel, to
  running the PR on a reserved device, to a SimDeck stream with a visual
  inspector, to a review. Recorded on video using PRs #11453 (iOS,
  `-ios-corner-shape`) and #11481 (Android, percentage `translate`).

## Open items before any PR

- **Windows and Linux.** The fallbacks exist (ordinary always-on-top windows,
  Control+Alt shortcuts) but are untested. The simulator capability's Android
  half should work there; its iOS half is macOS-only by nature.
- **Audit visibility for `kody.simulator.*`** (see above). Fix the demo script's
  audit-log scene, which wasn't true when recorded.
- **Inspector visibility.** The SimDeck `?inspector=1` option, and Kody Lab
  passing it from "Inspect view tree".
- **`demo-script.md` is stale on these points:**
  - The Kody_Review AVD was replaced by `Pixel_9_API_36_gapis` with
    `-memory 4096` and SimDeck's launch flags.
  - The iOS viewer now takes input.
  - Scenes 3 (notifications) and 7 (close) were not recorded.
- **`lab.cjs` has no direct tests.** Its pure logic lives in `lab-logic.cjs`
  (tested), but window and focus behavior was verified only by hand.
- **Out of scope until the maintainers respond:** signing and notarization,
  auto-update for a side build, and server-side grants specific to simulators.

## Handy commands

```sh
# Rebuild the CLI and package Kody Lab
npm run build --workspace @kodycodes/cli
npm run desktop:pack
rm -rf "/Applications/Kody Lab.app"
ditto "artifacts/desktop/mac-arm64/Kody Lab.app" "/Applications/Kody Lab.app"
open -g -a "/Applications/Kody Lab.app"

# Tests
(cd packages/desktop && npm test)
(cd packages/cli && npx tsx --test --test-force-exit test/host-simulators.test.ts)

# Simulator opt-in and runner state
node packages/cli/dist/bin.js context simulators status --json
node packages/cli/dist/bin.js daemon status --context <ec_id> --json   # the Lab runner's context

# Android emulator SimDeck can stream
~/Library/Android/sdk/emulator/emulator -avd Pixel_9_API_36_gapis -qt-hide-window \
  -gpu host -grpc 8554 -memory 4096 -no-boot-anim -ports 5554,5555 -share-vid
```
