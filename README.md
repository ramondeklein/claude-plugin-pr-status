# pr-status

A Claude Code plugin that keeps a pane beside the chat with the status of the
GitHub pull request the session is working on.

## What it shows

- The PR's title and URL (click to open), its head and base branch.
- Every reviewer with a status: not reviewed, commented, changes requested,
  approved or lost approval (a dismissed approval). In author mode, each
  reviewer also shows the commits pushed since their latest review.
- The number of unresolved review threads.
- The merge status: up-to-date, behind the base branch, or conflicts.
- The CI status of the latest commit: the number of failed, pending and
  passed checks, each shown only when it is not zero. Skipped checks are not
  counted.

## Author and reviewer mode

You are in **author mode** when you opened the PR or are assigned to it:

- Click "lost approval" or "changes requested" to request that reviewer's
  review again. CodeRabbit is asked with an `@coderabbitai review` comment;
  other bots can't be asked through GitHub's API, so they are not clickable.
- Click the open review remarks count to have Claude merge the base branch
  and then address the unresolved threads.
- Click "behind" or "conflicts" to have Claude merge the base branch.

Otherwise you are in **reviewer mode**: the pane shows your own review state
(not reviewed, approved, approval lost or commented), when you reviewed, the
commits pushed since, and a **Review again** button.

## Which PR it follows

By default, the PR of the current branch. It switches to a PR when a prompt
names one (a URL or `owner/repo#N`), when Claude runs `gh pr <command> <N>` or
`gh api .../pulls/<N>`, uses the GitHub MCP tools on a PR, or creates one with
`gh pr create`.

- `/pr-status` opens the pane.
- `/pr-status <url | owner/repo#N | N>` pins a PR.
- `/pr-status auto` follows the current branch's PR again.
- `/pr-status refresh` refreshes now. It also refreshes every 60 seconds and
  after each turn.

## Requirements

The [GitHub CLI](https://cli.github.com/) (`gh`), signed in with `gh auth login`.

## Settings

In `/config`:

- **Poll interval**: seconds between refreshes (default 60).
- **Review-again prompt**: sent by Review again, default `/review-pr {url}`.
  A leading `/name` runs that slash command; change it if you have no
  `/review-pr` command.
- **Address-remarks prompt** and **Merge-base prompt**: what Claude is asked
  to do when you click the remarks count or the merge status.

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
