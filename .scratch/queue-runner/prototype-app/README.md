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
- **Settings and Usage** open from the sidebar's footer row, where T3 Code has its own, as pop-ups
  over the page you're on (not pages). Update sits there greyed until updates are specced.
- **Settings is laid out as T3 Code's own settings** (#36): a list of settings pages on the left, one
  page at a time, and T3's type and colours while it's open (the `t3-skin` block in
  `src/index.css`). `?data=new` shows a new install. Code: `src/pages/settings-prototype/`. The
  layouts and rounds it was chosen from are on the branch `prototype/settings-layout-36`.
- One realistic busy state, no prototype bar. Other states still load by URL (`?demo=`, see
  `src/data/fixtures.ts`) for when we look at one element's edge cases.
- It "refreshes" on tab focus and every 10 s while focused (here it only ticks elapsed minutes).
- Stack: Vite 8, React 19, TypeScript, Tailwind 4, Radix (popover, dialog, switch), cmdk, sonner,
  lucide — leads-dashboard's stack minus TanStack Router (a 30-line URL router instead).
- Data: `src/data/fixtures.ts`, shaped on `jobs.jsonl` outcomes, `config.toml` repos and the
  usage gate. The state model is `prior-art-and-ui.md` §4.
