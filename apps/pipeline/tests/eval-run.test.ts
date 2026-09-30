import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { variantKey, buildVariants, buildVariantLabel, parseReasoningFlag, buildEffectiveCallSettings, orderItemsForRun, cli, type Variant } from '../src/commands/eval-run';
import { GRADING_CALL_SETTINGS } from '@adaptive/shared/grading-prompt';
import { AUDIT_GROUP_SIZE } from '../src/lib/pipeline-config';

class ProcessExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

function expectExit(fn: () => void, code: number) {
  try {
    fn();
    throw new Error('expected process.exit to be called');
  } catch (err) {
    expect(err).toBeInstanceOf(ProcessExitError);
    expect((err as ProcessExitError).code).toBe(code);
  }
}

describe('buildVariants', () => {
  it('produces one variant per model when repeat is 1', () => {
    expect(buildVariants(['a', 'b'], 1)).toEqual([
      { model: 'a', repeatIndex: 1 },
      { model: 'b', repeatIndex: 1 },
    ]);
  });

  it('orders repeats outermost, models innermost (repeat-major, model-minor)', () => {
    expect(buildVariants(['a', 'b'], 2)).toEqual([
      { model: 'a', repeatIndex: 1 },
      { model: 'b', repeatIndex: 1 },
      { model: 'a', repeatIndex: 2 },
      { model: 'b', repeatIndex: 2 },
    ]);
  });
});

describe('variantKey', () => {
  it('is unique per model and repeatIndex', () => {
    const keys = buildVariants(['a', 'b'], 2).map(variantKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('buildVariantLabel', () => {
  const variants: Variant[] = [{ model: 'a', repeatIndex: 1 }, { model: 'b', repeatIndex: 1 }];

  it('returns null when no label is given', () => {
    expect(buildVariantLabel(undefined, variants[0], variants)).toBeNull();
  });

  it('returns the label unchanged for a single-variant run', () => {
    expect(buildVariantLabel('baseline', variants[0], [variants[0]])).toBe('baseline');
  });

  it('suffixes the model slug for a multi-variant run', () => {
    expect(buildVariantLabel('candidate', variants[0], variants)).toBe('candidate:a');
    expect(buildVariantLabel('candidate', variants[1], variants)).toBe('candidate:b');
  });

  it('also suffixes the repeat index when repeatIndex > 1', () => {
    const repeated: Variant = { model: 'a', repeatIndex: 2 };
    expect(buildVariantLabel('candidate', repeated, [variants[0], repeated])).toBe('candidate:a:r2');
  });
});

describe('parseReasoningFlag', () => {
  it('returns undefined when unset', () => {
    expect(parseReasoningFlag(undefined)).toBeUndefined();
  });

  it("maps 'off' to enabled: false", () => {
    expect(parseReasoningFlag('off')).toEqual({ enabled: false });
  });

  it('maps an effort tier to { effort }', () => {
    expect(parseReasoningFlag('low')).toEqual({ effort: 'low' });
    expect(parseReasoningFlag('none')).toEqual({ effort: 'none' });
  });
});

describe('buildEffectiveCallSettings', () => {
  it('an audit baseline with no flags records production settings (temperature 0.1, JSON mode, Mistral-pinned)', () => {
    const settings = buildEffectiveCallSettings('audit', {});
    expect(settings).toEqual({
      temperature: 0.1,
      jsonMode: true,
      provider: { order: ['Mistral'], allowFallbacks: false },
    });
  });

  it('lets --temperature override the audit production default', () => {
    const settings = buildEffectiveCallSettings('audit', { temperature: 0.5 });
    expect(settings.temperature).toBe(0.5);
    expect(settings.provider).toEqual({ order: ['Mistral'], allowFallbacks: false });
  });

  it('lets --provider override the audit production pin', () => {
    const settings = buildEffectiveCallSettings('audit', { provider: 'google-ai-studio' });
    expect(settings.provider).toEqual({ order: ['google-ai-studio'], allowFallbacks: false });
    expect(settings.temperature).toBe(0.1);
  });

  it('a grading baseline with no flags records GRADING_CALL_SETTINGS, unpinned', () => {
    const settings = buildEffectiveCallSettings('grading', {});
    expect(settings).toEqual({
      temperature: GRADING_CALL_SETTINGS.temperature,
      jsonMode: GRADING_CALL_SETTINGS.jsonMode,
      provider: undefined,
    });
  });

  it('lets --temperature and --provider override grading defaults', () => {
    const settings = buildEffectiveCallSettings('grading', { temperature: 0.9, provider: 'openai' });
    expect(settings.temperature).toBe(0.9);
    expect(settings.provider).toEqual({ order: ['openai'], allowFallbacks: false });
  });
});

describe('orderItemsForRun', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

  it('returns items in their original order when no seed is given', () => {
    expect(orderItemsForRun(items, undefined)).toEqual(items);
  });

  it('gives the same order for the same seed', () => {
    expect(orderItemsForRun(items, 42)).toEqual(orderItemsForRun(items, 42));
  });

  it('gives a different order for a different seed', () => {
    expect(orderItemsForRun(items, 1)).not.toEqual(orderItemsForRun(items, 2));
  });

  it('permutes without dropping or duplicating items', () => {
    const ordered = orderItemsForRun(items, 7);
    expect([...ordered].sort()).toEqual([...items].sort());
  });

  it('does not mutate the input array', () => {
    const copy = [...items];
    orderItemsForRun(items, 3);
    expect(items).toEqual(copy);
  });
});

describe('eval-run cli: --group-size and --shuffle-groups', () => {
  const base = ['--set', 'set-1', '--task', 'audit', '--models', 'mistralai/mistral-large-2512'];

  it('defaults group-size to the production AUDIT_GROUP_SIZE and leaves shuffle-groups unset', () => {
    const options = cli.parse(base);
    expect(options.groupSize).toBe(AUDIT_GROUP_SIZE);
    expect(options.shuffleGroups).toBeUndefined();
  });

  it('parses an explicit --group-size', () => {
    const options = cli.parse([...base, '--group-size', '1']);
    expect(options.groupSize).toBe(1);
  });

  it('parses an explicit --shuffle-groups seed', () => {
    const options = cli.parse([...base, '--shuffle-groups', '123']);
    expect(options.shuffleGroups).toBe(123);
  });
});

describe('buildEffectiveCallSettings (mapping)', () => {
  it('a mapping baseline with no flags records no temperature override, no JSON mode, and no provider pin', () => {
    const settings = buildEffectiveCallSettings('mapping', {});
    expect(settings).toEqual({ temperature: undefined, jsonMode: false, provider: undefined });
  });

  it('lets --temperature and --provider override the mapping defaults', () => {
    const settings = buildEffectiveCallSettings('mapping', { temperature: 0.4, provider: 'anthropic' });
    expect(settings.temperature).toBe(0.4);
    expect(settings.provider).toEqual({ order: ['anthropic'], allowFallbacks: false });
    expect(settings.jsonMode).toBe(false);
  });
});

describe('eval-run cli: retired --hypothesis/--surface flags', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0);
    }) as unknown as typeof process.exit);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const base = ['--set', 'set-1', '--task', 'grading', '--models', 'openai/gpt-4.1-nano'];

  it('rejects the retired --hypothesis flag as unknown, before touching --experiment resolution', () => {
    expectExit(() => cli.parse([...base, '--hypothesis', 'h1']), 1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown option: --hypothesis'));
  });

  it('rejects the retired --surface flag as unknown (renamed to --task)', () => {
    expectExit(() => cli.parse(['--set', 'set-1', '--surface', 'grading', '--models', 'openai/gpt-4.1-nano']), 1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown option: --surface'));
  });

  it('still requires --task now that --surface is gone', () => {
    expectExit(() => cli.parse(['--set', 'set-1', '--models', 'openai/gpt-4.1-nano']), 1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--task is required'));
  });
});

describe('eval-run cli: --task mapping', () => {
  it('accepts mapping as a valid task', () => {
    const options = cli.parse(['--set', 'set-1', '--task', 'mapping', '--models', 'anthropic/claude-haiku-4.5']);
    expect(options.task).toBe('mapping');
  });
});

describe('buildEffectiveCallSettings (transcription)', () => {
  it('a transcription baseline with no flags records no temperature override, no JSON mode, and no provider pin — matching convertPdfToMarkdown', () => {
    const settings = buildEffectiveCallSettings('transcription', {});
    expect(settings).toEqual({ temperature: undefined, jsonMode: false, provider: undefined });
  });

  it('lets --temperature and --provider override the transcription defaults', () => {
    const settings = buildEffectiveCallSettings('transcription', { temperature: 0.2, provider: 'google-ai-studio' });
    expect(settings.temperature).toBe(0.2);
    expect(settings.provider).toEqual({ order: ['google-ai-studio'], allowFallbacks: false });
    expect(settings.jsonMode).toBe(false);
  });
});

describe('eval-run cli: --task transcription', () => {
  it('accepts transcription as a valid task', () => {
    const options = cli.parse(['--set', 'set-1', '--task', 'transcription', '--models', 'google/gemini-2.5-flash']);
    expect(options.task).toBe('transcription');
  });
});
