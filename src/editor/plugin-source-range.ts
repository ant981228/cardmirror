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
import {
  backMatch,
  CONTEXT,
  flattenDoc,
  MIN_CONTEXT_FRACTION,
  resolveDescriptor,
  type AnchorDescriptor,
} from './learn-anchor.js';
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
 * Order: `headingId` names a heading and wins outright (a legacy token,
 * which has no `scopeId`, is checked first; see below); otherwise the
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
      const node = doc.nodeAt(entry.pos);
      // `nodeAt` can't miss (the pos came from a doc walk); the null is a rail.
      if (!node) return null;
      const own = { from: entry.pos + 1, to: entry.pos + node.nodeSize - 1 };
      // A token with `scopeId` names this heading: a found UUID is final,
      // and never falls through to the anchor, or a renamed heading would
      // silently retarget whatever text still matches the stale quote.
      if (payload.scopeId !== null || !payload.anchor) return own;
      // Tokens minted before the target/scope split carry the GOVERNING
      // heading here even for an undertag or a cite, and they are already
      // stored in companion apps. Nothing in such a token says which kind
      // it was, so the anchor's context decides: a heading's own token was
      // minted with the text before the heading as its prefix.
      if (prefixSitsBefore(doc, own.from, payload.anchor)) return own;
      const section = computeHeadingRange(doc, entry);
      const scoped = section ? anchorRange(doc, payload.anchor, section) : null;
      // The anchor still finds a line inside the section: that is the line
      // the token was minted for, the heading included.
      if (scoped) return scoped;
      // Neither the heading's surroundings nor the quote match. Either a
      // renamed heading whose neighbours also changed, or an undertag or
      // cite the user rewrote. Answering with the heading would overwrite
      // a tag in the second case, so it is not-found.
      return null;
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
  // The token names a whole line, so answer with the content range of the
  // textblock the quote landed in, not the quote's own span. After the
  // user adds to the line in CardMirror the quote covers only part of it,
  // and a write over the quote would leave the addition stuck to the new
  // text. This also keeps the range inside one block: a descriptor's `to`
  // can sit in the next block's content.
  const $from = doc.resolve(r.from);
  return { from: $from.start(), to: $from.end() };
}

/** True when the flat text just before `pos` matches `anchor.prefix` well
 *  enough to say the anchor was minted at `pos` - the same context bar
 *  `resolveDescriptor` applies. An empty prefix means the quote opened
 *  the document, so the text before `pos` must be empty too. */
function prefixSitsBefore(doc: PMNode, pos: number, anchor: AnchorDescriptor): boolean {
  const flat = flattenDoc(doc);
  let i = flat.pos.findIndex((p) => p >= pos);
  if (i < 0) i = flat.text.length;
  const before = flat.text.slice(Math.max(0, i - CONTEXT), i);
  if (anchor.prefix === '') return before === '';
  const need = Math.ceil(Math.min(anchor.prefix.length, CONTEXT) * MIN_CONTEXT_FRACTION);
  return backMatch(before, anchor.prefix) >= need;
}
