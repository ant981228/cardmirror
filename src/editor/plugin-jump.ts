/**
 * Shared jump resolution for plugin provenance tokens — used by
 * api.jumpToSource (local window) and the inbound /jump host.
 * Resolution is `resolveSourceRange`, shared with /replace and /insert-after.
 */
import type { EditorView } from 'prosemirror-view';
import { TextSelection } from 'prosemirror-state';
import { resolveSourceRange } from './plugin-source-range.js';
import { parseSourceToken, type SourcePayload } from './plugin-source-token.js';
import { scrollToHeadingId } from './precise-scroll.js';
import type { JumpResult } from './plugin-api.js';

export function resolveJumpInView(view: EditorView, payload: SourcePayload): boolean {
  // The same resolution /replace and /insert-after use, so a jump always
  // lands on the line those routes would write.
  const range = resolveSourceRange(view.state.doc, payload);
  if (!range) return false;
  const id = view.state.doc.resolve(range.from).parent.attrs['id'];
  select(view, range.from, payload.headingId && id === payload.headingId ? id : undefined);
  return true;
}

function select(view: EditorView, pos: number, headingId?: string): void {
  const tr = view.state.tr;
  tr.setSelection(TextSelection.create(tr.doc, Math.min(pos, tr.doc.content.size)));
  view.dispatch(tr);
  // Route through the nav-pane precise-scroll path when a heading id is
  // known and rendered; fall back to a plain scroll (anchor-only jumps,
  // or a headless/test DOM where the element isn't present).
  if (!headingId || !scrollToHeadingId(view, headingId)) {
    view.dispatch(view.state.tr.scrollIntoView());
  }
  view.focus();
}

/** Resolve a token against THIS window's doc. 'not-mine' = valid token
 *  for a different docId (the caller escalates to the main-process
 *  broadcast). */
export function jumpToTokenInView(
  view: EditorView,
  currentDocId: string | null,
  token: string,
): JumpResult | 'not-mine' {
  const payload = parseSourceToken(token);
  if (!payload) return { ok: false, error: 'bad-request' };
  if (!currentDocId || currentDocId !== payload.docId) return 'not-mine';
  if (resolveJumpInView(view, payload)) return { ok: true };
  return { ok: false, error: 'not-found', docTitle: payload.docTitle };
}
