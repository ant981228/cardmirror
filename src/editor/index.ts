/**
 * Editor entry module.
 *
 * Mounts the ProseMirror EditorView with our schema and wires the
 * surrounding chrome: ribbon commands, open/save flows, autosave +
 * crash-recovery journaling, speech-doc routing, and the hooks the
 * multi-pane / mobile shells install to take over per-pane state.
 */

import { EditorState, Plugin, Selection, TextSelection, type Command } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { history, redo, undo } from 'prosemirror-history';
import { baseKeymap } from 'prosemirror-commands';
import { Node as PMNode, type Mark, DOMSerializer } from 'prosemirror-model';
import { schema, newHeadingId } from '../schema/index.js';
import { fromDocxFull, toDocx, serializeNative, serializeNativeAsync, parseNative, parseNativeSalvage, NativeDamagedError, readDocIdFromBytes, stampDocId, setSaveHealListener } from '../index.js';
import { transformForExport, countMarkedCards } from '../export/transform-for-export.js';
import type { Thread, Comment } from './comments-plugin.js';
import type { LocalComment } from './learn-store.js';
import { NavigationPanel } from './nav-panel.js';
import { initUpdateChip } from './update-chip.js';
import { mountTimerUI } from './timer-ui.js';
import { initTimerAudio } from './timer-audio.js';
import {
  getTimerState as getTimerStateNow,
  reconcileTimerPopout,
  setTimerPoppedOut,
  setTimerVisible,
  subscribeTimer,
} from './timer-state.js';
import { cycleTimerProfile, TIMER_PROFILE_LABELS } from './timer-profile.js';
import { isBenchmarkActive, setBenchmarkActive } from './benchmark-state.js';
import { openReference } from './reference-ui.js';
import {
  getSpeechDocResolver,
  installSpeechDocResolver,
} from './speech-doc-registry.js';
import {
  sendToSpeech as runSendToSpeech,
  takeSendSlice,
  resolveCursorStructureRange,
  buildDeleteStructureTr,
  installIncomingSpeechSliceHandler,
} from './speech-doc-send.js';
import { promptForChoice, promptForText, promptForRouteChoice, alertDialog, confirmDialog, installModalKeys, armDialogFocus } from './text-prompt.js';
import { pushOverlay, popOverlay, isTopOverlay } from './overlay-stack.js';
import { openDocMenu } from './doc-menu-ui.js';
import { createReference } from './create-reference.js';
import { showToast } from './toast.js';
import { maybeDecryptForOpen, OpenCancelledError, UnsupportedEncryptionError } from './open-encrypted.js';
import { CLIPBOARD_BUSY_MESSAGE, writeClipboardHtml } from './clipboard-write.js';
import { buildCutInPlacePlugin, installCutInPlaceContext } from './cut-in-place.js';
import { suppressGuiSelectAll } from './editable-target.js';
import { openSelectSpeechDocModal } from './select-speech-doc-ui.js';
import { dropzoneStore, deriveDropzoneLabel } from './dropzone-store.js';
import { DropzoneController } from './dropzone-ui.js';
import { mountPairingPills, initPairingWiring } from './pairing/pairing-wiring.js';
import {
  setReceivedInsertNavHook, insertMostRecentReceived, RECEIVE_NEEDS_DOC_MESSAGE } from './pairing/inbox-insert.js';
import { sendViewToStarred } from './pairing/send-to-starred.js';
import { sendViewToRecipient } from './pairing/send-to-recipient.js';
import { installExternalConsent } from './external-consent-ui.js';
import { maybeSnapshotVersion } from './version-history.js';
import { awaitWithSaveWatchdog, warnIfSlow } from './save-watchdog.js';
import { installExternalInsertHost } from './external-insert-host.js';
import { installPluginRegistry } from './plugin-registry.js';
import { createPluginApi } from './plugin-api.js';
import { installPluginJumpHost } from './plugin-jump-host.js';
import { isPluginEnabled, reconcilePluginState } from './plugins-store.js';
import { appVersion } from './install-info.js';
import {
  decodeModeSwitchMarker,
  encodeModeSwitchMarker,
  modeSwitchDirtyMap,
  type ModeSwitchDoc,
} from './mode-switch.js';
import {
  webCloseOtherWindowsForModeSwitch,
  isFileOpenInAnotherWindow,
  installWindowCoordination,
  anOlderMultiPaneWindowExists,
  closeSelfWithFallback,
} from './window-coordination.js';
import { resolveMobileLayout } from './mobile-layout.js';
import { mobilePlugin, setMobileShellActive } from './mobile-plugin.js';
import { installCardCutterGate, cardCutterActive } from './card-cutter-gate.js';
import { installPluginCommunityGate } from './plugin-community-gate.js';
import { openCutLaunchSheet } from './card-cutter-ui.js';
import { setCutterDocIdProvider } from './card-cutter-port.js';
import {
  quickCardsStore,
  buildQuickCard,
  distinctTags,
  findDuplicate,
} from './quick-cards-store.js';
import { openQuickCardAdd } from './quick-card-add-ui.js';
import { quickCardsManageUI } from './quick-cards-manage-ui.js';
import {
  quickCardSearchUI,
  openQuickCardTagPicker,
  prewarmQuickCardFiles,
} from './quick-card-search-ui.js';
import {
  learnStore,
  loadLearnStore,
  localToday,
  setShowInContextHandler,
  type ShowInContextRequest,
} from './learn-store-host.js';
import { buildDescriptor, resolveDescriptor, type AnchorDescriptor } from './learn-anchor.js';
import { countSelectionImages } from './ai/explain-context.js';
import { preciseScrollIntoView } from './precise-scroll.js';
import {
  captureViewportAnchor,
  restoreViewportAnchor,
  type ViewportAnchor,
} from './scroll-anchor.js';
import { voicePlugin } from './voice/plugin.js';
import { VoiceController } from './voice/controller.js';
import { openCardEditor } from './learn-create-ui.js';
import { openLearnManage } from './learn-manage-ui.js';
import { openBulkConvert, runConvertSingleFileWeb } from './bulk-convert-ui.js';
import { openBulkCompress, runCompressSingleFileWeb } from './bulk-compress-ui.js';
import { bulkCompressEnabled } from './bulk-compress-gate.js';
import { openClean, runCleanSingleFileWeb } from './clean-ui.js';
import { homeScreen, type HomeScreenCallbacks } from './home-screen.js';
import { recordRecent, removeRecent, listRecents, type RecentFile } from './recents-store.js';
import { isAutosaveOnForPath, setAutosaveForPath } from './autosave-prefs-store.js';
import {
  settings,
  condenseWarningCloseFor,
  CUSTOM_OVERRIDE_TOKEN_NAMES,
  DISPLAY_SIZE_KEYS,
  DISPLAY_COLOR_KEYS,
  PARAGRAPH_SPACING_KEYS,
  type DisplaySizes,
  type DisplayTypography,
  type StyleAlignments,
  type DisplayColors,
  type FormattingPanelMode,
  ZOOM_MIN_PCT,
  ZOOM_MAX_PCT,
  CHROME_SCALE_MIN_PCT,
  CHROME_SCALE_MAX_PCT,
  migrateAutoUpdateOptOut,
} from './settings.js';
import { openSaveAs } from './save-as-ui.js';
import { highlightColorLabel, shadingColorLabel } from './color-palette.js';
import { viewportSpellcheckPlugin } from './viewport-spellcheck.js';
import { commentsPlugin, commentsKey, loadThreads, getCommentsState, gcOrphanThreads, newCommentId, setCommentIdSessionResolver } from './comments-plugin.js';
import { commentClipboardPlugin } from './comment-clipboard.js';
import { commentGuardPlugin } from './comment-guard.js';
import { pillScrollClearancePlugin } from './pill-scroll-clearance.js';
import { scheduleIdle, cancelIdle, type IdleHandle } from './idle-scheduler.js';
import { CommentsColumn, addCommentToSelection, FC_PREFIX, AI_PREFIX, NOTE_PREFIX } from './comments-ui.js';
import { runAiCreateCite } from './ai/cite-creator.js';
import { runReformatAllCites } from './ai/reformat-all-cites.js';
import { runTranslate } from './translate.js';
import { runRepairText } from './ai/repair-text.js';
import { runRepairFormatting } from './ai/repair-formatting.js';
import { runSendToFlow, runPullFromFlow, runCreateFlow, runStartFlowHost } from './flow-port.js';
import {
  readModePlugin,
  PMD_READ_MODE_TOGGLE,
  readModeAwareUndo,
  readModeAwareRedo,
} from './read-mode-plugin.js';
import { markUnreadPlugin, MARK_UNREAD_TOGGLE } from './mark-unread-plugin.js';
import { makeSelfRefPlugin } from './self-transclusion-plugin.js';
import {
  enterBelowSelfRef,
  openInsertSelfRef,
  openInsertInDocCopy,
  selfRefSelectionPos,
} from './self-transclusion-commands.js';
import {
  flattenSelfRefs,
  flattenSelfRefsInSlice,
  fragmentHasSelfRef,
  isSelfRef,
} from './self-transclusion.js';
import { rememberLinkedCopy, clearLinkedCopy } from './clipboard-link-cache.js';
import { makeTransclusionDivergencePlugin, transclusionDivergenceKey } from './transclusion-divergence-plugin.js';
import {
  setCollabSessionStarter,
  setCollabSessionJoinPrompt,
  tagCollabTransaction,
  collabPluginSourceFor,
  collabPluginsFor,
  setCollabInviteJoiner,
  setCollabInviter,
  collabCopresenceFor,
  collabCloseKeepResumable,
  collabEndOrLeaveSession,
  collabCaptureSessionHandoff,
  collabLiveSessionCount,
  collabRoomIsLive,
  collabRoomClaimKey,
  notifyCollabFocusChange,
} from './collab/collab-hooks.js';
import { learnHighlightPlugin, flashcardRangeAt } from './learn-highlight-plugin.js';
import { repairHighlightPlugin } from './repair-highlight-plugin.js';
import { aiWorkingPlugin } from './ai/ai-working-plugin.js';
import { editCoordinatorPlugin, coordinatorBlocks, flashLockedLeases } from './ai/edit-coordinator.js';
import { cardCutterPreviewPlugin, cardCutterFlagPlugin } from './card-cutter-preview-plugin.js';
import { italicCaretPlugin } from './italic-caret-plugin.js';
import { absorbPlugin } from './absorb-plugin.js';
import { containerIntegrityPlugin } from './container-integrity-plugin.js';
import { citeClassifierPlugin } from './cite-classifier-plugin.js';
import { namedStyleNormalizerPlugin } from './named-style-normalizer-plugin.js';
import { fontSizeClassPlugin } from './font-size-class-plugin.js';
import { cardNumberingPlugin, NUMBERING_REFRESH, numberingSampleGlyph, numberingDisplaySig } from './numbering-plugin.js';
import { numberingSelectionState, registerNavNumberingScope } from './numbering-commands.js';
import {
  buildSimilarSelectionPlugin,
  selectAllOfStyle,
  getSimilarSelectionState,
  type StyleSelector,
} from './similar-selection-plugin.js';
import { findReplacePlugin } from './find-replace-plugin.js';
import { repairParagraphPlugin } from './repair-paragraph-plugin.js';
import { frozenSelectionPlugin } from './frozen-selection-plugin.js';
import { pilcrowSelectionPlugin } from './pilcrow-selection-plugin.js';
import {
  transclusionSelectionGuard,
  transclusionEmptyZoneReaper,
} from './transclusion-selection-guard.js';
import { buildMacroKeymap } from './keyboard-macros.js';
import { FindReplaceBar } from './find-replace-ui.js';
import { RepairParagraphBar } from './repair-paragraph-ui.js';
import { tableEditingPlugin, columnResizingPlugin } from './table-plugins.js';
import { buildPastePlugin } from './paste-plugin.js';
import { buildImageNodeFromBlob, insertImageNode } from './image-insert.js';
import { imageContextMenuPlugin } from './image-context-menu-plugin.js';
import { editorNodeViews } from './image-resize-nodeview.js';
import { setViewDocPath, getViewDocPath } from './transclusion-doc-path.js';
import { isSyncOrigin } from './sync-origin.js';
import { listSessionRecords, deleteSessionRecord } from './collab/collab-store.js';
import { collabEnabled } from './collab/collab-gate.js';
import { parseJoinLinkHash } from './collab/join-link.js';
import { setRePickOpener, setOpenSourceOpener } from './transclusion-actions.js';
import { isLiteBuild } from './lite.js';
import { isTransclusionNode, fragmentHasZone } from './transclusion.js';
import { showConfirm } from './confirm-dialog.js';
import { linkContextMenuPlugin } from './link-context-menu-plugin.js';
import { textContextMenuPlugin } from './text-context-menu-plugin.js';
import { wordSelectionPlugin } from './word-selection-plugin.js';
import { typeOverBoundaryPlugin, crossContainerDeleteSelection, neverThrow } from './type-over-boundary.js';
import { readerViewPlugin, applyReaderViewToTarget } from './reader-view.js';
import { headingIdGuardPlugin } from './heading-id-guard.js';
import { smartQuotesPlugin } from './smart-quotes-plugin.js';
import { customDashPlugin } from './custom-dash-plugin.js';
import { autoCapitalizePlugin } from './auto-capitalize-plugin.js';
import { customAutocorrectPlugin } from './custom-autocorrect-plugin.js';
import { footnotePopoverPlugin } from './footnote-popover.js';
import { wordSelectionKeymap } from './word-selection-keymap.js';
import { morphModePlugin, toggleMorphMode } from './morph-mode.js';
import { highlightFrequencyPlugin } from './highlight-frequency-plugin.js';
import { editorDragSurface } from './drag-editor-surface.js';
import {
  backspaceAtTagStart,
  backspaceAtFirstBodyStart,
  deleteAtTagEnd,
  deleteAtContainerEnd,
  enterMidTag,
  enterAtTagEnd,
  enterInHeading,
  enterAtZoneStart,
} from './tag-keymap.js';
import { enterWithConfiguredStyle } from './enter-style.js';
import { keepCursorInLeadingBlockOnBlockedMerge, blockBackspaceNodeSelect, blockDeleteNodeSelect } from './boundary-cursor-keymap.js';
import {
  journalPredatesFile,
  journalStalenessBaseline,
  markRecoveredDraft,
  recoveredDraftJournalSavedAt,
  clearRecoveredDraftMark,
  autosaveBlockedForRecoveredDraft,
} from './journal-staleness.js';
import { makeBlankDoc } from './blank-doc.js';
import { opensAsBlank, blankDocumentBytes } from './empty-open.js';
import { indentParagraph, outdentParagraph } from './indent-keymap.js';
import {
  registerRibbonTooltip,
  unregisterRibbonTooltip,
  reapplyAllRibbonTooltips,
} from './ribbon-tooltips.js';
import { availableRibbonCommandIds } from './ribbon-availability.js';
import { setIcon } from './icons.js';
import { runSettingCommand, settingCommandLabel } from './setting-commands.js';
import {
  buildRibbonKeymap,
  commandLabelFor,
  getRibbonCommand,
  formatKeyForDisplay,
  primaryKeyFor,
  ribbonKeyStringFor,
  ribbonCommandForKey,
  setFontSize,
  adjustFontSize,
  compileShrinkProtections,
  RIBBON_COMMAND_LABELS,
  RIBBON_COMMAND_IDS,
  type StructuralRibbonCommandId,
  type RibbonContext,
  type AnyCommandId,
  type RibbonCommandId,
} from './ribbon-commands.js';
import { openWordCount } from './word-count-ui.js';
import { wireColorPanel } from './color-panel.js';
import { AI_DISABLED_MESSAGE } from './ai/llm.js';
import { postNotice, wireStatusNotices } from './status-notices.js';
import {
  countReadAloudWords,
  countReadAloudSplit,
  totalWords,
  formatReadTimeFor,
  formatNumber,
  type ReadAloudCounts,
} from './word-count.js';
import { liveContainerSegment, remainingReadSegment } from './live-read-time.js';
import { getHost, getElectronHost, isWindowsHost, isSameOpenHandle, type OpenedFile, type JournalEntry } from './host/index.js';
import {
  installGlobalErrorSurface,
  fileLockedMessage,
  isFileGoneError,
  isFileChangedOnDiskError,
  isWriteBlockedError,
} from './error-surface.js';
import { captureCleanToken } from './save-clean-token.js';
import { wireWebEditionHeaderButtons } from './web-download.js';
import { computeSelectionChrome, type SelectionChrome } from './selection-chrome.js';
import { formatSpeechFilename } from './speech-filename.js';

// Install the last-resort error hooks before ANY app wiring — an exception
// during boot or in a fire-and-forget flow must never be invisible again.
installGlobalErrorSurface();

// Save-time structural tripwire reporting (structural-integrity audit,
// tier 1): a save that found an invalid doc heals it and reports here.
// Surface it (rate-limited — journal writes fire every ~1-2s while the
// producer bug is live) and keep a durable ring buffer of diagnostics
// so the still-unidentified shell producer can be caught red-handed
// from a field report instead of another corrupted file.
setSaveHealListener(({ error, healed }) => {
  console.error(`[cardmirror] invalid doc at save (healed=${healed}): ${error}`);
  try {
    const KEY = 'cm-save-heal-log';
    const log = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown[];
    log.push({ at: new Date().toISOString(), healed, error });
    localStorage.setItem(KEY, JSON.stringify(log.slice(-20)));
  } catch {
    /* diagnostics only — never let logging break a save */
  }
  // One coalescing chip entry instead of a once-a-minute toast
  // heartbeat (Issue #34 field report: unreadable, unscreenshotable,
  // and repeated for as long as the wound stayed open). The first
  // occurrence still toasts; repeats bump the ×N counter.
  postNotice({
    severity: healed ? 'warning' : 'error',
    title: healed ? 'Document repaired while saving' : 'Document damaged — repair failed',
    body: healed
      ? 'CardMirror repaired invalid document structure while saving. Please report this — it means a bug corrupted the document in memory. Reopening the document clears the condition.'
      : 'CardMirror found invalid document structure it could not repair while saving. Please report this.',
    key: `save-heal:${healed}`,
  });
});

// Web edition only: reveal + wire the "Download the desktop app" and
// GitHub buttons in the ribbon's right-hand grid (no-op under Electron).
wireWebEditionHeaderButtons();
wireStatusNotices();

// (The pre-launch join-link and session-record gate overrides lived
// here; the 2026-08-19 ungating made them redundant — the gate itself
// is open on every desktop-layout browser now.)

// Web account linking from the browser: renewal runs quietly at boot,
// and the console handle stays for support/diagnostics (the settings
// tab is the real UI). Lazy import: the collab chunk must not load
// before the gate check.
if (collabEnabled() && !getElectronHost()) {
  void (async () => {
    const [account, relay] = await Promise.all([
      import('./collab/web-account.js'),
      import('./collab/collab-relay.js'),
    ]);
    const base = () => relay.relayBaseUrl();
    if (base()) account.scheduleWebRenewal(base());
    (window as unknown as Record<string, unknown>)['__cmWebAccount'] = {
      connect: (code: string, opts?: { confirmEvict?: boolean }) =>
        account.webAccountConnect(base(), code, opts),
      disconnect: () => account.webAccountDisconnect(),
      status: () => account.webAccountStatus(),
    };
  })();
}

// Session invite links (#join=<shareCode>&pass=…): parse and CLEAR the
// fragment immediately — the share code carries the room's E2E key and
// must not linger in the address bar or history — then offer the join
// once the editor shell is up. The guest pass (when present) is what
// lets a browser with no account and no token authenticate; joiners
// with their own credentials simply don't need it.
// Gate-independent on purpose: the mobile shell's gate is CLOSED, but
// a phone user tapping an invite link still deserves the clean
// refusal below rather than a silently ignored hash.
if (!getElectronHost() && !isLiteBuild() && window.location.hash.includes('join=')) {
  const joinParts = parseJoinLinkHash(window.location.hash);
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  if (joinParts && isMobileLayout()) {
    // Deliberately unsupported (user decision 2026-08-18): co-editing
    // is a desktop-layout feature. A clean refusal beats the mobile
    // shell's script error — and beats silently ignoring the link.
    setTimeout(() => {
      void alertDialog(
        'This invite link opens a live co-editing session, which needs the ' +
          'desktop layout — open it on a computer (or a Chromebook) instead.',
      );
    }, 600);
  } else if (joinParts) {
    const offerJoin = async (): Promise<void> => {
      const go = await confirmDialog(
        'Join the shared session from this link? You will edit the document live with its host.',
        { okLabel: 'Join Session' },
      );
      if (!go) return;
      const m = await loadCollabUi();
      await m.joinSessionWithCode(
        multiDocActive ? makeMultiPaneSessionDeps() : collabDeps,
        joinParts.shareCode,
        { guestPass: joinParts.guestPass },
      );
    };
    // Late bindings (collabDeps etc.) resolve by the time this fires.
    const joinPoll = setInterval(() => {
      if (!document.getElementById('editor')) return;
      clearInterval(joinPoll);
      void offerJoin();
    }, 250);
  }
}

// UI tour auto-start for fresh profiles (desktop layout only — the
// mobile UI has no ribbon to tour). The module polls for the editor
// chrome itself, so first boots that land on the home screen tour on
// the first opened document instead.
if (!isMobileLayout()) {
  void import('./ui-tour.js').then((m) => m.maybeAutoStartUiTour());
}

// Tag the body with the host kind so CSS can gate platform-specific chrome
// (e.g. the Paste Text button appears only in the browser edition).
document.body.classList.add('pmd-host-' + getHost().kind);
// Tag in-place-save capability separately from host kind: the autosave button
// is gated on this (Electron always; a Chromium browser with the File System
// Access API; hidden on Firefox/Safari where Save can only ever Save-As).
if (getHost().supportsInPlaceSave) {
  document.body.classList.add('pmd-inplace-save');
}

const editorEl = document.getElementById('editor')!;
/** Single-doc scroll container. `#app` is `position: fixed` +
 *  `overflow-y: auto` in single-doc layout (see `style.css`) so it
 *  owns the editor's scroll. Multi-pane has its own per-pane
 *  scrollers (`.pmd-pane-body`); this reference is only meaningful
 *  for single-doc paths (initial-mount reset, etc.). */
const appEl = document.getElementById('app')!;

/** Mousedown handler: when the user clicks below the rendered
 *  content of `view.dom` but still inside the editor wrapper, drop
 *  the cursor at the doc's end and focus the view. PM's built-in
 *  click handling only fires for clicks that land inside the
 *  contenteditable surface; on a near-empty doc (a single empty
 *  paragraph) `view.dom`'s rendered height is ~20px, so clicks in
 *  the editor's empty whitespace below it do nothing — the user
 *  has to aim at the tiny rendered paragraph. This handler closes
 *  that gap. Wired once per editor surface (single-doc + each
 *  multi-pane DocRecord). Restrict to clicks OUTSIDE `view.dom`
 *  AND vertically below its bottom so we never hijack a click PM
 *  would handle naturally. */
export function attachClickBelowToEnd(
  wrapperEl: HTMLElement,
  getView: () => EditorView | null,
): void {
  wrapperEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const v = getView();
    if (!v) return;
    if (e.target instanceof Node && v.dom.contains(e.target)) return;
    const rect = v.dom.getBoundingClientRect();
    if (e.clientY <= rect.bottom) return;
    e.preventDefault();
    const tr = v.state.tr.setSelection(Selection.atEnd(v.state.doc));
    v.dispatch(tr.scrollIntoView());
    v.focus();
  });
}
// Wire it for the single-doc editor surface. Multi-pane wires its
// own per-record surface in `buildDocRecord`.
attachClickBelowToEnd(editorEl, () => view);
const navEl = document.getElementById('nav-panel')!;
const homeBtn = document.getElementById('home-btn') as HTMLButtonElement | null;
const openBtn = document.getElementById('open-btn') as HTMLButtonElement;
const newBtn = document.getElementById('new-btn') as HTMLButtonElement | null;
const exportBtn = document.getElementById('export-btn') as HTMLButtonElement;
const autosaveBtn = document.getElementById('autosave-btn') as HTMLButtonElement | null;
const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement;
const referenceBtn = document.getElementById('reference-btn') as HTMLButtonElement | null;
const readModeBtn = document.getElementById('read-mode-btn') as HTMLButtonElement;
const readerViewBtn = document.getElementById('reader-view-btn') as HTMLButtonElement | null;
const navPanePullTab = document.getElementById('nav-pane-pull-tab') as HTMLButtonElement | null;
const insertImageBtn = document.getElementById('insert-image-btn') as HTMLButtonElement | null;
// Speech-doc buttons. Visible in multi-doc and multi-window modes
// (CSS-gated on `body.pmd-multi-doc` / `body.pmd-multi-window`);
// the click handlers route through the shell's ctx hooks in
// multi-pane and fall back to the single-doc implementations
// otherwise.
const speechNewBtn = document.getElementById('speech-new-btn') as HTMLButtonElement | null;
const speechMarkBtn = document.getElementById('speech-mark-btn') as HTMLButtonElement | null;
const speechSendCursorBtn = document.getElementById('speech-send-cursor-btn') as HTMLButtonElement | null;
const speechSendEndBtn = document.getElementById('speech-send-end-btn') as HTMLButtonElement | null;
/** Resolver for "what value should the read-mode ribbon button
 *  show as pressed?". Single-doc mode reads `settings.readMode`;
 *  multi-doc swaps in a resolver that asks the focused pane's
 *  per-DocRecord state via `setReadModeStateResolver`.
 *  Declared up here (not next to `setReadModeStateResolver`)
 *  because `applyReadMode` runs at module-init time before the
 *  bottom-of-file declarations execute — a TDZ access otherwise. */
let readModeStateForActive: () => boolean = () => settings.get('readMode');

/** Resolver for "is autosave on for the doc the ribbon should
 *  reflect?". Single-doc reads the (transient) `settings.autosaveEnabled`
 *  value; multi-doc swaps in a resolver that asks the focused
 *  pane's per-DocRecord state via `setAutosaveStateResolver`. */
let autosaveStateForActive: () => boolean = () => settings.get('autosaveEnabled');

// Install the Electron-aware speech-doc resolver before any
// subscribers attach. On the browser this is a no-op; on Electron
// it swaps in the main-process-mirroring resolver so doc
// registrations and speech-set calls flow through IPC.
installSpeechDocResolver(getHost());

/** Sync the speech-mark button's aria-pressed with whether the
 *  currently-active view IS the speech doc. Called from
 *  `setActiveView` (focus change) and from the speech-doc
 *  registry subscription installed below. Also drives the
 *  multi-window speech-doc banner (the prominent "🎤 This is the
 *  speech document" strip below the ribbon). */
function refreshSpeechMarkBtn(): void {
  const resolver = getSpeechDocResolver();
  const isSpeechDoc =
    !!view && resolver.getSpeechUid() === currentDocUid;
  if (speechMarkBtn) {
    speechMarkBtn.setAttribute('aria-pressed', isSpeechDoc ? 'true' : 'false');
  }
  // Banner is only meaningful when this window IS the speech doc.
  // Multi-pane mode hides it via CSS (it uses per-pane chips); the
  // body class toggle here just controls the multi-window case.
  const banner = document.getElementById('speech-doc-banner');
  if (banner) banner.hidden = !isSpeechDoc;
  document.body.classList.toggle('pmd-speech-banner-visible', isSpeechDoc);
}

/** Single-doc mark-as-speech toggle. Routes through the resolver,
 *  which (on Electron) propagates the change to main and broadcasts
 *  to every window. */
function toggleMarkSingleDocAsSpeech(): void {
  const resolver = getSpeechDocResolver();
  if (resolver.isSpeechByUid(currentDocUid)) {
    resolver.setSpeechByUid(null);
  } else {
    resolver.setSpeechByUid(currentDocUid);
  }
}

/** Single-doc send-to-speech. Hands off to the shared helper, which
 *  decides whether to insert locally (speech doc is in THIS renderer)
 *  or route via main (speech doc is in another window). */
function runSingleDocSendToSpeech(sourceView: EditorView, atEnd: boolean): void {
  runSendToSpeech(sourceView, atEnd);
}

/** Send-to-dropzone for any view: mirrors send-to-speech's
 *  source-resolution (explicit selection if present, else the
 *  enclosing card / analytic_unit / heading) but routes the
 *  resulting slice into the dropzone shelf instead of a speech
 *  doc. The store handles the cross-window broadcast — every
 *  nav-pane bubble updates immediately. Exported for the multi-
 *  pane shell, which calls this with its focused-slot view. */
export async function sendViewToDropzone(sourceView: EditorView): Promise<void> {
  const slice = takeSendSlice(sourceView);
  if (!slice) return;
  const first = slice.content.firstChild;
  const type = first ? first.type.name : 'text';
  await dropzoneStore.add({
    id: `dz-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    label: deriveDropzoneLabel(slice, type),
    type,
    sliceJson: slice.toJSON(),
    createdAt: Date.now(),
  });
}

/** Text of the smallest heading enclosing the selection — the nearest
 *  preceding `block`, else `hat`, else `pocket` (the nearest preceding
 *  structural heading of any level IS the smallest enclosing one,
 *  since headings define sections by running until the next
 *  equal-or-shallower heading). Empty string if none precedes. Used to
 *  pre-fill the Add Quick Card name. */
function smallestEnclosingHeadingText(state: EditorState): string {
  const from = state.selection.from;
  let text = '';
  state.doc.nodesBetween(0, from, (node) => {
    const t = node.type.name;
    if (t === 'pocket' || t === 'hat' || t === 'block') {
      text = node.textContent.trim();
    }
    return true;
  });
  return text;
}

/** Add Quick Card: save the current selection — or the cursor's enclosing
 *  card / section when there's no selection — as a named, tagged snippet.
 *  Routes through `takeSendSlice`, mirroring the send-to commands: an explicit
 *  selection is normalized to whole structural units and re-highlighted as
 *  feedback, so a quick card is always a clean structural unit and never a
 *  half-card or stray fragment. Name pre-fills with the smallest enclosing
 *  heading; the (name, tag-set) uniqueness rule is enforced via the dialog's
 *  inline validator. */
async function runAddQuickCard(sourceView: EditorView): Promise<void> {
  const slice = takeSendSlice(sourceView);
  if (!slice) {
    showToast('Put the cursor in a card or section, or select one, to save as a quick card.');
    return;
  }
  const result = await openQuickCardAdd({
    initialName: smallestEnclosingHeadingText(sourceView.state),
    existingTags: distinctTags(quickCardsStore.list()),
    findConflict: (name, tags) => findDuplicate(quickCardsStore.list(), name, tags) ?? null,
    onOpenConflict: (card) => {
      void quickCardsManageUI.open({ selectId: card.id });
    },
  });
  if (!result) return;
  const plainText = slice.content.textBetween(0, slice.content.size, '\n', '\n');
  const card = buildQuickCard({
    name: result.name,
    tags: result.tags,
    contentJson: slice.toJSON(),
    plainText,
    sourceName: activeFile().filename ?? '',
  });
  await quickCardsStore.upsert(card);
  showToast(`Saved quick card “${card.name}”.`);
}

/** Select the cursor's enclosing structure — the current card /
 *  analytic_unit / heading + subtree — using the send commands'
 *  bounds logic but **ignoring any active selection** (it keys off
 *  the cursor only). `TextSelection.between` snaps the raw block
 *  bounds to a valid text selection spanning the whole region. */
function selectCurrentHeadingIn(sourceView: EditorView): void {
  const range = resolveCursorStructureRange(sourceView);
  if (!range) return;
  const { doc } = sourceView.state;
  sourceView.dispatch(sourceView.state.tr.setSelection(headingContentSelection(doc, range)).scrollIntoView());
  sourceView.focus();
}

/** A selection covering a structural range. Normally `TextSelection.between`
 *  (clamps endpoints to textblocks). But a range that ENDS in a block LEAF ATOM
 *  — a live view (`self_ref`) — has no textblock after it, so `between` snaps the
 *  end back BEFORE the view, dropping it from the selection ("stops at the top of
 *  the live view"). `TextSelection.create` honors the exact range, so the trailing
 *  view is included (the self-ref plugin then highlights the spanned view). */
function headingContentSelection(doc: PMNode, range: { from: number; to: number }): Selection {
  const before = doc.resolve(range.to).nodeBefore;
  if (before && before.isBlock && before.isAtom) {
    try {
      return TextSelection.create(doc, range.from, range.to);
    } catch {
      /* fall through to the clamped selection */
    }
  }
  return TextSelection.between(doc.resolve(range.from), doc.resolve(range.to));
}

/** Delete the cursor's enclosing structure (same bounds as
 *  `selectCurrentHeadingIn`, cursor-only). Removes the whole node range
 *  so nothing is left behind — notably no blank card shell, which is
 *  what a select-then-Delete over an isolating card would leave. */
function deleteCurrentHeadingIn(sourceView: EditorView): void {
  const tr = buildDeleteStructureTr(sourceView.state);
  if (!tr) return;
  sourceView.dispatch(tr);
  sourceView.focus();
}

/** Copy the cursor's enclosing structure to the clipboard (same
 *  bounds as `selectCurrentHeadingIn`, also ignoring any active
 *  selection) as both HTML and plain text, without moving the cursor
 *  or changing the selection. Mirrors the nav pane's copy-heading
 *  serialization. */
async function copyCurrentHeadingIn(sourceView: EditorView): Promise<void> {
  const range = resolveCursorStructureRange(sourceView);
  if (!range) return;
  const slice = sourceView.state.doc.slice(range.from, range.to);
  const serializer = DOMSerializer.fromSchema(sourceView.state.schema);
  const tmp = document.createElement('div');
  tmp.appendChild(serializer.serializeFragment(slice.content));
  const html = tmp.innerHTML;
  const text = slice.content.textBetween(0, slice.content.size, '\n', '\n');
  // Shared host-first / retrying path — and every outcome surfaces
  // (see clipboard-write.ts for the silent-failure history).
  if (await writeClipboardHtml(html, text)) showToast('Copied!');
  else showToast(CLIPBOARD_BUSY_MESSAGE);
}

/** Single-doc new-speech-document. Verbatim's `NewSpeech` prompts
 *  for a round name ("1NC", "2AC vs Hogwarts") and builds a fresh
 *  speech doc titled accordingly. In multi-window mode we spawn a
 *  new window pre-loaded with that doc and ask the spawned window
 *  to self-mark as the speech doc once it mounts. If the
 *  `defaultSpeechDocFolder` setting is set, we save the doc into
 *  that folder before spawning so the new window opens with a
 *  real handle (subsequent ⌘S writes silently in place); when
 *  unset, the new window opens unsaved and the user picks a save
 *  location later via Save As. */
async function runNewSpeechDocumentSingleDoc(): Promise<void> {
  const host = getHost();
  if (!host.canSpawnWindow) {
    void alertDialog(
      'New Speech Document opens a separate window, which the web version can’t ' +
        'create. To use a speech document here, turn on the Three-pane workspace ' +
        '(Settings → General) — it shows several docs side by side in one window, ' +
        'where one can be marked as the speech doc. (Or, in a second browser tab, ' +
        'open a doc and use “Mark active doc as speech”.)',
    );
    getActiveView()?.focus(); // reclaim focus the alert stole (Windows/Linux)
    return;
  }
  // Electron disables window.prompt(); use an in-renderer modal
  // instead. Trims the result for us and returns null on cancel.
  const speechName = await promptForText({
    message: 'Which speech? (e.g. 1NC, 2AC Round 3 vs Hogwarts)',
    placeholder: '1NC',
    okLabel: 'Create',
  });
  if (speechName == null) return;
  if (!speechName) return;
  const trimmed = speechName;

  const format = settings.get('defaultSpeechDocFormat');
  const initialFilename = formatSpeechFilename(trimmed, format);
  // Pocket heading is the filename minus its extension when the
  // user has opted in; otherwise start fully blank. Off case lets
  // users title their speeches inline rather than via the chip.
  const docNode = settings.get('includeSpeechDocPocket')
    ? makeSpeechBlankDoc(initialFilename.replace(/\.(cmir|docx)$/i, ''))
    : makeBlankNewDoc();

  let docBytes: Uint8Array;
  try {
    docBytes =
      format === 'cmir' ? serializeNative(docNode) : await toDocx(docNode, { defaultFont: settings.get('bodyFont') });
  } catch (err) {
    console.error('Speech-doc serialization failed:', err);
    void alertDialog(
      `Couldn't create speech document: ${err instanceof Error ? err.message : err}`,
    );
    return;
  }

  // Optional auto-save into the configured speech-doc folder.
  // Skipped silently when the setting is empty (no folder = no
  // automatic save).
  let handle: string | null = null;
  let filename = initialFilename;
  const defaultFolder = settings.get('defaultSpeechDocFolder').trim();
  const electronForSpeechSave = getElectronHost();
  if (defaultFolder && electronForSpeechSave) {
    const targetPath = joinSpeechDocPath(defaultFolder, filename);
    try {
      // A brand-new file — use the at-path writer (which also creates
      // the folder if needed); `saveExisting` refuses paths that don't
      // exist on disk. Electron-only, like the folder setting itself.
      // failIfExists: a custom filename template can drop the
      // timestamp, which makes two docs of the same name easy. Hand
      // the collision to the native dialog rather than clobbering.
      const result = await electronForSpeechSave.writeFileAtPath(
        targetPath,
        docBytes,
        { failIfExists: true },
      );
      if (result === 'collision') {
        const saved = await host.saveAs(filename, docBytes, {
          filters: saveFiltersForFormat(format),
          nearPath: targetPath,
        });
        // Cancelled dialog: carry on unsaved rather than losing the
        // doc. The user still gets the window and can Save As later.
        if (saved) {
          handle = typeof saved.handle === 'string' ? saved.handle : null;
          filename = saved.name;
        }
      } else {
        handle = targetPath;
      }
    } catch (err) {
      console.warn('Auto-save of new speech doc to default folder failed:', err);
      // Continue without a handle; the user can Save As later.
    }
  }

  const uid = newSessionDocUid();
  try {
    await host.spawnWindow({
      filename,
      bytes: docBytes,
      handle,
      format,
      uid,
      markAsSpeech: true,
    });
  } catch (err) {
    console.error('Failed to spawn new speech window:', err);
    void alertDialog(
      `Failed to open new speech window: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/** Speech-doc starter: a Pocket heading carrying the user-supplied
 *  title plus a trailing empty paragraph for the cursor to land in.
 *  Same shape as multi-pane's `makeSpeechBlankDoc`. */
function makeSpeechBlankDoc(title: string): PMNode {
  return schema.nodes['doc']!.createChecked(null, [
    schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text(title)),
    schema.nodes['paragraph']!.create(null),
  ]);
}

/** Concatenate a folder path with a filename, handling trailing
 *  separators on the folder. Forward slash works on every platform
 *  Electron supports (Windows accepts both `/` and `\` in fs paths). */
function joinSpeechDocPath(folder: string, filename: string): string {
  const trimmedFolder = folder.replace(/[/\\]+$/, '');
  return `${trimmedFolder}/${filename}`;
}
// Subscribe to the speech-doc registry so the button stays in sync
// when the designation changes outside of a focus event (e.g., the
// shell marks a fresh `newSpeech` doc as soon as it lands, or main
// broadcasts a speech change made in another window).
getSpeechDocResolver().subscribe(() => refreshSpeechMarkBtn());
const wordCountBtn = document.getElementById('word-count-btn') as HTMLButtonElement;
const commentsToggleBtn = document.getElementById('comments-toggle-btn') as HTMLButtonElement | null;
const commentsAddBtn = document.getElementById('comments-add-btn') as HTMLButtonElement | null;
const addNoteBtn = document.getElementById('add-note-btn') as HTMLButtonElement | null;
const createFlashcardBtn = document.getElementById('create-flashcard-btn') as HTMLButtonElement | null;
const manageFlashcardsBtn = document.getElementById('manage-flashcards-btn') as HTMLButtonElement | null;
const askAiBtn = document.getElementById('ask-ai-btn') as HTMLButtonElement | null;
const commentsColumnEl = document.getElementById('comments-column') as HTMLElement | null;
const wordCountText = document.getElementById('word-count-text')!;
const cursorColorDisplay = document.getElementById('cursor-color-display') as HTMLElement;
const cursorColorText = document.getElementById('cursor-color-text')!;
const plainPasteToggleBtn = document.getElementById('plain-paste-toggle-btn') as HTMLButtonElement | null;
const fontSizeInput = document.getElementById('font-size-input') as HTMLInputElement | null;
const fontSizePickerBtn = document.getElementById('font-size-picker-btn') as HTMLButtonElement | null;
const fontSizeControlEl = fontSizeInput?.parentElement as HTMLDivElement | null;
const fontSizeUpBtn = document.getElementById('font-size-up-btn') as HTMLButtonElement | null;
const fontSizeDownBtn = document.getElementById('font-size-down-btn') as HTMLButtonElement | null;

// Mirror the paste-plugin's armed flag onto the Paste Text button: aria-pressed
// (the lit state) plus a state-aware tooltip. The common path (clipboard read
// succeeds) pastes immediately and never arms; this only lights up on the
// browser fallback when the read is denied, where the tooltip then explains that
// the next Ctrl/Cmd+V does the paste.
function updatePlainPasteIndicator(armed: boolean): void {
  if (!plainPasteToggleBtn) return;
  plainPasteToggleBtn.setAttribute('aria-pressed', armed ? 'true' : 'false');
  // Route through the tooltip controller so ribbonTooltipMode governs whether it
  // shows. Armed → drop the F2 hint (Ctrl/Cmd+V is the actionable key now).
  if (armed) {
    registerRibbonTooltip({
      el: plainPasteToggleBtn,
      label: 'Plain paste armed — press Ctrl/Cmd+V to paste as text',
    });
  } else {
    registerRibbonTooltip({
      el: plainPasteToggleBtn,
      commandId: 'pasteAsText',
      label: 'Paste the clipboard as unformatted text',
    });
  }
}
// Update chip (install-on-confirm) — desktop only; the element stays
// hidden on web / when the packaged shell predates the chip API.
{
  const updateChipEl = document.getElementById('update-chip') as HTMLButtonElement | null;
  const chipHost = getElectronHost();
  if (updateChipEl && chipHost) initUpdateChip(updateChipEl, chipHost);
}

// Timer pop-out reconciliation — the timer always LAUNCHES popped
// in. The persisted poppedOut flag is cleared iff no pop-out window
// actually exists right now: a fresh launch clears the stale flag
// from quitting with the float open, while a mode-switch reload
// (three-pane toggle reloads this window; the float survives it)
// keeps the flag and the never-both-visible invariant intact. The
// closed-event listener is the crash-path backstop that returns the
// timer to the main windows if the float dies without writing state.
{
  const timerHost = getElectronHost();
  if (timerHost?.timerPopoutExists) {
    void timerHost.timerPopoutExists().then((exists) => reconcileTimerPopout(exists));
    timerHost.onTimerPopoutClosed?.(() => setTimerPoppedOut(false));
  } else {
    reconcileTimerPopout(false);
  }
}

const zoomOutBtn = document.getElementById('zoom-out-btn') as HTMLButtonElement;
const zoomInBtn = document.getElementById('zoom-in-btn') as HTMLButtonElement;
const zoomResetBtn = document.getElementById('zoom-reset-btn') as HTMLButtonElement;
const zoomPct = document.getElementById('zoom-pct')!;

// Module-level state. Declared before the settings subscriber registers
// so that `applyReadMode` can read `view` without a temporal-dead-zone
// ReferenceError on initial call.
let view: EditorView | null = null;
let currentDoc: PMNode = makeNewDocBody();

/** Multi-doc workspace gate. When true, the multi-pane shell has
 *  taken over the main shell — it manages its own EditorViews and
 *  pushes the focused pane's view into the module-level `view`
 *  variable below via `setActiveView`. The single-doc open / mount
 *  paths delegate to the shell instead. */
let multiDocActive = false;
/** When the multi-pane shell is active, this delegates file-open
 *  routing to its prompt-for-slot flow. */
let multiDocOnFileOpen: ((opened: OpenedFile) => Promise<void> | void) | null = null;
/** When the multi-pane shell is active, "Show in context" routes a
 *  flashcard's source into a slot of this window (rather than a separate
 *  window) and scrolls to the anchor. */
let multiDocShowInContext: ((req: ShowInContextRequest) => Promise<void> | void) | null = null;
/** When the multi-pane shell is active, this delegates the
 *  "New doc" ribbon button to the shell's slot-routing flow. */
let multiDocOnNewDoc: (() => Promise<void> | void) | null = null;
/** When the multi-pane shell is active, this delegates the
 *  read-mode ribbon button to the shell's per-pane toggle. */
let multiDocToggleReadMode: (() => void) | null = null;
let multiDocToggleAutosave: (() => void) | null = null;
/** Assigned by `wireColorPanel(...)` further below. Referenced by the
 *  `togglePaintbrushHighlight` / `togglePaintbrushShading` ribbon
 *  commands so users can arm the paintbrush via a keybinding. */
let colorPanel: import('./color-panel.js').ColorPanelHandle | null = null;
/** Created lazily on the first Ctrl-F / Ctrl-H press. Reads the
 *  active view via the `getView` getter so the bar follows the
 *  currently-focused pane in multi-doc mode. */
let findReplaceBar: FindReplaceBar | null = null;
/** Resolver for "which nav panel should find-hit decorations land
 *  on?". Default: the single-doc global nav. Multi-pane shell
 *  swaps this for a focused-pane resolver via
 *  `setActiveNavPanelResolver`. */
let activeNavPanelResolver: () => NavigationPanel | null = () => navPanel;
// Receive-pill inserts fold their new headings to the active pane's depth.
setReceivedInsertNavHook(() => activeNavPanelResolver()?.applyMaxLevelToNewHeadings());
export function setActiveNavPanelResolver(
  resolver: () => NavigationPanel | null,
): void {
  activeNavPanelResolver = resolver;
}
function ensureFindReplaceBar(): FindReplaceBar {
  if (!findReplaceBar) {
    findReplaceBar = new FindReplaceBar(
      () => view,
      () => activeNavPanelResolver(),
    );
  }
  return findReplaceBar;
}
let repairParagraphBar: RepairParagraphBar | null = null;
function ensureRepairParagraphBar(): RepairParagraphBar {
  if (!repairParagraphBar) {
    repairParagraphBar = new RepairParagraphBar(() => view);
  }
  return repairParagraphBar;
}
/** Speech-doc command hooks. Installed by the multi-pane shell; in
 *  single-doc mode these stay null and the ribbon commands fall
 *  back to the single-doc implementations (multi-window speech
 *  routing via the resolver). */
let multiDocNewSpeechDocument: (() => void) | null = null;
let multiDocMarkActiveAsSpeech: (() => void) | null = null;
let multiDocSendToSpeechAtCursor: (() => void) | null = null;
let multiDocSendToSpeechAtEnd: (() => void) | null = null;
let multiDocSendToDropzone: (() => void) | null = null;
let multiDocSendToStarred: (() => void) | null = null;
let multiDocSendToRecipient: (() => void) | null = null;
/** Filename plumbing for Save-As. In single-doc mode the module's
 *  `currentDocFilename` is the source of truth; in multi-doc each
 *  pane owns its own filename, so the shell installs these hooks
 *  to let Save-As read the focused pane's name and propagate the
 *  user's rename back into the chip. */
let multiDocGetFocusedFilename: (() => string | null) | null = null;
let multiDocSetFocusedFilename: ((name: string) => void) | null = null;
/** All-slots filename accessor. Used by `updateWindowTitle` so the
 *  OS window title in multi-pane mode shows EVERY open slot's
 *  filename rather than just the focused one — the chip in the
 *  pane chrome already identifies the focused doc, so the title
 *  is most useful as a summary of the whole workspace. Returns
 *  filenames in slot order; empty slots map to null. */
let multiDocGetAllFilenames: (() => (string | null)[]) | null = null;
/** Resolve one doc uid → its filename (across all panes + stacks). Used by
 *  collab to name a session after its OWNER doc, not the whole-window title. */
let multiDocGetFilenameForUid: ((uid: string) => string | null) | null = null;
let multiDocGetDocIdForUid: ((uid: string) => string | null) | null = null;
// Collab join/resume in the workspace (slot-picker session docs).
let multiDocCreateSessionDoc: (() => Promise<string | null>) | null = null;
let multiDocSetFilenameForUid: ((uid: string, name: string) => void) | null = null;
/** App-quit path: the shell prompts to save every unsaved pane, returning false
 *  if the user cancels (abort the quit). null in single-doc mode. */
let multiDocPromptSaveAllForQuit: (() => Promise<boolean>) | null = null;

/** Full focused-file plumbing for the Save / Save-As flow — reads
 *  the filename plus the on-disk handle and on-disk format. */
let multiDocGetFocusedFile:
  | (() => {
      filename: string;
      handle: unknown | null;
      format: 'cmir' | 'docx' | null;
      docId: string | null;
      uid: string;
    } | null)
  | null = null;
let multiDocSetFocusedFile:
  | ((file: { filename: string; handle: unknown | null; format: 'cmir' | 'docx' | null }) => void)
  | null = null;
/** Set the focused DocRecord's Learn docId (minted/forked lazily). */
let multiDocSetFocusedDocId: ((docId: string) => void) | null = null;
/** Find the live view of any pane in this window (focused or not) whose
 *  DocRecord carries `docId`, else null. Backs the inbound-jump host and
 *  the plugin API's local-first jump, so a doc open in an unfocused pane
 *  jumps without the main-process broadcast hop. */
let multiDocFindViewForDocId: ((docId: string) => EditorView | null) | null = null;
/** Crash-recovery hook: clear the focused pane's journal after a
 *  successful save in multi-doc mode. The shell knows the
 *  DocRecord's uid; the editor only knows it has a focused doc. */
let multiDocCaptureFocusedCleanToken: (() => (() => boolean) | null) | null = null;
/** Mode-switch hook: journal every open DocRecord across every
 *  slot's stack so the auto-recover-on-reload flow can rebuild
 *  the workspace in the new layout. Returns each doc's uid +
 *  pre-switch dirty state for the mode-switch marker. */
let multiDocJournalAll: (() => Promise<ModeSwitchDoc[]>) | null = null;
/** Web three-pane → one-per-window: close every non-focused doc (save-prompting
 *  dirty ones), keeping only the focused doc for the single-doc window. Returns
 *  false if the user cancelled a save prompt (the switch aborts). */
let multiDocReduceToFocused: (() => Promise<boolean>) | null = null;
/** Three-pane nav toggle: the global Show/Hide Navigation Pane control routes
 *  here so it acts on ALL per-slot outlines together (toggle = restore-all when
 *  any is hidden, else hide-all), and the pull-tab restores them all. */
let multiDocToggleAllNav: (() => void) | null = null;
let multiDocShowAllNav: (() => void) | null = null;
/** Web same-file guard: the file handles this window currently has open, so a
 *  peer window's cross-window duplicate-open query can compare against them
 *  (single-doc reports its one handle; multi-pane reports every pane's). */
let multiDocGetOpenHandles: (() => unknown[]) | null = null;
/** File handles open in THIS window right now, for the web same-file guard's
 *  query responder. */
function getThisWindowOpenHandles(): unknown[] {
  if (multiDocActive && multiDocGetOpenHandles) return multiDocGetOpenHandles();
  return currentDocHandle != null ? [currentDocHandle] : [];
}
/** Crash-recovery hook: load a recovered journal entry into the
 *  multi-pane workspace. The shell picks a slot (first empty, or
 *  prompts the user) and pushes a DocRecord built from the
 *  recovered doc + threads + handle + format. */
let multiDocOnRecoveredDoc:
  | ((entry: {
      uid: string;
      filename: string;
      handle: unknown;
      format: 'cmir' | 'docx' | null;
      docId: string | null;
      doc: import('prosemirror-model').Node;
      threads: Thread[];
      dirty: boolean;
    }) => Promise<void>)
  | null = null;

/** Multi-pane shell hooks. Called by `multi-pane-shell.ts` at boot
 *  to install the overrides that redirect the single-doc open /
 *  mountView paths into per-pane routing. */
export function enableMultiDocMode(opts: {
  onFileOpen: (opened: OpenedFile) => Promise<void> | void;
  showInContext?: (req: ShowInContextRequest) => Promise<void> | void;
  onNewDoc?: () => Promise<void> | void;
  toggleReadMode?: () => void;
  toggleReaderView?: () => void;
  toggleAutosave?: () => void;
  /** Zoom the focused pane's body by a percentage delta (per-pane zoom). */
  zoomFocusedBy?: (deltaPct: number) => void;
  /** Reset the focused pane's body zoom to 100%. */
  zoomFocusedReset?: () => void;
  newSpeechDocument?: () => void;
  markActiveAsSpeech?: () => void;
  sendToSpeechAtCursor?: () => void;
  sendToSpeechAtEnd?: () => void;
  sendToDropzone?: () => void;
  sendToStarred?: () => void;
  sendToRecipient?: () => void;
  getFocusedFilename?: () => string | null;
  setFocusedFilename?: (name: string) => void;
  getFocusedFile?: () => {
    filename: string;
    handle: unknown | null;
    format: 'cmir' | 'docx' | null;
    docId: string | null;
    uid: string;
  } | null;
  setFocusedFile?: (file: { filename: string; handle: unknown | null; format: 'cmir' | 'docx' | null }) => void;
  setFocusedDocId?: (docId: string) => void;
  /** Live view of any pane holding `docId` (focused or background), or null. */
  findViewForDocId?: (docId: string) => EditorView | null;
  getAllFilenames?: () => (string | null)[];
  /** Filename of the open doc with `uid` (across all panes + stacks), or null.
   *  Lets collab publish/label a session with its OWNER doc's name rather than
   *  the whole-window title. */
  getFilenameForUid?: (uid: string) => string | null;
  getDocIdForUid?: (uid: string) => string | null;
  /** Collab join/resume in the workspace: create a fresh unsaved doc in a
   *  user-picked slot to hold the session. Returns its uid, or null when the
   *  user cancels the slot picker. */
  createSessionDoc?: () => Promise<string | null>;
  /** Rename the open doc with `uid` wherever it lives — session title adoption
   *  targets the owner doc, which may no longer be the focused one. */
  setFilenameForUid?: (uid: string, name: string) => void;
  /** App-quit path: prompt to save every unsaved doc across all panes (without
   *  closing them). Returns false if the user cancels — the quit aborts. */
  promptSaveAllForQuit?: () => Promise<boolean>;
  /** Called from single-doc save flows RIGHT BEFORE serializing so a
   *  successful save can mark the focused DocRecord clean + drop its
   *  journal — but only if no edits landed while the write was in
   *  flight (see save-clean-token.ts). Returns null when no pane is
   *  focused. */
  captureFocusedCleanToken?: () => (() => boolean) | null;
  onRecoveredDoc?: (entry: {
    uid: string;
    filename: string;
    handle: unknown;
    format: 'cmir' | 'docx' | null;
    docId: string | null;
    doc: import('prosemirror-model').Node;
    threads: Thread[];
    dirty: boolean;
  }) => Promise<void>;
  journalAll?: () => Promise<ModeSwitchDoc[]>;
  reduceToFocusedForModeSwitch?: () => Promise<boolean>;
  getOpenHandles?: () => unknown[];
  toggleAllNav?: () => void;
  showAllNav?: () => void;
}): void {
  multiDocActive = true;
  multiDocOnFileOpen = opts.onFileOpen;
  multiDocShowInContext = opts.showInContext ?? null;
  multiDocOnNewDoc = opts.onNewDoc ?? null;
  multiDocToggleReadMode = opts.toggleReadMode ?? null;
  multiDocToggleReaderView = opts.toggleReaderView ?? null;
  multiDocToggleAutosave = opts.toggleAutosave ?? null;
  multiDocZoomBy = opts.zoomFocusedBy ?? null;
  multiDocZoomResetHook = opts.zoomFocusedReset ?? null;
  multiDocNewSpeechDocument = opts.newSpeechDocument ?? null;
  multiDocMarkActiveAsSpeech = opts.markActiveAsSpeech ?? null;
  multiDocSendToSpeechAtCursor = opts.sendToSpeechAtCursor ?? null;
  multiDocSendToSpeechAtEnd = opts.sendToSpeechAtEnd ?? null;
  multiDocSendToDropzone = opts.sendToDropzone ?? null;
  multiDocSendToStarred = opts.sendToStarred ?? null;
  multiDocSendToRecipient = opts.sendToRecipient ?? null;
  multiDocGetFocusedFilename = opts.getFocusedFilename ?? null;
  multiDocSetFocusedFilename = opts.setFocusedFilename ?? null;
  multiDocGetFocusedFile = opts.getFocusedFile ?? null;
  multiDocSetFocusedFile = opts.setFocusedFile ?? null;
  multiDocSetFocusedDocId = opts.setFocusedDocId ?? null;
  multiDocFindViewForDocId = opts.findViewForDocId ?? null;
  multiDocGetAllFilenames = opts.getAllFilenames ?? null;
  multiDocGetFilenameForUid = opts.getFilenameForUid ?? null;
  multiDocGetDocIdForUid = opts.getDocIdForUid ?? null;
  multiDocCreateSessionDoc = opts.createSessionDoc ?? null;
  multiDocSetFilenameForUid = opts.setFilenameForUid ?? null;
  multiDocPromptSaveAllForQuit = opts.promptSaveAllForQuit ?? null;
  multiDocCaptureFocusedCleanToken = opts.captureFocusedCleanToken ?? null;
  multiDocOnRecoveredDoc = opts.onRecoveredDoc ?? null;
  multiDocJournalAll = opts.journalAll ?? null;
  multiDocReduceToFocused = opts.reduceToFocusedForModeSwitch ?? null;
  multiDocGetOpenHandles = opts.getOpenHandles ?? null;
  multiDocToggleAllNav = opts.toggleAllNav ?? null;
  multiDocShowAllNav = opts.showAllNav ?? null;
  // Hide the single-doc editor surface. The multi-pane shell
  // mounts its own DOM into #app alongside it. The comments
  // column is NOT hidden — the shell adopts it as a sibling of
  // the multi-row (a narrow fourth slot that shrinks the three
  // doc panes equally) and its visibility follows the same
  // `commentsVisible` setting as in single-pane.
  editorEl.hidden = true;
  // Hide the global single-pane nav panel; the multi-pane shell
  // renders its own per-section nav.
  navEl.hidden = true;
  document.body.classList.add('pmd-multi-doc');
  // The shared exportBtn is enabled by the multi-pane shell once
  // any pane has a view focused — for safety, enable it here too.
  exportBtn.disabled = false;
}

/** All mark names any formatting-panel button cares about — the fused
 *  selection walk answers presence for the whole set in one pass. */
const FUSED_MARK_NAMES = ['cite_mark', 'underline_mark', 'emphasis_mark'] as const;

/** One-frame coalescing for the selection-mirroring chrome (font-size chip,
 *  cursor-color readout, formatting-panel pressed states, numbering buttons)
 *  — perf audit A-01, 2026-07-11. These used to run inline on EVERY
 *  transaction, each doing its own O(selection) walk: drag-selecting
 *  dispatches a selection transaction per pointermove (~60-125/s), so
 *  growing a selection across a master file saturated the main thread
 *  recomputing four readouts. The flush reads view.state at frame time, so
 *  a burst of transactions inside one frame costs ONE fused walk; readouts
 *  land at most a frame (~16 ms) late, imperceptible for passive
 *  indicators. Settings/mount/benchmark refresh paths still call the
 *  refreshers directly (synchronously) — the gate at the dispatch site is
 *  complete because these readouts depend only on doc, selection,
 *  storedMarks, and settings. */
let selectionChromePending = false;
function scheduleSelectionChromeRefresh(): void {
  if (selectionChromePending) return;
  selectionChromePending = true;
  requestAnimationFrame(() => {
    selectionChromePending = false;
    flushSelectionChrome();
  });
}
function flushSelectionChrome(): void {
  // ONE walk answers font uniformity, mark presence, and numbering units
  // for a range selection; every empty-selection path is O(1) and computed
  // inside the consumers as before.
  const chrome =
    view && !view.state.selection.empty
      ? computeSelectionChrome(view.state, FUSED_MARK_NAMES, ptForRun)
      : null;
  refreshFontSizeDisplay(chrome);
  refreshCursorColorDisplay();
  refreshFormattingPanelButtonStates(chrome);
  syncNumberingButtons(chrome);
}

/** Used by the multi-pane shell: route the shared ribbon /
 *  chrome through the currently-focused pane's view. */
export function setActiveView(v: EditorView | null): void {
  const focusChanged = v !== view;
  if (focusChanged) {
    // A real focus change — pane switch, stack switch, home screen — not
    // the per-transaction re-run (same view). An open find bar belongs to
    // the outgoing pane: close it now, while it can still clear that
    // pane's match decorations and nav hit markers. Left open, closing it
    // from the new pane clears the NEW pane's (empty) state and the old
    // pane's highlights are stuck until find is reopened there. No
    // refocus — focus is already moving.
    findReplaceBar?.close({ refocusEditor: false });
  }
  view = v;
  // Paint-mode visuals live on a specific editor element; the brush
  // itself follows focus (the mouseup handler resolves the view at
  // stroke time), so move the armed cursor/class to the pane it now
  // applies to. Must run AFTER `view` is reassigned — the color
  // panel's viewRef reads it. No-op when nothing is armed or painted.
  if (focusChanged) colorPanel?.syncPaintbrushView();
  if (v) {
    currentDoc = v.state.doc;
  }
  // The shared collab chip follows the focused doc's session — repaint it
  // now instead of waiting for that session's next status event.
  notifyCollabFocusChange();
  // Re-sync the chrome that depends on `view` (font-size chip,
  // word-count display, paragraph integrity indicator,
  // read-mode toggle pressed-state, speech-mark button, etc.).
  // The selection-mirroring quartet coalesces to one fused walk per frame
  // — the multi-pane dispatch re-runs setActiveView per focused-pane
  // transaction, which used to pay all four walks a second time (A-01).
  scheduleSelectionChromeRefresh();
  refreshWordCount();
  refreshReadModeBtn();
  refreshSpeechMarkBtn();
  refreshAutosaveBtn();
  // Status-bar zoom % reflects the focused pane's per-pane zoom in multi-doc.
  refreshZoomStatus();
  updateWindowTitle();
}

/** Read-only accessor for the active view — exposed so other
 *  modules (multi-pane shell) can register listeners that need it. */
export function getActiveView(): EditorView | null {
  return view;
}

/** Benchmark lifecycle (Settings → Benchmark). The mutating editing test runs
 *  on the live doc, but `dispatchTransaction` checks `isBenchmarkActive()` and
 *  skips the autosave / dirty / nav-rebuild side effects, so nothing touches
 *  disk and the nav doesn't churn. `endBenchmark` reverts the whole editor state
 *  (doc + selection + undo history) from the pre-run snapshot and refreshes the
 *  chrome that was suppressed. */
export function beginBenchmark(): EditorState | null {
  const v = getActiveView();
  if (!v) return null;
  setBenchmarkActive(true);
  return v.state;
}
export function endBenchmark(snapshot: EditorState | null): void {
  const v = getActiveView();
  if (v && snapshot) v.updateState(snapshot);
  setBenchmarkActive(false);
  if (v) {
    scheduleHeavyUpdate();
    refreshFontSizeDisplay();
    refreshCursorColorDisplay();
    refreshFormattingPanelButtonStates();
    syncNumberingButtons();
  }
}

// Live context for ribbon commands that read settings at keypress
// time — active highlight / shading color for F11 / Mod-F11; condense
// behavior flags for F3 / Alt-F3 / Mod-Alt-F3.
// Collaboration sessions: everything heavy (Loro wasm, transport) lives
// in the lazily-imported collab-ui module; these seams hand it the view
// and the two state-swap capabilities it needs. Dormant unless the
// collab gate is open (see collab/collab-gate.ts).
let collabUiModule: Promise<typeof import('./collab/collab-ui.js')> | null = null;
/** Display filename for a doc uid across single-doc + multi-pane. Collab names
 *  a session after its OWNER doc via this; document.title is unusable in
 *  multi-pane (every open doc joined by " · "). Null when the uid isn't open
 *  here (e.g. its pane lives in another window). */
function resolveDocFilename(uid: string): string | null {
  if (multiDocActive && multiDocGetFilenameForUid) return multiDocGetFilenameForUid(uid);
  return uid === currentDocUid ? currentDocFilename : null;
}

/** Persistent docId for a doc uid (null before first save) — stamped
 *  into session records so open-from-disk can match a file to its
 *  session (see checkSessionRejoinForOpenedDoc). */
function resolveDocPersistentId(uid: string): string | null {
  if (multiDocActive && multiDocGetDocIdForUid) return multiDocGetDocIdForUid(uid);
  return uid === currentDocUid ? currentDocId : null;
}

function loadCollabUi(): Promise<typeof import('./collab/collab-ui.js')> {
  return (collabUiModule ??= import('./collab/collab-ui.js').then((m) => {
    // Tell collab-ui which doc is focused so its shared chip / no-deps flows
    // (copy-code, invite) act on the session the user is looking at when a
    // window holds more than one.
    m.setCollabFocusResolver(() => activeDocIdentity().sessionUid);
    // Resolve a session's OWNER doc uid → its filename, so the title published
    // to joiners (and invite labels) is that doc's name — not the whole-window
    // title, which in multi-pane is every open doc joined by " · ".
    m.setCollabDocTitleResolver((uid) => resolveDocFilename(uid));
    m.setCollabDocIdResolver((uid) => resolveDocPersistentId(uid));
    return m;
  }));
}
// Receive-pill invites: hand the share code from a `room-invite` inbox
// row to the lazy collab module. Registered unconditionally (cheap
// setter); the pill itself gates the Join button on collabEnabled().
// Deps are picked PER CLICK: the multi-pane workspace joins into a
// user-picked slot; single-pane joins in place (or spawns a window).
// The returned promise reports success so the pill only consumes the
// invite (and its share code) when the join actually landed.
setCollabInviteJoiner((code) =>
  loadCollabUi().then((m) =>
    m.joinSessionWithCode(multiDocActive ? makeMultiPaneSessionDeps() : collabDeps, code),
  ),
);
setCollabInviter((target) => {
  void loadCollabUi().then((m) => m.inviteTargetFlow(collabDeps, target));
});
// The Send pill's Start-session button — identical to running the Start
// Collaboration Session command (same confirm, same share-code copy).
// collabDeps in BOTH modes: its getOwnerUid resolves the FOCUSED doc,
// which is what starting means in three-pane too. The multi-pane deps
// are join-shaped — their uid is null until newSessionDoc() fills it,
// which start never calls — so using them here bound the session to an
// empty uid with the window-joined title ("A.docx · B.docx") in the
// confirm, orphaned from every pane footer (field find, 2026-08-12).
setCollabSessionStarter(() => {
  void loadCollabUi().then((m) => m.startSessionFlow(collabDeps));
});
// The Receive pill's Join button — same flow (and same deps choice) as
// the Join Collaboration Session command: multi-pane joins into a
// user-picked slot; single-pane in place.
setCollabSessionJoinPrompt(() => {
  void loadCollabUi().then((m) =>
    m.joinSessionFlow(multiDocActive ? makeMultiPaneSessionDeps() : collabDeps),
  );
});
// Per-doc comment-id allocation: a comment gets a random (collision-safe) id
// only when the doc it's created in is itself co-edited. Comment creation always
// targets the active doc, so test THAT doc's session — a non-co-edited doc open
// beside a co-edited one still gets clean sequential ids. Cheap sync check.
setCommentIdSessionResolver(() => collabPluginSourceFor(activeDocIdentity().sessionUid) != null);
const collabDeps = {
  getView: () => view,
  // The uid of the doc a session is being started/joined for = the focused
  // doc's uid. Captured at install so the binding attaches only to that view.
  getOwnerUid: () => activeDocIdentity().sessionUid,
  // Resolve a doc uid to its live view (single-doc main view + every pane are
  // registered here). Lets a session bind to its OWNER's view, not the focused
  // one — so each doc's presence/comments render in its own pane.
  getViewForUid: (uid: string) => getSpeechDocResolver().viewForUid(uid),
  // The blessed same-view plugin swap (same pattern as the keybinding
  // settings subscriber): a session starting/ending changes the plugin
  // stack, and buildEditorPlugins consults the collab plugin source. Pass the
  // focused doc's uid so the collab plugins are (re)attached only when the
  // focused view is the session owner.
  refreshPlugins: () => {
    if (view) {
      view.updateState(
        view.state.reconfigure({ plugins: buildEditorPlugins(activeDocIdentity().sessionUid) }),
      );
    }
  },
  // Rebuild a SPECIFIC doc's plugin stack by uid — session-end paths target
  // the owner doc's view, which may not be the focused one (multi-pane).
  refreshPluginsForUid: (uid: string) => {
    const v = getSpeechDocResolver().viewForUid(uid);
    if (v) v.updateState(v.state.reconfigure({ plugins: buildEditorPlugins(uid) }));
  },
  // Name the (unsaved) session doc: window title, filename chip, and
  // the save-as default all follow currentDocFilename. No handle — the
  // first save still prompts for a location, pre-filled with this name.
  setDocTitle: (title: string) => {
    // Never clobber a doc the user has SAVED — their on-disk name wins
    // over a host's mid-session rename arriving through the meta map.
    if (currentDocHandle) return;
    currentDocFilename = title;
    updateWindowTitle();
  },
  // Joining a session opens a new unsaved doc IN THIS WINDOW — never
  // via ribbonContext.newDocument(), which SPAWNS a window on desktop
  // and would strand the session binding in a window that never gets
  // it (field bug: joiner saw an unrelated new window plus an inert
  // "synced" chip here). The Loro binding replaces the empty content
  // from the session's CRDT state after the swap.
  newSessionDoc: () => replaceWithSessionDoc(),
  // Accepting an invite shouldn't overwrite the doc you're working in: on
  // desktop multi-window, if this window holds a real doc (not the disposable
  // starter), open the session in a NEW window instead. Returns true when it
  // spawned — the caller aborts the in-window join, and the spawned window
  // re-enters the join with a starter open, so it joins in place. Web /
  // single-window (or the starter already open) → false → join here.
  spawnJoinWindow: (shareCode: string): boolean => {
    const host = getHost();
    // Three-pane is ONE window: sessions join into slots (the multi-pane deps
    // below), never a spawned OS window. This gate is defense-in-depth for any
    // caller that reaches the single-pane deps while the workspace is active —
    // isPristineStarter is single-pane module state and stale garbage here
    // (field bug: spawn-to-join dead-ended in "This file is empty…").
    if (multiDocActive) return false;
    if (!host.canSpawnWindow || isPristineStarter) return false;
    void host
      .spawnWindow({
        filename: '',
        bytes: new Uint8Array(),
        handle: null,
        format: null,
        uid: null,
        joinShareCode: shareCode,
      })
      .catch((err) => {
        console.error('Spawn-to-join failed:', err);
        showToast('Could not open a new window for the session.');
      });
    return true;
  },
};

/** Deps for joining/resuming a session in the multi-pane workspace. The
 *  session doc is created in a slot the user picks, and every hook resolves
 *  through THAT doc's uid — never the focused pane, which can change mid-flow
 *  (same per-uid pattern as the mode-switch auto-resume deps). Single-use:
 *  build one per join/resume flow — the created doc's uid lives in the
 *  closure. Field bugs this replaces: the single-pane deps either aborted
 *  ("Join cancelled" after streaming the whole doc — replaceWithSessionDoc
 *  bails under multiDocActive) or spawned a second window that dead-ended in
 *  the empty-file open error (2026-07-10). */
/** `existingUid` pins the deps to an ALREADY-open doc — the
 *  open-from-disk rejoin gate resumes in place (existingDoc mode), so
 *  newSessionDoc never runs and the slot picker never appears; without
 *  the pin, getOwnerUid() would stay null and the session would bind
 *  to nothing. Ordinary flows omit it: uid is set when the slot picker
 *  creates the session doc. */
function makeMultiPaneSessionDeps(existingUid?: string) {
  let uid: string | null = existingUid ?? null;
  const viewFor = (u: string | null): EditorView | null =>
    u ? getSpeechDocResolver().viewForUid(u) : null;
  return {
    // Before the session doc exists this is only consulted by guards; the
    // focused pane's view is fine (and null is allowed — the flows create
    // their doc via newSessionDoc).
    getView: () => viewFor(uid) ?? getActiveView(),
    getOwnerUid: () => uid,
    getViewForUid: (u: string) => getSpeechDocResolver().viewForUid(u),
    refreshPlugins: () => {
      const v = viewFor(uid);
      if (v) v.updateState(v.state.reconfigure({ plugins: buildEditorPlugins(uid) }));
    },
    refreshPluginsForUid: (u: string) => {
      const v = getSpeechDocResolver().viewForUid(u);
      if (v) v.updateState(v.state.reconfigure({ plugins: buildEditorPlugins(u) }));
    },
    // Adopt the host-published title on the session doc's own record (by
    // uid — focus may have moved during the join round-trip).
    setDocTitle: (title: string) => {
      if (uid) multiDocSetFilenameForUid?.(uid, title);
    },
    // Fresh unsaved doc in a user-picked slot; the Loro binding replaces its
    // blank content with the session's CRDT state after refreshPlugins.
    newSessionDoc: async (): Promise<boolean> => {
      const created = (await multiDocCreateSessionDoc?.()) ?? null;
      if (!created) return false;
      uid = created;
      return true;
    },
    // Deliberately no spawnJoinWindow: the workspace is ONE window — sessions
    // join into slots, never new OS windows.
  };
}

const ribbonContext: RibbonContext = {
  highlightColor: () => settings.get('lastHighlightColor'),
  shadingColor: () => settings.get('lastShadingColor'),
  paragraphIntegrity: () => settings.get('paragraphIntegrity'),
  usePilcrows: () => settings.get('usePilcrows'),
  extractUndertagInQuotes: () => settings.get('extractUndertagInQuotes'),
  headingMode: () => settings.get('headingMode'),
  condenseOnPaste: () => settings.get('condenseOnPaste'),
  collabStartSession: () => {
    void loadCollabUi().then((m) => m.startSessionFlow(collabDeps));
  },
  collabJoinSession: () => {
    // Multi-pane joins into a user-picked slot; single-pane in place.
    void loadCollabUi().then((m) =>
      m.joinSessionFlow(multiDocActive ? makeMultiPaneSessionDeps() : collabDeps),
    );
  },
  collabCopyShareCode: () => {
    void loadCollabUi().then((m) => m.copyShareCodeFlow());
  },
  collabCopyInviteLink: () => {
    void loadCollabUi().then((m) => m.copyInviteLinkFlow());
  },
  collabInviteStarred: () => {
    void loadCollabUi().then((m) => m.inviteStarredFlow());
  },
  openDevConsole: () => {
    void getElectronHost()?.toggleDevTools();
  },
  collabEndSession: () => {
    void loadCollabUi().then((m) => m.endSessionFlow(collabDeps));
  },
  clearFormattingOnNamedStyleToggleOff: () =>
    settings.get('clearFormattingOnNamedStyleToggleOff'),
  effectivePtForNode: (node, parent) => effectivePtForNode(node, parent),
  normalPt: () => settings.get('displaySizes').normal,
  shrinkRestoresOmissionsToNormal: () =>
    settings.get('shrinkRestoresOmissionsToNormal'),
  shrinkProtectionPatterns: () =>
    compileShrinkProtections(
      settings.get('shrinkCustomProtections'),
      // When the user has picked Custom, feed the literal pause /
      // resume marker strings into the protection list so the
      // markers we emit are also auto-protected from shrink. The
      // six built-in delimiter shapes are already covered by the
      // static base.
      settings.get('condenseWarningDelimiter') === 'custom'
        ? settings.get('condenseWarningCustomPauseMarker')
        : '',
      settings.get('condenseWarningDelimiter') === 'custom'
        ? settings.get('condenseWarningCustomResumeMarker')
        : '',
    ),
  condenseWarningMarkers: () => {
    const d = settings.get('condenseWarningDelimiter');
    if (d === 'custom') {
      return {
        pause: settings.get('condenseWarningCustomPauseMarker'),
        resume: settings.get('condenseWarningCustomResumeMarker'),
      };
    }
    const close = condenseWarningCloseFor(d);
    return {
      pause: `${d}PARAGRAPH INTEGRITY PAUSES${close}`,
      resume: `${d}PARAGRAPH INTEGRITY RESUMES${close}`,
    };
  },
  runCreateReference: () => {
    if (!view) return;
    void createReference(view.state, effectivePtForNode, {
      includeHeading: settings.get('createReferenceIncludeHeading'),
      delimiter: settings.get('createReferenceDelimiter'),
      includeCite: settings.get('createReferenceIncludeCite'),
      customHeading: settings.get('createReferenceCustomHeading'),
      headingBold: settings.get('createReferenceHeadingBold'),
      headingItalic: settings.get('createReferenceHeadingItalic'),
      headingEmphasized: settings.get('createReferenceHeadingEmphasized'),
      headingUnderlined: settings.get('createReferenceHeadingUnderlined'),
      shrink: settings.get('createReferenceShrinks'),
      shrinkPt: settings.get('createReferenceShrinkPt'),
      highlightMode: settings.get('createReferenceHighlightMode'),
      useGray50: settings.get('forReferenceUseGray50'),
    }).then((result) => {
      // Every outcome gets surfaced — the silent-failure version of
      // this taught a user that the button "needs five clicks".
      if (result === 'copied') showToast('Copied!');
      else if (result === 'invalid-selection')
        showToast('Create Reference: select body text inside a single card first.');
      else showToast(CLIPBOARD_BUSY_MESSAGE);
    });
  },
  openWordCountDialog: () => {
    if (view) openWordCount(view);
  },
  toggleReaderView: () => toggleReaderViewCommand(),
  openContainingFolder: () => {
    const host = getElectronHost();
    if (!host) {
      showToast('Open Containing Folder requires the desktop edition.');
      return;
    }
    // Focus-aware in both modes: activeFile() reads the focused pane's
    // record in multi-doc, the module-level values in single-doc. The
    // handle IS the absolute path on desktop.
    const { handle } = activeFile();
    if (typeof handle === 'string' && handle.length > 0) {
      void host.showItemInFolder(handle);
    } else {
      showToast('This document hasn\u2019t been saved to a file yet.');
    }
  },
  toggleReadMode: () => {
    if (multiDocActive && multiDocToggleReadMode) {
      // Per-pane in multi-doc mode: flip the focused pane's
      // state and apply it locally without touching the global
      // setting (so the other panes keep theirs).
      multiDocToggleReadMode();
    } else {
      settings.set('readMode', !settings.get('readMode'));
    }
    if (settings.get('jumpToDocTopOnReadModeToggle') && view) {
      const tr = view.state.tr.setSelection(Selection.atStart(view.state.doc));
      view.dispatch(tr.scrollIntoView());
    }
  },
  openShortcutsReference: () => openReference(),
  toggleCommentsVisible: () => {
    if (!commentsColumn || !commentsColumnEl) return;
    const next = commentsColumnEl.hidden;
    commentsColumn.setVisible(next);
    commentsToggleBtn?.setAttribute('aria-pressed', next ? 'true' : 'false');
    commentsColumn.render();
  },
  addCommentToSelection: () => {
    if (!view || !commentsColumn) return;
    const newId = addCommentToSelection(view);
    if (!newId) return;
    if (commentsColumnEl?.hidden) {
      commentsColumn.setVisible(true);
      commentsToggleBtn?.setAttribute('aria-pressed', 'true');
    }
    commentsColumn.render();
    commentsColumn.focusReplyForThread(newId);
  },
  aiAskAboutSelection: () => {
    if (!view || !commentsColumn) return;
    if (!settings.get('aiFeaturesEnabled')) {
      showToast(AI_DISABLED_MESSAGE);
      return;
    }
    const sel = view.state.selection;
    if (sel.empty) {
      showToast('Select text or an image to ask about.');
      return;
    }
    // Vision cost is bounded: only the first few images in the selection
    // are sent. Tell the user when some are left out.
    const imgCount = countSelectionImages(view.state, sel.from, sel.to);
    if (imgCount > 5) showToast(`The AI will see the first 5 of ${imgCount} images.`);
    // AI threads live in the local annotation layer (per-user, never
    // serialized into the shared doc) — anchored by descriptor + a
    // purple highlight decoration, exactly like flashcards. No
    // comment_range mark, so the question never leaks into .docx/.cmir.
    const descriptor = buildDescriptor(view.state.doc, sel.from, sel.to);
    const docId = ensureActiveDocId();
    const threadId = crypto.randomUUID();
    // Place the purple highlight directly from the known selection before
    // the store add — the reconcile then skips the doc-walk re-anchor.
    commentsColumn.placeLocalAnnotation(threadId, sel.from, sel.to, 'ai');
    learnStore.addAiThread({
      threadId,
      docId,
      comments: [],
      anchor: descriptor,
      createdAt: new Date().toISOString(),
    });
    // Register the doc (even unsaved) so it's known to the store, and
    // stamp the id into the file now so the note re-associates on reload.
    const f = activeFile();
    learnStore.registerDoc({
      docId,
      path: typeof f.handle === 'string' ? f.handle : null,
      name: f.filename ?? 'Untitled',
      format: f.format,
    });
    void stampActiveFileDocId(docId);
    if (commentsColumnEl?.hidden) {
      commentsColumn.setVisible(true);
      commentsToggleBtn?.setAttribute('aria-pressed', 'true');
    }
    commentsColumn.activateAiThread(threadId);
  },
  addNoteToSelection: () => {
    if (!view || !commentsColumn) return;
    const sel = view.state.selection;
    if (sel.empty) {
      showToast('Select text or an image to add a note.');
      return;
    }
    // Notes live in the local annotation layer (per-user, never
    // serialized into the doc unless exported) — anchored by descriptor +
    // a green highlight decoration, exactly like AI threads. Private by
    // construction: no comment_range mark in the doc.
    const descriptor = buildDescriptor(view.state.doc, sel.from, sel.to);
    const docId = ensureActiveDocId();
    const noteId = crypto.randomUUID();
    // Set the green highlight directly from the known selection BEFORE the
    // store add, so the reconcile it triggers finds the range already
    // present and never walks the doc to re-anchor it.
    commentsColumn.placeLocalAnnotation(noteId, sel.from, sel.to, 'note');
    learnStore.addNote({
      noteId,
      docId,
      comments: [],
      anchor: descriptor,
      createdAt: new Date().toISOString(),
    });
    // Register the doc (even unsaved) + stamp its id so the note
    // re-associates on reload — same as the AI-thread / flashcard flows.
    const f = activeFile();
    learnStore.registerDoc({
      docId,
      path: typeof f.handle === 'string' ? f.handle : null,
      name: f.filename ?? 'Untitled',
      format: f.format,
    });
    void stampActiveFileDocId(docId);
    if (commentsColumnEl?.hidden) {
      commentsColumn.setVisible(true);
      commentsToggleBtn?.setAttribute('aria-pressed', 'true');
    }
    commentsColumn.activateNote(noteId);
  },
  aiCreateCite: () => {
    if (!view) return;
    runAiCreateCite(view);
  },
  reformatAllCites: () => {
    if (!view) return;
    void runReformatAllCites(view);
  },
  translate: () => {
    if (!view) return;
    runTranslate(view);
  },
  repairText: () => {
    if (!view) return;
    runRepairText(view);
  },
  repairFormatting: () => {
    if (!view) return;
    runRepairFormatting(view);
  },
  sendToFlowColumn: () => {
    if (view) void runSendToFlow(view, { mode: 'column', headingsOnly: false });
  },
  sendToFlowCell: () => {
    if (view) void runSendToFlow(view, { mode: 'cell', headingsOnly: false });
  },
  sendHeadingsToFlowColumn: () => {
    if (view) void runSendToFlow(view, { mode: 'column', headingsOnly: true });
  },
  sendHeadingsToFlowCell: () => {
    if (view) void runSendToFlow(view, { mode: 'cell', headingsOnly: true });
  },
  pullFromFlow: () => {
    if (view) void runPullFromFlow(view);
  },
  createFlow: () => {
    void runCreateFlow();
  },
  startFlowHost: () => {
    void runStartFlowHost();
  },
  toggleVoice: () => {
    void getVoiceController().toggle();
  },
  openCardCutter: () => {
    if (view) void openCutLaunchSheet(view);
  },
  addCutterContext: () => {
    if (!view || !commentsColumn) return;
    const sel = view.state.selection;
    if (sel.empty) {
      showToast('Select the text the cutter should use as context.');
      return;
    }
    // Same local-annotation plumbing as a private note (anchored by
    // descriptor, green decoration, never serialized into the doc) —
    // just carrying the cutter-section kind so the port ships the
    // anchored text as context with every cut in this file.
    const descriptor = buildDescriptor(view.state.doc, sel.from, sel.to);
    const docId = ensureActiveDocId();
    const noteId = crypto.randomUUID();
    commentsColumn.placeLocalAnnotation(noteId, sel.from, sel.to, 'note');
    learnStore.addNote({
      noteId,
      docId,
      comments: [],
      anchor: descriptor,
      createdAt: new Date().toISOString(),
      kind: 'cutter-section',
    });
    const f = activeFile();
    learnStore.registerDoc({
      docId,
      path: typeof f.handle === 'string' ? f.handle : null,
      name: f.filename ?? 'Untitled',
      format: f.format,
    });
    void stampActiveFileDocId(docId);
    if (commentsColumnEl?.hidden) {
      commentsColumn.setVisible(true);
      commentsToggleBtn?.setAttribute('aria-pressed', 'true');
    }
    commentsColumn.activateNote(noteId);
  },
  openCutterGuidance: () => {
    if (!view || !commentsColumn) return;
    const docId = ensureActiveDocId();
    let note = learnStore.cutterGuidanceNote(docId);
    if (!note) {
      // The ONE anchorless guidance note per file: root = the user's
      // "how this file works", replies = the cutter's accumulated
      // card-neutral refinements. Anchorless by design — it's about
      // the whole file, not a stretch of text.
      const noteId = crypto.randomUUID();
      learnStore.addNote({
        noteId,
        docId,
        comments: [],
        anchor: null,
        createdAt: new Date().toISOString(),
        kind: 'cutter-guidance',
      });
      const f = activeFile();
      learnStore.registerDoc({
        docId,
        path: typeof f.handle === 'string' ? f.handle : null,
        name: f.filename ?? 'Untitled',
        format: f.format,
      });
      void stampActiveFileDocId(docId);
      note = learnStore.getNote(noteId)!;
    }
    if (commentsColumnEl?.hidden) {
      commentsColumn.setVisible(true);
      commentsToggleBtn?.setAttribute('aria-pressed', 'true');
    }
    commentsColumn.activateNote(note.noteId);
  },
  cardCutterActive: () => cardCutterActive(),
  createFlashcard: () => {
    if (!view) return;
    const sel = view.state.selection;
    if (sel.empty) {
      showToast('Select text to anchor a flashcard.');
      return;
    }
    const descriptor = buildDescriptor(view.state.doc, sel.from, sel.to);
    void (async () => {
      const def = await openCardEditor({ selectedText: descriptor.quote });
      if (!def) return;
      const docId = ensureActiveDocId();
      const cardId = crypto.randomUUID();
      const today = localToday();
      learnStore.upsertCard({ id: cardId, type: def.type, front: def.front, back: def.back }, today);
      learnStore.setAnchor(cardId, docId, descriptor);
      // Register the doc (even unsaved/Untitled) so the card's file shows
      // up immediately in the Home breakdown + manage GUI.
      const f = activeFile();
      learnStore.registerDoc({
        docId,
        path: typeof f.handle === 'string' ? f.handle : null,
        name: f.filename ?? 'Untitled',
        format: f.format,
      });
      // Persist the doc id into the file now so the card re-associates on
      // reload without waiting for a manual save (no-op if the file
      // already has an id, or has no on-disk handle yet).
      void stampActiveFileDocId(docId);
      showToast('Flashcard created.');
    })();
  },
  manageFlashcards: () => {
    openLearnManage();
  },
  newDocument: () => {
    void onNewDocClicked();
  },
  openFile: () => {
    void runOpenFlow();
  },
  save: () => {
    void runSaveFlow();
  },
  saveAs: () => {
    void runSaveAsFlow();
  },
  saveSendDoc: () => {
    void runSaveSendDocFlow();
  },
  saveMarkedCards: () => {
    void runSaveMarkedCardsFlow();
  },
  toggleAutosave: () => {
    if (multiDocActive && multiDocToggleAutosave) {
      multiDocToggleAutosave();
      return;
    }
    const next = !settings.get('autosaveEnabled');
    settings.set('autosaveEnabled', next);
    // Remember the choice per-file so it survives close + reopen.
    setAutosaveForPath(activeFile().handle, next);
    // Turning autosave ON: secure write permission now, while this click's
    // activation is fresh — autosave fires on a timer with no gesture to prompt
    // from, so it relies on the grant being in place already.
    if (next) void getHost().ensureWritable(activeFile().handle);
  },
  newSpeechDocument: () => {
    if (multiDocNewSpeechDocument) {
      multiDocNewSpeechDocument();
      return;
    }
    void runNewSpeechDocumentSingleDoc();
  },
  markActiveAsSpeech: () => {
    if (multiDocMarkActiveAsSpeech) {
      multiDocMarkActiveAsSpeech();
      return;
    }
    toggleMarkSingleDocAsSpeech();
  },
  sendToSpeechAtCursor: () => {
    if (multiDocSendToSpeechAtCursor) {
      multiDocSendToSpeechAtCursor();
      return;
    }
    if (view) runSingleDocSendToSpeech(view, false);
  },
  sendToSpeechAtEnd: () => {
    if (multiDocSendToSpeechAtEnd) {
      multiDocSendToSpeechAtEnd();
      return;
    }
    if (view) runSingleDocSendToSpeech(view, true);
  },
  sendToDropzone: () => {
    if (multiDocSendToDropzone) {
      multiDocSendToDropzone();
      return;
    }
    if (view) void sendViewToDropzone(view);
  },
  sendToStarred: () => {
    if (multiDocSendToStarred) {
      multiDocSendToStarred();
      return;
    }
    if (view) void sendViewToStarred(view);
  },
  sendToRecipient: () => {
    if (multiDocSendToRecipient) {
      multiDocSendToRecipient();
      return;
    }
    if (view) void sendViewToRecipient(view);
  },
  insertReceivedAtCursor: () => {
    // The home screen covers the destination doc — same interdiction as
    // the receive pill's rows (the keyboard path must not silently write
    // into a document the user can't see).
    if (homeScreen.isVisible()) {
      showToast(RECEIVE_NEEDS_DOC_MESSAGE);
      return;
    }
    if (view) insertMostRecentReceived(view, false);
  },
  insertReceivedAtEnd: () => {
    if (homeScreen.isVisible()) {
      showToast(RECEIVE_NEEDS_DOC_MESSAGE);
      return;
    }
    if (view) insertMostRecentReceived(view, true);
  },
  // Source-only operations on the focused view — no cross-doc
  // destination, so unlike send-to-* they need no multi-doc routing
  // (`view` is the focused pane's view in both modes).
  selectCurrentHeading: () => {
    if (view) selectCurrentHeadingIn(view);
  },
  deleteCurrentHeading: () => {
    if (view) deleteCurrentHeadingIn(view);
  },
  copyCurrentHeading: () => {
    if (view) void copyCurrentHeadingIn(view);
  },
  addQuickCard: () => {
    if (view) void runAddQuickCard(view);
  },
  manageQuickCards: () => {
    void quickCardsManageUI.open();
  },
  openQuickCardSearch: () => {
    // Centre over the focused pane (multi-pane) or the editor element
    // (single-doc); opens browse-only when there's no active view.
    const paneEl =
      (view?.dom.closest('.pmd-pane') as HTMLElement | null) ?? editorEl ?? null;
    quickCardSearchUI.open({
      view,
      paneEl,
      runCommand: runRibbonCommandById,
      openFilePath: openFileByPath,
      // Enables per-header Mod+Enter "transclude" while browsing a file normally.
      docPath: view ? getViewDocPath(view) : null,
    });
  },
  insertLiveZone: () => {
    // Same picker, in transclude mode: pick a file, drill to a header, insert a
    // live zone. Needs the current doc's path to build a portable source ref.
    const paneEl =
      (view?.dom.closest('.pmd-pane') as HTMLElement | null) ?? editorEl ?? null;
    const docPath = view ? getViewDocPath(view) : null;
    quickCardSearchUI.open({
      view,
      paneEl,
      runCommand: runRibbonCommandById,
      openFilePath: openFileByPath,
      transcludeMode: true,
      docPath,
    });
  },
  insertSelfLiveZone: () => {
    // Live View: pick a section of THIS doc to mirror read-only.
    if (view) openInsertSelfRef(view);
  },
  insertInDocCopy: () => {
    // Linked Copy from this doc: pick a section to copy in editably.
    if (view) openInsertInDocCopy(view);
  },
  insertImage: () => {
    if (!view) return;
    openImagePicker(view);
  },
  zoomIn: () => zoomActiveBy(10),
  zoomOut: () => zoomActiveBy(-10),
  zoomReset: () => zoomActiveReset(),
  chromeScaleUp: () => setChromeScale(settings.get('chromeScalePct') + 10),
  chromeScaleDown: () => setChromeScale(settings.get('chromeScalePct') - 10),
  chromeScaleReset: () => setChromeScale(100),
  togglePaintbrushHighlight: () => {
    if (!view) return;
    colorPanel?.togglePaintbrush('highlight');
  },
  togglePaintbrushShading: () => {
    if (!view) return;
    colorPanel?.togglePaintbrush('shading');
  },
  openFind: () => {
    if (!view) return;
    ensureFindReplaceBar().open({ mode: 'find', sortMode: 'categorized' });
  },
  openRepairParagraph: () => {
    if (!view) return;
    ensureRepairParagraphBar().open();
  },
  openFindReplace: () => {
    if (!view) return;
    ensureFindReplaceBar().open({ mode: 'replace', sortMode: 'categorized' });
  },
  openFindByProximity: () => {
    if (!view) return;
    ensureFindReplaceBar().open({ mode: 'find', sortMode: 'uncategorized' });
  },
  toggleNavPane: () => {
    if (multiDocActive && multiDocToggleAllNav) multiDocToggleAllNav();
    else settings.set('navPaneVisible', !settings.get('navPaneVisible'));
  },
  // ─── No-default-binding hooks ────────────────────────────────
  // Each routes through the same button's existing click handler
  // (via `.click()`) — the keybinding then follows the exact same
  // UX as a ribbon click, including dropdown positioning and any
  // selection-aware branching. Wired this way so we don't have to
  // duplicate the host-side menu construction in two places.
  lastFontColor: () => settings.get('lastFontColor'),
  openSettings: () => settingsBtn.click(),
  minimizeWindow: () => {
    void getElectronHost()?.minimizeWindow();
  },
  openJournalsFolder: () => {
    void getElectronHost()?.openJournalsFolder();
  },
  toggleMorphMode: () => {
    toggleMorphMode();
  },
  recoverPreviousVersion: () => {
    // Mode-aware opener: three-pane mounts the recovered copy into a
    // slot of THIS window (the same funnel as File -> Open, so the slot
    // picker and duplicate guards apply); single-pane spawns a window.
    const openRecovered = async (name: string, bytes: Uint8Array): Promise<void> => {
      if (multiDocActive && multiDocOnFileOpen) {
        await multiDocOnFileOpen({ name, bytes, handle: undefined });
        return;
      }
      await getElectronHost()?.spawnWindow({
        filename: name,
        bytes,
        handle: null,
        format: 'cmir',
        uid: null,
      });
    };
    void loadCollabUi().then((m) =>
      m.recoverPreviousVersionFlow(openRecovered, {
        docId: activeSavedDocId() ?? null,
        docTitle: activeFile().filename ?? 'Untitled',
        // Focused doc in both modes (setActiveView tracks the pane) —
        // powers the version rows' "N cards not in current doc" badge.
        currentDoc: getActiveView()?.state.doc ?? null,
      }),
    );
  },
  cycleTheme: () => {
    // light → dark → system → light. The settings subscription
    // re-runs applyTheme, so this is all the command needs to do.
    const order = ['light', 'dark', 'system'] as const;
    const cur = settings.get('theme');
    const next = order[(order.indexOf(cur) + 1) % order.length]!;
    settings.set('theme', next);
    showToast(`Theme: ${next}`);
  },
  cycleTimerPreset: () => {
    // Cycle the timer profile College → High School → Pomodoro (wrapping),
    // applying its saved durations. Surface the timer so the change is visible
    // and confirm via toast.
    setTimerVisible(true);
    const next = cycleTimerProfile();
    showToast(`Timer preset: ${TIMER_PROFILE_LABELS[next]}`);
  },
  toggleParagraphIntegrity: () => {
    settings.set('paragraphIntegrity', !settings.get('paragraphIntegrity'));
  },
  selectSpeechDoc: () => {
    void openSelectSpeechDocModal();
  },
  goHome: () => {
    // Open home over the current doc (return-to-doc enabled) — except a
    // multi-pane workspace with nothing open: "Return to doc" there
    // would just dismiss home back to the blank window.
    const canReturnToDoc =
      !multiDocActive ||
      (multiDocGetAllFilenames?.().some((f) => f !== null) ?? false);
    homeScreen.show({ canReturnToDoc });
  },
  openHighlightPicker: () => colorPanel?.openPicker('highlight'),
  openShadingPicker: () => colorPanel?.openPicker('shading'),
  openFontColorPicker: () => colorPanel?.openPicker('fontcolor'),
  openFontSizePicker: () => fontSizePickerBtn?.click(),
  openDocToolsMenu: () => docMenuBtn?.click(),
  openCardToolsMenu: () => cardMenuBtn?.click(),
  openTableMenu: () => tableMenuBtn?.click(),
};

// Toolbar convention (same as homeBtn below): don't let the click
// steal focus onto the button — the flows these trigger end by
// focusing the mounted doc, and a focused button would otherwise hold
// the keyboard if any async step in between dropped the ball
// (2026-07-27 focus audit).
openBtn.addEventListener('mousedown', (e) => e.preventDefault());
openBtn.addEventListener('click', () => {
  void runOpenFlow();
});
if (newBtn) {
  newBtn.addEventListener('mousedown', (e) => e.preventDefault());
  newBtn.addEventListener('click', () => {
    void onNewDocClicked();
  });
}
if (homeBtn) {
  homeBtn.addEventListener('mousedown', (e) => e.preventDefault());
  // goHome is view-less (pure UI) — call the ctx side effect
  // directly rather than via runRibbon, which gates on a live
  // `view` (null in multi-pane with no panes open). The keybinding
  // path reaches the same ctx.goHome via runViewlessRibbon.
  homeBtn.addEventListener('click', () => ribbonContext.goHome());
}


/**
 * Handle the ribbon "New document" button.
 *
 *   - Multi-doc: route through the multi-pane shell's slot picker
 *     (the new doc is added to a stack alongside whatever else is
 *     open; no "current doc" to overwrite).
 *   - Single-doc: replacing the current view is destructive, so
 *     ask first. Three-button confirm: Save → run Save As, on
 *     success swap to a fresh doc; Don't save → swap immediately;
 *     Cancel → bail. Esc / overlay click also cancel.
 */
async function onNewDocClicked(): Promise<void> {
  if (multiDocActive && multiDocOnNewDoc) {
    void multiDocOnNewDoc();
    return;
  }
  // Multi-window mode (single-doc + Electron): New always spawns a
  // new window. The current window stays put — including when it's
  // still showing the pristine starter, because the user clicking
  // New is an unambiguous request for a fresh doc to work in, not
  // a request to overwrite. No prompt: nothing in the current
  // window is at risk of being lost.
  const host = getHost();
  if (host.canSpawnWindow) {
    try {
      await host.spawnWindow(null);
    } catch (err) {
      console.error('Spawn window failed:', err);
      void alertDialog(`Failed to open new window: ${err instanceof Error ? err.message : err}`);
    }
    return;
  }
  // Web edition: no other window to open into, so New replaces
  // what's here. Only prompt to save if there are actual edits to
  // lose — the pristine starter is disposable.
  if (!isPristineStarter) {
    const choice = await confirmNewDocOverwrite();
    if (choice === 'cancel') return;
    if (choice === 'save') {
      const saved = await runSaveAsFlow();
      if (!saved) return;
    }
  }
  // Drop the old session's journal before swapping in a new doc —
  // the user's choice (or the pristine-starter shortcut) above is
  // the authoritative signal that they're done with the previous
  // content. New doc gets a fresh uid so future journals key
  // against the new session.
  void clearCurrentJournal();
  mountView(makeNewDocBody());
  currentDocFilename = null;
  setCurrentDocHandle(null);
  currentDocFormat = null;
  currentDocUid = newSessionDocUid();
  currentDocId = null; // new doc → minted on first save
  markCurrentDocClean();
  syncSingleDocSpeechRegistration();
  // The fresh doc is conceptually still pristine, but the user
  // just demonstrated they're done with whatever was here before.
  // Treat as non-pristine so subsequent Opens spawn.
  markNonPristineStarter();
  updateWindowTitle();
  // The user asked for a doc to type into — put the caret there so
  // typing works with no extra click.
  view?.focus();
}

/** Join-session doc swap: the web edition's New-in-place path, minus
 *  the spawn branch — the session binds to the CURRENT window's view.
 *  Same overwrite protection as New: real edits prompt save/discard/
 *  cancel; returns false when the user cancels (caller unwinds the
 *  join without touching the room). */
async function replaceWithSessionDoc(): Promise<boolean> {
  if (multiDocActive) return false; // sessions are single-doc-window only
  if (!isPristineStarter) {
    const choice = await confirmNewDocOverwrite();
    if (choice === 'cancel') return false;
    if (choice === 'save') {
      const saved = await runSaveAsFlow();
      if (!saved) return false;
    }
  }
  void clearCurrentJournal();
  mountView(makeNewDocBody());
  currentDocFilename = null;
  setCurrentDocHandle(null);
  currentDocFormat = null;
  currentDocUid = newSessionDocUid();
  currentDocId = null; // unsaved session copy → docId minted on first save
  markCurrentDocClean();
  syncSingleDocSpeechRegistration();
  markNonPristineStarter();
  updateWindowTitle();
  // Joining from the home screen (the receive pill's Join is reachable
  // there): the session doc just replaced the content — home must yield
  // to it, like every other doc-mounting path.
  homeScreen.hide();
  // Focus after hide (2026-07-27 focus audit: mountView drops focus to
  // body; the Loro binding then replaces the content, which focus
  // survives). Keyboard works in the joined session with no click.
  view?.focus();
  return true;
}

/** Three-button overlay used by the single-doc "New document" flow.
 *  Returns the user's choice; resolves with `'cancel'` on Esc or
 *  the explicit Cancel button. */
function confirmNewDocOverwrite(): Promise<'save' | 'discard' | 'cancel'> {
  return new Promise((resolve) => {
    const overlayToken = pushOverlay();
    const overlay = document.createElement('div');
    overlay.className = 'pmd-route-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'pmd-route-dialog';

    const header = document.createElement('div');
    header.className = 'pmd-route-header';
    header.textContent = 'Save your current document before creating a new one?';
    dialog.appendChild(header);

    const buttons = document.createElement('div');
    buttons.className = 'pmd-route-buttons';

    let removeKeys = (): void => {};
    const cleanup = (): void => {
      popOverlay(overlayToken);
      overlay.remove();
      removeKeys();
    };

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'pmd-route-btn';
    saveBtn.innerHTML = '<strong>Save</strong><br><span>Save the current doc, then start fresh.</span>';
    saveBtn.addEventListener('click', () => { cleanup(); resolve('save'); });
    buttons.appendChild(saveBtn);

    const discardBtn = document.createElement('button');
    discardBtn.type = 'button';
    discardBtn.className = 'pmd-route-btn';
    discardBtn.innerHTML = "<strong>Don't save</strong><br><span>Discard changes and start fresh.</span>";
    discardBtn.addEventListener('click', () => { cleanup(); resolve('discard'); });
    buttons.appendChild(discardBtn);

    dialog.appendChild(buttons);

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'pmd-route-cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => { cleanup(); resolve('cancel'); });
    dialog.appendChild(cancel);

    overlay.appendChild(dialog);
    // Click outside the dialog box → cancel.
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { cleanup(); resolve('cancel'); }
    });
    // Capture-phase + swallow (see installModalKeys): this dialog is
    // bound to Mod-N, so it always opens over a FOCUSED editor — a
    // bubble-phase listener let Enter reach ProseMirror's keydown and
    // insert a newline before the dialog ever saw the key.
    removeKeys = installModalKeys(dialog, overlayToken, (e) => {
      if (e.key === 'Escape') {
        cleanup();
        resolve('cancel');
        return true;
      }
      return false;
    });
    document.body.appendChild(overlay);
    armDialogFocus(dialog, 'alertdialog', 'Save your current document before creating a new one?');
  });
}
/** The Settings subtree (settings-ui + keybindings editor + benchmark
 *  harness) is the largest UI module in the app and most sessions never
 *  open it — load it on first use, mirroring recovery-ui / mobile-shell.
 *  Cached so repeat opens don't re-resolve. */
let settingsUiModule: Promise<typeof import('./settings-ui.js')> | null = null;
function loadSettingsUi(): Promise<typeof import('./settings-ui.js')> {
  return (settingsUiModule ??= import('./settings-ui.js'));
}
settingsBtn.addEventListener('click', () => {
  void loadSettingsUi().then((m) => m.openSettings());
});
/**
 * Tiny adapter to invoke a `RibbonCommandId` against the active view
 * with the live context. Used by every menu item and ribbon button so
 * a single user-defined keybinding fires the exact same code path
 * as clicking the UI — and so binding/unbinding a command never leaves
 * the UI orphaned.
 */
export function runRibbon(id: AnyCommandId): void {
  if (!view) return;
  getRibbonCommand(id, ribbonContext)(view.state, view.dispatch.bind(view), view);
}

/**
 * Open the OS file picker (single image) and insert the chosen
 * file at `targetView`'s current cursor. Same code path the paste-
 * plugin uses for clipboard image paste, sourced from an
 * `<input type="file">` instead of `event.clipboardData`. The
 * input element is detached after use; reusing a static one would
 * complicate the "pick the same file twice" case.
 */
function openImagePicker(targetView: EditorView): void {
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'image/*';
  picker.style.display = 'none';
  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    picker.remove();
    if (!file) return;
    void (async () => {
      const node = await buildImageNodeFromBlob(file);
      if (!node) {
        void alertDialog(`Couldn't read "${file.name}" as an image.`);
        return;
      }
      const inserted = insertImageNode(targetView, node);
      if (!inserted) {
        void alertDialog(
          'The cursor isn\'t in a position that accepts inline content. Click into a card body, paragraph, or heading first.',
        );
      }
    })();
  });
  document.body.appendChild(picker);
  picker.click();
}

if (referenceBtn) {
  // Call `openReference` directly (like `settingsBtn` → `openSettings`)
  // rather than dispatching through `runRibbon`, which early-bails
  // when `view` is null. The shortcuts dialog has no view
  // dependency, so it should still open in multi-doc mode when no
  // pane currently has a doc.
  referenceBtn.addEventListener('click', () => openReference());
}

if (insertImageBtn) {
  insertImageBtn.addEventListener('mousedown', (e) => e.preventDefault());
  insertImageBtn.addEventListener('click', () => runRibbon('insertImage'));
}

const docMenuBtn = document.getElementById('doc-menu-btn') as HTMLButtonElement | null;
if (docMenuBtn) {
  docMenuBtn.addEventListener('mousedown', (e) => e.preventDefault());
  docMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Sections alphabetical by title — Cleanup, Highlighting, Select.
    // Each entry that touches body text is selection-sensitive
    // (selection if non-empty, doc-wide otherwise).
    openDocMenu(docMenuBtn, view, [
      {
        title: 'Cleanup',
        items: [
          {
            label: 'Convert Analytics to Tags',
            commandId: 'convertAnalyticsToTags',
            run: () => runRibbon('convertAnalyticsToTags'),
          },
          {
            label: 'Convert Cited Analytics to Tags',
            commandId: 'convertCitedAnalyticsToTags',
            run: () => runRibbon('convertCitedAnalyticsToTags'),
          },
          {
            label: 'Fix Formatting Gaps',
            commandId: 'fixFormattingGaps',
            run: () => runRibbon('fixFormattingGaps'),
          },
          {
            label: 'Remove Hyperlinks',
            commandId: 'removeHyperlinks',
            run: () => runRibbon('removeHyperlinks'),
          },
        ],
      },
      {
        title: 'Highlighting',
        items: [
          {
            label: 'Standardize Highlighting',
            commandId: 'standardizeHighlight',
            run: () => runRibbon('standardizeHighlight'),
          },
          {
            label: 'Standardize Background Color',
            commandId: 'standardizeShading',
            run: () => runRibbon('standardizeShading'),
          },
          // The menu is rebuilt on every open, so these labels show
          // the live exception colors from settings.
          {
            label: `Standardize Highlighting (except ${highlightColorLabel(settings.get('standardizeHighlightException'))})`,
            commandId: 'standardizeHighlightExcept',
            run: () => runRibbon('standardizeHighlightExcept'),
          },
          {
            label: `Standardize Background Color (except ${shadingColorLabel(settings.get('standardizeShadingException'))})`,
            commandId: 'standardizeShadingExcept',
            run: () => runRibbon('standardizeShadingExcept'),
          },
        ],
      },
      {
        title: 'Select',
        items: [
          {
            label: 'Select Similar Formatting',
            commandId: 'selectSimilar',
            run: () => runRibbon('selectSimilar'),
          },
        ],
      },
    ]);
  });
}

// Table dropdown — same openDocMenu shape as Doc / Card, lives in
// the format-menu panel. Sections alphabetical by title.
const tableMenuBtn = document.getElementById('table-menu-btn') as HTMLButtonElement | null;
if (tableMenuBtn) {
  tableMenuBtn.addEventListener('mousedown', (e) => e.preventDefault());
  tableMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openDocMenu(tableMenuBtn, view, [
      {
        title: 'Table',
        items: [
          { label: 'Insert Table (3×3)', commandId: 'insertTable', run: () => runRibbon('insertTable') },
          { label: 'Insert Row Above', commandId: 'addRowBefore', run: () => runRibbon('addRowBefore') },
          { label: 'Insert Row Below', commandId: 'addRowAfter', run: () => runRibbon('addRowAfter') },
          { label: 'Insert Column Left', commandId: 'addColumnBefore', run: () => runRibbon('addColumnBefore') },
          { label: 'Insert Column Right', commandId: 'addColumnAfter', run: () => runRibbon('addColumnAfter') },
          { label: 'Delete Row', commandId: 'deleteTableRow', run: () => runRibbon('deleteTableRow') },
          { label: 'Delete Column', commandId: 'deleteTableColumn', run: () => runRibbon('deleteTableColumn') },
          { label: 'Merge Cells', commandId: 'mergeTableCells', run: () => runRibbon('mergeTableCells') },
          { label: 'Split Cell', commandId: 'splitTableCell', run: () => runRibbon('splitTableCell') },
          { label: 'Delete Table', commandId: 'deleteTable', run: () => runRibbon('deleteTable') },
        ],
      },
    ]);
  });
}

// Inline formatting toggles — same runRibbon dispatch as Mod-B/Mod-I,
// so a binding override or future shadow-selection change applies
// uniformly. Press state isn't reflected on these buttons — they're
// not in the formatting-panel active-state loop
// (`refreshFormattingPanelButtonStates`).
const superscriptBtn = document.getElementById('superscript-btn') as HTMLButtonElement | null;
if (superscriptBtn) {
  superscriptBtn.addEventListener('mousedown', (e) => e.preventDefault());
  superscriptBtn.addEventListener('click', () => runRibbon('toggleSuperscript'));
}
const subscriptBtn = document.getElementById('subscript-btn') as HTMLButtonElement | null;
if (subscriptBtn) {
  subscriptBtn.addEventListener('mousedown', (e) => e.preventDefault());
  subscriptBtn.addEventListener('click', () => runRibbon('toggleSubscript'));
}
const strikethroughBtn = document.getElementById('strikethrough-btn') as HTMLButtonElement | null;
if (strikethroughBtn) {
  strikethroughBtn.addEventListener('mousedown', (e) => e.preventDefault());
  strikethroughBtn.addEventListener('click', () => runRibbon('toggleStrikethrough'));
}

const cardMenuBtn = document.getElementById('card-menu-btn') as HTMLButtonElement | null;
if (cardMenuBtn) {
  cardMenuBtn.addEventListener('mousedown', (e) => e.preventDefault());
  cardMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Sections are kept alphabetical by title — Condense, Excerpt,
    // Highlighting. All items route through `getRibbonCommand` so a
    // user-bound key fires the same code path as clicking the menu.
    openDocMenu(cardMenuBtn, view, [
      {
        title: 'Condense',
        items: [
          { label: 'Condense', commandId: 'condenseDefault', run: () => runRibbon('condenseDefault') },
          {
            label: 'Condense without paragraph integrity',
            commandId: 'condenseNoIntegrity',
            run: () => runRibbon('condenseNoIntegrity'),
          },
          {
            label: 'Condense with pilcrows',
            commandId: 'condenseNoIntegrityWithPilcrows',
            run: () => runRibbon('condenseNoIntegrityWithPilcrows'),
          },
          {
            label: 'Condense with warning',
            commandId: 'condenseWithWarning',
            run: () => runRibbon('condenseWithWarning'),
          },
          { label: 'Uncondense', commandId: 'uncondense', run: () => runRibbon('uncondense') },
        ],
      },
      {
        title: 'Excerpt',
        items: [
          {
            label: 'Create Reference',
            commandId: 'createReference',
            run: () => runRibbon('createReference'),
          },
          {
            label: 'Extract Undertag',
            commandId: 'extractUndertag',
            run: () => runRibbon('extractUndertag'),
          },
        ],
      },
      {
        title: 'Highlighting',
        items: [
          {
            label: 'Lock Highlighting',
            commandId: 'lockHighlighting',
            run: () => runRibbon('lockHighlighting'),
          },
          {
            label: 'Highlight to Background',
            commandId: 'highlightToShading',
            run: () => runRibbon('highlightToShading'),
          },
          {
            label: 'Background to Highlight',
            commandId: 'shadingToHighlight',
            run: () => runRibbon('shadingToHighlight'),
          },
        ],
      },
    ]);
  });
}
readModeBtn.addEventListener('click', () => runRibbon('toggleReadMode'));
wordCountBtn.addEventListener('click', () => runRibbon('wordCountSelection'));

/** Push the current `navPaneVisible` setting into a body class so
 *  the CSS rules at the top of style.css can hide/show the nav
 *  pane (single-doc panel + multi-doc rail) + the left-edge pull-
 *  tab. Called on boot and on every setting change. */
function applyNavPaneVisible(visible: boolean): void {
  document.body.classList.toggle('pmd-nav-hidden', !visible);
}
// The reading-view button took the nav toggle's permanent ribbon slot
// (2026-08-31); Show/Hide Navigation Pane stays available as a
// command (command bar, custom ribbon buttons, bindable hotkey).
if (readerViewBtn) {
  readerViewBtn.addEventListener('mousedown', (e) => e.preventDefault());
  readerViewBtn.addEventListener('click', () => runRibbon('toggleReaderView'));
}
if (navPanePullTab) {
  // Pull-tab is only ever shown when the nav pane is hidden;
  // clicking it always re-shows.
  navPanePullTab.addEventListener('click', () => {
    if (multiDocActive && multiDocShowAllNav) multiDocShowAllNav();
    else settings.set('navPaneVisible', true);
  });
}
applyNavPaneVisible(settings.get('navPaneVisible'));

/** Apply the `formatNavPaneByType` setting. When off, adds the
 *  `pmd-nav-flat` class to `<html>`; CSS rules in `style.css`
 *  flatten the per-level font weights / sizes and the analytic-blue
 *  label color so only indentation conveys hierarchy. */
function applyFormatNavPaneByType(on: boolean): void {
  document.documentElement.classList.toggle('pmd-nav-flat', !on);
}
applyFormatNavPaneByType(settings.get('formatNavPaneByType'));

// Speech-doc buttons — shown in multi-doc / multi-window modes
// (CSS-gated; hidden otherwise). All four route through the ctx
// commands. The new-speech button uses ribbonContext directly
// because it works without a view; the other three guard on `view`
// to match the keymap dispatch path.
if (speechNewBtn) {
  speechNewBtn.addEventListener('mousedown', (e) => e.preventDefault());
  speechNewBtn.addEventListener('click', () => ribbonContext.newSpeechDocument());
}
if (speechMarkBtn) {
  speechMarkBtn.addEventListener('mousedown', (e) => e.preventDefault());
  speechMarkBtn.addEventListener('click', () => runRibbon('markActiveAsSpeech'));
}
if (speechSendCursorBtn) {
  speechSendCursorBtn.addEventListener('mousedown', (e) => e.preventDefault());
  speechSendCursorBtn.addEventListener('click', () => runRibbon('sendToSpeechAtCursor'));
}
if (speechSendEndBtn) {
  speechSendEndBtn.addEventListener('mousedown', (e) => e.preventDefault());
  speechSendEndBtn.addEventListener('click', () => runRibbon('sendToSpeechAtEnd'));
}

// Quick Cards ribbon cluster: Add, Search, Tag Picker, Manage.
// `mousedown` preventDefault on all four keeps the editor selection
// intact (Add needs it; harmless for the rest).
const qcSearchBtn = document.getElementById('qc-search-btn') as HTMLButtonElement | null;
const qcTagPickerBtn = document.getElementById('qc-tagpicker-btn') as HTMLButtonElement | null;
const qcManageBtn = document.getElementById('qc-manage-btn') as HTMLButtonElement | null;
const qcAddBtn = document.getElementById('qc-add-btn') as HTMLButtonElement | null;
for (const btn of [qcSearchBtn, qcTagPickerBtn, qcManageBtn, qcAddBtn]) {
  btn?.addEventListener('mousedown', (e) => e.preventDefault());
}
qcAddBtn?.addEventListener('click', () => runRibbon('addQuickCard'));
// Search is view-less — call ctx directly so it opens even with no doc.
qcSearchBtn?.addEventListener('click', () => ribbonContext.openQuickCardSearch());
qcTagPickerBtn?.addEventListener('click', () => {
  if (qcTagPickerBtn) openQuickCardTagPicker(qcTagPickerBtn);
});
qcManageBtn?.addEventListener('click', () => void quickCardsManageUI.open());

// Comments column. The CommentsColumn instance owns the side-panel
// DOM; we re-render it via `view.dispatchTransaction` overrides
// further down so doc edits, plugin meta, and selection changes all
// keep the panel in sync. setVisible flips the `hidden` attr +
// stores the setting + dispatches a `set-visible` meta to the plugin.
export const commentsColumn = commentsColumnEl
  ? new CommentsColumn(commentsColumnEl, () => view ?? null, () => activeAnnotationDocId())
  : null;
/** The DOM element for the comments column — exposed so the
 *  multi-pane shell can adopt it as a sibling of the multi-row.
 *  Returns null when the host build doesn't include the column
 *  (the element is conditionally present in `index.html`). */
export function getCommentsColumnEl(): HTMLElement | null {
  return commentsColumnEl;
}
/** Per-pane `dispatchTransaction` in the multi-pane shell calls
 *  this with each transaction to mirror the single-pane comment
 *  column updates: render-schedule on doc/plugin changes and
 *  active-thread tracking on selection changes. No-op when the
 *  column doesn't exist or when the transaction's view isn't the
 *  current active one — background-stack edits in non-focused
 *  panes shouldn't paint over the focused doc's column. */
export function notifyCommentsForActiveTransaction(
  v: EditorView,
  prevState: EditorState,
  next: EditorState,
  docChanged: boolean,
): void {
  if (!commentsColumn) return;
  if (view !== v) return;
  const prevCommentsState = commentsKey.getState(prevState);
  if (docChanged || commentsKey.getState(next) !== prevCommentsState) {
    commentsColumn.scheduleRender();
  }
  if (prevState.selection !== next.selection || docChanged) {
    const id = threadIdAtCursor(next);
    commentsColumn.setActiveThread(id);
  }
}
if (commentsToggleBtn && commentsColumn) {
  commentsToggleBtn.addEventListener('click', () => {
    const next = commentsColumnEl?.hidden ?? true;
    commentsColumn.setVisible(next);
    commentsToggleBtn.setAttribute('aria-pressed', next ? 'true' : 'false');
    commentsColumn.render();
  });
}
if (commentsAddBtn && commentsColumn) {
  commentsAddBtn.addEventListener('mousedown', (e) => e.preventDefault());
  commentsAddBtn.addEventListener('click', () => {
    if (!view) return;
    const newId = addCommentToSelection(view);
    if (!newId) return;
    // Auto-reveal the column so the user can see and fill in the
    // new thread right away.
    if (commentsColumnEl?.hidden) {
      commentsColumn.setVisible(true);
      commentsToggleBtn?.setAttribute('aria-pressed', 'true');
    }
    commentsColumn.render();
    commentsColumn.focusReplyForThread(newId);
  });
}
// Create-flashcard + Ask-AI buttons (bottom row of the comments
// panel). Both act on the selection, so preventDefault on mousedown
// keeps the editor focused + the selection live; the click runs the
// same bindable command the keyboard does. The Ask-AI button is shown
// only while AI features are enabled (see `applyAskAiButtonVisibility`).
if (createFlashcardBtn) {
  createFlashcardBtn.addEventListener('mousedown', (e) => e.preventDefault());
  createFlashcardBtn.addEventListener('click', () => runRibbonCommandById('createFlashcard'));
}
if (manageFlashcardsBtn) {
  manageFlashcardsBtn.addEventListener('mousedown', (e) => e.preventDefault());
  manageFlashcardsBtn.addEventListener('click', () => runRibbonCommandById('manageFlashcards'));
}
// Red due-today dot on the Manage Flashcards button: shown when any
// flashcard is due across the whole library AND the setting is on.
// Recompute on store changes (cards added / reviewed), on the setting
// toggle (handled by the settings subscriber below), and when the app
// regains focus (catches a midnight day-rollover while it sat idle).
function refreshFlashcardDueDot(): void {
  if (!manageFlashcardsBtn) return;
  const show =
    settings.get('flashcardDueDot') &&
    learnStore.dueCount({ kind: 'all' }, localToday()) > 0;
  manageFlashcardsBtn.classList.toggle('pmd-ribbon-due-dot', show);
}
learnStore.subscribe(refreshFlashcardDueDot);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshFlashcardDueDot();
});
refreshFlashcardDueDot();

/** Rebuild the user-configured custom ribbon buttons from settings. Each runs
 *  a chosen command with a chosen icon; entries whose command is no longer
 *  available are skipped, and the whole panel is hidden when nothing valid is
 *  configured. Called at boot, whenever `ribbonCustomButtons` changes, and on
 *  plugin registration changes (a button bound to a plugin command appears
 *  once its plugin loads — async after boot — and vanishes on uninstall). */
function renderCustomRibbonButtons(): void {
  const panel = document.getElementById('custom-ribbon-panel');
  if (!panel) return;
  // Release tooltips for the buttons we're about to discard, then rebuild.
  for (const old of panel.querySelectorAll('button')) unregisterRibbonTooltip(old);
  panel.replaceChildren();
  const available = new Set(availableRibbonCommandIds());
  let shown = 0;
  for (const cfg of settings.get('ribbonCustomButtons')) {
    const cmd = cfg.command;
    // A custom button binds a ribbon command (static or plugin) OR a setting
    // command (toggle:/cycle:). Resolve a label from whichever it is; skip
    // when it's neither available nor a known setting command (obsolete /
    // gated-off / its plugin not loaded).
    const settingLabel = settingCommandLabel(cmd);
    const ribbonLabel = !settingLabel && available.has(cmd) ? commandLabelFor(cmd) : undefined;
    const label = settingLabel ?? ribbonLabel;
    if (!label) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ribbon-doc-ops-btn';
    setIcon(btn, cfg.icon);
    btn.setAttribute('aria-label', label);
    // Keep the editor selection alive across the click (selection commands).
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      if (!runSettingCommand(cmd)) runRibbonCommandById(cmd);
    });
    // Ribbon commands use the managed tooltip (label + live shortcut); setting
    // commands aren't in that registry, so give them a plain title. Plugin
    // commands aren't in RIBBON_COMMAND_LABELS, so hand the tooltip its label.
    if (settingLabel) btn.title = settingLabel;
    else registerRibbonTooltip({ el: btn, commandId: cmd, label: ribbonLabel });
    panel.appendChild(btn);
    shown++;
  }
  panel.hidden = shown === 0;
}
renderCustomRibbonButtons();
if (askAiBtn) {
  askAiBtn.addEventListener('mousedown', (e) => e.preventDefault());
  askAiBtn.addEventListener('click', () => runRibbonCommandById('aiAskAboutSelection'));
}
if (addNoteBtn) {
  addNoteBtn.addEventListener('mousedown', (e) => e.preventDefault());
  addNoteBtn.addEventListener('click', () => runRibbonCommandById('addNoteToSelection'));
}

/** Show the Ask-AI ribbon button only when AI features are enabled. */
function applyAskAiButtonVisibility(enabled: boolean): void {
  if (askAiBtn) askAiBtn.hidden = !enabled;
}
applyAskAiButtonVisibility(settings.get('aiFeaturesEnabled'));

/** Find the column-card id of the annotation at the current cursor
 *  position — a comment thread, an AI thread, or a flashcard — so the
 *  comments column can focus its card. Returns null when the cursor
 *  isn't inside one.
 *
 *  Comments anchor via a `comment_range` mark (and serialize); we check
 *  the inherited marks at $from / $to plus the text node immediately
 *  before / after the cursor, so a cursor parked at the very start of a
 *  marked range still resolves. AI threads and flashcards are local-only
 *  and anchor via highlight-plugin decorations instead of a mark, so a
 *  mark lookup misses them — fall back to the resolved highlight ranges
 *  and return the column's prefixed id (`ai:` / `fc:`). Comment marks win
 *  over a highlight range when text carries both. */
export function threadIdAtCursor(state: EditorState): string | null {
  const sel = state.selection;
  const harvest = (markSources: readonly (readonly Mark[])[]): string | null => {
    for (const marks of markSources) {
      for (const m of marks) {
        if (m.type.name === 'comment_range') {
          const id = String(m.attrs['threadId'] ?? '');
          if (id) return id;
        }
      }
    }
    return null;
  };
  const commentId = harvest([
    sel.$from.marks(),
    sel.$to.marks(),
    sel.$from.nodeAfter?.marks ?? [],
    sel.$to.nodeBefore?.marks ?? [],
  ]);
  if (commentId) return commentId;
  // Local annotation layer (AI threads / flashcards) — anchored by
  // decoration, not a mark. Either selection endpoint inside a range
  // focuses it, mirroring the comment harvest checking $from and $to.
  const range = flashcardRangeAt(state, sel.from) ?? flashcardRangeAt(state, sel.to);
  if (range) {
    const prefix = range.kind === 'ai' ? AI_PREFIX : range.kind === 'note' ? NOTE_PREFIX : FC_PREFIX;
    return prefix + range.cardId;
  }
  return null;
}

zoomOutBtn.addEventListener('click', () => zoomActiveBy(-10));
zoomInBtn.addEventListener('click', () => zoomActiveBy(10));
zoomResetBtn.addEventListener('click', () => zoomActiveReset());

// Gesture zoom — trackpad pinch and Ctrl+mouse-wheel. Chromium delivers a
// trackpad pinch as a `wheel` event with `ctrlKey` set (identical shape to
// a real Ctrl+wheel), so one handler covers both. We must preventDefault on
// the gesture or Chromium also fires its own native page-zoom on top of
// ours (double zoom). Deltas are accumulated so a continuous pinch (many
// tiny deltas) and a single wheel notch (one large delta) both feel right,
// stepping `zoomPct` by 10% per threshold. Non-passive so preventDefault
// takes effect; capture so we win before any inner scroll handler.
let gestureZoomAccum = 0;
const GESTURE_ZOOM_THRESHOLD = 40; // delta units per 10% step
window.addEventListener(
  'wheel',
  (e: WheelEvent) => {
    if (!e.ctrlKey || !settings.get('gestureZoom')) return;
    e.preventDefault();
    gestureZoomAccum += e.deltaY;
    let steps = 0;
    while (gestureZoomAccum <= -GESTURE_ZOOM_THRESHOLD) {
      steps += 1; // deltaY < 0 → zoom in
      gestureZoomAccum += GESTURE_ZOOM_THRESHOLD;
    }
    while (gestureZoomAccum >= GESTURE_ZOOM_THRESHOLD) {
      steps -= 1; // deltaY > 0 → zoom out
      gestureZoomAccum -= GESTURE_ZOOM_THRESHOLD;
    }
    if (steps !== 0) zoomActiveBy(steps * 10);
  },
  { capture: true, passive: false },
);

// Formatting panel — Verbatim-style ribbon buttons that dispatch the
// same commands as the F4–F7 / Mod-F7 keymap. Display mode and visual
// preview are both driven by settings (formattingPanelMode and
// formattingPanelPreview).
type FormattingPanelId =
  | StructuralRibbonCommandId
  | 'applyCite'
  | 'applyUnderline'
  | 'applyEmphasis'
  | 'clearToNormal';
const FORMATTING_PANEL_BUTTONS: Record<FormattingPanelId, string> = {
  setPocket: 'style-pocket-btn',
  setHat: 'style-hat-btn',
  setBlock: 'style-block-btn',
  setTag: 'style-tag-btn',
  setAnalytic: 'style-analytic-btn',
  setUndertag: 'style-undertag-btn',
  applyCite: 'cite-btn',
  applyUnderline: 'underline-btn',
  applyEmphasis: 'emphasis-btn',
  clearToNormal: 'normal-btn',
};
const FORMATTING_PANEL_SHORT_LABEL: Record<FormattingPanelId, string> = {
  setPocket: 'Pocket',
  setHat: 'Hat',
  setBlock: 'Block',
  setTag: 'Tag',
  setAnalytic: 'Analytic',
  setUndertag: 'Undertag',
  applyCite: 'Cite',
  applyUnderline: 'Underline',
  applyEmphasis: 'Emphasis',
  clearToNormal: 'Clear',
};
// Right-clicking a style button selects every instance of that style in
// the document as a shadow selection (same display + bulk-operation
// machinery as Select Similar Formatting). Structural buttons match
// their block type's content runs; character buttons match the text runs
// carrying their mark(s). Clear (normal) has nothing to "select all of".
const FORMATTING_PANEL_SELECT_ALL: Partial<Record<FormattingPanelId, StyleSelector>> = {
  setPocket: { kind: 'block', nodeType: 'pocket' },
  setHat: { kind: 'block', nodeType: 'hat' },
  setBlock: { kind: 'block', nodeType: 'block' },
  setTag: { kind: 'block', nodeType: 'tag' },
  setAnalytic: { kind: 'block', nodeType: 'analytic' },
  setUndertag: { kind: 'block', nodeType: 'undertag' },
  applyCite: { kind: 'mark', markTypes: ['cite_mark'] },
  // Only the named "Underline" character style (a body mark) — NOT
  // `underline_direct`, the raw underline used inside structural blocks
  // (tag / analytic / pocket / hat / block / undertag). Those carry
  // direct underline, not the underline style, so "select all underline"
  // shouldn't sweep them up.
  applyUnderline: { kind: 'mark', markTypes: ['underline_mark'] },
  applyEmphasis: { kind: 'mark', markTypes: ['emphasis_mark'] },
};
// Which style is "active" at the cursor for each style button — drives
// the toggled-on (aria-pressed) indicator. Structural buttons match the
// cursor's enclosing textblock type; character buttons match its marks.
// Underline matches only the named `underline_mark` (a body style), NOT
// `underline_direct` — the raw underline structural blocks (tags /
// analytics / …) use isn't an instance of the underline style, same as
// the select-all rule. Clear has no on-state.
const FORMATTING_PANEL_ACTIVE_BLOCK: Partial<Record<FormattingPanelId, string>> = {
  setPocket: 'pocket',
  setHat: 'hat',
  setBlock: 'block',
  setTag: 'tag',
  setAnalytic: 'analytic',
  setUndertag: 'undertag',
};
const FORMATTING_PANEL_ACTIVE_MARKS: Partial<Record<FormattingPanelId, readonly string[]>> = {
  applyCite: ['cite_mark'],
  applyUnderline: ['underline_mark'],
  applyEmphasis: ['emphasis_mark'],
};
const formattingPanelEl = document.getElementById('formatting-panel') as HTMLElement | null;
const citePanelEl = document.getElementById('cite-panel') as HTMLElement | null;
const paragraphIntegrityBtn = document.getElementById('paragraph-integrity-btn') as HTMLButtonElement | null;
const formattingPanelBtnRefs: { id: FormattingPanelId; btn: HTMLButtonElement }[] = [];
for (const [id, btnId] of Object.entries(FORMATTING_PANEL_BUTTONS) as [FormattingPanelId, string][]) {
  const btn = document.getElementById(btnId) as HTMLButtonElement | null;
  if (!btn) continue;
  const label = RIBBON_COMMAND_LABELS[id];
  btn.setAttribute('aria-label', label);
  btn.addEventListener('mousedown', (e) => {
    // Don't steal focus from the editor — the command needs to act on
    // the paragraph that holds the live cursor.
    e.preventDefault();
  });
  btn.addEventListener('click', () => {
    if (!view) return;
    const cmd = getRibbonCommand(id, ribbonContext);
    cmd(view.state, view.dispatch.bind(view));
    view.focus();
  });
  const selectAll = FORMATTING_PANEL_SELECT_ALL[id];
  if (selectAll) {
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!view) return;
      // Scoped when there's a live selection OR a sticky scope from a
      // prior right-click — both bound the search to a region.
      const scoped =
        !view.state.selection.empty || !!getSimilarSelectionState(view.state).scope;
      const ok = selectAllOfStyle(selectAll)(view.state, view.dispatch.bind(view));
      if (!ok) {
        showToast(
          `No ${FORMATTING_PANEL_SHORT_LABEL[id]} instances ${
            scoped ? 'in the selection' : 'in this document'
          }.`,
        );
      }
      view.focus();
    });
  }
  formattingPanelBtnRefs.push({ id, btn });
  registerRibbonTooltip({ el: btn, commandId: id });
}

function applyFormattingPanel(
  mode: FormattingPanelMode,
  preview: boolean,
  showCharacterStyles: boolean,
): void {
  if (!formattingPanelEl) return;
  // "Hide" mode scopes to the F4–F12 button array only: the
  // structural-style sub-panel + the cite-panel sub-panel. The
  // color panel (font color / size / highlight / shading) and the
  // doc-ops panel (paragraph integrity toggle) are unaffected —
  // they don't host F-key bindings and have their own visibility
  // controls.
  formattingPanelEl.classList.toggle('hidden', mode === 'hidden');
  formattingPanelEl.classList.toggle('style-preview', preview);
  if (citePanelEl) {
    // Cite panel hidden when the whole formatting panel is hidden,
    // OR when the "Show character styles" setting is off.
    citePanelEl.classList.toggle('hidden', mode === 'hidden' || !showCharacterStyles);
    citePanelEl.classList.toggle('style-preview', preview);
  }
  for (const { id, btn } of formattingPanelBtnRefs) {
    const keyDisplay = formatKeyForDisplay(
      primaryKeyFor(id, settings.get('ribbonKeyOverrides')),
    );
    const shortLabel = FORMATTING_PANEL_SHORT_LABEL[id];
    // ' · ' matches the separator used in the status-bar read-time
    // display, so the visual rhythm is consistent across the chrome.
    btn.textContent =
      mode === 'shortcuts'
        ? (keyDisplay || shortLabel)
        : mode === 'both' && keyDisplay
        ? `${shortLabel} · ${keyDisplay}`
        : shortLabel;
    // Title is managed by the ribbon-tooltip controller (registered
    // for these buttons above) — `reapplyAllRibbonTooltips()` runs
    // from the settings subscriber whenever the relevant inputs
    // (ribbonTooltipMode, ribbonKeyOverrides) change.
  }
}

// Body-text zoom is PER-EDITOR and transient (not a setting): single-pane keeps
// the window's live zoom here; multi-pane keeps it per pane on the DocRecord and
// routes through the hooks below. Only `defaultZoomPct` (what an editor opens at)
// persists + syncs. Chrome scale stays a synced global (see setChromeScale).
let liveZoomPct = 100;
let multiDocZoomBy: ((deltaPct: number) => void) | null = null;
let multiDocZoomResetHook: (() => void) | null = null;
/** Resolves the zoom the status bar should show — single-doc the window's live
 *  zoom, multi-pane the focused pane's (installed via setZoomStateResolver). */
let zoomStateForActive: () => number = () => liveZoomPct;

export function clampZoom(pct: number): number {
  return Math.max(ZOOM_MIN_PCT, Math.min(ZOOM_MAX_PCT, Math.round(pct / 10) * 10));
}

/** Single-pane: set the window's live body zoom (transient). */
function setZoom(pct: number): void {
  liveZoomPct = clampZoom(pct);
  applyZoom(liveZoomPct);
}

/** The window's live body zoom (single-pane). Exported for the mobile shell. */
export function getLiveZoomPct(): number {
  return liveZoomPct;
}

/** Set the window's live body zoom without the desktop step-10 rounding (the
 *  mobile zoom slider/pinch use step 5). Clamped to the body-zoom bounds. */
export function setLiveZoomPct(pct: number): void {
  liveZoomPct = Math.max(ZOOM_MIN_PCT, Math.min(ZOOM_MAX_PCT, Math.round(pct)));
  applyZoom(liveZoomPct);
}

function applyZoom(pct: number): void {
  document.documentElement.style.setProperty('--editor-zoom', String(pct / 100));
  updateZoomStatus(pct);
}

/** Status-bar % label + reset-button state only — shared by the single-pane
 *  applyZoom and the multi-pane per-pane path. */
function updateZoomStatus(pct: number): void {
  zoomPct.textContent = `${pct}%`;
  zoomResetBtn.disabled = pct === 100;
}

/** Apply body zoom to a SPECIFIC editor surface — multi-pane uses this per pane
 *  so panes don't share the window-level `--editor-zoom` var. */
export function applyZoomToTarget(editorEl: HTMLElement, pct: number): void {
  editorEl.style.zoom = String(pct / 100);
}

/** Replace the resolver behind the status-bar zoom readout. The multi-pane shell
 *  installs a focused-pane resolver at boot. */
export function setZoomStateResolver(resolver: () => number): void {
  zoomStateForActive = resolver;
  updateZoomStatus(zoomStateForActive());
}

/** Re-read the active zoom into the status bar (the shell calls this on pane
 *  focus change). */
export function refreshZoomStatus(): void {
  updateZoomStatus(zoomStateForActive());
}

// ─── Word-style zoom gesture ───────────────────────────────────────
// Zoom used to write the CSS `zoom` value on every 10% step, so a
// continuous ctrl+wheel / key-repeat reflowed the whole editor once per
// step (choppy). Instead the TARGET % shows immediately (badge + status)
// while the actual reflow is deferred: steps within a short window
// coalesce, and the real zoom applies ONCE when the input settles — then
// the viewport is re-anchored (a scaled document otherwise slides under a
// fixed scrollTop). "Show the % you'll land at, then land."

// The anchor view is always `view`: single-doc the editor, multi-pane the
// focused pane's view (the shell keeps `view` pointed there via
// setActiveView), so its nearest scroller is the right one in both modes.

// 120ms covers the default key-repeat interval (~90ms on macOS), so a HELD
// zoom key coalesces into one gesture instead of committing per repeat; the
// badge shows the target instantly, so the extra latency stays imperceptible.
const ZOOM_COMMIT_DELAY_MS = 120;
// How long a committed gesture's anchor stays reusable. Must outlive the
// restore's refine window (up to 6 rAFs ≈ 100ms): a zoom step that lands
// while the previous restore is still refining must NOT capture a fresh
// anchor — it would snapshot a transient, half-corrected layout (the
// rapid-zoom viewport jump). Reusing the burst's original anchor instead
// pins one doc position to one screen Y across the whole burst, so drift
// can't accumulate either. Rapid +/- CLICKS (~150-300ms apart) are the
// case that never coalesces, so the hold is what protects them.
const ZOOM_ANCHOR_HOLD_MS = 250;
let zoomTarget: number | null = null; // pending target during a gesture
let zoomAnchor: ViewportAnchor | null = null; // captured at burst start, held across commits
let zoomAnchorReleaseTimer: number | null = null;
let zoomCommitTimer: number | null = null;
let zoomBadgeEl: HTMLElement | null = null;
let zoomBadgeHideTimer: number | null = null;

function showZoomBadge(pct: number): void {
  if (!zoomBadgeEl) {
    zoomBadgeEl = document.createElement('div');
    zoomBadgeEl.className = 'pmd-zoom-badge';
    zoomBadgeEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(zoomBadgeEl);
  }
  zoomBadgeEl.textContent = `${pct}%`;
  zoomBadgeEl.classList.add('visible');
  if (zoomBadgeHideTimer !== null) window.clearTimeout(zoomBadgeHideTimer);
}

function hideZoomBadgeSoon(): void {
  if (zoomBadgeHideTimer !== null) window.clearTimeout(zoomBadgeHideTimer);
  zoomBadgeHideTimer = window.setTimeout(() => {
    zoomBadgeEl?.classList.remove('visible');
    zoomBadgeHideTimer = null;
  }, 550);
}

/** Drop the held burst anchor once the burst has gone quiet. Re-armed on
 *  every commit, cancelled when a new step keeps the burst alive. */
function releaseZoomAnchorSoon(): void {
  if (zoomAnchorReleaseTimer !== null) window.clearTimeout(zoomAnchorReleaseTimer);
  zoomAnchorReleaseTimer = window.setTimeout(() => {
    zoomAnchorReleaseTimer = null;
    zoomAnchor = null;
  }, ZOOM_ANCHOR_HOLD_MS);
}

/** Apply the pending zoom target once, then pin the viewport back. The
 *  anchor is HELD (not cleared) so steps landing while the restore still
 *  refines continue the same burst against the same baseline. */
function commitZoomGesture(): void {
  zoomCommitTimer = null;
  const target = zoomTarget;
  zoomTarget = null;
  if (target === null) return;
  if (multiDocActive && multiDocZoomBy) {
    multiDocZoomBy(target - zoomStateForActive());
  } else {
    setZoom(target);
  }
  if (zoomAnchor) restoreViewportAnchor(zoomAnchor);
  releaseZoomAnchorSoon();
  hideZoomBadgeSoon();
}

/** Preview a zoom target: update the % readout now, defer the reflow. */
function zoomPreviewTo(pct: number): void {
  const target = clampZoom(pct);
  // A held anchor only carries across the burst within ONE view — a pane
  // focus change mid-burst must re-anchor against the new pane.
  if (zoomAnchor && zoomAnchor.view !== view) zoomAnchor = null;
  if (zoomTarget === null && !zoomAnchor) {
    // Burst start — anchor to the current (committed, settled) layout.
    // A held anchor from a just-committed step is deliberately reused
    // instead: capturing here mid-refine would pin a transient layout.
    zoomAnchor = view ? captureViewportAnchor(view) : null;
  }
  // The burst is alive again — don't let the hold expire under it.
  if (zoomAnchorReleaseTimer !== null) {
    window.clearTimeout(zoomAnchorReleaseTimer);
    zoomAnchorReleaseTimer = null;
  }
  zoomTarget = target;
  updateZoomStatus(target);
  showZoomBadge(target);
  if (zoomCommitTimer !== null) window.clearTimeout(zoomCommitTimer);
  zoomCommitTimer = window.setTimeout(commitZoomGesture, ZOOM_COMMIT_DELAY_MS);
}

/** Zoom the ACTIVE editor by a delta (single-pane the window, multi-pane
 *  the focused pane) — accumulates onto any pending gesture target. */
function zoomActiveBy(deltaPct: number): void {
  zoomPreviewTo((zoomTarget ?? zoomStateForActive()) + deltaPct);
}

function zoomActiveReset(): void {
  // Reset is a single deliberate action — apply immediately (still badged
  // and anchored), cancelling any pending gesture.
  if (zoomCommitTimer !== null) {
    window.clearTimeout(zoomCommitTimer);
    zoomCommitTimer = null;
  }
  zoomTarget = null;
  // Mid-burst reset (rapid +/- then Reset): the previous commit's restore
  // may still be refining, so a FRESH capture here would pin a transient
  // layout — the exact trap the burst hold exists to avoid. Reuse the
  // held anchor when it belongs to this view; capture fresh only when
  // the gesture machinery is idle.
  if (zoomAnchor && zoomAnchor.view !== view) zoomAnchor = null;
  const anchor = zoomAnchor ?? (view ? captureViewportAnchor(view) : null);
  zoomAnchor = anchor;
  if (multiDocActive && multiDocZoomResetHook) {
    multiDocZoomResetHook();
  } else {
    setZoom(100);
  }
  showZoomBadge(100);
  hideZoomBadgeSoon();
  if (anchor) restoreViewportAnchor(anchor);
  releaseZoomAnchorSoon();
}

/** Chrome scale — the whole-page zoom analog of `setZoom`. Wired
 *  to Chromium's per-frame `webFrame.setZoomFactor` on Electron,
 *  so the chord behaves exactly the way the browser's built-in
 *  Ctrl-+ does (chrome + doc reflow uniformly). No-op on the web
 *  edition; the user has the browser's own zoom for that. */
function setChromeScale(pct: number): void {
  const clamped = Math.max(
    CHROME_SCALE_MIN_PCT,
    Math.min(CHROME_SCALE_MAX_PCT, Math.round(pct / 10) * 10),
  );
  settings.set('chromeScalePct', clamped);
}

function applyChromeScale(pct: number): void {
  const host = getElectronHost();
  if (!host) return;
  try {
    host.setZoomFactor(pct / 100);
  } catch (err) {
    console.warn('setZoomFactor failed:', err);
  }
}

/**
 * Push displaySizes into CSS custom properties on `#editor`. CSS rules
 * for each named style use `font-size: var(--pmd-size-<name>)`, so
 * updating these variables retypes the whole editor.
 */
function applyDisplaySizes(sizes: DisplaySizes): void {
  // Set on documentElement so the multi-pane shell's editors (which
  // aren't descendants of #editor) inherit the same custom props.
  // The single-doc #editor still inherits from documentElement, so
  // single-doc behavior is unchanged.
  for (const key of DISPLAY_SIZE_KEYS) {
    document.documentElement.style.setProperty(`--pmd-size-${key}`, `${sizes[key]}pt`);
    editorEl.style.setProperty(`--pmd-size-${key}`, `${sizes[key]}pt`);
  }
}

/**
 * Push typography flags onto `#editor` as classes (predicated CSS) and
 * as a CSS custom property for the box thickness. Each boolean either
 * adds or removes a class; CSS rules selector-gated on those classes
 * apply the corresponding decoration.
 */
/** Push the per-style alignment overrides as CSS custom properties on
 *  `#editor` + `:root` (the vars are only SET for non-default states;
 *  each style's CSS falls back to `start`). A paragraph's own
 *  alignment attr renders as an inline style and keeps winning. */
function applyStyleAlignments(a: StyleAlignments): void {
  const vars: Record<keyof StyleAlignments, string> = {
    tag: '--pmd-align-tag',
    paragraph: '--pmd-align-paragraph',
    cardBody: '--pmd-align-card-body',
    analyticBody: '--pmd-align-analytic-body',
    analytic: '--pmd-align-analytic',
    undertag: '--pmd-align-undertag',
    citeParagraph: '--pmd-align-cite',
  };
  for (const key of Object.keys(vars) as (keyof StyleAlignments)[]) {
    const value = a[key];
    for (const el of [editorEl, document.documentElement]) {
      if (value === 'default') el.style.removeProperty(vars[key]);
      else el.style.setProperty(vars[key], value);
    }
  }
}

/** Card content-visibility intrinsic-width sync state. Declared HERE
 *  (not next to its functions further down) because the boot-time
 *  `applyMaxTextWidth(...)` module-level call reaches
 *  `scheduleSyncCardIntrinsicWidth` during module evaluation — `let`
 *  declarations after that call site would still be in their temporal
 *  dead zone and throw (field error 2026-07-15). */
let lastCardIntrinsicWidth = -1;
let cardIntrinsicWidthRaf: number | null = null;
let cardIntrinsicWidthInstalled = false;

/** Cap + center the ProseMirror content column (accessibility "max
 *  text width"). 0 = off → the var is removed and layout is exactly
 *  the pre-feature CSS. Changing the cap changes the width cards lay
 *  out into, so the content-visibility intrinsic-width re-measures. */
function applyMaxTextWidth(px: number, align: 'center' | 'left' | 'right'): void {
  // margin-inline pair per column position; 'auto' (center) is also the
  // CSS fallback, inert while the cap is off.
  const margin = align === 'left' ? '0 auto' : align === 'right' ? 'auto 0' : 'auto';
  for (const el of [editorEl, document.documentElement]) {
    if (px > 0) {
      el.style.setProperty('--pmd-max-text-width', `${px}px`);
      el.style.setProperty('--pmd-max-text-margin', margin);
    } else {
      el.style.removeProperty('--pmd-max-text-width');
      el.style.removeProperty('--pmd-max-text-margin');
    }
  }
  scheduleSyncCardIntrinsicWidth();
}

function applyDisplayTypography(t: DisplayTypography): void {
  editorEl.classList.toggle('pmd-cite-underlined', t.citeUnderlined);
  editorEl.classList.toggle('pmd-underline-bold', t.underlineBold);
  // Predicate class for the NON-default state; base CSS keeps double.
  editorEl.classList.toggle('pmd-hat-underline-single', !t.hatUnderlineDouble);
  editorEl.classList.toggle('pmd-emphasis-bold', t.emphasisBold);
  editorEl.classList.toggle('pmd-emphasis-italic', t.emphasisItalic);
  editorEl.classList.toggle('pmd-emphasis-box', t.emphasisBox);
  editorEl.classList.toggle('pmd-undertag-italic', t.undertagItalic);
  editorEl.classList.toggle('pmd-undertag-bold', t.undertagBold);
  editorEl.style.setProperty('--pmd-emphasis-box-size', `${t.emphasisBoxSize}pt`);
  document.documentElement.style.setProperty('--pmd-emphasis-box-size', `${t.emphasisBoxSize}pt`);
  editorEl.style.setProperty('--pmd-pocket-box-size', `${t.pocketBoxSize}pt`);
  document.documentElement.style.setProperty('--pmd-pocket-box-size', `${t.pocketBoxSize}pt`);
  // 0 = the font's automatic thickness (the CSS keyword, not 0pt).
  const underlineSize = t.underlineSize > 0 ? `${t.underlineSize}pt` : 'auto';
  editorEl.style.setProperty('--pmd-underline-size', underlineSize);
  document.documentElement.style.setProperty('--pmd-underline-size', underlineSize);
  // Predicate class for the NON-default state; base CSS keeps the box.
  editorEl.classList.toggle('pmd-pocket-box-off', !t.pocketBox);
  document.documentElement.classList.toggle('pmd-pocket-box-off', !t.pocketBox);
  // Mirror the undertag/cite/emphasis flags to documentElement so the
  // ribbon's formatting-panel preview (which lives outside #editor)
  // can react to the same settings.
  document.documentElement.classList.toggle('pmd-undertag-italic', t.undertagItalic);
  document.documentElement.classList.toggle('pmd-undertag-bold', t.undertagBold);
  document.documentElement.classList.toggle('pmd-cite-underlined', t.citeUnderlined);
  document.documentElement.classList.toggle('pmd-underline-bold', t.underlineBold);
  document.documentElement.classList.toggle('pmd-hat-underline-single', !t.hatUnderlineDouble);
  document.documentElement.classList.toggle('pmd-emphasis-bold', t.emphasisBold);
  document.documentElement.classList.toggle('pmd-emphasis-italic', t.emphasisItalic);
  document.documentElement.classList.toggle('pmd-emphasis-box', t.emphasisBox);
  document.documentElement.style.setProperty('--pmd-emphasis-box-size', `${t.emphasisBoxSize}pt`);
}

/** Resolve the user's theme preference + the "apply theme to
 *  document" toggle into `data-theme` / `data-theme-doc`
 *  attributes on the document root. Light is the absence of a
 *  `data-theme` attribute (CSS defaults handle it). Dark mode
 *  toggles every `--pmd-c-*` token via the
 *  `:root[data-theme="dark"]` rule in style.css. When the
 *  theme is dark but `themeAppliesToDocument` is false, the
 *  editor scope re-declares the relevant tokens back to light
 *  so the document keeps its paper-like surface. */
function applyTheme(
  pref: 'light' | 'dark' | 'system',
  appliesToDocument: boolean,
): void {
  let effective: 'light' | 'dark';
  if (pref === 'system') {
    effective = window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  } else {
    effective = pref;
  }
  if (effective === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  if (effective === 'dark' && appliesToDocument) {
    document.documentElement.setAttribute('data-theme-doc', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme-doc');
  }
}

/** Listen for OS-level prefers-color-scheme changes so 'system'
 *  mode tracks them live. Set up once at boot. */
const systemDarkMedia = window.matchMedia('(prefers-color-scheme: dark)');
systemDarkMedia.addEventListener('change', () => {
  if (settings.get('theme') === 'system') {
    applyTheme('system', settings.get('themeAppliesToDocument'));
  }
});

/** Apply the `showDocNameChip` setting to `<html>`. The chip's CSS
 *  display is gated on this class — without it, the chip is
 *  force-hidden with `!important` and the ribbon resizer can't
 *  override it back on. Off by default.
 *
 *  Deliberately does NOT call `updateWindowTitle`: at boot this
 *  runs before `currentDocFilename`'s module-level declaration
 *  executes (the apply functions live near the top of the module;
 *  the per-doc state near the bottom), so reading it through
 *  `activeFile()` would throw a TDZ ReferenceError. The chip's
 *  text + `[hidden]` attribute are kept current by
 *  `updateWindowTitle` on every mount / save / open / focus
 *  change. */
function applyShowDocNameChip(on: boolean): void {
  document.documentElement.classList.toggle('pmd-doc-name-chip-on', on);
}

/** Apply the `reduceMotion` setting onto the document root as
 *  `data-motion`. CSS rules in `style.css` consume the attribute
 *  and gate animations / transitions. Three states:
 *    - 'auto'  → no attribute; the CSS uses the
 *               `prefers-reduced-motion` media query to follow the
 *               OS preference.
 *    - 'on'    → `data-motion="reduce"`; CSS unconditionally
 *               flattens animations and transitions.
 *    - 'off'   → `data-motion="normal"`; CSS keeps full motion
 *               even when the OS asks for reduced. */
function applyReduceMotion(pref: 'auto' | 'on' | 'off'): void {
  if (pref === 'on') {
    document.documentElement.setAttribute('data-motion', 'reduce');
  } else if (pref === 'off') {
    document.documentElement.setAttribute('data-motion', 'normal');
  } else {
    document.documentElement.removeAttribute('data-motion');
  }
}

/** Color-vision preset: `data-cvd="friendly"` gates the Okabe-Ito
 *  token blocks in style.css. Orthogonal to `data-theme` (composes
 *  with dark); hand-set Color overrides land as inline styles on
 *  documentElement and still beat the preset. */
function applyColorVision(on: boolean): void {
  if (on) document.documentElement.setAttribute('data-cvd', 'friendly');
  else document.documentElement.removeAttribute('data-cvd');
}

/** Annotation underline shapes: `data-annotation-shapes` gates the
 *  per-kind underlines in style.css (comment dotted, flashcard solid,
 *  AI dashed, note double; off = tint only). Orthogonal to the
 *  color-vision preset. */
function applyAnnotationShapes(on: boolean): void {
  if (on) document.documentElement.setAttribute('data-annotation-shapes', 'on');
  else document.documentElement.removeAttribute('data-annotation-shapes');
}

/** Background-color cue: `data-shading-cue="dots"` gates the faint
 *  dot grid on `span[data-shading]` in style.css, which mixes the
 *  dot color from the span's own `--sh` fill. */
function applyDistinguishShading(on: boolean): void {
  if (on) document.documentElement.setAttribute('data-shading-cue', 'dots');
  else document.documentElement.removeAttribute('data-shading-cue');
}

/** Timer panel edge: html class consumed by style.css — 'right'
 *  moves #timer-panel past the ribbon's right stack via flex order. */
function applyTimerPosition(pos: 'left' | 'right'): void {
  document.documentElement.classList.toggle('pmd-timer-right', pos === 'right');
}

/** Nav-pane analytic italics: an html class (same pattern as
 *  `pmd-nav-flat`) that italicizes analytic nav entries so they don't
 *  rely on the color cue — which dark mode and the flat nav both
 *  remove entirely. */
function applyNavAnalyticItalics(on: boolean): void {
  document.documentElement.classList.toggle('pmd-nav-analytic-italic', on);
}

/** Accessibility: cite-marked text at normal weight (display-only;
 *  export weight is untouched). On documentElement so the ribbon's
 *  style preview follows the same class. */
function applyUnboldCites(on: boolean): void {
  document.documentElement.classList.toggle('pmd-cite-unbold', on);
}

/** Steady text cursor: a body class that hides the native blinking
 *  caret; the italic-caret plugin then draws a steady caret in its
 *  place (CSS consumes the class). */
function applyCursorBlink(disabled: boolean): void {
  document.body.classList.toggle('pmd-steady-cursor', disabled);
}

/** Flip the app's icon set by setting `data-icons` on the document
 *  root; `icons.css` masks the modern SVGs under `"modern"` and
 *  falls back to the original emoji glyphs under `"classic"`. */
function applyIconSet(set: 'modern' | 'classic'): void {
  document.documentElement.dataset['icons'] = set;
}

function applyDisplayColors(c: DisplayColors): void {
  // Write to `--pmd-user-color-*`, NOT `--pmd-color-*`. style.css
  // resolves the effective `--pmd-color-*` from this user value plus
  // the theme layer (light → user color; dark chrome → built-in light
  // blue/green; dark document → user color unless apply-to-doc is on).
  // Writing `--pmd-color-*` directly would pin it past the theme and
  // make the dark-mode values dead. See the `--pmd-color-analytic`
  // cascade in style.css.
  for (const key of DISPLAY_COLOR_KEYS) {
    document.documentElement.style.setProperty(`--pmd-user-color-${key}`, c[key]);
  }
}

/** Apply the user's per-token color overrides as inline styles
 *  on documentElement. Inline style has the highest specificity,
 *  so an entry in `customColorOverrides` wins over the :root
 *  defaults AND over any future preset that sets the same
 *  variable via a body class. Tokens missing from the overrides
 *  blob get `removeProperty` so the cascade fallback kicks back
 *  in (cleanly restoring whichever preset / default applies). */
function applyCustomColorOverrides(
  overrides: Record<string, string>,
  knownTokens: readonly string[],
): void {
  const docEl = document.documentElement;
  for (const token of knownTokens) {
    if (Object.prototype.hasOwnProperty.call(overrides, token)) {
      docEl.style.setProperty('--' + token, overrides[token]!);
    } else {
      docEl.style.removeProperty('--' + token);
    }
  }
}

/** Apply the highlight + shading display-override settings.
 *  Toggles two body classes that the CSS rules in style.css gate
 *  on, and pushes the LAST slot's color into a CSS variable as
 *  the catch-all for source colors not in the ranked top-(N-1).
 *  With slots.length === 1, the entire override collapses to
 *  that single color (no ranking needed). The
 *  highlight-frequency plugin handles the per-color top-N-1
 *  rules via a dynamic stylesheet — see
 *  src/editor/highlight-frequency-plugin.ts. */
function applyHighlightShadingOverride(
  highlightOn: boolean,
  highlightSlots: string[],
  shadingOn: boolean,
  shadingSlots: string[],
): void {
  document.body.classList.toggle('pmd-override-highlight', highlightOn);
  document.body.classList.toggle('pmd-override-shading', shadingOn);
  // Catch-all variables: read by the static CSS rule. Last slot
  // doubles as the "everything not in top-(N-1)" bucket.
  document.documentElement.style.setProperty(
    '--pmd-c-override-highlight',
    highlightSlots[highlightSlots.length - 1] ?? '#ffff00',
  );
  document.documentElement.style.setProperty(
    '--pmd-c-override-shading',
    shadingSlots[shadingSlots.length - 1] ?? '#d2d2d2',
  );
}

/** CSS generic font categories — always available, picked by the
 *  browser per system. Don't quote these; quotes would turn them into
 *  literal font names that don't exist. */
const GENERIC_FONT_KEYWORDS = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
]);

function applyBodyFont(font: string): void {
  // Set font-family as an inline style directly. Quoted form for named
  // fonts (handles spaces and avoids ambiguity with CSS keywords);
  // unquoted form for generic categories. Inline style on #editor wins
  // over the stylesheet rule and inherits to all descendants.
  const head = GENERIC_FONT_KEYWORDS.has(font) ? font : `"${font}"`;
  const value = `${head}, 'Helvetica Neue', sans-serif`;
  editorEl.style.fontFamily = value;
  // Mirror to a CSS custom property on documentElement so the multi-
  // pane shell's editor surfaces (not descendants of #editor) can pick
  // up the body font via `font-family: var(--pmd-body-font)`.
  document.documentElement.style.setProperty('--pmd-body-font', value);
}

/** Apply the user's "Interface font" preference. Sets
 *  `--pmd-ui-font` on documentElement to the chosen family with a
 *  sans-serif fallback; an empty string clears the inline override
 *  so the stylesheet's `:root { --pmd-ui-font: <system stack> }`
 *  default kicks back in. */
function applyUiFont(font: string): void {
  const trimmed = font.trim();
  if (!trimmed) {
    document.documentElement.style.removeProperty('--pmd-ui-font');
    return;
  }
  const head = GENERIC_FONT_KEYWORDS.has(trimmed) ? trimmed : `"${trimmed}"`;
  document.documentElement.style.setProperty(
    '--pmd-ui-font',
    `${head}, sans-serif`,
  );
}

function applyLineHeight(_multiplier: number): void {
  // Sets each of the six per-paragraph-type line-height variables
  // from its corresponding setting, so every knob in the Settings
  // dialog flows through to the editor surface. Set on BOTH #editor
  // (single-doc) and documentElement (so the multi-pane shell's
  // editors inherit them).
  const s = settings.all();
  const pairs: [string, string][] = [
    ['--pmd-line-height', String(s.lineHeight)],
    ['--pmd-line-height-cite', String(s.lineHeightCite)],
    ['--pmd-line-height-tag', String(s.lineHeightTag)],
    ['--pmd-line-height-analytic', String(s.lineHeightAnalytic)],
    ['--pmd-line-height-heading', String(s.lineHeightHeading)],
    ['--pmd-line-height-undertag', String(s.lineHeightUndertag)],
  ];
  for (const [k, v] of pairs) {
    editorEl.style.setProperty(k, v);
    document.documentElement.style.setProperty(k, v);
  }
}

/** Push each per-style paragraph-spacing knob to its CSS variable
 *  (`--pmd-para-<style>-before` / `-after`, in pt). The `.pmd-*` margin
 *  rules read these, so the override flows straight to the editor and the
 *  multi-pane shell. */
function applyParagraphSpacing(): void {
  const s = settings.get('displayParagraphSpacing');
  for (const key of PARAGRAPH_SPACING_KEYS) {
    // 'pocketBefore' → '--pmd-para-pocket-before'
    const cssName = `--pmd-para-${key.replace(/(Before|After)$/, (m) => `-${m.toLowerCase()}`)}`;
    const value = `${s[key]}pt`;
    editorEl.style.setProperty(cssName, value);
    document.documentElement.style.setProperty(cssName, value);
  }
}

// Track the last applied ribbon-key override map so the settings
// subscriber can detect changes by reference and reconfigure the
// view's plugin stack only when bindings actually moved. We start
// with whatever the store has at boot — first subscriber call won't
// see a diff and won't reconfigure (the freshly-built view already
// has the current bindings baked in).
let lastRibbonOverrides = settings.get('ribbonKeyOverrides');
let lastKeyboardMacros = settings.get('keyboardMacros');
// Read-mode state is applied at boot (below) and on doc mount; the
// subscriber only re-applies it when it ACTUALLY changes. Tracked
// because `applyReadMode` dispatches a transaction that makes the
// read-mode plugin re-walk the doc to rebuild its hiding decorations —
// O(doc), so re-running it on every unrelated settings change would
// make every settings change lag on big docs.
let lastReadMode = settings.get('readMode');
let lastReadModeBorders = settings.get('hideEmphasisBordersInReadMode');
let lastReadModeParaIntegrity = settings.get('readModeParagraphIntegrity');
let lastMarkUnread = settings.get('markUnreadAfterMarker');
let lastNumberingDisplay = numberingDisplaySig();

/** Show/hide the chrome's optional clusters per their (default-off) settings:
 *  the dropzone pill and the Quick Cards button stack. Called from the settings
 *  subscriber AND once at boot — `settings.subscribe` does NOT fire on
 *  registration, so without the boot call the default-hidden state wouldn't take
 *  effect until the setting was next changed. */
function applyPillVisibility(): void {
  document.documentElement.classList.toggle(
    'pmd-dropzone-pill-hidden',
    !settings.get('showDropzonePill'),
  );
  document.documentElement.classList.toggle(
    'pmd-quickcards-hidden',
    !settings.get('showQuickCardButtons'),
  );
  document.documentElement.classList.toggle(
    'pmd-undoredo-hidden',
    !settings.get('showUndoRedoButtons'),
  );
  // Numbering cluster is on by default; hide it when the setting is off. The
  // class carries `!important` so it wins over the shrink waterfall.
  document.documentElement.classList.toggle(
    'pmd-numbering-hidden',
    !settings.get('showNumberingButtons'),
  );
  // The bottom scroll runway is gated on the WHOLE tray, not just the dropzone:
  // the send/receive pills (shown when pairing is enabled) occupy the same
  // bottom-left band, so the last line must clear them too. Applies in both
  // single-pane (#editor) and multi-pane (the anchored pane) — see the
  // `html.pmd-pill-tray-active … padding-bottom` rules in style.css.
  document.documentElement.classList.toggle(
    'pmd-pill-tray-active',
    settings.get('showDropzonePill') || settings.get('pairingEnabled'),
  );
}

// Apply read-mode visual state and editing lockdown whenever the
// setting changes (and once now to handle the persisted value).
settings.subscribe((s) => {
  applyTheme(s.theme, s.themeAppliesToDocument);
  applyShowDocNameChip(s.showDocNameChip);
  applyIconSet(s.iconSet);
  applyReduceMotion(s.reduceMotion);
  applyColorVision(s.colorVisionFriendly);
  applyAnnotationShapes(s.annotationShapes);
  applyDistinguishShading(s.distinguishShading);
  applyNavAnalyticItalics(s.navAnalyticItalics);
  applyUnboldCites(s.unboldCites);
  applyTimerPosition(s.timerPosition);
  applyCursorBlink(s.disableCursorBlink);
  // Multi-doc owns read mode per-pane: `settings.readMode` stays false
  // there even while a pane is reading, so routing a display-preference
  // change through `applyReadMode(s.readMode)` would dispatch
  // toggle-OFF into the focused pane's view — stripping its hide
  // decorations while the pane element keeps `pmd-read-mode`, i.e. read
  // mode showing every word of every card. The shell's own subscriber
  // re-stamps these classes per pane instead.
  if (
    !multiDocActive &&
    (s.readMode !== lastReadMode ||
      s.hideEmphasisBordersInReadMode !== lastReadModeBorders ||
      s.readModeParagraphIntegrity !== lastReadModeParaIntegrity)
  ) {
    lastReadMode = s.readMode;
    lastReadModeBorders = s.hideEmphasisBordersInReadMode;
    lastReadModeParaIntegrity = s.readModeParagraphIntegrity;
    applyReadMode(s.readMode);
  }
  // Nudge the mark-unread plugin to rebuild when its toggle flips (diff-gated
  // because the rebuild is O(doc); the plugin re-reads the setting itself).
  if (s.markUnreadAfterMarker !== lastMarkUnread) {
    lastMarkUnread = s.markUnreadAfterMarker;
    if (view) view.dispatch(view.state.tr.setMeta(MARK_UNREAD_TOGGLE, true));
  }
  // Card-numbering display changed (on/off, format, or indent): rebuild the
  // numbering decorations. The on/off gate is read live in the plugin's
  // decorations prop; format/indent bake into the set, so force a rebuild.
  const numberingSig = numberingDisplaySig();
  if (numberingSig !== lastNumberingDisplay) {
    lastNumberingDisplay = numberingSig;
    if (view) view.dispatch(view.state.tr.setMeta(NUMBERING_REFRESH, true));
  }
  applyNavPaneVisible(s.navPaneVisible);
  applyFormatNavPaneByType(s.formatNavPaneByType);
  // Body zoom is NOT re-applied on settings change — it's per-editor and
  // transient, and `defaultZoomPct` only governs what NEW editors open at,
  // never re-zooms an already-open one. Chrome scale stays a synced global.
  applyChromeScale(s.chromeScalePct);
  applyDisplaySizes(s.displaySizes);
  applyDisplayTypography(s.displayTypography);
  applyStyleAlignments(s.styleAlignments);
  applyMaxTextWidth(s.maxTextWidthPx, s.maxTextWidthAlign);
  applyDisplayColors(s.displayColors);
  applyHighlightShadingOverride(
    s.overrideHighlightColor,
    s.overrideHighlightSlots,
    s.overrideShadingColor,
    s.overrideShadingSlots,
  );
  applyCustomColorOverrides(
    s.customColorOverrides,
    CUSTOM_OVERRIDE_TOKEN_NAMES,
  );
  applyBodyFont(s.bodyFont);
  applyUiFont(s.uiFont);
  applyAskAiButtonVisibility(s.aiFeaturesEnabled);
  refreshFlashcardDueDot(); // the due-dot setting may have toggled
  renderCustomRibbonButtons(); // the custom-button config may have changed
  reapplyAllRibbonTooltips();
  pushNativeMenuBindings();
  applyPillVisibility();
  // Reposition the pill when it's toggled on (toggling doesn't resize
  // #app, so the ResizeObserver won't fire). rAF lets the display change
  // apply first. The editor's scroll runway is pure CSS (the editable's
  // padding-bottom, gated on the pill-hidden class), so it self-tracks.
  requestAnimationFrame(positionDropzone);
  applyLineHeight(s.lineHeight);
  applyParagraphSpacing();
  applyFormattingPanel(s.formattingPanelMode, s.formattingPanelPreview, s.showCharacterStyles);
  // Button states must re-sync when the panel is re-shown (the hidden mode
  // skips their computation entirely — see refreshFormattingPanelButtonStates).
  refreshFormattingPanelButtonStates();
  syncParagraphIntegrityBtn();
  syncNumberingButtons();
  // A settings change never edits the document, so the whole-doc word
  // count can't have changed — reuse the cached count (re-formatting the
  // read-time strings with the current readers) instead of re-walking the
  // whole doc on every toggle. `selectionOnly` is the "doc unchanged,
  // reuse the cache" path (it still counts a live selection, which is
  // O(range) and cheap).
  refreshWordCount({ selectionOnly: true });
  refreshFontSizeDisplay();
  refreshCursorColorDisplay();
  if (
    s.ribbonKeyOverrides !== lastRibbonOverrides ||
    s.keyboardMacros !== lastKeyboardMacros
  ) {
    lastRibbonOverrides = s.ribbonKeyOverrides;
    lastKeyboardMacros = s.keyboardMacros;
    if (view) {
      // Focused doc's uid so a reconfigure keeps the collab binding only when
      // the focused view is the session owner (multi-pane fusion guard).
      view.updateState(
        view.state.reconfigure({ plugins: buildEditorPlugins(activeDocIdentity().sessionUid) }),
      );
    }
  }
  // Editor spellcheck is handled by the viewport-spellcheck plugin,
  // which subscribes to `editorSpellcheck` itself — nothing to do here.
  // Nav-rail drag, zoom, display-size changes — anything that can
  // move the editor's available width — re-sync the card-intrinsic
  // CSS variable so skipped (content-visibility) cards stay the
  // right width.
  notifyEditorLayoutChanged();
});

/** ResizeObserver-driven progressive ribbon hiding. Watches the
 *  ribbon's intrinsic content width (`scrollWidth`) against its
 *  available width (`clientWidth`); when content overflows, hides
 *  the next panel in the priority list (least-essential first).
 *  When the ribbon grows, optimistically un-hides one panel and
 *  checks for overflow; if it fits, leaves it visible; otherwise
 *  hides it again. Converges in O(panel count) iterations.
 *
 *  Measured, not media-queried: panels hide only when they
 *  LITERALLY don't fit, at any chrome scale / OS font size /
 *  visible-panel-mix combination. */
function initRibbonResizer(): void {
  const ribbon = document.getElementById('ribbon');
  if (!ribbon) return;
  // Hide order from "least essential" to "most essential".
  // Each entry is the set of element IDs to hide/show together.
  // Adding a new group? Just append to this list.
  const panelIds: string[][] = [
    ['cite-panel'],              // (a) Character styles
    ['formatting-panel'],        // (b) Structural styles
    ['numbering-panel'],         // (c) Card numbering cluster — hide THIRD
    ['custom-ribbon-panel'],     // (d) User custom buttons
    ['doc-name-chip'],           // (d) Active-doc filename pill (opt-in)
    ['format-menu-panel'],       // (d) Table / image / sub / sup / strike
    ['doc-ops-panel'],           // (e) Paragraph integrity
    ['font-size-up-btn',         // (f) Font-size step buttons
     'font-size-down-btn'],
    ['color-panel'],             // (g) Highlight / shading / font color
                                 //     / font-size input + picker. Hiding
                                 //     the whole color-panel also covers
                                 //     the step buttons in (f), which is
                                 //     fine — display:none is idempotent.
    ['comments-ops-panel'],      // (h) Comments toggle + add-comment.
    ['open-btn', 'new-btn',      // (i) File ops: open, new, save,
     'export-btn', 'autosave-btn'], //     autosave-toggle.
    ['view-ops-panel'],          // (j) Read mode + nav-pane toggle.
    ['settings-btn',             // (k) Settings + keyboard-shortcuts
     'reference-btn'],           //     reference. Genuinely last —
                                 //     reaching them requires user
                                 //     intent and they don't compete
                                 //     for ribbon real estate during
                                 //     normal editing.
  ];
  let hideCount = 0;
  function setVisible(idx: number, visible: boolean): void {
    for (const id of panelIds[idx]!) {
      const el = document.getElementById(id);
      if (el) el.style.display = visible ? '' : 'none';
    }
  }
  // Reserve a small buffer between the rightmost visible panel
  // (in `.ribbon-left`) and the pinned-right elements (in
  // `.ribbon-right`, e.g. timer toggle). Without the buffer the
  // rightmost panel button can sit flush against the timer button
  // just before the next panel hides. The buffer matches the
  // column-gap inside a panel — same spacing intra-panel buttons
  // get from each other — so the visual rhythm reads as the same
  // unit on both sides.
  //
  // Can't piggyback on `scrollWidth > clientWidth + 1` for this:
  // `.ribbon-center` is `flex: 1 1 auto`, so when the ribbon
  // isn't actually overflowing, the center grows to fill remaining
  // space and `scrollWidth === clientWidth`. Subtracting a buffer
  // from `clientWidth` in that predicate would fire the overflow
  // trigger unconditionally and hide every panel. Instead, measure
  // the actual visual gap between `.ribbon-left`'s right edge and
  // `.ribbon-right`'s left edge, minus any visible center content
  // (doc-name chip) — that's the real free space and shrinks
  // monotonically as panels are added back.
  function measureIntraPanelGap(): number {
    for (const id of ['cite-panel', 'formatting-panel', 'color-panel']) {
      const el = document.getElementById(id);
      if (!el) continue;
      const cs = getComputedStyle(el);
      const raw = cs.columnGap === 'normal' ? cs.gap : cs.columnGap;
      const n = parseFloat(raw);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 4;
  }
  const overflowBuffer = measureIntraPanelGap();
  const leftSection = ribbon.querySelector<HTMLElement>('.ribbon-left');
  const rightSection = ribbon.querySelector<HTMLElement>('.ribbon-right');
  const centerSection = ribbon.querySelector<HTMLElement>('.ribbon-center');
  const isOverflowing = (): boolean => {
    if (!leftSection || !rightSection) {
      // Structure not present (shouldn't happen, but defensive):
      // fall back to the old true-overflow check.
      return ribbon.scrollWidth > ribbon.clientWidth + 1;
    }
    const leftRight = leftSection.getBoundingClientRect().right;
    const rightLeft = rightSection.getBoundingClientRect().left;
    let centerWidth = 0;
    if (centerSection) {
      for (const child of Array.from(centerSection.children)) {
        centerWidth += (child as HTMLElement).getBoundingClientRect().width;
      }
    }
    return rightLeft - leftRight - centerWidth < overflowBuffer;
  };
  let reflowing = false;
  function reflow(): void {
    if (reflowing) return;
    reflowing = true;
    try {
      // Hide more panels until the ribbon fits.
      while (hideCount < panelIds.length && isOverflowing()) {
        setVisible(hideCount, false);
        hideCount++;
      }
      // Try to bring panels back when there's room.
      while (hideCount > 0) {
        setVisible(hideCount - 1, true);
        if (isOverflowing()) {
          setVisible(hideCount - 1, false);
          break;
        }
        hideCount--;
      }
    } finally {
      reflowing = false;
    }
  }
  const observer = new ResizeObserver(reflow);
  observer.observe(ribbon);
  // ALSO observe the elements whose visibility can change while
  // the ribbon's own width stays constant (window-driven). When
  // the user toggles the timer panel or the doc-name chip, the
  // ribbon's `scrollWidth` jumps but `clientWidth` doesn't, so a
  // ribbon-only observer never fires. Observing these specific
  // elements catches the show / hide → 0 ↔ N transition and
  // re-runs the cascade.
  for (const id of ['timer-panel', 'doc-name-chip', 'custom-ribbon-panel', 'numbering-panel']) {
    const el = document.getElementById(id);
    if (el) observer.observe(el);
  }
  reflow();
}
initRibbonResizer();

applyTheme(settings.get('theme'), settings.get('themeAppliesToDocument'));
applyShowDocNameChip(settings.get('showDocNameChip'));
applyIconSet(settings.get('iconSet'));
applyReduceMotion(settings.get('reduceMotion'));
applyColorVision(settings.get('colorVisionFriendly'));
applyAnnotationShapes(settings.get('annotationShapes'));
applyDistinguishShading(settings.get('distinguishShading'));
applyNavAnalyticItalics(settings.get('navAnalyticItalics'));
applyUnboldCites(settings.get('unboldCites'));
applyTimerPosition(settings.get('timerPosition'));
applyPillVisibility(); // default-off dropzone pill + quick-card cluster, at boot
// Build the timer panel + button bindings. Visibility is gated
// on `timerVisible` (transient per-window setting); the panel
// stays hidden in the DOM until the user toggles ⏱ in the
// ribbon.
mountTimerUI();
// Audible timer alerts — this window competes for the shared audio-
// owner lock (the pop-out wins while it exists). No-op while the
// setting is off.
initTimerAudio();
// Undo / redo ribbon stack (showUndoRedoButtons setting; visibility
// via html.pmd-undoredo-hidden in applyPillVisibility). Operates on
// the focused pane's view; mousedown is swallowed so the click keeps
// the editor's selection and focus.
for (const [btnId, cmd] of [
  ['undo-btn', undo],
  ['redo-btn', redo],
] as const) {
  const btn = document.getElementById(btnId);
  if (!btn) continue;
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => {
    if (!view) return;
    cmd(view.state, view.dispatch.bind(view));
    view.focus();
  });
}

const timerToggleBtn = document.getElementById('timer-toggle-btn') as HTMLButtonElement | null;
if (timerToggleBtn) {
  function refreshTimerToggle(): void {
    const on = getTimerStateNow().visible;
    timerToggleBtn!.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  refreshTimerToggle();
  // Subscribe to TIMER state, not settings — visibility is part
  // of the shared timer state so it broadcasts across windows.
  subscribeTimer(refreshTimerToggle);
  timerToggleBtn.addEventListener('click', () => {
    setTimerVisible(!getTimerStateNow().visible);
  });
}

// Register every top-level ribbon button with the tooltip
// controller. Formatting / cite panel buttons were already
// registered earlier (in the formattingPanelBtnRefs loop). For
// buttons whose tooltip is state-aware (autosave shows different
// text when on / off), the corresponding state-update callback
// re-pokes the controller below so the new text flows through
// the current ribbonTooltipMode.
{
  const byId = (id: string): HTMLElement | null => document.getElementById(id);
  const button = (
    id: string,
    commandId: Parameters<typeof registerRibbonTooltip>[0]['commandId'],
    label?: string,
  ): void => {
    const el = byId(id);
    if (el) registerRibbonTooltip({ el, commandId, label });
  };
  button('open-btn', 'openFile');
  button('new-btn', 'newDocument');
  button('home-btn', 'goHome', 'Home');
  button('export-btn', 'save');
  button('settings-btn', 'openSettings');
  button('reference-btn', 'openShortcutsReference');
  button('read-mode-btn', 'toggleReadMode');
  button('reader-view-btn', 'toggleReaderView');
  button('comments-toggle-btn', 'toggleCommentsVisible');
  button('add-comment-btn', 'addCommentToSelection');
  button('create-flashcard-btn', 'createFlashcard', 'Create flashcard from selection');
  button('manage-flashcards-btn', 'manageFlashcards', 'Manage flashcards');
  button('ask-ai-btn', 'aiAskAboutSelection', 'Ask AI about selection');
  button('highlight-btn', 'applyHighlight');
  button('highlight-picker-btn', 'openHighlightPicker', 'Highlight color');
  button('shading-btn', 'applyShading');
  button('shading-picker-btn', 'openShadingPicker', 'Background color');
  button('fontcolor-btn', 'applyFontColor');
  button('fontcolor-picker-btn', 'openFontColorPicker', 'Font color');
  button('font-size-up-btn', 'adjustFontSizeUp');
  button('font-size-down-btn', 'adjustFontSizeDown');
  button('font-size-picker-btn', 'openFontSizePicker', 'Font size');
  button('doc-menu-btn', 'openDocToolsMenu', 'Document utilities');
  button('card-menu-btn', 'openCardToolsMenu', 'Card utilities');
  button('table-menu-btn', 'openTableMenu', 'Table operations');
  button('image-btn', 'insertImage');
  button('superscript-btn', 'toggleSuperscript');
  button('subscript-btn', 'toggleSubscript');
  button('strikethrough-btn', 'toggleStrikethrough');
  button('paragraph-integrity-btn', 'toggleParagraphIntegrity');
  button('num-role-btn', 'toggleNumberRole');
  button('num-sub-role-btn', 'toggleSubRole');
  button('num-restart-btn', 'toggleNumRestart');
  const numVisEl = byId('num-visibility-btn');
  if (numVisEl) registerRibbonTooltip({ el: numVisEl, label: 'Show or hide card numbering' });
  button(
    'plain-paste-toggle-btn',
    'pasteAsText',
    'Paste the clipboard as unformatted text',
  );
  button('new-speech-btn', 'newSpeechDocument');
  button('mark-active-as-speech-btn', 'markActiveAsSpeech');
  button('send-to-speech-cursor-btn', 'sendToSpeechAtCursor');
  button('send-to-speech-end-btn', 'sendToSpeechAtEnd');
  // Targets without a ribbon-command id — pass a label only.
  // Title appears in `tooltip` and `both` modes; absent in
  // `shortcut` (no shortcut to show) and `none`.
  const timerEl = byId('timer-toggle-btn');
  if (timerEl) registerRibbonTooltip({ el: timerEl, label: 'Show / hide the timer panel' });
  // Autosave is state-aware — start from whatever the HTML
  // initial-paint title is; the state-update site below
  // re-registers with the live state-derived text.
  const autosaveEl = byId('autosave-btn');
  if (autosaveEl) registerRibbonTooltip({ el: autosaveEl, label: autosaveEl.title || 'Autosave' });
}

applyReadMode(settings.get('readMode'));
// Open this window's editor at the configured default zoom (transient from here
// — the user can zoom this window independently of others, and it resets to the
// default on reload).
liveZoomPct = clampZoom(settings.get('defaultZoomPct'));
applyZoom(liveZoomPct);
applyChromeScale(settings.get('chromeScalePct'));
applyDisplaySizes(settings.get('displaySizes'));
applyDisplayTypography(settings.get('displayTypography'));
applyStyleAlignments(settings.get('styleAlignments'));
applyMaxTextWidth(settings.get('maxTextWidthPx'), settings.get('maxTextWidthAlign'));
applyDisplayColors(settings.get('displayColors'));
applyHighlightShadingOverride(
  settings.get('overrideHighlightColor'),
  settings.get('overrideHighlightSlots'),
  settings.get('overrideShadingColor'),
  settings.get('overrideShadingSlots'),
);
applyCustomColorOverrides(
  settings.get('customColorOverrides'),
  CUSTOM_OVERRIDE_TOKEN_NAMES,
);
applyBodyFont(settings.get('bodyFont'));
applyUiFont(settings.get('uiFont'));
applyLineHeight(settings.get('lineHeight'));
applyParagraphSpacing();
applyFormattingPanel(
  settings.get('formattingPanelMode'),
  settings.get('formattingPanelPreview'),
  settings.get('showCharacterStyles'),
);

// Claim browser shortcuts for every ribbon binding. F3 (Find), F5
// (Reload), F7 (Caret Browse), F11 (Fullscreen), Mod-U (View Source),
// and others normally trigger browser UI. We listen in the BUBBLE
// phase (no `{ capture: true }`) so the editor's PM keymap on
// `view.dom` gets first crack at the event — PM bails out via
// `eventBelongsToView` if `event.defaultPrevented` is already set,
// so a capture-phase preventDefault would silently disable our own
// keymap. By the time this handler fires:
//   - If PM matched a binding it already called preventDefault, and
//     we skip (avoids double-firing the command).
//   - If PM didn't match (binding absent OR editor unfocused), we
//     preventDefault to block the browser's built-in action and, if
//     the editor exists, dispatch the matching ribbon command
//     manually.
// We look up the key string against the ribbon registry up-front and
// only preventDefault when it's actually bound — so plain typing,
// Mod-Z, and other PM/browser defaults that we don't claim pass
// through untouched.
// Some keys are un-preventable in some browsers (F11 in Firefox; F5 /
// F12 in some Chromium builds) — a browser limitation the Electron
// build sidesteps entirely.
window.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) return;
  // Cheap early bail for typing: no modifier and not an F-key means
  // it can't be one of ours.
  if (!e.ctrlKey && !e.metaKey && !e.altKey && !/^F\d+$/.test(e.key)) return;
  const keyString = ribbonKeyStringFor(e);
  const cmdId = ribbonCommandForKey(
    keyString,
    settings.get('ribbonKeyOverrides'),
  );
  if (!cmdId) return;
  // A chord typed into a NATIVE text field (find bar, font-size box,
  // tag filter, a dialog input) must not dispatch view commands into
  // the document behind it (2026-07-27 focus audit: Cmd-B while
  // typing in the font-size input bolded the background doc). The
  // ProseMirror editor is contenteditable, not a native field, so
  // editor chords are unaffected; viewless file commands stay
  // available from fields — they act on the app, not the widget. No
  // preventDefault on the skip: the field keeps its native behavior.
  const targetTag = e.target instanceof HTMLElement ? e.target.tagName : '';
  const inNativeField =
    targetTag === 'INPUT' || targetTag === 'TEXTAREA' || targetTag === 'SELECT';
  if (inNativeField && !VIEWLESS_RIBBON_COMMANDS.has(cmdId)) return;
  e.preventDefault();
  // File-level commands (newDocument / openFile / saveAs) and the
  // shortcuts-dialog opener don't need a live view — invoke the
  // ctx side effect directly so the shortcut works even when no
  // pane has a doc open. Other commands still require a view
  // because they read state / dispatch transactions.
  if (VIEWLESS_RIBBON_COMMANDS.has(cmdId)) {
    runViewlessRibbon(cmdId);
    return;
  }
  if (!view) return;
  const cmd = getRibbonCommand(cmdId, ribbonContext);
  cmd(view.state, view.dispatch.bind(view), view);
});

// Mod+A with nothing editable focused (e.g. just alt-tabbed back, no click yet)
// would otherwise select the entire GUI. Capture phase so it runs before the
// editor; a no-op when focus is in the editor or any input, where the native /
// ProseMirror select-all still applies.
document.addEventListener('keydown', suppressGuiSelectAll, true);

/** Ribbon commands whose side effect doesn't read the doc / dispatch
 *  a transaction. Listed here so the global keydown handler can
 *  invoke them without a live view — single-doc startup is
 *  view-ful by the time this fires, but multi-doc with no panes
 *  open hits this path. */
const VIEWLESS_RIBBON_COMMANDS = new Set<AnyCommandId>([
  'newDocument',
  'openFile',
  'saveAs',
  'openShortcutsReference',
  // `newSpeechDocument` creates a fresh doc and routes it through a
  // slot — no source view required. The other three speech
  // commands DO need an active doc (a source for send, or the
  // focused doc for mark) so they stay gated on `view`.
  'newSpeechDocument',
  // Zoom modifies a persisted setting + a CSS variable on
  // documentElement — no doc dispatch required, so it works even
  // when multi-doc has zero panes open.
  'zoomIn',
  'zoomOut',
  'zoomReset',
  // Toggling the nav-pane visibility only flips a transient
  // setting + body class; works without an active doc.
  'toggleNavPane',
  // Home screen overlay — pure UI, no doc needed. Must be view-
  // less so it works in multi-pane with zero panes open.
  'goHome',
  // Quick-card search palette — opens browse-only without a doc, so
  // its Mod-Shift-Space binding must work view-less too.
  'openQuickCardSearch',
  'insertLiveZone',
  'insertSelfLiveZone',
  'insertInDocCopy',
  // Opens the Quick Cards manager overlay — no active doc required.
  'manageQuickCards',
  // Multi-pane workspace commands — fire on the shell, not a
  // doc. View-less so they work even when no slot has a doc.
  'focusSlot1',
  'focusSlot2',
  'focusSlot3',
  'sendDocToSlot1',
  'sendDocToSlot2',
  'sendDocToSlot3',
  'toggleSlotExpand',
  'cycleDocNext',
  'cycleDocPrev',
  'closeDocOrWindow',
  // Voice toggle flips a session, not a doc — works with no pane focused.
  'toggleVoice',
  // Pre-warming the Flow host spawns a process; no doc required.
  'startFlowHost',
  // Collaboration-session lifecycle operates on the app shell (state
  // swap, dialogs, clipboard) — the flows themselves fetch the view.
  'collabStartSession',
  'collabJoinSession',
  'collabCopyShareCode',
  'collabCopyInviteLink',
  'collabInviteStarred',
  'collabEndSession',
  'openDevConsole',
]);

function runViewlessRibbon(id: AnyCommandId): void {
  switch (id) {
    case 'newDocument': ribbonContext.newDocument(); return;
    case 'openFile': ribbonContext.openFile(); return;
    case 'save': ribbonContext.save(); return;
    case 'saveAs': ribbonContext.saveAs(); return;
    case 'toggleAutosave': ribbonContext.toggleAutosave(); return;
    case 'openShortcutsReference': ribbonContext.openShortcutsReference(); return;
    case 'newSpeechDocument': ribbonContext.newSpeechDocument(); return;
    case 'zoomIn': ribbonContext.zoomIn(); return;
    case 'zoomOut': ribbonContext.zoomOut(); return;
    case 'zoomReset': ribbonContext.zoomReset(); return;
    case 'toggleNavPane': ribbonContext.toggleNavPane(); return;
    case 'goHome': ribbonContext.goHome(); return;
    case 'openQuickCardSearch': ribbonContext.openQuickCardSearch(); return;
    case 'insertLiveZone': ribbonContext.insertLiveZone(); return;
    case 'insertSelfLiveZone': ribbonContext.insertSelfLiveZone(); return;
    case 'insertInDocCopy': ribbonContext.insertInDocCopy(); return;
    case 'manageQuickCards': ribbonContext.manageQuickCards(); return;
    case 'toggleVoice': ribbonContext.toggleVoice(); return;
    case 'startFlowHost': ribbonContext.startFlowHost(); return;
    case 'collabStartSession': ribbonContext.collabStartSession(); return;
    case 'collabJoinSession': ribbonContext.collabJoinSession(); return;
    case 'collabCopyShareCode': ribbonContext.collabCopyShareCode(); return;
    case 'collabCopyInviteLink': ribbonContext.collabCopyInviteLink(); return;
    case 'collabInviteStarred': ribbonContext.collabInviteStarred(); return;
    case 'openDevConsole': ribbonContext.openDevConsole(); return;
    case 'collabEndSession': ribbonContext.collabEndSession(); return;
    // Multi-pane workspace navigation. Each dispatches into the
    // shell via dynamic import — keeps single-doc bundles free
    // of the shell's deps. All no-op in single-doc mode (the
    // shell module-level state is null until the user enables
    // multi-doc).
    case 'focusSlot1': void runMultiPane('focusSlot', 0); return;
    case 'focusSlot2': void runMultiPane('focusSlot', 1); return;
    case 'focusSlot3': void runMultiPane('focusSlot', 2); return;
    case 'sendDocToSlot1': void runMultiPane('sendDocToSlot', 0); return;
    case 'sendDocToSlot2': void runMultiPane('sendDocToSlot', 1); return;
    case 'sendDocToSlot3': void runMultiPane('sendDocToSlot', 2); return;
    case 'toggleSlotExpand': void runMultiPane('toggleSlotExpand', 0); return;
    case 'cycleDocNext': void runMultiPaneCycle(1); return;
    case 'cycleDocPrev': void runMultiPaneCycle(-1); return;
    case 'closeDocOrWindow':
      void (async () => {
        const { tryCloseVisibleInFocusedSlot } = await import(
          './multi-pane-shell.js'
        );
        const consumed = await tryCloseVisibleInFocusedSlot();
        if (!consumed) await handleUserCloseRequest();
      })();
      return;
  }
}

/** Dispatch a ribbon command by id, the way the keyboard does:
 *  view-less commands run regardless of focus; the rest go through
 *  `runRibbon` (which no-ops when there's no active view). Used by the
 *  search palette's command source. */
function runRibbonCommandById(id: AnyCommandId): void {
  if (VIEWLESS_RIBBON_COMMANDS.has(id)) {
    runViewlessRibbon(id);
    return;
  }
  runRibbon(id);
}

/** Dispatch a multi-pane action by name. Single-doc returns
 *  silently. Encapsulated as a helper so the case bodies in
 *  `runViewlessRibbon` above stay tidy. */
async function runMultiPane(
  action: 'focusSlot' | 'sendDocToSlot' | 'toggleSlotExpand',
  slotIdx: 0 | 1 | 2,
): Promise<void> {
  const m = await import('./multi-pane-shell.js');
  switch (action) {
    case 'focusSlot':
      m.focusSlotByIndex(slotIdx);
      return;
    case 'sendDocToSlot':
      m.sendVisibleToSlotByIndex(slotIdx);
      return;
    case 'toggleSlotExpand':
      m.toggleFocusedSlotExpand();
      return;
  }
}

/** Cycle the focused slot's visible doc forward (+1) / back (-1). Bound by the
 *  rebindable `cycleDocNext` / `cycleDocPrev` commands (unbound by default).
 *  No-op outside multi-pane mode. */
async function runMultiPaneCycle(direction: 1 | -1): Promise<void> {
  const m = await import('./multi-pane-shell.js');
  m.cycleFocusedSlotDoc(direction);
}

// Wire the color panel (split buttons + swatch pickers). Pass a ref
// object so the panel reads the live view through `view.view` even
// when the EditorView gets re-mounted (e.g. on docx import).
colorPanel = wireColorPanel({ get view() { return view; } });

// Paragraph Integrity toggle — clicking flips the setting; the
// settings subscriber below mirrors the live value into the
// aria-pressed attribute so the CSS reflects state.
if (paragraphIntegrityBtn) {
  paragraphIntegrityBtn.addEventListener('mousedown', (e) => e.preventDefault());
  paragraphIntegrityBtn.addEventListener('click', () => {
    settings.set('paragraphIntegrity', !settings.get('paragraphIntegrity'));
  });
}
function syncParagraphIntegrityBtn(): void {
  if (!paragraphIntegrityBtn) return;
  const on = settings.get('paragraphIntegrity');
  paragraphIntegrityBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
}
syncParagraphIntegrityBtn();

// Numbering ribbon cluster: number / substructure / restart run the shared
// ribbon commands (skeleton edits); the fourth button toggles the numbers'
// visibility (`showCardNumbering`). `syncNumberingButtons` keeps the 1./a) faces
// matching the configured format and every button's pressed state matching the
// selection / setting — it's called from the same per-transaction + settings
// hooks as the formatting-panel and paragraph-integrity indicators.
const numRoleBtn = document.getElementById('num-role-btn') as HTMLButtonElement | null;
const numSubRoleBtn = document.getElementById('num-sub-role-btn') as HTMLButtonElement | null;
const numRestartBtn = document.getElementById('num-restart-btn') as HTMLButtonElement | null;
const numVisibilityBtn = document.getElementById('num-visibility-btn') as HTMLButtonElement | null;
// A nav-pane multi-selection of tag/analytic rows scopes the number/sub
// toggles to THOSE cards, as if they were selected in the editor. Routed
// through the active-panel resolver so it follows the focused pane in
// multi-pane mode; single selections return null (the editor caret wins).
registerNavNumberingScope(
  () => activeNavPanelResolver()?.selectedNumberingScope() ?? null,
);
for (const [btn, cmd] of [
  [numRoleBtn, 'toggleNumberRole'],
  [numSubRoleBtn, 'toggleSubRole'],
  [numRestartBtn, 'toggleNumRestart'],
] as const) {
  if (!btn) continue;
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => runRibbon(cmd));
}
if (numVisibilityBtn) {
  numVisibilityBtn.addEventListener('mousedown', (e) => e.preventDefault());
  numVisibilityBtn.addEventListener('click', () => {
    settings.set('showCardNumbering', !settings.get('showCardNumbering'));
  });
}
/** Last-written numbering button DOM state — these ran per transaction, so
 *  skip the textContent/attribute writes when nothing changed (A-01). */
const numBtnWritten = new Map<HTMLElement, string>();
function writeBtn(el: HTMLElement | null, face: string | null, pressed: boolean): void {
  if (!el) return;
  const key = `${face ?? ''}|${pressed}`;
  if (numBtnWritten.get(el) === key) return;
  numBtnWritten.set(el, key);
  if (face !== null) el.textContent = face;
  el.setAttribute('aria-pressed', pressed ? 'true' : 'false');
}
function syncNumberingButtons(chrome?: SelectionChrome | null): void {
  const faceNumber = numberingSampleGlyph('number');
  const faceSub = numberingSampleGlyph('sub');
  const visOn = settings.get('showCardNumbering');
  // Role / restart reflect the current selection's numbering state.
  if (!view) {
    writeBtn(numRoleBtn, faceNumber, false);
    writeBtn(numSubRoleBtn, faceSub, false);
    writeBtn(numRestartBtn, null, false);
    writeBtn(numVisibilityBtn, null, visOn);
    return;
  }
  const st = numberingSelectionState(
    view.state,
    chrome && !view.state.selection.empty ? chrome.units : undefined,
  );
  writeBtn(numRoleBtn, faceNumber, st.number);
  writeBtn(numSubRoleBtn, faceSub, st.sub);
  writeBtn(numRestartBtn, null, st.restart);
  writeBtn(numVisibilityBtn, null, visOn);
}
syncNumberingButtons();

// Paste Text button — routes through `runRibbon('pasteAsText')`, the same path
// as the F2 keymap: read the clipboard and paste it unformatted (Electron via
// host IPC; browser via the async Clipboard API, gated on this click as the
// user gesture). If a browser read is denied it falls back to arming the paste-
// plugin's flag, and `onArmedChange` mirrors that onto `aria-pressed` so the
// button lights up as the cue to press Ctrl/Cmd+V.
if (plainPasteToggleBtn) {
  plainPasteToggleBtn.addEventListener('mousedown', (e) => e.preventDefault());
  plainPasteToggleBtn.addEventListener('click', () => runRibbon('pasteAsText'));
  // Title is owned by the ribbon-tooltip controller (registered with the
  // `pasteAsText` command id above); it appends the keybinding in `both` /
  // `shortcut` modes. The HTML title is the initial-paint fallback.
}

// ---- Font-size input + dropdown ----

const FONT_SIZE_PRESETS = [4, 6, 8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 22, 24, 26, 28, 32, 36, 48, 72];

function commitFontSizeInput(): void {
  if (!fontSizeInput || !view) return;
  const raw = fontSizeInput.value.trim();
  if (raw === '' || raw === '—') {
    // No-op revert: re-sync from current cursor state.
    refreshFontSizeDisplay();
    return;
  }
  const pt = parseFloat(raw);
  if (!Number.isFinite(pt) || pt <= 0) {
    refreshFontSizeDisplay();
    return;
  }
  // Clamp to OOXML's sane range (1–409pt; 818 half-points is Word's cap).
  const clamped = Math.max(1, Math.min(409, pt));
  setFontSize(clamped, effectivePtForNode)(view.state, view.dispatch.bind(view));
  view.focus();
}

if (fontSizeInput) {
  fontSizeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitFontSizeInput();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      refreshFontSizeDisplay();
      fontSizeInput.blur();
    }
  });
  fontSizeInput.addEventListener('blur', () => {
    commitFontSizeInput();
  });
  // Focus highlights the current value so typing replaces it.
  fontSizeInput.addEventListener('focus', () => {
    fontSizeInput.select();
  });
}

let openFontSizePickerEl: HTMLElement | null = null;
function closeFontSizePicker(): void {
  if (!openFontSizePickerEl) return;
  openFontSizePickerEl.remove();
  openFontSizePickerEl = null;
  fontSizePickerBtn?.setAttribute('aria-expanded', 'false');
}

function openFontSizePicker(): void {
  if (!fontSizePickerBtn) return;
  if (openFontSizePickerEl) {
    closeFontSizePicker();
    return;
  }
  const picker = document.createElement('div');
  picker.className = 'pmd-font-size-picker';
  for (const pt of FONT_SIZE_PRESETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = String(pt);
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      if (view) setFontSize(pt, effectivePtForNode)(view.state, view.dispatch.bind(view));
      closeFontSizePicker();
      view?.focus();
    });
    picker.appendChild(btn);
  }
  document.body.appendChild(picker);
  const rect = fontSizePickerBtn.getBoundingClientRect();
  picker.style.top = `${rect.bottom + 2}px`;
  picker.style.left = `${rect.right - picker.offsetWidth}px`;
  openFontSizePickerEl = picker;
  fontSizePickerBtn.setAttribute('aria-expanded', 'true');

  const onDocPointerDown = (e: PointerEvent) => {
    if (!openFontSizePickerEl) return;
    const t = e.target as Node | null;
    if (t && (openFontSizePickerEl.contains(t) || fontSizePickerBtn.contains(t))) return;
    closeFontSizePicker();
    document.removeEventListener('pointerdown', onDocPointerDown);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeFontSizePicker();
      document.removeEventListener('pointerdown', onDocPointerDown);
      document.removeEventListener('keydown', onKey);
    }
  };
  document.addEventListener('pointerdown', onDocPointerDown);
  document.addEventListener('keydown', onKey);
}

if (fontSizePickerBtn) {
  fontSizePickerBtn.addEventListener('mousedown', (e) => e.preventDefault());
  fontSizePickerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openFontSizePicker();
  });
}

for (const [btn, delta] of [
  [fontSizeUpBtn, 1],
  [fontSizeDownBtn, -1],
] as const) {
  if (!btn) continue;
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => {
    if (!view) return;
    adjustFontSize(delta, effectivePtForNode)(view.state, view.dispatch.bind(view));
    view.focus();
  });
}

/** Update the status-bar cursor-color readout. It reports the ACTUAL
 *  stored colors on the run at the cursor, NOT the rendered colors.
 *  Two audiences: (a) the display overrides hide the stored colors, so
 *  the readout reveals what's encoded while an override is on; (b) the
 *  standalone `showCursorColorNames` accessibility toggle — highlight
 *  hues carry meaning in shared files, and this exposes that meaning
 *  as text for users who can't reliably tell the hues apart.
 *  Multi-pane: `view` is the focused pane's view (setActiveView), and
 *  the pane dispatch re-runs setActiveView per focused-pane
 *  transaction, so the readout tracks the caret there too. */
function refreshCursorColorDisplay(): void {
  const namesOn = settings.get('showCursorColorNames');
  const highlightOn = settings.get('overrideHighlightColor') || namesOn;
  const shadingOn = settings.get('overrideShadingColor') || namesOn;
  if (!highlightOn && !shadingOn) {
    cursorColorDisplay.hidden = true;
    return;
  }
  cursorColorDisplay.hidden = false;
  if (!view) {
    cursorColorText.textContent = '—';
    return;
  }
  const sel = view.state.selection;
  const marks = sel.$head.marks();
  let highlightName = '';
  let shadingHex = '';
  for (const m of marks) {
    if (m.type.name === 'highlight') {
      highlightName = String(m.attrs['color'] ?? '');
    } else if (m.type.name === 'shading') {
      shadingHex = String(m.attrs['color'] ?? '');
    }
  }
  const parts: string[] = [];
  if (highlightOn) {
    parts.push(
      `Hl: ${highlightName ? highlightColorLabel(highlightName) : 'none'}`,
    );
  }
  if (shadingOn) {
    parts.push(
      `Sh: ${shadingHex ? shadingColorLabel(shadingHex) : 'none'}`,
    );
  }
  cursorColorText.textContent = parts.join(' · ');
}

/** Is `markName` active across the current selection? Empty selection:
 *  the stored marks (if any) else the marks at the cursor. Range: the
 *  mark is present somewhere in the range. Mirrors prosemirror's standard
 *  `markActive`. */
function isMarkActiveInSelection(state: EditorState, markName: string): boolean {
  const type = state.schema.marks[markName];
  if (!type) return false;
  const sel = state.selection;
  if (sel.empty) {
    return !!type.isInSet(state.storedMarks || sel.$head.marks());
  }
  return state.doc.rangeHasMark(sel.from, sel.to, type);
}

/** Reflect the cursor's current style on the ribbon: each structural /
 *  character style button shows its toggled-on (aria-pressed) state when
 *  the cursor sits on text carrying that style. Cheap — reads the
 *  cursor's block type + marks (O(1)); safe to call on every transaction. */
function refreshFormattingPanelButtonStates(chrome?: SelectionChrome | null): void {
  if (!view) return;
  // Panel hidden → the buttons aren't visible; skip the mark computation.
  // The settings subscriber re-syncs states explicitly when the mode
  // changes back, so nothing shows stale on re-show.
  if (settings.get('formattingPanelMode') === 'hidden') return;
  const state = view.state;
  const $from = state.selection.$from;
  // Clicking between blocks lands a gap cursor (or a node selection) whose
  // parent is a non-textblock with no marks. The visible caret hasn't
  // moved into new text, so leave the indicator on the last real run's
  // style instead of blanking every button.
  if (!$from.parent.isTextblock) return;
  const blockType = $from.parent.type.name;
  const useChrome = chrome && !state.selection.empty ? chrome : null;
  for (const { id, btn } of formattingPanelBtnRefs) {
    let active = false;
    const wantBlock = FORMATTING_PANEL_ACTIVE_BLOCK[id];
    if (wantBlock) {
      active = blockType === wantBlock;
    } else {
      const wantMarks = FORMATTING_PANEL_ACTIVE_MARKS[id];
      if (wantMarks) {
        active = useChrome
          ? wantMarks.some((m) => useChrome.markActive[m])
          : wantMarks.some((m) => isMarkActiveInSelection(state, m));
      }
    }
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

function refreshFontSizeDisplay(chrome?: SelectionChrome | null): void {
  if (!fontSizeInput || !fontSizeControlEl) return;
  // Don't clobber the user's in-progress edit — only sync the input
  // value when it isn't focused.
  if (document.activeElement === fontSizeInput) return;
  if (!view) {
    fontSizeInput.value = '—';
    fontSizeControlEl.classList.remove('pmd-font-size-direct');
    return;
  }
  const info =
    chrome && !view.state.selection.empty
      ? chrome.font
      : effectiveFontSizeForDisplay(view.state);
  fontSizeInput.value = info.pt == null ? '—' : formatPt(info.pt);
  // Red when every contributing run derives its size from an explicit
  // `font_size` mark; black when bare or driven by a named-style mark.
  fontSizeControlEl.classList.toggle(
    'pmd-font-size-direct',
    info.pt != null && info.direct,
  );
}

function formatPt(pt: number): string {
  // Drop the trailing ".0" for whole numbers; otherwise show one decimal.
  return Number.isInteger(pt) ? `${pt}` : pt.toFixed(1);
}

interface FontSizeInfo {
  /** Effective size in pt, or `null` when the selection spans mixed sizes. */
  pt: number | null;
  /** True iff every contributing run derives its size from an explicit
   *  `font_size` mark. False when any run is bare or named-style-derived. */
  direct: boolean;
}

/**
 * Effective font-size (in pt) for a paragraph that has no run-level
 * size cues. Reads from the live `displaySizes` setting so all
 * downstream consumers reflect user-customized per-style sizes.
 */
function paragraphDefaultPt(parentName: string): number {
  const sizes = settings.get('displaySizes');
  switch (parentName) {
    case 'pocket': return sizes.pocket;
    case 'hat': return sizes.hat;
    case 'block': return sizes.block;
    case 'tag': return sizes.tag;
    case 'analytic': return sizes.analytic;
    case 'undertag': return sizes.undertag;
    default: return sizes.normal;
  }
}

/**
 * Effective font-size for a single text run, with the same precedence
 * the chip / increment buttons / display logic all use:
 *   1. `font_size` mark on the run → that value (and `direct: true`).
 *   2. Named-style mark on the run (cite_mark, underline_mark, etc.)
 *      → the corresponding per-style size from displaySizes.
 *   3. Otherwise → the parent paragraph's natural size.
 */
function ptForRun(text: PMNode, parent: PMNode): { pt: number; direct: boolean } {
  const fs = text.marks.find((m) => m.type.name === 'font_size');
  if (fs) {
    return { pt: Number(fs.attrs['halfPoints'] ?? 22) / 2, direct: true };
  }
  const sizes = settings.get('displaySizes');
  for (const m of text.marks) {
    switch (m.type.name) {
      case 'cite_mark': return { pt: sizes.cite, direct: false };
      case 'underline_mark': return { pt: sizes.underline, direct: false };
      case 'emphasis_mark': return { pt: sizes.emphasis, direct: false };
      case 'undertag_mark': return { pt: sizes.undertag, direct: false };
      case 'analytic_mark': return { pt: sizes.analytic, direct: false };
    }
  }
  return { pt: paragraphDefaultPt(parent.type.name), direct: false };
}

/**
 * Resolver used by `adjustFontSize` to pick a per-run starting size
 * when the run has no explicit `font_size` mark. `node === null`
 * means "no adjacent text" — fall through to the parent default.
 */
export function effectivePtForNode(node: PMNode | null, parent: PMNode): number {
  if (node && node.isText) return ptForRun(node, parent).pt;
  return paragraphDefaultPt(parent.type.name);
}

function effectiveFontSizeForDisplay(state: EditorState): FontSizeInfo {
  const sel = state.selection;
  if (sel.empty) {
    const $pos = sel.$from;
    const parent = $pos.parent;
    if (!parent.isTextblock) return { pt: null, direct: false };
    // PM's effective marks at the cursor: storedMarks (if set) override
    // the marks at the cursor position. Otherwise `$pos.marks()`
    // resolves correctly for both the mid-run case (returns the
    // containing text node's marks) and the boundary case (returns the
    // left-neighbor's marks, matching the "next typed char extends
    // left" semantics). A `parent.child(idx-1)` lookup would confuse
    // the two cases — for a cursor INSIDE an 11pt run that follows an
    // 8pt run it returns the 8pt run as the "before" node, so the
    // chip would report 8pt even though the cursor isn't there.
    const marks = state.storedMarks ?? $pos.marks();
    const fs = marks.find((m) => m.type.name === 'font_size');
    if (fs) return { pt: Number(fs.attrs['halfPoints'] ?? 22) / 2, direct: true };
    const sizes = settings.get('displaySizes');
    for (const m of marks) {
      switch (m.type.name) {
        case 'cite_mark': return { pt: sizes.cite, direct: false };
        case 'underline_mark': return { pt: sizes.underline, direct: false };
        case 'emphasis_mark': return { pt: sizes.emphasis, direct: false };
        case 'undertag_mark': return { pt: sizes.undertag, direct: false };
        case 'analytic_mark': return { pt: sizes.analytic, direct: false };
      }
    }
    return { pt: paragraphDefaultPt(parent.type.name), direct: false };
  }

  // Non-empty: one implementation — the fused selection walk (asked for
  // zero marks here; direct fallback callers only need the font answer).
  return computeSelectionChrome(state, [], ptForRun).font;
}

/** Cached whole-doc read-aloud word count. Recomputed only when the
 *  doc changes (the O(doc) walk); reused when the selection collapses
 *  back to a cursor so a selection change never re-walks the whole doc
 *  just to restore the whole-doc readout. */
let lastWholeDocWords: ReadAloudCounts | null = null;

function refreshWordCount(opts?: { selectionOnly?: boolean }): void {
  // In multi-doc mode the shared status-bar word counter is hidden
  // (each pane shows its own in its footer). Skip the O(doc-size)
  // walk entirely — it's pure waste; the result lands in an
  // element that's `display: none`.
  if (multiDocActive) return;
  if (!view) {
    wordCountText.textContent = '—';
    return;
  }
  const sel = view.state.selection;
  // Selection-aware readout is opt-in (`liveSelectionWordCount`). When
  // off, the bar always shows the whole-doc count regardless of any
  // selection — the Word Count button covers selection counts on demand.
  const hasSelection = settings.get('liveSelectionWordCount') && !sel.empty;
  let counts: ReadAloudCounts;
  if (hasSelection) {
    // Selection read time: count only the selected range (O(range)).
    // Leaves the cached whole-doc count untouched.
    counts = countReadAloudSplit(view.state.doc, sel.from, sel.to);
  } else if (opts?.selectionOnly && lastWholeDocWords !== null) {
    // Selection just collapsed to a cursor on a selection-only
    // transaction: the whole-doc count can't have changed, so reuse the
    // cache instead of re-walking the doc on every cursor move.
    counts = lastWholeDocWords;
  } else {
    counts = countReadAloudSplit(view.state.doc);
    lastWholeDocWords = counts;
  }
  const words = totalWords(counts);

  const readers = settings.get('readers').slice(0, 2);
  // With the container segment enabled the whole-doc side gets a "Doc:"
  // label so the two sides read symmetrically ("Doc: … | Card: …");
  // with it off, the readout is exactly the pre-feature bare number.
  const head = hasSelection
    ? `Selection: ${formatNumber(words)}`
    : settings.get('liveContainerReadTime')
      ? `Doc: ${formatNumber(words)}`
      : formatNumber(words);
  const parts = [head];
  for (const r of readers) {
    parts.push(`${r.name}: ${formatReadTimeFor(counts, r)}`);
  }
  // Segments are pipe-joined in scope order — whole doc, the enclosing
  // container, what's left — and each is independently optional, so the
  // join filters rather than nesting conditionals (container off with
  // remaining on reads "Doc: … | Left: …").
  const segments = [
    parts.join(' · '),
    liveContainerSegment(view.state),
    remainingReadSegment(view.state),
  ].filter((s): s is string => s !== null);
  wordCountText.textContent = segments.join(' | ');
}

/**
 * Single-doc read-mode application. Read mode is conceptually
 * per-doc — in multi-doc mode each pane owns its own read-mode
 * state via the shell — and the single-doc surface just happens
 * to have exactly one doc, so the `settings.readMode` setting
 * drives this one editor's read-mode flag.
 */
/** Reading view is per-doc SESSION state (never a setting): module
 *  flag in single-doc; the multi-pane shell keeps a per-record flag
 *  and installs a focused-doc resolver for the ribbon button. */
let readerViewOn = false;
let multiDocToggleReaderView: (() => void) | null = null;
let readerViewStateForActive: () => boolean = () => readerViewOn;

export function setMultiDocToggleReaderView(fn: (() => void) | null): void {
  multiDocToggleReaderView = fn;
}

export function setReaderViewStateResolver(resolver: () => boolean): void {
  readerViewStateForActive = resolver;
  refreshReaderViewBtn();
}

export function refreshReaderViewBtn(): void {
  readerViewBtn?.classList.toggle('pmd-active', readerViewStateForActive());
}

function toggleReaderViewCommand(): void {
  if (multiDocActive && multiDocToggleReaderView) {
    multiDocToggleReaderView();
  } else if (view) {
    readerViewOn = !readerViewOn;
    applyReaderViewToTarget(editorEl, view, readerViewOn);
  }
  refreshReaderViewBtn();
}

function applyReadMode(on: boolean): void {
  // Read mode collapses most of the document; capture what's at the top of
  // the viewport so we can pin it back afterward (§ scroll-anchor) — UNLESS
  // the user prefers the toggle to jump to the doc top, which the
  // `toggleReadMode` command handles and our restore would otherwise fight.
  const anchor =
    view && !settings.get('jumpToDocTopOnReadModeToggle')
      ? captureViewportAnchor(view, { readMode: true })
      : null;
  editorEl.classList.toggle('pmd-read-mode', on);
  editorEl.classList.toggle(
    'pmd-rm-no-emphasis-borders',
    on && settings.get('hideEmphasisBordersInReadMode'),
  );
  editorEl.classList.toggle(
    'pmd-rm-para-integrity',
    on && settings.get('readModeParagraphIntegrity'),
  );
  if (!multiDocActive) refreshReadModeBtn();
  if (view) {
    // Read mode keeps the editor EDITABLE so the caret stays placeable
    // (for dropping a reading-position marker); edits are blocked by the
    // read-mode plugin's filterTransaction instead.
    view.setProps({ editable: () => true });
    // Send the new state to the read-mode plugin so it (re)builds
    // its text-hiding decoration set. The meta value IS the
    // desired on/off state — the plugin stores it as its own
    // local state rather than re-reading the global setting,
    // which is what lets multi-doc keep read mode per-pane.
    view.dispatch(view.state.tr.setMeta(PMD_READ_MODE_TOGGLE, on));
  }
  if (anchor) restoreViewportAnchor(anchor);
}

/**
 * Apply read-mode visuals + editability + plugin re-render to a
 * SPECIFIC editor surface — same logic as `applyReadMode` above,
 * just parameterised on the host element and view so the multi-pane
 * shell can call it per pane without going through the
 * `settings.readMode` global.
 */
export function applyReadModeToTarget(
  hostEl: HTMLElement,
  targetView: EditorView,
  on: boolean,
  hideEmphasisBorders: boolean,
  readParagraphIntegrity: boolean,
): void {
  const anchor = settings.get('jumpToDocTopOnReadModeToggle')
    ? null
    : captureViewportAnchor(targetView, { readMode: true });
  hostEl.classList.toggle('pmd-read-mode', on);
  hostEl.classList.toggle('pmd-rm-no-emphasis-borders', on && hideEmphasisBorders);
  hostEl.classList.toggle('pmd-rm-para-integrity', on && readParagraphIntegrity);
  // Stay editable so the caret is placeable; edits are blocked by the
  // read-mode plugin's filterTransaction.
  targetView.setProps({ editable: () => true });
  targetView.dispatch(targetView.state.tr.setMeta(PMD_READ_MODE_TOGGLE, on));
  if (anchor) restoreViewportAnchor(anchor);
}

/**
 * Replace the resolver used by `refreshReadModeBtn`. In single-doc
 * the default (read `settings.readMode`) is fine; the multi-pane
 * shell calls this at boot to install a focused-pane resolver.
 */
export function setReadModeStateResolver(resolver: () => boolean): void {
  readModeStateForActive = resolver;
  // Resolver change implies the source-of-truth changed (e.g., the
  // multi-pane shell just installed its focused-pane resolver) —
  // refresh the button so it reflects the new answer.
  refreshReadModeBtn();
}

/**
 * Replace the resolver used by `refreshAutosaveBtn`. Mirrors
 * `setReadModeStateResolver` — single-doc reads the (transient)
 * setting; multi-pane installs a focused-DocRecord resolver so the
 * autosave toggle reflects per-pane state. */
export function setAutosaveStateResolver(resolver: () => boolean): void {
  autosaveStateForActive = resolver;
  refreshAutosaveBtn();
}

function refreshReadModeBtn(): void {
  readModeBtn.classList.toggle('pmd-active', readModeStateForActive());
}

const navPanel = new NavigationPanel(navEl);

/** The single-doc NavigationPanel instance — the mobile shell drives
 *  its destination mode ("Send to…") and hosts it in the drawer. */
export function getNavPanel(): NavigationPanel {
  return navPanel;
}

function makeStarterDoc(): PMNode {
  const n = schema.nodes;
  const m = schema.marks;
  // Shorthand factories. Marks-on-text uses ProseMirror's array-of-
  // marks form; nodes get an `id` only where the schema requires
  // one for stable heading IDs (per ARCHITECTURE.md §4).
  const t = (text: string, marks?: ReturnType<(typeof m)[string]['create']>[]) =>
    marks && marks.length ? schema.text(text, marks) : schema.text(text);
  const para = (...children: PMNode[]) => n['paragraph']!.create(null, children);
  const paraText = (text: string) => n['paragraph']!.create(null, schema.text(text));
  /** Indented body paragraph (0.5" = 720 dxa). Used for the F-key
   *  shortcut list so it visually reads as a sub-block under the
   *  surrounding prose. */
  const paraIndented = (text: string) =>
    n['paragraph']!.create({ indent: 720 }, schema.text(text));
  /** Empty paragraph spacer — gives a blank line between content
   *  blocks so the onboarding doc reads less wall-of-text. */
  const blank = () => n['paragraph']!.create(null);

  return n['doc']!.createChecked(null, [
    n['pocket']!.create({ id: newHeadingId() }, schema.text('Welcome to CardMirror')),
    paraText(
      'CardMirror is an editor for debate evidence that reads and writes the same Word .docx files as Verbatim. The boxed heading above is a Pocket — Verbatim\'s name for a top-level section. Everything below is live: type in it, edit it, and try the shortcuts as you go.',
    ),
    blank(),
    paraText(
      'This guide writes "Mod" for your main modifier key: Ctrl on Windows and Linux, ⌘ on macOS.',
    ),
    blank(),

    // Section 1: Try it
    n['hat']!.create({ id: newHeadingId() }, schema.text('1. Open your own files')),
    paraText(
      'Click 📂 in the ribbon to open a real Verbatim file. CardMirror renders its styles and structure faithfully; Save As (💾, or Mod-Shift-S) writes back a Verbatim-native .docx.',
    ),
    blank(),
    paraText(
      'CardMirror keeps crash-recovery journals of unsaved work, but save early anyway — a real .docx on disk is what Verbatim and your teammates can open.',
    ),
    blank(),

    // Section 2: Structural styles
    n['hat']!.create({ id: newHeadingId() }, schema.text('2. Structural styles')),
    paraText(
      'CardMirror uses Verbatim\'s four heading levels — Pocket, Hat, Block, Tag — plus Analytics and Undertags. Each has a function key (rebindable in Settings → Keyboard shortcuts):',
    ),
    blank(),
    paraIndented('F4 = Pocket'),
    paraIndented('F5 = Hat'),
    paraIndented('F6 = Block'),
    paraIndented('F7 = Tag'),
    paraIndented('Mod-F7 = Analytic'),
    paraIndented('Mod-F8 = Undertag'),
    blank(),
    paraText(
      'Put the cursor in a paragraph and press the key to convert it; a selection converts every paragraph it touches. F12 clears back to plain text.',
    ),
    blank(),

    n['block']!.create({ id: newHeadingId() }, schema.text('Blocks group related cards under a Hat')),
    paraText(
      'Loose paragraphs like this one can sit anywhere. A paragraph typed right after a card is absorbed into it as body text; start a heading to break out.',
    ),

    n['card']!.create(null, [
      n['tag']!.create({ id: newHeadingId() }, schema.text('Cards are the unit of evidence — the Tag goes on top')),
      n['undertag']!.create(null, schema.text('Undertags (Mod-F8) annotate the tag — qualifiers or sub-claims.')),
      n['cite_paragraph']!.create(null, [
        t('John '),
        t('Smith 24', [m['cite_mark']!.create()]),
        t(', Professor of Climate Science at Yale University, "Title of the Source," '),
        t('Publication Name', [m['italic']!.create()]),
        t(', 9/23/2024, '),
        t('https://example.com', [m['link']!.create({ href: 'https://example.com' })]),
      ]),
      n['card_body']!.create(null, [
        t('The body holds the evidence text. '),
        t('F9 underlines', [m['underline_mark']!.create()]),
        t(', '),
        t('F10 emphasizes', [m['emphasis_mark']!.create()]),
        t(', and '),
        t('F11 highlights', [m['highlight']!.create({ color: 'yellow' })]),
        t(' (F9 and F11 toggle; F10 is apply-only). Mod-8 shrinks the un-underlined text for reading. The cite mark (F8) is on "Smith 24" above.',
        ),
      ]),
    ]),
    blank(),

    n['analytic_unit']!.create(null, [
      n['analytic']!.create(
        { id: newHeadingId() },
        schema.text('Analytics (Mod-F7) hold standalone analysis — claims with no card behind them.'),
      ),
      n['card_body']!.create(
        null,
        schema.text(
          'Like a card, an analytic absorbs the paragraphs below it as one block.',
        ),
      ),
    ]),
    blank(),

    // Section 3: Moving things around
    n['hat']!.create({ id: newHeadingId() }, schema.text('3. Moving things around')),
    paraText(
      'The nav pane on the left is your outline. Click an entry to jump to it; double-click to fold its sub-tree. The 1 · 2 · 3 · 4 buttons set how deep the outline goes.',
    ),
    blank(),
    paraText(
      'Drag a nav entry to reorder — it carries the whole heading and its contents. Mod-click and Shift-click extend the selection; hold Ctrl (Alt on macOS) while dragging to copy instead of move.',
    ),
    blank(),
    paraText(
      'To drag a card straight from the page, hold Mod-Shift-Alt and drag it. Drops are schema-aware: invalid targets don\'t light up.',
    ),
    blank(),

    // Section 4: Read mode
    n['hat']!.create({ id: newHeadingId() }, schema.text('4. Read mode')),
    paraText(
      'Click 👁️ to read at the podium. Everything but Tags, Cites, Analytics, and highlighted text hides, and typing is locked out so a stray key can\'t edit the doc. Click 👁️ again or press Esc to exit.',
    ),
    blank(),
    paraText(
      'The status bar shows live read-time estimates for your top two readers. Set their names and words-per-minute in ⚙ → General → "Readers for read-time estimates".',
    ),
    blank(),

    // Section 5: Three-pane workspace
    n['hat']!.create({ id: newHeadingId() }, schema.text('5. Three-pane workspace')),
    paraText(
      'Turn on ⚙ → General → "Three-pane workspace" for three side-by-side slots, each with its own outline, footer, and back/forward history (toggling reloads the editor). Mod-1 / Mod-2 / Mod-3 focus them.',
    ),
    blank(),
    paraText(
      'Drag a card or heading from one slot to another to copy it across — the source keeps its copy. Comments are off while multi-doc is on.',
    ),
    blank(),

    // Section 6: Learn
    n['hat']!.create({ id: newHeadingId() }, schema.text('6. Study your evidence')),
    paraText(
      'CardMirror can turn evidence into spaced-repetition flashcards. They live only on your machine — they never travel with a .docx you share. Select some text and use Create Flashcard to anchor a question-and-answer or cloze card to it; anchored cards show up in the comments column beside the text they came from.',
    ),
    blank(),
    paraText(
      'The Home screen\'s Learn section runs your due reviews. With AI features on, CardMirror can draft cards for you too.',
    ),
    blank(),

    // Section 7: Collaboration
    n['hat']!.create({ id: newHeadingId() }, schema.text('7. Share and co-edit')),
    paraText(
      'In the desktop app, CardMirror machines can send cards to each other and co-edit documents live — both end-to-end encrypted. Turn on Enable collaboration in ⚙ → Collaboration to get your pairing code and the Send / Receive pills, then swap codes with teammates to send cards straight to their machines.',
    ),
    blank(),
    paraText(
      'For live co-editing, click the Send pill and press the invite button on a recipient — or run Start Collaboration Session from the command bar and share the code it copies. Up to 10 people type in one document with live cursors, and everyone keeps their copy when the session ends.',
    ),
    blank(),
    paraText(
      'On the official relay these features require a linked paid Debate Decoded membership (⚙ → Collaboration).',
    ),
    blank(),

    // Section 8: Settings
    n['hat']!.create({ id: newHeadingId() }, schema.text('8. Make it yours')),
    paraText(
      'Click ⚙ for Settings and 📖 for the full keyboard reference any time.',
    ),
    blank(),

    // Outro — its own hat: field reports say the tour-off toggle was
    // undiscoverable buried as a trailing paragraph, so it gets a
    // heading the nav pane surfaces.
    n['hat']!.create({ id: newHeadingId() }, schema.text('Done with the tour?')),
    paraText(
      'Turn off ⚙ → Files → "Onboarding doc for new documents" and new documents will open blank. When you\'re ready, open a .docx with 📂 — or just start editing this one. Welcome aboard!',
    ),
  ]);
}

/** Build a doc with no content beyond a single empty paragraph.
 *  Used when the user has turned the onboarding starter off — new
 *  docs and newly spawned windows mount this instead of the
 *  welcome guide. */
function makeBlankNewDoc(): PMNode {
  // Shared with the three-pane shell's New — one definition so the two
  // modes' blank docs cannot drift.
  return makeBlankDoc();
}

/** Mobile-view onboarding doc — the desktop starter is all ribbon
 *  buttons, F-keys, and Mod-chords, none of which exist in the touch UI.
 *  This one introduces the actual mobile affordances (the ☰ outline, the
 *  ⋮ menu, the Read/Move/Repair mode bar). */
function makeMobileStarterDoc(): PMNode {
  const n = schema.nodes;
  const paraText = (text: string) => n['paragraph']!.create(null, schema.text(text));
  const paraIndented = (text: string) =>
    n['paragraph']!.create({ indent: 720 }, schema.text(text));
  const blank = () => n['paragraph']!.create(null);

  return n['doc']!.createChecked(null, [
    n['pocket']!.create({ id: newHeadingId() }, schema.text('Welcome to CardMirror')),
    paraText(
      'This is the mobile view — a quick way to read, navigate, and lightly edit your debate files. It opens and saves the same Word .docx files as Verbatim and the CardMirror desktop app.',
    ),
    blank(),

    n['hat']!.create({ id: newHeadingId() }, schema.text('1. Open a file')),
    paraText(
      'Tap ⋮ (top-right) to open a Verbatim or CardMirror file, or start a new one. The mobile view is built for reading and light edits, not building a document from scratch — to write a new doc, switch to the desktop layout from the same ⋮ menu ("Use desktop layout"). Saving writes back the same Word format either way.',
    ),
    blank(),

    n['hat']!.create({ id: newHeadingId() }, schema.text('2. Find your way around')),
    paraText(
      'Tap ☰ (top-left) for the outline — every Pocket, Hat, Block, and Tag in the document. Tap an entry to jump straight to it.',
    ),
    blank(),

    n['hat']!.create({ id: newHeadingId() }, schema.text('3. The mode bar')),
    paraText('The bar along the bottom sets what a tap does:'),
    paraIndented('◉ Read — study the document; tap text to drop a reading marker.'),
    paraIndented('✥ Move — tap a card or heading to pick it up and drop it somewhere new.'),
    paraIndented('✦ Repair — tap a card to clean up its formatting.'),
    blank(),

    n['hat']!.create({ id: newHeadingId() }, schema.text('4. Cutting and full editing live on the desktop')),
    paraText(
      'The mobile view is built for reading, navigating, and quick fixes. For cutting cards, structural edits, and the full keyboard workflow, open the same file in the CardMirror desktop app — it is the same document.',
    ),
  ]);
}

/** Whether this session is using the mobile (touch) layout. Mirrors the
 *  boot-time `BOOT_MOBILE` decision, recomputed here because
 *  `makeNewDocBody` runs before that constant is initialized. */
function isMobileLayout(): boolean {
  return resolveMobileLayout(settings.get('mobileLayout'), {
    hostKind: getHost().kind,
    coarsePointer:
      typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches,
    viewportWidth: window.innerWidth,
  });
}

/** Pick between the onboarding starter and a blank doc based on
 *  the `showOnboardingStarter` setting. Single entry point for
 *  "what does a fresh doc look like?" so the initial mount and the
 *  New flow stay in lockstep. The starter is layout-specific so the
 *  guidance matches the UI the user is actually looking at. */
function makeNewDocBody(): PMNode {
  if (!settings.get('showOnboardingStarter')) return makeBlankNewDoc();
  return isMobileLayout() ? makeMobileStarterDoc() : makeStarterDoc();
}

/**
 * Build the editor's plugin list. Extracted so that `mountView` and
 * the live keybinding-override subscriber both produce the same set —
 * the only delta when overrides change is the ribbon keymap plugin,
 * but PM doesn't let you splice a single plugin, so the whole list is
 * rebuilt and the view is `reconfigure`d in place.
 *
 * Exported so the multi-pane shell can build per-pane EditorViews
 * using the exact same plugin stack as the single-doc shell.
 */
// `targetUid` = the DocRecord.uid of the view these plugins are being built for.
// The active collab session's binding plugins attach ONLY when this is the
// session-owning doc; every other pane (and the null/omitted case) stays
// independent, so opening a second doc during a session can't fuse it onto the
// session's shared LoroDoc. See CollabPluginSource.ownerUid.
// Cut in place (shared documents): whole units cut in a session are
// marked, not deleted; the paste moves them. Resolves the session and the
// document identity lazily through the speech-doc registry.
installCutInPlaceContext({
  isSessionDoc: (view) => collabPluginSourceFor(getSpeechDocResolver().uidForView(view)) != null,
  docKey: (view) => getSpeechDocResolver().uidForView(view),
  viewForDocKey: (key) => getSpeechDocResolver().viewForUid(key),
  hasSeenNotice: () => settings.get('hasSeenCutInPlaceNotice'),
  markNoticeSeen: () => settings.set('hasSeenCutInPlaceNotice', true),
  writeClipboard: writeClipboardHtml,
  clipboardBusyMessage: CLIPBOARD_BUSY_MESSAGE,
});

export function buildEditorPlugins(targetUid?: string | null): Plugin[] {
  const plugins: Plugin[] = [
    // First so its `editable` / read-mode tap-marker props win on the
    // mobile shell; a no-op everywhere else (the active flag is set
    // once at boot, before any view mounts).
    mobilePlugin,
    // Cut in place — ahead of the undo keymap (Cmd-Z while a cut is
    // pending clears the mark, not the last edit) and of the paste
    // plugin (our own payload pasted in the same document is a MOVE).
    buildCutInPlacePlugin(),
    // A live collaboration session owns undo: the CRDT undo manager
    // reverts only this peer's edits, which prosemirror-history cannot
    // guarantee once remote transactions interleave. Outside a session,
    // the plain history stack as always.
    ...(collabPluginSourceFor(targetUid)?.ownsUndo()
      ? [keymap({ 'Mod-z': collabUndo, 'Mod-y': collabRedo, 'Mod-Shift-z': collabRedo })]
      : [
          history(),
          keymap({ 'Mod-z': readModeAwareUndo, 'Mod-y': readModeAwareRedo, 'Mod-Shift-z': readModeAwareRedo }),
        ]),
    // Tag/analytic boundary editing rules (ARCHITECTURE.md §14.3).
    // These run before baseKeymap so they get first crack at
    // Backspace / Delete / Enter when the cursor is in a tag.
    keymap({
      Backspace: (state, dispatch, view) =>
        // First: a selection PM's own delete cannot fit (head-tail
        // cross-container shape) gets the merge-up rebuild instead of
        // an uncaught TransformError (field crash 2026-08-29).
        crossContainerDeleteSelection(state, dispatch, view) ||
        backspaceAtTagStart(state, dispatch, view) ||
        backspaceAtFirstBodyStart(state, dispatch, view) ||
        keepCursorInLeadingBlockOnBlockedMerge(state, dispatch, view) ||
        // Last: never let baseKeymap's selectNodeBackward node-select a
        // whole card / body at a card-adjacent boundary. neverThrow: PM
        // join shapes that cannot fit must no-op, not crash the key.
        neverThrow(blockBackspaceNodeSelect)(state, dispatch, view),
      Delete: (state, dispatch, view) =>
        crossContainerDeleteSelection(state, dispatch, view) ||
        deleteAtTagEnd(state, dispatch, view) ||
        deleteAtContainerEnd(state, dispatch, view) ||
        keepCursorInLeadingBlockOnBlockedMerge(state, dispatch, view) ||
        // Mirror of the Backspace guard: never forward-node-select a card/body.
        neverThrow(blockDeleteNodeSelect)(state, dispatch, view),
      Enter: (state, dispatch, view) =>
        // Live-view bottom edge first: inside the read-only mirror the
        // handlers below would claim the key and have their splits
        // filtered (a dead key), so the escape-below-the-window path
        // must win before any of them run.
        enterBelowSelfRef(state, dispatch) ||
        // "New paragraph on Enter" settings: returns false (untouched
        // pipeline) unless the cursor is at the end of a structural
        // block whose enterAfter* setting picks a style.
        enterWithConfiguredStyle(state, dispatch, view) ||
        enterAtTagEnd(state, dispatch, view) ||
        enterAtZoneStart(state, dispatch, view) ||
        enterMidTag(state, dispatch, view) ||
        neverThrow(enterInHeading)(state, dispatch, view),
    }),
    // Ribbon commands — structural style hotkeys (F4–F7 / Mod-F7)
    // plus inline mark toggles (Mod-B / Mod-I) and the color-aware
    // toggles (F11 / Mod-F11). User overrides come from settings; the
    // `ribbonKeyOverrides` subscriber below reconfigures the state
    // when they change so new bindings take effect without a reload.
    // User keyboard macros run BEFORE the ribbon keymap so a macro key
    // wins over a command bound to the same key (the macro is the user's
    // explicit, more-specific intent). Reconfigured by the
    // `keyboardMacros` subscriber below when the list changes.
    // Sensel Morph control-surface interpreter (prototype). Must sit
    // above every keymap: while armed it rate-divides jog-wheel arrow
    // ticks and, when a selection is active, claims the overlay's
    // pad-grid letters as formatting stamps before macros/ribbon/base
    // see them. Inert until armed (toggleMorphMode command).
    morphModePlugin({
      buildCommand: (id) => getRibbonCommand(id, ribbonContext),
      zoomBy: (deltaPct) => {
        if (multiDocZoomBy) multiDocZoomBy(deltaPct);
        else setZoom(liveZoomPct + deltaPct);
      },
    }),
    keymap(buildMacroKeymap(settings.get('keyboardMacros'))),
    keymap(
      buildRibbonKeymap(settings.get('ribbonKeyOverrides'), ribbonContext),
    ),
    // Word-style nav: Ctrl+Left/Right (units), Ctrl+Up/Down
    // (paragraphs, asymmetric Ctrl+Up), PageUp/PageDown
    // (headings, asymmetric PageUp). Shift+ variants extend. See
    // `word-selection-keymap.ts`. Sits ABOVE baseKeymap so its
    // Ctrl+Arrow / PageUp/Down bindings take precedence over
    // anything baseKeymap defines (and the browser default).
    wordSelectionKeymap,
    // Every base command wrapped in neverThrow: ProseMirror's
    // join/split machinery still has cross-container fit shapes it
    // cannot close, and a TransformError escaping a keystroke ate the
    // input and spammed the console (field log 2026-08-29; fuzzer
    // reproduces cursor-join shapes). A logged no-op is the honest
    // outcome — the edit had no legal result.
    keymap(Object.fromEntries(Object.entries(baseKeymap).map(([k, c]) => [k, neverThrow(c)]))),
    readModePlugin,
    markUnreadPlugin,
    commentsPlugin,
    // Copied comments carry their threads through the clipboard
    // (comment-clipboard.ts) — restore on paste, both shells.
    commentClipboardPlugin(),
    // A comment's range can only grow by typing inside it: any OTHER
    // mechanism that lands a copy of a commented span (drag copies,
    // dropzone, sends, future paths) gets a duplicate thread or — if
    // the thread is unknown here — the mark stripped (comment-guard.ts).
    commentGuardPlugin(),
    // Typing at the doc's end auto-scrolls the caret clear of the
    // pill tray (pill-scroll-clearance.ts) — both shells.
    pillScrollClearancePlugin(),
    learnHighlightPlugin,
    repairHighlightPlugin,
    aiWorkingPlugin,
    // Sits next to the AI-working highlight: holds the leases AI ops claim
    // over the regions they're editing, remaps them through every
    // transaction, and blocks user edits inside an active lease.
    editCoordinatorPlugin,
    cardCutterPreviewPlugin,
    cardCutterFlagPlugin,
    italicCaretPlugin,
    transclusionSelectionGuard,
    transclusionEmptyZoneReaper,
    // Cross-file live-zone divergence indicator: reads sources at quiet moments
    // and badges any zone whose source has moved on. Read-only, desktop-only.
    makeTransclusionDivergencePlugin(),
    // Intra-doc live windows (self_ref): re-render each window read-only when the
    // section it mirrors changes, via a node decoration. No sync/copy — the
    // window is a by-reference view resolved live from the source.
    makeSelfRefPlugin(),
    frozenSelectionPlugin,
    pilcrowSelectionPlugin,
    // Backstop for schema-invalid containers a paste fitter can leave
    // behind (Issue #34) — REGISTERED BEFORE absorb: PM restarts the
    // appendTransaction loop after each appended tr, so healing first
    // means absorb never walks a wounded doc.
    containerIntegrityPlugin,
    absorbPlugin,
    citeClassifierPlugin,
    namedStyleNormalizerPlugin,
    fontSizeClassPlugin,
    cardNumberingPlugin,
    buildSimilarSelectionPlugin(effectivePtForNode),
    findReplacePlugin(),
    repairParagraphPlugin(),
    // Shared singletons — fresh columnResizing() instances lose the
    // table nodeView across reconfigure; see table-plugins.ts.
    tableEditingPlugin,
    columnResizingPlugin,
    // Tab / Shift-Tab indent — registered AFTER tableEditing so it
    // never fires while the cursor is inside a cell (cell Tab nav
    // takes precedence). Outside tables, Tab on a paragraph-spanning
    // selection indents; on a collapsed cursor inserts '\t'.
    keymap({ Tab: indentParagraph, 'Shift-Tab': outdentParagraph }),
    buildPastePlugin({
      condenseOnPaste: () => settings.get('condenseOnPaste'),
      paragraphIntegrity: () => settings.get('paragraphIntegrity'),
      usePilcrows: () => settings.get('usePilcrows'),
      headingMode: () => settings.get('headingMode'),
      smartPasteConversion: () => settings.get('smartPasteConversion'),
      onArmedChange: (armed) => updatePlainPasteIndicator(armed),
    }),
    imageContextMenuPlugin,
    linkContextMenuPlugin,
    // Word-style mouse-selection state machine: owns single-,
    // double-, and triple-click + drag + shift+click. Lets PM
    // place the caret on single-click (preventDefault on the
    // mousedown elsewhere) and lets PM run its default triple-
    // click textblock select; the plugin just records the
    // anchor + granularity so subsequent drag and shift+click
    // extend by the right unit.
    wordSelectionPlugin,
    typeOverBoundaryPlugin,
    // Backstop for the heading-id uniqueness invariant: repairs
    // fit-synthesized null ids and replace-split duplicate ids on the
    // offending LOCAL transaction (see heading-id-guard.ts).
    headingIdGuardPlugin,
    // Reading view: per-doc paginated columns; carries the marker-only
    // transaction lock + relayout hook (see reader-view.ts).
    readerViewPlugin,
    highlightFrequencyPlugin,
    // Swallow the browser's `dragstart` on the editor's content-
    // editable so the user can't initiate a text-move drag from a
    // selection. (Text drag-and-drop never worked reliably, so it's
    // unconditionally off.) Doesn't affect the card / heading pickup-
    // modifier drag — that system uses pointerdown directly and
    // `preventDefault`s, so `dragstart` never fires for those gestures.
    new Plugin({
      props: {
        handleDOMEvents: {
          dragstart: (_view, event) => {
            // Text drag-and-drop is unconditionally off (it never worked
            // reliably). Live Views aren't natively draggable either — they move
            // via the pickup-chord / nav-pane drag like cards — so nothing on the
            // editable surface should start a native drag.
            event.preventDefault();
            return true;
          },
        },
        // Clipboard content is always self-contained: a live view materializes to
        // plain cards here, and a linked copy flattens on paste — so a cross-doc /
        // external paste gets working content, never a dangling link. To ALSO keep
        // the link on a SAME-doc paste (matching drag), stash the un-flattened
        // slice keyed by this view; the paste handler restores it when the paste
        // lands back in the same doc. Cache only when there's actually a link to
        // preserve; a link-less copy clears it.
        transformCopied(slice, view) {
          const clipboard = flattenSelfRefsInSlice(slice, view.state.doc, newHeadingId);
          if (fragmentHasSelfRef(slice.content) || fragmentHasZone(slice.content)) {
            rememberLinkedCopy(slice, view, clipboard);
          } else {
            clearLinkedCopy();
          }
          return clipboard;
        },
      },
    }),
  ];
  // Smart quotes — curls typed quotes when the `smartQuotes` setting is on
  // (inert otherwise; the plugin checks the setting per keystroke).
  plugins.push(smartQuotesPlugin());
  // Custom dash autoformat — converts a typed `---` when the customDash settings
  // are on (inert otherwise; the plugin checks per keystroke).
  plugins.push(customDashPlugin());
  // Custom autocorrections — user-defined replace-as-you-type entries, with
  // the auto-capitalize decorator composing over expansions. ORDER MATTERS
  // across the autocorrect family: char-triggered rules (smart quotes,
  // custom dash) run before commit-triggered ones (this, then standalone
  // auto-capitalization) — first match wins per keystroke.
  plugins.push(customAutocorrectPlugin());
  // Auto-capitalization in tags/analytics — sentence starts + standalone `i`,
  // gated on `autoCapitalizeSentences` (inert otherwise).
  plugins.push(autoCapitalizePlugin());
  plugins.push(footnotePopoverPlugin());
  // Editor spellcheck — viewport-scoped custom checker, gated internally
  // on the `editorSpellcheck` setting (does nothing when off).
  plugins.push(viewportSpellcheckPlugin());
  // Fallback Cut/Copy/Paste context menu. MUST register after the
  // image, link, and spellcheck menus — it claims every right-click
  // that reaches it, and handleDOMEvents run in registration order.
  plugins.push(textContextMenuPlugin);
  // Voice control (SPEC-voice.md §12 item 3): plugin state (mode, pen,
  // utterance atomicity). Desktop-only at runtime; the plugin itself is
  // inert without a session. The session toggle is bound through the
  // rebindable ribbon command (`toggleVoice`), not a fixed keymap here.
  plugins.push(voicePlugin());
  // A live collaboration session appends its binding plugins (sync,
  // undo manager, later cursors). Appended last: they carry no keymaps,
  // and every earlier filter/appendTransaction must see their output.
  // Scope the session binding to its ONE owning doc's view (collabPluginsFor
  // returns [] for any non-owner / null uid). Without this, every pane built
  // while a session is active binds to the session's shared LoroDoc and gets
  // overwritten with the session doc (multi-pane document fusion).
  plugins.push(...collabPluginsFor(targetUid));
  return plugins;
}

// Route undo/redo to the FOCUSED doc's session (if it owns undo). These keymaps
// only fire on the focused view, whose record uid is activeDocIdentity's.
const collabUndo: Command = (state, dispatch, viewArg) =>
  collabPluginSourceFor(activeDocIdentity().sessionUid)?.undo(state, dispatch, viewArg) ?? false;
const collabRedo: Command = (state, dispatch, viewArg) =>
  collabPluginSourceFor(activeDocIdentity().sessionUid)?.redo(state, dispatch, viewArg) ?? false;

let voiceController: VoiceController | null = null;
function getVoiceController(): VoiceController {
  voiceController ??= new VoiceController({
    getView: getActiveView,
    ribbonCtx: ribbonContext,
  });
  return voiceController;
}

function mountView(doc: PMNode, threads: Thread[] = []): void {
  if (view) {
    editorDragSurface.detach();
    view.destroy();
  }
  const state = EditorState.create({
    doc,
    schema,
    // Single-doc/mobile main view: its uid is the session-owner identity when a
    // session is active on this window (matches getOwnerUid = currentDocUid).
    plugins: buildEditorPlugins(currentDocUid),
  });
  view = new EditorView(editorEl, {
    state,
    nodeViews: editorNodeViews,
    // NO `editable` prop: read mode is enforced by the read-mode
    // plugin's filterTransaction, with the view kept editable so the
    // caret is placeable and Space/Enter reading markers work — the
    // design documented in read-mode-plugin.ts and what multi-pane
    // panes already do. The old `editable: () => !readMode` here
    // predated that design (2026-05-09 vs 2026-06-08) and quietly
    // diverged single-pane: contenteditable=false also makes PM's
    // view.focus() a DOM no-op (2026-07-27 focus audit).
    // Browser's built-in spellcheck stays OFF — `editorSpellcheck` is
    // served by the custom viewport checker (viewport-spellcheck.ts),
    // which also catches imported text and renders under Wayland.
    attributes: { spellcheck: 'false' },
    dispatchTransaction(this: EditorView, tx) {
      // Only the current, fully-mounted view processes transactions. PM
      // invokes this as `dispatchTransaction.call(theView, tx)`, so `this`
      // is the view the transaction was dispatched to. During a re-mount
      // the module-level `view` still points at the PREVIOUS (just
      // destroyed) view while the replacement is under construction — and
      // a plugin that dispatches from its own `view()` setup (the
      // highlight-frequency mount scan is one) fires right then. Reading
      // the stale `view` would apply that fresh-doc transaction to the old
      // view's state and throw "Applying a mismatched transaction" (the
      // home-screen New/Open failure). The same guard also drops a late
      // dispatch from a torn-down view (a pending timer/rAF) so it can't
      // write into its replacement. Until `view` is assigned to this
      // instance, drop the transaction — matching the historical
      // first-mount behavior where `view` was null and the dispatch no-op'd.
      if (this !== view) return;
      // Stamp collab metas (sync-origin on the Loro binding's remote
      // transactions) BEFORE apply so every filterTransaction sees them.
      // No-op when no session is active.
      tagCollabTransaction(tx);
      // A user edit inside a region an AI op has leased is rejected and the
      // locked region flashes. AI writes carry a bypass tag, so they pass.
      if (coordinatorBlocks(view.state, tx)) {
        flashLockedLeases(view, tx);
        return;
      }
      const prevState = view.state;
      const prevCommentsState = commentsKey.getState(prevState);
      const prevDivergedSet = transclusionDivergenceKey.getState(prevState)?.diverged;
      const next = view.state.apply(tx);
      view.updateState(next);
      // The divergence set updates via a meta transaction (no doc change), so the
      // docChanged-gated nav rebuild below wouldn't pick it up. Rebuild the nav
      // when the set's identity changes (new Set only on a real change) so the
      // "source updated" dots appear/clear. Doc edits keep the same Set ref, so
      // this doesn't double up with the docChanged rebuild.
      if (transclusionDivergenceKey.getState(next)?.diverged !== prevDivergedSet) {
        scheduleHeavyUpdate();
      }
      if (tx.docChanged) {
        // Suppress persistence while the benchmark drives temporary edits — they
        // are reverted from a snapshot, must never reach disk, and shouldn't
        // mark the doc dirty (see beginBenchmark/endBenchmark).
        if (!isBenchmarkActive()) {
          currentDoc = next.doc;
          markNonPristineStarter();
          markCurrentDocDirty();
          // Re-arm the autosave debounce. No-ops when the setting
          // is off, so the call is cheap to fire unconditionally.
          notifyEditForAutosave();
        }
        // The cached whole-doc word count is now stale. Null it so a
        // selection collapse before the debounced recount re-walks the
        // doc rather than showing a stale total (the debounced
        // scheduleHeavyUpdate repopulates it on the next idle flush).
        lastWholeDocWords = null;
      }
      // Selection-mirroring chrome: only when something it displays could
      // have changed (doc, selection, storedMarks — settings changes have
      // their own refresh path), coalesced to one fused walk per frame.
      // Meta-only ticks (spellcheck, comments GC, collab leases) skip it.
      if (
        tx.docChanged ||
        !prevState.selection.eq(next.selection) ||
        prevState.storedMarks !== next.storedMarks
      ) {
        scheduleSelectionChromeRefresh();
      }
      // Doc-walking work (nav rebuild, word count, comments column
      // refresh, comments-plugin orphan GC) is all O(doc) and the
      // dominant per-keystroke cost on big docs. Debounce it, and run
      // it only when the doc actually changed: skipping selection-only
      // transactions avoids rebuilding the nav's `<li>`s on every
      // cursor move and keeps a plain nav click from re-rendering the
      // outline mid-double-click.
      if (tx.docChanged && !isBenchmarkActive()) {
        needsCommentsGC = true;
        scheduleHeavyUpdate();
        // Keep the nav pane's cached heading positions in lockstep with the doc
        // so the caret-tracking below compares against current positions, not
        // the pre-edit ones the debounced rebuild hasn't refreshed yet —
        // otherwise the highlight flickers to the next heading while you type
        // on the line just above it.
        navPanel.remapPositions(tx.mapping);
        // Headings that ARRIVE via sync (a joined session's initial fill,
        // a partner's additions mid-session) fold to the pane's current
        // depth instead of landing fully expanded. Synchronous, before
        // the debounced rebuild — the hook diffs against lastSeenIds,
        // which any intervening render would refresh (see its JSDoc).
        if (isSyncOrigin(tx)) navPanel.applyMaxLevelToNewHeadings();
      }
      // Selection-only changes refresh just the word-count readout so
      // the read time reflects the selection immediately instead of
      // waiting for the next edit. `liveSelectionWordCount` only needs
      // it when a range is involved on either side (plain cursor moves
      // can't change a selection count); `liveContainerReadTime` needs
      // every selection change, cursor moves included — the enclosing
      // container follows the caret, and so does `liveRemainingReadTime`'s
      // "what's left" boundary. All three reuse the cached whole-doc
      // count (no doc walk); the container count is itself cached per
      // container and the remaining count reads a per-doc suffix table,
      // so an empty→empty move costs an ancestor walk plus at most one
      // top-level child.
      else if (
        !prevState.selection.eq(next.selection) &&
        ((settings.get('liveSelectionWordCount') &&
          (!prevState.selection.empty || !next.selection.empty)) ||
          settings.get('liveContainerReadTime') ||
          settings.get('liveRemainingReadTime'))
      ) {
        refreshWordCount({ selectionOnly: true });
      }
      // Comments column refresh on doc / plugin-state change is
      // debounced via the column's own scheduleRender (matches the
      // 200ms heavy-update cadence).
      if (commentsColumn && (tx.docChanged || commentsKey.getState(next) !== prevCommentsState)) {
        commentsColumn.scheduleRender();
      }
      // Cursor → active-thread tracking. `threadIdAtCursor` reads
      // the cursor's marks (O(1)); `setActiveThread` with the default
      // 'cursor' flavor schedules a debounced render instead of
      // running one synchronously.
      if (commentsColumn && (prevState.selection !== next.selection || tx.docChanged)) {
        const id = threadIdAtCursor(next);
        commentsColumn.setActiveThread(id);
      }
      // Caret-tracking for the nav pane: highlight the heading whose
      // section contains the cursor. Gate on selection-position
      // change (cheap) so a transaction that only mutated content
      // away from the cursor doesn't pay the find-heading walk.
      // `prevState.selection.from !== next.selection.from` rather
      // than `prevState.selection !== next.selection` because a
      // selection object can be a new instance (after doc map) for
      // the same effective caret position; we only care about the
      // position itself.
      // Also refire when the live-view node-selection changes even if `from`
      // held steady (a cursor just before a live view and a NodeSelection on it
      // share a position) so the window's nav highlight tracks it.
      const nextSelfRef = selfRefSelectionPos(next);
      if (
        prevState.selection.from !== next.selection.from ||
        selfRefSelectionPos(prevState) !== nextSelfRef
      ) {
        navPanel.setCaretHeading(next.selection.from, nextSelfRef);
      }
    },
  });
  // Hydrate comments plugin state from the import. A separate
  // transaction (with addToHistory: false inside `loadThreads`)
  // keeps load out of the undo stack.
  if (threads.length > 0) {
    view.dispatch(loadThreads(view.state, threads));
  }
  currentDoc = doc;
  navPanel.attach(view);
  // Sync visible state with the persisted setting on every mount.
  const startVisible = settings.get('commentsVisible');
  if (commentsColumnEl) commentsColumnEl.hidden = !startVisible;
  if (commentsToggleBtn) {
    commentsToggleBtn.setAttribute('aria-pressed', startVisible ? 'true' : 'false');
  }
  if (commentsColumn) commentsColumn.render();
  // Editor drop surface — renders drop indicators in the editor when
  // a nav-pane drag is active, and exposes a hit-test the nav drag
  // handler queries during pointermove.
  editorDragSurface.attach(view, editorEl);
  // Publish editor width as `--pmd-card-intrinsic-width` so cards
  // and heading containers (which have `content-visibility: auto`)
  // can use it as their intrinsic-width when skipped off-screen.
  // Window-resize + explicit triggers (nav drag fires through the
  // settings subscriber). Deliberately NOT a ResizeObserver — see
  // the doc comment on `syncCardIntrinsicWidth` for why.
  setupCardIntrinsicWidthSync();
  exportBtn.disabled = false;
  // Initial paint: do the heavy update synchronously so the user sees
  // the right thing immediately on doc load.
  navPanel.update(doc);
  refreshWordCount();
  refreshFontSizeDisplay();
  refreshFormattingPanelButtonStates();
  syncNumberingButtons();
  // Push the current `settings.readMode` value through the full
  // apply path now that `view` exists — `applyReadMode` ran at
  // module init time before this view was constructed (so its
  // `view.setProps` / plugin dispatch were skipped) and the
  // plugin's local state defaults to OFF. Re-applying here lands
  // both the editable flag AND the plugin's text-hiding
  // decoration set in their correct on/off state for the
  // persisted setting.
  applyReadMode(settings.get('readMode'));
  // Reset scroll on both the nav pane and the editor so a
  // freshly-mounted doc starts at the top. Single-doc's scroll
  // container is `#app` (`position: fixed` + `overflow-y: auto`);
  // multi-pane has per-pane `.pmd-pane-body` scrollers that the
  // shell already resets on its own. Without this, opening one
  // doc and then another lands you at whatever scroll position
  // the previous doc was last in.
  navPanel.scrollToTop();
  appEl.scrollTop = 0;
  // Re-resolve this doc's flashcard highlights once the caller has set
  // the doc identity (adoptDocId runs synchronously right after
  // mountView returns, so defer a frame). No-op when the column is
  // closed (lazy per SPEC §4.2).
  requestAnimationFrame(() => commentsColumn?.refreshFlashcardAnchors());
}

/** Publish `#editor`'s current width as `--pmd-card-intrinsic-width`
 *  so cards and heading containers (which use
 *  `content-visibility: auto`) render their skipped-placeholder box
 *  at the editor's real width rather than a fixed pixel fallback.
 *
 *  Driven by explicit triggers — initial mount, window resize, and
 *  the settings subscriber (which fires on nav-rail drags via the
 *  `navWidth` setting). NOT a ResizeObserver: the variable write
 *  triggers a layout pass on every card, and observer-driven
 *  updates produced a hard feedback loop where the editor's
 *  measured width crept up each iteration after the user clicked
 *  into the editor. Explicit triggers can't re-fire from our own
 *  mutations. */
// (State for these lives up next to applyMaxTextWidth — a boot-time
// applyMaxTextWidth call reaches scheduleSyncCardIntrinsicWidth, and
// `let` state declared down here would still be in its temporal dead
// zone at that point.)

function syncCardIntrinsicWidth(): void {
  if (!editorEl || editorEl.hidden) return;
  // Measure the actual ProseMirror element's content area (clientWidth
  // minus its computed horizontal padding) when the view is mounted —
  // that's the box cards lay out into, so it's the right value for the
  // `contain-intrinsic-width` fallback. `editorEl.offsetWidth` would
  // include scrollbar gutter and ignore PM's inner padding, which
  // overshoots a card's actual width.
  let width = 0;
  if (view) {
    const pmEl = view.dom as HTMLElement;
    const cs = getComputedStyle(pmEl);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    width = Math.round(pmEl.clientWidth - padL - padR);
  } else {
    width = Math.round(editorEl.clientWidth);
  }
  if (width <= 0) return;
  if (width === lastCardIntrinsicWidth) return;
  lastCardIntrinsicWidth = width;
  editorEl.style.setProperty('--pmd-card-intrinsic-width', `${width}px`);
}

/** Coalesce sync triggers landing in the same tick into a single
 *  rAF read, so we measure once after layout settles. */
function scheduleSyncCardIntrinsicWidth(): void {
  if (cardIntrinsicWidthRaf !== null) return;
  cardIntrinsicWidthRaf = requestAnimationFrame(() => {
    cardIntrinsicWidthRaf = null;
    syncCardIntrinsicWidth();
  });
}

function setupCardIntrinsicWidthSync(): void {
  if (cardIntrinsicWidthInstalled) {
    scheduleSyncCardIntrinsicWidth();
    return;
  }
  cardIntrinsicWidthInstalled = true;
  window.addEventListener('resize', scheduleSyncCardIntrinsicWidth);
  scheduleSyncCardIntrinsicWidth();
}

/** Exposed for the global settings subscriber — fires on nav drag
 *  (navWidth change), zoom change, etc. that move the editor's
 *  available width without raising a window resize event. */
export function notifyEditorLayoutChanged(): void {
  if (!cardIntrinsicWidthInstalled) return;
  scheduleSyncCardIntrinsicWidth();
}

let pendingHeavyUpdate: IdleHandle | null = null;
const HEAVY_UPDATE_DELAY_MS = 200;

/** Set when a doc-changing transaction has fired since the last
 *  `scheduleHeavyUpdate` flush. Drives the comments-plugin orphan
 *  GC walk — O(doc), so it runs once per idle period and only when
 *  the doc actually moved, never per keystroke. */
let needsCommentsGC = false;

function scheduleHeavyUpdate(): void {
  if (pendingHeavyUpdate !== null) cancelIdle(pendingHeavyUpdate);
  // Schedule via requestIdleCallback (setTimeout fallback) so the
  // nav / word-count / GC burst runs only when the browser has frame
  // budget to spare — a fixed timer would fire regardless of whether
  // the browser is busy and collide with paint frames.
  pendingHeavyUpdate = scheduleIdle(() => {
    pendingHeavyUpdate = null;
    if (!view) return;
    navPanel.update(view.state.doc);
    // Re-apply the caret highlight now that `update()` has rebuilt
    // `liEntries` with fresh positions. The synchronous `setCaretHeading`
    // in `dispatchTransaction` ran against stale positions (it fires
    // before this debounced rebuild) — fine for small edits, but a
    // structural change like a drag-move leaves the wrong heading
    // highlighted until the next caret movement. Re-running here against
    // the rebuilt positions corrects it. Positional resync, not a caret
    // move → an explicit nav multi-select survives (the numbering
    // toggles edit the selected cards, which lands here).
    navPanel.setCaretHeading(view.state.selection.from, selfRefSelectionPos(view.state), {
      preserveMultiSelect: true,
    });
    refreshWordCount();
    if (needsCommentsGC) {
      needsCommentsGC = false;
      gcOrphanThreads(view);
    }
  }, HEAVY_UPDATE_DELAY_MS);
}

/** Remembers the file the user imported, so Save As can default to
 *  its name. Set on import, updated on Save / Save-As. */
let currentDocFilename: string | null = null;
/** Opaque host handle for the current single-doc file. Set on
 *  open (when the host hands one out) and on Save-As (when the user
 *  commits to a location). The "Save" command writes to this handle
 *  silently; absent → Save falls through to Save-As.
 *
 *  Mutated through `setCurrentDocHandle` so the cross-window
 *  duplicate-open guard stays in sync (Electron only): the helper
 *  releases the old path-claim and registers the new one with
 *  main, so opening the same file in a different window can
 *  detect + focus this window instead. */
let currentDocHandle: unknown | null = null;
function setCurrentDocHandle(next: unknown | null): void {
  const prev = currentDocHandle;
  currentDocHandle = next;
  // Keep the transclusion refresh resolver's view→docPath map current.
  if (view) setViewDocPath(view, typeof next === 'string' ? next : null);
  if (prev === next) return;
  const electron = getElectronHost();
  if (!electron) return;
  if (typeof prev === 'string' && prev) {
    void electron.openPathRelease(prev);
  }
  if (typeof next === 'string' && next) {
    void electron.openPathRegister(next);
  }
}
/** On-disk format of the current single-doc file. Drives whether
 *  "Save" routes through `toDocx` or `serializeNative`. `null` for
 *  brand-new docs that have never been saved. */
let currentDocFormat: 'cmir' | 'docx' | null = null;
/** Stable identifier for the active single-doc session. Keys the
 *  crash-recovery journal entry so a doc that's been edited but
 *  not saved is still recoverable after a hard kill. Regenerated
 *  whenever a fresh doc replaces the current one (New, Open,
 *  recovery from a different journal). */
let currentDocUid: string = newSessionDocUid();

/** Stable per-document UUID for the Learn annotation layer (SPEC §3.1).
 *  Read from the file on open; minted on first save (in-place) or forked
 *  on Save As; null for a never-saved doc (its annotations key to
 *  `currentDocUid` until first save, then `ensureActiveDocId` rekeys them).
 *  Single-doc only — multi-pane keeps the equivalent on each DocRecord. */
let currentDocId: string | null = null;

/** The active doc's persistent docId + session uid — mode-aware. In
 *  multi-pane this is the focused pane's record; in single-doc the
 *  module-level `currentDoc*` values. */
function activeDocIdentity(): { docId: string | null; sessionUid: string } {
  if (multiDocActive && multiDocGetFocusedFile) {
    const f = multiDocGetFocusedFile();
    if (f) return { docId: f.docId, sessionUid: f.uid };
  }
  return { docId: currentDocId, sessionUid: currentDocUid };
}

/** Find the live view for a doc open anywhere in THIS window — any pane
 *  in multi-pane, the single view in single-doc — regardless of focus.
 *  Returns null when no open doc has that id. */
function findViewForDocId(docId: string): EditorView | null {
  if (multiDocActive && multiDocFindViewForDocId) return multiDocFindViewForDocId(docId);
  return currentDocId === docId ? getActiveView() : null;
}

/** Write the active doc's persistent docId back into its record
 *  (focused pane in multi-pane, module global in single-doc). */
function setActiveDocId(docId: string): void {
  if (multiDocActive && multiDocSetFocusedDocId) {
    multiDocSetFocusedDocId(docId);
    return;
  }
  currentDocId = docId;
}

/** The docId to ground new annotations against right now — the persistent
 *  docId once saved, else the session uid (rekeyed onto the real docId at
 *  first save). Used by Create Flashcard / Ask AI. */
function activeAnnotationDocId(): string {
  const { docId, sessionUid } = activeDocIdentity();
  return docId ?? sessionUid;
}

/** Return the active doc's stable id, minting one (and rekeying any
 *  pre-save annotations off the session uid) on first save / first
 *  flashcard of a never-saved doc. Works in both layouts. */
function ensureActiveDocId(): string {
  const { docId, sessionUid } = activeDocIdentity();
  if (docId) return docId;
  const id = crypto.randomUUID();
  learnStore.rekeyDoc(sessionUid, id);
  setActiveDocId(id);
  return id;
}

/** The persistent docId to embed on a save — never the session uid (a
 *  never-saved doc writes no identity). */
function activeSavedDocId(): string | undefined {
  return activeDocIdentity().docId ?? undefined;
}

/** Stamp `docId` straight into the active file on disk — minimal +
 *  lossless (adds the `.docx` custom property / `.cmir` field without
 *  re-rendering the body), so a flashcard created in a file CardMirror
 *  didn't author survives a reload without a manual save. No-op on the
 *  web edition, for never-saved docs (no handle), or when the file
 *  already carries an id (it was adopted on open). Best-effort:
 *  failures just leave the id in memory (a later save persists it).
 *  Reads from disk, so unsaved in-editor edits are untouched. */
async function stampActiveFileDocId(docId: string): Promise<void> {
  const electron = getElectronHost();
  if (!electron) return;
  const f = activeFile();
  if (typeof f.handle !== 'string' || !f.handle) return;
  try {
    const read = await electron.readFileAtPath(f.handle);
    if (!read) return;
    if (await readDocIdFromBytes(read.bytes, read.format)) return; // already has one
    const stamped = await stampDocId(read.bytes, read.format, docId);
    await getHost().saveExisting(f.handle, stamped);
  } catch (err) {
    console.warn('Failed to stamp docId into file:', err);
  }
}

/** Adopt the docId read from an opened file (null ⇒ minted on next save)
 *  and register the doc so the Learn "By file" view + open-in-context can
 *  find it. */
function adoptDocId(docId: string | null, name: string, handle: unknown, format: 'cmir' | 'docx' | null): void {
  currentDocId = docId;
  if (docId) {
    learnStore.registerDoc({ docId, path: typeof handle === 'string' ? handle : null, name, format });
  }
  void checkSessionRejoinForOpenedDoc(docId);
}

/** RoomIds currently mid-prompt — a re-open while the dialog is up
 *  must not stack a second one. */
const rejoinPromptsInFlight = new Set<string>();

/** Open-from-disk rejoin gate. A file whose docId matches a resumable
 *  session record must not be edited outside its session while the
 *  session lives — silent divergence: two copies under one name, no
 *  merge between them. Exactly two doors, per the settled design:
 *  REJOIN (bind the session into this just-opened doc — clean from
 *  disk, so nothing local is lost) or LEAVE (discard this window's
 *  session record and continue with the file, divergence accepted
 *  explicitly). Esc/cancel counts as Rejoin — the non-destructive
 *  door; there is deliberately no "just edit locally" option. */
export async function checkSessionRejoinForOpenedDoc(
  docId: string | null,
  openedUid?: string,
): Promise<void> {
  if (!docId) return;
  let records: Awaited<ReturnType<typeof listSessionRecords>>;
  try {
    records = await listSessionRecords();
  } catch {
    return; // storage unavailable — nothing to offer
  }
  const record = records.find((r) => (r.docId ?? null) === docId);
  if (!record || rejoinPromptsInFlight.has(record.roomId)) return;
  // Session already live in this window → its copy is already open;
  // don't prompt, just say so.
  const loaded = await collabUiModule;
  if (loaded?.roomLiveInWindow(record.roomId)) {
    showToast('This document\u2019s co-editing session is already open in this window.');
    return;
  }
  rejoinPromptsInFlight.add(record.roomId);
  try {
    const choice = await promptForRouteChoice<'rejoin' | 'leave'>({
      message: 'This document has a co-editing session',
      detail:
        'It was saved from a live session. Editing it outside the session would ' +
        'split it into two diverging copies with the same name.',
      choices: [
        {
          value: 'rejoin',
          label: 'Rejoin session',
          description: 'Reconnect — this document becomes the live session copy.',
        },
        {
          value: 'leave',
          label: 'Leave session',
          description: 'Forget the session here and keep this file as an independent copy.',
        },
      ],
      cancelLabel: 'Rejoin session',
    });
    if (choice === 'leave') {
      await deleteSessionRecord(record.roomId);
      showToast('Left the session \u2014 this copy is now independent.');
      return;
    }
    // 'rejoin' or Esc/cancel: bind the session into the doc just opened.
    const m = await loadCollabUi();
    // Multi-pane: pin the deps to the pane the file was opened into —
    // existingDoc resume never runs the slot picker, so the uid must
    // come from the open, not from a doc-creation that won't happen.
    const deps = multiDocActive ? makeMultiPaneSessionDeps(openedUid) : collabDeps;
    await m.resumeSessionFlow(deps, record.roomId, { existingDoc: true });
  } finally {
    rejoinPromptsInFlight.delete(record.roomId);
  }
}

/** True while this window is still showing the untouched
 *  onboarding starter doc. False after any user action that makes
 *  the doc "real" — edit, Open, New, Save, recovery. In windows
 *  mode (single-doc + Electron), Open and New replace the doc
 *  in-place when this is true (so first launch doesn't strand a
 *  redundant starter window) and spawn fresh windows when this
 *  is false. Multi-pane mode ignores the flag. */
let isPristineStarter = true;

/** Mark the current window as having had a substantive user
 *  action (edit / Open / New / Save / Recover). Once non-pristine,
 *  subsequent Opens / News spawn new windows on hosts that
 *  support it. */
function markNonPristineStarter(): void {
  isPristineStarter = false;
}

/** Whether the single-doc view has unsaved changes — true on any
 *  doc-changing edit, cleared on a successful save (manual or
 *  autosave) and on every doc swap (Open, New, mount-from-spawn,
 *  recovery). Drives the close-confirm prompt: a clean window
 *  closes without prompting. */
let currentDocDirty = false;
/** Edit generation for the single-doc view — bumped on every doc-
 *  changing edit AND on every explicit clean (doc swaps: Open / New /
 *  recovery). Saves capture it right before serializing so a save that
 *  completes after further edits (or after the doc was replaced) can't
 *  wrongly mark the CURRENT content clean (see save-clean-token.ts). */
let currentDocEditGen = 0;
function markCurrentDocDirty(): void {
  currentDocDirty = true;
  currentDocEditGen++;
}
function markCurrentDocClean(): void {
  currentDocDirty = false;
  // Invalidate any in-flight save's clean token: this path runs on doc
  // swaps, and a save of the PREVIOUS doc must not mark the new one
  // clean (save completions commit via their token, not this fn).
  currentDocEditGen++;
}

/** Generate a fresh session-scoped doc UID. Used by the single-doc
 *  edit path; multi-doc DocRecords have their own newDocUid pool.
 *  Keeping the namespaces separate avoids accidental collisions
 *  even though both keys are local-scope. */
function newSessionDocUid(): string {
  return `single-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

/** Tracks the uid currently registered with the speech-doc resolver
 *  on behalf of this renderer's single view. `null` when no doc is
 *  mounted yet. Used by `syncSingleDocSpeechRegistration` to know
 *  what to unregister before re-registering. */
let registeredSingleDocUid: string | null = null;

/** Reconcile the speech-doc resolver with the current `view` +
 *  `currentDocUid`. Call after any `mountView(...)` followed by a
 *  `currentDocUid = ...` reassignment. Idempotent: registering the
 *  same uid/view pair is a no-op; switching uids unregisters the
 *  old before registering the new. In Electron mode this also
 *  drives the main-process registry via IPC. The `onSliceLanded`
 *  hook fires when an incoming speech-doc slice lands in this
 *  view — refreshes nav-panel collapse state for newly arrived
 *  headings using the configured `maxLevel`. */
function syncSingleDocSpeechRegistration(): void {
  if (!view) return;
  const resolver = getSpeechDocResolver();
  if (
    registeredSingleDocUid !== null &&
    registeredSingleDocUid !== currentDocUid
  ) {
    resolver.unregisterView(registeredSingleDocUid);
  }
  resolver.registerView(currentDocUid, view, {
    onSliceLanded: () => navPanel.applyMaxLevelToNewHeadings(),
  });
  registeredSingleDocUid = currentDocUid;
}

/** Filename-to-format inference. Used when opening files and when
 *  defaulting the Save-As dialog's format radio. */
function formatFromFilename(name: string | null | undefined): 'cmir' | 'docx' | null {
  if (!name) return null;
  const lower = name.toLowerCase();
  if (lower.endsWith('.cmir')) return 'cmir';
  if (lower.endsWith('.docx')) return 'docx';
  return null;
}

/** Choose the PARSER for already-loaded doc bytes by sniffing them, not by the
 *  doc's `format` field. A `.docx` is a zip — its bytes start with `PK`
 *  (0x50 0x4b); native cmir is gzipped or raw JSON and never does. The `format`
 *  field is the SAVE format, NOT a reliable parser hint: in-memory and journal
 *  serializations are ALWAYS native cmir even for docx-saved docs, so a
 *  mode-switch respawn or an opened `.cmir-journal` carries cmir bytes stamped
 *  `format: 'docx'`. Sniffing the bytes is authoritative; trusting `format` here
 *  sends those cmir bytes to the Word importer, which throws "not a zip file". */
function bytesLookLikeDocx(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/** Combined open-file filter — accepts both formats by default so
 *  the user can pick either. The native option is listed first so
 *  it's the default filter selection (most apps default to "all
 *  recognized" or the first filter; users can swap to "Word only"
 *  if they want to narrow). */
const OPEN_FILE_FILTERS = [
  { name: 'CardMirror, Word, or recovery journal', extensions: ['cmir', 'cmir-journal', 'docx'] },
  { name: 'CardMirror native (.cmir)', extensions: ['cmir'] },
  { name: 'CardMirror recovery journal (.cmir-journal)', extensions: ['cmir-journal'] },
  { name: 'Microsoft Word (.docx)', extensions: ['docx'] },
];

/** Resolve an opened file to the doc payload to mount. A `.cmir-journal` is a
 *  JSON envelope wrapping the real doc bytes (the same bytes a `.cmir` holds)
 *  plus an explicit format; decode it and open the wrapped doc as a RECOVERED,
 *  unsaved copy — `handle = null` (so Save can't silently overwrite the original
 *  `.cmir`, which may be newer or live on another machine) and `recovered: true`
 *  (so it mounts dirty and prompts before closing). Non-journal files pass
 *  through with their format inferred from the extension. Returns `'corrupt'`
 *  for an unreadable journal envelope. */
async function resolveOpenedFile(
  opened: OpenedFile,
): Promise<
  | { name: string; bytes: Uint8Array; handle: unknown; format: 'cmir' | 'docx'; recovered: boolean }
  | 'corrupt'
> {
  if (opened.name.toLowerCase().endsWith('.cmir-journal')) {
    try {
      const env = JSON.parse(new TextDecoder().decode(opened.bytes)) as {
        bytesB64?: unknown;
        format?: unknown;
        filename?: unknown;
      };
      if (typeof env.bytesB64 !== 'string') return 'corrupt';
      const bin = atob(env.bytesB64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const format: 'cmir' | 'docx' =
        env.format === 'docx'
          ? 'docx'
          : env.format === 'cmir'
            ? 'cmir'
            : formatFromFilename(typeof env.filename === 'string' ? env.filename : null) ?? 'cmir';
      let name =
        typeof env.filename === 'string' && env.filename
          ? env.filename
          : opened.name.replace(/\.cmir-journal$/i, '');
      // Carry the format's extension on the name so every downstream path (incl.
      // multi-pane, which re-derives format from the name) agrees on the format.
      if (formatFromFilename(name) !== format) name = `${name}.${format}`;
      return { name, bytes, handle: null, format, recovered: true };
    } catch {
      return 'corrupt';
    }
  }
  const format = formatFromFilename(opened.name) ?? 'docx';
  // A GENUINELY empty file — stat size 0, e.g. Explorer's "New >
  // Microsoft Word Document" — opens as a blank document bound to its
  // path, like Word does: substitute canonical blank bytes here so every
  // downstream open path (parse, mount, multi-pane routing, spawn-window)
  // works unmodified. Cloud placeholders never take this branch (the host
  // only flags stat-0 files; a not-yet-downloaded placeholder stats at
  // its real size and keeps the "hasn't finished downloading" error).
  const bytes = opensAsBlank(opened)
    ? await blankDocumentBytes(format, makeBlankNewDoc(), {
        defaultFont: settings.get('bodyFont'),
      })
    : opened.bytes;
  return {
    name: opened.name,
    bytes,
    // Keep the handle as-is: an Electron path string OR a web FileSystemFile-
    // Handle object (so Save can write in place). Only string paths reach the
    // path-keyed stores downstream (they guard with `typeof === 'string'`).
    handle: opened.handle ?? null,
    format,
    recovered: false,
  };
}

/** Save-As filter — only the chosen format's extension. Built per
 *  save call so the dialog drops to a single option matching the
 *  format radio the user picked. */
function saveFiltersForFormat(format: 'cmir' | 'docx'): { name: string; extensions: string[] }[] {
  if (format === 'cmir') {
    return [{ name: 'CardMirror native (.cmir)', extensions: ['cmir'] }];
  }
  return [{ name: 'Microsoft Word (.docx)', extensions: ['docx'] }];
}

/** The "open a doc" flow. Asks the host for a file, detects format
 *  from the extension, and routes: multi-doc mode hands off to the
 *  multi-pane shell (which shows the "send to slot N" picker);
 *  single-doc mode mounts it as the current view. */
async function runOpenFlow(): Promise<void> {
  let opened: OpenedFile | null;
  try {
    opened = await getHost().openFile({ filters: OPEN_FILE_FILTERS });
  } catch (err) {
    console.error('Open failed:', err);
    void alertDialog(`Failed to open: ${err instanceof Error ? err.message : err}`);
    return;
  }
  if (!opened) return;
  await routeOpenedFile(opened);
}

/** Route an already-obtained opened file: cross-window duplicate guard,
 *  then multi-pane slot picker / spawn-a-new-window (unless this window
 *  is still a pristine starter) / mount-in-place. Shared by the Open
 *  dialog and the command-palette file search, so file search opens in
 *  a new window / the slot picker rather than replacing the current doc. */
async function routeOpenedFile(opened: OpenedFile): Promise<void> {
  // Decode a .cmir-journal into its wrapped doc (recovered, unsaved); a plain
  // .cmir/.docx passes through unchanged.
  const src = await resolveOpenedFile(opened);
  if (src === 'corrupt') {
    void alertDialog('That .cmir-journal file is corrupt or could not be read.');
    return;
  }
  // Cross-window duplicate-open guard: if any other window already has this
  // file open, refuse (Electron focuses that window; web just toasts). Runs
  // BEFORE the multi-doc / spawn-window / mount branches so the same check
  // applies whether this window is single-doc or multi-pane and whether we're
  // about to mount here or spawn a fresh window. Handle-keyed — never-saved
  // docs (handle == null, incl. a recovered journal) have no identity yet so
  // they're not deduped.
  if (src.handle != null && (await isFileOpenInAnotherWindow(src.handle))) {
    showToast(`"${src.name}" is already open in another window.`);
    return;
  }
  if (multiDocActive && multiDocOnFileOpen) {
    // Multi-pane shell runs its own within-window duplicate-open
    // guard (checks every slot's stack) before showing the slot
    // picker.
    try {
      await multiDocOnFileOpen({ name: src.name, bytes: src.bytes, handle: src.handle });
    } catch (err) {
      if (err instanceof NativeDamagedError) {
        await offerDamagedSalvage(src.name, src.bytes);
        return;
      }
      console.error('Multi-doc open failed:', err);
      void alertDialog(`Failed to open: ${err instanceof Error ? err.message : err}`);
    }
    return;
  }
  // Single-doc within-window duplicate-open guard: if the file is
  // already the current doc, refuse and toast.
  if (src.handle != null && (await isSameOpenHandle(currentDocHandle, src.handle))) {
    showToast(`"${src.name}" is already open.`);
    return;
  }
  const format = src.format;
  // Windows mode (single-doc + Electron + we have a non-pristine
  // doc in the current window): spawn a new window for the
  // opened file instead of replacing what's here.
  const host = getHost();
  if (host.canSpawnWindow && !isPristineStarter) {
    try {
      await host.spawnWindow({
        filename: src.name,
        bytes: src.bytes,
        // spawnWindow is Electron-only (canSpawnWindow); its handle is a path
        // string. A web FileSystemFileHandle can't cross to a new window.
        handle: typeof src.handle === 'string' ? src.handle : null,
        format,
        uid: null,
      });
    } catch (err) {
      console.error('Spawn window failed:', err);
      void alertDialog(`Failed to open in new window: ${err instanceof Error ? err.message : err}`);
    }
    return;
  }
  // Password-protected .docx arrives as a compound file, not a zip;
  // decrypt to real .docx bytes (or pass through) before parsing.
  let openBytes: Uint8Array;
  try {
    openBytes = await maybeDecryptForOpen(src.bytes, src.name);
  } catch (err) {
    if (err instanceof OpenCancelledError) return;
    void alertDialog(err instanceof Error ? err.message : String(err));
    return;
  }
  try {
    let docNode: PMNode;
    let docThreads: Thread[] | undefined;
    let docId: string | null = null;
    if (!bytesLookLikeDocx(openBytes)) {
      const parsed = parseNative(openBytes);
      docNode = parsed.doc;
      docThreads = parsed.threads.length > 0 ? parsed.threads : undefined;
      docId = parsed.docId;
    } else {
      const result = await fromDocxFull(openBytes);
      docNode = result.doc;
      docThreads = result.threads;
      docId = result.docId;
    }
    mountOpenedSingleDoc({
      docNode,
      docThreads,
      docId,
      name: src.name,
      handle: src.handle ?? null,
      format,
      dirty: src.recovered === true,
      recordAsRecent: !src.recovered,
    });
  } catch (err) {
    if (err instanceof NativeDamagedError) {
      await offerDamagedSalvage(src.name, openBytes);
      return;
    }
    console.error('Failed to load doc:', err);
    void alertDialog(`Failed to load: ${err instanceof Error ? err.message : err}`);
  }
}

/** The single-doc mount tail shared by a normal open and a salvage
 *  open (which passes handle: null so the first save forces Save As,
 *  preserving the damaged original on disk). */
function mountOpenedSingleDoc(args: {
  docNode: PMNode;
  docThreads: Thread[] | undefined;
  docId: string | null;
  name: string;
  handle: unknown;
  format: 'cmir' | 'docx';
  dirty: boolean;
  recordAsRecent: boolean;
}): void {
  // Opening replaces the current doc; clear its journal and
  // mint a fresh uid for the new session.
  void clearCurrentJournal();
  mountView(args.docNode, args.docThreads);
  currentDocFilename = args.name;
  setCurrentDocHandle(args.handle ?? null);
  currentDocFormat = args.format;
  // Restore this file's remembered autosave toggle (off if unknown).
  settings.set('autosaveEnabled', isAutosaveOnForPath(args.handle));
  currentDocUid = newSessionDocUid();
  adoptDocId(args.docId, args.name, args.handle ?? null, args.format);
  // A recovered journal / salvaged copy mounts dirty (no on-disk file
  // to be in sync with), so closing prompts to save; a normal open is
  // clean.
  if (args.dirty) markCurrentDocDirty();
  else markCurrentDocClean();
  syncSingleDocSpeechRegistration();
  markNonPristineStarter();
  updateWindowTitle();
  // A recovered/salvaged doc has no path yet — don't record an
  // unreopenable (handle-null) recent; Save records it once written.
  if (args.recordAsRecent) {
    recordRecent({
      handle: typeof args.handle === 'string' ? args.handle : null,
      filename: args.name,
      format: args.format,
    });
  }
  homeScreen.hide();
  console.log(`Loaded ${args.name}: ${countSummary(args.docNode)}`);
}

/** Damaged-file salvage offer (structural-integrity audit follow-on):
 *  when a .cmir fails the load check even after the heals, offer to
 *  open a repaired COPY with the minimal invalid subtrees removed.
 *  Consent-first with a concrete loss list; the copy mounts with no
 *  file handle so the first save forces Save As and the damaged
 *  original stays byte-intact for forensics; the drop report joins
 *  the local diagnostics log. */
async function offerDamagedSalvage(name: string, bytes: Uint8Array): Promise<void> {
  let salvaged: ReturnType<typeof parseNativeSalvage>;
  try {
    salvaged = parseNativeSalvage(bytes);
  } catch (err) {
    // Even salvage can't produce a valid doc — the plain refusal.
    void alertDialog(`Failed to load: ${err instanceof Error ? err.message : err}`);
    return;
  }
  // Step 1: plain compact offer — the loss details live in the
  // follow-up confirmation (field feedback 2026-07-27: a paragraph of
  // warning inside a full-width route button "sucks"; a lone action
  // belongs in a small button beside Cancel).
  const repair = await confirmDialog(
    'You can open a repaired copy instead. The original file is left untouched.',
    { title: `“${name}” is damaged and can’t be opened as-is.`, okLabel: 'Repair' },
  );
  if (!repair) return;

  // Step 2: the concrete-loss confirmation. Skipped when nothing needs
  // removing — there is no loss to warn about.
  if (salvaged.dropped.length > 0) {
    const previews = salvaged.dropped
      .slice(0, 8)
      .map((d) => `• ${d.type}${d.textPreview ? `: “${d.textPreview}”` : ' (no visible text)'}`);
    const more = salvaged.dropped.length - previews.length;
    const confirmed = await confirmDialog(
      previews.join('\n') +
        (more > 0 ? `\n…and ${more} more` : '') +
        '\n\nSaving the repaired copy will ask where to save it, instead of overwriting the original file.',
      {
        title: `Repairing removes ${salvaged.dropped.length} damaged element${salvaged.dropped.length === 1 ? '' : 's'}:`,
        okLabel: 'Open repaired copy',
      },
    );
    if (!confirmed) return;
  }
  try {
    const log = JSON.parse(localStorage.getItem('cm-save-heal-log') ?? '[]') as unknown[];
    log.push({ at: new Date().toISOString(), salvageOpen: name, dropped: salvaged.dropped });
    localStorage.setItem('cm-save-heal-log', JSON.stringify(log.slice(-20)));
  } catch {
    /* diagnostics only */
  }
  const repairedName = name.replace(/\.cmir$/i, '') + ' (repaired)';
  const threads = salvaged.threads.length > 0 ? salvaged.threads : undefined;
  if (multiDocActive && multiDocOnRecoveredDoc) {
    try {
      await multiDocOnRecoveredDoc({
        uid: newSessionDocUid(),
        filename: repairedName,
        handle: null,
        format: 'cmir',
        docId: salvaged.docId,
        doc: salvaged.doc,
        threads: salvaged.threads,
        dirty: true,
      });
    } catch (err) {
      void alertDialog(`Failed to open repaired copy: ${err instanceof Error ? err.message : err}`);
    }
    return;
  }
  mountOpenedSingleDoc({
    docNode: salvaged.doc,
    docThreads: threads,
    docId: salvaged.docId,
    name: repairedName,
    handle: null,
    format: 'cmir',
    dirty: true,
    recordAsRecent: false,
  });
  // The what-will-be-removed decision already happened in the consent
  // dialog above; this completion files as a durable notice so the
  // count stays findable after the toast fades.
  postNotice({
    severity: 'info',
    title: 'Opened a repaired copy',
    body:
      salvaged.dropped.length === 0
        ? 'Opened a repaired copy.'
        : `Opened a repaired copy — ${salvaged.dropped.length} damaged element${salvaged.dropped.length === 1 ? '' : 's'} removed.`,
  });
}

// ─── Home screen wiring ────────────────────────────────────────────
// The home screen is an overlay shown on launch (no file), when the
// last doc is closed, or via the Home button. Its actions load
// in-place (this window) rather than spawning a new window.

/** Parse + mount an opened file's bytes into THIS window, set the
 *  doc-state vars, record it in recents, and hide the home screen.
 *  Shared by the home screen's Open / Open-recent paths. */
async function loadFileInPlace(file: {
  filename: string;
  bytes: Uint8Array;
  // Electron path string OR a web FileSystemFileHandle object — flows to
  // `setCurrentDocHandle` so in-place Save works in both editions.
  handle: unknown;
  format: 'cmir' | 'docx';
  /** A recovered (.cmir-journal) doc: mount dirty, don't record a recent. */
  recovered?: boolean;
}): Promise<void> {
  // Decrypt a password-protected .docx (a compound file, not a zip)
  // before parsing; passes through for a normal file. Throws
  // OpenCancelledError / UnsupportedEncryptionError, handled by the
  // callers' catch.
  const openBytes = await maybeDecryptForOpen(file.bytes, file.filename);
  let docNode: PMNode;
  let docThreads: Thread[] | undefined;
  let docId: string | null = null;
  if (!bytesLookLikeDocx(openBytes)) {
    const parsed = parseNative(openBytes);
    docNode = parsed.doc;
    docThreads = parsed.threads.length > 0 ? parsed.threads : undefined;
    docId = parsed.docId;
  } else {
    const result = await fromDocxFull(openBytes);
    docNode = result.doc;
    docThreads = result.threads;
    docId = result.docId;
  }
  void clearCurrentJournal();
  mountView(docNode, docThreads);
  currentDocFilename = file.filename;
  setCurrentDocHandle(file.handle);
  currentDocFormat = file.format;
  // Restore this file's remembered autosave toggle (off if unknown).
  settings.set('autosaveEnabled', isAutosaveOnForPath(file.handle));
  currentDocUid = newSessionDocUid();
  adoptDocId(docId, file.filename, file.handle, file.format);
  if (file.recovered) markCurrentDocDirty();
  else markCurrentDocClean();
  syncSingleDocSpeechRegistration();
  markNonPristineStarter();
  updateWindowTitle();
  if (typeof file.handle === 'string' && file.handle) {
    const electron = getElectronHost();
    if (electron) void electron.openPathRegister(file.handle);
  }
  if (!file.recovered) {
    recordRecent({ handle: typeof file.handle === 'string' ? file.handle : null, filename: file.filename, format: file.format });
  }
  homeScreen.hide();
  // Focus AFTER hide (home hides the editor tree via ancestor CSS; a
  // focus() into display:none silently no-ops). 2026-07-27 focus
  // audit: no in-place open ever focused the new view — mountView
  // destroys the previously-focused view, dropping focus to body, so
  // keyboard chords went dead until a click landed on a text line.
  // Covers every caller: home Open tile, Cmd-O, recents, drag-drop.
  view?.focus();
}

const homeCallbacks: HomeScreenCallbacks = {
  // Single-doc: load in-place in this window. Multi-pane: hide
  // home and route through the shell flows, which present the
  // slot-routing UI over the now-visible workspace.
  newDoc: () => {
    if (multiDocActive) {
      homeScreen.hide();
      void multiDocOnNewDoc?.();
      return;
    }
    mountFreshBlankDoc();
    homeScreen.hide();
    // Focus AFTER hide: the home overlay hides the editor tree via an
    // ancestor CSS class, and focus() into a display:none subtree is a
    // silent no-op (2026-07-27 focus audit — this path never focused,
    // so a home-created doc ignored typing/styling until a click
    // landed on a text line).
    view?.focus();
  },
  newSpeechDoc: () => {
    if (multiDocActive) {
      homeScreen.hide();
      multiDocNewSpeechDocument?.();
      return;
    }
    void (async () => {
      const created = await createSpeechDocInPlace();
      if (created) homeScreen.hide();
    })();
  },
  open: () => {
    if (multiDocActive) {
      // runOpenFlow's multi-pane branch picks a file then routes
      // it through multiDocOnFileOpen (the slot picker).
      homeScreen.hide();
      void runOpenFlow();
      return;
    }
    void (async () => {
      const opened = await pickAndLoadInPlace();
      if (opened) homeScreen.hide();
    })();
  },
  openRecent: (recent: RecentFile) => {
    void openRecentInPlace(recent);
  },
  resumeSession: (roomId: string) => {
    void (async (): Promise<void> => {
      // Duplicate guards BEFORE any spawn, so a redundant click never mints
      // a stray window. This-window: the synchronous live-room probe.
      // Other-window: the session's claim in the duplicate-open registry —
      // probing it also focuses the owning window.
      if (collabRoomIsLive(roomId)) {
        homeScreen.hide(); // the live doc is somewhere in this window
        showToast('That session is already open in this window.');
        return;
      }
      let liveElsewhere = false;
      try {
        liveElsewhere =
          (await getElectronHost()?.openPathCheck(collabRoomClaimKey(roomId)))?.takenByOther ??
          false;
      } catch {
        /* openPath API absent (old preload / web) — skip the cross-window guard */
      }
      if (liveElsewhere) {
        showToast('That session is already open in another CardMirror window.');
        return;
      }
      homeScreen.hide();
      // Single-pane with a real doc behind the home screen: resume in a NEW
      // window (the session doc would otherwise evict this one) — the spawned
      // window opens a blank starter and runs the full resume, mirroring the
      // spawn-to-join flow.
      if (!multiDocActive && !isPristineStarter && getHost().canSpawnWindow) {
        void getHost()
          .spawnWindow({
            filename: '',
            bytes: new Uint8Array(),
            handle: null,
            format: null,
            uid: null,
            resumeRoomId: roomId,
          })
          .catch((err) => {
            console.error('Spawn-to-resume failed:', err);
            showToast('Could not open a new window for the session.');
          });
        return;
      }
      // Multi-pane resumes into a user-picked slot (the home screen is
      // reachable there via the Home button); a pristine single-pane
      // starter resumes in place.
      void loadCollabUi().then((m) =>
        m.resumeSessionFlow(multiDocActive ? makeMultiPaneSessionDeps() : collabDeps, roomId),
      );
    })();
  },
  manageQuickCards: () => {
    void quickCardsManageUI.open();
  },
  // Clean: Electron gets the folder-recursive modal; web cleans one file at a time.
  clean:
    getHost().kind === 'electron'
      ? () => openClean()
      : () => void runCleanSingleFileWeb(),
  // Bulk convert: folder modal on Electron; single-file Convert on web.
  bulkConvert:
    getHost().kind === 'electron'
      ? () => openBulkConvert()
      : () => void runConvertSingleFileWeb(),
  // Bulk compress: a retired early-alpha migration tool, dormant behind a
  // console gate (localStorage['pmd-compress']='1'). When closed the
  // callback is undefined, so the Home screen hides the Compress tile and
  // reflows Quick Cards + the number shortcuts into its place.
  bulkCompress: !bulkCompressEnabled()
    ? undefined
    : getHost().kind === 'electron'
      ? () => openBulkCompress()
      : () => void runCompressSingleFileWeb(),
};

/** Mount a fresh blank starter doc in this window, resetting the
 *  single-doc state vars. Shared by the home screen's New action
 *  and the close-doc-to-home path. Does NOT mark non-pristine —
 *  this is a clean blank, eligible to be replaced silently. */
function mountFreshBlankDoc(): void {
  void clearCurrentJournal();
  mountView(makeNewDocBody());
  currentDocFilename = null;
  setCurrentDocHandle(null);
  currentDocFormat = null;
  currentDocUid = newSessionDocUid();
  currentDocId = null; // new doc → minted on first save
  markCurrentDocClean();
  syncSingleDocSpeechRegistration();
  updateWindowTitle();
}

/** Close the current doc back to the home screen rather than
 *  closing the window. Confirms unsaved changes first (same
 *  prompt as the window-close flow). From home itself (no doc
 *  open) this is a no-op — the OS close button / quit path owns
 *  actually closing the window. */
async function handleCloseDocToHome(): Promise<void> {
  try {
    await handleCloseDocToHomeInner();
  } catch (err) {
    // Fail safe: a crash mid-flow reads as "didn't close" with a reason —
    // not a Home click that silently does nothing. The doc stays open.
    console.error('Close-to-home crashed:', err);
    void alertDialog(
      `Couldn't close this document: ${err instanceof Error ? err.message : err}`,
    );
  }
}

async function handleCloseDocToHomeInner(): Promise<void> {
  if (homeScreen.isVisible()) return;
  const finish = (): void => {
    mountFreshBlankDoc();
    homeScreen.show();
  };
  // A co-edited doc gets the session-aware close first (keep resumable vs
  // end/leave), naming the doc.
  const co = await resolveCoEditedClose(currentDocUid, currentDocFilename ?? '');
  if (co === 'cancel') return;
  if (co === 'keep') {
    // Session kept resumable — its record holds the content, so drop the
    // recovery journal and return home without the file save prompt.
    await clearCurrentJournal().catch(() => {});
    finish();
    return;
  }
  // co === 'run-normal': not co-edited, or the session was ended/left.
  if (!currentDocDirty) {
    finish();
    return;
  }
  const choice = await confirmCloseUnsaved();
  switch (choice) {
    case 'save': {
      if (await runSaveFlow()) finish();
      return;
    }
    case 'saveAs': {
      if (await runSaveAsFlow()) finish();
      return;
    }
    case 'discard': {
      await clearCurrentJournal().catch(() => {});
      finish();
      return;
    }
    case 'cancel':
      return;
  }
}

/** File-picker open that always loads in-place (never spawns a
 *  window) — used by the home screen. Returns true on success. */
async function pickAndLoadInPlace(): Promise<boolean> {
  let opened: OpenedFile | null;
  try {
    opened = await getHost().openFile({ filters: OPEN_FILE_FILTERS });
  } catch (err) {
    void alertDialog(`Failed to open: ${err instanceof Error ? err.message : err}`);
    return false;
  }
  if (!opened) return false;
  const src = await resolveOpenedFile(opened);
  if (src === 'corrupt') {
    void alertDialog('That .cmir-journal file is corrupt or could not be read.');
    return false;
  }
  if (src.handle != null && (await isFileOpenInAnotherWindow(src.handle))) {
    showToast(`"${src.name}" is already open in another window.`);
    return false;
  }
  try {
    await loadFileInPlace({
      filename: src.name,
      bytes: src.bytes,
      handle: src.handle,
      format: src.format,
      recovered: src.recovered,
    });
    return true;
  } catch (err) {
    if (err instanceof OpenCancelledError) return false; // user dismissed the password box
    if (err instanceof NativeDamagedError) {
      await offerDamagedSalvage(src.name, src.bytes);
      return false; // the ORIGINAL open failed; salvage mounts its own copy
    }
    void alertDialog(
      err instanceof UnsupportedEncryptionError
        ? err.message
        : `Failed to load: ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
}

/** Open a `.cmir` by absolute path (the command palette's file search).
 *  Reads the file, then routes through the shared open logic — so it
 *  spawns a NEW window (single-doc) or shows the slot picker
 *  (multi-pane) rather than overwriting the current window's doc. */
async function openFileByPath(path: string, name: string): Promise<void> {
  const electron = getElectronHost();
  if (!electron) return;
  let file: Awaited<ReturnType<typeof electron.readFileAtPath>>;
  try {
    file = await electron.readFileAtPath(path);
  } catch {
    file = null;
  }
  if (!file) {
    showToast(`Couldn't open "${name}" — file moved or deleted.`);
    return;
  }
  await routeOpenedFile({
    name: file.name,
    bytes: file.bytes,
    handle: file.handle,
    ...(file.emptyOnDisk === true ? { emptyOnDisk: true } : {}),
  });
}

/** Resolve `descriptor` against the active view's doc and select +
 *  scroll to it. Best-effort: toasts (using `name`) when the text can no
 *  longer be located, falls back to a caret when the range isn't a valid
 *  text selection, and tolerates a not-yet-laid-out position. Call inside
 *  a rAF after a mount so the DOM is measurable by preciseScrollIntoView. */
function focusDescriptorInActiveView(descriptor: AnchorDescriptor, name: string): void {
  const v = getActiveView();
  if (!v) return;
  const r = resolveDescriptor(v.state.doc, descriptor);
  if (!r) {
    showToast(`Opened "${name}", but couldn't locate the card's text — it may have changed.`);
    return;
  }
  // Select the anchored text when possible (highlights it); fall back to
  // a caret at its start if the range isn't a valid text selection.
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

/** "Show in context" from a flashcard review. Routes the card's source to
 *  a focused view of its anchored text:
 *   1. This window already shows the source → close the review (it covers
 *      the doc) and focus in place.
 *   2. Another window has it open → focus that window and message it to
 *      scroll to the anchor; the review stays up.
 *   3. Not open anywhere → spawn a new window carrying the anchor (which
 *      it focuses on mount); the review stays up.
 *   4. No window-spawning host (web) → close the review and open in place.
 *  `closeSession` dismisses the review overlay; called only in 1 / 4. */
async function showFlashcardSource(
  req: ShowInContextRequest,
  closeSession: () => void,
): Promise<void> {
  const host = getHost();
  const electron = getElectronHost();

  // Multi-pane: the workspace is this one window, so route the source
  // into a slot here (never a separate window). The review + home both
  // cover the whole workspace, so close them to reveal the focused pane.
  if (multiDocActive && multiDocShowInContext) {
    closeSession();
    homeScreen.hide();
    await multiDocShowInContext(req);
    return;
  }

  // 1 / 4 — opens in THIS window: close the review AND the home screen
  // (both overlay the doc) so the focused text is actually visible, then
  // focus on the next frame.
  const openInThisWindow = async (reopen: boolean): Promise<void> => {
    closeSession();
    homeScreen.hide();
    if (reopen) await openFileByPath(req.path, req.name);
    requestAnimationFrame(() => focusDescriptorInActiveView(req.descriptor, req.name));
  };

  if (!electron || !host.canSpawnWindow) {
    // Web: no separate windows — replace the doc here (unless it's
    // already current) and focus.
    const isCurrent = typeof currentDocHandle === 'string' && currentDocHandle === req.path;
    await openInThisWindow(!isCurrent);
    return;
  }

  // 1 — the source IS this window's current doc: don't spawn a duplicate;
  // close the review and focus the already-open doc in place.
  if (typeof currentDocHandle === 'string' && currentDocHandle === req.path) {
    await openInThisWindow(false);
    return;
  }

  // 2 — open in another window: focus it + have it scroll to the anchor.
  const { delivered } = await electron.focusAnchorInWindow(req.path, req.descriptor);
  if (delivered) return;

  // 3 — not open anywhere: spawn a new window that focuses the anchor.
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
  const format = formatFromFilename(file.name) ?? 'docx';
  await host.spawnWindow({
    filename: file.name,
    bytes: file.bytes,
    handle: typeof file.handle === 'string' ? file.handle : null,
    format,
    uid: null,
    focusAnchor: req.descriptor,
    ...(file.emptyOnDisk === true ? { emptyOnDisk: true } : {}),
  });
}
setShowInContextHandler((req, closeSession) => void showFlashcardSource(req, closeSession));
// Receive a cross-window "scroll to this anchor" request — this window
// owns the path another window's "Show in context" targeted. Wired for
// every window (single-doc or multi-pane), unlike the OS-open listener.
getElectronHost()?.onFocusAnchor(({ descriptor }) => {
  requestAnimationFrame(() =>
    focusDescriptorInActiveView(descriptor, currentDocFilename || 'document'),
  );
});

/** Subscribe to main's `host:external-open` forward (an OS "Open
 *  with… CardMirror" routed to this existing multi-pane window). Opens
 *  the path through the standard routing, so it lands in this window's
 *  slot picker rather than a blank new window. */
function installExternalOpenListener(): void {
  const electron = getElectronHost();
  if (!electron) return;
  electron.onExternalOpen(({ path }) => {
    void openFileByPath(path, path.replace(/^.*[\\/]/, ''));
  });
}

/** Drag-and-drop file opening (desktop). Dropping a .cmir / .cmir-journal /
 *  .docx anywhere in the window opens it through the normal pipeline
 *  (`openFileByPath` → dedup, unsaved-changes prompt, recovery-journal
 *  handling all apply). Other file types fall through untouched. No-op on the
 *  web edition, which has no filesystem paths to open. */
function installDragToOpen(): void {
  const electron = getElectronHost();
  if (!electron) return;
  const SUPPORTED = /\.(cmir|cmir-journal|docx)$/i;
  // Permit the drop (and suppress Electron's default navigate-to-the-file) only
  // while an OS file is being dragged — internal card drags carry no 'Files'
  // type, so drag-and-drop card moves are left completely untouched.
  document.addEventListener(
    'dragover',
    (e) => {
      if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
    },
    true,
  );
  // Capture phase + stopPropagation so a drop on the editor is handled here
  // instead of by ProseMirror. Only supported doc files are intercepted; an
  // unsupported file (e.g. an image the editor may handle) falls through.
  document.addEventListener(
    'drop',
    (e) => {
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const file = Array.from(files).find((f) => SUPPORTED.test(f.name));
      if (!file) return;
      e.preventDefault();
      e.stopPropagation();
      const path = electron.getPathForFile(file);
      if (!path) {
        showToast(`Couldn't open “${file.name}” — try dragging it from a folder.`);
        return;
      }
      void openFileByPath(path, file.name);
    },
    true,
  );
}

/** A window spawned for an OS open carries an initial doc. Single-doc
 *  boot mounts it in place; multi-pane boot can't (the workspace owns
 *  layout), so route it through the slot picker instead of leaving the
 *  window blank. Returns true if a payload was consumed. */
async function routeInitialDocIntoWorkspace(): Promise<boolean> {
  const host = getHost();
  // Check for a spawn payload regardless of this window's own canSpawnWindow — a
  // web window spawned into a plain browser tab isn't standalone but still
  // carries a doc. `getInitialDoc` returns null cheaply when there's none.
  let payload: Awaited<ReturnType<typeof host.getInitialDoc>>;
  try {
    payload = await host.getInitialDoc();
  } catch (err) {
    console.warn('getInitialDoc failed:', err);
    payload = null;
  }
  if (!payload) return false;
  // A spawn-to-join payload landing in a window that booted into the
  // multi-pane workspace: run the join here through the slot-picker deps.
  // Without this the empty-bytes payload fell through to the file-open
  // path and dead-ended in "This file is empty or hasn't finished
  // downloading…" (field bug, 2026-07-10). Multi-pane windows no longer
  // spawn join windows themselves, so this only catches stale payloads
  // and races around a mode toggle — but it catches them correctly.
  if (payload.joinShareCode) {
    const m = await loadCollabUi();
    await m.joinSessionWithCode(makeMultiPaneSessionDeps(), payload.joinShareCode);
    return true;
  }
  // Same for a spawn-to-resume payload: run the resume through the
  // slot-picker deps rather than dead-ending the empty-bytes payload.
  if (payload.resumeRoomId) {
    const m = await loadCollabUi();
    await m.resumeSessionFlow(makeMultiPaneSessionDeps(), payload.resumeRoomId);
    return true;
  }
  await routeOpenedFile({
    name: payload.filename,
    bytes: payload.bytes,
    handle: payload.handle ?? null,
    ...(payload.emptyOnDisk === true ? { emptyOnDisk: true } : {}),
  });
  return true;
}

/** Reopen a recent file in-place via its stored path handle.
 *  Prunes the entry if the file is gone / unreadable. */
async function openRecentInPlace(recent: RecentFile): Promise<void> {
  const electron = getElectronHost();
  if (!electron || recent.handle == null) return;
  let file = await electron.readFileAtPath(recent.handle);
  if (!file) {
    showToast(`Couldn't open "${recent.filename}" — file moved or deleted.`);
    removeRecent(recent.handle);
    return;
  }
  // Genuinely-empty file (stat size 0): open blank instead of erroring —
  // same substitution resolveOpenedFile does for the Open-dialog path;
  // this path bypasses it, so substitute once here for all three exits.
  if (opensAsBlank(file)) {
    file = {
      ...file,
      bytes: await blankDocumentBytes(file.format, makeBlankNewDoc(), {
        defaultFont: settings.get('bodyFont'),
      }),
    };
  }
  const { takenByOther } = await electron.openPathCheck(file.handle);
  if (takenByOther) {
    showToast(`"${file.name}" is already open in another window.`);
    homeScreen.hide();
    return;
  }
  // Multi-pane: hide home and route through the shell's slot
  // picker (same as Open). Single-doc: load in-place here.
  if (multiDocActive && multiDocOnFileOpen) {
    homeScreen.hide();
    try {
      await multiDocOnFileOpen({
        name: file.name,
        bytes: file.bytes,
        handle: file.handle,
      });
    } catch (err) {
      void alertDialog(`Failed to open: ${err instanceof Error ? err.message : err}`);
    }
    return;
  }
  // Single-pane with a real doc behind the home screen (Home button):
  // don't evict it — open the recent in a NEW window, matching the
  // one-doc-per-window convention everywhere else on desktop. The
  // pristine starter (home at launch) still loads in place below.
  if (!isPristineStarter && electron.canSpawnWindow) {
    // Already open in THIS window? (openPathCheck above treats own claims
    // as free, so without this a recent pointing at the doc behind the
    // home screen would mint a duplicate window.) Hiding home lands the
    // user on the doc they asked for.
    if (currentDocHandle != null && (await isSameOpenHandle(currentDocHandle, file.handle))) {
      homeScreen.hide();
      return;
    }
    homeScreen.hide();
    try {
      await electron.spawnWindow({
        filename: file.name,
        bytes: file.bytes,
        handle: file.handle,
        format: file.format,
        uid: null,
      });
    } catch (err) {
      void alertDialog(`Failed to open new window: ${err instanceof Error ? err.message : err}`);
    }
    return;
  }
  try {
    await loadFileInPlace({
      filename: file.name,
      bytes: file.bytes,
      handle: file.handle,
      format: file.format,
    });
  } catch (err) {
    if (err instanceof OpenCancelledError) return; // user dismissed the password box
    if (err instanceof NativeDamagedError) {
      await offerDamagedSalvage(file.name, file.bytes);
      return;
    }
    void alertDialog(
      err instanceof UnsupportedEncryptionError
        ? err.message
        : `Failed to load: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/** Build + mount a new speech doc in THIS window (home-screen
 *  flow). Prompts for the speech name like the ribbon's New Speech,
 *  but mounts in-place rather than spawning a window. Returns true
 *  when a doc was created (false on cancel). */
async function createSpeechDocInPlace(): Promise<boolean> {
  const speechName = await promptForText({
    message: 'Which speech? (e.g. 1NC, 2AC Round 3 vs Hogwarts)',
    placeholder: '1NC',
    okLabel: 'Create',
  });
  if (!speechName) return false;
  const format = settings.get('defaultSpeechDocFormat');
  const filename = formatSpeechFilename(speechName, format);
  const docNode = settings.get('includeSpeechDocPocket')
    ? makeSpeechBlankDoc(filename.replace(/\.(cmir|docx)$/i, ''))
    : makeNewDocBody();
  void clearCurrentJournal();
  mountView(docNode);
  currentDocFilename = null;
  setCurrentDocHandle(null);
  currentDocFormat = null;
  currentDocUid = newSessionDocUid();
  currentDocId = null; // new doc → minted on first save
  markCurrentDocClean();
  syncSingleDocSpeechRegistration();
  markNonPristineStarter();
  updateWindowTitle();
  // Mark this new doc as the speech doc for the session.
  getSpeechDocResolver().setSpeechByUid(currentDocUid);
  return true;
}

/** Strip the known extensions off a filename so the Save-As dialog
 *  can re-attach the right one based on the chosen format. */
function basenameWithoutExt(name: string): string {
  for (const ext of ['.cmir', '.docx']) {
    if (name.toLowerCase().endsWith(ext)) return name.slice(0, -ext.length);
  }
  return name;
}

/** Read the active file's filename + handle + format. In multi-doc
 *  mode this is the focused pane's record; in single-doc it's the
 *  module-level `currentDoc*` values. */
function activeFile(): { filename: string | null; handle: unknown | null; format: 'cmir' | 'docx' | null } {
  if (multiDocActive && multiDocGetFocusedFile) {
    const f = multiDocGetFocusedFile();
    if (f) return { filename: f.filename, handle: f.handle, format: f.format };
  }
  return { filename: currentDocFilename, handle: currentDocHandle, format: currentDocFormat };
}

/** Apply a save result back into the active file's record — chip
 *  label, in-place-save handle, and format all update together. */
function commitSaveResult(filename: string, handle: unknown | null, format: 'cmir' | 'docx'): void {
  if (multiDocActive && multiDocSetFocusedFile) {
    multiDocSetFocusedFile({ filename, handle, format });
  } else {
    currentDocFilename = filename;
    setCurrentDocHandle(handle);
    currentDocFormat = format;
  }
  // A (re)named doc that owns a live session republishes its title to
  // the room — a session started on an untitled doc gets its name the
  // moment the host saves, and joiners adopt it via the meta watcher.
  // `?.` on the module promise: never force-loads collab for a plain save.
  void collabUiModule?.then((m) => m.republishSessionTitle(activeDocIdentity().sessionUid));
  // A committed save (e.g. Save-As of a recovered draft) writes the content
  // to a real file, so it's no longer a stale-recovery-overwrite candidate.
  clearRecoveredDraftMark(activeDocIdentity().sessionUid);
  updateWindowTitle();
  // Format/handle may have changed (e.g., Save-As from unsaved →
  // .cmir-with-handle), which flips the autosave button between
  // inert and effective states. A new handle also moots any earlier
  // autosave failure (the stale-path rescue lands here via Save As).
  reportAutosaveSuccess();
  refreshAutosaveBtn();
  // A save (especially Save-As, which mints a path for a
  // previously-unsaved doc) makes the file recents-worthy.
  recordRecent({
    handle: typeof handle === 'string' ? handle : null,
    filename,
    format,
  });
}

/** Public refresh hook. Multi-pane callers invoke this whenever a
 *  slot's visible doc changes (open, close, save-as rename) so the
 *  OS title — which summarizes every open slot — stays in sync
 *  even when the change doesn't move focus. */
export function refreshWindowTitle(): void {
  updateWindowTitle();
}

function pushSingleDocInfo(): void {
  const electronHost = getElectronHost();
  if (!electronHost || multiDocActive) return;
  // Only push for the single-doc layout's main view. Multi-pane
  // pushes per-record from its own filename-change hooks.
  if (registeredSingleDocUid === null) return;
  void electronHost.docInfoUpdate(registeredSingleDocUid, currentDocFilename);
}

/** Sync the active filename into the OS title bar (`document.title`)
 *  AND the in-app filename chip — the chip is the user-facing source
 *  of truth where the OS title isn't visible (frameless Electron
 *  windows, tiling WMs, hidden title-bar themes). Cheap; called on
 *  open / save / multi-doc focus change. Title format: single-doc
 *  `${filename} — CardMirror` ('CardMirror' if untitled); multi-pane
 *  joins every non-empty slot's name — the per-pane chip already
 *  identifies the focused doc, so the title serves as a workspace
 *  summary. */
function updateWindowTitle(): void {
  const focused = activeFile();
  pushSingleDocInfo();
  if (multiDocActive && multiDocGetAllFilenames) {
    const names = multiDocGetAllFilenames().filter((n): n is string => !!n);
    document.title = names.length > 0
      ? `${names.join(' · ')} — CardMirror`
      : 'CardMirror';
  } else {
    document.title = focused.filename
      ? `${focused.filename} — CardMirror`
      : 'CardMirror';
  }
  // In-app filename chip. The chip itself is CSS-hidden in
  // multi-pane mode (each per-pane chip shows the pane's own
  // filename), so the JS update is a no-op there visually — but
  // we still write the focused doc's filename so a mode-switch
  // back to single-doc doesn't surface a stale label. The chip
  // is `[hidden]`-toggled when there's no filename at all
  // (untitled / onboarding / fresh doc before Save-As) so the
  // empty chip doesn't sit in the ribbon as visual noise.
  const chip = document.getElementById('doc-name-chip');
  const chipText = document.getElementById('doc-name-chip-text');
  if (chip && chipText) {
    chipText.textContent = focused.filename ?? '';
    chip.setAttribute('title', focused.filename ?? '');
    chip.toggleAttribute('hidden', !focused.filename);
  }
}

/** 1–2 letter initials from a display name, for a baked-in comment's
 *  margin badge. */
function initialsForName(name: string): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return ((parts[0]![0] ?? '') + (parts[parts.length - 1]![0] ?? '')).toUpperCase();
  }
  return (parts[0]?.slice(0, 2) ?? '').toUpperCase();
}

/** Bake private LearnStore threads (notes and/or AI threads) into an
 *  export doc as real `comment_range` marks + comment threads — the
 *  opt-in "include notes / AI comments on export" path. Each entity's
 *  anchor is resolved against `doc`; entities whose text didn't survive
 *  the export transform, or that have no turns, are skipped. Returns the
 *  marked-up doc plus the converted threads for the serializer. */
function bakePrivateThreadsIntoDoc(
  doc: PMNode,
  opts: { includeNotes: boolean; includeAiThreads: boolean },
): { doc: PMNode; threads: Thread[] } {
  const docId = activeDocIdentity().docId;
  if (!docId) return { doc, threads: [] };
  const markType = schema.marks['comment_range'];
  if (!markType) return { doc, threads: [] };
  const sources: { anchor: AnchorDescriptor | null; comments: LocalComment[] }[] = [];
  if (opts.includeAiThreads) sources.push(...learnStore.aiThreadsForDoc(docId));
  if (opts.includeNotes) sources.push(...learnStore.notesForDoc(docId));
  if (sources.length === 0) return { doc, threads: [] };
  let state = EditorState.create({ doc, schema });
  const threads: Thread[] = [];
  for (const src of sources) {
    if (!src.anchor || src.comments.length === 0) continue;
    const r = resolveDescriptor(state.doc, src.anchor);
    if (!r) continue; // text didn't survive the transform / unresolvable
    const rootId = newCommentId();
    const comments: Comment[] = src.comments.map((c, i) => ({
      id: i === 0 ? rootId : newCommentId(),
      author: c.author || 'You',
      initials: initialsForName(c.author),
      date: c.at,
      text: c.text,
      kind: c.ai ? 'ai' : 'human',
      parentId: i === 0 ? null : rootId,
    }));
    threads.push({ id: rootId, comments });
    state = state.apply(
      state.tr.addMark(r.from, r.to, markType.create({ threadId: rootId })),
    );
  }
  return { doc: state.doc, threads };
}

/** Serialize the active doc into bytes in the given format. Shared
 *  by the Save and Save-As flows. The `opts` arg controls export-
 *  time filtering (read mode, drop analytics / undertags / comments)
 *  and the opt-in baking of private notes / AI threads into comments. */
async function serializeForSave(
  format: 'cmir' | 'docx',
  opts: {
    includeComments: boolean;
    includeAnalytics: boolean;
    includeUndertags: boolean;
    readMode: boolean;
    /** Bake private notes into the file as real comments (opt-in). */
    includeNotes?: boolean;
    /** Bake AI threads into the file as real comments (opt-in). */
    includeAiThreads?: boolean;
    /** Keep only the cards that contain a reading marker, flat. */
    markedCardsOnly?: boolean;
  },
  /** Stable doc identity to embed (`.cmir` field / `.docx` docProps).
   *  Omitted for derived/lossy exports, which stay clean (no identity). */
  docId?: string,
): Promise<Uint8Array> {
  const docToExport = view ? view.state.doc : currentDoc;
  let exportDocNode = transformForExport(docToExport, {
    includeComments: opts.includeComments,
    includeAnalytics: opts.includeAnalytics,
    includeUndertags: opts.includeUndertags,
    readMode: opts.readMode,
    markedCardsOnly: opts.markedCardsOnly ?? false,
    markUnreadAfterMarker: settings.get('markUnreadAfterMarker'),
  });
  if (view) gcOrphanThreads(view);
  const baseThreads =
    opts.includeComments && view
      ? Array.from(getCommentsState(view.state).threads.values())
      : [];
  // Opt-in: convert the private annotation layer (notes / AI threads)
  // into real comments baked onto the export doc. Never touches the
  // working doc — this is a snapshot.
  const extraThreads: Thread[] = [];
  if (opts.includeNotes || opts.includeAiThreads) {
    const baked = bakePrivateThreadsIntoDoc(exportDocNode, {
      includeNotes: !!opts.includeNotes,
      includeAiThreads: !!opts.includeAiThreads,
    });
    exportDocNode = baked.doc;
    extraThreads.push(...baked.threads);
  }
  const allThreads = [...baseThreads, ...extraThreads];
  const threadsOpt = allThreads.length > 0 ? { threads: allThreads } : {};
  if (format === 'cmir') {
    // Async gzip: the DEFLATE runs off the main thread, so autosave's
    // debounced firing doesn't stall typing (manual saves get the same
    // benefit for free). Output bytes are identical to the sync path.
    // `.cmir` keeps intra-doc windows (self_ref) as live references — the
    // source is in the same file, so the file stays self-contained.
    return serializeNativeAsync(exportDocNode, { ...threadsOpt, ...(docId ? { docId } : {}) });
  }
  // Word has no live-window concept: materialize each self_ref window to real
  // cards (resolved from the source, ids re-stamped) before export.
  const docxNode = flattenSelfRefs(exportDocNode, newHeadingId);
  return toDocx(docxNode, { ...threadsOpt, ...(docId ? { docId } : {}), defaultFont: settings.get('bodyFont') });
}

/**
 * Run the Save As flow. Returns `true` when the user committed to a
 * save (and the bytes hit disk / downloaded), `false` when they
 * cancelled the dialog or the OS file picker.
 */
/** Live views + linked copies in the doc a save would serialize — the same
 *  doc `serializeForSave` exports (`view` when present, else `currentDoc`).
 *  A matched node isn't descended into: whatever it contains is part of the
 *  view/copy being flattened, not a separately-droppable link. */
function activeSaveDocLiveLinkCounts(): { views: number; copies: number } {
  const doc = view ? view.state.doc : currentDoc;
  const counts = { views: 0, copies: 0 };
  if (!doc) return counts;
  doc.descendants((node) => {
    if (isSelfRef(node)) {
      counts.views++;
      return false;
    }
    if (isTransclusionNode(node)) {
      counts.copies++;
      return false;
    }
    return true;
  });
  return counts;
}

/** Warn before a `.docx` write that would flatten live views / linked copies.
 *  Word can't store live links, so saving to `.docx` drops them (the content
 *  stays, the link doesn't) — a silent, one-way loss if the doc is later
 *  reopened from that `.docx`. Every `.docx`-writing path asks: Save, Save As,
 *  and the close/quit prompts in both layouts all route through
 *  `runSaveFlow` / `runSaveAsFlow` (autosave never writes `.docx`).
 *  Returns true to proceed, false to cancel. `.cmir` saves never ask. */
async function confirmDocxDropsLiveLinks(): Promise<boolean> {
  const { views, copies } = activeSaveDocLiveLinkCounts();
  const total = views + copies;
  if (total === 0) return true;
  const parts: string[] = [];
  if (views > 0) parts.push(views === 1 ? 'a live view' : `${views} live views`);
  if (copies > 0) parts.push(copies === 1 ? 'a linked copy' : `${copies} linked copies`);
  const what = parts.join(' and ');
  const them = total === 1 ? 'it' : 'them';
  return showConfirm({
    title: 'Saving to Word drops live links',
    message:
      `This document contains ${what}. Word (.docx) files can't hold live links, ` +
      `so saving to .docx flattens ${them} to plain cards — the content stays, but the ` +
      `link to the source is dropped and won't come back when you reopen the .docx. ` +
      `Save as CardMirror (.cmir) instead to keep ${them} live.`,
    confirmLabel: 'Save to Word anyway',
    cancelLabel: 'Cancel',
  });
}

/** Hardened Save-As entry: the flow must NEVER reject — callers range from
 *  fire-and-forget buttons (`void runSaveAsFlow()`) to close/quit handlers
 *  where an escaped rejection silently aborts the close (field bug
 *  2026-07-12: "click Save As → nothing happens"). A crash anywhere in the
 *  flow now surfaces as an explicit dialog and reads as a failed save. */
export async function runSaveAsFlow(): Promise<boolean> {
  try {
    return await runSaveAsFlowInner();
  } catch (err) {
    console.error('Save As flow crashed:', err);
    void alertDialog(
      `Save As failed unexpectedly: ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
}

async function runSaveAsFlowInner(): Promise<boolean> {
  const file = activeFile();
  const suggestedName = basenameWithoutExt(file.filename ?? 'untitled');
  // Existing on-disk handle wins (preserves the file's current
  // format on Save As); otherwise honor the user's preferred
  // default for new docs.
  const defaultFormat: 'cmir' | 'docx' = file.format ?? settings.get('defaultSaveFormat');
  const choice = await openSaveAs({
    initialFilename: suggestedName,
    defaultFormat,
  });
  if (!choice) return false;
  // Writing to .docx flattens live views / linked copies — confirm first.
  if (choice.format === 'docx' && !(await confirmDocxDropsLiveLinks())) return false;
  // A full-fidelity save (everything included, not read-mode) IS the
  // working document written to disk, so the doc adopts the new
  // name / handle / format. Anything that drops content — the Send
  // Doc / Read Doc presets, or a Save Custom with boxes unchecked —
  // produces a separate, lossy export: the working document keeps
  // its own identity (otherwise it would think it's named e.g.
  // SEND_X and the duplicate-open guard would block reopening that
  // export), its dirty state, and its recovery journal.
  // Baking the private layer (notes / AI threads) into the file is a
  // one-way snapshot, so it's a derived export too — the working doc
  // keeps its own identity AND its private layer (otherwise reopening
  // would double-load the notes as both comments and re-anchored notes).
  const isFullSave =
    choice.includeComments &&
    choice.includeAnalytics &&
    choice.includeUndertags &&
    !choice.readMode &&
    !choice.includeNotes &&
    !choice.includeAiThreads &&
    !choice.markedCardsOnly;
  try {
    // A full Save As is a distinct logical doc → fork a new docId (the
    // original file keeps its own). Derived/lossy exports get no docId
    // (clean copies). Works in both layouts via the focused-doc identity.
    const forkDocId = isFullSave ? crypto.randomUUID() : undefined;
    // Before serializing, same as runSaveFlowInner — mid-write edits
    // must keep the doc dirty. Only consumed on the full-save path.
    const commitClean = captureActiveDocCleanToken();
    // Same pre-write watchdog as the in-place save: a hung serialize
    // here suppressed even the OS file picker (field case 2026-08-29).
    const bytes = await warnIfSlow(
      serializeForSave(
        choice.format,
        {
          includeComments: choice.includeComments,
          includeAnalytics: choice.includeAnalytics,
          includeUndertags: choice.includeUndertags,
          readMode: choice.readMode,
          includeNotes: choice.includeNotes,
          includeAiThreads: choice.includeAiThreads,
          markedCardsOnly: choice.markedCardsOnly,
        },
        forkDocId,
      ),
      choice.filename,
    );
    const result = await getHost().saveAs(choice.filename, bytes, {
      filters: saveFiltersForFormat(choice.format),
      // Open the dialog next to the doc's current path (or, after a
      // rename/move broke it, the nearest surviving parent folder).
      ...(typeof file.handle === 'string' && file.handle ? { nearPath: file.handle } : {}),
    });
    if (!result) return false;
    if (isFullSave) {
      // Read the pre-fork identity before committing the new file
      // (commitSaveResult leaves docId untouched, but read first to be
      // explicit about which doc we're forking FROM).
      const { docId: srcDocId, sessionUid } = activeDocIdentity();
      // Did this doc have a real on-disk original? (file.handle is the
      // PRE-save handle.) A never-saved doc has no original to preserve,
      // so its annotations MOVE to the new file rather than copy —
      // otherwise an in-doc flashcard's minted docId would linger as a
      // phantom "Untitled" group.
      const hadOnDiskOriginal = file.handle != null;
      commitSaveResult(result.name, result.handle ?? null, choice.format);
      if (forkDocId) {
        if (srcDocId && hadOnDiskOriginal) {
          // Real file → fork: the original keeps its cards; the copy
          // follows the new file.
          learnStore.copyDocAnnotations(srcDocId, forkDocId);
        } else if (srcDocId) {
          // Never-saved doc whose docId was minted by an in-doc
          // flashcard: move it, don't copy.
          learnStore.rekeyDoc(srcDocId, forkDocId);
        } else {
          // Never-saved + never-minted: annotations are still under the
          // session uid.
          learnStore.rekeyDoc(sessionUid, forkDocId);
        }
        setActiveDocId(forkDocId);
        learnStore.registerDoc({
          docId: forkDocId,
          path: typeof result.handle === 'string' ? result.handle : null,
          name: result.name,
          format: choice.format,
        });
      }
      // Successful save — mark clean + drop the now-redundant journal,
      // unless edits landed while the write was in flight.
      commitClean();
    } else {
      // Derived export: still surface the new file in recents so it's
      // reachable, but don't touch the working doc's identity / state.
      recordRecent({
        handle: typeof result.handle === 'string' ? result.handle : null,
        filename: result.name,
        format: choice.format,
      });
    }
    flashSaveSuccess();
    markNonPristineStarter();
    return true;
  } catch (err) {
    console.error('Save failed:', err);
    const lockedMsg = fileLockedMessage(err);
    void alertDialog(`Save failed: ${lockedMsg ?? (err instanceof Error ? err.message : err)}`);
    return false;
  }
}

/**
 * Save a Send Doc silently — the keyboard-bindable automation of the
 * Save-As dialog's "Send Doc" preset. A send doc drops comments,
 * analytics, and undertags (full, non-read-mode export). The
 * destination comes from settings: `sendDocDestination` chooses between
 * the source file's own folder (`sameFolder`) and a fixed folder
 * (`sendDocFolder`); the format follows `defaultSaveFormat`; the `SEND_`
 * prefix honors `prefixPresetSaveFilenames` (same as the preset).
 *
 * Falls back to the OS Save-As dialog when the silent destination can't
 * be resolved — a never-saved doc in same-folder mode, an unset fixed
 * folder, a name collision with the source file, or a non-Electron host.
 *
 * Like the preset, this is a lossy export: the working document keeps
 * its own identity, dirty state, and recovery journal. Returns `true`
 * when bytes hit disk, `false` on cancel / error.
 */
export async function runSaveSendDocFlow(): Promise<boolean> {
  const file = activeFile();
  const format: 'cmir' | 'docx' = settings.get('defaultSaveFormat');
  const base = basenameWithoutExt(file.filename ?? 'untitled');
  const filename =
    (settings.get('prefixPresetSaveFilenames') ? settings.get('sendDocPrefix') : '') +
    `${base}.${format}`;

  // Resolve the silent destination. Fixed-folder mode needs a configured path;
  // same-folder mode needs an on-disk source. Either missing → the dialog
  // fallback below. `sourceHandle` is ALWAYS passed to the IPC so the desktop
  // refuses to overwrite the ORIGINAL document (returns 'collision' → we defer
  // to the dialog) in BOTH modes — including when a custom/empty prefix would
  // land the export on the source's exact path.
  const sourceHandle =
    typeof file.handle === 'string' && file.handle ? file.handle : null;
  const fixedFolderMode = settings.get('sendDocDestination') === 'fixedFolder';
  const folder = fixedFolderMode ? settings.get('sendDocFolder') || null : null;
  const destResolvable = fixedFolderMode ? folder !== null : sourceHandle !== null;

  try {
    // Send Doc filtering — drop comments / analytics / undertags. Lossy
    // export → no docId embedded (stays a clean copy).
    const bytes = await serializeForSave(format, {
      includeComments: false,
      includeAnalytics: false,
      includeUndertags: false,
      readMode: false,
    });

    const electron = getElectronHost();
    let result: { name: string; handle?: unknown } | null = null;
    if (electron && destResolvable) {
      const silent = await electron.saveSendDoc(
        { folder, siblingHandle: sourceHandle, filename },
        bytes,
      );
      if (silent === 'collision') {
        // Target would overwrite the SOURCE document (a custom/empty prefix +
        // same folder/format) — defer to the dialog so the user can rename.
        result = await getHost().saveAs(filename, bytes, {
          filters: saveFiltersForFormat(format),
          ...(sourceHandle ? { nearPath: sourceHandle } : {}),
        });
      } else {
        result = silent;
      }
    } else {
      // Never-saved doc (same-folder mode), unset fixed folder, or a
      // non-Electron host → let the OS dialog pick the location.
      result = await getHost().saveAs(filename, bytes, {
        filters: saveFiltersForFormat(format),
        ...(sourceHandle ? { nearPath: sourceHandle } : {}),
      });
    }
    if (!result) return false;
    // Surface the export in recents so it's reachable, but never touch
    // the working doc's identity / dirty state (it's a derived copy).
    recordRecent({
      handle: typeof result.handle === 'string' ? result.handle : null,
      filename: result.name,
      format,
    });
    flashSaveSuccess();
    markNonPristineStarter();
    return true;
  } catch (err) {
    console.error('Send doc save failed:', err);
    void alertDialog(`Send doc save failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/**
 * Save Marked Cards silently — the keyboard-bindable automation of the Save-As
 * dialog's "Marked Cards" preset. Extracts only the cards containing a reading
 * marker (flat — no headings, no analytics). Destination comes from settings:
 * `markedCardsDestination` chooses the source file's folder (`sameFolder`) or a
 * fixed folder (`markedCardsFolder`); the format follows `defaultSaveFormat`;
 * the `MARKED_` prefix honors `prefixPresetSaveFilenames`. Same dialog fallbacks
 * and derived-export semantics (working doc untouched) as Save Send Doc. No-ops
 * with a toast when nothing is marked. Returns `true` when bytes hit disk.
 */
export async function runSaveMarkedCardsFlow(): Promise<boolean> {
  const docToExport = view ? view.state.doc : currentDoc;
  if (countMarkedCards(docToExport) === 0) {
    showToast('No marked cards to save.');
    return false;
  }
  const file = activeFile();
  const format: 'cmir' | 'docx' = settings.get('defaultSaveFormat');
  const base = basenameWithoutExt(file.filename ?? 'untitled');
  const filename =
    (settings.get('prefixPresetSaveFilenames') ? settings.get('markedDocPrefix') : '') +
    `${base}.${format}`;

  // Always pass the source path so the desktop refuses to overwrite the original
  // (→ 'collision' → dialog) in BOTH destination modes; see runSaveSendDocFlow.
  const sourceHandle =
    typeof file.handle === 'string' && file.handle ? file.handle : null;
  const fixedFolderMode = settings.get('markedCardsDestination') === 'fixedFolder';
  const folder = fixedFolderMode ? settings.get('markedCardsFolder') || null : null;
  const destResolvable = fixedFolderMode ? folder !== null : sourceHandle !== null;

  try {
    const bytes = await serializeForSave(format, {
      includeComments: false,
      includeAnalytics: false,
      includeUndertags: true,
      readMode: false,
      markedCardsOnly: true,
    });

    const electron = getElectronHost();
    let result: { name: string; handle?: unknown } | null = null;
    if (electron && destResolvable) {
      // Reuse the Send Doc silent-write IPC — it writes bytes to a
      // folder/sibling + filename, agnostic to what the bytes are.
      const silent = await electron.saveSendDoc(
        { folder, siblingHandle: sourceHandle, filename },
        bytes,
      );
      if (silent === 'collision') {
        result = await getHost().saveAs(filename, bytes, {
          filters: saveFiltersForFormat(format),
          ...(sourceHandle ? { nearPath: sourceHandle } : {}),
        });
      } else {
        result = silent;
      }
    } else {
      result = await getHost().saveAs(filename, bytes, {
        filters: saveFiltersForFormat(format),
        ...(sourceHandle ? { nearPath: sourceHandle } : {}),
      });
    }
    if (!result) return false;
    recordRecent({
      handle: typeof result.handle === 'string' ? result.handle : null,
      filename: result.name,
      format,
    });
    flashSaveSuccess();
    markNonPristineStarter();
    return true;
  } catch (err) {
    console.error('Marked cards save failed:', err);
    void alertDialog(`Marked cards save failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/**
 * Run the "silent" Save flow — writes back to the existing on-disk
 * file in its existing format, no dialog. Falls through to Save-As
 * when we have no handle (brand-new doc, host without in-place save
 * support, etc.). Returns the same boolean as Save-As.
 */
/** Hardened Save entry — same never-reject contract as runSaveAsFlow. */
// ─── In-flight save state ──────────────────────────────────────────
// Amber pulse on the save button from click until the save settles —
// the click acknowledgement the hung-write field case exposed as
// missing (nothing visible happened for the watchdog's first 10s).
// Applied only after a short delay so fast saves go straight to the
// ✓ flash without an amber flicker. Depth-counted: the close flows
// also route through runSaveFlow.
const SAVING_STATE_DELAY_MS = 250;
let savingDepth = 0;
let savingStateTimer: number | null = null;
function setSaveInProgress(on: boolean): void {
  if (on) {
    savingDepth++;
    if (savingDepth > 1) return;
    savingStateTimer = window.setTimeout(() => {
      savingStateTimer = null;
      exportBtn.classList.add('pmd-save-saving');
    }, SAVING_STATE_DELAY_MS);
  } else {
    savingDepth = Math.max(0, savingDepth - 1);
    if (savingDepth > 0) return;
    if (savingStateTimer !== null) {
      window.clearTimeout(savingStateTimer);
      savingStateTimer = null;
    }
    exportBtn.classList.remove('pmd-save-saving');
  }
}

export async function runSaveFlow(): Promise<boolean> {
  setSaveInProgress(true);
  try {
    return await runSaveFlowInner();
  } catch (err) {
    console.error('Save flow crashed:', err);
    void alertDialog(`Save failed unexpectedly: ${err instanceof Error ? err.message : err}`);
    return false;
  } finally {
    setSaveInProgress(false);
  }
}

/** The changed-on-disk decision, shared by manual save and the
 *  autosave conflict path. A compact promptForChoice rather than the
 *  route-style dialog: this is a small pick-one, not a Save/Don't
 *  Save-family confirmation (user call, 2026-08-17). */
function promptDiskConflict(filename: string | null): Promise<'overwrite' | 'saveAs' | null> {
  return promptForChoice<'overwrite' | 'saveAs'>({
    message:
      `"${filename ?? 'This document'}" has changed on disk since it was ` +
      `opened — it may have been edited by another program, on another ` +
      `device, or through a sync service. Replace the on-disk version?`,
    choices: [
      { value: 'overwrite', label: 'Overwrite', primary: true },
      { value: 'saveAs', label: 'Save As…' },
    ],
  });
}

async function runSaveFlowInner(): Promise<boolean> {
  const file = activeFile();
  if (!file.handle || !file.format || !getHost().supportsInPlaceSave) {
    return runSaveAsFlow();
  }
  // Request write access (browser: the readwrite permission prompt) NOW, while
  // this Save's user-activation is fresh and BEFORE the potentially slow
  // serialize — so the prompt only appears on real save intent, in context.
  // Denied → fall back to Save-As. No-op `true` on Electron.
  if (!(await getHost().ensureWritable(file.handle))) {
    return runSaveAsFlow();
  }
  // Recovered-draft guard: a doc opened from the recovery sidebar may be about
  // to overwrite a file that's NEWER than the journal it came from (a stale
  // journal from an older session). The changed-on-disk guard can't catch this
  // — the file was never read this session — so run the same stale-overwrite
  // confirmation as the sidebar's Save, on the first in-place save. Cleared
  // once the doc is written.
  const activeUid = activeDocIdentity().sessionUid;
  const recoveredSavedAt = recoveredDraftJournalSavedAt(activeUid);
  if (recoveredSavedAt) {
    const disk = await getHost().statFile(file.handle).catch(() => null);
    if (disk && journalPredatesFile(recoveredSavedAt, disk.mtimeMs)) {
      const choice = await promptStaleRecoveryOverwrite(
        file.filename ?? 'this file',
        recoveredSavedAt,
        disk.mtimeMs,
      );
      // Save-As keeps both versions; its success clears the mark via
      // commitSaveResult.
      if (choice === 'saveAs') return runSaveAsFlow();
      if (choice !== 'overwrite') return false;
    }
  }
  // Saving in place to a .docx flattens live views / linked copies — confirm
  // first. This also covers the close/quit save prompts, which route here.
  if (file.format === 'docx' && !(await confirmDocxDropsLiveLinks())) return false;
  try {
    // Ensure a stable docId (minting + rekeying pre-save annotations on
    // first save), keyed to the focused doc in either layout.
    const docId = ensureActiveDocId();
    // Capture the clean token BEFORE serializing: edits that land from
    // here on are not in the written bytes and must keep the doc dirty.
    const commitClean = captureActiveDocCleanToken();
    // warnIfSlow: a pre-write hang (serialize) is invisible to the
    // write watchdog below — surface it instead of ambering silently.
    const bytes = await warnIfSlow(
      serializeForSave(
        file.format,
        {
          // Silent saves preserve everything by default — the
          // user-facing toggles only fire from the Save-As dialog.
          includeComments: true,
          includeAnalytics: true,
          includeUndertags: true,
          readMode: false,
        },
        docId,
      ),
      file.filename,
    );
    // Version-history snapshot BEFORE the disk write is awaited: a save
    // whose destination folder hangs (cloud-sync placeholder) still
    // leaves a recoverable version in app data. Fire-and-forget.
    maybeSnapshotVersion(docId, bytes, 'manual');
    try {
      // Watchdog: a write that HANGS (cloud-sync placeholder hydration
      // stalling — the silent-save field case) warns at 10s and offers
      // Save As at 30s; real errors propagate to the handling below.
      if (
        (await awaitWithSaveWatchdog(getHost().saveExisting(file.handle, bytes), file.filename, {
          escalate: true,
        })) === 'saveAs'
      ) {
        return runSaveAsFlow();
      }
    } catch (err) {
      // The file changed on disk since we last read/wrote it — another
      // program, device, or sync service (Dropbox syncing down another
      // machine's edit is the field case) wrote the path while this doc
      // was open. Blindly writing would destroy that version WITHOUT
      // even producing a Dropbox conflicted copy, so ask first.
      if (!isFileChangedOnDiskError(err)) throw err;
      const choice = await promptDiskConflict(file.filename);
      if (choice === 'saveAs') return runSaveAsFlow();
      if (choice !== 'overwrite') return false;
      if (
        (await awaitWithSaveWatchdog(
          getHost().saveExisting(file.handle, bytes, { force: true }),
          file.filename,
          { escalate: true },
        )) === 'saveAs'
      ) {
        return runSaveAsFlow();
      }
    }
    // Written to its file — no longer a stale-recovery-overwrite candidate.
    clearRecoveredDraftMark(activeUid);
    if (docId) {
      learnStore.registerDoc({
        docId,
        path: typeof file.handle === 'string' ? file.handle : null,
        name: file.filename ?? 'Untitled',
        format: file.format,
      });
    }
    flashSaveSuccess();
    markNonPristineStarter();
    // Marks clean + drops the journal ONLY if no edits landed while
    // the serialize/write was in flight — later keystrokes are not in
    // the written bytes, so they must keep the doc dirty.
    commitClean();
    reportAutosaveSuccess();
    return true;
  } catch (err) {
    console.error('Save failed:', err);
    // The file's LOCATION refused the write (web host, after its own
    // refresh-and-retry): Chromium can deterministically reject swap-file
    // writes on cloud-backed ChromeOS mounts — Dropbox and Google Drive are
    // provider filesystems in the Files app, not local folders. A blind
    // retry cannot succeed there; Save-As to a local folder is the exit,
    // and this dialog's button click supplies the fresh user gesture the
    // Save-As picker needs.
    if (isWriteBlockedError(err)) {
      const choice = await promptForRouteChoice<'saveAs' | 'retry'>({
        message:
          `"${file.filename ?? 'This document'}" couldn't be saved in place — ` +
          `its folder refused the write. On Chromebooks this happens in ` +
          `cloud-synced folders (Google Drive, Dropbox): they can block ` +
          `direct saves from web apps. Your work is still open and safe.`,
        choices: [
          {
            value: 'saveAs',
            label: 'Save As\u2026',
            description:
              'Pick a new location \u2014 a local folder (My Files / Downloads) always works.',
          },
          {
            value: 'retry',
            label: 'Try Again',
            description: 'Retry writing to the same file.',
          },
        ],
      });
      if (choice === 'saveAs') return runSaveAsFlow();
      if (choice === 'retry') return runSaveFlowInner();
      return false;
    }
    // The file's folder was renamed/moved/deleted out from under us (field
    // bug 2026-07-11: a shared Dropbox folder rename left every open doc
    // with a stale path — saves ENOENT'd with no way forward, and the
    // close flow dead-ended). Offer Save As so the work has an exit.
    if (isFileGoneError(err)) {
      const rescue = await confirmDialog(
        `"${file.filename ?? 'This document'}" couldn't be saved because its ` +
          `file no longer exists at the saved location — the folder may have ` +
          `been renamed, moved, or deleted (for example by a cloud-sync ` +
          `change). Choose a new location to keep your work.`,
        { title: 'File location not found', okLabel: 'Save As…' },
      );
      return rescue ? runSaveAsFlow() : false;
    }
    const lockedMsg = fileLockedMessage(err);
    void alertDialog(`Save failed: ${lockedMsg ?? (err instanceof Error ? err.message : err)}`);
    return false;
  }
}

// Floppy = Save. Falls through to the Save-As dialog automatically
// when no handle exists or the host can't do silent in-place saves,
// so the first save of a new doc still prompts for a location and
// format.
exportBtn.addEventListener('click', () => {
  void runSaveFlow();
});

// ─── Save visual feedback ──────────────────────────────────────────
// On every successful save (manual or autosave) we briefly swap the
// save button's glyph for a check mark, and do the same for the
// autosave toggle when it's on. Subtle reassurance that the bytes
// actually hit disk; doesn't block anything.

const FLASH_DURATION_MS = 1400;
/** Per-element pending revert timers. Re-entrant — a save that
 *  fires while a previous flash is still on screen extends the
 *  flash rather than restoring the original glyph mid-animation. */
const flashTimers = new WeakMap<HTMLElement, number>();
/** Original inner markup of a flashing button, captured before the ✓
 *  overwrite and restored when the flash ends (preserves the icon
 *  `<span>`, not just text). */
const flashOrigHtml = new WeakMap<HTMLElement, string>();

function flashSavedGlyph(el: HTMLElement): void {
  const existing = flashTimers.get(el);
  if (existing !== undefined) {
    window.clearTimeout(existing);
  } else {
    // Preserve the full inner markup, not just text — these buttons
    // hold an icon `<span>`, which a text-only restore would wipe out
    // (the glyph would never come back after the ✓ flash).
    flashOrigHtml.set(el, el.innerHTML);
  }
  el.textContent = '✓';
  // A success flash supersedes the in-flight amber immediately (the
  // depth-counted clear runs a beat later, in runSaveFlow's finally).
  el.classList.remove('pmd-save-saving');
  el.classList.add('pmd-save-flash');
  const id = window.setTimeout(() => {
    flashTimers.delete(el);
    el.innerHTML = flashOrigHtml.get(el) ?? '';
    flashOrigHtml.delete(el);
    el.classList.remove('pmd-save-flash');
  }, FLASH_DURATION_MS);
  flashTimers.set(el, id);
}

/** Flash the save button (always) and the autosave button (when
 *  on). Both manual saves and autosaves call this. Reads via
 *  `autosaveStateForActive` so multi-pane's per-DocRecord flag is
 *  consulted in addition to the single-doc transient setting. */
function flashSaveSuccess(): void {
  flashSavedGlyph(exportBtn);
  if (autosaveBtn && autosaveStateForActive()) {
    flashSavedGlyph(autosaveBtn);
  }
}

// ─── Autosave + crash-recovery journal ────────────────────────────
// Autosave: debounced ~5s after the last doc-changing edit. Only
// fires for `.cmir` files with an existing on-disk handle and a host
// that supports in-place saves. `.docx` is skipped because `toDocx`
// is expensive enough that per-edit autosaves would visibly stutter
// the editor on large debate files.
//
// Journaling: debounced ~3s after the last doc-changing edit.
// Always fires (regardless of autosave) when the host supports it.
// Writes a recoverable cmir snapshot under the doc's UID; cleared
// on successful save / explicit close. Drives the recovery modal
// on startup.

const AUTOSAVE_DELAY_MS = 5000;
const JOURNAL_DELAY_MS = 3000;
let autosaveTimer: number | null = null;
let journalTimer: number | null = null;
// Write chains: with the gzip step async, two debounce rounds could
// otherwise overlap in flight and land out of order (older bytes
// clobbering newer). Each round snapshots + writes strictly after the
// previous one settles; the run functions never reject.
let journalWriteChain: Promise<void> = Promise.resolve();
let autosaveChain: Promise<void> = Promise.resolve();

/** Called from every view's `dispatchTransaction` when `tx.docChanged`
 *  is true. Re-arms both the autosave debounce (when the setting is
 *  on) and the journal debounce (always, when supported). Cheap to
 *  fire unconditionally — each branch no-ops when its trigger
 *  condition isn't met. */
export function notifyEditForAutosave(): void {
  scheduleJournalWrite();
  if (!settings.get('autosaveEnabled')) return;
  if (autosaveTimer !== null) window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => {
    autosaveTimer = null;
    // .catch keeps the chain FULFILLED: runAutosaveAttempt handles its own
    // write errors, but a throw from its guard lines (before its try) used
    // to reject the chain — after which every later .then silently skipped
    // and autosave was dead for the session while its button stayed lit.
    autosaveChain = autosaveChain
      .then(() => runAutosaveAttempt())
      .catch((err) =>
        reportAutosaveFailure(currentDocFilename ?? 'Untitled', err, {
          promptConflict: () => void runSaveFlow(),
        }),
      );
  }, AUTOSAVE_DELAY_MS);
}

/** Schedule a debounced journal write for the SINGLE-DOC session.
 *  Multi-doc records run their own per-pane journal scheduling
 *  through the shell, since each DocRecord has its own uid +
 *  filename + handle. */
function scheduleJournalWrite(): void {
  if (!getHost().journalsSupported) return;
  if (multiDocActive) return;
  if (journalTimer !== null) window.clearTimeout(journalTimer);
  journalTimer = window.setTimeout(() => {
    journalTimer = null;
    // .catch keeps the chain alive — a guard-line throw must not end
    // crash-recovery journaling for the whole session.
    journalWriteChain = journalWriteChain
      .then(() => runJournalWrite())
      .catch((err) => console.warn('Journal write crashed:', err));
  }, JOURNAL_DELAY_MS);
}

async function runJournalWrite(): Promise<void> {
  if (!view) return;
  const host = getHost();
  if (!host.journalsSupported) return;
  try {
    const bytes = await serializeNativeAsync(view.state.doc, {
      threads: Array.from(getCommentsState(view.state).threads.values()),
      ...(currentDocId ? { docId: currentDocId } : {}),
    });
    // A recovered-but-not-yet-saved draft carries its ORIGINAL journal
    // savedAt forward, so the stale-overwrite guard survives relaunches and
    // mode switches even though this write stamps savedAt = now.
    const recoveredFrom = recoveredDraftJournalSavedAt(currentDocUid);
    await host.writeJournal({
      uid: currentDocUid,
      filename: currentDocFilename ?? 'Untitled',
      // Keep the handle as-is: Electron path string OR the browser's
      // FileSystemFileHandle (both survive the journal round-trip).
      handle: currentDocHandle,
      format: currentDocFormat,
      savedAt: new Date().toISOString(),
      ...(recoveredFrom ? { recoveredFromSavedAt: recoveredFrom } : {}),
      bytes,
    });
  } catch (err) {
    console.warn('Journal write failed:', err);
  }
}

/** Clear the journal for the current single-doc session — called
 *  after a successful save and on New / Open (which replace the
 *  doc). Best-effort; logs failures silently. */
async function clearCurrentJournal(): Promise<void> {
  const host = getHost();
  if (!host.journalsSupported) return;
  try {
    await host.deleteJournal(currentDocUid);
  } catch (err) {
    console.warn('Journal delete failed:', err);
  }
}

/** Layout-aware clean token for the active doc — capture it RIGHT
 *  BEFORE serializing a save; call the returned fn after the write
 *  lands to mark the doc clean + drop its crash-recovery journal,
 *  which it only does when no edits arrived while the save was in
 *  flight (see save-clean-token.ts). Multi-pane: the focused
 *  DocRecord via the shell hook; single-doc: the module globals. */
function captureActiveDocCleanToken(): () => boolean {
  if (multiDocActive && multiDocCaptureFocusedCleanToken) {
    const token = multiDocCaptureFocusedCleanToken();
    if (token) return token;
  }
  return captureCleanToken({
    editGen: () => currentDocEditGen,
    markClean: () => {
      // Direct flag clear — markCurrentDocClean() would bump the
      // generation and wrongly invalidate other in-flight tokens.
      currentDocDirty = false;
    },
    clearJournal: () => {
      void clearCurrentJournal();
    },
  });
}

async function runAutosaveAttempt(): Promise<void> {
  if (!settings.get('autosaveEnabled')) return;
  const file = activeFile();
  // Autosave only saves `.cmir` files. The toDocx path is too
  // expensive for background firing; users keep manual control
  // over when docx files hit disk.
  if (file.format !== 'cmir' || !file.handle) return;
  if (!getHost().supportsInPlaceSave) return;
  // A recovered draft may only be written by a MANUAL save until its first
  // one lands — the stale-overwrite confirmation lives on the manual path,
  // and an autosave here would silently do the exact overwrite it guards
  // against.
  if (autosaveBlockedForRecoveredDraft(activeDocIdentity().sessionUid)) return;
  try {
    // Capture before serializing — keystrokes during the write are not
    // in the saved bytes and must keep the doc dirty + journaled.
    const commitClean = captureActiveDocCleanToken();
    const bytes = await serializeForSave(
      'cmir',
      {
        includeComments: true,
        includeAnalytics: true,
        includeUndertags: true,
        readMode: false,
      },
      // Preserve the doc's identity on autosave (a saved .cmir already
      // has one; without this the autosave write would strip it).
      activeSavedDocId(),
    );
    // Same pre-write snapshot as the manual save path (see there).
    maybeSnapshotVersion(activeSavedDocId(), bytes, 'auto');
    // Watchdog without the dialog — never a modal mid-typing; the
    // 10s warning chip still converts a hung autosave into feedback.
    await awaitWithSaveWatchdog(getHost().saveExisting(file.handle, bytes), file.filename, {
      escalate: false,
    });
    flashSaveSuccess();
    commitClean();
    reportAutosaveSuccess();
  } catch (err) {
    reportAutosaveFailure(file.filename ?? 'Untitled', err, {
      promptConflict: () => void runSaveFlow(),
    });
  }
}

// ─── Autosave button wiring ────────────────────────────────────────

/** Whether the most recent autosave attempt (either layout) failed.
 *  Gates the one-per-streak toast and drives the button's error
 *  styling + tooltip suffix. Cleared by any successful save. */
let autosaveFailureActive = false;

/** Surface an autosave failure. Autosave used to fail silently
 *  (console.warn only) — with a stale file path that meant the user
 *  believed their doc was saved while every write was bouncing (field
 *  bug 2026-07-11, folder renamed under a shared Dropbox). One toast
 *  per failure streak (not per retry), plus a persistent error state
 *  on the autosave button until a save lands. */
export function reportAutosaveFailure(
  filename: string,
  err: unknown,
  opts?: {
    /** Provided by call sites whose manual-save flow targets THIS doc
     *  (single-doc; multi-pane records may not be focused, so they
     *  stay pause+notice). A changed-on-disk conflict prompts the
     *  shared disk-conflict decision immediately — the divergence
     *  only widens while it waits (audit §3C). */
    promptConflict?: () => void;
  },
): void {
  console.warn('Autosave failed:', err);
  autosaveBtn?.setAttribute('data-autosave-error', 'true');
  if (autosaveFailureActive) return;
  autosaveFailureActive = true;
  refreshAutosaveBtn();
  if (isFileChangedOnDiskError(err) && opts?.promptConflict) {
    // The save flow re-serializes and shows promptDiskConflict; a
    // cancel leaves autosave paused with the notice below standing.
    opts.promptConflict();
  }
  postAutosaveNotice(
    isFileGoneError(err)
      ? `Autosave failed — "${filename}" no longer exists at its saved location. Use Save As to pick a new one.`
      : isFileChangedOnDiskError(err)
        ? `Autosave paused — "${filename}" changed on disk (edited by another program or device?). Use Save to review before overwriting.`
        : isWriteBlockedError(err)
          ? `Autosave failed — "${filename}"'s folder refused the write (cloud-synced folder?). Use Save As to move it to a local folder like My Files/Downloads.`
          : `Autosave failed for "${filename}" — your latest changes are not saved.`,
  );
}

/** Autosave failures are data-loss-adjacent: toast for immediacy plus
 *  a durable chip entry (coalesced per file) the user can re-read. */
function postAutosaveNotice(body: string): void {
  postNotice({ severity: 'error', title: 'Autosave problem', body, key: 'autosave' });
}

/** Any successful save (manual, Save As, or autosave, either layout)
 *  ends the failure streak and clears the button's error state. */
export function reportAutosaveSuccess(): void {
  if (!autosaveFailureActive && !autosaveBtn?.hasAttribute('data-autosave-error')) return;
  autosaveFailureActive = false;
  autosaveBtn?.removeAttribute('data-autosave-error');
  refreshAutosaveBtn();
}

/** Update the autosave button's pressed state + tooltip based on
 *  the current setting and the active file's format. The button
 *  stays pressed regardless of whether autosave is actually firing
 *  (the user's preference is sovereign), but the tooltip clarifies
 *  when autosave is on but inert (docx file, brand-new doc, etc.). */
function refreshAutosaveBtn(): void {
  if (!autosaveBtn) return;
  const on = autosaveStateForActive();
  autosaveBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  let label: string;
  if (!on) {
    label = 'Autosave is off — click to turn on';
    autosaveBtn.dataset['autosaveEffective'] = 'false';
  } else {
    const file = activeFile();
    const effective = file.format === 'cmir' && !!file.handle;
    autosaveBtn.dataset['autosaveEffective'] = effective ? 'true' : 'false';
    if (effective) {
      label = 'Autosave is on — saves to .cmir every few seconds after edits';
    } else if (file.format === 'docx') {
      label =
        'Autosave is on, but only fires for .cmir files (this doc is .docx). ' +
        'Save As to .cmir to enable.';
    } else {
      label = 'Autosave is on, but this doc has not been saved yet. Save once to enable.';
    }
  }
  if (autosaveFailureActive) {
    label += ' LAST AUTOSAVE FAILED — the latest changes are not on disk.';
  }
  // Route through the tooltip controller so the current
  // ribbonTooltipMode (none / tooltip / shortcut / both) governs
  // whether this state-aware text actually appears.
  registerRibbonTooltip({ el: autosaveBtn, label });
}

if (autosaveBtn) {
  autosaveBtn.addEventListener('mousedown', (e) => e.preventDefault());
  autosaveBtn.addEventListener('click', () => {
    if (multiDocActive && multiDocToggleAutosave) {
      multiDocToggleAutosave();
      return;
    }
    settings.set('autosaveEnabled', !settings.get('autosaveEnabled'));
  });
  // Initial state + live updates as the setting / focused doc changes.
  refreshAutosaveBtn();
  settings.subscribe(() => refreshAutosaveBtn());
}

// ─── Native menu wiring (Electron only) ────────────────────────────
// When running inside the Electron shell, the menu bar's File items
// fire IPC messages that we route through the same ribbon-command
// handlers as keyboard shortcuts and ribbon buttons. Single point of
// truth: ribbonContext.

/** Type-narrow a string to RibbonCommandId. Used by the menu-
 *  command IPC handler so the fallback `runRibbon(...)` branch is
 *  type-safe. */
const RIBBON_COMMAND_ID_SET = new Set<string>(RIBBON_COMMAND_IDS);
function isRibbonCommandId(s: string): s is RibbonCommandId {
  return RIBBON_COMMAND_ID_SET.has(s);
}

/** Menu-bound ribbon commands whose current keybinding the native
 *  menu shows as an accelerator hint. Keep in sync with the menu
 *  template in `apps/desktop/src/main.ts`. */
const NATIVE_MENU_COMMANDS: RibbonCommandId[] = [
  // File
  'openFile',
  'newDocument',
  'save',
  'saveAs',
  'toggleAutosave',
  'closeDocOrWindow',
  // Speech
  'newSpeechDocument',
  'markActiveAsSpeech',
  'sendToSpeechAtCursor',
  'sendToSpeechAtEnd',
  'selectSpeechDoc',
  // View
  'chromeScaleReset',
  'chromeScaleUp',
  'chromeScaleDown',
  // Window
  'minimizeWindow',
  // Help
  'openSettings',
  'openShortcutsReference',
];

/** Snapshot the current keybinding for each menu-bound command
 *  and ship it to main so the native menu's accelerator labels
 *  stay in sync with user rebinds. No-op outside Electron. */
function pushNativeMenuBindings(): void {
  const electronHost = getElectronHost();
  if (!electronHost) return;
  const overrides = settings.get('ribbonKeyOverrides');
  const bindings: Record<string, string | null> = {};
  for (const id of NATIVE_MENU_COMMANDS) {
    const key = primaryKeyFor(id, overrides);
    bindings[id] = key || null;
  }
  void electronHost.setMenuBindings(bindings);
}
{
  const electronHost = getElectronHost();
  if (electronHost) {
    electronHost.onMenuCommand((command) => {
      switch (command) {
        case 'newDocument':
          ribbonContext.newDocument();
          break;
        case 'openFile':
          ribbonContext.openFile();
          break;
        case 'save':
          ribbonContext.save();
          break;
        case 'saveAs':
          ribbonContext.saveAs();
          break;
        case 'closeDocOrWindow':
          // Multi-pane: close the focused slot's visible doc. In
          // single-doc, "close the doc" returns to the home screen
          // (the window stays open); the OS close button / quit
          // path is what actually closes the window. When already
          // on home, handleCloseDocToHome is a no-op — fall through
          // to the real window close so Ctrl+W from home still
          // quits.
          void (async () => {
            const { tryCloseVisibleInFocusedSlot } = await import(
              './multi-pane-shell.js'
            );
            const consumed = await tryCloseVisibleInFocusedSlot();
            if (consumed) return;
            if (!multiDocActive && !homeScreen.isVisible()) {
              await handleCloseDocToHome();
            } else {
              await handleUserCloseRequest();
            }
          })();
          break;
        default:
          // Fallback for the Speech / View / Help / Toggle Autosave
          // entries. All of them are valid ribbon command ids; route
          // each through runRibbon so menu and keyboard paths use a
          // single implementation. Unknown commands are silently
          // ignored (no menu item should send something we don't
          // recognize).
          if (isRibbonCommandId(command)) {
            runRibbon(command);
          }
      }
    });
    // Mode-switch coordination: another window is about to reload
    // into the new workspace mode and is asking us to journal our
    // current doc and close. The journal write is best-effort; we
    // close regardless so the originating window's
    // `journalAndCloseOtherWindows` promise resolves promptly.
    electronHost.onPleaseCloseForModeSwitch(() => {
      void (async (): Promise<void> => {
        try {
          // Journals this window's open doc(s) — single doc or, in
          // the rare multi-pane-with-extra-windows case, every pane —
          // and reports the uid + dirty list to main so the surviving
          // window can scope its post-reload reopen to exactly the
          // switch's docs. Same co-editing contract as the toggling
          // window: live sessions are flushed and their docs EXCLUDED
          // from the report — they close and stay resumable from the
          // Sessions list rather than reopening as static copies.
          const docs = await journalForModeSwitchExcludingSessions();
          if (docs.length > 0) {
            await electronHost.reportModeSwitchJournaled(docs);
          }
        } catch (err) {
          console.warn('Mode-switch journaling failed:', err);
        }
        await electronHost.closeSelf();
      })();
    });
    // User clicked the OS close button. If the doc is clean,
    // close immediately. If dirty, prompt for save / save-as /
    // cancel / discard.
    electronHost.onCloseRequest(() => {
      void handleUserCloseRequest();
    });
  }
}

/** Renderer-side handler for `host:close-request` (the user
 *  clicked the window's close button). Clean docs close
 *  immediately; dirty docs surface a 4-option prompt and act on
 *  the user's choice. Cancel leaves the window open. */
async function handleUserCloseRequest(): Promise<void> {
  const electronHost = getElectronHost();
  if (!electronHost) return;
  try {
    await handleUserCloseRequestInner(electronHost);
  } catch (err) {
    // Fail SAFE. Every path through the close flow must end in closeSelf()
    // or cancelClose(); an escaped throw ran NEITHER — a pending macOS quit
    // would wait forever on this window's verdict. Cancel the close: the
    // window stays open, nothing is lost, and the user sees why.
    console.error('Close-request handling crashed:', err);
    void alertDialog(
      `Couldn't close this window cleanly: ${err instanceof Error ? err.message : err}\n\n` +
        'The window stays open and your document is untouched. Save manually, then try again.',
    );
    try {
      await electronHost.cancelClose?.();
    } catch {
      /* best-effort — cancelClose is itself a bridge call */
    }
  }
}

async function handleUserCloseRequestInner(
  electronHost: NonNullable<ReturnType<typeof getElectronHost>>,
): Promise<void> {
  // Multi-pane: `currentDocDirty` only tracks the single-doc view, so the quit
  // must ask the SHELL to prompt for every unsaved pane before closing —
  // otherwise closing the window silently discards their work. (Sessions persist
  // automatically on quit, so no per-doc session dialog.) A cancel / failed save
  // aborts the quit via `cancelClose` so a later ordinary close still leaves the
  // app in the dock on macOS.
  if (multiDocActive) {
    const ok = multiDocPromptSaveAllForQuit ? await multiDocPromptSaveAllForQuit() : true;
    if (ok) {
      // Explicitly flush every live session's record before the window dies —
      // "sessions persist on quit" otherwise rides only the fire-and-forget
      // pagehide write, which a fast teardown can cut off mid-write (audit
      // find, 2026-07-10). Best-effort: a flush failure must not block the
      // quit the user just confirmed.
      try {
        await collabCaptureSessionHandoff();
      } catch (err) {
        console.warn('Session flush on quit failed:', err);
      }
      await electronHost.closeSelf();
    } else await electronHost.cancelClose?.();
    return;
  }
  // Single-doc: a co-edited doc gets the session-aware close (keep resumable vs
  // end/leave), naming the doc.
  {
    const co = await resolveCoEditedClose(currentDocUid, currentDocFilename ?? '');
    if (co === 'cancel') {
      // Backed out of the session-aware close — clear any pending app-quit
      // intent so a later ordinary window close doesn't terminate the app on
      // macOS (matches the Cancel path in the dirty-save switch below).
      await electronHost.cancelClose?.();
      return;
    }
    if (co === 'keep') {
      // Closing the doc (session kept resumable) completes a pending quit.
      await electronHost.closeSelf();
      return;
    }
    // 'run-normal' → fall through to the dirty/save flow below.
  }
  if (!currentDocDirty) {
    await electronHost.closeSelf();
    return;
  }
  const choice = await confirmCloseUnsaved();
  switch (choice) {
    case 'save': {
      const ok = await runSaveFlow();
      if (ok) await electronHost.closeSelf();
      // Save failed — the window stays open, so a quit that was
      // waiting on this confirmation is off. Let main know.
      else await electronHost.cancelClose?.();
      return;
    }
    case 'saveAs': {
      const ok = await runSaveAsFlow();
      if (ok) await electronHost.closeSelf();
      else await electronHost.cancelClose?.();
      return;
    }
    case 'discard': {
      // User wants the work gone. Drop the journal so it doesn't
      // surface as a recovery option on the next launch, then
      // close.
      await clearCurrentJournal().catch(() => {
        /* best-effort */
      });
      await electronHost.closeSelf();
      return;
    }
    case 'cancel':
      // Window stays open — cancel any pending app quit so a later
      // ordinary close doesn't terminate the app on macOS.
      await electronHost.cancelClose?.();
      return;
  }
}

/** Four-button overlay for "user wants to close a dirty doc."
 *  Same DOM shape as `confirmNewDocOverwrite` but with separate
 *  Save and Save-As actions (in-place save vs pick-location) plus
 *  an explicit Discard. Esc / overlay-click cancel. Exported for
 *  multi-pane's per-pane close handler. */
export function confirmCloseUnsaved(): Promise<'save' | 'saveAs' | 'discard' | 'cancel'> {
  return new Promise((resolve) => {
    const overlayToken = pushOverlay();
    const overlay = document.createElement('div');
    overlay.className = 'pmd-route-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'pmd-route-dialog';

    const header = document.createElement('div');
    header.className = 'pmd-route-header';
    header.textContent = 'You have unsaved changes. Save before closing?';
    dialog.appendChild(header);

    const buttons = document.createElement('div');
    buttons.className = 'pmd-route-buttons';

    let removeKeys = (): void => {};
    const cleanup = (): void => {
      popOverlay(overlayToken);
      overlay.remove();
      removeKeys();
    };

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'pmd-route-btn';
    saveBtn.innerHTML =
      '<strong>Save</strong><br><span>Write to the existing file, then close.</span>';
    saveBtn.addEventListener('click', () => {
      cleanup();
      resolve('save');
    });
    buttons.appendChild(saveBtn);

    const saveAsBtn = document.createElement('button');
    saveAsBtn.type = 'button';
    saveAsBtn.className = 'pmd-route-btn';
    saveAsBtn.innerHTML =
      '<strong>Save As…</strong><br><span>Pick a location, then close.</span>';
    saveAsBtn.addEventListener('click', () => {
      cleanup();
      resolve('saveAs');
    });
    buttons.appendChild(saveAsBtn);

    const discardBtn = document.createElement('button');
    discardBtn.type = 'button';
    discardBtn.className = 'pmd-route-btn';
    discardBtn.innerHTML =
      "<strong>Don't save</strong><br><span>Discard changes and close. Recovery journal is dropped.</span>";
    discardBtn.addEventListener('click', () => {
      cleanup();
      resolve('discard');
    });
    buttons.appendChild(discardBtn);

    dialog.appendChild(buttons);

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'pmd-route-cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => {
      cleanup();
      resolve('cancel');
    });
    dialog.appendChild(cancel);

    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        cleanup();
        resolve('cancel');
      }
    });
    // Capture-phase + swallow (see installModalKeys). This is the
    // Mod-W dialog — it opens over a focused editor on essentially
    // every close, and with a bubble-phase listener Enter reached
    // ProseMirror first and silently inserted a newline into the very
    // doc the user was about to Save or Discard.
    removeKeys = installModalKeys(dialog, overlayToken, (e) => {
      if (e.key === 'Escape') {
        cleanup();
        resolve('cancel');
        return true;
      }
      // Number keys mirror button order so the dialog is fully
      // keyboard-navigable: 1=Save, 2=Save As, 3=Don't save.
      // Esc still cancels. Skips when a modifier is held so we
      // don't intercept chords (e.g., Ctrl+1 stays available for
      // its slot-focus meaning, even if a save prompt is open).
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
      if (e.key === '1') {
        cleanup();
        resolve('save');
        return true;
      }
      if (e.key === '2') {
        cleanup();
        resolve('saveAs');
        return true;
      }
      if (e.key === '3') {
        cleanup();
        resolve('discard');
        return true;
      }
      return false;
    });
    document.body.appendChild(overlay);
    armDialogFocus(dialog, 'alertdialog', 'You have unsaved changes. Save before closing?');
  });
}

/** Session-aware close confirm for a co-edited doc. "Close" keeps the session
 *  resumable — the record stays and unsynced edits sync when the user rejoins
 *  from the home-screen Sessions list; "End/Leave" clears it. Naming the doc
 *  removes ambiguity about which one is closing (multi-pane). */
function confirmCloseCoEditedDoc(
  docName: string,
  info: { role: 'host' | 'participant'; unsynced: number },
): Promise<'keep' | 'end' | 'cancel'> {
  const name = docName ? `"${docName}"` : 'this document';
  const leaveLabel = info.role === 'host' ? 'End session' : 'Leave session';
  const syncing =
    info.unsynced > 0
      ? ` ${info.unsynced} change${info.unsynced === 1 ? '' : 's'} still syncing will sync when you rejoin.`
      : '';
  return promptForRouteChoice<'keep' | 'end'>({
    message: `Close ${name}?`,
    choices: [
      {
        value: 'keep',
        label: 'Close',
        description: `Keep the session — rejoin from the Sessions list to keep editing.${syncing}`,
      },
      {
        value: 'end',
        label: leaveLabel,
        description:
          info.role === 'host'
            ? 'End the session for everyone.'
            : 'Leave the session; your copy stays as it is.',
      },
    ],
  }).then((c) => c ?? 'cancel');
}

/** For a doc that MAY be co-edited, run the session-aware close confirm and the
 *  chosen collab action. Returns:
 *   - `'cancel'`     → abort the close (leave the doc open)
 *   - `'keep'`       → session kept resumable; the caller should close WITHOUT
 *                      a file save prompt (the session record holds the content)
 *   - `'run-normal'` → not co-edited, OR the session was ended/left; the caller
 *                      runs its usual dirty → save/discard close flow
 *  Exported for the multi-pane shell's per-pane close handler. */
export async function resolveCoEditedClose(
  uid: string,
  docName: string,
): Promise<'cancel' | 'keep' | 'run-normal'> {
  const cp = collabCopresenceFor(uid);
  if (!cp) return 'run-normal';
  const choice = await confirmCloseCoEditedDoc(docName, { role: cp.role, unsynced: cp.queued });
  if (choice === 'cancel') return 'cancel';
  if (choice === 'keep') {
    // False = the resumable record couldn't be verified on disk — it would
    // have been the doc's only copy (the close path drops the journal), so
    // the close must abort. The session was left live.
    if (!(await collabCloseKeepResumable(uid))) {
      showToast(
        "Couldn't save the session for resuming — the document stays open. " +
          'Check disk space and try again.',
      );
      return 'cancel';
    }
    return 'keep';
  }
  // False = a host End couldn't tombstone the room (relay unreachable); it
  // already toasted, and the session stays live — abort the close so the
  // user isn't left thinking the session ended.
  if (!(await collabEndOrLeaveSession(uid))) return 'cancel';
  // The session is gone — rebuild the doc's plugin stack NOW. The caller
  // continues into the dirty-save prompt, and a Cancel there keeps the doc
  // open; without this it kept dead session plugins (audit find, 2026-07-10).
  {
    const v = getSpeechDocResolver().viewForUid(uid);
    if (v) v.updateState(v.state.reconfigure({ plugins: buildEditorPlugins(uid) }));
  }
  return 'run-normal';
}

function countSummary(doc: PMNode): string {
  const counts: Record<string, number> = {};
  doc.descendants((node) => {
    counts[node.type.name] = (counts[node.type.name] ?? 0) + 1;
  });
  return Object.entries(counts)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
}

// Boot: if multi-doc workspace is enabled, hand off to the multi-pane
// shell. Otherwise mount the starter doc in the single-doc shell.
// Crash recovery runs after the editor is up (so the recovery modal
// has somewhere to mount over).
//
// Mobile shell (web edition, small touch screens — SPEC-mobile-view.md):
// resolved FIRST and once per load. It rides the single-doc machinery
// (same mountView, open/save flows, recovery), so it forces the
// multi-pane branch off for this session WITHOUT writing the synced
// `multiDocWorkspace` setting — toggling back to desktop restores the
// workspace untouched.
const BOOT_MOBILE_ENV = {
  hostKind: getHost().kind,
  coarsePointer:
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches,
  viewportWidth: window.innerWidth,
};
const BOOT_MOBILE = resolveMobileLayout(settings.get('mobileLayout'), BOOT_MOBILE_ENV);
if (BOOT_MOBILE_ENV.hostKind === 'browser') {
  console.log(
    `[cardmirror] mobile: setting=${settings.get('mobileLayout')} width=${BOOT_MOBILE_ENV.viewportWidth} coarse=${BOOT_MOBILE_ENV.coarsePointer} → ${BOOT_MOBILE ? 'mobile' : 'desktop'} layout`,
  );
}
if (BOOT_MOBILE) setMobileShellActive(true);
const BOOT_MULTI_DOC_WORKSPACE = !BOOT_MOBILE && settings.get('multiDocWorkspace');
// Set when this window bounced itself as a redundant three-pane duplicate
// (singleton enforcement). A bounced window that lingers (couldn't self-close)
// must stop claiming to be a workspace, so it never blocks a future window.
let redundantWindowBounced = false;
// Multi-window mode shows the speech-stack ribbon cluster (mark-as-speech + the
// two send buttons). On desktop that's single-doc + a host that can spawn
// windows (Electron). On the web a single-doc tab can send to the speech doc in
// ANOTHER same-origin tab (cross-tab transport, see speech-doc-send.ts), so
// surface it there too — but not on the mobile shell, which has no such flow.
if (
  !BOOT_MULTI_DOC_WORKSPACE &&
  (getHost().canSpawnWindow || (getHost().kind === 'browser' && !BOOT_MOBILE))
) {
  document.body.classList.add('pmd-multi-window');
}
// Install the cross-window send-to-speech receiver. No-op when not
// on Electron; safe to install in both single-doc and (will-be)
// multi-pane paths since the resolver filters by uid.
installIncomingSpeechSliceHandler();
// Persistent web cross-window coordination: tracks live peer windows and answers
// mode-switch please-close (journal our doc(s), report, self-close) + same-file
// queries (is this file already open here?). No-op on Electron (coordinates
// through main) and where BroadcastChannel is unavailable.
installWindowCoordination({
  // Same helper as the Electron paths: co-edited docs are flushed + excluded
  // (inert on web today — co-editing is desktop-only — but the contract holds
  // if that ever changes).
  journalOpenDocs: journalForModeSwitchExcludingSessions,
  getOpenHandles: getThisWindowOpenHandles,
  // A page-load's mode is fixed (a toggle reloads), so the boot constant is the
  // current three-pane state — for the singleton (one-three-pane-window) rule.
  // A window that already bounced no longer counts as a live workspace.
  isMultiPane: () => BOOT_MULTI_DOC_WORKSPACE && !redundantWindowBounced,
});
// Load the persistent, cross-window Quick Cards library + subscribe to
// changes. Done at boot (not on first UI mount) so the add command and
// search palette work the instant they're invoked, in either layout.
void quickCardsStore.init();
// Pre-warm the search palette's file cache during idle, before it's ever
// opened, so the first search's `.docx` parse is already cached and never
// janks a keystroke. No-op off Electron / without a file-search root.
prewarmQuickCardFiles();

// Single cross-window dropzone pill, anchored to the editor's
// bottom-left corner (NOT the nav pane — dragging onto a nav-bottom
// pill scrolled the outline). `positionDropzone` tracks the editor
// element's rect, so it follows nav-width changes, the status bar, and
// (multi-pane) the leftmost pane.
const dropzoneController = new DropzoneController();
// No dropzone on mobile: there is no grab-and-drag from the editor
// surface there at all (a drag is indistinguishable from a scroll on
// touch) — structural moves are Move-mode buttons + nav-pane drags.
if (!BOOT_MOBILE) {
  // All three bottom-left pills share one fixed tray (a flex row) so the
  // send / receive pills sit to the RIGHT of the dropzone and each pill's
  // expansion overlays upward without reflowing its neighbors. The tray is
  // the element `positionDropzone` anchors.
  const pillTray = document.createElement('div');
  pillTray.className = 'pmd-pill-tray';
  document.body.appendChild(pillTray);
  dropzoneController.mount({
    parent: pillTray,
    getFocusedView: () => getActiveView(),
  });
  // Cross-machine card sharing: Send + Receive pills + config wiring.
  // No-ops gracefully off Electron (web edition). The view resolver
  // reports NO view while the home screen is up: card INSERTS target
  // the focused doc, which home is covering — the pill toasts instead
  // of writing into a document the user can't see.
  const { receivePillEl } = mountPairingPills(
    pillTray,
    () => (homeScreen.isVisible() ? null : getActiveView()),
  );
  initPairingWiring();
  // The receive pill lives in the HOME SCREEN'S own dock while home is
  // visible — collab invites join a NEW doc, so seeing/accepting them
  // must not require one open, and the pill's home position should be
  // the hub's layout, not wherever the editor layer underneath anchored
  // the tray. Re-parenting moves the live node (listeners ride along);
  // the send pill + dropzone stay tray-only, covered by the overlay.
  if (receivePillEl) {
    const placeReceivePill = (homeVisible: boolean): void => {
      const dock = homeScreen.pillDock();
      if (homeVisible && dock) dock.appendChild(receivePillEl);
      else if (receivePillEl.parentElement !== pillTray) pillTray.appendChild(receivePillEl);
    };
    homeScreen.onVisibilityChange(placeReceivePill);
    placeReceivePill(homeScreen.isVisible());
  }
}

// Fast Debate Paste integration — subscribe to `external:insert-text`
// IPC dispatched by the main-process bridge so its `POST /insert`
// can drive an insertion against the focused window's live editor.
// Builds the inserted body nodes directly (no F2 routing), so the
// historical stray-tag bug the spec calls out can't happen here.
installExternalInsertHost({
  getFocusedView: () => getActiveView(),
  getFocusedDocTitle: () => activeFile().filename,
  // Doc-targeted inserts (GET /docs → insert with target): the pane
  // registry resolves a uid to its live view in this window, three-
  // pane aware, focused or not.
  resolveViewForUid: (uid) => getSpeechDocResolver().viewForUid(uid),
});
// Inbound /jump handler — core-owned surface (spec 6): the fast-paste
// bridge advertises schema 2 unconditionally, so a window must always
// answer `external:jump`, regardless of the `pluginsEnabled` switch.
// No-ops when the preload bridge is absent (web / old shells).
installPluginJumpHost({
  findViewForDocId: (docId) => findViewForDocId(docId),
});
// External-app consent: mirror the toggle + per-app decisions to main
// (which enforces them on /insert and /jump), run the first-contact
// consent prompt, and explain rejected unidentified callers. Not gated
// by `pluginsEnabled` — the bridge is not the plugin system.
installExternalConsent();
// Plugin system boot: install the window registry, then load the
// user-enabled plugins. Gated on the `pluginsEnabled` setting and on
// a plugin-capable desktop host (no-op on web / old shells).
async function initPlugins(): Promise<void> {
  if (!settings.get('pluginsEnabled')) return;
  const host = getElectronHost();
  if (!host?.pluginList || !host.pluginLoad) return; // desktop only
  // A registration lands AFTER every open view already built its keymap
  // (this whole function runs async post-boot), so a plugin's defaultKey
  // would be dead in the editor until an unrelated reconfigure. Rebuild
  // every open view's plugin set on each successful registration — same
  // reconfigure the ribbonKeyOverrides subscriber uses, per-uid so collab
  // bindings stay only on their session-owning doc.
  const rebuildKeymapsForPluginCommands = (): void => {
    for (const { uid, view: v } of getSpeechDocResolver().allViews()) {
      try {
        v.updateState(v.state.reconfigure({ plugins: buildEditorPlugins(uid) }));
      } catch (err) {
        console.warn('[plugins] keymap rebuild failed for a view:', err);
      }
    }
    // Custom ribbon buttons can bind plugin commands: one bound to a command
    // of the just-registered plugin materializes now (boot rendered before
    // the async plugin load), and an uninstalled plugin's button vanishes.
    renderCustomRibbonButtons();
  };
  installPluginRegistry((pluginId) =>
    createPluginApi(pluginId, {
      appVersion,
      getView: () => getActiveView(),
      findViewForDocId: (docId) => findViewForDocId(docId),
      getDocIdentity: () => {
        const a = activeDocIdentity();
        return { docId: a.docId, docTitle: activeFile().filename || 'Untitled' };
      },
      ensureDocId: () => {
        try {
          // Same three-step path the Learn flows use: mint the id, register
          // the doc (even unsaved) with the store, and stamp it into the file
          // so a plugin's extracted tokens re-associate on reload.
          const docId = ensureActiveDocId();
          const f = activeFile();
          learnStore.registerDoc({
            docId,
            path: typeof f.handle === 'string' ? f.handle : null,
            name: f.filename ?? 'Untitled',
            format: f.format,
          });
          void stampActiveFileDocId(docId);
          return docId;
        } catch {
          return null;
        }
      },
    }),
    { onCommandsChanged: rebuildKeymapsForPluginCommands },
  );
  let installed: { id: string; name: string; incompatible?: string }[];
  try {
    installed = (await host.pluginList()) as { id: string; name: string; incompatible?: string }[];
  } catch (err) {
    console.warn('[plugins] could not list installed plugins:', err);
    showToast('Plugins failed to load.');
    return;
  }
  // Drop leftovers (enabled flags, storage bags, key overrides) from
  // plugins whose install DIRECTORY is gone — the one unambiguous
  // "really uninstalled" signal; a mere load failure prunes nothing.
  reconcilePluginState(new Set(installed.map((p) => p.id)));
  for (const p of installed) {
    if (!isPluginEnabled(p.id)) continue;
    // Listed-but-incompatible (needs a newer CardMirror): main refuses to
    // serve its bundle anyway; skipping here avoids a spurious failure toast.
    if (p.incompatible) continue;
    // A rejecting IPC call must not skip the remaining plugins (or escape
    // the un-awaited initPlugins() as an unhandled rejection).
    const r = await host.pluginLoad(p.id).catch((err: unknown) => ({
      ok: false as const,
      error: err instanceof Error ? err.message : String(err),
    }));
    if (!r.ok) {
      console.warn(`[plugins] ${p.id} failed to load:`, r.error);
      showToast(`Plugin ${p.name} failed to load.`);
    }
  }
}
void initPlugins();
// Console gate for community (non-allowlisted) plugin installs. Installs
// `__plugins('community-on')` and re-arms main's unlock flag from the
// stored setting each boot; enforcement lives in main's installer.
installPluginCommunityGate();
// Read-scope plumbing (scoped host.readFileAtPath, PR #25 review):
// mirror the File-search folders into main at boot + on change, and
// hand main the pre-existing recents ONCE so they stay reopenable —
// the import channel closes itself after the first journal write.
{
  const eh = getElectronHost();
  if (eh) {
    let lastRoots = settings.get('fileSearchRoots');
    void eh.syncLibraryRoots(lastRoots);
    settings.subscribe(() => {
      const roots = settings.get('fileSearchRoots');
      if (roots !== lastRoots) {
        lastRoots = roots;
        void eh.syncLibraryRoots(roots);
      }
    });
    void eh.grantLegacyRecents(
      listRecents()
        .map((r) => r.handle)
        .filter((h): h is string => typeof h === 'string' && h.length > 0),
    );
  }
}
// Experimental, console-gated AI card cutter. Installs the
// `__cardcutter('on')` console entry point; does nothing visible
// until enabled.
installCardCutterGate();
// The port can't import index.ts (cycle) — inject the annotation docId
// so cutter-context notes (file guidance + designated sections) resolve
// for the active doc when the cutter assembles its context block.
setCutterDocIdProvider(() => activeAnnotationDocId());
// Start-on-launch: pre-warm the Verbatim Flow PowerShell host so the
// first Send to Flow doesn't pay the cold start. No-ops off Windows and
// when the setting is off; silent (no toast) on this automatic path.
if (settings.get('flowHostOnLaunch') && isWindowsHost()) {
  void runStartFlowHost(true);
}
requestAnimationFrame(positionDropzone);
window.addEventListener('resize', positionDropzone);
{
  const appEl = document.getElementById('app');
  if (appEl && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => positionDropzone()).observe(appEl);
  }
}

/** Anchor the dropzone pill to the bottom-left of the editor area —
 *  `#app` in single-doc, the leftmost visible pane body in multi-pane
 *  — from the target's live rect (so it tracks nav-width changes, the
 *  status bar, and layout). Inline left/bottom; CSS provides a sane
 *  fallback before the first run. */
function positionDropzone(): void {
  // Anchors the whole pill tray (dropzone + send + receive). Kept the name
  // for its existing call sites (rAF / resize / ResizeObserver hooks).
  const root = document.querySelector<HTMLElement>('.pmd-pill-tray');
  if (!root) return;
  const target = document.body.classList.contains('pmd-multi-doc')
    ? document.querySelector<HTMLElement>('.pmd-pane:not([hidden]) .pmd-pane-body')
    : document.getElementById('app');
  // Tag the multi-pane anchor pane (the leftmost visible one — the only pane the
  // tray sits over) so CSS can give just that pane a bottom runway, mirroring the
  // single-doc `padding-bottom`. Other panes have no pill over them and stay
  // flush. The class is moved off any pane that's no longer the anchor.
  const anchorPane = document.body.classList.contains('pmd-multi-doc')
    ? (target?.closest('.pmd-pane') ?? null)
    : null;
  document.querySelectorAll('.pmd-pane-pill-anchored').forEach((stale) => {
    if (stale !== anchorPane) stale.classList.remove('pmd-pane-pill-anchored');
  });
  anchorPane?.classList.add('pmd-pane-pill-anchored');
  const r = target?.getBoundingClientRect();
  if (!r || r.width === 0 || r.height === 0) {
    // Can't measure the anchor yet — booting into multi-doc with every
    // pane still `[hidden]` (no doc loaded), or a 0×0 layout pass. Drop
    // any inline position left over from the OTHER layout so the
    // mode-aware CSS fallback takes over instead of a stale value. (The
    // boot pass runs in single-pane context and inlines a `bottom`
    // measured against `#app`; without this it would strand the pill in
    // the multi-pane footer's band until an unrelated reflow re-ran us.)
    root.style.removeProperty('left');
    root.style.removeProperty('bottom');
    root.style.removeProperty('max-width');
    return;
  }
  root.style.left = `${Math.max(4, Math.round(r.left + 8))}px`;
  root.style.bottom = `${Math.max(4, Math.round(window.innerHeight - r.bottom + 8))}px`;
  // Cap the expanded shelf so its right edge keeps the same 8px margin
  // as the left (it's left-anchored, so without this it grows toward
  // the window edge).
  root.style.maxWidth = `${Math.max(160, Math.round(r.width - 16))}px`;
  // The scroll runway (so the last content clears the tray) is pure CSS: a
  // `padding-bottom` on the editable, gated on the pill-hidden class. Single-doc
  // pads `#editor .ProseMirror`; multi-pane pads only the anchored pane's editor
  // (tagged `.pmd-pane-pill-anchored` above) — no measurement needed here.
}
// Load the per-user Learn annotation store (flashcards / schedules /
// anchors) so review counts + the comments column have it available.
void loadLearnStore();

// Drag-and-drop file opening works in both single-doc and multi-pane modes.
installDragToOpen();

// Web only: disable the reload keyboard shortcut (Mod+R / F5), matching the
// desktop build (which removes the reload accelerator in the main process). An
// accidental reload would discard the in-memory session. Programmatic reloads
// (the mode switch) are unaffected, and an intentional reload is still available
// from the browser / app menu. Capture phase so we win before anything else;
// reliable in the installed PWA (a plain tab's browser chrome may still honor
// its own reload).
if (getHost().kind === 'browser') {
  window.addEventListener(
    'keydown',
    (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if ((mod && (e.key === 'r' || e.key === 'R')) || e.key === 'F5') {
        e.preventDefault();
      }
    },
    { capture: true },
  );
}

if (BOOT_MULTI_DOC_WORKSPACE) {
  void (async () => {
    // Singleton: only one three-pane window. Run the check alongside the shell
    // import; if an older three-pane window is already open, this is a
    // browser-spawned duplicate (Cmd+N / app icon) — bounce it instead of
    // opening a second workspace.
    const [older, m] = await Promise.all([
      anOlderMultiPaneWindowExists(),
      import('./multi-pane-shell.js'),
    ]);
    if (older) {
      redundantWindowBounced = true;
      closeSelfWithFallback(
        'You’re in three-pane mode — open new docs using in-app commands.',
      );
      return;
    }
    m.mountMultiPaneShell();
    // The dropzone pill anchors to the leftmost VISIBLE pane body, but
    // panes boot `[hidden]` until a doc loads — so the anchor doesn't
    // exist yet and a single reposition pass would early-return. The
    // `#app` ResizeObserver wired at boot is also dead here (`#app` is
    // `display:none` in multi-doc). Watch the live pane row instead:
    //   - ResizeObserver: layout / zoom / window changes.
    //   - MutationObserver on `hidden`: a pane un-hiding as its first
    //     doc mounts changes which pane is the anchor without resizing
    //     the row, so ResizeObserver alone misses it.
    requestAnimationFrame(positionDropzone);
    const row = document.querySelector<HTMLElement>('.pmd-multi-row');
    if (row) {
      if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(() => positionDropzone()).observe(row);
      }
      new MutationObserver(() => positionDropzone()).observe(row, {
        attributes: true,
        attributeFilter: ['hidden'],
        subtree: true,
      });
    }
    // Home screen in multi-pane: mounted here; its actions route
    // through the shell's slot picker rather than loading in-place.
    // Auto-shown whenever the workspace is EMPTY (blank launch below,
    // and the shell re-shows it when the last doc closes) — an empty
    // workspace would otherwise land on a bare window with no
    // affordances. Any doc entering a slot hides it.
    homeScreen.mount(document.body, homeCallbacks);
    // Tell main this window can take OS-opened files into its slot
    // picker (so "Open with…" reuses it instead of spawning a blank
    // window), and wire the forward channel.
    void getElectronHost()?.registerMultipane(true);
    installExternalOpenListener();
    // If this window was spawned for an OS open (cold launch), route
    // its initial doc through the slot picker instead of booting
    // blank. Skip recovery when we did — a spawned-for-a-file window
    // isn't the place to surface unrelated drafts (matches single-doc).
    const routedInitialDoc = await routeInitialDocIntoWorkspace();
    if (!routedInitialDoc) {
      // Blank multi-pane launch → land on the home screen, matching
      // single-pane. Shown BEFORE recovery (same order as single-pane):
      // the recovery sidebar overlays it, and a mode-switch reload's
      // auto-reopened docs hide it via the slot-populated hook.
      homeScreen.show();
      await runStartupRecovery();
    }
  })();
} else {
  // Home screen is a single-doc-mode feature (multi-pane has its
  // own workspace layout). Mount it before boot so the overlay is
  // ready when initSingleDocBoot decides whether to show it.
  homeScreen.mount(document.body, homeCallbacks);
  // Single-pane windows don't take OS-opened files in place — main
  // keeps spawning a fresh window per file. Report the mode so a
  // stale multi-pane registration (from before a mode-toggle reload)
  // is cleared.
  void getElectronHost()?.registerMultipane(false);
  // Mobile shell mounts its chrome over the single-doc machinery
  // (dynamic import — the shell imports back into this module, the
  // same cycle-break the multi-pane shell uses).
  if (BOOT_MOBILE) {
    void import('./mobile-shell.js').then((m) => m.mountMobileShell());
  }
  void initSingleDocBoot();
}

/** Single-doc boot. On hosts that support window spawning, check
 *  for a pending initial-doc payload first (this window may have
 *  been spawned by another window's Open / New click). If yes,
 *  mount the payload and skip the recovery sidebar (spawned
 *  windows aren't the right place to surface unrelated journal
 *  drafts — that belongs to the first window of the session).
 *  If no payload, mount the starter and run normal recovery. */
async function initSingleDocBoot(): Promise<void> {
  const host = getHost();
  // A spawned window carries an initial-doc payload. Check regardless of THIS
  // window's own `canSpawnWindow`: a web window spawned into a plain browser tab
  // isn't itself standalone, but must still mount the doc it was opened with.
  // `getInitialDoc` returns null cheaply when there's no pending payload.
  let payload: Awaited<ReturnType<typeof host.getInitialDoc>> = null;
  try {
    payload = await host.getInitialDoc();
  } catch (err) {
    console.warn('getInitialDoc failed:', err);
  }
  if (payload) {
    if (payload.joinShareCode) {
      await mountJoinedSession(payload.joinShareCode);
      return;
    }
    if (payload.resumeRoomId) {
      await mountResumedSession(payload.resumeRoomId);
      return;
    }
    await mountFromSpawnPayload(payload);
    return;
  }
  // No spawn payload — either this is the first window of an app
  // session or it's a blank window spawned later (e.g., the user
  // clicked "New document" while two other windows were already
  // open). Mount the starter doc in either case, but ONLY surface
  // the recovery sidebar on the first window: spawned-blank
  // windows would otherwise offer to recover the docs the user
  // already has open in OTHER windows of the same session, which
  // is both confusing and useless.
  mountView(currentDoc);
  syncSingleDocSpeechRegistration();
  // A window spawned by "New document" exists to be typed into — focus
  // the editor so typing works with no extra click. Gated on the home
  // overlay: when it's covering the editor (fresh launches that land on
  // Home), keystrokes belong to it, not to the doc underneath.
  if (!homeScreen.isVisible()) view?.focus();
  let isFirst = true;
  try {
    isFirst = await getHost().isFirstWindow();
  } catch (err) {
    console.warn('isFirstWindow failed; defaulting to true:', err);
  }
  // A mode-switch reload must run recovery in THIS window no matter
  // what: it's the switch's surviving window, but frequently NOT the
  // app session's first window — every single→multi switch closes
  // all the other windows, often including the original first, and
  // firstness never transfers. Gating the mode-switch reopen on
  // isFirstWindow alone would restore nothing after multi→single.
  const modeSwitchPending =
    sessionStorage.getItem(MODE_SWITCH_MARKER_KEY) !== null;
  if (modeSwitchPending) {
    console.log(`[cardmirror] modeswitch: single-pane boot, isFirst=${isFirst}`);
  }
  if (isFirst || modeSwitchPending) {
    // Launched with no file → show the home screen over the
    // (blank) starter doc. Recovery still runs underneath; if the
    // user recovers a draft it mounts + hides home via
    // runStartupRecovery's mount path. We show home first so a
    // no-recovery launch lands on the hub rather than a blank doc.
    homeScreen.show();
    await runStartupRecovery();
  }
  if (isFirst) {
    const electron = getElectronHost();
    // Update checks became opt-OUT (2026-07-27): flip an older
    // install's stored `false` default exactly once, with a one-time
    // notice pointing at the toggle. Runs before the launch check so
    // the flipped setting takes effect this very boot.
    if (electron) {
      migrateAutoUpdateOptOut(() => {
        showToast(
          'CardMirror now checks for updates automatically. You can turn this off — or pause it for a tournament — in Settings → General → About this install.',
        );
      });
    }
    // At-launch update check, gated on the same first-window rule
    // as the recovery UI — we don't want every spawned window in
    // a session to re-check or to re-pop "Update available" if the
    // user dismissed it on the first window. The main-process IPC
    // handler is a no-op in dev (non-packaged) builds, so the gate
    // here is renderer-side defense in depth.
    if (
      electron &&
      settings.get('checkForUpdatesOnLaunch') &&
      settings.get('updateChecksPausedUntil') <= Date.now() // tournament pause
    ) {
      try {
        await electron.triggerAutoUpdateCheck();
      } catch (err) {
        // Auto-launch check failures stay silent — the user didn't
        // ask for feedback. Manual checks have their own error path.
        console.warn('Auto-launch update check failed:', err);
      }
    }
    // Plus a DAILY background check (also silent unless an update is
    // found), so an app left running for days still notices updates.
    // Re-reads the setting each tick, so turning "Check for updates
    // automatically" off stops it; first window only, like above.
    if (electron) {
      window.setInterval(
        () => {
          if (
            settings.get('checkForUpdatesOnLaunch') &&
            settings.get('updateChecksPausedUntil') <= Date.now() // tournament pause
          ) {
            void electron.triggerAutoUpdateCheck().catch((err) => {
              console.warn('Daily update check failed:', err);
            });
          }
        },
        24 * 60 * 60 * 1000,
      );
    }
  }
}

/** A window spawned to accept a collaboration invite: mount a fresh pristine
 *  starter, then run the FULL join here so the session + Loro binding install
 *  together in this window (join's `newSessionDoc` swaps the starter for the
 *  session doc; pristine → no save prompt, and `spawnJoinWindow` returns false
 *  so there's no second spawn). */
async function mountJoinedSession(shareCode: string): Promise<void> {
  mountView(currentDoc);
  syncSingleDocSpeechRegistration();
  try {
    await loadCollabUi().then((m) => m.joinSessionWithCode(collabDeps, shareCode));
  } catch (err) {
    console.error('Join in spawned window failed:', err);
  }
}

/** A window spawned to resume a persisted session (home-screen Sessions list
 *  clicked while a real doc was open): mount a fresh pristine starter, then
 *  run the full resume here — the pristine starter means resumeSessionFlow's
 *  newSessionDoc swaps it in without a save prompt, and the session + binding
 *  land together in this window (mirrors mountJoinedSession). */
async function mountResumedSession(roomId: string): Promise<void> {
  mountView(currentDoc);
  syncSingleDocSpeechRegistration();
  try {
    await loadCollabUi().then((m) => m.resumeSessionFlow(collabDeps, roomId));
  } catch (err) {
    console.error('Resume in spawned window failed:', err);
  }
}

/** Mount a SpawnWindowPayload into this freshly-spawned window.
 *  Parses the bytes (cmir → parseNative, docx → fromDocxFull),
 *  mounts the result, and sets the doc-state module vars. */
async function mountFromSpawnPayload(
  payload: Awaited<ReturnType<ReturnType<typeof getHost>['getInitialDoc']>>,
): Promise<void> {
  if (!payload) return;
  // Genuinely-empty file (stat size 0 — main's OS-open path flags it):
  // mount as a blank document instead of erroring in parseNative. Same
  // substitution as resolveOpenedFile, which this path bypasses.
  if (opensAsBlank({ name: payload.filename, bytes: payload.bytes, emptyOnDisk: payload.emptyOnDisk })) {
    payload = {
      ...payload,
      bytes: await blankDocumentBytes(
        payload.format ?? formatFromFilename(payload.filename) ?? 'docx',
        makeBlankNewDoc(),
        { defaultFont: settings.get('bodyFont') },
      ),
    };
  }
  // Initial-doc / file-association opens land here without passing
  // through routeOpenedFile, so a password-protected file must be
  // handled at this parse point too.
  let openBytes: Uint8Array;
  try {
    openBytes = await maybeDecryptForOpen(payload.bytes, payload.filename);
  } catch (err) {
    if (err instanceof OpenCancelledError) return;
    void alertDialog(err instanceof Error ? err.message : String(err));
    return;
  }
  try {
    let docNode: PMNode;
    let docThreads: Thread[] | undefined;
    let docId: string | null;
    const format = payload.format ?? formatFromFilename(payload.filename) ?? 'docx';
    if (!bytesLookLikeDocx(openBytes)) {
      const parsed = parseNative(openBytes);
      docNode = parsed.doc;
      docThreads = parsed.threads.length > 0 ? parsed.threads : undefined;
      docId = parsed.docId;
    } else {
      const result = await fromDocxFull(openBytes);
      docNode = result.doc;
      docThreads = result.threads;
      docId = result.docId;
    }
    mountView(docNode, docThreads);
    currentDocFilename = payload.filename;
    setCurrentDocHandle(payload.handle);
    currentDocFormat = format;
    currentDocUid = payload.uid ?? newSessionDocUid();
    // A mode-switch respawn of a recovered, not-yet-saved draft re-marks it
    // here so the stale-overwrite guard + autosave hold-off survive the move
    // into this window.
    if (payload.uid && payload.recoveredFromSavedAt) {
      markRecoveredDraft(payload.uid, payload.recoveredFromSavedAt);
    }
    adoptDocId(docId, payload.filename, payload.handle, format);
    // Newly spawned window starts clean — even though it has
    // pre-loaded content from the originating window, it hasn't
    // been edited in THIS window's session. Exception: a mode-
    // switch respawn of a doc with unsaved changes — the payload
    // bytes hold edits that exist nowhere on disk, so the close
    // prompt must keep firing.
    if (payload.markDirty) markCurrentDocDirty();
    else markCurrentDocClean();
    syncSingleDocSpeechRegistration();
    if (payload.markAsSpeech) {
      // New Speech Document flow: the spawning window built the
      // doc + flagged us as the destination, so we self-mark now
      // that our view is registered with the resolver. Main will
      // broadcast `speech:changed` to every window, including the
      // originator, so the per-window banner + ribbon button
      // reflect the new state.
      getSpeechDocResolver().setSpeechByUid(currentDocUid);
      // Position the cursor inside the empty paragraph below the
      // Pocket header (when the speech doc was created WITH a
      // header) so the user can start typing / receiving sends
      // immediately. Without a header — `includeSpeechDocPocket`
      // off — the doc is just one paragraph and the default
      // selection lands inside it, no adjustment needed.
      if (view && docNode.firstChild?.type.name === 'pocket' && docNode.childCount > 1) {
        const pocketSize = docNode.firstChild.nodeSize;
        const cursorPos = pocketSize + 1;
        view.dispatch(
          view.state.tr.setSelection(
            TextSelection.create(view.state.doc, cursorPos),
          ),
        );
      }
    }
    // "Show in context": focus the card's anchored text once the new
    // doc's DOM has laid out (preciseScrollIntoView measures it).
    if (payload.focusAnchor) {
      const anchor = payload.focusAnchor;
      requestAnimationFrame(() => focusDescriptorInActiveView(anchor, payload.filename));
    }
    // A spawned window with real content exists to be worked in —
    // focus the editor so keyboard chords work with no extra click
    // (2026-07-27 focus audit; spawned-blank windows already do this
    // in the boot path). Home is never up in a spawned window, and
    // the focusAnchor rAF above wins afterwards when present.
    view?.focus();
    markNonPristineStarter();
    updateWindowTitle();
    console.log(`Spawned with ${payload.filename}: ${countSummary(docNode)}`);
  } catch (err) {
    if (err instanceof NativeDamagedError) {
      // Mount the starter FIRST so the window isn't broken if the
      // user declines; a confirmed salvage then replaces it. This
      // path covers spawned windows AND file-association opens
      // (double-clicking a .cmir), so the offer must live here too.
      mountView(currentDoc);
      await offerDamagedSalvage(payload.filename, openBytes);
      return;
    }
    console.error('Failed to mount spawned doc:', err);
    void alertDialog(`Failed to load: ${err instanceof Error ? err.message : err}`);
    // Fall back to the starter so the window isn't broken.
    mountView(currentDoc);
  }
}

// ─── Mode-switch handler ──────────────────────────────────────────
// When the user toggles `multiDocWorkspace`, prompt to reload. On
// confirm: journal every open doc with a "mode-switch" marker,
// reload the page, and let the startup-recovery flow silently
// reopen them in the new layout. On cancel: revert the setting.
let modeSwitchInFlight = false;
settings.subscribe((s, meta) => {
  if (modeSwitchInFlight) return;
  // The mobile shell forces single-doc rendering without writing the
  // synced `multiDocWorkspace` setting, so the boot constant can
  // disagree with the stored value here by design — never a switch.
  if (BOOT_MOBILE) return;
  // A `multiDocWorkspace` toggle in ANOTHER window reaches us through
  // the cross-window storage-event sync. Only the window the user
  // actually toggled in may drive the switch (close the other windows
  // and reload) — if every window ran it, each would try to be the
  // surviving host and close all the others, leaving nothing open. We
  // still absorb the new value; the initiating window will close us.
  if (meta.remote) return;
  if (s.multiDocWorkspace === BOOT_MULTI_DOC_WORKSPACE) return;
  void handleModeSwitch(s.multiDocWorkspace);
});

const MODE_SWITCH_MARKER_KEY = 'cardmirror:mode-switch-recovery';

async function handleModeSwitch(newValue: boolean): Promise<void> {
  try {
    await handleModeSwitchInner(newValue);
  } catch (err) {
    // A throw anywhere outside the inner journaling try (the confirm dialog,
    // the live-session-count bridge, the marker write) used to leave
    // modeSwitchInFlight stuck true — every later toggle a silent no-op for
    // the session — with the setting flipped but no switch performed. Fail
    // safe: revert the setting (subscriber skips: flag still set, value
    // matches boot) and unstick the guard.
    console.error('Mode switch crashed:', err);
    void alertDialog(
      `Couldn't switch modes: ${err instanceof Error ? err.message : err}\n\nStaying in the current layout.`,
    );
    settings.set('multiDocWorkspace', BOOT_MULTI_DOC_WORKSPACE);
    modeSwitchInFlight = false;
  }
}

async function handleModeSwitchInner(newValue: boolean): Promise<void> {
  modeSwitchInFlight = true;
  const electron = !!getElectronHost();
  let message: string;
  if (newValue) {
    message = electron
      ? 'Any other open CardMirror windows will close, and every open document will reopen as a pane in this window.'
      : 'Every open document will move into a pane in this window. Your other CardMirror windows will ask you to close them.';
  } else {
    message = electron
      ? 'The editor will reload and your open documents will each reopen in their own window.'
      : 'This window keeps the current document. Your other open documents will be closed — you’ll be prompted to save any with unsaved changes — and stay available in Recent Files.';
  }
  // Co-edited docs don't survive the reload as live sessions (they close and
  // stay resumable) — say so before the user commits.
  const liveSessions = collabLiveSessionCount();
  if (liveSessions > 0) {
    message +=
      liveSessions === 1
        ? ' Your co-editing session will close — reopen it from the Sessions list on the home screen (your unsynced changes are saved).'
        : ` Your ${liveSessions} co-editing sessions will close — reopen them from the Sessions list on the home screen (your unsynced changes are saved).`;
  }
  // In-DOM confirm (two equal buttons), NOT window.confirm: Electron's
  // native confirm on Windows/Linux never hands keyboard focus back to the
  // renderer — the editor was untypeable until a reload (field bug,
  // 2026-07-03; audit find, 2026-07-10). And not the big route-choice cards
  // either: those are for genuine multi-option decisions, not a yes/no
  // (field feedback, 2026-07-11).
  const confirmed = await confirmDialog(message, {
    title: newValue
      ? 'Switch to three-pane workspace?'
      : 'Switch to one-document-per-window mode?',
    okLabel: 'Switch',
  });
  if (!confirmed) {
    // Revert. The `modeSwitchInFlight` guard prevents the
    // subscriber from re-running and looping.
    settings.set('multiDocWorkspace', BOOT_MULTI_DOC_WORKSPACE);
    modeSwitchInFlight = false;
    return;
  }
  try {
    // If we're on Electron and other windows are open, have each
    // of them journal their current doc and close before we
    // reload. The post-reload recovery picks up every journal and
    // restores the docs in the new layout.
    const electronHost = getElectronHost();
    let remoteDocs: ModeSwitchDoc[] = [];
    if (electronHost) {
      await electronHost.journalAndCloseOtherWindows();
    } else if (newValue) {
      // Web → three-pane: ask the other windows to journal their doc(s) and
      // close over a BroadcastChannel, and collect what each had open. Their
      // journals land in the shared journal store; only the uid+dirty list
      // travels here, folded into the marker so the survivor reopens them too.
      remoteDocs = await webCloseOtherWindowsForModeSwitch();
    } else if (multiDocActive && multiDocReduceToFocused) {
      // Web → one-per-window: the browser can't reopen the other docs in their
      // own windows, so close them here (prompting to save unsaved ones) and
      // keep the focused doc, which the reload reopens in the single-doc window.
      // Close Settings first so each doc's save/discard prompt appears over the
      // workspace (with its pane focused), not over the Settings pane the toggle
      // was flipped in. Settings is lazy-loaded: if the module was never
      // fetched, the dialog can't be open — don't fetch it just to close it.
      if (settingsUiModule) (await settingsUiModule).closeSettings();
      const reduced = await multiDocReduceToFocused();
      if (!reduced) {
        // User cancelled a save prompt — abort the switch; stay in three-pane.
        settings.set('multiDocWorkspace', BOOT_MULTI_DOC_WORKSPACE);
        modeSwitchInFlight = false;
        return;
      }
    }
    // Journal the docs the new layout should reopen. Co-edited docs are
    // flushed + excluded by the helper: they CLOSE across the toggle and
    // stay resumable from the home-screen Sessions list. This replaces the
    // old auto-resume hand-off, which bound the session over the doc AFTER
    // it reopened editable (silently discarding edits made in the reload
    // gap) and only ever restored this window's sessions anyway.
    const reopenDocs = await journalForModeSwitchExcludingSessions();
    // The marker carries exactly which journals belong to this
    // switch (plus each doc's pre-switch dirty state) — this
    // window's non-session docs AND any collected from the windows
    // we just closed. The post-reload recovery reopens those and
    // ONLY those — without the list it would sweep in every journal
    // in the store, resurfacing stale entries from earlier sessions
    // on every toggle.
    sessionStorage.setItem(
      MODE_SWITCH_MARKER_KEY,
      encodeModeSwitchMarker([...reopenDocs, ...remoteDocs]),
    );
    console.log(
      `[cardmirror] modeswitch: journaled ${reopenDocs.length} local + ${remoteDocs.length} remote doc(s), switching to ${newValue ? 'multi' : 'single'}-pane`,
    );
  } catch (err) {
    console.error('Mode-switch journaling failed:', err);
    void alertDialog(
      `Couldn't save open documents before switching modes: ${err instanceof Error ? err.message : err}\n\nReverting.`,
    );
    settings.set('multiDocWorkspace', BOOT_MULTI_DOC_WORKSPACE);
    modeSwitchInFlight = false;
    return;
  }
  window.location.reload();
}

/** Mode-switch journaling with the co-editing contract applied: FLUSH every
 *  live session's record (so it stays resumable from the home-screen Sessions
 *  list), journal every open doc, then drop the co-edited docs' journals and
 *  exclude them from the returned reopen list — co-edited docs CLOSE across
 *  the switch rather than reopening as static copies beside their live
 *  session records. Shared by the toggling window (handleModeSwitch) and the
 *  windows it asks to close (the please-close handler), so both apply the
 *  same rule. No-op wrapper on web (no sessions there). */
async function journalForModeSwitchExcludingSessions(): Promise<ModeSwitchDoc[]> {
  let sessionUids = new Set<string>();
  try {
    const flushed = await collabCaptureSessionHandoff();
    sessionUids = new Set(flushed.map((h) => h.uid));
  } catch (err) {
    console.warn('Mode-switch session flush failed:', err);
  }
  const docs = await journalAllForModeSwitch();
  if (sessionUids.size === 0) return docs;
  // Delete the journals we just wrote for the co-edited docs so they don't
  // resurface as crash-recovery drafts on a later normal launch. (Their
  // content lives on in the just-flushed session records.)
  const host = getHost();
  await Promise.all(
    docs
      .filter((d) => sessionUids.has(d.uid))
      .map((d) => host.deleteJournal(d.uid).catch(() => {})),
  );
  console.log(
    `[cardmirror] modeswitch: left ${sessionUids.size} co-editing session(s) resumable`,
  );
  return docs.filter((d) => !sessionUids.has(d.uid));
}

/** Journal every currently-open doc so the post-reload recovery
 *  flow can restore them in the new layout, and return each doc's
 *  uid + pre-switch dirty state for the mode-switch marker.
 *  Cancels the single-doc debounce timer so a pending edit-driven
 *  write doesn't fire alongside the explicit one. */
async function journalAllForModeSwitch(): Promise<ModeSwitchDoc[]> {
  if (multiDocActive && multiDocJournalAll) {
    return await multiDocJournalAll();
  }
  // Untouched onboarding starter — nothing real is open in this
  // window. Journaling it would reopen a redundant Untitled doc
  // in the new layout.
  if (isPristineStarter && !currentDocDirty) return [];
  if (journalTimer !== null) {
    window.clearTimeout(journalTimer);
    journalTimer = null;
  }
  await runJournalWrite();
  return [{ uid: currentDocUid, dirty: currentDocDirty }];
}

/** Startup recovery — read any unsaved journals from the previous
 *  session and surface the recovery sidebar if there are any. The
 *  sidebar lets the user open each draft into the editor for
 *  inspection before deciding whether to keep it (save) or
 *  discard it. Drafts left undecided when the sidebar closes
 *  remain in the journal store for the next launch. */
async function runStartupRecovery(): Promise<void> {
  try {
    await runStartupRecoveryInner();
  } catch (err) {
    // Journals survive on disk — a recovery crash defers the offer to the
    // next launch rather than losing anything. Say so instead of dying mute
    // (an escaped throw here used to vanish into the boot IIFE).
    console.error('Startup recovery failed:', err);
    showToast(
      'Startup recovery hit an error — your drafts are safe and will be offered on the next launch.',
    );
  }
}

async function runStartupRecoveryInner(): Promise<void> {
  // No recovery offers on mobile — the sidebar is a desktop surface
  // (it would fight the mobile chrome), and the view-first shell is
  // the wrong place to adjudicate drafts. Journals stay put and
  // surface on the next desktop-layout launch.
  if (BOOT_MOBILE) {
    console.log('[cardmirror] mobile: skipping startup recovery (journals deferred to desktop)');
    return;
  }
  const host = getHost();
  if (!host.journalsSupported) return;
  let entries: JournalEntry[];
  try {
    entries = await host.readJournals();
  } catch (err) {
    console.warn('Failed to read recovery journals:', err);
    return;
  }
  // Mode-switch reload: the user toggled `multiDocWorkspace` and we
  // journaled the open docs before reloading. Auto-open exactly the
  // journals the switch wrote — and only those — silently in the
  // new layout, no recovery sidebar. Journals NOT in the switch's
  // list (crash leftovers from earlier sessions) stay put for the
  // next normal launch's sidebar.
  const markerDocs = decodeModeSwitchMarker(
    sessionStorage.getItem(MODE_SWITCH_MARKER_KEY),
  );
  if (markerDocs !== null) {
    sessionStorage.removeItem(MODE_SWITCH_MARKER_KEY);
    // Docs that were open in the windows the switch closed reported
    // their journals to main — sessionStorage is per-window, so
    // their lists can only reach us through the main process.
    let remoteDocs: ModeSwitchDoc[] = [];
    try {
      remoteDocs = (await getElectronHost()?.takeModeSwitchJournaledDocs()) ?? [];
    } catch (err) {
      console.warn('Failed to collect mode-switch doc reports:', err);
    }
    const dirtyByUid = modeSwitchDirtyMap([...markerDocs, ...remoteDocs]);
    const matched = entries.filter((e) => dirtyByUid.has(e.uid));
    console.log(
      `[cardmirror] modeswitch: recovery — ${entries.length} journal(s) on disk, ` +
        `${markerDocs.length} local + ${remoteDocs.length} remote in marker, ${matched.length} matched`,
    );
    await autoRecoverAll(matched, dirtyByUid);
    // Co-edited docs were NOT journaled into this switch (they close
    // keep-resumable) — nothing to auto-resume here. The user reopens them
    // from the home-screen Sessions list, which slot-picks like a join.
    return;
  }
  if (entries.length === 0) return;
  const { openRecoverySidebar } = await import('./recovery-ui.js');
  await openRecoverySidebar(entries, {
    onSave: async (entry) => {
      return saveRecoveryEntry(entry);
    },
    onOpen: async (entry) => {
      // Remember this is a recovered draft so its FIRST normal Ctrl-S runs the
      // same stale-overwrite guard as the sidebar's Save (the open-then-save
      // path has no on-disk baseline to catch it otherwise), and so autosave
      // holds off until that guarded save lands. The baseline is the entry's
      // recovered-from provenance when it has one — a draft recovered, edited,
      // and re-crashed keeps its original timestamp.
      markRecoveredDraft(entry.uid, journalStalenessBaseline(entry));
      // Multi-doc opens into a slot; single-doc replaces the
      // current view.
      if (multiDocActive && multiDocOnRecoveredDoc) {
        try {
          const parsed = parseNative(entry.bytes);
          await multiDocOnRecoveredDoc({
            uid: entry.uid,
            filename: entry.filename,
            handle: entry.handle,
            format: entry.format,
            docId: parsed.docId,
            doc: parsed.doc,
            threads: parsed.threads,
            // Sidebar recovery = crash recovery: the journal holds
            // content that never reached disk.
            dirty: true,
          });
        } catch (err) {
          console.warn(`Failed to parse recovery journal for ${entry.uid}:`, err);
        }
        return;
      }
      await applyRecovery(entry);
    },
    onDiscard: async (entry) => {
      try {
        await host.deleteJournal(entry.uid);
      } catch (err) {
        console.warn('Failed to discard journal:', err);
      }
    },
  });
}


/** Persist a recovery journal entry to disk without opening it in
 *  the editor. Used by the recovery sidebar's Save action so the
 *  user can finalize a draft directly from the sidebar.
 *
 *  In-place when `entry.handle` exists and we can save silently;
 *  otherwise opens the same Save-As modal the regular save path
 *  uses, defaulting to the entry's original filename / format.
 *  Deletes the journal entry on success so it doesn't reappear in
 *  the recovery list next launch. Returns whether the user
 *  committed to a save. */
/** Second confirmation before a recovery Save overwrites a file that's newer
 *  than the draft. Safe choice (Keep the file) is the default — Enter, Esc,
 *  and Cancel all resolve to keeping the file; only an explicit pick of the
 *  destructive option overwrites. `saveAs` keeps both: the newer file stays
 *  as-is and the draft goes to a location the user picks. */
async function promptStaleRecoveryOverwrite(
  name: string,
  journalSavedAtIso: string,
  fileMtimeMs: number,
): Promise<'keep' | 'saveAs' | 'overwrite'> {
  const fmt = (ms: number): string =>
    new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const displayName = name || 'this file';
  const choice = await promptForRouteChoice<'keep' | 'saveAs' | 'overwrite'>({
    message: `“${displayName}” on disk is newer than this recovered draft.`,
    choices: [
      {
        value: 'keep',
        label: 'Keep the file on disk',
        description: `Leaves the newer file (changed ${fmt(fileMtimeMs)}) as-is.`,
      },
      {
        value: 'saveAs',
        label: 'Save the draft elsewhere…',
        description: 'Keeps both: the newer file stays as-is and this draft saves to a new location.',
      },
      {
        value: 'overwrite',
        label: 'Replace it with the older draft',
        description: `Overwrites the newer file with this draft (from ${fmt(
          Date.parse(journalSavedAtIso),
        )}). The newer changes are lost and this can’t be undone.`,
      },
    ],
    cancelLabel: 'Cancel',
  });
  return choice ?? 'keep';
}

async function saveRecoveryEntry(entry: JournalEntry): Promise<boolean> {
  const host = getHost();
  // In-place save when we have a path-string handle (Electron) and the host
  // supports silent writes — re-serialize the journal's cmir bytes through
  // PM to either cmir-out (cheap) or docx-out (toDocx). A browser
  // FileSystemFileHandle survives the journal round-trip but carries no
  // write grant in this flow, so the web edition routes to the Save-As
  // modal below instead.
  if (typeof entry.handle === 'string' && entry.handle && entry.format && host.supportsInPlaceSave) {
    // Stale-journal guard: if the file on disk is newer than this journal,
    // it was edited (and saved) in a session AFTER the crash that left this
    // journal behind. Writing the journal would overwrite that newer work,
    // so require an explicit confirmation first. (A real recovery journal is
    // newer than the last save, so it never trips this.) "Save elsewhere"
    // keeps both versions via the Save-As modal below. The baseline is the
    // recovered-from provenance when the journal has one — re-journaling
    // stamps savedAt = now, which must not launder the check.
    let inPlace = true;
    const baseSavedAt = journalStalenessBaseline(entry);
    const disk = await host.statFile(entry.handle).catch(() => null);
    if (disk && journalPredatesFile(baseSavedAt, disk.mtimeMs)) {
      const choice = await promptStaleRecoveryOverwrite(entry.filename, baseSavedAt, disk.mtimeMs);
      if (choice === 'keep') return false;
      if (choice === 'saveAs') inPlace = false;
    }
    if (inPlace) {
      try {
        const bytes = await reserializeJournalAs(entry, entry.format);
        await host.saveExisting(entry.handle, bytes);
        await host.deleteJournal(entry.uid).catch(() => {
          /* best-effort */
        });
        return true;
      } catch (err) {
        // Original file renamed/moved/deleted since the crash — or its
        // location refuses writes (blocked cloud mount) → fall through to
        // the Save-As modal below so the draft still has an exit
        // (saveExisting no longer recreates files at stale paths).
        if (!isFileGoneError(err) && !isWriteBlockedError(err)) {
          console.error('Recovery save failed:', err);
          const lockedMsg = fileLockedMessage(err);
          void alertDialog(`Save failed: ${lockedMsg ?? (err instanceof Error ? err.message : err)}`);
          return false;
        }
      }
    }
  }
  // No handle, or host can't save in place — open the Save-As
  // modal pre-filled with the entry's name + format. Anything the
  // user picks here writes a fresh file.
  const choice = await openSaveAs({
    initialFilename: entry.filename || 'Untitled',
    defaultFormat: entry.format ?? 'cmir',
  });
  if (!choice) return false;
  try {
    const bytes = await reserializeJournalAs(entry, choice.format);
    const filters =
      choice.format === 'cmir'
        ? [{ name: 'CardMirror native (.cmir)', extensions: ['cmir'] }]
        : [{ name: 'Microsoft Word (.docx)', extensions: ['docx'] }];
    const result = await host.saveAs(choice.filename, bytes, {
      filters,
      // Land the dialog near the draft's original location (or its
      // nearest surviving parent, when the gone-file fallback routed
      // us here after a rename/move).
      ...(typeof entry.handle === 'string' && entry.handle ? { nearPath: entry.handle } : {}),
    });
    if (!result) return false;
    await host.deleteJournal(entry.uid).catch(() => {
      /* best-effort */
    });
    return true;
  } catch (err) {
    console.error('Recovery Save As failed:', err);
    void alertDialog(`Save As failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/** Convert a journal entry's stored cmir bytes into the requested
 *  on-disk format. cmir → cmir is a passthrough (the journal
 *  already stores cmir); cmir → docx parses the journal and runs
 *  the export pipeline. */
async function reserializeJournalAs(
  entry: JournalEntry,
  format: 'cmir' | 'docx',
): Promise<Uint8Array> {
  if (format === 'cmir') {
    // Defensive copy — entry.bytes may be a Buffer post-IPC.
    return entry.bytes instanceof Uint8Array
      ? entry.bytes
      : new Uint8Array(entry.bytes as ArrayBufferLike);
  }
  const parsed = parseNative(entry.bytes);
  const exportDoc = transformForExport(parsed.doc, {
    includeComments: true,
    includeAnalytics: true,
    includeUndertags: true,
    readMode: false,
    markedCardsOnly: false,
    markUnreadAfterMarker: settings.get('markUnreadAfterMarker'),
  });
  return toDocx(exportDoc, {
    ...(parsed.threads.length > 0 ? { threads: parsed.threads } : {}),
    defaultFont: settings.get('bodyFont'),
  });
}

/** Silently open every journal entry as part of a mode-switch
 *  reload — the user already confirmed; no sidebar, no per-entry
 *  decisions. Multi-doc routes each through the shell's slot
 *  router; single-doc on Electron mounts the most-recently-saved
 *  entry here and spawns a new window for each remaining entry
 *  (so a mode switch from panes → windows actually distributes
 *  the open docs across windows). Single-doc on the web edition
 *  mounts the most recent and leaves the rest as journals (they'll
 *  show up in the recovery sidebar on the next non-mode-switch
 *  launch). */
async function autoRecoverAll(
  entries: JournalEntry[],
  dirtyByUid?: ReadonlyMap<string, boolean>,
): Promise<void> {
  const host = getHost();
  // No dirty info (plain crash recovery) → treat everything as
  // dirty: the journal IS the unsaved content.
  const wasDirty = (uid: string): boolean => dirtyByUid?.get(uid) ?? true;
  // Mode-switch docs that were clean before the switch already
  // match their on-disk files — once reopened, their journals are
  // redundant. Dropping them keeps the store's journals-mean-
  // unsaved-work invariant: leftovers would resurface as bogus
  // recovery offers AND as stale extra docs on the next switch.
  const dropIfClean = async (uid: string): Promise<void> => {
    if (wasDirty(uid)) return;
    try {
      await host.deleteJournal(uid);
    } catch {
      /* best-effort */
    }
  };
  if (multiDocActive && multiDocOnRecoveredDoc) {
    for (const entry of entries) {
      try {
        // A recovered-draft mark rides the journal across the mode-switch
        // reload (the in-memory registry died with the old window) — without
        // this, toggling the workspace would strip the stale-overwrite guard
        // and unblock autosave for a draft that never had its guarded save.
        if (entry.recoveredFromSavedAt) {
          markRecoveredDraft(entry.uid, entry.recoveredFromSavedAt);
        }
        const parsed = parseNative(entry.bytes);
        await multiDocOnRecoveredDoc({
          uid: entry.uid,
          filename: entry.filename,
          handle: entry.handle,
          format: entry.format,
          docId: parsed.docId,
          doc: parsed.doc,
          threads: parsed.threads,
          dirty: wasDirty(entry.uid),
        });
        await dropIfClean(entry.uid);
        console.log(`[cardmirror] modeswitch: reopened "${entry.filename}" in a pane`);
      } catch (err) {
        console.warn(`Failed to auto-recover ${entry.uid}:`, err);
        showToast(`Couldn't reopen "${entry.filename}" — it may still be available from Recents.`);
      }
    }
    return;
  }
  // Single-doc: most-recent goes into THIS window; rest spawn new
  // windows on hosts that support it, else linger as journals.
  const sorted = [...entries].sort((a, b) =>
    (b.savedAt ?? '').localeCompare(a.savedAt ?? ''),
  );
  const winner = sorted[0];
  if (!winner) return;
  try {
    // Same mark carry-over as the pane path above.
    if (winner.recoveredFromSavedAt) {
      markRecoveredDraft(winner.uid, winner.recoveredFromSavedAt);
    }
    await applyRecovery(winner, { markDirty: wasDirty(winner.uid) });
    await dropIfClean(winner.uid);
    console.log(`[cardmirror] modeswitch: reopened "${winner.filename}" in this window`);
  } catch (err) {
    // One unreadable journal must not strand the rest — the spawn loop
    // below still reopens the other docs. The journal stays on disk.
    console.warn(`Failed to auto-recover ${winner.uid}:`, err);
    showToast(`Couldn't reopen "${winner.filename}" — it may still be available from Recents.`);
  }
  if (!host.canSpawnWindow) return;
  for (const entry of sorted.slice(1)) {
    try {
      await host.spawnWindow({
        filename: entry.filename,
        bytes: entry.bytes,
        // spawnWindow handoff carries a path string (Electron); a web handle
        // can't cross to a new window, so it coerces to null. (Web multi->single
        // never reaches here — reduceToFocused leaves only the focused doc.)
        handle: typeof entry.handle === 'string' ? entry.handle : null,
        format: entry.format,
        // Reuse the original uid so the spawned window's
        // journal continues to track the same logical doc.
        uid: entry.uid,
        markDirty: wasDirty(entry.uid),
        // The recovered-draft mark rides along so the stale-overwrite
        // guard survives the move to the new window.
        ...(entry.recoveredFromSavedAt
          ? { recoveredFromSavedAt: entry.recoveredFromSavedAt }
          : {}),
      });
      await dropIfClean(entry.uid);
      console.log(`[cardmirror] modeswitch: spawned a window for "${entry.filename}"`);
    } catch (err) {
      console.warn(`Failed to spawn window for recovered ${entry.uid}:`, err);
      showToast(`Couldn't reopen "${entry.filename}" — it may still be available from Recents.`);
    }
  }
}

/** Load a recovered journal entry into the single-doc editor (the
 *  recovered doc replaces the current one). Multi-doc routing
 *  happens inline in `runStartupRecovery` via the shell hook.
 *  `markDirty: false` is the mode-switch reopen of a doc that was
 *  clean before the switch — it mounts clean (its on-disk file
 *  already matches); everything else mounts dirty. */
async function applyRecovery(
  entry: JournalEntry,
  opts?: { markDirty?: boolean },
): Promise<void> {
  let parsed: ReturnType<typeof parseNative>;
  try {
    parsed = parseNative(entry.bytes);
  } catch (err) {
    console.warn(`Failed to parse recovery journal for ${entry.uid}:`, err);
    return;
  }
  mountView(parsed.doc, parsed.threads.length > 0 ? parsed.threads : undefined);
  currentDocFilename = entry.filename;
  setCurrentDocHandle(entry.handle);
  currentDocFormat = entry.format;
  // Reuse the original uid so a re-crash overwrites the same
  // journal slot (rather than accumulating new ones).
  currentDocUid = entry.uid;
  // Restore the Learn doc id from the recovered bytes so flashcards
  // re-associate (and a never-saved doc's cards stay keyed to the
  // reused uid above). adoptDocId registers it when present.
  adoptDocId(parsed.docId, entry.filename, entry.handle, entry.format);
  // Crash recovery restores content that wasn't successfully saved
  // on the previous session, so it mounts dirty. A mode-switch
  // reopen of a pre-switch-clean doc mounts clean instead.
  if (opts?.markDirty === false) markCurrentDocClean();
  else markCurrentDocDirty();
  syncSingleDocSpeechRegistration();
  markNonPristineStarter();
  updateWindowTitle();
  // Recovering a draft into the editor dismisses the home overlay.
  homeScreen.hide();
}

// Wire a live zone's "Re-pick source" (from its glyph menu) to reopen the picker
// in re-pick mode for that zone — same deps as the insertLiveZone command, which
// live in this module.
setRePickOpener((targetView, pos, identity) => {
  const paneEl =
    (targetView.dom.closest('.pmd-pane') as HTMLElement | null) ?? editorEl ?? null;
  quickCardSearchUI.open({
    view: targetView,
    paneEl,
    runCommand: runRibbonCommandById,
    openFilePath: openFileByPath,
    transcludeMode: true,
    docPath: getViewDocPath(targetView),
    rePickTarget: { pos, identity },
  });
});

// Wire a live zone's "Open source file" to resolve its linked .cmir (safely, in
// the main process) and open it in the app.
setOpenSourceOpener((targetView, pos) => {
  const node = targetView.state.doc.nodeAt(pos);
  if (!node || node.type.name !== 'transclusion_ref') return;
  const sourceRef = String(node.attrs['source_ref'] ?? '');
  if (!sourceRef) {
    showToast('This live zone has no linked source.');
    return;
  }
  const electron = getElectronHost();
  const docPath = getViewDocPath(targetView);
  if (!electron || !docPath) {
    showToast('Save this document first, then open the source.');
    return;
  }
  const base = node.attrs['source_ref_base'] === 'root' ? 'root' : 'doc';
  const roots = (settings.get('fileSearchRoots') as string[] | undefined) ?? [];
  const sourceAbs = String(node.attrs['source_abs'] ?? '');
  void electron.resolveCmirPath(docPath, sourceRef, base, roots, sourceAbs).then((abs) => {
    if (!abs) {
      showToast('Source file not found.');
      return;
    }
    void openFileByPath(abs, abs.split(/[\\/]/).pop() ?? 'source.cmir');
  });
});
