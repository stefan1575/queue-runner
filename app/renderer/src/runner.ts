// The window's side of the bridge: the runner's view, kept current, and a ticking clock.
import { useEffect, useState } from 'react';
import type { Bridge } from '../../src/desktop/bridge.ts';
import type { View } from '../../src/desktop/view.ts';

declare global {
  interface Window { runner: Bridge }
}

export const runner = (): Bridge => window.runner;

/** The runner's view, null until the main process has answered. */
export function useView(): View | null {
  const [view, setView] = useState<View | null>(null);
  useEffect(() => {
    let live = true;
    const off = runner().onView((v) => setView(v));
    void runner().view().then((v) => { if (live) setView(v); });
    return () => { live = false; off(); };
  }, []);
  return view;
}

/** The time now, moved on every 15 seconds so the previews keep up with the clock. */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  return now;
}
