/**
 * Looks up an `eval-run` task's `EvalTaskDefinition` by its `EvalTask` name. Every task eval-run
 * supports (`audit`, `grading`, `mapping`, `transcription`) is keyed here once implemented.
 */

import { auditTask } from './audit';
import { gradingTask } from './grading';
import { mappingTask } from './mapping';
import { transcriptionTask } from './transcription';
import type { EvalTaskDefinition } from './types';

type ErasedTaskDefinition = EvalTaskDefinition<unknown, unknown, Record<string, unknown>>;

export const TASK_DEFINITIONS: Record<'audit' | 'grading' | 'mapping' | 'transcription', ErasedTaskDefinition> = {
  audit: auditTask as unknown as ErasedTaskDefinition,
  grading: gradingTask as unknown as ErasedTaskDefinition,
  mapping: mappingTask as unknown as ErasedTaskDefinition,
  transcription: transcriptionTask as unknown as ErasedTaskDefinition,
};
