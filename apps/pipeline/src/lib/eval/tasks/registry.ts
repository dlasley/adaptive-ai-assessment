/**
 * Looks up an `eval-run` task's `EvalTaskDefinition` by its `EvalTask` name. Every task eval-run
 * supports (`audit`, `grading`, `mapping`, `transcription`) is keyed here once implemented.
 */

import { auditTask } from './audit';
import { gradingTask } from './grading';
import { mappingTask } from './mapping';
import { transcriptionTask } from './transcription';
import type { EvalTaskDefinition } from './types';

export const TASK_DEFINITIONS: Record<'audit' | 'grading' | 'mapping' | 'transcription', EvalTaskDefinition<unknown, unknown>> = {
  audit: auditTask as EvalTaskDefinition<unknown, unknown>,
  grading: gradingTask,
  mapping: mappingTask as EvalTaskDefinition<unknown, unknown>,
  transcription: transcriptionTask as EvalTaskDefinition<unknown, unknown>,
};
