import { describe, expect, it } from 'vitest';
import { summarizePipelineRun, type UnitPipelineResult } from '../src/lib/pipeline-steps';

function result(overrides: Partial<UnitPipelineResult> & { unitId: string }): UnitPipelineResult {
  return { success: true, warnings: [], ...overrides };
}

describe('summarizePipelineRun', () => {
  it('exits 0 when every unit succeeds', () => {
    const summary = summarizePipelineRun([
      result({ unitId: 'unit-1' }),
      result({ unitId: 'unit-2' }),
    ]);

    expect(summary.exitCode).toBe(0);
    expect(summary.lines).toContain('  Units processed: 2');
    expect(summary.lines).toContain('  Succeeded:       2');
    expect(summary.lines).toContain('  Failed:          0');
  });

  it('exits 1 when any unit fails, and names the failed unit and step', () => {
    const summary = summarizePipelineRun([
      result({ unitId: 'unit-1' }),
      result({ unitId: 'unit-2', success: false, failedStep: 'question generation' }),
    ]);

    expect(summary.exitCode).toBe(1);
    expect(summary.lines).toContain('Failed units:');
    expect(summary.lines).toContain('  - unit-2: question generation');
  });

  it('keeps a failed unit from suppressing results for the rest of the batch', () => {
    // Simulates --all: one bad unit among several successes still reports every unit.
    const summary = summarizePipelineRun([
      result({ unitId: 'unit-1' }),
      result({ unitId: 'unit-2', success: false, failedStep: 'PDF conversion' }),
      result({ unitId: 'unit-3' }),
    ]);

    expect(summary.lines).toContain('  Units processed: 3');
    expect(summary.lines).toContain('  Succeeded:       2');
    expect(summary.lines).toContain('  Failed:          1');
    expect(summary.exitCode).toBe(1);
  });

  it('surfaces non-fatal warnings without failing the run', () => {
    const summary = summarizePipelineRun([
      result({ unitId: 'unit-1', warnings: ['quality audit failed (questions remain as pending)'] }),
    ]);

    expect(summary.exitCode).toBe(0);
    expect(summary.lines).toContain('Warnings (non-fatal):');
    expect(summary.lines).toContain('  - unit-1: quality audit failed (questions remain as pending)');
  });

  it('lists multiple warnings for the same unit', () => {
    const summary = summarizePipelineRun([
      result({
        unitId: 'unit-1',
        warnings: ['quality audit failed (questions remain as pending)', 'resource extraction failed'],
      }),
    ]);

    expect(summary.lines).toContain('  - unit-1: quality audit failed (questions remain as pending)');
    expect(summary.lines).toContain('  - unit-1: resource extraction failed');
  });

  it('handles an empty result set', () => {
    const summary = summarizePipelineRun([]);

    expect(summary.exitCode).toBe(0);
    expect(summary.lines).toContain('  Units processed: 0');
  });
});
