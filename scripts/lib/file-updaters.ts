/**
 * Pure functions for inserting entries into units.ts.
 *
 * These take current file content + new data and return updated content.
 * No filesystem I/O — callers handle reading/writing.
 */

interface TopicData {
  name: string;
  headings: string[];
}

interface UnitData {
  id: string;
  title: string;
  label: string;
  description: string;
  topics: TopicData[];
}

/**
 * Insert a new unit entry into units.ts content.
 * Returns null if the unit ID already exists.
 */
export function insertUnitEntry(
  currentContent: string,
  unitData: UnitData
): string | null {
  // Check if unit already exists
  if (currentContent.includes(`id: '${unitData.id}'`)) {
    return null;
  }

  // Escape single quotes in all string values
  const esc = (s: string) => s.replace(/'/g, "\\'");

  // Build the topic lines as { name, headings } objects
  const topicLines = unitData.topics
    .map((t) => {
      const headingsStr = t.headings.map((h) => `'${esc(h)}'`).join(', ');
      return `      { name: '${esc(t.name)}', headings: [${headingsStr}] },`;
    })
    .join('\n');

  const entry = `  {
    id: '${esc(unitData.id)}',
    title: '${esc(unitData.title)}',
    label: '${esc(unitData.label)}',
    description: '${esc(unitData.description)}',
    topics: [
${topicLines}
    ],
  },`;

  // Find the closing ]; and insert before it
  const closingIndex = currentContent.lastIndexOf('];');
  if (closingIndex === -1) {
    throw new Error('Could not find closing ]; in units.ts content');
  }

  return (
    currentContent.slice(0, closingIndex) +
    entry +
    '\n' +
    currentContent.slice(closingIndex)
  );
}
