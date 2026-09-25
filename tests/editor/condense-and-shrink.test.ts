/**
 * Condense With Warning and Shrink (unbound): Condense With Warning,
 * then Shrink over the condensed text, in one transaction. The pause /
 * resume markers are shrink-protected and stay at Normal size.
 */

import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  compileShrinkProtections,
  condenseAndShrink,
  shrinkText,
} from '../../src/editor/ribbon-commands.js';
import { condenseWithWarning } from '../../src/editor/condense.js';

const m = (name: string, attrs?: Record<string, unknown>) => schema.marks[name]!.create(attrs);
const t = (text: string, ...marks: ReturnType<typeof m>[]) => schema.text(text, marks);

function tag(text: string) {
  return schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(text));
}
function body(...inlines: ReturnType<typeof t>[]) {
  return schema.nodes['card_body']!.create(null, inlines);
}
function card(...children: PMNode[]) {
  return schema.nodes['card']!.createChecked(null, children);
}
function makeDoc(...children: PMNode[]) {
  return schema.nodes['doc']!.createChecked(null, children);
}

const NORMAL_PT = 11;
const PAUSE = 'PAUSE HERE';
const RESUME = 'RESUME HERE';

function effectivePt(node: PMNode | null, _parent: PMNode): number {
  const mark = node?.marks.find((mk) => mk.type.name === 'font_size');
  return mark ? Number(mark.attrs['halfPoints']) / 2 : NORMAL_PT;
}

function makeCommand(protectMarkers: boolean) {
  return condenseAndShrink(
    condenseWithWarning(() => ({ pause: PAUSE, resume: RESUME })),
    shrinkText(
      effectivePt,
      () => NORMAL_PT,
      () => protectMarkers,
      () => compileShrinkProtections([], PAUSE, RESUME),
    ),
  );
}
const command = makeCommand(false);

function ptOf(doc: PMNode, needle: string): number {
  let found = NORMAL_PT;
  doc.descendants((node, _pos, parent) => {
    if (node.isText && node.text?.includes(needle) && parent) {
      found = effectivePt(node, parent);
      return false;
    }
    return true;
  });
  return found;
}

function twoParagraphCard(): PMNode {
  return makeDoc(
    card(
      tag('TAG'),
      body(t('first unread words '), t('the warrant', m('underline_mark'))),
      body(t('second unread paragraph')),
    ),
  );
}

/** Select from the start of the first body to the end of the last. */
function selectBodies(doc: PMNode): EditorState {
  const state = EditorState.create({ doc });
  let from = -1;
  let to = -1;
  doc.descendants((node, pos) => {
    if (node.type.name !== 'card_body') return true;
    if (from < 0) from = pos + 1;
    to = pos + node.nodeSize - 1;
    return false;
  });
  return state.apply(state.tr.setSelection(TextSelection.create(doc, from, to)));
}

describe('condenseAndShrink', () => {
  it('condenses with markers and shrinks the merged text in one transaction', () => {
    const state = selectBodies(twoParagraphCard());
    const trs: Transaction[] = [];
    expect(command(state, (tr) => trs.push(tr))).toBe(true);
    expect(trs).toHaveLength(1);
    const doc = state.apply(trs[0]!).doc;
    const cardNode = doc.firstChild!;
    const texts: string[] = [];
    cardNode.forEach((child) => {
      if (child.type.name === 'card_body') texts.push(child.textContent);
    });
    expect(texts).toHaveLength(3);
    expect(texts[0]).toBe(PAUSE);
    expect(texts[1]).toContain('first unread words');
    expect(texts[1]).toContain('second unread paragraph');
    expect(texts[2]).toBe(RESUME);
    expect(ptOf(doc, 'first unread')).toBeLessThan(NORMAL_PT);
    expect(ptOf(doc, 'second unread')).toBeLessThan(NORMAL_PT);
    expect(ptOf(doc, 'the warrant')).toBe(NORMAL_PT);
  });

  it('keeps the markers at Normal size when shrink protections are on', () => {
    const state = selectBodies(twoParagraphCard());
    let next: EditorState | null = null;
    expect(makeCommand(true)(state, (tr) => { next = state.apply(tr); })).toBe(true);
    const doc = next!.doc;
    expect(ptOf(doc, 'first unread')).toBeLessThan(NORMAL_PT);
    expect(ptOf(doc, PAUSE)).toBe(NORMAL_PT);
    expect(ptOf(doc, RESUME)).toBe(NORMAL_PT);
  });

  it('refuses where Condense With Warning refuses (empty selection)', () => {
    const doc = twoParagraphCard();
    const state = EditorState.create({ doc });
    const cursor = state.apply(state.tr.setSelection(TextSelection.create(doc, 8)));
    expect(command(cursor, () => {})).toBe(false);
  });

  it('dry run (no dispatch) reports applicability without changing anything', () => {
    const state = selectBodies(twoParagraphCard());
    expect(command(state)).toBe(true);
  });
});
