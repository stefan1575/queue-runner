// PROTOTYPE (throwaway): Settings layout B, round 3: T3 Code's own settings, copied. Stefan asked
// for it on 2026-11-16, since the runner ships as a desktop app beside T3.
//
// What is T3's (read from T3 Code 0.1.9's settings bundle, sized up about 1.15x to the scale Stefan
// runs T3 at): Settings opens over the app as its own window with a close button; a list of pages
// on the left with Search and "/" on top; a "Settings / Page" header; one page at a time; each
// setting is a row in a bordered card, medium-weight title over a smaller grey line, its control
// on the right; Inter; T3's greys and blue (the skin in index.css). No subtitles under headings.
//
// What is ours: the eight pages and their settings (#36), the blue counts for what wants a choice,
// and the search matching other words, current values and a typo. Search results show every
// matching setting under its page's name.
import { Bell, CalendarClock, FolderGit2, Inbox, Monitor, PieChart, Search, Trash2, User, Users, X, type LucideIcon } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { ClaudeMark, OpenAIMark } from "@/components/Brand";
import { Chip } from "@/components/ui";
import { cn } from "@/lib/cn";
import { navigate, useUrl } from "@/lib/router";
import { AddRepo, NameField, NoRemote, NUDGE, Num, Pick, RemoveRepo, RolePicks, SavedNote, SoundChoices, T3Button, Toggle } from "./controls";
import { DATE_STYLES, fmtDate, GH, isTwelve, releaseAt, RESETS, ROLES, SOUNDS, T3_SNOOZE, TIME_FORMATS } from "./model";
import { nudges, setParams, useNow, type Settings } from "./state";

export const name = "Categories and search";

type CatId = "you" | "roles" | "share" | "repos" | "display" | "inbox" | "notify" | "machine";
const CATS: { id: CatId; label: string; icon: LucideIcon }[] = [
  { id: "you", label: "Name", icon: User },
  { id: "roles", label: "Roles", icon: Users },
  { id: "share", label: "Your share", icon: PieChart },
  { id: "repos", label: "Repositories", icon: FolderGit2 },
  { id: "display", label: "Display", icon: CalendarClock },
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "notify", label: "Notifications", icon: Bell },
  { id: "machine", label: "Machine", icon: Monitor },
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

// ---- T3's settings row: title over a grey line on the left, the control on the right
function Row({ title, desc, children, below, dim }: { title: ReactNode; desc?: ReactNode; children?: ReactNode; below?: ReactNode; dim?: boolean }) {
  return (
    <div className="px-5 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-2.5 lg:flex-nowrap">
        <div className={cn("min-w-0", dim && "opacity-55")}>
          <div className="flex flex-wrap items-center gap-2 text-[16px] font-medium leading-snug">{title}</div>
          {desc && <div className="mt-1 max-w-[72ch] text-pretty text-[14px] leading-normal text-mute">{desc}</div>}
        </div>
        {children && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{children}</div>}
      </div>
      {below}
    </div>
  );
}
const Card = ({ children }: { children: ReactNode }) => <div className="divide-y divide-line-2 rounded-xl border border-line-2 bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]">{children}</div>;

interface Item { id: string; cat: CatId; words: string; node: ReactNode }

function items(st: Settings, now: Date): Item[] {
  const { s } = st;
  const tf = st.timeFormat;
  const anyNotify = s.notify.needsMe || s.notify.merges;
  const dateOpts = DATE_STYLES.map((d) => ({ id: d.id, label: fmtDate(now, d.id, tf), hint: d.label }));
  const allDates = DATE_STYLES.map((d) => `${fmtDate(now, d.id, tf)} ${fmtDate(now, d.id, tf, true)} ${d.label}`).join(" ");
  const flip = (label: string, on: boolean, set: (v: boolean) => void) => <Toggle label={label} checked={on} onChange={set} />;

  return [
    { id: "name", cat: "you", words: `name you me call briefs github account user who ${s.name} ${GH.login}`,
      node: <Row title="Your name" desc={<>The runner uses it in the briefs it writes. From your GitHub account, {GH.login}.</>}><NameField st={st} /></Row> },

    ...ROLES.map((r): Item => {
      const role = s.roles[r.id];
      return {
        id: r.id, cat: "roles",
        words: `${r.label} ${r.verb} role provider model effort thinking reasoning agent ai claude anthropic chatgpt openai opus sonnet haiku fable gpt sol ${role.model} ${role.effort} ${r.id === "reviewer" ? "review pr pull request" : "build ticket fix decision conflict"}`,
        node: (
          <Row title={<>{r.label}{!role.chosen && <Chip tone="you">T3's default</Chip>}</>} desc={r.does}
            below={!role.chosen && (
              <div className={cn(NUDGE, "mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 text-[14.5px]")}>
                <span className="flex-1">Not your choice yet. Pick the model you want {r.id === "builder" ? "building" : "reviewing"}.</span>
                <button type="button" onClick={() => st.keepRole(r.id)} className="h-8 rounded-md bg-on px-2.5 font-medium text-white">Keep this</button>
              </div>
            )}>
            <RolePicks st={st} role={r.id} />
          </Row>
        ),
      };
    }),

    ...s.shares.map((x): Item => {
      const Mark = x.provider === "claude" ? ClaudeMark : OpenAIMark;
      const resets = fmtDate(RESETS[x.id], s.dateStyle, tf, true), released = fmtDate(releaseAt(x), s.dateStyle, tf, true);
      return {
        id: x.id, cat: "share",
        words: `${x.window} ${x.provider} share percent % ${x.percent}% keep kept reserve hold back budget usage limit quota week weekly window plan subscription reset resets release released hours ${resets} ${released} ${x.enforced ? "" : "coming soon later"}`,
        node: (
          <Row dim={!x.enforced} title={<><Mark className="size-4" />{x.window}{!x.enforced && <Chip>Coming soon</Chip>}</>}
            desc={<>Resets {resets}.{x.enforced && (x.percent === 0 ? " Nothing is kept: the runner may use all of it." : ` The runner stops at ${100 - x.percent}% used, then may use the rest from ${released}.`)}</>}>
            <span className={cn("flex items-center gap-2 text-[15px]", !x.enforced && "opacity-55")}>
              Keep<Num label={`Percent of ${x.window} kept`} value={x.percent} disabled={!x.enforced} onChange={(percent) => st.setShare(x.id, { percent })} />%
              <span className={cn("flex items-center gap-2 pl-2", x.enforced && x.percent === 0 && "opacity-55")}>until<Num label={`Hours before ${x.window} resets`} value={x.releaseHours} max={168} disabled={!x.enforced} onChange={(releaseHours) => st.setShare(x.id, { releaseHours })} />hours before the reset</span>
            </span>
          </Row>
        ),
      };
    }),

    ...s.repos.map((r): Item => ({
      id: `repo-${r.name}`, cat: "repos",
      words: `${r.name} ${r.github ?? "no github remote warning cannot"} ${r.path} repository repo project folder served serve on off merge merges who github t3 ${r.newFromT3 ? "new" : ""}`,
      node: (
        <Row title={<>{r.name}{r.newFromT3 && <Chip tone="you">New from T3</Chip>}{!r.github && <NoRemote />}</>}
          desc={r.github ? `${r.github} · ${r.path}` : `${r.path} · can't be served until it has a GitHub remote`}>
          <Pick className="w-[172px]" label={`Who merges ${r.name}`} value={r.merge} disabled={!r.served} onChange={(merge) => st.setRepo(r.name, { merge })} options={[{ id: "me", label: "I merge" }, { id: "runner", label: "Runner merges" }]} />
          <span className="grid w-[60px] place-items-center" title={r.served ? "Served" : r.github ? "Not served" : "Can't be served"}><Toggle label={`Serve ${r.name}`} checked={r.served} disabled={!r.github} onChange={(served) => st.setRepo(r.name, { served })} /></span>
          <RemoveRepo st={st} repo={r}><button type="button" className="grid size-9 place-items-center rounded-lg text-faint hover:bg-sunk hover:text-ink" aria-label={`Remove ${r.name}`} title="Remove"><Trash2 className="size-4" /></button></RemoveRepo>
        </Row>
      ),
    })),

    { id: "date", cat: "display", words: `date dates style format day month year weekday calendar today display ${allDates}`,
      node: <Row title="Date style" desc={<>How dates are written across the app. In tight spots: {fmtDate(now, s.dateStyle, tf, true)}.</>}><Pick className="w-[318px]" label="Date style" value={s.dateStyle} options={dateOpts} onChange={(v) => st.set((d) => { d.dateStyle = v; })} /></Row> },
    { id: "clock", cat: "display", words: "clock time format 12 24 hour am pm t3 timestamp",
      node: <Row title="Clock" desc={<>{isTwelve(tf) ? "12-hour" : "24-hour"}, because T3 Code's Time format is set to {TIME_FORMATS.find((f) => f.id === tf)?.label}. Both apps read the same.</>}><T3Button where="General → Time format">Change in T3</T3Button></Row> },

    { id: "snooze", cat: "inbox", words: `snooze inbox later remind postpone hide t3 threads ${T3_SNOOZE.join(" ")}`,
      node: <Row title="Snooze choices" desc={<>Exactly T3 Code's Snooze options: {T3_SNOOZE.join(", ")}, and Snooze for…. Snoozing here snoozes the thread there, and the other way round.</>}><T3Button where="Threads → Snooze options">Change in T3</T3Button></Row> },

    { id: "needs", cat: "notify", words: "notify notification notifications alert toast ping popup ask answer needs me attention stop",
      node: <Row title="Notify me when something needs me" desc={'An ask, a stop filed for you, or an "Answer:" thread.'}>{flip("Notify me when something needs me", s.notify.needsMe, (v) => st.set((d) => { d.notify.needsMe = v; }))}</Row> },
    { id: "merges", cat: "notify", words: "notify notification notifications alert merge merges merged ready pull request pr",
      node: <Row title="Merge notifications" desc="Also notify me when a pull request merges or is ready to merge.">{flip("Notify me on merges", s.notify.merges, (v) => st.set((d) => { d.notify.merges = v; }))}</Row> },
    { id: "sound", cat: "notify", words: `sound sounds audio noise volume silent mute quiet none play ding ${SOUNDS.map((x) => x.label).join(" ")}`,
      node: <Row title="Sound" desc="Made for the app. Click one to hear it." dim={!anyNotify}><SoundChoices st={st} disabled={!anyNotify} /></Row> },

    { id: "startup", cat: "machine", words: "start startup windows boot login logon sign in tray autostart launch open",
      node: <Row title="Start with Windows" desc="The runner starts in the tray when you sign in.">{flip("Start with Windows", s.machine.startWithWindows, (v) => st.set((d) => { d.machine.startWithWindows = v; }))}</Row> },
    { id: "wake", cat: "machine", words: "wake sleep pc computer power scheduled schedule overnight job night",
      node: <Row title="Wake this PC" desc="Let the runner wake this PC for a job scheduled after a wait, such as a usage reset overnight.">{flip("Let the runner wake this PC", s.machine.wakePc, (v) => st.set((d) => { d.machine.wakePc = v; }))}</Row> },
  ];
}

export function VariantB({ st }: { st: Settings }) {
  const { params } = useUrl();
  const now = useNow();
  const raw = params.get("q") ?? "";
  const q = raw.trim();
  const cat = CATS.find((c) => c.id === params.get("section")) ?? CATS[0];
  const all = items(st, now);
  const hits = q ? all.filter((r) => matches(r.words, q)) : [];
  const n = nudges(st.s);
  const wants: Partial<Record<CatId, number>> = { roles: n.roles.length, repos: n.newRepos.length + (n.noneServed ? 1 : 0) };
  const box = useRef<HTMLInputElement>(null);
  const pane = useRef<HTMLDivElement>(null);

  // T3's colours and type, for as long as this window is open.
  useEffect(() => {
    document.documentElement.classList.add("t3-skin");
    return () => document.documentElement.classList.remove("t3-skin");
  }, []);
  useEffect(() => { pane.current?.scrollTo({ top: 0 }); }, [cat.id, q]);

  // "/" jumps to the search box, as in T3.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || (e.target as HTMLElement | null)?.closest("input, textarea, [contenteditable]")) return;
      e.preventDefault(); box.current?.focus();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="fixed inset-0 z-[36] bg-black/55 px-3 pb-[78px] pt-3 sm:px-[5vw] sm:pt-[4vh]">
      <div role="region" aria-label="Settings" className="mx-auto flex h-full w-full max-w-[1560px] overflow-hidden rounded-2xl border border-line-2 bg-page shadow-2xl">
        <aside className="flex w-[272px] shrink-0 flex-col border-r border-line-2 bg-side max-md:w-[58px]">
          <label className="flex h-[54px] shrink-0 items-center gap-2.5 px-5 max-md:justify-center max-md:px-0">
            <Search className="size-[18px] shrink-0 text-mute" />
            <input ref={box} value={raw} onChange={(e) => setParams({ q: e.target.value || null })} onKeyDown={(e) => { if (e.key === "Escape") { setParams({ q: null }); e.currentTarget.blur(); } }}
              placeholder="Search" aria-label="Search settings" className="min-w-0 flex-1 bg-transparent text-[16px] font-medium outline-none placeholder:text-mute max-md:hidden" />
            {q ? <button type="button" onClick={() => { setParams({ q: null }); box.current?.focus(); }} className="rounded p-1 text-mute hover:text-ink max-md:hidden" aria-label="Clear search"><X className="size-4" /></button>
              : <kbd className="rounded-md bg-sunk px-2 py-0.5 font-mono text-[13px] text-mute max-md:hidden">/</kbd>}
          </label>
          <nav aria-label="Settings pages" className="flex-1 space-y-0.5 overflow-y-auto px-2.5 pb-3">
            {CATS.map((c) => {
              const count = hits.filter((r) => r.cat === c.id).length, on = !q && c.id === cat.id;
              return (
                <button key={c.id} type="button" aria-current={on ? "page" : undefined} title={c.label} onClick={() => setParams({ section: c.id, q: null })}
                  className={cn("flex h-[38px] w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[16px] font-medium max-md:justify-center max-md:px-0", on ? "bg-sunk text-ink" : "text-mute hover:bg-sunk/70 hover:text-ink", q && !count && "opacity-40")}>
                  <c.icon className="size-[18px] shrink-0 opacity-80" />
                  <span className="flex-1 max-md:hidden">{c.label}</span>
                  {q ? count > 0 && <span className="text-[13.5px] tabular-nums max-md:hidden">{count}</span>
                    : !!wants[c.id] && <span className="min-w-5 rounded-full bg-on px-1.5 text-center text-[13px] font-semibold text-white max-md:hidden" title="Wants a choice">{wants[c.id]}</span>}
                </button>
              );
            })}
          </nav>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-[54px] shrink-0 items-center gap-2.5 border-b border-line-2 pl-6 pr-2 text-[16px]">
            <span className="text-mute">Settings</span>
            <span className="text-faint">/</span>
            <b className="truncate font-semibold">{q ? "Search" : cat.label}</b>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <SavedNote st={st} className="max-sm:hidden" />
              {!q && cat.id === "repos" && <AddRepo st={st} />}
              <button type="button" onClick={() => navigate("/")} className="grid size-9 place-items-center rounded-lg text-mute hover:bg-sunk hover:text-ink" aria-label="Close settings" title="Close"><X className="size-[18px]" /></button>
            </div>
          </header>

          <div ref={pane} className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[1000px] space-y-8 px-5 py-8 sm:px-8">
              {q ? (
                <>
                  {hits.length === 0 && <p className="px-1 text-[15px] text-mute">Nothing matches "{q}". Try what a setting does or what it's set to: "merge", "opus", "sound", "sleep", a repository's name, or a date like "nov 19".</p>}
                  {CATS.filter((c) => hits.some((r) => r.cat === c.id)).map((c) => (
                    <section key={c.id}>
                      <h2 className="px-5 pb-2.5 text-[18.5px] font-semibold">
                        <button type="button" onClick={() => setParams({ section: c.id, q: null })} className="hover:underline">{c.label}</button>
                      </h2>
                      <Card>{hits.filter((r) => r.cat === c.id).map((r) => <div key={r.id}>{r.node}</div>)}</Card>
                    </section>
                  ))}
                </>
              ) : (
                <section aria-label={cat.label}>
                  {cat.id === "repos" && n.noneServed && <div className={cn(NUDGE, "mb-4 px-4 py-2.5 text-[14.5px]")}>The runner isn't serving any repository yet, so it has nothing to do. Switch on the ones it should work on.</div>}
                  <Card>{all.filter((r) => r.cat === cat.id).map((r) => <div key={r.id}>{r.node}</div>)}</Card>
                </section>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
