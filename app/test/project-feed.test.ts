// T3's projects, kept from T3's events (#151): `subscribeShell`'s snapshot, then each project
// added, changed or removed in T3, with no polling. Run against the fake T3 behind the real
// WebSocket client.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { T3ProjectFeed } from '../src/t3/project-feed.ts';
import { runtimeAddress } from '../src/t3/real.ts';
import { T3Ws } from '../src/t3/ws.ts';
import { FakeT3 } from './fake-t3.ts';

let dir: string;
let t3: FakeT3;
let feeds: T3ProjectFeed[] = [];
/** The retries the feed asked for, run by the test when it wants. */
let retries: (() => void)[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qr-feed-'));
  t3 = new FakeT3();
  t3.projects = [{ id: 'p1', title: 'sandbox', workspaceRoot: 'C:/sandbox' }];
  await writeFile(join(dir, 'server-runtime.json'), JSON.stringify({ origin: t3.origin }));
});
afterEach(async () => {
  for (const f of feeds) f.stop();
  feeds = [];
  retries = [];
  await rm(dir, { recursive: true, force: true });
});

function feed() {
  const ws = new T3Ws(runtimeAddress(join(dir, 'server-runtime.json')), t3.cli, t3.http, t3.connect);
  const f = T3ProjectFeed.start(ws, (again) => { retries.push(again); return () => {}; });
  feeds.push(f);
  return f;
}
const settle = () => new Promise((r) => setTimeout(r, 20));
const ids = (f: T3ProjectFeed) => f.current()?.map((p) => p.id) ?? null;

describe("T3's projects", () => {
  test("start from T3's snapshot, threads ignored", async () => {
    const f = feed();
    expect(f.current()).toBeNull();
    await settle();
    expect(f.current()).toEqual([{ id: 'p1', title: 'sandbox', folder: 'C:/sandbox' }]);
    expect(t3.frames.filter((m) => m._tag === 'Request').map((m) => m.tag)).toEqual(['subscribeShell']);
  });

  test('a project added or removed in T3 shows up or goes, and each change is told', async () => {
    const f = feed();
    await settle();
    let told = 0;
    f.onChange(() => { told++; });
    t3.addProject({ id: 'p2', title: 'blog', workspaceRoot: 'C:/blog' });
    await settle();
    expect(ids(f)).toEqual(['p1', 'p2']);
    t3.removeProject('p1');
    await settle();
    expect(ids(f)).toEqual(['p2']);
    expect(told).toBe(2);
  });

  test('a stream T3 ends is opened again, and its new snapshot replaces the old list', async () => {
    const f = feed();
    await settle();
    t3.endShells();
    t3.projects = [{ id: 'p3', title: 'other', workspaceRoot: 'C:/other' }];
    await settle();
    expect(f.error()).toMatch(/T3's WebSocket closed/);
    expect(ids(f)).toEqual(['p1']); // the last list stays while T3 is away
    expect(retries).toHaveLength(1);
    retries[0]!();
    await settle();
    expect(ids(f)).toEqual(['p3']);
    expect(f.error()).toBeNull();
    expect(t3.shellCount).toBe(1);
  });

  test('T3 not running leaves no list and says why, and is tried again', async () => {
    await rm(join(dir, 'server-runtime.json'));
    const f = feed();
    await settle();
    expect(f.current()).toBeNull();
    expect(f.error()).toMatch(/T3's server isn't running/);
    expect(retries).toHaveLength(1);
  });
});
