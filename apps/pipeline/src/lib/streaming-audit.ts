/**
 * Generic per-group streaming loop shared by `questions-audit.ts`'s Mistral and Sonnet auditors:
 * audits one group of questions at a time and, when a writer is supplied, applies that group's
 * results to the database immediately rather than waiting for the whole run to finish — a crash
 * or Ctrl-C partway through a long run keeps whatever earlier groups already wrote. Stops after
 * finishing the in-flight group once `shouldStop` reports true, the SIGINT handling both
 * auditors share.
 */

import type { QuestionRow } from './db-queries';

export interface StreamingAuditRunOptions<Result, Summary> {
  questions: QuestionRow[];
  groupSize: number;
  /** Audits one group. Must resolve, never reject — a permanent per-group failure is expected to
   * resolve to passthrough/error results instead, the way each auditor's own retry handling
   * already does, so one group's failure never aborts the groups after it. */
  auditGroupFn: (group: QuestionRow[], groupIndex: number, totalGroups: number) => Promise<Result[]>;
  /** Writes one group's results to the database. Omitted in dry-run (no --write-db) mode, in
   * which case `summary` stays `emptySummary` for the whole run. */
  applyGroupFn?: (groupResults: Result[], group: QuestionRow[]) => Promise<Summary>;
  emptySummary: Summary;
  mergeSummaries: (a: Summary, b: Summary) => Summary;
  onGroupDone?: (questionsDone: number, questionsTotal: number) => void;
  shouldStop?: () => boolean;
}

export interface StreamingAuditRunResult<Result, Summary> {
  results: Result[];
  summary: Summary;
  interrupted: boolean;
}

export async function runStreamingAudit<Result, Summary>(
  opts: StreamingAuditRunOptions<Result, Summary>,
): Promise<StreamingAuditRunResult<Result, Summary>> {
  const groups: QuestionRow[][] = [];
  for (let i = 0; i < opts.questions.length; i += opts.groupSize) {
    groups.push(opts.questions.slice(i, i + opts.groupSize));
  }

  const results: Result[] = [];
  let summary = opts.emptySummary;
  let interrupted = false;
  let questionsDone = 0;

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const groupResults = await opts.auditGroupFn(group, i, groups.length);
    results.push(...groupResults);
    questionsDone += group.length;

    if (opts.applyGroupFn) {
      const groupSummary = await opts.applyGroupFn(groupResults, group);
      summary = opts.mergeSummaries(summary, groupSummary);
    }

    opts.onGroupDone?.(questionsDone, opts.questions.length);

    if (opts.shouldStop?.()) {
      interrupted = true;
      break;
    }
  }

  return { results, summary, interrupted };
}
