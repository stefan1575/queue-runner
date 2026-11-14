import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { navigate } from "@/lib/router";
import type { Tone } from "@/data/types";

export function A({ to, className, children, ...rest }: { to: string; className?: string; children: ReactNode; title?: string }) {
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.button !== 0) return;
        e.preventDefault();
        const u = new URL(to, location.origin);
        const set: Record<string, string> = {};
        u.searchParams.forEach((v, k) => (set[k] = v));
        navigate(u.pathname, set);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

export function Panel({ title, aside, children, className, pad = true }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={cn("min-w-0 rounded-xl border border-line bg-surface", className)}>
      {title && (
        <header className="flex items-baseline justify-between gap-3 border-b border-line-2 px-4 py-3 sm:px-5">
          <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
          {aside && <div className="shrink-0 text-[13px] text-mute">{aside}</div>}
        </header>
      )}
      <div className={pad ? "p-4 sm:p-5" : ""}>{children}</div>
    </section>
  );
}

const TONES: Record<Tone, string> = {
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
  info: "bg-line-2 text-ink-2",
  run: "bg-builder-soft text-builder",
  you: "bg-you-soft text-you",
};

export function Chip({ tone = "info", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[12px] font-medium leading-4", TONES[tone], className)}>{children}</span>;
}

export function Sha({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={cn("rounded bg-line-2 px-1 py-px font-mono text-[11.5px] text-ink-2", className)}>{children}</code>;
}

export function Button({
  children,
  onClick,
  variant = "default",
  className,
  type = "button",
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "ghost" | "you";
  className?: string;
  type?: "button" | "submit";
  disabled?: boolean;
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        variant === "default" && "border border-line bg-surface text-ink hover:bg-page",
        variant === "primary" && "bg-ink text-white hover:bg-ink-2",
        variant === "you" && "bg-you text-white hover:brightness-110",
        variant === "ghost" && "text-mute hover:bg-line-2 hover:text-ink",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Meter({ value, reserve, label }: { value: number | null; reserve?: number; label: string }) {
  const v = value ?? 0;
  const tone = value === null ? "bg-faint" : v >= 90 ? "bg-bad" : v >= 75 ? "bg-warn" : "bg-builder";
  return (
    <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-line-2" role="img" aria-label={value === null ? `${label}: unknown` : `${label}: ${v}% used`}>
      {value !== null && <div className={cn("h-full rounded-full", tone)} style={{ width: `${Math.min(v, 100)}%` }} />}
      {reserve !== undefined && (
        <div
          className="absolute inset-y-0 right-0 border-l-2 border-you bg-[repeating-linear-gradient(135deg,transparent_0_3px,rgba(163,82,0,.22)_3px_5px)]"
          style={{ width: `${reserve}%` }}
          title={`${reserve}% kept for you`}
        />
      )}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-1 py-2">
      <p className="text-[15px] font-semibold">{title}</p>
      {children && <p className="max-w-prose text-mute">{children}</p>}
    </div>
  );
}

export function RepoTag({ id, className }: { id: string; className?: string }) {
  return <span className={cn("truncate text-[12.5px] text-mute", className)}>{id}</span>;
}
