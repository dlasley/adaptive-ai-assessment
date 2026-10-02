import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class ProcessExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

const { loadUnitMaterialsMock } = vi.hoisted(() => ({
  loadUnitMaterialsMock: vi.fn(),
}));

vi.mock('../src/lib/learning-materials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/learning-materials')>()),
  loadUnitMaterials: loadUnitMaterialsMock,
}));

import { auditHeadingPreflight } from '../src/commands/questions-audit';

/**
 * `auditHeadingPreflight` is the audit command's two-gate equivalent of `questions-generate.ts`'s
 * heading preflight (see `questions-generate-preflight.test.ts`):
 *
 * Gate 1 validates every topic's stored headings, for every unit referenced by the fetched
 * questions, against that unit's current markdown — a stale heading fails loudly instead of
 * `extractTopicContent` silently returning empty content for it.
 *
 * Gate 2 covers a topic gate 1 never inspects: one with no stored headings at all, whose
 * name-substring fallback in `extractTopicContent` also fails to match anything, plus an unknown
 * unit or topic — all of which would otherwise degrade silently to
 * `buildAuditMaterialsBlock`'s "(no source material found for this topic)" placeholder rather than
 * failing the run.
 */
describe('auditHeadingPreflight', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0);
    }) as unknown as typeof process.exit);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    loadUnitMaterialsMock.mockReset();
  });

  describe('gate 1 — stale stored headings', () => {
    it('exits non-zero naming the unit and mismatched heading for legacy word-token headings', () => {
      loadUnitMaterialsMock.mockReturnValue('## Bilan: Past Tense of Common Verbs\nContent.\n');
      const units = [{
        id: 'unit-1',
        title: 'Unit 1',
        description: '',
        source_file_stem: null,
        topics: [{ name: 'Verb Conjugation', headings: ['bilan:', 'past', 'tense', 'common', 'verbs'] }],
      }];

      expect(() => auditHeadingPreflight([{ unit_id: 'unit-1', topic: 'Verb Conjugation' }], units as never)).toThrow(ProcessExitError);

      const errorCalls = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      const errorText = errorCalls.map((args) => args.join(' ')).join('\n');
      expect(errorText).toContain('unit-1');
      expect(errorText).toContain('bilan:');
    });

    it('validates every distinct unit referenced by the fetched questions, not just the first', () => {
      loadUnitMaterialsMock.mockImplementation((unitId: string) =>
        unitId === 'unit-1' ? '## Real Heading\ncontent\n' : '## Something Else\ncontent\n',
      );
      const units = [
        { id: 'unit-1', title: 'Unit 1', description: '', source_file_stem: null, topics: [{ name: 'T1', headings: ['Real Heading'] }] },
        { id: 'unit-2', title: 'Unit 2', description: '', source_file_stem: null, topics: [{ name: 'T2', headings: ['stale'] }] },
      ];
      // unit-1 repeated across two questions — must be validated once, not twice.
      const questions = [
        { unit_id: 'unit-1', topic: 'T1' },
        { unit_id: 'unit-1', topic: 'T1' },
        { unit_id: 'unit-2', topic: 'T2' },
      ];

      expect(() => auditHeadingPreflight(questions, units as never)).toThrow(ProcessExitError);
      expect(loadUnitMaterialsMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('gate 2 — content resolution for topics gate 1 does not inspect', () => {
    it('exits when a headingless topic\'s name-substring fallback also fails to match anything', () => {
      loadUnitMaterialsMock.mockReturnValue('## Something Unrelated\ncontent\n');
      const units = [{
        id: 'unit-1',
        title: 'Unit 1',
        description: '',
        source_file_stem: null,
        topics: [{ name: 'Never Taught Topic', headings: [] }],
      }];

      expect(() => auditHeadingPreflight([{ unit_id: 'unit-1', topic: 'Never Taught Topic' }], units as never)).toThrow(ProcessExitError);

      const errorCalls = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      const errorText = errorCalls.map((args) => args.join(' ')).join('\n');
      expect(errorText).toContain('Never Taught Topic');
      expect(errorText).toContain('unit-1');
      expect(errorText).toContain('--map-existing');
      expect(errorText).toContain('--allow-missing-material');
    });

    it('does not exit when a headingless topic\'s name-substring fallback does resolve', () => {
      loadUnitMaterialsMock.mockReturnValue('## Vocabulary\nmot 1\nmot 2\n');
      const units = [{
        id: 'unit-1',
        title: 'Unit 1',
        description: '',
        source_file_stem: null,
        topics: [{ name: 'Vocabulary', headings: [] }],
      }];

      expect(() => auditHeadingPreflight([{ unit_id: 'unit-1', topic: 'Vocabulary' }], units as never)).not.toThrow();
    });

    it('exits when a question references a unit_id absent from the given units list', () => {
      const units: never[] = [];

      expect(() => auditHeadingPreflight([{ unit_id: 'ghost-unit', topic: 'Anything' }], units)).toThrow(ProcessExitError);
      expect(loadUnitMaterialsMock).not.toHaveBeenCalled();

      const errorCalls = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      const errorText = errorCalls.map((args) => args.join(' ')).join('\n');
      expect(errorText).toContain('ghost-unit');
    });

    it('exits when a question references a topic absent from the unit\'s curriculum and unmatched by the fallback', () => {
      loadUnitMaterialsMock.mockReturnValue('## Something Else Entirely\ncontent\n');
      const units = [{
        id: 'unit-1',
        title: 'Unit 1',
        description: '',
        source_file_stem: null,
        topics: [{ name: 'A Known Topic', headings: ['Something Else Entirely'] }],
      }];

      expect(() => auditHeadingPreflight([{ unit_id: 'unit-1', topic: 'A Topic Nobody Registered' }], units as never)).toThrow(ProcessExitError);
    });

    it('lists every unresolved (unit, topic) pair in one error, not just the first', () => {
      loadUnitMaterialsMock.mockReturnValue('## Something Unrelated\ncontent\n');
      const units = [{
        id: 'unit-1',
        title: 'Unit 1',
        description: '',
        source_file_stem: null,
        topics: [
          { name: 'First Missing Topic', headings: [] },
          { name: 'Second Missing Topic', headings: [] },
        ],
      }];
      const questions = [
        { unit_id: 'unit-1', topic: 'First Missing Topic' },
        { unit_id: 'unit-1', topic: 'Second Missing Topic' },
      ];

      expect(() => auditHeadingPreflight(questions, units as never)).toThrow(ProcessExitError);

      const errorCalls = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      const errorText = errorCalls.map((args) => args.join(' ')).join('\n');
      expect(errorText).toContain('First Missing Topic');
      expect(errorText).toContain('Second Missing Topic');
    });

    it('does not run gate 2 (or exit) when allowMissingMaterial is set', () => {
      const units: never[] = [];

      expect(() => auditHeadingPreflight(
        [{ unit_id: 'ghost-unit', topic: 'Anything' }],
        units,
        { allowMissingMaterial: true },
      )).not.toThrow();
    });
  });

  it('does not exit when every topic (headed or headingless) resolves to real content', () => {
    loadUnitMaterialsMock.mockReturnValue('## Bilan: Past Tense of Common Verbs\nContent.\n\n## Vocabulary\nmot 1\n');
    const units = [{
      id: 'unit-1',
      title: 'Unit 1',
      description: '',
      source_file_stem: null,
      topics: [
        { name: 'Verb Conjugation', headings: ['Bilan: Past Tense of Common Verbs'] },
        { name: 'Vocabulary', headings: [] },
      ],
    }];
    const questions = [
      { unit_id: 'unit-1', topic: 'Verb Conjugation' },
      { unit_id: 'unit-1', topic: 'Vocabulary' },
    ];

    expect(() => auditHeadingPreflight(questions, units as never)).not.toThrow();
  });
});
