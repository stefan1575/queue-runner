// gh failing (not signed in, offline, not installed) is not a folder with no GitHub repo (review 1's F1).
import { describe, expect, it } from 'vitest';
import { run } from '../src/app.ts';
import { GhGitHub, GitHubError, ghAt, type Gh } from '../src/github.ts';

const here = () => true;
const answers = (code: number, stderr: string): Gh => async () => ({ code, stdout: '', stderr });

describe('gh failures', () => {
  it('not signed in (exit 4) is a failure with what gh said', async () => {
    const gh = new GhGitHub(answers(4, 'To get started with GitHub CLI, please run:  gh auth login\n'), here);
    await expect(gh.remoteOf('C:/q')).rejects.toThrow(/gh repo view failed \(4\) in C:\/q: To get started/);
  });

  it('bad credentials (exit 1, HTTP 401) is a failure too', async () => {
    const gh = new GhGitHub(answers(1, 'HTTP 401: Bad credentials (https://api.github.com/graphql)\n'), here);
    await expect(gh.remoteOf('C:/q')).rejects.toBeInstanceOf(GitHubError);
  });

  it('gh not installed is a failure, not exit code 1', async () => {
    const result = await ghAt('no-such-gh-for-the-queue-runner-app')(['--version'], process.cwd());
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/ENOENT/);
    await expect(new GhGitHub(ghAt('no-such-gh-for-the-queue-runner-app'), here).remoteOf(process.cwd()))
      .rejects.toThrow(/ENOENT/);
  });

  it('only gh\'s three "no repo here" answers, or a folder that is gone, are no remote', async () => {
    for (const said of [
      'failed to run git: fatal: not a git repository (or any of the parent directories): .git',
      'none of the git remotes configured for this repository point to a known GitHub host.',
      'no git remotes found',
    ]) expect(await new GhGitHub(answers(1, `${said}\n`), here).remoteOf('C:/x')).toBeNull();
    let asked = false;
    const gone = new GhGitHub(async () => { asked = true; return { code: 0, stdout: '', stderr: '' }; }, () => false);
    expect(await gone.remoteOf('C:/gone')).toBeNull();
    expect(asked).toBe(false);
  });

  it('--list prints the failure and exits 1, never "no GitHub remote"', async () => {
    const mcp = { call: async () => ({ projects: [{ id: 'p', title: 'queue-runner', workspaceRoot: 'C:/q' }], nextCursor: null }) };
    const ws = { first: async () => ({ config: { environment: { label: 'PC', serverVersion: '0.1.9' } } }) };
    const github = new GhGitHub(answers(4, 'To get started with GitHub CLI, please run:  gh auth login\n'), here);
    let out = '';
    expect(await run(['--list'], { mcp, ws, github }, (s) => { out += s; })).toBe(1);
    expect(out).not.toContain('no GitHub remote');
    expect(out).toContain('queue-runner\n  C:/q\n  gh failed: gh repo view failed (4) in C:/q: To get started');
  });
});
