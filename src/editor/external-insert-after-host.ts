/**
 * Renderer-side handler for inbound insert-after requests (the fast-paste
 * bridge's `POST /insert-after`, broadcast per window). Mirrors
 * external-replace-host.ts: structural preload bridge, one ack per
 * request, and `not-mine` when the token names a doc no pane in this
 * window holds - main turns an all-`not-mine` outcome into
 * `doc-not-open`.
 *
 * Wire:
 *   - Main receives the HTTP `POST /insert-after` payload and sends an
 *     `external:insert-after` IPC with `{ requestId, source, text }`.
 *   - This module resolves the token's doc against this window's panes,
 *     adds the sibling through `insertAfterTokenInView`
 *     (`./external-insert-after.ts`), and answers on
 *     `external:insert-after-result` with
 *     `{ requestId, ok, error?, docTitle?, source? }`.
 *
 * Silent by construction, like /replace: no focus, no raise, no scroll,
 * no caret move. The flowing app calls this while its user types, so a
 * window that came forward per inserted line would be unusable.
 */

import type { EditorView } from 'prosemirror-view';
import { insertAfterTokenInView } from './external-insert-after.js';
import { parseSourceToken } from './plugin-source-token.js';

interface InsertAfterRequest {
  requestId: string;
  source: string;
  text: string;
}

interface InsertAfterAck {
  requestId: string;
  ok: boolean;
  error?: 'not-mine' | 'not-found' | 'bad-request' | 'doc-readonly' | 'body-text' | 'internal';
  docTitle?: string;
  /** Minted token for the line this call created. Mandatory on success:
   *  the line is text nothing named a moment ago, so without it the
   *  caller can never address what it just wrote. */
  source?: string;
}

/** Preload-exposed API surface this module reads. Defined here as
 *  a structural type so the renderer build doesn't take a
 *  build-time dependency on the desktop preload. */
interface ExternalInsertAfterBridge {
  onExternalInsertAfterRequest(handler: (req: InsertAfterRequest) => void): () => void;
  sendExternalInsertAfterResult(result: InsertAfterAck): void;
}

export interface ExternalInsertAfterHostOpts {
  /** Return a live view for `docId` if any pane in this window has that
   *  doc open (focused or not), else null. */
  findViewForDocId: (docId: string) => EditorView | null;
}

/** Mount the external-insert-after handler. Returns an unsubscribe
 *  function for tests / shutdown - boot-mode callers can ignore. */
export function installExternalInsertAfterHost(opts: ExternalInsertAfterHostOpts): () => void {
  const bridge = pickBridge();
  if (!bridge) return () => {};
  return bridge.onExternalInsertAfterRequest((req) => {
    bridge.sendExternalInsertAfterResult(handle(req, opts));
  });
}

function handle(req: InsertAfterRequest, opts: ExternalInsertAfterHostOpts): InsertAfterAck {
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
    // plugin's gate). A keystroke in another app must not add a line to
    // a doc the user has deliberately locked, so this is checked here
    // rather than left to the transaction builder.
    if (!view.editable) return { requestId, ok: false, error: 'doc-readonly' };
    const res = insertAfterTokenInView(view, payload.docId, req.source, req.text);
    // Unreachable while `findViewForDocId` is keyed on the token's own
    // docId; kept as a rail so a future pane-resolution change can't
    // turn a mismatch into a silent success.
    if (res === 'not-mine') return { requestId, ok: false, error: 'not-mine' };
    if (res.ok) return { requestId, ok: true, source: res.source };
    const ack: InsertAfterAck = { requestId, ok: false, error: res.error };
    if (res.docTitle) ack.docTitle = res.docTitle;
    return ack;
  } catch {
    return { requestId, ok: false, error: 'internal' };
  }
}

function pickBridge(): ExternalInsertAfterBridge | null {
  const w = window as unknown as { electronAPI?: ExternalInsertAfterBridge };
  const api = w.electronAPI;
  if (!api) return null;
  if (typeof api.onExternalInsertAfterRequest !== 'function') return null;
  if (typeof api.sendExternalInsertAfterResult !== 'function') return null;
  return api;
}
