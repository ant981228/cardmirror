// @vitest-environment jsdom
/**
 * citeTokens on the external-insert bridge: a role-`cite` insert may
 * name verbatim substrings of its FIRST line (lastname(s) + shortdate,
 * the F8 convention) and they arrive wearing `cite_mark`. Tokens that
 * miss mark nothing; later paragraphs (bundled article text) are never
 * marked; other roles ignore the field.
 */
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema } from '../../src/schema/index.js';
import { buildExternalInsertTransaction } from '../../src/editor/external-insert.js';
import { absorbPlugin } from '../../src/editor/absorb-plugin.js';

function paragraph(text: string) {
  return text
    ? schema.nodes['paragraph']!.create(null, schema.text(text))
    : schema.nodes['paragraph']!.create(null, []);
}
function makeState(doc: ReturnType<(typeof schema.nodes)['doc']['createChecked']>): EditorState {
  return EditorState.create({ doc, plugins: [absorbPlugin] });
}

/** All [text, marked?] runs in document order. */
function citeMarkedRuns(doc: EditorState['doc']): Array<[string, boolean]> {
  const runs: Array<[string, boolean]> = [];
  doc.descendants((n) => {
    if (n.isText) {
      runs.push([n.text!, n.marks.some((m) => m.type.name === 'cite_mark')]);
    }
    return true;
  });
  return runs;
}

function stateAtEmptyParagraph(): EditorState {
  const doc = schema.nodes['doc']!.createChecked(null, [paragraph('')]);
  const state = makeState(doc);
  return state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, 1)),
  );
}

describe('external insert — citeTokens', () => {
  it('marks a single-author token in the inserted cite', () => {
    const state = stateAtEmptyParagraph();
    const cite = 'Simon Speakman Cordall 25, Senior Reporter, "Title," Al Jazeera, 09/02/2025';
    const plan = buildExternalInsertTransaction(state, {
      text: cite,
      role: 'cite',
      newParagraph: true,
      citeTokens: ['Cordall 25'],
    });
    expect(plan).not.toBeNull();
    const runs = citeMarkedRuns(plan!.tr.doc);
    expect(runs).toContainEqual(['Cordall 25', true]);
    // Everything outside the token stays unmarked.
    expect(runs.filter(([, marked]) => marked)).toHaveLength(1);
  });

  it('marks both tokens of the two-author shape', () => {
    const state = stateAtEmptyParagraph();
    const cite = 'Laura Weiss & John Bresnahan 3/26, reporters, "T," Punchbowl, 3/26/26';
    const plan = buildExternalInsertTransaction(state, {
      text: cite,
      role: 'cite',
      newParagraph: true,
      citeTokens: ['Weiss & ', 'Bresnahan 3/26'],
    });
    const marked = citeMarkedRuns(plan!.tr.doc).filter(([, m]) => m).map(([t]) => t);
    expect(marked.join('|')).toContain('Weiss & ');
    expect(marked.join('|')).toContain('Bresnahan 3/26');
  });

  it('never marks past the first line (bundled article text)', () => {
    const state = stateAtEmptyParagraph();
    const text = 'Cordall 25, "Title," Al Jazeera\n\nArticle body mentioning Cordall 25 again.';
    const plan = buildExternalInsertTransaction(state, {
      text,
      role: 'cite',
      newParagraph: true,
      citeTokens: ['Cordall 25'],
    });
    const runs = citeMarkedRuns(plan!.tr.doc);
    const markedTexts = runs.filter(([, m]) => m).map(([t]) => t);
    expect(markedTexts).toEqual(['Cordall 25']); // once — the cite line only
  });

  it('a token that misses marks nothing (no fallback guessing)', () => {
    const state = stateAtEmptyParagraph();
    const plan = buildExternalInsertTransaction(state, {
      text: 'Some cite without the token',
      role: 'cite',
      newParagraph: true,
      citeTokens: ['Nonexistent 99'],
    });
    expect(citeMarkedRuns(plan!.tr.doc).some(([, m]) => m)).toBe(false);
  });

  it('non-cite roles ignore citeTokens', () => {
    const state = stateAtEmptyParagraph();
    const plan = buildExternalInsertTransaction(state, {
      text: 'Cordall 25, plain card text',
      role: 'card',
      newParagraph: true,
      citeTokens: ['Cordall 25'],
    });
    expect(citeMarkedRuns(plan!.tr.doc).some(([, m]) => m)).toBe(false);
  });

  it('fuzzy-matches typography drift (curly quote in the doc text)', () => {
    const state = stateAtEmptyParagraph();
    const cite = 'O’Brien 25, analyst, "T," Site, 1/1/25';
    const plan = buildExternalInsertTransaction(state, {
      text: cite,
      role: 'cite',
      newParagraph: true,
      citeTokens: ["O'Brien 25"], // straight apostrophe from the sender
    });
    const marked = citeMarkedRuns(plan!.tr.doc).filter(([, m]) => m).map(([t]) => t);
    expect(marked).toEqual(['O’Brien 25']);
  });
});
