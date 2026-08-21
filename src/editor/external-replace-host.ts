/**
 * Renderer-side handler for inbound replace requests (the fast-paste
 * bridge's `POST /replace`, broadcast per window). Mirrors
 * plugin-jump-host.ts: structural preload bridge, one ack per request,
 * and `not-mine` when the token names a doc no pane in this window
 * holds - main turns an all-`not-mine` outcome into `doc-not-open`.
 *
 * Wire:
 *   - Main receives the HTTP `POST /replace` payload and sends an
 *     `external:replace-text` IPC with `{ requestId, source, text }`.
 *   - This module resolves the token's doc against this window's panes,
 *     applies the replacement through `replaceTokenInView`
 *     (`./external-replace.ts`), and answers on
 *     `external:replace-result` with
 *     `{ requestId, ok, error?, docTitle?, source? }`.
 *
 * Unlike /jump, this path is silent by construction: it never focuses,
 * raises or scrolls a window and never moves the caret. The flowing app
 * calls it on every settled keystroke, so stealing the reader's place
 * would be worse than not mirroring the edit at all.
 */

import type { EditorView } from 'prosemirror-view';
import { replaceTokenInView } from './external-replace.js';
import { parseSourceToken } from './plugin-source-token.js';

interface ReplaceRequest {
  requestId: string;
  source: string;
  text: string;
}

interface ReplaceAck {
  requestId: string;
  ok: boolean;
  error?: 'not-mine' | 'not-found' | 'bad-request' | 'doc-readonly' | 'body-text' | 'internal';
  docTitle?: string;
  /** Freshly minted token for the replaced range. Mandatory on success:
   *  the caller's stored token anchors on the OLD text, so without a
   *  re-mint only the first edit of a given cell would ever resolve. */
  source?: string;
}

/** Preload-exposed API surface this module reads. Defined here as
 *  a structural type so the renderer build doesn't take a
 *  build-time dependency on the desktop preload. */
interface ExternalReplaceBridge {
  onExternalReplaceRequest(handler: (req: ReplaceRequest) => void): () => void;
  sendExternalReplaceResult(result: ReplaceAck): void;
}

export interface ExternalReplaceHostOpts {
  /** Return a live view for `docId` if any pane in this window has that
   *  doc open (focused or not), else null. */
  findViewForDocId: (docId: string) => EditorView | null;
}

/** Mount the external-replace handler. Returns an unsubscribe
 *  function for tests / shutdown - boot-mode callers can ignore. */
export function installExternalReplaceHost(opts: ExternalReplaceHostOpts): () => void {
  const bridge = pickBridge();
  if (!bridge) return () => {};
  return bridge.onExternalReplaceRequest((req) => {
    bridge.sendExternalReplaceResult(handle(req, opts));
  });
}

function handle(req: ReplaceRequest, opts: ExternalReplaceHostOpts): ReplaceAck {
  const requestId = req.requestId;
  try {
    if (typeof requestId !== 'string' || typeof req.source !== 'string' || typeof req.text !== 'string') {
      return { requestId, ok: false, error: 'bad-request' };
    }
    // Parse FIRST: a garbage token is `bad-request` regardless of which
    // panes are open, so it never masquerades as `not-mine`.
    const payload = parseSourceToken(req.source);
    if (!payload) return { requestId, ok: false, error: 'bad-request' };
    const view = opts.findViewForDocId(payload.docId);
    if (!view) return { requestId, ok: false, error: 'not-mine' };
    // Read mode flips the view's `editable` false (the read-mode
    // plugin's gate). A keystroke in another app must not rewrite a doc
    // the user has deliberately locked, so this is checked here rather
    // than left to the transaction builder.
    if (!view.editable) return { requestId, ok: false, error: 'doc-readonly' };
    const res = replaceTokenInView(view, payload.docId, req.source, req.text);
    // Unreachable while `findViewForDocId` is keyed on the token's own
    // docId; kept as a rail so a future pane-resolution change can't
    // turn a mismatch into a silent success.
    if (res === 'not-mine') return { requestId, ok: false, error: 'not-mine' };
    if (res.ok) return { requestId, ok: true, source: res.source };
    const ack: ReplaceAck = { requestId, ok: false, error: res.error };
    if (res.docTitle) ack.docTitle = res.docTitle;
    return ack;
  } catch {
    return { requestId, ok: false, error: 'internal' };
  }
}

function pickBridge(): ExternalReplaceBridge | null {
  const w = window as unknown as { electronAPI?: ExternalReplaceBridge };
  const api = w.electronAPI;
  if (!api) return null;
  if (typeof api.onExternalReplaceRequest !== 'function') return null;
  if (typeof api.sendExternalReplaceResult !== 'function') return null;
  return api;
}
