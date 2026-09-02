/**
 * Electron preload script.
 *
 * Runs in an isolated bridging context between the main process and
 * the renderer. Exposes a narrow `window.electronAPI` surface via
 * Electron's `contextBridge` so the renderer can call into native
 * code without having full Node access.
 *
 * The shape exposed here matches the `ElectronAPI` interface
 * declared inside `src/editor/host/electron-host.ts`. If you add a
 * method here, mirror it there (and ideally in the cross-platform
 * Host interface so BrowserHost grows the same capability).
 */

import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron';

interface FileFilter {
  name: string;
  extensions: string[];
}

interface JournalEntry {
  uid: string;
  filename: string;
  handle: string | null;
  format: 'cmir' | 'docx' | null;
  savedAt: string;
  /** Stale-overwrite guard baseline for a recovered, not-yet-manually-saved
   *  draft. Passed through opaquely. */
  recoveredFromSavedAt?: string;
  bytes: Uint8Array;
}

interface QuickCardIpc {
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

interface PairingAccountStatusIpc {
  enabled: boolean;
  connected: boolean;
  expiresAt: number;
  email: string;
}
interface PairingConnectResultIpc {
  /** Seat picker list (relay ≥ 2026-09-02); absent on older relays. */
  candidates?: Array<{ routingCode: string; boundAt: string; lastSeenAt?: string; label?: string }>;
  ok: boolean;
  error?: string;
  expiresAt?: number;
  email?: string;
  limit?: number;
  wouldEvict?: { routingCode: string; boundAt: string };
  retryCode?: string;
}
interface PairingConfigIpc {
  enabled: boolean;
  displayName: string;
  schemaVersion: string;
  minReceiverVersion?: string;
  pollSeconds: number;
  relayUrl?: string;
  relayToken?: string;
}
interface PairingSendIpc {
  recipientCodes: string[];
  item: { label: string; type: string; sliceJson: unknown };
  via?: string;
}
interface PairingInboxItemIpc {
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

contextBridge.exposeInMainWorld('electronAPI', {
  /** Absolute filesystem path of a dropped/selected `File`. Electron 32+
   *  removed the `File.path` property, so drag-to-open resolves it through
   *  `webUtils.getPathForFile` here in the preload. Returns '' if the file has
   *  no real path (e.g. dragged from another app, not a folder). */
  getPathForFile: (file: File): string => {
    const p = webUtils.getPathForFile(file);
    // A real dropped/picked File resolving to a path IS a user gesture —
    // grant it so the scoped read-file-at-path can serve the drop-to-open
    // flow. Unforgeable from the page: a synthetic File has no path, and
    // this channel is preload-internal (not on the exposed API). `send`
    // (not invoke) so the grant lands in main before the renderer's
    // follow-up read invoke — same-renderer IPC stays ordered.
    if (p) ipcRenderer.send('host:grant-dropped-path', p);
    return p;
  },

  /** Read the system clipboard's plain-text content. Used by the
   *  F2 (Paste Plain) command on Electron — bypasses the Chromium
   *  web clipboard-permission UI that forces the web edition into
   *  a sticky-toggle workaround. */
  clipboardReadText: () => ipcRenderer.invoke('host:clipboard-read-text'),
  /** Read html + plain clipboard flavors together (editor
   *  context-menu Paste) — same no-permission-UI rationale as
   *  clipboardReadText, plus the rich flavor Word round-trips. */
  clipboardReadHtml: () => ipcRenderer.invoke('host:clipboard-read-html'),
  /** Write html+plain to the system clipboard from the MAIN process.
   *  Unlike navigator.clipboard.write, needs no renderer focus and
   *  tolerates Win32 clipboard-lock contention (Create Reference's
   *  one-click-in-five field failure next to Word). */
  clipboardWriteHtml: (html: string, text: string) =>
    ipcRenderer.invoke('host:clipboard-write-html', { html, text }),

  /** Trigger a manual auto-update check. Resolves with a status
   *  string the UI can use to show a friendly result message
   *  without needing to listen on its own autoUpdater channel. */
  checkForUpdates: () => ipcRenderer.invoke('host:check-for-updates') as Promise<{
    status: 'latest' | 'updating' | 'error' | 'dev';
    message?: string;
  }>,

  /** Trigger a silent at-launch update check. Same network call
   *  as `checkForUpdates`, but the main process suppresses the
   *  "you're on the latest" and "couldn't check" dialogs — only
   *  the "Update available" modal fires. No-op in dev builds. */
  triggerAutoUpdateCheck: () => ipcRenderer.invoke('host:trigger-auto-update-check'),
  getUpdateChipState: () => ipcRenderer.invoke('host:update-chip-state'),
  updateChipAction: () => ipcRenderer.invoke('host:update-chip-action'),
  onUpdateChip(handler: (payload: { state: 'available' | 'ready'; version: string } | null) => void): () => void {
    const listener = (_evt: unknown, payload: { state: 'available' | 'ready'; version: string } | null): void =>
      handler(payload);
    ipcRenderer.on('update:chip', listener);
    return () => ipcRenderer.removeListener('update:chip', listener);
  },

  /** Floating always-on-top timer window. `timerPopoutOpen` creates
   *  (or re-shows) it; `timerPopoutExists` is the liveness probe the
   *  boot-time popped-out reconciliation keys on; the closed event is
   *  the main process's backstop for closes that skipped the pop-out
   *  renderer's own state write (crash / force-close). */
  timerPopoutOpen: (opts?: { contentWidth: number; contentHeight: number; zoomFactor: number }) =>
    ipcRenderer.invoke('host:timer-popout-open', opts),
  timerPopoutExists: () => ipcRenderer.invoke('host:timer-popout-exists') as Promise<boolean>,
  onTimerPopoutClosed(handler: () => void): () => void {
    const listener = (): void => handler();
    ipcRenderer.on('timer:popout-closed', listener);
    return () => ipcRenderer.removeListener('timer:popout-closed', listener);
  },

  /** Open the OS file manager at the crash-dumps folder. */
  openCrashDumpsFolder: () => ipcRenderer.invoke('host:open-crash-dumps'),

  /** Open the OS file manager at the crash-recovery journals folder. */
  openJournalsFolder: () => ipcRenderer.invoke('host:open-journals-folder'),
  showItemInFolder: (handle: string) => ipcRenderer.invoke('host:show-item-in-folder', handle),

  /** Minimize this OS window (the `minimizeWindow` ribbon command /
   *  macOS Window-menu Minimize). */
  minimizeWindow: () => ipcRenderer.invoke('host:minimize-window'),

  /** Renderer accessibility tree toggle (default off — works around a known
   *  Chromium AX crash). Reads/writes a machine-local pref; changing it needs an
   *  app restart. `isAccessibilitySupportActive` reports whether an assistive-tech
   *  client is currently connected. */
  getAccessibilityTreeEnabled: () =>
    ipcRenderer.invoke('host:get-accessibility-tree-enabled') as Promise<boolean>,
  setAccessibilityTreeEnabled: (enabled: boolean) =>
    ipcRenderer.invoke('host:set-accessibility-tree-enabled', enabled) as Promise<void>,
  getAccessibilityTreeApplied: () =>
    ipcRenderer.invoke('host:get-accessibility-tree-applied') as Promise<boolean>,
  isAccessibilitySupportActive: () =>
    ipcRenderer.invoke('host:is-accessibility-support-active') as Promise<boolean>,
  relaunchApp: () => ipcRenderer.invoke('host:relaunch-app') as Promise<void>,

  /** Open a URL in the user's default OS browser (via shell.openExternal).
   *  Main filters to http(s) + mailto so file:// URLs can't escape. */
  openExternal: (url: string) => ipcRenderer.invoke('host:open-external', url),

  /** Open the native directory-picker dialog. Used by the
   *  settings UI for the "default folder" rows. Returns the
   *  chosen absolute path or null if the user cancelled. */
  pickDirectory: (opts?: { defaultPath?: string; title?: string }) =>
    ipcRenderer.invoke('host:pick-directory', opts),

  /** Native file-picker returning the chosen PATH only — no read, no
   *  read-scope grant (the file-search exclusion list needs a path to
   *  block, never content). */
  pickFile: (opts?: { defaultPath?: string; title?: string; filters?: FileFilter[] }) =>
    ipcRenderer.invoke('host:pick-file', opts),

  openFile: (opts: { filters: FileFilter[] }) =>
    ipcRenderer.invoke('host:open-file', opts),

  /** Read a file at a known path (no picker) for the home screen's
   *  "open recent" flow. Resolves null when the path is gone /
   *  unreadable so the caller can prune the stale recent. */
  /** Read-scope plumbing (see main's read-scope.ts): the renderer mirrors
   *  its File-search folders and one-shot-imports pre-existing recents so
   *  scoped `readFileAtPath` keeps serving them. */
  syncLibraryRoots: (roots: string[]): Promise<void> =>
    ipcRenderer.invoke('host:sync-library-roots', roots),
  grantLegacyRecents: (paths: string[]): Promise<boolean> =>
    ipcRenderer.invoke('host:grant-legacy-recents', paths),
  readFileAtPath: (filePath: string) =>
    ipcRenderer.invoke('host:read-file-at-path', filePath) as Promise<{
      name: string;
      bytes: Uint8Array;
      handle: string;
      format: 'cmir' | 'docx';
    } | null>,

  /** stat a file (mtime + size) for the recovery-save staleness check.
   *  Null when the path is gone / unreadable. */
  statFile: (filePath: string) =>
    ipcRenderer.invoke('host:stat-file', filePath) as Promise<{
      mtimeMs: number;
      size: number;
    } | null>,

  /** Resolve a doc-relative `.cmir` ref and read it, for a transclusion
   *  refresh. Path resolution + library-root scoping + traversal rejection
   *  happen in main. Resolves null when the source can't be safely read. */
  readCmirFile: (
    docPath: string,
    sourceRef: string,
    base: 'doc' | 'root',
    roots: string[],
    sourceAbs = '',
  ) =>
    ipcRenderer.invoke('host:read-cmir-file', docPath, sourceRef, base, roots, sourceAbs) as Promise<{
      bytes: Uint8Array;
      name: string;
    } | null>,

  /** Resolve a transclusion source ref to its safe absolute path (for opening
   *  the linked file). Same main-process boundary as readCmirFile; null when it
   *  can't be safely resolved. */
  resolveCmirPath: (
    docPath: string,
    sourceRef: string,
    base: 'doc' | 'root',
    roots: string[],
    sourceAbs = '',
  ) =>
    ipcRenderer.invoke(
      'host:resolve-cmir-path',
      docPath,
      sourceRef,
      base,
      roots,
      sourceAbs,
    ) as Promise<string | null>,

  /** Write an anchored `.docx` back over its source (a raw Word file gaining a
   *  single `pmd-heading` bookmark so a live zone can refresh from it). Same
   *  main-process containment boundary as reading; main refuses non-`.docx`
   *  targets and writes atomically. Resolves the outcome, never throws. */
  writeSourceAnchor: (
    docPath: string,
    sourceRef: string,
    base: 'doc' | 'root',
    roots: string[],
    sourceAbs: string,
    bytes: Uint8Array,
  ) =>
    ipcRenderer.invoke(
      'host:write-source-anchor',
      docPath,
      sourceRef,
      base,
      roots,
      sourceAbs,
      bytes,
    ) as Promise<{ ok: true; name: string } | { ok: false; reason: string }>,

  saveAs: (
    suggestedName: string,
    bytes: Uint8Array,
    opts: { filters: FileFilter[]; nearPath?: string },
  ) => ipcRenderer.invoke('host:save-as', suggestedName, bytes, opts),

  saveExisting: (handle: string, bytes: Uint8Array, opts?: { force?: boolean }) =>
    ipcRenderer.invoke('host:save-existing', handle, bytes, opts),

  /** Silent "Save Send Doc" write to a renderer-resolved folder.
   *  Resolves to the written file's name + path, the string
   *  'collision' when the target would overwrite the source, or null
   *  when the destination couldn't be resolved. */
  saveSendDoc: (
    opts: { folder: string | null; siblingHandle: string | null; filename: string },
    bytes: Uint8Array,
  ) =>
    ipcRenderer.invoke('host:save-send-doc', opts, bytes) as Promise<
      { name: string; handle: string } | 'collision' | null
    >,

  /** Bulk-convert helpers: recursively list files of an extension
   *  under a directory, and write bytes to an arbitrary path. */
  listFilesRecursive: (dir: string, ext: string) =>
    ipcRenderer.invoke('host:list-files-recursive', dir, ext) as Promise<
      Array<{ path: string; relPath: string }>
    >,
  /** Ask main for a direct MessagePort to the file-index service. The
   *  port arrives via the `cardmirror:file-index-port` window message
   *  (see the forwarding listener below) — invoke-style IPC can't carry
   *  a transferable. */
  requestFileIndexPort: () => {
    ipcRenderer.send('host:file-index-port');
  },
  writeFileAtPath: (
    filePath: string,
    bytes: Uint8Array,
    opts?: { failIfExists?: boolean },
  ) => ipcRenderer.invoke('host:write-file-at-path', filePath, bytes, opts),

  /** Bulk-compress every `.cmir` under `dir` in place (temporary
   *  migration tool). `onProgress` fires (throttled) as files are
   *  processed. Resolves with the final summary. */
  bulkCompress: (
    dir: string,
    onProgress: (p: {
      done: number;
      total: number;
      compressed: number;
      skipped: number;
      failed: number;
      bytesBefore: number;
      bytesAfter: number;
    }) => void,
  ) => {
    const listener = (_evt: unknown, p: Parameters<typeof onProgress>[0]): void => onProgress(p);
    ipcRenderer.on('host:bulk-compress:progress', listener);
    return (
      ipcRenderer.invoke('host:bulk-compress', dir) as Promise<{
        total: number;
        compressed: number;
        skipped: number;
        failed: number;
        bytesBefore: number;
        bytesAfter: number;
      }>
    ).finally(() => ipcRenderer.removeListener('host:bulk-compress:progress', listener));
  },

  /** Crash-recovery journal API. Stores per-doc snapshots under
   *  `app.getPath('userData')/journals/{uid}.cmir-journal`. */
  writeJournal: (entry: JournalEntry) =>
    ipcRenderer.invoke('host:write-journal', entry),
  readJournals: () => ipcRenderer.invoke('host:read-journals'),
  deleteJournal: (uid: string) =>
    ipcRenderer.invoke('host:delete-journal', uid),

  /** Collab session-history API ({roomId}.cmir-history, same folder as
   *  the journals; retained past session end — see collab-history.ts).
   *  Envelopes are plain JSON (the snapshot rides as base64), so no
   *  byte-conversion shims are needed at this boundary. */
  writeHistory: (envelope: unknown) => ipcRenderer.invoke('host:write-history', envelope),
  listHistory: () => ipcRenderer.invoke('host:list-history'),
  historySnapshot: (
    docId: string,
    bytes: Uint8Array,
    policy: { retentionDays: number; maxDocBytes: number; maxTotalBytes: number },
    trigger?: 'manual' | 'auto' | 'close',
  ): Promise<{ stored: boolean; reason?: string }> =>
    ipcRenderer.invoke('host:history-snapshot', docId, bytes, policy, trigger),
  historyList: (
    docId: string,
  ): Promise<Array<{ id: string; ts: number; size: number; trigger?: 'manual' | 'auto' | 'close' }>> =>
    ipcRenderer.invoke('host:history-list', docId),
  historyRead: (docId: string, id: string): Promise<Uint8Array | null> =>
    ipcRenderer.invoke('host:history-read', docId, id),
  historyUsage: (): Promise<{ totalBytes: number; snapshots: number }> =>
    ipcRenderer.invoke('host:history-usage'),
  historyClear: (): Promise<void> => ipcRenderer.invoke('host:history-clear'),
  readHistory: (target: { roomId?: string; path?: string }) =>
    ipcRenderer.invoke('host:read-history', target),
  deleteHistory: (roomId: string) => ipcRenderer.invoke('host:delete-history', roomId),
  pickHistoryFile: () =>
    ipcRenderer.invoke('host:pick-history-file') as Promise<string | null>,

  /** Learn store (local annotation layer) — whole-blob KV under
   *  `app.getPath('userData')/learn-store.json`. */
  readLearnStore: () => ipcRenderer.invoke('host:read-learn-store') as Promise<string | null>,
  writeLearnStore: (json: string) => ipcRenderer.invoke('host:write-learn-store', json),

  /** Report this window's workspace mode to main at boot (and on the
   *  reload a mode toggle triggers) so the OS "Open with…" path knows
   *  which windows can take a file into their slot picker. */
  registerMultipane: (isMultiPane: boolean) =>
    ipcRenderer.invoke('host:register-multipane', isMultiPane),
  /** Main forwards an OS-opened file (path) to an existing multi-pane
   *  window so it routes through the slot picker instead of spawning a
   *  blank window. Returns an unsubscribe. */
  onExternalOpen(handler: (payload: { path: string }) => void): () => void {
    const listener = (_evt: unknown, payload: { path: string }): void => handler(payload);
    ipcRenderer.on('host:external-open', listener);
    return () => ipcRenderer.removeListener('host:external-open', listener);
  },

  /** Spawn a new BrowserWindow, optionally pre-loaded with a doc. */
  spawnWindow: (payload: {
    filename: string;
    bytes: Uint8Array;
    handle: string | null;
    format: 'cmir' | 'docx' | null;
    uid: string | null;
    markAsSpeech?: boolean;
    focusAnchor?: { quote: string; prefix: string; suffix: string; approxPos: number };
    joinShareCode?: string;
    resumeRoomId?: string;
  } | null) => ipcRenderer.invoke('host:spawn-window', payload),

  /** Called once at renderer boot to retrieve any initial-doc
   *  payload the spawning window stashed for us. Null when the
   *  window was opened blank. */
  getInitialDoc: () => ipcRenderer.invoke('host:get-initial-doc'),

  /** True iff this is the first window of the current app session.
   *  Used by the renderer to gate the startup-recovery UI — only
   *  the first window should surface unsaved-journal restoration;
   *  windows spawned later in the session would otherwise offer to
   *  recover docs already open in OTHER windows of the same
   *  session. */
  isFirstWindow: () => ipcRenderer.invoke('host:is-first-window'),

  /** Mode-switch helper: tell main to broadcast
   *  `'mode-switch:please-close'` to every other open window and
   *  resolve once they've all closed. */
  journalAndCloseOtherWindows: () =>
    ipcRenderer.invoke('host:journal-and-close-other-windows'),

  /** Close this renderer's window programmatically. Called by the
   *  please-close handler after journaling. */
  closeSelf: () => ipcRenderer.invoke('host:close-self'),

  /** Tell main that a close-request was resolved WITHOUT closing
   *  (Cancel, or a failed Save). Lets main drop any pending quit
   *  intent so a subsequent ordinary window close doesn't quit the
   *  app on macOS. No-op close-wise; safe to call redundantly. */
  cancelClose: () => ipcRenderer.invoke('host:close-cancelled'),

  /** Mode-switch helper: report the docs this window journaled in
   *  response to a please-close. Main accumulates them so the
   *  surviving window can scope its post-reload auto-recovery to
   *  exactly the switch's docs (sessionStorage is per-window, so a
   *  closing window's list can only travel through main). */
  reportModeSwitchJournaled: (docs: Array<{ uid: string; dirty: boolean }>) =>
    ipcRenderer.invoke('host:mode-switch-journaled', docs),

  /** Fetch (and clear) the docs the closed windows reported for the
   *  current mode switch. Called once by the surviving window after
   *  its reload. */
  takeModeSwitchJournaledDocs: () =>
    ipcRenderer.invoke('host:take-mode-switch-journaled'),

  /** Subscribe to mode-switch please-close broadcasts. Returns an
   *  unsubscribe handle. */
  onPleaseCloseForModeSwitch(handler: () => void): () => void {
    const listener = (): void => handler();
    ipcRenderer.on('mode-switch:please-close', listener);
    return () => ipcRenderer.removeListener('mode-switch:please-close', listener);
  },

  /** Subscribe to user-initiated close requests. Main intercepts
   *  the window's `close` event and sends this so the renderer
   *  can prompt for unsaved-doc handling. The renderer's handler
   *  must call `host:close-self` to actually close, or do nothing
   *  (Cancel). */
  onCloseRequest(handler: () => void): () => void {
    const listener = (): void => handler();
    ipcRenderer.on('host:close-request', listener);
    return () => ipcRenderer.removeListener('host:close-request', listener);
  },

  /** Doc-lifecycle reporting for the main-process speech-doc
   *  registry. Renderers call register on mount and unregister on
   *  close, so main knows where each uid lives. */
  docRegister: (uid: string) => ipcRenderer.invoke('host:doc-register', uid),
  docUnregister: (uid: string) =>
    ipcRenderer.invoke('host:doc-unregister', uid),

  /** Cross-window duplicate-open guard. `openPathCheck(path)` is
   *  read-only — if another window already owns the path, main
   *  focuses that window and the caller gets `takenByOther:
   *  true` so it can toast + abort the open. Caller registers
   *  via `openPathRegister(path)` once it actually mounts the
   *  doc, and `openPathRelease(path)` when the doc unmounts
   *  (close, replace, Save-As to a different path). Main also
   *  cleans up claims automatically when a window closes, so
   *  missed releases don't permanently block re-opening. */
  openPathCheck: (path: string) =>
    ipcRenderer.invoke('host:open-path-check', path) as Promise<{
      takenByOther: boolean;
    }>,
  openPathRegister: (path: string) =>
    ipcRenderer.invoke('host:open-path-register', path),
  openPathRelease: (path: string) =>
    ipcRenderer.invoke('host:open-path-release', path),
  /** "Show in context": if another window already has `path` open, focus
   *  it and tell it to scroll to `descriptor`. `delivered: false` ⇒ no
   *  such window, so the caller spawns a new one. */
  focusAnchorInWindow: (
    path: string,
    descriptor: { quote: string; prefix: string; suffix: string; approxPos: number },
  ) =>
    ipcRenderer.invoke('host:focus-anchor-in-window', path, descriptor) as Promise<{
      delivered: boolean;
    }>,
  /** The window that owns a path receives this when another window's
   *  "Show in context" targets it; it resolves the descriptor in its
   *  doc and scrolls. Returns an unsubscribe. */
  onFocusAnchor(
    handler: (payload: {
      descriptor: { quote: string; prefix: string; suffix: string; approxPos: number };
    }) => void,
  ): () => void {
    const listener = (
      _evt: unknown,
      payload: { descriptor: { quote: string; prefix: string; suffix: string; approxPos: number } },
    ): void => handler(payload);
    ipcRenderer.on('host:focus-anchor', listener);
    return () => ipcRenderer.removeListener('host:focus-anchor', listener);
  },

  /** Set / clear / read the current speech-doc designation. Main
   *  broadcasts `speech:changed` to every window after any state
   *  change so UIs stay in sync. */
  speechSet: (uid: string | null) =>
    ipcRenderer.invoke('host:speech-set', uid),
  speechGet: () => ipcRenderer.invoke('host:speech-get'),

  /** Voice recognition (SPEC-voice.md §12 item 2). One session at a
   *  time, owned by the window that started it. The renderer captures
   *  mic audio (getUserMedia → 16 kHz mono s16le PCM) and streams it
   *  down; recognition runs in main; typed parse events come back on
   *  `voice:event`, input-level reports on `voice:level`. */
  voiceStart: (opts?: {
    modelDir?: string;
    rmsGate?: number;
    minWordConf?: number;
    autoSleepSeconds?: number;
    dictationModel?: 'standard' | 'large';
  }) =>
    ipcRenderer.invoke('host:voice-start', opts ?? {}) as Promise<{
      ok: boolean;
      error?: string;
      modelLoadMs?: number;
      largeDictationMissing?: boolean;
    }>,
  /** Base recognition model (~130 MB, stored in userData) — the model
   *  voice needs to run at all. First-use download, not bundled. */
  voiceBaseModelInfo: () =>
    ipcRenderer.invoke('host:voice-base-model-info') as Promise<{
      present: boolean;
      downloading: boolean;
    }>,
  voiceDownloadBaseModel: () =>
    ipcRenderer.invoke('host:voice-download-base-model') as Promise<{
      ok: boolean;
      error?: string;
    }>,
  /** Remove the installed base model from userData to reclaim space. */
  voiceDeleteBaseModel: () =>
    ipcRenderer.invoke('host:voice-delete-base-model') as Promise<{
      ok: boolean;
      error?: string;
    }>,
  /** Opt-in large dictation model (~1.8 GB, stored in userData). */
  voiceDictationModelInfo: () =>
    ipcRenderer.invoke('host:voice-dictation-model-info') as Promise<{
      present: boolean;
      downloading: boolean;
    }>,
  voiceDownloadDictationModel: () =>
    ipcRenderer.invoke('host:voice-download-dictation-model') as Promise<{
      ok: boolean;
      error?: string;
    }>,
  /** Remove the installed large model (and its bundled-Node runtime). */
  voiceDeleteDictationModel: () =>
    ipcRenderer.invoke('host:voice-delete-dictation-model') as Promise<{
      ok: boolean;
      error?: string;
    }>,
  onVoiceDownloadProgress(
    handler: (p: {
      model?: 'base-model' | 'large-model' | 'node-runtime';
      pct: number;
      receivedMB?: number;
      extracting?: boolean;
    }) => void,
  ): () => void {
    const listener = (
      _evt: unknown,
      payload: {
        model?: 'base-model' | 'large-model' | 'node-runtime';
        pct: number;
        receivedMB?: number;
        extracting?: boolean;
      },
    ): void => handler(payload);
    ipcRenderer.on('voice:download-progress', listener);
    return () => ipcRenderer.removeListener('voice:download-progress', listener);
  },
  voiceStop: () => ipcRenderer.invoke('host:voice-stop'),
  /** Fire-and-forget PCM chunk (ArrayBuffer of s16le samples). */
  voicePushAudio: (chunk: ArrayBuffer) =>
    ipcRenderer.send('host:voice-audio', chunk),
  /** Viewport/document text for quote-targeting vocabulary; debounce
   *  caller-side (~150 ms per spec §12 item 4). */
  voiceSetVocabulary: (docText: string) =>
    ipcRenderer.invoke('host:voice-set-vocabulary', docText),
  /** Native clipboard ops (same paths as Mod-C/X/V). */
  voiceClipboard: (op: 'copy' | 'cut' | 'paste') =>
    ipcRenderer.invoke('host:voice-clipboard', op),
  /** Native key synthesis (sendInputEvent) for voice "press <key>" —
   *  drives real default actions, unlike DOM-dispatched events. */
  voiceSendKey: (key: string) => ipcRenderer.invoke('host:voice-send-key', key),
  onVoiceEvent(handler: (event: unknown) => void): () => void {
    const listener = (_evt: unknown, payload: unknown): void => handler(payload);
    ipcRenderer.on('voice:event', listener);
    return () => ipcRenderer.removeListener('voice:event', listener);
  },
  onVoiceLevel(
    handler: (level: {
      rms: number;
      gate: number;
      calibrating: boolean;
      autoSleepRemainingMs?: number;
    }) => void,
  ): () => void {
    const listener = (
      _evt: unknown,
      payload: { rms: number; gate: number; calibrating: boolean; autoSleepRemainingMs?: number },
    ): void => handler(payload);
    ipcRenderer.on('voice:level', listener);
    return () => ipcRenderer.removeListener('voice:level', listener);
  },

  /** Push the active filename for a registered uid so the
   *  Select-Speech-Doc modal can label every doc across every
   *  window. Call on mount and whenever the filename changes
   *  (save, save-as). Pass `null` for unsaved docs. */
  docInfoUpdate: (uid: string, filename: string | null) =>
    ipcRenderer.invoke('host:doc-info-update', { uid, filename }),

  /** Dropzone shelf — cross-window in-memory scratch space for
   *  dragged content. List returns the current items; add/remove/
   *  clear mutate and broadcast via `dropzone:changed`. Cleared on
   *  app restart per spec. */
  dropzoneList: () =>
    ipcRenderer.invoke('host:dropzone-list') as Promise<
      Array<{
        id: string;
        label: string;
        sliceJson: unknown;
        createdAt: number;
      }>
    >,
  dropzoneAdd: (item: { id: string; label: string; type: string; sliceJson: unknown; createdAt: number }) =>
    ipcRenderer.invoke('host:dropzone-add', item),
  dropzoneRemove: (id: string) =>
    ipcRenderer.invoke('host:dropzone-remove', id),
  dropzoneClear: () => ipcRenderer.invoke('host:dropzone-clear'),
  onDropzoneChanged(
    handler: (
      items: Array<{ id: string; label: string; type: string; sliceJson: unknown; createdAt: number }>,
    ) => void,
  ): () => void {
    const listener = (
      _evt: unknown,
      items: Array<{ id: string; label: string; type: string; sliceJson: unknown; createdAt: number }>,
    ): void => handler(items);
    ipcRenderer.on('dropzone:changed', listener);
    return () => ipcRenderer.removeListener('dropzone:changed', listener);
  },

  /** Quick Cards — persistent, cross-window snippet library. List
   *  returns current cards; upsert/bulkUpsert/remove/clear mutate,
   *  persist to `{userData}/quick-cards.json`, and broadcast via
   *  `quick-cards:changed`. */
  quickCardsList: () =>
    ipcRenderer.invoke('host:quick-cards-list') as Promise<QuickCardIpc[]>,
  quickCardsUpsert: (card: QuickCardIpc) =>
    ipcRenderer.invoke('host:quick-cards-upsert', card),
  quickCardsBulkUpsert: (cards: QuickCardIpc[]) =>
    ipcRenderer.invoke('host:quick-cards-bulk-upsert', cards),
  quickCardsRemove: (id: string) =>
    ipcRenderer.invoke('host:quick-cards-remove', id),
  quickCardsClear: () => ipcRenderer.invoke('host:quick-cards-clear'),
  onQuickCardsChanged(handler: (cards: QuickCardIpc[]) => void): () => void {
    const listener = (_evt: unknown, cards: QuickCardIpc[]): void => handler(cards);
    ipcRenderer.on('quick-cards:changed', listener);
    return () => ipcRenderer.removeListener('quick-cards:changed', listener);
  },

  /** Cross-machine card sharing. configure starts/stops the receive
   *  poller; send POSTs one message per recipient (token stays in main);
   *  the inbox accessors + `pairing:inbox-changed` keep the Receive pill
   *  in sync across windows; `pairing:version-mismatch` surfaces a toast. */
  pairingConfigure: (cfg: PairingConfigIpc) =>
    ipcRenderer.invoke('host:pairing-configure', cfg) as Promise<{ ownCode: string }>,
  pairingRegenerateKey: () =>
    ipcRenderer.invoke('host:pairing-regenerate-key') as Promise<{ ownCode: string }>,
  pairingSend: (payload: PairingSendIpc) =>
    ipcRenderer.invoke('host:pairing-send', payload) as Promise<{
      ok: number;
      fail: number;
      authFail: number;
    }>,
  pairingInboxList: () =>
    ipcRenderer.invoke('host:pairing-inbox-list') as Promise<PairingInboxItemIpc[]>,
  pairingInboxRemove: (id: string) =>
    ipcRenderer.invoke('host:pairing-inbox-remove', id),
  pairingInboxClear: () => ipcRenderer.invoke('host:pairing-inbox-clear'),
  pairingInboxMarkAllRead: () => ipcRenderer.invoke('host:pairing-inbox-mark-read'),
  collabRelayDefaults: () =>
    ipcRenderer.invoke('host:collab-relay-defaults') as Promise<{
      url: string;
      token: string;
      routingCode: string;
    }>,
  toggleDevTools: () => ipcRenderer.invoke('host:toggle-devtools') as Promise<void>,
  onPowerResumed: (handler: () => void) => {
    const listener = () => handler();
    ipcRenderer.on('host:power-resumed', listener);
    return () => ipcRenderer.removeListener('host:power-resumed', listener);
  },
  onPairingInboxChanged(handler: (items: PairingInboxItemIpc[]) => void): () => void {
    const listener = (_evt: unknown, items: PairingInboxItemIpc[]): void => handler(items);
    ipcRenderer.on('pairing:inbox-changed', listener);
    return () => ipcRenderer.removeListener('pairing:inbox-changed', listener);
  },
  onPairingVersionMismatch(
    handler: (info: {
      partnerVersion: string;
      localVersion: string;
      requiredVersion: string;
    }) => void,
  ): () => void {
    const listener = (
      _evt: unknown,
      info: { partnerVersion: string; localVersion: string; requiredVersion: string },
    ): void => handler(info);
    ipcRenderer.on('pairing:version-mismatch', listener);
    return () => ipcRenderer.removeListener('pairing:version-mismatch', listener);
  },
  onPairingUnauthorized(handler: () => void) {
    const listener = () => handler();
    ipcRenderer.on('pairing:unauthorized', listener);
    return () => ipcRenderer.removeListener('pairing:unauthorized', listener);
  },
  /** Blog-account entitlement (gates nothing until relay-side enforcement). */
  pairingConnectAccount: (payload: { connectCode: string; confirmEvict?: boolean; evict?: string }) =>
    ipcRenderer.invoke('host:pairing-connect-account', payload) as Promise<PairingConnectResultIpc>,
  pairingAccountStatus: () =>
    ipcRenderer.invoke('host:pairing-account-status') as Promise<PairingAccountStatusIpc>,
  pairingDisconnectAccount: () =>
    ipcRenderer.invoke('host:pairing-disconnect-account') as Promise<PairingAccountStatusIpc>,
  onPairingEntitlementChanged(
    handler: (status: PairingAccountStatusIpc & { evicted?: boolean; lapsed?: boolean }) => void,
  ): () => void {
    const listener = (
      _evt: unknown,
      status: PairingAccountStatusIpc & { evicted?: boolean; lapsed?: boolean },
    ): void => handler(status);
    ipcRenderer.on('pairing:entitlement-changed', listener);
    return () => ipcRenderer.removeListener('pairing:entitlement-changed', listener);
  },

  /** List every open doc across every window. Each entry carries
   *  the uid, filename (or null), its owning window's id + title,
   *  whether it's the current speech doc, whether it lives in the
   *  caller's own window, and whether its window is currently
   *  focused. */
  listDocs: () =>
    ipcRenderer.invoke('host:list-docs') as Promise<
      Array<{
        uid: string;
        filename: string | null;
        windowId: number;
        windowTitle: string;
        isSpeech: boolean;
        isOwnWindow: boolean;
        isFocusedWindow: boolean;
      }>
    >,

  /** Subscribe to speech-state broadcasts. The handler receives the
   *  current `{ uid }` (uid is null when no speech doc is flagged). */
  onSpeechChanged(handler: (state: { uid: string | null }) => void): () => void {
    const listener = (_evt: unknown, state: { uid: string | null }): void =>
      handler(state);
    ipcRenderer.on('speech:changed', listener);
    return () => ipcRenderer.removeListener('speech:changed', listener);
  },

  /** Send a serialized PM slice to whatever window owns the speech
   *  doc. Returns whether the slice was delivered (`delivered:
   *  true`) or why not (`delivered: false, reason: ...`). */
  speechSendSlice: (payload: { sliceJson: unknown; atEnd: boolean }) =>
    ipcRenderer.invoke('host:speech-send-slice', payload),

  /** Subscribe to incoming speech-doc slices. The handler receives
   *  `{ uid, sliceJson, atEnd }` and is responsible for applying
   *  the slice to its local view that matches uid. */
  onIncomingSpeechSlice(
    handler: (payload: { uid: string; sliceJson: unknown; atEnd: boolean }) => void,
  ): () => void {
    const listener = (
      _evt: unknown,
      payload: { uid: string; sliceJson: unknown; atEnd: boolean },
    ): void => handler(payload);
    ipcRenderer.on('speech:incoming-slice', listener);
    return () =>
      ipcRenderer.removeListener('speech:incoming-slice', listener);
  },

  /** Push the renderer's current keybinding map to main so the
   *  application menu's accelerator labels track user rebinds.
   *  Values are PM-keymap strings (`Mod-o`, `Shift-Mod-s`,
   *  `Ctrl-ArrowLeft`); main translates each to Electron's
   *  accelerator form. Pass `null` for commands with no current
   *  binding so the accelerator hint is omitted. */
  setMenuBindings: (bindings: Record<string, string | null>) =>
    ipcRenderer.invoke('host:set-menu-bindings', bindings),

  /** Subscribe to native-menu commands. Main process broadcasts
   *  `'menu-command'` events to the focused window's webContents
   *  whenever the user picks File → Open / Save / etc. The
   *  renderer routes them through its existing ribbon-command
   *  registry. */
  onMenuCommand(handler: (command: string) => void): () => void {
    const listener = (_evt: unknown, command: string): void => handler(command);
    ipcRenderer.on('menu-command', listener);
    return () => ipcRenderer.removeListener('menu-command', listener);
  },

  /** Fast Debate Paste integration — receive an `external:insert-text`
   *  request from the main-process HTTP bridge (`fast-paste-bridge.ts`),
   *  hand it to the renderer's external-insert handler, and send the
   *  ack back via `external:insert-result`. The pair stays on a
   *  contextBridge-exposed channel so the renderer never has to be
   *  injected with `executeJavaScript` under contextIsolation. */
  onExternalInsertRequest(handler: (req: {
    requestId: string;
    text: string;
    role: string; // ExternalInsertRole (external-insert.ts) — heading roles included since PR #28
    newParagraph: boolean;
    omitted: boolean;
    target?: string;
  }) => void): () => void {
    const listener = (
      _evt: unknown,
      req: {
        requestId: string;
        text: string;
        role: string; // ExternalInsertRole (external-insert.ts) — heading roles included since PR #28
        newParagraph: boolean;
        omitted: boolean;
        target?: string;
      },
    ): void => handler(req);
    ipcRenderer.on('external:insert-text', listener);
    return () => ipcRenderer.removeListener('external:insert-text', listener);
  },
  sendExternalInsertResult: (result: {
    requestId: string;
    ok: boolean;
    error?: string;
    docTitle?: string;
  }): void => {
    ipcRenderer.send('external:insert-result', result);
  },

  /** External-app consent (see external-consent.ts). The renderer
   *  mirrors the master toggle + per-app decisions to main, runs the
   *  first-contact prompt on request, and receives fire-and-forget
   *  notes (lastSeen stamps, unidentified-caller toasts). */
  syncExternalConsent: (state: {
    policy: 'off' | 'ask' | 'open';
    apps: Record<string, 'allow' | 'deny'>;
  }): void => {
    ipcRenderer.send('host:sync-external-consent', state);
  },
  onExternalConsentPrompt(handler: (req: {
    requestId: string;
    appId: string;
    appName: string | null;
    appVersion: string | null;
  }) => void): () => void {
    const listener = (
      _evt: unknown,
      req: { requestId: string; appId: string; appName: string | null; appVersion: string | null },
    ): void => handler(req);
    ipcRenderer.on('external:consent-prompt', listener);
    return () => ipcRenderer.removeListener('external:consent-prompt', listener);
  },
  sendExternalConsentPromptResult: (result: { requestId: string; outcome: string }): void => {
    ipcRenderer.send('external:consent-prompt-result', result);
  },
  onExternalConsentNote(handler: (note: {
    kind: 'seen' | 'unidentified';
    appId?: string;
    when?: string;
  }) => void): () => void {
    const listener = (
      _evt: unknown,
      note: { kind: 'seen' | 'unidentified'; appId?: string; when?: string },
    ): void => handler(note);
    ipcRenderer.on('external:consent-note', listener);
    return () => ipcRenderer.removeListener('external:consent-note', listener);
  },

  /** Chrome scale — Chromium's per-frame page-zoom factor.
   *  Identical mechanism to the browser's Ctrl-+ / Ctrl-- chord:
   *  reflows the whole document including the editor surface,
   *  so the renderer's existing rem-based chrome and pt-based
   *  doc content both scale uniformly. Persisted per-window for
   *  the window's lifetime; the renderer reapplies the saved
   *  factor on every boot. */
  setZoomFactor: (factor: number): void => {
    webFrame.setZoomFactor(factor);
  },
  getZoomFactor: (): number => webFrame.getZoomFactor(),

  /** Verbatim Flow bridge (Windows COM → Excel). All resolve a JSON
   *  status object; off Windows they resolve `{ error: 'windows-only' }`. */
  flowAvailable: (): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('host:flow-available'),
  flowSend: (payload: { cells: string[] }, force?: boolean): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('host:flow-send', payload, !!force),
  flowPull: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('host:flow-pull'),
  flowCreate: (templatePath?: string): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('host:flow-create', templatePath),
  /** Pre-warm the persistent PowerShell host (no Excel interaction). */
  flowStartHost: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('host:flow-start'),
  /** Plugin bridge (plugin API v1 — see the plugin API spec). Jump
   *  broadcast + flow-app discovery/POST relay resolve through main;
   *  the jump request/result pair mirrors the external-insert pair
   *  above (`external:jump` / `external:jump-result`). */
  pluginJump: (source: string): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('host:plugin-jump', source),
  flowApps: (): Promise<unknown[]> => ipcRenderer.invoke('host:flow-apps'),
  flowPost: (appId: string, route: string, body: unknown): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('host:flow-post', appId, route, body),
  onExternalJumpRequest(handler: (req: {
    requestId: string;
    source: string;
  }) => void): () => void {
    const listener = (
      _evt: unknown,
      req: { requestId: string; source: string },
    ): void => handler(req);
    ipcRenderer.on('external:jump', listener);
    return () => ipcRenderer.removeListener('external:jump', listener);
  },
  sendExternalJumpResult: (result: {
    requestId: string;
    ok: boolean;
    error?: string;
  }): void => {
    ipcRenderer.send('external:jump-result', result);
  },

  /** Card-cutter local plugin (experimental). `pick` opens the native
   *  file dialog and returns the chosen path. `load` asks main for the
   *  engine bundle's source (from the given path, the CARDCUTTER_ENGINE
   *  env, or the default userData/plugins location) and runs it in the
   *  renderer's MAIN world, where it self-registers via
   *  window.__registerCardCutter. Never bundled in the release. */
  cardCutterPickFile: (): Promise<string | null> =>
    ipcRenderer.invoke('host:cardcutter-pick-file'),
  cardCutterLoad: async (
    enginePath?: string | null,
  ): Promise<{ ok: boolean; path?: string; error?: string }> => {
    const res = (await ipcRenderer.invoke('host:cardcutter-read', enginePath ?? null)) as
      | { source: string; path: string }
      | { error: string; path: string };
    if (!('source' in res) || !res.source) {
      return { ok: false, error: 'error' in res ? res.error : 'not found', path: res.path };
    }
    try {
      await webFrame.executeJavaScript(res.source);
      return { ok: true, path: res.path };
    } catch (e) {
      return { ok: false, error: String(e), path: res.path };
    }
  },
  /** Plugin manager (GitHub install; Obsidian model). Install/list/
   *  uninstall/update-check round-trip to main; `pluginLoad` /
   *  `pluginLoadFile` fetch a bundle's source from main and run it in
   *  the renderer's MAIN world (same mechanism as cardCutterLoad),
   *  where it self-registers via window.__registerCardMirrorPlugin. */
  pluginInstallInspect: (ref: string): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('host:plugin-install-inspect', ref),
  pluginBrowse: (): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('host:plugin-browse'),
  pluginInstallCommit: (token: string): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('host:plugin-install-commit', token),
  pluginInstallDiscard: (token: string): Promise<void> =>
    ipcRenderer.invoke('host:plugin-install-discard', token),
  pluginCommunityInstalls: (on: boolean): Promise<void> =>
    ipcRenderer.invoke('host:plugin-community-installs', on),
  pluginList: (): Promise<unknown[]> => ipcRenderer.invoke('host:plugin-list'),
  pluginUninstall: (id: string): Promise<void> => ipcRenderer.invoke('host:plugin-uninstall', id),
  pluginCheckUpdate: (id: string, repoRef: string): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('host:plugin-check-update', id, repoRef),
  pluginPickFile: (): Promise<string | null> => ipcRenderer.invoke('host:plugin-pick-file'),
  pluginLoad: async (id: string): Promise<{ ok: boolean; error?: string }> => {
    const res = (await ipcRenderer.invoke('host:plugin-read', id)) as
      | { source: string }
      | { error: string };
    if (!('source' in res) || !res.source) {
      return { ok: false, error: 'error' in res ? res.error : 'not found' };
    }
    try {
      await webFrame.executeJavaScript(res.source);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
  pluginLoadFile: async (filePath: string): Promise<{ ok: boolean; error?: string }> => {
    const res = (await ipcRenderer.invoke('host:plugin-read-file', filePath)) as
      | { source: string }
      | { error: string };
    if (!('source' in res) || !res.source) {
      return { ok: false, error: 'error' in res ? res.error : 'not found' };
    }
    try {
      await webFrame.executeJavaScript(res.source);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
});

// File-index service port hand-off. `ipcRenderer.invoke` can't carry a
// transferable, so main replies to `host:file-index-port` with a
// WebContents.postMessage whose port lands here — and the preload's
// `window.postMessage(…, transfer)` is the one documented bridge for
// moving a MessagePort from the isolated world into the page's world.
// (Local declaration: this tsconfig has no DOM lib, but the preload
// runs in the renderer where `window` exists.)
declare const window: {
  postMessage(message: unknown, targetOrigin: string, transfer?: unknown[]): void;
};
ipcRenderer.on('host:file-index-port', (event) => {
  window.postMessage({ type: 'cardmirror:file-index-port' }, '*', event.ports);
});
