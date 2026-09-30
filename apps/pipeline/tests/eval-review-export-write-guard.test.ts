/**
 * Proof that `eval-review-export.ts`'s `main()` calls `guardTrackedTreeWrite` before touching the
 * store — not just that the helper itself refuses the right paths (`eval-paths.test.ts`) or that the
 * source text calls it before any write (`eval-write-guard-call-sites.test.ts`). Runs `main()`
 * in-process against a fake `EvalStore` whose every method throws, so any store access other than
 * the guard's own refusal would surface as a different, unexpected error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { main } from '../src/commands/eval-review-export';
import type { EvalStore } from '../src/lib/eval/db';
import { REPO_ROOT } from '../src/lib/paths';
import { baseFakeEvalStore } from './helpers/eval-store';

class ProcessExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

/** Wraps `baseFakeEvalStore()` so a test can prove the guard fires before any store method is even
 * touched, not just that the untouched methods would have thrown. */
function trackedFakeStore(): { store: EvalStore; wasTouched: () => boolean } {
  const base = baseFakeEvalStore();
  let touched = false;
  const store = new Proxy(base, {
    get(target, prop, receiver) {
      touched = true;
      return Reflect.get(target, prop, receiver);
    },
  });
  return { store, wasTouched: () => touched };
}

describe('eval-review-export main() — write-guard call site', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0);
    }) as unknown as typeof process.exit);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses an --out resolving inside the tracked apps/pipeline package, before any store access', async () => {
    const insideTracked = path.join(REPO_ROOT, 'apps', 'pipeline', 'reports', 'guard-test.xlsx');
    const { store, wasTouched } = trackedFakeStore();

    await expect(
      main({ argv: ['--set', 'fake-set-id', '--out', insideTracked], store }),
    ).rejects.toThrow(ProcessExitError);

    const errorText = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((args) => args.join(' '))
      .join('\n');
    expect(errorText).toContain('Refusing to write');
    expect(wasTouched()).toBe(false);
  });

  it('refuses the same relative path resolved against the repo root', async () => {
    const { store, wasTouched } = trackedFakeStore();

    await expect(
      main({ argv: ['--set', 'fake-set-id', '--out', 'apps/pipeline/reports/guard-test.xlsx'], store }),
    ).rejects.toThrow(ProcessExitError);

    const errorText = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((args) => args.join(' '))
      .join('\n');
    expect(errorText).toContain('Refusing to write');
    expect(wasTouched()).toBe(false);
  });

  it('does not create the refused output file', async () => {
    const outPath = path.join(REPO_ROOT, 'apps', 'pipeline', 'reports', 'guard-test-not-created.xlsx');
    const { store } = trackedFakeStore();

    await expect(
      main({ argv: ['--set', 'fake-set-id', '--out', outPath], store }),
    ).rejects.toThrow(ProcessExitError);

    expect(fs.existsSync(outPath)).toBe(false);
  });
});
