// The dashboard's read model: a projection of the runner's job log, GitHub, the usage gate and the
// two providers' usage. Fake here; every field is something the runner already knows or can read.

export type RepoId = string;

export interface Repo {
  id: RepoId;
  github: string;
  path: string;
  base: string;
  merge: "stefan" | "runner";
  liveDoc?: string;
  readable: boolean;
}

export type JobKind = "build" | "fix" | "conflict" | "decision" | "live" | "review" | "merge";

export interface LaneJob {
  kind: JobKind;
  repo: RepoId;
  ref: string;
  pr?: number;
  title: string;
  since: string;
  minutes: number; // elapsed; ticks while the page is live
  sha?: string;
  round?: number;
  thread?: string;
}

export type LaneStatus = "working" | "idle" | "waiting" | "stopping" | "stopped" | "unavailable";

// One thing that decides whether the lane may start its next job.
export interface Gate {
  label: string;
  ok: boolean;
  note?: string;
}

export interface Lane {
  status: LaneStatus;
  job?: LaneJob;
  headline: string;
  next: string;
  until?: string;
  gates: Gate[];
}

export type AskKind = "merge" | "decide" | "answer" | "live" | "repair";

export interface Ask {
  id: string;
  kind: AskKind;
  repo: RepoId;
  ref: string;
  pr?: number;
  title: string;
  why: string[];
  options?: { label: string; means: string; recommended?: boolean }[];
  unblocks?: number;
  since: string;
  action: string;
}

export type IssueState = "ready" | "building" | "review" | "fixing" | "you" | "merge" | "blocked" | "not-ready" | "done";

export interface Feature {
  id: string; // "repo#n" of the spec issue, or "repo:none"
  repo: RepoId;
  n?: number;
  title: string;
}

export interface Issue {
  repo: RepoId;
  n: number;
  title: string;
  feature?: string;
  state: IssueState;
  reason?: string;
  blockedBy?: string[]; // "repo#n"
  pr?: number;
}

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
  running?: boolean;
}

export interface PR {
  repo: RepoId;
  n: number;
  title: string;
  issue: number;
  branch: string;
  head: string;
  phase: "building" | "awaiting-review" | "reviewing" | "fixing" | "ready" | "merged" | "closed";
  gate?: string;
  held?: string;
  live?: "pending" | "live" | "needs-attention" | "unknown";
  next: string;
  ask?: string;
  timeline: TEvent[];
}

export interface DigestRow {
  day: string; // always shown: the log never assumes you remember when you last looked
  at: string;
  actor: TEvent["actor"];
  repo: RepoId;
  text: string;
  pr?: number;
  tone: Tone;
  group: "merged" | "reviewed" | "built" | "stopped" | "recovered";
}

export interface Window {
  used: number | null;
  resets: string;
}

export interface Meter {
  five: Window;
  week: Window;
  // Model-scoped weekly limits the account has (e.g. "Fable"), only when the usage response has them.
  scoped?: (Window & { label: string })[];
  readAt: string;
  error?: string;
}

export interface Connection {
  id: string;
  name: string;
  role: string;
  ok: boolean;
  status: string;
  how: [string, string][];
}

export interface Runner {
  process: "running" | "starting" | "restarting" | "stopped";
  since: string;
  note?: string;
  lastSeen: string;
  reserve: number;
  github: { ok: boolean; note?: string };
}

export interface World {
  repos: Repo[];
  runner: Runner;
  claude: Lane;
  sol: Lane;
  usage: { claude: Meter & { releaseAt: string }; chatgpt: Meter };
  asks: Ask[];
  features: Feature[];
  issues: Issue[];
  prs: PR[];
  digest: { since: string; rows: DigestRow[] };
  connections: Connection[];
}
