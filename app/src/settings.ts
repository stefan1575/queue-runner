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
  /** Each repo's choices, by T3 project id (#151). null until T3's projects were first seen: that
   *  first sight is a new install, where no project is marked New. */
  repos: Record<string, RepoChoice> | null;
  /** Whether Setup has been shown: it opens by itself on the app's first start only (#162). */
  setupSeen: boolean;
  /** The T3 provider instances (`instanceId`s) set up without outside tools: the only ones a
   *  review launches on (#155, docs/reviews.md). Empty: no review runs. */
  toolFreeInstances: string[];
};

/** Who merges a served repo's clean PRs. */
export type Merger = 'runner' | 'me';
/** A repo's choices: served (the runner works on it), who merges, and whether its "New" mark,
 *  for a project new from T3, has been looked at. */
export type RepoChoice = { served: boolean; merge: Merger; seen: boolean };
export type SettingsPatch = Partial<Settings>;

export const DEFAULT_SETTINGS: Settings = { name: null, dateStyle: 'month-first', startWithWindows: true, jobs: DEFAULT_JOBS, shares: {}, repos: null, setupSeen: false, toolFreeInstances: [] };

/** A change the page never offers: an unknown key or a value of the wrong kind. */
export class SettingsError extends Error {}

/** Each repo's choices; `lenient` drops an entry this version can't read (a saved file) where a
 *  change made now is refused whole. */
function repoChoices(v: unknown, lenient: boolean): Record<string, RepoChoice> | null | undefined {
  if (v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, RepoChoice> = {};
  for (const [id, c] of Object.entries(v as Record<string, any>)) {
    if (typeof c?.served === 'boolean' && (c.merge === 'runner' || c.merge === 'me') && typeof c.seen === 'boolean') {
      out[id] = { served: c.served, merge: c.merge, seen: c.seen };
    } else if (!lenient) return undefined;
  }
  return out;
}

// Each key's check: the value it keeps, or undefined for one it refuses.
const CHECKS: { [K in keyof Settings]: (v: unknown) => Settings[K] | undefined } = {
  name: (v) => (v === null ? null : typeof v === 'string' ? (v.trim() || null) : undefined),
  dateStyle: (v) => (DATE_STYLES.some((d) => d.id === v) ? (v as DateStyle) : undefined),
  startWithWindows: (v) => (typeof v === 'boolean' ? v : undefined),
  jobs: checkJobs,
  shares: checkShares,
  repos: (v) => repoChoices(v, false),
  setupSeen: (v) => (typeof v === 'boolean' ? v : undefined),
  toolFreeInstances: (v) => (Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() !== '')
    ? [...new Set(v.map((x: string) => x.trim()))] : undefined),
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

/** The file calls the settings make: the disk, or a test's own in-memory folder. A missing file
 *  is read as an error with `code` 'ENOENT', as Node's is. */
export type SettingsFiles = {
  mkdir(folder: string): Promise<void>;
  read(file: string): Promise<string>;
  write(file: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
};

export const DISK: SettingsFiles = {
  mkdir: async (folder) => { await mkdir(folder, { recursive: true }); },
  read: (file) => readFile(file, 'utf8'),
  write: (file, text) => writeFile(file, text),
  rename: (from, to) => rename(from, to),
};

export class SettingsStore {
  private file: string;
  private files: SettingsFiles;
  private settings: Settings;
  private listeners = new Set<(s: Settings) => void>();
  /** Writes run one after another, so the file always ends on the last change. */
  private writing: Promise<void> = Promise.resolve();

  private constructor(file: string, settings: Settings, files: SettingsFiles) {
    this.file = file;
    this.settings = settings;
    this.files = files;
  }

  /** The settings kept in `folder`. A missing file is a new install; a key with a value this
   *  version doesn't take falls back to its default and the rest are kept. */
  static async open(folder: string, files: SettingsFiles = DISK): Promise<SettingsStore> {
    await files.mkdir(folder);
    const file = join(folder, 'settings.json');
    let saved: Record<string, unknown> = {};
    try {
      saved = JSON.parse(await files.read(file));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${file} can't be read: ${(e as Error).message}`);
    }
    const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const k of KEYS) {
      // a saved repo entry this version can't read is dropped on its own; the rest are kept
      const kept = !(k in saved) ? undefined : k === 'repos' ? repoChoices(saved[k], true) : CHECKS[k](saved[k]);
      if (kept !== undefined) settings[k] = kept;
    }
    return new SettingsStore(file, settings as Settings, files);
  }

  get(): Settings {
    return { ...this.settings };
  }

  /** A change made from the settings as saved when its turn to write comes, so changes made
   *  together never undo each other (each repo's choices are one key). */
  async update(change: (s: Settings) => SettingsPatch): Promise<Settings> {
    return this.write(() => checkPatch(change(this.get())));
  }

  /** Saves the change and tells the listeners. A SettingsError (nothing saved) for a value the
   *  page never offers. A change whose write fails is not kept: `get()` and the next change go on
   *  from what was last saved. */
  async set(patch: SettingsPatch): Promise<Settings> {
    const checked = checkPatch(patch);
    return this.write(() => checked);
  }

  /** Built on the last saved settings when its turn to write comes, and kept only once written. */
  private write(patch: () => SettingsPatch): Promise<Settings> {
    const write = this.writing.then(async () => {
      const next = { ...this.settings, ...patch() };
      // written aside and renamed over, so a crash mid-write never leaves half a file
      await this.files.write(`${this.file}.tmp`, `${JSON.stringify(next, null, 2)}
`);
      await this.files.rename(`${this.file}.tmp`, this.file);
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
