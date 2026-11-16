// PROTOTYPE (throwaway): Settings layout B, the one Stefan picked, second round. A list of
// categories stays put on the left while every section scrolls as one page on the right; the list
// follows the scroll and jumps on click. The search box narrows the page to the settings that match:
// it knows other words for a setting, what it's set to now (a model, a repo, a date) and forgives a
// typo. Controls sit in one column on the right and keep their width, so nothing shifts on a change.
// Type has three levels: the section's heading above its card, a setting's title, its description.
import { Bell, CalendarClock, FolderGit2, Inbox, Monitor, PieChart, Search, Trash2, User, Users, X, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ClaudeMark, OpenAIMark } from "@/components/Brand";
import { Chip } from "@/components/ui";
import { cn } from "@/lib/cn";
import { useUrl } from "@/lib/router";
import { AddRepo, DateChoices, NameField, NoRemote, NUDGE, Num, RemoveRepo, RolePicks, SavedNote, Seg, SnoozeList, SoundChoices, T3Button, Toggle } from "./controls";
import { DATE_STYLES, fmtDate, GH, isTwelve, releaseAt, RESETS, ROLES, SOUNDS, T3_SNOOZE, TIME_FORMATS } from "./model";
import { nudges, setParams, useNow, type Settings } from "./state";

export const name = "Categories and search";

type CatId = "you" | "roles" | "share" | "repos" | "display" | "inbox" | "notify" | "machine";
const CATS: { id: CatId; label: string; title?: string; icon: LucideIcon; about: string }[] = [
  { id: "you", label: "Name", icon: User, about: "What the runner calls you." },
  { id: "roles", label: "Roles", icon: Users, about: "Who does the work, from the providers T3 Code has connected." },
  { id: "share", label: "Your share", title: "Your share of each plan", icon: PieChart, about: "The part of each weekly window the runner leaves for you, whichever role uses that provider." },
  { id: "repos", label: "Repositories", icon: FolderGit2, about: "The same list as T3 Code's projects, kept in step both ways. The runner never touches one that isn't served." },
  { id: "display", label: "Display", icon: CalendarClock, about: "How dates and times are written." },
  { id: "inbox", label: "Inbox", icon: Inbox, about: "What the Inbox takes from T3 Code." },
  { id: "notify", label: "Notifications", icon: Bell, about: "When the app taps you on the shoulder." },
  { id: "machine", label: "Machine", icon: Monitor, about: "How the runner lives on this PC." },
];

// ---- search: other words for a setting, its current values, and one typo forgiven
const toks = (s: string) => s.toLowerCase().split(/[^a-z0-9%]+/).filter(Boolean);
function near(a: string, b: string, max: number) {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length] <= max;
}
const wordHit = (w: string, t: string) =>
  w.startsWith(t) || (t.length >= 3 && w.includes(t)) || (t.length >= 5 && w[0] === t[0] && (near(w, t, t.length >= 8 ? 2 : 1) || near(w.slice(0, t.length), t, 1)));
const matches = (words: string, q: string) => { const ws = toks(words); return toks(q).every((t) => ws.some((w) => wordHit(w, t))); };

// ---- one setting: what it is on the left, its control in a steady column on the right
function Line({ title, desc, children, below, dim }: { title: ReactNode; desc?: ReactNode; children?: ReactNode; below?: ReactNode; dim?: boolean }) {
  return (
    <div className="py-4">
      <div className="grid items-center gap-x-8 gap-y-2.5 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className={cn("min-w-0", dim && "opacity-55")}>
          <div className="flex flex-wrap items-center gap-2 text-[16px] font-medium">{title}</div>
          {desc && <div className="mt-0.5 max-w-[62ch] text-[14.5px] leading-snug text-mute">{desc}</div>}
        </div>
        {children && <div className="flex flex-wrap items-center gap-2 lg:justify-end">{children}</div>}
      </div>
      {below}
    </div>
  );
}

interface Row { id: string; cat: CatId; words: string; node: ReactNode }

function rows(st: Settings, now: Date): Row[] {
  const { s } = st;
  const tf = st.timeFormat;
  const anyNotify = s.notify.needsMe || s.notify.merges;
  const allDates = DATE_STYLES.map((d) => `${fmtDate(now, d.id, tf)} ${fmtDate(now, d.id, tf, true)} ${d.label}`).join(" ");
  const flip = (label: string, on: boolean, set: (v: boolean) => void) => <Toggle label={label} checked={on} onChange={set} />;

  return [
    { id: "name", cat: "you", words: `name you me call briefs github account user who ${s.name} ${GH.login}`,
      node: <Line title="Your name" desc={<>The runner uses it in the briefs it writes. From your GitHub account, {GH.login}.</>}><NameField st={st} /></Line> },

    ...ROLES.map((r): Row => {
      const role = s.roles[r.id];
      return {
        id: r.id, cat: "roles",
        words: `${r.label} ${r.verb} role provider model effort thinking reasoning agent ai claude anthropic chatgpt openai opus sonnet haiku fable gpt sol ${role.model} ${role.effort} ${r.id === "reviewer" ? "review pr pull request" : "build ticket fix decision conflict"}`,
        node: (
          <Line title={<>{r.label}{!role.chosen && <Chip tone="you">T3's default</Chip>}</>} desc={r.does}
            below={!role.chosen && (
              <div className={cn(NUDGE, "mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 text-[15px]")}>
                <span className="flex-1">Not your choice yet. Pick the model you want {r.id === "builder" ? "building" : "reviewing"}.</span>
                <button type="button" onClick={() => st.keepRole(r.id)} className="h-8 rounded-md bg-you px-2.5 font-medium text-white dark:text-page">Keep this</button>
              </div>
            )}>
            <RolePicks st={st} role={r.id} />
          </Line>
        ),
      };
    }),

    ...s.shares.map((x): Row => {
      const Mark = x.provider === "claude" ? ClaudeMark : OpenAIMark;
      const resets = fmtDate(RESETS[x.id], s.dateStyle, tf, true), released = fmtDate(releaseAt(x), s.dateStyle, tf, true);
      return {
        id: x.id, cat: "share",
        words: `${x.window} ${x.provider} share percent % ${x.percent}% keep kept reserve hold back budget usage limit quota week weekly window plan subscription reset resets release released hours ${resets} ${released} ${x.enforced ? "" : "coming soon later"}`,
        node: (
          <div className="grid items-center gap-x-8 gap-y-2.5 py-4 lg:grid-cols-[minmax(0,1fr)_124px_296px]">
            <div className={cn("min-w-0", !x.enforced && "opacity-55")}>
              <div className="flex flex-wrap items-center gap-2 text-[16px] font-medium"><Mark className="size-4" />{x.window}{!x.enforced && <Chip>Coming soon</Chip>}</div>
              <div className="mt-0.5 text-[14.5px] leading-snug text-mute">
                Resets {resets}.{x.enforced && (x.percent === 0 ? " Nothing is kept: the runner may use all of it." : ` The runner stops at ${100 - x.percent}% used, then may use the rest from ${released}.`)}
              </div>
            </div>
            <label className={cn("flex items-center gap-2 text-[15.5px]", !x.enforced && "opacity-55")}>Keep<Num label={`Percent of ${x.window} kept`} value={x.percent} disabled={!x.enforced} onChange={(percent) => st.setShare(x.id, { percent })} />%</label>
            <label className={cn("flex items-center gap-2 text-[15.5px]", (!x.enforced || x.percent === 0) && "opacity-55")}>until<Num label={`Hours before ${x.window} resets`} value={x.releaseHours} max={168} disabled={!x.enforced} onChange={(releaseHours) => st.setShare(x.id, { releaseHours })} />hours before the reset</label>
          </div>
        ),
      };
    }),

    ...s.repos.map((r): Row => ({
      id: `repo-${r.name}`, cat: "repos",
      words: `${r.name} ${r.github ?? "no github remote warning cannot"} ${r.path} repository repo project folder served serve on off merge merges who github t3 ${r.newFromT3 ? "new" : ""}`,
      node: (
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-2.5 py-4 lg:grid-cols-[minmax(0,1fr)_136px_244px_36px]">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-[16px] font-medium">{r.name}{r.newFromT3 && <Chip tone="you">New from T3</Chip>}{!r.github && <NoRemote />}</div>
            <div className="mt-0.5 truncate text-[14.5px] text-mute">{r.github ? `${r.github} · ${r.path}` : `${r.path} · can't be served until it has a GitHub remote`}</div>
          </div>
          <label className="flex items-center gap-2.5 text-[15px] text-ink-2">
            <Toggle label={`Serve ${r.name}`} checked={r.served} disabled={!r.github} onChange={(served) => st.setRepo(r.name, { served })} />
            <span className={cn(!r.github && "text-faint")}>{r.served ? "Served" : "Not served"}</span>
          </label>
          <Seg className="w-full" label={`Who merges ${r.name}`} value={r.merge} disabled={!r.served} onChange={(merge) => st.setRepo(r.name, { merge })} options={[{ id: "me", label: "I merge" }, { id: "runner", label: "Runner merges" }]} />
          <RemoveRepo st={st} repo={r}><button type="button" className="grid size-9 place-items-center rounded-lg text-faint hover:bg-sunk hover:text-ink" aria-label={`Remove ${r.name}`} title="Remove"><Trash2 className="size-4" /></button></RemoveRepo>
        </div>
      ),
    })),

    { id: "date", cat: "display", words: `date dates style format day month year weekday calendar today display ${allDates}`,
      node: <Line title="Date style" desc="How dates are written across the app, shown on the time right now." below={<DateChoices st={st} now={now} className="mt-3 sm:grid-cols-2" />} /> },
    { id: "clock", cat: "display", words: "clock time format 12 24 hour am pm t3 timestamp",
      node: <Line title="Clock" desc={<>{isTwelve(tf) ? "12-hour" : "24-hour"}, because T3 Code's Time format is set to {TIME_FORMATS.find((f) => f.id === tf)?.label}. Both apps read the same.</>}><T3Button where="General → Time format">Change in T3</T3Button></Line> },

    { id: "snooze", cat: "inbox", words: `snooze inbox later remind postpone hide t3 threads ${T3_SNOOZE.join(" ")}`,
      node: <Line title="Snooze choices" desc="Exactly T3 Code's Snooze options. Snoozing here snoozes the thread there, and the other way round." below={<div className="mt-3"><SnoozeList /></div>}><T3Button where="Threads → Snooze options">Change in T3</T3Button></Line> },

    { id: "needs", cat: "notify", words: "notify notification notifications alert toast ping popup ask answer needs me attention stop",
      node: <Line title="Notify me when something needs me" desc={'An ask, a stop filed for you, or an "Answer:" thread.'}>{flip("Notify me when something needs me", s.notify.needsMe, (v) => st.set((d) => { d.notify.needsMe = v; }))}</Line> },
    { id: "merges", cat: "notify", words: "notify notification notifications alert merge merges merged ready pull request pr",
      node: <Line title="Also when a pull request merges or is ready to merge">{flip("Notify me on merges", s.notify.merges, (v) => st.set((d) => { d.notify.merges = v; }))}</Line> },
    { id: "sound", cat: "notify", words: `sound sounds audio noise volume silent mute quiet none play ding ${SOUNDS.map((x) => x.label).join(" ")}`,
      node: <Line title="Sound" desc="Made for the app. Click one to hear it." dim={!anyNotify}><SoundChoices st={st} disabled={!anyNotify} /></Line> },

    { id: "startup", cat: "machine", words: "start startup windows boot login logon sign in tray autostart launch open",
      node: <Line title="Start with Windows" desc="The runner starts in the tray when you sign in.">{flip("Start with Windows", s.machine.startWithWindows, (v) => st.set((d) => { d.machine.startWithWindows = v; }))}</Line> },
    { id: "wake", cat: "machine", words: "wake sleep pc computer power scheduled schedule overnight job night",
      node: <Line title="Let the runner wake this PC" desc="For a job scheduled after a wait, such as a usage reset overnight.">{flip("Let the runner wake this PC", s.machine.wakePc, (v) => st.set((d) => { d.machine.wakePc = v; }))}</Line> },
  ];
}

const TOP = 76; // the app's top bar plus a little air: where a section lands and the list sticks

export function VariantB({ st }: { st: Settings }) {
  const { params } = useUrl();
  const now = useNow();
  const raw = params.get("q") ?? "";
  const q = raw.trim();
  const all = rows(st, now);
  const shown = q ? all.filter((r) => matches(r.words, q)) : all;
  const n = nudges(st.s);
  const wants: Partial<Record<CatId, number>> = { roles: n.roles.length, repos: n.newRepos.length + (n.noneServed ? 1 : 0) };
  const count = (c: CatId) => shown.filter((r) => r.cat === c).length;
  const box = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState<CatId>("you");
  const held = useRef(0); // a click on the list wins over the scroll for a moment

  // The list follows the page: the current category is the last one whose card reached the top.
  useEffect(() => {
    const onScroll = () => {
      if (Date.now() < held.current) return;
      let cur: CatId = "you";
      for (const c of CATS) { const el = document.getElementById(`cat-${c.id}`); if (el && el.getBoundingClientRect().top <= TOP + 40) cur = c.id; }
      setActive(cur);
    };
    onScroll();
    addEventListener("scroll", onScroll, { passive: true });
    return () => removeEventListener("scroll", onScroll);
  }, [q]);

  // "/" jumps to the search box, as in T3 and VS Code.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || (e.target as HTMLElement | null)?.closest("input, textarea, [contenteditable]")) return;
      e.preventDefault(); box.current?.focus();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const jump = (id: CatId) => {
    if (q) setParams({ q: null });
    held.current = Date.now() + 700;
    setActive(id);
    setTimeout(() => document.getElementById(`cat-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), q ? 40 : 0);
  };

  return (
    <div className="grid gap-x-8 gap-y-4 md:grid-cols-[232px_minmax(0,1fr)]">
      <aside className="md:sticky md:self-start" style={{ top: TOP }}>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <input ref={box} value={raw} onChange={(e) => setParams({ q: e.target.value || null })} onKeyDown={(e) => { if (e.key === "Escape") { setParams({ q: null }); e.currentTarget.blur(); } }}
            placeholder="Search settings" aria-label="Search settings" className="h-10 w-full rounded-lg border border-line bg-surface pl-9 pr-9 text-[15.5px] placeholder:text-faint" />
          {q ? <button type="button" onClick={() => { setParams({ q: null }); box.current?.focus(); }} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-faint hover:text-ink" aria-label="Clear search"><X className="size-4" /></button>
            : <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-line px-1.5 font-mono text-[12.5px] text-faint">/</kbd>}
        </div>
        <nav aria-label="Settings categories" className="mt-3 flex flex-wrap gap-0.5 md:flex-col">
          {CATS.map((c) => {
            const hits = count(c.id), on = !q && c.id === active;
            return (
              <button key={c.id} type="button" aria-current={on ? "true" : undefined} onClick={() => jump(c.id)}
                className={cn("flex h-10 items-center gap-2.5 rounded-lg px-3 text-left text-[15.5px]", on ? "bg-surface font-medium text-ink shadow-sm ring-1 ring-line" : "text-ink-2 hover:bg-sunk", q && !hits && "opacity-40")}>
                <c.icon className={cn("size-[17px]", on ? "text-ink" : "text-faint")} />
                <span className="flex-1">{c.label}</span>
                {q ? hits > 0 && <span className="text-[13.5px] tabular-nums text-mute">{hits}</span>
                  : !!wants[c.id] && <span className="min-w-5 rounded-full bg-you px-1.5 text-center text-[13px] font-semibold text-white dark:text-page" title="Wants a choice">{wants[c.id]}</span>}
              </button>
            );
          })}
        </nav>
        <SavedNote st={st} className="mt-4 px-3" />
      </aside>

      <div className="min-w-0 space-y-5">
        {q && (
          <div className="flex items-baseline gap-3 px-1 text-[15.5px]">
            <span><b className="font-semibold">{shown.length}</b> {shown.length === 1 ? "setting matches" : "settings match"} "{q}"</span>
            <button type="button" onClick={() => setParams({ q: null })} className="text-mute underline decoration-faint underline-offset-4 hover:text-ink">Show all</button>
          </div>
        )}
        {q && shown.length === 0 && (
          <div className="rounded-xl border border-line bg-surface px-6 py-8 text-mute">Nothing matches. Try what a setting does or what it's set to: "merge", "opus", "sound", "sleep", a repository's name, or a date like "nov 19".</div>
        )}

        {CATS.filter((c) => count(c.id) > 0).map((c) => (
          <section key={c.id} id={`cat-${c.id}`} aria-label={c.title ?? c.label} className="pb-5" style={{ scrollMarginTop: TOP }}>
            <header className="flex items-end gap-4 px-1 pb-3">
              <div className="min-w-0 flex-1">
                <h2 className="text-[23px] font-semibold leading-tight tracking-[-0.015em]">{c.title ?? c.label}</h2>
                <p className="mt-1 text-[15px] text-mute">{c.about}</p>
              </div>
              {c.id === "repos" && <AddRepo st={st} />}
            </header>
            {c.id === "repos" && !q && n.noneServed && <div className={cn(NUDGE, "mb-3 px-3 py-2 text-[15px]")}>The runner isn't serving any repository yet, so it has nothing to do. Switch on the ones it should work on.</div>}
            <div className="divide-y divide-line-2 rounded-xl border border-line bg-surface px-6">
              {shown.filter((r) => r.cat === c.id).map((r) => <div key={r.id}>{r.node}</div>)}
            </div>
          </section>
        ))}

        {/* Room below so the last short sections can reach the top when jumped to. */}
        {!q && <div className="h-[40vh]" aria-hidden />}
      </div>
    </div>
  );
}
