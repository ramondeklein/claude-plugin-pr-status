import { expect, test } from 'claude-code/testing'

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

function answer(viewer: string) {
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
          reviewThreads: { nodes: [{ isResolved: false }, { isResolved: false }, { isResolved: true }] },
          commits: { nodes: [{ commit: { oid: 'c1' } }, { commit: { oid: 'c2' } }, { commit: { oid: 'c3' } }] },
          head: {
            nodes: [{
              commit: {
                statusCheckRollup: {
                  contexts: {
                    checkRunCountsByState: [
                      { state: 'QUEUED', count: 1 }, { state: 'IN_PROGRESS', count: 2 },
                      { state: 'SUCCESS', count: 16 }, { state: 'SKIPPED', count: 35 },
                      { state: 'FAILURE', count: 0 },
                    ],
                    statusContextCountsByState: [{ state: 'SUCCESS', count: 1 }],
                  },
                },
              },
            }],
          },
          timelineItems: { nodes: [{ previousReviewState: 'APPROVED', review: { id: 'r1' } }] },
        },
      },
    },
  }
}

function engine(on: any, viewer: string, calls: string[][]) {
  on('command.register', () => ({ value: { command: 'pr-status' } }))
  on('command.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: { cancel() {} } }))
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    calls.push([...e.argv])
    const a = e.argv.join(' ')
    const ok = (stdout: string) => ({
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (a.startsWith('gh pr view')) return ok('https://github.com/acme/widgets/pull/7\n')
    if (a.startsWith('gh api graphql')) return ok(JSON.stringify(answer(viewer)))
    if (a.includes('/compare/')) return ok('5\n')
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
    expect(await ui.find({ type: 'Text', text: /failed/ })).toBeFalsy()
    expect(await ui.find({ key: 'address' })).toBeTruthy()
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
}
