/**
 * Causal mark heal — inserter-intent semantics for the read layers.
 *
 * Peritext range marks cover text concurrently inserted INSIDE their
 * range (see collab-invariants.ts, which heals the font_size half of
 * this). For the read-layer marks — highlight / underline / emphasis /
 * shading — that coverage is wrong in the product's own terms: a
 * highlight means "these exact words are read aloud", so a paragraph a
 * partner retyped WITHOUT ever seeing the highlight must not converge
 * highlighted (field reports 2026-08-05: whole card bodies "nobody
 * highlighted"). But text typed by someone who COULD see the mark —
 * their replica had it — keeps it: that's ordinary typing inside a
 * highlight, and it already carries the mark by the typist's own hand.
 *
 * The rule, causally exact (validated by the 2026-08-06 study — spike,
 * repro, and a 15-seed fuzz of this rule injected at every import):
 *
 *   a governed mark may cover a character iff the character's insert
 *   op and the covering mark op are CAUSALLY RELATED — the typist knew
 *   the mark, or the marker knew the text. CONCURRENT pairs are
 *   Peritext interior inheritance with no user behind them: strip.
 *
 * The verdict is a pure function of the op history, so every peer that
 * evaluates a pair — whenever its own imports complete it — reaches
 * the same answer, and the strips converge like ordinary edits (the
 * fuzz's convergence assertion is the regression net for this).
 *
 * Mechanics: runs on binding transactions only (remote imports and
 * session undo — local typing is never healed), over the transactions'
 * CHANGED ranges only. Char origin op ids come from the Loro text
 * cursor API; mark ops and causal deps from an incrementally-updated
 * decode of the doc's op log (exportJsonUpdates MUST be called with
 * peer compression off — compressed ids index a peers[] table and
 * match nothing). Strips are emitted as an ordinary ProseMirror
 * transaction so the binding writes them back to the CRDT and the
 * local view repaints (writing the CRDT directly leaves the binding —
 * which ignores foreign local commits — showing stale marks).
 *
 * Fail-safe direction is always KEEP: an unattributable char (shallow
 * history, container-initial content), an unresolvable change, or an
 * unmatched mark keeps its mark — over-keeping is the status quo;
 * over-stripping would eat deliberate work.
 */

import { Plugin } from 'prosemirror-state';
import type { Transaction } from 'prosemirror-state';
import { AddMarkStep, RemoveMarkStep } from 'prosemirror-transform';
import type { Node as PMNode } from 'prosemirror-model';
import {
  loroSyncPluginKey,
  loroUndoPluginKey,
  CHILDREN_KEY,
  type LoroNodeMapping,
  type LoroDocType,
} from 'loro-prosemirror';
import { LoroText, VersionVector } from 'loro-crdt';
import type { LoroDoc, PeerID } from 'loro-crdt';
import { guardNormalizerTr } from '../normalizer-guard.js';

/** The read layers: marks that state "these exact words" (the cutter's
 *  own layer model — u / em / hl — plus shading, highlight's docx
 *  shadow). comment_range is deliberately NOT here: a comment anchors a
 *  REGION, and growing over interior edits is its correct behavior. */
export const CAUSALLY_GOVERNED_MARKS: ReadonlySet<string> = new Set([
  'highlight',
  'underline_mark',
  'emphasis_mark',
  'shading',
]);

function isBindingTransaction(tr: Transaction): boolean {
  return tr.getMeta(loroSyncPluginKey) !== undefined || tr.getMeta(loroUndoPluginKey) !== undefined;
}

// ─── Incremental op-history index ─────────────────────────────────

interface MarkOpRec {
  peer: string;
  counter: number;
  styleKey: string;
  container: string;
}

interface ChangeRec {
  start: number;
  end: number; // exclusive op-counter bound
  deps: { peer: PeerID; counter: number }[];
  /** Memoized frontiersToVV(deps) — resolved once per change, not once
   *  per (character × candidate) in the heal loop. */
  vv?: Map<string, number> | null;
}

interface HistIndex {
  /** container id → style key → mark ops, so a text node's candidates
   *  are a direct lookup, not a filter over every mark op ever seen. */
  markOps: Map<string, Map<string, MarkOpRec[]>>;
  markOpCount: number;
  /** Per peer, ordered by start counter (append-only per peer). */
  changes: Map<string, ChangeRec[]>;
  /** VV (as toJSON map) the index is current through. */
  upTo: Map<`${number}`, number>;
}

/** Diagnostics for tests: how many heal passes ran, and how many
 *  seed/init transactions were skipped. */
export const causalHealStats = { passes: 0, skippedInit: 0 };

type JsonUpdates = {
  changes: {
    id: string; // "counter@peer"
    deps: string[];
    ops: { container: string; counter: number; content: Record<string, unknown> }[];
  }[];
};

const indexCache = new WeakMap<object, HistIndex>();

function parseOpId(id: string): { peer: string; counter: number } {
  const at = id.lastIndexOf('@');
  return { peer: id.slice(at + 1), counter: Number(id.slice(0, at)) };
}

/** Bring the doc's history index up to date. Steady-state cost is one
 *  decode of the ops imported since the last heal, not the full log. */
function updateIndex(doc: LoroDoc): HistIndex {
  const idx: HistIndex = indexCache.get(doc) ?? {
    markOps: new Map(),
    markOpCount: 0,
    changes: new Map(),
    upTo: new Map(),
  };
  const from = idx.upTo.size > 0 ? new VersionVector(idx.upTo) : undefined;
  const now = doc.version();
  // Peer compression OFF: compressed ids index a peers[] table and
  // would never match real container ids or op ids.
  const json = doc.exportJsonUpdates(from, now, false) as unknown as JsonUpdates;
  const touched = new Set<string>();
  for (const ch of json.changes) {
    const { peer, counter: start } = parseOpId(ch.id);
    let end = start;
    for (const op of ch.ops) {
      const c = op.content as { type?: string; text?: string; style_key?: string; style_value?: unknown };
      // Text inserts consume one op counter per character; everything
      // else consumes one per op.
      const opLen = c.type === 'insert' && typeof c.text === 'string' ? c.text.length : 1;
      end = Math.max(end, op.counter + opLen);
      if (
        c.type === 'mark' &&
        c.style_value != null &&
        typeof c.style_key === 'string' &&
        CAUSALLY_GOVERNED_MARKS.has(c.style_key)
      ) {
        let byStyle = idx.markOps.get(op.container);
        if (!byStyle) idx.markOps.set(op.container, (byStyle = new Map()));
        let list = byStyle.get(c.style_key);
        if (!list) byStyle.set(c.style_key, (list = []));
        list.push({ peer, counter: op.counter, styleKey: c.style_key, container: op.container });
        idx.markOpCount++;
      }
    }
    const arr = idx.changes.get(peer) ?? [];
    arr.push({
      start,
      end,
      deps: ch.deps.map((d) => {
        const p = parseOpId(d);
        return { peer: p.peer as PeerID, counter: p.counter };
      }),
    });
    idx.changes.set(peer, arr);
    touched.add(peer);
  }
  // Only the peers appended to this pass — re-sorting every peer's whole
  // change list on every pass grew with session length (2026-09-01
  // review, SC6). Changes arrive in ascending counter order per peer,
  // so this is nearly a no-op sort on an already-ordered array.
  for (const peer of touched) idx.changes.get(peer)!.sort((a, b) => a.start - b.start);
  idx.upTo = now.toJSON();
  indexCache.set(doc, idx);
  return idx;
}

function changeOf(idx: HistIndex, peer: string, counter: number): ChangeRec | null {
  const arr = idx.changes.get(peer);
  if (!arr) return null;
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = arr[mid]!;
    if (counter < c.start) hi = mid - 1;
    else if (counter >= c.end) lo = mid + 1;
    else return c;
  }
  return null;
}

/** Does op A causally know op B? Same peer: counter order (ops within
 *  one peer's log are totally ordered). Cross-peer: B lies inside the
 *  version vector of A's change deps (VV values are exclusive upper
 *  counters — "knows ops < v"). */
function knows(
  doc: LoroDoc,
  idx: HistIndex,
  a: { peer: string; counter: number },
  b: { peer: string; counter: number },
): boolean {
  if (a.peer === b.peer) return b.counter <= a.counter;
  const ch = changeOf(idx, a.peer, a.counter);
  if (!ch || ch.deps.length === 0) return false;
  if (ch.vv === undefined) {
    try {
      ch.vv = doc.frontiersToVV(ch.deps).toJSON() as Map<string, number>;
    } catch {
      ch.vv = null; // pruned/foreign frontier — keep (fail-safe)
    }
  }
  if (!ch.vv) return false;
  return (ch.vv.get(b.peer) ?? 0) > b.counter;
}

/** Pre-build the history index off the critical path (idle time after
 *  a session mounts), so the first remote frame doesn't pay the full
 *  op-log decode synchronously. Idempotent. */
export function warmCausalMarkIndex(doc: LoroDoc): void {
  try {
    updateIndex(doc);
  } catch {
    /* diagnostics only — the plugin rebuilds on demand */
  }
}

// ─── PM position → Loro text container ────────────────────────────

/** The LoroText backing `blockNode` (a PM textblock), via the sync
 *  plugin's container mapping. `invert` is a per-heal-pass inverted
 *  index of the mapping, built lazily only when a governed mark is
 *  actually present in a changed range. Mirrors the walk the binding's
 *  own cursor code performs (cursor/common.ts absolutePositionToCursor);
 *  offset mapping matches: non-text children (atoms) consume one
 *  ProseMirror position each. */
function loroTextFor(
  blockNode: PMNode,
  syncDoc: LoroDocType,
  invert: Map<PMNode, string>,
): { text: LoroText; cid: string; base: (pmOffset: number) => number } | null {
  const containerId = invert.get(blockNode);
  if (!containerId) return null;
  try {
    const loroMap = syncDoc.getMap(containerId as never) as unknown as {
      get(key: string): unknown;
    };
    const children = loroMap.get(CHILDREN_KEY) as {
      length: number;
      get(i: number): unknown;
    };
    // A textblock's children hold ONE LoroText (the binding's shape for
    // text content) possibly alongside atom entries. Find the text and
    // count how many leading atoms precede it (each is one PM offset).
    let atomsBefore = 0;
    for (let i = 0; i < children.length; i++) {
      const child = children.get(i);
      if (child instanceof LoroText) {
        const cid = String(child.id);
        return { text: child, cid, base: (pmOffset: number) => pmOffset - atomsBefore };
      }
      atomsBefore += 1;
    }
  } catch {
    /* unmapped/detached — keep (fail-safe) */
  }
  return null;
}

// ─── The plugin ───────────────────────────────────────────────────

interface Range {
  from: number;
  to: number;
}

/** Doc ranges `tr` touched, in post-apply coordinates (same helper
 *  shape as collab-invariants'). */
function changedRanges(tr: Transaction): Range[] {
  const out: Range[] = [];
  tr.steps.forEach((step, i) => {
    const rest = tr.mapping.slice(i + 1);
    if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
      out.push({ from: rest.map(step.from, -1), to: rest.map(step.to, 1) });
      return;
    }
    step.getMap().forEach((_os, _oe, newStart, newEnd) => {
      out.push({ from: rest.map(newStart, -1), to: rest.map(newEnd, 1) });
    });
  });
  return out;
}

export function causalMarkHealPlugin(loroDoc: LoroDoc): Plugin {
  return new Plugin({
    appendTransaction(trs, oldState, newState) {
      // The binding's INIT transaction replaces the empty starter doc
      // with the whole CRDT state (the ~10s join freeze on a tournament
      // master): its changed range is the entire document, so this pass
      // would decode the full op log and walk every governed run —
      // inside the freeze. Nothing is lost by skipping: the verdict is a
      // pure function of op history, and the next real remote frame
      // touching a run heals it (fail-safe direction is KEEP anyway)
      // (2026-09-01 review, SC5).
      if (oldState.doc.content.size <= 2 && newState.doc.content.size > 2) {
        causalHealStats.skippedInit++;
        return null;
      }
      // Binding transactions only: remote imports and session undo.
      // Local typing is never healed — a local insert inside a visible
      // mark is the SEEN case by construction.
      const ranges: Range[] = [];
      for (let i = 0; i < trs.length; i++) {
        if (!isBindingTransaction(trs[i]!) || !trs[i]!.docChanged) continue;
        for (const r of changedRanges(trs[i]!)) {
          let { from, to } = r;
          for (let j = i + 1; j < trs.length; j++) {
            from = trs[j]!.mapping.map(from, -1);
            to = trs[j]!.mapping.map(to, 1);
          }
          if (from < to) ranges.push({ from, to });
        }
      }
      if (ranges.length === 0) return null;

      // Cheap pre-check before touching the op log or the container
      // mapping: is any governed mark present in the changed ranges?
      const doc = newState.doc;
      let anyGoverned = false;
      for (const { from, to } of ranges) {
        const cf = Math.max(0, Math.min(from, doc.content.size));
        const ct = Math.max(cf, Math.min(to, doc.content.size));
        doc.nodesBetween(cf, ct, (node) => {
          if (anyGoverned) return false;
          if (node.isText && node.marks.some((m) => CAUSALLY_GOVERNED_MARKS.has(m.type.name))) {
            anyGoverned = true;
          }
          return !anyGoverned;
        });
        if (anyGoverned) break;
      }
      if (!anyGoverned) return null;

      const syncState = loroSyncPluginKey.getState(newState) as
        | { doc: LoroDocType; mapping: LoroNodeMapping }
        | undefined;
      if (!syncState?.doc || !syncState.mapping) return null;

      const idx = updateIndex(loroDoc);
      if (idx.markOpCount === 0) return null;
      causalHealStats.passes++;

      // Inverted container mapping (PM node → container id), built once
      // per pass — only reached when governed marks are in play.
      const invert = new Map<PMNode, string>();
      for (const [cid, node] of syncState.mapping as unknown as Map<string, PMNode>) {
        invert.set(node, cid);
      }

      const tr = newState.tr;
      const healed = new Set<string>(); // `${pos}:${mark}` dedup across overlapping ranges
      for (const { from, to } of ranges) {
        const cf = Math.max(0, Math.min(from, doc.content.size));
        const ct = Math.max(cf, Math.min(to, doc.content.size));
        doc.nodesBetween(cf, ct, (node, pos, parent) => {
          if (!node.isText || !parent) return true;
          const governed = node.marks.filter((m) => CAUSALLY_GOVERNED_MARKS.has(m.type.name));
          if (governed.length === 0) return true;
          const mapped = loroTextFor(parent, syncState.doc, invert);
          if (!mapped) return true; // keep (fail-safe)
          // This text node's offset within its parent textblock.
          const parentOffset = doc.resolve(pos).parentOffset;
          const overlapFrom = Math.max(pos, cf);
          const overlapTo = Math.min(pos + node.nodeSize, ct);
          for (const mark of governed) {
            const key = `${pos}:${mark.type.name}`;
            if (healed.has(key)) continue;
            healed.add(key);
            // Container-exact: only mark ops on THIS block's own text
            // container vouch for its runs — a highlight elsewhere in
            // the doc must not keep an inherited one here.
            const candidates = idx.markOps.get(mapped.cid)?.get(mark.type.name);
            if (!candidates || candidates.length === 0) continue; // keep (fail-safe)
            // Per-char verdicts over the overlap, coalesced to ranges.
            let runStart = -1;
            for (let p = overlapFrom; p < overlapTo; p++) {
              const loroOffset = mapped.base(parentOffset + (p - pos));
              let inherited = false;
              try {
                const origin = mapped.text.getCursor(loroOffset)?.pos();
                inherited =
                  origin != null &&
                  !candidates.some(
                    (m) =>
                      knows(loroDoc, idx, { peer: String(origin.peer), counter: origin.counter }, m) ||
                      knows(loroDoc, idx, m, { peer: String(origin.peer), counter: origin.counter }),
                  );
              } catch {
                inherited = false; // keep (fail-safe)
              }
              if (inherited && runStart < 0) runStart = p;
              if (!inherited && runStart >= 0) {
                tr.removeMark(runStart, p, mark.type);
                runStart = -1;
              }
            }
            if (runStart >= 0) tr.removeMark(runStart, overlapTo, mark.type);
          }
          return true;
        });
      }
      if (tr.steps.length === 0) return null;
      // Machinery, not a user edit: outside the undo stack, admitted by
      // read mode via the normalizer origin, and capped against loops.
      tr.setMeta('addToHistory', false);
      return guardNormalizerTr(trs, tr);
    },
  });
}
