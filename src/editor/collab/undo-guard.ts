/**
 * Container-safe undo/redo for co-editing sessions.
 *
 * A CRDT undo of a container-CREATING op (Enter in the middle of a tag,
 * inserting or pasting a card, or the redo of a card deletion) deletes
 * that container — and a container delete takes every concurrent edit
 * inside it. Partner B starts typing in the half A just split off, A
 * reflexively presses Ctrl+Z, and B's typing is gone with no error:
 * the doc converges cleanly on its absence (chaos rig, 2026-09-04:
 * undo/redo at 10% of ops quadrupled lost content — 18 lost tokens + 5
 * lost heads in 20 seeds; deterministic table in the rig's notes).
 *
 * Loro's UndoManager cannot preview a step, but it can reverse one, so
 * the guard works after the fact, on a rule that needs no knowledge of
 * step boundaries (the manager MERGES nearby local changes into one
 * step, silently):
 *
 *   - A bookkeeping plugin marks a container (by its heading id) as
 *     PARTNER-TOUCHED when a remote transaction creates or changes it,
 *     and clears the mark when a local, non-undo transaction creates
 *     it or deliberately deletes it (the user's intent covers whatever
 *     the partner had done by then).
 *   - After an undo/redo lands, any heading id that vanished names a
 *     removed container. If none of them was partner-touched, the step
 *     stands. Otherwise it is reversed at once (redo of the undo, undo
 *     of the redo) and the user is told why.
 *
 * Text-only undo/redo never removes a container and is never touched;
 * the user's OWN edits inside a container never block. Session-only —
 * single-doc editing keeps ProseMirror history.
 */

import { Plugin, PluginKey } from 'prosemirror-state';
import type { Command, EditorState, Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import type { LoroDoc, UndoManager } from 'loro-crdt';
import { loroSyncPluginKey, undo as loroUndo, redo as loroRedo } from 'loro-prosemirror';
import { HEADING_TYPE_NAMES } from '../../schema/ids.js';

export interface UndoGuard {
  undo: Command;
  redo: Command;
  /** Install alongside the session plugins — the partner-touched ledger. */
  plugin: Plugin;
  /** Test/diagnostic counters. `unrecoverable` = a reversal was needed
   *  but the manager could no longer perform it (a new local edit had
   *  already cleared the redo stack). */
  readonly stats: { blocked: number; allowed: number; unrecoverable: number };
  dispose(): void;
}

export interface UndoGuardOptions {
  doc: LoroDoc;
  undoManager: UndoManager;
  getView: () => EditorView | null;
  /** Shown when an undo/redo is reversed (toast / notice). */
  onBlocked: (message: string) => void;
}

export const UNDO_BLOCKED_MESSAGE =
  "Can't undo that here — a partner has edited the card it would remove.";
export const REDO_BLOCKED_MESSAGE =
  "Can't redo that here — a partner has edited the card it would remove.";

const undoGuardKey = new PluginKey('cm-undo-guard');

/** heading id → fingerprint of the container that carries it. For a tag /
 *  analytic the container is the enclosing card / analytic unit; a
 *  pocket / hat / block is its own container. */
export function containerFingerprints(doc: PMNode): Map<string, string> {
  const out = new Map<string, string>();
  doc.descendants((n, _pos, parent) => {
    if (!HEADING_TYPE_NAMES.has(n.type.name)) return true;
    const id = n.attrs['id'];
    if (typeof id !== 'string' || !id) return true;
    const container = n.type.name === 'tag' || n.type.name === 'analytic' ? (parent ?? n) : n;
    out.set(id, `${container.type.name}|${container.childCount}|${container.textContent}`);
    return true;
  });
  return out;
}

export function createUndoGuard(opts: UndoGuardOptions): UndoGuard {
  const { undoManager, getView, doc } = opts;
  const stats = { blocked: 0, allowed: 0, unrecoverable: 0 };
  /** Containers (heading ids) a remote transaction touched since they last
   *  appeared or were deliberately deleted locally. */
  const partnerTouched = new Set<string>();

  // The binding dispatches BOTH remote imports and undo/redo results with
  // the same 'non-local-updates' meta; Loro's event tells them apart
  // (by: 'import' vs a local event with origin 'undo'). This subscription
  // is registered before the view's, so it runs first, synchronously,
  // ahead of the binding's dispatch.
  let lastEventBy: string = 'local';
  const unsubscribe = doc.subscribe((event) => {
    lastEventBy = event.by;
  });

  const plugin = new Plugin({
    key: undoGuardKey,
    state: {
      init: () => null,
      apply: (tr: Transaction, value: null, oldState: EditorState, newState: EditorState) => {
        if (!tr.docChanged) return value;
        const sync = tr.getMeta(loroSyncPluginKey) as { type?: string } | undefined;
        const before = containerFingerprints(oldState.doc);
        const after = containerFingerprints(newState.doc);
        if (sync?.type === 'non-local-updates') {
          if (lastEventBy !== 'import') return value; // undo/redo result: marks persist
          for (const [id, fp] of after) if (before.get(id) !== fp) partnerTouched.add(id);
          return value;
        }
        if (sync !== undefined) return value; // the binding's own echoes
        // A local, user-originated transaction: containers it creates or
        // deletes start clean — the intent covers the partner's prior edits.
        for (const id of after.keys()) if (!before.has(id)) partnerTouched.delete(id);
        for (const id of before.keys()) if (!after.has(id)) partnerTouched.delete(id);
        return value;
      },
    },
  });

  /** After the step's events have reached the PM doc, compare. */
  const verify = (docBefore: PMNode, isUndo: boolean, attempt = 0): void => {
    const view = getView();
    if (!view) return;
    const docAfter = view.state.doc;
    if (docAfter === docBefore && attempt < 4) {
      // Loro delivers the step's events on a microtask; the binding
      // dispatches inside that. Retry on the next tick, a few times.
      setTimeout(() => verify(docBefore, isUndo, attempt + 1), 0);
      return;
    }
    const before = containerFingerprints(docBefore);
    const after = containerFingerprints(docAfter);
    const removed = [...before.keys()].filter((id) => !after.has(id));
    if (!removed.some((id) => partnerTouched.has(id))) {
      stats.allowed++;
      return;
    }
    stats.blocked++;
    const reverted = isUndo ? undoManager.redo() : undoManager.undo();
    if (!reverted) stats.unrecoverable++;
    opts.onBlocked(isUndo ? UNDO_BLOCKED_MESSAGE : REDO_BLOCKED_MESSAGE);
  };

  const wrap =
    (inner: Command, isUndo: boolean): Command =>
    (state: EditorState, dispatch?: (tr: Transaction) => void, view?: EditorView) => {
      if (!dispatch) return inner(state, dispatch, view);
      const docBefore = state.doc;
      const ran = inner(state, dispatch, view);
      // Check as early as the runtime allows — after Loro's event
      // microtask, before any later keystroke can clear the redo stack.
      if (ran) queueMicrotask(() => verify(docBefore, isUndo));
      return ran;
    };

  return {
    undo: wrap(loroUndo, true),
    redo: wrap(loroRedo, false),
    plugin,
    stats,
    dispose: () => unsubscribe(),
  };
}
