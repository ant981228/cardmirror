// @vitest-environment jsdom
/**
 * Real-relay CHAOS fuzz — the pre-release confirmation rig for the
 * co-editing changes (2026-09-04).
 *
 * Unlike the in-memory fuzzers this drives FULL sessions (real schema,
 * the app's own plugin stack, encrypted transport, SSE stream +
 * catch-up) against the ACTUAL relay code, booted locally on SQLite by
 * this file, with a TCP chaos proxy in the network path:
 *
 *   - proxy CUT: every socket destroyed, new connections refused for a
 *     window (a dropped Wi-Fi / VPN flap);
 *   - proxy BLACKHOLE: connections accepted and held with no bytes
 *     (a captive portal / half-open link — exercises the stall
 *     watchdog and request deadlines);
 *   - peer stop/start and stream restarts (lid close / wake);
 *   - persist-and-resume: a peer is torn down and rebuilt from its
 *     persisted snapshot + meta, exactly like an app relaunch;
 *   - RELAY RESTART: the relay process is killed and rebooted on the
 *     same database mid-run (a redeploy);
 *   - a FRESH joiner at the end, with no cache, proves the relay's
 *     stored history reconstructs the same doc.
 *
 * Invariants per seed (the bug families we chase, not just convergence):
 *   1. every peer + the fresh joiner converge to one schema-valid doc;
 *   2. heading ids (tag/analytic/pocket/hat/block) are unique and
 *      non-null in that doc;
 *   3. CONTENT ORACLE: every token the fuzzer inserted and never
 *      deleted appears EXACTLY once (lost content and duplicated
 *      content both fail); tokens it deleted do not reappear.
 *
 * Run (skipped unless REAL_RELAY_CHAOS=1):
 *   REAL_RELAY_CHAOS=1 FUZZ_SEEDS=10 npx vitest run tests/collab/real-relay-chaos-fuzz.test.ts
 * Knobs: FUZZ_SEEDS, FUZZ_SEED_START, FUZZ_ROUNDS, FUZZ_PEERS,
 * RELAY_SERVICE_DIR (…/Scouting Assistant/relay-service), RELAY_PORT.
 * Findings only — the rig makes no product changes.
 */

import { describe, it, expect } from 'vitest';
import * as net from 'node:net';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Node as PMNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { RoomsClient } from '../../src/editor/collab/room-client.js';
import { CollabSession } from '../../src/editor/collab/collab-session.js';
import { decodeShareCode } from '../../src/editor/collab/collab-crypto.js';
import { collabInvariantHealPlugin } from '../../src/editor/collab/collab-invariants.js';
import { causalMarkHealPlugin } from '../../src/editor/collab/causal-mark-heal.js';
import { collabRepairPlugin, lowestPeerIsLeader } from '../../src/editor/collab/collab-repair.js';
import { headingIdGuardPlugin } from '../../src/editor/heading-id-guard.js';
import { cardNumberingPlugin } from '../../src/editor/numbering-plugin.js';
import { enterMidTag } from '../../src/editor/tag-keymap.js';
import { LoroUndoPlugin, undo as loroUndo, redo as loroRedo } from 'loro-prosemirror';
import { createUndoGuard, type UndoGuard } from '../../src/editor/collab/undo-guard.js';
import { UndoManager } from 'loro-crdt';
import { mkView, settle, sleep, cardNode, docOf, docText } from './_loro-helpers.js';

const ENABLED = process.env['REAL_RELAY_CHAOS'] === '1';
const SEEDS = Number(process.env['FUZZ_SEEDS'] ?? 6);
const SEED_START = Number(process.env['FUZZ_SEED_START'] ?? 1);
const ROUNDS = Number(process.env['FUZZ_ROUNDS'] ?? 8);
const PEERS = Number(process.env['FUZZ_PEERS'] ?? 3);
const RELAY_PORT = Number(process.env['RELAY_PORT'] ?? 8415);
const PROXY_PORT = RELAY_PORT + 1;
const RELAY_SERVICE_DIR =
  process.env['RELAY_SERVICE_DIR'] ??
  path.join(os.homedir(), 'Dropbox/Coding Projects/Scouting Assistant/relay-service');
const TOKEN = 'dev-pairing-token';
const NO_CHAOS = process.env['FUZZ_NO_CHAOS'] === '1';
const NO_MOVE = process.env['FUZZ_NO_MOVE'] === '1';
const NO_SPLIT = process.env['FUZZ_NO_SPLIT'] === '1';
/** Drop the invariant-heal / causal-mark-heal / repair plugins (the app's
 *  in-session menders) to see whether a loss needs them. */
const NO_HEAL = process.env['FUZZ_NO_HEAL'] === '1';
/** Undo/redo through the app's Loro undo manager (FUZZ_UNDO=1). */
const WITH_UNDO = process.env['FUZZ_UNDO'] === '1';
/** FUZZ_UNDO_OPS=0: install the undo plugin but never invoke undo/redo
 *  (isolates the plugin's presence from the operations). */
const UNDO_OPS = process.env['FUZZ_UNDO_OPS'] !== '0';
/** FUZZ_UNDO_GUARD=0: raw Loro undo (the pre-guard behavior) for A/B runs. */
const UNDO_GUARD = process.env['FUZZ_UNDO_GUARD'] !== '0';
/** Undo-step merge interval (ms) for the rig's managers. 0 = each op its
 *  own step (a user undoes their last action); the app's default is 1000. */
const UNDO_MERGE_MS = Number(process.env['FUZZ_UNDO_MERGE_MS'] ?? 0);
/** Per-view guard (the app installs one per session). */
const guards = new WeakMap<EditorView, UndoGuard>();
const undoManagers = new WeakMap<EditorView, UndoManager>();
const peerAtCreate = new WeakMap<EditorView, string>();
const peerAtOp = new WeakMap<EditorView, () => string>();

// ── Relay process ────────────────────────────────────────────────────
let relayProc: ChildProcess | null = null;
let relayDb = '';

async function waitHealth(port: number, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/relay/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  return false;
}

async function bootRelay(): Promise<void> {
  if (!relayDb) relayDb = path.join(os.tmpdir(), `relay-chaos-${process.pid}.db`);
  const py = path.join(RELAY_SERVICE_DIR, '../backend/venv/bin/uvicorn');
  relayProc = spawn(py, ['app:app', '--port', String(RELAY_PORT), '--log-level', 'warning'], {
    cwd: RELAY_SERVICE_DIR,
    env: {
      ...process.env,
      DATABASE_URL: `sqlite:///${relayDb}`,
      RELAY_TOKEN: TOKEN,
      ENTITLEMENT_SECRET: 'x',
      RELAY_DEV_FAKE_SESSION: '1',
      PYTHONPATH: path.join(RELAY_SERVICE_DIR, '../backend'),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  relayProc.stderr?.on('data', (d) => {
    stderr += String(d);
  });
  if (!(await waitHealth(RELAY_PORT, 20_000))) {
    throw new Error(`relay did not come up on ${RELAY_PORT}: ${stderr.slice(-400)}`);
  }
}

async function killRelay(): Promise<void> {
  const p = relayProc;
  relayProc = null;
  if (!p) return;
  await new Promise<void>((resolve) => {
    p.once('exit', () => resolve());
    p.kill('SIGTERM');
    setTimeout(() => {
      try {
        p.kill('SIGKILL');
      } catch {
        /* gone */
      }
      resolve();
    }, 3000);
  });
}

// ── Chaos proxy ──────────────────────────────────────────────────────
type ProxyMode = 'ok' | 'cut' | 'blackhole';
class ChaosProxy {
  mode: ProxyMode = 'ok';
  private server: net.Server;
  private sockets = new Set<net.Socket>();
  constructor(private readonly listenPort: number, private readonly upstreamPort: number) {
    this.server = net.createServer((client) => this.onConnection(client));
  }
  private onConnection(client: net.Socket): void {
    this.sockets.add(client);
    client.on('close', () => this.sockets.delete(client));
    client.on('error', () => {});
    if (this.mode === 'cut') {
      client.destroy();
      return;
    }
    if (this.mode === 'blackhole') {
      // Accepted, never answered: the client sees an open socket that
      // says nothing (deadlines / stall watchdog must fire).
      return;
    }
    const up = net.connect(this.upstreamPort, '127.0.0.1');
    up.on('error', () => client.destroy());
    client.on('error', () => up.destroy());
    up.on('close', () => client.destroy());
    client.on('close', () => up.destroy());
    client.pipe(up);
    up.pipe(client);
  }
  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.listenPort, '127.0.0.1', () => resolve()));
  }
  /** Destroy every live socket (in any mode). */
  cutAll(): void {
    for (const s of this.sockets) s.destroy();
  }
  async close(): Promise<void> {
    this.cutAll();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

// ── Fuzz machinery ───────────────────────────────────────────────────
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

const HEADING_TYPES = new Set(['tag', 'analytic', 'pocket', 'hat', 'block']);

/** Seed doc; every tag carries a heading token «hdS_N» so duplicated
 *  or lost HEADS are caught exactly-once, independent of id re-minting. */
function seedDoc(seed: number, headTokens: Set<string>): PMNode {
  const hd = (n: number): string => {
    const t = `«hd${seed}_${n}»`;
    headTokens.add(t);
    return t;
  };
  return docOf(
    cardNode(`Tag one alpha ${hd(0)}`, ['alpha bravo charlie delta', 'echo foxtrot golf']),
    cardNode(`Tag two bravo ${hd(1)}`, ['hotel india juliet kilo lima']),
    cardNode(`Tag three charlie ${hd(2)}`, ['mike november oscar papa']),
    cardNode(`Tag four delta ${hd(3)}`, ['quebec romeo sierra']),
  );
}

/** Heading ids in document order (null ids reported as the string 'NULL'). */
function headingIds(doc: PMNode): string[] {
  const out: string[] = [];
  doc.descendants((n) => {
    if (HEADING_TYPES.has(n.type.name)) out.push((n.attrs['id'] as string | null) ?? 'NULL');
    return true;
  });
  return out;
}

function duplicateIds(doc: PMNode): string[] {
  const seen = new Map<string, number>();
  for (const id of headingIds(doc)) seen.set(id, (seen.get(id) ?? 0) + 1);
  return [...seen.entries()].filter(([, n]) => n > 1).map(([id, n]) => `${id}×${n}`);
}

/** Absolute positions of every textblock: [start, end] of its content. */
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

/** Offsets in a textblock where an edit may land without cutting a
 *  token in half: word boundaries (after a space, or the ends) that are
 *  not inside a «…» token. */
function safeOffsets(text: string): number[] {
  const out: number[] = [];
  let inTok = false;
  for (let i = 0; i <= text.length; i++) {
    const ch = text[i] ?? '';
    if (text[i - 1] === '«') inTok = true;
    if (text[i - 1] === '»') inTok = false;
    if (inTok) continue;
    if (i === 0 || i === text.length || text[i - 1] === ' ' || ch === ' ') out.push(i);
  }
  return out;
}

/** Every «…» token currently in the doc. */
function tokensIn(doc: PMNode): Set<string> {
  const out = new Set<string>();
  for (const tb of textblocks(doc)) for (const m of tb.node.textContent.matchAll(/«[^»]+»/g)) out.add(m[0]);
  return out;
}

/** Absolute [from, to) of a token's text in the doc, or null. */
function findToken(doc: PMNode, token: string): { from: number; to: number } | null {
  for (const tb of textblocks(doc)) {
    const text = tb.node.textContent;
    const i = text.indexOf(token);
    if (i >= 0) return { from: tb.start + i, to: tb.start + i + token.length };
  }
  return null;
}

function countToken(doc: PMNode, token: string): number {
  let n = 0;
  for (const tb of textblocks(doc)) {
    const text = tb.node.textContent;
    let i = text.indexOf(token);
    while (i >= 0) {
      n++;
      i = text.indexOf(token, i + token.length);
    }
  }
  return n;
}

/** Top-level card-like children with their positions. */
function topCards(doc: PMNode): Array<{ index: number; pos: number; node: PMNode }> {
  const out: Array<{ index: number; pos: number; node: PMNode }> = [];
  let pos = 0;
  doc.forEach((child, _off, index) => {
    if (child.type.name === 'card' || child.type.name === 'analytic_unit') out.push({ index, pos, node: child });
    pos += child.nodeSize;
  });
  return out;
}

interface Oracle {
  inserted: Set<string>;
  deleted: Set<string>;
  /** Heading tokens: one per tag ever created; never deleted by any op. */
  heads: Set<string>;
  next: number;
  ops: Record<string, number>;
  /** Recent ops as `r<round>p<peer>:<op>` for merged-duplicate context. */
  trail: string[];
  /** Per token: where it was born and which peers saw it each round. */
  history: Map<string, string[]>;
  /** Set by the seed loop before each op batch: `r<round>p<peer>`. */
  where: string;
}

function bump(o: Oracle, name: string): void {
  o.ops[name] = (o.ops[name] ?? 0) + 1;
}

/** One random local edit on a peer. Tokens are unique per seed so the
 *  oracle can count them; structure ops are the heading-id/loss
 *  minting doors (Enter mid-tag, moves, id-carrying pastes, splits). */
function applyOp(view: EditorView, rnd: () => number, o: Oracle, seed: number): string {
  if (WITH_UNDO && UNDO_OPS) {
    const u = rnd();
    if (u < 0.10) {
      // Undo/redo only touches THIS peer's own ops, so the oracle
      // reconciles by diffing this peer's token set: a token that
      // vanished was legitimately un-inserted (counts as deleted), one
      // that reappeared was legitimately un-deleted.
      const before = tokensIn(view.state.doc);
      const umP = undoManagers.get(view);
      let isUndo = u < 0.07;
      if (umP && isUndo && !umP.canUndo() && umP.canRedo()) isUndo = false;
      if (umP && !isUndo && !umP.canRedo() && umP.canUndo()) isUndo = true;
      if (umP && !(isUndo ? umP.canUndo() : umP.canRedo())) return 'skip';
      const g = guards.get(view);
      const cmd = g ? (isUndo ? g.undo : g.redo) : isUndo ? loroUndo : loroRedo;
      const ran = cmd(view.state, (tr) => view.dispatch(tr), view);
      if (process.env['FUZZ_UNDO_PROBE'] && (o.ops['undoProbe'] ?? 0) < 6) { o.ops['undoProbe'] = (o.ops['undoProbe'] ?? 0) + 1; const um = undoManagers.get(view); console.log(`[undo-probe] via=${g ? 'guard' : 'raw'} isUndo=${isUndo} ran=${ran} canUndo=${um?.canUndo()} canRedo=${um?.canRedo()} peerNow=${peerAtOp.get(view)?.()} peerAtCreate=${peerAtCreate.get(view)}`); }
      if (!ran) return 'skip';
      const after = tokensIn(view.state.doc);
      for (const t of before) if (!after.has(t)) { o.deleted.add(t); o.heads.delete(t); o.history.get(t)?.push(`${isUndo ? 'undone' : 'redone-away'} ${o.where}`); }
      for (const t of after) if (!before.has(t)) { o.deleted.delete(t); if (t.startsWith('«hd')) o.heads.add(t); else o.inserted.add(t); o.history.get(t)?.push(`${isUndo ? 'undo-restored' : 'redone'} ${o.where}`); }
      bump(o, isUndo ? 'undo' : 'redo');
      return isUndo ? 'undo' : 'redo';
    }
  }
  const roll = rnd();
  const doc = view.state.doc;
  let name = 'none';
  try {
    if (roll < 0.34) {
      // insert a tracked token inside a body textblock
      const bodies = textblocks(doc).filter((t) => t.node.type.name === 'card_body' || t.node.type.name === 'paragraph');
      if (bodies.length === 0) return 'skip';
      const tb = bodies[Math.floor(rnd() * bodies.length)]!;
      const offs = safeOffsets(tb.node.textContent);
      const pos = tb.start + offs[Math.floor(rnd() * offs.length)]!;
      const token = `«tk${seed}_${o.next++}»`;
      view.dispatch(view.state.tr.insertText(` ${token} `, pos));
      o.inserted.add(token);
      o.history.set(token, [`born ${o.where}`]);
      name = 'insertToken';
      bump(o, 'insertToken');
    } else if (roll < 0.44) {
      // delete a whole tracked token that this peer currently sees
      const present = [...o.inserted].filter((t) => !o.deleted.has(t) && findToken(doc, t));
      if (present.length === 0) return 'skip';
      const token = present[Math.floor(rnd() * present.length)]!;
      const r = findToken(doc, token)!;
      view.dispatch(view.state.tr.delete(r.from, r.to));
      o.deleted.add(token);
      o.history.get(token)?.push(`deleted ${o.where}`);
      name = 'deleteToken';
      bump(o, 'deleteToken');
    } else if (roll < 0.58 && !NO_SPLIT) {
      // Enter in the middle of a tag — the numbering/heading-id door
      const tags: Array<{ start: number; end: number; text: string }> = [];
      doc.descendants((n, pos) => {
        if (n.type.name === 'tag' && n.content.size >= 4) tags.push({ start: pos + 1, end: pos + 1 + n.content.size, text: n.textContent });
        return !HEADING_TYPES.has(n.type.name);
      });
      if (tags.length === 0) return 'skip';
      const t = tags[Math.floor(rnd() * tags.length)]!;
      const offs = safeOffsets(t.text).filter((o2) => o2 > 0 && o2 < t.text.length);
      if (offs.length === 0) return 'skip';
      const at = t.start + offs[Math.floor(rnd() * offs.length)]!;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
      enterMidTag(view.state, (tr) => view.dispatch(tr));
      name = 'enterMidTag';
      bump(o, 'enterMidTag');
    } else if (roll < 0.68) {
      // split a body paragraph
      const bodies = textblocks(doc).filter((t) => t.node.type.name === 'card_body' && t.end - t.start > 2);
      if (bodies.length === 0) return 'skip';
      const tb = bodies[Math.floor(rnd() * bodies.length)]!;
      const offs = safeOffsets(tb.node.textContent).filter((o2) => o2 > 0 && o2 < tb.end - tb.start);
      if (offs.length === 0) return 'skip';
      view.dispatch(view.state.tr.split(tb.start + offs[Math.floor(rnd() * offs.length)]!));
      name = 'splitBody';
      bump(o, 'splitBody');
    } else if (roll < 0.8 && !NO_MOVE) {
      // move a top-level card to another top-level slot (content preserved)
      const cards = topCards(doc);
      if (cards.length < 2) return 'skip';
      const src = cards[Math.floor(rnd() * cards.length)]!;
      const others = cards.filter((c) => c.index !== src.index);
      const dst = others[Math.floor(rnd() * others.length)]!;
      const tr = view.state.tr.delete(src.pos, src.pos + src.node.nodeSize);
      const insertAt = tr.mapping.map(dst.pos + (rnd() < 0.5 ? 0 : dst.node.nodeSize));
      tr.insert(insertAt, src.node);
      view.dispatch(tr);
      name = 'moveCard';
      bump(o, 'moveCard');
    } else if (roll < 0.88 && process.env['FUZZ_NO_DUPPASTE'] !== '1') {
      // paste-like insert of a card carrying an EXISTING heading id (the
      // guard must remint; a surviving duplicate is a finding)
      const ids = headingIds(doc).filter((id) => id !== 'NULL');
      if (ids.length === 0) return 'skip';
      const stolen = ids[Math.floor(rnd() * ids.length)]!;
      const card = schema.nodes['card']!.createChecked(null, [
        schema.nodes['tag']!.create({ id: stolen }, schema.text(`Pasted ${Math.floor(rnd() * 1000)}`)),
        schema.nodes['card_body']!.create(null, schema.text('pasted body text')),
      ]);
      const cards = topCards(doc);
      const at = cards.length ? cards[Math.floor(rnd() * cards.length)]!.pos : 0;
      view.dispatch(view.state.tr.insert(at, card));
      name = 'pasteDupId';
      bump(o, 'pasteDupId');
    } else if (roll < 0.94 || (roll < 0.88 && process.env['FUZZ_NO_DUPPASTE'] === '1')) {
      // fresh card with a tracked token
      const token = `«tk${seed}_${o.next++}»`;
      const head = `«hd${seed}_${o.next++}»`;
      const card = cardNode(`Fresh ${Math.floor(rnd() * 1000)} ${head}`, [`new ${token} body`]);
      view.dispatch(view.state.tr.insert(view.state.doc.content.size, card));
      o.inserted.add(token);
      o.heads.add(head);
      o.history.set(token, [`born ${o.where} (card)`]);
      name = 'insertCard';
      bump(o, 'insertCard');
    } else {
      // a mark over a short run (the causal-heal family)
      const tbs = textblocks(doc).filter((t) => t.end - t.start > 3);
      if (tbs.length === 0) return 'skip';
      const tb = tbs[Math.floor(rnd() * tbs.length)]!;
      const from = tb.start + Math.floor(rnd() * (tb.end - tb.start - 2));
      const to = Math.min(tb.end, from + 1 + Math.floor(rnd() * 6));
      const mark = rnd() < 0.5 ? schema.marks['highlight']!.create() : schema.marks['underline']!.create();
      view.dispatch(view.state.tr.addMark(from, to, mark));
      name = 'mark';
      bump(o, 'mark');
    }
  } catch (e) {
    bump(o, `skip:${(e as Error).message.slice(0, 40)}`);
    return 'skip';
  }
  return name;
}

/** Texts of the headings carrying `id` — to see WHICH nodes share it. */
function headingTextsFor(doc: PMNode, id: string): string[] {
  const out: string[] = [];
  doc.descendants((n) => {
    if (HEADING_TYPES.has(n.type.name) && n.attrs['id'] === id) out.push(`${n.type.name}:"${n.textContent.slice(0, 30)}"`);
    return true;
  });
  return out;
}

async function waitForConvergence(docs: () => PMNode[], deadlineMs: number): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    await settle();
    const ds = docs();
    if (ds.every((d) => d.eq(ds[0]!))) return true;
    if (Date.now() - t0 > deadlineMs) return false;
    await sleep(250);
  }
}

interface SeedReport {
  seed: number;
  ok: boolean;
  chaos: string[];
  ops: Record<string, number>;
  problems: string[];
}

describe.skipIf(!ENABLED)('real-relay CHAOS fuzz (local relay + chaos proxy)', () => {
  it(
    `holds convergence, unique heading ids, and the content oracle across ${SEEDS} seeds`,
    async () => {
      if (!fs.existsSync(RELAY_SERVICE_DIR)) throw new Error(`RELAY_SERVICE_DIR missing: ${RELAY_SERVICE_DIR}`);
      await bootRelay();
      const proxy = new ChaosProxy(PROXY_PORT, RELAY_PORT);
      await proxy.listen();
      const reports: SeedReport[] = [];
      try {
        for (let seed = SEED_START; seed < SEED_START + SEEDS; seed++) {
          const rnd = mulberry32(seed);
          const report: SeedReport = { seed, ok: true, chaos: [], ops: {}, problems: [] };
          const oracle: Oracle = { inserted: new Set(), deleted: new Set(), heads: new Set(), next: 0, ops: report.ops, trail: [], history: new Map(), where: '' };
          const mkClient = () =>
            new RoomsClient({
              baseUrl: () => `http://127.0.0.1:${PROXY_PORT}/relay`,
              token: () => TOKEN,
              requestTimeoutMs: 2500,
              postTimeoutMs: 4000,
            });
          const OPTS = {
            flushMs: 30,
            minBackoffMs: 30,
            maxBackoffMs: 250,
            catchUpMs: 4000,
            stallMs: 1500,
            resetAfterMs: 800,
            auditDelayMs: 600,
          };
          const peerIds: string[] = [];
          // ORDER MATTERS and mirrors the app (index.ts): the base editor
          // plugins (heading-id guard, numbering) come first, the session
          // binding is appended LAST. The guard skips any apply cycle that
          // already holds a binding-stamped transaction, so with the sync
          // plugin ahead of it the guard is inert (measured 2026-09-04:
          // sync→guard leaves a duplicate-id insert unrepaired; guard→sync
          // remints it).
          const pendingGuards = new Map<CollabSession, UndoGuard>();
          const pendingUms = new Map<CollabSession, UndoManager>();
          let viewRef: { current: EditorView | null } = { current: null };
          const plugsFor = (s: CollabSession) => {
            const undoPlugins: import('prosemirror-state').Plugin[] = [];
            if (WITH_UNDO) {
              const um = new UndoManager(s.loroDoc, { mergeInterval: UNDO_MERGE_MS });
              pendingUms.set(s, um);
              undoPlugins.push(LoroUndoPlugin({ doc: s.loroDoc, undoManager: um }));
              if (UNDO_GUARD) {
                const ref = { current: null as EditorView | null };
                viewRef = ref;
                const g = createUndoGuard({ doc: s.loroDoc, undoManager: um, getView: () => ref.current, onBlocked: () => { report.ops['undoBlocked'] = (report.ops['undoBlocked'] ?? 0) + 1; } });
                pendingGuards.set(s, g);
                undoPlugins.push(g.plugin);
              }
            }
            return [
            headingIdGuardPlugin,
            cardNumberingPlugin,
            ...s.plugins(),
            ...undoPlugins,
            ...(NO_HEAL
              ? []
              : [
                  collabInvariantHealPlugin(),
                  causalMarkHealPlugin(s.loroDoc),
                  collabRepairPlugin(() => lowestPeerIsLeader(s.loroDoc.peerIdStr, peerIds)),
                ]),
            ];
          };
          /** mkView + bind the session's undo guard to the new view. */
          const viewFor = (s: CollabSession): EditorView => {
            const v = mkView(plugsFor(s));
            const g = pendingGuards.get(s);
            const um = pendingUms.get(s);
            if (um) { undoManagers.set(v, um); peerAtCreate.set(v, s.loroDoc.peerIdStr); peerAtOp.set(v, () => s.loroDoc.peerIdStr); }
            if (g) {
              viewRef.current = v;
              guards.set(v, g);
            }
            return v;
          };

          const { session: host, shareCode } = await CollabSession.host({ pmDoc: seedDoc(seed, oracle.heads), client: mkClient(), ...OPTS });
          const decoded = decodeShareCode(shareCode)!;
          const peers: Array<{ session: CollabSession; view: EditorView; stopped: boolean }> = [];
          peers.push({ session: host, view: viewFor(host), stopped: false });
          peerIds.push(host.loroDoc.peerIdStr);
          await settle();
          host.start();
          for (let p = 1; p < PEERS; p++) {
            const j = await CollabSession.join({ ...decoded, client: mkClient(), ...OPTS });
            peers.push({ session: j, view: viewFor(j), stopped: false });
            peerIds.push(j.loroDoc.peerIdStr);
            await settle();
            j.start();
          }
          await sleep(300);

          const relayRestartRound = Math.floor(rnd() * ROUNDS);
          for (let round = 0; round < ROUNDS; round++) {
            for (let p = 0; p < peers.length; p++) {
              const n = 1 + Math.floor(rnd() * 4);
              oracle.where = `r${round}p${p}`;
              for (let k = 0; k < n; k++) {
                const before = duplicateIds(peers[p]!.view.state.doc);
                const name = applyOp(peers[p]!.view, rnd, oracle, seed);
                if (name === 'undo' || name === 'redo') await settle(2);
                oracle.trail.push(`r${round}p${p}:${name}`);
                const after = duplicateIds(peers[p]!.view.state.doc);
                const fresh = after.filter((d) => !before.includes(d));
                if (fresh.length) {
                  report.problems.push(`LOCAL DOOR r${round} p${p} op=${name}: ${fresh.map((d) => `${d} ${headingTextsFor(peers[p]!.view.state.doc, d.split('×')[0]!).join(' | ')}`).join('; ')}`);
                }
              }
            }
            await sleep(80 + Math.floor(rnd() * 120));
            for (const t of oracle.inserted) {
              if (oracle.deleted.has(t)) continue;
              const seen = peers.map((pp, i) => (countToken(pp.view.state.doc, t) > 0 ? `p${i}` : '-')).join('');
              oracle.history.get(t)?.push(`r${round}:${seen}`);
            }
            for (let p = 0; p < peers.length; p++) {
              const dups = duplicateIds(peers[p]!.view.state.doc);
              const known = report.problems.some((x) => x.startsWith('LOCAL DOOR'));
              if (dups.length && !known && !report.problems.some((x) => x.startsWith('MERGED DUP'))) {
                report.problems.push(`MERGED DUP first seen r${round} p${p} (chaos so far: ${report.chaos.join(' ') || 'none'}): ${dups.map((d) => `${d} ${headingTextsFor(peers[p]!.view.state.doc, d.split('×')[0]!).join(' | ')}`).join('; ')}\n      recent ops: ${oracle.trail.join(' ')}`);
              }
            }

            // ── chaos between rounds ──
            const c = rnd();
            if (NO_CHAOS) {
              /* pure live sync: no network or lifecycle events */
            } else if (round === relayRestartRound) {
              report.chaos.push(`r${round}:relay-restart`);
              await killRelay();
              proxy.cutAll();
              await sleep(300 + Math.floor(rnd() * 500));
              await bootRelay();
            } else if (c < 0.2) {
              report.chaos.push(`r${round}:proxy-cut`);
              proxy.mode = 'cut';
              proxy.cutAll();
              await sleep(300 + Math.floor(rnd() * 700));
              proxy.mode = 'ok';
            } else if (c < 0.35) {
              report.chaos.push(`r${round}:blackhole`);
              proxy.mode = 'blackhole';
              proxy.cutAll();
              await sleep(1200 + Math.floor(rnd() * 1500));
              proxy.mode = 'ok';
              proxy.cutAll(); // release the held sockets
            } else if (c < 0.5) {
              const p = Math.floor(rnd() * peers.length);
              report.chaos.push(`r${round}:stop-start(p${p})`);
              await peers[p]!.session.stop();
              peers[p]!.stopped = true;
              await sleep(200 + Math.floor(rnd() * 400));
              peers[p]!.session.start();
              peers[p]!.stopped = false;
            } else if (c < 0.65) {
              // app relaunch: persist → tear down → resume from the record
              const p = Math.floor(rnd() * peers.length);
              const old = peers[p]!;
              report.chaos.push(`r${round}:resume(p${p})`);
              const snapshot = old.session.exportSnapshot();
              const meta = old.session.persistMeta();
              await old.session.stop();
              old.view.destroy();
              const resumed = await CollabSession.resume({
                roomId: old.session.roomId,
                keyBytes: decoded.keyBytes,
                role: p === 0 ? 'host' : 'participant',
                snapshot,
                increments: [],
                lastSeq: meta.lastSeq,
                sentVersion: meta.sentVersion,
                client: mkClient(),
                ...OPTS,
              });
              peerIds[p] = resumed.loroDoc.peerIdStr;
              peers[p] = { session: resumed, view: viewFor(resumed), stopped: false };
              await settle();
              resumed.start();
            } else if (c < 0.8) {
              const p = Math.floor(rnd() * peers.length);
              report.chaos.push(`r${round}:restart(p${p})`);
              peers[p]!.session.restart();
            }
          }

          // Everything back online; force a catch-up on every peer.
          proxy.mode = 'ok';
          for (const p of peers) {
            if (p.stopped) {
              p.session.start();
              p.stopped = false;
            }
            await p.session.catchUp().catch(() => {});
          }
          const converged = await waitForConvergence(() => peers.map((p) => p.view.state.doc), 30_000);
          if (!converged) {
            report.ok = false;
            report.problems.push('peers did not converge in 30s');
          }

          // A fresh joiner from the relay's stored history (no cache).
          let freshDoc: PMNode | null = null;
          try {
            const fresh = await CollabSession.join({ ...decoded, client: mkClient(), ...OPTS });
            const fv = viewFor(fresh);
            await settle();
            fresh.start();
            const both = await waitForConvergence(() => [peers[0]!.view.state.doc, fv.state.doc], 15_000);
            freshDoc = fv.state.doc;
            if (!both) {
              report.ok = false;
              report.problems.push('fresh joiner from relay history differs from live peers');
            }
            await fresh.stop();
            fv.destroy();
          } catch (e) {
            report.ok = false;
            report.problems.push(`fresh joiner failed: ${(e as Error).message}`);
          }

          const final = peers[0]!.view.state.doc;
          try {
            final.check();
          } catch (e) {
            report.ok = false;
            report.problems.push(`schema-invalid: ${(e as Error).message.slice(0, 120)}`);
          }
          for (const [label, d] of [...peers.map((p, i) => [`p${i}`, p.view.state.doc] as const), ...(freshDoc ? [['fresh', freshDoc] as const] : [])]) {
            const dups = duplicateIds(d);
            if (dups.length) {
              report.ok = false;
              report.problems.push(`${label}: duplicate heading ids ${dups.map((x) => `${x} [${headingTextsFor(d, x.split('×')[0]!).join(' | ')}]`).join(', ')}`);
            }
            if (headingIds(d).includes('NULL')) {
              report.ok = false;
              report.problems.push(`${label}: null heading id`);
            }
          }
          const expected = [...oracle.inserted].filter((t) => !oracle.deleted.has(t));
          const lost = expected.filter((t) => countToken(final, t) === 0);
          const duplicated = expected.filter((t) => countToken(final, t) > 1);
          const resurrected = [...oracle.deleted].filter((t) => countToken(final, t) > 0);
          if (lost.length) {
            report.ok = false;
            report.problems.push(`LOST content (never deleted): ${lost.map((t) => `${t} [${(oracle.history.get(t) ?? []).join(' ')}] chaos=[${report.chaos.join(' ')}]`).join('; ')}`);
          }
          if (duplicated.length) {
            report.ok = false;
            report.problems.push(`DUPLICATED content: ${duplicated.join(', ')}`);
          }
          if (resurrected.length) {
            report.ok = false;
            report.problems.push(`deleted content came back: ${resurrected.join(', ')}`);
          }
          const lostHeads = [...oracle.heads].filter((t) => countToken(final, t) === 0);
          const dupHeads = [...oracle.heads].filter((t) => countToken(final, t) > 1);
          if (lostHeads.length) {
            report.ok = false;
            report.problems.push(`LOST heading (never deleted): ${lostHeads.join(', ')}`);
          }
          if (dupHeads.length) {
            report.ok = false;
            report.problems.push(`DUPLICATED heading: ${dupHeads.map((t) => `${t}×${countToken(final, t)}`).join(', ')}`);
          }
          if (!report.ok) {
            report.problems.push(`docs: ${peers.map((p, i) => `p${i}=${docText(p.view.state.doc).length}ch`).join(' ')}`);
            report.problems.push(`ops: ${oracle.trail.filter((t) => !t.endsWith(':skip')).join(' ')}`);
          }
          reports.push(report);
          console.log(
            `[chaos-fuzz] seed ${seed}: ${report.ok ? 'OK ' : 'FAIL'} format=${host.childrenFormat()} tokens=${expected.length} heads=${oracle.heads.size} ids=${headingIds(final).length} chaos=[${report.chaos.join(' ')}]` +
              (report.ok ? '' : `\n    ${report.problems.join('\n    ')}`),
          );

          if (WITH_UNDO && UNDO_GUARD) console.log(`[chaos-fuzz] seed ${seed} undo-guard stats: ${peers.map((p, i) => { const g = guards.get(p.view); return `p${i}=${g ? `${g.stats.allowed}a/${g.stats.blocked}b/${g.stats.unrecoverable}u` : 'NO-GUARD'}`; }).join(' ')} undoOps=${report.ops['undo'] ?? 0}/${report.ops['redo'] ?? 0}`);
          for (const p of peers) {
            await p.session.stop().catch(() => {});
            p.view.destroy();
          }
          await mkClient().deleteRoom(decoded.roomId).catch(() => {});
        }
      } finally {
        await proxy.close();
        await killRelay();
        try {
          fs.unlinkSync(relayDb);
        } catch {
          /* already gone */
        }
      }
      const failed = reports.filter((r) => !r.ok);
      console.log(`[chaos-fuzz] ${reports.length - failed.length}/${reports.length} seeds clean`);
      for (const r of failed) console.log(`[chaos-fuzz] seed ${r.seed} problems:\n  ${r.problems.join('\n  ')}`);
      expect(failed.map((r) => r.seed)).toEqual([]);
    },
    1_800_000,
  );
});
