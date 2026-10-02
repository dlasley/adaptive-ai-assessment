import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const RUN_IF_MAIN = path.resolve(import.meta.dirname, '../src/lib/run-if-main.ts');

function tsxCli(): string {
  const packageJson = require.resolve('tsx/package.json');
  const { bin } = require(packageJson) as { bin: string };
  return path.join(path.dirname(packageJson), bin);
}

function run(scriptPath: string, cwd: string) {
  return spawnSync(process.execPath, [tsxCli(), scriptPath], { cwd, encoding: 'utf-8' });
}

describe('runIfMain', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'run-if-main-')));
    fs.mkdirSync(path.join(tmp, 'real'));
    fs.writeFileSync(
      path.join(tmp, 'real', 'entry.mts'),
      `import { runIfMain } from ${JSON.stringify(RUN_IF_MAIN)};\nrunIfMain(import.meta.url, async () => { console.log('main ran'); });\n`,
    );
    fs.writeFileSync(
      path.join(tmp, 'real', 'imported.mts'),
      `import ${JSON.stringify(path.join(tmp, 'real', 'entry.mts'))};\nconsole.log('importer ran');\n`,
    );
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('runs main when the file is the entry point', () => {
    const result = run(path.join(tmp, 'real', 'entry.mts'), tmp);
    expect(result.stdout).toContain('main ran');
  });

  it('runs main when the entry point is reached through a symlinked directory', () => {
    fs.symlinkSync(path.join(tmp, 'real'), path.join(tmp, 'link'));
    const result = run(path.join(tmp, 'link', 'entry.mts'), tmp);
    expect(result.stdout).toContain('main ran');
  });

  it('runs main when the entry file itself is a symlink', () => {
    fs.symlinkSync(path.join(tmp, 'real', 'entry.mts'), path.join(tmp, 'entry-link.mts'));
    const result = run(path.join(tmp, 'entry-link.mts'), tmp);
    expect(result.stdout).toContain('main ran');
  });

  it('does not run main when the file is only imported', () => {
    const result = run(path.join(tmp, 'real', 'imported.mts'), tmp);
    expect(result.stdout).toContain('importer ran');
    expect(result.stdout).not.toContain('main ran');
  });
});
