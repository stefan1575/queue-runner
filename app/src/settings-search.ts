// Settings' pages and its Search, from #36's prototype (variant B): a setting is found by other
// words for it, by its current value (a name, a date as the style writes it), and despite one
// typo. Every word of the search must match. Shared with the renderer, so nothing here touches
// Node.
import type { View } from './desktop/view.ts';
import { DATE_STYLES, formatDate, TIME_FORMATS } from './display.ts';
import { releaseAt, shareRows } from './shares.ts';
import { defaultModel, JOB_KINDS, kindModels, model, provider, type Catalog, type JobKind, type ModelChoice } from './jobs.ts';

export type PageId = 'name' | 'repos' | 'models' | 'share' | 'display' | 'machine';
export const PAGES: { id: PageId; label: string }[] = [
  { id: 'name', label: 'Name' },
  { id: 'repos', label: 'Repositories' },
  { id: 'models', label: 'Models' },
  { id: 'share', label: 'Your share' },
  { id: 'display', label: 'Display' },
  { id: 'machine', label: 'Machine' },
];

/** A repository's row is `repo:<T3 project id>`. */
export type SettingId = 'name' | `repo:${string}` | 'job-default' | `job-${JobKind}` | `share-${string}` | 'date' | 'clock' | 'startup';
export type SettingEntry = { id: SettingId; page: PageId; words: string };

const MODEL_WORDS = 'model models provider effort reasoning thinking agent ai job jobs';
/** A choice's words: its provider's, model's and effort's names as T3 gives them. */
function choiceWords(c: ModelChoice | null, catalog: Catalog | null): string {
  if (!c || !catalog) return '';
  const m = model(catalog, c);
  return `${provider(catalog, c.provider)?.label ?? c.provider} ${m?.label ?? c.model} ${m?.efforts.find((e) => e.id === c.effort)?.label ?? c.effort ?? ''}`;
}

/** The settings that want a choice, per page: Default left on T3's own (#36's blue counts). */
export function wantsChoice(view: View): Partial<Record<PageId, number>> {
  const c = view.catalog;
  return c && c.providers.length && defaultModel(view.settings.jobs, c).followsT3 ? { models: 1 } : {};
}

/** Each setting with the words Search finds it by: what it's called, other words for it, and
 *  what it's set to now. */
export function settingEntries(view: View, now: Date): SettingEntry[] {
  const { settings: s, account, timeFormat: tf } = view;
  const repos = (view.repos ?? []).map((r): SettingEntry => ({
    id: `repo:${r.id}`, page: 'repos',
    words: `${r.title} ${r.github ?? 'no github remote warning cannot'} ${r.folder} repository repositories repo project folder served serve on off merge merges who github t3 ${r.isNew ? 'new' : ''}`,
  }));
  const dates = DATE_STYLES.map((d) => `${formatDate(now, d.id, tf)} ${formatDate(now, d.id, tf, true)} ${d.label}`).join(' ');
  return [
    { id: 'name', page: 'name', words: `your name you me call called briefs github account user who ${s.name ?? ''} ${account?.name ?? ''} ${account?.login ?? ''}` },
    ...repos,
    { id: 'job-default', page: 'models', words: `default every all ${MODEL_WORDS} t3 ${view.catalog ? choiceWords(defaultModel(s.jobs, view.catalog).choice, view.catalog) : ''}` },
    ...JOB_KINDS.map((k) => {
      const m = view.catalog ? kindModels(s.jobs, k.id, view.catalog) : null;
      return {
        id: `job-${k.id}` as SettingId, page: 'models' as PageId,
        words: `${k.label} ${k.does} ${MODEL_WORDS} fallback usage ${m ? `${choiceWords(m.choice, view.catalog)} ${choiceWords(m.fallback, view.catalog)}` : ''}`,
      };
    }),
    ...shareRows(view.usage, s.shares).map((r): SettingEntry => {
      const at = (d: Date | null) => (d ? `${formatDate(d, s.dateStyle, tf)} ${formatDate(d, s.dateStyle, tf, true)}` : '');
      return {
        id: `share-${r.key}`, page: 'share',
        words: `${r.title} share percent % ${r.share.percent}% keep kept reserve hold back budget usage limit quota week weekly window plan subscription reset resets release released hours ${at(r.resetsAt ? new Date(r.resetsAt) : null)} ${at(releaseAt(r.share, r.resetsAt))} ${r.enforced ? '' : 'coming soon later'}`,
      };
    }),
    { id: 'date', page: 'display', words: `date dates style format day month year weekday calendar today display ${dates}` },
    { id: 'clock', page: 'display', words: `clock time format 12 24 hour am pm t3 timestamp ${TIME_FORMATS.find((f) => f.id === tf)?.label ?? ''}` },
    { id: 'startup', page: 'machine', words: 'start with windows startup boot login logon sign in tray autostart launch open' },
  ];
}

const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9%:]+/).filter(Boolean);

/** Whether `a` is within `max` edits of `b`. */
function near(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]! <= max;
}

// A word matches when it starts with the search word, holds it (3 letters or more), or, from 5
// letters, starts with the same letter and is one typo off (two from 8 letters), whole or as a start.
const wordHit = (w: string, t: string) =>
  w.startsWith(t) || (t.length >= 3 && w.includes(t)) ||
  (t.length >= 5 && w[0] === t[0] && (near(w, t, t.length >= 8 ? 2 : 1) || near(w.slice(0, t.length), t, 1)));

export function matches(words: string, query: string): boolean {
  const ws = tokens(words);
  const ts = tokens(query);
  return ts.length > 0 && ts.every((t) => ws.some((w) => wordHit(w, t)));
}

/** The settings a search finds, in page order. */
export function searchSettings(view: View, now: Date, query: string): SettingEntry[] {
  return settingEntries(view, now).filter((e) => matches(e.words, query));
}
