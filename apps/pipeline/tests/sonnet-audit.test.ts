import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  applySonnetAuditResultsForGroup,
  EMPTY_SONNET_AUDIT_RESULTS_SUMMARY,
  mergeSonnetAuditResultsSummaries,
  SonnetAuditResult,
} from '../src/lib/sonnet-audit';

function makeResult(overrides: Partial<SonnetAuditResult> = {}): SonnetAuditResult {
  return {
    id: 'q-1',
    topic: 'greetings',
    type: 'fill-in-blank',
    writing_type: null,
    generated_by: 'anthropic/claude-sonnet-5',
    question: 'Comment dit-on "hello"?',
    answer: 'bonjour',
    answer_correct: true,
    grammar_correct: true,
    no_hallucination: true,
    question_coherent: true,
    notes: 'OK',
    usage: null,
    served_model: null,
    ...overrides,
  };
}

/** Records every write as a `{ update, id }` pair, whether it came in through the batched
 * `.upsert()` path or the per-row `.update().eq()` fallback, instead of touching a real database.
 * A batch containing any `failIds` row fails as a whole (as a real upsert would), so
 * `applyAuditWrites`'s row-by-row fallback is what actually exercises per-row failure. */
function makeFakeSupabase(opts: { failIds?: Set<string> } = {}) {
  const calls: { update: Record<string, unknown>; id: string }[] = [];
  const client = {
    from(_table: string) {
      return {
        update(data: Record<string, unknown>) {
          return {
            eq(_col: string, id: string) {
              calls.push({ update: data, id });
              if (opts.failIds?.has(id)) {
                return Promise.resolve({ error: { message: `simulated failure for ${id}` } });
              }
              return Promise.resolve({ error: null });
            },
          };
        },
        upsert(rows: Record<string, unknown>[]) {
          if (rows.some((row) => opts.failIds?.has(row.id as string))) {
            return Promise.resolve({ error: { message: 'simulated batch failure' } });
          }
          for (const { id, ...update } of rows) {
            calls.push({ update, id: id as string });
          }
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { supabase: client as unknown as SupabaseClient, calls };
}

describe('applySonnetAuditResultsForGroup', () => {
  const auditorModel = 'anthropic/claude-sonnet-5';

  it('flags a gate failure and activates a gate pass', async () => {
    const results = [makeResult({ id: 'fail', answer_correct: false }), makeResult({ id: 'pass' })];
    const { supabase, calls } = makeFakeSupabase();

    const summary = await applySonnetAuditResultsForGroup(supabase, results, auditorModel);

    expect(summary).toEqual({ activeCount: 1, flaggedCount: 1, errorCount: 0 });
    expect(calls.find((c) => c.id === 'fail')!.update.quality_status).toBe('flagged');
    expect(calls.find((c) => c.id === 'pass')!.update.quality_status).toBe('active');
  });

  it('stamps audit_metadata.prompt_hash from the promptHash argument, or null when omitted', async () => {
    const results = [makeResult({ id: 'a' })];
    const { supabase, calls } = makeFakeSupabase();

    await applySonnetAuditResultsForGroup(supabase, results, auditorModel, 'abc123');
    expect((calls[0].update.audit_metadata as Record<string, unknown>).prompt_hash).toBe('abc123');

    const { supabase: supabase2, calls: calls2 } = makeFakeSupabase();
    await applySonnetAuditResultsForGroup(supabase2, results, auditorModel);
    expect((calls2[0].update.audit_metadata as Record<string, unknown>).prompt_hash).toBeNull();
  });

  it('re-audit: writes flagged for a question that is currently active but now fails the gate', async () => {
    // Documents that the write never reads current quality_status first — the same verdict is
    // written whether the question was pending, active, or flagged beforehand, which is what lets
    // a re-audit (`--batch-id X --write-db`, no `--pending-only`) flip an active question to
    // flagged rather than only ever promoting pending ones.
    const results = [makeResult({ id: 'was-active', answer_correct: false })];
    const { supabase, calls } = makeFakeSupabase();

    const summary = await applySonnetAuditResultsForGroup(supabase, results, auditorModel);

    expect(summary.flaggedCount).toBe(1);
    expect(calls.find((c) => c.id === 'was-active')!.update.quality_status).toBe('flagged');
  });

  it('re-audit: writes active for a question that is currently flagged but now passes the gate', async () => {
    const results = [makeResult({ id: 'was-flagged' })];
    const { supabase, calls } = makeFakeSupabase();

    const summary = await applySonnetAuditResultsForGroup(supabase, results, auditorModel);

    expect(summary.activeCount).toBe(1);
    expect(calls.find((c) => c.id === 'was-flagged')!.update.quality_status).toBe('active');
  });

  it('leaves a PARSE_ERROR result unwritten — errors stay pending', async () => {
    const results = [makeResult({ id: 'ok' }), makeResult({ id: 'broken', notes: 'PARSE_ERROR: not json' })];
    const { supabase, calls } = makeFakeSupabase();

    const summary = await applySonnetAuditResultsForGroup(supabase, results, auditorModel);

    expect(summary.errorCount).toBe(1);
    expect(calls.some((c) => c.id === 'broken')).toBe(false);
    expect(calls.some((c) => c.id === 'ok')).toBe(true);
  });

  it('does not count a flag toward activeCount/flaggedCount when its database write fails', async () => {
    const results = [makeResult({ id: 'q' })];
    const { supabase } = makeFakeSupabase({ failIds: new Set(['q']) });

    const summary = await applySonnetAuditResultsForGroup(supabase, results, auditorModel);

    expect(summary.activeCount).toBe(0);
  });

  it('writes no remediation fields — Sonnet is metadata-only, unlike the Mistral auditor', async () => {
    const results = [makeResult({ id: 'q' })];
    const { supabase, calls } = makeFakeSupabase();

    await applySonnetAuditResultsForGroup(supabase, results, auditorModel);

    const call = calls[0];
    expect(Object.keys(call.update).sort()).toEqual(['audit_metadata', 'quality_status']);
    const metadata = call.update.audit_metadata as Record<string, unknown>;
    expect(metadata.auditor).toBe('sonnet');
    expect(metadata.gate_criteria).toEqual({
      answer_correct: true,
      grammar_correct: true,
      no_hallucination: true,
      question_coherent: true,
    });
  });

  it('produces the same total summary whether applied as one group or split across several', async () => {
    const results = [
      makeResult({ id: 'a' }),
      makeResult({ id: 'b', answer_correct: false }),
      makeResult({ id: 'c', notes: 'PARSE_ERROR: bad json' }),
      makeResult({ id: 'd' }),
    ];

    const single = makeFakeSupabase();
    const singleSummary = await applySonnetAuditResultsForGroup(single.supabase, results, auditorModel);

    const split = makeFakeSupabase();
    let splitSummary = EMPTY_SONNET_AUDIT_RESULTS_SUMMARY;
    for (const [start, end] of [[0, 2], [2, 4]] as const) {
      const groupSummary = await applySonnetAuditResultsForGroup(split.supabase, results.slice(start, end), auditorModel);
      splitSummary = mergeSonnetAuditResultsSummaries(splitSummary, groupSummary);
    }

    expect(splitSummary).toEqual(singleSummary);
  });
});
