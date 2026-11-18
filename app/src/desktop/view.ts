// What the window shows of the runner, kept in the main process (the runner runs there; the
// window only shows it): the settings, the `gh` account Name comes from, T3's Time format and
// T3's catalog of providers and models (#152).
// Every change is told to the listeners, which send it to the window.
import type { TimeFormat } from '../display.ts';
import { GitHubError, type Account, type GitHubAccount } from '../github.ts';
import type { Catalog } from '../jobs.ts';
import type { Settings, SettingsPatch, SettingsStore } from '../settings.ts';
import type { CatalogSource } from '../t3/catalog-source.ts';

export type View = {
  settings: Settings;
  /** The account gh is signed in as, or null when gh couldn't say (`accountError` says why). */
  account: Account | null;
  accountError?: string;
  /** T3's Time format, which the window's clock follows. */
  timeFormat: TimeFormat;
  /** What T3 offers each job: null until T3 first answers. */
  catalog: Catalog | null;
  /** Why T3 can't be asked for it now, while it can't. */
  catalogError?: string;
};

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

const catalogPart = (c: ReturnType<CatalogSource['current']>) =>
  ({ catalog: c.catalog, ...(c.error ? { catalogError: c.error } : {}) });

export class RunnerView {
  private view: View;
  private settings: SettingsStore;
  private listeners = new Set<(v: View) => void>();

  private constructor(settings: SettingsStore, view: View) {
    this.settings = settings;
    this.view = view;
  }

  static async start(settings: SettingsStore, github: GitHubAccount, timeFormat: TimeFormatSource, catalog: CatalogSource): Promise<RunnerView> {
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
      ...catalogPart(catalog.current()),
    });
    settings.onChange((s) => view.update({ settings: s }));
    timeFormat.onChange((f) => view.update({ timeFormat: f }));
    catalog.onChange((c) => view.update(catalogPart(c), ['catalogError']));
    return view;
  }

  get(): View {
    return this.view;
  }

  /** Saves a settings change; the view that follows is told to the listeners too. */
  async set(patch: SettingsPatch): Promise<View> {
    await this.settings.set(patch);
    return this.view;
  }

  onChange(listener: (v: View) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private update(part: Partial<View>, drop: (keyof View)[] = []) {
    const next: View = { ...this.view };
    for (const k of drop) delete next[k];
    this.view = { ...next, ...part };
    for (const l of this.listeners) l(this.view);
  }
}
