import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { LlmError, LlmNetworkError } from '@adaptive/shared/llm';
import {
  ApplyAuditResultsSummary,
  BatchJobStore,
  LlmBatchJobRow,
  MistralAuditResult,
  NewLlmBatchJobRow,
  QuestionRow,
  applyAuditResults,
  applyAuditResultsForGroup,
  applyGroupUsage,
  auditGroupWithRetry,
  buildAuditBatchRequests,
  buildFallbackSessionId,
  buildPassthroughResults,
  callMistralAuditGroup,
  createSupabaseBatchJobStore,
  EMPTY_AUDIT_RESULTS_SUMMARY,
  mergeAuditResultsSummaries,
  parseAuditResponse,
  renderedMistralAuditSystemPrompt,
  resultsForGroupItem,
  resumeAuditJob,
  submitAuditJob,
  sumResultUsage,
} from '../src/lib/mistral-audit';

/** Records every write as a `{ table, update, id }` triple, whether it came in through the batched
 * `.upsert()` path or the per-row `.update().eq()` fallback, instead of touching a real database.
 * A batch containing any `failIds` row fails as a whole (as a real upsert would), so
 * `applyAuditWrites`'s row-by-row fallback is what actually exercises per-row failure. */
function makeFakeSupabase(opts: { failIds?: Set<string> } = {}) {
  const calls: { table: string; update: Record<string, unknown>; id: string }[] = [];
  const client = {
    from(table: string) {
      return {
        update(data: Record<string, unknown>) {
          return {
            eq(_col: string, id: string) {
              calls.push({ table, update: data, id });
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
            calls.push({ table, update, id: id as string });
          }
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { supabase: client as unknown as SupabaseClient, calls };
}

function makeQuestion(overrides: Partial<QuestionRow> = {}): QuestionRow {
  return {
    id: 'q-1',
    question: 'Comment dit-on "hello"?',
    correct_answer: 'bonjour',
    type: 'fill-in-blank',
    difficulty: 'beginner',
    topic: 'greetings',
    unit_id: 'introduction',
    writing_type: null,
    generated_by: 'anthropic/claude-sonnet-5',
    options: null,
    acceptable_variations: null,
    ...overrides,
  };
}

function okResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'q-1',
    answer_correct: true,
    grammar_correct: true,
    no_hallucination: true,
    question_coherent: true,
    natural_language: true,
    register_appropriate: true,
    difficulty_appropriate: true,
    suggested_difficulty: null,
    variations_valid: true,
    culturally_appropriate: true,
    missing_variations: [],
    invalid_variations: [],
    notes: 'OK',
    severity: 'suggestion',
    ...overrides,
  };
}

/** A fully-typed `MistralAuditResult`, for tests that pass a result straight to
 * `applyAuditResultsForGroup` rather than through `JSON.stringify` + `parseAuditResponse`. */
function makeMistralResult(overrides: Partial<MistralAuditResult> = {}): MistralAuditResult {
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
    natural_language: true,
    register_appropriate: true,
    difficulty_appropriate: true,
    suggested_difficulty: null,
    variations_valid: true,
    culturally_appropriate: true,
    missing_variations: [],
    invalid_variations: [],
    notes: 'OK',
    severity: 'suggestion',
    usage: null,
    served_model: null,
    served_provider: null,
    response_meta: null,
    ...overrides,
  };
}

describe('parseAuditResponse', () => {
  it('matches results to questions by id, not array position', () => {
    const questions = [makeQuestion({ id: 'a' }), makeQuestion({ id: 'b' })];
    // Deliberately out of order — id matching must not depend on array position.
    const content = JSON.stringify([
      okResult({ id: 'b', answer_correct: false }),
      okResult({ id: 'a' }),
    ]);

    const results = parseAuditResponse(content, questions);

    expect(results.map((r) => r.id)).toEqual(['a', 'b']);
    expect(results[0].answer_correct).toBe(true);
    expect(results[1].answer_correct).toBe(false);
  });

  it('handles a { results: [...] } wrapper the same as a bare array', () => {
    const questions = [makeQuestion({ id: 'a' })];
    const content = JSON.stringify({ results: [okResult({ id: 'a' })] });

    const results = parseAuditResponse(content, questions);

    expect(results[0].id).toBe('a');
    expect(results[0].notes).toBe('OK');
  });

  it('accepts a response wrapped in a Markdown code fence', () => {
    const questions = [makeQuestion({ id: 'a' }), makeQuestion({ id: 'b' })];
    const content = '```json\n' + JSON.stringify([okResult({ id: 'a' }), okResult({ id: 'b' })], null, 2) + '\n```';

    const results = parseAuditResponse(content, questions);

    expect(results.map((r) => r.notes)).toEqual(['OK', 'OK']);
  });

  it('falls back to a passthrough result with a PARSE_ERROR note on malformed JSON', () => {
    const questions = [makeQuestion({ id: 'a' }), makeQuestion({ id: 'b' })];

    const results = parseAuditResponse('not json', questions);

    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.answer_correct).toBe(true);
      expect(r.notes).toContain('PARSE_ERROR:');
    }
  });

  it('marks a question PARSE_ERROR when no result carries its id', () => {
    const questions = [makeQuestion({ id: 'a' }), makeQuestion({ id: 'b' })];
    const content = JSON.stringify([okResult({ id: 'a' })]);

    const results = parseAuditResponse(content, questions);

    expect(results[0].notes).toBe('OK');
    expect(results[1].notes).toContain('PARSE_ERROR:');
    expect(results[1].notes).toContain('b');
    // Placeholder booleans on the error entry never gate a write — see isError in applyAuditResultsForGroup.
    expect(results[1].answer_correct).toBe(true);
  });

  it('marks a question PARSE_ERROR when its result is missing a gate criterion', () => {
    const questions = [makeQuestion({ id: 'a' })];
    const result = okResult({ id: 'a' });
    delete (result as Record<string, unknown>).natural_language;
    const content = JSON.stringify([result]);

    const results = parseAuditResponse(content, questions);

    expect(results[0].notes).toContain('PARSE_ERROR:');
    expect(results[0].notes).toContain('natural_language');
  });

  it('maps a bare-object response to the single question in a one-question group, without a PARSE_ERROR', () => {
    // A group of exactly one question (the production default) is a case a caller can hit; a model
    // asked to audit one question may reply with a single JSON object rather than a one-element array.
    const questions = [makeQuestion({ id: 'solo' })];
    const content = JSON.stringify(okResult({ id: 'solo' }));

    const results = parseAuditResponse(content, questions);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('solo');
    expect(results[0].notes).toBe('OK');
    expect(results[0].notes).not.toContain('PARSE_ERROR');
  });

  it('treats a single object returned for a multi-question group as one match, not a pass for every question', () => {
    const questions = [makeQuestion({ id: 'a' }), makeQuestion({ id: 'b' }), makeQuestion({ id: 'c' })];
    // A bare object (not an array, no results/questions wrapper) for a 3-question group.
    const content = JSON.stringify(okResult({ id: 'b' }));

    const results = parseAuditResponse(content, questions);

    expect(results.find((r) => r.id === 'a')?.notes).toContain('PARSE_ERROR:');
    expect(results.find((r) => r.id === 'b')?.notes).toBe('OK');
    expect(results.find((r) => r.id === 'c')?.notes).toContain('PARSE_ERROR:');
  });

  it('matches a one-question call\'s single result by position even when its id is corrupted', () => {
    // Mistral corrupts one hex character of the echoed UUID on a fraction of single-question
    // audits; with only one question in the call, the result can't belong to anything else.
    const questions = [makeQuestion({ id: 'a' })];
    const content = JSON.stringify([okResult({ id: 'a1234567-corrupted-hex-char' })]);

    const results = parseAuditResponse(content, questions);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('a');
    expect(results[0].notes).toBe('OK');
    expect(results[0].echoed_id).toBe('a1234567-corrupted-hex-char');
  });

  it('still runs the gate-criteria check on a one-question call\'s positionally matched result', () => {
    const questions = [makeQuestion({ id: 'a' })];
    const result = okResult({ id: 'corrupted-id-does-not-match-a' });
    delete (result as Record<string, unknown>).natural_language;
    const content = JSON.stringify([result]);

    const results = parseAuditResponse(content, questions);

    expect(results).toHaveLength(1);
    expect(results[0].notes).toContain('PARSE_ERROR:');
    expect(results[0].notes).toContain('natural_language');
  });

  it('rejects a one-question call that returns two results, even unmatched ids', () => {
    const questions = [makeQuestion({ id: 'a' })];
    const content = JSON.stringify([okResult({ id: 'x' }), okResult({ id: 'y' })]);

    const results = parseAuditResponse(content, questions);

    expect(results).toHaveLength(1);
    expect(results[0].notes).toContain('PARSE_ERROR:');
  });

  it('matches a five-question call\'s results by id, isolating a single corrupted id to its own question', () => {
    const questions = ['a', 'b', 'c', 'd', 'e'].map((id) => makeQuestion({ id }));
    const content = JSON.stringify([
      okResult({ id: 'a' }),
      okResult({ id: 'b-corrupted-hex' }),
      okResult({ id: 'c' }),
      okResult({ id: 'd' }),
      okResult({ id: 'e' }),
    ]);

    const results = parseAuditResponse(content, questions);

    expect(results).toHaveLength(5);
    for (const id of ['a', 'c', 'd', 'e']) {
      expect(results.find((r) => r.id === id)?.notes).toBe('OK');
    }
    const b = results.find((r) => r.id === 'b')!;
    expect(b.notes).toContain('PARSE_ERROR:');
    expect(b.notes).toContain('no result returned');
  });

  it('fails closed on a duplicate id — neither copy is used, not last-wins', () => {
    const questions = [makeQuestion({ id: 'a' }), makeQuestion({ id: 'b' })];
    const content = JSON.stringify([
      okResult({ id: 'a', answer_correct: true }),
      okResult({ id: 'a', answer_correct: false }),
      okResult({ id: 'b' }),
    ]);

    const results = parseAuditResponse(content, questions);

    const a = results.find((r) => r.id === 'a')!;
    const b = results.find((r) => r.id === 'b')!;
    expect(a.notes).toContain('PARSE_ERROR:');
    expect(a.notes).toContain('multiple results');
    // Placeholder booleans on the error entry never gate a write.
    expect(a.answer_correct).toBe(true);
    expect(b.notes).toBe('OK');
  });

  it('fails closed on three copies of the same id, not just two', () => {
    const questions = [makeQuestion({ id: 'a' })];
    const content = JSON.stringify([
      okResult({ id: 'a' }),
      okResult({ id: 'a', answer_correct: false }),
      okResult({ id: 'a' }),
    ]);

    const results = parseAuditResponse(content, questions);

    expect(results[0].notes).toContain('PARSE_ERROR:');
    expect(results[0].notes).toContain('multiple results');
  });

  it('lets soft signals default when the response omits them, without affecting gate criteria', () => {
    const questions = [makeQuestion({ id: 'a' })];
    const result = okResult({ id: 'a' });
    delete (result as Record<string, unknown>).difficulty_appropriate;
    delete (result as Record<string, unknown>).variations_valid;
    delete (result as Record<string, unknown>).culturally_appropriate;
    const content = JSON.stringify([result]);

    const results = parseAuditResponse(content, questions);

    expect(results[0].notes).toBe('OK');
    expect(results[0].difficulty_appropriate).toBe(true);
    expect(results[0].variations_valid).toBe(true);
    expect(results[0].culturally_appropriate).toBe(true);
  });
});

describe('buildPassthroughResults', () => {
  it('marks every field as passing and carries the given note', () => {
    const questions = [makeQuestion({ id: 'a' }), makeQuestion({ id: 'b' })];

    const results = buildPassthroughResults(questions, 'API_ERROR: boom');

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.notes === 'API_ERROR: boom')).toBe(true);
    expect(results.every((r) => r.answer_correct && r.grammar_correct)).toBe(true);
  });
});

describe('auditGroupWithRetry', () => {
  const retryOpts = {
    maxRetries: 3,
    initialBackoffMs: 10,
    maxBackoffMs: 100,
    sleepFn: vi.fn().mockResolvedValue(undefined),
  };

  it('returns the successful result on the first attempt without retrying', async () => {
    const group = [makeQuestion({ id: 'a' })];
    const auditFn = vi.fn().mockResolvedValue([{ id: 'a' }]);
    const onSuccess = vi.fn();

    const results = await auditGroupWithRetry(auditFn, group, { ...retryOpts, onSuccess });

    expect(auditFn).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(results).toEqual([{ id: 'a' }]);
  });

  it('retries a 429 with backoff and succeeds once the rate limit clears', async () => {
    const group = [makeQuestion({ id: 'a' })];
    const auditFn = vi.fn()
      .mockRejectedValueOnce(new LlmError('rate limited', 429))
      .mockRejectedValueOnce(new LlmError('rate limited', 429))
      .mockResolvedValueOnce([{ id: 'a' }]);
    const onRateLimited = vi.fn();
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    const results = await auditGroupWithRetry(auditFn, group, { ...retryOpts, sleepFn, onRateLimited });

    expect(auditFn).toHaveBeenCalledTimes(3);
    expect(onRateLimited).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledTimes(2);
    expect(results).toEqual([{ id: 'a' }]);
  });

  it('gives up after a 429 persists through every retry, producing one passthrough result per question', async () => {
    const group = [makeQuestion({ id: 'a' }), makeQuestion({ id: 'b' })];
    const auditFn = vi.fn().mockRejectedValue(new LlmError('rate limited', 429));
    const onRateLimitExhausted = vi.fn();

    const results = await auditGroupWithRetry(auditFn, group, { ...retryOpts, onRateLimitExhausted });

    expect(auditFn).toHaveBeenCalledTimes(retryOpts.maxRetries + 1);
    expect(onRateLimitExhausted).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.notes.startsWith('API_ERROR:'))).toBe(true);
  });

  it('a non-retryable error is attempted once and yields exactly one result per question', async () => {
    const group = [makeQuestion({ id: 'a' }), makeQuestion({ id: 'b' }), makeQuestion({ id: 'c' })];
    const auditFn = vi.fn().mockRejectedValue(new LlmError('bad request', 400));
    const onNonRetryableError = vi.fn();
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    const results = await auditGroupWithRetry(auditFn, group, { ...retryOpts, sleepFn, onNonRetryableError });

    // A 400 is never mistaken for a rate limit, so it must not be retried: exactly one call, and
    // exactly one result per question — not one passthrough set per failed attempt.
    expect(auditFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
    expect(onNonRetryableError).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(results.every((r) => r.notes.startsWith('API_ERROR:'))).toBe(true);
  });
});

describe('applyAuditResultsForGroup', () => {
  const opts = { auditorModel: 'mistralai/mistral-large-2512' };

  it('flags a gate failure and activates a gate pass, each with its own audit_metadata', async () => {
    const questions = [makeQuestion({ id: 'fail' }), makeQuestion({ id: 'pass' })];
    const results: MistralAuditResult[] = [
      makeMistralResult({ id: 'fail', answer_correct: false }),
      makeMistralResult({ id: 'pass' }),
    ];
    const { supabase, calls } = makeFakeSupabase();

    const summary = await applyAuditResultsForGroup(supabase, results, questions, opts);

    expect(summary).toEqual({ activeCount: 1, flaggedCount: 1, errorCount: 0, difficultyRelabeled: 0, variationsRemoved: 0 });
    const flaggedCall = calls.find((c) => c.id === 'fail')!;
    expect(flaggedCall.update.quality_status).toBe('flagged');
    const passCall = calls.find((c) => c.id === 'pass')!;
    expect(passCall.update.quality_status).toBe('active');
  });

  it('writes served_model but not served_provider to audit_metadata, even when the result carries one', async () => {
    const questions = [makeQuestion({ id: 'a' })];
    const results: MistralAuditResult[] = [
      makeMistralResult({ id: 'a', served_model: 'mistralai/mistral-large-2512', served_provider: 'Mistral' }),
    ];
    const { supabase, calls } = makeFakeSupabase();

    await applyAuditResultsForGroup(supabase, results, questions, opts);

    const metadata = calls.find((c) => c.id === 'a')!.update.audit_metadata as Record<string, unknown>;
    expect(metadata.served_model).toBe('mistralai/mistral-large-2512');
    expect('served_provider' in metadata).toBe(false);
  });

  it('stamps audit_metadata.prompt_hash from opts.promptHash, or null when omitted', async () => {
    const questions = [makeQuestion({ id: 'a' }), makeQuestion({ id: 'b' })];
    const results: MistralAuditResult[] = [makeMistralResult({ id: 'a' }), makeMistralResult({ id: 'b', answer_correct: false })];
    const { supabase, calls } = makeFakeSupabase();

    await applyAuditResultsForGroup(supabase, results, questions, { ...opts, promptHash: 'abc123' });
    expect((calls.find((c) => c.id === 'a')!.update.audit_metadata as Record<string, unknown>).prompt_hash).toBe('abc123');
    expect((calls.find((c) => c.id === 'b')!.update.audit_metadata as Record<string, unknown>).prompt_hash).toBe('abc123');

    const { supabase: supabase2, calls: calls2 } = makeFakeSupabase();
    await applyAuditResultsForGroup(supabase2, results, questions, opts);
    expect((calls2.find((c) => c.id === 'a')!.update.audit_metadata as Record<string, unknown>).prompt_hash).toBeNull();
  });

  it('leaves a PARSE_ERROR/API_ERROR result unwritten — errors stay pending', async () => {
    const questions = [makeQuestion({ id: 'ok' }), makeQuestion({ id: 'broken' })];
    const results: MistralAuditResult[] = [
      makeMistralResult({ id: 'ok' }),
      ...buildPassthroughResults([questions[1]], 'API_ERROR: boom'),
    ];
    const { supabase, calls } = makeFakeSupabase();

    const summary = await applyAuditResultsForGroup(supabase, results, questions, opts);

    expect(summary.errorCount).toBe(1);
    expect(calls.some((c) => c.id === 'broken')).toBe(false); // no write attempted for the error result
    expect(calls.some((c) => c.id === 'ok')).toBe(true);
  });

  it('relabels difficulty and drops invalid variations only on a passing question', async () => {
    const questions = [makeQuestion({ id: 'q', difficulty: 'beginner', acceptable_variations: ['bonjour', 'salut'] })];
    const results: MistralAuditResult[] = [
      makeMistralResult({
        id: 'q',
        difficulty_appropriate: false,
        suggested_difficulty: 'intermediate',
        variations_valid: false,
        invalid_variations: ['salut'],
      }),
    ];
    const { supabase, calls } = makeFakeSupabase();

    const summary = await applyAuditResultsForGroup(supabase, results, questions, opts);

    expect(summary).toEqual({ activeCount: 1, flaggedCount: 0, errorCount: 0, difficultyRelabeled: 1, variationsRemoved: 1 });
    const call = calls.find((c) => c.id === 'q')!;
    expect(call.update.difficulty).toBe('intermediate');
    expect(call.update.acceptable_variations).toEqual(['bonjour']);
  });

  it('throws instead of silently omitting difficulty when a result id has no matching question', async () => {
    const questions = [makeQuestion({ id: 'a' })];
    const results: MistralAuditResult[] = [makeMistralResult({ id: 'unmatched' })];
    const { supabase } = makeFakeSupabase();

    await expect(applyAuditResultsForGroup(supabase, results, questions, opts)).rejects.toThrow(
      /unmatched/
    );
  });

  it('re-audit: writes flagged for a question that is currently active but now fails the gate', async () => {
    // The fake supabase never reads current quality_status — this test documents that
    // applyAuditResultsForGroup writes the new verdict unconditionally, which is what makes a
    // re-audit (`--batch-id X --write-db`, no `--pending-only`) able to flip an active question to
    // flagged, not just promote pending ones.
    const questions = [makeQuestion({ id: 'was-active' })];
    const results: MistralAuditResult[] = [makeMistralResult({ id: 'was-active', answer_correct: false })];
    const { supabase, calls } = makeFakeSupabase();

    const summary = await applyAuditResultsForGroup(supabase, results, questions, opts);

    expect(summary.flaggedCount).toBe(1);
    expect(calls.find((c) => c.id === 'was-active')!.update.quality_status).toBe('flagged');
  });

  it('re-audit: writes active for a question that is currently flagged but now passes the gate', async () => {
    const questions = [makeQuestion({ id: 'was-flagged' })];
    const results: MistralAuditResult[] = [makeMistralResult({ id: 'was-flagged' })];
    const { supabase, calls } = makeFakeSupabase();

    const summary = await applyAuditResultsForGroup(supabase, results, questions, opts);

    expect(summary.activeCount).toBe(1);
    expect(calls.find((c) => c.id === 'was-flagged')!.update.quality_status).toBe('active');
  });

  it('does not count a flag toward activeCount/flaggedCount when its database write fails', async () => {
    const questions = [makeQuestion({ id: 'q' })];
    const results: MistralAuditResult[] = [makeMistralResult({ id: 'q' })];
    const { supabase } = makeFakeSupabase({ failIds: new Set(['q']) });

    const summary = await applyAuditResultsForGroup(supabase, results, questions, opts);

    expect(summary.activeCount).toBe(0);
  });

  it('produces the same total summary and the same set of writes whether applied as one group or split across several', async () => {
    const ids = ['a', 'b', 'c', 'd'];
    const questions = ids.map((id) => makeQuestion({ id }));
    const results: MistralAuditResult[] = [
      makeMistralResult({ id: 'a' }),
      makeMistralResult({ id: 'b', answer_correct: false }),
      ...buildPassthroughResults([questions[2]], 'PARSE_ERROR: bad json'),
      makeMistralResult({ id: 'd', difficulty_appropriate: false, suggested_difficulty: 'advanced' }),
    ];

    // Single-shot: the whole run applied in one call, as the --llm-batch-resume path does.
    const single = makeFakeSupabase();
    const singleSummary = await applyAuditResultsForGroup(single.supabase, results, questions, opts);

    // Split into two groups of two, as the streaming sync loop does.
    const split = makeFakeSupabase();
    let splitSummary = EMPTY_AUDIT_RESULTS_SUMMARY;
    for (const [start, end] of [[0, 2], [2, 4]] as const) {
      const groupSummary = await applyAuditResultsForGroup(
        split.supabase, results.slice(start, end), questions.slice(start, end), opts,
      );
      splitSummary = mergeAuditResultsSummaries(splitSummary, groupSummary);
    }

    expect(splitSummary).toEqual(singleSummary);
    // audited_at is a fresh timestamp per call, so it legitimately differs between the two runs —
    // strip it before comparing the rest of each write.
    const normalize = (calls: typeof single.calls) =>
      [...calls]
        .map((c) => {
          const metadata = c.update.audit_metadata as Record<string, unknown> | undefined;
          const { audited_at: _omit, ...rest } = metadata ?? {};
          return { ...c, update: { ...c.update, audit_metadata: rest } };
        })
        .sort((x, y) => x.id.localeCompare(y.id));
    expect(normalize(split.calls)).toEqual(normalize(single.calls));
  });
});

describe('applyAuditResults', () => {
  it('wraps a single applyAuditResultsForGroup call and returns its summary', async () => {
    const questions = [makeQuestion({ id: 'q' })];
    const results: MistralAuditResult[] = [makeMistralResult({ id: 'q' })];
    const { supabase } = makeFakeSupabase();

    const summary: ApplyAuditResultsSummary = await applyAuditResults(supabase, results, questions, {
      auditorModel: 'mistralai/mistral-large-2512',
    });

    expect(summary).toEqual({ activeCount: 1, flaggedCount: 0, errorCount: 0, difficultyRelabeled: 0, variationsRemoved: 0 });
  });
});

describe('buildFallbackSessionId', () => {
  it('derives one session id per job id, distinct from the sync CLI path\'s own session ids', () => {
    expect(buildFallbackSessionId('job-1')).toBe('job-1:audit-fallback');
    expect(buildFallbackSessionId('job-2')).toBe('job-2:audit-fallback');
  });
});

describe('buildAuditBatchRequests', () => {
  it('builds one request per group with a sequential customId and no per-request provider pin', () => {
    const groups = [[makeQuestion({ id: 'a' })], [makeQuestion({ id: 'b' })]];

    const requests = buildAuditBatchRequests(groups, 'SYSTEM PROMPT', []);

    expect(requests.map((r) => r.customId)).toEqual(['group-0', 'group-1']);
    for (const r of requests) {
      expect(r.temperature).toBe(0.1);
      expect(r.jsonMode).toBe(true);
      expect(r.messages[0]).toEqual({ role: 'system', content: 'SYSTEM PROMPT' });
      expect('providerOnly' in r).toBe(false);
    }
  });
});

describe('resultsForGroupItem', () => {
  it('parses a response item exactly as the sync path parses its own content', () => {
    const questions = [makeQuestion({ id: 'a' })];
    const item = {
      customId: 'group-0',
      response: {
        statusCode: 200,
        body: { choices: [{ message: { content: JSON.stringify([okResult({ id: 'a' })]) } }] },
      },
    };

    const results = resultsForGroupItem(item, questions);

    expect(results[0].id).toBe('a');
    expect(results[0].notes).toBe('OK');
  });

  it('produces an API_ERROR passthrough for an error item, without touching parseAuditResponse', () => {
    const questions = [makeQuestion({ id: 'a' }), makeQuestion({ id: 'b' })];
    const item = { customId: 'group-0', error: { message: 'provider timeout' } };

    const results = resultsForGroupItem(item, questions);

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.notes.startsWith('API_ERROR: provider timeout'))).toBe(true);
  });

  it('produces an API_ERROR passthrough when a response item has no extractable content', () => {
    const questions = [makeQuestion({ id: 'a' })];
    const item = { customId: 'group-0', response: { statusCode: 200, body: { choices: [] } } };

    const results = resultsForGroupItem(item, questions);

    expect(results[0].notes).toContain('API_ERROR:');
  });

  it('attaches the batch item response body\'s usage and served model to every result', () => {
    const questions = [makeQuestion({ id: 'a' }), makeQuestion({ id: 'b' })];
    const item = {
      customId: 'group-0',
      response: {
        statusCode: 200,
        body: {
          model: 'mistralai/mistral-large-2512',
          choices: [{ message: { content: JSON.stringify([okResult({ id: 'a' }), okResult({ id: 'b' })]) } }],
          usage: { prompt_tokens: 200, completion_tokens: 100, cost: 0.02 },
        },
      },
    };

    const results = resultsForGroupItem(item, questions);

    expect(results[0].served_model).toBe('mistralai/mistral-large-2512');
    expect(results[0].usage).toEqual({ prompt_tokens: 100, completion_tokens: 50, reasoning_tokens: null, cost_usd: 0.01, is_byok: null });
    expect(results[1].usage).toEqual(results[0].usage);
  });

  it('attaches the batch item response body\'s served provider to every result in a grouped call', () => {
    const questions = [makeQuestion({ id: 'a' }), makeQuestion({ id: 'b' })];
    const item = {
      customId: 'group-0',
      response: {
        statusCode: 200,
        body: {
          model: 'mistralai/mistral-large-2512',
          provider: 'Mistral',
          choices: [{ message: { content: JSON.stringify([okResult({ id: 'a' }), okResult({ id: 'b' })]) } }],
        },
      },
    };

    const results = resultsForGroupItem(item, questions);

    expect(results[0].served_provider).toBe('Mistral');
    expect(results[1].served_provider).toBe('Mistral');
  });

  it('attaches the batch item response body\'s served provider on a single-question call', () => {
    const questions = [makeQuestion({ id: 'a' })];
    const item = {
      customId: 'group-0',
      response: {
        statusCode: 200,
        body: {
          model: 'mistralai/mistral-large-2512',
          provider: 'Mistral',
          choices: [{ message: { content: JSON.stringify([okResult({ id: 'a' })]) } }],
        },
      },
    };

    const results = resultsForGroupItem(item, questions);

    expect(results[0].served_provider).toBe('Mistral');
  });
});

describe('applyGroupUsage', () => {
  it('divides cost and tokens evenly across the group and stamps every result with the served model', () => {
    const results = [makeMistralResult({ id: 'a' }), makeMistralResult({ id: 'b' })];

    const withUsage = applyGroupUsage(
      results,
      { promptTokens: 100, completionTokens: 50, reasoningTokens: 10, costUsd: 0.02 },
      'mistralai/mistral-large-2512',
    );

    expect(withUsage[0].usage).toEqual({ prompt_tokens: 50, completion_tokens: 25, reasoning_tokens: 5, cost_usd: 0.01, is_byok: null });
    expect(withUsage[1].usage).toEqual(withUsage[0].usage);
    expect(withUsage.every((r) => r.served_model === 'mistralai/mistral-large-2512')).toBe(true);
  });

  it('is a no-op when usage, servedModel, and servedProvider are all undefined', () => {
    const results = [makeMistralResult({ id: 'a' })];
    expect(applyGroupUsage(results, undefined, undefined)).toBe(results);
  });

  it('stamps every result with the served provider', () => {
    const results = [makeMistralResult({ id: 'a' }), makeMistralResult({ id: 'b' })];
    const withProvider = applyGroupUsage(results, undefined, undefined, 'Mistral');
    expect(withProvider.every((r) => r.served_provider === 'Mistral')).toBe(true);
  });
});

describe('sumResultUsage', () => {
  it('recovers the exact original totals by summing per-question shares back together', () => {
    const group = applyGroupUsage(
      [makeMistralResult({ id: 'a' }), makeMistralResult({ id: 'b' }), makeMistralResult({ id: 'c' })],
      { promptTokens: 300, completionTokens: 90, costUsd: 0.03 },
      'mistralai/mistral-large-2512',
    );

    const totals = sumResultUsage(group, 1);

    expect(totals).toEqual({ calls: 1, prompt_tokens: 300, completion_tokens: 90, reasoning_tokens: 0, cost_usd: 0.03, byok_calls: 0 });
  });

  it('uses the caller-supplied call count, not a count derived from results', () => {
    const results = [makeMistralResult({ id: 'a', usage: null })];
    expect(sumResultUsage(results, 3).calls).toBe(3);
  });
});

// ── In-memory BatchJobStore, for submit/resume tests ────────────────────────

function makeStore(seed: Partial<LlmBatchJobRow> = {}): { store: BatchJobStore; row: LlmBatchJobRow | null } {
  const state: { row: LlmBatchJobRow | null } = {
    row: {
      id: 'job-1',
      provider_batch_id: 'batch-1',
      stage: 'audit',
      pipeline_batch_id: 'audit-introduction-1',
      unit_id: 'introduction',
      model: 'mistralai/mistral-large-2512',
      provider_only: 'Mistral',
      status: 'in_progress',
      request_counts: { total: 2, completed: 0, failed: 0 },
      custom_id_context: { 'group-0': ['a'], 'group-1': ['b'] },
      error: null,
      is_fallback_applied: false,
      submitted_at: new Date().toISOString(),
      completed_at: null,
      applied_at: null,
      total_cost_usd: null,
      ...seed,
    },
  };

  const store: BatchJobStore = {
    async insert(row: NewLlmBatchJobRow) {
      state.row = {
        id: 'job-1',
        unit_id: null,
        provider_only: null,
        status: 'validating',
        request_counts: null,
        error: null,
        is_fallback_applied: false,
        submitted_at: new Date().toISOString(),
        completed_at: null,
        applied_at: null,
        total_cost_usd: null,
        ...row,
      };
      return state.row;
    },
    async get(id: string) {
      return state.row && state.row.id === id ? state.row : null;
    },
    async update(id, patch) {
      if (state.row && state.row.id === id) {
        state.row = { ...state.row, ...patch };
      }
    },
    async claim(id: string) {
      if (state.row && state.row.id === id && !state.row.applied_at) {
        state.row = { ...state.row, applied_at: new Date().toISOString() };
        return true;
      }
      return false;
    },
  };

  return { store, row: state.row };
}

describe('submitAuditJob', () => {
  it('chunks questions into request groups, submits one batch, and records the job with matching custom_id_context', async () => {
    const { store } = makeStore();
    const questions = [makeQuestion({ id: 'a' }), makeQuestion({ id: 'b' }), makeQuestion({ id: 'c' })];
    const submitBatchFn = vi.fn().mockResolvedValue({
      id: 'batch-xyz',
      status: 'validating',
      requestCounts: { total: 3, completed: 0, failed: 0 },
    });

    const result = await submitAuditJob(questions, {
      store,
      submitBatchFn,
      systemPrompt: 'SYSTEM',
      batchModel: 'mistralai/mistral-large-2512',
      pipelineBatchId: 'audit-introduction-1',
      units: [],
      unitId: 'introduction',
    });

    expect(submitBatchFn).toHaveBeenCalledTimes(1);
    const call = submitBatchFn.mock.calls[0][0];
    expect(call.model).toBe('mistralai/mistral-large-2512');
    expect(call.providerOnly).toBe('Mistral');
    expect(call.requests).toHaveLength(3); // 3 questions, group size 1 -> 3 groups

    expect(result.providerBatchId).toBe('batch-xyz');
    expect(result.groupCount).toBe(3);

    const row = await store.get(result.jobId);
    expect(row?.custom_id_context).toEqual({ 'group-0': ['a'], 'group-1': ['b'], 'group-2': ['c'] });
    expect(row?.model).toBe('mistralai/mistral-large-2512');
    expect(row?.pipeline_batch_id).toBe('audit-introduction-1');
  });
});

// ── resumeAuditJob ───────────────────────────────────────────────────────

function baseDeps(store: BatchJobStore, overrides: Record<string, unknown> = {}) {
  return {
    store,
    pollUntilDoneFn: vi.fn(),
    fetchQuestionsByIdsFn: vi.fn().mockResolvedValue([]),
    syncAuditFn: vi.fn().mockResolvedValue([]),
    applyResultsFn: vi.fn().mockResolvedValue({
      activeCount: 0,
      flaggedCount: 0,
      errorCount: 0,
      difficultyRelabeled: 0,
      variationsRemoved: 0,
    }),
    writeDb: false,
    fallbackModel: 'mistralai/mistral-large',
    ...overrides,
  };
}

describe('createSupabaseBatchJobStore — total_cost_usd tolerance', () => {
  function makeFakeJobsSupabase(errorOnFirstUpdate: { code?: string; message: string } | null) {
    const updateCalls: Record<string, unknown>[] = [];
    let callIndex = 0;
    const client = {
      from(_table: string) {
        return {
          update(data: Record<string, unknown>) {
            updateCalls.push(data);
            return {
              eq(_col: string, _id: string) {
                const err = callIndex === 0 ? errorOnFirstUpdate : null;
                callIndex++;
                return Promise.resolve({ error: err });
              },
            };
          },
        };
      },
    };
    return { supabase: client as unknown as SupabaseClient, updateCalls };
  }

  it('skips total_cost_usd with a warning and retries the rest when the column does not exist', async () => {
    const { supabase, updateCalls } = makeFakeJobsSupabase({ code: '42703', message: 'column "total_cost_usd" does not exist' });
    const store = createSupabaseBatchJobStore(supabase);

    await store.update('job-1', { completed_at: '2026-01-01T00:00:00Z', total_cost_usd: 0.05 });

    expect(updateCalls).toEqual([
      { completed_at: '2026-01-01T00:00:00Z', total_cost_usd: 0.05 },
      { completed_at: '2026-01-01T00:00:00Z' },
    ]);
  });

  it('does not issue a retry when the patch has no field besides total_cost_usd', async () => {
    const { supabase, updateCalls } = makeFakeJobsSupabase({ code: '42703', message: 'column "total_cost_usd" does not exist' });
    const store = createSupabaseBatchJobStore(supabase);

    await store.update('job-1', { total_cost_usd: 0.05 });

    expect(updateCalls).toHaveLength(1);
  });

  it('throws for an update error unrelated to the missing column', async () => {
    const { supabase } = makeFakeJobsSupabase({ message: 'connection reset' });
    const store = createSupabaseBatchJobStore(supabase);

    await expect(store.update('job-1', { completed_at: 'x' })).rejects.toThrow(/connection reset/);
  });

  it('throws a 42703 error too when it is not about total_cost_usd', async () => {
    const { supabase } = makeFakeJobsSupabase({ code: '42703', message: 'column "unrelated_column" does not exist' });
    const store = createSupabaseBatchJobStore(supabase);

    await expect(store.update('job-1', { completed_at: 'x' })).rejects.toThrow(/unrelated_column/);
  });
});

describe('resumeAuditJob', () => {
  it('returns not_found for an unknown job id without polling', async () => {
    const { store } = makeStore();
    const deps = baseDeps(store);

    const outcome = await resumeAuditJob('missing', deps as never);

    expect(outcome.kind).toBe('not_found');
    expect(deps.pollUntilDoneFn).not.toHaveBeenCalled();
  });

  it('short-circuits on an already-applied job without polling (double-resume guard)', async () => {
    const { store } = makeStore({ applied_at: new Date().toISOString() });
    const deps = baseDeps(store);

    const outcome = await resumeAuditJob('job-1', deps as never);

    expect(outcome.kind).toBe('already_applied');
    expect(deps.pollUntilDoneFn).not.toHaveBeenCalled();
  });

  it('reports still_running and writes no results while the batch is in flight', async () => {
    const { store } = makeStore();
    const requestCounts = { total: 2, completed: 1, failed: 0 };
    const deps = baseDeps(store, {
      pollUntilDoneFn: vi.fn().mockResolvedValue({
        outcome: 'still_running',
        result: { id: 'batch-1', status: 'in_progress', requestCounts, results: null, batchError: null },
      }),
      writeDb: true,
    });

    const outcome = await resumeAuditJob('job-1', deps as never);

    expect(outcome).toEqual({ kind: 'still_running', requestCounts });
    expect(deps.applyResultsFn).not.toHaveBeenCalled();
    const row = await store.get('job-1');
    expect(row?.status).toBe('in_progress');
  });

  it('reports poll_error for a 5xx or network failure while polling, and writes nothing', async () => {
    const cases: [LlmError, number | undefined][] = [
      [new LlmError('upstream batch-api returned HTTP 500', 500), 500],
      [new LlmNetworkError('network error reaching OpenRouter: getaddrinfo ENOTFOUND openrouter.ai'), undefined],
    ];
    for (const [error, status] of cases) {
      const { store } = makeStore();
      const before = await store.get('job-1');
      const deps = baseDeps(store, {
        pollUntilDoneFn: vi.fn().mockRejectedValue(error),
        writeDb: true,
      });

      const outcome = await resumeAuditJob('job-1', deps as never);

      expect(outcome).toEqual({ kind: 'poll_error', message: error.message, status });
      expect(deps.applyResultsFn).not.toHaveBeenCalled();
      expect(await store.get('job-1')).toEqual(before);
    }
  });

  it('propagates a status-less LlmError such as a missing API key instead of retrying it', async () => {
    const { store } = makeStore();
    const deps = baseDeps(store, {
      pollUntilDoneFn: vi.fn().mockRejectedValue(new LlmError('OPENROUTER_API_KEY is not set')),
      writeDb: true,
    });

    await expect(resumeAuditJob('job-1', deps as never)).rejects.toThrow('OPENROUTER_API_KEY is not set');
  });

  it('propagates a 4xx while polling instead of treating it as retryable', async () => {
    const { store } = makeStore();
    const deps = baseDeps(store, {
      pollUntilDoneFn: vi.fn().mockRejectedValue(new LlmError('batch not found', 404)),
      writeDb: true,
    });

    await expect(resumeAuditJob('job-1', deps as never)).rejects.toThrow('batch not found');
    expect(deps.applyResultsFn).not.toHaveBeenCalled();
  });

  it('reports terminal_no_fallback for a post-execution failure with no batchError, writes nothing, but records completed_at', async () => {
    const { store } = makeStore();
    const deps = baseDeps(store, {
      pollUntilDoneFn: vi.fn().mockResolvedValue({
        outcome: 'expired',
        result: { id: 'batch-1', status: 'expired', requestCounts: { total: 2, completed: 1, failed: 0 }, results: null, batchError: null },
      }),
      writeDb: true,
    });

    const outcome = await resumeAuditJob('job-1', deps as never);

    expect(outcome).toEqual({ kind: 'terminal_no_fallback', status: 'expired' });
    expect(deps.applyResultsFn).not.toHaveBeenCalled();
    expect(deps.syncAuditFn).not.toHaveBeenCalled();
    const row = await store.get('job-1');
    expect(row?.completed_at).toBeTruthy();
  });

  describe('whole-batch pre-execution failure', () => {
    function failedPoll() {
      return vi.fn().mockResolvedValue({
        outcome: 'failed',
        result: {
          id: 'batch-1',
          status: 'failed',
          requestCounts: { total: 2, completed: 0, failed: 0 },
          results: null,
          batchError: { message: 'invalid max_tokens', raw: { message: 'invalid max_tokens' } },
        },
      });
    }

    it('does not run the sync fallback when --write-db was not passed (preview only)', async () => {
      const { store } = makeStore();
      const deps = baseDeps(store, { pollUntilDoneFn: failedPoll(), writeDb: false });

      const outcome = await resumeAuditJob('job-1', deps as never);

      expect(outcome.kind).toBe('preview_only');
      expect(deps.syncAuditFn).not.toHaveBeenCalled();
      expect(deps.applyResultsFn).not.toHaveBeenCalled();
      const row = await store.get('job-1');
      // The failure is detected and recorded, but is_fallback_applied stays false: no sync call was
      // ever made, so the column's documented meaning ("the fallback actually ran") would be a lie.
      expect(row?.is_fallback_applied).toBe(false);
      expect(row?.error).toEqual({ message: 'invalid max_tokens', raw: { message: 'invalid max_tokens' } });
    });

    it('runs the sync fallback exactly once per group (no retry loop) and applies via the fallback model', async () => {
      const { store } = makeStore();
      const questionsById: Record<string, QuestionRow> = {
        a: makeQuestion({ id: 'a' }),
        b: makeQuestion({ id: 'b' }),
      };
      const deps = baseDeps(store, {
        pollUntilDoneFn: failedPoll(),
        writeDb: true,
        fetchQuestionsByIdsFn: vi.fn().mockResolvedValue(Object.values(questionsById)),
        syncAuditFn: vi.fn().mockImplementation(async (qs: QuestionRow[]) =>
          qs.map((q) => ({ id: q.id, notes: 'OK' }))
        ),
      });

      const outcome = await resumeAuditJob('job-1', deps as never);

      expect(outcome.kind).toBe('applied_via_fallback');
      // Two groups in custom_id_context ('group-0', 'group-1') -> exactly two sync calls.
      expect(deps.syncAuditFn).toHaveBeenCalledTimes(2);
      expect(deps.applyResultsFn).toHaveBeenCalledTimes(1);
      const [, , auditorModel] = deps.applyResultsFn.mock.calls[0];
      expect(auditorModel).toBe('mistralai/mistral-large');
      expect(outcome.kind === 'applied_via_fallback' && outcome.usage.calls).toBe(2);
    });

    it('sums the fallback\'s per-question usage shares into total_cost_usd on the job row', async () => {
      const { store } = makeStore();
      const questions = [makeQuestion({ id: 'a' }), makeQuestion({ id: 'b' })];
      const deps = baseDeps(store, {
        pollUntilDoneFn: failedPoll(),
        writeDb: true,
        fetchQuestionsByIdsFn: vi.fn().mockResolvedValue(questions),
        syncAuditFn: vi.fn().mockImplementation(async (qs: QuestionRow[]) =>
          applyGroupUsage(
            qs.map((q) => makeMistralResult({ id: q.id })),
            { costUsd: 0.01 },
            'mistralai/mistral-large-2512',
          )
        ),
      });

      const outcome = await resumeAuditJob('job-1', deps as never);

      expect(outcome.kind === 'applied_via_fallback' && outcome.usage.cost_usd).toBeCloseTo(0.02, 10);
      const row = await store.get('job-1');
      expect(row?.total_cost_usd).toBeCloseTo(0.02, 10);
    });

    it('is a no-op when a concurrent resume already claimed the job', async () => {
      const { store } = makeStore();
      const deps = baseDeps(store, {
        pollUntilDoneFn: failedPoll(),
        writeDb: true,
        fetchQuestionsByIdsFn: vi.fn().mockResolvedValue([makeQuestion({ id: 'a' })]),
        store: { ...store, claim: vi.fn().mockResolvedValue(false) },
      });

      const outcome = await resumeAuditJob('job-1', deps as never);

      expect(outcome.kind).toBe('claim_lost');
      expect(deps.syncAuditFn).not.toHaveBeenCalled();
      expect(deps.applyResultsFn).not.toHaveBeenCalled();
    });

    it('refuses to claim and writes nothing when none of the job\'s question ids resolve in the target table', async () => {
      const { store } = makeStore();
      const claim = vi.fn();
      const deps = baseDeps(store, {
        pollUntilDoneFn: failedPoll(),
        writeDb: true,
        fetchQuestionsByIdsFn: vi.fn().mockResolvedValue([]),
        store: { ...store, claim },
      });

      const outcome = await resumeAuditJob('job-1', deps as never);

      expect(outcome.kind).toBe('no_questions_resolved');
      expect(claim).not.toHaveBeenCalled();
      expect(deps.syncAuditFn).not.toHaveBeenCalled();
      expect(deps.applyResultsFn).not.toHaveBeenCalled();
    });
  });

  describe('completed batch', () => {
    function completedPoll(results: unknown[]) {
      return vi.fn().mockResolvedValue({
        outcome: 'completed',
        result: {
          id: 'batch-1',
          status: 'completed',
          requestCounts: { total: 2, completed: 2, failed: 0 },
          results,
          batchError: null,
        },
      });
    }

    it('does not apply when --write-db was not passed (preview only)', async () => {
      const { store } = makeStore();
      const deps = baseDeps(store, {
        pollUntilDoneFn: completedPoll([{ customId: 'group-0', error: { message: 'x' } }]),
        writeDb: false,
      });

      const outcome = await resumeAuditJob('job-1', deps as never);

      expect(outcome.kind).toBe('preview_only');
      expect(deps.applyResultsFn).not.toHaveBeenCalled();
    });

    it('maps a per-request error item to a passthrough result and applies with the batch job model (not the fallback model)', async () => {
      const { store } = makeStore();
      const questions = [makeQuestion({ id: 'a' }), makeQuestion({ id: 'b' })];
      const deps = baseDeps(store, {
        pollUntilDoneFn: completedPoll([
          { customId: 'group-0', error: { message: 'provider timeout' } },
          {
            customId: 'group-1',
            response: { statusCode: 200, body: { choices: [{ message: { content: JSON.stringify([okResult({ id: 'b' })]) } }] } },
          },
        ]),
        writeDb: true,
        fetchQuestionsByIdsFn: vi.fn().mockResolvedValue(questions),
      });

      const outcome = await resumeAuditJob('job-1', deps as never);

      expect(outcome.kind).toBe('applied');
      expect(deps.applyResultsFn).toHaveBeenCalledTimes(1);
      const [results, , auditorModel] = deps.applyResultsFn.mock.calls[0];
      expect(auditorModel).toBe('mistralai/mistral-large-2512'); // the job row's own (batch) model
      const byId = new Map((results as MistralAuditResult[]).map((r) => [r.id, r]));
      expect(byId.get('a')?.notes).toContain('API_ERROR: provider timeout');
      expect(byId.get('b')?.notes).toBe('OK');
    });

    it('sums per-group usage into the outcome and writes total_cost_usd on the job row', async () => {
      const { store } = makeStore();
      const questions = [makeQuestion({ id: 'a' }), makeQuestion({ id: 'b' })];
      const deps = baseDeps(store, {
        pollUntilDoneFn: completedPoll([
          {
            customId: 'group-0',
            response: {
              statusCode: 200,
              body: { model: 'mistralai/mistral-large-2512', choices: [{ message: { content: JSON.stringify([okResult({ id: 'a' })]) } }], usage: { cost: 0.01 } },
            },
          },
          {
            customId: 'group-1',
            response: {
              statusCode: 200,
              body: { model: 'mistralai/mistral-large-2512', choices: [{ message: { content: JSON.stringify([okResult({ id: 'b' })]) } }], usage: { cost: 0.015 } },
            },
          },
        ]),
        writeDb: true,
        fetchQuestionsByIdsFn: vi.fn().mockResolvedValue(questions),
      });

      const outcome = await resumeAuditJob('job-1', deps as never);

      expect(outcome.kind).toBe('applied');
      if (outcome.kind === 'applied') {
        expect(outcome.usage.calls).toBe(2);
        expect(outcome.usage.cost_usd).toBeCloseTo(0.025, 10);
      }
      const row = await store.get('job-1');
      expect(row?.total_cost_usd).toBeCloseTo(0.025, 10);
    });

    it('is a no-op when a concurrent resume already claimed the job', async () => {
      const { store } = makeStore();
      const deps = baseDeps(store, {
        pollUntilDoneFn: completedPoll([
          { customId: 'group-0', error: { message: 'x' } },
          { customId: 'group-1', error: { message: 'x' } },
        ]),
        writeDb: true,
        fetchQuestionsByIdsFn: vi.fn().mockResolvedValue([makeQuestion({ id: 'a' }), makeQuestion({ id: 'b' })]),
        store: { ...store, claim: vi.fn().mockResolvedValue(false) },
      });

      const outcome = await resumeAuditJob('job-1', deps as never);

      expect(outcome.kind).toBe('claim_lost');
      expect(deps.applyResultsFn).not.toHaveBeenCalled();
    });

    it('refuses to claim and writes nothing when none of the job\'s question ids resolve in the target table', async () => {
      const { store } = makeStore();
      const claim = vi.fn();
      const deps = baseDeps(store, {
        pollUntilDoneFn: completedPoll([
          { customId: 'group-0', error: { message: 'x' } },
          { customId: 'group-1', error: { message: 'x' } },
        ]),
        writeDb: true,
        fetchQuestionsByIdsFn: vi.fn().mockResolvedValue([]),
        store: { ...store, claim },
      });

      const outcome = await resumeAuditJob('job-1', deps as never);

      expect(outcome.kind).toBe('no_questions_resolved');
      expect(claim).not.toHaveBeenCalled();
      expect(deps.applyResultsFn).not.toHaveBeenCalled();
    });

    it('leaves a group with no matching result pending and records it on the job row, instead of fabricating a result', async () => {
      const { store } = makeStore(); // custom_id_context has group-0 -> ['a'], group-1 -> ['b']
      const questions = [makeQuestion({ id: 'a' }), makeQuestion({ id: 'b' })];
      const deps = baseDeps(store, {
        // Only group-0 has a result; group-1 is missing entirely.
        pollUntilDoneFn: completedPoll([
          { customId: 'group-0', response: { statusCode: 200, body: { choices: [{ message: { content: JSON.stringify([okResult({ id: 'a' })]) } }] } } },
        ]),
        writeDb: true,
        fetchQuestionsByIdsFn: vi.fn().mockResolvedValue(questions),
      });

      const outcome = await resumeAuditJob('job-1', deps as never);

      expect(outcome.kind).toBe('applied');
      expect(deps.applyResultsFn).toHaveBeenCalledTimes(1);
      const [results] = deps.applyResultsFn.mock.calls[0];
      // Only 'a' (group-0) got an audit verdict; 'b' (group-1, missing) was never fabricated a result.
      expect((results as MistralAuditResult[]).map((r) => r.id)).toEqual(['a']);

      const row = await store.get('job-1');
      expect(row?.error).toEqual({ missing_results: ['group-1'], unknown_results: [] });
    });

    it('records an unrecognized customId in the job row and ignores it, without crashing the collect loop', async () => {
      const { store } = makeStore();
      const questions = [makeQuestion({ id: 'a' }), makeQuestion({ id: 'b' })];
      const deps = baseDeps(store, {
        pollUntilDoneFn: completedPoll([
          { customId: 'group-0', response: { statusCode: 200, body: { choices: [{ message: { content: JSON.stringify([okResult({ id: 'a' })]) } }] } } },
          { customId: 'group-1', response: { statusCode: 200, body: { choices: [{ message: { content: JSON.stringify([okResult({ id: 'b' })]) } }] } } },
          { customId: 'group-99-unknown', response: { statusCode: 200, body: { choices: [{ message: { content: JSON.stringify([okResult()]) } }] } } },
        ]),
        writeDb: true,
        fetchQuestionsByIdsFn: vi.fn().mockResolvedValue(questions),
      });

      const outcome = await resumeAuditJob('job-1', deps as never);

      expect(outcome.kind).toBe('applied');
      const [results] = deps.applyResultsFn.mock.calls[0];
      expect((results as MistralAuditResult[]).map((r) => r.id).sort()).toEqual(['a', 'b']);

      const row = await store.get('job-1');
      expect(row?.error).toEqual({ missing_results: [], unknown_results: ['group-99-unknown'] });
    });
  });
});

describe('renderedMistralAuditSystemPrompt', () => {
  it('renders a non-empty prompt with course placeholders substituted', () => {
    const prompt = renderedMistralAuditSystemPrompt();
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).not.toContain('{{COURSE_NAME}}');
    expect(prompt).not.toContain('{{COURSE_LEVEL}}');
  });

  it('is stable across repeated calls (the underlying file read is memoized)', () => {
    expect(renderedMistralAuditSystemPrompt()).toBe(renderedMistralAuditSystemPrompt());
  });
});

describe('callMistralAuditGroup', () => {
  it('sends the rendered system prompt, the user prompt, and the injected settings, and parses the result', async () => {
    const questions = [makeQuestion({ id: 'q-1' })];
    const callLlmFn = vi.fn().mockResolvedValue({
      text: JSON.stringify([{
        id: 'q-1',
        answer_correct: true,
        grammar_correct: true,
        no_hallucination: true,
        question_coherent: true,
        natural_language: true,
        register_appropriate: true,
      }]),
      usage: { promptTokens: 100, completionTokens: 20, costUsd: 0.001 },
      servedModel: 'mistralai/mistral-small-2603',
      servedProvider: 'Mistral',
    });

    const results = await callMistralAuditGroup(
      questions,
      [],
      { model: 'mistralai/mistral-small-2603', temperature: 0.1, providerOnly: 'Mistral', sessionId: 'run-1:audit' },
      callLlmFn,
    );

    expect(callLlmFn).toHaveBeenCalledWith(expect.objectContaining({
      model: 'mistralai/mistral-small-2603',
      temperature: 0.1,
      jsonMode: true,
      providerOnly: 'Mistral',
      sessionId: 'run-1:audit',
    }));
    const call = callLlmFn.mock.calls[0][0];
    expect(call.messages[0].role).toBe('system');
    expect(call.messages[0].content).toBe(renderedMistralAuditSystemPrompt());
    expect(call.messages[1].content).toContain('ID: q-1');

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('q-1');
    expect(results[0].answer_correct).toBe(true);
    expect(results[0].served_model).toBe('mistralai/mistral-small-2603');
    expect(results[0].served_provider).toBe('Mistral');
  });

  it('attaches the served provider to every result of a grouped (multi-question) call', async () => {
    const questions = [makeQuestion({ id: 'q-1' }), makeQuestion({ id: 'q-2' })];
    const callLlmFn = vi.fn().mockResolvedValue({
      text: JSON.stringify([
        { id: 'q-1', answer_correct: true, grammar_correct: true, no_hallucination: true, question_coherent: true, natural_language: true, register_appropriate: true },
        { id: 'q-2', answer_correct: true, grammar_correct: true, no_hallucination: true, question_coherent: true, natural_language: true, register_appropriate: true },
      ]),
      servedModel: 'mistralai/mistral-large-2512',
      servedProvider: 'Mistral',
    });

    const results = await callMistralAuditGroup(
      questions,
      [],
      { model: 'mistralai/mistral-large-2512', providerOnly: 'Mistral' },
      callLlmFn,
    );

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.served_provider === 'Mistral')).toBe(true);
  });

  it('keeps the call\'s response facts on every row when the response does not parse', async () => {
    const questions = [makeQuestion({ id: 'q-1' }), makeQuestion({ id: 'q-2' })];
    const callLlmFn = vi.fn().mockResolvedValue({
      text: 'this is not JSON',
      servedModel: 'mistralai/mistral-large-2512',
      servedProvider: 'Mistral',
      raw: { id: 'gen-unparsed', choices: [{ finish_reason: 'length' }] },
    });

    const results = await callMistralAuditGroup(questions, [], { model: 'mistralai/mistral-large-2512' }, callLlmFn);

    expect(results.map((r) => r.notes.startsWith('PARSE_ERROR:'))).toEqual([true, true]);
    for (const result of results) {
      expect(result.response_meta).toEqual({ id: 'gen-unparsed', choices: [{ finish_reason: 'length' }] });
    }
  });

  it('passes reasoning and provider through when set, alongside providerOnly/temperature omitted', async () => {
    const questions = [makeQuestion({ id: 'q-1' })];
    const callLlmFn = vi.fn().mockResolvedValue({ text: '[]' });

    await callMistralAuditGroup(
      questions,
      [],
      { model: 'google/gemini-2.5-flash', reasoning: { effort: 'none' }, provider: { order: ['google-ai-studio'] } },
      callLlmFn,
    );

    expect(callLlmFn).toHaveBeenCalledWith(expect.objectContaining({
      model: 'google/gemini-2.5-flash',
      reasoning: { effort: 'none' },
      provider: { order: ['google-ai-studio'] },
    }));
    const call = callLlmFn.mock.calls[0][0];
    expect(call.temperature).toBeUndefined();
    expect(call.providerOnly).toBeUndefined();
  });
});
