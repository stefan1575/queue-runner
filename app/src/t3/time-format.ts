// T3's Time format (`timestampFormat`), which the window's clock follows (#68 story 36, #36).
// It is a setting of T3's own window, kept in `~/.t3/userdata/client-settings.json`; T3's server
// doesn't serve it. So this is the one exception to "No reads of T3's database or settings"
// (docs/app.md, Rules; Stefan on #150): it reads that one key, never writes the file, and watches
// it. It goes once T3's server serves client settings.
import { unwatchFile, watchFile, type Stats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { TimeFormatSource } from '../desktop/view.ts';
import type { TimeFormat } from '../display.ts';
import { T3_HOME } from './real.ts';

export const CLIENT_SETTINGS = join(T3_HOME, 'userdata', 'client-settings.json');

const FORMATS: TimeFormat[] = ['locale', '12-hour', '24-hour'];
/** How often the file is looked at: a stat, not a read, until it changes. */
const POLL_MS = 500;
/** How long a file that isn't JSON is given to become JSON before it counts as unreadable: a
 *  write caught midway ends well inside it, a file left broken outlasts it. */
const SETTLE_MS = 2000;

/** The Time format in T3's client settings; System default (T3's own default) when the file is
 *  missing or unreadable, or holds no such key or a value T3 doesn't offer. */
export async function readTimeFormat(file: string = CLIENT_SETTINGS): Promise<TimeFormat> {
  return (await read(file)) ?? 'locale';
}

/** As readTimeFormat, but undefined for a file that's there and isn't JSON: most often one caught
 *  mid-write (emptied, not yet filled). */
async function read(file: string): Promise<TimeFormat | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return 'locale';
  }
  let value: unknown;
  try {
    value = JSON.parse(text)?.timestampFormat;
  } catch {
    return undefined;
  }
  return FORMATS.includes(value as TimeFormat) ? (value as TimeFormat) : 'locale';
}

/** What the file is right now, as a poll tells one state from the next. */
async function stateOf(file: string): Promise<string> {
  try {
    const s = await stat(file);
    return `${s.ino}:${s.size}:${s.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

/** Calls `changed` whenever the file looks different, until the returned function is called. */
export type Watch = (file: string, changed: () => void) => () => void;

// Polled rather than fs.watch: it sees a file that's missing (or whose folder is) and comes
// later, and a file replaced by a rename, with no watcher to re-arm.
const pollFile: Watch = (file, changed) => {
  const onStat = (now: Stats, before: Stats) => {
    if (now.mtimeMs === before.mtimeMs && now.size === before.size && now.ino === before.ino) return;
    changed();
  };
  watchFile(file, { interval: POLL_MS, persistent: false }, onStat);
  return () => unwatchFile(file, onStat);
};

export interface WatchOptions {
  /** How the file's changes are noticed: polled by default. */
  watch?: Watch;
  settleMs?: number;
}

export class T3TimeFormat implements TimeFormatSource {
  private format: TimeFormat;
  private file: string;
  private settleMs: number;
  private listeners = new Set<(f: TimeFormat) => void>();
  private unwatch: () => void;
  /** Reads run one after another, so a slow one never lands after a newer one. */
  private reading: Promise<void> = Promise.resolve();
  /** The second look at a file that wasn't JSON, while one is pending. */
  private settle: ReturnType<typeof setTimeout> | undefined;

  private constructor(file: string, format: TimeFormat, options: WatchOptions) {
    this.file = file;
    this.format = format;
    this.settleMs = options.settleMs ?? SETTLE_MS;
    this.unwatch = (options.watch ?? pollFile)(file, () => {
      this.reading = this.reading.then(() => this.reread());
    });
  }

  static async start(file: string = CLIENT_SETTINGS, options: WatchOptions = {}): Promise<T3TimeFormat> {
    return new T3TimeFormat(file, await readTimeFormat(file), options);
  }

  current(): TimeFormat {
    return this.format;
  }

  onChange(listener: (f: TimeFormat) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.unwatch();
    clearTimeout(this.settle);
    this.settle = undefined;
    this.listeners.clear();
  }

  /** `settledState`: the file's state when a look was asked for, SETTLE_MS ago. Only that same
   *  state, still not JSON, counts as unreadable: a file that has changed since is a new write,
   *  caught midway as likely as the last one was. */
  private async reread(settledState?: string) {
    // A file that isn't JSON is most often T3 caught mid-write: it keeps the format it had, and
    // is looked at again once SETTLE_MS has passed. Still the same file and still not JSON then,
    // it is unreadable, so System default (as readTimeFormat).
    const state = await stateOf(this.file);
    let format = await read(this.file);
    if (format === undefined) {
      if (state !== settledState) {
        this.lookAgain(state);
        return;
      }
      format = 'locale';
    }
    // Read whole (or gone): no look an earlier half-write asked for still stands.
    clearTimeout(this.settle);
    this.settle = undefined;
    if (format === this.format) return;
    this.format = format;
    for (const l of this.listeners) l(format);
  }

  private lookAgain(state: string) {
    clearTimeout(this.settle);
    this.settle = setTimeout(() => {
      this.settle = undefined;
      this.reading = this.reading.then(() => this.reread(state));
    }, this.settleMs);
    this.settle.unref?.();
  }
}
