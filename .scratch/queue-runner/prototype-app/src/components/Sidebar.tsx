// The sidebar: the repo switcher on top (like an org switcher), the pages, and at the bottom whether
// the runner is up and what it's connected to.
import { Activity, Gauge, LayoutDashboard, Settings } from "lucide-react";
import { navigate, useUrl } from "@/lib/router";
import { cn } from "@/lib/cn";
import { useScoped, useStore } from "@/store";
import { RepoPicker } from "./RepoPicker";
import { Dot } from "./ui";

export const PAGES = [
  { path: "/", label: "Dashboard", icon: LayoutDashboard },
  { path: "/activity", label: "Activity", icon: Activity },
  { path: "/usage", label: "Usage", icon: Gauge },
  { path: "/settings", label: "Settings", icon: Settings },
] as const;

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { path } = useUrl();
  const { asks } = useScoped();
  const go = (p: string) => { navigate(p); onNavigate?.(); };

  return (
    <div className="flex h-full flex-col">
      <div className="p-3"><RepoPicker /></div>
      <nav aria-label="Pages" className="flex-1 space-y-0.5 px-3 pt-1">
        {PAGES.map(({ path: p, label, icon: Icon }) => {
          const on = p === "/" ? path === "/" : path.startsWith(p);
          return (
            <button key={p} type="button" onClick={() => go(p)} aria-current={on ? "page" : undefined}
              className={cn("flex h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-[15px] font-medium", on ? "bg-surface text-ink shadow-sm ring-1 ring-line" : "text-ink-2 hover:bg-surface/60")}>
              <Icon className={cn("size-[18px]", on ? "text-ink" : "text-faint")} />
              <span className="flex-1">{label}</span>
              {p === "/" && asks.length > 0 && (
                <span className="min-w-6 rounded-full bg-you px-2 text-center text-[13px] font-semibold text-white dark:text-page" title={`${asks.length} need you`}>{asks.length}</span>
              )}
            </button>
          );
        })}
      </nav>
      <Health onNavigate={() => go("/settings")} />
    </div>
  );
}

function Health({ onNavigate }: { onNavigate: () => void }) {
  const { world } = useStore();
  const r = world.runner;
  const up = r.process === "running";
  const word = up ? "Running" : r.process === "stopped" ? "Not running" : r.process === "starting" ? "Starting" : "Restarting";
  const down = world.connections.filter((c) => !c.ok);
  return (
    <button type="button" onClick={onNavigate} className="m-3 rounded-xl border border-line bg-surface/70 p-3 text-left hover:bg-surface">
      <div className="flex items-center gap-2 text-[14.5px] font-semibold">
        <Dot className={up ? "bg-ok" : r.process === "stopped" ? "bg-bad" : "bg-run"} live={up} />
        <span className={cn(r.process === "stopped" && "text-bad")}>Runner {word.toLowerCase()}</span>
        <span className="ml-auto text-[13px] font-normal text-faint">{r.process === "stopped" ? `seen ${r.lastSeen}` : `since ${r.since}`}</span>
      </div>
      <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
        {world.connections.map((c) => (
          <li key={c.id} className="flex items-center gap-1.5 text-[13.5px]" title={c.status}>
            <Dot className={c.ok ? "bg-ok" : "bg-bad"} />
            <span className={c.ok ? "text-ink-2" : "font-medium text-bad"}>{c.name}</span>
          </li>
        ))}
      </ul>
      {down.length > 0 && <p className="mt-2 text-[13px] text-bad">{down.map((c) => `${c.name}: ${c.status}`).join(". ")}</p>}
    </button>
  );
}
