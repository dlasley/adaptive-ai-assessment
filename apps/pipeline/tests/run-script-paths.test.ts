/**
 * Statically finds every `runScript()`/`runScriptAsync()` call across the pipeline source tree
 * and asserts its `command` argument resolves to a file that actually exists under `COMMANDS_DIR`
 * — both functions join `command` onto `COMMANDS_DIR` themselves (`lib/script-runner.ts`), so a
 * caller passing an `apps/pipeline/`-prefixed path (a leftover from before the src/ move) silently
 * resolves to a nonexistent nested path and the child step does nothing, with no error unless the
 * caller happens to check `.success` (see the code review this test was written for).
 *
 * The `command` argument isn't always a string literal — `pipeline-steps.ts`'s `stepAuditQuestions`
 * assigns it to a local `const` before passing it — so this walks the TypeScript AST rather than
 * grepping for quoted `.ts` filenames, resolving a local `const` binding (and, for any call that
 * picks between two literals with a ternary, both branches) back to its possible string values.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { COMMANDS_DIR, PIPELINE_ROOT } from '../src/lib/paths';

interface RunScriptCall {
  file: string;
  line: number;
  calleeName: string;
  values: string[];
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

/** Resolves an expression to every string value it could statically be: a literal, a ternary of
 * two literals, or a local `const` identifier bound to either of those (one level of indirection —
 * enough for this codebase's one dynamic case, `pipeline-steps.ts`'s `auditScript`). Returns `null`
 * if the expression isn't one of those recognized shapes. */
function resolveStringValues(node: ts.Expression, source: ts.SourceFile): string[] | null {
  if (ts.isStringLiteralLike(node)) return [node.text];

  if (ts.isConditionalExpression(node)) {
    const whenTrue = resolveStringValues(node.whenTrue, source);
    const whenFalse = resolveStringValues(node.whenFalse, source);
    if (!whenTrue || !whenFalse) return null;
    return [...whenTrue, ...whenFalse];
  }

  if (ts.isIdentifier(node)) {
    let found: string[] | null = null;
    const visit = (n: ts.Node) => {
      if (found) return;
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === node.text &&
        n.initializer
      ) {
        found = resolveStringValues(n.initializer, source);
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(source);
    return found;
  }

  return null;
}

function findRunScriptCalls(filePath: string): RunScriptCall[] {
  const text = fs.readFileSync(filePath, 'utf-8');
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const calls: RunScriptCall[] = [];

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === 'runScript' || node.expression.text === 'runScriptAsync')
    ) {
      const [commandArg] = node.arguments;
      const values = commandArg ? resolveStringValues(commandArg, source) : null;
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      calls.push({
        file: path.relative(PIPELINE_ROOT, filePath),
        line: line + 1,
        calleeName: node.expression.text,
        values: values ?? [`<unresolved: ${commandArg?.getText(source) ?? '(none)'}>`],
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

const allCalls = [
  ...listSourceFiles(path.join(PIPELINE_ROOT, 'src', 'commands')),
  ...listSourceFiles(path.join(PIPELINE_ROOT, 'src', 'lib')),
].flatMap(findRunScriptCalls);

describe('runScript()/runScriptAsync() command arguments', () => {
  it('found at least one call site (sanity check for the scanner itself)', () => {
    expect(allCalls.length).toBeGreaterThan(0);
  });

  it('never resolves to an unrecognized expression shape (a literal, a two-literal ternary, or a const bound to either)', () => {
    const unresolved = allCalls.filter((call) => call.values.some((v) => v.startsWith('<unresolved:')));
    expect(unresolved).toEqual([]);
  });

  describe.each(allCalls.map((call) => [`${call.file}:${call.line} ${call.calleeName}(${call.values.join(' | ')})`, call] as const))(
    '%s',
    (_label, call) => {
      it.each(call.values)('%s exists under COMMANDS_DIR', (value) => {
        expect(value.startsWith('apps/pipeline/')).toBe(false);
        const resolved = path.join(COMMANDS_DIR, value);
        expect(fs.existsSync(resolved)).toBe(true);
      });
    },
  );
});
