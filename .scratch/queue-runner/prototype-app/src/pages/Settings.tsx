// Settings: the repos the runner serves, your share of each provider, and how it's connected.
// Rows marked "Later" show where a future setting goes; they don't work yet.
import { Fragment } from "react";
import { ProviderName, type Provider } from "@/components/Brand";
import { Dot, Section } from "@/components/ui";
import { cn } from "@/lib/cn";
import { useStore } from "@/store";

const ROLES: [string, string, Provider][] = [
  ["Builder", "Builds issues, fix rounds, conflict rounds", "claude"],
  ["Reviewer", "Reviews every PR head", "chatgpt"],
  ["Decider", "Decides cases the fixed flow doesn't cover", "claude"],
  ["Deployer", "Live steps after a merge (Lovable, Supabase)", "claude"],
];

function Later() {
  return <span className="rounded-md bg-sunk px-1.5 py-0.5 text-[12.5px] font-medium text-mute">Later</span>;
}

export function SettingsPage() {
  const { world } = useStore();
  return (
    <div className="grid max-w-[920px] gap-4">
      <Section title="Repositories" count={world.repos.length} flush>
        <ol className="divide-y divide-line-2">
          {world.repos.map((r, i) => (
            <li key={r.id} className="flex items-center gap-3 px-4 py-3">
              <span className="w-5 text-right tabular-nums text-faint">{i + 1}</span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{r.id}</span>
                <span className="block truncate text-[13.5px] text-mute">{r.github} · {r.path}</span>
              </span>
              <span className="text-[14px] text-ink-2">{r.merge === "stefan" ? "You merge" : "Runner merges"}</span>
            </li>
          ))}
        </ol>
        <p className="border-t border-line-2 px-4 py-3 text-[14px] text-mute">The first repo with work gets the next build.</p>
      </Section>

      <Section title="Your share of each provider">
        <div className="space-y-3">
          <Row label={<ProviderName p="claude" />} value={`${world.runner.reserve}% of the week kept for you`} />
          <Row label={<ProviderName p="chatgpt" />} value="Not kept back: reviews may use all of it" later />
        </div>
      </Section>

      <Section title="Roles" aside={<Later />} flush>
        <table className="w-full text-[14.5px]">
          <tbody>
            {ROLES.map(([role, does, p]) => (
              <tr key={role} className="border-b border-line-2 last:border-0">
                <td className="px-4 py-3 font-semibold">{role}</td>
                <td className="px-4 py-3 text-mute">{does}</td>
                <td className="px-4 py-3 text-right"><ProviderName p={p} className="opacity-70" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Connections" flush>
        <ul className="divide-y divide-line-2">
          {world.connections.map((c) => (
            <li key={c.id} className="px-4 py-3">
              <div className="flex items-center gap-2.5">
                <Dot className={c.ok ? "bg-ok" : "bg-bad"} />
                <span className="font-semibold">{c.name}</span>
                <span className="text-[14px] text-mute">{c.role}</span>
                <span className={cn("ml-auto text-[14px]", c.ok ? "text-ink-2" : "font-semibold text-bad")}>{c.status}</span>
              </div>
              <dl className="mt-1.5 grid grid-cols-[96px_1fr] gap-x-3 gap-y-0.5 pl-[18px] text-[13.5px]">
                {c.how.map(([k, v]) => <Fragment key={k}><dt className="text-faint">{k}</dt><dd className="break-words font-mono text-[13px] text-ink-2">{v}</dd></Fragment>)}
              </dl>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function Row({ label, value, later }: { label: React.ReactNode; value: string; later?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-36">{label}</span>
      <span className="flex-1 text-ink-2">{value}</span>
      {later && <Later />}
    </div>
  );
}
