// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_UPDATE_SOURCE,
  UPDATE_SOURCE_FILE,
  parseUpdateSource,
  readBakedUpdateSource,
  readUpdateSourceOverride,
  writeUpdateSourceOverride,
} from '../../apps/desktop/src/update-source.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cardmirror-update-source-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseUpdateSource', () => {
  it('accepts owner/repo and GitHub URLs', () => {
    const want = { owner: 'brian-cai', repo: 'cardmirror' };
    expect(parseUpdateSource('brian-cai/cardmirror')).toEqual(want);
    expect(parseUpdateSource('  brian-cai/cardmirror  ')).toEqual(want);
    expect(parseUpdateSource('https://github.com/brian-cai/cardmirror')).toEqual(want);
    expect(parseUpdateSource('github.com/brian-cai/cardmirror/releases/latest')).toEqual(want);
    expect(parseUpdateSource('https://github.com/brian-cai/cardmirror.git')).toEqual(want);
    expect(parseUpdateSource('git@github.com:brian-cai/cardmirror.git')).toEqual(want);
  });

  it('rejects anything that is not a repo', () => {
    expect(parseUpdateSource('')).toBeNull();
    expect(parseUpdateSource('brian-cai')).toBeNull();
    expect(parseUpdateSource('-bad/cardmirror')).toBeNull();
    expect(parseUpdateSource('owner/re po')).toBeNull();
    expect(parseUpdateSource('owner/..')).toBeNull();
  });
});

describe('update source override', () => {
  it('is null when no file exists', () => {
    expect(readUpdateSourceOverride(dir)).toBeNull();
  });

  const SPKI = 'MCowBQYDK2VwAyEAdO1qH+c7c/2+RpQqdyAsoeYeJWptaOkQvmoiDQjfins=';

  it('round-trips with its pinned key, and null clears it', () => {
    writeUpdateSourceOverride(dir, { owner: 'brian-cai', repo: 'cardmirror', spki: SPKI });
    expect(readUpdateSourceOverride(dir)).toEqual({ owner: 'brian-cai', repo: 'cardmirror', spki: SPKI });
    writeUpdateSourceOverride(dir, null);
    expect(existsSync(path.join(dir, UPDATE_SOURCE_FILE))).toBe(false);
    expect(readUpdateSourceOverride(dir)).toBeNull();
  });

  it('ignores a corrupt or wrong-shaped file', () => {
    writeFileSync(path.join(dir, UPDATE_SOURCE_FILE), '{ nope');
    expect(readUpdateSourceOverride(dir)).toBeNull();
    writeFileSync(path.join(dir, UPDATE_SOURCE_FILE), JSON.stringify({ owner: 'x' }));
    expect(readUpdateSourceOverride(dir)).toBeNull();
    writeFileSync(path.join(dir, UPDATE_SOURCE_FILE), JSON.stringify({ owner: 'a b', repo: 'c', spki: SPKI }));
    expect(readUpdateSourceOverride(dir)).toBeNull();
    // A source with no pinned key is never followed: an unsigned stream
    // can't be an override.
    writeFileSync(path.join(dir, UPDATE_SOURCE_FILE), JSON.stringify({ owner: 'brian-cai', repo: 'cardmirror' }));
    expect(readUpdateSourceOverride(dir)).toBeNull();
  });
});

describe('readBakedUpdateSource', () => {
  it("reads electron-builder's app-update.yml", () => {
    writeFileSync(
      path.join(dir, 'app-update.yml'),
      'owner: brian-cai\nrepo: cardmirror\nprovider: github\nupdaterCacheDirName: cardmirror-updater\n',
    );
    expect(readBakedUpdateSource(dir)).toEqual({ owner: 'brian-cai', repo: 'cardmirror' });
  });

  it('falls back to the official stream when missing or not GitHub', () => {
    expect(readBakedUpdateSource(dir)).toEqual(DEFAULT_UPDATE_SOURCE);
    writeFileSync(path.join(dir, 'app-update.yml'), 'provider: generic\nurl: https://example.com\n');
    expect(readBakedUpdateSource(dir)).toEqual(DEFAULT_UPDATE_SOURCE);
  });
});
