import fs from 'fs';
import path from 'path';
import { units } from './units';

/**
 * Look up heading patterns for a topic from units.ts
 */
function getTopicHeadings(topic: string): string[] {
  for (const unit of units) {
    const found = unit.topics.find(t => t.name === topic);
    if (found) return found.headings;
  }
  return [];
}

/**
 * Derive the markdown filename for a unit ID.
 * Follows the naming convention used by regenerate.ts (line 536).
 */
function getMarkdownFilename(unitId: string): string {
  if (unitId === 'introduction') return 'French 1 Introduction.md';
  const num = unitId.replace('unit-', '');
  return `French 1 Unit ${num}.md`;
}

/**
 * Load learning materials for a specific unit
 */
export function loadUnitMaterials(unitId: string): string {
  try {
    const fileName = getMarkdownFilename(unitId);
    const filePath = path.join(process.cwd(), 'learnings', fileName);
    const content = fs.readFileSync(filePath, 'utf-8');
    return content;
  } catch (error) {
    console.error(`Error loading materials for unit ${unitId}:`, error);
    throw new Error(`Failed to load learning materials for unit: ${unitId}`);
  }
}

/**
 * Extract relevant content for a specific topic from the unit materials
 */
export function extractTopicContent(materials: string, topic: string): string {
  // Split content into sections
  const lines = materials.split('\n');
  const relevantLines: string[] = [];
  let isRelevant = false;
  let sectionDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if this line is a heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = headingMatch[2];

      // Check if this heading is relevant to the topic
      if (headingText.toLowerCase().includes(topic.toLowerCase()) ||
          topic.toLowerCase().includes(headingText.toLowerCase())) {
        isRelevant = true;
        sectionDepth = level;
        relevantLines.push(line);
      } else if (isRelevant && level <= sectionDepth) {
        // We've reached a new section at the same or higher level
        break;
      } else if (isRelevant) {
        relevantLines.push(line);
      }
    } else if (isRelevant) {
      relevantLines.push(line);
    }
  }

  // If we found specific content, return it
  if (relevantLines.length > 10) {
    return relevantLines.join('\n');
  }

  // Fallback: try heading patterns from centralized topic-headings mapping
  const aliases = getTopicHeadings(topic);

  // Try matching with aliases
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

    if (headingMatch) {
      const headingText = headingMatch[2].toLowerCase();
      const hasAlias = aliases.some(alias => headingText.includes(alias));

      if (hasAlias) {
        // Found a match via alias - extract this section
        const level = headingMatch[1].length;
        const sectionLines: string[] = [line];

        for (let j = i + 1; j < lines.length; j++) {
          const nextLine = lines[j];
          const nextHeading = nextLine.match(/^(#{1,6})\s+/);
          if (nextHeading && nextHeading[1].length <= level) {
            break;
          }
          sectionLines.push(nextLine);
        }

        if (sectionLines.length > 10) {
          console.log(`    ℹ️  Found topic "${topic}" via alias match in heading`);
          return sectionLines.join('\n');
        }
      }
    }
  }

  // No match found - log warning and return empty to trigger skip
  console.warn(`    ⚠️  No content found for topic "${topic}" - questions may be off-topic`);

  // Return a minimal prompt that instructs Claude to work from general knowledge
  return `Topic: ${topic}\n\nNote: No specific learning materials found for this topic. Generate questions based on standard French 1 curriculum content for this topic.`;
}

/**
 * Extract YouTube links from learning materials for a specific topic
 */
export function extractYouTubeLinks(materials: string, topic?: string): { url: string; title: string }[] {
  const content = topic ? extractTopicContent(materials, topic) : materials;
  const lines = content.split('\n');
  const youtubeLinks: { url: string; title: string }[] = [];

  // Regular expressions to match YouTube URLs
  const youtubeRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]+)/g;

  let currentSection = '';

  for (const line of lines) {
    // Track current section header for context
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      currentSection = headingMatch[2].replace(/\*\*/g, '').trim();
    }

    // Find YouTube links
    const matches = line.matchAll(youtubeRegex);
    for (const match of matches) {
      const url = match[0].startsWith('http') ? match[0] : `https://${match[0]}`;
      const title = currentSection || topic || 'Video Resource';

      // Avoid duplicates
      if (!youtubeLinks.some(link => link.url === url)) {
        youtubeLinks.push({ url, title });
      }
    }
  }

  return youtubeLinks;
}
