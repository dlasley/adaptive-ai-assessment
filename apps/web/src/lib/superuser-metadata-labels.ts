/**
 * Label formatting for the superuser-only metadata panels shown on
 * questions and their evaluations. Kept as pure functions so the display
 * text can be unit tested without mounting a component.
 */

import type { EvaluationResult } from '@/lib/evaluate-writing/types';

type EvaluationMetadata = NonNullable<EvaluationResult['metadata']>;
type EvaluationTier = EvaluationMetadata['evaluationTier'];
type MatchedAgainst = EvaluationMetadata['matchedAgainst'];

/** Display label for each evaluation tier, in tier order. */
export const EVALUATION_TIER_LABELS: Record<EvaluationTier, string> = {
  empty_check: '1 - Empty Check',
  exact_match: '2 - Exact Match',
  fuzzy_match: '3 - Fuzzy Match',
  noise_check: '3b - Noise Check',
  semantic: '4 - Semantic',
};

/** Falls back to the raw tier value for any tier not in the map. */
export function getEvaluationTierLabel(tier: string): string {
  return EVALUATION_TIER_LABELS[tier as EvaluationTier] ?? tier;
}

/** Display label for which answer an evaluation matched against. */
export function getMatchedAgainstLabel(
  matchedAgainst: string,
  variationIndex?: number
): string {
  if (matchedAgainst === 'primary_answer') return 'Primary Answer';
  if (matchedAgainst === 'acceptable_variation') {
    return `Variation #${(variationIndex ?? 0) + 1}`;
  }
  if (matchedAgainst === 'none') return 'None';
  return matchedAgainst;
}

/**
 * Formats a hyphenated question type ('multiple-choice', 'true-false') as
 * title case ('Multiple Choice', 'True False'). Used for the MCQ/true-false
 * family of questions, whose type strings are hyphenated words.
 */
export function formatQuestionTypeLabel(type: string): string {
  return type
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Formats a typed-answer question type ('writing', 'fill-in-blank') for
 * display. Kept distinct from formatQuestionTypeLabel because the typed-
 * answer family has always used its own casing ('Fill in Blank', lowercase
 * 'in') rather than title-casing every hyphen-separated word.
 */
export function formatTypedAnswerQuestionTypeLabel(type: 'writing' | 'fill-in-blank'): string {
  return type === 'fill-in-blank' ? 'Fill in Blank' : 'Writing';
}

export interface SuperuserMetadataField {
  label: string;
  value: string;
  fullWidth?: boolean;
  mono?: boolean;
  capitalize?: boolean;
}

/** Display label for how an answer matched what it was compared against. */
const MATCH_KIND_LABELS: Record<NonNullable<EvaluationMetadata['matchKind']>, string> = {
  exact: 'Exact',
  adjacent_swap: 'Adjacent Swap',
};

/** Falls back to the raw value for any match kind not in the map. */
export function getMatchKindLabel(matchKind: string): string {
  return MATCH_KIND_LABELS[matchKind as NonNullable<EvaluationMetadata['matchKind']>] ?? matchKind;
}

/**
 * The evaluation-metadata fields shared by every call site regardless of
 * question type: match kind and model confidence (each shown only when the
 * evaluation tier that produces it was used), the matched-against reason,
 * the model, and the evaluation reason.
 */
export function buildCommonEvaluationMetadataFields(
  metadata: EvaluationMetadata
): SuperuserMetadataField[] {
  const fields: SuperuserMetadataField[] = [];
  if (metadata.matchKind !== undefined) {
    fields.push({ label: 'Match Kind', value: getMatchKindLabel(metadata.matchKind) });
  }
  if (metadata.modelConfidence !== undefined) {
    fields.push({ label: 'Semantic Confidence', value: `${metadata.modelConfidence}%` });
  }
  fields.push({
    label: 'Matched Against',
    value: getMatchedAgainstLabel(metadata.matchedAgainst, metadata.matchedVariationIndex),
  });
  if (metadata.modelUsed) {
    fields.push({ label: 'Model', value: metadata.modelUsed, mono: true, fullWidth: true });
  }
  if (metadata.evaluationReason) {
    fields.push({ label: 'Evaluation Reason', value: metadata.evaluationReason, fullWidth: true });
  }
  return fields;
}
