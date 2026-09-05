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
 * Ops (per peer, per round): typed tokens (some with astral-plane
 * characters, some typed INSIDE marked runs), token deletes, Enter
 * mid-tag, body splits, card moves (one transaction) and cut+paste of a
 * card (two transactions), id-carrying pastes, fresh cards, marks,
 * keyboard typing through the autocorrect family (smart quotes, custom
 * dash, custom autocorrects, auto-capitalize), comment threads /
 * replies / resolve toggles, and — opt-in — undo/redo through the app's
 * guarded undo. Every session carries cursor presence and comment sync
 * like the app's. Chaos also includes leave/rejoin (farewell + stop,
 * start + rebroadcast) with a presence-roster oracle, and wake bursts
 * (hide/show + three restarts a beat apart).
 *
 * Invariants per seed (the bug families we chase, not just convergence):
 *   1. every peer + the fresh joiner converge to one schema-valid doc;
 *   2. heading ids (tag/analytic/pocket/hat/block) are unique and
 *      non-null in that doc;
 *   3. CONTENT ORACLE: every token the fuzzer inserted and never
 *      deleted appears EXACTLY once (lost content and duplicated
 *      content both fail); tokens it deleted do not reappear; heading
 *      tokens appear exactly once;
 *   4. marks a token was typed with survive (unless a later mark op
 *      overlapped it); no exclusive-mark clash, hollow container or
 *      ragged table survives the session;
 *   5. exact text ops never mismatched the ProseMirror text (the
 *      binding's __CM_TEXT_SYNC_STATS__ counter);
 *   6. presence: a leaving peer drops off partners' rosters within 2s,
 *      a rejoining one is back within 3s, and every roster is complete
 *      after convergence; comment threads/replies/resolved state
 *      converge and none is lost.
 * Soft notes (printed, never failing): a partner's edit lost to a
 * cut+paste of its card (delete+create — expected today), undo blocks
 * the rig's own ledger considers unjustified, long-outage row counts.
 *
 * Run (skipped unless REAL_RELAY_CHAOS=1):
 *   REAL_RELAY_CHAOS=1 FUZZ_SEEDS=10 npx vitest run tests/collab/real-relay-chaos-fuzz.test.ts
 * Knobs: FUZZ_SEEDS, FUZZ_SEED_START, FUZZ_ROUNDS, FUZZ_PEERS,
 * FUZZ_NO_CHAOS / NO_MOVE / NO_CUTPASTE / NO_CUTINPLACE / NO_SPLIT / NO_HEAL / NO_DUPPASTE /
 * NO_AUTOCORRECT / NO_PRESENCE / NO_COMMENTS, FUZZ_UNDO (+UNDO_OPS=0,
 * UNDO_GUARD=0, UNDO_MERGE_MS), FUZZ_SCALE=N cards (+FUZZ_SCALE_OP_P95_MS
 * threshold; timings land in the per-seed ops line), FUZZ_LONG_OUTAGE_MS,
 * FUZZ_OLD_PEER_DIR (mixed-version peer from an older release's worktree
 * inside the repo), RELAY_SERVICE_DIR (…/Scouting Assistant/relay-service),
 * RELAY_PORT. Findings only — the rig makes no product changes.
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
import { freshHeadingIds } from '../../src/editor/drag-controller.js';
import { buildCutInPlacePlugin, installCutInPlaceContext, markCutInPlace, handleCutInPlacePaste, pendingCut } from '../../src/editor/cut-in-place.js';
import { Slice, Fragment } from 'prosemirror-model';
import { LoroUndoPlugin, undo as loroUndo, redo as loroRedo } from 'loro-prosemirror';
import { createUndoGuard, type UndoGuard } from '../../src/editor/collab/undo-guard.js';
import { UndoManager } from 'loro-crdt';
import { mkView, settle, sleep, cardNode, docOf, docText, tableNode, tableShapes } from './_loro-helpers.js';
import { settings } from '../../src/editor/settings.js';
import { smartQuotesPlugin } from '../../src/editor/smart-quotes-plugin.js';
import { customDashPlugin } from '../../src/editor/custom-dash-plugin.js';
import { autoCapitalizePlugin } from '../../src/editor/auto-capitalize-plugin.js';
import { customAutocorrectPlugin } from '../../src/editor/custom-autocorrect-plugin.js';
import { installCursorPresence, type CursorsHandle } from '../../src/editor/collab/collab-cursors.js';
import { installCommentsSync, type CommentsSyncHandle } from '../../src/editor/collab/collab-comments.js';
import { commentsPlugin, commentsKey, addThreadMeta, addReplyMeta, setResolvedMeta, getCommentsState, type Comment } from '../../src/editor/comments-plugin.js';

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
/** FUZZ_NO_CUTPASTE=1: keep one-transaction moves, drop the two-transaction cut+paste. */
const NO_CUTPASTE = process.env['FUZZ_NO_CUTPASTE'] === '1';
/** FUZZ_NO_CUTINPLACE=1: drop the session cut (mark, then a paste that
 *  moves) — the way a 1.7.0 client cuts a whole card in a session. */
const NO_CUTINPLACE = process.env['FUZZ_NO_CUTINPLACE'] === '1';
/** Cut-in-place plumbing for the rig's views: every view is a session
 *  doc keyed by itself; the clipboard write hands the payload back. */
const docKeys = new WeakMap<EditorView, string>();
const cutHtml = new WeakMap<EditorView, string>();
let lastCutHtml = '';
let docKeySeq = 0;
installCutInPlaceContext({
  isSessionDoc: () => true,
  docKey: (view) => docKeys.get(view) ?? null,
  viewForDocKey: () => null,
  hasSeenNotice: () => true,
  markNoticeSeen: () => {},
  writeClipboard: async (html) => {
    lastCutHtml = html;
    return true;
  },
  clipboardBusyMessage: 'busy',
});
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
/** FUZZ_NO_AUTOCORRECT=1: leave the autocorrect family (smart quotes,
 *  custom dash, custom autocorrects, auto-capitalize) out of the stack. */
const WITH_AUTOCORRECT = process.env['FUZZ_NO_AUTOCORRECT'] !== '1';
/** FUZZ_NO_PRESENCE=1 / FUZZ_NO_COMMENTS=1: leave cursor presence /
 *  comment sync out of the session (the app always installs both). */
const WITH_PRESENCE = process.env['FUZZ_NO_PRESENCE'] !== '1';
const WITH_COMMENTS = process.env['FUZZ_NO_COMMENTS'] !== '1';
/** FUZZ_SCALE=N: N generated cards appended to the seed doc, with
 *  host/join/op/convergence timings in the per-seed ops line;
 *  FUZZ_SCALE_OP_P95_MS fails a seed whose op p95 exceeds it. */
const SCALE = Number(process.env['FUZZ_SCALE'] ?? 0);
const SCALE_OP_P95_MS = Number(process.env['FUZZ_SCALE_OP_P95_MS'] ?? 0);
/** FUZZ_LONG_OUTAGE_MS=N: one mid-run blackhole of N ms during which
 *  every peer keeps typing; the relay rows those edits became are
 *  counted afterwards (coalescing: about one row per peer per drain). */
const LONG_OUTAGE_MS = Number(process.env['FUZZ_LONG_OUTAGE_MS'] ?? 0);
/** FUZZ_OLD_PEER_DIR=<git worktree of an older release, INSIDE the repo
 *  (vite refuses files outside its root), e.g. .fuzz-old-1.6.0 after
 *  `git worktree add --detach .fuzz-old-1.6.0 v1.6.0 && (cd .fuzz-old-1.6.0 && npm ci)`>:
 *  peer 1 is built entirely from that tree — its session, transport,
 *  binding patch, plugins and ProseMirror — so the wire, the relay and
 *  the merges are exercised across versions. That peer runs only
 *  schema-agnostic ops (its schema is a different instance). */
const OLD_PEER_DIR = process.env['FUZZ_OLD_PEER_DIR'] ?? '';
interface OldMods {
  CollabSession: typeof CollabSession;
  RoomsClient: typeof RoomsClient;
  mkView: typeof mkView;
  TextSelection: typeof TextSelection;
  headingIdGuardPlugin: import('prosemirror-state').Plugin;
  cardNumberingPlugin: import('prosemirror-state').Plugin;
  collabInvariantHealPlugin: typeof collabInvariantHealPlugin;
  causalMarkHealPlugin: typeof causalMarkHealPlugin;
  collabRepairPlugin: typeof collabRepairPlugin;
  lowestPeerIsLeader: typeof lowestPeerIsLeader;
  installCursorPresence: typeof installCursorPresence;
  installCommentsSync: typeof installCommentsSync;
  commentsPlugin: import('prosemirror-state').Plugin;
  getCommentsState: typeof getCommentsState;
  hasReconcile: boolean;
}
async function loadOldMods(dir: string): Promise<OldMods> {
  const imp = (rel: string): Promise<Record<string, unknown>> => import(/* @vite-ignore */ `${dir}/${rel}`) as Promise<Record<string, unknown>>;
  const [sess, rc, helpers, guard, numbering, inv, heal, repair, cursors, comments, cplug, pstate, lp] = await Promise.all([
    imp('src/editor/collab/collab-session.ts'),
    imp('src/editor/collab/room-client.ts'),
    imp('tests/collab/_loro-helpers.ts'),
    imp('src/editor/heading-id-guard.ts'),
    imp('src/editor/numbering-plugin.ts'),
    imp('src/editor/collab/collab-invariants.ts'),
    imp('src/editor/collab/causal-mark-heal.ts'),
    imp('src/editor/collab/collab-repair.ts'),
    imp('src/editor/collab/collab-cursors.ts'),
    imp('src/editor/collab/collab-comments.ts'),
    imp('src/editor/comments-plugin.ts'),
    imp('node_modules/prosemirror-state/dist/index.js'),
    imp('node_modules/loro-prosemirror/dist/index.js'),
  ]);
  return {
    CollabSession: sess['CollabSession'] as typeof CollabSession,
    RoomsClient: rc['RoomsClient'] as typeof RoomsClient,
    mkView: helpers['mkView'] as typeof mkView,
    TextSelection: pstate['TextSelection'] as typeof TextSelection,
    headingIdGuardPlugin: guard['headingIdGuardPlugin'] as import('prosemirror-state').Plugin,
    cardNumberingPlugin: numbering['cardNumberingPlugin'] as import('prosemirror-state').Plugin,
    collabInvariantHealPlugin: inv['collabInvariantHealPlugin'] as typeof collabInvariantHealPlugin,
    causalMarkHealPlugin: heal['causalMarkHealPlugin'] as typeof causalMarkHealPlugin,
    collabRepairPlugin: repair['collabRepairPlugin'] as typeof collabRepairPlugin,
    lowestPeerIsLeader: repair['lowestPeerIsLeader'] as typeof lowestPeerIsLeader,
    installCursorPresence: cursors['installCursorPresence'] as typeof installCursorPresence,
    installCommentsSync: comments['installCommentsSync'] as typeof installCommentsSync,
    commentsPlugin: cplug['commentsPlugin'] as import('prosemirror-state').Plugin,
    getCommentsState: cplug['getCommentsState'] as typeof getCommentsState,
    hasReconcile: String(lp['LoroSyncPlugin']).includes('cardmirrorReconcile') || String(lp['updateLoroToPmState'] ?? '').includes('cardmirrorReconcile'),
  };
}
/** Astral-plane characters some tokens carry (surrogate pairs at the
 *  edges of exact text ops and inside the diff's trims). */
const ASTRAL = ['🙂', '𝔘𝔫', '👩‍💻', '𝕏'];
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

/** Seed doc; every tag carries a heading token «hdSsN» so duplicated
 *  or lost HEADS are caught exactly-once, independent of id re-minting.
 *  (Seed heads live in their own «hdSs…» namespace: fresh cards mint
 *  «hdS_N» from the shared op counter, and until 2026-09-04 the two
 *  collided — every "duplicated head" the rig ever reported was a fresh
 *  card whose head text equalled a seed card's. A rig bug, not a merge
 *  bug.) */
function seedDoc(seed: number, headTokens: Set<string>): PMNode {
  const hd = (n: number): string => {
    const t = `«hd${seed}s${n}»`;
    headTokens.add(t);
    return t;
  };
  return docOf(
    cardNode(`Tag one alpha ${hd(0)}`, ['alpha bravo charlie delta', 'echo foxtrot golf']),
    cardNode(`Tag two bravo ${hd(1)}`, ['hotel india juliet kilo lima']),
    cardNode(`Tag three charlie ${hd(2)}`, ['mike november oscar papa']),
    cardNode(`Tag four delta ${hd(3)}`, ['quebec romeo sierra']),
    tableNode(2, 3, 'cell'),
    ...Array.from({ length: SCALE }, (_, i) => cardNode(`Scale card ${i} ${hd(4 + i)}`, [`body ${i} lorem ipsum dolor sit amet consectetur`, `second paragraph ${i} of filler text for size`])),
  );
}
function percentile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(q * a.length))]!;
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
  /** Mark names on every character of a token right after it was typed
   *  (typing inherits the run's marks) — must survive to the end unless
   *  a later mark op overlapped the token. */
  birthMarks: Map<string, string[]>;
  markTouched: Set<string>;
  /** heading id → peer indexes whose LOCAL ops targeted that container
   *  (the rig's own ledger, independent of the undo guard's). */
  touchedBy: Map<string, Set<number>>;
  /** Tokens / heads that sat inside a card while it was cut and pasted
   *  (two transactions: the CRDT sees delete + create, so a partner's
   *  concurrent edit to that card is expected to vanish — reported in
   *  its own bucket, not as a hard loss). */
  cutPasted: Set<string>;
  /** Heading id of the container each token was born in, and every
   *  container heading id a cut+paste ever removed: a token born into a
   *  card a partner had cut before seeing it is the same expected loss. */
  birthContainer: Map<string, string>;
  cutCards: Set<string>;
  /** Set by the undo op, consumed by the seed loop after the guard's
   *  microtask: which heading ids the undo removed and who ran it. */
  pendingUndoCheck: { removed: string[]; peer: number; blockedBefore: number } | null;
  /** Soft findings printed per seed (never fail the seed). */
  notes: string[];
  /** Comment threads added (id → reply ids added to it). */
  threads: Map<string, Set<string>>;
}

function peerIndexOf(o: Oracle): number {
  const m = /p(\d+)$/.exec(o.where);
  return m ? Number(m[1]) : -1;
}
/** Heading id of the container enclosing `pos` (card / analytic unit →
 *  its head; pocket / hat / block → itself), or null outside any. */
function containerHeadId(doc: PMNode, pos: number): string | null {
  const $p = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  for (let d = $p.depth; d >= 0; d--) {
    const n = $p.node(d);
    if (n.type.name === 'card' || n.type.name === 'analytic_unit') {
      const head = n.firstChild;
      return head && HEADING_TYPES.has(head.type.name) ? ((head.attrs['id'] as string | null) ?? 'NULL') : null;
    }
    if (n.type.name === 'pocket' || n.type.name === 'hat' || n.type.name === 'block') return (n.attrs['id'] as string | null) ?? 'NULL';
  }
  return null;
}
function touch(o: Oracle, doc: PMNode, pos: number): void {
  const id = containerHeadId(doc, pos);
  if (!id) return;
  let set = o.touchedBy.get(id);
  if (!set) o.touchedBy.set(id, (set = new Set()));
  set.add(peerIndexOf(o));
}
/** Mark names present on EVERY character of [from, to) (comment ranges
 *  ignored). */
function marksAt(doc: PMNode, from: number, to: number): string[] {
  let names: Set<string> | null = null;
  doc.nodesBetween(from, to, (n) => {
    if (!n.isText) return true;
    const here = new Set(n.marks.map((m) => m.type.name).filter((x) => x !== 'comment_range'));
    names = names ? new Set([...names].filter((x) => here.has(x))) : here;
    return false;
  });
  return names ? [...(names as Set<string>)].sort() : [];
}
/** Text runs carrying two marks the schema says exclude each other —
 *  the exclusive-marks sweep's job in a session. */
function markClashes(doc: PMNode): string[] {
  const out: string[] = [];
  doc.descendants((n) => {
    if (!n.isText) return true;
    for (const a of n.marks) for (const b of n.marks) if (a !== b && a.type.excludes(b.type)) { out.push(`${a.type.name}+${b.type.name} on "${(n.text ?? '').slice(0, 24)}"`); return true; }
    return true;
  });
  return out;
}
/** Cards / analytic units whose first child is not a head. */
function hollowContainers(doc: PMNode): string[] {
  const out: string[] = [];
  doc.descendants((n, pos) => {
    if (n.type.name === 'card' || n.type.name === 'analytic_unit') {
      const head = n.firstChild;
      if (!head || !HEADING_TYPES.has(head.type.name)) out.push(`${n.type.name}@${pos}: first child ${head?.type.name ?? 'none'}`);
    }
    return true;
  });
  return out;
}
/** Type `text` one character at a time through the editor's
 *  handleTextInput chain (what a keyboard does), so char- and
 *  commit-triggered autocorrect rules fire and land in the sync batch
 *  alongside the typed characters. */
function typeChars(view: EditorView, at: number, text: string): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
  for (const ch of text) {
    const from = view.state.selection.from;
    const handled = view.someProp('handleTextInput', (f) => f(view, from, from, ch, () => view.state.tr.insertText(ch, from, from)));
    if (!handled) view.dispatch(view.state.tr.insertText(ch, from));
  }
}

function bump(o: Oracle, name: string): void {
  o.ops[name] = (o.ops[name] ?? 0) + 1;
}

/** One random local edit on a peer. Tokens are unique per seed so the
 *  oracle can count them; structure ops are the heading-id/loss
 *  minting doors (Enter mid-tag, moves, id-carrying pastes, splits). */
function applyOp(view: EditorView, rnd: () => number, o: Oracle, seed: number, agnostic = false): string {
  if (WITH_UNDO && UNDO_OPS && !agnostic) {
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
      const idsBefore = headingIds(view.state.doc);
      const blockedBefore = o.ops['undoBlocked'] ?? 0;
      const ran = cmd(view.state, (tr) => view.dispatch(tr), view);
      if (ran) {
        const idsNow = new Set(headingIds(view.state.doc));
        o.pendingUndoCheck = { removed: idsBefore.filter((id) => !idsNow.has(id)), peer: peerIndexOf(o), blockedBefore };
      }
      if (process.env['FUZZ_UNDO_PROBE'] && (o.ops['undoProbe'] ?? 0) < 6) { o.ops['undoProbe'] = (o.ops['undoProbe'] ?? 0) + 1; const um = undoManagers.get(view); console.log(`[undo-probe] via=${g ? 'guard' : 'raw'} isUndo=${isUndo} ran=${ran} canUndo=${um?.canUndo()} canRedo=${um?.canRedo()} peerNow=${peerAtOp.get(view)?.()} peerAtCreate=${peerAtCreate.get(view)}`); }
      if (!ran) return 'skip';
      const after = tokensIn(view.state.doc);
      for (const t of before) if (!after.has(t)) { o.deleted.add(t); o.heads.delete(t); o.history.get(t)?.push(`${isUndo ? 'undone' : 'redone-away'} ${o.where}`); }
      for (const t of after) if (!before.has(t)) { o.deleted.delete(t); if (t.startsWith('«hd')) o.heads.add(t); else o.inserted.add(t); o.history.get(t)?.push(`${isUndo ? 'undo-restored' : 'redone'} ${o.where}`); }
      bump(o, isUndo ? 'undo' : 'redo');
      return isUndo ? 'undo' : 'redo';
    }
  }
  // An old-tree peer's view has a different schema instance: only ops
  // that never touch this tree's schema objects (text, splits, moves,
  // cut+paste) are safe there; the roll is steered into those branches.
  const roll = agnostic ? [0.2, 0.4, 0.6, 0.7, 0.78][Math.floor(rnd() * 5)]! : rnd();
  const doc = view.state.doc;
  let name = 'none';
  try {
    if (WITH_COMMENTS && roll < 0.06) {
      // comment threads: add over a token, reply, toggle resolved
      const threads = getCommentsState(view.state).threads;
      const known = [...threads.keys()].filter((id) => o.threads.has(id));
      const sub = rnd();
      const stamp = (n: number): string => `2026-09-04T10:${String(n % 60).padStart(2, '0')}:00Z`;
      const mk = (id: string, text: string, parentId: string | null): Comment => ({ id, author: 'Fuzz', initials: 'F', date: stamp(o.next), text, kind: 'human', parentId });
      if (sub < 0.5 || known.length === 0) {
        const present = [...o.inserted].filter((t) => !o.deleted.has(t) && findToken(doc, t));
        if (present.length === 0) return 'skip';
        const t = present[Math.floor(rnd() * present.length)]!;
        const r = findToken(doc, t)!;
        const id = `c${seed}_${o.next++}`;
        view.dispatch(view.state.tr.addMark(r.from, r.to, schema.marks['comment_range']!.create({ threadId: id })).setMeta(commentsKey, addThreadMeta({ id, comments: [mk(id, `about ${t}`, null)] })));
        o.threads.set(id, new Set());
        o.markTouched.add(t);
        name = 'commentAdd';
        bump(o, 'commentAdd');
      } else if (sub < 0.8) {
        const id = known[Math.floor(rnd() * known.length)]!;
        const rid = `c${seed}_${o.next++}`;
        view.dispatch(view.state.tr.setMeta(commentsKey, addReplyMeta(id, mk(rid, `reply ${rid}`, id))));
        o.threads.get(id)!.add(rid);
        name = 'commentReply';
        bump(o, 'commentReply');
      } else {
        const id = known[Math.floor(rnd() * known.length)]!;
        const cur = threads.get(id)?.comments[0]?.resolved === true;
        view.dispatch(view.state.tr.setMeta(commentsKey, setResolvedMeta(id, !cur)));
        name = 'commentResolve';
        bump(o, 'commentResolve');
      }
    } else if (roll < 0.14 && !NO_CUTINPLACE && !agnostic) {
      // cut in place: mark a whole card now; a later op pastes it (a MOVE)
      const pending = pendingCut(view.state);
      const cards = topCards(doc);
      if (pending) {
        const dst = cards[Math.floor(rnd() * cards.length)]!;
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, Math.min(dst.pos + 2, view.state.doc.content.size))));
        handleCutInPlacePaste(view, cutHtml.get(view) ?? '');
        name = 'cutInPlacePaste';
        bump(o, 'cutInPlacePaste');
      } else {
        if (cards.length < 2) return 'skip';
        const src = cards[Math.floor(rnd() * cards.length)]!;
        touch(o, doc, src.pos + 1);
        lastCutHtml = '';
        void markCutInPlace(view, [{ from: src.pos, to: src.pos + src.node.nodeSize }]);
        cutHtml.set(view, lastCutHtml);
        name = 'cutInPlaceMark';
        bump(o, 'cutInPlaceMark');
      }
    } else if (roll < 0.34) {
      // insert a tracked token inside a body textblock
      const bodies = textblocks(doc).filter((t) => t.node.type.name === 'card_body' || t.node.type.name === 'paragraph');
      if (bodies.length === 0) return 'skip';
      const tb = bodies[Math.floor(rnd() * bodies.length)]!;
      const astral = rnd() < 0.25 ? ASTRAL[Math.floor(rnd() * ASTRAL.length)]! : '';
      const token = `«tk${seed}_${o.next++}${astral}»`;
      // 30%: land INSIDE a marked run — typing there inherits the marks.
      let pos: number | null = null;
      if (rnd() < 0.3) {
        const runs: Array<{ from: number; to: number }> = [];
        doc.nodesBetween(tb.start, tb.end, (n, p) => {
          if (n.isText && n.text && n.text.length >= 3 && !n.text.includes('«') && n.marks.some((m) => m.type.name !== 'comment_range')) runs.push({ from: p, to: p + n.text.length });
          return true;
        });
        if (runs.length) {
          const r = runs[Math.floor(rnd() * runs.length)]!;
          pos = r.from + 1 + Math.floor(rnd() * (r.to - r.from - 2));
        }
      }
      if (pos === null) {
        const offs = safeOffsets(tb.node.textContent);
        pos = tb.start + offs[Math.floor(rnd() * offs.length)]!;
      }
      view.dispatch(view.state.tr.insertText(` ${token} `, pos));
      o.inserted.add(token);
      o.history.set(token, [`born ${o.where}`]);
      const born = findToken(view.state.doc, token);
      if (born) o.birthMarks.set(token, marksAt(view.state.doc, born.from, born.to));
      const bc = containerHeadId(doc, pos);
      if (bc) o.birthContainer.set(token, bc);
      touch(o, doc, pos);
      name = 'insertToken';
      bump(o, 'insertToken');
    } else if (roll < 0.44) {
      // delete a whole tracked token that this peer currently sees
      const present = [...o.inserted].filter((t) => !o.deleted.has(t) && findToken(doc, t));
      if (present.length === 0) return 'skip';
      const token = present[Math.floor(rnd() * present.length)]!;
      const r = findToken(doc, token)!;
      touch(o, doc, r.from);
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
      touch(o, doc, t.start);
      enterMidTag(view.state, (tr) => view.dispatch(tr));
      touch(o, view.state.doc, t.start);
      name = 'enterMidTag';
      bump(o, 'enterMidTag');
    } else if (roll < 0.68) {
      // split a body paragraph
      const bodies = textblocks(doc).filter((t) => t.node.type.name === 'card_body' && t.end - t.start > 2);
      if (bodies.length === 0) return 'skip';
      const tb = bodies[Math.floor(rnd() * bodies.length)]!;
      const offs = safeOffsets(tb.node.textContent).filter((o2) => o2 > 0 && o2 < tb.end - tb.start);
      if (offs.length === 0) return 'skip';
      touch(o, doc, tb.start);
      view.dispatch(view.state.tr.split(tb.start + offs[Math.floor(rnd() * offs.length)]!));
      name = 'splitBody';
      bump(o, 'splitBody');
    } else if (roll < 0.76 && !NO_MOVE) {
      // move a top-level card to another top-level slot (content preserved)
      const cards = topCards(doc);
      if (cards.length < 2) return 'skip';
      const src = cards[Math.floor(rnd() * cards.length)]!;
      const others = cards.filter((c) => c.index !== src.index);
      const dst = others[Math.floor(rnd() * others.length)]!;
      const tr = view.state.tr.delete(src.pos, src.pos + src.node.nodeSize);
      const insertAt = tr.mapping.map(dst.pos + (rnd() < 0.5 ? 0 : dst.node.nodeSize));
      tr.insert(insertAt, src.node);
      touch(o, doc, src.pos + 1);
      view.dispatch(tr);
      name = 'moveCard';
      bump(o, 'moveCard');
    } else if (roll < 0.8 && !NO_MOVE && !NO_CUTPASTE) {
      // cut + paste of a whole card as TWO transactions (Cmd-X … Cmd-V) the
      // way a SOLO document or an old client does it: the binding sees a
      // delete batch, then an insert batch — with FRESH ids, as the app's
      // paste stamps (the head TOKEN still duplicates against a partner's
      // concurrent move; the id does not). In a session, new clients cut
      // in place instead (a move) — see the cutInPlace op.
      const cards = topCards(doc);
      if (cards.length < 2) return 'skip';
      const src = cards[Math.floor(rnd() * cards.length)]!;
      for (const t of tokensIn(src.node)) o.cutPasted.add(t);
      const cutHead = containerHeadId(doc, src.pos + 1);
      if (cutHead) o.cutCards.add(cutHead);
      touch(o, doc, src.pos + 1);
      view.dispatch(view.state.tr.delete(src.pos, src.pos + src.node.nodeSize));
      const now = topCards(view.state.doc);
      const dst = now[Math.floor(rnd() * now.length)]!;
      const at = dst.pos + (rnd() < 0.5 ? 0 : dst.node.nodeSize);
      view.dispatch(view.state.tr.insert(at, freshHeadingIds(new Slice(Fragment.from(src.node), 0, 0)).content));
      name = 'cutPaste';
      bump(o, 'cutPaste');
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
      touch(o, view.state.doc, at + 1);
      name = 'pasteDupId';
      bump(o, 'pasteDupId');
    } else if (roll < 0.94 || (roll < 0.88 && process.env['FUZZ_NO_DUPPASTE'] === '1')) {
      // fresh card with a tracked token
      const token = `«tk${seed}_${o.next++}»`;
      const head = `«hd${seed}_${o.next++}»`;
      const card = cardNode(`Fresh ${Math.floor(rnd() * 1000)} ${head}`, [`new ${token} body`]);
      const endPos = view.state.doc.content.size;
      view.dispatch(view.state.tr.insert(endPos, card));
      touch(o, view.state.doc, endPos + 1);
      o.inserted.add(token);
      o.heads.add(head);
      o.history.set(token, [`born ${o.where} (card)`]);
      name = 'insertCard';
      bump(o, 'insertCard');
    } else if (roll < 0.97 || !WITH_AUTOCORRECT) {
      // a mark over a short run (the causal-heal family)
      const tbs = textblocks(doc).filter((t) => t.end - t.start > 3);
      if (tbs.length === 0) return 'skip';
      const tb = tbs[Math.floor(rnd() * tbs.length)]!;
      const from = tb.start + Math.floor(rnd() * (tb.end - tb.start - 2));
      const to = Math.min(tb.end, from + 1 + Math.floor(rnd() * 6));
      const mark = rnd() < 0.5 ? schema.marks['highlight']!.create() : schema.marks['underline_mark']!.create();
      for (const t of tokensIn(doc)) {
        const r = findToken(doc, t);
        if (r && r.from < to && from < r.to) o.markTouched.add(t);
      }
      touch(o, doc, from);
      view.dispatch(view.state.tr.addMark(from, to, mark));
      name = 'mark';
      bump(o, 'mark');
    } else {
      // keyboard typing through the autocorrect family: a sentence end
      // (auto-capitalize), a custom autocorrect entry, smart quotes and a
      // custom dash — each rule rewrites text the exact-op path just
      // synced, inside the same batch or the next.
      const tbs = textblocks(doc).filter((t) => t.node.type.name === 'tag' || t.node.type.name === 'card_body');
      if (tbs.length === 0) return 'skip';
      const tb = tbs[Math.floor(rnd() * tbs.length)]!;
      const phrases = [' lorem. ipsum', ' teh end', ' say "hi" now', ' a--b', ' asap. fine'];
      touch(o, doc, tb.start);
      typeChars(view, tb.end, phrases[Math.floor(rnd() * phrases.length)]!);
      name = 'typeChars';
      bump(o, 'typeChars');
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
    const k0 = JSON.stringify(ds[0]!.toJSON());
    if (ds.every((d) => JSON.stringify(d.toJSON()) === k0)) return true;
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
      const oldMods = OLD_PEER_DIR ? await loadOldMods(OLD_PEER_DIR) : null;
      if (oldMods) console.log(`[chaos-fuzz] old peer: p1 from ${OLD_PEER_DIR} (binding reconcile in that tree: ${oldMods.hasReconcile ? 'yes' : 'no'})`);
      if (WITH_AUTOCORRECT) {
        settings.set('autoCapitalizeSentences', true);
        settings.set('customAutocorrectEnabled', true);
        settings.set('customAutocorrects', [{ from: 'teh', to: 'the' }, { from: 'asap', to: 'as soon as possible' }]);
        settings.set('smartQuotes', true);
        settings.set('customDashEnabled', true);
      }
      const proxy = new ChaosProxy(PROXY_PORT, RELAY_PORT);
      await proxy.listen();
      const reports: SeedReport[] = [];
      try {
        for (let seed = SEED_START; seed < SEED_START + SEEDS; seed++) {
          const rnd = mulberry32(seed);
          const report: SeedReport = { seed, ok: true, chaos: [], ops: {}, problems: [] };
          const oracle: Oracle = { inserted: new Set(), deleted: new Set(), heads: new Set(), next: 0, ops: report.ops, trail: [], history: new Map(), where: '', birthMarks: new Map(), markTouched: new Set(), touchedBy: new Map(), cutPasted: new Set(), birthContainer: new Map(), cutCards: new Set(), pendingUndoCheck: null, notes: [], threads: new Map() };
          const opTimes: number[] = [];
          const timings: Record<string, number> = {};
          const textSync = (globalThis as { __CM_TEXT_SYNC_STATS__?: { exact: number; mismatch: number; diffBatches: number } }).__CM_TEXT_SYNC_STATS__;
          const textSyncBefore = textSync ? { ...textSync } : null;
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
            buildCutInPlacePlugin(),
            headingIdGuardPlugin,
            cardNumberingPlugin,
            ...(WITH_AUTOCORRECT ? [smartQuotesPlugin(), customDashPlugin(), customAutocorrectPlugin(), autoCapitalizePlugin()] : []),
            ...s.plugins(),
            ...undoPlugins,
            ...(NO_HEAL
              ? []
              : [
                  collabInvariantHealPlugin(),
                  causalMarkHealPlugin(s.loroDoc),
                  collabRepairPlugin(() => lowestPeerIsLeader(s.loroDoc.peerIdStr, peerIds)),
                ]),
            ...(commentsOf.get(s) ? [commentsPlugin, commentsOf.get(s)!.plugin] : []),
            ...(cursorsOf.get(s)?.plugins() ?? []),
            ];
          };
          /** mkView + bind the session's undo guard to the new view. */
          const viewFor = (s: CollabSession): EditorView => {
            const ref = { current: null as EditorView | null };
            viewRefs.set(s, ref);
            if (WITH_COMMENTS) commentsOf.set(s, installCommentsSync(s.loroDoc, () => ref.current));
            if (WITH_PRESENCE) cursorsOf.set(s, installCursorPresence(s, () => ref.current));
            const v = mkView(plugsFor(s));
            ref.current = v;
            docKeys.set(v, `rig-doc-${++docKeySeq}`);
            commentsOf.get(s)?.pull();
            // The cursor plugin publishes a local cursor only while the view
            // has focus, which jsdom never grants a contenteditable: stub it
            // (as collab-cursors.test.ts does) and seed one selection so
            // every peer has a presence state to announce and re-announce.
            (v as unknown as { hasFocus: () => boolean }).hasFocus = () => true;
            if (WITH_PRESENCE && v.state.doc.content.size > 2) v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1)));
            const g = pendingGuards.get(s);
            const um = pendingUms.get(s);
            if (um) { undoManagers.set(v, um); peerAtCreate.set(v, s.loroDoc.peerIdStr); peerAtOp.set(v, () => s.loroDoc.peerIdStr); }
            if (g) {
              viewRef.current = v;
              guards.set(v, g);
            }
            return v;
          };

          const peers: Array<{ session: CollabSession; view: EditorView; stopped: boolean; old?: boolean }> = [];
          const mkOldClient = () =>
            oldMods
              ? new oldMods.RoomsClient({
                  baseUrl: () => `http://127.0.0.1:${PROXY_PORT}/relay`,
                  token: () => TOKEN,
                  requestTimeoutMs: 2500,
                  postTimeoutMs: 4000,
                })
              : null;
          const cursorsOf = new Map<CollabSession, CursorsHandle>();
          const commentsOf = new Map<CollabSession, CommentsSyncHandle>();
          const viewRefs = new Map<CollabSession, { current: EditorView | null }>();
          /** Session callbacks that route presence frames into the (later
           *  installed) cursors handle, as collab-ui does. */
          const withPresence = (h: { s: CollabSession | null }) => ({
            callbacks: { onPresence: (b: Uint8Array) => { if (h.s) cursorsOf.get(h.s)?.applyRemote(b); } },
          });
          const disposeHandles = (sess: CollabSession): void => {
            cursorsOf.get(sess)?.dispose();
            commentsOf.get(sess)?.dispose();
            cursorsOf.delete(sess);
            commentsOf.delete(sess);
          };
          /** Wait until predicate holds on every partner or the deadline passes. */
          const rosterWait = async (pred: () => boolean, ms: number): Promise<boolean> => {
            const t0 = Date.now();
            while (Date.now() - t0 < ms) {
              if (pred()) return true;
              await sleep(60);
            }
            return pred();
          };
          /** The old tree's view: its own mkView, plugins, cursors and
           *  comments (handles land in the same maps; the session object is
           *  the key). No undo plugins, no autocorrect family. */
          const viewForOld = (s: CollabSession): EditorView => {
            const om = oldMods!;
            const ref = { current: null as EditorView | null };
            viewRefs.set(s, ref);
            if (WITH_COMMENTS) commentsOf.set(s, om.installCommentsSync(s.loroDoc, () => ref.current));
            if (WITH_PRESENCE) cursorsOf.set(s, om.installCursorPresence(s, () => ref.current));
            const v = om.mkView([
              om.headingIdGuardPlugin,
              om.cardNumberingPlugin,
              ...s.plugins(),
              ...(NO_HEAL ? [] : [om.collabInvariantHealPlugin(), om.causalMarkHealPlugin(s.loroDoc), om.collabRepairPlugin(() => om.lowestPeerIsLeader(s.loroDoc.peerIdStr, peerIds))]),
              ...(commentsOf.get(s) ? [om.commentsPlugin, commentsOf.get(s)!.plugin] : []),
              ...(cursorsOf.get(s)?.plugins() ?? []),
            ]);
            ref.current = v;
            commentsOf.get(s)?.pull();
            (v as unknown as { hasFocus: () => boolean }).hasFocus = () => true;
            if (WITH_PRESENCE && v.state.doc.content.size > 2) v.dispatch(v.state.tr.setSelection(om.TextSelection.create(v.state.doc, 1)));
            return v;
          };
          const hostRef = { s: null as CollabSession | null };
          const tHost = Date.now();
          const { session: host, shareCode } = await CollabSession.host({ pmDoc: seedDoc(seed, oracle.heads), client: mkClient(), ...OPTS, ...withPresence(hostRef) });
          hostRef.s = host;
          timings['hostMs'] = Date.now() - tHost;
          const decoded = decodeShareCode(shareCode)!;
          peers.push({ session: host, view: viewFor(host), stopped: false });
          peerIds.push(host.loroDoc.peerIdStr);
          await settle();
          host.start();
          for (let p = 1; p < PEERS; p++) {
            const jRef = { s: null as CollabSession | null };
            const tJoin = Date.now();
            const isOld = !!oldMods && p === 1;
            const j = isOld
              ? await oldMods!.CollabSession.join({ ...decoded, client: mkOldClient()!, ...OPTS, ...withPresence(jRef) })
              : await CollabSession.join({ ...decoded, client: mkClient(), ...OPTS, ...withPresence(jRef) });
            jRef.s = j;
            timings['joinMs'] = Math.max(timings['joinMs'] ?? 0, Date.now() - tJoin);
            peers.push({ session: j, view: isOld ? viewForOld(j) : viewFor(j), stopped: false, old: isOld });
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
                const presentBefore = [...tokensIn(peers[p]!.view.state.doc)].filter((t) => oracle.inserted.has(t));
                const tOp = performance.now();
                const name = applyOp(peers[p]!.view, rnd, oracle, seed, peers[p]!.old === true);
                if (name !== 'skip') opTimes.push(performance.now() - tOp);
                // A token this peer could see that is gone right after its
                // own op (and the op did not delete it) names the door.
                {
                  const now = tokensIn(peers[p]!.view.state.doc);
                  for (const t of presentBefore) if (!now.has(t) && !oracle.deleted.has(t)) oracle.history.get(t)?.push(`VANISHED-after ${name} ${oracle.where}`);
                  // A token born by this op: is it in this peer's PM doc AND its Loro doc?
                  for (const t of oracle.inserted) {
                    if (presentBefore.includes(t) || (oracle.history.get(t)?.length ?? 0) !== 1) continue;
                    const inLoro = JSON.stringify(peers[p]!.session.loroDoc.toJSON()).includes(t);
                    oracle.history.get(t)?.push(`after-birth pm=${now.has(t) ? 'y' : 'n'} loro=${inLoro ? 'y' : 'n'}`);
                  }
                }
                if (name === 'undo' || name === 'redo') await settle(2);
                if (oracle.pendingUndoCheck) {
                  const c = oracle.pendingUndoCheck;
                  oracle.pendingUndoCheck = null;
                  if ((report.ops['undoBlocked'] ?? 0) > c.blockedBefore) {
                    const partnerTouched = c.removed.some((id) => [...(oracle.touchedBy.get(id) ?? [])].some((pp) => pp !== c.peer));
                    if (!partnerTouched) {
                      bump(oracle, 'undoFalseBlock');
                      oracle.notes.push(`undo FALSE BLOCK ${oracle.where}: removed [${c.removed.join(' ')}] — no partner op ever targeted them (rig ledger)`);
                    }
                  }
                }
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
            // First round in which a HEAD TOKEN shows twice on any peer: the
            // op window since the previous round is the residual's door.
            if (!report.problems.some((x) => x.startsWith('HEAD DUP first seen'))) {
              for (let p = 0; p < peers.length; p++) {
                const d = peers[p]!.view.state.doc;
                const dupHeadsNow = [...oracle.heads].filter((t) => countToken(d, t) > 1);
                if (dupHeadsNow.length) {
                  const tagsFor = (t: string): string[] => { const out: string[] = []; d.descendants((n) => { if (HEADING_TYPES.has(n.type.name) && n.textContent.includes(t)) out.push(`${n.type.name}#${String(n.attrs['id']).slice(0, 8)}:"${n.textContent.slice(0, 40)}"`); return !HEADING_TYPES.has(n.type.name); }); return out; };
                  report.problems.push(`HEAD DUP first seen r${round} p${p}: ${dupHeadsNow.map((t) => `${t} in [${tagsFor(t).join(' | ')}]`).join('; ')}\n      ops this round: ${oracle.trail.filter((x) => x.startsWith(`r${round}p`) && !x.endsWith(':skip')).join(' ')}`);
                  break;
                }
              }
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
              // (never the old-tree peer: its resume is that tree's, not ours)
              const fresh = peers.map((x, i) => i).filter((i) => !peers[i]!.old);
              const p = fresh[Math.floor(rnd() * fresh.length)]!;
              const old = peers[p]!;
              report.chaos.push(`r${round}:resume(p${p})`);
              const snapshot = old.session.exportSnapshot();
              const meta = old.session.persistMeta();
              (cursorsOf.get(old.session) as (CursorsHandle & { farewell?: () => void }) | undefined)?.farewell?.(); // the app's quit path says goodbye
              await old.session.stop();
              disposeHandles(old.session);
              old.view.destroy();
              const rRef = { s: null as CollabSession | null };
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
                ...withPresence(rRef),
              });
              rRef.s = resumed;
              peerIds[p] = resumed.loroDoc.peerIdStr;
              peers[p] = { session: resumed, view: viewFor(resumed), stopped: false };
              await settle();
              resumed.start();
            } else if (c < 0.8) {
              const p = Math.floor(rnd() * peers.length);
              report.chaos.push(`r${round}:restart(p${p})`);
              peers[p]!.session.restart();
            } else if (c < 0.9 && WITH_PRESENCE) {
              // leave (farewell + stop) → partners drop the caret at once;
              // come back (start + rebroadcast) → partners list it again.
              const p = Math.floor(rnd() * peers.length);
              const me = peers[p]!;
              const myId = me.session.loroDoc.peerIdStr;
              const partners = peers.filter((x) => x !== me);
              report.chaos.push(`r${round}:leave-rejoin(p${p})`);
              const handle = cursorsOf.get(me.session) as (CursorsHandle & { farewell?: () => void; rebroadcast?: () => void }) | undefined;
              handle?.farewell?.();
              await me.session.stop();
              me.stopped = true;
              const gone = await rosterWait(() => partners.every((x) => !cursorsOf.get(x.session)!.presence().some((e) => e.peer === myId)), 2000);
              if (!gone) {
                if (me.old) oracle.notes.push(`old-tree p${p} leaves with no departure frame (pre-1.7.0 behavior): partners keep its caret until expiry`);
                else report.problems.push(`PRESENCE: p${p} still listed by a partner 2s after leaving (r${round})`);
              }
              await sleep(100 + Math.floor(rnd() * 300));
              me.session.start();
              me.stopped = false;
              handle?.rebroadcast?.();
              const back = await rosterWait(() => partners.every((x) => cursorsOf.get(x.session)!.presence().some((e) => e.peer === myId)), 3000);
              if (!back) {
                if (me.old) oracle.notes.push(`old-tree p${p} rejoined without a re-announce (pre-1.7.0): partners list it on its next cursor frame`);
                else report.problems.push(`PRESENCE: p${p} not re-announced to every partner 3s after rejoining (r${round})`);
              }
            } else if (c < 0.9) {
              /* presence disabled: nothing this round */
            } else {
              // wake burst: powerResumed + online + visible land a beat
              // apart; the restart debounce must fold them into ONE
              // reconnect, and a tab-hide flushes the outbound queue.
              const p = Math.floor(rnd() * peers.length);
              report.chaos.push(`r${round}:wake-burst(p${p})`);
              const setVis = (v: 'hidden' | 'visible'): void => {
                Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
                document.dispatchEvent(new Event('visibilitychange'));
              };
              setVis('hidden');
              await sleep(20);
              setVis('visible');
              for (let k = 0; k < 3; k++) {
                peers[p]!.session.restart();
                await sleep(15);
              }
            }
            if (LONG_OUTAGE_MS > 0 && round === Math.floor(ROUNDS / 2)) {
              // one long blackhole while everyone keeps typing; rows counted at the end
              report.chaos.push(`r${round}:long-outage(${LONG_OUTAGE_MS}ms)`);
              timings['outageSeqBefore'] = Math.max(...peers.map((x) => x.session.debugState().lastSeq));
              proxy.mode = 'blackhole';
              proxy.cutAll();
              const t0 = Date.now();
              let edits = 0;
              while (Date.now() - t0 < LONG_OUTAGE_MS) {
                for (let p = 0; p < peers.length; p++) {
                  oracle.where = `r${round}o${p}`;
                  const bodies = textblocks(peers[p]!.view.state.doc).filter((t) => t.node.type.name === 'card_body');
                  if (!bodies.length) continue;
                  const tb = bodies[Math.floor(rnd() * bodies.length)]!;
                  const offs = safeOffsets(tb.node.textContent);
                  const token = `«tk${seed}_${oracle.next++}»`;
                  peers[p]!.view.dispatch(peers[p]!.view.state.tr.insertText(` ${token} `, tb.start + offs[Math.floor(rnd() * offs.length)]!));
                  oracle.inserted.add(token);
                  oracle.history.set(token, [`born ${oracle.where} (outage)`]);
                  edits++;
                }
                await sleep(250);
              }
              timings['outageEdits'] = edits;
              proxy.mode = 'ok';
              proxy.cutAll();
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
          const tConv = Date.now();
          const converged = await waitForConvergence(() => peers.map((p) => p.view.state.doc), 30_000);
          timings['convergeMs'] = Date.now() - tConv;
          if (!converged) {
            report.ok = false;
            report.problems.push('peers did not converge in 30s');
          }

          if (LONG_OUTAGE_MS > 0 && timings['outageSeqBefore'] !== undefined) {
            try {
              let after = timings['outageSeqBefore']!;
              let rows = 0;
              for (let page = 0; page < 50; page++) {
                const r = await mkClient().fetchUpdates(decoded.roomId, after);
                rows += r.updates.length;
                if (!r.more || r.lastSeq <= after) break;
                after = r.lastSeq;
              }
              timings['outageRowsAfter'] = rows;
              oracle.notes.push(`long outage: ${timings['outageEdits']} edits across ${peers.length} peers became ${rows} relay rows from seq ${timings['outageSeqBefore']} on (later rounds included)`);
            } catch (e) {
              oracle.notes.push(`long outage row count failed: ${(e as Error).message}`);
            }
          }
          if (WITH_PRESENCE) {
            // Everyone online again: each peer's roster must show every other
            // live peer (keepalives re-announce within 15s in the app; the
            // rig's ops broadcast on every transaction).
            for (const x of peers) (cursorsOf.get(x.session) as (CursorsHandle & { rebroadcast?: () => void }) | undefined)?.rebroadcast?.();
            const liveIds: string[] = peers.map((x) => x.session.loroDoc.peerIdStr);
            const full = await rosterWait(() => peers.every((x) => liveIds.filter((id) => id !== x.session.loroDoc.peerIdStr).every((id) => cursorsOf.get(x.session)!.presence().some((e) => e.peer === id))), 4000);
            if (!full) {
              report.ok = false;
              report.problems.push(`PRESENCE roster incomplete after convergence: ${peers.map((x, i) => `p${i} sees [${cursorsOf.get(x.session)!.presence().filter((e) => !e.self).map((e) => liveIds.indexOf(e.peer) >= 0 ? `p${liveIds.indexOf(e.peer)}` : e.peer.slice(0, 6)).join(' ')}]`).join('; ')}`);
            }
          }
          if (WITH_COMMENTS && oracle.threads.size) {
            const views = peers.map((x, i) => [`p${i}`, (x.old ? oldMods!.getCommentsState : getCommentsState)(x.view.state).threads] as const);
            const sig = (m: Map<string, { comments: Comment[] }>): string => JSON.stringify([...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, t]) => [id, t.comments.map((c) => [c.id, c.text, c.resolved === true])]));
            const sigs = views.map(([, m]) => sig(m));
            if (new Set(sigs).size > 1) {
              report.ok = false;
              report.problems.push(`COMMENTS diverged across peers: ${views.map(([l, m]) => `${l}=${m.size} threads`).join(' ')}`);
            }
            const m0 = views[0]![1];
            const missing = [...oracle.threads.keys()].filter((id) => !m0.has(id));
            const missingReplies = [...oracle.threads.entries()].flatMap(([id, rs]) => [...rs].filter((rid) => !m0.get(id)?.comments.some((c) => c.id === rid)).map((rid) => `${id}/${rid}`));
            if (missing.length || missingReplies.length) {
              report.ok = false;
              report.problems.push(`COMMENTS lost: threads [${missing.join(' ')}] replies [${missingReplies.join(' ')}]`);
            }
          }
          if (opTimes.length) {
            report.ops['opP50Ms'] = Math.round(percentile(opTimes, 0.5) * 10) / 10;
            report.ops['opP95Ms'] = Math.round(percentile(opTimes, 0.95) * 10) / 10;
            report.ops['opMaxMs'] = Math.round(percentile(opTimes, 1) * 10) / 10;
          }
          for (const [k, v] of Object.entries(timings)) report.ops[k] = v;
          if (SCALE_OP_P95_MS > 0 && (report.ops['opP95Ms'] ?? 0) > SCALE_OP_P95_MS) {
            report.ok = false;
            report.problems.push(`op p95 ${report.ops['opP95Ms']}ms exceeds FUZZ_SCALE_OP_P95_MS=${SCALE_OP_P95_MS}`);
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
            disposeHandles(fresh);
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
          const lostAll = expected.filter((t) => countToken(final, t) === 0);
          const viaCut = (t: string): boolean => oracle.cutPasted.has(t) || oracle.cutCards.has(oracle.birthContainer.get(t) ?? '');
          const lost = lostAll.filter((t) => !viaCut(t));
          const lostCutPaste = lostAll.filter(viaCut);
          const duplicated = expected.filter((t) => countToken(final, t) > 1);
          const resurrectedAll = [...oracle.deleted].filter((t) => countToken(final, t) > 0);
          const resurrected = resurrectedAll.filter((t) => !viaCut(t));
          const resurrectedCut = resurrectedAll.filter(viaCut);
          if (resurrectedCut.length) {
            report.ops['cutPasteResurrect'] = (report.ops['cutPasteResurrect'] ?? 0) + resurrectedCut.length;
            oracle.notes.push(`cut+paste brought back a partner's concurrent delete (delete+create, expected): ${resurrectedCut.join(', ')}`);
          }
          if (lost.length) {
            report.ok = false;
            report.problems.push(`LOST content (never deleted): ${lost.map((t) => `${t} [${(oracle.history.get(t) ?? []).join(' ')}] chaos=[${report.chaos.join(' ')}]`).join('; ')}`);
          }
          if (lostCutPaste.length) {
            report.ops['cutPasteLoss'] = (report.ops['cutPasteLoss'] ?? 0) + lostCutPaste.length;
            oracle.notes.push(`cut+paste dropped a partner's concurrent edit (delete+create, expected): ${lostCutPaste.join(', ')}`);
          }
          // Marks a token was typed with must survive (unless a later mark
          // op overlapped it — then the schema's exclusions may legitimately
          // have replaced one).
          const markLoss: string[] = [];
          for (const [t, born] of oracle.birthMarks) {
            if (!born.length || oracle.markTouched.has(t) || countToken(final, t) !== 1) continue;
            const r = findToken(final, t)!;
            const now = marksAt(final, r.from, r.to);
            const missing = born.filter((m) => !now.includes(m));
            if (missing.length) markLoss.push(`${t} born [${born.join(',')}] now [${now.join(',')}]`);
          }
          if (markLoss.length) {
            report.ok = false;
            report.problems.push(`MARKS lost on typed text: ${markLoss.join('; ')}`);
          }
          const clashes = markClashes(final);
          if (clashes.length) {
            report.ok = false;
            report.problems.push(`exclusive-mark clash survived the session: ${clashes.slice(0, 4).join('; ')}`);
          }
          const hollow = hollowContainers(final);
          if (hollow.length) {
            report.ok = false;
            report.problems.push(`hollow containers: ${hollow.join('; ')}`);
          }
          for (const shape of tableShapes(final)) {
            if (new Set(shape).size > 1) {
              report.ok = false;
              report.problems.push(`ragged table: rows ${shape.join('/')}`);
            }
          }
          if (textSync && textSyncBefore) {
            const d = { exact: textSync.exact - textSyncBefore.exact, mismatch: textSync.mismatch - textSyncBefore.mismatch, diffBatches: textSync.diffBatches - textSyncBefore.diffBatches };
            report.ops['textExact'] = d.exact;
            report.ops['textDiffBatches'] = d.diffBatches;
            if (d.mismatch > 0) {
              report.ok = false;
              report.problems.push(`exact text ops MISMATCHED the PM text ${d.mismatch}× (classifier bug; fell back to the diff)`);
            }
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
            `[chaos-fuzz] seed ${seed}: ${report.ok ? 'OK ' : 'FAIL'} format=${host.childrenFormat()}${oldMods ? ' mixed=p1-old' : ''} tokens=${expected.length} heads=${oracle.heads.size} ids=${headingIds(final).length} chaos=[${report.chaos.join(' ')}]` +
              (report.ok ? '' : `\n    ${report.problems.join('\n    ')}`) +
              (oracle.notes.length ? `\n    note: ${oracle.notes.join('\n    note: ')}` : ''),
          );
          console.log(`[chaos-fuzz] seed ${seed} ops: ${Object.entries(report.ops).map(([k, v]) => `${k}=${v}`).join(' ')}`);

          if (WITH_UNDO && UNDO_GUARD) console.log(`[chaos-fuzz] seed ${seed} undo-guard stats: ${peers.map((p, i) => { const g = guards.get(p.view); return `p${i}=${g ? `${g.stats.allowed}a/${g.stats.blocked}b/${g.stats.unrecoverable}u` : 'NO-GUARD'}`; }).join(' ')} undoOps=${report.ops['undo'] ?? 0}/${report.ops['redo'] ?? 0}`);
          for (const p of peers) {
            (cursorsOf.get(p.session) as (CursorsHandle & { farewell?: () => void }) | undefined)?.farewell?.();
            await p.session.stop().catch(() => {});
            disposeHandles(p.session);
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
