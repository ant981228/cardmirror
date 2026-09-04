/**
 * "Send to Recipient" — the keyboard sibling of Send to Starred: the same
 * source (the cursor's enclosing card, or the active selection), but the
 * target is picked from a list of your contacts and groups instead of the
 * single starred one. Unbound by default; command bar / custom key.
 *
 * The list is the full contact list — hidden recipients too, at the end —
 * because hiding is about Send-pill clutter, not reachability (see
 * PairingPartner.hidden). The picker opens FIRST and the slice is taken
 * after a choice, so cancelling touches nothing.
 */

import type { EditorView } from 'prosemirror-view';
import { settings, type PairingPartner, type PairingGroup } from '../settings.js';
import { captureFocusForDialog, installModalKeys, armDialogFocus } from '../text-prompt.js';
import { pushOverlay, popOverlay } from '../overlay-stack.js';
import { setIcon } from '../icons';
import { showToast } from '../toast.js';
import { resolveStarredTarget, sendViewTo } from './send-to-starred.js';

export interface RecipientChoice {
  kind: 'partner' | 'group';
  ref: string;
  label: string;
  /** Second line: the pairing code, a hidden marker, or a member count. */
  sub: string;
  hidden: boolean;
}

/** The picker's rows, in display order: visible contacts (list order),
 *  then groups, then hidden contacts. Contacts without a code are
 *  skipped (they can't be sent to). Pure, for tests. */
export function listRecipientChoices(
  partners: readonly PairingPartner[],
  groups: readonly PairingGroup[],
): RecipientChoice[] {
  const known = partners.filter((p) => p.code);
  const partnerRow = (p: PairingPartner): RecipientChoice => ({
    kind: 'partner',
    ref: p.code,
    label: p.name || p.code,
    sub: p.hidden ? 'Hidden from the Send pill' : p.name ? p.code : '',
    hidden: !!p.hidden,
  });
  const visible = known.filter((p) => !p.hidden).map(partnerRow);
  const hidden = known.filter((p) => p.hidden).map(partnerRow);
  const groupRows: RecipientChoice[] = groups.map((g) => {
    const members = g.memberCodes.filter((c) => known.some((p) => p.code === c)).length;
    return {
      kind: 'group',
      ref: g.id,
      label: g.label || 'Group',
      sub: `Group · ${members} recipient${members === 1 ? '' : 's'}`,
      hidden: false,
    };
  });
  return [...visible, ...groupRows, ...hidden];
}

/** Modal list of contacts and groups (the Select Speech Doc dialog's
 *  look, via the shared list-pick classes). Resolves to the chosen row,
 *  or null on Escape / overlay click / close. */
export function pickRecipient(choices: RecipientChoice[]): Promise<RecipientChoice | null> {
  return new Promise((resolve) => {
    const restoreFocus = captureFocusForDialog();
    const token = pushOverlay();
    let settled = false;
    const overlay = document.createElement('div');
    overlay.className = 'pmd-list-pick-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'pmd-list-pick-dialog';
    overlay.appendChild(dialog);

    const finish = (choice: RecipientChoice | null): void => {
      if (settled) return;
      settled = true;
      removeKeys();
      overlay.remove();
      popOverlay(token);
      restoreFocus();
      resolve(choice);
    };
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(null);
    });

    const header = document.createElement('header');
    header.className = 'pmd-list-pick-header';
    const title = document.createElement('h2');
    title.textContent = 'Send to Recipient';
    header.appendChild(title);
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'pmd-list-pick-close';
    setIcon(closeBtn, 'close');
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', () => finish(null));
    header.appendChild(closeBtn);
    dialog.appendChild(header);

    const intro = document.createElement('p');
    intro.className = 'pmd-list-pick-intro';
    intro.textContent = 'Send the current card (or selection) to:';
    dialog.appendChild(intro);

    // Type-to-filter when the list is long enough to need it.
    const filter = document.createElement('input');
    filter.type = 'search';
    filter.className = 'pmd-list-pick-filter';
    filter.placeholder = 'Filter…';
    filter.setAttribute('aria-label', 'Filter recipients');
    if (choices.length > 6) dialog.appendChild(filter);

    const list = document.createElement('div');
    list.className = 'pmd-list-pick-list';
    dialog.appendChild(list);
    const rows: Array<{ el: HTMLButtonElement; choice: RecipientChoice }> = [];
    if (choices.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'pmd-list-pick-empty';
      empty.textContent = 'No contacts yet — add one from the Send pill or Settings → Collaboration.';
      list.appendChild(empty);
    }
    for (const choice of choices) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'pmd-list-pick-row';
      if (choice.hidden) row.classList.add('pmd-list-pick-row-muted');
      const text = document.createElement('span');
      text.className = 'pmd-list-pick-row-text';
      const name = document.createElement('span');
      name.className = 'pmd-list-pick-row-name';
      name.textContent = choice.label;
      text.appendChild(name);
      if (choice.sub) {
        const sub = document.createElement('span');
        sub.className = 'pmd-list-pick-row-sub';
        sub.textContent = choice.sub;
        text.appendChild(sub);
      }
      row.appendChild(text);
      row.addEventListener('click', () => finish(choice));
      list.appendChild(row);
      rows.push({ el: row, choice });
    }
    const applyFilter = (): void => {
      const q = filter.value.trim().toLowerCase();
      for (const r of rows) {
        r.el.hidden = q.length > 0 && !r.choice.label.toLowerCase().includes(q) && !r.choice.sub.toLowerCase().includes(q);
      }
    };
    filter.addEventListener('input', applyFilter);

    const removeKeys = installModalKeys(dialog, token, (e) => {
      if (e.key === 'Escape') {
        finish(null);
        return true;
      }
      if (e.key === 'Enter' && document.activeElement === filter) {
        const first = rows.find((r) => !r.el.hidden);
        if (first) finish(first.choice);
        return true;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const visible = rows.filter((r) => !r.el.hidden).map((r) => r.el);
        if (visible.length === 0) return true;
        const i = visible.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === 'ArrowDown' ? (i + 1) % visible.length : (i - 1 + visible.length) % visible.length;
        visible[next]!.focus();
        return true;
      }
      return false;
    });
    document.body.appendChild(overlay);
    armDialogFocus(dialog, 'dialog', 'Send to Recipient');
    (filter.isConnected ? filter : rows[0]?.el)?.focus();
  });
}

/** Ask which contact or group to send to, then send the cursor's card /
 *  active selection there. Toasts when sharing is off or nothing is
 *  configured; cancelling does nothing. */
export async function sendViewToRecipient(view: EditorView): Promise<void> {
  if (!settings.get('pairingEnabled')) {
    showToast('Card sharing is off');
    return;
  }
  const choices = listRecipientChoices(settings.get('pairingPartners'), settings.get('pairingGroups'));
  const choice = await pickRecipient(choices);
  if (!choice) return;
  const target = resolveStarredTarget(
    { kind: choice.kind, ref: choice.ref },
    settings.get('pairingPartners'),
    settings.get('pairingGroups'),
  );
  if (!target) {
    showToast('That recipient is no longer in your contacts');
    return;
  }
  await sendViewTo(view, target);
}
