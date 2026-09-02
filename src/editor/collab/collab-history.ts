/**
 * Session history files — the durable record behind Recover Previous
 * Version.
 *
 * Co-editing gives each participant undo over only their OWN changes,
 * so a session that gets wrecked (a bad merge, a hostile joiner) has no
 * recovery path once it ends: the session record is deleted on
 * Leave/End/tombstone by design (it exists for CRASH recovery — see
 * collab-persist), `.cmir` files carry no CRDT history, and the relay
 * compacts and tombstones its copy. This module writes a separate
 * `{roomId}.cmir-history` file into the crash-journals folder that
 * SURVIVES session end — deliberately including a remote tombstone,
 * since a deliberate attacker can end the session for everyone.
 *
 * The file is a full Loro snapshot (state + complete oplog) in a JSON
 * envelope. Because the CRDT never records wall-clock time
 * (`setRecordTimestamp` is off — turning it on would grow every change
 * and publish per-peer edit times to the room), the envelope carries
 * LOCAL observation times: each write notes how far every peer's op
 * counter had advanced by that moment. The version list derives its
 * timestamps from those observations, so nothing about the shared
 * document changes.
 *
 * Recovery never touches the live session: a chosen version is checked
 * out on a scratch LoroDoc built from the file and opened as a new
 * unsaved document. See collab-recover-ui.ts for the flow.
 */

import { LoroDoc } from 'loro-crdt';
import { createNodeFromLoroObj } from 'loro-prosemirror';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../../schema/index.js';
import { getElectronHost } from '../host/index.js';
import type { HistoryChangeTime, HistoryEnvelope, HistoryEnvelopeWrite } from '../host/types.js';
import { base64ToBytes } from './collab-crypto.js';
import { configTextStyle, type CollabSession } from './collab-session.js';

/** Write cadence. Deliberately slower than the session record's 2.5s:
 *  each write is a full snapshot (~the document's own size), and losing
 *  the last few seconds of history is acceptable for a feature whose
 *  job is recovering from vandalism, not from crashes. Huge documents
 *  slow down further — exportSnapshot is a synchronous wasm call on the
 *  renderer (measured 0.3-0.8s on a 20 MB tournament master), so the
 *  remaining per-write hitch is paid once a minute there, not thrice. */
const HISTORY_PERSIST_MS = 20_000;
const HISTORY_PERSIST_SLOW_MS = 60_000;
const BIG_SNAPSHOT_BYTES = 4 * 1024 * 1024;
/** First write waits out the session-start critical path: hosting a
 *  big document already freezes the renderer seeding the CRDT, and the
 *  attach-time snapshot+write added ~1s on top of it. Nothing is lost
 *  by waiting — crash safety is collab-persist's job, and pagehide
 *  still forces a write if the window closes sooner. */
const INITIAL_WRITE_DELAY_MS = 8_000;

/** Idle gap that starts a new group in the version list. */
export const HISTORY_GROUP_GAP_MS = 60_000;

export interface HistoryHandle {
  /** Force a write now (the recover dialog flushes before reading). */
  flush(): Promise<void>;
  /** Stop writing. NEVER deletes the file — retention is the point. */
  dispose(): void;
}

/** Live handles by roomId, so the dialog can flush the focused
 *  session's file without threading the handle through the UI. */
const liveHandles = new Map<string, HistoryHandle>();

export function historyHandleFor(roomId: string): HistoryHandle | null {
  return liveHandles.get(roomId) ?? null;
}

/** The slice of the host the writer needs — injectable for tests. */
export interface HistoryHostLike {
  writeHistory(envelope: HistoryEnvelopeWrite): Promise<void>;
  readHistory(target: { roomId?: string; path?: string }): Promise<HistoryEnvelope | null>;
}

export function attachSessionHistory(
  session: CollabSession,
  getDocTitle: () => string,
  hostForTests?: HistoryHostLike,
  opts: { onFailure?: (consecutive: number) => void } = {},
): HistoryHandle {
  const host: HistoryHostLike | null = hostForTests ?? getElectronHost();
  let disposed = false;
  // Set synchronously by dispose(): an in-flight write's finally must not
  // re-arm the schedule while the dispose-time write is still draining.
  let stopping = false;
  let tail: Promise<void> = Promise.resolve();
  let startedAt = Date.now();
  let changeTimes: HistoryChangeTime[] = [];
  /** Last VV we recorded observation times for (peer -> exclusive counter). */
  let seenVV = new Map<string, number>();
  /** Version bytes of the last write, to skip idle rewrites. */
  let writtenVersion: Uint8Array | null = null;
  let seeded = false;
  let lastSnapshotBytes = 0;
  let failures = 0;

  const writeInner = async (): Promise<void> => {
    if (disposed || !host) return;
    try {
      if (!seeded) {
        seeded = true;
        // Resuming a room this machine already has history for: merge,
        // so earlier observation times (and the true start) survive.
        const prior = await host.readHistory({ roomId: session.roomId });
        if (prior) {
          startedAt = Math.min(startedAt, prior.startedAt);
          changeTimes = [...prior.changeTimes];
          for (const t of changeTimes) {
            seenVV.set(t.peer, Math.max(seenVV.get(t.peer) ?? 0, t.counter));
          }
        }
      }
      const version = session.encodedVersion();
      if (writtenVersion && bytesEqual(writtenVersion, version)) return;
      // Note how far each peer had advanced by now — the version list's
      // only clock. VV counters are exclusive uppers ("knows ops < v").
      const now = Date.now();
      const vv = session.loroDoc.version().toJSON() as Map<string, number>;
      for (const [peer, counter] of vv) {
        if ((seenVV.get(peer) ?? 0) < counter) {
          seenVV.set(peer, counter);
          changeTimes.push({ peer, counter, at: now });
        }
      }
      const snapshot = session.exportSnapshot();
      const envelope: HistoryEnvelopeWrite = {
        v: 1,
        roomId: session.roomId,
        docTitle: getDocTitle() || 'Untitled',
        startedAt,
        updatedAt: now,
        changeTimes,
        snapshot,
      };
      await host.writeHistory(envelope);
      writtenVersion = version;
      lastSnapshotBytes = snapshot.byteLength;
      if (failures > 0) {
        failures = 0;
        opts.onFailure?.(0);
      }
    } catch {
      /* disk full/denied — history degrades, the session still works */
      opts.onFailure?.(++failures);
    }
  };

  const write = (): Promise<void> => {
    tail = tail.then(writeInner);
    return tail;
  };

  // Self-rescheduling timer so the cadence can slow for huge docs.
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (delay: number): void => {
    timer = setTimeout(() => {
      void write().finally(() => {
        if (!disposed && !stopping) {
          schedule(lastSnapshotBytes > BIG_SNAPSHOT_BYTES ? HISTORY_PERSIST_SLOW_MS : HISTORY_PERSIST_MS);
        }
      });
    }, delay);
  };
  schedule(INITIAL_WRITE_DELAY_MS);
  const onPageHide = (): void => void write();
  // Only the HIDE transition: visibilitychange also fires on tab-in, and
  // a write is a synchronous full snapshot export (0.3-0.8s on a 20 MB
  // master) — alt-tabbing BACK to a big co-edited doc froze the renderer
  // (2026-09-01 review). pagehide stays unconditional.
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') void write();
  };
  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('visibilitychange', onVisibility);

  const handle: HistoryHandle = {
    flush: () => write(),
    dispose: () => {
      // One last write so the file covers the session's final state,
      // then stop. The file itself is retained unconditionally — a
      // remote tombstone must not be able to destroy the evidence.
      stopping = true;
      void write().finally(() => {
        disposed = true;
      });
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibility);
      liveHandles.delete(session.roomId);
    },
  };
  // Never clobber a live writer for the same room: with two handles the
  // first became unreachable (historyHandleFor / dispose only ever saw
  // the last) while still writing. Keep the first; stop this one.
  const existing = liveHandles.get(session.roomId);
  if (existing) {
    console.warn('[collab-history] a history writer is already live for this room — keeping it');
    if (timer !== null) clearTimeout(timer);
    disposed = true;
    window.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('visibilitychange', onVisibility);
    return existing;
  }
  liveHandles.set(session.roomId, handle);
  return handle;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ── Version-list derivation (pure; unit-tested) ─────────────────────

export interface VersionRow {
  /** Checkout target: the causal heads once this change is included. */
  frontier: { peer: `${number}`; counter: number }[];
  peer: string;
  /** Local observation time, or null for changes that predate this
   *  machine's tracking (an imported room, a pre-feature session). */
  atMs: number | null;
  /** True on the row that stands in for the session's initial seeding
   *  (see collapseSeedPrefix). */
  isSeed?: boolean;
}

export interface VersionGroup {
  rows: VersionRow[];
  /** First/last known times in the group (null for untimed groups). */
  startMs: number | null;
  endMs: number | null;
  peers: string[];
}

/** Every change in causal order, each with the frontier that checkout
 *  needs to reproduce the document as of that change. */
export function deriveVersionRows(
  ldoc: LoroDoc,
  changeTimes: readonly HistoryChangeTime[],
): VersionRow[] {
  type Ch = {
    peer: `${number}`;
    counter: number;
    length: number;
    lamport: number;
    deps: { peer: `${number}`; counter: number }[];
  };
  const all: Ch[] = [];
  for (const [peer, changes] of ldoc.getAllChanges()) {
    for (const c of changes) {
      all.push({ peer, counter: c.counter, length: c.length, lamport: c.lamport, deps: c.deps });
    }
  }
  // A linear extension of causality: a change's lamport is strictly
  // greater than each dep's (start = max over dep END lamports), so
  // sorting by lamport can never place a child before its dependency;
  // lamport ties are concurrent and safe in either order.
  all.sort((a, b) => a.lamport - b.lamport || (a.peer < b.peer ? -1 : a.peer > b.peer ? 1 : a.counter - b.counter));

  // Sort observation times once; a change's time is the FIRST tick that
  // covered its last op (counter+length <= observed exclusive counter).
  const timesByPeer = new Map<string, HistoryChangeTime[]>();
  for (const t of changeTimes) {
    const arr = timesByPeer.get(t.peer) ?? [];
    arr.push(t);
    timesByPeer.set(t.peer, arr);
  }
  for (const arr of timesByPeer.values()) arr.sort((a, b) => a.counter - b.counter);
  const timeFor = (peer: string, endExclusive: number): number | null => {
    const arr = timesByPeer.get(peer);
    if (!arr) return null;
    for (const t of arr) if (t.counter >= endExclusive) return t.at;
    return null;
  };

  const heads = new Set<string>();
  const key = (p: string, c: number): string => `${p}:${c}`;
  const rows: VersionRow[] = [];
  for (const c of all) {
    for (const d of c.deps) heads.delete(key(d.peer, d.counter));
    heads.add(key(c.peer, c.counter + c.length - 1));
    // Collapse to one head per peer (a peer's ops are totally ordered,
    // so its max counter covers the rest) — insurance against a dep
    // list that omits a same-peer predecessor.
    const perPeer = new Map<string, number>();
    for (const h of heads) {
      const at = h.lastIndexOf(':');
      const p = h.slice(0, at);
      const n = Number(h.slice(at + 1));
      perPeer.set(p, Math.max(perPeer.get(p) ?? -1, n));
    }
    rows.push({
      frontier: [...perPeer].map(([p, n]) => ({ peer: p as `${number}`, counter: n })),
      peer: c.peer,
      atMs: timeFor(c.peer, c.counter + c.length),
    });
  }
  return rows;
}

/**
 * Collapse the seeding prefix to one row. Hosting a session writes the
 * ENTIRE document into the CRDT as one commit, which Loro splits into
 * several changes (~6 for a 60-card file) — so the list otherwise opens
 * with a run of "versions" that are just the document half-built,
 * top-down, reading as if the bottom cards were deleted. Those cuts are
 * noise: nobody wants a partially seeded document. The leading run of
 * same-peer rows sharing one observation tick (or untimed) collapses to
 * its LAST row, marked `isSeed` so the dialog can label it "Session
 * started". Host edits inside the first ~20s write window fold in too —
 * an acceptable loss of granularity for the opening seconds.
 */
export function collapseSeedPrefix(rows: readonly VersionRow[]): VersionRow[] {
  if (rows.length < 2) {
    return rows.map((r, i) => (i === rows.length - 1 ? { ...r, isSeed: true } : r));
  }
  const first = rows[0]!;
  let end = 0; // inclusive end of the seed run
  while (
    end + 1 < rows.length &&
    rows[end + 1]!.peer === first.peer &&
    rows[end + 1]!.atMs === first.atMs
  ) {
    end++;
  }
  return [{ ...rows[end]!, isSeed: true }, ...rows.slice(end + 1)];
}

/** Group rows by idle gap. Untimed rows extend the current group (or
 *  form a leading one), so pre-tracking history stays reachable. */
export function groupVersionRows(
  rows: readonly VersionRow[],
  gapMs: number = HISTORY_GROUP_GAP_MS,
): VersionGroup[] {
  const groups: VersionGroup[] = [];
  let cur: VersionGroup | null = null;
  let lastTimed: number | null = null;
  for (const row of rows) {
    const fresh =
      cur === null || (row.atMs !== null && lastTimed !== null && row.atMs - lastTimed > gapMs);
    if (fresh) {
      cur = { rows: [], startMs: row.atMs, endMs: row.atMs, peers: [] };
      groups.push(cur);
    }
    cur!.rows.push(row);
    if (row.atMs !== null) {
      if (cur!.startMs === null) cur!.startMs = row.atMs;
      cur!.endMs = row.atMs;
      lastTimed = row.atMs;
    }
    if (!cur!.peers.includes(row.peer)) cur!.peers.push(row.peer);
  }
  return groups;
}

// ── Reconstruction ──────────────────────────────────────────────────

/** Materialize the document as of `frontier`, from a history file's
 *  snapshot. Always a scratch doc — the live session never checks out.
 *
 *  Deliberately does NOT use `checkout()`: Loro's checkout can spin
 *  unboundedly on large concurrent movable-list histories (observed
 *  live 2026-08-13 — 100% CPU, no return, on a real session's history;
 *  the same rows rebuild in seconds this way). Instead the update log
 *  is cut at the row's version (a frontier's causal closure) and
 *  imported into a fresh doc — the identical document state, and the
 *  scratch doc stays ATTACHED, so the binding reader's
 *  getOrCreateContainer writes (a cut landing mid-node leaves a map
 *  missing its children/attributes container) are ordinary edits
 *  rather than readonly-checkout violations. */
/** A reusable materializer over ONE imported source doc: the recover
 *  dialog materializes per preview click and again on "Open copy", and
 *  each call re-imported the whole snapshot (plus, on Open copy,
 *  re-decoded its base64) (2026-09-01 review, PH-A7). The per-version
 *  checkout itself is unchanged — and still never checkout()s. */
export function createVersionMaterializer(
  snapshot: Uint8Array,
): (frontier: VersionRow['frontier']) => PMNode {
  const source = new LoroDoc();
  source.import(snapshot);
  return (frontier) => materializeFrom(source, frontier);
}

export function materializeVersion(
  snapshot: Uint8Array,
  frontier: VersionRow['frontier'],
): PMNode {
  const source = new LoroDoc();
  source.import(snapshot);
  return materializeFrom(source, frontier);
}

function materializeFrom(source: LoroDoc, frontier: VersionRow['frontier']): PMNode {
  const vv = source.frontiersToVV(frontier);
  const prefix = source.exportJsonUpdates(undefined, vv);
  const ldoc = new LoroDoc();
  configTextStyle(ldoc);
  ldoc.importJsonUpdates(prefix);
  return createNodeFromLoroObj(schema, ldoc.getMap('doc') as never, new Map()) as PMNode;
}

export function snapshotFromEnvelope(envelope: HistoryEnvelope): Uint8Array {
  return base64ToBytes(envelope.snapshotB64);
}
