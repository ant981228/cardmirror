/**
 * Live-session persistence manager (M3).
 *
 * Attached alongside installSeams for every hosted/joined/resumed
 * session: on a short cadence (and on pagehide, the last reliable
 * moment before a kill) it writes the session's CRDT state to the
 * collab store as increments over the last persisted version —
 * steady-state writes are keystroke-sized, and every COMPACT_EVERY
 * increments the record is rebased onto a fresh snapshot. Cleared on
 * explicit Leave/End and on remote tombstone; a crash leaves the
 * record behind, which is the whole point — the home screen's
 * Sessions list resumes from it.
 */

import type { CollabSession } from './collab-session.js';
import {
  deleteSessionRecord,
  loadSessionRecord,
  saveSessionRecord,
  type PersistedSessionRecord,
} from './collab-store.js';

const PERSIST_MS = 2_500;
/** Big documents persist less often: every 40th increment rebases onto a
 *  full snapshot (a synchronous wasm export, 0.3-0.8s on a 20 MB master)
 *  and IndexedDB structured-clones the whole multi-MB record on EVERY
 *  write — the same size-adaptive cadence collab-history already uses
 *  (2026-09-01 review, SC7). */
const PERSIST_SLOW_MS = 10_000;
const BIG_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const COMPACT_EVERY = 40;

export interface PersistCadence {
  persistMs?: number;
  slowPersistMs?: number;
  bigSnapshotBytes?: number;
  /** Consecutive write failures (storage denied/full) — writeInner
   *  swallows them by design; this is how the UI learns crash-resume
   *  has silently stopped working. Reset to 0 on the next success. */
  onFailure?: (consecutive: number) => void;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface PersistHandle {
  /** Force a write now (used at attach and before teardown). */
  flush(): Promise<void>;
  /** Force a write now AND verify the stored record covers the session's
   *  current version (read-back check — writeInner swallows storage errors
   *  by design). Use when the record is about to become the doc's only copy. */
  verifiedFlush(): Promise<boolean>;
  /** Stop persisting AND delete the record (Leave/End/tombstone). */
  clear(): Promise<void>;
  /** Stop persisting, keep the record (app-driven teardown paths that
   *  should stay resumable). */
  dispose(): void;
}

export function attachSessionPersistence(
  session: CollabSession,
  shareCode: string,
  getDocTitle: () => string,
  getDocId: () => string | null = () => null,
  cadence: PersistCadence = {},
): PersistHandle {
  let disposed = false;
  const persistMs = cadence.persistMs ?? PERSIST_MS;
  const slowPersistMs = cadence.slowPersistMs ?? PERSIST_SLOW_MS;
  const bigSnapshotBytes = cadence.bigSnapshotBytes ?? BIG_SNAPSHOT_BYTES;
  let lastSnapshotBytes = 0;
  let failures = 0;
  // Writes are serialized through a promise tail so an explicit
  // flush() AWAITS any in-flight write instead of silently no-oping
  // past it (the attach-time initial write races an immediate flush).
  let tail: Promise<void> = Promise.resolve();
  // In-memory mirror of the stored record; rebuilt from scratch when
  // absent so a resume continues the SAME record.
  let record: PersistedSessionRecord | null = null;

  const writeInner = async (): Promise<void> => {
    if (disposed) return;
    try {
      if (!record) {
        record = (await loadSessionRecord(session.roomId)) ?? null;
      }
      const meta = session.persistMeta();
      // A rename mid-session: republish the doc title to the room's meta map
      // (new joiners + invite labels see it) — it was published once at start
      // and never again (audit find, 2026-07-10). The excluded 'cm-meta'
      // origin keeps it out of the undo stack; the write itself rides the
      // session's normal flush.
      const title = getDocTitle();
      // Sticky: once a docId is known it stays on the record (the
      // resolver can answer null transiently, e.g. before first save).
      const docId = getDocId() ?? record?.docId ?? null;
      // Sticky like docId: the pass arrives once (host-create or a
      // link join) and must survive every rewrite of the record.
      const guestPass = session.guestPass ?? record?.guestPass ?? null;
      if (record && title && title !== record.docTitle) {
        try {
          session.loroDoc.getMap('meta').set('title', title);
          session.loroDoc.commit({ origin: 'cm-meta' });
        } catch {
          /* best-effort */
        }
      }
      if (
        record &&
        record.increments.length < COMPACT_EVERY &&
        bytesEqual(record.persistedVersion, session.encodedVersion())
      ) {
        // Doc unchanged — refresh the cursor/sent metadata AND the title
        // when they moved (a rename with no edits previously never reached
        // the Sessions list); otherwise skip the write entirely.
        if (
          record.lastSeq === meta.lastSeq &&
          bytesEqual(record.sentVersion, meta.sentVersion) &&
          record.docTitle === getDocTitle() &&
          (record.docId ?? null) === docId
        ) {
          return;
        }
        record = {
          ...record,
          lastSeq: meta.lastSeq,
          sentVersion: meta.sentVersion,
          docTitle: getDocTitle(),
          docId,
          guestPass,
          updatedAt: Date.now(),
        };
        await saveSessionRecord(record);
        return;
      }
      if (record && record.increments.length < COMPACT_EVERY) {
        const inc = session.exportSince(record.persistedVersion);
        record = {
          ...record,
          increments: [...record.increments, inc.bytes],
          persistedVersion: inc.version,
          lastSeq: meta.lastSeq,
          sentVersion: meta.sentVersion,
          docTitle: getDocTitle(),
          docId,
          guestPass,
          updatedAt: Date.now(),
        };
      } else {
        // First write, or compaction due: rebase onto a full snapshot.
        record = {
          roomId: session.roomId,
          shareCode,
          role: session.role,
          lastSeq: meta.lastSeq,
          sentVersion: meta.sentVersion,
          snapshot: session.exportSnapshot(),
          increments: [],
          persistedVersion: session.encodedVersion(),
          docTitle: getDocTitle(),
          docId,
          guestPass,
          updatedAt: Date.now(),
        };
      }
      lastSnapshotBytes = record.snapshot.byteLength;
      await saveSessionRecord(record);
      if (failures > 0) {
        failures = 0;
        cadence.onFailure?.(0);
      }
    } catch {
      /* storage denied/full — persistence degrades, the session still works */
      cadence.onFailure?.(++failures);
    }
  };

  const write = (): Promise<void> => {
    tail = tail.then(writeInner);
    return tail;
  };

  // Self-rescheduling so the cadence can slow once the snapshot is big.
  let timer: ReturnType<typeof setTimeout>;
  const schedule = (delay: number): void => {
    timer = setTimeout(() => {
      void write().finally(() => {
        if (!disposed) schedule(lastSnapshotBytes > bigSnapshotBytes ? slowPersistMs : persistMs);
      });
    }, delay);
  };
  schedule(persistMs);
  const onPageHide = (): void => void write();
  // Hide transition only — the same tab-in write cost collab-history
  // paid (a compaction tick here is a full snapshot export too).
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') void write();
  };
  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('visibilitychange', onVisibility);
  void write();

  const stop = (): void => {
    disposed = true;
    clearTimeout(timer);
    window.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('visibilitychange', onVisibility);
  };

  return {
    flush: () => write(),
    verifiedFlush: async () => {
      // writeInner deliberately swallows storage errors (steady-state ticks
      // must not break a working session) — so an explicit flush whose record
      // is about to become the doc's ONLY copy (keep-resumable close drops
      // the journal) verifies end-to-end instead: read the record back and
      // check it covers the session's current version. Callers abort the
      // close when this returns false (audit find, 2026-07-10).
      await write();
      try {
        const stored = await loadSessionRecord(session.roomId);
        return stored != null && bytesEqual(stored.persistedVersion, session.encodedVersion());
      } catch {
        return false;
      }
    },
    clear: async () => {
      stop();
      // Serialize the delete AFTER any in-flight write: a write() that was
      // already past its `disposed` guard when we stopped would otherwise
      // resurrect the record right after we delete it (Leave/End immediately
      // following a periodic/initial write).
      await tail.catch(() => {});
      await deleteSessionRecord(session.roomId);
    },
    dispose: stop,
  };
}
