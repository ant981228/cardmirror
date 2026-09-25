/**
 * Receive pill — the inbox of cards other machines have sent you.
 *
 * Behaves like the dropzone shelf (drag a row out into the doc, or click
 * to insert at the cursor / Alt-click to append) but each row also shows
 * WHO sent it and WHEN, and the pill flashes green when a card lands. The
 * count badge shows total received plus how many are still unread; opening
 * the pill marks everything read (and stops a "keep flashing" loop).
 *
 * Backed by `inbox-store` (main-process-owned, cross-window). Receiving is
 * driven by the main poller; this is purely display + drag-out.
 */

import { Slice } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { dragController, type DragItem } from '../drag-controller.js';
import { schema } from '../../schema/index.js';
import { setIcon } from '../icons';
import { typeBadge, dropzoneDragLevel, previewRowButton } from '../dropzone-ui.js';
import { openCardPreview } from '../card-preview-modal.js';
import { isAnyOverlayOpen } from '../overlay-stack.js';
import { settings } from '../settings.js';
import {
  inboxItemCardCount, inboxStore, type InboxItem } from './inbox-store.js';
import { insertReceivedItem, RECEIVE_NEEDS_DOC_MESSAGE } from './inbox-insert.js';
import { showToast } from '../toast.js';
import { parseRoomInvite } from './room-invite.js';
import { collabEnabled } from '../collab/collab-gate.js';
import { collabInviteJoiner, collabSessionJoinPrompt } from '../collab/collab-hooks.js';
import { deletePrefetch } from '../collab/collab-store.js';
import { checkedSliceFromJSON } from '../../schema/slice-check.js';

interface ReceivePillMountOptions {
  parent: HTMLElement;
  getFocusedView: () => EditorView | null;
}

const PULSE_MS = 700;
const REPEAT_MS = 10000;

/** The session-invite row's type chip — three letters like every other chip. */
export const SESSION_BADGE_LABEL = 'SES';

export class ReceivePillController {
  private root!: HTMLDivElement;
  private bar!: HTMLDivElement;
  private listEl!: HTMLUListElement;
  private joinSessionEl: HTMLButtonElement | null = null;
  private actionsLi: HTMLLIElement | null = null;
  private badge!: HTMLSpanElement;
  private getFocusedView: () => EditorView | null = () => null;
  private items: InboxItem[] = [];
  private open = false;
  private seenIds = new Set<string>();
  private flashTimer: number | null = null;
  private pulseTimer: number | null = null;
  private unsubscribeStore: (() => void) | null = null;
  private unsubscribeSettings: (() => void) | null = null;
  private unsubscribeController: (() => void) | null = null;
  private dragOutSource: {
    startX: number;
    startY: number;
    item: InboxItem;
    started: boolean;
    altKey: boolean;
  } | null = null;

  /** The pill's root element — re-parented by the shell between the
   *  editor pill tray and the home screen's dock (listeners ride along
   *  with the node, so the pill works identically in either host). */
  rootEl(): HTMLElement | null {
    return this.root ?? null;
  }

  mount(opts: ReceivePillMountOptions): void {
    this.getFocusedView = opts.getFocusedView;

    this.root = document.createElement('div');
    this.root.className = 'pmd-pill pmd-receive-pill';
    this.root.dataset['open'] = 'false';
    this.root.setAttribute('role', 'group');
    this.root.setAttribute('aria-label', 'Received cards');

    this.listEl = document.createElement('ul');
    this.listEl.className = 'pmd-receive-list pmd-pill-popup';
    this.root.appendChild(this.listEl);

    // Footer action inside the popup list: join a session by pasted
    // code. Unconditional (no session state to depend on — joining is
    // always possible); hidden only where collab itself is (web
    // edition / joiner not wired). Built once; render() re-appends it
    // after clearing the list, so listeners survive.
    this.actionsLi = document.createElement('li');
    this.actionsLi.className = 'pmd-receive-actions';
    this.joinSessionEl = document.createElement('button');
    this.joinSessionEl.type = 'button';
    this.joinSessionEl.className = 'pmd-receive-action';
    this.joinSessionEl.innerHTML =
      '<span class="pmd-send-action-icon" aria-hidden="true">' +
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>' +
      '</span><span>Join session</span>';
    this.joinSessionEl.title = 'Join a collaboration session with a pasted share code';
    this.joinSessionEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setOpen(false);
      collabSessionJoinPrompt()?.();
    });
    this.actionsLi.appendChild(this.joinSessionEl);

    this.bar = document.createElement('div');
    this.bar.className = 'pmd-pill-bar pmd-receive-bar';
    this.bar.setAttribute('role', 'button');
    this.bar.setAttribute('tabindex', '0');
    this.bar.title = 'Cards other people sent you';
    const icon = document.createElement('span');
    icon.className = 'pmd-pill-icon';
    icon.setAttribute('aria-hidden', 'true');
    // In-tray (the icon set's `download`), paired with Send's out-tray.
    setIcon(icon, 'download');
    this.bar.appendChild(icon);
    const labelEl = document.createElement('span');
    labelEl.className = 'pmd-pill-label';
    labelEl.textContent = 'Receive';
    this.bar.appendChild(labelEl);

    // One combined badge: "total · N new" (blue) when there are unread
    // cards, fading to just "total" (gray) once everything's been seen.
    this.badge = document.createElement('span');
    this.badge.className = 'pmd-receive-badge';
    this.badge.hidden = true;
    this.bar.appendChild(this.badge);

    const toggle = (e: Event): void => {
      e.stopPropagation();
      this.setOpen(!this.open);
    };
    this.bar.addEventListener('click', toggle);
    this.bar.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle(e);
      }
    });

    this.root.appendChild(this.bar);
    opts.parent.appendChild(this.root);

    void inboxStore.init().then(() => {
      this.items = inboxStore.list();
      this.seenIds = new Set(this.items.map((it) => it.id));
      this.render();
      // Resume "keep flashing" for cards still unread from a previous
      // session — they haven't been seen yet, so the reminder continues.
      if (
        settings.get('pairingReceiveFlash') === 'repeat' &&
        inboxStore.unreadCount() > 0 &&
        !this.open
      ) {
        this.handleArrival();
      }
    });
    this.unsubscribeStore = inboxStore.subscribe((items) => {
      this.onStoreChange(items);
    });
    this.unsubscribeSettings = settings.subscribe(() => {
      this.applyVisibility();
      if (settings.get('pairingReceiveFlash') === 'off') this.stopRepeat();
    });
    this.unsubscribeController = dragController.subscribe((event) => {
      if (event === 'end') this.endDragOut();
    });

    this.applyVisibility();
    document.addEventListener('pointerdown', this.onDocumentPointerDown);
  }

  unmount(): void {
    document.removeEventListener('pointerdown', this.onDocumentPointerDown);
    this.unsubscribeStore?.();
    this.unsubscribeSettings?.();
    this.unsubscribeController?.();
    this.stopRepeat();
    this.root.remove();
  }

  private applyVisibility(): void {
    this.root.hidden = !settings.get('pairingEnabled');
  }

  private onStoreChange(items: InboxItem[]): void {
    const arrivals = items.filter((it) => !this.seenIds.has(it.id) && !it.read);
    for (const it of items) this.seenIds.add(it.id);
    this.items = items;
    this.render();
    if (arrivals.length > 0 && !this.open) this.handleArrival();
  }

  // ---- Flash --------------------------------------------------------

  private handleArrival(): void {
    const mode = settings.get('pairingReceiveFlash');
    if (mode === 'off') return;
    this.pulse();
    if (mode === 'repeat') this.startRepeat();
  }

  /** One green pulse — the command-bar / repair-paragraph technique:
   *  drop the class, force reflow to restart, re-add, clear after the
   *  animation. A timeout (not `animationend`) so reduced-motion, which
   *  disables the keyframe, still clears the class. */
  private pulse(): void {
    this.root.classList.remove('pmd-pill-flash');
    void this.root.offsetWidth; // reflow
    this.root.classList.add('pmd-pill-flash');
    if (this.pulseTimer !== null) window.clearTimeout(this.pulseTimer);
    this.pulseTimer = window.setTimeout(() => {
      this.root.classList.remove('pmd-pill-flash');
      this.pulseTimer = null;
    }, PULSE_MS);
  }

  private startRepeat(): void {
    this.stopRepeat();
    this.flashTimer = window.setInterval(() => {
      if (!settings.get('pairingEnabled') || inboxStore.unreadCount() === 0 || this.open) {
        this.stopRepeat();
        return;
      }
      this.pulse();
    }, REPEAT_MS);
  }

  private stopRepeat(): void {
    if (this.flashTimer !== null) {
      window.clearInterval(this.flashTimer);
      this.flashTimer = null;
    }
  }

  // ---- Rendering ----------------------------------------------------

  private setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    this.root.dataset['open'] = open ? 'true' : 'false';
    if (open) {
      this.stopRepeat();
      this.root.classList.remove('pmd-pill-flash');
      void inboxStore.markAllRead();
    }
    this.render();
  }

  private render(): void {
    const total = this.items.length;
    const unread = inboxStore.unreadCount();
    this.badge.hidden = total === 0;
    this.badge.textContent = unread > 0 ? `${total} · ${unread} new` : String(total);
    this.badge.classList.toggle('pmd-receive-badge-unread', unread > 0);
    this.root.classList.toggle('pmd-pill-empty', total === 0);

    this.listEl.innerHTML = '';
    if (total === 0) {
      const empty = document.createElement('li');
      empty.className = 'pmd-receive-empty';
      empty.textContent = "You haven't received anything yet.";
      this.listEl.appendChild(empty);
    } else {
      for (const item of [...this.items].reverse()) {
        this.listEl.appendChild(this.renderRow(item));
      }
    }
    if (this.actionsLi) {
      this.actionsLi.hidden = !(collabEnabled() && collabSessionJoinPrompt() !== null);
      this.listEl.appendChild(this.actionsLi);
    }
  }

  private renderRow(item: InboxItem): HTMLLIElement {
    const invite = parseRoomInvite(item);
    if (invite) return this.renderInviteRow(item, invite);
    const row = document.createElement('li');
    row.className = 'pmd-receive-row';
    if (!item.read) row.classList.add('pmd-receive-row-unread');

    const badge = document.createElement('span');
    const { kind, label: typeLabel } = typeBadge(item.type);
    badge.className = `pmd-dropzone-row-type pmd-dropzone-row-type-${kind}`;
    badge.textContent = typeLabel;
    row.appendChild(badge);

    // Bundled multi-selection send → ×N count beside the type chip.
    // Everything about the row stays atomic: click, drag-out, and ✕
    // all act on the whole bundle (partial grabs are deliberately not
    // a thing — the sender chose what travels together).
    const cardCount = inboxItemCardCount(item);
    if (cardCount > 1) {
      const count = document.createElement('span');
      count.className = 'pmd-receive-row-count';
      count.textContent = `×${cardCount}`;
      count.title = `${cardCount} cards — inserted together`;
      row.appendChild(count);
    }

    const main = document.createElement('span');
    main.className = 'pmd-receive-row-main';
    const label = document.createElement('span');
    label.className = 'pmd-receive-row-label';
    label.textContent = item.label;
    label.title = item.label;
    main.appendChild(label);
    const meta = document.createElement('span');
    meta.className = 'pmd-receive-row-meta';
    meta.textContent = `${resolveSender(item)} · ${relTime(item.receivedAt)}`;
    meta.title = meta.textContent;
    main.appendChild(meta);
    row.appendChild(main);

    // Look before you insert: a full-size read-only preview with Copy.
    const subtitle = meta.textContent;
    row.appendChild(
      previewRowButton(() => openCardPreview({ title: item.label, subtitle, sliceJson: item.sliceJson })),
    );

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'pmd-dropzone-row-delete';
    del.title = 'Remove';
    del.setAttribute('aria-label', 'Remove');
    setIcon(del, 'close');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      void inboxStore.remove(item.id);
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

  /** A session invite: not draggable/insertable — its action is Join.
   *  Old clients never see these rows (the envelope's version floor
   *  drops the message in main with the update toast); a client with
   *  the collab gate closed shows the row without the Join button. */
  private renderInviteRow(
    item: InboxItem,
    invite: { shareCode: string; title: string },
  ): HTMLLIElement {
    // Eagerly prefetch the room's encrypted seed (§4.1) so accepting
    // this invite later — offline — still joins. Fire-and-forget; the
    // module is light (no wasm) and dedupes/staleness-checks itself.
    if (collabEnabled()) {
      void import('../collab/collab-prefetch.js').then((m) =>
        m.prefetchInviteSeed(invite.shareCode),
      );
    }
    const row = document.createElement('li');
    row.className = 'pmd-receive-row pmd-receive-row-invite';
    if (!item.read) row.classList.add('pmd-receive-row-unread');

    const badge = document.createElement('span');
    badge.className = 'pmd-dropzone-row-type pmd-dropzone-row-type-generic';
    badge.textContent = SESSION_BADGE_LABEL;
    row.appendChild(badge);

    const main = document.createElement('span');
    main.className = 'pmd-receive-row-main';
    const label = document.createElement('span');
    label.className = 'pmd-receive-row-label';
    label.textContent = invite.title
      ? `Invited you to collaborate on “${invite.title}”`
      : 'Invited you to a collaboration session';
    label.title = label.textContent;
    main.appendChild(label);
    const meta = document.createElement('span');
    meta.className = 'pmd-receive-row-meta';
    meta.textContent = `${resolveSender(item)} · ${relTime(item.receivedAt)}`;
    meta.title = meta.textContent;
    main.appendChild(meta);
    row.appendChild(main);

    const joiner = collabEnabled() ? collabInviteJoiner() : null;
    if (joiner) {
      const join = document.createElement('button');
      join.type = 'button';
      join.className = 'pmd-receive-row-join';
      join.textContent = 'Join';
      join.title = 'Join the collaboration session';
      join.addEventListener('click', (e) => {
        e.stopPropagation();
        // Consume the invite only when the join actually lands: a cancelled
        // slot pick, an unreachable/filtered relay, or a balked overwrite
        // prompt must not burn the share code (the host would have to
        // re-invite for every retry). A dead room (session ended) reports
        // true from the flow so the useless row still clears.
        void joiner(invite.shareCode).then((joined) => {
          if (joined) void inboxStore.remove(item.id);
        });
      });
      row.appendChild(join);
    }

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'pmd-dropzone-row-delete';
    del.title = 'Remove';
    del.setAttribute('aria-label', 'Remove');
    setIcon(del, 'close');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      void inboxStore.remove(item.id);
      // Declined invite — drop its prefetched seed too.
      const roomId = invite.shareCode.split('.')[1];
      if (roomId) void deletePrefetch(roomId);
    });
    row.appendChild(del);

    return row;
  }

  // ---- Drag-out / insert (mirrors the dropzone) ---------------------

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
    const src = this.dragOutSource;
    if (!src) return;
    if (src.started) {
      dragController.commit({ copy: true });
    } else {
      this.insertItem(src.item, src.altKey || e.altKey);
    }
    this.endDragOut();
  };

  private beginDragOut(item: InboxItem): boolean {
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
      level: dropzoneDragLevel(type),
      label: item.label,
      prebuilt: slice,
    };
    dragController.begin({ view, items: [dragItem], virtual: true });
    return true;
  }

  private insertItem(item: InboxItem, atEnd: boolean): void {
    const view = this.getFocusedView();
    if (!view) {
      // No visible destination: the home screen covers the doc, or the
      // workspace is empty. Say so instead of silently doing nothing —
      // the item stays in the inbox for when a doc is open.
      showToast(RECEIVE_NEEDS_DOC_MESSAGE);
      return;
    }
    insertReceivedItem(view, item, atEnd);
  }

  private endDragOut(): void {
    if (!this.dragOutSource) return;
    window.removeEventListener('pointermove', this.onDragOutPointerMove);
    window.removeEventListener('pointerup', this.onDragOutPointerUp);
    this.dragOutSource = null;
  }

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

/** Prefer your local nickname for the sender, then their self-declared
 *  name, then a short form of their code. */
export function resolveSender(item: InboxItem): string {
  if (item.senderCode) {
    const partner = settings
      .get('pairingPartners')
      .find((p) => p.code && p.code === item.senderCode);
    if (partner?.name) return item.via ? `${partner.name} · ${item.via}` : partner.name;
  }
  if (item.senderName) return item.via ? `${item.senderName} · ${item.via}` : item.senderName;
  if (item.senderCode) return `…${item.senderCode.slice(-4)}`;
  return 'Unknown sender';
}

export function relTime(ts: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

/** Open the most-recently-received card in the preview (the same
 *  preview a row's Preview button opens) without inserting anything —
 *  the keyboard twin of Insert Received Card. False when the inbox is
 *  empty or the payload cannot be rebuilt (the preview toasts for the
 *  latter itself). Works with the home screen up: nothing is written. */
export const NOTHING_RECEIVED_MESSAGE = 'Nothing received yet.';
export function previewMostRecentReceived(): boolean {
  const item = inboxStore.list().at(-1);
  if (!item) {
    showToast(NOTHING_RECEIVED_MESSAGE);
    return false;
  }
  return openCardPreview({
    title: item.label,
    subtitle: `${resolveSender(item)} · ${relTime(item.receivedAt)}`,
    sliceJson: item.sliceJson,
  });
}
