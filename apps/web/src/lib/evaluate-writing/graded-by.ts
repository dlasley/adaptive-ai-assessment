import type { GradedBy } from '@adaptive/shared/enums';
import type { EvaluationResult, EvaluationTierName } from './types';

/** How an answer matched, as the fuzzy tier reports it. */
type MatchDescription = Pick<NonNullable<EvaluationResult['_matchInfo']>, 'matchedAgainst' | 'matchKind'>;

/**
 * The `graded_by` value for a tier's result. A fuzzy-tier match that is not described counts as a
 * swap: that tier accepts exact and single-swap matches only, and an exact one always describes
 * itself.
 */
export function gradedByForTier(tier: EvaluationTierName, match?: MatchDescription): GradedBy {
  switch (tier) {
    case 'empty_check':
      return 'empty';
    case 'exact_match':
      return 'exact';
    case 'noise_check':
      return 'noise';
    case 'semantic':
      return 'semantic';
    case 'fuzzy_match': {
      const againstVariation = match?.matchedAgainst === 'acceptable_variation';
      if (match?.matchKind === 'exact') return againstVariation ? 'variation' : 'exact';
      return againstVariation ? 'variation_swap' : 'swap';
    }
  }
}
