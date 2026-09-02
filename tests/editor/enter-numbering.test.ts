/**
 * Enter in the MIDDLE of a numbered tag/heading: the number stays with
 * the pre-cursor half (the card the author was numbering); the post-cursor
 * half is the new, unnumbered unit. Field report 2026-09-02: the new
 * container was built with default attrs, so the number followed the
 * second card.
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { enterMidTag, enterInHeading } from '../../src/editor/tag-keymap.js';
import { computeNumbering } from '../../src/editor/numbering.js';

function numberedCard(tag: string): PMNode {
  return schema.nodes['card']!.createChecked({ numRole: 'number', numRestart: false }, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text('body')),
  ]);
}
function labels(d: PMNode): string[] {
  const map = computeNumbering(d).cards;
  const out: string[] = [];
  d.descendants((node, pos) => {
    if (node.type.name === 'card') {
      out.push(map.get(pos)?.text ?? '·');
      return false;
    }
    return true;
  });
  return out;
}
function run(cmd: typeof enterMidTag, state: EditorState): EditorState {
  let next = state;
  const ok = cmd(state, (tr) => {
    next = state.apply(tr);
  });
  expect(ok).toBe(true);
  return next;
}

describe('Enter mid-tag keeps the number on the FIRST half', () => {
  it('a numbered card split mid-tag: first half numbered, second half plain', () => {
    const doc = schema.nodes['doc']!.create(null, [numberedCard('Alpha Beta'), numberedCard('Gamma')]);
    expect(labels(doc)).toEqual(['1', '2']);
    let state = EditorState.create({ doc });
    // Cursor between "Alpha " and "Beta": card open(1) + tag open(1) + 6 chars.
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2 + 6)));
    state = run(enterMidTag, state);
    const cards = [state.doc.child(0), state.doc.child(1), state.doc.child(2)];
    expect(cards[0]!.firstChild!.textContent).toBe('Alpha ');
    expect(cards[1]!.firstChild!.textContent).toBe('Beta');
    expect(cards[0]!.attrs['numRole'], 'the pre-cursor half keeps the number role').toBe('number');
    expect(cards[1]!.attrs['numRole'], 'the post-cursor half is the new, plain card').toBe('none');
    expect(labels(state.doc)).toEqual(['1', '·', '2']);
  });

  it('a block split mid-heading: the first half keeps its restart flag; the second takes the default', () => {
    const block = schema.nodes['block']!.create({ id: newHeadingId(), numRestart: false }, schema.text('Long Block'));
    const doc = schema.nodes['doc']!.create(null, [block, numberedCard('One')]);
    let state = EditorState.create({ doc });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1 + 4)));
    state = run(enterInHeading, state);
    expect(state.doc.child(0).textContent).toBe('Long');
    expect(state.doc.child(1).textContent).toBe(' Block');
    expect(state.doc.child(0).attrs['numRestart'], 'first half inherits the author’s flag').toBe(false);
    expect(state.doc.child(1).attrs['numRestart'], 'second half is a fresh block (default restart)').toBe(true);
  });
});
