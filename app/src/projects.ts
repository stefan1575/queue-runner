// Every T3 project with its folder and GitHub remote: the repos the app could serve.
import { GitHubError, type GitHub, type Remote } from './github.ts';
import type { T3Mcp } from './t3/mcp.ts';

/** `failure` is what gh said when it couldn't answer for the folder; `remote` is then null. */
export type Project = { id: string; title: string; folder: string; remote: Remote | null; failure?: string };

const PAGE = 100;

/** T3's projects, every page of `t3_project_list`, with no remote read: each one's id, title and
 *  folder. */
export async function t3Projects(mcp: Pick<T3Mcp, 'call'>): Promise<Omit<Project, 'remote' | 'failure'>[]> {
  const found: any[] = [];
  let cursor: number | null = 0;
  while (cursor !== null) {
    const page: any = await mcp.call('t3_project_list', { cursor, limit: PAGE });
    found.push(...(page?.projects ?? []));
    const next = page?.nextCursor;
    cursor = typeof next === 'number' && next > cursor ? next : null;
  }
  return found.map((p) => ({ id: p.id, title: p.title, folder: p.workspaceRoot }));
}

/** T3's projects, every page of `t3_project_list`, each matched to its GitHub remote. */
export async function listProjects(mcp: Pick<T3Mcp, 'call'>, github: GitHub): Promise<Project[]> {
  return Promise.all((await t3Projects(mcp)).map(async (project): Promise<Project> => {
    try {
      return { ...project, remote: await github.remoteOf(project.folder) };
    } catch (e) {
      if (!(e instanceof GitHubError)) throw e;
      return { ...project, remote: null, failure: e.message };
    }
  }));
}

export function formatProjects(projects: Project[]): string {
  if (projects.length === 0) return 'T3 has no projects.\n';
  const remote = (p: Project) =>
    (p.failure ? `gh failed: ${p.failure}` : p.remote ? p.remote.nameWithOwner : 'no GitHub remote');
  return projects.map((p) => `${p.title}\n  ${p.folder}\n  ${remote(p)}\n`).join('');
}
