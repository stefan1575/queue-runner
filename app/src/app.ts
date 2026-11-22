// The command line. `--list` prints every T3 project with its GitHub remote and changes nothing; it
// exits 1 when gh failed for any project (each such project says what gh said).
//
// The rest is ported from `queue_runner/cli.py`'s `main` (#219), with its flags, texts and exit
// codes:
//
//     --config PATH --once             one pass of each lane: settle, at most one Claude job per
//                                      working repo and at most one Sol review
//     --config PATH                    run: pass after pass
//     --config PATH --release NAME#N   let the picker take a held issue again
//     --config PATH --reserve PERCENT  the share of the week kept for Stefan (default 5)
//
// Python's other flags come with the tickets that port them (`--dry-run` #238, `--review` #222,
// `--gate`, `--pause` and `--resume` #229, `--snapshot` #230, `--inbox` #231): until then they are
// arguments it doesn't know. Until the cutover (#165) the app runs only with `--config` naming a
// config that serves the sandboxes; the repo's own `config.toml` stays the Python runner's.
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CachedUsage, type Endpoint, OAuthUsage, type Usage } from './claude-usage.ts';
import { DEFAULT_CONFIG, type Config, load_config } from './config.ts';
import type { GitHub as ListGitHub } from './github.ts';
import { Gate, Knob, os_or_value_error, read_knob, write_knob } from './job-gate.ts';
import { type NoToaster, type NoWaker } from './later-parts.ts';
import { RunnerBusy, runner_lock } from './lock.ts';
import { formatProjects, listProjects } from './projects.ts';
import { format_g, W } from './python.ts';
import { format_exc, RESTART, Runner, type Git, type GitHub, type RunnerOptions, type Sleep, wall_sleep } from './run.ts';
import { JobLog } from './state.ts';
import type { T3Mcp } from './t3/mcp.ts';
import type { T3Ws } from './t3/ws.ts';

export type Doors = { mcp: Pick<T3Mcp, 'call'>; ws: Pick<T3Ws, 'first'>; github: ListGitHub };

/** What the ported command line runs on: Python's `main` takes each as a keyword, and builds the
 *  real one when it's left out. Here the caller (`src/main.ts`, the desktop app) gives the real
 *  ones. */
export type RunnerDoors = {
  github: GitHub; git: Git; t3: RunnerOptions['t3'];
  sleep?: Sleep | null; usage?: Endpoint<Usage> | CachedUsage<Usage> | null; clock?: (() => Date) | null;
  waker?: NoWaker | null; toaster?: NoToaster | null;
};

const USAGE = 'usage: pnpm --dir app start -- --list\n'
  + '       pnpm --dir app start -- --config CONFIG [--once | --release NAME#N | --reserve PERCENT]\n';

/** `--list`, or with `--config` the ported command line (`main`). Without `--config` the run loop
 *  doesn't start: until the cutover it runs only on a config that names the sandboxes (docs/app.md,
 *  Rules), never on the Python runner's own `config.toml`. */
export async function run(argv: string[], doors: Doors, out: (s: string) => void, runner?: RunnerDoors): Promise<number> {
  const args = argv.filter((a) => a !== '--');
  if (args.length === 1 && args[0] === '--list') return list(doors, out);
  if (runner !== undefined && !args.includes('--list') && args.some((a) => a === '--config' || a.startsWith('--config='))) {
    return main(args, runner, out);
  }
  out(USAGE);
  return 2;
}

async function list(doors: Doors, out: (s: string) => void): Promise<number> {
  // The WebSocket is opened on every start, so a sign-in it refuses shows at once.
  const [config, projects] = await Promise.all([
    doors.ws.first('subscribeServerConfig', {}),
    listProjects(doors.mcp, doors.github),
  ]);
  const env = config?.config?.environment;
  out(`T3 ${env?.serverVersion ?? '?'} on ${env?.label ?? '?'}\n\n`);
  out(formatProjects(projects));
  // a project gh couldn't answer for is a failed list, not one with no remote
  return projects.some((p) => p.failure) ? 1 : 0;
}

export const EXIT_LOCKED = 3;

const pad = (n: number) => String(n).padStart(2, '0');

/** `datetime.now().astimezone().isoformat(timespec='seconds')`. */
function local_iso(t: Date): string {
  const off = -t.getTimezoneOffset();
  const abs = Math.abs(off);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}:`
    + `${pad(t.getSeconds())}${off < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function _logger(config: Config): (line: string) => void {
  return (line) => {
    mkdirSync(config.log_dir, { recursive: true });
    appendFileSync(join(config.log_dir, 'runner.log'), `${local_iso(new Date())} ${line}\n`, 'utf8');
  };
}

function _jobs(config: Config): JobLog {
  return new JobLog(join(config.state_dir, 'jobs.jsonl'));
}

/** The gate, with Claude's one shared reader (`claude-usage.ts`'s `CachedUsage`, issue 66): the
 *  endpoint is asked once every 5 minutes. */
export function _gate(config: Config, usage: Endpoint<Usage> | CachedUsage<Usage> | null, clock: (() => Date) | null,
  sleep: Sleep | null): Gate {
  const endpoint = usage ?? new OAuthUsage();
  const reader = endpoint instanceof CachedUsage ? endpoint : new CachedUsage(endpoint, clock);
  return new Gate(config.state_dir, reader, clock, sleep);
}

function _knob(config: Config, reserve: number, out: (s: string) => void): number {
  if (!(reserve >= 0 && reserve <= 100)) {
    out('--reserve takes a percent from 0 to 100.\n');
    return 2;
  }
  try {
    read_knob(config.state_dir);
  } catch (e) {   // set afresh
    if (!os_or_value_error(e)) throw e;
    out(`gate.json was unreadable (${e.message}); writing it afresh.\n`);
  }
  write_knob(config.state_dir, new Knob(reserve));
  out(`The weekly reserve is ${format_g(reserve)}%. A running runner reads this before its next Claude job.\n`);
  return 0;
}

const REF = new RegExp(`^([${W}.-]+)#(\\d+)$`, 'u');

/** NAME#N from the command line: (repo, N), or null after saying what's wrong. */
function _repo_ref(value: string, config: Config, flag: string, out: (s: string) => void): [Config['repos'][number], number] | null {
  const m = REF.exec(value);
  const repos = new Map(config.repos.map((r) => [r.name, r]));
  if (!m || !repos.has(m[1]!)) {
    out(`${flag} takes NAME#N with NAME one of the repos in the config.\n`);
    return null;
  }
  return [repos.get(m[1]!)!, Number(m[2])];
}

function _pid_file(config: Config): string {
  return join(config.state_dir, 'runner.pid');
}

type Args = { once: boolean; release: string | null; reserve: number | null; config: string };

/** argparse's reading of the flags ported so far: an unknown argument, or a flag without its value,
 *  is a usage error (exit 2), as argparse's is. */
function parse_args(argv: readonly string[], out: (s: string) => void): Args | null {
  const args: Args = { once: false, release: null, reserve: null, config: DEFAULT_CONFIG };
  const usage = 'usage: queue_runner [--once] [--release NAME#N] [--reserve PERCENT] [--config CONFIG]\n';
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i]!.startsWith('--') && argv[i]!.includes('=')
      ? [argv[i]!.slice(0, argv[i]!.indexOf('=')), argv[i]!.slice(argv[i]!.indexOf('=') + 1)] : [argv[i]!, null];
    const value = (): string | null => {
      if (inline !== null) return inline;
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('-') && !/^-\d/.test(next))) return null;
      i += 1;
      return next;
    };
    if (flag === '--once' && inline === null) {
      args.once = true;
      continue;
    }
    if (flag === '--release' || flag === '--config' || flag === '--reserve') {
      const v = value();
      if (v === null) {
        out(`${usage}queue_runner: error: argument ${flag}: expected one argument\n`);
        return null;
      }
      if (flag === '--release') args.release = v;
      else if (flag === '--config') args.config = v;
      else {
        const n = Number(v);
        if (v.trim() === '' || Number.isNaN(n)) {
          out(`${usage}queue_runner: error: argument --reserve: invalid float value: '${v}'\n`);
          return null;
        }
        args.reserve = n;
      }
      continue;
    }
    out(`${usage}queue_runner: error: unrecognized arguments: ${argv.slice(i).join(' ')}\n`);
    return null;
  }
  return args;
}

/** `cli.main` for the flags ported so far. */
export async function main(argv: string[], doors: RunnerDoors, out: (s: string) => void): Promise<number> {
  const sleep = doors.sleep ?? ((s: number) => wall_sleep(s));
  const args = parse_args(argv, out);
  if (args === null) return 2;

  const config = load_config(args.config);
  const log_line = _logger(config);

  if (args.release !== null) {
    const ref = _repo_ref(args.release, config, '--release', out);
    if (ref === null) return 2;
    _jobs(config).released(ref[0].name, ref[1]);
    log_line(`released ${args.release}`);
    out(`Released ${args.release}: the picker may take it again, the Sol lane may `
      + 'review it again if its reviews failed, and a PR stopped for Stefan is back in '
      + 'the loop.\n');
    return 0;
  }

  if (args.reserve !== null) {
    const code = _knob(config, args.reserve, out);
    if (code === 0) log_line(`Stefan: ${argv.join(' ')}`);
    return code;
  }
  const gate = _gate(config, doors.usage ?? null, doors.clock ?? null, sleep);
  const runner = new Runner(config, {
    github: doors.github, t3: doors.t3, git: doors.git, out, log_line, toaster: doors.toaster ?? null, gate,
    now: doors.clock ?? null, waker: doors.waker ?? null,
  });
  let restart: string | null = null;
  try {
    const lock = runner_lock(config.state_dir);
    try {
      writeFileSync(_pid_file(config), String(process.pid), 'utf8');
      try {
        if (args.once) {
          await runner.run_once();
        } else {
          log_line(`runner started (pid ${process.pid})`);
          await runner.wait_for_t3(sleep);
          if (await runner.run_forever(sleep) === RESTART) restart = runner.restart_sha;
        }
      } finally {   // a runner that ends leaves no pid for --stop to find
        try {
          rmSync(_pid_file(config));
        } catch {
          // as Python's contextlib.suppress(OSError)
        }
      }
    } finally {
      lock[Symbol.dispose]();
    }
  } catch (e) {
    if (e instanceof RunnerBusy) {
      log_line(`a second runner started (pid ${process.pid}) and exited at once: ${e.message}`);
      out(`A queue runner is already running (${e.message}).\n`);
      return EXIT_LOCKED;
    }
    log_line(`runner stopped on an error:\n${format_exc(e)}`);
    throw e;
  }
  // Restarting on the runner's own new code (`restart.relaunch`) is ported with serving itself
  // (#237): until then the runner has no self-update, and run_forever never returns RESTART.
  if (restart) return 1;
  return 0;
}
