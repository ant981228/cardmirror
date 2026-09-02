/**
 * Zero-dependency seams between the always-loaded editor core and the
 * lazily-loaded collab module (which pulls in the Loro wasm — never on
 * the startup path).
 *
 * The transaction tagger runs inside `dispatchTransaction` BEFORE
 * `state.apply`, so metas it sets are visible to every
 * `filterTransaction` (read mode, AI edit coordinator). The active
 * collab module registers a tagger that stamps the sync-origin meta on
 * the Loro binding's remote transactions; with no session active this
 * is a null-check per dispatch.
 *
 * The plugin source lets `buildEditorPlugins` include a live session's
 * binding plugins, and signals that the session owns undo (the CRDT
 * undo manager reverts only this peer's edits — prosemirror-history
 * cannot guarantee that once remote transactions interleave).
 */

import type { Command, Plugin, Transaction } from 'prosemirror-state';

export interface CollabPluginSource {
  /** The `DocRecord.uid` of the ONE document this session owns — the registry
   *  key. Only that document's view receives the binding plugins; every other
   *  pane stays independent (the multi-pane fusion guard), and a window can hold
   *  one session per open doc. */
  ownerUid: string | null;
  /** Binding plugins for the active session (sync, undo, cursors). */
  plugins(): Plugin[];
  /** True while the session owns undo — `history()` is excluded and
   *  Mod-Z / Mod-Y route to `undo` / `redo` below. */
  ownsUndo(): boolean;
  undo: Command;
  redo: Command;
}

let tagger: ((tr: Transaction) => void) | null = null;
// One live session per OWNING doc uid. A multi-pane window can therefore hold
// several independent sessions; each doc's view only ever sees its own.
const pluginSources = new Map<string, CollabPluginSource>();

export function setCollabTransactionTagger(fn: ((tr: Transaction) => void) | null): void {
  tagger = fn;
}

/** Called from dispatchTransaction on every tr; no-op when dormant. */
export function tagCollabTransaction(tr: Transaction): void {
  tagger?.(tr);
}

/** Register a live session's binding plugins, keyed by the doc it owns. */
export function registerCollabPluginSource(src: CollabPluginSource): void {
  if (src.ownerUid == null) return; // unownable session can't be scoped
  pluginSources.set(src.ownerUid, src);
}

/** Drop the session owned by `ownerUid` (on end/leave). */
export function unregisterCollabPluginSource(ownerUid: string | null): void {
  if (ownerUid != null) pluginSources.delete(ownerUid);
}

/** The plugin source owned by `uid`, or null — for undo/redo routing and the
 *  per-view `ownsUndo` decision. */
export function collabPluginSourceFor(uid: string | null | undefined): CollabPluginSource | null {
  return uid != null ? pluginSources.get(uid) ?? null : null;
}

/** True if ANY session is live in this window (dormant-fast-path check). */
export function anyCollabSessionActive(): boolean {
  return pluginSources.size > 0;
}

/**
 * A session's binding plugins for the view identified by `targetUid`, or `[]`.
 * THE multi-pane fusion guard: a session's plugins attach ONLY to its own owning
 * doc's view. Every other pane — and the null/omitted uid — gets nothing, so
 * opening a second document while a session is live can never bind that pane to
 * a session's shared LoroDoc and overwrite it.
 */
export function collabPluginsFor(targetUid: string | null | undefined): Plugin[] {
  return collabPluginSourceFor(targetUid)?.plugins() ?? [];
}

/** Invite-join seam: the Receive pill (always-loaded pairing UI) hands a
 *  share code from a `room-invite` inbox item to the lazily-loaded collab
 *  module. Registered from editor/index.ts alongside the other collab
 *  ribbon wiring; null while the collab gate is closed. */
let inviteJoiner: ((shareCode: string) => Promise<boolean>) | null = null;

/** The resolved boolean reports whether the join landed (or was handed off
 *  to a spawned window) — the Receive pill consumes the invite row only
 *  then, so a cancelled or failed join keeps the share code retryable. */
export function setCollabInviteJoiner(fn: ((shareCode: string) => Promise<boolean>) | null): void {
  inviteJoiner = fn;
}

export function collabInviteJoiner(): ((shareCode: string) => Promise<boolean>) | null {
  return inviteJoiner;
}

/** A pairing recipient resolved by the Send pill (one partner, or a
 *  group fanned out to its members). */
export interface CollabInviteTarget {
  codes: string[];
  label: string;
  via?: string;
}

/** Invite-send seam: the Send pill's click mode hands a picked
 *  partner/group to the lazily-loaded collab module, which starts a
 *  session on the current doc if none is active and sends the invite
 *  (§6's picker-first flow). Null while the collab gate is closed. */
let inviter: ((target: CollabInviteTarget) => void) | null = null;

export function setCollabInviter(fn: ((target: CollabInviteTarget) => void) | null): void {
  inviter = fn;
}

export function collabInviter(): ((target: CollabInviteTarget) => void) | null {
  return inviter;
}

/** Start-session seam: the Send pill's click mode triggers the same
 *  flow as the Start Collaboration Session command on the current doc.
 *  Null while the collab gate is closed. */
let sessionStarter: (() => void) | null = null;

export function setCollabSessionStarter(fn: (() => void) | null): void {
  sessionStarter = fn;
}

export function collabSessionStarter(): (() => void) | null {
  return sessionStarter;
}

/** Join-session seam: the Receive pill's footer button triggers the
 *  same prompt-for-a-code flow as the Join Collaboration Session
 *  command. Null until the editor wires it at startup. */
let sessionJoinPrompt: (() => void) | null = null;

export function setCollabSessionJoinPrompt(fn: (() => void) | null): void {
  sessionJoinPrompt = fn;
}

export function collabSessionJoinPrompt(): (() => void) | null {
  return sessionJoinPrompt;
}

/** Focused doc's live session share code, or null. Registered by
 *  collab-ui at module load — before that no session can exist, so
 *  null (= "Start session") is always right. The Send pill uses this
 *  to swap its action to "Copy code" when the doc you're looking at
 *  is already in a session. */
let shareCodeGetter: (() => string | null) | null = null;

export function setCollabShareCodeGetter(fn: (() => string | null) | null): void {
  shareCodeGetter = fn;
}

export function collabActiveShareCode(): string | null {
  return shareCodeGetter?.() ?? null;
}

/** Focused doc's session INVITE LINK (share code + guest pass packed
 *  for the web joiner) — same registration pattern as the share code. */
let inviteLinkGetter: (() => string | null) | null = null;

export function setCollabInviteLinkGetter(fn: (() => string | null) | null): void {
  inviteLinkGetter = fn;
}

export function collabActiveInviteLink(): string | null {
  return inviteLinkGetter?.() ?? null;
}

/** Live copresence for one open doc's session — connection status + who's here —
 *  read by the multi-pane shell to paint each slot's footer with ITS visible
 *  doc's session state. Provided by the lazily-loaded collab-ui once it's up;
 *  null before then (footers stay blank). Kept here (the zero-dependency seam)
 *  so the always-loaded shell never imports the heavy collab module. */
export interface CollabCopresence {
  /** This peer's role in the session — drives the close dialog's End-vs-Leave
   *  wording (a host ends for everyone; a participant leaves). */
  role: 'host' | 'participant';
  connected: boolean;
  queued: number;
  peers: { name: string; color: string; self: boolean }[];
}

let copresenceProvider: ((uid: string) => CollabCopresence | null) | null = null;

export function setCollabCopresenceProvider(
  fn: ((uid: string) => CollabCopresence | null) | null,
): void {
  copresenceProvider = fn;
}

/** Copresence for the doc `uid`, or null when it has no live session (or collab
 *  isn't loaded). */
export function collabCopresenceFor(uid: string | null | undefined): CollabCopresence | null {
  return uid != null && copresenceProvider ? copresenceProvider(uid) : null;
}

const copresenceListeners = new Set<() => void>();

/** Subscribe to copresence changes (a session starting/ending, a status update,
 *  or a presence tick). Returns an unsubscribe. The shell repaints every slot
 *  footer on each fire. */
export function onCollabCopresenceChange(fn: () => void): () => void {
  copresenceListeners.add(fn);
  return () => {
    copresenceListeners.delete(fn);
  };
}

/** Fire the copresence listeners — called by collab-ui whenever a session's
 *  status/presence changes or a session starts/ends. No-op with no listeners. */
let copresenceNotifyTimer: ReturnType<typeof setTimeout> | null = null;
let copresenceNotifyPending = false;
/** Leading + trailing coalescing: the first call in a quiet period
 *  fires synchronously (session start/end must paint at once); calls
 *  inside the next 150ms collapse into ONE trailing notification.
 *  While typing, emitStatus flips queuedUpdates 0→1→0 for every post,
 *  and each flip repainted every slot footer — each calling into the
 *  wasm presence store (2026-09-01 review, PH-A11). */
export function notifyCollabCopresenceChange(): void {
  if (copresenceNotifyTimer !== null) {
    copresenceNotifyPending = true;
    return;
  }
  for (const fn of copresenceListeners) fn();
  copresenceNotifyTimer = setTimeout(() => {
    copresenceNotifyTimer = null;
    if (copresenceNotifyPending) {
      copresenceNotifyPending = false;
      notifyCollabCopresenceChange();
    }
  }, 150);
}

/** Close-time session actions, provided by collab-ui. When a co-edited doc
 *  closes, it either KEEPS its session resumable (persist the CRDT — including
 *  unsynced edits — drop the live binding, disconnect; the user rejoins from the
 *  home-screen Sessions list and their changes sync then) or ENDS/LEAVES it
 *  (host ends for everyone / guest leaves, clearing the resumable record). The
 *  always-loaded close paths (multi-pane shell + single-doc) call these; both
 *  no-op when collab isn't loaded — a doc with no session never reaches them. */
let closeActions: {
  keepResumable: (uid: string) => Promise<boolean>;
  endOrLeave: (uid: string) => Promise<boolean>;
} | null = null;

export function setCollabCloseActions(
  a: {
    keepResumable: (uid: string) => Promise<boolean>;
    endOrLeave: (uid: string) => Promise<boolean>;
  } | null,
): void {
  closeActions = a;
}

/** Close `uid`'s doc but keep its session resumable (persist + disconnect).
 *  False = the record write could not be verified — the session stays LIVE
 *  and the caller must abort the close (the record would have been the doc's
 *  only copy). */
export function collabCloseKeepResumable(uid: string): Promise<boolean> {
  return closeActions?.keepResumable(uid) ?? Promise.resolve(true);
}

/** End (host) or leave (guest) `uid`'s session, clearing the resumable record.
 *  False = a host End couldn't tombstone the room (relay unreachable); the
 *  session stays live and the caller must abort the close. */
export function collabEndOrLeaveSession(uid: string): Promise<boolean> {
  return closeActions?.endOrLeave(uid) ?? Promise.resolve(true);
}

/** Mode-switch flush: the single↔three-pane toggle is a full page reload, so a
 *  live session is torn down by it. Before reloading, FLUSH each live session's
 *  record so unsynced edits persist, and return each one's {uid, roomId}. The
 *  co-edited docs then close across the toggle (excluded from the reopen marker)
 *  and stay resumable from the home-screen Sessions list — the uids are how the
 *  toggle knows which docs those are. Provided by collab-ui; resolves [] when
 *  collab isn't loaded (no sessions — always the case on web). */
let handoffProvider: (() => Promise<{ uid: string; roomId: string }[]>) | null = null;

export function setCollabHandoffProvider(
  fn: (() => Promise<{ uid: string; roomId: string }[]>) | null,
): void {
  handoffProvider = fn;
}

export function collabCaptureSessionHandoff(): Promise<{ uid: string; roomId: string }[]> {
  return handoffProvider?.() ?? Promise.resolve([]);
}

/** How many live co-editing sessions this window holds — a synchronous, no-flush
 *  read for the mode-switch confirm dialog (which must warn BEFORE the user
 *  commits). Provided by collab-ui; 0 when collab isn't loaded. */
let sessionCountProvider: (() => number) | null = null;

export function setCollabSessionCountProvider(fn: (() => number) | null): void {
  sessionCountProvider = fn;
}

export function collabLiveSessionCount(): number {
  return sessionCountProvider?.() ?? 0;
}

/** Is a session for `roomId` live in THIS window? Synchronous probe for the
 *  always-loaded paths (home-screen Sessions rows) that must refuse before
 *  spawning a window. Provided by collab-ui; false when collab isn't loaded. */
let liveRoomProbe: ((roomId: string) => boolean) | null = null;

export function setCollabLiveRoomProbe(fn: ((roomId: string) => boolean) | null): void {
  liveRoomProbe = fn;
}

export function collabRoomIsLive(roomId: string): boolean {
  return liveRoomProbe?.(roomId) ?? false;
}

/** Focus moved between docs: the lazily-loaded collab UI repaints the shared
 *  chip from the newly-focused doc's session — it otherwise held the previous
 *  doc's label until that session's next status event (audit find,
 *  2026-07-10). No-op until the collab module loads. */
let focusChangeHandler: (() => void) | null = null;

export function setCollabFocusChangeHandler(fn: (() => void) | null): void {
  focusChangeHandler = fn;
}

export function notifyCollabFocusChange(): void {
  focusChangeHandler?.();
}

/** Cross-WINDOW live-session guard: while a session is live, its window holds
 *  a claim on this synthetic key in the same main-process registry the
 *  duplicate-file-open guard uses (`openPathRegister`/`openPathCheck`) — so
 *  probing it focuses the owning window and cleans up stale claims for free.
 *  The prefix keeps the keys disjoint from every real file path. */
export function collabRoomClaimKey(roomId: string): string {
  return `cardmirror-collab-room://${roomId}`;
}
