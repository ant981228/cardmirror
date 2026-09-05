/**
 * Verbatim ribbon commands — structural style application, formatting
 * marks, and the keymap / command-ID registry
 * (ARCHITECTURE.md §15 ribbon-command parity).
 *
 * Heading-hotkey conversion rules (F4 / F5 / F6 / F7 → Pocket / Hat /
 * Block / Tag):
 *   - paragraph at doc root → target heading (new id)
 *   - pocket / hat / block at doc root → target heading (preserve id)
 *   - same-type re-press → reset toward the style's canonical look
 *     (clear indent + stray font size / color; see `stripIndentAtDepth`)
 *   - tag inside card → dissolve card; tag → target heading. Card
 *     children that follow become loose doc-level siblings:
 *     card_body → paragraph, cite_paragraph → paragraph, undertag is
 *     kept, analytic gets wrapped in an analytic_unit.
 *   - analytic inside analytic_unit → analogous dissolve
 *   - body slot (card_body / cite_paragraph / undertag) inside
 *     card / analytic_unit:
 *       - F4–F6 split the container: everything before the cursor slot
 *         stays in the container; the cursor slot becomes a heading
 *         after; following children lift out as loose siblings
 *         (card_body / cite_paragraph → paragraph, undertag kept,
 *         analytic wrapped in analytic_unit).
 *       - F7 splits into two cards: the cursor slot becomes the tag of
 *         a new card; following children (card_body / undertag /
 *         cite_paragraph / analytic) become that new card's body.
 *   - F7 on doc-level paragraph/heading → wrap as card with tag
 *     carrying the original content (preserve id on heading → tag)
 *   - F7 on analytic-as-anchor of analytic_unit → analytic_unit
 *     becomes card; analytic becomes tag
 *
 * Returns false (no-op) for contexts a command doesn't handle, e.g.
 * an analytic that's the cite-slot of a card rather than the anchor
 * of an analytic_unit.
 */

import { Fragment, type Mark, type MarkType, type Node as PMNode, type ResolvedPos } from 'prosemirror-model';
import { Selection, TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { toggleMark } from 'prosemirror-commands';
import { toggleReadingMarkerCommand } from './reading-marker.js';
import { convertCardsToReadMode } from './convert-cards-to-read-mode.js';
import { openFootnoteEditor } from './footnote-popover.js';
import { flipQuoteDirection } from './flip-quote-direction.js';
import {
  isPluginCommandId,
  pluginCommandIds,
  pluginCommandLabel,
  pluginCommandKeywords,
  pluginDefaultKey,
  runPluginCommand,
} from './plugin-registry.js';
import { schema } from '../schema/index.js';
import { newHeadingId } from '../schema/ids.js';
import {
  condenseBranchC,
  condenseMerge,
  condenseWithWarning,
  uncondense,
  toggleCase,
  type HeadingMode,
} from './condense.js';
import { applyPlainPasteFromText, togglePlainPaste } from './paste-plugin.js';
import { lockHighlighting } from './create-reference.js';
import { showToast } from './toast.js';
import { surfaceError } from './error-surface.js';
import { TYPE_TO_LEVEL, TYPE_LABEL } from './headings.js';
import { selectedTransclusion, enclosingZonePos, isTransclusionNode } from './transclusion.js';
import { refreshZoneAtPos, refreshAllZones, detachZoneAtPos } from './transclusion-actions.js';
import { checkLiveZoneSources } from './transclusion-divergence-plugin.js';
import {
  fixFormattingGaps,
  forEachGap,
  isGapChar,
  STRUCTURAL_TEXTBLOCKS_FOR_UNDERLINE,
  WORD_CHAR_RE,
  type GapHit,
} from './formatting-gaps.js';

// Re-exported: the command lives in formatting-gaps.ts (extracted so the
// paste converters can run it without importing this module, which would
// cycle through paste-plugin); this module remains its command-surface home.

const SHRINK_ON_CITE_MESSAGE = 'This paragraph is a cite line — shrink works on body text';
export { fixFormattingGaps };
import { refreshFailMessage } from './transclusion-resolve.js';
import { getElectronHost, getHost } from './host/index.js';
import { classifyChar, isWordChar } from './word-break.js';
import { moveContainerUp, moveContainerDown } from './move-container.js';
import { toggleNumberRole, toggleSubRole, toggleNumRestart } from './numbering-commands.js';
import { settings } from './settings.js';
import { matchAcronymPattern } from './acronym-patterns.js';
import {
  getTimerState,
  loadSpeechPreset,
  pauseTimer,
  resetTimer,
  selectMode,
  setTimerVisible,
  startTimer,
} from './timer-state.js';
import {
  selectSimilar,
  getOperatingRanges,
  META_OPERATING_ON_SHADOW,
} from './similar-selection-plugin.js';
// Structural table commands go through the ragged-table guard — raw
// prosemirror-tables commands on a ragged table (the shape concurrent
// collab row+column inserts merge to) can nest a row inside a row and
// corrupt the doc. See table-guard.ts.
import {
  guardedAddRowAfter,
  guardedAddRowBefore,
  guardedDeleteRow,
  guardedAddColumnAfter,
  guardedAddColumnBefore,
  guardedDeleteColumn,
  guardedDeleteTable,
  guardedMergeCells,
  guardedSplitCell,
} from './table-guard.js';

type HeadingTypeName = 'pocket' | 'hat' | 'block';

const DOC_HEADINGS = new Set<string>(['pocket', 'hat', 'block']);
const CONTAINER_HEAD = new Set<string>(['tag', 'analytic']);
/** Body-slot textblocks that can appear as non-head children of a
 *  card or analytic_unit. When the cursor is in one of these and
 *  the user invokes a heading hotkey (F4-F7 / Mod-F7), the command
 *  splits the surrounding container at that body slot — the slot
 *  becomes the new heading; preceding body slots stay in the
 *  original container; following body slots lift out. */
const SPLITTABLE_BODY_SLOTS = new Set<string>(['card_body', 'cite_paragraph', 'undertag']);

/** Textblock types whose doc-level instances can be converted to
 *  a heading / tag / analytic / undertag in place. Body slots
 *  (cite_paragraph, undertag, card_body) can legally appear at doc
 *  level (per the schema's BLOCK_CONTENT) — e.g., after a card
 *  dissolve lifts them out — and the heading hotkeys should treat
 *  them like a plain paragraph. */
const DOC_LEVEL_CONVERTIBLE = new Set<string>([
  'paragraph',
  'cite_paragraph',
  'undertag',
  'card_body',
  'pocket',
  'hat',
  'block',
]);

/** Direct-formatting marks. Stripped when F8/F9/F10 ADD a named
 *  style — the named style's typography (cite 13pt bold, underline
 *  style, emphasis decorations) replaces direct overrides. F9 also
 *  strips these on toggle-off when
 *  `clearFormattingOnNamedStyleToggleOff` is true (Verbatim parity
 *  for "press F9 twice to clear formatting").
 *
 *  `underline_direct` is intentionally NOT in this set even though
 *  it IS technically direct formatting: F9's apply pass writes
 *  underline_direct for structural-block segments, so this strip
 *  must not run in the same pass or it would erase the just-added
 *  mark. F9's toggle-off pass removes underline_direct explicitly
 *  via `tr.removeMark(..., directMark)` so it's still cleared.
 *  Promotion strips (F4–F7) include underline_direct explicitly
 *  through `PROMOTION_STRIP_MARK_NAMES`.
 *
 *  `link` is excluded — semantic content, not formatting. */
const DIRECT_FORMATTING_MARK_NAMES = [
  'font_size',
  'font_color',
  'font_family',
  'bold',
  // The structural-bold override (a word unbolded inside a tag/heading).
  // Clearing direct formatting or promoting text restores the block's
  // default bold, so it belongs here alongside `bold`.
  'bold_off',
  'italic',
  'strikethrough',
  'highlight',
  'shading',
] as const;

/** Apply-direction strip: the set used when adding a named-style
 *  mark (F8 Cite, F9 Underline, F10 Emphasis). `highlight` is
 *  *intentionally excluded* — users keep their highlights when
 *  applying a character style on top, since the highlight color
 *  marks "this is the argument-text" and survives a typographic
 *  re-skin. Shading still strips on apply (its semantic is closer
 *  to a font color than a content marker). The toggle-off direction
 *  of F9 still uses the full `DIRECT_FORMATTING_MARK_NAMES` set via
 *  `stripDirectFormatting` below — pressing F9 twice still clears
 *  highlight, matching Verbatim's "F9 twice → fully cleared". */
const APPLY_DIRECT_FORMATTING_STRIP_NAMES = [
  'font_size',
  'font_color',
  'font_family',
  'bold',
  'italic',
  'strikethrough',
  'shading',
] as const;

function stripDirectFormatting(tr: Transaction, from: number, to: number): void {
  for (const name of DIRECT_FORMATTING_MARK_NAMES) {
    const mt = schema.marks[name];
    if (mt) tr.removeMark(from, to, mt);
  }
}

function stripDirectFormattingOnApply(
  tr: Transaction,
  from: number,
  to: number,
): void {
  for (const name of APPLY_DIRECT_FORMATTING_STRIP_NAMES) {
    const mt = schema.marks[name];
    if (mt) tr.removeMark(from, to, mt);
  }
}

/** All marks stripped when body text is promoted into a structural
 *  block (F4–F7 / Mod-F7 / Mod-F8). The structural block's own
 *  typography applies — named-style marks (cite_mark / underline_mark
 *  / emphasis_mark / undertag_mark / analytic_mark) and any direct
 *  formatting lose meaning. `link` is preserved (semantic content);
 *  `pilcrow_marker` is also preserved (post-condense markers shouldn't
 *  silently vanish when their paragraph is restyled). */
const PROMOTION_STRIP_MARK_NAMES = [
  ...DIRECT_FORMATTING_MARK_NAMES,
  'underline_direct',
  'cite_mark',
  'underline_mark',
  'emphasis_mark',
  'undertag_mark',
  'analytic_mark',
] as const;
const PROMOTION_STRIP_SET = new Set<string>(PROMOTION_STRIP_MARK_NAMES);

function stripPromotionMarksOnTr(
  tr: Transaction,
  from: number,
  to: number,
): void {
  for (const name of PROMOTION_STRIP_MARK_NAMES) {
    const mt = schema.marks[name];
    if (mt) tr.removeMark(from, to, mt);
  }
}

/** Strip promotion-affected marks from every text/inline node in a
 *  fragment, returning a new fragment. Use this when building NEW
 *  structural nodes from existing body content (e.g., wrapping a
 *  paragraph in a card+tag — the tag should get clean content). */
function stripPromotionMarksOnFragment(fragment: Fragment): Fragment {
  const out: PMNode[] = [];
  fragment.forEach((child) => {
    const newMarks = child.marks.filter((m) => !PROMOTION_STRIP_SET.has(m.type.name));
    out.push(child.mark(newMarks));
  });
  return Fragment.fromArray(out);
}

/** Direct character-formatting marks cleared when a structural style is
 *  re-pressed on a block that's already that type — resetting it toward the
 *  style's canonical look. `indent` is reset alongside these; `spacing` is
 *  intentionally preserved. */
const REAPPLY_CLEAR_MARK_NAMES = ['font_size', 'font_color'] as const;

/** Mark types for `REAPPLY_CLEAR_MARK_NAMES` that exist in the schema. */
function reapplyClearMarkTypes(): MarkType[] {
  return REAPPLY_CLEAR_MARK_NAMES.map((n) => schema.marks[n]).filter(
    (m): m is MarkType => !!m,
  );
}

/** Return a copy of a textblock with its `indent` attr reset to 0 and every
 *  direct font-size / font-color mark stripped from its inline content (type,
 *  spacing, and other attrs preserved). Returns the same node reference when
 *  nothing changes, so callers can cheaply detect a no-op. */
function clearReapplyFormatting(node: PMNode): PMNode {
  const markTypes = reapplyClearMarkTypes();
  let contentChanged = false;
  const out: PMNode[] = [];
  node.content.forEach((inline) => {
    let marks = inline.marks;
    for (const mt of markTypes) if (mt.isInSet(marks)) marks = mt.removeFromSet(marks);
    if (marks !== inline.marks) {
      contentChanged = true;
      out.push(inline.mark(marks));
    } else {
      out.push(inline);
    }
  });
  const indentChanged = (node.attrs['indent'] ?? 0) !== 0;
  if (!contentChanged && !indentChanged) return node;
  const attrs = indentChanged ? { ...node.attrs, indent: 0 } : node.attrs;
  return node.type.create(
    attrs,
    contentChanged ? Fragment.fromArray(out) : node.content,
    node.marks,
  );
}

/**
 * Bulk same-type re-press over a right-click "select all of this style"
 * shadow selection (`selectAllOfStyle`), which collapses the real PM
 * selection — so `applyStructuralToSelection` never sees the matches.
 * Resets every covered same-type block toward the style's canonical
 * look — clearing its `indent` and stray direct font-size / font-color
 * marks, mirroring `stripIndentAtDepth` — in one transaction;
 * `spacing` is preserved. Workflow: right-click the ribbon style button
 * to select all tags, left-click to scrub stray sizes / colors (often
 * imported from .docx) off them.
 *
 * Only fires for a shadow selection (`fromShadow`) whose blocks already
 * match `targetType`; a shadow of a different style, or a real
 * selection, falls through so the caller's normal conversion logic
 * runs. Returns false when no same-type block is covered.
 */
function bulkReapplyStructuralOnShadow(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  targetType: string,
): boolean {
  const op = getOperatingRanges(state);
  if (!op.fromShadow || op.ranges.length === 0) return false;
  const markTypes = reapplyClearMarkTypes();
  const targets: { pos: number; node: PMNode; from: number; to: number }[] = [];
  for (const range of op.ranges) {
    state.doc.nodesBetween(range.from, range.to, (node, pos) => {
      if (node.isTextblock && node.type.name === targetType) {
        targets.push({
          pos,
          node,
          from: Math.max(range.from, pos + 1),
          to: Math.min(range.to, pos + node.nodeSize - 1),
        });
      }
      return true;
    });
  }
  if (targets.length === 0) return false;
  if (!dispatch) return true;
  const tr = state.tr;
  // setNodeMarkup / removeMark steps don't change positions, so original coords
  // stay valid across the loop — no mapping needed.
  for (const t of targets) {
    if ((t.node.attrs['indent'] ?? 0) !== 0) {
      tr.setNodeMarkup(t.pos, null, { ...t.node.attrs, indent: 0 });
    }
    if (t.from < t.to) for (const mt of markTypes) tr.removeMark(t.from, t.to, mt);
  }
  // Keep the shadow alive so further bulk ops can chain off the same matches.
  tr.setMeta(META_OPERATING_ON_SHADOW, true);
  dispatch(tr);
  return true;
}

/**
 * Same-type re-press helper: reset the structural block at `depth` toward its
 * style's canonical look — clear its `indent` attr and strip direct font-size /
 * font-color marks off its content — while preserving the type, `spacing`, and
 * every other attr. Returns true unconditionally (the keystroke is consumed).
 * Used by every heading / undertag shortcut's already-this-type branch.
 */
/**
 * Depth of the enclosing live zone (`transclusion_ref`), or 0 at the real doc
 * level. A zone is structurally a mini-doc (same BLOCK_CONTENT), so the
 * structural commands measure their `depth === 1/2` gates and their
 * `before/after/node/index(...)` math relative to this base — behaving
 * identically inside a zone as at the doc root, with new headings/cards landing
 * INSIDE the zone. base 0 → unchanged doc-level behavior.
 */
function structuralBaseDepth($from: ResolvedPos): number {
  for (let d = 1; d <= $from.depth; d++) {
    if ($from.node(d).type.name === 'transclusion_ref') return d;
  }
  return 0;
}

/**
 * True when the cursor is at the very END of a live zone's LAST content — the
 * end of the last body of the zone's last card / analytic_unit. A structural
 * heading key there BREAKS OUT: the new head/card lands after the zone
 * (splitContainerAtBody), cutting off the section, and the level ceiling is
 * exempt (the heading is leaving the zone). Anywhere else, the key stays in.
 */
function isZoneBottomBreakout($from: ResolvedPos, base: number): boolean {
  if (base === 0) return false;
  if ($from.depth !== base + 2) return false; // a body inside a container in the zone
  if (!SPLITTABLE_BODY_SLOTS.has($from.parent.type.name)) return false;
  if ($from.parentOffset !== $from.parent.content.size) return false; // at the body's end
  const zone = $from.node(base);
  const container = $from.node(base + 1);
  return (
    $from.index(base) === zone.childCount - 1 && // container is the zone's last child
    $from.index(base + 1) === container.childCount - 1 // body is the container's last
  );
}

/** Highest rank (lowest `TYPE_TO_LEVEL`) among a zone's heading descendants, or
 *  0 when the zone has no headings — no ceiling, so any heading is allowed
 *  (nothing to "outrank"). */
function minZoneHeadingLevel(zone: PMNode): number {
  let min = Infinity;
  zone.descendants((n) => {
    const lvl = TYPE_TO_LEVEL[n.type.name];
    if (lvl != null && lvl < min) min = lvl;
    return true;
  });
  return min === Infinity ? 0 : min;
}

/** Brief flash of a live zone's rail to signal a blocked structural op. */
function flashZoneRail(view: EditorView | undefined, zonePos: number): void {
  if (!view) return;
  const dom = view.nodeDOM(zonePos);
  if (!(dom instanceof HTMLElement)) return;
  dom.classList.remove('pmd-transclusion-flash');
  void dom.offsetWidth; // reflow so re-adding restarts the animation
  dom.classList.add('pmd-transclusion-flash');
  window.setTimeout(() => dom.classList.remove('pmd-transclusion-flash'), 600);
}

/** The position of the live zone the refresh command should act on: the one
 *  selected as a node, else the one the cursor sits inside. `null` when neither
 *  — the command is then unavailable. `refreshZoneAtPos` takes exactly this. */
function commandZonePos(state: EditorState): number | null {
  const sel = selectedTransclusion(state.selection);
  if (sel) return sel.pos;
  return enclosingZonePos(state.doc, state.selection.head);
}

/** Whether the document holds at least one live zone (gates refresh-all). */
function docHasZone(doc: PMNode): boolean {
  let found = false;
  doc.descendants((n) => {
    if (found) return false;
    if (isTransclusionNode(n)) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

/**
 * Inside a live zone, refuse to create a heading higher-rank than the zone's
 * highest existing heading — a transcluded block's contents can't gain a new
 * block/hat/pocket (that would fracture the snapshot), though cards (tag /
 * analytic) are always fine. Flashes the rail + toasts. Returns true when the
 * op should be BLOCKED (the caller swallows the key); false to proceed.
 */
function blockedByZoneLevel(
  $from: ResolvedPos,
  base: number,
  newType: string,
  view: EditorView | undefined,
): boolean {
  if (base === 0) return false; // not in a zone
  const level = TYPE_TO_LEVEL[newType];
  if (level == null) return false;
  if (level > minZoneHeadingLevel($from.node(base))) return false; // lower rank — allowed
  flashZoneRail(view, $from.before(base));
  showToast(`A ${TYPE_LABEL[newType] ?? 'heading'} would outrank this linked copy’s section — use a lower-level heading here.`);
  return true;
}

function stripIndentAtDepth(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  depth: number,
): boolean {
  if (!dispatch) return true;
  const $from = state.selection.$from;
  const node = $from.node(depth);
  const pos = $from.before(depth);
  let tr = state.tr;
  if ((node.attrs['indent'] ?? 0) !== 0) {
    tr = tr.setNodeMarkup(pos, null, { ...node.attrs, indent: 0 });
  }
  const start = pos + 1;
  const end = start + node.content.size;
  for (const mt of reapplyClearMarkTypes()) tr = tr.removeMark(start, end, mt);
  // No-op (already canonical): consume the key without dispatching an empty
  // transaction that would burn an undo step.
  if (!tr.docChanged) return true;
  dispatch(tr);
  return true;
}

/**
 * F4 / F5 / F6 — convert the current paragraph or heading to the target
 * doc-level heading type.
 */
export function setHeading(typeName: HeadingTypeName): Command {
  return (state, dispatch, view) => {
    if (!state.selection.empty) {
      return applyStructuralToSelection(state, dispatch, {
        mode: 'heading',
        headingType: typeName,
      });
    }
    if (bulkReapplyStructuralOnShadow(state, dispatch, typeName)) return true;
    if (bulkReplaceStructuralOnShadow(state, dispatch, { mode: 'heading', headingType: typeName })) return true;
    const $from = state.selection.$from;
    const base = structuralBaseDepth($from);
    // A live zone can't gain a heading that outranks its highest — block F4–F6
    // for pocket/hat/block above the zone's ceiling (cards are always fine). A
    // bottom-edge break-out is exempt: that heading lands OUTSIDE the zone.
    if (!isZoneBottomBreakout($from, base) && blockedByZoneLevel($from, base, typeName, view)) {
      return true;
    }

    if ($from.depth === base + 1) {
      const parent = $from.parent;
      const pname = parent.type.name;
      if (pname === typeName) {
        return stripIndentAtDepth(state, dispatch, base + 1);
      }
      if (!DOC_LEVEL_CONVERTIBLE.has(pname)) return false;
      if (!dispatch) return true;
      // Preserve the existing id when converting between heading
      // types (pocket↔hat↔block); body slots get a fresh id.
      const id = DOC_HEADINGS.has(pname)
        ? ((parent.attrs['id'] as string | null) ?? newHeadingId())
        : newHeadingId();
      const tr = state.tr.setNodeMarkup(
        $from.before(base + 1),
        schema.nodes[typeName]!,
        { id },
      );
      // The promoted heading takes its identity from the structural
      // type's CSS, so any prior named-style / direct formatting marks
      // on the source content are stripped.
      const contentFrom = $from.before(base + 1) + 1;
      const contentTo = contentFrom + parent.content.size;
      stripPromotionMarksOnTr(tr, contentFrom, contentTo);
      dispatch(tr.scrollIntoView());
      return true;
    }

    if ($from.depth === base + 2 && CONTAINER_HEAD.has($from.parent.type.name)) {
      return dissolveContainerToHeading(state, dispatch, typeName);
    }

    if ($from.depth === base + 2 && SPLITTABLE_BODY_SLOTS.has($from.parent.type.name)) {
      return splitContainerAtBody(state, dispatch, { mode: 'heading', headingType: typeName });
    }

    return false;
  };
}

/**
 * F7 — convert the current paragraph or heading to a tag, wrapping in
 * a card. On an analytic-anchor, convert the analytic_unit to a card.
 */
export function setTag(): Command {
  return (state, dispatch) => {
    if (!state.selection.empty) {
      return applyStructuralToSelection(state, dispatch, { mode: 'tag' });
    }
    if (bulkReapplyStructuralOnShadow(state, dispatch, 'tag')) return true;
    if (bulkReplaceStructuralOnShadow(state, dispatch, { mode: 'tag' })) return true;
    const $from = state.selection.$from;

    const base = structuralBaseDepth($from);
    if ($from.depth === base + 1) {
      const parent = $from.parent;
      const pname = parent.type.name;
      if (!DOC_LEVEL_CONVERTIBLE.has(pname)) return false;
      if (!dispatch) return true;
      const id = DOC_HEADINGS.has(pname)
        ? ((parent.attrs['id'] as string | null) ?? newHeadingId())
        : newHeadingId();
      // Strip promotion-affected marks from the source content before
      // wrapping it — body-only named-style marks and direct overrides
      // don't belong on a tag's text.
      const cleanContent = stripPromotionMarksOnFragment(parent.content);
      const tagNode = schema.nodes['tag']!.create({ id }, cleanContent);
      const cardNode = schema.nodes['card']!.create(null, [tagNode]);
      const from = $from.before(base + 1);
      const to = $from.after(base + 1);
      let tr = state.tr.replaceWith(from, to, cardNode);
      // After replace: parent → card@from → tag@(from+1) → content@(from+2)
      const cursorPos = from + 2 + Math.min($from.parentOffset, parent.content.size);
      tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
      // No scrollIntoView — wrapping in a card adds vertical chrome
      // (tag margin + card padding), so following the new selection
      // produces a jarring viewport scroll even when the cursor is
      // already visible. F4–F6 use setNodeMarkup and don't shift
      // layout, so their behavior matches without explicit suppression.
      dispatch(tr);
      return true;
    }

    if ($from.depth === base + 2 && $from.parent.type.name === 'tag') {
      return stripIndentAtDepth(state, dispatch, base + 2);
    }

    if (
      $from.depth === base + 2 &&
      $from.parent.type.name === 'analytic' &&
      $from.node(base + 1).type.name === 'analytic_unit' &&
      $from.node(base + 1).firstChild === $from.parent
    ) {
      return convertAnalyticUnitToCard(state, dispatch);
    }

    if ($from.depth === base + 2 && SPLITTABLE_BODY_SLOTS.has($from.parent.type.name)) {
      return splitContainerAtBody(state, dispatch, { mode: 'tag' });
    }

    return false;
  };
}

/**
 * Mod-F7 — same as F7 but produces analytic_unit / analytic instead of
 * card / tag. cite_paragraph and analytic following children get folded
 * into card_body (text preserved, custom type lost) because analytic_unit
 * only allows analytic + (card_body | undertag)*.
 */
export function setAnalytic(): Command {
  return (state, dispatch) => {
    if (!state.selection.empty) {
      return applyStructuralToSelection(state, dispatch, { mode: 'analytic' });
    }
    if (bulkReapplyStructuralOnShadow(state, dispatch, 'analytic')) return true;
    if (bulkReplaceStructuralOnShadow(state, dispatch, { mode: 'analytic' })) return true;
    const $from = state.selection.$from;

    const base = structuralBaseDepth($from);
    if ($from.depth === base + 1) {
      const parent = $from.parent;
      const pname = parent.type.name;
      if (!DOC_LEVEL_CONVERTIBLE.has(pname)) return false;
      if (!dispatch) return true;
      const id = DOC_HEADINGS.has(pname)
        ? ((parent.attrs['id'] as string | null) ?? newHeadingId())
        : newHeadingId();
      const cleanContent = stripPromotionMarksOnFragment(parent.content);
      const analyticNode = schema.nodes['analytic']!.create({ id }, cleanContent);
      const unitNode = schema.nodes['analytic_unit']!.create(null, [analyticNode]);
      const from = $from.before(base + 1);
      const to = $from.after(base + 1);
      let tr = state.tr.replaceWith(from, to, unitNode);
      // parent → analytic_unit@from → analytic@(from+1) → content@(from+2)
      const cursorPos = from + 2 + Math.min($from.parentOffset, parent.content.size);
      tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
      dispatch(tr);
      return true;
    }

    if (
      $from.depth === base + 2 &&
      $from.parent.type.name === 'analytic' &&
      $from.node(base + 1).type.name === 'analytic_unit' &&
      $from.node(base + 1).firstChild === $from.parent
    ) {
      return stripIndentAtDepth(state, dispatch, base + 2);
    }

    if (
      $from.depth === base + 2 &&
      $from.parent.type.name === 'tag' &&
      $from.node(base + 1).type.name === 'card' &&
      $from.node(base + 1).firstChild === $from.parent
    ) {
      return convertCardToAnalyticUnit(state, dispatch);
    }

    if ($from.depth === base + 2 && SPLITTABLE_BODY_SLOTS.has($from.parent.type.name)) {
      return splitContainerAtBody(state, dispatch, { mode: 'analytic' });
    }

    return false;
  };
}

/**
 * Mod-F8 — convert the current paragraph to an undertag.
 *
 * Undertag is a body-level type (no outline level, no id) that's
 * valid both at doc root and inside card / analytic_unit. So unlike
 * setTag/setAnalytic, cursors inside card_body / cite_paragraph
 * stay in place: just the node type changes, the card structure is
 * preserved. Cursors at a tag or analytic anchor still dissolve
 * the surrounding container, since [undertag, …] isn't valid as
 * card / analytic_unit content.
 */
export function setUndertag(): Command {
  return (state, dispatch) => {
    if (!state.selection.empty) {
      return applyStructuralToSelection(state, dispatch, { mode: 'undertag' });
    }
    if (bulkReapplyStructuralOnShadow(state, dispatch, 'undertag')) return true;
    if (bulkReplaceStructuralOnShadow(state, dispatch, { mode: 'undertag' })) return true;
    const $from = state.selection.$from;

    const base = structuralBaseDepth($from);
    if ($from.depth === base + 1) {
      const parent = $from.parent;
      const pname = parent.type.name;
      if (pname === 'undertag') return stripIndentAtDepth(state, dispatch, base + 1);
      if (!DOC_LEVEL_CONVERTIBLE.has(pname)) return false;
      if (!dispatch) return true;
      const tr = state.tr.setNodeMarkup(
        $from.before(base + 1),
        schema.nodes['undertag']!,
        null,
      );
      const contentFrom = $from.before(base + 1) + 1;
      const contentTo = contentFrom + parent.content.size;
      stripPromotionMarksOnTr(tr, contentFrom, contentTo);
      dispatch(tr.scrollIntoView());
      return true;
    }

    if ($from.depth === base + 2) {
      const pname = $from.parent.type.name;
      if (pname === 'undertag') return stripIndentAtDepth(state, dispatch, base + 2);
      if (pname === 'card_body' || pname === 'cite_paragraph') {
        if (!dispatch) return true;
        const parent = $from.parent;
        const tr = state.tr.setNodeMarkup(
          $from.before(base + 2),
          schema.nodes['undertag']!,
          null,
        );
        const contentFrom = $from.before(base + 2) + 1;
        const contentTo = contentFrom + parent.content.size;
        stripPromotionMarksOnTr(tr, contentFrom, contentTo);
        dispatch(tr.scrollIntoView());
        return true;
      }
      if (pname === 'tag' || pname === 'analytic') {
        return dissolveContainerToUndertag(state, dispatch);
      }
    }

    return false;
  };
}

function dissolveContainerToUndertag(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
): boolean {
  const $from = state.selection.$from;
  const base = structuralBaseDepth($from);
  const head = $from.parent;
  const container = $from.node(base + 1);
  if (container.firstChild !== head) return false;
  if (container.type.name === 'card' && head.type.name !== 'tag') return false;
  if (container.type.name === 'analytic_unit' && head.type.name !== 'analytic') return false;
  if (!dispatch) return true;

  const undertagNode = schema.nodes['undertag']!.create(
    null,
    stripPromotionMarksOnFragment(head.content),
  );
  const nonHeadChildren: PMNode[] = [];
  container.forEach((child, _offset, index) => {
    if (index === 0) return;
    nonHeadChildren.push(child);
  });

  const containerStart = $from.before(base + 1);
  const containerEnd = $from.after(base + 1);

  // If the previous sibling (in the doc or the enclosing zone) is the same
  // container type, absorb [undertag, ...non-head children] into it. Card and
  // analytic_unit both accept undertag in their content, and the non-head
  // children are already valid content, so no per-child rewriting is needed.
  const containerIndex = $from.index(base);
  if (containerIndex > 0) {
    const prev = $from.node(base).child(containerIndex - 1);
    if (prev.type.name === container.type.name) {
      const prevStart = containerStart - prev.nodeSize;
      const newPrev = prev.copy(
        prev.content.append(Fragment.fromArray([undertagNode, ...nonHeadChildren])),
      );
      let tr = state.tr.replaceWith(prevStart, containerEnd, newPrev);
      const cursorPos =
        prevStart + 1 + prev.content.size + 1 +
        Math.min($from.parentOffset, head.content.size);
      tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
      dispatch(tr.scrollIntoView());
      return true;
    }
  }

  const lifted: PMNode[] = [undertagNode, ...nonHeadChildren.map(liftCardChild)];
  let tr = state.tr.replaceWith(
    containerStart,
    containerEnd,
    Fragment.fromArray(lifted),
  );
  const cursorPos = containerStart + 1 + Math.min($from.parentOffset, head.content.size);
  tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
  dispatch(tr.scrollIntoView());
  return true;
}

/** Pure node transform: a `card` → the equivalent `analytic_unit`. Tag →
 *  analytic is a same-tier swap (same structural role, just cite/analytic
 *  semantic) so direct formatting on the head is preserved; the card's body
 *  slots map into valid analytic_unit content via `toAnalyticUnitChild`.
 *  Shared by the cursor command and the shadow bulk-replace so both keep the
 *  container intact (rather than dissolving it). */
function cardToAnalyticUnitNode(card: PMNode): PMNode {
  const tag = card.firstChild!;
  const id = (tag.attrs['id'] as string | null) ?? newHeadingId();
  const analyticNode = schema.nodes['analytic']!.create({ id }, tag.content);
  const rest: PMNode[] = [];
  card.forEach((child, _offset, index) => {
    if (index === 0) return;
    rest.push(toAnalyticUnitChild(child));
  });
  // Carry the numbering skeleton (numRole/numRestart) across the swap —
  // card and analytic_unit share the same attr set, and a tag↔analytic
  // restyle must not silently strip a card's number (field bug 2026-07-15).
  return schema.nodes['analytic_unit']!.create(card.attrs, [analyticNode, ...rest]);
}

function convertCardToAnalyticUnit(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
): boolean {
  const $from = state.selection.$from;
  const base = structuralBaseDepth($from);
  const tag = $from.parent;
  const card = $from.node(base + 1);
  if (!dispatch) return true;

  const unitNode = cardToAnalyticUnitNode(card);

  const from = $from.before(base + 1);
  const to = $from.after(base + 1);
  let tr = state.tr.replaceWith(from, to, unitNode);
  const cursorPos = from + 2 + Math.min($from.parentOffset, tag.content.size);
  tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
  dispatch(tr);
  return true;
}

function toAnalyticUnitChild(child: PMNode): PMNode {
  const t = child.type.name;
  if (t === 'card_body' || t === 'undertag' || t === 'cite_paragraph') return child;
  // analytic_unit content = analytic (card_body | undertag | cite_paragraph)*;
  // a stray analytic (from a card's cite-slot) folds into card_body so
  // the text comes along.
  return schema.nodes['card_body']!.create(null, child.content);
}

type SplitMode =
  | { mode: 'heading'; headingType: HeadingTypeName }
  | { mode: 'tag' }
  | { mode: 'analytic' };

function splitContainerAtBody(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  opts: SplitMode,
): boolean {
  const $from = state.selection.$from;
  const base = structuralBaseDepth($from);
  const cursorBody = $from.parent;
  if (!SPLITTABLE_BODY_SLOTS.has(cursorBody.type.name)) return false;
  const container = $from.node(base + 1);
  const containerName = container.type.name;
  if (containerName !== 'card' && containerName !== 'analytic_unit') return false;

  let cursorIndex = -1;
  container.forEach((child, _offset, index) => {
    if (cursorIndex === -1 && child === cursorBody) cursorIndex = index;
  });
  if (cursorIndex < 1) return false;

  if (!dispatch) return true;

  const beforeChildren: PMNode[] = [];
  const followingChildren: PMNode[] = [];
  container.forEach((child, _offset, index) => {
    if (index < cursorIndex) beforeChildren.push(child);
    else if (index > cursorIndex) followingChildren.push(child);
  });
  const beforeContainer = container.copy(Fragment.fromArray(beforeChildren));

  let liftedNodes: PMNode[];
  let insideOffset: number;
  const cleanHeadContent = stripPromotionMarksOnFragment(cursorBody.content);
  if (opts.mode === 'heading') {
    const headingType = schema.nodes[opts.headingType]!;
    const newHead = headingType.create({ id: newHeadingId() }, cleanHeadContent);
    const followingLifted = followingChildren.map(liftCardChild);
    liftedNodes = [newHead, ...followingLifted];
    insideOffset = 1;
  } else if (opts.mode === 'tag') {
    const tagNode = schema.nodes['tag']!.create({ id: newHeadingId() }, cleanHeadContent);
    // following children are already valid card content (card_body /
    // undertag / cite_paragraph / analytic), so pass through unchanged.
    const newCard = schema.nodes['card']!.create(null, [tagNode, ...followingChildren]);
    liftedNodes = [newCard];
    insideOffset = 2;
  } else {
    const analyticNode = schema.nodes['analytic']!.create({ id: newHeadingId() }, cleanHeadContent);
    const followingForUnit = followingChildren.map(toAnalyticUnitChild);
    const newUnit = schema.nodes['analytic_unit']!.create(null, [analyticNode, ...followingForUnit]);
    liftedNodes = [newUnit];
    insideOffset = 2;
  }

  const containerFrom = $from.before(base + 1);
  const containerTo = $from.after(base + 1);

  // Zone bottom edge → break OUT: `beforeContainer` stays inside the zone, and
  // the lifted new head/card lands AFTER the zone (outside), cutting off the
  // section. (Anywhere else in the zone, it stays in — the branch below.)
  if (isZoneBottomBreakout($from, base)) {
    const zoneAfter = $from.after(base);
    let tr = state.tr.replaceWith(containerFrom, containerTo, beforeContainer);
    const insertPos = tr.mapping.map(zoneAfter);
    tr = tr.insert(insertPos, Fragment.fromArray(liftedNodes));
    const cursorPos =
      insertPos + insideOffset + Math.min($from.parentOffset, cursorBody.content.size);
    tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
    dispatch(tr.scrollIntoView());
    return true;
  }

  const replacement = Fragment.fromArray([beforeContainer, ...liftedNodes]);
  let tr = state.tr.replaceWith(containerFrom, containerTo, replacement);

  const cursorPos =
    containerFrom + beforeContainer.nodeSize + insideOffset +
    Math.min($from.parentOffset, cursorBody.content.size);
  tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
  dispatch(tr);
  return true;
}

function dissolveContainerToHeading(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  typeName: HeadingTypeName,
): boolean {
  const $from = state.selection.$from;
  const base = structuralBaseDepth($from);
  const head = $from.parent;
  const container = $from.node(base + 1);
  // Only dissolve when the head is the container's required anchor.
  if (container.firstChild !== head) return false;
  if (container.type.name === 'card' && head.type.name !== 'tag') return false;
  if (container.type.name === 'analytic_unit' && head.type.name !== 'analytic') return false;

  if (!dispatch) return true;

  const id = (head.attrs['id'] as string | null) ?? newHeadingId();
  const newHeading = schema.nodes[typeName]!.create(
    { id },
    stripPromotionMarksOnFragment(head.content),
  );

  const lifted: PMNode[] = [newHeading];
  container.forEach((child, _offset, index) => {
    if (index === 0) return;
    lifted.push(liftCardChild(child));
  });

  const from = $from.before(base + 1);
  const to = $from.after(base + 1);
  let tr = state.tr.replaceWith(from, to, Fragment.fromArray(lifted));
  const cursorPos = from + 1 + Math.min($from.parentOffset, head.content.size);
  tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
  dispatch(tr.scrollIntoView());
  return true;
}

/**
 * F8 / F10 — apply a body-only named-style mark (`cite_mark` /
 * `emphasis_mark`) to text in the selection. Both share the same
 * shape: structural textblocks (tag / analytic / pocket / hat / block)
 * and undertags are skipped, so a selection that spans them only marks
 * the body portions and the structural slots are left untouched.
 *
 * A collapsed selection expands to the word at the cursor (no-op when
 * there is no word to act on).
 *
 * Apply-only (not toggle): re-running on the same range is idempotent.
 * Schema `excludes` on these marks auto-strips conflicting
 * cite/underline/emphasis in the range when `tr.addMark` is called.
 */
const NAMED_STYLE_SKIP_BLOCKS = new Set(['tag', 'analytic', 'pocket', 'hat', 'block', 'undertag']);

/**
 * Word at the (collapsed) cursor — "continuous text uninterrupted by
 * whitespace" within the cursor's textblock. Returns null if the
 * selection isn't collapsed, the cursor isn't in a textblock, or the
 * cursor sits at a whitespace position with whitespace on both sides
 * (no word to act on).
 *
 * Inline leaves (images, etc.) count as word boundaries — a word
 * can't span a non-text inline node. Mark boundaries are *not* word
 * boundaries: "plain" + "bold" with no space between produces the
 * single word "plainbold" even though they're two text nodes.
 */
function wordRangeAtCursor(state: EditorState): { from: number; to: number } | null {
  const sel = state.selection;
  if (!sel.empty) return null;
  const $from = sel.$from;
  const parent = $from.parent;
  if (!parent.isTextblock) return null;
  const size = parent.content.size;
  if (size === 0) return null;

  // Per-position word-class map for the textblock. Inline leaves
  // (images, etc.) get a sentinel slot that the classifier reads
  // as non-word ('\0' classifies as 'punct'), which correctly
  // ends the word at the leaf boundary. Text node characters
  // classify via the spec's iterator (`isWordChar` from
  // `word-break.ts`) — letters, digits, U+0027, U+2019. Notably
  // `.` / `,` / `_` / hyphen / dash family / U+2018 are NOT word
  // characters under the spec, so `U.S.A.` is three words and
  // `user_name` is two.
  const chars = new Array<string>(size);
  let p = 0;
  parent.forEach((child) => {
    if (child.isText) {
      const t = child.text ?? '';
      for (let i = 0; i < t.length; i++) {
        chars[p + i] = t[i] ?? '\0';
      }
      p += t.length;
    } else {
      for (let i = 0; i < child.nodeSize; i++) {
        chars[p + i] = '\0';
      }
      p += child.nodeSize;
    }
  });
  const isW = (i: number): boolean => isWordChar(chars[i] ?? '\0');

  const offset = $from.parentOffset;
  let left = offset;
  while (left > 0 && isW(left - 1)) left--;
  let right = offset;
  while (right < size && isW(right)) right++;
  if (left === right) return null;

  const tbStart = $from.start();
  return { from: tbStart + left, to: tbStart + right };
}

/** Layer 3 formatting trim — strip ONE trailing space character
 *  from the end of each range, UNLESS the range minus that
 *  trailing space is entirely whitespace. The trim un-does Word-
 *  unit absorption (double-click and `Ctrl-Shift-Right` each pull
 *  a single trailing space onto the right edge of the selection);
 *  it must NOT also block the user from deliberately formatting a
 *  whitespace-only selection — e.g., shift-arrowing across a
 *  single space they want highlighted.
 *
 *  Single-char trim: a multi-unit selection like `word word word `
 *  loses the final space but keeps its internal spaces formatted.
 *  Selecting just ` ` (a single space) or `   ` (whitespace only)
 *  is left intact so the format applies to the whole range.
 *  Layer 3 of the word-selection model (see `word-break.ts`). */
function trimRangesForFormatting(
  doc: PMNode,
  ranges: { from: number; to: number }[],
): { from: number; to: number }[] {
  return ranges.map(({ from, to }) => {
    if (from >= to) return { from, to };
    let last: string;
    try {
      last = doc.textBetween(to - 1, to);
    } catch {
      return { from, to };
    }
    if (last.length === 0) return { from, to };
    if (classifyChar(last) !== 'space') return { from, to };
    if (!hasNonSpaceChar(doc, from, to - 1)) return { from, to };
    return { from, to: to - 1 };
  });
}

/** True iff `[from, to)` contains at least one text character
 *  that doesn't classify as `'space'`. Walks text leaves; ignores
 *  block boundaries and non-text leaves. Used by the formatting
 *  trim to decide whether shaving the trailing space would leave
 *  any "real" content behind. */
function hasNonSpaceChar(doc: PMNode, from: number, to: number): boolean {
  if (from >= to) return false;
  let found = false;
  doc.nodesBetween(from, to, (node, pos) => {
    if (found) return false;
    if (!node.isText) return true;
    const text = node.text ?? '';
    const localStart = Math.max(0, from - pos);
    const localEnd = Math.min(text.length, to - pos);
    for (let i = localStart; i < localEnd; i++) {
      if (classifyChar(text[i] ?? '') !== 'space') {
        found = true;
        return false;
      }
    }
    return false;
  });
  return found;
}

/** Drop-in for `getOperatingRanges` in formatting-command sites:
 *  identical return shape, but ranges have their trailing space
 *  trimmed per Layer 3. Use the bare `getOperatingRanges` for any
 *  consumer that should see the user's selection unmodified. */
function getOperatingRangesForFormatting(
  state: EditorState,
): { ranges: { from: number; to: number }[]; fromShadow: boolean } {
  const op = getOperatingRanges(state);
  if (op.ranges.length === 0) return op;
  // Layer 3 exists to un-do word-unit absorption in USER selections
  // (double-click pulls one trailing space onto the edge). Shadow
  // ranges come from text-RUN boundaries — nothing was absorbed, and
  // trimming each of N matched runs would leave N run-final spaces
  // out of scope (e.g. Select Similar → F12 skipping every run's
  // trailing space).
  if (op.fromShadow) return op;
  return {
    ranges: trimRangesForFormatting(state.doc, op.ranges),
    fromShadow: op.fromShadow,
  };
}

function applyBodyMark(
  markName: 'cite_mark' | 'emphasis_mark',
  opts: { expandToWordWhenEmpty?: boolean } = {},
): Command {
  return withGapFix((state, dispatch) => {
    const markType = schema.marks[markName];
    if (!markType) return false;

    // Operating ranges: PM selection if non-empty, otherwise the
    // shadow-selection matches if any are active, otherwise the
    // word at the cursor (when the command opts in via
    // `expandToWordWhenEmpty`).
    const op = getOperatingRangesForFormatting(state);
    let opRanges = op.ranges;
    if (opRanges.length === 0) {
      if (!opts.expandToWordWhenEmpty) return false;
      const word = wordRangeAtCursor(state);
      if (!word) return false;
      opRanges = [word];
    }

    // Collect per-textblock ranges; structural-block skip is enforced
    // by the nodesBetween callback (a touched tag / undertag yields
    // no range and contributes nothing).
    const ranges: { from: number; to: number }[] = [];
    for (const { from, to } of opRanges) {
      state.doc.nodesBetween(from, to, (node, pos) => {
        if (!node.isTextblock) return true;
        if (NAMED_STYLE_SKIP_BLOCKS.has(node.type.name)) return false;
        const tbStart = pos + 1;
        const tbEnd = pos + node.nodeSize - 1;
        const applyFrom = Math.max(tbStart, from);
        const applyTo = Math.min(tbEnd, to);
        if (applyFrom < applyTo) ranges.push({ from: applyFrom, to: applyTo });
        return false;
      });
    }
    if (ranges.length === 0) return false;
    if (!dispatch) return true;

    const tr = state.tr;
    const mark = markType.create();
    for (const r of ranges) {
      tr.addMark(r.from, r.to, mark);
      // One-directional apply: direct overrides (font_size, bold,
      // etc.) clear; highlight survives, shading strips — see
      // `APPLY_DIRECT_FORMATTING_STRIP_NAMES` for the rationale.
      stripDirectFormattingOnApply(tr, r.from, r.to);
    }
    if (op.fromShadow) tr.setMeta(META_OPERATING_ON_SHADOW, true);
    dispatch(tr);
    return true;
  }, { appliesNamedStyle: true });
}

export function applyCite(): Command {
  return applyBodyMark('cite_mark', { expandToWordWhenEmpty: true });
}

export function applyEmphasis(): Command {
  return applyBodyMark('emphasis_mark', { expandToWordWhenEmpty: true });
}

/**
 * Shared walk for the acronym commands. Expands the selection to
 * whole-word boundaries per textblock and returns the ranges to mark:
 *
 *   - When the (expanded) selection lives in a SINGLE textblock and
 *     its text matches an entry in the custom acronym table
 *     (Settings → Editing → Acronym marking, case-insensitive), the
 *     ranges are the user-picked character offsets — so "weapons of
 *     mass destruction" can mark just w/m/d and read as "WMD".
 *   - Otherwise, the first character of each word — a word being a
 *     maximal run of word-class characters per `word-break.ts`
 *     (inline leaves and block boundaries break words; mark
 *     boundaries don't; `U.S.A.` is three one-letter words).
 *
 * `skipBlocks` applies the `NAMED_STYLE_SKIP_BLOCKS` gate (body-text
 * marks skip structural textblocks; highlight doesn't).
 */
function acronymTargetRanges(
  state: EditorState,
  skipBlocks: boolean,
): { from: number; to: number }[] {
  const sel = state.selection;
  interface BlockInfo {
    tbStart: number;
    expFrom: number;
    text: string; // expanded-range text; inline leaves as '\0'
    firstLetters: { from: number; to: number }[];
  }
  const blocks: BlockInfo[] = [];

  state.doc.nodesBetween(sel.from, sel.to, (node, pos) => {
    if (!node.isTextblock) return true;
    if (skipBlocks && NAMED_STYLE_SKIP_BLOCKS.has(node.type.name)) return false;

    const tbStart = pos + 1;
    const size = node.content.size;
    if (size === 0) return false;

    // Per-position word-class map and character image for THIS
    // textblock. `isW[i]` is true iff the char at slot `i` classifies
    // as a word-character (`isWordChar`); inline leaves get '\0',
    // which is non-word and ends any in-progress word.
    const isW = new Array<boolean>(size);
    const chars = new Array<string>(size);
    let p = 0;
    node.forEach((child) => {
      if (child.isText) {
        const t = child.text ?? '';
        for (let i = 0; i < t.length; i++) {
          const ch = t[i] ?? '\0';
          isW[p + i] = isWordChar(ch);
          chars[p + i] = ch;
        }
        p += t.length;
      } else {
        for (let i = 0; i < child.nodeSize; i++) {
          isW[p + i] = false;
          chars[p + i] = '\0';
        }
        p += child.nodeSize;
      }
    });

    // Selection-clip range in textblock-local coords.
    const localFrom = Math.max(0, sel.from - tbStart);
    const localTo = Math.min(size, sel.to - tbStart);
    if (localFrom >= localTo) return false;

    // A word is "partially selected" iff at least one of its
    // word-class characters falls inside the selection.
    let leftW = -1;
    let rightW = -1;
    for (let i = localFrom; i < localTo; i++) {
      if (isW[i] === true) {
        if (leftW < 0) leftW = i;
        rightW = i;
      }
    }
    if (leftW < 0) return false;

    // Expand to whole-word boundaries — the smallest contiguous range
    // fully covering every partially-selected word.
    let expFrom = leftW;
    let expTo = rightW + 1;
    while (expFrom > 0 && isW[expFrom - 1] === true) expFrom--;
    while (expTo < size && isW[expTo] === true) expTo++;

    // First character of each word in the expanded range.
    const firstLetters: { from: number; to: number }[] = [];
    let inWord = false;
    for (let i = expFrom; i < expTo; i++) {
      const isWord = isW[i] === true;
      if (isWord && !inWord) {
        firstLetters.push({ from: tbStart + i, to: tbStart + i + 1 });
        inWord = true;
      } else if (!isWord) {
        inWord = false;
      }
    }
    blocks.push({
      tbStart,
      expFrom,
      text: chars.slice(expFrom, expTo).join(''),
      firstLetters,
    });
    // Stop descent; the whole textblock is processed.
    return false;
  });

  // Custom table lookup — single-textblock selections only (phrases
  // don't span paragraphs; multi-block selections keep the classic
  // per-word behavior).
  if (blocks.length === 1) {
    const b = blocks[0]!;
    const hit = matchAcronymPattern(b.text, settings.get('acronymPatterns'));
    if (hit) {
      return hit.chars
        .filter((c) => c < b.text.length && b.text[c] !== '\0')
        .map((c) => ({
          from: b.tbStart + b.expFrom + c,
          to: b.tbStart + b.expFrom + c + 1,
        }));
    }
  }
  return blocks.flatMap((b) => b.firstLetters);
}

/**
 * Alt-F10 — apply `emphasis_mark` to the acronym target letters of
 * the selection: the custom-table characters when the selection
 * matches a configured phrase, else the first character of each word
 * (select "United States Capitol Police" and "U", "S", "C", "P" get
 * emphasized). See `acronymTargetRanges` for the walk contract.
 *
 * No-op on empty selection — no "emphasize the word at the cursor"
 * fallback like `applyEmphasis` has.
 *
 * Structural blocks (tag / undertag / pocket / hat / block /
 * analytic) are skipped — `emphasis_mark` is a body-text mark
 * (same skip rule as `applyEmphasis`). Each marked character also
 * gets the same direct-formatting stripping `applyEmphasis` does.
 */
export function emphasizeAcronym(): Command {
  return (state, dispatch) => {
    const markType = schema.marks['emphasis_mark'];
    if (!markType) return false;
    if (state.selection.empty) return false;

    const ranges = acronymTargetRanges(state, true);
    if (ranges.length === 0) return false;
    if (!dispatch) return true;

    const tr = state.tr;
    const mark = markType.create();
    for (const r of ranges) {
      tr.addMark(r.from, r.to, mark);
      // Same one-directional-apply semantics as `applyBodyMark`:
      // direct overrides clear; highlight survives, shading strips.
      stripDirectFormattingOnApply(tr, r.from, r.to);
    }
    dispatch(tr);
    return true;
  };
}

/**
 * Underline Acronym — `underline_mark` on the acronym target letters,
 * completing the emphasize / highlight / underline trio. Same
 * contract as `emphasizeAcronym` (body-text named style: structural
 * blocks skipped, direct formatting stripped on apply); unbound by
 * default.
 */
export function underlineAcronym(): Command {
  return (state, dispatch) => {
    const markType = schema.marks['underline_mark'];
    if (!markType) return false;
    if (state.selection.empty) return false;

    const ranges = acronymTargetRanges(state, true);
    if (ranges.length === 0) return false;
    if (!dispatch) return true;

    const tr = state.tr;
    const mark = markType.create();
    for (const r of ranges) {
      tr.addMark(r.from, r.to, mark);
      stripDirectFormattingOnApply(tr, r.from, r.to);
    }
    dispatch(tr);
    return true;
  };
}

/**
 * Alt-F11 — apply the active `highlight` color to the acronym target
 * letters of the selection (custom-table characters on a phrase
 * match, else each word's first letter — select "United States
 * Capitol Police" and `U / S / C / P` carry the active highlight).
 *
 * Differences from `emphasizeAcronym`, parallel to the differences
 * between `applyHighlight` and `applyEmphasis`:
 *   - No structural-block skip — highlight is a runtime annotation,
 *     not a named style, and F11 itself works in tags / analytics.
 *   - No direct-formatting strip — highlight is additive; nothing
 *     about the marked character's other formatting should change.
 *
 * No-op on empty selection (matches the emphasize-acronym contract
 * — no "highlight the word at the cursor" fallback).
 */
export function highlightAcronym(activeColor: () => string | null): Command {
  return (state, dispatch) => {
    const markType = schema.marks['highlight'];
    if (!markType) return false;
    if (state.selection.empty) return false;

    const ranges = acronymTargetRanges(state, false);
    if (ranges.length === 0) return false;
    if (!dispatch) return true;

    const tr = state.tr;
    const color = activeColor();
    for (const r of ranges) {
      // Replace any existing highlight color on this character so
      // the new acronym mark wins (parallel to applyHighlight's
      // remove-then-add for the "apply" branch). A null pen ("No
      // highlight") strips the target letters instead.
      tr.removeMark(r.from, r.to, markType);
      if (color !== null) tr.addMark(r.from, r.to, markType.create({ color }));
    }
    dispatch(tr);
    return true;
  };
}

/** Expand `[from, to]` outward to include the word char just past each end
 *  (skipping gap chars first) so the boundary gap between the changed region
 *  and its neighbor word is in scope — but no further, so unrelated gaps
 *  elsewhere in the paragraph aren't touched. Bounded to the textblock. */
function expandToAdjacentBookends(
  doc: PMNode,
  from: number,
  to: number,
): { from: number; to: number } {
  const isGap = (pos: number): boolean => {
    const ch = doc.textBetween(pos, pos + 1);
    return isGapChar(ch);
  };
  const tbStart = doc.resolve(from).start();
  let eFrom = from;
  while (eFrom > tbStart && isGap(eFrom - 1)) eFrom--;
  if (eFrom > tbStart) eFrom--; // include the left bookend word char
  const tbEnd = doc.resolve(to).end();
  let eTo = to;
  while (eTo < tbEnd && isGap(eTo)) eTo++;
  if (eTo < tbEnd) eTo++; // include the right bookend word char
  return { from: eFrom, to: eTo };
}

/** Clip a gap's normalization range so explicitly-selected trailing/leading
 *  PUNCTUATION survives as the command set it. A gap char inside the operating
 *  range `r` that is punctuation was deliberately selected — selecting
 *  "government." (with the period) and pressing F9 means the period takes the
 *  style, even though it's a gap char between "government" and the next word. So
 *  the gap-fix must not strip it. Whitespace is NOT protected: a selected
 *  trailing space is still normalized away, matching the Layer-3 trim's
 *  space-only policy ("government. " → underline the period, not the space).
 *  Punctuation outside `r` stays a normal gap char (so an unselected "." still
 *  bridges/strips). Returns the sub-range of `[gapFrom, gapTo)` the gap-fix may
 *  touch — empty (from === to) when the whole gap is protected. */
function gapModRange(
  doc: PMNode,
  gapFrom: number,
  gapTo: number,
  r: { from: number; to: number },
): { from: number; to: number } {
  const inSel = (pos: number): boolean => pos >= r.from && pos < r.to;
  const isPunct = (pos: number): boolean =>
    classifyChar(doc.textBetween(pos, pos + 1)) === 'punct';
  let from = gapFrom;
  while (from < gapTo && inSel(from) && isPunct(from)) from++;
  let to = gapTo;
  while (to > from && inSel(to - 1) && isPunct(to - 1)) to--;
  return { from, to };
}

/** Whether EVERY text node in `[from, to)` carries `type`. Unlike PM's
 *  `rangeHasMark` (true if the mark occurs ANYWHERE in the range), this is the
 *  "throughout" test — used to tell a continuously-styled gap from one that's
 *  only partly styled. Empty range → false. */
function rangeFullyHasMark(
  doc: PMNode,
  from: number,
  to: number,
  type: MarkType,
): boolean {
  if (to <= from) return false;
  let full = true;
  doc.nodesBetween(from, to, (node) => {
    if (node.isText && !type.isInSet(node.marks)) full = false;
    return full;
  });
  return full;
}

/** Normalize ONE gap across ALL formatting families to the value its bookends
 *  imply — bridge a mark both carry, strip one the bookends don't agree on.
 *  Used by the per-apply wrapper (`withGapFix`), which calls it only on the
 *  EDGE gaps of a changed range.
 *
 *  The underline/emphasis "named-style" family has two bridging rules, chosen
 *  by `appliesNamedStyle` — true only when the command that ran actually
 *  toggles that family (underline / emphasis / cite):
 *    - appliesNamedStyle = true: underline AND emphasis are one family —
 *      both bookends carrying either (incl. emphasis+emphasis) → the gap fills
 *      with UNDERLINE, so an emphasized selection's edges join an emphasized
 *      neighbor with underline (the continuous read-aloud marker).
 *    - appliesNamedStyle = false: the command was an UNRELATED family
 *      (highlight / shading / font_size), so the named-style family is left
 *      UNTOUCHED — whatever underline / emphasis / cite the gap already carries
 *      is the deliberate result of an earlier apply, and an unrelated command
 *      never changes it. (Rewriting it from the bookends instead would both
 *      break emphasis on a continuous emphasized phrase AND rewrite an underlined
 *      emphasis-join to emphasis the moment you highlight either side.)
 *  `effectivePt` omitted → `font_size` is left alone (no size resolver).
 *
 *  The bookends come from `hit`, but the actual mark mutations are confined to
 *  `[modFrom, modTo)` — the part of the gap the caller permits us to touch
 *  (`gapModRange` shaves off explicitly-selected punctuation). The bookend
 *  decision is unchanged; only the written span narrows. */
function applyFullGapTarget(
  tr: Transaction,
  hit: GapHit,
  modFrom: number,
  modTo: number,
  appliesNamedStyle: boolean,
  effectivePt?: (node: PMNode | null, parent: PMNode) => number,
): void {
  if (modFrom >= modTo) return;
  const { firstNode, lastNode, parent } = hit;
  const um = schema.marks['underline_mark']!;
  const ud = schema.marks['underline_direct']!;
  const emphasisType = schema.marks['emphasis_mark']!;
  const citeType = schema.marks['cite_mark']!;
  const highlightType = schema.marks['highlight']!;
  const shadingType = schema.marks['shading']!;
  const fontSizeType = schema.marks['font_size']!;
  const fm = firstNode.marks;
  const lm = lastNode.marks;
  const has = (marks: readonly Mark[], t: MarkType): boolean =>
    marks.some((mk) => mk.type === t);

  const marksToAdd: Mark[] = [];
  const marksToRemove: MarkType[] = [];

  // Named-style family (underline / emphasis / cite). ONLY normalized
  // when the command that ran actually toggles this family
  // (appliesNamedStyle). For an UNRELATED command (highlight / shading /
  // font_size) it's left completely ALONE — whatever the gap already
  // carries is the deliberate result of an earlier named-style apply
  // (e.g. the underlined read-aloud join between two emphasized words).
  // Rewriting it from the bookends would see emphasis on both sides of
  // `E <underline> E` and turn the underlined join into EMPHASIS.
  if (appliesNamedStyle) {
    const fmU = has(fm, um) || has(fm, ud);
    const lmU = has(lm, um) || has(lm, ud);
    const fmE = has(fm, emphasisType);
    const lmE = has(lm, emphasisType);
    const fmC = has(fm, citeType);
    const lmC = has(lm, citeType);
    // Underline and emphasis are one "underline family": whenever BOTH bookends
    // carry one of them (underline both sides, emphasis both sides, OR mixed) the
    // gap fills with UNDERLINE — two emphasized words joined by underline, the
    // continuous read-aloud marker. EXCEPT when the gap is ALREADY a continuous
    // emphasized phrase (bookends and gap all emphasized): re-applying emphasis
    // to part of it must not punch underlined holes at the sub-span's edges, so
    // keep the emphasis. (The command marks only the operating word, so `tr.doc`
    // at the flanking gap still reflects its pre-command state.)
    let named: 'underline' | 'emphasis' | 'cite' | null = null;
    if (fmE && lmE && rangeFullyHasMark(tr.doc, modFrom, modTo, emphasisType))
      named = 'emphasis';
    else if ((fmU || fmE) && (lmU || lmE)) named = 'underline';
    else if (fmC && lmC) named = 'cite';

    if (named === 'underline') {
      const structural = STRUCTURAL_TEXTBLOCKS_FOR_UNDERLINE.has(parent.type.name);
      marksToAdd.push((structural ? ud : um).create());
      marksToRemove.push(structural ? um : ud, emphasisType, citeType);
    } else if (named === 'emphasis') {
      // `excludes` strips underline_mark / cite automatically; underline_direct
      // has no excludes, so strip it explicitly.
      marksToAdd.push(emphasisType.create());
      marksToRemove.push(ud);
    } else if (named === 'cite') {
      marksToAdd.push(citeType.create());
      marksToRemove.push(ud);
    } else {
      marksToRemove.push(um, ud, emphasisType, citeType);
    }
  }

  // highlight / shading: bridge when both carry it (first color wins), else strip.
  const fmHl = fm.find((mk) => mk.type === highlightType);
  const lmHl = lm.find((mk) => mk.type === highlightType);
  if (fmHl && lmHl) marksToAdd.push(highlightType.create(fmHl.attrs));
  else marksToRemove.push(highlightType);
  const fmSh = fm.find((mk) => mk.type === shadingType);
  const lmSh = lm.find((mk) => mk.type === shadingType);
  if (fmSh && lmSh) marksToAdd.push(shadingType.create(fmSh.attrs));
  else marksToRemove.push(shadingType);

  // font_size: bridge the smaller-effective-pt bookend's explicit mark.
  if (effectivePt) {
    const fmFs = fm.find((mk) => mk.type === fontSizeType);
    const lmFs = lm.find((mk) => mk.type === fontSizeType);
    const fmEpt = effectivePt(firstNode, parent);
    const lmEpt = effectivePt(lastNode, parent);
    let targetFs: Mark | null = null;
    if (fmEpt < lmEpt) {
      if (fmFs) targetFs = fmFs;
    } else if (lmEpt < fmEpt) {
      if (lmFs) targetFs = lmFs;
    } else if (fmFs && lmFs) {
      targetFs = fmFs;
    }
    if (targetFs) marksToAdd.push(fontSizeType.create(targetFs.attrs));
    else marksToRemove.push(fontSizeType);
  }

  for (const mt of marksToRemove) tr.removeMark(modFrom, modTo, mt);
  for (const mk of marksToAdd) tr.addMark(modFrom, modTo, mk);
}

/** Wrap a formatting Command so that, after it runs, the gaps around what it
 *  changed are normalized the same way the manual Fix Formatting Gaps command
 *  does — the FULL pass over every formatting family, not just the one the
 *  user pressed: bridge a style across gaps both new neighbors share, strip a
 *  style the bookends don't agree on. Runs in the command's OWN transaction
 *  (one undo step); reads the changed ranges from its mark steps (positions
 *  are stable across mark steps). `effectivePt` enables font_size normalization
 *  (passed by the size commands). `appliesNamedStyle` marks commands that
 *  toggle the underline/emphasis/cite family — only those let an emphasized
 *  edge gap fill with underline; for everything else (highlight / shading /
 *  font_size) the named-style family is preserved (see `applyFullGapTarget`). */
function withGapFix(
  command: Command,
  opts: {
    effectivePt?: (node: PMNode | null, parent: PMNode) => number;
    appliesNamedStyle?: boolean;
  } = {},
): Command {
  const { effectivePt, appliesNamedStyle = false } = opts;
  return (state, dispatch, view) => {
    if (!dispatch) return command(state, undefined, view);
    // The authoritative edges are the edges of the user's OPERATING ranges
    // (their selection / shadow ranges / word-at-cursor), computed the same
    // way the wrapped commands do — NOT the mark steps. A mixed-format
    // selection produces mark steps whose edges land on INTERNAL seams (e.g.
    // `addMark` skips an already-styled part, and an excluded-mark removal
    // becomes its own step), so step edges would wrongly trigger the merge at
    // those seams. The operating range spans the whole selection, so its only
    // edges are the true outer ones. (Mark steps don't move positions, so
    // ranges from the pre-command state stay valid in the resulting doc.)
    let opRanges = getOperatingRangesForFormatting(state).ranges;
    if (opRanges.length === 0) {
      const word = wordRangeAtCursor(state);
      if (word) opRanges = [word];
    }
    let captured: Transaction | null = null;
    const result = command(state, (tr) => { captured = tr; }, view);
    const tr = captured as Transaction | null;
    if (!tr) return result;
    // The auto-bridge is opt-out: when off, run the command unchanged. The
    // manual Fix Formatting Gaps command is unaffected (it never calls this).
    if (!settings.get('autoBridgeFormattingGaps')) {
      dispatch(tr);
      return result;
    }
    for (const r of opRanges) {
      // When the user formatted ONLY gap content — whitespace, punctuation,
      // or a punctuation/whitespace mix, i.e. no actual word character —
      // that's a deliberate choice; honor it. Don't let the gap-fix strip or
      // bridge it even if a flanking word is styled. The cleanup is for gaps
      // left dangling as a side effect of formatting a WORD, not for
      // whitespace/punctuation the user selected directly.
      if (!WORD_CHAR_RE.test(tr.doc.textBetween(r.from, r.to))) continue;
      const span = expandToAdjacentBookends(tr.doc, r.from, r.to);
      forEachGap(tr.doc, span.from, span.to, (hit) => {
        // Only the gaps at the EDGES of the selection get the merge treatment
        // — where it meets an adjacent word. A gap INTERNAL to the selection
        // (both bookends inside it) is part of what the user just styled;
        // leave it as the command set it. So emphasizing a span keeps its
        // internal spaces emphasized rather than converting seams to
        // underline. Internal ⇔ both bookends in r: left bookend at
        // gapFrom-1, right bookend char at gapTo.
        const internal = hit.gapFrom - 1 >= r.from && hit.gapTo < r.to;
        if (internal) return;
        // Shave explicitly-selected trailing/leading punctuation out of the
        // writable span: the user picked it on purpose, so the command's mark
        // stands there. The bookends (hence bridge-vs-strip) are unchanged.
        const mod = gapModRange(tr.doc, hit.gapFrom, hit.gapTo, r);
        applyFullGapTarget(tr, hit, mod.from, mod.to, appliesNamedStyle, effectivePt);
      });
    }
    dispatch(tr);
    return result;
  };
}

/**
 * F9 / Mod-U — toggle Verbatim's "Underline" style on the selection.
 *
 * Two marks back this: `underline_mark` (named-style, used in body
 * textblocks — paragraph / card_body / cite_paragraph) and
 * `underline_direct` (direct formatting, used in structural
 * textblocks — tag / analytic / pocket / hat / block / undertag).
 * "Underlined" for toggle purposes means either mark is present.
 *
 * Empty selection: expand to the word at the cursor — the maximal
 * run of non-whitespace characters within the cursor's textblock —
 * and toggle that. No-op when the cursor is in whitespace, in an
 * empty textblock, or on a non-text leaf (no word to act on). Mark
 * boundaries do NOT break a word: "plain" + "bold" (two text nodes,
 * different marks, no whitespace between) acts as one word.
 *
 * Non-empty selection: walk the selection's text nodes. If every
 * character is already underlined, strip both underline marks
 * across the range. Otherwise, add the appropriate mark per parent
 * textblock type to characters that aren't yet underlined — body
 * gets `underline_mark` (auto-strips conflicting cite_mark and
 * emphasis_mark in that range, per the "body text has one of cite /
 * underline / emphasis" policy), structural gets `underline_direct`
 * (doesn't conflict with anything).
 */
export function applyUnderline(
  clearFormattingOnToggleOff: () => boolean = () => true,
): Command {
  return withGapFix((state, dispatch) => {
    const namedMark = schema.marks['underline_mark']!;
    const directMark = schema.marks['underline_direct']!;

    // Operating ranges: PM selection > shadow ranges > word-at-cursor.
    // A collapsed cursor with NO word (empty block, whitespace) is a
    // deliberate no-op: F9's contract is expand-to-word; arming for
    // typing belongs to Mod-U (toggleUnderlineTyping) alone.
    const op = getOperatingRangesForFormatting(state);
    let opRanges = op.ranges;
    if (opRanges.length === 0) {
      const word = wordRangeAtCursor(state);
      if (!word) return false;
      opRanges = [word];
    }

    // "Already underlined?" check across all operating ranges. If
    // every text char in every range carries one of the two
    // underline marks, the gesture toggles OFF; otherwise it adds.
    let everyUnderlined = true;
    let anyText = false;
    for (const { from, to } of opRanges) {
      const scan = toggleScanRange(state.doc, from, to);
      state.doc.nodesBetween(scan.from, scan.to, (node) => {
        if (!node.isText) return true;
        anyText = true;
        const u = node.marks.some(
          (m) => m.type === namedMark || m.type === directMark,
        );
        if (!u) everyUnderlined = false;
        return true;
      });
    }
    if (!anyText) return false;

    if (!dispatch) return true;

    const tr = state.tr;
    if (everyUnderlined) {
      // Toggle off: strip both underline marks across each range.
      for (const { from, to } of opRanges) {
        tr.removeMark(from, to, namedMark);
        tr.removeMark(from, to, directMark);
        // Verbatim's "press F9 twice clears formatting" — opt-out
        // via setting.
        if (clearFormattingOnToggleOff()) stripDirectFormatting(tr, from, to);
      }
    } else {
      // Toggle on: per-textblock segments across all operating
      // ranges. Body uses underline_mark (named-style with
      // excludes); structural uses underline_direct.
      const segments: { from: number; to: number; structural: boolean }[] = [];
      for (const { from, to } of opRanges) {
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (!node.isTextblock) return true;
          const tbStart = pos + 1;
          const tbEnd = pos + node.nodeSize - 1;
          const f = Math.max(tbStart, from);
          const t = Math.min(tbEnd, to);
          if (f < t) {
            segments.push({
              from: f,
              to: t,
              structural: STRUCTURAL_TEXTBLOCKS_FOR_UNDERLINE.has(node.type.name),
            });
          }
          return false;
        });
      }
      for (const seg of segments) {
        const markType = seg.structural ? directMark : namedMark;
        const otherMark = seg.structural ? namedMark : directMark;
        tr.removeMark(seg.from, seg.to, otherMark);
        tr.addMark(seg.from, seg.to, markType.create());
        stripDirectFormattingOnApply(tr, seg.from, seg.to);
      }
    }
    if (op.fromShadow) tr.setMeta(META_OPERATING_ON_SHADOW, true);
    dispatch(tr);
    return true;
  }, { appliesNamedStyle: true });
}


/**
 * Mod-U — underline. For a real selection (or shadow ranges) it behaves
 * exactly like F9 / `applyUnderline`. The difference is the COLLAPSED-cursor
 * case: where F9 expands to the word at the cursor and underlines it, Mod-U
 * instead toggles a STORED underline mark so the NEXT typed text is
 * underlined — parity with Mod-I (italic) and Mod-B (bold). The stored mark
 * follows the same body-vs-structural rule as everything else:
 * `underline_direct` in structural blocks (tag / analytic / …), the named
 * `underline_mark` style in body text.
 */
export function toggleUnderlineTyping(
  clearFormattingOnToggleOff: () => boolean = () => true,
): Command {
  return (state, dispatch, view) => {
    const op = getOperatingRangesForFormatting(state);
    if (op.ranges.length === 0) {
      const namedMark = schema.marks['underline_mark']!;
      const directMark = schema.marks['underline_direct']!;
      const structural = STRUCTURAL_TEXTBLOCKS_FOR_UNDERLINE.has(
        state.selection.$from.parent.type.name,
      );
      return toggleMark(structural ? directMark : namedMark)(state, dispatch, view);
    }
    return applyUnderline(clearFormattingOnToggleOff)(state, dispatch, view);
  };
}

/**
 * Shadow-aware drop-in replacement for `toggleMark` from
 * `prosemirror-commands`. Falls back to PM's `toggleMark` when the
 * PM selection is non-empty (preserves the standard Word/PM toggle
 * semantic), but when the selection is collapsed AND the shadow
 * selection has matches, toggles the mark across every match in a
 * single transaction.
 */
function shadowAwareToggleMark(markType: MarkType): Command {
  return (state, dispatch, view) => {
    const op = getOperatingRangesForFormatting(state);

    // No operating ranges (empty PM selection, no shadow matches) —
    // defer to PM's storedMarks toggle. This is the cursor-only
    // path where the mark will be applied to the next typed
    // character.
    if (op.ranges.length === 0) {
      return toggleMark(markType)(state, dispatch, view);
    }

    // All-marked test: walk every operating range and decide
    // whether to add (some text char lacks the mark) or remove
    // (every text char already carries it). Matches PM's
    // `toggleMark` decision, generalized to multiple ranges.
    let allMarked = true;
    let anyText = false;
    for (const { from, to } of op.ranges) {
      state.doc.nodesBetween(from, to, (node) => {
        if (!node.isText) return true;
        anyText = true;
        if (!node.marks.some((m) => m.type === markType)) allMarked = false;
        return true;
      });
    }
    if (!anyText) return false;
    if (!dispatch) return true;

    // Unified add / remove across every operating range — the
    // ranges already have Layer 3's trailing-space trim baked in
    // (via `getOperatingRangesForFormatting`), so a double-
    // clicked `word ` only bolds the word, not the absorbed
    // space.
    const tr = state.tr;
    if (allMarked) {
      for (const { from, to } of op.ranges) tr.removeMark(from, to, markType);
    } else {
      const mark = markType.create();
      for (const { from, to } of op.ranges) tr.addMark(from, to, mark);
    }
    if (op.fromShadow) tr.setMeta(META_OPERATING_ON_SHADOW, true);
    dispatch(tr);
    return true;
  };
}

/** Textblocks that render bold by DEFAULT (via CSS), where "bold" isn't a
 *  mark to add but the baseline — so toggling bold there means toggling the
 *  `bold_off` override instead. (undertag is body-weight, so it's not here.) */
const BOLD_DEFAULT_TEXTBLOCKS = new Set([
  'tag', 'analytic', 'pocket', 'hat', 'block',
]);

/**
 * Mod-B — bold. Context-aware: in body text it toggles the `bold` mark as
 * usual; inside a bold-by-default structural block (tag / analytic / pocket
 * / hat / block) it toggles the `bold_off` override instead, so a word in a
 * tag can be un-bolded (and re-bolded). The two marks exclude each other, so
 * either toggle clears the opposite. Decision follows the selection's anchor
 * block, matching `toggleUnderlineTyping`'s structural test.
 */
export function toggleBold(): Command {
  return (state, dispatch, view) => {
    const structuralBold = BOLD_DEFAULT_TEXTBLOCKS.has(
      state.selection.$from.parent.type.name,
    );
    const markType = structuralBold ? schema.marks['bold_off']! : schema.marks['bold']!;
    return shadowAwareToggleMark(markType)(state, dispatch, view);
  };
}

/**
 * F11 — toggle Highlight across the selection with the active
 * highlight color. Color-agnostic toggle: if every character in the
 * selection already carries any `highlight` mark, strip it. Otherwise
 * apply the active color to the whole range (replacing any existing
 * color in chars that were already highlighted).
 *
 * No structural-block skip — tags, analytics, etc. can carry
 * highlights (they're a runtime annotation, not a semantic style).
 * Empty selection: no-op (no word expansion — highlights typically
 * span multiple words and users select before applying).
 */
export function applyHighlight(activeColor: () => string | null): Command {
  return withGapFix((state, dispatch) => {
    const highlightType = schema.marks['highlight'];
    if (!highlightType) return false;

    // Operating ranges: PM selection > shadow ranges. No word-expand
    // fallback — highlights typically span multiple words and users
    // select before applying.
    const op = getOperatingRangesForFormatting(state);
    if (op.ranges.length === 0) return false;

    const color = activeColor();
    let allInActiveColor = true;
    let anyText = false;
    for (const { from, to } of op.ranges) {
      const scan = toggleScanRange(state.doc, from, to);
      const r = scanTextMarkPresence(
        state.doc,
        scan.from,
        scan.to,
        'highlight',
        color === null ? undefined : { color },
      );
      if (r.anyText) anyText = true;
      if (!r.allMarkedMatching) allInActiveColor = false;
    }
    if (!anyText) return false;

    if (!dispatch) return true;
    const tr = state.tr;
    // Toggle off only when the whole range already wears THIS color —
    // a different color repaints instead of erasing (field report
    // 2026-08-05: green over yellow used to strip everything). A null
    // pen ("No highlight") always strips, no toggle branch.
    if (allInActiveColor || color === null) {
      for (const { from, to } of op.ranges) tr.removeMark(from, to, highlightType);
    } else {
      // Replace any existing highlight color with the active one
      // across each range. removeMark + addMark guarantees the new
      // color wins even where a different highlight already exists.
      for (const { from, to } of op.ranges) {
        tr.removeMark(from, to, highlightType);
        tr.addMark(from, to, highlightType.create({ color }));
      }
    }
    if (op.fromShadow) tr.setMeta(META_OPERATING_ON_SHADOW, true);
    dispatch(tr);
    return true;
  });
}

/**
 * Mod-F11 — toggle Shading (background color, `<w:shd w:fill="…"/>`).
 * Same toggle shape as F11. Shading is independent of highlight —
 * both can coexist on the same character. When both are present the
 * inner DOM wrapper (highlight, defined after shading in the schema)
 * wins visually. Highlight is rendered as the on-screen color;
 * shading remains in the data for round-trip and as the "protected
 * highlight" fallback that survives Word's Remove Highlighting.
 */
export function applyShading(activeColor: () => string | null): Command {
  return withGapFix((state, dispatch) => {
    const shadingType = schema.marks['shading'];
    if (!shadingType) return false;

    const op = getOperatingRangesForFormatting(state);
    if (op.ranges.length === 0) return false;

    const color = activeColor();
    let allInActiveColor = true;
    let anyText = false;
    for (const { from, to } of op.ranges) {
      const scan = toggleScanRange(state.doc, from, to);
      const r = scanTextMarkPresence(
        state.doc,
        scan.from,
        scan.to,
        'shading',
        color === null ? undefined : { color },
      );
      if (r.anyText) anyText = true;
      if (!r.allMarkedMatching) allInActiveColor = false;
    }
    if (!anyText) return false;

    if (!dispatch) return true;
    const tr = state.tr;
    // Same-color-only toggle, mirroring highlight: a different active
    // color repaints; only repeating the exact color strips. Null pen
    // ("No background color") — strip.
    if (allInActiveColor || color === null) {
      for (const { from, to } of op.ranges) tr.removeMark(from, to, shadingType);
    } else {
      for (const { from, to } of op.ranges) {
        tr.removeMark(from, to, shadingType);
        tr.addMark(from, to, shadingType.create({ color }));
      }
    }
    if (op.fromShadow) tr.setMeta(META_OPERATING_ON_SHADOW, true);
    dispatch(tr);
    return true;
  });
}

/**
 * Direct-apply commands fed by the ribbon's color dropdowns. Each
 * applies the chosen value to the selection unconditionally — these
 * are "I picked this color, paint everything with it" gestures, not
 * toggles. No-op on collapsed selection.
 *
 * `setHighlightColor` and `setShadingColor` always write the mark.
 * `setFontColor` accepts null to remove the mark entirely ("Automatic"
 * in the dropdown). Hex values are normalized to uppercase, matching
 * the OOXML convention used elsewhere in the schema.
 */
export function setHighlightColor(color: string): Command {
  return withGapFix((state, dispatch) => {
    const type = schema.marks['highlight'];
    if (!type) return false;
    const op = getOperatingRangesForFormatting(state);
    if (op.ranges.length === 0) return false;
    if (!dispatch) return true;
    const tr = state.tr;
    for (const { from, to } of op.ranges) {
      tr.removeMark(from, to, type);
      tr.addMark(from, to, type.create({ color }));
    }
    if (op.fromShadow) tr.setMeta(META_OPERATING_ON_SHADOW, true);
    dispatch(tr);
    return true;
  });
}

export function setShadingColor(rgb: string): Command {
  return withGapFix((state, dispatch) => {
    const type = schema.marks['shading'];
    if (!type) return false;
    const op = getOperatingRangesForFormatting(state);
    if (op.ranges.length === 0) return false;
    if (!dispatch) return true;
    const tr = state.tr;
    for (const { from, to } of op.ranges) {
      tr.removeMark(from, to, type);
      tr.addMark(from, to, type.create({ color: rgb.toUpperCase() }));
    }
    if (op.fromShadow) tr.setMeta(META_OPERATING_ON_SHADOW, true);
    dispatch(tr);
    return true;
  });
}

/**
 * Verbatim's "Standardize Highlighting" (`UniHighlight`). Walks the
 * target range, finds every text run that carries a `highlight` mark,
 * and rewrites its color to the current active highlight color —
 * useful for collapsing a mix of cyan / yellow / etc. back to one
 * consistent color. Unhighlighted text is untouched. A null pen
 * ("No highlight" active) strips highlights in scope instead.
 *
 * `scope`:
 *   - `'document'` — walk the whole doc (Verbatim parity).
 *   - `'selection'` — walk only the current selection. No-op when
 *     the selection is empty.
 *
 * `except` (the "with Exception" variant): a getter for one Word
 * highlight name whose runs are left completely untouched — they
 * keep their color even when the pen is null.
 */
export function uniHighlight(
  activeColor: () => string | null,
  scope: 'document' | 'selection' = 'document',
  except?: () => string,
): Command {
  return runUniColor('highlight', activeColor, scope, false, except);
}

/**
 * Standardize Shading — same shape as `uniHighlight` but for the
 * `shading` mark. Shading uses RGB hex (no leading `#`); the active
 * color is normalized to uppercase to match the schema, and the
 * `except` hex is compared case-insensitively.
 */
export function uniShade(
  activeColor: () => string | null,
  scope: 'document' | 'selection' = 'document',
  except?: () => string,
): Command {
  return runUniColor('shading', activeColor, scope, true, except);
}

/** Word's 15 named highlight colors with their canonical OOXML RGB
 *  values. Used to bridge between the `highlight` mark (which
 *  stores a name) and the `shading` mark (which stores hex RGB). */
const HIGHLIGHT_NAME_TO_HEX: Record<string, string> = {
  yellow: 'FFFF00',
  green: '00FF00',
  cyan: '00FFFF',
  magenta: 'FF00FF',
  blue: '0000FF',
  red: 'FF0000',
  darkBlue: '000080',
  darkCyan: '008080',
  darkGreen: '008000',
  darkMagenta: '800080',
  darkRed: '800000',
  darkYellow: '808000',
  darkGray: '808080',
  lightGray: 'C0C0C0',
  black: '000000',
};

function nearestHighlightName(hex: string): string {
  const upper = hex.toUpperCase();
  for (const [name, target] of Object.entries(HIGHLIGHT_NAME_TO_HEX)) {
    if (target === upper) return name;
  }
  // No exact match — pick the nearest by Euclidean RGB distance so
  // shading colors that aren't one of Word's 15 named highlights
  // still convert to *something* reasonable.
  const r = parseInt(upper.slice(0, 2), 16);
  const g = parseInt(upper.slice(2, 4), 16);
  const b = parseInt(upper.slice(4, 6), 16);
  let bestName = 'yellow';
  let bestDist = Infinity;
  for (const [name, target] of Object.entries(HIGHLIGHT_NAME_TO_HEX)) {
    const tr = parseInt(target.slice(0, 2), 16);
    const tg = parseInt(target.slice(2, 4), 16);
    const tb = parseInt(target.slice(4, 6), 16);
    const dist = (r - tr) ** 2 + (g - tg) ** 2 + (b - tb) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      bestName = name;
    }
  }
  return bestName;
}

/**
 * Convert every `highlight` mark in the current selection to a
 * `shading` mark with the equivalent RGB color (Word's 15 named
 * highlight colors map cleanly to their canonical RGBs). No-op on
 * empty selection. Unhighlighted text is untouched.
 */
export function highlightToShading(): Command {
  return (state, dispatch) => {
    const highlightType = schema.marks['highlight'];
    const shadingType = schema.marks['shading'];
    if (!highlightType || !shadingType) return false;
    if (state.selection.empty) return false;
    if (!dispatch) return true;
    // Trim trailing space (Layer 3).
    const [trimmed] = trimRangesForFormatting(state.doc, [
      { from: state.selection.from, to: state.selection.to },
    ]);
    const { from, to } = trimmed!;
    const tr = state.tr;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isText) return true;
      const hl = node.marks.find((m) => m.type === highlightType);
      if (!hl) return true;
      const colorName = String(hl.attrs['color'] ?? 'yellow');
      const hex = HIGHLIGHT_NAME_TO_HEX[colorName] ?? 'FFFF00';
      const start = Math.max(from, pos);
      const end = Math.min(to, pos + node.nodeSize);
      if (start >= end) return true;
      tr.removeMark(start, end, highlightType);
      tr.addMark(start, end, shadingType.create({ color: hex }));
      return true;
    });
    dispatch(tr);
    return true;
  };
}

/**
 * Convert every `shading` mark in the current selection to a
 * `highlight` mark whose color name matches the shading's RGB (exact
 * match first, then nearest-by-RGB-distance for arbitrary shades).
 * No-op on empty selection. Non-shaded text is untouched.
 */
export function shadingToHighlight(): Command {
  return (state, dispatch) => {
    const highlightType = schema.marks['highlight'];
    const shadingType = schema.marks['shading'];
    if (!highlightType || !shadingType) return false;
    if (state.selection.empty) return false;
    if (!dispatch) return true;
    // Trim trailing space (Layer 3).
    const [trimmed] = trimRangesForFormatting(state.doc, [
      { from: state.selection.from, to: state.selection.to },
    ]);
    const { from, to } = trimmed!;
    const tr = state.tr;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isText) return true;
      const sh = node.marks.find((m) => m.type === shadingType);
      if (!sh) return true;
      const hex = String(sh.attrs['color'] ?? 'D2D2D2');
      const name = nearestHighlightName(hex);
      const start = Math.max(from, pos);
      const end = Math.min(to, pos + node.nodeSize);
      if (start >= end) return true;
      tr.removeMark(start, end, shadingType);
      tr.addMark(start, end, highlightType.create({ color: name }));
      return true;
    });
    dispatch(tr);
    return true;
  };
}

function runUniColor(
  markName: 'highlight' | 'shading',
  activeColor: () => string | null,
  scope: 'document' | 'selection',
  upperHex: boolean,
  except?: () => string,
): Command {
  return (state, dispatch) => {
    const type = schema.marks[markName];
    if (!type) return false;
    let from: number;
    let to: number;
    if (scope === 'selection') {
      if (state.selection.empty) return false;
      // Trim trailing space (Layer 3).
      const [trimmed] = trimRangesForFormatting(state.doc, [
        { from: state.selection.from, to: state.selection.to },
      ]);
      from = trimmed!.from;
      to = trimmed!.to;
    } else {
      from = 0;
      to = state.doc.content.size;
    }
    const raw = activeColor();
    // Null pen: "standardize onto none" — strip the mark from every
    // marked run in scope. Unmarked text stays untouched either way.
    const color = raw === null ? null : upperHex ? raw.toUpperCase() : raw;
    // Exception pen: runs already marked in this color are skipped
    // entirely (highlight compares Word names; shading compares hex
    // case-insensitively via the shared uppercase normalization).
    const exceptRaw = except?.();
    const exceptColor =
      exceptRaw === undefined ? undefined : upperHex ? exceptRaw.toUpperCase() : exceptRaw;
    if (!dispatch) return true;
    const tr = state.tr;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isText) return true;
      const mark = node.marks.find((m) => m.type === type);
      if (!mark) return true;
      if (exceptColor !== undefined) {
        const current = String(mark.attrs['color'] ?? '');
        if ((upperHex ? current.toUpperCase() : current) === exceptColor) return true;
      }
      const start = Math.max(from, pos);
      const end = Math.min(to, pos + node.nodeSize);
      if (start >= end) return true;
      tr.removeMark(start, end, type);
      if (color !== null) tr.addMark(start, end, type.create({ color }));
      return true;
    });
    dispatch(tr);
    return true;
  };
}

export function setFontColor(rgb: string | null): Command {
  return (state, dispatch) => {
    const type = schema.marks['font_color'];
    if (!type) return false;
    const op = getOperatingRangesForFormatting(state);
    if (op.ranges.length === 0) return false;
    if (!dispatch) return true;
    const tr = state.tr;
    for (const { from, to } of op.ranges) {
      tr.removeMark(from, to, type);
      if (rgb !== null) {
        tr.addMark(from, to, type.create({ color: rgb.toUpperCase() }));
      }
    }
    if (op.fromShadow) tr.setMeta(META_OPERATING_ON_SHADOW, true);
    dispatch(tr);
    return true;
  };
}

/**
 * Adjust the font_size of the selection by `delta` points (+1 or -1
 * for the ribbon's increment/decrement buttons). With an empty
 * selection, this nudges `storedMarks` so the next-typed character
 * picks up the adjusted size — same shape as `setFontSize`'s empty-
 * selection branch.
 *
 * The `effectivePt` callback derives the run's "current" size when
 * it has no `font_size` mark — e.g., a hat-paragraph run reports
 * 22pt, a `.pmd-cite` run reports 13pt, a body run reports 11pt.
 * Without this, increments off non-font_size-marked text would all
 * nudge from a hardcoded body default and produce surprising jumps
 * (cursor in a 22pt hat → +1 lands on 12pt).
 */
export function adjustFontSize(
  delta: number,
  effectivePt: (node: PMNode | null, parent: PMNode) => number,
): Command {
  return withGapFix((state, dispatch) => {
    const type = schema.marks['font_size'];
    if (!type) return false;
    const sel = state.selection;
    const nudge = (pt: number) => Math.max(1, Math.min(409, pt + delta));

    // Shadow-selection path: if PM sel is empty but shadow matches
    // are active, nudge every text run inside each match (per-run
    // currentPt is the resolver's answer, so a 22pt + an 11pt run
    // get nudged from their own starting points).
    const shadowOp = sel.empty ? getOperatingRangesForFormatting(state) : null;
    if (shadowOp && shadowOp.fromShadow && shadowOp.ranges.length > 0) {
      if (!dispatch) return true;
      const tr = state.tr;
      for (const { from, to } of shadowOp.ranges) {
        state.doc.nodesBetween(from, to, (node, pos, parent) => {
          if (!node.isText || !parent) return true;
          const start = Math.max(from, pos);
          const end = Math.min(to, pos + node.nodeSize);
          if (start >= end) return true;
          const currentPt = effectivePt(node, parent);
          const targetHp = Math.round(nudge(currentPt) * 2);
          tr.removeMark(start, end, type);
          tr.addMark(start, end, type.create({ halfPoints: targetHp }));
          return true;
        });
      }
      tr.setMeta(META_OPERATING_ON_SHADOW, true);
      dispatch(tr);
      return true;
    }

    if (sel.empty) {
      if (!dispatch) return true;
      const $from = sel.$from;
      const parent = $from.parent;
      const current = state.storedMarks ?? $from.marks();
      const existing = current.find((m) => m.type === type);
      let currentPt: number;
      if (existing) {
        currentPt = Number(existing.attrs['halfPoints'] ?? 22) / 2;
      } else {
        // Look at the adjacent text node (before preferred), since the
        // cursor effectively "inherits" its run's identity. If neither
        // neighbor is text, fall through to parent default.
        const idx = $from.index();
        const before = idx > 0 ? parent.child(idx - 1) : null;
        const after = idx < parent.childCount ? parent.child(idx) : null;
        const adjacent =
          before?.isText ? before : after?.isText ? after : null;
        currentPt = effectivePt(adjacent, parent);
      }
      const withoutFs = current.filter((m) => m.type !== type);
      const next = type
        .create({ halfPoints: Math.round(nudge(currentPt) * 2) })
        .addToSet(withoutFs);
      dispatch(state.tr.setStoredMarks(next));
      return true;
    }

    if (!dispatch) return true;
    const tr = state.tr;
    // Trim trailing space (Layer 3) so a double-clicked word + its
    // absorbed space gets the font-size change on the word only.
    const [trimFrom, trimTo] = (() => {
      const [t] = trimRangesForFormatting(state.doc, [
        { from: sel.from, to: sel.to },
      ]);
      return [t!.from, t!.to];
    })();
    state.doc.nodesBetween(trimFrom, trimTo, (node, pos, parent) => {
      if (!node.isText || !parent) return true;
      const start = Math.max(trimFrom, pos);
      const end = Math.min(trimTo, pos + node.nodeSize);
      if (start >= end) return true;
      const currentPt = effectivePt(node, parent);
      const targetHp = Math.round(nudge(currentPt) * 2);
      tr.removeMark(start, end, type);
      tr.addMark(start, end, type.create({ halfPoints: targetHp }));
      return true;
    });
    dispatch(tr);
    return true;
  }, { effectivePt });
}

/**
 * Apply a `font_size` mark (or remove it, when `pt === null`) across
 * the selection. With an empty selection, the change updates the
 * editor's `storedMarks` so the next typed character picks it up —
 * Word's "type some number into the font-size box and start typing"
 * behavior. `pt` is in points (the chip's user-facing unit); we
 * convert to OOXML half-points internally.
 */
export function setFontSize(
  pt: number | null,
  effectivePt: (node: PMNode | null, parent: PMNode) => number,
): Command {
  return withGapFix((state, dispatch) => {
    const type = schema.marks['font_size'];
    if (!type) return false;
    const sel = state.selection;

    // Shadow-selection path: PM sel empty + shadow matches active →
    // apply across all matches as a single tr.
    const shadowOp = sel.empty ? getOperatingRangesForFormatting(state) : null;
    if (shadowOp && shadowOp.fromShadow && shadowOp.ranges.length > 0) {
      if (!dispatch) return true;
      const tr = state.tr;
      for (const { from, to } of shadowOp.ranges) {
        tr.removeMark(from, to, type);
        if (pt !== null) {
          tr.addMark(from, to, type.create({ halfPoints: Math.round(pt * 2) }));
        }
      }
      tr.setMeta(META_OPERATING_ON_SHADOW, true);
      dispatch(tr);
      return true;
    }

    if (sel.empty) {
      if (!dispatch) return true;
      const current = state.storedMarks ?? sel.$from.marks();
      const withoutFs = current.filter((m) => m.type !== type);
      const next =
        pt === null
          ? withoutFs
          : type.create({ halfPoints: Math.round(pt * 2) }).addToSet(withoutFs);
      dispatch(state.tr.setStoredMarks(next));
      return true;
    }
    if (!dispatch) return true;
    const tr = state.tr;
    // Trim trailing space (Layer 3).
    const [trimmed] = trimRangesForFormatting(state.doc, [
      { from: sel.from, to: sel.to },
    ]);
    const { from, to } = trimmed!;
    tr.removeMark(from, to, type);
    if (pt !== null) {
      tr.addMark(from, to, type.create({ halfPoints: Math.round(pt * 2) }));
    }
    dispatch(tr);
    return true;
  }, { effectivePt });
}

// ----------------------------------------------------------------
// F12 — Clear to Normal
//
// Verbatim parity adapted to our schema. Two coverage regimes:
//
//   - "Full" coverage (cursor in a paragraph, OR selection encompasses
//     a paragraph end-to-end): demote the paragraph's structural type
//     to body AND strip direct character formatting from its content.
//   - "Partial" coverage (selection covers only part of a paragraph):
//     strip marks across the selected sub-range only; paragraph type
//     is untouched.
//
// Mark sets:
//   - Demote/full: strip font_size, font_color, font_family, bold,
//     italic, strikethrough. Keep highlight, shading, named-style
//     marks (cite_mark / underline_mark / emphasis_mark / undertag_mark
//     / analytic_mark), link, pilcrow_marker. Also convert
//     `underline_direct` → `underline_mark` so direct underlining
//     survives the demotion as the body-valid variant.
//   - Partial: strip the above plus `underline_direct` AND all named-
//     style marks — partial is "clear character formatting" in the
//     Verbatim sense; only highlight/shading are exempted.
//
// Paragraph type demotion (full coverage):
//   - pocket / hat / block → paragraph (setNodeMarkup)
//   - tag → paragraph (dissolves the surrounding card; trailing
//     children of the card lift to doc level)
//   - analytic → paragraph (dissolves the analytic_unit)
//   - undertag at doc level → paragraph (setNodeMarkup)
//   - undertag inside a card / analytic_unit → card_body
//   - cite_paragraph, card_body, paragraph → no type change (only
//     the strip + underline_direct convert)

const F12_STRIP_DIRECT_NAMES = [
  'font_size',
  'font_color',
  'font_family',
  'bold',
  'italic',
  'strikethrough',
] as const;

const F12_STRIP_PARTIAL_NAMES = [
  ...F12_STRIP_DIRECT_NAMES,
  'underline_direct',
  'cite_mark',
  'underline_mark',
  'emphasis_mark',
  'undertag_mark',
  'analytic_mark',
] as const;

function stripMarkNamesOnTr(
  tr: Transaction,
  from: number,
  to: number,
  names: readonly string[],
): void {
  for (const name of names) {
    const mt = schema.marks[name];
    if (mt) tr.removeMark(from, to, mt);
  }
}

function convertUnderlineDirectToMarkOnTr(
  tr: Transaction,
  from: number,
  to: number,
  doc: PMNode,
): void {
  const directType = schema.marks['underline_direct'];
  const markType = schema.marks['underline_mark'];
  if (!directType || !markType) return;
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return true;
    if (!node.marks.some((m) => m.type === directType)) return true;
    const start = Math.max(from, pos);
    const end = Math.min(to, pos + node.nodeSize);
    if (start >= end) return true;
    tr.removeMark(start, end, directType);
    tr.addMark(start, end, markType.create());
    return true;
  });
}

function cleanFragmentForClearToNormal(
  fragment: Fragment,
  mode: 'cursor' | 'full',
): Fragment {
  const stripNames = mode === 'cursor' ? F12_STRIP_DIRECT_NAMES : F12_STRIP_PARTIAL_NAMES;
  const stripSet = new Set<string>(stripNames);
  const convertUnderlineDirect = mode === 'cursor';
  const directType = schema.marks['underline_direct'];
  const markType = schema.marks['underline_mark'];
  const out: PMNode[] = [];
  fragment.forEach((child) => {
    if (!child.isText) {
      out.push(child);
      return;
    }
    let newMarks: readonly Mark[] = child.marks.filter((m) => !stripSet.has(m.type.name));
    if (convertUnderlineDirect && directType && markType) {
      if (newMarks.some((m) => m.type === directType)) {
        newMarks = newMarks.filter((m) => m.type !== directType);
        if (!newMarks.some((m) => m.type === markType)) {
          newMarks = markType.create().addToSet(newMarks);
        }
      }
    }
    out.push(child.mark(newMarks));
  });
  return Fragment.fromArray(out);
}

interface ClearToNormalOp {
  nodeStart: number;
  nodeSize: number;
  typeName: string;
  /** Depth of the textblock in the original doc. */
  depth: number;
  /** `cursor` = empty selection at this paragraph; `full` = non-empty
   *  selection covers it end-to-end; `partial` = sub-range coverage. */
  mode: 'cursor' | 'full' | 'partial';
  partialFrom?: number;
  partialTo?: number;
}

export function clearToNormal(): Command {
  return (state, dispatch) => {
    const sel = state.selection;
    const isEmpty = sel.empty;

    // Shadow-selection path: when the PM selection is collapsed and
    // shadow matches are active, treat each match as a partial-mode
    // strip across its range. Structural demotes (cursor / full)
    // don't apply — the user picked specific runs to clean, not
    // whole paragraphs.
    if (isEmpty) {
      const shadowOp = getOperatingRangesForFormatting(state);
      if (shadowOp.fromShadow && shadowOp.ranges.length > 0) {
        if (!dispatch) return true;
        const tr = state.tr;
        for (const { from, to } of shadowOp.ranges) {
          applyClearToNormalPartial(tr, from, to);
        }
        tr.setMeta(META_OPERATING_ON_SHADOW, true);
        dispatch(tr);
        return true;
      }
    }

    const ops: ClearToNormalOp[] = [];
    state.doc.nodesBetween(sel.from, sel.to, (node, pos) => {
      if (!node.isTextblock) return true;
      const contentFrom = pos + 1;
      const contentTo = pos + node.nodeSize - 1;
      const $pos = state.doc.resolve(pos + 1);
      let mode: 'cursor' | 'full' | 'partial';
      if (isEmpty) {
        mode = 'cursor';
      } else if (sel.from <= contentFrom && sel.to >= contentTo) {
        mode = 'full';
      } else {
        mode = 'partial';
      }
      ops.push({
        nodeStart: pos,
        nodeSize: node.nodeSize,
        typeName: node.type.name,
        depth: $pos.depth,
        mode,
        partialFrom: mode === 'partial' ? Math.max(sel.from, contentFrom) : undefined,
        partialTo: mode === 'partial' ? Math.min(sel.to, contentTo) : undefined,
      });
      return false;
    });

    if (ops.length === 0) return false;
    if (!dispatch) return true;

    // Apply in reverse position order so earlier positions stay
    // stable through any dissolves (which can shrink the doc).
    const tr = state.tr;
    for (let i = ops.length - 1; i >= 0; i--) {
      const op = ops[i]!;
      if (op.mode === 'cursor' || op.mode === 'full') {
        applyClearToNormalDemote(tr, op);
      } else if (op.partialFrom != null && op.partialTo != null) {
        applyClearToNormalPartial(tr, op.partialFrom, op.partialTo);
      }
    }

    dispatch(tr);
    return true;
  };
}

/** Demote-and-strip path. Used for both `cursor` and `full` modes;
 *  the strip set + underline_direct handling differ:
 *    - cursor: keep named-style marks, convert underline_direct →
 *      underline_mark (so direct underlining survives the demotion).
 *    - full (entire paragraph in a non-empty selection): strip
 *      everything the partial-coverage path would, then demote on
 *      top of it. "Both behaviors at once."
 */
function applyClearToNormalDemote(tr: Transaction, op: ClearToNormalOp): void {
  const { nodeStart, nodeSize, typeName, depth, mode } = op;
  const contentFrom = nodeStart + 1;
  const contentTo = nodeStart + nodeSize - 1;
  const fragmentMode: 'cursor' | 'full' = mode === 'cursor' ? 'cursor' : 'full';
  const stripNames =
    fragmentMode === 'cursor' ? F12_STRIP_DIRECT_NAMES : F12_STRIP_PARTIAL_NAMES;

  let target: 'paragraph' | 'card_body' | null = null;
  let needDissolve = false;
  switch (typeName) {
    case 'pocket':
    case 'hat':
    case 'block':
      target = 'paragraph';
      break;
    case 'tag':
    case 'analytic':
      target = 'paragraph';
      needDissolve = true;
      break;
    case 'undertag':
      target = depth === 1 ? 'paragraph' : 'card_body';
      break;
    case 'cite_paragraph':
    case 'card_body':
    case 'paragraph':
      target = null;
      break;
    default:
      target = null;
  }

  if (needDissolve) {
    // Dissolve card / analytic_unit. The head's cleaned content
    // becomes a doc-level paragraph; trailing children lift out.
    const $head = tr.doc.resolve(contentFrom);
    const containerDepth = $head.depth - 1;
    if (containerDepth < 1) return;
    const container = $head.node(containerDepth);
    const containerStart = $head.before(containerDepth);
    if (container.firstChild !== $head.parent) return;

    const cleanedHead = cleanFragmentForClearToNormal(
      container.firstChild.content,
      fragmentMode,
    );
    const newPara = schema.nodes['paragraph']!.create(null, cleanedHead);
    const lifted: PMNode[] = [newPara];
    container.forEach((child, _off, index) => {
      if (index === 0) return;
      lifted.push(liftCardChild(child));
    });

    // Capture the selection endpoints' logical position inside
    // the container BEFORE the replaceWith so we can re-anchor
    // after. PM's default `ReplaceStep` mapping pushes any
    // position inside the replaced range to the END of the
    // replacement (assoc=1 — the right-association convention),
    // which lands the cursor at the tail of the lifted bodies
    // — and if absorb claims those bodies into a preceding card,
    // the cursor follows them to the bottom of that card. A
    // manual setSelection is the only fix: dissolve replaces the
    // very container that holds the cursor, so there's no
    // surrounding region whose mapping could preserve it.
    const containerEnd = containerStart + container.nodeSize;
    const origHead = tr.selection.head;
    const origAnchor = tr.selection.anchor;
    const mappedHead = mapPosThroughDissolve(origHead, containerStart, containerEnd, container, lifted);
    const mappedAnchor = origAnchor === origHead
      ? mappedHead
      : mapPosThroughDissolve(origAnchor, containerStart, containerEnd, container, lifted);

    tr.replaceWith(containerStart, containerEnd, Fragment.fromArray(lifted));

    if (mappedHead != null) {
      const $newHead = tr.doc.resolve(mappedHead);
      const $newAnchor = mappedAnchor != null ? tr.doc.resolve(mappedAnchor) : $newHead;
      tr.setSelection(TextSelection.between($newAnchor, $newHead));
    }
    return;
  }

  // Non-dissolve: strip + (conditionally) convert in place, then
  // change type if needed.
  stripMarkNamesOnTr(tr, contentFrom, contentTo, stripNames);
  if (fragmentMode === 'cursor') {
    convertUnderlineDirectToMarkOnTr(tr, contentFrom, contentTo, tr.doc);
  }
  if (target !== null && target !== typeName) {
    tr.setNodeMarkup(nodeStart, schema.nodes[target]!);
  }
}

function applyClearToNormalPartial(tr: Transaction, from: number, to: number): void {
  stripMarkNamesOnTr(tr, from, to, F12_STRIP_PARTIAL_NAMES);
}

/** Map a doc-position that falls inside a card / analytic_unit being
 *  dissolved by `applyClearToNormalDemote` to its logical equivalent
 *  in the lifted (post-replace) structure. Returns `null` for
 *  positions outside the container — those are handled correctly by
 *  PM's automatic size-delta mapping.
 *
 *  The lifted structure is `[paragraph(cleanedHead), ...lifted
 *  bodies]` inserted in place of the container. Each lifted body is
 *  the result of `liftCardChild` (card_body / cite_paragraph →
 *  paragraph, undertag → undertag, analytic → analytic_unit-wrapped).
 *  The `analytic_unit` wrap adds one extra opening boundary, which
 *  this function accounts for.
 */
function mapPosThroughDissolve(
  orig: number,
  containerStart: number,
  containerEnd: number,
  container: PMNode,
  lifted: readonly PMNode[],
): number | null {
  if (orig <= containerStart || orig >= containerEnd) return null;

  // Walk children to find which one the position was in and its
  // offset within that child's content.
  let walkPos = containerStart + 1; // inside container, before first child
  let childIdx = -1;
  let offsetInChild = 0;
  container.forEach((child, _off, idx) => {
    if (childIdx !== -1) return;
    const childOpen = walkPos;
    const childClose = walkPos + child.nodeSize;
    if (orig <= childOpen) {
      childIdx = idx;
      offsetInChild = 0;
    } else if (orig < childClose) {
      childIdx = idx;
      offsetInChild = orig - (childOpen + 1);
    }
    walkPos = childClose;
  });
  if (childIdx === -1) {
    // Position was just inside the container's closing boundary,
    // past the last child — clamp to end of the last lifted item.
    childIdx = lifted.length - 1;
    const lastLifted = lifted[childIdx]!;
    offsetInChild = lastLifted.type.name === 'analytic_unit'
      ? lastLifted.firstChild!.content.size
      : lastLifted.content.size;
  }

  // Sum sizes of preceding lifted items to find where the target
  // lifted item starts in the new doc.
  let newPos = containerStart;
  for (let i = 0; i < childIdx; i++) {
    newPos += lifted[i]!.nodeSize;
  }
  const liftedChild = lifted[childIdx]!;
  if (liftedChild.type.name === 'analytic_unit') {
    // analytic_unit wraps analytic → 2 opening boundaries.
    const inner = liftedChild.firstChild!;
    return newPos + 2 + Math.max(0, Math.min(offsetInChild, inner.content.size));
  }
  return newPos + 1 + Math.max(0, Math.min(offsetInChild, liftedChild.content.size));
}

// ----------------------------------------------------------------
// Shrink — Verbatim parity.
//
// Cycles the size of "filler" (non-underlined / non-emphasized) text
// through a small ramp:   11 → 8 → 7 → 6 → 5 → 4 → 11.  Mixed-size
// runs normalize to 8pt. Underlined and emphasized text keep their
// existing size — the point of Shrink is to compress the connective
// text while leaving the highlighted argument-text readable.
//
// Two kinds of "protected" ranges get optional special treatment,
// both gated by the same `shrinkRestoresOmissionsToNormal` setting
// (default off):
//   1. Bracketed-Omitted spans (`[…Omitted…]`, `[[…Omitted…]]`,
//      `<…Omitted…>`, `<<…Omitted…>>`, case-insensitive).
//   2. "Condense with warning" markers — `<open>PARAGRAPH INTEGRITY
//      (PAUSES|RESUMES)<close>` for all 6 delimiter variants
//      (`[`/`[[`/`<`/`<<`/`{`/`{{`), case-insensitive. We match every
//      variant regardless of the current `condenseWarningDelimiter`
//      setting so changing the delimiter mid-doc still protects older
//      markers.
//
// When the setting is ON: protected text is excluded from the size-
// cycle decision (otherwise a protected span stuck at Normal would
// make `sizes.size !== 1` and reset the cycle to 8pt, stranding the
// rest of the text) AND is restored to Normal at the end so it stays
// readable. When the setting is OFF: protected text is shrunk along
// with everything else.
//
// Scope:
//   - Empty selection, cursor inside a `card` (anywhere) → all
//     card_body paragraphs of that card.
//   - Empty selection, cursor inside an `analytic_unit` → all
//     card_body paragraphs of that unit.
//   - Empty selection, cursor in a doc-level `paragraph` → that
//     paragraph.
//   - Anything else with empty selection (pocket / hat / block /
//     doc-level undertag / doc-level cite_paragraph) → no-op.
//   - Non-empty selection → the parts of the selection that fall
//     inside card_body paragraphs (in cards or analytic_units) and
//     doc-level generic paragraphs. Tags, undertags, cite paragraphs,
//     headings within the selection are skipped (their content stays
//     at its existing size).

const SHRINK_NORMAL_TO_SMALL_PT = 8;
// `i` for case-insensitive ("omitted" / "OMITTED" / etc. all match);
// `.*?` is non-greedy and JS `.` doesn't cross newlines by default,
// so each bracket pair stops at the nearest closer within the same
// paragraph. Double-bracket variants come first so the longer match
// wins when both shapes overlap.
const BUILTIN_PROTECTED_REGEXES: readonly RegExp[] = [
  // Omissions. The post-sort+merge in `findProtectedRanges` collapses
  // any residual overlap between the double and single variants.
  /\[\[.*?Omitted.*?\]\]/gi,
  /<<.*?Omitted.*?>>/gi,
  /\{\{.*?Omitted.*?\}\}/gi,
  /\[.*?Omitted.*?\]/gi,
  /<.*?Omitted.*?>/gi,
  /\{.*?Omitted.*?\}/gi,
  // "Condense with warning" markers — all 6 delimiter variants.
  // Matched regardless of the current `condenseWarningDelimiter`
  // setting so older markers (or markers from another user's setting
  // choice) stay protected after the setting changes. The `'custom'`
  // delimiter's markers get auto-added via `compileShrinkProtections`
  // when the user has configured one.
  /\[\[PARAGRAPH INTEGRITY (?:PAUSES|RESUMES)\]\]/gi,
  /<<PARAGRAPH INTEGRITY (?:PAUSES|RESUMES)>>/gi,
  /\{\{PARAGRAPH INTEGRITY (?:PAUSES|RESUMES)\}\}/gi,
  /\[PARAGRAPH INTEGRITY (?:PAUSES|RESUMES)\]/gi,
  /<PARAGRAPH INTEGRITY (?:PAUSES|RESUMES)>/gi,
  /\{PARAGRAPH INTEGRITY (?:PAUSES|RESUMES)\}/gi,
  // Footnote callouts — anything containing "FOOTNOTE" between any of
  // the six delimiter shapes.
  /\[\[.*?FOOTNOTE.*?\]\]/gi,
  /<<.*?FOOTNOTE.*?>>/gi,
  /\{\{.*?FOOTNOTE.*?\}\}/gi,
  /\[.*?FOOTNOTE.*?\]/gi,
  /<.*?FOOTNOTE.*?>/gi,
  /\{.*?FOOTNOTE.*?\}/gi,
  // Image alt-text fallbacks — anything containing "ALT TEXT" between
  // any of the six delimiter shapes.
  /\[\[.*?ALT TEXT.*?\]\]/gi,
  /<<.*?ALT TEXT.*?>>/gi,
  /\{\{.*?ALT TEXT.*?\}\}/gi,
  /\[.*?ALT TEXT.*?\]/gi,
  /<.*?ALT TEXT.*?>/gi,
  /\{.*?ALT TEXT.*?\}/gi,
  // Translator attribution markers — "TRANSLATION BY <model/service>"
  // between any of the six delimiter shapes. The `.*?` covers every
  // attribution (MYMEMORY, GOOGLE TRANSLATE, OPUS 4.8, …) so all
  // possible markers stay at Normal size when protection is on.
  /\[\[.*?TRANSLATION BY .*?\]\]/gi,
  /<<.*?TRANSLATION BY .*?>>/gi,
  /\{\{.*?TRANSLATION BY .*?\}\}/gi,
  /\[.*?TRANSLATION BY .*?\]/gi,
  /<.*?TRANSLATION BY .*?>/gi,
  /\{.*?TRANSLATION BY .*?\}/gi,
];

const REGEX_ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

/** Escape a literal string for use as a regex source. */
function escapeRegexLiteral(s: string): string {
  return s.replace(REGEX_ESCAPE_RE, '\\$&');
}

/**
 * Combine the built-in protected patterns with user-supplied custom
 * protections and (if "Condense with warning" is using custom marker
 * strings) one auto-generated literal pattern per non-empty custom
 * marker. The custom markers are the WHOLE pause / resume paragraph
 * text — not delimiters around `PARAGRAPH INTEGRITY PAUSES/RESUMES`
 * — so they're escaped and protected as literal strings.
 *
 * Each user-custom entry is either a literal string (regex-escaped
 * and compiled with `gi`) or a raw regex source (compiled verbatim
 * with `gi`). Invalid regex sources and empty patterns are skipped.
 */
export function compileShrinkProtections(
  custom: readonly { pattern: string; isRegex: boolean }[],
  customPauseMarker: string,
  customResumeMarker: string,
): RegExp[] {
  const out: RegExp[] = [...BUILTIN_PROTECTED_REGEXES];
  for (const marker of [customPauseMarker, customResumeMarker]) {
    if (!marker) continue;
    try {
      out.push(new RegExp(escapeRegexLiteral(marker), 'gi'));
    } catch {
      // Defensive — escape should always produce valid regex.
    }
  }
  for (const rule of custom) {
    if (!rule.pattern) continue;
    const source = rule.isRegex
      ? rule.pattern
      : escapeRegexLiteral(rule.pattern);
    try {
      out.push(new RegExp(source, 'gi'));
    } catch {
      // Invalid user regex — silently skip rather than break shrink.
    }
  }
  return out;
}

const SHRINK_EXEMPT_MARK_NAMES = new Set([
  'underline_mark',
  'underline_direct',
  'emphasis_mark',
]);

export function shrinkText(
  effectivePt: (node: PMNode | null, parent: PMNode) => number,
  normalPt: () => number,
  restoreOmissions: () => boolean,
  protectionPatterns: () => readonly RegExp[],
): Command {
  return sizeCycleCommand(effectivePt, normalPt, restoreOmissions, protectionPatterns, nextShrinkSize);
}

/** Restore shrink-scope text straight to Normal size — the inverse of
 *  the shrink cycle, sharing its scope/eligibility/protection logic. */
export function regrowText(
  effectivePt: (node: PMNode | null, parent: PMNode) => number,
  normalPt: () => number,
  restoreOmissions: () => boolean,
  protectionPatterns: () => readonly RegExp[],
): Command {
  return sizeCycleCommand(
    effectivePt,
    normalPt,
    restoreOmissions,
    protectionPatterns,
    (_sizes, normal) => normal,
  );
}

/** Smart Shrink: one-shot, per-paragraph depth. A paragraph with NO
 *  underlining or emphasis anywhere is a long fully-unread stretch —
 *  its eligible text goes straight to 5pt; a paragraph that has those
 *  marks keeps the standard 8pt for its connective text. Eligibility
 *  and protections are identical to the regular shrink cycle, and the
 *  command is idempotent (no cycling). Classification reads the WHOLE
 *  paragraph even when only part of it is selected. */
const SMART_SHRINK_BARE_PT = 5;
const SMART_SHRINK_MARKED_PT = 8;

interface SmartShrinkBlock {
  /** The textblock (classification looks at all of it). */
  node: PMNode;
  /** The portion to shrink (clipped to the selection when partial). */
  from: number;
  to: number;
}

/** Smart-shrink scope: the same blocks the regular shrink cycle
 *  touches, but block-aware so each paragraph classifies itself. */
function computeSmartShrinkBlocks(
  state: import('prosemirror-state').EditorState,
): SmartShrinkBlock[] {
  const sel = state.selection;
  if (sel.empty) {
    const $pos = sel.$from;
    if ($pos.depth < 1) return [];
    const docLevel = $pos.node(1);
    const docLevelStart = $pos.before(1);
    const t = docLevel.type.name;
    if (t === 'card' || t === 'analytic_unit') {
      const out: SmartShrinkBlock[] = [];
      let offset = 1;
      docLevel.forEach((child) => {
        if (child.type.name === 'card_body') {
          const childStart = docLevelStart + offset;
          out.push({ node: child, from: childStart + 1, to: childStart + child.nodeSize - 1 });
        }
        offset += child.nodeSize;
      });
      return out;
    }
    if (t === 'paragraph') {
      return [{ node: docLevel, from: docLevelStart + 1, to: docLevelStart + docLevel.nodeSize - 1 }];
    }
    return [];
  }
  const out: SmartShrinkBlock[] = [];
  state.doc.nodesBetween(sel.from, sel.to, (node, pos) => {
    if (!node.isTextblock) return true;
    const t = node.type.name;
    if (t !== 'card_body' && t !== 'paragraph') return false;
    const from = Math.max(sel.from, pos + 1);
    const to = Math.min(sel.to, pos + node.nodeSize - 1);
    if (from < to) out.push({ node, from, to });
    return false;
  });
  return out;
}

/** True when any text in the block carries a shrink-exempt mark
 *  (underline / direct underline / emphasis). */
function blockHasExemptMarks(node: PMNode): boolean {
  let has = false;
  node.descendants((child) => {
    if (has) return false;
    if (child.isText && child.marks.some((m) => SHRINK_EXEMPT_MARK_NAMES.has(m.type.name))) {
      has = true;
    }
    return !has;
  });
  return has;
}

export function smartShrinkText(
  effectivePt: (node: PMNode | null, parent: PMNode) => number,
  normalPt: () => number,
  restoreOmissions: () => boolean,
  protectionPatterns: () => readonly RegExp[],
): Command {
  return (state, dispatch) => {
    const blocks = computeSmartShrinkBlocks(state);
    if (blocks.length === 0) {
      if (dispatch && state.selection.$from.parent.type.name === 'cite_paragraph') {
        showToast(SHRINK_ON_CITE_MESSAGE, { durationMs: 2200 });
      }
      return false;
    }

    const ranges = blocks.map(({ from, to }) => ({ from, to }));
    const protectedRanges = restoreOmissions()
      ? findProtectedRanges(state.doc, ranges, protectionPatterns())
      : [];

    // Per block: classify (whole paragraph), then collect its eligible
    // sub-ranges at the block's target size.
    const edits: { from: number; to: number; pt: number }[] = [];
    for (const block of blocks) {
      const pt = blockHasExemptMarks(block.node) ? SMART_SHRINK_MARKED_PT : SMART_SHRINK_BARE_PT;
      state.doc.nodesBetween(block.from, block.to, (node, pos, parent) => {
        if (!node.isText || !parent) return true;
        if (node.marks.some((m) => SHRINK_EXEMPT_MARK_NAMES.has(m.type.name))) return true;
        const start = Math.max(block.from, pos);
        const end = Math.min(block.to, pos + node.nodeSize);
        if (start >= end) return true;
        for (const sub of subtractRanges(start, end, protectedRanges)) {
          edits.push({ ...sub, pt });
        }
        return true;
      });
    }
    if (edits.length === 0 && protectedRanges.length === 0) return false;

    // Idempotency / no-op detection: skip when every edit already sits
    // at its target size (so the command honestly reports false).
    const fontSizeType = schema.marks['font_size']!;
    const changed = edits.some(({ from, to, pt }) => {
      let differs = false;
      state.doc.nodesBetween(from, to, (node, _pos, parent) => {
        if (differs || !node.isText || !parent) return !differs;
        if (effectivePt(node, parent) !== pt) differs = true;
        return !differs;
      });
      return differs;
    });
    if (!changed && protectedRanges.length === 0) return false;
    if (!dispatch) return true;

    const tr = state.tr;
    for (const { from, to, pt } of edits) {
      tr.removeMark(from, to, fontSizeType);
      tr.addMark(
        from,
        to,
        fontSizeType.create({ halfPoints: Math.round(pt * 2), origin: 'shrink' }),
      );
    }
    const normalHp = Math.round(normalPt() * 2);
    for (const { from, to } of protectedRanges) {
      tr.removeMark(from, to, fontSizeType);
      tr.addMark(from, to, fontSizeType.create({ halfPoints: normalHp, origin: 'shrink' }));
    }
    dispatch(tr);
    return true;
  };
}

function sizeCycleCommand(
  effectivePt: (node: PMNode | null, parent: PMNode) => number,
  normalPt: () => number,
  restoreOmissions: () => boolean,
  protectionPatterns: () => readonly RegExp[],
  pickSize: (sizes: Set<number>, normalPt: number) => number,
): Command {
  return (state, dispatch) => {
    const ranges = computeShrinkScope(state);
    if (ranges.length === 0) {
      // The common dead-end: a cite line that READS as body text
      // (imported cite-style debris keeps the paragraph classified
      // as cite) — toast so the refusal is diagnosable. Still
      // returns false: the command didn't run.
      if (dispatch && state.selection.$from.parent.type.name === 'cite_paragraph') {
        showToast(SHRINK_ON_CITE_MESSAGE, { durationMs: 2200 });
      }
      return false;
    }

    // If the protect-restore setting is on, identify protected spans
    // (built-in omissions + warning markers + user custom rules + auto-
    // generated patterns for the custom condense-with-warning delim)
    // up front so they can be excluded from both the size-cycle decision
    // and the size mutation. Otherwise treat them as regular text.
    const protectedRanges = restoreOmissions()
      ? findProtectedRanges(state.doc, ranges, protectionPatterns())
      : [];

    // Walk eligible (non-exempt) text nodes inside each range to
    // collect their effective sizes and the per-text-node sub-ranges
    // that the size change should touch. Within each text node, drop
    // any portion that overlaps a protected range.
    const eligible: { from: number; to: number }[] = [];
    const sizes = new Set<number>();
    for (const range of ranges) {
      state.doc.nodesBetween(range.from, range.to, (node, pos, parent) => {
        if (!node.isText || !parent) return true;
        if (node.marks.some((m) => SHRINK_EXEMPT_MARK_NAMES.has(m.type.name))) {
          return true;
        }
        const start = Math.max(range.from, pos);
        const end = Math.min(range.to, pos + node.nodeSize);
        if (start >= end) return true;
        const subRanges = subtractRanges(start, end, protectedRanges);
        if (subRanges.length === 0) return true;
        for (const sub of subRanges) eligible.push(sub);
        sizes.add(effectivePt(node, parent));
        return true;
      });
    }
    if (eligible.length === 0 && protectedRanges.length === 0) return false;

    const normal = normalPt();
    const newSize = pickSize(sizes, normal);
    if (!dispatch) return true;

    const tr = state.tr;
    const fontSizeType = schema.marks['font_size']!;
    const newHp = Math.round(newSize * 2);
    for (const { from, to } of eligible) {
      tr.removeMark(from, to, fontSizeType);
      tr.addMark(from, to, fontSizeType.create({ halfPoints: newHp, origin: 'shrink' }));
    }

    // Force protected ranges to Normal size. Done after the eligible
    // pass so they overwrite any pre-existing font_size mark.
    const normalHp = Math.round(normal * 2);
    for (const { from, to } of protectedRanges) {
      tr.removeMark(from, to, fontSizeType);
      tr.addMark(from, to, fontSizeType.create({ halfPoints: normalHp, origin: 'shrink' }));
    }

    dispatch(tr);
    return true;
  };
}

function nextShrinkSize(sizes: Set<number>, normalPt: number): number {
  if (sizes.size !== 1) return SHRINK_NORMAL_TO_SMALL_PT;
  const current = [...sizes][0]!;
  if (current > 8) return 8;
  if (current === 8) return 7;
  if (current === 7) return 6;
  if (current === 6) return 5;
  if (current === 5) return 4;
  if (current === 4) return normalPt;
  // Off-cycle size — below 4pt or fractional (e.g. 3pt, 6.5pt;
  // anything above 8pt is caught by the `> 8` branch) — jump back
  // to Normal so the cycle re-enters from a known point.
  return normalPt;
}

function computeShrinkScope(state: import('prosemirror-state').EditorState): { from: number; to: number }[] {
  const sel = state.selection;
  if (sel.empty) {
    const $pos = sel.$from;
    if ($pos.depth < 1) return [];
    const docLevel = $pos.node(1);
    const docLevelStart = $pos.before(1);
    const t = docLevel.type.name;
    if (t === 'card' || t === 'analytic_unit') {
      const out: { from: number; to: number }[] = [];
      let offset = 1;
      docLevel.forEach((child) => {
        if (child.type.name === 'card_body') {
          const childStart = docLevelStart + offset;
          out.push({ from: childStart + 1, to: childStart + child.nodeSize - 1 });
        }
        offset += child.nodeSize;
      });
      return out;
    }
    if (t === 'paragraph') {
      return [{ from: docLevelStart + 1, to: docLevelStart + docLevel.nodeSize - 1 }];
    }
    return [];
  }

  // Non-empty selection: filter to card_body + doc-level paragraph.
  const out: { from: number; to: number }[] = [];
  state.doc.nodesBetween(sel.from, sel.to, (node, pos) => {
    if (!node.isTextblock) return true;
    const t = node.type.name;
    if (t !== 'card_body' && t !== 'paragraph') return false;
    const contentFrom = pos + 1;
    const contentTo = pos + node.nodeSize - 1;
    const from = Math.max(sel.from, contentFrom);
    const to = Math.min(sel.to, contentTo);
    if (from < to) out.push({ from, to });
    return false;
  });
  return out;
}

/**
 * Find all protected spans (omissions + "Condense with warning"
 * markers) within the given doc ranges, returned as sorted, merged
 * doc-position [from, to) ranges.
 *
 * Each scope range gets its text gathered with a per-char back-map to
 * doc positions so regex matches can be translated back into the doc.
 * Double-bracket variants are listed first in PROTECTED_RANGE_REGEXES
 * so the longer match wins on overlap; final sort+merge collapses any
 * residual overlap between variants (e.g. `[[…Omitted…]]` also
 * matches the inner `[…Omitted…]`).
 */
export function findProtectedRanges(
  doc: PMNode,
  ranges: { from: number; to: number }[],
  patterns: readonly RegExp[],
): { from: number; to: number }[] {
  const matches: { from: number; to: number }[] = [];
  for (const range of ranges) {
    const charPos: number[] = [];
    let text = '';
    doc.nodesBetween(range.from, range.to, (node, pos) => {
      if (!node.isText || !node.text) return true;
      const start = Math.max(range.from, pos);
      const end = Math.min(range.to, pos + node.nodeSize);
      if (start >= end) return true;
      const slice = node.text.slice(start - pos, end - pos);
      for (let i = 0; i < slice.length; i++) charPos.push(start + i);
      text += slice;
      return true;
    });
    for (const re of patterns) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        // Defensive against zero-width matches (e.g. a user-supplied
        // regex like `(?=)` would match every position): advance
        // lastIndex by 1 to avoid an infinite loop.
        if (m[0].length === 0) {
          re.lastIndex = m.index + 1;
          continue;
        }
        const matchFrom = charPos[m.index];
        const matchTo = charPos[m.index + m[0].length - 1];
        if (matchFrom == null || matchTo == null) continue;
        matches.push({ from: matchFrom, to: matchTo + 1 });
      }
    }
  }
  if (matches.length === 0) return matches;
  matches.sort((a, b) => a.from - b.from || b.to - a.to);
  const merged: { from: number; to: number }[] = [];
  for (const r of matches) {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to) {
      last.to = Math.max(last.to, r.to);
    } else {
      merged.push({ from: r.from, to: r.to });
    }
  }
  return merged;
}

/**
 * Return [start, end) minus any portions covered by `excludes`.
 * `excludes` must be sorted by `from` and non-overlapping (which
 * `findProtectedRanges` guarantees).
 */
function subtractRanges(
  start: number,
  end: number,
  excludes: { from: number; to: number }[],
): { from: number; to: number }[] {
  if (excludes.length === 0) return [{ from: start, to: end }];
  const out: { from: number; to: number }[] = [];
  let cursor = start;
  for (const e of excludes) {
    if (e.to <= cursor) continue;
    if (e.from >= end) break;
    if (e.from > cursor) out.push({ from: cursor, to: e.from });
    cursor = Math.max(cursor, e.to);
    if (cursor >= end) return out;
  }
  if (cursor < end) out.push({ from: cursor, to: end });
  return out;
}

/**
 * Walk text nodes in [from, to] and report whether every text char
 * carries a mark of the given name, plus whether any text was found
 * at all. Used by toggle commands to decide on-vs-off.
 */
/** The sub-range of [from,to) a TOGGLE decision should scan: the
 *  operating range with leading/trailing whitespace shaved. The gap
 *  fix polices selection-edge whitespace (bridged or stripped by the
 *  bookends — gapModRange protects selected punctuation but
 *  deliberately not whitespace), so counting those chars broke the
 *  select + double-F11 quick-unhighlight: tap 1 highlighted the words
 *  but the gap fix stripped the selected trailing space, tap 2 then
 *  saw "not fully highlighted" and repainted forever instead of
 *  toggling off. Falls back to the full range when trimming leaves
 *  nothing, so a deliberate whitespace-only selection keeps its
 *  meaning. Used by the toggles (highlight / shading / underline);
 *  emphasis is not a toggle and stays untrimmed. */
function toggleScanRange(doc: PMNode, from: number, to: number): { from: number; to: number } {
  let f = from;
  let t = to;
  while (f < t && /^\s$/.test(doc.textBetween(f, f + 1))) f++;
  while (t > f && /^\s$/.test(doc.textBetween(t - 1, t))) t--;
  return f < t ? { from: f, to: t } : { from, to };
}

function scanTextMarkPresence(
  doc: PMNode,
  from: number,
  to: number,
  markName: string,
  attrs?: Record<string, unknown>,
): { allMarked: boolean; anyText: boolean; allMarkedMatching: boolean } {
  let allMarked = true;
  let anyText = false;
  // With `attrs`: every text run carries the mark AND every such mark
  // matches those attrs (e.g. the highlight is in THIS color). Drives
  // the toggle-vs-recolor decision: same color toggles off, a
  // different color repaints.
  let allMarkedMatching = true;
  doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return true;
    anyText = true;
    const m = node.marks.find((mk) => mk.type.name === markName);
    if (!m) {
      allMarked = false;
      allMarkedMatching = false;
    } else if (attrs && !Object.entries(attrs).every(([k, v]) => m.attrs[k] === v)) {
      allMarkedMatching = false;
    }
    return true;
  });
  return { allMarked, anyText, allMarkedMatching };
}

/**
 * Alt-F8 — Verbatim's CopyPreviousCite, reframed for our schema.
 * Copies the nearest preceding cite_paragraphs (source rules in
 * `findPreviousCites`; whitespace-only cites still count) to the
 * cursor's location (placement rules in `computeCitePasteLocation`),
 * leaving the source untouched. The cursor lands at the end of the
 * last inserted cite so the user can continue from there.
 */
export function copyPreviousCite(): Command {
  return (state, dispatch) => {
    // Collapse a non-empty selection to its start position.
    const $from = state.doc.resolve(state.selection.from);

    let cites = findPreviousCites(state.doc, $from);
    if (cites.length === 0) return false;
    // Optional narrowing (Settings → Editing): only the single nearest
    // preceding cite, not the source's whole cite group. The group's
    // last member is the one closest to the cursor in document order.
    if (settings.get('copyPreviousCiteNearestOnly') && cites.length > 1) {
      cites = [cites[cites.length - 1]!];
    }
    if (!dispatch) return true;

    const dest = computeCitePasteLocation($from);
    const insertedCites = cites.map((c) => c.copy(c.content));
    const content = Fragment.fromArray(insertedCites);
    // Cursor at end of last cite's content (one position before the
    // last cite's closing token).
    const cursorPos = dest.from + content.size - 1;

    let tr = state.tr.replaceWith(dest.from, dest.to, content);
    try {
      tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
    } catch {
      tr = tr.setSelection(Selection.near(tr.doc.resolve(cursorPos)));
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/**
 * F2 — Paste Text. Pastes the clipboard's plain text in one keystroke when a
 * clipboard read is available:
 *   - Electron: full host clipboard access, no prompt.
 *   - Chromium browser: the async Clipboard API, gated on THIS keypress as the
 *     required user gesture. Chromium prompts once for the clipboard-read
 *     permission and then persists the grant — one-keystroke thereafter.
 * When no read is available, or the web read is denied (Firefox has no
 * persistent grant), F2 falls back to arming a "plain paste" flag in the
 * `paste-plugin`; the next real `paste` event (Ctrl/Cmd+V) consumes it, strips
 * formatting, and disarms. See `src/editor/paste-plugin.ts` for the consumer.
 */
export function pasteAsText(
  ctx: Pick<
    RibbonContext,
    'condenseOnPaste' | 'paragraphIntegrity' | 'usePilcrows' | 'headingMode'
  >,
): Command {
  return (state, dispatch, view) => {
    if (!dispatch) return true;
    const electron = getElectronHost();
    if (view && clipboardReadAvailable(electron)) {
      void runPlainPasteFromClipboard(electron, view, ctx);
      return true;
    }
    return togglePlainPaste()(state, dispatch);
  };
}

type ClipboardReader = { clipboardReadText: () => Promise<string> } | null;

/** True when SOME clipboard read is available: Electron's host IPC, or the
 *  browser's async Clipboard API. */
function clipboardReadAvailable(electron: ClipboardReader): boolean {
  return (
    !!electron ||
    (typeof navigator !== 'undefined' && !!navigator.clipboard?.readText)
  );
}

/** Read the clipboard's plain text — Electron via host IPC, browser via the
 *  async Clipboard API. The web path MUST be reached from a user gesture (called
 *  straight from a keypress command, before any await) and prompts for the
 *  clipboard-read permission the first time (persists on Chromium). Returns null
 *  when the read is unavailable or denied. */
async function readClipboardText(electron: ClipboardReader): Promise<string | null> {
  if (electron) {
    try {
      return await electron.clipboardReadText();
    } catch (err) {
      console.warn('clipboard read (host) failed:', err);
      return null;
    }
  }
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (clip?.readText) {
    try {
      return await clip.readText();
    } catch (err) {
      console.warn('clipboard read (web) failed:', err);
      return null;
    }
  }
  return null;
}

async function runPlainPasteFromClipboard(
  electron: ClipboardReader,
  view: EditorView,
  ctx: Pick<
    RibbonContext,
    'condenseOnPaste' | 'paragraphIntegrity' | 'usePilcrows' | 'headingMode'
  >,
): Promise<void> {
  const text = await readClipboardText(electron);
  if (text === null) {
    // Read denied/unavailable — on web, fall back to the arm-flag workflow so
    // the next Ctrl/Cmd+V still does a plain paste. (Electron reads rarely fail.)
    if (!electron) togglePlainPaste()(view.state, view.dispatch);
    return;
  }
  applyPlainPasteFromText(view, text, ctx);
}

/**
 * Paste the clipboard's plain text, then DESTRUCTIVELY condense just the pasted
 * content WITHOUT preserving paragraph integrity — the net
 * effect of an F2 plain paste followed by Alt-F3 (Condense Without Paragraph
 * Integrity) over what you pasted. Reads the clipboard (Electron host IPC, or
 * the Chromium async Clipboard API — this keypress is the required gesture),
 * pastes with the settings-driven condense-on-paste suppressed, then forces
 * `condenseMerge({ withPilcrows: false })` over the inserted range regardless of
 * the user's condense settings. Unbound by default; no-op (the key falls
 * through) where no clipboard read is available, and — unlike F2 — there's no
 * arm-flag fallback (the condense needs the text immediately).
 */
export function pasteCondensed(ctx: Pick<RibbonContext, 'headingMode'>): Command {
  return (_state, dispatch, view) => {
    if (!dispatch) return true;
    const electron = getElectronHost();
    if (!view || !clipboardReadAvailable(electron)) return false;
    void runPasteCondensed(electron, view, ctx);
    return true;
  };
}

async function runPasteCondensed(
  electron: ClipboardReader,
  view: EditorView,
  ctx: Pick<RibbonContext, 'headingMode'>,
): Promise<void> {
  const text = await readClipboardText(electron);
  if (text === null) return; // read denied/unavailable — no-op (no arm-flag for condense)
  pasteTextAndCondense(view, text, ctx.headingMode());
}

/**
 * Paste `text` like an F2 plain paste (its settings-driven condense suppressed),
 * then destructively condense just the inserted range with paragraph integrity
 * off — the shared core of the Paste-and-Condense command, minus the clipboard
 * read. Exported for tests.
 */
export function pasteTextAndCondense(view: EditorView, text: string, headingMode: HeadingMode): void {
  if (!text) return;
  // Left boundary of the paste: content lands at the selection start, and the
  // cursor ends up at the far end after the paste.
  const from = view.state.selection.from;
  applyPlainPasteFromText(view, text, {
    condenseOnPaste: () => false,
    paragraphIntegrity: () => false,
    usePilcrows: () => false,
    headingMode: () => headingMode,
  });
  const to = view.state.selection.from; // cursor parked at the end of the paste
  if (to <= from) return; // nothing landed
  try {
    // Select the just-pasted range, then run the destructive, integrity-off
    // condense (identical to the Alt-F3 command, but scoped to the paste).
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
    condenseMerge({ withPilcrows: false, headingMode })(view.state, view.dispatch.bind(view));
  } catch (err) {
    // The paste itself is committed and valid — keep it — but a failed
    // condense must be VISIBLE (audit tier 4): a silent warn here would
    // hide a real condense bug from every field report.
    surfaceError('paste + condense', err);
  }
}

/** Shared core for the analytics→tags conversions. Converts every
 *  `analytic_unit` in scope (the selection, or the whole doc when the
 *  selection is empty) that satisfies `shouldConvert` into a `card`
 *  (analytic→tag, body slots pass through). No-op when none qualify. */
function analyticsToTagsCommand(
  shouldConvert: (unit: PMNode) => boolean,
): Command {
  return (state, dispatch) => {
    const sel = state.selection;
    const from = sel.empty ? 0 : sel.from;
    const to = sel.empty ? state.doc.content.size : sel.to;

    const units: { node: PMNode; pos: number }[] = [];
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type.name === 'analytic_unit') {
        if (shouldConvert(node)) units.push({ node, pos });
        // Analytic_units don't nest, so no need to recurse.
        return false;
      }
      return true;
    });
    if (units.length === 0) return false;
    if (!dispatch) return true;

    const tr = state.tr;
    // Reverse-doc order so an earlier unit's position stays valid
    // through later replacements. analytic_unit ↔ card and analytic
    // ↔ tag are same-size swaps anyway (each side wraps with a
    // single open + close), but processing in reverse is the safer
    // default for multi-replace transactions.
    for (let i = units.length - 1; i >= 0; i--) {
      const { node: unit, pos } = units[i]!;
      const analytic = unit.firstChild;
      if (!analytic || analytic.type.name !== 'analytic') continue;
      const tagId =
        (analytic.attrs['id'] as string | null) ?? newHeadingId();
      const tagNode = schema.nodes['tag']!.create(
        { id: tagId },
        analytic.content,
      );
      const rest: PMNode[] = [];
      unit.forEach((child, _offset, idx) => {
        if (idx > 0) rest.push(child);
      });
      const cardNode = schema.nodes['card']!.create(null, [tagNode, ...rest]);
      tr.replaceWith(pos, pos + unit.nodeSize, cardNode);
    }
    dispatch(tr);
    return true;
  };
}

/** Verbatim's `ConvertAnalyticsToTags` — convert every `analytic_unit`
 *  in scope (see `analyticsToTagsCommand`). The heading's `id`, inline
 *  content, and marks survive: a same-tier swap, exempt from the
 *  promotion strip (see DECISIONS 2026-05-12 "Style apply strips
 *  direct formatting"). Body slots pass through untouched — they're
 *  legal in both containers. */
export function convertAnalyticsToTags(): Command {
  return analyticsToTagsCommand(() => true);
}

/** Like `convertAnalyticsToTags`, but only converts analytic_units that
 *  actually carry a `cite_paragraph` — i.e. analytics with a real cite
 *  attached, leaving bare (citeless) analytics as analytics. */
export function convertCitedAnalyticsToTags(): Command {
  return analyticsToTagsCommand((unit) => {
    let hasCite = false;
    unit.forEach((child) => {
      if (child.type.name === 'cite_paragraph') hasCite = true;
    });
    return hasCite;
  });
}

/**
 * Extract the current selection into a new `undertag` paragraph beneath
 * the enclosing card's tag, below any existing undertags. The original
 * text stays put — this copies the excerpt out as an undertag (e.g. a
 * short summary label under the tag). When `inQuotes` is on, the excerpt
 * is wrapped in double quotes.
 *
 * Requires a non-empty selection inside a card whose first child is a
 * tag; otherwise a no-op (returns false). A multi-block selection is
 * collapsed to a single line (undertag is one inline paragraph).
 */
export function extractUndertag(inQuotes: () => boolean): Command {
  return (state, dispatch) => {
    const sel = state.selection;
    if (sel.empty) return false;
    const $from = sel.$from;
    // Enclosing card (cards never nest, but walk up to be safe).
    let cardDepth = -1;
    for (let d = $from.depth; d >= 0; d--) {
      if ($from.node(d).type.name === 'card') {
        cardDepth = d;
        break;
      }
    }
    if (cardDepth < 0) return false;
    const card = $from.node(cardDepth);
    if (!card.firstChild || card.firstChild.type.name !== 'tag') return false;
    // The selection's text, collapsed across blocks to one line.
    const raw = state.doc.textBetween(sel.from, sel.to, ' ', ' ').trim();
    if (!raw) return false;
    if (!dispatch) return true;

    const text = inQuotes() ? `"${raw}"` : raw;
    const undertag = schema.nodes['undertag']!.create(null, schema.text(text));
    // Insert just after the card's last undertag, or right after the tag
    // when the card has none yet.
    const cardStart = $from.before(cardDepth);
    let insertPos = cardStart + 1 + card.firstChild.nodeSize; // after the tag
    card.forEach((child, offset) => {
      if (child.type.name === 'undertag') {
        insertPos = cardStart + 1 + offset + child.nodeSize;
      }
    });
    const tr = state.tr.insert(insertPos, undertag);
    // Drop the cursor at the end of the new undertag so it's ready to edit.
    tr.setSelection(TextSelection.create(tr.doc, insertPos + 1 + undertag.content.size));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/**
 * Remove every `link` mark in scope — Verbatim's `RemoveHyperlinks`.
 * Non-empty selection → strip within the selection (partial overlap
 * splits the mark, leaving the untouched portion linked); empty
 * selection → the whole doc. Returns false when no `link` mark is in
 * scope. Other marks on linked runs are untouched — dropping `link`
 * alone removes both the URL and the user-agent blue/underline, since
 * our `link` mark renders as `<a href>` with no overriding CSS.
 */
export function removeHyperlinks(): Command {
  return (state, dispatch) => {
    const linkType = schema.marks['link']!;
    const sel = state.selection;
    const from = sel.empty ? 0 : sel.from;
    const to = sel.empty ? state.doc.content.size : sel.to;
    // Pre-scan: bail before constructing a transaction if no run in
    // scope carries the mark. Keeps history clean and lets callers
    // use the return value as "did anything happen?"
    let found = false;
    state.doc.nodesBetween(from, to, (node) => {
      if (found) return false;
      if (node.marks.some((m) => m.type === linkType)) found = true;
      return !found;
    });
    if (!found) return false;
    if (!dispatch) return true;
    dispatch(state.tr.removeMark(from, to, linkType));
    return true;
  };
}

function findPreviousCites(doc: PMNode, $from: ResolvedPos): PMNode[] {
  // Phase 1: look in the cursor's enclosing card for cites whose end
  // is before the cursor.
  let cardDepth = -1;
  for (let d = $from.depth; d >= 0; d--) {
    if ($from.node(d).type.name === 'card') {
      cardDepth = d;
      break;
    }
  }
  if (cardDepth >= 0) {
    const card = $from.node(cardDepth);
    const cardStart = $from.before(cardDepth);
    const cursorPos = $from.pos;
    const here: PMNode[] = [];
    let childStart = cardStart + 1;
    card.forEach((child) => {
      const childEnd = childStart + child.nodeSize;
      if (child.type.name === 'cite_paragraph' && childEnd <= cursorPos) {
        here.push(child);
      }
      childStart = childEnd;
    });
    if (here.length > 0) return here;
  }

  // Phase 2: walk doc-level children backward (from the cursor's
  // enclosing card if any, else from the cursor itself). A "source"
  // is either a card whose children include at least one
  // cite_paragraph OR a run of consecutive free-floating
  // cite_paragraphs at doc level. The most recent source (in
  // document order) wins.
  const limitPos = cardDepth >= 0 ? $from.before(cardDepth) : $from.pos;
  let bestCites: PMNode[] = [];
  let currentGroup: PMNode[] = [];
  let pos = 0;
  doc.forEach((child) => {
    const childEnd = pos + child.nodeSize;
    pos = childEnd;
    if (childEnd > limitPos) return;
    const t = child.type.name;
    if (t === 'cite_paragraph') {
      currentGroup.push(child);
      return;
    }
    // Any non-cite_paragraph node breaks a free-floating cite run.
    if (currentGroup.length > 0) {
      bestCites = currentGroup;
      currentGroup = [];
    }
    if (t === 'card') {
      const found: PMNode[] = [];
      child.forEach((g) => {
        if (g.type.name === 'cite_paragraph') found.push(g);
      });
      if (found.length > 0) bestCites = found;
    }
  });
  if (currentGroup.length > 0) bestCites = currentGroup;
  return bestCites;
}

/** Body-like textblock types whose empty (or whitespace-only) instances
 *  are replaced by the cite rather than left behind. Headings
 *  (pocket/hat/block/tag/analytic) are not in this set — their empty
 *  form is a meaningful slot the user explicitly created. */
const REPLACE_IF_EMPTY = new Set(['paragraph', 'card_body', 'cite_paragraph', 'undertag']);

function isBlankParagraph(node: PMNode): boolean {
  return /^\s*$/.test(node.textContent);
}

interface CitePasteLocation {
  from: number;
  to: number;
}

/**
 * Where to drop the cite content. Three regimes, in priority
 * order:
 *
 *   1. If the cursor's paragraph is an empty body-like slot,
 *      replace it (the user explicitly placed the cursor in a
 *      blank slot — fill it).
 *   2. If the cursor is at the VERY START (parentOffset === 0)
 *      of a body-like paragraph (card_body / cite_paragraph /
 *      undertag / doc-level paragraph), insert the cite right
 *      BEFORE that paragraph — between the previous sibling and
 *      the cursor's paragraph, "where the cursor visually is"
 *      (e.g., between a no-cite card's tag and its first body,
 *      not after that body).
 *   3. Otherwise, insert as a sibling immediately after the
 *      cursor's paragraph. Covers cursor in a tag (cite
 *      naturally belongs after the tag), and cursor mid-/end-
 *      of-body.
 */
function computeCitePasteLocation($from: ResolvedPos): CitePasteLocation {
  if ($from.depth < 1) return { from: 0, to: 0 };
  const para = $from.parent;
  const paraDepth = $from.depth;
  if (REPLACE_IF_EMPTY.has(para.type.name) && isBlankParagraph(para)) {
    return { from: $from.before(paraDepth), to: $from.after(paraDepth) };
  }
  if (REPLACE_IF_EMPTY.has(para.type.name) && $from.parentOffset === 0) {
    const insertPos = $from.before(paraDepth);
    return { from: insertPos, to: insertPos };
  }
  const insertPos = $from.after(paraDepth);
  return { from: insertPos, to: insertPos };
}

function liftCardChild(child: PMNode): PMNode {
  const t = child.type.name;
  if (t === 'card_body' || t === 'cite_paragraph') {
    return schema.nodes['paragraph']!.create(null, child.content);
  }
  if (t === 'analytic') {
    return schema.nodes['analytic_unit']!.create(null, [child]);
  }
  return child;
}

/** Pure node transform: an `analytic_unit` → the equivalent `card`. Reverse
 *  of `cardToAnalyticUnitNode`; the analytic_unit's body slots are already
 *  valid card content, so they pass through unchanged. */
function analyticUnitToCardNode(unit: PMNode): PMNode {
  const analytic = unit.firstChild!;
  const id = (analytic.attrs['id'] as string | null) ?? newHeadingId();
  const tagNode = schema.nodes['tag']!.create({ id }, analytic.content);
  const rest: PMNode[] = [];
  unit.forEach((child, _offset, index) => {
    if (index === 0) return;
    rest.push(child);
  });
  // Same attr carry-through as cardToAnalyticUnitNode (numbering survives).
  return schema.nodes['card']!.create(unit.attrs, [tagNode, ...rest]);
}

function convertAnalyticUnitToCard(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
): boolean {
  const $from = state.selection.$from;
  const base = structuralBaseDepth($from);
  const analytic = $from.parent;
  const unit = $from.node(base + 1);
  if (!dispatch) return true;

  const cardNode = analyticUnitToCardNode(unit);

  const from = $from.before(base + 1);
  const to = $from.after(base + 1);
  let tr = state.tr.replaceWith(from, to, cardNode);
  // After replace: doc → card@from → tag@(from+1) → content@(from+2)
  const cursorPos = from + 2 + Math.min($from.parentOffset, analytic.content.size);
  tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
  // No scrollIntoView — see setTag() above.
  dispatch(tr);
  return true;
}

// ---- Selection-spanning application ----

type StructuralMode =
  | { mode: 'heading'; headingType: HeadingTypeName }
  | { mode: 'tag' }
  | { mode: 'analytic' }
  | { mode: 'undertag' };

/**
 * Compute the doc-child replacement for restyling everything in `[from, to]`
 * to `opts`'s structural type — the shared core of selection-based apply and
 * the shadow bulk-replace. Returns the contiguous doc-child range to replace
 * and the transformed children, or null when nothing intersects or the
 * transform is a no-op (e.g. the range only touched same-type heads with no
 * font_size to clear).
 */
function computeStructuralReplacement(
  state: EditorState,
  from: number,
  to: number,
  opts: StructuralMode,
): { replaceFrom: number; replaceTo: number; newChildren: PMNode[] } | null {
  if (from === to) return null;
  // A trailing selection boundary that merely sits at the START of the
  // next paragraph — the Ctrl-Shift-Down / Shift-Down-past-block-end shape,
  // which lands `to` at offset 0 of the following textblock — means that
  // paragraph has nothing actually selected in it. Pull `to` back across
  // the block's opening boundary so we don't restyle it too.
  const $to = state.doc.resolve(to);
  if ($to.parentOffset === 0 && to - 1 > from) {
    to -= 1;
  }

  let firstIdx = -1;
  let lastIdx = -1;
  let p = 0;
  state.doc.forEach((child, _offset, idx) => {
    const cStart = p;
    const cEnd = p + child.nodeSize;
    if (cEnd > from && cStart < to) {
      if (firstIdx === -1) firstIdx = idx;
      lastIdx = idx;
    }
    p = cEnd;
  });
  if (firstIdx === -1) return null;

  let replaceFrom = -1;
  let replaceTo = -1;
  const newChildren: PMNode[] = [];
  const originalChildren: PMNode[] = [];
  p = 0;
  state.doc.forEach((child, _offset, idx) => {
    const cStart = p;
    const cEnd = p + child.nodeSize;
    p = cEnd;
    if (idx < firstIdx || idx > lastIdx) return;
    if (idx === firstIdx) replaceFrom = cStart;
    if (idx === lastIdx) replaceTo = cEnd;
    originalChildren.push(child);
    transformDocChild(child, cStart, from, to, opts, newChildren);
  });

  if (newChildren.length === 0) return null;
  // Nothing actually transformed (e.g. the selection only touched
  // same-type heads): report null instead of an identical replace —
  // which would burn an undo step and yank the cursor.
  const unchanged =
    newChildren.length === originalChildren.length &&
    newChildren.every((n, i) => n === originalChildren[i] || n.eq(originalChildren[i]!));
  if (unchanged) return null;
  return { replaceFrom, replaceTo, newChildren };
}

/**
 * Apply a structural-style command to every paragraph the selection
 * touches. Selection is contiguous, so the affected paragraphs are
 * contiguous too. Walk the doc-level slice that contains them, rebuild
 * it once, and dispatch a single replaceWith.
 *
 * Rules per affected node:
 *   - doc-level textblock (paragraph / pocket / hat / block / loose
 *     card_body / cite_paragraph / undertag): convert to the target
 *     style. Heading ids are preserved across heading→heading swaps.
 *   - card / analytic_unit: walk children. Once the first touched
 *     child is hit the container is broken — touched children become
 *     headings/tags/analytics, untouched children that follow lift to
 *     doc level (card_body / cite_paragraph → paragraph, undertag
 *     stays, analytic → analytic_unit). Untouched children that
 *     precede the first touched stay inside the original container.
 */
function applyStructuralToSelection(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  opts: StructuralMode,
): boolean {
  const r = computeStructuralReplacement(
    state,
    state.selection.from,
    state.selection.to,
    opts,
  );
  if (!r) return false;
  if (!dispatch) return true;
  const tr = state.tr.replaceWith(
    r.replaceFrom,
    r.replaceTo,
    Fragment.fromArray(r.newChildren),
  );
  // Place cursor at the first text position inside the new range.
  // Selection.near handles the case where replaceFrom+1 is inside a
  // non-textblock container (card / analytic_unit).
  try {
    tr.setSelection(Selection.near(tr.doc.resolve(r.replaceFrom + 1)));
  } catch {
    /* fallback to default mapped selection */
  }
  dispatch(tr);
  return true;
}

/**
 * Bulk *replace* of one structural style with another over a right-click
 * "select all of this style" shadow selection — e.g. select all tags, then
 * press Mod-F7 to turn every one into an analytic; or select all pockets and
 * press F5 to make them hats. The single-block conversion rules already live
 * in `transformDocChild`/`computeStructuralReplacement`; this runs them once
 * per matched block, in one transaction.
 *
 * Each shadow range sits inside one structural block (one doc-level child —
 * a card for a tag, the heading itself for pocket/hat/block), so each yields
 * one independent doc-child replacement. They're applied back-to-front so the
 * earlier (lower) positions stay valid as later ones are rewritten. Only fires
 * for a shadow selection; a same-type target produces no change here (handled
 * by `bulkReapplyStructuralOnShadow`, which clears stray font_size instead).
 * No `META_OPERATING_ON_SHADOW`, so the now-stale matches dissipate.
 */
function bulkReplaceStructuralOnShadow(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  opts: StructuralMode,
): boolean {
  const op = getOperatingRanges(state);
  if (!op.fromShadow || op.ranges.length === 0) return false;
  const repls = new Map<number, { from: number; to: number; nodes: PMNode[] }>();
  for (const range of op.ranges) {
    const $pos = state.doc.resolve(range.from);
    const child = $pos.depth >= 1 ? $pos.node(1) : null;
    const ct = child?.type.name;
    // Container head swaps (tag↔analytic) preserve the container and its
    // body slots — use the dedicated node-builders, not transformDocChild,
    // which would dissolve the card and lift the cite/body to doc level.
    if (child && ct === 'card' && opts.mode === 'analytic') {
      const from = $pos.before(1);
      repls.set(from, { from, to: $pos.after(1), nodes: [cardToAnalyticUnitNode(child)] });
    } else if (child && ct === 'analytic_unit' && opts.mode === 'tag') {
      const from = $pos.before(1);
      repls.set(from, { from, to: $pos.after(1), nodes: [analyticUnitToCardNode(child)] });
    } else {
      // Everything else (heading↔heading swaps, and the rarer cross-tier
      // conversions) goes through the shared selection transform.
      const r = computeStructuralReplacement(state, range.from, range.to, opts);
      if (r) repls.set(r.replaceFrom, { from: r.replaceFrom, to: r.replaceTo, nodes: r.newChildren });
    }
  }
  if (repls.size === 0) return false;
  if (!dispatch) return true;
  const sorted = [...repls.values()].sort((a, b) => b.from - a.from);
  const tr = state.tr;
  for (const r of sorted) {
    tr.replaceWith(r.from, r.to, Fragment.fromArray(r.nodes));
  }
  dispatch(tr.scrollIntoView());
  return true;
}

function transformDocChild(
  child: PMNode,
  childStart: number,
  selFrom: number,
  selTo: number,
  opts: StructuralMode,
  out: PMNode[],
): void {
  const t = child.type.name;

  if (child.isTextblock) {
    // paragraph / pocket / hat / block / loose card_body / cite_paragraph / undertag
    out.push(asTransformed(child, opts));
    return;
  }

  if (t === 'card' || t === 'analytic_unit') {
    let hitTouched = false;
    let preChanged = false;
    const preChildren: PMNode[] = [];
    const liftedChildren: PMNode[] = [];
    child.forEach((g, offset) => {
      const gStart = childStart + 1 + offset;
      const gEnd = gStart + g.nodeSize;
      const inSel = gEnd > selFrom && gStart < selTo;
      // A child the command would re-create as the type it already is
      // (F7 with a selection inside a tag, Mod-F7 on analytic text,
      // Mod-F8 on an undertag) counts as UNTOUCHED: the equivalent
      // cursor gesture is a no-op, and treating it as touched would
      // dissolve the container — orphaning the cite/body that follow.
      // Re-pressing the shortcut on a same-type head still resets it
      // toward canonical (clears indent + direct font-size /
      // font-color marks; see clearReapplyFormatting), mirroring the
      // cursor re-press, but leaves the container intact.
      const sameType = isSameTypeTarget(g, opts);
      const gTouched = inSel && !sameType;
      if (gTouched) {
        hitTouched = true;
        liftedChildren.push(asTransformed(g, opts));
      } else if (hitTouched) {
        liftedChildren.push(liftCardChild(inSel && sameType ? clearReapplyFormatting(g) : g));
      } else {
        const kept = inSel && sameType ? clearReapplyFormatting(g) : g;
        if (kept !== g) preChanged = true;
        preChildren.push(kept);
      }
    });

    if (liftedChildren.length === 0) {
      // No container break. If a same-type head had its formatting reset in
      // place, rebuild the container with the cleaned children; otherwise pass
      // the original through untouched.
      out.push(preChanged ? child.copy(Fragment.fromArray(preChildren)) : child);
      return;
    }
    if (preChildren.length === 0) {
      out.push(...liftedChildren);
      return;
    }
    out.push(child.copy(Fragment.fromArray(preChildren)));
    out.push(...liftedChildren);
    return;
  }

  // Anything else (e.g., nested doc structures not in our schema) — pass through.
  out.push(child);
}

/** True when the transform would re-create the node as the same
 *  structural type it already is. */
function isSameTypeTarget(child: PMNode, opts: StructuralMode): boolean {
  const t = child.type.name;
  return (
    (opts.mode === 'tag' && t === 'tag') ||
    (opts.mode === 'analytic' && t === 'analytic') ||
    (opts.mode === 'undertag' && t === 'undertag') ||
    (opts.mode === 'heading' && t === opts.headingType)
  );
}

function asTransformed(child: PMNode, opts: StructuralMode): PMNode {
  const existingId =
    typeof child.attrs['id'] === 'string' && child.attrs['id']
      ? (child.attrs['id'] as string)
      : null;
  // Selection-based promotion replaces the source paragraph entirely;
  // strip named-style and direct-formatting marks so the new structural
  // block carries only the canonical typography. Exception: tag↔analytic
  // is a same-tier swap (same structural role, different cite/analytic
  // semantic) so direct formatting carries through.
  const sameTierSwap =
    (opts.mode === 'tag' || opts.mode === 'analytic') &&
    (child.type.name === 'tag' || child.type.name === 'analytic');
  const cleanContent = sameTierSwap
    ? child.content
    : stripPromotionMarksOnFragment(child.content);
  if (opts.mode === 'undertag') {
    // Undertag has no id and no wrapping container — at doc level it
    // sits as a sibling, inside a card it sits among the body slots.
    return schema.nodes['undertag']!.create(null, cleanContent);
  }
  const id = existingId ?? newHeadingId();
  if (opts.mode === 'heading') {
    return schema.nodes[opts.headingType]!.create({ id }, cleanContent);
  }
  if (opts.mode === 'tag') {
    const tag = schema.nodes['tag']!.create({ id }, cleanContent);
    return schema.nodes['card']!.create(null, [tag]);
  }
  const a = schema.nodes['analytic']!.create({ id }, cleanContent);
  return schema.nodes['analytic_unit']!.create(null, [a]);
}

// ---- Keymap binding registry ----

/**
 * Stable identifiers for editor command bindings. The settings UI
 * stores user overrides keyed by these IDs — not by the current
 * key string — so renaming a default key doesn't strand user
 * customizations.
 *
 * `StructuralRibbonCommandId` is the subset rendered as buttons in
 * the formatting panel.
 */
export type StructuralRibbonCommandId =
  | 'setPocket'
  | 'setHat'
  | 'setBlock'
  | 'setTag'
  | 'setAnalytic'
  | 'setUndertag';

export type RibbonCommandId =
  | StructuralRibbonCommandId
  | 'moveContainerUp'
  | 'moveContainerDown'
  | 'toggleBold'
  | 'toggleItalic'
  | 'toggleStrikethrough'
  | 'toggleSuperscript'
  | 'toggleSubscript'
  | 'applyCite'
  | 'applyUnderline'
  | 'toggleUnderlineTyping'
  | 'toggleReadingMarker'
  | 'applyEmphasis'
  | 'emphasizeAcronym'
  | 'applyHighlight'
  | 'highlightAcronym'
  | 'underlineAcronym'
  | 'applyShading'
  | 'condenseDefault'
  | 'condenseNoIntegrity'
  | 'condenseNoIntegrityWithPilcrows'
  | 'condenseWithWarning'
  | 'uncondense'
  | 'toggleCase'
  | 'copyPreviousCite'
  | 'pasteAsText'
  | 'pasteCondensed'
  | 'clearToNormal'
  | 'shrink'
  | 'smartShrink'
  | 'regrow'
  | 'createReference'
  | 'lockHighlighting'
  | 'extractUndertag'
  | 'highlightToShading'
  | 'shadingToHighlight'
  | 'standardizeHighlight'
  | 'standardizeShading'
  | 'standardizeHighlightExcept'
  | 'standardizeShadingExcept'
  | 'convertCardsToReadMode'
  | 'toggleReadMode'
  | 'toggleReaderView'
  | 'openContainingFolder'
  | 'toggleCommentsVisible'
  | 'addCommentToSelection'
  | 'addNoteToSelection'
  | 'aiAskAboutSelection'
  | 'aiCreateCite'
  | 'reformatAllCites'
  | 'translate'
  | 'repairText'
  | 'repairFormatting'
  | 'repairParagraphIntegrity'
  | 'sendToFlowColumn'
  | 'sendToFlowCell'
  | 'sendHeadingsToFlowColumn'
  | 'sendHeadingsToFlowCell'
  | 'pullFromFlow'
  | 'createFlow'
  | 'startFlowHost'
  | 'toggleVoice'
  | 'openCardCutter'
  | 'addCutterContext'
  | 'openCutterGuidance'
  | 'createFlashcard'
  | 'manageFlashcards'
  | 'wordCountSelection'
  | 'openShortcutsReference'
  | 'startUiTour'
  | 'selectSimilar'
  | 'removeHyperlinks'
  | 'convertAnalyticsToTags'
  | 'convertCitedAnalyticsToTags'
  | 'fixFormattingGaps'
  | 'insertTable'
  | 'addRowAfter'
  | 'addRowBefore'
  | 'deleteTableRow'
  | 'addColumnAfter'
  | 'addColumnBefore'
  | 'deleteTableColumn'
  | 'mergeTableCells'
  | 'splitTableCell'
  | 'deleteTable'
  | 'newDocument'
  | 'openFile'
  | 'save'
  | 'saveAs'
  | 'saveSendDoc'
  | 'saveMarkedCards'
  | 'toggleAutosave'
  | 'newSpeechDocument'
  | 'markActiveAsSpeech'
  | 'sendToSpeechAtCursor'
  | 'sendToSpeechAtEnd'
  | 'sendToDropzone'
  | 'insertLiveZone'
  | 'insertSelfLiveZone'
  | 'insertInDocCopy'
  | 'refreshLiveZone'
  | 'refreshAllLiveZones'
  | 'checkLiveZoneSources'
  | 'detachLiveZone'
  | 'sendToStarred'
  | 'sendToRecipient'
  | 'insertReceivedAtCursor'
  | 'insertReceivedAtEnd'
  // Select / copy the cursor's enclosing structure (the current card /
  // analytic_unit / heading + its subtree), reusing the send-to-*
  // bounds logic but keyed off the cursor — any active selection is
  // ignored. No default bindings — wire up via Settings → Keyboard shortcuts.
  | 'selectCurrentHeading'
  | 'deleteCurrentHeading'
  // Auto-numbering skeleton authoring (NUMBERING_PLAN.md §4).
  | 'toggleNumberRole'
  | 'toggleSubRole'
  | 'toggleNumRestart'
  | 'copyCurrentHeading'
  // Quick Cards (see reference-docs/SPEC-quick-cards.md). Add saves the
  // current selection as a named, tagged snippet (no default binding);
  // the search palette opens on Mod-Shift-Space.
  | 'addQuickCard'
  | 'manageQuickCards'
  | 'openQuickCardSearch'
  | 'collabStartSession'
  | 'collabJoinSession'
  | 'collabCopyShareCode'
  | 'collabCopyInviteLink'
  | 'collabInviteStarred'
  | 'collabEndSession'
  | 'insertImage'
  | 'openDevConsole'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'chromeScaleUp'
  | 'chromeScaleDown'
  | 'chromeScaleReset'
  | 'togglePaintbrushHighlight'
  | 'togglePaintbrushShading'
  | 'openFind'
  | 'openFindReplace'
  | 'openFindByProximity'
  | 'toggleNavPane'
  // Commands that ship without a default binding — bindable via
  // Settings → Keyboard shortcuts. Each maps to a ribbon button or
  // menu item.
  | 'adjustFontSizeUp'
  | 'adjustFontSizeDown'
  | 'applyFontColor'
  | 'openSettings'
  // Minimize the OS window. Desktop-only; the macOS Window menu's
  // Minimize item routes through this same command so its accelerator
  // follows user rebinds (Mod-m default restores the stock Cmd+M).
  | 'minimizeWindow'
  | 'openJournalsFolder'
  // Arm/disarm Morph mode (the Sensel control-surface interpreter).
  // No default key — bind via Settings, or run from the command bar.
  | 'toggleMorphMode'
  // Open an earlier state of a co-edited document as its own unsaved
  // copy, from the session-history file. No default key.
  | 'recoverPreviousVersion'
  // Cycle the theme setting light → dark → system → light. No default
  // binding; bind via Settings → Keyboard shortcuts.
  | 'cycleTheme'
  // Cycle the timer profile College → High School → Pomodoro (wraps),
  // applying its durations. No default binding.
  | 'cycleTimerPreset'
  // Flip every curly quote in the selection to the opposite direction. No
  // default binding.
  | 'flipQuoteDirection'
  | 'toggleParagraphIntegrity'
  | 'selectSpeechDoc'
  | 'goHome'
  | 'openHighlightPicker'
  | 'openShadingPicker'
  | 'openFontColorPicker'
  | 'openFontSizePicker'
  | 'openDocToolsMenu'
  | 'openCardToolsMenu'
  | 'openTableMenu'
  // Multi-pane workspace navigation, listed for user-rebindability
  // via Settings → Keyboard shortcuts; the shell owns the
  // implementations and the global keydown handler in
  // editor/index.ts dispatches when the key fires. No-ops in
  // single-doc mode.
  | 'focusSlot1'
  | 'focusSlot2'
  | 'focusSlot3'
  | 'sendDocToSlot1'
  | 'sendDocToSlot2'
  | 'sendDocToSlot3'
  | 'toggleSlotExpand'
  | 'cycleDocNext'
  | 'cycleDocPrev'
  // Smart close — closes the focused slot's visible doc in
  // multi-pane mode; falls through to the standard window-close
  // prompt otherwise. Menu accelerator (Ctrl+W) stays
  // hardcoded as a discoverability cue; this registry entry is
  // the user-rebindable layer.
  | 'closeDocOrWindow'
  // Timer transport. All gated on the timer panel being visible
  // (they return false when it's hidden so the key falls through);
  // none has a default binding — wire up via Settings → Keyboard
  // shortcuts.
  // Timer state is BroadcastChannel-synced, so a key press in one
  // window drives the clocks in every window, like the buttons.
  // Show/hide is the one timer command NOT gated on visibility —
  // its whole point is bringing the panel up. Mirrors the ribbon
  // timer button (aria-pressed toggle in index.ts).
  // Insert an empty footnote at the cursor and open its editor.
  // No default binding and no menu entry — a keyboard-only power
  // feature.
  | 'insertFootnote'
  | 'timerToggleVisible'
  | 'timerStartPause'
  | 'timerPreset1'
  | 'timerPreset2'
  | 'timerPreset3'
  | 'timerStartAffPrep'
  | 'timerStartNegPrep'
  | 'timerReset';

export const STRUCTURAL_RIBBON_COMMAND_IDS: StructuralRibbonCommandId[] = [
  'setPocket',
  'setHat',
  'setBlock',
  'setTag',
  'setAnalytic',
  'setUndertag',
];

export const RIBBON_COMMAND_IDS: RibbonCommandId[] = [
  ...STRUCTURAL_RIBBON_COMMAND_IDS,
  'moveContainerUp',
  'moveContainerDown',
  'toggleBold',
  'toggleItalic',
  'toggleStrikethrough',
  'toggleSuperscript',
  'toggleSubscript',
  'applyCite',
  'applyUnderline',
  'toggleUnderlineTyping',
  'toggleReadingMarker',
  'applyEmphasis',
  'emphasizeAcronym',
  'applyHighlight',
  'highlightAcronym',
  'underlineAcronym',
  'applyShading',
  'condenseDefault',
  'condenseNoIntegrity',
  'condenseNoIntegrityWithPilcrows',
  'condenseWithWarning',
  'uncondense',
  'toggleCase',
  'copyPreviousCite',
  'pasteAsText',
  'pasteCondensed',
  'clearToNormal',
  'shrink',
  'smartShrink',
  'regrow',
  'createReference',
  'lockHighlighting',
  'extractUndertag',
  'highlightToShading',
  'shadingToHighlight',
  'standardizeHighlight',
  'standardizeShading',
  'standardizeHighlightExcept',
  'standardizeShadingExcept',
  'convertCardsToReadMode',
  'toggleReadMode',
  'toggleReaderView',
  'openContainingFolder',
  'toggleCommentsVisible',
  'addCommentToSelection',
  'addNoteToSelection',
  'aiAskAboutSelection',
  'aiCreateCite',
  'reformatAllCites',
  'translate',
  'repairText',
  'repairFormatting',
  'repairParagraphIntegrity',
  'sendToFlowColumn',
  'sendToFlowCell',
  'sendHeadingsToFlowColumn',
  'sendHeadingsToFlowCell',
  'pullFromFlow',
  'createFlow',
  'startFlowHost',
  'toggleVoice',
  'openCardCutter',
  'addCutterContext',
  'openCutterGuidance',
  'createFlashcard',
  'manageFlashcards',
  'wordCountSelection',
  'openShortcutsReference',
  'startUiTour',
  'selectSimilar',
  'removeHyperlinks',
  'convertAnalyticsToTags',
  'convertCitedAnalyticsToTags',
  'fixFormattingGaps',
  'insertTable',
  'addRowAfter',
  'addRowBefore',
  'deleteTableRow',
  'addColumnAfter',
  'addColumnBefore',
  'deleteTableColumn',
  'mergeTableCells',
  'splitTableCell',
  'deleteTable',
  'newDocument',
  'openFile',
  'save',
  'saveAs',
  'saveSendDoc',
  'saveMarkedCards',
  'toggleAutosave',
  'newSpeechDocument',
  'markActiveAsSpeech',
  'sendToSpeechAtCursor',
  'sendToSpeechAtEnd',
  'sendToDropzone',
  'insertLiveZone',
  'insertSelfLiveZone',
  'insertInDocCopy',
  'refreshLiveZone',
  'refreshAllLiveZones',
  'checkLiveZoneSources',
  'detachLiveZone',
  'sendToStarred',
  'sendToRecipient',
  'insertReceivedAtCursor',
  'insertReceivedAtEnd',
  'selectCurrentHeading',
  'deleteCurrentHeading',
  'toggleNumberRole',
  'toggleSubRole',
  'toggleNumRestart',
  'copyCurrentHeading',
  'addQuickCard',
  'manageQuickCards',
  'openQuickCardSearch',
  'collabStartSession',
  'collabJoinSession',
  'collabCopyShareCode',
  'collabCopyInviteLink',
  'collabInviteStarred',
  'collabEndSession',
  'insertImage',
  'openDevConsole',
  'zoomIn',
  'zoomOut',
  'zoomReset',
  'chromeScaleUp',
  'chromeScaleDown',
  'chromeScaleReset',
  'togglePaintbrushHighlight',
  'togglePaintbrushShading',
  'openFind',
  'openFindReplace',
  'openFindByProximity',
  'toggleNavPane',
  // Bindable ribbon actions with no default keys.
  'adjustFontSizeUp',
  'adjustFontSizeDown',
  'applyFontColor',
  'openSettings',
  'minimizeWindow',
  'openJournalsFolder',
  'toggleMorphMode',
  'recoverPreviousVersion',
  'cycleTheme',
  'cycleTimerPreset',
  'flipQuoteDirection',
  'toggleParagraphIntegrity',
  'selectSpeechDoc',
  'goHome',
  'openHighlightPicker',
  'openShadingPicker',
  'openFontColorPicker',
  'openFontSizePicker',
  'openDocToolsMenu',
  'openCardToolsMenu',
  'openTableMenu',
  'focusSlot1',
  'focusSlot2',
  'focusSlot3',
  'sendDocToSlot1',
  'sendDocToSlot2',
  'sendDocToSlot3',
  'toggleSlotExpand',
  'cycleDocNext',
  'cycleDocPrev',
  'closeDocOrWindow',
  'insertFootnote',
  'timerToggleVisible',
  'timerStartPause',
  'timerPreset1',
  'timerPreset2',
  'timerPreset3',
  'timerStartAffPrep',
  'timerStartNegPrep',
  'timerReset',
];

export const RIBBON_COMMAND_LABELS: Record<RibbonCommandId, string> = {
  setPocket: 'Apply Pocket Style',
  setHat: 'Apply Hat Style',
  setBlock: 'Apply Block Style',
  setTag: 'Apply Tag Style',
  setAnalytic: 'Apply Analytic Style',
  setUndertag: 'Apply Undertag Style',
  moveContainerUp: 'Move Container Up',
  moveContainerDown: 'Move Container Down',
  toggleBold: 'Bold',
  toggleItalic: 'Italic',
  toggleStrikethrough: 'Strikethrough',
  toggleSuperscript: 'Superscript',
  toggleSubscript: 'Subscript',
  applyCite: 'Apply Cite Style',
  applyUnderline: 'Toggle Underline',
  toggleUnderlineTyping: 'Underline (toggle while typing)',
  toggleReadingMarker: 'Reading-position marker (toggle)',
  applyEmphasis: 'Apply Emphasis Style',
  emphasizeAcronym: 'Emphasize Acronym',
  applyHighlight: 'Toggle Highlight',
  highlightAcronym: 'Highlight Acronym',
  underlineAcronym: 'Underline Acronym',
  applyShading: 'Toggle Background Color',
  condenseDefault: 'Condense',
  condenseNoIntegrity: 'Condense Without Paragraph Integrity',
  condenseNoIntegrityWithPilcrows: 'Condense Without Paragraph Integrity (With Pilcrows)',
  condenseWithWarning: 'Condense With Warning',
  uncondense: 'Uncondense',
  toggleCase: 'Toggle Case',
  copyPreviousCite: 'Copy Previous Cite',
  pasteAsText: 'Paste Plain Text',
  pasteCondensed: 'Paste and Destructively Condense',
  clearToNormal: 'Clear',
  shrink: 'Shrink Card Text',
  smartShrink: 'Smart Shrink (Deeper for Unmarked Paragraphs)',
  regrow: 'Restore Card Text Size',
  createReference: 'Create Reference',
  lockHighlighting: 'Lock Highlighting',
  extractUndertag: 'Extract Undertag',
  highlightToShading: 'Highlight to Background',
  shadingToHighlight: 'Background to Highlight',
  standardizeHighlight: 'Standardize Highlighting',
  standardizeShading: 'Standardize Background Color',
  standardizeHighlightExcept: 'Standardize Highlighting (with Exception)',
  standardizeShadingExcept: 'Standardize Background Color (with Exception)',
  convertCardsToReadMode: 'Convert Cards to Read Mode',
  toggleReadMode: 'Toggle Read Mode',
  toggleReaderView: 'Toggle Reading View',
  openContainingFolder: 'Open Containing Folder',
  toggleCommentsVisible: 'Show / Hide Comments',
  addCommentToSelection: 'Add Comment to Selection',
  addNoteToSelection: 'Add Note to Selection',
  aiAskAboutSelection: 'Ask AI About Selection',
  aiCreateCite: 'Format Cite From Selection (AI)',
  reformatAllCites: 'Reformat Every Cite in Document (AI)',
  translate: 'Translate Selection to Clipboard (AI)',
  repairText: 'Repair OCR/PDF Text (AI)',
  repairFormatting: 'Repair Formatting (AI)',
  repairParagraphIntegrity: 'Repair Paragraph Integrity',
  sendToFlowColumn: 'Send to Flow (one cell per line)',
  sendToFlowCell: 'Send to Flow (single cell)',
  sendHeadingsToFlowColumn: 'Send Headings to Flow (one cell per line)',
  sendHeadingsToFlowCell: 'Send Headings to Flow (single cell)',
  pullFromFlow: 'Pull Selection from Flow',
  createFlow: 'Create New Flow',
  startFlowHost: 'Start Flow Connection',
  toggleVoice: 'Toggle voice control',
  openCardCutter: 'Cut card with AI…',
  addCutterContext: 'Use Selection as Cutter Context',
  openCutterGuidance: 'Edit File Cutting Guidance',
  createFlashcard: 'Create Flashcard From Selection',
  manageFlashcards: 'Manage Flashcards',
  wordCountSelection: 'Word Count Selection',
  openShortcutsReference: 'Open Keyboard Shortcuts',
  startUiTour: 'Take the UI Tour',
  selectSimilar: 'Select Similar Formatting',
  removeHyperlinks: 'Remove Hyperlinks',
  convertAnalyticsToTags: 'Convert Analytics to Tags',
  convertCitedAnalyticsToTags: 'Convert Cited Analytics to Tags',
  fixFormattingGaps: 'Fix Formatting Gaps',
  insertTable: 'Insert Table',
  addRowAfter: 'Insert Row Below',
  addRowBefore: 'Insert Row Above',
  deleteTableRow: 'Delete Row',
  addColumnAfter: 'Insert Column Right',
  addColumnBefore: 'Insert Column Left',
  deleteTableColumn: 'Delete Column',
  mergeTableCells: 'Merge Cells',
  splitTableCell: 'Split Cell',
  deleteTable: 'Delete Table',
  newDocument: 'New Document',
  openFile: 'Open File',
  save: 'Save',
  saveAs: 'Save As…',
  saveSendDoc: 'Save Send Doc',
  saveMarkedCards: 'Save Marked Cards',
  toggleAutosave: 'Toggle Autosave',
  newSpeechDocument: 'New Speech Document',
  markActiveAsSpeech: 'Mark / Unmark Active Doc as the Speech Doc',
  sendToSpeechAtCursor: 'Send to Speech (At Cursor)',
  sendToSpeechAtEnd: 'Send to Speech (At End)',
  sendToDropzone: 'Send to Dropzone',
  insertLiveZone: 'Insert Linked Copy from a File',
  insertSelfLiveZone: 'Insert Live View',
  insertInDocCopy: 'Insert Linked Copy from This Document',
  refreshLiveZone: 'Refresh Linked Copy',
  refreshAllLiveZones: 'Refresh All Linked Copies',
  checkLiveZoneSources: 'Check Linked Copy Sources for Updates',
  detachLiveZone: 'Unlink Copy',
  sendToStarred: 'Send to Starred Recipient',
  sendToRecipient: 'Send to Recipient…',
  insertReceivedAtCursor: 'Insert Received Card (At Cursor)',
  insertReceivedAtEnd: 'Insert Received Card (At End)',
  selectCurrentHeading: 'Select Current Heading',
  deleteCurrentHeading: 'Delete Current Heading',
  toggleNumberRole: 'Number: Toggle Number Role',
  toggleSubRole: 'Number: Toggle Substructure Role',
  toggleNumRestart: 'Number: Toggle Start-Over-Here',
  copyCurrentHeading: 'Copy Current Heading',
  addQuickCard: 'Add Quick Card',
  manageQuickCards: 'Manage Quick Cards',
  openQuickCardSearch: 'Search Everything',
  collabStartSession: 'Start Collaboration Session',
  collabJoinSession: 'Join Collaboration Session',
  collabCopyShareCode: 'Copy Session Share Code',
  collabCopyInviteLink: 'Copy Session Invite Link',
  collabInviteStarred: 'Invite Starred Partner to Session',
  collabEndSession: 'End or Leave Collaboration Session',
  insertImage: 'Insert Image at Cursor',
  openDevConsole: 'Open Developer Console',
  zoomIn: 'Zoom In',
  zoomOut: 'Zoom Out',
  zoomReset: 'Reset Zoom to 100%',
  chromeScaleUp: 'Chrome Scale Up',
  chromeScaleDown: 'Chrome Scale Down',
  chromeScaleReset: 'Reset Chrome Scale to 100%',
  togglePaintbrushHighlight: 'Toggle Highlight Paint Mode',
  togglePaintbrushShading: 'Toggle Background-Color Paint Mode',
  openFind: 'Find',
  openFindReplace: 'Find and Replace',
  openFindByProximity: 'Find Without Category Grouping',
  toggleNavPane: 'Show / Hide Navigation Pane',
  adjustFontSizeUp: 'Increase Font Size by 1pt',
  adjustFontSizeDown: 'Decrease Font Size by 1pt',
  applyFontColor: 'Apply Font Color',
  openSettings: 'Open Settings',
  minimizeWindow: 'Minimize Window',
  openJournalsFolder: 'Open Crash-Recovery Journals Folder',
  toggleMorphMode: 'Toggle Morph Mode',
  recoverPreviousVersion: 'Recover Previous Version',
  cycleTheme: 'Cycle Theme (Light → Dark → System)',
  cycleTimerPreset: 'Cycle Timer Preset (College → High School → Pomodoro)',
  flipQuoteDirection: 'Flip Quote Direction',
  toggleParagraphIntegrity: 'Toggle Paragraph Integrity',
  selectSpeechDoc: 'Select Speech Document',
  goHome: 'Go to Home Screen',
  openHighlightPicker: 'Open Highlight Color Picker',
  openShadingPicker: 'Open Background Color Picker',
  openFontColorPicker: 'Open Font Color Picker',
  openFontSizePicker: 'Open Font Size Picker',
  openDocToolsMenu: 'Open Doc Tools Menu',
  openCardToolsMenu: 'Open Card Tools Menu',
  openTableMenu: 'Open Table Menu',
  focusSlot1: 'Focus Slot 1',
  focusSlot2: 'Focus Slot 2',
  focusSlot3: 'Focus Slot 3',
  sendDocToSlot1: 'Send Doc to Slot 1',
  sendDocToSlot2: 'Send Doc to Slot 2',
  sendDocToSlot3: 'Send Doc to Slot 3',
  toggleSlotExpand: 'Toggle Slot Expand / Restore',
  cycleDocNext: 'Next Document in Slot',
  cycleDocPrev: 'Previous Document in Slot',
  closeDocOrWindow: 'Close Doc or Window',
  insertFootnote: 'Insert Footnote',
  timerToggleVisible: 'Timer: Show / Hide Panel',
  timerStartPause: 'Timer: Start / Pause',
  timerPreset1: 'Timer: Start Speech Preset 1',
  timerPreset2: 'Timer: Start Speech Preset 2',
  timerPreset3: 'Timer: Start Speech Preset 3',
  timerStartAffPrep: 'Timer: Start Aff Prep',
  timerStartNegPrep: 'Timer: Start Neg Prep',
  timerReset: 'Timer: Reset',
};

/**
 * Extra search terms for the command palette, keyed by command id.
 * The display label stays `RIBBON_COMMAND_LABELS`; these are matched
 * (never shown) so a query phrased differently than the label still
 * surfaces the command. Two recurring cases drive most of these:
 *   - show/hide ⇄ toggle: a visibility command labeled one way should
 *     also answer to the other phrasing.
 *   - vague or Word-flavored labels: "Clear" is really "clear
 *     formatting"; "Paste Plain Text" is what Word calls "paste
 *     without formatting".
 * Keep entries lowercase. Only commands that need an alias appear here.
 */
export const RIBBON_COMMAND_ALIASES: Partial<Record<RibbonCommandId, readonly string[]>> = {
  sendToRecipient: ['send to contact', 'send card to', 'pick recipient', 'send to group'],
  minimizeWindow: ['minimize', 'hide window', 'window menu'],
  openJournalsFolder: ['crash', 'recovery', 'journal', 'restore', 'lost work', 'autosave folder'],
  toggleMorphMode: ['morph', 'sensel', 'control surface', 'jog wheel', 'overlay'],
  recoverPreviousVersion: ['history', 'version', 'restore', 'rollback', 'vandalism', 'session history'],
  collabStartSession: ['collaborate', 'coedit', 'co-edit', 'share session', 'live edit'],
  collabJoinSession: ['join session', 'share code', 'coedit'],
  collabCopyShareCode: ['share code', 'invite code', 'session code'],
  collabCopyInviteLink: ['invite link', 'share link', 'join link', 'session link'],
  collabInviteStarred: ['invite partner', 'session invite', 'invite to session'],
  openDevConsole: ['devtools', 'dev console', 'debug console', 'inspect', 'developer tools'],
  collabEndSession: ['leave session', 'stop session', 'stop collaborating'],
  repairParagraphIntegrity: [
    'paragraph integrity',
    'split paragraphs',
    'add paragraph breaks',
    'paragraph starts',
  ],
  // show/hide ⇄ toggle visibility pairs
  toggleCommentsVisible: ['toggle comments', 'comments'],
  toggleNavPane: ['toggle navigation pane', 'toggle nav pane', 'sidebar', 'outline pane'],
  convertCardsToReadMode: ['zap card', 'zap cards'],
  toggleReadMode: ['show read mode', 'hide read mode', 'invisibility mode'],
  toggleReaderView: ['reading view', 'reader view', 'paginated view', 'read view', 'book view', 'columns'],
  openContainingFolder: ['reveal in finder', 'show in folder', 'show in explorer', 'reveal file', 'file location', 'containing folder'],
  toggleAutosave: ['enable autosave', 'disable autosave', 'turn on autosave', 'turn off autosave'],
  markActiveAsSpeech: ['toggle speech doc', 'set speech document'],
  // vague / Word-flavored labels
  clearToNormal: ['clear formatting', 'remove formatting', 'clear to normal'],
  lockHighlighting: ['lock highlights', 'grey highlights', 'gray highlights', 'rehighlight'],
  standardizeHighlightExcept: ['standardize except', 'standardize highlighting except', 'exception highlight'],
  standardizeShadingExcept: ['standardize background except', 'standardize shading except', 'exception shading'],
  regrow: ['unshrink', 'regrow', 'restore text size', 'unshrink card text'],
  smartShrink: ['smart shrink', 'deep shrink'],
  aiAskAboutSelection: ['question'],
  reformatAllCites: ['reformat all cites', 'reformat cites', 'all cites', 'every cite', 'bulk cite'],
  pasteAsText: ['paste without formatting', 'paste unformatted', 'paste text'],
  pasteCondensed: ['paste condense', 'paste merge', 'paste flatten', 'paste no paragraphs', 'destructive paste'],
  removeHyperlinks: ['remove links', 'unlink'], // "delete …" via the delete/remove synonym group
  applyShading: ['shading', 'text highlight color'],
  insertImage: ['add image', 'insert picture', 'photo'],
  // "Insert …" element commands also answer to "add …" (genuine equivalence —
  // unlike Add Quick Card / Add Comment / Add Note, which CREATE, not insert).
  insertTable: ['add table'],
  addRowBefore: ['add row above'],
  addRowAfter: ['add row below'],
  addColumnBefore: ['add column left'],
  addColumnAfter: ['add column right'],
  insertReceivedAtCursor: ['add received card at cursor'],
  insertReceivedAtEnd: ['add received card at end'],
  moveContainerUp: ['move up', 'move card up', 'move section up', 'reorder up', 'shift up'],
  moveContainerDown: ['move down', 'move card down', 'move section down', 'reorder down', 'shift down'],
  goHome: ['start screen', 'welcome screen', 'dashboard'],
  openShortcutsReference: ['hotkeys', 'key bindings', 'shortcuts'],
  startUiTour: ['tour', 'onboarding', 'walkthrough', 'coach marks', 'tutorial'],
  zoomReset: ['actual size'],
  cycleTheme: ['dark mode', 'light mode', 'toggle theme', 'switch theme', 'appearance'],
  cycleTimerPreset: ['switch timer preset', 'toggle timer preset', 'next timer preset', 'change timer preset', 'timer profile', 'timer preset'],
  insertFootnote: ['footnote', 'endnote', 'add footnote', 'new footnote', 'note'],
  insertLiveZone: [
    'linked copy from a file',
    'transclude',
    'transclusion',
    'embed from file',
    'live zone',
    'pull card',
    'link section',
  ],
  insertSelfLiveZone: [
    // create ⇄ insert: genuine equivalence for live views (nothing exists
    // until the command runs either way) — both phrasings must find it.
    'create live view',
    'new live view',
    'live view',
    'live window',
    'embed section',
    'mirror section',
    'view a section',
    'transclude section',
    'ted nelson',
  ],
  insertInDocCopy: [
    'linked copy from this document',
    'copy a section',
    'embed copy',
    'linked copy this doc',
    'transclude copy',
    'duplicate section linked',
  ],
  refreshLiveZone: ['refresh transclusion', 'update copy', 'sync copy', 'pull source'],
  refreshAllLiveZones: [
    'refresh all transclusions',
    'update all copies',
    'refresh whole document',
    'refresh every copy',
  ],
  checkLiveZoneSources: [
    'check linked copies',
    'check for source updates',
    'check copy sources',
    'have copy sources changed',
    'linked copy updates',
  ],
  detachLiveZone: ['detach transclusion', 'unlink live zone', 'break live zone link'],
  timerToggleVisible: ['show timer', 'hide timer', 'toggle timer', 'timer panel'],
  timerStartPause: ['start timer', 'pause timer', 'speech timer', 'play timer'],
  timerPreset1: ['timer 9', 'first speech preset'],
  timerPreset2: ['timer 6', 'second speech preset'],
  timerPreset3: ['timer 3', 'third speech preset'],
  timerStartAffPrep: ['aff prep', 'affirmative prep', 'prep timer'],
  timerStartNegPrep: ['neg prep', 'negative prep', 'prep timer'],
  timerReset: ['reset timer', 'reset prep'],
  flipQuoteDirection: ['flip quotes', 'curly quotes', 'reverse quote direction', 'smart quote direction', 'fix apostrophe', 'quote direction'],
  deleteCurrentHeading: ['delete card', 'delete heading', 'delete current card'], // "remove …" via the delete/remove synonym group
  toggleNumberRole: ['number', 'numbering', 'numbered card', 'auto number', 'list number'],
  toggleSubRole: ['substructure', 'sub number', 'sub letter', 'numbering', 'sublist', 'letter'],
  toggleNumRestart: ['restart numbering', 'start over', 'renumber', 'continue numbering', 'number restart'],
  saveSendDoc: ['send doc', 'export send doc', 'send version'],
  saveMarkedCards: ['marked cards', 'extract marked cards', 'export marked cards', 'save marked'],
  startFlowHost: ['warm flow', 'prewarm flow', 'flow connection', 'connect to flow', 'speed up flow'],
  toggleVoice: ['voice control', 'voice mode', 'dictation', 'speech', 'microphone', 'start voice', 'stop voice'],
  // The cutter shortcut serves double duty for its highlighting verbs, so
  // those names resolve to it too.
  openCardCutter: [
    'cut card', 'card cutter', 'trim card', 'ai cut', 'auto highlight',
    'highlight', 'add highlight', 'dehighlight', 'remove highlight', 'unhighlight',
    'refine highlighting', 'refine highlight', 'rehighlight', 'fix highlighting',
  ],
  addCutterContext: ['cutter context', 'context section', 'designate context', 'cutting context'],
  openCutterGuidance: ['file guidance', 'cutting guidance', 'cutter guidance', 'how this file works'],
  // Spelled-out slot numbers, so "one" / "two" / "three" surface the
  // slot focus (switch) + send-to-slot commands in the command bar.
  focusSlot1: ['one'],
  focusSlot2: ['two'],
  focusSlot3: ['three'],
  sendDocToSlot1: ['one'],
  sendDocToSlot2: ['two'],
  sendDocToSlot3: ['three'],
};

/**
 * Default key bindings. The value is a single key or an array of
 * keys; all bindings invoke the same command. The first entry is the
 * "primary" binding used for ribbon-button tooltips; the rest are
 * aliases (visible in the keybindings editor). Verbatim's hotkeys
 * win where they exist; Word's Mod-B / Mod-I / Mod-U cover the
 * inline marks.
 */
export const DEFAULT_RIBBON_KEYS: Record<RibbonCommandId, string | string[]> = {
  setPocket: 'F4',
  setHat: 'F5',
  setBlock: 'F6',
  setTag: 'F7',
  setAnalytic: 'Mod-F7',
  setUndertag: 'Mod-F8',
  moveContainerUp: 'Mod-Alt-ArrowUp',
  moveContainerDown: 'Mod-Alt-ArrowDown',
  toggleBold: 'Mod-b',
  toggleItalic: 'Mod-i',
  toggleStrikethrough: '',
  toggleSuperscript: 'Mod-Shift-=',
  toggleSubscript: 'Mod-=',
  applyCite: 'F8',
  applyUnderline: ['F9'],
  toggleUnderlineTyping: 'Mod-u',
  toggleReadingMarker: 'Mod-Shift-d',
  applyEmphasis: 'F10',
  emphasizeAcronym: 'Alt-F10',
  applyHighlight: 'F11',
  highlightAcronym: 'Alt-F11',
  underlineAcronym: '',
  applyShading: 'Mod-F11',
  condenseDefault: 'F3',
  condenseNoIntegrity: 'Alt-F3',
  condenseNoIntegrityWithPilcrows: 'Mod-Alt-F3',
  condenseWithWarning: '',
  uncondense: 'Mod-Alt-Shift-F3',
  toggleCase: 'Shift-F3',
  copyPreviousCite: 'Alt-F8',
  pasteAsText: 'F2',
  pasteCondensed: '',
  clearToNormal: 'F12',
  shrink: 'Mod-8',
  smartShrink: 'Mod-Alt-8',
  regrow: 'Mod-Shift-8',
  // Menu / button commands — exposed for user-defined bindings via
  // the keybinding editor; no default key.
  createReference: '',
  lockHighlighting: '',
  extractUndertag: '',
  highlightToShading: '',
  shadingToHighlight: '',
  standardizeHighlight: '',
  standardizeShading: '',
  standardizeHighlightExcept: '',
  standardizeShadingExcept: '',
  convertCardsToReadMode: '',
  toggleReadMode: '',
  toggleReaderView: '',
  openContainingFolder: '',
  toggleCommentsVisible: '',
  addCommentToSelection: '',
  addNoteToSelection: 'Mod-Shift-n',
  aiAskAboutSelection: 'Mod-Shift-q',
  aiCreateCite: 'Mod-Shift-x',
  // Deliberately unbound: one model request per cite in the document is
  // far too expensive to sit behind a stray chord. Bind it in Settings →
  // Keyboard shortcuts if you want one.
  reformatAllCites: '',
  translate: 'Mod-Shift-t',
  repairText: 'Mod-Shift-r',
  repairFormatting: 'Mod-Alt-r',
  // No default binding — rebindable in Settings → Keyboard shortcuts.
  repairParagraphIntegrity: '',
  sendToFlowColumn: '',
  sendToFlowCell: '',
  sendHeadingsToFlowColumn: '',
  sendHeadingsToFlowCell: '',
  pullFromFlow: '',
  createFlow: '',
  startFlowHost: '',
  toggleVoice: 'Mod-Shift-V',
  openCardCutter: 'Mod-Alt-c',
  addCutterContext: '',
  openCutterGuidance: '',
  createFlashcard: '',
  manageFlashcards: '',
  wordCountSelection: '',
  openShortcutsReference: '',
  startUiTour: '',
  selectSimilar: '',
  removeHyperlinks: '',
  convertAnalyticsToTags: '',
  convertCitedAnalyticsToTags: '',
  fixFormattingGaps: '',
  // Table commands — no default keys; bind via the keybinding editor.
  insertTable: '',
  addRowAfter: '',
  addRowBefore: '',
  deleteTableRow: '',
  addColumnAfter: '',
  addColumnBefore: '',
  deleteTableColumn: '',
  mergeTableCells: '',
  splitTableCell: '',
  deleteTable: '',
  // Chrome won't let JS suppress its `Ctrl-N` (new window) or
  // `Ctrl-Shift-N` (new incognito window) defaults — both keys
  // are un-preventable in the browser, so the web edition has to
  // use `Mod-Alt-N`. Electron has no such restriction, so its
  // default is the conventional `Mod-N`. Both can be rebound in
  // Settings → Keyboard shortcuts.
  newDocument: getHost().kind === 'electron' ? 'Mod-n' : 'Mod-Alt-n',
  openFile: 'Mod-o',
  save: 'Mod-s',
  saveAs: 'Mod-Shift-s',
  saveSendDoc: 'Mod-Alt-s',
  saveMarkedCards: 'Mod-Alt-m',
  toggleAutosave: '',
  insertLiveZone: '',
  insertSelfLiveZone: '',
  insertInDocCopy: '',
  refreshLiveZone: '',
  refreshAllLiveZones: '',
  checkLiveZoneSources: '',
  detachLiveZone: '',
  // Verbatim's "Send to speech" — bare backtick (next to 1 on US
  // layouts) for at-cursor, Alt-backtick for at-end-of-doc. Same
  // chord as the desktop app. Trade-off: a bare backtick keystroke
  // is consumed by the command; users who actually need to type a
  // literal "`" in evidence can rebind these via Settings →
  // Keybindings.
  sendToSpeechAtCursor: '`',
  sendToSpeechAtEnd: 'Alt-`',
  sendToDropzone: 'Mod-`',
  sendToStarred: '',
  sendToRecipient: '',
  insertReceivedAtCursor: 'Mod-p',
  insertReceivedAtEnd: 'Mod-Alt-p',
  selectCurrentHeading: 'Alt-a',
  deleteCurrentHeading: '',
  toggleNumberRole: 'Mod-Alt-1',
  toggleSubRole: 'Mod-Alt-2',
  toggleNumRestart: 'Mod-Alt-3',
  copyCurrentHeading: '',
  addQuickCard: '',
  manageQuickCards: '',
  openQuickCardSearch: 'Mod-Shift-Space',
  collabStartSession: '',
  collabJoinSession: '',
  collabCopyShareCode: '',
  collabCopyInviteLink: '',
  collabInviteStarred: '',
  collabEndSession: '',
  newSpeechDocument: '',
  markActiveAsSpeech: '',
  insertImage: '',
  // Zoom. Mod-=/Mod-- mirror Word's editor-zoom convention (the `=`
  // key is the unshifted version of `+`). Mod-= overlaps with
  // toggleSubscript's default; the editor's keymap resolves the
  // overlap in the user's favor via Settings → Keyboard shortcuts, where
  // either command can be rebound. zoomReset stays unbound by
  // default — Mod-0 is a browser-level "reset zoom" chord that
  // Chromium won't always let the page intercept.
  openDevConsole: '',
  zoomIn: 'Mod-=',
  zoomOut: 'Mod--',
  zoomReset: '',
  // Chrome scale — Mod-Alt versions of the editor-zoom chord.
  // Same physical keys with Alt added: reads as "zoom the whole
  // page, not just the doc". Wired to Chromium's per-frame
  // setZoomFactor on Electron (identical mechanism to the
  // browser's built-in Ctrl-+); no-op on the web edition (use
  // the browser's own page-zoom there).
  chromeScaleUp: 'Mod-Alt-=',
  chromeScaleDown: 'Mod-Alt--',
  chromeScaleReset: 'Mod-Alt-0',
  // Paintbrush toggles — no obvious convention here, so register
  // them in the keybinding registry without a default. Users who
  // want a hotkey for sticky highlight / shading can bind one in
  // Settings → Keyboard shortcuts.
  togglePaintbrushHighlight: '',
  togglePaintbrushShading: '',
  // Browser-level Ctrl-F opens the page's find. Electron will let us
  // intercept (we drive our own bar); the web edition may see the
  // browser's UI also pop up. Documented + user-rebindable.
  openFind: 'Mod-f',
  openFindReplace: 'Mod-h',
  openFindByProximity: 'Alt-f',
  // No default — pickable in Settings → Keyboard shortcuts. Hiding the
  // nav pane is a personal-workflow toggle that's already on the
  // ribbon + nav-pane × + pull-tab; the keybinding is a power-
  // user convenience layer, not a discoverable default.
  toggleNavPane: '',
  // Ribbon actions with no default key — all already reachable via
  // the ribbon, so a default chord would be noise. Bindable in
  // Settings → Keyboard shortcuts.
  adjustFontSizeUp: '',
  adjustFontSizeDown: '',
  applyFontColor: '',
  openSettings: '',
  // Stock macOS chord; also works on Win/Linux. Rebindable like all.
  minimizeWindow: 'Mod-m',
  openJournalsFolder: '',
  toggleMorphMode: '',
  recoverPreviousVersion: '',
  cycleTheme: '',
  cycleTimerPreset: '',
  flipQuoteDirection: '',
  toggleParagraphIntegrity: '',
  selectSpeechDoc: '',
  goHome: '',
  openHighlightPicker: '',
  openShadingPicker: '',
  openFontColorPicker: '',
  openFontSizePicker: '',
  openDocToolsMenu: '',
  openCardToolsMenu: '',
  openTableMenu: '',
  focusSlot1: 'Mod-1',
  focusSlot2: 'Mod-2',
  focusSlot3: 'Mod-3',
  sendDocToSlot1: 'Mod-Shift-1',
  sendDocToSlot2: 'Mod-Shift-2',
  sendDocToSlot3: 'Mod-Shift-3',
  toggleSlotExpand: 'Mod-Shift-f',
  // Unbound by default — rebindable via Settings → Keyboard shortcuts.
  cycleDocNext: '',
  cycleDocPrev: '',
  closeDocOrWindow: 'Mod-w',
  insertFootnote: '',
  timerToggleVisible: '',
  timerStartPause: '',
  timerPreset1: '',
  timerPreset2: '',
  timerPreset3: '',
  timerStartAffPrep: '',
  timerStartNegPrep: '',
  timerReset: '',
};

/**
 * Live values the color-aware commands (F11 Highlight, Mod-F11
 * Shading) read at invocation time. Passed into `buildRibbonKeymap`
 * and `getRibbonCommand` so the editor can hand them a `settings`-
 * backed resolver. Defaults pull the schema's defaults, so tests can
 * call `getRibbonCommand('applyHighlight')` without wiring settings.
 */
export interface RibbonContext {
  highlightColor: () => string | null;
  shadingColor: () => string | null;
  /** Whether F3 (default condense) preserves paragraph integrity. */
  paragraphIntegrity: () => boolean;
  /** Whether F3 inserts 6-pt ¶ markers when merging (consulted only when
   *  paragraphIntegrity is false). */
  usePilcrows: () => boolean;
  /** Whether Extract Undertag wraps the excerpt in double quotes. */
  extractUndertagInQuotes: () => boolean;
  /** How selection-based condense treats structural elements. See
   *  `condense.ts` and `settings.ts` for the rule table. */
  headingMode: () => 'strict' | 'respect' | 'demolish';
  /** Whether F2 (Paste Text) runs the default condense pass after pasting. */
  condenseOnPaste: () => boolean;
  /** Whether F9's toggle-off direction also strips direct formatting
   *  (Verbatim's "press F9 twice clears formatting"). */
  clearFormattingOnNamedStyleToggleOff: () => boolean;
  /** Resolves a text run's effective font-size in pt, accounting for
   *  font_size marks, named-style marks, and paragraph defaults — same
   *  resolver the chip / increment-decrement buttons use. Used by
   *  Shrink to compute its starting size. */
  effectivePtForNode: (node: PMNode | null, parent: PMNode) => number;
  /** Body "Normal" size in pt — the size Shrink jumps back to at the
   *  bottom of its cycle. */
  normalPt: () => number;
  /** Whether Shrink (Mod-8) excludes protected text (omissions,
   *  warning markers, user custom rules) from the cycle and pins
   *  them at Normal size. Off by default. */
  shrinkRestoresOmissionsToNormal: () => boolean;
  /** Compiled protected-range patterns Shrink uses to find spans to
   *  preserve at Normal size. The editor builds this from the static
   *  built-in patterns, the user's custom protections, and the
   *  custom condense-with-warning delimiter (if configured). */
  shrinkProtectionPatterns: () => readonly RegExp[];
  /** Full pause / resume marker text "Condense with warning" should
   *  emit. For the six built-in delimiter enum values this is the
   *  classic `<open>PARAGRAPH INTEGRITY PAUSES<close>` pairing; for
   *  the `'custom'` enum value it's the user-typed setting strings
   *  verbatim (which replace the entire marker, not just the
   *  brackets). The resolver lets the command consume one shape
   *  regardless of which the user picked. */
  condenseWarningMarkers: () => { pause: string; resume: string };
  /** Side-effecting actions for the menu-only / button-only commands.
   *  All four are no-ops by default so tests / standalone uses of
   *  `getRibbonCommand` don't need to wire them. The real editor
   *  binds these in `index.ts` to the corresponding modal / dialog /
   *  setting toggle. They are wrapped in Commands so the keybinding
   *  editor can rebind them like any other ribbon action. */
  runCreateReference: () => void;
  openWordCountDialog: () => void;
  toggleReadMode: () => void;
  toggleReaderView: () => void;
  openContainingFolder: () => void;
  openShortcutsReference: () => void;
  toggleCommentsVisible: () => void;
  addCommentToSelection: () => void;
  addNoteToSelection: () => void;
  aiAskAboutSelection: () => void;
  aiCreateCite: () => void;
  /** Confirm, then run the cite creator over every cite paragraph in the
   *  document — one model request each. */
  reformatAllCites: () => void;
  /** Translate the selection and copy the result to the clipboard. */
  translate: () => void;
  /** Repair OCR / PDF text errors in the selection in place. */
  repairText: () => void;
  /** Repair body-text formatting (underline/emphasis/highlight scheme). */
  repairFormatting: () => void;
  /** Open the Repair Paragraph Integrity workflow on the current card. */
  openRepairParagraph: () => void;
  /** Verbatim Flow (Windows COM → Excel). Send selected blocks / pull
   *  selected cells / open a new Flow. */
  sendToFlowColumn: () => void;
  sendToFlowCell: () => void;
  sendHeadingsToFlowColumn: () => void;
  sendHeadingsToFlowCell: () => void;
  pullFromFlow: () => void;
  createFlow: () => void;
  /** Pre-warm the persistent Flow PowerShell host (Windows only). */
  startFlowHost: () => void;
  /** Toggle the voice-control session on/off (desktop only). */
  toggleVoice: () => void;
  /** Open the AI card-cutter launch sheet for the current card. Gated on
   *  `cardCutterActive` — a no-op when the experiment is off. */
  openCardCutter: () => void;
  /** Create an anchored cutter-context note from the selection. Gated
   *  on `cardCutterActive`. */
  addCutterContext: () => void;
  /** Open (creating if absent) the doc's single anchorless file-guidance
   *  note for the cutter. Gated on `cardCutterActive`. */
  openCutterGuidance: () => void;
  /** Whether the card-cutter experiment is currently enabled. Lets the
   *  keymap fall through when off so the binding isn't consumed. */
  cardCutterActive: () => boolean;
  createFlashcard: () => void;
  manageFlashcards: () => void;
  /** File-level commands. These work regardless of whether the editor
   *  is mounted / has a doc loaded — they always run the same handler
   *  the corresponding ribbon button uses. */
  newDocument: () => void;
  openFile: () => void;
  save: () => void;
  saveAs: () => void;
  saveSendDoc: () => void;
  saveMarkedCards: () => void;
  toggleAutosave: () => void;
  /** Speech-doc commands (Verbatim's `Paperless.SendToSpeech` family).
   *  All four are wired via the speech-doc registry — when the host
   *  hasn't installed a real implementation, the defaults are
   *  no-ops so tests / standalone uses don't crash. */
  newSpeechDocument: () => void;
  markActiveAsSpeech: () => void;
  sendToSpeechAtCursor: () => void;
  sendToSpeechAtEnd: () => void;
  sendToDropzone: () => void;
  /** Open the picker to insert a live zone (transclusion). Desktop-only UI. */
  insertLiveZone: () => void;
  /** Open the picker to insert a Live View — a read-only window onto another
   *  section of THIS document. */
  insertSelfLiveZone: () => void;
  /** Open the picker to insert a Linked Copy — an editable copy of another
   *  section of THIS document. */
  insertInDocCopy: () => void;
  /** Send the cursor's card (or selection) to the starred recipient/group. */
  sendToStarred: () => void;
  /** Same source as sendToStarred; the target is picked from a list of
   *  contacts and groups. */
  sendToRecipient: () => void;
  /** Insert the most-recently-received card (from the receive pill) into the
   *  active doc — at the cursor, or at the end of the doc. */
  insertReceivedAtCursor: () => void;
  insertReceivedAtEnd: () => void;
  /** Select / copy the cursor's enclosing structure (the current
   *  card / analytic_unit / heading + subtree). Keyed off the cursor;
   *  any active selection is ignored. */
  selectCurrentHeading: () => void;
  /** Delete the cursor's enclosing structure (card / analytic_unit /
   *  heading + subtree) outright — no blank heading left behind. */
  deleteCurrentHeading: () => void;
  copyCurrentHeading: () => void;
  /** Save the current selection as a named, tagged quick card
   *  (opens the Add dialog). No-op + toast if the selection is empty. */
  addQuickCard: () => void;
  /** Open the Quick Cards manager (browse/edit the saved library). */
  manageQuickCards: () => void;
  /** Open the floating quick-card search palette. Works with no
   *  active doc (browse-only; insert no-ops). */
  openQuickCardSearch: () => void;
  collabStartSession: () => void;
  collabJoinSession: () => void;
  collabCopyShareCode: () => void;
  collabCopyInviteLink: () => void;
  collabInviteStarred: () => void;
  collabEndSession: () => void;
  /** Open the file picker that prompts for an image to insert at
   *  the editor's current cursor. Pasting an image from the
   *  clipboard goes through paste-plugin instead — no ctx hook
   *  needed for that path. */
  insertImage: () => void;
  /** Zoom controls — bumps the persisted `zoomPct` setting one
   *  step up/down or resets it to 100%. The status-bar buttons
   *  use the same handlers. */
  /** Toggle Chromium DevTools (desktop only; hidden on web). */
  openDevConsole: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
  /** Chrome scale — page-zoom analog of the editor zoom above.
   *  Bumps the persisted `chromeScalePct` setting (50–300, step
   *  10); on Electron this propagates to Chromium's
   *  `webFrame.setZoomFactor` so the whole page (chrome + doc)
   *  reflows at the new factor. No-op on the web edition. */
  chromeScaleUp: () => void;
  chromeScaleDown: () => void;
  chromeScaleReset: () => void;
  /** Paint-mode toggles for highlight / background-color. Mirror
   *  what clicking the ribbon's main color button does when the
   *  selection is empty (arming sticky paint until the next click
   *  or Escape). */
  togglePaintbrushHighlight: () => void;
  togglePaintbrushShading: () => void;
  /** Open the floating Find / Find+Replace bar. The `openFindByProximity`
   *  variant (Alt-F; name kept for binding stability) skips category
   *  grouping — matches run in document order from the cursor, wrapping. */
  openFind: () => void;
  openFindReplace: () => void;
  openFindByProximity: () => void;
  /** Flip the navigation-pane visibility setting. Per-window
   *  (transient), so toggling in one window leaves siblings
   *  untouched. */
  toggleNavPane: () => void;
  /** Most-recently-picked font color (hex, no `#`, e.g. `"FF0000"`)
   *  or `null` when the user has chosen "Automatic" / no explicit
   *  color. Read at invocation time by the `applyFontColor` command
   *  so a keybinding applies whatever color the user last picked
   *  in the ribbon swatch. */
  lastFontColor: () => string | null;
  /** Host-side actions exposed for keybinding parity with their
   *  ribbon-button counterparts. All optional (default no-op) so
   *  tests and headless callers don't have to wire them up. */
  openSettings: () => void;
  /** Minimize this OS window (desktop only; no-op elsewhere). */
  minimizeWindow: () => void;
  /** Open the crash-recovery journals folder (desktop only; no-op elsewhere). */
  openJournalsFolder: () => void;
  /** Arm/disarm Morph mode (Sensel control-surface interpreter). */
  toggleMorphMode: () => void;
  /** Open an earlier state of a co-edited doc as its own unsaved copy. */
  recoverPreviousVersion: () => void;
  /** Cycle the theme setting light → dark → system → light. */
  cycleTheme: () => void;
  /** Cycle the timer profile College → High School → Pomodoro (wraps). */
  cycleTimerPreset: () => void;
  toggleParagraphIntegrity: () => void;
  selectSpeechDoc: () => void;
  goHome: () => void;
  openHighlightPicker: () => void;
  openShadingPicker: () => void;
  openFontColorPicker: () => void;
  openFontSizePicker: () => void;
  openDocToolsMenu: () => void;
  openCardToolsMenu: () => void;
  openTableMenu: () => void;
}

const DEFAULT_RIBBON_CONTEXT: RibbonContext = {
  highlightColor: () => 'yellow',
  shadingColor: () => 'D2D2D2',
  paragraphIntegrity: () => true,
  usePilcrows: () => false,
  extractUndertagInQuotes: () => false,
  headingMode: () => 'respect',
  condenseOnPaste: () => false,
  clearFormattingOnNamedStyleToggleOff: () => true,
  effectivePtForNode: () => 11,
  normalPt: () => 11,
  shrinkRestoresOmissionsToNormal: () => false,
  shrinkProtectionPatterns: () => BUILTIN_PROTECTED_REGEXES,
  condenseWarningMarkers: () => ({
    pause: '[PARAGRAPH INTEGRITY PAUSES]',
    resume: '[PARAGRAPH INTEGRITY RESUMES]',
  }),
  runCreateReference: () => {},
  openWordCountDialog: () => {},
  toggleReadMode: () => {},
  toggleReaderView: () => {},
  openContainingFolder: () => {},
  openShortcutsReference: () => {},
  toggleCommentsVisible: () => {},
  addCommentToSelection: () => {},
  addNoteToSelection: () => {},
  aiAskAboutSelection: () => {},
  aiCreateCite: () => {},
  reformatAllCites: () => {},
  translate: () => {},
  repairText: () => {},
  repairFormatting: () => {},
  openRepairParagraph: () => {},
  sendToFlowColumn: () => {},
  sendToFlowCell: () => {},
  sendHeadingsToFlowColumn: () => {},
  sendHeadingsToFlowCell: () => {},
  pullFromFlow: () => {},
  createFlow: () => {},
  startFlowHost: () => {},
  toggleVoice: () => {},
  openCardCutter: () => {},
  addCutterContext: () => {},
  openCutterGuidance: () => {},
  cardCutterActive: () => false,
  createFlashcard: () => {},
  manageFlashcards: () => {},
  newDocument: () => {},
  openFile: () => {},
  save: () => {},
  saveAs: () => {},
  saveSendDoc: () => {},
  saveMarkedCards: () => {},
  toggleAutosave: () => {},
  newSpeechDocument: () => {},
  markActiveAsSpeech: () => {},
  sendToSpeechAtCursor: () => {},
  sendToDropzone: () => {},
  insertLiveZone: () => {},
  insertSelfLiveZone: () => {},
  insertInDocCopy: () => {},
  sendToStarred: () => {},
  sendToRecipient: () => {},
  insertReceivedAtCursor: () => {},
  insertReceivedAtEnd: () => {},
  sendToSpeechAtEnd: () => {},
  selectCurrentHeading: () => {},
  deleteCurrentHeading: () => {},
  copyCurrentHeading: () => {},
  addQuickCard: () => {},
  manageQuickCards: () => {},
  openQuickCardSearch: () => {},
  collabStartSession: () => {},
  collabJoinSession: () => {},
  collabCopyShareCode: () => {},
  collabCopyInviteLink: () => {},
  collabInviteStarred: () => {},
  collabEndSession: () => {},
  insertImage: () => {},
  openDevConsole: () => {},
  zoomIn: () => {},
  zoomOut: () => {},
  zoomReset: () => {},
  chromeScaleUp: () => {},
  chromeScaleDown: () => {},
  chromeScaleReset: () => {},
  togglePaintbrushHighlight: () => {},
  togglePaintbrushShading: () => {},
  openFind: () => {},
  openFindReplace: () => {},
  openFindByProximity: () => {},
  toggleNavPane: () => {},
  lastFontColor: () => null,
  openSettings: () => {},
  minimizeWindow: () => {},
  openJournalsFolder: () => {},
  toggleMorphMode: () => {},
  recoverPreviousVersion: () => {},
  cycleTheme: () => {},
  cycleTimerPreset: () => {},
  toggleParagraphIntegrity: () => {},
  selectSpeechDoc: () => {},
  goHome: () => {},
  openHighlightPicker: () => {},
  openShadingPicker: () => {},
  openFontColorPicker: () => {},
  openFontSizePicker: () => {},
  openDocToolsMenu: () => {},
  openCardToolsMenu: () => {},
  openTableMenu: () => {},
};

/** Wrap a timer action as an editor command, gated on the timer
 *  panel being visible — hidden timer → return false so the key
 *  falls through to other handlers. Timer state changes broadcast
 *  to every window, matching the panel's buttons. */
function timerCommand(run: () => void): Command {
  return (_state, dispatch) => {
    if (!getTimerState().visible) return false;
    if (!dispatch) return true;
    run();
    return true;
  };
}

/** Load the active profile's Nth speech preset and start it counting
 *  — the one-keystroke version of "click the 9/6/3 button, then
 *  Start". A missing/zero preset leaves the clock untouched. */
function startSpeechPreset(idx: number): void {
  const minutes = settings.get('timerSpeechPresets')[idx] ?? 0;
  if (minutes <= 0) return;
  loadSpeechPreset(minutes);
  startTimer();
}

function commandFor(id: RibbonCommandId, ctx: RibbonContext): Command {
  switch (id) {
    case 'setPocket': return setHeading('pocket');
    case 'setHat': return setHeading('hat');
    case 'setBlock': return setHeading('block');
    case 'setTag': return setTag();
    case 'setAnalytic': return setAnalytic();
    case 'toggleNumberRole': return toggleNumberRole;
    case 'toggleSubRole': return toggleSubRole;
    case 'toggleNumRestart': return toggleNumRestart;
    case 'setUndertag': return setUndertag();
    case 'moveContainerUp': return moveContainerUp();
    case 'moveContainerDown': return moveContainerDown();
    case 'toggleBold': return toggleBold();
    case 'toggleItalic': return shadowAwareToggleMark(schema.marks['italic']!);
    case 'toggleStrikethrough': return shadowAwareToggleMark(schema.marks['strikethrough']!);
    case 'toggleSuperscript': return shadowAwareToggleMark(schema.marks['superscript']!);
    case 'toggleSubscript': return shadowAwareToggleMark(schema.marks['subscript']!);
    case 'applyCite': return applyCite();
    case 'applyUnderline': return applyUnderline(ctx.clearFormattingOnNamedStyleToggleOff);
    case 'toggleUnderlineTyping': return toggleUnderlineTyping(ctx.clearFormattingOnNamedStyleToggleOff);
    case 'toggleReadingMarker': return toggleReadingMarkerCommand;
    case 'applyEmphasis': return applyEmphasis();
    case 'emphasizeAcronym': return emphasizeAcronym();
    case 'applyHighlight': return applyHighlight(ctx.highlightColor);
    case 'highlightAcronym': return highlightAcronym(ctx.highlightColor);
    case 'underlineAcronym': return underlineAcronym();
    case 'applyShading': return applyShading(ctx.shadingColor);
    case 'condenseDefault':
      // F3 reads paragraphIntegrity + usePilcrows at invocation time.
      return (state, dispatch) => {
        if (ctx.paragraphIntegrity()) {
          return condenseBranchC()(state, dispatch);
        }
        return condenseMerge({
          withPilcrows: ctx.usePilcrows(),
          headingMode: ctx.headingMode(),
        })(state, dispatch);
      };
    case 'condenseNoIntegrity':
      // Alt-F3: force no integrity + no pilcrows regardless of settings.
      return (state, dispatch) =>
        condenseMerge({ withPilcrows: false, headingMode: ctx.headingMode() })(state, dispatch);
    case 'condenseNoIntegrityWithPilcrows':
      // Mod-Alt-F3: force no integrity + pilcrows regardless of settings.
      return (state, dispatch) =>
        condenseMerge({ withPilcrows: true, headingMode: ctx.headingMode() })(state, dispatch);
    case 'condenseWithWarning':
      return condenseWithWarning(ctx.condenseWarningMarkers);
    case 'uncondense': return uncondense();
    case 'toggleCase': return toggleCase();
    case 'copyPreviousCite': return copyPreviousCite();
    case 'pasteAsText':
      return pasteAsText(ctx);
    case 'pasteCondensed':
      return pasteCondensed(ctx);
    case 'clearToNormal':
      return clearToNormal();
    case 'shrink':
      return shrinkText(
        ctx.effectivePtForNode,
        ctx.normalPt,
        ctx.shrinkRestoresOmissionsToNormal,
        ctx.shrinkProtectionPatterns,
      );
    case 'smartShrink':
      return smartShrinkText(
        ctx.effectivePtForNode,
        ctx.normalPt,
        ctx.shrinkRestoresOmissionsToNormal,
        ctx.shrinkProtectionPatterns,
      );
    case 'regrow':
      return regrowText(
        ctx.effectivePtForNode,
        ctx.normalPt,
        ctx.shrinkRestoresOmissionsToNormal,
        ctx.shrinkProtectionPatterns,
      );
    case 'createReference':
      // Side-effecting (clipboard write + toast). Returns true so the
      // keymap consumes the keystroke even though no transaction fires.
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.runCreateReference();
        return true;
      };
    case 'extractUndertag':
      return extractUndertag(ctx.extractUndertagInQuotes);
    case 'lockHighlighting':
      return lockHighlighting();
    case 'highlightToShading':
      return highlightToShading();
    case 'shadingToHighlight':
      return shadingToHighlight();
    case 'standardizeHighlight':
      // Auto-scoped: selection-based when there's a selection, doc-
      // wide when there isn't. Keeps one menu item for both modes.
      return (state, dispatch, view) =>
        uniHighlight(
          ctx.highlightColor,
          state.selection.empty ? 'document' : 'selection',
        )(state, dispatch, view);
    case 'standardizeShading':
      return (state, dispatch, view) =>
        uniShade(
          ctx.shadingColor,
          state.selection.empty ? 'document' : 'selection',
        )(state, dispatch, view);
    case 'standardizeHighlightExcept':
      // Same auto-scoping as the plain command; runs already in the
      // configured exception color are left untouched.
      return (state, dispatch, view) =>
        uniHighlight(
          ctx.highlightColor,
          state.selection.empty ? 'document' : 'selection',
          () => settings.get('standardizeHighlightException'),
        )(state, dispatch, view);
    case 'standardizeShadingExcept':
      return (state, dispatch, view) =>
        uniShade(
          ctx.shadingColor,
          state.selection.empty ? 'document' : 'selection',
          () => settings.get('standardizeShadingException'),
        )(state, dispatch, view);
    case 'convertCardsToReadMode':
      return convertCardsToReadMode;
    case 'toggleReadMode':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.toggleReadMode();
        return true;
      };
    case 'toggleReaderView':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.toggleReaderView();
        return true;
      };
    case 'openContainingFolder':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openContainingFolder();
        return true;
      };
    case 'toggleCommentsVisible':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.toggleCommentsVisible();
        return true;
      };
    case 'addCommentToSelection':
      // The mark + thread creation logic is view-aware, so the
      // command delegates to the editor's side-effect hook.
      return (state, dispatch) => {
        if (state.selection.empty) return false;
        if (!dispatch) return true;
        ctx.addCommentToSelection();
        return true;
      };
    case 'addNoteToSelection':
      return (state, dispatch) => {
        if (state.selection.empty) return false;
        if (!dispatch) return true;
        ctx.addNoteToSelection();
        return true;
      };
    case 'aiAskAboutSelection':
      return (state, dispatch) => {
        if (state.selection.empty) return false;
        if (!dispatch) return true;
        ctx.aiAskAboutSelection();
        return true;
      };
    case 'aiCreateCite':
      return (state, dispatch) => {
        if (state.selection.empty) return false;
        if (!dispatch) return true;
        ctx.aiCreateCite();
        return true;
      };
    case 'reformatAllCites':
      // Whole-document scope — no selection needed, and the run itself
      // reports when the doc has no cites to reformat.
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.reformatAllCites();
        return true;
      };
    case 'translate':
      return (state, dispatch) => {
        if (state.selection.empty) return false;
        if (!dispatch) return true;
        ctx.translate();
        return true;
      };
    case 'repairText':
      return (state, dispatch) => {
        if (state.selection.empty) return false;
        if (!dispatch) return true;
        ctx.repairText();
        return true;
      };
    case 'repairFormatting':
      return (state, dispatch) => {
        if (state.selection.empty) return false;
        if (!dispatch) return true;
        ctx.repairFormatting();
        return true;
      };
    case 'repairParagraphIntegrity':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openRepairParagraph();
        return true;
      };
    case 'sendToFlowColumn':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.sendToFlowColumn();
        return true;
      };
    case 'sendToFlowCell':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.sendToFlowCell();
        return true;
      };
    case 'sendHeadingsToFlowColumn':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.sendHeadingsToFlowColumn();
        return true;
      };
    case 'sendHeadingsToFlowCell':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.sendHeadingsToFlowCell();
        return true;
      };
    case 'pullFromFlow':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.pullFromFlow();
        return true;
      };
    case 'createFlow':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.createFlow();
        return true;
      };
    case 'startFlowHost':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.startFlowHost();
        return true;
      };
    case 'toggleVoice':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.toggleVoice();
        return true;
      };
    case 'openCardCutter':
      // Gated on the experiment being on. Returning false when off lets
      // the keystroke fall through instead of being silently swallowed.
      return (_state, dispatch) => {
        if (!ctx.cardCutterActive()) return false;
        if (!dispatch) return true;
        ctx.openCardCutter();
        return true;
      };
    case 'addCutterContext':
      // Same gate as openCardCutter, plus a selection to anchor to.
      return (state, dispatch) => {
        if (!ctx.cardCutterActive()) return false;
        if (state.selection.empty) return false;
        if (!dispatch) return true;
        ctx.addCutterContext();
        return true;
      };
    case 'openCutterGuidance':
      return (_state, dispatch) => {
        if (!ctx.cardCutterActive()) return false;
        if (!dispatch) return true;
        ctx.openCutterGuidance();
        return true;
      };
    case 'createFlashcard':
      return (state, dispatch) => {
        if (state.selection.empty) return false;
        if (!dispatch) return true;
        ctx.createFlashcard();
        return true;
      };
    case 'manageFlashcards':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.manageFlashcards();
        return true;
      };
    case 'wordCountSelection':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openWordCountDialog();
        return true;
      };
    case 'openShortcutsReference':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openShortcutsReference();
        return true;
      };
    case 'startUiTour':
      // Chrome-level side effect, doc-independent; lazy import keeps
      // the tour module out of the boot path.
      return (_state, dispatch) => {
        if (!dispatch) return true;
        void import('./ui-tour.js').then((m) => m.startUiTour());
        return true;
      };
    case 'selectSimilar':
      return selectSimilar(ctx.effectivePtForNode);
    case 'removeHyperlinks':
      return removeHyperlinks();
    case 'convertAnalyticsToTags':
      return convertAnalyticsToTags();
    case 'convertCitedAnalyticsToTags':
      return convertCitedAnalyticsToTags();
    case 'fixFormattingGaps':
      return fixFormattingGaps(ctx.effectivePtForNode);
    case 'insertTable':
      return insertTable();
    case 'addRowAfter':
      return guardedAddRowAfter;
    case 'addRowBefore':
      return guardedAddRowBefore;
    case 'deleteTableRow':
      return guardedDeleteRow;
    case 'addColumnAfter':
      return guardedAddColumnAfter;
    case 'addColumnBefore':
      return guardedAddColumnBefore;
    case 'deleteTableColumn':
      return guardedDeleteColumn;
    case 'mergeTableCells':
      return guardedMergeCells;
    case 'splitTableCell':
      return guardedSplitCell;
    case 'deleteTable':
      return guardedDeleteTable;
    case 'newDocument':
      // File-level commands: always available, even with no doc open
      // and no selection. PM-command convention: a "query" call (no
      // dispatch) only reports availability; the side effect runs
      // solely on the real dispatch call.
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.newDocument();
        return true;
      };
    case 'openFile':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openFile();
        return true;
      };
    case 'save':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.save();
        return true;
      };
    case 'saveAs':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.saveAs();
        return true;
      };
    case 'saveSendDoc':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.saveSendDoc();
        return true;
      };
    case 'saveMarkedCards':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.saveMarkedCards();
        return true;
      };
    case 'toggleAutosave':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.toggleAutosave();
        return true;
      };
    case 'newSpeechDocument':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.newSpeechDocument();
        return true;
      };
    case 'markActiveAsSpeech':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.markActiveAsSpeech();
        return true;
      };
    case 'sendToSpeechAtCursor':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.sendToSpeechAtCursor();
        return true;
      };
    case 'sendToSpeechAtEnd':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.sendToSpeechAtEnd();
        return true;
      };
    case 'sendToDropzone':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.sendToDropzone();
        return true;
      };
    case 'insertLiveZone':
      // Opens the picker (desktop-only UI); the palette builds the node.
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.insertLiveZone();
        return true;
      };
    case 'insertSelfLiveZone':
      // Opens the in-document heading picker; inserts a Live View (self_ref).
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.insertSelfLiveZone();
        return true;
      };
    case 'insertInDocCopy':
      // Opens the in-document heading picker; inserts an editable Linked Copy.
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.insertInDocCopy();
        return true;
      };
    case 'refreshLiveZone':
      // Refresh the live zone the cursor is IN (or the one selected as a node) —
      // the same action as its ⟳ menu item: re-read the source, re-extract the
      // section, confirm first if the zone has local edits. Acts via the
      // command's own view so it works in single-doc and every multi-pane slot.
      return (state, dispatch, view) => {
        if (commandZonePos(state) === null) return false;
        if (!dispatch) return true;
        const pos = view ? commandZonePos(view.state) : null;
        if (view && pos !== null) {
          void refreshZoneAtPos(view, pos).then((o) => {
            const msg = o.ok ? '' : refreshFailMessage(o.reason);
            if (msg) showToast(msg);
          });
        }
        return true;
      };
    case 'refreshAllLiveZones':
      // Refresh EVERY live zone in the document. One confirmation up front (in
      // refreshAllZones) covers the whole batch, since it discards local edits
      // and re-pulls every source throughout the doc.
      return (state, dispatch, view) => {
        if (!docHasZone(state.doc)) return false;
        if (!dispatch) return true;
        if (view) {
          void refreshAllZones(view).then((s) => {
            if (!s.confirmed || s.total === 0) return;
            const msg =
              s.failed === 0
                ? `Refreshed ${s.refreshed} linked ${s.refreshed === 1 ? 'copy' : 'copies'}.`
                : `Refreshed ${s.refreshed} of ${s.total} linked copies — ${s.failed} could not be reached.`;
            showToast(msg);
          });
        }
        return true;
      };
    case 'checkLiveZoneSources':
      // Read every cross-file live zone's SOURCE and flag which have changed
      // (updates the badges) — but pull nothing. Refresh is the separate,
      // content-replacing action. Desktop-only (it reads the source files).
      return (state, dispatch, view) => {
        if (!docHasZone(state.doc)) return false;
        if (!dispatch) return true;
        if (view) {
          void checkLiveZoneSources(view).then((s) => {
            const n = (x: number, w: string): string => `${x} ${w}${x === 1 ? '' : 's'}`;
            const unreachable = s.total - s.checked;
            const copies = (x: number): string => `${x} linked ${x === 1 ? 'copy' : 'copies'}`;
            const msg = !s.desktop
              ? 'Linked copies check for source updates on the desktop app.'
              : s.total === 0
                ? 'No linked copies in this document.'
                : s.diverged > 0
                  ? `${copies(s.diverged)} ${s.diverged === 1 ? 'has a' : 'have'} changed source${s.diverged === 1 ? '' : 's'} — Refresh to pull the updates.`
                  : unreachable > 0
                    ? `Linked copies are up to date (${n(unreachable, 'source')} couldn't be reached).`
                    : `All ${copies(s.total)} are up to date with their sources.`;
            showToast(msg);
          });
        }
        return true;
      };
    case 'detachLiveZone':
      return (state, dispatch, view) => {
        if (!selectedTransclusion(state.selection)) return false;
        if (!dispatch) return true;
        const sel = selectedTransclusion(view ? view.state.selection : state.selection);
        if (view && sel) detachZoneAtPos(view, sel.pos);
        return true;
      };
    case 'sendToRecipient':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.sendToRecipient();
        return true;
      };
    case 'sendToStarred':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.sendToStarred();
        return true;
      };
    case 'insertReceivedAtCursor':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.insertReceivedAtCursor();
        return true;
      };
    case 'insertReceivedAtEnd':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.insertReceivedAtEnd();
        return true;
      };
    case 'selectCurrentHeading':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.selectCurrentHeading();
        return true;
      };
    case 'deleteCurrentHeading':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.deleteCurrentHeading();
        return true;
      };
    case 'copyCurrentHeading':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.copyCurrentHeading();
        return true;
      };
    case 'addQuickCard':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.addQuickCard();
        return true;
      };
    case 'manageQuickCards':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.manageQuickCards();
        return true;
      };
    case 'openQuickCardSearch':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openQuickCardSearch();
        return true;
      };
    case 'collabStartSession':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.collabStartSession();
        return true;
      };
    case 'collabJoinSession':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.collabJoinSession();
        return true;
      };
    case 'collabCopyShareCode':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.collabCopyShareCode();
        return true;
      };
    case 'collabCopyInviteLink':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.collabCopyInviteLink();
        return true;
      };
    case 'collabInviteStarred':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.collabInviteStarred();
        return true;
      };
    case 'collabEndSession':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.collabEndSession();
        return true;
      };
    case 'insertImage':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.insertImage();
        return true;
      };
    case 'insertFootnote':
      return (state, dispatch, view) => {
        const type = schema.nodes['footnote'];
        if (!type) return false;
        // Needs an inline position (any textblock). Replaces a
        // non-empty selection, like typing would.
        if (!state.selection.$from.parent.inlineContent) return false;
        if (!dispatch) return true;
        const insertPos = state.selection.from;
        const tr = state.tr.replaceSelectionWith(
          type.create({ kind: 'footnote', content: [] }),
        );
        dispatch(tr.scrollIntoView());
        // Open the popover straight into edit mode so the flow is
        // invoke → type the note → Save.
        if (view) openFootnoteEditor(view, insertPos);
        return true;
      };
    case 'openDevConsole':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openDevConsole();
        return true;
      };
    case 'zoomIn':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.zoomIn();
        return true;
      };
    case 'zoomOut':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.zoomOut();
        return true;
      };
    case 'zoomReset':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.zoomReset();
        return true;
      };
    case 'chromeScaleUp':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.chromeScaleUp();
        return true;
      };
    case 'chromeScaleDown':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.chromeScaleDown();
        return true;
      };
    case 'chromeScaleReset':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.chromeScaleReset();
        return true;
      };
    case 'togglePaintbrushHighlight':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.togglePaintbrushHighlight();
        return true;
      };
    case 'togglePaintbrushShading':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.togglePaintbrushShading();
        return true;
      };
    case 'openFind':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openFind();
        return true;
      };
    case 'openFindReplace':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openFindReplace();
        return true;
      };
    case 'openFindByProximity':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openFindByProximity();
        return true;
      };
    case 'toggleNavPane':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.toggleNavPane();
        return true;
      };
    // ─── No-default-binding commands (keybinding parity for
    //     ribbon-button / menu actions) ──────────────────────────
    case 'adjustFontSizeUp':
      return adjustFontSize(1, ctx.effectivePtForNode);
    case 'adjustFontSizeDown':
      return adjustFontSize(-1, ctx.effectivePtForNode);
    case 'applyFontColor':
      // Apply the user's most-recently-picked font color (null =
      // strip the font_color mark / revert to theme default).
      return (state, dispatch, view) =>
        setFontColor(ctx.lastFontColor())(state, dispatch, view);
    case 'openSettings':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openSettings();
        return true;
      };
    case 'minimizeWindow':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.minimizeWindow();
        return true;
      };
    case 'openJournalsFolder':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openJournalsFolder();
        return true;
      };
    case 'toggleMorphMode':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.toggleMorphMode();
        return true;
      };
    case 'recoverPreviousVersion':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.recoverPreviousVersion();
        return true;
      };
    case 'cycleTheme':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.cycleTheme();
        return true;
      };
    case 'cycleTimerPreset':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.cycleTimerPreset();
        return true;
      };
    case 'timerToggleVisible':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        setTimerVisible(!getTimerState().visible);
        return true;
      };
    case 'timerStartPause':
      return timerCommand(() => {
        if (getTimerState().running) pauseTimer();
        else startTimer();
      });
    case 'timerPreset1':
      return timerCommand(() => startSpeechPreset(0));
    case 'timerPreset2':
      return timerCommand(() => startSpeechPreset(1));
    case 'timerPreset3':
      return timerCommand(() => startSpeechPreset(2));
    case 'timerStartAffPrep':
      return timerCommand(() => {
        selectMode('affPrep');
        startTimer();
      });
    case 'timerStartNegPrep':
      return timerCommand(() => {
        selectMode('negPrep');
        startTimer();
      });
    case 'timerReset':
      return timerCommand(() => resetTimer());
    case 'flipQuoteDirection':
      return flipQuoteDirection;
    case 'toggleParagraphIntegrity':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.toggleParagraphIntegrity();
        return true;
      };
    case 'selectSpeechDoc':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.selectSpeechDoc();
        return true;
      };
    case 'goHome':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.goHome();
        return true;
      };
    case 'openHighlightPicker':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openHighlightPicker();
        return true;
      };
    case 'openShadingPicker':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openShadingPicker();
        return true;
      };
    case 'openFontColorPicker':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openFontColorPicker();
        return true;
      };
    case 'openFontSizePicker':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openFontSizePicker();
        return true;
      };
    case 'openDocToolsMenu':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openDocToolsMenu();
        return true;
      };
    case 'openCardToolsMenu':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openCardToolsMenu();
        return true;
      };
    case 'openTableMenu':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openTableMenu();
        return true;
      };
    // Multi-pane workspace commands are dispatched via
    // `runViewlessRibbon` in `editor/index.ts` (they don't read
    // PM state or dispatch transactions). Return a no-op
    // PM Command so PM's keymap doesn't claim the key but also
    // doesn't crash; the viewless path is what actually fires.
    case 'focusSlot1':
    case 'focusSlot2':
    case 'focusSlot3':
    case 'sendDocToSlot1':
    case 'sendDocToSlot2':
    case 'sendDocToSlot3':
    case 'toggleSlotExpand':
    case 'cycleDocNext':
    case 'cycleDocPrev':
    case 'closeDocOrWindow':
      return () => false;
  }
}

/**
 * Insert a default 3×3 table at the cursor. (Larger / smaller
 * tables can be reached via add-row / add-column after the fact.)
 * Inserts only if the cursor sits where a table is schema-legal.
 */
function insertTable(): Command {
  return (state, dispatch) => {
    const tableType = schema.nodes['table'];
    const rowType = schema.nodes['table_row'];
    const cellType = schema.nodes['table_cell'];
    const paragraphType = schema.nodes['paragraph'];
    if (!tableType || !rowType || !cellType || !paragraphType) return false;

    const rows = 3;
    const cols = 3;
    const cellContent = paragraphType.createAndFill();
    if (!cellContent) return false;
    const tableRows: PMNode[] = [];
    for (let r = 0; r < rows; r++) {
      const cells: PMNode[] = [];
      for (let c = 0; c < cols; c++) {
        cells.push(cellType.create(null, cellContent));
      }
      tableRows.push(rowType.create(null, cells));
    }
    const tableNode = tableType.create(null, tableRows);

    const $from = state.selection.$from;
    // Walk up from the cursor's deepest non-textblock ancestor outward,
    // finding the innermost container whose schema allows a `table`
    // child. doc / card / analytic_unit accept tables; card_body and
    // textblocks (paragraph, tag, etc.) don't. Insert immediately
    // before the ancestor that lives one level inside that container —
    // so a cursor inside a card produces a card-internal table just
    // above the card_body the cursor is in.
    let depth = $from.depth;
    while (depth > 0) {
      const container = $from.node(depth - 1);
      const idx = $from.index(depth - 1);
      if (container.canReplaceWith(idx, idx, tableType)) break;
      depth--;
    }
    if (depth === 0) {
      // Even the doc rejected the table — schema misconfiguration.
      return false;
    }
    const insertAt = $from.before(depth);
    if (!dispatch) return true;
    dispatch(state.tr.insert(insertAt, tableNode).scrollIntoView());
    return true;
  };
}

/** Normalize a default-key value (string | string[]) to an array. */
function keysArray(spec: string | string[]): string[] {
  return Array.isArray(spec) ? spec : [spec];
}

/** A static ribbon id, or a runtime plugin command id. */
export type AnyCommandId = RibbonCommandId | (string & {});

/** Label for any command id - static table first, plugin registry
 *  second, the raw id as a last resort. */
export function commandLabelFor(id: AnyCommandId): string {
  return (
    (RIBBON_COMMAND_LABELS as Record<string, string>)[id] ??
    pluginCommandLabel(id) ??
    id
  );
}

/** Palette search aliases for any command id - static table first,
 *  plugin keywords second (empty when neither has any). */
export function commandAliasesFor(id: AnyCommandId): readonly string[] {
  return (
    (RIBBON_COMMAND_ALIASES as Record<string, readonly string[] | undefined>)[id] ??
    pluginCommandKeywords(id)
  );
}

/**
 * Primary key for a command — the binding shown to the user (tooltips
 * etc.). Aliases (further entries in the array) exist for the user's
 * muscle memory but aren't surfaced in the chrome.
 */
export function primaryKeyFor(
  id: AnyCommandId,
  overrides: Partial<Record<string, string | string[]>> = {},
): string {
  const spec =
    overrides[id] ??
    (DEFAULT_RIBBON_KEYS as Partial<Record<string, string | string[]>>)[id] ??
    pluginDefaultKey(id) ??
    '';
  const keys = keysArray(spec);
  return keys[0] ?? '';
}

/**
 * Produce a `keymap()`-ready binding object. Each command's keys
 * (primary + aliases) all bind to the same Command. Overrides replace
 * the default array for a given command; passing an empty string or
 * empty array unbinds it. When a settings panel is added, it can
 * pass user-stored overrides here.
 */
export function buildRibbonKeymap(
  overrides: Partial<Record<string, string | string[]>> = {},
  ctx: RibbonContext = DEFAULT_RIBBON_CONTEXT,
): Record<string, Command> {
  const out: Record<string, Command> = {};
  for (const id of RIBBON_COMMAND_IDS) {
    const spec = overrides[id] ?? DEFAULT_RIBBON_KEYS[id];
    const cmd = commandFor(id, ctx);
    for (const key of keysArray(spec)) {
      if (!key) continue;
      out[key] = cmd;
    }
  }
  // Plugin commands bind after the static set. A plugin's DEFAULT key
  // never steals an already-bound key (static bindings win conflicts),
  // but an EXPLICIT user override rebinding a plugin command does win -
  // the user asked for it (the keybindings editor dislodges the loser).
  // Collision is judged on the FOLDED key so a case-only variant
  // ('Mod-Shift-D' vs static 'Mod-Shift-d') can't slip past.
  const staticFolded = foldedStaticKeys(overrides);
  const pluginFolded = new Set<string>();
  for (const id of pluginCommandIds()) {
    const explicit = overrides[id] != null;
    const spec = overrides[id] ?? pluginDefaultKey(id) ?? [];
    const cmd: Command = () => runPluginCommand(id);
    for (const key of keysArray(spec)) {
      if (!key) continue;
      // Collisions are judged on the FOLDED key against BOTH pools —
      // the static set and earlier plugin bindings — so a case-only
      // variant ('Mod-Shift-D' vs an earlier 'Mod-Shift-d') can't
      // double-bind between two plugins any more than against a
      // static command.
      const folded = foldKeyString(key);
      if (!explicit && (staticFolded.has(folded) || pluginFolded.has(folded) || out[key])) {
        continue;
      }
      pluginFolded.add(folded);
      out[key] = cmd;
    }
  }
  return out;
}

/**
 * Build a Command for a given ribbon command ID. Used by the ribbon
 * toolbar buttons so they stay keyed by stable IDs alongside the
 * keymap — when a binding is rebound through settings, buttons and
 * keys both follow.
 */
export function getRibbonCommand(
  id: AnyCommandId,
  ctx: RibbonContext = DEFAULT_RIBBON_CONTEXT,
): Command {
  if (isPluginCommandId(id)) return () => runPluginCommand(id);
  return commandFor(id as RibbonCommandId, ctx);
}

/**
 * Build a ProseMirror-keymap-style key string from a KeyboardEvent —
 * `"F3"`, `"Alt-F3"`, `"Mod-Alt-F3"`, etc. Modifier order matches
 * the convention used in `DEFAULT_RIBBON_KEYS`.
 */
export function ribbonKeyStringFor(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Mod');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  // Normalize digits via `e.code` so `Mod-Shift-1` matches even
  // though Shift+1 produces `e.key === '!'` on US layouts (and
  // layout-specific shifted chars elsewhere). PM-style keymap
  // matching already accounts for shifted symbol keys like `=`/`+`.
  if (/^Digit[0-9]$/.test(e.code)) {
    parts.push(e.code.slice(5));
  } else if (e.code === 'Space' || e.key === ' ') {
    // The space key's `e.key` is a literal " ", which would join into
    // "Mod-Shift- " and never match the canonical "Mod-Shift-Space"
    // binding. Normalize to PM's "Space" name so the global key
    // handler matches space bindings even when the editor is unfocused.
    parts.push('Space');
  } else if (e.key.length === 1) {
    // Single characters are matched case-insensitively, like
    // prosemirror-keymap does inside the editor: bindings are
    // registered lowercase ('Mod-Shift-s'), but a real Shift (or
    // CapsLock) keydown produces e.key === 'S' — without folding,
    // every shifted/caps-locked letter chord missed whenever focus
    // was outside the editor. Identity for digits and symbols.
    parts.push(e.key.toLowerCase());
  } else {
    parts.push(e.key);
  }
  return parts.join('-');
}

/** Case-fold a key string's final segment when it's a single
 *  character — 'Mod-Shift-S' ≡ 'Mod-Shift-s'. Saved user overrides
 *  captured before ribbonKeyStringFor folded letters are stored
 *  uppercase, so lookups must fold both sides. */
export function foldKeyString(key: string): string {
  const i = key.lastIndexOf('-');
  const tail = i < 0 ? key : key.slice(i + 1);
  if (tail.length !== 1) return key;
  return i < 0 ? key.toLowerCase() : key.slice(0, i) + '-' + tail.toLowerCase();
}

/** Folded forms of every key the static (non-plugin) commands resolve
 *  to under `overrides`. The single source of truth for plugin-vs-static
 *  collisions, shared by `buildRibbonKeymap` and
 *  `effectivePluginDefaultKeys` so the two can't drift. */
function foldedStaticKeys(
  overrides: Partial<Record<string, string | string[]>>,
): Set<string> {
  const set = new Set<string>();
  for (const id of RIBBON_COMMAND_IDS) {
    const spec = overrides[id] ?? DEFAULT_RIBBON_KEYS[id];
    for (const key of keysArray(spec)) {
      if (key) set.add(foldKeyString(key));
    }
  }
  return set;
}

/**
 * The default keys a plugin command actually binds to, after static
 * collisions are resolved — so display sites show what really
 * dispatches. An explicit override wins outright (returned verbatim,
 * empty entries dropped); otherwise each built-in default key is
 * suppressed when its folded form already belongs to a static command.
 */
export function effectivePluginDefaultKeys(
  id: AnyCommandId,
  overrides: Partial<Record<string, string | string[]>> = {},
): string[] {
  if (overrides[id] != null) return keysArray(overrides[id]!).filter((k) => !!k);
  const staticFolded = foldedStaticKeys(overrides);
  return keysArray(pluginDefaultKey(id) ?? []).filter(
    (k) => !!k && !staticFolded.has(foldKeyString(k)),
  );
}

/**
 * Look up a ribbon command ID by its current key binding. Returns
 * null if no command is bound to this key. Used by the global
 * F-key capture handler in `index.ts` to dispatch ribbon commands
 * when the editor isn't the focused element. Single-character keys
 * match case-insensitively (mirrors prosemirror-keymap, which tries
 * the Shift-base variant inside the editor).
 */
export function ribbonCommandForKey(
  keyString: string,
  overrides: Partial<Record<string, string | string[]>> = {},
): AnyCommandId | null {
  const folded = foldKeyString(keyString);
  // An explicit override that rebinds a plugin command wins over a
  // static DEFAULT key (mirrors buildRibbonKeymap above).
  for (const id of pluginCommandIds()) {
    const spec = overrides[id];
    if (spec != null && keysArray(spec).some((k) => foldKeyString(k) === folded)) return id;
  }
  for (const id of RIBBON_COMMAND_IDS) {
    const spec = overrides[id] ?? DEFAULT_RIBBON_KEYS[id];
    if (keysArray(spec).some((k) => foldKeyString(k) === folded)) return id;
  }
  for (const id of pluginCommandIds()) {
    const spec = overrides[id] ?? pluginDefaultKey(id) ?? [];
    if (keysArray(spec).some((k) => foldKeyString(k) === folded)) return id;
  }
  return null;
}

/**
 * Format a ProseMirror-keymap key string for display in a tooltip.
 * Substitutes the platform's modifier for "Mod-" and pretty-prints
 * the separator.
 */
export function formatKeyForDisplay(key: string): string {
  if (!key) return '';
  const isMac =
    typeof navigator !== 'undefined' &&
    /mac/i.test(navigator.platform ?? '');
  return key
    .replace(/Mod-/g, isMac ? '⌘' : 'Ctrl+')
    .replace(/Shift-/g, isMac ? '⇧' : 'Shift+')
    .replace(/Alt-/g, isMac ? '⌥' : 'Alt+')
    .replace(/-/g, '+');
}
