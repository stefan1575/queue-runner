// PROTOTYPE (throwaway): the queue runner's dashboard on fake data. Nothing here reads or writes the
// runner, GitHub or T3. A sidebar (repo switcher, pages, health), the page, and usage floating right.
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import { CirclePause, Gauge, Menu, Play, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Toaster, toast } from "sonner";
import { Lanes } from "./components/Lanes";
import { NeedsList } from "./components/NeedsList";
import { PAGES, Sidebar } from "./components/Sidebar";
import { UsageCard } from "./components/UsageCard";
import { Work } from "./components/Work";
import { cn } from "./lib/cn";
import { useUrl } from "./lib/router";
import { ActivityPage } from "./pages/Activity";
import { PrDrawer } from "./pages/PrDetail";
import { SettingsPage } from "./pages/Settings";
import { UsagePage } from "./pages/Usage";
import { StoreProvider, useStore } from "./store";

// PROTOTYPE (#36): the Settings page gets a wider column than the other pages.
const COLUMN = "mx-auto max-w-[1180px] min-[1600px]:mr-[max(344px,calc((100%-1180px)/2))]";
const WIDE_COLUMN = "mx-auto max-w-[1400px] min-[1600px]:mr-[max(344px,calc((100%-1400px)/2))]";

function TopBar({ title, wide, onMenu, usageOpen, toggleUsage }: { title: string; wide?: boolean; onMenu: () => void; usageOpen: boolean; toggleUsage: () => void }) {
  const { live } = useStore();
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-page/90 px-4 backdrop-blur md:px-6">
      <div className={cn("flex h-14 items-center gap-3", wide ? WIDE_COLUMN : COLUMN)}>
      <button type="button" onClick={onMenu} className="-ml-1 rounded-lg p-1.5 hover:bg-sunk md:hidden" aria-label="Open menu"><Menu className="size-5" /></button>
      <h1 className="text-[20px] font-semibold tracking-[-0.01em]">{title}</h1>
      <div className="ml-auto flex items-center gap-2">
        <UpdatedAgo updatedAt={live.updatedAt} active={live.active} />
        <StopAll />
        <button type="button" onClick={toggleUsage} aria-pressed={usageOpen} className={cn("inline-flex h-9 items-center gap-1.5 rounded-lg border border-line px-3 text-[15px] font-medium hover:bg-sunk min-[1600px]:hidden", usageOpen && "bg-sunk")}>
          <Gauge className="size-4" />Usage
        </button>
      </div>
      </div>
    </header>
  );
}

function UpdatedAgo({ updatedAt, active }: { updatedAt: number; active: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const ago = Math.max(0, Math.round((now - updatedAt) / 1000));
  return (
    <span className={cn("hidden text-[14.5px] tabular-nums lg:inline", active ? "text-mute" : "text-faint")} title="Refreshes when you focus this tab, then every 10 s while it stays focused">
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
  if (stopped) return <button type="button" onClick={() => apply("resume")} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-ink px-3 text-[15px] font-medium text-page"><Play className="size-3.5" />Resume all</button>;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[15px] font-semibold shadow-sm hover:border-faint hover:bg-sunk data-[state=open]:bg-sunk"><CirclePause className="size-4" /><span className="hidden sm:inline">Stop all</span></Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={4} className="z-50 w-60 rounded-lg border border-line bg-surface p-1 shadow-lg">
          {([["after", "After current jobs", "Both lanes finish, then start nothing"], ["now", "Now", "Cuts off both running jobs"]] as const).map(([k, t, s]) => (
            <button key={k} type="button" onClick={() => apply(k)} className="block w-full rounded-md px-2.5 py-1.5 text-left hover:bg-sunk">
              <span className={cn("block text-[15.5px] font-medium", k === "now" && "text-bad")}>{t}</span>
              <span className="block text-[14.5px] text-mute">{s}</span>
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
  return <div className={cn("rounded-xl border px-4 py-3 text-[15.5px]", r.process === "stopped" ? "border-bad/30 bg-bad-soft text-bad" : "border-warn/30 bg-warn-soft text-warn")}><b className="font-semibold">{r.process === "stopped" ? "The runner isn't running. " : ""}</b>{msg}</div>;
}

function Dashboard() {
  return (
    <div className="space-y-4">
      <NeedsList />
      <Lanes />
      <Work />
    </div>
  );
}

function Main() {
  const { world } = useStore();
  const { path, params } = useUrl();
  const [menu, setMenu] = useState(false);
  const [usage, setUsage] = useState(false);
  useEffect(() => { document.title = `${world.asks.length ? `(${world.asks.length}) ` : ""}Queue runner`; }, [world.asks.length]);
  const page = PAGES.find((p) => p.path === path) ?? PAGES[0];
  const wide = page.path === "/settings" && params.get("round") !== "1"; // round 1 of the Settings prototype had the usual column

  return (
    <div className="flex min-h-full">
      <nav aria-label="Sidebar" className="sticky top-0 hidden h-screen w-[280px] shrink-0 border-r border-line bg-side md:block"><Sidebar /></nav>
      <Dialog.Root open={menu} onOpenChange={setMenu}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
          <Dialog.Content aria-describedby={undefined} className="sheet-in-left fixed inset-y-0 left-0 z-50 w-[min(300px,86vw)] bg-side shadow-2xl">
            <Dialog.Title className="sr-only">Menu</Dialog.Title>
            <Dialog.Close className="absolute right-2 top-2 z-10 rounded-md p-1.5 text-faint hover:bg-sunk" aria-label="Close menu"><X className="size-4" /></Dialog.Close>
            <Sidebar onNavigate={() => setMenu(false)} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar title={page.label} wide={wide} onMenu={() => setMenu(true)} usageOpen={usage} toggleUsage={() => setUsage(!usage)} />
        <main id="main" className={cn("flex-1 px-4 py-5 md:px-6", world.runner.process === "stopped" && "[&_section]:opacity-80")}>
          <div className={cn("space-y-4", wide ? WIDE_COLUMN : COLUMN)}>
          <Banner />
          {page.path === "/" && <Dashboard />}
          {page.path === "/activity" && <ActivityPage />}
          {page.path === "/usage" && <UsagePage />}
          {page.path === "/settings" && <SettingsPage />}
          </div>
        </main>
      </div>

      {/* Wide windows: always in view on the right. Narrower: opened from the top bar. */}
      {page.path !== "/usage" && <UsageCard className="fixed right-6 top-[76px] z-20 hidden min-[1600px]:block" />}
      {usage && <UsageCard onClose={() => setUsage(false)} className="fixed right-4 top-[64px] z-40 max-w-[calc(100vw-32px)] min-[1600px]:hidden" />}
      <PrDrawer />
    </div>
  );
}

export function App() {
  return (
    <StoreProvider>
      <Main />
      <Toaster position="bottom-right" toastOptions={{ style: { fontFamily: "var(--font-sans)", fontSize: 14 } }} />
    </StoreProvider>
  );
}
