// GitHub, through `gh` (the CLI T3 itself uses for GitHub). A seam the tests fake.
import { execFile } from 'node:child_process';

export type Remote = { nameWithOwner: string; url: string };

export interface GitHub {
  /** The GitHub repo a folder's git remote points at, or null when it has none (not a git
   *  folder, no remote on GitHub, or the folder is gone). */
  remoteOf(folder: string): Promise<Remote | null>;
}

export type Gh = (args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;

export const ghCli: Gh = (args, cwd) => new Promise((resolve) => {
  execFile('gh', args, { cwd, timeout: 60_000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } },
    (error, stdout) => resolve({ code: error ? 1 : 0, stdout: String(stdout) }));
});

export class GhGitHub implements GitHub {
  private gh: Gh;
  constructor(gh: Gh = ghCli) { this.gh = gh; }

  async remoteOf(folder: string): Promise<Remote | null> {
    const { code, stdout } = await this.gh(['repo', 'view', '--json', 'nameWithOwner,url'], folder);
    if (code !== 0) return null;
    try {
      const repo = JSON.parse(stdout);
      return typeof repo?.nameWithOwner === 'string' ? { nameWithOwner: repo.nameWithOwner, url: repo.url } : null;
    } catch {
      return null;
    }
  }
}
