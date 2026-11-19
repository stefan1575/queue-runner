// Live check of filing a stop and reading its answer (#158): against the GitHub sandbox
// `stefan1575/queue-runner-sandbox` only, in the one T3 project cloned from it (found by its remote,
// live/sandbox.ts). No thread runs, so it costs no tokens: the stops are a job that needs the user
// and a question with no thread, recorded in a job log of its own in a temp folder; the stop desk,
// gh and GitHub are real. The decision thread (the cap's Approach note) is the fakes' only.
// **It writes to GitHub:** it pushes a branch, opens a PR, files a `needs-info` issue, comments on
// both, answers on the issue as a person would (a plain comment), closes the PR, and deletes the
// branch; the desk closes the issue.
//
//   1. A PR, and a fix round on it that needs the user: one pass files the PR's `needs-info` issue
//      (its hidden line, the label), the stop in it and a comment on the PR; a second pass posts
//      nothing more.
//   2. A plain comment on the issue answers it: the stop is answered and the job freed.
//   3. A second stop goes in the same issue; the PR closed outside the app clears it: a note, and
//      the issue closed as not planned.
//
//     pnpm --dir app live:stops
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GhGitHub } from '../src/github.ts';
import { JobLog } from '../src/job-log.ts';
import { JOB_BRANCH_PREFIX } from '../src/picker.ts';
import { needsInfoMark, StopDesk } from '../src/stops.ts';
import { T3Mcp } from '../src/t3/mcp.ts';
import { fetchHttp, runtimeAddress, t3Cli } from '../src/t3/real.ts';
import { sandboxRepo, SANDBOX_GITHUB as GITHUB } from './sandbox.ts';

const NOBODY = { provider: 'none', model: 'none', effort: null };
const mcp = new T3Mcp(runtimeAddress(), t3Cli(), fetchHttp);
const github = new GhGitHub();
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

const repo = await sandboxRepo(mcp, github);
const state = await mkdtemp(join(tmpdir(), 'qr-live-stops-'));
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const branch = `${JOB_BRANCH_PREFIX}live-stops-${stamp}`;
const wt = join(state, 'worktree');
const log = await JobLog.open(join(state, 'jobs.jsonl'));
const say = (l: string) => console.log(`  ${l}`);
const noThreads = { subscribe: () => { throw new Error('the live stops check runs no thread'); } };
const noGate = {
  pick: () => ({ fits: false as const, until: null, hold: { why: 'reading' as const, provider: 'none', checkedAt: null, stale: 'none' as const } }),
  started: () => {}, finished: () => {}, dropped: () => {}, forget: () => {},
};
const desk = new StopDesk({ repos: () => [repo], github, mcp, ws: noThreads as any, gate: noGate as any, catalog: () => null, user: async () => 'the live check', log, say });

let n: number | null = null;
let issue: number | null = null;
try {
  run(repo.folder, 'git', 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
  run(repo.folder, 'git', 'worktree', 'add', '-q', '-b', branch, wt, 'origin/main');
  await writeFile(join(wt, `live-stops-${stamp}.txt`), 'a stop\n');
  run(wt, 'git', 'add', '.');
  run(wt, 'git', ...commitAs, 'commit', '-q', '-m', 'Live stops check');
  run(wt, 'git', 'push', '-q', 'origin', `HEAD:${branch}`);
  const h = run(wt, 'git', 'rev-parse', 'HEAD');
  n = Number(run(state, 'gh', 'api', '-X', 'POST', `repos/${GITHUB}/pulls`, '-f', `title=Live stops check ${stamp}`, '-f', `head=${branch}`, '-f', 'base=main',
    '-f', "body=Opened by the app's live stops check (`app/live/stops.ts`).", '-q', '.number'));
  console.log(`PR #${n}: https://github.com/${GITHUB}/pull/${n}, H ${h.slice(0, 7)}`);

  // 1. a fix round on it that needs the user: filed once
  const fix = await log.started({ kind: 'fix', repo: repo.id, github: GITHUB, issue: n, branch, base: 'main', title: `Queue runner fix: sandbox#${n}`, choice: NOBODY, onFallback: false, sha: h, round: 1 });
  await log.ended(fix.id, { outcome: 'needs-user', error: 'the live check says T3 may have started a thread' });
  await desk.pass();
  const stop = log.stops()[0];
  check('one needs-user stop, filed', log.stops().length === 1 && stop?.cause === 'needs-user' && Boolean(stop.filed), JSON.stringify(log.stops()));
  issue = Number(/\/issues\/(\d+)/.exec(stop?.filed?.issue ?? '')?.[1] ?? NaN);
  const got = JSON.parse(run(state, 'gh', 'api', `repos/${GITHUB}/issues/${issue}`));
  check(`its needs-info issue #${issue} has the PR's hidden line and the label`, got.body.includes(needsInfoMark(GITHUB, n)) && got.labels.some((l: any) => l.name === 'needs-info'), got.title);
  const onIssue = await github.issueComments(GITHUB, issue);
  const onPr = await github.issueComments(GITHUB, n);
  check('the stop is a comment on the issue', onIssue.filter((c) => c.body.includes(`stop ${stop!.id}`)).length === 1);
  check('and the PR links it', onPr.filter((c) => c.body.includes(`stop ${stop!.id}`) && c.body.includes(stop!.filed!.issue)).length === 1);
  await desk.pass();
  check('a second pass posts nothing more', (await github.issueComments(GITHUB, issue)).length === onIssue.length && (await github.issueComments(GITHUB, n)).length === onPr.length);
  check('the job still needs the user', log.needingUser(repo.id).length === 1);

  // 2. answered on the issue, as a person would
  run(state, 'gh', 'api', '-X', 'POST', `repos/${GITHUB}/issues/${issue}/comments`, '-f', 'body=Checked in T3: nothing ran. Carry on.');
  await desk.pass();
  check('answered by the reply', log.stops()[0]?.answered?.answer === 'replied', JSON.stringify(log.stops()[0]?.answered));
  check('the job is freed', log.needingUser(repo.id).length === 0);

  // 3. a second stop in the same issue, cleared by the PR closed outside the app
  const second = await log.stopped({ cause: 'question', repo: repo.id, github: GITHUB, pr: n, sha: h, why: 'the live check asks a second question', link: null });
  await desk.pass();
  check('the second stop goes in the same needs-info issue', log.stops().find((s) => s.id === second.id)?.filed?.issue === stop?.filed?.issue);
  run(state, 'gh', 'api', '-X', 'PATCH', `repos/${GITHUB}/pulls/${n}`, '-f', 'state=closed');
  await desk.pass();
  const after = JSON.parse(run(state, 'gh', 'api', `repos/${GITHUB}/issues/${issue}`));
  check('cleared when the PR was closed', log.stops().find((s) => s.id === second.id)?.answered?.answer === 'pr-closed');
  check('its issue closed as not planned, with a note', after.state === 'closed' && after.state_reason === 'not_planned'
    && (await github.issueComments(GITHUB, issue)).some((c) => c.body.includes(`PR #${n} was closed without an answer here`)), `${after.state} ${after.state_reason}`);
} finally {
  if (n !== null) {
    quietly(state, 'gh', 'api', '-X', 'PATCH', `repos/${GITHUB}/pulls/${n}`, '-f', 'state=closed');
    quietly(repo.folder, 'git', 'push', '-q', 'origin', '--delete', branch);
  }
  if (issue !== null && !Number.isNaN(issue)) quietly(state, 'gh', 'api', '-X', 'PATCH', `repos/${GITHUB}/issues/${issue}`, '-f', 'state=closed');
  quietly(repo.folder, 'git', 'worktree', 'remove', '--force', wt);
  quietly(repo.folder, 'git', 'branch', '-D', branch);
  await rm(state, { recursive: true, force: true }).catch(() => {});
}
console.log(good ? 'all ok' : 'FAILED');
process.exit(good ? 0 : 1);
