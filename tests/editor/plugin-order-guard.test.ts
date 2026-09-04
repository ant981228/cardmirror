/**
 * Tripwire: the heading-id guard must precede the collab binding in the
 * editor's plugin list. The guard skips any apply cycle that already
 * holds a binding-stamped transaction, so with the Loro sync plugin
 * ahead of it the guard is silently inert inside every co-editing
 * session (measured 2026-09-04: sync→guard leaves a duplicate-id insert
 * unrepaired; guard→sync re-mints it). index.ts builds the base list
 * first and appends `collabPluginsFor(...)` last; this pins that order
 * at the source level, since the assembly function isn't callable in
 * isolation.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

describe('editor plugin order: heading-id guard before the collab binding', () => {
  it('index.ts lists headingIdGuardPlugin before plugins.push(...collabPluginsFor(...))', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '../../src/editor/index.ts'), 'utf8');
    const guardAt = src.indexOf('\n    headingIdGuardPlugin,');
    const collabAt = src.indexOf('plugins.push(...collabPluginsFor(');
    expect(guardAt, 'guard is in the base plugin list').toBeGreaterThan(0);
    expect(collabAt, 'collab plugins are appended').toBeGreaterThan(0);
    expect(guardAt).toBeLessThan(collabAt);
    // And nothing appends collab plugins before the base list is built.
    expect(src.indexOf('collabPluginsFor(')).toBeGreaterThanOrEqual(src.indexOf('const plugins: Plugin[] = ['));
  });
});
