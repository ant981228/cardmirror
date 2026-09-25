/**
 * Send-to-speech routing.
 *
 * Compute the slice to send from the source view, then either insert
 * it into the speech doc's view directly (when the speech doc lives
 * in THIS renderer) or serialize it and route via the host bridge to
 * whichever window owns the speech doc (Electron multi-window).
 *
 * The local insert flow (`insertSpeechSlice`) is shared by the
 * multi-pane shell, the single-doc multi-window path, and the
 * receive-side handler, so incoming slices apply through the exact
 * same logic as an in-window send.
 */

import type { EditorView } from 'prosemirror-view';
import { TextSelection, NodeSelection, type EditorState, type Transaction } from 'prosemirror-state';
import { Fragment, Slice, type Node as PMNode, type ResolvedPos } from 'prosemirror-model';
import { closeHistory } from 'prosemirror-history';
import { schema, newHeadingId } from '../schema/index.js';
import { rewriteHeadingIds } from './drag-controller.js';
import { nearestValidInsertPos } from './insert-position.js';
import { flattenZonesInSlice, enclosingZonePos } from './transclusion.js';
import { flattenSelfRefsInSlice, isSelfRef } from './self-transclusion.js';
import { normalizeSelectionForSend } from './send-normalize.js';
import { getSimilarSelectionState } from './similar-selection-plugin.js';
import { getSpeechDocResolver } from './speech-doc-registry.js';
import { getElectronHost } from './host/index.js';
import { alertDialog } from './text-prompt.js';
import { sectionEndFromHeading } from './headings.js';
import { checkedSliceFromJSON } from '../schema/slice-check.js';

// ── Web multi-tab slice transport ──────────────────────────────────────────
// With no main process to route through, the speech doc may live in another
// same-origin TAB. We deliver the serialized slice over a BroadcastChannel;
// whichever tab has that uid's view mounted inserts it through the SAME
// `insertSpeechSlice` path as an in-window send and acks back, so the sender
// knows it landed (mirroring the Electron 'delivered' / 'speech-window-gone'
// result). A card slice is small, so no chunking is needed.
interface SpeechSliceMsg {
  kind: 'slice';
  nonce: string;
  uid: string;
  sliceJson: unknown;
  atEnd: boolean;
}
interface SpeechAckMsg {
  kind: 'ack';
  nonce: string;
}
type SpeechChannelMsg = SpeechSliceMsg | SpeechAckMsg;

const speechChannel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('pmd-speech-slice')
    : null;

/** Optional hook fired after a successful local insert. Multi-pane
 *  uses it to focus the destination slot and cancel its debounced
 *  heavy-update timer; single-doc has nothing to do here. */
export type AfterInsertHook = (speechView: EditorView) => void;

/** Document range `[from, to)` that "send"-style commands act on. */
export interface SendRange {
  from: number;
  to: number;
}

/** The card / analytic_unit / heading (+ its subtree) enclosing
 *  `$pos`, ignoring any selection. A heading's range runs from the
 *  heading to the next equal-or-shallower heading — the same
 *  semantics `computeHeadingRange` uses. Returns `null` if `$pos`
 *  isn't inside such a structure. Shared bounds logic for the
 *  send-to-* and select/copy-current-heading commands. */
function enclosingStructureRange(doc: PMNode, $pos: ResolvedPos): SendRange | null {
  for (let depth = $pos.depth; depth >= 0; depth--) {
    const node = $pos.node(depth);
    const t = node.type.name;
    if (t === 'card' || t === 'analytic_unit') {
      const from = $pos.before(depth);
      return { from, to: from + node.nodeSize };
    }
    if (t === 'pocket' || t === 'hat' || t === 'block') {
      const from = $pos.before(depth);
      const headingLevel = t === 'pocket' ? 1 : t === 'hat' ? 2 : 3;
      // Sibling scan, not an O(rest of doc) nodesBetween — and unlike the old
      // scan here, headings inside zones/live views can't truncate the section
      // (sectionEndFromHeading only sees siblings; audit A-13, 2026-07-11).
      const to = sectionEndFromHeading(
        $pos.node(depth - 1),
        $pos.index(depth - 1),
        from + node.nodeSize,
        headingLevel,
      );
      return { from, to };
    }
  }
  return null;
}

/** Range for the **send-to-** commands: the user's selection if any,
 *  otherwise the cursor's enclosing structure. `null` if neither
 *  applies (e.g., empty doc). `resolveSendSlice` slices over this. */
export function resolveSendRange(view: EditorView): SendRange | null {
  const sel = view.state.selection;
  const doc = view.state.doc;
  // A node-selected live view (the green box you get by clicking it) sends just
  // that window. A `self_ref` isn't a structural unit, so `normalizeSelectionForSend`
  // would drop it and nothing would go — return its node range directly.
  // `takeSendSlice` / `resolveSendSlice` flatten the self_ref to plain cards.
  if (sel instanceof NodeSelection && isSelfRef(sel.node)) {
    return { from: sel.from, to: sel.from + sel.node.nodeSize };
  }
  if (!sel.empty) return spanSendRange(doc, sel.from, sel.to);
  // Empty selection: the cursor's enclosing structure (card / heading + section).
  return enclosingStructureRange(doc, sel.$from);
}

/** Send range for one explicit span `[from, to)` of a selection. */
function spanSendRange(doc: PMNode, from: number, to: number): SendRange | null {
  // A selection INSIDE a live zone (isolating, so it can't cross the boundary)
  // sends the whole transcluded cards it overlaps — as a cached copy (the slice
  // carries no zone node, so no live link travels). The general normalizer only
  // sees top-level doc children and would miss it, returning null.
  const zonePos = enclosingZonePos(doc, from);
  if (zonePos !== null && zonePos === enclosingZonePos(doc, to)) {
    return zoneChildSendRange(doc, zonePos, from, to);
  }
  // Normalize an arbitrary selection to a run of whole top-level nodes that
  // leads with a structural unit, so whatever is sent can always be placed
  // cleanly on receipt (never splitting a card). Returns null when nothing
  // structural is selected.
  return normalizeSelectionForSend(doc, from, to);
}

/** Ranges for a discontinuous (shadow) selection — a scattered nav-pane
 *  ⌘-click set, the manual Ctrl/Cmd selection, Select Similar — in doc
 *  order, each normalized like a plain selection, overlaps merged. Empty
 *  when there's no shadow selection (or the real selection is non-empty,
 *  which wins, as in `getOperatingRanges`). A shadow set parks the caret
 *  in the gap before its first range, where the cursor fallback finds no
 *  enclosing structure — so without this the send silently did nothing. */
function shadowSendRanges(view: EditorView): SendRange[] {
  const state = view.state;
  if (!state.selection.empty) return [];
  const matches = getSimilarSelectionState(state).matches;
  if (matches.length === 0) return [];
  const ranges = matches
    .map((m) => spanSendRange(state.doc, m.from, m.to))
    .filter((r): r is SendRange => r !== null)
    .sort((a, b) => a.from - b.from);
  const merged: SendRange[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else merged.push({ ...r });
  }
  return merged;
}

/** One slice holding every range's content back to back. Each range is a
 *  run of whole nodes, so the per-range slices are closed and concatenate
 *  cleanly. Live views are materialized per range, as in a single send. */
function concatSendSlices(doc: PMNode, ranges: SendRange[]): Slice {
  const nodes: PMNode[] = [];
  for (const r of ranges) {
    flattenSelfRefsInSlice(doc.slice(r.from, r.to), doc, newHeadingId).content.forEach((n) =>
      nodes.push(n),
    );
  }
  return new Slice(Fragment.fromArray(nodes), 0, 0);
}

/** Range covering the whole transcluded cards (zone children) that overlap
 *  [from, to], for a selection inside a live zone. Whole-node boundaries keep the
 *  resulting slice clean (openStart/openEnd 0) and free of the zone wrapper. */
export function zoneChildSendRange(
  doc: PMNode,
  zonePos: number,
  from: number,
  to: number,
): SendRange | null {
  const zone = doc.nodeAt(zonePos);
  if (!zone) return null;
  let rangeFrom = -1;
  let rangeTo = -1;
  zone.forEach((child, offset) => {
    const cStart = zonePos + 1 + offset;
    const cEnd = cStart + child.nodeSize;
    if (cEnd > from && cStart < to) {
      if (rangeFrom === -1) rangeFrom = cStart;
      rangeTo = cEnd;
    }
  });
  return rangeFrom === -1 ? null : { from: rangeFrom, to: rangeTo };
}

/** Range for **select / copy current heading**: ALWAYS the structure
 *  the cursor sits in, deliberately ignoring any active selection
 *  (re-selecting an existing selection is meaningless, and Ctrl+C
 *  already copies a selection). Uses the selection head as "the
 *  cursor." `null` if the cursor isn't inside a structure. */
export function resolveCursorStructureRange(view: EditorView): SendRange | null {
  return enclosingStructureRange(view.state.doc, view.state.selection.$head);
}

/** Build a transaction that deletes the cursor's enclosing structure
 *  (card / analytic_unit / heading + its subtree) outright — the whole
 *  node range, so nothing is left behind. This is deliberately NOT the
 *  same as selecting the structure and pressing Delete: a text-selection
 *  delete over an isolating `card` empties its contents but keeps the
 *  now-blank card shell, which is exactly what "Delete Current Heading"
 *  must avoid. Returns null when the cursor isn't in a deletable
 *  structure (e.g. a loose paragraph / empty doc). Re-homes the cursor
 *  to the nearest valid spot where the structure used to be. */
export function buildDeleteStructureTr(state: EditorState): Transaction | null {
  const range = enclosingStructureRange(state.doc, state.selection.$head);
  if (!range) return null;
  const tr = state.tr.delete(range.from, range.to);
  // Skip re-homing on a now-empty doc (no valid text position to land
  // on); the mapped selection covers that degenerate case.
  if (tr.doc.content.size > 0) {
    const pos = Math.min(range.from, tr.doc.content.size);
    tr.setSelection(TextSelection.near(tr.doc.resolve(pos)));
  }
  return tr.scrollIntoView();
}

/** Compute the slice to send from `sourceView`. Returns the user's
 *  selection if any, otherwise the enclosing card / heading range.
 *  Returns `null` if the cursor isn't inside a structure that has
 *  natural send semantics (e.g., empty doc). */
export function resolveSendSlice(view: EditorView): Slice | null {
  const shadow = shadowSendRanges(view);
  if (shadow.length > 0) return concatSendSlices(view.state.doc, shadow);
  const range = resolveSendRange(view);
  if (!range) return null;
  // Materialize any Live View here (source doc is in hand) so it travels as
  // plain cards, like a Linked Copy does.
  return flattenSelfRefsInSlice(view.state.doc.slice(range.from, range.to), view.state.doc, newHeadingId);
}

/** Like `resolveSendSlice`, but for an explicit (non-empty) selection it also
 *  reflects the normalized range back as the source selection — so the user
 *  sees exactly which whole cards / sections are being sent. A bare cursor is
 *  left untouched (its enclosing-structure send is unambiguous). Returns null
 *  when there's nothing structural to send. */
export function takeSendSlice(view: EditorView): Slice | null {
  // A discontinuous selection sends all its pieces; it stays on screen as-is.
  const shadow = shadowSendRanges(view);
  if (shadow.length > 0) return concatSendSlices(view.state.doc, shadow);
  const hadSelection = !view.state.selection.empty;
  const range = resolveSendRange(view);
  if (!range) return null;
  const slice = flattenSelfRefsInSlice(
    view.state.doc.slice(range.from, range.to),
    view.state.doc,
    newHeadingId,
  );
  if (hadSelection) {
    try {
      const sel = TextSelection.between(
        view.state.doc.resolve(range.from),
        view.state.doc.resolve(range.to),
      );
      view.dispatch(view.state.tr.setSelection(sel));
    } catch {
      /* range didn't map to a text selection — leave the selection as-is */
    }
  }
  return slice;
}

/** Insert a slice into the speech view at-cursor or at-end. Handles
 *  blank-line replace, boundary snapping, history-boundary
 *  isolation (closeHistory + addToHistory meta), trailing paragraph
 *  after the slice, scrollIntoView, focus, and heading-ID rewriting.
 *
 *  Wrapped in `setTimeout(..., 0)` so the dispatch happens off the
 *  source pane's keydown handler — dispatching cross-view inside the
 *  keymap chain breaks Ctrl-Z (best guess: PM's history treats the
 *  cross-view dispatch as an appended/non-event because of the
 *  surrounding keydown context). */
export function insertSpeechSlice(
  speechView: EditorView,
  slice: Slice,
  atEnd: boolean,
  afterInsert?: AfterInsertHook,
): void {
  // No mid-text prompt: a block-level slice dropped at a raw caret inside a
  // card would split it (spawning a phantom blank-tag card). A non-blank caret
  // instead snaps to the nearest top-level boundary — exactly where a
  // drag-and-drop would land it — in the live-insert block below. An empty
  // placeholder line is still REPLACED (filled) so a sent card doesn't leave a
  // stray blank line above it.

  setTimeout(() => {
    try {
      // The speech doc can be closed in the 0 ms defer window; dispatching
      // into a destroyed view throws. ProseMirror nulls `docView` on
      // destroy — bail if that happened.
      if ((speechView as unknown as { docView: unknown }).docView == null) return;
      const liveState = speechView.state;
      // A speech doc is a compiled artifact — flatten any live zone to plain
      // content rather than carry a link into it. Computed up front: the
      // placement logic below must judge the content that will actually
      // land, not the pre-flatten slice.
      const rewritten = rewriteHeadingIds(flattenZonesInSlice(slice));
      let liveFrom: number;
      let liveTo: number;
      if (atEnd) {
        const lastChild = liveState.doc.lastChild;
        if (lastChild && lastChild.isTextblock && lastChild.content.size === 0) {
          liveTo = liveState.doc.content.size;
          liveFrom = liveTo - lastChild.nodeSize;
        } else {
          liveFrom = liveState.doc.content.size;
          liveTo = liveFrom;
        }
      } else {
        const $from = liveState.selection.$from;
        const isEmpty = liveState.selection.empty;
        // Fill only a blank line the incoming content may legally REPLACE
        // in place — in practice the doc-level placeholder the previous
        // send's trailer (or a new doc's seed paragraph) left, which is
        // what the fill was designed for (0f48fce). The old check accepted
        // ANY empty textblock — including a blank card_body INSIDE a card,
        // where replaceRange had to split the host card: each half's
        // schema-mandated leading `tag` was synthesized empty, and the
        // trailer insert below then split the tail half a SECOND time —
        // the field report's "2 empty tag headers" after a tilde send,
        // carrying the split card's numbering attrs (2026-07-27).
        const inBlank =
          isEmpty &&
          $from.depth >= 1 &&
          $from.parent.isTextblock &&
          $from.parent.content.size === 0 &&
          $from
            .node($from.depth - 1)
            .canReplace(
              $from.index($from.depth - 1),
              $from.index($from.depth - 1) + 1,
              rewritten.content,
            );
        if (inBlank) {
          // Fill the empty placeholder line rather than insert beside it (which
          // would leave a stray blank line above the sent card).
          liveFrom = $from.before($from.depth);
          liveTo = $from.after($from.depth);
        } else if (isEmpty) {
          // Snap to the nearest valid drop target for THIS content — a whole card
          // to a doc-level gap, card content inside the enclosing card — so it
          // lands as a clean sibling instead of splitting the cursor's card,
          // exactly where a drag-and-drop would drop it.
          liveFrom = liveTo = nearestValidInsertPos(
            liveState.doc,
            liveState.selection.from,
            rewritten.content,
          );
        } else {
          // A range selection snaps exactly like a non-blank caret: to the
          // nearest valid drop target for this content. Raw-inserting at
          // selection.from put the card MID-TEXT inside whatever the range
          // touched, and replaceRange resolved that by splitting the host
          // card — every split half must lead with a `tag` (schema), so
          // ProseMirror synthesized empty ones: the field report's "2-3 blank
          // tag lines after the card" (2026-07-11).
          liveFrom = liveTo = nearestValidInsertPos(
            liveState.doc,
            liveState.selection.from,
            rewritten.content,
          );
        }
      }
      let tr = liveState.tr;
      tr.replaceRange(liveFrom, liveTo, rewritten);
      const sliceEndPos = tr.mapping.map(liveTo);
      const trailer = schema.nodes['paragraph']!.create();
      tr.insert(sliceEndPos, trailer);
      tr.setSelection(TextSelection.create(tr.doc, sliceEndPos + 1));
      tr = closeHistory(tr);
      tr.setMeta('addToHistory', true);

      speechView.dispatch(tr.scrollIntoView());
      speechView.focus();
      // Fire destination-side hook (e.g., nav-panel collapse refresh)
      // BEFORE the sender's afterInsert so the dest's nav is in its
      // final state when the sender (in same-window cases) does any
      // focus-followup work.
      const resolver = getSpeechDocResolver();
      const destUid = resolver.uidForView(speechView);
      if (destUid) resolver.notifySliceLanded(destUid);
      afterInsert?.(speechView);
    } catch (err) {
      // The insert runs in a 0 ms defer — no caller try/catch can reach a
      // throw here, and on a cross-window send the sender was already told
      // "delivered". A failed insert mid-round must be LOUD, not a lost card.
      console.error('Speech insert failed:', err);
      void alertDialog(
        `Couldn't insert the card into the speech document: ${err instanceof Error ? err.message : err}`,
      );
    }
  }, 0);
}

/** Main entry point. Reads the speech-doc resolver, computes the
 *  slice, and routes — either dispatching locally if the speech doc
 *  lives in this renderer, or serializing + IPCing via the host
 *  bridge if the speech doc lives in another window. */
export function sendToSpeech(
  sourceView: EditorView,
  atEnd: boolean,
  afterInsert?: AfterInsertHook,
): void {
  const resolver = getSpeechDocResolver();
  const speechUid = resolver.getSpeechUid();
  if (!speechUid) {
    // In-DOM dialog, NEVER window.alert: on Windows/Linux the native alert
    // doesn't hand keyboard focus back to the renderer — selection worked
    // but typing was dead until a reload, and the old `sourceView.focus()`
    // bandaid only helped on macOS (field bug, 2026-07-11).
    void alertDialog(
      'No speech document yet. Use "New speech document" to create one or "Mark active doc as speech" to designate an existing pane.',
    );
    return;
  }
  const slice = takeSendSlice(sourceView);
  if (!slice) return;

  const localView = resolver.viewForUid(speechUid);
  if (localView) {
    // Same-window path. No-op if the user is sending FROM the speech
    // doc itself — Verbatim inserts a `~ Marked HH:MM ~` card-marker
    // there; not implemented here.
    if (sourceView === localView) return;
    insertSpeechSlice(localView, slice, atEnd, afterInsert);
    return;
  }

  // Speech doc lives in another window / tab.
  const electron = getElectronHost();
  if (!electron) {
    // Web multi-tab: broadcast the slice to whichever tab owns the speech doc.
    sendSpeechSliceCrossTab(speechUid, slice.toJSON(), atEnd, sourceView);
    return;
  }
  const sliceJson = slice.toJSON();
  void electron.speechSendSlice({ sliceJson, atEnd }).then((result) => {
    if (result.delivered) return;
    if (result.reason === 'speech-window-gone') {
      // Stale designation — main already cleared it. The local
      // resolver will pick up the change via the `speech:changed`
      // broadcast. Surface a brief notice so the user understands
      // why nothing landed.
      void alertDialog("The speech document's window has closed.");
    } else if (result.reason === 'same-window') {
      // Shouldn't trigger in practice — we check locally above —
      // but main has the same guard. Silent.
    } else if (result.reason === 'no-speech-doc') {
      // Race: speech designation was cleared between our resolver
      // read and main's dispatch. Local broadcast will resync.
    } else {
      console.warn('Cross-window send-to-speech failed:', result.reason);
    }
  });
}

/** Web: broadcast a slice to the tab that owns the speech doc, confirming
 *  delivery via an ack — so a designation pointing at a closed tab surfaces the
 *  same "window's gone" notice the Electron path shows, not a silent drop. */
function sendSpeechSliceCrossTab(
  uid: string,
  sliceJson: unknown,
  atEnd: boolean,
  sourceView: EditorView,
): void {
  if (!speechChannel) {
    void alertDialog("This browser can't reach the speech document in another tab.");
    return;
  }
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let timer: ReturnType<typeof setTimeout>;
  const onAck = (e: MessageEvent<SpeechChannelMsg>): void => {
    if (e.data?.kind === 'ack' && e.data.nonce === nonce) {
      speechChannel?.removeEventListener('message', onAck);
      clearTimeout(timer);
    }
  };
  speechChannel.addEventListener('message', onAck);
  speechChannel.postMessage({
    kind: 'slice',
    nonce,
    uid,
    sliceJson,
    atEnd,
  } as SpeechSliceMsg);
  timer = setTimeout(() => {
    speechChannel?.removeEventListener('message', onAck);
    // No tab acked — the designated speech doc isn't open anywhere.
    void alertDialog("The speech document isn't open in any tab.");
  }, 600);
}

/** Deserialize + insert an incoming slice into the local view for `uid`, via the
 *  same `insertSpeechSlice` path as an in-window send. Returns true iff a local
 *  view for `uid` existed (so the web transport acks only when THIS tab owns the
 *  target doc). */
function applyIncomingSlice(uid: string, sliceJson: unknown, atEnd: boolean): boolean {
  const view = getSpeechDocResolver().viewForUid(uid);
  if (!view) return false;
  let slice: Slice;
  try {
    slice = checkedSliceFromJSON(sliceJson);
  } catch (err) {
    console.error('Failed to deserialize incoming speech slice:', err);
    return false;
  }
  insertSpeechSlice(view, slice, atEnd);
  return true;
}

/** Install the receive-side handler. Resolves an incoming slice's target uid to
 *  a local view and applies it via `insertSpeechSlice`. Electron receives over
 *  the host IPC (routed by main); the browser receives over a BroadcastChannel
 *  from another tab and acks so the sender can confirm delivery. Called once at
 *  boot from whichever editor surface is alive (the resolver's per-tab view map
 *  filters incoming slices to whichever doc actually lives in this renderer). */
export function installIncomingSpeechSliceHandler(): void {
  const electron = getElectronHost();
  if (electron) {
    electron.onIncomingSpeechSlice(({ uid, sliceJson, atEnd }) => {
      if (!applyIncomingSlice(uid, sliceJson, atEnd)) {
        console.warn('Incoming speech slice for unregistered uid', uid);
      }
    });
    return;
  }
  // Web multi-tab: another tab broadcast a slice — insert + ack if THIS tab owns
  // the target doc; otherwise ignore (a different tab will handle it).
  speechChannel?.addEventListener('message', (e: MessageEvent<SpeechChannelMsg>) => {
    const msg = e.data;
    if (!msg || msg.kind !== 'slice') return;
    if (applyIncomingSlice(msg.uid, msg.sliceJson, msg.atEnd)) {
      speechChannel?.postMessage({ kind: 'ack', nonce: msg.nonce } as SpeechAckMsg);
    }
  });
}
