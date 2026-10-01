/**
 * Builds the frozen `eval_items` snapshots `eval-set-create` writes, for the audit, grading,
 * mapping, and transcription tasks. Pure functions over already-fetched rows or files — no
 * Supabase or LLM calls here, so sampling and snapshot shape are unit-testable without a live
 * database.
 */

import { createHash } from 'crypto';
import { stratifiedSample, mulberry32, shuffle } from './sampling';
import { loadUnitMaterials, toHeadingSlideForm, type MaterialsUnit, type HeadingRef } from '../learning-materials';
import type { EvalItemRow } from './db';

/** sha256 (16 hex) — same convention as questions-audit.ts's prompt hashing, applied here to the
 * frozen inputs an eval_sets row depends on (unit markdown content, units row). A later mismatch
 * against a freshly computed hash means the underlying material changed since the set was made. */
export function hashInputs(unitMarkdown: string, unitsRow: unknown): string {
  const digest = createHash('sha256');
  digest.update(unitMarkdown);
  digest.update(JSON.stringify(unitsRow));
  return digest.digest('hex').substring(0, 16);
}

/** `hashInputs` for a sample that may touch several units: loads each unit's markdown, sorts by
 * unit id so ordering can't affect the hash, and hashes the combined markdown against the units'
 * own rows (topics/headings). */
export function hashInputsForUnits(unitIds: string[], units: MaterialsUnit[]): string {
  const sortedIds = [...new Set(unitIds)].sort();
  const combinedMarkdown = sortedIds.map((id) => loadUnitMaterials(id, units)).join('\n---\n');
  const rows = sortedIds.map((id) => units.find((u) => u.id === id) ?? null);
  return hashInputs(combinedMarkdown, rows);
}

/** Builds a stratification key function from a list of field names (the `--strata` flag, split on
 * comma), reading each named field off the item with String() coercion — so a `null` stratum
 * value groups as the literal string `"null"` rather than crashing or silently merging with
 * `undefined`. */
export function strataKeyFn<T>(fields: string[]): (item: T) => string {
  return (item: T) => fields.map((field) => String((item as Record<string, unknown>)[field])).join('|');
}

// ── Audit task ───────────────────────────────────────────────────────────

export interface AuditSourceQuestion {
  id: string;
  question: string;
  correct_answer: string;
  type: string;
  difficulty: string;
  topic: string;
  unit_id: string;
  writing_type: string | null;
  options: string[] | null;
  acceptable_variations: string[] | null;
  quality_status: string;
  audit_metadata: Record<string, unknown> | null;
}

export interface BuildAuditItemsOptions {
  size: number;
  /** Field names on `AuditSourceQuestion` to stratify by, e.g. ['type', 'difficulty', 'quality_status']. */
  strata: string[];
  seed?: number;
  /** When true, samples flagged and non-flagged questions separately at a 50/50 split instead of
   * stratifying quality_status proportionally, which would under-represent flagged questions
   * since they're the minority in production. */
  balanceStatus?: boolean;
}

export interface BuiltEvalItem {
  itemKey: string;
  payload: Record<string, unknown>;
  /** The design-time label this item was built to carry (`eval_items.seeded_class`): set for
   * grading items, where it mirrors `payload.label_class`. Undefined for a task that doesn't seed
   * one yet (audit, mapping, transcription). */
  seededClass?: string;
  /** Set only for a task whose reference is deterministic and known at creation time (mapping) —
   * audit and grading items start with no reference and are reviewed later. */
  reference?: Record<string, unknown>;
  referenceStatus?: 'pending' | 'approved' | 'rejected';
  reviewedBy?: string;
  reviewedAt?: string;
}

/** Reads a grading item's seeded label class, preferring the `seeded_class` column and falling
 * back to `payload.label_class` for a row written before the column existed. The one place every
 * reader of the design-time label goes through. */
export function seededLabelClass(item: Pick<EvalItemRow, 'seeded_class' | 'payload'>): string | undefined {
  return item.seeded_class ?? (item.payload.label_class as string | undefined);
}

export interface BuildItemsResult {
  items: BuiltEvalItem[];
  seed: number;
  strataCounts: Record<string, number>;
}

/** Removes candidates whose `topic` is in `excludedTopics` (exact match), before sampling. */
export function excludeTopics<T extends { topic: string }>(items: T[], excludedTopics: Set<string>): T[] {
  return items.filter((item) => !excludedTopics.has(item.topic));
}

export function auditPayload(q: AuditSourceQuestion): Record<string, unknown> {
  return {
    question: q.question,
    correct_answer: q.correct_answer,
    type: q.type,
    difficulty: q.difficulty,
    topic: q.topic,
    unit_id: q.unit_id,
    writing_type: q.writing_type,
    options: q.options,
    acceptable_variations: q.acceptable_variations,
    // The production auditor's own verdict, carried along for a production-verdict comparison
    // (eval-run's summary) when approved reference doesn't cover this item yet.
    production_audit: q.audit_metadata ?? null,
  };
}

function mergeStrataCounts(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const merged = { ...a };
  for (const [key, count] of Object.entries(b)) {
    merged[key] = (merged[key] ?? 0) + count;
  }
  return merged;
}

export function buildAuditItems(questions: AuditSourceQuestion[], opts: BuildAuditItemsOptions): BuildItemsResult {
  const keyFn = strataKeyFn<AuditSourceQuestion>(opts.strata);

  if (opts.balanceStatus) {
    const flagged = questions.filter((q) => q.quality_status === 'flagged');
    const nonFlagged = questions.filter((q) => q.quality_status !== 'flagged');
    const half = Math.floor(opts.size / 2);

    const flaggedSample = stratifiedSample(flagged, { size: half, keyFn, seed: opts.seed });
    const nonFlaggedSample = stratifiedSample(nonFlagged, {
      size: opts.size - half,
      keyFn,
      seed: flaggedSample.seed, // same seed for both halves keeps the whole draw reproducible from one recorded value
    });

    const sampled = [...flaggedSample.items, ...nonFlaggedSample.items];
    return {
      items: sampled.map((q) => ({ itemKey: q.id, payload: auditPayload(q) })),
      seed: flaggedSample.seed,
      strataCounts: mergeStrataCounts(flaggedSample.strataCounts, nonFlaggedSample.strataCounts),
    };
  }

  const sample = stratifiedSample(questions, { size: opts.size, keyFn, seed: opts.seed });
  return {
    items: sample.items.map((q) => ({ itemKey: q.id, payload: auditPayload(q) })),
    seed: sample.seed,
    strataCounts: sample.strataCounts,
  };
}

export interface DrawSelectionPoolOptions {
  /** Ids read from `--pool-ids`, restricted to the current (filtered) candidate pool before the
   * draw — an id absent from the candidate pool is reported in `ignoredCount`, not silently kept. */
  poolIds: Set<string>;
  poolSize: number;
  /** Reused from the stratified core's own seed, so the whole draw is reproducible from one
   * recorded value. */
  seed: number;
  /** Ids already drawn into the stratified core — excluded so the pool never duplicates it. */
  excludeIds: Set<string>;
}

export interface DrawSelectionPoolResult {
  ids: string[];
  /** How many `poolIds` entries weren't in the candidate pool at all (wrong batch/filter, typo,
   * etc.) — reported so the caller can log a count instead of silently dropping them. */
  ignoredCount: number;
}

/**
 * Draws `poolSize` ids uniformly at random (seeded) from `poolIds`, restricted to `candidateIds`
 * and excluding anything already in `excludeIds`. Unlike `stratifiedSample`, this draw ignores
 * strata entirely — the pool exists to add breadth beyond the core sample's stratification, not to
 * preserve it.
 */
export function drawSelectionPool(candidateIds: Set<string>, opts: DrawSelectionPoolOptions): DrawSelectionPoolResult {
  const inCandidates = [...opts.poolIds].filter((id) => candidateIds.has(id));
  const ignoredCount = opts.poolIds.size - inCandidates.length;
  const eligible = inCandidates.filter((id) => !opts.excludeIds.has(id));
  const ids = shuffle(eligible, mulberry32(opts.seed)).slice(0, opts.poolSize);
  return { ids, ignoredCount };
}

// ── Grading task ─────────────────────────────────────────────────────────

export const GRADING_LABEL_CLASSES = [
  'correct',
  'wrong',
  'typo',
  'missing_accent',
  'valid_paraphrase',
  'partially_correct',
] as const;

export type GradingLabelClass = (typeof GRADING_LABEL_CLASSES)[number];

/** Label classes with a deterministic correct answer (a typo or a missing accent), rather than one
 * a model call is needed to seed. Used to route these items around review or model-based seeding. */
export const POLICY_LABEL_CLASSES = ['typo', 'missing_accent'] as const satisfies readonly GradingLabelClass[];

export interface GradingSourceQuestion {
  id: string;
  question: string;
  correct_answer: string;
  type: 'fill-in-blank' | 'writing';
  difficulty: string;
  topic: string;
  unit_id: string;
  writing_type: string | null;
  acceptable_variations: string[] | null;
}

export interface BuildGradingItemsOptions {
  /** How many label classes to seed per question, taken in `GRADING_LABEL_CLASSES` order. */
  perQuestion: number;
}

/**
 * One item per (question, label class) pair, with an empty `submitted_answer` placeholder —
 * `eval-seed-grading` fills it in later. `item_key` is `${questionId}:${labelClass}`, so re-running
 * this against the same question set is idempotent under `eval_items`' `(set_id, item_key)`
 * uniqueness.
 */
export function buildGradingItems(questions: GradingSourceQuestion[], opts: BuildGradingItemsOptions): BuiltEvalItem[] {
  const labelClasses = GRADING_LABEL_CLASSES.slice(0, opts.perQuestion);
  const items: BuiltEvalItem[] = [];
  for (const q of questions) {
    for (const labelClass of labelClasses) {
      items.push({
        itemKey: `${q.id}:${labelClass}`,
        payload: {
          question_id: q.id,
          question: q.question,
          correct_answer: q.correct_answer,
          type: q.type,
          difficulty: q.difficulty,
          topic: q.topic,
          unit_id: q.unit_id,
          writing_type: q.writing_type,
          acceptable_variations: q.acceptable_variations,
          label_class: labelClass,
          submitted_answer: '',
        },
        seededClass: labelClass,
      });
    }
  }
  return items;
}

// ── Mapping task ─────────────────────────────────────────────────────────

export interface MappingSourceUnit {
  id: string;
  topics: Array<{ name: string; headings: HeadingRef[] }>;
}

export interface BuildMappingItemsResult {
  items: BuiltEvalItem[];
  /** Topic names the unit has with no stored headings — the caller refuses the set rather than
   * silently scoring a topic against an empty reference set, since that's a broken topic-heading link
   * (framework: validation only proves a heading exists, not that the topic has one at all), not a
   * legitimate "this topic teaches nothing extra" case. */
  topicsWithNoHeadings: string[];
}

/**
 * One item per topic in `unit`, with reference set deterministically at creation time from the unit's
 * own current headings (already validated against the document by `content-suggest-topics
 * --map-existing`) — normalized to `{ heading, slide }` form (`toHeadingSlideForm`) so reference has a
 * uniform shape regardless of whether a heading happens to be stored as a bare string. `item_key` is
 * the topic name, unique within a unit.
 */
export function buildMappingItems(unit: MappingSourceUnit): BuildMappingItemsResult {
  const topicsWithNoHeadings = unit.topics.filter((t) => t.headings.length === 0).map((t) => t.name);
  const items: BuiltEvalItem[] = unit.topics.map((t) => ({
    itemKey: t.name,
    payload: { unit_id: unit.id, topic: t.name },
    reference: { headings: t.headings.map(toHeadingSlideForm) },
    referenceStatus: 'approved',
    reviewedBy: 'policy: corrected heading table',
    reviewedAt: new Date().toISOString(),
  }));
  return { items, topicsWithNoHeadings };
}

// ── Transcription task ───────────────────────────────────────────────────
//
// Does a cheaper vision model transcribe course slides into markdown as completely and
// accurately as production's model? Items are drawn from the three slide categories a conversion
// report exposes (image-dominated, text, and a "mixed" category production doesn't itself track —
// see `categorizeTranscriptionSlides`), with each slide's own `pdftotext` text layer frozen into the
// item at creation time. Reference (a checked transcript per slide) is filled in later via
// `eval-review-export`/`eval-review-import`, so every item starts `reference_status: 'pending'`.

/** sha256 (16 hex) of a PDF's raw bytes — this task's `eval_sets.inputs_hash`, recorded so a
 * later mismatch against a freshly hashed file means the PDF changed since the set was built. */
export function hashPdfBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').substring(0, 16);
}

/** The subset of a `*.conversion-report.json` (`ConversionReport` in `pdf-conversion.ts`) this
 * task's sampling needs — a structural subset, not an import, since the report is read off disk
 * as plain JSON. */
export interface TranscriptionConversionReport {
  slideCount: number;
  imageDominatedSlides: number[];
  skippedSlides: Array<{ slide: number }>;
  flaggedSlides: Array<{ slide: number; coverage: number }>;
}

export interface TranscriptionSlideInfo {
  slide: number;
  /** This slide's `pdftotext` output — the same text layer production uses as a hint. */
  textLayer: string;
}

export const TRANSCRIPTION_CATEGORIES = ['image-dominated', 'text', 'mixed'] as const;
export type TranscriptionCategory = (typeof TRANSCRIPTION_CATEGORIES)[number];

export interface CategorizedTranscriptionSlides {
  imageDominated: number[];
  text: number[];
  mixed: number[];
}

/**
 * Splits a PDF's slides into the three pools `eval-set-create --task transcription` draws from.
 * `imageDominated` is exactly the report's own `imageDominatedSlides` list — production already
 * computes this (text layer under `IMAGE_DOMINATED_CHAR_THRESHOLD` characters). Production has no
 * third class of its own, so `mixed` is defined here: among the remaining slides (not image-dominated,
 * not skipped — a skipped slide has no teaching content, nothing for a transcription eval to check),
 * sort by text-layer length and split at the median; the shorter half — closer to the
 * image-dominated boundary, most likely to carry teaching content in an image alongside a real text
 * layer — is `mixed`, and the longer half (more fully captured by the text layer already) is `text`.
 */
export function categorizeTranscriptionSlides(
  slides: TranscriptionSlideInfo[],
  report: TranscriptionConversionReport,
): CategorizedTranscriptionSlides {
  const imageDominatedSet = new Set(report.imageDominatedSlides);
  const skippedSet = new Set(report.skippedSlides.map((s) => s.slide));

  const imageDominated = slides.filter((s) => imageDominatedSet.has(s.slide)).map((s) => s.slide);
  const eligible = slides.filter((s) => !imageDominatedSet.has(s.slide) && !skippedSet.has(s.slide));
  const sortedByLength = [...eligible].sort(
    (a, b) => a.textLayer.length - b.textLayer.length || a.slide - b.slide,
  );
  const mixedCount = Math.floor(sortedByLength.length / 2);

  return {
    imageDominated: imageDominated.sort((a, b) => a - b),
    mixed: sortedByLength.slice(0, mixedCount).map((s) => s.slide).sort((a, b) => a - b),
    text: sortedByLength.slice(mixedCount).map((s) => s.slide).sort((a, b) => a - b),
  };
}

export interface DrawTranscriptionSampleOptions {
  perCategory: number;
  seed?: number;
}

export interface DrawTranscriptionSampleResult {
  slides: Record<TranscriptionCategory, number[]>;
  seed: number;
}

/**
 * Draws `perCategory` slides (seeded, uniform within each category) from each of the three
 * categories. Refuses — throws, rather than silently drawing fewer — when a category has fewer
 * slides than requested, since a short draw would quietly under-represent that category rather than
 * surface the PDF being too small for the requested sample.
 */
export function drawTranscriptionSample(
  categorized: CategorizedTranscriptionSlides,
  opts: DrawTranscriptionSampleOptions,
): DrawTranscriptionSampleResult {
  const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
  const rand = mulberry32(seed);

  const draw = (pool: number[], category: TranscriptionCategory): number[] => {
    if (pool.length < opts.perCategory) {
      throw new Error(
        `Category '${category}' has only ${pool.length} slide(s), fewer than --per-category ${opts.perCategory}`,
      );
    }
    return shuffle(pool, rand).slice(0, opts.perCategory).sort((a, b) => a - b);
  };

  return {
    slides: {
      'image-dominated': draw(categorized.imageDominated, 'image-dominated'),
      text: draw(categorized.text, 'text'),
      mixed: draw(categorized.mixed, 'mixed'),
    },
    seed,
  };
}

export interface BuildTranscriptionItemsOptions {
  pdfName: string;
  slides: Record<TranscriptionCategory, number[]>;
  textLayerBySlide: Map<number, string>;
  /** Slides the conversion report already flagged (low coverage) — carried onto the item as a note
   * for the reviewer, not used to change sampling or scoring. */
  flaggedSlides: Set<number>;
}

/**
 * One item per drawn slide, `item_key` `${pdfName}:${slide}`. Reference is left unset (`pending`) — a
 * transcription item's reference is a checked transcript, filled in later via `eval-review-export`/
 * `eval-review-import`, never known at creation time the way mapping's is.
 */
export function buildTranscriptionItems(opts: BuildTranscriptionItemsOptions): BuiltEvalItem[] {
  const items: BuiltEvalItem[] = [];
  for (const category of TRANSCRIPTION_CATEGORIES) {
    for (const slide of opts.slides[category]) {
      items.push({
        itemKey: `${opts.pdfName}:${slide}`,
        payload: {
          pdf_name: opts.pdfName,
          slide,
          category,
          text_layer: opts.textLayerBySlide.get(slide) ?? '',
          production_flagged: opts.flaggedSlides.has(slide),
        },
      });
    }
  }
  return items;
}
