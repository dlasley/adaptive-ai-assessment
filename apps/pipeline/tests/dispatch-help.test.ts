import { describe, expect, it } from 'vitest';
import { formatHelp } from '../src/lib/dispatch/help';
import type { CommandMeta } from '../src/lib/dispatch/types';

const FIXTURE_COMMANDS: CommandMeta[] = [
  { name: 'pipeline-run', area: 'pipeline', description: 'Run the full pipeline.' },
  { name: 'content-suggest-topics', area: 'content', description: 'Suggest topics.' },
  { name: 'content-extract-resources', area: 'content', description: 'Extract resources.' },
  { name: 'audit-compare', area: 'audit', description: 'Compare Sonnet and Mistral audit results.' },
];

describe('formatHelp', () => {
  const output = formatHelp(FIXTURE_COMMANDS);

  it('lists every command name and its description', () => {
    for (const command of FIXTURE_COMMANDS) {
      expect(output).toContain(command.name);
      expect(output).toContain(command.description);
    }
  });

  it('groups commands under their area label, in AREAS display order', () => {
    const pipelineIndex = output.indexOf('Pipeline:');
    const contentIndex = output.indexOf('Content:');
    const auditIndex = output.indexOf('Audit:');
    expect(pipelineIndex).toBeGreaterThan(-1);
    expect(contentIndex).toBeGreaterThan(pipelineIndex);
    expect(auditIndex).toBeGreaterThan(contentIndex);
  });

  it('omits area headings with no commands', () => {
    expect(output).not.toContain('Questions:');
    expect(output).not.toContain('Database:');
  });

  it('documents the guided-mode, direct-command, and completion invocation forms', () => {
    expect(output).toContain('pipeline <command> [options]');
    expect(output).toContain('pipeline completion zsh|bash');
    expect(output).toContain('Guided mode');
  });
});
