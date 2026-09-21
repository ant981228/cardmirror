/**
 * Intra-document live window ("self-transclusion") — the pure core.
 *
 * A `self_ref` node is a by-REFERENCE, read-only projection of another section
 * of the SAME document. It stores only `source_heading_id` (which section to
 * mirror) — no content copy. This module resolves that reference to the source
 * section's CURRENT content, recursively inlining any nested self-refs and
 * guarding against cycles. It is DOM-free and Electron-free (fully unit
 * testable); the NodeView + plugin build on it.
 *
 * The window is read-only: you edit at the source, never through the window.
 * That's what makes it conflict-free — one editable copy of any content, N live
 * views onto it — so none of the sync / divergence / freeze machinery the
 * by-value prototype needed exists here.
 */

import { Fragment, Slice, type Mark, type Node as PMNode, type Schema } from 'prosemirror-model';
import { extractSection, rewriteHeadingIdsInFragment, isTransclusionNode } from './transclusion.js';
import {
  styleReferenceText,
  type ReferenceBodyStyle,
} from './reference-style.js';
import type { CreateReferenceHighlightMode } from './settings.js';

export const SELF_REF_NODE = 'self_ref';

export function isSelfRef(node: PMNode | null | undefined): boolean {
  return !!node && node.type.name === SELF_REF_NODE;
}

/** Build a `self_ref` node mirroring the section under `headingId`. */
export function createSelfRefNode(
  schema: Schema,
  headingId: string,
  label: string,
): PMNode {
  const type = schema.nodes[SELF_REF_NODE];
  if (!type) throw new Error('self_ref not registered in schema');
  return type.create({ source_heading_id: headingId, source_label: label });
}

/** Build a live view of an exact body-text selection marked in the source. */
export function createLiveReferenceNode(
  schema: Schema,
  anchorId: string,
  heading: string,
  style: {
    gray: boolean;
    bold: boolean;
    italic: boolean;
    emphasized: boolean;
    underlined: boolean;
    shrink: boolean;
    shrinkPt: number;
    highlightMode: CreateReferenceHighlightMode;
  },
): PMNode {
  const type = schema.nodes[SELF_REF_NODE];
  if (!type) throw new Error('self_ref not registered in schema');
  return type.create({
    source_anchor_id: anchorId,
    source_label: 'Live reference',
    reference_heading: heading,
    reference_gray: style.gray,
    reference_heading_bold: style.bold,
    reference_heading_italic: style.italic,
    reference_heading_emphasized: style.emphasized,
    reference_heading_underlined: style.underlined,
    reference_shrink: style.shrink,
    reference_shrink_pt: style.shrinkPt,
    reference_highlight_mode: style.highlightMode,
  });
}

export interface Projection {
  /** The resolved source content, with any nested self-refs inlined. */
  content: Fragment;
  /** The source heading no longer exists in the doc. */
  missing: boolean;
  /** A nested self-ref pointed back through the chain (a cycle) and was dropped. */
  cycle: boolean;
}

/**
 * Resolve the current content a `self_ref` projects: the source section under
 * `headingId`, with any nested self-refs recursively inlined. `visited` carries
 * the chain of heading ids already being resolved, so a self-ref that points
 * back (directly or transitively) is detected as a cycle, dropped, and flagged
 * — the projection never recurses forever (Obsidian's "embed cycle" guard).
 */
export function resolveSelfProjection(
  doc: PMNode,
  headingId: string,
  visited: ReadonlySet<string> = new Set(),
): Projection {
  // Per-pass memo: each distinct heading is resolved ONCE and reused, so a
  // heading referenced repeatedly (a diamond, or the same embed inlined N times)
  // isn't re-walked per occurrence — turning a potential exponential fan-out into
  // linear. Cycles are broken by `onStack` (headings currently on the resolution
  // path); `visited` seeds it so an explicit ancestor set is still honored.
  return resolveMemo(doc, headingId, new Set(visited), new Map());
}

/** Resolve an exact-selection source anchor into body paragraphs. */
export function resolveLiveReferenceProjection(
  doc: PMNode,
  anchorId: string,
  style?: ReferenceBodyStyle,
): Projection {
  if (!anchorId) return { content: Fragment.empty, missing: true, cycle: false };
  const anchorType = doc.type.schema.marks['live_reference_source'];
  if (!anchorType) return { content: Fragment.empty, missing: true, cycle: false };
  const paragraphs: PMNode[] = [];
  doc.descendants((node) => {
    if (node.type.name !== 'card_body') return true;
    const children: PMNode[] = [];
    node.forEach((child) => {
      const anchor = child.marks.find(
        (mark) =>
          mark.type === anchorType &&
          String(mark.attrs['ids'] ?? '').split(' ').includes(anchorId),
      );
      if (anchor) {
        const source = child.mark(child.marks.filter((mark) => mark !== anchor));
        let effectivePt = 11;
        try {
          const sizes = JSON.parse(String(anchor.attrs['sizes'] ?? '{}')) as Record<string, unknown>;
          const stored = Number(sizes[anchorId]);
          if (Number.isFinite(stored) && stored > 0) effectivePt = stored;
        } catch {
          /* malformed private metadata falls back to Normal size */
        }
        children.push(style ? styleReferenceText(source, effectivePt, style) : source);
      }
    });
    if (children.length) paragraphs.push(node.type.create(node.attrs, children));
    return false;
  });
  return {
    content: Fragment.fromArray(paragraphs),
    missing: paragraphs.length === 0,
    cycle: false,
  };
}

export function liveReferenceSourceRange(
  doc: PMNode,
  anchorId: string,
): { from: number; to: number } | null {
  const anchorType = doc.type.schema.marks['live_reference_source'];
  if (!anchorType || !anchorId) return null;
  let from = Infinity;
  let to = -Infinity;
  doc.descendants((node, pos) => {
    if (
      node.isInline &&
      node.marks.some(
        (mark) =>
          mark.type === anchorType &&
          String(mark.attrs['ids'] ?? '').split(' ').includes(anchorId),
      )
    ) {
      from = Math.min(from, pos);
      to = Math.max(to, pos + node.nodeSize);
    }
    return true;
  });
  return Number.isFinite(from) ? { from, to } : null;
}

/** Resolve either flavor of self_ref without duplicating the attrs branch. */
export function resolveSelfRefProjection(doc: PMNode, node: PMNode): Projection {
  const anchorId = String(node.attrs['source_anchor_id'] ?? '');
  return anchorId
    ? resolveLiveReferenceProjection(doc, anchorId, liveReferenceBodyStyle(node))
    : resolveSelfProjection(doc, String(node.attrs['source_heading_id'] ?? ''));
}

export function liveReferenceBodyStyle(node: PMNode): ReferenceBodyStyle {
  return {
    shrink: node.attrs['reference_shrink'] === true,
    shrinkPt: Number(node.attrs['reference_shrink_pt'] ?? 3),
    highlightMode: String(node.attrs['reference_highlight_mode'] ?? 'shading') as CreateReferenceHighlightMode,
    useGray50: node.attrs['reference_gray'] === true,
  };
}

/** Add the reference heading when a live reference becomes ordinary content. */
export function materializeSelfRefProjection(node: PMNode, projection: Projection): Fragment {
  if (!node.attrs['source_anchor_id']) return projection.content;
  const heading = String(node.attrs['reference_heading'] ?? '');
  if (!heading) return projection.content;
  const marks: Mark[] = [];
  const schema = node.type.schema;
  if (node.attrs['reference_heading_bold']) marks.push(schema.marks['bold']!.create());
  if (node.attrs['reference_heading_italic']) marks.push(schema.marks['italic']!.create());
  if (node.attrs['reference_heading_emphasized']) marks.push(schema.marks['emphasis_mark']!.create());
  else if (node.attrs['reference_heading_underlined']) marks.push(schema.marks['underline_mark']!.create());
  return Fragment.from(schema.nodes['paragraph']!.create(null, schema.text(heading, marks)))
    .append(projection.content);
}

/**
 * Memoized DFS core of `resolveSelfProjection`. `onStack` = the headings whose
 * resolution is in progress on this path — a reference back into one is a cycle,
 * dropped and flagged. `memo` = completed resolutions, reused across every
 * reference in this pass. For an acyclic reference graph (every real doc) this is
 * output-identical to a naive re-resolution; for the degenerate cyclic corner it
 * still terminates and stays valid, breaking the cycle at a consistent point
 * (resolution order) rather than a path-dependent one.
 */
function resolveMemo(
  doc: PMNode,
  headingId: string,
  onStack: Set<string>,
  memo: Map<string, Projection>,
): Projection {
  if (!headingId || onStack.has(headingId)) {
    // Empty pointer, or a back-reference to a heading still being resolved: a
    // cycle. Drop it and flag — rendering forever is the only alternative. Not
    // memoized: the in-progress heading caches its real result when it completes.
    return { content: Fragment.empty, missing: false, cycle: true };
  }
  const cached = memo.get(headingId);
  if (cached) return cached;

  const section = extractSection(doc, headingId);
  if (!section) {
    const miss: Projection = { content: Fragment.empty, missing: true, cycle: false };
    memo.set(headingId, miss);
    return miss;
  }
  onStack.add(headingId);
  const state = { cycle: false };
  const content = inlineNestedRefs(doc, section.content, onStack, memo, state);
  onStack.delete(headingId);
  const result: Projection = { content, missing: false, cycle: state.cycle };
  memo.set(headingId, result);
  return result;
}

/** Resolves a heading's projection, memoized. */
export type ProjectionResolver = (headingId: string) => Projection;

/**
 * A projection resolver that memoizes across MANY headings in a single pass —
 * for callers that resolve EVERY self_ref in a doc (numbering, the render plugin,
 * flatten). Without it, N views that chain (view→section-with-view→…) each
 * re-resolve their overlapping sub-chain — O(N²); sharing one memo makes the
 * whole pass resolve each distinct heading once. Each top-level resolution starts
 * with a fresh cycle stack; the doc must not change under the resolver.
 */
export function makeProjectionResolver(doc: PMNode): ProjectionResolver {
  const memo = new Map<string, Projection>();
  return (headingId) => resolveMemo(doc, headingId, new Set<string>(), memo);
}

/**
 * Replace every `self_ref` in `doc` with its resolved projection as real cards
 * (heading ids re-stamped fresh, so the flattened copies don't collide with the
 * source they were projected from). Used before `.docx` export — Word has no
 * live-window concept, so a window materializes to plain cards. `.cmir` does NOT
 * use this: it keeps the reference (the source is in the same file).
 */
export function flattenSelfRefs(doc: PMNode, freshId: () => string): PMNode {
  return doc.type.create(doc.attrs, flattenSelfRefsInFragment(doc.content, doc, freshId), doc.marks);
}

/** Whether `frag` contains a self_ref anywhere. */
export function fragmentHasSelfRef(frag: Fragment): boolean {
  let found = false;
  const walk = (f: Fragment): void => {
    f.forEach((n) => {
      if (found) return;
      if (isSelfRef(n)) {
        found = true;
        return;
      }
      if (n.content.size) walk(n.content);
    });
  };
  walk(frag);
  return found;
}

/**
 * Replace every self_ref in `frag` with its resolved projection as real cards
 * (ids re-stamped), resolving against `sourceDoc` — the doc the fragment came
 * from. Used when a live view leaves its home doc (copy / send / drag): the
 * reference can't travel, so it materializes to plain content, just like a
 * linked copy flattens.
 */
export function flattenSelfRefsInFragment(
  frag: Fragment,
  sourceDoc: PMNode,
  freshId: () => string,
): Fragment {
  // No self_ref → nothing to inline; return as-is (the common case, and it keeps
  // this cheap on the divergence hot path where it runs on every source read).
  if (!fragmentHasSelfRef(frag)) return frag;
  // One resolver for the whole fragment so N self_refs share the memo (linear,
  // not O(N × chain)).
  return flattenWithResolver(frag, sourceDoc, makeProjectionResolver(sourceDoc), freshId);
}

function flattenWithResolver(
  frag: Fragment,
  sourceDoc: PMNode,
  resolve: ProjectionResolver,
  freshId: () => string,
): Fragment {
  const out: PMNode[] = [];
  frag.forEach((node) => {
    if (isSelfRef(node)) {
      const anchorId = String(node.attrs['source_anchor_id'] ?? '');
      const proj = anchorId
        ? resolveLiveReferenceProjection(sourceDoc, anchorId, liveReferenceBodyStyle(node))
        : resolve(String(node.attrs['source_heading_id'] ?? ''));
      rewriteHeadingIdsInFragment(materializeSelfRefProjection(node, proj), freshId)
        .forEach((n) => out.push(n));
      return;
    }
    if (node.content.size) {
      out.push(node.type.create(node.attrs, flattenWithResolver(node.content, sourceDoc, resolve, freshId), node.marks));
      return;
    }
    out.push(node);
  });
  return Fragment.fromArray(out);
}

/** `flattenSelfRefsInFragment` for a Slice. Open depths are unchanged — a
 *  self_ref is a leaf atom, so it's never on an "open" edge the way a container
 *  zone is (cf. flattenZonesInSlice, which must adjust them). */
export function flattenSelfRefsInSlice(slice: Slice, sourceDoc: PMNode, freshId: () => string): Slice {
  if (!fragmentHasSelfRef(slice.content)) return slice;
  return new Slice(
    flattenSelfRefsInFragment(slice.content, sourceDoc, freshId),
    slice.openStart,
    slice.openEnd,
  );
}

function inlineNestedRefs(
  doc: PMNode,
  frag: Fragment,
  onStack: Set<string>,
  memo: Map<string, Projection>,
  state: { cycle: boolean },
): Fragment {
  const out: PMNode[] = [];
  frag.forEach((node) => {
    if (isSelfRef(node)) {
      const anchorId = String(node.attrs['source_anchor_id'] ?? '');
      const child = anchorId
        ? resolveLiveReferenceProjection(doc, anchorId, liveReferenceBodyStyle(node))
        : resolveMemo(doc, String(node.attrs['source_heading_id'] ?? ''), onStack, memo);
      if (child.cycle) state.cycle = true;
      // A missing nested source contributes nothing (its own window elsewhere
      // shows "source not found"); a resolved one inlines its content.
      materializeSelfRefProjection(node, child).forEach((n) => out.push(n));
      return;
    }
    if (isTransclusionNode(node)) {
      // A linked copy inside the mirrored section is shown FLAT — its cached cards
      // inline, its rail dropped. A live view never stacks a second transclusion
      // rail inside itself; re-processing the copy's content also inlines any
      // self_refs it holds.
      inlineNestedRefs(doc, node.content, onStack, memo, state).forEach((n) => out.push(n));
      return;
    }
    if (node.content.size) {
      out.push(node.type.create(node.attrs, inlineNestedRefs(doc, node.content, onStack, memo, state), node.marks));
      return;
    }
    out.push(node);
  });
  return Fragment.fromArray(out);
}
