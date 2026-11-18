import { describe, expect, it } from 'vitest';
import { run } from '../src/app.ts';
import { GhGitHub, type GitHub } from '../src/github.ts';
import { formatProjects, listProjects } from '../src/projects.ts';

const remotes: Record<string, string> = { 'C:/a': 'stefan1575/queue-runner-sandbox' };
const github: GitHub = {
  remoteOf: async (f) => (remotes[f] ? { nameWithOwner: remotes[f]!, url: `https://github.com/${remotes[f]}` } : null),
};

function pagedMcp(projects: object[], size: number) {
  const calls: any[] = [];
  return {
    calls,
    call: async (tool: string, args: any) => {
      calls.push({ tool, args });
      const next = args.cursor + size < projects.length ? args.cursor + size : null;
      return { projects: projects.slice(args.cursor, args.cursor + size), nextCursor: next };
    },
  };
}

const projects = [
  { id: 'p1', title: 'queue-runner sandbox', workspaceRoot: 'C:/a' },
  { id: 'p2', title: 'No project', workspaceRoot: 'C:/scratch' },
  { id: 'p3', title: 'third', workspaceRoot: 'C:/c' },
];

describe('listing projects', () => {
  it('reads every page and matches each folder to its GitHub remote', async () => {
    const mcp = pagedMcp(projects, 2);
    const found = await listProjects(mcp, github);
    expect(mcp.calls.map((c) => c.args.cursor)).toEqual([0, 2]);
    expect(found.map((p) => [p.title, p.remote?.nameWithOwner ?? null])).toEqual([
      ['queue-runner sandbox', 'stefan1575/queue-runner-sandbox'], ['No project', null], ['third', null],
    ]);
  });

  it('prints each project with its folder and remote, or "no GitHub remote"', async () => {
    const text = formatProjects(await listProjects(pagedMcp(projects, 100), github));
    expect(text).toBe('queue-runner sandbox\n  C:/a\n  stefan1575/queue-runner-sandbox\n'
      + 'No project\n  C:/scratch\n  no GitHub remote\n' + 'third\n  C:/c\n  no GitHub remote\n');
  });

  it('--list opens the WebSocket, prints the projects and changes nothing', async () => {
    const mcp = pagedMcp(projects.slice(0, 1), 100);
    const ws = { first: async (tag: string) => ({ tag, config: { environment: { label: 'PC', serverVersion: '0.1.9' } } }) };
    let out = '';
    const code = await run(['--', '--list'], { mcp, ws, github }, (s) => { out += s; });
    expect(code).toBe(0);
    expect(out).toBe('T3 0.1.9 on PC\n\nqueue-runner sandbox\n  C:/a\n  stefan1575/queue-runner-sandbox\n');
    expect(mcp.calls.map((c) => c.tool)).toEqual(['t3_project_list']);
  });

  it('anything but --list prints the usage', async () => {
    let out = '';
    const doors = { mcp: pagedMcp([], 1), ws: { first: async () => ({}) }, github };
    expect(await run([], doors, (s) => { out += s; })).toBe(2);
    expect(out).toMatch(/usage/);
  });
});

describe('GitHub through gh', () => {
  it('asks gh in the project\'s folder', async () => {
    const seen: any[] = [];
    const gh = new GhGitHub(async (args, cwd) => {
      seen.push({ args, cwd });
      return { code: 0, stdout: '{"nameWithOwner":"o/r","url":"https://github.com/o/r"}' };
    });
    expect(await gh.remoteOf('C:/a')).toEqual({ nameWithOwner: 'o/r', url: 'https://github.com/o/r' });
    expect(seen).toEqual([{ args: ['repo', 'view', '--json', 'nameWithOwner,url'], cwd: 'C:/a' }]);
  });

  it('a folder gh finds no repo for has no remote', async () => {
    expect(await new GhGitHub(async () => ({ code: 1, stdout: '' })).remoteOf('C:/x')).toBeNull();
  });
});
