# Kody Lab demo script (macOS)

Audience: the Kody maintainers. Goal: show four desktop features working on a
real workload (reviewing NativeScript pull requests) and make it obvious why
each one belongs in Kody desktop. Target length 6–7 minutes; builds are cut or
sped up in editing.

The features:

1. **Quick panel** (⌥Space): a keyboard-focusable panel over any app that never
   steals focus from it.
2. **Native notifications** from a package app's own data, clicking through to
   the right place.
3. **`kody.simulator.*`**: iOS simulators and Android emulators as a
   permissioned execution-context capability, next to host commands.
4. **Review panel**: a non-activating panel docked beside the simulator, so you
   use the app under review and write the review at the same time.

The workload is `@nstudio/nativescript-github-dashboard`, a Kody package app
that triages the ~100 open NativeScript PRs. Two PRs carry the hands-on part:

| PR                                                                                                | Why it's in the video                                                                                                                         | Platform |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| [#11453](https://github.com/NativeScript/NativeScript/pull/11453) `-ios-corner-shape: continuous` | Its own description says the manual test "needs a device/simulator". Visual, and iOS-only.                                                    | iOS      |
| [#11481](https://github.com/NativeScript/NativeScript/pull/11481) percentage `translate()`        | CI has **never run** on it (it conflicts with main), so a local run is the only verification a maintainer can get. Visual and cross-platform. | Android  |

## Pre-flight (the day of recording)

Do these in order; each takes a minute except the warm builds.

- [ ] Kody Lab running (tray shows **Kody Lab**). The published Kody app can
      stay installed; quit it so there is one tray icon.
- [ ] Tray › **Allow commands** and **Allow simulators** both on.
- [ ] SimDeck 0.2.0 with NativeScript/SimDeck#87 (Xcode 27 moved SimulatorKit;
      without #87 the viewer shows "Unable to load SimulatorKit"). Until #87
      ships, both global installs carry a local build of `simdeck-v0.2.0` + #87
      from `~/Documents/github/DjDeveloperr/SimDeck` (branch
      `local/v0.2.0-xcode27`; the originals are kept as `*.orig` next to them).
      `curl -s 127.0.0.1:4310/api/health` returns `"ok":true`.
- [ ] Xcode 27 input needs NativeScript/SimDeck#91 (taps, Home and keys go
      through `dtuhidd`). The local build on branch `local/v0.2.0-xcode27`
      carries #87 and #91, so the viewer takes input as well as streaming.
- [ ] The **Kody Review** iOS simulator exists
      (`xcrun simctl list | grep "Kody     Review"`). The runner always uses it,
      so your other simulators are never touched. Boot it before recording.
- [ ] The **Kody_Review** Android AVD (Pixel 9, API 36, 4 GB RAM) exists. The
      runner prefers it and boots it if needed. Stock 2 GB AVDs swap so hard
      that adb input and screenshots stall; set `hw.ramSize = 4096` in its
      `config.ini` (a value like `4096M` is silently ignored). Boot it before
      recording.
- [ ] **Warm builds**: run each PR once before recording (Run on iOS for #11453,
      Run on Android for #11481) and stop them. The second run reuses the
      worktree and `node_modules` and launches in about a minute instead of five
      or more.
- [ ] Dashboard synced: Lab › **Sync PRs now**.
- [ ] Notifications allowed for Kody Lab (System Settings › Notifications), and
      Focus / Do Not Disturb off.
- [ ] Desktop: VS Code (or any editor) open and frontmost, nothing personal on
      screen, Dock autohide on. Record at 1920×1080 or a 16:10 equivalent.
- [ ] Have [#11453](https://github.com/NativeScript/NativeScript/pull/11453) and
      [#11481](https://github.com/NativeScript/NativeScript/pull/11481) open in
      a browser tab for the cutaways.

Public actions: **Approve workflows** starts CI on someone's fork and **Comment
/ Approve / Request changes** posts to GitHub as you. Only click them on camera
if you mean them; otherwise hover and describe.

## Scenes

Narration is in quotes. On-screen actions are numbered. Keep the cursor slow and
pause half a second after each result appears.

### 0. Cold open (10 s)

The final layout, before any explanation: the editor in the background, the
simulator running NativeScript's toolbox app on the left, the review panel on
the right, notes being typed while the simulator stays frontmost.

> "This is Kody Lab: a local build of Kody desktop with four additions. I'll
> show each one on something I do every week: reviewing NativeScript pull
> requests."

### 1. The workload: a Kody package app (45 s)

1. Tray › **NativeScript PRs**. The dashboard opens.
2. CI filter › **Tests not run**: about 45 open PRs have never had CI run.
3. CI filter › **Awaiting approval**: fork PRs whose workflows GitHub is
   holding. Show the selection checkbox and **Approve workflows to run** bar,
   then deselect.
4. Package chips: **core**, then **vite**. Sort › **Most dangerous first**; open
   one card's blast-radius breakdown (files, lines, areas, platform code).
5. Toggle **Critical**: bundler, manifest, and CI-workflow changes are flagged
   automatically.

> "This is an ordinary Kody package app: GitHub through a Kody credential,
> package storage for the snapshot, and a job for the heavy lifting. Everything
> that follows is the desktop app working with it."

### 2. Quick panel (45 s)

1. Click into VS Code and type a line, so it's clearly focused.
2. ⌥Space. The panel appears over the editor. Point at the status line: _typing
   over Code_. The menu bar still says Code.
3. With the field empty, the top rows are views: _Workflows awaiting approval_,
   _Tests not run_, _Critical PRs_, _Most dangerous first_. Type `core`, then
   `11453`. Results filter as you type.
4. Esc. The caret is back in VS Code exactly where it was.

> "Electron can't do this. A focusable window activates its app, which pulls the
> editor out of focus; that's electron/electron#52915. Kody Lab doesn't patch
> Electron. It runs the NativeScript macOS runtime inside Electron's main
> process, so it can make the window a key, non-activating NSPanel directly from
> JavaScript. It's about twenty lines."

### 3. Notifications (25 s)

1. Show a notification arriving: "#N needs workflow approval", "Critical PR #N",
   "CI failing on #N", or "Building #11453 for ios" from the run below. (If none
   arrives naturally, use the notification from scene 4's run.)
2. Click it. The review panel opens on that PR.

> "Kody Lab polls the app's summary endpoint and only notifies on changes: newly
> held workflows, newly critical PRs, CI turning red, builds starting or
> failing. Clicking goes straight to the review."

### 4. Review #11453 on iOS (2 min 30 s)

1. In VS Code, ⌥Space, type `11453`, then ⌘↩. The review panel docks on the
   right; VS Code stays active.
2. Point out the checklist. It is generated from what the PR touches: _Run on
   iOS_, _Check layout and styling_, _Update types_, _Tests cover the change_.
3. Click **Run on iOS**. (Cut.)

   > "That click queued a Kody job routed to this Mac. It fetches the PR head,
   > makes a worktree, installs, and launches the toolbox app on the Kody Review
   > simulator through `kody.simulator`. Before launch it adds two things to the
   > app, locally and never committed: a lifecycle logger and the SimDeck
   > NativeScript inspector, installing the packages if the PR doesn't have
   > them."

4. The log streams in the panel. Point at `==> Review hooks in apps/toolbox`,
   then `[kody-review] launch`.
5. Click **Simulator view**. SimDeck opens docked to the left of the panel,
   already on Kody Review (the runner pins the viewer with `?device=`). On Xcode
   27 the iOS viewer is watch-only for now, so do steps 6–9 in Simulator.app and
   keep the viewer for the wide shot.
6. In the simulator: **CSS Playground**. Replace the CSS with:

   ```css
   width: 220;
   height: 220;
   font-size: 20;
   color: white;
   padding: 16;
   background: #65adf1;
   border-radius: 70;
   -ios-corner-shape: continuous;
   ```

   Tap **Apply**. Then change the last line to `corner-shape: round;` and Apply
   again, back and forth twice. The corners visibly change from Apple's
   continuous curve to circular arcs.

   > "That's exactly the manual test the PR author asked for, and it took one
   > click to get here."

7. **Screenshot**, then **Add to notes**.
8. **Inspect view tree**. It comes from the NativeScript inspector that was
   injected, so it shows NativeScript views (Page, GridLayout, Label `#play`)
   rather than raw UIKit.
9. Click into the simulator, then type in the review notes: _"Verified on iOS
   27: continuous vs round switch at runtime, screenshot attached."_ The
   simulator keeps focus while you type. Press ⌘1 and ⌘2 to tick items.

   > "The panel takes keystrokes without activating. I can use the app and write
   > the review at the same time, without the windows fighting."

10. Hover **Comment**: posts the review, checklist, and captures to GitHub,
    pinned to the commit tested. (Click only if you mean it.)

### 5. Review #11481 on Android (1 min 15 s)

1. ⌥Space, `11481`, ⌘↩. The panel switches PRs. Point at the CI badge: _not
   run_.

   > "GitHub never ran CI on this one: it conflicts with main, so no workflow
   > could start. Without a local run, nobody has verified it on a device."

2. **Run on Android**. (Cut to `[kody-review] launch`.)
3. On the emulator: **CSS Playground**. Tap **Apply** once with the default CSS:
   a 200-wide blue label, centered.
4. Add one line at the end of the CSS and tap **Apply**:

   ```css
   transform: translateX(-50%);
   ```

   The label slides left by exactly half its own width, so its right edge lands
   on the screen's center line. (Rehearsal on a Pixel 9: x 277–802 px before,
   15–540 px after, on a 1080 px screen. Per the PR, main drops the `%` and
   moves it 50 dp, well short of the center.)

5. **Inspect view tree** (Android uses accessibility through uiautomator) and
   point at `TextView: I'm a test label. @15,734 525x146`: 15 + 525 = 540, the
   center. Then **Screenshot**, and add both to notes.
6. Type a note and tick _Run on Android_.

> "Same flow, other platform, same runner. Approving workflows covers PRs that
> CI can run. This covers the ones it can't."

### 6. Simulators are a permission, not a shell (45 s)

1. Tray menu: **Allow commands** and **Allow simulators** are separate switches.
   Turn Allow simulators off, show the confirm dialog, turn it back on.
2. Open the machine's audit log: kody.codes › Account › Execution contexts ›
   this Mac, scroll to **Audit log**. The run's `kody.simulator.list`, then
   `kody.simulator.boot ios <Kody Review UDID>`, then the build command, then
   `screenshot` / `describe` / `stream` are each a line next to host commands.

> "Packages and agents get typed actions instead of shell strings: list, boot,
> install, launch, screenshot, describe, stream. Each one is authorized and
> audited per machine, and nothing changes on the server except one line that
> lets the namespace through."

### 7. Close (20 s)

Return to the cold-open layout.

> "Four pieces: a quick panel that doesn't steal focus, notifications from a
> package's own data, simulators as a capability, and a review panel that lives
> beside the simulator. It runs today on macOS on Apple Silicon. Windows and
> Linux get the same features with ordinary windows; the native panel is the
> macOS extra. If you'd like any of it in Kody, I'll open the PRs."

## Recovery

- **Quick panel shows "Loading pull requests…"**: it's signing in to the
  dashboard in the background; it fills within a few seconds.
- **"No iOS simulator is running"** on Screenshot or Inspect: boot Kody Review.
- **Simulator view opens SimDeck on another device**: pick Kody Review from
  SimDeck's device menu.
- **Run fails with "PR head moved"**: the author pushed. Lab › Sync PRs now,
  then Run again.
- **Build stuck at npm install**: first runs take minutes; that's what the warm
  builds are for.
- **"This app has no one to run as"** on Run: a publish recorded no publisher.
  `kody api packageAppRunsAsSet --org nstudio --params '{"package_id":"7106ea16-89a9-4107-9a11-d7733450a0ab","username":"nwalker"}'`.
