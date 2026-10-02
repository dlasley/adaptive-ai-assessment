import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const schema = readFileSync(resolve(__dirname, '../../../supabase/schema.sql'), 'utf-8');

/**
 * Every `CREATE VIEW eval_...` or `CREATE OR REPLACE VIEW eval_...` statement's opening line, with
 * the view name captured. The `eval_*` tables are service-role only with row level security, so a
 * view over them must run with the caller's rights (`security_invoker`), never the definer's, or it
 * would expose the tables to any role that can select from the view.
 */
function evalViewHeaders(): Array<{ name: string; header: string }> {
  const pattern = /^CREATE (?:OR REPLACE )?VIEW (eval_[a-z_]+)([^\n]*)$/gm;
  const headers: Array<{ name: string; header: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(schema)) !== null) {
    headers.push({ name: match[1], header: match[2] });
  }
  return headers;
}

describe('eval_* views in supabase/schema.sql', () => {
  it('exist', () => {
    expect(evalViewHeaders().length).toBeGreaterThan(0);
  });

  it('every one declares security_invoker = true on its CREATE line', () => {
    const missing = evalViewHeaders()
      .filter(({ header }) => !/WITH \(security_invoker = true\)/.test(header))
      .map(({ name }) => name);
    expect(missing).toEqual([]);
  });

  it('every one carries a COMMENT ON VIEW statement', () => {
    const missing = evalViewHeaders()
      .filter(({ name }) => !schema.includes(`COMMENT ON VIEW ${name} IS '`))
      .map(({ name }) => name);
    expect(missing).toEqual([]);
  });
});
