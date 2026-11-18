// Live check of a review (#155), dry run, like today's scripts/live_review.py: one real review of
// one real PR in the GitHub sandbox `stefan1575/queue-runner-sandbox` (it refuses any other repo),
// through the review lane's own `review`, with a poster that posts nothing. It says what adoption
// would decide, then reviews anyway (the sandbox has no CI, so its checks never pass).
//
// The PR's clone is a fresh one in a temp folder. The review's thread runs in the "queue-runner
// sandbox" T3 project (it refuses to run without exactly one), the only T3 project a live check
// may use: T3 starts a thread only in a project, and the brief sends it to the checkout. Without
// `--pr`, it opens a small PR of its own in the sandbox (a branch with one flawed function) and
// closes it, branch deleted, at the end. Costs one review thread.
//
//     pnpm --dir app live:review [-- --pr N] [-- --run <instance>:<model>]
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitCli } from '../src/git.ts';
import { GhGitHub } from '../src/github.ts';
import { JobLog } from '../src/job-log.ts';
import { DEFAULT_JOBS, model, type Catalog, type ModelChoice } from '../src/jobs.ts';
import { Deps } from '../src/review/deps.ts';
import { DryRunPoster } from '../src/review/post.ts';
import { ReviewLane } from '../src/review-lane.ts';
import { catalogFromConfig } from '../src/t3/catalog.ts';
import { T3Mcp } from '../src/t3/mcp.ts';
import { fetchHttp, nodeConnect, runtimeAddress, t3Cli } from '../src/t3/real.ts';
import { T3Ws } from '../src/t3/ws.ts';

const SANDBOX = 'queue-runner sandbox';
const GITHUB = 'stefan1575/queue-runner-sandbox';

const arg = (flag: string) => process.argv.flatMap((a, i) => (process.argv[i - 1] === flag ? [a] : []))[0];
const address = runtimeAddress();
const cli = t3Cli();
const mcp = new T3Mcp(address, cli, fetchHttp);
const ws = new T3Ws(address, cli, fetchHttp, nodeConnect);
const github = new GhGitHub();
let good = true;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  good &&= ok;
};
const run = (cwd: string, program: string, ...args: string[]) => execFileSync(program, args, { cwd, encoding: 'utf8' }).trim();

const projects: any[] = (await mcp.call('t3_project_list', { cursor: 0, limit: 100 })).projects;
const sandbox = projects.filter((p) => p.title === SANDBOX);
if (sandbox.length !== 1) throw new Error(`expected one T3 project called "${SANDBOX}", found ${sandbox.length}: refusing`);
const project = sandbox[0];

const catalog: Catalog = catalogFromConfig((await ws.first('subscribeServerConfig', { workspaceSnapshotsOnDemand: true })).config);
const [provider, ...rest] = (arg('--run') ?? `${catalog.t3Default?.provider}:${catalog.t3Default?.model}`).split(':');
const m = model(catalog, { provider: provider!, model: rest.join(':') });
if (!m) throw new Error(`T3 has no model ${rest.join(':')} on ${provider}`);
const choice: ModelChoice = { provider: provider!, model: m.id, effort: m.efforts[0]?.id ?? null };

const state = await mkdtemp(join(tmpdir(), 'qr-live-review-'));
const clone = join(state, 'clone');
run(state, 'gh', 'repo', 'clone', GITHUB, clone, '--', '--quiet');
if (run(clone, 'gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner') !== GITHUB) throw new Error(`the clone isn't ${GITHUB}: refusing`);

let opened: { number: number; branch: string } | null = null;
let n = Number(arg('--pr') ?? 0);
if (!n) {
  // a PR of its own: one function with a bug a review should find
  const branch = `live-review-${Date.now()}`;
  run(clone, 'git', 'checkout', '-q', '-b', branch);
  await writeFile(join(clone, 'average.js'), '// The average of a list of numbers.\nexport function average(xs) {\n  let sum = 0;\n  for (let i = 0; i <= xs.length; i++) sum += xs[i];\n  return sum / xs.length;\n}\n');
  run(clone, 'git', 'add', 'average.js');
  run(clone, 'git', '-c', 'user.name=queue runner live check', '-c', 'user.email=live-check@invalid', 'commit', '-q', '-m', 'Add average()');
  run(clone, 'git', 'push', '-q', 'origin', branch);
  const url = run(clone, 'gh', 'pr', 'create', '--repo', GITHUB, '--head', branch, '--title', 'Live review check: add average()', '--body', 'Adds `average(xs)`. Opened by the app\'s live review check, closed when it ends.');
  n = Number(url.split('/').at(-1));
  opened = { number: n, branch };
  console.log(`Opened ${url}`);
}

try {
  const pr = (await github.pullsToReview(GITHUB)).find((p) => p.number === n);
  if (!pr) throw new Error(`#${n} is not an open PR in ${GITHUB}`);
  const before = (await github.issueComments(GITHUB, n)).length;
  const log = await JobLog.open(join(state, 'jobs.jsonl'));
  const said: string[] = [];
  const noGate = { pick: () => { throw new Error('not asked'); }, check: () => ({ fits: true as const, cost: {} }), started() {}, finished() {}, dropped() {}, forget() {} };
  const lane = new ReviewLane({
    repos: () => [], github, git: new GitCli(), deps: new Deps(join(state, 'deps')), mcp, ws, gate: noGate as any,
    catalog: () => catalog, jobs: () => ({ ...DEFAULT_JOBS, review: { own: choice, fallback: null } }),
    user: async () => 'the live check', log, stateDir: state, poster: new DryRunPoster((l) => said.push(l)),
    say: (l) => { said.push(l); console.log(`  ${l}`); },
  });
  const repo = { id: project.id, title: 'queue-runner-sandbox', folder: clone, github: GITHUB };
  console.log(`Adoption would say: ${(await lane.whyNot(repo, pr)) ?? 'review it'}`);
  console.log(`Reviewing ${GITHUB}#${n} at ${pr.headSha.slice(0, 7)} on ${choice.provider} ${choice.model} at ${choice.effort}`);
  const job = await lane.review(repo, pr, { choice, onFallback: false, cost: {} });
  console.log(JSON.stringify(job, null, 2));

  const outcome = job.end?.outcome ?? 'none';
  check('the review read a verdict from its ledger', ['clean', 'blocking', 'stop', 'approach-note'].includes(outcome), `${outcome}${job.end?.error ? `: ${job.end.error}` : ''}`);
  const runDir = job.end?.runDir ?? '';
  const comment = await readFile(join(runDir, 'comment.md'), 'utf8').catch(() => '');
  check('the comment carries the ledger and names its reviewer', comment.includes('```sol-findings') && comment.includes(`· ${m.label}`), comment.split('\n')[0]);
  check('nothing was posted', (await github.issueComments(GITHUB, n)).length === before && said.some((l) => l.startsWith('dry run:')));
  const statuses = run(clone, 'gh', 'api', `repos/${GITHUB}/commits/${pr.headSha}/statuses`, '-q', '[.[] | select(.context == "sol-review")] | length');
  check('no sol-review status was set', statuses === '0', statuses);
  const shell = await ws.first('orchestration.subscribeShell', {});
  const thread = [...(shell.snapshot?.threads ?? []), ...(shell.snapshot?.archivedThreads ?? [])].find((t: any) => t.id === job.threadId);
  check('its thread is settled', Boolean(thread?.settledAt) || thread?.settledOverride === 'settled', `settledAt ${thread?.settledAt ?? null}`);
  check("its run was on the review kind's model", thread?.modelSelection?.model === choice.model, JSON.stringify(thread?.modelSelection));
  check('the checkout is gone', !run(clone, 'git', 'worktree', 'list').includes('checkouts'));
  console.log(`Run folder kept for reading: ${runDir}`);
} finally {
  if (opened) {
    run(clone, 'gh', 'pr', 'close', String(opened.number), '--repo', GITHUB, '--delete-branch');
    console.log(`Closed #${opened.number} and deleted ${opened.branch}`);
  }
}
console.log(good ? 'live review check: all ok' : 'live review check: FAILED');
process.exitCode = good ? 0 : 1;
