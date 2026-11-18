// GitHub, through `gh` (the CLI T3 itself uses for GitHub). A seam the tests fake.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

export type Remote = { nameWithOwner: string; url: string };

/** gh couldn't answer: not signed in, offline, not installed, or anything else it refused. */
export class GitHubError extends Error {}

export interface GitHub {
  /** The GitHub repo a folder's git remote points at, or null when it has none (not a git
   *  folder, no remote on GitHub, or the folder is gone). A GitHubError when gh fails. */
  remoteOf(folder: string): Promise<Remote | null>;
}

/** One gh run: its exit code and both streams. A gh that can't be started (not installed) or
 *  is killed (the timeout) is a code that isn't 0, with why in `stderr`. */
export type Gh = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

export const ghAt = (program: string): Gh => (args, cwd) => new Promise((resolve) => {
  execFile(program, args, { cwd, timeout: 60_000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } },
    (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      const why = error && typeof error.code !== 'number' ? `${error.message}\n` : '';
      resolve({ code, stdout: String(stdout), stderr: why + String(stderr) });
    });
});
export const ghCli: Gh = ghAt('gh');

// What gh says, exit 1, for a folder with no GitHub repo (gh 2.x, seen live 2026-11-18).
// Anything else it fails with (exit 4 when not signed in, HTTP 401, offline) is a failure.
const NO_REPO = [
  /not a git repository/,
  /none of the git remotes configured for this repository point to a known GitHub host/,
  /no git remotes found/,
];

export class GhGitHub implements GitHub {
  private gh: Gh;
  private exists: (folder: string) => boolean;
  constructor(gh: Gh = ghCli, exists: (folder: string) => boolean = existsSync) {
    this.gh = gh;
    this.exists = exists;
  }

  async remoteOf(folder: string): Promise<Remote | null> {
    // A folder that's gone has no remote; gh can't even start there (ENOENT, like no gh).
    if (!this.exists(folder)) return null;
    const { code, stdout, stderr } = await this.gh(['repo', 'view', '--json', 'nameWithOwner,url'], folder);
    if (code !== 0) {
      if (code === 1 && NO_REPO.some((r) => r.test(stderr))) return null;
      throw new GitHubError(`gh repo view failed (${code}) in ${folder}: ${stderr.trim().split('\n')[0] || 'no message'}`);
    }
    let repo: any;
    try {
      repo = JSON.parse(stdout);
    } catch {
      throw new GitHubError(`gh repo view printed no JSON in ${folder}: ${stdout.slice(0, 200)}`);
    }
    if (typeof repo?.nameWithOwner !== 'string') throw new GitHubError(`gh repo view named no repo in ${folder}`);
    return { nameWithOwner: repo.nameWithOwner, url: repo.url };
  }
}
