const { BrowserWindow, session, shell } = require('electron')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const kodyOrigin = 'https://kody.codes'
const partition = 'persist:kody'
const defaults = { org: 'nstudio', app: 'nativescript-github-dashboard' }

/** The package app the lab surfaces drive. Override with { "dashboard": { "org", "app" } } in userData/lab.json. */
function dashboardConfig(app) {
	try {
		const saved = JSON.parse(
			readFileSync(join(app.getPath('userData'), 'lab.json'), 'utf8'),
		)?.dashboard
		if (typeof saved?.org === 'string' && typeof saved?.app === 'string')
			return { org: saved.org, app: saved.app }
	} catch {}
	return defaults
}

/** Local tools on this machine, such as the SimDeck service the dashboard starts through kody.simulator. */
function isLoopback(value) {
	try {
		const url = new URL(value)
		return (
			url.protocol === 'http:' &&
			(url.hostname === '127.0.0.1' || url.hostname === 'localhost')
		)
	} catch {
		return false
	}
}

class Dashboard {
	constructor({ app, openLocal }) {
		this.openLocal = openLocal
		this.config = dashboardConfig(app)
		this.origin = `https://${this.config.org}.kody.run`
		this.base = `${this.origin}/${this.config.app}`
		this.handoffUrl = `${kodyOrigin}/@${this.config.org}/packages/${this.config.app}/open`
		this.session = session.fromPartition(partition)
		this.handoff = null
	}

	url(path = '/') {
		return `${this.base}${path.startsWith('/') ? path : `/${path}`}`
	}

	/** Package apps share a host per org, and Kody auth pages live on kody.codes; anything else opens in the browser. */
	allows(value) {
		try {
			const url = new URL(value)
			return url.origin === kodyOrigin || url.origin === this.origin
		} catch {
			return false
		}
	}

	/** Hosted apps don't see the kody.codes cookie; /open mints a handoff that lands an app-host session cookie. */
	ensureSession() {
		this.handoff ??= new Promise((resolve, reject) => {
			const window = new BrowserWindow({
				show: false,
				webPreferences: { partition, sandbox: true, contextIsolation: true },
			})
			const timer = setTimeout(
				() =>
					finish(
						new Error(
							'Signing in to the dashboard timed out. Sign in to Kody Lab first.',
						),
					),
				30_000,
			)
			const finish = (error) => {
				clearTimeout(timer)
				if (!window.isDestroyed()) window.destroy()
				this.handoff = null
				if (error) reject(error)
				else resolve()
			}
			window.webContents.on('did-navigate', (_event, url) => {
				if (url.startsWith(this.origin)) finish()
				else if (
					url.startsWith(`${kodyOrigin}/login`) ||
					url.startsWith(`${kodyOrigin}/signup`)
				)
					finish(new Error('Sign in to Kody Lab first.'))
			})
			window.loadURL(this.handoffUrl).catch((error) => finish(error))
		})
		return this.handoff
	}

	async fetch(path, init = {}) {
		const request = () =>
			this.session.fetch(this.url(path), {
				...init,
				headers: {
					...init.headers,
					...(init.method && init.method !== 'GET'
						? { Origin: this.origin }
						: {}),
				},
			})
		let response = await request()
		if (
			response.status === 403 &&
			response.headers.get('x-kody-handoff') === 'required'
		) {
			await this.ensureSession()
			response = await request()
		}
		return response
	}

	async json(path, init) {
		const response = await this.fetch(path, init)
		const body = await response.json().catch(() => ({}))
		if (!response.ok)
			throw new Error(body.error || `Dashboard returned ${response.status}`)
		return body
	}

	/** Keep a lab window on the dashboard and Kody's sign-in pages; other links open in the default browser. */
	attach(window) {
		this.attached ??= new WeakSet()
		if (this.attached.has(window)) return
		this.attached.add(window)
		const contents = window.webContents
		contents.setWindowOpenHandler(({ url }) => {
			if (isLoopback(url) && this.openLocal) this.openLocal(url)
			else if (url.startsWith('https://') || isLoopback(url))
				void shell.openExternal(url)
			return { action: 'deny' }
		})
		contents.on('will-navigate', (event, url) => {
			if (this.allows(url)) return
			event.preventDefault()
			if (url.startsWith('https://') || url.startsWith('http://'))
				void shell.openExternal(url)
		})
		contents.on('did-navigate', (_event, url, status) => {
			if (url.startsWith(this.origin) && status === 403)
				void this.ensureSession().then(
					() => contents.reload(),
					() => {},
				)
		})
	}

	async load(window, path) {
		this.attach(window)
		const probe = await this.fetch(path).catch(() => null)
		if (!probe || !probe.ok) await this.ensureSession().catch(() => {})
		await window.loadURL(this.url(path))
	}
}

module.exports = { Dashboard, partition }
