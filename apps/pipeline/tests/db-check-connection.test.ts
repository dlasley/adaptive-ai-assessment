import { describe, expect, it } from 'vitest';
import { checkRelations, commandMeta } from '../src/commands/db-check-connection';
import type { ReadOnlySupabaseClient } from '../src/lib/db-queries';

function fakeClient(results: Record<string, { count?: number; error?: { message: string } }>) {
  const selected: string[] = [];
  const client: ReadOnlySupabaseClient = {
    from(table: string) {
      return {
        select: ((_columns: string, options: unknown) => {
          expect(options).toEqual({ count: 'exact', head: true });
          selected.push(table);
          const result = results[table] ?? { count: 0 };
          return Promise.resolve({ count: result.count ?? null, error: result.error ?? null });
        }) as never,
      };
    },
  };
  return { client, selected };
}

describe('db-check-connection', () => {
  it('reports a count for each readable relation and the error for an unreadable one', async () => {
    const { client, selected } = fakeClient({
      study_codes: { count: 3 },
      questions: { error: { message: 'relation "questions" does not exist' } },
    });
    const results = await checkRelations(client, ['study_codes', 'questions']);
    expect(results).toEqual([
      { relation: 'study_codes', count: 3, error: null },
      { relation: 'questions', count: null, error: 'relation "questions" does not exist' },
    ]);
    expect(selected).toEqual(['study_codes', 'questions']);
  });

  it('describes itself as a read-only check', () => {
    expect(commandMeta.description).toMatch(/writes nothing/i);
  });
});
