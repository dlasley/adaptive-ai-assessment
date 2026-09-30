/**
 * Shared types for the `pipeline` dispatcher (`bin/pipeline.ts` and this directory).
 */

import type { OptionSpecs } from '../options/types';

/** The `<area>` prefix a command file's name starts with, e.g. `questions-audit.ts` -> `questions`. */
export const AREAS = ['pipeline', 'content', 'questions', 'audit', 'db', 'eval'] as const;
export type Area = (typeof AREAS)[number];

export const AREA_LABELS: Record<Area, string> = {
  pipeline: 'Pipeline',
  content: 'Content',
  questions: 'Questions',
  audit: 'Audit',
  db: 'Database',
  eval: 'Evaluation',
};

/**
 * One discovered command file. `specs` is undefined for a command that doesn't declare its flags
 * through `defineCli()`.
 */
export interface CommandMeta {
  name: string;
  area: Area;
  description: string;
  specs?: OptionSpecs;
}
