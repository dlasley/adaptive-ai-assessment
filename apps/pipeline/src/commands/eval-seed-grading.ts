/**
 * Fills in a grading eval set's `submitted_answer` placeholders. `typo` and `missing_accent` are
 * computed deterministically from the correct answer; the other four label classes go through one
 * model call per question, asking for whichever of them are still empty. Everything written stays
 * `reference_status: 'pending'` — a reviewer approves (or corrects) each item in the Supabase table
 * editor before eval-run treats it as reference. A `typo`/`missing_accent` item whose correct answer has
 * no valid deterministic transform (every character identical; no accent to strip) is marked
 * `reference_status: 'rejected'` with a note instead, rather than seeding a degenerate item.
 *
 * Dry run by default: computes and prints the deterministic answers and the projected cost of the
 * model calls the set still needs, without calling a model or writing anything. --write-db is what
 * actually calls the model and persists both the deterministic and model-seeded answers.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { loadEnv } from '../lib/env';
import { createScriptSupabase } from '../lib/db-queries';
import { createSupabaseEvalStore, type EvalItemRow, type EvalStore } from '../lib/eval/db';
import { GRADING_LABEL_CLASSES, seededLabelClass, type GradingLabelClass } from '../lib/eval/set-builder';
import {
  computeDeterministicAnswer,
  MODEL_SEEDED_LABEL_CLASSES,
  parseSeedGradingResponse,
  renderSeedGradingPrompt,
  SeedGradingParseError,
} from '../lib/eval/grading-seed';
import { projectCostUsd, registryPriceOf } from '../lib/eval/tolerances';
import { callLlm } from '@adaptive/shared/llm';
import { renderCoursePrompt } from '@adaptive/shared/course';
import { defineCli } from '../lib/options/define-cli';
import { dbTargetFlags, loggingFlags } from '../lib/options/groups';
import { createLogger, levelFromFlags, setLogLevel } from '../lib/logger';
import { PROMPTS_DIR } from '../lib/paths';
import { runIfMain } from '../lib/run-if-main';

// One seed call covers every model-seeded label class still missing for a question at once, so
// cost is projected per question (not per label class). Rough, undated estimate of that one call's
// size — the seed prompt itself plus one short answer per requested label class.
const SEED_PROMPT_TOKENS_PER_CALL = 1200;
const SEED_COMPLETION_TOKENS_PER_CALL = 400;

const logger = createLogger('eval-seed-grading');

export const cli = defineCli(
  {
    ...dbTargetFlags,
    ...loggingFlags,
    set: { type: 'string', required: true, help: 'eval_sets id (grading task) to seed' },
    model: { type: 'string', required: true, help: 'Model slug used to write the four model-seeded label classes' },
  },
  {
    name: 'eval-seed-grading',
    description: "Fills a grading eval set's submitted_answer placeholders — deterministic for typo/missing_accent, model-written for the rest. Every item stays reference_status 'pending'. Dry run by default (plan and projected cost, no model call); --write-db calls the model and persists answers.",
    examples: [
      'npx tsx apps/pipeline/src/commands/eval-seed-grading.ts --set <id> --model anthropic/claude-sonnet-5 --write-db',
    ],
  },
);

type Options = ReturnType<typeof cli.parse>;

interface QuestionGroup {
  questionId: string;
  question: string;
  correctAnswer: string;
  type: string;
  difficulty: string;
  items: Map<GradingLabelClass, EvalItemRow>;
}

function groupByQuestion(items: EvalItemRow[]): QuestionGroup[] {
  const groups = new Map<string, QuestionGroup>();
  for (const item of items) {
    const p = item.payload;
    const questionId = String(p.question_id);
    let group = groups.get(questionId);
    if (!group) {
      group = {
        questionId,
        question: String(p.question),
        correctAnswer: String(p.correct_answer),
        type: String(p.type),
        difficulty: String(p.difficulty),
        items: new Map(),
      };
      groups.set(questionId, group);
    }
    group.items.set(seededLabelClass(item) as GradingLabelClass, item);
  }
  return [...groups.values()];
}

/**
 * `store` and `argv` are injection points for tests (a fake `EvalStore`) so the deterministic-answer
 * write path is testable without a live Supabase connection or a model call. Production use
 * (`runIfMain` below) supplies neither, so both default to the real thing.
 */
export async function main(deps: { argv?: string[]; store?: EvalStore } = {}) {
  loadEnv();
  const options: Options = cli.parse(deps.argv);
  setLogLevel(levelFromFlags(options));

  // eval_items is service-role only, read or write. Real Supabase access is skipped entirely when a
  // store is injected, so a test never needs live credentials or a network connection.
  const store = deps.store ?? createSupabaseEvalStore(createScriptSupabase({ write: true }));

  const set = await store.getSet(options.set);
  if (!set) {
    logger.error(`No eval set found with id ${options.set}`);
    process.exit(1);
  }
  if (set.task !== 'grading') {
    logger.error(`eval set ${options.set} is task '${set.task}', not 'grading'`);
    process.exit(1);
  }

  const allItems = await store.listItems(options.set);
  const pending = allItems.filter((i) => !i.payload.submitted_answer);
  console.log(`${pending.length} of ${allItems.length} items still need a submitted_answer.`);

  const groups = groupByQuestion(pending);
  console.log(`Grouped into ${groups.length} question(s).`);

  const rawTemplate = readFileSync(join(PROMPTS_DIR, 'eval-seed-grading.md'), 'utf-8');
  const systemPrompt = renderCoursePrompt(rawTemplate);

  let filled = 0;
  let rejected = 0;
  let parseFailures = 0;
  let groupsNeedingModel = 0;
  const pendingByLabelClass = new Map<GradingLabelClass, number>();
  const deterministicPreview: string[] = [];

  for (const group of groups) {
    const updates = new Map<string, string>(); // item id -> submitted_answer
    const rejections = new Map<string, string>(); // item id -> reason no valid deterministic answer exists

    for (const labelClass of GRADING_LABEL_CLASSES) {
      const item = group.items.get(labelClass);
      if (!item || item.payload.submitted_answer) continue;
      pendingByLabelClass.set(labelClass, (pendingByLabelClass.get(labelClass) ?? 0) + 1);

      const result = computeDeterministicAnswer(labelClass, group.correctAnswer);
      if (result.kind === 'answer') {
        updates.set(item.id, result.value);
        deterministicPreview.push(`    ${group.questionId} ${labelClass}: '${result.value}'`);
      } else if (result.kind === 'rejected') {
        rejections.set(item.id, result.reason);
        logger.warn(`Question ${group.questionId}: ${labelClass} rejected (${result.reason}).`);
      }
    }

    const modelLabelClasses = MODEL_SEEDED_LABEL_CLASSES.filter((c) => {
      const item = group.items.get(c);
      return item && !item.payload.submitted_answer;
    });
    if (modelLabelClasses.length > 0) groupsNeedingModel++;

    if (options.writeDb && modelLabelClasses.length > 0) {
      const prompt = renderSeedGradingPrompt(systemPrompt, {
        questionType: group.type,
        difficulty: group.difficulty,
        question: group.question,
        correctAnswer: group.correctAnswer,
        labelClasses: modelLabelClasses,
      });

      try {
        const result = await callLlm({
          model: options.model,
          jsonMode: true,
          temperature: 0.7,
          messages: [{ role: 'user', content: prompt }],
        });
        const answers = parseSeedGradingResponse(result.text, modelLabelClasses);
        for (const labelClass of modelLabelClasses) {
          const item = group.items.get(labelClass)!;
          updates.set(item.id, answers[labelClass]);
        }
      } catch (err) {
        parseFailures++;
        const message = err instanceof SeedGradingParseError ? err.message : String(err);
        logger.error(`Question ${group.questionId}: seed call failed (${message}) — leaving its model-seeded items empty for a re-run.`);
      }
    }

    if (!options.writeDb) continue;

    for (const [itemId, submittedAnswer] of updates) {
      const item = allItems.find((i) => i.id === itemId)!;
      try {
        await store.updateItem(itemId, { payload: { ...item.payload, submitted_answer: submittedAnswer } });
        filled++;
      } catch (err) {
        logger.error(`Failed to write submitted_answer for item ${itemId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    for (const [itemId, reason] of rejections) {
      try {
        await store.updateItem(itemId, { reference_status: 'rejected', notes: reason });
        rejected++;
      } catch (err) {
        logger.error(`Failed to reject item ${itemId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (!options.writeDb) {
    console.log('\nPlan (dry run — no model call made):');
    console.log('  Pending items by label class:');
    for (const labelClass of GRADING_LABEL_CLASSES) {
      const count = pendingByLabelClass.get(labelClass) ?? 0;
      if (count > 0) console.log(`    ${labelClass}: ${count}`);
    }
    if (deterministicPreview.length > 0) {
      console.log('\n  Deterministic answers that would be written:');
      for (const line of deterministicPreview) console.log(line);
    }
    if (groupsNeedingModel > 0) {
      const registryRow = await store.getModelBySlug(options.model).catch(() => null);
      const projected = projectCostUsd(registryPriceOf(registryRow ?? undefined), groupsNeedingModel, SEED_PROMPT_TOKENS_PER_CALL, SEED_COMPLETION_TOKENS_PER_CALL);
      const projectedLabel = projected !== undefined ? `$${projected.toFixed(4)}` : 'unknown (unpriced model)';
      console.log(`\n  Model calls needed: ${groupsNeedingModel} question(s), projected cost ${projectedLabel}.`);
    }
    console.log('\nDry run — pass --write-db to call the model and persist answers.');
    return;
  }

  console.log(`\nFilled ${filled} item(s), rejected ${rejected} item(s) with no valid deterministic answer. ${parseFailures} question(s) had a seed-call failure and were left empty.`);
  console.log("Every item is still reference_status 'pending' — review and approve each one in the Supabase table editor before eval-run treats it as reference.");
}

runIfMain(import.meta.url, main);
