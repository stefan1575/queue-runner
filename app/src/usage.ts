// Each connected provider's usage windows as T3 reports them (#153): `subscribeServerConfig`'s
// providers, each with `usageLimits {checkedAt, windows: [{id, kind, label, usedPercent, resetsAt,
// windowDurationMins}], resetCredits, unavailable}` (docs/app.md, Usage). T3 probes them itself
// and sends each change as a `providerStatuses` event; the app never asks a provider. Shared with
// the renderer, so nothing here touches Node.

export type WindowKind = 'session' | 'weekly' | 'monthly' | 'other';

export type UsageWindow = {
  /** T3's id for it, stable per provider (`five_hour`, `seven_day`, `primary`, ...). */
  id: string;
  kind: WindowKind;
  /** T3's label: `Session`, `Weekly`, or a window for some models only (`Weekly · <family>`). */
  label: string;
  usedPercent: number;
  /** When it resets (ISO), or null when T3 doesn't say (not started). */
  resetsAt: string | null;
  minutes: number | null;
};

export type ProviderUsage = {
  /** T3's `instanceId`. */
  provider: string;
  driver: string;
  /** The login whose usage this is: instances that share one share their windows and the jobs
   *  running on them (T3's `auth.workspaceId`, else its continuation group, else the instance). */
  account: string;
  /** T3's name for the provider. */
  label: string;
  /** The login's name, for what the app says about its windows: the shortest of its
   *  instances' names (one instance may be named for what it's for). */
  name: string;
  /** When T3 last read these windows (ISO), or null when it never has. */
  checkedAt: string | null;
  windows: UsageWindow[];
  /** Reset credits banked, when T3 reports any. */
  resetCredits: number | null;
  /** Why T3 has no windows for it: `unsupported` (T3 can't read this provider's usage) or
   *  `probeFailed`; null when it has them. */
  unavailable: string | null;
};

const KINDS: WindowKind[] = ['session', 'weekly', 'monthly', 'other'];
const connected = (p: any) => p && p.enabled !== false && p.status === 'ready' && typeof p.instanceId === 'string';
const iso = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);

function windowOf(w: any): UsageWindow | null {
  if (typeof w?.id !== 'string' || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) return null;
  return {
    id: w.id,
    kind: KINDS.includes(w.kind) ? w.kind : 'other',
    label: typeof w.label === 'string' ? w.label : w.id,
    usedPercent: Math.max(0, Math.min(100, w.usedPercent)),
    resetsAt: iso(w.resetsAt),
    minutes: typeof w.windowDurationMins === 'number' ? w.windowDurationMins : null,
  };
}

/** The usage of each provider T3 can start a thread on now, from T3's `providers`. */
export function usageFromProviders(providers: unknown): ProviderUsage[] {
  const all = (Array.isArray(providers) ? providers : []).filter(connected).map((p: any): ProviderUsage => {
    const u = p.usageLimits;
    const windows = (Array.isArray(u?.windows) ? u.windows : []).map(windowOf).filter((w: UsageWindow | null): w is UsageWindow => w !== null);
    const login = p.auth?.workspaceId ?? p.continuation?.groupKey;
    return {
      provider: p.instanceId,
      driver: String(p.driver ?? p.instanceId),
      account: `${p.driver ?? p.instanceId}:${typeof login === 'string' && login ? login : p.instanceId}`,
      label: String(p.displayName ?? p.instanceId),
      name: '',
      checkedAt: iso(u?.checkedAt),
      windows,
      resetCredits: typeof u?.resetCredits?.availableCount === 'number' ? u.resetCredits.availableCount : null,
      unavailable: windows.length ? null : String(u?.unavailable?.reason ?? (u ? 'probeFailed' : 'unsupported')),
    };
  });
  return all.map((u) => ({
    ...u,
    name: all.filter((o) => o.account === u.account).map((o) => o.label).reduce((a, b) => (b.length < a.length ? b : a)),
  }));
}

/** The models a window counts: a window labelled `<kind> · <family>` counts only the models
 *  whose name or id names that family; any other counts every model. */
export function windowFamily(w: Pick<UsageWindow, 'label'>): string | null {
  const at = w.label.indexOf('·');
  const family = at < 0 ? '' : w.label.slice(at + 1).trim();
  return family || null;
}

export function windowCounts(w: Pick<UsageWindow, 'label'>, model: { id: string; label?: string }): boolean {
  const family = windowFamily(w)?.toLowerCase();
  return !family || model.id.toLowerCase().includes(family) || (model.label ?? '').toLowerCase().includes(family);
}

/** The window as a person says it: "X's 5-hour window", "X's week", "X's <family> week". */
export function windowName(providerLabel: string, w: Pick<UsageWindow, 'kind' | 'label' | 'minutes'>): string {
  const family = windowFamily(w);
  const of = `${providerLabel}'s ${family ? `${family} ` : ''}`;
  if (w.kind === 'weekly') return `${of}week`;
  if (w.kind === 'monthly') return `${of}month`;
  if (w.kind === 'session') {
    const h = w.minutes && w.minutes % 60 === 0 ? w.minutes / 60 : null;
    return `${of}${h ? `${h}-hour` : 'session'} window`;
  }
  return `${providerLabel}'s ${w.label} window`;
}
