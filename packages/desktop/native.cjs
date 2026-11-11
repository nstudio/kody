// AppKit access through the NativeScript macOS runtime (@nativescript/macos-node-api), which turns every Objective-C
// class into a main-process global. Everything here is optional: off Apple Silicon macOS, or if the runtime fails to
// load, callers get plain Electron behavior.

let loading = null

function supported() {
	return process.platform === 'darwin' && process.arch === 'arm64'
}

/** Resolves true once AppKit globals such as NSApplication exist. Safe to call repeatedly. */
function loadNative() {
	if (!supported()) return Promise.resolve(false)
	loading ??= import('@nativescript/macos-node-api').then(
		() => typeof globalThis.NSApplication === 'function',
		(error) => {
			console.warn(`NativeScript runtime unavailable: ${error.message}`)
			return false
		},
	)
	return loading
}

function ready() {
	return supported() && typeof globalThis.NSApplication === 'function'
}

// getMediaSourceId() is "window:<CGWindowID>:0", and the CGWindowID is the NSWindow's windowNumber, so the window can
// be found without reading the raw native handle.
function nsWindowFor(browserWindow) {
	if (!ready() || browserWindow.isDestroyed()) return null
	const id = Number(browserWindow.getMediaSourceId().split(':')[1])
	const windows = NSApplication.sharedApplication.windows
	for (let i = 0; i < windows.count; i++) {
		const window = windows.objectAtIndex(i)
		if (window.windowNumber === id) return window
	}
	return null
}

/**
 * Show a `type: 'panel'` BrowserWindow as the key window without activating the app, so the frontmost app keeps the
 * menu bar while the panel takes typing. Electron's own focus() always activates the app.
 */
function showWithoutActivating(browserWindow) {
	const window = nsWindowFor(browserWindow)
	if (!window) {
		browserWindow.show()
		browserWindow.focus()
		return false
	}
	window.styleMask = window.styleMask | NSWindowStyleMask.NonactivatingPanel
	window.collectionBehavior =
		NSWindowCollectionBehavior.CanJoinAllSpaces |
		NSWindowCollectionBehavior.FullScreenAuxiliary
	window.hidesOnDeactivate = false
	window.becomesKeyOnlyIfNeeded = false
	window.makeKeyAndOrderFront(null)
	browserWindow.webContents.focus()
	return true
}

/**
 * Hide a panel shown with showWithoutActivating and give the keyboard back to `app`, a frontmostApp() result taken
 * before it was shown. While the panel is key this app is active; ordering the panel out deactivates it without
 * activating anything else, so keystrokes go nowhere. Activation has to be handed over before the panel hides.
 */
function hideReturningFocus(browserWindow, app) {
	const target =
		ready() && app
			? NSRunningApplication.runningApplicationWithProcessIdentifier(app.pid)
			: null
	if (target && !target.terminated) target.activateWithOptions(0)
	browserWindow.hide()
}

/** The app the user is actually in. While a non-activating panel is key, NSApp.active reads true, so ask NSWorkspace. */
function frontmostApp() {
	if (!ready()) return null
	const app = NSWorkspace.sharedWorkspace.frontmostApplication
	return app
		? {
				name: app.localizedName,
				pid: app.processIdentifier,
				bundleId: app.bundleIdentifier,
			}
		: null
}

/** Visible frame (minus menu bar and Dock) of the screen under the mouse, in Electron's top-left coordinates. */
function screenUnderMouse(screen) {
	return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
}

module.exports = {
	loadNative,
	showWithoutActivating,
	hideReturningFocus,
	frontmostApp,
	screenUnderMouse,
}
