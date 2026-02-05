/**
 * Script to extract and reconcile topics from learning materials
 *
 * This script:
 * 1. Reads a markdown learning file
 * 2. Uses LLM to identify teachable topics
 * 3. Compares against existing topics in units.ts
 * 4. Outputs matched topics and new topic suggestions
 *
 * Run with: npx tsx scripts/extract-topics.ts <markdown-file> <unit-id>
 * Example: npx tsx scripts/extract-topics.ts learnings/French\ 1\ Unit\ 4.md unit-4
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { units } from '../src/lib/units';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

interface TopicMatch {
  extracted: string;
  existingTopic: string;
  confidence: 'exact' | 'high' | 'medium';
  unitId: string;
}

interface NewTopicSuggestion {
  topic: string;
  description: string;
  sampleContent: string;
}

interface TopicExtractionResult {
  matches: TopicMatch[];
  newTopics: NewTopicSuggestion[];
  unmatchedExisting: string[];
}

/**
 * Get all existing topics across all units
 */
function getAllExistingTopics(): { topic: string; unitId: string }[] {
  const allTopics: { topic: string; unitId: string }[] = [];
  for (const unit of units) {
    for (const topic of unit.topics) {
      allTopics.push({ topic, unitId: unit.id });
    }
  }
  return allTopics;
}

/**
 * Extract topics from markdown using LLM
 */
async function extractTopicsFromMarkdown(
  markdown: string,
  unitId: string,
  existingTopics: { topic: string; unitId: string }[]
): Promise<TopicExtractionResult> {

  const existingTopicsList = existingTopics
    .map(t => `- "${t.topic}" (${t.unitId})`)
    .join('\n');

  const prompt = `You are analyzing French language learning materials to identify teachable topics.

## Task
Analyze the following markdown content and:
1. Identify all distinct teachable topics (vocabulary sets, grammar concepts, cultural topics)
2. Match each identified topic against the existing topics list
3. Suggest new topics only for content not covered by existing topics

## Existing Topics (DO NOT create duplicates of these)
${existingTopicsList}

## Rules for Topic Matching
- Match semantically, not just by exact string
- "Subject Pronouns" matches "Subject Pronouns (je, tu, il/elle, nous, vous, ils/elles)"
- "ER Verbs" matches "-ER Verb Conjugation"
- "Numbers" should specify range: "Numbers 0-20" vs "Numbers 20-100"
- If content fits an existing topic, USE that existing topic name exactly

## Rules for New Topics
- Only suggest truly NEW content not covered by existing topics
- Use consistent naming format: "Concept (examples)" e.g., "Colors (rouge, bleu, vert)"
- Be specific: "Verb: Aller (to go)" not just "Verbs"
- Include parenthetical examples for clarity

## Output Format
Return ONLY valid JSON:
{
  "matches": [
    {
      "extracted": "what you found in the content",
      "existingTopic": "exact name from existing topics list",
      "confidence": "exact|high|medium"
    }
  ],
  "newTopics": [
    {
      "topic": "New Topic Name (with examples)",
      "description": "Brief description of what this covers",
      "sampleContent": "Example vocabulary or concept from the markdown"
    }
  ]
}

## Content to Analyze (Unit: ${unitId})
${markdown.slice(0, 15000)}
${markdown.length > 15000 ? '\n[Content truncated...]' : ''}
`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });

  const responseText = message.content[0].type === 'text' ? message.content[0].text : '';

  // Extract JSON from response
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No valid JSON found in response');
  }

  const result = JSON.parse(jsonMatch[0]);

  // Find existing topics that weren't matched
  const matchedExisting = new Set(result.matches.map((m: TopicMatch) => m.existingTopic));
  const existingForUnit = existingTopics.filter(t => t.unitId === unitId);
  const unmatchedExisting = existingForUnit
    .filter(t => !matchedExisting.has(t.topic))
    .map(t => t.topic);

  return {
    matches: result.matches || [],
    newTopics: result.newTopics || [],
    unmatchedExisting,
  };
}

/**
 * Generate updated units.ts content
 */
function generateUnitsUpdate(
  unitId: string,
  matches: TopicMatch[],
  newTopics: NewTopicSuggestion[]
): string {
  const existingUnit = units.find(u => u.id === unitId);

  // Start with matched existing topics
  const finalTopics = new Set<string>();

  // Add all matched topics
  for (const match of matches) {
    finalTopics.add(match.existingTopic);
  }

  // Add new topics
  for (const newTopic of newTopics) {
    finalTopics.add(newTopic.topic);
  }

  const topicsArray = Array.from(finalTopics);

  return `
// Suggested topics for ${unitId}
// Review and update src/lib/units.ts

{
  id: '${unitId}',
  title: '🇫🇷 ${existingUnit?.title || unitId}',
  description: '${existingUnit?.description || 'Description needed'}',
  topics: [
${topicsArray.map(t => `    '${t.replace(/'/g, "\\'")}',`).join('\n')}
  ],
},
`;
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error('Usage: npx tsx scripts/extract-topics.ts <markdown-file> <unit-id>');
    console.error('Example: npx tsx scripts/extract-topics.ts learnings/French\\ 1\\ Unit\\ 4.md unit-4');
    process.exit(1);
  }

  const [markdownPath, unitId] = args;

  if (!fs.existsSync(markdownPath)) {
    console.error(`File not found: ${markdownPath}`);
    process.exit(1);
  }

  console.log('🔍 Topic Extraction Tool\n');
  console.log(`📄 File: ${markdownPath}`);
  console.log(`📦 Unit: ${unitId}\n`);

  // Load markdown
  const markdown = fs.readFileSync(markdownPath, 'utf-8');
  console.log(`📝 Loaded ${markdown.length} characters\n`);

  // Get existing topics
  const existingTopics = getAllExistingTopics();
  console.log(`📚 Found ${existingTopics.length} existing topics across ${units.length} units\n`);

  // Extract topics
  console.log('🤖 Analyzing content with LLM...\n');
  const result = await extractTopicsFromMarkdown(markdown, unitId, existingTopics);

  // Output results
  console.log('=' .repeat(60));
  console.log('TOPIC EXTRACTION RESULTS');
  console.log('=' .repeat(60));

  console.log('\n✅ MATCHED TO EXISTING TOPICS:');
  console.log('-'.repeat(40));
  if (result.matches.length === 0) {
    console.log('  (none)');
  } else {
    for (const match of result.matches) {
      const icon = match.confidence === 'exact' ? '🎯' :
                   match.confidence === 'high' ? '✓' : '~';
      console.log(`  ${icon} "${match.extracted}"`);
      console.log(`     → ${match.existingTopic} [${match.confidence}]`);
    }
  }

  console.log('\n🆕 NEW TOPIC SUGGESTIONS:');
  console.log('-'.repeat(40));
  if (result.newTopics.length === 0) {
    console.log('  (none - all content maps to existing topics)');
  } else {
    for (const topic of result.newTopics) {
      console.log(`  📌 "${topic.topic}"`);
      console.log(`     ${topic.description}`);
      console.log(`     Sample: ${topic.sampleContent.slice(0, 100)}...`);
      console.log();
    }
  }

  console.log('\n⚠️  EXISTING TOPICS NOT FOUND IN CONTENT:');
  console.log('-'.repeat(40));
  if (result.unmatchedExisting.length === 0) {
    console.log('  (all existing topics have matching content)');
  } else {
    for (const topic of result.unmatchedExisting) {
      console.log(`  ❓ "${topic}"`);
    }
  }

  // Generate suggested update
  console.log('\n' + '='.repeat(60));
  console.log('SUGGESTED units.ts UPDATE');
  console.log('='.repeat(60));
  console.log(generateUnitsUpdate(unitId, result.matches, result.newTopics));

  // Save results to file
  const outputPath = path.join(
    process.cwd(),
    'data',
    `topic-extraction-${unitId}-${Date.now()}.json`
  );

  fs.writeFileSync(outputPath, JSON.stringify({
    unitId,
    sourceFile: markdownPath,
    timestamp: new Date().toISOString(),
    ...result,
  }, null, 2));

  console.log(`\n💾 Full results saved to: ${outputPath}`);
}

// Run
main().catch(console.error);
