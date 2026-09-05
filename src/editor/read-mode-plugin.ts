/**
 * Read-mode decoration plugin.
 *
 * Tags each text node with one of two CSS classes:
 *   - `pmd-rm-keep`  — read-aloud content; visible in read mode
 *   - `pmd-rm-hide`  — non-read-aloud filler; hidden in read mode
 *
 * The decision is made per text node based on its parent paragraph and
 * its marks:
 *   - In `cite_paragraph`: keep iff carrying `cite_mark` OR `highlight` —
 *     or, with "Read mode: keep entire cite" on, every text node of a
 *     cite that has at least one such run (`keepsWholeParagraph`).
 *   - In `card_body` / `paragraph` / `undertag`: keep iff carrying `highlight`.
 *   - Elsewhere (heading paragraphs etc.): no decoration — block-level
 *     CSS handles whether they show.
 *
 * The decorations are emitted only when read mode is *active*; with
 * read mode off there's nothing to render and we keep an empty set.
 * Toggling the setting fires a meta-flagged no-op transaction
 * (`PMD_READ_MODE_TOGGLE`) so the plugin can rebuild the set on
 * demand.
 *
 * Doc edits trigger an *incremental* update: existing decorations get
 * mapped through the transaction (positions adjust), then decorations
 * inside the touched region (expanded to top-level container) are
 * recomputed. This is O(touched-region) instead of O(whole-doc) per
 * keystroke — the dominant typing-latency win for large docs.
 *
 * Why the plugin instead of pure CSS: marks nest in the rendered DOM
 * (a highlight inside an underline ends up inside the underline's
 * span). Targeting "non-read-aloud text" via CSS specificity races
 * against the nested wrapper structure; tagging text nodes directly
 * with a per-node class avoids that entirely.
 */

import { Plugin } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { undo, redo, undoDepth, redoDepth } from 'prosemirror-history';
import { changedRange, expandToTopLevel } from './decoration-range.js';
import { isSyncOrigin } from './sync-origin.js';
import { NORMALIZER_META } from './normalizer-guard.js';
import { settings } from './settings.js';
import {
  toggleReadingMarker,
  isReadingMarkerColor,
  READING_MARKER_META,
  READ_MODE_UNDO_META,
  READ_MODE_DRAG_META,
} from './reading-marker.js';

/** Meta key that flips read mode on or off for a specific view.
 *  The meta value is the *desired* state — `true` on, `false` off.
 *  The state is carried explicitly rather than re-read from the
 *  global `settings.readMode`: read mode is per-pane under
 *  multi-doc, so the global setting can stay `false` while an
 *  individual pane is on. */
export const PMD_READ_MODE_TOGGLE = 'pmdReadModeToggle';

interface ReadModeState {
  on: boolean;
  decorations: DecorationSet;
  /** `undoDepth` captured when read mode was entered. In read mode, undo is
   *  allowed only while the current depth exceeds this — i.e. only the
   *  marker edits added since entry are undoable, never earlier edits. */
  baseUndoDepth: number;
  /** Whether a marker edit has been made since entering read mode. Gates
   *  redo so it can't re-apply a pre-read-mode undo (dropping a marker
   *  clears the redo stack, so once dirtied, redo only touches markers). */
  dirtied: boolean;
}

export const readModePlugin: Plugin<ReadModeState> = new Plugin<ReadModeState>({
  state: {
    init() {
      // Always start OFF — the dispatching code path
      // (`applyReadMode` / `applyReadModeToTarget`) sends a toggle
      // meta the moment a view should be in read mode, so per-view
      // state starts in a known-good baseline regardless of any
      // global setting.
      return { on: false, decorations: DecorationSet.empty, baseUndoDepth: 0, dirtied: false };
    },
    apply(tr, prev, _oldState, newState) {
      const meta = tr.getMeta(PMD_READ_MODE_TOGGLE);
      if (meta !== undefined) {
        const on = meta === true;
        return {
          on,
          decorations: on ? computeFullSet(newState.doc) : DecorationSet.empty,
          // Snapshot the undo depth on entry so read-mode undo only reverses
          // edits (markers) made from here on.
          baseUndoDepth: on ? undoDepth(newState) : prev.baseUndoDepth,
          dirtied: false,
        };
      }
      if (!tr.docChanged) return prev;
      if (!prev.on) return prev;

      // A marker or drag edit (not an undo/redo) dirties read mode → redo is allowed.
      const dirtied =
        prev.dirtied ||
        tr.getMeta(READING_MARKER_META) === true ||
        tr.getMeta(READ_MODE_DRAG_META) === true;

      const range = changedRange(tr);
      if (!range) {
        return { ...prev, decorations: prev.decorations.map(tr.mapping, tr.doc), dirtied };
      }

      // Map existing decorations through the change, then replace any
      // that fall inside the recompute window.
      const expanded = expandToTopLevel(tr.doc, range.from, range.to);
      const mapped = prev.decorations.map(tr.mapping, tr.doc);
      const stale = mapped.find(expanded.from, expanded.to);
      const fresh = computeDecorationsInRange(tr.doc, expanded.from, expanded.to);
      return { ...prev, decorations: mapped.remove(stale).add(tr.doc, fresh), dirtied };
    },
  },
  props: {
    decorations(state) {
      return readModePlugin.getState(state)?.decorations;
    },
    // Read mode keeps the editor editable (so the caret is placeable) but
    // blocks edits via `filterTransaction` below. Space and Enter do
    // nothing else here, so they're the effortless way to drop/remove a
    // reading-position marker at the podium. The command's bound shortcut
    // (Mod-Shift-D) still works via the normal keymap.
    handleDOMEvents: {
      keydown(view, event) {
        if (!readModePlugin.getState(view.state)?.on) return false;
        const bare = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
        if (bare && (event.key === 'Enter' || event.key === ' ' || event.code === 'Space')) {
          if (toggleReadingMarker(view)) {
            event.preventDefault();
            return true;
          }
        }
        // Swallow bare editing keys at the DOM level. `filterTransaction`
        // already guarantees no doc change, but the view is EDITABLE in
        // read mode (both layouts since 2026-07-27 — the caret must be
        // placeable), so without this the browser would mutate the DOM,
        // PM would parse the mutation, the filter would reject it, and
        // PM would redraw to revert — wasted churn per keystroke, and
        // the first such mutation trips PM's checkCSS console warning
        // (single-pane read mode deliberately resets white-space to
        // `normal` for chunk-separator collapsing). Shift is allowed
        // (shifted letters are still typing); real chords, navigation
        // keys, and F-keys all pass through untouched.
        const noChord = !event.ctrlKey && !event.metaKey && !event.altKey;
        if (
          noChord &&
          (event.key.length === 1 ||
            event.key === 'Enter' ||
            event.key === 'Backspace' ||
            event.key === 'Delete')
        ) {
          event.preventDefault();
          return true;
        }
        return false;
      },
    },
  },
  // Read mode's lock: while on, reject any document change except the
  // reading-marker edit, the (already-bounded) marker undo/redo, and
  // drag-move / dropzone / receive-pill insertions (position-validated by the
  // drag controller, so safe while reading). Selection moves and meta-only
  // transactions (no doc change) pass, so the cursor stays usable.
  //
  // Two categories bypass the lock outright: sync-origin transactions
  // (already-merged remote content — rejecting one desynchronizes the
  // editor from the shared doc, see sync-origin.ts) and normalizer
  // output (a normalizer only fires in response to a transaction this
  // filter already admitted; blocking the fix-up would strand the doc
  // half-normalized until read mode exits).
  filterTransaction(tr, state) {
    if (!readModePlugin.getState(state)?.on) return true;
    if (!tr.docChanged) return true;
    return (
      isSyncOrigin(tr) ||
      tr.getMeta(NORMALIZER_META) === true ||
      tr.getMeta(READING_MARKER_META) === true ||
      tr.getMeta(READ_MODE_UNDO_META) === true ||
      tr.getMeta(READ_MODE_DRAG_META) === true
    );
  },
});

/** Undo — but in read mode, only as far back as the markers dropped since
 *  read mode was entered (never earlier edits). Outside read mode, plain
 *  undo. Bound to Mod-Z. */
export const readModeAwareUndo: Command = (state, dispatch, view) => {
  const rm = readModePlugin.getState(state);
  if (rm?.on) {
    if (undoDepth(state) <= rm.baseUndoDepth) return true; // nothing marker-ish to undo
    return undo(state, dispatch ? (tr) => dispatch(tr.setMeta(READ_MODE_UNDO_META, true)) : undefined, view);
  }
  return undo(state, dispatch, view);
};

/** Redo — in read mode, only marker edits undone since entry (a dropped
 *  marker clears any earlier redo, so `dirtied` means redo is marker-only).
 *  Outside read mode, plain redo. Bound to Mod-Y / Mod-Shift-Z. */
export const readModeAwareRedo: Command = (state, dispatch, view) => {
  const rm = readModePlugin.getState(state);
  if (rm?.on) {
    if (!rm.dirtied || redoDepth(state) === 0) return true;
    return redo(state, dispatch ? (tr) => dispatch(tr.setMeta(READ_MODE_UNDO_META, true)) : undefined, view);
  }
  return redo(state, dispatch, view);
};

/** Read mode keeps a text node visible iff it carries the paragraph's
 *  read-aloud mark — or is a red reading-position marker (so the marker
 *  you drop while reading actually shows). */
function isReadKept(child: PMNode, markNames: readonly string[]): boolean {
  return child.marks.some(
    (m) =>
      markNames.includes(m.type.name) ||
      (m.type.name === 'font_color' && isReadingMarkerColor(m.attrs['color'] as string)),
  );
}

/** "Read mode: keep entire cite" — a cite paragraph with ANY read-aloud
 *  run shows all of its text (qualifications, source, date), not just the
 *  marked runs. A cite with nothing marked still collapses, like a body
 *  paragraph with nothing highlighted, so an unmarked cite never shows as
 *  a stray line. The setting is read at decoration time; both shells
 *  rebuild the set when it flips. */
function keepsWholeParagraph(para: PMNode, markNames: readonly string[]): boolean {
  if (para.type.name !== 'cite_paragraph' || !settings.get('readModeKeepEntireCite')) return false;
  let any = false;
  para.forEach((child) => {
    if (!any && child.isText && !!child.text && isReadKept(child, markNames)) any = true;
  });
  return any;
}

function computeFullSet(doc: PMNode): DecorationSet {
  return DecorationSet.create(doc, computeDecorationsInRange(doc, 0, doc.content.size));
}

/** Textblocks whose text read mode always shows (headings / structural
 *  labels — no rm-keep/hide decoration; block-level CSS shows them). */
const READ_MODE_HEADING_BLOCKS = new Set(['tag', 'analytic', 'pocket', 'hat', 'block']);

/** Marks whose text a cite paragraph reads aloud: the cite mark, and —
 *  since 1.0 — highlights too, so a highlighted phrase inside a cite no
 *  longer vanishes in read mode (field find, 2026-08-14). */
const CITE_KEPT_MARKS: readonly string[] = ['cite_mark', 'highlight'];
const BODY_KEPT_MARKS: readonly string[] = ['highlight'];

/** The read-aloud marks a textblock is filtered by, `'heading'` if its
 *  text is always shown, or null if it isn't read-mode content. Mirrors
 *  computeDecorationsInRange's per-node decision. */
function readKeptKind(nodeName: string): readonly string[] | 'heading' | null {
  if (READ_MODE_HEADING_BLOCKS.has(nodeName)) return 'heading';
  if (nodeName === 'cite_paragraph') return CITE_KEPT_MARKS;
  if (nodeName === 'card_body' || nodeName === 'paragraph' || nodeName === 'undertag') {
    return BODY_KEPT_MARKS;
  }
  return null;
}

/** Whether read mode keeps this inline text node of `parent` visible.
 *  Shared with destructive conversions so their audible-text rule cannot
 *  drift from the display-only mode. */
export function isReadModeKeptText(child: PMNode, parent: PMNode): boolean {
  if (!child.isText) return false;
  const kind = readKeptKind(parent.type.name);
  if (kind === 'heading') return true;
  if (kind === null) return false;
  return isReadKept(child, kind) || keepsWholeParagraph(parent, kind);
}

/**
 * The position of the text read mode keeps VISIBLE that is nearest to
 * `pos` — a highlighted run, a cite, or heading/label text. Read-mode
 * scroll anchoring pins to this (content that exists in BOTH modes)
 * rather than a structural block boundary above the reader: the body
 * between such a boundary and the reader collapses in read mode, so
 * pinning the boundary drifts the reader's actual spot. Searches within
 * the enclosing top-level container; returns null if it holds no
 * read-aloud content (caller falls back to the raw position).
 */
export function nearestReadKeptPos(doc: PMNode, pos: number): number | null {
  const size = doc.content.size;
  const clamped = Math.max(0, Math.min(pos, size));
  const { from, to } = expandToTopLevel(doc, clamped, clamped);
  let best: number | null = null;
  let bestDist = Infinity;
  const consider = (cand: number): void => {
    const dist = Math.abs(cand - clamped);
    if (dist < bestDist) {
      bestDist = dist;
      best = cand;
    }
  };
  doc.nodesBetween(from, to, (node, nodePos) => {
    const kind = readKeptKind(node.type.name);
    if (kind === null) return true; // a container — descend
    if (kind === 'heading') {
      if (node.content.size > 0) {
        const start = nodePos + 1;
        const end = nodePos + node.nodeSize - 1;
        consider(Math.max(start, Math.min(clamped, end)));
      }
      return false;
    }
    // Body / cite text: only runs actually carrying the read-aloud mark
    // (or the whole cite, when the setting keeps it).
    const whole = keepsWholeParagraph(node, kind);
    node.forEach((child, offset) => {
      if (!child.isText || !child.text) return;
      if (!whole && !isReadKept(child, kind)) return;
      const start = nodePos + 1 + offset;
      const end = start + child.nodeSize;
      consider(Math.max(start, Math.min(clamped, end)));
    });
    return false;
  });
  return best;
}

/**
 * The FIRST text position in `[from, to]`, scanning forward, that read
 * mode keeps visible — a highlighted run, a cite, or heading/label text.
 * Returns null if the range holds no read-aloud content.
 *
 * This is the read-mode scroll anchor: the first content below the
 * viewport top that survives the toggle. Everything hidden above it
 * collapses to nothing, so pinning it to the top of the viewport lands
 * the reader on exactly the first thing they'll still see — instead of
 * drifting to wherever a structural boundary happened to be.
 */
export function firstReadKeptPos(doc: PMNode, from: number, to: number): number | null {
  const size = doc.content.size;
  const lo = Math.max(0, Math.min(from, size));
  const hi = Math.max(lo, Math.min(to, size));
  let found: number | null = null;
  doc.nodesBetween(lo, hi, (node, nodePos) => {
    if (found !== null) return false;
    const kind = readKeptKind(node.type.name);
    if (kind === null) return true; // container — descend
    if (kind === 'heading') {
      if (node.content.size > 0) found = Math.max(lo, nodePos + 1);
      return false;
    }
    const whole = keepsWholeParagraph(node, kind);
    node.forEach((child, offset) => {
      if (found !== null) return;
      if (!child.isText || !child.text) return;
      if (!whole && !isReadKept(child, kind)) return;
      const end = nodePos + 1 + offset + child.nodeSize;
      if (end <= lo) return; // entirely above the scan start
      found = Math.max(lo, nodePos + 1 + offset);
    });
    return false;
  });
  return found;
}

/**
 * Build the decoration list for text nodes whose start position lies
 * within [from, to]. Callers pass a `from`/`to` already expanded to
 * top-level container boundaries so partial paragraphs aren't
 * visited mid-traversal.
 *
 * Two-pass per paragraph: for each kept text node we look at the
 * *next* text child. End-of-run (next node is hidden, or no next
 * node) gets a widget-decoration separator inserted AT the
 * boundary. The widget renders outside any mark wrappers — a plain
 * `<span>` containing a space — so the separator inherits no
 * emphasis box / highlight background. Mid-run kept spans (e.g.
 * a single highlighted phrase split into pieces by a bold sub-mark)
 * get no separator, so the highlight band reads continuously.
 */
function computeDecorationsInRange(doc: PMNode, from: number, to: number): Decoration[] {
  const decos: Decoration[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    const kind = readKeptKind(node.type.name);
    if (kind !== null && kind !== 'heading') {
      decorateParagraph(node, pos, kind, decos);
      // We've already walked this paragraph's inline children; don't
      // recurse into them again from the outer nodesBetween.
      return false;
    }
    return true;
  });
  return decos;
}

/** Build the separator widget's DOM. A bare `<span>` containing a
 *  single space character. Lives as a sibling of the mark wrappers
 *  rather than a child, so emphasis boxes / highlight backgrounds
 *  don't bleed into the gap. */
function makeRunSeparator(): HTMLElement {
  const span = document.createElement('span');
  span.className = 'pmd-rm-separator';
  span.textContent = ' ';
  // Widgets are inherently non-editable in PM; the explicit attr
  // here is belt-and-suspenders against any DOM mutation paths
  // that might otherwise try to step inside it.
  span.contentEditable = 'false';
  return span;
}

/** Walk one paragraph's direct text children in order. For each
 *  kept text node, decide whether it ends a run; if so, emit a
 *  widget separator at the boundary. */
function decorateParagraph(
  para: PMNode,
  paraPos: number,
  markNames: readonly string[],
  decos: Decoration[],
): void {
  interface Item { pos: number; nodeSize: number; keep: boolean }
  const items: Item[] = [];
  const whole = keepsWholeParagraph(para, markNames);
  para.forEach((child, offset) => {
    if (!child.isText || !child.text) return;
    const keep = whole || isReadKept(child, markNames);
    items.push({ pos: paraPos + 1 + offset, nodeSize: child.nodeSize, keep });
  });
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.keep) {
      decos.push(
        Decoration.inline(item.pos, item.pos + item.nodeSize, {
          class: 'pmd-rm-keep',
        }),
      );
      // End-of-run boundary: drop a sibling-level separator widget
      // at the position where the next inline content begins.
      const next = items[i + 1];
      const endsRun = !next || !next.keep;
      if (endsRun) {
        decos.push(
          Decoration.widget(item.pos + item.nodeSize, makeRunSeparator, {
            side: 1,
            ignoreSelection: true,
          }),
        );
      }
    } else {
      decos.push(
        Decoration.inline(item.pos, item.pos + item.nodeSize, {
          class: 'pmd-rm-hide',
        }),
      );
    }
  }
}
