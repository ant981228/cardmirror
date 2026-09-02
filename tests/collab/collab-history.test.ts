// @vitest-environment jsdom

/**
 * Session history + Recover Previous Version (collab-history.ts).
 *
 * The load-bearing claim: a version chosen from the derived list —
 * frontier computed from the change graph alone, rebuilt on a scratch
 * doc from the file's snapshot — reproduces the document EXACTLY as it
 * stood, marks and attrs included. Everything else (grouping,
 * local-time bookkeeping, retention-on-dispose) supports that claim.
 */

import { describe, it, expect } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import type { CollabSession } from '../../src/editor/collab/collab-session.js';
import type { HistoryEnvelope, HistoryEnvelopeWrite } from '../../src/editor/host/types.js';
import {
  attachSessionHistory,
  collapseSeedPrefix,
  createVersionMaterializer,
  deriveVersionRows,
  groupVersionRows,
  historyHandleFor,
  materializeVersion,
  type HistoryHostLike,
  type VersionRow,
} from '../../src/editor/collab/collab-history.js';
import { createLoroPeers, syncAll, docText, settle, findText, type LoroPeer } from './_loro-helpers.js';

function card(i: number): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(`Tag ${i}`)),
    schema.nodes['card_body']!.create(null, schema.text(`ANCHOR${i} body text ${i}`)),
  ]);
}
const seed = (): PMNode =>
  schema.nodes['doc']!.createChecked(null, Array.from({ length: 6 }, (_, i) => card(i)));

describe('round-trip: derived frontier → checkout → materialize', () => {
  it('reproduces the exact pre-vandalism doc, marks and attrs included', async () => {
    const peers = await createLoroPeers(seed(), 2);
    const [a, b] = peers as [LoroPeer, LoroPeer];

    // Phase 1: the state worth recovering — typing plus two mark kinds.
    {
      const r = findText(a.view.state.doc, 'ANCHOR3');
      a.view.dispatch(a.view.state.tr.insert(r.to, schema.text('-KEEPME')));
      const r2 = findText(a.view.state.doc, 'body text 3');
      a.view.dispatch(
        a.view.state.tr.addMark(r2.from, r2.to, schema.marks['highlight']!.create({ color: 'cyan' })),
      );
      const r3 = findText(a.view.state.doc, 'body text 5');
      a.view.dispatch(a.view.state.tr.addMark(r3.from, r3.to, schema.marks['bold']!.create()));
    }
    await settle();
    await syncAll(peers);
    const expected = a.view.state.doc;
    const changesAtCheckpoint = [...a.ldoc.getAllChanges().values()].flat().length;

    // Phase 2: the vandalism, after the checkpoint.
    {
      const r = findText(b.view.state.doc, 'ANCHOR1');
      b.view.dispatch(
        b.view.state.tr.delete(r.from, Math.min(r.from + 150, b.view.state.doc.content.size - 2)),
      );
    }
    await settle();
    await syncAll(peers);
    expect(docText(a.doc())).not.toContain('ANCHOR1'); // damage landed

    // Recovery: rows derived from the final snapshot alone.
    const snapshot = a.exportAll();
    const scratch = new LoroDoc();
    scratch.import(snapshot);
    const rows = deriveVersionRows(scratch, []);
    const recovered = materializeVersion(snapshot, rows[changesAtCheckpoint - 1]!.frontier);

    expect(recovered.eq(expected), 'recovered doc equals the checkpoint doc').toBe(true);
    let cyan = false;
    let bold = false;
    recovered.descendants((n) => {
      for (const m of n.marks) {
        if (m.type.name === 'highlight' && m.attrs['color'] === 'cyan') cyan = true;
        if (m.type.name === 'bold') bold = true;
      }
    });
    expect(cyan && bold, 'marks with attrs survive').toBe(true);
    peers.forEach((p) => p.destroy());
  }, 120_000);

  it('EVERY derived row materializes — no cut of the graph yields an invalid frontier', async () => {
    const peers = await createLoroPeers(seed(), 2);
    const [a, b] = peers as [LoroPeer, LoroPeer];
    // Interleaved cross-peer editing so the change graph actually branches.
    for (let i = 0; i < 4; i++) {
      const ra = findText(a.view.state.doc, `ANCHOR${i}`);
      a.view.dispatch(a.view.state.tr.insert(ra.to, schema.text(`-A${i}`)));
      await settle();
      await syncAll(peers);
      const rb = findText(b.view.state.doc, `ANCHOR${i + 1}`);
      b.view.dispatch(b.view.state.tr.insert(rb.to, schema.text(`-B${i}`)));
      await settle();
      await syncAll(peers);
    }
    const snapshot = a.exportAll();
    const scratch = new LoroDoc();
    scratch.import(snapshot);
    const rows = deriveVersionRows(scratch, []);
    expect(rows.length).toBeGreaterThan(4);
    for (const [i, row] of rows.entries()) {
      const node = materializeVersion(snapshot, row.frontier);
      expect(node.type.name, `row ${i} materializes`).toBe('doc');
    }
    // The final row is the current document.
    const final = materializeVersion(snapshot, rows[rows.length - 1]!.frontier);
    expect(final.eq(a.view.state.doc)).toBe(true);
    peers.forEach((p) => p.destroy());
  }, 120_000);

  it('a shared materializer over ONE imported source matches per-call materialization for every row', async () => {
    // The recover dialog materializes per preview click and again on
    // "Open copy"; each call re-imported the whole snapshot (2026-09-01
    // review, PH-A7). One source doc, same output.
    const peers = await createLoroPeers(seed(), 2);
    const [a, b] = peers as [LoroPeer, LoroPeer];
    for (let i = 0; i < 3; i++) {
      const ra = findText(a.view.state.doc, `ANCHOR${i}`);
      a.view.dispatch(a.view.state.tr.insert(ra.to, schema.text(`-A${i}`)));
      await settle();
      await syncAll(peers);
      const rb = findText(b.view.state.doc, `ANCHOR${i + 1}`);
      b.view.dispatch(b.view.state.tr.insert(rb.to, schema.text(`-B${i}`)));
      await settle();
      await syncAll(peers);
    }
    const snapshot = a.exportAll();
    const scratch = new LoroDoc();
    scratch.import(snapshot);
    const rows = deriveVersionRows(scratch, []);
    const materialize = createVersionMaterializer(snapshot);
    for (const [i, row] of rows.entries()) {
      const shared = materialize(row.frontier);
      const direct = materializeVersion(snapshot, row.frontier);
      expect(shared.eq(direct), `row ${i} identical via the shared source`).toBe(true);
    }
    peers.forEach((p) => p.destroy());
  }, 120_000);

  it('never calls checkout() — the hang class is structurally excluded', async () => {
    // Loro's checkout() spun unboundedly (100% CPU, no return) on a
    // real movable-room history, 2026-08-13, hanging Recover on every
    // machine in the session. materializeVersion now rebuilds state by
    // importing the update log up to the row's version instead. Pin
    // that: with checkout() booby-trapped, materialization must still
    // succeed — so no future edit can quietly reintroduce the call.
    const peers = await createLoroPeers(seed(), 1);
    const a = peers[0]!;
    const snapshot = a.exportAll();
    const scratch = new LoroDoc();
    scratch.import(snapshot);
    const rows = deriveVersionRows(scratch, []);
    const proto = LoroDoc.prototype as unknown as { checkout: (...args: never[]) => unknown };
    const original = proto.checkout;
    proto.checkout = () => {
      throw new Error('materializeVersion must not use checkout()');
    };
    try {
      const node = materializeVersion(snapshot, rows[Math.floor(rows.length / 2)]!.frontier);
      expect(node.type.name).toBe('doc');
    } finally {
      proto.checkout = original;
    }
    peers.forEach((p) => p.destroy());
  }, 120_000);
});

describe('seeding', () => {
  it('the seed splits into several changes; collapse folds them into one flagged row', async () => {
    // Seeding alone (zero user edits) — Loro splits the one big commit.
    const bigSeed = schema.nodes['doc']!.createChecked(
      null,
      Array.from({ length: 60 }, (_, i) => card(i)),
    );
    const peers = await createLoroPeers(bigSeed, 1);
    const a = peers[0]!;
    const snapshot = a.exportAll();
    const scratch = new LoroDoc();
    scratch.import(snapshot);
    const rows = deriveVersionRows(scratch, []);
    expect(rows.length, 'seeding splits into multiple changes').toBeGreaterThan(1);

    // EVERY cut materializes — including mid-seed cuts that land inside
    // a half-built node (the binding reader creates missing containers;
    // the prefix-built scratch doc is attached, so those writes are
    // ordinary edits).
    for (const [i, row] of rows.entries()) {
      const node = materializeVersion(snapshot, row.frontier);
      expect(node.type.name, `row ${i} materializes`).toBe('doc');
    }

    // Collapsed: one seed row, flagged, reproducing the FULL seed state.
    const collapsed = collapseSeedPrefix(rows);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]!.isSeed).toBe(true);
    const seedDoc = materializeVersion(snapshot, collapsed[0]!.frontier);
    expect(docText(seedDoc)).toContain('ANCHOR59'); // bottom card present
    peers.forEach((p) => p.destroy());
  }, 120_000);

  it('collapse folds only the leading same-peer same-tick run', () => {
    const row = (atMs: number | null, peer = '1'): VersionRow => ({
      frontier: [{ peer: '1', counter: 0 }],
      peer,
      atMs,
    });
    // Seed run of 3 (same peer, same tick), then later edits.
    const collapsed = collapseSeedPrefix([row(100), row(100), row(100), row(100_000), row(200_000, '2')]);
    expect(collapsed).toHaveLength(3);
    expect(collapsed[0]!.isSeed).toBe(true);
    expect(collapsed[1]!.atMs).toBe(100_000);
    // A different PEER right after the first row ends the run immediately.
    const mixed = collapseSeedPrefix([row(100, '1'), row(100, '2'), row(100, '1')]);
    expect(mixed).toHaveLength(3);
    expect(mixed[0]!.isSeed).toBe(true);
  });
});

describe('grouping', () => {
  const row = (atMs: number | null, peer = '1'): VersionRow => ({
    frontier: [{ peer: '1', counter: 0 }],
    peer,
    atMs,
  });

  it('splits on gaps over the threshold, not under it', () => {
    const groups = groupVersionRows(
      [row(0), row(30_000), row(59_000), row(121_000), row(130_000)],
      60_000,
    );
    expect(groups.map((g) => g.rows.length)).toEqual([3, 2]);
    expect(groups[0]!.startMs).toBe(0);
    expect(groups[0]!.endMs).toBe(59_000);
    expect(groups[1]!.startMs).toBe(121_000);
  });

  it('a gap of exactly the threshold stays in one group', () => {
    const groups = groupVersionRows([row(0), row(60_000)], 60_000);
    expect(groups).toHaveLength(1);
  });

  it('untimed rows extend the current group and lead without one', () => {
    const groups = groupVersionRows([row(null), row(null), row(5_000), row(200_000)], 60_000);
    expect(groups.map((g) => g.rows.length)).toEqual([3, 1]);
    expect(groups[0]!.startMs).toBe(5_000); // first KNOWN time
  });

  it('collects distinct peers per group', () => {
    const groups = groupVersionRows([row(0, 'p1'), row(1_000, 'p2'), row(2_000, 'p1')], 60_000);
    expect(groups[0]!.peers.sort()).toEqual(['p1', 'p2']);
  });

  it('single change → single group', () => {
    const groups = groupVersionRows([row(42)], 60_000);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.startMs).toBe(42);
  });
});

describe('the writer', () => {
  /** Minimal real-CRDT session stand-in: enough surface for the writer. */
  async function fakeSession(): Promise<{ session: CollabSession; peer: LoroPeer; edit: () => void }> {
    const peers = await createLoroPeers(seed(), 1);
    const peer = peers[0]!;
    const session = {
      roomId: 'room-test-1',
      loroDoc: peer.ldoc,
      encodedVersion: () => {
        peer.ldoc.commit();
        return peer.ldoc.version().encode();
      },
      exportSnapshot: () => {
        peer.ldoc.commit();
        return peer.ldoc.export({ mode: 'snapshot' });
      },
    } as unknown as CollabSession;
    const edit = (): void => {
      const r = findText(peer.view.state.doc, 'ANCHOR0');
      peer.view.dispatch(peer.view.state.tr.insert(r.to, schema.text('x')));
    };
    return { session, peer, edit };
  }

  function captureHost(prior: HistoryEnvelope | null = null): {
    host: HistoryHostLike;
    writes: HistoryEnvelopeWrite[];
  } {
    const writes: HistoryEnvelopeWrite[] = [];
    return {
      writes,
      host: {
        writeHistory: (envelope) => {
          writes.push({ ...envelope, changeTimes: [...envelope.changeTimes] });
          return Promise.resolve();
        },
        readHistory: () => Promise.resolve(prior),
      },
    };
  }

  it('writes on first flush, skips idle rewrites, writes again on change', async () => {
    const { session, peer, edit } = await fakeSession();
    const { host, writes } = captureHost();
    const handle = attachSessionHistory(session, () => 'My Doc', host);
    await handle.flush();
    expect(writes.length).toBe(1);
    expect(writes[0]!.docTitle).toBe('My Doc');
    expect(writes[0]!.roomId).toBe('room-test-1');
    expect(writes[0]!.changeTimes.length).toBeGreaterThan(0);

    await handle.flush(); // no doc change → no write
    expect(writes.length).toBe(1);

    edit();
    await settle();
    await handle.flush();
    expect(writes.length).toBe(2);
    // The new ops got a NEW observation entry.
    expect(writes[1]!.changeTimes.length).toBeGreaterThan(writes[0]!.changeTimes.length);
    handle.dispose();
    peer.destroy();
  });

  it('visibilitychange: writes when the tab HIDES, never when it comes back', async () => {
    // Field cost: the handler fired on both transitions, and a write is a
    // synchronous full snapshot export (0.3-0.8s on a 20 MB master) — so
    // alt-tabbing BACK to a big co-edited doc froze the renderer.
    const { session, peer, edit } = await fakeSession();
    const { host, writes } = captureHost();
    const handle = attachSessionHistory(session, () => 'Vis Doc', host);
    await handle.flush();
    expect(writes.length).toBe(1);
    edit();
    await settle();
    const setVisibility = (state: 'visible' | 'hidden'): void => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    setVisibility('visible');
    await new Promise((r) => setTimeout(r, 20));
    expect(writes.length, 'tab-in must not export a snapshot').toBe(1);
    setVisibility('hidden');
    await new Promise((r) => setTimeout(r, 20));
    expect(writes.length, 'tab-out flushes').toBe(2);
    handle.dispose();
    peer.destroy();
  });

  it('dispose writes one final time and NEVER deletes; handle unregisters', async () => {
    const { session, peer, edit } = await fakeSession();
    const { host, writes } = captureHost();
    const handle = attachSessionHistory(session, () => 'T', host);
    await handle.flush();
    expect(historyHandleFor('room-test-1')).toBe(handle);
    edit();
    await settle();
    const before = writes.length;
    handle.dispose();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(writes.length, 'dispose flushed the final state').toBeGreaterThan(before);
    expect(historyHandleFor('room-test-1')).toBeNull();
    // The HistoryHostLike surface has no delete at all — retention is
    // structural, not a code path this module could take by mistake.
    peer.destroy();
  });

  it('merges a prior file: startedAt and old observation times survive', async () => {
    const { session, peer } = await fakeSession();
    const prior: HistoryEnvelope = {
      v: 1,
      roomId: 'room-test-1',
      docTitle: 'Old title',
      startedAt: 1000,
      updatedAt: 2000,
      changeTimes: [{ peer: '42', counter: 7, at: 1500 }],
      snapshotB64: 'ignored',
    };
    const { host, writes } = captureHost(prior);
    const handle = attachSessionHistory(session, () => 'New title', host);
    await handle.flush();
    expect(writes[0]!.startedAt).toBe(1000);
    expect(writes[0]!.changeTimes.some((t) => t.peer === '42' && t.at === 1500)).toBe(true);
    expect(writes[0]!.docTitle).toBe('New title');
    handle.dispose();
    peer.destroy();
  });

  it('round-trips through its own envelope: derived rows carry the write times', async () => {
    const { session, peer, edit } = await fakeSession();
    const { host, writes } = captureHost();
    const handle = attachSessionHistory(session, () => 'T', host);
    await handle.flush();
    edit();
    await settle();
    await handle.flush();
    const envelope = writes[writes.length - 1]!;
    expect(envelope.snapshot.byteLength, 'snapshot rides as raw bytes').toBeGreaterThan(0);
    const scratch = new LoroDoc();
    scratch.import(peer.ldoc.export({ mode: 'snapshot' }));
    const rows = deriveVersionRows(scratch, envelope.changeTimes);
    expect(rows.length).toBeGreaterThan(0);
    // The final change was observed by the second flush → it has a time.
    expect(rows[rows.length - 1]!.atMs).not.toBeNull();
    handle.dispose();
    peer.destroy();
  });
});
