import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Expo does not support two React Native versions in one monorepo, and two copies of React in one
// app fail at run time even when they share a version, because each copy keeps its own internal
// state. The web app and the Expo app share the hoisted node_modules, so the root `overrides` pin
// both apps to the React version the Expo SDK requires; this test fails if any of these packages
// is installed in more than one place.

const repoRoot = path.resolve(__dirname, '..');

interface QueryNode {
  version: string;
  location: string;
}

/** Every installed copy of `name` under `cwd`, from `npm query '#<name>'`. */
function installedCopies(cwd: string, name: string): QueryNode[] {
  let output: string;
  try {
    output = execFileSync('npm', ['query', `#${name}`], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    if (!stdout) throw error;
    output = stdout;
  }
  return (JSON.parse(output) as QueryNode[])
    .map(({ version, location }) => ({ version, location }))
    .sort((a, b) => a.location.localeCompare(b.location));
}

function writePackage(dir: string, manifest: Record<string, unknown>) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
}

/** A throwaway install with React at the top and a second copy nested under `legacy`. */
function withNestedReact(nestedVersion: string, check: (dir: string) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), 'single-react-copy-'));
  try {
    writePackage(dir, { name: 'fixture', version: '1.0.0', dependencies: { react: '19.2.3', legacy: '1.0.0' } });
    writePackage(path.join(dir, 'node_modules/react'), { name: 'react', version: '19.2.3' });
    writePackage(path.join(dir, 'node_modules/legacy'), {
      name: 'legacy',
      version: '1.0.0',
      dependencies: { react: nestedVersion },
    });
    writePackage(path.join(dir, 'node_modules/legacy/node_modules/react'), { name: 'react', version: nestedVersion });
    check(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('single React copy', { timeout: 60_000 }, () => {
  it.each(['react', 'react-dom', 'react-native'])('installs %s in exactly one place', (name) => {
    expect(installedCopies(repoRoot, name)).toEqual([{ version: expect.any(String), location: `node_modules/${name}` }]);
  });

  it('detects a second copy at a different version', () => {
    withNestedReact('18.3.1', (dir) => {
      expect(installedCopies(dir, 'react')).toEqual([
        { version: '18.3.1', location: 'node_modules/legacy/node_modules/react' },
        { version: '19.2.3', location: 'node_modules/react' },
      ]);
    });
  });

  it('detects a second copy at the same version', () => {
    withNestedReact('19.2.3', (dir) => {
      expect(installedCopies(dir, 'react')).toHaveLength(2);
    });
  });
});
