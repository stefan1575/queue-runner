// Every T3 project with its folder and GitHub remote: the repos the app could serve.
import type { GitHub, Remote } from './github.ts';
import type { T3Mcp } from './t3/mcp.ts';

export type Project = { id: string; title: string; folder: string; remote: Remote | null };

const PAGE = 100;

/** T3's projects, every page of `t3_project_list`, each matched to its GitHub remote. */
export async function listProjects(mcp: Pick<T3Mcp, 'call'>, github: GitHub): Promise<Project[]> {
  const found: any[] = [];
  let cursor: number | null = 0;
  while (cursor !== null) {
    const page: any = await mcp.call('t3_project_list', { cursor, limit: PAGE });
    found.push(...(page?.projects ?? []));
    const next = page?.nextCursor;
    cursor = typeof next === 'number' && next > cursor ? next : null;
  }
  return Promise.all(found.map(async (p) => ({
    id: p.id, title: p.title, folder: p.workspaceRoot, remote: await github.remoteOf(p.workspaceRoot),
  })));
}

export function formatProjects(projects: Project[]): string {
  if (projects.length === 0) return 'T3 has no projects.\n';
  return projects.map((p) => `${p.title}\n  ${p.folder}\n  ${p.remote ? p.remote.nameWithOwner : 'no GitHub remote'}\n`).join('');
}
