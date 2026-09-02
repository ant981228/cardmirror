/**
 * CollabSession — one collaboration session: a LoroDoc, the encrypted
 * room transport, and the sync discipline between them.
 *
 * Data flow:
 *   outbound  editor → LoroSyncPlugin → LoroDoc → (flush timer)
 *             export update-since-lastSent → encrypt → POST /updates
 *   inbound   SSE update frame (or catch-up GET) → decrypt →
 *             importBatch → Loro events → LoroSyncPlugin → editor
 *
 * Version bookkeeping invariant: everything covered by `lastSentVersion`
 * has either been queued for send or arrived from remote. `applyRemote`
 * therefore SYNCHRONOUSLY exports any un-flushed local diff before
 * importing (export is cheap and synchronous; only the POST is async) —
 * otherwise the next flush would re-export freshly imported remote ops
 * and echo them back to the room (harmless — updates are idempotent —
 * but wasteful at travel-day scale).
 *
 * Delivery discipline (mirrors card sharing): the stream is push-first;
 * every (re)connect hello triggers a catch-up fetch from our own cursor,
 * and a low-frequency catch-up timer heals stream frames the server shed
 * under backpressure. A shed frame is at worst a temporarily missing
 * causal dependency — Loro queues ops whose deps are absent and applies
 * them when the catch-up supplies the rest.
 *
 * The seed state travels as the room's FIRST regular update (a Loro
 * snapshot blob is just importable data), so joining is uniformly
 * "fetch everything after 0". The snapshot ENDPOINT is only compaction:
 * the host periodically uploads an encrypted snapshot so the server can
 * truncate the log and joins stay fast on long sessions.
 */

import { LoroDoc, VersionVector, decodeImportBlobMeta } from 'loro-crdt';
import type { Node as PMNode } from 'prosemirror-model';
import type { Plugin } from 'prosemirror-state';
import { EditorState } from 'prosemirror-state';
import { LoroSyncPlugin, updateLoroToPmState } from 'loro-prosemirror';
import { appVersion } from '../install-info.js';
import { compareAppVersions, MOVABLE_ROOMS_MIN_VERSION } from '../relay-protocol.js';
import { schema } from '../../schema/index.js';
import {
  bytesToBase64,
  decryptBlob,
  encryptBlob,
  encodeShareCode,
  generateRoomKeyBytes,
  importRoomKey,
} from './collab-crypto.js';
import {
  RoomsClient,
  RoomsError,
  RoomStream,
  type RoomUpdate,
  type StreamStats,
  type TransportStats,
} from './room-client.js';

type SyncDoc = Parameters<typeof LoroSyncPlugin>[0]['doc'];

/** Mirrors loro-prosemirror's configLoroTextStyle: PM `inclusive` is the
 *  local statement of Peritext expand behavior; the CRDT-level config
 *  makes CONCURRENT boundary insertions honor the same intent. Must be
 *  set before any ops are created on the doc. Exported so the history
 *  recovery path configures its scratch docs identically — a mismatch
 *  would change mark-expansion behavior on the recovered copy. */
/**
 * Seed format for NEW rooms: builds at/after MOVABLE_ROOMS_MIN_VERSION
 * seed movable-list children (the binding's per-room inheritance then
 * keeps every container in the room matching the root, whatever build
 * touches it later). Betas seed plain lists, so this line is dormant
 * until the version crosses the floor — ship-and-forget for v1.0.
 * Module-scope on purpose: the flag only matters at ROOT creation, and
 * a per-build constant can't race anything.
 */
globalThis.__CM_MOVABLE_LIST__ = compareAppVersions(appVersion, MOVABLE_ROOMS_MIN_VERSION) >= 0;

export function configTextStyle(doc: LoroDoc): void {
  doc.configTextStyle(
    Object.fromEntries(
      Object.entries(schema.marks).map(([name, type]) => [
        name,
        { expand: type.spec.inclusive !== false ? ('after' as const) : ('none' as const) },
      ]),
    ),
  );
}

export interface CollabSessionCallbacks {
  /** Connection or queue state changed (drives the sync-status UI). */
  onStatus?: (status: { connected: boolean; queuedUpdates: number }) => void;
  /** The relay rejected our credentials (401/403) MID-SESSION — fired once
   *  per session so the UI can say so (otherwise the retry loop is
   *  indistinguishable from being offline). Retrying continues at the
   *  backoff ceiling in case the entitlement returns. */
  onAuthRejected?: () => void;
  /** A GUEST-PASS session's pass was refused by the relay (twice,
   *  portal-checked — see RoomStream.onAuthDead). Terminal cause
   *  notice: the pass is immutable and guests cannot re-mint, so the
   *  session is about to end (onEnded follows immediately). Lets the
   *  UI say WHY — "invite expired" — where onEnded's toast only says
   *  what. */
  onGuestAuthExpired?: () => void;
  /** The session ended (host ended it, or the room was GC'd). Terminal. */
  onEnded?: () => void;
  /** The room is at participant capacity. Terminal for this attempt. */
  onFull?: () => void;
  /** An established session's reconnects keep 409ing (seat taken past
   *  the relay's reap window). Retrying continues; the UI should explain. */
  onCrowdedOut?: () => void;
  /** The queue head has failed `sendStuckAfter` times in a row (a
   *  poison entry, or a relay that keeps refusing): fired once with the
   *  count when the threshold is crossed, and with 0 when a later send
   *  succeeds. Retrying continues either way — this is the signal that
   *  "edits aren't reaching the room" was previously silent. */
  onSendStuck?: (consecutive: number) => void;
  /** Encrypted presence blob from a peer (cursor layer decodes). */
  onPresence?: (blob: Uint8Array) => void;
  /** A catch-up just imported a LARGE offline backlog (`count` update
   *  blobs) — the merge-visibility hook for "you were gone a while". */
  onBacklogMerged?: (count: number) => void;
}

export interface CollabSessionOptions {
  client: RoomsClient;
  roomId: string;
  key: CryptoKey;
  role: 'host' | 'participant';
  callbacks?: CollabSessionCallbacks;
  /** Outbound debounce; keystrokes within a window coalesce into one
   *  wire update. */
  flushMs?: number;
  /** Belt-and-suspenders catch-up cadence while streaming (heals shed
   *  push frames). */
  catchUpMs?: number;
  /** Minimum stream-blind duration before a merged catch-up backlog is
   *  worth announcing (onBacklogMerged). Injectable for tests. */
  backlogNoticeMinBlindMs?: number;
  /** Inbound micro-batch window: stream frames arriving within this
   *  window import as ONE batch → one ProseMirror transaction → one
   *  plugin-pipeline pass, instead of a full cycle per frame (perf
   *  study 2026-08-06: ~10 cycles/sec with five typists). Remote-edit
   *  display latency grows by at most this much. Injectable for tests. */
  receiveBatchMs?: number;
  inboundBatchBytes?: number;
  resyncSliceBytes?: number;
  sendStuckAfter?: number;
  /** Stream backoff bounds, injectable for tests. */
  minBackoffMs?: number;
  resetAfterMs?: number;
  stallMs?: number;
  maxBackoffMs?: number;
  /** Host compaction cadence: upload an encrypted snapshot every N
   *  posted updates. */
  snapshotEvery?: number;
  /** Self-echo watchdog deadline (see field docs); injectable for tests. */
  echoTimeoutMs?: number;
  /** Delay before the first room-history audit; injectable for tests. */
  auditDelayMs?: number;
  /** Blobs above this many bytes ship via the snapshot endpoint (8x the
   *  relay's per-update cap) instead of as updates; injectable for
   *  tests. Default sits under the relay's 5MB update cap. */
  updateByteLimit?: number;
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class CollabSession {
  readonly loroDoc: LoroDoc;
  readonly roomId: string;
  readonly role: 'host' | 'participant';

  private readonly client: RoomsClient;
  private readonly key: CryptoKey;
  private readonly callbacks: CollabSessionCallbacks;
  private readonly flushMs: number;
  private readonly catchUpMs: number;
  private readonly backlogNoticeMinBlindMs: number;
  private readonly receiveBatchMs: number;
  /** Decrypted stream frames awaiting the micro-batch drain. Safe to
   *  DROP at teardown: the fetch cursor never advanced past them (it
   *  advances only in catch-up), so the next catch-up re-fetches
   *  anything a dropped buffer held. */
  private inboundBuf: Uint8Array[] = [];
  private inboundTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the live stream went down (null while it's up) and the
   *  duration of the last COMPLETED blind window — consumed by the
   *  next catch-up's backlog-notice decision, so one blind window can
   *  announce at most once. */
  private blindSince: number | null = null;
  private lastBlindMs = 0;
  private readonly snapshotEvery: number;
  private readonly echoTimeoutMs: number;
  private readonly auditDelayMs: number;
  private readonly updateByteLimitBase: number;
  private updateByteLimitOverride: number | null = null;
  private get updateByteLimit(): number {
    return this.updateByteLimitOverride ?? this.updateByteLimitBase;
  }

  private stream: RoomStream | null = null;
  /** Room guest pass (web-collab Phase 3): minted at host-create when
   *  the relay's flip is on, carried in invite links, persisted with
   *  the session record so resume keeps the credential. Null when the
   *  feature is dormant or this peer joined with its own credentials. */
  guestPass: string | null = null;
  private lastSeq = 0;
  private lastSentVersion: ReturnType<LoroDoc['version']>;
  /** What the relay has CONFIRMED receiving (post succeeded), unlike
   *  lastSentVersion which advances at export-into-queue time. The
   *  persisted record stores THIS — a crash loses the in-memory queue,
   *  and resuming from export-time state would silently drop every
   *  queued-but-unposted update. */
  private ackedVersion: ReturnType<LoroDoc['version']>;
  private outQueue: {
    blob: Uint8Array;
    /** Doc version when this diff was exported (acked on post). */
    version: ReturnType<LoroDoc['version']>;
    /** Version the diff starts FROM — chunked re-exports need it, and
     *  intermediate chunks ack to it so a crash mid-sequence re-sends
     *  the whole span instead of losing the tail. */
    from: ReturnType<LoroDoc['version']>;
  }[] = [];
  private sending = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private catchUpTimer: ReturnType<typeof setInterval> | null = null;
  private auditTimer: ReturnType<typeof setInterval> | null = null;
  private auditKickoff: ReturnType<typeof setTimeout> | null = null;
  private sendRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private ended = false;
  private postedCount = 0;
  private catchUpRunning = false;
  /** Self-echo watchdog: the server pushes our own posted update back
   *  to our stream, so "posted seq N, stream never showed ≥ N" proves
   *  the stream is attached to a stale relay instance (a deploy's old
   *  process lingers unbound but keeps serving heartbeats to streams it
   *  still holds — posts go to the new instance, pushes fan out where
   *  nobody listens). Hard-restart reconnects to the live instance. */
  private awaitingEcho: { seq: number; at: number } | null = null;
  private maxStreamSeq = 0;
  /** Opaque per-session stream nonce: sent as ?sid= on the stream and
   *  ?from= on presence posts so the server skips echoing our own
   *  cursor frames back (pure egress savings — the cursor layer drops
   *  own-peer frames anyway). */
  private readonly streamSid: string = Math.random().toString(36).slice(2, 14);
  /** ROOM-HOLDINGS bookkeeping for the incremental history audit.
   *  The room's content is (verified snapshot) + (update rows above its
   *  coversThroughSeq). We fold version-vector maxima from every blob
   *  that passes through this client anyway — imports, our own posts,
   *  snapshots we download or upload — so the periodic audit compares
   *  locally instead of re-downloading the entire room every cycle
   *  (which was ~65% of all relay egress, 2026-07-24 audit).
   *  `tailMetas` holds per-row maxima ABOVE the verified snapshot; a
   *  compaction (covers advance) invalidates rows at-or-below the new
   *  covers, so they are pruned once the NEW snapshot's own meta is
   *  verified — never trusted transitively. */
  private roomSnapVv = new Map<string, number>();
  private verifiedSnapCovers = 0;
  private knownSnapCovers = 0;
  private tailMetas: Array<{ seq: number; vv: Array<[string, number]> }> = [];
  /** Bookkeeping overflow (huge unpruned tail) → the next audit falls
   *  back to the ground-truth full scan instead of trusting a capped
   *  accumulator. */
  private tailOverflow = false;
  /** True while imported ops sit in Loro's causal-dependency queue.
   *  COMPACTION MUST NOT RUN in this state: the snapshot would omit the
   *  pending ops while its coversThroughSeq truncates their stored
   *  blobs — destroying them from the room permanently (field bug: the
   *  joiner's edits stopped reaching the host FOREVER, surviving
   *  restarts, because a host compaction ate their causal ancestors).
   *  Cleared only when a full-resync import integrates cleanly. */
  private pendingImports = false;
  /** Ops parked for missing causal deps, per peer (counter spans). The
   *  boolean above is DERIVED from this map after every import: a span
   *  is dropped once the doc's version vector covers its end. The old
   *  bare boolean was only ever cleared inside the full-resync block,
   *  so the common heal (an ordinary catch-up fetching the deps) left
   *  it latched and the host never compacted again (2026-09-01
   *  review, SC1). */
  private pendingSpans = new Map<string, { start: number; end: number }>();

  /** Fold one import's status into the parked-span ledger and re-derive
   *  pendingImports. Call after EVERY importBatch. */
  private notePending(status: { pending: Map<string, { start: number; end: number }> | null }): void {
    if (status.pending) {
      for (const [peer, span] of status.pending) {
        const cur = this.pendingSpans.get(peer);
        this.pendingSpans.set(
          peer,
          cur ? { start: Math.min(cur.start, span.start), end: Math.max(cur.end, span.end) } : { ...span },
        );
      }
    }
    if (this.pendingSpans.size > 0) {
      const vv = this.loroDoc.version();
      for (const [peer, span] of this.pendingSpans) {
        const have = vv.get(peer as `${number}`) ?? 0;
        if (have >= span.end) this.pendingSpans.delete(peer);
      }
    }
    this.pendingImports = this.pendingSpans.size > 0;
  }

  private constructor(opts: CollabSessionOptions & { loroDoc: LoroDoc }) {
    this.loroDoc = opts.loroDoc;
    this.roomId = opts.roomId;
    this.role = opts.role;
    this.client = opts.client;
    this.key = opts.key;
    this.callbacks = opts.callbacks ?? {};
    this.flushMs = opts.flushMs ?? 500;
    this.catchUpMs = opts.catchUpMs ?? 300_000;
    this.backlogNoticeMinBlindMs = opts.backlogNoticeMinBlindMs ?? 60_000;
    this.receiveBatchMs = opts.receiveBatchMs ?? 120;
    this.snapshotEvery = opts.snapshotEvery ?? 50;
    this.echoTimeoutMs = opts.echoTimeoutMs ?? 8000;
    this.auditDelayMs = opts.auditDelayMs ?? 15_000;
    this.inboundBatchBytes = opts.inboundBatchBytes ?? 8 * 1024 * 1024;
    this.resyncSliceBytes = opts.resyncSliceBytes ?? 8 * 1024 * 1024;
    this.sendStuckAfter = opts.sendStuckAfter ?? 6;
    this.updateByteLimitBase = opts.updateByteLimit ?? 4_500_000;
    this.lastSentVersion = this.loroDoc.version();
    this.ackedVersion = this.lastSentVersion;
    this.streamOpts = {
      minBackoffMs: opts.minBackoffMs,
      maxBackoffMs: opts.maxBackoffMs,
      resetAfterMs: opts.resetAfterMs,
      stallMs: opts.stallMs,
    };
  }

  private streamOpts: {
    minBackoffMs?: number;
    maxBackoffMs?: number;
    resetAfterMs?: number;
    stallMs?: number;
  };

  /** Start a session on the current document. Uploads the seed state as
   *  update #1 and returns the share code alongside the session. */
  static async host(opts: {
    pmDoc: PMNode;
    client: RoomsClient;
    callbacks?: CollabSessionCallbacks;
    flushMs?: number;
    catchUpMs?: number;
    auditDelayMs?: number;
    backlogNoticeMinBlindMs?: number;
    receiveBatchMs?: number;
    inboundBatchBytes?: number;
    resyncSliceBytes?: number;
    sendStuckAfter?: number;
    minBackoffMs?: number;
    resetAfterMs?: number;
    stallMs?: number;
    maxBackoffMs?: number;
    snapshotEvery?: number;
    updateByteLimit?: number;
  }): Promise<{ session: CollabSession; shareCode: string; guestPass: string | null }> {
    const keyBytes = generateRoomKeyBytes();
    const key = await importRoomKey(keyBytes);
    const { roomId, guestPass } = await opts.client.createRoom();

    const loroDoc = new LoroDoc();
    configTextStyle(loroDoc);
    updateLoroToPmState(loroDoc as SyncDoc, new Map(), EditorState.create({ doc: opts.pmDoc }));
    loroDoc.commit();

    const session = new CollabSession({ ...opts, roomId, key, role: 'host', loroDoc });
    const seed = loroDoc.export({ mode: 'snapshot' });
    let seq: number;
    if (seed.length > session.updateByteLimit) {
      // Large document: the seed exceeds the relay's per-update cap
      // (413 in the field on big master files). Ship it as cap-sized
      // update chunks — ordinary log entries that joins and live peers
      // consume through the normal paths.
      const emptyVersion = new LoroDoc().version();
      const chunks = session.exportChunks(emptyVersion);
      seq = 0;
      for (const chunk of chunks) {
        seq = await opts.client.postUpdate(roomId, await encryptBlob(key, chunk));
      }
    } else {
      seq = await opts.client.postUpdate(roomId, await encryptBlob(key, seed));
    }
    session.lastSeq = seq;
    session.lastSentVersion = loroDoc.version();
    session.ackedVersion = session.lastSentVersion; // seed delivery succeeded
    // Movable rooms mint a v2 share code carrying the compatibility
    // floor — its FORMAT is what fences pre-1.0 builds out of the
    // join-by-code path (see encodeShareCode). List rooms stay v1 so
    // old builds can keep joining them.
    const floor =
      session.childrenFormat() === 'movable' ? MOVABLE_ROOMS_MIN_VERSION : undefined;
    session.guestPass = guestPass;
    return { session, shareCode: encodeShareCode(roomId, keyBytes, floor), guestPass };
  }

  /** Join an existing session; resolves once the backlog (seed + tail)
   *  is imported, so the caller mounts views against a populated doc. */
  static async join(opts: {
    roomId: string;
    keyBytes: Uint8Array;
    client: RoomsClient;
    callbacks?: CollabSessionCallbacks;
    flushMs?: number;
    catchUpMs?: number;
    auditDelayMs?: number;
    backlogNoticeMinBlindMs?: number;
    receiveBatchMs?: number;
    inboundBatchBytes?: number;
    resyncSliceBytes?: number;
    sendStuckAfter?: number;
    minBackoffMs?: number;
    resetAfterMs?: number;
    stallMs?: number;
    maxBackoffMs?: number;
    updateByteLimit?: number;
  }): Promise<CollabSession> {
    const key = await importRoomKey(opts.keyBytes);
    const loroDoc = new LoroDoc();
    configTextStyle(loroDoc);
    const session = new CollabSession({
      ...opts,
      key,
      role: 'participant',
      loroDoc,
    });
    // Strict initial sync: steady-state catchUp() swallows network
    // errors by design (resilience), but a join that can't reach the
    // relay must FAIL — otherwise the caller mounts an empty doc and
    // the invite-prefetch offline fallback never gets a chance.
    //
    // ...after a few jittered retries for the TRANSIENT shapes (a relay
    // deploy's 502/503, one refused connection): the steady-state stream
    // backs off and retries, but the join had no equivalent, so a
    // short blip either failed the join outright or silently chose a
    // stale prefetched seed (2026-09-01 review). Three retries at
    // base×(1,2,4) — ~7s at the production base, long enough to ride
    // out a deploy switchover. 4xx stays terminal.
    const base = opts.minBackoffMs ?? 1000;
    for (let attempt = 0; ; attempt++) {
      try {
        await session.catchUp(false, true);
        break;
      } catch (err) {
        const transient = err instanceof RoomsError && (err.status === 0 || err.status >= 500);
        if (!transient || attempt >= 3) throw err;
        const delay = base * 2 ** attempt * (0.7 + Math.random() * 0.6);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    return session;
  }

  /** Rebuild a session from persisted state (M3): the CRDT snapshot +
   *  increments carry this peer's full history — including edits that
   *  never reached the relay before the app died — so the first flush
   *  after start() sends exactly the unsent diff (sentVersion marks
   *  what the room already has), and catch-up resumes from lastSeq.
   *  No network happens here; start() drives reconnection. */
  static async resume(opts: {
    roomId: string;
    keyBytes: Uint8Array;
    role: 'host' | 'participant';
    snapshot: Uint8Array;
    increments: Uint8Array[];
    lastSeq: number;
    /** What the relay has seen from this peer. Omit when EVERYTHING
     *  imported came from the room (invite-prefetch offline join) —
     *  the post-import version is then exactly the room's view. */
    sentVersion?: Uint8Array;
    client: RoomsClient;
    callbacks?: CollabSessionCallbacks;
    flushMs?: number;
    catchUpMs?: number;
    auditDelayMs?: number;
    backlogNoticeMinBlindMs?: number;
    receiveBatchMs?: number;
    inboundBatchBytes?: number;
    resyncSliceBytes?: number;
    sendStuckAfter?: number;
    minBackoffMs?: number;
    resetAfterMs?: number;
    stallMs?: number;
    maxBackoffMs?: number;
    snapshotEvery?: number;
  }): Promise<CollabSession> {
    const key = await importRoomKey(opts.keyBytes);
    const loroDoc = new LoroDoc();
    configTextStyle(loroDoc);
    loroDoc.importBatch([opts.snapshot, ...opts.increments]);
    const session = new CollabSession({ ...opts, key, loroDoc });
    session.lastSeq = opts.lastSeq;
    session.lastSentVersion = opts.sentVersion
      ? VersionVector.decode(opts.sentVersion)
      : loroDoc.version();
    session.ackedVersion = session.lastSentVersion;
    return session;
  }

  /** Cursor + sent-version metadata for the persistence layer — cheap,
   *  called every persist tick. The snapshot export is separate
   *  (exportSnapshot) so steady-state ticks never pay for it. */
  persistMeta(): { lastSeq: number; sentVersion: Uint8Array } {
    return { lastSeq: this.lastSeq, sentVersion: this.ackedVersion.encode() };
  }

  /** Full CRDT export — the persistence layer's compaction base. */
  /** The room's children-container format — decides the invite floor
   *  (movable rooms exclude builds that cannot read them). */
  childrenFormat(): 'movable' | 'list' {
    try {
      const kids = this.loroDoc.getMap('doc').get('children');
      if (kids != null && (kids as { kind?: () => string }).kind?.() === 'MovableList') {
        return 'movable';
      }
    } catch {
      /* unseeded/odd shape → treat as the legacy format */
    }
    return 'list';
  }

  /** Full snapshot export, memoized on the doc version for a few
   *  seconds: collab-persist (every 40th increment) and collab-history
   *  (every 20-60s) each exported their own byte-identical snapshot —
   *  a synchronous wasm call measured at 0.3-0.8s on a 20 MB master —
   *  and paid it twice whenever their ticks coincided (2026-09-01
   *  review, SC7/A14). The TTL bounds the extra doc-sized buffer. */
  exportSnapshot(): Uint8Array {
    this.loroDoc.commit();
    const version = this.loroDoc.version().encode();
    const memo = this.snapshotMemo;
    if (memo && Date.now() - memo.at < 10_000 && bytesEq(memo.version, version)) return memo.bytes;
    const bytes = this.loroDoc.export({ mode: 'snapshot' });
    this.snapshotMemo = { version, bytes, at: Date.now() };
    return bytes;
  }

  private snapshotMemo: { version: Uint8Array; bytes: Uint8Array; at: number } | null = null;

  /** Incremental export since `from` (VersionVector.encode() bytes) —
   *  the persistence layer's cheap steady-state write. */
  exportSince(from: Uint8Array): { bytes: Uint8Array; version: Uint8Array } {
    this.loroDoc.commit();
    return {
      bytes: this.loroDoc.export({ mode: 'update', from: VersionVector.decode(from) }),
      version: this.loroDoc.version().encode(),
    };
  }

  /** Current doc version, encoded — persistence uses it to detect
   *  "anything new since the last write?" cheaply. */
  encodedVersion(): Uint8Array {
    this.loroDoc.commit();
    return this.loroDoc.version().encode();
  }

  /** The ProseMirror plugins that bind an EditorView to this session.
   *  Fresh instances per view; the LoroDoc is the shared state. */
  plugins(): Plugin[] {
    return [LoroSyncPlugin({ doc: this.loroDoc as SyncDoc })];
  }

  start(): void {
    this.stopping = false;
    if (this.ended || this.stream) return;
    this.stream = new RoomStream({
      baseUrl: this.client.opts.baseUrl,
      token: this.client.opts.token,
      routingCode: this.client.opts.routingCode,
      credentials: this.client.opts.credentials,
      fetchImpl: this.client.opts.fetchImpl,
      roomId: this.roomId,
      sid: this.streamSid,
      minBackoffMs: this.streamOpts.minBackoffMs,
      maxBackoffMs: this.streamOpts.maxBackoffMs,
      resetAfterMs: this.streamOpts.resetAfterMs,
      stallMs: this.streamOpts.stallMs,
      callbacks: {
        onHello: () => {
          this.connected = true;
          // Close the blind window; the hello catch-up (below) consumes
          // its duration for the backlog-notice decision.
          if (this.blindSince !== null) {
            this.lastBlindMs = Date.now() - this.blindSince;
            this.blindSince = null;
          }
          this.emitStatus();
          void this.catchUp();
          void this.drainQueue();
        },
        onUpdate: (u) => {
          if (u.seq > this.maxStreamSeq) this.maxStreamSeq = u.seq;
          if (this.awaitingEcho && u.seq >= this.awaitingEcho.seq) this.awaitingEcho = null;
          void this.applyRemote(u);
        },
        onPresence: (blob) => {
          void (async () => {
            try {
              this.callbacks.onPresence?.(await decryptBlob(this.key, blob));
            } catch {
              /* wrong-key or corrupt presence frame — drop */
            }
          })();
        },
        onEnded: () => this.handleEnded(),
        onAuthDead: () => this.handleAuthDead(),
        onFull: () => {
          this.callbacks.onFull?.();
        },
        onCrowdedOut: () => {
          this.callbacks.onCrowdedOut?.();
        },
        onDown: () => {
          this.connected = false;
          if (this.blindSince === null) this.blindSince = Date.now();
          this.awaitingEcho = null;
          this.emitStatus();
        },
      },
    });
    this.stream.start();
    this.flushTimer = setInterval(() => {
      this.flush();
      this.checkEcho();
    }, this.flushMs);
    this.catchUpTimer = setInterval(() => void this.catchUp(), this.catchUpMs);
    // Every audit runs BEHIND a catch-up so its probe starts from a
    // current cursor: with its own unaligned timer the "~100B probe"
    // fetched and decrypted every row since a cursor that was ~2.5
    // minutes stale on average (2026-09-01 review, T7). The extra tail
    // fetch is the cheap half; the decrypts it avoids are the expensive
    // half.
    const audit = (): void => void this.catchUp().then(() => this.auditRoomHistory());
    this.auditKickoff = setTimeout(audit, this.auditDelayMs);
    this.auditTimer = setInterval(audit, 30 * 60_000);
  }

  /** Leave the session (participant) or just stop syncing: final flush
   *  attempt, then tear down timers and the stream. */
  async stop(): Promise<void> {
    // Land anything the micro-batch window still holds before the
    // final flush/drain, so stop() is as current as per-frame import
    // was. (Dropping would also be safe — the cursor never advanced
    // past buffered frames — but landing them is free here.)
    if (this.inboundTimer) {
      clearTimeout(this.inboundTimer);
      this.inboundTimer = null;
    }
    this.drainInbound();
    // A REAL final drain: await the send already in flight (bounded by
    // its request deadline) rather than returning past it, and stop the
    // failure path from re-arming a retry timer after we clear it
    // (2026-09-01 review, SC10). What can't be sent stays in the queue
    // — the persisted record captures it for resume.
    this.stopping = true;
    this.flush();
    await this.drainQueue().catch(() => {});
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.catchUpTimer) clearInterval(this.catchUpTimer);
    if (this.auditTimer) clearInterval(this.auditTimer);
    if (this.auditKickoff) clearTimeout(this.auditKickoff);
    if (this.sendRetryTimer) clearTimeout(this.sendRetryTimer);
    this.flushTimer = this.catchUpTimer = this.auditTimer = null;
    this.auditKickoff = null;
    this.sendRetryTimer = null;
    this.stream?.stop();
    this.stream = null;
    this.connected = false;
  }

  /** End the session for everyone (host action): tombstones the room. */
  async end(): Promise<void> {
    await this.stop();
    try {
      await this.client.deleteRoom(this.roomId);
    } catch {
      /* already gone */
    }
    this.handleEnded();
  }

  /** Wake-from-sleep hook. */
  restart(): void {
    this.stream?.restart();
  }

  get queuedUpdates(): number {
    return this.outQueue.length;
  }

  /** Introspection for diagnostics and the sync-status UI. The
   *  transport/stream counters and failure tallies exist so a field
   *  report of "it says synced but nothing moves" leaves evidence —
   *  every failure path here used to be a silent catch (2026-09-01
   *  review). */
  debugState(): {
    connected: boolean;
    streamRunning: boolean;
    streamConnected: boolean;
    queued: number;
    sending: boolean;
    lastSeq: number;
    awaitingEchoSeq: number | null;
    pendingImports: boolean;
    tailOverflow: boolean;
    ended: boolean;
    consecutiveSendFailures: number;
    consecutiveSnapshotFailures: number;
    lastCatchUpError: string | null;
    catchUpRowsSkipped: number;
    inboundDrains: number;
    resyncSlices: number;
    transport: TransportStats;
    stream: StreamStats | null;
  } {
    return {
      connected: this.connected,
      streamRunning: this.stream?.running ?? false,
      streamConnected: this.stream?.connected ?? false,
      queued: this.outQueue.length,
      sending: this.sending,
      lastSeq: this.lastSeq,
      awaitingEchoSeq: this.awaitingEcho?.seq ?? null,
      pendingImports: this.pendingImports,
      tailOverflow: this.tailOverflow,
      ended: this.ended,
      consecutiveSendFailures: this.consecutiveSendFailures,
      consecutiveSnapshotFailures: this.consecutiveSnapshotFailures,
      lastCatchUpError: this.lastCatchUpError,
      catchUpRowsSkipped: this.catchUpRowsSkipped,
      inboundDrains: this.inboundDrains,
      resyncSlices: this.resyncSlices,
      transport: this.client.stats,
      stream: this.stream?.stats ?? null,
    };
  }

  /** A catch-up requested while one was running (see catchUp). */
  private catchUpRerun: { expectMissingDeps: boolean } | null = null;
  /** Relay seqs above the cursor whose frames the STREAM already
   *  delivered (decrypted + buffered for import). Catch-up still
   *  fetches those rows — the cursor advances only from pages, never
   *  from frames — but skips decrypting and re-importing them. Pruned
   *  as the cursor passes them; cleared outright past the cap (a
   *  re-import is merely redundant, never wrong). */
  private importedSeqs = new Set<number>();
  private static readonly IMPORTED_SEQS_CAP = 5000;
  private catchUpRowsSkipped = 0;
  /** Byte bound on one inbound importBatch: a push burst (a reconnect
   *  repost, the audit's full-history chunks) used to land as ONE
   *  synchronous import of everything the 120ms window collected
   *  (2026-09-01 review, SC13). The buffer is drop-safe by design
   *  (the cursor never advanced past it), so slicing it is too. */
  private readonly inboundBatchBytes: number;
  private inboundDrains = 0;
  /** Byte bound on one full-resync importBatch: the escalation path
   *  buffered every decrypted blob of the whole room, then blocked the
   *  main thread on one giant import (SC12). pendingLeft semantics are
   *  preserved by folding every slice's status into the span ledger. */
  private readonly resyncSliceBytes: number;
  private resyncSlices = 0;
  /** Consecutive send failures that count as "stuck" (default 6 ≈ one
   *  minute at the escalating retry cadence). */
  private readonly sendStuckAfter: number;
  private sendStuckSignaled = false;
  private consecutiveSendFailures = 0;
  private consecutiveSnapshotFailures = 0;
  private lastCatchUpError: string | null = null;

  /** Self-echo watchdog (see field docs on `awaitingEcho`). */
  private checkEcho(): void {
    if (!this.awaitingEcho || !this.stream?.connected) return;
    if (Date.now() - this.awaitingEcho.at > this.echoTimeoutMs) {
      console.warn('[collab] posted update never echoed on the stream — reconnecting (stale relay instance?)');
      this.awaitingEcho = null;
      this.stream.restart();
    }
  }

  // --- outbound ---

  /** Advance the sent frontier over ops IMPORTED from the relay (so we
   *  never echo them back) WITHOUT absorbing our own un-flushed local
   *  ops. Our own peer's sent counter advances ONLY through flush().
   *
   *  ROOT CAUSE of the field one-way desync: the import paths used to
   *  set `lastSentVersion = loroDoc.version()`, which silently marked
   *  our own un-posted ops as "sent" — including plugin-generated
   *  repair/heal ops that land on a microtask AFTER the import, so a
   *  later import absorbed them. flush() then saw "nothing new" and
   *  early-returned; those ops never reached the relay, the queue
   *  emptied, `ackedVersion` claimed them sent, and the chip read
   *  "synced" while other peers could never catch up. Preserving our
   *  own counter here keeps the invariant "our own ops are sent only
   *  once flush() exports them." */
  private markImportedSent(): void {
    const full = this.loroDoc.version().toJSON();
    const own = this.loroDoc.peerIdStr as `${number}`;
    const sentOwn = this.lastSentVersion.toJSON().get(own) ?? 0;
    full.set(own, sentOwn);
    this.lastSentVersion = new VersionVector(full);
  }

  /** Export any local ops since the last flush into the send queue.
   *  Synchronous by design so `applyRemote` can call it pre-import. */
  flush(): void {
    if (this.ended) return;
    this.loroDoc.commit();
    const version = this.loroDoc.version();
    // An empty diff still exports a ~22-byte header blob, so gate on the
    // version vector actually advancing (compare() === 0 means equal).
    if (version.compare(this.lastSentVersion) === 0) return;
    const diff = this.loroDoc.export({ mode: 'update', from: this.lastSentVersion });
    const from = this.lastSentVersion;
    this.lastSentVersion = version;
    this.outQueue.push({ blob: diff, version, from });
    this.emitStatus();
    void this.drainQueue();
  }

  /** The in-flight drain, so stop() can await it instead of no-oping
   *  past it (drainQueue returns at once while `sending` is set). */
  private drainPromise: Promise<void> | null = null;
  /** Set by stop(): suppresses retry timers that would outlive the
   *  session; cleared by start(). */
  private stopping = false;

  private drainQueue(): Promise<void> {
    if (this.sending || this.ended) return this.drainPromise ?? Promise.resolve();
    const p = this.drainQueueInner().finally(() => {
      if (this.drainPromise === p) this.drainPromise = null;
    });
    this.drainPromise = p;
    return p;
  }

  /** Collapse a queued run into one entry: every entry carries `from`,
   *  so one export from the head's `from` covers the whole run (plus any
   *  remote ops imported since — harmless, idempotent). Ack bookkeeping
   *  keeps working because `version` stays the run's last version. Ten
   *  offline minutes used to be ~1200 sequential POSTs and 1200 relay
   *  rows for every peer to fetch (2026-09-01 review, SC2). */
  private coalesceQueue(): void {
    if (this.outQueue.length < 2) return;
    const head = this.outQueue[0]!;
    const last = this.outQueue[this.outQueue.length - 1]!;
    this.loroDoc.commit();
    const blob = this.loroDoc.export({ mode: 'update', from: head.from });
    this.outQueue = [{ blob, version: last.version, from: head.from }];
  }

  private async drainQueueInner(): Promise<void> {
    this.sending = true;
    try {
      // ONCE per drain, before the loop — never per iteration: the loop
      // may split an oversized head into chunk entries, and re-coalescing
      // those merges them back into the oversized blob (chunk → merge →
      // chunk, forever).
      this.coalesceQueue();
      while (this.outQueue.length > 0) {
        const entry = this.outQueue[0]!;
        try {
          if (entry.blob.length > this.updateByteLimit) {
            // Oversized diff (huge paste, or the audit's full-history
            // repost on a big doc): split it into cap-sized update
            // chunks and keep draining.
            this.chunkQueueHead();
            continue;
          }
          const seq = await this.client.postUpdate(
            this.roomId,
            await encryptBlob(this.key, entry.blob),
          );
          this.foldTailMeta(seq, entry.blob);
          this.outQueue.shift();
          this.ackedVersion =
            this.outQueue.length === 0 ? this.lastSentVersion : entry.version;
          this.postedCount++;
          this.sendRetryMs = 1000;
          this.consecutiveSendFailures = 0;
          if (this.sendStuckSignaled) {
            this.sendStuckSignaled = false;
            this.callbacks.onSendStuck?.(0);
          }
          if (this.stream?.connected) this.awaitingEcho = { seq, at: Date.now() };
          // Deliberately NOT advancing lastSeq to our own posted seq:
          // the cursor means "I have imported everything ≤ this", and a
          // peer's concurrent post can hold a LOWER seq we haven't seen
          // — claiming it would skip their updates forever, and new
          // edits depending on them would park in the causal-deps
          // queue. Catch-up re-fetching our own blobs is a no-op.
          this.emitStatus();
          // A successful send proves the relay is reachable; skip any
          // pending backoff wait. (A nudge, never a restart: aborting
          // an in-flight handshake from the send loop starves the
          // stream while the user types — see RoomStream.nudge.)
          // A successful send proves the relay is reachable; skip any
          // pending backoff wait. (A nudge, never a restart: aborting
          // an in-flight handshake from the send loop starves the
          // stream while the user types — see RoomStream.nudge.)
          this.stream?.nudge();
          if (this.role === 'host' && this.postedCount % this.snapshotEvery === 0) {
            void this.uploadSnapshot();
          }
        } catch (err) {
          if (err instanceof RoomsError && (err.status === 410 || err.status === 404)) {
            // 410 = tombstoned (host ended); 404 = the room itself is gone
            // (relay idle-GC). Both terminal — the stream already treats
            // them identically.
            this.handleEnded();
            return;
          }
          if (err instanceof RoomsError && (err.status === 401 || err.status === 403)) {
            // Credentials/entitlement died MID-SESSION. Retrying can't fix
            // it silently and a hot retry loop looked exactly like being
            // offline (audit find, 2026-07-10): tell the user once and back
            // off to the ceiling in case the entitlement comes back.
            this.sendRetryMs = 30_000;
            this.notifyAuthRejected();
          }
          if (err instanceof RoomsError && err.status === 413 && entry.blob.length > 1024) {
            // Server-side cap disagreement (backstop for the proactive
            // size check above): force a re-chunk by treating the
            // server's cap as authoritative for this entry.
            this.updateByteLimitOverride = Math.floor(entry.blob.length / 2);
            this.chunkQueueHead();
            this.updateByteLimitOverride = null;
            continue;
          }
          this.consecutiveSendFailures++;
          if (!this.sendStuckSignaled && this.consecutiveSendFailures >= this.sendStuckAfter) {
            this.sendStuckSignaled = true;
            this.callbacks.onSendStuck?.(this.consecutiveSendFailures);
          }
          // Log the first failure and then every 5th, so a stuck queue
          // leaves evidence without flooding the console.
          if (this.consecutiveSendFailures === 1 || this.consecutiveSendFailures % 5 === 0) {
            console.warn(
              `[collab] update post failed (${this.consecutiveSendFailures} in a row):`,
              (err as Error)?.message ?? err,
            );
          }
          this.connected = false;
          this.emitStatus();
          this.scheduleSendRetry();
          return;
        }
      }
    } finally {
      this.sending = false;
    }
  }

  private sendRetryMs = 1000;

  private scheduleSendRetry(): void {
    if (this.sendRetryTimer || this.ended || this.stopping) return;
    const jitter = 0.7 + Math.random() * 0.6;
    const delay = this.sendRetryMs * jitter;
    this.sendRetryMs = Math.min(this.sendRetryMs * 2, 30_000);
    this.sendRetryTimer = setTimeout(() => {
      this.sendRetryTimer = null;
      void this.drainQueue();
    }, delay);
  }

  // --- room-holdings bookkeeping (incremental audit) ---

  private static readonly TAIL_METAS_CAP = 4000;

  /** Fold one update row's meta into the tail ledger. `plain` is the
   *  DECRYPTED blob (imports) or the pre-encryption bytes (our posts). */
  private foldTailMeta(seq: number, plain: Uint8Array): void {
    if (seq <= this.verifiedSnapCovers) return; // already inside the verified snapshot
    if (this.tailMetas.length >= CollabSession.TAIL_METAS_CAP) {
      this.tailOverflow = true;
      return;
    }
    try {
      const meta = decodeImportBlobMeta(plain, false);
      this.tailMetas.push({ seq, vv: [...meta.partialEndVersionVector.toJSON()] });
    } catch {
      /* undecodable — the audit's escalation full-scan remains the backstop */
    }
  }

  /** A snapshot whose CONTENT we have actually decoded (downloaded and
   *  decrypted, or exported by us) becomes the verified floor; tail rows
   *  it covers are pruned. Trust is never transitive — a covers advance
   *  alone (knownSnapCovers) verifies nothing. */
  private foldSnapshotMeta(plain: Uint8Array, covers: number): void {
    try {
      const meta = decodeImportBlobMeta(plain, false);
      const vv = new Map<string, number>();
      for (const [peer, counter] of meta.partialEndVersionVector.toJSON()) vv.set(peer, counter);
      this.roomSnapVv = vv;
      this.verifiedSnapCovers = covers;
      if (covers > this.knownSnapCovers) this.knownSnapCovers = covers;
      this.tailMetas = this.tailMetas.filter((t) => t.seq > covers);
      this.tailOverflow = this.tailMetas.length >= CollabSession.TAIL_METAS_CAP;
    } catch {
      /* undecodable snapshot — keep the previous verified state */
    }
  }

  private noteSnapCovers(covers: number): void {
    if (covers > this.knownSnapCovers) this.knownSnapCovers = covers;
  }

  /** Everything we can prove the room currently holds: the verified
   *  snapshot's vv merged with the surviving tail rows' maxima. */
  private roomHoldings(): Map<string, number> {
    const out = new Map(this.roomSnapVv);
    for (const t of this.tailMetas) {
      for (const [peer, counter] of t.vv) {
        if ((out.get(peer) ?? 0) < counter) out.set(peer, counter);
      }
    }
    return out;
  }

  /** Does the live doc hold ops beyond `holdings`? (The audit's core
   *  question: ops WE have that the room may have lost.) */
  private versionMissingFrom(holdings: Map<string, number>): boolean {
    for (const [peer, counter] of this.loroDoc.version().toJSON()) {
      if ((holdings.get(peer) ?? 0) < counter) return true;
    }
    return false;
  }

  // --- inbound ---

  private async applyRemote(u: RoomUpdate): Promise<void> {
    if (this.ended || u.seq <= this.lastSeq) return;
    let plain: Uint8Array;
    try {
      plain = await decryptBlob(this.key, u.blob);
    } catch {
      // Wrong key or corrupt ciphertext — drop the frame. The cursor
      // is deliberately untouched (see below).
      return;
    }
    // Per-FRAME bookkeeping happens at arrival: the audit ledger is
    // per relay row (foldTailMeta), and the echo watchdog already
    // cleared in onUpdate. The IMPORT is micro-batched below — frames
    // arriving within receiveBatchMs land as one importBatch → one
    // binding transaction → one plugin-pipeline pass, instead of a
    // full cycle per frame (perf study 2026-08-06).
    this.foldTailMeta(u.seq, plain);
    this.inboundBuf.push(plain);
    if (this.importedSeqs.size >= CollabSession.IMPORTED_SEQS_CAP) this.importedSeqs.clear();
    this.importedSeqs.add(u.seq);
    this.inboundTimer ??= setTimeout(() => {
      this.inboundTimer = null;
      this.drainInbound();
    }, this.receiveBatchMs);
  }

  /** Import everything the micro-batch window collected, as one batch. */
  private drainInbound(): void {
    if (this.ended || this.inboundBuf.length === 0) return;
    // Take at most inboundBatchBytes (always ≥1 frame); the remainder
    // drains on the next tick.
    let bytes = 0;
    let n = 0;
    while (n < this.inboundBuf.length && (n === 0 || bytes + this.inboundBuf[n]!.length <= this.inboundBatchBytes)) {
      bytes += this.inboundBuf[n]!.length;
      n++;
    }
    const batch = this.inboundBuf.slice(0, n);
    this.inboundBuf = this.inboundBuf.slice(n);
    if (this.inboundBuf.length > 0 && this.inboundTimer === null) {
      this.inboundTimer = setTimeout(() => {
        this.inboundTimer = null;
        this.drainInbound();
      }, 0);
    }
    this.inboundDrains++;
    this.flush(); // capture local diff before import (see module doc)
    const status = this.loroDoc.importBatch(batch);
    this.notePending(status);
    this.markImportedSent();
    // The cursor does NOT advance from stream frames — ONLY from
    // catch-up pages. A pushed frame proves nothing about the rows
    // below it: pushes are shed under backpressure and dropped by
    // dying connections (field: ERR_NETWORK_CHANGED flaps), and a
    // cursor that jumps past an unfetched row makes every later
    // catch-up ("give me rows after N") skip it FOREVER — a permanent
    // silent gap when the lost content has no later causal reference,
    // and a compaction hazard (coversThroughSeq trusts this cursor).
    // The stream is the fast path; the paginated catch-up is the
    // correctness path.
    this.sendRetryMs = 1000;
    // Ops whose causal dependencies we lack (a shed push frame, or a
    // window the cursor skipped) sit pending until the deps arrive —
    // fetch them now instead of waiting for the periodic catch-up. The
    // missing deps sit BELOW our cursor, so the catch-up must be
    // allowed to escalate to a full resync.
    if (status.pending && status.pending.size > 0) {
      void this.catchUp(true);
    }
  }

  /** Fetch and import everything after our cursor (join, reconnect,
   *  and the periodic shed-frame healer). `expectMissingDeps` marks a
   *  call made because an import parked ops on missing causal deps —
   *  those deps live BELOW the cursor, so if the tail fetch yields
   *  nothing the full resync must still run. */
  async catchUp(expectMissingDeps = false, rethrow = false): Promise<void> {
    if (this.ended) return;
    if (this.catchUpRunning) {
      // Don't DROP a concurrent request — latch it for one re-run after
      // the current pass, ORing the expectMissingDeps escalation. The
      // old early return discarded drainInbound's shed-frame healer when
      // it raced onHello's catch-up, leaving recovery to the 5-minute
      // timer (2026-09-01 review, SC8).
      this.catchUpRerun = { expectMissingDeps: (this.catchUpRerun?.expectMissingDeps ?? false) || expectMissingDeps };
      return;
    }
    this.catchUpRunning = true;
    try {
      let pendingLeft = false;
      let importedAny = false;
      let importedCount = 0;
      // For the backlog notice: frames re-fetched but ALREADY applied
      // (the cursor deliberately lags the live stream) import as no-ops
      // — only a doc-version change means the user actually missed
      // something.
      const versionBefore = this.loroDoc.version().encode();
      for (;;) {
        // Conditional snapshot: if the room's snapshot is the exact one we
        // already imported (tag match), the server ships only the tail —
        // the cursor still advances past the compacted floor, and the
        // content is already in the doc by the verified-tag invariant
        // (verifiedSnapCovers is only ever set where the snapshot bytes
        // were imported or exported by us).
        const page = await this.client.fetchUpdates(this.roomId, this.lastSeq, {
          haveSnap: this.verifiedSnapCovers,
        });
        this.noteSnapCovers(page.snapCovers);
        const blobs: Uint8Array[] = [];
        if (page.snapshot && page.snapshot.coversThroughSeq > this.lastSeq) {
          try {
            const plainSnap = await decryptBlob(this.key, page.snapshot.blob);
            this.foldSnapshotMeta(plainSnap, page.snapshot.coversThroughSeq);
            blobs.push(plainSnap);
          } catch {
            // Undecryptable server snapshot (wrong key / corrupt ciphertext):
            // skip it like a bad update frame instead of throwing — the throw
            // wedged EVERY subsequent catch-up permanently (audit find,
            // 2026-07-10). The session degrades to whatever updates decrypt.
            console.warn('[collab] undecryptable room snapshot — skipped');
          }
        }
        // Rows the stream already delivered are skipped (their metadata
        // was folded at arrival); the rest decrypt in PARALLEL — the old
        // one-await-per-row loop serialized up to 200 WebCrypto round
        // trips on the join path (2026-09-01 review, T8).
        const fresh = page.updates.filter((u) => {
          if (u.seq <= this.lastSeq) return false;
          if (this.importedSeqs.has(u.seq)) {
            this.catchUpRowsSkipped++;
            return false;
          }
          return true;
        });
        const plains = await Promise.all(
          fresh.map((u) => decryptBlob(this.key, u.blob).catch(() => null)),
        );
        for (let i = 0; i < fresh.length; i++) {
          const plain = plains[i];
          if (!plain) continue; // undecryptable frame (see applyRemote)
          this.foldTailMeta(fresh[i]!.seq, plain);
          blobs.push(plain);
        }
        if (blobs.length > 0) {
          importedAny = true;
          importedCount += blobs.length;
          this.flush();
          const status = this.loroDoc.importBatch(blobs);
          this.markImportedSent();
          // ACCUMULATE across pages — a clean later page must not cancel
          // the full resync a dirty earlier page requested (audit find,
          // 2026-07-10).
          pendingLeft = pendingLeft || (!!status.pending && status.pending.size > 0);
          this.notePending(status);
        }
        const advanced = page.lastSeq > this.lastSeq;
        if (advanced) {
          this.lastSeq = page.lastSeq;
          for (const seq of this.importedSeqs) if (seq <= this.lastSeq) this.importedSeqs.delete(seq);
        }
        if (!page.more) break;
        // Progress guard: a `more` page whose cursor did not advance (a
        // proxy-mangled body, a half-deployed relay) would otherwise loop
        // forever with no delay, pinning the relay (2026-09-01 review).
        if (!advanced) {
          console.warn('[collab] catch-up page reported more without advancing — stopping');
          break;
        }
      }
      if (expectMissingDeps && !importedAny) pendingLeft = true;
      if (pendingLeft) {
        // Deps live below our cursor (skipped or compacted) — one full
        // resync from zero, PAGINATED: a long session holds more rows
        // than one page, and a resync that stops at page 1 never
        // reaches the deps it exists to fetch (field: the one-way
        // desync recurred because the healer read 200 rows of a bigger
        // log and parked forever).
        let after = 0;
        let blobs: Uint8Array[] = [];
        let sliceBytes = 0;
        let importedAnySlice = false;
        const importSlice = (): void => {
          if (blobs.length === 0) return;
          this.flush();
          const status = this.loroDoc.importBatch(blobs);
          this.markImportedSent();
          this.notePending(status);
          this.resyncSlices++;
          importedAnySlice = true;
          blobs = [];
          sliceBytes = 0;
        };
        for (;;) {
          const page = await this.client.fetchUpdates(this.roomId, after);
          this.noteSnapCovers(page.snapCovers);
          if (page.snapshot && after < page.snapshot.coversThroughSeq) {
            try {
              const plainSnap = await decryptBlob(this.key, page.snapshot.blob);
              this.foldSnapshotMeta(plainSnap, page.snapshot.coversThroughSeq);
              blobs.push(plainSnap);
              sliceBytes += plainSnap.length;
              if (sliceBytes >= this.resyncSliceBytes) importSlice();
            } catch {
              console.warn('[collab] undecryptable room snapshot in resync — skipped');
            }
          }
          const plains = await Promise.all(
            page.updates.map((u) => decryptBlob(this.key, u.blob).catch(() => null)),
          );
          for (let i = 0; i < page.updates.length; i++) {
            const plain = plains[i];
            if (!plain) continue; // undecryptable frame
            this.foldTailMeta(page.updates[i]!.seq, plain);
            blobs.push(plain);
            sliceBytes += plain.length;
            // Within a page too — a page can hold 200 multi-MB rows.
            if (sliceBytes >= this.resyncSliceBytes) importSlice();
          }
          const next = page.lastSeq;
          if (page.more && next <= after) {
            console.warn('[collab] resync page reported more without advancing — stopping');
            break;
          }
          after = next;
          if (!page.more) break;
        }
        // Final slice. A clean full-resync proves every known op
        // integrated; spans still parked after it are genuinely absent
        // from the room (the ledger folded every slice).
        importSlice();
        void importedAnySlice;
        if (after > this.lastSeq) this.lastSeq = after;
      }
      // Backlog notice (M3), gated three ways: enough frames to matter,
      // the doc actually changed (novelty — periodic catch-ups re-fetch
      // frames the stream already delivered), and a real blind window
      // (a healthy session's micro-reconnects stay silent). The blind
      // duration is consumed so one window announces at most once.
      const blindMs = this.blindSince !== null ? Date.now() - this.blindSince : this.lastBlindMs;
      this.lastBlindMs = 0;
      const docChanged =
        importedCount > 0 && !bytesEq(versionBefore, this.loroDoc.version().encode());
      if (importedCount >= 25 && docChanged && blindMs >= this.backlogNoticeMinBlindMs) {
        this.callbacks.onBacklogMerged?.(importedCount);
      }
      // "Connected" is the STREAM's state (live push flowing) — a
      // successful catch-up over plain HTTP must not paint the chip
      // synced while push delivery is still down.
      this.connected = this.stream ? this.stream.connected : true;
      this.emitStatus();
    } catch (err) {
      if (err instanceof RoomsError && (err.status === 410 || err.status === 404)) {
        this.handleEnded();
        // A STRICT initial sync (join/first resume tick) must NOT silently
        // succeed on an ended/expired room — otherwise the caller mounts a
        // blank doc masquerading as a joined session, shows "Joined the
        // session", and leaves a phantom resumable record. Rethrow so join()
        // fails and the UI can say the session has ended. Steady-state
        // catch-ups (rethrow=false) keep swallowing it — handleEnded already
        // drove the onEnded teardown.
        if (rethrow) throw err;
        return;
      }
      if (err instanceof RoomsError && (err.status === 401 || err.status === 403)) {
        this.notifyAuthRejected();
      }
      this.lastCatchUpError = (err as Error)?.message ?? String(err);
      console.warn('[collab] catch-up failed:', this.lastCatchUpError);
      this.connected = false;
      this.emitStatus();
      if (rethrow) throw err;
    } finally {
      this.catchUpRunning = false;
      const rerun = this.catchUpRerun;
      this.catchUpRerun = null;
      if (rerun && !this.ended) void this.catchUp(rerun.expectMissingDeps);
    }
  }

  // --- history assurance ---

  /** Verify the ROOM still holds every op the relay has acknowledged
   *  from this replica; repost the full history if not. Insurance for
   *  compaction-destroyed ops (see `pendingImports`): a room that lost
   *  a peer's causal ancestors can never integrate that peer's future
   *  edits — a permanent one-way split that LOOKS synced on both ends.
   *  The audit reads only blob METADATA (no full import) and reposting
   *  is idempotent, so a false positive costs one oversized update. */
  async auditRoomHistory(): Promise<void> {
    if (this.ended || this.outQueue.length > 0) return;
    try {
      // Cheap self-contained probe (~100B): the room's current compaction
      // epoch, plus any tail rows past our cursor (folded, not imported —
      // importing stays the catch-up's job). Self-contained rather than
      // trusting knownSnapCovers so a compaction landing moments before
      // the audit is still seen THIS cycle.
      const probe = await this.client.fetchUpdates(this.roomId, this.lastSeq, {
        haveSnap: this.verifiedSnapCovers,
      });
      this.noteSnapCovers(probe.snapCovers);
      if (probe.snapshot) {
        try {
          this.foldSnapshotMeta(
            await decryptBlob(this.key, probe.snapshot.blob),
            probe.snapshot.coversThroughSeq,
          );
        } catch {
          /* undecryptable — the escalation below stays the backstop */
        }
      }
      for (const u of probe.updates) {
        try {
          this.foldTailMeta(u.seq, await decryptBlob(this.key, u.blob));
        } catch {
          /* skip */
        }
      }
      // A compaction epoch we haven't verified the CONTENT of (trust is
      // never transitive from a covers number alone): download that one
      // snapshot and fold its meta — once per epoch, and never for the
      // host, whose own uploads verify at export.
      if (this.knownSnapCovers > this.verifiedSnapCovers) {
        const page = await this.client.fetchUpdates(this.roomId, 0, {
          haveSnap: this.verifiedSnapCovers,
        });
        this.noteSnapCovers(page.snapCovers);
        if (page.snapshot) {
          try {
            this.foldSnapshotMeta(
              await decryptBlob(this.key, page.snapshot.blob),
              page.snapshot.coversThroughSeq,
            );
          } catch {
            /* undecryptable — the escalation below stays the backstop */
          }
        }
      }
      // Same benign-false-positive guards as always: the queue must be
      // empty AND flush must have exported everything, so any residual
      // gap is genuinely absent from the room, not merely in-flight.
      this.flush();
      if (this.outQueue.length > 0) return;
      if (this.loroDoc.version().compare(this.lastSentVersion) !== 0) return;
      // Local compare against the accumulated holdings — the steady-state
      // audit costs zero fetches (this loop used to re-download the whole
      // room, snapshot included, every 30 minutes: ~65% of relay egress).
      if (!this.tailOverflow && !this.versionMissingFrom(this.roomHoldings())) return;
      // Possible loss (or ledger overflow): CONFIRM against ground truth
      // before reposting — the full scan is authoritative and this path
      // should be vanishingly rare.
      const roomMax = await this.scanRoomMax();
      this.tailOverflow = false;
      this.flush();
      if (this.outQueue.length > 0) return;
      if (this.loroDoc.version().compare(this.lastSentVersion) !== 0) return;
      if (!this.versionMissingFrom(roomMax)) return;
      console.warn(
        '[collab] the room lost ops this replica holds (compacted away?) — reposting full history',
      );
      this.loroDoc.commit();
      const emptyVersion = new LoroDoc().version();
      for (const chunk of this.exportChunks(emptyVersion)) {
        const seq = await this.client.postUpdate(this.roomId, await encryptBlob(this.key, chunk));
        this.foldTailMeta(seq, chunk);
        if (this.stream?.connected) this.awaitingEcho = { seq, at: Date.now() };
      }
    } catch (err) {
      // Advisory — the next scheduled audit retries — but never silent.
      console.warn('[collab] history audit failed:', (err as Error)?.message ?? err);
    }
  }

  /** Ground-truth room scan: page the ENTIRE room and decode every
   *  blob's version-vector maxima. This was the old audit's every-cycle
   *  body; it now runs only to confirm a suspected loss before the
   *  repost (and re-verifies the snapshot as a side effect). */
  private async scanRoomMax(): Promise<Map<string, number>> {
    const roomMax = new Map<string, number>();
    let after = 0;
    for (;;) {
      const page = await this.client.fetchUpdates(this.roomId, after);
      this.noteSnapCovers(page.snapCovers);
      const blobs: Uint8Array[] = [];
      if (page.snapshot && after < page.snapshot.coversThroughSeq) {
        try {
          const plainSnap = await decryptBlob(this.key, page.snapshot.blob);
          this.foldSnapshotMeta(plainSnap, page.snapshot.coversThroughSeq);
          blobs.push(plainSnap);
        } catch {
          /* undecryptable snapshot — audit what we can */
        }
      }
      const plains = await Promise.all(
        page.updates.map((u) => decryptBlob(this.key, u.blob).catch(() => null)),
      );
      for (const plain of plains) if (plain) blobs.push(plain);
      for (const b of blobs) {
        try {
          const meta = decodeImportBlobMeta(b, false);
          for (const [peer, counter] of meta.partialEndVersionVector.toJSON()) {
            if ((roomMax.get(peer) ?? 0) < counter) roomMax.set(peer, counter);
          }
        } catch {
          /* undecodable blob */
        }
      }
      const next = page.lastSeq;
      if (page.more && next <= after) {
        console.warn('[collab] audit scan page reported more without advancing — stopping');
        break;
      }
      after = next;
      if (!page.more) break;
    }
    return roomMax;
  }

  // --- presence ---

  async sendPresence(blob: Uint8Array): Promise<void> {
    if (this.ended) return;
    // Presence frames are DELIVERED over the stream, so while it isn't
    // connected nobody can see ours (and we can't see theirs) — posting
    // is pure waste, and on a dead credential it was the bulk of an
    // all-night 401 churn (field observation 2026-08-28). The keepalive
    // cadence resumes on the next post after the stream re-hellos.
    if (!this.stream?.connected) return;
    try {
      await this.client.postPresence(this.roomId, await encryptBlob(this.key, blob), this.streamSid);
    } catch {
      /* presence is fire-and-forget */
    }
  }

  // --- compaction ---

  private async uploadSnapshot(): Promise<void> {
    // NEVER compact over ops that haven't integrated: coversThroughSeq
    // truncates the stored log, and a snapshot exported while imports
    // pend does NOT contain them — the room loses them permanently.
    if (this.pendingImports) return;
    try {
      this.loroDoc.commit();
      const covers = this.lastSeq;
      const snapshot = this.loroDoc.export({ mode: 'snapshot' });
      const sealed = await encryptBlob(this.key, snapshot);
      await this.client.postSnapshot(this.roomId, bytesToBase64(sealed), covers);
      // We exported it — its content is known without a download.
      this.foldSnapshotMeta(snapshot, covers);
      this.consecutiveSnapshotFailures = 0;
    } catch (err) {
      // Compaction is best-effort (the log just stays longer) — but a host
      // whose snapshot POST always fails must leave evidence: that room
      // never compacts again.
      this.consecutiveSnapshotFailures++;
      if (this.consecutiveSnapshotFailures === 1 || this.consecutiveSnapshotFailures % 5 === 0) {
        console.warn(
          `[collab] snapshot upload failed (${this.consecutiveSnapshotFailures} in a row):`,
          (err as Error)?.message ?? err,
        );
      }
    }
  }

  /** Split the ops between two versions into update blobs that each
   *  fit under the relay's per-update cap (the "chunked client-side"
   *  the wire design promised). Chunks are ORDINARY updates: streams
   *  push them live and importers park early arrivals in the causal-
   *  dependency queue until the set completes — no snapshot detour, no
   *  log truncation, no data-loss surface. */
  private exportChunks(
    from: ReturnType<LoroDoc['version']>,
  ): Uint8Array[] {
    this.loroDoc.commit();
    const to = this.loroDoc.version();
    const spans: { id: { peer: `${number}`; counter: number }; len: number }[] = [];
    for (const [peer, end] of to.toJSON()) {
      const start = from.get(peer) ?? 0;
      if (end > start) spans.push({ id: { peer, counter: start }, len: end - start });
    }
    const out: Uint8Array[] = [];
    const emit = (sp: typeof spans): void => {
      if (sp.length === 0) return;
      const blob = this.loroDoc.export({ mode: 'updates-in-range', spans: sp });
      const totalLen = sp.reduce((n, x) => n + x.len, 0);
      if (blob.length <= this.updateByteLimit || totalLen <= 1) {
        out.push(blob); // single-op blobs ship as-is; the server cap is 8x our limit
        return;
      }
      if (sp.length > 1) {
        const mid = Math.ceil(sp.length / 2);
        emit(sp.slice(0, mid));
        emit(sp.slice(mid));
      } else {
        const span = sp[0]!;
        const half = Math.floor(span.len / 2);
        emit([{ id: span.id, len: half }]);
        emit([{ id: { peer: span.id.peer, counter: span.id.counter + half }, len: span.len - half }]);
      }
    };
    emit(spans);
    return out;
  }

  /** Replace the oversized queue head with its chunked equivalents.
   *  Intermediate chunks ack back to the span's FROM version, so a
   *  crash mid-sequence re-exports the whole span on resume (imports
   *  are idempotent); only the final chunk advances to the head's end
   *  version. */
  private chunkQueueHead(): void {
    const entry = this.outQueue[0]!;
    const chunks = this.exportChunks(entry.from);
    const replacements = chunks.map((blob, i) => ({
      blob,
      version: i === chunks.length - 1 ? entry.version : entry.from,
      from: entry.from,
    }));
    this.outQueue.splice(0, 1, ...replacements);
    this.emitStatus();
  }

  private authNotified = false;

  private notifyAuthRejected(): void {
    if (this.authNotified) return;
    this.authNotified = true;
    this.callbacks.onAuthRejected?.();
  }

  /** The stream saw two consecutive relay-confirmed 401/403s. For a
   *  GUEST-PASS session that's terminal: the pass is immutable, guests
   *  cannot re-mint one (host-only endpoint), and auth runs before the
   *  room lookup server-side — so the client can never even learn
   *  whether the room still exists. Retrying forever just churned
   *  presence/stream against week-expired passes all night (field
   *  observation 2026-08-28). Members keep today's behavior: notify
   *  once and let the stream retry at its ceiling, because an expired
   *  entitlement can quietly renew and heal the session. */
  private handleAuthDead(): void {
    if (this.client.opts.guestAuth === true) {
      this.callbacks.onGuestAuthExpired?.();
      this.handleEnded();
      return;
    }
    this.notifyAuthRejected();
  }

  private emitStatus(): void {
    this.callbacks.onStatus?.({ connected: this.connected, queuedUpdates: this.outQueue.length });
  }

  private handleEnded(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.inboundTimer) clearTimeout(this.inboundTimer);
    this.inboundTimer = null;
    this.inboundBuf = [];
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.catchUpTimer) clearInterval(this.catchUpTimer);
    if (this.auditTimer) clearInterval(this.auditTimer);
    if (this.auditKickoff) clearTimeout(this.auditKickoff);
    if (this.sendRetryTimer) clearTimeout(this.sendRetryTimer);
    this.flushTimer = this.catchUpTimer = this.auditTimer = null;
    this.auditKickoff = null;
    this.sendRetryTimer = null;
    this.stream?.stop();
    this.stream = null;
    this.connected = false;
    this.callbacks.onEnded?.();
  }
}
