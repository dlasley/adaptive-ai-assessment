/**
 * Strips a caught Supabase/PostgREST error (or any other caught value) down to fields safe to pass
 * to `logger.error`. `logger.error` is never level-gated by environment, so whatever it's given
 * reaches production logs unconditionally — this is the one place that discipline is enforced,
 * rather than reasoning about it at every call site.
 *
 * Postgres's own error text can embed literal row values: a unique/foreign-key/check-violation
 * error's `details` field reads `Key (col)=(value) already exists.` or `Failing row contains
 * (<every column value>)`, and an invalid-input-syntax error's `message` itself reads `invalid
 * input syntax for type integer: "<value>"`. Either can carry a student's free-text answer for a
 * table with a free-text column (e.g. `question_results.user_answer`).
 *
 * `details` is never returned, for any error shape. `message` is returned only for database error
 * codes verified not to embed row values in Postgres's own message text; other database errors get
 * `code` alone, and non-database errors their `name` alone. `hint` is Postgres's own suggested-fix
 * wording, never row-derived, so it is always safe to include when present.
 */

const MESSAGE_SAFE_CODES = new Set([
  '23502', // not_null_violation — message names the column, not its value
  '23503', // foreign_key_violation — message names the constraint, not the value
  '23505', // unique_violation — message names the constraint, not the value
  '23514', // check_violation — message names the constraint, not the value
  'PGRST116', // PostgREST: no rows found for a .single()/.maybeSingle() call
  'PGRST204', // PostgREST: no content
]);

export interface SafeErrorFields {
  code?: string;
  message?: string;
  hint?: string;
  name?: string;
  // Lets this satisfy logger.error's `Record<string, unknown>` data parameter without a spread at
  // every call site.
  [key: string]: unknown;
}

/**
 * Returns `{ code, message?, hint? }` for a Supabase/PostgREST-shaped error (anything with a
 * string `code` property), `{ name }` for any other `Error`, or `{}` for anything else (including
 * `null`/`undefined`). A non-database error's message is never returned: parse errors quote the
 * text they failed on (`JSON.parse` on a request body or a model reply that may repeat a student's
 * answer), and validation errors can quote the rejected value.
 */
export function supabaseErrorFields(error: unknown): SafeErrorFields {
  if (error && typeof error === 'object') {
    const code = 'code' in error ? (error as { code?: unknown }).code : undefined;
    if (typeof code === 'string') {
      const fields: SafeErrorFields = { code };

      if (MESSAGE_SAFE_CODES.has(code)) {
        const message = (error as { message?: unknown }).message;
        if (typeof message === 'string') fields.message = message;
      }

      const hint = (error as { hint?: unknown }).hint;
      if (typeof hint === 'string' && hint.length > 0) fields.hint = hint;

      return fields;
    }
  }

  if (error instanceof Error) {
    return { name: error.name };
  }

  return {};
}

/** True for PostgREST's "no rows" error from `.single()`: the lookup worked and found nothing. Any
 * other error means the database could not answer, which is not the same as "not found". */
export function isNoRowsError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'PGRST116';
}
