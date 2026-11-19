import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PrRef, PrStatus, PrTarget, Reviewer, ReviewerState } from '../types'
import {
  QUERY,
  ago,
  buildStatus,
  fill,
  findGhPrNumber,
  findRef,
  refText,
  sameRef,
  sinceText,
  stamp,
} from './pr'
import type { GqlAnswer } from './pr'

const PANE = 'pr-status'

// Bump a tag when the shape of its value changes: older values read as initial.
const target = atom({ plugin: 'pr-status', key: 'target' } as const, null, {
  shape: 'target-1',
})
const status = atom({ plugin: 'pr-status', key: 'status' } as const, null, {
  shape: 'status-3',
})
const error = atom({ plugin: 'pr-status', key: 'error' } as const, null)
const busy = atom({ plugin: 'pr-status', key: 'busy' } as const, null)

type Options = {
  pollSeconds?: number
  reviewCommand?: string
  addressPrompt?: string
  mergePrompt?: string
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

function openPane($: EngineInterface, ref: PrRef) {
  void $.ui.open({ id: PANE, title: `PR #${ref.number}` }).catch(() => undefined)
}

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
  return buildStatus(ref, answer, behindBy, await $.clock.now())
}

async function doRefresh($: EngineInterface) {
  let t = await read($, target)
  if (t === null || t.source === 'branch') {
    const ref = await resolveInCwd($)
    if (ref === null) {
      if (t !== null) {
        await update($, target, () => null)
        await update($, status, () => null)
      }
      return
    }
    if (!sameRef(ref, t?.ref)) {
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
    await update($, status, () => s)
    await update($, error, () => null)
  } catch (err) {
    await update($, error, () => (err instanceof Error ? err.message : String(err)))
  }
}

function refresh($: EngineInterface): Promise<void> {
  if (!inflight) {
    inflight = doRefresh($).finally(() => {
      inflight = undefined
    })
  }
  return inflight
}

async function setTarget($: EngineInterface, ref: PrRef, source: PrTarget['source']) {
  const cur = await read($, target)
  if (source === 'detected' && cur?.source === 'manual') return
  if (sameRef(cur?.ref, ref)) {
    if (cur && cur.source !== source && source !== 'branch') {
      await update($, target, () => ({ ref, source }))
    }
    return
  }
  await update($, target, () => ({ ref, source }))
  await update($, status, () => null)
  await update($, error, () => null)
  openPane($, ref)
  void refresh($)
}

async function detectIn($: EngineInterface, text: string | undefined) {
  if (!text) return
  const ref = findRef(text)
  if (ref) return setTarget($, ref, 'detected')
  const cmd = findGhPrNumber(text)
  if (cmd) {
    const [owner = '', repo = ''] = (cmd.repo ?? '').split('/')
    const resolved: PrRef | null = cmd.repo
      ? { owner, repo, number: cmd.number }
      : await resolveInCwd($, cmd.number)
    if (resolved) await setTarget($, resolved, 'detected')
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
    return next(e)
  })

  on('command.run', { command: 'pr-status' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'auto') {
      await update($, target, () => null)
      await update($, status, () => null)
      await refresh($)
      const t = await read($, target)
      if (t) openPane($, t.ref)
      return { text: t ? `following the branch PR ${refText(t.ref)}.` : 'no PR for the current branch.' }
    }
    if (arg && arg !== 'refresh') {
      let ref = findRef(arg)
      if (!ref && /^#?\d+$/.test(arg)) ref = await resolveInCwd($, Number(arg.replace('#', '')))
      if (!ref) return { text: `could not find a PR for "${arg}".` }
      await setTarget($, ref, 'manual')
      openPane($, ref)
      return { text: `pinned to ${refText(ref)}.` }
    }
    await refresh($)
    const t = await read($, target)
    if (!t) return { text: 'no PR for the current branch. Pass a URL or number.' }
    await $.ui.open({ id: PANE, title: `PR #${t.ref.number}` })
    return { text: `${refText(t.ref)}.` }
  })

  on('prompt.submit', async ($, e, next) => {
    void detectIn($, [e.text, e.command?.args].filter(Boolean).join(' ')).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    try {
      if (e.tool === 'Bash') {
        const cmd = e.command
        if (/\bgh\s+pr\s+create\b/.test(cmd) && ran.text) await detectIn($, ran.text)
        else await detectIn($, cmd)
      } else if (String(e.tool).startsWith('mcp__github__')) {
        const input = e as unknown as Record<string, unknown>
        const num = Number(input.pullNumber ?? input.pull_number)
        if (typeof input.owner === 'string' && typeof input.repo === 'string' && num > 0) {
          await setTarget($, { owner: input.owner, repo: input.repo, number: num }, 'detected')
        }
      }
    } catch {
      // Detection is best effort.
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
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
    const now = await $.clock.now()

    if (!t) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No PR for this branch.</Text>
          <Text dimColor>/pr-status &lt;url | owner/repo#N | N&gt; pins one.</Text>
        </Box>
      )
    }

    if (!s) {
      return (
        <Box flexDirection="column">
          <Text>{refText(t.ref)}</Text>
          <Text dimColor>{err ? `Error: ${err}` : 'Loading...'}</Text>
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
          {detail.length > 0 && <Text dimColor> {detail.filter(Boolean).join(', ')}</Text>}
        </Box>
      )
    }

    const remarks = `${s.openThreads} open review remark${s.openThreads === 1 ? '' : 's'}`
    const remarksRow =
      isAuthor && isOpen && s.openThreads > 0 ? (
        <Button
          key="address"
          plain
          onPress={() => send($, fill(options.addressPrompt ?? '', { url: s.url, count: s.openThreads, base: s.baseRef, head: s.headRef }))}
        >
          <Text color="warning" underline>{remarks}</Text>
          <Text dimColor> (address)</Text>
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
        mergeText = isOpen ? 'checking...' : s.state.toLowerCase()
    }
    const canMerge = isAuthor && isOpen && (s.merge === 'behind' || s.merge === 'conflicts')
    const mergeRow = (
      <Box>
        <Text>Merge: </Text>
        {canMerge ? (
          <Button
            key="merge-base"
            plain
            onPress={() =>
              send($, fill(options.mergePrompt ?? '', { url: s.url, base: s.baseRef, head: s.headRef }))
            }
          >
            <Text color={mergeColor} underline>{mergeText}</Text>
            <Text dimColor> (merge {s.baseRef})</Text>
          </Button>
        ) : (
          <Text color={mergeColor} dimColor={!mergeColor}>{mergeText}</Text>
        )}
      </Box>
    )

    const c = s.checks
    const checkParts = [
      c.failed ? { text: `${c.failed} failed`, color: 'error' } : null,
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
            <Text color={p.color}>
              {i > 0 ? ', ' : ''}
              {p.text}
            </Text>
          ))
        )}
      </Box>
    )

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

    return (
      <Box flexDirection="column">
        <Box>
          <Text weight="bold">#{s.ref.number} </Text>
          <Text>{s.title}</Text>
        </Box>
        <Link href={s.url} />
        <Text dimColor>
          {s.mode} mode ({s.viewer}){s.isDraft ? ', draft' : ''}
          {isOpen ? '' : `, ${s.state.toLowerCase()}`}
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
        <Text> </Text>
        <Box>
          <Text dimColor>
            {working ?? (err ? `Error: ${err}` : `updated ${ago(new Date(s.fetchedAt).toISOString(), now)}`)}{' '}
          </Text>
          <Button key="refresh" dimColor onPress={() => refresh($)}>refresh</Button>
        </Box>
      </Box>
    )
  })
}
