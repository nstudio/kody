const {
	BrowserWindow,
	globalShortcut,
	ipcMain,
	Notification,
	screen,
} = require('electron')
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')
const native = require('./native.cjs')
const { Dashboard, partition } = require('./dashboard.cjs')

const QUICK_SHORTCUT = 'Alt+Space'
const REVIEW_SHORTCUT = 'Alt+Shift+R'
const POLL_MS = 3 * 60 * 1000

const CI_TAGS = {
	'awaiting-approval': { text: 'Awaiting approval', tone: 'amber' },
	'not-run': { text: 'Tests not run' },
	running: { text: 'Running' },
	failing: { text: 'Failing', tone: 'red' },
	passing: { text: 'Passing', tone: 'green' },
}

/**
 * Desktop surfaces for the lab edition: the ⌥Space quick panel, a non-activating review panel beside the simulator,
 * a dashboard window, and notifications driven by the NativeScript PR dashboard's summary endpoint.
 */
class Lab {
	constructor({ app, showApp, onChange }) {
		Object.assign(this, { app, showApp, onChange })
		this.dashboard = new Dashboard({ app })
		this.summary = null
		this.summaryAt = 0
		this.lastReview = null
		this.quick = null
		this.review = null
		this.dashboardWindow = null
		this.settingsPath = join(app.getPath('userData'), 'lab-settings.json')
		this.settings = { notifications: true }
		try {
			Object.assign(
				this.settings,
				JSON.parse(readFileSync(this.settingsPath, 'utf8')),
			)
		} catch {}
		this.nativeReady = false
	}

	async start() {
		this.nativeReady = await native.loadNative()
		ipcMain.handle('lab:quick', (event, command, input) => {
			if (!this.quick || event.sender !== this.quick.webContents)
				throw new Error('Only the quick panel can call this.')
			if (command === 'query') return this.results(input)
			if (command === 'run') return this.runResult(input)
			if (command === 'hide') return this.hideQuick()
			throw new Error('Unknown quick panel command.')
		})
		globalShortcut.register(QUICK_SHORTCUT, () => void this.toggleQuick())
		globalShortcut.register(REVIEW_SHORTCUT, () => void this.toggleReview())
		this.app.on('will-quit', () => globalShortcut.unregisterAll())
		this.poll(true)
		this.timer = setInterval(() => this.poll(false), POLL_MS)
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
					accelerator: QUICK_SHORTCUT,
					click: () => void this.toggleQuick(),
				},
				{
					label: this.lastReview
						? `Review panel (#${this.lastReview})`
						: 'Review panel',
					accelerator: REVIEW_SHORTCUT,
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
					label: 'PR notifications',
					type: 'checkbox',
					checked: this.settings.notifications,
					click: (item) => {
						this.settings.notifications = item.checked
						this.saveSettings()
					},
				},
				{ type: 'separator' },
				{
					label: this.nativeReady
						? 'Native panels: on (NativeScript)'
						: 'Native panels: unavailable on this Mac',
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
			if (!initial && previous && this.settings.notifications)
				this.notifyChanges(previous, summary)
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

	notifyChanges(before, after) {
		const old = new Map(before.prs.map((p) => [p.number, p]))
		const notes = []
		for (const pr of after.prs) {
			const was = old.get(pr.number)
			if (pr.ci === 'awaiting-approval' && was?.ci !== 'awaiting-approval')
				notes.push({
					title: `#${pr.number} needs workflow approval`,
					body: `${pr.title} — ${pr.approvableRuns} run(s) held for ${pr.author}`,
					number: pr.number,
				})
			else if (pr.critical && !was?.critical)
				notes.push({
					title: `Critical PR #${pr.number}`,
					body: `${pr.title}${pr.criticalReason ? ` — ${pr.criticalReason}` : ''}`,
					number: pr.number,
				})
			else if (pr.ci === 'failing' && was && was.ci !== 'failing')
				notes.push({
					title: `CI failing on #${pr.number}`,
					body: pr.title,
					number: pr.number,
				})
		}
		const oldSessions = new Map(before.sessions.map((s) => [s.id, s]))
		for (const session of after.sessions) {
			const was = oldSessions.get(session.id)
			if (was?.state === session.state) continue
			if (session.state === 'running' && was)
				notes.push({
					title: `Building #${session.number} for ${session.platform}`,
					body: 'apps/toolbox is installing and launching on this Mac.',
					number: session.number,
				})
			if (session.state === 'failed')
				notes.push({
					title: `Toolbox run for #${session.number} failed`,
					body:
						session.error ||
						session.logTail ||
						'See the review panel for the log.',
					number: session.number,
				})
			if (session.state === 'exited')
				notes.push({
					title: `Toolbox run for #${session.number} finished`,
					body: `Exit code ${session.exitCode ?? 0}`,
					number: session.number,
				})
		}
		for (const note of notes.slice(0, 5)) this.notify(note)
		if (notes.length > 5)
			this.notify({
				title: `${notes.length - 5} more PR updates`,
				body: 'Open NativeScript PRs to see them.',
			})
	}

	notify({ title, body, number }) {
		if (!Notification.isSupported()) return
		const notification = new Notification({ title, body, silent: false })
		notification.on('click', () =>
			number ? void this.openReview(number) : void this.openDashboard('/'),
		)
		notification.show()
	}

	// ---- Quick panel ----------------------------------------------------------------------------------------------

	async results(text) {
		const summary = await this.freshSummary().catch(() => null)
		const query = text.trim().toLowerCase()
		const frontmost = native.frontmostApp()
		const status = summary
			? `${summary.prs.length} open PRs · synced ${summary.fetchedAt ? new Date(summary.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'never'}`
			: this.summaryError || 'Loading PRs…'
		const prs = summary?.prs ?? []
		const items = []
		const prItem = (pr) => ({
			id: `pr:${pr.number}`,
			reviewId: `review:${pr.number}`,
			icon: pr.critical ? '◆' : '⇄',
			title: `#${pr.number} ${pr.title}`,
			subtitle: `${pr.author} · ${pr.areas.slice(0, 3).join(', ')} · risk ${pr.risk.score} (${pr.risk.level})`,
			tags: [
				CI_TAGS[pr.ci],
				...(pr.critical ? [{ text: 'Critical', tone: 'purple' }] : []),
			].filter(Boolean),
		})
		const number = Number(query.replace(/^#/, ''))
		if (Number.isSafeInteger(number) && number > 0) {
			const pr = prs.find((p) => p.number === number)
			items.push({
				id: `review:${number}`,
				icon: '✎',
				title: `Review #${number}${pr ? ` — ${pr.title}` : ''}`,
				subtitle: 'Open the review panel beside the simulator',
			})
			items.push({
				id: `pr:${number}`,
				icon: '↗',
				title: `Open #${number} in NativeScript PRs`,
			})
		}
		const awaiting = prs.filter((p) => p.ci === 'awaiting-approval')
		const untested = prs.filter(
			(p) => p.ci === 'awaiting-approval' || p.ci === 'not-run',
		)
		const critical = prs.filter((p) => p.critical)
		const commands = [
			{
				id: 'view:awaiting',
				icon: '⏸',
				title: `Workflows awaiting approval (${awaiting.length})`,
				subtitle:
					awaiting
						.slice(0, 3)
						.map((p) => `#${p.number}`)
						.join(' ') || 'None right now',
				keywords: 'approve workflows held ci fork',
			},
			{
				id: 'view:untested',
				icon: '◌',
				title: `Tests not run (${untested.length})`,
				keywords: 'untested ci not run',
			},
			{
				id: 'view:critical',
				icon: '◆',
				title: `Critical PRs (${critical.length})`,
				keywords: 'critical dangerous',
			},
			{
				id: 'view:risk',
				icon: '▲',
				title: 'Most dangerous first',
				keywords: 'risk blast radius severe high',
			},
			{
				id: 'view:all',
				icon: '☰',
				title: 'All NativeScript PRs',
				keywords: 'dashboard list open',
			},
			{
				id: 'sync',
				icon: '↻',
				title: 'Sync PRs from GitHub',
				keywords: 'refresh sync update',
			},
			{
				id: 'kody',
				icon: 'K',
				title: 'Open Kody',
				keywords: 'kody home account',
			},
		]
		if (!query) {
			items.push(...commands.slice(0, 4))
			items.push(...awaiting.slice(0, 3).map(prItem))
			items.push(
				...prs
					.slice(0, 5)
					.filter((p) => !awaiting.includes(p))
					.map(prItem),
			)
		} else {
			items.push(
				...commands.filter((c) =>
					`${c.title} ${c.keywords}`.toLowerCase().includes(query),
				),
			)
			const words = query.replace(/^#/, '').split(/\s+/).filter(Boolean)
			items.push(
				...prs
					.filter((p) => !(Number.isSafeInteger(number) && p.number === number))
					.filter((p) =>
						words.every((w) =>
							`${p.number} ${p.title} ${p.author} ${p.areas.join(' ')} ${p.ci}`
								.toLowerCase()
								.includes(w),
						),
					)
					.slice(0, 12)
					.map(prItem),
			)
		}
		return {
			items: items.slice(0, 14),
			status,
			frontmost:
				frontmost && frontmost.pid !== process.pid ? frontmost.name : null,
		}
	}

	async runResult(id) {
		const [kind, value] = id.split(':')
		this.hideQuick()
		if (kind === 'review') return void this.openReview(Number(value))
		if (kind === 'pr') return void this.openDashboard(`/?pr=${Number(value)}`)
		if (kind === 'sync') return void this.poll(false, true)
		if (kind === 'kody') return void this.showApp()
		const views = {
			awaiting: '/?ci=awaiting-approval',
			untested: '/?ci=untested',
			critical: '/?critical=true',
			risk: '/?sort=risk-desc',
			all: '/',
		}
		if (kind === 'view' && views[value])
			return void this.openDashboard(views[value])
	}

	createQuick() {
		const window = new BrowserWindow({
			type: 'panel',
			width: 680,
			height: 440,
			show: false,
			frame: false,
			transparent: true,
			resizable: false,
			alwaysOnTop: true,
			skipTaskbar: true,
			hasShadow: true,
			webPreferences: {
				preload: join(__dirname, 'quick-panel-preload.cjs'),
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
			},
		})
		window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
		window.on('blur', () => this.hideQuick())
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
			x: Math.round(area.x + (area.width - 680) / 2),
			y: Math.round(area.y + area.height * 0.18),
			width: 680,
			height: 440,
		})
		if (this.quick.webContents.isLoading())
			await new Promise((resolve) =>
				this.quick.webContents.once('did-finish-load', resolve),
			)
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
		const area = native.screenUnderMouse(screen)
		const width = 440
		const bounds = {
			x: area.x + area.width - width - 12,
			y: area.y + 12,
			width,
			height: area.height - 24,
		}
		if (!this.review || this.review.isDestroyed()) {
			this.review = new BrowserWindow({
				type: 'panel',
				...bounds,
				minWidth: 360,
				show: false,
				title: `Review #${number}`,
				alwaysOnTop: true,
				backgroundColor: '#0d1117',
				webPreferences: {
					partition,
					sandbox: true,
					contextIsolation: true,
					nodeIntegration: false,
				},
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
		if (this.review && !this.review.isDestroyed() && this.review.isVisible()) {
			if (this.review.isFocused()) return this.review.hide()
			return native.showWithoutActivating(this.review)
		}
		if (this.review && !this.review.isDestroyed())
			return native.showWithoutActivating(this.review)
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
				webPreferences: {
					partition,
					sandbox: true,
					contextIsolation: true,
					nodeIntegration: false,
				},
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
