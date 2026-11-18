// Live check of a build (#154), against the real T3, in the "queue-runner sandbox" project only
// (it refuses to run without exactly one, and never names another), like today's
// scripts/live_sandbox.py: a hand-made issue built through the build lane's own `build`, in a
// real T3 worktree from a freshly fetched origin/main, its end learned from T3's thread events,
// recorded in a job log in a temp folder, and its thread settled. The sandbox has no GitHub
// (its origin is a local bare repo), so there's no picking, no comment and no PR: the issue asks
// for one commit pushed to origin. Costs one small thread. The usage gate isn't asked: it's run
// by hand, on the sandbox only.
//
//     pnpm --dir app live:build                               # T3's default model, at its lowest effort
//     pnpm --dir app live:build -- --run <instance>:<model>   # this one instead
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuildLane } from '../src/build-lane.ts';
import { GitCli } from '../src/git.ts';
import { GhGitHub } from '../src/github.ts';
import { JobLog } from '../src/job-log.ts';
import { DEFAULT_JOBS, model, type Catalog, type ModelChoice } from '../src/jobs.ts';
import { JOB_BRANCH_PREFIX, slug } from '../src/picker.ts';
import { catalogFromConfig } from '../src/t3/catalog.ts';
import { T3Mcp } from '../src/t3/mcp.ts';
import { fetchHttp, nodeConnect, runtimeAddress, t3Cli } from '../src/t3/real.ts';
import { T3Ws } from '../src/t3/ws.ts';

const SANDBOX = 'queue-runner sandbox';

const address = runtimeAddress();
const cli = t3Cli();
const mcp = new T3Mcp(address, cli, fetchHttp);
const ws = new T3Ws(address, cli, fetchHttp, nodeConnect);
let good = true;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  good &&= ok;
};

const projects: any[] = (await mcp.call('t3_project_list', { cursor: 0, limit: 100 })).projects;
const sandbox = projects.filter((p) => p.title === SANDBOX);
if (sandbox.length !== 1) throw new Error(`expected one T3 project called "${SANDBOX}", found ${sandbox.length}: refusing`);
const project = sandbox[0];

const catalog: Catalog = catalogFromConfig((await ws.first('subscribeServerConfig', { workspaceSnapshotsOnDemand: true })).config);
const asked = process.argv.flatMap((a, i) => (process.argv[i - 1] === '--run' ? [a] : []))[0];
const [provider, ...rest] = (asked ?? `${catalog.t3Default?.provider}:${catalog.t3Default?.model}`).split(':');
const m = model(catalog, { provider: provider!, model: rest.join(':') });
if (!m) throw new Error(`T3 has no model ${rest.join(':')} on ${provider}`);
const choice: ModelChoice = { provider: provider!, model: m.id, effort: m.efforts[0]?.id ?? null };
console.log(`Building in ${project.workspaceRoot} on ${choice.provider} ${choice.model} at ${choice.effort}`);

// a number of its own each run, so a branch an earlier run left never holds this one
const number = Number(String(Date.now()).slice(-6));
const title = 'Add a line to README';
const ticket = {
  issue: {
    number, title, openBlockers: 0, openSubIssues: 0, openLinkedPulls: 0,
    body: 'Add the line `Checked by the queue runner app live test.` at the end of `README.md`, commit it, '
      + 'and push the branch to `origin`. This repo has no GitHub: there is no PR to open and no issue to '
      + 'comment on. No tests and no review: it is one line.',
  },
  branch: `${JOB_BRANCH_PREFIX}${slug(title)}-${number}`, base: 'origin/main',
};

const state = await mkdtemp(join(tmpdir(), 'qr-live-build-'));
const log = await JobLog.open(join(state, 'jobs.jsonl'));
const noGate = { pick: () => { throw new Error('not asked'); }, check: () => ({ fits: true as const, cost: {} }), started() {}, finished() {}, dropped() {}, forget() {} };
const repo = { id: project.id, title: project.title, folder: project.workspaceRoot, github: null };
const lane = new BuildLane({
  repos: () => [repo], github: new GhGitHub(), git: new GitCli(), mcp, ws, gate: noGate as any,
  catalog: () => catalog, jobs: () => ({ ...DEFAULT_JOBS, build: { own: choice, fallback: null } }),
  user: async () => 'the live check', log, exists: existsSync, say: (l) => console.log(`  ${l}`),
});
const job = await lane.build(repo, ticket, 'main', { choice, onFallback: false, cost: {} });
console.log(JSON.stringify(job, null, 2));

check('the build ended done', job.end?.outcome === 'done', `${job.end?.outcome} (${job.end?.status ?? ''}${job.end?.error ? `: ${job.end.error}` : ''})`);
const pushed = execFileSync('git', ['-C', project.workspaceRoot, 'ls-remote', 'origin', `refs/heads/${ticket.branch}`], { encoding: 'utf8' }).trim();
check(`its branch ${ticket.branch} is on origin`, pushed.length > 0, pushed.slice(0, 12));

// settled: T3's shell has the thread with settledAt set
const shell = await ws.first('orchestration.subscribeShell', {});
const thread = [...(shell.snapshot?.threads ?? []), ...(shell.snapshot?.archivedThreads ?? [])].find((t: any) => t.id === job.threadId);
check('its thread is settled', Boolean(thread?.settledAt) || thread?.settledOverride === 'settled',
  `settledAt ${thread?.settledAt ?? null}, settledOverride ${thread?.settledOverride ?? null}`);
const norm = (p: unknown) => String(p ?? '').replace(/\\/g, '/').toLowerCase();
check('it ran in its own T3 worktree, on the job branch', thread?.branch === ticket.branch
  && Boolean(thread?.worktreePath) && norm(thread.worktreePath) !== norm(project.workspaceRoot),
  `${thread?.branch} in ${thread?.worktreePath}`);
check('its run was on the build kind\'s model', thread?.modelSelection?.model === choice.model, JSON.stringify(thread?.modelSelection));
await rm(state, { recursive: true, force: true });
console.log(good ? 'live build check: all ok' : 'live build check: FAILED');
process.exitCode = good ? 0 : 1;
