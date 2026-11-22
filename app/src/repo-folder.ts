// A served repo read from its own git folder (#219, Stefan's decision on #261, 2026-11-22): its
// GitHub `owner/name` from the folder's `origin` remote and its base branch from `origin/HEAD`,
// with no network call, the way Python reads both from config.toml. The truth stays where T3 and
// git keep it: nothing is copied into Settings.
//
// A clone has `origin/HEAD`; a folder added as a Local folder project may not, so a missing one is
// set once with `git remote set-head origin --auto` (the one call here that asks the remote) and
// read again.
import { existsSync } from 'node:fs';
import { run_git, type Run } from './git-seam.ts';

/** What a folder read gives: the repo's `owner/name` on GitHub and its base branch, or why it
 *  couldn't be read (with its `owner/name` when that much was read). */
export type FolderRead = { github: string; base: string } | { github: string | null; reason: string };

/** `owner/name` from a GitHub remote URL (https, `git@github.com:` or `ssh://`), or null. */
export function githubName(url: string): string | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

const firstLine = (s: string) => s.trim().split('\n')[0] ?? '';

/** The served repo's folder, read: its GitHub `owner/name` and base, or why not. Never throws. */
export async function readFolder(folder: string, run: Run = run_git,
  exists: (path: string) => boolean = existsSync): Promise<FolderRead> {
  if (!exists(folder)) return { github: null, reason: `its folder ${folder} is missing` };
  let github: string | null = null;
  try {
    const [code, out, err] = await run(['-C', folder, 'remote', 'get-url', 'origin']);
    if (code) return { github: null, reason: `git can't read its origin remote (${firstLine(err) || `exit ${code}`})` };
    github = githubName(out);
    if (github === null) return { github: null, reason: `its origin remote isn't on GitHub (${firstLine(out)})` };
    const head = ['-C', folder, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'];
    let [hcode, hout] = await run(head);
    if (hcode) {   // no origin/HEAD: set once from the remote, then read again
      const [scode, , serr] = await run(['-C', folder, 'remote', 'set-head', 'origin', '--auto']);
      if (scode) return { github, reason: `its origin/HEAD is missing and git couldn't set it (${firstLine(serr) || `exit ${scode}`})` };
      [hcode, hout] = await run(head);
      if (hcode) return { github, reason: 'its origin/HEAD is missing' };
    }
    const ref = firstLine(hout);
    return { github, base: ref.startsWith('origin/') ? ref.slice('origin/'.length) : ref };
  } catch (e) {   // git didn't start, or ran past its timeout
    return { github, reason: `git couldn't run (${(e as Error).message})` };
  }
}
