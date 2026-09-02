/**
 * Collaboration-session UI flows: start / join / copy-code / end,
 * wired to the ribbon commands, plus the status-bar chip. Lazily
 * imported (this module pulls the Loro wasm via collab-session).
 *
 * One session per window at a time, bound to the single-doc view. The
 * flows own the editor's collab seams (collab-hooks): while a session
 * is live they register the plugin source (Loro sync + undo manager),
 * the transaction tagger (stamps sync-origin on the binding's remote
 * transactions so read mode and the AI coordinator admit them), and
 * refresh the plugin stack through the injected reconfigure capability.
 *
 * Invite transport: the share code (clipboard) and, on desktop, sealed
 * pairing-mailbox invites (inviteStarredFlow / joinSessionWithCode via
 * the Receive pill's Join).
 */

import type { EditorView } from 'prosemirror-view';
import { LoroUndoPlugin, loroSyncPluginKey, loroUndoPluginKey, undo as loroUndo, redo as loroRedo } from 'loro-prosemirror';
import { settings } from '../settings.js';
import { showToast } from '../toast.js';
import { surfaceError } from '../error-surface.js';
import { RELAY_FIX_PATH } from '../relay-decline.js';
import { postNotice } from '../status-notices.js';
import { promptForText, promptForRouteChoice, confirmDialog } from '../text-prompt.js';
import { markSyncOrigin } from '../sync-origin.js';
import { readModePlugin } from '../read-mode-plugin.js';
import {
  registerCollabPluginSource,
  unregisterCollabPluginSource,
  setCollabTransactionTagger,
  setCollabCopresenceProvider,
  notifyCollabCopresenceChange,
  setCollabCloseActions,
  setCollabHandoffProvider,
  setCollabSessionCountProvider,
  setCollabLiveRoomProbe,
  setCollabFocusChangeHandler,
  setCollabShareCodeGetter,
  setCollabInviteLinkGetter,
  collabRoomClaimKey,
} from './collab-hooks.js';
import { RoomsError } from './room-client.js';
import { getElectronHost } from '../host/index.js';
import { ensureBakedRelay, relayClient, relayClientWithGuestPass, endRoomOnRelay } from './collab-relay.js';
import { buildJoinLink, parseJoinLinkHash } from './join-link.js';
import { relayClient as pairingRelayClient } from '../pairing/relay-client.js';
import { resolveStarredTarget } from '../pairing/send-to-starred.js';
import { buildRoomInviteItem, roomInviteFloor } from '../pairing/room-invite.js';
import { collabInvariantHealPlugin } from './collab-invariants.js';
import { causalMarkHealPlugin } from './causal-mark-heal.js';
import {
  installCommentsSync,
  COMMENTS_COMMIT_ORIGIN,
  type CommentsSyncHandle,
} from './collab-comments.js';
import { UndoManager } from 'loro-crdt';
import { attachSessionPersistence, type PersistHandle } from './collab-persist.js';
import { attachSessionHistory, type HistoryHandle } from './collab-history.js';
import { installCursorPresence, type CursorsHandle } from './collab-cursors.js';
import { collabRepairPlugin, lowestPeerIsLeader } from './collab-repair.js';
import { loadSessionRecord, loadPrefetch, deletePrefetch } from './collab-store.js';
import { importRoomKey, decryptBlob } from './collab-crypto.js';
import { resetSessionCommentIds } from '../comments-plugin.js';
import { collabEnabled } from './collab-gate.js';
import { decodeShareCode } from './collab-crypto.js';
import { CollabSession } from './collab-session.js';
import { compareAppVersions } from '../relay-protocol.js';
import { appVersion } from '../install-info.js';

export interface CollabUiDeps {
  getView(): EditorView | null;
  refreshPlugins(): void;
  /** The `DocRecord.uid` of the document this session is being started/joined
   *  for — captured at install so the binding plugins only ever attach to that
   *  one doc's view (multi-pane fusion guard). */
  getOwnerUid?(): string | null;
  /** Resolve a doc uid to its live view. A session binds its cursors/comments to
   *  its OWNER's view via this (not the focused view), so in multi-pane each
   *  doc's presence renders in its own pane. Falls back to the focused view. */
  getViewForUid?(uid: string): EditorView | null;
  /** Rebuild the plugin stack of the doc with `uid` (its own view — NOT the
   *  focused one). Session-END paths use this so an unfocused owner pane
   *  doesn't keep dead collab plugins. Falls back to refreshPlugins(). */
  refreshPluginsForUid?(uid: string): void;
  /** Swap THIS window's editor to a fresh unsaved doc for a joined
   *  session — must never spawn a window (the binding installs into the
   *  current view; a spawned window would never get it — field bug on
   *  desktop, 2026-07-03). Resolves false if the user cancelled out of
   *  overwriting unsaved edits. */
  newSessionDoc(): boolean | Promise<boolean>;
  /** Name the (unsaved) session doc in this window: window title, the
   *  filename chip, and the save-as default. Joiners get the host's
   *  title through the room's meta map — without this the window and
   *  the Sessions list just say "collaboration session" (field bug,
   *  2026-07-03). */
  setDocTitle?(title: string): void;
  /** Desktop multi-window: when the current window has a real doc open (not
   *  the disposable starter), spawn a NEW window to host the joined session
   *  and return true — the caller then aborts, and the spawned window runs
   *  the full join itself (so the session + Loro binding land together,
   *  never stranded). Returns false to join in THIS window (starter open, or
   *  single-window / web). */
  spawnJoinWindow?(shareCode: string): boolean;
}

/** One live co-editing session, owned by a single open doc (the map key). A
 *  multi-pane window can hold several — one per doc. */
interface ActiveSession {
  session: CollabSession;
  shareCode: string;
  ownerUid: string;
  cursors: CursorsHandle;
  commentsSync: CommentsSyncHandle;
  persist: PersistHandle;
  /** Session-history writer ({roomId}.cmir-history). Disposed at
   *  teardown but its FILE is always retained — unlike the session
   *  record, which is deleted on Leave/End/tombstone. */
  history: HistoryHandle;
  wakeCleanup: () => void;
  /** Unsubscribe the meta-map (title) watcher installed by installSeams. */
  metaUnsub: () => void;
  /** Latest connection status for THIS session. The shared status-bar chip only
   *  ever reflects the focused doc's session; storing status per session lets
   *  each multi-pane slot footer render its own visible doc's state. */
  lastStatus: { connected: boolean; queuedUpdates: number } | null;
}

const sessions = new Map<string, ActiveSession>();

/** Commit origin for session meta-map writes (title publishing) — excluded
 *  from the session UndoManager alongside comment writes, so Ctrl+Z never
 *  un-publishes the shared title. */
const META_COMMIT_ORIGIN = 'cm-meta';

/** Focused doc's uid — set by the editor host so no-deps UI helpers (chip,
 *  presence, copy-code, invite) can find the session the user is looking at. */
let focusedUidResolver: (() => string | null) | null = null;
export function setCollabFocusResolver(fn: (() => string | null) | null): void {
  focusedUidResolver = fn;
}

/** Resolve a doc uid → its display filename, set by the host so no-deps helpers
 *  (invite, persist label) and the start flow name a session after its OWNER
 *  doc rather than `document.title` — which in multi-pane is every open doc
 *  joined by " · ". */
let docTitleResolver: ((uid: string) => string | null) | null = null;
export function setCollabDocTitleResolver(fn: ((uid: string) => string | null) | null): void {
  docTitleResolver = fn;
}

/** Resolve a doc uid → its persistent docId (null before first save).
 *  The persistence manager stamps it into the session record so the
 *  open-from-disk path can match a file back to its session. */
let docIdResolver: ((uid: string) => string | null) | null = null;
export function setCollabDocIdResolver(fn: ((uid: string) => string | null) | null): void {
  docIdResolver = fn;
}

/** Whether a session for `roomId` is live in THIS window. */
export function roomLiveInWindow(roomId: string): boolean {
  for (const s of sessions.values()) if (s.session.roomId === roomId) return true;
  return false;
}

/** The session owned by `uid`, or null. */
function sessionFor(uid: string | null | undefined): ActiveSession | null {
  return uid != null ? sessions.get(uid) ?? null : null;
}

// Feed the multi-pane shell's per-slot footers: each slot paints the copresence
// of ITS visible doc's session (or nothing when that doc isn't in a session).
setCollabCopresenceProvider((uid) => {
  const sess = sessionFor(uid);
  if (!sess) return null;
  return {
    role: sess.session.role,
    // Before the first onStatus, assume connected (start() flushes immediately);
    // the flows also stamp lastStatus so an offline join/resume reads correctly.
    connected: sess.lastStatus?.connected ?? true,
    queued: sess.lastStatus?.queuedUpdates ?? 0,
    peers: sess.cursors.presence().map((p) => ({ name: p.name, color: p.color, self: p.self })),
  };
});

// Close-time actions for a co-edited doc, called by the always-loaded close
// paths (multi-pane shell + single-doc) via collab-hooks. Registered once here.
setCollabCloseActions({
  keepResumable: (uid) => closeKeepResumableSession(uid),
  endOrLeave: (uid) => closeEndOrLeaveSession(uid),
});

// Mode-switch hand-off: flush every live session's record (so unsynced edits
// survive the toggle's reload) and report {uid, roomId} so the post-reload flow
// can auto-resume each into the doc that reopens under its uid.
setCollabHandoffProvider(async () => {
  const list = [...sessions.values()].map((s) => ({ uid: s.ownerUid, roomId: s.session.roomId }));
  await Promise.all([...sessions.values()].map((s) => s.persist.flush()));
  return list;
});
setCollabSessionCountProvider(() => sessions.size);
setCollabLiveRoomProbe((roomId) =>
  [...sessions.values()].some((s) => s.session.roomId === roomId),
);
setCollabFocusChangeHandler(() => refreshChipForFocus());

// Cross-window live-session claims. Desktop rides the duplicate-open
// path registry in main; web (Phase 3) rides the WEB LOCKS API — an
// exclusive lock named by the claim key, held for the tab's lifetime
// (the browser releases it automatically when the tab dies, crash
// included, which is exactly the lifetime a claim should have).
// All three are best-effort and swallow everything: an old preload, a
// lockless browser, or a test harness must not break session flows.
const webHeldClaims = new Map<string, () => void>();

function claimRoom(roomId: string): void {
  const key = collabRoomClaimKey(roomId);
  try {
    const electron = getElectronHost();
    if (electron) {
      void electron.openPathRegister(key).catch(() => {});
      return;
    }
    if (webHeldClaims.has(key) || typeof navigator.locks?.request !== 'function') return;
    void navigator.locks
      .request(key, { mode: 'exclusive', ifAvailable: true }, (lock) => {
        // null = another tab holds it. We proceed unclaimed (the join
        // guard runs BEFORE the session starts; this path is reached
        // only for sessions already being created here).
        if (!lock) return undefined;
        return new Promise<void>((resolve) => {
          webHeldClaims.set(key, resolve);
        });
      })
      .catch(() => {});
  } catch {
    /* API absent — no cross-window guard, sessions still work */
  }
}
function releaseRoomClaim(roomId: string): void {
  const key = collabRoomClaimKey(roomId);
  try {
    const electron = getElectronHost();
    if (electron) {
      void electron.openPathRelease(key).catch(() => {});
      return;
    }
    webHeldClaims.get(key)?.();
    webHeldClaims.delete(key);
  } catch {
    /* API absent */
  }
}
async function roomLiveElsewhere(roomId: string): Promise<boolean> {
  const key = collabRoomClaimKey(roomId);
  try {
    const electron = getElectronHost();
    if (electron) {
      return (await electron.openPathCheck(key))?.takenByOther ?? false;
    }
    if (typeof navigator.locks?.query !== 'function') return false;
    const held = (await navigator.locks.query()).held ?? [];
    return held.some((l) => l.name === key) && !webHeldClaims.has(key);
  } catch {
    return false;
  }
}

/** The session the shared chip / no-deps flows act on: the focused doc's, or —
 *  when focus isn't resolvable (or that doc has no session) — the sole session
 *  if there's exactly one. (A later step adds a per-slot footer so every
 *  session's status shows at once; until then the single chip follows focus.) */
function chipSession(): ActiveSession | null {
  return (
    sessionFor(focusedUidResolver?.() ?? null) ??
    (sessions.size === 1 ? [...sessions.values()][0]! : null)
  );
}

/** The session UI ACTIONS act on (copy code, invite starred): STRICTLY the
 *  focused doc's session. The sole-session fallback applies only when focus is
 *  unresolvable (no resolver registered — bare single-pane); falling back while
 *  the user is LOOKING at a session-less doc invited partners into a different
 *  doc's session (audit find, 2026-07-10). Display (chipSession) keeps the
 *  fallback — showing the one live session is fine; acting on it is not. */
function actionSession(): ActiveSession | null {
  const focused = focusedUidResolver?.() ?? null;
  if (focused != null) return sessionFor(focused);
  return sessions.size === 1 ? [...sessions.values()][0]! : null;
}

// The Send pill's session action ("Start session" vs "Copy session
// code") keys off the FOCUSED doc's live session — an action, so it
// uses actionSession(), never the display fallback (see above).
setCollabShareCodeGetter(() => actionSession()?.shareCode ?? null);
setCollabInviteLinkGetter(() => {
  const s = actionSession();
  if (!s) return null;
  return buildJoinLink({ shareCode: s.shareCode, guestPass: s.session.guestPass });
});

function chipEl(): HTMLElement | null {
  return document.getElementById('collab-chip');
}

function updateChip(status: { connected: boolean; queuedUpdates: number } | null): void {
  const chip = chipEl();
  if (!chip) return;
  if (!status) {
    chip.hidden = true;
    chip.replaceChildren();
    return;
  }
  chip.hidden = false;
  const text = status.connected
    ? status.queuedUpdates > 0
      ? `Session: sending ${status.queuedUpdates}…`
      : 'Session: synced'
    : status.queuedUpdates > 0
      ? `Session: offline — ${status.queuedUpdates} queued`
      : 'Session: offline';
  // Chip = a text label + a presence-dots strip (kept as stable children so
  // the dots can refresh on their own timer without rebuilding the label).
  let label = chip.querySelector('.pmd-collab-chip-label');
  let dots = chip.querySelector('.pmd-collab-chip-dots');
  if (!(label instanceof HTMLElement) || !(dots instanceof HTMLElement)) {
    chip.replaceChildren();
    label = document.createElement('span');
    label.className = 'pmd-collab-chip-label';
    chip.appendChild(label);
    dots = document.createElement('span');
    dots.className = 'pmd-collab-chip-dots';
    chip.appendChild(dots);
  }
  label.textContent = text;
  renderPresenceDots(dots as HTMLElement);
}

/** One colored dot per person in the room, hover for the name. */
function renderPresenceDots(container: HTMLElement): void {
  const peers = chipSession()?.cursors.presence() ?? [];
  container.replaceChildren();
  for (const p of peers) {
    const dot = document.createElement('span');
    dot.className = 'pmd-collab-presence-dot' + (p.self ? ' pmd-collab-presence-dot-self' : '');
    dot.style.background = p.color;
    dot.title = p.self ? `${p.name} (you)` : p.name;
    container.appendChild(dot);
  }
}

/** Re-render just the dots (peers join/leave/expire between chip updates). */
function refreshPresenceDots(): void {
  const dots = chipEl()?.querySelector('.pmd-collab-chip-dots');
  if (dots instanceof HTMLElement) renderPresenceDots(dots);
}

let presenceTimer: ReturnType<typeof setInterval> | null = null;


/** Stamp the Loro binding's own transactions as sync-origin: both the
 *  remote-update imports and the init-time content replace carry the
 *  binding's meta, and neither is a user edit — read mode and the AI
 *  coordinator must admit them (rejection desyncs editor from CRDT). */
function collabTagger(tr: Parameters<typeof markSyncOrigin>[0]): void {
  if (tr.getMeta(loroSyncPluginKey) !== undefined || tr.getMeta(loroUndoPluginKey) !== undefined) {
    markSyncOrigin(tr);
  }
}


/** Wake-from-sleep / network-return hooks (M3): a resumed laptop's
 *  stream socket is silently dead until timeouts notice — restart it
 *  the moment the OS tells us. Desktop: powerMonitor via the host
 *  seam; both editions: the browser 'online' event. */
function installWakeHooks(session: CollabSession): () => void {
  const onOnline = (): void => session.restart();
  window.addEventListener('online', onOnline);
  const offResume = getElectronHost()?.onPowerResumed?.(() => session.restart()) ?? null;
  return () => {
    window.removeEventListener('online', onOnline);
    offResume?.();
  };
}

/** Build a session's seams, register it, and return the ActiveSession. The
 *  cursors/comments bind to the OWNER's view (not focus) so each doc's presence
 *  renders in its own pane. Window-level seams (tagger, presence timer, comment-
 *  id mode) are shared across every live session and retired in `teardownSession`
 *  when the last one ends. `ownerUid` is the map key (the focused doc at start). */
/** `ownerUid` is the map key and the doc the seams bind into. It is passed in
 *  (not re-read from `deps.getOwnerUid()` here) because every caller has already
 *  awaited a confirm dialog and/or a relay round-trip by this point: re-reading
 *  focus now would bind the session onto whatever doc the user has since clicked
 *  into. Callers capture it at the moment that fixes the target — start: the
 *  focused doc when Start was chosen; join/resume: the freshly-created session
 *  doc right after newSessionDoc(). */
/** Full-screen "working…" veil for the synchronous CRDT freezes a big
 *  document forces: hosting seeds the whole doc into the CRDT (~36s
 *  measured on a 6.7MB master) and joining materializes it back
 *  (~10s). Neither can yield mid-work, so the honest thing is a
 *  painted banner before the freeze starts. The 30ms wait is what
 *  lets it PAINT — returning the cleanup so callers `finally` it
 *  (via setTimeout(0), which FIFO-orders removal after the binding's
 *  own deferred init freeze). */
async function sessionPrepOverlay(text: string): Promise<() => void> {
  const overlay = document.createElement('div');
  overlay.className = 'pmd-bulk-overlay pmd-session-prep';
  const card = document.createElement('div');
  card.className = 'pmd-session-prep-card';
  card.textContent = text;
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  await new Promise((r) => setTimeout(r, 30));
  return () => overlay.remove();
}

function installSeams(
  session: CollabSession,
  deps: CollabUiDeps,
  shareCode: string,
  ownerUid: string,
): ActiveSession {
  const ownerView = (): EditorView | null =>
    (ownerUid ? deps.getViewForUid?.(ownerUid) ?? null : null) ?? deps.getView();
  // One shared tagger stamps ANY binding transaction (keyed off the Loro plugin
  // meta), so it serves every session; installed while ≥1 is live.
  setCollabTransactionTagger(collabTagger);
  const wakeCleanup = installWakeHooks(session);
  const commentsSync = installCommentsSync(session.loroDoc, ownerView);
  // M3: crash-surviving session record (home-screen Sessions list resumes it).
  const persist = attachSessionPersistence(
    session,
    shareCode,
    () => sessionDocTitle(ownerUid) || sharedDocTitle(session),
    () => docIdResolver?.(ownerUid) ?? null,
  );
  // Recover Previous Version's durable record: full-history snapshots
  // that survive session end (deliberately including a remote
  // tombstone — an attacker ending the session must not destroy it).
  const history = attachSessionHistory(
    session,
    () => sessionDocTitle(ownerUid) || sharedDocTitle(session),
  );
  const cursors = installCursorPresence(session, ownerView);
  // One shared timer refreshes the focused session's chip dots AND every slot
  // footer's copresence (peers join/leave/expire between status updates).
  if (presenceTimer === null)
    presenceTimer = setInterval(() => {
      refreshPresenceDots();
      notifyCollabCopresenceChange();
    }, 3000);
  // Comment-id allocation is per-doc now (the host's resolver tests each doc's
  // session state), so nothing to toggle on here — a co-edited doc's new
  // comments get random ids to avoid two peers colliding on the counter.
  // Live title adoption: the host may (re)name the doc mid-session —
  // a session started on an untitled doc was permanently nameless in
  // every joiner window before this, because the title was read exactly
  // once at join/resume. Hosts never adopt (their local filename is the
  // source of truth the republish flows FROM).
  const metaUnsub = session.loroDoc.getMap('meta').subscribe((e) => {
    if (e.by === 'local' || session.role === 'host') return;
    queueMicrotask(() => adoptSharedTitle(deps, session));
  });
  const sess: ActiveSession = {
    session,
    shareCode,
    ownerUid,
    cursors,
    commentsSync,
    persist,
    history,
    wakeCleanup,
    metaUnsub,
    lastStatus: null,
  };
  sessions.set(ownerUid, sess);
  // Cross-window live-session claim: while this session is live, other
  // windows' Sessions rows (and join-by-code) refuse the same room and focus
  // this window instead — same registry as the duplicate-file-open guard.
  // Best-effort; released in teardownSession (and by main when this window
  // dies).
  claimRoom(session.roomId);
  // A session just appeared — repaint slot footers (this doc's may be visible).
  notifyCollabCopresenceChange();
  registerCollabPluginSource({
    ownerUid,
    plugins: () => [
      ...session.plugins(),
      // A pre-configured manager (the plugin otherwise builds its own):
      // comment-mirror and meta writes commit with excluded origins, so the
      // undo stack holds ONLY document edits — Ctrl+Z was silently deleting
      // comments/replies session-wide when a comment op sat on top of it
      // (audit find, 2026-07-10). The plugin still adds 'sys:init' and wires
      // its own cursor-restore hooks onto this manager.
      LoroUndoPlugin({
        doc: session.loroDoc,
        undoManager: new UndoManager(session.loroDoc, {
          excludeOriginPrefixes: [COMMENTS_COMMIT_ORIGIN, META_COMMIT_ORIGIN],
        }),
      }),
      collabInvariantHealPlugin(),
      // Inserter-intent for the read layers: strips highlight/underline/
      // emphasis/shading inherited by text whose typist never saw the
      // mark (Peritext interior coverage) — see causal-mark-heal.ts.
      causalMarkHealPlugin(session.loroDoc),
      collabRepairPlugin(() =>
        lowestPeerIsLeader(session.loroDoc.peerIdStr, cursors.visiblePeers()),
      ),
      commentsSync.plugin,
      ...cursors.plugins(),
    ],
    ownsUndo: () => true,
    // Read-mode clamp (M4): swallow undo/redo entirely while reading — the Loro
    // undo transactions carry the binding meta (→ sync-origin) and would
    // otherwise sail through the read-mode lock and revert real edits.
    undo: (state, dispatch, view) =>
      readModePlugin.getState(state)?.on ? true : loroUndo(state, dispatch, view),
    redo: (state, dispatch, view) =>
      readModePlugin.getState(state)?.on ? true : loroRedo(state, dispatch, view),
  });
  return sess;
}

/** Dispose one session's seams + drop it from the registry. Window-level shared
 *  seams (tagger / presence timer / comment-id mode) are retired only when the
 *  LAST session ends. `keepRecord` keeps the resumable persisted record (a
 *  cancelled RESUME, or a close-but-keep); terminal paths clear it. Returns the
 *  record-clear promise so terminal callers can await deletion (so a re-read of
 *  the Sessions list doesn't flash a stale row); most callers ignore it. */
function teardownSession(sess: ActiveSession, keepRecord = false): Promise<void> {
  // Stop the SESSION itself, not just its UI: the room-full and join/resume
  // failure paths reached here without an explicit stop, and the orphaned
  // CollabSession kept its flush / catch-up / audit timers (and the audit's
  // full-history repost) alive for the window's life against a room this
  // window was no longer in (2026-09-01 review). stop() is idempotent, so
  // the End/Leave/close paths that already stopped are unaffected.
  void sess.session.stop().catch(() => {});
  unregisterCollabPluginSource(sess.ownerUid);
  sessions.delete(sess.ownerUid);
  // Release the cross-window live-session claim (registered in installSeams).
  releaseRoomClaim(sess.session.roomId);
  // A session went away — repaint slot footers (this doc's may be visible).
  notifyCollabCopresenceChange();
  sess.wakeCleanup();
  sess.metaUnsub();
  sess.commentsSync.dispose();
  sess.cursors.dispose();
  // History stops writing but its file is NEVER cleared here — the
  // whole point is surviving Leave/End/tombstone. Pruning is age-based,
  // in the main process.
  sess.history.dispose();
  let cleared: Promise<void> = Promise.resolve();
  if (keepRecord) sess.persist.dispose();
  else cleared = sess.persist.clear();
  if (sessions.size === 0) {
    setCollabTransactionTagger(null);
    // Last session gone — drop the random-id dedup set so it doesn't grow.
    resetSessionCommentIds();
    if (presenceTimer !== null) {
      clearInterval(presenceTimer);
      presenceTimer = null;
    }
  }
  return cleared;
}

/** Whether `ownerUid`'s session is the one the shared chip reflects. MUST
 *  match chipSession()'s selection exactly: the two used to disagree on the
 *  sole-session fallback (chipSession applied it whenever the focused doc had
 *  no session; this predicate only when focus was unresolvable), so the chip
 *  label froze — and ghosted after that session ended — while its dots kept
 *  rendering from chipSession (audit find, 2026-07-10). */
function isChipSession(ownerUid: string): boolean {
  return chipSession()?.ownerUid === ownerUid;
}

/** Repaint the shared chip from the CURRENT chip session's last status —
 *  called (via collab-hooks) when focus moves between docs; the chip
 *  otherwise held the previous doc's label until its next status event. */
export function refreshChipForFocus(): void {
  const sess = chipSession();
  updateChip(sess ? sess.lastStatus ?? { connected: true, queuedUpdates: 0 } : null);
}

// `getSess` resolves THIS session's ActiveSession lazily — for join/resume the
// entry isn't created (and its owning uid isn't known) until after newSessionDoc
// creates the fresh doc, which is after the CollabSession (and these callbacks)
// exist. Returns null before install / after teardown; callbacks then no-op.
function sessionCallbacks(deps: CollabUiDeps, getSess: () => ActiveSession | null) {
  return {
    onStatus: (s: { connected: boolean; queuedUpdates: number }) => {
      const sess = getSess();
      if (!sess) return;
      // Every session records its own status (each slot footer renders its
      // own); the shared chip still reflects only the focused doc's.
      sess.lastStatus = s;
      if (isChipSession(sess.ownerUid)) updateChip(s);
      notifyCollabCopresenceChange();
    },
    onPresence: (bytes: Uint8Array) => getSess()?.cursors.applyRemote(bytes),
    onGuestAuthExpired: () => {
      // Terminal-cause notice for a guest whose (immutable, 7-day) pass
      // the relay refused: onEnded fires right after this and its toast
      // says the session ended — this says WHY, and what to do about it.
      postNotice({
        severity: 'error',
        title: 'Session invite expired',
        body:
          'Your invite to this session has expired, so it can’t reconnect. ' +
          'Ask the host for a fresh invite link if the session is still going. ' +
          'This copy of the document is yours to keep.',
        key: 'collab-guest-expired',
      });
    },
    onAuthRejected: () => {
      // Mid-session 401/403 — without this the endless retry loop reads
      // exactly like being offline (audit find, 2026-07-10). Fired once
      // per session by CollabSession.
      postNotice({
        severity: 'error',
        title: 'Session credentials rejected',
        body:
          'The session relay rejected your credentials. ' +
          RELAY_FIX_PATH +
          ' Your edits are saved locally and keep retrying.',
        key: 'collab-401',
      });
    },
    onBacklogMerged: (_count: number) => {
      // Merge-visibility (M3): a real offline backlog just landed — say
      // so, instead of the doc silently reshaping under the user. The
      // session only fires this after a genuine blind window whose
      // catch-up actually changed the doc (frame counts never mapped to
      // user-perceived edits, so the number is gone from the message).
      showToast('Caught up on edits made while you were offline — recent sections may have moved');
    },
    onEnded: () => {
      // The explicit end/leave flows clean up themselves before the
      // session's onEnded fires; only a REMOTELY ended session (host
      // ended it, room GC'd) reaches past this guard.
      const sess = getSess();
      if (!sess || !sessions.has(sess.ownerUid)) return;
      const wasHost = sess.session.role === 'host';
      const wasChip = isChipSession(sess.ownerUid);
      void teardownSession(sess).catch((e) => surfaceError('collab teardown', e));
      void wasChip;
      refreshChipForFocus(); // repaint from live truth — a stale wasChip snapshot left ghost chips (field find, 2026-08-12)
      // Rebuild the OWNER doc's plugin stack — refreshing the focused view
      // left an unfocused owner pane holding dead session plugins (audit
      // find, 2026-07-10).
      if (deps.refreshPluginsForUid) deps.refreshPluginsForUid(sess.ownerUid);
      else deps.refreshPlugins();
      showToast(
        wasHost
          ? 'Collaboration session ended'
          : 'Session ended — this copy is now yours alone',
      );
    },
    onFull: () => {
      const sess = getSess();
      if (!sess || !sessions.has(sess.ownerUid)) {
        showToast('That session is full (10 participants)');
        return;
      }
      // The join/resume half-succeeded over REST before the stream's 409:
      // leaving the session mounted showed "Joined the session" + a dead
      // offline chip forever (audit find, 2026-07-10). Tear down but KEEP
      // the record so the user can rejoin from the Sessions list when
      // someone leaves.
      const wasChip = isChipSession(sess.ownerUid);
      void teardownSession(sess, /* keepRecord */ true).catch((e) => surfaceError('collab teardown', e));
      void wasChip;
      refreshChipForFocus(); // repaint from live truth — a stale wasChip snapshot left ghost chips (field find, 2026-08-12)
      if (deps.refreshPluginsForUid) deps.refreshPluginsForUid(sess.ownerUid);
      else deps.refreshPlugins();
      showToast(
        'The session is full (10 people) — your copy is saved; rejoin from the ' +
          'Sessions list when someone leaves.',
      );
    },
  };
}

/** Turn a relay failure into a user-actionable message. A 401 is the
 *  gating/auth signal — for INITIATING a session (send-gated per §5.4:
 *  paid initiates, free joins) that means a subscription is required;
 *  for join/resume it means the relay rejected the credentials. The
 *  401 is inherently ambiguous between "hosted relay, needs a paid
 *  account" and "self-host, wrong token", so the message names both
 *  without asserting which. Any non-401 keeps its raw reason. */
export function relayFailureMessage(err: unknown, opts: { initiating: boolean; verb: string }): string {
  if (err instanceof RoomsError && err.status === 401) {
    return opts.initiating
      ? 'Starting a collaboration session requires a relay. ' + RELAY_FIX_PATH
      : 'The session relay rejected your credentials. ' + RELAY_FIX_PATH;
  }
  // 410 = the room was ended (host); 404 = the room itself is gone (relay
  // idle GC). Not errors the user can retry into — tell them the session is
  // over rather than leaking the raw "rooms request failed: NNN".
  if (err instanceof RoomsError && (err.status === 410 || err.status === 404)) {
    return 'That co-editing session has ended — ask for a fresh invite to start a new one.';
  }
  return `Could not ${opts.verb}: ${(err as Error).message}`;
}

/** Start-session gate: a session is started FOR a focused document, so a
 *  live view is required (join/resume create their own doc and do not use
 *  this). The message holds in both modes — single-pane always has a doc;
 *  multi-pane hits this only with every slot empty/unfocused. */
function guardReady(deps: CollabUiDeps): EditorView | null {
  if (!collabEnabled()) return null;
  const view = deps.getView();
  if (!view) {
    showToast('Open and focus a document to start a co-editing session');
    return null;
  }
  return view;
}

/** Docs with a Start flow mid-confirm/mid-relay: a double-click (or a second
 *  Start command racing the first's awaits) minted TWO rooms for one doc
 *  (audit find, 2026-07-10). */
const startsInFlight = new Set<string>();

export async function startSessionFlow(deps: CollabUiDeps): Promise<void> {
  if (!collabEnabled()) return; // desktop-only; inert on the web edition
  const view = guardReady(deps);
  if (!view) return;
  const ownerUid = deps.getOwnerUid?.() ?? '';
  if (sessionFor(ownerUid)) {
    showToast('This document already has a session — end or leave it first');
    return;
  }
  if (startsInFlight.has(ownerUid)) return;
  startsInFlight.add(ownerUid);
  try {
    await startSessionFlowInner(deps, view, ownerUid);
  } finally {
    startsInFlight.delete(ownerUid);
  }
}

async function startSessionFlowInner(
  deps: CollabUiDeps,
  view: EditorView,
  ownerUid: string,
): Promise<void> {
  // Confirm, naming the doc the session will be created for — removes any
  // ambiguity about which doc is being shared (multi-pane: the focused one).
  const startName = sessionDocTitle(ownerUid);
  // A plain yes/no — two equal buttons (confirmDialog), NOT the big
  // route-choice cards, which are reserved for genuine multi-option
  // decisions (field feedback, 2026-07-11).
  const startConfirm = await confirmDialog(
    'Anyone you share the code with can edit this document with you in real time.',
    {
      title: `Start a co-editing session for ${startName ? `"${startName}"` : 'this document'}?`,
      okLabel: 'Start Session',
    },
  );
  if (!startConfirm) return;
  await ensureBakedRelay();
  const client = relayClient();
  if (!client) {
    showToast(`No relay connection — ${RELAY_FIX_PATH}`);
    return;
  }
  try {
    // Host on the CURRENT (focused) doc — no doc swap, so its uid is the owner.
    let sessRef: ActiveSession | null = null;
    // host() seeds the ENTIRE doc into the CRDT synchronously, and the
    // binding's init (a setTimeout(0) inside the sync plugin) then does
    // its own synchronous pass — the veil must outlive BOTH, or it
    // vanishes while the editor is still frozen (field find, 2026-08-12
    // three-pane test). The finally releases it via setTimeout(0).
    const prepDone = await sessionPrepOverlay(
      'Preparing collaboration session — a large document can take a moment…',
    );
    let session: CollabSession;
    let shareCode: string;
    let sess: ActiveSession;
    try {
      ({ session, shareCode } = await CollabSession.host({
        pmDoc: view.state.doc,
        client,
        callbacks: sessionCallbacks(deps, () => sessRef),
      }));
      // ownerUid captured at flow start (line ~427), under the doc that was
      // focused when Start was chosen — host() shared THAT doc's content, so
      // the seams must bind to it even if focus has since moved.
      sess = installSeams(session, deps, shareCode, ownerUid);
      sessRef = sess;
      // Seed before start(): the first flush then carries the host's
      // existing comment threads alongside the seeded doc — and the doc
      // title, so joiners can name their unsaved copy.
      sess.commentsSync.seedFromView(view);
      session.loroDoc.getMap('meta').set('title', sessionDocTitle(ownerUid));
      session.loroDoc.commit({ origin: META_COMMIT_ORIGIN });
      deps.refreshPlugins();
      session.start();
    } finally {
      // The binding queued its init (the second synchronous freeze) via
      // setTimeout(0) inside refreshPlugins; same-delay timeouts run
      // FIFO, so queueing the veil's removal NOW runs it right after
      // that init finishes — without inserting awaits into this flow,
      // which lets live session callbacks interleave mid-flow (broke
      // the flow tests when tried).
      setTimeout(prepDone, 0);
    }
    sess.lastStatus = { connected: true, queuedUpdates: 0 };
    updateChip({ connected: true, queuedUpdates: 0 });
    // Web hosts copy the INVITE LINK (their partner most likely joins in
    // a browser; the link carries the guest pass so an account-less
    // joiner works). Desktop keeps the bare code — its partners are
    // other installs, and the code paste-flow is muscle memory there.
    const inviteText = getElectronHost()
      ? shareCode
      : buildJoinLink({ shareCode, guestPass: session.guestPass });
    const copied = await navigator.clipboard?.writeText(inviteText).then(
      () => true,
      () => false,
    );
    showToast(
      copied
        ? getElectronHost()
          ? 'Session started — share code copied, send it to your partner'
          : 'Session started — invite link copied, send it to your partner'
        : 'Session started — use "Copy Session Share Code" to invite',
    );
  } catch (err) {
    showToast(relayFailureMessage(err, { initiating: true, verb: 'start the session' }));
  }
}

export async function joinSessionFlow(deps: CollabUiDeps): Promise<void> {
  if (!collabEnabled()) return;
  const entered = await promptForText({
    message: 'Paste the share code — or the invite link — from your partner',
    placeholder: 'cmshare… or https://cardmirror.app/#join=…',
    okLabel: 'Join',
  });
  if (!entered) return;
  // A full invite link pastes here too (the Chromebook path: link
  // received in a chat, app already open). Extract code + guest pass.
  const hashIdx = entered.indexOf('#');
  const fromLink = hashIdx >= 0 ? parseJoinLinkHash(entered.slice(hashIdx)) : null;
  if (fromLink) {
    await joinSessionWithCode(deps, fromLink.shareCode, { guestPass: fromLink.guestPass });
    return;
  }
  await joinSessionWithCode(deps, entered);
}

/** Join with a code in hand — the prompt flow above and the Receive
 *  pill's invite Join both land here. Returns true when the join actually
 *  landed (or was handed to a spawned window) — the Receive pill consumes
 *  the invite only then, so a cancelled slot pick or an unreachable relay
 *  doesn't burn the share code. No view is required up front: the flow
 *  creates its own doc via deps.newSessionDoc (multi-pane may be an empty
 *  workspace at this point). */
export async function joinSessionWithCode(
  deps: CollabUiDeps,
  code: string,
  opts?: { guestPass?: string | null },
): Promise<boolean> {
  if (!collabEnabled()) return false;
  // Don't overwrite the doc you're working in — or bump the session you're
  // already in: unless this window holds the disposable starter, hand the
  // join to a fresh window (which re-enters here with the starter open, so it
  // joins in place). Runs BEFORE the `active` guard and the session creation,
  // so an active-session window opens the new join elsewhere instead of
  // refusing, and the session + binding are born in the window that keeps them.
  // (Single-pane desktop only; the multi-pane deps have no spawnJoinWindow.)
  // Counts as consumed: the join continues in the spawned window.
  if (deps.spawnJoinWindow?.(code.trim())) return true;
  // Don't overwrite a doc that's ITSELF in a session (spawnJoinWindow already
  // redirected windows holding a real doc; this guards the edge case).
  if (sessionFor(deps.getOwnerUid?.())) {
    showToast('This document is in a session — end or leave it before joining here');
    return false;
  }
  await ensureBakedRelay();
  // Own credentials (baked token / linked account / self-host settings)
  // outrank a guest pass — they're strictly more capable. The pass is
  // the fallback that lets an account-less browser join at all.
  const client =
    relayClient() ?? (opts?.guestPass ? relayClientWithGuestPass(opts.guestPass) : null);
  if (!client) {
    showToast(`No relay connection — ${RELAY_FIX_PATH}`);
    return false;
  }
  const decoded = decodeShareCode(code);
  if (!decoded) {
    showToast('That does not look like a share code');
    return false;
  }
  // v2 codes carry the room's compatibility floor. (Old builds never
  // get this far — the v2 format fails their parser above — this check
  // is for FUTURE floors above the running version.)
  if (decoded.minVersion && compareAppVersions(appVersion, decoded.minVersion) < 0) {
    showToast(
      `This session needs CardMirror ${decoded.minVersion} or newer — update to join.`,
    );
    return false;
  }
  // A resumable record for this room means WE'VE been in it before — resume
  // instead of fresh-joining, so the record's unsynced local edits flush to
  // the room. A fresh join minted a second copy from the relay state, and a
  // later Leave deleted the old record, making those edits unrecoverable
  // (audit find, 2026-07-10).
  if (await loadSessionRecord(decoded.roomId)) {
    return resumeSessionFlow(deps, decoded.roomId);
  }
  // Resolved after newSessionDoc/installSeams; callbacks read it lazily.
  let sessRef: ActiveSession | null = null;
  try {
    let session: CollabSession;
    let joinedOffline = false;
    try {
      session = await CollabSession.join({
        ...decoded,
        client,
        callbacks: sessionCallbacks(deps, () => sessRef),
      });
      session.guestPass = opts?.guestPass ?? null;
    } catch (err) {
      // An ENDED (410) or expired/GC'd (404) room is not an offline
      // condition — the seed would resume a session that no longer exists.
      // Surface it as ended.
      if (err instanceof RoomsError && (err.status === 410 || err.status === 404)) throw err;
      // Offline (or relay unreachable): fall back to the invite's
      // prefetched seed (§4.1). Everything in it came FROM the room,
      // so resume() with no sentVersion is exact; start() syncs at the
      // next connectivity window.
      const pre = await loadPrefetch(decoded.roomId);
      if (!pre) throw err;
      const key = await importRoomKey(decoded.keyBytes);
      const blobs = await Promise.all(pre.blobs.map((b) => decryptBlob(key, b)));
      session = await CollabSession.resume({
        roomId: decoded.roomId,
        keyBytes: decoded.keyBytes,
        role: 'participant',
        snapshot: blobs[0]!,
        increments: blobs.slice(1),
        lastSeq: pre.lastSeq,
        client,
        callbacks: sessionCallbacks(deps, () => sessRef),
      });
      joinedOffline = true;
    }
    // Create the fresh unsaved session doc — its uid is the session owner
    // (single-pane swaps this window's doc; multi-pane slot-picks). A false
    // return = the user balked (overwrite prompt / slot picker) — unwind
    // without touching the room AND keep the prefetched seed: the invite
    // stays retryable.
    if (!(await deps.newSessionDoc())) {
      await session.stop();
      showToast('Join cancelled');
      return false;
    }
    // The session owner is the doc newSessionDoc() just created — capture its
    // uid NOW, before any later focus change, so the seams bind into it.
    const ownerUid = deps.getOwnerUid?.() ?? '';
    sessRef = installSeams(session, deps, code.trim(), ownerUid);
    // Add the binding to the fresh doc's view — its init replaces the
    // empty content with the session's CRDT state synchronously (~10s
    // on a tournament-master-sized doc), but only after a setTimeout(0)
    // deferral inside the sync plugin: the veil's removal is queued
    // BEHIND that init (FIFO), or it vanishes before the freeze starts.
    const prepDone = await sessionPrepOverlay(
      'Opening the shared document — a large document can take a moment…',
    );
    try {
      deps.refreshPlugins();
      // The join snapshot already carries the host's thread map — land it
      // in the fresh pane's plugin state; same for the published title.
      sessRef.commentsSync.pull();
      adoptSharedTitle(deps, session);
      session.start();
    } finally {
      // FIFO with the binding's own setTimeout(0) init — see the host
      // flow's finally for why this is a timeout, not an await.
      setTimeout(prepDone, 0);
    }
    sessRef.lastStatus = { connected: !joinedOffline, queuedUpdates: 0 };
    updateChip({ connected: !joinedOffline, queuedUpdates: 0 });
    // Only NOW is the seed spent — the join is committed (for the offline
    // path the seed's content lives on in the session + its persist record).
    void deletePrefetch(decoded.roomId).catch((e) => surfaceError('collab seed cleanup', e));
    showToast(
      joinedOffline
        ? 'Joined from the prefetched copy — will sync when you reconnect'
        : 'Joined the session',
    );
    deps.getView()?.focus();
    return true;
  } catch (err) {
    if (sessRef) void teardownSession(sessRef).catch((e) => surfaceError('collab teardown', e));
    // A dead room's invite and seed are useless — purge the seed and report
    // consumed so the Receive pill clears the row. Every other failure keeps
    // both, so the user can retry once the network/slot situation changes.
    const ended = err instanceof RoomsError && (err.status === 410 || err.status === 404);
    if (ended) void deletePrefetch(decoded.roomId).catch((e) => surfaceError('collab seed cleanup', e));
    showToast(relayFailureMessage(err, { initiating: false, verb: 'join' }));
    return ended;
  }
}

/** Resume a persisted session (home-screen Sessions list, M3). The
 *  persisted CRDT carries this peer's full history — including edits
 *  that never reached the relay before the app died — so start()'s
 *  first flush sends exactly the unsent diff and catch-up resumes from
 *  the stored cursor. A tombstoned room degrades through the normal
 *  onEnded path ("this copy is now yours alone") and clears the record.
 *  Returns true when the session is live in this window afterwards (also
 *  when it already was) — joinSessionWithCode delegates here for rooms
 *  with a resumable record, and the Receive pill consumes the invite on
 *  true. */
export async function resumeSessionFlow(
  deps: CollabUiDeps,
  roomId: string,
  opts?: { existingDoc?: boolean },
): Promise<boolean> {
  if (!collabEnabled()) return false; // desktop-only; inert on the web edition
  // No up-front view requirement: unless resuming into an existing doc, the
  // flow creates its own via deps.newSessionDoc (multi-pane may be an empty
  // workspace reached from the home screen's Sessions list).
  if (opts?.existingDoc && !deps.getView()) return false;
  if (sessionFor(deps.getOwnerUid?.())) {
    showToast('This document is in a session — end or leave it first');
    return false;
  }
  for (const s of sessions.values()) {
    if (s.session.roomId === roomId) {
      showToast('That session is already active in this window');
      // Already live here — an invite for it is redundant, so report success.
      return true;
    }
  }
  // Cross-WINDOW guard: another window holding this room live claims its
  // synthetic key in the duplicate-open registry; probing it also focuses
  // that window (so the user lands on the live session, not an error).
  if (await roomLiveElsewhere(roomId)) {
    showToast('That session is already open in another CardMirror window.');
    return true; // live elsewhere — an invite/row for it is redundant here
  }
  const record = await loadSessionRecord(roomId);
  if (!record) {
    showToast('No saved session to resume');
    return false;
  }
  await ensureBakedRelay();
  const client =
    relayClient() ??
    (record.guestPass ? relayClientWithGuestPass(record.guestPass) : null);
  if (!client) {
    showToast(`No relay connection — ${RELAY_FIX_PATH}`);
    return false;
  }
  const decoded = decodeShareCode(record.shareCode);
  if (!decoded) {
    showToast('Saved session record is unreadable');
    return false;
  }
  let sessRef: ActiveSession | null = null;
  try {
    const session = await CollabSession.resume({
      roomId: record.roomId,
      keyBytes: decoded.keyBytes,
      role: record.role,
      snapshot: record.snapshot,
      increments: record.increments,
      lastSeq: record.lastSeq,
      sentVersion: record.sentVersion,
      client,
      callbacks: sessionCallbacks(deps, () => sessRef),
    });
    session.guestPass = record.guestPass ?? null;
    // Host resume without a stored pass: re-mint so fresh invite links
    // stay possible (no-op 404 while the relay flip is off, and guests
    // never pass the send-auth gate on this endpoint).
    if (record.role === 'host' && !session.guestPass) {
      void client.fetchGuestPass(record.roomId).then((p) => {
        if (p) session.guestPass = p;
      });
    }
    // Fresh doc first — its uid owns the session. A false return keeps the
    // record (still resumable) — no seams installed yet, so nothing to unwind.
    // EXCEPT `existingDoc`: bind into an ALREADY-open doc under its uid instead
    // of creating one (the binding replaces its content with the CRDT's —
    // same doc). A capability for resuming in place; no caller today.
    if (!opts?.existingDoc && !(await deps.newSessionDoc())) {
      await session.stop();
      showToast('Resume cancelled');
      return false;
    }
    // Owner = the doc that will hold the session: for existingDoc it is the
    // already-open doc under its uid; otherwise the fresh doc newSessionDoc()
    // just made (single-pane swap, or multi-pane slot). Capture past the awaits.
    const ownerUid = deps.getOwnerUid?.() ?? '';
    sessRef = installSeams(session, deps, record.shareCode, ownerUid);
    deps.refreshPlugins();
    sessRef.commentsSync.pull();
    adoptSharedTitle(deps, session);
    session.start();
    sessRef.lastStatus = { connected: false, queuedUpdates: session.queuedUpdates };
    updateChip({ connected: false, queuedUpdates: session.queuedUpdates });
    showToast('Session resumed — syncing');
    deps.getView()?.focus();
    return true;
  } catch (err) {
    // KEEP the record on a failed resume: it existed before this attempt and
    // may hold unsynced edits — the default teardown would delete it (audit
    // find, 2026-07-10). Still resumable from the Sessions list.
    if (sessRef) void teardownSession(sessRef, /* keepRecord */ true).catch((e) => surfaceError('collab teardown', e));
    showToast(relayFailureMessage(err, { initiating: false, verb: 'resume' }));
    return false;
  }
}

export async function copyInviteLinkFlow(): Promise<void> {
  const sess = actionSession();
  if (!sess) {
    showToast('This document has no active session');
    return;
  }
  const link = buildJoinLink({
    shareCode: sess.shareCode,
    guestPass: sess.session.guestPass,
  });
  const ok = await navigator.clipboard?.writeText(link).then(
    () => true,
    () => false,
  );
  showToast(ok ? 'Invite link copied' : 'Could not copy the invite link');
}

export async function copyShareCodeFlow(): Promise<void> {
  const sess = actionSession();
  if (!sess) {
    showToast('This document has no active session');
    return;
  }
  const ok = await navigator.clipboard?.writeText(sess.shareCode).then(
    () => true,
    () => false,
  );
  showToast(ok ? 'Share code copied' : 'Could not copy the share code');
}

/** Re-publish the owner doc's display name to its live session's meta
 *  map. Host-only (the shared title tracks the HOST's file; a joiner's
 *  local Save-As must not rename the session for everyone), and a
 *  no-op without a session for `uid`, without a resolvable name, or
 *  when the name is unchanged. The shells call this whenever a doc's
 *  filename commits (Save / Save-As), so a session started on an
 *  untitled doc gets its name the moment the host saves — and every
 *  joiner's meta subscription adopts it live. */
export function republishSessionTitle(uid: string | null): void {
  if (!uid) return;
  const sess = sessions.get(uid);
  if (!sess || sess.session.role !== 'host') return;
  const name = sessionDocTitle(uid);
  if (!name || name === sharedDocTitle(sess.session)) return;
  sess.session.loroDoc.getMap('meta').set('title', name);
  sess.session.loroDoc.commit({ origin: META_COMMIT_ORIGIN });
}

/** The host-published doc title from the room's meta map ('' when the
 *  host predates title publishing or hasn't named the doc). */
function sharedDocTitle(session: CollabSession): string {
  const t = session.loroDoc.getMap('meta').get('title');
  return typeof t === 'string' ? t.trim() : '';
}

/** Adopt the shared title in this window (joiner/resume paths). */
function adoptSharedTitle(deps: CollabUiDeps, session: CollabSession): void {
  const title = sharedDocTitle(session);
  if (title) deps.setDocTitle?.(title);
}

/** The name to publish/label a session with: the OWNER doc's own filename (via
 *  the host-set resolver), NOT `document.title` — in multi-pane that's every
 *  open doc joined by " · ", so a joiner would inherit a window title naming all
 *  of the host's open docs. Falls back to parsing the single-doc window title
 *  when no resolver is set (tests / pre-wire) or the uid can't be resolved. */
function sessionDocTitle(ownerUid: string | null | undefined): string {
  const byUid = ownerUid ? docTitleResolver?.(ownerUid) : null;
  if (byUid != null) return byUid.trim();
  const t = document.title;
  const cut = t.lastIndexOf(' — CardMirror');
  if (cut > 0) return t.slice(0, cut);
  return t === 'CardMirror' ? '' : t;
}

/** Shared invite-send tail: sealed pairing message, version-floored so
 *  pre-invite clients get the update-required toast instead of a dead
 *  card row. Assumes an active session. */
async function sendInviteTo(
  target: { codes: string[]; label: string; via?: string },
  shareCode: string,
  ownerUid: string | null | undefined,
): Promise<void> {
  const item = buildRoomInviteItem({
    shareCode,
    title: sessionDocTitle(ownerUid),
  });
  // Movable-format rooms carry the higher floor: a pre-movable build
  // joining one couldn't read its containers at all, so it must get
  // the decline-with-update-toast instead of a broken join.
  const format = actionSession()?.session.childrenFormat() ?? 'list';
  const res = await pairingRelayClient.send(target.codes, item, {
    via: target.via,
    minReceiverVersion: roomInviteFloor(format),
  });
  if (res.fail === 0) showToast(`Invited ${target.label} ✓`);
  else if (res.ok === 0) showToast(`Couldn't reach ${target.label}`);
  else showToast(`Invited ${target.label} (${res.fail} failed)`);
}

/** Send a session invite to the starred partner/group. */
export async function inviteStarredFlow(): Promise<void> {
  if (!collabEnabled()) return;
  const sess = actionSession();
  if (!sess) {
    showToast('This document has no active session — start one first');
    return;
  }
  if (!settings.get('pairingEnabled')) {
    showToast('Card sharing is off — invites travel through it');
    return;
  }
  const target = resolveStarredTarget(
    settings.get('pairingStarred'),
    settings.get('pairingPartners'),
    settings.get('pairingGroups'),
  );
  if (!target) {
    showToast('Star a partner or group in the Send pill first');
    return;
  }
  if (target.codes.length === 0) {
    showToast('The starred group has no recipients yet');
    return;
  }
  await sendInviteTo(target, sess.shareCode, sess.ownerUid);
}

/** The Send pill's click-to-invite (§6 picker-first flow): with no
 *  active session, START one on the current doc, then invite the
 *  picked partner/group; with one active, just invite. */
export async function inviteTargetFlow(
  deps: CollabUiDeps,
  target: { codes: string[]; label: string; via?: string },
): Promise<void> {
  if (!collabEnabled()) return;
  if (!settings.get('pairingEnabled')) {
    showToast('Card sharing is off — invites travel through it');
    return;
  }
  if (target.codes.length === 0) {
    showToast('That group has no recipients yet');
    return;
  }
  let sess = sessionFor(deps.getOwnerUid?.());
  if (!sess) {
    await startSessionFlow(deps);
    sess = sessionFor(deps.getOwnerUid?.());
    if (!sess) return; // start failed/cancelled — its toast explains
  }
  await sendInviteTo(target, sess.shareCode, sess.ownerUid);
}

/** Terminate/leave a session and clear its resumable record — the shared core
 *  of the explicit End command and the close dialog's End/Leave choice (no
 *  prompt; the caller already confirmed). Host ends for everyone (tombstones the
 *  room); a participant just disconnects. */
/** End (host) or leave (guest) a session. Returns false when a host End
 *  couldn't tombstone the room (offline / filtered network) — the session is
 *  left LIVE and nothing is torn down, so the caller must abort whatever
 *  close it was driving. Reporting success without the tombstone let invited
 *  peers keep editing a room the host believed was over, with the local
 *  record (the host's only handle for ending it) already deleted (audit +
 *  field find, 2026-07-10). A guest Leave has no server side and always
 *  succeeds. */
async function endOrLeaveSession(sess: ActiveSession): Promise<boolean> {
  const isHost = sess.session.role === 'host';
  const wasChip = isChipSession(sess.ownerUid);
  // Disconnect first (final drain attempt), THEN tombstone for a host end —
  // and only tear down once the room is actually gone. endRoomOnRelay treats
  // an already-ended/expired room (410/404) as success.
  await sess.session.stop();
  if (isHost) {
    try {
      await endRoomOnRelay(sess.session.roomId);
    } catch (err) {
      // Reconnect and keep the session (and its record) intact — the user
      // retries once the relay is reachable.
      sess.session.start();
      showToast(
        `Couldn't end the session — check your connection and try again. (${err instanceof Error ? err.message : err})`,
      );
      return false;
    }
  }
  // Registry drop before the record delete, so a late stream frame's
  // onEnded no-ops.
  const cleared = teardownSession(sess);
  void wasChip;
      refreshChipForFocus(); // repaint from live truth — a stale wasChip snapshot left ghost chips (field find, 2026-08-12)
  await cleared; // record actually gone before we return
  return true;
}

/** Close a co-edited doc but KEEP its session resumable: disconnect (a final
 *  drain attempt), persist the CRDT — including edits that never reached the
 *  relay — then drop the live binding while leaving the stored record behind.
 *  The home-screen Sessions list resumes it; unsynced edits flush on rejoin.
 *  Called from the always-loaded close paths via collab-hooks. */
async function closeKeepResumableSession(uid: string): Promise<boolean> {
  const sess = sessionFor(uid);
  if (!sess) return true;
  const wasChip = isChipSession(sess.ownerUid);
  await sess.session.stop(); // disconnect only — the room + record survive
  // Capture the final state (incl. any still-unsynced edits) AFTER the drain so
  // sentVersion is accurate — VERIFIED: the close path drops the recovery
  // journal, so this record is about to be the doc's only copy. A silent
  // storage failure must abort the close, not lose the doc (audit find,
  // 2026-07-10).
  if (!(await sess.persist.verifiedFlush())) {
    sess.session.start(); // reconnect; the session stays live, caller aborts
    return false;
  }
  void teardownSession(sess, /* keepRecord */ true).catch((e) => surfaceError('collab teardown', e));
  void wasChip;
      refreshChipForFocus(); // repaint from live truth — a stale wasChip snapshot left ghost chips (field find, 2026-08-12)
  return true;
}

/** Close a co-edited doc by ending/leaving its session (clears the record).
 *  False = a host End failed to tombstone; nothing was torn down. */
async function closeEndOrLeaveSession(uid: string): Promise<boolean> {
  const sess = sessionFor(uid);
  if (!sess) return true;
  return endOrLeaveSession(sess);
}

export async function endSessionFlow(deps: CollabUiDeps): Promise<void> {
  // Ends the FOCUSED doc's session (the one the user is looking at).
  const sess = sessionFor(deps.getOwnerUid?.());
  if (!sess) {
    showToast('No active session');
    return;
  }
  const isHost = sess.session.role === 'host';
  // In-app overlay, NOT window.confirm: Electron's native confirm on
  // Windows/Linux never hands keyboard focus back to the renderer —
  // the editor was untypeable until a reload (field bug, 2026-07-03).
  const choice = await confirmDialog(
    isHost ? 'Participants keep their current copy.' : 'Your copy stays as it is now.',
    {
      title: isHost ? 'End the session for everyone?' : 'Leave the session?',
      okLabel: isHost ? 'End Session' : 'Leave Session',
    },
  );
  if (!choice) return;
  // A failed host End (relay unreachable) already toasted and left the
  // session live — don't repaint plugins or claim success.
  if (!(await endOrLeaveSession(sess))) return;
  if (deps.refreshPluginsForUid) deps.refreshPluginsForUid(sess.ownerUid);
  else deps.refreshPlugins();
  showToast(isHost ? 'Session ended' : 'Left the session');
  deps.getView()?.focus();
}

/** Test seam: the session the user is looking at (focused doc's, or the sole
 *  session), or null. */
export function activeSession(): CollabSession | null {
  return chipSession()?.session ?? null;
}

/** Recover Previous Version command body. Lives here (not in the
 *  recover module) so the lazy-loaded collab-ui module is the single
 *  entry point index.ts's command wiring already uses, and so the
 *  recover module needs no import back into this one. */
export async function recoverPreviousVersionFlow(
  openDoc?: import('./collab-recover-ui.js').OpenRecoveredDoc,
  solo?: {
    docId: string | null;
    docTitle: string;
    currentDoc?: import('prosemirror-model').Node | null;
  },
): Promise<void> {
  const m = await import('./collab-recover-ui.js');
  await m.openRecoverPreviousVersion(activeSession(), openDoc, solo);
}
