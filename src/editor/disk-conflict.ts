/**
 * Disk-conflict state + the cloud badge (design brief 2026-09-06).
 *
 * Per open document (keyed by its on-disk handle) this tracks whether
 * the file lives in a cloud-synced folder and whether main's stat-only
 * poller has seen it change under the editor. One badge per window
 * shows the ACTIVE document's state, anchored beside the filename chip
 * in the ribbon:
 *
 *   local      — not rendered (no cloud provider);
 *   synced     — neutral cloud glyph, "as of last sync" (we know the
 *                local disk, not the cloud); click reveals the file;
 *   changed    — amber + relative time; click opens the decision
 *                dialog (Reload / Keep mine as a copy / Overwrite);
 *   kept-copy  — the window is editing a conflicted copy; click
 *                offers the original.
 *
 * Nothing here ever toasts, steals focus, or animates on a state
 * transition — a conflict must never interrupt a speech. While read
 * mode or the timer pop-out is active the badge is frozen at its last
 * rendering and catches up when both clear. `changed` is cleared only
 * by a Reload or by an in-place save that main accepted (which means
 * the disk was byte-identical after all); a keep-both save moves the
 * window to the copy, whose state starts as `kept-copy`.
 */
import { promptForRouteChoice } from './text-prompt.js';
import { postNotice } from './status-notices.js';
import { settings } from './settings.js';
import type { CloudProvider } from './host/types.js';

export type DiskBadgeState = 'local' | 'synced' | 'changed' | 'kept-copy';
export type ClaimResult = 'fresh' | 'journaled' | 'changed' | 'unknown';

export interface DocDiskInfo {
  provider: CloudProvider | null;
  state: DiskBadgeState;
  /** When the poller (or registration) first saw the file differ. */
  changedAt: number | null;
  /** For `kept-copy`: the original file's path. */
  copyOf: string | null;
}

const byHandle = new Map<string, DocDiskInfo>();

const PROVIDER_LABEL: Record<CloudProvider, string> = {
  dropbox: 'Dropbox',
  onedrive: 'OneDrive',
  gdrive: 'Google Drive',
  icloud: 'iCloud Drive',
  other: 'a synced folder',
};

export function diskInfoFor(handle: unknown): DocDiskInfo | null {
  return typeof handle === 'string' ? (byHandle.get(handle) ?? null) : null;
}

/** A window registered `handle` as its open document. `claim` says how
 *  the changed-on-disk baseline was obtained (see doc-writes.ts):
 *  `changed` means the file already differs from the journaled baseline
 *  a recovered doc carried, so the badge starts amber. A `kept-copy`
 *  marked just before registration (the keep-both save) is preserved. */
export function noteDocRegistered(handle: string, claim: ClaimResult, provider: CloudProvider | null): void {
  const prev = byHandle.get(handle);
  if (prev?.state === 'kept-copy') {
    byHandle.set(handle, { ...prev, provider });
  } else {
    byHandle.set(handle, {
      provider,
      state: claim === 'changed' ? 'changed' : provider ? 'synced' : 'local',
      changedAt: claim === 'changed' ? Date.now() : null,
      copyOf: null,
    });
  }
  refreshDiskBadge();
}

/** Main's poller saw the file change on disk (stat-only: a sync
 *  client's timestamp touch shows up too; the save corrects it). */
export function noteDiskChanged(handle: string, at: number = Date.now()): void {
  const prev = byHandle.get(handle);
  if (!prev || prev.state === 'changed') return;
  byHandle.set(handle, { ...prev, state: 'changed', changedAt: at });
  refreshDiskBadge();
}

/** An in-place save main ACCEPTED: the disk matched the baseline (or
 *  was byte-identical), so a standing `changed` was a false alarm. */
export function noteSavedInPlace(handle: string): void {
  const prev = byHandle.get(handle);
  if (!prev || prev.state !== 'changed') return;
  byHandle.set(handle, { ...prev, state: prev.provider ? 'synced' : 'local', changedAt: null });
  refreshDiskBadge();
}

/** The window switched to a conflicted copy of `originalHandle`. */
export function noteKeptCopy(copyHandle: string, originalHandle: string): void {
  const orig = byHandle.get(originalHandle);
  byHandle.set(copyHandle, {
    provider: orig?.provider ?? null,
    state: 'kept-copy',
    changedAt: null,
    copyOf: originalHandle,
  });
  refreshDiskBadge();
}

/** Reload from disk replaced the in-memory doc with the file. */
export function noteReloaded(handle: string): void {
  const prev = byHandle.get(handle);
  if (!prev) return;
  byHandle.set(handle, { ...prev, state: prev.provider ? 'synced' : 'local', changedAt: null, copyOf: null });
  refreshDiskBadge();
}

export function noteDocReleased(handle: string): void {
  byHandle.delete(handle);
  refreshDiskBadge();
}

/** The name used in a conflicted copy's filename: the co-editing display
 *  name if set, else the comment author name (the default "You" does not
 *  count), else null — main falls back to the computer account username.
 *  Never anything from the Debate Decoded account. */
export function conflictedCopyUserName(): string | null {
  const pairing = settings.get('pairingDisplayName').trim();
  if (pairing) return pairing;
  const author = settings.get('commentAuthor').trim();
  if (author && author.toLowerCase() !== 'you') return author;
  return null;
}

/** Post the (non-interrupting) chip entry for a keep-both save. */
export function announceKeptCopy(copyName: string, originalName: string): void {
  postNotice({
    severity: 'warning',
    title: 'Saved as a conflicted copy',
    body:
      `Saved as "${copyName}" — "${originalName}" changed on disk while you were editing it. ` +
      `You are now editing the copy; the other version is untouched.`,
    key: `disk-conflict:${originalName}`,
  });
}

export function relativeTime(ms: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// ── Badge ───────────────────────────────────────────────────────────

export interface DiskBadgeDeps {
  /** The active document's handle + display name (either layout). */
  getActive: () => { handle: string | null; name: string | null };
  /** Read mode or the timer pop-out is active: freeze the badge. */
  isSuppressed: () => boolean;
  /** The active document hosts a live co-editing session — Reload is
   *  withheld (it would replace the shared document under everyone). */
  isSessionHost: (handle: string) => boolean;
  reveal: (handle: string) => void;
  /** Confirms unsaved edits itself, then replaces the doc from disk. */
  reloadFromDisk: (handle: string) => Promise<void>;
  keepMineAsCopy: (handle: string) => Promise<void>;
  /** Already double-confirmed by the badge; force-writes the disk. */
  overwrite: (handle: string) => Promise<void>;
  openOriginal: (originalHandle: string) => Promise<void>;
}

let badgeEl: HTMLButtonElement | null = null;
let badgeDeps: DiskBadgeDeps | null = null;
let clockTimer: number | null = null;

const CLOUD_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
  '<path fill="currentColor" d="M19.4 10.1A7 7 0 0 0 5.6 8.8 5 5 0 0 0 6 18.5h12.5a4.2 4.2 0 0 0 .9-8.4zM18.5 17H6a3.5 3.5 0 0 1-.3-7l.9-.1.2-.9a5.5 5.5 0 0 1 10.8 1.1v.9h1a2.7 2.7 0 0 1-.1 5.4z"/></svg>';

/** Create the badge next to `anchor` (the filename chip) once. */
export function installDiskBadge(anchor: HTMLElement, deps: DiskBadgeDeps): void {
  badgeDeps = deps;
  if (badgeEl) return;
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'pmd-disk-badge';
  el.hidden = true;
  el.setAttribute('aria-live', 'off');
  el.addEventListener('mousedown', (e) => e.preventDefault()); // keep the editor's focus
  el.addEventListener('click', () => void onBadgeClick());
  anchor.insertAdjacentElement('afterend', el);
  badgeEl = el;
  refreshDiskBadge();
}

function render(): void {
  if (!badgeEl || !badgeDeps) return;
  const { handle, name } = badgeDeps.getActive();
  const info = handle ? byHandle.get(handle) : null;
  if (!info || info.state === 'local') {
    badgeEl.hidden = true;
    badgeEl.removeAttribute('data-state');
    stopClock();
    return;
  }
  const provider = info.provider ? PROVIDER_LABEL[info.provider] : 'a synced folder';
  badgeEl.hidden = false;
  badgeEl.setAttribute('data-state', info.state);
  let label = '';
  let title = '';
  if (info.state === 'synced') {
    title = `In ${provider} · as of last sync. Click to reveal the file.`;
  } else if (info.state === 'changed') {
    const when = info.changedAt ? relativeTime(info.changedAt) : '';
    label = when ? `changed on disk ${when}` : 'changed on disk';
    title = `"${name ?? 'This document'}" changed on disk ${when} — another device or program wrote it. Click to decide.`;
  } else {
    label = 'conflicted copy';
    title = `You are editing a conflicted copy of "${info.copyOf ? baseName(info.copyOf) : name ?? 'the original'}". Click for the original.`;
  }
  badgeEl.innerHTML = `${CLOUD_SVG}${label ? `<span class="pmd-disk-badge-text">${escapeHtml(label)}</span>` : ''}`;
  badgeEl.title = title;
  badgeEl.setAttribute('aria-label', title);
  if (info.state === 'changed') startClock();
  else stopClock();
}

/** Re-render for the active document — unless suppressed (read mode /
 *  timer pop-out), in which case the badge keeps its last rendering
 *  and catches up on the next refresh after the suppression clears. */
export function refreshDiskBadge(): void {
  if (!badgeEl || !badgeDeps) return;
  if (badgeDeps.isSuppressed()) return;
  render();
}

function startClock(): void {
  if (clockTimer !== null) return;
  clockTimer = window.setInterval(() => refreshDiskBadge(), 30_000);
}
function stopClock(): void {
  if (clockTimer === null) return;
  window.clearInterval(clockTimer);
  clockTimer = null;
}

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

async function onBadgeClick(): Promise<void> {
  if (!badgeDeps) return;
  const { handle, name } = badgeDeps.getActive();
  if (!handle) return;
  const info = byHandle.get(handle);
  if (!info) return;
  if (info.state === 'synced') {
    badgeDeps.reveal(handle);
    return;
  }
  if (info.state === 'kept-copy') {
    const choice = await promptForRouteChoice<'original' | 'reveal'>({
      message: `You are editing a conflicted copy of "${info.copyOf ? baseName(info.copyOf) : name ?? 'the original'}".`,
      detail:
        'The other version is untouched. Merge by hand when you are ready; the two files are side by side in the folder.',
      choices: [
        { value: 'original', label: 'Open the original', description: 'In another window, alongside this copy.' },
        { value: 'reveal', label: 'Reveal in folder', description: 'Show both files in Finder / Explorer.' },
      ],
      cancelLabel: 'Close',
    });
    if (choice === 'original' && info.copyOf) await badgeDeps.openOriginal(info.copyOf);
    else if (choice === 'reveal') badgeDeps.reveal(handle);
    return;
  }
  // changed
  const host = badgeDeps.isSessionHost(handle);
  const when = info.changedAt ? relativeTime(info.changedAt) : 'recently';
  const choices: Array<{ value: 'reload' | 'keep' | 'overwrite'; label: string; description: string }> = [];
  if (!host) {
    choices.push({
      value: 'reload',
      label: 'Reload from disk',
      description: 'Take the other version. Your unsaved edits here are discarded (you will be asked).',
    });
  }
  choices.push({
    value: 'keep',
    label: 'Keep mine as a copy',
    description: 'Save your version beside it as a conflicted copy and keep editing the copy.',
  });
  choices.push({
    value: 'overwrite',
    label: 'Overwrite the file on disk',
    description: 'Replace the other version with yours. Asks once more.',
  });
  const choice = await promptForRouteChoice<'reload' | 'keep' | 'overwrite'>({
    message: `"${name ?? 'This document'}" changed on disk ${when}.`,
    detail:
      `Another device or program wrote the file while you were editing it${info.provider ? ` (it is in ${PROVIDER_LABEL[info.provider]})` : ''}.` +
      (host ? '\nReload is unavailable while you host a co-editing session — end the session first.' : ''),
    choices,
  });
  if (choice === 'reload') await badgeDeps.reloadFromDisk(handle);
  else if (choice === 'keep') await badgeDeps.keepMineAsCopy(handle);
  else if (choice === 'overwrite') {
    const sure = await promptForRouteChoice<'yes'>({
      message: `Overwrite "${name ?? 'the file'}" on disk?`,
      detail: 'The version another device wrote will be lost, and no conflicted copy is kept.',
      choices: [{ value: 'yes', label: 'Overwrite', description: 'Replace it with the version in this window.' }],
      cancelLabel: 'Keep both instead',
    });
    if (sure === 'yes') await badgeDeps.overwrite(handle);
  }
}

/** Test seam. */
export function __resetDiskConflictForTests(): void {
  byHandle.clear();
  stopClock();
  badgeEl?.remove();
  badgeEl = null;
  badgeDeps = null;
}
