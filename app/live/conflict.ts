// Live check of a conflict round (#157): against the GitHub sandbox `stefan1575/queue-runner-sandbox`
// only, in the one T3 project cloned from it (found by its remote, live/sandbox.ts). Everything is
// real but the usage gate, which lets the round in on the model asked: gh, git, T3, the job log (in
// a temp folder) and the conflict lane, which sees only the check's own PR. Costs one small thread.
// **It writes to GitHub:** it pushes a branch and opens its PR, pushes a commit to the sandbox's main
// that conflicts with it, and the round pushes a merge to the PR's branch; at the end the PR is
// closed and its branch deleted (main keeps its commit, as the merge check's merges stay).
//
//   1. A branch from origin/main that adds `live-conflict-<stamp>.txt`, and its PR; then main adds
//      the same file with other text, so the PR conflicts. GitHub is asked until it says so.
//   2. The conflict lane's pass: one round, a fresh thread on the model asked, in a new worktree
//      at H on its own branch (a `made` line). Its end: done, the PR's head moved, main's tip in
//      the new head's history, GitHub says it merges, no stop, the thread settled.
//
//     pnpm --dir app live:conflict                               # T3's default model, at its lowest effort
//     pnpm --dir app live:conflict -- --run <instance>:<model>   # this one instead
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConflictLane } from '../src/conflict-lane.ts';
import { GitCli } from '../src/git.ts';
import { GhGitHub } from '../src/github.ts';
import { JobLog } from '../src/job-log.ts';
import { model, type Catalog, type ModelChoice } from '../src/jobs.ts';
import { JOB_BRANCH_PREFIX } from '../src/picker.ts';
import { catalogFromConfig } from '../src/t3/catalog.ts';
import { T3Mcp } from '../src/t3/mcp.ts';
import { fetchHttp, nodeConnect, runtimeAddress, t3Cli } from '../src/t3/real.ts';
import { T3Ws } from '../src/t3/ws.ts';
import { sandboxRepo, SANDBOX_GITHUB as GITHUB } from './sandbox.ts';

const address = runtimeAddress();
const cli = t3Cli();
const mcp = new T3Mcp(address, cli, fetchHttp);
const ws = new T3Ws(address, cli, fetchHttp, nodeConnect);
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** GitHub's mergeable for the PR, asked until it's `want` (it works it out in its own time). */
async function mergeable(n: number, want: boolean): Promise<boolean | null> {
  let last: boolean | null = null;
  for (let k = 0; k < 30; k++) {
    last = (await github.pull(GITHUB, n)).mergeable;
    if (last === want) return last;
    await sleep(2000);
  }
  return last;
}

const repo = await sandboxRepo(mcp, github);
const catalog: Catalog = catalogFromConfig((await ws.first('subscribeServerConfig', { workspaceSnapshotsOnDemand: true })).config);
const asked = process.argv.flatMap((a, i) => (process.argv[i - 1] === '--run' ? [a] : []))[0];
const [provider, ...rest] = (asked ?? `${catalog.t3Default?.provider}:${catalog.t3Default?.model}`).split(':');
const m = model(catalog, { provider: provider!, model: rest.join(':') });
if (!m) throw new Error(`T3 has no model ${rest.join(':')} on ${provider}`);
const choice: ModelChoice = { provider: provider!, model: m.id, effort: m.efforts[0]?.id ?? null };

const state = await mkdtemp(join(tmpdir(), 'qr-live-conflict-'));
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const branch = `${JOB_BRANCH_PREFIX}live-conflict-${stamp}`;
const file = `live-conflict-${stamp}.txt`;
const prSide = join(state, 'pr-side');
const mainSide = join(state, 'main-side');
const log = await JobLog.open(join(state, 'jobs.jsonl'));
const say = (l: string) => console.log(`  ${l}`);
console.log(`Conflict round in ${repo.folder} on ${choice.provider} ${choice.model} at ${choice.effort}`);

let n: number | null = null;
let threadWorktree: string | null = null;
let workBranch: string | null = null;
try {
  // 1. the PR's side, its PR, then main's side of the same file: a conflict
  run(repo.folder, 'git', 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
  run(repo.folder, 'git', 'worktree', 'add', '-q', '-b', branch, prSide, 'origin/main');
  await writeFile(join(prSide, file), 'The PR says: conflicts are resolved by merging main in.\n');
  run(prSide, 'git', 'add', '.');
  run(prSide, 'git', ...commitAs, 'commit', '-q', '-m', 'Live conflict check: the PR side');
  run(prSide, 'git', 'push', '-q', 'origin', `HEAD:${branch}`);
  const h = run(prSide, 'git', 'rev-parse', 'HEAD');
  // the PR's own worktree goes, so the round makes a new one at H, as it does for a person's PR
  run(repo.folder, 'git', 'worktree', 'remove', '--force', prSide);
  run(repo.folder, 'git', 'branch', '-D', branch);
  n = Number(run(state, 'gh', 'api', '-X', 'POST', `repos/${GITHUB}/pulls`, '-f', `title=Live conflict check ${stamp}`, '-f', `head=${branch}`, '-f', 'base=main',
    '-f', `body=Opened by the app's live conflict check (\`app/live/conflict.ts\`). It adds \`${file}\` with one line; main adds the same file with another, so it conflicts. Keep both lines.`, '-q', '.number'));
  console.log(`PR #${n}: https://github.com/${GITHUB}/pull/${n}, H ${h.slice(0, 7)}`);
  run(repo.folder, 'git', 'worktree', 'add', '-q', '--detach', mainSide, 'origin/main');
  await writeFile(join(mainSide, file), 'Main says: a conflicted PR gets one round at a time.\n');
  run(mainSide, 'git', 'add', '.');
  run(mainSide, 'git', ...commitAs, 'commit', '-q', '-m', 'Live conflict check: the main side');
  run(mainSide, 'git', 'push', '-q', 'origin', 'HEAD:main');
  const tip = run(mainSide, 'git', 'rev-parse', 'HEAD');
  run(repo.folder, 'git', 'worktree', 'remove', '--force', mainSide);
  console.log(`main at ${tip.slice(0, 7)}`);
  check('GitHub says the PR conflicts', (await mergeable(n, false)) === false);
  check("the base's tip is read from the branch", (await github.branchHead(GITHUB, 'main')) === tip);

  // 2. the lane's pass: one round on the check's PR only
  const only = n;
  const lane = new ConflictLane({
    repos: () => [repo],
    github: {
      pullsToReview: async (r) => (await github.pullsToReview(r)).filter((p) => p.number === only), pull: (r, k) => github.pull(r, k),
      branchHead: (r, b) => github.branchHead(r, b), checks: (r, sha) => github.checks(r, sha), issueComments: (r, k) => github.issueComments(r, k),
      reviewReplies: (r, k) => github.reviewReplies(r, k), openThreads: (r, k) => github.openThreads(r, k),
    },
    git, mcp, ws, catalog: () => catalog, user: async () => 'the live check', log, exists: existsSync, say,
    gate: { pick: () => ({ fits: true, choice, onFallback: false, cost: {} }), started() {}, finished() {}, dropped() {}, forget() {} } as any,
  });
  await lane.pass();
  await lane.idle();
  const rounds = log.jobs().filter((j) => j.kind === 'conflict');
  const job = rounds[0];
  workBranch = job?.workBranch ?? null;
  console.log(JSON.stringify(job, null, 2));
  check('one conflict round', rounds.length === 1, String(rounds.length));
  check('it ended done', job?.end?.outcome === 'done', `${job?.end?.outcome} (${job?.end?.error ?? ''})`);
  check('it recorded the base it merged, from the branch', job?.baseSha === tip, job?.baseSha);
  check(`it worked on its own branch, recorded as made`, Boolean(workBranch) && job?.made?.includes(workBranch!) === true, workBranch ?? '');
  const head = (await github.pull(GITHUB, n)).headSha;
  check(`the PR's head moved from ${h.slice(0, 7)}`, head !== h && job?.end?.head === head, head.slice(0, 7));
  const behind = Number(run(state, 'gh', 'api', `repos/${GITHUB}/compare/${tip}...${head}`, '-q', '.behind_by'));
  check(`main's tip ${tip.slice(0, 7)} is in the new head's history`, behind === 0, `behind by ${behind}`);
  check('GitHub says it merges now', (await mergeable(n, true)) === true);
  check('no stop', log.stops().length === 0, JSON.stringify(log.stops()));
  const shell = await ws.first('orchestration.subscribeShell', {});
  const thread = [...(shell.snapshot?.threads ?? []), ...(shell.snapshot?.archivedThreads ?? [])].find((t: any) => t.id === job?.threadId);
  threadWorktree = thread?.worktreePath ?? null;
  check('its thread is settled', Boolean(thread?.settledAt) || thread?.settledOverride === 'settled', `settledAt ${thread?.settledAt ?? null}`);
  check('it ran in a T3 worktree on its own branch', thread?.branch === workBranch && Boolean(thread?.worktreePath), `${thread?.branch} in ${thread?.worktreePath}`);
  check("its run was on the model asked", thread?.modelSelection?.model === choice.model, JSON.stringify(thread?.modelSelection));
} finally {
  if (n !== null) quietly(state, 'gh', 'api', '-X', 'PATCH', `repos/${GITHUB}/pulls/${n}`, '-f', 'state=closed');
  quietly(repo.folder, 'git', 'push', '-q', 'origin', '--delete', branch);
  quietly(repo.folder, 'git', 'worktree', 'remove', '--force', prSide);
  quietly(repo.folder, 'git', 'worktree', 'remove', '--force', mainSide);
  if (threadWorktree) quietly(repo.folder, 'git', 'worktree', 'remove', '--force', threadWorktree);
  quietly(repo.folder, 'git', 'branch', '-D', branch);
  if (workBranch) quietly(repo.folder, 'git', 'branch', '-D', workBranch);
  quietly(repo.folder, 'git', 'worktree', 'prune');
  await rm(state, { recursive: true, force: true }).catch(() => {});
}
console.log(good ? 'live conflict check: all ok' : 'live conflict check: FAILED');
process.exitCode = good ? 0 : 1;
