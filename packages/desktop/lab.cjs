const {
	BrowserWindow,
	dialog,
	globalShortcut,
	ipcMain,
	Notification,
	screen,
} = require('electron')
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')
const native = require('./native.cjs')
const { Dashboard, partition } = require('./dashboard.cjs')
const {
	approvalNotifications,
	quickResults,
	resultAction,
	shortcutsFor,
	summaryNotifications,
} = require('./lab-logic.cjs')

const POLL_MS = 3 * 60 * 1000
const APPROVALS_POLL_MS = 5 * 60 * 1000
const QUICK_SIZE = { width: 680, height: 440 }
const isMac = process.platform === 'darwin'
// `type: 'panel'` is macOS-only; elsewhere these are ordinary always-on-top windows.
const panelType = isMac ? { type: 'panel' } : {}

const safeWebPreferences = {
	sandbox: true,
	contextIsolation: true,
	nodeIntegration: false,
}

/**
 * Desktop surfaces for the lab edition: the quick panel, a non-activating review panel beside the simulator, a
 * dashboard window, and notifications driven by the NativeScript PR dashboard and Kody's pending approvals.
 */
class Lab {
	constructor({ app, runner, showApp, onChange }) {
		Object.assign(this, { app, runner, showApp, onChange })
		this.dashboard = new Dashboard({ app })
		this.shortcuts = shortcutsFor(process.platform)
		this.summary = null
		this.summaryAt = 0
		this.summaryError = null
		this.approvals = null
		this.simulators = null
		this.lastReview = null
		this.quick = null
		this.review = null
		this.dashboardWindow = null
		this.nativeReady = false
		this.settingsPath = join(app.getPath('userData'), 'lab-settings.json')
		this.settings = { notifications: true }
		try {
			Object.assign(
				this.settings,
				JSON.parse(readFileSync(this.settingsPath, 'utf8')),
			)
		} catch {}
	}

	async start() {
		if (process.platform === 'win32')
			this.app.setAppUserModelId('codes.kody.desktop.lab')
		this.nativeReady = await native.loadNative()
		ipcMain.handle('lab:quick', (event, command, input) => {
			if (!this.quick || event.sender !== this.quick.webContents)
				throw new Error('Only the quick panel can call this.')
			if (command === 'query') return this.results(input)
			if (command === 'run') return this.runResult(input)
			if (command === 'hide') return this.hideQuick()
			throw new Error('Unknown quick panel command.')
		})
		globalShortcut.register(this.shortcuts.quick, () => void this.toggleQuick())
		globalShortcut.register(
			this.shortcuts.review,
			() => void this.toggleReview(),
		)
		this.app.on('will-quit', () => globalShortcut.unregisterAll())
		void this.poll(true)
		void this.pollApprovals(true)
		setInterval(() => void this.poll(false), POLL_MS).unref()
		setInterval(() => void this.pollApprovals(false), APPROVALS_POLL_MS).unref()
		void this.readSimulators()
		this.quick = this.createQuick()
	}

	saveSettings() {
		mkdirSync(this.app.getPath('userData'), { recursive: true })
		writeFileSync(this.settingsPath, JSON.stringify(this.settings), {
			mode: 0o600,
		})
	}

	menu() {
		return {
			label: 'Lab',
			submenu: [
				{
					label: 'Quick panel',
					accelerator: this.shortcuts.quick,
					click: () => void this.toggleQuick(),
				},
				{
					label: this.lastReview
						? `Review panel (#${this.lastReview})`
						: 'Review panel',
					accelerator: this.shortcuts.review,
					click: () => void this.toggleReview(),
				},
				{
					label: 'NativeScript PRs',
					accelerator: 'CmdOrCtrl+Shift+P',
					click: () => void this.openDashboard('/'),
				},
				{ type: 'separator' },
				{ label: 'Sync PRs now', click: () => void this.poll(false, true) },
				{
					label: 'Notifications',
					type: 'checkbox',
					checked: this.settings.notifications,
					click: (item) => {
						this.settings.notifications = item.checked
						this.saveSettings()
					},
				},
				{ type: 'separator' },
				{
					label: 'Allow simulators',
					type: 'checkbox',
					enabled: this.simulators !== null,
					checked: this.simulators?.enabled === true,
					click: (item) => void this.setSimulators(item.checked),
				},
				...(this.simulators?.enabled && !this.simulators.commands
					? [{ label: 'Simulators also need Allow commands', enabled: false }]
					: []),
				{ type: 'separator' },
				{
					label: this.nativeReady
						? 'Native panels: on (NativeScript)'
						: 'Native panels: standard windows on this platform',
					enabled: false,
				},
			],
		}
	}

	// ---- Data -----------------------------------------------------------------------------------------------------

	async poll(initial, force = false) {
		try {
			if (force)
				await this.dashboard.json('/api/refresh', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: '{}',
				})
			const summary = await this.dashboard.json('/api/summary?sync=1')
			const previous = this.summary
			this.summary = summary
			this.summaryAt = Date.now()
			this.summaryError = null
			if (!initial && this.settings.notifications)
				for (const note of summaryNotifications(previous, summary))
					this.notify(note)
			this.onChange?.()
		} catch (error) {
			this.summaryError = error.message
		}
	}

	async freshSummary() {
		if (!this.summary || Date.now() - this.summaryAt > 60_000)
			await this.poll(!this.summary)
		return this.summary
	}

	/** Pending Kody approvals in the dashboard's org and the account's active org, through the bundled CLI login. */
	async pollApprovals(initial) {
		const orgs = [...new Set([this.dashboard.config.org, null])]
		const items = []
		for (const org of orgs) {
			try {
				const raw = await this.runner.command([
					'api',
					'approvalPendingList',
					...(org ? ['--org', org] : []),
					'--params',
					'{}',
					'--json',
				])
				const body = JSON.parse(raw.slice(raw.indexOf('{')))
				for (const item of body.result?.items ?? body.items ?? []) {
					const key = item.key ?? item.id ?? JSON.stringify(item).slice(0, 120)
					const title =
						item.summary ??
						item.title ??
						item.description ??
						item.message ??
						`${item.type ?? 'Approval'}${item.package ? ` for ${item.package.name ?? item.package}` : ''}`
					if (!items.some((i) => i.key === key))
						items.push({ key, title: String(title).slice(0, 160) })
				}
			} catch {}
		}
		const previous = this.approvals
		this.approvals = items
		if (!initial && this.settings.notifications)
			for (const note of approvalNotifications(previous, items))
				this.notify(note)
	}

	notify({ title, body, number, kody }) {
		if (!Notification.isSupported()) return
		const notification = new Notification({ title, body, silent: false })
		notification.on('click', () => {
			if (number) void this.openReview(number)
			else if (kody) void this.showApp('/account')
			else void this.openDashboard('/')
		})
		notification.show()
	}

	// ---- Simulators -----------------------------------------------------------------------------------------------

	async readSimulators() {
		try {
			const status = JSON.parse(
				await this.runner.command([
					'context',
					'simulators',
					'status',
					'--json',
				]),
			)
			this.simulators = {
				enabled: status.local?.enabled === true,
				commands: status.commands?.local?.enabled === true,
			}
		} catch {
			this.simulators = null
		}
		this.onChange?.()
	}

	async setSimulators(enabled) {
		if (enabled) {
			const { response } = await dialog.showMessageBox({
				type: 'warning',
				message: 'Allow Kody runs to control simulators on this machine?',
				detail:
					'Your runs on this machine (with host commands allowed) can list, boot, shut down, install apps on, launch, screenshot, and inspect iOS simulators and Android emulators through kody.simulator.*. Each action is recorded in the context audit log. Turn it off here or with `kody context simulators off`.',
				buttons: ['Allow simulators', 'Cancel'],
				defaultId: 1,
				cancelId: 1,
			})
			if (response !== 0) return this.onChange?.()
		}
		try {
			await this.runner.command([
				'context',
				'simulators',
				enabled ? 'on' : 'off',
				'--json',
			])
		} catch (error) {
			dialog.showErrorBox('Could not change simulator access', error.message)
		}
		await this.readSimulators()
	}

	// ---- Quick panel ----------------------------------------------------------------------------------------------

	async results(text) {
		const summary = await this.freshSummary().catch(() => null)
		const frontmost = native.frontmostApp()
		const synced = summary?.fetchedAt
			? new Date(summary.fetchedAt).toLocaleTimeString([], {
					hour: 'numeric',
					minute: '2-digit',
				})
			: 'never'
		return {
			items: quickResults(summary, text, this.approvals ?? []),
			status: summary
				? `${summary.prs.length} open PRs · synced ${synced}`
				: this.summaryError || 'Loading PRs…',
			frontmost:
				frontmost && frontmost.pid !== process.pid ? frontmost.name : null,
		}
	}

	async runResult(id) {
		const action = resultAction(id)
		this.hideQuick()
		if (!action) return
		if (action.type === 'review') return void this.openReview(action.number)
		if (action.type === 'dashboard') return void this.openDashboard(action.path)
		if (action.type === 'sync') return void this.poll(false, true)
		if (action.type === 'kody') return void this.showApp(action.path)
	}

	createQuick() {
		const window = new BrowserWindow({
			...panelType,
			...QUICK_SIZE,
			show: false,
			frame: false,
			transparent: true,
			resizable: false,
			alwaysOnTop: true,
			skipTaskbar: true,
			hasShadow: true,
			webPreferences: {
				...safeWebPreferences,
				preload: join(__dirname, 'quick-panel-preload.cjs'),
			},
		})
		window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
		// Becoming key without activating can report a transient blur while the panel orders front.
		window.on('blur', () => {
			if (Date.now() - (this.quickShownAt ?? 0) > 400) this.hideQuick()
		})
		window.webContents.on('will-navigate', (event) => event.preventDefault())
		window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
		void window.loadFile(join(__dirname, 'quick-panel.html'))
		return window
	}

	async toggleQuick() {
		if (this.quick?.isVisible()) return this.hideQuick()
		this.quick ??= this.createQuick()
		const area = native.screenUnderMouse(screen)
		this.quick.setBounds({
			x: Math.round(area.x + (area.width - QUICK_SIZE.width) / 2),
			y: Math.round(area.y + area.height * 0.18),
			...QUICK_SIZE,
		})
		if (this.quick.webContents.isLoading())
			await new Promise((resolve) =>
				this.quick.webContents.once('did-finish-load', resolve),
			)
		this.quickShownAt = Date.now()
		native.showWithoutActivating(this.quick)
		this.quick.webContents.send('lab:quick-show', {})
	}

	hideQuick() {
		if (this.quick?.isVisible()) this.quick.hide()
	}

	// ---- Review panel and dashboard window ------------------------------------------------------------------------

	async openReview(number) {
		if (!Number.isSafeInteger(number) || number < 1) return
		this.lastReview = number
		this.onChange?.()
		if (!this.review || this.review.isDestroyed()) {
			const area = native.screenUnderMouse(screen)
			const width = 440
			this.review = new BrowserWindow({
				...panelType,
				x: area.x + area.width - width - 12,
				y: area.y + 12,
				width,
				height: area.height - 24,
				minWidth: 360,
				show: false,
				alwaysOnTop: true,
				backgroundColor: '#0d1117',
				webPreferences: { ...safeWebPreferences, partition },
			})
			this.review.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
			this.review.on('page-title-updated', (event) => {
				event.preventDefault()
				this.review.setTitle(`Review #${this.lastReview} — Kody Lab`)
			})
		}
		this.review.setTitle(`Review #${number} — Kody Lab`)
		await this.dashboard.load(
			this.review,
			`/?view=review&pr=${number}&embed=panel`,
		)
		native.showWithoutActivating(this.review)
	}

	async toggleReview() {
		if (this.review && !this.review.isDestroyed()) {
			if (this.review.isVisible() && this.review.isFocused())
				return this.review.hide()
			return native.showWithoutActivating(this.review)
		}
		if (this.lastReview) return this.openReview(this.lastReview)
		return this.toggleQuick()
	}

	async openDashboard(path) {
		if (!this.dashboardWindow || this.dashboardWindow.isDestroyed()) {
			this.dashboardWindow = new BrowserWindow({
				width: 1320,
				height: 900,
				title: 'NativeScript PRs — Kody Lab',
				backgroundColor: '#0d1117',
				webPreferences: { ...safeWebPreferences, partition },
			})
			this.dashboardWindow.on('page-title-updated', (event, title) => {
				event.preventDefault()
				this.dashboardWindow.setTitle(`${title} — Kody Lab`)
			})
		}
		await this.dashboard.load(this.dashboardWindow, path)
		this.dashboardWindow.show()
		this.dashboardWindow.focus()
	}
}

module.exports = { Lab }
