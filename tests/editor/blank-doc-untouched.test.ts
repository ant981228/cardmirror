/**
 * `isUntouchedBlank` — the "is this still the doc New made?" check the
 * three-pane shell uses before letting an opened file replace an
 * Untitled doc. Blank content alone isn't enough: anything in the undo
 * history means the user has worked in the doc.
 */

import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { history } from 'prosemirror-history';
import { schema } from '../../src/schema/index.js';
import { isUntouchedBlank, makeBlankDoc } from '../../src/editor/blank-doc.js';

function freshState(doc = makeBlankDoc()): EditorState {
  return EditorState.create({ doc, plugins: [history()] });
}

describe('isUntouchedBlank', () => {
  it('a brand-new blank doc is untouched', () => {
    expect(isUntouchedBlank(freshState())).toBe(true);
  });

  it('works without the history plugin', () => {
    expect(isUntouchedBlank(EditorState.create({ doc: makeBlankDoc() }))).toBe(true);
  });

  it('a doc with text is not', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['paragraph']!.create(null, schema.text('hi')),
    ]);
    expect(isUntouchedBlank(freshState(doc))).toBe(false);
  });

  it('a doc with a heading and no text is not', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['pocket']!.create({ id: 'p1' }),
    ]);
    expect(isUntouchedBlank(freshState(doc))).toBe(false);
  });

  it('typing then deleting leaves it blank but no longer untouched', () => {
    let state = freshState();
    state = state.apply(state.tr.insertText('x', 1));
    state = state.apply(state.tr.delete(1, 2));
    expect(state.doc.eq(makeBlankDoc())).toBe(true);
    expect(isUntouchedBlank(state)).toBe(false);
  });
});
