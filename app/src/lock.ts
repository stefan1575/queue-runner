// Locks between runner processes: one runner, and one Sol job at a time. Ported from
// `queue_runner/lock.py` (#219).
import { closeSync, constants, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';

export class RunnerBusy extends Error {
  override name = 'RunnerBusy';
}

// libuv's `UV_FS_O_EXLOCK` on Windows: the file opened with no sharing, so no other handle opens
// it while this one is open. Node has no byte lock (Python's `msvcrt.locking`), so this is the
// lock: Python's byte-locked `runner.lock` refuses it, as Python refuses Python, and while the
// app holds it Python's `open` of the file fails before its lock is tried.
const UV_FS_O_EXLOCK = 0x10000000;

/** A lock on `<state_dir>/<name>`: `runner.lock` for the runner's whole life, `sol.lock` for each
 *  Sol job. The OS drops it if the process dies. Held until it is disposed (`using`, as Python's
 *  `with`); `RunnerBusy` if another holds it. Off Windows, where Python takes `fcntl.flock`, Node
 *  has neither, and the file is only opened. */
export function runner_lock(state_dir: string, name = 'runner.lock'): Disposable {
  mkdirSync(state_dir, { recursive: true });
  const path = join(state_dir, name);
  const flags = constants.O_RDWR | constants.O_CREAT | constants.O_APPEND
    | (process.platform === 'win32' ? UV_FS_O_EXLOCK : 0);   // Python's `open(path, 'a+')`
  let fd: number;
  try {
    fd = openSync(path, flags);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EBUSY') throw new RunnerBusy(`another queue runner holds ${path}`);
    throw e;
  }
  return { [Symbol.dispose]: () => closeSync(fd) };
}
