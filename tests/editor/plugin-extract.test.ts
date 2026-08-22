// tests/editor/plugin-extract.test.ts
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { extractSelection } from '../../src/editor/plugin-extract.js';
import { parseSourceToken } from '../../src/editor/plugin-source-token.js';
import { resolveDescriptor } from '../../src/editor/learn-anchor.js';

const IDENT = { docId: 'doc-1', docTitle: 'Test.docx' };

function heading(type: string, text: string, id = newHeadingId()): PMNode {
  return schema.nodes[type]!.create({ id }, schema.text(text));
}
function undertag(text: string): PMNode {
  return schema.nodes['undertag']!.create(null, schema.text(text));
}
function citePara(citeText: string, rest = ''): PMNode {
  const content = [schema.text(citeText, [schema.marks['cite_mark']!.create()])];
  if (rest) content.push(schema.text(rest));
  return schema.nodes['cite_paragraph']!.create(null, content);
}
function cardBody(text: string): PMNode {
  return schema.nodes['card_body']!.create(null, schema.text(text));
}
function paragraph(text: string): PMNode {
  return schema.nodes['paragraph']!.create(null, schema.text(text));
}
function card(...children: PMNode[]): PMNode {
  return schema.nodes['card']!.createChecked(null, children);
}
function analyticUnit(...children: PMNode[]): PMNode {
  return schema.nodes['analytic_unit']!.createChecked(null, children);
}
function selfRef(sourceHeadingId: string, children: PMNode[]): PMNode {
  return schema.nodes['self_ref']!.create(
    { source_heading_id: sourceHeadingId, source_label: '↳ Mirror' },
    children,
  );
}
/** First document position of the first node of `type`, or -1. */
function posOf(doc: PMNode, type: string): number {
  let found = -1;
  doc.descendants((n, p) => {
    if (found < 0 && n.type.name === type) found = p;
  });
  return found;
}
function makeDoc(children: PMNode[]): PMNode {
  return schema.nodes['doc']!.createChecked(null, children);
}

/** Minimal view stand-in: extraction reads state only. */
function fakeView(doc: PMNode, from: number, to = from): EditorView {
  const state = EditorState.create({ doc });
  const sel =
    to === from
      ? TextSelection.create(state.doc, from)
      : TextSelection.create(state.doc, from, to);
  // Extraction only touches view.state; a full EditorView needs a DOM mount.
  return { state: state.apply(state.tr.setSelection(sel)) } as unknown as EditorView;
}

const tagId = newHeadingId();
const blockId = newHeadingId();
function sampleDoc(): PMNode {
  return makeDoc([
    heading('block', 'AT: Framework', blockId),
    card(
      heading('tag', 'Perm solves', tagId),
      undertag('extend: do both'),
      citePara('Smith 24', ' - Prof at X, Journal.'),
      cardBody('Long card body prose that must never leave.'),
    ),
    paragraph('a loose paragraph'),
  ]);
}

describe('extractSelection', () => {
  it('collapsed cursor in the card extracts the card as typed items, no body', () => {
    const doc = sampleDoc();
    // position inside the tag text: block node = pos 0..block.nodeSize
    const inTag = doc.nodeSize - doc.child(1).nodeSize - doc.child(2).nodeSize - 2 + 3;
    const res = extractSelection(fakeView(doc, inTag), IDENT);
    if (!res.ok) throw new Error(res.error);
    expect(res.items.map((i) => i.kind)).toEqual(['tag', 'undertag', 'cite']);
    expect(res.items[2]!.text).toBe('Smith 24');
    expect(res.items.some((i) => i.text.includes('never leave'))).toBe(false);
  });
  it('names each heading and only scopes the undertag and the cite to it', () => {
    const doc = sampleDoc();
    const res = extractSelection(fakeView(doc, 3, doc.content.size - 2), IDENT);
    if (!res.ok) throw new Error(res.error);
    const byKind = Object.fromEntries(res.items.map((i) => [i.kind, i]));
    const at = (kind: string) => parseSourceToken(byKind[kind]!.source)!;
    expect(at('block').headingId).toBe(blockId);
    expect(at('tag').headingId).toBe(tagId);
    // An undertag and a cite name NO heading: the governing tag is scope for
    // their anchor. Naming it made them resolve to the tag's own line.
    expect(at('undertag').headingId).toBeNull();
    expect(at('undertag').scopeId).toBe(tagId);
    expect(at('cite').headingId).toBeNull();
    expect(at('cite').scopeId).toBe(tagId);
    expect(at('tag').docTitle).toBe('Test.docx');
  });
  it('explicit selection wins and skips loose paragraphs', () => {
    const doc = sampleDoc();
    const res = extractSelection(fakeView(doc, 1, doc.content.size - 1), IDENT);
    if (!res.ok) throw new Error(res.error);
    expect(res.items.map((i) => i.kind)).toEqual(['block', 'tag', 'undertag', 'cite']);
  });
  it('cursor above all headings errors instead of guessing', () => {
    const doc = makeDoc([paragraph('intro'), heading('block', 'B')]);
    const res = extractSelection(fakeView(doc, 2), IDENT);
    expect(res).toEqual({ ok: false, error: 'no-heading-at-cursor' });
  });
  it('selection with only body content yields empty-selection', () => {
    const doc = sampleDoc();
    // select inside the loose trailing paragraph only
    const paraStart = doc.content.size - doc.child(2).nodeSize;
    const res = extractSelection(fakeView(doc, paraStart + 1, paraStart + 6), IDENT);
    expect(res).toEqual({ ok: false, error: 'empty-selection' });
  });

  it('never emits self_ref mirrored content', () => {
    const srcId = newHeadingId();
    // A live view mirrors the block above it; its child is a derived copy of
    // the same text. Without the guard the mirror emits 'AT: Framework' twice.
    const doc = makeDoc([
      heading('block', 'AT: Framework', srcId),
      card(heading('tag', 'Perm solves')),
      selfRef(srcId, [heading('block', 'AT: Framework')]),
    ]);
    const res = extractSelection(fakeView(doc, 1, doc.content.size - 1), IDENT);
    if (!res.ok) throw new Error(res.error);
    const framework = res.items.filter((i) => i.text === 'AT: Framework');
    expect(framework.length).toBe(1);
  });

  it('names an analytic itself and scopes its undertag to it', () => {
    const anId = newHeadingId();
    const doc = makeDoc([analyticUnit(heading('analytic', 'A1', anId), undertag('detail'))]);
    const res = extractSelection(fakeView(doc, 1, doc.content.size - 1), IDENT);
    if (!res.ok) throw new Error(res.error);
    expect(res.items.map((i) => i.kind)).toEqual(['analytic', 'undertag']);
    const ut = res.items.find((i) => i.kind === 'undertag')!;
    expect(parseSourceToken(res.items[0]!.source)!.headingId).toBe(anId);
    expect(parseSourceToken(ut.source)!.scopeId).toBe(anId);
  });

  it('scopes a top-level undertag to the nearest preceding heading', () => {
    const bId = newHeadingId();
    const doc = makeDoc([heading('block', 'Section', bId), undertag('loose note')]);
    const res = extractSelection(fakeView(doc, 1, doc.content.size - 1), IDENT);
    if (!res.ok) throw new Error(res.error);
    const ut = res.items.find((i) => i.kind === 'undertag')!;
    expect(parseSourceToken(ut.source)!.scopeId).toBe(bId);
  });

  it('scopes a mid-card selection to the tag outside the range', () => {
    const tId = newHeadingId();
    const doc = makeDoc([card(heading('tag', 'Tag here', tId), undertag('mid detail'))]);
    const utPos = posOf(doc, 'undertag');
    // Select only inside the undertag text — the tag sits before sel.from.
    const res = extractSelection(fakeView(doc, utPos + 2, utPos + 6), IDENT);
    if (!res.ok) throw new Error(res.error);
    expect(res.items.map((i) => i.kind)).toEqual(['undertag']);
    expect(parseSourceToken(res.items[0]!.source)!.scopeId).toBe(tId);
  });

  it('anchors resolve back to the item text', () => {
    const doc = sampleDoc();
    const res = extractSelection(fakeView(doc, 1, doc.content.size - 1), IDENT);
    if (!res.ok) throw new Error(res.error);
    const block = res.items.find((i) => i.kind === 'block')!;
    const anchor = parseSourceToken(block.source)!.anchor;
    expect(anchor).not.toBeNull();
    const resolved = resolveDescriptor(doc, anchor!);
    expect(resolved).not.toBeNull();
    const text = doc.textBetween(resolved!.from, resolved!.to, ' ');
    expect(text).toContain('AT: Framework');
  });

  it('collapsed cursor in a block section stops at the next same-level heading', () => {
    const aId = newHeadingId();
    const bId = newHeadingId();
    const doc = makeDoc([
      heading('block', 'Block A', aId),
      card(heading('tag', 'A tag')),
      heading('block', 'Block B', bId),
      card(heading('tag', 'B tag')),
    ]);
    // Cursor inside the 'Block A' heading.
    const res = extractSelection(fakeView(doc, 2), IDENT);
    if (!res.ok) throw new Error(res.error);
    const texts = res.items.map((i) => i.text);
    expect(texts).toContain('Block A');
    expect(texts).toContain('A tag');
    expect(texts).not.toContain('Block B');
    expect(texts).not.toContain('B tag');
  });

  it('a one-character graze emits the whole item', () => {
    const doc = makeDoc([
      card(heading('tag', 'First tag')),
      heading('block', 'Grazed heading'),
    ]);
    const blockPos = posOf(doc, 'block');
    // Selection ends one char into the block heading; it emits in full.
    const res = extractSelection(fakeView(doc, 1, blockPos + 2), IDENT);
    if (!res.ok) throw new Error(res.error);
    const grazed = res.items.find((i) => i.kind === 'block');
    expect(grazed?.text).toBe('Grazed heading');
  });
});
