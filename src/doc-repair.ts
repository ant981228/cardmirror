/**
 * Deterministic document repair for structural states ProseMirror never
 * produces locally but external content can: DOCX imports with irregular
 * tables, and merged documents from a sync layer. Pure function of the
 * doc — identical input yields identical repairs everywhere, and the
 * pass is idempotent (a repaired doc yields no further repair).
 *
 * Three passes, in order:
 *   1. prosemirror-tables `fixTables` — pads ragged rows and clamps
 *      colspan overflow so every row spans the same width.
 *   2. `excludes` sweep — text carrying both members of a mutually
 *      exclusive mark pair keeps the earlier-declared mark and drops the
 *      later one. ProseMirror enforces `excludes` in `Mark.addToSet`
 *      (local editing) but not on node construction, so externally built
 *      content can carry both.
 *   3. Container first-child invariant — a `card` must open with `tag`,
 *      an `analytic_unit` with `analytic` (their content expressions
 *      require it, but `NodeType.create` does not validate); an empty
 *      heading is inserted when missing. Heading `id` stamping is left
 *      to `stampMissingHeadingIds` at load: ids are random, and this
 *      pass must stay deterministic.
 */
import { EditorState, type Transaction } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { fixTables } from 'prosemirror-tables';
import { schema } from './schema/index.js';

/** Resolution order for mutually-exclusive marks: on a text node that
 *  (post-merge) carries two marks the schema declares as `excludes`,
 *  the HIGHER-priority one is kept and the other dropped. A single
 *  priority per mark makes the resolution a TOTAL ORDER — it cannot
 *  form a cycle the way a hand-listed pairwise winner-table can, and a
 *  cycle would reintroduce order-dependent (non-converging) repair.
 *  Which pairs actually conflict is read from the schema itself
 *  (`type.excludes`), so this map only needs to rank the participants;
 *  a new exclusive mark is covered by adding its priority.
 *
 *  Order (2026-07-05, user): citation styling is the most structural,
 *  then emphasis, then underline; an explicit bold beats an explicit
 *  bold-off; superscript beats subscript. */
/** A changed region (post-apply coordinates of the state being
 *  repaired). When a caller supplies ranges, every sweep below walks
 *  only nodes intersecting them instead of the whole document. */
export interface RepairRange {
  from: number;
  to: number;
}

/** Walk `tr.doc` either whole or bounded to `ranges` (mapped through
 *  the transaction's steps so far, since earlier sweeps may have
 *  shifted positions). Overlapping ranges can visit a node twice —
 *  callers dedupe by position where a double application would not be
 *  idempotent. */
function walk(
  tr: Transaction,
  ranges: readonly RepairRange[] | undefined,
  cb: (node: PMNode, pos: number, parent: PMNode | null) => boolean | void,
): void {
  if (!ranges) {
    tr.doc.descendants(cb);
    return;
  }
  const size = tr.doc.content.size;
  for (const r of ranges) {
    const from = Math.max(0, Math.min(tr.mapping.map(r.from, -1), size));
    const to = Math.max(from, Math.min(tr.mapping.map(r.to, 1), size));
    if (from >= to) continue;
    tr.doc.nodesBetween(from, to, cb);
  }
}

const MARK_PRIORITY: Readonly<Record<string, number>> = {
  cite_mark: 30,
  emphasis_mark: 20,
  underline_mark: 10,
  bold: 2,
  bold_off: 1,
  superscript: 2,
  subscript: 1,
};

/** Strip the lower-priority member of every present mutually-exclusive
 *  pair from `tr`. Mark-level and deterministic: every peer resolves to
 *  the same winner, so this is safe to run on ALL peers (unlike the
 *  structural repairs) — double-application converges under LWW. */
function sweepExclusiveMarks(tr: Transaction, ranges?: readonly RepairRange[]): void {
  walk(tr, ranges, (node, pos) => {
    if (!node.isText) return true;
    const ranked = node.marks.filter((m) => m.type.name in MARK_PRIORITY);
    for (const m of ranked) {
      const outranked = ranked.some(
        (other) =>
          other !== m &&
          other.type.excludes(m.type) &&
          MARK_PRIORITY[other.type.name]! > MARK_PRIORITY[m.type.name]!,
      );
      if (outranked) tr.removeMark(pos, pos + node.nodeSize, m.type);
    }
    return true;
  });
}

/** Canonicalize display-heal sentinels (see the loro-prosemirror
 *  patch's cardmirrorHealInvalidNode): a head whose id carries the
 *  'crdt-heal-' prefix was synthesized at CRDT materialization and
 *  exists ONLY in this peer's PM doc — the CRDT children list still
 *  lacks the head. Rewriting the id (deterministically — repair must
 *  stay a pure function of the doc) gives the transaction a step on
 *  that node, and the sync layer's diff then writes the whole head
 *  into the CRDT as an ordinary edit. The rewritten prefix no longer
 *  matches, so the pass cannot re-fire on its own output.
 *
 *  Runs on EVERY peer, not just the leader (2026-07-26, mixed-version
 *  hardening): the sooner ANY current-version peer lands the head in
 *  the CRDT, the sooner an old-version peer materializes a valid card
 *  instead of dropping it — and un-gating is safe because concurrent
 *  write-backs merge into duplicate heads that the materializer's
 *  multi-head normalization converges deterministically (and the id
 *  rewrite itself is same-value, so it merges harmlessly). */
function canonicalizeHealSentinels(tr: Transaction, ranges?: readonly RepairRange[]): void {
  walk(tr, ranges, (node, pos) => {
    if (node.type.name !== 'tag' && node.type.name !== 'analytic') return true;
    const id = String(node.attrs['id'] ?? '');
    if (id.startsWith('crdt-heal-')) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, id: 'ch-' + id.slice('crdt-heal-'.length) });
    }
    return false;
  });
}

/** Structural table normalization — the post-detonation heal for the
 *  ragged-table command bug (seed-51 soak find, 2026-08-15): a client
 *  without the table-guard runs `addRowAfter` from a short-row cell of
 *  a RAGGED table (the shape concurrent row+column inserts merge to)
 *  and prosemirror-tables nests an empty table_row INSIDE the trailing
 *  row — and ProseMirror's replace fitter ACCEPTS the schema-invalid
 *  doc. `fixTables` then throws on that state, so this pass must run
 *  before it (and the fixTables call stays guarded regardless).
 *
 *  Deterministic rules: a nested row carrying cells is hoisted to a
 *  sibling row after its container (nothing the user typed is lost);
 *  an EMPTY nested row is dropped — it is the detonation artifact, the
 *  user's intended row is its container; any other illegal child of a
 *  row or table is dropped; a table left with no rows is removed
 *  (its content expression requires one). */
function normalizeTableStructure(tr: Transaction, ranges?: readonly RepairRange[]): void {
  const rowType = schema.nodes['table_row']!;
  const isCell = (n: PMNode): boolean =>
    n.type.name === 'table_cell' || n.type.name === 'table_header';
  const targets: Array<{ pos: number; node: PMNode }> = [];
  const seen = new Set<number>();
  walk(tr, ranges, (node, pos) => {
    if (node.type.name !== 'table') return true;
    if (seen.has(pos)) return false;
    seen.add(pos);
    let dirty = false;
    node.forEach((row) => {
      if (row.type !== rowType) dirty = true;
      row.forEach((c) => {
        if (!isCell(c)) dirty = true;
      });
    });
    if (dirty) targets.push({ pos, node });
    return false;
  });
  // replaceWith shifts positions — apply bottom-up.
  for (const { pos, node } of targets.reverse()) {
    const rows: PMNode[] = [];
    const pushRow = (row: PMNode): void => {
      const cells: PMNode[] = [];
      const nested: PMNode[] = [];
      row.forEach((c) => {
        if (isCell(c)) cells.push(c);
        else if (c.type === rowType) nested.push(c);
        // anything else: dropped
      });
      if (cells.length) rows.push(rowType.createChecked(row.attrs, cells));
      for (const n of nested) pushRow(n);
    };
    node.forEach((row) => {
      if (row.type === rowType) pushRow(row);
      // non-row child of table: dropped
    });
    if (rows.length) {
      tr.replaceWith(
        pos,
        pos + node.nodeSize,
        schema.nodes['table']!.createChecked(node.attrs, rows),
      );
    } else {
      tr.delete(pos, pos + node.nodeSize);
    }
  }
}

/** `fixTables`, but never allowed to take the repair pass down with it:
 *  it throws on structurally-invalid tables (row nested inside row).
 *  With `normalizeTableStructure` running first that state is gone,
 *  but an unforeseen invalid shape must degrade to "tables unpadded
 *  this pass", not "no repair at all". */
function safeFixTables(state: EditorState, oldState?: EditorState): Transaction | null {
  try {
    return fixTables(state, oldState) ?? null;
  } catch {
    return null;
  }
}

/** The all-peer repair half: table-structure normalization +
 *  exclusive-marks resolution + heal-sentinel canonicalization — all
 *  deterministic, unlike the structural table/head insertions in
 *  `buildDocRepairTr`, which stay leader-gated (see collab-repair).
 *
 *  Table normalization runs on EVERY peer for the same reason the
 *  heal sentinels do: the invalid table lives ONLY in the PM doc of
 *  the peer whose command created it — the materializer salvages it
 *  away on everyone else — so a leader-gated pass would never reach
 *  it unless that peer happened to be leader. The pass is a no-op for
 *  every other peer, and self-extinguishing: the write-back heals the
 *  CRDT, after which no peer's doc is dirty. (Two peers concurrently
 *  holding invalid copies of the SAME table could merge duplicate
 *  rows — visible, user-fixable, and requires two simultaneous
 *  detonations of one table; accepted, same as the multi-head merge
 *  corner above.) */
export function buildMarkRepairTr(
  state: EditorState,
  ranges?: readonly RepairRange[],
): Transaction | null {
  const tr = state.tr;
  // Order matters: normalization uses replaceWith (position-shifting),
  // and the two sweeps below walk the CURRENT tr.doc, so they must
  // come after it (walk() maps the ranges through those steps).
  //
  // `ranges` (the session pass supplies the merge's changed regions)
  // bounds every sweep: a violation a merge creates lies inside the
  // merge's changed region — the same argument fixTables' bounded path
  // already rests on — so the pass that imported it still repairs it,
  // at a cost proportional to the edit rather than the document
  // (2026-09-01 review, SC4). Import/open callers pass nothing and keep
  // the full scan as the backstop.
  normalizeTableStructure(tr, ranges);
  sweepExclusiveMarks(tr, ranges);
  canonicalizeHealSentinels(tr, ranges);
  return tr.steps.length ? tr : null;
}

/** Build the full repair transaction for `state` (tables + exclusive
 *  marks + container invariant), or null when nothing needs repair.
 *  Used by import, offline merge, and the session's leader.
 *
 *  `oldState` (when the caller has one — the session repair pass does)
 *  puts prosemirror-tables on its own bounded fast path: only tables
 *  in regions that CHANGED between the states are checked, instead of
 *  a full-document scan per call (perf study 2026-08-06 — the leader
 *  paid that scan on every remote frame). A table broken BY a merge is
 *  necessarily inside that merge's changed region, so it is still
 *  caught in the very pass that imported it; import/open callers pass
 *  no oldState and keep the full scan, which also remains the backstop
 *  for anything a bounded session pass could ever leave behind. */
export function buildDocRepairTr(
  state: EditorState,
  oldState?: EditorState,
  ranges?: readonly RepairRange[],
): Transaction | null {
  // Structural normalization first — fixTables THROWS on the states it
  // heals (see normalizeTableStructure). When it made changes,
  // fixTables must see the normalized doc, so its steps are folded on
  // top; the oldState fast path is skipped in that (rare) case.
  const structural = state.tr;
  normalizeTableStructure(structural, ranges);
  let tr: Transaction;
  if (structural.steps.length) {
    const fixed = safeFixTables(state.apply(structural));
    if (fixed) for (const step of fixed.steps) structural.step(step);
    tr = structural;
  } else {
    tr = safeFixTables(state, oldState) ?? state.tr;
  }

  // Mark sweep scans tr.doc so positions reflect any table fixes above;
  // removeMark never shifts positions, so one scan can batch all fixes.
  sweepExclusiveMarks(tr, ranges);

  // Insertions shift positions, so collect first and apply bottom-up.
  // Dedupe by position: overlapping ranges may visit a container twice,
  // and a double insert would duplicate the head.
  const inserts: Array<{ pos: number; type: 'tag' | 'analytic' }> = [];
  const insertAt = new Set<number>();
  walk(tr, ranges, (node, pos) => {
    if (node.type.name === 'card' && node.firstChild?.type.name !== 'tag') {
      if (!insertAt.has(pos + 1)) {
        insertAt.add(pos + 1);
        inserts.push({ pos: pos + 1, type: 'tag' });
      }
    }
    if (node.type.name === 'analytic_unit' && node.firstChild?.type.name !== 'analytic') {
      if (!insertAt.has(pos + 1)) {
        insertAt.add(pos + 1);
        inserts.push({ pos: pos + 1, type: 'analytic' });
      }
    }
    return true;
  });
  inserts.sort((a, b) => b.pos - a.pos);
  for (const ins of inserts) {
    tr.insert(ins.pos, schema.nodes[ins.type]!.create());
  }

  // Heal-sentinel canonicalization (shared with the all-peer repair
  // half — see canonicalizeHealSentinels above). setNodeMarkup shifts
  // no positions, so running it after the insertions above is safe.
  canonicalizeHealSentinels(tr, ranges);

  return tr.steps.length ? tr : null;
}

/** Repair a standalone doc (no editor state), returning the repaired doc
 *  — or the same node when nothing needed repair. */
export function repairDoc(doc: PMNode): PMNode {
  const tr = buildDocRepairTr(EditorState.create({ doc }));
  return tr ? tr.doc : doc;
}
