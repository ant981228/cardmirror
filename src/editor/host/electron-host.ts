/**
 * ElectronHost — the Host implementation for the Electron desktop
 * wrapper. Delegates every operation to the main process via the
 * preload-exposed `window.electronAPI`. The renderer never touches
 * Node directly; the bridge is intentionally narrow.
 *
 * Handles are plain strings (absolute file paths) — structured-clone
 * across IPC, no serialization tricks needed.
 */

import type { LearnOp } from '../learn-store.js';
import type {
  FileFilter,
  HistoryEnvelope,
  HistoryEnvelopeWrite,
  HistoryMeta,
  Host,
  JournalEntry,
  OpenFileOptions,
  OpenedFile,
  SaveAsOptions,
  SaveResult,
  SpawnWindowPayload,
} from './types.js';

/** Wire shape of a quick card across IPC. Structurally identical to
 *  the renderer's `QuickCard`; declared locally so this module takes
 *  no import dependency on the store (and no import cycle). */
export interface QuickCardIpc {
  id: string;
  name: string;
  tags: string[];
  contentJson: unknown;
  nameLower: string;
  tagsLower: string[];
  textLower: string;
  sourceName: string;
  createdAt: number;
  updatedAt: number;
}

/** Cross-machine card sharing IPC shapes. Declared locally (structurally
 *  identical to the renderer's pairing types) so this module takes no
 *  import dependency on the pairing stores — same convention as
 *  `QuickCardIpc`. */
export interface PairingAccountStatusIpc {
  /** False when the build/runtime doesn't enable the blog-account flow. */
  enabled: boolean;
  connected: boolean;
  /** Entitlement expiry, epoch ms (0 when none). */
  expiresAt: number;
  /** Member email the relay reported ('' when unknown). */
  email: string;
  /** The relay reported the linked membership inactive at the last
   *  renewal (optional: absent from older mains). */
  lapsed?: boolean;
}

export interface PairingConnectResultIpc {
  ok: boolean;
  /** 'seatLimit' | 'evicted' | 'badCode' | 'subscription' | 'unsupported' | 'network' | 'disabled' | 'http NNN' */
  error?: string;
  expiresAt?: number;
  email?: string;
  limit?: number;
  wouldEvict?: { routingCode: string; boundAt: string };
  /** Seat picker list (relay ≥ 2026-09-02); absent on older relays. */
  candidates?: Array<{ routingCode: string; boundAt: string; lastSeenAt?: string; label?: string }>;
  retryCode?: string;
}

export interface PairingConfigIpc {
  /** Whether the receive channel should run. */
  enabled: boolean;
  /** Optional name stamped (inside the ciphertext) on outgoing cards. */
  displayName: string;
  /** App version, for the cross-version guard. */
  schemaVersion: string;
  /** Compatibility floor stamped on cards this build sends — the minimum
   *  receiver version that can read them. Blank = any version may receive. */
  minReceiverVersion?: string;
  /** Poll cadence in seconds (fallback polling against legacy relays;
   *  floored to 5 min as the catch-up cadence while push-streaming). */
  pollSeconds: number;
  /** Self-hosted relay base URL ('' = the official relay). */
  relayUrl?: string;
  /** Bearer for a self-hosted relay ('' = the baked official token). */
  relayToken?: string;
}
export interface PairingSendItemIpc {
  label: string;
  type: string;
  sliceJson: unknown;
}
export interface PairingSendIpc {
  recipientCodes: string[];
  item: PairingSendItemIpc;
  via?: string;
  /** Per-message compatibility floor override (session invites carry the
   *  first invite-aware version; cards keep the config-level floor). */
  minReceiverVersion?: string;
}
export interface PairingInboxItemIpc {
  id: string;
  label: string;
  type: string;
  sliceJson: unknown;
  senderName: string;
  senderCode: string;
  via?: string;
  receivedAt: number;
  read: boolean;
}

/** Verbatim Flow bridge result shapes (mirrors verbatim-flow.ps1). */
export interface FlowAvailable {
  available: boolean;
  workbook?: string;
  reason?: string;
  error?: string;
}
export interface FlowResult {
  ok: boolean;
  written?: number;
  needsConfirm?: boolean;
  cell?: string;
  cells?: string[];
  template?: string;
  error?: string;
}

/** Final tallies from a bulk-compress run. */
export interface BulkCompressSummary {
  total: number;
  compressed: number;
  skipped: number;
  failed: number;
  bytesBefore: number;
  bytesAfter: number;
}
/** Throttled progress during a bulk-compress run (`done` of `total`). */
export interface BulkCompressProgress extends BulkCompressSummary {
  done: number;
}

/** The shape we expect the preload script to expose. Defined here
 *  (and not imported from the desktop workspace) so the editor
 *  doesn't take a build-time dependency on Electron-specific code. */
interface ElectronAPI {
  clipboardReadText(): Promise<string>;
  /** Main-process read of the html + plain clipboard flavors.
   *  Optional so a renderer against an older packaged shell falls
   *  back to text-only paste via clipboardReadText. */
  clipboardReadHtml?(): Promise<{ html?: unknown; text?: unknown }>;
  /** Main-process clipboard write (html + plain). Optional so a
   *  renderer against an older packaged shell falls back to the
   *  renderer clipboard. */
  clipboardWriteHtml?(html: string, text: string): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  pickDirectory(opts?: {
    defaultPath?: string;
    title?: string;
  }): Promise<string | null>;
  /** Native file picker returning the chosen PATH only (nothing is read
   *  and no read scope is granted — used for the file-search exclusion
   *  list). Optional so a renderer against an older packaged shell
   *  degrades gracefully (the settings UI hides its button). */
  pickFile?(opts?: {
    defaultPath?: string;
    title?: string;
    filters?: FileFilter[];
  }): Promise<string | null>;
  openFile(opts: { filters: FileFilter[] }): Promise<{
    name: string;
    bytes: Uint8Array;
    handle: string;
    /** Optional so an older main without the stat-0 flag is tolerated. */
    emptyOnDisk?: boolean;
  } | null>;
  /** Verbatim Flow bridge (Windows COM → Excel). Optional so an older
   *  preload tolerates its absence. */
  flowAvailable?(): Promise<FlowAvailable>;
  flowSend?(payload: { cells: string[] }, force?: boolean): Promise<FlowResult>;
  flowPull?(): Promise<FlowResult>;
  flowCreate?(templatePath?: string): Promise<FlowResult>;
  flowStartHost?(): Promise<FlowResult>;
  /** Card-cutter local plugin (experimental; optional so an older
   *  preload tolerates its absence). */
  cardCutterPickFile?(): Promise<string | null>;
  cardCutterLoad?(
    enginePath?: string | null,
  ): Promise<{ ok: boolean; path?: string; error?: string }>;
  /** Plugin manager (GitHub install; optional so an older preload
   *  tolerates its absence). Install is two-phase: inspect stages the
   *  release main-side and returns consent-dialog facts; commit writes
   *  after consent; discard drops the staged release on decline. */
  pluginInstallInspect?(ref: string): Promise<Record<string, unknown>>;
  pluginBrowse?(): Promise<Record<string, unknown>>;
  pluginInstallCommit?(token: string): Promise<Record<string, unknown>>;
  pluginInstallDiscard?(token: string): Promise<void>;
  pluginCommunityInstalls?(on: boolean): Promise<void>;
  pluginList?(): Promise<unknown[]>;
  pluginUninstall?(id: string): Promise<void>;
  pluginCheckUpdate?(id: string, repoRef: string): Promise<Record<string, unknown>>;
  pluginPickFile?(): Promise<string | null>;
  pluginLoad?(id: string): Promise<{ ok: boolean; error?: string }>;
  pluginLoadFile?(filePath: string): Promise<{ ok: boolean; error?: string }>;
  getPathForFile(file: File): string;
  minimizeWindow?(): Promise<void>;
  syncLibraryRoots?(roots: string[]): Promise<void>;
  grantLegacyRecents?(paths: string[]): Promise<boolean>;
  readFileAtPath(filePath: string): Promise<{
    name: string;
    bytes: Uint8Array;
    handle: string;
    format: 'cmir' | 'docx';
    /** Optional so an older main without the stat-0 flag is tolerated. */
    emptyOnDisk?: boolean;
  } | null>;
  statFile(filePath: string): Promise<{ mtimeMs: number; size: number } | null>;
  readCmirFile(
    docPath: string,
    sourceRef: string,
    base: 'doc' | 'root',
    roots: string[],
    sourceAbs?: string,
  ): Promise<{ bytes: Uint8Array; name: string } | null>;
  resolveCmirPath(
    docPath: string,
    sourceRef: string,
    base: 'doc' | 'root',
    roots: string[],
    sourceAbs?: string,
  ): Promise<string | null>;
  writeSourceAnchor(
    docPath: string,
    sourceRef: string,
    base: 'doc' | 'root',
    roots: string[],
    sourceAbs: string,
    bytes: Uint8Array,
  ): Promise<{ ok: true; name: string } | { ok: false; reason: string }>;
  saveAs(
    suggestedName: string,
    bytes: Uint8Array,
    opts: { filters: FileFilter[]; nearPath?: string },
  ): Promise<{ name: string; handle: string } | null>;
  saveExisting(handle: string, bytes: Uint8Array, opts?: { force?: boolean }): Promise<void>;
  saveSendDoc(
    opts: { folder: string | null; siblingHandle: string | null; filename: string },
    bytes: Uint8Array,
  ): Promise<{ name: string; handle: string } | 'collision' | null>;
  listFilesRecursive(dir: string, ext: string): Promise<Array<{ path: string; relPath: string }>>;
  /** Ask main for a direct MessagePort to the file-index service; it
   *  arrives via the `cardmirror:file-index-port` window message (see
   *  file-search-client.ts). Optional: older shells lack the service. */
  requestFileIndexPort?: () => void;
  writeFileAtPath(
    filePath: string,
    bytes: Uint8Array,
    opts?: { failIfExists?: boolean },
  ): Promise<'collision' | void>;
  bulkCompress(
    dir: string,
    onProgress: (p: BulkCompressProgress) => void,
  ): Promise<BulkCompressSummary>;
  writeJournal(entry: JournalEntry): Promise<void>;
  readJournals(): Promise<JournalEntry[]>;
  deleteJournal(uid: string): Promise<void>;
  writeHistory(envelope: HistoryEnvelopeWrite): Promise<void>;
  listHistory(): Promise<HistoryMeta[]>;
  readHistory(target: { roomId?: string; path?: string }): Promise<HistoryEnvelope | null>;
  historySnapshot?(
    docId: string,
    bytes: Uint8Array,
    policy: { retentionDays: number; maxDocBytes: number; maxTotalBytes: number },
    trigger?: 'manual' | 'auto' | 'close',
  ): Promise<{ stored: boolean; reason?: string }>;
  historyList?(
    docId: string,
  ): Promise<Array<{ id: string; ts: number; size: number; trigger?: 'manual' | 'auto' | 'close' }>>;
  historyRead?(docId: string, id: string): Promise<Uint8Array | null>;
  historyUsage?(): Promise<{ totalBytes: number; snapshots: number }>;
  historyClear?(): Promise<void>;
  deleteHistory(roomId: string): Promise<void>;
  pickHistoryFile(): Promise<string | null>;
  readLearnStore(): Promise<string | null>;
  applyLearnOp(op: LearnOp): Promise<string>;
  onLearnStoreChanged(handler: (json: string) => void): () => void;
  spawnWindow(payload: SpawnWindowPayload | null): Promise<void>;
  getInitialDoc(): Promise<SpawnWindowPayload | null>;
  isFirstWindow(): Promise<boolean>;
  /** Report this window's workspace mode to main (multi-pane vs
   *  single-pane) so the OS "Open with…" path can reuse a multi-pane
   *  window's slot picker instead of spawning a blank window. */
  registerMultipane(isMultiPane: boolean): Promise<void>;
  /** Main forwards an OS-opened file (absolute path) to this window
   *  when it's an existing multi-pane workspace. Returns unsubscribe. */
  onExternalOpen(handler: (payload: { path: string }) => void): () => void;
  journalAndCloseOtherWindows(): Promise<void>;
  closeSelf(): Promise<void>;
  /** Report that a close-request ended without closing (Cancel or a
   *  failed Save) so main can drop any pending quit intent. Optional
   *  so an older preload without the channel is tolerated. */
  cancelClose?(): Promise<void>;
  /** Optional so an older preload tolerates the mode-switch
   *  doc-list channel being absent. */
  reportModeSwitchJournaled?(docs: Array<{ uid: string; dirty: boolean }>): Promise<void>;
  takeModeSwitchJournaledDocs?(): Promise<Array<{ uid: string; dirty: boolean }>>;
  onPleaseCloseForModeSwitch(handler: () => void): () => void;
  onCloseRequest(handler: () => void): () => void;
  docRegister(uid: string): Promise<void>;
  docUnregister(uid: string): Promise<void>;
  /** Push the current filename for a uid so the Select-Speech-Doc
   *  modal can show meaningful row labels across every window. */
  docInfoUpdate(uid: string, filename: string | null): Promise<void>;
  /** Cross-window dropzone shelf. List returns current items;
   *  add/remove/clear mutate and broadcast via onDropzoneChanged. */
  dropzoneList(): Promise<
    Array<{ id: string; label: string; type: string; sliceJson: unknown; createdAt: number }>
  >;
  dropzoneAdd(item: {
    id: string;
    label: string;
    sliceJson: unknown;
    createdAt: number;
  }): Promise<void>;
  dropzoneRemove(id: string): Promise<void>;
  dropzoneClear(): Promise<void>;
  onDropzoneChanged(
    handler: (
      items: Array<{ id: string; label: string; type: string; sliceJson: unknown; createdAt: number }>,
    ) => void,
  ): () => void;

  /** Cross-window + persistent Quick Cards library. List returns the
   *  current cards; upsert/bulkUpsert/remove/clear mutate, persist to
   *  disk, and broadcast via onQuickCardsChanged. */
  quickCardsList(): Promise<QuickCardIpc[]>;
  quickCardsUpsert(card: QuickCardIpc): Promise<void>;
  quickCardsBulkUpsert(cards: QuickCardIpc[]): Promise<void>;
  quickCardsRemove(id: string): Promise<void>;
  quickCardsClear(): Promise<void>;
  onQuickCardsChanged(handler: (cards: QuickCardIpc[]) => void): () => void;

  /** Cross-machine card sharing. The main process holds the relay URL +
   *  token, runs the receive poller, and owns the inbox; the renderer
   *  configures it, sends, and reads the inbox through these. Optional so
   *  an older preload (without the pairing build) degrades gracefully. */
  pairingConfigure?(cfg: PairingConfigIpc): Promise<{ ownCode: string }>;
  pairingRegenerateKey?(): Promise<{ ownCode: string }>;
  pairingSend?(payload: PairingSendIpc): Promise<{ ok: number; fail: number; authFail?: number }>;
  pairingInboxList?(): Promise<PairingInboxItemIpc[]>;
  pairingInboxRemove?(id: string): Promise<void>;
  pairingInboxClear?(): Promise<void>;
  pairingInboxMarkAllRead?(): Promise<void>;
  /** Baked relay endpoint from the main process (same base + shared
   *  token card sharing uses) — the renderer-side rooms client falls
   *  back to this when no settings/dev override is present. Optional so
   *  an older preload degrades to settings-only resolution.
   *  `routingCode` (absent on older preloads) is '' unless the token is
   *  an entitlement — then it names this machine for the relay's
   *  machine-binding check. */
  collabRelayDefaults?(): Promise<{ url: string; token: string; routingCode?: string }>;
  /** Toggle Chromium DevTools on this window (packaged builds have no
   *  menu accelerators for it on Windows/Linux). */
  toggleDevTools?(): Promise<void>;
  /** System woke from sleep — long-lived streams should hard-restart. */
  onPowerResumed?(handler: () => void): () => void;
  onPairingInboxChanged?(handler: (items: PairingInboxItemIpc[]) => void): () => void;
  onPairingVersionMismatch?(
    handler: (info: {
      partnerVersion: string;
      localVersion: string;
      requiredVersion: string;
    }) => void,
  ): () => void;
  /** Relay rejected our credentials (401) — throttled in main. */
  onPairingUnauthorized?(handler: () => void): () => void;
  pairingConnectAccount?(payload: {
    connectCode: string;
    confirmEvict?: boolean;
    /** Routing code of the seat to unlink (from `candidates`). */
    evict?: string;
  }): Promise<PairingConnectResultIpc>;
  pairingAccountStatus?(): Promise<PairingAccountStatusIpc>;
  pairingDisconnectAccount?(): Promise<PairingAccountStatusIpc>;
  onPairingEntitlementChanged?(
    handler: (status: PairingAccountStatusIpc & { evicted?: boolean; lapsed?: boolean }) => void,
  ): () => void;

  /** Return every open doc across every window with its current
   *  filename, owning window, and speech-doc status. */
  listDocs(): Promise<
    Array<{
      uid: string;
      filename: string | null;
      windowId: number;
      windowTitle: string;
      isSpeech: boolean;
      isOwnWindow: boolean;
      isFocusedWindow: boolean;
    }>
  >;
  openPathCheck(path: string): Promise<{ takenByOther: boolean }>;
  openPathRegister(path: string): Promise<void>;
  openPathRelease(path: string): Promise<void>;
  /** "Show in context": if another window owns `path`, focus it and send
   *  it the anchor to scroll to. `delivered: false` ⇒ spawn a window. */
  focusAnchorInWindow(
    path: string,
    descriptor: { quote: string; prefix: string; suffix: string; approxPos: number },
  ): Promise<{ delivered: boolean }>;
  /** Receive a "scroll to this anchor" request from another window's
   *  "Show in context" (this window owns the path). Returns unsubscribe. */
  onFocusAnchor(
    handler: (payload: {
      descriptor: { quote: string; prefix: string; suffix: string; approxPos: number };
    }) => void,
  ): () => void;
  speechSet(uid: string | null): Promise<void>;
  speechGet(): Promise<{ uid: string | null }>;
  onSpeechChanged(handler: (state: { uid: string | null }) => void): () => void;
  speechSendSlice(payload: {
    sliceJson: unknown;
    atEnd: boolean;
  }): Promise<{ delivered: boolean; reason?: string }>;
  onIncomingSpeechSlice(
    handler: (payload: { uid: string; sliceJson: unknown; atEnd: boolean }) => void,
  ): () => void;
  /** Subscribe to menu-driven commands from the native menu bar.
   *  Returns an unsubscribe handle. */
  onMenuCommand(handler: (command: string) => void): () => void;
  /** Push the current keybinding map to main so the native menu's
   *  accelerator hints stay in sync with user rebinds. Values are
   *  PM-keymap strings; pass `null` for commands with no current
   *  binding so the accelerator slot is left blank. */
  setMenuBindings(bindings: Record<string, string | null>): Promise<void>;
  /** Run a manual auto-update check (mirrors Help → Check for
   *  Updates…). Resolves with a status the UI can render. */
  checkForUpdates(): Promise<{
    status: 'latest' | 'updating' | 'error' | 'dev';
    message?: string;
  }>;
  /** Trigger a silent at-launch update check. Same network call as
   *  `checkForUpdates`, but the main process suppresses the
   *  "you're on the latest" / "couldn't check" dialogs that the
   *  manual path shows — only the "Update available" dialog
   *  fires. No-op in dev (non-packaged) builds. Called from the
   *  renderer at boot iff `checkForUpdatesOnLaunch` is enabled. */
  triggerAutoUpdateCheck(): Promise<void>;
  /** Update chip (install-on-confirm): current staged/available update
   *  state (null = none), a subscription for changes, and the chip's
   *  click action (ready → restart-install; available → release page).
   *  See main.ts "Update chip" for the model. */
  getUpdateChipState(): Promise<{ state: 'available' | 'ready'; version: string } | null>;
  updateChipAction(): Promise<void>;
  onUpdateChip(
    handler: (payload: { state: 'available' | 'ready'; version: string } | null) => void,
  ): () => void;
  /** Floating always-on-top timer pop-out window. Optional so a
   *  renderer against an older packaged shell (preload without the
   *  timer API) simply never offers the pop-out button. The opener
   *  measures its rendered panel and passes its chrome zoom so the
   *  float hugs the content at the same scale (it has no host
   *  surface of its own to apply zoom with). */
  timerPopoutOpen?(opts?: {
    contentWidth: number;
    contentHeight: number;
    zoomFactor: number;
  }): Promise<void>;
  timerPopoutExists?(): Promise<boolean>;
  onTimerPopoutClosed?(handler: () => void): () => void;
  /** Open the OS file manager at the crash-dumps folder (mirrors
   *  Help → Open Crash Dumps Folder). */
  openCrashDumpsFolder(): Promise<void>;
  /** Open the OS file manager at the crash-recovery journals folder. */
  openJournalsFolder(): Promise<void>;
  showItemInFolder?(handle: string): Promise<void>;
  /** Renderer accessibility tree toggle. Default off — works around a known
   *  Chromium AX-serialization crash. Machine-local pref; changing it needs an
   *  app restart (`relaunchApp`). `isAccessibilitySupportActive` reports whether
   *  an assistive-tech / UI-Automation client is currently connected. */
  getAccessibilityTreeEnabled(): Promise<boolean>;
  setAccessibilityTreeEnabled(enabled: boolean): Promise<void>;
  /** The state actually applied this session (may differ from the saved pref
   *  until a restart). */
  getAccessibilityTreeApplied(): Promise<boolean>;
  isAccessibilitySupportActive(): Promise<boolean>;
  relaunchApp(): Promise<void>;
  /** Chromium page-zoom factor for this window (1.0 = 100%).
   *  Synchronous renderer-side call into Electron's `webFrame`. */
  setZoomFactor(factor: number): void;
  getZoomFactor(): number;

  /** Fast Debate Paste integration. The renderer subscribes to
   *  `external:insert-text` requests dispatched from the main-process
   *  HTTP bridge (`apps/desktop/src/fast-paste-bridge.ts`), and replies
   *  via `external:insert-result`. Wire contract lives in the FDP
   *  integration spec (reference-docs). */
  onExternalInsertRequest(
    handler: (req: {
      requestId: string;
      text: string;
      role: string; // ExternalInsertRole (external-insert.ts) — heading roles included since PR #28
      newParagraph: boolean;
      omitted: boolean;
      target?: string;
    }) => void,
  ): () => void;
  sendExternalInsertResult(result: {
    requestId: string;
    ok: boolean;
    error?: string;
    docTitle?: string;
  }): void;
  /** Plugin bridge (plugin API v1). Optional so an older preload
   *  tolerates their absence — callers fall back gracefully. The
   *  jump request/result pair mirrors the external-insert pair
   *  above (`external:jump` / `external:jump-result`). */
  pluginJump?(source: string): Promise<Record<string, unknown>>;
  flowApps?(): Promise<unknown[]>;
  flowPost?(appId: string, route: string, body: unknown): Promise<Record<string, unknown>>;
  onExternalJumpRequest?(
    handler: (req: { requestId: string; source: string }) => void,
  ): () => void;
  sendExternalJumpResult?(result: {
    requestId: string;
    ok: boolean;
    error?: string;
  }): void;
  /** External-app consent (apps/desktop/src/external-consent.ts):
   *  settings-mirror sync to main, the first-contact prompt pair, and
   *  fire-and-forget notes (lastSeen stamps, unidentified-caller
   *  notices). Optional so an older preload tolerates their absence. */
  syncExternalConsent?(state: {
    policy: 'off' | 'ask' | 'open';
    apps: Record<string, 'allow' | 'deny'>;
  }): void;
  onExternalConsentPrompt?(
    handler: (req: {
      requestId: string;
      appId: string;
      appName: string | null;
      appVersion: string | null;
    }) => void,
  ): () => void;
  sendExternalConsentPromptResult?(result: { requestId: string; outcome: string }): void;
  onExternalConsentNote?(
    handler: (note: { kind: 'seen' | 'unidentified'; appId?: string; when?: string }) => void,
  ): () => void;
}

function api(): ElectronAPI {
  const x = (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
  if (!x) throw new Error('ElectronHost selected but window.electronAPI is missing.');
  return x;
}

export class ElectronHost implements Host {
  readonly kind = 'electron' as const;
  readonly supportsInPlaceSave = true;
  readonly journalsSupported = true;
  readonly canSpawnWindow = true;

  async clipboardReadText(): Promise<string> {
    return api().clipboardReadText();
  }

  async clipboardReadHtml(): Promise<{ html: string; text: string } | null> {
    const fn = api().clipboardReadHtml;
    if (!fn) return null; // older shell — caller falls back to text
    const r = await fn.call(api());
    return {
      html: typeof r?.html === 'string' ? r.html : '',
      text: typeof r?.text === 'string' ? r.text : '',
    };
  }

  async clipboardWriteHtml(html: string, text: string): Promise<boolean> {
    const fn = api().clipboardWriteHtml;
    if (!fn) return false; // older shell — caller falls back
    return (await fn.call(api(), html, text)) === true;
  }

  async openExternal(url: string): Promise<void> {
    await api().openExternal(url);
  }

  async pickDirectory(opts?: {
    defaultPath?: string;
    title?: string;
  }): Promise<string | null> {
    return api().pickDirectory(opts);
  }

  async pickFile(opts?: {
    defaultPath?: string;
    title?: string;
    filters?: FileFilter[];
  }): Promise<string | null> {
    return (await api().pickFile?.(opts)) ?? null;
  }

  /** Verbatim Flow bridge (Windows COM → Excel). Resolve a "windows-only"
   *  / "unsupported" result on hosts that can't do it. */
  async flowAvailable(): Promise<FlowAvailable> {
    return (await api().flowAvailable?.()) ?? { available: false, error: 'unsupported' };
  }
  async flowSend(payload: { cells: string[] }, force?: boolean): Promise<FlowResult> {
    return (await api().flowSend?.(payload, force)) ?? { ok: false, error: 'unsupported' };
  }
  async flowPull(): Promise<FlowResult> {
    return (await api().flowPull?.()) ?? { ok: false, error: 'unsupported' };
  }
  async flowCreate(templatePath?: string): Promise<FlowResult> {
    return (await api().flowCreate?.(templatePath)) ?? { ok: false, error: 'unsupported' };
  }
  async flowStartHost(): Promise<FlowResult> {
    return (await api().flowStartHost?.()) ?? { ok: false, error: 'unsupported' };
  }

  /** Card-cutter local plugin: pick the engine file / load it from disk
   *  into the renderer. No-ops gracefully on an older preload. */
  async cardCutterPickFile(): Promise<string | null> {
    return (await api().cardCutterPickFile?.()) ?? null;
  }
  async cardCutterLoad(
    enginePath?: string | null,
  ): Promise<{ ok: boolean; path?: string; error?: string }> {
    return (
      (await api().cardCutterLoad?.(enginePath ?? null)) ?? {
        ok: false,
        error: 'card-cutter loading unsupported by this build',
      }
    );
  }

  /** Plugin manager (GitHub install). No-ops gracefully on an older
   *  preload that predates the plugin surface. */
  async pluginInstallInspect(ref: string): Promise<Record<string, unknown>> {
    return (await api().pluginInstallInspect?.(ref)) ?? { ok: false, error: 'unsupported' };
  }
  async pluginBrowse(): Promise<Record<string, unknown>> {
    return (
      (await api().pluginBrowse?.()) ?? { ok: false, error: 'This build has no plugin directory.' }
    );
  }
  async pluginInstallCommit(token: string): Promise<Record<string, unknown>> {
    return (await api().pluginInstallCommit?.(token)) ?? { ok: false, error: 'unsupported' };
  }
  async pluginInstallDiscard(token: string): Promise<void> {
    await api().pluginInstallDiscard?.(token);
  }
  async pluginCommunityInstalls(on: boolean): Promise<void> {
    await api().pluginCommunityInstalls?.(on);
  }
  async pluginList(): Promise<unknown[]> {
    return (await api().pluginList?.()) ?? [];
  }
  async pluginUninstall(id: string): Promise<void> {
    await api().pluginUninstall?.(id);
  }
  async pluginCheckUpdate(id: string, repoRef: string): Promise<Record<string, unknown>> {
    return (await api().pluginCheckUpdate?.(id, repoRef)) ?? { ok: false, error: 'unsupported' };
  }
  async pluginPickFile(): Promise<string | null> {
    return (await api().pluginPickFile?.()) ?? null;
  }
  async pluginLoad(id: string): Promise<{ ok: boolean; error?: string }> {
    return (
      (await api().pluginLoad?.(id)) ?? {
        ok: false,
        error: 'plugin loading unsupported by this build',
      }
    );
  }
  async pluginLoadFile(filePath: string): Promise<{ ok: boolean; error?: string }> {
    return (
      (await api().pluginLoadFile?.(filePath)) ?? {
        ok: false,
        error: 'plugin loading unsupported by this build',
      }
    );
  }

  /** Plugin bridge (v1) — bound only when the preload exposes it, so a
   *  capability check (`host.pluginJump`) reflects the running shell:
   *  callers pick their own renderer-side fallback (e.g. jumpToSource's
   *  doc-not-open-with-title), which a stub wrapper couldn't produce. */
  readonly pluginJump? = api().pluginJump?.bind(api());
  readonly flowApps? = api().flowApps?.bind(api());
  readonly flowPost? = api().flowPost?.bind(api());

  async openFile(opts: OpenFileOptions = {}): Promise<OpenedFile | null> {
    const result = await api().openFile({ filters: opts.filters ?? [] });
    if (!result) return null;
    // Normalize the bytes — IPC sometimes hands us a Buffer-like
    // object (Node's `Buffer extends Uint8Array`); wrapping
    // guarantees a plain Uint8Array view that downstream code can
    // pass to `fromDocxFull` etc.
    return {
      name: result.name,
      bytes: result.bytes instanceof Uint8Array ? result.bytes : new Uint8Array(result.bytes),
      handle: result.handle,
      ...(result.emptyOnDisk === true ? { emptyOnDisk: true } : {}),
    };
  }

  /** Absolute path of a dropped File (drag-to-open). '' when it can't be
   *  resolved (no real path, or the bridge call fails). */
  getPathForFile(file: File): string {
    try {
      return api().getPathForFile(file);
    } catch {
      return '';
    }
  }

  /** Read a file at a known path without a picker. Returns null
   *  when the path is missing / unreadable (caller prunes the
   *  stale recent). ElectronHost-only — the home screen guards
   *  on host kind before calling. */
  /** Minimize this OS window. No-ops gracefully on an older preload. */
  async minimizeWindow(): Promise<void> {
    await api().minimizeWindow?.();
  }

  /** Read-scope plumbing — no-ops gracefully on an older preload. */
  async syncLibraryRoots(roots: string[]): Promise<void> {
    await api().syncLibraryRoots?.(roots);
  }
  async grantLegacyRecents(paths: string[]): Promise<boolean> {
    return (await api().grantLegacyRecents?.(paths)) ?? false;
  }
  async readFileAtPath(filePath: string): Promise<{
    name: string;
    bytes: Uint8Array;
    handle: string;
    format: 'cmir' | 'docx';
    emptyOnDisk?: boolean;
  } | null> {
    const result = await api().readFileAtPath(filePath);
    if (!result) return null;
    return {
      name: result.name,
      bytes: result.bytes instanceof Uint8Array ? result.bytes : new Uint8Array(result.bytes),
      handle: result.handle,
      format: result.format,
      ...(result.emptyOnDisk === true ? { emptyOnDisk: true } : {}),
    };
  }

  /** Stat a file for the recovery-save staleness check. `handle` is an
   *  Electron absolute-path string; anything else resolves to null. */
  async statFile(handle: unknown): Promise<{ mtimeMs: number; size: number } | null> {
    if (typeof handle !== 'string' || !handle) return null;
    return api().statFile(handle);
  }

  /** Resolve a doc-relative `.cmir` ref and read it (for a transclusion
   *  refresh). Main handles resolution + library-root scoping + traversal
   *  rejection; null means "couldn't safely read." ElectronHost-only. */
  async readCmirFile(
    docPath: string,
    sourceRef: string,
    base: 'doc' | 'root',
    roots: string[],
    sourceAbs = '',
  ): Promise<{ bytes: Uint8Array; name: string } | null> {
    const result = await api().readCmirFile(docPath, sourceRef, base, roots, sourceAbs);
    if (!result) return null;
    return {
      bytes: result.bytes instanceof Uint8Array ? result.bytes : new Uint8Array(result.bytes),
      name: result.name,
    };
  }

  /** Resolve a `.cmir` ref to its safe absolute path (for opening the linked
   *  file); null when it can't be safely resolved. ElectronHost-only. */
  async resolveCmirPath(
    docPath: string,
    sourceRef: string,
    base: 'doc' | 'root',
    roots: string[],
    sourceAbs = '',
  ): Promise<string | null> {
    return api().resolveCmirPath(docPath, sourceRef, base, roots, sourceAbs);
  }

  /** Write an anchored `.docx` back over its source so a raw Word file becomes a
   *  refreshable live-zone source. Main re-checks containment (same boundary as
   *  reading), refuses non-`.docx`, and writes atomically. ElectronHost-only. */
  async writeSourceAnchor(
    docPath: string,
    sourceRef: string,
    base: 'doc' | 'root',
    roots: string[],
    sourceAbs: string,
    bytes: Uint8Array,
  ): Promise<{ ok: true; name: string } | { ok: false; reason: string }> {
    return api().writeSourceAnchor(docPath, sourceRef, base, roots, sourceAbs, bytes);
  }

  async saveAs(
    suggestedName: string,
    bytes: Uint8Array,
    opts: SaveAsOptions = {},
  ): Promise<SaveResult | null> {
    const result = await api().saveAs(suggestedName, bytes, {
      filters: opts.filters ?? [],
      ...(opts.nearPath ? { nearPath: opts.nearPath } : {}),
    });
    if (!result) return null;
    return { name: result.name, handle: result.handle };
  }

  async saveExisting(
    handle: unknown,
    bytes: Uint8Array,
    opts?: { force?: boolean },
  ): Promise<void> {
    if (typeof handle !== 'string') {
      throw new Error(
        'ElectronHost: saveExisting requires a string path handle.',
      );
    }
    await api().saveExisting(handle, bytes, opts);
  }

  /** Electron writes to absolute paths — always writable, no permission model. */
  async ensureWritable(_handle: unknown): Promise<boolean> {
    return true;
  }

  /** Silent "Save Send Doc" write. `opts.folder` (fixed-folder mode)
   *  or `opts.siblingHandle` (same-folder mode, the source file's path)
   *  resolves the destination directory in main. Returns the written
   *  file's name + path, `'collision'` when the target would overwrite
   *  the source (caller should fall back to Save As), or `null` when the
   *  destination couldn't be resolved. */
  async saveSendDoc(
    opts: { folder: string | null; siblingHandle: string | null; filename: string },
    bytes: Uint8Array,
  ): Promise<{ name: string; handle: string } | 'collision' | null> {
    return api().saveSendDoc(opts, bytes);
  }

  async listFilesRecursive(dir: string, ext: string): Promise<Array<{ path: string; relPath: string }>> {
    return api().listFilesRecursive(dir, ext);
  }

  /** Kick the file-index-port hand-off. Returns whether the shell
   *  supports the service (older preloads don't — file search then
   *  reads as unavailable, like an empty roots list). */
  requestFileIndexPort(): boolean {
    const fn = api().requestFileIndexPort;
    if (typeof fn !== 'function') return false;
    fn();
    return true;
  }

  async writeFileAtPath(
    filePath: string,
    bytes: Uint8Array,
    opts?: { failIfExists?: boolean },
  ): Promise<'collision' | void> {
    return await api().writeFileAtPath(filePath, bytes, opts);
  }

  async bulkCompress(
    dir: string,
    onProgress: (p: BulkCompressProgress) => void,
  ): Promise<BulkCompressSummary> {
    return api().bulkCompress(dir, onProgress);
  }

  async writeJournal(entry: JournalEntry): Promise<void> {
    await api().writeJournal(entry);
  }

  async readJournals(): Promise<JournalEntry[]> {
    const raw = await api().readJournals();
    // Normalize bytes — they may arrive as a Buffer-shaped object
    // after the structured clone. Same defensive wrap as openFile.
    return raw.map((entry) => ({
      ...entry,
      bytes: entry.bytes instanceof Uint8Array ? entry.bytes : new Uint8Array(entry.bytes as ArrayBufferLike),
    }));
  }

  async deleteJournal(uid: string): Promise<void> {
    await api().deleteJournal(uid);
  }

  /** Collab session-history files — envelopes are plain JSON (the
   *  snapshot rides as base64), so unlike journals no byte
   *  normalization is needed across the IPC boundary. */
  async writeHistory(envelope: HistoryEnvelopeWrite): Promise<void> {
    await api().writeHistory(envelope);
  }

  async listHistory(): Promise<HistoryMeta[]> {
    return api().listHistory();
  }

  async readHistory(target: { roomId?: string; path?: string }): Promise<HistoryEnvelope | null> {
    return api().readHistory(target);
  }

  /** Version-history snapshot store (userData/history). All no-op
   *  gracefully on an older preload without the surface. */
  async historySnapshot(
    docId: string,
    bytes: Uint8Array,
    policy: { retentionDays: number; maxDocBytes: number; maxTotalBytes: number },
    trigger?: 'manual' | 'auto' | 'close',
  ): Promise<{ stored: boolean; reason?: string }> {
    return (await api().historySnapshot?.(docId, bytes, policy, trigger)) ?? { stored: false };
  }
  async historyList(
    docId: string,
  ): Promise<Array<{ id: string; ts: number; size: number; trigger?: 'manual' | 'auto' | 'close' }>> {
    return (await api().historyList?.(docId)) ?? [];
  }
  async historyRead(docId: string, id: string): Promise<Uint8Array | null> {
    return (await api().historyRead?.(docId, id)) ?? null;
  }
  async historyUsage(): Promise<{ totalBytes: number; snapshots: number }> {
    return (await api().historyUsage?.()) ?? { totalBytes: 0, snapshots: 0 };
  }
  async historyClear(): Promise<void> {
    await api().historyClear?.();
  }

  async deleteHistory(roomId: string): Promise<void> {
    await api().deleteHistory(roomId);
  }

  async pickHistoryFile(): Promise<string | null> {
    return api().pickHistoryFile();
  }

  async readLearnStore(): Promise<string | null> {
    return api().readLearnStore();
  }

  applyLearnOp(op: LearnOp): Promise<string> {
    return api().applyLearnOp(op);
  }

  onLearnStoreChanged(handler: (json: string) => void): () => void {
    return api().onLearnStoreChanged(handler);
  }

  async spawnWindow(payload: SpawnWindowPayload | null): Promise<void> {
    await api().spawnWindow(payload);
  }

  async getInitialDoc(): Promise<SpawnWindowPayload | null> {
    const result = await api().getInitialDoc();
    if (!result) return null;
    return {
      ...result,
      bytes: result.bytes instanceof Uint8Array
        ? result.bytes
        : new Uint8Array(result.bytes as ArrayBufferLike),
    };
  }

  async isFirstWindow(): Promise<boolean> {
    return await api().isFirstWindow();
  }

  async registerMultipane(isMultiPane: boolean): Promise<void> {
    // Tolerate an older preload (no channel) — main just won't reuse
    // this window for OS opens, falling back to spawn-a-window.
    await api().registerMultipane?.(isMultiPane);
  }

  onExternalOpen(handler: (payload: { path: string }) => void): () => void {
    const fn = api().onExternalOpen;
    return typeof fn === 'function' ? fn(handler) : () => {};
  }

  /** Mode-switch helper. Asks main to broadcast a please-close
   *  message to every other window and resolve once they've all
   *  closed. The originating renderer then journals its own doc
   *  and reloads. */
  async journalAndCloseOtherWindows(): Promise<void> {
    await api().journalAndCloseOtherWindows();
  }

  /** Programmatic "close this window." Called by the please-close
   *  handler after the renderer finishes journaling. */
  async closeSelf(): Promise<void> {
    await api().closeSelf();
  }

  /** Tell main a close-request was resolved without closing (Cancel
   *  or a failed Save) so it can drop any pending quit intent. */
  async cancelClose(): Promise<void> {
    await api().cancelClose?.();
  }

  /** Mode-switch helper: report the docs this window journaled in
   *  response to a please-close, so the surviving window can scope
   *  its post-reload auto-recovery to exactly the switch's docs. */
  async reportModeSwitchJournaled(docs: Array<{ uid: string; dirty: boolean }>): Promise<void> {
    await api().reportModeSwitchJournaled?.(docs);
  }

  /** Mode-switch helper: fetch (and clear) the doc lists the closed
   *  windows reported. Called once by the surviving window after
   *  its reload. */
  async takeModeSwitchJournaledDocs(): Promise<Array<{ uid: string; dirty: boolean }>> {
    return (await api().takeModeSwitchJournaledDocs?.()) ?? [];
  }

  /** Subscribe to mode-switch please-close broadcasts. */
  onPleaseCloseForModeSwitch(handler: () => void): () => void {
    return api().onPleaseCloseForModeSwitch(handler);
  }

  /** Subscribe to user-initiated window close requests. Main fires
   *  this when the user clicks the OS close button so the renderer
   *  can prompt for unsaved-doc handling before the window closes. */
  onCloseRequest(handler: () => void): () => void {
    return api().onCloseRequest(handler);
  }

  /** Doc-lifecycle reporting for the main-process speech-doc
   *  registry. Renderers call this on mount and unregister on close
   *  so main knows which window owns each uid. */
  async docRegister(uid: string): Promise<void> {
    await api().docRegister(uid);
  }

  async docUnregister(uid: string): Promise<void> {
    await api().docUnregister(uid);
  }

  async docInfoUpdate(uid: string, filename: string | null): Promise<void> {
    await api().docInfoUpdate(uid, filename);
  }

  async dropzoneList(): Promise<
    Array<{ id: string; label: string; type: string; sliceJson: unknown; createdAt: number }>
  > {
    return api().dropzoneList();
  }

  async dropzoneAdd(item: {
    id: string;
    label: string;
    sliceJson: unknown;
    createdAt: number;
  }): Promise<void> {
    await api().dropzoneAdd(item);
  }

  async dropzoneRemove(id: string): Promise<void> {
    await api().dropzoneRemove(id);
  }

  async dropzoneClear(): Promise<void> {
    await api().dropzoneClear();
  }

  onDropzoneChanged(
    handler: (
      items: Array<{ id: string; label: string; type: string; sliceJson: unknown; createdAt: number }>,
    ) => void,
  ): () => void {
    return api().onDropzoneChanged(handler);
  }

  async quickCardsList(): Promise<QuickCardIpc[]> {
    return api().quickCardsList();
  }

  async quickCardsUpsert(card: QuickCardIpc): Promise<void> {
    await api().quickCardsUpsert(card);
  }

  async quickCardsBulkUpsert(cards: QuickCardIpc[]): Promise<void> {
    await api().quickCardsBulkUpsert(cards);
  }

  async quickCardsRemove(id: string): Promise<void> {
    await api().quickCardsRemove(id);
  }

  async quickCardsClear(): Promise<void> {
    await api().quickCardsClear();
  }

  onQuickCardsChanged(handler: (cards: QuickCardIpc[]) => void): () => void {
    return api().onQuickCardsChanged(handler);
  }

  async pairingConfigure(cfg: PairingConfigIpc): Promise<{ ownCode: string }> {
    return (await api().pairingConfigure?.(cfg)) ?? { ownCode: '' };
  }

  async pairingRegenerateKey(): Promise<{ ownCode: string }> {
    return (await api().pairingRegenerateKey?.()) ?? { ownCode: '' };
  }

  async pairingSend(
    payload: PairingSendIpc,
  ): Promise<{ ok: number; fail: number; authFail?: number }> {
    return (
      (await api().pairingSend?.(payload)) ?? { ok: 0, fail: payload.recipientCodes.length }
    );
  }

  async pairingInboxList(): Promise<PairingInboxItemIpc[]> {
    return (await api().pairingInboxList?.()) ?? [];
  }

  async pairingInboxRemove(id: string): Promise<void> {
    await api().pairingInboxRemove?.(id);
  }

  async pairingInboxClear(): Promise<void> {
    await api().pairingInboxClear?.();
  }

  async pairingInboxMarkAllRead(): Promise<void> {
    await api().pairingInboxMarkAllRead?.();
  }

  async collabRelayDefaults(): Promise<{ url: string; token: string; routingCode?: string }> {
    return (await api().collabRelayDefaults?.()) ?? { url: '', token: '', routingCode: '' };
  }

  async toggleDevTools(): Promise<void> {
    await api().toggleDevTools?.();
  }

  onPowerResumed(handler: () => void): () => void {
    return api().onPowerResumed?.(handler) ?? (() => {});
  }

  onPairingInboxChanged(handler: (items: PairingInboxItemIpc[]) => void): () => void {
    return api().onPairingInboxChanged?.(handler) ?? (() => {});
  }

  onPairingVersionMismatch(
    handler: (info: {
      partnerVersion: string;
      localVersion: string;
      requiredVersion: string;
    }) => void,
  ): () => void {
    return api().onPairingVersionMismatch?.(handler) ?? (() => {});
  }

  onPairingUnauthorized(handler: () => void): () => void {
    return api().onPairingUnauthorized?.(handler) ?? (() => {});
  }

  async pairingConnectAccount(payload: {
    connectCode: string;
    confirmEvict?: boolean;
    evict?: string;
  }): Promise<PairingConnectResultIpc> {
    return (
      (await api().pairingConnectAccount?.(payload)) ?? { ok: false, error: 'disabled' }
    );
  }

  async pairingAccountStatus(): Promise<PairingAccountStatusIpc> {
    return (
      (await api().pairingAccountStatus?.()) ?? {
        enabled: false,
        connected: false,
        expiresAt: 0,
        email: '',
      }
    );
  }

  async pairingDisconnectAccount(): Promise<PairingAccountStatusIpc> {
    return (
      (await api().pairingDisconnectAccount?.()) ?? {
        enabled: false,
        connected: false,
        expiresAt: 0,
        email: '',
      }
    );
  }

  onPairingEntitlementChanged(
    handler: (status: PairingAccountStatusIpc & { evicted?: boolean; lapsed?: boolean }) => void,
  ): () => void {
    return api().onPairingEntitlementChanged?.(handler) ?? (() => {});
  }

  async listDocs(): Promise<
    Array<{
      uid: string;
      filename: string | null;
      windowId: number;
      windowTitle: string;
      isSpeech: boolean;
      isOwnWindow: boolean;
      isFocusedWindow: boolean;
    }>
  > {
    return api().listDocs();
  }

  /** Cross-window duplicate-open guard. `openPathCheck` is the
   *  read-only pre-load probe — if another window owns the
   *  path, main focuses it for the user and returns
   *  `takenByOther: true`. `openPathRegister` claims a path on
   *  successful mount; `openPathRelease` drops the claim on
   *  unmount. Window-close auto-cleanup handles force-quits.
   *  See the IPC handlers in `apps/desktop/src/main.ts`. */
  async openPathCheck(path: string): Promise<{ takenByOther: boolean }> {
    return await api().openPathCheck(path);
  }

  async openPathRegister(path: string): Promise<void> {
    await api().openPathRegister(path);
  }

  async openPathRelease(path: string): Promise<void> {
    await api().openPathRelease(path);
  }

  async focusAnchorInWindow(
    path: string,
    descriptor: { quote: string; prefix: string; suffix: string; approxPos: number },
  ): Promise<{ delivered: boolean }> {
    const fn = api().focusAnchorInWindow;
    if (typeof fn !== 'function') return { delivered: false };
    return await fn(path, descriptor);
  }

  onFocusAnchor(
    handler: (payload: {
      descriptor: { quote: string; prefix: string; suffix: string; approxPos: number };
    }) => void,
  ): () => void {
    const fn = api().onFocusAnchor;
    return typeof fn === 'function' ? fn(handler) : () => {};
  }

  /** Set / clear the current speech-doc designation. Main broadcasts
   *  `speech:changed` to every window after any state change. */
  async speechSet(uid: string | null): Promise<void> {
    await api().speechSet(uid);
  }

  async speechGet(): Promise<{ uid: string | null }> {
    return api().speechGet();
  }

  /** Subscribe to speech-state broadcasts. Handler receives the
   *  current `{ uid }` — uid is null when no speech doc is flagged. */
  onSpeechChanged(handler: (state: { uid: string | null }) => void): () => void {
    return api().onSpeechChanged(handler);
  }

  /** Send a serialized PM slice to whichever window owns the speech
   *  doc. Returns `{ delivered, reason? }`. */
  async speechSendSlice(payload: {
    sliceJson: unknown;
    atEnd: boolean;
  }): Promise<{ delivered: boolean; reason?: string }> {
    return api().speechSendSlice(payload);
  }

  /** Subscribe to incoming speech-doc slices from other windows. */
  onIncomingSpeechSlice(
    handler: (payload: { uid: string; sliceJson: unknown; atEnd: boolean }) => void,
  ): () => void {
    return api().onIncomingSpeechSlice(handler);
  }

  /** Subscribe to menu-driven commands from the native menu bar.
   *  Mirrors the preload's `onMenuCommand` API. Returns an unsubscribe
   *  function. Not part of the cross-platform Host interface — only
   *  the desktop shell exposes a menu, so this is ElectronHost-only. */
  onMenuCommand(handler: (command: string) => void): () => void {
    return api().onMenuCommand(handler);
  }

  /** Push the current keybinding map to main so menu accelerators
   *  follow user rebinds. Callers send a fresh map on every
   *  settings change; main de-dups by reassigning its store. */
  async setMenuBindings(bindings: Record<string, string | null>): Promise<void> {
    await api().setMenuBindings(bindings);
  }

  async checkForUpdates(): Promise<{
    status: 'latest' | 'updating' | 'error' | 'dev';
    message?: string;
  }> {
    return api().checkForUpdates();
  }

  async triggerAutoUpdateCheck(): Promise<void> {
    await api().triggerAutoUpdateCheck();
  }

  async getUpdateChipState(): Promise<{ state: 'available' | 'ready'; version: string } | null> {
    return api().getUpdateChipState();
  }

  async updateChipAction(): Promise<void> {
    await api().updateChipAction();
  }

  onUpdateChip(
    handler: (payload: { state: 'available' | 'ready'; version: string } | null) => void,
  ): () => void {
    // Optional-chained: an older packaged shell (preload without the
    // chip API) just never shows the chip.
    const fn = api().onUpdateChip;
    return fn ? fn.call(api(), handler) : () => {};
  }

  // Timer pop-out — optional-chained like the chip API: an older
  // packaged shell simply never offers the pop-out button.
  async timerPopoutOpen(opts?: {
    contentWidth: number;
    contentHeight: number;
    zoomFactor: number;
  }): Promise<void> {
    await api().timerPopoutOpen?.(opts);
  }

  async timerPopoutExists(): Promise<boolean> {
    return (await api().timerPopoutExists?.()) === true;
  }

  onTimerPopoutClosed(handler: () => void): () => void {
    const fn = api().onTimerPopoutClosed;
    return fn ? fn.call(api(), handler) : () => {};
  }

  async openCrashDumpsFolder(): Promise<void> {
    await api().openCrashDumpsFolder();
  }

  /** Reveal a saved document in Finder / Explorer. Optional-chained:
   *  no-ops gracefully on an older preload without the surface. */
  async showItemInFolder(handle: string): Promise<void> {
    await api().showItemInFolder?.(handle);
  }
  async openJournalsFolder(): Promise<void> {
    await api().openJournalsFolder();
  }

  async getAccessibilityTreeEnabled(): Promise<boolean> {
    return api().getAccessibilityTreeEnabled();
  }

  async setAccessibilityTreeEnabled(enabled: boolean): Promise<void> {
    await api().setAccessibilityTreeEnabled(enabled);
  }

  async getAccessibilityTreeApplied(): Promise<boolean> {
    return api().getAccessibilityTreeApplied();
  }

  async isAccessibilitySupportActive(): Promise<boolean> {
    return api().isAccessibilitySupportActive();
  }

  async relaunchApp(): Promise<void> {
    await api().relaunchApp();
  }

  /** Page-zoom factor for this window. Same mechanism as the
   *  browser's Ctrl-+ — reflows the whole document including
   *  the editor surface, so chrome and doc content scale
   *  uniformly. The renderer reapplies this on every boot from
   *  the persisted `chromeScalePct` setting. */
  setZoomFactor(factor: number): void {
    api().setZoomFactor(factor);
  }

  getZoomFactor(): number {
    return api().getZoomFactor();
  }
}
