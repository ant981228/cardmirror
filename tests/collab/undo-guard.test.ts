// @vitest-environment jsdom
/**
 * Container-safe undo (undo-guard.ts): an undo/redo that would delete a
 * container a partner has edited since is reversed; unedited ones and
 * text-only steps pass. Deterministic in-memory peers, movable rooms.
 */
import { describe, it, expect } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { LoroUndoPlugin } from 'loro-prosemirror';
import { UndoManager, type LoroDoc } from 'loro-crdt';
import { enterMidTag } from '../../src/editor/tag-keymap.js';
import { headingIdGuardPlugin } from '../../src/editor/heading-id-guard.js';
import { createUndoGuard, UNDO_BLOCKED_MESSAGE, REDO_BLOCKED_MESSAGE, type UndoGuard } from '../../src/editor/collab/undo-guard.js';
import { createLoroPeers, settle, docOf, cardNode, type LoroPeer } from './_loro-helpers.js';

declare global {
  // eslint-disable-next-line no-var
  var __CM_MOVABLE_LIST__: boolean | undefined;
}

function textblocks(doc: PMNode): Array<{ start: number; end: number; node: PMNode }> {
  const out: Array<{ start: number; end: number; node: PMNode }> = [];
  doc.descendants((n, pos) => {
    if (n.isTextblock) {
      out.push({ start: pos + 1, end: pos + 1 + n.content.size, node: n });
      return false;
    }
    return true;
  });
  return out;
}
function count(d: PMNode, s: string): number {
  let n = 0;
  for (const tb of textblocks(d)) {
    let i = tb.node.textContent.indexOf(s);
    while (i >= 0) {
      n++;
      i = tb.node.textContent.indexOf(s, i + s.length);
    }
  }
  return n;
}
async function sync(peers: LoroPeer[]): Promise<void> {
  for (let r = 0; r < 3; r++) {
    const blobs = peers.map((p) => p.exportAll());
    peers.forEach((p) => blobs.forEach((b) => p.import(b)));
    await settle();
  }
}
function typeAtEndOf(v: EditorView, pred: (n: PMNode) => boolean, text: string): void {
  const tbs = textblocks(v.state.doc).filter((t) => pred(t.node));
  const tb = tbs[tbs.length - 1]!;
  v.dispatch(v.state.tr.insertText(text, tb.end));
}

interface Rig {
  peers: LoroPeer[];
  guards: UndoGuard[];
  blocked: string[];
}
async function rig(): Promise<Rig> {
  globalThis.__CM_MOVABLE_LIST__ = true;
  const guards: UndoGuard[] = [];
  const blocked: string[] = [];
  const views: Array<EditorView | null> = [];
  const peers = await createLoroPeers(
    docOf(cardNode('Alpha «H0»', ['alpha body one']), cardNode('Bravo «H1»', ['bravo body'])),
    2,
    (ldoc: LoroDoc) => {
      // mergeInterval 0: each edit is its own step, so the scenarios can
      // undo exactly one op (the app's default merges nearby edits).
      const um = new UndoManager(ldoc, { mergeInterval: 0 });
      const idx = guards.length;
      const g = createUndoGuard({ doc: ldoc, undoManager: um, getView: () => views[idx] ?? null, onBlocked: (m) => blocked.push(m) });
      guards.push(g);
      return [headingIdGuardPlugin, LoroUndoPlugin({ doc: ldoc as never, undoManager: um }), g.plugin];
    },
  );
  peers.forEach((p, i) => (views[i] = p.view));
  await settle();
  return { peers, guards, blocked };
}
function splitTagOn(v: EditorView): void {
  v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 2 + 5)));
  enterMidTag(v.state, (tr) => v.dispatch(tr));
}
async function runUndo(r: Rig, i: number): Promise<boolean> {
  const v = r.peers[i]!.view;
  const ran = r.guards[i]!.undo(v.state, (tr) => v.dispatch(tr), v);
  await settle(6);
  await sync(r.peers);
  await settle(6);
  return ran;
}

describe('container-safe undo in co-editing sessions', () => {
  it('Enter-mid-tag, partner types into the new half, undo → reversed, typing kept', async () => {
    const r = await rig();
    const [A, B] = r.peers as [LoroPeer, LoroPeer];
    splitTagOn(A.view);
    await settle();
    await sync(r.peers);
    // B types into the tag of the NEW (first) container.
    const firstTag = textblocks(B.view.state.doc).find((t) => t.node.type.name === 'tag')!;
    B.view.dispatch(B.view.state.tr.insertText(' «B»', firstTag.end));
    await settle();
    await sync(r.peers);
    expect(count(A.doc(), '«B»')).toBe(1);
    await runUndo(r, 0);
    expect(count(A.doc(), '«B»'), "the partner's typing survives").toBe(1);
    expect(count(B.doc(), '«B»')).toBe(1);
    expect(A.doc().childCount, 'the split-off container is still there').toBe(3);
    expect(r.blocked).toEqual([UNDO_BLOCKED_MESSAGE]);
    expect(r.guards[0]!.stats.blocked).toBe(1);
    expect(A.doc().eq(B.doc())).toBe(true);
    for (const p of r.peers) p.destroy();
  });

  it('Enter-mid-tag with nobody editing the new half → undo merges it back as before', async () => {
    const r = await rig();
    const [A, B] = r.peers as [LoroPeer, LoroPeer];
    splitTagOn(A.view);
    await settle();
    await sync(r.peers);
    expect(A.doc().childCount).toBe(3);
    await runUndo(r, 0);
    expect(A.doc().childCount, 'undo allowed: the container was untouched').toBe(2);
    expect(r.blocked).toEqual([]);
    expect(r.guards[0]!.stats.allowed).toBe(1);
    expect(A.doc().eq(B.doc())).toBe(true);
    for (const p of r.peers) p.destroy();
  });

  it('inserted card, partner types into it, undo → reversed; untouched card → undo removes it', async () => {
    const r = await rig();
    const [A, B] = r.peers as [LoroPeer, LoroPeer];
    A.view.dispatch(A.view.state.tr.insert(A.view.state.doc.content.size, cardNode('Fresh «HN»', ['fresh body'])));
    await settle();
    await sync(r.peers);
    typeAtEndOf(B.view, (n) => n.type.name === 'card_body' && n.textContent.startsWith('fresh'), ' «B»');
    await settle();
    await sync(r.peers);
    await runUndo(r, 0);
    expect(count(A.doc(), '«B»')).toBe(1);
    expect(count(A.doc(), '«HN»')).toBe(1);
    expect(r.blocked).toEqual([UNDO_BLOCKED_MESSAGE]);
    // Now a second fresh card nobody touches: plain undo works.
    A.view.dispatch(A.view.state.tr.insert(A.view.state.doc.content.size, cardNode('Fresh2 «HM»', ['fresh two'])));
    await settle();
    await sync(r.peers);
    await runUndo(r, 0);
    expect(count(A.doc(), '«HM»')).toBe(0);
    expect(count(A.doc(), '«HN»'), 'the first (edited) card is untouched').toBe(1);
    expect(r.blocked.length).toBe(1);
    expect(A.doc().eq(B.doc())).toBe(true);
    for (const p of r.peers) p.destroy();
  });

  it('redo is symmetric: delete card → undo restores → partner types → redo is reversed', async () => {
    const r = await rig();
    const [A, B] = r.peers as [LoroPeer, LoroPeer];
    const second = A.view.state.doc.child(1);
    const pos = A.view.state.doc.child(0).nodeSize;
    A.view.dispatch(A.view.state.tr.delete(pos, pos + second.nodeSize));
    await settle();
    await sync(r.peers);
    expect(count(A.doc(), '«H1»')).toBe(0);
    await runUndo(r, 0); // restore
    expect(count(A.doc(), '«H1»')).toBe(1);
    typeAtEndOf(B.view, (n) => n.type.name === 'card_body' && n.textContent.startsWith('bravo'), ' «B»');
    await settle();
    await sync(r.peers);
    const v = A.view;
    r.guards[0]!.redo(v.state, (tr) => v.dispatch(tr), v);
    await settle(6);
    await sync(r.peers);
    await settle(6);
    expect(count(A.doc(), '«B»'), "the partner's typing survives the redo").toBe(1);
    expect(count(A.doc(), '«H1»')).toBe(1);
    expect(r.blocked).toEqual([REDO_BLOCKED_MESSAGE]);
    expect(A.doc().eq(B.doc())).toBe(true);
    for (const p of r.peers) p.destroy();
  });

  it('text-only undo is untouched', async () => {
    const r = await rig();
    const [A] = r.peers as [LoroPeer, LoroPeer];
    typeAtEndOf(A.view, (n) => n.type.name === 'card_body', ' «T»');
    await settle();
    await sync(r.peers);
    await runUndo(r, 0);
    expect(count(A.doc(), '«T»')).toBe(0);
    expect(r.blocked).toEqual([]);
    for (const p of r.peers) p.destroy();
  });
});
