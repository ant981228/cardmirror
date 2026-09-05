/**
 * Layer 2 — Word-style mouse-selection state machine.
 * (`word-break.ts` defines the word-selection model and its layer
 * taxonomy.) Three click gestures with distinct anchor +
 * granularity behavior:
 *
 *   - Single click: anchor = a point, granularity = character.
 *     Dynamic — extending past the anchor's own unit upgrades to
 *     word granularity (and pulls the rest of the anchor unit in);
 *     reversing back inside the original unit downgrades to
 *     character. The HEAD is direction-based: moving AWAY from the
 *     anchor (the drag's extension direction) snaps word-by-word;
 *     moving back TOWARD the anchor is always character-precise —
 *     so a long word-by-word sweep terminates mid-word by simply
 *     backing up to the exact endpoint, in one gesture.
 *   - Double click: anchor = the word unit (Layer 1 query with
 *     trailing-space absorption), granularity = word (fixed).
 *     Drag extends word-by-word; the anchor unit stays fully
 *     selected even when the drag reverses direction.
 *   - Triple click: anchor = the paragraph (= containing textblock
 *     range), granularity = paragraph (fixed). Drag extends one
 *     whole paragraph at a time; the anchor paragraph stays fully
 *     selected when the drag reverses direction. shift+click after
 *     a triple-click extends paragraph-by-paragraph using the same
 *     mechanism.
 *
 * Drag and shift+click are the same operation per the spec: both
 * move the active end to a target governed by the existing
 * anchor + granularity. Drag continuously, shift+click jumps.
 * Shift+double-click and shift+triple-click are no-ops (shift
 * only modifies a single click).
 *
 * Ctrl/Cmd (discontinuous add-to-selection) follows the same click
 * ladder: a click adds the word, a double-click the word, a
 * triple-click the whole paragraph; a drag adds the dragged range,
 * snapped to whole words after a double-click and to whole
 * paragraphs after a triple-click (`discontinuousRangeFor`).
 *
 * The plugin tracks a module-level `currentAnchor` across
 * gestures so shift+click after a double-click extends in word
 * granularity, and shift+click after a single click follows the
 * dynamic-granularity rule. When an external transaction
 * (typing, arrow keys, programmatic dispatch) moves the
 * selection in a way that doesn't match our tracked anchor, the
 * shift+click handler falls back to PM's selection-anchor as a
 * fresh point anchor.
 */

import { Plugin, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode, ResolvedPos } from 'prosemirror-model';
import { classifyChar } from './word-break.js';
import {
  similarSelectionKey,
  setManualShadowSelection,
  setShadowPending,
  type RangePair,
} from './similar-selection-plugin.js';

/** Cmd is the discontinuous-select modifier on macOS (Ctrl-click is the OS
 *  context menu there); Ctrl elsewhere. */
const IS_MAC =
  typeof navigator !== 'undefined' && /mac/i.test(navigator.platform ?? '');

type Granularity = 'character' | 'word' | 'paragraph';

interface SelectionAnchor {
  /** The original click position in the doc. Doesn't move during
   *  the gesture. For single-click this IS the anchor; for double-
   *  click it's the click location and `unit` is the unit it
   *  landed in. */
  point: number;
  /** The anchor unit. For single-click starts as `{ point, point }`
   *  and grows to the full unit once dynamic granularity upgrades.
   *  For double-click this is the double-clicked word/punctuation
   *  unit (with Layer 1 trailing-space absorption already applied). */
  unit: { from: number; to: number };
  /** The unit containing `point` (the W0 of the spec). Used by
   *  single-click dynamic-granularity to detect upgrade /
   *  downgrade as the active end crosses W0's boundaries. Null
   *  when the click landed outside any text block (no unit). */
  W0: { from: number; to: number } | null;
  /** Current granularity. Single-click anchors start as
   *  'character' and may toggle 'character' ↔ 'word' as the
   *  active end moves. Double-click anchors are fixed at 'word'. */
  granularity: Granularity;
  /** True for double-click anchors — granularity is fixed and the
   *  anchor unit is never shrunk below its initial extent. */
  fixed: boolean;
  /** Head direction tracking for dynamic (single-click) anchors: the
   *  selection side and the previous active position. The head's
   *  granularity is purely direction-based — away from the anchor
   *  snaps word-by-word, toward the anchor is character-precise —
   *  and direction is judged against `prev` (an OBSERVED move, so a
   *  stationary pointer re-reporting its position is a no-op, never a
   *  mode flip). Reset on side flips and on re-entering W0. */
  run?: { side: 1 | -1; prev: number } | null;
  /** Freshness counter. Bumped on every selection this plugin
   *  dispatches; set to -1 by the `apply` hook when an external
   *  transaction moves the selection, so `effectiveAnchor` re-derives
   *  instead of reusing this anchor. */
  fingerprint: number;
}

let nextFingerprint = 1;
let currentAnchor: SelectionAnchor | null = null;

/** Marker used to tag selection-setting transactions that this
 *  plugin dispatches. The `apply` hook below treats any
 *  selection-changing transaction WITHOUT this tag as an external
 *  update, which invalidates `currentAnchor`. */
const SEL_FROM_PLUGIN = 'pmd:word-selection-plugin';

export const wordSelectionPlugin: Plugin = new Plugin({
  props: {
    handleDOMEvents: {
      mousedown(view, event): boolean {
        return handleMousedown(view, event);
      },
    },
  },
  state: {
    init() {
      return null;
    },
    apply(tr, _value) {
      // A selection change not tagged by this plugin means
      // `currentAnchor` no longer matches the live selection. Mark
      // it stale so `effectiveAnchor` re-derives from the PM
      // selection the next time shift+click fires.
      if (tr.selectionSet && tr.getMeta(SEL_FROM_PLUGIN) === undefined) {
        if (currentAnchor) currentAnchor.fingerprint = -1;
      }
      return null;
    },
  },
});

function handleMousedown(view: EditorView, event: MouseEvent): boolean {
  if (event.button !== 0) return false;
  // Alt+drag = block selection (out of scope); leave alone.
  if (event.altKey) return false;
  const coords = { left: event.clientX, top: event.clientY };
  const hit = view.posAtCoords(coords);
  if (!hit) return false;
  const clickPos = hit.pos;
  const detail = event.detail;

  // Defer to PM's default when the click landed on an inline atom
  // (image, etc.). PM's mousedown handler creates a NodeSelection
  // for these, which our plugin would otherwise clobber with a
  // text-style TextSelection at the click pos. Detected by
  // resolving the click pos and checking whether the immediate
  // node-before or node-after is a non-text atom.
  try {
    const $pos = view.state.doc.resolve(clickPos);
    const after = $pos.nodeAfter;
    const before = $pos.nodeBefore;
    const isAtomLeaf = (n: PMNode | null | undefined): boolean =>
      !!n && n.isAtom && !n.isText;
    if (isAtomLeaf(after) || isAtomLeaf(before)) return false;
  } catch {
    return false;
  }

  // Ctrl (Windows/Linux) / Cmd (Mac) — discontinuous "add to selection". A drag
  // adds an arbitrary range; a plain click adds the word under the pointer. The
  // ranges become a shadow selection (see `similar-selection-plugin`), so the
  // existing format commands AND the copy handler act across all of them.
  const discontinuousMod = IS_MAC ? event.metaKey : event.ctrlKey;
  if (discontinuousMod && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    beginDiscontinuousSelect(view, clickPos, detail);
    return true;
  }

  // Shift+click: extend, never re-anchor.
  if (event.shiftKey) {
    if (detail !== 1) {
      // Shift+double-click and shift+triple-click are no-ops
      // per spec — Shift modifies only a single click.
      event.preventDefault();
      return true;
    }
    const anchor = effectiveAnchor(view);
    extendActiveEndTo(view, anchor, clickPos);
    installDragListeners(view, anchor);
    event.preventDefault();
    return true;
  }

  // Triple-click: select the containing textblock and install
  // paragraph-granularity drag. We dispatch the selection
  // ourselves (rather than falling through to PM's default
  // triple-click selection) so the transaction carries our
  // `SEL_FROM_PLUGIN` meta — otherwise the `apply` hook below
  // would treat PM's selectionSet as an external change and
  // invalidate the anchor we just set, breaking the very next
  // shift+click extension.
  if (detail === 3) {
    const paraRange = textblockRangeAt(view, clickPos);
    if (!paraRange) return false;
    event.preventDefault();
    const anchor: SelectionAnchor = {
      point: clickPos,
      unit: paraRange,
      W0: paraRange,
      granularity: 'paragraph',
      fixed: true,
      fingerprint: nextFingerprint++,
    };
    currentAnchor = anchor;
    dispatchSelection(view, paraRange.from, paraRange.to, anchor);
    installDragListeners(view, anchor);
    return true;
  }

  // Double-click: select the unit and install word-granularity
  // drag.
  if (detail === 2) {
    const unit = queryUnitAtDocPos(view, clickPos);
    if (!unit) return false;
    event.preventDefault();
    const anchor: SelectionAnchor = {
      point: clickPos,
      unit,
      W0: unit,
      granularity: 'word',
      fixed: true,
      fingerprint: nextFingerprint++,
    };
    currentAnchor = anchor;
    dispatchSelection(view, unit.from, unit.to, anchor);
    installDragListeners(view, anchor);
    return true;
  }

  // Single click: place the caret AND set up the dynamic-
  // granularity anchor for any drag that follows. We
  // preventDefault so the browser's built-in drag-to-extend
  // (character granularity, no upgrade/downgrade) doesn't
  // compete with ours; the dispatched selection sets the caret
  // and `installDragListeners` takes over the drag.
  const anchor = createPointAnchor(view, clickPos);
  currentAnchor = anchor;
  dispatchSelection(view, clickPos, clickPos, anchor);
  installDragListeners(view, anchor);
  event.preventDefault();
  return true;
}

/** Fresh single-click (dynamic-granularity) anchor at `clickPos`.
 *  Exported for the drag-state-machine tests, which drive
 *  `extendActiveEndTo` with synthetic position sequences. */
export function createPointAnchor(view: EditorView, clickPos: number): SelectionAnchor {
  return {
    point: clickPos,
    unit: { from: clickPos, to: clickPos },
    W0: queryUnitAtDocPos(view, clickPos),
    granularity: 'character',
    fixed: false,
    fingerprint: nextFingerprint++,
  };
}

/** The range a Ctrl/Cmd gesture adds to the discontinuous selection: pointer
 *  down at `startPos` with click count `detail`, released at `endPos` (null or
 *  `startPos` = no drag). A click adds the word under the pointer; a
 *  triple-click the containing paragraph. A drag adds the dragged range,
 *  snapped outward to whole words after a double-click and to whole paragraphs
 *  after a triple-click — the same ladder as the plain gestures, minus the
 *  anchor machinery (nothing here is ever re-anchored or reversed). The second
 *  and third clicks of a sequence each add their own range; the shadow merge
 *  folds the earlier word into the paragraph. Exported for tests. */
export function discontinuousRangeFor(
  view: EditorView,
  startPos: number,
  endPos: number | null,
  detail: number,
): RangePair {
  const unitAt = (pos: number): RangePair | null =>
    detail >= 3 ? textblockRangeAt(view, pos) : detail === 2 ? queryUnitAtDocPos(view, pos) : null;
  if (endPos === null || endPos === startPos) {
    return (detail >= 3 ? textblockRangeAt(view, startPos) : queryUnitAtDocPos(view, startPos)) ?? { from: startPos, to: startPos };
  }
  const lo = Math.min(startPos, endPos);
  const hi = Math.max(startPos, endPos);
  const a = unitAt(lo);
  const b = unitAt(hi);
  return { from: Math.min(lo, a?.from ?? lo), to: Math.max(hi, b?.to ?? hi) };
}

/** Ctrl/Cmd add-to-selection. From the pointer-down at `startPos` (click
 *  count `detail`), track the gesture; on release add the range
 *  `discontinuousRangeFor` decides to the discontinuous shadow selection. The
 *  set being extended is captured up front: any existing shadow matches, plus
 *  — on the FIRST such gesture — the current non-empty selection as the first
 *  range. */
function beginDiscontinuousSelect(view: EditorView, startPos: number, detail: number): void {
  const ps = similarSelectionKey.getState(view.state);
  const existing: RangePair[] =
    ps && ps.matches.length > 0 ? ps.matches.map((r) => ({ ...r })) : [];
  const sel = view.state.selection;
  const priorSel: RangePair[] =
    existing.length === 0 && !sel.empty ? [{ from: sel.from, to: sel.to }] : [];
  const base = [...existing, ...priorSel];
  // Lock the already-selected ranges in as a discontinuous selection right away
  // (folding a live normal selection in), so they stay put while the drag adds
  // to them — only the drag-preview moves.
  if (base.length > 0) setManualShadowSelection(view, base);

  let dragged = false;
  const posAt = (e: MouseEvent): number | null => {
    const hit = view.posAtCoords({ left: e.clientX, top: e.clientY });
    return hit ? hit.pos : null;
  };
  const onMove = (e: MouseEvent): void => {
    const pos = posAt(e);
    if (pos === null || pos === startPos) return;
    dragged = true;
    // Preview the pending range as a DECORATION (not the real selection) so the
    // existing ranges aren't dismissed mid-drag — snapped exactly as the
    // release will add it.
    setShadowPending(view, discontinuousRangeFor(view, startPos, pos, detail));
  };
  const onUp = (e: MouseEvent): void => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    const endPos = posAt(e) ?? startPos;
    const added = discontinuousRangeFor(view, startPos, dragged ? endPos : null, detail);
    // setManualShadowSelection clears the pending preview (its setMatches resets it).
    setManualShadowSelection(view, [...base, added]);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

/** Resolve the effective anchor for a shift+click. Re-uses
 *  `currentAnchor` when its fingerprint is still fresh; otherwise
 *  fabricates a 'point' anchor from the current PM selection's
 *  anchor (the fixed end of the selection) so shift+click extends
 *  from a sensible spot when the user typed / arrow-keyed in
 *  between gestures. */
function effectiveAnchor(view: EditorView): SelectionAnchor {
  if (currentAnchor && currentAnchor.fingerprint !== -1) {
    return currentAnchor;
  }
  const anchorPos = view.state.selection.anchor;
  const W0 = queryUnitAtDocPos(view, anchorPos);
  const fresh: SelectionAnchor = {
    point: anchorPos,
    unit: { from: anchorPos, to: anchorPos },
    W0,
    granularity: 'character',
    fixed: false,
    fingerprint: nextFingerprint++,
  };
  currentAnchor = fresh;
  return fresh;
}

/** Edge band (px from the viewport's top/bottom) within which a
 *  selection drag triggers autoscroll, and the max scroll step per
 *  animation frame (at the very edge; ramps down to 1px at the band's
 *  inner boundary). */
const AUTOSCROLL_EDGE_PX = 44;
const AUTOSCROLL_MAX_STEP_PX = 20;

/** Signed pixels to scroll the viewport this frame given the pointer's
 *  `clientY` relative to the scroller's `top`/`bottom`. Negative = up,
 *  positive = down, 0 = pointer is outside both edge bands. Speed ramps
 *  linearly with how deep the pointer is into the band (min 1px once
 *  inside, so the edge always creeps). Exported for testing. */
export function edgeAutoscrollDelta(
  top: number,
  bottom: number,
  clientY: number,
  margin = AUTOSCROLL_EDGE_PX,
  maxStep = AUTOSCROLL_MAX_STEP_PX,
): number {
  if (clientY < top + margin) {
    const depth = Math.min(1, (top + margin - clientY) / margin);
    return -Math.max(1, Math.round(maxStep * depth));
  }
  if (clientY > bottom - margin) {
    const depth = Math.min(1, (clientY - (bottom - margin)) / margin);
    return Math.max(1, Math.round(maxStep * depth));
  }
  return 0;
}

/** Nearest scrollable ancestor of the editor surface — the element
 *  that owns the document's vertical scroll (`#app` in single-doc,
 *  `.pmd-pane-body` per pane in multi-pane). Null if none is found. */
function findSelectionScroller(el: HTMLElement): HTMLElement | null {
  let cur: HTMLElement | null = el.parentElement;
  while (cur && cur !== document.body && cur !== document.documentElement) {
    const oy = getComputedStyle(cur).overflowY;
    if (oy === 'auto' || oy === 'scroll') return cur;
    cur = cur.parentElement;
  }
  return null;
}

function installDragListeners(view: EditorView, anchor: SelectionAnchor): void {
  const scroller = findSelectionScroller(view.dom);
  let lastX = 0;
  let lastY = 0;
  let havePointer = false;
  let rafId = 0;

  // Extend the selection's active end to wherever the pointer currently
  // sits. The probe Y is clamped just inside the scroller so a pointer
  // parked past the edge still resolves to the edge-most line as new
  // content scrolls into view.
  const extendToPointer = (): void => {
    let probeY = lastY;
    if (scroller) {
      const rect = scroller.getBoundingClientRect();
      probeY = Math.max(rect.top + 1, Math.min(rect.bottom - 1, lastY));
    }
    const hit = view.posAtCoords({ left: lastX, top: probeY });
    if (hit) extendActiveEndTo(view, anchor, hit.pos);
  };

  // While the pointer rests in a top/bottom edge band, scroll the
  // viewport and drag the selection along with it — even with the mouse
  // held perfectly still. Self-reschedules only while it actually
  // scrolls, so it stops the moment the pointer leaves the band or the
  // scroll hits its limit.
  const tick = (): void => {
    rafId = 0;
    if (!havePointer || !scroller) return;
    const rect = scroller.getBoundingClientRect();
    const dy = edgeAutoscrollDelta(rect.top, rect.bottom, lastY);
    if (dy === 0) return;
    const before = scroller.scrollTop;
    scroller.scrollTop = before + dy;
    if (scroller.scrollTop === before) return; // already at the limit
    extendToPointer();
    rafId = requestAnimationFrame(tick);
  };

  const maybeStartAutoscroll = (): void => {
    if (rafId !== 0 || !scroller) return;
    const rect = scroller.getBoundingClientRect();
    if (edgeAutoscrollDelta(rect.top, rect.bottom, lastY) !== 0) {
      rafId = requestAnimationFrame(tick);
    }
  };

  const onMove = (e: MouseEvent): void => {
    lastX = e.clientX;
    lastY = e.clientY;
    havePointer = true;
    const hit = view.posAtCoords({ left: e.clientX, top: e.clientY });
    if (hit) extendActiveEndTo(view, anchor, hit.pos);
    maybeStartAutoscroll();
  };
  const onUp = (): void => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mouseup', onUp, true);
  };
  // Capture phase so we beat node-level handlers that might call
  // stopPropagation on mouseup.
  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('mouseup', onUp, true);
}

/** Extend the selection's active end to `activePos`, applying
 *  the spec's rules for the anchor's current granularity. */
/** Move the gesture's active end to `activePos` under the anchor's
 *  granularity rules. Exported for tests. */
export function extendActiveEndTo(
  view: EditorView,
  anchor: SelectionAnchor,
  activePos: number,
): void {
  if (anchor.fixed && anchor.granularity === 'paragraph') {
    // Paragraph granularity (fixed): selection spans the union of
    // the anchor paragraph and the paragraph at the active end.
    // Whole-textblock ranges on both sides; anchor paragraph
    // always stays fully selected even when drag reverses
    // direction.
    const activePara = textblockRangeAt(view, activePos);
    if (!activePara) return;
    if (activePos >= anchor.unit.to) {
      dispatchSelection(view, anchor.unit.from, activePara.to, anchor);
    } else if (activePos <= anchor.unit.from) {
      dispatchSelection(view, anchor.unit.to, activePara.from, anchor);
    } else {
      dispatchSelection(view, anchor.unit.from, anchor.unit.to, anchor);
    }
    return;
  }

  if (anchor.fixed) {
    // Word-granularity (fixed): selection spans the union of the
    // anchor unit and the unit at the active end (bare unit, no
    // trailing-space absorption — only the initiating click
    // absorbs). Anchor unit always stays fully selected.
    const activeUnit = bareUnitAtDocPos(view, activePos) ?? {
      from: activePos,
      to: activePos,
    };
    if (activePos >= anchor.unit.to) {
      // Right-extension: anchor stays on the LEFT.
      dispatchSelection(view, anchor.unit.from, activeUnit.to, anchor);
    } else if (activePos <= anchor.unit.from) {
      // Left-extension: anchor flips to the RIGHT side. The
      // word-granularity active unit is the unit AT the active
      // end (which may be a space unit, etc. — bare).
      dispatchSelection(view, anchor.unit.to, activeUnit.from, anchor);
    } else {
      // Active end is inside the anchor unit — selection collapses
      // back to the anchor unit (spec: "the selection can never
      // shrink below it"). Direction-preserve by keeping the
      // current selection's head side.
      dispatchSelection(view, anchor.unit.from, anchor.unit.to, anchor);
    }
    return;
  }

  // Dynamic granularity (single-click anchors).
  const W0 = anchor.W0;
  const insideW0 =
    W0 !== null && activePos >= W0.from && activePos <= W0.to;

  if (insideW0) {
    // Snap to character granularity — exact anchor.point..activePos.
    anchor.granularity = 'character';
    anchor.unit = { from: anchor.point, to: anchor.point };
    anchor.run = null; // leaving W0 again starts a fresh head run
    dispatchSelection(view, anchor.point, activePos, anchor);
    return;
  }

  // Outside W0 → upgrade to word granularity. The anchor unit
  // becomes the whole W0 (spec: "the remainder of W0 is pulled
  // into the selection"), and we extend by word-units toward
  // the active end. If W0 is null (click was in a non-text
  // location with no unit), fall back to character behavior.
  if (W0 === null) {
    dispatchSelection(view, anchor.point, activePos, anchor);
    return;
  }
  anchor.granularity = 'word';
  anchor.unit = W0;
  const side: 1 | -1 = activePos >= W0.to ? 1 : -1;
  const wordSnap = (): void => {
    const activeUnit = bareUnitAtDocPos(view, activePos) ?? {
      from: activePos,
      to: activePos,
    };
    if (side === 1) dispatchSelection(view, W0.from, activeUnit.to, anchor);
    else dispatchSelection(view, W0.to, activeUnit.from, anchor);
  };

  // Direction-based head (see the `run` field's doc comment):
  // away from the anchor → word snap; toward it → character-precise.
  if (!anchor.run || anchor.run.side !== side) {
    // First move onto this side is by definition away from the anchor.
    anchor.run = { side, prev: activePos };
    wordSnap();
    return;
  }
  const run = anchor.run;
  if (activePos === run.prev) return; // stationary re-report: no-op
  const away = side === 1 ? activePos > run.prev : activePos < run.prev;
  run.prev = activePos;
  if (away) {
    wordSnap();
  } else {
    // Toward the anchor: exact head; the anchor side keeps the full W0 edge.
    dispatchSelection(view, side === 1 ? W0.from : W0.to, activePos, anchor);
  }
}

function dispatchSelection(
  view: EditorView,
  anchorPos: number,
  headPos: number,
  anchor: SelectionAnchor,
): void {
  // Coerce BOTH endpoints to the nearest inline content before
  // constructing anything. PM's TextSelection.create does NOT throw
  // on an endpoint outside inline content — it console.warns (once
  // per session) and returns a broken selection anyway, so the old
  // try/catch "fallback" here was dead code, and the broken selection
  // was DISPATCHED into state (field bug 2026-07-27: a click below
  // the last line resolves to a doc-level position; every
  // selection-dependent command then silently no-oped until a real
  // text click installed a valid selection — the "styling does
  // nothing until I click the caret line" class). `between` also
  // gives the natural UX: a below-content click lands the caret at
  // the end of the last line.
  const doc = view.state.doc;
  const clamp = (p: number): number => Math.max(0, Math.min(p, doc.content.size));
  const sel = TextSelection.between(doc.resolve(clamp(anchorPos)), doc.resolve(clamp(headPos)));
  const cur = view.state.selection;
  if (
    cur instanceof TextSelection &&
    cur.anchor === sel.anchor &&
    cur.head === sel.head
  ) {
    // Even when the selection is already in the desired state,
    // make sure the editor is focused — `event.preventDefault()`
    // on mousedown blocks the browser's default focus transfer,
    // so a single-click that doesn't change the selection needs
    // an explicit focus call (otherwise the caret renders but
    // typing goes nowhere).
    if (!view.hasFocus()) view.focus();
    return;
  }
  const tr = view.state.tr.setSelection(sel);
  tr.setMeta(SEL_FROM_PLUGIN, true);
  anchor.fingerprint = nextFingerprint++;
  view.dispatch(tr);
  if (!view.hasFocus()) view.focus();
}

// ---- Layer 1 lookups against a PM doc ------------------------------

/** Build a per-position character-class map for the textblock that
 *  contains `pos`. Inline leaves classify as 'punct' so they
 *  always end a word/space/punctuation run — the leaf is its own
 *  single-position unit. Returns null if `pos` doesn't resolve
 *  inside a textblock (e.g., a click between block boundaries). */
interface TextblockClassMap {
  tbStart: number;
  size: number;
  classAt: (idx: number) => 'word' | 'space' | 'tab' | 'punct';
  charAt: (idx: number) => string; // For trailing-space absorption.
}

function classMapForTextblock(view: EditorView, pos: number): TextblockClassMap | null {
  let $pos: ResolvedPos;
  try {
    $pos = view.state.doc.resolve(pos);
  } catch {
    return null;
  }
  if (!$pos.parent.isTextblock) return null;
  const parent = $pos.parent;
  const size = parent.content.size;
  if (size === 0) {
    // Empty textblock — no units.
    return {
      tbStart: $pos.start(),
      size: 0,
      classAt: () => 'punct',
      charAt: () => '\0',
    };
  }
  const chars = new Array<string>(size);
  let p = 0;
  parent.forEach((child: PMNode) => {
    if (child.isText) {
      const t = child.text ?? '';
      for (let i = 0; i < t.length; i++) {
        chars[p + i] = t[i] ?? '\0';
      }
      p += t.length;
    } else {
      // Inline leaf occupies 1 position per nodeSize unit (usually 1).
      // Use sentinel '\0' so the iterator treats it as a hard
      // boundary (classifies as 'punct').
      for (let i = 0; i < child.nodeSize; i++) chars[p + i] = '\0';
      p += child.nodeSize;
    }
  });
  return {
    tbStart: $pos.start(),
    size,
    classAt: (i) => classifyChar(chars[i] ?? '\0'),
    charAt: (i) => chars[i] ?? '\0',
  };
}

/** Map a doc position to the local char index whose unit the
 *  position falls inside. PM positions sit BETWEEN characters,
 *  so we bias toward the char to the RIGHT (`localOffset` itself)
 *  for most positions, and to the LEFT (`localOffset - 1`) when
 *  the position is at the textblock end. Returns null if the
 *  position is outside a textblock. */
function localCharIndex(view: EditorView, pos: number): {
  map: TextblockClassMap;
  idx: number;
} | null {
  const map = classMapForTextblock(view, pos);
  if (!map) return null;
  if (map.size === 0) return null;
  const localOffset = pos - map.tbStart;
  let idx = localOffset;
  if (idx >= map.size) idx = map.size - 1;
  if (idx < 0) idx = 0;
  return { map, idx };
}

/** Layer 1 query unit at a doc position — applies trailing-space
 *  absorption (word/punct unit extends to include any
 *  immediately-following space unit; space/tab units don't reach
 *  back). Returns doc-position range. Null when the position
 *  isn't inside a textblock with content. */
function queryUnitAtDocPos(
  view: EditorView,
  pos: number,
): { from: number; to: number } | null {
  const hit = localCharIndex(view, pos);
  if (!hit) return null;
  const { map, idx } = hit;
  const cls = map.classAt(idx);
  if (cls === 'tab') {
    // Tab is always atomic — never absorbs, never groups.
    return { from: map.tbStart + idx, to: map.tbStart + idx + 1 };
  }
  // Walk the maximal same-class run containing idx.
  let lo = idx;
  let hi = idx;
  while (lo > 0 && map.classAt(lo - 1) === cls) lo--;
  while (hi + 1 < map.size && map.classAt(hi + 1) === cls) hi++;
  let end = hi + 1;
  if (cls === 'word' || cls === 'punct') {
    while (end < map.size && map.classAt(end) === 'space') end++;
  }
  return { from: map.tbStart + lo, to: map.tbStart + end };
}

/** Resolve a doc position to the [from, to] range of the
 *  enclosing textblock — the paragraph-granularity unit. Returns
 *  null when the position doesn't resolve inside a textblock. */
function textblockRangeAt(
  view: EditorView,
  pos: number,
): { from: number; to: number } | null {
  let $pos: ResolvedPos;
  try {
    $pos = view.state.doc.resolve(
      Math.max(0, Math.min(pos, view.state.doc.content.size)),
    );
  } catch {
    return null;
  }
  let depth = $pos.depth;
  while (depth > 0 && !$pos.node(depth).isTextblock) depth--;
  if (depth === 0) return null;
  return {
    from: $pos.before(depth) + 1,
    to: $pos.after(depth) - 1,
  };
}

/** Like `queryUnitAtDocPos` but never applies trailing-space
 *  absorption. Used for drag-extension by units AFTER the
 *  initiating click — only the initial unit absorbs per the
 *  spec ("absorption is asymmetric"). */
function bareUnitAtDocPos(
  view: EditorView,
  pos: number,
): { from: number; to: number } | null {
  const hit = localCharIndex(view, pos);
  if (!hit) return null;
  const { map, idx } = hit;
  const cls = map.classAt(idx);
  if (cls === 'tab') {
    return { from: map.tbStart + idx, to: map.tbStart + idx + 1 };
  }
  let lo = idx;
  let hi = idx;
  while (lo > 0 && map.classAt(lo - 1) === cls) lo--;
  while (hi + 1 < map.size && map.classAt(hi + 1) === cls) hi++;
  return { from: map.tbStart + lo, to: map.tbStart + hi + 1 };
}

