// An in-memory folder for the settings, for a test that waits on what the app does after a save:
// a save here is done once its promises settle, so a wait on it never waits for the disk (#202 F2).
// `settings.test.ts` keeps the real disk, where each save is awaited.
import type { JobLogFiles } from '../src/job-log.ts';
import type { SettingsFiles } from '../src/settings.ts';

export function memoryFiles(): SettingsFiles & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    mkdir: async () => {},
    read: async (file) => {
      const text = files.get(file);
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
      return text;
    },
    write: async (file, text) => { files.set(file, text); },
    rename: async (from, to) => {
      const text = files.get(from);
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${from}`), { code: 'ENOENT' });
      files.set(to, text);
      files.delete(from);
    },
  };
}

/** An in-memory folder for the job log, for the build lane's tests: an append is done once its
 *  promise settles (#202 F2). `job-log.test.ts` keeps the real disk. */
export function memoryJobFiles(): JobLogFiles & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    read: async (file) => {
      const text = files.get(file);
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
      return text;
    },
    append: async (file, text) => { files.set(file, (files.get(file) ?? '') + text); },
    truncate: async (file, bytes) => { files.set(file, Buffer.from(files.get(file) ?? '').subarray(0, bytes).toString()); },
  };
}
