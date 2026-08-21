/**
 * External-replace primitive - backs the `POST /replace` endpoint, the
 * write-back half of provenance flow: a flowing app that received an
 * item via `/extract` hands the token plus edited text back, and the
 * named textblock's content becomes that text.
 *
 * Two invariants make this a separate route rather than a `/jump` +
 * `/insert` composition:
 *
 *   - It is SILENT. No `scrollIntoView`, no selection change, no
 *     stored marks, no focus. A settled keystroke in another app must
 *     never move this reader's caret or viewport, so the write goes in
 *     as one bare content replacement and nothing else.
 *
 *   - It re-mints the token. This is not decoration: the stored
 *     descriptor QUOTES the old text (`learn-anchor.ts`), so the
 *     instant this call succeeds the caller's token stops resolving.
 *     `resolveDescriptor` finds no occurrence of a quote that no longer
 *     exists and the context gate rejects any coincidental hit. A
 *     caller that keeps the old token gets exactly one successful edit
 *     and `not-found` forever after, so the fresh `source` in the
 *     success result MUST be stored in its place.
 *
 * One transaction per call, so a single Cmd-Z undoes the whole write and
 * `LoroSyncPlugin` mirrors it into the collab CRDT as one step batch.
 *
 * Card bodies and loose paragraphs are REFUSED (`body-text`). `/extract`
 * never emits them (`plugin-extract.ts`: "spec rule, no override"), so a
 * token naming one can only come from a stale anchor that drifted onto
 * quoted source text - and quoted source text is the one thing in the
 * document an outside app must never rewrite. The gate is a whitelist of
 * the kinds that do leave the doc, so a schema addition is refused until
 * someone decides it may travel.
 */

import { type EditorState, type Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { buildDescriptor } from './learn-anchor.js';
import { resolveSourceRange } from './plugin-source-range.js';
import { mintSourceToken, parseSourceToken } from './plugin-source-token.js';

export interface ExternalReplaceOpts {
  /** Content-range start, as `resolveSourceRange` reports it. */
  from: number;
  to: number;
  /** One line of plain text. Newlines are rejected: the route names a
   *  single textblock, and splitting it into more would change the
   *  document's structure behind the reader's back. */
  text: string;
}

/**
 * Replace `[from, to)` with a single text node. Returns `null` for input
 * this primitive refuses: empty text (an external app never deletes
 * document text), a newline (see `ExternalReplaceOpts.text`), or a range
 * outside `state.doc`.
 */
export function buildExternalReplaceTransaction(
  state: EditorState,
  opts: ExternalReplaceOpts,
): Transaction | null {
  const { from, to, text } = opts;
  if (text === '' || /[\r\n]/.test(text)) return null;
  if (from < 0 || to < from || to > state.doc.content.size) return null;

  // Carry the styling of the run the range starts on, so replacing a
  // highlighted or underlined tag doesn't hand back plain text. Marks the
  // schema declares non-inclusive (a link, a comment range, the pilcrow
  // marker) are dropped on purpose: they were drawn over that exact run,
  // not over whatever text an outside app sends next.
  const at = state.doc.resolve(from).nodeAfter;
  const marks = at ? at.marks.filter((m) => m.type.spec.inclusive !== false) : [];

  // No `scrollIntoView`, no `setSelection`, no `setStoredMarks`: an
  // external write must leave the local caret and viewport exactly where
  // the reader left them.
  return state.tr.replaceWith(from, to, state.schema.text(text, marks));
}

/** Textblock types `/replace` may rewrite: exactly what `/extract`
 *  emits - the heading kinds (`headings.ts` TYPE_TO_LEVEL) plus
 *  undertags and cites. `card_body` and doc-level `paragraph` are absent
 *  on purpose (see the header). */
const REPLACEABLE_TYPES: Record<string, true> = {
  pocket: true,
  hat: true,
  block: true,
  tag: true,
  analytic: true,
  undertag: true,
  cite_paragraph: true,
};

export type ReplaceResult =
  | { ok: true; source: string }
  | {
      ok: false;
      error: 'bad-request' | 'not-found' | 'doc-readonly' | 'body-text';
      docTitle?: string;
    };

/** Resolve a token against THIS window's doc and rewrite the textblock it
 *  names. 'not-mine' = valid token for a different docId (the caller
 *  escalates to the main-process broadcast), mirroring
 *  `jumpToTokenInView`. */
export function replaceTokenInView(
  view: EditorView,
  currentDocId: string | null,
  token: string,
  text: string,
): ReplaceResult | 'not-mine' {
  const payload = parseSourceToken(token);
  if (!payload) return { ok: false, error: 'bad-request' };
  if (!currentDocId || currentDocId !== payload.docId) return 'not-mine';
  if (!view.editable) return { ok: false, error: 'doc-readonly' };
  const range = resolveSourceRange(view.state.doc, payload);
  if (!range) return { ok: false, error: 'not-found', docTitle: payload.docTitle };
  // `from` is a content position, so its parent IS the named textblock.
  if (!REPLACEABLE_TYPES[view.state.doc.resolve(range.from).parent.type.name]) {
    return { ok: false, error: 'body-text', docTitle: payload.docTitle };
  }
  const tr = buildExternalReplaceTransaction(view.state, {
    from: range.from,
    to: range.to,
    text,
  });
  if (!tr) return { ok: false, error: 'bad-request' };
  // Dispatch ONCE: the view's own `dispatchTransaction` override is the
  // single choke point for undo history, collab sync and autosave.
  view.dispatch(tr);
  // The replacement is one text node, so it spans `from .. from + length`
  // in the doc that just landed. Re-anchor there; see the header on why
  // the caller has to keep this token.
  return {
    ok: true,
    source: mintSourceToken({
      docId: payload.docId,
      docTitle: payload.docTitle,
      headingId: payload.headingId,
      anchor: buildDescriptor(view.state.doc, range.from, range.from + text.length),
    }),
  };
}
