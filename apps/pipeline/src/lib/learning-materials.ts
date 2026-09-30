import fs from 'fs';
import { createLogger } from './logger';
import { findMarkdownForUnit, resolveUnitMarkdownPath } from './unit-discovery';
import type { TopicHeadingRef } from '@adaptive/shared/types';

const logger = createLogger('learning-materials');

export type HeadingRef = TopicHeadingRef;

/** Minimal shape needed from units — avoids coupling to full Unit type. */
interface UnitWithTopics {
  topics: Array<{ name: string; headings: HeadingRef[] }>;
}

/** Minimal shape needed to resolve a unit's source file. */
interface UnitWithId {
  id: string;
  source_file_stem?: string | null;
}

/** The minimal unit shape every materials-loading function in this file needs — callers pass a
 * full `Unit` (from `@adaptive/shared/types`) or a purpose-built literal; both satisfy this
 * structurally, so nothing outside this file needs to import the full `Unit` type just to call
 * `buildAuditMaterialsBlock` or `extractTopicContent`. */
export interface MaterialsUnit extends UnitWithId, UnitWithTopics {}

const HEADING_LINE_RE = /^(#{1,6})\s+(.+)$/;
const SLIDE_MARKER_RE = /^<!-- slide (\d+) -->$/;
const NUMBERED_MARKER_RE = /^<!--\s*([A-Za-z]+)\s+(\d+)\s*-->$/;
const FENCE_RE = /^```/;

/**
 * Validates every numbered marker comment (`<!-- <word> <number> -->`) in `markdown`: the word
 * must be "slide", and the slide numbers must start at 1 and strictly increase with no repeats.
 * Called wherever unit markdown is read from disk, before anything scans it for slide markers —
 * a marker this function rejects is invisible to `slideMarkerAtOrBefore` (it only recognizes
 * `<!-- slide N -->`), so a heading after it would otherwise silently inherit the wrong slide
 * number instead of raising an error.
 */
export function assertValidSlideMarkers(markdown: string, filePath: string): void {
  const lines = markdown.split('\n');
  let previousSlide = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].trim().match(NUMBERED_MARKER_RE);
    if (!match) continue;
    const [, word, numText] = match;
    if (word !== 'slide') {
      throw new Error(
        `${filePath}, line ${i + 1}: unrecognized marker "${lines[i].trim()}" — only "<!-- slide N -->" markers are accepted.`
      );
    }
    const num = Number(numText);
    if (previousSlide === 0 && num !== 1) {
      throw new Error(
        `${filePath}, line ${i + 1}: slide markers must start at "<!-- slide 1 -->" (found "<!-- slide ${num} -->" first).`
      );
    }
    if (previousSlide !== 0 && num <= previousSlide) {
      throw new Error(
        `${filePath}, line ${i + 1}: slide marker "<!-- slide ${num} -->" is out of order — slide numbers must start at 1 and increase strictly with no repeats (previous marker was ${previousSlide}).`
      );
    }
    previousSlide = num;
  }
}

/** Collapses whitespace and case so heading comparisons ignore incidental formatting
 * differences (extra spaces, capitalization) without treating distinct headings as equal. */
export function normalizeHeadingText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function headingRefText(ref: HeadingRef): string {
  return typeof ref === 'string' ? ref : ref.heading;
}

function headingRefSlide(ref: HeadingRef): number | null {
  return typeof ref === 'string' ? null : ref.slide;
}

/** A stable string key for a `HeadingRef`, for dedup and set membership — object refs don't
 * compare equal by reference even when they mean the same heading occurrence. */
export function headingRefKey(ref: HeadingRef): string {
  const slide = headingRefSlide(ref);
  return slide === null
    ? `text:${normalizeHeadingText(headingRefText(ref))}`
    : `slide:${normalizeHeadingText(headingRefText(ref))}:${slide}`;
}

/** A human-readable rendering of a `HeadingRef` for review tables and error messages. */
export function formatHeadingRef(ref: HeadingRef): string {
  const slide = headingRefSlide(ref);
  return slide === null ? headingRefText(ref) : `${headingRefText(ref)} (slide ${slide})`;
}

/** A `HeadingRef` normalized to the uniform `{ heading, slide }` shape, with `slide: null` for a
 * heading stored as a bare string (only ever done when that text is unique in the document — see
 * `simplifyHeadingRef`). Gives callers one shape to compare headings by, regardless of whether a
 * heading happened to be stored as a string or an object. */
export function toHeadingSlideForm(ref: HeadingRef): { heading: string; slide: number | null } {
  return { heading: headingRefText(ref), slide: headingRefSlide(ref) };
}

interface HeadingLine {
  level: number;
  text: string;
}

/** One entry per line: the parsed heading (level + text) if that line is a real heading, or
 * null otherwise. A `#`-prefixed line inside a fenced code block (between ` ``` ` markers) is
 * not a heading — a verbatim-quoted exercise or code sample shouldn't be read as document
 * structure. */
function scanHeadingLineInfo(lines: string[]): (HeadingLine | null)[] {
  const info: (HeadingLine | null)[] = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE_RE.test(line.trim())) {
      inFence = !inFence;
      info.push(null);
      continue;
    }
    if (inFence) {
      info.push(null);
      continue;
    }
    const match = line.match(HEADING_LINE_RE);
    info.push(match ? { level: match[1].length, text: match[2].trim() } : null);
  }
  return info;
}

export interface DocumentHeadingOccurrence {
  heading: string;
  level: number;
  /** Index (0-based) of the heading line in the document's split lines. */
  lineIndex: number;
  /** The `<!-- slide N -->` marker in effect at this heading, or null before any marker
   * (front matter, or a document with no slide markers at all). */
  slide: number | null;
}

/** The nearest `<!-- slide N -->` marker at or before `lineIdx`, or null if the document has none
 * that early (front matter before the first slide marker). */
function slideMarkerAtOrBefore(lines: string[], lineIdx: number): number | null {
  for (let i = lineIdx; i >= 0; i--) {
    const match = lines[i].match(SLIDE_MARKER_RE);
    if (match) return Number(match[1]);
  }
  return null;
}

function scanHeadingLines(lines: string[]): DocumentHeadingOccurrence[] {
  const headingLines = scanHeadingLineInfo(lines);
  const occurrences: DocumentHeadingOccurrence[] = [];
  for (let i = 0; i < lines.length; i++) {
    const info = headingLines[i];
    if (!info) continue;
    occurrences.push({
      heading: info.text,
      level: info.level,
      lineIndex: i,
      slide: slideMarkerAtOrBefore(lines, i),
    });
  }
  return occurrences;
}

/** Every markdown heading occurrence (any level) in a document, in document order, each with the
 * slide in effect when it appears. Used to validate a topic's stored headings, to build a
 * repair-mode proposal, and to render the "document headings, with slides" index in the
 * extraction/repair prompts. */
export function extractDocumentHeadings(markdown: string): DocumentHeadingOccurrence[] {
  return scanHeadingLines(markdown.split('\n'));
}

/**
 * True when `ref`'s heading text is unique across every occurrence in `documentHeadings` —
 * i.e. it's safe to store as a bare string rather than a `{ heading, slide }` pair.
 */
export function isHeadingTextUnique(text: string, documentHeadings: DocumentHeadingOccurrence[]): boolean {
  const target = normalizeHeadingText(text);
  return documentHeadings.filter(occ => normalizeHeadingText(occ.heading) === target).length === 1;
}

/**
 * Normalizes a validated `HeadingRef` to the minimal form: a bare string when that heading text
 * is unique in the document (a slide number would be redundant), otherwise the `{ heading, slide }`
 * pair unchanged. Applied once, right before a heading list is stored or proposed — callers
 * (extraction, `--map-existing`) don't need to make this call themselves.
 */
export function simplifyHeadingRef(ref: HeadingRef, documentHeadings: DocumentHeadingOccurrence[]): HeadingRef {
  const text = headingRefText(ref);
  return isHeadingTextUnique(text, documentHeadings) ? text : ref;
}

function matchesHeadingRef(occurrence: DocumentHeadingOccurrence, ref: HeadingRef): boolean {
  if (normalizeHeadingText(occurrence.heading) !== normalizeHeadingText(headingRefText(ref))) return false;
  const slide = headingRefSlide(ref);
  return slide === null || occurrence.slide === slide;
}

/** The document-heading index (into `documentHeadings`) of every occurrence `ref` resolves to. */
function occurrenceIndicesForRef(ref: HeadingRef, documentHeadings: DocumentHeadingOccurrence[]): number[] {
  const indices: number[] = [];
  documentHeadings.forEach((occ, i) => {
    if (matchesHeadingRef(occ, ref)) indices.push(i);
  });
  return indices;
}

/** For each occurrence in `documentHeadings` (by index), the line index where its section ends —
 * the next occurrence at the same or shallower level, or `Infinity` for the last section of its
 * level in the document. Mirrors the end computed by `collectSectionsByHeadings`. */
function sectionEndsByOccurrence(documentHeadings: DocumentHeadingOccurrence[]): number[] {
  return documentHeadings.map((occ, i) => {
    for (let j = i + 1; j < documentHeadings.length; j++) {
      if (documentHeadings[j].level <= occ.level) return documentHeadings[j].lineIndex;
    }
    return Infinity;
  });
}

export interface CollapseNestedHeadingsResult {
  headings: HeadingRef[];
  collapsedCount: number;
}

/**
 * Removes headings from `headingRefs` that are already covered by another heading in the same
 * list: an exact duplicate, or a heading whose resolved section entirely contains another
 * heading's resolved occurrence (a `##` parent listed alongside one of its `###` children). Order
 * of the surviving entries is preserved. Coverage is decided against the real document structure in
 * `documentHeadings`, not just the entries in `headingRefs` — two heading occurrences with the same
 * text but different parents (disambiguated by slide) are never collapsed into each other.
 *
 * "Exact duplicate" is decided by resolved document occurrence, not by ref shape — a bare string
 * and an equivalent `{ heading, slide }` pointing at the same unique heading are recognized as the
 * same entry even though their `headingRefKey`s differ.
 */
export function collapseNestedHeadings(
  headingRefs: HeadingRef[],
  documentHeadings: DocumentHeadingOccurrence[]
): CollapseNestedHeadingsResult {
  if (headingRefs.length <= 1) return { headings: headingRefs.slice(), collapsedCount: 0 };

  const ends = sectionEndsByOccurrence(documentHeadings);
  const entries = headingRefs.map(ref => ({
    ref,
    occurrenceIndices: occurrenceIndicesForRef(ref, documentHeadings),
  }));

  const dropped = new Set<number>();
  const seenOccurrenceSets = new Set<string>();

  // Exact duplicates first, keeping the earliest occurrence. A ref with no resolved occurrence is
  // never registered here — it must never collide with another equally-unresolved ref.
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].occurrenceIndices.length === 0) continue;
    const occurrenceSetKey = entries[i].occurrenceIndices.slice().sort((a, b) => a - b).join(',');
    if (seenOccurrenceSets.has(occurrenceSetKey)) {
      dropped.add(i);
      continue;
    }
    seenOccurrenceSets.add(occurrenceSetKey);
  }

  // A heading with no resolved occurrence (shouldn't happen for validated data) is never treated
  // as covered — only real containment collapses an entry.
  for (let i = 0; i < entries.length; i++) {
    if (dropped.has(i)) continue;
    for (let j = 0; j < entries.length; j++) {
      if (i === j || dropped.has(j) || entries[j].occurrenceIndices.length === 0) continue;
      const coveredByI = entries[j].occurrenceIndices.every(jIdx =>
        entries[i].occurrenceIndices.some(
          iIdx => documentHeadings[jIdx].lineIndex > documentHeadings[iIdx].lineIndex &&
                  documentHeadings[jIdx].lineIndex < ends[iIdx]
        )
      );
      if (coveredByI) dropped.add(j);
    }
  }

  const headings = entries.filter((_, i) => !dropped.has(i)).map(e => e.ref);
  return { headings, collapsedCount: headingRefs.length - headings.length };
}

export interface HeadingSpan {
  /** Line index (0-based, inclusive) of the resolved occurrence's heading line. */
  start: number;
  /** Line index (0-based, exclusive) where its section ends, or `Infinity` for the last section
   * of its level in the document. */
  end: number;
}

/**
 * The document line span of every occurrence `headingRefs` resolves to — one entry per resolved
 * occurrence, not deduplicated or collapsed. The raw material for comparing two *different*
 * topics' content for containment or overlap (`collapseNestedHeadings` only ever compares entries
 * within a single list).
 */
export function resolveHeadingSpans(
  headingRefs: HeadingRef[],
  documentHeadings: DocumentHeadingOccurrence[]
): HeadingSpan[] {
  const ends = sectionEndsByOccurrence(documentHeadings);
  const spans: HeadingSpan[] = [];
  for (const ref of headingRefs) {
    for (const idx of occurrenceIndicesForRef(ref, documentHeadings)) {
      spans.push({ start: documentHeadings[idx].lineIndex, end: ends[idx] });
    }
  }
  return spans;
}

export interface HeadingMismatch {
  topic: string;
  heading: HeadingRef;
  reason: 'not-found' | 'ambiguous';
}

/**
 * Every `(topic, heading)` pair that doesn't resolve to exactly one section in the document:
 * - `not-found`: the heading text doesn't exist at all, or (for a `{ heading, slide }` ref) exists
 *   but not on that slide — a paraphrased, combined, or invented heading, or a wrong slide.
 * - `ambiguous`: a bare-string heading whose text isn't unique in the document — heading text
 *   like "Exercices" or "Warm Up" repeats across sections, so a bare string can't say which
 *   occurrence is meant. It needs a `{ heading, slide }` pair instead.
 */
export function findHeadingMismatches(
  topics: { name: string; headings: HeadingRef[] }[],
  documentHeadings: DocumentHeadingOccurrence[]
): HeadingMismatch[] {
  const mismatches: HeadingMismatch[] = [];

  for (const topic of topics) {
    for (const ref of topic.headings) {
      const text = normalizeHeadingText(headingRefText(ref));
      const slide = headingRefSlide(ref);
      const occurrencesForText = documentHeadings.filter(occ => normalizeHeadingText(occ.heading) === text);

      if (occurrencesForText.length === 0) {
        mismatches.push({ topic: topic.name, heading: ref, reason: 'not-found' });
        continue;
      }

      if (slide === null) {
        if (occurrencesForText.length > 1) {
          mismatches.push({ topic: topic.name, heading: ref, reason: 'ambiguous' });
        }
        continue;
      }

      if (!occurrencesForText.some(occ => occ.slide === slide)) {
        mismatches.push({ topic: topic.name, heading: ref, reason: 'not-found' });
      }
    }
  }

  return mismatches;
}

export function formatHeadingMismatches(mismatches: HeadingMismatch[]): string {
  return mismatches.map(m => {
    const note = m.reason === 'ambiguous'
      ? ' (appears more than once in the document — needs a slide)'
      : '';
    return `  "${m.topic}" → "${formatHeadingRef(m.heading)}"${note}`;
  }).join('\n');
}

/**
 * Every mismatch among a unit's topics that have stored headings, against `materials`. Topics
 * with no stored headings are skipped — they use the name-substring fallback in
 * `extractTopicContent`, which doesn't require heading validation. Used as a preflight: a
 * command that's about to extract topic content should call this and fail loudly on any
 * mismatch, rather than let `extractTopicContent` silently return empty content per topic.
 */
export function findUnitHeadingMismatches(
  materials: string,
  topics: { name: string; headings: HeadingRef[] }[]
): HeadingMismatch[] {
  const withHeadings = topics.filter(t => t.headings.length > 0);
  return findHeadingMismatches(withHeadings, extractDocumentHeadings(materials));
}

/**
 * The error text for a failed heading preflight: names the unit, lists every mismatch, and
 * points at the repair tool.
 */
export function formatHeadingPreflightError(unitId: string, mismatches: HeadingMismatch[]): string {
  return [
    `${mismatches.length} stored heading(s) for unit "${unitId}" do not validate against its current markdown:`,
    formatHeadingMismatches(mismatches),
    '',
    `Repair with: npx tsx apps/pipeline/src/commands/content-suggest-topics.ts <markdown-file> ${unitId} --map-existing --write-db`,
    `(review the proposal first, or hand-edit it and apply with --from-proposal <path> --write-db)`,
  ].join('\n');
}

export interface UnresolvedTopicRef {
  unitId: string;
  topic: string;
}

/**
 * The error text for a failed material-resolution preflight: lists every `(topic, unit)` pair that
 * resolved to no content at all — a stale/unknown unit, a topic absent from that unit's curriculum,
 * or (the case `findUnitHeadingMismatches` above can't see, since it only inspects topics that
 * already have stored headings) a headingless topic whose name-substring fallback in
 * `extractTopicContent` also failed to match anything.
 */
export function formatMaterialPreflightError(unresolved: UnresolvedTopicRef[]): string {
  const list = unresolved.map((u) => `  "${u.topic}" (unit "${u.unitId}")`).join('\n');
  return [
    `${unresolved.length} topic(s) resolve to no reference material at all — no stored headings ` +
      'match the current markdown, and no heading text matches the topic name:',
    list,
    '',
    'Repair by adding headings for these topics with: npx tsx ' +
      'apps/pipeline/src/commands/content-suggest-topics.ts <markdown-file> <unit-id> --map-existing --write-db',
    '(review the proposal first, or hand-edit it and apply with --from-proposal <path> --write-db)',
    '',
    'Or pass --allow-missing-material to audit these questions anyway, without reference material.',
  ].join('\n');
}

/**
 * Look up heading patterns for a topic from the provided units data.
 */
function getTopicHeadings(topic: string, units: UnitWithTopics[]): HeadingRef[] {
  for (const unit of units) {
    const found = unit.topics.find(t => t.name === topic);
    if (found) return found.headings;
  }
  return [];
}

/**
 * Load learning materials for a specific unit: from the file named by its
 * `source_file_stem` when recorded, otherwise from file discovery by unit label
 * (see apps/pipeline/src/lib/unit-discovery.ts).
 */
export function loadUnitMaterials(unitId: string, units: UnitWithId[]): string {
  let filePath: string;
  let content: string;
  try {
    const unit = units.find(u => u.id === unitId);
    const resolved = (unit ? resolveUnitMarkdownPath(unit) : null) ?? findMarkdownForUnit(unitId);
    if (!resolved) {
      throw new Error(`No markdown file found for unit: ${unitId}`);
    }
    filePath = resolved;
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    logger.error(`Error loading materials for unit ${unitId}`, { error });
    throw new Error(`Failed to load learning materials for unit: ${unitId}`);
  }
  assertValidSlideMarkers(content, filePath);
  return content;
}

interface HeadingSection {
  heading: string;
  level: number;
  /** Index (0-based, inclusive) of the heading line in the document's split lines. */
  startLine: number;
  /** Index (0-based, exclusive) of the line where this section ends — the next heading at the
   * same or shallower level, or end of document. */
  endLine: number;
  content: string;
}

/**
 * Collects every section in `lines` whose heading matches one of `headingRefs` — text alone for
 * a bare-string ref, text AND slide for a `{ heading, slide }` ref (disambiguating a heading that
 * repeats elsewhere in the document). A section runs from its heading line until the next heading
 * at the same or shallower level, so a nested subsection (a deeper heading) stays part of its
 * parent section. A ref that matches more than one occurrence (only possible for a bare string
 * whose text turns out not to be unique) contributes one section per occurrence.
 */
function collectSectionsByHeadings(lines: string[], headingRefs: HeadingRef[]): HeadingSection[] {
  if (headingRefs.length === 0) return [];
  const documentHeadings = scanHeadingLines(lines);
  const collapsedRefs = collapseNestedHeadings(headingRefs, documentHeadings).headings;
  const headingLines = scanHeadingLineInfo(lines);
  const sections: HeadingSection[] = [];

  for (let i = 0; i < lines.length; i++) {
    const info = headingLines[i];
    if (!info) continue;
    const occurrence: DocumentHeadingOccurrence = { heading: info.text, level: info.level, lineIndex: i, slide: slideMarkerAtOrBefore(lines, i) };
    if (!collapsedRefs.some(ref => matchesHeadingRef(occurrence, ref))) continue;

    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const next = headingLines[j];
      if (next && next.level <= info.level) {
        end = j;
        break;
      }
    }

    sections.push({
      heading: info.text,
      level: info.level,
      startLine: i,
      endLine: end,
      content: lines.slice(i, end).join('\n'),
    });
  }

  return sections;
}

/** The index of the last line in `[startLine, endLine)` that is neither blank nor itself a slide
 * marker — so a trailing marker for the *next* section (which sits in the blank space before its
 * heading, still inside this section's line range) doesn't get attributed here. */
function lastContentLine(lines: string[], startLine: number, endLine: number): number {
  for (let i = endLine - 1; i >= startLine; i--) {
    if (lines[i].trim() !== '' && !SLIDE_MARKER_RE.test(lines[i].trim())) return i;
  }
  return startLine;
}

/** The slide range a line span covers: the marker in effect at the start, and the marker in
 * effect at the span's last actual content line. */
function slidesSpanned(lines: string[], startLine: number, endLine: number): { first: number | null; last: number | null } {
  const first = slideMarkerAtOrBefore(lines, startLine);
  const last = slideMarkerAtOrBefore(lines, lastContentLine(lines, startLine, endLine));
  return { first, last: last ?? first };
}

export interface TopicContentSummary {
  sectionCount: number;
  totalChars: number;
  firstSlide: number | null;
  lastSlide: number | null;
}

/**
 * Summarizes what `headings` resolve to in `materials` — section count, total character count,
 * and the slide range the sections span. Used by the topic review table (content-suggest-topics.ts)
 * and the repair-mode proposal, not by generation, which only needs the joined content text.
 */
export function summarizeExactSections(materials: string, headings: HeadingRef[]): TopicContentSummary {
  const lines = materials.split('\n');
  const sections = collectSectionsByHeadings(lines, headings);

  let totalChars = 0;
  let firstSlide: number | null = null;
  let lastSlide: number | null = null;

  for (const section of sections) {
    totalChars += section.content.length;
    const { first, last } = slidesSpanned(lines, section.startLine, section.endLine);
    if (first !== null && (firstSlide === null || first < firstSlide)) firstSlide = first;
    if (last !== null && (lastSlide === null || last > lastSlide)) lastSlide = last;
  }

  return { sectionCount: sections.length, totalChars, firstSlide, lastSlide };
}

/**
 * Extract relevant content for a specific topic from the unit materials.
 *
 * A topic with stored `headings` (see `units.topics[].headings`) is matched exactly: every
 * section whose heading (and slide, for a disambiguated ref) equals one of those refs, full stop.
 * A topic with no stored headings falls back to matching its name against heading text by
 * substring — the only path available before a unit has been through heading validation. Either
 * way, an unmatched topic returns an empty string rather than a prompt telling the model to
 * invent content from general knowledge; callers skip generation for empty content.
 */
export function extractTopicContent(materials: string, topic: string, units: UnitWithTopics[]): string {
  const lines = materials.split('\n');
  const headings = getTopicHeadings(topic, units);

  if (headings.length > 0) {
    const sections = collectSectionsByHeadings(lines, headings);
    if (sections.length === 0) {
      logger.warn(`No content found for topic "${topic}" — none of its stored headings matched the document`);
      return '';
    }
    logger.debug(`Found topic "${topic}" via exact heading match (${sections.length} section${sections.length > 1 ? 's' : ''})`);
    return sections.map(s => s.content).join('\n\n---\n\n');
  }

  // Fallback for topics without stored headings: match the topic name against heading text.
  const headingLines = scanHeadingLineInfo(lines);
  const relevantLines: string[] = [];
  let isRelevant = false;
  let sectionDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const info = headingLines[i];

    if (info) {
      if (info.text.toLowerCase().includes(topic.toLowerCase()) ||
          topic.toLowerCase().includes(info.text.toLowerCase())) {
        isRelevant = true;
        sectionDepth = info.level;
        relevantLines.push(lines[i]);
      } else if (isRelevant && info.level <= sectionDepth) {
        break;
      } else if (isRelevant) {
        relevantLines.push(lines[i]);
      }
    } else if (isRelevant) {
      relevantLines.push(lines[i]);
    }
  }

  if (relevantLines.length > 0) {
    return relevantLines.join('\n');
  }

  logger.warn(`No content found for topic "${topic}" — no stored headings and no heading matched its name`);
  return '';
}

export interface AuditTopicRef {
  unitId: string;
  topic: string;
}

/** Characters of a topic's extracted content included in an audit prompt's reference-material
 * block before truncation. An audit group can span several distinct topics at once (unlike
 * generation, which prompts one topic at a time), so each topic's excerpt is capped rather than
 * included in full — this keeps a group with multiple large topics from ballooning the prompt. */
export const AUDIT_MATERIAL_CHARS_PER_TOPIC = 6000;

/**
 * Builds the "reference material" block for an audit prompt: one labelled section per distinct
 * `(unitId, topic)` pair in `refs`, in first-occurrence order, each truncated to
 * `maxCharsPerTopic` characters. A topic with no resolvable content (headings that don't match
 * the current markdown, or no headings and no name match) gets a section saying so rather than
 * being silently omitted, so the auditor knows not to assume general knowledge in its place.
 * Returns '' for an empty `refs`, so a caller can skip the block entirely rather than emit an
 * empty header.
 */
export function buildAuditMaterialsBlock(
  refs: AuditTopicRef[],
  units: MaterialsUnit[],
  maxCharsPerTopic: number = AUDIT_MATERIAL_CHARS_PER_TOPIC,
): string {
  const seen = new Set<string>();
  const materialsByUnit = new Map<string, string>();
  const sections: string[] = [];

  for (const ref of refs) {
    const key = `${ref.unitId}::${ref.topic}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // A ref whose unit isn't in `units` at all (never expected in practice — every question's
    // unit_id should resolve against the same units list its topic came from) gets a "no
    // material" section rather than attempting a file read that can only fail. A unit that IS
    // present but genuinely missing its markdown file still throws via `loadUnitMaterials`,
    // matching generation's behavior — that's a real configuration error, not a gap to paper over.
    if (!units.some((u) => u.id === ref.unitId)) {
      sections.push(`--- Topic: ${ref.topic} (${ref.unitId}) ---\n(no source material found for this topic)`);
      continue;
    }

    let materials = materialsByUnit.get(ref.unitId);
    if (materials === undefined) {
      materials = loadUnitMaterials(ref.unitId, units);
      materialsByUnit.set(ref.unitId, materials);
    }

    const content = extractTopicContent(materials, ref.topic, units);
    const body = !content
      ? '(no source material found for this topic)'
      : content.length > maxCharsPerTopic
        ? `${content.slice(0, maxCharsPerTopic)}\n[...truncated]`
        : content;

    sections.push(`--- Topic: ${ref.topic} (${ref.unitId}) ---\n${body}`);
  }

  return sections.join('\n\n');
}
