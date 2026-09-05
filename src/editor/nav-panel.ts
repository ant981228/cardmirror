/**
 * Navigation panel — outline view of headings (ARCHITECTURE.md §8).
 *
 * Renders a tree of pocket / hat / block / tag / analytic entries
 * indented by outline level. Click an entry to jump to the heading
 * in the editor; chevrons and double-click toggle collapse; the
 * level buttons filter like Word's "Show Heading N". Also provides
 * level-locked multi-select, drag-reorder via the shared drag
 * controller (long-press on mobile), a heading context menu, and
 * find-hit decorations.
 */

import type { EditorView } from 'prosemirror-view';
import { type Node as PMNode, DOMSerializer } from 'prosemirror-model';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import { type Mappable } from 'prosemirror-transform';
import { settings, SETTINGS_DEFAULTS } from './settings.js';
import { CLIPBOARD_BUSY_MESSAGE, writeClipboardHtml } from './clipboard-write.js';
import { isCutInPlaceDoc, markCutInPlace } from './cut-in-place.js';
import { showToast } from './toast.js';
import { setManualShadowSelection } from './similar-selection-plugin.js';
import {
  insertSelfRef,
  insertInDocCopy,
  selfRefSelectionPos,
} from './self-transclusion-commands.js';
import { registerOpenContextMenu, clearOpenContextMenu } from './context-menu-registry.js';
import { dragController, type DragItem, type DragSurface } from './drag-controller.js';
import { isTransclusionNode, zoneIdentity } from './transclusion.js';
import { isSelfRef, resolveSelfProjection } from './self-transclusion.js';
import { transclusionDivergenceKey } from './transclusion-divergence-plugin.js';

/** Outline entries including the content projected by intra-doc live windows
 *  (`self_ref`). A window is an atom with no doc children, so `collectHeadings`
 *  alone misses it; here each window's source projection is resolved and its
 *  headings spliced in at the window's position as READ-ONLY (`windowed`) rows.
 *  Kept in the nav layer so `headings.ts` needn't depend on self-transclusion. */
function collectOutlineWithWindows(doc: PMNode): HeadingEntry[] {
  const base = collectHeadings(doc);
  const projected: HeadingEntry[] = [];
  doc.descendants((node, pos) => {
    if (!isSelfRef(node)) return true;
    const proj = resolveSelfProjection(doc, String(node.attrs['source_heading_id'] ?? ''));
    if (proj.missing || proj.content.size === 0) return false;
    const wrapped = doc.type.create(null, proj.content);
    for (const e of collectHeadings(wrapped)) {
      // Numbering lookup key: the mirrored card's REAL doc position. The
      // projection's coordinate space maps 1:1 onto the self_ref's child
      // content (the content plugin keeps them equal), whose positions
      // start at pos + 1 — the same positions computeNumbering keys the
      // window's cards under, so the nav can show the host-contextual
      // number the editor shows.
      let windowCardPos: number | null = null;
      if (e.type === 'tag' || e.type === 'analytic') {
        const $e = wrapped.resolve(e.pos);
        if ($e.parentOffset === 0) windowCardPos = pos + 1 + $e.before();
      }
      // Point every projected row at the window and mark it windowed: no real
      // doc node backs it, so id must be null and it's read-only in the nav.
      projected.push({ ...e, pos, zonePos: pos, id: null, windowed: true, windowCardPos });
    }
    return false; // atom — nothing to descend into
  });
  if (!projected.length) return base;
  // Stable sort by pos slots each window's projected block at the window's
  // position (no base heading shares a self_ref's pos), preserving inner order.
  return [...base, ...projected].sort((a, b) => a.pos - b.pos);
}
import { preciseScrollIntoView, scrollToHeadingId } from './precise-scroll.js';
import {
  collectHeadings,
  computeHeadingRange,
  zoneRangeForEntry,
  headingInsertPos,
  TYPE_LABEL,
  type HeadingEntry,
} from './headings.js';
import { setIcon } from './icons';
import { isMobileShellActive } from './mobile-plugin.js';
import { createNumberGlyph, numberingDisplaySig } from './numbering-plugin.js';
import { computeNumbering } from './numbering.js';

/** Minimum nav-pane width — must fit the 4 level buttons + the
 *  close (×) button + row padding; anything narrower clips the ×. */
const NAV_WIDTH_MIN = 180;
const NAV_WIDTH_MAX = 800;

/** Max gap between two plain clicks on the same nav entry to count as a
 *  double-click (collapse toggle). Approximates the OS double-click
 *  window; see `handlePlainClickDouble`. */
const NAV_DOUBLE_CLICK_MS = 500;

/** Mobile long-press window before a row drag arms (movement within
 *  the window cancels — it's a scroll). Below typical browser
 *  context-menu timing so our pickup wins the gesture. */
const NAV_LONG_PRESS_MS = 450;

/** Shared empty set for the no-divergence fast path (avoids per-render alloc). */
const EMPTY_POSITIONS: ReadonlySet<number> = new Set<number>();

/**
 * Whether the user is holding the platform's "copy" modifier during
 * a drag. File-manager convention: Ctrl on Windows/Linux, Option (Alt)
 * on macOS. Treating both as equivalent is harmless — neither has a
 * conflicting drag semantic on its non-native platform.
 */
function isCopyModifier(
  e: { ctrlKey: boolean; altKey: boolean },
): boolean {
  return e.ctrlKey || e.altKey;
}

function applyNavWidthCss(px: number): void {
  const clamped = Math.max(NAV_WIDTH_MIN, Math.min(NAV_WIDTH_MAX, px));
  document.documentElement.style.setProperty('--nav-width', `${clamped}px`);
}

// Nav width is PER-WINDOW: applied once from the `navWidth` setting when
// this window boots (module init — NOT per panel construction, which in
// multi-pane happens per opened doc and would re-pull whatever another
// window persisted since). Drags apply locally and persist the value as
// the DEFAULT for windows opened later; the settings subscriber
// deliberately does not re-apply it, so a drag in one window never
// resizes another (field request 2026-07-15 — same model as the nav
// depth default).
if (typeof document !== 'undefined') {
  applyNavWidthCss(settings.get('navWidth'));
}

/**
 * Attach a draggable resize handle to the right edge of `host`. Width is
 * stored in the `--nav-width` CSS custom property — shared by the single-doc
 * nav panel and the multi-pane rail, so both layouts resize in lockstep
 * WITHIN a window — and persisted as the `navWidth` setting, which is the
 * DEFAULT for windows opened later (never applied live to other windows).
 * While dragging, `host` carries `pmd-nav-resizing` and `<body>` carries
 * `pmd-nav-resize-active`. The host must be a positioned element so the
 * absolutely-positioned handle aligns to its right edge. Returns the
 * handle element.
 */
export function installNavResizeHandle(host: HTMLElement): HTMLElement {
  const handle = document.createElement('div');
  handle.className = 'pmd-nav-resize-handle';
  handle.setAttribute('aria-label', 'Resize outline panel');
  handle.setAttribute('role', 'separator');
  handle.title = 'Drag to resize — double-click to reset';
  host.appendChild(handle);

  // Double-click snaps back to the factory default width. Persisted
  // like a drag: any manual width change is also the default for
  // future windows (one rule, no special cases). The two click/
  // release pairs that precede dblclick each run the drag-end persist
  // with an unchanged width — harmless no-ops.
  handle.addEventListener('dblclick', () => {
    applyNavWidthCss(SETTINGS_DEFAULTS.navWidth);
    settings.set('navWidth', SETTINGS_DEFAULTS.navWidth);
  });

  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  const onMove = (e: MouseEvent) => {
    if (!dragging) return;
    const delta = e.clientX - startX;
    applyNavWidthCss(startWidth + delta);
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('pmd-nav-resize-active');
    host.classList.remove('pmd-nav-resizing');
    const w = getComputedStyle(host).width;
    const pixels = parseInt(w, 10);
    if (Number.isFinite(pixels)) {
      settings.set('navWidth', pixels);
    }
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };

  handle.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX;
    startWidth = host.getBoundingClientRect().width;
    document.body.classList.add('pmd-nav-resize-active');
    host.classList.add('pmd-nav-resizing');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    e.preventDefault();
  });

  return handle;
}

export class NavigationPanel {
  private root: HTMLElement;
  private view: EditorView | null = null;
  private readonly readOnly: boolean = false;
  private listEl: HTMLOListElement;
  private emptyEl: HTMLElement;
  private currentDoc: PMNode | null = null;
  /** Set of heading IDs whose subtrees are collapsed. Derived from
   *  maxLevel on attach; ad-hoc chevron clicks update during a session.
   *  Not persisted (heading IDs are doc-specific). */
  private collapsed: Set<string> = new Set();
  private levelButtons: HTMLButtonElement[] = [];
  private unsubscribeSettings: (() => void) | null = null;
  private unsubscribeDrag: (() => void) | null = null;
  private unregisterSurface: (() => void) | null = null;
  private destroyed = false;
  /** Custom handler for the header × button. When set (multi-pane,
   *  where each section is one document's outline) the × closes just
   *  THIS section via the callback; otherwise it falls back to
   *  toggling the global `navPaneVisible` setting (single-doc, where
   *  there's only one pane and × means "hide the nav pane"). */
  private onClose: (() => void) | null = null;

  // ---- Selection state (multi-select) ----
  private selectedIds: Set<string> = new Set();
  private selectionAnchorId: string | null = null;
  /** Doc position of the `self_ref` whose window row(s) carry the caret
   *  highlight, or null. Projected (windowed) rows have `id: null`, so the
   *  id-keyed `selectedIds` can't reach them — a node-selected live view is
   *  tracked here instead and lit by matching `entry.pos`. */
  private selectedWindowPos: number | null = null;
  /** Outline level of currently selected entries; selection is
   *  level-locked (so tags + analytics — both level 4 — can be
   *  selected together, but a tag + a block cannot). */
  private selectionLevel: number | null = null;
  /** When the user plain-clicks on an entry that's part of a multi-
   *  selection, defer the "replace selection with just this entry"
   *  action to pointerup-without-drag (so the drag uses the multi).
   */
  private deferredClickFinalize: HeadingEntry | null = null;
  /** Modifier state captured at pointerdown — drives whether
   *  pointerup-without-drag does a jumpTo (plain click) or just
   *  finalizes selection (Ctrl/Shift click). */
  private pointerDownModifier: 'none' | 'shift' | 'meta' = 'none';
  /** Manual double-click detection. The native `dblclick` is unreliable
   *  here: a plain click jumps the editor, whose transaction schedules a
   *  debounced nav re-render that recreates every `<li>` — and the
   *  browser only fires `dblclick` when both clicks hit the *same* node.
   *  We instead match the entry id + timestamp across two plain clicks,
   *  which is immune to the `<li>` being rebuilt between them. */
  private lastClickId: string | null = null;
  private lastClickTime = 0;
  /** Entry ids that have children (so can be collapse-toggled). Rebuilt
   *  each render; keyed by id so double-click detection survives the
   *  `<li>` being recreated. */
  private collapsibleIds: Set<string> = new Set();

  // ---- Drag-and-drop state ----
  private liEntries: Map<HTMLLIElement, HeadingEntry> = new Map();
  private dragStartX = 0;
  private dragStartY = 0;
  private dragStartLi: HTMLLIElement | null = null;
  private dragStartEntry: HeadingEntry | null = null;
  private dragHandlersAttached = false;
  private pickupPill: HTMLElement | null = null;
  private dropIndicators: HTMLElement[] = [];
  /** True while `renderDropIndicators` un-hid an empty outline's
   *  `listEl` so its end-of-doc slot could hit-test; restored by
   *  `removeDropIndicators`. */
  private listShownForDrag = false;
  /** Heading IDs we expanded automatically during the active drag.
   *  Restored on drag-off / cancel. */
  private autoExpanded: Set<string> = new Set();
  private autoExpandTimer: ReturnType<typeof setTimeout> | null = null;
  private autoExpandTarget: string | null = null;

  /** Find-hit positions to surface as nav decorations. The "hit"
   *  set is just an unordered list of doc positions; each render
   *  pass computes which RENDERED heading is the deepest ancestor
   *  of each hit and marks those headings with a "has-hit"
   *  class. Empty / null = no decoration. */
  private findHitPositions: number[] = [];
  /** Per-id pending re-collapse timers — armed when the pointer
   *  leaves an auto-expanded entry's subtree, cleared if it returns
   *  before the timer fires. Mirrors the auto-expand 400ms hover. */
  private pendingRestoreTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private boundOnDragMove = (e: PointerEvent) => this.onDragMove(e);
  private boundOnDragUp = (e: PointerEvent) => this.onDragUp(e);
  private boundOnDragKey = (e: KeyboardEvent) => this.onDragKey(e);
  private boundOnDragKeyUp = (e: KeyboardEvent) => this.onDragKey(e);

  // ── Mobile (SPEC-mobile-view.md P3) ──
  /** Long-press pickup: on touch a plain pan must scroll the list, so
   *  a row drag arms only after a still-press of this length. */
  private longPressTimer: number | null = null;
  private longPressLi: HTMLLIElement | null = null;
  /** While a long-press drag lives, swallow touch panning so the
   *  browser can't hijack the gesture into a scroll mid-drag. The
   *  list's `touch-action: pan-y` governs the pre-arm phase. */
  private boundTouchBlocker = (e: TouchEvent): void => {
    if (dragController.isActive()) e.preventDefault();
  };
  /** Destination mode ("Send to…" on mobile): row taps call this
   *  instead of navigating. The anchor rect (the tapped row) lets
   *  the caller position its above/below placement chooser. */
  private destinationCb:
    | ((entry: HeadingEntry, anchor: DOMRect | null) => void)
    | null = null;
  /** Mobile drag-to-scroll: once movement cancels the long-press,
   *  the list pans under the pointer. Owned manually (the list has
   *  `touch-action: none` on mobile) so mouse, emulated touch, and
   *  real touch all behave identically. `panPointer` tracks the
   *  candidate gesture from pointerdown anywhere in the list;
   *  `manualPan` is set once movement commits it to a scroll. */
  private panPointer: { id: number; startX: number; startY: number } | null = null;
  private manualPan: { lastY: number } | null = null;

  /** The outline-level filter for THIS panel. Always per-instance and
   *  TRANSIENT: the 1–4 buttons adjust the open doc's view only, and
   *  every `attach()` (new doc) resets it to the `navMaxLevel` setting
   *  ("Default navigation depth", Settings → General). The buttons
   *  never write the setting. */
  private localMaxLevel: number = settings.get('navMaxLevel');
  /** Heading IDs seen at the last render. Used by
   *  `applyMaxLevelToNewHeadings` (called after cross-view drops in
   *  multi-pane mode) to identify headings that were dropped /
   *  pasted in since the previous render and need to be auto-
   *  collapsed to the current `maxLevel`. Existing user-expanded
   *  parents stay expanded. */
  private lastSeenIds: Set<string> = new Set();
  private get maxLevel(): number {
    return this.localMaxLevel;
  }

  constructor(
    parent: HTMLElement,
    opts?: {
      onClose?: () => void;
      /** Outline-only mode (the recover dialogs' version previews):
       *  navigation, level buttons, and expand/collapse work, but the
       *  panel never starts drags and never registers as a drop
       *  surface — its view is a read-only preview, not a document
       *  anyone may reorder. */
      readOnly?: boolean;
    },
  ) {
    this.onClose = opts?.onClose ?? null;
    this.readOnly = opts?.readOnly === true;
    this.root = document.createElement('aside');
    this.root.className = 'pmd-nav-panel';

    const header = document.createElement('header');

    const levelGroup = document.createElement('div');
    levelGroup.className = 'pmd-nav-level-group';
    levelGroup.title = 'Show heading levels — click N to show levels 1 through N';
    for (let lvl = 1; lvl <= 4; lvl++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pmd-nav-level-btn';
      btn.dataset['level'] = String(lvl);
      btn.textContent = String(lvl);
      btn.title = `Show heading 1${lvl > 1 ? `–${lvl}` : ''}`;
      btn.addEventListener('click', () => this.setMaxLevel(lvl));
      this.levelButtons.push(btn);
      levelGroup.appendChild(btn);
    }
    header.appendChild(levelGroup);

    // Close × in the top-right — mirrors the ribbon's nav-pane
    // toggle but lives where the user is already looking when
    // they want to dismiss the outline.
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'pmd-nav-close';
    setIcon(closeBtn, 'close');
    // In multi-pane mode the × closes just this document's outline
    // section (via `onClose`); in single-doc it hides the whole pane.
    const closeLabel = this.onClose ? "Hide this document's outline" : 'Hide navigation pane';
    closeBtn.title = closeLabel;
    closeBtn.setAttribute('aria-label', closeLabel);
    closeBtn.addEventListener('click', () => {
      if (this.onClose) this.onClose();
      else settings.set('navPaneVisible', false);
    });
    header.appendChild(closeBtn);

    this.root.appendChild(header);
    this.updateLevelButtonsActive();

    this.listEl = document.createElement('ol');
    this.listEl.className = 'pmd-nav-list';
    this.root.appendChild(this.listEl);
    // Mobile drag-to-scroll engages from ANY pointerdown in the list
    // — rows and the blank space below them alike (`touch-action:
    // none` on the list means nothing scrolls unless we do it).
    this.listEl.addEventListener('pointerdown', (e) => {
      if (!isMobileShellActive() || !e.isPrimary) return;
      this.panPointer = {
        id: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
      };
      this.attachDragHandlers();
    });

    this.emptyEl = document.createElement('p');
    this.emptyEl.className = 'pmd-nav-empty';
    this.emptyEl.textContent = 'No headings.';
    this.root.appendChild(this.emptyEl);

    this.installResizeHandle();

    // Re-render only when a setting the outline depends on changes —
    // the cite preview (`showCitePreview`) or the numbering display.
    // An unconditional re-render would rebuild the whole outline (one
    // DOM node per heading — O(doc)) on every unrelated settings
    // toggle. `navMaxLevel` is deliberately NOT in this list: it is
    // the default depth for NEW documents; level changes on the open
    // doc go through `setMaxLevel` (transient, per-panel).
    let lastShowCitePreview = settings.get('showCitePreview');
    // Card numbering bakes into the rows, so any display-affecting
    // numbering setting re-renders too — same signature the editor's
    // NUMBERING_REFRESH subscribers diff.
    let lastNumberingSig = numberingDisplaySig();
    this.unsubscribeSettings = settings.subscribe((s) => {
      // `navWidth` deliberately NOT applied here — per-window (see the
      // module-init comment above applyNavWidthCss).
      const numberingSig = numberingDisplaySig();
      if (
        this.currentDoc &&
        (s.showCitePreview !== lastShowCitePreview || numberingSig !== lastNumberingSig)
      ) {
        lastShowCitePreview = s.showCitePreview;
        lastNumberingSig = numberingSig;
        this.render(this.currentDoc);
      }
    });

    parent.appendChild(this.root);
  }

  /**
   * Per-section resize handle; hidden in multi-doc mode (the rail
   * carries its own). See {@link installNavResizeHandle}.
   */
  private installResizeHandle(): void {
    installNavResizeHandle(this.root);
  }

  attach(view: EditorView): void {
    this.view = view;
    this.currentDoc = view.state.doc;
    // A new doc opens at the user's configured DEFAULT depth — level
    // clicks on the previous doc were a transient, per-doc view choice.
    this.localMaxLevel = settings.get('navMaxLevel');
    this.updateLevelButtonsActive();
    // On every attach (fresh mount or new doc loaded), establish the
    // initial collapse state from maxLevel. This guarantees the default
    // view is the one promised by maxLevel — heading IDs are doc-specific
    // so any persisted collapsed state from another doc wouldn't apply
    // anyway.
    this.applyMaxLevelToCollapseState();
    this.render(this.currentDoc);

    // Register as a drop-target surface and subscribe to drag events
    // so we render indicators regardless of which surface initiated
    // the drag (nav-pane drag → both surfaces show indicators;
    // editor pickup-mode drag → both surfaces show indicators too).
    if (this.unregisterSurface) this.unregisterSurface();
    if (this.unsubscribeDrag) this.unsubscribeDrag();
    if (this.readOnly) return;
    this.unregisterSurface = dragController.registerSurface(this.dragSurfaceImpl);
    this.unsubscribeDrag = dragController.subscribe((event) => {
      if (event === 'begin') {
        const session = dragController.getSession();
        if (session) this.renderDropIndicators(session.items[0]!.level);
      } else if (event === 'end') {
        this.removeDropIndicators();
      } else if (event === 'move') {

        // Run auto-expand / auto-restore on every controller move
        // event, so editor-sourced drags get the same
        // hover-driven nav-pane behavior as nav-sourced drags. The
        // nav-source path also triggers this (its setPointer fires
        // 'move'), but the duplicate work is idempotent.
        if (!dragController.isActive()) return;
        const { x, y } = dragController.getPointer();
        const hovered = this.entryUnderPointer(x, y);
        this.maybeAutoExpand(hovered);
        this.maybeRestoreAutoExpanded(hovered);
        // Keep the pickup pill's copy badge in sync with the
        // controller's copy-mode flag. The flag is updated by drag-
        // source pointer/key handlers; this is how the badge picks up
        // a key-only toggle (Ctrl held without pointer movement).
        this.syncPickupPillCopyBadge();
      }
    });
  }

  /**
   * Tear down subscriptions, timers, and doc/view references. Multi-pane
   * closes panes routinely (tournament sessions open and close many
   * files); without this, the settings/drag closures kept every closed
   * pane's panel — and the full doc snapshot in `currentDoc` — alive
   * for the whole session, each leaked panel still doing O(headings)
   * work on every drag event.
   */
  destroy(): void {
    this.destroyed = true;
    this.cancelLongPress();
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
    this.unsubscribeDrag?.();
    this.unsubscribeDrag = null;
    this.unregisterSurface?.();
    this.unregisterSurface = null;
    // Closed mid-drag: the document-level drag listeners are otherwise
    // only removed when the drag ends.
    if (this.dragHandlersAttached) {
      document.removeEventListener('pointermove', this.boundOnDragMove);
      document.removeEventListener('pointerup', this.boundOnDragUp);
      document.removeEventListener('keydown', this.boundOnDragKey);
      document.removeEventListener('keyup', this.boundOnDragKeyUp);
      this.dragHandlersAttached = false;
    }
    this.cancelAutoExpand();
    this.cancelAllPendingRestore();
    this.liEntries.clear();
    this.currentDoc = null;
    this.view = null;
    this.root.remove();
  }

  /** Cached scroll-gate element — used by hit-test to verify the
   *  cursor is in THIS nav's section, not just somewhere in the
   *  nav-rail column. See the comment in `hitTestDropIndicators`. */
  private navScrollGateEl: HTMLElement | null = null;

  /** Walk up from `this.root` to find the nearest scrolling ancestor
   *  (the multi-doc `.pmd-multi-nav-body`) or fall back to the panel
   *  itself (single-doc, where the panel is position:fixed and its
   *  own rect already gates correctly). Cached per instance. */
  private findNavScrollGate(): HTMLElement {
    // Cache validity needs `contains(this.root)`, not just
    // `isConnected`: the multi-pane shell RE-PARENTS nav sections
    // between containers when panes are rearranged, so a cached gate
    // can remain in the DOM — as some other slot's scroller — while
    // no longer being this panel's ancestor. Hit-testing drags
    // against that stale rect rejected every pointer position, so
    // drops offered no slot anywhere in the affected doc until it
    // was closed and reopened (field report 2026-07-17, three-pane).
    if (
      this.navScrollGateEl &&
      this.navScrollGateEl.isConnected &&
      this.navScrollGateEl.contains(this.root)
    ) {
      return this.navScrollGateEl;
    }
    let cur: HTMLElement | null = this.root;
    while (cur && cur !== document.body) {
      const overflow = getComputedStyle(cur).overflowY;
      if (overflow === 'auto' || overflow === 'scroll') {
        this.navScrollGateEl = cur;
        return cur;
      }
      cur = cur.parentElement;
    }
    this.navScrollGateEl = this.root;
    return this.root;
  }

  private dragSurfaceImpl: DragSurface = {
    hitTest: (clientX, clientY) => this.hitTestDropIndicators(clientX, clientY),
    highlight: (el) => this.highlightDropIndicator(el),
  };

  private hitTestDropIndicators(
    clientX: number,
    clientY: number,
  ): { el: HTMLElement; insertPos: number; dy: number; view?: EditorView } | null {
    const session = dragController.getSession();
    if (!session) return null;
    const myView = this.view ?? undefined;

    // Hit-test gate: in single-doc the panel is position:fixed, so
    // its own bounding rect spans the whole nav column and a
    // horizontal-only check is enough. In multi-doc each section
    // has its own panel and the panel's rect can extend past its
    // section (content overflow inside the scrolling section body)
    // — so a cursor in section 2 would still pass the horizontal
    // check on section 1's hit-test and "drop through" to whichever
    // indicator in section 1 happened to share a viewport-y with
    // the cursor. Gate against the nearest scrolling ancestor's
    // rect, which clips correctly to each section's visible area in
    // multi-doc while degenerating to the panel itself in single-doc.
    const gateRect = this.findNavScrollGate().getBoundingClientRect();
    if (clientX < gateRect.left - 8 || clientX > gateRect.right + 8) return null;
    if (clientY < gateRect.top || clientY > gateRect.bottom) return null;

    type Cand = { el: HTMLElement; insertPos: number; centerY: number; dy: number };
    const valid: Cand[] = [];
    // For same-view drops, skip indicators that fall inside the
    // dragged source range (would be a no-op). For cross-view drops
    // every indicator is a valid landing point — the source ranges
    // refer to a different doc.
    const sameDoc = session.view === this.view;
    for (const indicator of this.dropIndicators) {
      const insertPos = parseInt(indicator.dataset['insertPos'] ?? '-1', 10);
      if (sameDoc) {
        const onSelf = session.items.some(
          (it) => insertPos > it.from && insertPos < it.to,
        );
        if (onSelf) continue;
      }
      const rect = indicator.getBoundingClientRect();
      const centerY = (rect.top + rect.bottom) / 2;
      valid.push({ el: indicator, insertPos, centerY, dy: Math.abs(clientY - centerY) });
    }
    if (valid.length === 0) return null;

    // Preferred: closest indicator within a 24px band.
    let best: Cand | null = null;
    for (const v of valid) {
      if (v.dy > 24) continue;
      if (!best || v.dy < best.dy) best = v;
    }
    if (best) return { el: best.el, insertPos: best.insertPos, dy: best.dy, view: myView };

    // Fall-through: pointer is above the topmost or below the
    // bottommost indicator. Snap to that extreme so dragging into
    // the empty space at the top or bottom of the panel still lands
    // a target.
    let topMost = valid[0]!;
    let bottomMost = valid[0]!;
    for (const v of valid) {
      if (v.centerY < topMost.centerY) topMost = v;
      if (v.centerY > bottomMost.centerY) bottomMost = v;
    }
    if (clientY > bottomMost.centerY) {
      return { el: bottomMost.el, insertPos: bottomMost.insertPos, dy: bottomMost.dy, view: myView };
    }
    if (clientY < topMost.centerY) {
      return { el: topMost.el, insertPos: topMost.insertPos, dy: topMost.dy, view: myView };
    }
    return null;
  }

  private highlightDropIndicator(el: HTMLElement | null): void {
    for (const indicator of this.dropIndicators) {
      indicator.classList.toggle(
        'pmd-nav-drop-indicator-active',
        indicator === el,
      );
    }
  }

  /** Re-render given a new doc. Doc-change callers debounce (~200ms);
   *  `remapPositions` keeps cached positions current in between. */
  update(doc: PMNode): void {
    if (this.destroyed) return; // a late debounced call must not re-pin the doc
    this.currentDoc = doc;
    this.render(doc);
  }

  /** Map the cached heading positions forward through a doc change so they stay
   *  current between the debounced `update()` rebuilds. Without this, the
   *  cached positions are pre-edit while the caret is post-edit, so
   *  `setCaretHeading` briefly highlights the next heading while you type just
   *  above it (and nav click-to-jump targets a stale spot). Cheap:
   *  O(visible headings), called once per doc-changing transaction. */
  remapPositions(mapping: Mappable): void {
    for (const [li, entry] of this.liEntries) {
      const mapped = mapping.map(entry.pos);
      if (mapped === entry.pos) continue;
      entry.pos = mapped;
      li.dataset['pos'] = String(mapped);
    }
  }

  /** Sync the collapsed set to a maxLevel: every parent at level ≥ N
   *  is collapsed, every shallower parent is expanded.
   *
   *  When called with no argument, uses the current setting. When called
   *  with an explicit level, uses that — needed by `setMaxLevel`, which
   *  must update collapsed state for the new level *before* the settings
   *  store change fires the render-on-subscribe.
   */
  private applyMaxLevelToCollapseState(level?: number): void {
    if (!this.currentDoc) return;
    const maxLevel = level ?? this.maxLevel;
    const entries = collectHeadings(this.currentDoc);
    this.collapsed = new Set();
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (entry.id == null) continue;
      const next = entries[i + 1];
      const hasChildren = next != null && next.level > entry.level;
      if (!hasChildren) continue;
      if (entry.level >= maxLevel) {
        this.collapsed.add(entry.id);
      }
    }
  }

  /** Scroll the outline back to the top. Called by the editor on
   *  doc load so a freshly-opened doc doesn't inherit the previous
   *  doc's nav-pane scroll offset. */
  scrollToTop(): void {
    this.listEl.scrollTop = 0;
  }

  /** "Send to…" (mobile Move mode): while on, a tap on any row calls
   *  `cb` with that entry instead of navigating; drags don't arm.
   *  The caller owns exiting the mode (including on cancel). */
  enterDestinationMode(cb: (entry: HeadingEntry, anchor: DOMRect | null) => void): void {
    this.destinationCb = cb;
    this.root.classList.add('pmd-nav-destination');
  }

  exitDestinationMode(): void {
    this.destinationCb = null;
    this.root.classList.remove('pmd-nav-destination');
  }

  /** Receive the current find-bar hit positions. The nav panel
   *  marks each heading whose subtree contains at least one hit
   *  with a "has-hit" indicator — the deepest currently-rendered
   *  ancestor wins (a hit under a collapsed Pocket lights up the
   *  Pocket; expanding the Pocket lets a deeper Hat take over).
   *  Pass `null` or an empty array to clear all decorations. */
  setFindHitPositions(positions: number[] | null): void {
    this.findHitPositions = positions ? positions.slice() : [];
    if (this.currentDoc) this.render(this.currentDoc);
  }

  /**
   * Apply the current `maxLevel` collapse rule to headings whose IDs
   * weren't present at the last render. Used by the multi-pane shell
   * after a cross-view drop: dropped content gets fresh heading IDs
   * via `rewriteHeadingIds`, so the diff identifies exactly the new
   * entries. Existing user-expanded parents are preserved.
   *
   * Also triggers a synchronous re-render and updates the latest doc
   * snapshot — call after the transaction has applied but BEFORE any
   * other render of the post-drop doc: every render refreshes
   * `lastSeenIds`, so an intervening render (a flushed debounce, a
   * settings repaint) makes the new headings look already-seen and
   * this becomes a silent no-op.
   */
  applyMaxLevelToNewHeadings(): void {
    const view = this.view;
    if (!view) return;
    const doc = view.state.doc;
    this.currentDoc = doc;
    const maxLevel = this.maxLevel;
    const entries = collectHeadings(doc);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (entry.id == null) continue;
      if (this.lastSeenIds.has(entry.id)) continue; // not new
      const next = entries[i + 1];
      const hasChildren = next != null && next.level > entry.level;
      if (!hasChildren) continue;
      if (entry.level >= maxLevel) {
        this.collapsed.add(entry.id);
      }
    }
    this.render(doc);
  }

  /** Positions (in `doc`) of the live zones the divergence plugin has flagged.
   *  The plugin keys divergence by zone IDENTITY, so we walk the doc's zones and
   *  map any whose identity is in the diverged set to their current position. */
  private divergedZonePositions(doc: PMNode): ReadonlySet<number> {
    const diverged = this.view
      ? transclusionDivergenceKey.getState(this.view.state)?.diverged
      : undefined;
    if (!diverged || diverged.size === 0) return EMPTY_POSITIONS;
    const out = new Set<number>();
    doc.descendants((node, pos) => {
      if (!isTransclusionNode(node)) return true;
      if (diverged.has(zoneIdentity(node))) out.add(pos);
      return false; // zones never nest
    });
    return out;
  }

  private render(doc: PMNode): void {
    const entries = collectOutlineWithWindows(doc);

    // Refresh the `lastSeenIds` set so `applyMaxLevelToNewHeadings`
    // (called by the multi-pane shell after cross-view drops) can
    // diff future renders against it.
    const seen = new Set<string>();
    for (const entry of entries) {
      if (entry.id != null) seen.add(entry.id);
    }
    this.lastSeenIds = seen;

    // Find-hit nav decoration: for each pending hit position, work
    // out which RENDERED heading entry will be its deepest visible
    // ancestor (entries hidden under a collapsed parent don't
    // count, but the collapsed parent itself does). Stored by
    // entry index so the rendering loop below can light up the
    // right `<li>` cheaply.
    const hitEntryIndices = this.computeFindHitAncestorEntries(entries);

    // Positions of live zones whose source has diverged (the divergence plugin's
    // set, mapped from zone identity to position in THIS doc) — so the run's
    // first nav row can carry a "source updated" dot, mirroring the editor badge.
    const divergedZones = this.divergedZonePositions(doc);

    // Card numbers, mirroring the editor's numbering pass: wrapping
    // card/analytic_unit position → computed label, gated on the same
    // display toggle. O(top-level children) — cheap next to the DOM
    // rebuild below.
    const numberLabels = settings.get('showCardNumbering') ? computeNumbering(doc).cards : null;

    // Clear and re-build. For doc sizes we care about (max ~600 headings
    // in the example corpus) this is fine; if profiling shows it's hot,
    // diff against the previous render.
    this.listEl.innerHTML = '';
    this.liEntries.clear();
    this.collapsibleIds.clear();

    if (entries.length === 0) {
      this.listEl.style.display = 'none';
      this.emptyEl.style.display = '';
      return;
    }

    this.emptyEl.style.display = 'none';
    this.listEl.style.display = '';

    // Skip-tracking: when we encounter a collapsed heading, we hide
    // every following entry whose level is deeper than it, until we
    // hit one at the same or shallower level.
    let skipBelowLevel: number | null = null;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;

      if (skipBelowLevel != null) {
        if (entry.level > skipBelowLevel) continue;
        skipBelowLevel = null;
      }

      const next = entries[i + 1];
      // Windowed (projected) rows are read-only leaves — never collapsible.
      const hasChildren = !entry.windowed && next != null && next.level > entry.level;
      const collapsed = entry.id != null && this.collapsed.has(entry.id);
      if (hasChildren && entry.id != null) this.collapsibleIds.add(entry.id);

      const li = document.createElement('li');
      li.className = `pmd-nav-item pmd-nav-level-${entry.level} pmd-nav-type-${entry.type}`;
      if (entry.windowed) li.classList.add('pmd-nav-item-window');
      if (entry.id) li.dataset['id'] = entry.id;
      li.dataset['pos'] = String(entry.pos);
      if (
        (entry.id != null && this.selectedIds.has(entry.id)) ||
        (entry.windowed && entry.pos === this.selectedWindowPos)
      ) {
        li.classList.add('pmd-nav-item-selected');
      }
      if (hitEntryIndices.has(i)) {
        li.classList.add('pmd-nav-item-find-hit');
      }
      // Transcluded run: a faint green rail marks headings that live inside a
      // live zone, mirroring the editor's zone rail. `next` is entries[i+1].
      if (entry.zonePos != null) {
        li.classList.add('pmd-nav-item-zone');
        const prev = entries[i - 1];
        const isZoneStart = !prev || prev.zonePos !== entry.zonePos;
        const isZoneEnd = !next || next.zonePos !== entry.zonePos;
        if (isZoneStart) li.classList.add('pmd-nav-item-zone-start');
        if (isZoneEnd) li.classList.add('pmd-nav-item-zone-end');
        // Diverged run: a second "source updated" rail (configurable muted red)
        // that runs flush to the RIGHT of the green transclusion rail, spanning
        // the whole zone like it — echoing the editor's glyph badge.
        if (divergedZones.has(entry.zonePos)) {
          li.classList.add('pmd-nav-item-diverged');
          if (isZoneStart) li.classList.add('pmd-nav-item-diverged-start');
          if (isZoneEnd) li.classList.add('pmd-nav-item-diverged-end');
          const rail = document.createElement('span');
          rail.className = 'pmd-nav-diverged-rail';
          li.appendChild(rail);
        }
      }

      const chevron = document.createElement('span');
      chevron.className = 'pmd-nav-chevron';
      if (hasChildren) {
        setIcon(chevron, collapsed ? 'chevron-right' : 'chevron-down');
        chevron.classList.add('pmd-nav-chevron-active');
        chevron.addEventListener('click', (e) => {
          e.stopPropagation();
          this.toggleCollapsed(entry);
        });
      } else {
        // Leaf — keep a placeholder for indent alignment.
        chevron.classList.add('pmd-nav-chevron-leaf');
      }
      li.appendChild(chevron);

      // Card number glyph — the editor's computed label for this row's
      // wrapping card/analytic_unit. Only the wrapper's FIRST heading
      // row carries it (parentOffset 0), matching the editor, which
      // decorates the tag line — an in-card analytic under a numbered
      // tag stays bare. Windowed (live-view projection) rows carry the
      // mirrored card's REAL position precomputed at projection time —
      // computeNumbering keys a live view's cards by those positions
      // (host-contextual, the same numbers the editor renders in the
      // window), so projected rows number like everything else.
      if (numberLabels && (entry.type === 'tag' || entry.type === 'analytic')) {
        let cardPos: number | null = null;
        if (entry.windowed) {
          cardPos = entry.windowCardPos ?? null;
        } else {
          const $pos = doc.resolve(entry.pos);
          if ($pos.parentOffset === 0) cardPos = $pos.before();
        }
        const numLabel = cardPos != null ? numberLabels.get(cardPos) : undefined;
        if (numLabel) {
          const glyph = createNumberGlyph(numLabel);
          glyph.classList.add('pmd-nav-card-number');
          li.appendChild(glyph);
        }
      }

      const label = document.createElement('span');
      label.className = 'pmd-nav-label';
      // Whitespace-only headings must render exactly like empty ones: a
      // space-filled text node defeats the `:empty::before` NBSP rule
      // that holds an empty row at full height, yet still collapses to
      // zero width — yielding a squashed row. Normalize to truly empty
      // so the CSS fallback applies.
      label.textContent = entry.text.trim() === '' ? '' : entry.text;
      li.appendChild(label);

      if (entry.cite && settings.get('showCitePreview')) {
        const citePreview = document.createElement('span');
        citePreview.className = 'pmd-nav-cite-preview';
        citePreview.textContent = entry.cite;
        citePreview.title = entry.cite;
        li.appendChild(citePreview);
      }

      if (entry.windowed) {
        // Read-only projected row: a plain click scrolls to the window; a
        // pickup-drag moves the WHOLE live view (the `self_ref`). Routed through
        // the same pointer handler as headings so it reuses the drag machinery —
        // it just has no id-selection or context menu (nothing real to act on).
        li.addEventListener('pointerdown', (e) => this.onLiPointerDown(e, entry, li));
      } else {
        // Pointer-based handler: distinguishes click (jump-to) from drag
        // (move heading), and detects double-clicks (collapse toggle) in
        // `onDragUp` rather than via the native `dblclick`, which a plain
        // click's nav re-render would invalidate.
        li.addEventListener('pointerdown', (e) => this.onLiPointerDown(e, entry, li));
        li.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          // On mobile the browser synthesizes contextmenu from the same
          // long-press that arms row pickup — suppress the menu there.
          if (isMobileShellActive()) return;
          this.openContextMenu(e.clientX, e.clientY, entry);
        });
      }

      this.liEntries.set(li, entry);
      this.listEl.appendChild(li);

      if (hasChildren && collapsed) {
        skipBelowLevel = entry.level;
      }
    }
  }

  /** Run the same skip/stack logic the render loop uses, but
   *  return the set of entry indices that should be marked as
   *  "contains a find hit somewhere in its rendered subtree".
   *
   *  For each hit position, the matching entry is the deepest
   *  one currently on the render stack at the time the iteration
   *  reaches the hit's position — i.e., the deepest visible
   *  ancestor. Entries under a collapsed parent never enter the
   *  stack so a hit inside them surfaces on the collapsed parent
   *  instead. */
  private computeFindHitAncestorEntries(
    entries: HeadingEntry[],
  ): Set<number> {
    const hits = this.findHitPositions;
    const out = new Set<number>();
    if (hits.length === 0 || entries.length === 0) return out;
    const sortedHits = hits.slice().sort((a, b) => a - b);

    // Render stack of CURRENTLY-VISIBLE entries (indices into
    // `entries`), maintaining strictly-increasing levels — same
    // shape as the render loop's view of "what ancestors are
    // currently shown above each line".
    const stack: number[] = [];
    let skipBelowLevel: number | null = null;
    let hitIdx = 0;

    const consumePendingHitsUpTo = (posExclusive: number): void => {
      while (hitIdx < sortedHits.length && sortedHits[hitIdx]! < posExclusive) {
        if (stack.length > 0) out.add(stack[stack.length - 1]!);
        hitIdx++;
      }
    };

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      // Any hits with position < this entry's position belong to
      // whichever entry is currently on top of the stack.
      consumePendingHitsUpTo(entry.pos);
      if (skipBelowLevel !== null) {
        if (entry.level > skipBelowLevel) continue;
        skipBelowLevel = null;
      }
      // Pop entries from the stack whose level is at-or-deeper
      // than this entry's level (this entry will replace them at
      // its slot in the outline).
      while (
        stack.length > 0 &&
        entries[stack[stack.length - 1]!]!.level >= entry.level
      ) {
        stack.pop();
      }
      stack.push(i);
      // If this entry is collapsed AND has children, hide every
      // deeper entry until a sibling-or-shallower one shows up.
      const next = entries[i + 1];
      const hasChildren = next != null && next.level > entry.level;
      const collapsed = entry.id != null && this.collapsed.has(entry.id);
      if (hasChildren && collapsed) {
        skipBelowLevel = entry.level;
      }
    }
    // Hits past the last heading attribute to the deepest stack
    // entry still in scope.
    consumePendingHitsUpTo(Infinity);

    return out;
  }

  private toggleCollapsed(entry: HeadingEntry): void {
    if (entry.id == null) return;
    if (this.collapsed.has(entry.id)) {
      this.collapsed.delete(entry.id);
    } else {
      this.collapsed.add(entry.id);
    }
    if (this.currentDoc) this.render(this.currentDoc);
  }

  // ---------------------------------------------- Drag-and-drop ----

  private onLiPointerDown(
    e: PointerEvent,
    entry: HeadingEntry,
    li: HTMLLIElement,
  ): void {
    if (e.button !== 0) return; // primary button only
    // Ignore clicks that originated on the chevron — it has its own
    // handler and shouldn't initiate a drag.
    const target = e.target as HTMLElement;
    if (target.closest('.pmd-nav-chevron')) return;

    // Window (read-only projected) row: no id-selection. A plain release jumps to
    // the window (onDragUp's click path handles id:null); a drag moves the whole
    // live view (startDrag). Inert as a "send to…" destination.
    if (entry.windowed) {
      if (this.destinationCb) return;
      this.pointerDownModifier = 'none';
      this.deferredClickFinalize = null;
      this.dragStartX = e.clientX;
      this.dragStartY = e.clientY;
      this.dragStartLi = li;
      this.dragStartEntry = entry;
      this.attachDragHandlers();
      return;
    }

    // Capture modifier state so pointerup-without-drag knows whether
    // it's a plain click (jumpTo) or a Ctrl/Shift click (selection-only).
    this.pointerDownModifier = e.shiftKey
      ? 'shift'
      : e.metaKey || e.ctrlKey
        ? 'meta'
        : 'none';

    // Apply the selection update for Shift/Ctrl right away.
    // Plain clicks defer the "replace selection with this entry" if
    // the entry is part of a multi-selection — drag should use the
    // existing multi, but a plain click without drag should single-
    // select.
    this.deferredClickFinalize = null;
    if (this.pointerDownModifier === 'shift') {
      this.handleShiftClick(entry);
    } else if (this.pointerDownModifier === 'meta') {
      this.handleCtrlClick(entry);
    } else {
      // plain
      if (
        entry.id != null &&
        this.selectedIds.has(entry.id) &&
        this.selectedIds.size > 1
      ) {
        this.deferredClickFinalize = entry;
      } else {
        this.selectSingle(entry);
      }
    }

    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;
    this.dragStartLi = li;
    this.dragStartEntry = entry;

    // Mobile: arm the drag by long-press, never by movement (movement
    // is a scroll). Destination mode is tap-only — no pickup at all —
    // and read mode disables mobile pickup entirely.
    if (
      isMobileShellActive() &&
      !this.readOnly &&
      !this.destinationCb &&
      !settings.get('readMode') &&
      settings.get('dragInteractions')
    ) {
      this.cancelLongPress();
      this.longPressLi = li;
      this.longPressTimer = window.setTimeout(() => {
        this.longPressTimer = null;
        li.classList.add('pmd-nav-longpress-armed');
        if (typeof navigator.vibrate === 'function') navigator.vibrate(15);
        this.startDrag();
        document.addEventListener('touchmove', this.boundTouchBlocker, {
          passive: false,
        });
      }, NAV_LONG_PRESS_MS);
    }

    this.attachDragHandlers();
  }

  /** Attach the document-level gesture handlers (idempotent). Used by
   *  both row pointerdowns (click / drag / long-press) and list-level
   *  pointerdowns (mobile pan). Detached in `cleanupDrag`. */
  private attachDragHandlers(): void {
    if (this.dragHandlersAttached) return;
    document.addEventListener('pointermove', this.boundOnDragMove);
    document.addEventListener('pointerup', this.boundOnDragUp);
    document.addEventListener('keydown', this.boundOnDragKey);
    // keyup so the copy-modifier indicator clears the moment the
    // user releases Ctrl/Option mid-drag without moving the pointer.
    document.addEventListener('keyup', this.boundOnDragKeyUp);
    this.dragHandlersAttached = true;
  }

  private cancelLongPress(): void {
    if (this.longPressTimer !== null) {
      window.clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
    this.longPressLi?.classList.remove('pmd-nav-longpress-armed');
    this.longPressLi = null;
    document.removeEventListener('touchmove', this.boundTouchBlocker);
  }

  // ---- Selection helpers ----

  private selectSingle(entry: HeadingEntry): void {
    if (entry.id == null) {
      this.clearSelection();
      return;
    }
    const wasSize = this.selectedIds.size;
    const onlyMember = wasSize === 1 && this.selectedIds.has(entry.id);
    this.selectedIds = new Set([entry.id]);
    this.selectionAnchorId = entry.id;
    this.selectionLevel = entry.level;
    if (!onlyMember) this.applySelectionClasses();
  }

  private clearSelection(): void {
    if (
      this.selectedIds.size === 0 &&
      this.selectionAnchorId === null &&
      this.selectedWindowPos === null
    ) {
      return;
    }
    this.selectedIds.clear();
    this.selectionAnchorId = null;
    this.selectionLevel = null;
    this.selectedWindowPos = null;
    this.applySelectionClasses();
  }

  /**
   * Caret-tracking entry point. Called from the editor's
   * `dispatchTransaction` whenever the caret position changes. Finds
   * the heading whose section contains `pos` (= largest
   * `entry.pos <= pos`) and updates the nav-pane highlight to point
   * at it. No-op if the resulting selection would match the current
   * one. Always sets a single selection — explicit multi-select via
   * Ctrl/Shift-click is intentionally collapsed on the next caret
   * movement, matching user intuition that the nav-pane reflects
   * "where the cursor is."
   *
   * Iterates `liEntries` (the currently-rendered nav items) rather
   * than walking the doc — cheap (O(N_visible_headings), typically a
   * few hundred at most) and uses the positions that are already
   * cached alongside the DOM. Positions can drift slightly between
   * doc edits and the next debounced `update()` (~200ms); the
   * highlight may briefly point at a stale neighbor in that window,
   * which is acceptable for a visual indicator.
   *
   * Auto-scrolling the pane to bring the highlight into view is opt-in
   * (`navFollowCursor`, default off) — unconditional scrolling would
   * dominate scroll behavior for users who scroll the editor freely,
   * which is why this stayed highlight-only until asked for. The
   * following mode only moves the pane when the highlight actually
   * CHANGES rows and the new row is off-screen; see
   * `scrollCaretRowIntoView`.
   *
   * `opts.preserveMultiSelect`: set by the POSITIONAL RESYNC callers
   * (post-rebuild / divergence refresh), where the caret didn't move —
   * the doc changed under it. An explicit Shift/Ctrl-click multi-select
   * survives those as long as the caret's heading is still one of its
   * members: the numbering toggles edit the very cards the group
   * covers, and users run them repeatedly on one selection. Real caret
   * movement (the gated dispatchTransaction path) omits the flag and
   * collapses as documented above.
   */
  setCaretHeading(
    pos: number,
    selfRefPos: number | null = null,
    opts?: { preserveMultiSelect?: boolean },
  ): void {
    // A node-selected live view carries the caret onto ITS window row(s) rather
    // than the heading above it. The projected rows share the `self_ref`'s
    // position and have `id: null`, so track the window by position and light
    // those rows directly (the id-keyed selection can't reach them).
    if (selfRefPos !== null) {
      const changed = this.selectedWindowPos !== selfRefPos || this.selectedIds.size > 0;
      this.selectedIds.clear();
      this.selectionAnchorId = null;
      this.selectionLevel = null;
      this.selectedWindowPos = selfRefPos;
      if (changed) this.applySelectionClasses();
      return;
    }
    const hadWindow = this.selectedWindowPos !== null;
    this.selectedWindowPos = null;
    let best: HeadingEntry | null = null;
    for (const entry of this.liEntries.values()) {
      if (entry.id == null) continue;
      if (entry.pos > pos) continue;
      if (best === null || entry.pos > best.pos) best = entry;
    }
    if (best === null) {
      this.clearSelection();
      if (hadWindow) this.applySelectionClasses();
      return;
    }
    if (
      opts?.preserveMultiSelect === true &&
      this.selectedIds.size > 1 &&
      best.id != null &&
      this.selectedIds.has(best.id)
    ) {
      // Resync with the caret still inside the group — keep it.
      if (hadWindow) this.applySelectionClasses();
      return;
    }
    if (!hadWindow && this.selectedIds.size === 1 && this.selectedIds.has(best.id!)) return;
    this.selectSingle(best);
    // Reached only when the highlight moved to a DIFFERENT row (every
    // no-change path returned above), which is what keeps following from
    // fighting the user: typing inside one section can't scroll the pane.
    //
    // Positional resyncs are excluded. `preserveMultiSelect` marks exactly
    // those callers (see the opts docs above): the caret did NOT move, the
    // doc changed under it — a drag-reorder, a debounced rebuild, a level
    // change. Scrolling there would yank the pane for something the user
    // didn't do with the cursor, and the level-change caller wants the
    // 'top' anchoring instead, which it applies itself.
    if (opts?.preserveMultiSelect !== true && settings.get('navFollowCursor')) {
      this.scrollCaretRowIntoView('nearest');
    }
  }

  private handleShiftClick(entry: HeadingEntry): void {
    if (entry.id == null) return;
    if (!this.currentDoc) {
      this.selectSingle(entry);
      return;
    }
    if (!this.selectionAnchorId || this.selectionLevel == null) {
      this.selectSingle(entry);
      return;
    }
    const all = collectHeadings(this.currentDoc);
    const aIdx = all.findIndex((e) => e.id === this.selectionAnchorId);
    const bIdx = all.findIndex((e) => e.id === entry.id);
    if (aIdx < 0 || bIdx < 0) {
      this.selectSingle(entry);
      return;
    }
    const lo = Math.min(aIdx, bIdx);
    const hi = Math.max(aIdx, bIdx);
    const next = new Set<string>();
    // Filter the range to the anchor's outline level. Mixed-level
    // ranges quietly resolve to the level-consistent subset (e.g. a
    // shift-click range over a hat keeps just the cards on either
    // side, dropping the hat). Same level = OK regardless of type:
    // a tag and an analytic at level 4 group together.
    for (let i = lo; i <= hi; i++) {
      const e = all[i]!;
      if (e.id != null && e.level === this.selectionLevel) next.add(e.id);
    }
    this.selectedIds = next;
    // Anchor stays where it was so subsequent shift-clicks keep
    // ranging from the same starting point.
    this.applySelectionClasses();
  }

  private handleCtrlClick(entry: HeadingEntry): void {
    if (entry.id == null) return;
    // Empty selection or level mismatch → replace with just this entry.
    if (
      this.selectedIds.size === 0 ||
      (this.selectionLevel !== null && this.selectionLevel !== entry.level)
    ) {
      this.selectSingle(entry);
      return;
    }
    // Toggle entry in/out.
    if (this.selectedIds.has(entry.id)) {
      this.selectedIds.delete(entry.id);
      if (this.selectedIds.size === 0) {
        this.selectionAnchorId = null;
        this.selectionLevel = null;
      } else if (this.selectionAnchorId === entry.id) {
        // Anchor was the deselected entry; pick another to be the new
        // anchor (the next remaining one).
        this.selectionAnchorId = this.selectedIds.values().next().value ?? null;
      }
    } else {
      this.selectedIds.add(entry.id);
      this.selectionAnchorId = entry.id;
      this.selectionLevel = entry.level;
    }
    this.applySelectionClasses();
  }

  /** The numbering commands' nav-selection scope ("apply to these
   *  units as if selected"), from the current EXPLICIT multi-selection:
   *
   *   - level-4 rows (tags/analytics) → the wrapping card/
   *     analytic_unit positions (`kind: 'cards'`) — number/sub role
   *     toggles AND per-card restart flags;
   *   - level-3 rows (blocks) → the block node positions
   *     (`kind: 'blocks'`) — the restart/continue toggle, e.g. flipping
   *     every block separating a consecutively-numbered run to
   *     "continue" in one press;
   *   - anything else → null.
   *
   *  Null unless ≥2 rows are selected: a single selection is just the
   *  caret-tracking mirror (the highlight follows the editor caret),
   *  so the editor's own selection scope must win there. A moved caret
   *  collapses multi-selects (`setCaretHeading`), so a surviving
   *  multi-select is always a deliberate Shift/Ctrl-click.
   *
   *  Resolved against the live doc via `collectHeadings` (NOT the
   *  rendered rows — a shift-click range includes rows hidden under
   *  collapsed parents). Deduped: a card's tag and its in-card
   *  analytic both map to the same wrapper. */
  selectedNumberingScope(): { kind: 'blocks' | 'cards'; positions: number[] } | null {
    if (!this.view) return null;
    if (this.selectedIds.size < 2) return null;
    if (this.selectionLevel !== 3 && this.selectionLevel !== 4) return null;
    const doc = this.view.state.doc;
    const out = new Set<number>();
    if (this.selectionLevel === 3) {
      for (const e of collectHeadings(doc, { skipCite: true })) {
        if (e.id == null || !this.selectedIds.has(e.id)) continue;
        if (e.type !== 'block') continue;
        out.add(e.pos); // the block node itself carries numRestart
      }
      return out.size > 0 ? { kind: 'blocks', positions: [...out] } : null;
    }
    for (const e of collectHeadings(doc, { skipCite: true })) {
      if (e.id == null || !this.selectedIds.has(e.id)) continue;
      if (e.type !== 'tag' && e.type !== 'analytic') continue;
      const $pos = doc.resolve(e.pos);
      if ($pos.depth === 0) continue; // malformed — a bare heading has no wrapper
      out.add($pos.before());
    }
    return out.size > 0 ? { kind: 'cards', positions: [...out] } : null;
  }

  private applySelectionClasses(): void {
    for (const [li, entry] of this.liEntries) {
      // `=== true` (not just `entry.windowed`) so a non-windowed row yields
      // `false`, never `undefined` — `classList.toggle(cls, undefined)` FLIPS
      // rather than forcing off, which would spuriously light unrelated rows.
      const selected =
        (entry.id != null && this.selectedIds.has(entry.id)) ||
        (entry.windowed === true && entry.pos === this.selectedWindowPos);
      li.classList.toggle('pmd-nav-item-selected', selected);
    }
  }

  private onDragMove(e: PointerEvent): void {
    // Mobile pans engage from anywhere in the list — they have a
    // panPointer but no drag-start row.
    if (!this.dragStartEntry && !this.panPointer) return;

    if (!dragController.isActive()) {
      const dx = e.clientX - this.dragStartX;
      const dy = e.clientY - this.dragStartY;
      // Mobile: movement never arms a drag — it cancels the pending
      // long-press and becomes a manual list pan.
      if (isMobileShellActive()) {
        const pan = this.panPointer;
        if (!pan || e.pointerId !== pan.id) return;
        if (this.manualPan) {
          const panDy = e.clientY - this.manualPan.lastY;
          this.manualPan.lastY = e.clientY;
          this.listEl.scrollTop -= panDy;
          return;
        }
        const px = e.clientX - pan.startX;
        const py = e.clientY - pan.startY;
        if (px * px + py * py > 64) {
          this.cancelLongPress();
          this.manualPan = { lastY: e.clientY };
          // Keep the stream alive even if the starting row re-renders
          // out from under the gesture.
          try {
            this.listEl.setPointerCapture(e.pointerId);
          } catch {
            /* capture is best-effort */
          }
        }
        return;
      }
      // 5px threshold — below this, count as a click, not a drag.
      if (dx * dx + dy * dy < 25) return;
      // Drag-to-rearrange disabled (touch devices where a scrolling
      // finger reads as a drag): the movement stays inert; releasing
      // still counts as a click below the threshold path.
      if (this.readOnly || !settings.get('dragInteractions')) return;
      // Drag-reorder is allowed even in read mode: the drop is position-
      // validated and the resulting transaction is read-mode-permitted (see
      // READ_MODE_DRAG_META). A click below the threshold still just navigates.
      this.startDrag();
    }

    if (!dragController.isActive()) return;

    dragController.setPointer(e.clientX, e.clientY);
    dragController.setCopyMode(isCopyModifier(e));
    this.updatePickupPill(e.clientX, e.clientY);
    dragController.dispatchHit(e.clientX, e.clientY);

    const hovered = this.entryUnderPointer(e.clientX, e.clientY);
    this.maybeAutoExpand(hovered);
    this.maybeRestoreAutoExpanded(hovered);
  }

  private onDragUp(e: PointerEvent): void {
    let committed = false;
    if (dragController.isActive()) {
      // Read the modifier off the pointerup event so the user's final
      // intent at release time is what matters (Ctrl/Option held →
      // copy; otherwise → move).
      committed = dragController.commit({ copy: isCopyModifier(e) });
    } else if (this.dragStartEntry) {
      // No drag occurred. Finalize the click action:
      // - Plain click on a multi-selected entry (deferred): single-select
      //   it, then jump to it.
      // - Plain click otherwise: jump to the entry (selection already
      //   updated at pointerdown).
      // - Ctrl/Shift click: selection was already updated; don't navigate.
      if (this.manualPan) {
        // The gesture was a scroll, not a click — no navigation.
        this.manualPan = null;
      } else if (this.pointerDownModifier === 'none') {
        if (this.destinationCb) {
          // Destination mode: the tap picks a "Send to…" target
          // instead of navigating. The callback owns mode exit.
          this.destinationCb(
            this.dragStartEntry,
            this.dragStartLi?.getBoundingClientRect() ?? null,
          );
        } else {
          if (this.deferredClickFinalize) {
            this.selectSingle(this.deferredClickFinalize);
          }
          this.jumpTo(this.dragStartEntry);
          this.handlePlainClickDouble(this.dragStartEntry);
        }
      }
    }
    this.deferredClickFinalize = null;
    this.pointerDownModifier = 'none';
    this.manualPan = null;
    this.panPointer = null;
    this.cancelLongPress();
    this.cleanupDrag(committed);
  }

  /** Manual double-click → collapse toggle. Runs after the click's
   *  jump, so a double-click both navigates and toggles (matching the
   *  old native-`dblclick` behavior) — but reliable, because it keys on
   *  the entry id rather than the `<li>` node the jump's re-render
   *  replaces. The second click of a double resets `lastClickId` so a
   *  third click starts a fresh single (no triple-click chaining). */
  private handlePlainClickDouble(entry: HeadingEntry): void {
    if (entry.id == null) {
      this.lastClickId = null;
      return;
    }
    const now = Date.now();
    const isDouble =
      this.lastClickId === entry.id && now - this.lastClickTime < NAV_DOUBLE_CLICK_MS;
    if (isDouble) {
      this.lastClickId = null;
      if (this.collapsibleIds.has(entry.id)) this.toggleCollapsed(entry);
      return;
    }
    this.lastClickId = entry.id;
    this.lastClickTime = now;
  }

  private onDragKey(e: KeyboardEvent): void {
    if (e.key === 'Escape' && dragController.isActive()) {
      e.preventDefault();
      dragController.cancel();
      this.cleanupDrag(false);
      return;
    }
    // Any other key event (down or up) while dragging: refresh the
    // copy-mode flag so the pickup pill reflects whether Ctrl/Option
    // is currently held. KeyboardEvent's ctrlKey/altKey reflect the
    // post-event state, which is what we want for both directions.
    if (dragController.isActive()) {
      dragController.setCopyMode(isCopyModifier(e));
    }
  }

  private startDrag(): void {
    const startEntry = this.dragStartEntry;
    if (!startEntry || !this.view) return;

    // A window row drags the WHOLE live view (`self_ref`) as one doc-level unit
    // (like a live zone), never the projected content it shows.
    if (startEntry.windowed) {
      const node = this.view.state.doc.nodeAt(startEntry.pos);
      if (!node || !isSelfRef(node)) return;
      const item: DragItem = {
        from: startEntry.pos,
        to: startEntry.pos + node.nodeSize,
        id: null,
        type: 'self_ref',
        level: 0,
        label: String(node.attrs['source_label'] || startEntry.text || 'Live view').replace(
          /^↳\s*/,
          '',
        ),
      };
      this.createPickupPill([item]);
      dragController.begin({ view: this.view, items: [item] });
      // Grey every window row of this live view so the whole projection reads as
      // the drag source.
      for (const [li, entry] of this.liEntries) {
        if (entry.windowed && entry.pos === startEntry.pos) {
          li.classList.add('pmd-nav-item-dragging');
        }
      }
      return;
    }

    // Decide which entries to drag: the multi-selection (if the drag
    // origin is part of one) or just the start entry.
    let entriesToDrag: HeadingEntry[];
    if (
      startEntry.id != null &&
      this.selectedIds.has(startEntry.id) &&
      this.selectedIds.size > 1 &&
      this.currentDoc
    ) {
      // Multi-drag: walk all entries in document order and keep the
      // selected ones. This preserves their original relative order
      // in the source-items list.
      const all = collectHeadings(this.currentDoc);
      entriesToDrag = all.filter(
        (e) => e.id != null && this.selectedIds.has(e.id),
      );
    } else {
      entriesToDrag = [startEntry];
    }

    const items: DragItem[] = [];
    for (const e of entriesToDrag) {
      // Dragging a transcluded heading moves the WHOLE zone as one unit (with a
      // visual indicator); other nav ops act on the single heading.
      const range =
        (this.view && zoneRangeForEntry(this.view.state.doc, e)) || this.computeHeadingRange(e);
      if (!range) continue;
      items.push({
        from: range.from,
        to: range.to,
        id: e.id,
        type: e.type,
        level: e.level,
        label: e.text,
      });
    }
    if (items.length === 0) return;

    // Pickup pill is created BEFORE begin so the visual lands as soon
    // as the drag fires. Drop indicators on both surfaces are
    // rendered by their respective subscriptions reacting to the
    // controller's 'begin' event.
    this.createPickupPill(items);
    dragController.begin({ view: this.view, items });

    // Mark all dragged source <li>s. If the drag is a whole live zone, grey the
    // ENTIRE transcluded run (every entry with the zone's pos), not just the
    // grabbed heading — so it reads as a multi-select of all the zone's headings.
    const idsBeingDragged = new Set(
      items.map((it) => it.id).filter((id): id is string => id != null),
    );
    const doc = this.view.state.doc;
    const zoneItem = items.find((it) => isTransclusionNode(doc.nodeAt(it.from)));
    const draggedZonePos = zoneItem ? zoneItem.from : null;
    for (const [li, entry] of this.liEntries) {
      if (
        (entry.id != null && idsBeingDragged.has(entry.id)) ||
        (draggedZonePos != null && entry.zonePos === draggedZonePos)
      ) {
        li.classList.add('pmd-nav-item-dragging');
      }
    }
  }

  private cleanupDrag(committed: boolean): void {
    let needsRerender = false;

    // On cancel: restore any remaining auto-expanded entries (the
    // primary restore happens during drag-off in maybeRestoreAuto-
    // Expanded; this is a safety net plus the cancel-revert path).
    // On commit: leave them as-is. If an auto-expanded entry is still
    // in the set at commit time, the user dropped inside its subtree
    // and so they should stay expanded.
    if (!committed && this.autoExpanded.size > 0) {
      for (const id of this.autoExpanded) {
        this.collapsed.add(id);
      }
      needsRerender = true;
    }
    this.autoExpanded.clear();
    this.cancelAllPendingRestore();

    // Drop indicators are cleaned up by the surface subscriptions
    // reacting to the 'end' event; we just clean up our pickup pill.
    this.removePickupPill();
    // Clear dragging class from every <li> that had it (multi-drag
    // can mark several at once).
    this.listEl
      .querySelectorAll<HTMLElement>('.pmd-nav-item-dragging')
      .forEach((el) => {
        el.classList.remove('pmd-nav-item-dragging');
      });
    this.cancelAutoExpand();

    if (this.dragHandlersAttached) {
      document.removeEventListener('pointermove', this.boundOnDragMove);
      document.removeEventListener('pointerup', this.boundOnDragUp);
      document.removeEventListener('keydown', this.boundOnDragKey);
      document.removeEventListener('keyup', this.boundOnDragKeyUp);
      this.dragHandlersAttached = false;
    }
    this.dragStartLi = null;
    this.dragStartEntry = null;

    // After a successful drop the underlying doc has changed —
    // force-refresh now instead of waiting for the debounced heavy-
    // update tick (which would leave the nav out of sync for ~200ms).
    const newDoc = this.view ? this.view.state.doc : this.currentDoc;
    if (newDoc && newDoc !== this.currentDoc) {
      this.currentDoc = newDoc;
      needsRerender = true;
    }

    // Only re-render if something actually changed: a plain click (no
    // drag, no doc change) shouldn't tear down and rebuild the <li>s.
    // (Our double-click detection keys on entry id so it survives a
    // rebuild — but a needless rebuild on every click still flickers.)
    if (needsRerender && this.currentDoc) {
      this.render(this.currentDoc);
    }
  }

  private entryUnderPointer(x: number, y: number): HeadingEntry | null {
    const target = document.elementFromPoint(x, y);
    if (!target) return null;
    const li = (target as Element).closest?.('.pmd-nav-item') as HTMLLIElement | null;
    if (!li) return null;
    return this.liEntries.get(li) ?? null;
  }

  private renderDropIndicators(draggedLevel: number): void {
    this.removeDropIndicators();
    if (!this.view) return;
    const doc = this.view.state.doc;

    // An empty outline hides `listEl` in favor of the "No headings."
    // placeholder — which also hid the always-valid end-of-doc drop
    // slot appended below, so an empty pane's nav offered NO drop
    // targets at all (field bug 2026-07-27, three-pane: dragging onto
    // an empty doc's nav section showed only the placeholder). Surface
    // the (zero-height) list for the drag's duration so the end slot
    // has a real hit-test rect — the extreme-snap fall-through in
    // hitTestDropIndicators then makes the whole section droppable.
    // The placeholder stays visible alongside; removeDropIndicators
    // restores the empty state (a successful drop re-renders anyway).
    if (this.listEl.style.display === 'none') {
      this.listEl.style.display = '';
      this.listShownForDrag = true;
    }

    const items = Array.from(this.listEl.children).filter(
      (el): el is HTMLLIElement => el instanceof HTMLLIElement,
    );

    // Indicators are ZERO-HEIGHT anchors (see .pmd-nav-drop-indicator):
    // they take no layout space, so opening drop slots doesn't spread
    // the outline or shift the items below. (The previous design
    // inserted 4px spacers, which accumulated down a long outline and
    // visibly displaced everything near the bottom; the hovered slot's
    // bar now paints as an overlay on the boundary instead.)

    // Is the drag source a doc-level opaque unit — a whole live zone (linked
    // copy) OR a live view (`self_ref`)? Then it drops as a doc-level unit (not
    // level-scoped) at any doc boundary, and offers no targets inside any zone.
    // Must match the editor surface's test: a self_ref is picked up at level 0,
    // so omitting it here made `entry.level > 0` skip EVERY heading, leaving only
    // the end-of-doc slot as a drop target for a live view.
    // Checked across ALL items, not items[0]: a mixed multi-select (a promoted
    // whole zone + a plain heading) must scope its slots the same way
    // regardless of which item sits first in doc order.
    const session = dragController.getSession();
    const srcIsZone =
      !!session &&
      session.items.some((it) => {
        const n = session.view.state.doc.nodeAt(it.from);
        return !!n && (isTransclusionNode(n) || isSelfRef(n));
      });

    for (const li of items) {
      const entry = this.liEntries.get(li);
      if (!entry) continue;

      let insertPos: number | null;
      if (entry.zonePos != null) {
        // A live zone is opaque to drops: only the run's FIRST transcluded entry
        // yields a slot, remapped to BEFORE the zone (doc level) so a top-of-zone
        // drop lands outside it. Inner transcluded slots are dropped entirely — so
        // nothing lands between transcluded cards, and a zone can't nest.
        if (!li.classList.contains('pmd-nav-item-zone-start')) continue;
        insertPos = entry.zonePos;
      } else {
        // §14: slots exist between siblings of level <= dragged level. A whole-
        // zone drag isn't level-scoped, so it may drop at any doc-level boundary.
        // `headingInsertPos` computes just the (cheap) start position.
        if (!srcIsZone && entry.level > draggedLevel) continue;
        insertPos = headingInsertPos(doc, entry);
      }
      if (insertPos == null) continue;

      const indicator = document.createElement('div');
      indicator.className = 'pmd-nav-drop-indicator';
      indicator.dataset['insertPos'] = String(insertPos);
      this.listEl.insertBefore(indicator, li);
      this.dropIndicators.push(indicator);
    }

    // End-of-doc slot: always valid.
    const endIndicator = document.createElement('div');
    endIndicator.className = 'pmd-nav-drop-indicator';
    endIndicator.dataset['insertPos'] = String(doc.content.size);
    this.listEl.appendChild(endIndicator);
    this.dropIndicators.push(endIndicator);
  }

  private removeDropIndicators(): void {
    for (const el of this.dropIndicators) el.remove();
    this.dropIndicators = [];
    if (this.listShownForDrag) {
      this.listShownForDrag = false;
      // Still no headings (drag aborted or dropped elsewhere) → put
      // the empty state back. A drop INTO this doc re-renders with
      // headings, so the list stays visible via the normal path.
      if (!this.listEl.querySelector('li')) this.listEl.style.display = 'none';
    }
  }

  private maybeAutoExpand(hoveredEntry: HeadingEntry | null): void {
    const session = dragController.getSession();
    if (!session || session.items.length === 0) return;
    const draggedLevel = session.items[0]!.level;

    if (!hoveredEntry || !hoveredEntry.id) {
      this.cancelAutoExpand();
      return;
    }
    // Only auto-expand collapsed entries that are SHALLOWER than the
    // dragged level — the user is drilling into a parent to find a
    // drop target inside.
    if (hoveredEntry.level >= draggedLevel) {
      this.cancelAutoExpand();
      return;
    }
    if (!this.collapsed.has(hoveredEntry.id)) {
      this.cancelAutoExpand();
      return;
    }

    if (this.autoExpandTarget === hoveredEntry.id) return; // already pending

    this.cancelAutoExpand();
    this.autoExpandTarget = hoveredEntry.id;
    this.autoExpandTimer = setTimeout(() => {
      this.autoExpandTimer = null;
      if (this.autoExpandTarget !== hoveredEntry.id) return;
      if (!this.collapsed.has(hoveredEntry.id!)) return;
      this.collapsed.delete(hoveredEntry.id!);
      this.autoExpanded.add(hoveredEntry.id!);
      if (this.currentDoc) {
        this.render(this.currentDoc);
        this.renderDropIndicators(draggedLevel);
      }
    }, 400);
  }

  /**
   * Maintain per-id pending re-collapse timers for auto-expanded
   * entries the pointer has left. An entry is "left" when the
   * pointer's current entry is some other entry outside that entry's
   * outline subtree. While outside, a 400ms timer counts down; if the
   * pointer comes back into the subtree before the timer fires, the
   * timer is cancelled — no flicker for quick passes through
   * neighboring areas. If the pointer is over a non-entry slot (e.g.
   * a drop indicator) or off the nav entirely, neither schedule nor
   * cancel — leave the existing pending state alone.
   */
  private maybeRestoreAutoExpanded(currentEntry: HeadingEntry | null): void {
    if (this.autoExpanded.size === 0) return;
    if (!this.currentDoc) return;
    if (!currentEntry) return;

    const allEntries = collectHeadings(this.currentDoc);

    for (const expandedId of this.autoExpanded) {
      const expandedIdx = allEntries.findIndex((e) => e.id === expandedId);
      if (expandedIdx < 0) {
        // Entry no longer exists (doc edited under us). Restore now.
        this.cancelPendingRestore(expandedId);
        this.executeRestore(expandedId);
        continue;
      }
      const expandedEntry = allEntries[expandedIdx]!;
      let inside = currentEntry.id === expandedId;
      if (!inside) {
        for (let i = expandedIdx + 1; i < allEntries.length; i++) {
          const e = allEntries[i]!;
          if (e.level <= expandedEntry.level) break;
          if (e.id === currentEntry.id) {
            inside = true;
            break;
          }
        }
      }
      if (inside) {
        this.cancelPendingRestore(expandedId);
      } else {
        this.schedulePendingRestore(expandedId);
      }
    }
  }

  private schedulePendingRestore(id: string): void {
    if (this.pendingRestoreTimers.has(id)) return; // already pending
    const timer = setTimeout(() => {
      this.pendingRestoreTimers.delete(id);
      this.executeRestore(id);
    }, 400);
    this.pendingRestoreTimers.set(id, timer);
  }

  private cancelPendingRestore(id: string): void {
    const timer = this.pendingRestoreTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.pendingRestoreTimers.delete(id);
    }
  }

  private cancelAllPendingRestore(): void {
    for (const timer of this.pendingRestoreTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingRestoreTimers.clear();
  }

  /** Re-collapse a single auto-expanded entry. Safe to call when the
   *  entry isn't actually in autoExpanded anymore (no-op). */
  private executeRestore(id: string): void {
    if (!this.autoExpanded.has(id)) return;
    this.autoExpanded.delete(id);
    this.collapsed.add(id);
    if (this.currentDoc) {
      this.render(this.currentDoc);
      const session = dragController.getSession();
      if (session) this.renderDropIndicators(session.items[0]!.level);
    }
  }

  private cancelAutoExpand(): void {
    if (this.autoExpandTimer) {
      clearTimeout(this.autoExpandTimer);
      this.autoExpandTimer = null;
    }
    this.autoExpandTarget = null;
  }

  private createPickupPill(items: DragItem[]): void {
    this.removePickupPill();
    const pill = document.createElement('div');
    pill.className = 'pmd-nav-pickup-pill';
    // Wrap the text in an inner span so text-overflow / ellipsis can
    // clip JUST the text. The copy-mode `+` badge attaches to the
    // pill itself via `::after` and overflows past its bounds — if
    // the clip lived on the pill, the badge would get cropped too.
    const text = document.createElement('span');
    text.className = 'pmd-nav-pickup-pill-text';
    if (items.length === 1) {
      const label = items[0]!.label.trim() || `(empty ${items[0]!.type})`;
      text.textContent = label.length > 40 ? label.slice(0, 38) + '…' : label;
    } else {
      // Use a uniform-type label when all items share a type; fall
      // back to a generic count when types are mixed (e.g. a level-4
      // selection mixing tags and analytics).
      const allSameType = items.every((i) => i.type === items[0]!.type);
      if (allSameType) {
        const t = items[0]!.type;
        const typeLabel = TYPE_LABEL[t] ?? t;
        text.textContent = `${items.length} ${typeLabel}s`;
      } else {
        text.textContent = `${items.length} headings`;
      }
    }
    pill.appendChild(text);
    document.body.appendChild(pill);
    this.pickupPill = pill;
  }

  private updatePickupPill(x: number, y: number): void {
    if (!this.pickupPill) return;
    this.pickupPill.style.left = `${x + 12}px`;
    this.pickupPill.style.top = `${y + 12}px`;
    this.syncPickupPillCopyBadge();
  }

  private syncPickupPillCopyBadge(): void {
    if (!this.pickupPill) return;
    this.pickupPill.classList.toggle(
      'pmd-nav-pickup-pill-copy',
      dragController.isCopyMode(),
    );
  }

  private removePickupPill(): void {
    if (this.pickupPill) {
      this.pickupPill.remove();
      this.pickupPill = null;
    }
  }

  /**
   * Click handler for the level buttons. Behaves like Word's "Show
   * Heading N" — collapses every heading at level ≥ N (and expands
   * every heading at level < N). Acts as a bulk reset; the user can
   * still selectively expand/collapse individual entries via the
   * chevrons afterwards.
   */
  /** Level buttons: a TRANSIENT, per-panel view change — never written
   *  to settings. The "Default navigation depth" setting (General tab)
   *  governs what NEW documents open at; clicking the already-active
   *  level re-collapses any manual chevron expansions. */
  private setMaxLevel(level: number): void {
    if (level < 1 || level > 4) return;
    this.applyMaxLevelToCollapseState(level);
    this.localMaxLevel = level;
    this.updateLevelButtonsActive();
    if (this.currentDoc) this.render(this.currentDoc);
    // `render` rebuilt `liEntries`, so the caret highlight has to be
    // re-resolved against the rows that now exist — the same positional
    // resync the editor runs after its debounced `update()`. Without it
    // the highlight simply VANISHES whenever the new depth collapses the
    // caret's heading away: `selectedIds` still holds that heading's id,
    // but no rendered row carries it, so nothing lights up. (Pre-existing
    // on main, where it hid behind the scroll jumping to the top too.)
    // Positional resync, not a caret move → an explicit multi-select
    // survives, matching the other resync callers.
    this.resyncCaretHighlight();
    // Then keep the user's place: the rebuild dropped `scrollTop` to 0,
    // so the outline would otherwise snap to the top of the document.
    if (settings.get('navFollowCursor')) this.scrollCaretRowIntoView('top');
  }

  /** Re-resolve the caret highlight against the currently-rendered rows.
   *  Call after any `render()` that wasn't driven by a caret move. */
  private resyncCaretHighlight(): void {
    const view = this.view;
    if (!view) return;
    this.setCaretHeading(view.state.selection.from, selfRefSelectionPos(view.state), {
      preserveMultiSelect: true,
    });
  }

  /**
   * The rendered row carrying the caret highlight — what the outline
   * currently says "you are here" about. Null when nothing is
   * highlighted (empty outline, or a caret ahead of the first heading).
   *
   * Deliberately reads the DOM class rather than re-deriving the caret's
   * heading from the doc: `setCaretHeading` already owns that resolution
   * (largest rendered `entry.pos <= caret pos`, which lands on the
   * deepest rendered ancestor when the exact heading is collapsed away),
   * and scrolling to a row the highlight DISAGREES with would be worse
   * than not scrolling at all.
   */
  private caretRow(): HTMLLIElement | null {
    for (const li of this.liEntries.keys()) {
      if (li.classList.contains('pmd-nav-item-selected')) return li;
    }
    return null;
  }

  /**
   * Scroll the outline to the highlighted row, so the pane keeps up with
   * where the caret is in the document.
   *
   * Two modes, and the difference is the whole reason this doesn't
   * "dominate scroll behavior for users who scroll the editor freely"
   * (the concern `setCaretHeading` documents):
   *
   *   - `'nearest'` — the caret-following case. Does NOTHING when the row
   *     is already visible, so ordinary typing and cursor movement inside
   *     one section never move the pane, and a nav pane the user scrolled
   *     by hand is left alone until the caret actually leaves the visible
   *     span. Only an off-screen row scrolls, and only just far enough.
   *   - `'top'` — the level-change case, where `render()` has already
   *     destroyed the scroll offset. There is no position left to
   *     preserve, so the row is pinned to the top of the viewport and the
   *     section the user was reading heads the list.
   *
   * Scroll only: the editor selection, the nav selection, and the
   * collapsed set are all left exactly as they were.
   */
  private scrollCaretRowIntoView(mode: 'nearest' | 'top'): void {
    const target = this.caretRow();
    if (!target) return;
    const list = this.listEl;
    // WHICH element scrolls differs by layout: single-doc scrolls the
    // list itself, but three-pane scrolls the section BODY
    // (`.pmd-multi-nav-body`) so the panel header can stick to its top
    // — there the list is never its own scroller and writing its
    // `scrollTop` is a silent no-op (and its unclipped `clientHeight`
    // makes every row look "already visible"). Prefer the list when it
    // actually scrolls, else the enclosing body.
    const scroller =
      list.scrollHeight > list.clientHeight
        ? list
        : (list.closest<HTMLElement>('.pmd-multi-nav-body') ?? list);
    // `offsetTop` is measured from the nearest POSITIONED ancestor —
    // the fixed panel in single-doc, the `position: relative` section
    // in three-pane. Row and scroller share it either way, so the
    // difference is a scroller-content-relative coordinate.
    const top = target.offsetTop - scroller.offsetTop;
    // In three-pane the panel header is `position: sticky` INSIDE the
    // scroller and masks the top of its viewport: rows under it count
    // as hidden, and 'top' pins just below it. Single-doc's header
    // sits outside the list, so the allowance is zero there.
    const headerEl = this.root.querySelector<HTMLElement>(':scope > header');
    const headerH =
      scroller !== list && headerEl && scroller.contains(headerEl) ? headerEl.offsetHeight : 0;
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (mode === 'nearest') {
      const viewTop = scroller.scrollTop + headerH;
      const viewBottom = scroller.scrollTop + scroller.clientHeight;
      const bottom = top + target.offsetHeight;
      if (top >= viewTop && bottom <= viewBottom) return; // already visible
      // Off the bottom → bring its bottom edge just inside; off the top →
      // its top edge. Either way the pane moves the minimum distance.
      const next = top < viewTop ? top - headerH : bottom - scroller.clientHeight;
      scroller.scrollTop = Math.max(0, Math.min(next, max));
      return;
    }
    scroller.scrollTop = Math.max(0, Math.min(top - headerH, max));
  }

  private updateLevelButtonsActive(): void {
    for (const btn of this.levelButtons) {
      const lvl = parseInt(btn.dataset['level'] ?? '0', 10);
      btn.classList.toggle('pmd-nav-level-btn-active', lvl === this.maxLevel);
    }
  }

  // ---------------------------------------------- Context menu ----

  private openContextMenu(x: number, y: number, entry: HeadingEntry): void {
    closeAnyOpenContextMenu();

    const menu = document.createElement('div');
    menu.className = 'pmd-nav-context-menu';

    // Right-click on a row that's part of the multi-selection → the
    // menu acts on ALL selected rows; on any other row → just that one.
    const n = this.contextTargets(entry).length;
    const what = n > 1 ? `${n} headings` : 'heading';
    const items: ContextMenuItem[] = [
      {
        kind: 'item',
        label: `Select ${what} and contents`,
        action: () => this.selectHeadingAndContents(entry),
      },
      {
        kind: 'item',
        label: `Cut ${what} and contents`,
        action: () => { void this.cutHeadingAndContents(entry); },
      },
      {
        kind: 'item',
        label: `Copy ${what} and contents`,
        action: () => { void this.copyHeadingAndContents(entry); },
      },
      {
        kind: 'item',
        label: `Delete ${what} and contents`,
        action: () => this.deleteHeadingAndContents(entry),
      },
      // Creators — deliberately NOT multi-select aware: a live view or
      // linked copy mirrors ONE section, so these always act on the
      // clicked row alone, whatever the selection is.
      ...(entry.id != null && !entry.windowed
        ? ([
            { kind: 'separator' },
            {
              kind: 'item',
              label: 'Create live view of heading',
              action: () => this.createLiveViewFrom(entry),
            },
            {
              kind: 'item',
              label: 'Create linked copy of heading',
              action: () => this.createLinkedCopyFrom(entry),
            },
          ] as ContextMenuItem[])
        : []),
      { kind: 'separator' },
      ...[1, 2, 3, 4].map((lvl): ContextMenuItem => ({
        kind: 'item',
        label: `Show heading level ${lvl}`,
        checked: lvl === this.maxLevel,
        action: () => this.setMaxLevel(lvl),
      })),
    ];

    for (const item of items) {
      if (item.kind === 'separator') {
        const sep = document.createElement('div');
        sep.className = 'pmd-nav-context-separator';
        menu.appendChild(sep);
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pmd-nav-context-item';
      if (item.checked) btn.classList.add('pmd-nav-context-item-checked');
      btn.textContent = item.label;
      btn.addEventListener('click', () => {
        item.action();
        closeAnyOpenContextMenu();
      });
      menu.appendChild(btn);
    }

    document.body.appendChild(menu);

    // Position the menu, clamping to viewport.
    const rect = menu.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 4;
    const maxY = window.innerHeight - rect.height - 4;
    menu.style.left = `${Math.min(x, Math.max(0, maxX))}px`;
    menu.style.top = `${Math.min(y, Math.max(0, maxY))}px`;

    openContextMenuEl = menu;
    registerOpenContextMenu(closeAnyOpenContextMenu);
    setTimeout(() => {
      window.addEventListener('mousedown', maybeCloseContextMenu, { capture: true });
      window.addEventListener('keydown', maybeCloseContextMenu, { capture: true });
    });
  }

  /**
   * Compute the doc range covering a heading and everything "below" it
   * in the outline. Returns null if it can't be resolved.
   *
   * - Tag (always inside a card) → the parent card.
   * - Analytic inside an analytic_unit → the unit.
   * - Analytic inside a card (cite-position) → the card.
   * - Pocket / Hat / Block → from the heading to just before the next
   *   equal-or-shallower heading (or end of doc).
   */
  private computeHeadingRange(
    entry: HeadingEntry,
  ): { from: number; to: number; useNodeSelection: boolean } | null {
    if (!this.view) return null;
    return computeHeadingRange(this.view.state.doc, entry);
  }

  /** The entries a context-menu action should act on: the whole
   *  multi-selection when the clicked row belongs to it, else just the
   *  clicked row (matching every OS file manager). Re-collected from
   *  the live doc so positions are current at action time, not
   *  right-click time. */
  private contextTargets(entry: HeadingEntry): HeadingEntry[] {
    if (
      !this.view ||
      entry.id == null ||
      !this.selectedIds.has(entry.id) ||
      this.selectedIds.size < 2
    ) {
      return [entry];
    }
    const picked = collectOutlineWithWindows(this.view.state.doc).filter(
      (e) => e.id != null && this.selectedIds.has(e.id),
    );
    return picked.length > 0 ? picked : [entry];
  }

  /** Doc-order, overlap-merged subtree ranges for a set of headings.
   *  Merging is a belt (multi-select is same-level, so subtrees are
   *  disjoint), but a parent+child pair must never double-copy or
   *  double-delete. */
  private headingRanges(entries: HeadingEntry[]): { from: number; to: number }[] {
    const ranges = entries
      .map((e) => this.computeHeadingRange(e))
      .filter((r): r is NonNullable<ReturnType<NavigationPanel['computeHeadingRange']>> => r != null)
      .sort((a, b) => a.from - b.from);
    const merged: { from: number; to: number }[] = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
      else merged.push({ from: r.from, to: r.to });
    }
    return merged;
  }

  /** The self-containment guard the section picker enforces via
   *  guardPos, for the menu creators: the EDITOR cursor is the
   *  insertion point, and it must sit outside the mirrored section —
   *  a window can't live inside what it mirrors. Null = fine;
   *  otherwise the toast to show. */
  private creatorGuardMessage(entry: HeadingEntry, what: string): string | null {
    if (!this.view) return 'No document.';
    const range = this.computeHeadingRange(entry);
    if (!range || range.to <= range.from) return `This heading has no content to ${what}.`;
    const at = this.view.state.selection.from;
    if (at >= range.from && at <= range.to) {
      return `Put the cursor where the ${what} should go — outside this section — first.`;
    }
    return null;
  }

  /** Insert a read-only live view of this heading's section at the
   *  editor cursor (same insertion the picker command performs; the
   *  clicked nav row replaces the pick). */
  private createLiveViewFrom(entry: HeadingEntry): void {
    if (!this.view || entry.id == null) return;
    const blocked = this.creatorGuardMessage(entry, 'live view');
    if (blocked) {
      showToast(blocked);
      return;
    }
    if (!insertSelfRef(this.view, entry.id)) {
      showToast('Couldn\u2019t create a live view of this heading.');
    }
  }

  /** Insert an editable in-doc linked copy of this heading's section
   *  at the editor cursor. */
  private createLinkedCopyFrom(entry: HeadingEntry): void {
    if (!this.view || entry.id == null) return;
    const blocked = this.creatorGuardMessage(entry, 'linked copy');
    if (blocked) {
      showToast(blocked);
      return;
    }
    // insertInDocCopy surfaces its own error toasts (shared zone
    // error messages) on failure.
    insertInDocCopy(this.view, entry.id);
  }

  private selectHeadingAndContents(entry: HeadingEntry): void {
    if (!this.view) return;
    const targets = this.contextTargets(entry);
    if (targets.length > 1) {
      const ranges = this.headingRanges(targets);
      const first = ranges[0];
      if (!first) return;
      if (ranges.length === 1) {
        // A shift-click run merges into one contiguous span (adjacent
        // subtrees abut) — a plain native selection is exact.
        const tr = this.view.state.tr;
        tr.setSelection(TextSelection.create(this.view.state.doc, first.from, first.to));
        tr.scrollIntoView();
        this.view.dispatch(tr);
        this.view.focus();
        return;
      }
      // Scattered ⌘-click set → the app's discontinuous shadow selection
      // (same machinery as the manual Ctrl/Cmd selection and Select
      // Similar): each subtree selected exactly, nothing in between.
      // Format commands, copy, etc. consume it via getOperatingRanges.
      setManualShadowSelection(this.view, ranges);
      this.view.dispatch(this.view.state.tr.scrollIntoView());
      this.view.focus();
      return;
    }
    const range = this.computeHeadingRange(entry);
    if (!range) return;
    const doc = this.view.state.doc;
    const tr = this.view.state.tr;
    tr.setSelection(
      range.useNodeSelection
        ? NodeSelection.create(doc, range.from)
        : TextSelection.create(doc, range.from, range.to),
    );
    tr.scrollIntoView();
    this.view.dispatch(tr);
    this.view.focus();
  }

  /** Delete the heading subtree(s) — all targets in ONE transaction
   *  (one undo step), applied back-to-front so earlier positions never
   *  need remapping. Undo via Cmd+Z. */
  private deleteHeadingAndContents(entry: HeadingEntry): void {
    if (!this.view) return;
    const ranges = this.headingRanges(this.contextTargets(entry));
    if (ranges.length === 0) return;
    const tr = this.view.state.tr;
    for (let i = ranges.length - 1; i >= 0; i--) {
      const r = ranges[i]!;
      tr.delete(r.from, r.to);
    }
    this.view.dispatch(tr);
  }

  /** HTML + plain-text clipboard payload for one or more heading
   *  ranges, concatenated in doc order — a discontinuous ⌘-click set
   *  pastes exactly as if the sections had been dragged together. */
  private rangeClipboardPayload(...ranges: { from: number; to: number }[]): {
    html: string;
    text: string;
  } {
    const serializer = DOMSerializer.fromSchema(this.view!.state.schema);
    const tmp = document.createElement('div');
    const texts: string[] = [];
    for (const range of ranges) {
      const slice = this.view!.state.doc.slice(range.from, range.to);
      tmp.appendChild(serializer.serializeFragment(slice.content));
      texts.push(slice.content.textBetween(0, slice.content.size, '\n', '\n'));
    }
    return { html: tmp.innerHTML, text: texts.join('\n') };
  }

  /**
   * Copy the heading + subtree to the clipboard as both HTML and plain
   * text. Doesn't move focus or change the selection.
   */
  private async copyHeadingAndContents(entry: HeadingEntry): Promise<void> {
    if (!this.view) return;
    const ranges = this.headingRanges(this.contextTargets(entry));
    if (ranges.length === 0) return;
    const { html, text } = this.rangeClipboardPayload(...ranges);

    // Shared host-first / retrying path; every outcome surfaces —
    // the silent version of this taught a user that copy buttons
    // "need five clicks" (see clipboard-write.ts).
    if (await writeClipboardHtml(html, text)) showToast('Copied!');
    else showToast(CLIPBOARD_BUSY_MESSAGE);
  }

  /**
   * Cut = copy, then delete — and the delete happens only after the
   * clipboard write SUCCEEDS, so a busy clipboard can never destroy
   * content. The write is async (host-first, retrying): if any
   * transaction lands meanwhile (a collab peer's edit, typing during a
   * retry cycle), the captured range is stale — the delete is aborted
   * rather than removing a shifted span. Undo via Cmd+Z as with Delete.
   */
  private async cutHeadingAndContents(entry: HeadingEntry): Promise<void> {
    if (!this.view) return;
    const ranges = this.headingRanges(this.contextTargets(entry));
    if (ranges.length === 0) return;
    // A shared document: whole units are cut IN PLACE — marked and copied,
    // moved by the paste (cut-in-place.ts). Nothing is deleted here.
    if (isCutInPlaceDoc(this.view)) {
      await markCutInPlace(this.view, ranges);
      return;
    }
    const docAtCopy = this.view.state.doc;
    const { html, text } = this.rangeClipboardPayload(...ranges);

    if (!(await writeClipboardHtml(html, text))) {
      showToast(CLIPBOARD_BUSY_MESSAGE);
      return;
    }
    if (!this.view || this.view.state.doc !== docAtCopy) {
      showToast('Document changed while cutting — copied, but nothing was deleted.');
      return;
    }
    // One transaction, back-to-front (see deleteHeadingAndContents).
    const tr = this.view.state.tr;
    for (let i = ranges.length - 1; i >= 0; i--) {
      const r = ranges[i]!;
      tr.delete(r.from, r.to);
    }
    this.view.dispatch(tr);
    showToast('Cut!');
  }

  /**
   * Jump to a heading: place the cursor at the start of its content,
   * focus the editor, and scroll it into view. Headings carry a
   * `data-id` attr (per their toDOM); scrolling targets that element,
   * falling back to `domAtPos` when it isn't in the rendered DOM.
   */
  private jumpTo(entry: HeadingEntry): void {
    if (!this.view) return;

    // A windowed (projected) row is backed by the `self_ref` atom at entry.pos —
    // there's no real heading node inside. Select the atom and scroll to its OWN
    // DOM element (`domAtPos(pos)` lands just before it, which would scroll to
    // the previous node — the "jumps above" bug).
    if (entry.windowed) {
      try {
        this.view.dispatch(
          this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, entry.pos)),
        );
        this.view.focus();
      } catch {
        /* stale position — still try to scroll */
      }
      let el: Node | null = this.view.nodeDOM(entry.pos);
      while (el && el.nodeType !== Node.ELEMENT_NODE) el = el.parentNode;
      if (el instanceof HTMLElement) preciseScrollIntoView(this.view, el);
      return;
    }

    // Place the cursor at the start of the heading's content. entry.pos
    // is the position right before the heading node; +1 steps inside
    // its content. Wrap in try/catch in case the doc has shifted out
    // from under the entry (e.g., after rapid edits).
    try {
      const tr = this.view.state.tr.setSelection(
        TextSelection.create(this.view.state.doc, entry.pos + 1),
      );
      this.view.dispatch(tr);
      this.view.focus();
    } catch {
      // Fall through to scroll-only behavior if the position is stale.
    }

    if (entry.id && scrollToHeadingId(this.view, entry.id)) return;

    // Fallback: resolve the doc position and scroll the editor's
    // closest containing element into view.
    const domAtPos = this.view.domAtPos(entry.pos);
    let el: Node | null = domAtPos.node;
    while (el && el.nodeType !== Node.ELEMENT_NODE) el = el.parentNode;
    if (el && el instanceof HTMLElement) {
      preciseScrollIntoView(this.view, el);
    }
  }
}

// ---------------------------------------------- Context menu plumbing

interface ContextMenuItemBase {
  kind: 'item';
  label: string;
  action: () => void;
  checked?: boolean;
}
interface ContextMenuSeparator { kind: 'separator' }
type ContextMenuItem = ContextMenuItemBase | ContextMenuSeparator;

let openContextMenuEl: HTMLElement | null = null;

function closeAnyOpenContextMenu(): void {
  if (openContextMenuEl) {
    openContextMenuEl.remove();
    openContextMenuEl = null;
    window.removeEventListener('mousedown', maybeCloseContextMenu, { capture: true });
    window.removeEventListener('keydown', maybeCloseContextMenu, { capture: true });
  }
  clearOpenContextMenu(closeAnyOpenContextMenu);
}

function maybeCloseContextMenu(e: MouseEvent | KeyboardEvent): void {
  if (e instanceof KeyboardEvent) {
    if (e.key === 'Escape') closeAnyOpenContextMenu();
    return;
  }
  if (!openContextMenuEl) return;
  if (!openContextMenuEl.contains(e.target as Node)) {
    closeAnyOpenContextMenu();
  }
}

/** Minimal CSS.escape polyfill for jsdom-style environments. */

