/**
 * The external /replace primitive: one silent content rewrite, plus the
 * fresh token the caller has to store because the old one's anchor quotes
 * text that no longer exists.
 */

import { describe, expect, it } from 'vitest';
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { buildDescriptor } from '../../src/editor/learn-anchor.js';
import { replaceTokenInView, type ReplaceResult } from '../../src/editor/external-replace.js';
import { mintSourceToken, parseSourceToken } from '../../src/editor/plugin-source-token.js';

const TAG_ID = newHeadingId();

function tagNode(text: string, id: string | null, marks: readonly Mark[] = []): PMNode {
  return schema.nodes['tag']!.create({ id }, schema.text(text, marks));
}

/** `Intro` block, then a one-card doc whose tag is the replace target. The
 *  body gives the anchor real suffix context to match against. */
function docWith(tag: PMNode): PMNode {
  return schema.nodes['doc']!.createChecked(null, [
    schema.nodes['block']!.create({ id: newHeadingId() }, schema.text('Intro')),
    schema.nodes['card']!.createChecked(null, [
      tag,
      schema.nodes['card_body']!.create(
        null,
        schema.text('Body sentence long enough to supply real anchor context.'),
      ),
    ]),
  ]);
}

function findTag(doc: PMNode): { pos: number; node: PMNode } {
  let pos = -1;
  doc.descendants((n, p) => {
    if (pos < 0 && n.type.name === 'tag') pos = p;
    return pos < 0;
  });
  if (pos < 0) throw new Error('no tag in doc');
  return { pos, node: doc.nodeAt(pos)! };
}

function anchorToken(doc: PMNode, headingId: string | null): string {
  const { pos, node } = findTag(doc);
  return mintSourceToken({
    docId: 'd1',
    docTitle: 'T',
    headingId,
    anchor: buildDescriptor(doc, pos + 1, pos + node.nodeSize - 1),
  });
}

function uuidToken(headingId: string, docId = 'd1'): string {
  return mintSourceToken({ docId, docTitle: 'T', headingId, anchor: null });
}

function makeView(doc: PMNode, opts: { editable?: boolean; caret?: number } = {}) {
  let state = EditorState.create({ doc });
  if (opts.caret !== undefined) {
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, opts.caret)));
  }
  const dispatched: Transaction[] = [];
  const stub = {
    editable: opts.editable !== false,
    get state(): EditorState {
      return state;
    },
    dispatch(tr: Transaction): void {
      dispatched.push(tr);
      state = state.apply(tr);
    },
  };
  return {
    // `replaceTokenInView` reads only `state`, `editable` and `dispatch`.
    // Proving it needs nothing more (no focus, no DOM, no coords) is half
    // the point of the route, so the stub carries nothing more.
    view: stub as unknown as EditorView,
    dispatched,
    get state(): EditorState {
      return stub.state;
    },
  };
}

/** Narrow a success and hand back the re-minted token. */
function okSource(r: ReplaceResult | 'not-mine'): string {
  if (r === 'not-mine' || !r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r.source;
}

/** Anchor token naming the card's BODY paragraph - the shape only anchor
 *  drift can produce, since `/extract` never emits a card body. */
function bodyToken(doc: PMNode): string {
  let pos = -1;
  doc.descendants((n, p) => {
    if (pos < 0 && n.type.name === 'card_body') pos = p;
    return pos < 0;
  });
  if (pos < 0) throw new Error('no card_body in doc');
  const node = doc.nodeAt(pos)!;
  return mintSourceToken({
    docId: 'd1',
    docTitle: 'T',
    headingId: null,
    anchor: buildDescriptor(doc, pos + 1, pos + node.nodeSize - 1),
  });
}

describe('replaceTokenInView', () => {
  it("rewrites the named tag's text and leaves the node type intact", () => {
    const v = makeView(docWith(tagNode('Old tag text', TAG_ID)));

    const source = okSource(replaceTokenInView(v.view, 'd1', uuidToken(TAG_ID), 'New tag text'));

    const tag = findTag(v.state.doc).node;
    expect(tag.type.name).toBe('tag');
    expect(tag.textContent).toBe('New tag text');
    // One text node, not a patchwork of runs.
    expect(tag.childCount).toBe(1);
    // Silent: exactly one transaction, and it moves nothing.
    expect(v.dispatched).toHaveLength(1);
    expect(v.dispatched[0]!.scrolledIntoView).toBe(false);
    expect(v.dispatched[0]!.selectionSet).toBe(false);
    expect(v.dispatched[0]!.storedMarksSet).toBe(false);
    // The re-minted token quotes the NEW text and carries the identity over.
    const fresh = parseSourceToken(source)!;
    expect(fresh.anchor!.quote).toBe('New tag text');
    expect(fresh.headingId).toBe(TAG_ID);
    expect(fresh.docId).toBe('d1');
    expect(fresh.docTitle).toBe('T');
  });

  it('keeps a mark that covered the original text', () => {
    const bold = schema.marks['bold']!.create();
    const v = makeView(docWith(tagNode('Old tag text', TAG_ID, [bold])));

    okSource(replaceTokenInView(v.view, 'd1', uuidToken(TAG_ID), 'New tag text'));

    const tag = findTag(v.state.doc).node;
    expect(tag.textContent).toBe('New tag text');
    expect(bold.isInSet(tag.child(0).marks)).toBe(true);
  });

  it('leaves the local selection where it was', () => {
    const v = makeView(docWith(tagNode('Old tag text', TAG_ID)), { caret: 3 });
    expect(v.state.selection.from).toBe(3);

    okSource(replaceTokenInView(v.view, 'd1', uuidToken(TAG_ID), 'New tag text'));

    expect(v.state.selection.from).toBe(3);
    expect(v.state.selection.empty).toBe(true);
  });

  it('answers not-found when the quoted text was already edited away', () => {
    const stale = anchorToken(docWith(tagNode('Old tag text', null)), null);
    const v = makeView(docWith(tagNode('Someone retyped this', null)));

    expect(replaceTokenInView(v.view, 'd1', stale, 'Never lands')).toEqual({
      ok: false,
      error: 'not-found',
      docTitle: 'T',
    });
    expect(v.dispatched).toHaveLength(0);
  });

  it('answers doc-readonly for a view that is not editable', () => {
    const v = makeView(docWith(tagNode('Old tag text', TAG_ID)), { editable: false });

    expect(replaceTokenInView(v.view, 'd1', uuidToken(TAG_ID), 'New tag text')).toEqual({
      ok: false,
      error: 'doc-readonly',
    });
    expect(v.dispatched).toHaveLength(0);
  });

  it('refuses a token that resolves to card body text', () => {
    const doc = docWith(tagNode('Old tag text', TAG_ID));
    const v = makeView(doc);

    expect(replaceTokenInView(v.view, 'd1', bodyToken(doc), 'Rewritten evidence')).toEqual({
      ok: false,
      error: 'body-text',
      docTitle: 'T',
    });
    // The quoted text is untouched: refusal, not a silent no-op elsewhere.
    expect(v.state.doc.textBetween(0, v.state.doc.content.size, ' ')).toContain(
      'Body sentence long enough to supply real anchor context.',
    );
    expect(v.dispatched).toHaveLength(0);
  });

  it('accepts the other kinds /extract emits (undertag, cite)', () => {
    const undertagId = newHeadingId();
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['card']!.createChecked(null, [
        tagNode('Tag text', undertagId),
        schema.nodes['undertag']!.create(null, schema.text('Undertag claim')),
        schema.nodes['cite_paragraph']!.create(null, schema.text('Author 24, some journal')),
      ]),
    ]);
    // Minted against the LIVE doc each time: a descriptor quotes its
    // surroundings, so the first write invalidates a token cut from the
    // pre-write doc (the re-mint rule, exercised on its own above).
    const at = (d: PMNode, name: string): string => {
      let pos = -1;
      d.descendants((n, p) => {
        if (pos < 0 && n.type.name === name) pos = p;
        return pos < 0;
      });
      const node = d.nodeAt(pos)!;
      return mintSourceToken({
        docId: 'd1',
        docTitle: 'T',
        headingId: null,
        anchor: buildDescriptor(d, pos + 1, pos + node.nodeSize - 1),
      });
    };

    const v = makeView(doc);
    okSource(replaceTokenInView(v.view, 'd1', at(doc, 'undertag'), 'Edited undertag'));
    okSource(
      replaceTokenInView(
        v.view,
        'd1',
        at(v.state.doc, 'cite_paragraph'),
        'Author 2024, some journal',
      ),
    );

    expect(v.state.doc.textBetween(0, v.state.doc.content.size, ' ')).toContain('Edited undertag');
    expect(v.dispatched).toHaveLength(2);
  });

  it("answers not-mine for another doc's token", () => {
    const v = makeView(docWith(tagNode('Old tag text', TAG_ID)));

    expect(replaceTokenInView(v.view, 'd1', uuidToken(TAG_ID, 'other'), 'New tag text')).toBe(
      'not-mine',
    );
    // A window with no doc open owns no token either.
    expect(replaceTokenInView(v.view, null, uuidToken(TAG_ID), 'New tag text')).toBe('not-mine');
    expect(v.dispatched).toHaveLength(0);
  });

  it('answers bad-request for empty text, a newline, or a garbage token', () => {
    const v = makeView(docWith(tagNode('Old tag text', TAG_ID)));
    const token = uuidToken(TAG_ID);

    expect(replaceTokenInView(v.view, 'd1', token, '')).toEqual({
      ok: false,
      error: 'bad-request',
    });
    expect(replaceTokenInView(v.view, 'd1', token, 'two\nlines')).toEqual({
      ok: false,
      error: 'bad-request',
    });
    expect(replaceTokenInView(v.view, 'd1', 'garbage', 'New tag text')).toEqual({
      ok: false,
      error: 'bad-request',
    });
    expect(v.dispatched).toHaveLength(0);
  });

  it('replaces twice when the caller stores the returned token', () => {
    // Anchor-only tokens on purpose: a token carrying a heading UUID resolves
    // by id and survives any edit, so the re-mint only earns its keep here.
    const doc = docWith(tagNode('First text', null));
    const first = anchorToken(doc, null);
    const v = makeView(doc);

    const second = okSource(replaceTokenInView(v.view, 'd1', first, 'Second text'));
    okSource(replaceTokenInView(v.view, 'd1', second, 'Third text'));

    expect(findTag(v.state.doc).node.textContent).toBe('Third text');
    expect(v.dispatched).toHaveLength(2);
  });

  it('answers not-found when the caller reuses the stale token', () => {
    const doc = docWith(tagNode('First text', null));
    const first = anchorToken(doc, null);
    const v = makeView(doc);

    okSource(replaceTokenInView(v.view, 'd1', first, 'Second text'));

    // Same token, same window: its quote is gone, so nothing resolves and
    // nothing is written.
    expect(replaceTokenInView(v.view, 'd1', first, 'Third text')).toEqual({
      ok: false,
      error: 'not-found',
      docTitle: 'T',
    });
    expect(findTag(v.state.doc).node.textContent).toBe('Second text');
    expect(v.dispatched).toHaveLength(1);
  });
});
