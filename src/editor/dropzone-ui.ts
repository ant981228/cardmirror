/**
 * Dropzone bubble — cross-window scratch shelf for dragged content.
 * A single instance, anchored to the editor's bottom-left corner
 * (positioned by `positionDropzone` in index.ts — not the nav pane,
 * whose bottom edge sits in the outline's auto-scroll zone).
 *
 * Two states, the same anatomy as the Send / Receive pills:
 *   - Closed: small grey pill in the tray (icon + item count).
 *   - Open: the item list is a `.pmd-pill-popup` rising from the
 *     pill row (left-anchored on the tray, spanning it), with the
 *     bar as the popup's tab — the popup grows out of the button.
 *     Clear lives in the popup's footer.
 *
 *   - Drag-over (any state): blue accept-state matching the nav-
 *     pane + editor drop indicators. The bubble's surface
 *     subscribes to the drag controller's 'end' event so the
 *     highlight clears after commit.
 *
 * Drag-in: registers a DragSurface with `dragController`. On
 *   commit, the surface's `absorb` extracts each session item's
 *   slice and pushes it into `dropzoneStore`.
 *
 * Drag-out: rows in the list start a `virtual` drag session via
 *   `dragController.begin(...)` on pointerdown + threshold move.
 *
 * Store: `dropzoneStore` (electron-aware) holds the cross-window
 *   state. A single DropzoneController is mounted at boot
 *   (index.ts); `getFocusedView` resolves the active editor view.
 */

import { Slice } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import {
  dragController,
  rewriteHeadingIds,
  type DragItem,
  type DragSurface,
} from './drag-controller.js';
import { dropzoneStore, deriveDropzoneLabel, type DropzoneItem } from './dropzone-store.js';
import { TYPE_TO_LEVEL } from './headings.js';
import { nearestValidInsertPos } from './insert-position.js';
import { flattenZonesInSlice } from './transclusion.js';
import { flattenSelfRefsInSlice } from './self-transclusion.js';
import { schema, newHeadingId } from '../schema/index.js';
import { setIcon } from './icons';
import { readModePlugin } from './read-mode-plugin.js';
import { READ_MODE_DRAG_META } from './reading-marker.js';
import { checkedSliceFromJSON } from '../schema/slice-check.js';
import { openCardPreview } from './card-preview-modal.js';
import { isAnyOverlayOpen } from './overlay-stack.js';

interface DropzoneMountOptions {
  parent: HTMLElement;
  getFocusedView: () => EditorView | null;
}

export class DropzoneController {
  /** The pill: the bar, plus the popup list while open. In the tray
   *  `positionDropzone` (index.ts) anchors. */
  private root!: HTMLDivElement;
  /** The popup list (`.pmd-pill-popup`), shown while open. */
  private listEl!: HTMLUListElement;
  /** The bar (icon + count). Always visible; the click target for
   *  toggling open / closed, and the popup's tab while open. */
  private bar!: HTMLDivElement;
  private countBadge!: HTMLSpanElement;
  private clearBtn!: HTMLButtonElement;
  /** Popup footer holding Clear; appended by renderList while there
   *  are items (built once so the listener survives re-renders). */
  private actionsLi!: HTMLLIElement;
  private items: DropzoneItem[] = [];
  private open = false;
  private surface: DragSurface | null = null;
  private unregisterSurface: (() => void) | null = null;
  private unsubscribeStore: (() => void) | null = null;
  private unsubscribeController: (() => void) | null = null;
  private getFocusedView: () => EditorView | null = () => null;
  private dragOutSource: {
    startX: number;
    startY: number;
    item: DropzoneItem;
    started: boolean;
    altKey: boolean;
  } | null = null;

  mount(opts: DropzoneMountOptions): void {
    this.getFocusedView = opts.getFocusedView;

    this.root = document.createElement('div');
    this.root.className = 'pmd-pill pmd-dropzone-root';
    this.root.dataset['open'] = 'false';
    this.root.setAttribute('role', 'group');
    this.root.setAttribute('aria-label', 'Dropzone shelf');

    // The popup list, above the pill row while open.
    this.listEl = document.createElement('ul');
    this.listEl.className = 'pmd-dropzone-list pmd-pill-popup';
    this.root.appendChild(this.listEl);

    // Popup footer: Clear. Lives in the popup, not the bar, so the bar
    // stays a pill-sized tab.
    this.actionsLi = document.createElement('li');
    this.actionsLi.className = 'pmd-dropzone-actions';
    this.clearBtn = document.createElement('button');
    this.clearBtn.type = 'button';
    this.clearBtn.className = 'pmd-dropzone-clear';
    this.clearBtn.textContent = 'Clear';
    this.clearBtn.title = 'Remove every shelf item';
    this.clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void dropzoneStore.clear();
    });
    this.actionsLi.appendChild(this.clearBtn);

    // Bar — always visible. Clicking it toggles open.
    this.bar = document.createElement('div');
    this.bar.className = 'pmd-dropzone-bar';
    this.bar.setAttribute('role', 'button');
    this.bar.setAttribute('tabindex', '0');
    this.bar.title = 'Dropzone — drag content here, click to expand';

    // A storage box (the icon set's `archive`): a shelf where cards are
    // parked. Send / Receive carry the set's matching out-tray / in-tray.
    const icon = document.createElement('span');
    icon.className = 'pmd-dropzone-icon';
    icon.setAttribute('aria-hidden', 'true');
    setIcon(icon, 'archive');
    this.bar.appendChild(icon);

    this.countBadge = document.createElement('span');
    this.countBadge.className = 'pmd-dropzone-count';
    this.countBadge.hidden = true;
    this.bar.appendChild(this.countBadge);

    const handleToggle = (e: Event): void => {
      e.stopPropagation();
      this.setOpen(!this.open);
    };
    this.bar.addEventListener('click', handleToggle);
    this.bar.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleToggle(e);
      }
    });

    this.root.appendChild(this.bar);
    opts.parent.appendChild(this.root);

    // Drag surface — the pill (its bar) and, while open, the popup list
    // are both targets, so dropping anywhere on the shelf counts. (The
    // popup is absolutely positioned: the root's own rect is just the
    // bar, so the list is measured separately.)
    this.surface = {
      hitTest: (clientX, clientY) => {
        // Don't absorb our own drag-out: virtual sessions originate from
        // the shelf, so dropping a shelf item back onto the shelf would
        // just duplicate it. Returning null makes that a no-op (and frees
        // the editor surface to win the hit instead).
        if (dragController.getSession()?.virtual) return null;
        const inRect = (rect: DOMRect): boolean =>
          clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
        const inside =
          inRect(this.root.getBoundingClientRect()) ||
          (this.open && inRect(this.listEl.getBoundingClientRect()));
        if (!inside) return null;
        return {
          el: this.root,
          insertPos: 0,
          dy: 0,
          absorb: (items) => this.absorbItems(items),
        };
      },
      highlight: (el) => {
        this.root.classList.toggle('pmd-dropzone-root-drop-target', el !== null);
      },
    };
    this.unregisterSurface = dragController.registerSurface(this.surface);

    void dropzoneStore.init().then(() => {
      this.items = dropzoneStore.list();
      this.renderList();
      this.renderBar();
    });
    this.unsubscribeStore = dropzoneStore.subscribe((items) => {
      this.items = items;
      this.renderList();
      this.renderBar();
    });

    // End-of-drag cleanup — controller doesn't proactively clear
    // surface highlights, so the dropzone clears its own here.
    this.unsubscribeController = dragController.subscribe((event) => {
      if (event === 'end') {
        this.surface?.highlight(null);
        this.endDragOut();
      }
    });

    document.addEventListener('pointerdown', this.onDocumentPointerDown);
  }

  unmount(): void {
    document.removeEventListener('pointerdown', this.onDocumentPointerDown);
    this.unsubscribeStore?.();
    this.unsubscribeController?.();
    this.unregisterSurface?.();
    this.root.remove();
  }

  // ---- Rendering ----------------------------------------------------

  private renderBar(): void {
    const n = this.items.length;
    this.countBadge.hidden = n === 0;
    this.countBadge.textContent = String(n);
    this.root.classList.toggle('pmd-dropzone-root-empty', n === 0);
  }

  private setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    this.root.dataset['open'] = open ? 'true' : 'false';
    this.renderBar();
  }

  private renderList(): void {
    this.listEl.innerHTML = '';
    if (this.items.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'pmd-dropzone-empty';
      empty.textContent =
        'Drag a card or heading onto the pill. Shelf items are shared across windows in this session.';
      this.listEl.appendChild(empty);
      return;
    }
    for (const item of [...this.items].reverse()) {
      this.listEl.appendChild(this.renderRow(item));
    }
    this.listEl.appendChild(this.actionsLi);
  }

  private renderRow(item: DropzoneItem): HTMLLIElement {
    const row = document.createElement('li');
    row.className = 'pmd-dropzone-row';

    const badge = document.createElement('span');
    const { kind, label: typeLabel } = typeBadge(item.type);
    badge.className = `pmd-dropzone-row-type pmd-dropzone-row-type-${kind}`;
    badge.textContent = typeLabel;
    row.appendChild(badge);

    const label = document.createElement('span');
    label.className = 'pmd-dropzone-row-label';
    label.textContent = item.label;
    label.title = item.label;
    row.appendChild(label);

    // Look before you insert: a full-size read-only preview with Copy.
    row.appendChild(previewRowButton(() => openCardPreview({ title: item.label, sliceJson: item.sliceJson })));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'pmd-dropzone-row-delete';
    del.title = 'Remove from shelf';
    del.setAttribute('aria-label', 'Remove');
    setIcon(del, 'close');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      void dropzoneStore.remove(item.id);
    });
    row.appendChild(del);

    row.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest('.pmd-dropzone-row-delete, .pmd-row-preview')) return;
      this.dragOutSource = {
        startX: e.clientX,
        startY: e.clientY,
        item,
        started: false,
        altKey: e.altKey,
      };
      window.addEventListener('pointermove', this.onDragOutPointerMove);
      window.addEventListener('pointerup', this.onDragOutPointerUp);
      e.preventDefault();
    });

    return row;
  }

  // ---- Drag-in (controller absorb) ----------------------------------

  private async absorbItems(items: DragItem[]): Promise<void> {
    const session = dragController.getSession();
    if (!session) return;
    const srcView = session.view;
    for (const item of items) {
      // Materialize any Live View before it's frozen onto the shelf — the source
      // doc is gone by drop time, so the reference can't survive. A prebuilt
      // slice (a received card, a shelf item dragged onward) was materialized
      // by whoever built it; flattening it against THIS doc would drop its
      // cards, since its source is not here.
      const slice =
        item.prebuilt ?? flattenSelfRefsInSlice(srcView.state.doc.slice(item.from, item.to), srcView.state.doc, newHeadingId);
      const sliceJson = slice.toJSON();
      const type = item.type || inferTypeFromSlice(slice);
      const label = deriveDropzoneLabel(slice, type);
      const id = newId();
      await dropzoneStore.add({
        id,
        label,
        type,
        sliceJson,
        createdAt: Date.now(),
      });
    }
  }

  // ---- Drag-out -----------------------------------------------------

  private onDragOutPointerMove = (e: PointerEvent): void => {
    const src = this.dragOutSource;
    if (!src) return;
    if (!src.started) {
      const dx = e.clientX - src.startX;
      const dy = e.clientY - src.startY;
      if (dx * dx + dy * dy < 16) return;
      src.started = this.beginDragOut(src.item);
      if (!src.started) {
        this.endDragOut();
        return;
      }
    }
    dragController.setPointer(e.clientX, e.clientY);
    dragController.dispatchHit(e.clientX, e.clientY);
  };

  private onDragOutPointerUp = (e: PointerEvent): void => {
    if (!this.dragOutSource) return;
    const src = this.dragOutSource;
    if (src.started) {
      dragController.commit({ copy: true });
    } else {
      // Click without crossing the drag threshold → insert the
      // item into the active doc. Alt held at release time (or at
      // pointerdown — either counts as user intent) means insert
      // at end; otherwise at cursor. Same semantic as send-to-
      // speech's ` (at-cursor) vs Alt-\` (at-end) split.
      const atEnd = src.altKey || e.altKey;
      this.insertItem(src.item, atEnd);
    }
    this.endDragOut();
  };

  private beginDragOut(item: DropzoneItem): boolean {
    const view = this.getFocusedView();
    if (!view) return false;
    let slice: Slice;
    try {
      slice = checkedSliceFromJSON(item.sliceJson);
    } catch {
      return false;
    }
    const type = item.type || 'dropzone';
    const dragItem: DragItem = {
      from: 0,
      to: 0,
      id: null,
      type,
      // Mirror the native drag's level so the editor / nav surfaces gate
      // drop indicators the same way: a block (level 3) can only land at
      // pocket/hat/block boundaries, not inside another block before a
      // tag. Headings map via TYPE_TO_LEVEL; card / analytic_unit drag at
      // tag level (4, like the native container drag); anything else
      // (loose paragraph / unknown) is generic content that can go
      // anywhere, so it gets the deepest level. (Level 0 would gate
      // every indicator out, leaving the drag no target.)
      level: dropzoneDragLevel(type),
      label: item.label,
      prebuilt: slice,
    };
    dragController.begin({ view, items: [dragItem], virtual: true });
    return true;
  }

  /** Insert the item's slice into the active view at the cursor
   *  position (atEnd=false) or at the end of the doc (atEnd=true).
   *  Mirrors send-to-speech's at-cursor vs at-end semantic.
   *  Heading IDs are rewritten so re-inserting the same shelf item
   *  multiple times never produces ID collisions. */
  private insertItem(item: DropzoneItem, atEnd: boolean): void {
    const view = this.getFocusedView();
    if (!view) return;
    let slice: Slice;
    try {
      slice = checkedSliceFromJSON(item.sliceJson);
    } catch {
      return;
    }
    // A shelf item is a frozen paste — flatten any live zone it carries so it
    // can't drop a wrong-doc live link into whatever doc is focused.
    const rewritten = rewriteHeadingIds(flattenZonesInSlice(slice));
    // In read mode there's no editing caret to target, so a click appends to
    // the bottom of the doc rather than the cursor.
    const inReadMode = readModePlugin.getState(view.state)?.on === true;
    // Snap a click-to-insert to the nearest valid drop target for THIS content
    // (where a drag would drop it): a whole card lands at a doc-level gap, card
    // content lands inside the enclosing card, inline text stays at the caret —
    // so a shelf item never splits the card the caret is in.
    const insertPos =
      atEnd || inReadMode
        ? view.state.doc.content.size
        : nearestValidInsertPos(view.state.doc, view.state.selection.head, rewritten.content);
    const tr = view.state.tr
      .insert(insertPos, rewritten.content)
      .setMeta(READ_MODE_DRAG_META, true);
    view.dispatch(tr.scrollIntoView());
    view.focus();
  }

  private endDragOut(): void {
    if (!this.dragOutSource) return;
    window.removeEventListener('pointermove', this.onDragOutPointerMove);
    window.removeEventListener('pointerup', this.onDragOutPointerUp);
    this.dragOutSource = null;
  }

  // ---- Click-outside ------------------------------------------------

  private onDocumentPointerDown = (e: PointerEvent): void => {
    if (!this.open) return;
    // A modal on top (the card preview opened from a row) takes the pointer:
    // its Close button must not collapse the list the user is browsing.
    if (isAnyOverlayOpen()) return;
    const t = e.target as Node | null;
    if (!t) return;
    if (this.root.contains(t)) return;
    this.setOpen(false);
  };
}

function newId(): string {
  return `dz-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The row's Preview button — the compact accent-outline look of the
 *  Receive pill's Join button. Shared by the shelf and the inbox rows;
 *  the click never starts the row's drag-out. */
export function previewRowButton(open: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pmd-row-preview';
  btn.textContent = 'Preview';
  btn.title = 'Look at these cards without inserting them';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    open();
  });
  return btn;
}

/** The row's type chip. Every label is three letters so the chips line
 *  up (user request 2026-09-09); the heading ones match the search
 *  toolbar's file-object badges (`FILE_OBJECT_KIND_BADGES`). */
export function typeBadge(type: string): { kind: string; label: string } {
  switch (type) {
    case 'pocket': return { kind: 'pocket', label: 'POC' };
    case 'hat': return { kind: 'hat', label: 'HAT' };
    case 'block': return { kind: 'block', label: 'BLK' };
    case 'tag': return { kind: 'tag', label: 'TAG' };
    case 'analytic': return { kind: 'analytic', label: 'ANL' };
    case 'card': return { kind: 'card', label: 'CRD' };
    case 'card_body': return { kind: 'card', label: 'BDY' };
    case 'cite_paragraph': return { kind: 'cite', label: 'CIT' };
    case 'analytic_unit': return { kind: 'analytic', label: 'ANL' };
    case 'undertag': return { kind: 'tag', label: 'UND' };
    case 'paragraph': return { kind: 'text', label: 'TXT' };
    case 'text': return { kind: 'text', label: 'TXT' };
    default: return { kind: 'generic', label: 'ITM' };
  }
}

function inferTypeFromSlice(slice: Slice): string {
  if (slice.content.childCount === 0) return 'text';
  const first = slice.content.firstChild;
  return first ? first.type.name : 'text';
}

/** Outline level a dropzone item should drag at, matching the native
 *  editor / nav drag so drop indicators are gated identically. Headings
 *  map via `TYPE_TO_LEVEL`; `card` / `analytic_unit` drag at tag level
 *  (4, like the native container drag); generic content (loose
 *  paragraph / unknown) can go anywhere, so it gets the deepest level. */
export function dropzoneDragLevel(type: string): number {
  if (type === 'card' || type === 'analytic_unit') return 4;
  return TYPE_TO_LEVEL[type] ?? 4;
}
