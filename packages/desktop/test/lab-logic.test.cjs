const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
	approvalNotifications,
	quickResults,
	resultAction,
	shortcutsFor,
	summaryNotifications,
} = require('../lab-logic.cjs')

const pr = (number, overrides = {}) => ({
	number,
	title: `PR ${number}`,
	author: 'someone',
	draft: false,
	ci: 'passing',
	approvableRuns: 0,
	risk: { score: 30, level: 'moderate' },
	critical: false,
	criticalReason: null,
	areas: ['core'],
	...overrides,
})
const summary = (prs, sessions = []) => ({
	prs,
	sessions,
	fetchedAt: '2026-11-10T22:00:00Z',
})

test('shortcuts avoid Option-Space off macOS', () => {
	assert.equal(shortcutsFor('darwin').quick, 'Alt+Space')
	assert.equal(shortcutsFor('win32').quick, 'Control+Alt+Space')
	assert.equal(shortcutsFor('linux').review, 'Control+Alt+R')
})

test('an empty query lists views, then PRs awaiting approval before the newest', () => {
	const items = quickResults(
		summary([
			pr(3),
			pr(2, { ci: 'awaiting-approval', approvableRuns: 4 }),
			pr(1),
		]),
		'',
	)
	assert.deepEqual(
		items.slice(0, 4).map((i) => i.id),
		['view:awaiting', 'view:untested', 'view:critical', 'view:risk'],
	)
	assert.equal(items[0].title, 'Workflows awaiting approval (1)')
	assert.deepEqual(
		items.slice(4).map((i) => i.id),
		['pr:2', 'pr:3', 'pr:1'],
	)
})

test('a PR number offers review first, even before the snapshot has it', () => {
	const items = quickResults(summary([pr(11573)]), '#11573')
	assert.equal(items[0].id, 'review:11573')
	assert.match(items[0].title, /PR 11573/)
	assert.equal(items[1].id, 'pr:11573')
	assert.equal(quickResults(null, '42')[0].id, 'review:42')
})

test('words match title, author, area and CI state together', () => {
	const prs = [
		pr(1, { title: 'fix(vite): hmr', areas: ['vite'] }),
		pr(2, { title: 'fix(core): layout', ci: 'failing' }),
	]
	assert.deepEqual(
		quickResults(summary(prs), 'fix failing')
			.filter((i) => i.id.startsWith('pr:'))
			.map((i) => i.id),
		['pr:2'],
	)
	assert.deepEqual(
		quickResults(summary(prs), 'vite')
			.filter((i) => i.id.startsWith('pr:'))
			.map((i) => i.id),
		['pr:1'],
	)
})

test('pending Kody approvals add a command', () => {
	const items = quickResults(summary([]), '', [
		{ key: 'a', title: 'Publish @x/y' },
	])
	assert.ok(
		items.some((i) => i.id === 'kody:approvals' && i.title.includes('(1)')),
	)
})

test('result ids map to actions and reject anything else', () => {
	assert.deepEqual(resultAction('review:12'), { type: 'review', number: 12 })
	assert.deepEqual(resultAction('pr:12'), {
		type: 'dashboard',
		path: '/?pr=12',
	})
	assert.deepEqual(resultAction('view:critical'), {
		type: 'dashboard',
		path: '/?critical=true',
	})
	assert.deepEqual(resultAction('kody:approvals'), {
		type: 'kody',
		path: '/account',
	})
	assert.equal(resultAction('review:0'), null)
	assert.equal(resultAction('view:../../etc'), null)
	assert.equal(resultAction('open:https://example.com'), null)
})

test('no notifications on the first summary', () => {
	assert.deepEqual(
		summaryNotifications(null, summary([pr(1, { ci: 'awaiting-approval' })])),
		[],
	)
})

test('notifies new approvals, new critical PRs, and CI turning red', () => {
	const before = summary([pr(1), pr(2), pr(3)])
	const after = summary([
		pr(1, { ci: 'awaiting-approval', approvableRuns: 2 }),
		pr(2, { critical: true, criticalReason: 'Bundler change' }),
		pr(3, { ci: 'failing' }),
		pr(4, { ci: 'failing' }),
	])
	const notes = summaryNotifications(before, after)
	assert.deepEqual(
		notes.map((n) => n.title),
		['#1 needs workflow approval', 'Critical PR #2', 'CI failing on #3'],
	)
	assert.match(notes[1].body, /Bundler change/)
})

test('unchanged state does not notify again', () => {
	const state = summary([
		pr(1, { ci: 'awaiting-approval' }),
		pr(2, { critical: true }),
	])
	assert.deepEqual(summaryNotifications(state, state), [])
})

test('toolbox session transitions notify once', () => {
	const s = (state, extra = {}) => ({
		id: 'x',
		number: 7,
		platform: 'ios',
		state,
		...extra,
	})
	assert.deepEqual(
		summaryNotifications(
			summary([], [s('queued')]),
			summary([], [s('running')]),
		).map((n) => n.title),
		['Building #7 for ios'],
	)
	assert.deepEqual(
		summaryNotifications(
			summary([], [s('running')]),
			summary([], [s('failed', { error: 'boom' })]),
		).map((n) => n.body),
		['boom'],
	)
	assert.deepEqual(
		summaryNotifications(
			summary([], [s('running')]),
			summary([], [s('running')]),
		),
		[],
	)
})

test('caps a burst of notifications with a summary line', () => {
	const before = summary(Array.from({ length: 8 }, (_, i) => pr(i + 1)))
	const after = summary(
		Array.from({ length: 8 }, (_, i) => pr(i + 1, { critical: true })),
	)
	const notes = summaryNotifications(before, after)
	assert.equal(notes.length, 6)
	assert.equal(notes[5].title, '3 more PR updates')
})

test('approval notifications only for keys not seen before', () => {
	assert.deepEqual(approvalNotifications(null, [{ key: 'a', title: 'A' }]), [])
	assert.deepEqual(
		approvalNotifications(
			[{ key: 'a', title: 'A' }],
			[
				{ key: 'a', title: 'A' },
				{ key: 'b', title: 'B' },
			],
		).map((n) => n.body),
		['B'],
	)
})
