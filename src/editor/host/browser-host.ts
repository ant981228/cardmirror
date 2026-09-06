/**
 * BrowserHost — the Host implementation for the plain web edition
 * (and, by extension, the installable PWA). All file I/O goes
 * through web platform APIs: `<input type="file">` for opens,
 * `showSaveFilePicker` (Chromium) or a synthesized `<a download>`
 * link (everyone else) for saves.
 *
 * The hidden file-input that opens files is owned and recycled by
 * this class — callers don't see it. We allow only one open dialog
 * to be pending at a time (browsers serialize them anyway).
 */

import { LearnStore, applyLearnOp, type LearnOp } from '../learn-store.js';
import type {
  FileFilter,
  Host,
  JournalEntry,
  OpenFileOptions,
  OpenedFile,
  SaveAsOptions,
  SaveResult,
  SpawnWindowPayload,
} from './types.js';

const LEARN_STORE_KEY = 'pmd-learn-store';
const LEARN_STORE_LOCK = 'pmd-learn-store';

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Best-effort MIME guess for a given extension. The browser's
 *  showSaveFilePicker uses MIME → extension mapping to label the
 *  format dropdown; getting this right makes the dialog read
 *  naturally. */
function mimeForExtension(ext: string): string {
  if (ext === 'docx') return DOCX_MIME;
  if (ext === 'cmir') return 'application/json';
  return 'application/octet-stream';
}

/** Chrome's File System Access API is gated by feature detection. */
interface ShowSaveFilePickerOptions {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}
type FsPermissionMode = { mode: 'read' | 'readwrite' };
interface FileSystemFileHandle {
  name?: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{
    write(data: Blob | ArrayBuffer | Uint8Array): Promise<void>;
    close(): Promise<void>;
  }>;
  queryPermission?(opts: FsPermissionMode): Promise<PermissionState>;
  requestPermission?(opts: FsPermissionMode): Promise<PermissionState>;
  isSameEntry?(other: FileSystemFileHandle): Promise<boolean>;
}
type ShowSaveFilePicker = (
  opts: ShowSaveFilePickerOptions,
) => Promise<FileSystemFileHandle>;
interface ShowOpenFilePickerOptions {
  types?: ShowSaveFilePickerOptions['types'];
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
}
type ShowOpenFilePicker = (
  opts?: ShowOpenFilePickerOptions,
) => Promise<FileSystemFileHandle[]>;

function getShowSaveFilePicker(): ShowSaveFilePicker | undefined {
  return (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker })
    .showSaveFilePicker;
}
function getShowOpenFilePicker(): ShowOpenFilePicker | undefined {
  return (window as unknown as { showOpenFilePicker?: ShowOpenFilePicker })
    .showOpenFilePicker;
}

function filtersToAcceptAttribute(filters?: FileFilter[]): string {
  if (!filters || filters.length === 0) return '';
  const exts = new Set<string>();
  for (const f of filters) {
    for (const e of f.extensions) exts.add(`.${e}`);
  }
  return Array.from(exts).join(',');
}

/** iOS / iPadOS. iOS's file picker maps a file input's `accept` to UTIs and
 *  greys out every file whose extension it can't map — including our custom
 *  `.cmir` / `.cmir-journal` (only `.docx`, which has a UTI, stays pickable).
 *  Detect it so the open picker can drop `accept` there. iPadOS 13+ masquerades
 *  as desktop Safari, so also catch a touch-capable "Mac". */
function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (/iP(hone|od|ad)/.test(navigator.userAgent)) return true;
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

// The File System Access pickers validate each accept extension and reject
// anything outside [A-Za-z0-9+.] — notably the hyphen in `.cmir-journal`, which
// the lenient `<input accept>` allowed. Skip extensions the API would reject;
// they remain pickable via the picker's "All files" option (which we keep on).
const FS_ACCESS_EXT_OK = /^[A-Za-z0-9+.]+$/;

function filtersToSavePickerTypes(filters?: FileFilter[]): ShowSaveFilePickerOptions['types'] {
  if (!filters || filters.length === 0) return undefined;
  const types = filters
    .map((f) => {
      const accept: Record<string, string[]> = {};
      for (const ext of f.extensions) {
        if (!FS_ACCESS_EXT_OK.test(ext)) continue;
        const mime = mimeForExtension(ext);
        const existing = accept[mime] ?? [];
        existing.push(`.${ext}`);
        accept[mime] = existing;
      }
      return { description: f.name, accept };
    })
    .filter((t) => Object.keys(t.accept).length > 0);
  return types.length > 0 ? types : undefined;
}

/** Opened IndexedDB connection. Lazily created on first journal
 *  operation; reused for subsequent calls. */
let dbPromise: Promise<IDBDatabase> | null = null;

const DB_NAME = 'cardmirror';
const DB_VERSION = 2;
const STORE_JOURNALS = 'journals';
const STORE_SPAWNS = 'spawns';

/** The ?spawn=<id> handoff key for THIS window, captured at load before
 *  `getInitialDoc` strips it from the URL. Non-null in a spawned window. */
const SPAWN_ID: string | null =
  typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('spawn')
    : null;

const PWA_INSTALLED_KEY = 'pmd-pwa-installed';

/** True when THIS window is an installed / standalone PWA window. */
function isStandaloneDisplayMode(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  const mm = window.matchMedia;
  const standalone =
    mm('(display-mode: standalone)').matches ||
    mm('(display-mode: window-controls-overlay)').matches ||
    mm('(display-mode: minimal-ui)').matches;
  // iOS home-screen PWAs signal via navigator.standalone instead.
  const ios = (navigator as unknown as { standalone?: boolean }).standalone === true;
  return standalone || ios;
}

/** Whether this context can open new editor windows. True in a standalone PWA —
 *  and STICKILY in any window of the same profile once the app has run standalone
 *  (recorded in localStorage). That matters because `window.open` from an
 *  installed PWA doesn't always yield another *standalone* window (Chrome may
 *  open a plain tab); without the sticky bit, that spawned tab would read
 *  `canSpawnWindow=false` and New Document would overwrite in place instead of
 *  spawning, and New Speech Document would refuse. A plain browser that has never
 *  run the app standalone stays false (three-pane is the answer there). */
function detectCanSpawnWindow(): boolean {
  const standalone = isStandaloneDisplayMode();
  try {
    if (standalone) localStorage.setItem(PWA_INSTALLED_KEY, '1');
    return standalone || localStorage.getItem(PWA_INSTALLED_KEY) === '1';
  } catch {
    return standalone;
  }
}

/** Open a new editor window via a programmatic `rel="noopener"` anchor click,
 *  NOT `window.open()`. Chrome only routes a navigation into the installed app
 *  window (its "navigation capturing") when the navigation targets a
 *  NON-auxiliary browsing context — one with no `opener`. `window.open()` always
 *  creates an auxiliary context, so Chrome excludes it from capturing and it
 *  lands in a browser tab even with the app's "open in app" link setting on
 *  (Chrome only offers a manual "Open in app" button). A `noopener` link click
 *  creates a non-auxiliary context, which IS capturable — so in an installed PWA
 *  with link-capturing enabled it opens as a real app window; everywhere else it
 *  opens a normal tab. The doc payload rides via IndexedDB, so losing the opener
 *  reference costs us nothing. */
function openNewWindow(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('BrowserHost: IndexedDB unavailable.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (): void => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_JOURNALS)) {
        db.createObjectStore(STORE_JOURNALS, { keyPath: 'uid' });
      }
      // v2: one-shot spawn-window handoff — payload keyed by a generated id,
      // read + deleted by the spawned window's getInitialDoc.
      if (!db.objectStoreNames.contains(STORE_SPAWNS)) {
        db.createObjectStore(STORE_SPAWNS);
      }
    };
    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void => reject(req.error ?? new Error('IndexedDB open failed.'));
  });
  return dbPromise;
}

function browserJournalsSupported(): boolean {
  return typeof indexedDB !== 'undefined';
}

/** Best-effort request for durable (non-evictable) storage. No-op where the
 *  Storage API is absent; harmless if the browser declines. */
async function requestPersistentStorage(): Promise<void> {
  try {
    const s = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    if (!s?.persist) return;
    const already = s.persisted ? await s.persisted() : false;
    if (!already) await s.persist();
  } catch {
    /* best-effort — storage still works, just without the durability hint */
  }
}

export class BrowserHost implements Host {
  readonly kind = 'browser' as const;
  readonly journalsSupported = browserJournalsSupported();
  readonly canSpawnWindow = detectCanSpawnWindow();

  constructor() {
    // Ask the browser to keep our IndexedDB/localStorage (settings, the autosave
    // journal, recovery state) from being evicted under storage pressure. Matters
    // most for the installed PWA on ChromeOS, where the user's work otherwise
    // lives only in the browser profile. Best-effort, fire-and-forget.
    void requestPersistentStorage();
  }

  get supportsInPlaceSave(): boolean {
    // showSaveFilePicker gives us a writable handle that survives
    // back to disk. Without it, fallback saves go through a
    // download link and there's no persistent reference.
    return typeof getShowSaveFilePicker() === 'function';
  }

  /** Lazily-created hidden file input. Reused across opens. */
  private fileInput: HTMLInputElement | null = null;

  /** Settles the currently-pending openOnce (as null), if any. A
   *  pending open can hang forever — a dismissed picker on a browser
   *  without the `cancel` event, or an `input.click()` that silently
   *  did nothing because its user activation had expired. A new
   *  attempt supersedes the stuck one rather than queueing behind it,
   *  so one hung open can't wedge every future open (Ctrl-O, menu,
   *  and home screen all share this method). */
  private abortPendingOpen: (() => void) | null = null;

  async openFile(opts: OpenFileOptions = {}): Promise<OpenedFile | null> {
    // File System Access path (Chromium): yields a handle so subsequent saves
    // write back IN PLACE. Falls back to the handle-less <input> elsewhere
    // (Firefox/Safari/iOS), where Save stays Save-As.
    const showOpenFilePicker = getShowOpenFilePicker();
    if (typeof showOpenFilePicker === 'function') {
      return this.openViaPicker(showOpenFilePicker, opts);
    }
    this.abortPendingOpen?.();
    return this.openOnce(opts);
  }

  private async openViaPicker(
    pick: ShowOpenFilePicker,
    opts: OpenFileOptions,
  ): Promise<OpenedFile | null> {
    let handle: FileSystemFileHandle | undefined;
    try {
      [handle] = await pick({
        types: filtersToSavePickerTypes(opts.filters),
        multiple: false,
      });
    } catch (e) {
      // AbortError = user dismissed the picker. Quietly bail.
      if (e instanceof DOMException && e.name === 'AbortError') return null;
      throw e;
    }
    if (!handle) return null;
    // No permission request here — opening a file to read shouldn't prompt for
    // edit access (it looks like an unprompted "save?" before the user has
    // touched anything). The readwrite grant is requested later, from a user
    // gesture, when the user actually saves or turns autosave on. See
    // `ensureWritable`.
    const file = await handle.getFile();
    const buf = await file.arrayBuffer();
    return {
      name: handle.name ?? file.name,
      bytes: new Uint8Array(buf),
      handle,
      // A browser File's size is the real on-disk size (the OS hydrates
      // cloud placeholders before handing them over), so 0 here means
      // genuinely empty — open as a blank doc (see editor/empty-open.ts).
      ...(buf.byteLength === 0 ? { emptyOnDisk: true } : {}),
    };
  }

  private openOnce(opts: OpenFileOptions): Promise<OpenedFile | null> {
    const input = this.ensureFileInput();
    // Reapply the accept attribute from the caller's filters on
    // every open — different call sites may pass different filters.
    // On iOS a custom-extension `accept` greys out the very files we want
    // (`.cmir`), so drop it there and let any file be picked — the format is
    // validated downstream. Other browsers honor the extension filter fine.
    const accept = filtersToAcceptAttribute(opts.filters);
    if (accept && !isIOS()) input.setAttribute('accept', accept);
    else input.removeAttribute('accept');

    return new Promise((resolve, reject) => {
      // Browser quirk: if the user picks the same filename twice in
      // a row, the second `change` event won't fire unless `.value`
      // is cleared. Reset every time to be safe.
      input.value = '';

      let settled = false;
      const cleanup = (): void => {
        input.removeEventListener('change', onChange);
        input.removeEventListener('cancel', onCancel);
        if (this.abortPendingOpen === abort) this.abortPendingOpen = null;
      };
      const abort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        console.log('[cardmirror] open: superseding a pending open that never settled');
        resolve(null);
      };
      this.abortPendingOpen = abort;
      const onChange = async (): Promise<void> => {
        if (settled) return;
        settled = true;
        cleanup();
        const file = input.files?.[0];
        if (!file) {
          resolve(null);
          return;
        }
        try {
          const buf = await file.arrayBuffer();
          resolve({
            name: file.name,
            bytes: new Uint8Array(buf),
            // Same reasoning as the picker path: a 0-byte read of a
            // real browser File is genuinely empty, not a placeholder.
            ...(buf.byteLength === 0 ? { emptyOnDisk: true } : {}),
          });
        } catch (err) {
          reject(err);
        }
      };

      // `cancel` (Chrome 113+, Firefox 91+, Safari 16.4+) signals
      // that the user closed the picker without picking anything.
      // Unlike a focus + timeout heuristic, it can't race a slow
      // `change` event (browsers may populate `input.files` well
      // after the dialog closes). On browsers that lack the event,
      // the promise stays pending on cancel — a minor leak, but no
      // false null resolve that drops a real selection.
      const onCancel = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(null);
      };

      input.addEventListener('change', onChange);
      input.addEventListener('cancel', onCancel);
      input.click();
    });
  }

  async saveAs(
    suggestedName: string,
    bytes: Uint8Array,
    opts: SaveAsOptions = {},
  ): Promise<SaveResult | null> {
    const blob = bytesToBlob(bytes, suggestedName);

    const showSaveFilePicker = getShowSaveFilePicker();
    if (typeof showSaveFilePicker === 'function') {
      let handle: FileSystemFileHandle;
      try {
        handle = await showSaveFilePicker({
          suggestedName,
          types: filtersToSavePickerTypes(opts.filters),
        });
      } catch (e) {
        // AbortError = user cancelled the OS dialog. Quietly bail.
        if (e instanceof DOMException && e.name === 'AbortError') {
          return null;
        }
        throw e;
      }
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return {
        name: handle.name ?? suggestedName,
        handle,
      };
    }

    // Fallback: synthesize a download link.
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedName;
    a.click();
    URL.revokeObjectURL(url);
    return { name: suggestedName };
  }

  // `_opts` (the Electron changed-on-disk force flag) is accepted for
  // interface parity and ignored — the FS Access API has no cheap
  // stat, so this host has no changed-on-disk guard to override.
  async saveExisting(handle: unknown, bytes: Uint8Array, _opts?: { force?: boolean }): Promise<void> {
    if (!handle || typeof (handle as FileSystemFileHandle).createWritable !== 'function') {
      throw new Error('BrowserHost: saveExisting requires a File System Access handle.');
    }
    const fh = handle as FileSystemFileHandle;
    // VERIFY only — never prompt here. Write permission is granted ahead of time
    // by `ensureWritable` from a user gesture (Save click / autosave toggle), so
    // a gesture-less autosave fire that lacks permission fails cleanly (the
    // caller no-ops) rather than triggering a confusing out-of-context prompt.
    if (
      fh.queryPermission &&
      (await fh.queryPermission({ mode: 'readwrite' })) !== 'granted'
    ) {
      throw new Error('BrowserHost: write permission not granted for in-place save.');
    }
    const blob = bytesToBlob(bytes, fh.name ?? '');
    try {
      await writeThrough(fh, blob);
    } catch (err) {
      if (!isRetriableWriteError(err)) throw err;
      // Chromium's swap-file write can throw InvalidStateError when the
      // target's cached state went stale under it — sync services (Dropbox,
      // DriveFS on ChromeOS) touch files between our snapshot and the swap
      // commit. Refresh the handle's cached state (getFile re-reads size and
      // mtime), give the sync a beat to settle, and retry ONCE.
      await fh.getFile?.().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 300));
      try {
        await writeThrough(fh, blob);
      } catch (err2) {
        if (!isRetriableWriteError(err2)) throw err2;
        // Deterministic refusal, not a race — cloud-backed ChromeOS mounts
        // (Files-app provider filesystems) can reject swap-file writes
        // outright. Mark the message so save flows can route to Save-As
        // instead of dead-ending on a raw DOMException (same marker
        // convention as EMODIFIED / ELOCKED: only the message string
        // reliably crosses every boundary).
        throw new Error(
          `EWRITEBLOCKED: ${err2 instanceof Error ? err2.message : String(err2)}`,
        );
      }
    }
  }

  /** Best-effort file stat for the recovery-save staleness check. Reads
   *  `lastModified`/`size` off the File System Access handle's current File.
   *  Returns null when there's no readable handle (so the caller skips the
   *  check rather than blocking) — `getFile()` needs only read access, which
   *  a recoverable handle already has. */
  async statFile(handle: unknown): Promise<{ mtimeMs: number; size: number } | null> {
    const fh = handle as FileSystemFileHandle | null;
    if (!fh || typeof fh.getFile !== 'function') return null;
    try {
      const file = await fh.getFile();
      return { mtimeMs: file.lastModified, size: file.size };
    } catch {
      return null;
    }
  }

  /** Ensure write access to `handle`, prompting if necessary. MUST be called
   *  from a user gesture (Save / autosave toggle) so the readwrite prompt can
   *  show. Returns whether write access is granted. */
  async ensureWritable(handle: unknown): Promise<boolean> {
    const fh = handle as FileSystemFileHandle | null;
    if (!fh || typeof fh.createWritable !== 'function') return false;
    // No permission API (older Chromium): assume writable; createWritable throws
    // downstream if not.
    if (!fh.queryPermission || !fh.requestPermission) return true;
    const rw: FsPermissionMode = { mode: 'readwrite' };
    if ((await fh.queryPermission(rw)) === 'granted') return true;
    try {
      return (await fh.requestPermission(rw)) === 'granted';
    } catch {
      // requestPermission throws without transient activation.
      return false;
    }
  }

  async writeJournal(entry: JournalEntry): Promise<void> {
    if (!this.journalsSupported) return;
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_JOURNALS, 'readwrite');
      // IndexedDB structured-clones the value: Uint8Array is supported
      // natively, and a FileSystemFileHandle is cloneable too — so the file
      // handle survives the reload (restored with 'prompt' permission, which is
      // fine: the duplicate-open guard's isSameEntry needs no grant, and
      // in-place save re-requests permission on first write). Keeping it lets a
      // journaled/recovered doc retain its file identity across a mode switch.
      tx.objectStore(STORE_JOURNALS).put({ ...entry });
      tx.oncomplete = (): void => resolve();
      tx.onerror = (): void => reject(tx.error ?? new Error('writeJournal failed.'));
    });
  }

  async readJournals(): Promise<JournalEntry[]> {
    if (!this.journalsSupported) return [];
    const db = await openDb();
    return new Promise<JournalEntry[]>((resolve, reject) => {
      const tx = db.transaction(STORE_JOURNALS, 'readonly');
      const req = tx.objectStore(STORE_JOURNALS).getAll();
      req.onsuccess = (): void => resolve((req.result as JournalEntry[]) ?? []);
      req.onerror = (): void => reject(req.error ?? new Error('readJournals failed.'));
    });
  }

  async deleteJournal(uid: string): Promise<void> {
    if (!this.journalsSupported) return;
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_JOURNALS, 'readwrite');
      tx.objectStore(STORE_JOURNALS).delete(uid);
      tx.oncomplete = (): void => resolve();
      tx.onerror = (): void => reject(tx.error ?? new Error('deleteJournal failed.'));
    });
  }

  async readLearnStore(): Promise<string | null> {
    try {
      return localStorage.getItem(LEARN_STORE_KEY);
    } catch {
      return null;
    }
  }

  /** Read → apply → write under a Web Lock, so two tabs can never
   *  interleave (the lock is origin-wide; tabs share localStorage). The
   *  tab that wrote adopts the returned blob; the others learn of the
   *  change through the `storage` event (`onLearnStoreChanged`). */
  async applyLearnOp(op: LearnOp): Promise<string> {
    const run = async (): Promise<string> => {
      let cur: string | null = null;
      try {
        cur = localStorage.getItem(LEARN_STORE_KEY);
      } catch {
        /* storage blocked — apply against an empty copy */
      }
      if (cur !== null) {
        try {
          JSON.parse(cur);
        } catch {
          // Never overwrite a blob we could not read: set it aside first.
          try {
            localStorage.setItem(`${LEARN_STORE_KEY}.unreadable-${Date.now()}`, cur);
          } catch {
            /* best effort */
          }
          cur = null;
        }
      }
      const s = new LearnStore();
      s.loadJson(cur);
      applyLearnOp(s, op);
      const json = s.toJson();
      try {
        localStorage.setItem(LEARN_STORE_KEY, json);
      } catch (err) {
        console.warn('Learn store: not persisted (storage quota or disabled):', err);
      }
      return json;
    };
    if (typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function') {
      return (await navigator.locks.request(LEARN_STORE_LOCK, run)) as string;
    }
    return run();
  }

  onLearnStoreChanged(handler: (json: string) => void): () => void {
    const listener = (e: StorageEvent): void => {
      if (e.key === LEARN_STORE_KEY && typeof e.newValue === 'string') handler(e.newValue);
    };
    window.addEventListener('storage', listener);
    return () => window.removeEventListener('storage', listener);
  }

  async spawnWindow(payload: SpawnWindowPayload | null): Promise<void> {
    // Open a new editor window (see `openNewWindow` for why an anchor click and
    // not `window.open`). A doc payload is handed off via IndexedDB, keyed by an
    // id in the URL, which the new window reads back in `getInitialDoc`. Written
    // BEFORE the open so the payload is present by the time the (slower-booting)
    // new window looks for it.
    let query = '';
    if (payload) {
      const id = crypto.randomUUID();
      try {
        const db = await openDb();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_SPAWNS, 'readwrite');
          tx.objectStore(STORE_SPAWNS).put(payload, id);
          tx.oncomplete = (): void => resolve();
          tx.onerror = (): void => reject(tx.error ?? new Error('spawn write failed'));
          tx.onabort = (): void => reject(tx.error ?? new Error('spawn write aborted'));
        });
        query = `?spawn=${id}`;
      } catch (err) {
        console.warn('BrowserHost: spawn handoff store failed', err);
        // Fall through and open a blank window rather than nothing.
      }
    }
    const url = window.location.origin + window.location.pathname + query;
    openNewWindow(url);
  }

  async getInitialDoc(): Promise<SpawnWindowPayload | null> {
    if (!SPAWN_ID) return null;
    // Strip the ?spawn param so a reload doesn't try to re-consume it.
    try {
      window.history.replaceState({}, '', window.location.pathname);
    } catch {
      /* ignore */
    }
    try {
      const db = await openDb();
      return await new Promise<SpawnWindowPayload | null>((resolve) => {
        const tx = db.transaction(STORE_SPAWNS, 'readwrite');
        const store = tx.objectStore(STORE_SPAWNS);
        const req = store.get(SPAWN_ID);
        req.onsuccess = (): void => {
          const payload = (req.result as SpawnWindowPayload | undefined) ?? null;
          store.delete(SPAWN_ID); // one-shot
          resolve(payload);
        };
        req.onerror = (): void => resolve(null);
      });
    } catch {
      return null;
    }
  }

  async isFirstWindow(): Promise<boolean> {
    // A spawned window (carrying a ?spawn handoff) opened a specific doc — it's
    // not the session's first window and shouldn't run the recovery prompt.
    // Other web tabs each boot fresh and are "first" for their own recovery.
    return !SPAWN_ID;
  }

  private ensureFileInput(): HTMLInputElement {
    if (this.fileInput) return this.fileInput;
    const input = document.createElement('input');
    input.type = 'file';
    input.hidden = true;
    document.body.appendChild(input);
    this.fileInput = input;
    return input;
  }
}

/** Build a Blob from a Uint8Array, picking a reasonable MIME type
 *  from the filename extension. */
/** One write attempt: swap-file open → write → commit. */
async function writeThrough(fh: FileSystemFileHandle, blob: Blob): Promise<void> {
  const writable = await fh.createWritable();
  await writable.write(blob);
  await writable.close();
}

/** Write failures worth a refresh-and-retry. InvalidStateError is
 *  Chromium's stale-cached-state signal (its message is the generic
 *  "state cached in an interface object … changed since it was read
 *  from disk" text); NoModificationAllowedError is the write-refused
 *  variant some filesystems raise. NotFoundError and NotAllowedError
 *  stay excluded — those mean gone and permission, which retries can't
 *  fix and which upstream flows already classify. */
function isRetriableWriteError(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === 'InvalidStateError' || err.name === 'NoModificationAllowedError')
  );
}

function bytesToBlob(bytes: Uint8Array, filename: string): Blob {
  // Copy into a regular ArrayBuffer so Blob's BlobPart contract is
  // happy. Some TypedArray backing buffers are SharedArrayBuffer in
  // worker contexts; Blob doesn't accept those directly.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  return new Blob([ab], { type: mimeForExtension(ext) });
}
