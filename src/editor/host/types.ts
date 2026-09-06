/**
 * Host interface — the platform abstraction the editor talks to for
 * everything that isn't pure DOM manipulation.
 *
 * Why this exists: CardMirror runs in three contexts (regular browser
 * tab, installed PWA, native desktop binary wrapped by Electron /
 * Tauri). Each context offers a different way to open files, save
 * files, store settings, etc. The editor proper doesn't care which
 * context it's in — it calls `host.openFile()` and `host.saveAs()`
 * and the right thing happens.
 *
 * Adding a new platform = writing a new Host implementation. Adding
 * a new capability = extending this interface and implementing it in
 * each platform host.
 *
 * Lifecycle: `getHost()` (from `./index.ts`) returns the singleton
 * for the current platform, picked once at module load and never
 * swapped. Host implementations may hold internal state (e.g. cached
 * file handles for in-place saves); they're not assumed to be pure.
 */

import type { LearnOp } from '../learn-store.js';

/** File-type filter for native open/save dialogs. Mirrors Electron's
 *  `dialog.FileFilter` shape so the ElectronHost can pass it
 *  through verbatim; BrowserHost uses it to build the `<input
 *  accept="…">` attribute and the `showSaveFilePicker` types arg. */
export interface FileFilter {
  /** Human-readable label shown in the dialog (e.g. "CardMirror
   *  document"). */
  name: string;
  /** Extensions without the leading dot (e.g. `["docx"]`, `["cmir"]`,
   *  or `["docx", "cmir"]`). */
  extensions: string[];
}

/** Result of a successful `Host.openFile` — a file the user picked
 *  from a native dialog (or its web-platform equivalent). */
export interface OpenedFile {
  /** Display name (basename, no path). Used for chip labels, tab
   *  titles, and the slot-router prompt. */
  name: string;
  /** Full byte contents of the file. */
  bytes: Uint8Array;
  /** Opaque platform-specific handle that subsequent in-place saves
   *  (`Host.saveExisting`) can pass back to write to the same
   *  on-disk location. `undefined` when the platform doesn't expose
   *  a persistent reference — browsers without the File System
   *  Access API, for example. */
  handle?: unknown;
  /** True when the file is GENUINELY zero bytes on disk (stat / File
   *  size 0 — e.g. Explorer's "New > Microsoft Word Document" ShellNew
   *  file, or `touch`). Such a file opens as a blank document bound to
   *  its path, like Word does. Deliberately NOT set for a short read of
   *  a cloud placeholder — those stat at the file's real size, and keep
   *  the "hasn't finished downloading" error. See editor/empty-open.ts. */
  emptyOnDisk?: boolean;
}

/** Result of a successful `Host.saveAs` — confirmation that the
 *  bytes hit storage at a user-chosen location. */
export interface SaveResult {
  /** Final filename the platform actually used. May differ from the
   *  `suggestedName` argument if the user renamed in the dialog
   *  (or if the browser's download path stripped extensions). */
  name: string;
  /** Opaque handle the future `Host.saveExisting` can use to write
   *  back to the same file without re-prompting. `undefined` when
   *  the platform can't hand one out. */
  handle?: unknown;
}

/** Options to `openFile`. */
export interface OpenFileOptions {
  /** Filters to show in the dialog. When omitted or empty, the
   *  dialog accepts any file (the BrowserHost's hidden input drops
   *  its `accept` attribute; Electron shows "All files"). The first
   *  filter is usually the default. */
  filters?: FileFilter[];
}

/** Options to `saveAs`. */
export interface SaveAsOptions {
  /** Filters to show in the save dialog. The first filter is
   *  usually used as the default format if the user doesn't pick
   *  a specific one. */
  filters?: FileFilter[];
  /** A path the dialog should open NEAR (Electron only; the web picker
   *  has no equivalent). Usually the active doc's own on-disk path: the
   *  dialog opens in the deepest ancestor folder that still exists — the
   *  doc's own folder when the path is intact, or (Word-style) the
   *  nearest surviving parent after a rename/move/delete broke it, so
   *  the stale-path rescue lands the user next to wherever their file
   *  went. Omit for docs with no path (today's last-used-dir default). */
  nearPath?: string;
}

/** A crash-recovery journal entry. Written every few seconds while
 *  a doc has unsaved edits; cleared on successful save or explicit
 *  close. On launch the host returns any stragglers from a previous
 *  session that crashed before they cleared.
 *
 *  The doc itself is stored as `bytes` in CardMirror native (`.cmir`)
 *  serialization — lossless and cheap to (de)serialize. The doc's
 *  *intended* on-disk format and handle are tracked separately so a
 *  recovered `.docx` doc can keep targeting Word on its next save. */
/** On-disk identity of a document's file — the changed-on-disk guard's
 *  baseline (see apps/desktop/src/doc-writes.ts). */
export interface DiskBase {
  mtimeMs: number;
  size: number;
  contentHash?: string;
}

export type CloudProvider = 'dropbox' | 'onedrive' | 'gdrive' | 'icloud' | 'other';

export interface JournalEntry {
  /** Journal-carried baseline of the doc's file (desktop fills it on
   *  write); passed back when the recovered doc registers its path. */
  diskBase?: DiskBase;
  /** Stable identifier for the doc across the session — multi-doc
   *  uses its DocRecord uid; single-doc tracks one at module level.
   *  Recovery reuses the same uid so a recovered doc that crashes
   *  again overwrites the same journal slot. */
  uid: string;
  /** Last-known display name. Used in the recovery modal so the
   *  user knows what they're recovering. "Untitled" when the doc
   *  was never named. */
  filename: string;
  /** Last-known on-disk handle (Electron: absolute path string;
   *  Browser: the File System Access `FileSystemFileHandle`). Handles ARE
   *  structured-cloneable, so the browser one survives a reload via IndexedDB —
   *  a journaled/recovered doc keeps its file identity (for the duplicate-open
   *  guard, which only needs `isSameEntry`, and for in-place save, which
   *  re-requests permission on first write). `null` for never-saved docs. */
  handle: unknown;
  /** The format the doc was last saved in (or null if never saved).
   *  Drives whether a recovered + re-saved doc round-trips through
   *  `toDocx` or stays native. */
  format: 'cmir' | 'docx' | null;
  /** ISO 8601 timestamp of when this journal entry was written. */
  savedAt: string;
  /** Set while the doc descends from a RECOVERED draft that hasn't been
   *  manually saved yet: the `savedAt` of the journal it was recovered from.
   *  Edits re-journal with `savedAt` = now, which would otherwise launder the
   *  stale-overwrite check — this carries the original provenance forward
   *  across relaunches and mode switches until the first manual save lands.
   *  Absent for normal journals. */
  recoveredFromSavedAt?: string;
  /** Doc content as CardMirror native (`.cmir`) bytes — the editor
   *  passes this to `parseNative` on recovery. */
  bytes: Uint8Array;
}

/** One local observation of how far a peer's op counter had advanced —
 *  the session-history file's substitute for CRDT timestamps (which are
 *  deliberately not recorded; see collab-history.ts). `counter` is a
 *  version-vector value, i.e. an EXCLUSIVE upper: "ops < counter
 *  existed by `at`". */
export interface HistoryChangeTime {
  peer: string;
  counter: number;
  /** Local epoch ms at the write that first covered this counter. */
  at: number;
}

/** On-disk envelope of a `{roomId}.cmir-history` session-history file
 *  ({userData}/journals, beside the crash journals but with its own
 *  extension so the crash-recovery scanner never offers it). Written
 *  continuously during a collab session and RETAINED after it ends —
 *  the durable record Recover Previous Version reads. Identical for
 *  host and participants: everyone holds the same history. */
export interface HistoryEnvelope {
  v: 1;
  roomId: string;
  /** Last-known display title, for the recovery list. */
  docTitle: string;
  /** Local epoch ms: first write / most recent write. */
  startedAt: number;
  updatedAt: number;
  changeTimes: HistoryChangeTime[];
  /** Full Loro snapshot (state + complete oplog), base64. */
  snapshotB64: string;
}

/** The WRITE-side shape sent over IPC: the snapshot rides as raw bytes
 *  and the MAIN process base64-encodes it into the stored envelope.
 *  Measured on a 20 MB snapshot: the renderer-side JS encoder cost
 *  463 ms per write; Buffer's native encoder costs 2 ms. */
export interface HistoryEnvelopeWrite {
  v: 1;
  roomId: string;
  docTitle: string;
  startedAt: number;
  updatedAt: number;
  changeTimes: HistoryChangeTime[];
  snapshot: Uint8Array;
}

/** A history file's listing row — the envelope minus its payload, so
 *  enumerating files never loads every snapshot into memory. */
export interface HistoryMeta {
  roomId: string;
  docTitle: string;
  startedAt: number;
  updatedAt: number;
  sizeBytes: number;
}

/** The interface every platform host implements. New methods land
 *  here when the editor needs a new capability that varies between
 *  web and desktop. */
export interface Host {
  /** Identifier for telemetry / debug. Lowercase string, stable. */
  readonly kind: 'browser' | 'electron' | 'tauri';

  /** Show a native open-file picker. Resolve with the picked file's
   *  contents or `null` if the user cancelled. */
  openFile(opts?: OpenFileOptions): Promise<OpenedFile | null>;

  /** Show a native save-file picker pre-filled with `suggestedName`
   *  and write `bytes` to the user's chosen location. Resolve with
   *  the saved file's final name + a handle for future in-place
   *  saves, or `null` if the user cancelled. */
  saveAs(
    suggestedName: string,
    bytes: Uint8Array,
    opts?: SaveAsOptions,
  ): Promise<SaveResult | null>;

  /** Write `bytes` to the file referenced by `handle`. Used for the
   *  silent "Save" path (no dialog) — the caller already knows
   *  where the doc lives.
   *
   *  Throws when the handle is no longer writable (file deleted,
   *  moved, permissions revoked) or when the platform can't fulfil
   *  the contract — the caller can fall back to Save As in those
   *  cases. On Electron it also throws an EMODIFIED-marked error
   *  (`isFileChangedOnDiskError`) when the file changed on disk
   *  since it was last read or written; `opts.force` — the user's
   *  explicit "Overwrite" choice — skips that guard. Hosts without
   *  the guard ignore `opts`. */
  saveExisting(
    handle: unknown,
    bytes: Uint8Array,
    opts?: { force?: boolean },
  ): Promise<void>;

  /** Ensure `handle` is writable, prompting for permission if needed, and
   *  resolve to whether write access is granted. Call this from a USER-GESTURE
   *  context (a Save click / autosave toggle) BEFORE the work that precedes the
   *  write (e.g. serialization), so the browser's readwrite permission prompt
   *  fires while the gesture's activation is still valid — and only when the
   *  user has shown save intent, not on open. No-op `true` on Electron (paths
   *  are always writable) and where there's no permission model. */
  ensureWritable(handle: unknown): Promise<boolean>;

  /** Last-modified time + size of the file `handle` points at, or `null`
   *  when it doesn't exist / can't be read without a prompt. Used by the
   *  crash-recovery Save to detect a journal that's older than the file it
   *  would overwrite (a stale journal from a previous session), so it can
   *  warn before destroying newer on-disk work. */
  statFile(handle: unknown): Promise<{ mtimeMs: number; size: number } | null>;

  /** Whether this host can actually perform in-place saves. The
   *  caller uses this to decide whether to even surface the
   *  silent-Save affordance — when false, "Save" devolves into
   *  Save As. Browsers without the File System Access API return
   *  false; Electron / Tauri return true. */
  readonly supportsInPlaceSave: boolean;

  /** Persist `entry` to the journal store under `entry.uid`,
   *  overwriting any previous entry for that uid. Cheap to call —
   *  the editor fires this debounced after every doc-changing
   *  edit. */
  writeJournal(entry: JournalEntry): Promise<void>;

  /** Read every journal entry currently in the store. Called at
   *  startup to surface anything that didn't get cleared by a
   *  graceful save (i.e. the previous session crashed / was killed). */
  readJournals(): Promise<JournalEntry[]>;

  /** Remove the journal entry for `uid`. Called on successful
   *  save, on explicit close, or after the user discards a
   *  recovery offer. No-op when no journal exists for that uid. */
  deleteJournal(uid: string): Promise<void>;

  /** Read the per-user Learn store blob (flashcards, schedules, anchors,
   *  decks — the local annotation layer). `null` when none saved yet. */
  readLearnStore(): Promise<string | null>;

  /** Apply one Learn store mutation at the single OWNER of the canonical
   *  copy (desktop: the main process; web: this tab, under a Web Lock)
   *  and return the resulting blob. Windows never write the blob
   *  themselves — see learn-store-host.ts. */
  applyLearnOp(op: LearnOp): Promise<string>;

  /** Follow canonical Learn store changes made through ANY window or
   *  tab. Returns an unsubscribe. */
  onLearnStoreChanged(handler: (json: string) => void): () => void;

  /** Whether journaling actually persists across sessions on this
   *  host. Set to false by hosts that can't (e.g. a hypothetical
   *  browser without IndexedDB). The editor stops writing
   *  journals when this is false; the recovery modal still works
   *  on hosts where it's true. */
  readonly journalsSupported: boolean;

  /** Whether this host can spawn additional editor windows. True
   *  on Electron; false on the web edition. The "windows" workspace
   *  mode falls back to single-doc-replace UX when this is false. */
  readonly canSpawnWindow: boolean;

  /** Spawn a new editor window, optionally pre-loaded with a doc.
   *  Callers should gate on `canSpawnWindow`; on hosts that can't
   *  spawn, this rejects. */
  spawnWindow(payload: SpawnWindowPayload | null): Promise<void>;

  /** Called once at renderer boot to retrieve the initial doc the
   *  spawning window stashed for us. Returns `null` when this is
   *  the first window of a session (or the host doesn't support
   *  the spawn handshake). */
  getInitialDoc(): Promise<SpawnWindowPayload | null>;

  /** True iff this is the first window of the current app session.
   *  Used by the renderer to decide whether to surface the
   *  startup-recovery UI — only the first window should, since
   *  later windows would otherwise offer to "recover" docs the
   *  user already has open in earlier windows of the same session.
   *  On hosts that don't multi-window (web), always true. */
  isFirstWindow(): Promise<boolean>;
}

/** Payload exchanged between a spawning window and the freshly-
 *  spawned one. Carries enough provenance for the new window's
 *  renderer to mount the doc without re-prompting via the file
 *  picker. */
export interface SpawnWindowPayload {
  /** Journal-carried baseline of a recovered doc being respawned. */
  diskBase?: DiskBase;
  filename: string;
  bytes: Uint8Array;
  handle: string | null;
  format: 'cmir' | 'docx' | null;
  /** True when the file was genuinely 0 bytes on disk — set by main's
   *  OS-open path only; the receiving window opens it as a blank doc
   *  (see OpenedFile.emptyOnDisk). Renderer-spawned payloads omit it. */
  emptyOnDisk?: boolean;
  /** Pre-existing doc uid (when the doc is being moved between
   *  windows or recovered from a journal). Null for fresh docs. */
  uid: string | null;
  /** When true, the spawned window self-marks the new doc as the
   *  speech doc after mounting + registering its view. Used by
   *  the New Speech Document flow so the freshly-spawned window
   *  becomes the routing target for subsequent send-to-speech. */
  markAsSpeech?: boolean;
  /** When true, the spawned window mounts the doc DIRTY instead of
   *  the default clean. Used by the mode-switch reopen for docs
   *  that had unsaved changes — the payload bytes hold edits that
   *  exist nowhere on disk, so the close prompt must keep firing. */
  markDirty?: boolean;
  /** Mode-switch respawn of a doc recovered from a journal and not yet
   *  manually saved: the ORIGINAL journal `savedAt`, so the spawned window
   *  re-marks the doc and the stale-overwrite guard (plus its autosave
   *  hold-off) survives the move between windows. */
  recoveredFromSavedAt?: string;
  /** When set, the spawned window resolves this anchor against the
   *  mounted doc and scrolls + selects it. Used by the flashcard
   *  review's "Show in context" to open a card's source in its own
   *  window focused on the anchored text. Shape mirrors
   *  `AnchorDescriptor` (kept inline so host types don't depend on the
   *  editor layer). */
  focusAnchor?: { quote: string; prefix: string; suffix: string; approxPos: number };
  /** When set, the spawned window JOINS this collaboration share code
   *  instead of mounting a doc — it opens a blank starter and runs the full
   *  join (session + Loro binding land together in the new window). Used so
   *  accepting an invite while a real doc is open doesn't overwrite it. The
   *  doc fields above are placeholders in this case. */
  joinShareCode?: string;
  /** When set, the spawned window RESUMES this persisted collaboration
   *  session (home-screen Sessions list) instead of mounting a doc — same
   *  shape as joinShareCode: blank starter, then the full resume runs in the
   *  new window. Used so resuming while a real doc is open doesn't overwrite
   *  it. The doc fields above are placeholders in this case. */
  resumeRoomId?: string;
}
