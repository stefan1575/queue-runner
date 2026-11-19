// T3's projects, kept from T3's events (#151): `subscribeShell`'s snapshot, then each project
// added, changed or removed in T3, with no polling. Run against the fake T3 behind the real
// WebSocket client, with T3's address answered by the fake too, so every wait here is on the
// fake and none on a real file read (#202 F2).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { T3ProjectFeed } from '../src/t3/project-feed.ts';
import { T3Ws } from '../src/t3/ws.ts';
import { FakeT3 } from './fake-t3.ts';

let t3: FakeT3;
let feeds: T3ProjectFeed[] = [];
/** The retries the feed asked for, run by the test when it wants. */
let retries: (() => void)[] = [];

beforeEach(() => {
  t3 = new FakeT3();
  t3.projects = [{ id: 'p1', title: 'sandbox', workspaceRoot: 'C:/sandbox' }];
});
afterEach(() => {
  for (const f of feeds) f.stop();
  feeds = [];
  retries = [];
});

function feed() {
  const ws = new T3Ws(t3.address, t3.cli, t3.http, t3.connect);
  const f = T3ProjectFeed.start(ws, (again) => { retries.push(again); return () => {}; });
  feeds.push(f);
  return f;
}
const ids = (f: T3ProjectFeed) => f.current()?.map((p) => p.id) ?? null;

describe("T3's projects", () => {
  test("start from T3's snapshot, threads ignored", async () => {
    const f = feed();
    expect(f.current()).toBeNull();
    await vi.waitFor(() => expect(f.current()).not.toBeNull());
    expect(f.current()).toEqual([{ id: 'p1', title: 'sandbox', folder: 'C:/sandbox' }]);
    expect(t3.frames.filter((m) => m._tag === 'Request').map((m) => m.tag)).toEqual(['orchestration.subscribeShell']);
  });

  test('a project added or removed in T3 shows up or goes, and each change is told', async () => {
    const f = feed();
    await vi.waitFor(() => expect(ids(f)).toEqual(['p1']));
    let told = 0;
    f.onChange(() => { told++; });
    t3.addProject({ id: 'p2', title: 'blog', workspaceRoot: 'C:/blog' });
    await vi.waitFor(() => expect(ids(f)).toEqual(['p1', 'p2']));
    t3.removeProject('p1');
    await vi.waitFor(() => expect(ids(f)).toEqual(['p2']));
    expect(told).toBe(2);
  });

  test('a stream T3 ends is opened again, and its new snapshot replaces the old list', async () => {
    const f = feed();
    await vi.waitFor(() => expect(ids(f)).toEqual(['p1']));
    t3.endShells();
    t3.projects = [{ id: 'p3', title: 'other', workspaceRoot: 'C:/other' }];
    await vi.waitFor(() => expect(retries).toHaveLength(1));
    expect(f.error()).toMatch(/T3's WebSocket closed/);
    expect(ids(f)).toEqual(['p1']); // the last list stays while T3 is away
    expect(retries).toHaveLength(1);
    retries[0]!();
    await vi.waitFor(() => expect(ids(f)).toEqual(['p3']));
    expect(f.error()).toBeNull();
    expect(t3.shellCount).toBe(1);
  });

  test("a stream T3 says needs a new snapshot is opened again at once, and isn't counted as down", async () => {
    const f = feed();
    await vi.waitFor(() => expect(ids(f)).toEqual(['p1']));
    t3.projects.push({ id: 'p2', title: 'blog', workspaceRoot: 'C:/blog' }); // missed by the stream
    t3.requireSnapshot();
    await vi.waitFor(() => expect(ids(f)).toEqual(['p1', 'p2']));
    expect(retries).toEqual([]);
    expect(f.error()).toBeNull();
    expect(t3.frames.filter((m) => m._tag === 'Request').map((m) => m.tag)).toEqual(['orchestration.subscribeShell', 'orchestration.subscribeShell']);
  });

  test('an archived project is left out, and comes back when T3 brings it back', async () => {
    t3.projects.push({ id: 'p2', title: 'old', workspaceRoot: 'C:/old', archivedAt: '2026-11-01T00:00:00.000Z' });
    const f = feed();
    await vi.waitFor(() => expect(ids(f)).toEqual(['p1']));
    t3.archiveProject('p1', true);
    await vi.waitFor(() => expect(ids(f)).toEqual([]));
    t3.archiveProject('p2', false);
    await vi.waitFor(() => expect(ids(f)).toEqual(['p2']));
  });

  test('T3 not running leaves no list and says why, and is tried again', async () => {
    t3.running = false;
    const f = feed();
    await vi.waitFor(() => expect(retries).toHaveLength(1));
    expect(f.current()).toBeNull();
    expect(f.error()).toMatch(/T3's server isn't running/);
  });
});
