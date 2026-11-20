// Local git, as the runner needs it around a build job: fetch the base, spot a leftover branch,
// read the branch's commits afterwards. T3 worktrees share their repo's refs, so the repo's own
// path sees the job's branch.
//
// Ported from `queue_runner/git.py` (#216): the same git commands, the same answers, the same
// names (snake_case, as Python has them), with `tests/test_git.py` ported case for case in
// `test/git-seam.test.ts`.
//
// Differences that are TypeScript's only. `run_git` and every call are async: Node runs a child
// process without blocking, where Python's lanes block on their own threads. Python's tuples are
// arrays (`[code, out, err]`, `[tip, uncommitted]`, `[status, path]`) and its `None` is `null`.
// A git that can't start, or runs past the timeout, rejects with Node's own error, as Python
// raises `FileNotFoundError` or `TimeoutExpired`; only a non-zero exit is an answer.
import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join, normalize, parse } from 'node:path';

export class GitError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'GitError';
  }
}

/** What git answered: its exit code, stdout and stderr. */
export type Run = (args: string[]) => Promise<[number, string, string]>;

/** A commit as `commits`, `log` and `first_parent` read it: `{sha, subject}` zipped from one
 *  `%H<tab>%s` line, so a line with no tab has no subject, as in Python. */
export type Commit = { sha: string; subject?: string };

/** Python's text mode reads `\r\n` and a lone `\r` as `\n` (universal newlines). */
const universal = (s: string) => s.replace(/\r\n?/g, '\n');

export const run_git: Run = (args) => new Promise((resolve, reject) => {
  const child = execFile('git', args, { encoding: 'utf8', timeout: 300_000, maxBuffer: Infinity, windowsHide: true },
    (error, stdout, stderr) => {
      if (!error) return resolve([0, universal(stdout), universal(stderr)]);
      if (typeof error.code === 'number') return resolve([error.code, universal(stdout), universal(stderr)]);
      reject(error);
    });
  child.stdin?.on('error', () => {}); // a git that never started: its error is the exit's
  child.stdin?.end();                 // Python's stdin=DEVNULL
});

/** One blob's bytes, as `evidence` reads it in Python: its own `subprocess.run`, binary, 120s. */
const cat_file = (path: string, spec: string) => new Promise<[number, Buffer, Buffer]>((resolve, reject) => {
  const child = execFile('git', ['-C', path, 'cat-file', 'blob', spec],
    { encoding: 'buffer', timeout: 120_000, maxBuffer: Infinity, windowsHide: true },
    (error, stdout, stderr) => {
      if (!error) return resolve([0, stdout, stderr]);
      if (typeof error.code === 'number') return resolve([error.code, stdout, stderr]);
      reject(error);
    });
  child.stdin?.on('error', () => {});
  child.stdin?.end();
});

const LINE_BREAK = new RegExp(String.raw`\r\n|[\n\r\v\f\x1c\x1d\x1e\x85${String.fromCharCode(0x2028, 0x2029)}]`);

/** Python's `str.splitlines()`: every line boundary it knows, the last line's end dropped. */
function splitlines(s: string): string[] {
  const lines = s.split(LINE_BREAK);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Python's `str.strip()` with no argument: whitespace, as Python counts it, off both ends. */
const SPACE = '[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const STRIP = new RegExp(`^${SPACE}+|${SPACE}+$`, 'g');
const strip = (s: string) => s.replace(STRIP, '');

/** Python's `sorted()` of strings: by code point. */
const by_code_point = (a: string, b: string) => {
  const x = Array.from(a, (c) => c.codePointAt(0)!), y = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
};

/** `str.split('\t', 1)` zipped with ('sha', 'subject'). */
function commit(line: string): Commit {
  const tab = line.indexOf('\t');
  return tab < 0 ? { sha: line } : { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
}

/** `os.path.exists`: follows links; false on any error. */
const exists = (p: string) => stat(p).then(() => true, () => false);

/** `os.path.isdir`. */
const isdir = (p: string) => stat(p).then((s) => s.isDirectory(), () => false);

/** `deps.py`'s `Deps.unlink`, which `remove_checkout` calls: removes the checkout's node_modules
 *  link (a junction or a symlink: Node's `lstat` sees both as a link), never what it points to.
 *  #221 ports the rest of `deps.py`. */
async function _unlink_modules(worktree: string): Promise<void> {
  const link = join(worktree, 'node_modules');
  const st = await lstat(link).catch(() => null);
  if (st?.isSymbolicLink()) await unlink(link);
}

/** `shutil.rmtree(folder, ignore_errors=True)`: deletes what it can, links without following
 *  them, and carries on past what it can't. */
async function _rmtree(folder: string): Promise<void> {
  const st = await lstat(folder).catch(() => null);
  if (!st) return;
  if (st.isDirectory() && !st.isSymbolicLink()) {
    const names = await readdir(folder).catch(() => [] as string[]);
    for (const name of names) await _rmtree(join(folder, name));
    await rmdir(folder).catch(() => {});
  } else {
    await unlink(folder).catch(() => {});
  }
}

/** `datetime.now():%Y%m%d-%H%M%S`, this PC's local time. */
function stamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

export class GitCli {
  private _run: Run;
  constructor(run: Run = run_git) {
    this._run = run;
  }

  private async _ok(args: string[]): Promise<string> {
    const [code, out, err] = await this._run(args);
    if (code) throw new GitError(`git ${args.join(' ')} failed (${code}): ${strip(err)}`);
    return out;
  }

  /** Updates `origin/<branch>`: T3 makes a job's worktree from it without fetching. */
  async fetch(path: string, branch: string): Promise<void> {
    await this._ok(['-C', path, 'fetch', '--quiet', 'origin', branch]);
  }

  async has_branch(path: string, branch: string): Promise<boolean> {
    const [code] = await this._run(['-C', path, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return code === 0;
  }

  private async _ref(path: string, ref: string): Promise<string | null> {
    const [code, out] = await this._run(['-C', path, 'rev-parse', '--verify', '--quiet', ref]);
    return code === 0 ? strip(out) : null;
  }

  /** Frees a job's branch and its worktree's folder for a fresh T3 worktree after a usage
   *  limit: T3 can't make a worktree on a branch that exists, and it makes it at the same
   *  folder (`~/.t3/worktrees/<project>/<branch>`). Keeps the branch's tip under
   *  `refs/queue-runner/limit/<branch>` and anything left uncommitted (untracked files
   *  included) as a stash-like commit under `.../<branch>-uncommitted`, removes the old
   *  worktree and deletes the branch, so T3 makes it again at the tip.
   *
   *  Returns [tip, uncommitted]: the kept ones if the branch is gone already (an earlier try
   *  whose thread never started); null for either there isn't. Raises GitError if the old
   *  worktree can't be removed. */
  async free_branch(path: string, branch: string, worktree: string | null): Promise<[string | null, string | null]> {
    const keep = `refs/queue-runner/limit/${branch}`, wip_ref = `refs/queue-runner/limit/${branch}-uncommitted`;
    const tip = await this._ref(path, `refs/heads/${branch}`);
    if (tip === null) return [await this._ref(path, keep), await this._ref(path, wip_ref)];
    await this._ok(['-C', path, 'update-ref', keep, tip]);
    let wip: string | null = null;
    if (worktree && await isdir(worktree)) {
      if (strip(await this._ok(['-C', worktree, 'status', '--porcelain']))) {
        await this._ok(['-C', worktree, 'add', '-A']);
        wip = strip(await this._ok(['-C', worktree, 'stash', 'create',
          'left uncommitted by a thread a usage limit cut off'])) || null;
        if (wip) await this._ok(['-C', path, 'update-ref', wip_ref, wip]);
      }
      if (!(await this.remove_worktree(path, worktree))) {
        throw new GitError(`the old worktree ${worktree} could not be removed`);
      }
    }
    await this._run(['-C', path, 'worktree', 'prune']);
    if (await this._ref(path, `refs/heads/${branch}`)) await this._ok(['-C', path, 'branch', '-D', branch]);
    return [tip, wip];
  }

  /** The branch's commits not on `base`, oldest first: [{sha, subject}]. */
  async commits(path: string, base: string, branch: string): Promise<Commit[]> {
    if (!(await this.has_branch(path, branch))) return [];
    const out = await this._ok(['-C', path, 'log', '--reverse', '--format=%H%x09%s', `${base}..refs/heads/${branch}`]);
    return splitlines(out).filter((line) => line).map(commit);
  }

  // --- a review's checkout ------------------------------------------------------------------

  /** Fetches the PR's head into a runner ref, and its base branch. Returns [ref, sha]. */
  async fetch_pr(path: string, number: number, base: string): Promise<[string, string]> {
    const ref = `refs/queue-runner/pr${number}`;
    await this._ok(['-C', path, 'fetch', '--quiet', 'origin', `+refs/pull/${number}/head:${ref}`,
      `+refs/heads/${base}:refs/remotes/origin/${base}`]);
    return [ref, strip(await this._ok(['-C', path, 'rev-parse', ref]))];
  }

  /** Copies the PR's screenshots, `pr-<number>/` on the repo's `evidence` branch
   *  (`templates/build.md`, Screenshots), into `dest`; returns their names. No branch or none: [].
   *  Raises GitError when origin can't be read (network, auth): that isn't "none published",
   *  which would block the PR for shots it has (PR #114 review 1, F2), so the review fails and
   *  is tried again. */
  async evidence(path: string, number: number, dest: string): Promise<string[]> {
    const ref = 'refs/queue-runner/evidence';
    const [code, , err] = await this._run(['-C', path, 'ls-remote', '--exit-code', '--heads', 'origin',
      'refs/heads/evidence']);
    if (code === 2) return [];   // origin answered and has no such branch
    if (code) throw new GitError(`git ls-remote origin evidence failed (${code}): ${strip(err)}`);
    await this._ok(['-C', path, 'fetch', '--quiet', 'origin', `+refs/heads/evidence:${ref}`]);
    const names = splitlines(await this._ok(['-C', path, 'ls-tree', '--name-only', ref, `pr-${number}/`]))
      .filter((n) => n);
    const last = (n: string) => n.slice(n.lastIndexOf('/') + 1);
    for (const name of names) {
      const [blob_code, blob, blob_err] = await cat_file(path, `${ref}:${name}`);
      if (blob_code) throw new GitError(`git cat-file ${name} failed: ${strip(blob_err.toString('utf8'))}`);
      await mkdir(dest, { recursive: true });
      await writeFile(join(dest, last(name)), blob);
    }
    return names.map(last).sort(by_code_point);
  }

  /** A detached worktree at `ref` for Sol to read, made afresh. Returns where a leftover
   *  at `worktree` was moved aside, if it was (`remove_checkout`). */
  async checkout(path: string, ref: string, worktree: string): Promise<string | null> {
    const moved = await this.remove_checkout(path, worktree);
    await this._ok(['-C', path, 'worktree', 'add', '--detach', worktree, ref]);
    return moved;
  }

  /** Removes Sol's checkout. A folder git unregistered but couldn't delete (owner-only
   *  folders Sol's sandbox user left: docs/reviews.md, Sol runs tests) is moved aside to
   *  `<worktree>.stale-<time>`, so the next `worktree add` finds the path free; returns where
   *  it went, else null. `sweep_stale` deletes it later if it can. */
  async remove_checkout(path: string, worktree: string, ref: string | null = null): Promise<string | null> {
    let moved: string | null = null;
    if (await exists(worktree)) {
      // First: git follows the node_modules junction and empties the dependency cache.
      await _unlink_modules(worktree);
      await this._run(['-C', path, 'worktree', 'remove', '--force', worktree]);
      if (await exists(worktree)) {
        const stale = `${worktree}.stale-${stamp(new Date())}`;
        moved = stale;
        let n = 1;
        while (await exists(moved)) {
          n += 1;
          moved = `${stale}-${n}`;
        }
        await rename(worktree, moved);
      }
    }
    await this._run(['-C', path, 'worktree', 'prune']);
    if (ref) await this._run(['-C', path, 'update-ref', '-d', ref]);
    return moved;
  }

  /** Deletes the checkouts `remove_checkout` moved aside, where it can. Returns the ones
   *  still there (their owner-only folders can't be deleted by Stefan's account). */
  static async sweep_stale(checkouts_dir: string): Promise<string[]> {
    let names: string[];
    try {
      names = (await readdir(checkouts_dir)).sort(by_code_point);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const kept: string[] = [];
    for (const name of names) {
      const folder = join(checkouts_dir, name);
      if (name.includes('.stale-') && await isdir(folder)) {
        await _rmtree(folder);
        if (await exists(folder)) kept.push(folder);
      }
    }
    return kept;
  }

  /** Whether `older` is in `newer`'s history; false for a commit this clone lacks. */
  async is_ancestor(path: string, older: string, newer: string): Promise<boolean> {
    return (await this._run(['-C', path, 'merge-base', '--is-ancestor', older, newer]))[0] === 0;
  }

  /** `git diff a..b`, or with `merge_base` the PR-style `a...b` (from where b left a). */
  diff(path: string, a: string, b: string, merge_base = false): Promise<string> {
    return this._ok(['-C', path, 'diff', merge_base ? `${a}...${b}` : a, ...(merge_base ? [] : [b])]);
  }

  // --- a fix round, and after a merge -------------------------------------------------------

  /** The commits in `b` not in `a`, oldest first: [{sha, subject}]. */
  async log(path: string, a: string, b: string): Promise<Commit[]> {
    const out = await this._ok(['-C', path, 'log', '--reverse', '--format=%H%x09%s', `${a}..${b}`]);
    return splitlines(out).filter((line) => line).map(commit);
  }

  /** `git diff --stat a...b`: the files a PR changes, from where b left a. */
  diffstat(path: string, a: string, b: string): Promise<string> {
    return this._ok(['-C', path, 'diff', '--stat', `${a}...${b}`]);
  }

  /** Removes a job's worktree and its local branch. True once git no longer lists the
   *  worktree: T3 can hold the empty folder open, so `worktree remove` may fail after git
   *  has unregistered it and deleted its files (docs/t3.md). */
  async remove_worktree(path: string, worktree: string, branch: string | null = null): Promise<boolean> {
    await this._run(['-C', path, 'worktree', 'remove', '--force', worktree]);
    await this._run(['-C', path, 'worktree', 'prune']);
    const listed = await this._ok(['-C', path, 'worktree', 'list', '--porcelain']);
    const want = _same_path(worktree);
    const gone = !splitlines(listed).some((line) => line.startsWith('worktree ')
      && _same_path(line.slice('worktree '.length)) === want);
    if (gone && branch) await this._run(['-C', path, 'branch', '-D', branch]);
    return gone;
  }

  // --- live steps after merges ----------------------------------------------------------------

  async sha(path: string, ref: string): Promise<string> {
    return strip(await this._ok(['-C', path, 'rev-parse', '--verify', `${ref}^{commit}`]));
  }

  /** The commits on `b`'s first-parent line since `a`, oldest first (a merged PR is one
   *  merge commit): [{sha, subject}]. */
  async first_parent(path: string, a: string, b: string): Promise<Commit[]> {
    const out = await this._ok(['-C', path, 'log', '--reverse', '--first-parent', '--format=%H%x09%s', `${a}..${b}`]);
    return splitlines(out).filter((line) => line).map(commit);
  }

  /** The files `b` changed since `a`: [[status letter, path]], renames as their new path. */
  async name_status(path: string, a: string, b: string): Promise<[string, string][]> {
    const out = await this._ok(['-C', path, 'diff', '--name-status', '--no-renames', a, b]);
    const found: [string, string][] = [];
    for (const line of splitlines(out)) {
      const parts = line.split('\t');
      if (parts.length >= 2) found.push([parts[0]!.slice(0, 1), parts[parts.length - 1]!]);
    }
    return found;
  }
}

/** `os.path.normcase(os.path.normpath(p.strip()))`: on Windows, separators as `\`, `.` and `..`
 *  resolved, a trailing separator dropped, and lower case. */
function _same_path(p: string): string {
  let n = normalize(strip(p));
  const root = parse(n).root;
  while (n.length > root.length && /[\\/]$/.test(n)) n = n.slice(0, -1);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}
