/**
 * PDF-to-markdown conversion utilities.
 *
 * Extracted from regenerate.ts — handles PDF text extraction,
 * chunking, Claude API conversion, and artifact cleanup.
 */

import Anthropic from '@anthropic-ai/sdk';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { MODELS } from './config';

// Load PDF-to-Markdown conversion prompt from file (single source of truth)
export const CONVERSION_PROMPT = fs.readFileSync(
  path.join(process.cwd(), 'scripts', 'prompts', 'pdf-to-markdown.md'),
  'utf-8'
) + '\n\nNow convert the following PDF text content to clean markdown:\n\n';

/**
 * Check if pdftotext is available
 */
export function checkPdftotext(): boolean {
  try {
    execSync('which pdftotext', { encoding: 'utf-8' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract text from PDF using pdftotext (from poppler)
 */
export function extractPdfText(pdfPath: string): string {
  try {
    const result = execSync(`pdftotext "${pdfPath}" -`, {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer
    });
    return result;
  } catch (error) {
    console.error(`  ❌ Error extracting text from ${path.basename(pdfPath)}:`, error);
    throw error;
  }
}

/**
 * Split pdftotext output into chunks using form feed page boundaries.
 * Groups pages so each chunk stays under maxCharsPerChunk.
 */
export function chunkPdfText(pdfText: string, maxCharsPerChunk: number = 15000): string[] {
  // pdftotext inserts form feed (\f) between pages
  const pages = pdfText.split('\f').filter(p => p.trim().length > 0);

  if (pages.length === 0) return [pdfText];

  const chunks: string[] = [];
  let currentChunk = '';

  for (const page of pages) {
    if (currentChunk.length + page.length > maxCharsPerChunk && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = '';
    }
    currentChunk += page + '\n\n';
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

/**
 * Clean common LLM artifacts from conversion output
 */
export function cleanConversionArtifacts(text: string): string {
  let cleaned = text;

  // Remove opening code fence
  if (cleaned.startsWith('```markdown')) {
    cleaned = cleaned.replace(/^```markdown\n?/, '');
  }
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\n?/, '');
  }

  // Remove closing code fence
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.replace(/\n?```$/, '');
  }

  // Remove introductory lines
  const introPatterns = [
    /^I'll convert this.*?\n+/i,
    /^Here's the.*?\n+/i,
    /^The PDF file.*?\n+/i,
    /^Perfect!.*?\n+/i,
    /^Now I'll.*?\n+/i,
  ];

  for (const pattern of introPatterns) {
    cleaned = cleaned.replace(pattern, '');
  }

  // Remove concluding summaries (after last ---)
  const lastSeparator = cleaned.lastIndexOf('\n---\n');
  if (lastSeparator !== -1) {
    const afterSeparator = cleaned.substring(lastSeparator + 5);
    if (
      afterSeparator.includes('This markdown preserves') ||
      afterSeparator.includes('Perfect for') ||
      afterSeparator.includes('The content above')
    ) {
      cleaned = cleaned.substring(0, lastSeparator + 5);
    }
  }

  return cleaned.trim();
}

/**
 * Convert a single chunk of PDF text to markdown using Claude
 */
async function convertChunkToMarkdown(
  anthropic: Anthropic,
  chunkText: string,
  pdfName: string,
  chunkIndex: number,
  totalChunks: number
): Promise<string> {
  const chunkContext = totalChunks > 1
    ? `\n\nNote: This is section ${chunkIndex + 1} of ${totalChunks} from ${pdfName}. Convert ALL content faithfully — do NOT summarize, skip exercises, or deduplicate. If a section continues from a previous chunk, just convert what you see.\n\n`
    : '\n\n';

  const message = await anthropic.messages.create({
    model: MODELS.pdfConversion,
    max_tokens: 16000,
    messages: [
      {
        role: 'user',
        content: CONVERSION_PROMPT + chunkContext + chunkText,
      },
    ],
  });

  const responseText = message.content[0].type === 'text' ? message.content[0].text : '';
  return cleanConversionArtifacts(responseText);
}

/**
 * Convert PDF text to markdown using Claude, chunking large inputs
 */
export async function convertPdfToMarkdown(
  anthropic: Anthropic,
  pdfText: string,
  pdfName: string
): Promise<string> {
  const chunks = chunkPdfText(pdfText);

  if (chunks.length === 1) {
    console.log(`  📝 Sending ${pdfName} to Claude for conversion (1 chunk)...`);
    return convertChunkToMarkdown(anthropic, chunks[0], pdfName, 0, 1);
  }

  console.log(`  📝 Sending ${pdfName} to Claude in ${chunks.length} chunks...`);
  const markdownParts: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    console.log(`     Chunk ${i + 1}/${chunks.length} (${chunks[i].length.toLocaleString()} chars)...`);
    const md = await convertChunkToMarkdown(anthropic, chunks[i], pdfName, i, chunks.length);
    markdownParts.push(md);

    // Rate limit delay between chunks
    if (i < chunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  return markdownParts.join('\n\n---\n\n');
}
