/**
 * The `eval_experiments.status` a recorded decision moves its experiment to. Shared by the two
 * commands that write that column, `eval-compare --decide` and `eval-finding --decide`, so the
 * mapping from a decision to a status lives in one place rather than once per command.
 */

export type EvalDecision = 'adopt' | 'reject' | 'defer' | 'supersede';

export type EvalDecidedStatus = 'decided' | 'deferred' | 'superseded';

export function experimentStatusForDecision(decision: EvalDecision): EvalDecidedStatus {
  if (decision === 'defer') return 'deferred';
  if (decision === 'supersede') return 'superseded';
  return 'decided';
}
