// T3's Time format, read from T3's client-settings.json (the one exception to "no reads of T3's
// settings", docs/app.md): that one key, never written, watched for changes, System default when
// it can't be read. A fake file in a temp folder stands in for T3's.
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { TimeFormat } from '../src/display.ts';
import { readTimeFormat, T3TimeFormat } from '../src/t3/time-format.ts';

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
async function start(d: string) {
  const s = await T3TimeFormat.start(settingsFile(d));
  sources.push(s);
  return s;
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
  test('a change in T3 reaches the listeners, and the file is never written', async () => {
    const d = await userdata();
    await t3Writes(d, { timestampFormat: '24-hour' });
    const source = await start(d);
    expect(source.current()).toBe('24-hour');
    const seen: TimeFormat[] = [];
    source.onChange((f) => seen.push(f));

    await t3Writes(d, { timestampFormat: '12-hour' });
    await vi.waitFor(() => expect(seen).toEqual(['12-hour']), { timeout: 5000 });
    expect(source.current()).toBe('12-hour');
    expect(JSON.parse(await readFile(settingsFile(d), 'utf8')).wordWrap).toBe(true);
  });

  test('a file replaced by a rename (written aside, then moved over) is followed too', async () => {
    const d = await userdata();
    await t3Writes(d, { timestampFormat: 'locale' });
    const source = await start(d);
    const seen: TimeFormat[] = [];
    source.onChange((f) => seen.push(f));
    await writeFile(join(d, 'client-settings.json.tmp'), JSON.stringify({ timestampFormat: '24-hour' }));
    await rename(join(d, 'client-settings.json.tmp'), settingsFile(d));
    await vi.waitFor(() => expect(source.current()).toBe('24-hour'), { timeout: 5000 });
    expect(seen.at(-1)).toBe('24-hour');
  });

  test('the file going away falls back to System default, and coming back is read', async () => {
    const d = await userdata();
    await t3Writes(d, { timestampFormat: '12-hour' });
    const source = await start(d);
    await rm(settingsFile(d));
    await vi.waitFor(() => expect(source.current()).toBe('locale'), { timeout: 5000 });
    await t3Writes(d, { timestampFormat: '24-hour' });
    await vi.waitFor(() => expect(source.current()).toBe('24-hour'), { timeout: 5000 });
  });

  test('a write that leaves the Time format alone tells no one', async () => {
    const d = await userdata();
    await t3Writes(d, { timestampFormat: '24-hour' });
    const source = await start(d);
    const seen: TimeFormat[] = [];
    source.onChange((f) => seen.push(f));
    await t3Writes(d, { timestampFormat: '24-hour', wordWrap: false });
    await t3Writes(d, { timestampFormat: '12-hour' });
    await vi.waitFor(() => expect(seen).toEqual(['12-hour']), { timeout: 5000 });
  });

  test('a file caught mid-write (emptied, not yet filled) tells no one, and its end is read', async () => {
    const d = await userdata();
    await t3Writes(d, { timestampFormat: '24-hour' });
    const source = await start(d);
    const seen: TimeFormat[] = [];
    source.onChange((f) => seen.push(f));
    await writeFile(settingsFile(d), '');
    await new Promise((r) => setTimeout(r, 1200)); // past two polls of the empty file
    expect(source.current()).toBe('24-hour');
    await t3Writes(d, { timestampFormat: '12-hour' });
    await vi.waitFor(() => expect(seen).toEqual(['12-hour']), { timeout: 3000 });
  });

  test('a file replaced by one that stays unreadable is System default once it settles', async () => {
    const d = await userdata();
    await t3Writes(d, { timestampFormat: '24-hour' });
    const source = await start(d);
    const seen: TimeFormat[] = [];
    source.onChange((f) => seen.push(f));
    await writeFile(join(d, 'next.json'), '{invalid');
    await rename(join(d, 'next.json'), settingsFile(d));
    await vi.waitFor(() => expect(seen).toEqual(['locale']), { timeout: 5000 });
  });

  test('a file emptied and never filled is System default once it settles', async () => {
    const d = await userdata();
    await t3Writes(d, { timestampFormat: '12-hour' });
    const source = await start(d);
    await writeFile(settingsFile(d), '');
    await vi.waitFor(() => expect(source.current()).toBe('locale'), { timeout: 5000 });
  });

  // The settle look, driven by hand: the test says when a poll sees the file, so a change the
  // poll hasn't seen yet is there when the look comes.
  async function startPolledByHand(d: string, settleMs = 300) {
    let poll = () => {};
    const s = await T3TimeFormat.start(settingsFile(d), {
      settleMs,
      watch: (_file, changed) => {
        poll = changed;
        return () => {};
      },
    });
    sources.push(s);
    return { source: s, poll: () => poll() };
  }
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test('a save read whole drops the look a half-written one asked for (Sol F3)', async () => {
    const d = await userdata();
    await t3Writes(d, { timestampFormat: '24-hour' });
    const { source, poll } = await startPolledByHand(d);
    const seen: TimeFormat[] = [];
    source.onChange((f) => seen.push(f));
    await writeFile(settingsFile(d), '');
    poll();
    await pause(50);
    await t3Writes(d, { timestampFormat: '12-hour' });
    poll();
    await vi.waitFor(() => expect(seen).toEqual(['12-hour']));
    await writeFile(settingsFile(d), ''); // the next save, emptied; no poll has seen it yet
    await pause(400); // past the first look's time
    await t3Writes(d, { timestampFormat: '24-hour' });
    poll();
    await vi.waitFor(() => expect(seen).toEqual(['12-hour', '24-hour']));
  });

  test('a look finding the file changed since it was asked for gives the new state its own time', async () => {
    const d = await userdata();
    await t3Writes(d, { timestampFormat: '24-hour' });
    const { source, poll } = await startPolledByHand(d);
    const seen: TimeFormat[] = [];
    source.onChange((f) => seen.push(f));
    await writeFile(settingsFile(d), '{');
    poll();
    await pause(150);
    await writeFile(settingsFile(d), '{"timestampFormat"'); // a second half-write, not yet polled
    await pause(250); // the first look comes: this state is 100 ms old, not settled
    expect(seen).toEqual([]);
    await t3Writes(d, { timestampFormat: '12-hour' });
    poll();
    await vi.waitFor(() => expect(seen).toEqual(['12-hour']));
    await pause(400);
    expect(seen).toEqual(['12-hour']);
  });

  test('a half-written file left as it is still settles to System default when polled by hand', async () => {
    const d = await userdata();
    await t3Writes(d, { timestampFormat: '24-hour' });
    const { source, poll } = await startPolledByHand(d);
    await writeFile(settingsFile(d), '{');
    poll();
    await vi.waitFor(() => expect(source.current()).toBe('locale'));
  });

  test("no T3 folder at all is System default, and the start doesn't fail", async () => {
    const d = await userdata();
    const source = await start(join(d, 'no-such-userdata'));
    expect(source.current()).toBe('locale');
  });
});
