// #202 F2, again for #158 N1: a test that waits (`vi.waitFor`) waits on its own fakes, never on the
// disk. The lane tests read T3's address from a real `server-runtime.json` on every MCP call and
// kept their job log on disk, so a full parallel run on a busy PC timed their waits out. This fails
// a waiting test file that reads T3's address from a file (`runtimeAddress(<path>)`, where the fake's
// `t3.address` serves) or opens a job log with no in-memory files (`memoryJobFiles`).
import { describe, expect, it } from 'vitest';
import { hitsInAppTests } from './app-test-files.ts';

const SELF = ['test/waits-on-fakes.test.ts'];

/** What in a test file makes its waits wait on the disk, by line. */
export function diskWaits(source: string): string[] {
  if (!/\bvi\.waitFor\(/.test(source)) return [];
  const hits: string[] = [];
  source.split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;
    if (/\bruntimeAddress\(\s*[^)\s]/.test(line)) hits.push(`${i + 1}: T3's address read from a file (use the fake's t3.address): ${line.trim()}`);
    if (/\bJobLog\.open\(/.test(line) && !/[Ff]iles/.test(line)) hits.push(`${i + 1}: a job log on disk (pass memoryJobFiles()): ${line.trim()}`);
  });
  return hits;
}

describe('a test that waits waits on its fakes', () => {
  it('finds a waiting test that reads T3 from a file or keeps its job log on disk', () => {
    const source = [
      'await vi.waitFor(() => ok());',
      "const address = runtimeAddress(join(dir, 'server-runtime.json'));",
      "log = await JobLog.open(join(dir, 'jobs.jsonl'), () => clock);",
    ].join('\n');
    expect(diskWaits(source)).toEqual([
      "2: T3's address read from a file (use the fake's t3.address): const address = runtimeAddress(join(dir, 'server-runtime.json'));",
      "3: a job log on disk (pass memoryJobFiles()): log = await JobLog.open(join(dir, 'jobs.jsonl'), () => clock);",
    ]);
  });

  it('passes one on its fakes, and one that never waits', () => {
    expect(diskWaits("await vi.waitFor(() => ok());\nconst a = t3.address;\nlog = await JobLog.open(f, () => c, memoryJobFiles());")).toEqual([]);
    expect(diskWaits("log = await JobLog.open(join(dir, 'jobs.jsonl'));")).toEqual([]);
  });

  it("passes the app's tests", () => {
    expect(hitsInAppTests(SELF, diskWaits)).toEqual([]);
  });
});
