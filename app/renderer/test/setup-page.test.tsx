// @vitest-environment jsdom
// The Setup page (#162): each check passed, or what's missing and how to fix it; Check again asks
// the main process to run them again; it opens by itself on the first start only, and later
// from the sidebar's Setup button, which is marked while something's missing.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { View } from '../../src/desktop/view.ts';
import { DEFAULT_SETTINGS, type SettingsPatch } from '../../src/settings.ts';
import type { SetupReport, SetupState } from '../../src/setup.ts';
import { App } from '../src/App.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollTo ??= () => {};

const passing: SetupReport = {
  ok: true, at: new Date(2026, 10, 19, 9, 41).toISOString(),
  checks: [
    { id: 't3', label: 'T3 Code', state: 'ok', summary: 'T3 Code 0.1.9 is running on Fake, and the runner is signed in.' },
    { id: 'providers', label: 'Providers', state: 'ok', summary: '2 connected in T3 Code.', items: ['Alpha', 'Beta'] },
    { id: 'github', label: 'GitHub', state: 'ok', summary: 'gh is signed in to github.com as ana-k. T3 Code uses the same sign-in.' },
    { id: 'resume', label: 'Resume after usage limits', state: 'ok', summary: 'Off in T3 Code, so only the runner resumes its threads.' },
  ],
};
const failing: SetupReport = {
  ok: false, at: new Date(2026, 10, 19, 9, 42).toISOString(),
  checks: [
    { id: 't3', label: 'T3 Code', state: 'bad', summary: "T3 Code isn't running.", fix: 'Open T3 Code, then check again.', detail: "T3's server isn't running (server-runtime.json: Error)" },
    { id: 'providers', label: 'Providers', state: 'waiting', summary: 'Checked once T3 Code answers.' },
    { id: 'github', label: 'GitHub', state: 'bad', summary: "gh isn't signed in to GitHub.", fix: 'Run `gh auth login` in a terminal, then check again.' },
    { id: 'resume', label: 'Resume after usage limits', state: 'waiting', summary: 'Checked once T3 Code answers.' },
  ],
};

let root: Root;
let host: HTMLElement;
let saved: SettingsPatch[];
let checks: number;
let current: View;
let push: (v: View) => void;

const viewWith = (setup: SetupState, setupSeen = true): View => ({
  settings: { ...DEFAULT_SETTINGS, setupSeen }, account: null, timeFormat: '24-hour', catalog: null, repos: [], reposError: null, usage: [], setup,
});

beforeEach(() => {
  saved = [];
  checks = 0;
  location.hash = '';
  window.runner = {
    view: async () => current,
    onView: (l: (v: View) => void) => { push = l; return () => {}; },
    set: async (patch: SettingsPatch) => { saved.push(patch); return current; },
    checkSetup: async () => { checks++; return current; },
  } as unknown as Window['runner'];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
});

async function start(view: View) {
  current = view;
  await act(async () => root.render(<App />));
}
const dialog = () => document.querySelector('[role="dialog"][aria-label="Setup"]');
const text = () => dialog()?.textContent ?? '';
const button = (label: string) => {
  const b = [...document.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.getAttribute('aria-label') === label || x.textContent?.trim() === label);
  if (!b) throw new Error(`no button ${label}`);
  return b;
};

describe('the Setup page', () => {
  test('opens by itself on the first start, saying it has been seen; each check passed', async () => {
    await start(viewWith({ report: passing, checking: false }, false));
    expect(dialog()).not.toBeNull();
    expect(saved).toEqual([{ setupSeen: true }]);
    expect(text()).toContain('Everything the runner needs is in place.');
    expect(document.querySelectorAll('[data-check-state="ok"]')).toHaveLength(4);
    expect(text()).toContain('Alpha');
    expect(text()).toContain('Beta');
    expect(text()).toContain('Checked 09:41');
    expect(text()).not.toContain('How to fix');
  });

  test('a later start leaves it shut; the sidebar opens it, marked while something is missing', async () => {
    await start(viewWith({ report: failing, checking: false }));
    expect(dialog()).toBeNull();
    expect(saved).toEqual([]);
    expect(button('Setup: 2 to fix').querySelector('[data-mark]')).not.toBeNull();
    await act(async () => { button('Setup: 2 to fix').click(); });
    expect(dialog()).not.toBeNull();
  });

  test('names each problem and how to fix it', async () => {
    await start(viewWith({ report: failing, checking: false }, false));
    expect(text()).toContain('2 things to fix');
    expect(text()).toContain("T3 Code isn't running.");
    expect(text()).toContain('Open T3 Code, then check again.');
    expect(text()).toContain("T3's server isn't running (server-runtime.json: Error)");
    expect(text()).toContain("gh isn't signed in to GitHub.");
    expect(dialog()!.querySelector('code')?.textContent).toBe('gh auth login');
    expect(document.querySelectorAll('[data-check-state="bad"]')).toHaveLength(2);
    expect(document.querySelectorAll('[data-check-state="waiting"]')).toHaveLength(2);
  });

  test('Check again asks the main process, and shows the new report with no restart', async () => {
    await start(viewWith({ report: failing, checking: false }, false));
    await act(async () => { button('Check again').click(); });
    expect(checks).toBe(1);
    await act(async () => push(viewWith({ report: failing, checking: true })));
    expect(button('Checking…').disabled).toBe(true);
    await act(async () => push(viewWith({ report: passing, checking: false })));
    expect(text()).toContain('Everything the runner needs is in place.');
  });

  test("a check that couldn't run says why", async () => {
    await start(viewWith({ report: null, checking: false, error: 'boom' }, false));
    expect(text()).toContain("The checks couldn't run: boom");
  });

  test('closes with its X and Escape', async () => {
    await start(viewWith({ report: passing, checking: false }, false));
    await act(async () => { button('Close setup').click(); });
    expect(dialog()).toBeNull();
    await act(async () => { button('Setup').click(); });
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(dialog()).toBeNull();
  });
});
