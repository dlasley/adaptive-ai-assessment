/**
 * Pure directory-based reference export/import helpers for the transcription task. Unlike audit and
 * grading's spreadsheet CSV round trip, a transcript is reviewed against the slide image, not a row
 * of cells — so reference lives as one markdown file per slide (`<slide>.md`) rather than a CSV. No
 * filesystem or Supabase access here; `eval-review-export.ts`/`eval-review-import.ts` do the reading and
 * writing, this module only decides file names, contents, and validity.
 */

import { NO_CONTENT_MARKER } from '../pdf-conversion';
import type { EvalItemRow } from './db';

export interface TranscriptionReferenceExportFile {
  /** File name within the export directory, e.g. "12.md" — not a full path. */
  filename: string;
  content: string;
}

/**
 * One `<slide>.md` file per item, prefilled with `outputsByItem`'s entry for that item (the baseline
 * run's own transcript, when `eval-review-export --from-run` is given) or empty otherwise, for the
 * reviewer to transcribe into from scratch.
 */
export function buildTranscriptionReferenceExportFiles(
  items: Pick<EvalItemRow, 'id' | 'payload'>[],
  outputsByItem?: Map<string, string>,
): TranscriptionReferenceExportFile[] {
  return items.map((item) => ({
    filename: `${item.payload.slide as number}.md`,
    content: outputsByItem?.get(item.id) ?? '',
  }));
}

/** README.md listing every item's slide, category, and file name, for a reviewer opening the export
 * directory cold. */
export function buildTranscriptionReferenceReadme(
  setId: string,
  items: Pick<EvalItemRow, 'payload'>[],
  prefilledFromRun?: string,
): string {
  const lines = [
    `# Transcription reference — set ${setId}`,
    '',
    prefilledFromRun
      ? `Each file is prefilled with run ${prefilledFromRun}'s transcript — check it against the slide image and correct it in place.`
      : 'Each file starts empty — transcribe the slide from its image directly into the file.',
    '',
    `Write the no-content marker line \`${NO_CONTENT_MARKER}\` (and nothing else) for a slide with no teaching content.`,
    '',
    '| Slide | Category | File |',
    '|---|---|---|',
  ];
  const sorted = [...items].sort((a, b) => (a.payload.slide as number) - (b.payload.slide as number));
  for (const item of sorted) {
    const slide = item.payload.slide as number;
    lines.push(`| ${slide} | ${item.payload.category} | ${slide}.md |`);
  }
  return lines.join('\n') + '\n';
}

export interface TranscriptionReferenceValidationError {
  itemId: string;
  message: string;
}

export interface TranscriptionReferenceRow {
  itemId: string;
  reference: { markdown: string };
}

export interface TranscriptionReferenceValidationResult {
  errors: TranscriptionReferenceValidationError[];
  rows: TranscriptionReferenceRow[];
}

/**
 * Validates a reviewer's completed export directory against a set's known items: every item's slide
 * must have a non-empty file — a real checked transcript, or exactly the no-content marker line.
 * Every item is checked before returning, so a caller can report every missing or empty file at
 * once rather than stopping at the first.
 */
export function validateTranscriptionReferenceFiles(
  items: Pick<EvalItemRow, 'id' | 'payload'>[],
  fileContentBySlide: Map<number, string>,
): TranscriptionReferenceValidationResult {
  const errors: TranscriptionReferenceValidationError[] = [];
  const rows: TranscriptionReferenceRow[] = [];

  for (const item of items) {
    const slide = item.payload.slide as number;
    const raw = fileContentBySlide.get(slide);
    if (raw === undefined) {
      errors.push({ itemId: item.id, message: `no ${slide}.md file found in the reference directory` });
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed === '') {
      errors.push({
        itemId: item.id,
        message: `${slide}.md is empty — write the checked transcript, or the no-content marker line \`${NO_CONTENT_MARKER}\` if the slide has no teaching content`,
      });
      continue;
    }
    rows.push({ itemId: item.id, reference: { markdown: trimmed } });
  }

  return { errors, rows };
}
