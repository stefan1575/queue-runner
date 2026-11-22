// A served repo read from its own git folder (`src/repo-folder.ts`, #219; Stefan's decision on
// #261): its `owner/name` from its origin remote and its base from `origin/HEAD`, on a fake git.
import { describe, expect, test } from 'vitest';
import { githubName, readFolder } from '../src/repo-folder.ts';

/** A fake git in one folder: its origin's URL (null: no origin), whether `origin/HEAD` is set, and
 *  what `remote set-head origin --auto` does (sets it, or fails); every call kept. */
function fakeGit(origin: string | null, head: string | null, setHead: string | Error | null = null) {
  const ran: string[] = [];
  let ref = head;
  const run = async (args: string[]): Promise<[number, string, string]> => {
    const cmd = args.slice(2).join(' ');
    ran.push(cmd);
    if (cmd === 'remote get-url origin') return origin === null ? [2, '', "error: No such remote 'origin'\n"] : [0, `${origin}\n`, ''];
    if (cmd.startsWith('symbolic-ref')) return ref === null ? [1, '', ''] : [0, `origin/${ref}\n`, ''];
    if (cmd === 'remote set-head origin --auto') {
      if (setHead instanceof Error) return [128, '', `fatal: ${setHead.message}\n`];
      ref = setHead;
      return [0, `origin/HEAD set to ${setHead}\n`, ''];
    }
    throw new Error(`unexpected git ${cmd}`);
  };
  return { run, ran };
}

const there = () => true;

describe('githubName', () => {
  test.each([
    ['https://github.com/owner/repo.git', 'owner/repo'],
    ['https://github.com/owner/repo', 'owner/repo'],
    ['https://user@github.com/owner/repo/', 'owner/repo'],
    ['git@github.com:owner/repo.git', 'owner/repo'],
    ['ssh://git@github.com/owner/repo.git', 'owner/repo'],
    ['https://gitlab.com/owner/repo.git', null],
    ['C:/code/elsewhere', null],
  ])('%s', (url, name) => {
    expect(githubName(url)).toBe(name);
  });
});

describe('readFolder', () => {
  test('its owner/name from origin and its base from origin/HEAD, two local git calls and nothing else', async () => {
    const git = fakeGit('https://github.com/owner/a.git', 'trunk');
    expect(await readFolder('C:/a', git.run, there)).toEqual({ github: 'owner/a', base: 'trunk' });
    expect(git.ran).toEqual(['remote get-url origin', 'symbolic-ref --quiet --short refs/remotes/origin/HEAD']);
  });

  test('a missing origin/HEAD is set once, then read; the next read finds it set', async () => {
    const git = fakeGit('git@github.com:owner/a.git', null, 'main');
    expect(await readFolder('C:/a', git.run, there)).toEqual({ github: 'owner/a', base: 'main' });
    expect(await readFolder('C:/a', git.run, there)).toEqual({ github: 'owner/a', base: 'main' });
    expect(git.ran.filter((c) => c.startsWith('remote set-head'))).toEqual(['remote set-head origin --auto']);
  });

  test("an origin/HEAD git can't set is why, with the name it read", async () => {
    const git = fakeGit('https://github.com/owner/a', null, new Error('unable to connect'));
    expect(await readFolder('C:/a', git.run, there)).toEqual({
      github: 'owner/a', reason: "its origin/HEAD is missing and git couldn't set it (fatal: unable to connect)",
    });
  });

  test('a missing folder, no origin, an origin off GitHub, a git that will not start: each says why', async () => {
    expect(await readFolder('C:/gone', fakeGit(null, null).run, () => false)).toEqual({ github: null, reason: 'its folder C:/gone is missing' });
    expect(await readFolder('C:/a', fakeGit(null, null).run, there)).toEqual({
      github: null, reason: "git can't read its origin remote (error: No such remote 'origin')",
    });
    expect(await readFolder('C:/a', fakeGit('https://gitlab.com/o/r.git', 'main').run, there)).toEqual({
      github: null, reason: "its origin remote isn't on GitHub",
    });
    // a credentialed remote off GitHub: its user and token are never said (review 1 of #262, F5)
    const token = 'ghp_SYNTHETIC0123456789token';
    const secret = await readFolder('C:/a', fakeGit(`https://someone:${token}@git.example.com/o/r.git`, 'main').run, there);
    expect(secret).toEqual({ github: null, reason: "its origin remote isn't on GitHub" });
    expect(JSON.stringify(secret)).not.toMatch(/someone|SYNTHETIC|example/);
    // nor in git's own error that names the URL
    const unset = fakeGit(`https://someone:${token}@github.com/owner/a`, null, new Error(`unable to access 'https://someone:${token}@github.com/owner/a/': 403`));
    const said = await readFolder('C:/a', unset.run, there);
    expect(said).toEqual({ github: 'owner/a', reason: "its origin/HEAD is missing and git couldn't set it (fatal: unable to access 'https://github.com/owner/a/': 403)" });
    const broken = async (): Promise<[number, string, string]> => { throw new Error('spawn git ENOENT'); };
    expect(await readFolder('C:/a', broken, there)).toEqual({ github: null, reason: "git couldn't run (spawn git ENOENT)" });
  });
});
