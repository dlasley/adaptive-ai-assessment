/**
 * Topic utilities for managing and comparing topics
 */

import type { Unit } from '@adaptive/shared/types';
import { MODELS } from './pipeline-config';
import { callLlm } from '@adaptive/shared/llm';
import { getCourse } from '@adaptive/shared/course';
import { extractDocumentHeadings, type HeadingRef, type DocumentHeadingOccurrence } from './learning-materials';

export interface TopicSimilarity {
  topic1: string;
  topic2: string;
  similarity: 'identical' | 'overlapping' | 'related' | 'distinct';
  explanation: string;
  recommendation: 'merge' | 'keep-both' | 'rename';
  suggestedName?: string;
}

/**
 * Get all existing topics with their unit context
 */
export function getAllTopics(units: Unit[]): Map<string, string> {
  const topicMap = new Map<string, string>();
  for (const unit of units) {
    for (const topic of unit.topics) {
      topicMap.set(topic.name, unit.id);
    }
  }
  return topicMap;
}

/**
 * Normalize topic name for comparison
 */
function normalizeTopic(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/[()]/g, '')
    .trim();
}

/**
 * Quick check for obvious duplicates using string similarity
 */
export function findPotentialDuplicates(
  newTopic: string,
  existingTopics: string[]
): string[] {
  const normalizedNew = normalizeTopic(newTopic);
  const candidates: string[] = [];

  for (const existing of existingTopics) {
    const normalizedExisting = normalizeTopic(existing);

    // Check for substring match
    if (normalizedNew.includes(normalizedExisting) ||
        normalizedExisting.includes(normalizedNew)) {
      candidates.push(existing);
      continue;
    }

    // Check for word overlap
    const newWords = new Set(normalizedNew.split(' '));
    const existingWords = new Set(normalizedExisting.split(' '));
    const intersection = [...newWords].filter(w => existingWords.has(w) && w.length > 3);

    if (intersection.length >= 2) {
      candidates.push(existing);
    }
  }

  return candidates;
}

/**
 * Use LLM to check semantic similarity between topics
 */
export async function checkTopicSimilarity(
  topic1: string,
  topic2: string,
  sessionId: string
): Promise<TopicSimilarity> {
  const prompt = `You are a French language curriculum expert. Compare these two topic names and determine their relationship.

Topic 1: "${topic1}"
Topic 2: "${topic2}"

Classify their relationship as:
- "identical": Same topic, different wording (e.g., "ER Verbs" vs "-ER Verb Conjugation")
- "overlapping": Significant content overlap (e.g., "Numbers 1-20" vs "Numbers 0-20")
- "related": Same category but different focus (e.g., "Verb: Avoir" vs "Verb: Être")
- "distinct": No significant overlap

Return ONLY JSON:
{
  "similarity": "identical|overlapping|related|distinct",
  "explanation": "Brief explanation of the relationship",
  "recommendation": "merge|keep-both|rename",
  "suggestedName": "If merge or rename, suggest the canonical name"
}`;

  const result = await callLlm({
    model: MODELS.topicSimilarity,
    maxTokens: 500,
    disableReasoning: true,
    messages: [{ role: 'user', content: prompt }],
    sessionId,
  });

  const responseText = result.text;
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    return {
      topic1,
      topic2,
      similarity: 'distinct',
      explanation: 'Could not determine similarity',
      recommendation: 'keep-both',
    };
  }

  const parsed = JSON.parse(jsonMatch[0]);
  return {
    topic1,
    topic2,
    ...parsed,
  };
}

// ─── Topic-to-heading mapping ("--map-existing") ─────────────────────────────
//
// The prompt builder and response parser behind `content-suggest-topics --map-existing`
// (production heading repair). Kept here, rather than in the command file, so another caller can
// use the exact production prompt and parser without importing a command module.

/** The "document headings, with slides" index given to the model in the extraction and mapping
 * prompts, so it can report a slide for every heading it assigns without inferring one from
 * `<!-- slide N -->` markers scattered through the raw content on its own. */
export function formatHeadingIndex(documentHeadings: DocumentHeadingOccurrence[]): string {
  return documentHeadings.map(occ => `- "${occ.heading}" (slide ${occ.slide ?? '?'})`).join('\n');
}

export function buildMapExistingPrompt(topicNames: string[], markdown: string): string {
  const content = `${markdown}\n`;
  const documentHeadings = extractDocumentHeadings(markdown);
  return `You are mapping existing topic names to the markdown headings that teach them, for a ${getCourse().name} course unit. Do not invent new topics, rename these, or omit any — assign headings only.

## Topics (assign headings to each one; do not add, remove, or rename any)
${topicNames.map(t => `- ${t}`).join('\n')}

## Document Headings (verbatim, with slide numbers)
${formatHeadingIndex(documentHeadings)}

## Content
${content}

For each topic above, list the markdown heading(s) whose section teaches it. Each entry is an
object { "heading": "<verbatim text>", "slide": <slide number> } — copy both fields from the
Document Headings index above (no paraphrasing, no combining multiple headings into one string).
A topic with no heading of its own gets an empty array — don't guess at a nearby heading.

Return ONLY valid JSON:
{
  "topics": {
    "<topic name>": [{ "heading": "<heading>", "slide": <slide> }, ...]
  }
}`;
}

export class MapExistingParseError extends Error {}

/**
 * Extracts a `{ topic name -> headings }` mapping from a `--map-existing`-style model response:
 * finds the JSON object, reads its `topics` field, and defaults any topic `buildMapExistingPrompt`
 * asked about but the model didn't return to an empty array. Does not validate the returned
 * headings against the document — that's `findHeadingMismatches`, applied by the caller (production
 * retries a mismatch once; other callers may score the raw result instead).
 */
export function parseMapExistingResponse(responseText: string, topicNames: string[]): Record<string, HeadingRef[]> {
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new MapExistingParseError('No valid JSON object found in --map-existing response');
  }

  const parsed = JSON.parse(jsonMatch[0]);
  const mappings: Record<string, HeadingRef[]> = parsed.topics || {};
  for (const name of topicNames) {
    if (!mappings[name]) mappings[name] = [];
  }
  return mappings;
}
