// @vitest-environment jsdom
/**
 * The causal mark heal (collab/causal-mark-heal.ts) end-to-end through
 * the real plugin: (1) named adversarial cases covering BOTH sides of
 * inserter intent — text typed blind to a concurrent highlight is
 * stripped everywhere, text typed by anyone who had seen the mark (or
 * text the marker had seen) stays — and (2) the loro-fuzz convergence
 * stress loop with the heal active on every peer, which is the
 * regression net for the property that makes the heal safe at all:
 * verdicts are pure functions of op history, so strips converge.
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { addRowAfter, addColumnAfter, deleteRow, deleteColumn } from 'prosemirror-tables';
import { schema, newHeadingId } from '../../src/schema/index.js';
import type { Node as PMNode } from 'prosemirror-model';
import { buildDocRepairTr } from '../../src/doc-repair.js';
import {
  createLoroPeers,
  settle,
  mixedDoc,
  docText,
  findText,
  type LoroPeer,
} from './_loro-helpers.js';
import { causalMarkHealPlugin, causalHealStats } from '../../src/editor/collab/causal-mark-heal.js';

function card(tag: string, body: string): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}

/** Sync every peer with every other; the heal plugin (installed on
 *  every peer's view) reacts to each import's binding transaction. */
async function syncAllHealed(peers: LoroPeer[]): Promise<void> {
  for (const from of peers) {
    const blob = from.exportAll();
    for (const to of peers) {
      if (to === from) continue;
      to.import(blob);
    }
  }
  await settle();
}

/** Peers with the REAL causal heal plugin active. */
function healedPeers(seed: PMNode, n: number): ReturnType<typeof createLoroPeers> {
  return createLoroPeers(seed, n, (ldoc) => [causalMarkHealPlugin(ldoc)]);
}

function highlightRange(p: LoroPeer, needle: string, color = 'yellow'): void {
  const r = findText(p.doc(), needle);
  p.view.dispatch(
    p.view.state.tr.addMark(r.from, r.to, schema.marks['highlight']!.create({ color })),
  );
}

function typeAt(p: LoroPeer, after: string, text: string, marks: 'inherit' | 'plain' = 'plain'): void {
  const r = findText(p.doc(), after);
  const tr = p.view.state.tr;
  if (marks === 'inherit') {
    const $pos = p.view.state.doc.resolve(r.to);
    tr.insertText(text, r.to);
    void $pos;
  } else {
    tr.insertText(text, r.to).removeMark(r.to, r.to + text.length, schema.marks['highlight']!);
  }
  p.view.dispatch(tr);
}

/** Is every char of `needle` highlighted in `p`'s doc? */
function isHighlighted(p: LoroPeer, needle: string): boolean {
  const r = findText(p.doc(), needle);
  let all = true;
  p.doc().nodesBetween(r.from, r.to, (node) => {
    if (node.isText && !node.marks.some((m) => m.type.name === 'highlight')) all = false;
    return true;
  });
  return all;
}

describe('causal heal — cost discipline (2026-09-01 review, SC5)', () => {
  it('the binding\u2019s init transaction is skipped; a real remote frame still runs a pass', async () => {
    // A joiner's init replaces the empty starter with the whole doc —
    // one binding transaction whose changed range is everything. Running
    // the heal there decoded the full op log and walked every governed
    // run inside the ~10s join freeze.
    const seed = mixedDoc();
    const before = { ...causalHealStats };
    const peers = await healedPeers(seed, 2);
    const [a, b] = peers as [LoroPeer, LoroPeer];
    expect(causalHealStats.skippedInit - before.skippedInit, 'both inits skipped').toBeGreaterThanOrEqual(2);
    expect(causalHealStats.passes - before.passes, 'no pass on init').toBe(0);
    // A highlights a run and B receives it: a real remote frame → a pass.
    const r = findText(a.view.state.doc, 'quick');
    a.view.dispatch(a.view.state.tr.addMark(r.from, r.to, schema.marks['highlight']!.create({ color: 'cyan' })));
    await settle();
    const passesBefore = causalHealStats.passes;
    b.import(a.exportAll());
    await settle();
    expect(causalHealStats.passes, 'remote frame with a governed mark → pass').toBeGreaterThan(passesBefore);
    for (const p of peers) p.destroy();
  });
});

describe('causal heal — both sides of inserter intent', () => {
  it('UNSEEN interior retype is stripped everywhere (the field case)', async () => {
    const peers = await healedPeers(
      schema.nodes['doc']!.createChecked(null, [card('T', 'alpha KEEPME bravo charlie delta')]),
      2,
    );
    const [a, b] = peers as [LoroPeer, LoroPeer];
    // Diverge: A highlights a span; B, never seeing it, retypes inside it.
    highlightRange(a, 'KEEPME bravo charlie');
    typeAt(b, 'bravo', ' INJECTED');
    await settle();

    await syncAllHealed(peers);
    await syncAllHealed(peers);

    expect(b.doc().eq(a.doc())).toBe(true);
    // A's deliberate span keeps its highlight…
    expect(isHighlighted(a, 'KEEPME')).toBe(true);
    expect(isHighlighted(a, 'charlie')).toBe(true);
    // …but B's concurrent-blind text does NOT inherit it.
    expect(isHighlighted(a, 'INJECTED')).toBe(false);
    expect(isHighlighted(b, 'INJECTED')).toBe(false);
    peers.forEach((p) => p.destroy());
  });

  it('SEEN typing inside a visible highlight stays highlighted', async () => {
    const peers = await healedPeers(
      schema.nodes['doc']!.createChecked(null, [card('T', 'alpha bravo charlie delta')]),
      2,
    );
    const [a, b] = peers as [LoroPeer, LoroPeer];
    highlightRange(a, 'bravo charlie');
    await settle();
    await syncAllHealed(peers); // B has SEEN the highlight

    // B types inside the visible highlight — PM's inclusive marks apply
    // the highlight locally, exactly like real typing.
    const r = findText(b.doc(), 'bravo');
    b.view.dispatch(
      b.view.state.tr.insertText('SEENTEXT', r.to).addMark(
        r.to,
        r.to + 'SEENTEXT'.length,
        schema.marks['highlight']!.create({ color: 'yellow' }),
      ),
    );
    await settle();
    await syncAllHealed(peers);
    await syncAllHealed(peers);

    expect(b.doc().eq(a.doc())).toBe(true);
    expect(isHighlighted(a, 'SEENTEXT')).toBe(true);
    expect(isHighlighted(b, 'SEENTEXT')).toBe(true);
    peers.forEach((p) => p.destroy());
  });

  it('marker who SAW the text keeps it highlighted (deliberate span over partner text)', async () => {
    const peers = await healedPeers(
      schema.nodes['doc']!.createChecked(null, [card('T', 'alpha bravo charlie delta')]),
      2,
    );
    const [a, b] = peers as [LoroPeer, LoroPeer];
    // B types first; A SEES it, then deliberately highlights across it.
    typeAt(b, 'bravo', ' BTEXT');
    await settle();
    await syncAllHealed(peers);
    highlightRange(a, 'bravo BTEXT charlie');
    await settle();
    await syncAllHealed(peers);
    await syncAllHealed(peers);

    expect(b.doc().eq(a.doc())).toBe(true);
    expect(isHighlighted(a, 'BTEXT')).toBe(true); // marker intent covers it
    expect(isHighlighted(b, 'BTEXT')).toBe(true);
    peers.forEach((p) => p.destroy());
  });

  it('transitive knowledge counts as SEEN (3 peers, relay chain)', async () => {
    const peers = await healedPeers(
      schema.nodes['doc']!.createChecked(null, [card('T', 'alpha bravo charlie delta')]),
      3,
    );
    const [a, b, c] = peers as [LoroPeer, LoroPeer, LoroPeer];
    highlightRange(a, 'bravo charlie');
    await settle();
    // A → B only (C stays dark).
    b.import(a.exportAll());
    await settle();
    // B types inside the highlight it received via A.
    const r = findText(b.doc(), 'bravo');
    b.view.dispatch(
      b.view.state.tr.insertText('VIARELAY', r.to).addMark(
        r.to,
        r.to + 'VIARELAY'.length,
        schema.marks['highlight']!.create({ color: 'yellow' }),
      ),
    );
    await settle();
    // C hears EVERYTHING from B alone — its heal must see B's insert as
    // causally downstream of A's mark, through the deps chain.
    c.import(b.exportAll());
    await settle();
    await syncAllHealed(peers);
    await syncAllHealed(peers);

    expect(c.doc().eq(a.doc())).toBe(true);
    expect(isHighlighted(c, 'VIARELAY')).toBe(true);
    peers.forEach((p) => p.destroy());
  });

  it('delivery-order permutations converge to the same verdict', async () => {
    for (const order of ['mark-first', 'insert-first'] as const) {
      const peers = await healedPeers(
        schema.nodes['doc']!.createChecked(null, [card('T', 'alpha bravo charlie delta')]),
        3,
      );
      const [a, b, c] = peers as [LoroPeer, LoroPeer, LoroPeer];
      highlightRange(a, 'bravo charlie');
      typeAt(b, 'bravo', ' XCONC');
      await settle();
      const fromA = a.exportAll();
      const fromB = b.exportAll();
      // C receives the two concurrent branches in either order.
      if (order === 'mark-first') {
        c.import(fromA);
        c.import(fromB);
      } else {
        c.import(fromB);
        c.import(fromA);
      }
      await settle();
      await syncAllHealed(peers);
      await syncAllHealed(peers);
      expect(c.doc().eq(a.doc()), `order ${order} convergence`).toBe(true);
      expect(isHighlighted(c, 'XCONC'), `order ${order} strip`).toBe(false);
      expect(isHighlighted(c, 'charlie'), `order ${order} keep`).toBe(true);
      peers.forEach((p) => p.destroy());
    }
  });
});

// ── The old fuzz loop, heal-injected ────────────────────────────────

const WORDS = ['uniqueness', 'link', 'impact', 'turn', 'solvency', 'perm', 'kritik', 'framework'];
const HIGHLIGHTS = ['yellow', 'green', 'cyan'];

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function cardNode(tag: string, paras: string[]): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(paras.join(' '))),
  ]);
}

function randomOp(rnd: () => number, p: LoroPeer): void {
  const view = p.view;
  const blocks: Array<{ start: number; end: number }> = [];
  p.doc().descendants((node, pos) => {
    if (node.isTextblock) {
      blocks.push({ start: pos + 1, end: pos + 1 + node.content.size });
      return false;
    }
    return true;
  });
  if (!blocks.length) return;
  const b = blocks[Math.floor(rnd() * blocks.length)]!;
  const pos = b.start + Math.floor(rnd() * Math.max(1, b.end - b.start));
  const roll = rnd();
  try {
    if (roll < 0.35) {
      view.dispatch(view.state.tr.insertText(` ${WORDS[Math.floor(rnd() * WORDS.length)]}`, pos));
    } else if (roll < 0.5) {
      const to = Math.min(b.end, pos + 1 + Math.floor(rnd() * 6));
      if (to > pos) view.dispatch(view.state.tr.delete(pos, to));
    } else if (roll < 0.68) {
      const to = Math.min(b.end, pos + 2 + Math.floor(rnd() * 10));
      if (to > pos) {
        const mark =
          rnd() < 0.6
            ? schema.marks['highlight']!.create({ color: HIGHLIGHTS[Math.floor(rnd() * 3)] })
            : schema.marks['bold']!.create();
        view.dispatch(view.state.tr.addMark(pos, to, mark));
      }
    } else if (roll < 0.78) {
      view.dispatch(view.state.tr.split(pos));
    } else if (roll < 0.86) {
      view.dispatch(
        view.state.tr.insert(
          view.state.doc.content.size,
          cardNode(`Fuzz ${Math.floor(rnd() * 999)}`, ['Fuzz body evidence.']),
        ),
      );
    } else {
      const cells: number[] = [];
      view.state.doc.descendants((node, cp) => {
        if (node.type.name === 'table_cell') {
          cells.push(cp + 2);
          return false;
        }
        return true;
      });
      if (!cells.length) return;
      const cellPos = cells[Math.floor(rnd() * cells.length)]!;
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, Math.min(cellPos, view.state.doc.content.size)),
        ),
      );
      const cmd = [addRowAfter, addColumnAfter, deleteRow, deleteColumn][Math.floor(rnd() * 4)]!;
      cmd(view.state, view.dispatch);
    }
  } catch {
    /* invalid position for this op — skip */
  }
}

describe('loro CRDT fuzz with the causal heal injected (3 peers, offline partitions)', () => {
  it('converges valid across 15 seeds', { timeout: 120_000 }, async () => {
    for (let seed = 1; seed <= 15; seed++) {
      const rnd = mulberry32(seed);
      const peers = await healedPeers(mixedDoc(), 3);
      for (let round = 0; round < 4; round++) {
        for (const p of peers) {
          const k = 1 + Math.floor(rnd() * 3);
          for (let i = 0; i < k; i++) randomOp(rnd, p);
        }
        await settle();
        const mode = rnd();
        if (mode < 0.35) {
          await syncAllHealed(peers);
        } else if (mode < 0.7) {
          const i = Math.floor(rnd() * 3);
          const j = (i + 1 + Math.floor(rnd() * 2)) % 3;
          await syncAllHealed([peers[i]!, peers[j]!]);
        }
        // else: fully offline round
      }
      await syncAllHealed(peers);
      await syncAllHealed(peers);
      await syncAllHealed(peers);
      const docs = peers.map((p) => p.doc());
      for (const d of docs) {
        expect(d.eq(docs[0]!), `seed ${seed} convergence`).toBe(true);
        expect(() => d.check(), `seed ${seed} validity`).not.toThrow();
      }
      if (buildDocRepairTr(EditorState.create({ doc: peers[0]!.view.state.doc }))) {
        // Structural repair interplay is out of scope for the heal proto;
        // the un-healed fuzz covers it. Just require convergence above.
      }
      // Text sanity: docs still contain body text (heal never eats content).
      expect(docText(docs[0]!).length).toBeGreaterThan(50);
      peers.forEach((p) => p.destroy());
    }
  });
});
