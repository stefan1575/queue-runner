// T3's catalog as the app keeps it (#152): from `subscribeServerConfig`'s snapshot, kept current
// by its later events, and asked again when the stream ends.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { T3Catalog } from '../src/t3/catalog-source.ts';
import { runtimeAddress } from '../src/t3/real.ts';
import { T3Ws } from '../src/t3/ws.ts';
import { FakeT3 } from './fake-t3.ts';

const snapshot = JSON.parse(await readFile(new URL('./fixtures/server-config.json', import.meta.url), 'utf8'));
let dir: string;
let t3: FakeT3;
let ws: T3Ws;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qr-catalog-'));
  t3 = new FakeT3();
  t3.serverConfig = snapshot;
  const runtime = join(dir, 'server-runtime.json');
  await writeFile(runtime, JSON.stringify({ origin: t3.origin }));
  ws = new T3Ws(runtimeAddress(runtime), t3.cli, t3.http, t3.connect);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const until = (f: () => boolean) => vi.waitFor(() => { if (!f()) throw new Error('not yet'); }, { timeout: 2000, interval: 5 });

describe("T3's catalog, kept current", () => {
  test('starts empty, fills from the snapshot and follows provider and settings updates', async () => {
    const source = T3Catalog.start(ws, 10);
    const seen: (number | undefined)[] = [];
    source.onChange((s) => seen.push(s.catalog?.providers.length));
    expect(source.current().catalog).toBeNull();
    await until(() => source.current().catalog !== null);
    const all = source.current().catalog!;
    expect(all.providers.length).toBeGreaterThan(1);
    expect(t3.frames.find((f) => f.tag === 'subscribeServerConfig')?.payload).toEqual({ workspaceSnapshotsOnDemand: true });

    const one = snapshot.config.providers.filter((p: any) => p.instanceId === all.providers[1]!.id);
    t3.pushConfig('providerStatuses', { providers: one });
    await until(() => source.current().catalog!.providers.length === 1);
    expect(source.current().catalog!.t3Default?.provider).toBe(all.providers[1]!.id);

    const m = one[0].models[1];
    t3.pushConfig('settingsUpdated', { settings: { defaultModelSelection: { instanceId: one[0].instanceId, model: m.slug, options: [] } } });
    await until(() => source.current().catalog!.t3Default?.model === m.slug);
    expect(seen).toEqual([all.providers.length, 1, 1]);
    source.stop();
  });

  test("each provider's usage follows T3's providerStatuses events", async () => {
    const source = T3Catalog.start(ws, 10);
    expect(source.current().usage).toEqual([]);
    await until(() => source.current().usage.length > 0);
    const used = () => source.current().usage.find((u) => u.provider === 'claudeAgent')?.windows[0]?.usedPercent;
    expect(used()).toBe(46);
    const providers = structuredClone(snapshot.config.providers);
    providers.find((p: any) => p.instanceId === 'claudeAgent').usageLimits.windows[0].usedPercent = 71;
    t3.pushConfig('providerStatuses', { providers });
    await until(() => used() === 71);
    source.stop();
  });

  test('a stream that ends says why, keeps the last catalog and is asked again', async () => {
    const source = T3Catalog.start(ws, 10);
    await until(() => source.current().catalog !== null);
    t3.dropSockets();
    await until(() => source.current().error !== undefined);
    expect(source.current().error).toMatch(/closed/);
    expect(source.current().catalog).not.toBeNull();
    await until(() => source.current().error === undefined);
    expect(t3.frames.filter((f) => f.tag === 'subscribeServerConfig')).toHaveLength(2);
    source.stop();
  });
});
