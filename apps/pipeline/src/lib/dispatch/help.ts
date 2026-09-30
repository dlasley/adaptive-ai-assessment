/**
 * Formats the top-level `pipeline` / `pipeline --help` command listing, grouped by area.
 */

import { groupByArea } from './discovery';
import type { CommandMeta } from './types';

export function formatHelp(commands: CommandMeta[]): string {
  const lines: string[] = [];
  lines.push('pipeline — content pipeline dispatcher for apps/pipeline');
  lines.push('');
  lines.push('Usage:');
  lines.push('  pipeline                         Guided mode (interactive, at a TTY)');
  lines.push('  pipeline <command> [options]      Run a command (same argv/exit code as');
  lines.push('                                     npx tsx apps/pipeline/src/commands/<command>.ts [options])');
  lines.push('  pipeline <command> --help         Show that command\'s full options');
  lines.push('  pipeline completion zsh|bash      Print a shell completion script');
  lines.push('  pipeline completion               Print completion install instructions');
  lines.push('');
  lines.push('Commands:');

  const nameWidth = Math.max(0, ...commands.map((c) => c.name.length));
  for (const group of groupByArea(commands)) {
    lines.push('');
    lines.push(`  ${group.label}:`);
    for (const command of group.commands) {
      lines.push(`    ${command.name.padEnd(nameWidth)}  ${command.description}`);
    }
  }

  return lines.join('\n');
}
