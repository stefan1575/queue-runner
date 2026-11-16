// PROTOTYPE (throwaway): the small controls the three Settings layouts share. Only atoms live here
// (a switch, a menu, a number, the confirm dialogs); each layout decides where they go.
// "box" is a control in a form row; "inline" is a word in a sentence that opens the same menu.
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import * as Switch from "@radix-ui/react-switch";
import { Check, ChevronDown, ExternalLink, Folder, FolderPlus, Play, TriangleAlert } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ProviderName } from "@/components/Brand";
import { Chip } from "@/components/ui";
import { cn } from "@/lib/cn";
import { clock, DATE_STYLES, EFFORT_LABEL, fmtDate, play, PROVIDER_IDS, SOUNDS, T3_PROVIDERS, T3_SNOOZE, type Effort, type ProviderId, type RepoRow, type RoleId } from "./model";
import type { Settings } from "./state";

export type Look = "box" | "inline";
export interface Opt<T extends string> { id: T; label: string; node?: ReactNode; hint?: string }

export const BTN = "inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-line bg-surface px-3 text-[15px] font-medium hover:bg-sunk disabled:cursor-not-allowed disabled:opacity-45";
const BOX = "inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg border border-line bg-surface px-3 text-[15.5px] hover:bg-sunk data-[state=open]:bg-sunk disabled:cursor-not-allowed disabled:opacity-50";
// A word you can change: sunk behind it and a dotted underline, so it reads as part of the sentence.
export const TOKEN = "inline-flex items-baseline gap-1 whitespace-nowrap rounded-md bg-sunk px-1.5 font-semibold text-ink underline decoration-faint decoration-dotted underline-offset-[5px] hover:bg-line data-[state=open]:bg-line disabled:cursor-not-allowed disabled:no-underline";
export const NUDGE = "rounded-lg border border-you-line bg-you-soft text-you";

export function Pick<T extends string>({ value, options, onChange, look = "box", disabled, label, className }: {
  value: T; options: Opt<T>[]; onChange: (v: T) => void; look?: Look; disabled?: boolean; label: string; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const cur = options.find((o) => o.id === value);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger disabled={disabled} aria-label={`${label}: ${cur?.label ?? value}`} className={cn(look === "box" ? BOX : TOKEN, className)}>
        {look === "box" ? <span className="min-w-0 truncate">{cur?.node ?? cur?.label ?? value}</span> : cur?.node ?? cur?.label ?? value}
        {look === "box" && <ChevronDown className="ml-auto size-4 shrink-0 text-faint" />}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={4} className="z-50 min-w-[max(190px,var(--radix-popover-trigger-width))] max-w-[min(420px,92vw)] rounded-lg border border-line bg-surface p-1 shadow-lg">
          {options.map((o) => (
            <button key={o.id} type="button" onClick={() => { setOpen(false); if (o.id !== value) onChange(o.id); }}
              className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-[15.5px] hover:bg-sunk">
              <Check className={cn("mt-[3px] size-4 shrink-0", o.id === value ? "text-ink" : "invisible")} />
              <span className="min-w-0">
                <span className={cn("block", o.id === value && "font-semibold")}>{o.node ?? o.label}</span>
                {o.hint && <span className="block text-[14px] text-mute">{o.hint}</span>}
              </span>
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <Switch.Root checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label}
      className="relative h-6 w-[42px] shrink-0 rounded-full bg-faint transition-colors data-[state=checked]:bg-ink disabled:cursor-not-allowed disabled:opacity-40">
      <Switch.Thumb className="block size-[18px] translate-x-[3px] rounded-full bg-surface shadow transition-transform data-[state=checked]:translate-x-[21px]" />
    </Switch.Root>
  );
}

export function Seg<T extends string>({ value, options, onChange, disabled, label, className }: { value: T; options: Opt<T>[]; onChange: (v: T) => void; disabled?: boolean; label: string; className?: string }) {
  return (
    <div role="group" aria-label={label} className={cn("inline-flex h-9 rounded-lg border border-line bg-sunk p-0.5", disabled && "opacity-45", className)}>
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={o.id === value} disabled={disabled} onClick={() => o.id !== value && onChange(o.id)}
          className={cn("flex-1 whitespace-nowrap rounded-md px-3 text-[15px] disabled:cursor-not-allowed", o.id === value ? "bg-surface font-medium text-ink shadow-sm ring-1 ring-line" : "text-mute hover:text-ink")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// A whole number that saves as soon as it's a valid one. Up and down arrows step it.
export function Num({ value, onChange, min = 0, max = 100, look = "box", disabled, label }: {
  value: number; onChange: (n: number) => void; min?: number; max?: number; look?: Look; disabled?: boolean; label: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  const type = (t: string) => { setText(t); if (/^\d+$/.test(t) && clamp(+t) !== value) onChange(clamp(+t)); };
  return (
    <input
      inputMode="numeric" aria-label={label} disabled={disabled} value={text}
      onChange={(e) => type(e.target.value.replace(/\D/g, "").slice(0, 3))}
      onBlur={() => setText(String(value))}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); const n = clamp(value + (e.key === "ArrowUp" ? 1 : -1)); if (n !== value) onChange(n); }
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      style={{ width: `calc(${Math.max(2, text.length)}ch + ${look === "box" ? 22 : 14}px)` }}
      className={cn("text-center tabular-nums disabled:cursor-not-allowed",
        look === "box" ? "h-9 rounded-lg border border-line bg-surface text-[15.5px] disabled:opacity-50" : "rounded-md bg-sunk font-semibold underline decoration-faint decoration-dotted underline-offset-[5px] hover:bg-line disabled:no-underline")}
    />
  );
}

// The name saves when you leave the field or press Enter, not on every key.
export function NameField({ st, look = "box" }: { st: Settings; look?: Look }) {
  const [text, setText] = useState(st.s.name);
  useEffect(() => setText(st.s.name), [st.s.name]);
  const commit = () => { const t = text.trim(); if (t && t !== st.s.name) st.set((d) => { d.name = t; }); else setText(st.s.name); };
  return (
    <input
      aria-label="Your name" value={text} spellCheck={false} autoComplete="off"
      onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setText(st.s.name); }}
      style={look === "inline" ? { width: `calc(${Math.max(3, text.length) * 0.9}ch + 14px)` } : undefined}
      className={look === "box" ? "h-9 w-[240px] max-w-full rounded-lg border border-line bg-surface px-3 text-[15.5px]" : "rounded-md bg-sunk px-1.5 font-semibold underline decoration-faint decoration-dotted underline-offset-[5px] hover:bg-line"}
    />
  );
}

// ---- roles: provider → model → effort, from what T3 has connected
export const providerOpts: Opt<ProviderId>[] = PROVIDER_IDS.map((id) => ({ id, label: T3_PROVIDERS[id].name, node: <ProviderName p={id} mark="size-4" className="gap-1.5" /> }));
export const modelOpts = (p: ProviderId): Opt<string>[] => T3_PROVIDERS[p].models.map((m) => ({ id: m, label: m }));
export const effortOpts = (p: ProviderId): Opt<Effort>[] => T3_PROVIDERS[p].efforts.map((e) => ({ id: e, label: EFFORT_LABEL[e] }));

// Each of the three keeps its width whatever is chosen, so changing the provider moves nothing.
export function RolePicks({ st, role }: { st: Settings; role: RoleId }) {
  const r = st.s.roles[role];
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Pick className="w-[152px]" label={`${role} provider`} value={r.provider} options={providerOpts} onChange={(provider) => st.setRole(role, { provider })} />
      <Pick className="w-[152px]" label={`${role} model`} value={r.model} options={modelOpts(r.provider)} onChange={(model) => st.setRole(role, { model })} />
      <Pick className="w-[132px]" label={`${role} effort`} value={r.effort} options={effortOpts(r.provider)} onChange={(effort) => st.setRole(role, { effort })} />
    </span>
  );
}

// ---- T3's own settings: shown here, changed there
export const openT3 = (where: string) => toast(`Would open T3 Code → Settings → ${where}`);
export function T3Button({ where, children, look = "box" }: { where: string; children: ReactNode; look?: Look }) {
  return (
    <button type="button" onClick={() => openT3(where)} className={look === "box" ? BTN : "inline-flex items-baseline gap-1 whitespace-nowrap font-semibold underline decoration-faint underline-offset-[5px] hover:decoration-ink"}>
      {children}<ExternalLink className={cn("shrink-0 text-faint", look === "box" ? "size-4" : "size-[0.8em] self-center")} />
    </button>
  );
}

export function SnoozeList() {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {[...T3_SNOOZE, "Snooze for…"].map((x) => <li key={x} className="rounded-md bg-sunk px-2 py-1 text-[15px] text-ink-2">{x}</li>)}
    </ul>
  );
}

// ---- display and sound choices, each shown as what it produces
function RadioDot({ on }: { on: boolean }) {
  return <span className={cn("mt-[3px] grid size-[18px] shrink-0 place-items-center rounded-full border-2", on ? "border-ink" : "border-faint")}>{on && <span className="size-2 rounded-full bg-ink" />}</span>;
}

export function DateChoices({ st, now, className }: { st: Settings; now: Date; className?: string }) {
  return (
    <div role="group" aria-label="Date style" className={cn("grid gap-2", className)}>
      {DATE_STYLES.map((d) => {
        const on = st.s.dateStyle === d.id;
        return (
          <button key={d.id} type="button" aria-pressed={on} onClick={() => !on && st.set((x) => { x.dateStyle = d.id; })}
            className={cn("flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left", on ? "border-ink ring-1 ring-ink" : "border-line hover:bg-sunk")}>
            <RadioDot on={on} />
            <span className="min-w-0">
              <span className="block font-medium">{fmtDate(now, d.id, st.timeFormat)}</span>
              <span className="block text-[14.5px] text-mute">{d.label} · in tight spots: {fmtDate(now, d.id, st.timeFormat, true)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function PlayButton({ st, className }: { st: Settings; className?: string }) {
  const id = st.s.notify.sound;
  return (
    <button type="button" disabled={id === "none"} onClick={() => play(id)} title="Play it" aria-label="Play the sound"
      className={cn("inline-grid size-7 place-items-center rounded-full border border-line bg-surface align-middle hover:bg-sunk disabled:opacity-40", className)}>
      <Play className="size-3.5 translate-x-px" />
    </button>
  );
}

export function SoundChoices({ st, disabled }: { st: Settings; disabled?: boolean }) {
  return (
    <div role="group" aria-label="Sound" className={cn("flex flex-wrap gap-2", disabled && "opacity-45")}>
      {SOUNDS.map((x) => {
        const on = st.s.notify.sound === x.id;
        return (
          <span key={x.id} className={cn("inline-flex h-9 items-center rounded-lg border", on ? "border-ink ring-1 ring-ink" : "border-line")}>
            <button type="button" aria-pressed={on} disabled={disabled} onClick={() => { play(x.id); if (!on) st.set((d) => { d.notify.sound = x.id; }); }}
              className={cn("h-full rounded-l-lg px-3 text-[15px] font-medium hover:bg-sunk disabled:cursor-not-allowed", x.id === "none" && "rounded-r-lg")}>
              {x.label}
            </button>
            {x.id !== "none" && (
              <button type="button" disabled={disabled} onClick={() => play(x.id)} aria-label={`Play ${x.label}`} title={`Play ${x.label}`}
                className="grid h-full w-8 place-items-center rounded-r-lg border-l border-line text-mute hover:bg-sunk hover:text-ink disabled:cursor-not-allowed">
                <Play className="size-3.5" />
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

// ---- when the last change was saved: the page has no Save button, so it says so
export function SavedNote({ st, className }: { st: Settings; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[14.5px] text-mute", className)} aria-live="polite">
      {st.savedAt ? <><Check className="size-4 text-ok" />Saved {clock(new Date(st.savedAt), st.timeFormat)}</> : "Changes save as you make them"}
    </span>
  );
}

// ---- repositories: removing asks first; adding makes a T3 project
const OVERLAY = "fixed inset-0 z-50 bg-black/35";
const DIALOG = "fixed left-1/2 top-1/2 z-50 w-[min(480px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-surface p-5 shadow-2xl";

export function RemoveRepo({ st, repo, children }: { st: Settings; repo: RepoRow; children: ReactNode }) {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>{children}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY} />
        <Dialog.Content className={DIALOG}>
          <Dialog.Title className="text-[18px] font-semibold">Remove {repo.name}?</Dialog.Title>
          <Dialog.Description asChild>
            <div className="mt-2 space-y-2 text-[15.5px] text-ink-2">
              <p>It leaves the runner and T3 Code: projects sync both ways, so it goes from T3's project list too.</p>
              <p>Nothing is deleted. The folder at <code className="font-mono text-[14.5px]">{repo.path}</code>{repo.github ? <> and everything on GitHub (<code className="font-mono text-[14.5px]">{repo.github}</code>)</> : null} stay as they are.</p>
              {repo.github && <p className="text-mute">To only stop the runner working on it, switch Served off instead.</p>}
            </div>
          </Dialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close className={BTN}>Cancel</Dialog.Close>
            <button type="button" className={cn(BTN, "border-bad/40 text-bad hover:bg-bad-soft")} onClick={() => { st.removeRepo(repo.name); toast(`${repo.name} removed from the runner and T3`); }}>Remove</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// A project without a GitHub remote is listed but can't be served: say so where it's listed.
export function NoRemote({ className }: { className?: string }) {
  return <Chip tone="warn" className={className} title="The runner works through GitHub issues and pull requests"><TriangleAlert className="size-3.5" />No GitHub remote</Chip>;
}

// Adding is choosing a folder on this PC, as T3's "Add project" does. In the app that's Windows'
// folder dialog; here it's the browser's, and the folder's .git/config is read for a GitHub remote.
// Where the browser has no folder dialog, two stand-in folders show the same flow.
interface Picked { name: string; github: string | null; path: string }
const STAND_INS: Picked[] = [
  { name: "blog-engine", github: "stefan1575/blog-engine", path: "~/Code/Personal/blog-engine" },
  { name: "tax-papers", github: null, path: "~/Documents/tax-papers" },
];
async function pickFolder(): Promise<Picked | "cancelled" | "no-dialog"> {
  const w = window as unknown as { showDirectoryPicker?: (o?: object) => Promise<FileSystemDirectoryHandle> };
  if (!w.showDirectoryPicker) return "no-dialog";
  try {
    const dir = await w.showDirectoryPicker({ mode: "read" });
    let github: string | null = null;
    try {
      const config = await (await (await (await dir.getDirectoryHandle(".git")).getFileHandle("config")).getFile()).text();
      github = config.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/m)?.[1] ?? null;
    } catch { /* not a git folder, or no remote */ }
    return { name: dir.name, github, path: `…/${dir.name}` };
  } catch (e) {
    return (e as DOMException).name === "AbortError" ? "cancelled" : "no-dialog";
  }
}

export function AddRepo({ st, className, children }: { st: Settings; className?: string; children?: ReactNode }) {
  const [standIn, setStandIn] = useState(false);
  const add = (p: Picked) => {
    setStandIn(false);
    if (st.s.repos.some((r) => r.name === p.name)) return void toast(`${p.name} is already listed`);
    st.addRepo(p);
    toast(`${p.name} added`, { description: p.github ? `Found ${p.github}. It's switched off until you serve it.` : "It has no GitHub remote, so it can't be served yet." });
  };
  const start = async () => { const p = await pickFolder(); if (p === "no-dialog") setStandIn(true); else if (p !== "cancelled") add(p); };
  return (
    <>
      <button type="button" onClick={start} className={className ?? BTN}>{children ?? <><FolderPlus className="size-4" />Add folder</>}</button>
      <Dialog.Root open={standIn} onOpenChange={setStandIn}>
        <Dialog.Portal>
          <Dialog.Overlay className={OVERLAY} />
          <Dialog.Content className={DIALOG}>
            <Dialog.Title className="text-[18px] font-semibold">Choose a folder</Dialog.Title>
            <Dialog.Description className="mt-2 text-[15px] text-mute">The app opens Windows' own folder dialog here. This browser can't, so pick a stand-in.</Dialog.Description>
            <div className="mt-4 space-y-2">
              {STAND_INS.map((p) => (
                <button key={p.name} type="button" onClick={() => add(p)} className="flex w-full items-center gap-3 rounded-lg border border-line px-3 py-2.5 text-left hover:bg-sunk">
                  <Folder className="size-5 shrink-0 text-faint" />
                  <span className="min-w-0 flex-1"><span className="block">{p.path}</span><span className="block text-[14px] text-mute">{p.github ? `GitHub remote: ${p.github}` : "No GitHub remote"}</span></span>
                </button>
              ))}
            </div>
            <div className="mt-5 flex justify-end"><Dialog.Close className={BTN}>Cancel</Dialog.Close></div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
