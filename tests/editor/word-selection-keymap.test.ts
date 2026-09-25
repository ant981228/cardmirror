/**
 * Tests for the Word-style keyboard navigation keymap, focused on
 * the collapse-on-selection behavior of the move variants.
 *
 *   - Plain Ctrl+Up/Down with a selection snaps to the start
 *     (Up) or end (Down) of the paragraph CONTAINING the
 *     relevant selection edge — does NOT skip into the adjacent
 *     paragraph the way a no-selection Ctrl+Down does.
 *
 * Shift-extend variants keep extending (never collapse); they are
 * exercised separately to confirm.
 */

import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Plugin, Transaction } from 'prosemirror-state';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  moveToHeadingOfType,
  wordSelectionKeymap,
} from '../../src/editor/word-selection-keymap.js';

// ─── Doc builders ─────────────────────────────────────────────────

function cardBody(text: string) {
  return schema.nodes['card_body']!.create(null, schema.text(text));
}
function tag(text: string, id = newHeadingId()) {
  return schema.nodes['tag']!.create({ id }, schema.text(text));
}
function cardWith(...children: import('prosemirror-model').Node[]) {
  return schema.nodes['card']!.createChecked(null, children);
}
function makeDoc(children: import('prosemirror-model').Node[]) {
  return schema.nodes['doc']!.createChecked(null, children);
}

function findTextStart(
  doc: import('prosemirror-model').Node,
  text: string,
): number {
  let found = -1;
  doc.descendants((n, p) => {
    if (found !== -1) return false;
    if (n.isText && n.text === text) {
      found = p;
      return false;
    }
    return true;
  });
  if (found < 0) throw new Error(`text "${text}" not in doc`);
  return found;
}

// ─── Synthetic key-event dispatch ─────────────────────────────────
//
// The keymap plugin exposes its bindings via props.handleKeyDown,
// not as an inspectable table. We invoke handleKeyDown with a fake
// view (just state + dispatch) and a fake KeyboardEvent (just the
// fields prosemirror-keymap reads).

interface FakeKeyEvent {
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  preventDefault: () => void;
}

function keyEvent(key: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}): FakeKeyEvent {
  // prosemirror-keymap reads .key for character keys and .code for
  // arrow / function keys. ArrowUp/ArrowDown/ArrowLeft/ArrowRight
  // use both .key and .code with the same name.
  return {
    key,
    code: key,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    metaKey: false,
    preventDefault: () => {},
  };
}

function press(
  state: EditorState,
  key: string,
  mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {},
): EditorState | null {
  let next: EditorState | null = null;
  const handleKeyDown = (
    wordSelectionKeymap as Plugin
  ).props?.handleKeyDown as
    | ((view: unknown, e: FakeKeyEvent) => boolean)
    | undefined;
  if (!handleKeyDown) throw new Error('keymap plugin has no handleKeyDown');
  const fakeView = {
    state,
    dispatch: (tr: Transaction) => {
      next = state.apply(tr);
    },
  };
  handleKeyDown(fakeView, keyEvent(key, mods));
  return next;
}

function stateWith(
  doc: import('prosemirror-model').Node,
  anchor: number,
  head: number = anchor,
) {
  const base = EditorState.create({ doc });
  return base.apply(
    base.tr.setSelection(TextSelection.create(base.doc, anchor, head)),
  );
}

// ─── Tests ────────────────────────────────────────────────────────

describe('Ctrl+Up / Ctrl+Down with a non-empty selection', () => {
  function buildDoc() {
    return makeDoc([
      cardWith(
        tag('TAG'),
        cardBody('first body text'),
        cardBody('second body text'),
      ),
    ]);
  }

  it('Ctrl+Down with selection inside body 1 → start of body 2 (next paragraph)', () => {
    const doc = buildDoc();
    const b1 = findTextStart(doc, 'first body text');
    const b2 = findTextStart(doc, 'second body text');
    const state = stateWith(doc, b1 + 3, b1 + 8);
    const next = press(state, 'ArrowDown', { ctrl: true });
    expect(next).not.toBeNull();
    const sel = next!.selection;
    expect(sel.empty).toBe(true);
    expect(sel.from).toBe(b2);
  });

  it('Ctrl+Up with selection inside body 2 → start of body 2, not end of body 1', () => {
    const doc = buildDoc();
    const b2 = findTextStart(doc, 'second body text');
    const state = stateWith(doc, b2 + 5, b2 + 10);
    const next = press(state, 'ArrowUp', { ctrl: true });
    expect(next).not.toBeNull();
    const sel = next!.selection;
    expect(sel.empty).toBe(true);
    expect(sel.from).toBe(b2);
  });

  it('Ctrl+Down spanning body 1→2 with a paragraph after → start of that next paragraph', () => {
    const doc = makeDoc([
      cardWith(
        tag('TAG'),
        cardBody('first body text'),
        cardBody('second body text'),
        cardBody('third body text'),
      ),
    ]);
    const b1 = findTextStart(doc, 'first body text');
    const b2 = findTextStart(doc, 'second body text');
    const b3 = findTextStart(doc, 'third body text');
    const state = stateWith(doc, b1 + 3, b2 + 4);
    const next = press(state, 'ArrowDown', { ctrl: true });
    expect(next).not.toBeNull();
    const sel = next!.selection;
    expect(sel.empty).toBe(true);
    expect(sel.from).toBe(b3);
  });

  it('Ctrl+Down spanning into the LAST paragraph → parks at its end (no next paragraph)', () => {
    const doc = buildDoc();
    const b1 = findTextStart(doc, 'first body text');
    const b2 = findTextStart(doc, 'second body text');
    const state = stateWith(doc, b1 + 3, b2 + 4);
    const next = press(state, 'ArrowDown', { ctrl: true });
    expect(next).not.toBeNull();
    const sel = next!.selection;
    expect(sel.empty).toBe(true);
    expect(sel.from).toBe(b2 + 'second body text'.length);
  });

  it('Ctrl+Up with selection spanning body 1 and body 2 → start of body 1', () => {
    const doc = buildDoc();
    const b1 = findTextStart(doc, 'first body text');
    const b2 = findTextStart(doc, 'second body text');
    const state = stateWith(doc, b1 + 3, b2 + 4);
    const next = press(state, 'ArrowUp', { ctrl: true });
    expect(next).not.toBeNull();
    const sel = next!.selection;
    expect(sel.empty).toBe(true);
    expect(sel.from).toBe(b1);
  });

  it('Ctrl+Down with EMPTY selection still uses normal next-paragraph behavior', () => {
    const doc = buildDoc();
    const b1 = findTextStart(doc, 'first body text');
    const b2 = findTextStart(doc, 'second body text');
    const state = stateWith(doc, b1 + 3);
    const next = press(state, 'ArrowDown', { ctrl: true });
    expect(next).not.toBeNull();
    const sel = next!.selection;
    expect(sel.empty).toBe(true);
    expect(sel.from).toBe(b2);
  });

  it('Ctrl+Up with EMPTY selection still goes to start of current paragraph', () => {
    const doc = buildDoc();
    const b2 = findTextStart(doc, 'second body text');
    const state = stateWith(doc, b2 + 4);
    const next = press(state, 'ArrowUp', { ctrl: true });
    expect(next).not.toBeNull();
    const sel = next!.selection;
    expect(sel.empty).toBe(true);
    expect(sel.from).toBe(b2);
  });

  it('Ctrl+Down after Ctrl+Shift+Down (selection ends at a paragraph start) → that paragraph start', () => {
    // Real-world flow: cursor mid body 1, Ctrl+Shift+Down extends the
    // selection to the start of body 2 ($to at parentOffset 0 of body 2 —
    // the last visibly-selected paragraph is body 1). A plain Ctrl+Down
    // collapses to body 2's start, which IS the next paragraph after the
    // last visibly-selected one (not skipping past it).
    const doc = buildDoc();
    const b1 = findTextStart(doc, 'first body text');
    const b2 = findTextStart(doc, 'second body text');
    // Selection produced by Ctrl+Shift+Down: anchor mid-body-1, head
    // at start of body 2 (parentOffset 0).
    const state = stateWith(doc, b1 + 3, b2);
    const next = press(state, 'ArrowDown', { ctrl: true });
    expect(next).not.toBeNull();
    const sel = next!.selection;
    expect(sel.empty).toBe(true);
    expect(sel.from).toBe(b2);
  });

  it('Ctrl+Shift+Down with selection still extends as before (not collapsed)', () => {
    const doc = buildDoc();
    const b1 = findTextStart(doc, 'first body text');
    const b2 = findTextStart(doc, 'second body text');
    const state = stateWith(doc, b1 + 2, b1 + 6);
    const next = press(state, 'ArrowDown', { ctrl: true, shift: true });
    expect(next).not.toBeNull();
    const sel = next!.selection;
    expect(sel.empty).toBe(false);
    expect(sel.anchor).toBe(b1 + 2);
    expect(sel.head).toBe(b2);
  });
});

describe('Ctrl+Left / Ctrl+Right with a non-empty selection', () => {
  // Doc: one card_body holding a single text node so positions are
  // 1:1 with character offsets inside the text.
  function buildDoc(text: string) {
    return makeDoc([cardWith(tag('TAG'), cardBody(text))]);
  }

  it('Ctrl+Right with selection inside a word → end of that word', () => {
    // "Therefore" — select "The" (offsets 0..3 within the word).
    // Ctrl+Right should jump to the end of the word ("Therefore"
    // has no trailing space, so the unit ends right after the 'e').
    const doc = buildDoc('Therefore');
    const start = findTextStart(doc, 'Therefore');
    const state = stateWith(doc, start, start + 3);
    const next = press(state, 'ArrowRight', { ctrl: true });
    expect(next).not.toBeNull();
    const sel = next!.selection;
    expect(sel.empty).toBe(true);
    expect(sel.from).toBe(start + 'Therefore'.length);
  });

  it('Ctrl+Right with selection inside a word that has a trailing space → past the trailing space', () => {
    // "Therefore foo" — select "The". Ctrl+Right absorbs the
    // trailing space and lands at the start of "foo".
    const doc = buildDoc('Therefore foo');
    const start = findTextStart(doc, 'Therefore foo');
    const state = stateWith(doc, start, start + 3);
    const next = press(state, 'ArrowRight', { ctrl: true });
    expect(next).not.toBeNull();
    const sel = next!.selection;
    expect(sel.empty).toBe(true);
    expect(sel.from).toBe(start + 'Therefore '.length);
  });

  it('Ctrl+Right with selection inside a word followed by punct → just past the word (NOT into the punct)', () => {
    // "Therefore. foo" — select "The". The word ends at offset 9
    // (the "." is its own punct unit). Ctrl+Right should stop at
    // offset 9, between "Therefore" and ".".
    const doc = buildDoc('Therefore. foo');
    const start = findTextStart(doc, 'Therefore. foo');
    const state = stateWith(doc, start, start + 3);
    const next = press(state, 'ArrowRight', { ctrl: true });
    expect(next).not.toBeNull();
    expect(next!.selection.from).toBe(start + 'Therefore'.length);
  });

  it('Ctrl+Left with selection inside a word → start of that word', () => {
    // "Therefore" — selection from offset 5 to offset 9 ("fore").
    // Ctrl+Left should jump to the start of "Therefore" (offset 0).
    const doc = buildDoc('Therefore');
    const start = findTextStart(doc, 'Therefore');
    const state = stateWith(doc, start + 5, start + 9);
    const next = press(state, 'ArrowLeft', { ctrl: true });
    expect(next).not.toBeNull();
    expect(next!.selection.from).toBe(start);
  });

  it('Ctrl+Right with selection ending AT a unit boundary → just collapses, no advance', () => {
    // After Ctrl+Shift+Right past "Therefore " (with trailing
    // space absorption), $to lands at offset 10 = start of "foo".
    // That's a unit boundary. Plain Ctrl+Right should NOT advance
    // further into "foo"; it should collapse at the boundary.
    const doc = buildDoc('Therefore foo bar');
    const start = findTextStart(doc, 'Therefore foo bar');
    const fromPos = start;
    const toPos = start + 'Therefore '.length;
    const state = stateWith(doc, fromPos, toPos);
    const next = press(state, 'ArrowRight', { ctrl: true });
    expect(next).not.toBeNull();
    expect(next!.selection.from).toBe(toPos);
  });

  it('Ctrl+Left with selection starting AT a unit boundary → just collapses, no rewind', () => {
    // Selection from start of "foo" backward to start of doc would
    // be unusual, but: selection covers "Therefore " ending at the
    // boundary. $from is at offset 0 (start of textblock — a unit
    // boundary by definition). Plain Ctrl+Left should NOT rewind
    // into a previous textblock; it should collapse at 0.
    const doc = buildDoc('Therefore foo');
    const start = findTextStart(doc, 'Therefore foo');
    const state = stateWith(doc, start, start + 'Therefore '.length);
    const next = press(state, 'ArrowLeft', { ctrl: true });
    expect(next).not.toBeNull();
    expect(next!.selection.from).toBe(start);
  });

  it('Ctrl+Shift+Right still extends as before (not snapped-and-collapsed)', () => {
    const doc = buildDoc('Therefore foo');
    const start = findTextStart(doc, 'Therefore foo');
    // Cursor at offset 3 inside "Therefore," extend right.
    const state = stateWith(doc, start + 3);
    const next = press(state, 'ArrowRight', { ctrl: true, shift: true });
    expect(next).not.toBeNull();
    const sel = next!.selection;
    expect(sel.empty).toBe(false);
    expect(sel.anchor).toBe(start + 3);
    // Extended head goes to start of "foo" (trailing-space absorbed).
    expect(sel.head).toBe(start + 'Therefore '.length);
  });

  it('Ctrl+Left at the START of a paragraph → END of the previous paragraph (after its trailing word/punct)', () => {
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('first body.'), cardBody('second body')),
    ]);
    const b1 = findTextStart(doc, 'first body.');
    const b2 = findTextStart(doc, 'second body');
    // Empty cursor at the very start of body 2 (offset 0).
    const state = stateWith(doc, b2);
    const next = press(state, 'ArrowLeft', { ctrl: true });
    expect(next).not.toBeNull();
    const sel = next!.selection;
    expect(sel.empty).toBe(true);
    // Lands AFTER the trailing "." of body 1 (its content end), not at
    // the start of that last unit.
    expect(sel.from).toBe(b1 + 'first body.'.length);
  });
});

// ─── PageUp / PageDown destinations (audit A-14, 2026-07-11) ──────
//
// collectHeadingPositions stopped descending into textblocks (a per-keypress
// full-doc text-run walk); the invariant pinned here is that the SAME heading
// stops are visited, in document order — including tag/analytic markers inside
// cards and headings inside zones and live views (which differ from
// headings.ts section semantics: for NAVIGATION they are stops).
describe('PageUp / PageDown heading navigation', () => {
  function pocket(text: string) {
    return schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text(text));
  }
  function block(text: string) {
    return schema.nodes['block']!.create({ id: newHeadingId() }, schema.text(text));
  }
  function buildNavDoc() {
    return makeDoc([
      pocket('POCKET'),
      block('BLOCK ONE'),
      cardWith(tag('TAG ONE'), cardBody('body one')),
      schema.nodes['transclusion_ref']!.create({ source_ref: 'other.cmir' }, [
        block('ZONE BLOCK'),
        cardWith(tag('ZONE TAG'), cardBody('zone body')),
      ]),
      schema.nodes['self_ref']!.create({ source_heading_id: 'X', source_label: 'V' }, [
        cardWith(tag('VIEW TAG'), cardBody('view body')),
      ]),
      cardWith(tag('TAG TWO'), cardBody('body two')),
    ]);
  }

  it('PageDown visits every heading marker in order, including zone/view innards', () => {
    const doc = buildNavDoc();
    let state = stateWith(doc, 1);
    const stops: string[] = [];
    for (;;) {
      const next = press(state, 'PageDown');
      if (!next || next.selection.head === state.selection.head) break;
      state = next;
      stops.push(state.selection.$head.parent.textContent);
    }
    expect(stops).toEqual([
      'BLOCK ONE',
      'TAG ONE',
      'ZONE BLOCK',
      'ZONE TAG',
      'VIEW TAG',
      'TAG TWO',
    ]);
  });

  it('PageUp walks the same stops in reverse', () => {
    const doc = buildNavDoc();
    // Start inside the last card body.
    const start = findTextStart(doc, 'body two');
    let state = stateWith(doc, start + 2);
    const stops: string[] = [];
    for (;;) {
      const next = press(state, 'PageUp');
      if (!next || next.selection.head === state.selection.head) break;
      state = next;
      stops.push(state.selection.$head.parent.textContent);
    }
    expect(stops).toEqual([
      'TAG TWO',
      'VIEW TAG',
      'ZONE TAG',
      'ZONE BLOCK',
      'TAG ONE',
      'BLOCK ONE',
      'POCKET',
    ]);
  });
});

// ─── Next / Previous Pocket … Tag (one heading type only) ─────────
describe('moveToHeadingOfType', () => {
  function pocket(text: string) {
    return schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text(text));
  }
  function block(text: string) {
    return schema.nodes['block']!.create({ id: newHeadingId() }, schema.text(text));
  }
  function buildDoc() {
    return makeDoc([
      pocket('POCKET'),
      block('BLOCK ONE'),
      cardWith(tag('TAG ONE'), cardBody('body one')),
      cardWith(tag('TAG TWO'), cardBody('body two')),
      block('BLOCK TWO'),
      cardWith(tag('TAG THREE'), cardBody('body three')),
    ]);
  }
  function walk(type: string, dir: 'prev' | 'next', from: number): string[] {
    let state = stateWith(buildDoc(), from);
    const cmd = moveToHeadingOfType(type, dir);
    const stops: string[] = [];
    for (;;) {
      let next: EditorState | null = null;
      if (!cmd(state, (tr) => { next = state.apply(tr); })) break;
      state = next!;
      stops.push(state.selection.$head.parent.textContent);
    }
    return stops;
  }

  it('Next Tag stops only at tags, skipping blocks', () => {
    expect(walk('tag', 'next', 1)).toEqual(['TAG ONE', 'TAG TWO', 'TAG THREE']);
  });

  it('Next Block skips the tags between blocks', () => {
    expect(walk('block', 'next', 1)).toEqual(['BLOCK ONE', 'BLOCK TWO']);
  });

  it('Previous Tag from inside a card body lands on that card’s tag first', () => {
    const doc = buildDoc();
    const start = findTextStart(doc, 'body three');
    expect(walk('tag', 'prev', start + 2)).toEqual(['TAG THREE', 'TAG TWO', 'TAG ONE']);
  });

  it('is unavailable when there is no heading of that type ahead', () => {
    const doc = buildDoc();
    const state = stateWith(doc, findTextStart(doc, 'body three'));
    expect(moveToHeadingOfType('pocket', 'next')(state)).toBe(false);
  });
});
