// The dashboard's read model: a projection of the runner's job log, GitHub and the usage gate
// (prior-art-and-ui.md §4). Fake here; every field is something the runner already knows.

export type RepoId = string;

export interface Repo {
  id: RepoId; // the config.toml name
  github: string; // owner/name
  path: string;
  base: string;
  merge: "stefan" | "runner";
  issues: "github" | "local";
  liveDoc?: string;
  readable: boolean; // GitHub answered on the last pass
}

export type JobKind = "build" | "fix" | "conflict" | "decision" | "live" | "review" | "merge";

export interface LaneJob {
  kind: JobKind;
  repo: RepoId;
  ref: string; // "#212" or "PR #210"
  href?: string; // where it lives in this app
  title: string;
  since: string; // clock time
  elapsed: string;
  sha?: string;
  round?: number;
  thread?: string; // T3 thread title
}

export type LaneStatus = "working" | "idle" | "waiting" | "paused" | "unavailable";

export interface Lane {
  status: LaneStatus;
  job?: LaneJob;
  headline: string; // one line: what it's doing or waiting for
  next: string; // the concrete next condition
  until?: string;
}

export type AskKind = "merge" | "decide" | "answer" | "live" | "repair";

export interface Ask {
  id: string;
  kind: AskKind;
  repo: RepoId;
  ref: string;
  prHref?: string;
  title: string;
  why: string[];
  options?: { label: string; means: string; recommended?: boolean }[];
  blocks?: string[]; // what it holds up
  since: string; // "2 h"
  action: { label: string; where: string }; // where = GitHub, T3...
}

export type IssueState = "ready" | "in-progress" | "blocked" | "held" | "not-ready" | "done";

export interface Issue {
  repo: RepoId;
  n: number;
  title: string;
  state: IssueState;
  reason?: string;
  blockedBy?: string[]; // "repo#n"
  pr?: number;
}

export type PrPhase =
  | "building"
  | "awaiting-review"
  | "reviewing"
  | "fixing"
  | "ready"
  | "merging"
  | "merged"
  | "closed";

export type LiveState = "not-required" | "pending" | "running" | "live" | "needs-attention" | "unknown" | "assumed";

export type Tone = "ok" | "warn" | "bad" | "info" | "run" | "you";

export interface Finding {
  id: string;
  sev: "Important" | "Nit" | "Pre-existing";
  status: "open" | "fixed" | "declined" | "filed";
  text: string;
  where?: string;
}

export interface TEvent {
  at: string;
  actor: "claude" | "sol" | "runner" | "you" | "github";
  kind: JobKind | "push" | "checks" | "stop" | "ready" | "reply" | "hold";
  sha?: string;
  round?: number;
  tone: Tone;
  title: string;
  detail?: string;
  findings?: Finding[];
  link?: string;
  running?: boolean;
}

export interface PR {
  repo: RepoId;
  n: number;
  title: string;
  issue: number;
  branch: string;
  head: string;
  phase: PrPhase;
  gate?: string; // the merge gate's summary when ready
  held?: string; // overlay: why it's held
  live?: LiveState;
  next: string; // what happens next / why it waits
  ask?: string; // ask id
  commits: number;
  files: number;
  timeline: TEvent[];
}

export interface ActivityRow {
  day: "Today" | "Yesterday" | "Wed 12 Nov";
  at: string;
  actor: TEvent["actor"];
  repo: RepoId;
  kind: TEvent["kind"];
  text: string;
  ref?: string;
  href?: string;
  outcome: string; // the raw job-log outcome
  tone: Tone;
}

export interface Window {
  used: number | null;
  resets: string;
}

export interface Usage {
  readable: boolean;
  error?: string;
  readAt: string;
  five: Window;
  week: Window & { releaseAt: string };
  costs: { kind: string; five: number; week: number; source: "default" | "learned"; n: number }[];
  sol: { available: boolean; until?: string; source?: string };
}

export interface Runner {
  process: "running" | "starting" | "restarting" | "stopped";
  pid?: number;
  since: string;
  note?: string;
  connection: "live" | "stale";
  lastSeen: string;
  claudePaused: boolean;
  reserve: number;
  github: { ok: boolean; note?: string };
}

export interface World {
  repos: Repo[];
  runner: Runner;
  claude: Lane;
  sol: Lane;
  usage: Usage;
  asks: Ask[];
  issues: Issue[];
  prs: PR[];
  activity: ActivityRow[];
  nextClaude: { text: string; href?: string } | null;
}
