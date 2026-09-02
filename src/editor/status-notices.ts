/**
 * Status-bar notices — the persistent home for errors and
 * diagnostics (toast audit §3B, shape per user decision 2026-08-17:
 * nothing may float over the page, so the durable surface is a
 * STATUS-BAR CHIP, not a corner card stack).
 *
 * A toast is a 1–8s tooltip at the cursor: fine for confirmations,
 * information-loss for anything the user may need to re-read, act
 * on, or copy into a bug report. `postNotice` keeps the immediate
 * toast (so nothing gets LESS visible than before) and additionally
 * files the message under the ⚠ chip in the status bar, where it
 * stays until dismissed — readable, copyable, and out of the page.
 *
 * Repeats coalesce by `key`: the save-heal tripwire fires on every
 * journal write while a wound is open (~1/min toast heartbeat in the
 * field) — with a key it becomes ONE chip entry with a ×N counter,
 * and only the first occurrence toasts.
 */

import { showToast } from './toast.js';
import { writeClipboardText } from './clipboard-write.js';

export type NoticeSeverity = 'error' | 'warning' | 'info';

export interface NoticeInput {
  severity: NoticeSeverity;
  title: string;
  body: string;
  /** Coalescing key: repeats increment ×N instead of stacking. */
  key?: string;
  /** Companion toast (default true; repeats never toast). */
  toast?: boolean;
}

interface Notice {
  id: number;
  key: string | null;
  severity: NoticeSeverity;
  title: string;
  body: string;
  count: number;
  lastAt: number;
}

const MAX_NOTICES = 50;
let notices: Notice[] = [];
let nextId = 1;
let chip: HTMLButtonElement | null = null;
let panel: HTMLElement | null = null;

export function noticeCount(): number {
  return notices.length;
}

export function postNotice(input: NoticeInput): void {
  const existing = input.key ? notices.find((n) => n.key === input.key) : undefined;
  if (existing) {
    existing.count++;
    existing.lastAt = Date.now();
    existing.body = input.body;
    existing.severity = input.severity;
    notices = [existing, ...notices.filter((n) => n !== existing)];
    // A repeat never toasts — this is what turns the save-heal
    // heartbeat into a counter instead of a once-a-minute nag.
  } else {
    notices.unshift({
      id: nextId++,
      key: input.key ?? null,
      severity: input.severity,
      title: input.title,
      body: input.body,
      count: 1,
      lastAt: Date.now(),
    });
    if (notices.length > MAX_NOTICES) notices.length = MAX_NOTICES;
    if (input.toast !== false) showToast(input.body);
  }
  render();
}

/** Remove a keyed notice (a condition that resolved itself — e.g. a
 *  session reconnected). No-op when absent. */
export function clearNotice(key: string): void {
  const before = notices.length;
  notices = notices.filter((n) => n.key !== key);
  if (notices.length !== before) render();
}

function dismiss(id: number): void {
  notices = notices.filter((n) => n.id !== id);
  render();
}

function dismissAll(): void {
  notices = [];
  render();
}

/** Test hook: reset module state between cases. */
export function __resetNoticesForTests(): void {
  notices = [];
  closePanel();
  render();
}

// ── Chip + panel ─────────────────────────────────────────────────────

export function wireStatusNotices(): void {
  chip = document.getElementById('notice-chip') as HTMLButtonElement | null;
  if (!chip) return;
  chip.addEventListener('click', () => {
    if (panel) closePanel();
    else openPanel();
  });
  render();
}

function render(): void {
  if (!chip) return;
  if (notices.length === 0) {
    chip.hidden = true;
    closePanel();
    return;
  }
  chip.hidden = false;
  // Three display tiers by the WORST message present (user decision):
  // grey/low-key for status updates, yellow for act-on, red critical.
  const worst = notices.some((n) => n.severity === 'error')
    ? 'error'
    : notices.some((n) => n.severity === 'warning')
      ? 'warning'
      : 'info';
  chip.dataset['severity'] = worst;
  chip.textContent = `${worst === 'info' ? 'ⓘ' : '⚠'} ${notices.length}`;
  chip.title = 'Notices — click to review';
  if (panel) renderPanel();
}

const onDocMouseDown = (e: MouseEvent): void => {
  if (!panel) return;
  const t = e.target as Node;
  if (panel.contains(t) || chip?.contains(t)) return;
  closePanel();
};
const onKeyDown = (e: KeyboardEvent): void => {
  if (e.key === 'Escape' && panel) {
    e.preventDefault();
    closePanel();
  }
};

function openPanel(): void {
  if (panel || notices.length === 0) return;
  panel = document.createElement('div');
  panel.className = 'pmd-notice-panel';
  document.body.appendChild(panel);
  renderPanel();
  window.addEventListener('mousedown', onDocMouseDown, { capture: true });
  window.addEventListener('keydown', onKeyDown, { capture: true });
}

function closePanel(): void {
  if (!panel) return;
  panel.remove();
  panel = null;
  window.removeEventListener('mousedown', onDocMouseDown, { capture: true });
  window.removeEventListener('keydown', onKeyDown, { capture: true });
}

const BODY_CLAMP = 280;

function renderPanel(): void {
  if (!panel) return;
  panel.replaceChildren();

  const header = document.createElement('div');
  header.className = 'pmd-notice-header';
  const title = document.createElement('span');
  title.textContent = 'Notices';
  header.appendChild(title);
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'pmd-settings-btn';
  clearBtn.textContent = 'Dismiss all';
  clearBtn.addEventListener('click', dismissAll);
  header.appendChild(clearBtn);
  panel.appendChild(header);

  const list = document.createElement('div');
  list.className = 'pmd-notice-list';
  for (const n of notices) {
    const row = document.createElement('div');
    row.className = `pmd-notice pmd-notice-${n.severity}`;

    const top = document.createElement('div');
    top.className = 'pmd-notice-top';
    const t = document.createElement('span');
    t.className = 'pmd-notice-title';
    t.textContent = n.title;
    top.appendChild(t);
    const meta = document.createElement('span');
    meta.className = 'pmd-notice-meta';
    const time = new Date(n.lastAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    meta.textContent = n.count > 1 ? `×${n.count} · ${time}` : time;
    top.appendChild(meta);
    row.appendChild(top);

    const body = document.createElement('div');
    body.className = 'pmd-notice-body';
    if (n.body.length > BODY_CLAMP) {
      body.textContent = n.body.slice(0, BODY_CLAMP) + '…';
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'pmd-notice-more';
      more.textContent = 'Show more';
      more.addEventListener('click', () => {
        body.textContent = n.body;
      });
      row.appendChild(body);
      row.appendChild(more);
    } else {
      body.textContent = n.body;
      row.appendChild(body);
    }

    const actions = document.createElement('div');
    actions.className = 'pmd-notice-actions';
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'pmd-settings-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      void writeClipboardText(`${n.title}\n${n.body}`).then((ok) =>
        showToast(ok ? 'Copied.' : 'Copy failed.'),
      );
    });
    actions.appendChild(copyBtn);
    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'pmd-settings-btn';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.addEventListener('click', () => dismiss(n.id));
    actions.appendChild(dismissBtn);
    row.appendChild(actions);

    list.appendChild(row);
  }
  panel.appendChild(list);
}
