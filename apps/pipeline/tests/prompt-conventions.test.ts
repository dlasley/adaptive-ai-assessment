/**
 * Guards against the judge prompt's "Conventions the Transcription Prompt Mandates" section
 * silently drifting from the production transcription prompt it restates; see both prompts' own
 * doc comments for why the restatement exists. Anchors are pulled from the transcription prompt's
 * own text where practical, so a changed heading, format string, or exclusion category there fails
 * this test until the judge prompt is updated to match.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROMPTS_DIR } from '../src/lib/paths';

const transcriptionPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'content-transcribe-pdf-slide.md'), 'utf-8');
const judgePrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'eval-judge-transcription.md'), 'utf-8');

function section(markdown: string, heading: string): string {
  const match = markdown.match(new RegExp(`## ${heading}([\\s\\S]*?)\\n## `));
  if (!match) throw new Error(`"${heading}" section not found`);
  return match[1];
}

const conventions = section(judgePrompt, 'Conventions the Transcription Prompt Mandates');

/** Extracts each bold category name under the transcription prompt's "Content to EXCLUDE" list
 * ("Real person names" from "- **Real person names** — Remove all..."). "Purely decorative
 * imagery" is left out: the judge sees the slide image directly, so that exclusion has no
 * text-only convention for the judge prompt to restate. */
function exclusionCategories(): string[] {
  const names = [...section(transcriptionPrompt, 'Content to EXCLUDE').matchAll(/^- \*\*(.+?)\*\*/gm)].map((m) => m[1]);
  if (names.length === 0) throw new Error('found no bulleted categories under "Content to EXCLUDE"');
  return names.filter((name) => name !== 'Purely decorative imagery');
}

/** Significant words of `phrase`, lowercased with a trailing "s" stripped, so "names"/"name" and
 * "policies"/"policy"-shaped plural drift between the two prompts still matches. */
function significantWords(phrase: string): string[] {
  return (phrase.toLowerCase().match(/[a-z]+/g) ?? []).map((w) => w.replace(/s$/, ''));
}

/** Splits a markdown bullet list into its individual items (each starting a new top-level `- `),
 * trimmed of surrounding whitespace. */
function bulletItems(markdown: string): string[] {
  return markdown.split(/\n(?=- )/).map((s) => s.trim()).filter(Boolean);
}

describe('eval-judge-transcription.md conventions track content-transcribe-pdf-slide.md', () => {
  it('restates every exclusion category the transcription prompt mandates', () => {
    const conventionWords = new Set(significantWords(conventions));
    for (const category of exclusionCategories()) {
      for (const word of significantWords(category)) {
        expect(conventionWords, `expected the judge prompt's conventions to mention "${word}" (from exclusion category "${category}")`).toContain(word);
      }
    }
  });

  it('keeps the exclusion bullet stated as an omission, not as required content', () => {
    const exclusionBullet = bulletItems(conventions).find((b) => /\bomission\b|leaves these out/i.test(b));
    expect(exclusionBullet, 'expected a bullet describing the exclusions as an omission').toBeDefined();
    // Collapse the markdown's own line wrapping so "not" and "missing content" landing on
    // different source lines still reads as one phrase.
    expect(exclusionBullet!.replace(/\s+/g, ' ')).toMatch(/not missing content/i);
  });

  it('restates the Exercices/Réponses heading split literally', () => {
    expect(transcriptionPrompt).toContain('### Exercices');
    expect(transcriptionPrompt).toContain('### Réponses');
    expect(conventions).toContain('### Exercices');
    expect(conventions).toContain('### Réponses');
  });

  it('restates the vocabulary line format literally', () => {
    const literal = '- **word** - translation';
    expect(transcriptionPrompt).toContain(literal);
    expect(conventions).toContain(literal);
  });

  it('restates the no-document-level-title rule', () => {
    expect(transcriptionPrompt).toContain('document-level');
    expect(transcriptionPrompt).toContain('`#`');
    expect(conventions).toContain('document-level');
    expect(conventions).toContain('`#`');
  });

  it('restates the bilingual heading rule', () => {
    const literal = 'English descriptor';
    expect(transcriptionPrompt).toContain(literal);
    expect(conventions.toLowerCase()).toContain('bilingual');
    expect(conventions).toContain(literal);
  });

  it('restates markdown tables for conjugation and grammar content', () => {
    expect(transcriptionPrompt.toLowerCase()).toContain('conjugation');
    expect(transcriptionPrompt.toLowerCase()).toContain('grammar');
    expect(conventions.toLowerCase()).toContain('conjugation');
    expect(conventions.toLowerCase()).toContain('grammar');
    expect(conventions.toLowerCase()).toContain('markdown table');
  });

  it('states that formatting is never the deciding factor', () => {
    expect(judgePrompt).toContain('Formatting is never the deciding factor');
  });
});
