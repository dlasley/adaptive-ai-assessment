import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// packages/shared is imported by both the Next.js app and the Expo app, so every shared module
// the Expo app can reach must load in React Native: it may import only relative paths inside
// packages/shared/src, zod, and other shared subpaths, and it may not touch `process` while the
// module is being evaluated. llm.ts and grading-prompt.ts are server-only: they are exempt from
// those rules, only each other may import them inside the package, and the Expo app must never
// import them, nor any module of the web app. Sources are parsed with the TypeScript compiler, so
// an import split across lines or a dynamic import is caught the same as a one-line static import.

const repoRoot = path.resolve(__dirname, '..');
const sharedSrc = path.join(repoRoot, 'packages/shared/src');
const mobileRoot = path.join(repoRoot, 'apps/mobile');
const webRoot = path.join(repoRoot, 'apps/web');

const SERVER_ONLY_SHARED = ['llm.ts', 'grading-prompt.ts'];

/** Generated or native output under apps/mobile; the same paths .gitignore and ESLint skip. */
const MOBILE_SKIPPED_DIRS = new Set(['node_modules', '.expo', 'ios', 'android', 'dist']);
const MOBILE_SKIPPED_FILES = new Set(['expo-env.d.ts']);

function sourceFiles(dir: string, skipDirs: Set<string> = new Set(), skipFiles: Set<string> = new Set()): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return skipDirs.has(entry.name) ? [] : sourceFiles(full, skipDirs, skipFiles);
    return /\.tsx?$/.test(entry.name) && !skipFiles.has(entry.name) ? [full] : [];
  });
}

function parse(source: string, fileName = 'module.ts'): ts.SourceFile {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
}

/** Every module specifier: static imports and re-exports, `import x = require()`, `import()` and `require()`. */
function importSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const [first] = node.arguments;
      if ((isImport || isRequire) && first && ts.isStringLiteralLike(first)) specifiers.push(first.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

/** A function whose body runs when it is defined: `(() => ...)()` or `(function () {...})()`. */
function isImmediatelyInvoked(node: ts.Node): boolean {
  let current = node;
  while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
  return ts.isCallExpression(current.parent) && current.parent.expression === current;
}

/** An identifier in a position that names a property rather than referring to a variable. */
function isPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
  if (ts.isBindingElement(parent)) return parent.propertyName === node;
  if (
    ts.isPropertyAssignment(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isGetAccessorDeclaration(parent) ||
    ts.isSetAccessorDeclaration(parent)
  ) {
    return parent.name === node;
  }
  return ts.isQualifiedName(parent) && parent.right === node;
}

/**
 * Line numbers of `process` references that run when the module is evaluated: anywhere outside a
 * function body, including inside an immediately invoked function and in destructuring.
 */
function topLevelProcessReferences(sourceFile: ts.SourceFile): number[] {
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node) && !isImmediatelyInvoked(node)) return;
    if (ts.isIdentifier(node) && node.text === 'process' && !isPropertyName(node)) {
      lines.push(sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return lines;
}

/** True when a specifier's last path segment names a server-only module, with or without extension. */
function namesServerOnlyModule(specifier: string): boolean {
  const last = specifier.split('/').at(-1) ?? '';
  return SERVER_ONLY_SHARED.some((file) => last === file || last === file.replace(/\.ts$/, ''));
}

function isUnder(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Why `importer` (a path relative to packages/shared/src) may not import `specifier`, or null. */
function sharedImportViolation(specifier: string, importer: string): string | null {
  const importerIsServerOnly = SERVER_ONLY_SHARED.includes(importer);

  if (specifier.startsWith('.')) {
    const resolved = path.resolve(sharedSrc, path.dirname(importer), specifier);
    if (!isUnder(sharedSrc, resolved)) return 'relative path leaves packages/shared/src';
    if (!importerIsServerOnly && namesServerOnlyModule(resolved)) return 'server-only shared module';
    return null;
  }
  if (importerIsServerOnly) return null;
  if (specifier.startsWith('@adaptive/shared/')) {
    return namesServerOnlyModule(specifier) ? 'server-only shared module' : null;
  }
  if (specifier === 'zod') return null;
  return 'not a relative path, zod, or a shared subpath';
}

/** Why a file under apps/mobile may not import `specifier`, or null when it may. */
function mobileImportViolation(specifier: string, fromFile: string): string | null {
  if (specifier === '@adaptive/web' || specifier.startsWith('@adaptive/web/')) return 'web-app module';
  if (specifier.startsWith('@adaptive/shared/') && namesServerOnlyModule(specifier)) {
    return 'server-only shared module';
  }
  if (specifier.startsWith('.')) {
    const resolved = path.resolve(path.dirname(fromFile), specifier);
    if (isUnder(webRoot, resolved)) return 'web-app module';
    if (isUnder(sharedSrc, resolved) && namesServerOnlyModule(resolved)) return 'server-only shared module';
  }
  return null;
}

describe('shared package import boundary', () => {
  const sharedFiles = sourceFiles(sharedSrc).map((file) => ({
    relative: path.relative(sharedSrc, file).split(path.sep).join('/'),
    sourceFile: parse(readFileSync(file, 'utf-8'), file),
  }));

  it('finds the shared sources, including both server-only modules', () => {
    expect(sharedFiles.length).toBeGreaterThan(SERVER_ONLY_SHARED.length + 3);
    for (const file of SERVER_ONLY_SHARED) expect(existsSync(path.join(sharedSrc, file))).toBe(true);
  });

  it('keeps every shared import inside the rules', () => {
    const offenders = sharedFiles.flatMap((f) =>
      importSpecifiers(f.sourceFile).flatMap((spec) => {
        const violation = sharedImportViolation(spec, f.relative);
        return violation ? [`${f.relative}: ${spec} (${violation})`] : [];
      }),
    );
    expect(offenders).toEqual([]);
  });

  it('references process only inside functions outside the server-only modules', () => {
    const offenders = sharedFiles
      .filter((f) => !SERVER_ONLY_SHARED.includes(f.relative))
      .flatMap((f) => topLevelProcessReferences(f.sourceFile).map((line) => `${f.relative}:${line}`));
    expect(offenders).toEqual([]);
  });

  describe('apps/mobile', () => {
    const mobileFiles = sourceFiles(mobileRoot, MOBILE_SKIPPED_DIRS, MOBILE_SKIPPED_FILES).map((file) => ({
      file,
      relative: path.relative(mobileRoot, file).split(path.sep).join('/'),
      sourceFile: parse(readFileSync(file, 'utf-8'), file),
    }));

    it('finds the app sources', () => {
      expect(mobileFiles.map((f) => f.relative)).toContain('src/config.ts');
    });

    it('never imports a server-only shared module or a web-app module', () => {
      const offenders = mobileFiles.flatMap((f) =>
        importSpecifiers(f.sourceFile).flatMap((spec) => {
          const violation = mobileImportViolation(spec, f.file);
          return violation ? [`${f.relative}: ${spec} (${violation})`] : [];
        }),
      );
      expect(offenders).toEqual([]);
    });
  });

  describe('detection', () => {
    const violations = (source: string, importer = 'enums.ts') =>
      importSpecifiers(parse(source)).map((spec) => sharedImportViolation(spec, importer));

    it('catches Node builtins, with and without the node: prefix', () => {
      expect(violations("import { readFileSync } from 'node:fs';")).toEqual(['not a relative path, zod, or a shared subpath']);
      expect(violations("import path from 'path';")).not.toEqual([null]);
      expect(violations("import { createHash } from\n  'crypto';")).not.toEqual([null]);
    });

    it('catches Next.js, react-dom and server-only, in every import form', () => {
      for (const source of [
        "import { NextResponse } from 'next/server';",
        "import type { Metadata } from 'next';",
        "import 'server-only';",
        "export { createPortal } from 'react-dom';",
        "const fs = await import('node:fs');",
        "const fs = require('fs');",
      ]) {
        expect(violations(source), source).toEqual(['not a relative path, zod, or a shared subpath']);
      }
    });

    it('allows relative, zod and shared-subpath imports', () => {
      expect(
        violations(
          "import type { Difficulty } from './enums';\nimport { z } from 'zod';\nimport { DIFFICULTIES } from '@adaptive/shared/enums';",
          'types.ts',
        ),
      ).toEqual([null, null, null]);
    });

    it('catches a non-exempt module importing a server-only module, and lets grading-prompt import ./llm', () => {
      expect(violations("import { callLlm } from './llm';", 'types.ts')).toEqual(['server-only shared module']);
      expect(violations("import { x } from './grading-prompt.ts';", 'course.ts')).toEqual(['server-only shared module']);
      expect(violations("import { x } from '@adaptive/shared/llm';", 'course.ts')).toEqual(['server-only shared module']);
      expect(violations("import type { LlmMessage } from './llm';", 'grading-prompt.ts')).toEqual([null]);
      expect(violations("import { createHash } from 'node:crypto';", 'grading-prompt.ts')).toEqual([null]);
    });

    it('catches a relative path that leaves packages/shared/src, from any module', () => {
      expect(violations("import { x } from '../../../apps/web/src/lib/csrf';")).toEqual([
        'relative path leaves packages/shared/src',
      ]);
      expect(violations("import { x } from '../../../apps/web/src/lib/csrf';", 'llm.ts')).toEqual([
        'relative path leaves packages/shared/src',
      ]);
    });

    it('catches a top-level process reference, including IIFEs and destructuring', () => {
      const lines = (source: string) => topLevelProcessReferences(parse(source));
      expect(lines('export const key = process.env.OPENROUTER_API_KEY;')).toEqual([1]);
      expect(lines("const env = process['env'];")).toEqual([1]);
      expect(lines("const flags = {\n  on: process.env.FLAG === 'true',\n};")).toEqual([2]);
      expect(lines('const { env } = process;')).toEqual([1]);
      expect(lines('const key = (() => process.env.KEY)();')).toEqual([1]);
      expect(lines('const key = (function () {\n  return process.env.KEY;\n})();')).toEqual([2]);
      expect(
        lines(
          'function read() { return process.env.COURSE_NAME; }\nconst lazy = () => process.env.X;\nclass C { get v() { return process.env.Y; } }\nconst o = { process: 1 };\no.process;',
        ),
      ).toEqual([]);
    });

    it('catches the app importing a server-only shared module or the web app', () => {
      const from = path.join(mobileRoot, 'src/api/client.ts');
      expect(mobileImportViolation('@adaptive/shared/llm', from)).toBe('server-only shared module');
      expect(mobileImportViolation('@adaptive/shared/grading-prompt', from)).toBe('server-only shared module');
      expect(mobileImportViolation('@adaptive/shared/src/llm', from)).toBe('server-only shared module');
      expect(mobileImportViolation('@adaptive/shared/src/grading-prompt.ts', from)).toBe('server-only shared module');
      expect(mobileImportViolation('../../../../packages/shared/src/llm', from)).toBe('server-only shared module');
      expect(mobileImportViolation('../../../web/src/lib/csrf', from)).toBe('web-app module');
      expect(mobileImportViolation('../../../../apps/web/src/lib/csrf', from)).toBe('web-app module');
      expect(mobileImportViolation('@adaptive/web/src/lib/leitner', from)).toBe('web-app module');
      expect(mobileImportViolation('@adaptive/shared/enums', from)).toBeNull();
      expect(mobileImportViolation('../config', from)).toBeNull();
      expect(mobileImportViolation('react-native', from)).toBeNull();
    });
  });
});
