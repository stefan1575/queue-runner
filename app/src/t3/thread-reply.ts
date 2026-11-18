// A run's reply, read through T3's MCP (#155; today's `T3Cli._run_text`, mirroring `runResultText`
// in T3's CLI, docs/t3.md): `t3_thread_read {view: messages}` paged by `afterPosition` until
// `hasMore` is false, the run's last `assistant_message` item, and its text read on by
// `textOffset` while T3 says it's truncated. A review's verdict is in this text, so it is read
// whole.
import type { T3Mcp } from './mcp.ts';

/** The run's last assistant message, in full, or null when it has none. */
export async function runReply(mcp: Pick<T3Mcp, 'call'>, threadId: string, runId: string | null): Promise<string | null> {
  const items: any[] = [];
  let after: unknown = null;
  for (;;) {
    const page = (await mcp.call('t3_thread_read', { threadId, view: 'messages', limit: 100, runLimit: 1, ...(after === null ? {} : { afterPosition: after }) })) ?? {};
    items.push(...(Array.isArray(page.items) ? page.items : []));
    after = page.nextPosition ?? null;
    if (!page.hasMore || after === null) break;
  }
  const last = items.filter((i) => i?.type === 'assistant_message' && (!runId || i.runId === runId)).at(-1);
  if (!last) return null;
  let text = String(last.text ?? '');
  let offset = last.textTruncated ? last.nextTextOffset ?? null : null;
  while (offset !== null) {
    const page = (await mcp.call('t3_thread_read', { threadId, itemId: last.itemId, textOffset: offset, runLimit: 1 })) ?? {};
    const chunk = (Array.isArray(page.items) ? page.items : []).find((i: any) => i?.itemId === last.itemId);
    if (!chunk) break;
    text += String(chunk.text ?? '');
    offset = chunk.textTruncated ? chunk.nextTextOffset ?? null : null;
  }
  return text;
}
