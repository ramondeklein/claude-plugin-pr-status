export type PrRef = { owner: string; repo: string; number: number }

export type PrTarget = { ref: PrRef; source: 'branch' | 'detected' | 'manual' }

export type ReviewerState =
  | 'not-reviewed'
  | 'commented'
  | 'changes-requested'
  | 'approved'
  | 'lost-approval'

export type ReviewInfo = {
  state: ReviewerState
  /** Last review of any kind. */
  at?: string
  /** Last approval (also for a dismissed one). */
  approvedAt?: string
  /** Commits on the PR after the relevant review; null when unknown (rewritten branch). */
  commitsSince: number | null
  /** Commits on the PR after the person's latest review of any kind; null when none or unknown. */
  commitsSinceLast: number | null
}

export type Reviewer = ReviewInfo & {
  login: string
  isBot: boolean
  isTeam: boolean
  isRequested: boolean
}

export type CheckCounts = { pending: number; failed: number; passed: number }

export type MergeState = 'up-to-date' | 'behind' | 'conflicts' | 'unknown'

export type PrStatus = {
  ref: PrRef
  url: string
  title: string
  state: string
  isDraft: boolean
  viewer: string
  author: string
  mode: 'author' | 'reviewer'
  headRef: string
  baseRef: string
  reviewers: Reviewer[]
  openThreads: number
  merge: MergeState
  behindBy: number | null
  checks: CheckCounts
  me: ReviewInfo
  fetchedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'pr-status': {
      target: Shaped<PrTarget | null>
      status: Shaped<PrStatus | null>
      error: string | null
      busy: string | null
    }
  }
}
