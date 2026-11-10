import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
	inheritedCommandEnv,
	type HostCommandFinished,
	type HostCommandRunContext,
	type HostCommands,
} from './host-commands.js'

/**
 * `kody.simulator.*`: a fixed set of iOS Simulator and Android emulator
 * actions on the daemon's machine. Every call needs host commands (local
 * opt-in and server grant) plus the local simulators opt-in, and is
 * authorized and audited through the same `kody.command.authorize` hop as
 * `kody.command.run`. Arguments are validated and passed to `execFile`, never
 * to a local shell.
 */

type HostSimulatorErrorCode =
	| 'execution_context_simulators_off'
	| 'execution_context_simulator_tool_missing'
	| 'execution_context_simulator_failed'
	| 'invalid_request'

export class HostSimulatorError extends Error {
	constructor(
		readonly code: HostSimulatorErrorCode,
		message: string,
		readonly timedOut = false,
	) {
		super(`${message} (${code})`)
		this.name = 'HostSimulatorError'
	}
}

export type SimulatorExecResult = {
	exitCode: number | null
	stdout: Buffer
	stderr: string
	timedOut: boolean
	/** stdout hit `maxBytes`; the process was killed and `stdout` is cut there. */
	overflow: boolean
}

export type SimulatorExec = (
	file: string,
	args: ReadonlyArray<string>,
	options: { timeoutMs: number; maxBytes: number; signal: AbortSignal },
) => Promise<SimulatorExecResult>

export type SimulatorTools = {
	xcrun: string | null
	adb: string | null
	emulator: string | null
	simdeck: string | null
}

export type SimulatorPlatform = 'ios' | 'android'

export const simulatorActions = [
	'list',
	'boot',
	'shutdown',
	'install',
	'launch',
	'terminate',
	'openUrl',
	'screenshot',
	'describe',
	'stream',
] as const

export const describeSources = [
	'auto',
	'nativescript',
	'native-ax',
	'uikit',
	'swiftui',
	'react-native',
	'flutter',
	'android-uiautomator',
] as const

export const simulatorLimits = {
	screenshotMaxBytes: 8 * 1024 * 1024,
	describeMaxBytes: 256 * 1024,
	toolOutputMaxBytes: 8 * 1024 * 1024,
	errorTailChars: 2000,
	maxListedDevices: 200,
	maxUrlChars: 4096,
	maxPathChars: 4096,
	maxAppIdChars: 255,
	maxDescribeDepth: 100,
	androidBootDefaultMs: 60_000,
	androidBootMinMs: 5_000,
	androidBootMaxMs: 300_000,
	androidBootPollMs: 1_000,
}

const timeouts = {
	list: 20_000,
	boot: 120_000,
	shutdown: 60_000,
	install: 180_000,
	launch: 60_000,
	terminate: 30_000,
	openUrl: 30_000,
	screenshot: 30_000,
	describe: 30_000,
	status: 10_000,
	probe: 5_000,
}

export const defaultSimDeckUrl = 'http://127.0.0.1:4310'

const iosUdidPattern =
	/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/
const androidSerialPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const avdNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const iosBundleIdPattern = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/
const androidPackagePattern =
	/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/
const customSchemePattern = /^[a-z][a-z0-9+.-]{0,63}$/
// Schemes that reach the device's files, scripts, or other apps' content
// instead of opening an app or web page.
const blockedUrlSchemes = new Set([
	'about',
	'android-app',
	'blob',
	'chrome',
	'content',
	'data',
	'file',
	'intent',
	'javascript',
	'vbscript',
])
function hasControlChars(value: string, allowSpace: boolean) {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index)
		if (code < 0x20 || code === 0x7f || (!allowSpace && code === 0x20)) {
			return true
		}
	}
	return false
}

function invalid(message: string): never {
	throw new HostSimulatorError('invalid_request', message)
}

function newCommandId() {
	return `cmd_${randomBytes(9).toString('base64url')}`
}

/** `adb shell` joins its arguments into one device shell command line. */
function deviceShellQuote(value: string) {
	return `'${value.replaceAll("'", `'\\''`)}'`
}

function objectArgs(raw: unknown): Record<string, unknown> {
	if (raw === undefined || raw === null) return {}
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		invalid('Pass one options object, e.g. { platform, id }.')
	}
	return raw as Record<string, unknown>
}

function platformArg(raw: unknown): SimulatorPlatform {
	if (raw !== 'ios' && raw !== 'android') {
		invalid("`platform` must be 'ios' or 'android'.")
	}
	return raw
}

/** iOS: a simulator UDID or `booted`. Android: an adb serial (`emulator-5554`). */
export function deviceIdArg(platform: SimulatorPlatform, raw: unknown) {
	if (typeof raw !== 'string' || raw.length === 0) {
		invalid(
			platform === 'ios'
				? '`id` must be a simulator UDID (kody.simulator.list() shows them) or "booted".'
				: '`id` must be an adb serial such as emulator-5554 (kody.simulator.list() shows them).',
		)
	}
	if (platform === 'ios') {
		if (raw !== 'booted' && !iosUdidPattern.test(raw)) {
			invalid(`${JSON.stringify(raw)} is not a simulator UDID.`)
		}
		return raw
	}
	if (!androidSerialPattern.test(raw)) {
		invalid(`${JSON.stringify(raw)} is not an adb serial.`)
	}
	return raw
}

export function avdNameArg(raw: unknown) {
	if (typeof raw !== 'string' || !avdNamePattern.test(raw)) {
		invalid(
			'`id` must be an AVD name (letters, digits, ".", "_", "-"); kody.simulator.list() shows them under android.avds.',
		)
	}
	return raw
}

export function appIdArg(platform: SimulatorPlatform, raw: unknown) {
	const pattern =
		platform === 'ios' ? iosBundleIdPattern : androidPackagePattern
	if (
		typeof raw !== 'string' ||
		raw.length > simulatorLimits.maxAppIdChars ||
		!pattern.test(raw)
	) {
		invalid(
			platform === 'ios'
				? '`appId` must be a bundle id such as com.example.App.'
				: '`appId` must be a package name such as com.example.app.',
		)
	}
	return raw
}

/** http(s), or an app's custom scheme (`myapp://…`) that is not a blocked system scheme. */
export function urlArg(raw: unknown) {
	if (
		typeof raw !== 'string' ||
		raw.length === 0 ||
		raw.length > simulatorLimits.maxUrlChars ||
		hasControlChars(raw, false)
	) {
		invalid('`url` must be a URL without spaces, at most 4096 characters.')
	}
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		invalid(`${JSON.stringify(raw)} is not a URL.`)
	}
	const scheme = url.protocol.slice(0, -1).toLowerCase()
	if (scheme === 'http' || scheme === 'https') {
		if (!url.hostname) invalid('An http(s) `url` needs a host.')
		return url.href
	}
	if (!customSchemePattern.test(scheme) || blockedUrlSchemes.has(scheme)) {
		invalid(
			`URL scheme ${scheme}: is not allowed. Use http, https, or an app's own scheme.`,
		)
	}
	return url.href
}

/** An existing `.app` bundle (iOS) or `.apk` file (Android), as its real path. */
export async function appPathArg(platform: SimulatorPlatform, raw: unknown) {
	if (
		typeof raw !== 'string' ||
		!isAbsolute(raw) ||
		raw.length > simulatorLimits.maxPathChars ||
		hasControlChars(raw, true)
	) {
		invalid('`appPath` must be an absolute path on the machine.')
	}
	const real = await realpath(raw).catch(() => null)
	const info = real ? await stat(real).catch(() => null) : null
	if (!real || !info) invalid(`${raw} does not exist on this machine.`)
	if (platform === 'ios' && !(real.endsWith('.app') && info.isDirectory())) {
		invalid(`${raw} is not a .app bundle (a folder ending in .app).`)
	}
	if (platform === 'android' && !(/\.apk$/i.test(real) && info.isFile())) {
		invalid(`${raw} is not an .apk file.`)
	}
	return real
}

function intArg(
	raw: unknown,
	name: string,
	fallback: number,
	min: number,
	max: number,
) {
	if (raw === undefined || raw === null) return fallback
	if (typeof raw !== 'number' || !Number.isInteger(raw)) {
		invalid(`\`${name}\` must be an integer.`)
	}
	return Math.min(Math.max(raw, min), max)
}

function describeSourceArg(raw: unknown) {
	if (raw === undefined || raw === null) return 'auto'
	if (
		typeof raw !== 'string' ||
		!(describeSources as ReadonlyArray<string>).includes(raw)
	) {
		invalid(`\`source\` must be one of ${describeSources.join(', ')}.`)
	}
	return raw
}

/** iOS simctl runtime id → "iOS 18.2". */
function runtimeLabel(id: string) {
	const short = id.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, '')
	const match = /^([A-Za-z]+)-(.+)$/.exec(short)
	return match ? `${match[1]} ${match[2]!.replaceAll('-', '.')}` : short
}

function pngSize(png: Buffer) {
	const signature = '89504e470d0a1a0a'
	if (png.length < 24 || png.subarray(0, 8).toString('hex') !== signature) {
		return null
	}
	return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

function decodeCapped(buffer: Buffer, cut: boolean) {
	const text = buffer.toString('utf8')
	// A cut can end inside a multi-byte character.
	return cut ? text.replace(/�$/, '') : text
}

/** Runs a tool with `execFile` (no shell) and the daemon's env minus `KODY_*`. */
export const execSimulatorTool: SimulatorExec = (file, args, options) =>
	new Promise((resolve) => {
		execFile(
			file,
			[...args],
			{
				encoding: 'buffer',
				maxBuffer: options.maxBytes,
				timeout: options.timeoutMs,
				killSignal: 'SIGKILL',
				signal: options.signal,
				env: inheritedCommandEnv(),
				windowsHide: true,
			},
			(error, stdout, stderr) => {
				const failure = error as
					| (Error & { code?: unknown; killed?: boolean })
					| null
				const overflow = failure?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
				const stderrText = Buffer.from(stderr ?? []).toString('utf8')
				resolve({
					exitCode: failure
						? typeof failure.code === 'number'
							? failure.code
							: null
						: 0,
					stdout: Buffer.from(stdout ?? []),
					stderr:
						stderrText ||
						(failure && typeof failure.code !== 'number'
							? failure.message
							: ''),
					timedOut:
						failure?.killed === true && !overflow && !options.signal.aborted,
					overflow,
				})
			},
		)
	})

function spawnDetachedTool(file: string, args: ReadonlyArray<string>) {
	const child = spawn(file, [...args], {
		detached: true,
		stdio: 'ignore',
		env: inheritedCommandEnv(),
		windowsHide: true,
	})
	child.on('error', () => {})
	child.unref()
}

async function findExecutable(
	name: string,
	dirs: ReadonlyArray<string>,
	platform: NodeJS.Platform,
) {
	const names = platform === 'win32' ? [`${name}.exe`, name] : [name]
	for (const dir of dirs) {
		if (!dir || !isAbsolute(dir)) continue
		for (const candidate of names) {
			const path = join(dir, candidate)
			try {
				await access(path, constants.X_OK)
				if ((await stat(path)).isFile()) return path
			} catch {
				// Not here.
			}
		}
	}
	return null
}

/**
 * Finds the tools on PATH, plus the usual Android SDK and Xcode locations:
 * a daemon run as a background service often has a minimal PATH.
 */
export async function resolveSimulatorTools(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	home: string = homedir(),
): Promise<SimulatorTools> {
	const path = (env.PATH ?? env.Path ?? '').split(delimiter)
	const sdkRoots = [
		env.ANDROID_HOME,
		env.ANDROID_SDK_ROOT,
		platform === 'darwin' ? join(home, 'Library/Android/sdk') : undefined,
		platform === 'linux' ? join(home, 'Android/Sdk') : undefined,
		platform === 'win32' && env.LOCALAPPDATA
			? join(env.LOCALAPPDATA, 'Android', 'Sdk')
			: undefined,
	].filter((root): root is string => typeof root === 'string' && root !== '')
	const [xcrun, adb, emulator, simdeck] = await Promise.all([
		platform === 'darwin'
			? findExecutable('xcrun', [...path, '/usr/bin'], platform)
			: null,
		findExecutable(
			'adb',
			[...path, ...sdkRoots.map((root) => join(root, 'platform-tools'))],
			platform,
		),
		findExecutable(
			'emulator',
			[...path, ...sdkRoots.map((root) => join(root, 'emulator'))],
			platform,
		),
		findExecutable('simdeck', path, platform),
	])
	return { xcrun, adb, emulator, simdeck }
}

type AndroidDevice = {
	serial: string
	state: string
	model?: string
	product?: string
	avd?: string
}

type Plan = {
	/** The fixed action as audited, e.g. `kody.simulator.screenshot ios <udid>`. */
	command: string
	execute: (signal: AbortSignal) => Promise<unknown>
}

export type HostSimulatorsOptions = {
	hostCommands: Pick<HostCommands, 'assertAvailable' | 'reportFinished'>
	/** This machine's local opt-in (`kody context simulators on`). */
	localEnabled?: boolean
	exec?: SimulatorExec
	spawnDetached?: (file: string, args: ReadonlyArray<string>) => void
	resolveTools?: () => Promise<SimulatorTools>
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>
	/** The audited `cwd` of every action; defaults to the home folder. */
	cwd?: string
}

export class HostSimulators {
	#localEnabled: boolean
	readonly #hostCommands: HostSimulatorsOptions['hostCommands']
	readonly #exec: SimulatorExec
	readonly #spawnDetached: NonNullable<HostSimulatorsOptions['spawnDetached']>
	readonly #resolveTools: () => Promise<SimulatorTools>
	readonly #sleep: NonNullable<HostSimulatorsOptions['sleep']>
	readonly #cwd: string

	constructor(options: HostSimulatorsOptions) {
		this.#hostCommands = options.hostCommands
		this.#localEnabled = options.localEnabled === true
		this.#exec = options.exec ?? execSimulatorTool
		this.#spawnDetached = options.spawnDetached ?? spawnDetachedTool
		this.#resolveTools = options.resolveTools ?? (() => resolveSimulatorTools())
		this.#sleep =
			options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }))
		this.#cwd = options.cwd ?? homedir()
	}

	setLocalEnabled(enabled: boolean) {
		this.#localEnabled = enabled
	}

	/** Throws the denial a run sees when it may not control simulators here. */
	assertAvailable() {
		if (!this.#localEnabled) {
			throw new HostSimulatorError(
				'execution_context_simulators_off',
				'Simulator control is off on this machine: its owner has not opted in. Turn it on on the machine with `kody context simulators on` or the Kody desktop app (Machine > Allow simulators). It also needs host commands on (`kody context commands on`).',
			)
		}
		this.#hostCommands.assertAvailable()
	}

	/** Dispatches one `kody.simulator.<name>(args)` call from a run. */
	async call(name: string, args: unknown, run: HostCommandRunContext) {
		this.assertAvailable()
		if (!(simulatorActions as ReadonlyArray<string>).includes(name)) {
			invalid(
				`Unknown kody.simulator.${name}. Use ${simulatorActions.join(', ')}.`,
			)
		}
		const input = objectArgs(args)
		const tools = await this.#resolveTools()
		const plan = await this.#plan(name, input, tools)
		const commandId = newCommandId()
		await run.authorize({
			commandId,
			command: plan.command,
			cwd: this.#cwd,
			envKeys: [],
			background: false,
		})
		this.assertAvailable()
		const startedAt = Date.now()
		let reason: HostCommandFinished['reason'] = 'exited'
		let exitCode: number | null = 0
		try {
			return await plan.execute(run.signal)
		} catch (error) {
			if (run.signal.aborted) {
				reason = 'cancelled'
				exitCode = null
			} else if (error instanceof HostSimulatorError && error.timedOut) {
				reason = 'timed_out'
				exitCode = null
			} else {
				exitCode = 1
			}
			throw error
		} finally {
			this.#hostCommands.reportFinished({
				commandId,
				runId: run.runId,
				command: plan.command,
				cwd: this.#cwd,
				exitCode,
				signal: null,
				durationMs: Date.now() - startedAt,
				background: false,
				reason,
			})
		}
	}

	async #plan(
		name: string,
		input: Record<string, unknown>,
		tools: SimulatorTools,
	): Promise<Plan> {
		const action = `kody.simulator.${name}`
		if (name === 'list') {
			return { command: action, execute: (signal) => this.#list(tools, signal) }
		}
		if (name === 'stream') {
			const simdeck = requireSimDeck(tools)
			return {
				command: action,
				execute: (signal) => this.#stream(simdeck, signal),
			}
		}
		const platform = platformArg(input.platform)
		if (name === 'describe') {
			const simdeck = requireSimDeck(tools)
			const id =
				input.id === undefined || input.id === null
					? null
					: deviceIdArg(platform, input.id)
			const source = describeSourceArg(input.source)
			const maxDepth =
				input.maxDepth === undefined || input.maxDepth === null
					? null
					: intArg(
							input.maxDepth,
							'maxDepth',
							0,
							1,
							simulatorLimits.maxDescribeDepth,
						)
			const args = [
				'describe',
				...(id ? [id] : []),
				'--format',
				'agent',
				'--source',
				source,
				...(maxDepth === null ? [] : ['--max-depth', String(maxDepth)]),
			]
			return {
				command: [action, platform, ...args.slice(1)].join(' '),
				execute: (signal) => this.#describe(simdeck, args, source, signal),
			}
		}
		if (platform === 'android' && name === 'boot') {
			const avd = avdNameArg(input.id)
			const waitMs = intArg(
				input.timeoutMs,
				'timeoutMs',
				simulatorLimits.androidBootDefaultMs,
				simulatorLimits.androidBootMinMs,
				simulatorLimits.androidBootMaxMs,
			)
			const emulator = requireTool(tools, 'emulator')
			const adb = requireTool(tools, 'adb')
			return {
				command: `${action} android ${avd}`,
				execute: (signal) =>
					this.#bootAndroid(emulator, adb, avd, waitMs, signal),
			}
		}
		if (platform === 'android' && name === 'shutdown') {
			const id =
				typeof input.id === 'string' && /^emulator-\d+$/.test(input.id)
					? input.id
					: avdNameArg(input.id)
			const adb = requireTool(tools, 'adb')
			return {
				command: `${action} android ${id}`,
				execute: (signal) => this.#shutdownAndroid(adb, id, signal),
			}
		}
		const id = deviceIdArg(platform, input.id)
		const command = (...extra: Array<string>) =>
			[action, platform, id, ...extra].join(' ')
		if (platform === 'ios') {
			const xcrun = requireTool(tools, 'xcrun')
			const simctl = (args: Array<string>, timeoutMs: number) =>
				this.#run(xcrun, ['simctl', ...args], { timeoutMs }, name)
			switch (name) {
				case 'boot':
					return {
						command: command(),
						execute: async (signal) => {
							const result = await simctl(['boot', id], timeouts.boot)(signal)
							const already = /current state:\s*Booted/i.test(result.stderr)
							if (result.exitCode !== 0 && !already) failed(name, result)
							return { platform, id, booted: true, alreadyBooted: already }
						},
					}
				case 'shutdown':
					return {
						command: command(),
						execute: async (signal) => {
							const result = await simctl(
								['shutdown', id],
								timeouts.shutdown,
							)(signal)
							const already = /current state:\s*Shutdown/i.test(result.stderr)
							if (result.exitCode !== 0 && !already) failed(name, result)
							return { platform, id, shutdown: true, alreadyShutdown: already }
						},
					}
				case 'install': {
					const appPath = await appPathArg(platform, input.appPath)
					return {
						command: command(appPath),
						execute: async (signal) => {
							ok(
								name,
								await simctl(
									['install', id, appPath],
									timeouts.install,
								)(signal),
							)
							return { platform, id, appPath, installed: true }
						},
					}
				}
				case 'launch': {
					const appId = appIdArg(platform, input.appId)
					return {
						command: command(appId),
						execute: async (signal) => {
							const result = ok(
								name,
								await simctl(['launch', id, appId], timeouts.launch)(signal),
							)
							const pid = /:\s*(\d+)\s*$/.exec(result.stdout.toString('utf8'))
							return {
								platform,
								id,
								appId,
								launched: true,
								pid: pid ? Number(pid[1]) : null,
							}
						},
					}
				}
				case 'terminate': {
					const appId = appIdArg(platform, input.appId)
					return {
						command: command(appId),
						execute: async (signal) => {
							const result = await simctl(
								['terminate', id, appId],
								timeouts.terminate,
							)(signal)
							const notRunning = /found nothing to terminate/i.test(
								result.stderr,
							)
							if (result.exitCode !== 0 && !notRunning) failed(name, result)
							return { platform, id, appId, terminated: !notRunning }
						},
					}
				}
				case 'openUrl': {
					const url = urlArg(input.url)
					return {
						command: command(url),
						execute: async (signal) => {
							ok(
								name,
								await simctl(['openurl', id, url], timeouts.openUrl)(signal),
							)
							return { platform, id, url, opened: true }
						},
					}
				}
				case 'screenshot':
					return {
						command: command(),
						execute: (signal) => this.#screenshotIos(xcrun, id, signal),
					}
			}
			invalid(`kody.simulator.${name} is not available for ios.`)
		}
		const adb = requireTool(tools, 'adb')
		const adbOn = (args: Array<string>, timeoutMs: number, maxBytes?: number) =>
			this.#run(adb, ['-s', id, ...args], { timeoutMs, maxBytes }, name)
		switch (name) {
			case 'install': {
				const appPath = await appPathArg(platform, input.appPath)
				return {
					command: command(appPath),
					execute: async (signal) => {
						const result = ok(
							name,
							await adbOn(['install', '-r', appPath], timeouts.install)(signal),
						)
						if (/Failure\s*\[/.test(result.stdout.toString('utf8'))) {
							failed(name, result)
						}
						return { platform, id, appPath, installed: true }
					},
				}
			}
			case 'launch': {
				const appId = appIdArg(platform, input.appId)
				return {
					command: command(appId),
					execute: async (signal) => {
						const result = ok(
							name,
							await adbOn(
								[
									'shell',
									'monkey',
									'-p',
									appId,
									'-c',
									'android.intent.category.LAUNCHER',
									'1',
								],
								timeouts.launch,
							)(signal),
						)
						if (/No activities found|monkey aborted/i.test(outputOf(result))) {
							failed(name, result)
						}
						return { platform, id, appId, launched: true, pid: null }
					},
				}
			}
			case 'terminate': {
				const appId = appIdArg(platform, input.appId)
				return {
					command: command(appId),
					execute: async (signal) => {
						ok(
							name,
							await adbOn(
								['shell', 'am', 'force-stop', appId],
								timeouts.terminate,
							)(signal),
						)
						return { platform, id, appId, terminated: true }
					},
				}
			}
			case 'openUrl': {
				const url = urlArg(input.url)
				return {
					command: command(url),
					execute: async (signal) => {
						const result = ok(
							name,
							await adbOn(
								[
									'shell',
									'am',
									'start',
									'-a',
									'android.intent.action.VIEW',
									'-d',
									deviceShellQuote(url),
								],
								timeouts.openUrl,
							)(signal),
						)
						if (/^Error/m.test(outputOf(result))) failed(name, result)
						return { platform, id, url, opened: true }
					},
				}
			}
			case 'screenshot':
				return {
					command: command(),
					execute: async (signal) => {
						const result = await adbOn(
							['exec-out', 'screencap', '-p'],
							timeouts.screenshot,
							simulatorLimits.screenshotMaxBytes,
						)(signal)
						if (result.overflow) screenshotTooLarge()
						ok(name, result)
						return screenshotResult(result.stdout)
					},
				}
		}
		invalid(`kody.simulator.${name} is not available for android.`)
	}

	/** One tool call; throws on timeout or cancel, returns the rest for the action to judge. */
	#run(
		file: string,
		args: Array<string>,
		options: { timeoutMs: number; maxBytes?: number | undefined },
		action: string,
	) {
		return async (signal: AbortSignal) => {
			const result = await this.#exec(file, args, {
				timeoutMs: options.timeoutMs,
				maxBytes: options.maxBytes ?? simulatorLimits.toolOutputMaxBytes,
				signal,
			})
			if (signal.aborted) {
				throw new HostSimulatorError(
					'execution_context_simulator_failed',
					`kody.simulator.${action} was cancelled.`,
				)
			}
			if (result.timedOut) {
				throw new HostSimulatorError(
					'execution_context_simulator_failed',
					`kody.simulator.${action} timed out after ${Math.round(options.timeoutMs / 1000)} s.`,
					true,
				)
			}
			return result
		}
	}

	async #list(tools: SimulatorTools, signal: AbortSignal) {
		const errorText = (error: unknown) =>
			error instanceof Error ? error.message : String(error)
		const ios = tools.xcrun
			? await this.#listIos(tools.xcrun, signal).then(
					(devices) => ({ available: true, devices }),
					(error: unknown) => ({
						available: true,
						devices: [],
						error: errorText(error),
					}),
				)
			: { available: false, devices: [] }
		const androidDevices = tools.adb
			? await this.#androidDevices(tools.adb, signal).then(
					(devices) => ({ devices }),
					(error: unknown) => ({ devices: [], error: errorText(error) }),
				)
			: { devices: [] }
		const avds = tools.emulator
			? await this.#listAvds(tools.emulator, signal).then(
					(avds) => ({ avds }),
					(error: unknown) => ({ avds: [], avdsError: errorText(error) }),
				)
			: { avds: [] }
		return {
			ios,
			android: {
				adb: tools.adb !== null,
				emulator: tools.emulator !== null,
				...androidDevices,
				...avds,
			},
			simdeck: tools.simdeck !== null,
		}
	}

	async #listIos(xcrun: string, signal: AbortSignal) {
		const result = ok(
			'list',
			await this.#run(
				xcrun,
				['simctl', 'list', 'devices', 'available', '--json'],
				{ timeoutMs: timeouts.list },
				'list',
			)(signal),
		)
		let parsed: unknown
		try {
			parsed = JSON.parse(result.stdout.toString('utf8'))
		} catch {
			throw new HostSimulatorError(
				'execution_context_simulator_failed',
				'xcrun simctl list did not print JSON.',
			)
		}
		const byRuntime = (parsed as { devices?: unknown })?.devices
		const devices: Array<{
			udid: string
			name: string
			runtime: string
			state: string
		}> = []
		if (!byRuntime || typeof byRuntime !== 'object') return devices
		for (const [runtime, list] of Object.entries(byRuntime)) {
			if (!Array.isArray(list)) continue
			for (const device of list as Array<Record<string, unknown>>) {
				if (typeof device?.udid !== 'string') continue
				devices.push({
					udid: device.udid,
					name: typeof device.name === 'string' ? device.name : device.udid,
					runtime: runtimeLabel(runtime),
					state: typeof device.state === 'string' ? device.state : 'Unknown',
				})
			}
		}
		return devices.slice(0, simulatorLimits.maxListedDevices)
	}

	async #androidDevices(adb: string, signal: AbortSignal) {
		const result = ok(
			'list',
			await this.#run(
				adb,
				['devices', '-l'],
				{ timeoutMs: timeouts.list },
				'list',
			)(signal),
		)
		const devices: Array<AndroidDevice> = []
		for (const line of result.stdout.toString('utf8').split(/\r?\n/)) {
			const [serial, state, ...rest] = line.trim().split(/\s+/)
			if (
				!serial ||
				!state ||
				line.startsWith('*') ||
				line.startsWith('List of devices') ||
				!androidSerialPattern.test(serial)
			) {
				continue
			}
			const device: AndroidDevice = { serial, state }
			for (const pair of rest) {
				const [key, value] = pair.split(':')
				if (key === 'model' && value) device.model = value
				if (key === 'product' && value) device.product = value
			}
			devices.push(device)
			if (devices.length >= simulatorLimits.maxListedDevices) break
		}
		await Promise.all(
			devices
				.filter((device) => /^emulator-\d+$/.test(device.serial))
				.map(async (device) => {
					const avd = await this.#emulatorAvd(adb, device.serial, signal)
					if (avd) device.avd = avd
				}),
		)
		return devices
	}

	async #emulatorAvd(adb: string, serial: string, signal: AbortSignal) {
		const result = await this.#exec(adb, ['-s', serial, 'emu', 'avd', 'name'], {
			timeoutMs: timeouts.probe,
			maxBytes: 64 * 1024,
			signal,
		})
		if (result.exitCode !== 0) return null
		const name = result.stdout.toString('utf8').split(/\r?\n/)[0]?.trim()
		return name && avdNamePattern.test(name) ? name : null
	}

	async #listAvds(emulator: string, signal: AbortSignal) {
		const result = ok(
			'list',
			await this.#run(
				emulator,
				['-list-avds'],
				{ timeoutMs: timeouts.list },
				'list',
			)(signal),
		)
		return result.stdout
			.toString('utf8')
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => avdNamePattern.test(line))
			.slice(0, simulatorLimits.maxListedDevices)
	}

	async #bootAndroid(
		emulator: string,
		adb: string,
		avd: string,
		waitMs: number,
		signal: AbortSignal,
	) {
		const avds = await this.#listAvds(emulator, signal)
		if (!avds.includes(avd)) {
			invalid(
				`No AVD named ${avd} on this machine. kody.simulator.list() shows android.avds.`,
			)
		}
		const running = (await this.#androidDevices(adb, signal)).find(
			(device) => device.avd === avd,
		)
		if (running?.state === 'device') {
			return {
				platform: 'android',
				id: avd,
				serial: running.serial,
				booted: true,
				alreadyBooted: true,
			}
		}
		if (!running) this.#spawnDetached(emulator, ['-avd', avd])
		const deadline = Date.now() + waitMs
		let serial = running?.serial ?? null
		while (Date.now() < deadline) {
			try {
				await this.#sleep(simulatorLimits.androidBootPollMs, signal)
			} catch {
				throw new HostSimulatorError(
					'execution_context_simulator_failed',
					'kody.simulator.boot was cancelled.',
				)
			}
			if (serial === null) {
				serial =
					(await this.#androidDevices(adb, signal)).find(
						(device) => device.avd === avd,
					)?.serial ?? null
				if (serial === null) continue
			}
			const booted = await this.#exec(
				adb,
				['-s', serial, 'shell', 'getprop', 'sys.boot_completed'],
				{ timeoutMs: timeouts.probe, maxBytes: 64 * 1024, signal },
			)
			if (
				booted.exitCode === 0 &&
				booted.stdout.toString('utf8').trim() === '1'
			) {
				return {
					platform: 'android',
					id: avd,
					serial,
					booted: true,
					alreadyBooted: false,
				}
			}
		}
		return {
			platform: 'android',
			id: avd,
			serial,
			booted: false,
			alreadyBooted: false,
			timedOut: true,
		}
	}

	async #shutdownAndroid(adb: string, id: string, signal: AbortSignal) {
		let serial = id
		if (!/^emulator-\d+$/.test(id)) {
			const running = (await this.#androidDevices(adb, signal)).find(
				(device) => device.avd === id,
			)
			if (!running) {
				return {
					platform: 'android',
					id,
					serial: null,
					shutdown: true,
					alreadyShutdown: true,
				}
			}
			serial = running.serial
		}
		ok(
			'shutdown',
			await this.#run(
				adb,
				['-s', serial, 'emu', 'kill'],
				{ timeoutMs: timeouts.shutdown },
				'shutdown',
			)(signal),
		)
		return {
			platform: 'android',
			id,
			serial,
			shutdown: true,
			alreadyShutdown: false,
		}
	}

	async #screenshotIos(xcrun: string, udid: string, signal: AbortSignal) {
		// `simctl io … screenshot -` writes a file named "-" on some Xcode
		// versions instead of stdout, so always go through a temp file.
		const dir = await mkdtemp(join(tmpdir(), 'kody-simulator-'))
		const file = join(dir, 'screen.png')
		try {
			ok(
				'screenshot',
				await this.#run(
					xcrun,
					['simctl', 'io', udid, 'screenshot', '--type=png', file],
					{ timeoutMs: timeouts.screenshot },
					'screenshot',
				)(signal),
			)
			const info = await stat(file).catch(() => null)
			if (!info) {
				throw new HostSimulatorError(
					'execution_context_simulator_failed',
					'xcrun simctl io screenshot wrote no image.',
				)
			}
			if (info.size > simulatorLimits.screenshotMaxBytes) screenshotTooLarge()
			return screenshotResult(await readFile(file))
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	}

	async #describe(
		simdeck: string,
		args: Array<string>,
		source: string,
		signal: AbortSignal,
	) {
		const result = await this.#run(
			simdeck,
			args,
			{
				timeoutMs: timeouts.describe,
				maxBytes: simulatorLimits.describeMaxBytes,
			},
			'describe',
		)(signal)
		if (!result.overflow) ok('describe', result)
		return {
			source,
			text: decodeCapped(result.stdout, result.overflow),
			truncated: result.overflow,
		}
	}

	async #stream(simdeck: string, signal: AbortSignal) {
		// `service status` on current SimDeck; `daemon status` on 0.1.x.
		for (const [args, key] of [
			[['service', 'status'], 'service'],
			[['daemon', 'status'], 'daemon'],
		] as const) {
			const result = await this.#run(
				simdeck,
				[...args],
				{ timeoutMs: timeouts.status, maxBytes: 256 * 1024 },
				'stream',
			)(signal)
			if (result.exitCode !== 0) continue
			let status: Record<string, unknown>
			try {
				status = JSON.parse(result.stdout.toString('utf8'))
			} catch {
				continue
			}
			const meta = status[key] as { httpUrl?: unknown } | null | undefined
			const raw = meta?.httpUrl ?? status.url
			const url = typeof raw === 'string' ? httpOrigin(raw) : null
			return {
				url: url ?? defaultSimDeckUrl,
				running: status.running === true,
			}
		}
		return { url: defaultSimDeckUrl, running: false }
	}
}

/** Only the origin: SimDeck's metadata also carries an access token that must not leave the daemon. */
function httpOrigin(raw: string) {
	try {
		const url = new URL(raw)
		return url.protocol === 'http:' || url.protocol === 'https:'
			? url.origin
			: null
	} catch {
		return null
	}
}

function outputOf(result: SimulatorExecResult) {
	return `${result.stdout.toString('utf8')}\n${result.stderr}`
}

function failed(action: string, result: SimulatorExecResult): never {
	const detail = outputOf(result).trim().slice(-simulatorLimits.errorTailChars)
	throw new HostSimulatorError(
		'execution_context_simulator_failed',
		`kody.simulator.${action} failed${result.exitCode === null ? '' : ` (exit ${result.exitCode})`}${detail ? `: ${detail}` : '.'}`,
	)
}

function ok(action: string, result: SimulatorExecResult) {
	if (result.exitCode !== 0) failed(action, result)
	return result
}

function screenshotTooLarge(): never {
	throw new HostSimulatorError(
		'execution_context_simulator_failed',
		'The screenshot is larger than 8 MB.',
	)
}

function screenshotResult(png: Buffer) {
	const size = pngSize(png)
	if (!size) {
		throw new HostSimulatorError(
			'execution_context_simulator_failed',
			'The screenshot is not a PNG image.',
		)
	}
	return {
		mimeType: 'image/png' as const,
		base64: png.toString('base64'),
		bytes: png.length,
		...size,
	}
}

const toolHints: Record<keyof SimulatorTools, string> = {
	xcrun: 'iOS simulators need Xcode on a Mac (xcrun simctl).',
	adb: 'Android needs the Android SDK platform-tools (adb) on PATH or in ANDROID_HOME.',
	emulator:
		'Booting an AVD needs the Android SDK emulator on PATH or in ANDROID_HOME.',
	simdeck:
		'Install SimDeck (`npm i -g simdeck`) and make sure the daemon sees it on PATH (`kody daemon env set PATH=…`).',
}

function requireTool(tools: SimulatorTools, name: keyof SimulatorTools) {
	const path = tools[name]
	if (!path) {
		throw new HostSimulatorError(
			'execution_context_simulator_tool_missing',
			`${name} was not found on this machine. ${toolHints[name]}`,
		)
	}
	return path
}

function requireSimDeck(tools: SimulatorTools) {
	return requireTool(tools, 'simdeck')
}
