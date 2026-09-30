/**
 * Suggest topics for a new or existing unit from its markdown.
 *
 * Workflow:
 * 1. Convert PDF to markdown (pipeline-run.ts's PDF conversion step)
 * 2. Run this script to extract and validate topics
 * 3. Review suggestions and update units table in DB
 * 4. Run questions-generate.ts for the unit
 *
 * Run with: npx tsx apps/pipeline/src/commands/content-suggest-topics.ts <markdown-file> <unit-id>
 *           npx tsx apps/pipeline/src/commands/content-suggest-topics.ts <markdown-file> <unit-id> --map-existing [--write-db]
 *           npx tsx apps/pipeline/src/commands/content-suggest-topics.ts --consolidate
 */

import { loadEnv } from '../lib/env';
import { MODELS } from '../lib/pipeline-config';
import { createLogger } from '../lib/logger';
import { runIfMain } from '../lib/run-if-main';
import { emptyUsageTotals, formatUsageSummary, recordCall } from '../lib/usage-tracking';
import { defineCli } from '../lib/options/define-cli';
import { dbTargetFlags } from '../lib/options/groups';

const logger = createLogger('content-suggest-topics');

/** Accumulates usage across this process's calls (topic extraction and --map-existing only — see
 * the module doc comment) for a one-line summary printed at the end of each CLI invocation. */
const runUsage = emptyUsageTotals();

export const cli = defineCli(
  {
    'markdown-file': { type: 'string', positional: 1, help: 'Path to the unit markdown file' },
    'unit-id': { type: 'string', positional: 2, help: 'Unit id (e.g. unit-4)' },
    consolidate: {
      type: 'boolean',
      default: false,
      help: 'Run cross-unit topic consolidation across every unit (no positionals)',
    },
    'map-existing': {
      type: 'boolean',
      default: false,
      help: "Repair headings for <unit-id>'s existing topic names, without re-extracting topic names",
    },
    'from-proposal': {
      type: 'string',
      help: 'With --map-existing, apply a hand-edited proposal JSON instead of calling the model (implies --map-existing)',
    },
    ...dbTargetFlags,
    'write-db': {
      type: 'boolean',
      default: false,
      help: 'With --map-existing, write the repaired headings to the units table (preview-only otherwise)',
      group: 'Database target',
    },
  },
  {
    name: 'content-suggest-topics',
    description: 'Suggest topics for a new or existing unit from its markdown.',
    examples: [
      'npx tsx apps/pipeline/src/commands/content-suggest-topics.ts content/markdown/Unit\\ 4.md unit-4',
      'npx tsx apps/pipeline/src/commands/content-suggest-topics.ts content/markdown/Unit\\ 1.md unit-1 --map-existing',
      'npx tsx apps/pipeline/src/commands/content-suggest-topics.ts content/markdown/Unit\\ 1.md unit-1 --map-existing --from-proposal content/exports/heading-repair-unit-1.json --write-db',
      'npx tsx apps/pipeline/src/commands/content-suggest-topics.ts --consolidate',
    ],
    validate: (o) => {
      if (o.consolidate && (o.markdownFile || o.unitId)) {
        return '--consolidate takes no positional arguments (it runs across every unit)';
      }
      if (!o.consolidate && (!o.markdownFile || !o.unitId)) {
        return 'Usage: <markdown-file> <unit-id> are both required unless --consolidate is set';
      }
    },
  },
);

import fs from 'fs';
import path from 'path';
import { createScriptSupabase } from '../lib/db-queries';
import { fetchUnitsFromDb } from '../lib/units-db';
import {
  getAllTopics,
  findPotentialDuplicates,
  checkTopicSimilarity,
  TopicSimilarity,
  formatHeadingIndex,
  buildMapExistingPrompt,
  parseMapExistingResponse,
  MapExistingParseError,
} from '../lib/topics';
import { getUnitLabel } from '../lib/unit-discovery';
import {
  extractDocumentHeadings,
  summarizeExactSections,
  headingRefText,
  headingRefKey,
  formatHeadingRef,
  simplifyHeadingRef,
  collapseNestedHeadings,
  resolveHeadingSpans,
  findHeadingMismatches,
  formatHeadingMismatches,
  assertValidSlideMarkers,
  type HeadingRef,
  type HeadingMismatch,
  type HeadingSpan,
  type DocumentHeadingOccurrence,
} from '../lib/learning-materials';
import { EXPORTS_DIR, PROMPTS_DIR } from '../lib/paths';
import type { Unit } from '@adaptive/shared/types';
import { callLlm } from '@adaptive/shared/llm';
import { renderCoursePrompt } from '@adaptive/shared/course';

const TOPIC_PROMPT_TEMPLATE = fs.readFileSync(
  path.join(PROMPTS_DIR, 'content-suggest-topics.md'),
  'utf-8'
).trim();

/**
 * Largest unit markdown sent whole to the model. Units run well below this; a larger file fails
 * loudly instead of having its later sections silently dropped from topic extraction.
 */
const MAX_TOPIC_SOURCE_CHARS = 200_000;

export function renderTopicPrompt(existingList: string[], markdown: string): string {
  if (markdown.length > MAX_TOPIC_SOURCE_CHARS) {
    throw new Error(
      `Unit markdown is ${markdown.length} characters, over the ${MAX_TOPIC_SOURCE_CHARS}-character limit for topic extraction. Split the unit into smaller files.`,
    );
  }
  const content = `${markdown}\n`;
  return renderCoursePrompt(TOPIC_PROMPT_TEMPLATE)
    .replaceAll('{{EXISTING_TOPICS}}', existingList.map((t) => `- ${t}`).join('\n'))
    .replaceAll('{{HEADING_INDEX}}', formatHeadingIndex(extractDocumentHeadings(markdown)))
    .replaceAll('{{CONTENT}}', content);
}

interface ExtractedTopic {
  name: string;
  category: 'vocabulary' | 'grammar' | 'culture' | 'communication';
  contentSummary: string;
  headings: HeadingRef[];
}

interface ExtractionResult {
  topics: ExtractedTopic[];
  suggestedLabel: string;
}

/**
 * One corrective round-trip for topics whose assigned headings didn't validate: hands the model
 * the exact mismatches plus the document's real heading-and-slide index and asks it to pick
 * correct ones. Returns only entries for topics it was able to correct — a topic the model still
 * can't place is simply absent from the result, leaving `findHeadingMismatches` to catch it on
 * re-validation.
 */
async function retryHeadingMismatches(
  mismatches: HeadingMismatch[],
  documentHeadings: DocumentHeadingOccurrence[],
  sessionId: string
): Promise<Record<string, HeadingRef[]>> {
  const prompt = `The following topic → heading assignments do not resolve to exactly one section in the source document. Fix them.

Mismatched assignments:
${mismatches.map(m => {
    if (m.reason === 'ambiguous') {
      return `- "${m.topic}" was assigned "${headingRefText(m.heading)}", which appears more than once in the document — say which slide it means`;
    }
    return `- "${m.topic}" was assigned "${formatHeadingRef(m.heading)}", which does not match any heading (or that heading's slide) in the document`;
  }).join('\n')}

Every heading actually in the document, verbatim, with its slide, in order:
${formatHeadingIndex(documentHeadings)}

For each mismatched topic above, return the correct heading(s), each as { "heading": "<verbatim text>", "slide": <slide number> } copied from the list above. If none of the document's headings actually cover that topic, return an empty array for it.

Return ONLY valid JSON:
{
  "corrections": {
    "<topic name>": [{ "heading": "<heading>", "slide": <slide> }, ...]
  }
}`;

  const result = await callLlm({
    model: MODELS.topicExtraction,
    maxTokens: 4000,
    disableReasoning: true,
    messages: [{ role: 'user', content: prompt }],
    sessionId,
  });
  recordCall(runUsage, result.usage);

  const jsonMatch = result.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    logger.warn('Heading mismatch retry returned no parseable JSON', { response: result.text });
    return {};
  }

  const parsed = JSON.parse(jsonMatch[0]);
  return parsed.corrections || {};
}

/**
 * Extract topic candidates and suggest a unit label from markdown
 */
async function extractTopicCandidates(
  markdown: string,
  _unitId: string,
  units: Unit[],
  sessionId: string
): Promise<ExtractionResult> {

  // Get all existing topics for context
  const allTopics = getAllTopics(units);
  const existingList = Array.from(allTopics.keys());

  const prompt = renderTopicPrompt(existingList, markdown);

  const result = await callLlm({
    model: MODELS.topicExtraction,
    maxTokens: 12000,
    disableReasoning: true,
    messages: [{ role: 'user', content: prompt }],
    sessionId,
  });
  recordCall(runUsage, result.usage);

  const responseText = result.text;

  // Extract JSON object
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    logger.error('No valid JSON object found in response', { response: responseText });
    throw new Error('No valid JSON object found in response');
  }

  const parsed = JSON.parse(jsonMatch[0]);
  const topics: ExtractedTopic[] = parsed.topics || [];

  // Validate every extracted heading against the document's real headings, with one corrective
  // retry before failing loudly.
  const documentHeadings = extractDocumentHeadings(markdown);
  let mismatches = findHeadingMismatches(topics, documentHeadings);

  if (mismatches.length > 0) {
    logger.warn(`${mismatches.length} extracted heading(s) do not match the document — retrying once`, { mismatches });
    const corrections = await retryHeadingMismatches(mismatches, documentHeadings, `${sessionId}:heading-retry`);
    for (const topic of topics) {
      if (corrections[topic.name]) topic.headings = corrections[topic.name];
    }
    mismatches = findHeadingMismatches(topics, documentHeadings);
  }

  if (mismatches.length > 0) {
    throw new Error(
      `${mismatches.length} topic heading(s) still do not match any heading in the document after one retry:\n${formatHeadingMismatches(mismatches)}`
    );
  }

  // Every heading is now validated — drop the slide from any that don't need it (their text is
  // unique in the document) so the stored form stays minimal and readable, and collapse any
  // parent-plus-child pair the model assigned to the same topic.
  for (const topic of topics) {
    topic.headings = topic.headings.map(ref => simplifyHeadingRef(ref, documentHeadings));
    topic.headings = collapseNestedHeadings(topic.headings, documentHeadings).headings;
  }

  return {
    topics,
    suggestedLabel: parsed.suggestedLabel || 'TODO: Add label',
  };
}

/**
 * Reconcile extracted topics with existing topics
 */
async function reconcileTopics(
  extracted: ExtractedTopic[],
  unitId: string,
  units: Unit[],
  sessionId: string
): Promise<{
  useExisting: { extracted: string; existing: string }[];
  addNew: string[];
  needsReview: { extracted: string; candidates: string[]; reason: string }[];
}> {
  const allTopics = getAllTopics(units);
  const existingList = Array.from(allTopics.keys());

  const useExisting: { extracted: string; existing: string }[] = [];
  const addNew: string[] = [];
  const needsReview: { extracted: string; candidates: string[]; reason: string }[] = [];

  for (const topic of extracted) {
    // Check for exact match first
    if (existingList.includes(topic.name)) {
      useExisting.push({ extracted: topic.name, existing: topic.name });
      continue;
    }

    // Check for potential duplicates
    const candidates = findPotentialDuplicates(topic.name, existingList);

    if (candidates.length === 0) {
      // No similar topics, this is new
      addNew.push(topic.name);
    } else if (candidates.length === 1) {
      // One candidate - check semantic similarity
      const similarity = await checkTopicSimilarity(topic.name, candidates[0], sessionId);

      if (similarity.similarity === 'identical') {
        useExisting.push({ extracted: topic.name, existing: candidates[0] });
      } else if (similarity.similarity === 'overlapping') {
        needsReview.push({
          extracted: topic.name,
          candidates,
          reason: `Overlaps with "${candidates[0]}": ${similarity.explanation}`,
        });
      } else {
        // Related or distinct - treat as new
        addNew.push(topic.name);
      }
    } else {
      // Multiple candidates - needs human review
      needsReview.push({
        extracted: topic.name,
        candidates,
        reason: 'Multiple potential matches found',
      });
    }
  }

  return { useExisting, addNew, needsReview };
}

/**
 * Generate the suggested topics array for the units table
 */
function generateTopicsArray(
  useExisting: { extracted: string; existing: string }[],
  addNew: string[]
): string[] {
  const topics = new Set<string>();

  // Add existing topics that were matched
  for (const match of useExisting) {
    topics.add(match.existing);
  }

  // Add new topics
  for (const topic of addNew) {
    topics.add(topic);
  }

  return Array.from(topics).sort();
}

/**
 * Groups each extracted topic's validated headings under its final (post-reconciliation) topic
 * name. Pure function — the headings themselves are already exact document heading strings by
 * the time they reach here (validated in `extractTopicCandidates`), so this only handles
 * dedup and the extracted-name → final-name mapping.
 */
function buildHeadingsByFinalTopic(
  extractedTopics: ExtractedTopic[],
  finalTopics: string[]
): Record<string, HeadingRef[]> {
  const headingsByTopic: Record<string, HeadingRef[]> = {};
  const seenKeysByTopic: Record<string, Set<string>> = {};

  for (const topic of extractedTopics) {
    // Find the final topic name this maps to
    const finalName = finalTopics.find(
      t => t.toLowerCase() === topic.name.toLowerCase() ||
           topic.name.toLowerCase().includes(t.toLowerCase()) ||
           t.toLowerCase().includes(topic.name.toLowerCase())
    ) || topic.name;

    if (topic.headings.length === 0) continue;

    if (!headingsByTopic[finalName]) {
      headingsByTopic[finalName] = [];
      seenKeysByTopic[finalName] = new Set();
    }
    for (const heading of topic.headings) {
      const key = headingRefKey(heading);
      if (!seenKeysByTopic[finalName].has(key)) {
        seenKeysByTopic[finalName].add(key);
        headingsByTopic[finalName].push(heading);
      }
    }
  }

  return headingsByTopic;
}

// ─── Review warnings ──────────────────────────────────────────────────────────
//
// Deterministic, non-blocking hints surfaced alongside the topic → heading review. They flag rows
// worth a human look — they never fail a run, and a heuristic missing a real problem or flagging a
// deliberate choice (topics that legitimately share a practice slide, say) is expected.

/** Threshold (characters) under which a topic's matched content is flagged as thin — a hint that
 * its headings may be incomplete or too narrowly scoped. */
export const MIN_TOPIC_CONTENT_CHARS = 250;

/** A single document section linked by this many or more topics is flagged for a look — either
 * the topics are near-duplicates or the section is legitimately shared (e.g. a practice slide
 * common to several grammar points). */
const SHARED_SECTION_MIN_TOPICS = 3;

const NAME_MATCH_MIN_WORD_LENGTH = 3;

/** English and French articles/prepositions short enough, or common enough, to be meaningless for
 * comparing a topic name against its heading text. */
const NAME_MATCH_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'with', 'without',
  'is', 'are', 'this', 'that', 'from', 'by', 'as',
  'le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'et', 'ou', 'en', 'dans', 'sur',
  'avec', 'sans', 'est', 'sont', 'ce', 'cette', 'ces', 'au', 'aux', 'pour',
]);

function stripAccents(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Meaningful, comparable words from a topic name or heading: accent- and case-folded,
 * parenthetical asides removed, short words and stopwords dropped. */
function meaningfulWords(text: string): Set<string> {
  const withoutParens = text.replace(/\([^)]*\)/g, ' ');
  const normalized = stripAccents(withoutParens.toLowerCase());
  const words = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  return new Set(words.filter(w => w.length >= NAME_MATCH_MIN_WORD_LENGTH && !NAME_MATCH_STOPWORDS.has(w)));
}

export type TopicWarningType = 'duplicate-content' | 'containment' | 'thin-content' | 'shared-section' | 'name-mismatch';

export interface TopicWarning {
  type: TopicWarningType;
  message: string;
}

export interface TopicWarningInput {
  name: string;
  headings: HeadingRef[];
  totalChars: number;
}

/** True when every span in `spansA` falls within some single span in `spansB` — `spansA`'s content
 * is entirely a subset of `spansB`'s. Empty `spansA` is never "contained" (there is nothing to
 * check, so it isn't meaningfully true). */
function isFullyContained(spansA: HeadingSpan[], spansB: HeadingSpan[]): boolean {
  if (spansA.length === 0) return false;
  return spansA.every(a => spansB.some(b => a.start >= b.start && a.end <= b.end));
}

/**
 * Computes review warnings for a set of final topics:
 * - `duplicate-content`: two or more topics whose heading lists resolve to the same set of
 *   sections (and therefore identical content) — heading sets are compared by key, so this needs
 *   no access to the document text itself.
 * - `containment`: one topic's resolved sections all fall inside a single other topic's resolved
 *   sections, without the reverse also being true (that's `duplicate-content` instead) — e.g. one
 *   topic assigned a parent heading and a second topic assigned one of that heading's children,
 *   never merged into the same topic so `collapseNestedHeadings` never sees them together. Needs
 *   `documentHeadings` to resolve each ref to its actual document span; skipped when omitted.
 * - `thin-content`: a topic (with at least one heading) resolving to under
 *   `MIN_TOPIC_CONTENT_CHARS` of content.
 * - `shared-section`: a single section linked by `SHARED_SECTION_MIN_TOPICS` or more topics.
 * - `name-mismatch`: a topic whose linked headings share no meaningful word with its own name.
 */
export function computeTopicWarnings(
  topics: TopicWarningInput[],
  documentHeadings?: DocumentHeadingOccurrence[]
): TopicWarning[] {
  const warnings: TopicWarning[] = [];

  const namesByHeadingSet = new Map<string, string[]>();
  for (const topic of topics) {
    if (topic.headings.length === 0) continue;
    const key = topic.headings.map(headingRefKey).sort().join('|');
    if (!namesByHeadingSet.has(key)) namesByHeadingSet.set(key, []);
    namesByHeadingSet.get(key)!.push(topic.name);
  }
  for (const names of namesByHeadingSet.values()) {
    if (names.length < 2) continue;
    warnings.push({
      type: 'duplicate-content',
      message: `${names.map(n => `"${n}"`).join(', ')} resolve to identical content`,
    });
  }

  if (documentHeadings) {
    const spansByTopic = new Map<string, HeadingSpan[]>();
    for (const topic of topics) {
      if (topic.headings.length > 0) {
        spansByTopic.set(topic.name, resolveHeadingSpans(topic.headings, documentHeadings));
      }
    }
    const names = Array.from(spansByTopic.keys());
    for (const nameA of names) {
      for (const nameB of names) {
        if (nameA === nameB) continue;
        const spansA = spansByTopic.get(nameA)!;
        const spansB = spansByTopic.get(nameB)!;
        if (!isFullyContained(spansA, spansB)) continue;
        // Containment in both directions means identical content, already reported above.
        if (isFullyContained(spansB, spansA)) continue;
        warnings.push({
          type: 'containment',
          message: `"${nameA}"'s content is entirely contained in "${nameB}"'s`,
        });
      }
    }
  }

  for (const topic of topics) {
    if (topic.headings.length > 0 && topic.totalChars < MIN_TOPIC_CONTENT_CHARS) {
      warnings.push({
        type: 'thin-content',
        message: `"${topic.name}" resolves to only ${topic.totalChars} character(s) of content`,
      });
    }
  }

  const topicNamesByHeadingKey = new Map<string, { ref: HeadingRef; names: Set<string> }>();
  for (const topic of topics) {
    for (const ref of topic.headings) {
      const key = headingRefKey(ref);
      if (!topicNamesByHeadingKey.has(key)) topicNamesByHeadingKey.set(key, { ref, names: new Set() });
      topicNamesByHeadingKey.get(key)!.names.add(topic.name);
    }
  }
  for (const { ref, names } of topicNamesByHeadingKey.values()) {
    if (names.size >= SHARED_SECTION_MIN_TOPICS) {
      warnings.push({
        type: 'shared-section',
        message: `"${formatHeadingRef(ref)}" is linked by ${names.size} topics: ${Array.from(names).map(n => `"${n}"`).join(', ')}`,
      });
    }
  }

  for (const topic of topics) {
    if (topic.headings.length === 0) continue;
    const nameWords = meaningfulWords(topic.name);
    if (nameWords.size === 0) continue;
    const headingWords = new Set<string>();
    for (const ref of topic.headings) {
      for (const w of meaningfulWords(headingRefText(ref))) headingWords.add(w);
    }
    const overlaps = Array.from(nameWords).some(w => headingWords.has(w));
    if (!overlaps) {
      warnings.push({
        type: 'name-mismatch',
        message: `"${topic.name}" shares no word with its linked heading(s): ${topic.headings.map(formatHeadingRef).join(', ')}`,
      });
    }
  }

  return warnings;
}

const WARNING_LABELS: Record<TopicWarningType, string> = {
  'duplicate-content': 'Duplicate content',
  'containment': 'Content contained in another topic',
  'thin-content': `Thin content (< ${MIN_TOPIC_CONTENT_CHARS} chars)`,
  'shared-section': `Section shared by ${SHARED_SECTION_MIN_TOPICS}+ topics`,
  'name-mismatch': 'Topic name and heading(s) share no word',
};

const WARNING_TYPE_ORDER: TopicWarningType[] = ['duplicate-content', 'containment', 'thin-content', 'shared-section', 'name-mismatch'];

/**
 * Renders `computeTopicWarnings`'s output grouped by type, as plain lines — safe to `console.log`
 * one at a time or splice into a larger `lines.join('\n')` block. Empty when there are no
 * warnings, so callers can append the result unconditionally.
 */
export function formatWarnings(warnings: TopicWarning[]): string[] {
  if (warnings.length === 0) return [];
  const lines: string[] = ['', 'WARNINGS (review, not blocking):'];
  for (const type of WARNING_TYPE_ORDER) {
    const group = warnings.filter(w => w.type === type);
    if (group.length === 0) continue;
    lines.push(`  ${WARNING_LABELS[type]}:`);
    for (const w of group) lines.push(`    - ${w.message}`);
  }
  return lines;
}

/**
 * Prints each final topic with its exact headings and the size of the content they resolve to
 * (sections, characters, slide range) — the review a human (or `--review-topics`) sees before
 * `stepAutoUpdateFiles` writes these headings to the `units` table. Flags topics with no headings
 * at all and topics whose headings matched zero sections in the document. `collapsedCounts`, when
 * given, notes how many nested headings `collapseNestedHeadings` dropped from that topic's list.
 */
function printTopicReviewTable(
  suggestedTopics: string[],
  headingsByTopic: Record<string, HeadingRef[]>,
  markdown: string,
  collapsedCounts?: Record<string, number>
): void {
  console.log('\n📋 Topic → heading review (before DB write):');
  console.log('─'.repeat(40));

  const warningInputs: TopicWarningInput[] = [];

  for (const topicName of suggestedTopics) {
    const headings = headingsByTopic[topicName] || [];
    const summary = summarizeExactSections(markdown, headings);
    const slides = summary.firstSlide === null
      ? 'no slides'
      : summary.firstSlide === summary.lastSlide
        ? `s.${summary.firstSlide}`
        : `s.${summary.firstSlide}-${summary.lastSlide}`;

    let flag = '';
    if (headings.length === 0) flag = '  ⚠️  NO HEADINGS';
    else if (summary.sectionCount === 0) flag = '  ⚠️  NO CONTENT MATCHED';
    const collapsedCount = collapsedCounts?.[topicName];
    if (collapsedCount) flag += `  (collapsed ${collapsedCount} nested heading(s))`;

    console.log(`   • ${topicName}${flag}`);
    for (const heading of headings) {
      console.log(`       - ${formatHeadingRef(heading)}`);
    }
    console.log(`       ${summary.sectionCount} section(s), ${summary.totalChars.toLocaleString()} chars, ${slides}`);

    warningInputs.push({ name: topicName, headings, totalChars: summary.totalChars });
  }

  const documentHeadings = extractDocumentHeadings(markdown);
  for (const line of formatWarnings(computeTopicWarnings(warningInputs, documentHeadings))) {
    console.log(line);
  }
}

/**
 * Cross-unit topic consolidation.
 * Identifies duplicate/overlapping topics across all units.
 */
async function consolidateAllTopics(units: Unit[], sessionId: string) {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║           CROSS-UNIT TOPIC CONSOLIDATION                   ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const allTopics = getAllTopics(units);
  const topicNames = Array.from(allTopics.keys());

  console.log(`📋 Analyzing ${topicNames.length} topics across ${units.length} units...\n`);

  // Fast pass: find candidate pairs via string matching
  const candidates: { t1: string; t2: string; u1: string; u2: string }[] = [];
  for (let i = 0; i < topicNames.length; i++) {
    for (let j = i + 1; j < topicNames.length; j++) {
      const dupes = findPotentialDuplicates(topicNames[i], [topicNames[j]]);
      if (dupes.length > 0) {
        candidates.push({
          t1: topicNames[i], t2: topicNames[j],
          u1: allTopics.get(topicNames[i])!,
          u2: allTopics.get(topicNames[j])!,
        });
      }
    }
  }

  if (candidates.length === 0) {
    console.log('✅ No potential duplicates found across units.');
    return;
  }

  console.log(`🔍 Found ${candidates.length} candidate pair(s). Checking with AI...\n`);

  const results: TopicSimilarity[] = [];
  for (const pair of candidates) {
    const sim = await checkTopicSimilarity(pair.t1, pair.t2, sessionId);
    results.push(sim);

    const icon = sim.similarity === 'identical' ? '🔴'
      : sim.similarity === 'overlapping' ? '🟡'
      : sim.similarity === 'related' ? '🔵' : '⚪';
    console.log(`${icon} ${pair.t1} (${pair.u1}) ↔ ${pair.t2} (${pair.u2})`);
    console.log(`   ${sim.similarity}: ${sim.explanation}`);
    if (sim.suggestedName) {
      console.log(`   → ${sim.recommendation}: "${sim.suggestedName}"`);
    }
    console.log();
  }

  // Summary
  const identical = results.filter(r => r.similarity === 'identical');
  const overlapping = results.filter(r => r.similarity === 'overlapping');

  console.log('═'.repeat(60));
  console.log('CONSOLIDATION SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  Identical (should merge): ${identical.length}`);
  console.log(`  Overlapping (review):     ${overlapping.length}`);
  console.log(`  Related (keep both):      ${results.filter(r => r.similarity === 'related').length}`);
  console.log(`  Distinct (false alarm):   ${results.filter(r => r.similarity === 'distinct').length}`);

  if (identical.length > 0 || overlapping.length > 0) {
    console.log('\n⚠️  Action needed: review identical/overlapping topics in units table');
  } else {
    console.log('\n✅ No consolidation needed.');
  }
}

// ─── Repair mode (--map-existing) ────────────────────────────────────────────
//
// Rebuilds headings for a unit's existing topic *names* without re-extracting the names
// themselves — for a unit whose topic names must stay stable (e.g. questions are already
// generated against them) but whose headings need to be validated or corrected.

/**
 * Calls the model to map `topicNames` to document headings, validates the result the same way
 * as `extractTopicCandidates` (one corrective retry, then fail loudly), simplifies each validated
 * heading to a bare string where its text is unique, and returns a mapping covering every
 * requested topic (a topic the model didn't return at all maps to `[]`).
 */
export async function mapExistingHeadings(
  topicNames: string[],
  markdown: string,
  sessionId: string
): Promise<Record<string, HeadingRef[]>> {
  const prompt = buildMapExistingPrompt(topicNames, markdown);

  const result = await callLlm({
    model: MODELS.topicExtraction,
    maxTokens: 12000,
    disableReasoning: true,
    messages: [{ role: 'user', content: prompt }],
    sessionId,
  });
  recordCall(runUsage, result.usage);

  let mappings: Record<string, HeadingRef[]>;
  try {
    mappings = parseMapExistingResponse(result.text, topicNames);
  } catch (err) {
    if (err instanceof MapExistingParseError) {
      logger.error(err.message, { response: result.text });
    }
    throw err;
  }

  const documentHeadings = extractDocumentHeadings(markdown);
  const asTopics = topicNames.map(name => ({ name, headings: mappings[name] }));
  let mismatches = findHeadingMismatches(asTopics, documentHeadings);

  if (mismatches.length > 0) {
    logger.warn(`${mismatches.length} mapped heading(s) do not match the document — retrying once`, { mismatches });
    const corrections = await retryHeadingMismatches(mismatches, documentHeadings, `${sessionId}:heading-retry`);
    for (const name of topicNames) {
      if (corrections[name]) mappings[name] = corrections[name];
    }
    const revalidated = topicNames.map(name => ({ name, headings: mappings[name] }));
    mismatches = findHeadingMismatches(revalidated, documentHeadings);
  }

  if (mismatches.length > 0) {
    throw new Error(
      `${mismatches.length} mapped heading(s) still do not match any heading in the document after one retry:\n${formatHeadingMismatches(mismatches)}`
    );
  }

  for (const name of topicNames) {
    mappings[name] = mappings[name].map(ref => simplifyHeadingRef(ref, documentHeadings));
  }

  return mappings;
}

export interface HeadingRepairProposalTopic {
  name: string;
  headings: HeadingRef[];
  sectionCount: number;
  totalChars: number;
  firstSlide: number | null;
  lastSlide: number | null;
}

export interface HeadingRepairProposal {
  unitId: string;
  sourceFile: string;
  timestamp: string;
  topics: HeadingRepairProposalTopic[];
}

/** Pure — shapes a repair-mode mapping result into the proposal written to
 * `content/exports/heading-repair-<unit-id>.json`, one row per topic with its matched-content
 * size, so a reviewer can see what each proposed heading set actually resolves to. Used both for
 * the model-generated proposal and, via `--from-proposal`, to re-render a hand-edited one against
 * the live document. */
export function buildHeadingRepairProposal(
  unitId: string,
  sourceFile: string,
  markdown: string,
  topicNames: string[],
  mappings: Record<string, HeadingRef[]>
): HeadingRepairProposal {
  return {
    unitId,
    sourceFile,
    timestamp: new Date().toISOString(),
    topics: topicNames.map(name => {
      const headings = mappings[name] || [];
      const summary = summarizeExactSections(markdown, headings);
      return {
        name,
        headings,
        sectionCount: summary.sectionCount,
        totalChars: summary.totalChars,
        firstSlide: summary.firstSlide,
        lastSlide: summary.lastSlide,
      };
    }),
  };
}

export interface FormatHeadingRepairTableOptions {
  /** How many nested headings `collapseNestedHeadings` dropped from each topic's list, keyed by
   * topic name. A topic absent from this map, or mapped to 0, had nothing collapsed. */
  collapsedCounts?: Record<string, number>;
  /** The source document's headings, needed to resolve each topic's headings to their actual line
   * spans for the `containment` warning. Omit to skip that one check — every other warning still
   * runs. */
  documentHeadings?: DocumentHeadingOccurrence[];
}

/** Pure — the readable Markdown table written alongside the JSON proposal. */
export function formatHeadingRepairTable(
  proposal: HeadingRepairProposal,
  options: FormatHeadingRepairTableOptions = {}
): string {
  const lines: string[] = [];
  lines.push(`# Heading repair proposal: ${proposal.unitId}`);
  lines.push('');
  lines.push(`Source: ${proposal.sourceFile}`);
  lines.push(`Generated: ${proposal.timestamp}`);
  lines.push('');
  lines.push('| Topic | Headings | Sections | Chars | Slides |');
  lines.push('|---|---|---|---|---|');

  for (const topic of proposal.topics) {
    const headingsCell = topic.headings.length > 0 ? topic.headings.map(formatHeadingRef).join('; ') : '—';
    const slides = topic.firstSlide === null
      ? '—'
      : topic.firstSlide === topic.lastSlide
        ? `${topic.firstSlide}`
        : `${topic.firstSlide}–${topic.lastSlide}`;
    let flag = topic.headings.length === 0
      ? ' ⚠️ no heading'
      : topic.sectionCount === 0
        ? ' ⚠️ no content'
        : '';
    const collapsedCount = options.collapsedCounts?.[topic.name];
    if (collapsedCount) flag += ` (collapsed ${collapsedCount} nested heading(s))`;
    lines.push(`| ${topic.name}${flag} | ${headingsCell} | ${topic.sectionCount} | ${topic.totalChars} | ${slides} |`);
  }

  const warnings = computeTopicWarnings(
    proposal.topics.map(t => ({ name: t.name, headings: t.headings, totalChars: t.totalChars })),
    options.documentHeadings
  );
  lines.push(...formatWarnings(warnings));

  return lines.join('\n');
}

/**
 * Reads a (presumably hand-edited) proposal JSON — same shape `buildHeadingRepairProposal`
 * produces — and returns just the `name -> headings` mapping it declares. Makes no assumption
 * about which topics it covers; `runMapExisting` falls back to a unit's existing headings for any
 * topic the file doesn't mention.
 */
export function readProposalMappings(proposalPath: string): Record<string, HeadingRef[]> {
  const raw = JSON.parse(fs.readFileSync(proposalPath, 'utf-8'));
  const topics: Array<{ name: string; headings: HeadingRef[] }> = raw.topics ?? [];
  const mappings: Record<string, HeadingRef[]> = {};
  for (const topic of topics) {
    mappings[topic.name] = topic.headings ?? [];
  }
  return mappings;
}

async function runMapExisting(
  markdownPath: string,
  unitId: string,
  units: Unit[],
  writeDb: boolean,
  fromProposalPath?: string
): Promise<void> {
  const unit = units.find(u => u.id === unitId);
  if (!unit) {
    logger.error(`Unit ${unitId} not found in DB — --map-existing repairs headings for an existing unit's topics, it cannot create a new unit`);
    process.exit(1);
  }

  const markdown = fs.readFileSync(markdownPath, 'utf-8');
  assertValidSlideMarkers(markdown, markdownPath);
  const documentHeadings = extractDocumentHeadings(markdown);
  let mappings: Record<string, HeadingRef[]>;
  let topicNames: string[];

  if (fromProposalPath) {
    console.log(`🔧 Applying hand-edited proposal for ${unitId} from ${fromProposalPath} (no model call)...\n`);
    mappings = readProposalMappings(fromProposalPath);
    topicNames = Object.keys(mappings);

    if (topicNames.length === 0) {
      logger.error(`No topics found in proposal file: ${fromProposalPath}`);
      process.exit(1);
    }

    const asTopics = topicNames.map(name => ({ name, headings: mappings[name] }));
    const mismatches = findHeadingMismatches(asTopics, documentHeadings);
    if (mismatches.length > 0) {
      throw new Error(
        `${mismatches.length} heading(s) in ${fromProposalPath} do not resolve to exactly one section in the document:\n${formatHeadingMismatches(mismatches)}`
      );
    }

    for (const name of topicNames) {
      mappings[name] = mappings[name].map(ref => simplifyHeadingRef(ref, documentHeadings));
    }
  } else {
    topicNames = unit.topics.map(t => t.name);
    if (topicNames.length === 0) {
      logger.error(`Unit ${unitId} has no topics to map`);
      process.exit(1);
    }

    console.log(`🔧 Repairing headings for ${topicNames.length} existing topic(s) in ${unitId}...\n`);
    const runId = `content-suggest-topics-map-existing-${unitId}-${Date.now()}`;
    mappings = await mapExistingHeadings(topicNames, markdown, `${runId}:map-existing`);
  }

  // Normalize the final mapping — model output and a hand-edited proposal alike — before it's
  // shown or written: drop any heading already covered by another one listed for the same topic.
  const collapsedCounts: Record<string, number> = {};
  for (const name of topicNames) {
    const { headings, collapsedCount } = collapseNestedHeadings(mappings[name] ?? [], documentHeadings);
    mappings[name] = headings;
    if (collapsedCount > 0) collapsedCounts[name] = collapsedCount;
  }

  const proposal = buildHeadingRepairProposal(unitId, markdownPath, markdown, topicNames, mappings);
  const table = formatHeadingRepairTable(proposal, { collapsedCounts, documentHeadings });
  console.log(table);

  if (!fs.existsSync(EXPORTS_DIR)) {
    fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  }
  const jsonPath = path.join(EXPORTS_DIR, `heading-repair-${unitId}.json`);
  const tablePath = path.join(EXPORTS_DIR, `heading-repair-${unitId}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(proposal, null, 2));
  fs.writeFileSync(tablePath, table);
  console.log(`\n💾 Proposal saved to: ${jsonPath}`);
  console.log(`💾 Table saved to:    ${tablePath}`);

  if (!writeDb) {
    console.log('\nℹ️  Preview only — pass --write-db to write these headings to the units table.');
    return;
  }

  const writeClient = createScriptSupabase({ write: true });
  // Only `headings` changes — a topic the mapping doesn't mention keeps its current headings,
  // and every other field on the unit row (title, label, description, sort_order,
  // source_file_stem, and any topic not named here) is untouched by this partial update.
  const topicsWithHeadings = unit.topics.map(t => ({
    name: t.name,
    headings: mappings[t.name] ?? t.headings,
  }));

  const { error } = await writeClient
    .from('units')
    .update({ topics: topicsWithHeadings })
    .eq('id', unitId);

  if (error) {
    logger.error(`Failed to write repaired headings for ${unitId}`, { message: error.message });
    process.exit(1);
  }
  console.log(`\n✅ Wrote repaired headings for ${topicNames.length} topic(s) to ${unitId}`);
}

/**
 * Main function.
 *
 * Takes two positional arguments (`<markdown-file> <unit-id>`) in its normal and `--map-existing`
 * modes, and none in `--consolidate` mode — `cli.config.validate` enforces that split, since a
 * per-flag `required` can't express "required unless a sibling flag is set."
 */
async function main() {
  loadEnv();
  // Fires on every exit path (process.exit(), a natural return, or an uncaught error) — the one
  // place that doesn't need to be threaded through this file's several early-exit branches.
  process.on('exit', () => {
    if (runUsage.calls > 0) {
      console.log(`\n${formatUsageSummary(runUsage)}`);
    }
  });

  const options = cli.parse();

  // Fetch units from database
  const supabase = createScriptSupabase();
  const units = await fetchUnitsFromDb(supabase);

  // Standalone consolidation mode
  if (options.consolidate) {
    const runId = `content-suggest-topics-consolidate-${Date.now()}`;
    await consolidateAllTopics(units, `${runId}:topic-similarity`);
    return;
  }

  // --consolidate's absence is already enforced by cli.config.validate, so both positionals are
  // guaranteed present here.
  const markdownPath = options.markdownFile!;
  const unitId = options.unitId!;
  const fromProposalPath = options.fromProposal;
  const mapExisting = options.mapExisting || fromProposalPath !== undefined;
  const writeDb = options.writeDb;

  if (!fs.existsSync(markdownPath)) {
    logger.error(`File not found: ${markdownPath}`);
    process.exit(1);
  }

  if (fromProposalPath && !fs.existsSync(fromProposalPath)) {
    logger.error(`Proposal file not found: ${fromProposalPath}`);
    process.exit(1);
  }

  if (mapExisting) {
    await runMapExisting(markdownPath, unitId, units, writeDb, fromProposalPath);
    return;
  }

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║           TOPIC SUGGESTION TOOL                            ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  console.log(`📄 Source: ${markdownPath}`);
  console.log(`📦 Unit:   ${unitId}`);

  // Check if unit exists
  const existingUnit = units.find(u => u.id === unitId);
  if (existingUnit) {
    console.log(`ℹ️  Unit exists with ${existingUnit.topics.length} topics`);
  } else {
    console.log('🆕 New unit (not in DB yet)');
  }
  console.log();

  // Load markdown
  const markdown = fs.readFileSync(markdownPath, 'utf-8');
  assertValidSlideMarkers(markdown, markdownPath);
  console.log(`📝 Loaded ${markdown.length.toLocaleString()} characters\n`);

  const runId = `content-suggest-topics-${unitId}-${Date.now()}`;

  // Extract topic candidates and suggested label
  console.log('🔍 Extracting topic candidates...');
  const extraction = await extractTopicCandidates(markdown, unitId, units, `${runId}:topic-extraction`);
  console.log(`   Found ${extraction.topics.length} potential topics`);
  console.log(`   Suggested label: "${extraction.suggestedLabel}"\n`);

  // Reconcile with existing topics
  console.log('🔄 Reconciling with existing topics...');
  const reconciled = await reconcileTopics(extraction.topics, unitId, units, `${runId}:topic-similarity`);
  console.log();

  // Output results
  console.log('═'.repeat(60));
  console.log('RESULTS');
  console.log('═'.repeat(60));

  console.log('\n✅ USE EXISTING TOPICS (no change needed):');
  console.log('─'.repeat(40));
  if (reconciled.useExisting.length === 0) {
    console.log('   (none)');
  } else {
    for (const match of reconciled.useExisting) {
      if (match.extracted === match.existing) {
        console.log(`   • ${match.existing}`);
      } else {
        console.log(`   • ${match.existing}`);
        console.log(`     (matched from: "${match.extracted}")`);
      }
    }
  }

  console.log('\n🆕 NEW TOPICS TO ADD:');
  console.log('─'.repeat(40));
  if (reconciled.addNew.length === 0) {
    console.log('   (none - all content maps to existing topics)');
  } else {
    for (const topic of reconciled.addNew) {
      console.log(`   + ${topic}`);
    }
  }

  console.log('\n⚠️  NEEDS HUMAN REVIEW:');
  console.log('─'.repeat(40));
  if (reconciled.needsReview.length === 0) {
    console.log('   (none)');
  } else {
    for (const item of reconciled.needsReview) {
      console.log(`   ? "${item.extracted}"`);
      console.log(`     Reason: ${item.reason}`);
      console.log(`     Candidates: ${item.candidates.join(', ')}`);
      console.log();
    }
  }

  // Generate suggested update
  const suggestedTopics = generateTopicsArray(reconciled.useExisting, reconciled.addNew);

  console.log('\n' + '═'.repeat(60));
  console.log('SUGGESTED UPDATE FOR units table');
  console.log('═'.repeat(60));

  // Determine the label to use - only show if different from existing
  const existingLabel = existingUnit?.label;
  const suggestedLabel = extraction.suggestedLabel;
  const labelsDiffer = existingLabel !== suggestedLabel;
  const finalLabel = labelsDiffer ? suggestedLabel : existingLabel;

  if (labelsDiffer && existingLabel) {
    console.log(`\n⚠️  Suggested label differs from existing:`);
    console.log(`   Existing:  "${existingLabel}"`);
    console.log(`   Suggested: "${suggestedLabel}"`);
  }

  console.log(`
// In units table, ${existingUnit ? 'update' : 'add'}:

{
  id: '${unitId}',
  title: '🇫🇷 ${existingUnit?.title.replace('🇫🇷 ', '') || getUnitLabel(unitId)}',${finalLabel ? `\n  label: '${finalLabel.replace(/'/g, "\\'")}',` : ''}
  description: '${existingUnit?.description || 'TODO: Add description'}',
  topics: [
${suggestedTopics.map(t => `    '${t.replace(/'/g, "\\'")}',`).join('\n')}
  ],
},
`);

  // Group each extracted topic's validated headings under its final topic name, then collapse any
  // parent-plus-child pair introduced by merging multiple extracted topics into one final topic.
  const headingMappings = buildHeadingsByFinalTopic(extraction.topics, suggestedTopics);
  const documentHeadings = extractDocumentHeadings(markdown);
  const collapsedCounts: Record<string, number> = {};
  for (const topicName of Object.keys(headingMappings)) {
    const { headings, collapsedCount } = collapseNestedHeadings(headingMappings[topicName], documentHeadings);
    headingMappings[topicName] = headings;
    if (collapsedCount > 0) collapsedCounts[topicName] = collapsedCount;
  }

  // Save detailed results (predictable filename for pipeline consumption)
  const outputDir = EXPORTS_DIR;
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const outputPath = path.join(outputDir, `topics-${unitId}.json`);
  fs.writeFileSync(outputPath, JSON.stringify({
    unitId,
    sourceFile: markdownPath,
    timestamp: new Date().toISOString(),
    suggestedLabel: extraction.suggestedLabel,
    extractedTopics: extraction.topics,
    reconciled,
    suggestedTopics,
    headingMappings,
  }, null, 2));

  console.log(`\n💾 Detailed results saved to: ${outputPath}`);

  // Review table: headings and matched-content size per topic, before stepAutoUpdateFiles writes
  printTopicReviewTable(suggestedTopics, headingMappings, markdown, collapsedCounts);

  // Summary
  console.log('\n' + '═'.repeat(60));
  console.log('SUMMARY');
  console.log('═'.repeat(60));
  console.log(`   Extracted:      ${extraction.topics.length} topics`);
  console.log(`   Use existing:   ${reconciled.useExisting.length}`);
  console.log(`   Add new:        ${reconciled.addNew.length}`);
  console.log(`   Needs review:   ${reconciled.needsReview.length}`);
  console.log(`   Final count:    ${suggestedTopics.length} topics`);
}

runIfMain(import.meta.url, main);
