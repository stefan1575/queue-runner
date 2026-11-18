// Settings' Search (#36's prototype): it finds a setting by another word for it, by its current
// value, and despite a typo.
import { describe, expect, test } from 'vitest';
import type { View } from '../src/desktop/view.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';
import { searchSettings } from '../src/settings-search.ts';

const view: View = {
  settings: { ...DEFAULT_SETTINGS, name: 'Stefan' },
  account: { login: 'stefan1575', name: 'Stefan B' },
  timeFormat: '24-hour',
};
const now = new Date(2026, 10, 16, 15, 5);
const find = (q: string) => searchSettings(view, now, q).map((s) => s.id);

describe('Search', () => {
  test('finds a setting by its own name', () => {
    expect(find('start with windows')).toEqual(['startup']);
    expect(find('date style')).toEqual(['date']);
  });

  test('finds a setting by another word for it', () => {
    expect(find('autostart')).toEqual(['startup']);
    expect(find('logon')).toEqual(['startup']);
    expect(find('briefs')).toEqual(['name']);
    expect(find('24')).toEqual(['clock']);
  });

  test('finds a setting by its value', () => {
    expect(find('stefan1575')).toEqual(['name']); // the gh account
    expect(find('nov 16')).toEqual(['date']); // a date as the style writes it
    expect(find('15:05')).toEqual(['date']);
  });

  test('forgives a typo', () => {
    expect(find('windos')).toEqual(['startup']);
    expect(find('calender')).toEqual(['date']);
  });

  test('every word must match, and an empty search finds nothing', () => {
    expect(find('windows banana')).toEqual([]);
    expect(find('  ')).toEqual([]);
  });

  test('each hit names its page', () => {
    expect(searchSettings(view, now, 'windows').map((s) => s.page)).toEqual(['machine']);
  });
});
