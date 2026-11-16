import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { Tone } from "@/data/types";

export function Section({ title, count, aside, children, className, flush }: { title: ReactNode; count?: number; aside?: ReactNode; children: ReactNode; className?: string; flush?: boolean }) {
  return (
    <section className={cn("min-w-0 rounded-lg border border-line bg-surface", className)}>
      <header className="flex h-11 items-center gap-2 border-b border-line-2 px-3">
        <h2 className="text-[15.5px] font-semibold">{title}</h2>
        {count !== undefined && <span className="text-[14.5px] tabular-nums text-mute">{count}</span>}
        {aside && <div className="ml-auto flex min-w-0 items-center gap-1">{aside}</div>}
      </header>
      <div className={flush ? "" : "p-3"}>{children}</div>
    </section>
  );
}

const TONES: Record<Tone, string> = {
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
  info: "bg-sunk text-ink-2",
  run: "bg-run-soft text-run",
  you: "bg-you-soft text-you",
};

export function Chip({ tone = "info", children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return <span title={title} className={cn("inline-flex h-6 items-center gap-1 whitespace-nowrap rounded px-1.5 text-[14px] font-medium", TONES[tone], className)}>{children}</span>;
}

export function Sha({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={cn("font-mono text-[14px] text-mute", className)}>{children}</code>;
}

export function Button({ children, onClick, variant = "default", className, type = "button", disabled, title }: {
  children: ReactNode; onClick?: () => void; variant?: "default" | "primary" | "ghost" | "you"; className?: string; type?: "button" | "submit"; disabled?: boolean; title?: string;
}) {
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 items-center justify-center gap-1 whitespace-nowrap rounded-md px-2.5 text-[15px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45",
        variant === "default" && "border border-line bg-surface hover:bg-sunk",
        variant === "primary" && "bg-accent text-white hover:brightness-110 dark:text-page",
        variant === "you" && "bg-you text-white hover:brightness-110",
        variant === "ghost" && "text-mute hover:bg-sunk hover:text-ink",
        className,
      )}
    >
      {children}
    </button>
  );
}

// One usage row, T3-style: label, bar, percent. The reset time sits under the bar when asked for.
export function UsageBar({ label, used, resets, reserve, showReset }: { label: string; used: number | null; resets: string; reserve?: number; showReset?: boolean }) {
  const v = used ?? 0;
  const fill = used === null ? "bg-faint" : v >= 100 ? "bg-bad" : v >= 85 ? "bg-run" : "bg-ink-2";
  return (
    <div className="grid grid-cols-[minmax(84px,auto)_1fr_48px] items-center gap-x-3 text-[15px]">
      <span className="text-mute">{label}</span>
      <div className="relative h-[5px] overflow-hidden rounded-full bg-sunk" role="img" aria-label={used === null ? `${label}: unknown` : `${label}: ${v}% used, resets ${resets}`} title={`Resets ${resets}`}>
        {used !== null && <div className={cn("h-full rounded-full", fill)} style={{ width: `${Math.min(v, 100)}%` }} />}
        {reserve !== undefined && <div className="absolute inset-y-0 right-0 bg-you/35" style={{ width: `${reserve}%` }} title={`${reserve}% kept for you`} />}
      </div>
      <b className={cn("text-right font-semibold tabular-nums", v >= 100 ? "text-bad" : v >= 85 && "text-run")}>{used === null ? "?" : `${v}%`}</b>
      {showReset && <span className="col-start-2 col-end-4 -mt-0.5 text-[13.5px] text-faint">resets {resets}</span>}
    </div>
  );
}

export function Dot({ className, live }: { className?: string; live?: boolean }) {
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", className, live && "live-dot")} />;
}

// Which repo an item belongs to, shown whenever the view spans more than one.
export function RepoTag({ repo, className }: { repo: string; className?: string }) {
  return <span className={cn("inline-flex h-6 shrink-0 items-center rounded-md border border-line px-1.5 text-[14px] font-medium text-ink-2", className)}>{repo}</span>;
}
