/**
 * The external /insert-after primitive: one silent same-type sibling
 * after the line a token names, plus the token for that new line - which
 * is the only handle the caller will ever have to text it just created.
 */

import { describe, expect, it } from 'vitest';
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { buildDescriptor } from '../../src/editor/learn-anchor.js';
import {
  insertAfterTokenInView,
  type InsertAfterResult,
} from '../../src/editor/external-insert-after.js';
import { resolveSourceRange } from '../../src/editor/plugin-source-range.js';
import { mintSourceToken, parseSourceToken } from '../../src/editor/plugin-source-token.js';

const TAG_ID = newHeadingId();

function tagNode(text: string, id: string | null): PMNode {
  return schema.nodes['tag']!.create({ id }, schema.text(text));
}

function bodyNode(text = 'Body sentence long enough to supply real anchor context.'): PMNode {
  return schema.nodes['card_body']!.create(null, schema.text(text));
}

/** `Intro` block, then one card built from `cardChildren`. The body gives
 *  a descriptor real suffix context to match against. */
function docWith(...cardChildren: PMNode[]): PMNode {
  return schema.nodes['doc']!.createChecked(null, [
    schema.nodes['block']!.create({ id: newHeadingId() }, schema.text('Intro')),
    schema.nodes['card']!.createChecked(null, cardChildren),
  ]);
}

function firstOfType(doc: PMNode, name: string): { pos: number; node: PMNode } {
  let pos = -1;
  doc.descendants((n, p) => {
    if (pos < 0 && n.type.name === name) pos = p;
    return pos < 0;
  });
  if (pos < 0) throw new Error(`no ${name} in doc`);
  return { pos, node: doc.nodeAt(pos)! };
}

/** Anchor-only token (no heading UUID) for the first node of `name` - the
 *  shape an undertag or a cite travels as. */
function anchorToken(doc: PMNode, name: string): string {
  const { pos, node } = firstOfType(doc, name);
  return mintSourceToken({
    docId: 'd1',
    docTitle: 'T',
    headingId: null,
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
    // `insertAfterTokenInView` reads only `state`, `editable` and
    // `dispatch`. Proving it needs nothing more - no focus, no DOM, no
    // coords - is half the point of the route, so the stub carries
    // nothing more.
    view: stub as unknown as EditorView,
    dispatched,
    get state(): EditorState {
      return stub.state;
    },
  };
}

/** Narrow a success and hand back the minted token. */
function okSource(r: InsertAfterResult | 'not-mine'): string {
  if (r === 'not-mine' || !r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r.source;
}

/** The text `token` names in `doc`, by the same resolution the route uses. */
function textAt(doc: PMNode, token: string): string {
  const range = resolveSourceRange(doc, parseSourceToken(token)!);
  if (!range) throw new Error('token does not resolve');
  return doc.textBetween(range.from, range.to);
}

function typeNames(node: PMNode): string[] {
  return Array.from({ length: node.childCount }, (_, i) => node.child(i).type.name);
}

describe('insertAfterTokenInView', () => {
  it("puts a new card with a tag right after the anchor tag's card", () => {
    const v = makeView(docWith(tagNode('Old tag text', TAG_ID), bodyNode()));

    const source = okSource(
      insertAfterTokenInView(v.view, 'd1', uuidToken(TAG_ID), 'Added tag line'),
    );

    // A tag is only legal as a card's first child, so the sibling is a
    // whole new card - placed after the anchor's card, not inside it.
    const doc = v.state.doc;
    expect(typeNames(doc)).toEqual(['block', 'card', 'card']);
    const anchorCard = doc.child(1);
    // The anchor's own card is untouched: same children, same text.
    expect(typeNames(anchorCard)).toEqual(['tag', 'card_body']);
    expect(anchorCard.child(0).textContent).toBe('Old tag text');
    expect(anchorCard.child(1).textContent).toContain('Body sentence');
    const added = doc.child(2);
    expect(typeNames(added)).toEqual(['tag']);
    expect(added.child(0).textContent).toBe('Added tag line');
    // A fresh heading owns its own id - the nav pane needs one, and it
    // must not be the anchor's.
    const freshId = added.child(0).attrs['id'];
    expect(typeof freshId).toBe('string');
    expect(freshId).not.toBe(TAG_ID);
    expect(parseSourceToken(source)!.headingId).toBe(freshId);
  });

  it('dispatches exactly one transaction and moves nothing', () => {
    const v = makeView(docWith(tagNode('Old tag text', TAG_ID), bodyNode()), { caret: 3 });
    expect(v.state.selection.from).toBe(3);

    okSource(insertAfterTokenInView(v.view, 'd1', uuidToken(TAG_ID), 'Added tag line'));

    // One transaction: a single Cmd-Z takes the whole insert back, and
    // the collab plugin mirrors it as one step batch.
    expect(v.dispatched).toHaveLength(1);
    expect(v.dispatched[0]!.scrolledIntoView).toBe(false);
    expect(v.dispatched[0]!.selectionSet).toBe(false);
    expect(v.dispatched[0]!.storedMarksSet).toBe(false);
    expect(v.state.selection.from).toBe(3);
    expect(v.state.selection.empty).toBe(true);
  });

  it("adds plain text, not the anchor's styling", () => {
    // Nothing styled this line, so dressing it in a neighbour's marks
    // would be a guess about intent.
    const bold = schema.marks['bold']!.create();
    const v = makeView(
      docWith(
        schema.nodes['tag']!.create({ id: TAG_ID }, schema.text('Old tag text', [bold])),
        bodyNode(),
      ),
    );

    okSource(insertAfterTokenInView(v.view, 'd1', uuidToken(TAG_ID), 'Added tag line'));

    expect(v.state.doc.child(2).child(0).child(0).marks).toHaveLength(0);
  });

  it('puts an undertag and a cite beside the anchor, inside the same card', () => {
    const v = makeView(
      docWith(
        tagNode('Tag text', TAG_ID),
        schema.nodes['undertag']!.create(null, schema.text('Undertag claim')),
        schema.nodes['cite_paragraph']!.create(null, schema.text('Author 24, some journal')),
      ),
    );

    // Minted against the LIVE doc each time: a descriptor quotes its
    // surroundings, so a token cut from the pre-insert doc can go stale.
    okSource(
      insertAfterTokenInView(v.view, 'd1', anchorToken(v.state.doc, 'undertag'), 'Second claim'),
    );
    okSource(
      insertAfterTokenInView(v.view, 'd1', anchorToken(v.state.doc, 'cite_paragraph'), 'Author 25'),
    );

    // Still one card: these kinds are legal card children, so neither
    // insert wrapped anything in a container.
    const doc = v.state.doc;
    expect(typeNames(doc)).toEqual(['block', 'card']);
    const card = doc.child(1);
    expect(typeNames(card)).toEqual([
      'tag',
      'undertag',
      'undertag',
      'cite_paragraph',
      'cite_paragraph',
    ]);
    expect(card.child(2).textContent).toBe('Second claim');
    expect(card.child(4).textContent).toBe('Author 25');
    expect(v.dispatched).toHaveLength(2);
  });

  it('the token in the reply addresses the line that was just created', () => {
    // The whole point of returning a token: the caller can edit, jump to
    // or insert after a line nothing named a moment ago.
    const v = makeView(docWith(tagNode('Tag text', TAG_ID), bodyNode()));

    const first = okSource(insertAfterTokenInView(v.view, 'd1', uuidToken(TAG_ID), 'First added'));
    expect(textAt(v.state.doc, first)).toBe('First added');

    // Chain off the reply: the new line is a real anchor, not a
    // write-only success message.
    const second = okSource(insertAfterTokenInView(v.view, 'd1', first, 'Second added'));
    expect(textAt(v.state.doc, second)).toBe('Second added');
    const doc = v.state.doc;
    expect(
      Array.from({ length: doc.childCount }, (_, i) =>
        doc.child(i).isTextblock ? doc.child(i).textContent : doc.child(i).child(0).textContent,
      ),
    ).toEqual(['Intro', 'Tag text', 'First added', 'Second added']);
  });

  it("resolves an undertag reply token through the descriptor", () => {
    // An undertag carries no heading id of its own, so its reply token
    // resolves by anchor rather than by UUID.
    const v = makeView(
      docWith(
        tagNode('Tag text', TAG_ID),
        schema.nodes['undertag']!.create(null, schema.text('Undertag claim')),
        bodyNode(),
      ),
    );

    const source = okSource(
      insertAfterTokenInView(v.view, 'd1', anchorToken(v.state.doc, 'undertag'), 'Added claim'),
    );

    expect(parseSourceToken(source)!.anchor!.quote).toBe('Added claim');
    expect(textAt(v.state.doc, source)).toBe('Added claim');
  });

  it('refuses a token that resolves to card body text', () => {
    const doc = docWith(tagNode('Old tag text', TAG_ID), bodyNode());
    const v = makeView(doc);

    // A card_body sibling would mean an outside app authoring evidence.
    expect(
      insertAfterTokenInView(v.view, 'd1', anchorToken(doc, 'card_body'), 'Made-up quote'),
    ).toEqual({ ok: false, error: 'body-text', docTitle: 'T' });
    expect(typeNames(v.state.doc.child(1))).toEqual(['tag', 'card_body']);
    expect(v.dispatched).toHaveLength(0);
  });

  it('answers bad-request for a garbage token, empty text, or a newline', () => {
    const v = makeView(docWith(tagNode('Old tag text', TAG_ID), bodyNode()));
    const token = uuidToken(TAG_ID);

    expect(insertAfterTokenInView(v.view, 'd1', 'garbage', 'Added line')).toEqual({
      ok: false,
      error: 'bad-request',
    });
    expect(insertAfterTokenInView(v.view, 'd1', token, '')).toEqual({
      ok: false,
      error: 'bad-request',
    });
    expect(insertAfterTokenInView(v.view, 'd1', token, 'two\nlines')).toEqual({
      ok: false,
      error: 'bad-request',
    });
    expect(v.dispatched).toHaveLength(0);
  });

  it("answers not-mine for another doc's token", () => {
    const v = makeView(docWith(tagNode('Old tag text', TAG_ID), bodyNode()));

    expect(insertAfterTokenInView(v.view, 'd1', uuidToken(TAG_ID, 'other'), 'Added line')).toBe(
      'not-mine',
    );
    // A window with no doc open owns no token either.
    expect(insertAfterTokenInView(v.view, null, uuidToken(TAG_ID), 'Added line')).toBe('not-mine');
    expect(v.dispatched).toHaveLength(0);
  });

  it('answers doc-readonly for a view that is not editable', () => {
    const v = makeView(docWith(tagNode('Old tag text', TAG_ID), bodyNode()), { editable: false });

    expect(insertAfterTokenInView(v.view, 'd1', uuidToken(TAG_ID), 'Added line')).toEqual({
      ok: false,
      error: 'doc-readonly',
    });
    expect(v.dispatched).toHaveLength(0);
  });

  it('answers not-found when the anchor no longer resolves', () => {
    const stale = anchorToken(docWith(tagNode('Old tag text', null), bodyNode()), 'tag');
    const v = makeView(docWith(tagNode('Someone retyped this', null), bodyNode()));

    expect(insertAfterTokenInView(v.view, 'd1', stale, 'Never lands')).toEqual({
      ok: false,
      error: 'not-found',
      docTitle: 'T',
    });
    expect(v.dispatched).toHaveLength(0);
  });
});
