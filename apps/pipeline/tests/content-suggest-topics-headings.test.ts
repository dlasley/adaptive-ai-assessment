import { describe, expect, it, vi } from 'vitest';
import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { callLlmMock } = vi.hoisted(() => ({ callLlmMock: vi.fn() }));

vi.mock('@adaptive/shared/llm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@adaptive/shared/llm')>()),
  callLlm: callLlmMock,
}));

import {
  buildHeadingRepairProposal,
  formatHeadingRepairTable,
  mapExistingHeadings,
  readProposalMappings,
} from '../src/commands/content-suggest-topics';
import {
  findHeadingMismatches,
  formatHeadingMismatches,
  type DocumentHeadingOccurrence,
} from '../src/lib/learning-materials';

/**
 * Tests for the heading-validation and repair-mode ("--map-existing") logic.
 * `findHeadingMismatches` is the validation step every extracted or mapped heading goes through
 * before it can be written to the units table; `mapExistingHeadings` is repair mode's LLM-driven
 * orchestration, tested here with the model stubbed so the retry path is deterministic.
 *
 * Heading text is not unique within a real unit document ("Exercices", "Warm Up" repeat across
 * sections), so a stored heading is either a bare string — valid only when that text is unique —
 * or a `{ heading, slide }` pair that pins the specific occurrence.
 */

function occ(heading: string, slide: number | null, level = 2): DocumentHeadingOccurrence {
  return { heading, slide, level, lineIndex: 0 };
}

const DOCUMENT_HEADINGS: DocumentHeadingOccurrence[] = [
  occ('Warm Up', 1),
  occ('Vocabulaire actif', 1),
  occ('Grammar: Subjonctif', 2),
  occ('Exercices', 3),
  occ('Exercices', 5), // duplicate text, different slide — the ambiguity case
];

describe('findHeadingMismatches', () => {
  it('reports no mismatches when every bare-string heading is unique in the document', () => {
    const topics = [{ name: 'Topic A', headings: ['Warm Up', 'Vocabulaire actif'] }];
    expect(findHeadingMismatches(topics, DOCUMENT_HEADINGS)).toEqual([]);
  });

  it('matches case- and whitespace-insensitively', () => {
    const topics = [{ name: 'Topic A', headings: ['  warm   up  ', 'VOCABULAIRE ACTIF'] }];
    expect(findHeadingMismatches(topics, DOCUMENT_HEADINGS)).toEqual([]);
  });

  it('flags a heading that does not appear in the document at all', () => {
    const topics = [{ name: 'Topic A', headings: ['Made Up Heading'] }];
    expect(findHeadingMismatches(topics, DOCUMENT_HEADINGS)).toEqual([
      { topic: 'Topic A', heading: 'Made Up Heading', reason: 'not-found' },
    ]);
  });

  it('flags a paraphrased or combined heading, not just a wholly invented one', () => {
    const topics = [{ name: 'Topic A', headings: ['Warm Up 08/18; 08/19'] }];
    const mismatches = findHeadingMismatches(topics, DOCUMENT_HEADINGS);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].heading).toBe('Warm Up 08/18; 08/19');
    expect(mismatches[0].reason).toBe('not-found');
  });

  it('reports one mismatch per bad heading across multiple topics', () => {
    const topics = [
      { name: 'Topic A', headings: ['Warm Up', 'Bogus 1'] },
      { name: 'Topic B', headings: ['Bogus 2'] },
    ];
    expect(findHeadingMismatches(topics, DOCUMENT_HEADINGS)).toEqual([
      { topic: 'Topic A', heading: 'Bogus 1', reason: 'not-found' },
      { topic: 'Topic B', heading: 'Bogus 2', reason: 'not-found' },
    ]);
  });

  it('flags a bare-string heading whose text is ambiguous (repeats in the document)', () => {
    const topics = [{ name: 'Topic A', headings: ['Exercices'] }];
    const mismatches = findHeadingMismatches(topics, DOCUMENT_HEADINGS);
    expect(mismatches).toEqual([{ topic: 'Topic A', heading: 'Exercices', reason: 'ambiguous' }]);
  });

  it('accepts a { heading, slide } ref that pins the intended occurrence of an ambiguous heading', () => {
    const topics = [{ name: 'Topic A', headings: [{ heading: 'Exercices', slide: 3 }] }];
    expect(findHeadingMismatches(topics, DOCUMENT_HEADINGS)).toEqual([]);
  });

  it('flags a { heading, slide } ref whose slide does not have that heading', () => {
    const topics = [{ name: 'Topic A', headings: [{ heading: 'Exercices', slide: 99 }] }];
    const mismatches = findHeadingMismatches(topics, DOCUMENT_HEADINGS);
    expect(mismatches).toEqual([{ topic: 'Topic A', heading: { heading: 'Exercices', slide: 99 }, reason: 'not-found' }]);
  });
});

describe('formatHeadingMismatches', () => {
  it('renders one line per mismatch naming the topic and the bad heading', () => {
    const text = formatHeadingMismatches([{ topic: 'Topic A', heading: 'Bogus', reason: 'not-found' }]);
    expect(text).toContain('Topic A');
    expect(text).toContain('Bogus');
  });

  it('notes when the reason is ambiguity rather than a missing heading', () => {
    const text = formatHeadingMismatches([{ topic: 'Topic A', heading: 'Exercices', reason: 'ambiguous' }]);
    expect(text).toMatch(/appears more than once/);
  });
});

describe('buildHeadingRepairProposal / formatHeadingRepairTable', () => {
  const markdown = `<!-- slide 1 -->

## Warm Up
Some content about greetings and introductions.
More content here to pad the section out.

<!-- slide 2 -->

## Vocabulaire actif
Vocabulary list content.
`;

  it('shapes a proposal with per-topic section/char/slide stats', () => {
    const proposal = buildHeadingRepairProposal(
      'unit-1',
      'content/markdown/Unit 1.md',
      markdown,
      ['Greetings', 'Vocabulary', 'Unmapped Topic'],
      { Greetings: ['Warm Up'], Vocabulary: ['Vocabulaire actif'], 'Unmapped Topic': [] },
    );

    expect(proposal.unitId).toBe('unit-1');
    expect(proposal.topics).toHaveLength(3);

    const greetings = proposal.topics.find(t => t.name === 'Greetings')!;
    expect(greetings.headings).toEqual(['Warm Up']);
    expect(greetings.sectionCount).toBe(1);
    expect(greetings.firstSlide).toBe(1);
    expect(greetings.totalChars).toBeGreaterThan(0);

    const unmapped = proposal.topics.find(t => t.name === 'Unmapped Topic')!;
    expect(unmapped.headings).toEqual([]);
    expect(unmapped.sectionCount).toBe(0);
    expect(unmapped.firstSlide).toBeNull();
  });

  it('flags topics with no heading or no matched content in the rendered table', () => {
    const proposal = buildHeadingRepairProposal(
      'unit-1',
      'content/markdown/Unit 1.md',
      markdown,
      ['Unmapped Topic', 'Stale Topic'],
      { 'Unmapped Topic': [], 'Stale Topic': ['Heading Not In Doc'] },
    );
    const table = formatHeadingRepairTable(proposal);
    expect(table).toContain('Unmapped Topic ⚠️ no heading');
    expect(table).toContain('Stale Topic ⚠️ no content');
  });

  it('does not flag a topic with matched headings and content', () => {
    const proposal = buildHeadingRepairProposal(
      'unit-1',
      'content/markdown/Unit 1.md',
      markdown,
      ['Greetings'],
      { Greetings: ['Warm Up'] },
    );
    const table = formatHeadingRepairTable(proposal);
    expect(table).not.toContain('⚠️');
  });

  it('renders a { heading, slide } ref with its slide in the table', () => {
    const proposal = buildHeadingRepairProposal(
      'unit-1',
      'content/markdown/Unit 1.md',
      markdown,
      ['Greetings'],
      { Greetings: [{ heading: 'Warm Up', slide: 1 }] },
    );
    const table = formatHeadingRepairTable(proposal);
    expect(table).toContain('Warm Up (slide 1)');
  });
});

describe('mapExistingHeadings (LLM stubbed)', () => {
  const markdown = `<!-- slide 1 -->

## Warm Up
Greetings content.

## Vocabulaire actif
Vocabulary content.
`;

  it('returns the model\'s mapping, simplified to bare strings, when every heading validates on the first pass', async () => {
    callLlmMock.mockResolvedValueOnce({
      text: JSON.stringify({
        topics: {
          Greetings: [{ heading: 'Warm Up', slide: 1 }],
          Vocabulary: [{ heading: 'Vocabulaire actif', slide: 1 }],
        },
      }),
    });

    const result = await mapExistingHeadings(['Greetings', 'Vocabulary'], markdown, 'test-session');

    // Both headings are unique in this document, so the slide is dropped in the stored form.
    expect(result).toEqual({ Greetings: ['Warm Up'], Vocabulary: ['Vocabulaire actif'] });
    expect(callLlmMock).toHaveBeenCalledTimes(1);
  });

  it('retries once and applies the correction when the first pass returns a bad heading', async () => {
    callLlmMock
      .mockResolvedValueOnce({
        text: JSON.stringify({
          topics: {
            Greetings: [{ heading: 'Warm Up 08/18', slide: 1 }],
            Vocabulary: [{ heading: 'Vocabulaire actif', slide: 1 }],
          },
        }),
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({ corrections: { Greetings: [{ heading: 'Warm Up', slide: 1 }] } }),
      });

    const result = await mapExistingHeadings(['Greetings', 'Vocabulary'], markdown, 'test-session');

    expect(result).toEqual({ Greetings: ['Warm Up'], Vocabulary: ['Vocabulaire actif'] });
    expect(callLlmMock).toHaveBeenCalledTimes(2);
  });

  it('throws, naming the still-bad heading, when the retry does not fix it', async () => {
    callLlmMock
      .mockResolvedValueOnce({ text: JSON.stringify({ topics: { Greetings: [{ heading: 'Bogus', slide: 1 }] } }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ corrections: {} }) });

    await expect(mapExistingHeadings(['Greetings'], markdown, 'test-session')).rejects.toThrow(/Bogus/);
    expect(callLlmMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the slide on a corrected heading whose text repeats elsewhere in the document', async () => {
    const dupMarkdown = `<!-- slide 3 -->

## Exercices
Wrong-section exercises the model first guessed.

<!-- slide 5 -->

## Exercices
Right-section exercises for this topic.
`;

    callLlmMock
      .mockResolvedValueOnce({ text: JSON.stringify({ topics: { Practice: [{ heading: 'Exercices', slide: 3 }] } }) });

    // No mismatch is raised here because the model already supplied a slide — this only exercises
    // that a disambiguated ref for a duplicated heading text is NOT simplified to a bare string.
    const result = await mapExistingHeadings(['Practice'], dupMarkdown, 'test-session');
    expect(result).toEqual({ Practice: [{ heading: 'Exercices', slide: 3 }] });
    expect(callLlmMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a response that uses a field other than "slide", naming the bad heading', async () => {
    const dupMarkdown = `<!-- slide 3 -->

## Exercices
Wrong-section exercises the model first guessed.

<!-- slide 5 -->

## Exercices
Right-section exercises for this topic.
`;

    // The prompt asks for { heading, slide }; a response using any other field has no `slide`
    // field, so it can never resolve to a specific occurrence of an ambiguous heading — this must
    // be treated exactly like any other unresolvable heading (mismatch, retry, then throw), never
    // silently accepted as if it meant slide 1 or the first occurrence.
    callLlmMock
      .mockResolvedValueOnce({ text: JSON.stringify({ topics: { Practice: [{ heading: 'Exercices', section: 3 }] } }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ corrections: {} }) });

    await expect(mapExistingHeadings(['Practice'], dupMarkdown, 'test-session')).rejects.toThrow(/Exercices/);
    expect(callLlmMock).toHaveBeenCalledTimes(2);
  });
});

describe('readProposalMappings', () => {
  it('reads a proposal file\'s topics into a name -> headings mapping', () => {
    const dir = mkdtempSync(join(tmpdir(), 'heading-repair-proposal-'));
    const path = join(dir, 'proposal.json');
    writeFileSync(path, JSON.stringify({
      unitId: 'unit-1',
      sourceFile: 'content/markdown/Unit 1.md',
      timestamp: new Date().toISOString(),
      topics: [
        { name: 'Greetings', headings: ['Warm Up'], sectionCount: 1, totalChars: 10, firstSlide: 1, lastSlide: 1 },
        { name: 'Practice', headings: [{ heading: 'Exercices', slide: 5 }], sectionCount: 1, totalChars: 20, firstSlide: 5, lastSlide: 5 },
      ],
    }));

    expect(readProposalMappings(path)).toEqual({
      Greetings: ['Warm Up'],
      Practice: [{ heading: 'Exercices', slide: 5 }],
    });
  });

  it('defaults a topic with no headings field to an empty array', () => {
    const dir = mkdtempSync(join(tmpdir(), 'heading-repair-proposal-'));
    const path = join(dir, 'proposal.json');
    writeFileSync(path, JSON.stringify({ topics: [{ name: 'Bare Topic' }] }));

    expect(readProposalMappings(path)).toEqual({ 'Bare Topic': [] });
  });
});
