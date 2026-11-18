// @vitest-environment jsdom
// Settings / Repositories (#151): a repo with no GitHub remote can't be switched on and says why;
// removing asks first, and asks again before a project's threads go with it; New marks count on
// the page and are looked at once the page goes away.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { RepoAction, RepoResult, View } from '../../src/desktop/view.ts';
import type { Repo } from '../../src/repos.ts';
import { DEFAULT_SETTINGS } from '../../src/settings.ts';
import { Settings } from '../src/Settings.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollTo ??= () => {};

const served: Repo = { id: 'p1', title: 'sandbox', folder: 'C:/sandbox', github: 'ana/sandbox', checking: false, served: true, merge: 'runner', isNew: false };
const fresh: Repo = { id: 'p2', title: 'blog', folder: 'C:/blog', github: 'ana/blog', checking: false, served: false, merge: 'me', isNew: true };
const bare: Repo = { id: 'p3', title: 'notes', folder: 'C:/notes', github: null, checking: false, served: false, merge: 'me', isNew: false };
const view: View = {
  settings: { ...DEFAULT_SETTINGS }, account: { login: 'ana-gh', name: 'Ana GH' }, timeFormat: 'locale',
  repos: [served, fresh, bare], reposError: null,
};

let root: Root;
let host: HTMLElement;
let asked: RepoAction[];
let answer: (a: RepoAction) => RepoResult;

beforeEach(() => {
  asked = [];
  answer = () => ({});
  window.runner = {
    view: async () => view,
    set: async () => view,
    repo: async (a: RepoAction) => { asked.push(a); return answer(a); },
    onView: () => () => {},
  } as unknown as Window['runner'];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const open = () => act(() => root.render(<Settings view={view} open={{ page: 'repos', query: '' }} onOpen={() => {}} onClose={() => {}} />));
const button = (label: string) => document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const byText = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text)!;
const click = async (el: HTMLElement) => { await act(async () => { el.click(); }); };

describe('the Repositories page', () => {
  test("a repo with no GitHub remote says so and its switch can't be turned on", () => {
    open();
    expect(host.textContent).toContain('No GitHub remote');
    expect(host.textContent).toContain("can't be served until it has a GitHub remote");
    expect(button('Serve notes').disabled).toBe(true);
    expect(button('Serve blog').disabled).toBe(false);
  });

  test('switching one on asks the runner', async () => {
    open();
    await click(button('Serve blog'));
    expect(asked).toEqual([{ do: 'serve', id: 'p2', on: true }]);
  });

  test("who merges can't be chosen for a repo that isn't served", () => {
    open();
    expect(button('Who merges blog: I merge').disabled).toBe(true);
    expect(button('Who merges sandbox: Runner merges').disabled).toBe(false);
  });

  test('removing asks first, then removes', async () => {
    open();
    await click(button('Remove sandbox'));
    expect(asked).toEqual([]);
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('C:/sandbox and everything on GitHub (ana/sandbox) stay as they are');
    await click(byText('Remove'));
    expect(asked).toEqual([{ do: 'remove', id: 'p1', withThreads: false }]);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  test("a project with threads is asked about again before they go too", async () => {
    answer = (a) => (a.do === 'remove' && !a.withThreads ? { error: 'sandbox still has threads in T3. Removing it deletes them too.', notEmpty: true } : {});
    open();
    await click(button('Remove sandbox'));
    await click(byText('Remove'));
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('still has threads in T3');
    await click(byText('Remove with its threads'));
    expect(asked).toEqual([{ do: 'remove', id: 'p1', withThreads: false }, { do: 'remove', id: 'p1', withThreads: true }]);
  });

  test('a New repo is marked and counted, and looked at once the page goes away', () => {
    open();
    expect(host.textContent).toContain('New from T3');
    expect(document.querySelector('[title="1 new from T3"]')).not.toBeNull();
    act(() => root.render(<></>));
    expect(asked).toEqual([{ do: 'seen', ids: ['p2'] }]);
  });

  test('adding opens the folder picker through the runner', async () => {
    answer = () => ({ added: 'C:/new' });
    open();
    await click(byText('Add folder'));
    expect(asked).toEqual([{ do: 'add' }]);
  });
});
