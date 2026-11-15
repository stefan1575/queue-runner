// The repo scope picker: All repositories, then the served repos in priority order with their ask
// counts. Search filters but never re-sorts. "Add repository…" is an action in the footer, not an
// option. Choosing a repo changes what you see, not what the runner does next.
import * as Popover from "@radix-ui/react-popover";
import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { Check, ChevronsUpDown, FolderGit2, Layers, Plus, Search, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/cn";
import { useStore } from "@/store";
import { Button } from "./ui";

export function RepoPicker() {
  const { world, repo, setRepo } = useStore();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const current = world.repos.find((r) => r.id === repo);
  const asksIn = (id: string) => world.asks.filter((a) => a.repo === id).length;

  return (
    <>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          aria-label={`Repository: ${current ? current.github : "All repositories"}`}
          className="flex w-full min-w-0 items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-surface/70 data-[state=open]:bg-surface"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-ink text-[15px] font-bold text-page">
            {current ? current.id[0].toUpperCase() : <Layers className="size-[18px]" />}
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-[15px] font-semibold">{current ? current.id : "All repositories"}</span>
            <span className="block truncate text-[13px] text-mute">{current ? current.github.split("/")[0] : `${world.repos.length} served`}</span>
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-faint" />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={6}
            className="z-50 w-[min(320px,calc(100vw-32px))] overflow-hidden rounded-xl border border-line bg-surface shadow-[0_12px_32px_-8px_rgba(21,23,28,.22)]"
          >
            <Command
              label="Repositories"
              filter={(value, search) => (value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0)}
              // cmdk sorts by score; every match scores 1, so order stays the priority order.
            >
              <div className="flex items-center gap-2 border-b border-line-2 px-3">
                <Search className="size-4 text-faint" />
                <Command.Input placeholder="Find a repository" className="h-11 flex-1 bg-transparent outline-none focus-visible:outline-none text-[15px] outline-none placeholder:text-faint" />
              </div>
              <Command.List className="max-h-[min(360px,55vh)] overflow-y-auto p-1.5">
                <Command.Empty className="px-2.5 py-3 text-[14.5px] text-mute">No served repository matches.</Command.Empty>
                <Command.Item
                  value="all repositories"
                  onSelect={() => { setRepo(null); setOpen(false); }}
                  className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 data-[selected=true]:bg-sunk"
                >
                  <span className="flex size-6 items-center justify-center rounded-md bg-ink text-page"><Layers className="size-3.5" /></span>
                  <span className="flex-1 text-[15px] font-medium">All repositories</span>
                  <Count n={world.asks.length} />
                  <Check className={cn("size-4", repo === null ? "text-ink" : "invisible")} />
                </Command.Item>
                <Command.Group heading="Served, in priority order" className="mt-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[13px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-faint">
                  {world.repos.map((r, i) => (
                    <Command.Item
                      key={r.id}
                      value={r.github}
                      onSelect={() => { setRepo(r.id); setOpen(false); }}
                      className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 data-[selected=true]:bg-sunk"
                    >
                      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-line-2 text-[13px] font-semibold tabular-nums text-ink-2">{i + 1}</span>
                      <span className="min-w-0 flex-1 leading-tight">
                        <span className="block truncate text-[15px] font-medium">{r.id}</span>
                        <span className="block truncate text-[13px] text-mute">{r.github.split("/")[0]}{r.merge === "stefan" ? " · you merge" : ""}{!r.readable ? " · unreadable" : ""}</span>
                      </span>
                      <Count n={asksIn(r.id)} />
                      <Check className={cn("size-4", repo === r.id ? "text-ink" : "invisible")} />
                    </Command.Item>
                  ))}
                </Command.Group>
              </Command.List>
            </Command>
            <div className="border-t border-line p-1.5">
              <button
                type="button"
                onClick={() => { setOpen(false); setAdding(true); }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[15px] font-medium hover:bg-sunk focus-visible:bg-sunk"
              >
                <span className="flex size-6 items-center justify-center rounded-md border border-dashed border-faint text-mute"><Plus className="size-3.5" /></span>
                Add repository…
              </button>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <AddRepo open={adding} onOpenChange={setAdding} />
    </>
  );
}

function Count({ n }: { n: number }) {
  if (!n) return <span className="w-6" />;
  return <span className="min-w-6 rounded-full bg-you-soft px-1.5 text-center text-[13px] font-semibold tabular-nums text-you" title={`${n} asks need you`}>{n}</span>;
}

function AddRepo({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { world, setWorld } = useStore();
  const [folder, setFolder] = useState("~/Code/Work/client-portal");
  const name = folder.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const [merge, setMerge] = useState<"runner" | "stefan">("runner");
  const [pos, setPos] = useState(world.repos.length + 1);
  const [live, setLive] = useState("");

  const add = () => {
    setWorld((w) => {
      const r = { id: name, github: `RoyalBullyAgency-RBA/${name}`, path: folder, base: "main", merge, liveDoc: live || undefined, readable: true };
      w.repos.splice(Math.min(pos - 1, w.repos.length), 0, r);
      return w;
    });
    onOpenChange(false);
    toast.success(`Added ${name} at priority ${pos}`, { description: "Prototype: nothing was written. For real, this adds a [[repos]] entry to config.toml and the runner reads it at its next start." });
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-32px)] w-[min(520px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl bg-surface p-5 shadow-2xl sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="text-[19px] font-semibold tracking-tight">Add a repository</Dialog.Title>
              <Dialog.Description className="mt-1 text-mute">The runner works in a local clone, so start from its folder.</Dialog.Description>
            </div>
            <Dialog.Close className="rounded-md p-1 text-faint hover:bg-line-2 hover:text-ink" aria-label="Close"><X className="size-4" /></Dialog.Close>
          </div>
          <form className="mt-5 space-y-4" onSubmit={(e) => { e.preventDefault(); add(); }}>
            <Field label="Local clone">
              <div className="flex gap-2">
                <input value={folder} onChange={(e) => setFolder(e.target.value)} className="h-11 min-w-0 flex-1 rounded-lg border border-line px-3 font-mono text-[14px]" />
                <Button>Browse…</Button>
              </div>
            </Field>
            <div className="flex items-center gap-3 rounded-lg bg-page px-3 py-2.5 text-[14.5px]">
              <FolderGit2 className="size-4 shrink-0 text-ok" />
              <span className="min-w-0">Found <b className="font-semibold">RoyalBullyAgency-RBA/{name}</b> as origin, base branch <b className="font-semibold">main</b>, issues on GitHub.</span>
            </div>
            <Field label="Who merges its PRs">
              <div className="grid gap-2 sm:grid-cols-2">
                {([["runner", "The runner", "Merges once Sol is clean and checks pass"], ["stefan", "You", "Marked ready-for-stefan; you merge"]] as const).map(([v, l, m]) => (
                  <label key={v} className={cn("cursor-pointer rounded-lg border p-3", merge === v ? "border-ink" : "border-line")}>
                    <input type="radio" name="merge" className="sr-only" checked={merge === v} onChange={() => setMerge(v)} />
                    <span className="block font-medium">{l}</span>
                    <span className="block text-[14px] text-mute">{m}</span>
                  </label>
                ))}
              </div>
            </Field>
            <Field label="Live steps doc (optional)" hint="A doc a Claude thread follows after merges, like leads-dashboard's Lovable steps.">
              <input value={live} onChange={(e) => setLive(e.target.value)} placeholder="docs/agents/deploy.md" className="h-11 w-full rounded-lg border border-line px-3 font-mono text-[14px] placeholder:text-faint" />
            </Field>
            <Field label="Priority" hint="The first repo with work gets the next build. Change it later in Settings.">
              <select value={pos} onChange={(e) => setPos(Number(e.target.value))} className="h-11 w-full rounded-lg border border-line bg-surface px-2">
                {world.repos.map((r, i) => <option key={r.id} value={i + 1}>{i + 1} · before {r.id}</option>)}
                <option value={world.repos.length + 1}>{world.repos.length + 1} · last</option>
              </select>
            </Field>
            <div className="flex justify-end gap-2 pt-1">
              <Dialog.Close asChild><Button variant="ghost">Cancel</Button></Dialog.Close>
              <Button type="submit" variant="primary">Add {name}</Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[14.5px] font-medium">{label}</div>
      {children}
      {hint && <p className="mt-1 text-[14px] text-mute">{hint}</p>}
    </div>
  );
}
