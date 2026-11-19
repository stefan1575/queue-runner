// In place or fresh (#158; today's limits.resume_choice): warm continues at any size, cold continues
// under 120k tokens, and an unknown age is cold, an unknown size large. The numbers come from T3's
// thread projection: its newest provider turn.
import { describe, expect, test } from 'vitest';
import { COLD_FRESH_MIN, resumeChoice, threadNow, WARM_FOR_MS } from '../src/resume.ts';

const NOW = new Date('2026-11-19T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe('resumeChoice', () => {
  test('warm: in place at any size', () => {
    expect(resumeChoice(ago(WARM_FOR_MS - 60_000), 500_000, NOW)).toEqual({ inPlace: true, why: expect.stringContaining('warm (its last request started 54 minutes ago)') });
  });
  test('cold and under the line: in place; at or over it: fresh', () => {
    expect(resumeChoice(ago(WARM_FOR_MS), COLD_FRESH_MIN - 1, NOW).inPlace).toBe(true);
    expect(resumeChoice(ago(2 * 3600_000), COLD_FRESH_MIN, NOW)).toEqual({ inPlace: false, why: 'cold (its last request started 2h00 ago) and 120,000 tokens, at least 120,000: a fresh thread is cheaper' });
  });
  test('an unknown age is cold, an unknown size large', () => {
    expect(resumeChoice(null, 1000, NOW).inPlace).toBe(true);
    expect(resumeChoice(null, null, NOW)).toEqual({ inPlace: false, why: 'cold (when its last request started is unknown) and its size unknown: a fresh thread' });
  });
});

describe('threadNow', () => {
  test("reads the newest provider turn, the runs, and the pending question with its questions' ids", async () => {
    const ws = { request: async () => ({
      runs: [{ id: 'r2', ordinal: 2 }, { id: 'r1', ordinal: 1 }],
      providerTurns: [
        { startedAt: '2026-11-19T11:30:00Z', tokenUsage: { usedTokens: 90_000 } },
        { startedAt: '2026-11-19T10:00:00Z', tokenUsage: { usedTokens: 40_000 } },
      ],
      runtimeRequests: [{ id: 'q1', kind: 'user_input', status: 'pending' }, { id: 'q0', kind: 'user_input', status: 'resolved' }],
      turnItems: [{ type: 'user_input_request', requestId: 'q1', questions: [{ id: 'which' }, { id: 'why' }] }],
    }) } as any;
    expect(await threadNow(ws, 't')).toEqual({
      lastRequest: new Date('2026-11-19T11:30:00Z'), tokens: 90_000, runs: ['r1', 'r2'], pending: { requestId: 'q1', questions: ['which', 'why'] },
    });
  });
  test('a thread with no turns has no age or size; one with no pending question has none', async () => {
    const ws = { request: async () => ({ runs: [], providerTurns: [], runtimeRequests: [], turnItems: [] }) } as any;
    expect(await threadNow(ws, 't')).toEqual({ lastRequest: null, tokens: null, runs: [], pending: null });
  });
});
