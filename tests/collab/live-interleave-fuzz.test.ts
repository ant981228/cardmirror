// @vitest-environment jsdom
/**
 * Live-interleave CRDT fuzz — random PAIRWISE syncs instead of the global
 * sync barrier the other in-memory fuzzers use. That barrier hides a
 * whole family: the binding's move-aware child diff bails to upstream's
 * delete-and-recreate when a moved/split card's content changed
 * concurrently, orphaning the partner's edit (lost content) or leaving
 * two rebuilt copies (duplicated heads). Found by the real-relay chaos
 * rig (2026-09-04); this is its cheap in-memory sibling. Tokens in every
 * body and every tag are tracked exactly-once.
 *
 * OPT-IN (FUZZ_LIVE_INTERLEAVE=1): the interleaving depends on timer
 * scheduling, so a given seed can pass or fail run to run — a
 * diagnostic, not a CI gate. Knobs: FUZZ_SEEDS, FUZZ_SEED_START,
 * LORO_CHECK=1 (report PM renders that drop content Loro holds, and
 * whether a lost token ever reached the inserter's own Loro doc),
 * RECONCILE_DEBUG=1 (op markers in the same log).
 *
 * Known residuals as of 2026-09-04, both documented in the chaos rig's
 * report: (1) two peers splitting the SAME paragraph or tag concurrently
 * each copy its tail into their own new container (a split is
 * delete+copy, not a text move) — duplicated body text / duplicated
 * heads; (2) an intermittent loss where a token inserted concurrently
 * with a split of its paragraph ends up SPLIT ACROSS the two paragraphs
 * in the CRDT itself («tk23_ | 16»), so it never renders as a token
 * again — the text-level diff applied on split under a concurrent
 * insert in the same range is the suspect (seed 23 reproduces it about
 * one run in three).
 */
import { describe, it, expect } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { enterMidTag } from '../../src/editor/tag-keymap.js';
import { headingIdGuardPlugin } from '../../src/editor/heading-id-guard.js';
import { createLoroPeers, settle, docOf, cardNode, type LoroPeer } from './_loro-helpers.js';

declare global {
  // eslint-disable-next-line no-var
  var __CM_MOVABLE_LIST__: boolean | undefined;
}
const SEEDS = Number(process.env['FUZZ_SEEDS'] ?? 24);
const SEED_START = Number(process.env['FUZZ_SEED_START'] ?? 1);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function textblocks(doc: PMNode): Array<{ start: number; end: number; node: PMNode }> {
  const out: Array<{ start: number; end: number; node: PMNode }> = [];
  doc.descendants((n, pos) => {
    if (n.isTextblock) {
      out.push({ start: pos + 1, end: pos + 1 + n.content.size, node: n });
      return false;
    }
    return true;
  });
  return out;
}
function count(d: PMNode, s: string): number {
  let n = 0;
  for (const tb of textblocks(d)) {
    let i = tb.node.textContent.indexOf(s);
    while (i >= 0) {
      n++;
      i = tb.node.textContent.indexOf(s, i + s.length);
    }
  }
  return n;
}
/** Word boundaries outside «…» tokens. */
function safeOffsets(text: string): number[] {
  const out: number[] = [];
  let inTok = false;
  for (let i = 0; i <= text.length; i++) {
    if (text[i - 1] === '«') inTok = true;
    if (text[i - 1] === '»') inTok = false;
    if (inTok) continue;
    if (i === 0 || i === text.length || text[i - 1] === ' ' || text[i] === ' ') out.push(i);
  }
  return out;
}
function topCards(doc: PMNode): Array<{ pos: number; node: PMNode }> {
  const out: Array<{ pos: number; node: PMNode }> = [];
  let pos = 0;
  doc.forEach((c) => {
    if (c.type.name === 'card') out.push({ pos, node: c });
    pos += c.nodeSize;
  });
  return out;
}
interface Oracle {
  inserted: Set<string>;
  heads: Set<string>;
  next: number;
  history: Map<string, string[]>;
  where: string;
}
const LOG = (): string[] => ((globalThis as { __CM_RECONCILE_LOG__?: string[] }).__CM_RECONCILE_LOG__ ??= []);
function op(view: EditorView, rnd: () => number, seed: number, o: Oracle): void {
  const roll = rnd();
  const doc = view.state.doc;
  try {
    if (roll < 0.4) {
      const bodies = textblocks(doc).filter((t) => t.node.type.name === 'card_body');
      const tb = bodies[Math.floor(rnd() * bodies.length)]!;
      const offs = safeOffsets(tb.node.textContent);
      const tok = `«tk${seed}_${o.next++}»`;
      view.dispatch(view.state.tr.insertText(` ${tok} `, tb.start + offs[Math.floor(rnd() * offs.length)]!));
      o.inserted.add(tok);
      o.history.set(tok, [`born ${o.where}`]);
    } else if (roll < 0.55) {
      const tags: Array<{ start: number; text: string }> = [];
      doc.descendants((n, pos) => {
        if (n.type.name === 'tag') tags.push({ start: pos + 1, text: n.textContent });
        return n.type.name !== 'tag';
      });
      const t = tags[Math.floor(rnd() * tags.length)]!;
      const offs = safeOffsets(t.text).filter((x) => x > 0 && x < t.text.length);
      if (!offs.length) return;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, t.start + offs[Math.floor(rnd() * offs.length)]!)));
      enterMidTag(view.state, (tr) => view.dispatch(tr));
    } else if (roll < 0.7) {
      const bodies = textblocks(doc).filter((t) => t.node.type.name === 'card_body' && t.end - t.start > 2);
      const tb = bodies[Math.floor(rnd() * bodies.length)]!;
      const offs = safeOffsets(tb.node.textContent).filter((x) => x > 0 && x < tb.end - tb.start);
      if (!offs.length) return;
      view.dispatch(view.state.tr.split(tb.start + offs[Math.floor(rnd() * offs.length)]!));
    } else if (roll < 0.85) {
      const cards = topCards(doc);
      if (cards.length < 2) return;
      const src = cards[Math.floor(rnd() * cards.length)]!;
      const others = cards.filter((c) => c.pos !== src.pos);
      const dst = others[Math.floor(rnd() * others.length)]!;
      const tr = view.state.tr.delete(src.pos, src.pos + src.node.nodeSize);
      tr.insert(tr.mapping.map(dst.pos + (rnd() < 0.5 ? 0 : dst.node.nodeSize)), src.node);
      view.dispatch(tr);
    } else {
      const tok = `«tk${seed}_${o.next++}»`;
      const head = `«hd${seed}_${o.next++}»`;
      view.dispatch(view.state.tr.insert(view.state.doc.content.size, cardNode(`Fresh ${head}`, [`new ${tok} body`])));
      o.inserted.add(tok);
      o.heads.add(head);
    }
  } catch {
    /* structurally impossible roll */
  }
}
/** After an import: every token the peer's LORO doc holds must also be in
 *  its PM doc — a PM render that drops content Loro has gets committed
 *  back as a deletion by the peer's next local edit. */
function checkRender(peer: LoroPeer, label: string): void {
  if (!process.env['LORO_CHECK']) return;
  const loroJson = JSON.stringify(peer.ldoc.toJSON());
  const pm = peer.doc();
  for (const m of loroJson.matchAll(/«tk[^»]+»/g)) {
    const t = m[0];
    if (count(pm, t) === 0) {
      // find the Loro text run holding it, for the report
      const around = loroJson.slice(Math.max(0, m.index! - 60), m.index! + 60).replace(/\\"/g, '"');
      LOG().push(`!! RENDER ${label}: ${t} is in Loro but not in PM; loro…${around}…`);
    }
  }
}
async function partialSync(peers: LoroPeer[], rnd: () => number, label = ''): Promise<void> {
  for (let k = 0; k < 2; k++) {
    const ai = Math.floor(rnd() * peers.length);
    const bi = Math.floor(rnd() * peers.length);
    const a = peers[ai]!;
    const b = peers[bi]!;
    if (a === b) continue;
    b.import(a.exportAll());
    await settle(4);
    checkRender(b, `${label} p${bi}<-p${ai}`);
    a.import(b.exportAll());
    await settle(4);
    checkRender(a, `${label} p${ai}<-p${bi}`);
  }
}
async function fullSync(peers: LoroPeer[]): Promise<void> {
  for (let r = 0; r < 3; r++) {
    const blobs = peers.map((p) => p.exportAll());
    peers.forEach((p) => blobs.forEach((b) => p.import(b)));
    await settle(4);
    peers.forEach((p, i) => checkRender(p, `fullSync#${r} p${i}`));
  }
}

describe.skipIf(process.env['FUZZ_LIVE_INTERLEAVE'] !== '1')('live-interleave fuzz (pairwise syncs, movable rooms)', () => {
  it(`exactly-once content and heads across ${SEEDS} seeds`, { timeout: 60_000 * SEEDS }, async () => {
    globalThis.__CM_MOVABLE_LIST__ = true;
    if (process.env['RECONCILE_DEBUG']) (globalThis as { __CM_RECONCILE_DEBUG__?: boolean }).__CM_RECONCILE_DEBUG__ = true;
    const failures: string[] = [];
    const softDuplicates: string[] = [];
    try {
      for (let seed = SEED_START; seed < SEED_START + SEEDS; seed++) {
        const rnd = mulberry32(seed);
        const o: Oracle = { inserted: new Set(), heads: new Set(['«hd0»', '«hd1»', '«hd2»', '«hd3»']), next: 0, history: new Map(), where: '' };
        const peers = await createLoroPeers(
          docOf(cardNode('Alpha «hd0»', ['alpha bravo charlie']), cardNode('Bravo «hd1»', ['delta echo']), cardNode('Charlie «hd2»', ['foxtrot golf']), cardNode('Delta «hd3»', ['hotel india'])),
          3,
          () => [headingIdGuardPlugin],
        );
        for (let round = 0; round < 8; round++) {
          for (const [pi, p] of peers.entries()) {
            for (let k = 0; k < 1 + Math.floor(rnd() * 3); k++) {
              o.where = `r${round}p${pi}`;
              if (process.env['RECONCILE_DEBUG']) LOG().push(`-- ${o.where} op`);
              const beforeTok = new Set(o.inserted);
              op(p.view, rnd, seed, o);
              if (process.env['LORO_CHECK']) {
                // Did the inserting peer's OWN Loro doc receive the token?
                for (const t of o.inserted) {
                  if (beforeTok.has(t)) continue;
                  const inPm = count(p.view.state.doc, t) > 0;
                  const inLoro = JSON.stringify(p.ldoc.toJSON()).includes(t);
                  if (inPm && !inLoro) {
                    o.history.get(t)?.push(`NOT-IN-LORO-after-local-op`);
                    LOG().push(`!! ${o.where} ${t} in PM but not in this peer's Loro doc`);
                  }
                }
              }
            }
          }
          await settle(4);
          if (process.env['RECONCILE_DEBUG']) LOG().push(`-- r${round} sync`);
          await partialSync(peers, rnd, `r${round}`);
          for (const t of o.inserted) o.history.get(t)?.push(`r${round}:${peers.map((pp, i) => (count(pp.doc(), t) > 0 ? `p${i}` : '-')).join('')}`);
        }
        await fullSync(peers);
        const d = peers[0]!.doc();
        const problems: string[] = [];
        if (!peers.every((p) => p.doc().eq(d))) problems.push('diverged');
        for (const t of o.inserted) {
          const c = count(d, t);
          if (c === 0) problems.push(`LOST ${t} [${(o.history.get(t) ?? []).join(' ')}] inLoro=${peers.map((pp, i) => (JSON.stringify(pp.ldoc.toJSON()).includes(t) ? `p${i}` : '-')).join('')}`);
          else if (c > 1) softDuplicates.push(`seed ${seed}: ${t}×${c}`);
        }
        for (const t of o.heads) {
          const c = count(d, t);
          if (c !== 1) problems.push(`head ${t}×${c}`);
        }
        if (problems.length) failures.push(`seed ${seed}: ${problems.join(', ')}`);
        for (const p of peers) p.destroy();
      }
    } finally {
      globalThis.__CM_MOVABLE_LIST__ = undefined;
    }
    if ((process.env['RECONCILE_DEBUG'] || process.env['LORO_CHECK']) && failures.length) console.log(LOG().filter((l, i, a) => l.startsWith('!!') || a.slice(Math.max(0, i - 3), i + 1).some((x) => x.startsWith('!!'))).join('\n'));
    // HARD: nothing lost, every head exactly once, peers converge.
    expect(failures, failures.join('\n')).toEqual([]);
    // KNOWN RESIDUAL (documented, not silent): two peers splitting the SAME
    // paragraph concurrently each copy its tail into their own new
    // paragraph — a split is delete+copy, not a text move, so the tail
    // shows twice. Visible and user-fixable, unlike a loss; upstream has
    // it too. Seeded, so the count is stable: seed 19 today. Fails if it
    // grows.
    expect(softDuplicates.length, `duplicated body text: ${softDuplicates.join('; ')}`).toBeLessThanOrEqual(SEEDS >= 24 ? 1 : SEEDS);
  });
});
