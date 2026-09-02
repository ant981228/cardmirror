/**
 * Recover Previous Version — the UI over collab-history.ts.
 *
 * Entry branches on context (the command's contract):
 *  - focused doc has a live session → open straight to THAT session's
 *    version list (someone watching a document get wrecked should be
 *    one step from recovery, not browsing files), with a
 *    "Recover from file…" escape hatch alongside;
 *  - no session → skip the dialog and open the OS picker at the
 *    journals folder immediately — with no session for context an
 *    intermediate screen would just be a worse file browser.
 *
 * Selecting a version NEVER touches a live session or the canonical
 * document: the chosen state is checked out on a scratch doc built
 * from the history file and opened as a NEW, unsaved document in its
 * own window. Untitled-and-unsaved is deliberate — the recovered copy
 * must be impossible to confuse with (or reflex-overwrite onto) the
 * canonical file. The user copies what they want across by hand.
 */

import { serializeNative } from '../../native/index.js';
import { appVersion } from '../install-info.js';
import { getElectronHost } from '../host/index.js';
import type { HistoryEnvelope } from '../host/types.js';
import { pushOverlay, popOverlay, isTopOverlay } from '../overlay-stack.js';
import { showToast } from '../toast.js';
import type { CollabSession } from './collab-session.js';
import {
  collapseSeedPrefix,
  createVersionMaterializer,
  deriveVersionRows,
  groupVersionRows,
  historyHandleFor,
  snapshotFromEnvelope,
  type VersionGroup,
  type VersionRow,
} from './collab-history.js';
import { LoroDoc } from 'loro-crdt';
import { configTextStyle } from './collab-session.js';
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import {
  computeSnapshotStats,
  diffSnapshotStats,
  cardsMissingFrom,
  formatDelta,
  mountVersionPreview,
  type SnapshotStats,
} from '../version-history.js';

/** How a recovered copy gets opened. index.ts supplies a mode-aware
 *  opener: multi-pane mounts it into a slot of THIS window (via the
 *  same funnel as File → Open); single-pane spawns a fresh window. */
export type OpenRecoveredDoc = (name: string, bytes: Uint8Array) => Promise<void>;

/** Entry point (via collab-ui, which supplies the focused session). */
export async function openRecoverPreviousVersion(
  session: CollabSession | null,
  openDoc?: OpenRecoveredDoc,
  solo?: {
    docId: string | null;
    docTitle: string;
    currentDoc?: import('prosemirror-model').Node | null;
  },
): Promise<void> {
  const host = getElectronHost();
  if (!host) {
    showToast('Recover Previous Version requires the desktop edition.');
    return;
  }
  let envelope: HistoryEnvelope | null = null;
  if (session) {
    // Make the file current first — the dialog reads the FILE so the
    // in-session and from-file paths share one code path.
    await historyHandleFor(session.roomId)?.flush();
    envelope = await host.readHistory({ roomId: session.roomId });
    if (!envelope) {
      showToast('No history has been captured for this session yet.');
      return;
    }
  } else {
    // No session: the focused doc's version-history snapshots are the
    // normal source — straight into the version list, no file picking.
    // The manual envelope picker stays as the escape hatch for orphaned
    // session history (doc closed, file copied from another machine).
    if (solo?.docId) {
      const vh = await import('../version-history.js');
      if (
        await vh.openVersionSnapshotDialog(solo.docId, solo.docTitle, openDoc, solo.currentDoc)
      ) {
        return;
      }
    }
    envelope = await pickEnvelopeFromFile();
    if (!envelope) return; // cancelled, or already toasted
  }
  openVersionDialog(envelope, openDoc, solo?.currentDoc ?? null);
}

async function pickEnvelopeFromFile(): Promise<HistoryEnvelope | null> {
  const host = getElectronHost();
  if (!host) return null;
  const path = await host.pickHistoryFile();
  if (!path) return null;
  const envelope = await host.readHistory({ path });
  if (!envelope) {
    showToast('That file could not be read as CardMirror session history.');
    return null;
  }
  return envelope;
}

function openVersionDialog(
  envelope: HistoryEnvelope,
  openDoc?: OpenRecoveredDoc,
  currentDoc?: PMNode | null,
): void {
  // Derive the list up front; the snapshot import is the expensive part
  // and it is shared by every later checkout.
  let ldoc: LoroDoc;
  let groups: VersionGroup[];
  try {
    ldoc = new LoroDoc();
    configTextStyle(ldoc);
    ldoc.import(snapshotFromEnvelope(envelope));
    groups = groupVersionRows(collapseSeedPrefix(deriveVersionRows(ldoc, envelope.changeTimes)));
  } catch {
    showToast('That session history is damaged and could not be read.');
    return;
  }
  if (groups.length === 0) {
    showToast('This session history contains no changes yet.');
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'pmd-bulk-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'pmd-bulk-dialog pmd-recover-dialog pmd-recover-dialog-wide';
  overlay.appendChild(dialog);

  const token = pushOverlay();
  let closed = false;
  let previewView: EditorView | null = null;
  const close = (): void => {
    if (closed) return;
    closed = true;
    popOverlay(token);
    document.removeEventListener('keydown', onKey, true);
    previewView?.destroy();
    previewView = null;
    overlay.remove();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && isTopOverlay(token)) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  const header = document.createElement('header');
  header.className = 'pmd-bulk-header';
  const h = document.createElement('h2');
  h.textContent = 'Recover Previous Version';
  header.appendChild(h);
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'pmd-bulk-close';
  closeBtn.textContent = '×';
  closeBtn.title = 'Close';
  closeBtn.addEventListener('click', close);
  header.appendChild(closeBtn);
  dialog.appendChild(header);

  const body = document.createElement('div');
  body.className = 'pmd-bulk-body pmd-recover-body pmd-recover-body-wide';
  const blurb = document.createElement('p');
  blurb.className = 'pmd-bulk-blurb';
  blurb.textContent =
    `“${envelope.docTitle}” — history through ${fmtTime(envelope.updatedAt)}. ` +
    `Click a version to preview it. Opening a version makes a separate unsaved copy; the shared document is not changed.`;
  body.appendChild(blurb);

  const split = document.createElement('div');
  split.className = 'pmd-recover-split';
  const list = document.createElement('div');
  list.className = 'pmd-recover-list pmd-recover-versions pmd-recover-versions-session';
  const previewPane = document.createElement('div');
  previewPane.className = 'pmd-recover-preview-pane';
  const previewEmpty = document.createElement('div');
  previewEmpty.className = 'pmd-recover-preview-empty';
  previewEmpty.textContent = 'Select a version to preview it.';
  previewPane.appendChild(previewEmpty);

  // ── Preview + digest machinery ──
  // materializeVersion is a SYNCHRONOUS loro checkout (~10s worst case
  // on tournament masters), so digests are computed lazily on the
  // user's own preview clicks — never as an eager background sweep
  // that would freeze the renderer — and cached per row.
  const snapshot = snapshotFromEnvelope(envelope);
  // One imported source doc for the dialog's lifetime: preview clicks
  // and "Open copy" used to re-import the whole snapshot (and re-decode
  // its base64) per call (2026-09-01 review, PH-A7).
  const materialize = createVersionMaterializer(snapshot);
  const currentStats = currentDoc ? computeSnapshotStats(currentDoc) : null;
  const statsByRow = new Map<VersionRow, SnapshotStats>();
  const selectables = new Set<HTMLElement>();
  let previewSeq = 0;

  interface GroupRefs {
    endRow: VersionRow;
    digest: HTMLElement;
    delta: HTMLElement;
    badge: HTMLElement;
  }
  const groupRefs: GroupRefs[] = []; // newest-first, matching the list

  const refreshDigests = (): void => {
    for (let i = 0; i < groupRefs.length; i++) {
      const g = groupRefs[i]!;
      const st = statsByRow.get(g.endRow);
      if (!st) continue;
      g.digest.textContent = `${st.words.toLocaleString()} words · ${st.cards.toLocaleString()} cards`;
      if (currentStats) {
        const missing = cardsMissingFrom(st, currentStats);
        g.badge.textContent =
          missing > 0 ? `${missing} card${missing === 1 ? '' : 's'} not in current doc` : '';
      }
      const older = groupRefs[i + 1] ? statsByRow.get(groupRefs[i + 1]!.endRow) : undefined;
      if (older) g.delta.textContent = formatDelta(diffSnapshotStats(st, older));
    }
  };

  const previewRow = (row: VersionRow, el: HTMLElement): void => {
    const seq = ++previewSeq;
    for (const sel of selectables) sel.classList.toggle('pmd-recover-version-selected', sel === el);
    previewPane.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'pmd-recover-preview-empty';
    loading.textContent = 'Reconstructing version…';
    previewPane.appendChild(loading);
    // Yield a beat so the busy state PAINTS before the sync checkout
    // (same trick as recoverButton).
    setTimeout(() => {
      if (closed || seq !== previewSeq) return;
      let node: PMNode;
      try {
        node = materialize(row.frontier);
      } catch (err) {
        console.error('[recover] failed to materialize preview:', err);
        loading.textContent = 'Could not reconstruct this version — the history may be damaged.';
        return;
      }
      if (closed || seq !== previewSeq) return;
      if (!statsByRow.has(row)) {
        statsByRow.set(row, computeSnapshotStats(node));
        refreshDigests();
      }
      previewView?.destroy();
      previewView = mountVersionPreview(previewPane, node);
    }, 30);
  };

  // Newest first — vandalism recovery reaches for "just before the end".
  for (const group of [...groups].reverse()) {
    list.appendChild(
      groupRow(group, envelope, close, openDoc, {
        previewRow,
        selectables,
        registerGroup: (refs) => groupRefs.push(refs),
        materialize,
      }),
    );
  }
  split.append(list, previewPane);
  body.appendChild(split);
  dialog.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'pmd-bulk-actions';
  const fromFile = document.createElement('button');
  fromFile.type = 'button';
  fromFile.className = 'pmd-bulk-btn';
  fromFile.textContent = 'Recover from file…';
  fromFile.addEventListener('click', () => {
    void pickEnvelopeFromFile().then((other) => {
      if (!other) return;
      close();
      openVersionDialog(other, openDoc, currentDoc);
    });
  });
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'pmd-bulk-btn pmd-bulk-btn-primary';
  done.textContent = 'Close';
  done.addEventListener('click', close);
  actions.append(fromFile, done);
  dialog.appendChild(actions);

  document.body.appendChild(overlay);
  done.focus();
}

interface GroupRowCtx {
  /** Materialize + render `row` in the preview pane; `el` gets the
   *  selected highlight. */
  previewRow: (row: VersionRow, el: HTMLElement) => void;
  /** All preview-selectable elements (for exclusive highlighting). */
  selectables: Set<HTMLElement>;
  registerGroup: (refs: {
    endRow: VersionRow;
    digest: HTMLElement;
    delta: HTMLElement;
    badge: HTMLElement;
  }) => void;
  /** Shared materializer over the dialog's one imported source doc. */
  materialize: (frontier: VersionRow['frontier']) => PMNode;
}

function groupRow(
  group: VersionGroup,
  envelope: HistoryEnvelope,
  closeDialog: () => void,
  openDoc: OpenRecoveredDoc | undefined,
  ctx: GroupRowCtx,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-recover-group';
  const endRow = group.rows[group.rows.length - 1]!;

  const head = document.createElement('div');
  head.className = 'pmd-recover-group-head pmd-recover-group-head-clickable';

  const expand = document.createElement('button');
  expand.type = 'button';
  expand.className = 'pmd-recover-expand';
  expand.textContent = '▸';
  expand.title = 'Show individual changes';

  const label = document.createElement('span');
  label.className = 'pmd-recover-group-label';
  // A group that IS just the seed row gets named for what it is.
  label.textContent =
    group.rows.length === 1 && group.rows[0]!.isSeed
      ? `Session started — ${groupLabel(group)}`
      : groupLabel(group);

  const meta = document.createElement('span');
  meta.className = 'pmd-recover-group-meta';
  meta.textContent =
    `${group.rows.length} change${group.rows.length === 1 ? '' : 's'} · ` +
    `${group.peers.length} editor${group.peers.length === 1 ? '' : 's'}`;

  // The group's recover target is its LAST change — "the document as it
  // stood at the end of this burst of editing".
  const open = recoverButton(endRow, envelope, closeDialog, openDoc, ctx.materialize);

  head.append(expand, label, meta, open);
  wrap.appendChild(head);

  // Digest lines (filled lazily once this group's end state has been
  // previewed — the checkout is too expensive to run eagerly).
  const digest = document.createElement('div');
  digest.className = 'pmd-recover-version-stats pmd-recover-group-digest';
  const delta = document.createElement('div');
  delta.className = 'pmd-recover-version-delta pmd-recover-group-digest';
  const badge = document.createElement('div');
  badge.className = 'pmd-recover-version-badge pmd-recover-group-digest';
  wrap.append(digest, delta, badge);
  ctx.registerGroup({ endRow, digest, delta, badge });

  // Clicking the group (not its buttons) previews its end state.
  ctx.selectables.add(head);
  head.addEventListener('click', (e) => {
    if (e.target instanceof HTMLElement && e.target.closest('button')) return;
    ctx.previewRow(endRow, head);
  });

  let detail: HTMLElement | null = null;
  expand.addEventListener('click', () => {
    if (detail) {
      detail.remove();
      detail = null;
      expand.textContent = '▸';
      return;
    }
    expand.textContent = '▾';
    detail = document.createElement('div');
    detail.className = 'pmd-recover-detail';
    // Newest first, same as the group list.
    for (const row of [...group.rows].reverse()) {
      const line = document.createElement('div');
      line.className = 'pmd-recover-row';
      const t = document.createElement('span');
      t.className = 'pmd-recover-row-time';
      t.textContent = row.atMs === null ? '—' : fmtTime(row.atMs);
      const who = document.createElement('span');
      who.className = 'pmd-recover-row-peer';
      who.textContent = row.isSeed ? 'session started (initial document)' : `editor …${row.peer.slice(-4)}`;
      line.append(t, who, recoverButton(row, envelope, closeDialog, openDoc, ctx.materialize));
      line.classList.add('pmd-recover-row-clickable');
      ctx.selectables.add(line);
      line.addEventListener('click', (e) => {
        if (e.target instanceof HTMLElement && e.target.closest('button')) return;
        ctx.previewRow(row, line);
      });
      detail.appendChild(line);
    }
    wrap.appendChild(detail);
  });
  return wrap;
}

function recoverButton(
  row: VersionRow,
  envelope: HistoryEnvelope,
  closeDialog: () => void,
  openDoc: OpenRecoveredDoc | undefined,
  materialize: (frontier: VersionRow['frontier']) => PMNode,
): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pmd-bulk-btn pmd-recover-open';
  btn.textContent = 'Open copy';
  btn.addEventListener('click', () => {
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Opening…';
    // Yield a beat so the busy state PAINTS: materializeVersion is a
    // synchronous rebuild that freezes the renderer for ~10s on a
    // tournament-master-sized file.
    void new Promise((r) => setTimeout(r, 30))
      .then(() => recoverVersion(row, envelope, openDoc, materialize))
      .then((ok) => {
        if (ok) closeDialog();
      })
      .finally(() => {
        btn.disabled = false;
        btn.textContent = original;
      });
  });
  return btn;
}

async function recoverVersion(
  row: VersionRow,
  envelope: HistoryEnvelope,
  openDoc: OpenRecoveredDoc | undefined,
  materialize: (frontier: VersionRow['frontier']) => PMNode,
): Promise<boolean> {
  const host = getElectronHost();
  if (!host) return false;
  try {
    const node = materialize(row.frontier);
    const bytes = serializeNative(node, { appVersion });
    const name = envelope.docTitle || 'Recovered document';
    if (openDoc) {
      await openDoc(name, bytes);
    } else {
      await host.spawnWindow({
        filename: name,
        bytes,
        handle: null, // never the canonical file — unsaved by construction
        format: 'cmir',
        uid: null,
      });
    }
    return true;
  } catch (err) {
    console.error('[recover] failed to open version:', err);
    showToast('Could not reconstruct that version — the history may be damaged.');
    return false;
  }
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString()} ${time}`;
}

function groupLabel(group: VersionGroup): string {
  if (group.startMs === null && group.endMs === null) return 'Earlier changes';
  const start = fmtTime(group.startMs ?? group.endMs!);
  const end = fmtTime(group.endMs ?? group.startMs!);
  return start === end ? start : `${start} – ${end}`;
}
