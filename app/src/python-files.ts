// Python's file calls where the git seam (#216) and the dependencies (#221) ports need them to
// leave the disk as Python's do: `os.path`'s checks and `shutil.rmtree(ignore_errors=True)`.
// On Windows, Node's `unlink` and `rmdir` clear the read-only attribute and delete, where
// Python's `os.unlink`, `os.remove` and `os.rmdir` fail with `PermissionError`, so a delete here
// checks it first.
import { lstat, readdir, rmdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** `os.path.exists`: follows links; false on any error. */
export const exists = (p: string) => stat(p).then(() => true, () => false);

/** `os.path.lexists`: true for a link, even a broken one. */
export const lexists = (p: string) => lstat(p).then(() => true, () => false);

/** `os.path.isdir`. */
export const isdir = (p: string) => stat(p).then((s) => s.isDirectory(), () => false);

/** `os.path.isfile`. */
export const isfile = (p: string) => stat(p).then((s) => s.isFile(), () => false);

/** Windows' read-only attribute, which Node shows as a mode with no write bits. Only Windows:
 *  elsewhere the mode's write bits don't stop a delete. */
export const read_only = (st: { mode: number }) => process.platform === 'win32' && (st.mode & 0o200) === 0;

/** The `PermissionError` Python's delete raises on a read-only entry, as Node words its own. */
export function permission_error(syscall: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`EPERM: operation not permitted, ${syscall} '${path}'`),
    { errno: -4048, code: 'EPERM', syscall, path });
}

/** `os.remove(path)` with its `OSError` ignored: a file or a link, never a folder, and not a
 *  read-only one on Windows. */
export async function remove_quietly(path: string): Promise<void> {
  const st = await lstat(path).catch(() => null);
  if (!st || (st.isDirectory() && !st.isSymbolicLink()) || read_only(st)) return;
  await unlink(path).catch(() => {});
}

/** `shutil.rmtree(folder, ignore_errors=True)`: refuses a folder that is itself a link (a
 *  junction too), deletes what it can, links inside without following them, and carries on
 *  past what it can't, a read-only entry included (`read_only`). */
export async function rmtree(folder: string): Promise<void> {
  const st = await lstat(folder).catch(() => null);
  if (!st || st.isSymbolicLink()) return;   // "Cannot call rmtree on a symbolic link"
  if (st.isDirectory()) await rmtree_inside(folder, st);
  else if (!read_only(st)) await unlink(folder).catch(() => {});
}

async function rmtree_inside(folder: string, st: { mode: number }): Promise<void> {
  const names = await readdir(folder).catch(() => [] as string[]);
  for (const name of names) {
    const entry = join(folder, name);
    const inner = await lstat(entry).catch(() => null);
    if (!inner) continue;
    if (inner.isDirectory() && !inner.isSymbolicLink()) await rmtree_inside(entry, inner);
    else if (!read_only(inner)) await unlink(entry).catch(() => {});
  }
  if (!read_only(st)) await rmdir(folder).catch(() => {});
}
