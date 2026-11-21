// One run loop at a time on a state folder (Python's `lock.runner_lock` on `runner.lock`, #219):
// the desktop app holds it while its run loop runs, and the command line's `--once` takes it for
// its pass, so neither plans beside the other. Node has no byte lock, so the lock is a file
// holding its holder's pid, created only if it isn't there: one whose process has gone (the OS
// dropped Python's lock with it) is stale and taken over.
import { mkdirSync, openSync, readFileSync, unlinkSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';

/** The lock's file in the state folder. Its own name, not Python's `runner.lock`, which the Python
 *  runner byte-locks in its own state folder. */
export const LOCK_FILE = 'run-loop.lock';

/** Another run loop holds the state folder's lock (Python's `RunnerBusy`). */
export class RunnerBusy extends Error {}

/** Whether a process is running: `process.kill(pid, 0)` sends nothing and fails for none. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';   // it's there, run by someone else
  }
}

/** Takes the lock on `state_dir`, or throws RunnerBusy while a running process holds it (this one
 *  too: a second take in one process is refused, as Python's is). Returns its release. */
export function runner_lock(state_dir: string, pid = process.pid, is_alive: (pid: number) => boolean = alive): () => void {
  mkdirSync(state_dir, { recursive: true });
  const path = join(state_dir, LOCK_FILE);
  for (let tries = 0; ; tries++) {
    let fd: number;
    try {
      fd = openSync(path, 'wx');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || tries) throw busy(e, path);
      let holder = NaN;
      try {
        holder = Number.parseInt(readFileSync(path, 'utf8'), 10);
      } catch { /* gone meanwhile, or unreadable: stale */ }
      if (Number.isInteger(holder) && holder > 0 && is_alive(holder)) {
        throw new RunnerBusy(`another queue runner (pid ${holder}) holds ${path}`);
      }
      try {
        unlinkSync(path);   // stale: its process has gone
      } catch { /* gone meanwhile */ }
      continue;
    }
    try {
      writeSync(fd, String(pid));
    } finally {
      closeSync(fd);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        if (readFileSync(path, 'utf8') === String(pid)) unlinkSync(path);
      } catch { /* gone already */ }
    };
  }
}

function busy(e: unknown, path: string): Error {
  if ((e as NodeJS.ErrnoException).code === 'EEXIST') return new RunnerBusy(`another queue runner holds ${path}`);
  return e as Error;
}
