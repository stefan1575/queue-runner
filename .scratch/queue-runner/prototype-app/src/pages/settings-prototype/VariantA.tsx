// PROTOTYPE (throwaway): Settings layout A, one long page. Every section is a card, stacked in the
// order you'd set a new install up; a row is a label on the left and its control on the right. A
// strip of section names sticks under the top bar to jump with, and carries the nudges.
import { Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { ClaudeMark, OpenAIMark } from "@/components/Brand";
import { Chip, Section } from "@/components/ui";
import { cn } from "@/lib/cn";
import { AddRepo, BTN, DateChoices, NameField, NoRemote, NUDGE, Num, RemoveRepo, RolePicks, SavedNote, Seg, SnoozeList, SoundChoices, T3Button, Toggle } from "./controls";
import { fmtDate, GH, isTwelve, releaseAt, RESETS, ROLES, TIME_FORMATS } from "./model";
import { nudges, useNow, type Settings } from "./state";

export const name = "One long page";

function Row({ title, desc, children, below, dim }: { title: ReactNode; desc?: ReactNode; children?: ReactNode; below?: ReactNode; dim?: boolean }) {
  return (
    <div className={cn("px-4 py-3", dim && "opacity-55")}>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="min-w-[220px] flex-1">
          <div className="font-semibold">{title}</div>
          {desc && <div className="text-[15px] text-mute">{desc}</div>}
        </div>
        {children && <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>}
      </div>
      {below}
    </div>
  );
}

const SECTIONS = ["Name", "Roles", "Your share", "Repositories", "Display", "Inbox", "Notifications", "Machine"];
const anchor = (s: string) => `set-${s.toLowerCase().replace(/\s+/g, "-")}`;

export function VariantA({ st }: { st: Settings }) {
  const { s } = st;
  const now = useNow();
  const n = nudges(s);
  const wants: Record<string, boolean> = { Roles: n.roles.length > 0, Repositories: n.newRepos.length > 0 || n.noneServed };
  const anyNotify = s.notify.needsMe || s.notify.merges;

  return (
    <div className="max-w-[880px]">
      <div className="sticky top-14 z-20 -mx-1 mb-3 flex flex-wrap items-center gap-1 bg-page/95 px-1 py-2 backdrop-blur">
        {SECTIONS.map((x) => (
          <button key={x} type="button" onClick={() => document.getElementById(anchor(x))?.scrollIntoView({ behavior: "smooth", block: "start" })}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[15px] font-medium text-ink-2 hover:bg-sunk">
            {x}{wants[x] && <span className="size-2 rounded-full bg-you" title="Wants a choice" />}
          </button>
        ))}
        <SavedNote st={st} className="ml-auto pr-1" />
      </div>

      <div className="space-y-4">
        <div id={anchor("Name")} className="scroll-mt-36">
          <Section title="Name" flush>
            <Row title="Your name" desc={<>The runner uses it in the briefs it writes. From your GitHub account, {GH.login}.</>}><NameField st={st} /></Row>
          </Section>
        </div>

        <div id={anchor("Roles")} className="scroll-mt-36">
          <Section title="Roles" flush aside={n.roles.length > 0 && <Chip tone="you">Choose {n.roles.length === 2 ? "both" : "one"}</Chip>}>
            <p className="border-b border-line-2 px-4 py-2.5 text-[15px] text-mute">Who does the work, from the providers T3 Code has connected.</p>
            <div className="divide-y divide-line-2">
              {ROLES.map((r) => (
                <Row key={r.id} title={r.label} desc={r.does}
                  below={!s.roles[r.id].chosen && (
                    <div className={cn(NUDGE, "mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 text-[15px]")}>
                      <span className="flex-1">This is T3's default, not your choice yet. Pick the model you want {r.id === "builder" ? "building" : "reviewing"}.</span>
                      <button type="button" onClick={() => st.keepRole(r.id)} className="h-8 rounded-md bg-you px-2.5 font-medium text-white dark:text-page">Keep this</button>
                    </div>
                  )}>
                  <RolePicks st={st} role={r.id} />
                </Row>
              ))}
            </div>
          </Section>
        </div>

        <div id={anchor("Your share")} className="scroll-mt-36">
          <Section title="Your share of each plan" flush>
            <p className="border-b border-line-2 px-4 py-2.5 text-[15px] text-mute">The part of each weekly window the runner leaves for you, whichever role uses that provider. It's released to the runner shortly before the window resets.</p>
            <div className="divide-y divide-line-2">
              {s.shares.map((x) => {
                const Mark = x.provider === "claude" ? ClaudeMark : OpenAIMark;
                return (
                  <div key={x.id} className="grid grid-cols-[minmax(170px,1fr)_auto] items-center gap-x-6 gap-y-2 px-4 py-3 md:grid-cols-[minmax(170px,1fr)_auto_auto]">
                    <div className={cn(!x.enforced && "opacity-55")}>
                      <div className="flex items-center gap-2 font-semibold"><Mark className="size-4" />{x.window}{!x.enforced && <Chip>Coming soon</Chip>}</div>
                      <div className="text-[15px] text-mute">Resets {fmtDate(RESETS[x.id], s.dateStyle, st.timeFormat, true)}</div>
                    </div>
                    <label className={cn("flex items-center gap-2 text-[15.5px]", !x.enforced && "opacity-55")}>Keep<Num label={`Percent of ${x.window} kept`} value={x.percent} disabled={!x.enforced} onChange={(percent) => st.setShare(x.id, { percent })} />%</label>
                    <label className={cn("col-span-2 flex flex-wrap items-center gap-2 text-[15.5px] md:col-span-1", (!x.enforced || x.percent === 0) && "opacity-55")}>
                      until<Num label={`Hours before ${x.window} resets`} value={x.releaseHours} max={168} disabled={!x.enforced} onChange={(releaseHours) => st.setShare(x.id, { releaseHours })} />hours before the reset
                    </label>
                    {x.enforced && (
                      <div className="col-span-full -mt-1 text-[15px] text-mute">
                        {x.percent === 0 ? "Nothing is kept: the runner may use all of it." : <>The runner stops at {100 - x.percent}% used, then may use the rest from {fmtDate(releaseAt(x), s.dateStyle, st.timeFormat, true)}.</>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Section>
        </div>

        <div id={anchor("Repositories")} className="scroll-mt-36">
          <Section title="Repositories" count={s.repos.length} flush aside={<AddRepo st={st} className={cn(BTN, "h-8 px-2.5")} />}>
            {n.noneServed && <div className={cn(NUDGE, "m-3 px-3 py-2 text-[15px]")}>The runner isn't serving any repository yet, so it has nothing to do. Switch on the ones it should work on.</div>}
            <div className="divide-y divide-line-2">
              {s.repos.map((r) => (
                <div key={r.name} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                  <div className="min-w-[200px] flex-1">
                    <div className="flex items-center gap-2 font-semibold">{r.name}{r.newFromT3 && <Chip tone="you">New from T3</Chip>}{!r.github && <NoRemote />}</div>
                    <div className="truncate text-[15px] text-mute">{r.github ?? "Can't be served until it has one"} · {r.path}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <label className="flex items-center gap-2 text-[15px] text-ink-2">
                      <Toggle label={`Serve ${r.name}`} checked={r.served} disabled={!r.github} onChange={(served) => st.setRepo(r.name, { served })} />
                      <span className="w-[74px]">{r.served ? "Served" : "Not served"}</span>
                    </label>
                    <Seg label={`Who merges ${r.name}`} value={r.merge} disabled={!r.served} onChange={(merge) => st.setRepo(r.name, { merge })} options={[{ id: "me", label: "I merge" }, { id: "runner", label: "Runner merges" }]} />
                    <RemoveRepo st={st} repo={r}><button type="button" className="rounded-md p-2 text-faint hover:bg-sunk hover:text-ink" aria-label={`Remove ${r.name}`} title="Remove"><Trash2 className="size-4" /></button></RemoveRepo>
                  </div>
                </div>
              ))}
            </div>
            <p className="border-t border-line-2 px-4 py-2.5 text-[15px] text-mute">The same list as T3 Code's projects, kept in step both ways. A project added in T3 arrives here switched off. Not served means the runner never touches it.</p>
          </Section>
        </div>

        <div id={anchor("Display")} className="scroll-mt-36">
          <Section title="Display" flush>
            <div className="divide-y divide-line-2">
              <Row title="Date style" desc="How dates are written across the app, shown on the time right now." below={<DateChoices st={st} now={now} className="mt-3 sm:grid-cols-2" />} />
              <Row title="Clock" desc={<>{isTwelve(st.timeFormat) ? "12-hour" : "24-hour"}, because T3 Code's Time format is set to {TIME_FORMATS.find((f) => f.id === st.timeFormat)?.label}. Both apps read the same.</>}>
                <T3Button where="General → Time format">Change in T3</T3Button>
              </Row>
            </div>
          </Section>
        </div>

        <div id={anchor("Inbox")} className="scroll-mt-36">
          <Section title="Inbox" flush>
            <Row title="Snooze choices" desc="Exactly T3 Code's Snooze options. Snoozing here snoozes the thread there, and the other way round." below={<div className="mt-3"><SnoozeList /></div>}>
              <T3Button where="Threads → Snooze options">Change in T3</T3Button>
            </Row>
          </Section>
        </div>

        <div id={anchor("Notifications")} className="scroll-mt-36">
          <Section title="Notifications" flush>
            <div className="divide-y divide-line-2">
              <Row title="Notify me when something needs me" desc={'An ask, a stop filed for you, or an "Answer:" thread.'}><Toggle label="Notify me when something needs me" checked={s.notify.needsMe} onChange={(v) => st.set((d) => { d.notify.needsMe = v; })} /></Row>
              <Row title="Also when a pull request merges or is ready to merge"><Toggle label="Notify me on merges" checked={s.notify.merges} onChange={(v) => st.set((d) => { d.notify.merges = v; })} /></Row>
              <Row title="Sound" desc="Made for the app. Click one to hear it." dim={!anyNotify}><SoundChoices st={st} disabled={!anyNotify} /></Row>
            </div>
          </Section>
        </div>

        <div id={anchor("Machine")} className="scroll-mt-36">
          <Section title="Machine" flush>
            <div className="divide-y divide-line-2">
              <Row title="Start with Windows" desc="The runner starts in the tray when you sign in."><Toggle label="Start with Windows" checked={s.machine.startWithWindows} onChange={(v) => st.set((d) => { d.machine.startWithWindows = v; })} /></Row>
              <Row title="Let the runner wake this PC" desc="For a job scheduled after a wait, such as a usage reset overnight."><Toggle label="Let the runner wake this PC" checked={s.machine.wakePc} onChange={(v) => st.set((d) => { d.machine.wakePc = v; })} /></Row>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
