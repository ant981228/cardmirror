// @vitest-environment jsdom
/**
 * End-to-end session test: two full editor peers (real schema, real
 * LoroSyncPlugin, real encrypted transport) syncing through the
 * in-process rooms relay — seed propagation, live convergence, the
 * offline→reconnect travel-day cycle, the P1 highlight-union regression
 * through the whole stack, and session end.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { schema } from '../../src/schema/index.js';
import { RoomsClient, RoomsError } from '../../src/editor/collab/room-client.js';
import { CollabSession } from '../../src/editor/collab/collab-session.js';
import { decodeShareCode } from '../../src/editor/collab/collab-crypto.js';
import { startRoomsMock, type RoomsMock } from './_rooms-mock.js';
import {
  mkView,
  settle,
  sleep,
  simpleDoc,
  mixedDoc,
  docText,
  findText,
  rangeFullyMarked,
  addMarkOn,
  typeAfter,
} from './_loro-helpers.js';

let mock: RoomsMock;
let client: RoomsClient;

beforeAll(async () => {
  mock = await startRoomsMock();
  client = new RoomsClient({ baseUrl: () => mock.url, token: () => mock.token });
});
afterAll(async () => {
  await mock.close();
});

const FAST = { flushMs: 25, minBackoffMs: 20, maxBackoffMs: 60, catchUpMs: 60_000 };

async function hostAndJoin(seedDoc = mixedDoc()) {
  const { session: host, shareCode } = await CollabSession.host({
    pmDoc: seedDoc,
    client,
    ...FAST,
  });
  const hostView = mkView(host.plugins());
  await settle();
  host.start();

  const decoded = decodeShareCode(shareCode)!;
  const joiner = await CollabSession.join({ ...decoded, client, ...FAST });
  const joinView = mkView(joiner.plugins());
  await settle();
  joiner.start();
  await sleep(80);
  return { host, hostView, joiner, joinView };
}

describe('ended-room join strictness (410)', () => {
  it('join() rejects on a tombstoned room instead of faking success', async () => {
    // Regression: the 410 branch in catchUp used to swallow the strict
    // initial sync, so joining an ended/expired room resolved with an empty,
    // already-ended session — the UI mounted a blank doc, toasted "Joined
    // the session", and persisted a phantom resumable record.
    const { session: host, shareCode } = await CollabSession.host({
      pmDoc: simpleDoc('a session that will end before the join'),
      client,
      ...FAST,
    });
    const decoded = decodeShareCode(shareCode)!;
    await client.deleteRoom(decoded.roomId); // host ended / room GC'd
    const err = await CollabSession.join({ ...decoded, client, ...FAST }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RoomsError);
    expect((err as RoomsError).status).toBe(410);
    await host.stop();
  });
});

describe('collab session end-to-end', () => {
  it('propagates the seed to a joiner', async () => {
    const seed = mixedDoc();
    const { host, hostView, joiner, joinView } = await hostAndJoin(seed);
    expect(joinView.state.doc.eq(seed)).toBe(true);
    expect(hostView.state.doc.eq(seed)).toBe(true);
    await joiner.stop();
    await host.stop();
  });

  it('converges live concurrent edits in both directions', async () => {
    const { host, hostView, joiner, joinView } = await hostAndJoin();
    typeAfter(hostView, 'quick fox', ' swiftly');
    typeAfter(joinView, 'lazy dog', ' sleeping');
    await sleep(250);
    expect(joinView.state.doc.eq(hostView.state.doc)).toBe(true);
    const t = docText(hostView.state.doc);
    expect(t).toContain('quick fox swiftly');
    expect(t).toContain('lazy dog sleeping');
    await joiner.stop();
    await host.stop();
  });

  it('survives the travel-day cycle: offline queue, edits both sides, reconnect merge', async () => {
    const { host, hostView, joiner, joinView } = await hostAndJoin();

    mock.pause();
    host.restart(); // sever live sockets so the outage is total
    joiner.restart();
    await sleep(60);

    typeAfter(hostView, 'riverbank', ' upstream');
    typeAfter(joinView, 'evidence text', ' and warrants');
    await sleep(120); // flush timers run; posts fail; queues hold
    expect(host.queuedUpdates + joiner.queuedUpdates).toBeGreaterThan(0);
    expect(docText(hostView.state.doc)).not.toBe(docText(joinView.state.doc));

    mock.resume();
    await sleep(500); // reconnect (backoff ≤60ms) + hello catch-up + drain
    expect(joinView.state.doc.eq(hostView.state.doc)).toBe(true);
    const t = docText(hostView.state.doc);
    expect(t).toContain('riverbank upstream');
    expect(t).toContain('evidence text and warrants');
    await joiner.stop();
    await host.stop();
  });

  it('inbound micro-batching: a burst of frames imports as ONE binding transaction', async () => {
    const { session: host, shareCode } = await CollabSession.host({
      pmDoc: mixedDoc(),
      client,
      ...FAST,
    });
    const hostView = mkView(host.plugins());
    await settle();
    host.start();
    const decoded = decodeShareCode(shareCode)!;
    const joiner = await CollabSession.join({
      ...decoded,
      client,
      ...FAST,
      receiveBatchMs: 250, // wide window so the whole burst lands in one drain
    });
    // Count the joiner's doc-changing dispatches (the binding's imports).
    let docDispatches = 0;
    const el = document.createElement('div');
    document.body.appendChild(el);
    const { EditorState } = await import('prosemirror-state');
    const { EditorView } = await import('prosemirror-view');
    const { schema } = await import('../../src/schema/index.js');
    const joinView: InstanceType<typeof EditorView> = new EditorView(el, {
      state: EditorState.create({ schema, plugins: joiner.plugins() }),
      dispatchTransaction(tx) {
        if (tx.docChanged) docDispatches++;
        joinView.updateState(joinView.state.apply(tx));
      },
    });
    await settle();
    joiner.start();
    await sleep(400);
    const baseline = docDispatches; // initial sync import(s)

    // Three flush-frames' worth of typing inside one 250ms window.
    for (let i = 0; i < 3; i++) {
      typeAfter(hostView, 'riverbank', ` batch${i}`);
      await sleep(45); // > flushMs(25): each burst ships as its own frame
    }
    await sleep(600); // drain + settle
    expect(docText(joinView.state.doc)).toContain('batch2');
    // All frames landed, but as ONE import → ONE doc-changing dispatch.
    expect(docDispatches - baseline).toBe(1);

    await joiner.stop();
    await host.stop();
    hostView.destroy();
    joinView.destroy();
  });

  it('backlog notice: silent when catch-up re-fetches frames the stream already delivered', async () => {
    // The field complaint (2026-08-05): the "synced N edits" toast fired
    // constantly during healthy sessions. The fetch cursor deliberately
    // lags the live stream, so every periodic catch-up re-fetches frames
    // that are ALREADY in the doc — the notice must gate on the doc
    // actually changing.
    const merged: number[] = [];
    const { session: host, shareCode } = await CollabSession.host({
      pmDoc: mixedDoc(),
      client,
      ...FAST,
    });
    const hostView = mkView(host.plugins());
    await settle();
    host.start();
    const decoded = decodeShareCode(shareCode)!;
    const joiner = await CollabSession.join({
      ...decoded,
      client,
      ...FAST,
      backlogNoticeMinBlindMs: 30,
      callbacks: { onBacklogMerged: (n) => merged.push(n) },
    });
    const joinView = mkView(joiner.plugins());
    await settle();
    joiner.start();
    await sleep(300); // both streams up, live delivery flowing

    // ≥25 frames of live typing (flush every 25ms), all stream-delivered.
    for (let i = 0; i < 30; i++) {
      typeAfter(hostView, 'riverbank', ` w${i}`);
      await sleep(30);
    }
    await sleep(300);
    expect(docText(joinView.state.doc)).toContain('w29'); // stream delivered

    await joiner.catchUp(); // the periodic tick, driven manually
    expect(merged).toEqual([]); // re-fetched frames changed nothing → silent

    await joiner.stop();
    await host.stop();
    hostView.destroy();
    joinView.destroy();
  });

  it('backlog notice: a genuine blind window with novel edits announces once', async () => {
    const merged: number[] = [];
    const { session: host, shareCode } = await CollabSession.host({
      pmDoc: mixedDoc(),
      client,
      ...FAST,
    });
    const hostView = mkView(host.plugins());
    await settle();
    host.start();
    const decoded = decodeShareCode(shareCode)!;
    // Slow reconnect backoff keeps the joiner stream-blind while the
    // host publishes, so the catch-up runs INSIDE the blind window.
    // (Retries land at 30-100% of the backoff: 15s keeps the earliest
    // possible reconnect, 4.5s, past the ~2-3s typing loop below.)
    const joiner = await CollabSession.join({
      ...decoded,
      client,
      flushMs: 25,
      minBackoffMs: 15_000,
      maxBackoffMs: 15_000,
      catchUpMs: 600_000,
      backlogNoticeMinBlindMs: 30,
      callbacks: { onBacklogMerged: (n) => merged.push(n) },
    });
    const joinView = mkView(joiner.plugins());
    await settle();
    joiner.start();
    await sleep(200);

    // Sever the joiner's stream while the relay is down; it stays down
    // for the backoff even after the relay comes back.
    mock.pause();
    joiner.restart();
    await sleep(80); // connect fails → onDown → blind window opens
    mock.resume();

    // The host (stream alive, posts retrying) publishes ≥25 frames the
    // joiner cannot see — one relay ROW per edit: the outbound queue
    // coalesces adjacent ticks, so wait for each edit to land before
    // the next (the notice threshold counts rows).
    for (let i = 0; i < 30; i++) {
      typeAfter(hostView, 'riverbank', ` b${i}`);
      for (let w = 0; w < 40 && host.debugState().queued > 0; w++) await sleep(10);
      await sleep(30);
    }
    await sleep(300);
    expect(docText(joinView.state.doc)).not.toContain('b29'); // truly blind

    await joiner.catchUp();
    expect(merged.length).toBe(1); // novel + blind ≥30ms → one notice
    expect(merged[0]!).toBeGreaterThanOrEqual(25);
    expect(docText(joinView.state.doc)).toContain('b29');

    await joiner.catchUp();
    expect(merged.length).toBe(1); // nothing new → still one

    await joiner.stop();
    await host.stop();
    hostView.destroy();
    joinView.destroy();
  });

  it('preserves the highlight union through the full stack (P1 regression)', async () => {
    const { host, hostView, joiner, joinView } = await hostAndJoin(
      simpleDoc('The quick fox jumped over the lazy dog tonight.'),
    );
    mock.pause();
    host.restart();
    joiner.restart();
    await sleep(60);
    const green = schema.marks['highlight']!.create({ color: 'green' });
    addMarkOn(hostView, 'The quick fox', green);
    addMarkOn(joinView, 'fox jumped over', green);
    await sleep(120);
    mock.resume();
    await sleep(500);
    expect(joinView.state.doc.eq(hostView.state.doc)).toBe(true);
    const union = findText(hostView.state.doc, 'The quick fox jumped over');
    expect(
      rangeFullyMarked(hostView.state.doc, union.from, union.to, schema.marks['highlight']!, {
        color: 'green',
      }),
    ).toBe(true);
    await joiner.stop();
    await host.stop();
  });

  it('ends the session for everyone (host end → participant onEnded)', async () => {
    let joinerEnded = false;
    const { session: host, shareCode } = await CollabSession.host({
      pmDoc: simpleDoc('to end'),
      client,
      ...FAST,
    });
    const hostView = mkView(host.plugins());
    await settle();
    host.start();
    const joiner = await CollabSession.join({
      ...decodeShareCode(shareCode)!,
      client,
      ...FAST,
      callbacks: { onEnded: () => (joinerEnded = true) },
    });
    const jView = mkView(joiner.plugins());
    await settle();
    joiner.start();
    await sleep(80);
    await host.end();
    await sleep(100);
    expect(joinerEnded).toBe(true);
    hostView.destroy();
    jView.destroy();
  });
});

describe('send-path liveness (a hung POST must not wedge the queue forever)', () => {
  it('the send queue recovers after a half-open request times out', async () => {
    // drainQueue's `sending` mutex clears only in finally; a fetch that
    // never settles (lid-close, NAT rebind) left every later flush()
    // returning at the first line with the chip stuck on "queued N"
    // (2026-09-01 review, SC3).
    const tClient = new RoomsClient({
      baseUrl: () => mock.url,
      token: () => mock.token,
      postTimeoutMs: 120,
    });
    const { session: host, shareCode } = await CollabSession.host({
      pmDoc: simpleDoc('liveness'),
      client: tClient,
      ...FAST,
    });
    const hostView = mkView(host.plugins());
    await settle();
    host.start();
    const joiner = await CollabSession.join({ ...decodeShareCode(shareCode)!, client, ...FAST });
    const joinView = mkView(joiner.plugins());
    await settle();
    joiner.start();
    await sleep(80);
    try {
      mock.hangNextUpdates(1); // the NEXT post is swallowed by a half-open socket
      typeAfter(hostView, 'liveness', ' ONE');
      await sleep(200); // that POST is now pending forever inside drainQueue
      typeAfter(hostView, 'liveness ONE', ' TWO');
      await sleep(900); // deadline → retry → both edits land
      expect(docText(joinView.state.doc)).toContain('liveness ONE TWO');
      expect(host.debugState().queued).toBe(0);
    } finally {
      mock.hangNextUpdates(0);
      await host.stop();
      await joiner.stop();
      hostView.destroy();
      joinView.destroy();
    }
  }, 10_000);
});

describe('catch-up re-entry (a concurrent request must not be dropped)', () => {
  it('catchUp(expectMissingDeps) arriving while a catch-up runs is re-run, escalation intact', async () => {
    // The `catchUpRunning` guard discarded a concurrent call outright —
    // including the expectMissingDeps=true signal that forces the full
    // resync when nothing new arrives. Recovery then waited for the
    // 5-minute timer (2026-09-01 review, SC8).
    const { host, hostView, joiner, joinView } = await hostAndJoin(simpleDoc('reentry'));
    try {
      const before = mock.updateFetches();
      const first = joiner.catchUp(); // in flight at its first await
      void joiner.catchUp(true); // shed-frame healer asks for a resync
      await first;
      await sleep(300);
      // First pass = 1 tail fetch. The re-run must do its own tail fetch
      // AND the from-zero resync (expectMissingDeps with nothing new).
      expect(mock.updateFetches() - before, 'tail + re-run tail + resync').toBeGreaterThanOrEqual(3);
    } finally {
      await host.stop();
      await joiner.stop();
      hostView.destroy();
      joinView.destroy();
    }
  }, 10_000);
});

describe('stop() is a real final drain', () => {
  it('stop() waits for an in-flight send and nothing posts after it resolves', async () => {
    // drainQueue() returned at once when `sending` was already true, so
    // stop()'s "final flush attempt" was a no-op whenever a POST was in
    // flight; stop() also never set a stopping flag, so the in-flight
    // failure re-armed sendRetryTimer AFTER stop() cleared the old one —
    // a timer (and a POST) outliving the session (2026-09-01 review, SC10).
    const tClient = new RoomsClient({
      baseUrl: () => mock.url,
      token: () => mock.token,
      postTimeoutMs: 150,
    });
    const { session: host, shareCode } = await CollabSession.host({
      pmDoc: simpleDoc('final drain'),
      client: tClient,
      ...FAST,
    });
    const hostView = mkView(host.plugins());
    await settle();
    host.start();
    const roomId = decodeShareCode(shareCode)!.roomId;
    await sleep(60);
    try {
      mock.hangNextUpdates(1); // the next POST is swallowed by a half-open socket
      typeAfter(hostView, 'final drain', ' EDIT');
      await sleep(80); // now in flight inside drainQueue
      const t0 = Date.now();
      await host.stop();
      const took = Date.now() - t0;
      expect(took, 'stop() awaited the in-flight send (bounded by its deadline)').toBeGreaterThanOrEqual(50);
      const posted = mock.updateCount(roomId);
      await sleep(1500); // the old retry timer would have fired inside this window
      expect(mock.updateCount(roomId), 'no POST after stop()').toBe(posted);
      expect(host.debugState().sending).toBe(false);
    } finally {
      mock.hangNextUpdates(0);
      await host.stop();
      hostView.destroy();
    }
  }, 10_000);
});

describe('offline queue coalescing', () => {
  it('a run of offline flush ticks drains as ONE update, not one POST per tick', async () => {
    // flush() pushed one queue entry per 500ms tick and drainQueue posted
    // them strictly one at a time: ten offline minutes ≈ 1200 sequential
    // POSTs, 1200 relay rows, 1200 rows for every peer to fetch and
    // decrypt (2026-09-01 review, SC2).
    const { host, hostView, joiner, joinView } = await hostAndJoin(simpleDoc('coalesce'));
    const roomId = host.roomId;
    try {
      mock.pause();
      for (let i = 0; i < 6; i++) {
        typeAfter(hostView, 'coalesce', ` e${i}`);
        await sleep(FAST.flushMs * 2); // each edit lands in its own flush tick
      }
      await sleep(FAST.flushMs * 2);
      // (Coalescing runs on every drain attempt, so the queue may already
      // hold a single merged entry here — the POST count below is the
      // real assertion.)
      expect(host.debugState().queued).toBeGreaterThanOrEqual(1);
      const before = mock.updateCount(roomId);
      mock.resume();
      // The stream never dropped (the mock's pause only 503s requests), so
      // the next flush is what re-triggers the drain — one more edit.
      typeAfter(hostView, 'coalesce', ' e6');
      await sleep(600);
      expect(host.debugState().queued).toBe(0);
      expect(mock.updateCount(roomId) - before, 'the whole run went as one update').toBeLessThanOrEqual(1);
      for (const e of ['e0', 'e5', 'e6']) expect(docText(joinView.state.doc)).toContain(e);
    } finally {
      mock.resume();
      await host.stop();
      await joiner.stop();
      hostView.destroy();
      joinView.destroy();
    }
  }, 10_000);
});

describe('pendingImports must clear once the parked ops integrate', () => {
  it('a shed frame healed by the ordinary catch-up does not disable host compaction forever', async () => {
    // pendingImports was set true on any batch with parked ops but only
    // ever set false inside the full-resync escalation block — the common
    // heal (ordinary catch-up fetches the missing deps) left it latched,
    // and uploadSnapshot early-returned for the rest of the session: the
    // room log grew without bound (2026-09-01 review, SC1).
    const { session: host, shareCode } = await CollabSession.host({
      pmDoc: simpleDoc('compact me'),
      client,
      ...FAST,
      snapshotEvery: 2, // compaction after every 2nd host post
    });
    const hostView = mkView(host.plugins());
    await settle();
    host.start();
    const decoded = decodeShareCode(shareCode)!;
    const joiner = await CollabSession.join({ ...decoded, client, ...FAST });
    const joinView = mkView(joiner.plugins());
    await settle();
    joiner.start();
    await sleep(80);
    try {
      // Frame A is shed from the host's stream; frame B (depending on A)
      // arrives → parked → catch-up fetches A → both integrate.
      mock.mutePush(true);
      typeAfter(joinView, 'compact me', ' A');
      await sleep(FAST.flushMs * 3);
      mock.mutePush(false);
      typeAfter(joinView, 'compact me A', ' B');
      await sleep(500);
      expect(docText(hostView.state.doc)).toContain('compact me A B');
      expect(host.debugState().pendingImports, 'healed → nothing pending').toBe(false);
      // The host now posts twice → a snapshot must reach the room.
      typeAfter(hostView, 'compact me A B', ' h1');
      await sleep(FAST.flushMs * 3);
      typeAfter(hostView, 'compact me A B h1', ' h2');
      await sleep(FAST.flushMs * 3);
      typeAfter(hostView, 'compact me A B h1 h2', ' h3');
      await sleep(400);
      const page = await client.fetchUpdates(host.roomId, 0);
      expect(page.snapshot, 'host compaction resumed').not.toBeNull();
    } finally {
      mock.mutePush(false);
      await host.stop();
      await joiner.stop();
      hostView.destroy();
      joinView.destroy();
    }
  }, 10_000);
});

describe('audit runs behind a fresh catch-up', () => {
  it('the audit probe sees a CURRENT cursor (no stale-window re-download)', async () => {
    // The 30-minute audit had its own timer, unaligned with the catch-up
    // timer, so its "~100B probe" fetched (and decrypted) every row since
    // a cursor that was ~2.5 minutes stale on average (2026-09-01
    // review, T7). Now every audit is preceded by a catch-up.
    const { session: host, shareCode } = await CollabSession.host({
      pmDoc: simpleDoc('audit me'),
      client,
      ...FAST,
      catchUpMs: 600_000, // no periodic catch-up: only the audit can advance the cursor
      auditDelayMs: 600, // after the scripted edits below, before the final check
    });
    const hostView = mkView(host.plugins());
    await settle();
    host.start();
    const decoded = decodeShareCode(shareCode)!;
    const joiner = await CollabSession.join({ ...decoded, client, ...FAST });
    const joinView = mkView(joiner.plugins());
    await settle();
    joiner.start();
    await sleep(60);
    try {
      mock.mutePush(true); // the host's stream delivers nothing → its cursor goes stale
      for (let i = 0; i < 3; i++) {
        typeAfter(joinView, 'audit me', ` j${i}`);
        await sleep(FAST.flushMs * 3);
      }
      const roomMax = (await client.fetchUpdates(host.roomId, 0)).lastSeq;
      expect(host.debugState().lastSeq, 'sanity: stale before the audit').toBeLessThan(roomMax);
      await sleep(800); // the audit kickoff (600ms after start) fires inside this window
      expect(host.debugState().lastSeq, 'audit ran behind a catch-up').toBeGreaterThanOrEqual(roomMax);
    } finally {
      mock.mutePush(false);
      await host.stop();
      await joiner.stop();
      hostView.destroy();
      joinView.destroy();
    }
  }, 10_000);
});

describe('catch-up skips rows the stream already delivered', () => {
  it('stream-delivered frames are not decrypted and imported a second time by catch-up', async () => {
    // The cursor deliberately advances only in catch-up, so the periodic
    // catch-up re-fetched, re-decrypted (one await each) and re-imported
    // every row the stream had pushed since — hundreds of no-op imports
    // per cycle in a busy room (2026-09-01 review, T8). The row is still
    // FETCHED (the cursor invariant is untouched); the work is skipped.
    const { host, hostView, joiner, joinView } = await hostAndJoin(simpleDoc('skip me'));
    try {
      for (let i = 0; i < 5; i++) {
        typeAfter(hostView, 'skip me', ` s${i}`);
        await sleep(FAST.flushMs * 3);
      }
      await sleep(200);
      expect(docText(joinView.state.doc)).toContain('s4');
      const before = joiner.debugState().catchUpRowsSkipped;
      await joiner.catchUp();
      expect(joiner.debugState().catchUpRowsSkipped - before, 'the 5 pushed rows were skipped').toBeGreaterThanOrEqual(5);
      expect(joiner.debugState().lastSeq, 'the cursor still advanced past them').toBeGreaterThan(0);
    } finally {
      await host.stop();
      await joiner.stop();
      hostView.destroy();
      joinView.destroy();
    }
  }, 10_000);
});

describe('snapshot export memo', () => {
  it('two exports at the same version share one buffer; an edit invalidates it', async () => {
    const { session, shareCode } = await CollabSession.host({ pmDoc: simpleDoc('memo'), client, ...FAST });
    void shareCode;
    const view = mkView(session.plugins());
    await settle();
    try {
      const a = session.exportSnapshot();
      const b = session.exportSnapshot();
      expect(b, 'same version → memoized buffer (persist + history share one export)').toBe(a);
      typeAfter(view, 'memo', ' changed');
      await settle();
      const c = session.exportSnapshot();
      expect(c).not.toBe(a);
    } finally {
      await session.stop();
      view.destroy();
    }
  });
});

describe('import batches are byte-bounded (2026-09-01 review, SC13/SC12)', () => {
  it('a push burst over the inbound byte cap drains in more than one batch', async () => {
    const { session: host, shareCode } = await CollabSession.host({ pmDoc: simpleDoc('burst'), client, ...FAST });
    const hostView = mkView(host.plugins());
    await settle();
    host.start();
    const joiner = await CollabSession.join({
      ...decodeShareCode(shareCode)!,
      client,
      ...FAST,
      receiveBatchMs: 400, // one wide window collects the whole burst
      inboundBatchBytes: 1500, // ~1KB frames → several batches
    });
    const joinView = mkView(joiner.plugins());
    await settle();
    joiner.start();
    await sleep(80);
    try {
      const big = 'x'.repeat(1000);
      for (let i = 0; i < 6; i++) {
        typeAfter(hostView, 'burst', ` ${big}${i}`);
        await sleep(FAST.flushMs * 2);
      }
      await sleep(900);
      expect(docText(joinView.state.doc)).toContain(`${big}5`);
      expect(joiner.debugState().inboundDrains, 'sliced, not one giant import').toBeGreaterThanOrEqual(2);
    } finally {
      await host.stop();
      await joiner.stop();
      hostView.destroy();
      joinView.destroy();
    }
  }, 10_000);

  it('a full resync over the slice cap imports in slices, not one buffered batch', async () => {
    const { session: host, shareCode } = await CollabSession.host({ pmDoc: simpleDoc('resync'), client, ...FAST });
    const hostView = mkView(host.plugins());
    await settle();
    host.start();
    const big = 'y'.repeat(1000);
    for (let i = 0; i < 6; i++) {
      typeAfter(hostView, 'resync', ` ${big}${i}`);
      await sleep(FAST.flushMs * 2);
    }
    await sleep(100);
    const joiner = await CollabSession.join({
      ...decodeShareCode(shareCode)!,
      client,
      ...FAST,
      resyncSliceBytes: 1500,
    });
    const joinView = mkView(joiner.plugins());
    await settle();
    joiner.start();
    await sleep(80);
    try {
      await joiner.catchUp(true); // "deps missing" with nothing new → full resync from zero
      expect(joiner.debugState().resyncSlices, 'several slices').toBeGreaterThanOrEqual(2);
      expect(docText(joinView.state.doc)).toContain(`${big}5`);
    } finally {
      await host.stop();
      await joiner.stop();
      hostView.destroy();
      joinView.destroy();
    }
  }, 10_000);
});

describe('a send that keeps failing is reported, not retried in silence (2026-09-01 review, SC14)', () => {
  it('after N consecutive failures the session signals onSendStuck once; success clears it', async () => {
    const stuck: number[] = [];
    const { session: host, shareCode } = await CollabSession.host({
      pmDoc: simpleDoc('stuck'),
      client,
      ...FAST,
      sendStuckAfter: 2,
      callbacks: { onSendStuck: (n) => stuck.push(n) },
    });
    const hostView = mkView(host.plugins());
    await settle();
    host.start();
    void shareCode;
    await sleep(60);
    try {
      mock.setUpdateFailure({ status: 500, detail: 'poisoned' });
      typeAfter(hostView, 'stuck', ' edit');
      await sleep(2200); // failure #1 at once, #2 after the ~1s retry
      expect(stuck.filter((n) => n > 0).length, 'signaled once').toBe(1);
      mock.setUpdateFailure(null);
      typeAfter(hostView, 'stuck edit', ' more');
      await sleep(2500); // retry succeeds → cleared
      expect(stuck[stuck.length - 1], 'cleared on success').toBe(0);
      expect(host.debugState().queued).toBe(0);
    } finally {
      mock.setUpdateFailure(null);
      await host.stop();
      hostView.destroy();
    }
  }, 15_000);
});

describe('holdings ledger buckets rows (2026-09-01 review, SC9)', () => {
  it('many rows fold into few buckets, so the ledger does not overflow into whole-room audit downloads', async () => {
    const { session: host, shareCode } = await CollabSession.host({ pmDoc: simpleDoc('ledger'), client, ...FAST });
    const hostView = mkView(host.plugins());
    await settle();
    host.start();
    const joiner = await CollabSession.join({
      ...decodeShareCode(shareCode)!,
      client,
      ...FAST,
      tailBucketRows: 4,
      tailMetasCap: 10, // per-row ledgering would overflow at 10 rows
    });
    const joinView = mkView(joiner.plugins());
    await settle();
    joiner.start();
    await sleep(80);
    try {
      for (let i = 0; i < 15; i++) {
        typeAfter(hostView, 'ledger', ` r${i}`);
        for (let w = 0; w < 40 && host.debugState().queued > 0; w++) await sleep(10);
      }
      await sleep(300);
      expect(docText(joinView.state.doc)).toContain('r14');
      const d = joiner.debugState();
      expect(d.tailBuckets, '15 rows → ≤4 buckets of 4').toBeLessThanOrEqual(4);
      expect(d.tailOverflow, 'no overflow → no whole-room re-download at audit time').toBe(false);
    } finally {
      await host.stop();
      await joiner.stop();
      hostView.destroy();
      joinView.destroy();
    }
  }, 10_000);
});

describe('join resilience', () => {
  it('a relay blip (5xx / connection refused) during join is retried, not treated as offline', async () => {
    // The steady-state stream backs off and retries; the JOIN's strict
    // initial catch-up did not — a deploy's 502/503 either failed the join
    // outright or silently chose a stale prefetched seed (2026-09-01
    // review, PH-A13).
    const { session: host, shareCode } = await CollabSession.host({
      pmDoc: simpleDoc('join through a blip'),
      client,
      ...FAST,
    });
    const hostView = mkView(host.plugins());
    await settle();
    host.start();
    const decoded = decodeShareCode(shareCode)!;
    mock.pause();
    // The blip clears while the join is still retrying (FAST base 20ms →
    // retries at ~20/40/80ms, jittered; the pause lifts inside that window).
    setTimeout(() => mock.resume(), 60);
    let joiner: CollabSession | null = null;
    try {
      joiner = await CollabSession.join({ ...decoded, client, ...FAST });
      const joinView = mkView(joiner.plugins());
      await settle();
      expect(docText(joinView.state.doc)).toContain('join through a blip');
      joinView.destroy();
    } finally {
      mock.resume();
      await joiner?.stop();
      await host.stop();
      hostView.destroy();
    }
  }, 10_000);
});

describe('paging loops never trust the server to make progress', () => {
  it('a page that says `more` but does not advance the cursor terminates the loop', async () => {
    // A proxy-mangled body or half-deployed relay answering {more:true,
    // lastSeq:<same>} forever turned catch-up into an unbounded, un-delayed
    // fetch loop pinning the relay (2026-09-01 review, T4).
    const { host, hostView, joiner, joinView } = await hostAndJoin(simpleDoc('paging'));
    mock.setStuckPaging(true);
    try {
      const before = mock.updateFetches();
      const settled = await Promise.race([
        joiner.catchUp().then(() => 'settled' as const),
        sleep(1500).then(() => 'hung' as const),
      ]);
      expect(settled, 'catch-up must terminate on a non-advancing page').toBe('settled');
      expect(mock.updateFetches() - before, 'and must not hammer the relay').toBeLessThan(10);
    } finally {
      mock.setStuckPaging(false);
      await host.stop();
      await joiner.stop();
      hostView.destroy();
      joinView.destroy();
    }
  }, 10_000);
});

describe('room-history integrity (compaction-loss self-heal)', () => {
  it('P14: a compaction that destroyed a peer\'s ops is detected and repaired by the audit', async () => {
    const mock = await startRoomsMock();
    const client = new RoomsClient({ baseUrl: () => mock.url, token: () => mock.token });
    try {
      // Host + joiner, both online; joiner contributes edits.
      const { session: host, shareCode } = await CollabSession.host({
        pmDoc: simpleDoc('the shared travel-day doc'),
        client,
        flushMs: 40,
        minBackoffMs: 30,
        maxBackoffMs: 60,
      });
      const hostView = mkView(host.plugins());
      await settle();
      host.start();
      const decoded = decodeShareCode(shareCode)!;
      const joiner = await CollabSession.join({
        ...decoded,
        client,
        flushMs: 40,
        minBackoffMs: 30,
        maxBackoffMs: 60,
      });
      const joinerView = mkView(joiner.plugins());
      await settle();
      joiner.start();
      await sleep(300);
      typeAfter(joinerView, 'shared', ' JOINER-EDIT');
      await sleep(300);
      expect(docText(hostView.state.doc)).toContain('JOINER-EDIT');

      // SIMULATED FIELD CORRUPTION: a compaction snapshot exported from
      // a doc that LACKS the joiner's ops, covering their stored seqs —
      // the relay truncates the log and the joiner's history is gone
      // from the room (pre-guard hosts could do this while imports were
      // pending). The bogus snapshot comes from a doc holding ONLY the
      // room's first blob (the host-only seed).
      const { importRoomKey, encryptBlob: seal, bytesToBase64: b64 } = await import(
        '../../src/editor/collab/collab-crypto.js'
      );
      const key = await importRoomKey(decoded.keyBytes);
      const hostOnly = new (await import('loro-crdt')).LoroDoc();
      // First room update = the seed snapshot (host-only history).
      const firstPage = await client.fetchUpdates(host.roomId, 0);
      // find the earliest blob (the seed) and import just that
      const { decryptBlob: open_ } = await import('../../src/editor/collab/collab-crypto.js');
      const earliest = firstPage.snapshot
        ? firstPage.snapshot.blob
        : firstPage.updates[0]!.blob;
      hostOnly.import(await open_(key, earliest));
      const lastSeq = (await client.fetchUpdates(host.roomId, 0)).lastSeq;
      const bogus = hostOnly.export({ mode: 'snapshot' });
      await client.postSnapshot(host.roomId, b64(await seal(key, bogus)), lastSeq);

      // The room's stored history now lacks the joiner's ops. A FRESH
      // participant (like a resumed host after cache loss) can't see them:
      const fresh = await CollabSession.join({ ...decoded, client, flushMs: 40 });
      const freshView = mkView(fresh.plugins());
      await settle();
      expect(docText(freshView.state.doc)).not.toContain('JOINER-EDIT');

      // THE HEAL: the joiner's audit sees the room missing its acked ops
      // and reposts full history.
      await joiner.auditRoomHistory();
      await fresh.catchUp();
      await settle();
      expect(docText(freshView.state.doc)).toContain('JOINER-EDIT');

      await fresh.stop();
      await joiner.stop();
      await host.stop();
      hostView.destroy();
      joinerView.destroy();
      freshView.destroy();
    } finally {
      await mock.close();
    }
  }, 25_000);
});

describe('large documents (413 avoidance via chunked updates)', () => {
  it('P15: oversized seeds and updates ship as cap-sized chunks and still converge', async () => {
    const mock = await startRoomsMock();
    const client = new RoomsClient({ baseUrl: () => mock.url, token: () => mock.token });
    try {
      // A tiny per-update limit forces BOTH paths: the seed exceeds it
      // (chunk-seeded room) and so does a big paste later.
      const { session: host, shareCode } = await CollabSession.host({
        pmDoc: simpleDoc('the enormous master file body that will not fit in one update'),
        client,
        flushMs: 40,
        minBackoffMs: 30,
        maxBackoffMs: 60,
        updateByteLimit: 400,
      });
      const hostView = mkView(host.plugins());
      await settle();
      host.start();

      // Joiner consumes the snapshot-fast-path seed.
      const joiner = await CollabSession.join({
        ...decodeShareCode(shareCode)!,
        client,
        flushMs: 40,
        minBackoffMs: 30,
        maxBackoffMs: 60,
        updateByteLimit: 400,
      });
      const joinerView = mkView(joiner.plugins());
      await settle();
      joiner.start();
      await sleep(300);
      expect(docText(joinerView.state.doc)).toContain('master file body');

      // Oversized edit (a paste bigger than the update cap) drains via
      // the snapshot fallback and reaches the partner.
      typeAfter(hostView, 'enormous', ' ' + 'BIGPASTE'.repeat(120));
      await sleep(600);
      expect(docText(joinerView.state.doc)).toContain('BIGPASTE'.repeat(3));

      // The room's stored state stays coherent for a fresh join.
      const fresh = await CollabSession.join({ ...decodeShareCode(shareCode)!, client, flushMs: 40 });
      const freshView = mkView(fresh.plugins());
      await settle();
      expect(docText(freshView.state.doc)).toContain('BIGPASTE');
      expect(docText(freshView.state.doc)).toContain('master file body'); // seed content intact

      await fresh.stop();
      await joiner.stop();
      await host.stop();
      hostView.destroy();
      joinerView.destroy();
      freshView.destroy();
    } finally {
      await mock.close();
    }
  }, 25_000);
});

describe('delivery-cursor discipline (shed frames must not create gaps)', () => {
  it('P16: a shed push is recovered by catch-up even when later frames arrive', async () => {
    const mock = await startRoomsMock();
    const client = new RoomsClient({ baseUrl: () => mock.url, token: () => mock.token });
    try {
      const { session: a, shareCode } = await CollabSession.host({
        pmDoc: simpleDoc('three peer shed test'),
        client,
        flushMs: 40,
        minBackoffMs: 30,
        maxBackoffMs: 60,
      });
      const aView = mkView(a.plugins());
      await settle();
      a.start();
      const decoded = decodeShareCode(shareCode)!;
      const mkPeer = async () => {
        const s = await CollabSession.join({
          ...decoded,
          client,
          flushMs: 40,
          minBackoffMs: 30,
          maxBackoffMs: 60,
          catchUpMs: 600_000, // no periodic catch-up — the test drives it
        });
        const v = mkView(s.plugins());
        await settle();
        s.start();
        return { s, v };
      };
      const b = await mkPeer();
      const c = await mkPeer();
      await sleep(300);

      // A's edit posts while pushes are muted: stored in the room,
      // delivered to NOBODY's stream.
      mock.mutePush(true);
      typeAfter(aView, 'three', ' LOST-EDIT');
      await sleep(250);
      mock.mutePush(false);

      // B's edit (causally independent of A's) pushes normally — C's
      // stream sees a frame ABOVE the shed one. The old cursor logic
      // jumped past the shed row here, making it unfetchable forever.
      typeAfter(b.v, 'peer', ' AFTER');
      await sleep(300);
      expect(docText(c.v.state.doc)).toContain('AFTER');

      // Catch-up must still find the shed row (cursor never jumped it).
      await c.s.catchUp();
      await settle();
      expect(docText(c.v.state.doc)).toContain('LOST-EDIT');
      await b.s.catchUp();
      await settle();
      expect(docText(b.v.state.doc)).toContain('LOST-EDIT');

      await c.s.stop();
      await b.s.stop();
      await a.stop();
      aView.destroy();
      b.v.destroy();
      c.v.destroy();
    } finally {
      await mock.close();
    }
  }, 25_000);
});

describe('send-completeness (the field one-way desync)', () => {
  it('P17: plugin-generated repair/heal ops always reach the relay (no silent send-drop)', async () => {
    const { LoroDoc } = await import('loro-crdt');
    const { LoroUndoPlugin } = await import('loro-prosemirror');
    const { collabInvariantHealPlugin } = await import(
      '../../src/editor/collab/collab-invariants.js'
    );
    const { collabRepairPlugin } = await import('../../src/editor/collab/collab-repair.js');
    const { importRoomKey, decryptBlob } = await import(
      '../../src/editor/collab/collab-crypto.js'
    );
    const { schema } = await import('../../src/schema/index.js');
    const { TextSelection } = await import('prosemirror-state');
    const { EditorState } = await import('prosemirror-state');
    const { EditorView } = await import('prosemirror-view');

    const mock = await startRoomsMock();
    const client = new RoomsClient({ baseUrl: () => mock.url, token: () => mock.token });
    try {
      // Seed a card whose body text peers will concurrently underline /
      // emphasize — overlapping exclusive marks trigger the repair sweep,
      // whose appendTransaction-generated ops were the ones that leaked.
      const seed = schema.node('doc', null, [
        schema.node('card', null, [
          schema.node('tag', { id: 'h1' }, [schema.text('the tag line for this card')]),
          schema.node('card_body', null, [
            schema.text('a fairly long body sentence that both debaters will mark up concurrently now'),
          ]),
        ]),
      ]);
      const { session: host, shareCode } = await CollabSession.host({
        pmDoc: seed,
        client,
        flushMs: 40,
        catchUpMs: 100000,
        minBackoffMs: 30,
        maxBackoffMs: 60,
        snapshotEvery: 100000,
      });
      const decoded = decodeShareCode(shareCode)!;
      const sessions = [host];
      for (let i = 1; i < 3; i++) {
        sessions.push(
          await CollabSession.join({
            ...decoded,
            client,
            flushMs: 40,
            catchUpMs: 100000,
            minBackoffMs: 30,
            maxBackoffMs: 60,
          }),
        );
      }
      // FULL production plugin stack (heal + every-peer repair) — the
      // stack that surfaced the leak; bare LoroSyncPlugin does not.
      const views = sessions.map((s) => {
        const el = document.createElement('div');
        document.body.appendChild(el);
        return new EditorView(el, {
          state: EditorState.create({
            schema,
            plugins: [
              ...s.plugins(),
              LoroUndoPlugin({ doc: s.loroDoc }),
              collabInvariantHealPlugin(),
              collabRepairPlugin(() => true),
            ],
          }),
        });
      });
      await settle();
      for (const s of sessions) s.start();
      await sleep(200);

      // Concurrent overlapping marks, faster than the flush window.
      const marks = [schema.marks['underline_mark']!, schema.marks['emphasis_mark']!];
      for (let round = 0; round < 20; round++) {
        for (let i = 0; i < views.length; i++) {
          const v = views[i]!;
          const r = findText(v.state.doc, 'body sentence');
          const from = r.from + (round % 5);
          v.dispatch(v.state.tr.addMark(from, from + 6, marks[i % 2]!.create()));
        }
        await sleep(12);
      }
      // Drain.
      for (let i = 0; i < 60; i++) {
        for (const s of sessions) s.flush();
        await sleep(100);
        if (sessions.every((s) => s.debugState().queued === 0 && !s.debugState().pendingImports)) break;
      }
      for (const s of sessions) await s.catchUp().catch(() => {});
      await sleep(300);

      // Reconstruct the relay's full doc from seq 0.
      const key = await importRoomKey(decoded.keyBytes);
      const relayDoc = new LoroDoc();
      let after = 0;
      for (;;) {
        const page = await client.fetchUpdates(host.roomId, after);
        const blobs: Uint8Array[] = [];
        if (page.snapshot && after < page.snapshot.coversThroughSeq) {
          blobs.push(await decryptBlob(key, page.snapshot.blob));
        }
        for (const u of page.updates) blobs.push(await decryptBlob(key, u.blob));
        if (blobs.length) relayDoc.importBatch(blobs);
        after = page.lastSeq;
        if (!page.more) break;
      }
      const relayVer = relayDoc.version().toJSON() as Map<string, number>;

      // THE INVARIANT: the relay holds every op each peer authored. A
      // leak shows as relayVer[peer] < the peer's own counter.
      for (const s of sessions) {
        const peer = s.loroDoc.peerIdStr;
        const own = (s.loroDoc.version().toJSON() as Map<string, number>).get(peer as never) ?? 0;
        const atRelay = relayVer.get(peer as never) ?? 0;
        expect(atRelay, `relay missing ${own - atRelay} of peer ${peer.slice(0, 5)}'s ops`).toBe(own);
      }
      // And with the relay complete, the peers converge and stay valid.
      expect(views[1]!.state.doc.eq(views[0]!.state.doc)).toBe(true);
      expect(views[2]!.state.doc.eq(views[0]!.state.doc)).toBe(true);
      for (const v of views) expect(() => v.state.doc.check()).not.toThrow();

      for (const s of sessions) await s.stop();
      for (const v of views) v.destroy();
    } finally {
      await mock.close();
    }
  }, 25_000);
});

describe('incremental history audit (egress discipline, 2026-07-24)', () => {
  it('steady-state audits never re-download the room; a compaction epoch is verified exactly once', async () => {
    // The old audit paged the ENTIRE room (snapshot included) from seq 0
    // every 30 minutes on every client — measured at ~65% of all relay
    // egress. The rewrite compares locally against maxima folded from
    // bytes that already passed through, so a steady-state audit costs
    // one ~100-byte probe, and a compaction costs ONE snapshot download.
    const freshMock = await startRoomsMock();
    const spyClient = new RoomsClient({
      baseUrl: () => freshMock.url,
      token: () => freshMock.token,
    });
    const calls: Array<{ after: number; haveSnap: number | undefined }> = [];
    const orig = spyClient.fetchUpdates.bind(spyClient);
    spyClient.fetchUpdates = (roomId, after, opts) => {
      calls.push({ after, haveSnap: opts?.haveSnap });
      return orig(roomId, after, opts);
    };
    try {
      const { session: host, shareCode } = await CollabSession.host({
        pmDoc: simpleDoc('audit egress doc'),
        client: spyClient,
        ...FAST,
      });
      const hostView = mkView(host.plugins());
      await settle();
      host.start();
      const decoded = decodeShareCode(shareCode)!;
      const joiner = await CollabSession.join({ ...decoded, client: spyClient, ...FAST });
      const joinView = mkView(joiner.plugins());
      await settle();
      joiner.start();
      await sleep(150);
      typeAfter(joinView, 'egress', ' JOINER-WORDS');
      await sleep(200);

      // Steady state: the audit makes exactly one from-cursor probe.
      calls.length = 0;
      await joiner.auditRoomHistory();
      expect(calls.length).toBe(1);
      expect(calls[0]!.after).toBeGreaterThan(0);
      const updatesBefore = freshMock.updateCount(host.roomId);

      // A (valid) compaction lands: full room state, covering everything.
      const { importRoomKey, encryptBlob: seal, bytesToBase64: b64, decryptBlob: open_ } =
        await import('../../src/editor/collab/collab-crypto.js');
      const { LoroDoc } = await import('loro-crdt');
      const key = await importRoomKey(decoded.keyBytes);
      const all = new LoroDoc();
      let after = 0;
      for (;;) {
        const page = await orig(host.roomId, after);
        if (page.snapshot) all.import(await open_(key, page.snapshot.blob));
        for (const u of page.updates) all.import(await open_(key, u.blob));
        after = page.lastSeq;
        if (!page.more) break;
      }
      const covers = after;
      await spyClient.postSnapshot(
        host.roomId,
        b64(await seal(key, all.export({ mode: 'snapshot' }))),
        covers,
      );

      // Next audit verifies the new epoch with at most two requests —
      // and when the cursor sits behind the new covers, the PROBE itself
      // returns the snapshot and the verify costs one request total.
      calls.length = 0;
      await joiner.auditRoomHistory();
      expect(calls.length).toBeLessThanOrEqual(2);

      // Epoch verified — audits are probe-only again, and the verified
      // compaction produced NO false-positive repost.
      calls.length = 0;
      await joiner.auditRoomHistory();
      expect(calls.filter((c) => c.after === 0).length).toBe(0);
      expect(calls.length).toBe(1);
      expect(freshMock.updateCount(host.roomId)).toBeLessThanOrEqual(updatesBefore);

      await joiner.stop();
      await host.stop();
      hostView.destroy();
      joinView.destroy();
    } finally {
      await freshMock.close();
    }
  }, 25_000);
});
