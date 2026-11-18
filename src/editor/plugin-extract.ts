// src/editor/plugin-extract.ts
/**
 * Plugin extraction - the core-owned, opinionated "what leaves the doc"
 * step of send-to-flow. Emits typed heading-like items only. Card
 * bodies and loose paragraphs NEVER emit (spec rule, no override).
 * Undertags always emit; the plugin decides what to do with them.
 */
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import {
  collectHeadings,
  computeHeadingRange,
  collectCiteText,
  TYPE_TO_LEVEL,
  type HeadingEntry,
} from './headings.js';
import { createDescriptorBuilder } from './learn-anchor.js';
import { mintSourceToken } from './plugin-source-token.js';
import type {
  ExtractResult,
  ExtractError,
  ExtractedItem,
  ExtractedKind,
} from './plugin-api.js';

export function extractSelection(
  view: EditorView,
  ident: { docId: string; docTitle: string },
): ExtractResult | ExtractError {
  const { doc } = view.state;
  const sel = view.state.selection;
  let from: number;
  let to: number;
  if (sel.empty) {
    const range = enclosingSectionRange(doc, sel.from);
    if (!range) return { ok: false, error: 'no-heading-at-cursor' };
    from = range.from;
    to = range.to;
  } else {
    from = sel.from;
    to = sel.to;
  }
  const items = collectItems(doc, from, to, ident);
  if (items.length === 0) return { ok: false, error: 'empty-selection' };
  return { ok: true, docId: ident.docId, docTitle: ident.docTitle, items };
}

/** The section of the nearest heading whose range contains `pos` -
 *  walking outward: a tag whose card ended before `pos` is skipped in
 *  favor of the enclosing block/hat/pocket. Null above all headings. */
function enclosingSectionRange(
  doc: PMNode,
  pos: number,
): { from: number; to: number } | null {
  const headings = collectHeadings(doc, { skipCite: true });
  let idx = -1;
  for (let i = 0; i < headings.length; i++) {
    if (headings[i]!.pos <= pos) idx = i;
    else break;
  }
  for (let i = idx; i >= 0; i--) {
    const r = computeHeadingRange(doc, headings[i]!);
    if (r && pos >= r.from && pos <= r.to) return r;
  }
  return null;
}

/** The id of the nearest heading whose section CONTAINS content position
 *  `pos`, walking outward like `enclosingSectionRange`. This is the
 *  token's scope, and the resolver searches only inside it, so a heading
 *  that merely comes earlier (a card that ended before a doc-level
 *  undertag) would mint a token that can never resolve. */
function scopeHeadingId(doc: PMNode, headings: HeadingEntry[], pos: number): string | null {
  for (let i = headings.length - 1; i >= 0; i--) {
    const h = headings[i]!;
    if (h.pos >= pos) continue;
    const r = computeHeadingRange(doc, h);
    // An id-less heading cannot scope a token; keep walking outward.
    if (h.id && r && pos >= r.from && pos < r.to) return h.id;
  }
  return null;
}

function collectItems(
  doc: PMNode,
  from: number,
  to: number,
  ident: { docId: string; docTitle: string },
): ExtractedItem[] {
  const items: ExtractedItem[] = [];
  const headings = collectHeadings(doc, { skipCite: true }); // once, not per item
  const buildDescriptor = createDescriptorBuilder(doc); // flatten once, not per item
  doc.nodesBetween(from, to, (node, pos) => {
    // Live-view / linked-copy containers hold DERIVED, id-less mirror content
    // (a duplicate of a section that lives elsewhere in this doc, or in
    // another file). Emitting it would double up items with wrong
    // attribution, so skip the whole subtree - same guard collectHeadings
    // uses for self_ref.
    if (node.type.name === 'self_ref' || node.type.name === 'transclusion_ref') return false;
    // Emission is per-TEXTBLOCK: a selection that merely grazes a block
    // still emits that block's full text. Deliberate — the emitted text
    // doubles as the jump anchor's quote, and a partial-line quote would
    // fail to re-resolve after ordinary edits.
    if (!node.isTextblock) return true; // descend into card / analytic_unit / etc.
    const type = node.type.name;
    let kind: ExtractedKind | null = null;
    let text = '';
    /** The heading this item IS, as opposed to the one it lives under. */
    let ownHeadingId: string | null = null;
    if (type in TYPE_TO_LEVEL) {
      kind = type as ExtractedKind;
      text = node.textContent;
      const id = node.attrs['id'];
      ownHeadingId = typeof id === 'string' && id ? id : null;
    } else if (type === 'undertag') {
      kind = 'undertag';
      text = node.textContent;
    } else if (type === 'cite_paragraph') {
      kind = 'cite';
      text = collectCiteText(node);
    }
    if (!kind) return false; // card_body / paragraph: never emitted
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return false;
    const contentFrom = pos + 1;
    const contentTo = pos + node.nodeSize - 1;
    const anchor = contentTo > contentFrom ? buildDescriptor(contentFrom, contentTo) : null;
    items.push({
      kind,
      text: clean,
      source: mintSourceToken({
        docId: ident.docId,
        docTitle: ident.docTitle,
        // An undertag or a cite names no heading: its governing heading is
        // SCOPE for the anchor, and naming it as the target is what used to
        // resolve those items to the tag above them.
        headingId: ownHeadingId,
        // A heading is its own scope; anything else lives in the section
        // that contains it.
        scopeId: ownHeadingId ?? scopeHeadingId(doc, headings, contentFrom),
        anchor,
      }),
    });
    return false;
  });
  return items;
}
