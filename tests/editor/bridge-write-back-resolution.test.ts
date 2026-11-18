// @vitest-environment jsdom
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
import { resolveJumpInView } from '../../src/editor/plugin-jump.js';
import { readModePlugin, PMD_READ_MODE_TOGGLE } from '../../src/editor/read-mode-plugin.js';

const TAG_TEXT = 'Warming is anthropogenic';
const UNDERTAG_TEXT = 'Only the trend line is contested';
const ident = { docId: 'd1', docTitle: 'doc.cmir' };

function card(tagId: string, undertag: string | null = UNDERTAG_TEXT): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: tagId }, schema.text(TAG_TEXT)),
    ...(undertag ? [schema.nodes['undertag']!.create(null, schema.text(undertag))] : []),
    schema.nodes['card_body']!.create(null, schema.text('Body text nobody outside may rewrite.')),
  ]);
}

function makeView(children: PMNode[], plugins: EditorState['plugins'] = []): EditorView {
  const doc = schema.nodes['doc']!.createChecked(null, children);
  const place = document.createElement('div');
  document.body.appendChild(place);
  return new EditorView(place, { state: EditorState.create({ doc, plugins }) });
}

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

function textOf(view: EditorView, type: string, nth = 0): string {
  return view.state.doc.resolve(startOf(view, type, nth)).parent.textContent;
}

/** The token /extract mints for the nth textblock of `type`. */
function tokenFor(view: EditorView, type: string, nth = 0): string {
  const from = startOf(view, type, nth);
  const node = view.state.doc.resolve(from).parent;
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, from, from + node.content.size)),
  );
  const res = extractSelection(view, ident);
  if (!res.ok) throw new Error(res.error);
  const item = res.items.find((i) => i.kind === (type === 'cite_paragraph' ? 'cite' : type));
  if (!item) throw new Error(`no ${type} item`);
  return item.source;
}

/** A token as earlier builds minted it, before the target/scope split: governing heading in
 *  headingId, no scopeId. */
function legacyTokenFor(view: EditorView, type: string, governingId: string): string {
  const from = startOf(view, type);
  const node = view.state.doc.resolve(from).parent;
  const legacy = {
    docId: 'd1',
    docTitle: 'doc.cmir',
    headingId: governingId,
    anchor: buildDescriptor(view.state.doc, from, from + node.content.size),
  };
  const b64 = btoa(JSON.stringify(legacy)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `cmsrc1.${b64}`;
}

describe('bridge write-back: which line a token names', () => {
  it('/replace in read mode refuses instead of reporting a write that was filtered', () => {
    const tagId = newHeadingId();
    const view = makeView([card(tagId)], [readModePlugin]);
    const token = tokenFor(view, 'undertag');
    // Exactly what applyReadMode does: stay editable, flip the plugin on.
    view.setProps({ editable: () => true });
    view.dispatch(view.state.tr.setMeta(PMD_READ_MODE_TOGGLE, true));
    const before = view.state.doc;
    const res = replaceTokenInView(view, 'd1', token, 'Rewritten by the flow app');
    // The doc did not change (read mode's filterTransaction dropped it)...
    expect(view.state.doc.eq(before)).toBe(true);
    // ...so the route must refuse (doc-readonly), not report success.
    expect(res).toMatchObject({ ok: false });
  });

  it('/insert-after in read mode answers doc-readonly, not internal', () => {
    const tagId = newHeadingId();
    const view = makeView([card(tagId)], [readModePlugin]);
    const token = tokenFor(view, 'undertag');
    view.setProps({ editable: () => true });
    view.dispatch(view.state.tr.setMeta(PMD_READ_MODE_TOGGLE, true));
    const res = insertAfterTokenInView(view, 'd1', token, 'New line');
    expect(res).toEqual({ ok: false, error: 'doc-readonly' });
  });

  it('/replace rewrites the whole textblock after the line grew in CardMirror', () => {
    const tagId = newHeadingId();
    const view = makeView([card(tagId)]);
    const token = tokenFor(view, 'undertag');
    // The user appends to the undertag in CardMirror after the extract.
    const end = startOf(view, 'undertag') + UNDERTAG_TEXT.length;
    view.dispatch(view.state.tr.insertText(' (per Mann)', end));
    const res = replaceTokenInView(view, 'd1', token, 'Flow text');
    if (res !== 'not-mine' && res.ok) {
      // Either refuse (not-found) or replace the block's whole content.
      expect(textOf(view, 'undertag')).toBe('Flow text');
    }
  });

  it('an earlier-build undertag token whose line was rewritten never writes the tag', () => {
    const tagId = newHeadingId();
    const view = makeView([card(tagId)]);
    const token = legacyTokenFor(view, 'undertag', tagId);
    // User rewrites the undertag in CardMirror; the legacy anchor is now stale.
    const from = startOf(view, 'undertag');
    view.dispatch(view.state.tr.insertText('Completely different words', from, from + UNDERTAG_TEXT.length));
    replaceTokenInView(view, 'd1', token, 'Flow edit meant for the undertag');
    expect(textOf(view, 'tag')).toBe(TAG_TEXT);
  });

  it('/jump and /replace agree on which line an earlier-build token names', () => {
    const tagId = newHeadingId();
    const view = makeView([card(tagId)]);
    const payload = parseSourceToken(legacyTokenFor(view, 'undertag', tagId))!;
    const range = resolveSourceRange(view.state.doc, payload)!;
    expect(view.state.doc.resolve(range.from).parent.type.name).toBe('undertag');
    expect(resolveJumpInView(view, payload)).toBe(true);
    expect(view.state.selection.$head.parent.type.name).toBe('undertag');
  });

  it('/jump honours scope like /replace when the line is gone from its own card', () => {
    const a = newHeadingId();
    const b = newHeadingId();
    const view = makeView([card(a), card(b)]);
    const token = tokenFor(view, 'undertag', 0);
    // Delete card A's undertag; card B (a duplicate) still has the same line.
    const from = startOf(view, 'undertag', 0);
    view.dispatch(view.state.tr.delete(from - 1, from + UNDERTAG_TEXT.length + 1));
    const payload = parseSourceToken(token)!;
    expect(resolveSourceRange(view.state.doc, payload)).toBeNull(); // /replace: not-found
    expect(resolveJumpInView(view, payload)).toBe(false); // /jump must agree
  });

  it('a doc-level undertag after a card resolves through its own /extract token', () => {
    const tagId = newHeadingId();
    const view = makeView([
      card(tagId, null),
      schema.nodes['undertag']!.create(null, schema.text('Loose undertag below the card')),
    ]);
    const token = tokenFor(view, 'undertag');
    const range = resolveSourceRange(view.state.doc, parseSourceToken(token)!);
    expect(range).not.toBeNull();
  });
  it('an earlier-build tag token still names the tag after a rename that keeps the old wording below', () => {
    const tagId = newHeadingId();
    const view = makeView([card(tagId, null)]);
    const token = legacyTokenFor(view, 'tag', tagId); // a tag's own legacy token
    // User retitles the tag and keeps the old wording as an undertag below it.
    const from = startOf(view, 'tag');
    let tr = view.state.tr.insertText('Retitled tag', from, from + TAG_TEXT.length);
    tr = tr.insert(tr.doc.resolve(from).after(), schema.nodes['undertag']!.create(null, schema.text(TAG_TEXT)));
    view.dispatch(tr);
    const range = resolveSourceRange(view.state.doc, parseSourceToken(token)!)!;
    // headingId still resolves, so the token names the tag - as it did before the shim.
    expect(view.state.doc.resolve(range.from).parent.type.name).toBe('tag');
  });
});
