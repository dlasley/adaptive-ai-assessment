#!/usr/bin/env npx tsx
/**
 * Extract Learning Resources from Markdown Files
 *
 * Scans learning material markdown files for URLs (YouTube and others),
 * maps them to topics using the same exact-heading matching as question generation,
 * and inserts them into the learning_resources database table.
 */

import { createHash } from 'crypto';
import {
  loadUnitMaterials,
  extractTopicContent,
  findUnitHeadingMismatches,
  formatHeadingPreflightError,
} from '../lib/learning-materials';
import { createScriptSupabase } from '../lib/db-queries';
import type { Unit } from '@adaptive/shared/types';
import { defineCli } from '../lib/options/define-cli';
import { dbTargetFlags, loggingFlags } from '../lib/options/groups';
import { createLogger } from '../lib/logger';
import { bootstrapCommand } from '../lib/command-bootstrap';
import { runIfMain } from '../lib/run-if-main';

const logger = createLogger('content-extract-resources');

// ─── Types ──────────────────────────────────────────────────────────────────

interface ExtractedResource {
  unit_id: string;
  topic: string;
  resource_type: 'video' | 'article' | 'audio' | 'interactive';
  url: string;
  title: string;
  provider: string;
  metadata: Record<string, unknown>;
  content_hash: string;
  source_file: string;
}

// ─── URL Detection ──────────────────────────────────────────────────────────

const YOUTUBE_REGEX = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]+)/g;
const GENERAL_URL_REGEX = /https?:\/\/[^\s)\]>,"']+/g;

const VIDEO_DOMAINS = new Set(['youtube.com', 'youtu.be', 'vimeo.com', 'dailymotion.com']);

function classifyUrl(url: string): { type: 'video' | 'article'; provider: string } {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    if (VIDEO_DOMAINS.has(hostname) || hostname.endsWith('youtube.com')) {
      return { type: 'video', provider: hostname.replace('.com', '').replace('.be', '') };
    }
    return { type: 'article', provider: hostname };
  } catch {
    return { type: 'article', provider: 'unknown' };
  }
}

function isYouTubeShort(url: string): boolean {
  return url.includes('/shorts/');
}

function extractYouTubeVideoId(url: string): string | null {
  const watchMatch = url.match(/[?&]v=([a-zA-Z0-9_-]+)/);
  if (watchMatch) return watchMatch[1];
  const shortsMatch = url.match(/\/shorts\/([a-zA-Z0-9_-]+)/);
  if (shortsMatch) return shortsMatch[1];
  const shortUrlMatch = url.match(/youtu\.be\/([a-zA-Z0-9_-]+)/);
  if (shortUrlMatch) return shortUrlMatch[1];
  return null;
}

// ─── Content Hash ───────────────────────────────────────────────────────────

function computeContentHash(url: string, unitId: string, topic: string): string {
  const normalized = `${url.toLowerCase().trim()}|${unitId}|${topic}`;
  return createHash('md5').update(normalized).digest('hex');
}

// ─── Extraction ─────────────────────────────────────────────────────────────

/**
 * Extract all URLs from markdown text, tracking the nearest heading as title.
 */
function extractUrlsFromContent(
  content: string,
  fallbackTitle: string,
): { url: string; title: string }[] {
  const lines = content.split('\n');
  const results: { url: string; title: string }[] = [];
  const seenUrls = new Set<string>();
  let currentSection = fallbackTitle;

  for (const line of lines) {
    // Track section headings for title derivation
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      currentSection = headingMatch[2].replace(/\*\*/g, '').trim();
    }

    // Check for markdown link text: [title](url)
    const linkMatches = line.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g);
    for (const lm of linkMatches) {
      let url = lm[2].replace(/[.,;:!?)]+$/, '');
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        results.push({ url, title: lm[1].trim() });
      }
    }

    // Find bare URLs (not already captured via markdown links)
    const matches = line.matchAll(GENERAL_URL_REGEX);
    for (const match of matches) {
      let url = match[0];
      // Clean trailing punctuation that's not part of the URL
      url = url.replace(/[.,;:!?)]+$/, '');
      // Ensure https
      if (!url.startsWith('http')) url = `https://${url}`;

      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        results.push({ url, title: currentSection });
      }
    }
  }

  return results;
}

/**
 * Extract resources for a single unit, mapping to topics.
 */
function extractForUnit(unitId: string, units: Unit[]): ExtractedResource[] {
  const unit = units.find(u => u.id === unitId);
  if (!unit) {
    logger.warn(`Unit ${unitId} not found in DB`);
    return [];
  }

  let materials: string;
  try {
    materials = loadUnitMaterials(unitId, units);
  } catch (err) {
    logger.warn(`Could not load materials for ${unitId}`, { error: err });
    return [];
  }

  const sourceFile = unit.source_file_stem
    ? `content/markdown/${unit.source_file_stem}.md`
    : `content/markdown/${unitId}.md`;

  const resources: ExtractedResource[] = [];
  const capturedUrls = new Set<string>();

  // Pass 1: Extract URLs per topic section
  for (const topic of unit.topics) {
    const topicContent = extractTopicContent(materials, topic.name, units);

    // No section matched this topic's headings (or name, for unmapped topics) — nothing to scan.
    if (!topicContent) {
      continue;
    }

    const urls = extractUrlsFromContent(topicContent, topic.name);
    for (const { url, title } of urls) {
      const classification = classifyUrl(url);
      const metadata: Record<string, unknown> = {};

      if (classification.provider === 'youtube' || classification.provider === 'youtu') {
        const videoId = extractYouTubeVideoId(url);
        if (videoId) metadata.videoId = videoId;
        if (isYouTubeShort(url)) metadata.isShort = true;
      }

      resources.push({
        unit_id: unitId,
        topic: topic.name,
        resource_type: classification.type,
        url,
        title,
        provider: classification.provider,
        metadata,
        content_hash: computeContentHash(url, unitId, topic.name),
        source_file: sourceFile,
      });

      capturedUrls.add(url);
    }
  }

  // Pass 2: Leftover scan — URLs not captured by any topic section
  const allUrls = extractUrlsFromContent(materials, unit.title);
  for (const { url, title } of allUrls) {
    if (capturedUrls.has(url)) continue;

    const classification = classifyUrl(url);
    const metadata: Record<string, unknown> = {};

    if (classification.provider === 'youtube' || classification.provider === 'youtu') {
      const videoId = extractYouTubeVideoId(url);
      if (videoId) metadata.videoId = videoId;
      if (isYouTubeShort(url)) metadata.isShort = true;
    }

    resources.push({
      unit_id: unitId,
      topic: 'General',
      resource_type: classification.type,
      url,
      title,
      provider: classification.provider,
      metadata,
      content_hash: computeContentHash(url, unitId, 'General'),
      source_file: sourceFile,
    });
  }

  return resources;
}

/**
 * Every topic with stored headings, across `targetUnits`, must resolve against its unit's
 * current markdown. A topic whose headings don't validate would otherwise silently scan zero
 * content (`extractTopicContent` returns empty, treated by `extractForUnit` as "nothing to
 * scan") — this turns that into a hard failure naming the unit. A unit with no markdown file at
 * all is left to the warning `extractForUnit` already logs for it, not treated as a
 * heading-validation failure.
 */
export function preflightHeadings(units: Unit[], targetUnits: Unit[]): void {
  for (const unit of targetUnits) {
    let materials: string;
    try {
      materials = loadUnitMaterials(unit.id, units);
    } catch {
      continue;
    }
    const mismatches = findUnitHeadingMismatches(materials, unit.topics);
    if (mismatches.length > 0) {
      logger.error(formatHeadingPreflightError(unit.id, mismatches));
      process.exit(1);
    }
  }
}

// ─── CLI ────────────────────────────────────────────────────────────────────

export const cli = defineCli(
  {
    ...dbTargetFlags,
    unit: { type: 'string', help: 'Extract for a specific unit (default: all)', group: 'Filters' },
    'dry-run': {
      type: 'boolean',
      default: false,
      help: 'Show what would be extracted (default unless --write-db)',
    },
    force: { type: 'boolean', default: false, help: 'Re-extract even if resources exist' },
    ...loggingFlags,
  },
  {
    name: 'content-extract-resources',
    description: 'Extract learning resources (YouTube URLs, etc.) from markdown files.',
    examples: [
      'npx tsx apps/pipeline/src/commands/content-extract-resources.ts --unit unit-2 --write-db',
      'npx tsx apps/pipeline/src/commands/content-extract-resources.ts --dry-run',
    ],
  },
);

async function main() {
  const { options, units } = await bootstrapCommand(cli, { units: true });
  // Dry-run unless --write-db, matching every other write-capable script in this repo.
  const dryRun = options.writeDb ? options.dryRun : true;

  console.log('📚 Learning Resource Extraction');
  console.log('================================');
  if (dryRun) {
    console.log('Mode: DRY RUN (use --write-db to insert)');
  } else {
    console.log('Mode: WRITE TO DB');
  }
  console.log();

  // Determine which units to process
  const targetUnits = options.unit
    ? units.filter(u => u.id === options.unit)
    : units;

  if (targetUnits.length === 0) {
    logger.error(`Unit "${options.unit}" not found`);
    process.exit(1);
  }

  preflightHeadings(units, targetUnits);

  // Extract resources
  const allResources: ExtractedResource[] = [];

  for (const unit of targetUnits) {
    console.log(`\n📂 ${unit.title} (${unit.id})`);
    const resources = extractForUnit(unit.id, units);
    allResources.push(...resources);

    // Summary per unit
    const byTopic = new Map<string, number>();
    for (const r of resources) {
      byTopic.set(r.topic, (byTopic.get(r.topic) || 0) + 1);
    }

    for (const [topic, count] of byTopic.entries()) {
      const topicResources = resources.filter(r => r.topic === topic);
      const videos = topicResources.filter(r => r.resource_type === 'video').length;
      const articles = topicResources.filter(r => r.resource_type === 'article').length;
      const parts = [];
      if (videos > 0) parts.push(`${videos} video${videos > 1 ? 's' : ''}`);
      if (articles > 0) parts.push(`${articles} article${articles > 1 ? 's' : ''}`);
      console.log(`  ${topic}: ${parts.join(', ')}`);
    }

    if (resources.length === 0) {
      console.log('  (no resources found)');
    }
  }

  // Overall summary
  const totalVideos = allResources.filter(r => r.resource_type === 'video').length;
  const totalArticles = allResources.filter(r => r.resource_type === 'article').length;
  const totalGeneral = allResources.filter(r => r.topic === 'General').length;
  const shorts = allResources.filter(r => r.metadata.isShort).length;

  console.log('\n================================');
  console.log(`Total: ${allResources.length} resources`);
  console.log(`  Videos: ${totalVideos} (${shorts} shorts)`);
  console.log(`  Articles: ${totalArticles}`);
  if (totalGeneral > 0) {
    console.log(`  Uncategorized (General): ${totalGeneral}`);
  }

  // Write to DB
  if (options.writeDb) {
    console.log('\n📝 Writing to database...');
    const supabase = createScriptSupabase({ write: true });

    // Fetch existing content hashes for dedup
    const { data: existing, error: fetchErr } = await supabase
      .from('learning_resources')
      .select('content_hash');

    if (fetchErr) {
      logger.error('Failed to fetch existing resources', { message: fetchErr.message });
      process.exit(1);
    }

    const existingHashes = new Set((existing || []).map(r => r.content_hash));

    // Filter to new resources only (unless --force)
    const toInsert = options.force
      ? allResources
      : allResources.filter(r => !existingHashes.has(r.content_hash));

    const duplicates = allResources.length - toInsert.length;
    if (duplicates > 0) {
      console.log(`  Skipping ${duplicates} duplicate${duplicates > 1 ? 's' : ''}`);
    }

    if (toInsert.length === 0) {
      console.log('  No new resources to insert.');
      return;
    }

    // Create batch record first (FK constraint requires it)
    const batchId = `resources_${new Date().toISOString().split('T')[0]}_${Date.now()}`;
    const { error: batchErr } = await supabase
      .from('batches')
      .insert({
        id: batchId,
        description: `Learning resource extraction (${toInsert.length} resources)`,
        question_count: toInsert.length,
        inserted_count: 0,
      });

    if (batchErr) {
      logger.error('Failed to create batch record', { message: batchErr.message });
      process.exit(1);
    }

    const rows = toInsert.map(r => ({
      ...r,
      batch_id: batchId,
    }));

    // Insert in chunks of 100
    const CHUNK_SIZE = 100;
    let insertedTotal = 0;

    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      const { error: insertErr } = await supabase
        .from('learning_resources')
        .insert(chunk);

      if (insertErr) {
        logger.error(`Insert failed for chunk ${Math.floor(i / CHUNK_SIZE) + 1}`, { message: insertErr.message });
      } else {
        insertedTotal += chunk.length;
      }
    }

    // Update batch record with actual counts
    await supabase
      .from('batches')
      .update({ inserted_count: insertedTotal, duplicate_count: duplicates })
      .eq('id', batchId);

    console.log(`\n✅ Inserted ${insertedTotal} resources (batch: ${batchId})`);
    console.log(`   Duplicates skipped: ${duplicates}`);
  }
}

runIfMain(import.meta.url, main);
