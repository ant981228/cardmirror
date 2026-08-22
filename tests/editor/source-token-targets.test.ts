// @vitest-environment jsdom
/**
 * WHICH LINE a provenance token names.
 *
 * `/extract` mints every item's token with the GOVERNING heading in
 * `headingId` - for an undertag or a cite, that is the card's tag, not the
 * item itself. `resolveSourceRange` treats a resolvable `headingId` as final,
 * so those tokens resolved to the tag: `/replace` overwrote the debater's tag
 * with an edit meant for a qualifier, `/insert-after` added lines in the wrong
 * place, and `/jump` selected the wrong line.
 *
 * The split these tests pin: `headingId` means "this token NAMES that
 * heading", `scopeId` means "resolve the anchor inside that heading's
 * section". Only heading kinds get the former.
 */
import { describe, expect, it } from 'vitest';
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { extractSelection } from '../../src/editor/plugin-extract.js';
import { resolveSourceRange } from '../../src/editor/plugin-source-range.js';
import { mintSourceToken, parseSourceToken } from '../../src/editor/plugin-source-token.js';
import { buildDescriptor } from '../../src/editor/learn-anchor.js';
import { replaceTokenInView } from '../../src/editor/external-replace.js';
import { insertAfterTokenInView } from '../../src/editor/external-insert-after.js';

const TAG_TEXT = 'Warming is anthropogenic';
const UNDERTAG_TEXT = 'Only the trend line is contested';
const CITE_TEXT = 'Mann 24, climate scientist';

const ident = { docId: 'd1', docTitle: 'doc.cmir' };

function card(tagId: string, tagText = TAG_TEXT): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: tagId }, schema.text(tagText)),
    schema.nodes['undertag']!.create(null, schema.text(UNDERTAG_TEXT)),
    // `/extract` reports a cite as the text carrying `cite_mark`, so the
    // fixture has to wear it or the item never emits.
    schema.nodes['cite_paragraph']!.create(
      null,
      schema.text(CITE_TEXT, [schema.marks['cite_mark']!.create()]),
    ),
    schema.nodes['card_body']!.create(null, schema.text('Body text nobody outside may rewrite.')),
  ]);
}

function makeView(...children: PMNode[]): EditorView {
  const doc = schema.nodes['doc']!.createChecked(null, children);
  const place = document.createElement('div');
  document.body.appendChild(place);
  return new EditorView(place, { state: EditorState.create({ doc }) });
}

/** Content start of the first textblock of `type`. */
function startOf(view: EditorView, type: string, nth = 0): number {
  let seen = 0;
  let pos = -1;
  view.state.doc.descendants((node, at) => {
    if (pos >= 0) return false;
    if (node.type.name === type) {
      if (seen === nth) pos = at + 1;
      seen++;
    }
    return pos < 0;
  });
  if (pos < 0) throw new Error(`no ${type} #${nth}`);
  return pos;
}

/** The token `/extract` mints for the item whose textblock is `type`. */
function tokenFor(view: EditorView, type: string): string {
  const from = startOf(view, type);
  const node = view.state.doc.resolve(from).parent;
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.create(view.state.doc, from, from + node.content.size),
    ),
  );
  const res = extractSelection(view, ident);
  if (!res.ok) throw new Error(`extract failed: ${res.error}`);
  const item = res.items[0];
  if (!item) throw new Error('extract emitted nothing');
  return item.source;
}

/** The textblock a token names, as type + text. */
function named(view: EditorView, token: string): { type: string; text: string } | null {
  const payload = parseSourceToken(token);
  if (!payload) throw new Error('unparseable token');
  const range = resolveSourceRange(view.state.doc, payload);
  if (!range) return null;
  const $from = view.state.doc.resolve(range.from);
  return { type: $from.parent.type.name, text: view.state.doc.textBetween(range.from, range.to) };
}

describe('which line a token names', () => {
  it('names the undertag, not the tag above it', () => {
    const view = makeView(card(newHeadingId()));

    expect(named(view, tokenFor(view, 'undertag'))).toEqual({
      type: 'undertag',
      text: UNDERTAG_TEXT,
    });
    view.destroy();
  });

  it('names the cite, not the tag above it', () => {
    const view = makeView(card(newHeadingId()));

    expect(named(view, tokenFor(view, 'cite_paragraph'))).toEqual({
      type: 'cite_paragraph',
      text: CITE_TEXT,
    });
    view.destroy();
  });

  it('still names the tag for a tag token', () => {
    // The guard against over-correcting: a heading kind names itself, and by
    // its id, so retyping the line keeps the token resolving.
    const view = makeView(card(newHeadingId()));

    expect(named(view, tokenFor(view, 'tag'))).toEqual({ type: 'tag', text: TAG_TEXT });
    view.destroy();
  });

  it('carries the governing heading as scope, not as target', () => {
    const tagId = newHeadingId();
    const view = makeView(card(tagId));

    const payload = parseSourceToken(tokenFor(view, 'undertag'))!;
    expect(payload.headingId, 'an undertag names no heading').toBeNull();
    expect(payload.scopeId, 'but records the card it belongs to').toBe(tagId);
    view.destroy();
  });

  it('keeps the scope authoritative when the named line is gone', () => {
    // Two cards with the same undertag wording. The named one is deleted, so
    // the answer is not-found - never the stranger that happens to match.
    const view = makeView(card(newHeadingId()), card(newHeadingId(), 'A different tag'));
    const token = tokenFor(view, 'undertag');

    const at = startOf(view, 'undertag');
    const node = view.state.doc.resolve(at).parent;
    view.dispatch(view.state.tr.delete(at - 1, at - 1 + node.nodeSize));

    expect(named(view, token)).toBeNull();
    view.destroy();
  });

  it('resolves a legacy token, minted before the split, to its own line', () => {
    // What ebb already stores: the governing tag in `headingId`, the item's
    // own text in the anchor, and no scope. The anchor decides.
    const tagId = newHeadingId();
    const view = makeView(card(tagId));
    const from = startOf(view, 'undertag');
    const legacy = mintSourceToken({
      docId: ident.docId,
      docTitle: ident.docTitle,
      headingId: tagId,
      scopeId: null,
      anchor: buildDescriptor(view.state.doc, from, from + UNDERTAG_TEXT.length),
    });

    expect(named(view, legacy)).toEqual({ type: 'undertag', text: UNDERTAG_TEXT });
    view.destroy();
  });
});

describe('the routes that write through a token', () => {
  it('/replace rewrites the undertag and leaves the tag alone', () => {
    const view = makeView(card(newHeadingId()));
    const token = tokenFor(view, 'undertag');

    expect(replaceTokenInView(view, ident.docId, token, 'Sharpened qualifier')).toMatchObject({
      ok: true,
    });
    expect(view.state.doc.resolve(startOf(view, 'undertag')).parent.textContent).toBe(
      'Sharpened qualifier',
    );
    expect(view.state.doc.resolve(startOf(view, 'tag')).parent.textContent).toBe(TAG_TEXT);
    view.destroy();
  });

  it('/insert-after puts the new line after the undertag, not after the tag', () => {
    const view = makeView(card(newHeadingId()));
    const token = tokenFor(view, 'undertag');

    expect(insertAfterTokenInView(view, ident.docId, token, 'A second qualifier')).toMatchObject({
      ok: true,
    });
    const texts: string[] = [];
    view.state.doc.descendants((node) => {
      if (node.isTextblock) texts.push(node.textContent);
      return true;
    });
    expect(texts.slice(0, 3)).toEqual([TAG_TEXT, UNDERTAG_TEXT, 'A second qualifier']);
    view.destroy();
  });

  it('/insert-after hands back a token naming the line it just wrote', () => {
    const view = makeView(card(newHeadingId()));
    const res = insertAfterTokenInView(
      view,
      ident.docId,
      tokenFor(view, 'undertag'),
      'A second qualifier',
    );
    if (res === 'not-mine' || !res.ok) throw new Error('insert-after failed');

    expect(named(view, res.source)).toEqual({
      type: 'undertag',
      text: 'A second qualifier',
    });
    view.destroy();
  });
});
