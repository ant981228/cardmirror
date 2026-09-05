// @vitest-environment jsdom
/**
 * The binding's Loro→ProseMirror render is a bounded replace (a
 * CardMirror patch): ProseMirror rebuilds the ancestors around the
 * splice as new node objects, so the mapping built for the rendered
 * tree must be re-pointed at the document's own objects — otherwise
 * the paragraph under the caret has no Loro mapping after every undo
 * and every remote batch that touches it, and each cursor conversion
 * logs "Cannot find the loroNode" (field report 2026-09-05).
 */
import { describe, it, expect, vi } from 'vitest';
import { loroSyncPluginKey, LoroUndoPlugin, undo as loroUndo } from 'loro-prosemirror';
import { UndoManager } from 'loro-crdt';
import { TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { createLoroPeers, syncAll, settle, docOf, cardNode } from './_loro-helpers.js';

declare global {
  // eslint-disable-next-line no-var
  var __CM_MOVABLE_LIST__: boolean | undefined;
}

/** Every container node in the document is a value of the binding's
 *  mapping (the reverse lookup absolutePositionToCursor falls back to). */
function unmappedContainers(view: EditorView): string[] {
  const st = loroSyncPluginKey.getState(view.state) as { mapping: Map<string, unknown> };
  const values = new Set(st.mapping.values());
  const out: string[] = [];
  if (!values.has(view.state.doc)) out.push('doc');
  view.state.doc.descendants((n, pos) => {
    if (n.isText) return false;
    if (!values.has(n)) out.push(`${n.type.name}@${pos}`);
    return true;
  });
  return out;
}
function bodyPos(doc: PMNode, card: number): number {
  let pos = 0;
  for (let i = 0; i < card; i++) pos += doc.child(i).nodeSize;
  return pos + 1 + doc.child(card).child(0).nodeSize + 1;
}

describe('binding mapping survives the bounded render', () => {
  it('after an undo, every container is still mapped and cursor conversion is silent', async () => {
    globalThis.__CM_MOVABLE_LIST__ = true;
    const [A] = await createLoroPeers(
      docOf(cardNode('Tag one', ['alpha bravo']), cardNode('Tag two', ['charlie'])),
      1,
      (ldoc) => [LoroUndoPlugin({ doc: ldoc, undoManager: new UndoManager(ldoc, { mergeInterval: 0 }) })],
    );
    const view = A!.view;
    try {
      const at = bodyPos(view.state.doc, 0) + 5;
      view.dispatch(view.state.tr.insertText('X', at));
      await settle();
      loroUndo(view.state, (tr) => view.dispatch(tr), view);
      await settle(3);
      expect(view.state.doc.child(0).child(1).textContent).toBe('alpha bravo');
      expect(unmappedContainers(view), 'the edited card and paragraph must be mapped again').toEqual([]);
      // A selection-only transaction converts the caret to a Loro cursor:
      // that used to log once per transaction until a local edit re-mapped.
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
        await settle();
        expect(errors.mock.calls.filter((c) => String(c[0]).includes('Cannot find the loroNode')).length).toBe(0);
      } finally {
        errors.mockRestore();
      }
    } finally {
      A!.destroy();
      globalThis.__CM_MOVABLE_LIST__ = undefined;
    }
  });

  it('the selection stash stays silent on a selection-only transaction appended after a doc change (plugins ahead of the sync)', async () => {
    // Batch shape the app produces: a raw edit → a plugin ahead of the sync
    // appends a doc change → another appends a selection fix. The sync's
    // own doc-changed transaction comes last, so the stash on that
    // selection-only transaction met a document the sync had not seen.
    globalThis.__CM_MOVABLE_LIST__ = true;
    const { Plugin, NodeSelection: NS } = await import('prosemirror-state');
    const { LoroSyncPlugin } = await import('loro-prosemirror');
    const { LoroDoc } = await import('loro-crdt');
    const { mkView } = await import('./_loro-helpers.js');
    const [tmp] = await createLoroPeers(docOf(cardNode('Tag one', ['alpha bravo']), cardNode('Tag two', ['charlie'])), 1, () => []);
    const blob = tmp!.exportAll();
    tmp!.destroy();
    const ldoc = new LoroDoc();
    ldoc.import(blob);
    const numbering = new Plugin({
      appendTransaction(trs, _old, state) {
        if (!trs.some((t) => t.getMeta('probe-select'))) return null;
        return state.tr.insertText('!', bodyPos(state.doc, 1) + 1).setMeta('probe-step', true);
      },
    });
    const fixup = new Plugin({
      appendTransaction(trs, _old, state) {
        if (!trs.some((t) => t.getMeta('probe-step'))) return null;
        return state.tr.setSelection(NS.create(state.doc, 0)); // selection-only, unsynced doc
      },
    });
    const view = mkView([numbering, fixup, LoroSyncPlugin({ doc: ldoc as never })]);
    await settle();
    await new Promise((r) => setTimeout(r, 5)); // past the binding's init timer
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      view.dispatch(view.state.tr.insertText('Y', bodyPos(view.state.doc, 0) + 1)); // a first synced edit
      await settle();
      view.dispatch(view.state.tr.insertText('X', bodyPos(view.state.doc, 0) + 2).setMeta('probe-select', true));
      await settle();
      expect(view.state.doc.child(1).child(1).textContent).toBe('c!harlie');
      expect(errors.mock.calls.filter((c) => String(c[0]).includes('Cannot find the loroNode')).length).toBe(0);
    } finally {
      errors.mockRestore();
      view.destroy();
      globalThis.__CM_MOVABLE_LIST__ = undefined;
    }
  });

  it('the undo plugin\'s selection capture stays silent when a plugin AHEAD of the sync appends a doc change (node selection)', async () => {
    // The app's plugin order puts several appenders (heading-id guard,
    // numbering, autocorrect) BEFORE the sync plugin, so their appended
    // transactions land before the sync's own doc-changed one. The undo
    // plugin's per-transaction capture converts the OLD state's selection
    // against the old document — for such an appended transaction that is
    // the raw edit's result, which nothing has synced yet — and a whole-
    // card node selection at depth 0 logged "Cannot find the loroNode".
    globalThis.__CM_MOVABLE_LIST__ = true;
    const { Plugin, NodeSelection: NS } = await import('prosemirror-state');
    const { LoroSyncPlugin } = await import('loro-prosemirror');
    const { LoroDoc } = await import('loro-crdt');
    const { mkView } = await import('./_loro-helpers.js');
    const [tmp] = await createLoroPeers(docOf(cardNode('Tag one', ['alpha bravo']), cardNode('Tag two', ['charlie'])), 1, () => []);
    const blob = tmp!.exportAll();
    tmp!.destroy();
    const ldoc = new LoroDoc();
    ldoc.import(blob);
    const appender = new Plugin({
      appendTransaction(trs, _old, state) {
        if (!trs.some((t) => t.getMeta('probe-select2'))) return null;
        return state.tr.insertText('!', bodyPos(state.doc, 1) + 1);
      },
    });
    const view = mkView([
      appender, // ahead of the sync plugin, like the app's own appenders
      LoroSyncPlugin({ doc: ldoc as never }),
      LoroUndoPlugin({ doc: ldoc, undoManager: new UndoManager(ldoc, { mergeInterval: 0 }) }),
    ]);
    await settle();
    await new Promise((r) => setTimeout(r, 5)); // past the binding's init timer
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      view.dispatch(view.state.tr.insertText('Y', bodyPos(view.state.doc, 0) + 1)); // a first synced edit
      await settle();
      const tr = view.state.tr.insertText('X', bodyPos(view.state.doc, 0) + 2);
      tr.setSelection(NS.create(tr.doc, 0)).setMeta('probe-select2', true);
      view.dispatch(tr);
      await settle();
      expect(view.state.doc.child(1).child(1).textContent).toBe('c!harlie');
      expect(errors.mock.calls.filter((c) => String(c[0]).includes('Cannot find the loroNode')).length).toBe(0);
    } finally {
      errors.mockRestore();
      view.destroy();
      globalThis.__CM_MOVABLE_LIST__ = undefined;
    }
  });

  it('a remote batch that changes nothing visible (both peers made the same move) keeps the mapping on the live objects', async () => {
    globalThis.__CM_MOVABLE_LIST__ = true;
    const [A, B] = await createLoroPeers(
      docOf(cardNode('Tag one', ['alpha bravo']), cardNode('Tag two', ['charlie']), cardNode('Tag three', ['delta'])),
      2,
      () => [],
    );
    const moveFirstToEnd = (view: EditorView): void => {
      const first = view.state.doc.child(0);
      const tr = view.state.tr.delete(0, first.nodeSize);
      tr.insert(tr.doc.content.size, first);
      view.dispatch(tr);
    };
    try {
      moveFirstToEnd(A!.view);
      moveFirstToEnd(B!.view);
      await settle();
      await syncAll([A!, B!]);
      await settle(3);
      expect(A!.doc().child(2).firstChild!.textContent).toBe('Tag one');
      expect(unmappedContainers(A!.view), 'A rendered a no-op batch and must still map its own objects').toEqual([]);
      expect(unmappedContainers(B!.view)).toEqual([]);
    } finally {
      A!.destroy();
      B!.destroy();
      globalThis.__CM_MOVABLE_LIST__ = undefined;
    }
  });

  it("after a partner's edit lands in the card under the caret, the paragraph is still mapped", async () => {
    globalThis.__CM_MOVABLE_LIST__ = true;
    const [A, B] = await createLoroPeers(
      docOf(cardNode('Tag one', ['alpha bravo']), cardNode('Tag two', ['charlie'])),
      2,
      () => [],
    );
    try {
      B!.view.dispatch(B!.view.state.tr.insertText(' +partner', bodyPos(B!.doc(), 0) + 'alpha bravo'.length));
      await settle();
      await syncAll([A!, B!]);
      await settle(3);
      expect(A!.doc().child(0).child(1).textContent).toBe('alpha bravo +partner');
      expect(unmappedContainers(A!.view)).toEqual([]);
      expect(unmappedContainers(B!.view)).toEqual([]);
    } finally {
      A!.destroy();
      B!.destroy();
      globalThis.__CM_MOVABLE_LIST__ = undefined;
    }
  });
});
