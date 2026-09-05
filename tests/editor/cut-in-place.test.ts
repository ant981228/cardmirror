// @vitest-environment jsdom
/**
 * Cut in place (shared documents): a whole-unit cut marks instead of
 * deleting; the paste in the same document MOVES the live units in one
 * transaction (ids kept); anything else on the clipboard clears the
 * mark; Esc / Cmd-Z clear it; a partner's delete makes the paste refuse;
 * cross-document paste removes the units from an open source.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EditorState, NodeSelection, TextSelection, type Plugin } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { buildSimilarSelectionPlugin, setManualShadowSelection } from '../../src/editor/similar-selection-plugin.js';
import {
  buildCutInPlacePlugin,
  cutInPlaceKey,
  installCutInPlaceContext,
  handleCutInPlacePaste,
  pendingCut,
  CUT_MARKER_ATTR,
  CUT_PENDING_CLASS,
} from '../../src/editor/cut-in-place.js';

function card(tag: string, body: string): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
function mk(key: string, ...children: PMNode[]): EditorView {
  const doc = schema.nodes['doc']!.create(null, children);
  const el = document.createElement('div');
  document.body.appendChild(el);
  const view = new EditorView(el, { state: EditorState.create({ doc, plugins: [buildSimilarSelectionPlugin(), buildCutInPlacePlugin()] }) });
  keys.set(view, key);
  views.set(key, view);
  return view;
}
function heads(doc: PMNode): string[] {
  const out: string[] = [];
  doc.forEach((c) => out.push(c.firstChild?.textContent ?? '?'));
  return out;
}
function ids(doc: PMNode): string[] {
  const out: string[] = [];
  doc.forEach((c) => out.push(String(c.firstChild?.attrs['id'])));
  return out;
}
function cardPos(doc: PMNode, head: string): number {
  let pos = 0;
  let found = -1;
  doc.forEach((c) => {
    if (found < 0 && c.firstChild?.textContent === head) found = pos;
    pos += c.nodeSize;
  });
  if (found < 0) throw new Error(`no card ${head}`);
  return found;
}
function selectCard(view: EditorView, head: string): void {
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, cardPos(view.state.doc, head))));
}
function caretInBody(view: EditorView, head: string): void {
  const pos = cardPos(view.state.doc, head);
  const node = view.state.doc.nodeAt(pos)!;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1 + node.firstChild!.nodeSize + 2)));
}
function plugin(view: EditorView): Plugin {
  return cutInPlaceKey.get(view.state)!;
}
function fireCut(view: EditorView): { handled: boolean; prevented: boolean } {
  let prevented = false;
  const ev = { preventDefault: () => { prevented = true; } } as unknown as ClipboardEvent;
  const handled = plugin(view).props.handleDOMEvents!['cut']!.call(plugin(view), view, ev) as boolean;
  return { handled, prevented };
}
function fireKey(view: EditorView, key: string, mods: Partial<KeyboardEvent> = {}): boolean {
  const ev = new KeyboardEvent('keydown', { key, ...mods });
  return plugin(view).props.handleKeyDown!.call(plugin(view), view, ev) as boolean;
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const keys = new Map<EditorView, string>();
const views = new Map<string, EditorView>();
let written: { html: string; text: string } | null = null;
let sessionDoc = true;
let reachable = true;
let noticeSeen = true;

beforeEach(() => {
  written = null;
  sessionDoc = true;
  reachable = true;
  noticeSeen = true;
  installCutInPlaceContext({
    isSessionDoc: () => sessionDoc,
    docKey: (v) => keys.get(v) ?? null,
    viewForDocKey: (k) => (reachable ? views.get(k) ?? null : null),
    hasSeenNotice: () => noticeSeen,
    markNoticeSeen: () => { noticeSeen = true; },
    writeClipboard: async (html, text) => { written = { html, text }; return true; },
    clipboardBusyMessage: 'busy',
  });
});
afterEach(() => {
  for (const v of views.values()) v.destroy();
  views.clear();
  keys.clear();
  installCutInPlaceContext(null);
});

describe('cut in place', () => {
  it('a whole-card cut in a shared document marks and copies, and deletes nothing', async () => {
    const v = mk('A', card('One', 'one'), card('Two', 'two'), card('Three', 'three'));
    selectCard(v, 'Two');
    const { handled, prevented } = fireCut(v);
    expect(handled).toBe(true);
    expect(prevented).toBe(true);
    await flush();
    expect(heads(v.state.doc)).toEqual(['One', 'Two', 'Three']);
    const p = pendingCut(v.state)!;
    expect(p.items.map((i) => i.id)).toEqual([ids(v.state.doc)[1]]);
    expect(written!.html).toContain(`${CUT_MARKER_ATTR}="A|${p.nonce}"`);
    expect(written!.html).toContain('Two');
    expect(written!.text).toContain('two');
    expect(v.dom.querySelectorAll(`.${CUT_PENDING_CLASS}`).length).toBe(1);
  });

  it('a text selection spanning the whole card (Select Current Heading) counts as the card', async () => {
    const v = mk('A', card('One', 'one'), card('Two', 'two'), card('Three', 'three'));
    const pos = cardPos(v.state.doc, 'Two');
    const node = v.state.doc.nodeAt(pos)!;
    // From the first character of the tag to the last of the body.
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, pos + 2, pos + node.nodeSize - 2)));
    expect(fireCut(v).handled).toBe(true);
    await flush();
    expect(pendingCut(v.state)!.items[0]!.id).toBe(ids(v.state.doc)[1]);
    expect(heads(v.state.doc)).toEqual(['One', 'Two', 'Three']);
    // Leaving out the last character is a text cut, not the card.
    fireKey(v, 'Escape');
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, pos + 2, pos + node.nodeSize - 3)));
    expect(fireCut(v).handled).toBe(false);
  });

  it('a text selection, or a solo document, keeps the ordinary cut', () => {
    const v = mk('A', card('One', 'one'), card('Two', 'two'));
    caretInBody(v, 'Two');
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, v.state.selection.from, v.state.selection.from + 2)));
    expect(fireCut(v).handled).toBe(false);
    selectCard(v, 'Two');
    sessionDoc = false;
    expect(fireCut(v).handled).toBe(false);
    expect(pendingCut(v.state)).toBeNull();
  });

  it('pasting our payload in the same document MOVES the card in one transaction, ids kept', async () => {
    const v = mk('A', card('One', 'one'), card('Two', 'two'), card('Three', 'three'));
    const before = ids(v.state.doc);
    selectCard(v, 'One');
    fireCut(v);
    await flush();
    // Caret at the very start of Three's tag: the nearest outline slot is
    // right before Three (from deep inside a body it may be the doc end).
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, cardPos(v.state.doc, 'Three') + 2)));
    let dispatches = 0;
    const orig = v.dispatch.bind(v);
    v.dispatch = (tr) => { dispatches++; orig(tr); };
    expect(handleCutInPlacePaste(v, written!.html)).toBe(true);
    expect(dispatches).toBe(1);
    expect(heads(v.state.doc)).toEqual(['Two', 'One', 'Three']);
    expect(ids(v.state.doc).sort()).toEqual([...before].sort());
    expect(pendingCut(v.state)).toBeNull();
    expect(v.dom.querySelectorAll(`.${CUT_PENDING_CLASS}`).length).toBe(0);
  });

  it('anything else on the clipboard ends the cut; our payload after that is an ordinary paste', async () => {
    const v = mk('A', card('One', 'one'), card('Two', 'two'));
    selectCard(v, 'Two');
    fireCut(v);
    await flush();
    const ours = written!.html;
    expect(handleCutInPlacePaste(v, '<p>from a browser</p>')).toBe(false);
    expect(pendingCut(v.state)).toBeNull();
    expect(handleCutInPlacePaste(v, ours)).toBe(false); // mark gone: a copy, the paste plugin's business
    expect(heads(v.state.doc)).toEqual(['One', 'Two']);
  });

  it('Esc and Cmd-Z clear the mark (and Cmd-Z is consumed only then); copy clears it too', async () => {
    const v = mk('A', card('One', 'one'), card('Two', 'two'));
    expect(fireKey(v, 'z', { metaKey: true })).toBe(false); // nothing pending: undo passes through
    selectCard(v, 'Two');
    fireCut(v);
    await flush();
    expect(fireKey(v, 'Escape')).toBe(true);
    expect(pendingCut(v.state)).toBeNull();
    fireCut(v);
    await flush();
    expect(fireKey(v, 'z', { metaKey: true, shiftKey: true })).toBe(false); // redo untouched
    expect(fireKey(v, 'z', { metaKey: true })).toBe(true);
    expect(pendingCut(v.state)).toBeNull();
    fireCut(v);
    await flush();
    plugin(v).props.handleDOMEvents!['copy']!.call(plugin(v), v, {} as ClipboardEvent);
    expect(pendingCut(v.state)).toBeNull();
    expect(heads(v.state.doc)).toEqual(['One', 'Two']);
  });

  it('a partner deleting the marked card makes the paste refuse, never a silent copy', async () => {
    const v = mk('A', card('One', 'one'), card('Two', 'two'), card('Three', 'three'));
    selectCard(v, 'Two');
    fireCut(v);
    await flush();
    const pos = cardPos(v.state.doc, 'Two');
    v.dispatch(v.state.tr.delete(pos, pos + v.state.doc.nodeAt(pos)!.nodeSize)); // "the partner"
    expect(pendingCut(v.state), 'a deleted unit stays pending, id only').not.toBeNull();
    caretInBody(v, 'One');
    expect(handleCutInPlacePaste(v, written!.html)).toBe(true); // consumed: refused with a note
    expect(heads(v.state.doc)).toEqual(['One', 'Three']);
    expect(pendingCut(v.state)).toBeNull();
    expect(handleCutInPlacePaste(v, written!.html)).toBe(false); // pasting again: an ordinary copy
  });

  it('a drag of the marked card (already a move) clears the mark', async () => {
    const v = mk('A', card('One', 'one'), card('Two', 'two'), card('Three', 'three'));
    selectCard(v, 'Two');
    fireCut(v);
    await flush();
    const pos = cardPos(v.state.doc, 'Two');
    const node = v.state.doc.nodeAt(pos)!;
    const tr = v.state.tr.delete(pos, pos + node.nodeSize);
    tr.insert(0, node);
    v.dispatch(tr);
    expect(heads(v.state.doc)).toEqual(['Two', 'One', 'Three']);
    expect(pendingCut(v.state)).toBeNull();
  });

  it('a remote batch that re-renders the marked card keeps the mark (only a local drag ends it)', async () => {
    const v = mk('A', card('One', 'one'), card('Two', 'two'), card('Three', 'three'));
    selectCard(v, 'Two');
    fireCut(v);
    await flush();
    // The binding applies a partner's edit as a replace of the whole card
    // region, stamped with the sync meta — the card is "new" to the mapping.
    const pos = cardPos(v.state.doc, 'Two');
    const node = v.state.doc.nodeAt(pos)!;
    const edited = card('Two', 'two +partner');
    const same = schema.nodes['card']!.createChecked(null, [
      schema.nodes['tag']!.create({ id: node.firstChild!.attrs['id'] }, schema.text('Two')),
      edited.child(1),
    ]);
    v.dispatch(v.state.tr.replaceWith(pos, pos + node.nodeSize, same).setMeta('loro-sync$', { type: 'non-local-updates' }));
    const p = pendingCut(v.state)!;
    expect(p, 'still pending').not.toBeNull();
    expect(p.items[0]!.to - p.items[0]!.from, 're-resolved to the live range').toBe(same.nodeSize);
    expect(v.dom.querySelectorAll(`.${CUT_PENDING_CLASS}`).length).toBe(1);
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, cardPos(v.state.doc, 'One') + 2)));
    expect(handleCutInPlacePaste(v, written!.html)).toBe(true);
    expect(heads(v.state.doc)).toEqual(['Two', 'One', 'Three']);
    expect(v.state.doc.firstChild!.child(1).textContent, "the partner's edit travelled").toBe('two +partner');
  });

  it('a multi-card selection cuts and moves all of them in document order', async () => {
    const v = mk('A', card('One', 'one'), card('Two', 'two'), card('Three', 'three'), card('Four', 'four'));
    const d = v.state.doc;
    const r = (h: string): { from: number; to: number } => ({ from: cardPos(d, h), to: cardPos(d, h) + d.nodeAt(cardPos(d, h))!.nodeSize });
    setManualShadowSelection(v, [r('One'), r('Three')]);
    fireCut(v);
    await flush();
    expect(pendingCut(v.state)!.items.length).toBe(2);
    caretInBody(v, 'Four');
    expect(handleCutInPlacePaste(v, written!.html)).toBe(true);
    const h = heads(v.state.doc);
    expect(h.sort()).toEqual(['Four', 'One', 'Three', 'Two']);
    expect(h.indexOf('One') < h.indexOf('Three'), 'original order kept').toBe(true);
    expect(pendingCut(v.state)).toBeNull();
  });

  it('cross-document paste is a copy there and removes the units from an OPEN source', async () => {
    const a = mk('A', card('One', 'one'), card('Two', 'two'));
    const b = mk('B', card('Other', 'other'));
    selectCard(a, 'Two');
    fireCut(a);
    await flush();
    expect(handleCutInPlacePaste(b, written!.html), 'the ordinary paste proceeds in B').toBe(false);
    expect(heads(a.state.doc), 'removed from the source').toEqual(['One']);
    expect(pendingCut(a.state)).toBeNull();
    // Source not reachable (closed / another window): it keeps the card.
    selectCard(a, 'One');
    fireCut(a);
    await flush();
    reachable = false;
    expect(handleCutInPlacePaste(b, written!.html)).toBe(false);
    expect(heads(a.state.doc)).toEqual(['One']);
  });
});
