import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchAllPagesMock } = vi.hoisted(() => ({
  fetchAllPagesMock: vi.fn(),
}));

vi.mock('../src/lib/db-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/db-queries')>()),
  fetchAllPages: fetchAllPagesMock,
}));

import { cli, fetchMistralQuestions, fetchSonnetQuestions } from '../src/commands/questions-audit';

/**
 * Re-auditing a batch's already-audited questions (`--batch-id X --write-db`, no `--pending-only`)
 * depends on the fetch never narrowing to `quality_status = 'pending'` unless that flag is set —
 * that's the only gate standing between "re-audit everything in this batch" and "only ever touch
 * pending rows". These tests record every `.eq()` call a fetch function's query-builder callback
 * makes, against a minimal fake chainable query object mirroring Supabase's own, so the assertion
 * doesn't depend on a live database.
 */
function makeQueryRecorder() {
  const calls: [string, unknown][] = [];
  const chain: { eq: (col: string, val: unknown) => typeof chain } = {
    eq(col, val) {
      calls.push([col, val]);
      return chain;
    },
  };
  return { chain, calls };
}

let recorder: ReturnType<typeof makeQueryRecorder>;

beforeEach(() => {
  recorder = makeQueryRecorder();
  fetchAllPagesMock.mockReset();
  fetchAllPagesMock.mockImplementation((_supabase, _table, build) => {
    build(recorder.chain);
    return Promise.resolve([]);
  });
});

describe('fetchMistralQuestions — quality_status filter', () => {
  it('filters to pending only when --pending-only is set', async () => {
    const options = cli.parse(['--batch-id', 'b1', '--pending-only']);

    await fetchMistralQuestions(options);

    expect(recorder.calls).toContainEqual(['quality_status', 'pending']);
  });

  it('does not filter by quality_status without --pending-only, so a re-audit reaches active and flagged rows too', async () => {
    const options = cli.parse(['--batch-id', 'b1']);

    await fetchMistralQuestions(options);

    expect(recorder.calls.some(([col]) => col === 'quality_status')).toBe(false);
    expect(recorder.calls).toContainEqual(['batch_id', 'b1']);
  });
});

describe('fetchSonnetQuestions — quality_status filter', () => {
  it('does not filter by quality_status without --pending-only', async () => {
    const options = cli.parse(['--auditor', 'sonnet', '--batch-id', 'b1']);

    await fetchSonnetQuestions(options);

    expect(recorder.calls.some(([col]) => col === 'quality_status')).toBe(false);
    expect(recorder.calls).toContainEqual(['batch_id', 'b1']);
  });
});
