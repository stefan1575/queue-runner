// The prototype's in-memory state: the demo world, the repo scope (from the URL) and the
// prototype's own switches. Nothing is persisted; reload resets the demo.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DEMOS } from "@/data/fixtures";
import type { World } from "@/data/types";
import { navigate, useUrl } from "@/lib/router";

type Store = {
  world: World;
  setWorld: (f: (w: World) => World) => void;
  demo: string;
  setDemo: (k: string) => void;
  repo: string | null; // null = all repositories
  setRepo: (r: string | null) => void;
  picker: "content" | "sidebar";
  opened: Set<string>; // asks whose link was opened (still open asks)
  markOpened: (id: string) => void;
  path: string;
};

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const { path, params } = useUrl();
  const demo = params.get("demo") && DEMOS[params.get("demo")!] ? params.get("demo")! : "normal";
  const [world, setW] = useState<World>(() => DEMOS[demo].make());
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(demo);

  useEffect(() => {
    if (demo !== loaded) {
      setW(DEMOS[demo].make());
      setOpened(new Set());
      setLoaded(demo);
    }
  }, [demo, loaded]);

  const repoParam = params.get("repo");
  const repo = repoParam && world.repos.some((r) => r.id === repoParam) ? repoParam : null;

  const value = useMemo<Store>(
    () => ({
      world,
      setWorld: (f) => setW((w) => f(structuredClone(w))),
      demo,
      setDemo: (k) => {
        const go = DEMOS[k].go;
        navigate(go ?? null, { demo: k === "normal" ? null : k, repo: k === "many-repos" ? null : new URL(location.href).searchParams.get("repo") });
      },
      repo,
      setRepo: (r) => navigate(null, { repo: r }),
      picker: params.get("picker") === "sidebar" ? "sidebar" : "content",
      opened,
      markOpened: (id) => setOpened((s) => new Set(s).add(id)),
      path,
    }),
    [world, demo, repo, params, opened, path],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore() {
  const s = useContext(Ctx);
  if (!s) throw new Error("no store");
  return s;
}

// The world filtered to the selected repo. Lanes and usage stay global: there are two lanes in all.
export function useScoped() {
  const { world, repo } = useStore();
  const inScope = (r: string) => repo === null || r === repo;
  return {
    asks: world.asks.filter((a) => inScope(a.repo)),
    otherAsks: world.asks.filter((a) => !inScope(a.repo)),
    issues: world.issues.filter((i) => inScope(i.repo)),
    prs: world.prs.filter((p) => inScope(p.repo)),
    activity: world.activity.filter((a) => inScope(a.repo)),
    inScope,
  };
}
