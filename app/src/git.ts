// Local git in a served repo's folder, around a build (#154; today's `queue_runner/git.py`):
// T3 makes the job's worktree from `origin/<base>` but doesn't fetch first, and fails on a
// leftover local branch of the job's name (docs/t3.md). A seam the tests fake.
import { execFile } from 'node:child_process';

/** git failed: not installed, not a repository, offline, or anything else it refused. */
export class GitError extends Error {}

export interface Git {
  /** Fetches `origin/<base>`, so the worktree starts from GitHub's newest. The refspec is named,
   *  so `refs/remotes/origin/<base>` is written whatever the clone's own refspec fetches (a
   *  single-branch clone of another branch writes only FETCH_HEAD otherwise). */
  fetch(folder: string, base: string): Promise<void>;
  /** Whether a local branch of this name exists. */
  hasBranch(folder: string, branch: string): Promise<boolean>;
}

type Run = (args: string[], cwd: string) => Promise<{ code: number; stderr: string }>;

const gitRun: Run = (args, cwd) => new Promise((resolve) => {
  execFile('git', args, { cwd, timeout: 120_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    (error, _stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      resolve({ code, stderr: (error && typeof error.code !== 'number' ? `${error.message}\n` : '') + String(stderr) });
    });
});

const firstLine = (text: string) => text.trim().split(/\r?\n/)[0] || 'no message';

export class GitCli implements Git {
  private run: Run;
  constructor(run: Run = gitRun) {
    this.run = run;
  }

  async fetch(folder: string, base: string): Promise<void> {
    const { code, stderr } = await this.run(['fetch', '--quiet', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], folder);
    if (code !== 0) throw new GitError(`git fetch origin ${base} failed (${code}) in ${folder}: ${firstLine(stderr)}`);
  }

  async hasBranch(folder: string, branch: string): Promise<boolean> {
    const { code, stderr } = await this.run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], folder);
    if (code === 0) return true;
    if (code === 1) return false;
    throw new GitError(`git rev-parse failed (${code}) in ${folder}: ${firstLine(stderr)}`);
  }
}
