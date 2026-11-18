// The samples a shoot shows (`--shoot`, docs/app.md, Screenshots). Repositories: a served repo the
// runner merges, one you merge, one new from T3 and one with no GitHub remote. Setup: its checks
// passing, and failing. Nothing here reaches T3 or GitHub: the projects and answers are fixed,
// and adding or removing a repo says it's a sample.
import type { Remote } from '../github.ts';
import { Repositories } from '../repos.ts';
import type { SettingsStore } from '../settings.ts';
import { checkSetup, type SetupDoors, type SetupReport } from '../setup.ts';
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

/** Setup's sample reports for a shoot, made by the real checks on fixed answers: everything in
 *  place (the sample T3 catalog's providers, gh signed in), or T3 not running and gh signed out. */
export async function sampleSetup(config: any): Promise<{ passing: SetupReport; failing: SetupReport }> {
  const at = () => new Date('2026-11-19T09:41:00');
  const signedIn = JSON.stringify({ hosts: { 'github.com': [{ state: 'success', active: true, host: 'github.com', login: 'ana-k' }] } });
  const doors = (up: boolean): SetupDoors => ({
    t3Installed: async () => true,
    address: async () => { if (!up) throw new T3Error(String.raw`T3's server isn't running (C:\Users\ana\.t3\userdata\server-runtime.json: Error)`); return 'http://127.0.0.1:3773'; },
    ws: { first: async () => ({ config: { ...config, settings: { ...config.settings, autoResumeLimitedThreads: false } } }) },
    mcp: { call: async () => ({ projects: [], nextCursor: null }) },
    gh: async () => (up
      ? { code: 0, stdout: signedIn, stderr: '' }
      : { code: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login' }),
  });
  return { passing: await checkSetup(doors(true), at), failing: await checkSetup(doors(false), at) };
}
