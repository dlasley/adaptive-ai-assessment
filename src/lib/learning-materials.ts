import fs from 'fs';
import path from 'path';

// Map unit IDs to their corresponding markdown files
const UNIT_FILE_MAP: Record<string, string> = {
  'introduction': 'French 1 Introduction.md',
  'unit-2': 'French 1 Unit 2.md',
  'unit-3': 'French 1 Unit 3.md',
};

/**
 * Load learning materials for a specific unit
 */
export function loadUnitMaterials(unitId: string): string {
  try {
    const fileName = UNIT_FILE_MAP[unitId];
    if (!fileName) {
      throw new Error(`Unknown unit ID: ${unitId}`);
    }

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

  // Otherwise, return a broader section of the materials
  return materials.slice(0, 3000); // First 3000 characters as fallback
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

/**
 * Get YouTube resources for multiple topics from a unit
 */
export function getTopicResources(unitId: string, topics: string[]): Record<string, { url: string; title: string }[]> {
  try {
    const materials = loadUnitMaterials(unitId);
    const resources: Record<string, { url: string; title: string }[]> = {};

    for (const topic of topics) {
      const links = extractYouTubeLinks(materials, topic);
      if (links.length > 0) {
        resources[topic] = links;
      }
    }

    return resources;
  } catch (error) {
    console.error(`Error getting topic resources for unit ${unitId}:`, error);
    return {};
  }
}
