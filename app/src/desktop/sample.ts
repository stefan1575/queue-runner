// The sample Repositories a shoot shows (`--shoot`, docs/app.md, Screenshots): a served repo the
// runner merges, one you merge, one new from T3 and one with no GitHub remote. Nothing here
// reaches T3 or GitHub: the projects are fixed, and adding or removing says it's a sample.
import type { Remote } from '../github.ts';
import { Repositories } from '../repos.ts';
import type { SettingsStore } from '../settings.ts';
import { T3Error } from '../t3/seams.ts';
import type { T3Project } from '../t3/project-feed.ts';

const PROJECTS: (T3Project & { github: string | null })[] = [
  { id: 'sample-1', title: 'queue-runner', folder: 'C:\\Code\\queue-runner', github: 'ana-k/queue-runner' },
  { id: 'sample-2', title: 'game-backdrop', folder: 'C:\\Code\\game-backdrop', github: 'ana-k/game-backdrop' },
  { id: 'sample-3', title: 'portfolio-site', folder: 'C:\\Code\\portfolio-site', github: 'ana-k/portfolio-site' },
  { id: 'sample-4', title: 'scratch-notes', folder: 'C:\\Users\\ana\\scratch-notes', github: null },
];

export async function sampleRepos(settings: SettingsStore): Promise<Repositories> {
  await settings.update(() => ({
    repos: {
      'sample-1': { served: true, merge: 'runner', seen: true },
      'sample-2': { served: true, merge: 'me', seen: true },
      'sample-3': { served: false, merge: 'me', seen: false },
      'sample-4': { served: false, merge: 'me', seen: true },
    },
  }));
  const remote = (folder: string): Remote | null => {
    const g = PROJECTS.find((p) => p.folder === folder)?.github;
    return g ? { nameWithOwner: g, url: `https://github.com/${g}` } : null;
  };
  const refuse = async (): Promise<never> => { throw new T3Error('this is a sample: nothing reaches T3'); };
  return Repositories.start({
    feed: { current: () => PROJECTS.map(({ github, ...p }) => p), error: () => null, onChange: () => () => {} },
    github: { remoteOf: async (f) => remote(f), labelNames: async () => [], createLabel: async () => {} },
    settings,
    mcp: { call: refuse },
    pickFolder: async () => null,
  });
}
