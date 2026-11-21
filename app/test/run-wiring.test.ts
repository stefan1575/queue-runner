// The run loop as the app wires it (`src/run-wiring.ts`, #219): the served repos and a job's own
// repo from Repositories and each repo's base, and the run loop's own job log in the state folder.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Repo as AppRepo } from '../src/repos.ts';
import { Bases, firstCatalog, JOB_LOG, jobLog, repoLookup, runConfig, servedRepos, SharedTitles } from '../src/run-wiring.ts';
import { T3Catalog } from '../src/t3/catalog-source.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qr-wiring-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const repo = (title: string, o: Partial<AppRepo> = {}): AppRepo => ({
  id: `p-${title}`, title, folder: `C:/code/${title}`, github: `owner/${title}`, checking: false,
  served: true, merge: 'me', isNew: false, ...o,
});

/** Bases read at once from `known` (a repo missing from it is never read). */
async function bases(known: Record<string, string>, ...first: string[]) {
  const b = new Bases(async (g) => {
    if (!(g in known)) throw new Error('not found');
    return known[g]!;
  }, () => {});
  await b.load(first);
  return b;
}

describe('the config', () => {
  test("a served repo carries Settings' choice of who merges (#219 F9)", async () => {
    const b = await bases({ 'owner/a': 'main', 'owner/b': 'trunk' }, 'owner/a', 'owner/b');
    expect(servedRepos([repo('a', { merge: 'runner' }), repo('b')], b, new SharedTitles(() => {}))).toEqual([
      { name: 'a', github: 'owner/a', path: 'C:/code/a', base: 'main', merge: 'runner' },
      { name: 'b', github: 'owner/b', path: 'C:/code/b', base: 'trunk', merge: 'me' },
    ]);
  });

  test("a job's own repo is found served or not, its base null until read, and null while the app can't say (#219 F2, F3)", async () => {
    const b = await bases({ 'owner/a': 'main', 'owner/off': 'main' }, 'owner/a');
    let list: AppRepo[] | null = null;
    const lookup = repoLookup(() => list, b);
    expect(lookup('a')).toBeNull();   // Repositories hasn't listed T3's projects yet
    list = [repo('a'), repo('off', { served: false }), repo('reading', { github: null, checking: true })];
    expect(lookup('a')).toEqual({ name: 'a', github: 'owner/a', path: 'C:/code/a', base: 'main', merge: 'me' });
    expect(lookup('off')).toMatchObject({ name: 'off', base: null });   // switched off: still found, its base read now
    await b.load(['owner/off']);
    expect(lookup('off')).toMatchObject({ name: 'off', base: 'main' });
    expect(lookup('reading')).toBeNull();   // its remote is still being read
    expect(lookup('gone')).toBeUndefined();
    expect(runConfig(() => [], dir, lookup).lookup).toBe(lookup);
  });

  test("two T3 projects with one title aren't served, and a job naming it is left undecided, said once (#219 F11)", async () => {
    const b = await bases({ 'owner/one': 'main', 'owner/two': 'main', 'owner/b': 'main' }, 'owner/one', 'owner/two', 'owner/b');
    const said: string[] = [];
    const titles = new SharedTitles((l) => said.push(l));
    const list = [repo('a', { id: 'p1', github: 'owner/one', folder: 'C:/one/a' }), repo('a', { id: 'p2', github: 'owner/two', folder: 'C:/two/a' }), repo('b')];
    expect(servedRepos(list, b, titles)).toEqual([{ name: 'b', github: 'owner/b', path: 'C:/code/b', base: 'main', merge: 'me' }]);
    expect(servedRepos(list, b, titles)).toHaveLength(1);
    expect(said).toEqual(['2 T3 projects are titled "a" (C:/one/a, C:/two/a): none of them is served until all but one are renamed, as the run loop names a repo by its title']);
    expect(repoLookup(() => list, b)('a')).toBeNull();   // neither repo's GitHub is the job's for sure
    const renamed = [list[0]!, { ...list[1]!, title: 'a2' }, list[2]!];
    expect(servedRepos(renamed, b, titles).map((r) => r.github)).toEqual(['owner/one', 'owner/two', 'owner/b']);
    expect(repoLookup(() => renamed, b)('a')).toMatchObject({ github: 'owner/one' });
  });

  test("--once's wait for T3's models ends when T3 refuses the stream, with why (#219 F12)", async () => {
    const ws = { subscribe: () => ({ close: () => {}, done: Promise.reject(new Error('T3 refused the WebSocket')) }) };
    const catalog = T3Catalog.start(ws as any, 60_000);
    try {
      let got: string | null | 'still waiting' = 'still waiting';
      void firstCatalog(catalog).then((why) => { got = why; });
      for (let i = 0; i < 10; i++) await Promise.resolve();   // the refusal and the wait's answer settle
      expect(got).toBe('T3 refused the WebSocket');
      expect(await firstCatalog(catalog)).toBe('T3 refused the WebSocket');   // already failed: at once
    } finally {
      catalog.stop();
    }
  });

  test("the run loop's job log is its own file, and the desktop app's old jobs.jsonl is left unread (#219 F4)", async () => {
    // an old-format log with a build still open, its repo a T3 project id
    const old = join(dir, 'jobs.jsonl');
    const line = { event: 'start', id: 'j1', kind: 'build', repo: 'p-a', github: 'owner/a', issue: 4, branch: 'b', title: 't', at: '2026-11-20T00:00:00Z' };
    await writeFile(old, `${JSON.stringify(line)}\n`);
    const log = jobLog(dir);
    expect(log.path).toBe(join(dir, JOB_LOG));
    expect(JOB_LOG).not.toBe('jobs.jsonl');
    expect(log.jobs()).toEqual([]);
  });
});
