// PROTOTYPE (throwaway), ROUND 1: this file as it was before Stefan's feedback of 2026-11-16, kept so
// the two rounds can be compared from the bar. The current one is one folder up.
// PROTOTYPE (throwaway): Settings layout B, categories and search, like T3's or VS Code's settings.
// A list of categories on the left, one category at a time on the right, each setting stacked as
// title, a line about it, then its control. The search box finds a setting in any category.
import { Bell, CalendarClock, FolderGit2, Inbox, Monitor, PieChart, Plus, Search, User, Users, X, type LucideIcon } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { ClaudeMark, OpenAIMark } from "@/components/Brand";
import { Chip } from "@/components/ui";
import { cn } from "@/lib/cn";
import { useUrl } from "@/lib/router";
import { AddRepo, BTN, DateChoices, NameField, NUDGE, Num, RemoveRepo, RolePicks, SavedNote, Seg, SnoozeList, SoundChoices, T3Button, Toggle } from "./controls";
import { fmtDate, GH, isTwelve, releaseAt, RESETS, ROLES, TIME_FORMATS } from "../model";
import { nudges, setParams, useNow, type Settings } from "../state";

export const name = "Categories and search";

type CatId = "you" | "roles" | "share" | "repos" | "display" | "inbox" | "notify" | "machine";
const CATS: { id: CatId; label: string; icon: LucideIcon; about: string }[] = [
  { id: "you", label: "You", icon: User, about: "Who the runner works for." },
  { id: "roles", label: "Roles", icon: Users, about: "Who does the work, from the providers T3 Code has connected." },
  { id: "share", label: "Your share", icon: PieChart, about: "The part of each weekly window the runner leaves for you, whichever role uses that provider." },
  { id: "repos", label: "Repositories", icon: FolderGit2, about: "The same list as T3 Code's projects, kept in step both ways. Not served means the runner never touches it." },
  { id: "display", label: "Display", icon: CalendarClock, about: "How dates and times are written." },
  { id: "inbox", label: "Inbox", icon: Inbox, about: "What the Inbox borrows from T3 Code." },
  { id: "notify", label: "Notifications", icon: Bell, about: "When the app taps you on the shoulder." },
  { id: "machine", label: "Machine", icon: Monitor, about: "How the runner lives on this PC." },
];

interface Item { id: string; cat: CatId; title: ReactNode; words: string; desc?: ReactNode; body: ReactNode; dim?: boolean }

// A switch reads as a sentence beside it, the way VS Code's checkboxes do.
function OnOff({ on, set, label, children }: { on: boolean; set: (v: boolean) => void; label: string; children: ReactNode }) {
  return <label className="flex items-start gap-3"><Toggle label={label} checked={on} onChange={set} /><span className="text-ink-2">{children}</span></label>;
}

function items(st: Settings, now: Date): Item[] {
  const { s } = st;
  const anyNotify = s.notify.needsMe || s.notify.merges;
  return [
    { id: "name", cat: "you", title: "Your name", words: "name briefs github you", desc: <>The runner uses it in the briefs it writes. From your GitHub account, {GH.login}.</>, body: <NameField st={st} /> },

    ...ROLES.map((r): Item => ({
      id: r.id, cat: "roles", title: <>{r.label}{!s.roles[r.id].chosen && <Chip tone="you">T3's default</Chip>}</>, words: `${r.label} role provider model effort claude chatgpt opus sol ${s.roles[r.id].model}`, desc: r.does,
      body: (
        <div className="space-y-2.5">
          <RolePicks st={st} role={r.id} />
          {!s.roles[r.id].chosen && (
            <div className={cn(NUDGE, "flex max-w-[560px] flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 text-[15px]")}>
              <span className="flex-1">Not your choice yet. Pick the model you want {r.id === "builder" ? "building" : "reviewing"}.</span>
              <button type="button" onClick={() => st.keepRole(r.id)} className="h-8 rounded-md bg-you px-2.5 font-medium text-white dark:text-page">Keep this</button>
            </div>
          )}
        </div>
      ),
    })),

    ...s.shares.map((x): Item => {
      const Mark = x.provider === "claude" ? ClaudeMark : OpenAIMark;
      return {
        id: x.id, cat: "share", dim: !x.enforced, words: `${x.window} share percent keep kept reserve release hours reset plan week`,
        title: <><Mark className="size-4" />{x.window}{!x.enforced && <Chip>Coming soon</Chip>}</>,
        desc: <>Resets {fmtDate(RESETS[x.id], s.dateStyle, st.timeFormat, true)}.{x.enforced && (x.percent === 0 ? " Nothing is kept: the runner may use all of it." : ` The runner stops at ${100 - x.percent}% used, then may use the rest from ${fmtDate(releaseAt(x), s.dateStyle, st.timeFormat, true)}.`)}</>,
        body: (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[15.5px]">
            <label className="flex items-center gap-2">Keep<Num label={`Percent of ${x.window} kept`} value={x.percent} disabled={!x.enforced} onChange={(percent) => st.setShare(x.id, { percent })} />% for me</label>
            <label className={cn("flex items-center gap-2", x.enforced && x.percent === 0 && "opacity-55")}>until<Num label={`Hours before ${x.window} resets`} value={x.releaseHours} max={168} disabled={!x.enforced} onChange={(releaseHours) => st.setShare(x.id, { releaseHours })} />hours before the reset</label>
          </div>
        ),
      };
    }),

    ...s.repos.map((r): Item => ({
      id: `repo-${r.name}`, cat: "repos", words: `${r.name} ${r.github ?? "no remote"} repository repo served merge project`,
      title: <>{r.name}{r.newFromT3 && <Chip tone="you">New from T3</Chip>}</>,
      desc: <>{r.github ?? "No GitHub remote, so it can't be served"} · {r.path}</>,
      body: (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <label className="flex items-center gap-2 text-[15px] text-ink-2">
            <Toggle label={`Serve ${r.name}`} checked={r.served} disabled={!r.github} onChange={(served) => st.setRepo(r.name, { served })} />
            <span className="w-[74px]">{r.served ? "Served" : "Not served"}</span>
          </label>
          <Seg label={`Who merges ${r.name}`} value={r.merge} disabled={!r.served} onChange={(merge) => st.setRepo(r.name, { merge })} options={[{ id: "me", label: "I merge" }, { id: "runner", label: "Runner merges" }]} />
          <RemoveRepo st={st} repo={r}><button type="button" className="h-9 rounded-lg px-2 text-[15px] text-mute hover:bg-sunk hover:text-ink">Remove…</button></RemoveRepo>
        </div>
      ),
    })),

    { id: "date", cat: "display", title: "Date style", words: "date style format month weekday iso display", desc: "How dates are written across the app, shown on the time right now.", body: <DateChoices st={st} now={now} className="max-w-[520px]" /> },
    { id: "clock", cat: "display", title: "Clock", words: "clock time format 12 24 hour t3", desc: <>{isTwelve(st.timeFormat) ? "12-hour" : "24-hour"}, because T3 Code's Time format is set to {TIME_FORMATS.find((f) => f.id === st.timeFormat)?.label}. Both apps read the same.</>, body: <T3Button where="General → Time format">Change in T3</T3Button> },

    { id: "snooze", cat: "inbox", title: "Snooze choices", words: "snooze inbox t3 threads", desc: "Exactly T3 Code's Snooze options. Snoozing here snoozes the thread there, and the other way round.", body: <div className="space-y-3"><SnoozeList /><T3Button where="Threads → Snooze options">Change in T3</T3Button></div> },

    { id: "needs", cat: "notify", title: "When something needs me", words: "notify notification ask answer needs me", body: <OnOff label="Notify me when something needs me" on={s.notify.needsMe} set={(v) => st.set((d) => { d.notify.needsMe = v; })}>Notify me about an ask, a stop filed for me, or an "Answer:" thread.</OnOff> },
    { id: "merges", cat: "notify", title: "Merges", words: "notify notification merge merged ready pull request pr", body: <OnOff label="Notify me on merges" on={s.notify.merges} set={(v) => st.set((d) => { d.notify.merges = v; })}>Also notify me when a pull request merges or is ready to merge.</OnOff> },
    { id: "sound", cat: "notify", title: "Sound", words: "sound chime knock drop silent none play", desc: "Made for the app. Click one to hear it.", dim: !anyNotify, body: <SoundChoices st={st} disabled={!anyNotify} /> },

    { id: "startup", cat: "machine", title: "Start with Windows", words: "start startup windows boot tray logon", body: <OnOff label="Start with Windows" on={s.machine.startWithWindows} set={(v) => st.set((d) => { d.machine.startWithWindows = v; })}>Start the runner in the tray when I sign in.</OnOff> },
    { id: "wake", cat: "machine", title: "Wake this PC", words: "wake sleep pc scheduled job", body: <OnOff label="Let the runner wake this PC" on={s.machine.wakePc} set={(v) => st.set((d) => { d.machine.wakePc = v; })}>Let the runner wake this PC for a job scheduled after a wait, such as a usage reset overnight.</OnOff> },
  ];
}

function ItemBlock({ it }: { it: Item }) {
  return (
    <div className="py-4">
      <div className={cn(it.dim && "opacity-55")}>
        <div className="flex flex-wrap items-center gap-2 font-semibold">{it.title}</div>
        {it.desc && <div className="mt-0.5 text-[15px] text-mute">{it.desc}</div>}
      </div>
      <div className="mt-2.5">{it.body}</div>
    </div>
  );
}

export function VariantB({ st }: { st: Settings }) {
  const { params } = useUrl();
  const now = useNow();
  const q = (params.get("q") ?? "").trim().toLowerCase();
  const cat = CATS.find((c) => c.id === params.get("section")) ?? CATS[0];
  const all = items(st, now);
  const n = nudges(st.s);
  const wants: Partial<Record<CatId, number>> = { roles: n.roles.length, repos: n.newRepos.length + (n.noneServed ? 1 : 0) };
  const hits = q ? all.filter((it) => q.split(/\s+/).every((w) => it.words.toLowerCase().includes(w))) : [];
  const box = useRef<HTMLInputElement>(null);

  // "/" jumps to the search box, as in T3 and VS Code.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || (e.target as HTMLElement | null)?.closest("input, textarea, [contenteditable]")) return;
      e.preventDefault(); box.current?.focus();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="grid max-w-[1040px] gap-x-8 gap-y-4 md:grid-cols-[224px_minmax(0,1fr)]">
      <aside className="md:sticky md:top-[76px] md:self-start">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <input ref={box} value={params.get("q") ?? ""} onChange={(e) => setParams({ q: e.target.value || null })} onKeyDown={(e) => { if (e.key === "Escape") setParams({ q: null }); }}
            placeholder="Search settings" aria-label="Search settings" className="h-9 w-full rounded-lg border border-line bg-surface pl-8 pr-8 text-[15.5px] placeholder:text-faint" />
          {q ? <button type="button" onClick={() => setParams({ q: null })} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-faint hover:text-ink" aria-label="Clear search"><X className="size-4" /></button>
            : <kbd className="absolute right-2 top-1/2 -translate-y-1/2 rounded border border-line px-1.5 font-mono text-[12.5px] text-faint">/</kbd>}
        </div>
        <nav aria-label="Settings categories" className="mt-3 flex flex-wrap gap-0.5 md:flex-col">
          {CATS.map((c) => {
            const on = !q && c.id === cat.id;
            return (
              <button key={c.id} type="button" aria-current={on ? "page" : undefined} onClick={() => setParams({ section: c.id, q: null })}
                className={cn("flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-left text-[15.5px] font-medium", on ? "bg-surface text-ink shadow-sm ring-1 ring-line" : "text-ink-2 hover:bg-sunk")}>
                <c.icon className={cn("size-4", on ? "text-ink" : "text-faint")} />
                <span className="flex-1">{c.label}</span>
                {!!wants[c.id] && <span className="min-w-5 rounded-full bg-you px-1.5 text-center text-[13px] font-semibold text-white dark:text-page" title="Wants a choice">{wants[c.id]}</span>}
              </button>
            );
          })}
        </nav>
        <SavedNote st={st} className="mt-4 px-2.5" />
      </aside>

      <div className="min-w-0 rounded-lg border border-line bg-surface px-5 pb-2 pt-4">
        {q ? (
          <>
            <h2 className="text-[18px] font-semibold">{hits.length} {hits.length === 1 ? "setting" : "settings"} for "{params.get("q")?.trim()}"</h2>
            {hits.length === 0 && <p className="py-6 text-mute">Nothing matches. Try a repository's name, "sound", "merge" or "effort".</p>}
            <div className="divide-y divide-line-2">
              {hits.map((it) => (
                <div key={it.id}>
                  <button type="button" onClick={() => setParams({ section: it.cat, q: null })} className="mt-3 text-[13.5px] font-semibold uppercase tracking-[0.06em] text-faint hover:text-ink">{CATS.find((c) => c.id === it.cat)?.label}</button>
                  <div className="-mt-3"><ItemBlock it={it} /></div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="text-[18px] font-semibold">{cat.id === "share" ? "Your share of each plan" : cat.label}</h2>
                <p className="text-[15px] text-mute">{cat.about}</p>
              </div>
              {cat.id === "repos" && <AddRepo st={st}><button type="button" className={BTN}><Plus className="size-4" />Add</button></AddRepo>}
            </div>
            {cat.id === "repos" && n.noneServed && <div className={cn(NUDGE, "mt-3 px-3 py-2 text-[15px]")}>The runner isn't serving any repository yet, so it has nothing to do. Switch on the ones it should work on.</div>}
            <div className="mt-1 divide-y divide-line-2">
              {all.filter((it) => it.cat === cat.id).map((it) => <ItemBlock key={it.id} it={it} />)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
