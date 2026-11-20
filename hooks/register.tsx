import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  PrRef,
  PrSource,
  PrStatus,
  PrTarget,
  Reviewer,
  ReviewerState,
  PaneSession,
  PluginVersion,
  WorkflowRun,
} from '../types'
import { contextColor, costTips, cacheHitRate, kTokens, usd } from './cost'
import {
  QUERY,
  ago,
  buildStatus,
  checkCounts,
  fill,
  findGhPrNumber,
  findRef,
  hasOpening,
  openingRef,
  parseRuns,
  refText,
  sameRef,
  sinceText,
  stamp,
} from './pr'
import type { GqlAnswer } from './pr'
import { githubRepo, installedVersion, pluginsDir, short } from './version'

const PANE = 'pr-status'

// Bump a tag when the shape of its value changes: older values read as initial.
const target = atom({ plugin: 'pr-status', key: 'target' } as const, null, {
  shape: 'target-2',
})
const status = atom({ plugin: 'pr-status', key: 'status' } as const, null, {
  shape: 'status-6',
})
const error = atom({ plugin: 'pr-status', key: 'error' } as const, null)
const busy = atom({ plugin: 'pr-status', key: 'busy' } as const, null)
const origin = atom({ plugin: 'pr-status', key: 'origin' } as const, null, {
  shape: 'origin-1',
})
const session = atom({ plugin: 'pr-status', key: 'session' } as const, null, {
  shape: 'session-1',
})
const mergeAgent = atom({ plugin: 'pr-status', key: 'mergeAgent' } as const, null)
const addressAgent = atom({ plugin: 'pr-status', key: 'addressAgent' } as const, null)
const afterMerge = atom({ plugin: 'pr-status', key: 'afterMerge' } as const, null, {
  shape: 'after-merge-1',
})

type Options = {
  pollSeconds?: number
  reviewCommand?: string
  addressPrompt?: string
  mergePrompt?: string
  mergeModel?: string
  addressModel?: string
  cacheTtlMinutes?: number
}

// A source replaces the followed PR only when it ranks at least as high.
const RANK: Record<PrSource, number> = {
  tool: 0,
  branch: 1,
  prompt: 2,
  session: 3,
  created: 4,
  manual: 5,
}

// Bots can't be asked through the reviewers API (they are no collaborators);
// these re-review when the PR gets this comment.
const BOT_REREVIEW: Record<string, string> = {
  coderabbitai: '@coderabbitai review',
}

const canRerequest = (r: Reviewer) => !r.isBot || r.login in BOT_REREVIEW

const STATE_TEXT: Record<ReviewerState, string> = {
  'not-reviewed': 'not reviewed',
  commented: 'commented',
  'changes-requested': 'changes requested',
  approved: 'approved',
  'lost-approval': 'lost approval',
}

const STATE_COLOR: Record<ReviewerState, string | undefined> = {
  'not-reviewed': undefined,
  commented: 'suggestion',
  'changes-requested': 'error',
  approved: 'success',
  'lost-approval': 'warning',
}

let options: Options = {}
let timer: { cancel: () => void } | undefined
let inflight: Promise<void> | undefined

async function gh($: EngineInterface, args: string[]) {
  const cwd = await $.session.cwd()
  const out = await $.process.run(['gh', ...args], { cwd, timeoutMs: 30_000 })
  if (out.exitCode !== 0) {
    throw new Error((out.stderr || out.stdout).trim().split('\n')[0] || `gh exited ${out.exitCode}`)
  }
  return out.stdout
}

/** `gh pr view [n]` in the session's cwd, as a full reference. */
async function resolveInCwd($: EngineInterface, num?: number, repo?: string) {
  const args = ['pr', 'view']
  if (num !== undefined) args.push(String(num))
  if (repo) args.push('-R', repo)
  args.push('--json', 'url', '-q', '.url')
  try {
    return findRef(await gh($, args))
  } catch {
    return null
  }
}

/** The pane's title: the PR number, and MERGED or CLOSED once it is no longer open. */
function paneTitle(ref: PrRef, state?: string) {
  if (state === 'MERGED') return `PR #${ref.number} - MERGED`
  if (state === 'CLOSED') return `PR #${ref.number} - CLOSED`
  return `PR #${ref.number}`
}

function openPane($: EngineInterface, ref: PrRef, state?: string) {
  void $.ui.open({ id: PANE, title: paneTitle(ref, state) }).catch(() => undefined)
}

/** Retitles the pane when it is open; never reopens one the person closed. */
async function retitle($: EngineInterface, ref: PrRef, state: string) {
  const title = paneTitle(ref, state)
  const pane = (await $.ui.panes()).find(p => p.id === PANE)
  if (pane && pane.title !== title) await $.ui.open({ id: PANE, title })
}

const closedText = (s: PrStatus) =>
  s.state === 'MERGED'
    ? `${refText(s.ref)} was merged into ${s.baseRef}${s.mergedBy ? ` by ${s.mergedBy}` : ''}`
    : `${refText(s.ref)} was closed without merging`

async function fetchStatus($: EngineInterface, ref: PrRef): Promise<PrStatus> {
  const raw = await gh($, [
    'api', 'graphql',
    '-F', `owner=${ref.owner}`,
    '-F', `name=${ref.repo}`,
    '-F', `number=${ref.number}`,
    '-f', `query=${QUERY}`,
  ])
  const answer = JSON.parse(raw) as GqlAnswer
  const pr = answer.data?.repository?.pullRequest
  let behindBy: number | null = null
  if (pr && pr.state === 'OPEN') {
    try {
      const cmp = await gh($, [
        'api',
        `repos/${ref.owner}/${ref.repo}/compare/${encodeURIComponent(pr.baseRefName)}...${pr.headRefOid}`,
        '-q', '.behind_by',
      ])
      behindBy = Number(cmp.trim())
      if (!Number.isFinite(behindBy)) behindBy = null
    } catch {
      behindBy = null
    }
  }
  let runs: WorkflowRun[] = []
  if (pr && pr.state === 'OPEN') {
    const counts = checkCounts(pr)
    if (counts.failed > 0 || counts.pending > 0) {
      try {
        runs = parseRuns(
          await gh($, [
            'run', 'list',
            '-R', `${ref.owner}/${ref.repo}`,
            '--commit', pr.headRefOid,
            '--limit', '100',
            '--json', 'databaseId,workflowName,status,conclusion,url',
          ]),
        )
      } catch {
        runs = []
      }
    }
  }
  return buildStatus(ref, answer, behindBy, await $.clock.now(), runs)
}

let openingRead = false

/**
 * Reads the PR the conversation opened with, once there is an opening, and
 * follows it unless a stronger source holds the pane.
 */
async function readOpening($: EngineInterface) {
  if (openingRead) return
  let ref = await read($, origin)
  if (ref === null) {
    const messages = await $.session.messages()
    if (!hasOpening(messages)) return
    ref = openingRef(messages)
    if (ref) {
      const found = ref
      await update($, origin, () => found)
    }
  }
  openingRead = true
  if (ref) await setTarget($, ref, 'session')
}

async function doRefresh($: EngineInterface) {
  void refreshSession($)
  await readOpening($).catch(() => undefined)
  let t = await read($, target)
  // The branch's PR outranks only a PR a tool call happened to touch.
  if (t === null || RANK[t.source] <= RANK.branch) {
    const ref = await resolveInCwd($)
    if (ref === null) {
      if (t?.source === 'branch') {
        await update($, target, () => null)
        await update($, status, () => null)
        return
      }
    } else if (!sameRef(ref, t?.ref)) {
      const next: PrTarget = { ref, source: 'branch' }
      await update($, target, () => next)
      await update($, status, () => null)
      openPane($, ref)
      t = next
    }
  }
  if (t === null) return
  const want = t.ref
  try {
    const s = await fetchStatus($, want)
    // The target may have moved while we fetched.
    const now = await read($, target)
    if (!sameRef(now?.ref, want)) return
    const before = await read($, status)
    await update($, status, () => s)
    await update($, error, () => null)
    if (before && sameRef(before.ref, want) && before.state === 'OPEN' && s.state !== 'OPEN') {
      // Seen going from open to merged or closed: say so, and bring the pane up.
      $.ui.toast(closedText(s))
      openPane($, want, s.state)
    } else {
      await retitle($, want, s.state).catch(() => undefined)
    }
  } catch (err) {
    await update($, error, () => (err instanceof Error ? err.message : String(err)))
  }
}

function refresh($: EngineInterface): Promise<void> {
  if (!inflight) {
    // Fire-and-forget callers never see a failure; the pane shows `error`.
    inflight = doRefresh($).catch(() => undefined).finally(() => {
      inflight = undefined
    })
  }
  return inflight
}

async function setTarget($: EngineInterface, ref: PrRef, source: PrSource) {
  const cur = await read($, target)
  if (cur && RANK[source] < RANK[cur.source]) return
  if (sameRef(cur?.ref, ref)) {
    if (cur && cur.source !== source) await update($, target, () => ({ ref, source }))
    return
  }
  await update($, target, () => ({ ref, source }))
  await update($, status, () => null)
  await update($, error, () => null)
  openPane($, ref)
  void refresh($)
}

async function detectIn($: EngineInterface, text: string | undefined, source: PrSource) {
  if (!text) return
  const ref = findRef(text)
  if (ref) return setTarget($, ref, source)
  const cmd = findGhPrNumber(text)
  if (cmd) {
    const [owner = '', repo = ''] = (cmd.repo ?? '').split('/')
    const resolved: PrRef | null = cmd.repo
      ? { owner, repo, number: cmd.number }
      : await resolveInCwd($, cmd.number)
    if (resolved) await setTarget($, resolved, source)
  }
}

// ---- session context and cost ------------------------------------------------

async function refreshSession($: EngineInterface, turn?: { usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } }) {
  try {
    const [u, model, now] = await Promise.all([$.session.usage(), $.session.model(), $.clock.now()])
    await update($, session, (prev: PaneSession | null): PaneSession => {
      const next: PaneSession = {
        tokens: u.context.tokens,
        window: u.context.window,
        costUsd: (u.cost?.usd ?? 0),
        model,
        isRunning: turn ? false : (prev?.isRunning ?? false),
        lastTurn: prev?.lastTurn,
      }
      if (turn) {
        const t = turn.usage
        next.lastTurn = {
          at: now,
          costUsd: prev && prev.turnStartUsd !== undefined ? (u.cost?.usd ?? 0) - prev.turnStartUsd : null,
          input: t?.input_tokens ?? 0,
          cacheRead: t?.cache_read_input_tokens ?? 0,
          cacheWrite: t?.cache_creation_input_tokens ?? 0,
          output: t?.output_tokens ?? 0,
        }
      } else if (prev?.turnStartUsd !== undefined) {
        next.turnStartUsd = prev.turnStartUsd
      }
      return next
    })
  } catch {
    // The Session section is best effort.
  }
}

async function turnStarted($: EngineInterface) {
  try {
    const u = await $.session.usage()
    await update($, session, (prev: PaneSession | null): PaneSession | null =>
      prev ? { ...prev, isRunning: true, turnStartUsd: (u.cost?.usd ?? 0) } : prev,
    )
  } catch {
    // best effort
  }
}

// ---- the plugin's own version ----------------------------------------------

async function run($: EngineInterface, argv: string[]) {
  const out = await $.process.run(argv, { cwd: $.plugin.root, timeoutMs: 15_000 })
  if (out.exitCode !== 0) throw new Error(`${argv[0]} exited ${out.exitCode}`)
  return out.stdout.trim()
}

/**
 * The commit this plugin runs: git's for a checkout loaded with --plugin-dir,
 * else the one installed_plugins.json recorded; and the newest on GitHub.
 */
// Not in $.state: it is read again at every session start, and a second
// writer of the plugin's state beside a refresh lost the refresh's write.
let pluginVersion: PluginVersion | null = null

async function readVersion($: EngineInterface) {
  const root = $.plugin.root
  let found: PluginVersion | null = null
  let repo: string | null = null
  try {
    const commit = await run($, ['git', '-C', root, 'rev-parse', 'HEAD'])
    // A checkout's own top level, not a repository the plugin folder sits in.
    const top = await run($, ['git', '-C', root, 'rev-parse', '--show-toplevel'])
    if (commit && top.replace(/\/$/, '') === root.replace(/\/$/, '')) {
      const dirty = await run($, ['git', '-C', root, 'status', '--porcelain']).catch(() => '')
      found = { commit, source: 'git', isDirty: dirty !== '', latest: null }
      repo = githubRepo(await run($, ['git', '-C', root, 'remote', 'get-url', 'origin']).catch(() => ''))
    }
  } catch {
    // not a checkout
  }
  if (!found) {
    const dir = pluginsDir(root)
    if (dir) {
      try {
        const installed = await $.fs.read(`${dir}/installed_plugins.json`)
        const known = await $.fs.read(`${dir}/known_marketplaces.json`).catch(() => null)
        const rec = installedVersion(root, String(installed), known === null ? null : String(known))
        if (rec) {
          found = { commit: rec.commit, source: 'installed', isDirty: false, latest: null }
          repo = rec.repo
        }
      } catch {
        // no install record
      }
    }
  }
  if (found && repo) {
    try {
      found.latest = (await gh($, ['api', `repos/${repo}/commits/HEAD`, '--jq', '.sha'])).trim() || null
    } catch {
      // offline or no access
    }
  }
  pluginVersion = found
  $.ui.invalidate('ui.render')
}

// ---- merging the base branch on a cheaper model ------------------------------

/**
 * Starts the merge subagent: `tracked` once it runs and its end is awaited,
 * `untracked` when a hook answered the spawn, `failed` when none started.
 */
async function mergeBase($: EngineInterface, s: PrStatus): Promise<'tracked' | 'untracked' | 'failed'> {
  if (await read($, mergeAgent)) return 'failed'
  const model = options.mergeModel || 'sonnet'
  await update($, busy, () => `merging ${s.baseRef} into ${s.headRef} on ${model}`)
  try {
    const r = await $.agent.spawn({
      prompt: fill(options.mergePrompt ?? '', { url: s.url, base: s.baseRef, head: s.headRef }),
      description: `Merge ${s.baseRef} into ${s.headRef}`,
      model,
    })
    if (r.deny !== undefined) throw new Error(r.deny)
    const id = r.agentId
    if (!id) {
      // A hook answered for the spawn: nothing of ours to follow.
      await update($, busy, () => null)
      $.ui.toast(`Merging ${s.baseRef} into ${s.headRef} on ${r.model}`)
      return 'untracked'
    }
    await update($, mergeAgent, () => id)
    return 'tracked'
  } catch (err) {
    await update($, busy, () => null)
    $.ui.toast(`Could not start the merge: ${err instanceof Error ? err.message : err}`)
    return 'failed'
  }
}

// ---- addressing review remarks in a clean agent ----------------------------

/**
 * Addresses open review threads in a subagent of its own: a fresh context
 * holding only the task, not the session's conversation, so its many turns
 * do not each read that conversation again. A branch not known to be up to
 * date gets the base merged first, by the merge subagent.
 */
async function addressRemarks($: EngineInterface, s: PrStatus, count: number, by?: string) {
  if ((await read($, mergeAgent)) || (await read($, addressAgent))) return
  const task = {
    prompt:
      fill(options.addressPrompt ?? '', { url: s.url, count, base: s.baseRef, head: s.headRef }) +
      (by ? ` Only address the threads that ${by} started.` : ''),
    count,
  }
  if (s.merge !== 'up-to-date') {
    await update($, afterMerge, () => task)
    const started = await mergeBase($, s)
    if (started === 'tracked') return
    await update($, afterMerge, () => null)
    if (started === 'failed') return
  }
  await spawnAddress($, task)
}

async function spawnAddress($: EngineInterface, task: { prompt: string; count: number }) {
  const what = `${task.count} review remark${task.count === 1 ? '' : 's'}`
  await update($, busy, () => `addressing ${what} in a subagent`)
  try {
    const r = await $.agent.spawn({
      prompt: task.prompt,
      description: `Address ${what}`,
      ...(options.addressModel ? { model: options.addressModel } : {}),
    })
    if (r.deny !== undefined) throw new Error(r.deny)
    const id = r.agentId
    if (!id) {
      await update($, busy, () => null)
      $.ui.toast(`Addressing ${what} in a subagent`)
      return
    }
    await update($, addressAgent, () => id)
  } catch (err) {
    await update($, busy, () => null)
    $.ui.toast(`Could not start addressing the remarks: ${err instanceof Error ? err.message : err}`)
  }
}

/** Runs a prompt or, for a leading `/name`, that slash command. */
async function send($: EngineInterface, text: string) {
  const m = /^\/([\w:.-]+)\s*([\s\S]*)$/.exec(text.trim())
  if (m) {
    const name = m[1] ?? ''
    const names = (await $.command.list()).map(c => c.name)
    if (names.includes(name)) {
      void $.command.run({ command: name, args: m[2] ?? '' }).catch(err =>
        $.ui.toast(`pr-status: /${name} failed: ${err instanceof Error ? err.message : err}`),
      )
      return
    }
  }
  void $.prompt.submit({ text, asUser: true })
}

async function rerunFailed($: EngineInterface, s: PrStatus) {
  const failed = s.runs.filter(r => r.state === 'failed')
  await update($, busy, () => `re-running ${failed.length} failed workflow run${failed.length === 1 ? '' : 's'}`)
  const errors: string[] = []
  for (const r of failed) {
    try {
      await gh($, ['run', 'rerun', String(r.id), '--failed', '-R', `${s.ref.owner}/${s.ref.repo}`])
    } catch (err) {
      errors.push(`${r.name}: ${err instanceof Error ? err.message : err}`)
    }
  }
  await update($, busy, () => null)
  $.ui.toast(
    errors.length === 0
      ? `Re-running the failed jobs of ${failed.map(r => r.name).join(', ')}`
      : `Could not re-run ${errors.join('; ')}`,
  )
  await refresh($)
}

async function rerequest($: EngineInterface, s: PrStatus, r: Reviewer) {
  await update($, busy, () => `re-requesting ${r.login}`)
  try {
    const comment = BOT_REREVIEW[r.login]
    if (comment) {
      await gh($, [
        'pr', 'comment', String(s.ref.number),
        '-R', `${s.ref.owner}/${s.ref.repo}`,
        '--body', comment,
      ])
    } else {
      const field = r.isTeam ? 'team_reviewers[]' : 'reviewers[]'
      await gh($, [
        'api', '-X', 'POST',
        `repos/${s.ref.owner}/${s.ref.repo}/pulls/${s.ref.number}/requested_reviewers`,
        '-f', `${field}=${r.login}`,
      ])
    }
    $.ui.toast(`Review requested again from ${r.login}`)
  } catch (err) {
    $.ui.toast(`Could not re-request ${r.login}: ${err instanceof Error ? err.message : err}`)
  } finally {
    await update($, busy, () => null)
  }
  await refresh($)
}

export const register: Register = (on, rawOptions) => {
  options = (rawOptions ?? {}) as Options
  const pollMs = Math.max(15, Number(options.pollSeconds) || 60) * 1000

  // ---- events ----------------------------------------------------------------

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pr-status',
      description: 'PR status pane: open, set the PR (URL, owner/repo#N, number), "auto" or "refresh"',
      argumentHint: '[url | owner/repo#N | N | auto | refresh]',
    })
    timer?.cancel()
    timer = $.clock.every(pollMs, () => void refresh($))
    void refresh($)
    void readVersion($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'pr-status' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'auto') {
      await update($, target, () => null)
      await update($, status, () => null)
      openingRead = false
      await refresh($)
      const t = await read($, target)
      if (t) openPane($, t.ref, (await read($, status))?.state)
      if (!t) return { text: 'no PR in the conversation\'s opening or for the current branch.' }
      return {
        text: t.source === 'session'
          ? `following ${refText(t.ref)}, the PR the conversation opened with.`
          : `following the branch PR ${refText(t.ref)}.`,
      }
    }
    if (arg && arg !== 'refresh') {
      let ref = findRef(arg)
      if (!ref && /^#?\d+$/.test(arg)) ref = await resolveInCwd($, Number(arg.replace('#', '')))
      if (!ref) return { text: `could not find a PR for "${arg}".` }
      await setTarget($, ref, 'manual')
      openPane($, ref)
      return { text: `pinned to ${refText(ref)}.` }
    }
    await Promise.all([refresh($), arg === 'refresh' ? readVersion($).catch(() => undefined) : undefined])
    const t = await read($, target)
    if (!t) return { text: 'no PR for the current branch. Pass a URL or number.' }
    const s = await read($, status)
    await $.ui.open({ id: PANE, title: paneTitle(t.ref, sameRef(s?.ref, t.ref) ? s?.state : undefined) })
    return { text: `${refText(t.ref)}.` }
  })

  on('prompt.submit', async ($, e, next) => {
    // The first prompt is the conversation's opening; later ones only name a PR.
    void (async () => {
      await readOpening($)
      await detectIn($, [e.text, e.command?.args].filter(Boolean).join(' '), 'prompt')
    })().catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    try {
      if (e.tool === 'Bash') {
        const cmd = e.command
        if (/\bgh\s+pr\s+create\b/.test(cmd) && ran.text) await detectIn($, ran.text, 'created')
        else await detectIn($, cmd, 'tool')
      } else if (String(e.tool).startsWith('mcp__github__')) {
        const input = e as unknown as Record<string, unknown>
        const num = Number(input.pullNumber ?? input.pull_number)
        if (typeof input.owner === 'string' && typeof input.repo === 'string' && num > 0) {
          await setTarget($, { owner: input.owner, repo: input.repo, number: num }, 'tool')
        }
      }
    } catch {
      // Detection is best effort.
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) void turnStarted($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const merging = await read($, mergeAgent)
    if (merging && e.agentId === merging) {
      await update($, mergeAgent, () => null)
      await update($, busy, () => null)
      const line = e.answer.trim().split('\n').find(l => l.trim()) ?? ''
      $.ui.toast(e.isAborted ? 'The merge was interrupted' : `Merge done${line ? `: ${line}` : ''}`)
      // A merge that addressing the remarks waited on hands over to it.
      const task = await read($, afterMerge)
      if (task) {
        await update($, afterMerge, () => null)
        if (!e.isAborted) await spawnAddress($, task)
      }
    }
    const addressing = await read($, addressAgent)
    if (addressing && e.agentId === addressing) {
      await update($, addressAgent, () => null)
      await update($, busy, () => null)
      const line = e.answer.trim().split('\n').find(l => l.trim()) ?? ''
      $.ui.toast(e.isAborted ? 'Addressing the remarks was interrupted' : `Remarks addressed${line ? `: ${line}` : ''}`)
    }
    if (e.agentId === undefined) void refreshSession($, { usage: e.usage })
    void refresh($)
    return next(e)
  })

  // ---- drawing ---------------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const t = await read($, target)
    const s = await read($, status)
    const err = await read($, error)
    const working = await read($, busy)
    const merging = await read($, mergeAgent)
    const agentBusy = !!merging || !!(await read($, addressAgent))
    const info = await read($, session)
    const ver = pluginVersion
    const now = await $.clock.now()

    // ---- which commit of this plugin runs, and whether it is the newest ----
    const versionLine = (() => {
      if (!ver) return null
      const commit = ver.commit ? short(ver.commit) + (ver.isDirty ? '-dirty' : '') : 'unknown commit'
      const isLatest = !!ver.commit && !!ver.latest && ver.commit === ver.latest
      const behind = !!ver.commit && !!ver.latest && ver.commit !== ver.latest
      return (
        <Text key="version" dimColor={!behind}>
          pr-status {commit}
          {isLatest ? <Text color="success" dimColor>{' '}(latest)</Text> : null}
          {behind
            ? ver.source === 'installed'
              ? <Text color="warning">{' '}update available: {short(ver.latest!)} (/plugin update pr-status)</Text>
              : <Text dimColor>{' '}(GitHub has {short(ver.latest!)})</Text>
            : null}
        </Text>
      )
    })()

    // ---- Session: context, cost and what would make it cheaper ----
    const sessionSection = (() => {
      if (!info) return null
      const ttl = Math.max(5, Number(options.cacheTtlMinutes) || 60)
      const last = info.lastTurn
      const rate = last ? cacheHitRate(last) : null
      const idle = last && !info.isRunning ? Math.floor((now - last.at) / 60_000) : null
      const tips = costTips(info, now, ttl)
      const tipColor = { error: 'error', warning: 'warning', info: undefined } as const
      return (
        <Box key="session" flexDirection="column" marginTop={1}>
          <Text weight="bold">Session</Text>
          <Text>
            {'  '}Context{' '}
            <Text color={contextColor(info.tokens)}>
              {info.tokens === undefined ? 'unknown' : kTokens(info.tokens)}
            </Text>
            <Text dimColor>
              {' '}of {kTokens(info.window)}
              {info.tokens !== undefined ? ` (${Math.round((info.tokens / info.window) * 100)}%)` : ''}
              , {info.model}
            </Text>
          </Text>
          <Text>
            {'  '}Cost {usd(info.costUsd)}
            <Text dimColor>
              {last?.costUsd != null ? `, last turn ${usd(last.costUsd)}` : ''}
              {rate !== null ? `, cache hit ${Math.round(rate * 100)}%` : ''}
              {info.isRunning ? ', turn running' : idle !== null ? `, idle ${idle}m of ${ttl}m cache` : ''}
            </Text>
          </Text>
          {tips.map((tip, i) => (
            <Box key={`tip-${i}`}>
              <Text color={tipColor[tip.level]} dimColor={tip.level === 'info'} wrap="wrap">
                {'  '}{tip.level === 'info' ? '-' : '!'} {tip.text}
              </Text>
              {tip.action === 'compact' && (
                <Button key="compact" plain onPress={() => void $.session.compact().catch(() => undefined)}>
                  <Text underline> compact</Text>
                </Button>
              )}
            </Box>
          ))}
        </Box>
      )
    })()

    if (!t) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No PR in the conversation's opening or for this branch.</Text>
          <Text dimColor>/pr-status &lt;url | owner/repo#N | N&gt; pins one.</Text>
          {sessionSection}
          {versionLine}
        </Box>
      )
    }

    if (!s) {
      return (
        <Box flexDirection="column">
          <Text>{refText(t.ref)}</Text>
          <Text dimColor>{err ? `Error: ${err}` : 'Loading...'}</Text>
          {sessionSection}
          {versionLine}
        </Box>
      )
    }

    const isAuthor = s.mode === 'author'
    const isOpen = s.state === 'OPEN'
    const width = Math.min(
      22,
      Math.max(8, ...s.reviewers.map(r => r.login.length + (r.isTeam ? 1 : 0))),
    )

    const reviewerRow = (r: Reviewer) => {
      const name = (r.isTeam ? `@${r.login}` : r.login).padEnd(width)
      const label = STATE_TEXT[r.state]
      const detail: string[] = []
      if (isAuthor && r.at) {
        // Author: how much changed since this reviewer last looked.
        if ((r.state === 'approved' || r.state === 'lost-approval') && r.approvedAt !== r.at) {
          detail.push(`approved ${ago(r.approvedAt, now)}`)
        }
        detail.push(`last review ${ago(r.at, now)}`)
        detail.push(sinceText(r.commitsSinceLast))
      } else if (r.state === 'approved' || r.state === 'lost-approval') {
        detail.push(ago(r.approvedAt, now))
        if (r.state === 'approved' && r.commitsSince !== 0) detail.push(sinceText(r.commitsSince))
      } else if (r.at) {
        detail.push(ago(r.at, now))
      }
      if (r.isRequested && r.state !== 'not-reviewed') detail.push('re-requested')
      const clickable =
        isAuthor && isOpen && !r.isRequested && canRerequest(r) &&
        (r.state === 'lost-approval' || r.state === 'changes-requested')
      const open = `${r.openThreads} open`
      const openPart =
        r.openThreads === 0 ? null : isAuthor && isOpen && !agentBusy ? (
          <Button
            key={`address-${r.login}`}
            plain
            onPress={() => addressRemarks($, s, r.openThreads, r.login)}
          >
            <Text color="warning" underline>{open}</Text>
          </Button>
        ) : (
          <Text color="warning">{open}</Text>
        )
      return (
        <Box key={`rv-${r.login}`}>
          <Text>{'  '}{name} </Text>
          {clickable ? (
            <Button key={`rereq-${r.login}`} plain onPress={() => rerequest($, s, r)}>
              <Text color={STATE_COLOR[r.state]} underline>{label}</Text>
            </Button>
          ) : (
            <Text color={STATE_COLOR[r.state]} dimColor={r.state === 'not-reviewed'}>
              {label}
            </Text>
          )}
          {openPart && <Text>, </Text>}
          {openPart}
          {detail.length > 0 && <Text dimColor> {detail.filter(Boolean).join(', ')}</Text>}
        </Box>
      )
    }

    const remarks = `${s.openThreads} open review remark${s.openThreads === 1 ? '' : 's'}`
    const remarksRow =
      isAuthor && isOpen && s.openThreads > 0 && !agentBusy ? (
        <Button key="address" plain onPress={() => addressRemarks($, s, s.openThreads)}>
          <Text color="warning" underline>{remarks}</Text>
          <Text dimColor> (address in a subagent)</Text>
        </Button>
      ) : (
        <Text color={s.openThreads > 0 ? 'warning' : 'success'}>{remarks}</Text>
      )

    let mergeText = ''
    let mergeColor: string | undefined
    switch (s.merge) {
      case 'up-to-date':
        mergeText = `up-to-date with ${s.baseRef}`
        mergeColor = 'success'
        break
      case 'behind':
        mergeText = `behind ${s.baseRef} by ${s.behindBy} commit${s.behindBy === 1 ? '' : 's'}`
        mergeColor = 'warning'
        break
      case 'conflicts':
        mergeText = `conflicts with ${s.baseRef}`
        mergeColor = 'error'
        break
      default:
        mergeText = 'checking...'
    }
    const canMerge = isAuthor && isOpen && !agentBusy && (s.merge === 'behind' || s.merge === 'conflicts')
    const mergeRow = (
      <Box>
        <Text>Merge: </Text>
        {canMerge ? (
          <Button key="merge-base" plain onPress={() => mergeBase($, s)}>
            <Text color={mergeColor} underline>{mergeText}</Text>
            <Text dimColor> (merge {s.baseRef} on {options.mergeModel || 'sonnet'})</Text>
          </Button>
        ) : (
          <Text color={mergeColor} dimColor={!mergeColor}>{mergeText}</Text>
        )}
      </Box>
    )

    const c = s.checks
    const canRerun = isOpen && s.runs.some(r => r.state === 'failed')
    const checkParts = [
      c.failed ? { text: `${c.failed} failed`, color: 'error', key: 'rerun-failed' } : null,
      c.pending ? { text: `${c.pending} pending`, color: 'warning' } : null,
      c.passed ? { text: `${c.passed} passed`, color: 'success' } : null,
    ].filter(p => p !== null)
    const ciRow = (
      <Box>
        <Text>CI: </Text>
        {checkParts.length === 0 ? (
          <Text dimColor>no checks</Text>
        ) : (
          checkParts.map((p, i) => (
            <Box key={`ci-${i}`}>
              {i > 0 && <Text>, </Text>}
              {'key' in p && canRerun ? (
                <Button key="rerun-failed" plain onPress={() => rerunFailed($, s)}>
                  <Text color={p.color} underline>{p.text}</Text>
                  <Text dimColor> (re-run)</Text>
                </Button>
              ) : (
                <Text color={p.color}>{p.text}</Text>
              )}
            </Box>
          ))
        )}
      </Box>
    )
    const runRows = s.runs.map(r => (
      <Box key={`run-${r.id}`} flexDirection="column">
        <Text>
          {'  '}
          <Text color={r.state === 'failed' ? 'error' : 'warning'}>{r.state === 'failed' ? 'failed ' : 'running'}</Text>
          {' '}{r.name}
        </Text>
        <Box>
          <Text>{'    '}</Text>
          <Link href={r.url} />
        </Box>
      </Box>
    ))
    const checksLink =
      s.runs.length === 0 && checkParts.length > 0 ? (
        <Box>
          <Text>{'  '}</Text>
          <Link href={`${s.url}/checks`} />
        </Box>
      ) : null

    const me = s.me
    const myReview = (() => {
      switch (me.state) {
        case 'approved':
          return { label: 'Reviewed - Approved', color: 'success', at: me.approvedAt, extra: sinceText(me.commitsSince) }
        case 'lost-approval':
          return { label: 'Reviewed - Approval lost', color: 'warning', at: me.approvedAt, extra: sinceText(me.commitsSince) }
        case 'commented':
        case 'changes-requested':
          return {
            label: me.state === 'changes-requested' ? 'Reviewed - Commented (changes requested)' : 'Reviewed - Commented',
            color: 'suggestion',
            at: me.at,
            extra: [
              sinceText(me.commitsSince),
              me.approvedAt ? `approved earlier ${stamp(me.approvedAt)}` : '',
            ].filter(Boolean).join(', '),
          }
        default:
          return { label: 'Not reviewed', color: undefined, at: undefined, extra: '' }
      }
    })()

    // A merged or closed PR gets a framed, colored banner under its title.
    const closedBanner = (() => {
      if (isOpen) return null
      const merged = s.state === 'MERGED'
      const color = merged ? 'merged' : 'error'
      const at = merged ? (s.mergedAt ?? s.closedAt) : s.closedAt
      return (
        <Box key="closed-banner" flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
          <Text>
            <Text backgroundColor={color} color="inverseText" weight="bold">
              {merged ? ' MERGED ' : ' CLOSED '}
            </Text>
            <Text color={color} weight="bold">
              {' '}
              {merged
                ? `into ${s.baseRef}${s.mergedBy ? ` by ${s.mergedBy}` : ''}`
                : 'without merging'}
            </Text>
          </Text>
          {at ? <Text dimColor>{stamp(at)} ({ago(at, now)})</Text> : null}
        </Box>
      )
    })()

    const footer = (
      <Box flexDirection="column">
        <Box>
          <Text dimColor>
            {working ?? (err ? `Error: ${err}` : `updated ${ago(new Date(s.fetchedAt).toISOString(), now)}`)}{' '}
          </Text>
          <Button key="refresh" dimColor onPress={() => refresh($)}>refresh</Button>
        </Box>
        {versionLine}
      </Box>
    )

    // A merged or closed PR shows what it was and how it ended, nothing more:
    // reviewers, remarks, merge state, CI and reviews no longer matter.
    if (!isOpen) {
      return (
        <Box flexDirection="column">
          <Box>
            <Text weight="bold">#{s.ref.number} </Text>
            <Text>{s.title}</Text>
          </Box>
          {closedBanner}
          <Text> </Text>
          <Link href={s.url} />
          {sessionSection}
          <Text> </Text>
          {footer}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box>
          <Text weight="bold">#{s.ref.number} </Text>
          <Text>{s.title}</Text>
        </Box>
        <Text> </Text>
        <Link href={s.url} />
        <Text> </Text>
        <Text dimColor>
          {s.mode} mode ({s.viewer}){s.isDraft ? ', draft' : ''}
          {t.source === 'manual' ? ', pinned' : ''} - {s.headRef} -&gt; {s.baseRef}
        </Text>
        <Text> </Text>
        <Text weight="bold">Reviewers</Text>
        {s.reviewers.length === 0 && <Text dimColor>  none</Text>}
        {s.reviewers.map(reviewerRow)}
        <Text> </Text>
        {remarksRow}
        {mergeRow}
        {ciRow}
        {runRows}
        {checksLink}
        {!isAuthor && (
          <Box flexDirection="column" marginTop={1}>
            <Text weight="bold">My review</Text>
            <Text>
              {'  '}
              <Text color={myReview.color} dimColor={!myReview.color}>{myReview.label}</Text>
              {myReview.at ? <Text dimColor> {stamp(myReview.at)} ({ago(myReview.at, now)})</Text> : ''}
            </Text>
            {myReview.extra ? <Text dimColor>{'  '}{myReview.extra}</Text> : null}
            <Box>
              <Button
                key="review-again"
                variant="primary"
                onPress={() => send($, fill(options.reviewCommand ?? '', { url: s.url }))}
              >
                {me.state === 'not-reviewed' ? 'Review' : 'Review again'}
              </Button>
            </Box>
          </Box>
        )}
        {sessionSection}
        <Text> </Text>
        {footer}
      </Box>
    )
  })
}
