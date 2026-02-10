/**
 * Script to suggest topics for a new or existing unit
 *
 * Workflow:
 * 1. Convert PDF to markdown (convert-pdfs.ts)
 * 2. Run this script to extract and validate topics
 * 3. Review suggestions and update units.ts
 * 4. Run generate-questions.ts for the unit
 *
 * Run with: npx tsx scripts/suggest-unit-topics.ts <markdown-file> <unit-id>
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import { MODELS } from './lib/config';

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { units } from '../src/lib/units';
import {
  getAllTopics,
  findPotentialDuplicates,
  checkTopicSimilarity,
} from './lib/topic-utils';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

interface ExtractedTopic {
  name: string;
  category: 'vocabulary' | 'grammar' | 'culture' | 'communication';
  contentSummary: string;
  headingSource: string;
}

interface ExtractionResult {
  topics: ExtractedTopic[];
  suggestedLabel: string;
}

/**
 * Extract topic candidates and suggest a unit label from markdown
 */
async function extractTopicCandidates(
  markdown: string,
  _unitId: string
): Promise<ExtractionResult> {

  // Get all existing topics for context
  const allTopics = getAllTopics();
  const existingList = Array.from(allTopics.keys());

  const prompt = `You are analyzing French 1 course materials to identify distinct teachable topics.

## Your Task
1. Extract ALL teachable topics from this content
2. Suggest a short label (2-4 words) summarizing the unit's primary focus

Each topic should be:
- A distinct concept that can be tested with quiz questions
- Specific enough to generate 10-30 questions
- Named consistently with the existing topics

## Existing Topics (use these exact names if content matches)
${existingList.map(t => `- ${t}`).join('\n')}

## Content to Analyze
${markdown.slice(0, 20000)}
${markdown.length > 20000 ? '\n[Content truncated...]' : ''}

## Output Format
Return ONLY valid JSON object:
{
  "suggestedLabel": "2-4 word label for the unit (e.g., 'Activities & -ER Verbs', 'Être, Avoir & Numbers')",
  "topics": [
    {
      "name": "Topic Name (with examples if helpful)",
      "category": "vocabulary|grammar|culture|communication",
      "contentSummary": "Brief description of what this topic covers",
      "headingSource": "The markdown heading(s) this came from"
    }
  ]
}

## Label Guidelines
- Focus on the 1-2 most important/distinctive concepts in the unit
- Use "&" to combine concepts if needed
- Examples: "Basics & Greetings", "Activities & -ER Verbs", "Être, Avoir & Numbers"

## Topic Naming Conventions
- Vocabulary: "X Vocabulary" or "X (example, example)" e.g., "Food Vocabulary", "Colors (rouge, bleu)"
- Verbs: "Verb: French (to English)" e.g., "Verb: Avoir (to have)"
- Conjugation: "-ER Verb Conjugation", "Present Tense Conjugation"
- Grammar concepts: Descriptive with examples e.g., "Subject Pronouns (je, tu, il/elle...)"
- Numbers: Always specify range e.g., "Numbers 0-20", "Numbers 20-100"
- Cultural: "French X" or "X in France" e.g., "French Geography", "Holidays in France"

Extract ALL topics, even if they seem to overlap with existing ones. We will deduplicate later.`;

  const message = await anthropic.messages.create({
    model: MODELS.topicExtraction,
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });

  const responseText = message.content[0].type === 'text' ? message.content[0].text : '';

  // Extract JSON object
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error('Response:', responseText);
    throw new Error('No valid JSON object found in response');
  }

  const parsed = JSON.parse(jsonMatch[0]);
  return {
    topics: parsed.topics || [],
    suggestedLabel: parsed.suggestedLabel || 'TODO: Add label',
  };
}

/**
 * Reconcile extracted topics with existing topics
 */
async function reconcileTopics(
  extracted: ExtractedTopic[],
  unitId: string
): Promise<{
  useExisting: { extracted: string; existing: string }[];
  addNew: string[];
  needsReview: { extracted: string; candidates: string[]; reason: string }[];
}> {
  const allTopics = getAllTopics();
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
      const similarity = await checkTopicSimilarity(anthropic, topic.name, candidates[0]);

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
 * Generate the suggested topics array for units.ts
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
 * Compute heading mappings from extracted topics.
 * Pure function — returns a Record of topic name → keyword patterns.
 */
function computeHeadingMappings(
  extractedTopics: ExtractedTopic[],
  finalTopics: string[]
): Record<string, string[]> {
  const newMappings: Record<string, string[]> = {};

  for (const topic of extractedTopics) {
    // Find the final topic name this maps to
    const finalName = finalTopics.find(
      t => t.toLowerCase() === topic.name.toLowerCase() ||
           topic.name.toLowerCase().includes(t.toLowerCase()) ||
           t.toLowerCase().includes(topic.name.toLowerCase())
    ) || topic.name;

    // Extract keywords from heading source
    const headingSource = topic.headingSource.toLowerCase();
    const keywords = headingSource
      .split(/[,\s\-–—&]+/)
      .map(w => w.trim())
      .filter(w => w.length > 2 && !['the', 'and', 'for', 'with'].includes(w));

    if (keywords.length > 0) {
      if (!newMappings[finalName]) {
        newMappings[finalName] = [];
      }
      // Add unique keywords
      for (const kw of keywords) {
        if (!newMappings[finalName].includes(kw)) {
          newMappings[finalName].push(kw);
        }
      }
    }
  }

  return newMappings;
}

/**
 * Log new topic-heading mappings that aren't yet in topic-headings.ts
 */
async function logNewHeadingMappings(
  headingMappings: Record<string, string[]>
): Promise<void> {
  const topicHeadingsPath = path.join(process.cwd(), 'src', 'lib', 'topic-headings.ts');

  let currentContent = '';
  if (fs.existsSync(topicHeadingsPath)) {
    currentContent = fs.readFileSync(topicHeadingsPath, 'utf-8');
  }

  const existingMappings = currentContent.match(/'([^']+)':\s*\[/g) || [];
  const existingTopics = existingMappings.map(m => m.replace(/'([^']+)':\s*\[/, '$1'));

  let hasNewMappings = false;
  for (const topic of Object.keys(headingMappings)) {
    if (!existingTopics.some(t => t.toLowerCase() === topic.toLowerCase())) {
      hasNewMappings = true;
      break;
    }
  }

  if (hasNewMappings) {
    console.log('\n📝 New topic-heading mappings discovered:');
    for (const [topic, keywords] of Object.entries(headingMappings)) {
      if (!existingTopics.some(t => t.toLowerCase() === topic.toLowerCase())) {
        console.log(`   "${topic}": [${keywords.map(k => `'${k}'`).join(', ')}]`);
      }
    }
    console.log('\n   ℹ️  Add these to src/lib/topic-headings.ts for better content extraction');
  }
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error('Usage: npx tsx scripts/suggest-unit-topics.ts <markdown-file> <unit-id>');
    console.error('');
    console.error('Examples:');
    console.error('  npx tsx scripts/suggest-unit-topics.ts learnings/French\\ 1\\ Unit\\ 4.md unit-4');
    console.error('  npx tsx scripts/suggest-unit-topics.ts learnings/test-conversions/unit-2-test.md unit-2');
    process.exit(1);
  }

  const [markdownPath, unitId] = args;

  if (!fs.existsSync(markdownPath)) {
    console.error(`❌ File not found: ${markdownPath}`);
    process.exit(1);
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
    console.log('🆕 New unit (not in units.ts yet)');
  }
  console.log();

  // Load markdown
  const markdown = fs.readFileSync(markdownPath, 'utf-8');
  console.log(`📝 Loaded ${markdown.length.toLocaleString()} characters\n`);

  // Extract topic candidates and suggested label
  console.log('🔍 Extracting topic candidates...');
  const extraction = await extractTopicCandidates(markdown, unitId);
  console.log(`   Found ${extraction.topics.length} potential topics`);
  console.log(`   Suggested label: "${extraction.suggestedLabel}"\n`);

  // Reconcile with existing topics
  console.log('🔄 Reconciling with existing topics...');
  const reconciled = await reconcileTopics(extraction.topics, unitId);
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
  console.log('SUGGESTED UPDATE FOR units.ts');
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
// In src/lib/units.ts, ${existingUnit ? 'update' : 'add'}:

{
  id: '${unitId}',
  title: '🇫🇷 ${existingUnit?.title.replace('🇫🇷 ', '') || `Unit ${unitId.replace('unit-', '')}`}',${finalLabel ? `\n  label: '${finalLabel.replace(/'/g, "\\'")}',` : ''}
  description: '${existingUnit?.description || 'TODO: Add description'}',
  topics: [
${suggestedTopics.map(t => `    '${t.replace(/'/g, "\\'")}',`).join('\n')}
  ],
},
`);

  // Compute heading mappings from extracted topics
  const headingMappings = computeHeadingMappings(extraction.topics, suggestedTopics);

  // Save detailed results (predictable filename for pipeline consumption)
  const outputDir = path.join(process.cwd(), 'data');
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

  // Log any new heading mappings that need to be added
  await logNewHeadingMappings(headingMappings);

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

// Run
main().catch(console.error);
