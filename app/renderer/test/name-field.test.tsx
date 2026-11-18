// @vitest-environment jsdom
// The Name field keeps what was typed however Settings closes (PR #174, F1): leaving the field,
// Enter, or Settings going away with the field still focused (a click on the dimmed backdrop
// unmounts it on mouse-down, before any blur).
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { View } from '../../src/desktop/view.ts';
import { DEFAULT_SETTINGS, type SettingsPatch } from '../../src/settings.ts';
import { NameField } from '../src/controls.tsx';
import { Settings } from '../src/Settings.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom lays nothing out, so it has no scrolling; Settings scrolls its pane to the top.
Element.prototype.scrollTo ??= () => {};

let root: Root;
let host: HTMLElement;
let saved: SettingsPatch[];
const view: View = { settings: { ...DEFAULT_SETTINGS }, account: { login: 'ana-gh', name: 'Ana GH' }, timeFormat: 'locale', catalog: null, repos: [], reposError: null, usage: [] };

beforeEach(() => {
  saved = [];
  window.runner = {
    view: async () => view,
    set: async (patch: SettingsPatch) => { saved.push(patch); return view; },
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

/** Types into the field as a person would: React hears the native input event. */
function type(input: HTMLInputElement, text: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setValue.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const nameInput = () => host.querySelector<HTMLInputElement>('input[aria-label="Your name"]')!;

function SettingsOpen() {
  const [open, setOpen] = useState(true);
  return open ? <Settings view={view} open={{ page: 'name', query: '' }} onOpen={() => {}} onClose={() => setOpen(false)} /> : null;
}

describe('the Name field', () => {
  test('a click on the backdrop with the field still focused saves what was typed', () => {
    act(() => root.render(<SettingsOpen />));
    const input = nameInput();
    act(() => input.focus());
    type(input, 'Ana');
    const backdrop = host.querySelector<HTMLElement>('[role="dialog"]')!.parentElement!;
    act(() => { backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(saved).toEqual([{ name: 'Ana' }]);
  });

  test('the field going away for any reason saves what was typed', () => {
    act(() => root.render(<NameField value={null} fallback="Ana GH" onSave={(name) => saved.push({ name })} />));
    type(nameInput(), 'Bo');
    act(() => root.render(<></>));
    expect(saved).toEqual([{ name: 'Bo' }]);
  });

  test('leaving the field saves once, and its going away later saves nothing more', () => {
    act(() => root.render(<NameField value={null} fallback="Ana GH" onSave={(name) => saved.push({ name })} />));
    const input = nameInput();
    act(() => input.focus());
    type(input, 'Bo');
    act(() => input.blur());
    act(() => root.render(<></>));
    expect(saved).toEqual([{ name: 'Bo' }]);
  });

  test('Escape puts back what was saved, and nothing is saved when the field goes away', () => {
    act(() => root.render(<NameField value="Ana" fallback="Ana GH" onSave={(name) => saved.push({ name })} />));
    const input = nameInput();
    type(input, 'Bo');
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(input.value).toBe('Ana');
    act(() => root.render(<></>));
    expect(saved).toEqual([]);
  });

  test('a field left untouched saves nothing when it goes away', () => {
    act(() => root.render(<NameField value={null} fallback="Ana GH" onSave={(name) => saved.push({ name })} />));
    act(() => root.render(<></>));
    expect(saved).toEqual([]);
  });
});
