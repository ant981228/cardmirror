// @vitest-environment jsdom
/**
 * Sending a DISCONTINUOUS (shadow) selection — a scattered nav-pane ⌘-click
 * set's "Select headings and contents", the manual Ctrl/Cmd selection, Select
 * Similar. The shadow set parks the caret in the doc-level gap before its first
 * range, where the cursor fallback finds no enclosing structure, so the send
 * used to do nothing at all. It now sends every selected piece, in doc order.
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { type Node as PMNode, type Slice } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { takeSendSlice } from '../../src/editor/speech-doc-send.js';
import {
  buildSimilarSelectionPlugin,
  setManualShadowSelection,
  getSimilarSelectionState,
} from '../../src/editor/similar-selection-plugin.js';

const block = (text: string): PMNode =>
  schema.nodes['block']!.create({ id: newHeadingId() }, schema.text(text));
function card(tag: string, body: string): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
function makeView(children: PMNode[]): EditorView {
  const doc = schema.nodes['doc']!.create(null, children);
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new EditorView(el, {
    state: EditorState.create({ doc, plugins: [buildSimilarSelectionPlugin()] }),
  });
}
/** [start, end) of top-level child i. */
function child(view: EditorView, i: number): { from: number; to: number } {
  let out = { from: -1, to: -1 };
  view.state.doc.forEach((n, off, idx) => {
    if (idx === i) out = { from: off, to: off + n.nodeSize };
  });
  return out;
}
const topText = (slice: Slice): string[] => {
  const out: string[] = [];
  slice.content.forEach((n) => out.push(n.textContent));
  return out;
};

describe('takeSendSlice — discontinuous selection', () => {
  const docChildren = () => [
    block('B1'),
    card('t1', 'b1'),
    block('B2'),
    card('t2', 'b2'),
    block('B3'),
    card('t3', 'b3'),
  ];

  it('scattered headings + their sections all travel, nothing in between', () => {
    const view = makeView(docChildren());
    // B1's section (children 0–1) and B3's section (children 4–5).
    setManualShadowSelection(view, [
      { from: child(view, 0).from, to: child(view, 1).to },
      { from: child(view, 4).from, to: child(view, 5).to },
    ]);
    expect(view.state.selection.empty).toBe(true);
    const slice = takeSendSlice(view);
    expect(slice).not.toBeNull();
    expect(slice!.openStart).toBe(0);
    expect(slice!.openEnd).toBe(0);
    expect(topText(slice!)).toEqual(['B1', 't1b1', 'B3', 't3b3']);
    // The shadow selection stays on screen.
    expect(getSimilarSelectionState(view.state).matches.length).toBe(2);
  });

  it('a non-empty real selection still wins over a shadow set', () => {
    const view = makeView(docChildren());
    setManualShadowSelection(view, [
      { from: child(view, 0).from, to: child(view, 1).to },
      { from: child(view, 4).from, to: child(view, 5).to },
    ]);
    const b = child(view, 3);
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, b.from + 3, b.to - 3)),
    );
    expect(view.state.selection.empty).toBe(false);
    const slice = takeSendSlice(view)!;
    expect(topText(slice)).toEqual(['t2b2']);
  });
});
