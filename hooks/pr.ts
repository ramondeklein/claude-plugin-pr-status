// Pure PR logic: parsing references out of text and turning GitHub's
// GraphQL answer into the pane's status. No `$` here, so tests can reach it.

import type {
  CheckCounts,
  MergeState,
  PrRef,
  PrStatus,
  ReviewInfo,
  Reviewer,
} from '../types'

export const QUERY = `query($owner:String!,$name:String!,$number:Int!){
  viewer{login}
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      number url title state isDraft
      author{login}
      assignees(first:20){nodes{login}}
      headRefName baseRefName headRefOid
      mergeable
      reviewRequests(first:50){nodes{requestedReviewer{__typename ... on User{login} ... on Team{slug} ... on Bot{login} ... on Mannequin{login}}}}
      reviews(last:100){nodes{id author{__typename login} state submittedAt commit{oid}}}
      reviewThreads(first:100){nodes{isResolved}}
      commits(last:100){nodes{commit{oid}}}
      head: commits(last:1){nodes{commit{statusCheckRollup{contexts(first:1){checkRunCountsByState{state count} statusContextCountsByState{state count}}}}}}
      timelineItems(last:100,itemTypes:[REVIEW_DISMISSED_EVENT]){nodes{... on ReviewDismissedEvent{previousReviewState review{id}}}}
    }
  }
}`

const URL_RE = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g
const SHORT_RE = /(?:^|[\s(])([\w.-]+)\/([\w.-]+)#(\d+)\b/g
const API_RE = /repos\/([\w.-]+)\/([\w.-]+)\/pulls\/(\d+)/g

/** The last full PR reference (URL, owner/repo#N, API path) in `text`. */
export function findRef(text: string): PrRef | null {
  let found: { at: number; ref: PrRef } | null = null
  for (const re of [URL_RE, SHORT_RE, API_RE]) {
    for (const m of text.matchAll(re)) {
      const at = m.index ?? 0
      if (found === null || at >= found.at) {
        found = { at, ref: { owner: m[1]!, repo: m[2]!, number: Number(m[3]) } }
      }
    }
  }
  return found?.ref ?? null
}

const GH_PR_RE =
  /\bgh\s+pr\s+(?:view|checkout|diff|review|comment|edit|merge|checks|ready|update-branch)\b([^\n|;&]*)/g

/**
 * A `gh pr <sub> <n>` in a shell command: the number, and the repository when
 * `-R`/`--repo` names one (else the caller resolves it in the cwd).
 */
export function findGhPrNumber(
  command: string,
): { number: number; repo?: string } | null {
  let out: { number: number; repo?: string } | null = null
  for (const m of command.matchAll(GH_PR_RE)) {
    const args = m[1] ?? ''
    const num = /(?:^|\s)#?(\d+)(?=\s|$)/.exec(args)
    if (!num) continue
    const repo = /(?:-R|--repo)[ =]([\w.-]+\/[\w.-]+)/.exec(args)
    out = { number: Number(num[1]), repo: repo?.[1] }
  }
  return out
}

export const sameRef = (a: PrRef | null | undefined, b: PrRef | null | undefined) =>
  !!a && !!b && a.owner === b.owner && a.repo === b.repo && a.number === b.number

export const refText = (r: PrRef) => `${r.owner}/${r.repo}#${r.number}`

// ---- GraphQL answer -> status ------------------------------------------------

type GqlReview = {
  id: string
  author: { __typename: string; login: string } | null
  state: string
  submittedAt: string | null
  commit: { oid: string } | null
}

export type GqlPr = {
  number: number
  url: string
  title: string
  state: string
  isDraft: boolean
  author: { login: string } | null
  assignees: { nodes: { login: string }[] }
  headRefName: string
  baseRefName: string
  headRefOid: string
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  reviewRequests: {
    nodes: {
      requestedReviewer: { __typename: string; login?: string; slug?: string } | null
    }[]
  }
  reviews: { nodes: GqlReview[] }
  reviewThreads: { nodes: { isResolved: boolean }[] }
  commits: { nodes: { commit: { oid: string } }[] }
  head?: {
    nodes: {
      commit: {
        statusCheckRollup: {
          contexts: {
            checkRunCountsByState: { state: string; count: number }[]
            statusContextCountsByState: { state: string; count: number }[]
          }
        } | null
      }
    }[]
  }
  timelineItems: {
    nodes: { previousReviewState?: string; review?: { id: string } | null }[]
  }
}

export type GqlAnswer = {
  data?: {
    viewer: { login: string }
    repository: { pullRequest: GqlPr | null } | null
  }
  errors?: { message: string }[]
}

function commitsAfter(oid: string | undefined, commits: string[]): number | null {
  if (!oid) return null
  const i = commits.lastIndexOf(oid)
  return i < 0 ? null : commits.length - 1 - i
}

/**
 * One person's review state from their reviews in order. A dismissed review
 * reads as what it was before (`previous`), so a dismissed approval is a lost
 * approval.
 */
export function reviewInfo(
  reviews: GqlReview[],
  previous: Map<string, string>,
  commits: string[],
): ReviewInfo {
  if (reviews.length === 0) {
    return { state: 'not-reviewed', commitsSince: null, commitsSinceLast: null }
  }
  const last = reviews[reviews.length - 1]!
  const decisive = reviews.filter(r =>
    ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state),
  )
  const latest = decisive[decisive.length - 1]
  const approvals = reviews.filter(
    r =>
      r.state === 'APPROVED' ||
      (r.state === 'DISMISSED' && previous.get(r.id) === 'APPROVED'),
  )
  const lastApproval = approvals[approvals.length - 1]
  const base = {
    at: last.submittedAt ?? undefined,
    approvedAt: lastApproval?.submittedAt ?? undefined,
    commitsSinceLast: commitsAfter(last.commit?.oid, commits),
  }

  if (latest?.state === 'APPROVED') {
    return { ...base, state: 'approved', commitsSince: commitsAfter(latest.commit?.oid, commits) }
  }
  if (latest?.state === 'DISMISSED' && previous.get(latest.id) === 'APPROVED') {
    return {
      ...base,
      state: 'lost-approval',
      commitsSince: commitsAfter(latest.commit?.oid, commits),
    }
  }
  if (latest?.state === 'CHANGES_REQUESTED') {
    return {
      ...base,
      state: 'changes-requested',
      commitsSince: commitsAfter(latest.commit?.oid, commits),
    }
  }
  return { ...base, state: 'commented', commitsSince: commitsAfter(last.commit?.oid, commits) }
}

// Check runs and commit statuses by state. Skipped, stale and plain
// "completed" runs count as none of the three.
const PENDING = new Set(['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'EXPECTED'])
const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const PASSED = new Set(['SUCCESS', 'NEUTRAL'])

export function checkCounts(pr: GqlPr): CheckCounts {
  const out: CheckCounts = { pending: 0, failed: 0, passed: 0 }
  const ctx = pr.head?.nodes[0]?.commit.statusCheckRollup?.contexts
  if (!ctx) return out
  for (const { state, count } of [...ctx.checkRunCountsByState, ...ctx.statusContextCountsByState]) {
    if (PENDING.has(state)) out.pending += count
    else if (FAILED.has(state)) out.failed += count
    else if (PASSED.has(state)) out.passed += count
  }
  return out
}

export function buildStatus(
  ref: PrRef,
  answer: GqlAnswer,
  behindBy: number | null,
  now: number,
): PrStatus {
  if (answer.errors?.length) throw new Error(answer.errors[0]?.message ?? 'GraphQL error')
  const pr = answer.data?.repository?.pullRequest
  if (!pr) throw new Error(`${refText(ref)} not found`)
  const viewer = answer.data!.viewer.login
  const author = pr.author?.login ?? ''
  const isAuthor =
    viewer === author || pr.assignees.nodes.some(a => a.login === viewer)

  const commits = pr.commits.nodes.map(n => n.commit.oid)
  const previous = new Map<string, string>()
  for (const t of pr.timelineItems.nodes) {
    if (t.review?.id && t.previousReviewState) previous.set(t.review.id, t.previousReviewState)
  }

  const byLogin = new Map<string, GqlReview[]>()
  const bots = new Set<string>()
  for (const r of pr.reviews.nodes) {
    const login = r.author?.login
    if (!login || login === author) continue
    if (r.state === 'PENDING') continue
    if (r.author?.__typename === 'Bot') bots.add(login)
    byLogin.set(login, [...(byLogin.get(login) ?? []), r])
  }

  const requested = new Map<string, { isTeam: boolean; isBot: boolean }>()
  for (const n of pr.reviewRequests.nodes) {
    const rr = n.requestedReviewer
    if (!rr) continue
    const name = rr.__typename === 'Team' ? rr.slug : rr.login
    if (name) requested.set(name, { isTeam: rr.__typename === 'Team', isBot: rr.__typename === 'Bot' })
  }

  const logins = [...new Set([...requested.keys(), ...byLogin.keys()])]
  const order: Record<string, number> = {
    'lost-approval': 0,
    'changes-requested': 1,
    'not-reviewed': 2,
    commented: 3,
    approved: 4,
  }
  const reviewers: Reviewer[] = logins
    .map(login => ({
      login,
      isBot: bots.has(login) || !!requested.get(login)?.isBot || login.endsWith('[bot]'),
      isTeam: !!requested.get(login)?.isTeam,
      isRequested: requested.has(login),
      ...reviewInfo(byLogin.get(login) ?? [], previous, commits),
    }))
    .sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9) || a.login.localeCompare(b.login))

  let merge: MergeState = 'unknown'
  if (pr.mergeable === 'CONFLICTING') merge = 'conflicts'
  else if (behindBy !== null) merge = behindBy > 0 ? 'behind' : 'up-to-date'

  return {
    ref,
    url: pr.url,
    title: pr.title,
    state: pr.state,
    isDraft: pr.isDraft,
    viewer,
    author,
    mode: isAuthor ? 'author' : 'reviewer',
    headRef: pr.headRefName,
    baseRef: pr.baseRefName,
    reviewers,
    openThreads: pr.reviewThreads.nodes.filter(t => !t.isResolved).length,
    merge,
    behindBy,
    checks: checkCounts(pr),
    me: reviewInfo(byLogin.get(viewer) ?? [], previous, commits),
    fetchedAt: now,
  }
}

// ---- display helpers ---------------------------------------------------------

export function ago(iso: string | undefined, now: number): string {
  if (!iso) return ''
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function stamp(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function sinceText(n: number | null): string {
  if (n === null) return 'branch rewritten since'
  if (n === 0) return 'no commits since'
  return `${n} commit${n === 1 ? '' : 's'} since`
}

export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (all, k: string) =>
    k in vars ? String(vars[k]) : all,
  )
}
