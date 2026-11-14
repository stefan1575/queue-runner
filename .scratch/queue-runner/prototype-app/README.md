# Queue runner dashboard — prototype (throwaway)

A clickable prototype of the runner's dashboard on **fake data**. It reads and writes nothing:
not the runner, GitHub, T3 or `~/.queue-runner`. Reload resets it.

```
pnpm install
pnpm dev        # http://localhost:5288
```

- One main view: Needs you, the two lanes (with stop controls and the gates that decide whether
  each may start), the work as List / Board / Graph, and on the right both providers' usage,
  what happened since your last visit, and how the runner is connected.
- The floating bar switches the **demo state** (17, grouped). The URL holds the demo (`?demo=`),
  scope (`?repo=`), work view (`?view=`) and open PR (`?pr=`).
- It "refreshes" on tab focus and every 10 s while focused (here it only ticks elapsed minutes).
- Stack: Vite 8, React 19, TypeScript, Tailwind 4, Radix (popover, dialog, switch), cmdk, sonner,
  lucide — leads-dashboard's stack minus TanStack Router (a 30-line URL router instead).
- Data: `src/data/fixtures.ts`, shaped on `jobs.jsonl` outcomes, `config.toml` repos and the
  usage gate. The state model is `prior-art-and-ui.md` §4.
