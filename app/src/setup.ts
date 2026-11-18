// What the runner needs before it can work, checked for the Setup page (#162; #68 story 16): T3
// Code installed, running, reachable and the app signed in to it; at least one provider
// connected in T3; gh installed and signed in (T3 runs the same gh for GitHub, so its sign-in is
// T3's); and T3's Resume after usage limits off, since it would race the runner. Each problem
// says how to fix it. No skills are checked (#68, 2026-11-18). The report is plain data the
// window shows; the checks run in the main process, through the app's own seams.
import type { Gh } from './github.ts';
import type { T3Mcp } from './t3/mcp.ts';
import type { Address } from './t3/seams.ts';
import type { T3Ws } from './t3/ws.ts';

export type CheckId = 't3' | 'providers' | 'github' | 'resume';
/** ok: in place. bad: missing, with how to fix it. waiting: can't be checked until another
 *  check passes (T3's providers and settings, while T3 can't be reached). */
export type CheckState = 'ok' | 'bad' | 'waiting';

export type SetupCheck = {
  id: CheckId;
  label: string;
  state: CheckState;
  /** One line: what was found. */
  summary: string;
  /** What T3 or gh said, word for word, when it failed. */
  detail?: string;
  /** How to fix it, when it's bad. */
  fix?: string;
  /** The providers connected in T3. */
  items?: string[];
};

export type SetupReport = { checks: SetupCheck[]; ok: boolean; at: string };

export type SetupDoors = {
  /** Whether T3 Code's CLI is where T3 installs it. */
  t3Installed(): Promise<boolean>;
  address: Address;
  ws: Pick<T3Ws, 'first'>;
  mcp: Pick<T3Mcp, 'call'>;
  gh: Gh;
};

export const LABELS: Record<CheckId, string> = {
  t3: 'T3 Code',
  providers: 'Providers',
  github: 'GitHub',
  resume: 'Resume after usage limits',
};

const firstLine = (s: string) => s.trim().split(/\r?\n/)[0] || 'no message';
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A provider T3 can start a thread on now: switched on and ready (as the catalog counts it). */
const connected = (p: any) => p && p.enabled !== false && p.status === 'ready' && typeof p.instanceId === 'string';
const nameOf = (p: any) => String(p.displayName ?? p.instanceId);

type T3Result = { check: SetupCheck; config: any | null };

async function checkT3(d: SetupDoors): Promise<T3Result> {
  const bad = (summary: string, fix: string, detail?: string): T3Result =>
    ({ check: { id: 't3', label: LABELS.t3, state: 'bad', summary, fix, ...(detail ? { detail } : {}) }, config: null });
  if (!(await d.t3Installed())) {
    return bad("T3 Code isn't installed.", 'Install T3 Code and open it once, then check again.');
  }
  let origin: string;
  try {
    origin = await d.address();
  } catch (e) {
    return bad("T3 Code isn't running.", 'Open T3 Code, then check again. The runner finds it once its server is up.', why(e));
  }
  let config: any;
  try {
    config = (await d.ws.first('subscribeServerConfig', { workspaceSnapshotsOnDemand: true, providerCatalogsOnDemand: true }))?.config;
    await d.mcp.call('t3_project_list', { cursor: 0, limit: 1 });
  } catch (e) {
    const m = why(e);
    // A pairing code T3's CLI wouldn't make, or a sign-in T3 refused, is the sign-in; anything
    // else (nothing answering, a socket that closed) is T3 out of reach.
    if (/t3 auth|refused \/oauth|approved no sign-in|issued no/i.test(m)) {
      return bad("The runner couldn't sign in to T3 Code.", 'Restart T3 Code, then check again. If it still refuses, update T3 Code: the runner signs in with a pairing code from its CLI.', m);
    }
    return bad(`T3 Code isn't answering at ${origin}.`, 'Restart T3 Code, then check again.', m);
  }
  const env = config?.environment;
  return {
    check: {
      id: 't3', label: LABELS.t3, state: 'ok',
      summary: `T3 Code${env?.serverVersion ? ` ${env.serverVersion}` : ''} is running${env?.label ? ` on ${env.label}` : ''}, and the runner is signed in.`,
    },
    config: config ?? {},
  };
}

function waiting(id: CheckId): SetupCheck {
  return { id, label: LABELS[id], state: 'waiting', summary: 'Checked once T3 Code answers.' };
}

function checkProviders(config: any): SetupCheck {
  const all: any[] = Array.isArray(config.providers) ? config.providers : [];
  const on = all.filter(connected);
  if (on.length === 0) {
    const notReady = all.filter((p) => p?.enabled !== false && !connected(p));
    return {
      id: 'providers', label: LABELS.providers, state: 'bad', summary: 'No provider is connected in T3 Code.',
      fix: "In T3 Code's settings, switch on a provider and sign in to it, then check again.",
      ...(notReady.length ? { detail: notReady.map((p) => `${nameOf(p)}: ${p.message ?? p.status}`).join('\n') } : {}),
    };
  }
  return {
    id: 'providers', label: LABELS.providers, state: 'ok',
    summary: `${on.length} connected in T3 Code.`, items: on.map(nameOf),
  };
}

function checkResume(config: any): SetupCheck {
  const v = config.settings?.autoResumeLimitedThreads;
  const base = { id: 'resume' as const, label: LABELS.resume };
  if (v === true) {
    return {
      ...base, state: 'bad', summary: 'On in T3 Code: T3 would resume threads after a usage limit, racing the runner.',
      fix: "In T3 Code's settings, turn off Resume after usage limits. The runner resumes its own threads.",
    };
  }
  if (v === false) return { ...base, state: 'ok', summary: 'Off in T3 Code, so only the runner resumes its threads.' };
  return { ...base, state: 'ok', summary: "This T3 Code doesn't have the setting, so nothing races the runner." };
}

async function checkGitHub(gh: Gh): Promise<SetupCheck> {
  const base = { id: 'github' as const, label: LABELS.github };
  const { code, stdout, stderr } = await gh(['auth', 'status', '--hostname', 'github.com', '--json', 'hosts'], '.');
  // a gh that can't start has no exit code (the seam's -1): not installed
  if (code === -1 && /ENOENT|not recognized|cannot find/i.test(stderr)) {
    return {
      ...base, state: 'bad', summary: "GitHub's CLI, gh, isn't installed.",
      fix: 'Install gh from cli.github.com, sign in with `gh auth login` in a terminal, then check again.', detail: firstLine(stderr),
    };
  }
  let hosts: any[] = [];
  try {
    hosts = JSON.parse(stdout)?.hosts?.['github.com'] ?? [];
  } catch {
    // no JSON: gh said why on stderr
  }
  const active = hosts.find((h) => h?.active) ?? hosts[0];
  if (code === 0 && active?.state === 'success' && typeof active.login === 'string') {
    return { ...base, state: 'ok', summary: `gh is signed in to github.com as ${active.login}. T3 Code uses the same sign-in.` };
  }
  if (active && active.state !== 'success') {
    return {
      ...base, state: 'bad', summary: `gh's sign-in${active.login ? ` as ${active.login}` : ''} no longer works.`,
      fix: 'Run `gh auth login` in a terminal to sign in again, then check again.',
      detail: String(active.error ?? active.state ?? firstLine(stderr)),
    };
  }
  if (hosts.length === 0 && (code === 1 || /not logged in/i.test(stderr))) {
    return {
      ...base, state: 'bad', summary: "gh isn't signed in to GitHub.",
      fix: 'Run `gh auth login` in a terminal, then check again. T3 Code uses the same sign-in.', detail: firstLine(stderr),
    };
  }
  return {
    ...base, state: 'bad', summary: `gh couldn't say whether it's signed in (exit ${code}).`,
    fix: 'Run `gh auth status` in a terminal to see why, then check again.', detail: firstLine(stderr),
  };
}

/** Every check, T3's in order (its providers and settings need it answering) beside gh's. */
export async function checkSetup(d: SetupDoors, now: () => Date = () => new Date()): Promise<SetupReport> {
  const [t3, github] = await Promise.all([checkT3(d), checkGitHub(d.gh)]);
  const checks = [
    t3.check,
    t3.config ? checkProviders(t3.config) : waiting('providers'),
    github,
    t3.config ? checkResume(t3.config) : waiting('resume'),
  ];
  return { checks, ok: checks.every((c) => c.state === 'ok'), at: now().toISOString() };
}
