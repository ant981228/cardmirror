/**
 * Layer 2 — Word-style keyboard navigation: caret movement and
 * extension. (`word-break.ts` defines the word-selection model and
 * its layer taxonomy.) Six commands plus their Shift-extend
 * variants:
 *
 *   - **Ctrl+Left / Ctrl+Right** → start of previous / next unit
 *     using the Layer 1 iterator (`classifyChar` from
 *     `word-break.ts`). Cross-textblock: at the start of a
 *     textblock, Ctrl+Left jumps to the LAST unit's start of the
 *     previous textblock; symmetric Ctrl+Right at end-of-block
 *     lands at the next textblock's first unit start.
 *   - **Ctrl+Up** → start of the CURRENT paragraph; if already
 *     there, the previous paragraph (the spec's asymmetric
 *     "stop on current first" behavior).
 *   - **Ctrl+Down** → start of the next paragraph (no
 *     intermediate stop on the current paragraph's end — Word's
 *     asymmetric pair).
 *   - **PageUp** → start of the current heading marker; if
 *     already there, the previous heading. "Heading" here is any
 *     of the doc's heading-anchored node types
 *     (`pocket / hat / block / tag / analytic`, via
 *     `headings.ts:TYPE_TO_LEVEL`). Same shape as Ctrl+Up but
 *     using the headings list — useful for skipping over body
 *     content and free paragraphs to land on the next structural
 *     marker.
 *   - **PageDown** → start of the next heading marker.
 *
 * Shift+ variants of each extend the selection: anchor stays at
 * the existing selection's anchor; head moves to the destination.
 *
 * Mac convention: Alt+Arrow is the native word/paragraph move
 * (Mac uses Option, not Ctrl, for these). Each Ctrl- binding has
 * a matching Alt- binding that dispatches the same command, so
 * the keymap works the same on Mac as on Win/Linux without
 * needing a separate per-platform setup.
 *
 * Home / End and Ctrl+Home / Ctrl+End are deliberately NOT
 * bound here — the browser's contenteditable defaults already
 * match the spec (visual-line start/end and doc start/end
 * respectively).
 */

import { keymap } from 'prosemirror-keymap';
import { TextSelection } from 'prosemirror-state';
import type { Command, EditorState, Transaction } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { classifyChar } from './word-break.js';
import { preciseScrollIntoView, scrollToHeadingId } from './precise-scroll.js';
import { TYPE_TO_LEVEL } from './headings.js';

// ─── Textblock class-map (Layer 1 lookup inside a textblock) ───────

interface ClassMap {
  size: number;
  classAt: (i: number) => 'word' | 'space' | 'tab' | 'punct';
}

function classMapFor(parent: PMNode): ClassMap {
  const size = parent.content.size;
  const chars = new Array<string>(size);
  let p = 0;
  parent.forEach((child) => {
    if (child.isText) {
      const t = child.text ?? '';
      for (let i = 0; i < t.length; i++) chars[p + i] = t[i] ?? '\0';
      p += t.length;
    } else {
      // Inline leaf: sentinel '\0' classifies as 'punct' so it
      // bounds any in-progress word/space run.
      for (let i = 0; i < child.nodeSize; i++) chars[p + i] = '\0';
      p += child.nodeSize;
    }
  });
  return {
    size,
    classAt: (i) => classifyChar(chars[i] ?? '\0'),
  };
}

/** Start of the unit that ENDS at or before `offset`. Walks left
 *  from `offset` and returns the start of the run we land in.
 *  Used by Ctrl+Left. Returns 0 when `offset` is already at the
 *  textblock start.
 *
 *  Differs from the mouse-side iterator in `word-selection-
 *  plugin.ts`: for keyboard nav, the spec's trailing-space
 *  absorption applies on BOTH sides — pressing Ctrl+Right from
 *  the start of "help to" lands the caret just before "to"
 *  (skipping "help" + its trailing space in one keystroke), and
 *  the symmetric Ctrl+Left from that landing position rewinds
 *  to the start of "help". Without absorption the user would
 *  have to press an extra time to step over each inter-word
 *  space, which doesn't match the editor convention. (The mouse
 *  side keeps the asymmetric "query absorbs, drag doesn't"
 *  behavior — only the initiating click absorbs.) */
function prevUnitStart(map: ClassMap, offset: number): number {
  if (offset <= 0) return 0;
  let i = offset - 1;
  let cls = map.classAt(i);
  if (cls === 'tab') return i;
  if (cls === 'space') {
    // Trailing-space absorption: rewind through the space run
    // first, then keep going through the word/punct run before
    // it (if any) so a single Ctrl+Left jumps to the start of
    // the absorbed unit.
    while (i > 0 && map.classAt(i - 1) === 'space') i--;
    if (i > 0) {
      const prevCls = map.classAt(i - 1);
      if (prevCls === 'word' || prevCls === 'punct') {
        i--;
        cls = prevCls;
        while (i > 0 && map.classAt(i - 1) === cls) i--;
        return i;
      }
      // Tab to the left → tab is atomic, doesn't absorb. Land
      // at the start of the space run (= the position right
      // after the tab).
    }
    return i;
  }
  // Char to the left is word/punct — walk the run.
  while (i > 0 && map.classAt(i - 1) === cls) i--;
  return i;
}

/** Start of the unit that begins AT or AFTER `offset`. Walks
 *  right from `offset` past the rest of the current run. Used by
 *  Ctrl+Right. Returns `map.size` when `offset` is already past
 *  the last unit. Applies Layer 1 trailing-space absorption (see
 *  `prevUnitStart` for the rationale). */
function nextUnitStart(map: ClassMap, offset: number): number {
  if (offset >= map.size) return map.size;
  const cls = map.classAt(offset);
  if (cls === 'tab') return offset + 1;
  let i = offset;
  while (i < map.size && map.classAt(i) === cls) i++;
  // Word and punctuation runs absorb any immediately-following
  // space run (single Ctrl+Right skips "word" + trailing space
  // together). Tabs and spaces don't absorb.
  if (cls === 'word' || cls === 'punct') {
    while (i < map.size && map.classAt(i) === 'space') i++;
  }
  return i;
}

// ─── Textblock walk helpers ────────────────────────────────────────

/** The textblock IMMEDIATELY BEFORE `pos` in document order, or
 *  null when `pos` is in or before the first textblock. Returns
 *  the textblock's content range (positions of its first /
 *  last-plus-one inline positions). Walks `descendants` and
 *  records every textblock seen until passing `pos`. */
function prevTextblock(doc: PMNode, pos: number): { start: number; end: number; node: PMNode } | null {
  let result: { start: number; end: number; node: PMNode } | null = null;
  doc.descendants((node, nodePos) => {
    // Anything entirely past `pos` is past the cutoff.
    if (nodePos + 1 >= pos) return false;
    if (node.isTextblock) {
      result = {
        start: nodePos + 1,
        end: nodePos + node.nodeSize - 1,
        node,
      };
      return false; // don't descend into a textblock's inline content
    }
    return true;
  });
  return result;
}

/** The textblock IMMEDIATELY AFTER `pos` in document order. Same
 *  shape as `prevTextblock`. */
function nextTextblock(doc: PMNode, pos: number): { start: number; end: number; node: PMNode } | null {
  let result: { start: number; end: number; node: PMNode } | null = null;
  doc.descendants((node, nodePos) => {
    if (result !== null) return false;
    const nodeEnd = nodePos + node.nodeSize;
    if (nodeEnd <= pos) return false;
    if (node.isTextblock) {
      const start = nodePos + 1;
      if (start > pos) {
        result = { start, end: nodePos + node.nodeSize - 1, node };
      }
      return false;
    }
    return true;
  });
  return result;
}

// ─── Heading list (PageUp / PageDown) ──────────────────────────────

interface HeadingHit {
  /** Doc position of the heading node itself — the heading's
   *  inline content starts at `pos + 1`. */
  pos: number;
}

/** Flat list of all heading-anchored nodes in the doc, in
 *  document order. Same set the nav-panel uses (TYPE_TO_LEVEL
 *  from `headings.ts`): pocket / hat / block / tag / analytic.
 *  `onlyType` narrows it to one node type (the Next / Previous
 *  Pocket … Tag commands). */
function collectHeadingPositions(doc: PMNode, onlyType?: string): HeadingHit[] {
  const out: HeadingHit[] = [];
  doc.descendants((node, pos) => {
    if (onlyType ? node.type.name === onlyType : node.type.name in TYPE_TO_LEVEL) {
      out.push({ pos });
    }
    // Descend through non-textblock containers only (card, analytic_unit,
    // zone, live view — tags/analytics live inside them), but never into
    // textblocks: headings can't nest inside a textblock, and descending
    // visited every text RUN in the doc per keypress (audit A-14). Zone- and
    // view-inner headings stay navigation destinations, same as before.
    return !node.isTextblock;
  });
  return out;
}

// ─── Destination computation ───────────────────────────────────────

/** Compute the destination position for "previous unit start" from
 *  the current selection's head. Returns null when there's nowhere
 *  to go (caret in a non-textblock context, or doc start). */
function destPrevUnit(state: EditorState): number | null {
  const $head = state.selection.$head;
  if (!$head.parent.isTextblock) return null;
  const localOffset = $head.parentOffset;
  if (localOffset > 0) {
    const map = classMapFor($head.parent);
    return $head.start() + prevUnitStart(map, localOffset);
  }
  // Already at start of textblock — cross-block. Land at the END of the
  // previous textblock (just AFTER its trailing word / punctuation), not
  // at the start of that last unit. This mirrors the forward direction,
  // where crossing into the next paragraph lands at its start
  // (`destNextUnit` → `next.start`): both stop just across the paragraph
  // break rather than a full word into the neighbour.
  const prev = prevTextblock(state.doc, $head.start());
  if (!prev) return null;
  return prev.end;
}

function destNextUnit(state: EditorState): number | null {
  const $head = state.selection.$head;
  if (!$head.parent.isTextblock) return null;
  const localOffset = $head.parentOffset;
  if (localOffset < $head.parent.content.size) {
    const map = classMapFor($head.parent);
    return $head.start() + nextUnitStart(map, localOffset);
  }
  const next = nextTextblock(state.doc, $head.end());
  if (!next) return null;
  // Land at the start of the next textblock's first unit. Empty
  // textblocks have no units, so the destination is just the
  // textblock's content-start (offset 0).
  return next.start;
}

function destPrevParaStart(state: EditorState): number | null {
  const $head = state.selection.$head;
  if (!$head.parent.isTextblock) return null;
  const tbStart = $head.start();
  if ($head.pos > tbStart) return tbStart;
  // Already at start of current textblock — move to previous.
  const prev = prevTextblock(state.doc, tbStart);
  return prev ? prev.start : null;
}

function destNextParaStart(state: EditorState): number | null {
  const $head = state.selection.$head;
  if (!$head.parent.isTextblock) return null;
  const next = nextTextblock(state.doc, $head.end());
  return next ? next.start : null;
}

function destPrevHeading(state: EditorState): number | null {
  const headings = collectHeadingPositions(state.doc);
  if (headings.length === 0) return null;
  const caret = state.selection.head;
  // Last heading whose content-start (pos + 1) is ≤ caret. That
  // heading is the "current" one — the most recently-passed
  // heading marker as the caret moved through the doc.
  let currentIdx = -1;
  for (let i = headings.length - 1; i >= 0; i--) {
    if (headings[i]!.pos + 1 <= caret) {
      currentIdx = i;
      break;
    }
  }
  if (currentIdx < 0) return null;
  const currentStart = headings[currentIdx]!.pos + 1;
  if (caret > currentStart) return currentStart;
  // Caret is exactly at start of current heading → previous.
  if (currentIdx === 0) return null;
  return headings[currentIdx - 1]!.pos + 1;
}

function destNextHeading(state: EditorState): number | null {
  const headings = collectHeadingPositions(state.doc);
  const caret = state.selection.head;
  for (const h of headings) {
    const start = h.pos + 1;
    if (start > caret) return start;
  }
  return null;
}

/** Previous / next heading of ONE type (`pocket` / `hat` / `block` /
 *  `tag`), for the bindable Next / Previous Pocket … Tag commands.
 *  Previous has PageUp's shape: the start of the one the caret is in
 *  (past its start), else the one before. Every other heading type is
 *  skipped over. */
function destPrevHeadingOfType(state: EditorState, type: string): number | null {
  const caret = state.selection.head;
  const headings = collectHeadingPositions(state.doc, type);
  for (let i = headings.length - 1; i >= 0; i--) {
    const start = headings[i]!.pos + 1;
    if (start < caret) return start;
  }
  return null;
}

function destNextHeadingOfType(state: EditorState, type: string): number | null {
  const caret = state.selection.head;
  for (const h of collectHeadingPositions(state.doc, type)) {
    const start = h.pos + 1;
    if (start > caret) return start;
  }
  return null;
}

// ─── Move / extend command pair builders ───────────────────────────

/** Build a pair of Commands (move, extend) from a destination
 *  resolver. `move` collapses the selection to the destination;
 *  `extend` keeps the anchor and moves only the head. */
function commandPair(
  computeDest: (state: EditorState) => number | null,
  opts: {
    /** Scroll the destination on screen yourself (needs the view);
     *  without it, or with no view, the transaction's own minimal
     *  scroll-into-view is used. */
    scroll?: (view: EditorView, dest: number) => void;
  } = {},
): { move: Command; extend: Command } {
  const apply = (extending: boolean): Command => (state, dispatch, view) => {
    const destRaw = computeDest(state);
    if (destRaw === null) return false;
    // Clamp to a valid TextSelection position; PM throws if the
    // destination isn't inside text. `TextSelection.near` finds
    // the nearest valid position in document order.
    let tr: Transaction;
    try {
      const anchor = extending ? state.selection.anchor : destRaw;
      tr = state.tr.setSelection(
        TextSelection.create(state.doc, anchor, destRaw),
      );
    } catch {
      try {
        const sel = TextSelection.near(state.doc.resolve(destRaw));
        if (extending) {
          tr = state.tr.setSelection(
            TextSelection.create(state.doc, state.selection.anchor, sel.head),
          );
        } else {
          tr = state.tr.setSelection(sel);
        }
      } catch {
        return false;
      }
    }
    if (!dispatch) return true;
    if (opts.scroll && view) {
      dispatch(tr);
      opts.scroll(view, destRaw);
    } else {
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
  return { move: apply(false), extend: apply(true) };
}

/** Variant of `commandPair` for the horizontal Ctrl+Left /
 *  Ctrl+Right pair. Symmetric to `verticalCommandPair` (paragraph
 *  edge), one notch finer: when a non-empty selection is present
 *  and Shift is NOT held, snap to the START (Left) or END (Right)
 *  of the WORD/PUNCT unit that contains the corresponding
 *  selection edge.
 *
 *  Two cases for the edge corner:
 *
 *   - INSIDE a word or punct run (both flanking chars are the
 *     same word/punct class) → snap to that unit's edge via
 *     `prevUnitStart` / `nextUnitStart`. The same iterator the
 *     no-selection commands use, so the destination matches
 *     pressing Ctrl+Right from a caret at the corner.
 *   - AT a unit boundary (corner at textblock edge, or flanked
 *     by space/tab on the motion-side, or by a different class)
 *     → just collapse to the corner. The position is already at
 *     a unit edge; mirrors `verticalCommandPair`'s "stay put
 *     when `$to.parentOffset === 0`" fallback.
 *
 *  Shift-extend variants are unaffected. */
function horizontalCommandPair(
  computeDest: (state: EditorState) => number | null,
  collapseEdge: 'from' | 'to',
): { move: Command; extend: Command } {
  const base = commandPair(computeDest);
  const move: Command = (state, dispatch) => {
    if (!state.selection.empty) {
      const $corner =
        collapseEdge === 'from' ? state.selection.$from : state.selection.$to;
      let dest: number;
      if ($corner.parent.isTextblock) {
        const map = classMapFor($corner.parent);
        const offset = $corner.parentOffset;
        if (isInsideWordOrPunctUnit(map, offset)) {
          const local =
            collapseEdge === 'from'
              ? prevUnitStart(map, offset)
              : nextUnitStart(map, offset);
          dest = $corner.start() + local;
        } else {
          dest = collapseEdge === 'from' ? state.selection.from : state.selection.to;
        }
      } else {
        dest = collapseEdge === 'from' ? state.selection.from : state.selection.to;
      }
      if (!dispatch) return true;
      dispatch(
        state.tr
          .setSelection(TextSelection.create(state.doc, dest))
          .scrollIntoView(),
      );
      return true;
    }
    return base.move(state, dispatch);
  };
  return { move, extend: base.extend };
}

/** True when `offset` lies strictly inside a contiguous run of
 *  word OR punct characters — both the char to the left and the
 *  char at `offset` are the same word/punct class. Boundaries
 *  (textblock edges, adjacent to space/tab, or class transitions
 *  like word/punct) are NOT inside a unit. */
function isInsideWordOrPunctUnit(map: ClassMap, offset: number): boolean {
  if (offset <= 0 || offset >= map.size) return false;
  const left = map.classAt(offset - 1);
  const right = map.classAt(offset);
  if (left !== right) return false;
  return left === 'word' || left === 'punct';
}

/** Variant of `commandPair` for the vertical Ctrl+Up / Ctrl+Down
 *  pair: when a non-empty selection is present and Shift is NOT held,
 *  the move command collapses the selection relative to a paragraph
 *  edge instead of computing from the head (which can carry the caret
 *  into the wrong paragraph). Shift-extend variants are unaffected.
 *
 *  - Up (`from-start`): collapse to the START of the paragraph holding
 *    the selection's start. A following Up then walks to the previous
 *    paragraph.
 *  - Down (`to-end`): collapse to the START of the paragraph AFTER the
 *    one holding the selection's end — i.e. just past the paragraph
 *    break, the same place a Down would continue to. A following Down
 *    then continues to the paragraph after that.
 *
 *  Down edge cases:
 *  - `$to.parentOffset === 0`: after Ctrl+Shift+Down, `$to` sits at the
 *    START of the paragraph BELOW the last visibly-selected one. That
 *    paragraph's start already IS "the next paragraph", so collapse
 *    there (don't skip it).
 *  - Selection ends in the doc's last textblock (no paragraph after):
 *    park at that paragraph's end — there's nowhere further to go. */
function verticalCommandPair(
  computeDest: (state: EditorState) => number | null,
  paraEdge: 'from-start' | 'to-end',
): { move: Command; extend: Command } {
  const base = commandPair(computeDest);
  const move: Command = (state, dispatch) => {
    if (!state.selection.empty) {
      const corner =
        paraEdge === 'from-start' ? state.selection.$from : state.selection.$to;
      if (!corner.parent.isTextblock) return base.move(state, dispatch);
      let dest: number;
      if (paraEdge === 'from-start') {
        dest = corner.start();
      } else if (corner.parentOffset === 0) {
        // $to already at a paragraph start (Ctrl+Shift+Down spill) — that
        // paragraph IS the next one; collapse there.
        dest = corner.start();
      } else {
        // Start of the paragraph after the selection-end paragraph; no
        // next paragraph → park at this paragraph's end.
        const next = nextTextblock(state.doc, corner.end());
        dest = next ? next.start : corner.end();
      }
      if (!dispatch) return true;
      dispatch(
        state.tr
          .setSelection(TextSelection.create(state.doc, dest))
          .scrollIntoView(),
      );
      return true;
    }
    return base.move(state, dispatch);
  };
  return { move, extend: base.extend };
}

const { move: moveCaretToPrevUnit, extend: extendSelectionToPrevUnit } =
  horizontalCommandPair(destPrevUnit, 'from');
const { move: moveCaretToNextUnit, extend: extendSelectionToNextUnit } =
  horizontalCommandPair(destNextUnit, 'to');
const { move: moveCaretToPrevParaStart, extend: extendSelectionToPrevParaStart } =
  verticalCommandPair(destPrevParaStart, 'from-start');
const { move: moveCaretToNextParaStart, extend: extendSelectionToNextParaStart } =
  verticalCommandPair(destNextParaStart, 'to-end');
const { move: moveCaretToPrevHeading, extend: extendSelectionToPrevHeading } =
  commandPair(destPrevHeading);
const { move: moveCaretToNextHeading, extend: extendSelectionToNextHeading } =
  commandPair(destNextHeading);

/** Land the heading the caret just jumped to where a nav-pane click
 *  puts it: at the top of the scroller, less the headings' scroll
 *  margin, so it sits just under the ribbon — instead of the
 *  transaction's minimal scroll, which leaves it flush with whichever
 *  edge the caret came from. Same path as `NavigationPanel.jumpTo`:
 *  the heading's `data-id` element, else the element at the position.
 *  `dest` is one past the heading node's start. */
function scrollHeadingLikeNavClick(view: EditorView, dest: number): void {
  const id = view.state.doc.nodeAt(dest - 1)?.attrs['id'];
  if (typeof id === 'string' && id && scrollToHeadingId(view, id)) return;
  let el: Node | null = view.domAtPos(dest).node;
  while (el && el.nodeType !== Node.ELEMENT_NODE) el = el.parentNode;
  if (el instanceof HTMLElement) preciseScrollIntoView(view, el);
}

/** Caret-move commands for the ribbon registry's `nextPocket` …
 *  `prevTag` (no default keys). No-op (false) when there's no
 *  heading of that type in that direction. The heading lands where
 *  a nav-pane click would put it (see `scrollHeadingLikeNavClick`);
 *  PageUp / PageDown keep their minimal scroll. */
export function moveToHeadingOfType(type: string, dir: 'prev' | 'next'): Command {
  return commandPair(
    dir === 'prev'
      ? (state) => destPrevHeadingOfType(state, type)
      : (state) => destNextHeadingOfType(state, type),
    { scroll: scrollHeadingLikeNavClick },
  ).move;
}

// ─── The keymap plugin ─────────────────────────────────────────────

/** Bindings cover both Win/Linux (Ctrl) and Mac (Alt) word /
 *  paragraph keystrokes. PageUp / PageDown is the same key on
 *  every platform. */
export const wordSelectionKeymap = keymap({
  'Ctrl-ArrowLeft': moveCaretToPrevUnit,
  'Alt-ArrowLeft': moveCaretToPrevUnit,
  'Ctrl-ArrowRight': moveCaretToNextUnit,
  'Alt-ArrowRight': moveCaretToNextUnit,
  'Ctrl-Shift-ArrowLeft': extendSelectionToPrevUnit,
  'Alt-Shift-ArrowLeft': extendSelectionToPrevUnit,
  'Ctrl-Shift-ArrowRight': extendSelectionToNextUnit,
  'Alt-Shift-ArrowRight': extendSelectionToNextUnit,

  'Ctrl-ArrowUp': moveCaretToPrevParaStart,
  'Alt-ArrowUp': moveCaretToPrevParaStart,
  'Ctrl-ArrowDown': moveCaretToNextParaStart,
  'Alt-ArrowDown': moveCaretToNextParaStart,
  'Ctrl-Shift-ArrowUp': extendSelectionToPrevParaStart,
  'Alt-Shift-ArrowUp': extendSelectionToPrevParaStart,
  'Ctrl-Shift-ArrowDown': extendSelectionToNextParaStart,
  'Alt-Shift-ArrowDown': extendSelectionToNextParaStart,

  PageUp: moveCaretToPrevHeading,
  PageDown: moveCaretToNextHeading,
  'Shift-PageUp': extendSelectionToPrevHeading,
  'Shift-PageDown': extendSelectionToNextHeading,
});
