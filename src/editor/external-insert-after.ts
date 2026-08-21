/**
 * External-insert-after primitive - backs the `POST /insert-after`
 * endpoint, the third member of the provenance write-back family beside
 * `/replace` (rewrite the textblock a token names) and `/jump` (steer to
 * it).
 *
 * The gap it fills: a flowing app that received items through
 * `/extract` marks them as coming from a document. When its user types a
 * NEW line between two of those items, that line belongs in the
 * document too - and neither existing route can put it there.
 * `/replace` only rewrites text that already exists, and `/insert`
 * writes at the caret of a focused document, which is neither anchored
 * nor silent. So: one token, one new textblock, immediately after the
 * textblock that token names.
 *
 * What it shares with `/replace`:
 *
 *   - It is SILENT. No `scrollIntoView`, no selection change, no
 *     stored marks, no focus. The insert lands unasked, on a settled
 *     keystroke in another app, and must never move this reader's caret
 *     or viewport.
 *
 *   - It mints a token, and the caller needs it. The inserted line is
 *     text nothing named a moment ago, so an `ok` without a token leaves
 *     the caller unable to address the line it just created - it could
 *     never edit it through `/replace`, jump to it, or insert after it in
 *     turn. The token in the success result is the only handle to it.
 *
 * What is its own:
 *
 *   - The new block is a SIBLING OF THE ANCHOR'S OWN TYPE. An outside
 *     app names a line, never a structure, so the kind is read off the
 *     anchor rather than sent. `tag` is only ever a `card`'s first child
 *     and `analytic` only ever an `analytic_unit`'s (`src/schema/nodes.ts`),
 *     so those two arrive wrapped in a fresh single-heading container
 *     placed after the anchor's container; every other kind goes in
 *     beside the anchor node itself, which the `card` /
 *     `analytic_unit` content expressions allow.
 *
 *   - The text is PLAIN. `/replace` carries the styling of the run it
 *     overwrites; here there is no run to inherit from. This is new text
 *     nobody styled, and dressing it in a neighbour's marks would be a
 *     guess about intent.
 *
 * Anchor kinds are the whitelist `/replace` accepts
 * (`EXTERNAL_WRITABLE_TYPES`): a token naming card body text can only
 * come from an anchor that drifted onto quoted source text, and a
 * `card_body` sibling would mean an outside app authoring evidence.
 *
 * One transaction per call, so a single Cmd-Z removes the whole insert
 * and `LoroSyncPlugin` mirrors it into the collab CRDT as one step batch.
 */

import { type EditorState, type Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { newHeadingId } from '../schema/ids.js';
import { HEADING_CONTAINER } from './external-insert.js';
import { EXTERNAL_WRITABLE_TYPES } from './external-replace.js';
import { buildDescriptor } from './learn-anchor.js';
import { resolveSourceRange } from './plugin-source-range.js';
import { mintSourceToken, parseSourceToken } from './plugin-source-token.js';

export interface ExternalInsertAfterOpts {
  /** A content position inside the anchor textblock - `resolveSourceRange`
   *  reports one as its `from`, and its parent IS the anchor. */
  anchor: number;
  /** One line of plain text. Newlines are rejected: this route adds one
   *  block, and splitting `text` would build a structure the caller never
   *  described. Callers that want structure use `/insert`'s roles. */
  text: string;
}

export interface ExternalInsertAfterPlan {
  tr: Transaction;
  /** Where the new node goes in: after the anchor node, or after the
   *  anchor's container for the two kinds that need one. */
  at: number;
  /** Content start of the inserted textblock - `at` plus one token to
   *  enter each level it was wrapped in. Arithmetic, so the caller
   *  verifies it against the doc the transaction produced. */
  contentStart: number;
  /** Type name of the inserted textblock: the anchor's own. */
  type: string;
  /** Id stamped on the inserted heading; null for undertag / cite. */
  headingId: string | null;
}

/**
 * Build the one transaction that puts a new same-type sibling after the
 * textblock holding `anchor`. Returns `null` for input this primitive
 * refuses: empty text (an external app only ever adds a line here), a
 * newline (see `ExternalInsertAfterOpts.text`), a position that is not
 * inside a textblock of `state.doc`, or a schema missing the container a
 * `tag` / `analytic` needs (a defensive rail for other host contexts;
 * never our schema).
 */
export function buildExternalInsertAfterTransaction(
  state: EditorState,
  opts: ExternalInsertAfterOpts,
): ExternalInsertAfterPlan | null {
  const { anchor, text } = opts;
  if (text === '' || /[\r\n]/.test(text)) return null;
  if (anchor < 0 || anchor > state.doc.content.size) return null;

  const $anchor = state.doc.resolve(anchor);
  const type = $anchor.parent.type;
  if (!type.isTextblock) return null;
  // `hasOwn`, not a truthy read: pocket / hat / block ARE heading kinds
  // that map to no container, so a present-but-undefined entry answers
  // "heading, stands alone" while an absent one answers "undertag / cite".
  const isHeading = Object.hasOwn(HEADING_CONTAINER, type.name);
  const containerName = HEADING_CONTAINER[type.name];
  const containerType = containerName ? state.schema.nodes[containerName] : undefined;
  if (containerName && !containerType) return null;
  // A tag is only legal as a card's first child (an analytic likewise in
  // an analytic_unit), so the sibling slot for those two is after the
  // whole container, never between the container's own children.
  const depth = containerType ? $anchor.depth - 1 : $anchor.depth;
  if (depth < 1) return null;
  if (containerType && $anchor.node(depth).type !== containerType) return null;

  // Heading kinds carry a stable id (schema/ids.ts); one built without it
  // is invisible to the nav pane, the same stamp `buildHeadingNodes` makes.
  const headingId = isHeading ? newHeadingId() : null;
  const block = type.create(isHeading ? { id: headingId } : null, state.schema.text(text));
  const at = $anchor.after(depth);
  // No `scrollIntoView`, no `setSelection`, no `setStoredMarks`: an
  // external write leaves the local caret and viewport where the reader
  // left them.
  return {
    tr: state.tr.insert(at, containerType ? containerType.create(null, block) : block),
    at,
    contentStart: at + (containerType ? 2 : 1),
    type: type.name,
    headingId,
  };
}

export type InsertAfterResult =
  | { ok: true; source: string }
  | {
      ok: false;
      error: 'bad-request' | 'not-found' | 'doc-readonly' | 'body-text' | 'internal';
      docTitle?: string;
    };

/** Resolve a token against THIS window's doc and insert a sibling after
 *  the textblock it names. 'not-mine' = valid token for a different docId
 *  (the caller escalates to the main-process broadcast), mirroring
 *  `replaceTokenInView`. */
export function insertAfterTokenInView(
  view: EditorView,
  currentDocId: string | null,
  token: string,
  text: string,
): InsertAfterResult | 'not-mine' {
  const payload = parseSourceToken(token);
  if (!payload) return { ok: false, error: 'bad-request' };
  if (!currentDocId || currentDocId !== payload.docId) return 'not-mine';
  if (!view.editable) return { ok: false, error: 'doc-readonly' };
  const range = resolveSourceRange(view.state.doc, payload);
  if (!range) return { ok: false, error: 'not-found', docTitle: payload.docTitle };
  // `from` is a content position, so its parent IS the named textblock.
  if (!EXTERNAL_WRITABLE_TYPES[view.state.doc.resolve(range.from).parent.type.name]) {
    return { ok: false, error: 'body-text', docTitle: payload.docTitle };
  }
  const plan = buildExternalInsertAfterTransaction(view.state, { anchor: range.from, text });
  if (!plan) return { ok: false, error: 'bad-request' };
  // Dispatch ONCE: the view's own `dispatchTransaction` override is the
  // single choke point for undo history, collab sync and autosave.
  view.dispatch(plan.tr);
  // Mint against the landed document, never the arithmetic alone: slice
  // fitting is free to move or wrap an inserted node, and a token minted
  // over the wrong range would name a line the caller never wrote. If the
  // computed content start does not hold exactly the line we just sent,
  // the insert is in the document but unaddressable - which is `internal`,
  // for the same reason a re-mint failure is in `/replace`.
  const doc = view.state.doc;
  if (plan.contentStart + text.length > doc.content.size) {
    return { ok: false, error: 'internal' };
  }
  const $landed = doc.resolve(plan.contentStart);
  if (
    $landed.parent.type.name !== plan.type ||
    $landed.parentOffset !== 0 ||
    $landed.parent.textContent !== text
  ) {
    return { ok: false, error: 'internal' };
  }
  return {
    ok: true,
    source: mintSourceToken({
      docId: payload.docId,
      docTitle: payload.docTitle,
      // A fresh heading owns its own id; for an undertag or a cite the
      // governing heading is still the one the anchor's token named.
      headingId: plan.headingId ?? payload.headingId,
      anchor: buildDescriptor(doc, plan.contentStart, plan.contentStart + text.length),
    }),
  };
}
