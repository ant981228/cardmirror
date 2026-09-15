/**
 * `normalizeSelectionForSend` — snaps a send selection to a clean run of whole
 * top-level nodes that starts with a structural unit (card / analytic_unit /
 * heading), so the receiving side can place it by outline level without ever
 * splitting a card. Covers within-card, multi-card, boundary straddles,
 * the 75% intro carve-out, headings, and loose paragraphs.
 */

import { describe, expect, it } from 'vitest';
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { normalizeSelectionForSend } from '../../src/editor/send-normalize.js';

const tag = (t: string) => schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(t));
const body = (t: string) => schema.nodes['card_body']!.create(null, schema.text(t));
const card = (...k: PMNode[]) => schema.nodes['card']!.create(null, Fragment.fromArray(k));
const para = (t: string) => schema.nodes['paragraph']!.create(null, schema.text(t));
const block = (t: string) => schema.nodes['block']!.create({ id: newHeadingId() }, schema.text(t));
const makeDoc = (...k: PMNode[]) => schema.nodes['doc']!.create(null, Fragment.fromArray(k));

// child start positions: starts[i] = start of top-level child i; last = docEnd.
function starts(doc: PMNode): number[] {
  const s: number[] = [];
  let p = 0;
  doc.forEach((n) => {
    s.push(p);
    p += n.nodeSize;
  });
  s.push(p);
  return s;
}
function findText(doc: PMNode, t: string, off: number): number {
  let p = -1;
  doc.descendants((n, pos) => {
    if (p === -1 && n.isText && n.text === t) p = pos + off;
    return p === -1;
  });
  if (p < 0) throw new Error(`not found: ${t}`);
  return p;
}
// Normalize, then list the top-level node types of the resulting slice.
function sendTypes(doc: PMNode, from: number, to: number): string[] | null {
  const r = normalizeSelectionForSend(doc, from, to);
  if (!r) return null;
  const out: string[] = [];
  doc.slice(r.from, r.to).content.forEach((n) => out.push(n.type.name));
  return out;
}
function sendText(doc: PMNode, from: number, to: number): string {
  const r = normalizeSelectionForSend(doc, from, to)!;
  return doc.slice(r.from, r.to).content.textBetween(0, doc.slice(r.from, r.to).content.size, ' ');
}

describe('normalizeSelectionForSend — cards', () => {
  it('a selection within one card → the whole card', () => {
    const doc = makeDoc(card(tag('T'), body('alpha body words here')));
    const after = sendTypes(
      doc,
      findText(doc, 'alpha body words here', 2),
      findText(doc, 'alpha body words here', 7),
    );
    expect(after).toEqual(['card']);
  });

  it('one paragraph deep in a long card → the whole card', () => {
    const doc = makeDoc(
      card(tag('T'), body('one'), body('two'), body('three'), body('four'), body('five')),
    );
    expect(sendTypes(doc, findText(doc, 'four', 0), findText(doc, 'four', 4))).toEqual(['card']);
  });

  it('a drag across several cards → all of them, whole', () => {
    const doc = makeDoc(
      card(tag('A'), body('aaa')),
      card(tag('B'), body('bbb')),
      card(tag('C'), body('ccc')),
    );
    const s = starts(doc);
    expect(sendTypes(doc, s[0]! + 1, s[3]! - 1)).toEqual(['card', 'card', 'card']);
  });

  it('tail of A + head of B (straddle) → the more-covered single card', () => {
    const doc = makeDoc(card(tag('A'), body('aaaaaa')), card(tag('B'), body('bbbbbb')));
    const after = normalizeSelectionForSend(
      doc,
      findText(doc, 'aaaaaa', 5), // tail of A (small)
      findText(doc, 'bbbbbb', 1), // head of B (larger)
    )!;
    const types: string[] = [];
    doc.slice(after.from, after.to).content.forEach((n) => types.push(n.type.name));
    expect(types).toEqual(['card']);
    expect(sendText(doc, findText(doc, 'aaaaaa', 5), findText(doc, 'bbbbbb', 1))).toContain('bbbbbb');
  });
});

describe('normalizeSelectionForSend — headings', () => {
  it('caret in a heading’s first half → include the heading (intro rides along)', () => {
    const doc = makeDoc(block('H'), para('intro'), card(tag('A'), body('a')));
    const s = starts(doc);
    expect(sendTypes(doc, s[0]! + 1, findText(doc, 'a', 1))).toEqual([
      'block', 'paragraph', 'card',
    ]);
  });

  it('caret in a heading’s second half → skip the heading + its intro', () => {
    const doc = makeDoc(block('Heading'), card(tag('A'), body('a')), card(tag('B'), body('b')));
    const s = starts(doc);
    expect(sendTypes(doc, s[1]! - 1, findText(doc, 'b', 1))).toEqual(['card', 'card']);
  });
});

const hat = (t: string) => schema.nodes['hat']!.create({ id: newHeadingId() }, schema.text(t));

describe('normalizeSelectionForSend — several headings selected', () => {
  const threeBlocks = () =>
    makeDoc(
      block('Heading One'), card(tag('T1'), body('one')),
      block('Heading Two'), card(tag('T2'), body('two')),
      block('Heading Three'), card(tag('T3'), body('three')),
    );
  const texts = (doc: PMNode, from: number, to: number) => {
    const r = normalizeSelectionForSend(doc, from, to)!;
    const out: string[] = [];
    doc.slice(r.from, r.to).content.forEach((n) => out.push(n.textContent));
    return out;
  };

  it('drag ending late in the last heading → its cards come too', () => {
    const doc = threeBlocks();
    const from = findText(doc, 'Heading One', 1);
    const to = findText(doc, 'Heading Three', 13);
    expect(texts(doc, from, to)).toEqual([
      'Heading One', 'T1one', 'Heading Two', 'T2two', 'Heading Three', 'T3three',
    ]);
  });

  it('drag ending early in the last heading → it is still sent, with its cards', () => {
    const doc = threeBlocks();
    const from = findText(doc, 'Heading One', 1);
    const to = findText(doc, 'Heading Three', 3);
    expect(texts(doc, from, to)).toEqual([
      'Heading One', 'T1one', 'Heading Two', 'T2two', 'Heading Three', 'T3three',
    ]);
  });

  it('selection stopping at the very start of the next heading → that heading stays out', () => {
    const doc = threeBlocks();
    const from = findText(doc, 'Heading One', 1);
    const to = findText(doc, 'Heading Three', 0);
    expect(texts(doc, from, to)).toEqual(['Heading One', 'T1one', 'Heading Two', 'T2two']);
  });

  it('the last heading’s section stops at the next equal-or-shallower heading', () => {
    const doc = makeDoc(
      block('B1'), card(tag('T1'), body('one')),
      block('B2'), card(tag('T2'), body('two')),
      hat('Next Hat'), card(tag('T3'), body('three')),
    );
    const from = findText(doc, 'B1', 1);
    const to = findText(doc, 'B2', 2);
    expect(texts(doc, from, to)).toEqual(['B1', 'T1one', 'B2', 'T2two']);
  });

  it('selecting within one heading’s text → the heading and its section', () => {
    const doc = threeBlocks();
    const from = findText(doc, 'Heading Two', 1);
    const to = findText(doc, 'Heading Two', 10);
    expect(texts(doc, from, to)).toEqual(['Heading Two', 'T2two']);
  });
});

describe('normalizeSelectionForSend — leading loose paragraphs (75% intro rule)', () => {
  const docOf = () =>
    makeDoc(block('Heading'), para('intro text here'), card(tag('T'), body('card body')));

  it('> 75% of the intro selected → grab the heading + whole intro', () => {
    const doc = docOf();
    expect(
      sendTypes(doc, findText(doc, 'intro text here', 0), findText(doc, 'card body', 9)),
    ).toEqual(['block', 'paragraph', 'card']);
  });

  it('≤ 75% of the intro selected → trim it; lead with the card', () => {
    const doc = docOf();
    expect(
      sendTypes(doc, findText(doc, 'intro text here', 12), findText(doc, 'card body', 9)),
    ).toEqual(['card']);
  });

  it('pure intro, > 75% → heading + intro, no card', () => {
    const doc = docOf();
    expect(
      sendTypes(doc, findText(doc, 'intro text here', 0), findText(doc, 'intro text here', 15)),
    ).toEqual(['block', 'paragraph']);
  });

  it('pure intro, ≤ 75% → nothing to send (null)', () => {
    const doc = docOf();
    expect(
      sendTypes(doc, findText(doc, 'intro text here', 12), findText(doc, 'intro text here', 15)),
    ).toBeNull();
  });
});

describe('normalizeSelectionForSend — doc-top preface & pure loose', () => {
  it('preface paragraph + a card → drop the preface, lead with the card', () => {
    const doc = makeDoc(para('preface words'), card(tag('T'), body('b')));
    expect(sendTypes(doc, findText(doc, 'preface words', 0), findText(doc, 'b', 1))).toEqual([
      'card',
    ]);
  });

  it('pure doc-top preface → nothing to send (no heading to grab)', () => {
    const doc = makeDoc(para('preface words'), card(tag('T'), body('b')));
    expect(
      sendTypes(doc, findText(doc, 'preface words', 0), findText(doc, 'preface words', 13)),
    ).toBeNull();
  });

  it('only loose paragraphs → nothing to send', () => {
    const doc = makeDoc(para('one'), para('two'));
    expect(sendTypes(doc, findText(doc, 'one', 0), findText(doc, 'two', 3))).toBeNull();
  });
});
