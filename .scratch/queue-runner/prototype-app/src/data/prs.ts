// PR timelines (fake), grouped later by the head each step acted on.
import type { PR } from "./types";

const LD = "leads-dashboard";
const QR = "queue-runner";

export const PRS: PR[] = [
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
    timeline: [
      { at: "Sat 13:30", actor: "claude", kind: "build", sha: "9c1e2aa", tone: "ok", title: "Built and opened PR #4" },
      { at: "Sat 14:12", actor: "sol", kind: "review", sha: "9c1e2aa", round: 1, tone: "ok", title: "Review 1: clean", detail: "1 nit" },
      { at: "Sat 14:13", actor: "github", kind: "checks", sha: "9c1e2aa", tone: "run", title: "Checks running", detail: "tests (windows-latest) · 6 min so far", running: true },
    ],
  },
];
