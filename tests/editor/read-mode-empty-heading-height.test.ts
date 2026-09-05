/**
 * Read mode hides ProseMirror's trailing line break (the <br> in every
 * empty textblock) so empty body/cite paragraphs flow away. That rule
 * must NOT reach heading blocks: an empty pocket / hat / block / tag /
 * analytic has nothing else to set its height, and hiding the break
 * shrank an empty pocket to its padding in read mode (field report
 * 2026-09-05). jsdom does no layout, so this pins the stylesheet: the
 * hide rule exists, and a LATER rule restores the break inside every
 * heading block class.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('../../src/editor/style.css', import.meta.url)), 'utf8');

describe('read mode keeps an empty heading block at full height', () => {
  it('re-shows the trailing break inside every heading block class, after the hide rule', () => {
    const hide = css.indexOf('.pmd-read-mode .ProseMirror-trailingBreak {\n  display: none;');
    expect(hide, 'the read-mode trailing-break hide rule').toBeGreaterThan(-1);
    const restore = css.search(/\.pmd-read-mode :is\(([^)]*)\) > \.ProseMirror-trailingBreak \{\n  display: revert;/u);
    expect(restore, 'a rule restoring the break inside heading blocks').toBeGreaterThan(hide);
    const classes = css.slice(restore).match(/:is\(([^)]*)\)/u)![1]!;
    for (const heading of ['.pmd-pocket', '.pmd-hat', '.pmd-block', '.pmd-tag', '.pmd-analytic']) {
      expect(classes, `${heading} keeps its trailing break`).toContain(heading);
    }
  });
});
