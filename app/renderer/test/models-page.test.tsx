// @vitest-environment jsdom
// The Models page (#152): a new install shows T3's default with a nudge, and choosing or "Keep
// this" pins a value; each kind follows Default until set; with one provider connected, only it
// is offered.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { View } from '../../src/desktop/view.ts';
import { DEFAULT_JOBS, type Jobs } from '../../src/jobs.ts';
import { DEFAULT_SETTINGS, type SettingsPatch } from '../../src/settings.ts';
import { catalogFromConfig } from '../../src/t3/catalog.ts';
import { Settings } from '../src/Settings.tsx';
import fixture from '../../test/fixtures/server-config.json' with { type: 'json' };

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollTo ??= () => {};

const config: any = fixture.config;
const catalog = catalogFromConfig(config);
let root: Root;
let host: HTMLElement;
let saved: SettingsPatch[];

beforeEach(() => {
  saved = [];
  window.runner = { set: async (patch: SettingsPatch) => { saved.push(patch); return {}; } } as unknown as Window['runner'];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
});

const viewWith = (jobs: Jobs, c = catalog): View => ({ settings: { ...DEFAULT_SETTINGS, jobs }, account: null, timeFormat: 'locale', catalog: c, repos: [], reposError: null, usage: [], setup: { report: null, checking: false } });
const show = (view: View) => act(() => root.render(<Settings view={view} open={{ page: 'models', query: '' }} onOpen={() => {}} onClose={() => {}} />));
const button = (label: string) => {
  const b = [...document.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.getAttribute('aria-label')?.startsWith(label) || x.textContent?.startsWith(label));
  if (!b) throw new Error(`no button ${label}`);
  return b;
};
const click = (b: HTMLElement) => act(() => { b.click(); });
/** The options an open menu offers, by label. */
const menu = () => [...document.querySelectorAll('[data-radix-popper-content-wrapper] button')].map((b) => b.textContent);
const choose = (label: string, option: string) => {
  click(button(label));
  const o = [...document.querySelectorAll<HTMLButtonElement>('[data-radix-popper-content-wrapper] button')].find((b) => b.textContent === option);
  if (!o) throw new Error(`${label} offers no ${option}: ${menu().join(', ')}`);
  click(o);
};
const text = () => host.textContent ?? '';

describe('the Models page', () => {
  test("a new install shows T3's default with the nudge, and Keep this pins it", () => {
    show(viewWith(DEFAULT_JOBS));
    expect(text()).toContain("T3's default");
    expect(text()).toContain('Not your choice yet');
    expect(text().match(/Follows Default/g)).toHaveLength(6);
    const d = catalog.t3Default!;
    const p = catalog.providers.find((x) => x.id === d.provider)!;
    expect(button('Default provider').textContent).toBe(p.label);
    click(button('Keep this'));
    expect(saved).toEqual([{ jobs: { ...DEFAULT_JOBS, default: d } }]);
  });

  test('choosing on Default pins it', () => {
    show(viewWith(DEFAULT_JOBS));
    const other = catalog.providers.find((x) => x.id !== catalog.t3Default!.provider)!;
    choose('Default provider', other.label);
    expect(saved).toHaveLength(1);
    expect((saved[0]!.jobs as Jobs).default?.provider).toBe(other.id);
  });

  test('a chosen Default has no nudge', () => {
    show(viewWith({ ...DEFAULT_JOBS, default: catalog.t3Default }));
    expect(text()).not.toContain("T3's default");
    expect(text()).not.toContain('Not your choice yet');
  });

  test('a kind follows Default until set, and can go back to it; a fallback can be added and removed', () => {
    const def = catalog.t3Default!;
    show(viewWith({ ...DEFAULT_JOBS, default: def }));
    const m = catalog.providers[0]!.models.find((x) => x.id !== def.model && x.efforts.length)!;
    choose('Review model', m.label);
    expect((saved.at(-1)!.jobs as Jobs).review.own?.model).toBe(m.id);

    const own = { ...def, model: m.id, effort: m.defaultEffort };
    show(viewWith({ ...DEFAULT_JOBS, default: def, review: { own, fallback: null } }));
    expect(text().match(/Follows Default/g)).toHaveLength(5);
    click(button('Review: follow Default'));
    expect((saved.at(-1)!.jobs as Jobs).review).toEqual({ own: null, fallback: null });

    click(button('Add a fallback'));
    const fb = (saved.at(-1)!.jobs as Jobs).build.fallback!;
    expect(fb.provider).not.toBe(def.provider);
    show(viewWith({ ...DEFAULT_JOBS, default: def, build: { own: null, fallback: fb } }));
    click(button('Build: no fallback'));
    expect((saved.at(-1)!.jobs as Jobs).build).toEqual({ own: null, fallback: null });
  });

  test('with one provider connected, every kind offers only that provider', () => {
    const one = catalogFromConfig({ ...config, providers: config.providers.filter((p: any) => p.instanceId === catalog.providers[1]!.id) });
    show(viewWith(DEFAULT_JOBS, one));
    for (const label of ['Default', 'Build', 'Fix', 'Conflict', 'Decision', 'Review', 'Ask']) {
      click(button(`${label} provider`));
      expect(menu()).toEqual([one.providers[0]!.label]);
      act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    }
  });

  test("T3 not answering yet, or with nothing connected, says so", () => {
    show({ ...viewWith(DEFAULT_JOBS), catalog: null });
    expect(text()).toContain('Asking T3 Code for its models');
    show(viewWith(DEFAULT_JOBS, { providers: [], t3Default: null }));
    expect(text()).toContain('T3 Code has no provider connected');
  });
});
