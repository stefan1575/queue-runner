// GitHub, through `gh` (the CLI T3 itself uses for GitHub). A seam the tests fake.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

export type Remote = { nameWithOwner: string; url: string };

/** gh couldn't answer: not signed in, offline, not installed, or anything else it refused. */
export class GitHubError extends Error {}

export interface GitHub {
  /** The GitHub repo a folder's git remote points at, or null when it has none (not a git
   *  folder, no remote on GitHub, or the folder is gone). A GitHubError when gh fails. */
  remoteOf(folder: string): Promise<Remote | null>;
}

export type Account = { login: string; name: string | null };

export interface GitHubAccount {
  /** The account gh is signed in as: its login and the name set on it (null when none is). A
   *  GitHubError when gh fails. */
  account(): Promise<Account>;
}

const firstLine = (text: string) => text.trim().split(/\r?\n/)[0] || 'no message';

export type Label = { name: string; color: string; description: string };

export interface GitHubLabels {
  /** Every label's name in a repo (`owner/name`). A GitHubError when gh fails. */
  labelNames(repo: string): Promise<string[]>;
  /** Creates a label; one that's already there is left as it is. A GitHubError when gh fails. */
  createLabel(repo: string, label: Label): Promise<void>;
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

export class GhGitHub implements GitHub, GitHubAccount, GitHubLabels {
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

  async account(): Promise<Account> {
    const { code, stdout, stderr } = await this.gh(['api', 'user'], homedir());
    if (code !== 0) throw new GitHubError(`gh api user failed (${code}): ${stderr.trim().split('\n')[0] || 'no message'}`);
    let user: any;
    try {
      user = JSON.parse(stdout);
    } catch {
      throw new GitHubError(`gh api user printed no JSON: ${stdout.slice(0, 200)}`);
    }
    if (typeof user?.login !== 'string') throw new GitHubError('gh api user named no login');
    return { login: user.login, name: typeof user.name === 'string' && user.name.trim() ? user.name.trim() : null };
  }

  async labelNames(repo: string): Promise<string[]> {
    const { code, stdout, stderr } = await this.gh(['label', 'list', '--repo', repo, '--json', 'name', '--limit', '1000'], homedir());
    if (code !== 0) throw new GitHubError(`gh label list failed (${code}) for ${repo}: ${firstLine(stderr)}`);
    let labels: any;
    try {
      labels = JSON.parse(stdout);
    } catch {
      throw new GitHubError(`gh label list printed no JSON for ${repo}: ${stdout.slice(0, 200)}`);
    }
    if (!Array.isArray(labels)) throw new GitHubError(`gh label list printed no list for ${repo}`);
    return labels.map((l) => l?.name).filter((n): n is string => typeof n === 'string');
  }

  async createLabel(repo: string, label: Label): Promise<void> {
    const { code, stderr } = await this.gh(
      ['label', 'create', label.name, '--repo', repo, '--color', label.color, '--description', label.description], homedir());
    // made meanwhile by someone else: it's there, and it's theirs to keep as it is
    if (code === 0 || /already exists/.test(stderr)) return;
    throw new GitHubError(`gh label create ${label.name} failed (${code}) for ${repo}: ${firstLine(stderr)}`);
  }
}
