// PROTOTYPE (throwaway): Settings layout C, plain sentences. The page reads as a short description
// of how the runner works for you; every word you can change sits on a sunk chip with a dotted
// underline and opens the same menu a form control would. No cards, no rows of switches.
import type { ReactNode } from "react";
import { Chip } from "@/components/ui";
import { cn } from "@/lib/cn";
import { AddRepo, effortOpts, modelOpts, NameField, NoRemote, Num, Pick, PlayButton, providerOpts, RemoveRepo, SavedNote, T3Button, type Opt } from "./controls";
import { DATE_STYLES, fmtDate, GH, isTwelve, releaseAt, RESETS, ROLES, SOUNDS, T3_SNOOZE, TIME_FORMATS, type Share } from "./model";
import { nudges, useNow, type Settings } from "./state";

export const name = "Plain sentences";

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-x-8 gap-y-1 border-t border-line py-5 first:border-t-0 first:pt-1 md:grid-cols-[150px_minmax(0,1fr)]">
      <h2 className="pt-[7px] text-[15px] font-semibold text-mute">{title}</h2>
      <div className="space-y-1.5 text-[18.5px] leading-[2.05]">{children}</div>
    </section>
  );
}

// A yes/no said as two phrasings of the same clause.
function YesNo({ on, set, yes, no, label }: { on: boolean; set: (v: boolean) => void; yes: string; no: string; label: string }) {
  const options: Opt<"yes" | "no">[] = [{ id: "yes", label: yes }, { id: "no", label: no }];
  return <Pick look="inline" label={label} value={on ? "yes" : "no"} options={options} onChange={(v) => set(v === "yes")} />;
}

const Blue = ({ children }: { children: ReactNode }) => <span className="inline-block whitespace-nowrap rounded-md bg-you-soft px-2 text-[15.5px] font-medium leading-[1.9] text-you max-md:whitespace-normal">{children}</span>;
const Aside = ({ children }: { children: ReactNode }) => <span className="text-[16px] text-mute">{children}</span>;

export function VariantC({ st }: { st: Settings }) {
  const { s } = st;
  const now = useNow();
  const n = nudges(s);
  const dateOpts = DATE_STYLES.map((d) => ({ id: d.id, label: fmtDate(now, d.id, st.timeFormat), hint: d.label }));
  const soundOpts = SOUNDS.map((x) => ({ id: x.id, label: x.id === "none" ? "no sound" : `the ${x.label} sound` }));

  const share = (x: Share) => (
    <p key={x.id} className={cn(!x.enforced && "text-faint")}>
      Keep <Num look="inline" label={`Percent of ${x.window} kept`} value={x.percent} disabled={!x.enforced} onChange={(percent) => st.setShare(x.id, { percent })} />% of {x.window} for me
      {!x.enforced ? <>. <Chip className="align-middle">Coming soon</Chip></>
        : x.percent === 0 ? <>: the runner may use all of it. <Aside>It resets {fmtDate(RESETS[x.id], s.dateStyle, st.timeFormat, true)}.</Aside></>
        : <> until <Num look="inline" label={`Hours before ${x.window} resets`} value={x.releaseHours} max={168} onChange={(releaseHours) => st.setShare(x.id, { releaseHours })} /> hours before it resets. <Aside>The runner stops at {100 - x.percent}% used, then may use the rest from {fmtDate(releaseAt(x), s.dateStyle, st.timeFormat, true)}.</Aside></>}
    </p>
  );

  return (
    <div className="max-w-[860px]">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-[15px] text-mute">How the runner works for you. Click a marked word to change it.</p>
        <SavedNote st={st} />
      </div>

      <Group title="You">
        <p>Call me <NameField st={st} look="inline" /> in the briefs the runner writes. <Aside>From your GitHub account, {GH.login}.</Aside></p>
      </Group>

      <Group title="Roles">
        {ROLES.map((r) => {
          const role = s.roles[r.id];
          return (
            <p key={r.id}>
              {r.verb} with{" "}
              <Pick look="inline" label={`${r.label} provider`} value={role.provider} options={providerOpts} onChange={(provider) => st.setRole(r.id, { provider })} />{" "}
              <Pick look="inline" label={`${r.label} model`} value={role.model} options={modelOpts(role.provider)} onChange={(model) => st.setRole(r.id, { model })} /> at{" "}
              <Pick look="inline" label={`${r.label} effort`} value={role.effort} options={effortOpts(role.provider)} onChange={(effort) => st.setRole(r.id, { effort })} /> effort.{" "}
              {!role.chosen && <Blue>T3's default, not chosen yet. <button type="button" onClick={() => st.keepRole(r.id)} className="font-semibold underline underline-offset-4">Keep it</button></Blue>}
              {role.chosen && r.id === "builder" && <Aside>The builder also runs decisions and conflict rounds.</Aside>}
            </p>
          );
        })}
      </Group>

      <Group title="Your share of each plan">{s.shares.map(share)}</Group>

      <Group title="Repositories">
        {n.noneServed && <p><Blue>The runner isn't serving any repository yet, so it has nothing to do.</Blue></p>}
        {s.repos.map((r) => (
          <p key={r.name} className="group">
            <b className="font-semibold">{r.name}</b>{" "}
            {!r.github ? <><NoRemote className="align-middle" /> <span className="text-mute">so it can't be served.</span></> : (
              <>
                {r.newFromT3 && <>is <Blue>new from T3</Blue> and </>}
                {!r.newFromT3 && "is "}
                <YesNo label={`Serve ${r.name}`} on={r.served} set={(served) => st.setRepo(r.name, { served })} yes="served" no="not served" />
                {r.served ? <>, and <Pick look="inline" label={`Who merges ${r.name}`} value={r.merge} options={[{ id: "me", label: "I merge" }, { id: "runner", label: "the runner merges" }]} onChange={(merge) => st.setRepo(r.name, { merge })} />.</> : "."}
              </>
            )}{" "}
            <RemoveRepo st={st} repo={r}><button type="button" className="text-[15px] text-faint underline decoration-dotted underline-offset-4 opacity-0 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100">Remove</button></RemoveRepo>
          </p>
        ))}
        <p className="text-[16px] text-mute">
          The same list as T3 Code's projects, kept in step both ways. The runner never touches one that isn't served.{" "}
          <AddRepo st={st} className="font-semibold text-ink underline decoration-faint underline-offset-[5px] hover:decoration-ink">Add a folder</AddRepo>
        </p>
      </Group>

      <Group title="Display">
        <p>
          Write dates like <Pick look="inline" label="Date style" value={s.dateStyle} options={dateOpts} onChange={(v) => st.set((d) => { d.dateStyle = v; })} />, or {fmtDate(now, s.dateStyle, st.timeFormat, true)} where space is tight.
        </p>
        <p>
          The clock is {isTwelve(st.timeFormat) ? "12-hour" : "24-hour"} because T3 Code's Time format is set to {TIME_FORMATS.find((f) => f.id === st.timeFormat)?.label}. <T3Button look="inline" where="General → Time format">Change it in T3</T3Button>
        </p>
      </Group>

      <Group title="Inbox">
        <p>
          Snooze offers exactly what T3 Code offers: {T3_SNOOZE.map((x) => x.replace(/^(For|Today|Tomorrow)/, (w) => w.toLowerCase())).join(", ")}, or a time you pick. <T3Button look="inline" where="Threads → Snooze options">Change them in T3</T3Button>
        </p>
      </Group>

      <Group title="Notifications">
        <p>
          <YesNo label="Notify me when something needs me" on={s.notify.needsMe} set={(v) => st.set((d) => { d.notify.needsMe = v; })} yes="Notify me" no="Don't notify me" /> when something needs me: an ask, a stop filed for me, or an "Answer:" thread.
        </p>
        <p>
          <YesNo label="Notify me on merges" on={s.notify.merges} set={(v) => st.set((d) => { d.notify.merges = v; })} yes="Also notify me" no="Don't notify me" /> when a pull request merges or is ready to merge.
        </p>
        <p className={cn(!(s.notify.needsMe || s.notify.merges) && "text-faint")}>
          Play <Pick look="inline" label="Sound" value={s.notify.sound} options={soundOpts} disabled={!(s.notify.needsMe || s.notify.merges)} onChange={(v) => st.set((d) => { d.notify.sound = v; })} /> with a notification. <PlayButton st={st} className="ml-1" />
        </p>
      </Group>

      <Group title="Machine">
        <p><YesNo label="Start with Windows" on={s.machine.startWithWindows} set={(v) => st.set((d) => { d.machine.startWithWindows = v; })} yes="Start" no="Don't start" /> the runner when I sign in to Windows.</p>
        <p><YesNo label="Let the runner wake this PC" on={s.machine.wakePc} set={(v) => st.set((d) => { d.machine.wakePc = v; })} yes="Let" no="Don't let" /> the runner wake this PC for a job scheduled after a wait.</p>
      </Group>
    </div>
  );
}
