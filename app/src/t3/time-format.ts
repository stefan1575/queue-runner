// T3's Time format (`timestampFormat`), which the window's clock follows (#68 story 36, #36).
// It is a setting of T3's own window, kept in `~/.t3/userdata/client-settings.json`; T3's server
// doesn't serve it. So this is the one exception to "No reads of T3's database or settings"
// (docs/app.md, Rules; Stefan on #150): it reads that one key, never writes the file, and watches
// it. It goes once T3's server serves client settings.
import { unwatchFile, watchFile, type Stats } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TimeFormatSource } from '../desktop/view.ts';
import type { TimeFormat } from '../display.ts';
import { T3_HOME } from './real.ts';

export const CLIENT_SETTINGS = join(T3_HOME, 'userdata', 'client-settings.json');

const FORMATS: TimeFormat[] = ['locale', '12-hour', '24-hour'];
/** How often the file is looked at: a stat, not a read, until it changes. */
const POLL_MS = 500;

/** The Time format in T3's client settings; System default (T3's own default) when the file is
 *  missing or unreadable, or holds no such key or a value T3 doesn't offer. */
export async function readTimeFormat(file: string = CLIENT_SETTINGS): Promise<TimeFormat> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'))?.timestampFormat;
    return FORMATS.includes(value) ? value : 'locale';
  } catch {
    return 'locale';
  }
}

export class T3TimeFormat implements TimeFormatSource {
  private format: TimeFormat;
  private file: string;
  private listeners = new Set<(f: TimeFormat) => void>();
  private onStat: (now: Stats, before: Stats) => void;
  /** Reads run one after another, so a slow one never lands after a newer one. */
  private reading: Promise<void> = Promise.resolve();

  private constructor(file: string, format: TimeFormat) {
    this.file = file;
    this.format = format;
    // Polled rather than fs.watch: it sees a file that's missing (or whose folder is) and comes
    // later, and a file replaced by a rename, with no watcher to re-arm.
    this.onStat = (now, before) => {
      if (now.mtimeMs === before.mtimeMs && now.size === before.size && now.ino === before.ino) return;
      this.reading = this.reading.then(() => this.reread());
    };
    watchFile(file, { interval: POLL_MS, persistent: false }, this.onStat);
  }

  static async start(file: string = CLIENT_SETTINGS): Promise<T3TimeFormat> {
    return new T3TimeFormat(file, await readTimeFormat(file));
  }

  current(): TimeFormat {
    return this.format;
  }

  onChange(listener: (f: TimeFormat) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    unwatchFile(this.file, this.onStat);
    this.listeners.clear();
  }

  private async reread() {
    const format = await readTimeFormat(this.file);
    if (format === this.format) return;
    this.format = format;
    for (const l of this.listeners) l(format);
  }
}
