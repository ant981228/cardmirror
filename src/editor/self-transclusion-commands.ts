/**
 * Intra-document live window ("self-transclusion") — view-operating commands.
 *
 * Insert / re-pick / jump / unlink / delete for `self_ref` windows, plus the
 * minimal in-document section picker shared by insert and re-pick. All of this
 * is thin over the pure core (self-transclusion.ts); a window is a by-reference,
 * read-only projection, so there is no sync/merge/conflict machinery here.
 */

import { TextSelection, NodeSelection, type Command, type EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { newHeadingId } from '../schema/index.js';
import { collectHeadings } from './headings.js';
import { preciseScrollIntoView } from './precise-scroll.js';
import { rewriteHeadingIdsInFragment, enclosingZonePos } from './transclusion.js';
import {
  buildInDocCopyAttrs,
  insertZoneAtSelection,
  buildZoneErrorMessage,
} from './transclusion-actions.js';
import { showToast } from './toast.js';
import {
  SELF_REF_NODE,
  isSelfRef,
  createSelfRefNode,
  liveReferenceSourceRange,
  materializeSelfRefProjection,
  resolveSelfRefProjection,
} from './self-transclusion.js';

/** If the current selection is a whole-node selection ON a live view (`self_ref`
 *  atom), its document position; otherwise null. The nav caret-tracker uses this
 *  to light the window's projected row(s) instead of the heading above it. */
export function selfRefSelectionPos(state: EditorState): number | null {
  const sel = state.selection;
  return sel instanceof NodeSelection && isSelfRef(sel.node) ? sel.from : null;
}

/** Enter with the caret at the BOTTOM of a live view. The mirror is
 *  read-only, so the split Enter would normally produce is rejected by the
 *  content plugin's filter — and the styled-Enter / tag handlers in the
 *  chain claim the key first and die the same way, leaving it dead. At the
 *  bottom edge the key has one legal meaning — continue BELOW the window —
 *  so insert a fresh paragraph after the `self_ref` and move the caret into
 *  it. Bound FIRST in the Enter chain so the doomed handlers never claim
 *  the key. Anywhere else in the mirror, Enter stays a no-op. */
export const enterBelowSelfRef: Command = (state, dispatch) => {
  const sel = state.selection;
  if (!sel.empty) return false;
  const $head = sel.$head;
  let refDepth = 0;
  for (let d = $head.depth; d > 0; d--) {
    if (isSelfRef($head.node(d))) {
      refDepth = d;
      break;
    }
  }
  if (refDepth === 0) return false;
  // "Bottom" = nothing between the caret and the window's end: the caret
  // sits at its textblock's end and every wrapper up to the window is a
  // last child.
  if (!$head.parent.isTextblock || $head.parentOffset !== $head.parent.content.size) return false;
  for (let d = $head.depth - 1; d >= refDepth; d--) {
    if ($head.indexAfter(d) !== $head.node(d).childCount) return false;
  }
  if (!dispatch) return true;
  const paragraph = state.schema.nodes['paragraph']!.createAndFill();
  if (!paragraph) return false;
  const after = $head.after(refDepth);
  const tr = state.tr.insert(after, paragraph);
  tr.setSelection(TextSelection.create(tr.doc, after + 1));
  dispatch(tr.scrollIntoView());
  return true;
};

/** Insert a `self_ref` at the cursor mirroring the section under `headingId`.
 *  Read-only projection — no content is copied into the doc. */
export function insertSelfRef(view: EditorView, headingId: string): boolean {
  const entry = collectHeadings(view.state.doc, { skipCite: true }).find((h) => h.id === headingId);
  if (!entry) return false;
  const label = `↳ ${entry.text?.trim() || 'Section'}`;
  const node = createSelfRefNode(view.state.schema, headingId, label);
  const { $from, from } = view.state.selection;
  // If the cursor sits inside a linked copy, a live view dropped there would stack
  // two rails (a nested transclusion updating from a different source). Shunt it
  // out to just after the enclosing zone — mirrors how the linked-copy insert
  // escapes to the top level (`insertZoneAtSelection`).
  const zonePos = enclosingZonePos(view.state.doc, $from.pos);
  if (zonePos !== null) {
    const zone = view.state.doc.nodeAt(zonePos);
    const insertPos = zonePos + (zone?.nodeSize ?? 0);
    let tr = view.state.tr.insert(insertPos, node);
    try {
      tr = tr.setSelection(NodeSelection.create(tr.doc, insertPos));
    } catch {
      /* selection placement is best-effort */
    }
    view.dispatch(tr.scrollIntoView());
    view.focus();
    return true;
  }
  const tr = view.state.tr.replaceSelectionWith(node);
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(from, tr.doc.content.size))));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

/** Re-point the `self_ref` at `pos` to a different section. */
export function repointSelfRef(view: EditorView, pos: number, headingId: string): boolean {
  const node = view.state.doc.nodeAt(pos);
  if (!node || !isSelfRef(node)) return false;
  const entry = collectHeadings(view.state.doc, { skipCite: true }).find((h) => h.id === headingId);
  if (!entry) return false;
  const label = `↳ ${entry.text?.trim() || 'Section'}`;
  view.dispatch(
    view.state.tr.setNodeMarkup(pos, undefined, { source_heading_id: headingId, source_label: label }),
  );
  return true;
}

/** Scroll to (and place the cursor at) the mirrored source heading. */
export function jumpToSelfRefSource(
  view: EditorView,
  headingId: string,
  anchorId = '',
): boolean {
  if (anchorId) {
    const range = liveReferenceSourceRange(view.state.doc, anchorId);
    if (!range) return false;
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, range.from, range.to)).scrollIntoView(),
    );
    view.focus();
    return true;
  }
  const entry = collectHeadings(view.state.doc, { skipCite: true }).find((h) => h.id === headingId);
  if (!entry) return false;
  try {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, entry.pos + 1)));
    view.focus();
  } catch {
    /* position shifted — still try to scroll */
  }
  try {
    const sel = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(headingId) : headingId;
    const target = view.dom.querySelector<HTMLElement>(`[data-id="${sel}"]`);
    if (target) {
      preciseScrollIntoView(view, target);
      return true;
    }
    const at = view.domAtPos(entry.pos);
    let el: Node | null = at.node;
    while (el && el.nodeType !== Node.ELEMENT_NODE) el = el.parentNode;
    if (el instanceof HTMLElement) preciseScrollIntoView(view, el);
  } catch {
    /* not laid out — the selection alone lands near it */
  }
  return true;
}

/** Unlink: freeze the current projection into real, editable cards in place and
 *  stop tracking. The projected content is a copy of live content, so its
 *  heading ids are re-stamped fresh to preserve doc-wide uniqueness. */
export function unlinkSelfRef(view: EditorView, pos: number): boolean {
  const node = view.state.doc.nodeAt(pos);
  if (!node || !isSelfRef(node)) return false;
  const projection = resolveSelfRefProjection(view.state.doc, node);
  const content = rewriteHeadingIdsInFragment(
    materializeSelfRefProjection(node, projection),
    newHeadingId,
  );
  const tr = content.size
    ? view.state.tr.replaceWith(pos, pos + node.nodeSize, content)
    : view.state.tr.delete(pos, pos + node.nodeSize); // empty/missing source → just remove
  view.dispatch(tr);
  view.focus();
  return true;
}

/** Delete the window node. */
export function deleteSelfRef(view: EditorView, pos: number): boolean {
  const node = view.state.doc.nodeAt(pos);
  if (!node || !isSelfRef(node)) return false;
  view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
  view.focus();
  return true;
}

// The section picker lives in self-ref-picker.ts (peek-pattern rebuild,
// 2026-07-11): one collectHeadings pass + extent math instead of per-heading
// resolveSelfProjection/sectionRange, plus a collapsible/filterable outline.
// Re-exported here so callers keep their import path.
import { openSelfRefPicker } from './self-ref-picker.js';
export { openSelfRefPicker };

/** Insert: pick a section of this doc to mirror; drop a window at the cursor. */
export function openInsertSelfRef(view: EditorView): void {
  openSelfRefPicker(
    view,
    { title: 'Live view of a section of this document', guardPos: view.state.selection.from },
    (headingId) => insertSelfRef(view, headingId),
  );
}

/** Insert an in-doc LINKED COPY (editable snapshot) of the section under
 *  `headingId`. Unlike a live view, this bakes the content in and is
 *  refreshable. */
export function insertInDocCopy(view: EditorView, headingId: string): boolean {
  const outcome = buildInDocCopyAttrs(view.state.doc, headingId);
  if (!outcome.ok || !outcome.attrs) {
    showToast(buildZoneErrorMessage(outcome.reason));
    return false;
  }
  return insertZoneAtSelection(view, outcome.attrs, outcome.content);
}

/** Insert-copy: pick a section of this doc, drop an editable linked copy. */
export function openInsertInDocCopy(view: EditorView): void {
  openSelfRefPicker(
    view,
    { title: 'Copy a section of this document (linked)', guardPos: view.state.selection.from },
    (headingId) => insertInDocCopy(view, headingId),
  );
}

/** Re-pick: re-point an existing window to a different section. */
export function openRepickSelfRef(view: EditorView, pos: number): void {
  const node = view.state.doc.nodeAt(pos);
  if (!node || !isSelfRef(node)) return;
  openSelfRefPicker(
    view,
    { title: 'Re-point this live view to a section of this document', guardPos: pos },
    (headingId) => repointSelfRef(view, pos, headingId),
  );
}

export { SELF_REF_NODE };
