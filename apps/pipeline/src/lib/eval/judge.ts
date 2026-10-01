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

/** The sampling settings an `eval-judge` call actually sent, recorded on every entry. */
export interface JudgeCallSettings {
  /** The provider the call was pinned to (single upstream, fallbacks off), or null when unpinned. */
  provider_pin: string | null;
  reasoning: { enabled: false };
  /** Null means the call set no temperature and the host's default applied. */
  temperature: null;
}

/** One judge call's response facts: what `responseMetaFromLlmResult` keeps, plus the host and
 * model OpenRouter reports having served the call. Never message content. */
export type JudgeCallMeta = Record<string, unknown>;

/** One judging of one pairing under one judge prompt, stored in the list under its hash inside
 * `eval_results.judge_verdict` ({ [otherRunId]: { [judgePromptHash]: JudgeVerdictEntry[] } }). `judge_call` and
 * `calls` are absent on entries written before the call settings were recorded. */
export interface JudgeVerdictEntry {
  outcome: 'win' | 'loss' | 'tie';
  judge_model: string;
  /** 0-based: how many entries with the same judge model were already in the list when this one was written. */
  repeat: number;
  reasons: string[];
  judged_at: string;
  judge_call?: JudgeCallSettings;
  /** The two judge calls behind the outcome, one per position order. */
  calls?: JudgeCallMeta[];
}

/** The repeat index the next entry from `judgeModel` takes in a list of existing entries. */
export function nextJudgeRepeat(existing: readonly JudgeVerdictEntry[] | undefined, judgeModel: string): number {
  return (existing ?? []).filter((entry) => entry.judge_model === judgeModel).length;
}

/**
 * Picks the entries for one pairing out of the hash-keyed object stored for it, preferring the
 * list under `runJudgePromptHash` (the reading run's own `judge_prompt_hash`) when one exists, and
 * otherwise the list whose newest entry has the latest `judged_at`: the fallback for a pairing
 * judged only under a prompt other than the run's current one. Returns the hash actually used with
 * every entry under it, so a reader can compare repeats and judge models. Lists for the same pair and
 * hash can differ in length across items when a run failed on some of them, so a reader comparing
 * repeats must pair entries by `repeat` and `judge_model`, not by position. No call site reads
 * `judge_verdict` back today (`eval-judge.ts` only ever writes it); this exists for the first one
 * that does, and is exercised directly by its own tests.
 */
export function selectJudgeVerdictEntry(
  verdictsByHash: Record<string, JudgeVerdictEntry[]> | null | undefined,
  runJudgePromptHash: string | null | undefined,
): { hash: string; entries: JudgeVerdictEntry[] } | undefined {
  if (!verdictsByHash) return undefined;
  const lists = Object.entries(verdictsByHash).filter(([, entries]) => entries.length > 0);
  if (lists.length === 0) return undefined;
  if (runJudgePromptHash) {
    const own = lists.find(([hash]) => hash === runJudgePromptHash);
    if (own) return { hash: own[0], entries: own[1] };
  }
  const newestAt = (entries: JudgeVerdictEntry[]) => Math.max(...entries.map((e) => new Date(e.judged_at).getTime()));
  const [newestHash, newestEntries] = lists.reduce((latest, current) => (newestAt(current[1]) > newestAt(latest[1]) ? current : latest));
  return { hash: newestHash, entries: newestEntries };
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
