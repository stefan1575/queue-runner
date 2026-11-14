import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { Tone } from "@/data/types";

export function Section({ title, count, aside, children, className, flush }: { title: ReactNode; count?: number; aside?: ReactNode; children: ReactNode; className?: string; flush?: boolean }) {
  return (
    <section className={cn("min-w-0 rounded-lg border border-line bg-surface", className)}>
      <header className="flex h-9 items-center gap-2 border-b border-line-2 px-3">
        <h2 className="text-[13px] font-semibold">{title}</h2>
        {count !== undefined && <span className="text-[12px] tabular-nums text-mute">{count}</span>}
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
  run: "bg-builder-soft text-builder",
  you: "bg-you-soft text-you",
};

export function Chip({ tone = "info", children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return <span title={title} className={cn("inline-flex h-5 items-center gap-1 whitespace-nowrap rounded px-1.5 text-[11.5px] font-medium", TONES[tone], className)}>{children}</span>;
}

export function Sha({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={cn("font-mono text-[11.5px] text-mute", className)}>{children}</code>;
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
        "inline-flex h-7 items-center justify-center gap-1 whitespace-nowrap rounded-md px-2.5 text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45",
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

// A thin usage bar, T3-style: label, bar, percent, reset.
export function UsageBar({ label, used, resets, reserve, color }: { label: string; used: number | null; resets: string; reserve?: number; color: string }) {
  const v = used ?? 0;
  const fill = used === null ? "bg-faint" : v >= 95 ? "bg-bad" : v >= 80 ? "bg-warn" : color;
  return (
    <div className="grid grid-cols-[34px_1fr_auto] items-center gap-x-2 text-[12px]">
      <span className="text-mute">{label}</span>
      <div className="relative h-1.5 overflow-hidden rounded-full bg-sunk" role="img" aria-label={used === null ? `${label}: unknown` : `${label}: ${v}% used`}>
        {used !== null && <div className={cn("h-full rounded-full", fill)} style={{ width: `${Math.min(v, 100)}%` }} />}
        {reserve !== undefined && <div className="absolute inset-y-0 right-0 border-l border-you bg-you/25" style={{ width: `${reserve}%` }} title={`${reserve}% kept for you`} />}
      </div>
      <span className="w-[112px] whitespace-nowrap text-right tabular-nums">
        <b className="font-semibold">{used === null ? "?" : `${v}%`}</b>
        <span className="text-mute"> · {resets}</span>
      </span>
    </div>
  );
}

export function Dot({ className, live }: { className?: string; live?: boolean }) {
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", className, live && "live-dot")} />;
}
