// @vitest-environment jsdom
// The Your share page (#153): one row per provider per weekly window from T3's usage, 0% kept
// until 24 hours before the reset by default; a change saves when the field is left; a provider
// T3 reads no usage for shows greyed, "Coming soon", with nothing to change.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { View } from '../../src/desktop/view.ts';
import { DEFAULT_SETTINGS, type SettingsPatch } from '../../src/settings.ts';
import { catalogFromConfig } from '../../src/t3/catalog.ts';
import { usageFromProviders } from '../../src/usage.ts';
import { Settings } from '../src/Settings.tsx';
import fixture from '../../test/fixtures/server-config.json' with { type: 'json' };

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollTo ??= () => {};

const config: any = fixture.config;
const unread = { instanceId: 'other', driver: 'other', displayName: 'Other', status: 'ready', enabled: true, models: [] };
const usage = usageFromProviders([...config.providers, unread]);
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

const view = (shares = {}, u = usage): View => ({
  settings: { ...DEFAULT_SETTINGS, shares }, account: null, timeFormat: '24-hour', catalog: catalogFromConfig(config), usage: u,
});
const show = (v: View) => act(() => root.render(<Settings view={v} open={{ page: 'share', query: '' }} onOpen={() => {}} onClose={() => {}} />));
const field = (label: string) => {
  const f = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!f) throw new Error(`no field ${label}`);
  return f;
};
const type = (f: HTMLInputElement, text: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(f, text);
  f.dispatchEvent(new Event('input', { bubbles: true }));
});
const blur = (f: HTMLInputElement) => act(() => { f.focus(); f.blur(); });

describe('Your share', () => {
  test("one row per provider per weekly window, keeping nothing by default", () => {
    show(view());
    const text = host.textContent!;
    for (const t of ["Codex's week", "Claude's week", "Claude's Fable week", "Other's week"]) expect(text).toContain(t);
    expect(field("Percent of Claude's week kept").value).toBe('0');
    expect(field("Hours before Claude's week resets").value).toBe('24');
    expect(text).toContain('Nothing is kept: the runner may use all of it.');
  });

  test('a percent kept saves when the field is left, and the row says when the rest is released', () => {
    show(view());
    const f = field("Percent of Claude's week kept");
    type(f, '5');
    expect(saved).toEqual([]);
    blur(f);
    expect(saved).toEqual([{ shares: { 'claudeAgent/seven_day': { percent: 5, releaseHours: 24 } } }]);
    show(view({ 'claudeAgent/seven_day': { percent: 5, releaseHours: 24 } }));
    // the week resets Nov 23 11:00 UTC; 24 hours before is Nov 22, as the date style writes it locally
    expect(host.textContent).toMatch(/The runner stops at 95% used, then may use the rest from Nov 22/);
  });

  test('a value out of range is brought into it, and one that is no number is put back', () => {
    show(view());
    const hours = field("Hours before Codex's week resets");
    type(hours, '500');
    blur(hours);
    expect(saved).toEqual([{ shares: { 'codex/secondary': { percent: 0, releaseHours: 168 } } }]);
    const pct = field("Percent of Codex's week kept");
    type(pct, 'lots');
    blur(pct);
    expect(pct.value).toBe('0');
    expect(saved).toHaveLength(1);
  });

  test("a provider T3 reads no usage for shows greyed, Coming soon, with nothing to change", () => {
    show(view());
    expect(host.textContent).toContain('Coming soon');
    expect(field("Percent of Other's week kept").disabled).toBe(true);
    expect(field("Percent of Claude's week kept").disabled).toBe(false);
  });

  test('before T3 answers, the page says so', () => {
    show({ ...view(), catalog: null, usage: [] });
    expect(host.textContent).toContain('Asking T3 Code for its usage');
  });
});
