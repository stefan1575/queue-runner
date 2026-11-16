// The prototype's in-memory state: the demo world, the repo scope (URL), the PR drawer (URL), and
// the live refresh. Nothing is persisted; reload resets the demo.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DEMOS } from "@/data/fixtures";
import type { World } from "@/data/types";
import { navigate, useUrl } from "@/lib/router";

export const REFRESH_MS = 10_000;

type Live = { updatedAt: number; active: boolean };

type Store = {
  world: World;
  setWorld: (f: (w: World) => void) => void;
  demo: string;
  setDemo: (k: string) => void;
  repo: string | null;
  setRepo: (r: string | null) => void;
  openPr: (repo: string, n: number) => void;
  pr: [string, number] | null;
  closePr: () => void;
  opened: Set<string>;
  markOpened: (id: string) => void;
  live: Live;
};

const Ctx = createContext<Store | null>(null);

// Refetch on focus and every REFRESH_MS while the tab is visible and focused; stop when it isn't.
// Here a "fetch" just ticks the running jobs' elapsed minutes; for real it reads runner.json.
function useLive(onFetch: () => void): Live {
  const [updatedAt, setUpdatedAt] = useState(Date.now());
  const [active, setActive] = useState(document.visibilityState === "visible" && document.hasFocus());
  useEffect(() => {
    const fetchNow = () => { onFetch(); setUpdatedAt(Date.now()); };
    const sync = () => {
      const a = document.visibilityState === "visible" && document.hasFocus();
      setActive(a);
      if (a) fetchNow();
    };
    addEventListener("focus", sync);
    addEventListener("blur", sync);
    document.addEventListener("visibilitychange", sync);
    const poll = setInterval(() => { if (document.visibilityState === "visible" && document.hasFocus()) fetchNow(); }, REFRESH_MS);
    return () => {
      removeEventListener("focus", sync);
      removeEventListener("blur", sync);
      document.removeEventListener("visibilitychange", sync);
      clearInterval(poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return useMemo(() => ({ updatedAt, active }), [updatedAt, active]);
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const { params } = useUrl();
  const demo = params.get("demo") && DEMOS[params.get("demo")!] ? params.get("demo")! : "normal";
  const [world, setW] = useState<World>(() => DEMOS[demo].make());
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(demo);

  useEffect(() => {
    if (demo !== loaded) { setW(DEMOS[demo].make()); setOpened(new Set()); setLoaded(demo); }
  }, [demo, loaded]);

  const live = useLive(() =>
    setW((w) => {
      const n = structuredClone(w);
      for (const l of [n.claude, n.sol]) if (l.job && (l.status === "working" || l.status === "stopping")) l.job.minutes += 1;
      return n;
    }),
  );

  const repoParam = params.get("repo");
  const repo = repoParam && world.repos.some((r) => r.id === repoParam) ? repoParam : null;
  const prParam = params.get("pr");
  const pr: [string, number] | null = prParam ? [prParam.split("#")[0], Number(prParam.split("#")[1])] : null;

  const value = useMemo<Store>(
    () => ({
      world,
      setWorld: (f) => setW((w) => { const n = structuredClone(w); f(n); return n; }),
      demo,
      setDemo: (k) => {
        const p = DEMOS[k].pr;
        navigate(null, { demo: k === "normal" ? null : k, pr: p ? `${p[0]}#${p[1]}` : null, repo: null });
      },
      repo,
      setRepo: (r) => navigate(null, { repo: r }, true),
      openPr: (r, n) => navigate(null, { pr: `${r}#${n}` }),
      pr,
      closePr: () => navigate(null, { pr: null }),
      opened,
      markOpened: (id) => setOpened((s) => new Set(s).add(id)),
      live,
    }),
    [world, demo, repo, prParam, opened, live],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore() {
  const s = useContext(Ctx);
  if (!s) throw new Error("no store");
  return s;
}

export function useScoped() {
  const { world, repo } = useStore();
  const inScope = (r: string) => repo === null || r === repo;
  return {
    asks: world.asks.filter((a) => inScope(a.repo)),
    otherAsks: world.asks.filter((a) => !inScope(a.repo)),
    issues: world.issues.filter((i) => inScope(i.repo)),
    features: world.features.filter((f) => inScope(f.repo)),
    digest: world.digest.rows.filter((d) => inScope(d.repo)),
  };
}
