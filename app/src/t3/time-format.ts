// T3's Time format (`timestampFormat`), which the window's clock follows (#68 story 36, #36).
// It is a setting of T3's own window, kept in `~/.t3/userdata/client-settings.json`; T3's server
// doesn't serve it. So this is the one exception to "No reads of T3's database or settings"
// (docs/app.md, Rules; Stefan on #150): it reads that one key, never writes the file, and watches
// it. It goes once T3's server serves client settings.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TimeFormatSource } from '../desktop/view.ts';
import type { TimeFormat } from '../display.ts';
import { T3_HOME } from './real.ts';

export const CLIENT_SETTINGS = join(T3_HOME, 'userdata', 'client-settings.json');

const FORMATS: TimeFormat[] = ['locale', '12-hour', '24-hour'];
/** How often the file is read. It's a few hundred bytes, and reading it (not a stat) sees every
 *  change: a stat poll missed a write made while its first stat was still on its way, and a
 *  same-size write in the same clock tick as the last (CI, 2026-11-18 and 19). */
const POLL_MS = 500;

/** Runs `tick` again and again; returns the way to stop. The seam the tests run by hand, so
 *  none waits for real time to pass (#202). */
export type Poll = (tick: () => Promise<void>) => () => void;

/** `tick` every `ms`, the next wait set only once a tick is done, so a slow read never lands
 *  after a newer one. Its timer is never what keeps the app running. */
export const pollEvery = (ms: number): Poll => (tick) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const next = () => {
    timer = setTimeout(async () => {
      await tick();
      if (!stopped) next();
    }, ms);
    timer.unref();
  };
  next();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
};

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
  private stop: () => void;
  private closed = false;

  private constructor(file: string, format: TimeFormat, poll: Poll) {
    this.file = file;
    this.format = format;
    // Polled rather than fs.watch: it sees a file that's missing (or whose folder is) and comes
    // later, and a file replaced by a rename, with no watcher to re-arm.
    this.stop = poll(() => this.reread());
  }

  static async start(file: string = CLIENT_SETTINGS, poll: Poll = pollEvery(POLL_MS)): Promise<T3TimeFormat> {
    return new T3TimeFormat(file, await readTimeFormat(file), poll);
  }

  current(): TimeFormat {
    return this.format;
  }

  onChange(listener: (f: TimeFormat) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    this.stop();
    this.listeners.clear();
  }

  private async reread() {
    const format = await readTimeFormat(this.file);
    if (this.closed || format === this.format) return;
    this.format = format;
    for (const l of this.listeners) l(format);
  }
}
