/**
 * Topic utilities for managing and comparing topics
 */

import Anthropic from '@anthropic-ai/sdk';
import { units } from '../../src/lib/units';

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
export function getAllTopics(): Map<string, string> {
  const topicMap = new Map<string, string>();
  for (const unit of units) {
    for (const topic of unit.topics) {
      topicMap.set(topic, unit.id);
    }
  }
  return topicMap;
}

/**
 * Normalize topic name for comparison
 */
export function normalizeTopic(topic: string): string {
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
  anthropic: Anthropic,
  topic1: string,
  topic2: string
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

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001', // Use Haiku for quick checks
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });

  const responseText = message.content[0].type === 'text' ? message.content[0].text : '';
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

  const result = JSON.parse(jsonMatch[0]);
  return {
    topic1,
    topic2,
    ...result,
  };
}

/**
 * Validate a list of new topics against existing topics
 */
export async function validateNewTopics(
  anthropic: Anthropic,
  newTopics: string[],
  existingTopics: string[]
): Promise<{
  approved: string[];
  duplicates: { new: string; existing: string; suggestion: string }[];
  needsReview: { new: string; candidates: string[] }[];
}> {
  const approved: string[] = [];
  const duplicates: { new: string; existing: string; suggestion: string }[] = [];
  const needsReview: { new: string; candidates: string[] }[] = [];

  for (const newTopic of newTopics) {
    // Quick check for potential duplicates
    const candidates = findPotentialDuplicates(newTopic, existingTopics);

    if (candidates.length === 0) {
      // No obvious duplicates, approve
      approved.push(newTopic);
    } else if (candidates.length === 1) {
      // One candidate, do semantic check
      const similarity = await checkTopicSimilarity(anthropic, newTopic, candidates[0]);

      if (similarity.similarity === 'identical') {
        duplicates.push({
          new: newTopic,
          existing: candidates[0],
          suggestion: similarity.suggestedName || candidates[0],
        });
      } else if (similarity.similarity === 'overlapping') {
        needsReview.push({ new: newTopic, candidates });
      } else {
        approved.push(newTopic);
      }
    } else {
      // Multiple candidates, needs human review
      needsReview.push({ new: newTopic, candidates });
    }
  }

  return { approved, duplicates, needsReview };
}

/**
 * Generate a canonical topic name from content
 */
export async function suggestTopicName(
  anthropic: Anthropic,
  content: string,
  existingTopics: string[]
): Promise<string> {
  const existingExamples = existingTopics.slice(0, 10).join('\n- ');

  const prompt = `You are naming a French language learning topic.

Content to name:
${content.slice(0, 1000)}

Existing topic naming conventions (follow this style):
- ${existingExamples}

Rules:
1. Be specific (include examples in parentheses if helpful)
2. Use consistent formatting with existing topics
3. For verbs: "Verb: [French] (to [English])" e.g., "Verb: Avoir (to have)"
4. For vocabulary: "[Category] Vocabulary" or "[Category] (examples)"
5. For grammar: Descriptive name with examples if needed

Return ONLY the topic name, nothing else.`;

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 100,
    messages: [{ role: 'user', content: prompt }],
  });

  return message.content[0].type === 'text'
    ? message.content[0].text.trim().replace(/^["']|["']$/g, '')
    : 'Unknown Topic';
}
