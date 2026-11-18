// T3's catalog and each provider's usage as the main process keeps them (#152, #153):
// `subscribeServerConfig`'s snapshot, then its `providerStatuses` and `settingsUpdated` events
// (docs/app.md, The WebSocket API, Usage). T3 sends a `providerStatuses` event whenever a
// provider's usage changes. A stream that ends or fails keeps the last answer, says why, and is
// asked again after `retryMs`.
import type { Catalog } from '../jobs.ts';
import { usageFromProviders, type ProviderUsage } from '../usage.ts';
import { catalogFromConfig } from './catalog.ts';
import type { T3Ws } from './ws.ts';

/** The catalog (null until T3 first answers), each connected provider's usage and, while T3
 *  can't be asked, why. */
export type CatalogState = { catalog: Catalog | null; usage: ProviderUsage[]; error?: string };

export interface CatalogSource {
  current(): CatalogState;
  onChange(listener: (state: CatalogState) => void): () => void;
}

/** A catalog that never changes (the screenshots' sample). */
export const fixedCatalog = (catalog: Catalog, usage: ProviderUsage[] = []): CatalogSource =>
  ({ current: () => ({ catalog, usage }), onChange: () => () => {} });

export class T3Catalog implements CatalogSource {
  private state: CatalogState = { catalog: null, usage: [] };
  private config: { providers?: unknown; settings?: unknown } = {};
  private listeners = new Set<(s: CatalogState) => void>();
  private ws: Pick<T3Ws, 'subscribe'>;
  private retryMs: number;
  private stopped = false;
  private close: () => void = () => {};
  private timer: ReturnType<typeof setTimeout> | undefined;

  private constructor(ws: Pick<T3Ws, 'subscribe'>, retryMs: number) {
    this.ws = ws;
    this.retryMs = retryMs;
  }

  static start(ws: Pick<T3Ws, 'subscribe'>, retryMs = 30_000): T3Catalog {
    const c = new T3Catalog(ws, retryMs);
    c.subscribe();
    return c;
  }

  current(): CatalogState {
    return this.state;
  }

  onChange(listener: (s: CatalogState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.close();
  }

  private subscribe() {
    const sub = this.ws.subscribe('subscribeServerConfig', { workspaceSnapshotsOnDemand: true }, (v) => this.value(v));
    this.close = sub.close;
    sub.done.then(
      () => this.ended("T3 ended its server config stream"),
      (e: Error) => this.ended(e.message),
    );
  }

  private ended(why: string) {
    if (this.stopped) return;
    this.set({ ...this.state, error: why });
    this.timer = setTimeout(() => { if (!this.stopped) this.subscribe(); }, this.retryMs);
  }

  private value(v: any) {
    if (v?.type === 'snapshot') this.config = { providers: v.config?.providers, settings: v.config?.settings };
    else if (v?.type === 'providerStatuses') this.config = { ...this.config, providers: v.payload?.providers };
    else if (v?.type === 'settingsUpdated') this.config = { ...this.config, settings: v.payload?.settings };
    else return;
    this.set({ catalog: catalogFromConfig(this.config as any), usage: usageFromProviders(this.config.providers) });
  }

  private set(state: CatalogState) {
    this.state = state;
    for (const l of this.listeners) l(state);
  }
}
