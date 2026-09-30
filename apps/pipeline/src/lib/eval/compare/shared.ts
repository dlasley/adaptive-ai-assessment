/**
 * Pieces of `eval-compare`'s comparison logic and report rendering shared by every task: pairing a
 * run's results by item, one run's own cost/latency profile, the noise-floor markdown section every
 * task's report renders the same way, a single "n/a for missing or NaN" number formatter, and the
 * provider-pin verification `eval-compare` runs against every task's runs up front.
 */

import { percentile } from '../runner';
import type { EvalResultRow, EvalRunRow } from '../db';

export function resultByItem(results: EvalResultRow[]): Map<string, EvalResultRow> {
  return new Map(results.map((r) => [r.item_id, r]));
}

export interface RunCostLatency {
  n: number;
  costPerItemUsd: number | undefined;
  latencyMsP50: number | undefined;
  latencyMsP95: number | undefined;
}

/** One run's cost and latency profile, read straight from its `eval_results` rows. */
export function runCostLatency(results: EvalResultRow[]): RunCostLatency {
  const costs = results.map((r) => r.cost_usd).filter((v): v is number => v !== null && v !== undefined);
  const latencies = results.map((r) => r.latency_ms).filter((v): v is number => v !== null && v !== undefined);
  return {
    n: results.length,
    costPerItemUsd: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / results.length : undefined,
    latencyMsP50: percentile(latencies, 50),
    latencyMsP95: percentile(latencies, 95),
  };
}

/** Formats a number to `digits` decimal places, wrapped in an optional prefix/suffix (`$`, `ms`) —
 * or `'n/a'` when there is nothing to report (`undefined`) or nothing meaningful to report (`NaN`,
 * e.g. a rate computed over zero items). Every report in this directory renders a missing and a
 * NaN value identically, so a metric that happens to be `NaN` never prints as the literal text
 * "NaN". */
export function formatOrNA(value: number | undefined, digits: number, unit?: { prefix?: string; suffix?: string }): string {
  if (value === undefined || Number.isNaN(value)) return 'n/a';
  return `${unit?.prefix ?? ''}${value.toFixed(digits)}${unit?.suffix ?? ''}`;
}

/**
 * Renders the "## Noise floor (repeats of the same variant)" section every task's report shows
 * when `--runs` included a repeat of the same variant: a table over `rows` (headed by `header`,
 * one line per row from `renderRow`) followed by the standard caption. Returns no lines at all when
 * `rows` is empty — a report with no repeats shows no noise-floor section rather than an empty one.
 */
export function buildNoiseFloorSection<T>(rows: T[], header: string[], renderRow: (row: T) => string): string[] {
  if (rows.length === 0) return [];
  const lines: string[] = [];
  lines.push('');
  lines.push('## Noise floor (repeats of the same variant)');
  lines.push('');
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`|${header.map(() => '---').join('|')}|`);
  for (const row of rows) lines.push(renderRow(row));
  lines.push('');
  lines.push('A between-variant difference smaller than the noise floor above is not a finding.');
  return lines;
}

/** Lowercases and strips every non-alphanumeric character, so 'Google AI Studio' and
 * 'google-ai-studio' compare equal — provider names are hand-typed in `--provider` and rendered
 * inconsistently by different hosts, and neither spelling is more "correct" than the other. */
function normalizeProviderName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** A run's `provider_pin` may carry a host-routing suffix after a slash (e.g. `mistral/zdr` pins
 * Mistral's zero-data-retention endpoint) that `served_provider` never echoes back — only the part
 * before the slash names the host itself, which is what's being verified here. */
function normalizePin(pin: string): string {
  return normalizeProviderName(pin.split('/')[0]);
}

/** Whether `run`'s results named a `served_provider` other than the run's own `provider_pin` —
 * turns the pin from an assumption into a verified fact per call. Compares normalized forms (see
 * `normalizeProviderName`/`normalizePin`) so a hand-typed `--provider anthropic` isn't flagged
 * against OpenRouter's `Anthropic`. Returns the empty array when the run has no pin (nothing to
 * compare against) or every result matches it. */
export function providerPinMismatches(run: EvalRunRow, results: EvalResultRow[]): string[] {
  if (!run.provider_pin) return [];
  const normalizedPin = normalizePin(run.provider_pin);
  const mismatches = new Set(
    results
      .map((r) => r.served_provider)
      .filter((servedProvider): servedProvider is string => servedProvider !== null && normalizeProviderName(servedProvider) !== normalizedPin),
  );
  return [...mismatches];
}
