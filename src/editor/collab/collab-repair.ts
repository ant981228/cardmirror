/**
 * The tables/cards repair pass, wired into sessions (§4.4).
 *
 * `buildDocRepairTr` (doc-repair.ts, M0) is the deterministic, pure,
 * idempotent repair: prosemirror-tables' `fixTables` for ragged rows
 * and colspan overflow (the row-insert-vs-column-insert merge), the
 * mutually-exclusive-marks sweep, and the container first-child
 * invariant (a `card` opens with a `tag`, an `analytic_unit` with an
 * `analytic`). This plugin runs it after every remote batch and every
 * undo/redo, leader-gated per §4.3:
 *
 *   - LEADER (lowest peer id among self + presence-visible peers)
 *     dispatches the repair; followers suppress theirs and receive the
 *     leader's synced fix within a round-trip. Structural repairs are
 *     insertions — two peers repairing the same merged state emit
 *     concurrent ops with distinct identities, and CRDTs do not dedupe
 *     semantically identical content (double-padded tables).
 *   - The gate is BEST-EFFORT: presence can be empty (cursors setting
 *     off, frames lost), making everyone leader. That degrades to
 *     churn, not corruption — the repair is idempotent on its own
 *     output and the normalizer round cap stops any dispatch loop.
 *   - Heal-sentinel canonicalization deliberately runs on EVERY peer
 *     (inside buildMarkRepairTr), NOT leader-gated: it is convergent
 *     under concurrency (same-value id rewrites; concurrent head
 *     write-backs are absorbed by the materializer's multi-head
 *     normalization), and all-peer write-back shrinks the
 *     mixed-version window in which an old client can still finalize
 *     a dropped card.
 *
 * Repair transactions carry the normalizer origin (read mode admits
 * them; the round cap applies) and sync like ordinary edits.
 */

import { Plugin, PluginKey } from 'prosemirror-state';
import { postNotice } from '../status-notices.js';
import type { Transaction } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { AddMarkStep, RemoveMarkStep } from 'prosemirror-transform';
import { HEADING_TYPE_NAMES, newHeadingId } from '../../schema/ids.js';
import { loroSyncPluginKey, loroUndoPluginKey } from 'loro-prosemirror';
import { buildDocRepairTr, buildMarkRepairTr, type RepairRange } from '../../doc-repair.js';
import { guardNormalizerTr } from '../normalizer-guard.js';

/** Diagnostics for tests: session passes bounded to changed ranges vs
 *  full-document scans (which the session pass must never do). */
export const repairStats = { boundedPasses: 0, fullDocScans: 0, duplicateIdHeals: 0 };

/**
 * Merge-born duplicate heading ids (chaos rig, 2026-09-04).
 *
 * The heading-id guard heals LOCAL transactions only — policing remote
 * content edit-for-edit would fight old clients. But a merge can mint a
 * duplicate that no local transaction ever sees: a card cut and pasted
 * (delete + create, same id on the copy) while a partner MOVED it — a
 * concurrent move keeps a deleted movable-list element alive — leaves
 * the card twice on every peer, same id on both, forever (nav jumps,
 * live views and collab cursors all address by id). New clients no
 * longer cut that way in a session (cut in place), but an old client
 * still can, and nothing else would ever repair it.
 *
 * Detection must not walk the document per batch (the session pass is
 * bounded by design), so the plugin keeps a heading-id → count index in
 * its state, updated from each transaction's step ranges: the old range
 * (pre-step doc) subtracts the ids it holds, the new range adds them. A
 * text edit inside a body visits no heading, so the index is untouched
 * on the hot path; one full walk happens at install. The index is
 * mutated in place — it is a cache of the current document, not
 * semantic state, and undo/redo pass through `apply` like any edit.
 *
 * Leader-gated like the structural repairs: every bearer after the
 * first in document order is re-minted (the guard's own fallback rule
 * when provenance cannot say which copy is "the original"; identical
 * on every peer once docs converge, so followers agree with the fix
 * that arrives). Locating the bearers is the one full walk, and it runs
 * only when the index says a duplicate exists.
 */
interface RepairPluginState {
  idCounts: Map<string, number>;
}
const collabRepairKey = new PluginKey<RepairPluginState>('cm-collab-repair');

function addIdsIn(doc: PMNode, from: number, to: number, delta: number, counts: Map<string, number>): void {
  const size = doc.content.size;
  const f = Math.max(0, Math.min(from, size));
  const t = Math.max(f, Math.min(to, size));
  doc.nodesBetween(f, t, (n) => {
    if (HEADING_TYPE_NAMES.has(n.type.name)) {
      const id = n.attrs['id'];
      if (typeof id === 'string' && id) {
        const next = (counts.get(id) ?? 0) + delta;
        if (next <= 0) counts.delete(id);
        else counts.set(id, next);
      }
    }
    return true;
  });
}

function countAllIds(doc: PMNode): Map<string, number> {
  const counts = new Map<string, number>();
  addIdsIn(doc, 0, doc.content.size, 1, counts);
  return counts;
}

/** Positions of every bearer of `ids`, in document order (the rare
 *  full walk, taken only once the index reports a duplicate). */
function bearersOf(doc: PMNode, ids: Set<string>): Map<string, Array<{ pos: number; node: PMNode }>> {
  const out = new Map<string, Array<{ pos: number; node: PMNode }>>();
  doc.descendants((n, pos) => {
    if (!HEADING_TYPE_NAMES.has(n.type.name)) return true;
    const id = n.attrs['id'];
    if (typeof id === 'string' && ids.has(id)) {
      let list = out.get(id);
      if (!list) out.set(id, (list = []));
      list.push({ pos, node: n });
    }
    return true;
  });
  return out;
}

/** Doc ranges the binding transactions touched, in `newState`
 *  coordinates (remapped across later transactions in the batch) —
 *  the same shape causal-mark-heal and collab-invariants use. */
function changedRanges(trs: readonly Transaction[]): RepairRange[] {
  const out: RepairRange[] = [];
  for (let i = 0; i < trs.length; i++) {
    const tr = trs[i]!;
    if (!tr.docChanged) continue;
    tr.steps.forEach((step, si) => {
      const rest = tr.mapping.slice(si + 1);
      const push = (from: number, to: number): void => {
        for (let j = i + 1; j < trs.length; j++) {
          from = trs[j]!.mapping.map(from, -1);
          to = trs[j]!.mapping.map(to, 1);
        }
        if (from < to) out.push({ from, to });
      };
      if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
        push(rest.map(step.from, -1), rest.map(step.to, 1));
        return;
      }
      step.getMap().forEach((_os, _oe, newStart, newEnd) => {
        push(rest.map(newStart, -1), rest.map(newEnd, 1));
      });
    });
  }
  return out;
}

function isBindingTransaction(tr: Transaction): boolean {
  return tr.getMeta(loroSyncPluginKey) !== undefined || tr.getMeta(loroUndoPluginKey) !== undefined;
}

/** Rate-limited notice that a merge hollowed a container and the heal
 *  restored it (the loro-prosemirror patch's display-layer heal marks
 *  the synthesized head with a 'crdt-heal-' id). Without this the
 *  repair is invisible — the old behavior silently DELETED the card,
 *  and users deserve to know a conflict was patched over. */
/** Scan cooldown — kept even though the notice itself coalesces:
 *  the heal-sentinel doc walk below is gated on this timestamp
 *  (perf study 2026-08-06: one full-doc traversal per remote frame
 *  otherwise), so the rate limit still earns its keep as a scan
 *  gate rather than a toast gate. */
let lastHealToastAt = 0;
let lastNoticeAt = 0;
function noteHealedMerge(): void {
  lastHealToastAt = Date.now();
  if (Date.now() - lastNoticeAt < 60_000) return; // coalesce the notice
  lastNoticeAt = Date.now();
  // Chip entry (coalescing) instead of a rate-limited toast: this is
  // a your-document-changed notice the user must be able to re-read.
  postNotice({
    severity: 'warning',
    title: 'Co-editing merge repaired',
    body:
      'A co-editing merge conflict left a card without its heading — it was kept, with a blank heading. '
      + 'Delete the blank heading if the card itself was meant to go.',
    key: 'collab-merge-heal',
  });
}

export function collabRepairPlugin(isLeader: () => boolean): Plugin {
  return new Plugin<RepairPluginState>({
    key: collabRepairKey,
    state: {
      init: (_config, state) => ({ idCounts: countAllIds(state.doc) }),
      apply(tr, value) {
        if (!tr.docChanged) return value;
        tr.steps.forEach((step, i) => {
          const before = tr.docs[i]!;
          const after = tr.docs[i + 1] ?? tr.doc;
          step.getMap().forEach((oldStart, oldEnd, newStart, newEnd) => {
            addIdsIn(before, oldStart, oldEnd, -1, value.idCounts);
            addIdsIn(after, newStart, newEnd, 1, value.idCounts);
          });
        });
        return value;
      },
    },
    appendTransaction(trs, oldState, newState) {
      if (!trs.some((tr) => tr.docChanged && isBindingTransaction(tr))) return null;
      // The merge's changed regions bound every sweep below (a violation
      // a merge creates lies inside that merge's changed region — the
      // argument fixTables' bounded path already rests on). Before this,
      // three to five FULL-document walks ran per remote batch, at up to
      // ~8 batches/s on a tournament master (2026-09-01 review, SC4).
      const ranges = changedRanges(trs.filter(isBindingTransaction));
      repairStats.boundedPasses++;
      // Surface display-layer merge heals (every peer sees its own). A
      // sentinel is synthesized while materializing the merged region,
      // so scanning the changed ranges finds it — the old full-document
      // walk was gated on the notice cooldown, whose timestamp was only
      // ever stamped AFTER a heal was found: in the no-heal common case
      // the gate never closed and the whole doc was walked every frame.
      for (const { from, to } of ranges) {
        const size = newState.doc.content.size;
        const cf = Math.max(0, Math.min(from, size));
        const ct = Math.max(cf, Math.min(to, size));
        newState.doc.nodesBetween(cf, ct, (node) => {
          if (node.type.name === 'tag' || node.type.name === 'analytic') {
            if (String(node.attrs['id'] ?? '').startsWith('crdt-heal-')) noteHealedMerge();
            return false;
          }
          return true;
        });
      }
      // The exclusive-marks resolution runs on EVERY peer: it's
      // mark-level and deterministic (every peer picks the same winner
      // via the schema-derived total order), so double-application
      // converges under LWW — and a follower must not hold a
      // schema-invalid underline+emphasis run waiting on the leader's
      // fix to arrive. The STRUCTURAL half (tables + container
      // first-child) stays leader-gated: those are insertions, and two
      // peers repairing the same merged state emit concurrent ops with
      // distinct identities that would duplicate content.
      // oldState → prosemirror-tables' bounded fast path (see
      // buildDocRepairTr); the mark/sentinel sweeps inside are
      // unchanged.
      const leader = isLeader();
      let tr = leader
        ? buildDocRepairTr(newState, oldState, ranges)
        : buildMarkRepairTr(newState, ranges);
      if (leader) {
        // A merge-born duplicate id: a bearer inside the merged region
        // whose id the index counts more than once.
        const counts = collabRepairKey.getState(newState)?.idCounts;
        const dupIds = new Set<string>();
        if (counts) {
          for (const { from, to } of ranges) {
            const size = newState.doc.content.size;
            const cf = Math.max(0, Math.min(from, size));
            const ct = Math.max(cf, Math.min(to, size));
            newState.doc.nodesBetween(cf, ct, (node) => {
              if (!HEADING_TYPE_NAMES.has(node.type.name)) return true;
              const id = node.attrs['id'];
              if (typeof id === 'string' && (counts.get(id) ?? 0) > 1) dupIds.add(id);
              return true;
            });
          }
        }
        if (dupIds.size) {
          for (const [, bearers] of bearersOf(newState.doc, dupIds)) {
            for (const { pos, node } of bearers.slice(1)) {
              tr ??= newState.tr;
              tr.setNodeMarkup(tr.mapping.map(pos), null, { ...node.attrs, id: newHeadingId() }, node.marks);
              repairStats.duplicateIdHeals++;
            }
          }
        }
      }
      if (!tr) return null;
      return guardNormalizerTr(trs, tr);
    },
  });
}

/** §4.3 leader rule: lowest peer id wins, comparing self against the
 *  presence-visible peers. Peer ids are decimal u64 strings — compare
 *  numerically via BigInt, not lexically. */
export function lowestPeerIsLeader(selfPeerId: string, visible: string[]): boolean {
  try {
    const self = BigInt(selfPeerId);
    for (const p of visible) {
      if (BigInt(p) < self) return false;
    }
    return true;
  } catch {
    return true; // malformed peer id in presence — repair locally (safe)
  }
}
