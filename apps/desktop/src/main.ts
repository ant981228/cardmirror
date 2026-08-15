/**
 * CardMirror desktop — Electron main process.
 *
 * Responsibilities:
 *   - Create and manage the BrowserWindow that hosts the renderer.
 *   - Drive native open/save dialogs and read/write files from disk
 *     in response to renderer IPC. (Renderer-side Host abstraction
 *     in `src/editor/host/electron-host.ts`.)
 *   - Define the native menu bar; menu picks dispatch to the
 *     renderer as `'menu-command'` events, where they get routed
 *     through the same ribbon-command registry as keyboard
 *     shortcuts and ribbon buttons.
 *   - Host cross-window state: speech-doc registry, dropzone shelf,
 *     Quick Cards library, duplicate-open guard, crash-recovery
 *     journals, and auto-update.
 */

import {
  app,
  BrowserWindow,
  Menu,
  MenuItemConstructorOptions,
  MessageChannelMain,
  WebContentsView,
  clipboard,
  crashReporter,
  dialog,
  ipcMain,
  screen,
  shell,
  utilityProcess,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import { bundlePathFromExe, launchSwapHelper, macBundleSelfUpdatable } from './mac-swap-update.js';
import { registerVoiceIpc } from './voice/ipc';
import { registerFlowIpc } from './flow-bridge.js';
import { registerPairingIpc, relayUrl } from './pairing-ipc.js';
import {
  readAccessibilityTreeEnabled,
  writeAccessibilityTreeEnabled,
} from './accessibility-pref.js';
import { installMacAccessibilitySuppression } from './ax-suppress-mac.js';
import { resolveCmirCandidates, isWithin } from './transclusion-path.js';
import {
  saveExistingDoc,
  saveNewDoc,
  DocExistsError,
  recordDiskStateFromDisk,
  nearestExistingDir,
} from './doc-writes.js';
import {
  inspectFromGithub,
  commitPendingInstall,
  discardPendingInstall,
  setCommunityInstallsUnlocked,
  setAllowlistRelayUrlSupplier,
  listInstalled,
  readPluginSource,
  uninstallPlugin,
  checkPluginUpdate,
} from './plugin-manager.js';
import {
  grantReadPath,
  grantReadDir,
  setLibraryRoots,
  grantLegacyRecents,
  isReadAllowed,
} from './read-scope.js';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { gzip as zlibGzip, gunzip as zlibGunzip } from 'node:zlib';
import { promisify } from 'node:util';
import {
  setDocDirectory,
  startFastPasteBridge,
  stopFastPasteBridge,
  broadcastJump,
  getRunningEndpoint,
} from './fast-paste-bridge.js';
import {
  writeCardmirrorHandshake,
  deleteCardmirrorHandshake,
  scanFlowApps,
  flowPost,
} from './bridge-handshake.js';
import { hardenStdio } from './stdio-harden.js';

// FIRST executable statement: once stdio's far end can be a closed
// pipe (Linux launches), any console call — ours or Electron's own
// internal error logging — can raise an uncaught EPIPE and pop the
// main-process crash dialog. Nothing may log before this line.
hardenStdio();

const DEV_SERVER_URL = 'http://localhost:5173';

// macOS scroll-perf tuning. Belt-and-suspenders: none of these
// switches was the root fix for the historical scroll stalls (the
// Electron 33 → 42 / Chromium 130 → 148 bump was), but each is
// cheap and well-understood.
//
// `enable-zero-copy` lets the GPU upload raster tiles directly
// from main memory instead of double-buffering through the CPU —
// useful on Apple Silicon where the GPU shares system memory.
// `ignore-gpu-blocklist` overrides Chromium's conservative GPU
// blocklist so Apple Silicon devices that fall into a denied
// bucket still get full hardware acceleration.
// `enable-skia-graphite` opts into Chromium's newer Skia GPU
// backend (Dawn → Metal on macOS). On Chromium 148 (Electron 42)
// this is default-on for Apple platforms — the switch is a no-op,
// kept explicit to defend against any future default flip and to
// document the path we depend on.
//
// MUST run before `app.whenReady()` — Chromium reads switches at
// gpu-process startup.
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('enable-zero-copy');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-skia-graphite');
}

// Timer audio alerts schedule beeps on the AudioContext timeline; the
// scheduling window may not carry a recent user gesture (the alert
// owner can be a window the user never clicked, e.g. the timer
// pop-out). Chromium's autoplay policy would keep such a context
// suspended — waive it; a local editor has no drive-by-audio concern.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Start collecting crash minidumps as early as possible. We do
// NOT upload them — `uploadToServer: false` keeps everything on
// disk in `app.getPath('crashDumps')`. Users who hit a crash can
// pull the dump from there manually and attach it to a bug report.
// No telemetry, no remote endpoint, no third-party SDK.
crashReporter.start({
  productName: 'CardMirror',
  companyName: 'CardMirror',
  submitURL: '',
  uploadToServer: false,
});

// Default the renderer accessibility tree OFF. Electron 42 / Chromium 148 has a
// deterministic crash in Blink's accessibility serialization
// (blink::AXBlockFlowData::ComputeNeighborOnLine — a CHECK in the new
// AXBlockFlowIterator line-navigation code) that fires whenever an assistive-tech
// / UI-Automation client (screen reader, Windows Voice Access, Live Captions, …)
// turns the accessibility tree on. Symbolicated from real crash dumps; not fixed
// on current Chromium trunk. `--disable-renderer-accessibility` stops Chromium
// building/serializing the tree on Windows/Linux. On macOS the switch is not
// enough — an assistive-tech client setting AXEnhancedUserInterface on NSApp
// re-enables the tree behind it — so a second prong (installMacAccessibility-
// Suppression, called in whenReady) swizzles that AppKit path shut as well.
//
// Users who genuinely need a screen reader can opt back in via Settings (machine-
// local pref read here; the toggle prompts a restart since Chromium reads switches
// at startup). Fail-safe: any read failure leaves the switch ON (tree disabled).
// MUST run before `app.whenReady()`.
let rendererAccessibilityEnabled = false;
try {
  rendererAccessibilityEnabled = readAccessibilityTreeEnabled(app.getPath('userData'));
} catch {
  rendererAccessibilityEnabled = false;
}
if (!rendererAccessibilityEnabled) {
  app.commandLine.appendSwitch('disable-renderer-accessibility');
}

interface FileFilter {
  name: string;
  extensions: string[];
}

let mainWindow: BrowserWindow | null = null;

/** Optional initial-doc payload handed to a freshly-spawned window's
 *  renderer when it asks `host:get-initial-doc` at boot. Lets the
 *  spawning renderer pre-load a file into the new window without
 *  going through the file dialog again. Keyed by `BrowserWindow.id`. */
interface InitialDocPayload {
  filename: string;
  bytes: unknown; // arrives from renderer as Uint8Array / Buffer / ArrayBuffer
  handle: string | null;
  format: 'cmir' | 'docx' | null;
  uid: string | null;
  /** New Speech Document flow: spawned window self-marks the new
   *  doc as the speech doc after mounting. Optional / absent for
   *  normal Open + New spawns. */
  markAsSpeech?: boolean;
  /** Mode-switch reopen of a doc with unsaved changes: the spawned
   *  window mounts it dirty instead of the default clean. Passed
   *  through opaquely. */
  markDirty?: boolean;
  /** Mode-switch respawn of a recovered, not-yet-manually-saved draft:
   *  the original journal savedAt for the stale-overwrite guard. Passed
   *  through opaquely. */
  recoveredFromSavedAt?: string;
  /** "Show in context": spawned window scrolls + selects this anchor
   *  after mounting. Passed through opaquely (stored + returned via
   *  get-initial-doc); the renderer resolves it. */
  focusAnchor?: { quote: string; prefix: string; suffix: string; approxPos: number };
  /** Join a collaboration share code instead of mounting a doc. Passed
   *  through opaquely (stored + returned via get-initial-doc); the renderer
   *  runs the join. */
  joinShareCode?: string;
  /** Resume a persisted collaboration session instead of mounting a doc.
   *  Passed through opaquely, like joinShareCode. */
  resumeRoomId?: string;
}
const pendingInitialDocs = new Map<number, InitialDocPayload>();

/** Window id of the first window of this app session. Set on the
 *  first `createWindow` call; re-claimable by the next created
 *  window once the last window closes (macOS keeps the app alive
 *  windowless — without the reset, no window created after that
 *  point would ever run startup recovery). Used by the
 *  renderer's startup-recovery flow to gate the "offer to restore
 *  unsaved journals" UI: only the first window of a session should
 *  surface that UI — a subsequent spawned-blank window would
 *  otherwise offer to recover the docs the user already has open
 *  in the OTHER windows of this same session, which is confusing
 *  and useless. */
let firstWindowId: number | null = null;

/** A file path the OS asked us to open during the brief window
 *  between process start and `app.whenReady()`. macOS fires
 *  `open-file` very early (before whenReady) when the user
 *  double-clicks a registered .docx/.cmir, so we stash the
 *  path here and consume it inside the `whenReady` handler
 *  instead of dropping it on the floor. Cleared once consumed. */
let pendingLaunchFile: string | null = null;

/** Pick the first argv element that looks like one of our
 *  associated file types. Used for Windows / Linux launches —
 *  the OS passes the clicked file as a regular CLI argument
 *  rather than firing a dedicated event the way macOS does. */
function pickFileFromArgv(argv: readonly string[]): string | null {
  for (const a of argv) {
    if (typeof a !== 'string') continue;
    const lower = a.toLowerCase();
    if (lower.endsWith('.cmir') || lower.endsWith('.docx')) return a;
  }
  return null;
}

/** Window ids whose renderer is in multi-pane (3-slot workspace)
 *  mode. Populated/cleared by the renderer at boot via
 *  `host:register-multipane`, so it stays accurate across the
 *  reload a workspace-mode toggle triggers. Lets the OS-open path
 *  reuse an existing multi-pane window (routing the file through
 *  its slot picker) instead of spawning a blank one. Single-pane
 *  windows are absent, so they keep the spawn-a-new-window path. */
const multiPaneWindows = new Set<number>();

/** A multi-pane window to hand an externally-opened file to — the
 *  focused one when it's multi-pane, else any multi-pane window.
 *  Null when none exist (single-pane session, or cold launch). */
function pickMultiPaneTarget(): BrowserWindow | null {
  if (multiPaneWindows.size === 0) return null;
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed() && multiPaneWindows.has(focused.id)) {
    return focused;
  }
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && multiPaneWindows.has(w.id)) return w;
  }
  return null;
}

const CLOUD_WAIT_TIMEOUT_MS = 20_000;
const CLOUD_WAIT_POLL_MS = 400;
const cloudWaitDelay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Read a document file, waiting out a cloud "online-only" placeholder.
 *
 * A fully-synced file reads back exactly `stat.size` bytes. A Dropbox / iCloud
 * "online only" placeholder that hasn't downloaded reads back SHORT — often 0
 * bytes — because the provider materializes the content asynchronously and the
 * first read returns before the download lands. (A 0-byte read is what surfaces
 * downstream as "Not a CardMirror file: failed to parse JSON".) Opening the file
 * re-posts the fetch, so we re-read on a short interval to let an in-flight
 * download finish, up to a bounded timeout.
 *
 * Best-effort: returns whatever bytes it has after the wait (the parser then
 * gives a clear "not downloaded" message if it's still short). The fast path —
 * a normal, materialized file — returns on the first read with just one extra
 * `stat`.
 */
async function readDocumentBytes(filePath: string): Promise<Buffer> {
  let bytes = await fs.readFile(filePath);
  if (bytes.length >= (await fs.stat(filePath)).size) {
    // Baseline for the changed-on-disk save guard: remember what the
    // file looked like when we read it (see doc-writes.ts).
    await recordDiskStateFromDisk(filePath, bytes);
    return bytes;
  }
  const started = Date.now();
  while (Date.now() - started < CLOUD_WAIT_TIMEOUT_MS) {
    await cloudWaitDelay(CLOUD_WAIT_POLL_MS);
    const size = (await fs.stat(filePath)).size;
    bytes = await fs.readFile(filePath);
    if (bytes.length >= size) break;
  }
  await recordDiskStateFromDisk(filePath, bytes);
  return bytes;
}

/** Open a file the OS handed us (macOS `open-file`, Windows / Linux
 *  argv at launch or second-instance — e.g. "Open with… CardMirror").
 *  Multi-pane reuses an open window and routes the file through its
 *  slot picker (no blank new window); single-pane / cold launch spawns
 *  a fresh window with the file as its initial doc (VS Code / Word-like,
 *  and the single-pane behavior is unchanged). */
async function openExternalFile(filePath: string): Promise<void> {
  const ext = path.extname(filePath).toLowerCase();
  const format: 'cmir' | 'docx' | null =
    ext === '.cmir' ? 'cmir' : ext === '.docx' ? 'docx' : null;
  if (!format) return;
  grantReadPath(filePath); // OS handed it to us → the user opened it
  // Duplicate-open guard for the OS-open path. The in-app Open dialog
  // gets this via `host:open-path-check`; Finder / Dock / "Open with…"
  // double-clicks arrive here and must run the same check, or a file
  // already open in another window opens a second, conflicting copy
  // (whichever copy closes first then releases the shared claim).
  if (focusExistingOwner(filePath)) return;
  const target = pickMultiPaneTarget();
  if (target) {
    // Hand off to the existing workspace — it reads the path and shows
    // its slot picker. Bring it forward so the picker is visible.
    target.webContents.send('host:external-open', { path: filePath });
    if (target.isMinimized()) target.restore();
    target.focus();
    return;
  }
  try {
    const buf = await readDocumentBytes(filePath);
    createWindow({
      filename: path.basename(filePath),
      bytes: new Uint8Array(buf),
      handle: filePath,
      format,
      uid: null,
    });
  } catch (err) {
    console.warn('Failed to open external file:', filePath, err);
  }
}

/** Per-window allow-list for the next `close` event. The window
 *  close interception forwards the close to the renderer for
 *  confirmation; once the renderer has decided the window should
 *  close (Save, Save As, or Discard all do this; Cancel does not)
 *  it calls `host:close-self`, which adds the window's id here so
 *  the resulting `close` event passes through without bouncing
 *  back to the renderer. Cleared whenever a window is gone. */
const skipCloseConfirm = new Set<number>();

/** True once a genuine app-quit has been initiated (Cmd+Q, the
 *  app-menu Quit, or the OS asking us to shut down). The window
 *  `close` interception aborts every quit by design — it always
 *  `preventDefault()`s so the renderer can confirm unsaved work —
 *  so on macOS the resulting `window-all-closed` would otherwise
 *  leave the app alive in the dock with no windows, and Cmd+Q
 *  would appear to do nothing. We set this in `before-quit` and
 *  honour it in `window-all-closed` to finish the quit once every
 *  window has confirmed. Reset when the confirmation flow ends
 *  WITHOUT closing (Cancel, or a failed Save) via
 *  `host:close-cancelled`, so a later ordinary window close keeps
 *  the app running the way macOS expects. */
let quitInitiated = false;

function createWindow(initialDoc?: InitialDocPayload): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    // Explicit 0×0 minimum: Electron + Chromium will otherwise
    // advertise its own default minimum to the WM (~800×600 on some
    // Linux compositors). Pinning both to 0 advertises "no minimum"
    // so tiling WMs and split-screen layouts can shrink the window
    // arbitrarily; the renderer's CSS / JS handles narrow-viewport
    // degradation from there.
    minWidth: 0,
    minHeight: 0,
    title: 'CardMirror',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Chromium throttles JS / rAF in renderers whose windows are
      // partially occluded or out of focus — defensible on a 50-tab
      // browser, but here the user has typically one window with the
      // doc they're editing, and macOS aggressively backgrounds apps
      // that lose focus for even a moment (App Nap, occlusion
      // detection, etc.). Keep the renderer at full throttle so
      // scrolling / nav-pane interaction doesn't take an extra frame
      // when the window happens to be behind another.
      backgroundThrottling: false,
    },
  });

  // Mirror tagged renderer console lines to the main-process stdout —
  // renderer console output is otherwise only visible in DevTools,
  // which makes diagnostics like the repair-skip log unreadable from
  // a terminal dev session. Tagged-only: full forwarding would spam.
  win.webContents.on('console-message', (...args: unknown[]) => {
    // Electron emits (event, level, message, line, sourceId) in the
    // legacy signature and (event{level,message,...}) in the new one.
    const evt = args[0] as { message?: unknown; level?: unknown };
    const fromEvent = evt?.message;
    const msg = typeof fromEvent === 'string' ? fromEvent : args[2];
    if (typeof msg !== 'string') return;
    const level = typeof evt?.level === 'string' || typeof evt?.level === 'number' ? evt.level : args[1];
    // Error-level renderer output (uncaught exceptions, console.error)
    // is forwarded unconditionally — invisible exceptions in deferred
    // callbacks have repeatedly been the missing diagnostic.
    const isError = level === 3 || level === 'error';
    if (isError || /^\[(repair(-fmt)?|cardmirror)\]/.test(msg)) {
      console.log(`[renderer${isError ? ':error' : ''}] ${msg}`);
    }
  });

  // Renderer-crash recovery + telemetry. A NATIVE renderer death — the
  // Electron 42 / Chromium 148 accessibility CHECK
  // (blink::AXBlockFlowData::ComputeNeighborOnLine, confirmed from field
  // crash dumps), a GPU-process crash, or an OOM — otherwise leaves a
  // permanently blank window with no way back: the journal/autosave timers
  // die with the renderer, so unsaved work is stranded. We record the
  // reason (we capture NOTHING for these in-app today — only Crashpad
  // minidumps the user has to dig out) and reload, turning a terminal
  // white screen into a blink-and-recover: the reloaded renderer's startup
  // flow restores unsaved work from the crash journal.
  const recentReloads: number[] = [];
  win.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    const stamp =
      `${new Date().toISOString()} render-process-gone reason=${details.reason} ` +
      `exitCode=${details.exitCode ?? '?'} title=${JSON.stringify(win.isDestroyed() ? '' : win.getTitle())}`;
    console.error(`[main:renderer-crash] ${stamp}`);
    void fs
      .appendFile(path.join(app.getPath('userData'), 'renderer-crashes.log'), stamp + '\n')
      .catch(() => {});
    if (win.isDestroyed()) return;
    // Loop guard: if the doc deterministically re-crashes on load, don't
    // spin — preserve the journal and tell the user to restart.
    const now = Date.now();
    while (recentReloads.length > 0 && now - recentReloads[0]! > 30_000) recentReloads.shift();
    recentReloads.push(now);
    if (recentReloads.length > 3) {
      dialog.showErrorBox(
        'CardMirror kept crashing',
        'The editor window crashed several times in a row. Your unsaved work is preserved ' +
          'in the recovery journal — please quit and reopen CardMirror.',
      );
      return;
    }
    win.webContents.reload();
  });

  // Stash the initial doc (if any) BEFORE loading the renderer so
  // the renderer's `host:get-initial-doc` call at boot finds it.
  if (initialDoc) {
    pendingInitialDocs.set(win.id, initialDoc);
  }

  // First window of the app session is the only one allowed to
  // surface the startup-recovery UI; subsequent windows report
  // false via `host:is-first-window` and skip the prompt.
  if (firstWindowId === null) {
    firstWindowId = win.id;
  }

  if (!app.isPackaged) {
    void win.loadURL(DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    // electron-builder packages the renderer's vite-build output
    // under `Resources/renderer/` via the `extraResources` block in
    // apps/desktop/package.json. `process.resourcesPath` resolves
    // to that Resources dir on every platform (Contents/Resources on
    // macOS, resources/ on Windows / Linux). Same code path for all
    // packaged builds.
    void win.loadFile(
      path.join(process.resourcesPath, 'renderer', 'index.html'),
    );
  }

  // Track the focused window so menu commands fire at the right
  // place when multiple windows exist.
  win.on('focus', () => {
    mainWindow = win;
  });
  // Intercept user-initiated close (X button, Cmd-W, etc.) so the
  // renderer can prompt for unsaved-doc handling. The renderer
  // responds by either calling `host:close-self` (which adds the
  // window's id to `skipCloseConfirm` so the resulting close
  // event passes through cleanly) or by doing nothing (Cancel).
  // Programmatic closes from elsewhere in this file go through
  // the same skip-set, so they aren't double-prompted.
  win.on('close', (e) => {
    if (skipCloseConfirm.has(win.id)) {
      skipCloseConfirm.delete(win.id);
      return;
    }
    if (win.webContents.isDestroyed()) {
      // Renderer is gone — nothing to ask. Let the close proceed.
      return;
    }
    e.preventDefault();
    win.webContents.send('host:close-request');
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
    pendingInitialDocs.delete(win.id);
    skipCloseConfirm.delete(win.id);
    multiPaneWindows.delete(win.id);
    // A lone floating timer must not outlive the last document
    // window (it would block `window-all-closed` from ever firing
    // on Windows / Linux).
    closeTimerWindowIfOrphaned();
  });

  mainWindow = win;
  return win;
}

/** Find the BrowserWindow that owns the renderer making an IPC
 *  call. Falls back to the focused window when sender lookup fails
 *  (shouldn't, but be defensive). */
function ownerWindow(sender: Electron.WebContents): BrowserWindow | null {
  return (
    BrowserWindow.fromWebContents(sender) ??
    BrowserWindow.getFocusedWindow() ??
    mainWindow
  );
}

/** Convert IPC-transferred bytes (which can arrive as a plain
 *  Uint8Array view, a Node Buffer, or even a structured-cloned
 *  ArrayBuffer depending on Electron version) into a Buffer the
 *  fs API will accept. */
function bytesToBuffer(bytes: unknown): Buffer {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  throw new TypeError('Unsupported bytes payload — expected Uint8Array / ArrayBuffer / Buffer.');
}

// ─── Research browser ────────────────────────────────────────────
//
// A WebContentsView docked INTO one pane of the multi-pane workspace
// (never a fixed overlay over the whole window — a single-pane doc
// has nowhere to spare) so a user can browse for source material
// without leaving CardMirror, then send a selection into the focused
// editor pane (research-browser-panel.ts, renderer side, which also
// enforces the multi-pane-only gate and the pane picker). The
// embedded page runs UNPRIVILEGED — no preload, contextIsolation on,
// sandboxed — since it renders arbitrary third-party web content.
// One view per document window, created lazily on first toggle and
// kept alive (navigation state persists) across hide/show.
//
// Bounds are pushed from the renderer (`host:browser-set-bounds`),
// tracking the chosen pane's `getBoundingClientRect()` via
// ResizeObserver — that already reacts to window resizes and
// splitter drags, so main doesn't re-derive layout itself.

const RESEARCH_BROWSER_HOME = 'https://www.google.com';
// The renderer draws its own toolbar (address bar, nav buttons, insert
// actions) as ordinary DOM docked at the top of the same pane rect —
// the native view is positioned BELOW it so the DOM toolbar stays
// visible (a WebContentsView always paints over same-window DOM
// content it overlaps). Keep in sync with the panel's CSS toolbar
// height in research-browser-panel.ts.
const RESEARCH_BROWSER_TOOLBAR_HEIGHT = 76;

interface ResearchBrowserState {
  view: WebContentsView;
  visible: boolean;
}

const researchBrowsers = new Map<number, ResearchBrowserState>();

function isNavigableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function sendResearchBrowserNavState(win: BrowserWindow, view: WebContentsView): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return;
  const wc = view.webContents;
  win.webContents.send('host:browser-nav-state', {
    url: wc.getURL(),
    title: wc.getTitle(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    loading: wc.isLoading(),
  });
}

function getOrCreateResearchBrowser(win: BrowserWindow): ResearchBrowserState {
  const existing = researchBrowsers.get(win.id);
  if (existing) return existing;

  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Deny popups outright — a genuine new-tab intent opens in the OS
  // browser instead of spawning another in-app surface. Non-http(s)
  // schemes (file:, chrome:, custom protocol handlers) never open.
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (isNavigableUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  view.webContents.on('will-navigate', (event, url) => {
    if (!isNavigableUrl(url)) event.preventDefault();
  });
  view.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });
  view.webContents.session.on('will-download', (event) => event.preventDefault());

  const state: ResearchBrowserState = { view, visible: false };
  researchBrowsers.set(win.id, state);

  const notify = (): void => sendResearchBrowserNavState(win, view);
  view.webContents.on('did-navigate', notify);
  view.webContents.on('did-navigate-in-page', notify);
  view.webContents.on('page-title-updated', notify);
  view.webContents.on('did-start-loading', notify);
  view.webContents.on('did-stop-loading', notify);

  win.on('closed', () => researchBrowsers.delete(win.id));

  void view.webContents.loadURL(RESEARCH_BROWSER_HOME);
  return state;
}

// ─── IPC handlers ──────────────────────────────────────────────────

/** F2 (Paste Plain Text) on Electron: the renderer asks main for
 *  the clipboard's plain-text content and pastes it immediately
 *  (no Ctrl/Cmd+V required, no sticky toggle). Web edition keeps
 *  its arm-then-paste flow because navigator.clipboard.readText
 *  needs a per-press permission grant under Chromium's web policy. */
ipcMain.handle('host:clipboard-read-text', () => clipboard.readText());
/** Editor context-menu Paste: both flavors in one read so the
 *  renderer can prefer rich html and fall back to plain text
 *  without a second IPC round trip racing the clipboard. */
ipcMain.handle('host:clipboard-read-html', () => ({
  html: clipboard.readHTML(),
  text: clipboard.readText(),
}));
ipcMain.handle(
  'host:clipboard-write-html',
  (_evt, payload?: { html?: unknown; text?: unknown }) => {
    const html = typeof payload?.html === 'string' ? payload.html : '';
    const text = typeof payload?.text === 'string' ? payload.text : '';
    if (!html && !text) return false;
    // Omit empty flavors — passing html: '' would REGISTER an empty
    // text/html format, and Word/Docs prefer the HTML flavor, so a
    // text-only copy would paste as nothing there.
    const data: Electron.Data = {};
    if (html) data.html = html;
    if (text) data.text = text;
    clipboard.write(data);
    // clipboard.write returns void — verify by reading the text
    // flavor back (both flavors land in the one atomic write, so
    // text present ⇒ the write took). Bounded compare: length + a
    // prefix, so multi-megabyte cards don't pay a full scan. The
    // only blind spot is another app overwriting the clipboard in
    // the microseconds between write and read — which reports a
    // false FAILURE, the safe direction.
    if (text) {
      const readBack = clipboard.readText();
      const N = 4096;
      return readBack.length === text.length && readBack.slice(0, N) === text.slice(0, N);
    }
    // html-only payload (no callers today): trust the write.
    return true;
  },
);

/** Toggle DevTools on the window that asked. Backs the rebindable
 *  "Open Developer Console" ribbon command: the packaged app sets a
 *  null application menu on Windows/Linux, so the stock accelerators
 *  (F12 / Ctrl+Shift+I) don't exist there — without this, a packaged
 *  build has no console access at all. */
ipcMain.handle('host:toggle-devtools', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.webContents.toggleDevTools();
});

/** Research browser (desktop-only) — a docked WebContentsView the user
 *  browses source material in and pulls selections out of. See the
 *  helpers above for the embedding + isolation posture. */
ipcMain.handle('host:browser-toggle', (event, show: boolean) => {
  const win = ownerWindow(event.sender);
  if (!win) return;
  const state = getOrCreateResearchBrowser(win);
  state.visible = !!show;
  if (state.visible) {
    win.contentView.addChildView(state.view);
    // No bounds yet — stay a zero-size view until the renderer's first
    // `host:browser-set-bounds` (right after toggle-on, once it knows
    // which pane it's docking into) lands.
  } else {
    win.contentView.removeChildView(state.view);
  }
});

/** Position the native view within the pane rect the renderer just
 *  measured (`el.getBoundingClientRect()`, tracked live via
 *  ResizeObserver) — the toolbar strip at the top of that same rect
 *  is ordinary DOM the renderer draws itself. Rect is in the window's
 *  CSS-pixel content-view coordinate space. */
ipcMain.handle(
  'host:browser-set-bounds',
  (event, rect: { x: number; y: number; width: number; height: number }) => {
    const win = ownerWindow(event.sender);
    const state = win && researchBrowsers.get(win.id);
    if (!state || !state.visible) return;
    const x = Math.round(rect.x);
    const y = Math.round(rect.y) + RESEARCH_BROWSER_TOOLBAR_HEIGHT;
    const width = Math.max(0, Math.round(rect.width));
    const height = Math.max(0, Math.round(rect.height) - RESEARCH_BROWSER_TOOLBAR_HEIGHT);
    state.view.setBounds({ x, y, width, height });
  },
);

ipcMain.handle('host:browser-navigate', (event, url: string) => {
  const win = ownerWindow(event.sender);
  if (!win) return;
  const state = researchBrowsers.get(win.id);
  if (!state) return;
  const target = isNavigableUrl(url)
    ? url
    : `https://www.google.com/search?q=${encodeURIComponent(url)}`;
  void state.view.webContents.loadURL(target);
});

ipcMain.handle('host:browser-back', (event) => {
  const win = ownerWindow(event.sender);
  const state = win && researchBrowsers.get(win.id);
  if (state?.view.webContents.navigationHistory.canGoBack()) {
    state.view.webContents.navigationHistory.goBack();
  }
});

ipcMain.handle('host:browser-forward', (event) => {
  const win = ownerWindow(event.sender);
  const state = win && researchBrowsers.get(win.id);
  if (state?.view.webContents.navigationHistory.canGoForward()) {
    state.view.webContents.navigationHistory.goForward();
  }
});

ipcMain.handle('host:browser-reload', (event) => {
  const win = ownerWindow(event.sender);
  const state = win && researchBrowsers.get(win.id);
  state?.view.webContents.reload();
});

ipcMain.handle('host:browser-get-selection', async (event) => {
  const win = ownerWindow(event.sender);
  const state = win && researchBrowsers.get(win.id);
  if (!state) return { text: '', title: '', url: '' };
  try {
    const text = await state.view.webContents.executeJavaScript(
      'window.getSelection() ? window.getSelection().toString() : ""',
    );
    return {
      text: typeof text === 'string' ? text : '',
      title: state.view.webContents.getTitle(),
      url: state.view.webContents.getURL(),
    };
  } catch {
    return { text: '', title: '', url: '' };
  }
});

/** Trigger an electron-updater check from the renderer. Mirrors
 *  the Help → Check for Updates… menu item so the same flow can
 *  be reached from Settings → General → "About this install".
 *  In dev (non-packaged) the menu shows a friendly note instead
 *  of running; the renderer path returns `'dev'` so the UI can
 *  do the same. */
ipcMain.handle('host:check-for-updates', async () => {
  if (!app.isPackaged) return { status: 'dev' };
  return new Promise<{ status: 'latest' | 'updating' | 'error'; message?: string }>((resolve) => {
    const offNotAvailable = (): void => {
      autoUpdater.removeListener('update-not-available', notAvailable);
      autoUpdater.removeListener('update-available', available);
      autoUpdater.removeListener('error', errored);
    };
    const notAvailable = (): void => { offNotAvailable(); resolve({ status: 'latest' }); };
    const available = (): void => { offNotAvailable(); resolve({ status: 'updating' }); };
    const errored = (err: Error): void => {
      offNotAvailable();
      resolve({ status: 'error', message: err.message });
    };
    autoUpdater.once('update-not-available', notAvailable);
    autoUpdater.once('update-available', available);
    autoUpdater.once('error', errored);
    autoUpdater.checkForUpdates().catch((err: unknown) => {
      offNotAvailable();
      resolve({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    });
  });
});

/** At-launch silent update check. Called by the renderer at boot
 *  iff `settings.checkForUpdatesOnLaunch` is enabled AND this is
 *  the first window of the app session (mirrors the recovery-UI
 *  gating — only the first window of a session offers the
 *  prompt). No-op in dev. Routes through the same `runUpdateCheck`
 *  as the manual path but with the "latest" and "error" dialogs
 *  suppressed; only "Update available" fires a dialog, which is
 *  the same modal the manual flow shows. */
ipcMain.handle('host:trigger-auto-update-check', async () => {
  runUpdateCheck({ alertOnLatest: false, alertOnError: false, alertOnAvailable: false });
});

/** Open the OS file manager at the crash-dumps folder. Mirrors
 *  the Help → Open Crash Dumps Folder menu item. */
ipcMain.handle('host:open-crash-dumps', async () => {
  await shell.openPath(app.getPath('crashDumps'));
});

/** Open the OS file manager at the crash-recovery journals folder
 *  ({userData}/journals). Ensures the folder exists first so the
 *  command works even before any journal has been written. */
ipcMain.handle('host:open-journals-folder', async () => {
  await ensureJournalsDir();
  await shell.openPath(journalsDir());
});

/** Minimize the calling window — the `minimizeWindow` ribbon command
 *  (Mod-m default) and the macOS Window-menu Minimize item. */
ipcMain.handle('host:minimize-window', (event) => {
  ownerWindow(event.sender)?.minimize();
});

// Renderer accessibility tree toggle (see the `--disable-renderer-accessibility`
// block above). The pref is machine-local and read at startup; these let the
// settings UI show + change it. Changing it needs a restart to take effect.
ipcMain.handle('host:get-accessibility-tree-enabled', () =>
  readAccessibilityTreeEnabled(app.getPath('userData')),
);
ipcMain.handle('host:set-accessibility-tree-enabled', (_event, enabled: unknown) => {
  writeAccessibilityTreeEnabled(app.getPath('userData'), enabled === true);
});
// The state ACTUALLY APPLIED this session (the value read at startup, which
// decides whether `--disable-renderer-accessibility` was appended). May differ
// from the saved pref until the next restart — the settings UI uses this to show
// "currently on/off" and whether a restart is pending.
ipcMain.handle('host:get-accessibility-tree-applied', () => rendererAccessibilityEnabled);
// Whether Chromium currently reports an assistive-tech / UI-Automation client as
// active. True here means this machine would hit the AX crash if the tree were
// enabled — surfaced in Settings so the user understands why it's off.
ipcMain.handle('host:is-accessibility-support-active', () =>
  app.isAccessibilitySupportEnabled(),
);
// Full app relaunch — used by the accessibility toggle so the Chromium switch
// (read only at process start) actually takes effect.
ipcMain.handle('host:relaunch-app', () => {
  app.relaunch();
  app.exit(0);
});

/** Open a URL in the user's default OS browser. Used by the
 *  hyperlink context menu's "Open Link" action — we route through
 *  the shell instead of `window.open` so the link lands in the
 *  user's real browser, not a new Electron BrowserWindow. */
ipcMain.handle('host:open-external', async (_event, url: string) => {
  // Defensive: only allow http(s) + mailto so a crafted file:// URL
  // can't pop a local viewer the user didn't expect.
  if (typeof url !== 'string') return;
  if (!/^(https?:|mailto:)/i.test(url)) return;
  await shell.openExternal(url);
});

ipcMain.handle(
  'host:pick-directory',
  async (event, opts?: { defaultPath?: string; title?: string }) => {
    const win = ownerWindow(event.sender);
    const result = await dialog.showOpenDialog(
      win ?? new BrowserWindow({ show: false }),
      {
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: opts?.defaultPath,
        title: opts?.title,
      },
    );
    if (result.canceled || result.filePaths.length === 0) return null;
    // A user-picked directory puts its subtree in play for path reads
    // (folder-scan features enumerate inside it).
    grantReadDir(result.filePaths[0]!);
    return result.filePaths[0]!;
  },
);

// Path-only file picker: unlike host:open-file below, nothing is read
// and NO read scope is granted — the caller (the file-search exclusion
// list) needs a path to block, never the file's content.
ipcMain.handle(
  'host:pick-file',
  async (event, opts?: { defaultPath?: string; title?: string; filters?: FileFilter[] }) => {
    const win = ownerWindow(event.sender);
    const result = await dialog.showOpenDialog(win ?? new BrowserWindow({ show: false }), {
      properties: ['openFile'],
      defaultPath: opts?.defaultPath,
      title: opts?.title,
      filters: opts?.filters?.length ? opts.filters : [],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0]!;
  },
);

ipcMain.handle('host:open-file', async (event, opts: { filters?: FileFilter[] }) => {
  const win = ownerWindow(event.sender);
  const result = await dialog.showOpenDialog(win ?? new BrowserWindow({ show: false }), {
    properties: ['openFile'],
    filters: opts?.filters?.length ? opts.filters : [],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0]!;
  grantReadPath(filePath); // user-picked → reopenable by path (recents)
  const bytes = await readDocumentBytes(filePath);
  return {
    name: path.basename(filePath),
    bytes: new Uint8Array(bytes),
    handle: filePath,
  };
});

// ── Card-cutter local plugin (experimental; NEVER bundled in the
// release). The engine ships as a user-installed JS bundle on disk; the
// renderer asks for its source here and runs it in its main world. ──
function cardCutterDefaultPath(): string {
  return path.join(app.getPath('userData'), 'plugins', 'cardcutter.global.js');
}
ipcMain.handle('host:cardcutter-pick-file', async (event) => {
  const win = ownerWindow(event.sender);
  const result = await dialog.showOpenDialog(win ?? new BrowserWindow({ show: false }), {
    title: 'Select card-cutter engine file',
    properties: ['openFile'],
    filters: [{ name: 'JavaScript', extensions: ['js', 'mjs', 'cjs'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0]!;
});
ipcMain.handle('host:cardcutter-read', async (_event, explicit: string | null) => {
  const target =
    (explicit && explicit.trim()) || process.env.CARDCUTTER_ENGINE || cardCutterDefaultPath();
  try {
    const source = await fs.readFile(target, 'utf8');
    return { source, path: target };
  } catch (err) {
    return { error: (err as Error).message, path: target };
  }
});

// ── Plugin manager (GitHub install; Obsidian model). Installed plugins
// live in userData/plugins/<id>/ next to the legacy cardcutter file.
// The renderer asks for a bundle's source and runs it in its main
// world, same as the card-cutter path above. ──
// Two-phase install: inspect stages the release in memory and returns what
// the consent dialog needs (incl. the real owner/repo); commit writes only
// after consent; discard drops the staged files on decline. The allowlist
// check lives inside inspectFromGithub — main-side, so the renderer can't
// route around it. The unlock flag arrives over its own channel (the
// renderer's console command re-arms it each boot from its stored setting).
ipcMain.handle('host:plugin-install-inspect', async (_e, ref: string) =>
  inspectFromGithub(String(ref)),
);
ipcMain.handle('host:plugin-install-commit', async (_e, token: string) =>
  commitPendingInstall(String(token)),
);
ipcMain.handle('host:plugin-install-discard', async (_e, token: string) => {
  discardPendingInstall(String(token));
});
ipcMain.handle('host:plugin-community-installs', async (_e, on: boolean) => {
  setCommunityInstallsUnlocked(on === true);
});
ipcMain.handle('host:plugin-list', async () => listInstalled());
ipcMain.handle('host:plugin-read', async (_e, id: string) => {
  const source = await readPluginSource(String(id));
  return source === null ? { error: 'not found' } : { source };
});
ipcMain.handle('host:plugin-read-file', async (_e, filePath: string) => {
  // Dev path — load an arbitrary local bundle the user picked.
  if (typeof filePath !== 'string' || !filePath) return { error: 'bad path' };
  try {
    return { source: await fs.readFile(filePath, 'utf8') };
  } catch (err) {
    return { error: (err as Error).message };
  }
});
ipcMain.handle('host:plugin-uninstall', async (_e, id: string) => uninstallPlugin(String(id)));
ipcMain.handle('host:plugin-check-update', async (_e, id: string, repoRef: string) =>
  checkPluginUpdate(String(id), String(repoRef)),
);
ipcMain.handle('host:plugin-pick-file', async (event) => {
  const win = ownerWindow(event.sender);
  const result = await dialog.showOpenDialog(win ?? new BrowserWindow({ show: false }), {
    title: 'Select a plugin bundle',
    properties: ['openFile'],
    filters: [{ name: 'JavaScript', extensions: ['js', 'mjs', 'cjs'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0]!;
});

// Read a file at a known absolute path — used by the home
// screen's "open recent" path, which already has the path from
// the recents list and shouldn't pop a file picker. Returns null
// (rather than throwing) when the file is missing / unreadable so
// the caller can prune a stale recent entry gracefully.
//
// SCOPED (PR #25 review): only paths the user put in play — library
// roots, session dialog picks, OS opens, or past grants — are served;
// see read-scope.ts. Everything else reads as missing.
//
// The renderer mirrors its File-search folders here (boot + on change),
// and imports its pre-existing recents ONCE (the import channel dies as
// soon as the grant journal exists — it can't mint grants after that).
ipcMain.handle('host:sync-library-roots', async (_event, roots: unknown) => {
  setLibraryRoots(Array.isArray(roots) ? roots.map(String) : []);
});
// Fired by the preload's getPathForFile — a real dropped file resolved
// by webUtils. Not on the exposed electronAPI surface.
ipcMain.on('host:grant-dropped-path', (_event, p: unknown) => {
  if (typeof p === 'string' && p) grantReadPath(p);
});
ipcMain.handle('host:grant-legacy-recents', async (_event, paths: unknown) =>
  grantLegacyRecents(Array.isArray(paths) ? paths.map(String) : []),
);
ipcMain.handle('host:read-file-at-path', async (_event, filePath: string) => {
  if (typeof filePath !== 'string' || !filePath) return null;
  if (!(await isReadAllowed(filePath))) return null;
  try {
    const bytes = await readDocumentBytes(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const format: 'cmir' | 'docx' | null =
      ext === '.cmir' ? 'cmir' : ext === '.docx' ? 'docx' : null;
    if (!format) return null;
    return {
      name: path.basename(filePath),
      bytes: new Uint8Array(bytes),
      handle: filePath,
      format,
    };
  } catch {
    return null;
  }
});

// stat a file (mtime + size) for the recovery-save staleness check. Null
// when the path is gone / unreadable.
ipcMain.handle('host:stat-file', async (_event, filePath: string) => {
  if (typeof filePath !== 'string' || !filePath) return null;
  try {
    const st = await fs.stat(filePath);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
});

// Resolve + read a source .cmir for a transclusion refresh. Given the
// transcluding doc's own absolute path and a RELATIVE ref, resolve against the
// doc's directory, then HARD-SCOPE the result to the configured library roots
// (or the doc's own folder) and reject any `..` escape — the ref can travel
// inside a document authored by someone else (TRANSCLUSION_PLAN.md §3.2). It
// only ever parses a .cmir looking for a heading; it executes nothing. Returns
// null (never throws) on any failure, which the renderer treats as
// "unreachable — render from cache."
/** Upper bound on a source `.cmir` we'll pull into memory for a transclusion
 *  refresh. Generous vs. real debate masters (tens of MB); it exists to stop a
 *  hostile/oversized file (or a symlink to a device) from exhausting memory. */
const MAX_CMIR_READ_BYTES = 256 * 1024 * 1024;

/**
 * Resolve a transclusion source ref to a safe, canonical absolute path (or null).
 * Lexical containment (resolveCmirCandidates) can't see through symlinks, and the
 * filesystem FOLLOWS them — so a `.cmir` symlink inside a root could otherwise be
 * followed to an arbitrary file outside it (the ref travels in a doc someone else
 * authored). Re-verify on the CANONICAL path: realpath the target AND the allowed
 * roots (a root may itself live under a symlink), then require the real target to
 * sit inside a real root, be a regular file, and be within a sane size. This is
 * the actual boundary; the lexical check is just a fast pre-filter. Never throws.
 */
async function safeResolveCmirPath(
  docPath: string,
  sourceRef: string,
  refBase: 'doc' | 'root',
  rootList: string[],
  sourceAbs: string,
): Promise<string | null> {
  const candidates = resolveCmirCandidates(docPath, sourceRef, refBase, rootList, sourceAbs);
  const allowedBases = refBase === 'root' ? rootList : [...rootList, path.dirname(docPath)];
  const realBases: string[] = [];
  for (const b of allowedBases) {
    try {
      realBases.push(await fs.realpath(b));
    } catch {
      realBases.push(b);
    }
  }
  for (const abs of candidates) {
    try {
      const real = await fs.realpath(abs);
      // Symlink (or symlinked parent dir) that escapes every allowed root → drop.
      if (!realBases.some((rb) => isWithin(rb, real))) continue;
      const st = await fs.stat(real);
      // Reject devices/FIFOs (a `.cmir` symlink to /dev/zero would read forever)
      // and absurdly large files. Debate masters run to tens of MB → generous cap.
      if (!st.isFile() || st.size > MAX_CMIR_READ_BYTES) continue;
      return real;
    } catch {
      // try the next candidate root
    }
  }
  return null;
}

/** Coerce the untrusted IPC ref args, or null when malformed. */
function normalizeRefArgs(
  docPath: unknown,
  sourceRef: unknown,
  base: unknown,
  roots: unknown,
  sourceAbs: unknown,
): {
  docPath: string;
  sourceRef: string;
  refBase: 'doc' | 'root';
  rootList: string[];
  sourceAbs: string;
} | null {
  if (typeof docPath !== 'string' || typeof sourceRef !== 'string') return null;
  const refBase: 'doc' | 'root' = base === 'root' ? 'root' : 'doc';
  const rootList = Array.isArray(roots)
    ? roots.filter((r): r is string => typeof r === 'string' && r !== '')
    : [];
  return {
    docPath,
    sourceRef,
    refBase,
    rootList,
    sourceAbs: typeof sourceAbs === 'string' ? sourceAbs : '',
  };
}

ipcMain.handle(
  'host:read-cmir-file',
  async (
    _event,
    docPath: unknown,
    sourceRef: unknown,
    base: unknown,
    roots: unknown,
    sourceAbs: unknown,
  ) => {
    const a = normalizeRefArgs(docPath, sourceRef, base, roots, sourceAbs);
    if (!a) return null;
    const real = await safeResolveCmirPath(a.docPath, a.sourceRef, a.refBase, a.rootList, a.sourceAbs);
    if (!real) return null;
    try {
      const bytes = await readDocumentBytes(real);
      return { bytes: new Uint8Array(bytes), name: path.basename(real) };
    } catch {
      return null;
    }
  },
);

/** Resolve a transclusion source ref to its safe absolute path (for "Open source
 *  file" from a live zone). Same boundary as reading — never resolves a path
 *  outside the allowed roots. */
ipcMain.handle(
  'host:resolve-cmir-path',
  async (
    _event,
    docPath: unknown,
    sourceRef: unknown,
    base: unknown,
    roots: unknown,
    sourceAbs: unknown,
  ) => {
    const a = normalizeRefArgs(docPath, sourceRef, base, roots, sourceAbs);
    if (!a) return null;
    return safeResolveCmirPath(a.docPath, a.sourceRef, a.refBase, a.rootList, a.sourceAbs);
  },
);

/** Write an anchored `.docx` back over its source so a raw Word file becomes a
 *  refreshable live-zone source. The `bytes` are the renderer's surgical
 *  injector output — the original file with a single `pmd-heading` bookmark
 *  added. This side re-enforces the SAME containment boundary as reading (never
 *  writes outside the allowed roots), refuses anything but a `.docx`, and writes
 *  atomically (temp + fsync + rename) so a crash can't tear the source. It only
 *  ever persists caller bytes to a resolved-safe path — it never constructs the
 *  content, so a hostile ref can't be used to overwrite arbitrary files. */
ipcMain.handle(
  'host:write-source-anchor',
  async (
    _event,
    docPath: unknown,
    sourceRef: unknown,
    base: unknown,
    roots: unknown,
    sourceAbs: unknown,
    bytes: unknown,
  ): Promise<{ ok: true; name: string } | { ok: false; reason: string }> => {
    const a = normalizeRefArgs(docPath, sourceRef, base, roots, sourceAbs);
    if (!a) return { ok: false, reason: 'bad-args' };
    let buf: Buffer;
    try {
      buf = bytesToBuffer(bytes);
    } catch {
      return { ok: false, reason: 'bad-args' };
    }
    if (buf.byteLength === 0 || buf.byteLength > MAX_CMIR_READ_BYTES) {
      return { ok: false, reason: 'bad-args' };
    }
    const real = await safeResolveCmirPath(
      a.docPath,
      a.sourceRef,
      a.refBase,
      a.rootList,
      a.sourceAbs,
    );
    if (!real) return { ok: false, reason: 'unresolved' };
    // The resolver admits `.cmir` and `.docx`; only ever rewrite a `.docx`
    // (a `.cmir` already carries stable ids and must not be touched here).
    if (path.extname(real).toLowerCase() !== '.docx') return { ok: false, reason: 'not-docx' };
    // Stage a sibling temp in the SAME directory, derived from the VALIDATED
    // `real` (never renderer strings, so the target can't be redirected between
    // resolve and rename), fsync for durability, then rename over the original.
    const tmpPath = `${real}.cmir-anchor.tmp`;
    try {
      const fh = await fs.open(tmpPath, 'w');
      try {
        await fh.writeFile(buf);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fs.rename(tmpPath, real);
      // In-app write — refresh the changed-on-disk baseline so a doc
      // that has this file open doesn't get a false conflict prompt.
      await recordDiskStateFromDisk(real, buf);
      return { ok: true, name: path.basename(real) };
    } catch {
      try {
        await fs.unlink(tmpPath);
      } catch {
        /* best-effort cleanup of the temp file */
      }
      return { ok: false, reason: 'write-failed' };
    }
  },
);

// Bulk-convert support: recursively list files of a given extension
// under a directory, and write bytes to an arbitrary path. Used by the
// home-screen .docx↔.cmir bulk converter.
ipcMain.handle(
  'host:list-files-recursive',
  async (_event, dir: string, ext: string): Promise<Array<{ path: string; relPath: string }>> => {
    if (typeof dir !== 'string' || !dir || typeof ext !== 'string' || !ext) return [];
    const suffix = `.${ext.toLowerCase()}`;
    const out: Array<{ path: string; relPath: string }> = [];
    async function walk(cur: string): Promise<void> {
      let entries;
      try {
        entries = await fs.readdir(cur, { withFileTypes: true });
      } catch {
        return; // unreadable dir — skip
      }
      for (const ent of entries) {
        const name = ent.name;
        // Skip OS/Office junk that shares the extension but isn't a real
        // document: Word lock/owner files (~$…), macOS AppleDouble sidecars
        // (._…), and the __MACOSX metadata folder mac zips leave behind. These
        // aren't valid zips and would otherwise each surface as a scary error.
        if (name.startsWith('~$') || name.startsWith('._')) continue;
        const full = path.join(cur, name);
        if (ent.isDirectory()) {
          if (name === '__MACOSX') continue;
          await walk(full);
        } else if (ent.isFile() && name.toLowerCase().endsWith(suffix)) {
          out.push({ path: full, relPath: path.relative(dir, full) });
        }
      }
    }
    await walk(dir);
    return out;
  },
);

// ── Bulk-compress (temporary migration tool) ────────────────────────
// Rewrites every .cmir under a folder gzip-compressed, in place. The
// app reads compressed files transparently and writes them on save, but
// existing bulk-converted corpora would only shrink as files are
// re-saved — so this migrates them in one pass. Properties:
//   - idempotent: already-gzip files are skipped (re-runnable, mixed
//     folders fine);
//   - lossless: each rewrite is inflated and compared to the original
//     before the destructive replace;
//   - atomic: temp file + rename, so an interrupt can't corrupt a file;
//   - mtime-preserving: restores each file's mtime so the command bar's
//     recency ordering isn't disturbed.
// Runs in main (not the renderer like bulk-convert) to avoid streaming
// the whole corpus across IPC and to get atomic rename + utimes.
interface BulkCompressSummary {
  total: number;
  compressed: number;
  skipped: number;
  failed: number;
  bytesBefore: number;
  bytesAfter: number;
}

// zlib on libuv's thread pool: the sync variants would block the main
// process's event loop for the duration of each file's deflate +
// inflate-verify, stalling every window's IPC (saves, journal writes,
// menus, dialogs) for the whole bulk run.
const gzip = promisify(zlibGzip);
const gunzip = promisify(zlibGunzip);

ipcMain.handle(
  'host:bulk-compress',
  async (event, dir: string): Promise<BulkCompressSummary> => {
    if (typeof dir !== 'string' || !dir) throw new Error('bulk-compress: no folder');

    const files: string[] = [];
    async function walk(cur: string): Promise<void> {
      let entries;
      try {
        entries = await fs.readdir(cur, { withFileTypes: true });
      } catch {
        return; // unreadable dir — skip
      }
      for (const ent of entries) {
        const full = path.join(cur, ent.name);
        if (ent.isDirectory()) await walk(full);
        else if (ent.isFile() && ent.name.toLowerCase().endsWith('.cmir')) files.push(full);
      }
    }
    await walk(dir);

    const summary: BulkCompressSummary = {
      total: files.length,
      compressed: 0,
      skipped: 0,
      failed: 0,
      bytesBefore: 0,
      bytesAfter: 0,
    };
    const sender = event.sender;
    let lastSent = 0;
    const sendProgress = (force = false): void => {
      const now = Date.now();
      if (!force && now - lastSent < 100) return;
      lastSent = now;
      if (!sender.isDestroyed()) {
        sender.send('host:bulk-compress:progress', {
          done: summary.compressed + summary.skipped + summary.failed,
          ...summary,
        });
      }
    };

    for (const file of files) {
      try {
        const buf = await fs.readFile(file);
        summary.bytesBefore += buf.length;
        // Already compressed (gzip magic) → leave it, count as skipped.
        if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
          summary.skipped++;
          summary.bytesAfter += buf.length;
          sendProgress();
          continue;
        }
        const gz = await gzip(buf, { level: 6 });
        // Verify losslessness before the destructive replace.
        if (Buffer.compare(await gunzip(gz), buf) !== 0) {
          throw new Error('compression verification failed');
        }
        const st = await fs.stat(file);
        const tmp = `${file}.compress-tmp`;
        await fs.writeFile(tmp, gz);
        try {
          await fs.rename(tmp, file); // atomic on POSIX/Windows same-volume
        } catch (err) {
          await fs.unlink(tmp).catch(() => {});
          throw err;
        }
        // Restore the original mtime so recency sorting isn't disturbed.
        await fs.utimes(file, st.atime, st.mtime).catch(() => {});
        // In-app rewrite (mtime restored but SIZE changed) — refresh the
        // changed-on-disk baseline so an open doc in this folder doesn't
        // get a false conflict prompt on its next save.
        await recordDiskStateFromDisk(file, gz);
        summary.compressed++;
        summary.bytesAfter += gz.length;
      } catch (err) {
        summary.failed++;
        console.error('bulk-compress failed for', file, err);
      }
      sendProgress();
    }
    sendProgress(true);
    return summary;
  },
);

// ── File-index service (command-palette file search) ────────────────
// The index + search live in a utilityProcess (file-index-service.ts —
// see file-index-core.ts for the why): the browser process only forks
// the service and forwards one MessagePort per renderer, then stays out
// of the loop. Lazy: forked on the first port request, respawned on the
// next request if it dies.
let fileIndexService: Electron.UtilityProcess | null = null;

function ensureFileIndexService(): Electron.UtilityProcess {
  if (fileIndexService) return fileIndexService;
  const svc = utilityProcess.fork(path.join(__dirname, 'file-index-service.cjs'), [], {
    serviceName: 'cardmirror-file-index',
    env: { ...process.env, CM_INDEX_DATA_DIR: app.getPath('userData') },
  });
  svc.on('exit', () => {
    if (fileIndexService === svc) fileIndexService = null;
  });
  fileIndexService = svc;
  return svc;
}

// Renderer asks for its direct line to the service. A fresh channel per
// request: port1 goes to the service, port2 back to the renderer (the
// preload forwards it into the main world).
ipcMain.on('host:file-index-port', (event) => {
  const { port1, port2 } = new MessageChannelMain();
  ensureFileIndexService().postMessage({ type: 'port' }, [port1]);
  event.sender.postMessage('host:file-index-port', null, [port2]);
});

ipcMain.handle(
  'host:write-file-at-path',
  async (
    _event,
    filePath: string,
    bytes: unknown,
    opts?: { failIfExists?: boolean },
  ) => {
    if (typeof filePath !== 'string' || !filePath) {
      throw new Error('write-file-at-path: no path');
    }
    // mkdir: bulk convert writes into a destination folder, preserving
    // the input's subfolder structure. failIfExists is opt-in — only
    // the new-speech-doc auto-save asks for it; bulk convert still
    // overwrites by design. The check lives inside saveNewDoc's write
    // chain (not here) so it can't race a concurrent create.
    try {
      await saveNewDoc(filePath, bytesToBuffer(bytes), {
        mkdir: true,
        failIfExists: opts?.failIfExists,
      });
    } catch (err) {
      // The 'collision' sentinel lets the renderer defer to Save As —
      // same contract as host:save-send-doc below. Real write
      // failures keep throwing.
      if (err instanceof DocExistsError) return 'collision';
      throw err;
    }
    return undefined;
  },
);

ipcMain.handle(
  'host:save-as',
  async (
    event,
    suggestedName: string,
    bytes: unknown,
    opts: { filters?: FileFilter[]; nearPath?: string },
  ) => {
    const win = ownerWindow(event.sender);
    // Open the dialog next to the doc's own path when we have one: its
    // folder while the path is intact, or (Word-style) the nearest
    // surviving ancestor after a rename/move broke it — so the
    // stale-path rescue lands the user beside wherever the file went.
    // No nearPath (or nothing on its chain exists) → bare filename,
    // i.e. the OS's last-used-directory default, as before.
    let defaultPath = suggestedName;
    if (typeof opts?.nearPath === 'string' && opts.nearPath) {
      const dir = await nearestExistingDir(opts.nearPath);
      if (dir) defaultPath = path.join(dir, suggestedName);
    }
    const result = await dialog.showSaveDialog(win ?? new BrowserWindow({ show: false }), {
      defaultPath,
      filters: opts?.filters?.length ? opts.filters : [],
    });
    if (result.canceled || !result.filePath) return null;
    await saveNewDoc(result.filePath, bytesToBuffer(bytes));
    grantReadPath(result.filePath); // a saved file is reopenable by path
    return {
      name: path.basename(result.filePath),
      handle: result.filePath,
    };
  },
);

// Silent "Save Send Doc" / "Save Marked Cards" write. The renderer has already
// resolved the destination (a fixed folder, or the source file's own folder),
// the final filename, AND passes the source document's own path as
// `siblingHandle`; main joins, guards against clobbering the source, and
// writes. Returns the literal string 'collision' whenever the resolved target
// would overwrite the source document — in EITHER destination mode (e.g. a
// custom/empty prefix at the same folder + format, or a fixed folder that
// happens to contain the source) — so the renderer can defer to the Save As
// dialog instead.
ipcMain.handle(
  'host:save-send-doc',
  async (
    _event,
    opts: { folder: string | null; siblingHandle: string | null; filename: string },
    bytes: unknown,
  ) => {
    const dir = opts.folder ?? (opts.siblingHandle ? path.dirname(opts.siblingHandle) : null);
    if (!dir) return null;
    const target = path.join(dir, opts.filename);
    if (opts.siblingHandle && path.resolve(target) === path.resolve(opts.siblingHandle)) {
      return 'collision';
    }
    await saveNewDoc(target, bytesToBuffer(bytes), { mkdir: true });
    return { name: path.basename(target), handle: target };
  },
);

ipcMain.handle(
  'host:save-existing',
  async (_event, handle: string, bytes: unknown, opts?: { force?: boolean }) => {
    if (typeof handle !== 'string' || handle.length === 0) {
      throw new Error('host:save-existing: handle must be a non-empty path string.');
    }
    // Throws ENOENT when the file was renamed/deleted out from under
    // us (→ the renderer's Save-As rescue) and an EMODIFIED-marked
    // error when it changed on disk since we last read/wrote it
    // (→ the renderer's overwrite / Save As / cancel prompt, whose
    // "Overwrite" choice retries with force). See doc-writes.ts.
    await saveExistingDoc(handle, bytesToBuffer(bytes), { force: opts?.force === true });
  },
);

// ─── Crash-recovery journals ───────────────────────────────────────
// Each open doc gets one journal file at
//   {userData}/journals/{uid}.cmir-journal
// containing a small JSON envelope plus the doc bytes as base64.
// Written debounced after every doc-changing edit; cleared on save
// or explicit close; scanned at startup so a crash gets surfaced
// to the user as a recovery offer.

interface JournalEntryIpc {
  uid: string;
  filename: string;
  handle: string | null;
  format: 'cmir' | 'docx' | null;
  savedAt: string;
  /** Original journal savedAt when the doc descends from a recovered,
   *  not-yet-manually-saved draft — the stale-overwrite guard's baseline.
   *  Passed through opaquely. */
  recoveredFromSavedAt?: string;
  bytes: unknown;
}

function journalsDir(): string {
  return path.join(app.getPath('userData'), 'journals');
}

function journalPathFor(uid: string): string {
  // Sanitize uid → filename. UIDs are app-generated so they're
  // already safe (alphanumeric + dashes), but a strict filter
  // defends against future formats.
  const safe = uid.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(journalsDir(), `${safe}.cmir-journal`);
}

async function ensureJournalsDir(): Promise<void> {
  await fs.mkdir(journalsDir(), { recursive: true });
}

// Per-uid serialization tail. The renderer can dispatch two
// `host:write-journal` invokes for the same uid in quick
// succession (e.g. a debounced edit-driven write still in flight
// when the mode-switch path fires `journalAll`). Two raw
// `fs.writeFile` calls to the same path then race: the kernel
// extends the file to fit whichever write's tail comes second,
// producing a JSON-then-garbage file that the recovery reader
// throws out as corrupt. Chaining writes for a given uid onto
// the previous one's settle keeps the on-disk file always valid.
const journalWriteTails = new Map<string, Promise<void>>();

ipcMain.handle('host:write-journal', (_event, entry: JournalEntryIpc) => {
  if (!entry || typeof entry.uid !== 'string' || !entry.uid) {
    throw new Error('host:write-journal: entry.uid is required.');
  }
  const previous = journalWriteTails.get(entry.uid) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    await ensureJournalsDir();
    const buf = bytesToBuffer(entry.bytes);
    // Wrap the doc bytes in a small JSON envelope so the file is
    // self-describing. base64 the doc bytes (cmir JSON text → b64 →
    // ASCII string we can stick inside the outer JSON). Slight size
    // overhead but keeps the file fully readable / inspectable.
    const envelope = {
      uid: entry.uid,
      filename: entry.filename,
      handle: entry.handle,
      format: entry.format,
      savedAt: entry.savedAt,
      ...(typeof entry.recoveredFromSavedAt === 'string'
        ? { recoveredFromSavedAt: entry.recoveredFromSavedAt }
        : {}),
      bytesB64: buf.toString('base64'),
    };
    // Atomic write: stage into a sibling .tmp file then rename
    // over the real path. fs.rename is atomic on POSIX, so a
    // crash mid-write can't leave a half-written real journal,
    // and a concurrent reader either sees the previous valid
    // file or the new one — never a torn mix.
    const finalPath = journalPathFor(entry.uid);
    const tmpPath = `${finalPath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(envelope));
    await fs.rename(tmpPath, finalPath);
  });
  journalWriteTails.set(entry.uid, next);
  // GC the chain entry when this write settles, so the map
  // doesn't grow forever across long sessions. Only clear if
  // we're still the tail — a later write may have already
  // chained onto us.
  void next.finally(() => {
    if (journalWriteTails.get(entry.uid) === next) {
      journalWriteTails.delete(entry.uid);
    }
  });
  return next;
});

ipcMain.handle('host:read-journals', async () => {
  let entries: string[];
  try {
    entries = await fs.readdir(journalsDir());
  } catch (err) {
    // Dir doesn't exist yet → no journals to read.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const results: JournalEntryIpc[] = [];
  for (const name of entries) {
    if (!name.endsWith('.cmir-journal')) continue;
    const fullPath = path.join(journalsDir(), name);
    try {
      const text = await fs.readFile(fullPath, 'utf8');
      const parsed = JSON.parse(text);
      if (typeof parsed?.uid !== 'string' || typeof parsed?.bytesB64 !== 'string') continue;
      results.push({
        uid: parsed.uid,
        filename: typeof parsed.filename === 'string' ? parsed.filename : 'Untitled',
        handle: typeof parsed.handle === 'string' ? parsed.handle : null,
        format: parsed.format === 'cmir' || parsed.format === 'docx' ? parsed.format : null,
        savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : new Date(0).toISOString(),
        ...(typeof parsed.recoveredFromSavedAt === 'string'
          ? { recoveredFromSavedAt: parsed.recoveredFromSavedAt }
          : {}),
        bytes: new Uint8Array(Buffer.from(parsed.bytesB64, 'base64')),
      });
    } catch (err) {
      // Skip corrupt journal files rather than blocking startup.
      console.warn(`Skipping corrupt journal ${name}:`, err);
    }
  }
  return results;
});

ipcMain.handle('host:delete-journal', async (_event, uid: string) => {
  if (typeof uid !== 'string' || !uid) return;
  try {
    await fs.unlink(journalPathFor(uid));
  } catch (err) {
    // Already gone is fine.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
});

// ─── Collab session history ({roomId}.cmir-history) ────────────────
// Sibling of the crash journals, in the same folder, with a distinct
// extension so the crash-recovery scanner above never offers one as a
// recovery candidate. Written continuously during a collab session and
// RETAINED after it ends (including a remote tombstone) — the durable
// record behind Recover Previous Version. Unlike journals there is no
// natural clear point, so retention is explicit: age + total-size
// pruning on startup and hourly.

const HISTORY_EXTENSION = '.cmir-history';
const HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const HISTORY_MAX_TOTAL_BYTES = 500 * 1024 * 1024;

interface HistoryEnvelopeIpc {
  v: 1;
  roomId: string;
  docTitle: string;
  startedAt: number;
  updatedAt: number;
  changeTimes: { peer: string; counter: number; at: number }[];
  snapshotB64: string;
}

/** Write-side IPC shape: raw snapshot bytes. Encoding happens HERE —
 *  Buffer's native base64 costs ~2ms where the renderer's JS encoder
 *  cost 463ms per write on a 20 MB tournament master. */
interface HistoryWriteIpc {
  v: 1;
  roomId: string;
  docTitle: string;
  startedAt: number;
  updatedAt: number;
  changeTimes: { peer: string; counter: number; at: number }[];
  snapshot: unknown;
}

function historyPathFor(roomId: string): string {
  // Room ids are relay-minted, but sanitize like journalPathFor does —
  // this string becomes a filename.
  const safe = roomId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(journalsDir(), `${safe}${HISTORY_EXTENSION}`);
}

function parseHistoryEnvelope(text: string): HistoryEnvelopeIpc | null {
  try {
    const p = JSON.parse(text) as Partial<HistoryEnvelopeIpc>;
    if (
      p?.v !== 1 ||
      typeof p.roomId !== 'string' ||
      !p.roomId ||
      typeof p.snapshotB64 !== 'string' ||
      !p.snapshotB64 ||
      typeof p.startedAt !== 'number' ||
      typeof p.updatedAt !== 'number' ||
      !Array.isArray(p.changeTimes)
    ) {
      return null;
    }
    return {
      v: 1,
      roomId: p.roomId,
      docTitle: typeof p.docTitle === 'string' ? p.docTitle : 'Untitled',
      startedAt: p.startedAt,
      updatedAt: p.updatedAt,
      changeTimes: p.changeTimes.filter(
        (t): t is { peer: string; counter: number; at: number } =>
          typeof t?.peer === 'string' && typeof t?.counter === 'number' && typeof t?.at === 'number',
      ),
      snapshotB64: p.snapshotB64,
    };
  } catch {
    return null;
  }
}

// Same per-key write chain as journals: two in-flight writes to one
// path otherwise race into a valid-JSON-then-garbage file.
const historyWriteTails = new Map<string, Promise<void>>();

ipcMain.handle('host:write-history', (_event, entry: HistoryWriteIpc) => {
  if (!entry || entry.v !== 1 || typeof entry.roomId !== 'string' || !entry.roomId) {
    throw new Error('host:write-history: a v1 envelope with roomId is required.');
  }
  const snapshot = bytesToBuffer(entry.snapshot);
  if (snapshot.length === 0) {
    throw new Error('host:write-history: snapshot bytes are required.');
  }
  const previous = historyWriteTails.get(entry.roomId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    await ensureJournalsDir();
    const envelope: HistoryEnvelopeIpc = {
      v: 1,
      roomId: entry.roomId,
      docTitle: entry.docTitle,
      startedAt: entry.startedAt,
      updatedAt: entry.updatedAt,
      changeTimes: entry.changeTimes,
      snapshotB64: snapshot.toString('base64'),
    };
    const finalPath = historyPathFor(entry.roomId);
    const tmpPath = `${finalPath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(envelope));
    await fs.rename(tmpPath, finalPath);
  });
  historyWriteTails.set(entry.roomId, next);
  void next.finally(() => {
    if (historyWriteTails.get(entry.roomId) === next) {
      historyWriteTails.delete(entry.roomId);
    }
  });
  return next;
});

ipcMain.handle('host:list-history', async () => {
  let entries: string[];
  try {
    entries = await fs.readdir(journalsDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const rows: { roomId: string; docTitle: string; startedAt: number; updatedAt: number; sizeBytes: number }[] = [];
  for (const name of entries) {
    if (!name.endsWith(HISTORY_EXTENSION)) continue;
    const fullPath = path.join(journalsDir(), name);
    try {
      const text = await fs.readFile(fullPath, 'utf8');
      const env = parseHistoryEnvelope(text);
      if (!env) continue;
      rows.push({
        roomId: env.roomId,
        docTitle: env.docTitle,
        startedAt: env.startedAt,
        updatedAt: env.updatedAt,
        sizeBytes: Buffer.byteLength(text),
      });
    } catch (err) {
      console.warn(`Skipping unreadable history file ${name}:`, err);
    }
  }
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return rows;
});

ipcMain.handle(
  'host:read-history',
  async (_event, target: { roomId?: string; path?: string }) => {
    const fullPath =
      typeof target?.path === 'string' && target.path
        ? target.path
        : typeof target?.roomId === 'string' && target.roomId
          ? historyPathFor(target.roomId)
          : null;
    if (!fullPath) throw new Error('host:read-history: roomId or path is required.');
    try {
      return parseHistoryEnvelope(await fs.readFile(fullPath, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  },
);

ipcMain.handle('host:delete-history', async (_event, roomId: string) => {
  if (typeof roomId !== 'string' || !roomId) return;
  try {
    await fs.unlink(historyPathFor(roomId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
});

/** "Recover from file…": native picker opened AT the journals folder,
 *  filtered to history files. Returns the picked absolute path. */
ipcMain.handle('host:pick-history-file', async (event) => {
  await ensureJournalsDir();
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win ?? BrowserWindow.getAllWindows()[0]!, {
    defaultPath: journalsDir(),
    filters: [{ name: 'CardMirror session history', extensions: ['cmir-history'] }],
    properties: ['openFile'],
  });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]!;
});

/** Age + total-size pruning. Age first (30 days), then oldest-first
 *  until under the total cap — the cap is a runaway guard (a history
 *  file is ~2x its document's text; only heavy reorganizing sessions
 *  get big, ~125 KiB of permanent oplog per long card move). */
async function pruneHistoryFiles(): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(journalsDir());
  } catch {
    return; // No folder yet → nothing to prune.
  }
  const files: { path: string; mtimeMs: number; size: number }[] = [];
  for (const name of entries) {
    if (!name.endsWith(HISTORY_EXTENSION)) continue;
    const fullPath = path.join(journalsDir(), name);
    try {
      const st = await fs.stat(fullPath);
      files.push({ path: fullPath, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      /* raced a delete — skip */
    }
  }
  const now = Date.now();
  const kept: typeof files = [];
  for (const f of files) {
    if (now - f.mtimeMs > HISTORY_MAX_AGE_MS) {
      await fs.unlink(f.path).catch(() => {});
    } else {
      kept.push(f);
    }
  }
  kept.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
  let total = kept.reduce((n, f) => n + f.size, 0);
  for (const f of kept) {
    if (total <= HISTORY_MAX_TOTAL_BYTES) break;
    await fs.unlink(f.path).catch(() => {});
    total -= f.size;
  }
}

void app.whenReady().then(() => {
  void pruneHistoryFiles();
  const timer = setInterval(() => void pruneHistoryFiles(), 60 * 60 * 1000);
  timer.unref?.();
});

// ─── Learn store (local annotation layer) — whole-blob KV ──────────
function learnStorePath(): string {
  return path.join(app.getPath('userData'), 'learn-store.json');
}

ipcMain.handle('host:read-learn-store', async (): Promise<string | null> => {
  try {
    return await fs.readFile(learnStorePath(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    console.warn('Failed to read learn-store.json:', err);
    return null;
  }
});

// Serialize writes (tmp → atomic rename) so quick consecutive saves can't
// tear the file — same discipline as the journal / quick-cards writers.
let learnStoreWriteTail: Promise<void> = Promise.resolve();
ipcMain.handle('host:write-learn-store', (_event, json: string) => {
  if (typeof json !== 'string') return learnStoreWriteTail;
  learnStoreWriteTail = learnStoreWriteTail.catch(() => {}).then(async () => {
    const finalPath = learnStorePath();
    const tmpPath = `${finalPath}.tmp`;
    await fs.writeFile(tmpPath, json);
    await fs.rename(tmpPath, finalPath);
  });
  return learnStoreWriteTail;
});

// ─── Multi-window: spawn + initial-doc handshake ──────────────────
// Renderers in "windows mode" (multiDocWorkspace = false on
// Electron) call `host:spawn-window` to open a new BrowserWindow,
// optionally with an initial doc already loaded. The freshly-
// spawned window's renderer calls `host:get-initial-doc` once at
// boot to retrieve the payload (or `null` if it was just opened
// blank). Main owns the pending-map keyed by window id.

ipcMain.handle('host:spawn-window', async (_event, payload: InitialDocPayload | null) => {
  // `payload.bytes` may arrive as a Buffer / typed array depending on
  // the IPC transfer; stored as-is — the renderer normalizes at read
  // time.
  const newWin = createWindow(payload ?? undefined);
  // If the spawn carries an on-disk path, claim it for the new
  // window right away so a concurrent open in a third window
  // can't sneak in between spawn and the new window's mount.
  // The spawner doesn't claim in `runOpenFlow` for this path
  // (it isn't going to host the doc itself), so there's nothing
  // to transfer FROM — just claim for the new window directly.
  // (Stale-owner override handles the rare case where the path
  // was previously owned by a window that died without
  // releasing.)
  if (payload && typeof payload.handle === 'string' && payload.handle) {
    grantReadPath(payload.handle); // doc handed to a new window stays readable there
    const norm = canonicalOpenPath(payload.handle);
    const prevOwner = openPathOwners.get(norm);
    if (prevOwner !== undefined && prevOwner !== newWin.id) {
      windowOpenPaths.get(prevOwner)?.delete(norm);
    }
    openPathOwners.set(norm, newWin.id);
    let set = windowOpenPaths.get(newWin.id);
    if (!set) {
      set = new Set();
      windowOpenPaths.set(newWin.id, set);
    }
    set.add(norm);
  }
});

ipcMain.handle('host:get-initial-doc', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  const payload = pendingInitialDocs.get(win.id);
  if (!payload) return null;
  pendingInitialDocs.delete(win.id);
  return payload;
});

// The renderer reports its workspace mode at boot (and re-reports on
// the reload a mode toggle triggers) so the OS-open path knows which
// windows can take a file into their slot picker.
ipcMain.handle('host:register-multipane', async (event, isMultiPane: boolean) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (isMultiPane) multiPaneWindows.add(win.id);
  else multiPaneWindows.delete(win.id);
});

ipcMain.handle('host:is-first-window', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  return win.id === firstWindowId;
});

// ─── Mode-switch: journal-and-close other windows ─────────────────
// When the user toggles `multiDocWorkspace` in window A, every
// OTHER open window needs to journal its current doc and close
// before A reloads — so the post-reload recovery flow can pick up
// every doc and restore them in the new layout. Each renderer
// listens for `'mode-switch:please-close'`; on receipt it journals
// the current doc and calls `host:close-self`. We wait for the
// `closed` event on each before resolving, with a generous timeout
// fallback so a hung renderer doesn't strand the originating window.

const MODE_SWITCH_CLOSE_TIMEOUT_MS = 10000;

// True while a mode switch is closing the other windows. Backstop
// against two concurrent rounds: if two windows each initiated, each
// would treat the OTHER's surviving host as a window to close, so they
// would close each other and leave nothing open. The renderer gates
// the switch to the initiating window only (remote settings changes
// don't trigger it); this guard catches anything that slips past.
let modeSwitchInProgress = false;

// Docs journaled by the windows that close for a mode switch. Each
// closing renderer reports its {uid, dirty} list before close-self;
// the surviving window collects (and clears) the accumulated set
// after its reload so it can auto-reopen exactly the switch's docs
// — sessionStorage can't carry the closed windows' lists across.
let modeSwitchJournaledDocs: Array<{ uid: string; dirty: boolean }> = [];

ipcMain.handle('host:journal-and-close-other-windows', async (event) => {
  const sender = BrowserWindow.fromWebContents(event.sender);
  if (modeSwitchInProgress) return;
  modeSwitchInProgress = true;
  // Fresh round — drop reports left over from an earlier switch
  // whose surviving window never collected them.
  modeSwitchJournaledDocs = [];
  try {
  const others = BrowserWindow.getAllWindows().filter(
    (w) => w !== sender && !w.isDestroyed(),
  );
  await Promise.all(
    others.map(
      (w) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            // The renderer never closed itself in time: destroy()
            // skips its journal, so its doc is lost on reopen.
            if (!w.isDestroyed()) w.destroy();
            resolve();
          }, MODE_SWITCH_CLOSE_TIMEOUT_MS);
          w.once('closed', () => {
            clearTimeout(timer);
            resolve();
          });
          w.webContents.send('mode-switch:please-close');
        }),
    ),
  );
  } finally {
    modeSwitchInProgress = false;
  }
});

ipcMain.handle('host:close-self', async (event) => {
  const sender = BrowserWindow.fromWebContents(event.sender);
  if (sender && !sender.isDestroyed()) {
    // Mark this window as "already confirmed" so the close event
    // about to fire passes through the interception without
    // bouncing back to the renderer.
    skipCloseConfirm.add(sender.id);
    sender.close();
  }
});

// The renderer resolved a close-request WITHOUT closing (the user
// hit Cancel, or a Save/Save As failed). If that close-request was
// part of a quit, the window is staying open, so the quit is off —
// clear the intent flag. Otherwise a later ordinary window close
// would wrongly terminate the app on macOS instead of leaving it
// alive in the dock.
ipcMain.handle('host:close-cancelled', () => {
  quitInitiated = false;
});

ipcMain.handle(
  'host:mode-switch-journaled',
  (_event, docs: Array<{ uid: string; dirty: boolean }>) => {
    if (Array.isArray(docs)) modeSwitchJournaledDocs.push(...docs);
  },
);

ipcMain.handle('host:take-mode-switch-journaled', () => {
  const docs = modeSwitchJournaledDocs;
  modeSwitchJournaledDocs = [];
  return docs;
});

// ─── Speech-doc registry ──────────────────────────────────────────
// Cross-window state for "which open doc is the current send-to-
// speech destination." Tracked by uid so it survives windows
// coming and going (and so renderers, which can't share EditorView
// refs, can compare locally). Main also keeps a map of which docs
// live in which windows, so send-to-speech knows where to route
// the slice. Each renderer reports its own docs via host:doc-
// register / host:doc-unregister at mount / close.

interface SpeechRegistration {
  uid: string;
  windowId: number;
}
let speechRegistration: SpeechRegistration | null = null;
const docOwners = new Map<string, number>(); // uid → windowId
const windowDocs = new Map<number, Set<string>>(); // windowId → uid set

// ─── Cross-window duplicate-open guard ────────────────────────────
// Maps an open file's absolute path to the BrowserWindow.id that
// currently has it loaded. Renderers register a path after they
// finish loading a doc with an on-disk handle, and release it when
// the doc unmounts (close, replace, Save-As to a different path).
// At open-time, renderers query `host:open-path-claim` — if the
// path is already owned by ANOTHER window, main focuses that
// window and tells the caller to abort; otherwise the path is
// claimed for the caller. Window-close cleanup runs in the shared
// `browser-window-created → closed` listener below.
const openPathOwners = new Map<string, number>(); // canonical-path → windowId
const windowOpenPaths = new Map<number, Set<string>>(); // windowId → canonical-paths

/** Canonical form of `p` for use as a key in `openPathOwners`.
 *  `path.resolve` collapses `./` and `../`, expands the cwd for
 *  relative paths, and normalizes separators. Doesn't case-fold —
 *  Windows is technically case-insensitive but a same-case match
 *  is good enough for the duplicate-guard's purpose (the dialog
 *  always returns the same casing for a given file). */
function canonicalOpenPath(p: string): string {
  return path.resolve(p);
}

/** If a live window already owns `p`, focus (and un-minimize) it and
 *  return true. A stale entry (owner window gone) is cleaned up and
 *  the function returns false. Shared by the renderer-driven pre-open
 *  check (`host:open-path-check`) and the OS-open path
 *  (`openExternalFile`) so Finder / Dock / "Open with…" double-clicks
 *  get the SAME duplicate-open guard the in-app Open dialog does.
 *  `excludeWinId` lets a caller treat "already owned by me" as "free." */
function focusExistingOwner(p: string, excludeWinId?: number): boolean {
  const norm = canonicalOpenPath(p);
  const ownerId = openPathOwners.get(norm);
  if (ownerId === undefined || ownerId === excludeWinId) return false;
  const ownerWin = BrowserWindow.fromId(ownerId);
  if (!ownerWin || ownerWin.isDestroyed()) {
    openPathOwners.delete(norm);
    windowOpenPaths.get(ownerId)?.delete(norm);
    return false;
  }
  if (ownerWin.isMinimized()) ownerWin.restore();
  ownerWin.focus();
  return true;
}

/** Broadcast the current speech state to every window's renderer.
 *  Renderers reflect it in their UI (speech-mark button, etc.). */
function broadcastSpeechState(): void {
  const payload = speechRegistration
    ? { uid: speechRegistration.uid }
    : { uid: null };
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('speech:changed', payload);
  }
}

/** Per-uid display info pushed by renderers. Lets the
 *  Select-Speech-Doc modal (and any future cross-window doc
 *  picker) show meaningful labels for each open doc without
 *  having to query each window individually. Filename can be
 *  null for unsaved docs. */
const docInfo: Map<string, { filename: string | null }> = new Map();

ipcMain.handle('host:doc-register', async (event, uid: string) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || typeof uid !== 'string' || !uid) return;
  docOwners.set(uid, win.id);
  let set = windowDocs.get(win.id);
  if (!set) {
    set = new Set();
    windowDocs.set(win.id, set);
  }
  set.add(uid);
});

ipcMain.handle('host:doc-unregister', async (event, uid: string) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || typeof uid !== 'string' || !uid) return;
  docOwners.delete(uid);
  docInfo.delete(uid);
  windowDocs.get(win.id)?.delete(uid);
  // If the speech doc just got unregistered, clear the global flag
  // and notify everyone.
  if (speechRegistration?.uid === uid) {
    speechRegistration = null;
    broadcastSpeechState();
  }
});

/** Renderer pushes a uid's display info (currently just filename;
 *  the type is open for future fields). Called on doc mount and
 *  whenever the filename changes (save, save-as, rename). */
ipcMain.handle(
  'host:doc-info-update',
  async (
    _event,
    payload: { uid: string; filename: string | null },
  ) => {
    if (!payload || typeof payload.uid !== 'string' || !payload.uid) return;
    docInfo.set(payload.uid, {
      filename: typeof payload.filename === 'string' ? payload.filename : null,
    });
  },
);

/** List every open doc across every window. The Select Speech Doc
 *  modal calls this to populate its row list. Stale entries
 *  (windowless uids) are filtered out so the modal never offers
 *  a target that no longer has a home. */
ipcMain.handle('host:list-docs', async (event) => {
  const senderWin = BrowserWindow.fromWebContents(event.sender);
  const senderId = senderWin ? senderWin.id : -1;
  const focusedWin = BrowserWindow.getFocusedWindow();
  const focusedId = focusedWin ? focusedWin.id : -1;
  const out: Array<{
    uid: string;
    filename: string | null;
    windowId: number;
    windowTitle: string;
    isSpeech: boolean;
    isOwnWindow: boolean;
    isFocusedWindow: boolean;
  }> = [];
  for (const [uid, windowId] of docOwners.entries()) {
    const win = BrowserWindow.fromId(windowId);
    if (!win || win.isDestroyed()) continue;
    const info = docInfo.get(uid);
    out.push({
      uid,
      filename: info?.filename ?? null,
      windowId,
      windowTitle: win.getTitle(),
      isSpeech: speechRegistration?.uid === uid,
      isOwnWindow: windowId === senderId,
      isFocusedWindow: windowId === focusedId,
    });
  }
  return out;
});

// ─── Dropzone shelf (cross-window scratch space) ───────────────────
// Renderers drop slice content here; main keeps the list in memory
// and broadcasts every change so every window's bubble stays in
// sync. Cleared on app restart per spec (no disk persistence).

interface DropzoneItem {
  id: string;
  label: string;
  type: string;
  sliceJson: unknown;
  createdAt: number;
}

let dropzoneItems: DropzoneItem[] = [];

function broadcastDropzoneState(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('dropzone:changed', dropzoneItems);
  }
}

ipcMain.handle('host:dropzone-list', async () => dropzoneItems);

ipcMain.handle('host:dropzone-add', async (_event, item: DropzoneItem) => {
  if (!item || typeof item.id !== 'string' || !item.id) return;
  // De-dup by id — re-adding the same id moves it to the end (most
  // recent), which is the natural "use this again" semantics.
  dropzoneItems = dropzoneItems.filter((x) => x.id !== item.id);
  dropzoneItems.push(item);
  broadcastDropzoneState();
});

ipcMain.handle('host:dropzone-remove', async (_event, id: string) => {
  if (typeof id !== 'string' || !id) return;
  const next = dropzoneItems.filter((x) => x.id !== id);
  if (next.length === dropzoneItems.length) return;
  dropzoneItems = next;
  broadcastDropzoneState();
});

ipcMain.handle('host:dropzone-clear', async () => {
  if (dropzoneItems.length === 0) return;
  dropzoneItems = [];
  broadcastDropzoneState();
});

// ─── Quick Cards (persistent, cross-window snippet library) ────────
// Renderers add/edit named rich-text snippets; main keeps the
// canonical list in memory, persists it to
// `{userData}/quick-cards.json`, and broadcasts every change so every
// window stays in sync. Unlike the dropzone, this DOES persist across
// app restarts.

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

let quickCards: QuickCardIpc[] = [];
let quickCardsLoaded = false;

function quickCardsPath(): string {
  return path.join(app.getPath('userData'), 'quick-cards.json');
}

/** Lazy one-time load from disk. Every handler awaits this first so
 *  the first mutation of a session doesn't clobber a saved library. */
async function ensureQuickCardsLoaded(): Promise<void> {
  if (quickCardsLoaded) return;
  quickCardsLoaded = true;
  try {
    const text = await fs.readFile(quickCardsPath(), 'utf8');
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.cards)) {
      quickCards = parsed.cards.filter(
        (c: unknown): c is QuickCardIpc =>
          !!c && typeof c === 'object' && typeof (c as QuickCardIpc).id === 'string',
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('Failed to read quick-cards.json:', err);
    }
    quickCards = [];
  }
}

// Serialize writes (tmp → atomic rename) so two quick mutations can't
// race to a torn file — same discipline as the journal writer.
let quickCardsWriteTail: Promise<void> = Promise.resolve();
function persistQuickCards(): Promise<void> {
  const snapshot = quickCards;
  quickCardsWriteTail = quickCardsWriteTail.catch(() => {}).then(async () => {
    const finalPath = quickCardsPath();
    const tmpPath = `${finalPath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify({ version: 1, cards: snapshot }));
    await fs.rename(tmpPath, finalPath);
  });
  return quickCardsWriteTail;
}

function broadcastQuickCardsState(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('quick-cards:changed', quickCards);
  }
}

ipcMain.handle('host:quick-cards-list', async () => {
  await ensureQuickCardsLoaded();
  return quickCards;
});

ipcMain.handle('host:quick-cards-upsert', async (_event, card: QuickCardIpc) => {
  if (!card || typeof card.id !== 'string' || !card.id) return;
  await ensureQuickCardsLoaded();
  // De-dup by id — upsert covers both new-card adds and edits.
  quickCards = [...quickCards.filter((c) => c.id !== card.id), card];
  broadcastQuickCardsState();
  await persistQuickCards();
});

ipcMain.handle('host:quick-cards-bulk-upsert', async (_event, cards: QuickCardIpc[]) => {
  if (!Array.isArray(cards)) return;
  await ensureQuickCardsLoaded();
  const incoming = new Map(
    cards.filter((c) => c && typeof c.id === 'string' && c.id).map((c) => [c.id, c]),
  );
  if (incoming.size === 0) return;
  quickCards = [...quickCards.filter((c) => !incoming.has(c.id)), ...incoming.values()];
  broadcastQuickCardsState();
  await persistQuickCards();
});

ipcMain.handle('host:quick-cards-remove', async (_event, id: string) => {
  if (typeof id !== 'string' || !id) return;
  await ensureQuickCardsLoaded();
  const next = quickCards.filter((c) => c.id !== id);
  if (next.length === quickCards.length) return;
  quickCards = next;
  broadcastQuickCardsState();
  await persistQuickCards();
});

ipcMain.handle('host:quick-cards-clear', async () => {
  await ensureQuickCardsLoaded();
  if (quickCards.length === 0) return;
  quickCards = [];
  broadcastQuickCardsState();
  await persistQuickCards();
});

// Pre-load duplicate-open check. Renderer calls this BEFORE
// loading a file from disk. If another window owns the path, we
// focus that window and tell the caller `takenByOther: true` so
// the caller can toast + abort. Otherwise `false` and the caller
// proceeds to mount the doc. This handler does NOT register —
// registration happens through `host:open-path-register` once
// the doc has actually mounted (the centralized
// `setCurrentDocHandle` helper in the renderer wires that up).
ipcMain.handle('host:open-path-check', async (event, p: string) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || typeof p !== 'string' || !p) return { takenByOther: false };
  // Focus the owning window (and clean up a stale entry) via the same
  // helper the OS-open path uses; `win.id` is excluded so "already
  // owned by me" reads as free.
  return { takenByOther: focusExistingOwner(p, win.id) };
});

// "Show in context" cross-window focus: if another window owns `p`,
// focus it AND send it the anchor so it scrolls to the card's text.
// Returns whether it was delivered (false ⇒ caller spawns a window).
ipcMain.handle(
  'host:focus-anchor-in-window',
  async (event, p: string, descriptor: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || typeof p !== 'string' || !p) return { delivered: false };
    const norm = canonicalOpenPath(p);
    const ownerId = openPathOwners.get(norm);
    if (ownerId === undefined || ownerId === win.id) return { delivered: false };
    const ownerWin = BrowserWindow.fromId(ownerId);
    if (!ownerWin || ownerWin.isDestroyed()) {
      openPathOwners.delete(norm);
      windowOpenPaths.get(ownerId)?.delete(norm);
      return { delivered: false };
    }
    if (ownerWin.isMinimized()) ownerWin.restore();
    ownerWin.focus();
    ownerWin.webContents.send('host:focus-anchor', { descriptor });
    return { delivered: true };
  },
);

// Register `p` as owned by the caller's window. Idempotent — if
// the caller already owns it, no-op. If another window owns it,
// we overwrite (the caller's pre-load check should have caught
// the conflict; this is best-effort for paths picked up via
// Save-As / recovery where no check happened).
ipcMain.handle('host:open-path-register', async (event, p: string) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || typeof p !== 'string' || !p) return;
  const norm = canonicalOpenPath(p);
  const prevOwner = openPathOwners.get(norm);
  if (prevOwner === win.id) return;
  if (prevOwner !== undefined) {
    windowOpenPaths.get(prevOwner)?.delete(norm);
  }
  openPathOwners.set(norm, win.id);
  let set = windowOpenPaths.get(win.id);
  if (!set) {
    set = new Set();
    windowOpenPaths.set(win.id, set);
  }
  set.add(norm);
});

// Release a previously-registered path. No-op if the caller
// doesn't own it (defensive — shouldn't happen in normal flow).
ipcMain.handle('host:open-path-release', async (event, p: string) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || typeof p !== 'string' || !p) return;
  const norm = canonicalOpenPath(p);
  const owner = openPathOwners.get(norm);
  if (owner !== win.id) return;
  openPathOwners.delete(norm);
  windowOpenPaths.get(win.id)?.delete(norm);
});

// Voice recognition service (SPEC-voice.md §12 item 2): session
// lifecycle + PCM-in / parse-events-out channels live in voice/ipc.ts.
registerVoiceIpc();

// Verbatim Flow bridge (Windows COM → Excel). No-ops off Windows.
registerFlowIpc();

// cardmirror-bridge plugin surface (plugin API v1): jump broadcast via
// the fast-paste bridge, plus flow-app discovery / POST relay from the
// shared handshake directory. Tokens never reach the renderer.
ipcMain.handle('host:plugin-jump', async (_event, source: string) => {
  if (typeof source !== 'string') return { ok: false, error: 'bad-request' };
  return broadcastJump(source);
});
ipcMain.handle('host:flow-apps', async () => scanFlowApps());
ipcMain.handle('host:flow-post', async (_event, appId: string, route: string, body: unknown) => {
  if (typeof appId !== 'string' || typeof route !== 'string') {
    return { ok: false, error: 'no-such-app' };
  }
  return flowPost(appId, route, body);
});

// Cross-machine card sharing — receive poller + send + inbox. Idle until
// the renderer sends `host:pairing-configure` with sharing enabled.
registerPairingIpc();
// The plugin installer's allowlist fetch rides the same relay (and the
// same self-hosted override) as pairing — a getter, so a settings change
// takes effect without a restart. The route itself is ungated.
setAllowlistRelayUrlSupplier(relayUrl);

ipcMain.handle('host:speech-set', async (event, uid: string | null) => {
  const senderWin = BrowserWindow.fromWebContents(event.sender);
  if (!senderWin) return;
  if (uid === null) {
    speechRegistration = null;
    broadcastSpeechState();
    return;
  }
  if (typeof uid !== 'string' || !uid) return;
  // Look up the OWNING window for this uid (which may not be the
  // sender's — the Select Speech Doc modal lets a renderer pick a
  // doc that lives in a different window). Fall back to the
  // sender's window if the uid isn't registered yet, which is the
  // legacy "Mark Active as Speech" path where caller == owner.
  const ownerId = docOwners.get(uid);
  const targetId = ownerId ?? senderWin.id;
  speechRegistration = { uid, windowId: targetId };
  broadcastSpeechState();
});

ipcMain.handle('host:speech-get', async () => {
  return speechRegistration ? { uid: speechRegistration.uid } : { uid: null };
});

/** Route a send-to-speech slice to whatever window owns the speech
 *  doc. Returns the result of the routing — caller cares whether
 *  the slice actually got applied vs. there's no speech doc / the
 *  speech doc's window has gone away. */
ipcMain.handle(
  'host:speech-send-slice',
  async (
    event,
    payload: { sliceJson: unknown; atEnd: boolean },
  ) => {
    const sender = BrowserWindow.fromWebContents(event.sender);
    if (!speechRegistration) return { delivered: false, reason: 'no-speech-doc' };
    const targetWin = BrowserWindow.fromId(speechRegistration.windowId);
    if (!targetWin || targetWin.isDestroyed()) {
      // Speech-doc's window vanished — drop the registration.
      speechRegistration = null;
      broadcastSpeechState();
      return { delivered: false, reason: 'speech-window-gone' };
    }
    // Same-window: tell the sender to handle it locally (cheaper +
    // avoids a round-trip).
    if (sender && targetWin === sender) {
      return { delivered: false, reason: 'same-window' };
    }
    targetWin.webContents.send('speech:incoming-slice', {
      uid: speechRegistration.uid,
      sliceJson: payload.sliceJson,
      atEnd: payload.atEnd,
    });
    return { delivered: true };
  },
);

// Clean up registrations when windows die without unregistering
// (force-close, crash, etc.).
app.on('browser-window-created', (_event, win) => {
  win.on('closed', () => {
    const docs = windowDocs.get(win.id);
    if (docs) {
      for (const uid of docs) docOwners.delete(uid);
      windowDocs.delete(win.id);
    }
    if (speechRegistration?.windowId === win.id) {
      speechRegistration = null;
      broadcastSpeechState();
    }
    // Release every open-path claim the window held — if the
    // window closed without releasing (force-quit, crash, etc.)
    // we'd otherwise leave stale entries blocking future opens.
    const paths = windowOpenPaths.get(win.id);
    if (paths) {
      for (const p of paths) openPathOwners.delete(p);
      windowOpenPaths.delete(win.id);
    }
    // Last window gone → let the next created window claim
    // first-window status (and with it the startup-recovery UI).
    // While other windows remain, firstness stays retired — a
    // window spawned mid-session must not offer to "recover" docs
    // that are open in those windows. The timer pop-out doesn't
    // count — it's chrome, not a document window, and it closes
    // itself right after the last doc window anyway.
    const remaining = BrowserWindow.getAllWindows().filter(
      (w) => !w.isDestroyed() && !isTimerWindow(w),
    );
    if (remaining.length === 0) {
      firstWindowId = null;
    }
  });
});

// ─── Native menu bar ───────────────────────────────────────────────

/** Send a menu-command IPC event to the currently focused window. */
function dispatchMenuCommand(command: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (!win) return;
  win.webContents.send('menu-command', command);
}

/** Current renderer-reported keybinding for each menu-bound ribbon
 *  command, in PM keymap form (`Mod-o`, `CmdOrCtrl+Alt+N`, etc.).
 *  Renderer pushes this map via `host:set-menu-bindings` whenever
 *  `ribbonKeyOverrides` changes; main rebuilds the application
 *  menu so accelerators stay in sync with the user's overrides. */
let menuBindings: Record<string, string | null> = {};

/** PM-keymap string ("Mod-o", "Shift-Mod-s", "Ctrl-ArrowLeft") to
 *  Electron accelerator ("CmdOrCtrl+O", "Shift+CmdOrCtrl+S",
 *  "Ctrl+Left"). Returns undefined when `key` is empty or null. */
function pmKeyToAccelerator(key: string | null | undefined): string | undefined {
  if (!key) return undefined;
  const parts = key.split('-');
  const out: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    switch (part) {
      case 'Mod': out.push('CmdOrCtrl'); break;
      case 'ArrowLeft': out.push('Left'); break;
      case 'ArrowRight': out.push('Right'); break;
      case 'ArrowUp': out.push('Up'); break;
      case 'ArrowDown': out.push('Down'); break;
      default:
        out.push(part.length === 1 ? part.toUpperCase() : part);
    }
  }
  return out.join('+');
}

/** Look up the current keybinding for a menu-bound command and
 *  format it as an Electron accelerator. Returns undefined when no
 *  binding is set — the menu item still appears, just without an
 *  accelerator hint on the right side. */
function menuAccelerator(commandId: string): string | undefined {
  return pmKeyToAccelerator(menuBindings[commandId]);
}

function buildMenu(): Menu {
  const isMac = process.platform === 'darwin';

  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      {
        label: 'Open…',
        accelerator: menuAccelerator('openFile'),
        click: () => dispatchMenuCommand('openFile'),
      },
      {
        label: 'New Document',
        accelerator: menuAccelerator('newDocument'),
        click: () => dispatchMenuCommand('newDocument'),
      },
      { type: 'separator' },
      {
        label: 'Save',
        accelerator: menuAccelerator('save'),
        click: () => dispatchMenuCommand('save'),
      },
      {
        label: 'Save As…',
        accelerator: menuAccelerator('saveAs'),
        click: () => dispatchMenuCommand('saveAs'),
      },
      { type: 'separator' },
      {
        label: 'Toggle Autosave',
        accelerator: menuAccelerator('toggleAutosave'),
        click: () => dispatchMenuCommand('toggleAutosave'),
      },
      { type: 'separator' },
      {
        // Smart close: in multi-pane mode, closes the visible doc in
        // the focused slot rather than the entire window. Falls
        // through to closing the window when there's no visible
        // doc to close. Cmd+W on macOS, Ctrl+W on Windows/Linux —
        // captured as an explicit menu accelerator so it overrides
        // Chromium's default close-window behavior.
        label: 'Close',
        accelerator: menuAccelerator('closeDocOrWindow') ?? 'CmdOrCtrl+W',
        click: () => dispatchMenuCommand('closeDocOrWindow'),
      },
      ...(!isMac ? [{ role: 'quit' as const }] : []),
    ],
  };

  const speechMenu: MenuItemConstructorOptions = {
    label: 'Speech',
    submenu: [
      {
        label: 'New Speech Document',
        accelerator: menuAccelerator('newSpeechDocument'),
        click: () => dispatchMenuCommand('newSpeechDocument'),
      },
      {
        label: 'Mark / Unmark Active as Speech Doc',
        accelerator: menuAccelerator('markActiveAsSpeech'),
        click: () => dispatchMenuCommand('markActiveAsSpeech'),
      },
      { type: 'separator' },
      {
        label: 'Send to Speech (At Cursor)',
        accelerator: menuAccelerator('sendToSpeechAtCursor'),
        click: () => dispatchMenuCommand('sendToSpeechAtCursor'),
      },
      {
        label: 'Send to Speech (At End)',
        accelerator: menuAccelerator('sendToSpeechAtEnd'),
        click: () => dispatchMenuCommand('sendToSpeechAtEnd'),
      },
      { type: 'separator' },
      {
        label: 'Select Speech Doc…',
        accelerator: menuAccelerator('selectSpeechDoc'),
        click: () => dispatchMenuCommand('selectSpeechDoc'),
      },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      // No Cmd/Ctrl+R accelerator on plain Reload: a stray Cmd+R mid-edit
      // reloads the renderer and reads like a crash / data loss. Intentional
      // reloads go via this click or Force Reload (Cmd+Shift+R), which is
      // unlikely to be hit by accident.
      { label: 'Reload', click: () => BrowserWindow.getFocusedWindow()?.webContents.reload() },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      // Zoom items route through OUR ribbon commands (chromeScale)
      // rather than Electron's native zoomIn/zoomOut roles, so the
      // accelerator labels match the user's actual bindings and
      // re-using the chord doesn't hit Chromium's own zoom.
      {
        label: 'Reset Zoom',
        accelerator: menuAccelerator('chromeScaleReset'),
        click: () => dispatchMenuCommand('chromeScaleReset'),
      },
      {
        label: 'Zoom In',
        accelerator: menuAccelerator('chromeScaleUp'),
        click: () => dispatchMenuCommand('chromeScaleUp'),
      },
      {
        label: 'Zoom Out',
        accelerator: menuAccelerator('chromeScaleDown'),
        click: () => dispatchMenuCommand('chromeScaleDown'),
      },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };

  const helpMenu: MenuItemConstructorOptions = {
    label: 'Help',
    submenu: [
      {
        label: 'Settings…',
        accelerator: menuAccelerator('openSettings'),
        click: () => dispatchMenuCommand('openSettings'),
      },
      {
        label: 'Keyboard Shortcuts…',
        accelerator: menuAccelerator('openShortcutsReference'),
        click: () => dispatchMenuCommand('openShortcutsReference'),
      },
      {
        label: 'User Manual',
        click: () => {
          void shell.openExternal(MANUAL_URL);
        },
      },
      {
        label: 'Privacy Policy',
        click: () => {
          void shell.openExternal(PRIVACY_URL);
        },
      },
      {
        label: 'Terms of Use',
        click: () => {
          void shell.openExternal(TERMS_URL);
        },
      },
      { type: 'separator' },
      {
        label: 'Check for Updates…',
        click: runManualUpdateCheck,
      },
      {
        label: 'Open Crash Dumps Folder',
        click: () => {
          void shell.openPath(app.getPath('crashDumps'));
        },
      },
    ],
  };

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    fileMenu,
    speechMenu,
    // Custom Edit menu — Electron's `role: 'editMenu'` defaults
    // Redo to Cmd/Ctrl+Shift+Z; we prefer the traditional Cmd/Ctrl+Y
    // and let the renderer's keymap accept both chords so muscle
    // memory keeps working either way.
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const, accelerator: 'CmdOrCtrl+Z' },
        { role: 'redo' as const, accelerator: 'CmdOrCtrl+Y' },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        ...(isMac
          ? [{ role: 'pasteAndMatchStyle' as const }, { role: 'delete' as const }]
          : [{ role: 'delete' as const }]),
        { type: 'separator' as const },
        { role: 'selectAll' as const },
      ],
    },
    viewMenu,
    // Standard macOS Window menu. Minimize routes through the RENDERER
    // command (not `role: 'minimize'`) so its accelerator follows user
    // rebinds via the same menuBindings rebuild as every other item.
    // Zoom is deliberately absent — the OS meaning (toggle window
    // frame size) collides with the app's own text-zoom commands and
    // would read as a broken duplicate. Bring All to Front is the
    // native role: standard, no accelerator.
    ...(isMac
      ? [
          {
            label: 'Window',
            submenu: [
              {
                label: 'Minimize',
                accelerator: menuAccelerator('minimizeWindow'),
                click: () => {
                  // Direct main-side minimize. Only the ACCELERATOR needs
                  // the rebinding machinery (menuAccelerator, main-side);
                  // the action touches no editor state, and routing it
                  // through the renderer added a main→renderer→main round
                  // trip that read as lag whenever the renderer was busy
                  // (feel-test, beta.21). The renderer command path still
                  // serves the palette and the Win/Linux keymap — single
                  // hop there. Also covers the timer pop-out for free.
                  BrowserWindow.getFocusedWindow()?.minimize();
                },
              },
              { type: 'separator' as const },
              { role: 'front' as const },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),
    helpMenu,
  ];

  return Menu.buildFromTemplate(template);
}

/** Renderer-driven menu rebuild. Stores the new bindings map and
 *  re-installs the application menu so the user's current
 *  keybindings (after rebinds via Settings → Keybindings) show
 *  next to each menu item. Idempotent — safe to call on every
 *  settings change. */
ipcMain.handle(
  'host:set-menu-bindings',
  async (_event, bindings: Record<string, string | null>) => {
    if (!bindings || typeof bindings !== 'object') return;
    menuBindings = { ...bindings };
    // No native menu on Windows/Linux: there it reserves Alt+<key> for menu
    // mnemonics, which swallows the editor's Alt shortcuts before they reach the
    // keymap. Every menu command's accelerator is also a ribbon keybinding
    // handled by the renderer, so dropping the bar loses no shortcut. macOS keeps
    // its expected global menu bar (where Option doesn't trigger mnemonics).
    Menu.setApplicationMenu(process.platform === 'darwin' ? buildMenu() : null);
  },
);

// ─── Auto-update ───────────────────────────────────────────────────
//
// electron-updater reads `app-update.yml` from inside the packaged
// app — electron-builder emits it as part of the release build with
// the GitHub Releases provider configured. In development (no
// `app.isPackaged`) the check is a no-op so we don't 404 against a
// missing config file. Failures are logged, never alerted.

/** Public GitHub Releases page — fallback link surfaced in update
 *  dialogs so users always have a manual-download path. */
const RELEASES_URL = 'https://github.com/ant981228/cardmirror/releases';

/** The user manual (MANUAL.md), rendered on GitHub. Linked from the Help
 *  menu so the full guide is one click away. */
const MANUAL_URL = 'https://github.com/ant981228/cardmirror/blob/main/MANUAL.md';

/** The privacy policy (PRIVACY.md), rendered on GitHub. Linked from the Help
 *  menu alongside the manual (and from Settings → General). */
const PRIVACY_URL = 'https://github.com/ant981228/cardmirror/blob/main/PRIVACY.md';

/** The terms of use (TERMS.md), rendered on GitHub. Linked from the Help menu
 *  alongside the manual and privacy policy (and from Settings → General). */
const TERMS_URL = 'https://github.com/ant981228/cardmirror/blob/main/TERMS.md';

/** Best-effort dialog-parent lookup. Prefers the focused window,
 *  but if the user has alt-tabbed away between clicking
 *  "Check for Updates" and the response arriving, falls back to the
 *  first available window. Returns `null` only when no windows
 *  exist at all (effectively never for the manual-check path). */
function dialogParentWindow(): BrowserWindow | null {
  // Never parent a dialog to the tiny timer float — pick a real
  // document window even when the float happens to hold focus.
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !isTimerWindow(focused)) return focused;
  return BrowserWindow.getAllWindows().find((w) => !isTimerWindow(w)) ?? null;
}

/** Re-entrancy guard. A single in-flight check guards the manual
 *  (Help menu) path AND the auto-launch IPC path so the two can't
 *  race and double-dialog if they happen to overlap. */
let updateCheckInFlight = false;

/** Show the "Update available" modal. Same content whether the
 *  check was manual or auto-launched — modal, parented to the
 *  current window, with an "Open release page" button that deep-
 *  links to the tag's GitHub Release in the user's browser via
 *  `shell.openExternal`. */
function showUpdateAvailableDialog(info: { version: string }): void {
  const win = dialogParentWindow();
  if (!win) return;
  // macOS installs that can't self-update (Gatekeeper-translocated
  // copies, unwritable /Applications) get pointed at the .dmg; every
  // other install — including mac since the swap updater — stages in
  // the background and installs from the status-bar chip.
  const macManual =
    process.platform === 'darwin' && !macBundleSelfUpdatable(app.getPath('exe'));
  // Self-installing platforms lead with OK — the chip owns the install
  // (install-on-confirm); the release page is a secondary escape hatch.
  // Only the can't-self-update mac case leads with the release page,
  // because there the download IS the action.
  const buttons = macManual ? ['Open release page', 'Close'] : ['OK', 'Open release page'];
  const openIdx = macManual ? 0 : 1;
  void dialog
    .showMessageBox(win, {
      type: 'info',
      buttons,
      defaultId: 0,
      cancelId: macManual ? 1 : 0,
      title: 'Update available',
      message: `CardMirror ${info.version} is available.`,
      detail: macManual
        ? "Open the release page to download the new .dmg and reinstall — this install can't update itself automatically."
        : 'Downloading in the background. When it finishes, a chip appears in the status bar — click it to restart into the update.',
    })
    .then((result) => {
      if (result.response === openIdx) {
        void shell.openExternal(`${RELEASES_URL}/tag/v${info.version}`);
      }
    });
}

/** Options gating which outcomes produce a user-facing dialog. The
 *  manual (Help menu) check shows all three; the auto-launch check
 *  shows only "available" — silent on "latest" (we don't want a
 *  dialog every launch when the user is current) and on "error"
 *  (offline-on-boot is too common to dialog about). */
interface UpdateCheckOpts {
  alertOnLatest: boolean;
  alertOnError: boolean;
  /** Manual checks dialog on "available"; the auto paths route to the
   *  status-bar update chip instead (install-on-confirm, 2026-07-16 —
   *  auto-updates never dialog). */
  alertOnAvailable: boolean;
}

/** Core update-check routine. Both the Help menu manual path and
 *  the renderer-driven auto-launch path call this. In-flight guard
 *  prevents the two from racing. `update-available` always fires
 *  `showUpdateAvailableDialog`; the latest / error dialogs are
 *  gated by `opts`. In dev (`!app.isPackaged`) shows an info
 *  dialog only for the manual path (`opts.alertOnLatest`); the
 *  auto-launch path is a complete no-op in dev. */
function runUpdateCheck(opts: UpdateCheckOpts): void {
  if (!app.isPackaged) {
    if (opts.alertOnLatest) {
      const win = dialogParentWindow();
      if (win) {
        void dialog.showMessageBox(win, {
          type: 'info',
          message: 'Update checks are only active in packaged builds.',
        });
      }
    }
    return;
  }
  if (updateCheckInFlight) return;
  updateCheckInFlight = true;

  // Mutual cleanup: whichever event fires first wins; the others
  // get unregistered so a single check produces one response and
  // doesn't fire stale handlers on a *later* check.
  const cleanup = (): void => {
    updateCheckInFlight = false;
    autoUpdater.off('update-not-available', onNotAvailable);
    autoUpdater.off('update-available', onAvailable);
    autoUpdater.off('error', onError);
  };

  const onNotAvailable = (): void => {
    cleanup();
    if (!opts.alertOnLatest) return;
    const win = dialogParentWindow();
    if (!win) return;
    void dialog.showMessageBox(win, {
      type: 'info',
      title: 'No updates',
      message: "You're on the latest version.",
      detail: `CardMirror ${app.getVersion()}`,
    });
  };

  const onAvailable = (info: { version: string }): void => {
    cleanup();
    if (opts.alertOnAvailable) {
      showUpdateAvailableDialog(info);
      return;
    }
    // Auto path: silent — the persistent handlers in startAutoUpdate own
    // staging and the chip on every platform.
  };

  const onError = (err: Error): void => {
    cleanup();
    if (!opts.alertOnError) return;
    const win = dialogParentWindow();
    if (!win) return;
    void dialog.showMessageBox(win, {
      type: 'warning',
      title: "Couldn't check for updates",
      message: "Couldn't check for updates.",
      detail: `${err.message || String(err)}\n\nYou can grab the latest build manually from:\n${RELEASES_URL}`,
    });
  };

  autoUpdater.once('update-not-available', onNotAvailable);
  autoUpdater.once('update-available', onAvailable);
  autoUpdater.once('error', onError);

  autoUpdater.checkForUpdates().catch((err: unknown) => {
    onError(err instanceof Error ? err : new Error(String(err)));
  });
}

/** Manual Help → Check for Updates click handler. Shows feedback
 *  for every possible outcome. */
function runManualUpdateCheck(): void {
  runUpdateCheck({ alertOnLatest: true, alertOnError: true, alertOnAvailable: true });
}

// ─── Floating timer pop-out window ───────────────────────────────────
// A small frameless always-on-top window running timer.html (its own
// tiny renderer entry). Its preload exposes exactly ONE call (window
// self-resize; timer-popout-preload.ts): timer state AND settings
// live in the origin's localStorage + BroadcastChannel, so the
// pop-out ticks and controls the shared timer with a near-zero host
// surface — least privilege. The renderer's shared `poppedOut` flag
// drives everything (main windows hide their panel; the pop-out
// closes itself when the flag clears); this side only owns the
// window's existence and the crash-path backstop broadcast.

let timerWindow: BrowserWindow | null = null;
/** Per-session position memory. Deliberately NOT persisted: the
 *  timer always launches popped-in (the boot reconciliation in the
 *  renderer), so a cross-launch position would be dead weight. */
let timerWindowPos: { x: number; y: number } | null = null;
/** The chrome-zoom factor the current float renders at — needed to
 *  map the pop-out's CSS-pixel content measurements to DIP when it
 *  asks to be resized (compact ↔ expanded reflow). */
let timerWindowZoom = 1;

/** Fallback dimensions when the opener didn't measure its panel
 *  (older renderer). Sized for the expanded panel at 100% zoom. */
const TIMER_WINDOW_FALLBACK_WIDTH = 300;
const TIMER_WINDOW_FALLBACK_HEIGHT = 64;
/** Breathing room around the measured panel content: the page adds
 *  0.5rem horizontal padding per side (16px total) and the panel
 *  centers vertically in the window. */
const TIMER_WINDOW_PAD_W = 20;
const TIMER_WINDOW_PAD_H = 14;

interface TimerPopoutOpts {
  contentWidth?: number;
  contentHeight?: number;
  zoomFactor?: number;
}

function isTimerWindow(w: BrowserWindow): boolean {
  return timerWindow !== null && w === timerWindow;
}

/** Close the pop-out when the last DOCUMENT window goes away — a
 *  lone floating timer must not keep the app alive on Windows/Linux
 *  (`window-all-closed` counts every BrowserWindow) or linger
 *  ownerless on macOS. Called from doc-window `closed` handlers. */
function closeTimerWindowIfOrphaned(): void {
  if (!timerWindow || timerWindow.isDestroyed()) return;
  const others = BrowserWindow.getAllWindows().filter(
    (w) => !w.isDestroyed() && !isTimerWindow(w),
  );
  if (others.length === 0) timerWindow.close();
}

function openTimerWindow(popoutOpts?: TimerPopoutOpts): void {
  if (timerWindow && !timerWindow.isDestroyed()) {
    timerWindow.showInactive();
    return;
  }
  // The opener measured its rendered panel in ITS CSS pixels; its
  // chrome zoom maps those to DIP. Applying the same zoom to the
  // pop-out (below) keeps the float's controls at the exact scale
  // the user's ribbon renders at — the pop-out itself has no host
  // surface to read the setting with.
  const zoom =
    typeof popoutOpts?.zoomFactor === 'number' &&
    Number.isFinite(popoutOpts.zoomFactor) &&
    popoutOpts.zoomFactor > 0.2 &&
    popoutOpts.zoomFactor < 5
      ? popoutOpts.zoomFactor
      : 1;
  const width =
    typeof popoutOpts?.contentWidth === 'number' && popoutOpts.contentWidth > 40
      ? Math.round(popoutOpts.contentWidth * zoom) + TIMER_WINDOW_PAD_W
      : TIMER_WINDOW_FALLBACK_WIDTH;
  const height =
    typeof popoutOpts?.contentHeight === 'number' && popoutOpts.contentHeight > 20
      ? Math.round(popoutOpts.contentHeight * zoom) + TIMER_WINDOW_PAD_H
      : TIMER_WINDOW_FALLBACK_HEIGHT;
  const opts: Electron.BrowserWindowConstructorOptions = {
    width,
    height,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: 'Timer — CardMirror',
    webPreferences: {
      // Minimal dedicated preload: exposes ONLY a resize call (see
      // timer-popout-preload.ts). Everything else the pop-out does
      // rides localStorage + BroadcastChannel.
      preload: path.join(__dirname, 'timer-popout-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
  if (timerWindowPos) {
    // Clamp the remembered position to a connected display's work
    // area — a monitor unplugged mid-session must not strand the
    // float offscreen.
    const area = screen.getDisplayNearestPoint(timerWindowPos).workArea;
    opts.x = Math.min(Math.max(timerWindowPos.x, area.x), area.x + area.width - width);
    opts.y = Math.min(Math.max(timerWindowPos.y, area.y), area.y + area.height - height);
  }
  const win = new BrowserWindow(opts);
  timerWindowZoom = zoom;
  // 'floating' sits above normal windows without fighting system
  // panels. (Fullscreen spaces are explicitly out of scope — the
  // answer there is keeping the timer popped in.)
  win.setAlwaysOnTop(true, 'floating');
  win.on('moved', () => {
    const [x, y] = win.getPosition();
    if (typeof x === 'number' && typeof y === 'number') timerWindowPos = { x, y };
  });
  win.on('closed', () => {
    timerWindow = null;
    // Backstop for closes that skipped the renderer's own pagehide
    // write (crash, force-close): tell surviving windows to clear
    // the popped-out flag so the in-app panel comes back.
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('timer:popout-closed');
    }
  });
  // Match the opener's chrome zoom before first paint — the pop-out
  // can't apply it itself (no host surface). Re-assert after load:
  // Chromium resets per-origin zoom on navigation commit.
  if (zoom !== 1) {
    win.webContents.on('did-finish-load', () => {
      if (!win.isDestroyed()) win.webContents.setZoomFactor(zoom);
    });
  }
  if (!app.isPackaged) {
    void win.loadURL(`${DEV_SERVER_URL}/timer.html`);
  } else {
    void win.loadFile(path.join(process.resourcesPath, 'renderer', 'timer.html'));
  }
  // showInactive: popping the timer out must not steal focus from
  // the document the user is editing.
  win.once('ready-to-show', () => win.showInactive());
  timerWindow = win;
}

ipcMain.handle('host:timer-popout-open', (_evt, popoutOpts?: TimerPopoutOpts) => {
  openTimerWindow(popoutOpts);
});
/** The pop-out's content reflowed (compact ↔ expanded toggle): hug
 *  it again. Only the float itself may call this; measurements are
 *  its CSS px, scaled by the zoom the window was opened with, and
 *  the result is re-clamped into the work area so growing near a
 *  screen edge can't push the float off-screen. */
ipcMain.handle(
  'host:timer-popout-resize',
  (evt, dims?: { contentWidth?: number; contentHeight?: number }) => {
    if (!timerWindow || timerWindow.isDestroyed()) return;
    if (evt.sender !== timerWindow.webContents) return;
    const cw = dims?.contentWidth;
    const ch = dims?.contentHeight;
    if (typeof cw !== 'number' || typeof ch !== 'number') return;
    if (!(cw > 40) || !(ch > 20) || cw > 2000 || ch > 600) return;
    const width = Math.round(cw * timerWindowZoom) + TIMER_WINDOW_PAD_W;
    const height = Math.round(ch * timerWindowZoom) + TIMER_WINDOW_PAD_H;
    timerWindow.setSize(width, height);
    const [x, y] = timerWindow.getPosition();
    if (typeof x === 'number' && typeof y === 'number') {
      const area = screen.getDisplayNearestPoint({ x, y }).workArea;
      const cx = Math.min(Math.max(x, area.x), area.x + area.width - width);
      const cy = Math.min(Math.max(y, area.y), area.y + area.height - height);
      if (cx !== x || cy !== y) timerWindow.setPosition(cx, cy);
    }
  },
);
/** Boot-time reconciliation: lets a reloading renderer distinguish
 *  "pop-out is alive, keep the flag" (three-pane mode switch) from
 *  "flag is stale, clear it" (fresh launch). */
ipcMain.handle('host:timer-popout-exists', () =>
  timerWindow !== null && !timerWindow.isDestroyed(),
);

// ─── Update chip (install-on-confirm) ────────────────────────────────
// The ebb model (adopted 2026-07-16): auto-updates never dialog. Windows /
// Linux stage the download silently; the status-bar chip is the only
// surface, and nothing installs until the user clicks it (install-on-quit
// stays as the fallback for users who never do). macOS (until the swap
// updater lands) shows an "available" chip that opens the release page.
type UpdateChipState = { state: 'available' | 'ready'; version: string } | null;
let updateChip: UpdateChipState = null;
/** The verified update zip electron-updater staged (mac swap path). */
let macStagedUpdateZip: string | null = null;

function setUpdateChip(next: Exclude<UpdateChipState, null>): void {
  updateChip = next;
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('update:chip', updateChip);
  }
}

/** Late-opened windows pull the current chip state at boot. */
ipcMain.handle('host:update-chip-state', () => updateChip);

/** Chip click: 'ready' (staged) → quit + install now; 'available'
 *  (macOS, not stageable yet) → open the release page. */
ipcMain.handle('host:update-chip-action', () => {
  if (!updateChip) return;
  if (updateChip.state === 'ready') {
    if (process.platform === 'darwin') {
      // Bundle swap (Squirrel can't install into unsigned builds): hand
      // the staged zip to the detached helper and quit; it waits for
      // exit, swaps the bundle (restoring the old one on any failure),
      // and relaunches.
      const bundle = bundlePathFromExe(app.getPath('exe'));
      if (macStagedUpdateZip && bundle) {
        launchSwapHelper({
          pid: process.pid,
          zipPath: macStagedUpdateZip,
          appBundlePath: bundle,
        });
        app.quit();
        return;
      }
      // Staged artifact vanished — degrade to the release page.
      void shell.openExternal(`${RELEASES_URL}/tag/v${updateChip.version}`);
      return;
    }
    // (silent, forceRunAfter): the NSIS installer runs with no UI and
    // relaunches the app when done — the chip promised "restart to
    // install", not "watch an installer wizard". Matches ebb's passive
    // install feel.
    autoUpdater.quitAndInstall(true, true);
  } else {
    void shell.openExternal(`${RELEASES_URL}/tag/v${updateChip.version}`);
  }
});

function startAutoUpdate(): void {
  if (!app.isPackaged) return;
  // macOS: Squirrel.Mac can't INSTALL into unsigned/self-signed builds,
  // but electron-updater's download path (zip + sha512 verification
  // against the release metadata) works fine — so we stage manually via
  // downloadUpdate() and install with the bundle-swap helper
  // (mac-swap-update.ts) on the chip click. autoDownload stays off on
  // mac (we trigger the download ourselves after the writability
  // check); install-on-quit is Windows/Linux-only.
  const isMac = process.platform === 'darwin';
  autoUpdater.autoDownload = !isMac;
  autoUpdater.autoInstallOnAppQuit = !isMac;
  autoUpdater.on('error', (err) => {
    console.warn('Auto-update error:', err);
  });
  autoUpdater.on('update-available', (info) => {
    console.log(`Auto-update: ${info.version} available, downloading…`);
    if (!isMac) return; // autoDownload handles Windows/Linux staging
    if (macBundleSelfUpdatable(app.getPath('exe'))) {
      autoUpdater.downloadUpdate().catch((err: unknown) => {
        // Staging failed (offline blip, or a pre-universal release with
        // no zip artifact) — fall back to an 'available' chip that opens
        // the release page, the pre-swap-updater behavior.
        console.warn('mac update staging failed; chip falls back to release page:', err);
        setUpdateChip({ state: 'available', version: info.version });
      });
    } else {
      setUpdateChip({ state: 'available', version: info.version });
    }
  });
  autoUpdater.on('update-downloaded', (info) => {
    if (isMac) {
      const file = (info as { downloadedFile?: string }).downloadedFile;
      if (file && file.endsWith('.zip')) {
        macStagedUpdateZip = file;
        console.log(`Auto-update: ${info.version} staged (mac swap); chip shown.`);
        setUpdateChip({ state: 'ready', version: info.version });
      } else {
        setUpdateChip({ state: 'available', version: info.version });
      }
      return;
    }
    console.log(`Auto-update: ${info.version} downloaded; chip shown, installs on quit.`);
    // No dialog (install-on-confirm): the status-bar chip is the only
    // surface. autoInstallOnAppQuit stays on, so quitting normally
    // still applies the update for users who never click the chip.
    setUpdateChip({ state: 'ready', version: info.version });
  });
  // The at-launch check fires from the renderer's boot path (gated
  // on the `checkForUpdatesOnLaunch` setting + `host.isFirstWindow()`)
  // via the `host:trigger-auto-update-check` IPC handler; subsequent
  // windows in the same session skip it. The persistent event handlers
  // above stay wired so the "Update ready" dialog still fires when the
  // download completes.
}

// ─── App lifecycle ─────────────────────────────────────────────────

// Single-instance lock so OS double-clicks of `.cmir` / `.docx`
// don't spawn a second copy of the app. If we don't hold the
// lock, a previous CardMirror process is already running and
// will receive the file path via the `second-instance` event
// below — bail out of this process cleanly.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // Another instance was launched (typically by the OS handing
  // us a file via "Open with"). Argv contains the new instance's
  // command line; mine the file path out of it and open it in a
  // new window of the existing app.
  app.on('second-instance', (_event, argv) => {
    const filePath = pickFileFromArgv(argv);
    if (filePath) void openExternalFile(filePath);
    // Pull the user's attention back to a window so they see the
    // newly-opened doc (or at least the existing app) on top.
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

// macOS fires `open-file` for Finder double-clicks of registered
// extensions. It can fire BEFORE `app.whenReady()`, so stash the
// path and consume it inside whenReady if we're not ready yet.
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (app.isReady()) {
    void openExternalFile(filePath);
  } else {
    pendingLaunchFile = filePath;
  }
});

void app.whenReady().then(() => {
  // One-time cleanup: the retired cross-window debug probe appended to
  // this log without bound in every user profile; remove it on sight.
  void fs
    .unlink(path.join(app.getPath('userData'), 'cross-window-debug.log'))
    .catch(() => {});
  // Accessibility crash workaround telemetry: whether we disabled the
  // renderer AX tree this launch, and whether Chromium reports an
  // assistive-tech / UIA client active (i.e. this machine would hit the
  // AX crash if the tree were enabled).
  console.log(
    `[cardmirror] ax-tree-disabled=${!rendererAccessibilityEnabled} ax-support-active=${app.isAccessibilitySupportEnabled()}`,
  );
  // macOS second prong: unless the user opted the tree back on, swizzle the
  // AppKit AXEnhancedUserInterface path shut so an assistive-tech client can't
  // re-enable the Chromium tree behind the disable-renderer-accessibility
  // switch. Runs here (not at module load) because it needs the shared
  // NSApplication to exist; before createWindow so no webContents is exposed
  // to the crash path first. No-op off macOS.
  if (!rendererAccessibilityEnabled) {
    installMacAccessibilitySuppression();
  }
  // An assistive-tech client connecting mid-session — another
  // confirmation signal for the AX crash trigger.
  app.on('accessibility-support-changed', (_event, enabled) => {
    console.log(`[cardmirror] ax-support-changed enabled=${enabled}`);
  });
  // macOS only — see the note at the other setApplicationMenu call. Windows/Linux
  // get no native menu bar so it can't swallow Alt-key editor shortcuts.
  Menu.setApplicationMenu(process.platform === 'darwin' ? buildMenu() : null);
  // Decide what to mount on first launch:
  //   - macOS `open-file` already arrived → that file
  //   - Win / Linux: scan argv for a file path → that file
  //   - Otherwise: empty starter window
  const launchFile = pendingLaunchFile ?? pickFileFromArgv(process.argv);
  pendingLaunchFile = null;
  if (launchFile) {
    void openExternalFile(launchFile);
  } else {
    createWindow();
  }
  startAutoUpdate();
  // Fast Debate Paste integration — 127.0.0.1-only HTTP server
  // exposing `/ping`, `/insert`, and `/jump` for external clients. If
  // the port is taken or the discovery file can't be written, the
  // bridge silently bails and the client falls back to its
  // keystroke path (the integration is never a hard dependency).
  // Once up, mirror the endpoint into the shared cardmirror-bridge
  // handshake directory so flow apps can discover us (plugin API v1).
  // The doc directory (already maintained for the Select-Speech-Doc
  // picker) powers the bridge's GET /docs and doc-targeted inserts.
  setDocDirectory({
    listDocs: () =>
      [...docOwners.entries()].map(([uid, windowId]) => ({
        uid,
        filename: docInfo.get(uid)?.filename ?? null,
        windowId,
      })),
    ownerWindow: (uid) => {
      const id = docOwners.get(uid);
      if (id === undefined) return null;
      const win = BrowserWindow.fromId(id);
      return win && !win.isDestroyed() ? win : null;
    },
    speechUid: () => speechRegistration?.uid ?? null,
  });
  void startFastPasteBridge().then(async () => {
    const ep = getRunningEndpoint();
    if (ep) {
      try {
        await writeCardmirrorHandshake(ep.port, ep.token);
      } catch {
        /* non-fatal — flow apps just won't discover us this session */
      }
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Non-darwin: closing the last window quits, as usual. macOS
  // keeps the app alive when the user merely closes windows —
  // EXCEPT when a real quit is underway, where the close
  // interception aborted `app.quit()` and it now falls to us to
  // finish the job once every window has confirmed and gone.
  if (process.platform !== 'darwin' || quitInitiated) app.quit();
});

app.on('before-quit', () => {
  // Remember that a genuine quit was asked for. The per-window
  // `close` handlers will `preventDefault()` this quit to confirm
  // unsaved work; `window-all-closed` reads this flag to actually
  // exit once the confirmations resolve. Cleared by
  // `host:close-cancelled` if the user backs out.
  quitInitiated = true;
});

// Tear down the Fast Debate Paste bridge only once the quit truly
// proceeds. `will-quit` fires after every window has confirmed and
// `window-all-closed` has re-issued the quit — never on a quit the
// user cancelled (that clears `quitInitiated`, so the second
// `app.quit()` never runs and `will-quit` never fires). Doing the
// teardown here instead of in `before-quit` keeps the bridge and
// both discovery files alive for the rest of the session after a
// cancelled quit. Stale-file tolerance still covers a hard exit.
app.on('will-quit', () => {
  void stopFastPasteBridge();
  // Clears only the SESSION half (port/token); the identity file persists
  // so flow-app pickers can still list a closed CardMirror.
  void deleteCardmirrorHandshake();
});
