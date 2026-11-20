// Which commit of this plugin runs, and the newest on GitHub, so the pane can
// say whether it is up to date. No `$` here, so tests can reach it.

/** `owner/repo` from a GitHub remote URL (https, ssh or scp form). */
export function githubRepo(url: string): string | null {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim())
  return m ? `${m[1]}/${m[2]}` : null
}

/** The plugins folder of an installed plugin's root (`<config>/plugins/cache/...`). */
export function pluginsDir(root: string): string | null {
  const at = root.indexOf('/plugins/cache/')
  return at < 0 ? null : root.slice(0, at + '/plugins'.length)
}

type InstallRecord = { installPath?: string; gitCommitSha?: string }

/**
 * The commit and GitHub repository of the install at `root`, from
 * `installed_plugins.json` and `known_marketplaces.json`.
 */
export function installedVersion(
  root: string,
  installedJson: string,
  marketplacesJson: string | null,
): { commit: string; repo: string | null } | null {
  const installed = JSON.parse(installedJson) as {
    plugins?: Record<string, InstallRecord[]>
  } & Record<string, unknown>
  const lists = (installed.plugins ?? installed) as Record<string, unknown>
  for (const [key, records] of Object.entries(lists)) {
    if (!Array.isArray(records)) continue
    const rec = (records as InstallRecord[]).find(r => r.installPath === root)
    if (!rec?.gitCommitSha) continue
    let repo: string | null = null
    const marketplace = key.split('@')[1]
    if (marketplace && marketplacesJson) {
      const known = JSON.parse(marketplacesJson) as Record<
        string,
        { source?: { source?: string; repo?: string; url?: string } }
      >
      const src = known[marketplace]?.source
      repo = src?.repo ?? (src?.url ? githubRepo(src.url) : null)
    }
    return { commit: rec.gitCommitSha, repo }
  }
  return null
}

export const short = (sha: string) => sha.slice(0, 7)
