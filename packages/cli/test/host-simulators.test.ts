import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
	HostCommands,
	type HostCommandFinished,
	type HostCommandRunContext,
} from '../src/execution-context/host-commands.js'
import {
	HostSimulators,
	appIdArg,
	appPathArg,
	deviceIdArg,
	resolveSimulatorTools,
	urlArg,
	type SimulatorExec,
	type SimulatorTools,
} from '../src/execution-context/host-simulators.js'
import {
	readLocalPolicy,
	readLocalSimulatorsEnabled,
	setLocalCommandsEnabled,
	setLocalSimulatorsEnabled,
	allowLocalPath,
} from '../src/execution-context/fs-access.js'
import { runExecutionContextCommand } from '../src/execution-context/commands.js'

type Authorized = Parameters<HostCommandRunContext['authorize']>[0]
type ExecCall = { file: string; args: Array<string> }

const udid = '0F6B1F1E-1C2D-4E5F-8A9B-0C1D2E3F4A5B'
const allTools: SimulatorTools = {
	xcrun: '/usr/bin/xcrun',
	adb: '/sdk/platform-tools/adb',
	emulator: '/sdk/emulator/emulator',
	simdeck: '/bin/simdeck',
}
const png = Buffer.concat([
	Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
	Buffer.from([0, 0, 1, 0x2c, 0, 0, 2, 0x58]),
	Buffer.alloc(16),
])

function result(stdout: string | Buffer = '', overrides = {}) {
	return {
		exitCode: 0,
		stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
		stderr: '',
		timedOut: false,
		overflow: false,
		...overrides,
	}
}

function setup(
	options: {
		commands?: boolean
		grant?: boolean
		simulators?: boolean
		tools?: Partial<SimulatorTools>
		exec?: (call: ExecCall) => Awaited<ReturnType<SimulatorExec>> | undefined
		probeSimDeck?: (port: number) => Promise<number | null>
	} = {},
) {
	const hostCommands = new HostCommands({
		localEnabled: options.commands ?? true,
	})
	hostCommands.setGrantEnabled(options.grant ?? true)
	const finished: Array<HostCommandFinished> = []
	hostCommands.setReporter((entry) => {
		finished.push(entry)
	})
	const calls: Array<ExecCall> = []
	const spawned: Array<ExecCall> = []
	const simulators = new HostSimulators({
		hostCommands,
		localEnabled: options.simulators ?? true,
		cwd: '/Users/me',
		resolveTools: async () => ({ ...allTools, ...options.tools }),
		exec: async (file, args) => {
			const call = { file, args: [...args] }
			calls.push(call)
			return options.exec?.(call) ?? result()
		},
		spawnDetached: (file, args) => {
			spawned.push({ file, args: [...args] })
		},
		sleep: async () => {},
		probeSimDeck: options.probeSimDeck ?? (async () => null),
	})
	const authorized: Array<Authorized> = []
	const run: HostCommandRunContext = {
		runId: 'run_1',
		requesterUserId: 'user_a',
		signal: new AbortController().signal,
		authorize: async (input) => {
			authorized.push(input)
		},
	}
	return {
		simulators,
		hostCommands,
		run,
		authorized,
		calls,
		spawned,
		finished,
	}
}

function commandOf(entry: Authorized | undefined) {
	assert.ok(entry && 'command' in entry, 'authorized a start')
	return entry
}

test('device ids, app ids, and URLs are validated before anything runs', () => {
	assert.equal(deviceIdArg('ios', udid), udid)
	assert.equal(deviceIdArg('ios', 'booted'), 'booted')
	assert.equal(deviceIdArg('android', 'emulator-5554'), 'emulator-5554')
	assert.equal(deviceIdArg('android', '192.168.1.5:5555'), '192.168.1.5:5555')
	for (const bad of ['', 'iPhone 15', `${udid}; rm -rf ~`, '--help', 42]) {
		assert.throws(() => deviceIdArg('ios', bad), /invalid_request/)
	}
	for (const bad of ['-s', 'emulator-5554 shell', 'a$(id)', 'x\n']) {
		assert.throws(() => deviceIdArg('android', bad), /invalid_request/)
	}
	assert.equal(appIdArg('ios', 'com.example.My-App'), 'com.example.My-App')
	assert.equal(
		appIdArg('android', 'org.nativescript.demo'),
		'org.nativescript.demo',
	)
	for (const bad of ['single', 'com.example;reboot', 'com.example app', '']) {
		assert.throws(() => appIdArg('ios', bad), /invalid_request/)
	}
	assert.throws(() => appIdArg('android', 'com.my-app'), /invalid_request/)
	assert.throws(() => appIdArg('android', 'com.1app'), /invalid_request/)

	assert.equal(urlArg('https://example.com/a?b=c'), 'https://example.com/a?b=c')
	assert.equal(urlArg('myapp://open/item?id=1'), 'myapp://open/item?id=1')
	for (const bad of [
		'file:///etc/passwd',
		'javascript:alert(1)',
		'data:text/html,hi',
		'intent://x#Intent;end',
		'content://contacts/people',
		'https://exa mple.com',
		'not a url',
		'https://',
		`https://example.com/${'a'.repeat(5000)}`,
	]) {
		assert.throws(() => urlArg(bad), /invalid_request/, bad)
	}
})

test('app paths must be absolute and exist as a .app folder (iOS) or .apk file (Android)', async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kody-sim-test-')))
	const app = join(dir, 'Demo.app')
	mkdirSync(app)
	const apk = join(dir, 'demo.apk')
	writeFileSync(apk, 'apk')
	assert.equal(await appPathArg('ios', app), app)
	assert.equal(await appPathArg('android', apk), apk)
	await assert.rejects(appPathArg('ios', 'Demo.app'), /absolute path/)
	await assert.rejects(
		appPathArg('ios', join(dir, 'Missing.app')),
		/does not exist/,
	)
	await assert.rejects(appPathArg('ios', apk), /not a \.app bundle/)
	await assert.rejects(appPathArg('android', app), /not an \.apk file/)
})

test('simulator calls need the simulators opt-in and host commands (local and grant)', async () => {
	const off = setup({ simulators: false })
	await assert.rejects(
		off.simulators.call('list', undefined, off.run),
		/kody context simulators on[\s\S]*Machine > Allow simulators[\s\S]*\(execution_context_simulators_off\)/,
	)
	const noCommands = setup({ commands: false })
	await assert.rejects(
		noCommands.simulators.call('list', undefined, noCommands.run),
		/kody context commands on[\s\S]*\(execution_context_commands_off\)/,
	)
	const noGrant = setup({ grant: false })
	await assert.rejects(
		noGrant.simulators.call('list', undefined, noGrant.run),
		/\(execution_context_commands_off\)/,
	)
	for (const denied of [off, noCommands, noGrant]) {
		assert.deepEqual(denied.authorized, [])
		assert.deepEqual(denied.calls, [])
	}

	const on = setup({ simulators: false })
	on.simulators.setLocalEnabled(true)
	await on.simulators.call('list', undefined, on.run)
	assert.equal(on.authorized.length, 1)
})

test('availability is checked again after authorize', async () => {
	const ctx = setup()
	ctx.run.authorize = async () => {
		ctx.simulators.setLocalEnabled(false)
	}
	await assert.rejects(
		ctx.simulators.call('screenshot', { platform: 'ios', id: udid }, ctx.run),
		/execution_context_simulators_off/,
	)
	assert.deepEqual(ctx.calls, [])
})

test('invalid arguments are refused before authorize', async () => {
	const ctx = setup()
	await assert.rejects(
		ctx.simulators.call(
			'launch',
			{ platform: 'ios', id: udid, appId: '$(x)' },
			ctx.run,
		),
		/invalid_request/,
	)
	await assert.rejects(
		ctx.simulators.call('boot', { platform: 'windows', id: udid }, ctx.run),
		/`platform` must be 'ios' or 'android'/,
	)
	await assert.rejects(
		ctx.simulators.call('reboot', {}, ctx.run),
		/Unknown kody\.simulator\.reboot/,
	)
	await assert.rejects(
		ctx.simulators.call(
			'describe',
			{ platform: 'ios', source: 'webkit' },
			ctx.run,
		),
		/`source` must be one of/,
	)
	assert.deepEqual(ctx.authorized, [])
})

test('authorize gets the exact fixed action, the home cwd, and no env keys', async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kody-sim-test-')))
	const app = join(dir, 'Demo.app')
	mkdirSync(app)
	const ctx = setup({
		exec: ({ args }) =>
			args[0] === 'simctl' && args[1] === 'launch'
				? result('com.example.Demo: 4242\n')
				: undefined,
	})
	const cases: Array<[string, Record<string, unknown>, string]> = [
		['boot', { platform: 'ios', id: udid }, `kody.simulator.boot ios ${udid}`],
		[
			'install',
			{ platform: 'ios', id: udid, appPath: app },
			`kody.simulator.install ios ${udid} ${app}`,
		],
		[
			'launch',
			{ platform: 'ios', id: udid, appId: 'com.example.Demo' },
			`kody.simulator.launch ios ${udid} com.example.Demo`,
		],
		[
			'openUrl',
			{
				platform: 'android',
				id: 'emulator-5554',
				url: 'https://example.com/?a=1&b=2',
			},
			'kody.simulator.openUrl android emulator-5554 https://example.com/?a=1&b=2',
		],
		[
			'terminate',
			{ platform: 'android', id: 'emulator-5554', appId: 'org.example.demo' },
			'kody.simulator.terminate android emulator-5554 org.example.demo',
		],
		[
			'describe',
			{ platform: 'ios', id: udid, source: 'nativescript', maxDepth: 3 },
			`kody.simulator.describe ios ${udid} --format agent --source nativescript --max-depth 3`,
		],
		['list', {}, 'kody.simulator.list'],
	]
	for (const [name, args] of cases)
		await ctx.simulators.call(name, args, ctx.run)
	assert.deepEqual(
		ctx.authorized.map((entry) => commandOf(entry).command),
		cases.map(([, , command]) => command),
	)
	for (const entry of ctx.authorized) {
		const start = commandOf(entry)
		assert.match(start.commandId, /^cmd_[\w-]{6,64}$/)
		assert.equal(start.cwd, '/Users/me')
		assert.deepEqual(start.envKeys, [])
		assert.equal(start.background, false)
	}
	assert.equal(ctx.finished.length, cases.length)
	assert.ok(
		ctx.finished.every(
			(entry) => entry.reason === 'exited' && entry.exitCode === 0,
		),
	)
	assert.deepEqual(
		ctx.finished.map((entry) => entry.commandId),
		ctx.authorized.map((entry) => commandOf(entry).commandId),
	)
})

test('tools run with argument vectors, never a shell line', async () => {
	const ctx = setup()
	await ctx.simulators.call(
		'openUrl',
		{ platform: 'android', id: 'emulator-5554', url: "myapp://x?q=it's&b=2" },
		ctx.run,
	)
	await ctx.simulators.call(
		'launch',
		{ platform: 'android', id: 'emulator-5554', appId: 'org.example.demo' },
		ctx.run,
	)
	await ctx.simulators.call(
		'openUrl',
		{ platform: 'ios', id: udid, url: 'https://example.com/' },
		ctx.run,
	)
	assert.deepEqual(ctx.calls, [
		{
			file: allTools.adb,
			args: [
				'-s',
				'emulator-5554',
				'shell',
				'am',
				'start',
				'-a',
				'android.intent.action.VIEW',
				'-d',
				// adb shell hands this to the device's shell: quoted there.
				`'myapp://x?q=it'\\''s&b=2'`,
			],
		},
		{
			file: allTools.adb,
			args: [
				'-s',
				'emulator-5554',
				'shell',
				'monkey',
				'-p',
				'org.example.demo',
				'-c',
				'android.intent.category.LAUNCHER',
				'1',
			],
		},
		{
			file: allTools.xcrun,
			args: ['simctl', 'openurl', udid, 'https://example.com/'],
		},
	])
})

test('list reports iOS simulators, Android devices and AVDs, and SimDeck', async () => {
	const ctx = setup({
		exec: ({ file, args }) => {
			if (file === allTools.xcrun) {
				return result(
					JSON.stringify({
						devices: {
							'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
								{ udid, name: 'iPhone 16', state: 'Booted', dataPath: '/x' },
							],
						},
					}),
				)
			}
			if (args.join(' ') === 'devices -l') {
				return result(
					'List of devices attached\nemulator-5554          device product:sdk_gphone64 model:Pixel_9 transport_id:1\n\n',
				)
			}
			if (args.join(' ') === '-s emulator-5554 emu avd name')
				return result('Pixel_9_API_36\nOK\n')
			if (args[0] === '-list-avds')
				return result('INFO    | noise\nPixel_9_API_36\nns_api36\n')
			return undefined
		},
	})
	assert.deepEqual(await ctx.simulators.call('list', undefined, ctx.run), {
		ios: {
			available: true,
			devices: [
				{ udid, name: 'iPhone 16', runtime: 'iOS 18.2', state: 'Booted' },
			],
		},
		android: {
			adb: true,
			emulator: true,
			devices: [
				{
					serial: 'emulator-5554',
					state: 'device',
					model: 'Pixel_9',
					product: 'sdk_gphone64',
					avd: 'Pixel_9_API_36',
				},
			],
			avds: ['Pixel_9_API_36', 'ns_api36'],
		},
		simdeck: true,
	})

	const bare = setup({
		tools: { xcrun: null, adb: null, emulator: null, simdeck: null },
	})
	assert.deepEqual(await bare.simulators.call('list', undefined, bare.run), {
		ios: { available: false, devices: [] },
		android: { adb: false, emulator: false, devices: [], avds: [] },
		simdeck: false,
	})
})

test('iOS boot treats an already booted simulator as success; failures carry the tool output', async () => {
	const ctx = setup({
		exec: ({ args }) =>
			args[1] === 'boot'
				? result('', {
						exitCode: 149,
						stderr: 'Unable to boot device in current state: Booted',
					})
				: result('', { exitCode: 2, stderr: 'Invalid device: nope' }),
	})
	assert.deepEqual(
		await ctx.simulators.call('boot', { platform: 'ios', id: udid }, ctx.run),
		{
			platform: 'ios',
			id: udid,
			booted: true,
			alreadyBooted: true,
		},
	)
	await assert.rejects(
		ctx.simulators.call(
			'openUrl',
			{ platform: 'ios', id: udid, url: 'https://x.dev' },
			ctx.run,
		),
		/Invalid device: nope[\s\S]*execution_context_simulator_failed/,
	)
	assert.equal(ctx.finished.at(-1)?.exitCode, 1)
})

test('Android boot starts the AVD detached and waits for adb to see it booted', async () => {
	let polls = 0
	const ctx = setup({
		exec: ({ args }) => {
			const line = args.join(' ')
			if (line === '-list-avds') return result('Pixel_9_API_36\n')
			if (line === 'devices -l') {
				polls++
				return result(
					polls < 2
						? 'List of devices attached\n'
						: 'List of devices attached\nemulator-5556 device\n',
				)
			}
			if (line === '-s emulator-5556 emu avd name')
				return result('Pixel_9_API_36\nOK\n')
			if (line.endsWith('getprop sys.boot_completed')) return result('1\n')
			return undefined
		},
	})
	const booted = await ctx.simulators.call(
		'boot',
		{ platform: 'android', id: 'Pixel_9_API_36' },
		ctx.run,
	)
	assert.deepEqual(booted, {
		platform: 'android',
		id: 'Pixel_9_API_36',
		serial: 'emulator-5556',
		booted: true,
		alreadyBooted: false,
	})
	assert.deepEqual(ctx.spawned, [
		{ file: allTools.emulator, args: ['-avd', 'Pixel_9_API_36'] },
	])
	assert.equal(
		commandOf(ctx.authorized[0]).command,
		'kody.simulator.boot android Pixel_9_API_36',
	)

	await assert.rejects(
		ctx.simulators.call(
			'boot',
			{ platform: 'android', id: 'Missing_AVD' },
			ctx.run,
		),
		/No AVD named Missing_AVD/,
	)
	await assert.rejects(
		ctx.simulators.call(
			'boot',
			{ platform: 'android', id: 'bad name' },
			ctx.run,
		),
		/AVD name/,
	)
})

test('screenshot returns a capped base64 PNG with its size', async () => {
	const ctx = setup({ exec: () => result(png) })
	assert.deepEqual(
		await ctx.simulators.call(
			'screenshot',
			{ platform: 'android', id: 'emulator-5554' },
			ctx.run,
		),
		{
			mimeType: 'image/png',
			base64: png.toString('base64'),
			bytes: png.length,
			width: 300,
			height: 600,
		},
	)
	assert.deepEqual(ctx.calls.at(-1)?.args, [
		'-s',
		'emulator-5554',
		'exec-out',
		'screencap',
		'-p',
	])
	const big = setup({
		exec: () => result(png, { overflow: true, exitCode: null }),
	})
	await assert.rejects(
		big.simulators.call(
			'screenshot',
			{ platform: 'android', id: 'emulator-5554' },
			big.run,
		),
		/larger than 8 MB/,
	)

	const ios = setup({
		exec: ({ args }) => {
			writeFileSync(args.at(-1)!, png)
			return result()
		},
	})
	const shot = (await ios.simulators.call(
		'screenshot',
		{ platform: 'ios', id: udid },
		ios.run,
	)) as {
		width: number
	}
	assert.equal(shot.width, 300)
	assert.deepEqual(ios.calls[0]?.args.slice(0, 5), [
		'simctl',
		'io',
		udid,
		'screenshot',
		'--type=png',
	])
})

test('describe and stream need SimDeck; stream never returns its access token', async () => {
	const missing = setup({ tools: { simdeck: null } })
	await assert.rejects(
		missing.simulators.call('describe', { platform: 'ios' }, missing.run),
		/simdeck was not found[\s\S]*execution_context_simulator_tool_missing/,
	)
	await assert.rejects(
		missing.simulators.call('stream', undefined, missing.run),
		/execution_context_simulator_tool_missing/,
	)
	assert.deepEqual(missing.authorized, [])

	const ctx = setup({
		exec: ({ args }) => {
			if (args[0] === 'describe') {
				return result(Buffer.from('x'.repeat(100)), {
					overflow: true,
					exitCode: null,
				})
			}
			if (args.join(' ') === 'service status') {
				return result('', {
					exitCode: 2,
					stderr: "unrecognized subcommand 'status'",
				})
			}
			return result(
				JSON.stringify({
					running: true,
					daemon: {
						httpUrl: 'http://127.0.0.1:4311/?token=secret',
						accessToken: 'secret',
					},
				}),
			)
		},
	})
	assert.deepEqual(
		await ctx.simulators.call('describe', { platform: 'ios' }, ctx.run),
		{
			source: 'auto',
			text: 'x'.repeat(100),
			truncated: true,
		},
	)
	const stream = await ctx.simulators.call('stream', undefined, ctx.run)
	assert.deepEqual(stream, { url: 'http://127.0.0.1:4311', running: true })
	assert.doesNotMatch(JSON.stringify(stream), /secret/)

	const fresh = setup({
		exec: () => result(JSON.stringify({ running: false, service: null })),
	})
	assert.deepEqual(
		await fresh.simulators.call('stream', undefined, fresh.run),
		{
			url: 'http://127.0.0.1:4310',
			running: false,
		},
	)
})

test('stream reuses a healthy SimDeck and only starts it in the background', async () => {
	const healthy = setup({ probeSimDeck: async () => 4310 })
	assert.deepEqual(
		await healthy.simulators.call('stream', { start: true }, healthy.run),
		{ url: 'http://127.0.0.1:4310', running: true },
	)
	assert.deepEqual(healthy.calls, [])
	assert.equal(
		(healthy.authorized[0] as { command: string }).command,
		'kody.simulator.stream start',
	)

	let up = false
	const cold = setup({
		probeSimDeck: async () => (up ? 4312 : null),
		exec: ({ args }) => {
			if (args.join(' ') === 'service start')
				return result('', {
					exitCode: 2,
					stderr: "unrecognized subcommand 'start'",
				})
			if (args.join(' ') === 'daemon start') {
				up = true
				return result('started')
			}
			return result(JSON.stringify({ running: false }))
		},
	})
	assert.deepEqual(
		await cold.simulators.call('stream', { start: true }, cold.run),
		{ url: 'http://127.0.0.1:4312', running: true },
	)
	assert.deepEqual(
		cold.calls.map((c) => c.args.join(' ')),
		['service start', 'daemon start'],
	)
	assert.ok(
		cold.calls.every((c) => !c.args.some((a) => /^[0-9A-F-]{36}$/i.test(a))),
		'never passes a device to bare simdeck',
	)
})

test('stream with a simulator id opens the viewer on that simulator', async () => {
	const udid = '784FDD63-8E46-49AE-855A-FB0A7D860476'
	const ctx = setup({ probeSimDeck: async () => 4310 })
	assert.deepEqual(
		await ctx.simulators.call('stream', { start: true, id: udid }, ctx.run),
		{ url: `http://127.0.0.1:4310/?device=${udid}`, running: true },
	)
	assert.equal(
		(ctx.authorized[0] as { command: string }).command,
		`kody.simulator.stream start ${udid}`,
	)
	await assert.rejects(
		ctx.simulators.call('stream', { id: 'not a udid' }, ctx.run),
		/not a simulator UDID/,
	)
})

test('a timed out tool reports timed_out to the audit log', async () => {
	const ctx = setup({
		exec: () => result('', { exitCode: null, timedOut: true }),
	})
	await assert.rejects(
		ctx.simulators.call(
			'install',
			{
				platform: 'ios',
				id: udid,
				appPath: realpathSync(mkdtempSync(join(tmpdir(), 'x-'))),
			},
			ctx.run,
		),
		/not a \.app bundle/,
	)
	await assert.rejects(
		ctx.simulators.call('shutdown', { platform: 'ios', id: udid }, ctx.run),
		/timed out/,
	)
	assert.equal(ctx.finished.at(-1)?.reason, 'timed_out')
	assert.equal(ctx.finished.at(-1)?.exitCode, null)
})

test('tool lookup falls back to the Android SDK folders', async () => {
	const home = realpathSync(mkdtempSync(join(tmpdir(), 'kody-sim-home-')))
	const tools = join(home, 'Library/Android/sdk/platform-tools')
	mkdirSync(tools, { recursive: true })
	writeFileSync(join(tools, 'adb'), '#!/bin/sh\n', { mode: 0o755 })
	const found = await resolveSimulatorTools({ PATH: '' }, 'darwin', home)
	assert.equal(found.adb, join(tools, 'adb'))
	assert.equal(found.emulator, null)
	assert.equal(found.simdeck, null)
})

test('the simulators opt-in lives in the local policy and survives other policy edits', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'kody-sim-policy-'))
	const policyPath = join(dir, 'policy.json')
	assert.equal(await readLocalSimulatorsEnabled(policyPath), false)
	await setLocalSimulatorsEnabled({ enabled: true, policyPath })
	await setLocalCommandsEnabled({ enabled: true, policyPath })
	await allowLocalPath({ path: realpathSync(dir), mode: 'ro', policyPath })
	assert.equal(await readLocalSimulatorsEnabled(policyPath), true)
	const policy = await readLocalPolicy(policyPath)
	assert.equal(policy.simulators?.enabled, true)
	assert.equal(typeof policy.simulators?.changedAt, 'string')
	writeFileSync(
		policyPath,
		JSON.stringify({ version: 1, fs: [], simulators: { enabled: 'yes' } }),
	)
	await assert.rejects(
		readLocalPolicy(policyPath),
		/invalid "simulators" entry/,
	)
})

test('kody context simulators on, off, and status write the local policy', async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'kody-sim-cli-')))
	const saved = {
		XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
		HOME: process.env.HOME,
		APPDATA: process.env.APPDATA,
	}
	process.env.XDG_CONFIG_HOME = join(root, 'xdg')
	process.env.HOME = join(root, 'home')
	process.env.APPDATA = join(root, 'appdata')
	try {
		const run = async (positionals: Array<string>, values = {}) => {
			let text = ''
			const code = await runExecutionContextCommand({
				command: 'context',
				positionals: ['simulators', ...positionals],
				values,
				apiUrl: 'https://api.kody.test',
				token: async () => 'unused',
				clientVersion: '0.0.0',
				write: (chunk) => {
					text += chunk
				},
			})
			assert.equal(code, 0)
			return text
		}
		assert.match(
			await run([]),
			/Simulator control on this machine: off[\s\S]*kody context simulators on/,
		)
		assert.match(
			await run(['on']),
			/Simulator control on this machine: on[\s\S]*kody context commands on/,
		)
		assert.deepEqual(
			JSON.parse(await run(['status'], { json: true })).local.enabled,
			true,
		)
		assert.match(await run(['off']), /: off/)
		assert.equal(await readLocalSimulatorsEnabled(), false)
		await assert.rejects(run(['maybe']), /Usage: kody context simulators/)
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
	}
})

test('package-bound kody in an older origin shim passes kody.simulator through as a namespace', async () => {
	const { passContextNamespaces } =
		await import('../src/local-package-graph.ts')
	const shim =
		'get(_t, property) {\n\t\t\tif (property === "mcp" || property === "command") return kody[property];\n\t\t}'
	assert.match(
		passContextNamespaces(shim),
		/property === "command" \|\| property === "simulator"\) return kody\[property\]/,
	)
	const current = passContextNamespaces(shim)
	assert.equal(passContextNamespaces(current), current)
})
