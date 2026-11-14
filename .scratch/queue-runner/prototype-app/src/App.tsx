// PROTOTYPE (throwaway): the queue runner's main view on fake data. Nothing here reads or writes the
// runner, GitHub or T3. One page: Needs you, the two lanes, the work; usage and connections on the right.
import * as Popover from "@radix-ui/react-popover";
import { CirclePause, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { Toaster, toast } from "sonner";
import { Lanes } from "./components/Lanes";
import { NeedsList } from "./components/NeedsList";
import { PrototypeBar } from "./components/PrototypeBar";
import { Rail } from "./components/Rail";
import { RepoPicker } from "./components/RepoPicker";
import { Work } from "./components/Work";
import { Chip, Dot } from "./components/ui";
import { cn } from "./lib/cn";
import { PrDrawer } from "./pages/PrDetail";
import { StoreProvider, useStore } from "./store";

function TopBar() {
  const { world, live } = useStore();
  const r = world.runner;
  const [tone, word] = r.process === "running" ? (["ok", "Running"] as const) : r.process === "stopped" ? (["bad", "Not running"] as const) : (["warn", r.process === "starting" ? "Starting" : "Restarting"] as const);
  return (
    <header className="sticky top-0 z-30 flex h-11 items-center gap-2 border-b border-line bg-surface/90 px-3 backdrop-blur md:px-4">
      <span className="flex size-6 items-center justify-center rounded-md bg-accent text-white dark:text-page" aria-hidden>
        <svg viewBox="0 0 32 32" className="size-4"><path d="M8 11h16M8 16h11M8 21h7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" fill="none" /></svg>
      </span>
      <span className="hidden text-[13.5px] font-semibold sm:inline">Queue runner</span>
      <span className="text-line">/</span>
      <RepoPicker />
      <div className="ml-auto flex items-center gap-2">
        <Chip tone={tone} title={r.note}><Dot className="bg-current" live={r.process === "running"} />{word}<span className="hidden font-normal opacity-75 sm:inline">{r.process === "stopped" ? ` · last seen ${r.lastSeen}` : ` · since ${r.since}`}</span></Chip>
        <UpdatedAgo updatedAt={live.updatedAt} active={live.active} />
        <StopAll />
      </div>
    </header>
  );
}

function UpdatedAgo({ updatedAt, active }: { updatedAt: number; active: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const ago = Math.max(0, Math.round((now - updatedAt) / 1000));
  return (
    <span className={cn("hidden text-[12px] tabular-nums md:inline", active ? "text-mute" : "text-faint")} title="Refreshes when you focus this tab, then every 10 s while it stays focused">
      {active ? `Updated ${ago < 2 ? "now" : `${ago}s ago`}` : "Paused in background"}
    </span>
  );
}

function StopAll() {
  const { world, setWorld } = useStore();
  const [open, setOpen] = useState(false);
  const stopped = (["claude", "sol"] as const).every((k) => world[k].status === "stopped" || world[k].status === "stopping");
  const apply = (how: "after" | "now" | "resume") => {
    setWorld((w) => {
      for (const k of ["claude", "sol"] as const) {
        const l = w[k];
        const g = l.gates.find((x) => x.label === "Not stopped");
        if (how === "resume") { if (l.status === "stopped" || l.status === "stopping") l.status = l.job ? "working" : "idle"; if (g) { g.ok = true; g.note = undefined; } continue; }
        if (g) { g.ok = false; g.note = "Stopped by you"; }
        if (how === "now" || !l.job) { l.status = "stopped"; l.headline = l.job ? `Stopped by you during ${l.job.ref}` : "Stopped by you"; l.job = undefined; }
        else l.status = "stopping";
      }
    });
    setOpen(false);
    toast(how === "resume" ? "Both lanes resumed" : how === "now" ? "Both lanes stopped" : "Both lanes stop after their current job");
  };
  if (stopped) return <button type="button" onClick={() => apply("resume")} className="inline-flex h-7 items-center gap-1 rounded-md bg-accent px-2.5 text-[12.5px] font-medium text-white dark:text-page"><Play className="size-3.5" />Resume all</button>;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="inline-flex h-7 items-center gap-1 rounded-md border border-line px-2 text-[12.5px] font-medium hover:bg-sunk data-[state=open]:bg-sunk"><CirclePause className="size-3.5" /><span className="hidden sm:inline">Stop all</span></Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={4} className="z-50 w-60 rounded-lg border border-line bg-surface p-1 shadow-lg">
          {([["after", "After current jobs", "Both lanes finish, then start nothing"], ["now", "Now", "Cuts off both running jobs"]] as const).map(([k, t, s]) => (
            <button key={k} type="button" onClick={() => apply(k)} className="block w-full rounded-md px-2.5 py-1.5 text-left hover:bg-sunk">
              <span className={cn("block text-[13px] font-medium", k === "now" && "text-bad")}>{t}</span>
              <span className="block text-[12px] text-mute">{s}</span>
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Banner() {
  const { world } = useStore();
  const r = world.runner;
  const msg = r.process !== "running" ? r.note : !r.github.ok ? `GitHub unreadable. ${r.github.note}` : null;
  if (!msg) return null;
  return <div className={cn("rounded-lg border px-3 py-2 text-[12.5px]", r.process === "stopped" ? "border-bad/30 bg-bad-soft text-bad" : "border-warn/30 bg-warn-soft text-warn")}><b className="font-semibold">{r.process === "stopped" ? "The runner isn't running. " : ""}</b>{msg}</div>;
}

function Main() {
  const { world } = useStore();
  useEffect(() => { document.title = `${world.asks.length ? `(${world.asks.length}) ` : ""}Queue runner`; }, [world.asks.length]);
  return (
    <div className="flex min-h-full flex-col">
      <TopBar />
      <div className={cn("grid flex-1 grid-cols-[minmax(0,1fr)] gap-2 p-2 pb-20 md:p-3 md:pb-20 lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_330px]", world.runner.process === "stopped" && "[&_section]:opacity-80")}>
        <div className="min-w-0 space-y-2">
          <Banner />
          <NeedsList />
          <Lanes />
          <Work />
        </div>
        <aside className="min-w-0 lg:sticky lg:top-[52px] lg:max-h-[calc(100vh-60px)] lg:self-start lg:overflow-y-auto"><Rail /></aside>
      </div>
      <PrDrawer />
    </div>
  );
}

export function App() {
  return (
    <StoreProvider>
      <Main />
      <PrototypeBar />
      <Toaster position="bottom-right" toastOptions={{ style: { fontFamily: "var(--font-sans)", fontSize: 13 } }} />
    </StoreProvider>
  );
}
