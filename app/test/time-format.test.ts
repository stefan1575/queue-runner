// T3's Time format, read from T3's client-settings.json (the one exception to "no reads of T3's
// settings", docs/app.md): that one key, never written, watched for changes, System default when
// it can't be read. A fake file in a temp folder stands in for T3's, and the test runs each poll
// itself (`Poll`), so nothing waits for real time to pass (#202); the real poll runs on the fake
// clock.
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { TimeFormat } from '../src/display.ts';
import { type Poll, pollEvery, readTimeFormat, T3TimeFormat } from '../src/t3/time-format.ts';

let dirs: string[] = [];
let sources: T3TimeFormat[] = [];
afterEach(async () => {
  for (const s of sources) s.close();
  sources = [];
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});
async function userdata() {
  const d = await mkdtemp(join(tmpdir(), 'qr-timeformat-'));
  dirs.push(d);
  return d;
}
const settingsFile = (d: string) => join(d, 'client-settings.json');
// T3 keeps other client settings in the same file; the app reads only timestampFormat.
const t3Writes = (d: string, settings: object) =>
  writeFile(settingsFile(d), JSON.stringify({ wordWrap: true, diffLayout: 'split', ...settings }));
/** A source whose polls the test runs: `poll()` is one read of the file, as the real poll's
 *  timer would make; `stopped` says whether the source let its poll go. */
async function start(d: string) {
  let tick: () => Promise<void> = async () => { throw new Error('no poll asked for'); };
  const ran = { stopped: false };
  const poll: Poll = (t) => { tick = t; return () => { ran.stopped = true; }; };
  const source = await T3TimeFormat.start(settingsFile(d), poll);
  sources.push(source);
  return Object.assign(ran, { source, poll: () => tick() });
}

describe('reading the Time format', () => {
  test("each of T3's three choices", async () => {
    const d = await userdata();
    for (const f of ['locale', '12-hour', '24-hour'] as TimeFormat[]) {
      await t3Writes(d, { timestampFormat: f });
      expect(await readTimeFormat(settingsFile(d))).toBe(f);
    }
  });

  test('System default when the file is missing, unreadable, or has no such key or another value', async () => {
    const d = await userdata();
    expect(await readTimeFormat(settingsFile(d))).toBe('locale');
    await writeFile(settingsFile(d), '{half a file');
    expect(await readTimeFormat(settingsFile(d))).toBe('locale');
    await t3Writes(d, {});
    expect(await readTimeFormat(settingsFile(d))).toBe('locale');
    await t3Writes(d, { timestampFormat: 'sundial' });
    expect(await readTimeFormat(settingsFile(d))).toBe('locale');
    await mkdir(join(d, 'dir'));
    expect(await readTimeFormat(join(d, 'dir'))).toBe('locale');
  });
});

describe('following T3', () => {
  test('a change in T3 reaches the listeners at the next poll, and the file is never written', async () => {
    const d = await userdata();
    await t3Writes(d, { timestampFormat: '24-hour' });
    const { source, poll } = await start(d);
    expect(source.current()).toBe('24-hour');
    const seen: TimeFormat[] = [];
    source.onChange((f) => seen.push(f));

    await t3Writes(d, { timestampFormat: '12-hour' });
    expect(seen).toEqual([]);
    await poll();
    expect(seen).toEqual(['12-hour']);
    expect(source.current()).toBe('12-hour');
    expect(JSON.parse(await readFile(settingsFile(d), 'utf8')).wordWrap).toBe(true);
  });

  test('a file replaced by a rename (written aside, then moved over) is followed too', async () => {
    const d = await userdata();
    await t3Writes(d, { timestampFormat: 'locale' });
    const { source, poll } = await start(d);
    const seen: TimeFormat[] = [];
    source.onChange((f) => seen.push(f));
    await writeFile(join(d, 'client-settings.json.tmp'), JSON.stringify({ timestampFormat: '24-hour' }));
    await rename(join(d, 'client-settings.json.tmp'), settingsFile(d));
    await poll();
    expect(source.current()).toBe('24-hour');
    expect(seen).toEqual(['24-hour']);
  });

  test('the file going away falls back to System default, and coming back is read', async () => {
    const d = await userdata();
    await t3Writes(d, { timestampFormat: '12-hour' });
    const { source, poll } = await start(d);
    await rm(settingsFile(d));
    await poll();
    expect(source.current()).toBe('locale');
    await t3Writes(d, { timestampFormat: '24-hour' });
    await poll();
    expect(source.current()).toBe('24-hour');
  });

  test('a write that leaves the Time format alone tells no one', async () => {
    const d = await userdata();
    await t3Writes(d, { timestampFormat: '24-hour' });
    const { source, poll } = await start(d);
    const seen: TimeFormat[] = [];
    source.onChange((f) => seen.push(f));
    await t3Writes(d, { timestampFormat: '24-hour', wordWrap: false });
    await poll();
    expect(seen).toEqual([]);
    await t3Writes(d, { timestampFormat: '12-hour' });
    await poll();
    expect(seen).toEqual(['12-hour']);
  });

  test('a write right after the start is seen by the first poll', async () => {
    // CI, 2026-11-18 and 19: a stat poll took its first stat after the start's read, so a write
    // in between was never seen. Each poll reads the file, so the first one sees it.
    const d = await userdata();
    await t3Writes(d, { timestampFormat: '24-hour' });
    const { source, poll } = await start(d);
    await t3Writes(d, { timestampFormat: '12-hour' });
    await poll();
    expect(source.current()).toBe('12-hour');
  });

  test('a closed source lets its poll go, and a read already on its way tells no one', async () => {
    const d = await userdata();
    await t3Writes(d, { timestampFormat: '24-hour' });
    const started = await start(d);
    const seen: TimeFormat[] = [];
    started.source.onChange((f) => seen.push(f));
    await t3Writes(d, { timestampFormat: '12-hour' });
    const reading = started.poll();
    started.source.close();
    await reading;
    expect(started.stopped).toBe(true);
    expect(seen).toEqual([]);
    expect(started.source.current()).toBe('24-hour');
  });

  test("no T3 folder at all is System default, and the start doesn't fail", async () => {
    const d = await userdata();
    const { source } = await start(join(d, 'no-such-userdata'));
    expect(source.current()).toBe('locale');
  });
});

describe('the real poll, on the fake clock', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  test('ticks every interval, and keeps ticking', async () => {
    let ticks = 0;
    const stop = pollEvery(500)(async () => { ticks++; });
    await vi.advanceTimersByTimeAsync(499);
    expect(ticks).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(ticks).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ticks).toBe(3);
    stop();
  });

  test('sets the next wait only once a tick is done, so a slow read never overlaps the next', async () => {
    let ticks = 0;
    let finish = () => {};
    const stop = pollEvery(500)(() => { ticks++; return new Promise<void>((r) => { finish = r; }); });
    await vi.advanceTimersByTimeAsync(500);
    expect(ticks).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(ticks).toBe(1);
    finish();
    await vi.advanceTimersByTimeAsync(500);
    expect(ticks).toBe(2);
    stop();
  });

  test('stopped, it ticks no more, even when stopped while a tick is on its way', async () => {
    let ticks = 0;
    let finish = () => {};
    const stop = pollEvery(500)(() => { ticks++; return new Promise<void>((r) => { finish = r; }); });
    await vi.advanceTimersByTimeAsync(500);
    stop();
    finish();
    await vi.advanceTimersByTimeAsync(5000);
    expect(ticks).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
