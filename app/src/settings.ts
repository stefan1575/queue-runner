// The settings the window edits (#36), kept in `settings.json` in the state folder. Each change
// is saved the moment it's made (there's no Save button) and read back on the next start. Later
// tickets add their own keys here.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATE_STYLES, type DateStyle } from './display.ts';
import { checkJobs, DEFAULT_JOBS, type Jobs } from './jobs.ts';
import { checkShares, type Shares } from './shares.ts';

export type Settings = {
  /** Your name for the briefs; null follows the `gh` account's name. */
  name: string | null;
  dateStyle: DateStyle;
  startWithWindows: boolean;
  /** Which model does each kind of job (#152; `src/jobs.ts`). */
  jobs: Jobs;
  /** Your share of each provider's weekly windows, by `<driver>/<window id>` (#153; `src/shares.ts`).
   *  A window not named keeps 0%. */
  shares: Shares;
};
export type SettingsPatch = Partial<Settings>;

export const DEFAULT_SETTINGS: Settings = { name: null, dateStyle: 'month-first', startWithWindows: true, jobs: DEFAULT_JOBS, shares: {} };

/** A change the page never offers: an unknown key or a value of the wrong kind. */
export class SettingsError extends Error {}

// Each key's check: the value it keeps, or undefined for one it refuses.
const CHECKS: { [K in keyof Settings]: (v: unknown) => Settings[K] | undefined } = {
  name: (v) => (v === null ? null : typeof v === 'string' ? (v.trim() || null) : undefined),
  dateStyle: (v) => (DATE_STYLES.some((d) => d.id === v) ? (v as DateStyle) : undefined),
  startWithWindows: (v) => (typeof v === 'boolean' ? v : undefined),
  jobs: checkJobs,
  shares: checkShares,
};
const KEYS = Object.keys(CHECKS) as (keyof Settings)[];

/** The patch, checked: a SettingsError for anything the page doesn't offer. */
export function checkPatch(patch: unknown): SettingsPatch {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new SettingsError('a change is an object');
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!KEYS.includes(k as keyof Settings)) throw new SettingsError(`no setting called ${k}`);
    const kept = CHECKS[k as keyof Settings](v);
    if (kept === undefined) throw new SettingsError(`${k} can't be ${JSON.stringify(v)}`);
    out[k] = kept;
  }
  return out as SettingsPatch;
}

export class SettingsStore {
  private file: string;
  private settings: Settings;
  private listeners = new Set<(s: Settings) => void>();
  /** Writes run one after another, so the file always ends on the last change. */
  private writing: Promise<void> = Promise.resolve();

  private constructor(file: string, settings: Settings) {
    this.file = file;
    this.settings = settings;
  }

  /** The settings kept in `folder`. A missing file is a new install; a key with a value this
   *  version doesn't take falls back to its default and the rest are kept. */
  static async open(folder: string): Promise<SettingsStore> {
    await mkdir(folder, { recursive: true });
    const file = join(folder, 'settings.json');
    let saved: Record<string, unknown> = {};
    try {
      saved = JSON.parse(await readFile(file, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${file} can't be read: ${(e as Error).message}`);
    }
    const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const k of KEYS) {
      const kept = k in saved ? CHECKS[k](saved[k]) : undefined;
      if (kept !== undefined) settings[k] = kept;
    }
    return new SettingsStore(file, settings as Settings);
  }

  get(): Settings {
    return { ...this.settings };
  }

  /** Saves the change and tells the listeners. A SettingsError (nothing saved) for a value the
   *  page never offers. A change whose write fails is not kept: `get()` and the next change go on
   *  from what was last saved. */
  async set(patch: SettingsPatch): Promise<Settings> {
    const checked = checkPatch(patch);
    // Built on the last saved settings when its turn to write comes, and kept only once written.
    const write = this.writing.then(async () => {
      const next = { ...this.settings, ...checked };
      // written aside and renamed over, so a crash mid-write never leaves half a file
      await writeFile(`${this.file}.tmp`, `${JSON.stringify(next, null, 2)}
`);
      await rename(`${this.file}.tmp`, this.file);
      this.settings = next;
      const now = this.get();
      for (const l of this.listeners) l(now);
      return now;
    });
    this.writing = write.then(() => {}, () => {});
    return write;
  }

  onChange(listener: (s: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
