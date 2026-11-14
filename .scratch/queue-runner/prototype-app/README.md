# Queue runner dashboard — prototype (throwaway)

A clickable prototype of the runner's dashboard on **fake data**. It reads and writes nothing:
not the runner, GitHub, T3 or `~/.queue-runner`. Reload resets it.

```
pnpm install
pnpm dev        # http://localhost:5288
```

- The floating bar at the bottom switches the **demo state** (19, grouped) and where the **repo
  picker** sits (top of the content, or the sidebar). Both are in the URL (`?demo=`, `?picker=`),
  as is the scope (`?repo=`) and the queue view (`?view=`).
- Stack: Vite 8, React 19, TypeScript, Tailwind 4, Radix (popover, dialog, switch), cmdk, sonner,
  lucide — leads-dashboard's stack minus TanStack Router (a 30-line URL router instead).
- Data: `src/data/fixtures.ts`, shaped on `jobs.jsonl` outcomes, `config.toml` repos and the
  usage gate. The state model is `prior-art-and-ui.md` §4.
