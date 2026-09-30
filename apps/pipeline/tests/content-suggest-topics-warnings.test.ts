import { describe, expect, it } from 'vitest';
import {
  computeTopicWarnings,
  formatWarnings,
  MIN_TOPIC_CONTENT_CHARS,
  type TopicWarningInput,
} from '../src/commands/content-suggest-topics';
import { extractDocumentHeadings } from '../src/lib/learning-materials';

/**
 * Tests for the review-warnings heuristics: deterministic, non-blocking hints computed from a
 * topic's final (already-validated, already-collapsed) heading list. Each describes exactly one
 * signal in isolation, plus a combined "clean" case that produces none of them.
 */

function topic(name: string, headings: TopicWarningInput['headings'], totalChars: number): TopicWarningInput {
  return { name, headings, totalChars };
}

/**
 * Fixture for the containment checks, which need real document structure to resolve a heading
 * list to its actual line span: "Subjonctif" nests inside "Grammar", "Vocabulary" and "Culture"
 * are standalone siblings of "Grammar".
 */
const CONTAINMENT_MD = `<!-- slide 1 -->

## Grammar
Intro to grammar.

### Subjonctif
Nested content about the subjunctive.

## Vocabulary
Vocabulary content.

## Culture
Culture content.
`;
const CONTAINMENT_DOC_HEADINGS = extractDocumentHeadings(CONTAINMENT_MD);

describe('computeTopicWarnings — duplicate-content', () => {
  it('flags two topics whose heading sets resolve to the same content', () => {
    const warnings = computeTopicWarnings([
      topic('Warm Up Alpha', ['Warm Up'], 500),
      topic('Warm Up Beta', ['Warm Up'], 500),
    ]);
    expect(warnings).toEqual([
      { type: 'duplicate-content', message: '"Warm Up Alpha", "Warm Up Beta" resolve to identical content' },
    ]);
  });

  it('flags a group sharing the same headings regardless of list order', () => {
    const warnings = computeTopicWarnings([
      topic('One Alpha', ['One', 'Two'], 500),
      topic('One Beta', ['Two', 'One'], 500),
    ]);
    expect(warnings.filter(w => w.type === 'duplicate-content')).toHaveLength(1);
  });

  it('does not flag topics that merely share one heading among several', () => {
    const warnings = computeTopicWarnings([
      topic('One Alpha', ['One', 'Two'], 500),
      topic('Three Beta', ['Two', 'Three'], 500),
    ]);
    expect(warnings.filter(w => w.type === 'duplicate-content')).toHaveLength(0);
  });

  it('does not flag two topics that both have no headings', () => {
    const warnings = computeTopicWarnings([
      topic('A', [], 0),
      topic('B', [], 0),
    ]);
    expect(warnings.filter(w => w.type === 'duplicate-content')).toHaveLength(0);
  });
});

describe('computeTopicWarnings — containment', () => {
  it('flags a topic assigned a heading nested inside another topic\'s parent heading', () => {
    const warnings = computeTopicWarnings(
      [
        topic('Grammar Overview', ['Grammar'], 900),
        topic('Subjunctive', ['Subjonctif'], 300),
      ],
      CONTAINMENT_DOC_HEADINGS
    );
    const containment = warnings.filter(w => w.type === 'containment');
    expect(containment).toEqual([
      { type: 'containment', message: '"Subjunctive"\'s content is entirely contained in "Grammar Overview"\'s' },
    ]);
  });

  it('flags a topic whose single section is a subset of another topic\'s multiple sections', () => {
    const warnings = computeTopicWarnings(
      [
        topic('Everyday Life', ['Vocabulary', 'Culture'], 900),
        topic('Vocabulary Only', ['Vocabulary'], 400),
      ],
      CONTAINMENT_DOC_HEADINGS
    );
    const containment = warnings.filter(w => w.type === 'containment');
    expect(containment).toEqual([
      { type: 'containment', message: '"Vocabulary Only"\'s content is entirely contained in "Everyday Life"\'s' },
    ]);
  });

  it('does not flag two topics that merely overlap in one shared section', () => {
    const warnings = computeTopicWarnings(
      [
        topic('Grammar and Vocab', ['Grammar', 'Vocabulary'], 900),
        topic('Vocab and Culture', ['Vocabulary', 'Culture'], 900),
      ],
      CONTAINMENT_DOC_HEADINGS
    );
    expect(warnings.filter(w => w.type === 'containment')).toHaveLength(0);
  });

  it('reports an exact duplicate only under duplicate-content, not containment', () => {
    const warnings = computeTopicWarnings(
      [
        topic('Grammar A', ['Grammar'], 900),
        topic('Grammar B', ['Grammar'], 900),
      ],
      CONTAINMENT_DOC_HEADINGS
    );
    expect(warnings.filter(w => w.type === 'containment')).toHaveLength(0);
    expect(warnings.filter(w => w.type === 'duplicate-content')).toHaveLength(1);
  });

  it('is skipped entirely when documentHeadings is omitted', () => {
    const warnings = computeTopicWarnings([
      topic('Grammar Overview', ['Grammar'], 900),
      topic('Subjunctive', ['Subjonctif'], 300),
    ]);
    expect(warnings.filter(w => w.type === 'containment')).toHaveLength(0);
  });
});

describe('computeTopicWarnings — thin-content', () => {
  it('flags a topic whose content is under the threshold', () => {
    const warnings = computeTopicWarnings([topic('Warm Up', ['Warm Up'], MIN_TOPIC_CONTENT_CHARS - 1)]);
    expect(warnings).toEqual([
      {
        type: 'thin-content',
        message: `"Warm Up" resolves to only ${MIN_TOPIC_CONTENT_CHARS - 1} character(s) of content`,
      },
    ]);
  });

  it('does not flag a topic at or above the threshold', () => {
    const warnings = computeTopicWarnings([topic('Warm Up', ['Warm Up'], MIN_TOPIC_CONTENT_CHARS)]);
    expect(warnings.filter(w => w.type === 'thin-content')).toHaveLength(0);
  });

  it('does not flag a topic with no headings at all (already covered by the no-headings flag)', () => {
    const warnings = computeTopicWarnings([topic('Untethered', [], 0)]);
    expect(warnings.filter(w => w.type === 'thin-content')).toHaveLength(0);
  });
});

describe('computeTopicWarnings — shared-section', () => {
  it('flags a section linked by three or more topics', () => {
    // These three topics share the same single heading, so their heading sets are also
    // identical — expect both a shared-section warning and a duplicate-content one.
    const warnings = computeTopicWarnings([
      topic('Present Tense Practice', ['Verb Practice'], 500),
      topic('Passé Composé Practice', ['Verb Practice'], 500),
      topic('Imparfait Practice', ['Verb Practice'], 500),
    ]);
    const shared = warnings.filter(w => w.type === 'shared-section');
    expect(shared).toHaveLength(1);
    expect(shared[0].message).toContain('Verb Practice');
    expect(shared[0].message).toContain('3 topics');
  });

  it('does not flag a section linked by only two topics', () => {
    const warnings = computeTopicWarnings([
      topic('Present Tense Practice', ['Verb Practice'], 500),
      topic('Passé Composé Practice', ['Verb Practice'], 500),
    ]);
    expect(warnings.filter(w => w.type === 'shared-section')).toHaveLength(0);
  });

  it('distinguishes slide-disambiguated occurrences of the same heading text', () => {
    const warnings = computeTopicWarnings([
      topic('A', [{ heading: 'Exercices', slide: 1 }], 500),
      topic('B', [{ heading: 'Exercices', slide: 2 }], 500),
      topic('C', [{ heading: 'Exercices', slide: 3 }], 500),
    ]);
    expect(warnings.filter(w => w.type === 'shared-section')).toHaveLength(0);
  });
});

describe('computeTopicWarnings — name-mismatch', () => {
  it('flags a topic whose linked headings share no meaningful word with its name', () => {
    const warnings = computeTopicWarnings([topic('Greetings', ['Leçon Un'], 500)]);
    expect(warnings).toEqual([
      {
        type: 'name-mismatch',
        message: '"Greetings" shares no word with its linked heading(s): Leçon Un',
      },
    ]);
  });

  it('does not flag a topic sharing a word with its heading, case- and accent-insensitively', () => {
    const warnings = computeTopicWarnings([topic('VERBES pronominaux', ['Les verbes pronominaux'], 500)]);
    expect(warnings.filter(w => w.type === 'name-mismatch')).toHaveLength(0);
  });

  it('ignores a parenthetical aside in the topic name when checking for overlap', () => {
    const warnings = computeTopicWarnings([topic('Adjectives (agreement)', ['Grammar: Adjectives'], 500)]);
    expect(warnings.filter(w => w.type === 'name-mismatch')).toHaveLength(0);
  });

  it('does not flag a topic with no headings', () => {
    const warnings = computeTopicWarnings([topic('Untethered', [], 0)]);
    expect(warnings.filter(w => w.type === 'name-mismatch')).toHaveLength(0);
  });
});

describe('computeTopicWarnings — clean case', () => {
  it('produces no warnings for well-formed, distinct, adequately sized topics', () => {
    const warnings = computeTopicWarnings([
      topic('Warm Up Practice', ['Warm Up'], 500),
      topic('Grammar Basics', ['Grammar: Basics'], 600),
    ]);
    expect(warnings).toEqual([]);
  });
});

describe('formatWarnings', () => {
  it('returns an empty array when there are no warnings', () => {
    expect(formatWarnings([])).toEqual([]);
  });

  it('groups warnings by type under a labeled section', () => {
    const lines = formatWarnings([
      { type: 'thin-content', message: 'thin one' },
      { type: 'name-mismatch', message: 'mismatch one' },
      { type: 'thin-content', message: 'thin two' },
    ]);
    const text = lines.join('\n');
    expect(text).toContain('WARNINGS');
    const thinIndex = lines.findIndex(l => l.includes('thin one'));
    const thinTwoIndex = lines.findIndex(l => l.includes('thin two'));
    const mismatchIndex = lines.findIndex(l => l.includes('mismatch one'));
    expect(thinIndex).toBeLessThan(mismatchIndex);
    expect(thinTwoIndex).toBeLessThan(mismatchIndex);
  });
});
