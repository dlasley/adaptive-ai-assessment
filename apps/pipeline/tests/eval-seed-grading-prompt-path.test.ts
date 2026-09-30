/**
 * `eval-seed-grading.ts` reads its system prompt from `PROMPTS_DIR/eval-seed-grading.md`
 * (`PROMPTS_DIR` now imported from the pipeline's own `lib/paths.ts`, since the eval framework's
 * move dropped its private copy — see `lib/eval/paths.ts`'s doc comment). This proves the file
 * survived the move to its new location and still renders through `renderCoursePrompt` without a
 * hard-coded course name or language.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { renderCoursePrompt } from '@adaptive/shared/course';
import { PROMPTS_DIR } from '../src/lib/paths';

describe('eval-seed-grading.md prompt template', () => {
  it('exists under the pipeline package prompts directory', () => {
    const promptPath = path.join(PROMPTS_DIR, 'eval-seed-grading.md');
    expect(fs.existsSync(promptPath)).toBe(true);
  });

  it('renders through renderCoursePrompt with no unresolved {{COURSE_*}} placeholder left', () => {
    const raw = fs.readFileSync(path.join(PROMPTS_DIR, 'eval-seed-grading.md'), 'utf-8');
    const rendered = renderCoursePrompt(raw);

    expect(rendered).not.toMatch(/\{\{COURSE_NAME\}\}|\{\{COURSE_LEVEL\}\}|\{\{COURSE_LANGUAGE\}\}/);
  });

  it('carries no hard-coded course name or language literal in the raw template', () => {
    const raw = fs.readFileSync(path.join(PROMPTS_DIR, 'eval-seed-grading.md'), 'utf-8');
    expect(raw).not.toMatch(/french/i);
  });
});
