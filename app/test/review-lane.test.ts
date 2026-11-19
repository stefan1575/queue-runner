// The review lane (#155) end to end on fake T3, fake GitHub and fake git: an open PR whose checks
// passed on its newest commit gets a review thread on the review kind's model, in its own checkout
// of that commit; the reply's ledger decides; the comment, sol-review on that commit, follow-ups
// and the Review row are posted; the thread is settled. With the review provider out of usage the
// fallback reviews, named in the comment and the row.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { BuildRepo } from '../src/build-lane.ts';
import { CostLog } from '../src/cost-log.ts';
import type { ReviewGit } from '../src/git.ts';
import type { ReviewPull } from '../src/github.ts';
import { JobLog } from '../src/job-log.ts';
import { DEFAULT_JOBS, type Jobs, type ModelChoice } from '../src/jobs.ts';
import { readReviews } from '../src/review/ledger.ts';
import { DryRunPoster, TABLE_END, TABLE_START } from '../src/review/post.ts';
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
  finished(id: string, limit?: { resetAt: string | null }) { this.calls.push(`finished ${id}${limit ? ` out of usage until ${limit.resetAt}` : ''}`); }
  dropped(id: string) { this.calls.push(`dropped ${id}`); }
  forget() {}
}

const until = (ok: () => boolean) => vi.waitFor(() => { if (!ok()) throw new Error('not yet'); }, { timeout: 2000, interval: 5 });
/** The lane's retry waits, run when the test says: no real timer (#202). */
let retries: Set<() => void>;
const retryNow = () => { const due = [...retries]; retries.clear(); for (const f of due) f(); };

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
  retries = new Set();
});
afterEach(async () => {
  lane?.stop();
  await rm(dir, { recursive: true, force: true });
});

function makeLane(part: Partial<ReviewLaneDoors> = {}) {
  lane = new ReviewLane({
    repos: () => [APP], github: gh, git, deps: null, mcp, ws, gate: new RoomyGate(), catalog: () => catalog, jobs: () => jobs, toolFree: () => toolFree,
    user: async () => 'Pat', log, stateDir: join(dir, 'state'), say: (l) => lines.push(l), retry: (again) => { retries.add(again); return () => { retries.delete(again); }; },
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
    // the thread's working folder is the checkout of H, not the project's clone (F17)
    expect(launch.workspaceStrategy).toEqual({ type: 'existing_worktree', worktreePath: join(dir, 'state', 'checkouts', 'app-pr4') });
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

  test('an empty continuation read is read again, never taken as the end of the reply (F15)', async () => {
    t3.textChunk = 50;
    t3.emptyContinuations = 1;
    makeLane();
    const passed = lane.pass();
    await answer(1, reply([{ id: 'F1', tag: 'important', class: 'unchecked input', file: 'src/a.ts', line: 3, scenario: 'empty input crashes' }]));
    await passed;
    await until(() => retries.size > 0);
    retryNow();
    await until(() => log.jobs()[0]!.end !== undefined);
    await lane.idle();
    expect(log.jobs()[0]!.end).toMatchObject({ outcome: 'blocking' });
    expect(lines.join('\n')).toMatch(/its reply couldn't be read \(T3 gave message \S+'s text from 50 empty\)/);
  });

  test("a review that ends on a usage limit tells the gate its provider is out until T3's reset (#155 F22)", async () => {
    const gate = new RoomyGate();
    makeLane({ gate: gate as any });
    const passed = lane.pass();
    await until(() => t3.threadStreamCount('thread-1') > 0);
    t3.hitUsageLimit('thread-1', '2026-11-19T15:00:00.000Z');
    await answer(2, reply([])); // this gate has room, so the pass reviews again
    await passed;
    await lane.idle();
    const [job] = log.jobs();
    expect(job!.end).toMatchObject({ outcome: 'out-of-usage' });
    expect(gate.calls).toContain(`finished ${job!.id} out of usage until 2026-11-19T15:00:00.000Z`);
  });

  test('the head moving since listing counts nothing', async () => {
    git.heads[4] = H2;
    makeLane();
    await lane.pass();
    await lane.idle();
    expect(t3.launches).toEqual([]);
    expect(log.jobs().map((j) => j.end?.outcome)).toEqual(['head-moved']);
    // the ref its fetch wrote is removed
    expect(git.calls.at(-1)).toBe(`removeCheckout ${join(dir, 'state', 'checkouts', 'app-pr4')} refs/queue-runner/pr4`);
  });

  test('a repo switched off during the checkout launches nothing', async () => {
    let served = [APP];
    const checkout = git.checkout.bind(git);
    git.checkout = async (folder, ref, d) => { served = []; await checkout(folder, ref, d); };
    makeLane({ repos: () => served });
    await lane.pass();
    await lane.idle();
    expect(t3.launches).toEqual([]);
    expect(log.jobs()[0]!.end).toMatchObject({ outcome: 'not-started', error: 'app is no longer served' });
    expect(git.calls.at(-1)).toMatch(/^removeCheckout /);
  });

  test("a step before the launch failing for a moment isn't a failed review: the PR rests, then is reviewed", async () => {
    let at = new Date('2026-11-19T12:00:00Z');
    const checkout = git.checkout.bind(git);
    let fails = 1;
    git.checkout = async (folder, ref, d) => { if (fails-- > 0) throw new Error('git worktree add failed: index.lock exists'); await checkout(folder, ref, d); };
    makeLane({ now: () => at });
    await lane.pass();
    await lane.idle();
    expect(log.jobs().map((j) => j.end?.outcome)).toEqual(['not-started']);
    expect(lines.at(-1)).toMatch(/not now, its last review started no thread; it rests until 2026-11-19T12:05:00/);
    await lane.pass();
    expect(t3.launches).toEqual([]);
    at = new Date('2026-11-19T12:05:01Z');
    const passed = lane.pass();
    await answer(1, reply([]));
    await passed;
    await lane.idle();
    expect(log.jobs().map((j) => j.end?.outcome)).toEqual(['not-started', 'clean']);
  });

  test('a comment that fails to post is posted again after the wait, never taken as a failed review', async () => {
    gh.failing.add('comment');
    makeLane();
    const passed = lane.pass();
    await answer(1, reply([]));
    await passed;
    await until(() => retries.size > 0);
    expect(lines.join('\n')).toMatch(/Posting the review comment failed .*Posting it again after a wait\./);
    gh.failing.delete('comment');
    retryNow();
    await until(() => log.jobs()[0]!.end !== undefined);
    await lane.idle();
    expect(log.jobs()[0]!.end).toMatchObject({ outcome: 'clean' });
    expect(gh.posted.filter((p) => p.what === 'comment')).toHaveLength(1);
  });

  test('sol-review or the row failing after the comment is tried again until it lands; the job stays open meanwhile (F14)', async () => {
    gh.failing.add('status');
    gh.failing.add('body');
    makeLane();
    const passed = lane.pass();
    await answer(1, reply([]));
    await passed;
    await until(() => retries.size > 0);
    expect(log.jobs()[0]!.end).toBeUndefined();
    expect(lines.join('\n')).toMatch(/the review is posted, but setting sol-review on abcdef1 failed .* Trying again after a wait\./);
    gh.failing.delete('body');
    retryNow();
    await until(() => retries.size > 0);
    expect(log.jobs()[0]!.end).toBeUndefined();
    gh.failing.delete('status');
    retryNow();
    await until(() => log.jobs()[0]!.end !== undefined);
    await lane.idle();
    expect(log.jobs()[0]!.end).toMatchObject({ outcome: 'clean' });
    expect(gh.posted.map((p) => p.what)).toEqual(['comment', 'body', 'status']);
    expect(gh.posted[2]).toMatchObject({ sha: H, state: 'success' });
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

  test('a review called directly (the live check) on an instance not named launches nothing', async () => {
    toolFree = [FALLBACK.provider];
    makeLane();
    const job = await lane.review(APP, pull(), { choice: REVIEW, onFallback: false, cost: {}, reviewer: 'R' });
    expect(t3.launches).toEqual([]);
    expect(job.end).toMatchObject({ outcome: 'not-started' });
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

  test('a fix round writing to the branch holds the review; the head it pushed gets a fresh reviewer, and the lane says the review ended (#156)', async () => {
    gh.comments['owner/app#4'] = [{ author: 'me', createdAt: '2026-11-19T11:00:00Z', body: `<!-- queue-runner-app review round=1 verdict=blocking sha=${H.slice(0, 7)} findings=W10= -->` }];
    const earlier = await log.started({ kind: 'review', repo: 'p-app', github: 'owner/app', issue: 4, branch: 'claude/add-a-thing-3', base: 'main', title: 'r', choice: REVIEW, onFallback: false, sha: H, round: 1, reviewer: 'r' });
    await log.thread(earlier.id, { threadId: 'old-review', runId: 'r', link: null });
    await log.ended(earlier.id, { outcome: 'blocking', verdict: 'blocking' });
    const fix = await log.started({ kind: 'fix', repo: 'p-app', github: 'owner/app', issue: 4, branch: 'claude/add-a-thing-3', base: 'main', title: 'f', choice: BUILD, onFallback: false, sha: H, round: 1, to: 'thread-b' });
    gh.reviewPulls['owner/app'] = [pull({ headSha: H2 })];
    gh.checkStates[H2] = { state: 'passed', pending: [], failed: [] };
    git.heads[4] = H2;
    const ended: string[] = [];
    makeLane({ ended: (j) => ended.push(`${j.round} ${j.end!.outcome}`) });
    await lane.pass();
    expect(t3.launches).toEqual([]);
    expect(lines).toContain('review app#4: not now, a fix job is still writing to its branch');
    await log.ended(fix.id, { outcome: 'done', head: H2 });
    const passed = lane.pass();
    await answer(1, reply([]));
    await passed;
    await lane.idle();
    // a new thread, never a send to the review thread before it
    expect(t3.launches).toHaveLength(1);
    expect(t3.sends).toEqual([]);
    expect(t3.launches[0].message).toContain(H2);
    expect(ended).toEqual(['2 clean']);
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
});

describe('it starts clean', () => {
  test("a PR the Python runner reviewed, its Review table in the body, gets a fresh review 1, and its table is neither read nor rewritten", async () => {
    const python = '## Review\n\n| Step | Time (UTC) | Commit | Verdict |\n|---|---|---|---|\n| [Sol review 2](https://x) | 2026-11-18 10:00 | `abcdef1` | **Clean** |\n';
    gh.bodies['owner/app#4'] = `## Summary\n\nx\n\n${python}`;
    // the Python runner's review of this very head: the app doesn't read it, so H isn't reviewed yet
    gh.comments['owner/app#4'] = [{ author: 'someone', createdAt: '1', body: `## Sol review 2 · Clean\n\n<!-- sol-pr-review round=2 verdict=clean sha=${H} findings=W10= -->` }];
    makeLane();
    const passed = lane.pass();
    await answer(1, reply([]));
    await passed;
    await lane.idle();
    const comment = gh.posted.find((p) => p.what === 'comment')!;
    expect(comment.body).toMatch(/^## Sol review 1 · Clean/);
    expect(t3.launches[0].message).not.toContain('You last reviewed');
    const body = gh.bodies['owner/app#4']!;
    expect(body.startsWith(`## Summary\n\nx\n\n${python}\n${TABLE_START}\n| Step | Reviewer |`)).toBe(true);
    expect(body.endsWith(`\n\n${TABLE_END}\n`)).toBe(true);
    expect(gh.bodies['owner/app#4']).toContain(`| [Review 1](${comment.url}) | GPT-6.2-Sol High |`);
  });
});

describe('after a restart', () => {
  /** A review an app launched and then stopped watching (it quit): its job is open, its thread saved. */
  async function cutOff() {
    makeLane();
    void lane.pass();
    await until(() => t3.threadStreamCount('thread-1') > 0);
    lane.stop();
    await lane.idle();
    const job = log.jobs()[0]!;
    expect(job).toMatchObject({ threadId: 'thread-1', runId: 'run-1' });
    expect(job.end).toBeUndefined();
    // its checkout stays: the thread runs on in it
    expect(git.calls.filter((c) => c.startsWith('removeCheckout'))).toEqual([]);
    return job;
  }
  const organized = () => t3.toolCalls.filter((c) => c.tool === 't3_thread_organize').map((c) => c.args.threadId);

  test('a review with a saved thread id carries on with it: watched to its end, read, posted, its checkout removed and its thread settled', async () => {
    const job = await cutOff();
    makeLane();
    void lane.start();
    await until(() => t3.threadStreamCount('thread-1') > 0);
    await lane.pass();
    expect(t3.launches).toHaveLength(1); // no second review while it runs
    t3.say('thread-1', reply([{ id: 'F1', tag: 'important', class: 'unchecked input', file: 'src/a.ts', line: 3, scenario: 'empty input crashes' }]));
    t3.endRun('thread-1', 'completed');
    await until(() => log.get(job.id)!.end !== undefined);
    await lane.idle();
    expect(log.get(job.id)).toMatchObject({ end: { outcome: 'blocking', verdict: 'blocking' }, settledAt: expect.any(String) });
    expect(readReviews(gh.comments['owner/app#4']!)).toMatchObject([{ round: 1, verdict: 'blocking', sha: H }]);
    expect(gh.posted.filter((p) => p.what === 'status')).toEqual([expect.objectContaining({ sha: H, state: 'failure' })]);
    expect(gh.bodies['owner/app#4']).toContain('| [Review 1](');
    expect(git.calls.at(-1)).toBe(`removeCheckout ${join(dir, 'state', 'checkouts', 'app-pr4')} refs/queue-runner/pr4`);
    expect(organized()).toEqual(['thread-1']);
    expect(t3.launches).toHaveLength(1);
  });

  test("T3's reads failing or coming back empty for a moment are asked again, never taken as no reply or a failed review (F12)", async () => {
    const job = await cutOff();
    makeLane();
    void lane.start();
    await until(() => t3.threadStreamCount('thread-1') > 0);
    t3.readFailures = 2;
    t3.emptyReads = 1;
    t3.say('thread-1', reply([]));
    t3.endRun('thread-1', 'completed');
    for (let i = 0; i < 3; i++) {
      await until(() => retries.size > 0);
      retryNow();
    }
    await until(() => log.get(job.id)!.end !== undefined);
    await lane.idle();
    expect(log.get(job.id)!.end).toMatchObject({ outcome: 'clean' });
    expect(lines.filter((l) => /its reply couldn't be read/.test(l))).toHaveLength(2);
    expect(lines.filter((l) => /reply empty; reading it again/.test(l))).toHaveLength(1);
  });

  test('a review posted before the app stopped is recorded, never posted twice; its status and row follow', async () => {
    const job = await cutOff();
    const url = 'https://github.com/owner/app/pull/4#issuecomment-77';
    gh.comments['owner/app#4'] = [{ author: 'me', createdAt: '2', body: `<!-- queue-runner-app review round=1 verdict=clean sha=${H} findings=W10= -->`, url }];
    makeLane();
    void lane.start();
    await until(() => t3.threadStreamCount('thread-1') > 0);
    t3.say('thread-1', reply([]));
    t3.endRun('thread-1', 'completed');
    await until(() => log.get(job.id)!.end !== undefined);
    await lane.idle();
    expect(log.get(job.id)!.end).toMatchObject({ outcome: 'clean', link: url });
    expect(gh.posted.map((p) => p.what)).toEqual(['status', 'body']);
    expect(gh.posted[0]).toMatchObject({ sha: H, state: 'success', url });
    expect(gh.bodies['owner/app#4']).toContain(`| [Review 1](${url}) |`);
    expect(lines.join('\n')).toMatch(/is on the PR already \(posted before the app stopped\); not posted again/);
  });

  test('a status that never landed before the app stopped is set by the next start, the comment not posted again (F14)', async () => {
    gh.failing.add('status');
    makeLane();
    void lane.pass();
    await answer(1, reply([]));
    await until(() => retries.size > 0);
    lane.stop();
    await lane.idle();
    const job = log.jobs()[0]!;
    expect(job.end).toBeUndefined(); // left open: the next start carries on
    gh.failing.delete('status');
    makeLane();
    await lane.start();
    await until(() => log.get(job.id)!.end !== undefined);
    await lane.idle();
    expect(log.get(job.id)!.end).toMatchObject({ outcome: 'clean' });
    expect(gh.posted.map((p) => p.what)).toEqual(['comment', 'body', 'status']);
    expect(t3.launches).toHaveLength(1);
  });

  test('one with no saved thread id needs the user: no thread is matched to it, its checkout stays, and its repo starts nothing until the user answers', async () => {
    // a thread of its very title and project in T3: never taken for it
    t3.threadState['same-title'] = { id: 'same-title', projectId: 'p-app', title: 'Queue runner review: app#4', runtimeRequests: [], turnItems: [], runs: [{ id: 'r', ordinal: 1, rootNodeId: 'n', status: 'running' }] };
    const job = await log.started({ kind: 'review', repo: 'p-app', github: 'owner/app', issue: 4, branch: pull().branch, base: 'main', title: 'Queue runner review: app#4', choice: REVIEW, onFallback: false, sha: H, round: 1, reviewer: 'R' });
    makeLane();
    await lane.start();
    await lane.idle();
    expect(log.get(job.id)).toMatchObject({ end: { outcome: 'needs-user', error: 'the app stopped before T3 named its thread' } });
    expect(t3.threadStreamCount('same-title')).toBe(0);
    expect(t3.toolCalls.filter((c) => c.tool !== 't3_project_list')).toEqual([]);
    expect(git.calls).toEqual([]);
    await lane.pass();
    expect(t3.launches).toEqual([]);
    expect(lines).toContain('app: no review while Queue runner review: app#4 needs you');
    // the user answers: the repo is free, and the PR is reviewed afresh
    const passed = lane.answered(job.id);
    await answer(1, reply([]));
    await passed;
    await lane.idle();
    expect(log.jobs().at(-1)).toMatchObject({ end: { outcome: 'clean' } });
  });

  test('a launch whose answer was lost needs the user: its checkout stays for the thread T3 may have started, and nothing else starts', async () => {
    t3.launchAnswerLost = true;
    makeLane();
    await lane.pass();
    await lane.idle();
    const [job] = log.jobs();
    expect(job).toMatchObject({ end: { outcome: 'needs-user', error: expect.stringMatching(/answer was lost/) } });
    expect(job!.threadId).toBeUndefined();
    expect(t3.threadStreamCount('thread-1')).toBe(0);
    expect(git.calls.some((c) => c.startsWith('removeCheckout'))).toBe(false);
    expect(organized()).toEqual([]);
    t3.launchAnswerLost = false;
    await lane.pass();
    expect(t3.launches).toHaveLength(1);
  });

  test('a build that needs the user holds the review lane too: one ticket at a time, whichever lane', async () => {
    const build = await log.started({ kind: 'build', repo: 'p-app', github: 'owner/app', issue: 3, branch: 'claude/x-3', base: 'main', title: 'Queue runner build: app#3', choice: BUILD, onFallback: false });
    await log.ended(build.id, { outcome: 'needs-user', error: 'lost' });
    makeLane();
    await lane.pass();
    expect(t3.launches).toEqual([]);
    expect(lines).toEqual(['app: no review while Queue runner build: app#3 needs you']);
  });
});

describe('a reply', () => {
  test('T3 giving it empty three reads in a row fails the review', async () => {
    makeLane();
    const passed = lane.pass();
    await until(() => t3.threadStreamCount('thread-1') > 0);
    gh.reviewPulls['owner/app'] = []; // nothing to review after it
    t3.endRun('thread-1', 'completed');
    for (let i = 0; i < 2; i++) {
      await until(() => retries.size > 0);
      retryNow();
    }
    await passed;
    await until(() => log.jobs()[0]!.end !== undefined);
    await lane.idle();
    expect(log.jobs()[0]!.end).toMatchObject({ outcome: 'failed', error: expect.stringMatching(/completed with an empty reply \(read 3 times\)/) });
    expect(gh.posted).toEqual([]);
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
