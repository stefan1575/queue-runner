// Your share (#153, #36's "Your share of each plan"; #68 story 20): a percent of each provider's
// weekly windows kept for you, 0% by default, released some hours before the window resets (24 by
// default). One row per provider per weekly window, whichever kinds of job run there. The setting
// is keyed by T3's driver and window id (`<driver>/<window id>`), so it outlasts a new sign-in and
// covers every instance of that driver. Shared with the renderer, so nothing here touches Node.
import { windowName, type ProviderUsage, type UsageWindow } from './usage.ts';

export type Share = { percent: number; releaseHours: number };
export type Shares = Record<string, Share>;

export const DEFAULT_SHARE: Share = { percent: 0, releaseHours: 24 };
/** The longest a share can be held back: a week. */
export const MAX_RELEASE_HOURS = 168;

export const shareKey = (driver: string, windowId: string) => `${driver}/${windowId}`;
export const shareOf = (shares: Shares, driver: string, windowId: string): Share => shares[shareKey(driver, windowId)] ?? DEFAULT_SHARE;

/** When a share is released: `releaseHours` before the window resets; null when T3 gives no reset. */
export function releaseAt(share: Share, resetsAt: string | null): Date | null {
  return resetsAt ? new Date(Date.parse(resetsAt) - share.releaseHours * 3_600_000) : null;
}

/** The percent of a window kept for you now: the share until its release, then nothing. A
 *  window with no reset T3 knows of keeps it. */
export function heldPercent(share: Share, w: Pick<UsageWindow, 'resetsAt'>, now: Date): number {
  const at = releaseAt(share, w.resetsAt);
  return at === null || now < at ? share.percent : 0;
}

const isShare = (v: unknown): v is Share => {
  const s = v as Share;
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 2
    && Number.isInteger(s.percent) && s.percent >= 0 && s.percent <= 100
    && Number.isInteger(s.releaseHours) && s.releaseHours >= 0 && s.releaseHours <= MAX_RELEASE_HOURS;
};

/** The shares setting, checked: undefined for anything that isn't one. */
export function checkShares(v: unknown): Shares | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const out: Shares = {};
  for (const [k, s] of Object.entries(v)) {
    if (!/^[^/]+\/.+$/.test(k) || !isShare(s)) return undefined;
    out[k] = { percent: s.percent, releaseHours: s.releaseHours };
  }
  return out;
}

export type ShareRow = {
  key: string;
  /** "X's week", "X's <family> week". */
  title: string;
  resetsAt: string | null;
  /** False for a provider T3 reads no usage for: the row shows greyed, "Coming soon". */
  enforced: boolean;
  share: Share;
};

/** The page's rows: each connected provider's weekly windows, once per driver (instances on one
 *  driver show the same windows), named by the shortest of its instances' names. A provider T3
 *  reads no usage for gets one row for its week, not enforced. */
export function shareRows(usage: ProviderUsage[], shares: Shares): ShareRow[] {
  const drivers = [...new Set(usage.map((u) => u.driver))];
  return drivers.flatMap((driver): ShareRow[] => {
    const all = usage.filter((u) => u.driver === driver);
    const label = all.map((u) => u.label).reduce((a, b) => (b.length < a.length ? b : a));
    const read = all.find((u) => u.windows.length > 0);
    if (!read) {
      const key = shareKey(driver, 'weekly');
      return [{ key, title: `${label}'s week`, resetsAt: null, enforced: false, share: shares[key] ?? DEFAULT_SHARE }];
    }
    return read.windows.filter((w) => w.kind === 'weekly').map((w) => ({
      key: shareKey(driver, w.id), title: windowName(label, w), resetsAt: w.resetsAt, enforced: true,
      share: shareOf(shares, driver, w.id),
    }));
  });
}
