/**
 * Underline color overrides (Analytic from PR #118; Tag and Cite added
 * on merge). The behaviour lives in style.css, which jsdom cannot
 * evaluate (no var() resolution), so this pins the stylesheet's
 * structure instead:
 *  - the three tokens are offered under Color overrides → Document text
 *  - style.css never DEFINES them, so unset means "follow the text"
 *  - each context publishes its own inherited variable: analytics, tag
 *    paragraphs, and the cite MARK (never the cite paragraph)
 *  - every line-drawing rule reads them innermost-first with
 *    currentColor as the final fallback
 *  - highlight / shading bands never defer to an override
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CUSTOMIZABLE_COLOR_TOKENS } from '../../src/editor/settings.js';

const css = readFileSync(
  fileURLToPath(new URL('../../src/editor/style.css', import.meta.url)),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, ''); // comments mention the names freely

const CHAIN =
  'var(--pmd-cite-underline, var(--pmd-analytic-underline, var(--pmd-tag-underline, currentColor)))';

/** Declaration block of the first rule whose selector text is `selector`. */
function block(selector: string): string {
  const at = css.indexOf(selector + ' {');
  if (at < 0) throw new Error(`no rule for ${selector}`);
  return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
}

describe('underline color override tokens', () => {
  it('are offered under Document text, in analytic / tag / cite order', () => {
    const lines = CUSTOMIZABLE_COLOR_TOKENS.filter((t) => t.name.endsWith('-underline'));
    expect(lines.map((t) => [t.group, t.name, t.label])).toEqual([
      ['Document text', 'pmd-c-analytic-underline', 'Analytic underline'],
      ['Document text', 'pmd-c-tag-underline', 'Tag underline'],
      ['Document text', 'pmd-c-cite-underline', 'Cite underline'],
    ]);
  });

  it('are left unset by the stylesheet', () => {
    expect(css).not.toMatch(/--pmd-c-(analytic|tag|cite)-underline\s*:/);
  });
});

describe('contexts publish their token', () => {
  it('analytic paragraphs and analytic runs', () => {
    expect(css).toMatch(
      /\.pmd-analytic,\s*\.pmd-analytic-mark\s*\{\s*--pmd-analytic-underline:\s*var\(--pmd-c-analytic-underline\);\s*\}/,
    );
  });

  it('tag paragraphs', () => {
    expect(css).toMatch(/\.pmd-tag\s*\{\s*--pmd-tag-underline:\s*var\(--pmd-c-tag-underline\);\s*\}/);
  });

  it('the cite mark, and nothing keyed on the cite paragraph', () => {
    expect(css).toMatch(/\.pmd-cite\s*\{\s*--pmd-cite-underline:\s*var\(--pmd-c-cite-underline\);\s*\}/);
    expect(css).not.toMatch(/\.pmd-cite-para[^{]*\{[^}]*--pmd-(c-)?cite-underline/);
  });
});

describe('line-drawing rules', () => {
  it.each([
    '.ProseMirror u',
    '.pmd-underline',
    '.pmd-emphasis',
    '#editor.pmd-cite-underlined .pmd-cite',
    'html.pmd-cite-underlined .pmd-pane-editor .pmd-cite',
  ])('%s reads cite, then analytic, then tag, then the text color', (selector) => {
    expect(block(selector)).toContain(`text-decoration-color: ${CHAIN};`);
  });

  it('use that one chain everywhere an override is consulted', () => {
    const uses = css.match(/text-decoration-color:[^;]*--pmd-(cite|analytic|tag)-underline[^;]*;/g) ?? [];
    expect(uses.length).toBe(5);
    for (const use of uses) expect(use).toBe(`text-decoration-color: ${CHAIN};`);
  });

  it('an analytic run inside an underline redraws the line, invisibly when unset', () => {
    expect(block(':is(.pmd-underline, .pmd-emphasis, u) .pmd-analytic-mark')).toContain(
      'text-decoration-color: var(--pmd-c-analytic-underline, transparent);',
    );
  });
});

describe('highlight and shading beat the overrides', () => {
  const bandRules = [...css.matchAll(/([^{}]*data-(?:highlight|shading)-band[^{}]*)\{([^}]*)\}/g)]
    .map((m) => ({ selector: m[1]!, body: m[2]! }))
    .filter((r) => r.body.includes('text-decoration-color'));

  it('there are band rules for the line in both nestings and both bands', () => {
    expect(bandRules.length).toBe(4);
  });

  it('none of them consults an override', () => {
    for (const r of bandRules) {
      expect(r.body).not.toMatch(/--pmd-(c-)?(cite|analytic|tag)-underline/);
      expect(r.body).toMatch(/text-decoration-color: var\(--pmd-c-band-fg-(light|dark)\);/);
    }
  });

  it('the band-inside-line rules cover every element that draws a line', () => {
    const inner = bandRules.filter((r) => r.selector.includes('.pmd-cite'));
    expect(inner.length).toBe(2);
    for (const r of inner) {
      for (const sel of [
        '.pmd-underline',
        '.pmd-emphasis',
        '.ProseMirror u',
        '#editor.pmd-cite-underlined .pmd-cite',
        'html.pmd-cite-underlined .pmd-pane-editor .pmd-cite',
      ]) {
        expect(r.selector).toContain(sel);
      }
    }
  });
});
