export type PrRef = { owner: string; repo: string; number: number }

/**
 * Where the followed PR came from, weakest first: a PR a tool call touched,
 * the current branch's, one a later prompt named, the one the conversation
 * opened with, one created in this session, one pinned with /pr-status.
 */
export type PrSource = 'tool' | 'branch' | 'prompt' | 'session' | 'created' | 'manual'

export type PrTarget = { ref: PrRef; source: PrSource }

/** One main-loop turn's tokens, summed over its requests, and what it cost. */
export type TurnCost = {
  /** When it ended, epoch ms. */
  at: number
  /** US dollars, from the session's cost before and after; null when unknown. */
  costUsd: number | null
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

/** The session's context and cost, as the pane's Session section shows them. */
export type PaneSession = {
  /** Input tokens of the last response (the context in use); absent before one. */
  tokens?: number
  window: number
  costUsd: number
  model: string
  /** A main-loop turn is running. */
  isRunning: boolean
  /** The session's cost when the running turn started. */
  turnStartUsd?: number
  lastTurn?: TurnCost
}

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
  /** Unresolved review threads this reviewer started. */
  openThreads: number
}

export type CheckCounts = { pending: number; failed: number; passed: number }

/** A GitHub Actions run of the head commit that failed or still runs. */
export type WorkflowRun = { id: number; name: string; state: 'failed' | 'pending'; url: string }

export type MergeState = 'up-to-date' | 'behind' | 'conflicts' | 'unknown'

export type PrStatus = {
  ref: PrRef
  url: string
  title: string
  /** OPEN, CLOSED or MERGED. */
  state: string
  /** When and by whom the PR was merged (MERGED only). */
  mergedAt?: string
  mergedBy?: string
  /** When the PR was closed, merged or not. */
  closedAt?: string
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
  runs: WorkflowRun[]
  me: ReviewInfo
  fetchedAt: number
}

/** The commit of this plugin that runs, and the newest on GitHub. */
export type PluginVersion = {
  /** Full commit hash; null when it cannot be told. */
  commit: string | null
  /** A git checkout (`--plugin-dir`) or an installed copy. */
  source: 'git' | 'installed'
  /** A checkout with uncommitted changes. */
  isDirty: boolean
  /** The newest commit of the GitHub repository's default branch, when known. */
  latest: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'pr-status': {
      target: Shaped<PrTarget | null>
      status: Shaped<PrStatus | null>
      error: string | null
      busy: string | null
      /** The PR the conversation opened with, once read. */
      origin: Shaped<PrRef | null>
      session: Shaped<PaneSession | null>
      /** The subagent merging the base branch, while it runs. */
      mergeAgent: string | null
      /** The subagent addressing review remarks, while it runs. */
      addressAgent: string | null
      /** The remarks to address once the running merge ends. */
      afterMerge: Shaped<{ prompt: string; count: number } | null>
    }
  }
}
