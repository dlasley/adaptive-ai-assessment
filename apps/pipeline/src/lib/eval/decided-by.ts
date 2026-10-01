/**
 * Resolves who an `eval_findings` write is attributed to: the explicit `--decided-by` flag if
 * given, otherwise the `EVAL_DECIDED_BY` environment variable, otherwise undefined. Shared by
 * `eval-compare`'s `--decide` path and `eval-finding`, so both commands refuse the same way when
 * neither source names anyone rather than falling back to a literal placeholder.
 */
export function resolveDecidedBy(flag: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  const trimmedFlag = flag?.trim();
  if (trimmedFlag) return trimmedFlag;
  const trimmedEnv = env.EVAL_DECIDED_BY?.trim();
  return trimmedEnv || undefined;
}
