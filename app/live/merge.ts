// Live check of the merge path (#156), like today's scripts/live_merge.py: against the GitHub
// sandbox `stefan1575/queue-runner-sandbox` only, in the one T3 project cloned from it (found by its
// remote, live/sandbox.ts). The review is stubbed clean: no review thread runs, so it costs no
// tokens; the clean review's comment, `sol-review` and Review row are posted as the review lane
// posts them (GitHubPoster), and everything else is real: gh, git, the job log, the merge lane.
// **It writes to GitHub:** it pushes a branch, opens a PR, sets a `ci` status, posts two reviews and
// merges the PR into the sandbox's main, then deletes the branch.
//
//   1. A branch in a worktree of the project's folder, as a build's would be (a build job in a job
//      log of its own, in a temp folder), and its PR; `ci` passes on H1.
//   2. Review 1 clean on H1, then a second commit H2 pushed: the merge lane must not merge, and
//      GitHub must refuse a merge naming H1 (its 409, HeadMoved).
//   3. `ci` on H2, review 2 clean on H2, and the merge lane merges: merged on GitHub at H2 with a
//      merge commit (two parents), one merge step at H2, the worktree and the local branch gone.
//
//     pnpm --dir app live:merge
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitCli } from '../src/git.ts';
import { GhGitHub, HeadMoved } from '../src/github.ts';
import { JobLog } from '../src/job-log.ts';
import { MergeLane } from '../src/merge-lane.ts';
import { JOB_BRANCH_PREFIX } from '../src/picker.ts';
import { decide, readReviews } from '../src/review/ledger.ts';
import { GitHubPoster } from '../src/review/post.ts';
import { T3Mcp } from '../src/t3/mcp.ts';
import { fetchHttp, runtimeAddress, t3Cli } from '../src/t3/real.ts';
import { sandboxRepo, SANDBOX_GITHUB as GITHUB } from './sandbox.ts';

const CLEAN = 'Nothing to fix.\n\n```sol-findings\n{"findings": []}\n```\n';
const REVIEWER = 'the live check (stubbed clean)';
const NOBODY = { provider: 'none', model: 'none', effort: null };

const mcp = new T3Mcp(runtimeAddress(), t3Cli(), fetchHttp);
const github = new GhGitHub();
const git = new GitCli();
let good = true;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  good &&= ok;
};
const run = (cwd: string, program: string, ...args: string[]) => execFileSync(program, args, { cwd, encoding: 'utf8' }).trim();
const quietly = (cwd: string, program: string, ...args: string[]) => {
  try { execFileSync(program, args, { cwd, stdio: 'ignore' }); } catch { /* done already */ }
};
const commitAs = ['-c', 'user.name=queue runner live check', '-c', 'user.email=live-check@invalid'];

const repo = { ...(await sandboxRepo(mcp, github)), merge: 'runner' as const };
const state = await mkdtemp(join(tmpdir(), 'qr-live-merge-'));
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const branch = `${JOB_BRANCH_PREFIX}live-merge-${stamp}`;
const wt = join(state, 'build-worktree');
const log = await JobLog.open(join(state, 'jobs.jsonl'));
const say = (l: string) => console.log(`  ${l}`);

const push = async (text: string, subject: string) => {
  await writeFile(join(wt, `live-merge-${stamp}.txt`), text);
  run(wt, 'git', 'add', '.');
  run(wt, 'git', ...commitAs, 'commit', '-q', '-m', subject);
  run(wt, 'git', 'push', '-q', 'origin', `HEAD:${branch}`);
  return run(wt, 'git', 'rev-parse', 'HEAD');
};
const ci = (sha: string) => run(state, 'gh', 'api', '-X', 'POST', `repos/${GITHUB}/statuses/${sha}`, '-f', 'state=success', '-f', 'context=ci', '-f', 'description=live check');

/** A clean review of `sha`, stubbed: decided from a clean reply and posted as the lane posts it,
 *  and its job recorded as the review lane records one. */
async function cleanReview(n: number, sha: string) {
  const earlier = readReviews(await github.issueComments(GITHUB, n));
  const round = 1 + Math.max(0, ...earlier.map((r) => r.round));
  const d = decide({ repo: GITHUB, sha, round, earlier, hasReviewMd: false, reply: CLEAN, reviewer: REVIEWER, user: 'the live check' });
  const poster = new GitHubPoster(github, say);
  const url = await poster.post(GITHUB, n, d);
  await poster.finish(GITHUB, n, d, url!);
  const job = await log.started({ kind: 'review', repo: repo.id, github: GITHUB, issue: n, branch, base: 'main', title: `review ${n}`, choice: NOBODY, onFallback: false, sha, round, reviewer: REVIEWER });
  await log.ended(job.id, { outcome: d.verdict, verdict: d.verdict, link: url });
  return round;
}

let n: number | null = null;
try {
  // 1. a build's worktree and branch, and its PR
  run(repo.folder, 'git', 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
  run(repo.folder, 'git', 'worktree', 'add', '-q', '-b', branch, wt, 'origin/main');
  const h1 = await push('one\n', 'Live merge check: first commit');
  const build = await log.started({ kind: 'build', repo: repo.id, github: GITHUB, issue: 0, branch, base: 'main', title: 'Queue runner build: sandbox#0', choice: NOBODY, onFallback: false });
  await log.ended(build.id, { outcome: 'done' });
  n = Number(run(state, 'gh', 'api', '-X', 'POST', `repos/${GITHUB}/pulls`, '-f', `title=Live merge check ${stamp}`, '-f', `head=${branch}`, '-f', 'base=main',
    '-f', "body=Opened by the app's live merge check (`app/live/merge.ts`).", '-q', '.number'));
  console.log(`PR #${n}: https://github.com/${GITHUB}/pull/${n}, H1 ${h1.slice(0, 7)}`);
  ci(h1);

  // 2. clean on H1, then a push: no merge, and GitHub refuses the old head
  await cleanReview(n, h1);
  const h2 = await push('one\ntwo\n', 'Live merge check: a push after the review');
  const lane = new MergeLane({ repos: () => [repo], github, git, mcp, log, say });
  await lane.pass();
  await lane.idle();
  check(`not merged after the head moved to ${h2.slice(0, 7)}`, (await github.pull(GITHUB, n)).state === 'open');
  const refused = await github.merge(GITHUB, n, h1).then(() => null, (e: Error) => e);
  check(`GitHub refused a merge naming the old head ${h1.slice(0, 7)} (409)`, refused instanceof HeadMoved, refused?.message ?? 'it merged');
  check('still open', (await github.pull(GITHUB, n)).state === 'open');

  // 3. clean on H2, and the lane merges it
  ci(h2);
  await cleanReview(n, h2);
  await lane.pass();
  await lane.idle();
  const pr = await github.pull(GITHUB, n);
  check('merged on GitHub', pr.state === 'merged', pr.state);
  const merges = log.steps().filter((s) => s.kind === 'merge');
  check(`one merge step, merged by the app at ${h2.slice(0, 7)}`, merges.length === 1 && merges[0]!.end?.outcome === 'merged' && merges[0]!.sha === h2,
    JSON.stringify(merges.map((s) => [s.sha.slice(0, 7), s.end?.outcome])));
  const commit = merges[0]?.end?.commit;
  const parents = commit ? Number(run(state, 'gh', 'api', `repos/${GITHUB}/commits/${commit}`, '-q', '.parents | length')) : 0;
  check('a merge commit (two parents)', parents === 2, commit ?? 'no commit named');
  check('cleaned up', Boolean(merges[0]?.cleanedAt));
  const listed = (await git.worktrees(repo.folder)).map((w) => w.path.replace(/\\/g, '/').toLowerCase());
  check('the worktree is gone from git worktree list', !listed.includes(wt.replace(/\\/g, '/').toLowerCase()));
  check('its local branch is deleted', !(await git.hasBranch(repo.folder, branch)));
} finally {
  // the PR's branch on GitHub, and whatever the lane didn't remove because the check stopped first
  if (n !== null) quietly(repo.folder, 'git', 'push', '-q', 'origin', '--delete', branch);
  quietly(repo.folder, 'git', 'worktree', 'remove', '--force', wt);
  quietly(repo.folder, 'git', 'branch', '-D', branch);
  await rm(state, { recursive: true, force: true }).catch(() => {});
}
console.log(good ? 'all ok' : 'FAILED');
process.exit(good ? 0 : 1);
