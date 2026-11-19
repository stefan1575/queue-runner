// A run's reply, read through T3's MCP (#155; today's `T3Cli._run_text`, mirroring `runResultText`
// in T3's CLI, docs/t3.md): `t3_thread_read {view: messages}` paged by `afterPosition` until
// `hasMore` is false, the run's last `assistant_message` item, and its text read on by
// `textOffset` while T3 says it's truncated. A review's verdict is in this text, so it is read
// whole: a page or a continuation that comes back empty, or says there's more without saying
// where, throws (`ReplyCut`) and is read again by the caller, never taken as the reply's end. T3
// fills every page to its limit and says `hasMore` only when items are left (`matching.length >
// page.length`, read in the installed server 2026-11-19): so a later page that comes back empty,
// and a page short of the limit that says there's more, are cut reads too (#155 F20); only a page
// that says no more ends the paging. An empty first page is no reply yet (null), which the review
// lane reads again a few times before taking it as the thread's own (F12, `EMPTY_READS`).
import type { T3Mcp } from './mcp.ts';

const PAGE = 100;

/** T3 gave part of the reply empty, or said there was more without where: read it again. */
export class ReplyCut extends Error {}

/** The run's last assistant message, in full, or null when it has none. */
export async function runReply(mcp: Pick<T3Mcp, 'call'>, threadId: string, runId: string | null): Promise<string | null> {
  const items: any[] = [];
  let after: unknown = null;
  for (;;) {
    const page = (await mcp.call('t3_thread_read', { threadId, view: 'messages', limit: PAGE, runLimit: 1, ...(after === null ? {} : { afterPosition: after }) })) ?? {};
    const got: any[] = Array.isArray(page.items) ? page.items : [];
    const from = after === null ? 'the start' : `after ${after}`;
    if (!got.length && after !== null) throw new ReplyCut(`T3 gave thread ${threadId}'s messages from ${from} empty`);
    if (page.hasMore && got.length < PAGE) throw new ReplyCut(`T3 gave ${got.length} of thread ${threadId}'s messages from ${from} and said there were more`);
    items.push(...got);
    if (!page.hasMore) break;
    after = page.nextPosition ?? null;
    if (after === null) throw new ReplyCut(`T3 said thread ${threadId} has more messages, but not from where`);
  }
  const last = items.filter((i) => i?.type === 'assistant_message' && (!runId || i.runId === runId)).at(-1);
  if (!last) return null;
  let text = String(last.text ?? '');
  const next = (item: any): number | null => {
    if (!item.textTruncated) return null;
    if (typeof item.nextTextOffset !== 'number') throw new ReplyCut(`T3 cut message ${last.itemId}'s text without saying where it goes on`);
    return item.nextTextOffset;
  };
  let offset = next(last);
  while (offset !== null) {
    const page = (await mcp.call('t3_thread_read', { threadId, itemId: last.itemId, textOffset: offset, runLimit: 1 })) ?? {};
    const chunk = (Array.isArray(page.items) ? page.items : []).find((i: any) => i?.itemId === last.itemId);
    if (!chunk || !String(chunk.text ?? '')) throw new ReplyCut(`T3 gave message ${last.itemId}'s text from ${offset} empty`);
    text += String(chunk.text);
    offset = next(chunk);
  }
  return text;
}
