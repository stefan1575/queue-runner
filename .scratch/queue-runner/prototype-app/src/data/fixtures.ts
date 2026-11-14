// Fake data shaped like the runner's own records (~/.queue-runner/state/jobs.jsonl outcomes,
// config.toml repos, the usage gate). "Now" is Sat 14 Nov 2026, 14:40.
import type { Ask, ActivityRow, Issue, PR, Repo, World } from "./types";

const LD = "leads-dashboard";
const QR = "queue-runner";

export const REPOS: Repo[] = [
  {
    id: LD,
    github: "RoyalBullyAgency-RBA/leads-dashboard",
    path: "~/Code/Work/leads-dashboard",
    base: "main",
    merge: "stefan",
    issues: "github",
    liveDoc: "docs/agents/lovable-cloud.md",
    readable: true,
  },
  {
    id: QR,
    github: "stefan1575/queue-runner",
    path: "~/Code/Personal/queue-runner",
    base: "main",
    merge: "runner",
    issues: "github",
    readable: true,
  },
];

const EXTRA_REPOS: Repo[] = [
  ["royal-bully-ops", "RoyalBullyAgency-RBA/royal-bully-ops"],
  ["callsling-relay", "RoyalBullyAgency-RBA/callsling-relay"],
  ["client-portal", "RoyalBullyAgency-RBA/client-portal"],
  ["personal-ops", "stefan1575/personal-ops"],
  ["n8n-flows", "RoyalBullyAgency-RBA/n8n-flows"],
  ["twilio-voice-agent", "RoyalBullyAgency-RBA/twilio-voice-agent"],
  ["dotfiles", "stefan1575/dotfiles"],
  ["seo-audits", "RoyalBullyAgency-RBA/seo-audits"],
].map(([id, github]) => ({
  id,
  github,
  path: `~/Code/${github.startsWith("stefan") ? "Personal" : "Work"}/${id}`,
  base: "main",
  merge: "runner" as const,
  issues: "github" as const,
  readable: true,
}));

const ASKS: Ask[] = [
  {
    id: "ask-152",
    kind: "decide",
    repo: LD,
    ref: "PR #152",
    prHref: `/pr/${LD}/152`,
    title: "Sol is still blocking PR #152 after three reviews",
    why: [
      "Review 3 on 7d21e04 raised I-4 again: the ring-to check still reads the Client's owner from before the move.",
      "A decision thread wrote an approach note and recommends rework.",
    ],
    options: [
      { label: "rework", means: "One more fix round that changes the approach, as the note says", recommended: true },
      { label: "fix on", means: "One more fix round on the same approach" },
      { label: "hold", means: "Leave the PR until you release it" },
    ],
    blocks: ["#216 Ring-to audit page"],
    since: "2 h",
    action: { label: "Reply on the needs-info issue", where: "GitHub #219" },
  },
  {
    id: "ask-207",
    kind: "merge",
    repo: LD,
    ref: "PR #207",
    prHref: `/pr/${LD}/207`,
    title: "PR #207 is ready for you to merge",
    why: ["Sol's review is clean on a0d5f6f, its newest commit.", "Checks passed on a0d5f6f; no conflict with main; nothing said since the review."],
    since: "40 min",
    action: { label: "Open PR #207", where: "GitHub" },
  },
  {
    id: "ask-214",
    kind: "answer",
    repo: LD,
    ref: "#214",
    title: "The onboarding-form build asks whether every Client must fill it in",
    why: [
      "The build stopped before writing the form's required fields and is waiting for an answer.",
      "A decision thread couldn't answer it from the issue, so it's yours.",
    ],
    blocks: ["#215 SEO questions on the onboarding form"],
    since: "12 min",
    action: { label: "Answer in the build's thread", where: "T3" },
  },
];

const ISSUES: Issue[] = [
  { repo: LD, n: 212, title: "Archive view for old callers", state: "in-progress", reason: "Claude is building it" },
  { repo: LD, n: 213, title: "Domain health check on the Domains tab", state: "ready" },
  { repo: LD, n: 205, title: "Callers list: filter by tag", state: "in-progress", pr: 210, reason: "PR #210 in review" },
  { repo: LD, n: 150, title: "Ring-to number per Client", state: "in-progress", pr: 152, reason: "PR #152 waits for your decision" },
  { repo: LD, n: 191, title: "A Client's Twilio number on their page", state: "in-progress", pr: 207, reason: "PR #207 is ready for you to merge" },
  { repo: LD, n: 199, title: "Unassigned: assign several messages at once", state: "in-progress", pr: 204, reason: "PR #204: a fix round is next" },
  { repo: LD, n: 214, title: "Client onboarding form", state: "held", reason: "Its build waits for your answer" },
  { repo: LD, n: 215, title: "SEO questions on the onboarding form", state: "blocked", blockedBy: [`${LD}#214`] },
  { repo: LD, n: 216, title: "Ring-to audit page", state: "blocked", blockedBy: [`${LD}#150`] },
  { repo: LD, n: 217, title: "Spec: lead routing v2", state: "not-ready", reason: "A spec with 4 open sub-issues: its children are the work" },
  { repo: LD, n: 218, title: "Export calls as CSV", state: "not-ready", reason: "Not marked ready-for-agent" },
  { repo: QR, n: 5, title: "Dashboard read model (runner.json)", state: "ready" },
  { repo: QR, n: 6, title: "Settle finished threads through T3's API", state: "ready" },
  { repo: QR, n: 3, title: "Wake tasks survive a DST change", state: "in-progress", pr: 4, reason: "PR #4 is clean; checks are running" },
  { repo: QR, n: 7, title: "Dashboard page", state: "blocked", blockedBy: [`${QR}#5`] },
  { repo: QR, n: 8, title: "Report: review rounds and usage by job kind", state: "blocked", blockedBy: [`${QR}#6`, `${QR}#7`] },
  { repo: LD, n: 209, title: "Screenshot links in PR bodies", state: "done", pr: 209, reason: "Merged; live" },
];

const PRS: PR[] = [
  {
    repo: LD,
    n: 152,
    title: "Ring-to number per Client",
    issue: 150,
    branch: "claude/ring-to-number-150",
    head: "7d21e04",
    phase: "fixing",
    held: "Waiting for your answer to the approach note",
    next: "Nothing happens until you answer: rework or fix on gets one more fix round; hold leaves it.",
    ask: "ask-152",
    commits: 9,
    files: 14,
    timeline: [
      { at: "Tue 09:12", actor: "claude", kind: "build", sha: "e18a3c0", tone: "ok", title: "Built and opened PR #152", detail: "5 commits · thread “Queue runner build: leads-dashboard#150”" },
      { at: "Tue 09:40", actor: "sol", kind: "review", sha: "e18a3c0", round: 1, tone: "bad", title: "Review 1: blocking", detail: "2 Important, 1 nit", findings: [
        { id: "I-1", sev: "Important", status: "fixed", text: "Ring-to number saved without E.164 normalisation", where: "src/lib/ring-to.ts:41" },
        { id: "I-2", sev: "Important", status: "fixed", text: "Owner check reads the Client from before the move", where: "src/routes/_authed/clients.$clientId.tsx:118" },
        { id: "N-1", sev: "Nit", status: "open", text: "Rename ringTo → ringToNumber for the glossary" },
      ] },
      { at: "Tue 10:05", actor: "claude", kind: "fix", sha: "e18a3c0", round: 1, tone: "ok", title: "Fix round 1 pushed 2 commits", detail: "e18a3c0 → 3b9f7a2" },
      { at: "Tue 10:31", actor: "sol", kind: "review", sha: "3b9f7a2", round: 2, tone: "bad", title: "Review 2: blocking", detail: "1 Important", findings: [
        { id: "I-3", sev: "Important", status: "fixed", text: "Migration adds a NOT NULL column without a default", where: "supabase/migrations/20261110_ring_to.sql:3" },
      ] },
      { at: "Tue 11:02", actor: "claude", kind: "fix", sha: "3b9f7a2", round: 2, tone: "ok", title: "Fix round 2 pushed 2 commits", detail: "3b9f7a2 → 7d21e04" },
      { at: "Sat 12:20", actor: "sol", kind: "review", sha: "7d21e04", round: 3, tone: "bad", title: "Review 3: still blocking", detail: "I-4 repeats I-2's class", findings: [
        { id: "I-4", sev: "Important", status: "open", text: "Ring-to check still reads the pre-move owner when the Client is reassigned mid-call", where: "src/lib/ring-to.ts:77" },
      ] },
      { at: "Sat 12:31", actor: "claude", kind: "decision", sha: "7d21e04", tone: "info", title: "Decision thread wrote an approach note", detail: "Recommends rework: read the owner from the call's routing row, not the Client" },
      { at: "Sat 12:32", actor: "runner", kind: "stop", sha: "7d21e04", tone: "you", title: "Stopped for you: approach-note", detail: "Filed on needs-info issue #219; toast sent" },
    ],
  },
  {
    repo: LD,
    n: 207,
    title: "A Client's Twilio number on their page",
    issue: 191,
    branch: "claude/a-client-s-twilio-191",
    head: "a0d5f6f",
    phase: "ready",
    gate: "Ready for your merge",
    live: "pending",
    next: "Merge it on GitHub. The runner notices on its next pass, then runs the live steps.",
    ask: "ask-207",
    commits: 6,
    files: 8,
    timeline: [
      { at: "Fri 16:02", actor: "claude", kind: "build", sha: "5c0e11b", tone: "ok", title: "Built and opened PR #207", detail: "4 commits" },
      { at: "Fri 16:30", actor: "sol", kind: "review", sha: "5c0e11b", round: 1, tone: "bad", title: "Review 1: blocking", detail: "1 Important", findings: [
        { id: "I-1", sev: "Important", status: "fixed", text: "Twilio number shown to users without the Client's permission", where: "src/components/client-flag.tsx:52" },
      ] },
      { at: "Fri 17:05", actor: "claude", kind: "fix", sha: "5c0e11b", round: 1, tone: "ok", title: "Fix round 1 pushed 2 commits", detail: "5c0e11b → a0d5f6f" },
      { at: "Sat 13:40", actor: "github", kind: "checks", sha: "a0d5f6f", tone: "ok", title: "Checks passed", detail: "tests (ubuntu), typecheck, lint" },
      { at: "Sat 13:52", actor: "sol", kind: "review", sha: "a0d5f6f", round: 2, tone: "ok", title: "Review 2: clean", detail: "I-1 fixed; no Important finding open" },
      { at: "Sat 14:00", actor: "runner", kind: "ready", sha: "a0d5f6f", tone: "you", title: "Marked ready-for-stefan", detail: "Re-check passed: open, at a0d5f6f, checks passed, no conflict, nothing said since review 2. Toast sent." },
    ],
  },
  {
    repo: LD,
    n: 210,
    title: "Callers list: filter by tag",
    issue: 205,
    branch: "claude/callers-list-filter-205",
    head: "4be91c2",
    phase: "reviewing",
    next: "Sol is reviewing 4be91c2. Clean: it's marked ready for you. Blocking: a fix round.",
    commits: 3,
    files: 5,
    timeline: [
      { at: "Sat 12:10", actor: "claude", kind: "build", sha: "4be91c2", tone: "ok", title: "Built and opened PR #210", detail: "3 commits" },
      { at: "Sat 13:58", actor: "github", kind: "checks", sha: "4be91c2", tone: "ok", title: "Checks passed" },
      { at: "Sat 14:28", actor: "sol", kind: "review", sha: "4be91c2", round: 1, tone: "run", title: "Review 1 running", detail: "Sol has the checkout at 4be91c2 and can run npm test", running: true },
    ],
  },
  {
    repo: LD,
    n: 204,
    title: "Unassigned: assign several messages at once",
    issue: 199,
    branch: "claude/unassigned-bulk-199",
    head: "c71d0a9",
    phase: "fixing",
    next: "A fix round on c71d0a9 is the next Claude job, once the build of #212 ends.",
    commits: 7,
    files: 9,
    timeline: [
      { at: "Thu 10:00", actor: "claude", kind: "build", sha: "91ab3e2", tone: "ok", title: "Built and opened PR #204" },
      { at: "Thu 10:41", actor: "sol", kind: "review", sha: "91ab3e2", round: 1, tone: "bad", title: "Review 1: blocking", detail: "1 Important", findings: [
        { id: "I-1", sev: "Important", status: "fixed", text: "Bulk assign ignores messages already claimed", where: "src/lib/routing.ts:203" },
      ] },
      { at: "Thu 11:20", actor: "claude", kind: "fix", sha: "91ab3e2", round: 1, tone: "ok", title: "Fix round 1 pushed 3 commits", detail: "91ab3e2 → c71d0a9" },
      { at: "Sat 13:15", actor: "sol", kind: "review", sha: "c71d0a9", round: 2, tone: "bad", title: "Review 2: blocking", detail: "2 Important, 1 Pre-existing filed as #220", findings: [
        { id: "I-2", sev: "Important", status: "open", text: "Selection survives a filter change and assigns hidden rows", where: "src/components/message-list.tsx:144" },
        { id: "I-3", sev: "Important", status: "open", text: "No test for assigning across two Clients", where: "src/test/routing.test.ts" },
        { id: "P-1", sev: "Pre-existing", status: "filed", text: "Unread count lags one poll behind", where: "#220" },
      ] },
    ],
  },
  {
    repo: LD,
    n: 209,
    title: "Screenshot links in PR bodies",
    issue: 209,
    branch: "claude/pr-screenshot-links",
    head: "b434ec4",
    phase: "merged",
    live: "live",
    next: "Merged and live. Nothing left to do.",
    commits: 2,
    files: 3,
    timeline: [
      { at: "Thu 13:10", actor: "claude", kind: "build", sha: "b434ec4", tone: "ok", title: "Built and opened PR #209" },
      { at: "Thu 13:50", actor: "sol", kind: "review", sha: "b434ec4", round: 1, tone: "ok", title: "Review 1: clean" },
      { at: "Thu 13:52", actor: "runner", kind: "ready", sha: "b434ec4", tone: "you", title: "Marked ready-for-stefan" },
      { at: "Thu 14:34", actor: "you", kind: "merge", sha: "b434ec4", tone: "ok", title: "You merged it", detail: "Merge commit 0f3c2d1" },
      { at: "Thu 15:02", actor: "claude", kind: "live", sha: "0f3c2d1", tone: "ok", title: "Live: batch 0f3c2d1", detail: "Deployed on Lovable Cloud; 1 migration applied; check:live-schema passed" },
    ],
  },
  {
    repo: QR,
    n: 4,
    title: "Wake tasks survive a DST change",
    issue: 3,
    branch: "claude/wake-tasks-dst-3",
    head: "9c1e2aa",
    phase: "ready",
    gate: "Clean, waiting for checks",
    next: "Clean on 9c1e2aa. The runner merges it itself once the tests pass on 9c1e2aa.",
    commits: 2,
    files: 3,
    timeline: [
      { at: "Sat 13:30", actor: "claude", kind: "build", sha: "9c1e2aa", tone: "ok", title: "Built and opened PR #4" },
      { at: "Sat 14:12", actor: "sol", kind: "review", sha: "9c1e2aa", round: 1, tone: "ok", title: "Review 1: clean", detail: "1 nit" },
      { at: "Sat 14:13", actor: "github", kind: "checks", sha: "9c1e2aa", tone: "run", title: "Checks running", detail: "tests (windows-latest) · 6 min so far", running: true },
    ],
  },
];

const ACTIVITY: ActivityRow[] = [
  { day: "Today", at: "14:28", actor: "sol", repo: LD, kind: "review", ref: "PR #210", href: `/pr/${LD}/210`, text: "Started review 1 of PR #210 at 4be91c2", outcome: "start", tone: "run" },
  { day: "Today", at: "14:12", actor: "sol", repo: QR, kind: "review", ref: "PR #4", href: `/pr/${QR}/4`, text: "Review 1 of PR #4: clean on 9c1e2aa", outcome: "clean", tone: "ok" },
  { day: "Today", at: "14:05", actor: "claude", repo: LD, kind: "build", ref: "#212", text: "Started building #212 Archive view for old callers", outcome: "start", tone: "run" },
  { day: "Today", at: "14:00", actor: "runner", repo: LD, kind: "ready", ref: "PR #207", href: `/pr/${LD}/207`, text: "Marked PR #207 ready for you to merge", outcome: "marked", tone: "you" },
  { day: "Today", at: "13:52", actor: "sol", repo: LD, kind: "review", ref: "PR #207", href: `/pr/${LD}/207`, text: "Review 2 of PR #207: clean on a0d5f6f", outcome: "clean", tone: "ok" },
  { day: "Today", at: "13:30", actor: "claude", repo: QR, kind: "build", ref: "PR #4", href: `/pr/${QR}/4`, text: "Built #3 and opened PR #4", outcome: "done", tone: "ok" },
  { day: "Today", at: "13:15", actor: "sol", repo: LD, kind: "review", ref: "PR #204", href: `/pr/${LD}/204`, text: "Review 2 of PR #204: blocking, 2 Important", outcome: "blocking", tone: "bad" },
  { day: "Today", at: "12:58", actor: "claude", repo: LD, kind: "build", ref: "#214", text: "Build of #214 is waiting for an answer; a decision left it to you", outcome: "waiting", tone: "you" },
  { day: "Today", at: "12:32", actor: "runner", repo: LD, kind: "stop", ref: "PR #152", href: `/pr/${LD}/152`, text: "Stopped PR #152 for you (approach note), filed on #219", outcome: "filed", tone: "you" },
  { day: "Today", at: "12:20", actor: "sol", repo: LD, kind: "review", ref: "PR #152", href: `/pr/${LD}/152`, text: "Review 3 of PR #152: still blocking", outcome: "approach-note", tone: "bad" },
  { day: "Today", at: "12:10", actor: "claude", repo: LD, kind: "build", ref: "PR #210", href: `/pr/${LD}/210`, text: "Built #205 and opened PR #210", outcome: "done", tone: "ok" },
  { day: "Today", at: "09:01", actor: "claude", repo: LD, kind: "build", ref: "#211", text: "Build of #211 hit the usage limit; resumed in place at 14:05", outcome: "usage-limit", tone: "warn" },
  { day: "Yesterday", at: "17:05", actor: "claude", repo: LD, kind: "fix", ref: "PR #207", href: `/pr/${LD}/207`, text: "Fix round 1 on PR #207 pushed 2 commits", outcome: "pushed", tone: "ok" },
  { day: "Yesterday", at: "16:30", actor: "sol", repo: LD, kind: "review", ref: "PR #207", href: `/pr/${LD}/207`, text: "Review 1 of PR #207: blocking, 1 Important", outcome: "blocking", tone: "bad" },
  { day: "Wed 12 Nov", at: "15:02", actor: "claude", repo: LD, kind: "live", ref: "PR #209", href: `/pr/${LD}/209`, text: "Live steps for PR #209: deployed, 1 migration applied", outcome: "live", tone: "ok" },
  { day: "Wed 12 Nov", at: "14:34", actor: "you", repo: LD, kind: "merge", ref: "PR #209", href: `/pr/${LD}/209`, text: "You merged PR #209", outcome: "merged", tone: "ok" },
];

export function baseWorld(): World {
  return structuredClone({
    repos: REPOS,
    runner: {
      process: "running",
      pid: 18244,
      since: "08:01",
      connection: "live",
      lastSeen: "14:40",
      claudePaused: false,
      reserve: 5,
      github: { ok: true },
    },
    claude: {
      status: "working",
      job: {
        kind: "build",
        repo: LD,
        ref: "#212",
        title: "Archive view for old callers",
        since: "14:05",
        elapsed: "35 min",
        thread: "Queue runner build: leads-dashboard#212",
      },
      headline: "Building #212 Archive view for old callers",
      next: "Then: fix round on PR #204",
    },
    sol: {
      status: "working",
      job: {
        kind: "review",
        repo: LD,
        ref: "PR #210",
        href: `/pr/${LD}/210`,
        title: "Callers list: filter by tag",
        since: "14:28",
        elapsed: "12 min",
        sha: "4be91c2",
        round: 1,
      },
      headline: "Reviewing PR #210 at 4be91c2",
      next: "Then: nothing waiting for review",
    },
    usage: {
      readable: true,
      readAt: "14:39",
      five: { used: 38, resets: "15:40" },
      week: { used: 46, resets: "Mon 17 Nov, 16:20", releaseAt: "Sun 16 Nov, 16:20" },
      costs: [
        { kind: "Build", five: 34, week: 9, source: "learned", n: 7 },
        { kind: "Fix round", five: 22, week: 6, source: "learned", n: 4 },
        { kind: "Decision", five: 15, week: 4, source: "default", n: 1 },
        { kind: "Live steps", five: 20, week: 5, source: "default", n: 2 },
      ],
      sol: { available: true },
    },
    asks: ASKS,
    issues: ISSUES,
    prs: PRS,
    activity: ACTIVITY,
    nextClaude: { text: "Fix round on leads-dashboard PR #204 (review 2 blocking)", href: `/pr/${LD}/204` },
  } satisfies World);
}

// --------------------------------------------------------------- demo states
type Demo = { label: string; group: string; make: () => World; go?: string };

const pr = (w: World, repo: string, n: number) => w.prs.find((p) => p.repo === repo && p.n === n)!;
const issue = (w: World, repo: string, n: number) => w.issues.find((i) => i.repo === repo && i.n === n)!;

export const DEMOS: Record<string, Demo> = {
  normal: { group: "Everyday", label: "Three asks, both lanes working", make: baseWorld },
  "all-clear": {
    group: "Everyday",
    label: "Nothing needs you",
    make: () => {
      const w = baseWorld();
      w.asks = [];
      const p207 = pr(w, LD, 207);
      p207.phase = "merged"; p207.live = "live"; p207.ask = undefined; p207.gate = undefined; p207.next = "Merged and live.";
      issue(w, LD, 191).state = "done";
      const p152 = pr(w, LD, 152);
      p152.held = undefined; p152.ask = undefined; p152.next = "You answered rework: one more fix round is queued after #204's.";
      issue(w, LD, 214).state = "ready"; issue(w, LD, 214).reason = undefined;
      return w;
    },
  },
  "empty-queue": {
    group: "Everyday",
    label: "Queue empty",
    make: () => {
      const w = baseWorld();
      w.asks = [];
      w.issues = w.issues.filter((i) => i.state !== "ready" && i.state !== "held").map((i) => (i.state === "blocked" ? { ...i, state: "not-ready" as const, reason: "Not marked ready-for-agent", blockedBy: undefined } : i));
      w.claude = { status: "idle", headline: "Nothing to do", next: "Looks again every 5 minutes (poll_seconds). Mark an issue ready-for-agent to queue it." };
      w.sol = { status: "idle", headline: "Nothing to review", next: "Reviews a PR once its checks report." };
      w.nextClaude = null;
      w.prs = w.prs.filter((p) => p.phase === "merged");
      return w;
    },
  },
  "many-repos": {
    group: "Everyday",
    label: "Ten repositories",
    make: () => {
      const w = baseWorld();
      w.repos = [...w.repos, ...EXTRA_REPOS];
      w.asks.push({ id: "ask-ops", kind: "decide", repo: "royal-bully-ops", ref: "PR #31", title: "Sol flagged the same class twice on PR #31", why: ["Review 2 reopened a finding Claude declined."], since: "1 d", action: { label: "Reply on the needs-info issue", where: "GitHub #33" } });
      w.issues.push({ repo: "client-portal", n: 12, title: "Invoice page", state: "ready" }, { repo: "n8n-flows", n: 4, title: "Retry webhook on 502", state: "ready" });
      return w;
    },
  },
  "claude-gated": {
    group: "Claude lane",
    label: "Waiting for the 5-hour window",
    make: () => {
      const w = baseWorld();
      w.usage.five.used = 82;
      w.claude = { status: "waiting", until: "15:42", headline: "Waiting for room in the 5-hour window", next: "The window is at 82%; a fix round is expected to need 22%. Starts at 15:42, after the reset." };
      issue(w, LD, 212).state = "ready"; issue(w, LD, 212).reason = undefined;
      return w;
    },
  },
  "claude-reserve": {
    group: "Claude lane",
    label: "Waiting: weekly reserve",
    make: () => {
      const w = baseWorld();
      w.usage.week.used = 93;
      w.claude = { status: "waiting", until: "Sun 16:20", headline: "Waiting: the rest of the week is your reserve", next: "Week at 93%; a fix round needs 6% and 5% stays yours. Your reserve opens Sun 16 Nov, 16:20 (24 hours before the reset)." };
      issue(w, LD, 212).state = "ready"; issue(w, LD, 212).reason = undefined;
      return w;
    },
  },
  "claude-paused": {
    group: "Claude lane",
    label: "You paused Claude",
    make: () => {
      const w = baseWorld();
      w.runner.claudePaused = true;
      w.claude.headline = "Building #212 Archive view for old callers";
      w.claude.next = "Paused: no new Claude job after this build. Sol keeps reviewing and merging.";
      return w;
    },
  },
  "decision-running": {
    group: "Claude lane",
    label: "Decision thread running",
    make: () => {
      const w = baseWorld();
      w.asks = w.asks.filter((a) => a.id !== "ask-214");
      w.claude = {
        status: "working",
        job: { kind: "decision", repo: LD, ref: "#214", title: "Client onboarding form", since: "14:36", elapsed: "4 min", thread: "Queue runner decision: leads-dashboard#214" },
        headline: "Deciding what the #214 build's question needs",
        next: "Answers it in the build's thread, or leaves it to you (then it shows in Needs you).",
      };
      issue(w, LD, 214).reason = "A decision thread is reading the build's question";
      issue(w, LD, 212).state = "ready"; issue(w, LD, 212).reason = undefined;
      return w;
    },
  },
  "conflict-round": {
    group: "Claude lane",
    label: "Conflict round",
    go: `/pr/${LD}/153`,
    make: () => {
      const w = baseWorld();
      w.claude = {
        status: "working",
        job: { kind: "conflict", repo: LD, ref: "PR #153", href: `/pr/${LD}/153`, title: "Lead source on every call", since: "14:31", elapsed: "9 min", sha: "e40b7c3", thread: "Queue runner conflict: leads-dashboard#153" },
        headline: "Merging main into PR #153 at e40b7c3",
        next: "PR #154 also conflicts; its round waits until #153 merges.",
      };
      issue(w, LD, 212).state = "ready"; issue(w, LD, 212).reason = undefined;
      w.prs.push(
        {
          repo: LD, n: 153, title: "Lead source on every call", issue: 196, branch: "claude/lead-source-196", head: "e40b7c3", phase: "fixing",
          next: "A conflict round is merging main in (merge, not rebase: nothing is force-pushed). Sol reviews the pushed head afresh.",
          commits: 4, files: 6,
          timeline: [
            { at: "Fri 11:00", actor: "claude", kind: "build", sha: "e40b7c3", tone: "ok", title: "Built and opened PR #153" },
            { at: "Fri 11:40", actor: "sol", kind: "review", sha: "e40b7c3", round: 1, tone: "ok", title: "Review 1: clean" },
            { at: "Sat 10:12", actor: "github", kind: "checks", sha: "e40b7c3", tone: "bad", title: "Conflicts with main", detail: "main moved when PR #209 merged" },
            { at: "Sat 14:31", actor: "claude", kind: "conflict", sha: "e40b7c3", tone: "run", title: "Conflict round running", detail: "git merge origin/main, keep both sides' intent, run the checks, push", running: true },
          ],
        },
        {
          repo: LD, n: 154, title: "Call notes on the lead card", issue: 197, branch: "claude/call-notes-197", head: "18fe0d2", phase: "fixing",
          next: "Conflicts with main. Its conflict round waits for #153 to merge (lowest number first).",
          commits: 3, files: 4,
          timeline: [
            { at: "Fri 12:20", actor: "claude", kind: "build", sha: "18fe0d2", tone: "ok", title: "Built and opened PR #154" },
            { at: "Fri 13:02", actor: "sol", kind: "review", sha: "18fe0d2", round: 1, tone: "ok", title: "Review 1: clean" },
            { at: "Sat 10:12", actor: "github", kind: "checks", sha: "18fe0d2", tone: "bad", title: "Conflicts with main" },
          ],
        },
      );
      w.issues.push({ repo: LD, n: 196, title: "Lead source on every call", state: "in-progress", pr: 153, reason: "PR #153: conflict round" }, { repo: LD, n: 197, title: "Call notes on the lead card", state: "in-progress", pr: 154, reason: "PR #154: conflict round waits for #153" });
      return w;
    },
  },
  "held-pr": {
    group: "PRs",
    label: "PR you put on hold",
    go: `/pr/${LD}/204`,
    make: () => {
      const w = baseWorld();
      const p = pr(w, LD, 204);
      p.held = "You said hold on Sat 14:02";
      p.next = "Held until you release it. No review, fix round or merge meanwhile.";
      p.timeline.push(
        { at: "Sat 13:40", actor: "runner", kind: "stop", sha: "c71d0a9", tone: "you", title: "Stopped for you: review", detail: "I-2 reopened a class from review 1. Filed on #221" },
        { at: "Sat 14:02", actor: "you", kind: "hold", sha: "c71d0a9", tone: "you", title: "You replied hold on #221" },
      );
      issue(w, LD, 199).state = "held"; issue(w, LD, 199).reason = "PR #204 held by you";
      w.nextClaude = { text: "Build leads-dashboard#213 Domain health check" };
      w.claude.next = "Then: build #213";
      return w;
    },
  },
  "checks-pending": { group: "PRs", label: "Clean, checks pending", go: `/pr/${QR}/4`, make: baseWorld },
  "ready-merge": { group: "PRs", label: "Ready for you to merge", go: `/pr/${LD}/207`, make: baseWorld },
  "live-partial": {
    group: "PRs",
    label: "Live steps partial",
    go: `/pr/${LD}/207`,
    make: () => {
      const w = baseWorld();
      w.asks = w.asks.filter((a) => a.id !== "ask-207");
      const p = pr(w, LD, 207);
      p.phase = "merged"; p.gate = undefined; p.ask = "ask-live"; p.live = "needs-attention";
      p.next = "Merged, not fully live. No live run starts in leads-dashboard until you answer #222 or release it.";
      p.timeline.push(
        { at: "Sat 14:18", actor: "you", kind: "merge", sha: "a0d5f6f", tone: "ok", title: "You merged it", detail: "Merge commit 2be7a90" },
        { at: "Sat 14:33", actor: "claude", kind: "live", sha: "2be7a90", tone: "bad", title: "Live: partial", detail: "Deployed. 20261113_twilio_numbers.sql applied; 20261114_number_owner.sql failed: column \"owner_id\" already exists." },
        { at: "Sat 14:34", actor: "runner", kind: "stop", sha: "2be7a90", tone: "you", title: "Stopped for you: live", detail: "Filed on #222" },
      );
      issue(w, LD, 191).state = "done"; issue(w, LD, 191).reason = "Merged; live needs you";
      w.asks.unshift({
        id: "ask-live", kind: "live", repo: LD, ref: "PR #207", prHref: `/pr/${LD}/207`,
        title: "Live steps for PR #207 stopped halfway",
        why: ["Deployed on Lovable Cloud; 1 of 2 migrations applied.", "20261114_number_owner.sql failed: column \"owner_id\" already exists."],
        blocks: ["Every later live run in leads-dashboard"],
        since: "6 min", action: { label: "Open #222", where: "GitHub" },
      });
      w.activity.unshift({ day: "Today", at: "14:33", actor: "claude", repo: LD, kind: "live", ref: "PR #207", href: `/pr/${LD}/207`, text: "Live steps for PR #207: partial, 1 of 2 migrations", outcome: "partial", tone: "bad" });
      return w;
    },
  },
  "sol-out": {
    group: "Sol lane",
    label: "Sol out of usage",
    make: () => {
      const w = baseWorld();
      w.usage.sol = { available: false, until: "Sat 21:10", source: "10 min after the reset in Sol's rollout" };
      w.sol = { status: "waiting", until: "21:10", headline: "Out of usage until 21:10", next: "PR #210's review counted for nothing; it's reviewed afresh at 21:10. Merges wait too." };
      const p = pr(w, LD, 210);
      p.phase = "awaiting-review"; p.next = "Waiting for Sol (out of usage until 21:10).";
      p.timeline[2] = { at: "Sat 14:31", actor: "sol", kind: "review", sha: "4be91c2", round: 1, tone: "warn", title: "Review stopped: Sol is out of usage", detail: "out-of-usage: counts for nothing; reviewed afresh at 21:10" };
      return w;
    },
  },
  "github-down": {
    group: "Runner",
    label: "GitHub unreadable",
    make: () => {
      const w = baseWorld();
      w.runner.github = { ok: false, note: "GitHub hasn't answered since 14:22 (HTTP 503). Asks and PRs are as of 14:21; some may be missing. The runner keeps trying each pass." };
      w.repos.forEach((r) => (r.readable = false));
      return w;
    },
  },
  "usage-unreadable": {
    group: "Runner",
    label: "Claude usage unreadable",
    make: () => {
      const w = baseWorld();
      w.usage.readable = false;
      w.usage.error = "HTTP 401 from api/oauth/usage: the Claude login has expired";
      w.usage.five.used = null; w.usage.week.used = null;
      w.claude = { status: "unavailable", headline: "Can't read Claude's usage", next: "No Claude job starts until it can. Running Claude Code once refreshes the login. Sol carries on." };
      issue(w, LD, 212).state = "ready"; issue(w, LD, 212).reason = undefined;
      return w;
    },
  },
  "waiting-t3": {
    group: "Runner",
    label: "Starting: waiting for T3",
    make: () => {
      const w = baseWorld();
      w.runner.process = "starting";
      w.runner.since = "14:38";
      w.runner.note = "Waiting for T3's server (connection refused). Asking again every 30 seconds; nothing starts meanwhile.";
      w.claude = { status: "unavailable", headline: "Waiting for T3", next: "Starts its first pass once T3 answers." };
      w.sol = { status: "unavailable", headline: "Waiting for T3", next: "Starts its first pass once T3 answers." };
      issue(w, LD, 212).state = "ready"; issue(w, LD, 212).reason = undefined;
      const p = pr(w, LD, 210); p.phase = "awaiting-review"; p.timeline.pop(); p.next = "Sol reviews 4be91c2 on its first pass.";
      return w;
    },
  },
  restarting: {
    group: "Runner",
    label: "Restarting on new code",
    make: () => {
      const w = baseWorld();
      w.runner.process = "restarting";
      w.runner.note = "queue-runner's main moved to 66a5ea1 (PR #2 merged). Restarting once Sol finishes its pass.";
      w.claude = { status: "idle", headline: "Between jobs", next: "Starts nothing new until the runner is back on 66a5ea1." };
      return w;
    },
  },
  stopped: {
    group: "Runner",
    label: "Runner stopped",
    make: () => {
      const w = baseWorld();
      w.runner.process = "stopped";
      w.runner.connection = "stale";
      w.runner.lastSeen = "13:58";
      w.runner.note = "The runner isn't running. Last seen 13:58: the log ends with `runner stopped on an error`. A Claude job it was blocked on runs on in T3; the next runner settles it.";
      w.sol = { status: "unavailable", headline: "Not running", next: "Was reviewing PR #210 at 13:58; that review counts as failed." };
      w.claude = { ...w.claude, status: "unavailable", next: "This build runs on in T3. The next runner settles it." };
      return w;
    },
  },
};

export const DEMO_GROUPS = ["Everyday", "Claude lane", "Sol lane", "PRs", "Runner"];
