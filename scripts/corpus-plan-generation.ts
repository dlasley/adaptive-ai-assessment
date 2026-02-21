/**
 * Question Generation Planner
 * Analyzes current distribution and creates an execution plan to reach target distribution
 *
 * Usage:
 *   npx tsx scripts/plan-generation.ts              # Show analysis and plan
 *   npx tsx scripts/plan-generation.ts --execute    # Execute the plan
 *   npx tsx scripts/plan-generation.ts --analyze-only  # Just show analysis
 *
 * Options:
 *   --execute        Execute the generation plan
 *   --analyze-only   Only show distribution analysis, no plan
 *   --target-writing <n>  Target percentage for writing questions (default: 27)
 *   --help, -h       Show this help message
 */

import { spawn } from 'child_process';
import readline from 'readline';
import { units } from '../src/lib/units';
import { createScriptSupabase, fetchAllQuestions, analyzeDistribution, type DistributionAnalysis } from './lib/db-queries';
import { COST_PER_API_CALL } from './lib/config';

const supabase = createScriptSupabase();

// ============================================================================
// Configuration
// ============================================================================

// Target distribution for question types (percentages)
const TARGET_QUESTION_TYPE_DISTRIBUTION = {
  'multiple-choice': 33,
  'fill-in-blank': 26,
  'true-false': 14,
  'writing': 27,
};

// Target distribution for writing subtypes (percentages of writing questions)
const TARGET_WRITING_TYPE_DISTRIBUTION = {
  'translation': 35,
  'sentence_building': 25,
  'conjugation': 18,
  'question_formation': 12,
  'open_ended': 10,
};

// Topic compatibility for writing types (topics that support each type well)
// Topics not listed will use all-topic generation with expected drift
const TOPIC_COMPATIBILITY: Record<string, { topics: Array<{ unitId: string; topic: string }>; estimatedDrift: number }> = {
  'conjugation': {
    topics: [
      { unitId: 'unit-2', topic: '-ER Verb Conjugation' },
      { unitId: 'unit-2', topic: 'Common Verbs (parler, chanter, danser, manger, jouer)' },
      { unitId: 'unit-2', topic: 'Preferences (préférer)' },
      { unitId: 'unit-3', topic: 'Verb: Avoir (to have)' },
      { unitId: 'unit-3', topic: 'Verb: Être (to be)' },
    ],
    estimatedDrift: 0.3, // 30% drift on compatible topics
  },
  'question_formation': {
    topics: [
      { unitId: 'unit-3', topic: 'Questions with est-ce que' },
      { unitId: 'introduction', topic: 'Basic Conversation Phrases' },
      { unitId: 'unit-2', topic: 'Tu vs. Vous' },
      { unitId: 'unit-2', topic: 'Classroom Expressions' },
    ],
    estimatedDrift: 0.35, // 35% drift on compatible topics
  },
  'open_ended': {
    topics: [], // All topics - accept drift
    estimatedDrift: 0.5, // 50% drift across all topics
  },
  'sentence_building': {
    topics: [], // All topics work reasonably well
    estimatedDrift: 0.2, // 20% drift
  },
  'translation': {
    topics: [], // All topics work well
    estimatedDrift: 0.1, // 10% drift
  },
};


// ============================================================================
// Types
// ============================================================================

interface GenerationStep {
  writingType: string;
  targetCount: number;
  currentCount: number;
  needed: number;
  topics: Array<{ unitId: string; topic: string }> | 'all';
  estimatedApiCalls: number;
  estimatedQuestions: number;
  estimatedCost: number;
  command: string;
}

interface GenerationPlan {
  steps: GenerationStep[];
  totalApiCalls: number;
  totalEstimatedQuestions: number;
  totalEstimatedCost: number;
}

interface CLIOptions {
  execute: boolean;
  analyzeOnly: boolean;
  targetWritingPercent: number;
}

// ============================================================================
// CLI Parsing
// ============================================================================

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = {
    execute: false,
    analyzeOnly: false,
    targetWritingPercent: TARGET_QUESTION_TYPE_DISTRIBUTION.writing,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--execute':
        options.execute = true;
        break;
      case '--analyze-only':
        options.analyzeOnly = true;
        break;
      case '--target-writing':
        options.targetWritingPercent = parseInt(args[++i], 10);
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`
Question Generation Planner

Analyzes current question distribution and creates an execution plan
to bring the database into alignment with target distribution.

Usage: npx tsx scripts/plan-generation.ts [options]

Options:
  --execute           Execute the generation plan (prompts for confirmation)
  --analyze-only      Only show distribution analysis, don't generate a plan
  --target-writing <n> Target percentage for writing questions (default: 27)
  --help, -h          Show this help message

Examples:
  npx tsx scripts/plan-generation.ts              # Show analysis and plan
  npx tsx scripts/plan-generation.ts --execute    # Execute the plan
  npx tsx scripts/plan-generation.ts --analyze-only
  `);
}

// ============================================================================
// Analysis
// ============================================================================

function printAnalysis(analysis: DistributionAnalysis): void {
  console.log('📊 Current Distribution Analysis\n');
  console.log(`Total questions: ${analysis.total}\n`);

  console.log('Question Types:');
  const types = ['multiple-choice', 'fill-in-blank', 'true-false', 'writing'];
  for (const type of types) {
    const count = analysis.byType[type] || 0;
    const percent = analysis.total > 0 ? ((count / analysis.total) * 100).toFixed(1) : '0.0';
    const target = TARGET_QUESTION_TYPE_DISTRIBUTION[type as keyof typeof TARGET_QUESTION_TYPE_DISTRIBUTION];
    const diff = parseFloat(percent) - target;
    const status = Math.abs(diff) <= 3 ? '✓' : (diff > 0 ? '⚠️  +' + diff.toFixed(1) : '⚠️  ' + diff.toFixed(1));
    console.log(`  ${type.padEnd(18)} ${String(count).padStart(4)} (${percent.padStart(5)}%) - Target: ${target}% ${status}`);
  }

  if (analysis.writingTotal > 0) {
    console.log('\nWriting Subtypes (of ' + analysis.writingTotal + ' writing):');
    const writingTypes = ['translation', 'sentence_building', 'conjugation', 'question_formation', 'open_ended'];
    for (const wt of writingTypes) {
      const count = analysis.byWritingType[wt] || 0;
      const percent = analysis.writingTotal > 0 ? ((count / analysis.writingTotal) * 100).toFixed(1) : '0.0';
      const target = TARGET_WRITING_TYPE_DISTRIBUTION[wt as keyof typeof TARGET_WRITING_TYPE_DISTRIBUTION];
      const diff = parseFloat(percent) - target;
      const status = Math.abs(diff) <= 3 ? '✓' : (diff > 0 ? '+' + diff.toFixed(1) + ' over' : 'need ~' + Math.ceil(Math.abs(diff * analysis.writingTotal / 100)));
      console.log(`  ${wt.padEnd(20)} ${String(count).padStart(3)} (${percent.padStart(5)}%) - Target: ${target}% ${status}`);
    }
  }
}

// ============================================================================
// Plan Generation
// ============================================================================

function generatePlan(analysis: DistributionAnalysis): GenerationPlan {
  const steps: GenerationStep[] = [];

  // Calculate how many writing questions of each type we need
  const writingTypes = ['question_formation', 'open_ended', 'sentence_building', 'conjugation'] as const;
  // Note: We skip 'translation' since it's usually over-represented

  for (const wt of writingTypes) {
    const currentCount = analysis.byWritingType[wt] || 0;
    const targetPercent = TARGET_WRITING_TYPE_DISTRIBUTION[wt];
    const targetCount = Math.ceil((targetPercent / 100) * analysis.writingTotal);
    const needed = targetCount - currentCount;

    if (needed <= 0) continue;

    const compatibility = TOPIC_COMPATIBILITY[wt];
    const useTargetedTopics = compatibility.topics.length > 0;
    const topics = useTargetedTopics ? compatibility.topics : 'all';

    // Estimate API calls and questions
    let estimatedApiCalls: number;
    let estimatedQuestions: number;

    if (useTargetedTopics) {
      // Targeted: 3 difficulties × number of topics × count per topic
      const countPerTopic = Math.ceil(needed / (compatibility.topics.length * 3 * (1 - compatibility.estimatedDrift)));
      estimatedApiCalls = compatibility.topics.length * 3; // 3 difficulties
      estimatedQuestions = Math.ceil(estimatedApiCalls * countPerTopic * (1 - compatibility.estimatedDrift));
    } else {
      // All topics: calculate based on total topics and expected drift
      const totalTopics = units.reduce((sum, u) => sum + u.topics.length, 0);
      const countPerTopic = Math.max(1, Math.ceil(needed / (totalTopics * 3 * (1 - compatibility.estimatedDrift))));
      estimatedApiCalls = totalTopics * 3;
      estimatedQuestions = Math.ceil(needed / (1 - compatibility.estimatedDrift) * (1 - compatibility.estimatedDrift));
    }

    const estimatedCost = estimatedApiCalls * COST_PER_API_CALL;

    // Build command
    let command = `npx tsx scripts/generate-questions.ts --type writing --writing-type ${wt}`;
    if (useTargetedTopics && compatibility.topics.length <= 2) {
      // For very few topics, generate more per topic
      command += ` --count ${Math.ceil(needed / (compatibility.topics.length * 3))}`;
    } else {
      command += ` --count 2`;
    }
    command += ` --write-db`;

    steps.push({
      writingType: wt,
      targetCount,
      currentCount,
      needed,
      topics,
      estimatedApiCalls,
      estimatedQuestions: Math.min(estimatedQuestions, needed + 5), // Cap at slightly more than needed
      estimatedCost,
      command,
    });
  }

  // Sort by most needed first
  steps.sort((a, b) => b.needed - a.needed);

  return {
    steps,
    totalApiCalls: steps.reduce((sum, s) => sum + s.estimatedApiCalls, 0),
    totalEstimatedQuestions: steps.reduce((sum, s) => sum + s.estimatedQuestions, 0),
    totalEstimatedCost: steps.reduce((sum, s) => sum + s.estimatedCost, 0),
  };
}

function printPlan(plan: GenerationPlan): void {
  if (plan.steps.length === 0) {
    console.log('\n✅ Distribution is already well-balanced! No generation needed.');
    return;
  }

  console.log('\n' + '='.repeat(70));
  console.log('📋 Proposed Generation Plan');
  console.log('='.repeat(70));

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    console.log(`\n${i + 1}. ${step.writingType}`);
    console.log(`   Current: ${step.currentCount} | Target: ${step.targetCount} | Need: ~${step.needed}`);

    if (step.topics === 'all') {
      console.log(`   Strategy: All topics (accept ~${Math.round(TOPIC_COMPATIBILITY[step.writingType].estimatedDrift * 100)}% drift)`);
    } else {
      console.log(`   Strategy: Targeted topics (${step.topics.length} compatible topics)`);
      step.topics.slice(0, 3).forEach(t => console.log(`     - ${t.topic}`));
      if (step.topics.length > 3) console.log(`     - ... and ${step.topics.length - 3} more`);
    }

    console.log(`   Est. API calls: ${step.estimatedApiCalls} | Est. questions: ~${step.estimatedQuestions} | Est. cost: $${step.estimatedCost.toFixed(2)}`);
    console.log(`   Command:`);
    console.log(`     ${step.command}`);
  }

  console.log('\n' + '-'.repeat(70));
  console.log(`Total: ~${plan.totalEstimatedQuestions} questions | ${plan.totalApiCalls} API calls | ~$${plan.totalEstimatedCost.toFixed(2)}`);
  console.log('-'.repeat(70));

  console.log('\nRun with --execute to proceed, or copy commands above to run manually.');
}

// ============================================================================
// Execution
// ============================================================================

async function promptConfirmation(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(message + ' (y/N): ', (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

async function executeStep(step: GenerationStep): Promise<boolean> {
  console.log(`\n🚀 Executing: ${step.writingType}`);
  console.log(`   ${step.command}\n`);

  return new Promise((resolve) => {
    const args = step.command.replace('npx tsx scripts/generate-questions.ts ', '').split(' ');
    const proc = spawn('npx', ['tsx', 'scripts/generate-questions.ts', ...args], {
      stdio: 'inherit',
      shell: true,
    });

    proc.on('close', (code) => {
      resolve(code === 0);
    });

    proc.on('error', (err) => {
      console.error(`   ❌ Error: ${err.message}`);
      resolve(false);
    });
  });
}

async function executePlan(plan: GenerationPlan): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log('🔄 Executing Generation Plan');
  console.log('='.repeat(70));

  const confirmed = await promptConfirmation(
    `\nThis will make ~${plan.totalApiCalls} API calls (~$${plan.totalEstimatedCost.toFixed(2)}). Proceed?`
  );

  if (!confirmed) {
    console.log('\n❌ Cancelled.');
    return;
  }

  let successCount = 0;
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    console.log(`\n[${ i + 1}/${plan.steps.length}] Generating ${step.writingType}...`);

    const success = await executeStep(step);
    if (success) {
      successCount++;
      console.log(`   ✅ Completed ${step.writingType}`);
    } else {
      console.log(`   ⚠️  ${step.writingType} may have had issues`);
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log(`✅ Plan execution complete! (${successCount}/${plan.steps.length} steps succeeded)`);
  console.log('   Run this script again to verify the new distribution.');
  console.log('='.repeat(70));
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const options = parseArgs();

  console.log('🔍 Fetching current question distribution...\n');

  try {
    const questions = await fetchAllQuestions(supabase);

    if (questions.length === 0) {
      console.log('⚠️  No questions found in database!');
      console.log('\nRun the full regeneration pipeline first:');
      console.log('  npx tsx scripts/regenerate.ts --all --write-db --audit');
      return;
    }

    const analysis = analyzeDistribution(questions);
    printAnalysis(analysis);

    if (options.analyzeOnly) {
      return;
    }

    const plan = generatePlan(analysis);
    printPlan(plan);

    if (options.execute && plan.steps.length > 0) {
      await executePlan(plan);
    }

  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

main();
