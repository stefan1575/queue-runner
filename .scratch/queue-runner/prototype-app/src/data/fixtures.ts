// Fake data shaped like the runner's own records (jobs.jsonl outcomes, config.toml, the usage gate,
// Codex's rate_limits). "Now" is Sat 14 Nov 2026, 14:40.
import type { Ask, Connection, Feature, Gate, Issue, Repo, World } from "./types";
import { PRS } from "./prs";

const LD = "leads-dashboard";
const QR = "queue-runner";

export const REPOS: Repo[] = [
  { id: LD, github: "RoyalBullyAgency-RBA/leads-dashboard", path: "~/Code/Work/leads-dashboard", base: "main", merge: "stefan", liveDoc: "docs/agents/lovable-cloud.md", readable: true },
  { id: QR, github: "stefan1575/queue-runner", path: "~/Code/Personal/queue-runner", base: "main", merge: "runner", readable: true },
];

const EXTRA_REPOS: Repo[] = ["royal-bully-ops", "callsling-relay", "client-portal", "personal-ops", "n8n-flows", "twilio-voice-agent", "dotfiles", "seo-audits"].map((id) => ({
  id,
  github: `${id.includes("ops") || id === "dotfiles" ? "stefan1575" : "RoyalBullyAgency-RBA"}/${id}`,
  path: `~/Code/Work/${id}`,
  base: "main",
  merge: "runner" as const,
  readable: true,
}));

const ASKS: Ask[] = [
  {
    id: "ask-152", kind: "decide", repo: LD, ref: "PR #152", pr: 152,
    title: "Sol still blocks PR #152 after three reviews",
    why: ["Review 3 raised I-4 again: the ring-to check reads the Client's owner from before the move.", "A decision thread wrote an approach note; it recommends rework."],
    options: [
      { label: "rework", means: "One more fix round that changes the approach", recommended: true },
      { label: "fix on", means: "One more fix round on the same approach" },
      { label: "hold", means: "Leave it until you release it" },
    ],
    unblocks: 1, since: "2h", action: "Reply on #219",
  },
  {
    id: "ask-207", kind: "merge", repo: LD, ref: "PR #207", pr: 207,
    title: "PR #207 is ready to merge",
    why: ["Clean on a0d5f6f, checks passed, no conflict, nothing said since."],
    since: "40m", action: "Open PR",
  },
  {
    id: "ask-214", kind: "answer", repo: LD, ref: "#214",
    title: "Must every Client fill in the onboarding form?",
    why: ["The #214 build stopped before writing the form's required fields.", "A decision thread couldn't answer it from the issue."],
    unblocks: 2, since: "12m", action: "Answer in T3",
  },
];

const FEATURES: Feature[] = [
  { id: `${LD}#225`, repo: LD, n: 225, title: "Analytics" },
  { id: `${LD}#149`, repo: LD, n: 149, title: "Ring-to numbers" },
  { id: `${LD}#220`, repo: LD, n: 220, title: "Client onboarding" },
  { id: `${LD}#200`, repo: LD, n: 200, title: "Callers" },
  { id: `${QR}#9`, repo: QR, n: 9, title: "Dashboard" },
  { id: `${LD}:none`, repo: LD, title: "No feature" },
  { id: `${QR}:none`, repo: QR, title: "No feature" },
];

const f = (repo: string, n: number) => `${repo}#${n}`;

const ISSUES: Issue[] = [
  // Analytics: one ready issue holds up the whole chain.
  { repo: LD, n: 226, title: "Store call events", feature: f(LD, 225), state: "ready" },
  { repo: LD, n: 227, title: "Daily rollup of events", feature: f(LD, 225), state: "blocked", blockedBy: [f(LD, 226)] },
  { repo: LD, n: 228, title: "Charts page", feature: f(LD, 225), state: "blocked", blockedBy: [f(LD, 227)] },
  { repo: LD, n: 229, title: "Lead source report", feature: f(LD, 225), state: "blocked", blockedBy: [f(LD, 227), f(LD, 196)] },
  { repo: LD, n: 230, title: "Export analytics as CSV", feature: f(LD, 225), state: "blocked", blockedBy: [f(LD, 228)] },
  { repo: LD, n: 196, title: "Lead source on every call", feature: f(LD, 225), state: "done" },
  // Ring-to numbers
  { repo: LD, n: 191, title: "A Client's Twilio number on their page", feature: f(LD, 149), state: "merge", pr: 207, reason: "PR #207 ready for you to merge" },
  { repo: LD, n: 150, title: "Ring-to number per Client", feature: f(LD, 149), state: "you", pr: 152, reason: "PR #152 waits for your decision" },
  { repo: LD, n: 216, title: "Ring-to audit page", feature: f(LD, 149), state: "blocked", blockedBy: [f(LD, 150)] },
  // Client onboarding
  { repo: LD, n: 214, title: "Client onboarding form", feature: f(LD, 220), state: "you", reason: "Its build waits for your answer" },
  { repo: LD, n: 215, title: "SEO questions on the form", feature: f(LD, 220), state: "blocked", blockedBy: [f(LD, 214)] },
  { repo: LD, n: 223, title: "Welcome email after the form", feature: f(LD, 220), state: "blocked", blockedBy: [f(LD, 214)] },
  // Callers
  { repo: LD, n: 205, title: "Callers list: filter by tag", feature: f(LD, 200), state: "review", pr: 210, reason: "Sol is reviewing PR #210" },
  { repo: LD, n: 212, title: "Archive view for old callers", feature: f(LD, 200), state: "building", reason: "Claude is building it" },
  { repo: LD, n: 218, title: "Export calls as CSV", feature: f(LD, 200), state: "not-ready", reason: "Not marked ready-for-agent" },
  // No feature
  { repo: LD, n: 199, title: "Unassigned: assign several at once", state: "fixing", pr: 204, reason: "Fix round on PR #204 is next" },
  { repo: LD, n: 211, title: "Domain health check", state: "ready" },
  // queue-runner
  { repo: QR, n: 5, title: "Dashboard read model (runner.json)", feature: f(QR, 9), state: "ready" },
  { repo: QR, n: 6, title: "Settle threads through T3's API", feature: f(QR, 9), state: "ready" },
  { repo: QR, n: 7, title: "Dashboard page", feature: f(QR, 9), state: "blocked", blockedBy: [f(QR, 5)] },
  { repo: QR, n: 8, title: "Review rounds report", feature: f(QR, 9), state: "blocked", blockedBy: [f(QR, 6), f(QR, 7)] },
  { repo: QR, n: 3, title: "Wake tasks survive DST", state: "review", pr: 4, reason: "Clean; checks running" },
];

const claudeGates = (): Gate[] => [
  { label: "5-hour", ok: true, note: "38% + 22% for a fix round ≤ 100%" },
  { label: "Week", ok: true, note: "46% + 6%, leaving your 5%" },
  { label: "T3", ok: true },
  { label: "Not stopped", ok: true },
];
const solGates = (): Gate[] => [
  { label: "ChatGPT usage", ok: true, note: "26% of 5 hours" },
  { label: "T3", ok: true },
  { label: "Not stopped", ok: true },
];

const CONNECTIONS: Connection[] = [
  { id: "t3", name: "T3 Code", role: "Runs Claude's threads", ok: true, status: "Server up", how: [["Via", "~/.t3/bin/t3.cmd thread start --wait --json"], ["Projects", "leads-dashboard, queue-runner"], ["Worktrees", "~/.t3/worktrees/<project>/<branch>"]] },
  { id: "claude", name: "Claude", role: "Builder", ok: true, status: "Opus 5.5 · medium", how: [["Runs in", "T3, provider claudeAgent, model claude-opus-5-5"], ["Usage from", "api.anthropic.com/api/oauth/usage"], ["Login", "Claude Code's, in ~/.claude/.credentials.json"]] },
  { id: "chatgpt", name: "ChatGPT", role: "Reviewer (Sol)", ok: true, status: "GPT-6.1 Sol · high", how: [["Runs via", "~/codex-sol.sh --job review --effort high, in Git bash"], ["Sandbox", "checkout writable, network off"], ["Usage from", "newest rate_limits in ~/.codex/sessions"]] },
  { id: "github", name: "GitHub", role: "Issues, PRs, merges", ok: true, status: "gh as stefan1575", how: [["Via", "gh api"], ["Repos", "2 served"]] },
  { id: "windows", name: "Windows", role: "Toasts, wake", ok: true, status: "1 wake task set", how: [["Toasts", "as “Queue runner” (Stefan.QueueRunner)"], ["Wake", "Task Scheduler \\Queue runner\\"]] },
];

export function baseWorld(): World {
  return structuredClone({
    repos: REPOS,
    runner: { process: "running", since: "08:01", lastSeen: "14:40", reserve: 5, github: { ok: true } },
    claude: {
      status: "working",
      job: { kind: "build", repo: LD, ref: "#212", title: "Archive view for old callers", since: "14:05", minutes: 35, thread: "Queue runner build: leads-dashboard#212" },
      headline: "Building #212 Archive view for old callers",
      next: "Fix round on PR #204",
      gates: claudeGates(),
    },
    sol: {
      status: "working",
      job: { kind: "review", repo: LD, ref: "PR #210", pr: 210, title: "Callers list: filter by tag", since: "14:28", minutes: 12, sha: "4be91c2", round: 1 },
      headline: "Reviewing PR #210 at 4be91c2",
      next: "Nothing else waits for review",
      gates: solGates(),
    },
    usage: {
      claude: { five: { used: 38, resets: "15:40" }, week: { used: 46, resets: "Mon 16:20" }, readAt: "14:39", releaseAt: "Sun 16:20" },
      chatgpt: { five: { used: 26, resets: "16:14" }, week: { used: 6, resets: "Fri 23:32" }, readAt: "14:31" },
    },
    asks: ASKS,
    features: FEATURES,
    issues: ISSUES,
    prs: PRS,
    digest: {
      since: "09:12",
      rows: [
        { at: "14:12", actor: "sol", repo: QR, text: "PR #4 clean on first review", pr: 4, tone: "ok", group: "reviewed" },
        { at: "14:05", actor: "claude", repo: LD, text: "#211 hit the usage limit at 09:01 and resumed in place", tone: "warn", group: "recovered" },
        { at: "14:00", actor: "runner", repo: LD, text: "PR #207 marked ready for you", pr: 207, tone: "you", group: "reviewed" },
        { at: "13:52", actor: "sol", repo: LD, text: "PR #207 clean on review 2", pr: 207, tone: "ok", group: "reviewed" },
        { at: "13:30", actor: "claude", repo: QR, text: "Built #3, opened PR #4", pr: 4, tone: "ok", group: "built" },
        { at: "13:15", actor: "sol", repo: LD, text: "PR #204 blocking: 2 Important", pr: 204, tone: "bad", group: "reviewed" },
        { at: "12:58", actor: "claude", repo: LD, text: "#214's build asked a question; left to you", tone: "you", group: "stopped" },
        { at: "12:32", actor: "runner", repo: LD, text: "PR #152 stopped for you (approach note)", pr: 152, tone: "you", group: "stopped" },
        { at: "12:10", actor: "claude", repo: LD, text: "Built #205, opened PR #210", pr: 210, tone: "ok", group: "built" },
        { at: "10:40", actor: "you", repo: QR, text: "PR #2 merged; the runner restarted on 66a5ea1", tone: "ok", group: "merged" },
      ],
    },
    connections: CONNECTIONS,
  } satisfies World);
}

// --------------------------------------------------------------- demo states
type Demo = { label: string; group: string; make: () => World; pr?: [string, number] };

const issue = (w: World, repo: string, n: number) => w.issues.find((i) => i.repo === repo && i.n === n)!;
const pr = (w: World, repo: string, n: number) => w.prs.find((p) => p.repo === repo && p.n === n)!;
const gate = (w: World, lane: "claude" | "sol", label: string, note: string) => {
  const g = w[lane].gates.find((x) => x.label === label)!;
  g.ok = false;
  g.note = note;
};

export const DEMOS: Record<string, Demo> = {
  normal: { group: "Everyday", label: "Three asks, both lanes working", make: baseWorld },
  "all-clear": {
    group: "Everyday",
    label: "Nothing needs you",
    make: () => {
      const w = baseWorld();
      w.asks = [];
      issue(w, LD, 191).state = "done";
      issue(w, LD, 150).state = "fixing"; issue(w, LD, 150).reason = "You said rework; fix round queued";
      issue(w, LD, 214).state = "ready"; issue(w, LD, 214).reason = undefined;
      const p = pr(w, LD, 152); p.held = undefined; p.ask = undefined;
      const q = pr(w, LD, 207); q.phase = "merged"; q.live = "live"; q.ask = undefined; q.gate = undefined;
      return w;
    },
  },
  "ten-repos": {
    group: "Everyday",
    label: "Ten repositories",
    make: () => {
      const w = baseWorld();
      w.repos = [...w.repos, ...EXTRA_REPOS];
      w.asks.push({ id: "ask-ops", kind: "decide", repo: "royal-bully-ops", ref: "PR #31", pr: 31, title: "Sol flagged the same class twice on PR #31", why: ["Review 2 reopened a finding Claude declined."], since: "1d", action: "Reply on #33" });
      return w;
    },
  },
  "you-stopped-sol": {
    group: "Stopping",
    label: "You stopped Sol now",
    make: () => {
      const w = baseWorld();
      w.sol = { ...w.sol, status: "stopped", job: undefined, headline: "Stopped by you at 14:38", next: "PR #210's review was cut off; it's reviewed afresh on 4be91c2 when you resume" };
      gate(w, "sol", "Not stopped", "You stopped it at 14:38");
      return w;
    },
  },
  "claude-stopping": {
    group: "Stopping",
    label: "Claude stops after this job",
    make: () => {
      const w = baseWorld();
      w.claude.status = "stopping";
      w.claude.next = "Then stops. Nothing new starts until you resume";
      gate(w, "claude", "Not stopped", "Stops after #212's build");
      return w;
    },
  },
  "claude-gated": {
    group: "Waiting",
    label: "Claude waits: 5-hour window",
    make: () => {
      const w = baseWorld();
      w.usage.claude.five.used = 82;
      w.claude = { ...w.claude, status: "waiting", job: undefined, until: "15:42", headline: "Waiting for the 5-hour window", next: "Fix round on PR #204 at 15:42" };
      gate(w, "claude", "5-hour", "82% + 22% > 100%: waits for the 15:40 reset");
      issue(w, LD, 212).state = "ready";
      return w;
    },
  },
  "claude-reserve": {
    group: "Waiting",
    label: "Claude waits: your weekly reserve",
    make: () => {
      const w = baseWorld();
      w.usage.claude.week.used = 93;
      w.claude = { ...w.claude, status: "waiting", job: undefined, until: "Sun 16:20", headline: "Waiting: the rest of the week is yours", next: "Fix round on PR #204 when the reserve opens" };
      gate(w, "claude", "Week", "93% + 6% would eat your 5%; opens Sun 16:20");
      issue(w, LD, 212).state = "ready";
      return w;
    },
  },
  "claude-limit": {
    group: "Waiting",
    label: "Claude hit a usage limit",
    make: () => {
      const w = baseWorld();
      w.usage.claude.five.used = 100;
      w.claude = { ...w.claude, status: "waiting", until: "15:50", headline: "#212's build hit Claude's usage limit", next: "Continues in the same thread at 15:50 (context 41k, small enough)" };
      gate(w, "claude", "5-hour", "Limit hit; resumes 10 min after the 15:40 reset");
      return w;
    },
  },
  "sol-out": {
    group: "Waiting",
    label: "Sol out of ChatGPT usage",
    make: () => {
      const w = baseWorld();
      w.usage.chatgpt.five.used = 100;
      w.sol = { ...w.sol, status: "waiting", job: undefined, until: "16:24", headline: "Out of ChatGPT usage", next: "PR #210 reviewed afresh at 16:24; merges wait too" };
      gate(w, "sol", "ChatGPT usage", "100% of 5 hours; back 10 min after 16:14");
      issue(w, LD, 205).reason = "Waits for Sol (16:24)";
      return w;
    },
  },
  "decision-running": {
    group: "Claude jobs",
    label: "Decision thread running",
    make: () => {
      const w = baseWorld();
      w.asks = w.asks.filter((a) => a.id !== "ask-214");
      w.claude = { ...w.claude, job: { kind: "decision", repo: LD, ref: "#214", title: "Client onboarding form", since: "14:36", minutes: 4, thread: "Queue runner decision: leads-dashboard#214" }, headline: "Deciding on #214's question", next: "Answers it, or leaves it to you" };
      issue(w, LD, 214).state = "building"; issue(w, LD, 214).reason = "A decision thread is reading its question";
      issue(w, LD, 212).state = "ready";
      return w;
    },
  },
  "conflict-round": {
    group: "Claude jobs",
    label: "Conflict round",
    make: () => {
      const w = baseWorld();
      w.claude = { ...w.claude, job: { kind: "conflict", repo: QR, ref: "PR #4", pr: 4, title: "Wake tasks survive DST", since: "14:31", minutes: 9, sha: "9c1e2aa" }, headline: "Merging main into PR #4", next: "Fix round on PR #204" };
      issue(w, LD, 212).state = "ready";
      issue(w, QR, 3).state = "fixing"; issue(w, QR, 3).reason = "Conflict round: merging main in";
      return w;
    },
  },
  "live-partial": {
    group: "Claude jobs",
    label: "Live steps stopped halfway",
    pr: [LD, 207],
    make: () => {
      const w = baseWorld();
      w.asks = w.asks.filter((a) => a.id !== "ask-207");
      w.asks.unshift({ id: "ask-live", kind: "live", repo: LD, ref: "PR #207", pr: 207, title: "Live steps for PR #207 stopped halfway", why: ["Deployed; 1 of 2 migrations applied.", "20261114_number_owner.sql failed: column \"owner_id\" already exists."], since: "6m", action: "Open #222" });
      const p = pr(w, LD, 207);
      p.phase = "merged"; p.gate = undefined; p.ask = "ask-live"; p.live = "needs-attention"; p.next = "Merged, not fully live. No live run starts in leads-dashboard until you answer #222.";
      p.timeline.push(
        { at: "Sat 14:18", actor: "you", kind: "merge", sha: "a0d5f6f", tone: "ok", title: "You merged it" },
        { at: "Sat 14:33", actor: "claude", kind: "live", sha: "2be7a90", tone: "bad", title: "Live: partial", detail: "1 of 2 migrations applied" },
      );
      issue(w, LD, 191).state = "you"; issue(w, LD, 191).reason = "Live steps need you";
      return w;
    },
  },
  "github-down": {
    group: "Runner",
    label: "GitHub unreadable",
    make: () => {
      const w = baseWorld();
      w.runner.github = { ok: false, note: "No answer since 14:22 (HTTP 503). Asks and PRs are as of 14:21." };
      w.connections.find((c) => c.id === "github")!.ok = false;
      w.connections.find((c) => c.id === "github")!.status = "HTTP 503 since 14:22";
      return w;
    },
  },
  "usage-unreadable": {
    group: "Runner",
    label: "Claude usage unreadable",
    make: () => {
      const w = baseWorld();
      w.usage.claude.five.used = null; w.usage.claude.week.used = null; w.usage.claude.error = "HTTP 401: login expired";
      w.claude = { ...w.claude, status: "unavailable", job: undefined, headline: "Can't read Claude's usage", next: "Starts nothing until it can. Running Claude Code once refreshes the login" };
      gate(w, "claude", "5-hour", "Unreadable (HTTP 401)");
      w.connections.find((c) => c.id === "claude")!.ok = false;
      w.connections.find((c) => c.id === "claude")!.status = "Login expired";
      issue(w, LD, 212).state = "ready";
      return w;
    },
  },
  "waiting-t3": {
    group: "Runner",
    label: "Starting: waiting for T3",
    make: () => {
      const w = baseWorld();
      w.runner.process = "starting"; w.runner.since = "14:38"; w.runner.note = "Waiting for T3's server; asking every 30 s";
      w.claude = { ...w.claude, status: "unavailable", job: undefined, headline: "Waiting for T3", next: "First pass once T3 answers" };
      w.sol = { ...w.sol, status: "unavailable", job: undefined, headline: "Waiting for T3", next: "First pass once T3 answers" };
      gate(w, "claude", "T3", "Connection refused"); gate(w, "sol", "T3", "Connection refused");
      w.connections[0].ok = false; w.connections[0].status = "Not answering";
      issue(w, LD, 212).state = "ready";
      return w;
    },
  },
  stopped: {
    group: "Runner",
    label: "Runner not running",
    make: () => {
      const w = baseWorld();
      w.runner.process = "stopped"; w.runner.lastSeen = "13:58"; w.runner.note = "Last seen 13:58; the log ends with “runner stopped on an error”";
      w.claude = { ...w.claude, status: "unavailable", next: "This build runs on in T3; the next runner settles it" };
      w.sol = { ...w.sol, status: "unavailable", job: undefined, headline: "Not running", next: "PR #210's review counts as failed" };
      return w;
    },
  },
};

export const DEMO_GROUPS = ["Everyday", "Stopping", "Waiting", "Claude jobs", "Runner"];
