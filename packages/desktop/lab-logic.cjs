// Pure logic behind the lab surfaces, kept free of Electron so it can be unit tested.

const CI_TAGS = {
	'awaiting-approval': { text: 'Awaiting approval', tone: 'amber' },
	'not-run': { text: 'Tests not run' },
	running: { text: 'Running' },
	failing: { text: 'Failing', tone: 'red' },
	passing: { text: 'Passing', tone: 'green' },
}

const VIEWS = {
	awaiting: '/?ci=awaiting-approval',
	untested: '/?ci=untested',
	critical: '/?critical=true',
	risk: '/?sort=risk-desc',
	all: '/',
}

// Option-Space opens the window menu on Windows and is commonly taken by launchers on Linux desktops.
function shortcutsFor(platform) {
	return platform === 'darwin'
		? { quick: 'Alt+Space', review: 'Alt+Shift+R' }
		: { quick: 'Control+Alt+Space', review: 'Control+Alt+R' }
}

function prItem(pr) {
	return {
		id: `pr:${pr.number}`,
		reviewId: `review:${pr.number}`,
		icon: pr.critical ? '◆' : '⇄',
		title: `#${pr.number} ${pr.title}`,
		subtitle: `${pr.author} · ${pr.areas.slice(0, 3).join(', ')} · risk ${pr.risk.score} (${pr.risk.level})`,
		tags: [
			CI_TAGS[pr.ci],
			...(pr.critical ? [{ text: 'Critical', tone: 'purple' }] : []),
		].filter(Boolean),
	}
}

/** Quick panel results for the typed text against the dashboard summary (null while it loads). */
function quickResults(summary, text, approvals = []) {
	const query = String(text ?? '')
		.trim()
		.toLowerCase()
	const prs = summary?.prs ?? []
	const items = []
	const number = Number(query.replace(/^#/, ''))
	const isNumber = Number.isSafeInteger(number) && number > 0
	if (isNumber) {
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
		...(approvals.length
			? [
					{
						id: 'kody:approvals',
						icon: '✓',
						title: `Kody approvals waiting (${approvals.length})`,
						subtitle: approvals
							.slice(0, 2)
							.map((a) => a.title)
							.join(' · '),
						keywords: 'kody approvals publish credential',
					},
				]
			: []),
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
			id: 'kody:home',
			icon: 'K',
			title: 'Open Kody',
			keywords: 'kody home account',
		},
	]
	if (!query) {
		items.push(...commands.slice(0, approvals.length ? 5 : 4))
		items.push(...awaiting.slice(0, 3).map(prItem))
		items.push(
			...prs
				.filter((p) => !awaiting.includes(p))
				.slice(0, 5)
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
				.filter((p) => !(isNumber && p.number === number))
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
	return items.slice(0, 14)
}

/** What a quick panel result id does, without side effects. */
function resultAction(id) {
	const [kind, value] = String(id).split(':')
	const number = Number(value)
	if (kind === 'review' && Number.isSafeInteger(number) && number > 0)
		return { type: 'review', number }
	if (kind === 'pr' && Number.isSafeInteger(number) && number > 0)
		return { type: 'dashboard', path: `/?pr=${number}` }
	if (kind === 'view' && VIEWS[value])
		return { type: 'dashboard', path: VIEWS[value] }
	if (kind === 'sync') return { type: 'sync' }
	if (kind === 'kody' && value === 'approvals')
		return { type: 'kody', path: '/account' }
	if (kind === 'kody') return { type: 'kody' }
	return null
}

/** Notifications for what changed between two dashboard summaries, most important first, at most `limit`. */
function summaryNotifications(before, after, limit = 5) {
	if (!before || !after) return []
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
	const oldSessions = new Map((before.sessions ?? []).map((s) => [s.id, s]))
	for (const session of after.sessions ?? []) {
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
	if (notes.length <= limit) return notes
	return [
		...notes.slice(0, limit),
		{
			title: `${notes.length - limit} more PR updates`,
			body: 'Open NativeScript PRs to see them.',
		},
	]
}

/** Notifications for Kody approvals that appeared since the last poll. */
function approvalNotifications(before, after) {
	if (!before) return []
	const seen = new Set(before.map((a) => a.key))
	return after
		.filter((a) => !seen.has(a.key))
		.slice(0, 3)
		.map((a) => ({ title: 'Kody approval waiting', body: a.title, kody: true }))
}

module.exports = {
	shortcutsFor,
	quickResults,
	resultAction,
	summaryNotifications,
	approvalNotifications,
	VIEWS,
}
