// PROTOTYPE (throwaway): the Settings page as #36 settled it, on fake data, in memory.
// `Saved` is what the page edits; `stored()` is what the runner would keep. The rest is read from
// T3 or GitHub and only shown.

export type ProviderId = "claude" | "chatgpt";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type RoleId = "builder" | "reviewer";
export interface Role { provider: ProviderId; model: string; effort: Effort; chosen: boolean }

export const ROLES: { id: RoleId; label: string; verb: string; does: string }[] = [
  { id: "builder", label: "Builder", verb: "Build", does: "Builds tickets and fix rounds. It also runs decisions and conflict rounds." },
  { id: "reviewer", label: "Reviewer", verb: "Review", does: "Reviews every pull request, each time its head changes." },
];

// What T3 says is connected (its providers and their models). Fake.
export const T3_PROVIDERS: Record<ProviderId, { name: string; models: string[]; efforts: Effort[]; default: { model: string; effort: Effort } }> = {
  claude: { name: "Claude", models: ["Opus 5.5", "Sonnet 5.5", "Haiku 5.5", "Fable 5.2"], efforts: ["low", "medium", "high", "xhigh", "max"], default: { model: "Opus 5.5", effort: "medium" } },
  chatgpt: { name: "ChatGPT", models: ["GPT-6.1 Sol"], efforts: ["low", "medium", "high", "xhigh"], default: { model: "GPT-6.1 Sol", effort: "medium" } },
};
export const PROVIDER_IDS = Object.keys(T3_PROVIDERS) as ProviderId[];
export const T3_DEFAULT_PROVIDER: ProviderId = "claude";
export const EFFORT_LABEL: Record<Effort, string> = { low: "low", medium: "medium", high: "high", xhigh: "extra high", max: "max" };

export interface Share { id: string; provider: ProviderId; window: string; percent: number; releaseHours: number; enforced: boolean }
// When each weekly window next resets: T3 reports it, the runner only reads it. Fake, fixed at load.
const inHours = (h: number) => { const d = new Date(Date.now() + h * 3600_000); d.setMinutes(0, 0, 0); return d; };
export const RESETS: Record<string, Date> = { "claude-week": inHours(77), "claude-fable": inHours(121), "chatgpt-week": inHours(38) };
export const releaseAt = (s: Share) => new Date(RESETS[s.id].getTime() - s.releaseHours * 3600_000);

export interface RepoRow {
  name: string;
  github: string | null;          // null: a T3 project with no GitHub remote, listed but can't be served
  path: string;
  served: boolean;
  merge: "runner" | "me";
  newFromT3?: boolean;
}

export type DateStyle = "month-first" | "weekday-first" | "day-first" | "iso";
export type SoundId = "chime" | "knock" | "drop" | "none";
export type TimeFormat = "locale" | "12-hour" | "24-hour";

export interface Saved {
  name: string;
  roles: Record<RoleId, Role>;
  shares: Share[];
  repos: RepoRow[];
  dateStyle: DateStyle;
  notify: { needsMe: boolean; sound: SoundId; merges: boolean };
  machine: { startWithWindows: boolean; wakePc: boolean };
}

// Read from T3 or gh, shown, never set here.
export const GH = { login: "stefan1575", name: "Stefan" };
export const T3_SNOOZE = ["For 1 hour", "For 3 hours", "Today at 18:00", "Tomorrow at 9:00", "Monday at 9:00"];
export const TIME_FORMATS: { id: TimeFormat; label: string }[] = [
  { id: "locale", label: "System" },
  { id: "12-hour", label: "12-hour" },
  { id: "24-hour", label: "24-hour" },
];

const repos = (fresh: boolean): RepoRow[] => [
  { name: "queue-runner", github: "stefan1575/queue-runner", path: "~/Code/Personal/queue-runner", served: !fresh, merge: fresh ? "me" : "runner" },
  { name: "game-backdrop", github: "stefan1575/game-backdrop", path: "~/Code/Personal/game-backdrop", served: !fresh, merge: "me" },
  { name: "leads-dashboard", github: "RoyalBullyAgency-RBA/leads-dashboard", path: "~/Code/Work/leads-dashboard", served: !fresh, merge: "me" },
  { name: "Code", github: "stefan1575/Code", path: "~/Code", served: false, merge: "me" },
  // On a new install every project is new, so none is singled out.
  { name: "portfolio-site", github: "stefan1575/portfolio-site", path: "~/Code/Personal/portfolio-site", served: false, merge: "me", ...(fresh ? {} : { newFromT3: true }) },
  { name: "scratch-notes", github: null, path: "~/scratch-notes", served: false, merge: "me" },
];

const shares = (fresh: boolean): Share[] => [
  { id: "claude-week", provider: "claude", window: "Claude's week", percent: fresh ? 0 : 5, releaseHours: 24, enforced: true },
  { id: "claude-fable", provider: "claude", window: "Fable's week", percent: 0, releaseHours: 24, enforced: false },
  { id: "chatgpt-week", provider: "chatgpt", window: "ChatGPT's week", percent: 0, releaseHours: 24, enforced: false },
];

export function initial(fresh: boolean): Saved {
  const t3 = T3_PROVIDERS[T3_DEFAULT_PROVIDER].default;
  return {
    name: GH.name,
    roles: fresh
      ? { builder: { provider: T3_DEFAULT_PROVIDER, ...t3, chosen: false }, reviewer: { provider: T3_DEFAULT_PROVIDER, ...t3, chosen: false } }
      : { builder: { provider: "claude", model: "Opus 5.5", effort: "medium", chosen: true }, reviewer: { provider: "chatgpt", model: "GPT-6.1 Sol", effort: "high", chosen: true } },
    shares: shares(fresh),
    repos: repos(fresh),
    dateStyle: "month-first",
    notify: { needsMe: true, sound: "chime", merges: false },
    machine: { startWithWindows: true, wakePc: !fresh },
  };
}

// ---- dates: the style is ours, the clock is T3's
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const p2 = (n: number) => String(n).padStart(2, "0");
// "System" follows Windows; this fake PC is set to 12-hour.
export const isTwelve = (fmt: TimeFormat) => fmt !== "24-hour";
export function clock(d: Date, fmt: TimeFormat) {
  const h = d.getHours(), m = p2(d.getMinutes());
  return isTwelve(fmt) ? `${h % 12 || 12}:${m}${h < 12 ? "am" : "pm"}` : `${p2(h)}:${m}`;
}
export const DATE_STYLES: { id: DateStyle; label: string }[] = [
  { id: "month-first", label: "Month first" },
  { id: "weekday-first", label: "Weekday first" },
  { id: "day-first", label: "Day first" },
  { id: "iso", label: "Year-month-day" },
];
export function fmtDate(d: Date, style: DateStyle, fmt: TimeFormat, short = false) {
  const t = clock(d, fmt), day = DAYS[d.getDay()], mon = MONTHS[d.getMonth()], n = d.getDate(), y = d.getFullYear();
  const d3 = day.slice(0, 3), m3 = mon.slice(0, 3);
  if (style === "iso") return short ? `${p2(d.getMonth() + 1)}-${p2(n)} ${t}` : `${y}-${p2(d.getMonth() + 1)}-${p2(n)} ${d3} ${t}`;
  if (style === "weekday-first") return short ? `${d3}, ${m3} ${n}, ${t}` : `${day}, ${mon} ${n}, ${y}, ${t}`;
  if (style === "day-first") return short ? `${n} ${m3} ${d3} ${t}` : `${n} ${mon} ${y} ${day} ${t}`;
  return short ? `${m3} ${n} ${d3} ${t}` : `${mon} ${n}, ${y} ${day} ${t}`;
}

// ---- sounds: stand-ins played with WebAudio, so a choice can be heard
export const SOUNDS: { id: SoundId; label: string; notes: number[] }[] = [
  { id: "chime", label: "Chime", notes: [880, 1320] },
  { id: "knock", label: "Knock", notes: [220, 220] },
  { id: "drop", label: "Drop", notes: [1200, 600] },
  { id: "none", label: "No sound", notes: [] },
];
export function play(id: SoundId) {
  const s = SOUNDS.find((x) => x.id === id);
  if (!s || !s.notes.length) return;
  const ctx = new AudioContext();
  s.notes.forEach((f, i) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = id === "knock" ? "triangle" : "sine";
    o.frequency.value = f;
    const t = ctx.currentTime + i * 0.14;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g).connect(ctx.destination);
    o.start(t); o.stop(t + 0.4);
  });
  setTimeout(() => void ctx.close(), 1200);
}

// ---- what the runner would store: only what's set here. Names, paths and remotes are T3's.
// A role nobody chose yet is stored as null: the runner follows T3's default until it's set.
export function stored(s: Saved) {
  const role = (r: Role) => (r.chosen ? { provider: r.provider, model: r.model, effort: r.effort } : null);
  return {
    name: s.name,
    roles: { builder: role(s.roles.builder), reviewer: role(s.roles.reviewer) },
    shares: Object.fromEntries(s.shares.map((x) => [x.id, { percent: x.percent, releaseHours: x.releaseHours }])),
    repos: Object.fromEntries(s.repos.map((r) => [r.name, { served: r.served, merge: r.merge, ...(r.newFromT3 ? { new: true } : {}) }])),
    dateStyle: s.dateStyle,
    notify: s.notify,
    machine: s.machine,
  };
}
