// Pure session-cost logic: the figures and tips of the pane's Session
// section. No `$` here, so tests can reach it.
//
// The thresholds follow what drives Claude Code spend: every turn re-reads
// the whole context from the prompt cache, so a turn at 300k costs about
// three times one at 100k; a cache that expired while the session sat idle is
// written again at twice the input price; and Sonnet costs half of Opus.

import type { PaneSession, TurnCost } from '../types'

/** Past this much context, start the next task in a fresh session. */
export const LARGE_CONTEXT = 200_000
export const GROWING_CONTEXT = 150_000

export type CostTip = {
  level: 'error' | 'warning' | 'info'
  text: string
  /** A Button beside the tip. */
  action?: 'compact'
}

export const kTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

export const usd = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`)

/** Share of a turn's input served from the prompt cache, 0 to 1; null without input. */
export function cacheHitRate(t: TurnCost): number | null {
  const total = t.input + t.cacheRead + t.cacheWrite
  return total === 0 ? null : t.cacheRead / total
}

export const contextColor = (tokens: number | undefined) =>
  tokens === undefined
    ? undefined
    : tokens >= LARGE_CONTEXT
      ? 'error'
      : tokens >= GROWING_CONTEXT
        ? 'warning'
        : 'success'

const isOpus = (model: string) => /opus/i.test(model)

/** The tips that apply now, most costly first. */
export function costTips(s: PaneSession, now: number, cacheTtlMinutes: number): CostTip[] {
  const tips: CostTip[] = []
  const tokens = s.tokens ?? 0

  if (tokens >= LARGE_CONTEXT) {
    tips.push({
      level: 'error',
      text: `Context is ${kTokens(tokens)}, over 200k: every turn re-reads all of it. Finish this task and start the next one in a fresh session (or /clear), or compact now.`,
      action: 'compact',
    })
  } else if (tokens >= GROWING_CONTEXT) {
    tips.push({
      level: 'warning',
      text: `Context is ${kTokens(tokens)}, nearing 200k. Start the next task in a fresh session.`,
    })
  }

  const last = s.lastTurn
  if (last && !s.isRunning && tokens > 20_000) {
    const idle = Math.floor((now - last.at) / 60_000)
    if (idle >= cacheTtlMinutes) {
      tips.push({
        level: 'error',
        text: `Prompt cache expired (idle ${idle}m): the next prompt writes ${kTokens(tokens)} tokens again at twice the input price. After a long wait, a fresh session with a short handoff is cheaper.`,
      })
    } else if (idle >= cacheTtlMinutes - 10) {
      tips.push({
        level: 'warning',
        text: `Prompt cache expires in ${cacheTtlMinutes - idle}m (idle ${idle}m); after that the next prompt writes ${kTokens(tokens)} tokens again.`,
      })
    }
  }

  if (last) {
    const rate = cacheHitRate(last)
    const total = last.input + last.cacheRead + last.cacheWrite
    if (rate !== null && rate < 0.5 && total > 20_000) {
      tips.push({
        level: 'warning',
        text: `The last turn read only ${Math.round(rate * 100)}% of its input from the cache (${kTokens(last.cacheWrite + last.input)} written or uncached).`,
      })
    }
  }

  if (isOpus(s.model)) {
    tips.push({
      level: 'info',
      text: 'Routine work (merges, CI, small fixes) runs fine on Sonnet at half the price: use Sonnet subagents or a Sonnet session for it.',
    })
  }
  return tips
}
