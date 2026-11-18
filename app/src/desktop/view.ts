// What the window shows of the runner, kept in the main process (the runner runs there; the
// window only shows it): the settings, the `gh` account Name comes from, and T3's Time format.
// Every change is told to the listeners, which send it to the window.
import type { TimeFormat } from '../display.ts';
import { GitHubError, type Account, type GitHubAccount } from '../github.ts';
import { NotEmpty, RepoError, type Repo } from '../repos.ts';
import { SettingsError, type Merger, type Settings, type SettingsPatch, type SettingsStore } from '../settings.ts';
import { T3Error } from '../t3/seams.ts';

export type View = {
  settings: Settings;
  /** The account gh is signed in as, or null when gh couldn't say (`accountError` says why). */
  account: Account | null;
  accountError?: string;
  /** T3's Time format, which the window's clock follows. */
  timeFormat: TimeFormat;
  /** T3's projects, each with its choices; null until T3 has first answered. */
  repos: Repo[] | null;
  /** Why T3's projects can't be had right now, or null. */
  reposError: string | null;
};

/** What the window asks of Repositories. */
export type RepoAction =
  | { do: 'serve'; id: string; on: boolean }
  | { do: 'merge'; id: string; merge: Merger }
  | { do: 'seen'; ids: string[] }
  /** Read every project's GitHub remote again, as the Repositories page opens. */
  | { do: 'check' }
  | { do: 'add' }
  | { do: 'remove'; id: string; withThreads?: boolean };

/** How it went: `error` says why it didn't (`notEmpty` when the project still has threads in
 *  T3, which the window asks about); `added` is the folder an add made a project of, or null
 *  when the picker was closed. */
export type RepoResult = { error?: string; notEmpty?: boolean; added?: string | null };

const isId = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** The action as the window sent it over IPC, or null when any field isn't what it should be. */
export function checkAction(a: unknown): RepoAction | null {
  const o = a as Record<string, unknown> | null;
  if (typeof o !== 'object' || o === null) return null;
  switch (o.do) {
    case 'serve': return isId(o.id) && typeof o.on === 'boolean' ? { do: 'serve', id: o.id, on: o.on } : null;
    case 'merge': return isId(o.id) && (o.merge === 'me' || o.merge === 'runner') ? { do: 'merge', id: o.id, merge: o.merge } : null;
    case 'seen': return Array.isArray(o.ids) && o.ids.every(isId) ? { do: 'seen', ids: o.ids } : null;
    case 'check': return { do: 'check' };
    case 'add': return { do: 'add' };
    case 'remove':
      return isId(o.id) && (o.withThreads === undefined || typeof o.withThreads === 'boolean')
        ? { do: 'remove', id: o.id, withThreads: o.withThreads === true } : null;
    default: return null;
  }
}

/** Repositories, as the view needs it (src/repos.ts). */
export interface RepoSource {
  list(): Repo[] | null;
  error(): string | null;
  onChange(listener: () => void): () => void;
  setServed(id: string, on: boolean): Promise<void>;
  setMerge(id: string, merge: Merger): Promise<void>;
  seen(ids: string[]): Promise<void>;
  check(): Promise<void>;
  add(): Promise<string | null>;
  remove(id: string, withThreads?: boolean): Promise<void>;
}

/** Where T3's Time format comes from, and word when it changes. */
export interface TimeFormatSource {
  current(): TimeFormat;
  onChange(listener: (format: TimeFormat) => void): () => void;
}

/** The name the briefs use: yours, else the account's name, else its login; null when there's
 *  none of them. */
export function briefName(view: View): string | null {
  return view.settings.name ?? view.account?.name ?? view.account?.login ?? null;
}

export class RunnerView {
  private view: View;
  private settings: SettingsStore;
  private repos: RepoSource | null = null;
  private listeners = new Set<(v: View) => void>();

  private constructor(settings: SettingsStore, view: View) {
    this.settings = settings;
    this.view = view;
  }

  static async start(settings: SettingsStore, github: GitHubAccount, timeFormat: TimeFormatSource, repos: RepoSource): Promise<RunnerView> {
    let account: Account | null = null;
    let accountError: string | undefined;
    try {
      account = await github.account();
    } catch (e) {
      if (!(e instanceof GitHubError)) throw e;
      accountError = e.message;
    }
    const view = new RunnerView(settings, {
      settings: settings.get(), account, ...(accountError ? { accountError } : {}), timeFormat: timeFormat.current(),
      repos: repos.list(), reposError: repos.error(),
    });
    view.repos = repos;
    settings.onChange((s) => view.update({ settings: s }));
    repos.onChange(() => view.update({ repos: repos.list(), reposError: repos.error() }));
    timeFormat.onChange((f) => view.update({ timeFormat: f }));
    return view;
  }

  get(): View {
    return this.view;
  }

  /** Saves a settings change; the view that follows is told to the listeners too. Each repo's
   *  choices change only through `repo()`, which does what switching one on needs. */
  async set(patch: SettingsPatch): Promise<View> {
    if (patch && typeof patch === 'object' && 'repos' in patch) throw new SettingsError("a repository's choices change through its own controls");
    await this.settings.set(patch);
    return this.view;
  }

  /** Does what the window asked of Repositories. A refusal (no remote, gh or T3 failing) comes
   *  back as `error`, never thrown, so the window can tell a project with threads apart. An
   *  action with a field of the wrong kind is refused before anything is done. */
  async repo(asked: RepoAction): Promise<RepoResult> {
    const r = this.repos!;
    const action = checkAction(asked);
    if (!action) return { error: `the window asked for something unknown: ${JSON.stringify(asked)}` };
    try {
      switch (action.do) {
        case 'serve': await r.setServed(action.id, action.on); return {};
        case 'merge': await r.setMerge(action.id, action.merge); return {};
        case 'seen': await r.seen(action.ids); return {};
        case 'check': await r.check(); return {};
        case 'add': return { added: await r.add() };
        case 'remove': await r.remove(action.id, action.withThreads === true); return {};
      }
      return {};
    } catch (e) {
      if (e instanceof NotEmpty) return { error: e.message, notEmpty: true };
      if (e instanceof RepoError || e instanceof GitHubError || e instanceof T3Error || e instanceof SettingsError) return { error: e.message };
      throw e;
    }
  }

  onChange(listener: (v: View) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private update(part: Partial<View>) {
    this.view = { ...this.view, ...part };
    for (const l of this.listeners) l(this.view);
  }
}
