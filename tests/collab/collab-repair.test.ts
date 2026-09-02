// @vitest-environment jsdom
/**
 * §4.4 production wiring: the repair pass runs AUTOMATICALLY inside a
 * session — leader-gated, normalizer-tagged, after remote batches —
 * with no manual repairView() call. T1 proved the repair itself; this
 * proves the session plumbing: the ragged row-vs-column merge squares
 * on its own, only the leader emits the fix, and the follower's copy
 * converges through sync.
 */

import { describe, it, expect } from 'vitest';
import { addRowAfter, addColumnAfter } from 'prosemirror-tables';
import { TextSelection } from 'prosemirror-state';
import { collabRepairPlugin, lowestPeerIsLeader, repairStats } from '../../src/editor/collab/collab-repair.js';
import { buildDocRepairTr } from '../../src/doc-repair.js';
import { schema } from '../../src/schema/index.js';
import { EditorState } from 'prosemirror-state';
import {
  createLoroPeers,
  syncAll,
  settle,
  docOf,
  tableNode,
  tableShapes,
  docText,
  findText,
  type LoroPeer,
  para,
} from './_loro-helpers.js';

function selectIn(peer: LoroPeer, text: string): void {
  const r = findText(peer.doc(), text);
  peer.view.dispatch(peer.view.state.tr.setSelection(TextSelection.create(peer.view.state.doc, r.from)));
}

describe('session-wired repair pass (leader-gated)', () => {
  it('T4: the ragged row-vs-column merge squares automatically, leader-only', async () => {
    // Leadership fixed deterministically for the test: peer A repairs,
    // peer B suppresses (in production the gate compares peer ids from
    // presence; lowestPeerIsLeader is unit-tested below).
    const peers = await createLoroPeers(docOf(tableNode(3, 3)), 2, () => []);
    const [a, b] = peers as [LoroPeer, LoroPeer];
    // Rebuild views with the repair plugin included (createLoroPeers'
    // extraPlugins can't distinguish peers, so reconfigure directly).
    a.view.updateState(
      a.view.state.reconfigure({
        plugins: [...a.view.state.plugins, collabRepairPlugin(() => true)],
      }),
    );
    b.view.updateState(
      b.view.state.reconfigure({
        plugins: [...b.view.state.plugins, collabRepairPlugin(() => false)],
      }),
    );

    selectIn(a, 'c11');
    addRowAfter(a.view.state, a.view.dispatch);
    selectIn(b, 'c11');
    addColumnAfter(b.view.state, b.view.dispatch);
    await settle();
    await syncAll([a, b]);
    // The merge lands as a binding transaction → A's plugin repairs it
    // in the same dispatch cycle; the fix syncs to B.
    await syncAll([a, b]);

    expect(b.doc().eq(a.doc())).toBe(true);
    expect(() => a.doc().check()).not.toThrow();
    const rows = tableShapes(a.doc())[0]!;
    expect(new Set(rows).size).toBe(1); // rectangular, automatically
    for (const cellText of ['c00', 'c11', 'c22']) {
      expect(docText(a.doc())).toContain(cellText);
    }
    // Idempotent: nothing left to repair anywhere.
    expect(buildDocRepairTr(EditorState.create({ doc: a.doc() }))).toBeNull();
    expect(buildDocRepairTr(EditorState.create({ doc: b.doc() }))).toBeNull();
    a.destroy();
    b.destroy();
  });

  it('bounded fixTables: oldState scopes the scan; no-oldState remains the backstop', () => {
    // Perf fix 2026-08-06: the session pass gives buildDocRepairTr its
    // oldState, putting prosemirror-tables on the changed-regions fast
    // path. Semantics pinned here: a PRE-EXISTING break untouched by
    // the change is no longer opportunistically fixed by the bounded
    // pass (liveness change, accepted) — while the import/open callers,
    // which pass no oldState, still full-scan and remain the backstop.
    // (A table broken BY a merge sits inside that merge's changed
    // region and is covered end-to-end by T4 above.)
    const brokenTable = (() => {
      const cell = (t: string) =>
        schema.nodes['table_cell']!.createChecked(null, [
          schema.nodes['paragraph']!.createChecked(null, schema.text(t)),
        ]);
      return schema.nodes['table']!.create(null, [
        schema.nodes['table_row']!.create(null, [cell('r0a'), cell('r0b')]),
        schema.nodes['table_row']!.create(null, [cell('r1a')]), // ragged
      ]);
    })();
    const para = (t: string) =>
      schema.nodes['paragraph']!.createChecked(null, schema.text(t));
    const oldState = EditorState.create({ doc: docOf(brokenTable, para('tail')) });
    // The only change between states: text typed in the paragraph —
    // far from the (already broken) table.
    const newState = oldState.apply(
      oldState.tr.insertText(' more', oldState.doc.content.size - 1),
    );

    // Bounded: the untouched broken table is left alone this pass.
    const bounded = buildDocRepairTr(newState, oldState);
    const boundedFixesTable =
      bounded !== null && tableShapes(bounded.doc)[0]!.every((w, _i, a) => w === a[0]);
    expect(boundedFixesTable).toBe(false);

    // Backstop: the import/open path (no oldState) still squares it.
    const full = buildDocRepairTr(newState);
    expect(full).not.toBeNull();
    expect(new Set(tableShapes(full!.doc)[0]!).size).toBe(1);
  });

  it('bounded sweeps: a violation inside the changed range is repaired; one outside is left to the backstop', () => {
    // Mirrors the fixTables contract above for the mark/head/sentinel
    // sweeps (2026-09-01 review, SC4): the session pass supplies the
    // merge's changed ranges; import/open pass none and full-scan.
    const para = (t: string) => schema.nodes['paragraph']!.createChecked(null, schema.text(t));
    const headless = schema.nodes['card']!.create(null, [
      schema.nodes['card_body']!.createChecked(null, schema.text('no tag here')),
    ]);
    const clash = schema.nodes['paragraph']!.create(null, [
      schema.text('clash', [schema.marks['underline_mark']!.create(), schema.marks['emphasis_mark']!.create()]),
    ]);
    // Doc: [headless card] [para] [clash para] — the change happens in the clash para only.
    const doc = docOf(headless, para('middle'), clash);
    const state = EditorState.create({ doc });
    const clashFrom = doc.content.size - clash.nodeSize;
    const inRange = [{ from: clashFrom, to: doc.content.size }];

    const bounded = buildDocRepairTr(state, undefined, inRange);
    expect(bounded, 'the in-range mark clash is repaired').not.toBeNull();
    const bDoc = bounded!.doc;
    expect(bDoc.firstChild!.firstChild!.type.name, 'the out-of-range headless card is NOT touched').toBe('card_body');
    const clashText = bDoc.lastChild!.firstChild!;
    expect(clashText.marks.map((m) => m.type.name)).toEqual(['emphasis_mark']);

    const full = buildDocRepairTr(state);
    expect(full!.doc.firstChild!.firstChild!.type.name, 'backstop inserts the head').toBe('tag');
  });

  it('the session pass never walks the whole document (heal-sentinel scan included)', async () => {
    // The sentinel scan's "cooldown gate" only ever closed AFTER a heal
    // was found — in the common no-heal case every remote frame walked
    // the entire document (2026-09-01 review, PH-A1).
    const peers = await createLoroPeers(docOf(para('alpha'), para('beta')), 2, () => [
      collabRepairPlugin(() => true),
    ]);
    const [a, b] = peers as [LoroPeer, LoroPeer];
    const before = { ...repairStats };
    for (let i = 0; i < 3; i++) {
      const r = findText(a.view.state.doc, 'alpha');
      a.view.dispatch(a.view.state.tr.insertText(`${i}`, r.to));
      await settle();
      b.import(a.exportAll());
      await settle();
    }
    expect(repairStats.boundedPasses - before.boundedPasses).toBeGreaterThanOrEqual(3);
    expect(repairStats.fullDocScans - before.fullDocScans, 'session passes are bounded').toBe(0);
    for (const p of peers) p.destroy();
  });

  it('leader election: lowest peer id wins, numerically', () => {
    expect(lowestPeerIsLeader('5', ['10', '7'])).toBe(true);
    expect(lowestPeerIsLeader('10', ['5'])).toBe(false);
    // decimal u64 strings must compare numerically, not lexically
    // (lexically '9' > '10' — numerically 9 < 10, so '9' leads)
    expect(lowestPeerIsLeader('9', ['10'])).toBe(true);
    expect(lowestPeerIsLeader('10', ['9'])).toBe(false);
    // alone in the room → leader
    expect(lowestPeerIsLeader('12345678901234567890', [])).toBe(true);
  });
});
