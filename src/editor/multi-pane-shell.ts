/**
 * Multi-pane workspace shell.
 *
 * Mounted at boot when `settings.get('multiDocWorkspace')` is true.
 * Owns three slots (`slot1` / `slot2` / `slot3`), each holding a stack
 * of 0+ documents. Renders a per-slot pane with a small title chip,
 * the live ProseMirror EditorView, and a footer (word count + Open
 * file button). The nav pane is split into one section per active
 * slot. The shared ribbon, status bar, and Save / Save As route
 * through the focused pane via `setActiveView` in `editor/index.ts`.
 *
 * Comments: a single shared `#comments-column` sits to the right of
 * the multi-row like a narrow fourth slot. The threads shown follow
 * focus, and cards relayout against `view.coordsAtPos` on every
 * focused-pane scroll tick (the column doesn't share a scroll
 * container with any pane).
 *
 * Layout cells:
 *   - 1 active slot  → full width
 *   - 2 active slots → 50/50
 *   - 3 active slots → compact (thirds) OR wide-scroll (paged)
 *
 * Cross-pane drag = copy (handled in `drag-controller.ts`'s commit
 * branch for cross-view drops). Drag from doc → another doc's nav
 * section works the same way: the destination nav section's surface
 * declares its view, the controller treats it as cross-view.
 */

import { EditorState, Selection, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { setViewDocPath } from './transclusion-doc-path.js';
import { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../schema/index.js';
import { fromDocxFull, parseNative, serializeNativeAsync, NATIVE_FILE_EXTENSION } from '../index.js';
import { settings } from './settings.js';
import { MARK_UNREAD_TOGGLE } from './mark-unread-plugin.js';
import { NUMBERING_REFRESH, numberingDisplaySig } from './numbering-plugin.js';
import { getHost, getElectronHost, isSameOpenHandle, type OpenedFile } from './host/index.js';
import { isFileOpenInAnotherWindow } from './window-coordination.js';
import { getCommentsState, loadThreads, type Thread } from './comments-plugin.js';
import { learnStore, type ShowInContextRequest } from './learn-store-host.js';
import { resolveDescriptor, type AnchorDescriptor } from './learn-anchor.js';
import { preciseScrollIntoView } from './precise-scroll.js';

type DocFormat = 'cmir' | 'docx';

/** Decide which on-disk format a file is, given its filename.
 *  Returns null for filenames with neither a `.cmir` nor `.docx`
 *  extension (the caller can fall back to format detection by
 *  content sniffing, or just default to docx). */
function formatFromFilename(name: string): DocFormat | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.cmir')) return 'cmir';
  if (lower.endsWith('.docx')) return 'docx';
  return null;
}
import { NavigationPanel, installNavResizeHandle } from './nav-panel.js';
import { EditorDragSurface } from './drag-editor-surface.js';
import { dragController, rewriteHeadingIds } from './drag-controller.js';
import { isBenchmarkActive } from './benchmark-state.js';
import {
  countReadAloudSplit,
  totalWords,
  formatReadTimeFor,
  formatNumber,
  type ReadAloudCounts,
} from './word-count.js';
import { liveContainerSegment } from './live-read-time.js';
import { openWordCount } from './word-count-ui.js';
import { isAutosaveOnForPath, setAutosaveForPath } from './autosave-prefs-store.js';
import {
  autosaveBlockedForRecoveredDraft,
  recoveredDraftJournalSavedAt,
} from './journal-staleness.js';
import { makeBlankDoc } from './blank-doc.js';
import { homeScreen } from './home-screen.js';
import { captureCleanToken } from './save-clean-token.js';
import { scheduleIdle, cancelIdle, type IdleHandle } from './idle-scheduler.js';
import { getSpeechDocResolver } from './speech-doc-registry.js';
import { sendToSpeech as runSendToSpeech } from './speech-doc-send.js';
import { selfRefSelectionPos } from './self-transclusion-commands.js';
import { transclusionDivergenceKey } from './transclusion-divergence-plugin.js';
import {
  promptForText,
  alertDialog,
  installModalKeys,
  armDialogFocus,
  captureFocusForDialog,
} from './text-prompt.js';
import { showToast } from './toast.js';
import { recordRecent } from './recents-store.js';
import { maybeDecryptForOpen, OpenCancelledError } from './open-encrypted.js';
import {
  checkSessionRejoinForOpenedDoc,
  buildEditorPlugins,
  enableMultiDocMode,
  setActiveView,
  getActiveView,
  applyReadModeToTarget,
  setReadModeStateResolver,
  applyZoomToTarget,
  setZoomStateResolver,
  refreshZoomStatus,
  clampZoom,
  setAutosaveStateResolver,
  setActiveNavPanelResolver,
  attachClickBelowToEnd,
  confirmCloseUnsaved,
  resolveCoEditedClose,
  runSaveFlow,
  runSaveAsFlow,
  reportAutosaveFailure,
  reportAutosaveSuccess,
  refreshWindowTitle,
  commentsColumn,
  getCommentsColumnEl,
  notifyCommentsForActiveTransaction,
  sendViewToDropzone,
} from './index.js';
import { sendViewToStarred } from './pairing/send-to-starred.js';
import { isSyncOrigin } from './sync-origin.js';
import { editorNodeViews } from './image-resize-nodeview.js';
import { coordinatorBlocks, flashLockedLeases } from './ai/edit-coordinator.js';
import {
  tagCollabTransaction,
  collabCopresenceFor,
  onCollabCopresenceChange,
} from './collab/collab-hooks.js';
import { icon, setIcon } from './icons';
import { formatSpeechFilename } from './speech-filename.js';
import { pushOverlay, popOverlay, isTopOverlay } from './overlay-stack.js';

export type SlotId = 'slot1' | 'slot2' | 'slot3';
const SLOT_IDS: SlotId[] = ['slot1', 'slot2', 'slot3'];

let nextDocUid = 1;
function newDocUid(): string {
  return `doc-${nextDocUid++}`;
}

/** Sync the cross-window open-path claim when a record's handle
 *  changes. Releases `prev`'s claim (if any) and registers
 *  `next`'s claim (if any) with the main process. No-op outside
 *  Electron (browser has no cross-window concept). Called from
 *  the record lifecycle: mount (null → handle), Save-As (old →
 *  new), close (handle → null). Best-effort fire-and-forget —
 *  main also cleans up automatically when a window closes, so a
 *  missed release won't permanently block re-opening. */
function syncDocPathClaim(prev: unknown, next: unknown): void {
  if (prev === next) return;
  const electron = getElectronHost();
  if (!electron) return;
  if (typeof prev === 'string' && prev) void electron.openPathRelease(prev);
  if (typeof next === 'string' && next) void electron.openPathRegister(next);
}

/** Push a pane's current filename to main so the Select-Speech-Doc
 *  modal can label it. No-op on web. */
function pushPaneDocInfo(uid: string, filename: string | null): void {
  const electron = getElectronHost();
  if (!electron) return;
  void electron.docInfoUpdate(uid, filename);
}

/** Debounce window for per-DocRecord journal writes. */
const RECORD_JOURNAL_DELAY_MS = 3000;

// Per-record write chains: with the gzip step async, two debounce
// rounds for the SAME record could otherwise overlap in flight and
// land out of order (older bytes clobbering newer). Rounds for
// different records are independent (distinct uids / files).
const recordJournalChains = new WeakMap<DocRecord, Promise<void>>();
const recordAutosaveChains = new WeakMap<DocRecord, Promise<void>>();

/** Re-arm the journal-write timer for `record` after a doc edit.
 *  No-op when the host doesn't support journaling. */
function scheduleJournalForRecord(record: DocRecord): void {
  const host = getHost();
  if (!host.journalsSupported) return;
  if (record.journalTimer !== null) window.clearTimeout(record.journalTimer);
  record.journalTimer = window.setTimeout(() => {
    record.journalTimer = null;
    const prev = recordJournalChains.get(record) ?? Promise.resolve();
    recordJournalChains.set(
      record,
      prev
        .then(() => runJournalForRecord(record))
        .catch((err) => console.warn('Journal (record) write crashed:', err)),
    );
  }, RECORD_JOURNAL_DELAY_MS);
}

/** Actually serialize + write `record`'s current doc as a journal
 *  entry under its uid. Best-effort — logs failures, doesn't
 *  surface them to the user. */
async function runJournalForRecord(record: DocRecord): Promise<void> {
  const host = getHost();
  if (!host.journalsSupported) return;
  try {
    const state = record.view.state;
    const bytes = await serializeNativeAsync(state.doc, {
      threads: Array.from(getCommentsState(state).threads.values()),
      ...(record.docId ? { docId: record.docId } : {}),
    });
    // A recovered-but-not-yet-saved draft carries its ORIGINAL journal
    // savedAt forward, so the stale-overwrite guard survives relaunches and
    // mode switches even though this write stamps savedAt = now.
    const recoveredFrom = recoveredDraftJournalSavedAt(record.uid);
    await host.writeJournal({
      uid: record.uid,
      filename: record.filename,
      // Electron path string OR the browser's FileSystemFileHandle (both
      // survive the journal round-trip).
      handle: record.handle,
      format: record.format,
      savedAt: new Date().toISOString(),
      ...(recoveredFrom ? { recoveredFromSavedAt: recoveredFrom } : {}),
      bytes,
    });
  } catch (err) {
    console.warn('Journal write failed:', err);
  }
}

/** Delete the journal entry for `record`. Called on successful
 *  save and on explicit close. */
async function clearJournalForRecord(record: DocRecord): Promise<void> {
  const host = getHost();
  if (!host.journalsSupported) return;
  try {
    await host.deleteJournal(record.uid);
  } catch (err) {
    console.warn('Journal delete failed:', err);
  }
}

/** Debounce delay before an autosave attempt fires after the user
 *  pauses editing. Matches the single-doc constant in editor/index.ts. */
const AUTOSAVE_DELAY_MS = 5000;

/** Per-DocRecord autosave attempt. Like the single-doc
 *  `runAutosaveAttempt`, but bound to `record` instead of the
 *  module-level focused view — so edits in pane A flush to A's
 *  file even when focus has since moved to B. Same gates: opt-in
 *  per-record, .cmir + saved-once only, supportsInPlaceSave host. */
async function runAutosaveForRecord(record: DocRecord): Promise<void> {
  if (!record.autosaveEnabled) return;
  if (record.format !== 'cmir') return;
  if (typeof record.handle !== 'string' || !record.handle) return;
  const host = getHost();
  if (!host.supportsInPlaceSave) return;
  // A recovered draft may only be written by a MANUAL save until its first
  // one lands — the stale-overwrite confirmation lives on the manual path,
  // and `buildDocRecord` re-arms autosave from the per-path preference, so
  // without this gate a stale draft opened for inspection would silently
  // overwrite the newer file on the first keystroke.
  if (autosaveBlockedForRecoveredDraft(record.uid)) return;
  try {
    // Capture before serializing — keystrokes during the write are not
    // in the saved bytes and must keep the record dirty + journaled.
    const commitClean = captureCleanToken({
      editGen: () => record.editGen,
      markClean: () => {
        record.dirty = false;
      },
      // Successful save → drop the journal. Mirrors the single-doc
      // post-save journal cleanup so a re-crash doesn't surface a
      // recovery offer for a doc that's already on disk.
      clearJournal: () => {
        void clearJournalForRecord(record);
      },
    });
    const state = record.view.state;
    const threads = Array.from(getCommentsState(state).threads.values());
    const bytes = await serializeNativeAsync(state.doc, {
      ...(threads.length ? { threads } : {}),
      ...(record.docId ? { docId: record.docId } : {}),
    });
    await host.saveExisting(record.handle, bytes);
    commitClean();
    reportAutosaveSuccess();
  } catch (err) {
    reportAutosaveFailure(record.filename, err);
  }
}

/** (Re-)arm the per-record autosave debounce. No-op when autosave
 *  is off for the record. Cheap to fire unconditionally; the
 *  inner check short-circuits before scheduling. */
function scheduleAutosaveForRecord(record: DocRecord): void {
  if (!record.autosaveEnabled) return;
  if (record.autosaveTimer !== null) window.clearTimeout(record.autosaveTimer);
  record.autosaveTimer = window.setTimeout(() => {
    record.autosaveTimer = null;
    const prev = recordAutosaveChains.get(record) ?? Promise.resolve();
    // .catch keeps the chain fulfilled — one guard-line throw must not kill
    // this record's autosave for the session (same fix as the single-doc chain).
    recordAutosaveChains.set(
      record,
      prev
        .then(() => runAutosaveForRecord(record))
        .catch((err) => reportAutosaveFailure(record.filename, err)),
    );
  }, AUTOSAVE_DELAY_MS);
}

/**
 * One loaded document inside a slot's stack. Owns a live EditorView
 * (so swapping back to this record in the stack restores selection
 * and undo history without a re-mount — they live in the retained
 * view), the per-doc nav surface, and the per-doc editor drag
 * surface. Scroll does NOT live in the retained view: the scroller
 * is the slot's shared `.pmd-pane-body`, which clamps to 0 the
 * moment the editor detaches — so the viewport is carried per-doc
 * via `savedScrollTop` across detach / mount instead.
 */
interface DocRecord {
  uid: string;
  filename: string;
  /** Opaque host handle (Electron: absolute path; browser: a
   *  FileSystemFileHandle when one is available). `null` when the
   *  doc has never been saved or was opened in a context that
   *  doesn't expose handles. The Save command uses this to write
   *  silently in place; Save-As updates it. */
  handle: unknown | null;
  /** Which on-disk format this doc lives in. Driven by the
   *  filename extension on open / save. `null` for brand-new docs
   *  that haven't been saved yet (Save will fall through to Save-
   *  As, which prompts for a format). */
  format: 'cmir' | 'docx' | null;
  view: EditorView;
  /** Root element holding `view.dom`. Mounted into / detached from
   *  the slot's body when this record becomes / stops being visible. */
  editorEl: HTMLElement;
  /** The pane scroller's `scrollTop` while this doc was last
   *  visible — captured on detach, reapplied on mount (the browser
   *  clamps it against the doc's height). 0 for fresh docs, so a
   *  doc opened on top of another starts at the top. */
  savedScrollTop: number;
  navPanel: NavigationPanel;
  /** The slot this record currently lives in — maintained by
   *  `Slot.push`. The record's dispatchTransaction refreshes THIS
   *  slot's chrome (word count); a slot captured at build time
   *  would go stale as soon as `sendDocToSlotN` moves the record. */
  owner: Slot;
  /** Root element holding `navPanel`'s output. Mounted into / detached
   *  from the slot's nav section when visibility changes. */
  navEl: HTMLElement;
  dragSurface: EditorDragSurface;
  /** Debounce handle for per-pane "heavy" work (nav re-render +
   *  word-count walk). Both are O(doc-size) operations that PM
   *  fires transactions for several times per keystroke (composite
   *  edits, selection sync, etc.). Single-doc debounces the same
   *  work via `scheduleHeavyUpdate`; we match its 200ms cadence so
   *  per-keystroke editing of a large doc stays responsive.
   *
   *  Also matters for the nav specifically: rebuilding the heading
   *  list replaces every `<li>` element, which would invalidate a
   *  dblclick in progress unless the rebuild waits for a typing
   *  pause. */
  heavyUpdateTimer: IdleHandle | null;
  /** Debounce timer for the crash-recovery journal write. Re-armed
   *  by every doc-changing transaction; fires `~3s` later with a
   *  cmir snapshot of this record's current doc. */
  journalTimer: number | null;
  /** Per-doc read-mode state. Multi-doc treats read mode as a
   *  property of an individual open doc — the ribbon toggle flips
   *  this for the focused pane only, leaving other panes untouched. */
  readMode: boolean;
  /** Per-pane body-text zoom (50–300%). Same per-doc story as `readMode`: the
   *  zoom controls affect the FOCUSED pane only; other panes stay at theirs.
   *  Opens at `defaultZoomPct`, transient (resets on reload). */
  zoomPct: number;
  /** Per-doc autosave state. Same per-doc story as `readMode`: the
   *  ribbon toggle flips this for the focused pane only. When true
   *  AND the record is saved-as-.cmir, edits debounce into a
   *  per-record `saveExisting` call after `AUTOSAVE_DELAY_MS`. */
  autosaveEnabled: boolean;
  /** Debounce timer for the per-record autosave write. */
  autosaveTimer: number | null;
  /** Stable per-document id for the Learn annotation layer (SPEC §3.1).
   *  Read from the file on open; minted on first save (`ensureActiveDocId`
   *  in index.ts, via `setFocusedDocId`); null for a never-saved doc (its
   *  annotations key to `uid` until that mint rekeys them). Persisted into
   *  the file by every save / autosave / journal write. */
  docId: string | null;
  /** True when this record has unsaved changes — set on any
   *  doc-changing transaction, cleared on a successful save
   *  (manual or autosave). Drives the per-pane close-confirm
   *  prompt: a clean pane closes without prompting. */
  dirty: boolean;
  /** Edit generation — bumped on every doc-changing transaction. Saves
   *  capture it right before serializing so a save that completes after
   *  further edits can't wrongly mark those edits clean (see
   *  save-clean-token.ts). */
  editGen: number;
}

/**
 * Doc-switcher overlay — the Alt+Tab-style list that appears while
 * the user holds Ctrl+Tab in multi-pane mode. Lists every doc in
 * the focused slot's stack top-to-bottom (no thumbnails, just
 * filenames). Each Tab press while the overlay is open advances
 * the highlighted candidate; Ctrl release commits the highlight as
 * the slot's visible doc; Escape cancels without committing.
 *
 * Snapshots the slot's stack at `open` time so the candidate index
 * doesn't get scrambled if the slot's stack mutates during the
 * cycle (rare but defensive — autosave / async file ops can land
 * in the middle of a Ctrl-hold).
 */
class DocSwitcherOverlay {
  private overlayEl: HTMLElement;
  private listEl: HTMLElement;
  /** Active slot at open() time. Stays bound for the cycle. */
  private slot: Slot | null = null;
  /** Snapshot of the slot's stack at open time, in display order. */
  private candidates: DocRecord[] = [];
  /** Index into `candidates` that's currently highlighted. */
  private index = 0;

  constructor() {
    this.overlayEl = document.createElement('div');
    this.overlayEl.className = 'pmd-doc-switcher';
    this.overlayEl.hidden = true;
    this.listEl = document.createElement('ol');
    this.listEl.className = 'pmd-doc-switcher-list';
    this.overlayEl.appendChild(this.listEl);
    document.body.appendChild(this.overlayEl);
  }

  isOpen(): boolean {
    return !this.overlayEl.hidden;
  }

  /** Open the overlay for the given slot, advancing the highlight
   *  by `direction` from the slot's current visible doc. Mirrors
   *  the OS Alt+Tab pattern where the first chord press already
   *  shows a candidate (typically the next doc, not the current
   *  one). The overlay positions itself centered over the slot's
   *  pane (not the whole viewport) so users can tell at a glance
   *  which slot they're cycling through. */
  open(slot: Slot, direction: 1 | -1): void {
    this.slot = slot;
    this.candidates = [...slot.stack];
    const start = slot.visibleIndex < 0 ? 0 : slot.visibleIndex;
    const len = this.candidates.length;
    this.index = (start + direction + len) % len;
    this.positionOverSlot(slot);
    this.render();
    this.overlayEl.hidden = false;
  }

  /** Place the overlay so its center matches the slot's pane
   *  center. Read live each open() so layout changes (window
   *  resize, expand-mode toggle, etc.) since the last cycle
   *  don't strand the overlay over the wrong region. */
  private positionOverSlot(slot: Slot): void {
    const rect = slot.paneEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    this.overlayEl.style.left = `${Math.round(cx)}px`;
    this.overlayEl.style.top = `${Math.round(cy)}px`;
  }

  /** Step the highlight by `delta` (+1 or -1) with wrap-around. */
  advance(delta: 1 | -1): void {
    if (!this.isOpen()) return;
    const len = this.candidates.length;
    if (len < 2) return;
    this.index = (this.index + delta + len) % len;
    this.render();
  }

  /** Make the highlighted candidate the slot's visible doc, then
   *  close the overlay. Re-focuses the slot's view so typing
   *  resumes in the doc. */
  commit(): void {
    if (!this.isOpen() || !this.slot) {
      this.reset();
      return;
    }
    const target = this.candidates[this.index];
    if (target) {
      this.slot.showRecord(target);
      this.slot.visible?.view.focus();
    }
    this.reset();
  }

  /** Close the overlay without committing. */
  cancel(): void {
    if (!this.isOpen()) return;
    this.reset();
  }

  private reset(): void {
    this.overlayEl.hidden = true;
    this.slot = null;
    this.candidates = [];
    this.index = 0;
  }

  private render(): void {
    this.listEl.innerHTML = '';
    for (let i = 0; i < this.candidates.length; i++) {
      const rec = this.candidates[i]!;
      const item = document.createElement('li');
      item.className = 'pmd-doc-switcher-item';
      if (i === this.index) item.classList.add('pmd-doc-switcher-item-active');
      const name = document.createElement('span');
      name.className = 'pmd-doc-switcher-item-name';
      name.textContent = rec.filename || '(untitled)';
      item.appendChild(name);
      if (rec.dirty) {
        const mark = document.createElement('span');
        mark.className = 'pmd-doc-switcher-item-dirty';
        mark.textContent = '●';
        mark.title = 'Unsaved changes';
        item.appendChild(mark);
      }
      this.listEl.appendChild(item);
    }
  }
}

class Slot {
  readonly id: SlotId;
  /** Top-level pane element (chip + editor + footer). Hidden when
   *  the stack is empty. */
  readonly paneEl: HTMLElement;
  /** Title chip text container. */
  private chipNameEl: HTMLElement;
  /** When set, overrides the chip's displayed title (e.g. "CardMirror
   *  Browser" while the research browser docks into this pane) —
   *  `refreshChipFilename` leaves it alone so a Save-As on the doc
   *  underneath can't clobber it, and normal filename display resumes
   *  once the override is cleared. */
  private chipTitleOverride: string | null = null;
  /** Title chip stack dropdown trigger (shown when stack has 2+). */
  private chipStackBtn: HTMLButtonElement;
  /** Title chip expand / restore toggle — fills this pane to the
   *  full editor + nav-rail surface while the others stay loaded
   *  but hidden, and back. */
  private chipExpandBtn: HTMLButtonElement;
  /** Title chip × close button. */
  private chipCloseBtn: HTMLButtonElement;
  /** Editor body — DocRecord.editorEl mounts here. */
  private bodyEl: HTMLElement;
  /** Footer word count. */
  private wcEl: HTMLElement;
  /** Footer co-editing indicator — status text + presence dots for THIS slot's
   *  visible doc's session. Hidden when that doc has no live session. */
  private copresenceEl: HTMLElement;
  /** Nav section (in the multi-nav rail). Hidden when stack is empty. */
  readonly navSectionEl: HTMLElement;
  /** Nav body — DocRecord.navEl mounts here. */
  private navBodyEl: HTMLElement;
  /** Top-edge drag handle that resizes this section against the one
   *  above it. Hidden on the topmost visible section. */
  private navResizeHandle: HTMLElement;
  /** Last width we wrote into `--pmd-card-intrinsic-width`. Skips
   *  no-op writes on repeated sync calls (e.g. multiple events
   *  firing in one frame for the same final width). */
  private lastIntrinsicWidth = -1;
  /** Chip outline-toggle button — shows / hides THIS slot's nav
   *  section. The reopen path for a section closed via its × (and a
   *  one-click hide without reaching into the rail). */
  private chipNavBtn: HTMLButtonElement;
  /** True when the user has closed this slot's outline section (via the
   *  section × or the chip toggle). The section stays out of the rail —
   *  the doc itself stays open — until the user reopens it. Per-slot, so
   *  closing one document's outline leaves the others' untouched. */
  navHidden = false;
  /** Vertical flex weight of this slot's nav section within the rail.
   *  All start at 1 (equal share); dragging a section's resize handle
   *  shifts weight between it and its neighbour. Reset to 1 whenever the
   *  set of open sections changes (so a closed doc doesn't strand a
   *  lopsided split). */
  navFlex = 1;

  /** Live stack. Index 0 = bottom (least recently active);
   *  `visibleIndex` is the doc currently shown. */
  stack: DocRecord[] = [];
  visibleIndex = -1;

  /** Owning shell for routing focus / re-render events. */
  shell: MultiPaneShell;

  constructor(id: SlotId, shell: MultiPaneShell) {
    this.id = id;
    this.shell = shell;
    this.paneEl = document.createElement('div');
    this.paneEl.className = 'pmd-pane';
    this.paneEl.dataset['slot'] = id;
    this.paneEl.hidden = true;
    // Click anywhere in the pane → focus it (route shared ribbon /
    // chrome through this slot's visible doc).
    this.paneEl.addEventListener('mousedown', () => this.shell.focusSlot(this));

    // Title chip.
    const chip = document.createElement('div');
    chip.className = 'pmd-pane-chip';
    this.chipStackBtn = document.createElement('button');
    this.chipStackBtn.type = 'button';
    this.chipStackBtn.className = 'pmd-pane-chip-stack';
    this.chipStackBtn.title = 'Switch document in this slot';
    setIcon(this.chipStackBtn, 'chevron-down');
    this.chipStackBtn.hidden = true;
    this.chipStackBtn.addEventListener('mousedown', (e) => e.preventDefault());
    this.chipStackBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openStackDropdown();
    });
    chip.appendChild(this.chipStackBtn);
    this.chipNameEl = document.createElement('span');
    this.chipNameEl.className = 'pmd-pane-chip-name';
    chip.appendChild(this.chipNameEl);
    // Slot-number badge — small fixed glyph immediately left of
    // the expand button. Helps users identify which slot they're
    // looking at when only some slots are occupied (a single doc
    // in slot 2 with slots 1 and 3 empty looks the same as a
    // single doc in slot 1, otherwise).
    const slotBadge = document.createElement('span');
    slotBadge.className = 'pmd-pane-chip-slot-num';
    slotBadge.textContent = id.replace('slot', '');
    slotBadge.title = `Slot ${id.replace('slot', '')}`;
    chip.appendChild(slotBadge);
    this.chipExpandBtn = document.createElement('button');
    this.chipExpandBtn.type = 'button';
    this.chipExpandBtn.className = 'pmd-pane-chip-expand';
    this.chipExpandBtn.title = 'Expand this pane to fill the workspace (Ctrl+Shift+F)';
    setIcon(this.chipExpandBtn, 'expand');
    this.chipExpandBtn.setAttribute('aria-pressed', 'false');
    this.chipExpandBtn.addEventListener('mousedown', (e) => e.preventDefault());
    this.chipExpandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.shell.toggleExpanded(this);
    });
    chip.appendChild(this.chipExpandBtn);
    // Outline-toggle — shows / hides this slot's nav section. Pressed
    // = outline visible. Doubles as the reopen affordance after the
    // user closes the section with its own × button.
    this.chipNavBtn = document.createElement('button');
    this.chipNavBtn.type = 'button';
    this.chipNavBtn.className = 'pmd-pane-chip-nav';
    setIcon(this.chipNavBtn, 'nav-toggle');
    this.chipNavBtn.addEventListener('mousedown', (e) => e.preventDefault());
    this.chipNavBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.shell.setSlotNavHidden(this, !this.navHidden);
    });
    chip.appendChild(this.chipNavBtn);
    this.chipCloseBtn = document.createElement('button');
    this.chipCloseBtn.type = 'button';
    this.chipCloseBtn.className = 'pmd-pane-chip-close';
    this.chipCloseBtn.title = 'Close this document';
    setIcon(this.chipCloseBtn, 'close');
    this.chipCloseBtn.addEventListener('mousedown', (e) => e.preventDefault());
    this.chipCloseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.closeVisible();
    });
    chip.appendChild(this.chipCloseBtn);
    this.paneEl.appendChild(chip);

    // Editor body container.
    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'pmd-pane-body';
    this.paneEl.appendChild(this.bodyEl);

    // Footer (word-count button + word count + open file button).
    const footer = document.createElement('div');
    footer.className = 'pmd-pane-footer';
    // Σ button — opens the Word Count Selection modal scoped to this
    // pane's visible doc (mirrors the shared status-bar button that's
    // hidden in multi-doc mode).
    const wcBtn = document.createElement('button');
    wcBtn.type = 'button';
    wcBtn.className = 'pmd-pane-wc-btn';
    wcBtn.title = 'Word Count Selection';
    wcBtn.setAttribute('aria-label', 'Word count selection summary');
    wcBtn.textContent = 'Σ';
    wcBtn.addEventListener('mousedown', (e) => e.preventDefault());
    wcBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const rec = this.visible;
      if (!rec) return;
      this.shell.focusSlot(this);
      openWordCount(rec.view);
    });
    footer.appendChild(wcBtn);
    this.wcEl = document.createElement('span');
    this.wcEl.className = 'pmd-pane-wc';
    this.wcEl.textContent = '—';
    footer.appendChild(this.wcEl);
    // Per-slot co-editing indicator (this doc's session status + who's here).
    // Empty/hidden until the slot's visible doc joins a session.
    this.copresenceEl = document.createElement('span');
    this.copresenceEl.className = 'pmd-pane-copresence';
    this.copresenceEl.hidden = true;
    footer.appendChild(this.copresenceEl);
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'pmd-pane-open';
    openBtn.title = 'Open a file into this slot';
    openBtn.textContent = '+ Open file';
    openBtn.addEventListener('mousedown', (e) => e.preventDefault());
    openBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.shell.openFileIntoSlot(this.id);
    });
    footer.appendChild(openBtn);
    this.paneEl.appendChild(footer);

    // Nav section (lives in the multi-nav rail at left of window).
    this.navSectionEl = document.createElement('section');
    this.navSectionEl.className = 'pmd-multi-nav-section';
    this.navSectionEl.dataset['slot'] = id;
    this.navSectionEl.hidden = true;
    // Clicking anywhere in the nav section focuses this slot —
    // same affordance as clicking the pane itself. Without this,
    // clicking a heading would scroll the doc into view but the
    // chrome (font-size chip, read-mode button, etc.) would
    // continue routing through whatever pane was previously
    // focused, which feels broken when the user is navigating
    // via the nav pane.
    this.navSectionEl.addEventListener('mousedown', () => this.shell.focusSlot(this));
    // Vertical resize handle along the section's TOP edge — drags
    // weight between this section and the visible one above it. The
    // topmost visible section's handle has nothing above it and is
    // hidden by `reconcileNavRail`.
    this.navResizeHandle = document.createElement('div');
    this.navResizeHandle.className = 'pmd-multi-nav-resize';
    this.navResizeHandle.setAttribute('role', 'separator');
    this.navResizeHandle.setAttribute('aria-orientation', 'horizontal');
    this.navResizeHandle.setAttribute('aria-label', 'Resize outline section');
    this.navResizeHandle.title = 'Drag to resize · double-click to reset';
    this.navResizeHandle.addEventListener('mousedown', (e) =>
      this.shell.beginNavSectionResize(this, e),
    );
    this.navResizeHandle.addEventListener('dblclick', () =>
      this.shell.resetNavSectionSizes(),
    );
    this.navSectionEl.appendChild(this.navResizeHandle);
    this.navBodyEl = document.createElement('div');
    this.navBodyEl.className = 'pmd-multi-nav-body';
    this.navSectionEl.appendChild(this.navBodyEl);
  }

  /** Sync the chip's expand button to the shell's current expand
   *  state. Driven by `MultiPaneShell.applyExpandedState`. */
  setExpandButtonPressed(pressed: boolean): void {
    this.chipExpandBtn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    this.chipExpandBtn.title = pressed
      ? 'Restore the multi-pane layout'
      : 'Expand this pane to fill the workspace';
  }

  /** Sync the chip's outline-toggle button + the section's flex weight
   *  to current per-slot state. Called by the shell's nav reconcile. */
  applyNavState(): void {
    const shown = !this.navHidden;
    this.chipNavBtn.setAttribute('aria-pressed', shown ? 'true' : 'false');
    this.chipNavBtn.title = shown
      ? "Hide this document's outline"
      : "Show this document's outline";
    this.navSectionEl.style.flexGrow = String(this.navFlex);
  }

  /** Toggle the resize handle. Hidden on the topmost visible section
   *  (no neighbour above to trade height with). */
  setResizeHandleEnabled(enabled: boolean): void {
    this.navResizeHandle.hidden = !enabled;
  }

  /** Live pixel height of the section in the rail (0 when hidden). */
  navSectionHeight(): number {
    return this.navSectionEl.getBoundingClientRect().height;
  }

  /** Read the visible ProseMirror element's content-area width and
   *  write it into `--pmd-card-intrinsic-width` on the pane root.
   *  Cards inside use this variable as the fallback for
   *  `contain-intrinsic-width` (paired with the `auto` keyword) so
   *  off-screen-never-rendered cards in a narrow multi-pane slot
   *  size close to the real card width rather than a fixed 600px.
   *
   *  Measuring the PM root (not `bodyEl`) is deliberate — bodyEl's
   *  `offsetWidth` includes scrollbar gutter AND doesn't subtract
   *  the editor's inner padding, so it overshoots a card's actual
   *  width by enough to be visible at the doc edge. PM root's
   *  `clientWidth` is scrollbar-independent and we subtract its
   *  computed padding to land exactly on the content box where
   *  cards lay out.
   *
   *  Called explicitly on (a) push, (b) shell window resize, (c)
   *  layout-mode change, (d) active-count change. Deliberately NOT
   *  driven by ResizeObserver — the variable write triggers a
   *  layout pass on every card, and ResizeObserver-driven updates
   *  produced a hard feedback loop where the pane body's measured
   *  width kept growing each iteration after the user clicked into
   *  the editor. Explicit triggers can't re-fire from our own
   *  mutations. */
  syncCardIntrinsicWidth(): void {
    if (this.paneEl.hidden) return;
    const rec = this.visible;
    if (!rec) return;
    const pmEl = rec.view.dom as HTMLElement;
    const cs = getComputedStyle(pmEl);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    const width = Math.round(pmEl.clientWidth - padL - padR);
    if (width <= 0) return;
    if (width === this.lastIntrinsicWidth) return;
    this.lastIntrinsicWidth = width;
    this.paneEl.style.setProperty('--pmd-card-intrinsic-width', `${width}px`);
  }

  /** Public read access to the editor-body element — the shell
   *  uses this to attach a scroll-sync listener for the
   *  comments-column relayout. Stays a private field structurally;
   *  this getter is the only sanctioned read path. */
  get bodyElement(): HTMLElement {
    return this.bodyEl;
  }

  /** The currently-visible doc record (or null when stack is empty). */
  get visible(): DocRecord | null {
    if (this.visibleIndex < 0 || this.visibleIndex >= this.stack.length) return null;
    return this.stack[this.visibleIndex]!;
  }

  /** Adopt a freshly-built DocRecord into this slot's stack. New doc
   *  becomes the visible one; previously-visible (if any) drops into
   *  the stack but its EditorView stays live (memory-resident). */
  push(record: DocRecord): void {
    // Detach the OLD visible record first — `detachVisible` reads
    // `this.visible`, which derives from `visibleIndex`, so it must
    // run before we push the new record and shift the index.
    // Otherwise the old record's `editorEl` stays in `bodyEl` and
    // `mountVisible` appends the new one alongside it, rendering
    // both docs on top of each other.
    this.detachVisible();
    this.stack.push(record);
    record.owner = this; // keep the dispatch closure pointed at the live slot
    this.visibleIndex = this.stack.length - 1;
    this.mountVisible();
    // Visibility is owned by the shell: when expand mode is active,
    // a newly-populated non-expanded slot stays hidden until the
    // user restores the multi-pane layout. The shell's
    // notifySlotPopulated does the right thing either way.
    this.shell.notifySlotPopulated(this);
    this.shell.focusSlot(this);
  }

  /** Switch the visible doc to the given record. */
  showRecord(record: DocRecord): void {
    const idx = this.stack.indexOf(record);
    if (idx < 0) return;
    if (idx === this.visibleIndex) return;
    this.detachVisible();
    this.visibleIndex = idx;
    this.mountVisible();
    this.shell.focusSlot(this);
  }

  /** Cycle the visible doc within this slot's stack by `delta`
   *  (+1 = next, -1 = previous, wraps around at the ends). No-op
   *  when the stack has 0 or 1 docs. Used by Ctrl+Tab / Ctrl+Shift-
   *  Tab in the focused slot. Routes through `showRecord` so the
   *  shared chrome / focus dance fires the same way as a click on
   *  the stack-dropdown menu would. */
  cycleVisible(delta: 1 | -1): void {
    if (this.stack.length < 2) return;
    if (this.visibleIndex < 0) return;
    const len = this.stack.length;
    const next = (this.visibleIndex + delta + len) % len;
    this.showRecord(this.stack[next]!);
  }

  /** Detach the visible record from this slot WITHOUT destroying
   *  its view — used by send-to-slot to hand the record to another
   *  slot. Mirrors `closeVisible` minus the destroy / journal-drop
   *  steps (the doc keeps living; only its host slot changes).
   *  Returns the released record, or null if nothing was visible. */
  releaseVisible(): DocRecord | null {
    const idx = this.visibleIndex;
    if (idx < 0) return null;
    const record = this.stack[idx]!;
    this.detachVisible();
    this.stack.splice(idx, 1);
    if (this.stack.length === 0) {
      this.visibleIndex = -1;
      this.paneEl.hidden = true;
      // Reset the per-slot outline-closed flag so a doc opened into
      // this slot later starts with its outline shown.
      this.navHidden = false;
      this.shell.notifySlotEmptied(this);
      this.shell.reconcileNavRail();
      this.shell.refreshLayout();
      this.shell.handleSlotEmptied(this);
      return record;
    }
    this.visibleIndex = Math.min(idx, this.stack.length - 1);
    this.mountVisible();
    return record;
  }

  /** Close the currently-visible doc. Reveals the next stack member
   *  (or empties the slot). Prompts for save / discard / cancel if
   *  the doc has unsaved changes; clean docs close immediately. */
  async closeVisible(opts?: { modeSwitch?: boolean }): Promise<boolean> {
    try {
      return await this.closeVisibleInner(opts);
    } catch (err) {
      // Fail safe: a crash mid-close must read as "didn't close" (false)
      // with a visible reason — not a silently dead ✕ click. Same
      // never-reject contract as the hardened save flows.
      console.error('Pane close crashed:', err);
      void alertDialog(
        `Couldn't close this document: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
  }

  private async closeVisibleInner(opts?: { modeSwitch?: boolean }): Promise<boolean> {
    const idx = this.visibleIndex;
    if (idx < 0) return false;
    const closing = this.stack[idx]!;
    // During a mode-switch reduce we suppress the session-aware close: the
    // toggle is a full reload that persists every session (resumable, and the
    // kept doc auto-resumes), so prompting per co-edited pane would be noise —
    // but a DIRTY non-focused doc still gets its normal save prompt below.
    const coedited = !opts?.modeSwitch && collabCopresenceFor(closing.uid) != null;
    // Focus this pane so the confirm dialogs + save commands (which route via
    // `activeFile()`) target THIS doc, not whichever pane happened to be focused
    // when the user clicked ×.
    if (coedited || closing.dirty) this.shell.focusSlot(this);
    // Unsaved-file prompt (save / save-as / discard / cancel). Returns false to
    // abort the close.
    const runDirtyPrompt = async (): Promise<boolean> => {
      const choice = await confirmCloseUnsaved();
      if (choice === 'cancel') return false;
      if (choice === 'save') return runSaveFlow();
      if (choice === 'saveAs') return runSaveAsFlow();
      return true; // discard: fall through; existing journal-clear path runs.
    };
    if (coedited) {
      // Session-aware close: keep it resumable, or end/leave. Naming the doc.
      const co = await resolveCoEditedClose(closing.uid, closing.filename);
      if (co === 'cancel') return false;
      // 'keep' → the session record holds the content; close without a file
      // prompt. 'run-normal' → the session was ended/left; still offer to save
      // the local file if it's dirty.
      if (co === 'run-normal' && closing.dirty && !(await runDirtyPrompt())) return false;
    } else if (closing.dirty && !(await runDirtyPrompt())) {
      return false;
    }
    this.detachVisible();
    if (closing.heavyUpdateTimer !== null) {
      cancelIdle(closing.heavyUpdateTimer);
      closing.heavyUpdateTimer = null;
    }
    if (closing.journalTimer !== null) {
      window.clearTimeout(closing.journalTimer);
      closing.journalTimer = null;
    }
    if (closing.autosaveTimer !== null) {
      window.clearTimeout(closing.autosaveTimer);
      closing.autosaveTimer = null;
    }
    // Explicit close → drop the journal. Recovery is for crashes,
    // not "I changed my mind." If the user wanted to keep this
    // doc, they should have saved.
    void clearJournalForRecord(closing);
    // Clear speech-doc designation if the closing doc was it —
    // matches Verbatim's `AutoClose` which clears
    // `Globals.ActiveSpeechDoc` when the speech doc is closed.
    const speechResolver = getSpeechDocResolver();
    if (speechResolver.isSpeechByUid(closing.uid)) {
      speechResolver.setSpeechByUid(null);
    }
    speechResolver.unregisterView(closing.uid);
    // Release the cross-window path claim before destroying the
    // view — re-opening this file in any window should succeed.
    syncDocPathClaim(closing.handle, null);
    closing.view.destroy();
    closing.dragSurface.detach();
    closing.navPanel.destroy();
    this.stack.splice(idx, 1);
    if (this.stack.length === 0) {
      this.visibleIndex = -1;
      this.paneEl.hidden = true;
      // Reset the per-slot outline-closed flag so a doc opened into
      // this slot later starts with its outline shown.
      this.navHidden = false;
      // If this empty slot was the expanded one, exit expand mode —
      // no doc to expand any more.
      this.shell.notifySlotEmptied(this);
      this.shell.reconcileNavRail();
      this.shell.refreshLayout();
      // If this slot was focused, hand focus to the next active slot.
      this.shell.handleSlotEmptied(this);
      return true;
    }
    // Show the next-newest doc (the one that was second-from-top).
    this.visibleIndex = Math.min(idx, this.stack.length - 1);
    this.mountVisible();
    this.shell.focusSlot(this);
    return true;
  }

  /** Close every doc in this slot except `keep` (if it lives here),
   *  prompting save / discard for dirty ones. Returns false as soon as
   *  the user cancels a prompt (leaving the remaining docs open), true
   *  when the slot is reduced to `keep` (or empty). Used by the web
   *  mode-switch to collapse three-pane down to the focused doc. */
  async closeAllExcept(keep: DocRecord | null, opts?: { modeSwitch?: boolean }): Promise<boolean> {
    // Snapshot: closeVisible mutates the stack + visibleIndex as it goes.
    for (const rec of this.stack.filter((r) => r !== keep)) {
      if (!this.stack.includes(rec)) continue; // already closed (defensive)
      this.showRecord(rec); // make it visible so its save prompt is in context
      if (!(await this.closeVisible(opts))) return false; // user cancelled
    }
    return true;
  }

  /** App-quit path: prompt to save each DIRTY doc in this slot's stack, WITHOUT
   *  closing anything (the window is about to close, and sessions persist on
   *  quit, so no session dialog). Returns false if the user cancels a prompt or
   *  a save fails — the quit aborts and the workspace is left intact. Discard
   *  drops that doc's recovery journal so it doesn't resurface next launch. */
  async promptSaveDirtyForQuit(): Promise<boolean> {
    for (const rec of [...this.stack]) {
      if (!rec.dirty) continue;
      this.showRecord(rec); // surface it so the prompt has context
      this.shell.focusSlot(this); // save commands route via the focused doc
      const choice = await confirmCloseUnsaved();
      if (choice === 'cancel') return false;
      if (choice === 'save') {
        if (!(await runSaveFlow())) return false;
      } else if (choice === 'saveAs') {
        if (!(await runSaveAsFlow())) return false;
      } else if (choice === 'discard') {
        void clearJournalForRecord(rec);
      }
    }
    return true;
  }

  /** Detach the currently-mounted record's DOM (without destroying
   *  its view — the view stays live for fast swap-back). */
  private detachVisible(): void {
    const rec = this.visible;
    if (!rec) return;
    if (rec.editorEl.parentElement === this.bodyEl) {
      // Capture BEFORE removeChild — detaching collapses the
      // scroller's content and the browser clamps scrollTop to 0.
      rec.savedScrollTop = this.bodyEl.scrollTop;
      this.bodyEl.removeChild(rec.editorEl);
    }
    if (rec.navEl.parentElement === this.navBodyEl) {
      this.navBodyEl.removeChild(rec.navEl);
    }
    // Closing the last doc in a slot needs to drop that filename
    // out of the all-slots OS window title. mountVisible refreshes
    // when a new doc replaces the old one, but detachVisible
    // covers the close-with-no-replacement case.
    refreshWindowTitle();
  }

  /** Mount the currently-visible record's editor + nav DOM into the
   *  slot's body / nav section. Updates the chip + word count. */
  private mountVisible(): void {
    const rec = this.visible;
    if (!rec) return;
    this.bodyEl.appendChild(rec.editorEl);
    // After the append, so the restored content height is what the
    // browser clamps against.
    this.bodyEl.scrollTop = rec.savedScrollTop;
    this.navBodyEl.appendChild(rec.navEl);
    this.chipNameEl.textContent = rec.filename;
    this.refreshChip();
    this.refreshWordCount();
    this.refreshCopresence();
    // Speech-chip class lives on the pane element and reflects
    // the currently-visible record vs the speech-doc registry;
    // swapping records via the stack switcher needs to refresh.
    this.shell.refreshSpeechChips();
    // The OS window title summarizes every open slot's filename in
    // multi-pane mode — refresh it on every mount so opening a new
    // doc in a non-focused slot still updates the title bar.
    refreshWindowTitle();
  }

  /** Update the chip's stack-dropdown trigger visibility based on
   *  current stack depth. */
  refreshChip(): void {
    const multi = this.stack.length > 1;
    this.chipStackBtn.hidden = !multi;
    if (multi) {
      this.chipStackBtn.replaceChildren(icon('chevron-down'), document.createTextNode(` ${this.stack.length}`));
    } else {
      setIcon(this.chipStackBtn, 'chevron-down');
    }
  }

  /** Re-render the chip's filename label from the visible record.
   *  Called after Save-As updates `record.filename` so the chip
   *  reflects the user's chosen name. No-op while a title override
   *  (research browser) is active. */
  refreshChipFilename(): void {
    if (this.chipTitleOverride !== null) return;
    const rec = this.visible;
    if (!rec) return;
    this.chipNameEl.textContent = rec.filename;
  }

  /** Force the chip's title to `text` regardless of the visible doc's
   *  filename (or restore normal filename display when `text` is
   *  null) — used by the research browser, which takes over this
   *  pane's screen area but shouldn't masquerade as the underlying
   *  document. */
  setChipTitleOverride(text: string | null): void {
    this.chipTitleOverride = text;
    if (text !== null) {
      this.chipNameEl.textContent = text;
    } else {
      this.refreshChipFilename();
      if (this.stack.length === 0) this.chipNameEl.textContent = '';
    }
  }

  /** Paint this slot footer's co-editing indicator from its VISIBLE record's
   *  session — status text + one presence dot per person — or hide it when that
   *  doc has no live session. Focus-independent: a slot always shows its own
   *  doc's state, so swapping the stack's visible tab to a non-session doc hides
   *  it while another doc's session (in the same slot's stack) keeps syncing. */
  refreshCopresence(): void {
    const uid = this.visible?.uid ?? null;
    const cp = uid ? collabCopresenceFor(uid) : null;
    if (!cp) {
      this.copresenceEl.hidden = true;
      this.copresenceEl.replaceChildren();
      return;
    }
    this.copresenceEl.hidden = false;
    const text = cp.connected
      ? cp.queued > 0
        ? `Sending ${cp.queued}…`
        : 'Synced'
      : cp.queued > 0
        ? `Offline · ${cp.queued}`
        : 'Offline';
    const labelEl = document.createElement('span');
    labelEl.className = 'pmd-pane-copresence-label';
    labelEl.textContent = text;
    // Reuse the status-bar chip's dot classes so per-slot and single-pane
    // presence read identically.
    const dots = document.createElement('span');
    dots.className = 'pmd-collab-chip-dots';
    for (const p of cp.peers) {
      const dot = document.createElement('span');
      dot.className = 'pmd-collab-presence-dot' + (p.self ? ' pmd-collab-presence-dot-self' : '');
      dot.style.background = p.color;
      dot.title = p.self ? `${p.name} (you)` : p.name;
      dots.appendChild(dot);
    }
    this.copresenceEl.replaceChildren(labelEl, dots);
  }

  /** Whole-doc word count keyed on doc identity, so the cursor-move
   *  refreshes `liveContainerReadTime` triggers don't re-walk the doc
   *  (single-pane's `lastWholeDocWords` equivalent — one slot per pane
   *  suffices; the doc reference distinguishes stacked docs too). */
  private wcDocCache: { doc: PMNode; counts: ReadAloudCounts } | null = null;

  /** Recompute and display the visible doc's word count + read times
   *  for the first two configured readers. */
  refreshWordCount(): void {
    const rec = this.visible;
    if (!rec) {
      this.wcEl.textContent = '—';
      return;
    }
    const sel = rec.view.state.selection;
    // Selection-aware readout is opt-in (`liveSelectionWordCount`),
    // matching single-pane: when off, always show the whole-doc count
    // regardless of any selection (the Σ button covers selection counts
    // on demand).
    const hasSel = settings.get('liveSelectionWordCount') && !sel.empty;
    let counts: ReadAloudCounts;
    if (hasSel) {
      counts = countReadAloudSplit(rec.view.state.doc, sel.from, sel.to);
    } else if (this.wcDocCache && this.wcDocCache.doc === rec.view.state.doc) {
      counts = this.wcDocCache.counts;
    } else {
      counts = countReadAloudSplit(rec.view.state.doc);
      this.wcDocCache = { doc: rec.view.state.doc, counts };
    }
    const words = totalWords(counts);
    const readers = settings.get('readers').slice(0, 2);
    // "Doc:" label while the container segment is enabled, mirroring
    // single-pane; bare number when off (the pre-feature look).
    const head = hasSel
      ? `Sel: ${formatNumber(words)}`
      : settings.get('liveContainerReadTime')
        ? `Doc: ${formatNumber(words)}`
        : formatNumber(words);
    const parts = [head];
    for (const r of readers) {
      parts.push(`${r.name}: ${formatReadTimeFor(counts, r)}`);
    }
    const container = liveContainerSegment(rec.view.state);
    this.wcEl.textContent = container
      ? `${parts.join(' · ')} | ${container}`
      : parts.join(' · ');
  }

  /** Open a small dropdown over the chip listing every doc in this
   *  slot's stack. Each entry switches the visible doc; each carries
   *  a × icon that closes that entry. */
  private openStackDropdown(): void {
    closeOpenStackDropdown();
    const dropdown = document.createElement('div');
    dropdown.className = 'pmd-pane-chip-dropdown';
    for (const rec of this.stack) {
      const row = document.createElement('div');
      row.className = 'pmd-pane-chip-dropdown-row';
      if (rec === this.visible) row.classList.add('pmd-active');
      const name = document.createElement('span');
      name.className = 'pmd-pane-chip-dropdown-name';
      name.textContent = rec.filename;
      name.addEventListener('click', () => {
        closeOpenStackDropdown();
        this.showRecord(rec);
      });
      row.appendChild(name);
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'pmd-pane-chip-dropdown-close';
      setIcon(close, 'close');
      close.title = 'Close this document';
      close.addEventListener('mousedown', (e) => e.preventDefault());
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        closeOpenStackDropdown();
        void this.closeRecord(rec);
      });
      row.appendChild(close);
      dropdown.appendChild(row);
    }
    document.body.appendChild(dropdown);
    const rect = this.chipStackBtn.getBoundingClientRect();
    dropdown.style.position = 'absolute';
    dropdown.style.top = `${rect.bottom + window.scrollY + 2}px`;
    dropdown.style.left = `${rect.left + window.scrollX}px`;
    openStackDropdownEl = dropdown;
    const onDoc = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && dropdown.contains(t)) return;
      closeOpenStackDropdown();
      document.removeEventListener('pointerdown', onDoc);
    };
    setTimeout(() => document.addEventListener('pointerdown', onDoc), 0);
  }

  /** Close a specific record (not necessarily the visible one).
   *  Prompts if the record has unsaved changes. */
  async closeRecord(rec: DocRecord): Promise<void> {
    const idx = this.stack.indexOf(rec);
    if (idx < 0) return;
    if (idx === this.visibleIndex) {
      await this.closeVisible();
      return;
    }
    if (rec.dirty) {
      // Surface the doc so the user can see what they're being
      // asked about, AND so save commands route to it.
      this.showRecord(rec);
      this.shell.focusSlot(this);
      await this.closeVisible();
      return;
    }
    // A CLEAN co-edited doc still needs the session-aware close (keep /
    // end / leave) — the raw teardown below would destroy the view out from
    // under a live session with no dialog and nothing persisted. Same
    // surface-first treatment as dirty (audit find, 2026-07-10).
    if (collabCopresenceFor(rec.uid) != null) {
      this.showRecord(rec);
      this.shell.focusSlot(this);
      await this.closeVisible();
      return;
    }
    if (rec.heavyUpdateTimer !== null) {
      cancelIdle(rec.heavyUpdateTimer);
      rec.heavyUpdateTimer = null;
    }
    if (rec.autosaveTimer !== null) {
      window.clearTimeout(rec.autosaveTimer);
      rec.autosaveTimer = null;
    }
    // Clear speech-doc designation if the closing record was it.
    const speechResolver = getSpeechDocResolver();
    if (speechResolver.isSpeechByUid(rec.uid)) {
      speechResolver.setSpeechByUid(null);
    }
    speechResolver.unregisterView(rec.uid);
    syncDocPathClaim(rec.handle, null);
    rec.view.destroy();
    rec.dragSurface.detach();
    rec.navPanel.destroy();
    this.stack.splice(idx, 1);
    if (idx < this.visibleIndex) this.visibleIndex--;
    this.refreshChip();
  }
}

/** Run a record's debounced heavy-update work NOW (nav rebuild +
 *  word-count refresh), cancelling the pending timer. Callers that
 *  need an immediate nav update must flush, not just cancel — the
 *  timer also owes the word-count refresh, and cancelling alone
 *  leaves the pane's count stale. */
function flushHeavyUpdateNow(record: DocRecord): void {
  if (record.heavyUpdateTimer !== null) {
    cancelIdle(record.heavyUpdateTimer);
    record.heavyUpdateTimer = null;
  }
  record.navPanel.update(record.view.state.doc);
  record.navPanel.setCaretHeading(
    record.view.state.selection.from,
    selfRefSelectionPos(record.view.state),
    { preserveMultiSelect: true }, // positional resync, not a caret move
  );
  record.owner.refreshWordCount();
}

let openStackDropdownEl: HTMLElement | null = null;
function closeOpenStackDropdown(): void {
  if (!openStackDropdownEl) return;
  openStackDropdownEl.remove();
  openStackDropdownEl = null;
}

/** Last-applied value of the global `markUnreadAfterMarker` toggle, so the
 *  shell only rebuilds pane decorations when it actually flips. */
let shellLastMarkUnread = settings.get('markUnreadAfterMarker');
let shellLastNumberingSig = numberingDisplaySig();

class MultiPaneShell {
  private slots: Record<SlotId, Slot>;
  private shellEl: HTMLElement;
  private navRailEl: HTMLElement;
  private rowEl: HTMLElement;
  private focusedSlot: Slot | null = null;
  /** Active scroll listener for the comments-column relayout —
   *  bound to the focused pane's `.pmd-pane-body`. Single
   *  outstanding listener; focus changes tear down the old one
   *  before installing the new. Null when no pane is focused. */
  private focusedScrollSync: {
    body: HTMLElement;
    handler: () => void;
    rafId: number | null;
  } | null = null;
  private layoutMode: 'compact' | 'wide';
  /** When non-null, the named slot is "expanded" — visible on its
   *  own with every other pane + nav-section hidden, regardless of
   *  whether those slots have docs loaded. Click the chip's expand
   *  button again to restore the normal multi-pane layout. */
  private expandedSlot: Slot | null = null;
  /** When non-null, this EMPTY slot is being held open for the
   *  research browser to dock into — counted as "active" for layout
   *  purposes (column count, wide-mode peek) exactly like a slot with
   *  a real doc loaded, even though `stack.length === 0`. Set by
   *  `openResearchBrowserPane`, cleared by `closeResearchBrowserPane`. */
  private researchBrowserSlot: SlotId | null = null;
  private unsubscribeSettings: (() => void) | null = null;
  /** Doc-switcher overlay — the Alt+Tab-style list that opens
   *  when the user presses Ctrl+Tab while the focused slot has
   *  2+ docs. Created in the constructor. */
  private docSwitcher!: DocSwitcherOverlay;

  constructor() {
    this.layoutMode = settings.get('multiDocLayoutMode');
    // Build the shell DOM and mount it into #app, alongside the
    // (now-hidden) single-doc surfaces.
    const app = document.getElementById('app')!;
    this.shellEl = document.createElement('div');
    this.shellEl.id = 'multi-pane-shell';
    this.shellEl.className = 'pmd-multi-shell';
    this.shellEl.dataset['layout'] = this.layoutMode;
    app.appendChild(this.shellEl);

    // Nav rail sits at the window's left edge, OUTSIDE the existing
    // #nav-panel (which is hidden in multi-doc mode). Use absolute
    // positioning via CSS to align it with the window edge.
    this.navRailEl = document.createElement('aside');
    this.navRailEl.className = 'pmd-multi-nav';
    document.body.appendChild(this.navRailEl);
    // The per-section NavigationPanels each build their own resize handle,
    // but those are hidden in multi-doc (the sections share the rail evenly
    // and have no independent width). Give the rail one handle that resizes
    // the whole rail via the shared `--nav-width` — same variable the
    // single-doc panel uses, so the setting carries across layouts.
    installNavResizeHandle(this.navRailEl);

    // Pane row (the three editor panes).
    this.rowEl = document.createElement('div');
    this.rowEl.className = 'pmd-multi-row';
    this.rowEl.dataset['layout'] = this.layoutMode;
    this.shellEl.appendChild(this.rowEl);

    // Adopt the shared `#comments-column` as a sibling of the
    // multi-row so the multi-shell becomes
    // `[panes-row | comments-column]`. Visually the column reads
    // like a narrow fourth slot that shrinks the three doc panes
    // equally. Its visibility follows the same `commentsVisible`
    // setting as single-pane (it's hidden via the `hidden` attr
    // when the user toggles it off). Cards re-layout against the
    // focused pane's scroll via `attachFocusedScrollSync`, since
    // the column doesn't share a scroll container with any pane.
    const commentsEl = getCommentsColumnEl();
    if (commentsEl) {
      this.shellEl.appendChild(commentsEl);
      commentsEl.hidden = !settings.get('commentsVisible');
    }

    this.slots = {
      slot1: new Slot('slot1', this),
      slot2: new Slot('slot2', this),
      slot3: new Slot('slot3', this),
    };
    for (const id of SLOT_IDS) {
      this.rowEl.appendChild(this.slots[id].paneEl);
      this.navRailEl.appendChild(this.slots[id].navSectionEl);
    }
    // Repaint every slot footer's co-editing indicator whenever a session's
    // status/presence changes or one starts/ends. The shell is a lifetime
    // singleton (mountMultiPaneShell early-returns if built), so this
    // subscription never needs tearing down.
    onCollabCopresenceChange(() => {
      for (const id of SLOT_IDS) this.slots[id].refreshCopresence();
    });
    // Carry a persisted "nav hidden" preference into three-pane: start every
    // section closed so the rail — and the global toggle — reflect it. The
    // global toggle / per-slot toggles reopen them (reconcileNavRail syncs
    // `navPaneVisible` back to the aggregate).
    if (!settings.get('navPaneVisible')) {
      for (const id of SLOT_IDS) this.slots[id].navHidden = true;
    }

    this.unsubscribeSettings = settings.subscribe((s) => {
      if (s.multiDocLayoutMode !== this.layoutMode) {
        this.layoutMode = s.multiDocLayoutMode;
        this.shellEl.dataset['layout'] = this.layoutMode;
        this.rowEl.dataset['layout'] = this.layoutMode;
        // Layout mode swap → pane widths change → re-sync card
        // intrinsic widths so skipped cards aren't sized for the
        // OLD layout's pane width.
        this.scheduleSyncAllCardIntrinsicWidths();
      }
      // Pane word counts depend on reader settings.
      for (const id of SLOT_IDS) this.slots[id].refreshWordCount();
      // Editor spellcheck is served by the viewport-spellcheck plugin
      // (in buildEditorPlugins), which subscribes to `editorSpellcheck`
      // itself — nothing to push to the views here.
      // Read-mode is per-pane in multi-doc — flipped via the
      // ribbon command's `toggleReadMode` hook below — so we
      // deliberately ignore changes to the global
      // `settings.readMode` here. Otherwise toggling read mode in
      // one pane would force every other open doc into the same
      // state.
      // The `pmd-rm-no-emphasis-borders` and `pmd-rm-para-integrity`
      // flags ARE settings-driven (display preferences, not per-doc),
      // so when they change we re-stamp the classes on every
      // currently-read-mode'd pane to match.
      const hideEmphasisBorders = s.hideEmphasisBordersInReadMode;
      const readParagraphIntegrity = s.readModeParagraphIntegrity;
      for (const id of SLOT_IDS) {
        for (const rec of this.slots[id].stack) {
          if (rec.readMode) {
            rec.editorEl.classList.toggle(
              'pmd-rm-no-emphasis-borders',
              hideEmphasisBorders,
            );
            rec.editorEl.classList.toggle(
              'pmd-rm-para-integrity',
              readParagraphIntegrity,
            );
          }
        }
      }
      // The mark-unread toggle is settings-driven (a global display pref);
      // when it flips, nudge every pane's plugin to rebuild. Diff-gated
      // because the rebuild is O(doc): don't fire on unrelated settings changes.
      if (s.markUnreadAfterMarker !== shellLastMarkUnread) {
        shellLastMarkUnread = s.markUnreadAfterMarker;
        for (const id of SLOT_IDS) {
          for (const rec of this.slots[id].stack) {
            rec.view.dispatch(rec.view.state.tr.setMeta(MARK_UNREAD_TOGGLE, true));
          }
        }
      }
      // Numbering display changed (on/off, format, indent, color mode):
      // rebuild every pane's decorations — including hidden stacked docs,
      // whose views are live. Without this, only the focused view (nudged
      // by the single-doc subscriber) would repaint; with the display-off
      // gate in the plugin state, a hidden doc toggled on would otherwise
      // show no numbers until its next edit.
      const numberingSig = numberingDisplaySig();
      if (numberingSig !== shellLastNumberingSig) {
        shellLastNumberingSig = numberingSig;
        for (const id of SLOT_IDS) {
          for (const rec of this.slots[id].stack) {
            rec.view.dispatch(rec.view.state.tr.setMeta(NUMBERING_REFRESH, true));
          }
        }
      }
      // Nav drag changes available pane width — re-sync.
      this.scheduleSyncAllCardIntrinsicWidths();
    });

    // Tell the single-doc index.ts how to query "what should the
    // read-mode button show?" — in multi-doc that's the focused
    // pane's per-doc state, not the global setting.
    setReadModeStateResolver(() => this.focusedSlot?.visible?.readMode ?? false);
    // Same story for the status-bar zoom readout — it reflects the focused
    // pane's per-pane zoom (the shell refreshes it on focus change).
    setZoomStateResolver(
      () => this.focusedSlot?.visible?.zoomPct ?? settings.get('defaultZoomPct'),
    );
    // Same story for the autosave button — per-pane in multi-doc.
    setAutosaveStateResolver(() => this.focusedSlot?.visible?.autosaveEnabled ?? false);
    // Find-bar nav highlights land on the focused pane's own nav
    // panel; other panes don't share the find-bar's state.
    setActiveNavPanelResolver(() => this.focusedSlot?.visible?.navPanel ?? null);

    // Keep the speech chip / button state in sync with the
    // registry — the registry fires on every set/clear, including
    // ones the shell itself initiated.
    getSpeechDocResolver().subscribe(() => this.refreshSpeechChips());

    // Window resize is the other event that legitimately changes
    // pane widths. Deliberately NOT a ResizeObserver — see the doc
    // comment on Slot.syncCardIntrinsicWidth for why.
    window.addEventListener('resize', this.onWindowResize);

    // Build the doc-switcher overlay element (Alt+Tab-style list)
    // and stash a reference. The overlay is hidden until
    // `onDocCycleKey` opens it, then survives across Ctrl-Tab
    // chord presses for the duration of the user's Ctrl hold.
    this.docSwitcher = new DocSwitcherOverlay();

    // Mod-Tab / Mod-Shift-Tab cycle the visible doc within the
    // focused slot via the doc-switcher overlay (Alt+Tab-style
    // hold-and-press). Listener stays on `window` instead of
    // going through the ribbon-keymap path the other multi-pane
    // shortcuts use, because the overlay needs to track the
    // modifier hold and respond on keyup — which the discrete
    // single-press ribbon path can't model. The other multi-pane
    // shortcuts (slot focus, send-to-slot, expand toggle, smart
    // close) all go through the ribbon registry and are
    // user-rebindable in Settings → Keybindings.
    window.addEventListener("keydown", this.onDocCycleKey);
    window.addEventListener("keyup", this.onDocCycleKeyUp);

    // Drag-hover focus + post-drop collapse:
    //
    //   - On 'move': the controller's hoverTarget tells us which
    //     view the drop will land in. When the user hovers over
    //     a pane (even before releasing), focus that pane so the
    //     ribbon / chrome retarget. Stash the source/target views
    //     too so we can detect cross-view drops on 'end'.
    //   - On 'end': if this was a cross-view drop, apply the
    //     destination pane's outline-level filter to the freshly-
    //     dropped headings (which got fresh IDs via
    //     rewriteHeadingIds). Existing user expansions stay.
    let lastSourceView: EditorView | null = null;
    let lastTargetView: EditorView | null = null;
    dragController.subscribe((event) => {
      if (event === 'begin') {
        const session = dragController.getSession();
        lastSourceView = session?.view ?? null;
        lastTargetView = null;
      } else if (event === 'move') {
        const target = dragController.getHoverTarget();
        if (target) {
          lastTargetView = target.view;
          const slot = this.findSlotByView(target.view);
          if (slot && this.focusedSlot !== slot) this.focusSlot(slot);
        }
      } else if (event === 'end') {
        if (
          lastSourceView &&
          lastTargetView &&
          lastSourceView !== lastTargetView
        ) {
          const targetSlot = this.findSlotByView(lastTargetView);
          if (targetSlot?.visible) {
            const rec = targetSlot.visible;
            // ORDER CONSTRAINT: the collapse diff must run BEFORE any
            // render of the post-drop doc — every render refreshes the
            // nav's seen-ids baseline, so a render first makes the
            // dropped headings look "already seen" and the collapse
            // no-ops (the drop then lands fully expanded, ignoring the
            // pane's depth setting). applyMaxLevelToNewHeadings reads
            // view.state.doc directly and re-renders itself; the flush
            // afterwards still pays the caret resync + word count the
            // debounced timer owes.
            rec.navPanel.applyMaxLevelToNewHeadings();
            flushHeavyUpdateNow(rec);
          }
        }
        lastSourceView = null;
        lastTargetView = null;
      }
    });

    // First active slot gets focus by default once a doc lands.
  }

  private findSlotByView(view: EditorView): Slot | null {
    for (const id of SLOT_IDS) {
      if (this.slots[id].visible?.view === view) return this.slots[id];
    }
    return null;
  }

  /** Walk every slot's stack — visible AND background — to find
   *  the record that owns the given view. Used by send-to-speech
   *  so it can re-mount the speech record in its slot if a
   *  different record from the same stack is currently visible
   *  (otherwise the dispatch lands in a detached editor, focus
   *  doesn't transfer, and Ctrl-Z reaches the source pane's
   *  empty history instead of the speech doc's). */
  private findRecordForView(view: EditorView): { slot: Slot; record: DocRecord } | null {
    for (const id of SLOT_IDS) {
      const slot = this.slots[id];
      for (const rec of slot.stack) {
        if (rec.view === view) return { slot, record: rec };
      }
    }
    return null;
  }

  /** Refresh the data-attribute count on the row, used by CSS to
   *  size each pane based on how many slots are active. */
  refreshLayout(): void {
    // When a slot is expanded, the layout collapses to "one active
    // pane" regardless of how many other slots have docs loaded —
    // those panes are hidden but kept around so the user can pop
    // back to the normal layout with the same docs intact.
    const active = this.expandedSlot
      ? 1
      : SLOT_IDS.filter(
          (id) => this.slots[id].stack.length > 0 || id === this.researchBrowserSlot,
        ).length;
    this.rowEl.dataset['active'] = String(active);
    this.navRailEl.dataset['active'] = String(active);
    // Active-count change → pane widths change → re-sync.
    this.scheduleSyncAllCardIntrinsicWidths();
  }

  /** Toggle expand mode on `slot`. If the same slot is already
   *  expanded, this restores the normal layout. If a different slot
   *  is expanded, the expansion moves to the new slot. */
  toggleExpanded(slot: Slot): void {
    if (this.expandedSlot === slot) this.setExpandedSlot(null);
    else this.setExpandedSlot(slot);
  }

  /** Set (or clear) the expanded slot and re-apply hidden states
   *  and CSS hooks on every pane + nav section. */
  private setExpandedSlot(slot: Slot | null): void {
    // A slot with an empty stack has nothing to show — refuse the
    // request rather than expanding to a blank pane.
    if (slot && slot.stack.length === 0) return;
    this.expandedSlot = slot;
    this.applyExpandedState();
  }

  /** Reconcile per-slot pane / nav-section visibility with the
   *  current expand state. When `expandedSlot` is set, only that
   *  slot's pane + nav section are shown; otherwise visibility
   *  reverts to "has a doc loaded → shown". Also keeps every
   *  chip's expand-button aria-pressed flag in sync, and writes a
   *  `data-expanded` attribute on the row + nav rail so CSS can
   *  hook on it. Refreshes the layout count afterwards. */
  private applyExpandedState(): void {
    const expanded = this.expandedSlot;
    for (const id of SLOT_IDS) {
      const slot = this.slots[id];
      const show = expanded
        ? slot === expanded
        : slot.stack.length > 0 || id === this.researchBrowserSlot;
      slot.paneEl.hidden = !show;
      slot.setExpandButtonPressed(slot === expanded);
    }
    if (expanded) {
      this.rowEl.dataset['expanded'] = expanded.id;
      this.navRailEl.dataset['expanded'] = expanded.id;
    } else {
      delete this.rowEl.dataset['expanded'];
      delete this.navRailEl.dataset['expanded'];
    }
    // Nav-section visibility (per-slot, honours navHidden) is owned by
    // reconcileNavRail; pane visibility above stays independent.
    this.reconcileNavRail();
    this.refreshLayout();
    if (expanded) this.focusSlot(expanded);
  }

  /** Count of visible nav sections at the last reconcile — used to
   *  detect a composition change (open / close / hide / show) so we
   *  can re-even the vertical split. */
  private lastNavVisibleCount = -1;

  /** Single source of truth for which nav sections show in the rail,
   *  their vertical split, their resize handles, and whether the rail
   *  itself is shown at all. Derives visibility from: expand mode →
   *  only the expanded slot; otherwise every slot with a loaded doc —
   *  minus any the user has individually closed (`navHidden`). */
  reconcileNavRail(): void {
    const expanded = this.expandedSlot;
    const visible: Slot[] = [];
    for (const id of SLOT_IDS) {
      const slot = this.slots[id];
      const showByLayout = expanded ? slot === expanded : slot.stack.length > 0;
      const show = showByLayout && !slot.navHidden;
      slot.navSectionEl.hidden = !show;
      if (show) visible.push(slot);
    }
    // Composition changed → reset to an even split so a reopened or
    // newly-opened section doesn't inherit a stale, lopsided weight.
    if (visible.length !== this.lastNavVisibleCount) {
      for (const id of SLOT_IDS) this.slots[id].navFlex = 1;
      this.lastNavVisibleCount = visible.length;
    }
    // The topmost visible section has no neighbour above to trade
    // height with, so it gets no resize handle.
    for (let i = 0; i < visible.length; i++) {
      visible[i]!.setResizeHandleEnabled(i > 0);
    }
    // Chip toggle pressed-state + flex weight apply to every slot (a
    // closed section's chip still needs to show the reopen affordance).
    for (const id of SLOT_IDS) this.slots[id].applyNavState();
    // Every open doc's outline closed → drop the rail so the editor row
    // reclaims its width; the CSS `pmd-multi-nav-empty` body class zeroes
    // `#app`'s left margin.
    const railEmpty = visible.length === 0;
    this.navRailEl.hidden = railEmpty;
    document.body.classList.toggle('pmd-multi-nav-empty', railEmpty);
    // Keep the GLOBAL nav toggle in step with the per-section state: it reads
    // "on" iff at least one section is shown, and its `pmd-nav-hidden` body
    // class drives the rail-hide + the left-edge pull-tab. This is what makes
    // the global toggle and the per-slot toggles cooperate — all sections
    // hidden == globally off — instead of overriding each other. Only sync
    // while a doc is actually open, so an empty workspace doesn't flash the
    // pull-tab. `navPaneVisible`'s subscriber (index.ts) applies the class.
    const anyDocOpen = SLOT_IDS.some((id) => this.slots[id].stack.length > 0);
    if (anyDocOpen && settings.get('navPaneVisible') === railEmpty) {
      settings.set('navPaneVisible', !railEmpty);
    }
    this.scheduleSyncAllCardIntrinsicWidths();
  }

  /** True if any OPEN document's outline section is currently closed. */
  private anyNavHidden(): boolean {
    return SLOT_IDS.some(
      (id) => this.slots[id].stack.length > 0 && this.slots[id].navHidden,
    );
  }

  /** Show or hide EVERY open document's outline section at once — the global
   *  nav toggle's action in three-pane. */
  setAllNavHidden(hidden: boolean): void {
    for (const id of SLOT_IDS) {
      if (this.slots[id].stack.length > 0) this.slots[id].navHidden = hidden;
    }
    this.reconcileNavRail();
  }

  /** Global nav toggle in three-pane: if any section is currently closed, show
   *  them all; otherwise (all shown) hide them all. So the toggle always
   *  restores the whole rail from a partial state and only hides when
   *  everything is already visible. */
  toggleAllNav(): void {
    this.setAllNavHidden(!this.anyNavHidden());
  }

  /** Show / hide a single slot's outline section. The doc stays open;
   *  only its rail section toggles. Reopen via the same chip button or
   *  the section's × (close only). */
  setSlotNavHidden(slot: Slot, hidden: boolean): void {
    if (slot.navHidden === hidden) return;
    slot.navHidden = hidden;
    this.reconcileNavRail();
  }

  /** Reset every section back to an even vertical split (double-click
   *  on a resize handle). */
  resetNavSectionSizes(): void {
    for (const id of SLOT_IDS) this.slots[id].navFlex = 1;
    for (const id of SLOT_IDS) this.slots[id].applyNavState();
  }

  /** Begin a vertical drag on `slot`'s resize handle. Trades flex
   *  weight between `slot` and the visible section directly above it,
   *  keeping their combined weight constant so the other sections hold
   *  their size. Pixel delta → flex delta via the live combined height. */
  beginNavSectionResize(slot: Slot, e: MouseEvent): void {
    e.preventDefault();
    // The section directly above this one in rail (document) order,
    // skipping hidden ones.
    const order = SLOT_IDS.map((id) => this.slots[id]).filter(
      (s) => !s.navSectionEl.hidden,
    );
    const idx = order.indexOf(slot);
    if (idx <= 0) return;
    const above = order[idx - 1]!;

    const startY = e.clientY;
    const aboveH = above.navSectionHeight();
    const selfH = slot.navSectionHeight();
    const totalH = aboveH + selfH;
    const totalFlex = above.navFlex + slot.navFlex;
    if (totalH <= 0 || totalFlex <= 0) return;
    // Don't let a section collapse to nothing — keep room for at least
    // its sticky header.
    const MIN_PX = 48;

    const onMove = (ev: MouseEvent) => {
      let newAboveH = aboveH + (ev.clientY - startY);
      newAboveH = Math.max(MIN_PX, Math.min(totalH - MIN_PX, newAboveH));
      const aboveFlex = (newAboveH / totalH) * totalFlex;
      above.navFlex = aboveFlex;
      slot.navFlex = totalFlex - aboveFlex;
      above.applyNavState();
      slot.applyNavState();
    };
    const onUp = () => {
      document.body.classList.remove('pmd-nav-resize-vertical');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      this.scheduleSyncAllCardIntrinsicWidths();
    };
    document.body.classList.add('pmd-nav-resize-vertical');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  /** Pending rAF id for the next card-intrinsic-width batch. */
  private syncIntrinsicRaf: number | null = null;

  /** Coalesce multiple sync triggers landing in the same tick into a
   *  single rAF read, so we measure once after layout settles rather
   *  than mid-flight. The cache check inside `syncCardIntrinsicWidth`
   *  is doing the no-op short-circuit; this just avoids stacking
   *  redundant rAFs. */
  scheduleSyncAllCardIntrinsicWidths(): void {
    if (this.syncIntrinsicRaf !== null) return;
    this.syncIntrinsicRaf = requestAnimationFrame(() => {
      this.syncIntrinsicRaf = null;
      for (const id of SLOT_IDS) this.slots[id].syncCardIntrinsicWidth();
    });
  }

  private onWindowResize = (): void => {
    this.scheduleSyncAllCardIntrinsicWidths();
  };

  /** Ctrl-Tab / Ctrl-Shift-Tab → open the doc-switcher overlay for
   *  the focused slot. While Ctrl is held, each Tab advances the
   *  highlighted candidate by one (Shift+Tab reverses); releasing
   *  Ctrl commits the highlighted doc as visible. Escape cancels
   *  without committing. Mirrors the Windows Alt+Tab interaction
   *  pattern.
   *
   *  Also accepts Ctrl-Alt-Tab as a fallback for the web edition
   *  (where the browser reserves plain Ctrl-Tab for tab cycling
   *  and the renderer never sees the keydown). Electron windows
   *  have no tabs to cycle, so plain Ctrl-Tab passes through to
   *  the renderer — both bindings work on desktop. */
  private onDocCycleKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented) return;
    if (e.key !== 'Tab') return;
    const hasMod = e.ctrlKey || e.metaKey;
    if (!hasMod) return;
    const slot = this.focusedSlot;
    if (!slot || slot.stack.length < 2) return;
    e.preventDefault();
    const direction = e.shiftKey ? -1 : 1;
    if (this.docSwitcher.isOpen()) {
      this.docSwitcher.advance(direction);
    } else {
      this.docSwitcher.open(slot, direction);
    }
  };

  /** Companion to `onDocCycleKey` — when Ctrl (or Meta) is released
   *  while the doc-switcher overlay is open, commit the highlighted
   *  candidate (= make it the slot's visible doc) and close the
   *  overlay. We listen on `keyup` for `Control` / `Meta` so the
   *  commit fires the instant the user releases the modifier,
   *  matching the OS Alt+Tab feel. */
  private onDocCycleKeyUp = (e: KeyboardEvent): void => {
    if (!this.docSwitcher.isOpen()) return;
    if (e.key === 'Control' || e.key === 'Meta') {
      e.preventDefault();
      this.docSwitcher.commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.docSwitcher.cancel();
    }
  };

  /** Focus the slot at `idx` (0/1/2). Used by the `focusSlotN`
   *  ribbon commands. If a slot is currently expanded, this moves
   *  the expansion to the target. */
  focusSlotByIndex(idx: 0 | 1 | 2): void {
    const slot = this.slots[SLOT_IDS[idx]!];
    if (slot.stack.length === 0) return;
    if (this.expandedSlot && this.expandedSlot !== slot) {
      this.setExpandedSlot(slot);
    } else {
      this.focusSlot(slot);
    }
    slot.visible?.view.focus();
  }

  /** Cycle the focused slot's visible doc to the next (+1) or previous (-1) doc
   *  in its stack, instantly — no Alt+Tab overlay. No-op outside a focused slot
   *  holding 2+ docs. Bound to the rebindable `cycleDocNext` / `cycleDocPrev`
   *  commands (unbound by default); the hold-to-preview Ctrl-Tab path is
   *  separate. Cycles in stack order from the visible doc, matching Ctrl-Tab. */
  cycleFocusedSlotDoc(direction: 1 | -1): void {
    const slot = this.focusedSlot;
    if (!slot || slot.stack.length < 2) return;
    const len = slot.stack.length;
    const start = slot.visibleIndex < 0 ? 0 : slot.visibleIndex;
    const next = slot.stack[(start + direction + len) % len];
    if (next && next !== slot.visible) {
      slot.showRecord(next);
      slot.visible?.view.focus();
    }
  }

  /** Send the focused slot's visible doc to the slot at `idx`
   *  (0/1/2). Used by the `sendDocToSlotN` ribbon commands. */
  sendVisibleToSlotByIndex(idx: 0 | 1 | 2): void {
    const targetId = SLOT_IDS[idx]!;
    if (targetId === this.researchBrowserSlot) return;
    const targetSlot = this.slots[targetId];
    if (!this.focusedSlot || this.focusedSlot === targetSlot) return;
    const record = this.focusedSlot.releaseVisible();
    if (!record) return;
    targetSlot.push(record);
    targetSlot.visible?.view.focus();
  }

  /** Toggle expand-mode on the focused slot. Used by the
   *  `toggleSlotExpand` ribbon command. */
  toggleFocusedSlotExpand(): void {
    if (!this.focusedSlot) return;
    this.toggleExpanded(this.focusedSlot);
  }

  /** Smart-close gesture: if the focused slot has a visible doc,
   *  close it (prompting for unsaved-changes confirmation via
   *  the same `closeVisible` flow the chip-X button uses). Returns
   *  true to signal the caller that the gesture was consumed.
   *  Returns false when the focused slot is empty (or none is
   *  focused) — the caller should fall through to its
   *  window-close default. */
  async tryCloseFocusedVisible(): Promise<boolean> {
    const slot = this.focusedSlot;
    if (!slot || slot.visible === null) return false;
    await slot.closeVisible();
    return true;
  }

  /** Web mode-switch (three-pane → one-per-window): the browser can't reopen
   *  the other docs in their own windows, so close them here — prompting to
   *  save any with unsaved changes — and keep only the focused doc, which the
   *  reload reopens in the single-doc window. Returns false if the user
   *  cancelled a save prompt (the switch aborts and three-pane stays). */
  async reduceToFocusedForModeSwitch(): Promise<boolean> {
    let keep = this.focusedSlot?.visible ?? null;
    // Defensive: if nothing is focused but docs are open, keep the first so we
    // never collapse to a blank window.
    if (!keep) {
      for (const id of SLOT_IDS) {
        const v = this.slots[id].visible;
        if (v) {
          keep = v;
          break;
        }
      }
    }
    for (const id of SLOT_IDS) {
      if (!(await this.slots[id].closeAllExcept(keep, { modeSwitch: true }))) return false;
    }
    return true;
  }

  /** App-quit path (Cmd+Q / OS close in three-pane): prompt to save every
   *  unsaved doc across all panes, without closing them. Returns false if the
   *  user cancels — the caller aborts the quit and the workspace is untouched. */
  async promptSaveAllForQuit(): Promise<boolean> {
    for (const id of SLOT_IDS) {
      if (!(await this.slots[id].promptSaveDirtyForQuit())) return false;
    }
    return true;
  }

  /** Mark `slot` as focused. The shared ribbon / chrome will route
   *  through its visible doc's EditorView. In wide-scroll layout
   *  with three active panes, also scroll the focused pane into
   *  view IF it's not already fully visible — clicking the peeking
   *  third doc brings it into view, but clicking the middle (fully
   *  visible) doc leaves the scroll position alone. */
  focusSlot(slot: Slot): void {
    // A slot held open for the research browser has no doc — nothing to
    // route keyboard / active-view focus to. The click still lands (the
    // pane's chip is real, clickable chrome), it just doesn't steal focus.
    if (slot.stack.length === 0) return;
    // Focus follows VISIBILITY: a pane hidden behind an expanded slot
    // can receive docs (the slot picker routes there happily) but must
    // never take the keyboard — the expanded pane is what the user is
    // looking at. Transferring `focusedSlot`/activeView to an invisible
    // doc splits chord routing (view keymaps need DOM focus) from
    // command routing (active view), which reads as "styling does
    // nothing". The slot takes focus normally when it becomes visible.
    if (slot.paneEl.hidden) return;
    const wasSame = this.focusedSlot === slot && getActiveView() === slot.visible?.view;
    // The focused highlight is DERIVED: stamped across all panes on
    // every focus change, never incrementally transferred. The old
    // remove-from-previous-only bookkeeping leaked a stale class
    // whenever `focusedSlot` was nulled between transfers
    // (handleSlotEmptied): the emptied pane kept its class —
    // invisible while empty and hidden, but the next doc to land in
    // that slot showed BOTH panes as focused (field bug 2026-07-28,
    // surfaced by the focus-follows-visibility guard above; the old
    // hidden-slot focus seizure had re-normalized the class by
    // accident).
    for (const id of SLOT_IDS) {
      const s = this.slots[id];
      s.paneEl.classList.toggle('pmd-pane-focused', s === slot);
    }
    this.focusedSlot = slot;
    if (!wasSame) {
      setActiveView(slot.visible?.view ?? null);
      // The shared comments column lives at the shell-row level, not
      // inside any single pane — so re-resolve this doc's flashcard
      // anchors (the focused doc changed) and re-render its cards, and
      // re-point the scroll listener so cards relayout as the focused
      // pane scrolls. `refreshFlashcardAnchors` re-renders for us (and is
      // a no-op when the column is hidden, same as render()).
      // Gated on the focus actually changing: a click inside the
      // already-focused pane (i.e. every caret placement) would
      // otherwise pay a full O(doc) re-resolution here, and the
      // incremental paths (reconcileAnchors, highlight-range mapping,
      // lastDropCount) already keep anchors current between focus
      // changes.
      commentsColumn?.refreshFlashcardAnchors();
      this.attachFocusedScrollSync(slot);
    }
    const activeCount = SLOT_IDS.filter((id) => this.slots[id].stack.length > 0).length;
    if (this.layoutMode === 'wide' && activeCount === 3) {
      // Compare the pane's box against the row's viewport. If any
      // part of the pane is clipped (off-screen), scroll it into
      // view. The `scroll-snap-type` on the row aligns the landing
      // position to a snap point; if the pane is already fully
      // inside the viewport (e.g., the middle pane), skip the
      // scroll so the user doesn't see an unwanted snap.
      const rowRect = this.rowEl.getBoundingClientRect();
      const paneRect = slot.paneEl.getBoundingClientRect();
      const fullyVisible =
        paneRect.left >= rowRect.left - 0.5 &&
        paneRect.right <= rowRect.right + 0.5;
      if (!fullyVisible) {
        // `behavior: 'auto'` overrides the row's
        // `scroll-behavior: smooth`. Smooth scroll would otherwise
        // get paused mid-animation by ProseMirror's own pointerdown
        // handling on the same tick (focus + cursor placement +
        // implicit focused-element scroll-into-view), which made
        // the user have to hold the mouse button down to see the
        // transition finish. Instant snap with `scroll-snap-type`
        // still keeps the landing position aligned.
        //
        // The rAF defer also helps — PM's handlers run on the
        // current tick; we run on the next so the scroll target
        // doesn't get clobbered before it takes effect.
        const target = slot.paneEl;
        requestAnimationFrame(() => {
          target.scrollIntoView({ inline: 'start', block: 'nearest', behavior: 'auto' });
        });
      }
    }
  }

  /** Re-point the focused-pane scroll listener at `slot`. The
   *  shared comments column sits OUTSIDE every pane's scroll
   *  container in multi-pane, so when the focused editor scrolls,
   *  cards have to reposition to keep aligned with their anchored
   *  ranges. rAF-throttled so a fast scroll doesn't queue
   *  redundant relayouts; old listener is detached before the
   *  new one attaches. */
  private attachFocusedScrollSync(slot: Slot): void {
    this.detachFocusedScrollSync();
    const column = commentsColumn;
    if (!column) return;
    const body = slot.bodyElement;
    const state: { rafId: number | null } = { rafId: null };
    const handler = (): void => {
      if (state.rafId !== null) return;
      state.rafId = requestAnimationFrame(() => {
        state.rafId = null;
        column.relayoutCards();
      });
    };
    body.addEventListener('scroll', handler, { passive: true });
    this.focusedScrollSync = { body, handler, rafId: state.rafId };
  }

  /** Detach the scroll-sync listener (e.g. when focus transitions
   *  to no pane). Idempotent — no-op when no listener is bound. */
  private detachFocusedScrollSync(): void {
    if (!this.focusedScrollSync) return;
    this.focusedScrollSync.body.removeEventListener(
      'scroll',
      this.focusedScrollSync.handler,
    );
    if (this.focusedScrollSync.rafId !== null) {
      cancelAnimationFrame(this.focusedScrollSync.rafId);
    }
    this.focusedScrollSync = null;
  }

  /** Flip the read-mode state of the focused pane's visible doc.
   *  Called by the ribbon's `toggleReadMode` command (the global
   *  command dispatches into the shell via `enableMultiDocMode`'s
   *  `toggleReadMode` hook). No-op if no pane is focused. */
  toggleFocusedReadMode(): void {
    const rec = this.focusedSlot?.visible;
    if (!rec) return;
    rec.readMode = !rec.readMode;
    applyReadModeToTarget(
      rec.editorEl,
      rec.view,
      rec.readMode,
      settings.get('hideEmphasisBordersInReadMode'),
      settings.get('readModeParagraphIntegrity'),
    );
    // setActiveView is the path that drives `refreshReadModeBtn`,
    // so we route through it to keep the ribbon button in sync.
    setActiveView(rec.view);
  }

  /** Zoom the focused pane's body by a delta (per-pane). The zoom commands /
   *  buttons / pinch route here in multi-pane via the `zoomFocusedBy` hook. */
  zoomFocusedBy(deltaPct: number): void {
    const rec = this.focusedSlot?.visible;
    if (!rec) return;
    rec.zoomPct = clampZoom(rec.zoomPct + deltaPct);
    applyZoomToTarget(rec.editorEl, rec.zoomPct);
    refreshZoomStatus();
  }

  /** Reset the focused pane's body zoom to 100%. */
  zoomFocusedReset(): void {
    const rec = this.focusedSlot?.visible;
    if (!rec) return;
    rec.zoomPct = 100;
    applyZoomToTarget(rec.editorEl, rec.zoomPct);
    refreshZoomStatus();
  }

  /** Flip the autosave state of the focused pane's visible doc.
   *  Per-pane just like read mode — toggling on one pane leaves
   *  other open docs untouched. Routes through `setActiveView` so
   *  the ribbon's autosave button re-reads the resolver. */
  toggleFocusedAutosave(): void {
    const rec = this.focusedSlot?.visible;
    if (!rec) return;
    rec.autosaveEnabled = !rec.autosaveEnabled;
    // Remember the choice per-file so it survives close + reopen.
    setAutosaveForPath(rec.handle, rec.autosaveEnabled);
    if (!rec.autosaveEnabled && rec.autosaveTimer !== null) {
      window.clearTimeout(rec.autosaveTimer);
      rec.autosaveTimer = null;
    }
    setActiveView(rec.view);
  }

  /** Clean token for the focused pane — captured by the single-doc
   *  save flows right before they serialize, committed after the write
   *  lands. Pins the RECORD as well as the generation, so a save that
   *  completes after focus moved to another pane can't clear the wrong
   *  doc's dirty flag. Null when no pane is focused. */
  captureFocusedCleanToken(): (() => boolean) | null {
    const rec = this.focusedSlot?.visible;
    if (!rec) return null;
    return captureCleanToken({
      editGen: () => rec.editGen,
      markClean: () => {
        rec.dirty = false;
      },
      clearJournal: () => {
        void clearJournalForRecord(rec);
      },
    });
  }

  /** The filename currently shown in the focused pane's chip, or
   *  null when no pane is focused. Used by Save-As to prefill
   *  with the active doc's name. */
  getFocusedFilename(): string | null {
    return this.focusedSlot?.visible?.filename ?? null;
  }

  /** Occupied panes (a doc open, not hidden), left-to-right, for the
   *  research browser's "which pane?" picker — it docks INTO one
   *  pane's screen rect rather than overlaying the whole window, so
   *  it needs somewhere with an open doc to sit over. Reports
   *  `bodyElement` (the scrollable doc area), NOT the whole `paneEl`
   *  — the pane's own chip/tab row and footer sit outside `bodyEl`
   *  and must stay visible and usable above/below the docked browser,
   *  not get covered or squeezed by it. */
  occupiedSlotPanes(): Array<{ id: SlotId; label: string; el: HTMLElement }> {
    const labels: Record<SlotId, string> = { slot1: 'Pane 1', slot2: 'Pane 2', slot3: 'Pane 3' };
    return SLOT_IDS.filter((id) => this.slots[id].stack.length > 0 && !this.slots[id].paneEl.hidden).map(
      (id) => ({ id, label: labels[id], el: this.slots[id].bodyElement }),
    );
  }

  /** Reserve the first EMPTY pane for the research browser, auto-
   *  expanding the visible pane count exactly like opening a doc there
   *  would (one doc open → this shows pane 2; two docs open → pane 3,
   *  respecting the current layout mode's compact-thirds or
   *  wide-with-peek rendering — both already derive purely from the
   *  active-pane count `refreshLayout` computes). Returns null when
   *  every pane already has a doc loaded (caller falls back to
   *  `occupiedSlotPanes`'s pick-one-to-replace picker) or a slot is
   *  currently expanded/maximized (that mode already collapses to one
   *  visible pane; reserving a hidden one would just fight it). */
  openResearchBrowserPane(): { id: SlotId; el: HTMLElement } | null {
    if (this.expandedSlot) return null;
    const emptyId = SLOT_IDS.find((id) => this.slots[id].stack.length === 0);
    if (!emptyId) return null;
    this.researchBrowserSlot = emptyId;
    this.applyExpandedState();
    return { id: emptyId, el: this.slots[emptyId].bodyElement };
  }

  /** Release a pane reserved by `openResearchBrowserPane`, restoring
   *  normal occupancy-driven visibility. No-op if nothing's reserved
   *  (e.g. the browser docked into an already-occupied pane instead). */
  closeResearchBrowserPane(): void {
    if (!this.researchBrowserSlot) return;
    this.researchBrowserSlot = null;
    this.applyExpandedState();
  }

  /** Force (or clear) `id`'s chip title while the research browser
   *  occupies that pane — see `Slot.setChipTitleOverride`. */
  setResearchBrowserChipTitle(id: SlotId, text: string | null): void {
    this.slots[id].setChipTitleOverride(text);
  }

  /** Whether `id` is free to receive a newly-opened/recovered doc —
   *  empty AND not currently reserved for the research browser. Every
   *  "route a doc to an empty slot" path (file open, crash recovery,
   *  Show-in-context) must check this instead of `stack.length === 0`
   *  directly, or it'll happily plant a doc in the pane the browser is
   *  visually occupying. */
  private isSlotFreeForDoc(id: SlotId): boolean {
    return this.slots[id].stack.length === 0 && id !== this.researchBrowserSlot;
  }

  /** Return the focused doc's filename + on-disk handle + format,
   *  for the Save / Save-As flow. Returns null when no pane is
   *  focused or the slot has no visible record. */
  getFocusedFile(): {
    filename: string;
    handle: unknown | null;
    format: DocFormat | null;
    docId: string | null;
    uid: string;
  } | null {
    const rec = this.focusedSlot?.visible;
    if (!rec) return null;
    return { filename: rec.filename, handle: rec.handle, format: rec.format, docId: rec.docId, uid: rec.uid };
  }

  /** Set the focused doc's Learn id (minted lazily on first save /
   *  flashcard, or forked on Save As). Lightweight on purpose — unlike
   *  `setFocusedFile` it touches none of the filename / handle / chip /
   *  path-claim machinery. */
  setFocusedDocId(docId: string): void {
    const rec = this.focusedSlot?.visible;
    if (rec) rec.docId = docId;
  }

  /** View of any pane holding `docId` — every slot's full stack (visible
   *  AND background), so an inbound jump reaches a doc open in an
   *  unfocused pane. A background (stacked-but-hidden) record is RAISED
   *  to its slot's visible position first: its view stays memory-resident
   *  while hidden but its `editorEl` is detached, so jumping into it would
   *  select in an invisible editor and the user would see nothing.
   *  `showRecord` mounts synchronously (appendChild), so on return the
   *  view's DOM is attached and `scrollToHeadingId` has an element to hit.
   *  Returns null when no open doc has that id. */
  findViewForDocId(docId: string): EditorView | null {
    for (const id of SLOT_IDS) {
      const slot = this.slots[id];
      for (const rec of slot.stack) {
        if (rec.docId === docId) {
          // Raised before resolution: if the jump then fails not-found, the
          // raised record stays visible anyway. Accepted - the doc was
          // explicitly requested, so surfacing it is reasonable regardless.
          // Revisit if failed jumps raising docs turns out to be noisy.
          slot.showRecord(rec); // no-op when already visible
          return rec.view;
        }
      }
    }
    return null;
  }

  /** Filenames in every slot, in slot order. Empty slots map to
   *  `null` so callers can preserve positional context if they
   *  want (or filter the nulls out). Used by the OS window-title
   *  syncer to summarize the whole multi-pane workspace at once. */
  getAllFilenames(): (string | null)[] {
    return SLOT_IDS.map((id) => this.slots[id].visible?.filename ?? null);
  }

  /** The filename of the open doc with `uid` — searched across every slot's
   *  full stack (not just visible records), so a session owned by a background
   *  (stacked, non-visible) tab still resolves its own name. Null if no open
   *  doc has that uid. Lets collab publish/label a session with its OWNER doc's
   *  name rather than the whole-window title (every open doc joined by " · "). */
  docIdForUid(uid: string): string | null {
    for (const id of SLOT_IDS) {
      for (const rec of this.slots[id].stack) {
        if (rec.uid === uid) return rec.docId;
      }
    }
    return null;
  }

  filenameForUid(uid: string): string | null {
    for (const id of SLOT_IDS) {
      for (const rec of this.slots[id].stack) {
        if (rec.uid === uid) return rec.filename;
      }
    }
    return null;
  }

  /** Every open doc's file handle across all panes and their stacks — for the
   *  web cross-window same-file guard's query responder (a stacked, non-visible
   *  doc is still "open" and can be the duplicate). */
  getAllHandles(): unknown[] {
    const handles: unknown[] = [];
    for (const id of SLOT_IDS) {
      for (const rec of this.slots[id].stack) {
        if (rec.handle != null) handles.push(rec.handle);
      }
    }
    return handles;
  }

  /** Replace the focused pane's filename with `name` and refresh
   *  the chip. */
  setFocusedFilename(name: string): void {
    const slot = this.focusedSlot;
    if (!slot) return;
    const rec = slot.visible;
    if (!rec) return;
    rec.filename = name;
    slot.refreshChipFilename();
    pushPaneDocInfo(rec.uid, rec.filename);
  }

  /** Update the focused pane's filename + handle + format together —
   *  called from the editor's Save-As flow once the save commits.
   *  Keeps the chip label, the in-place-save handle, and the format
   *  in sync as the user renames or migrates formats. */
  setFocusedFile(file: { filename: string; handle: unknown | null; format: DocFormat | null }): void {
    const slot = this.focusedSlot;
    if (!slot) return;
    const rec = slot.visible;
    if (!rec) return;
    rec.filename = file.filename;
    // Save-As may have moved this doc to a new on-disk location;
    // re-sync the cross-window path claim so the new path is
    // owned by us and the old one is released.
    syncDocPathClaim(rec.handle, file.handle);
    rec.handle = file.handle;
    setViewDocPath(rec.view, typeof file.handle === 'string' ? file.handle : null);
    rec.format = file.format;
    slot.refreshChipFilename();
    pushPaneDocInfo(rec.uid, rec.filename);
  }

  /** Journal every DocRecord across every slot's stack. Called by
   *  the mode-switch flow before reloading so the post-reload
   *  startup-recovery can rebuild the workspace in the new layout.
   *  Cancels each record's pending debounced timer first so the
   *  explicit write we're about to fire isn't shadowed by a
   *  redundant timer-driven write a few hundred ms later. Returns
   *  each journaled doc's uid + pre-switch dirty state — the
   *  mode-switch marker scopes the post-reload reopen to exactly
   *  this list. */
  async journalAll(): Promise<Array<{ uid: string; dirty: boolean }>> {
    const tasks: Promise<void>[] = [];
    const docs: Array<{ uid: string; dirty: boolean }> = [];
    for (const id of SLOT_IDS) {
      for (const rec of this.slots[id].stack) {
        if (rec.journalTimer !== null) {
          window.clearTimeout(rec.journalTimer);
          rec.journalTimer = null;
        }
        tasks.push(runJournalForRecord(rec));
        docs.push({ uid: rec.uid, dirty: rec.dirty });
      }
    }
    await Promise.all(tasks);
    return docs;
  }

  /** Load a recovered doc into the workspace. Picks the first
   *  empty slot; if all three slots have docs already, stacks the
   *  recovered doc into the focused (or first) slot. Reuses the
   *  journal's uid so the recovered doc continues to crash-recover
   *  under the same slot. */
  async onRecoveredDoc(entry: {
    uid: string;
    filename: string;
    handle: unknown;
    format: DocFormat | null;
    docId: string | null;
    doc: PMNode;
    threads: import('./comments-plugin.js').Thread[];
    dirty: boolean;
  }): Promise<void> {
    // Pick the first empty slot; otherwise fall back to the
    // currently-focused slot or slot1.
    let target: SlotId = 'slot1';
    for (const id of SLOT_IDS) {
      if (this.isSlotFreeForDoc(id)) {
        target = id;
        break;
      }
      if (id === SLOT_IDS[SLOT_IDS.length - 1]) {
        target = this.focusedSlot?.id ?? 'slot1';
      }
    }
    const slot = this.slots[target];
    const record = buildDocRecord(entry.filename, entry.doc, slot, {
      handle: entry.handle,
      format: entry.format,
      uid: entry.uid,
      docId: entry.docId,
      threads: entry.threads,
    });
    // Crash recovery restores content that wasn't successfully
    // saved, so it arrives dirty (close-X prompts until the user
    // saves). A mode-switch reopen of a doc that was CLEAN before
    // the switch arrives clean — its on-disk file already matches.
    record.dirty = entry.dirty;
    slot.push(record);
    // Same focus-after-mount as every other slot-populating path
    // (2026-07-27 focus audit) — this one runs on crash recovery AND
    // every mode-switch reload, so a missing focus here made the
    // whole workspace keyboard-dead after switching modes until a
    // click landed on a text line. Recovery restores several docs in
    // sequence; each push re-focuses, leaving focus on the last one,
    // which matches the visible end state (last pushed doc is
    // focused-slot). Hidden-pane guard: focus follows visibility.
    if (!slot.paneEl.hidden) record.view.focus();
  }

  /** A slot's stack just became empty. If it was the expanded
   *  slot, drop expand mode — no doc to expand any more. */
  notifySlotEmptied(slot: Slot): void {
    if (this.expandedSlot === slot) this.setExpandedSlot(null);
  }

  /** A slot's stack just got a fresh doc. If we're in expand mode
   *  and a *different* slot is expanded, keep this newcomer hidden
   *  for now (the user can pop back to multi-pane to see it). If
   *  the populated slot is the expanded one (or if expand mode is
   *  off), show it. */
  notifySlotPopulated(slot: Slot): void {
    // A doc landing in any slot ends the empty-workspace state — the
    // home screen (shown at empty boot / after the last close) yields
    // to the workspace. No-op when home isn't up.
    homeScreen.hide();
    if (this.expandedSlot && this.expandedSlot !== slot) {
      slot.paneEl.hidden = true;
    } else {
      slot.paneEl.hidden = false;
    }
    // Section visibility (honouring navHidden + expand mode) is owned
    // by reconcileNavRail.
    this.reconcileNavRail();
    this.refreshLayout();
  }

  /** Handle a slot becoming empty — if it had focus, transfer to
   *  the next active slot (or clear focus). */
  handleSlotEmptied(slot: Slot): void {
    // Workspace fully empty → land on the home screen rather than a
    // blank window (parity with single-pane's close-to-home). Checked
    // BEFORE the focus bookkeeping: that path early-returns when the
    // emptied slot wasn't the focused one, and the last doc can close
    // from an unfocused slot (clean-doc ✕ needs no focus first).
    if (!SLOT_IDS.some((id) => this.slots[id].stack.length > 0)) {
      homeScreen.show();
    }
    if (this.focusedSlot !== slot) return;
    this.focusedSlot = null;
    // Clear the emptied pane's highlight NOW: focusSlot's stamp-all
    // covers the transfer case below, but when no slot remains (or
    // the next slot is hidden and refuses focus) nothing else would
    // remove it — the stale-class leak behind the "both panes look
    // focused" field bug (2026-07-28).
    slot.paneEl.classList.remove('pmd-pane-focused');
    for (const id of SLOT_IDS) {
      if (this.slots[id].stack.length > 0) {
        this.focusSlot(this.slots[id]);
        return;
      }
    }
    setActiveView(null);
    // No focused doc left — tear down the scroll listener so the
    // closed pane's body doesn't keep ferrying events, and render
    // the column once more so it shows the no-view state (empty).
    this.detachFocusedScrollSync();
    commentsColumn?.render();
  }

  /** Ask the host for a file and load it straight into the named
   *  slot — no slot picker, since the user explicitly clicked that
   *  slot's Open button. */
  async openFileIntoSlot(target: SlotId): Promise<void> {
    let opened: OpenedFile | null;
    try {
      opened = await getHost().openFile();
    } catch (err) {
      console.error('Open failed:', err);
      void alertDialog(`Failed to open: ${err instanceof Error ? err.message : err}`);
      return;
    }
    if (!opened) return;
    // Cross-window duplicate-open guard. Runs BEFORE the within-window
    // check so a duplicate held by another window jumps focus there
    // (Electron) or is refused (web) rather than landing on this
    // window's existing copy if any.
    if (opened.handle != null && (await isFileOpenInAnotherWindow(opened.handle))) {
      showToast(`"${opened.name}" is already open in another window.`);
      return;
    }
    if (await this.surfaceDuplicateIfOpen(opened)) return;
    await this.loadOpenedIntoSlot(opened, target);
  }

  /** Called from the ribbon's Open button via `enableMultiDocMode`'s
   *  `onFileOpen` callback. The shell shows the inline slot picker
   *  before loading, since the user didn't pre-choose a destination. */
  async onFileOpen(opened: OpenedFile): Promise<void> {
    if (await this.surfaceDuplicateIfOpen(opened)) return;
    const choice = await this.promptForSlot(opened.name);
    if (!choice) return;
    await this.loadOpenedIntoSlot(opened, choice);
  }

  /** Flashcard review's "Show in context": reveal the card's source in a
   *  slot of this window, scrolled to the anchored text. If the doc is
   *  already open in a slot, focus + scroll it (no reload). Otherwise
   *  load it into the first empty slot — or slot 1 when all three are
   *  occupied — without prompting (the user picked "show in context", not
   *  "open"), then scroll once it mounts. */
  async showInContext(req: ShowInContextRequest): Promise<void> {
    const existing = await this.findOpenRecordByHandle(req.path);
    if (existing) {
      existing.slot.showRecord(existing.record);
      this.focusSlot(existing.slot);
      const record = existing.record;
      requestAnimationFrame(() => scrollRecordToDescriptor(record, req.descriptor, req.name));
      return;
    }
    const electron = getElectronHost();
    if (!electron) return;
    let file: Awaited<ReturnType<typeof electron.readFileAtPath>>;
    try {
      file = await electron.readFileAtPath(req.path);
    } catch {
      file = null;
    }
    if (!file) {
      showToast(`Couldn't open "${req.name}" — file moved or deleted.`);
      return;
    }
    const target = SLOT_IDS.find((id) => this.isSlotFreeForDoc(id)) ?? 'slot1';
    await this.loadOpenedIntoSlot(
      { name: file.name, bytes: file.bytes, handle: file.handle },
      target,
    );
    const record = this.slots[target].visible;
    if (record) {
      requestAnimationFrame(() => scrollRecordToDescriptor(record, req.descriptor, req.name));
    }
  }

  /** Duplicate-open guard: if `opened` is already loaded in the
   *  workspace, focus + show the existing copy, toast the user,
   *  and return true so the caller can short-circuit. The shell
   *  doesn't currently support having multiple copies of the same
   *  doc open. */
  private async surfaceDuplicateIfOpen(opened: OpenedFile): Promise<boolean> {
    const existing = await this.findOpenRecordByHandle(opened.handle ?? null);
    if (!existing) return false;
    existing.slot.showRecord(existing.record);
    this.focusSlot(existing.slot);
    showToast(`"${opened.name}" is already open.`);
    return true;
  }

  /** Show the inline "Send to slot…" picker; resolves with the
   *  chosen slot, or null if the user cancels. */
  private promptForSlot(filename: string): Promise<SlotId | null> {
    return new Promise((resolve) => {
      // Register on the shared overlay stack so background number-key
      // handlers stand down — without this, picking a slot with '1'/'2'/
      // '3' over the home screen ALSO fired the matching home action
      // (isAnyOverlayOpen() saw no overlay).
      const overlayToken = pushOverlay();
      // Deterministic focus story (2026-07-27 focus audit: this was
      // the ONE overlay dialog with no focus arming, and Electron's
      // async focus restoration on dialog teardown has twice before
      // landed AFTER a renderer-side .focus() — the prime suspect for
      // the intermittent "new doc ignores styling" repro). Focus moves
      // INTO the dialog on open and is restored synchronously on
      // close, BEFORE the caller's own view.focus() runs — so the
      // caller's focus always wins the ordering.
      const restoreFocus = captureFocusForDialog();
      const overlay = document.createElement('div');
      overlay.className = 'pmd-route-overlay';
      // Single resolution path for all four ways out (slot click,
      // Cancel, Escape, digit key) so the document-level keydown
      // listener always detaches — a mouse-completed pick must not
      // leave a stale handler that eats the next typed '1'/'2'/'3'.
      let removeKeys = (): void => {};
      const finish = (choice: SlotId | null): void => {
        popOverlay(overlayToken);
        removeKeys();
        overlay.remove();
        restoreFocus();
        resolve(choice);
      };
      const dialog = document.createElement('div');
      dialog.className = 'pmd-route-dialog';
      const header = document.createElement('div');
      header.className = 'pmd-route-header';
      header.textContent = `Open ${filename} into…`;
      dialog.appendChild(header);
      const row = document.createElement('div');
      row.className = 'pmd-route-buttons';
      // The research browser's reserved pane isn't a legal doc
      // destination — offering it would let a new doc land right on
      // top of (and get visually hidden behind) the browser overlay.
      // The digit-key shortcuts below check this same list so a
      // typed '2' can't bypass the omitted button.
      const availableSlotIds = SLOT_IDS.filter((sid) => sid !== this.researchBrowserSlot);
      for (const id of availableSlotIds) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pmd-route-btn';
        const slot = this.slots[id];
        const stackLabel =
          slot.stack.length === 0
            ? '(empty)'
            : `${slot.visible?.filename ?? ''}${slot.stack.length > 1 ? ` (+${slot.stack.length - 1})` : ''}`;
        btn.innerHTML = `<strong>${id.replace('slot', 'Slot ')}</strong><br><span>${stackLabel}</span>`;
        btn.addEventListener('click', () => finish(id));
        row.appendChild(btn);
      }
      dialog.appendChild(row);
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'pmd-route-cancel';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => finish(null));
      dialog.appendChild(cancel);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
      // Esc cancels; 1 / 2 / 3 pick the corresponding slot. Skips
      // chords with modifiers so e.g. Ctrl+1 keeps its slot-focus
      // meaning even if a picker is open.
      // Capture-phase + swallow (see installModalKeys): the picker
      // opens over a focused editor on every multi-pane open, so a
      // bubble-phase listener let unhandled keys — Enter especially —
      // reach ProseMirror and edit the doc underneath.
      removeKeys = installModalKeys(dialog, overlayToken, (e) => {
        if (e.key === 'Escape') {
          finish(null);
          return true;
        }
        if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
        let idx = -1;
        if (e.key === '1') idx = 0;
        else if (e.key === '2') idx = 1;
        else if (e.key === '3') idx = 2;
        if (idx >= 0) {
          const id = SLOT_IDS[idx]!;
          if (!availableSlotIds.includes(id)) return false;
          finish(id);
          return true;
        }
        return false;
      });
      armDialogFocus(dialog, 'dialog', `Open ${filename} into a slot`);
    });
  }

  /** Parse + import + mount the host-provided OpenedFile into the
   *  given slot. Detects format from the filename extension and
   *  routes to the right parser. */
  private async loadOpenedIntoSlot(opened: OpenedFile, target: SlotId): Promise<void> {
    // Duplicate-open guard runs in the entry points
    // (`onFileOpen` + `openFileIntoSlot`) BEFORE the slot picker
    // shows, so we don't pester the user with a slot prompt for a
    // doc they already have open.
    const format = formatFromFilename(opened.name) ?? 'docx';
    // Password-protected .docx (a compound file, not a zip) → prompt +
    // decrypt to real .docx bytes before parsing; passes through
    // otherwise. Cancel aborts silently; an unsupported scheme shows
    // its own message.
    let openBytes: Uint8Array;
    try {
      openBytes = await maybeDecryptForOpen(opened.bytes, opened.name);
    } catch (err) {
      if (err instanceof OpenCancelledError) return;
      void alertDialog(err instanceof Error ? err.message : String(err));
      return;
    }
    let doc: PMNode;
    let threads: Thread[];
    let docId: string | null;
    // Pick the PARSER by sniffing the bytes, not the filename/format — a
    // recovered .cmir-journal or a mode-switch respawn carries native cmir bytes
    // under a docx name/format. A .docx is a 'PK' zip; cmir never is. (`format`
    // above stays the SAVE format.)
    const isDocxBytes =
      openBytes.length >= 2 && openBytes[0] === 0x50 && openBytes[1] === 0x4b;
    if (!isDocxBytes) {
      ({ doc, threads, docId } = parseNative(openBytes));
    } else {
      ({ doc, threads, docId } = await fromDocxFull(openBytes));
    }
    const slot = this.slots[target];
    const record = buildDocRecord(opened.name, doc, slot, {
      handle: opened.handle ?? null,
      format,
      docId,
      threads,
    });
    slot.push(record);
    // Open-from-disk rejoin gate (same as the single-doc open path):
    // a file with a resumable session offers rejoin-or-leave instead
    // of silently diverging.
    void checkSessionRejoinForOpenedDoc(docId ?? null, record.uid);
    // Multi-pane opens are recents too — this is the one funnel every
    // slot open passes through (Open dialog, palette, drag-drop, OS
    // association, spawn payloads, show-in-context). String-handle only:
    // recovered journals and mode-switch respawns of unsaved docs have
    // no reopenable path, and recording them would render dead rows
    // (mirrors the single-doc mount's recordAsRecent guard). The home
    // screen never mounts in this window; the entry surfaces in other
    // windows' home screens and on the next launch.
    if (typeof opened.handle === 'string') {
      recordRecent({ handle: opened.handle, filename: opened.name, format });
    }
    // DOM focus into the just-opened doc so keyboard chords work with
    // no extra click (2026-07-27 focus audit: this path never focused
    // — push only moves the bookkeeping). Skipped for a pane hidden
    // behind an expanded slot: focus follows visibility.
    if (!slot.paneEl.hidden) record.view.focus();
  }

  /** Look for an already-open DocRecord whose on-disk handle
   *  matches `handle`. Used by the duplicate-open guard. Returns
   *  the slot + record so the caller can re-focus the existing
   *  copy. Null when `handle` is null (never-saved doc) or no
   *  match — never-saved docs aren't deduped (we have no identity
   *  for them yet). */
  private async findOpenRecordByHandle(
    handle: unknown,
  ): Promise<{ slot: Slot; record: DocRecord } | null> {
    if (handle == null) return null;
    for (const id of SLOT_IDS) {
      const slot = this.slots[id];
      for (const record of slot.stack) {
        if (await isSameOpenHandle(record.handle, handle)) {
          return { slot, record };
        }
      }
    }
    return null;
  }

  /** Create an empty doc; prompt for slot. Used by the ribbon's
   *  "New doc" button. */
  async createNewDoc(): Promise<void> {
    const target = await this.promptForSlot('Untitled');
    if (!target) return;
    const doc = makeBlankDoc();
    const slot = this.slots[target];
    const record = buildDocRecord('Untitled', doc, slot, {
      handle: null,
      format: null,
    });
    slot.push(record);
    // Caret into the empty paragraph + focus, so typing (or arming a
    // style for typing) works immediately with no extra click. Every
    // other slot-populating path focuses too — UNLESS the target pane
    // is hidden behind an expanded slot: the expanded pane keeps the
    // keyboard (focus follows visibility; see focusSlot). A focus()
    // into a hidden subtree would silently no-op anyway.
    const tr = record.view.state.tr.setSelection(Selection.atEnd(record.view.state.doc));
    record.view.dispatch(tr);
    if (!slot.paneEl.hidden) record.view.focus();
  }

  /** Create a fresh unsaved doc to hold a joining/resuming co-editing
   *  session: slot picker first, record after. Returns the new record's
   *  uid, or null when the user cancels the picker. The caller registers
   *  the session under this uid and refreshes plugins — the Loro binding
   *  then replaces the blank content with the session's CRDT state. */
  async createSessionDocIntoSlot(): Promise<string | null> {
    const target = await this.promptForSlot('collaboration session');
    if (!target) return null;
    const doc = makeBlankDoc();
    const slot = this.slots[target];
    const record = buildDocRecord('Session', doc, slot, {
      handle: null,
      format: null,
    });
    slot.push(record);
    // Focus-after-mount, like every slot-populating path (2026-07-27
    // focus audit). The Loro binding replaces the blank content right
    // after; focus survives a state replace. Hidden-pane guard: focus
    // follows visibility.
    if (!slot.paneEl.hidden) record.view.focus();
    return record.uid;
  }

  /** Rename the open doc with `uid`, wherever it lives (any pane, any
   *  stack depth). The collab seams name a joined session doc by the
   *  host-published title, and by the time that title arrives focus may
   *  have moved — so this targets the record by uid, not the focused one
   *  (mirrors setFocusedFilename otherwise). */
  setFilenameForUid(uid: string, name: string): void {
    for (const id of SLOT_IDS) {
      const slot = this.slots[id];
      for (const rec of slot.stack) {
        if (rec.uid !== uid) continue;
        // A SAVED record keeps its on-disk name — the collab title
        // adoption must not rename a doc the user already saved.
        if (rec.handle != null) return;
        rec.filename = name;
        // Repaints from the slot's VISIBLE record — correct whether or
        // not that is the renamed one.
        slot.refreshChipFilename();
        pushPaneDocInfo(rec.uid, rec.filename);
        return;
      }
    }
  }

  /** Create a new speech document and mark it as the active speech
   *  doc. Verbatim parallels: `Paperless.NewSpeech` prompts for a
   *  round name ("1NC", "2AC vs Hogwarts", etc.); we do the same
   *  via a simple `prompt()` plus the standard slot picker. The
   *  fresh doc auto-registers as the speech doc — that's the
   *  whole point of `NewSpeech` (vs the generic `New doc`). */
  async createNewSpeechDocument(): Promise<void> {
    // Electron disables window.prompt(); route through the in-
    // renderer modal so the desktop edition works too.
    const speechName = await promptForText({
      message: 'Which speech? (e.g. 1NC, 2AC Round 3 vs Hogwarts)',
      placeholder: '1NC',
      okLabel: 'Create',
    });
    if (!speechName) return;
    const trimmed = speechName;
    const target = await this.promptForSlot(`Speech ${trimmed}`);
    if (!target) return;
    const format = settings.get('defaultSpeechDocFormat');
    const filename = formatSpeechFilename(trimmed, format);
    const includePocket = settings.get('includeSpeechDocPocket');
    // With pocket: Pocket heading carrying the filename (sans
    // extension) + trailing paragraph — Verbatim parity, the F4
    // row reads e.g. "Speech 2AC 5-15 12-30AM". Without: a fully
    // blank doc (one paragraph) for users who'd rather title
    // inline.
    const doc = includePocket
      ? makeSpeechBlankDoc(filename.replace(/\.(cmir|docx)$/i, ''))
      : makeBlankDoc();
    const slot = this.slots[target];
    // Format follows the user's `defaultSpeechDocFormat` setting —
    // `.docx` (Verbatim parity) by default, `.cmir` for autosave-
    // eligible speech docs. The user can still Save As to flip
    // format later.
    const record = buildDocRecord(filename, doc, slot, {
      handle: null,
      format,
    });
    slot.push(record);
    // `slot.push` focused the new view. Cursor placement:
    //   - With pocket: drop into the trailing paragraph so the
    //     first ` press inserts BELOW the pocket rather than
    //     inside it. Position math: pocket node occupies
    //     [0, pocket.nodeSize); paragraph cursor lives at
    //     pocket.nodeSize + 1.
    //   - Without pocket: position 1 (inside the only paragraph)
    //     is the natural cursor spot.
    const cursorPos = includePocket ? doc.firstChild!.nodeSize + 1 : 1;
    const tr = record.view.state.tr.setSelection(
      TextSelection.create(record.view.state.doc, cursorPos),
    );
    record.view.dispatch(tr);
    // Same visibility guard as createNewDoc: an expand-obscured pane
    // never takes the keyboard.
    if (!slot.paneEl.hidden) record.view.focus();
    // Mark as the speech doc. The registry hook fires the
    // resolver subscription, which refreshes chrome (the 📌
    // button's aria-pressed + the slot's chip).
    getSpeechDocResolver().setSpeech(record.view);
    this.refreshSpeechChips();
  }

  /** Toggle the focused pane's speech-doc designation. If the
   *  focused doc IS already the speech doc, clear the designation.
   *  Otherwise mark it (replacing any previous). No-op if no pane
   *  is focused. */
  markFocusedAsSpeech(): void {
    const rec = this.focusedSlot?.visible;
    if (!rec) return;
    const resolver = getSpeechDocResolver();
    const next = resolver.getSpeechView() === rec.view ? null : rec.view;
    resolver.setSpeech(next);
    this.refreshSpeechChips();
  }

  /** Send the focused slot's selection (or enclosing card / heading
   *  when no selection) to the cross-window dropzone shelf.
   *  Mirrors `sendToSpeech`'s source-resolution; the destination
   *  is the shelf, broadcast via `dropzoneStore`. */
  sendToDropzone(): void {
    const sourceRec = this.focusedSlot?.visible;
    if (!sourceRec) return;
    void sendViewToDropzone(sourceRec.view);
  }

  /** Send the focused pane's cursor card (or selection) to the starred
   *  recipient/group. Mirrors `sendToDropzone`, routed to the relay. */
  sendToStarred(): void {
    const sourceRec = this.focusedSlot?.visible;
    if (!sourceRec) return;
    void sendViewToStarred(sourceRec.view);
  }

  /** Send the focused pane's selection (or its enclosing heading-
   *  and-content range if the selection is empty) into the speech
   *  doc. `atEnd` controls the insertion point — true → after the
   *  doc-end, false → at the speech doc's current cursor. Verbatim:
   *  `Paperless.SendToSpeech PasteAtEnd:=true|false`. */
  sendToSpeech(atEnd: boolean): void {
    const sourceRec = this.focusedSlot?.visible;
    if (!sourceRec) return;
    const resolver = getSpeechDocResolver();
    const speechUid = resolver.getSpeechUid();
    // Locate the speech doc's slot + record so we can show it
    // BEFORE dispatching — the view might be BACKGROUND in its
    // slot's stack (user swapped to another record); dispatching
    // on a detached view leaves the changes invisible AND
    // uncatchable by Ctrl-Z because focus never transfers off the
    // source pane.
    const speechView = speechUid ? resolver.viewForUid(speechUid) : null;
    const located = speechView ? this.findRecordForView(speechView) : null;
    if (located && located.slot.visible?.view !== located.record.view) {
      located.slot.showRecord(located.record);
    }
    runSendToSpeech(sourceRec.view, atEnd, () => {
      // Post-insert: focus the destination slot and FLUSH its
      // debounced heavy update so the new headings and word count
      // show up immediately (flush, not just cancel — the timer
      // owes the word-count refresh). Nav-collapse-for-new-headings
      // is handled by the resolver's onSliceLanded hook (registered
      // in `buildDocRecord`), so it fires the same way for cross-
      // window receives.
      if (!located) return;
      this.focusSlot(located.slot);
      flushHeavyUpdateNow(located.record);
    });
  }

  /** Sync the visual speech indicator on every slot's chip with
   *  the registry's current state. Called whenever the speech
   *  designation changes or a slot's visible doc changes. */
  refreshSpeechChips(): void {
    const speechView = getSpeechDocResolver().getSpeechView();
    for (const id of SLOT_IDS) {
      const slot = this.slots[id];
      const isSpeech = !!speechView && slot.visible?.view === speechView;
      slot.paneEl.classList.toggle('pmd-pane-speech', isSpeech);
    }
  }
}


/** Speech-doc variant of `makeBlankDoc`. Same Pocket + trailing
 *  paragraph shape, but the Pocket carries the user-supplied
 *  speech name instead of "Untitled" so the F4 row at the top of
 *  the doc reads as a useful label ("1NC Round 3 vs Hogwarts"). */
function makeSpeechBlankDoc(title: string): PMNode {
  return schema.nodes['doc']!.createChecked(null, [
    schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text(title)),
    schema.nodes['paragraph']!.create(null),
  ]);
}

/** Single shell instance — multi-pane is a binary mode, so one is
 *  enough. */
let shell: MultiPaneShell | null = null;

/** Focus the slot at `idx` (0/1/2). No-op in single-doc mode, or
 *  when the target slot has no docs loaded. Used by the
 *  `focusSlotN` ribbon commands. */
export function focusSlotByIndex(idx: 0 | 1 | 2): void {
  if (!shell) return;
  shell.focusSlotByIndex(idx);
}

/** Send the focused slot's visible doc to the slot at `idx`
 *  (0/1/2). No-op when no slot is focused, when the focused slot
 *  has no visible doc, or when the target is the focused slot
 *  itself. Used by the `sendDocToSlotN` ribbon commands. */
export function sendVisibleToSlotByIndex(idx: 0 | 1 | 2): void {
  if (!shell) return;
  shell.sendVisibleToSlotByIndex(idx);
}

/** Toggle expand-mode on the focused slot. No-op when no slot is
 *  focused. Used by the `toggleSlotExpand` ribbon command. */
export function toggleFocusedSlotExpand(): void {
  if (!shell) return;
  shell.toggleFocusedSlotExpand();
}

/** Cycle the focused slot's visible doc forward (+1) / back (-1). No-op when
 *  the shell isn't active. Used by the `cycleDocNext` / `cycleDocPrev` commands. */
export function cycleFocusedSlotDoc(direction: 1 | -1): void {
  if (!shell) return;
  shell.cycleFocusedSlotDoc(direction);
}

/** If the multi-pane shell is active AND the focused slot has a
 *  visible doc, close that doc (prompting for unsaved changes if
 *  needed). Returns true if it consumed the gesture, false if it
 *  did nothing (caller should fall through to its window-close
 *  default — used by the desktop Ctrl+W handler so a blank
 *  multi-pane window still closes on the second Ctrl+W press). */
export async function tryCloseVisibleInFocusedSlot(): Promise<boolean> {
  if (!shell) return false;
  return shell.tryCloseFocusedVisible();
}

/** Resolve `descriptor` against a record's doc and select + scroll its
 *  view to it (preciseScrollIntoView, like the nav-pane jump). Best-
 *  effort — toasts if the text can't be located, falls back to a caret,
 *  tolerates a not-yet-laid-out position. Call inside a rAF after a
 *  mount / pane switch so the DOM is measurable. */
function scrollRecordToDescriptor(
  record: DocRecord,
  descriptor: AnchorDescriptor,
  name: string,
): void {
  const v = record.view;
  const r = resolveDescriptor(v.state.doc, descriptor);
  if (!r) {
    showToast(`Opened "${name}", but couldn't locate the card's text — it may have changed.`);
    return;
  }
  try {
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, r.from, r.to)));
  } catch {
    try {
      v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(r.from))));
    } catch {
      /* not selectable — still scroll below */
    }
  }
  try {
    const at = v.domAtPos(r.from);
    let node: Node | null = at.node ?? null;
    while (node && node.nodeType !== Node.ELEMENT_NODE) node = node.parentNode;
    if (node instanceof HTMLElement) preciseScrollIntoView(v, node, 'center');
  } catch {
    /* position detached / not laid out — ignore */
  }
  v.focus();
}

/** Build a fresh DocRecord — wraps the per-doc PM state, nav panel,
 *  editor drag surface, and DOM containers needed for slot mounting. */
function buildDocRecord(
  filename: string,
  doc: PMNode,
  slot: Slot,
  opts: {
    handle: unknown | null;
    format: DocFormat | null;
    uid?: string;
    /** Stable Learn doc id read from the opened/recovered file
     *  (null for a brand-new doc — minted on first save). */
    docId?: string | null;
    /** Threads from the parser (docx / cmir / crash-recovery
     *  journal). Dispatched into the comments plugin AFTER
     *  `record` is initialized — `dispatchTransaction` closes
     *  over `record`, so a load-threads dispatch earlier in this
     *  function would hit a temporal-dead-zone error. */
    threads?: Thread[];
  },
): DocRecord {
  const editorEl = document.createElement('div');
  editorEl.className = 'pmd-pane-editor';
  // Open each pane's body at the configured default zoom, applied inline so it's
  // independent of the window var and the other panes.
  applyZoomToTarget(editorEl, settings.get('defaultZoomPct'));
  const navEl = document.createElement('div');
  navEl.className = 'pmd-pane-nav-host';

  // Resolve this record's uid up front so the editor state can be built for it.
  // A session's collab binding attaches ONLY to its owning uid, so a pane opened
  // during someone else's session stays independent (no document fusion).
  const uid = opts.uid ?? newDocUid();
  const state = EditorState.create({
    doc,
    schema,
    plugins: buildEditorPlugins(uid),
  });

  // Per-pane EditorView. dispatchTransaction keeps the slot's word
  // count / chip / chrome in sync; if this pane is currently focused,
  // we also nudge the shared chrome (font-size chip etc.) via
  // `setActiveView` so the ribbon stays in sync as the cursor / doc
  // changes.
  // `mounted` guards against a transaction dispatched DURING construction:
  // a plugin that dispatches from its own `view()` setup (the highlight-
  // frequency mount scan is one) fires before `const view` is assigned, so
  // `dispatchTransaction` reading `view` would hit a temporal-dead-zone
  // ReferenceError. Drop those (the mount scan re-runs on the first real
  // edit / settings toggle); real transactions arrive after `mounted` flips.
  let mounted = false;
  const view: EditorView = new EditorView(editorEl, {
    state,
    nodeViews: editorNodeViews,
    // Browser's built-in spellcheck stays OFF — `editorSpellcheck` is
    // served by the custom viewport checker (viewport-spellcheck.ts).
    attributes: { spellcheck: 'false' },
    dispatchTransaction(tx) {
      if (!mounted) return;
      // Stamp collab metas (sync-origin on the Loro binding's remote
      // transactions) BEFORE apply, mirroring the single-doc dispatch.
      tagCollabTransaction(tx);
      // Reject a user edit inside a region an AI op has leased; flash the
      // locked region. AI writes carry a bypass tag and pass through.
      if (coordinatorBlocks(view.state, tx)) {
        flashLockedLeases(view, tx);
        return;
      }
      const prevState = view.state;
      const prevDiverged = transclusionDivergenceKey.getState(prevState)?.diverged;
      const next = view.state.apply(tx);
      view.updateState(next);
      // Re-arm the autosave + journal debounces on doc-changing
      // transactions. Autosave is per-record (each DocRecord owns
      // its own enabled flag + timer), so schedule the record's
      // own save, not the single-doc global path. No-ops when
      // autosave is off for this record. Also flip the dirty flag
      // so the pane's close-X knows there are unsaved changes to
      // prompt about.
      // Suppressed while the benchmark drives temporary edits (reverted from a
      // snapshot — must never reach disk or mark the record dirty).
      if (tx.docChanged && !isBenchmarkActive()) {
        record.dirty = true;
        record.editGen++;
        scheduleAutosaveForRecord(record);
        scheduleJournalForRecord(record);
      }
      // Keep the shared comments column in sync — same updates the
      // single-doc dispatchTransaction makes, but only when this
      // view is the active one (the helper short-circuits
      // otherwise). Background-stack edits in non-focused panes
      // don't paint over the focused doc's column.
      notifyCommentsForActiveTransaction(view, prevState, next, tx.docChanged);
      // Debounce both O(doc-size) updates into a single timer:
      //   - navPanel.update walks the doc for headings (and
      //     rebuilds every `<li>`, which would invalidate any
      //     dblclick in progress if it ran per keystroke)
      //   - slot.refreshWordCount walks every text node for the
      //     read-aloud count
      // Running these on every transaction makes typing in large
      // docs O(N) per keystroke. The 200ms timer matches the
      // single-doc `scheduleHeavyUpdate` cadence.
      // Only on doc changes: a selection-only transaction (e.g. a nav
      // click's jump) doesn't change the outline, so skip the rebuild —
      // a perf win, and it stops a plain nav click from recreating the
      // `<li>`s mid-double-click.
      if (tx.docChanged) {
        // Keep this pane's cached heading positions current between the
        // debounced rebuilds so caret-tracking doesn't flicker to the next
        // heading while typing just above it (parity with single-doc, index.ts).
        record.navPanel.remapPositions(tx.mapping);
        // Sync-arrived headings fold to this pane's current depth (the
        // joined-session initial fill used to land fully expanded) —
        // parity with single-doc, and it must run before the debounced
        // rebuild refreshes lastSeenIds.
        if (isSyncOrigin(tx)) record.navPanel.applyMaxLevelToNewHeadings();
        if (record.heavyUpdateTimer !== null) {
          cancelIdle(record.heavyUpdateTimer);
        }
        record.heavyUpdateTimer = scheduleIdle(() => {
          record.heavyUpdateTimer = null;
          try {
            record.navPanel.update(view.state.doc);
            // Re-apply against the rebuilt entries (fresh positions) so a
            // structural edit doesn't leave the wrong heading lit (parity with
            // single-doc, index.ts). Positional resync → nav multi-select survives.
            record.navPanel.setCaretHeading(
              view.state.selection.from,
              selfRefSelectionPos(view.state),
              { preserveMultiSelect: true },
            );
          } catch (e) {
            console.error('[cardmirror] navPanel.update failed in multi-pane flush:', e);
          }
          // record.owner, not the build-time `slot` — the record may
          // have moved panes (`sendDocToSlotN`); refreshing the old
          // slot would leave this pane's count stale.
          record.owner.refreshWordCount();
        }, 200);
      }
      // Selection-only changes refresh just this pane's word-count
      // readout so the read time reflects the selection immediately,
      // mirroring single-pane. `liveSelectionWordCount` needs it only
      // when a range is involved on either side; `liveContainerReadTime`
      // needs every selection change, cursor moves included — the
      // enclosing container follows the caret. Cheap either way: the
      // whole-doc count is cached per doc, the container count per
      // container.
      else if (
        !prevState.selection.eq(next.selection) &&
        ((settings.get('liveSelectionWordCount') &&
          (!prevState.selection.empty || !next.selection.empty)) ||
          settings.get('liveContainerReadTime'))
      ) {
        record.owner.refreshWordCount();
      }
      // Cheap O(1) chrome refresh — keeps the font-size chip in
      // sync as the cursor moves. `setActiveView`'s call to
      // `refreshWordCount` short-circuits in multi-doc mode
      // because the shared status-bar counter is hidden anyway.
      if (getActiveView() === view) {
        setActiveView(view);
      }
      // The divergence set updates via a meta transaction (no docChanged), so
      // the docChanged-gated rebuild above misses it. Rebuild when the set's
      // identity changes so the "source updated" rail appears/clears in this
      // pane's outline — parity with single-doc (index.ts), which the shared
      // NavigationPanel renders but only when told to re-run.
      if (transclusionDivergenceKey.getState(next)?.diverged !== prevDiverged) {
        try {
          record.navPanel.update(next.doc);
          record.navPanel.setCaretHeading(next.selection.from, selfRefSelectionPos(next), {
            preserveMultiSelect: true, // positional resync, not a caret move
          });
        } catch (e) {
          console.error('[cardmirror] navPanel divergence rebuild failed:', e);
        }
      }
      // Caret-tracking for this pane's nav: highlight the heading whose section
      // contains the cursor (parity with single-doc, index.ts). Gated on the
      // caret position changing so it's cheap; per-pane, so each pane tracks its
      // own cursor. Also refire when the live-view node-selection changes even
      // if `from` held steady, so the window's nav highlight tracks it.
      const nextSelfRef = selfRefSelectionPos(next);
      if (
        prevState.selection.from !== next.selection.from ||
        selfRefSelectionPos(prevState) !== nextSelfRef
      ) {
        record.navPanel.setCaretHeading(next.selection.from, nextSelfRef);
      }
    },
  });
  // View is fully constructed and `view` is now bound — real transactions
  // may flow. (Construction-time plugin dispatches were dropped above.)
  mounted = true;

  // Per-pane nav panel. The outline-level filter is per-panel and
  // transient by construction (each section's 1/2/3/4 buttons act
  // locally; new docs open at the "Default navigation depth" setting).
  // Its × closes just THIS document's outline section (via the slot
  // the record currently lives in — records can move between slots, so
  // resolve `owner` lazily at click time, not build time).
  const navPanel = new NavigationPanel(navEl, {
    onClose: () => record.owner.shell.setSlotNavHidden(record.owner, true),
  });
  navPanel.attach(view);
  // Initial caret-heading highlight so a freshly-mounted pane reflects the
  // cursor before the first selection change (parity with index.ts).
  navPanel.setCaretHeading(view.state.selection.from, selfRefSelectionPos(view.state));

  const dragSurface = new EditorDragSurface();
  dragSurface.attach(view, editorEl);
  // Click below all content → drop the cursor at the doc's end +
  // focus. Matches the single-doc behavior; closes the "I can't
  // tap into an empty doc unless I aim at its tiny rendered line"
  // gap for per-pane editors too.
  attachClickBelowToEnd(editorEl, () => view);

  // Register this pane's view→docPath so transclusion create/refresh can resolve
  // its doc-relative source refs — multi-pane parity with the single-doc path
  // (setCurrentDocHandle in index.ts). Kept in sync on Save-As (setFocusedFile).
  setViewDocPath(view, typeof opts.handle === 'string' ? opts.handle : null);

  const record: DocRecord = {
    uid,
    filename,
    handle: opts.handle,
    format: opts.format,
    view,
    editorEl,
    navPanel,
    navEl,
    dragSurface,
    owner: slot, // re-pointed by Slot.push on every move
    savedScrollTop: 0,

    heavyUpdateTimer: null,
    journalTimer: null,
    // New docs always start with read mode OFF. The user toggles
    // it per-pane via the ribbon command after opening.
    readMode: false,
    zoomPct: settings.get('defaultZoomPct'),
    // Autosave is per-pane in multi-doc — same intent as read mode.
    // Off by default, but a file the user previously turned autosave
    // ON for restores that choice across close + reopen (keyed by path).
    autosaveEnabled: isAutosaveOnForPath(opts.handle),
    autosaveTimer: null,
    docId: opts.docId ?? null,
    // Fresh doc: clean. Flipped on first doc-changing transaction;
    // cleared on a successful save (per-record autosave OR the
    // single-doc save flow firing through the clean-token hook).
    dirty: false,
    editGen: 0,
  };
  // Publish (uid, view) so the speech-doc resolver can resolve uids
  // back to live views and (on Electron) so main learns which
  // window owns this uid. The `onSliceLanded` hook fires on the
  // destination side whenever a speech-doc slice arrives (same-
  // window OR cross-window) — refreshes nav-panel collapse state
  // for newly arrived headings using the local `maxLevel` rule.
  getSpeechDocResolver().registerView(record.uid, record.view, {
    onSliceLanded: () => record.navPanel.applyMaxLevelToNewHeadings(),
  });
  // Seed main's per-uid filename map for this record so the
  // Select-Speech-Doc modal can label it immediately. Subsequent
  // filename changes (setFocusedFilename / setFocusedFile) push
  // their own updates.
  pushPaneDocInfo(record.uid, record.filename);

  // Register a known docId (opened/recovered file) so the Learn
  // "By file" view + open-in-context can resolve this doc.
  if (record.docId) {
    learnStore.registerDoc({
      docId: record.docId,
      path: typeof record.handle === 'string' ? record.handle : null,
      name: record.filename,
      format: record.format,
    });
  }

  // Hydrate comments plugin state from the parser's threads. MUST
  // run AFTER `record` is initialized — `dispatchTransaction`
  // closes over `record`, so dispatching earlier hits a TDZ. The
  // `loadThreads` transaction is `addToHistory: false` so it
  // stays out of the undo stack. Without this, the
  // `comment_range` marks render their inline highlight but the
  // comments column has no thread data to show.
  if (opts.threads && opts.threads.length > 0) {
    view.dispatch(loadThreads(view.state, opts.threads));
  }

  // Register this window's claim on the file path (Electron only)
  // so the cross-window duplicate-open guard can find it. Main's
  // spawn-window handler already claims for the new window's id
  // when a spawn carries a payload.handle, so this re-register is
  // an idempotent no-op for spawn-target initial mounts.
  syncDocPathClaim(null, record.handle);

  return record;
}

/** Whether the multi-pane workspace is mounted right now. The
 *  research browser only opens inside a real pane, so it gates on
 *  this rather than on `settings.get('multiDocWorkspace')` directly
 *  — the setting could be on with the shell not yet mounted. */
export function multiPaneShellActive(): boolean {
  return shell !== null;
}

/** Occupied panes for the research browser's pane picker, or `[]`
 *  when the shell isn't mounted (single-doc mode). */
export function researchBrowserSlotCandidates(): Array<{
  id: SlotId;
  label: string;
  el: HTMLElement;
}> {
  return shell?.occupiedSlotPanes() ?? [];
}

/** Reserve the first empty pane for the research browser, or null
 *  when every pane is occupied / the shell isn't mounted. */
export function openResearchBrowserPane(): { id: SlotId; el: HTMLElement } | null {
  return shell?.openResearchBrowserPane() ?? null;
}

/** Release a pane reserved by `openResearchBrowserPane`. */
export function closeResearchBrowserPane(): void {
  shell?.closeResearchBrowserPane();
}

/** Force (or clear, passing null) a pane's chip title while the
 *  research browser occupies it. */
export function setResearchBrowserChipTitle(id: SlotId, text: string | null): void {
  shell?.setResearchBrowserChipTitle(id, text);
}

/** Boot-time entry point — called from editor/index.ts when the
 *  multi-doc setting is on. Installs the multi-pane shell and the
 *  file-routing hook into the shared ribbon. */
export function mountMultiPaneShell(): void {
  if (shell) return;
  shell = new MultiPaneShell();
  enableMultiDocMode({
    onFileOpen: (file) => shell!.onFileOpen(file),
    showInContext: (req) => shell!.showInContext(req),
    onNewDoc: () => shell!.createNewDoc(),
    toggleReadMode: () => shell!.toggleFocusedReadMode(),
    toggleAutosave: () => shell!.toggleFocusedAutosave(),
    zoomFocusedBy: (delta) => shell!.zoomFocusedBy(delta),
    zoomFocusedReset: () => shell!.zoomFocusedReset(),
    captureFocusedCleanToken: () => shell!.captureFocusedCleanToken(),
    newSpeechDocument: () => { void shell!.createNewSpeechDocument(); },
    markActiveAsSpeech: () => shell!.markFocusedAsSpeech(),
    sendToSpeechAtCursor: () => shell!.sendToSpeech(false),
    sendToSpeechAtEnd: () => shell!.sendToSpeech(true),
    sendToDropzone: () => shell!.sendToDropzone(),
    sendToStarred: () => shell!.sendToStarred(),
    getFocusedFilename: () => shell!.getFocusedFilename(),
    setFocusedFilename: (name) => shell!.setFocusedFilename(name),
    getFocusedFile: () => shell!.getFocusedFile(),
    setFocusedFile: (f) => shell!.setFocusedFile(f),
    setFocusedDocId: (id) => shell!.setFocusedDocId(id),
    findViewForDocId: (id) => shell!.findViewForDocId(id),
    getAllFilenames: () => shell!.getAllFilenames(),
    getFilenameForUid: (uid) => shell!.filenameForUid(uid),
    getDocIdForUid: (uid) => shell!.docIdForUid(uid),
    createSessionDoc: () => shell!.createSessionDocIntoSlot(),
    setFilenameForUid: (uid, name) => shell!.setFilenameForUid(uid, name),
    promptSaveAllForQuit: () => shell!.promptSaveAllForQuit(),
    onRecoveredDoc: (entry) => shell!.onRecoveredDoc(entry),
    journalAll: () => shell!.journalAll(),
    reduceToFocusedForModeSwitch: () => shell!.reduceToFocusedForModeSwitch(),
    getOpenHandles: () => shell!.getAllHandles(),
    toggleAllNav: () => shell!.toggleAllNav(),
    showAllNav: () => shell!.setAllNavHidden(false),
  });
}
