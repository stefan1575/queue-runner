// The review lane (#155) end to end on fake T3, fake GitHub and fake git: an open PR whose checks
// passed on its newest commit gets a review thread on the review kind's model, in its own checkout
// of that commit; the reply's ledger decides; the comment, sol-review on that commit, follow-ups
// and the Review row are posted; the thread is settled. With the review provider out of usage the
// fallback reviews, named in the comment and the row.
import { jobMark } from '../src/launch.ts';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { BuildRepo } from '../src/build-lane.ts';
import { CostLog } from '../src/cost-log.ts';
import type { ReviewGit } from '../src/git.ts';
import type { ReviewPull } from '../src/github.ts';
import { JobLog } from '../src/job-log.ts';
import { DEFAULT_JOBS, type Jobs, type ModelChoice } from '../src/jobs.ts';
import { readReviews } from '../src/review/ledger.ts';
import { DryRunPoster } from '../src/review/post.ts';
import { ReviewLane, type ReviewLaneDoors } from '../src/review-lane.ts';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings.ts';
import { catalogFromConfig } from '../src/t3/catalog.ts';
import { T3Catalog } from '../src/t3/catalog-source.ts';
import { T3Mcp } from '../src/t3/mcp.ts';
import { runtimeAddress } from '../src/t3/real.ts';
import { T3Ws } from '../src/t3/ws.ts';
import { UsageGate } from '../src/usage-gate.ts';
import { FakeReviewGitHub } from './fake-github.ts';
import { FakeT3 } from './fake-t3.ts';

const snapshot = JSON.parse(await readFile(new URL('./fixtures/server-config.json', import.meta.url), 'utf8'));
const catalog = catalogFromConfig(snapshot.config);
const BUILD: ModelChoice = { provider: 'claudeAgent', model: 'claude-opus-5-5', effort: 'medium' };
const REVIEW: ModelChoice = { provider: 'codex', model: 'gpt-6.2-sol', effort: 'high' };
const FALLBACK: ModelChoice = { provider: 'claudeReviewer', model: 'claude-opus-5-5', effort: 'high' };
const APP: BuildRepo = { id: 'p-app', title: 'app', folder: 'C:/code/app', github: 'owner/app' };
const H = 'abcdef1234567890abcdef1234567890abcdef12';
const H2 = '1234567890abcdef1234567890abcdef12345678';
const pull = (part: Partial<ReviewPull> = {}): ReviewPull =>
  ({ number: 4, title: 'Add a thing', body: 'Closes #3', branch: 'claude/add-a-thing-3', base: 'main', headSha: H, draft: false, url: 'https://github.com/owner/app/pull/4', ...part });
const reply = (findings: unknown[], earlier?: unknown[]) =>
  `I read it all.\n\n\`\`\`sol-findings\n${JSON.stringify({ findings, ...(earlier ? { earlier } : {}) })}\n\`\`\``;

class FakeGit implements ReviewGit {
  calls: string[] = [];
  heads: Record<number, string> = {};
  shots: string[] = [];
  /** What each checkout holds (REVIEW.md, AGENTS.md...), written when it's made. */
  files: Record<string, string> = {};
  async fetchPr(folder: string, n: number, base: string) { this.calls.push(`fetchPr ${folder} ${n} ${base}`); return this.heads[n] ?? H; }
  async checkout(folder: string, ref: string, dir: string) {
    this.calls.push(`checkout ${ref} ${dir}`);
    await mkdir(dir, { recursive: true });
    for (const [name, text] of Object.entries(this.files)) await writeFile(join(dir, name), text);
  }
  async removeCheckout(folder: string, dir: string, ref?: string) { this.calls.push(`removeCheckout ${dir} ${ref}`); await rm(dir, { recursive: true, force: true }); }
  async isAncestor() { return true; }
  async diff(_f: string, a: string, b: string, mb?: boolean) { return `diff ${a}${mb ? '...' : '..'}${b}\n`; }
  async evidence(_f: string, _n: number, dest: string) {
    if (this.shots.length) await mkdir(dest, { recursive: true });
    return this.shots;
  }
}

/** A gate with room for every review, on the review kind's own model. */
class RoomyGate {
  calls: string[] = [];
  pick(id: string) { this.calls.push(`pick ${id}`); return { fits: true as const, choice: REVIEW, onFallback: false, cost: { five_hour: 15 } }; }
  check() { return { fits: true as const, cost: { five_hour: 15 } }; }
  started(job: { id: string }) { this.calls.push(`started ${job.id}`); }
  finished(id: string) { this.calls.push(`finished ${id}`); }
  dropped(id: string) { this.calls.push(`dropped ${id}`); }
  forget() {}
}

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(ok()).toBe(true);
};

let dir: string;
let t3: FakeT3;
let gh: FakeReviewGitHub;
let git: FakeGit;
let log: JobLog;
let mcp: T3Mcp;
let ws: T3Ws;
let lines: string[];
let jobs: Jobs;
let toolFree: string[];
let lane: ReviewLane;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qr-review-'));
  t3 = new FakeT3();
  t3.serverConfig = snapshot;
  await writeFile(join(dir, 'server-runtime.json'), JSON.stringify({ origin: t3.origin }));
  const address = runtimeAddress(join(dir, 'server-runtime.json'));
  mcp = new T3Mcp(address, t3.cli, t3.http);
  ws = new T3Ws(address, t3.cli, t3.http, t3.connect);
  gh = new FakeReviewGitHub();
  gh.reviewPulls['owner/app'] = [pull()];
  gh.checkStates[H] = { state: 'passed', pending: [], failed: [] };
  gh.issues['owner/app#3'] = { title: 'Add a thing', body: 'Please add it.' };
  gh.bodies['owner/app#4'] = '## Summary\n\nx\n\n## Evidence\n\ny\n';
  git = new FakeGit();
  log = await JobLog.open(join(dir, 'state', 'jobs.jsonl'));
  lines = [];
  jobs = { ...DEFAULT_JOBS, build: { own: BUILD, fallback: null }, review: { own: REVIEW, fallback: FALLBACK } };
  toolFree = [REVIEW.provider, FALLBACK.provider];
});
afterEach(async () => {
  lane?.stop();
  await rm(dir, { recursive: true, force: true });
});

function makeLane(part: Partial<ReviewLaneDoors> = {}) {
  lane = new ReviewLane({
    repos: () => [APP], github: gh, git, deps: null, mcp, ws, gate: new RoomyGate(), catalog: () => catalog, jobs: () => jobs, toolFree: () => toolFree,
    user: async () => 'Pat', log, stateDir: join(dir, 'state'), say: (l) => lines.push(l), retry: (open) => { const t = setTimeout(open, 5); return () => clearTimeout(t); },
    now: () => new Date('2026-11-19T12:00:00Z'), ...part,
  });
  return lane;
}

/** Waits for the review thread `n` to launch, has it reply, and ends its run. */
async function answer(n: number, text: string) {
  await until(() => t3.launches.length >= n);
  await until(() => t3.threadStreamCount(`thread-${n}`) > 0);
  t3.say(`thread-${n}`, text);
  t3.endRun(`thread-${n}`, 'completed');
}

describe('a review', () => {
  test("runs in its own checkout of H on the review kind's model, and posts its ledger and sol-review on H", async () => {
    git.files = { 'AGENTS.md': '# rules', 'REVIEW.md': 'Never report style.' };
    makeLane();
    const passed = lane.pass();
    await answer(1, reply([{ id: 'F1', tag: 'important', class: 'unchecked input', file: 'src/a.ts', line: 3, scenario: 'empty input crashes' }]));
    await passed;
    await lane.idle();

    const launch = t3.launches[0];
    expect(launch).toMatchObject({ projectId: 'p-app', title: 'Queue runner review: app#4', runtimeMode: 'full-access', modelSelection: { instanceId: 'codex', model: 'gpt-6.2-sol', options: [{ id: 'reasoningEffort', value: 'high' }] } });
    expect(launch.workspaceStrategy).toBeUndefined();
    const wt = join(dir, 'state', 'checkouts', 'app-pr4').replace(/\\/g, '/');
    expect(launch.message).toContain(`it means \`${wt}\``);
    expect(launch.message).toContain(`exactly ${H}`);
    expect(launch.message).toContain('Never report style.');
    expect(launch.message).toContain('`issue-3.md`: the issue it closes');
    expect(git.calls).toEqual([
      'fetchPr C:/code/app 4 main', `checkout refs/queue-runner/pr4 ${join(dir, 'state', 'checkouts', 'app-pr4')}`,
      `removeCheckout ${join(dir, 'state', 'checkouts', 'app-pr4')} refs/queue-runner/pr4`,
    ]);

    const comment = gh.posted.find((p) => p.what === 'comment')!;
    expect(comment.body).toMatch(/^## Sol review 1 · Blocking · GPT-6\.2-Sol High\n/);
    const read = readReviews(gh.comments['owner/app#4']!);
    expect(read).toMatchObject([{ round: 1, verdict: 'blocking', sha: H, findings: [{ id: 'F1', status: 'open' }] }]);
    expect(gh.posted.filter((p) => p.what === 'status')).toEqual([expect.objectContaining({ sha: H, context: 'sol-review', state: 'failure' })]);
    expect(gh.bodies['owner/app#4']).toContain(`| [Review 1](${comment.url}) | GPT-6.2-Sol High |`);

    const job = log.jobs().at(-1)!;
    expect(job).toMatchObject({ kind: 'review', issue: 4, sha: H, round: 1, threadId: 'thread-1', end: { outcome: 'blocking', verdict: 'blocking', link: comment.url } });
    expect(t3.toolCalls.filter((c) => c.tool === 't3_thread_organize')).toEqual([{ tool: 't3_thread_organize', args: { threadId: 'thread-1', action: 'settle' } }]);
    const runDir = job.end!.runDir!;
    expect(await readFile(join(runDir, 'change.diff'), 'utf8')).toBe(`diff origin/main...${H}\n`);
    expect(JSON.parse(await readFile(join(runDir, 'decision.json'), 'utf8'))).toMatchObject({ outcome: 'fix', reviewer: 'GPT-6.2-Sol High' });

    // reviewed on H: the next pass leaves it, and a new head is reviewed again, round 2
    await lane.pass();
    expect(t3.launches).toHaveLength(1);
    gh.reviewPulls['owner/app'] = [pull({ headSha: H2 })];
    gh.checkStates[H2] = { state: 'passed', pending: [], failed: [] };
    git.heads[4] = H2;
    const next = lane.pass();
    await answer(2, reply([], [{ id: 'F1', status: 'fixed' }]));
    await next;
    await lane.idle();
    expect(t3.launches[1].message).toContain(`You last reviewed ${H.slice(0, 7)}`);
    expect(log.jobs().at(-1)).toMatchObject({ round: 2, sha: H2, end: { outcome: 'clean' } });
    expect(gh.posted.filter((p) => p.what === 'status').map((p) => [p.sha, p.state])).toEqual([[H, 'failure'], [H2, 'success']]);
  });

  test('waits for the checks on H, not counting sol-review, and leaves a PR whose check failed', async () => {
    makeLane();
    gh.checkStates[H] = { state: 'pending', pending: ['tests'], failed: [] };
    await lane.pass();
    gh.checkStates[H] = { state: 'failed', pending: [], failed: ['tests'] };
    await lane.pass();
    gh.checkStates[H] = { state: 'none', pending: [], failed: [] };
    await lane.pass();
    expect(t3.launches).toEqual([]);
    expect(lines).toEqual([
      `review app#4: not now, checks still running on ${H.slice(0, 7)} (tests)`,
      `review app#4: not now, a check failed on ${H.slice(0, 7)} (tests)`,
      `review app#4: not now, no checks reported on ${H.slice(0, 7)} yet`,
    ]);
  });

  test('a PR with a review on H already, or a build writing to its branch, is left', async () => {
    gh.comments['owner/app#4'] = [{ author: 'x', createdAt: '1', body: `<!-- queue-runner-app review round=1 verdict=clean sha=${H.slice(0, 7)} findings=W10= -->` }];
    makeLane();
    await lane.pass();
    gh.comments['owner/app#4'] = [];
    await log.started({ kind: 'build', repo: 'p-app', github: 'owner/app', issue: 3, branch: 'claude/add-a-thing-3', base: 'origin/main', title: 'b', choice: BUILD, onFallback: false });
    await lane.pass();
    expect(t3.launches).toEqual([]);
    expect(lines).toEqual([`review app#4: not now, review 1 is on ${H.slice(0, 7)} already (clean)`, 'review app#4: not now, a build job is still writing to its branch']);
  });

  test('a pre-existing finding files a linked needs-triage issue; one that loses data blocks as Important', async () => {
    makeLane();
    const passed = lane.pass();
    await answer(1, reply([
      { id: 'F1', tag: 'pre-existing', class: 'temp folder never removed', file: 'src/x.ts', line: 4, scenario: 'disk fills' },
      { id: 'F2', tag: 'important', class: 'rows dropped on save', file: 'src/save.ts', line: 9, scenario: 'a second save loses the first' },
    ]));
    await passed;
    await lane.idle();
    const issue = gh.posted.find((p) => p.what === 'issue')!;
    expect(issue).toMatchObject({ labels: ['needs-triage'], title: 'temp folder never removed (src/x.ts)' });
    const comment = gh.posted.find((p) => p.what === 'comment')!;
    expect(comment.body).toContain(`F1 → [#101](${issue.url})`);
    expect(log.jobs().at(-1)!.end).toMatchObject({ outcome: 'blocking' });
    // the brief has the reviewer tag a data-losing pre-existing finding Important
    expect(t3.launches[0].message).toContain('One that loses or exposes data is important instead.');
  });

  test("a reply without a readable ledger fails: nothing posted, the thread settled, tried once more", async () => {
    makeLane();
    const passed = lane.pass();
    await answer(1, 'Looks fine to me.');
    await passed;
    // the pass after a failure starts the second try at once; after two, it's left
    await answer(2, 'Still no block.');
    await lane.idle();
    await lane.pass();
    expect(gh.posted).toEqual([]);
    expect(log.jobs().map((j) => j.end?.outcome)).toEqual(['failed', 'failed']);
    expect(t3.toolCalls.filter((c) => c.tool === 't3_thread_organize').map((c) => c.args.threadId)).toEqual(['thread-1', 'thread-2']);
    expect(t3.launches).toHaveLength(2);
    expect(lines.at(-1)).toBe(`review app#4: not now, 2 failed reviews on ${H.slice(0, 7)}: left until a new head`);
  });

  test('a long reply is read whole, past T3 truncating it', async () => {
    t3.textChunk = 50;
    makeLane();
    const passed = lane.pass();
    await answer(1, reply([]));
    await passed;
    await lane.idle();
    expect(log.jobs().at(-1)!.end).toMatchObject({ outcome: 'clean' });
  });

  test('the head moving since listing counts nothing', async () => {
    git.heads[4] = H2;
    makeLane();
    await lane.pass();
    await lane.idle();
    expect(t3.launches).toEqual([]);
    expect(log.jobs().map((j) => j.end?.outcome)).toEqual(['head-moved']);
  });

  test("only on an instance named as set up without outside tools: another one, though not the build's, waits and launches nothing", async () => {
    toolFree = [FALLBACK.provider];
    makeLane();
    await lane.pass();
    expect(t3.launches).toEqual([]);
    expect(log.jobs()).toEqual([]);
    expect(lines.at(-1)).toMatch(/waits: the review would run on Codex, which isn't one of the instances set up without outside tools/);
  });

  test('with no instance named as set up without outside tools, no review runs', async () => {
    toolFree = [];
    makeLane();
    await lane.pass();
    expect(t3.launches).toEqual([]);
    expect(lines.at(-1)).toMatch(/isn't one of the instances set up without outside tools/);
  });

  test('a review called directly (the live check) on an instance not named launches nothing and fails', async () => {
    toolFree = [FALLBACK.provider];
    makeLane();
    const job = await lane.review(APP, pull(), { choice: REVIEW, onFallback: false, cost: {}, reviewer: 'R' });
    expect(t3.launches).toEqual([]);
    expect(job.end).toMatchObject({ outcome: 'failed' });
    expect(job.end!.error).toMatch(/set up without outside tools/);
    expect(git.calls.at(-1)).toMatch(/^removeCheckout /);
  });

  test("never on the instance builds run on: it has the build's tools, whatever the list says", async () => {
    toolFree = [...toolFree, BUILD.provider];
    jobs = { ...jobs, review: { own: BUILD, fallback: null } };
    const gate = new RoomyGate();
    gate.pick = () => ({ fits: true as const, choice: BUILD, onFallback: false, cost: { five_hour: 15 } });
    makeLane({ gate });
    await lane.pass();
    expect(t3.launches).toEqual([]);
    expect(lines.at(-1)).toMatch(/waits: the review would run on Claude, the instance builds run on/);
  });

  test('a setting changed after the gate let the review in leaves it on the model let in, under its name', async () => {
    const checkout = git.checkout.bind(git);
    git.checkout = async (folder, ref, d) => { jobs = { ...jobs, review: { own: BUILD, fallback: null } }; await checkout(folder, ref, d); };
    makeLane();
    const passed = lane.pass();
    await answer(1, reply([]));
    await passed;
    await lane.idle();
    expect(t3.launches).toHaveLength(1);
    expect(t3.launches[0].modelSelection).toMatchObject({ instanceId: 'codex', model: 'gpt-6.2-sol' });
    expect(log.jobs().at(-1)).toMatchObject({ choice: REVIEW, reviewer: 'GPT-6.2-Sol High' });
  });

  test("the fallback's name is the one it was let in under, though the settings change after", async () => {
    const gate = new RoomyGate();
    gate.pick = () => ({ fits: true as const, choice: FALLBACK, onFallback: true, cost: { five_hour: 15 } });
    const checkout = git.checkout.bind(git);
    git.checkout = async (folder, ref, d) => { jobs = { ...jobs, review: { own: FALLBACK, fallback: null } }; await checkout(folder, ref, d); };
    makeLane({ gate });
    const passed = lane.pass();
    await answer(1, reply([]));
    await passed;
    await lane.idle();
    expect(log.jobs().at(-1)).toMatchObject({ reviewer: 'Claude Opus 5.5 High, fallback while Codex is out of usage' });
  });

  test('a dry run posts nothing', async () => {
    makeLane({ poster: new DryRunPoster((l) => lines.push(l)) });
    const passed = lane.pass();
    await answer(1, reply([]));
    await passed;
    await lane.idle();
    expect(gh.posted).toEqual([]);
    expect(lines.some((l) => l.startsWith('dry run: owner/app#4'))).toBe(true);
  });

  test('a review the app was cut off from is watched to its end and counts as failed', async () => {
    const job = await log.started({ kind: 'review', repo: 'p-app', github: 'owner/app', issue: 4, branch: 'b', base: 'main', title: 'Queue runner review: app#4', choice: REVIEW, onFallback: false, sha: H, round: 1 });
    t3.threadState['thread-9'] = { id: 'thread-9', projectId: 'p-app', runtimeRequests: [], turnItems: [], messages: [], runs: [{ id: 'run-9', ordinal: 1, rootNodeId: 'n', status: 'running' }] };
    await log.thread(job.id, { threadId: 'thread-9', runId: 'run-9', link: null });
    gh.reviewPulls['owner/app'] = [];
    makeLane();
    void lane.start();
    await until(() => t3.threadStreamCount('thread-9') > 0);
    t3.endRun('thread-9', 'completed');
    await lane.idle();
    expect(log.get(job.id)!.end).toMatchObject({ outcome: 'failed', error: 'The app stopped mid-review.' });
    expect(t3.toolCalls.filter((c) => c.tool === 't3_thread_organize').map((c) => c.args.threadId)).toEqual(['thread-9']);
  });
});

describe('an app that stopped between the launch and the log', () => {
  const started = () => log.started({ kind: 'review', repo: 'p-app', github: 'owner/app', issue: 4, branch: 'b', base: 'main', title: 'Queue runner review: app#4', choice: REVIEW, onFallback: false, sha: H, round: 1 });
  /** A thread in T3; `of` is the job whose launch made it (its message carries that job's mark). */
  const thread = (id: string, projectId: string, title: string, createdAt: string, of?: string) => {
    const messages = [{ itemId: `${id}-msg`, type: 'user_message', runId: `${id}-run`, text: `${of ? `${jobMark(of)}

` : ''}Review PR #4.` }];
    t3.threadState[id] = { id, projectId, title, createdAt, runtimeRequests: [], turnItems: [], messages, runs: [{ id: `${id}-run`, ordinal: 1, rootNodeId: 'n', status: 'running' }] };
  };

  test("a later thread with the same title isn't taken for it: only the one whose message carries its job's mark", async () => {
    const job = await started();
    const at = (ms: number) => new Date(Date.parse(job.startedAt) + ms).toISOString();
    thread('its-thread', 'p-app', job.title, at(700), job.id);
    thread('later', 'p-app', job.title, at(60_000), 'review-another-job'); // another job's, same PR
    thread('by-hand', 'p-app', job.title, at(90_000)); // made in T3 by hand, same title
    makeLane();
    void lane.start();
    await until(() => t3.threadStreamCount('its-thread') > 0);
    expect(log.get(job.id)).toMatchObject({ threadId: 'its-thread' });
    expect(t3.threadStreamCount('later') + t3.threadStreamCount('by-hand')).toBe(0);
    t3.endRun('later', 'completed'); // the other thread ending starts nothing: its own still runs
    await new Promise((r) => setTimeout(r, 30));
    expect(t3.launches).toEqual([]);
    expect(log.get(job.id)!.end).toBeUndefined();
    t3.endRun('its-thread', 'completed');
    await until(() => t3.launches.length === 1);
    await answer(1, reply([]));
    await lane.idle();
  });

  test("only same-titled threads without its mark: none is its, so it counts as failed", async () => {
    const job = await started();
    thread('by-hand', 'p-app', job.title, new Date(Date.parse(job.startedAt) + 500).toISOString());
    gh.reviewPulls['owner/app'] = [];
    makeLane();
    await lane.start();
    await lane.idle();
    expect(log.get(job.id)).toMatchObject({ end: { outcome: 'failed' } });
    expect(log.get(job.id)!.threadId).toBeUndefined();
  });

  test("a launch heads its message with the job's mark", async () => {
    makeLane();
    const passed = lane.pass();
    await answer(1, reply([]));
    await passed;
    await lane.idle();
    expect(t3.launches[0].message.startsWith(`${jobMark(log.jobs()[0]!.id)}

`)).toBe(true);
  });

  test('its review thread is found in T3 by project, title and start, and no second review starts until it ends', async () => {
    const job = await started();
    const at = (ms: number) => new Date(Date.parse(job.startedAt) + ms).toISOString();
    thread('older', 'p-app', job.title, at(-3_600_000), 'review-older'); // an earlier review of the same PR
    thread('its-thread', 'p-app', job.title, at(700), job.id);
    makeLane();
    void lane.start();
    await until(() => t3.threadStreamCount('its-thread') > 0);
    expect(log.get(job.id)).toMatchObject({ threadId: 'its-thread', runId: 'its-thread-run' });
    await new Promise((r) => setTimeout(r, 30));
    expect(t3.launches).toEqual([]); // the PR waits: its first review still runs in its checkout
    expect(git.calls).toEqual([]);
    t3.endRun('its-thread', 'completed');
    await until(() => t3.launches.length === 1); // then it's reviewed afresh
    expect(log.get(job.id)!.end).toMatchObject({ outcome: 'failed', error: 'The app stopped mid-review.' });
    expect(t3.toolCalls.filter((c) => c.tool === 't3_thread_organize').map((c) => c.args.threadId)).toContain('its-thread');
    expect(t3.toolCalls.filter((c) => c.tool === 't3_thread_organize').map((c) => c.args.threadId)).not.toContain('older');
    await answer(1, reply([]));
    await lane.idle();
  });

  test("T3's threads unreadable at first: asked again until they answer, never taken as no thread", async () => {
    const job = await started();
    thread('its-thread', 'p-app', job.title, new Date(Date.parse(job.startedAt) + 500).toISOString(), job.id);
    t3.shellFailures = 3;
    makeLane();
    void lane.start();
    await until(() => t3.threadStreamCount('its-thread') > 0);
    expect(t3.launches).toEqual([]);
    expect(lines.filter((l) => /couldn't be read to find its thread/.test(l))).toHaveLength(3);
    t3.endRun('its-thread', 'completed');
    await until(() => log.get(job.id)!.end !== undefined);
    await answer(1, reply([]));
    await lane.idle();
  });

  test('with no thread T3 made for it, it counts as failed at once', async () => {
    const job = await started();
    thread('other-pr', 'p-app', 'Queue runner review: app#5', new Date(Date.parse(job.startedAt) + 500).toISOString());
    gh.reviewPulls['owner/app'] = [];
    makeLane();
    await lane.start();
    await lane.idle();
    expect(log.get(job.id)!.end).toMatchObject({ outcome: 'failed' });
    expect(t3.toolCalls.filter((c) => c.tool === 't3_thread_organize')).toEqual([]);
  });
});

describe('the fallback', () => {
  let source: T3Catalog;
  afterEach(() => source?.stop());

  test("with the review provider out of usage, the fallback reviews, named in the comment and the row", async () => {
    // the fixture's Codex session window is 100% used; the no-tools Claude instance has room
    const settings: Settings = { ...DEFAULT_SETTINGS, jobs };
    source = T3Catalog.start(ws, 10);
    await until(() => source.current().usage.length > 0);
    const gate = new UsageGate(source, () => settings, await CostLog.open(join(dir, 'usage.jsonl')), () => new Date('2026-11-18T19:05:00Z'));
    makeLane({ gate, catalog: () => source.current().catalog });
    const passed = lane.pass();
    await answer(1, reply([]));
    await passed;
    await lane.idle();
    expect(t3.launches[0].modelSelection).toMatchObject({ instanceId: 'claudeReviewer', model: 'claude-opus-5-5' });
    const who = 'Claude Opus 5.5 High, fallback while Codex is out of usage';
    const comment = gh.posted.find((p) => p.what === 'comment')!;
    expect(comment.body).toMatch(new RegExp(`^## Sol review 1 · Clean · ${who.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n`));
    expect(gh.posted.find((p) => p.what === 'status')!.description).toBe(`${who}: Clean: no Important finding, 0 nits`.slice(0, 140));
    expect(gh.bodies['owner/app#4']).toContain(`| [Review 1](${comment.url}) | ${who} |`);
    expect(log.jobs().at(-1)).toMatchObject({ onFallback: true, end: { outcome: 'clean' } });
    expect(gate.runningJobs()).toEqual([]);
  });
});
