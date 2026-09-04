/**
 * Send pill — a drop target that pushes a card to a paired machine.
 *
 * Drag any card (from the editor, the dropzone, or the receive pill) over
 * this pill and it EXPANDS to reveal your partners and groups; drop on one
 * to send. It registers a `DragSurface` with the shared drag controller
 * (same mechanism the dropzone uses); the controller calls our `absorb`
 * when a card is dropped on a target row. Group targets fan the card out
 * to every member.
 *
 * No expansion happens without an active drag — the pill is a small
 * button otherwise.
 */

import { Fragment, Slice } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import {
  dragController,
  type DragItem,
  type DragSurface,
} from '../drag-controller.js';
import { deriveDropzoneLabel } from '../dropzone-store.js';
import { schema } from '../../schema/index.js';
import { settings, type PairingGroup } from '../settings.js';
import { showToast } from '../toast.js';
import { relayClient, sendOutcomeToast, type SendItem } from './relay-client.js';
import { collabEnabled } from '../collab/collab-gate.js';
import {
  collabActiveShareCode,
  collabInviter,
  collabSessionStarter,
} from '../collab/collab-hooks.js';
import { promptForText } from '../text-prompt.js';
import { normalizePairingCode, looksLikePairingCode } from './pairing-ids.js';
import { recentSenders } from './inbox-store.js';

interface SendPillMountOptions {
  parent: HTMLElement;
}

interface SendTarget {
  /** Recipient codes this row resolves to (one for a partner, many for a
   *  group). */
  codes: string[];
  /** Human label for the toast. */
  label: string;
  /** Group label stamped on the card, when this target is a group. */
  via?: string;
}

function pointInRect(r: { left: number; right: number; top: number; bottom: number }, x: number, y: number): boolean {
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/** Bounding box that encloses both rects (and the gap between them). */
function unionRect(
  a: DOMRect,
  b: DOMRect,
): { left: number; right: number; top: number; bottom: number } {
  return {
    left: Math.min(a.left, b.left),
    right: Math.max(a.right, b.right),
    top: Math.min(a.top, b.top),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

/** Person-plus glyph for the "add contact" action. */
const ADD_CONTACT_ICON =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="17" y1="11" x2="23" y2="11"/></svg>';

/** Clock-back glyph for the drag-mode "recent senders" zone. */
const RECENT_ICON =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg>';

/** Two-people glyph for the per-contact "invite to collaborate" button. */
const COLLAB_INVITE_ICON =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';

interface CapturedItem {
  slice: Slice;
  type: string;
  label: string;
}

/** A multi-selection ships as ONE item the receiver grabs atomically —
 *  the slices concatenate into a single slice (they arrive in document
 *  order from the drag session), so the wire format is unchanged and
 *  any receiver build, old or new, inserts the whole set in one go.
 *  Only closed node-level slices bundle; a drag carrying an open text
 *  fragment falls back to per-item sends (concatenating open slices
 *  would splice unrelated textblocks together). Exported for tests. */
export function bundleSendItems(items: CapturedItem[]): SendItem[] {
  if (items.length <= 1 || items.some((i) => i.slice.openStart !== 0 || i.slice.openEnd !== 0)) {
    return items.map((i) => ({ label: i.label, type: i.type, sliceJson: i.slice.toJSON() }));
  }
  let content = Fragment.empty;
  for (const i of items) content = content.append(i.slice.content);
  const first = items[0]!;
  return [
    {
      label: `${first.label} + ${items.length - 1} more`,
      type: first.type,
      sliceJson: new Slice(content, 0, 0).toJSON(),
    },
  ];
}

/** Edge-band autoscroll: how far a scrollable list should move this
 *  frame for a pointer at `pointerY` over `rect`. Zero outside the top
 *  and bottom bands; inside a band the step grows linearly toward the
 *  edge (up to `maxStep` px), negative = scroll up. Pure, for tests. */
export function edgeAutoscrollStep(
  pointerY: number,
  rect: { top: number; bottom: number },
  band = AUTOSCROLL_BAND_PX,
  maxStep = AUTOSCROLL_MAX_STEP_PX,
): number {
  if (rect.bottom - rect.top <= band * 2) return 0; // too short to have distinct bands
  if (pointerY < rect.top || pointerY > rect.bottom) return 0;
  const fromTop = pointerY - rect.top;
  const fromBottom = rect.bottom - pointerY;
  if (fromTop < band) return -Math.ceil(((band - fromTop) / band) * maxStep);
  if (fromBottom < band) return Math.ceil(((band - fromBottom) / band) * maxStep);
  return 0;
}
const AUTOSCROLL_BAND_PX = 28;
const AUTOSCROLL_MAX_STEP_PX = 14;

export class SendPillController {
  private root!: HTMLDivElement;
  /** Drag autoscroll: the list under the pointer and the last pointer
   *  position, while the pointer sits in an edge band. The list is
   *  capped at 320px, so a long recipient list was unreachable past the
   *  first screenful during a drag — nothing scrolled (field report,
   *  2026-09-04). Driven from hitTest (every pointermove) and kept
   *  alive by a frame loop while the pointer rests in the band. */
  private autoscroll: { el: HTMLElement; x: number; y: number; timer: number | null } | null = null;
  private bar!: HTMLDivElement;
  private panel!: HTMLDivElement;
  private surface: DragSurface | null = null;
  private unregisterSurface: (() => void) | null = null;
  private unsubscribeSettings: (() => void) | null = null;
  private unsubscribeController: (() => void) | null = null;
  private expanded = false;
  /** Click-to-invite mode: the panel is open from a CLICK (not a drag), so
   *  each row shows a collaboration-invite button. A drag-to-send never
   *  reveals the buttons (the `pmd-send-invite-mode` class gates them). */
  private inviteMode = false;
  private onDocPointerDown: ((e: PointerEvent) => void) | null = null;
  /** Row element → resolved target, rebuilt with the partner/group list. */
  private targets = new Map<HTMLElement, SendTarget>();
  /** The always-rendered bottom actions row (click buttons / drag zones). */
  private addContactEl: HTMLButtonElement | null = null;
  private startSessionEl: HTMLButtonElement | null = null;
  /** Drag-only recent-senders sub-list + its rows (subset of targets). */
  private recentSection: HTMLDivElement | null = null;
  private recentRows = new Set<HTMLElement>();

  mount(opts: SendPillMountOptions): void {
    this.root = document.createElement('div');
    this.root.className = 'pmd-pill pmd-send-pill';
    this.root.dataset['open'] = 'false';

    this.panel = document.createElement('div');
    this.panel.className = 'pmd-send-panel';
    this.root.appendChild(this.panel);

    this.bar = document.createElement('div');
    this.bar.className = 'pmd-pill-bar pmd-send-bar';
    this.bar.title = 'Drag a card here to send it';
    const icon = document.createElement('span');
    icon.className = 'pmd-pill-icon';
    icon.setAttribute('aria-hidden', 'true');
    // Paper-plane glyph.
    icon.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg>';
    this.bar.appendChild(icon);
    const labelEl = document.createElement('span');
    labelEl.className = 'pmd-pill-label';
    labelEl.textContent = 'Send';
    this.bar.appendChild(labelEl);
    this.root.appendChild(this.bar);

    // Click-to-invite (collab sessions): the same partner/group rows,
    // but a click on one sends a session invite — starting a session on
    // the current doc first when none is active. Only offered while the
    // collab gate is open; otherwise the pill stays drag-only.
    this.bar.addEventListener('click', () => {
      if (!settings.get('pairingEnabled')) return;
      if (this.inviteMode) this.collapse();
      else this.openInviteMode();
    });

    opts.parent.appendChild(this.root);

    this.surface = {
      hitTest: (clientX, clientY) => {
        if (!settings.get('pairingEnabled')) return null;
        // Active zone = just the bar when collapsed; once expanded, the
        // UNION of the bar and the (above, wider) panel so the pointer can
        // travel from the bar up into the partner list without falling into
        // the gap between them — which would otherwise collapse the pill.
        const barRect = this.bar.getBoundingClientRect();
        let inside = pointInRect(barRect, clientX, clientY);
        if (!inside && this.expanded) {
          inside = pointInRect(unionRect(barRect, this.panel.getBoundingClientRect()), clientX, clientY);
          // The recent-senders flyout hangs OFF the panel's right edge —
          // count it (and the gap to it) while it's shown, or crossing
          // into it would leave the surface and collapse the pill.
          if (!inside && this.recentSection && !this.recentSection.hidden) {
            inside = pointInRect(
              unionRect(this.panel.getBoundingClientRect(), this.recentSection.getBoundingClientRect()),
              clientX,
              clientY,
            );
          }
        }
        if (!inside) return null;
        this.updateAutoscroll(clientX, clientY);
        // Hovering the pill: it becomes the winning surface (dy 0). Once
        // expanded, resolve which target row the pointer is over.
        if (this.expanded) {
          const targetEl = this.targetRowAt(clientX, clientY);
          if (targetEl) {
            const target = this.targets.get(targetEl);
            if (target) {
              return {
                el: targetEl,
                insertPos: 0,
                dy: 0,
                absorb: (items) => this.sendItems(items, target),
              };
            }
          }
          // The actions row doubles as the drag zones (same footprints
          // as the click buttons). Send-by-code captures the slices at
          // drop time, THEN prompts — the doc can change while the
          // prompt is open.
          if (
            this.addContactEl &&
            pointInRect(this.addContactEl.getBoundingClientRect(), clientX, clientY)
          ) {
            return {
              el: this.addContactEl,
              insertPos: 0,
              dy: 0,
              absorb: (items) => {
                const captured = this.captureSendItems(items);
                if (captured.length > 0) void this.sendItemsByCode(captured);
              },
            };
          }
          if (
            this.startSessionEl &&
            !this.startSessionEl.classList.contains('pmd-send-action-collab-hidden') &&
            pointInRect(this.startSessionEl.getBoundingClientRect(), clientX, clientY)
          ) {
            // Hovering reveals the recent-senders list (handled in
            // highlight); dropping ON the zone itself is a no-op — the
            // drop belongs on one of the revealed rows.
            return { el: this.startSessionEl, insertPos: 0, dy: 0, absorb: () => {} };
          }
        }
        // Over the pill but not on a partner/group row (bar, gap, padding):
        // a no-op absorb so releasing here just closes the pill instead of
        // falling through to the controller's "insert into the doc" path.
        return { el: this.bar, insertPos: 0, dy: 0, absorb: () => {} };
      },
      highlight: (el) => {
        if (el === null) {
          this.collapse();
          return;
        }
        this.expand();
        this.clearRowHighlight();
        // Sticky reveal: hovering the zone (or any flyout row) shows the
        // flyout; crossing bar/gap space on the way over KEEPS it shown
        // (the old hide-on-anything-else made it vanish the moment the
        // pointer left the button). It hides only when the drag settles
        // on a real other target — a partner/group row or the other
        // action zone — or when the pill collapses.
        const overRecent =
          el === this.startSessionEl || (el instanceof HTMLElement && this.recentRows.has(el));
        if (overRecent) this.setRecentVisible(true);
        else if (
          (el.classList.contains('pmd-send-target') && !this.recentRows.has(el)) ||
          el === this.addContactEl
        ) {
          this.setRecentVisible(false);
        }
        if (el.classList.contains('pmd-send-target')) {
          el.classList.add('pmd-send-target-hot');
          this.bar.classList.remove('pmd-send-bar-hot');
        } else if (el === this.addContactEl || el === this.startSessionEl) {
          el.classList.add('pmd-send-action-hot');
          this.bar.classList.remove('pmd-send-bar-hot');
        } else {
          this.bar.classList.add('pmd-send-bar-hot');
        }
      },
    };
    this.unregisterSurface = dragController.registerSurface(this.surface);

    // Tear down highlight + collapse when any drag ends (drop elsewhere,
    // cancel, etc.) — the controller doesn't clear surfaces itself.
    this.unsubscribeController = dragController.subscribe((event) => {
      if (event === 'end') this.collapse();
    });

    this.renderTargets();
    this.applyVisibility();
    this.unsubscribeSettings = settings.subscribe(() => {
      this.renderTargets();
      this.applyVisibility();
      this.applyClickAffordance();
    });
    this.applyClickAffordance();
  }

  /** Cursor + tooltip reflect whether clicking does anything. */
  private applyClickAffordance(): void {
    const clickable = settings.get('pairingEnabled');
    this.bar.classList.toggle('pmd-send-bar-clickable', clickable);
    const canInvite = collabEnabled() && collabInviter() !== null;
    this.bar.title = clickable
      ? canInvite
        ? 'Drag a card here to send it · Click for contacts and collaboration'
        : 'Drag a card here to send it · Click to add a contact'
      : 'Drag a card here to send it';
  }

  private openInviteMode(): void {
    this.inviteMode = true;
    this.expand();
    this.applyDragZoneLabels(false);
    // Reveals the per-row collaboration-invite buttons (CSS-gated on this
    // class), so they appear only on a click-open, never mid-drag.
    this.root.classList.add('pmd-send-invite-mode');
    // Outside click closes (capture so editor clicks count too).
    this.onDocPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && this.root.contains(e.target)) return;
      this.collapse();
    };
    document.addEventListener('pointerdown', this.onDocPointerDown, true);
  }

  unmount(): void {
    this.unregisterSurface?.();
    this.unsubscribeSettings?.();
    this.unsubscribeController?.();
    this.root.remove();
  }

  private applyVisibility(): void {
    this.root.hidden = !settings.get('pairingEnabled');
  }

  /** Rebuild the partner + group drop rows from settings. */
  private renderTargets(): void {
    this.panel.innerHTML = '';
    this.targets.clear();
    this.recentRows.clear();

    // Hidden recipients stay OUT of the pill (that is what hiding is)
    // but remain reachable elsewhere: group sends still fan out to
    // them, and a hidden starred partner keeps its quick-send
    // shortcut — hiding is about pill clutter, not reachability.
    const allPartners = settings.get('pairingPartners').filter((p) => p.code);
    const partners = allPartners.filter((p) => !p.hidden);
    const groups = settings
      .get('pairingGroups')
      .filter((g) => g.memberCodes.some((c) => allPartners.some((p) => p.code === c)));

    if (partners.length === 0 && groups.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'pmd-send-empty';
      hint.textContent = 'Add a recipient in Settings → Collaboration.';
      this.panel.appendChild(hint);
    }

    if (groups.length > 0) {
      this.panel.appendChild(this.sectionLabel('Groups'));
      for (const g of groups) {
        const row = this.groupRow(g, allPartners);
        this.addInviteButton(row);
        this.panel.appendChild(row);
      }
    }
    if (partners.length > 0) {
      this.panel.appendChild(this.sectionLabel('To'));
      for (const p of partners) {
        const row = this.targetRow(p.name || p.code, [p.code], p.name || p.code);
        this.addInviteButton(row);
        this.panel.appendChild(row);
      }
    }

    // Recent-senders FLYOUT for the drag flow: a separate area to the
    // RIGHT of the panel, revealed while the drag hovers its zone.
    // Lives on the root, not in the panel — the panel is a scroll
    // container and would clip an absolutely-positioned child. Rows
    // are ordinary drop targets.
    this.recentSection?.remove();
    this.recentSection = document.createElement('div');
    this.recentSection.className = 'pmd-send-recent-flyout';
    this.recentSection.hidden = true;
    const blocked = new Set(
      settings.get('pairingBlockedCodes').map((c) => normalizePairingCode(c)),
    );
    for (const r of recentSenders()) {
      const code = normalizePairingCode(r.code);
      if (!code || blocked.has(code)) continue;
      const known = allPartners.find((p) => normalizePairingCode(p.code) === code);
      const label = known?.name?.trim() || (r.name || '').trim() || `…${code.slice(-6)}`;
      const row = this.targetRow(label, [r.code], label);
      row.classList.add('pmd-send-recent-row');
      this.recentRows.add(row);
      this.recentSection.appendChild(row);
    }
    this.root.appendChild(this.recentSection);

    // The actions row — the pill's own bottom row, in BOTH modes: on a
    // click-open these are buttons (add a contact / start a session);
    // during a drag the same two footprints are drop zones (send by
    // code / send to a recent sender), so the two modalities stay
    // spatially consistent.
    const actions = document.createElement('div');
    actions.className = 'pmd-send-actions';
    this.addContactEl = this.actionButton(
      ADD_CONTACT_ICON,
      'Add contact',
      'Add a contact by pairing code',
      () => {
        this.collapse();
        void this.addContactFlow();
      },
    );
    actions.appendChild(this.addContactEl);
    const canInvite = collabEnabled() && collabSessionStarter() !== null;
    this.startSessionEl = this.actionButton(
      COLLAB_INVITE_ICON,
      'Start session',
      'Start a collaboration session on this document',
      () => {
        this.collapse();
        // Decided at CLICK time, matching whatever the label showed:
        // a live session on the focused doc means the useful action is
        // handing out its code, not a "this doc is already in a
        // session" dead end.
        const live = collabActiveShareCode();
        if (live !== null) {
          void navigator.clipboard?.writeText(live).then(
            () => showToast('Session code copied — paste it to a teammate'),
            () => showToast('Could not copy the session code'),
          );
          return;
        }
        collabSessionStarter()?.();
      },
    );
    this.startSessionEl.classList.toggle('pmd-send-action-collab-hidden', !canInvite);
    this.refreshSessionAction();
    actions.appendChild(this.startSessionEl);
    this.panel.appendChild(actions);
  }

  /** Label the session action for the CURRENT focus: "Copy session
   *  code" when the focused doc has a live session, "Start session"
   *  otherwise. Called at build, click-open, and drag-end — the only
   *  moments the button is (about to be) visible. */
  private refreshSessionAction(): void {
    if (!this.startSessionEl) return;
    const live = collabActiveShareCode() !== null;
    (this.startSessionEl.lastChild as HTMLElement).textContent = live
      ? 'Copy code'
      : 'Start session';
    this.startSessionEl.title = live
      ? 'Copy this session’s share code for a teammate to join'
      : 'Start a collaboration session on this document';
  }

  /** One action-row entry: icon + label. Click behavior is live only in
   *  invite mode (the drag flow reuses the same element as a zone). */
  private actionButton(
    iconSvg: string,
    label: string,
    title: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-send-action';
    btn.title = title;
    const icon = document.createElement('span');
    icon.className = 'pmd-send-action-icon';
    icon.innerHTML = iconSvg;
    btn.appendChild(icon);
    const text = document.createElement('span');
    text.textContent = label;
    btn.appendChild(text);
    btn.addEventListener('click', (e) => {
      if (!this.inviteMode) return; // drag mode: the element is a drop zone
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  /** Click-mode Add contact: ask for a pairing code, then a name
   *  (pre-filled from the recent-senders ledger when the code has
   *  shared with us before), and append to the BOTTOM of the saved
   *  recipients. */
  private async addContactFlow(): Promise<void> {
    const raw = await promptForText({
      message: 'Add a contact',
      detail: 'Paste the pairing code they shared with you (cmk1.…).',
      placeholder: 'cmk1.…',
    });
    if (raw == null) return;
    const code = normalizePairingCode(raw);
    if (!looksLikePairingCode(code)) {
      showToast('That does not look like a pairing code');
      return;
    }
    const cur = settings.get('pairingPartners');
    if (cur.some((p) => normalizePairingCode(p.code) === code)) {
      showToast('Already in your recipients');
      return;
    }
    // Name them now (same flow as the settings Recent-senders Add…):
    // pre-filled from the ledger when they've shared with us before.
    // Cancel aborts the whole add; an emptied field adds them unnamed.
    const known = recentSenders().find((r) => normalizePairingCode(r.code) === code);
    const nameFor = await promptForText({
      message: 'Name this contact',
      detail: 'Shown in the Send pill and on cards you receive from them.',
      initial: (known?.name || '').trim(),
      placeholder: 'Name',
      okLabel: 'Add',
    });
    if (nameFor == null) return;
    const name = nameFor.trim();
    settings.set('pairingPartners', [...cur, { code, name }]);
    showToast(`Added ${name || `…${code.slice(-6)}`} to recipients`);
  }

  /** Drag-drop on "send by code": capture the slices FIRST (the doc can
   *  change while the prompt is open), then ask for the code and send —
   *  a one-off send, no contact saved. */
  private async sendItemsByCode(items: SendItem[]): Promise<void> {
    const raw = await promptForText({
      message: 'Send by pairing code',
      detail: 'Paste the pairing code to send this to (cmk1.…). One-off — this does not save a contact.',
      placeholder: 'cmk1.…',
    });
    if (raw == null) return;
    const code = normalizePairingCode(raw);
    if (!looksLikePairingCode(code)) {
      showToast('That does not look like a pairing code');
      return;
    }
    let ok = 0;
    let fail = 0;
    let authFail = 0;
    for (const si of items) {
      const res = await relayClient.send([code], si);
      ok += res.ok;
      fail += res.fail;
      authFail += res.authFail;
    }
    showToast(sendOutcomeToast(`…${code.slice(-6)}`, { ok, fail, authFail }));
  }

  /** Append the per-contact "invite to collaborate" button. Hidden by CSS
   *  until the pill is opened by a click (invite mode); clicking it starts a
   *  session on the current doc (if none) and invites that recipient/group. */
  private addInviteButton(row: HTMLElement): void {
    const target = this.targets.get(row);
    if (!target) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-send-invite-btn';
    btn.title = 'Invite to collaborate';
    btn.setAttribute('aria-label', 'Invite to collaborate');
    btn.innerHTML = COLLAB_INVITE_ICON;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.collapse();
      collabInviter()?.({ codes: target.codes, label: target.label, via: target.via });
    });
    row.appendChild(btn);
  }

  private sectionLabel(text: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'pmd-send-section';
    el.textContent = text;
    return el;
  }

  private groupRow(
    group: PairingGroup,
    partners: { code: string; name: string }[],
  ): HTMLElement {
    const codes = group.memberCodes.filter((c) => partners.some((p) => p.code === c));
    const row = this.targetRow(group.label || 'Group', codes, group.label || 'Group', group.label);
    const count = document.createElement('span');
    count.className = 'pmd-send-target-count';
    count.textContent = `${codes.length}`;
    count.title = `${codes.length} recipient${codes.length === 1 ? '' : 's'}`;
    row.appendChild(count);
    row.classList.add('pmd-send-target-group');
    return row;
  }

  private targetRow(label: string, codes: string[], toastLabel: string, via?: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'pmd-send-target';
    const name = document.createElement('span');
    name.className = 'pmd-send-target-name';
    name.textContent = label;
    name.title = label;
    row.appendChild(name);
    this.targets.set(row, { codes, label: toastLabel, via });
    return row;
  }

  private targetRowAt(x: number, y: number): HTMLElement | null {
    for (const el of this.targets.keys()) {
      if (pointInRect(el.getBoundingClientRect(), x, y)) return el;
    }
    return null;
  }

  private clearRowHighlight(): void {
    this.bar.classList.remove('pmd-send-bar-hot');
    for (const el of this.targets.keys()) el.classList.remove('pmd-send-target-hot');
    this.addContactEl?.classList.remove('pmd-send-action-hot');
    this.startSessionEl?.classList.remove('pmd-send-action-hot');
  }

  private setRecentVisible(visible: boolean): void {
    if (!this.recentSection) return;
    if (visible && this.recentSection.hidden) {
      // Anchor to the panel's live geometry: right edge + a small gap,
      // bottoms aligned. Root-relative coordinates (both are absolutely
      // positioned children of the root).
      const rootRect = this.root.getBoundingClientRect();
      const panelRect = this.panel.getBoundingClientRect();
      this.recentSection.style.left = `${panelRect.right - rootRect.left + 6}px`;
      this.recentSection.style.bottom = `${rootRect.bottom - panelRect.bottom}px`;
    }
    this.recentSection.hidden = !visible;
  }

  /** In drag mode the two action footprints change meaning: the left
   *  zone sends by code, the right reveals recent senders. Swap their
   *  labels/tooltips while a drag is live so the zone says what a drop
   *  does. */
  private applyDragZoneLabels(drag: boolean): void {
    if (this.addContactEl) {
      (this.addContactEl.lastChild as HTMLElement).textContent = drag ? 'Send by code' : 'Add contact';
      this.addContactEl.title = drag
        ? 'Drop here to send by pairing code (one-off)'
        : 'Add a contact by pairing code';
    }
    if (this.startSessionEl) {
      if (drag) {
        (this.startSessionEl.lastChild as HTMLElement).textContent = 'Recent senders';
        this.startSessionEl.title = 'Hover to pick someone who recently sent to you';
      } else {
        // Restore the session-aware label, not a hardcoded one.
        this.refreshSessionAction();
      }
      const icon = this.startSessionEl.firstChild as HTMLElement;
      icon.innerHTML = drag ? RECENT_ICON : COLLAB_INVITE_ICON;
    }
  }

  /** Start, retarget, or stop the edge-band autoscroll for the pointer
   *  at (x, y): the recent-senders flyout when the pointer is over it,
   *  else the panel. Called from hitTest; the frame loop re-runs the
   *  controller's hit test after every step so the highlighted row
   *  follows the content moving under a stationary pointer. */
  private updateAutoscroll(x: number, y: number): void {
    if (!this.expanded) {
      this.stopAutoscroll();
      return;
    }
    let el: HTMLElement | null = null;
    if (this.recentSection && !this.recentSection.hidden && pointInRect(this.recentSection.getBoundingClientRect(), x, y)) {
      el = this.recentSection;
    } else if (pointInRect(this.panel.getBoundingClientRect(), x, y)) {
      el = this.panel;
    }
    if (!el || edgeAutoscrollStep(y, el.getBoundingClientRect()) === 0) {
      this.stopAutoscroll();
      return;
    }
    if (this.autoscroll && this.autoscroll.el === el) {
      this.autoscroll.x = x;
      this.autoscroll.y = y;
      return;
    }
    this.stopAutoscroll();
    this.autoscroll = { el, x, y, timer: null };
    this.scheduleAutoscrollFrame();
  }

  private scheduleAutoscrollFrame(): void {
    const state = this.autoscroll;
    if (!state) return;
    const raf: (cb: () => void) => number =
      typeof requestAnimationFrame === 'function'
        ? (cb) => requestAnimationFrame(cb)
        : (cb) => setTimeout(cb, 16) as unknown as number;
    state.timer = raf(() => {
      state.timer = null;
      if (this.autoscroll !== state || !this.expanded) return;
      const step = edgeAutoscrollStep(state.y, state.el.getBoundingClientRect());
      const before = state.el.scrollTop;
      const max = Math.max(0, state.el.scrollHeight - state.el.clientHeight);
      const next = Math.min(max, Math.max(0, before + step));
      if (step === 0 || next === before) {
        this.stopAutoscroll();
        return;
      }
      state.el.scrollTop = next;
      // Content moved under a resting pointer: re-resolve the hovered row.
      dragController.dispatchHit(state.x, state.y);
      if (this.autoscroll === state) this.scheduleAutoscrollFrame();
    });
  }

  private stopAutoscroll(): void {
    const state = this.autoscroll;
    if (!state) return;
    this.autoscroll = null;
    if (state.timer !== null) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(state.timer);
      clearTimeout(state.timer);
    }
  }

  private expand(): void {
    if (this.expanded) return;
    this.expanded = true;
    this.root.dataset['open'] = 'true';
    // Expanded by a drag (not a click): the actions row is in zone mode.
    if (!this.inviteMode) this.applyDragZoneLabels(true);
  }

  private collapse(): void {
    if (this.inviteMode) {
      this.inviteMode = false;
      this.root.classList.remove('pmd-send-invite-mode');
      if (this.onDocPointerDown) {
        document.removeEventListener('pointerdown', this.onDocPointerDown, true);
        this.onDocPointerDown = null;
      }
    }
    if (!this.expanded) {
      this.clearRowHighlight();
      return;
    }
    this.expanded = false;
    this.root.dataset['open'] = 'false';
    this.stopAutoscroll();
    this.clearRowHighlight();
    this.setRecentVisible(false);
    this.applyDragZoneLabels(false);
  }

  /** Resolve dragged items to wire-ready SendItems NOW (positions go
   *  stale the moment the drag session ends or the doc changes). A
   *  multi-item drag BUNDLES into one SendItem — see bundleSendItems. */
  private captureSendItems(items: DragItem[]): SendItem[] {
    const session = dragController.getSession();
    if (!session) return [];
    const srcView: EditorView = session.view;
    const captured: CapturedItem[] = [];
    for (const item of items) {
      let slice: Slice;
      try {
        slice = item.prebuilt ?? srcView.state.doc.slice(item.from, item.to);
      } catch {
        continue;
      }
      const type = item.type || slice.content.firstChild?.type.name || 'text';
      const label = item.label || deriveDropzoneLabel(slice, type);
      captured.push({ slice, type, label });
    }
    return bundleSendItems(captured);
  }

  /** Resolve each dragged item to a SendItem and push to the target. */
  private async sendItems(items: DragItem[], target: SendTarget): Promise<void> {
    if (target.codes.length === 0) {
      showToast('That group has no recipients yet');
      return;
    }
    const sendItems = this.captureSendItems(items);
    if (sendItems.length === 0) return;

    let ok = 0;
    let fail = 0;
    let authFail = 0;
    for (const si of sendItems) {
      const res = await relayClient.send(target.codes, si, { via: target.via });
      ok += res.ok;
      fail += res.fail;
      authFail += res.authFail;
    }
    showToast(sendOutcomeToast(target.label, { ok, fail, authFail }));
  }
}
