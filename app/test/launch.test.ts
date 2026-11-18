// One launch for every kind of job (#152): a full-access T3 thread on the kind's provider
// instance, model and effort, the effort under the option id T3 gave for that model.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { DEFAULT_JOBS, JOB_KINDS, type Jobs } from '../src/jobs.ts';
import { JobError, launchJob } from '../src/launch.ts';
import { catalogFromConfig } from '../src/t3/catalog.ts';
import { T3Mcp } from '../src/t3/mcp.ts';
import { runtimeAddress } from '../src/t3/real.ts';
import { FakeT3 } from './fake-t3.ts';

let dir: string;
let t3: FakeT3;
let mcp: T3Mcp;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qr-launch-'));
  t3 = new FakeT3();
  const runtime = join(dir, 'server-runtime.json');
  await writeFile(runtime, JSON.stringify({ origin: t3.origin }));
  mcp = new T3Mcp(runtimeAddress(runtime), t3.cli, t3.http);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const config = JSON.parse(await readFile(new URL('./fixtures/server-config.json', import.meta.url), 'utf8')).config;
const catalog = catalogFromConfig(config);
const [a, b] = catalog.providers as [typeof catalog.providers[0], typeof catalog.providers[0]];
const last = (p: typeof a) => {
  const m = p.models.find((x) => x.efforts.length > 1 && !x.isDefault)!;
  return { provider: p.id, model: m.id, effort: m.efforts.at(-2)!.id, option: m.effortOption };
};
const job = { projectId: 'p1', title: 'Build #7', brief: 'Build issue #7.' };

describe('launching a job', () => {
  test("a kind with no settings of its own launches on Default's; one with its own on those", async () => {
    const def = last(b), own = last(a);
    const jobs: Jobs = { ...DEFAULT_JOBS, default: { provider: def.provider, model: def.model, effort: def.effort }, review: { own: { provider: own.provider, model: own.model, effort: own.effort }, fallback: null } };
    for (const k of JOB_KINDS) await launchJob(mcp, jobs, catalog, { ...job, kind: k.id });
    const sel = (x: typeof def) => ({ instanceId: x.provider, model: x.model, options: [{ id: x.option, value: x.effort }] });
    expect(t3.launches.map((l) => l.modelSelection)).toEqual(JOB_KINDS.map((k) => (k.id === 'review' ? sel(own) : sel(def))));
    expect(t3.launches[0]).toEqual({ projectId: 'p1', title: 'Build #7', message: 'Build issue #7.', runtimeMode: 'full-access', modelSelection: sel(def) });
  });

  test("each provider's effort goes under its own option id", async () => {
    const x = last(a), y = last(b);
    expect(x.option).not.toBe(y.option);
    for (const c of [x, y]) {
      await launchJob(mcp, { ...DEFAULT_JOBS, default: { provider: c.provider, model: c.model, effort: c.effort } }, catalog, { ...job, kind: 'build' });
    }
    expect(t3.launches.map((l) => l.modelSelection.options)).toEqual([[{ id: x.option, value: x.effort }], [{ id: y.option, value: y.effort }]]);
  });

  test("a new install launches on T3's default", async () => {
    await launchJob(mcp, DEFAULT_JOBS, catalog, { ...job, kind: 'fix' });
    const d = catalog.t3Default!;
    expect(t3.launches[0].modelSelection.instanceId).toBe(d.provider);
    expect(t3.launches[0].modelSelection.model).toBe(d.model);
    expect(t3.launches[0].modelSelection.options[0].value).toBe(d.effort);
  });

  test('a model with no effort to choose launches with no options', async () => {
    const p = catalog.providers.find((x) => x.models.some((m) => !m.efforts.length))!;
    const m = p.models.find((x) => !x.efforts.length)!;
    await launchJob(mcp, { ...DEFAULT_JOBS, default: { provider: p.id, model: m.id, effort: null } }, catalog, { ...job, kind: 'ask' });
    expect(t3.launches[0].modelSelection).toEqual({ instanceId: p.id, model: m.id, options: [] });
  });

  test('a worktree is made by T3 from its base ref', async () => {
    await launchJob(mcp, DEFAULT_JOBS, catalog, { ...job, kind: 'build', worktree: { baseRef: 'origin/main', branch: 'claude/x-7' } });
    expect(t3.launches[0].workspaceStrategy).toEqual({ type: 'worktree', baseRef: 'origin/main', branch: 'claude/x-7' });
  });

  test("on its fallback, a kind launches on the fallback's model", async () => {
    const f = last(a);
    const jobs: Jobs = { ...DEFAULT_JOBS, review: { own: null, fallback: { provider: f.provider, model: f.model, effort: f.effort } } };
    const got = await launchJob(mcp, jobs, catalog, { ...job, kind: 'review', onFallback: true });
    expect(t3.launches[0].modelSelection).toEqual({ instanceId: f.provider, model: f.model, options: [{ id: f.option, value: f.effort }] });
    expect(got).toMatchObject({ threadId: 'thread-1', runId: 'run-1', choice: { provider: f.provider, model: f.model, effort: f.effort } });
  });

  test('a kind with no fallback, asked for one, launches nothing', async () => {
    await expect(launchJob(mcp, DEFAULT_JOBS, catalog, { ...job, kind: 'review', onFallback: true })).rejects.toThrow(JobError);
    expect(t3.launches).toEqual([]);
  });

  test('with nothing connected, nothing launches', async () => {
    await expect(launchJob(mcp, DEFAULT_JOBS, { providers: [], t3Default: null }, { ...job, kind: 'build' })).rejects.toThrow(/no provider/);
    expect(t3.launches).toEqual([]);
  });
});
