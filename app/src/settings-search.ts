// Settings' pages and its Search, from #36's prototype (variant B): a setting is found by other
// words for it, by its current value (a name, a date as the style writes it), and despite one
// typo. Every word of the search must match. Shared with the renderer, so nothing here touches
// Node.
import type { View } from './desktop/view.ts';
import { DATE_STYLES, formatDate, TIME_FORMATS } from './display.ts';

export type PageId = 'name' | 'display' | 'machine';
export const PAGES: { id: PageId; label: string }[] = [
  { id: 'name', label: 'Name' },
  { id: 'display', label: 'Display' },
  { id: 'machine', label: 'Machine' },
];

export type SettingId = 'name' | 'date' | 'clock' | 'startup';
export type SettingEntry = { id: SettingId; page: PageId; words: string };

/** Each setting with the words Search finds it by: what it's called, other words for it, and
 *  what it's set to now. */
export function settingEntries(view: View, now: Date): SettingEntry[] {
  const { settings: s, account, timeFormat: tf } = view;
  const dates = DATE_STYLES.map((d) => `${formatDate(now, d.id, tf)} ${formatDate(now, d.id, tf, true)} ${d.label}`).join(' ');
  return [
    { id: 'name', page: 'name', words: `your name you me call called briefs github account user who ${s.name ?? ''} ${account?.name ?? ''} ${account?.login ?? ''}` },
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
