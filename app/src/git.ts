// Local git in a served repo's folder (today's `queue_runner/git.py`). Around a build (#154): T3
// makes the job's worktree from `origin/<base>` but doesn't fetch first, and fails on a leftover
// local branch of the job's name (docs/t3.md). Around a review (#155): the PR's head fetched and
// checked out detached for the reviewer, the diffs, the PR's screenshots. A seam the tests fake.
import { execFile } from 'node:child_process';
import { lstat, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

/** git failed: not installed, not a repository, offline, or anything else it refused. */
export class GitError extends Error {}

export interface Git {
  /** Fetches `origin/<base>`, so the worktree starts from GitHub's newest. */
  fetch(folder: string, base: string): Promise<void>;
  /** Whether a local branch of this name exists. */
  hasBranch(folder: string, branch: string): Promise<boolean>;
}

/** What the review lane does with git (#155; today's `GitCli`'s review half): the PR's head
 *  fetched, a detached checkout of it, the diffs and the PR's screenshots. */
export interface ReviewGit {
  /** Fetches the PR's head into `refs/queue-runner/pr<n>` and `origin/<base>`; the head's sha. */
  fetchPr(folder: string, n: number, base: string): Promise<string>;
  /** A detached worktree of `ref` at `dir`, made afresh (a leftover there is removed first). */
  checkout(folder: string, ref: string, dir: string): Promise<void>;
  /** Removes the checkout, its `node_modules` link first, and the PR's ref. Never throws. */
  removeCheckout(folder: string, dir: string, ref?: string): Promise<void>;
  /** Whether `older` is in `newer`'s history (false for a commit the clone lacks). */
  isAncestor(folder: string, older: string, newer: string): Promise<boolean>;
  /** `git diff a b`, or with `mergeBase` the PR's own `a...b`. */
  diff(folder: string, a: string, b: string, mergeBase?: boolean): Promise<string>;
  /** The PR's screenshots, `pr-<n>/` on origin's `evidence` branch, written into `dest`; their
   *  names. No branch, or none there: []. A GitError when origin can't be read: that isn't "none
   *  published", which would block a PR for shots it has. */
  evidence(folder: string, n: number, dest: string): Promise<string[]>;
}

export const prRef = (n: number) => `refs/queue-runner/pr${n}`;

type Run = (args: string[], cwd: string) => Promise<{ code: number; stdout?: string; stderr: string }>;
/** One blob's bytes (`git cat-file blob`): binary, so not through Run's text. */
type Blob = (folder: string, spec: string) => Promise<Buffer>;

const MAX = 256 * 1024 * 1024;

const gitRun: Run = (args, cwd) => new Promise((resolve) => {
  execFile('git', args, { cwd, timeout: 120_000, maxBuffer: MAX, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      resolve({ code, stdout: String(stdout), stderr: (error && typeof error.code !== 'number' ? `${error.message}\n` : '') + String(stderr) });
    });
});

const firstLine = (text: string) => text.trim().split(/\r?\n/)[0] || 'no message';

const gitBlob: Blob = (folder, spec) => new Promise((resolve, reject) => {
  execFile('git', ['cat-file', 'blob', spec], { cwd: folder, encoding: 'buffer', timeout: 120_000, maxBuffer: MAX, windowsHide: true },
    (error, stdout, stderr) => (error ? reject(new GitError(`git cat-file ${spec} failed: ${firstLine(String(stderr))}`)) : resolve(stdout)));
});

export class GitCli implements Git, ReviewGit {
  private run: Run;
  private blob: Blob;
  constructor(run: Run = gitRun, blob: Blob = gitBlob) {
    this.run = run;
    this.blob = blob;
  }

  private async ok(folder: string, args: string[]): Promise<string> {
    const { code, stdout, stderr } = await this.run(args, folder);
    if (code !== 0) throw new GitError(`git ${args.slice(0, 2).join(' ')} failed (${code}) in ${folder}: ${firstLine(stderr)}`);
    return stdout ?? '';
  }

  async fetch(folder: string, base: string): Promise<void> {
    const { code, stderr } = await this.run(['fetch', '--quiet', 'origin', base], folder);
    if (code !== 0) throw new GitError(`git fetch origin ${base} failed (${code}) in ${folder}: ${firstLine(stderr)}`);
  }

  async hasBranch(folder: string, branch: string): Promise<boolean> {
    const { code, stderr } = await this.run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], folder);
    if (code === 0) return true;
    if (code === 1) return false;
    throw new GitError(`git rev-parse failed (${code}) in ${folder}: ${firstLine(stderr)}`);
  }

  async fetchPr(folder: string, n: number, base: string): Promise<string> {
    await this.ok(folder, ['fetch', '--quiet', 'origin', `+refs/pull/${n}/head:${prRef(n)}`, `+refs/heads/${base}:refs/remotes/origin/${base}`]);
    return (await this.ok(folder, ['rev-parse', prRef(n)])).trim();
  }

  async checkout(folder: string, ref: string, dir: string): Promise<void> {
    await this.removeCheckout(folder, dir);
    await this.ok(folder, ['worktree', 'add', '--detach', dir, ref]);
  }

  async removeCheckout(folder: string, dir: string, ref?: string): Promise<void> {
    // first: `git worktree remove --force` follows a node_modules junction and empties the
    // dependency cache it points at (checked 2026-11-10, docs/reviews.md)
    await unlinkModules(dir);
    await this.run(['worktree', 'remove', '--force', dir], folder);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    await this.run(['worktree', 'prune'], folder);
    if (ref) await this.run(['update-ref', '-d', ref], folder);
  }

  async isAncestor(folder: string, older: string, newer: string): Promise<boolean> {
    return (await this.run(['merge-base', '--is-ancestor', older, newer], folder)).code === 0;
  }

  diff(folder: string, a: string, b: string, mergeBase = false): Promise<string> {
    return this.ok(folder, ['diff', ...(mergeBase ? [`${a}...${b}`] : [a, b])]);
  }

  async evidence(folder: string, n: number, dest: string): Promise<string[]> {
    const ref = 'refs/queue-runner/evidence';
    const { code, stderr } = await this.run(['ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/evidence'], folder);
    if (code === 2) return []; // origin answered and has no such branch
    if (code !== 0) throw new GitError(`git ls-remote origin evidence failed (${code}) in ${folder}: ${firstLine(stderr)}`);
    await this.ok(folder, ['fetch', '--quiet', 'origin', `+refs/heads/evidence:${ref}`]);
    const names = (await this.ok(folder, ['ls-tree', '--name-only', ref, `pr-${n}/`])).split('\n').map((x) => x.trim()).filter(Boolean);
    if (names.length) await mkdir(dest, { recursive: true });
    for (const name of names) await writeFile(join(dest, basename(name)), await this.blob(folder, `${ref}:${name}`));
    return names.map((x) => basename(x)).sort();
  }
}

/** Removes a checkout's `node_modules` link, never what it points to. */
export async function unlinkModules(dir: string): Promise<void> {
  const link = join(dir, 'node_modules');
  const st = await lstat(link).catch(() => null);
  if (st?.isSymbolicLink()) await unlink(link);
}
