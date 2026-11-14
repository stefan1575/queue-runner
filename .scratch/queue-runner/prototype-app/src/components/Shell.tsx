// The frame, after leads-dashboard's AppShell: a white sidebar with the pages, a header with the
// scope picker and the page title, scrolling content. Below md the sidebar becomes a sheet.
import * as Dialog from "@radix-ui/react-dialog";
import { Activity, Gauge, Inbox, LayoutDashboard, ListOrdered, Menu, Settings, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useStore, useScoped } from "@/store";
import type { Lane, Runner } from "@/data/types";
import { A, Chip } from "./ui";
import { RepoPicker } from "./RepoPicker";

export const PAGES = [
  { path: "/", label: "Overview", icon: LayoutDashboard },
  { path: "/needs-you", label: "Needs you", icon: Inbox },
  { path: "/queue", label: "Queue", icon: ListOrdered },
  { path: "/activity", label: "Activity", icon: Activity },
  { path: "/usage", label: "Usage", icon: Gauge },
  { path: "/settings", label: "Settings", icon: Settings },
] as const;

export function Shell({ title, subtitle, crumb, children }: { title: ReactNode; subtitle?: ReactNode; crumb?: ReactNode; children: ReactNode }) {
  const { picker, world } = useStore();
  const [menu, setMenu] = useState(false);
  const stale = world.runner.connection === "stale";

  return (
    <div className="flex h-full bg-page text-ink">
      <nav className="hidden w-60 shrink-0 flex-col border-r border-line bg-surface md:flex" aria-label="Pages">
        <SidebarBody />
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Phone and tablet bar */}
        <div className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2.5 md:hidden">
          <Dialog.Root open={menu} onOpenChange={setMenu}>
            <Dialog.Trigger className="-ml-1.5 rounded-lg p-1.5 hover:bg-line-2" aria-label="Open menu"><Menu className="size-5" /></Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/30" />
              <Dialog.Content className="sheet-in-left fixed inset-y-0 left-0 z-50 flex w-[min(288px,85vw)] flex-col bg-surface shadow-2xl" aria-describedby={undefined}>
                <Dialog.Title className="sr-only">Menu</Dialog.Title>
                <Dialog.Close className="absolute right-3 top-4 rounded-md p-1 text-faint hover:bg-line-2" aria-label="Close menu"><X className="size-4" /></Dialog.Close>
                <SidebarBody onNavigate={() => setMenu(false)} />
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
          <Brand compact />
          <div className="ml-auto"><AskBadge /></div>
        </div>

        <header className="border-b border-line bg-surface px-4 pb-4 pt-4 md:px-8 md:pt-5">
          {picker === "content" && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <RepoPicker variant="content" />
              <RunnerStatus runner={world.runner} />
            </div>
          )}
          {picker === "sidebar" && <div className="mb-3 flex justify-end md:hidden"><RunnerStatus runner={world.runner} /></div>}
          {crumb && <div className="mb-1 text-[13px] text-mute">{crumb}</div>}
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-1">
            <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.015em]">{title}</h1>
            {picker === "sidebar" && <div className="hidden md:block"><RunnerStatus runner={world.runner} /></div>}
          </div>
          {subtitle && <div className="mt-1 max-w-[72ch] text-[13.5px] text-mute">{subtitle}</div>}
        </header>

        <main id="main" className={cn("flex-1 overflow-y-auto px-4 pb-28 pt-6 md:px-8", stale && "[&>*]:opacity-[.72]")}>
          <Banners />
          <ScopeNote />
          {children}
        </main>
      </div>
    </div>
  );
}

function Brand({ compact }: { compact?: boolean }) {
  return (
    <A to="/" className="flex items-center gap-2.5">
      <span className="inline-flex size-8 items-center justify-center rounded-lg bg-ink text-white">
        <svg viewBox="0 0 32 32" className="size-5" aria-hidden><path d="M8 11h16M8 16h11M8 21h7" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" fill="none" /></svg>
      </span>
      {!compact ? (
        <span className="leading-tight">
          <span className="block font-semibold tracking-tight">Queue runner</span>
          <span className="block text-[11.5px] text-mute">localhost · on this PC</span>
        </span>
      ) : (
        <span className="font-semibold tracking-tight">Queue runner</span>
      )}
    </A>
  );
}

function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  const { world, picker, path } = useStore();
  const { asks, issues } = useScoped();
  const ready = issues.filter((i) => i.state === "ready").length;
  const active = (p: string) => (p === "/" ? path === "/" : path.startsWith(p)) || (p === "/queue" && path.startsWith("/pr/"));

  return (
    <>
      <div className="px-5 py-5"><Brand /></div>
      {picker === "sidebar" && (
        <div className="px-3 pb-3">
          <RepoPicker variant="sidebar" />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-3" onClick={(e) => (e.target as HTMLElement).closest("a") && onNavigate?.()}>
        {PAGES.map(({ path: p, label, icon: Icon }) => {
          const on = active(p);
          const count = p === "/needs-you" ? asks.length : p === "/queue" ? ready : 0;
          return (
            <A key={p} to={p} className={cn("mb-0.5 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] font-medium", on ? "bg-ink text-white" : "text-ink-2 hover:bg-line-2")}>
              <Icon className={cn("size-4", on ? "text-white/80" : "text-faint")} />
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {count > 0 && (
                <span className={cn("rounded-full px-2 py-px text-[11.5px] tabular-nums", p === "/needs-you" ? "bg-you text-white font-semibold" : on ? "bg-white/15" : "bg-line-2 text-mute")}>
                  {count}
                  {p === "/needs-you" && !world.runner.github.ok ? "+" : ""}
                </span>
              )}
            </A>
          );
        })}
      </div>
      <div className="space-y-2 border-t border-line p-4">
        <LaneLine name="Builder" who="Claude" lane={world.claude} color="builder" paused={world.runner.claudePaused} />
        <LaneLine name="Reviewer" who="Sol" lane={world.sol} color="reviewer" />
      </div>
    </>
  );
}

function LaneLine({ name, who, lane, color, paused }: { name: string; who: string; lane: Lane; color: "builder" | "reviewer"; paused?: boolean }) {
  const dot = lane.status === "working" ? (color === "builder" ? "bg-builder text-builder" : "bg-reviewer text-reviewer") : lane.status === "waiting" ? "bg-warn text-warn" : lane.status === "unavailable" ? "bg-bad text-bad" : "bg-faint text-faint";
  const word = lane.status === "working" ? (lane.job ? `${lane.job.kind} ${lane.job.ref}` : "working") : lane.status === "waiting" ? `waiting${lane.until ? ` · ${lane.until}` : ""}` : lane.status;
  return (
    <A to="/" className="flex items-center gap-2 text-[12.5px]">
      <span className={cn("size-2 shrink-0 rounded-full", dot, lane.status === "working" && "live-dot")} />
      <span className="font-medium">{name}</span>
      <span className="text-faint">{who}</span>
      <span className="ml-auto truncate text-mute">{paused ? "paused · " : ""}{word}</span>
    </A>
  );
}

export function RunnerStatus({ runner }: { runner: Runner }) {
  const p = runner.process;
  const tone = p === "running" ? (runner.github.ok ? "ok" : "warn") : p === "stopped" ? "bad" : "warn";
  const word = p === "running" ? "Running" : p === "starting" ? "Starting" : p === "restarting" ? "Restarting" : "Stopped";
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
      <Chip tone={tone}>
        <span className={cn("size-1.5 rounded-full bg-current", p === "running" && "live-dot")} />
        {word}
        <span className="font-normal opacity-80">{p === "stopped" ? `· last seen ${runner.lastSeen}` : `· since ${runner.since}`}</span>
      </Chip>
      {runner.claudePaused && <Chip tone="you">Claude starts paused</Chip>}
      {!runner.github.ok && <Chip tone="warn">GitHub unreadable</Chip>}
    </div>
  );
}

function AskBadge() {
  const { asks } = useScoped();
  if (!asks.length) return null;
  return (
    <A to="/needs-you" className="flex items-center gap-1.5 rounded-full bg-you-soft px-2.5 py-1 text-[12.5px] font-semibold text-you">
      <Inbox className="size-3.5" /> {asks.length} need you
    </A>
  );
}

function Banners() {
  const { world } = useStore();
  const r = world.runner;
  const items: { tone: "bad" | "warn"; title: string; body: string }[] = [];
  if (r.process === "stopped") items.push({ tone: "bad", title: `The runner isn't running (last seen ${r.lastSeen})`, body: `${r.note ?? ""} Start it with the Queue runner shortcut. Everything below is as of ${r.lastSeen}.` });
  if (r.process === "starting") items.push({ tone: "warn", title: "Starting: waiting for T3", body: r.note ?? "" });
  if (r.process === "restarting") items.push({ tone: "warn", title: "Restarting on new code", body: r.note ?? "" });
  if (!r.github.ok) items.push({ tone: "warn", title: "Couldn't check everything that needs you", body: r.github.note ?? "" });
  if (!items.length) return null;
  return (
    <div className="mb-5 space-y-2">
      {items.map((b) => (
        <div key={b.title} className={cn("rounded-xl border px-4 py-3", b.tone === "bad" ? "border-bad/25 bg-bad-soft" : "border-warn/25 bg-warn-soft")}>
          <p className={cn("font-semibold", b.tone === "bad" ? "text-bad" : "text-warn")}>{b.title}</p>
          <p className="mt-0.5 max-w-[80ch] text-[13.5px] text-ink-2">{b.body}</p>
        </div>
      ))}
    </div>
  );
}

// While filtered to one repo, the asks elsewhere stay visible.
function ScopeNote() {
  const { repo, setRepo, path } = useStore();
  const { otherAsks } = useScoped();
  if (!repo || !otherAsks.length || path.startsWith("/pr/")) return null;
  const repos = [...new Set(otherAsks.map((a) => a.repo))];
  return (
    <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-you-line bg-you-soft/60 px-4 py-2.5 text-[13.5px]">
      <span>
        <b className="font-semibold text-you">{otherAsks.length} {otherAsks.length === 1 ? "ask" : "asks"} in other repos</b>
        <span className="text-ink-2"> ({repos.join(", ")})</span>
      </span>
      <button type="button" onClick={() => setRepo(null)} className="font-medium text-you underline-offset-2 hover:underline">Show all repositories</button>
    </div>
  );
}
