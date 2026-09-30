import { describe, expect, it } from 'vitest';
import {
  normalizeHeadingText,
  extractDocumentHeadings,
  extractTopicContent,
  summarizeExactSections,
  isHeadingTextUnique,
  simplifyHeadingRef,
  headingRefKey,
  formatHeadingRef,
  findUnitHeadingMismatches,
  formatHeadingPreflightError,
  collapseNestedHeadings,
} from '../src/lib/learning-materials';

/**
 * A small document exercising every shape extractTopicContent's exact-match path has to
 * handle: a heading that appears twice ("Warm Up"), a nested subsection under "Grammar" that
 * must NOT break its parent section, a section under 10 lines ("Short Section"), and slide
 * markers spanning multiple sections.
 */
const SAMPLE_MD = `<!-- slide 1 -->

# Unit 1

## Warm Up
First warm up section, slide one.
Some more content here.

## Vocabulary
- mot 1
- mot 2
- mot 3

<!-- slide 2 -->

## Grammar
### Subjonctif
Nested content about the subjunctive.
More nested content under the subsection.

## Warm Up
Second warm up section, slide two, same heading text as the first.

<!-- slide 3 -->

## Short Section
one line only
`;

describe('normalizeHeadingText', () => {
  it('collapses whitespace and case', () => {
    expect(normalizeHeadingText('  Warm   Up  ')).toBe('warm up');
    expect(normalizeHeadingText('WARM UP')).toBe('warm up');
  });

  it('treats distinct headings as distinct after normalization', () => {
    expect(normalizeHeadingText('Warm Up')).not.toBe(normalizeHeadingText('Warm-Up'));
  });
});

describe('extractDocumentHeadings', () => {
  it('extracts every heading occurrence, including duplicates, in document order, with # stripped', () => {
    const headings = extractDocumentHeadings(SAMPLE_MD);
    expect(headings.map(h => h.heading)).toEqual([
      'Unit 1',
      'Warm Up',
      'Vocabulary',
      'Grammar',
      'Subjonctif',
      'Warm Up',
      'Short Section',
    ]);
  });

  it('records the slide in effect at each heading, distinguishing duplicate occurrences', () => {
    const headings = extractDocumentHeadings(SAMPLE_MD);
    const warmUps = headings.filter(h => h.heading === 'Warm Up');
    expect(warmUps.map(h => h.slide)).toEqual([1, 2]);
  });

  it('records a null slide for a heading before any slide marker in the document', () => {
    const noLeadingMarker = `# Front Matter Heading\nSome content before any slide marker.\n\n<!-- slide 1 -->\n\n## First Real Slide\nContent here.\n`;
    const headings = extractDocumentHeadings(noLeadingMarker);
    expect(headings[0]).toEqual({ heading: 'Front Matter Heading', level: 1, lineIndex: 0, slide: null });
    expect(headings[1].slide).toBe(1);
  });
});

describe('isHeadingTextUnique / simplifyHeadingRef / headingRefKey / formatHeadingRef', () => {
  const documentHeadings = extractDocumentHeadings(SAMPLE_MD);

  it('treats a heading with one occurrence as unique', () => {
    expect(isHeadingTextUnique('Vocabulary', documentHeadings)).toBe(true);
  });

  it('treats a heading with more than one occurrence as not unique', () => {
    expect(isHeadingTextUnique('Warm Up', documentHeadings)).toBe(false);
  });

  it('simplifies a slide-qualified ref to a bare string when its text is unique', () => {
    expect(simplifyHeadingRef({ heading: 'Vocabulary', slide: 1 }, documentHeadings)).toBe('Vocabulary');
  });

  it('keeps the slide on a ref whose text is not unique', () => {
    expect(simplifyHeadingRef({ heading: 'Warm Up', slide: 2 }, documentHeadings)).toEqual({ heading: 'Warm Up', slide: 2 });
  });

  it('gives distinct keys to different slides of the same heading text', () => {
    const a = headingRefKey({ heading: 'Warm Up', slide: 1 });
    const b = headingRefKey({ heading: 'Warm Up', slide: 2 });
    expect(a).not.toBe(b);
  });

  it('formats a bare string as-is and a slide-qualified ref with its slide', () => {
    expect(formatHeadingRef('Vocabulary')).toBe('Vocabulary');
    expect(formatHeadingRef({ heading: 'Warm Up', slide: 2 })).toBe('Warm Up (slide 2)');
  });
});

describe('summarizeExactSections', () => {
  it('finds both occurrences of a duplicated heading, on different slides', () => {
    const summary = summarizeExactSections(SAMPLE_MD, ['Warm Up']);
    expect(summary.sectionCount).toBe(2);
    expect(summary.firstSlide).toBe(1);
    expect(summary.lastSlide).toBe(2);
  });

  it('includes a section under 10 lines', () => {
    const summary = summarizeExactSections(SAMPLE_MD, ['Short Section']);
    expect(summary.sectionCount).toBe(1);
    expect(summary.totalChars).toBeGreaterThan(0);
    expect(summary.firstSlide).toBe(3);
    expect(summary.lastSlide).toBe(3);
  });

  it('reports zero sections and null slides for a heading not in the document', () => {
    const summary = summarizeExactSections(SAMPLE_MD, ['Nonexistent Heading']);
    expect(summary.sectionCount).toBe(0);
    expect(summary.totalChars).toBe(0);
    expect(summary.firstSlide).toBeNull();
    expect(summary.lastSlide).toBeNull();
  });

  it('returns an empty summary for a topic with no headings', () => {
    const summary = summarizeExactSections(SAMPLE_MD, []);
    expect(summary.sectionCount).toBe(0);
  });
});

describe('extractTopicContent — exact heading match', () => {
  it('collects every section for a duplicated heading, joined together', () => {
    const units = [{ topics: [{ name: 'Warm Up Topic', headings: ['Warm Up'] }] }];
    const content = extractTopicContent(SAMPLE_MD, 'Warm Up Topic', units);
    expect(content).toContain('First warm up section, slide one.');
    expect(content).toContain('Second warm up section, slide two');
  });

  it('keeps a nested subsection inside its parent section instead of breaking at it', () => {
    const units = [{ topics: [{ name: 'Grammar Topic', headings: ['Grammar'] }] }];
    const content = extractTopicContent(SAMPLE_MD, 'Grammar Topic', units);
    expect(content).toContain('### Subjonctif');
    expect(content).toContain('Nested content about the subjunctive.');
    // Must stop before the second "Warm Up", which is the next same-level (##) heading.
    expect(content).not.toContain('Second warm up section');
  });

  it('returns a short (<10-line) section rather than discarding it', () => {
    const units = [{ topics: [{ name: 'Short Topic', headings: ['Short Section'] }] }];
    const content = extractTopicContent(SAMPLE_MD, 'Short Topic', units);
    expect(content).toContain('one line only');
  });

  it('returns empty and does not fall back to name matching when stored headings resolve to nothing', () => {
    // "Vocabulary" would match by name-substring if the fallback ran, but a topic WITH stored
    // headings should never reach that fallback — a stale/wrong heading should surface as empty,
    // not silently substitute a differently-sourced match.
    const units = [{ topics: [{ name: 'Vocabulary', headings: ['Nonexistent Heading'] }] }];
    const content = extractTopicContent(SAMPLE_MD, 'Vocabulary', units);
    expect(content).toBe('');
  });

  it('narrows to a single occurrence of a duplicated heading when given a { heading, slide } ref', () => {
    const units = [{ topics: [{ name: 'Second Warm Up Only', headings: [{ heading: 'Warm Up', slide: 2 }] }] }];
    const content = extractTopicContent(SAMPLE_MD, 'Second Warm Up Only', units);
    expect(content).toContain('Second warm up section, slide two');
    expect(content).not.toContain('First warm up section, slide one.');
  });

  it('does not duplicate a nested subsection\'s content when a stored heading list names both it and its parent', () => {
    // Guards against stale stored data that predates collapseNestedHeadings — the nested content
    // must appear only once, not once for "Grammar" and again for "Subjonctif".
    const units = [{ topics: [{ name: 'Grammar Topic', headings: ['Grammar', 'Subjonctif'] }] }];
    const content = extractTopicContent(SAMPLE_MD, 'Grammar Topic', units);
    const occurrences = content.split('Nested content about the subjunctive.').length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('extractTopicContent — name-substring fallback (no stored headings)', () => {
  it('matches by topic name when no headings are stored', () => {
    const units = [{ topics: [{ name: 'Vocabulary', headings: [] }] }];
    const content = extractTopicContent(SAMPLE_MD, 'Vocabulary', units);
    expect(content).toContain('mot 1');
  });

  it('returns empty when neither headings nor a name match are found', () => {
    const units = [{ topics: [{ name: 'Nothing Like This', headings: [] }] }];
    const content = extractTopicContent(SAMPLE_MD, 'Nothing Like This', units);
    expect(content).toBe('');
  });
});

const FENCED_MD = `## Real Section
Content before the fence.

\`\`\`
# Not A Heading
## Also Not A Heading
\`\`\`

More content after the fence, still part of Real Section.

## Next Section
Content in the next section.
`;

describe('heading scan — fenced code blocks', () => {
  it('does not treat a #-prefixed line inside a fenced code block as a heading', () => {
    expect(extractDocumentHeadings(FENCED_MD).map(h => h.heading)).toEqual(['Real Section', 'Next Section']);
  });

  it('does not end a section early at a fenced #-prefixed line', () => {
    const units = [{ topics: [{ name: 'Real Topic', headings: ['Real Section'] }] }];
    const content = extractTopicContent(FENCED_MD, 'Real Topic', units);
    expect(content).toContain('Not A Heading');
    expect(content).toContain('More content after the fence');
    expect(content).not.toContain('Content in the next section');
  });
});

describe('collapseNestedHeadings', () => {
  const documentHeadings = extractDocumentHeadings(SAMPLE_MD);

  it('drops a child heading already covered by its parent', () => {
    const result = collapseNestedHeadings(['Grammar', 'Subjonctif'], documentHeadings);
    expect(result.headings).toEqual(['Grammar']);
    expect(result.collapsedCount).toBe(1);
  });

  it('drops the child regardless of list order', () => {
    const result = collapseNestedHeadings(['Subjonctif', 'Grammar'], documentHeadings);
    expect(result.headings).toEqual(['Grammar']);
    expect(result.collapsedCount).toBe(1);
  });

  it('keeps sibling headings at the same level', () => {
    const result = collapseNestedHeadings(['Vocabulary', 'Grammar'], documentHeadings);
    expect(result.headings).toEqual(['Vocabulary', 'Grammar']);
    expect(result.collapsedCount).toBe(0);
  });

  it('collapses an exact duplicate down to one entry', () => {
    const result = collapseNestedHeadings(['Grammar', 'Grammar'], documentHeadings);
    expect(result.headings).toEqual(['Grammar']);
    expect(result.collapsedCount).toBe(1);
  });

  it('does not collapse a same-text child that belongs to a different parent occurrence', () => {
    const parentChildDupMd = `<!-- slide 1 -->

## Parent A
Intro A.

### Exercices
Child of A.

<!-- slide 2 -->

## Parent B
Intro B.

### Exercices
Child of B.
`;
    const docHeadings = extractDocumentHeadings(parentChildDupMd);
    // "Exercices" on slide 2 belongs to Parent B's section, not Parent A's — listing it alongside
    // "Parent A" must not collapse it away.
    const result = collapseNestedHeadings(['Parent A', { heading: 'Exercices', slide: 2 }], docHeadings);
    expect(result.headings).toEqual(['Parent A', { heading: 'Exercices', slide: 2 }]);
    expect(result.collapsedCount).toBe(0);
  });

  it('returns the list unchanged when there is nothing to collapse', () => {
    const result = collapseNestedHeadings(['Vocabulary'], documentHeadings);
    expect(result.headings).toEqual(['Vocabulary']);
    expect(result.collapsedCount).toBe(0);
  });

  it('dedupes two ref shapes that resolve to the same occurrence, not just equal ref keys', () => {
    // "Vocabulary" is unique in SAMPLE_MD, so the bare string and the slide-qualified ref both
    // resolve to the exact same section — a duplicate by occurrence even though their
    // headingRefKeys differ.
    const result = collapseNestedHeadings(['Vocabulary', { heading: 'Vocabulary', slide: 1 }], documentHeadings);
    expect(result.headings).toEqual(['Vocabulary']);
    expect(result.collapsedCount).toBe(1);
  });
});

describe('findUnitHeadingMismatches / formatHeadingPreflightError', () => {
  it('flags legacy word-token headings as not-found against the real document', () => {
    // The real heading is "Warm Up"; single-word tokens split from it are not headings at all.
    const topics = [{ name: 'Warm Up Topic', headings: ['warm', 'up'] }];
    const mismatches = findUnitHeadingMismatches(SAMPLE_MD, topics);
    expect(mismatches).toEqual([
      { topic: 'Warm Up Topic', heading: 'warm', reason: 'not-found' },
      { topic: 'Warm Up Topic', heading: 'up', reason: 'not-found' },
    ]);
  });

  it('skips a topic with no stored headings entirely', () => {
    const topics = [{ name: 'No Headings Topic', headings: [] }];
    expect(findUnitHeadingMismatches(SAMPLE_MD, topics)).toEqual([]);
  });

  it('reports no mismatches when headings are the real, exact document text', () => {
    const topics = [{ name: 'Grammar Topic', headings: ['Grammar'] }];
    expect(findUnitHeadingMismatches(SAMPLE_MD, topics)).toEqual([]);
  });

  it('formats a preflight error naming the unit, every mismatch, and the repair command', () => {
    const text = formatHeadingPreflightError('unit-1', [
      { topic: 'Warm Up Topic', heading: 'warm', reason: 'not-found' },
    ]);
    expect(text).toContain('unit-1');
    expect(text).toContain('Warm Up Topic');
    expect(text).toContain('"warm"');
    expect(text).toContain('--map-existing');
    expect(text).toContain('--from-proposal');
  });
});
