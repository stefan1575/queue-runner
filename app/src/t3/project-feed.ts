// T3's projects, kept from T3's events (#151; #68: the runner reacts to T3's events, no polling):
// `subscribeShell` on the WebSocket sends a snapshot of every project, then each one added,
// changed or removed (docs/app.md, The WebSocket API). Its thread items are ignored here. A stream
// that ends or fails is opened again after a wait, and its new snapshot replaces the list; one
// whose T3 says `snapshot-required` (it can't send what changed) is opened again at once. An
// archived project isn't one of the runner's repos: T3 hides it, so it goes here too.
import type { T3Ws } from './ws.ts';

/** A T3 project: the runner's repos are T3's projects. */
export type T3Project = { id: string; title: string; folder: string };

/** Where T3's projects come from, and word when they change. */
export interface ProjectFeed {
  /** Every project, or null until T3 has first answered. */
  current(): T3Project[] | null;
  /** Why the stream is down (T3 not running, refused), or null while it's up. */
  error(): string | null;
  onChange(listener: () => void): () => void;
}

/** Runs `again` after a wait; returns the way to cancel it. */
export type Retry = (again: () => void) => () => void;
export const retryAfter = (ms: number): Retry => (again) => {
  const t = setTimeout(again, ms);
  return () => clearTimeout(t);
};

const project = (p: any): T3Project | null =>
  (typeof p?.id === 'string' && typeof p.workspaceRoot === 'string'
    ? { id: p.id, title: typeof p.title === 'string' ? p.title : p.id, folder: p.workspaceRoot }
    : null);
const archived = (p: any) => p?.archivedAt != null;

export class T3ProjectFeed implements ProjectFeed {
  private projects: Map<string, T3Project> | null = null;
  private down: string | null = null;
  private listeners = new Set<() => void>();
  private stopped = false;
  private close: (() => void) | null = null;
  private ws: Pick<T3Ws, 'subscribe'>;
  private retry: Retry;

  private constructor(ws: Pick<T3Ws, 'subscribe'>, retry: Retry) {
    this.ws = ws;
    this.retry = retry;
  }

  static start(ws: Pick<T3Ws, 'subscribe'>, retry: Retry = retryAfter(5_000)): T3ProjectFeed {
    const feed = new T3ProjectFeed(ws, retry);
    feed.open();
    return feed;
  }

  current(): T3Project[] | null {
    return this.projects ? [...this.projects.values()] : null;
  }

  error(): string | null {
    return this.down;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop() {
    this.stopped = true;
    this.close?.();
  }

  private open() {
    if (this.stopped) return;
    let replaced = false;
    const sub = this.ws.subscribe('orchestration.subscribeShell', {}, (item) => {
      if (item?.kind !== 'snapshot-required') return this.take(item);
      // T3 can't send what changed since: a new stream starts from a whole snapshot
      replaced = true;
      sub.close();
      this.open();
    });
    this.close = () => sub.close();
    const ended = (why: string) => {
      if (this.stopped || replaced) return;
      this.down = why;
      this.tell();
      const cancel = this.retry(() => this.open());
      this.close = cancel;
    };
    sub.done.then(() => ended('T3 ended the project stream'), (e: Error) => ended(e.message));
  }

  private take(item: any) {
    switch (item?.kind) {
      case 'snapshot': {
        const all: any[] = item.snapshot?.projects ?? [];
        const list = all.filter((p) => !archived(p)).map(project).filter(Boolean) as T3Project[];
        // A snapshot naming the roots whose GitHub identity T3 just resolved holds only those
        // projects; one without is every project.
        if (item.resolvedRepositoryIdentityRoots === undefined || !this.projects) this.projects = new Map();
        for (const p of all) if (archived(p) && typeof p?.id === 'string') this.projects.delete(p.id);
        for (const p of list) this.projects.set(p.id, p);
        break;
      }
      case 'project.updated': {
        const p = project(item.project);
        if (!p || !this.projects) return;
        if (archived(item.project)) {
          if (!this.projects.delete(p.id)) return;
        } else this.projects.set(p.id, p);
        break;
      }
      case 'project.removed':
        if (!this.projects?.delete(item.projectId)) return;
        break;
      default:
        return; // threads, and `synchronized` (caught up: nothing to do)
    }
    this.down = null;
    this.tell();
  }

  private tell() {
    for (const l of this.listeners) l();
  }
}
