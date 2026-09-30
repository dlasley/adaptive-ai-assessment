/**
 * Directory anchors for the pipeline package, resolved from this file's own
 * location rather than `process.cwd()` — every path here works whether a
 * pipeline command is run from the repo root (`npx tsx apps/pipeline/src/commands/x.ts`)
 * or from inside `apps/pipeline` (`npx tsx src/commands/x.ts`).
 */

import path from 'path';

export const PIPELINE_ROOT = path.resolve(__dirname, '..', '..');
export const REPO_ROOT = path.resolve(PIPELINE_ROOT, '..', '..');

/**
 * Directory the `pipeline` dispatcher (`bin/pipeline.ts`, `lib/dispatch/`) scans for command
 * files. The one place that binding lives, so pointing discovery at a different layout is a
 * one-line change here rather than a hunt through the dispatcher.
 */
export const COMMANDS_DIR = path.join(PIPELINE_ROOT, 'src', 'commands');

export const PROMPTS_DIR = path.join(PIPELINE_ROOT, 'prompts');

/** Working files — gitignored except `.gitkeep` in `pdf/` and `markdown/`; `exports/` is created
 * on demand by whatever command first writes to it. */
export const PDF_DIR = path.join(PIPELINE_ROOT, 'content', 'pdf');
export const MARKDOWN_DIR = path.join(PIPELINE_ROOT, 'content', 'markdown');
export const EXPORTS_DIR = path.join(PIPELINE_ROOT, 'content', 'exports');

/** Per-slide vision-conversion cache, keyed by a content hash — reused across PDFs and reruns. */
export const PDF_SLIDE_CACHE_DIR = path.join(EXPORTS_DIR, 'pdf-slide-cache');
