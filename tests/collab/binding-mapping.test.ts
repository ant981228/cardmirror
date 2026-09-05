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
