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
import { collectHeadings, computeHeadingRange } from './headings.js';
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
 * Order: `headingId` names a heading and wins outright; otherwise the
 * anchor decides, inside `scopeId`'s section when that heading is still
 * there. The two fields are NOT interchangeable - `headingId` is the
 * target, `scopeId` only says where to look - and conflating them is what
 * made an undertag's token answer with the tag above it.
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
      // Tokens minted before the target/scope split carry the GOVERNING
      // heading here even for an undertag or a cite, and they are already
      // stored in companion apps. Such a token has no `scopeId`: when its
      // anchor lands on some other line inside that heading's section, that
      // line is what it named, and answering with the heading would rewrite
      // the debater's tag. A heading's own token quotes its own text, so
      // this cannot retarget one.
      if (payload.scopeId === null && payload.anchor) {
        const section = computeHeadingRange(doc, entry);
        const scoped = section ? anchorRange(doc, payload.anchor, section) : null;
        if (scoped && doc.resolve(scoped.from).before() !== entry.pos) return scoped;
      }
      // A found UUID is otherwise final: never fall through to the anchor,
      // or a renamed heading would silently retarget whatever text still
      // matches the stale quote elsewhere in the doc. `nodeAt` can't miss
      // (the pos came from a doc walk); the null is a rail.
      const node = doc.nodeAt(entry.pos);
      return node ? { from: entry.pos + 1, to: entry.pos + node.nodeSize - 1 } : null;
    }
  }
  if (payload.anchor) {
    if (payload.scopeId) {
      const entry = collectHeadings(doc, { skipCite: true }).find(
        (h) => h.id === payload.scopeId,
      );
      // A living scope is AUTHORITATIVE: a quote that matches outside it is
      // another card's line that happens to read the same, and answering
      // with it would edit an item the caller never named. Only a scope
      // that is itself gone falls back to the whole document.
      if (entry) {
        const section = computeHeadingRange(doc, entry);
        return section ? anchorRange(doc, payload.anchor, section) : null;
      }
    }
    return anchorRange(doc, payload.anchor, null);
  }
  return null;
}

/** The textblock content range a descriptor resolves to, or null. `limit`
 *  confines the hit to one heading's section. */
function anchorRange(
  doc: PMNode,
  anchor: NonNullable<SourcePayload['anchor']>,
  limit: { from: number; to: number } | null,
): { from: number; to: number } | null {
  const r = resolveDescriptor(doc, anchor);
  if (!r) return null;
  // Never land inside a `self_ref` or `transclusion_ref`: their children
  // are read-only mirrored text, so a match there is a coincidence, not
  // the real source. Treat it as unresolved.
  if (inMirroredContent(doc, r.from)) return null;
  if (limit && (r.from < limit.from || r.from >= limit.to)) return null;
  // A descriptor's `to` is the LEFT EDGE OF THE NEXT flat character
  // (`learn-anchor.ts` endPos), so a quote that runs to the end of its
  // textblock reports a `to` past the block's closing token - in the
  // next block's content. Clamp to the block holding `from`: this
  // resolves to one textblock's content range, and a caller replacing
  // the raw range would merge two blocks.
  const $from = doc.resolve(r.from);
  return { from: r.from, to: Math.min(r.to, $from.end()) };
}
