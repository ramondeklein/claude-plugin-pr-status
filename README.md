# pr-status

A Claude Code plugin that keeps a pane beside the chat with the status of the
GitHub pull request the session is working on.

## What it shows

- The PR's title and URL (click to open), its head and base branch.
- Every reviewer with a status: not reviewed, commented, changes requested,
  approved or lost approval (a dismissed approval), and the number of open
  review threads they started. In author mode, each reviewer also
  shows the commits pushed since their latest review.
- The total number of open review threads. A thread is open while it is
  unresolved and its last comment is not ours (the PR author's, or yours
  when you are an assignee): a thread we replied to waits on the reviewer.
- The merge status: up-to-date, behind the base branch, or conflicts.
- The CI status of the latest commit: the number of failed, pending and
  passed checks, each shown only when it is not zero. Skipped checks are not
  counted. Below it, each GitHub Actions run that failed or still runs, with
  its URL; when none do, the PR's Checks page. Click the failed count to
  re-run the failed jobs of the failed runs.
- A merged or closed PR: a framed banner under the title, **MERGED** (into
  which branch, by whom, when) or **CLOSED** (without merging, when), and the
  pane's title ends in `- MERGED` or `- CLOSED`. The pane then shows only
  the title, the banner and the URL, since nothing else about the PR matters
  any more: no reviewers, remarks, merge state, CI or reviews. The Session
  section stays. When the pane
  sees an open PR become merged or closed, it also shows a toast and opens
  the pane again if you closed it.

## Session context and cost

Under the PR, the **Session** section shows:

- The context in use, out of the model's window, and the model. It is
  green under 150k tokens, yellow up to 200k and red above that.
- The session's cost so far, the last turn's cost, how much of the last
  turn's input came from the prompt cache, and how long the session has been
  idle against the cache's lifetime.

Below these figures it gives tips when they apply, based on what drives
Claude Code spend:

- **Context over 200k.** Every turn reads the whole context again, so a turn
  at 300k costs about three times as much as one at 100k. Finish the task and
  start the next one in a fresh session, or click **compact**. A warning
  shows from 150k.
- **Cache about to expire, or expired.** After the cache lifetime (60
  minutes by default) of idle time, the next prompt writes the whole context
  to the cache again, at twice the input price. After a long wait, a fresh
  session with a short handoff costs less.
- **Low cache hit rate on the last turn.**
- **Opus for routine work.** Merges, CI and small fixes run fine on Sonnet at
  half the price.

## Author and reviewer mode

You are in **author mode** when you opened the PR or are assigned to it:

- Click "lost approval" or "changes requested" to request that reviewer's
  review again. CodeRabbit is asked with an `@coderabbitai review` comment;
  other bots can't be asked through GitHub's API, so they are not clickable.
- Click the open review remarks count to address the open threads, push,
  and reply to each one; click a reviewer's open count to address only the
  threads that reviewer started. This runs in a subagent of its own, a fresh
  context holding only the task, so its many turns do not each read your
  session's conversation again. Unless the branch is up to date with its
  base, the merge subagent (below) merges the base first and the remarks
  subagent starts when it ends. The pane shows each step while it runs and a
  toast with the outcome when it ends; the main conversation is not used.
- Click "behind" or "conflicts" to merge the base branch and resolve the
  conflicts. This runs as a background subagent on Sonnet (the **Merge
  model** setting), not on the session's model: merging is routine work and
  Sonnet costs half as much as Opus. The pane shows the merge while it runs and
  a toast with its outcome when it ends; the merge is committed, not pushed.

Otherwise you are in **reviewer mode**: the pane shows your own review state
(not reviewed, approved, approval lost or commented), when you reviewed, the
commits pushed since, and a **Review again** button.

## Which PR it follows

The pane picks the PR from these sources. A source replaces the PR shown
only when it ranks at least as high:

1. A PR you pin with `/pr-status <url | owner/repo#N | N>`.
2. A PR Claude creates in this session with `gh pr create`.
3. The PR the conversation opened with: the first full PR URL
   (`https://github.com/<owner>/<repo>/pull/<N>`) in the first 10 lines of
   its first user messages, such as `/maintain-pr <url>` or "review <url>".
   System reminders are skipped.
4. A PR a later prompt names, as a URL or `owner/repo#N`.
5. The PR of the current branch.
6. A PR a tool call touches: `gh pr <command> <N>`, `gh api .../pulls/<N>`
   or the GitHub MCP tools.

So a PR Claude only looks at along the way never replaces the PR the
conversation is about.

- `/pr-status` opens the pane.
- `/pr-status <url | owner/repo#N | N>` pins a PR.
- `/pr-status auto` drops a pin and follows the conversation's opening PR
  again, or else the current branch's PR.
- `/pr-status refresh` refreshes now. It also refreshes every 60 seconds and
  after each turn.

## Plugin version

The last line of the pane names the commit of the plugin that runs:
`pr-status 1a2b3c4 (latest)`. It is read from git when the plugin runs from
a checkout (`--plugin-dir`), with `-dirty` for uncommitted changes, and from
Claude Code's install record otherwise. It is compared with the newest
commit of the plugin's GitHub repository: an installed plugin that is behind
shows `update available: <commit> (/plugin update pr-status)`. It is read
when the session starts and on `/pr-status refresh`.

## Requirements

The [GitHub CLI](https://cli.github.com/) (`gh`), signed in with `gh auth login`.

## Settings

In `/config`:

- **Poll interval**: seconds between refreshes (default 60).
- **Review-again prompt**: sent by Review again, default `/review-pr {url}`.
  A leading `/name` runs that slash command; change it if you have no
  `/review-pr` command.
- **Address-remarks prompt**: the task of the remarks subagent when you
  click the remarks count. It starts with no other context.
- **Address model**: the model of that subagent; empty (the default) for the
  session's model.
- **Merge-base prompt**: the task of the merge subagent when you click the
  merge status.
- **Merge model**: the model of that subagent, default `sonnet`.
- **Prompt cache lifetime**: in minutes, default 60 (the 1-hour cache); set 5
  for the 5-minute cache.

## Install

At the prompt of a terminal session:

```
/plugin install pr-status --marketplace ramondeklein/claude-plugin-pr-status
```

Answer `y` to add the marketplace, then choose a scope.

From a shell:

```
claude plugin install pr-status --marketplace ramondeklein/claude-plugin-pr-status
```

In the desktop app, where `/plugin` does not run: click + next to the prompt
box, then Plugins, Add marketplace with `ramondeklein/claude-plugin-pr-status`,
then Add plugin.
