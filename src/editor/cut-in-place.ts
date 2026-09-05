/**
 * Cut in place — how a whole card (or outline unit) is cut inside a
 * SHARED document.
 *
 * In a co-editing session, "cut then paste" used to be delete + create in
 * the CRDT: the container died on the cut and a fresh copy appeared on
 * the paste. Racing a partner, that silently dropped their concurrent
 * typing, resurrected a delete of theirs, or — against their move of
 * the same card — left the card twice (chaos rig, 2026-09-04). A nav-pane
 * drag never had the problem: it is one transaction, which the binding
 * turns into a real move that keeps the container's identity.
 *
 * So in a session a cut of whole units does not delete anything. It MARKS
 * the units (dimmed, labelled), copies them, and the paste that follows
 * in the same document MOVES the live units in one transaction — the
 * drag transaction — carrying every partner edit that has arrived, and
 * keeping heading ids, live views and linked copies continuous. The
 * clipboard payload carries a marker (opaque doc key + nonce) so the
 * paste can tell our own cut from anything else that landed on the
 * clipboard in between: any other paste simply clears the mark.
 *
 * Scope (deliberately narrow): only when every operating range is
 * exactly a whole card / analytic unit / outline subtree, only in a
 * document bound to a live session. Text cuts, and every cut in a solo
 * document, are untouched.
 *
 * Rules that make the mode legible (the ones a cut that no longer
 * deletes needs):
 *   - Esc, or Cmd-Z while a mark is pending, clears the mark (a reflexive
 *     "undo the cut" must not undo the last real edit instead).
 *   - Delete / Backspace on the marked unit removes it as always; a drag
 *     of the marked unit is already a move and clears the mark.
 *   - A paste of anything else clears the mark; our own payload pasted
 *     after the mark cleared inserts a copy (fresh ids), as today.
 *   - A partner deleting the marked unit before the paste: the paste is
 *     refused with a note — never a silent resurrection; pasting again
 *     inserts a copy on purpose.
 *   - Cross-document paste is Word-like: a fresh copy lands there, and
 *     the unit is removed from the SOURCE if that document is open here;
 *     a closed source (or one in another window) keeps it, and the note
 *     says so. Cross-document is delete + create by nature, which is
 *     safe there: ids never collide across documents.
 *   - Marks are transient editor state (never saved). They deliberately
 *     SURVIVE the session ending: a paste in the now-solo document still
 *     moves the unit, which beats clearing the mark and pasting a copy.
 */

import { Plugin, PluginKey, Selection, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { DOMSerializer, Fragment, type Node as PMNode } from 'prosemirror-model';
import { buildMoveTransaction, type DragItem } from './drag-controller.js';
import { unitRangeAtPos } from './structural-move.js';
import { nearestValidInsertPos } from './insert-position.js';
import { getOperatingRanges, type RangePair } from './similar-selection-plugin.js';
import { HEADING_TYPE_NAMES } from '../schema/ids.js';
import { showToast } from './toast.js';
import { postNotice } from './status-notices.js';

/** Attribute on the clipboard payload's wrapper: `<docKey>|<nonce>`. */
export const CUT_MARKER_ATTR = 'data-pmd-cut';
export const CUT_PENDING_CLASS = 'pmd-cut-pending';
export const CUT_PENDING_LABEL = 'Cut — paste to move';

export interface CutInPlaceContext {
  /** Whether this view's document is bound to a live session. */
  isSessionDoc: (view: EditorView) => boolean;
  /** Opaque key naming this view's document; null = unknown (marks off). */
  docKey: (view: EditorView) => string | null;
  /** Another open view by its doc key (cross-document paste removes the
   *  units from the source there), or null when not reachable here. */
  viewForDocKey: (key: string) => EditorView | null;
  hasSeenNotice: () => boolean;
  markNoticeSeen: () => void;
  writeClipboard: (html: string, text: string) => Promise<boolean>;
  /** Shown when the clipboard would not take the payload. */
  clipboardBusyMessage: string;
}

interface PendingItem {
  /** Heading id of the unit's head — the identity the paste re-resolves. */
  id: string | null;
  /** Live positions for the decoration; remapped through every edit. */
  from: number;
  to: number;
}
export interface PendingCut {
  nonce: string;
  items: PendingItem[];
}
export interface CutInPlaceState {
  pending: PendingCut | null;
}
type Meta = { type: 'set'; pending: PendingCut } | { type: 'clear' };

export const cutInPlaceKey = new PluginKey<CutInPlaceState>('cm-cut-in-place');
/** loro-prosemirror's sync PluginKey by its string form (PM stores metas
 *  under `<key>$`), so this always-loaded module never imports the lazy
 *  Loro chunk — the same trick heading-id-guard.ts uses. */
const LORO_SYNC_META = 'loro-sync$';

let ctx: CutInPlaceContext | null = null;
/** Installed once by the editor shell (and by tests). Without it the
 *  feature is inert: every cut is the ordinary cut. */
export function installCutInPlaceContext(c: CutInPlaceContext | null): void {
  ctx = c;
}

function nonce(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** Head id of the unit starting at `from`, if any. A card / analytic
 *  unit carries it on its first child; a pocket / hat / block on itself. */
function unitHeadId(doc: PMNode, from: number): string | null {
  const node = doc.nodeAt(from);
  if (!node) return null;
  const head = HEADING_TYPE_NAMES.has(node.type.name) ? node : node.firstChild;
  const id = head && HEADING_TYPE_NAMES.has(head.type.name) ? head.attrs['id'] : null;
  return typeof id === 'string' && id ? id : null;
}

/** The operating ranges when EVERY one is exactly a whole unit (card,
 *  analytic unit, or outline subtree), else null — the only shape cut
 *  in place applies to. */
export function wholeUnitRanges(state: EditorState): RangePair[] | null {
  const { ranges } = getOperatingRanges(state);
  if (ranges.length === 0) return null;
  const out: RangePair[] = [];
  for (const r of ranges) {
    if (r.to <= r.from) return null;
    const unit = wholeUnitFor(state.doc, r);
    if (!unit) return null;
    out.push(unit);
  }
  return out;
}

/** The unit a range means, when it means one: the unit's own node range
 *  (a node selection), or a text selection that spans the unit's entire
 *  inline content — Select Current Heading (Alt-A) and a drag from the
 *  first to the last character both select a card that way. A range that
 *  leaves out any of the unit's text, or reaches outside it, is not a
 *  whole unit. */
function wholeUnitFor(doc: PMNode, r: RangePair): RangePair | null {
  const size = doc.content.size;
  const unit = unitRangeAtPos(doc, Math.min(r.from + 1, size));
  if (!unit) return null;
  if (unit.from === r.from && unit.to === r.to) return { from: unit.from, to: unit.to };
  if (r.from < unit.from || r.to > unit.to) return null;
  const node = doc.nodeAt(unit.from);
  if (!node) return null;
  // First and last inline positions inside the unit, in document coordinates.
  const first = Selection.atStart(node).from + unit.from + 1;
  const last = Selection.atEnd(node).to + unit.from + 1;
  return r.from <= first && r.to >= last ? { from: unit.from, to: unit.to } : null;
}

/** Whether cut in place is on for this view's document (a live session
 *  and a known document identity). */
export function isCutInPlaceDoc(view: EditorView): boolean {
  return !!ctx && ctx.isSessionDoc(view) && !!ctx.docKey(view);
}

const DEV = !!(import.meta as { env?: { DEV?: boolean } }).env?.DEV;

export function cutInPlaceApplies(view: EditorView): RangePair[] | null {
  if (!ctx || !ctx.isSessionDoc(view) || !ctx.docKey(view)) {
    if (DEV) console.info(`[cut-in-place] off: ${!ctx ? 'no context' : !ctx.isSessionDoc(view) ? 'not a session document' : 'no document key'}`);
    return null;
  }
  const ranges = wholeUnitRanges(view.state);
  if (!ranges && DEV) {
    const { ranges: ops } = getOperatingRanges(view.state);
    console.info(`[cut-in-place] off: selection is not whole units (${ops.map((r) => `${r.from}-${r.to}`).join(', ') || 'empty'})`);
  }
  return ranges;
}

function clipboardPayload(view: EditorView, ranges: RangePair[], marker: string): { html: string; text: string } {
  const wrap = document.createElement('div');
  wrap.setAttribute(CUT_MARKER_ATTR, marker);
  const texts: string[] = [];
  const serializer = DOMSerializer.fromSchema(view.state.schema);
  for (const r of ranges) {
    const slice = view.state.doc.slice(r.from, r.to);
    // The editor's own clipboard serialization (transformCopied et al.)
    // when the view offers it; the schema serializer otherwise.
    const own = (view as EditorView & { serializeForClipboard?: (s: typeof slice) => { dom: HTMLElement; text: string } }).serializeForClipboard;
    if (own) {
      const { dom, text } = own.call(view, slice);
      wrap.appendChild(dom);
      texts.push(text);
    } else {
      wrap.appendChild(serializer.serializeFragment(slice.content));
      texts.push(slice.content.textBetween(0, slice.content.size, '\n', '\n'));
    }
  }
  return { html: wrap.outerHTML, text: texts.join('\n') };
}

/** Mark `ranges` as cut in place and put them on the clipboard. Resolves
 *  false when the clipboard refused (nothing is marked then). */
export async function markCutInPlace(view: EditorView, ranges: RangePair[]): Promise<boolean> {
  if (!ctx) return false;
  const key = ctx.docKey(view);
  if (!key) return false;
  const n = nonce();
  const { html, text } = clipboardPayload(view, ranges, `${key}|${n}`);
  const pending: PendingCut = {
    nonce: n,
    items: ranges.map((r) => ({ id: unitHeadId(view.state.doc, r.from), from: r.from, to: r.to })),
  };
  view.dispatch(view.state.tr.setMeta(cutInPlaceKey, { type: 'set', pending } satisfies Meta));
  if (!(await ctx.writeClipboard(html, text))) {
    if (!view.isDestroyed) clearCutInPlace(view);
    showToast(ctx.clipboardBusyMessage);
    return false;
  }
  if (!ctx.hasSeenNotice()) {
    ctx.markNoticeSeen();
    postNotice({
      severity: 'info',
      title: 'Cut in a shared document',
      body:
        'The card stays where it is, dimmed, until you paste: pasting in this document moves it, '
        + 'so partners’ edits travel with it. Delete removes it; Esc cancels the cut.',
      key: 'cut-in-place-intro',
    });
  } else {
    showToast(ranges.length > 1 ? `Cut ${ranges.length} — paste to move` : CUT_PENDING_LABEL);
  }
  return true;
}

export function clearCutInPlace(view: EditorView): void {
  if (view.isDestroyed) return;
  if (!cutInPlaceKey.getState(view.state)?.pending) return;
  view.dispatch(view.state.tr.setMeta(cutInPlaceKey, { type: 'clear' } satisfies Meta));
}

export function pendingCut(state: EditorState): PendingCut | null {
  return cutInPlaceKey.getState(state)?.pending ?? null;
}

function parseMarker(html: string): { docKey: string; nonce: string } | null {
  const m = new RegExp(`${CUT_MARKER_ATTR}="([^"|]+)\\|([^"]+)"`).exec(html);
  return m ? { docKey: m[1]!, nonce: m[2]! } : null;
}

/** Re-resolve the pending units by head id in the CURRENT doc (a partner
 *  may have moved, edited or deleted them since the cut). */
function resolvePending(doc: PMNode, pending: PendingCut): DragItem[] {
  const wanted = new Map<string, PendingItem>();
  for (const it of pending.items) if (it.id) wanted.set(it.id, it);
  const items: DragItem[] = [];
  if (wanted.size) {
    doc.descendants((node, pos) => {
      if (!HEADING_TYPE_NAMES.has(node.type.name)) return true;
      const id = node.attrs['id'];
      if (typeof id === 'string' && wanted.has(id)) {
        const unit = unitRangeAtPos(doc, pos + 1);
        if (unit) items.push({ ...unit, id } as DragItem);
        wanted.delete(id);
      }
      return false;
    });
  }
  // Id-less units (a bare paragraph subtree) fall back to their mapped positions.
  for (const it of pending.items) {
    if (it.id) continue;
    const unit = it.to > it.from ? unitRangeAtPos(doc, it.from + 1) : null;
    if (unit && unit.from === it.from) items.push({ ...unit, id: null } as DragItem);
  }
  return items.sort((a, b) => a.from - b.from);
}

function deleteItems(view: EditorView, items: DragItem[]): void {
  const tr = view.state.tr;
  for (const it of [...items].sort((a, b) => b.from - a.from)) tr.delete(it.from, it.to);
  view.dispatch(tr);
}

/**
 * Paste-time decision. Returns true when the paste was consumed (a move,
 * or a refusal); false to let the ordinary paste proceed — after clearing
 * a pending mark the user has evidently moved past.
 */
export function handleCutInPlacePaste(view: EditorView, html: string): boolean {
  const marker = html ? parseMarker(html) : null;
  const pending = pendingCut(view.state);
  const myKey = ctx?.docKey(view) ?? null;

  if (marker && ctx && myKey && marker.docKey !== myKey) {
    // Cross-document: the ordinary paste creates a fresh copy here; the
    // source, if open in this window and still marked, loses the units.
    const src = ctx.viewForDocKey(marker.docKey);
    const srcPending = src && !src.isDestroyed ? pendingCut(src.state) : null;
    if (src && srcPending && srcPending.nonce === marker.nonce) {
      const items = resolvePending(src.state.doc, srcPending);
      if (items.length) deleteItems(src, items);
      clearCutInPlace(src);
    } else if (!src) {
      showToast('Pasted a copy — the card also remains in the document it was cut from.');
    }
    if (pending) clearCutInPlace(view);
    return false;
  }

  if (!pending) return false; // nothing pending here: an ordinary paste (a copy, fresh ids)
  if (!marker || marker.nonce !== pending.nonce) {
    clearCutInPlace(view); // something else was copied since: the cut is over
    return false;
  }

  const items = resolvePending(view.state.doc, pending);
  if (items.length === 0) {
    clearCutInPlace(view);
    showToast('That card was deleted by a partner — paste again to insert a copy.');
    return true;
  }
  const lead = view.state.doc.nodeAt(items[0]!.from);
  const sel = view.state.selection;
  const insertPos = lead ? nearestValidInsertPos(view.state.doc, sel.from, Fragment.from(lead)) : sel.from;
  const tr = buildMoveTransaction(view.state, items, insertPos);
  if (!tr) {
    showToast('Can’t move a card into itself.');
    return true;
  }
  view.dispatch(tr.setMeta('uiEvent', 'paste').setMeta(cutInPlaceKey, { type: 'clear' } satisfies Meta).scrollIntoView());
  if (items.length < pending.items.length) showToast('Moved — a partner had deleted the rest.');
  return true;
}

function decorationsFor(doc: PMNode, pending: PendingCut): DecorationSet {
  const decos: Decoration[] = [];
  for (const it of pending.items) {
    if (it.to <= it.from) continue;
    // One node decoration per top-level node inside the unit's range (an
    // outline subtree spans several).
    doc.nodesBetween(it.from, it.to, (node, pos) => {
      if (pos < it.from || pos + node.nodeSize > it.to) return true;
      decos.push(Decoration.node(pos, pos + node.nodeSize, { class: CUT_PENDING_CLASS, 'data-pmd-cut-label': CUT_PENDING_LABEL }));
      return false;
    });
  }
  return DecorationSet.create(doc, decos);
}

export function buildCutInPlacePlugin(): Plugin<CutInPlaceState> {
  return new Plugin<CutInPlaceState>({
    key: cutInPlaceKey,
    state: {
      init: () => ({ pending: null }),
      apply(tr: Transaction, prev): CutInPlaceState {
        const meta = tr.getMeta(cutInPlaceKey) as Meta | undefined;
        if (meta?.type === 'clear') return { pending: null };
        if (meta?.type === 'set') return { pending: meta.pending };
        if (!prev.pending || !tr.docChanged) return prev;
        // Follow the units through edits. A unit whose range collapsed
        // was either re-rendered by the binding (a REMOTE batch replaces
        // whole regions — the unit is still there: re-resolve it by id),
        // MOVED locally (a drag is already the move: drop it, the mark is
        // done), or DELETED — by a partner, most likely. A deleted unit is
        // kept, id only, so the paste can refuse with a note instead of
        // quietly inserting a copy of something someone removed.
        const remote = tr.getMeta(LORO_SYNC_META) !== undefined;
        const items: PendingItem[] = [];
        for (const it of prev.pending.items) {
          const from = tr.mapping.map(it.from, 1);
          const to = tr.mapping.map(it.to, -1);
          if (to > from) {
            items.push({ ...it, from, to });
            continue;
          }
          if (!it.id) continue;
          let at = -1;
          tr.doc.descendants((node, pos) => {
            if (at >= 0) return false;
            if (HEADING_TYPE_NAMES.has(node.type.name) && node.attrs['id'] === it.id) at = pos;
            return at < 0;
          });
          if (at < 0) {
            items.push({ id: it.id, from, to: from }); // deleted: keep, id only
          } else if (remote) {
            const unit = unitRangeAtPos(tr.doc, at + 1);
            items.push(unit ? { id: it.id, from: unit.from, to: unit.to } : { id: it.id, from, to: from });
          }
          // else: a local move (drag) — the mark is done for this unit
        }
        return items.length ? { pending: { nonce: prev.pending.nonce, items } } : { pending: null };
      },
    },
    props: {
      decorations(state) {
        const pending = cutInPlaceKey.getState(state)?.pending;
        return pending ? decorationsFor(state.doc, pending) : null;
      },
      handleDOMEvents: {
        cut(view, event) {
          const ranges = cutInPlaceApplies(view);
          if (!ranges) return false;
          event.preventDefault();
          void markCutInPlace(view, ranges);
          return true;
        },
        copy(view) {
          clearCutInPlace(view); // copying something else ends the cut
          return false;
        },
      },
      handlePaste(view, event) {
        const html = event.clipboardData?.getData('text/html') ?? '';
        return handleCutInPlacePaste(view, html);
      },
      handleKeyDown(view, e) {
        if (!pendingCut(view.state)) return false;
        const mod = e.metaKey || e.ctrlKey;
        if (e.key === 'Escape' || (mod && !e.shiftKey && (e.key === 'z' || e.key === 'Z'))) {
          clearCutInPlace(view);
          return true;
        }
        return false;
      },
    },
  });
}
