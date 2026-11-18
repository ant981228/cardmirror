/**
 * Renderer-side handler for inbound jump requests (the fast-paste
 * bridge's POST /jump, broadcast per window). Mirrors
 * external-insert-host.ts: structural preload bridge, ack per request.
 */
import type { EditorView } from 'prosemirror-view';
import { jumpToTokenInView } from './plugin-jump.js';
import { parseSourceToken } from './plugin-source-token.js';

interface JumpRequest {
  requestId: string;
  source: string;
}
interface JumpAck {
  requestId: string;
  ok: boolean;
  error?: 'not-mine' | 'not-found' | 'bad-request';
}

/** Preload-exposed API surface this module reads. Defined here as
 *  a structural type so the renderer build doesn't take a
 *  build-time dependency on the desktop preload. */
interface JumpBridge {
  onExternalJumpRequest(handler: (req: JumpRequest) => void): () => void;
  sendExternalJumpResult(result: JumpAck): void;
}

export interface PluginJumpHostOpts {
  /** Return a live view for `docId` if any pane in this window has that
   *  doc open (focused or not), else null. `raise` surfaces a background
   *  pane; the jump is the ONE route that asks for it, because landing the
   *  caret somewhere the user cannot see is the same as doing nothing. The
   *  silent routes (`/replace`, `/insert-after`) call the same
   *  resolver without it. */
  findViewForDocId: (docId: string, opts?: { raise?: boolean }) => EditorView | null;
}

export function installPluginJumpHost(opts: PluginJumpHostOpts): () => void {
  const bridge = pickBridge();
  if (!bridge) return () => {};
  return bridge.onExternalJumpRequest((req) => {
    const requestId = req.requestId;
    // Parse FIRST: a garbage token is `bad-request` regardless of which
    // panes are open, so it never masquerades as `not-mine`.
    const payload = parseSourceToken(req.source);
    if (!payload) {
      bridge.sendExternalJumpResult({ requestId, ok: false, error: 'bad-request' });
      return;
    }
    const view = opts.findViewForDocId(payload.docId, { raise: true });
    if (!view) {
      bridge.sendExternalJumpResult({ requestId, ok: false, error: 'not-mine' });
      return;
    }
    const res = jumpToTokenInView(view, payload.docId, req.source);
    if (res === 'not-mine') {
      bridge.sendExternalJumpResult({ requestId, ok: false, error: 'not-mine' });
    } else if (res.ok) {
      bridge.sendExternalJumpResult({ requestId, ok: true });
    } else {
      bridge.sendExternalJumpResult({
        requestId,
        ok: false,
        error: res.error === 'doc-not-open' ? 'not-mine' : res.error,
      });
    }
  });
}

function pickBridge(): JumpBridge | null {
  const w = window as unknown as { electronAPI?: JumpBridge };
  const api = w.electronAPI;
  if (!api) return null;
  if (typeof api.onExternalJumpRequest !== 'function') return null;
  if (typeof api.sendExternalJumpResult !== 'function') return null;
  return api;
}
