# Queue runner dashboard — prototype (throwaway)

A clickable prototype of the runner's dashboard on **fake data**. It reads and writes nothing:
not the runner, GitHub, T3 or `~/.queue-runner`. Reload resets it.

```
pnpm install
pnpm dev        # http://localhost:5288
```

- A sidebar: the repo switcher, Dashboard / Activity / Usage / Settings, and the runner's health
  with its connections. Usage floats on the right (from a top-bar button on narrow windows).
- Colour is state: blue needs you, amber working, red broken, green healthy, grey idle. Claude's and
  OpenAI's brand colours appear only on their marks.
- **Settings is a layout prototype** (#36): three layouts of the same settings on `/settings`,
  switched by `?variant=A|B|C` or the floating bar (← → keys too); `?data=new` shows a new install.
  Earlier rounds stay viewable: `?round=1`, `?round=2` (keys 1, 2, 3). Round 3's B copies T3 Code's settings.
  The bar's "Stored JSON" shows what the runner would store. Code: `src/pages/settings-prototype/`.
- Elsewhere: one realistic busy state, no prototype bar. Other states still load by URL (`?demo=`, see
  `src/data/fixtures.ts`) for when we look at one element's edge cases.
- It "refreshes" on tab focus and every 10 s while focused (here it only ticks elapsed minutes).
- Stack: Vite 8, React 19, TypeScript, Tailwind 4, Radix (popover, dialog, switch), cmdk, sonner,
  lucide — leads-dashboard's stack minus TanStack Router (a 30-line URL router instead).
- Data: `src/data/fixtures.ts`, shaped on `jobs.jsonl` outcomes, `config.toml` repos and the
  usage gate. The state model is `prior-art-and-ui.md` §4.
