// @vitest-environment jsdom
/**
 * Ctrl/Cmd add-to-selection follows the plain-gesture click ladder
 * (field request 2026-09-05: "you can't command triple click to select
 * entire discontinuous paragraphs"): a click adds the word, a
 * triple-click the paragraph; a drag adds the dragged range snapped to
 * whole words after a double-click and to whole paragraphs after a
 * triple-click. Drives `discontinuousRangeFor` directly with synthetic
 * doc positions (the mouse listeners only translate coordinates into
 * exactly these calls) and checks the shadow merge folds a three-click
 * sequence's earlier words into its paragraph.
 */
import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { wordSelectionPlugin, discontinuousRangeFor } from '../../src/editor/word-selection-plugin.js';
import {
  buildSimilarSelectionPlugin,
  setManualShadowSelection,
  getSimilarSelectionState,
} from '../../src/editor/similar-selection-plugin.js';

// Two cards; each body is one paragraph (a textblock).
const ONE = 'alpha bravo charlie';
const TWO = 'delta echo foxtrot';

function makeView(): EditorView {
  const card = (text: string) =>
    schema.nodes['card']!.createChecked(null, [
      schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('T')),
      schema.nodes['card_body']!.create(null, schema.text(text)),
    ]);
  const doc = schema.nodes['doc']!.create(null, [card(ONE), card(TWO)]);
  const container = document.createElement('div');
  document.body.appendChild(container);
  return new EditorView(container, {
    state: EditorState.create({ doc, plugins: [wordSelectionPlugin, buildSimilarSelectionPlugin()] }),
  });
}

/** Doc position of `offset` within the body of card `index`. */
function bodyPos(view: EditorView, index: number, offset: number): number {
  const starts: number[] = [];
  view.state.doc.descendants((n, pos) => {
    if (n.type.name === 'card_body') starts.push(pos + 1);
    return n.type.name !== 'card_body';
  });
  return starts[index]! + offset;
}

describe('Ctrl/Cmd add-to-selection click ladder', () => {
  it('a click adds the word under the pointer (with its trailing space), a double-click the same', () => {
    const view = makeView();
    const inBravo = bodyPos(view, 0, 8);
    const bravo = { from: bodyPos(view, 0, 6), to: bodyPos(view, 0, 12) };
    expect(discontinuousRangeFor(view, inBravo, null, 1)).toEqual(bravo);
    expect(discontinuousRangeFor(view, inBravo, inBravo, 2)).toEqual(bravo);
    view.destroy();
  });

  it('a triple-click adds the whole paragraph', () => {
    const view = makeView();
    expect(discontinuousRangeFor(view, bodyPos(view, 1, 3), null, 3)).toEqual({
      from: bodyPos(view, 1, 0),
      to: bodyPos(view, 1, TWO.length),
    });
    view.destroy();
  });

  it('a plain drag adds exactly the dragged range, in either direction', () => {
    const view = makeView();
    const a = bodyPos(view, 0, 2);
    const b = bodyPos(view, 0, 9);
    expect(discontinuousRangeFor(view, a, b, 1)).toEqual({ from: a, to: b });
    expect(discontinuousRangeFor(view, b, a, 1)).toEqual({ from: a, to: b });
    view.destroy();
  });

  it('a drag after a double-click snaps both ends outward to whole words', () => {
    const view = makeView();
    // mid-"alpha" → mid-"bravo": "alpha bravo " (both units, trailing space absorbed)
    expect(discontinuousRangeFor(view, bodyPos(view, 0, 2), bodyPos(view, 0, 8), 2)).toEqual({
      from: bodyPos(view, 0, 0),
      to: bodyPos(view, 0, 12),
    });
    // reversed drag gives the same range
    expect(discontinuousRangeFor(view, bodyPos(view, 0, 8), bodyPos(view, 0, 2), 2)).toEqual({
      from: bodyPos(view, 0, 0),
      to: bodyPos(view, 0, 12),
    });
    view.destroy();
  });

  it('a drag after a triple-click spans whole paragraphs from the first to the last touched', () => {
    const view = makeView();
    expect(discontinuousRangeFor(view, bodyPos(view, 0, 9), bodyPos(view, 1, 4), 3)).toEqual({
      from: bodyPos(view, 0, 0),
      to: bodyPos(view, 1, TWO.length),
    });
    view.destroy();
  });

  it('the three clicks of a Ctrl/Cmd-triple-click each add a range; the shadow merge leaves one paragraph', () => {
    const view = makeView();
    const at = bodyPos(view, 0, 8);
    const ranges = [1, 2, 3].map((detail) => discontinuousRangeFor(view, at, null, detail));
    setManualShadowSelection(view, ranges);
    expect(getSimilarSelectionState(view.state).matches).toEqual([
      { from: bodyPos(view, 0, 0), to: bodyPos(view, 0, ONE.length) },
    ]);
    view.destroy();
  });
});
