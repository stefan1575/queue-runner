// GitCli against a real local git repo in a temp folder (no network): a fix round's commits and
// files, and removing a job's worktree and branch after its PR merged. Ported from
// `tests/test_git.py` case for case (#216).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GitCli, GitError } from '../src/git-seam.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** `addCleanup`: run after each test, newest first. */
let cleanups: (() => unknown)[] = [];
const addCleanup = (f: () => unknown) => cleanups.push(f);

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Makes `folder` (and a file in it) undeletable by anyone, as the folders Sol's sandbox
 *  user leaves are for Stefan; undone at the test's end so the temp folder can go. */
async function deny_delete(folder: string): Promise<void> {
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'f.txt'), 'x');
  execFileSync('icacls', [folder, '/deny', '*S-1-1-0:(OI)(CI)(DE,DC)'], { stdio: 'pipe' });
  addCleanup(() => spawnSync('icacls', [folder, '/remove:d', '*S-1-1-0'], { stdio: 'pipe' }));
}

/** Sets Windows' read-only attribute on `path` (on a link itself, not what it points to);
 *  cleared at the test's end so the temp folder can go. */
function read_only(path: string): void {
  execFileSync('attrib', ['+R', path, '/L'], { stdio: 'pipe' });
  addCleanup(() => spawnSync('attrib', ['-R', path, '/L'], { stdio: 'pipe' }));
}

describe('GitCliTest', () => {
  let repo: string, base: string, wt: string, head: string, cli: GitCli;

  async function commit(name: string, text: string, subject: string, cwd = repo) {
    await writeFile(join(cwd, name), text);
    git(cwd, 'add', name);
    git(cwd, 'commit', '-q', '-m', subject);
  }

  beforeEach(async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'qr-git-seam-'));
    addCleanup(() => rm(tmp, { recursive: true, force: true }));
    repo = join(tmp, 'repo');
    await mkdir(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'T');
    await commit('a.txt', 'one', 'First');
    base = git(repo, 'rev-parse', 'HEAD');
    wt = join(tmp, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'claude/x-1', wt);
    await commit('b.txt', 'two', 'Add b', wt);
    head = git(wt, 'rev-parse', 'HEAD');
    cli = new GitCli();
  });

  test('test_log_and_diffstat_between_two_commits', async () => {
    expect(await cli.log(repo, base, head)).toStrictEqual([{ sha: head, subject: 'Add b' }]);
    expect(await cli.diffstat(repo, base, head)).toContain('b.txt');
  });

  test('test_a_merged_pr_on_the_first_parent_line_and_its_files', async () => {
    git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #7 from o/claude/x-1', 'claude/x-1');
    const merge = git(repo, 'rev-parse', 'HEAD');
    expect(await cli.sha(repo, 'main')).toBe(merge);
    expect(await cli.first_parent(repo, base, merge))
      .toStrictEqual([{ sha: merge, subject: 'Merge pull request #7 from o/claude/x-1' }]);
    expect(await cli.name_status(repo, base, merge)).toStrictEqual([['A', 'b.txt']]);
  });

  test('test_a_worktree_and_its_branch_are_removed', async () => {
    expect(await cli.remove_worktree(repo, wt.replace(/\\/g, '/'), 'claude/x-1')).toBe(true);
    expect(existsSync(join(wt, 'b.txt'))).toBe(false);
    expect(await cli.has_branch(repo, 'claude/x-1')).toBe(false);
  });

  test('test_removing_a_review_checkout_keeps_what_its_node_modules_links_to', async () => {
    // git worktree remove --force follows a junction and empties its target (ticket 16): the
    // dependency cache behind a checkout's node_modules must survive.
    const cache = join(dirname(repo), 'cache', 'node_modules');
    await mkdir(join(cache, 'react'), { recursive: true });
    const checkout = join(dirname(repo), 'checkout');
    await cli.checkout(repo, head, checkout);
    await symlink(cache, join(checkout, 'node_modules'), 'junction');
    await cli.checkout(repo, head, checkout);   // made afresh: the old one removed
    await symlink(cache, join(checkout, 'node_modules'), 'junction');
    await cli.remove_checkout(repo, checkout);
    expect(existsSync(checkout)).toBe(false);
    expect(statSync(join(cache, 'react')).isDirectory()).toBe(true);
  });

  test('a read-only node_modules link fails the removal before git runs', async () => {
    // Python's `Deps.unlink` calls `os.rmdir`, which raises PermissionError on a read-only
    // junction: the checkout stays, still registered, and the cache behind it is untouched.
    const cache = join(dirname(repo), 'cache', 'node_modules');
    await mkdir(join(cache, 'react'), { recursive: true });
    const checkout = join(dirname(repo), 'checkout');
    await cli.checkout(repo, head, checkout);
    const link = join(checkout, 'node_modules');
    await symlink(cache, link, 'junction');
    read_only(link);
    await expect(cli.remove_checkout(repo, checkout)).rejects.toMatchObject({ code: 'EPERM', path: link });
    expect(statSync(join(checkout, 'b.txt')).isFile()).toBe(true);
    expect(git(repo, 'worktree', 'list')).toContain('checkout');
    expect(statSync(join(cache, 'react')).isDirectory()).toBe(true);
  });

  test('test_a_limited_jobs_branch_and_folder_are_freed_for_t3_to_make_again', async () => {
    await writeFile(join(wt, 'b.txt'), 'half done');   // left uncommitted by the thread the limit cut off
    await writeFile(join(wt, 'new.txt'), 'untracked');
    const [tip, wip] = await cli.free_branch(repo, 'claude/x-1', wt);
    expect(tip).toBe(head);
    expect(await cli.has_branch(repo, 'claude/x-1')).toBe(false);
    // What it left is kept in a commit, untracked files too.
    expect(git(repo, 'show', `${wip}:b.txt`)).toBe('half done');
    expect(git(repo, 'show', `${wip}:new.txt`)).toBe('untracked');
    // T3 makes the same branch again, at the tip, in the same folder.
    git(repo, 'worktree', 'add', '-q', '-b', 'claude/x-1', wt, tip!);
    expect(readFileSync(join(wt, 'b.txt'), 'utf8')).toBe('two');
    // A second try (T3 failed to start the first time) finds what it kept.
    git(repo, 'worktree', 'remove', '--force', wt);
    git(repo, 'branch', '-D', 'claude/x-1');
    expect(await cli.free_branch(repo, 'claude/x-1', wt)).toStrictEqual([tip, wip]);
  });

  test('test_a_clean_worktree_leaves_nothing_uncommitted', async () => {
    expect(await cli.free_branch(repo, 'claude/x-1', wt)).toStrictEqual([head, null]);
    expect(existsSync(join(wt, 'b.txt'))).toBe(false);
  });

  test('test_a_branch_never_made_has_no_tip', async () => {
    expect(await cli.free_branch(repo, 'claude/none-2', null)).toStrictEqual([null, null]);
  });

  test('test_a_worktree_already_gone_counts_as_removed', async () => {
    await cli.remove_worktree(repo, wt, null);
    expect(await cli.remove_worktree(repo, wt, 'claude/x-1')).toBe(true);
  });

  test('test_a_checkout_git_cant_delete_is_moved_aside_and_the_next_one_is_made', async () => {
    // Ticket 45: Sol's sandbox user left owner-only folders in the checkout, so `git worktree
    // remove` unregistered it but left its folder, and the next review's `worktree add` refused
    // the path. A deny-delete ACL plays the sandbox user's folder.
    const checkout = join(dirname(repo), 'checkouts', 'repo-pr6');
    await cli.checkout(repo, head, checkout);
    const locked = join(checkout, '.review-tmp', 'tmp1');
    await deny_delete(locked);
    const moved = (await cli.remove_checkout(repo, checkout))!;
    addCleanup(() => spawnSync('icacls', [join(moved, '.review-tmp', 'tmp1'), '/remove:d', '*S-1-1-0'], { stdio: 'pipe' }));
    expect(existsSync(checkout)).toBe(false);
    expect(basename(moved).startsWith('repo-pr6.stale-'), moved).toBe(true);
    expect(statSync(join(moved, '.review-tmp', 'tmp1')).isDirectory()).toBe(true);
    await cli.checkout(repo, head, checkout);   // the next review
    expect(statSync(join(checkout, 'b.txt')).isFile()).toBe(true);
    expect(git(repo, 'worktree', 'list')).not.toContain('repo-pr6.stale');
  });

  test('test_a_checkout_removed_whole_moves_nothing_aside', async () => {
    const checkout = join(dirname(repo), 'checkouts', 'repo-pr6');
    await cli.checkout(repo, head, checkout);
    expect(await cli.remove_checkout(repo, checkout)).toBeNull();
    expect(readdirSync(dirname(checkout))).toStrictEqual([]);
  });

  test('test_folders_moved_aside_are_swept_once_they_can_be_deleted', async () => {
    const checkouts = join(dirname(repo), 'checkouts');
    const free = join(checkouts, 'repo-pr4.stale-20261116-010203');
    const held = join(checkouts, 'repo-pr6.stale-20261116-010203');
    const live = join(checkouts, 'repo-pr7');
    for (const d of [free, held, live]) await mkdir(join(d, 'x'), { recursive: true });
    await deny_delete(join(held, 'x'));
    expect(await GitCli.sweep_stale(checkouts)).toStrictEqual([held]);
    expect(readdirSync(checkouts).sort()).toStrictEqual(['repo-pr6.stale-20261116-010203', 'repo-pr7']);
    expect(await GitCli.sweep_stale(join(checkouts, 'none'))).toStrictEqual([]);
  });

  test('a stale checkout with a read-only file, or that is a junction, is swept as Python leaves it', async () => {
    // `shutil.rmtree(ignore_errors=True)` on Windows can't delete a read-only file, so its folder
    // stays (the rest goes), and refuses a folder that is itself a link, which it leaves whole.
    const checkouts = join(dirname(repo), 'checkouts');
    const held = join(checkouts, 'repo-pr4.stale-20261116-010203');
    const linked = join(checkouts, 'repo-pr5.stale-20261116-010203');
    const target = join(dirname(repo), 'elsewhere');
    await mkdir(join(held, 'x'), { recursive: true });
    await writeFile(join(held, 'x', 'locked.txt'), 'x');
    await writeFile(join(held, 'x', 'free.txt'), 'x');
    read_only(join(held, 'x', 'locked.txt'));
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'keep.txt'), 'x');
    await symlink(target, linked, 'junction');
    expect(await GitCli.sweep_stale(checkouts)).toStrictEqual([held, linked]);
    expect(readdirSync(join(held, 'x'))).toStrictEqual(['locked.txt']);
    expect(readdirSync(linked)).toStrictEqual(['keep.txt']);
  });

  // --- a PR's screenshots, on the repo's `evidence` branch (PR #114) ---------------------------

  /** `repo` gets an origin; with `shots`, an `evidence` branch holding them. */
  async function origin_with_evidence(shots?: Record<string, Buffer>): Promise<string> {
    const origin = join(dirname(repo), 'origin');
    git(repo, 'clone', '-q', '--bare', repo, origin);
    git(repo, 'remote', 'add', 'origin', origin);
    if (shots && Object.keys(shots).length) {
      git(wt, 'checkout', '-q', '--orphan', 'evidence');
      git(wt, 'rm', '-rfq', '.');
      for (const [name, data] of Object.entries(shots)) {
        await mkdir(dirname(join(wt, name)), { recursive: true });
        await writeFile(join(wt, name), data);
        git(wt, 'add', name);
      }
      git(wt, 'commit', '-q', '-m', 'Shots');
      git(wt, 'push', '-q', origin, 'evidence');
    }
    return origin;
  }

  test('test_a_prs_published_screenshots_are_copied_out', async () => {
    await origin_with_evidence({
      'pr-5/after-busy-usage.png': Buffer.from('PNG2'),
      'pr-5/before-busy-usage.png': Buffer.from('PNG1'),
      'pr-6/after-x.png': Buffer.from('other'),
    });
    const dest = join(dirname(repo), 'run', 'evidence');
    expect(await cli.evidence(repo, 5, dest)).toStrictEqual(['after-busy-usage.png', 'before-busy-usage.png']);
    expect(readFileSync(join(dest, 'before-busy-usage.png'))).toStrictEqual(Buffer.from('PNG1'));
  });

  test('test_no_evidence_branch_or_no_shots_for_the_pr_is_none', async () => {
    await origin_with_evidence();
    const dest = join(dirname(repo), 'run', 'evidence');
    expect(await cli.evidence(repo, 5, dest)).toStrictEqual([]);
  });

  test('test_an_unreadable_origin_is_a_git_error_not_no_screenshots', async () => {
    // Sol's review 1, F2: a fetch failing for any other reason (network, auth) mustn't read as
    // "none published", which would block the PR for shots it has.
    await origin_with_evidence({ 'pr-5/after-x.png': Buffer.from('PNG') });
    git(repo, 'remote', 'set-url', 'origin', join(dirname(repo), 'gone'));
    await expect(cli.evidence(repo, 5, join(dirname(repo), 'run'))).rejects.toThrow(GitError);
  });
});
