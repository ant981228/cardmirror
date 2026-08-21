/**
 * Shared range resolution for plugin provenance tokens - the doc-level
 * half of `plugin-jump.ts`, split out so the inbound `/jump`,
 * `/replace` and `/insert-after` routes can never disagree about which
 * textblock a token names. Jump wants a caret position, replace wants a
 * content range, insert-after wants a position inside the anchor block;
 * all come from the SAME resolution order (spec 4.3: heading UUID, then
 * text anchor).
 */
import type { Node as PMNode } from 'prosemirror-model';
import { collectHeadings } from './headings.js';
import { resolveDescriptor } from './learn-anchor.js';
import type { SourcePayload } from './plugin-source-token.js';

/** True when `pos` sits inside a `self_ref` or `transclusion_ref` mirror
 *  subtree. */
export function inMirroredContent(doc: PMNode, pos: number): boolean {
  const $pos = doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === 'self_ref' || $pos.node(d).type.name === 'transclusion_ref') {
      return true;
    }
  }
  return false;
}

/**
 * Resolve a token payload to the CONTENT range of the textblock it names
 * - `[pos + 1, pos + nodeSize - 1]`, the same range extraction anchors
 * an item over (`plugin-extract.ts`), so a round trip through
 * `/extract` -> `/replace` rewrites exactly the text that was sent.
 *
 * A zero-length range is a legitimate answer for an empty heading; it is
 * the caller's business whether writing there makes sense.
 */
export function resolveSourceRange(
  doc: PMNode,
  payload: SourcePayload,
): { from: number; to: number } | null {
  if (payload.headingId) {
    const entry = collectHeadings(doc, { skipCite: true }).find(
      (h) => h.id === payload.headingId,
    );
    if (entry) {
      // A found UUID is final: never fall through to the anchor, or a
      // renamed heading would silently retarget whatever text still
      // matches the stale quote elsewhere in the doc. `nodeAt` can't miss
      // (the pos came from a doc walk); the null is a rail.
      const node = doc.nodeAt(entry.pos);
      return node ? { from: entry.pos + 1, to: entry.pos + node.nodeSize - 1 } : null;
    }
  }
  if (payload.anchor) {
    const r = resolveDescriptor(doc, payload.anchor);
    // Never land inside a `self_ref` or `transclusion_ref`: their children
    // are read-only mirrored text, so a match there is a coincidence, not
    // the real source. Treat it as unresolved.
    if (r && !inMirroredContent(doc, r.from)) {
      // A descriptor's `to` is the LEFT EDGE OF THE NEXT flat character
      // (`learn-anchor.ts` endPos), so a quote that runs to the end of its
      // textblock reports a `to` past the block's closing token - in the
      // next block's content. Clamp to the block holding `from`: this
      // resolves to one textblock's content range, and a caller replacing
      // the raw range would merge two blocks.
      const $from = doc.resolve(r.from);
      return { from: r.from, to: Math.min(r.to, $from.end()) };
    }
  }
  return null;
}
