import { describe, expect, it } from 'vitest';
import { ReplyCut, runReply } from '../src/t3/thread-reply.ts';

// a T3 that answers `view: messages` reads from a script of pages, one per read, in order
const msg = (i: number, type = 'user_message', text = `m${i}`) => ({ itemId: `i${i}`, type, runId: 'run-1', text, textTruncated: false });
const full = (from: number, last: any = null) => Array.from({ length: 100 }, (_, k) => (k === 99 && last ? last : msg(from + k)));
function scripted(pages: any[]) {
  const reads: any[] = [];
  return { reads, call: async (_tool: string, args: any) => { reads.push(args); return pages.shift(); } };
}

describe("a run's reply over several message pages (#155 F20)", () => {
  it('pages on to the last page and takes its last assistant message', async () => {
    const mcp = scripted([
      { items: full(0, msg(99, 'assistant_message', 'interim')), hasMore: true, nextPosition: 99 },
      { items: [msg(100, 'assistant_message', 'final')], hasMore: false, nextPosition: 100 },
    ]);
    expect(await runReply(mcp, 't', 'run-1')).toBe('final');
    expect(mcp.reads.map((r) => r.afterPosition)).toEqual([undefined, 99]);
  });

  it('an empty later page is a cut read, never the end: the interim update is not taken as the reply', async () => {
    const mcp = scripted([
      { items: full(0, msg(99, 'assistant_message', 'interim')), hasMore: true, nextPosition: 99 },
      { items: [], hasMore: false, nextPosition: null },
    ]);
    await expect(runReply(mcp, 't', 'run-1')).rejects.toThrow(new ReplyCut("T3 gave thread t's messages from after 99 empty"));
  });

  it('an empty first page is no reply yet, which the lane reads again a few times (F12)', async () => {
    expect(await runReply(scripted([{ items: [], hasMore: false, nextPosition: null }]), 't', 'run-1')).toBeNull();
  });

  it('a page short of the limit that says there are more is a cut read', async () => {
    const mcp = scripted([{ items: [msg(0), msg(1, 'assistant_message', 'interim')], hasMore: true, nextPosition: 1 }]);
    await expect(runReply(mcp, 't', 'run-1')).rejects.toThrow("T3 gave 2 of thread t's messages from the start and said there were more");
  });

  it('a short last page that says no more ends the paging; a run with no assistant message has none', async () => {
    expect(await runReply(scripted([{ items: [msg(0), msg(1, 'assistant_message', 'done')], hasMore: false, nextPosition: 1 }]), 't', 'run-1')).toBe('done');
    expect(await runReply(scripted([{ items: [msg(0)], hasMore: false, nextPosition: 0 }]), 't', 'run-1')).toBeNull();
  });
});
