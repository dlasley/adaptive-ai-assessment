/**
 * The pure logic behind `eval-judge`'s position-swapped comparison: the judge prompt and its hash,
 * the verdict shape and its parser, and the per-call message content builder. No Supabase or LLM
 * calls here — `eval-judge.ts` owns the run loop, item pairing, and the write path.
 */

import fs from 'fs';
import path from 'path';
import { renderCoursePrompt } from '@adaptive/shared/course';
import type { LlmContentPart } from '@adaptive/shared/llm';
import { hashText } from './tasks/shared';
import { PROMPTS_DIR } from '../paths';

export const JUDGE_PROMPT = renderCoursePrompt(
  fs.readFileSync(path.join(PROMPTS_DIR, 'eval-judge-transcription.md'), 'utf-8'),
);
/** sha256 (16 hex) of the rendered judge prompt, stamped onto both judged runs as judge_prompt_hash. */
export const JUDGE_PROMPT_HASH = hashText(JUDGE_PROMPT);

export type JudgeWinner = 'A' | 'B' | 'tie';

export interface JudgeVerdict {
  winner: JudgeWinner;
  reason: string;
}

export class JudgeParseError extends Error {}

function validateJudgeVerdictShape(parsed: unknown): asserts parsed is JudgeVerdict {
  const p = parsed as Partial<JudgeVerdict> | null;
  if (!p || (p.winner !== 'A' && p.winner !== 'B' && p.winner !== 'tie') || typeof p.reason !== 'string' || p.reason.trim() === '') {
    throw new JudgeParseError('judge response missing a valid winner/reason');
  }
}

/** Strips markdown code fences (the prompt asks for none, but a model sometimes adds them anyway),
 * parses JSON, and validates the shape a caller depends on. Mirrors
 * `@adaptive/shared/grading-prompt`'s `parseEvaluationResponse`. */
export function parseJudgeVerdict(text: string): JudgeVerdict {
  const cleaned = text.trim().replace(/^```json?\n?/, '').replace(/\n?```$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new JudgeParseError('judge response was not valid JSON');
  }
  validateJudgeVerdictShape(parsed);
  return parsed;
}

export type ItemOutcome = 'a' | 'b' | 'tie';

/**
 * Combines the two position-swapped judge calls for one item into a single outcome. `order1` judged
 * run A in the A slot and run B in the B slot; `order2` swapped them, so a "B" verdict in `order2`
 * means run A won that call. A run wins the item only when it wins in both orders — a split decision,
 * or either order coming back a tie, is a tie. This cancels a judge's position bias: a judge that
 * always preferred whichever transcript came first would win run A once and run B once, which this
 * combines to a tie rather than crediting either run.
 */
export function combineJudgeOrders(order1: JudgeVerdict, order2: JudgeVerdict): ItemOutcome {
  const aWinsOrder1 = order1.winner === 'A';
  const bWinsOrder1 = order1.winner === 'B';
  const aWinsOrder2 = order2.winner === 'B';
  const bWinsOrder2 = order2.winner === 'A';
  if (aWinsOrder1 && aWinsOrder2) return 'a';
  if (bWinsOrder1 && bWinsOrder2) return 'b';
  return 'tie';
}

/** The exact per-call message content: the judge prompt plus a text-layer hint, the two transcripts
 * under comparison, and the rendered slide image. */
export function buildJudgeMessageContent(slideText: string, transcriptA: string, transcriptB: string, imageBytes: Buffer): LlmContentPart[] {
  const hint = slideText.trim().length > 0
    ? `\n\nText layer extracted from this slide by a PDF text extractor (may be incomplete or out of order — use it as a hint only):\n\n${slideText}`
    : '\n\nNo text layer was extracted from this slide (likely image-only).';
  const body = `${JUDGE_PROMPT}${hint}\n\n## Transcript A\n\n${transcriptA}\n\n## Transcript B\n\n${transcriptB}`;
  return [
    { type: 'text', text: body },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBytes.toString('base64')}` } },
  ];
}
