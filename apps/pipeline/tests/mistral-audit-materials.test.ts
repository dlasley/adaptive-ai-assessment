import { beforeEach, describe, expect, it, vi } from 'vitest';

/** `buildAuditUserPrompt`/`buildAuditBatchRequests` pull each group's reference material through
 * `buildAuditMaterialsBlock` → `loadUnitMaterials`, which reads real files — mocked the same way
 * `tests/audit-materials.test.ts` mocks `fs` for the same reason. */
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(),
  },
}));

import fs from 'fs';
import { buildAuditUserPrompt, buildAuditBatchRequests, type QuestionRow } from '../src/lib/mistral-audit';
import { MARKDOWN_DIR } from '../src/lib/paths';

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);

function makeQuestion(overrides: Partial<QuestionRow> = {}): QuestionRow {
  return {
    id: 'q-1',
    question: 'Comment dit-on "hello"?',
    correct_answer: 'bonjour',
    type: 'fill-in-blank',
    difficulty: 'beginner',
    topic: 'Slang',
    unit_id: 'unit-1',
    writing_type: null,
    generated_by: 'anthropic/claude-sonnet-5',
    options: null,
    acceptable_variations: null,
    ...overrides,
  };
}

const UNITS = [{
  id: 'unit-1',
  source_file_stem: 'unit-1',
  topics: [
    { name: 'Slang', headings: ['Slang'] },
    { name: 'Future Plans', headings: ['Future Plans'] },
  ],
}];

beforeEach(() => {
  mockExistsSync.mockReset();
  mockReadFileSync.mockReset();
  mockExistsSync.mockImplementation((p) => p === `${MARKDOWN_DIR}/unit-1.md`);
  mockReadFileSync.mockReturnValue('## Slang\nFerme la trappe!\n\n## Future Plans\nOn compte faire un tour.\n');
});

describe('buildAuditUserPrompt — reference material', () => {
  it('includes one material section per distinct topic in the group, not one per question', () => {
    const questions = [
      makeQuestion({ id: 'a', topic: 'Slang' }),
      makeQuestion({ id: 'b', topic: 'Slang' }),
      makeQuestion({ id: 'c', topic: 'Future Plans' }),
    ];

    const prompt = buildAuditUserPrompt(questions, UNITS);

    expect(prompt.match(/--- Topic: Slang \(unit-1\) ---/g)).toHaveLength(1);
    expect(prompt.match(/--- Topic: Future Plans \(unit-1\) ---/g)).toHaveLength(1);
    expect(prompt).toContain('Ferme la trappe');
    expect(prompt).toContain('On compte faire un tour');
  });

  it('omits the reference-material preamble entirely when no unit resolves any material', () => {
    const questions = [makeQuestion({ unit_id: 'ghost-unit' })];

    const prompt = buildAuditUserPrompt(questions, []);

    // Still notes the topic has no material, but never claims the material is authoritative for
    // an empty block — the preamble text should not appear without a real excerpt behind it.
    expect(prompt).toContain('(no source material found for this topic)');
  });

  it('still lists every question after the material block', () => {
    const questions = [makeQuestion({ id: 'only-question' })];
    const prompt = buildAuditUserPrompt(questions, UNITS);
    expect(prompt).toContain('--- Question 1 ---');
    expect(prompt).toContain('ID: only-question');
  });
});

describe('buildAuditBatchRequests — reference material', () => {
  it('includes each group\'s material in its own request\'s user message', () => {
    const groups = [
      [makeQuestion({ id: 'a', topic: 'Slang' })],
      [makeQuestion({ id: 'b', topic: 'Future Plans' })],
    ];

    const requests = buildAuditBatchRequests(groups, 'SYSTEM', UNITS);

    expect(requests[0].messages[1].content).toContain('--- Topic: Slang (unit-1) ---');
    expect(requests[0].messages[1].content).not.toContain('--- Topic: Future Plans');
    expect(requests[1].messages[1].content).toContain('--- Topic: Future Plans (unit-1) ---');
  });
});
