import { expect, test } from 'claude-code/testing'

import { costTips } from './hooks/cost'
import { openingRef } from './hooks/pr'
import { githubRepo, installedVersion, pluginsDir } from './hooks/version'

const PANE = {
  plugin: 'pr-status',
  component: 'Pane',
  requestId: 'pr-status',
  props: {
    title: 'PR #7',
    isFocused: false,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const NOW = Date.parse('2026-11-19T12:00:00Z')
let clock = NOW

function answer(viewer: string, pr: Record<string, unknown> = {}) {
  const rv = (id: string, login: string, state: string, at: string, oid: string) => ({
    id,
    author: { __typename: 'User', login },
    state,
    submittedAt: at,
    commit: { oid },
  })
  return {
    data: {
      viewer: { login: viewer },
      repository: {
        pullRequest: {
          number: 7,
          url: 'https://github.com/acme/widgets/pull/7',
          title: 'Make widgets spin',
          state: 'OPEN',
          isDraft: false,
          author: { login: 'alice' },
          assignees: { nodes: [] },
          headRefName: 'spin',
          baseRefName: 'main',
          headRefOid: 'c3',
          mergeable: 'MERGEABLE',
          reviewRequests: {
            nodes: [{ requestedReviewer: { __typename: 'User', login: 'dave' } }],
          },
          reviews: {
            nodes: [
              rv('r1', 'bob', 'DISMISSED', '2026-11-19T09:00:00Z', 'c1'),
              rv('r2', 'carol', 'CHANGES_REQUESTED', '2026-11-19T10:00:00Z', 'c2'),
              rv('r3', 'erin', 'APPROVED', '2026-11-19T11:00:00Z', 'c2'),
              { ...rv('r5', 'coderabbitai', 'CHANGES_REQUESTED', '2026-11-19T10:30:00Z', 'c2'), author: { __typename: 'Bot', login: 'coderabbitai' } },
              { ...rv('r6', 'otherbot', 'CHANGES_REQUESTED', '2026-11-19T10:31:00Z', 'c2'), author: { __typename: 'Bot', login: 'otherbot' } },
              rv('r4', 'alice', 'COMMENTED', '2026-11-19T11:30:00Z', 'c3'),
            ],
          },
          reviewThreads: {
            nodes: [
              // carol's two threads await a reply; her third has alice's reply last
              { isResolved: false, first: { nodes: [{ author: { login: 'carol' } }] }, last: { nodes: [{ author: { login: 'carol' } }] } },
              { isResolved: false, first: { nodes: [{ author: { login: 'carol' } }] }, last: { nodes: [{ author: { login: 'erin' } }] } },
              { isResolved: false, first: { nodes: [{ author: { login: 'carol' } }] }, last: { nodes: [{ author: { login: 'alice' } }] } },
              { isResolved: true, first: { nodes: [{ author: { login: 'bob' } }] }, last: { nodes: [{ author: { login: 'bob' } }] } },
            ],
          },
          commits: { nodes: [{ commit: { oid: 'c1' } }, { commit: { oid: 'c2' } }, { commit: { oid: 'c3' } }] },
          head: {
            nodes: [{
              commit: {
                statusCheckRollup: {
                  contexts: {
                    checkRunCountsByState: [
                      { state: 'QUEUED', count: 1 }, { state: 'IN_PROGRESS', count: 2 },
                      { state: 'SUCCESS', count: 16 }, { state: 'SKIPPED', count: 35 },
                      { state: 'FAILURE', count: 1 },
                    ],
                    statusContextCountsByState: [{ state: 'SUCCESS', count: 1 }],
                  },
                },
              },
            }],
          },
          timelineItems: { nodes: [{ previousReviewState: 'APPROVED', review: { id: 'r1' } }] },
          ...pr,
        },
      },
    },
  }
}

type Seen = {
  pr?: () => Record<string, unknown>
  toasts?: string[]
  titles?: string[]
  /** The conversation so far. */
  messages?: { role: 'user' | 'assistant'; text: string; toolUses: [] }[]
  /** The current branch's PR URL; none when empty. */
  branch?: string
  usage?: { tokens?: number; window: number; usd: number }
  spawned?: Record<string, unknown>[]
  /** The plugin checkout's commit, whether it has changes, and GitHub's newest. */
  commit?: string
  dirty?: boolean
  latest?: string
  /** Commits the head is behind its base. */
  behind?: number
  /** No macOS `open` on this machine. */
  noOpen?: boolean
  /** Built-in slash commands the plugin ran. */
  commands?: string[]
}

function engine(on: any, viewer: string, calls: string[][], seen: Seen = {}) {
  let paneTitle: string | undefined
  on('command.register', () => ({ value: { command: 'pr-status' } }))
  on('command.list', () => ({ value: [] }))
  on('command.run', (_: unknown, e: { command: string }) => {
    seen.commands?.push(e.command)
    return { value: { text: '' } }
  })
  on('ui.open', (_: unknown, e: { id: string; title?: string }) => {
    paneTitle = e.title ?? e.id
    seen.titles?.push(paneTitle)
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({
    value: paneTitle ? [{ id: 'pr-status', title: paneTitle, isShown: true, isFocused: false, isPlaced: true }] : [],
  }))
  on('ui.toast', (_: unknown, e: { text: string }) => {
    seen.toasts?.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.messages', () => ({ value: seen.messages ?? [] }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => {
    const u = seen.usage ?? { tokens: 50_000, window: 1_000_000, usd: 1.5 }
    return {
      value: {
        startedAt: NOW - 3_600_000,
        context: { tokens: u.tokens, window: u.window, percent: u.tokens === undefined ? undefined : Math.round((u.tokens / u.window) * 100) },
        rateLimits: {},
        cost: { usd: u.usd },
      } as any,
    }
  })
  on('agent.spawn', (_: unknown, e: Record<string, unknown>) => {
    seen.spawned?.push(e)
    return { model: String(e.model ?? 'inherit'), agentId: 'agent-1' }
  })
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('clock.now', () => ({ value: clock }))
  on('clock.every', () => ({ value: { cancel() {} } }))
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    calls.push([...e.argv])
    const a = e.argv.join(' ')
    const ok = (stdout: string) => ({
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (e.argv[0] === 'open' && seen.noOpen) {
      return { value: { exitCode: 127, stdout: '', stderr: 'not found', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[0] === 'git') {
      const g = e.argv.slice(3).join(' ')
      if (g === 'rev-parse HEAD') return ok((seen.commit ?? 'abc1234aaaaaaaa') + '\n')
      if (g === 'rev-parse --show-toplevel') return ok(e.argv[2] + '\n')
      if (g === 'status --porcelain') return ok(seen.dirty ? ' M hooks/register.tsx\n' : '')
      if (g === 'remote get-url origin') return ok('git@github.com:ramondeklein/claude-plugin-pr-status.git\n')
    }
    if (a.startsWith('gh api repos/ramondeklein/claude-plugin-pr-status/commits/HEAD')) {
      return ok((seen.latest ?? 'abc1234aaaaaaaa') + '\n')
    }
    if (a === 'gh pr view --json url -q .url') {
      const branch = seen.branch ?? 'https://github.com/acme/widgets/pull/7'
      return branch ? ok(branch + '\n') : { value: { exitCode: 1, stdout: '', stderr: 'no pull requests found', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (a.startsWith('gh pr view')) return ok(`https://github.com/acme/widgets/pull/${/gh pr view (\d+)/.exec(a)?.[1] ?? 7}\n`)
    if (a.startsWith('gh api graphql')) {
      const n = Number(/number=(\d+)/.exec(a)?.[1] ?? 7)
      return ok(JSON.stringify(answer(viewer, { number: n, url: `https://github.com/acme/widgets/pull/${n}`, ...seen.pr?.() })))
    }
    if (a.includes('/compare/')) return ok(`${seen.behind ?? 5}\n`)
    if (a.startsWith('gh run list')) {
      return ok(JSON.stringify([
        { databaseId: 11, workflowName: 'Lint', status: 'completed', conclusion: 'failure', url: 'https://github.com/acme/widgets/actions/runs/11' },
        { databaseId: 12, workflowName: 'Tests', status: 'in_progress', conclusion: '', url: 'https://github.com/acme/widgets/actions/runs/12' },
        { databaseId: 13, workflowName: 'Docs', status: 'completed', conclusion: 'success', url: 'https://github.com/acme/widgets/actions/runs/13' },
      ]))
    }
    return ok('{}')
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`author mode on ${surface}: statuses and actions`, async ($, on) => {
    const calls: string[][] = []
    engine(on, 'alice', calls)
    await $.session.start({ cwd: '/repo', surface, isInteractive: true })
    await $.command.run({ command: 'pr-status', args: 'refresh' })

    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /lost approval/ }))?.text).toBe('lost approval')
    expect(await ui.find({ type: 'Text', text: /changes requested/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /2 open review remarks/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /behind main by 5 commits/ })).toBeTruthy()
    // commits after each reviewer's latest review (bob at c1, carol at c2, head c3)
    expect((await ui.find({ type: 'Text', text: /last review 3h ago, 2 commits since/ }))?.text).toContain('2 commits since')
    expect(await ui.find({ type: 'Text', text: /last review 2h ago, 1 commit since/ })).toBeTruthy()
    // CI: only the non-zero counts; skipped checks count as none
    expect(await ui.find({ type: 'Text', text: /3 pending/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /17 passed/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^1 failed$/ })).toBeTruthy()
    // the failed and running runs are listed, the passed one is not
    expect(await ui.find({ type: 'Text', text: /Lint/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Tests/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Docs/ })).toBeFalsy()
    await ui.press({ key: 'rerun-failed' })
    expect(calls.some(c => c.join(' ') === 'gh run rerun 11 --failed -R acme/widgets')).toBe(true)
    expect(calls.some(c => c.join(' ').startsWith('gh run rerun 12'))).toBe(false)
    expect(await ui.find({ key: 'address' })).toBeTruthy()
    // per reviewer: carol started both open threads, bob's is resolved
    expect(await ui.find({ key: 'address-carol' })).toBeTruthy()
    expect(await ui.find({ key: 'address-bob' })).toBeFalsy()
    expect(await ui.find({ key: 'merge-base' })).toBeTruthy()
    expect(await ui.find({ key: 'review-again' })).toBeFalsy()
    // the author's own comment does not make them a reviewer
    expect(await ui.find({ key: 'rv-alice' })).toBeFalsy()

    await ui.press({ key: 'rereq-bob' })
    const post = calls.find(c => c.includes('POST'))
    expect(post?.join(' ')).toContain('repos/acme/widgets/pulls/7/requested_reviewers')
    expect(post).toContain('reviewers[]=bob')

    // CodeRabbit is asked by a comment; a bot without a known command is not clickable.
    await ui.press({ key: 'rereq-coderabbitai' })
    const comment = calls.find(c => c.includes('comment'))
    expect(comment).toContain('@coderabbitai review')
    expect(await ui.find({ key: 'rereq-otherbot' })).toBeFalsy()
    await ui.unmount()
  })

  test(`reviewer mode on ${surface}: my review status`, async ($, on) => {
    engine(on, 'bob', [])
    await $.session.start({ cwd: '/repo', surface, isInteractive: true })
    await $.command.run({ command: 'pr-status', args: 'refresh' })

    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Reviewed - Approval lost/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /2 commits since/ })).toBeTruthy()
    expect(await ui.find({ key: 'review-again' })).toBeTruthy()
    expect(await ui.find({ key: 'address' })).toBeFalsy()
    expect(await ui.find({ key: 'merge-base' })).toBeFalsy()
    expect(await ui.find({ key: 'rereq-bob' })).toBeFalsy()
    await ui.unmount()
  })
  test(`merged PR on ${surface}: a banner, and no open-only rows`, async ($, on) => {
    const calls: string[][] = []
    const titles: string[] = []
    engine(on, 'alice', calls, {
      titles,
      pr: () => ({ state: 'MERGED', mergedAt: '2026-11-19T11:45:00Z', mergedBy: { login: 'erin' }, closedAt: '2026-11-19T11:45:00Z' }),
    })
    await $.session.start({ cwd: '/repo', surface, isInteractive: true })
    await $.command.run({ command: 'pr-status', args: 'refresh' })

    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^ MERGED $/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /into main by erin/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /15m ago/ })).toBeTruthy()
    expect(titles.at(-1)).toBe('PR #7 - MERGED')
    expect(await ui.find({ key: 'url-pr' })).toBeTruthy()
    // nothing to merge, re-run, address or review on a merged PR
    expect(await ui.find({ key: 'merge-base' })).toBeFalsy()
    expect(await ui.find({ key: 'rerun-failed' })).toBeFalsy()
    expect(await ui.find({ key: 'address' })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /behind main/ })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /passed/ })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /lost approval|changes requested/ })).toBeFalsy()
    // a merged PR is not compared with its base or asked for runs
    expect(calls.some(c => c.join(' ').includes('/compare/'))).toBe(false)
    expect(calls.some(c => c.join(' ').startsWith('gh run list'))).toBe(false)
    await ui.unmount()
  })

  test(`closed PR on ${surface}: a closed banner`, async ($, on) => {
    engine(on, 'bob', [], { pr: () => ({ state: 'CLOSED', closedAt: '2026-11-18T12:00:00Z' }) })
    await $.session.start({ cwd: '/repo', surface, isInteractive: true })
    await $.command.run({ command: 'pr-status', args: 'refresh' })

    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^ CLOSED $/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /without merging/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /1d ago/ })).toBeTruthy()
    // no details of a closed PR: reviewers, remarks, mode or my review
    expect(await ui.find({ key: 'review-again' })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /Reviewed - Approval lost/ })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /Reviewers/ })).toBeFalsy()
    expect(await ui.find({ key: 'rv-carol' })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /open review remark/ })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /mode \(/ })).toBeFalsy()
    // what is left: the banner, the session and the refresh button
    expect(await ui.find({ type: 'Text', text: /^Session $/ })).toBeTruthy()
    expect(await ui.find({ key: 'refresh' })).toBeTruthy()
    await ui.unmount()
  })

  test(`open then merged on ${surface}: a toast and a retitled pane`, async ($, on) => {
    let state = 'OPEN'
    const toasts: string[] = []
    const titles: string[] = []
    engine(on, 'alice', [], {
      toasts,
      titles,
      pr: () => (state === 'OPEN' ? {} : { state, mergedAt: '2026-11-19T11:59:00Z', mergedBy: { login: 'erin' } }),
    })
    await $.session.start({ cwd: '/repo', surface, isInteractive: true })
    await $.command.run({ command: 'pr-status', args: 'refresh' })
    expect(titles.at(-1)).toBe('PR #7')
    expect(toasts).toEqual([])

    state = 'MERGED'
    await $.command.run({ command: 'pr-status', args: 'refresh' })
    expect(toasts).toEqual(['acme/widgets#7 was merged into main by erin'])
    expect(titles.at(-1)).toBe('PR #7 - MERGED')

    // the next refresh does not announce it again
    await $.command.run({ command: 'pr-status', args: 'refresh' })
    expect(toasts.length).toBe(1)
  })
  test(`opening PR on ${surface}: the conversation's first URL beats the branch`, async ($, on) => {
    const calls: string[][] = []
    engine(on, 'alice', calls, {
      branch: 'https://github.com/acme/widgets/pull/8',
      messages: [
        {
          role: 'user',
          text: '<system-reminder>\nsee https://github.com/acme/widgets/pull/99\n</system-reminder>\n/maintain-pr https://github.com/acme/widgets/pull/7',
          toolUses: [],
        },
        { role: 'assistant', text: 'Looking at https://github.com/acme/widgets/pull/5 too.', toolUses: [] },
      ],
    })
    const graphqlNumber = () => calls.filter(c => c[2] === 'graphql').at(-1)?.find(a => a.startsWith('number='))
    await $.session.start({ cwd: '/repo', surface, isInteractive: true })
    await $.command.run({ command: 'pr-status', args: 'refresh' })
    expect(graphqlNumber()).toBe('number=7')

    // auto follows the opening again, not the branch
    await $.command.run({ command: 'pr-status', args: 'auto' })
    expect(graphqlNumber()).toBe('number=7')

    // a pin wins over the opening
    await $.command.run({ command: 'pr-status', args: '9' })
    await $.command.run({ command: 'pr-status', args: 'refresh' })
    expect(graphqlNumber()).toBe('number=9')
  })

  test(`no opening PR on ${surface}: the branch's PR`, async ($, on) => {
    const calls: string[][] = []
    engine(on, 'alice', calls, {
      branch: 'https://github.com/acme/widgets/pull/8',
      messages: [{ role: 'user', text: 'Fix the flaky test in widgets.', toolUses: [] }],
    })
    await $.session.start({ cwd: '/repo', surface, isInteractive: true })
    await $.command.run({ command: 'pr-status', args: 'refresh' })
    expect(calls.filter(c => c[2] === 'graphql').at(-1)).toContain('number=8')
  })

  test(`merge on ${surface}: runs on a Sonnet subagent`, async ($, on) => {
    const spawned: Record<string, unknown>[] = []
    const toasts: string[] = []
    engine(on, 'alice', [], { spawned, toasts })
    await $.session.start({ cwd: '/repo', surface, isInteractive: true })
    await $.command.run({ command: 'pr-status', args: 'refresh' })

    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /merge main on sonnet/ })).toBeTruthy()
    await ui.press({ key: 'merge-base' })
    expect(spawned.length).toBe(1)
    expect(spawned[0]?.model).toBe('sonnet')
    expect(spawned[0]?.description).toBe('Merge main into spin')
    expect(String(spawned[0]?.prompt)).toContain('Merge the latest main into spin')
    // the test's spawn hook starts no agent (core stamps agentId), so nothing is followed
    expect(toasts).toContain('Merging main into spin on sonnet')

    await ui.unmount()
  })

  test(`session section on ${surface}: context, cost and tips`, async ($, on) => {
    clock = NOW
    engine(on, 'alice', [], { usage: { tokens: 250_000, window: 1_000_000, usd: 3.21 } })
    await $.session.start({ cwd: '/repo', surface, isInteractive: true })
    await $.turn.complete({
      answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer',
      usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 240_000, cache_creation_input_tokens: 9000, model: 'claude-opus-5-5' },
    } as any)
    await $.command.run({ command: 'pr-status', args: 'refresh' })

    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^250k$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Cost \$3\.21/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /cache hit 96%/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Context is 250k, over 200k/ })).toBeTruthy()
    expect(await ui.find({ key: 'compact' })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Sonnet at half the price/ })).toBeTruthy()
    await ui.unmount()

    // an hour idle: the cache has expired
    clock = NOW + 61 * 60_000
    await $.command.run({ command: 'pr-status', args: 'refresh' })
    const later = await $.ui.mount({ ...PANE, surface })
    expect(await later.find({ type: 'Text', text: /Prompt cache expired \(idle 61m\)/ })).toBeTruthy()
    await later.unmount()
    clock = NOW
  })
  test(`plugin version on ${surface}: its commit and whether it is the newest`, async ($, on) => {
    engine(on, 'alice', [])
    await $.session.start({ cwd: '/repo', surface, isInteractive: true })
    await $.command.run({ command: 'pr-status', args: 'refresh' })
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^pr-status abc1234 \(latest\)$/ })).toBeTruthy()
    await ui.unmount()
  })

  test(`plugin version on ${surface}: a changed checkout behind GitHub`, async ($, on) => {
    engine(on, 'alice', [], { dirty: true, latest: 'def5678bbbbbbbb' })
    await $.session.start({ cwd: '/repo', surface, isInteractive: true })
    await $.command.run({ command: 'pr-status', args: 'refresh' })
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^pr-status abc1234-dirty \(GitHub has def5678\)$/ })).toBeTruthy()
    await ui.unmount()
  })
  test(`address remarks on ${surface}: merge on Sonnet, then a clean agent`, async ($, on) => {
    const spawned: Record<string, unknown>[] = []
    engine(on, 'alice', [], { spawned })
    await $.session.start({ cwd: '/repo', surface, isInteractive: true })
    await $.command.run({ command: 'pr-status', args: 'refresh' })
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /address in a subagent/ })).toBeTruthy()

    // behind main: the merge subagent first, then (here at once, as the test
    // engine starts no agent to wait on) the agent that addresses the remarks
    await ui.press({ key: 'address-carol' })
    expect(spawned.map(a => a.description)).toEqual(['Merge main into spin', 'Address 2 review remarks'])
    expect(spawned[0]?.model).toBe('sonnet')
    const task = String(spawned[1]?.prompt)
    expect(task).toContain('Address the 2 unresolved review threads on https://github.com/acme/widgets/pull/7')
    expect(task).toContain('Only address the threads that carol started.')
    expect(task).toContain('do not merge it again')
    await ui.unmount()
  })

  test(`address remarks on ${surface}: an up-to-date branch needs no merge`, async ($, on) => {
    const spawned: Record<string, unknown>[] = []
    engine(on, 'alice', [], { spawned, behind: 0 })
    await $.session.start({ cwd: '/repo', surface, isInteractive: true })
    await $.command.run({ command: 'pr-status', args: 'refresh' })
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'address' })
    expect(spawned.map(a => a.description)).toEqual(['Address 2 review remarks'])
    expect(String(spawned[0]?.prompt)).not.toContain('Only address the threads that')
    await ui.unmount()
  })
  test(`URLs on ${surface}: a press or Enter opens them in the browser`, async ($, on) => {
    const calls: string[][] = []
    engine(on, 'alice', calls)
    await $.session.start({ cwd: '/repo', surface, isInteractive: true })
    await $.command.run({ command: 'pr-status', args: 'refresh' })
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'url-pr' })
    expect(calls).toContainEqual(['open', 'https://github.com/acme/widgets/pull/7'])
    await ui.press({ key: 'url-run-11' })
    expect(calls).toContainEqual(['open', 'https://github.com/acme/widgets/actions/runs/11'])
    await ui.unmount()
  })

  test(`URLs on ${surface}: xdg-open where there is no open`, async ($, on) => {
    const calls: string[][] = []
    engine(on, 'alice', calls, { noOpen: true })
    await $.session.start({ cwd: '/repo', surface, isInteractive: true })
    await $.command.run({ command: 'pr-status', args: 'refresh' })
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'url-pr' })
    expect(calls).toContainEqual(['xdg-open', 'https://github.com/acme/widgets/pull/7'])
    await ui.unmount()
  })
  test(`compact and clear on ${surface}: the pane keeps its PR`, async ($, on) => {
    const calls: string[][] = []
    const commands: string[] = []
    const seen = {
      commands,
      branch: 'https://github.com/acme/widgets/pull/8',
      messages: [{ role: 'user' as const, text: '/maintain-pr https://github.com/acme/widgets/pull/7', toolUses: [] as [] }],
    }
    engine(on, 'alice', calls, seen)
    // the engine's own context: no blocks of its own here
    on('prompt.context', ($, e) => ({ blocks: e.blocks }))
    const graphqlNumber = () => calls.filter(c => c[2] === 'graphql').at(-1)?.find(a => a.startsWith('number='))
    await $.session.start({ cwd: '/repo', surface, isInteractive: true })
    await $.command.run({ command: 'pr-status', args: 'refresh' })
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /keeps PR #7/ })).toBeTruthy()
    const prBlock = async () => (await $.prompt.context({ blocks: [] })).blocks.find(b => b.name === 'pr-status')
    expect(await prBlock()).toBe(undefined)

    await ui.press({ key: 'compact' })
    expect(commands).toEqual(['compact'])

    // the first press only asks to confirm
    await ui.press({ key: 'clear' })
    expect(commands).toEqual(['compact'])
    expect(await ui.find({ type: 'Text', text: /press again to clear/ })).toBeTruthy()
    // the new conversation opens with another PR; the pane stays on #7
    seen.messages = [{ role: 'user', text: 'look at https://github.com/acme/widgets/pull/5', toolUses: [] }]
    await ui.press({ key: 'clear' })
    expect(commands).toEqual(['compact', 'clear'])
    // the fresh conversation is told which PR it works on
    expect((await prBlock())?.text).toBe('Context of this agent is https://github.com/acme/widgets/pull/7')
    await $.command.run({ command: 'pr-status', args: 'refresh' })
    expect(graphqlNumber()).toBe('number=7')
    await ui.unmount()
  })
}

test('openingRef: the first PR URL of the opening lines, reminders left out', () => {
  const msg = (text: string) => ({ role: 'user', text })
  expect(openingRef([msg('<system-reminder>https://github.com/a/b/pull/1</system-reminder>\nreview https://github.com/a/b/pull/2 and https://github.com/a/b/pull/3')]))
    .toEqual({ owner: 'a', repo: 'b', number: 2 })
  // past the opening lines it does not count
  const long = [...Array(12)].map((_, i) => `line ${i}`).join('\n') + '\nhttps://github.com/a/b/pull/4'
  expect(openingRef([msg(long)])).toBe(null)
  // an issue URL is no PR
  expect(openingRef([msg('fix https://github.com/a/b/issues/5')])).toBe(null)
  // assistant messages do not count
  expect(openingRef([{ role: 'assistant', text: 'https://github.com/a/b/pull/6' }, msg('hi')])).toBe(null)
})

test('costTips: what applies', () => {
  const base = { window: 1_000_000, costUsd: 1, model: 'claude-sonnet-5-5', isRunning: false }
  expect(costTips({ ...base, tokens: 50_000 }, NOW, 60)).toEqual([])
  expect(costTips({ ...base, tokens: 160_000 }, NOW, 60)[0]?.level).toBe('warning')
  const turn = { at: NOW - 52 * 60_000, costUsd: 0.5, input: 10, cacheRead: 100_000, cacheWrite: 1000, output: 10 }
  expect(costTips({ ...base, tokens: 100_000, lastTurn: turn }, NOW, 60)[0]?.text).toContain('expires in 8m')
  // a running turn is not idle
  expect(costTips({ ...base, tokens: 100_000, lastTurn: turn, isRunning: true }, NOW, 60)).toEqual([])
  const cold = { ...turn, at: NOW, cacheRead: 0, cacheWrite: 100_000 }
  expect(costTips({ ...base, tokens: 100_000, lastTurn: cold }, NOW, 60)[0]?.text).toContain('only 0%')
  expect(costTips({ ...base, model: 'claude-opus-5-5', tokens: 10 }, NOW, 60)[0]?.level).toBe('info')
})

test('version: install records, plugin folders and GitHub remotes', () => {
  const root = '/Users/x/.claude/plugins/cache/claude-plugin-pr-status/pr-status/0.1.0'
  expect(pluginsDir(root)).toBe('/Users/x/.claude/plugins')
  expect(pluginsDir('/Users/x/src/pr-status')).toBe(null)
  const installed = JSON.stringify({
    version: 2,
    plugins: { 'pr-status@claude-plugin-pr-status': [{ installPath: root, gitCommitSha: '78d1b1cd4641ec46' }] },
  })
  const known = JSON.stringify({
    'claude-plugin-pr-status': { source: { source: 'github', repo: 'ramondeklein/claude-plugin-pr-status' } },
  })
  expect(installedVersion(root, installed, known)).toEqual({ commit: '78d1b1cd4641ec46', repo: 'ramondeklein/claude-plugin-pr-status' })
  expect(installedVersion('/elsewhere', installed, known)).toBe(null)
  expect(githubRepo('ssh://git@github.com/ramondeklein/claude-plugin-pr-status.git')).toBe('ramondeklein/claude-plugin-pr-status')
  expect(githubRepo('https://github.com/a/b')).toBe('a/b')
  expect(githubRepo('git@gitlab.com:a/b.git')).toBe(null)
})
