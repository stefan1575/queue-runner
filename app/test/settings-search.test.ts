// Settings' Search (#36's prototype): it finds a setting by another word for it, by its current
// value, and despite a typo.
import { describe, expect, test } from 'vitest';
import type { View } from '../src/desktop/view.ts';
import { DEFAULT_JOBS } from '../src/jobs.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';
import { searchSettings, wantsChoice } from '../src/settings-search.ts';

const catalog = {
  providers: [
    { id: 'p1', label: 'Alpha', models: [{ id: 'm1', label: 'Alpha Big', isDefault: true, effortOption: 'effort', efforts: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }], defaultEffort: 'low' }] },
    { id: 'p2', label: 'Beta', models: [{ id: 'm2', label: 'Beta Quick', isDefault: true, effortOption: 'effort', efforts: [{ id: 'low', label: 'Low' }], defaultEffort: 'low' }] },
  ],
  t3Default: { provider: 'p1', model: 'm1', effort: 'low' },
};
const view: View = {
  settings: { ...DEFAULT_SETTINGS, name: 'Stefan', jobs: { ...DEFAULT_JOBS, review: { own: { provider: 'p2', model: 'm2', effort: 'low' }, fallback: null } } },
  account: { login: 'stefan1575', name: 'Stefan B' },
  timeFormat: '24-hour',
  repos: [
    { id: 'p1', title: 'sandbox', folder: 'C:/Code/sandbox', github: 'ana/sandbox', checking: false, served: true, merge: 'runner', isNew: false },
    { id: 'p2', title: 'notes', folder: 'C:/notes', github: null, checking: false, served: false, merge: 'me', isNew: true },
  ],
  reposError: null, setup: { report: null, checking: false },
  catalog,
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

  test('finds a repository by its name, its GitHub repo, its folder and what it lacks', () => {
    expect(find('sandbox')).toEqual(['repo:p1']);
    expect(find('ana/sandbox')).toEqual(['repo:p1']);
    expect(find('no github remote')).toEqual(['repo:p2']);
    expect(find('new')).toEqual(['repo:p2']);
    expect(find('merges')).toEqual(['repo:p1', 'repo:p2', 'job-conflict']);
    expect(searchSettings(view, now, 'notes').map((s) => s.page)).toEqual(['repos']);
  });

  test('each hit names its page', () => {
    expect(searchSettings(view, now, 'windows').map((s) => s.page)).toEqual(['machine']);
  });

  test('finds a kind of job by its name and by the model it runs on', () => {
    expect(find('review')).toEqual(['job-fix', 'job-review']); // a fix answers a review
    expect(find('beta quick')).toEqual(['job-review']);
    expect(find('alpha big').sort()).toEqual(['job-ask', 'job-build', 'job-conflict', 'job-decision', 'job-default', 'job-fix']);
    expect(find('fallback')).toHaveLength(6);
  });

  test("Models wants a choice while Default follows T3's", () => {
    expect(wantsChoice(view)).toEqual({ models: 1 });
    const chosen = { ...view, settings: { ...view.settings, jobs: { ...view.settings.jobs, default: catalog.t3Default } } };
    expect(wantsChoice(chosen)).toEqual({});
  });
});
