// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { installExternalReplaceHost } from '../../src/editor/external-replace-host.js';
import { mintSourceToken } from '../../src/editor/plugin-source-token.js';

function heading(text: string, id = newHeadingId()) {
  return schema.nodes['block']!.create({ id }, schema.text(text));
}

/** Live view over a two-heading doc; the second heading carries `id`,
 *  which is what the request tokens address. */
function buildView(id: string): { view: EditorView; cleanup: () => void } {
  const doc = schema.nodes['doc']!.createChecked(null, [
    heading('One'),
    heading('The plan causes inequality.', id),
  ]);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const view = new EditorView(container, { state: EditorState.create({ doc }) });
  return { view, cleanup: () => { view.destroy(); container.remove(); } };
}

interface ReplaceRequest {
  requestId: string;
  source: string;
  text: string;
}
interface ReplaceAck {
  requestId: string;
  ok: boolean;
  error?: string;
  docTitle?: string;
  source?: string;
}
interface ReplaceHandler {
  (req: ReplaceRequest): void;
}

/** Minimal stand-in for the preload replace bridge
 *  (`window.electronAPI`). Captures the registered handler so a test
 *  can fire a request, and records every ack the host sends back. */
function installFakeBridge(): {
  fire: (req: ReplaceRequest) => void;
  acks: ReplaceAck[];
} {
  const acks: ReplaceAck[] = [];
  let pending: ReplaceHandler | null = null;
  const w = window as unknown as { electronAPI?: unknown };
  w.electronAPI = {
    onExternalReplaceRequest: (h: ReplaceHandler): (() => void) => {
      pending = h;
      return () => { pending = null; };
    },
    sendExternalReplaceResult: (r: ReplaceAck): void => { acks.push(r); },
  };
  return { fire: (req) => pending?.(req), acks };
}

describe('installExternalReplaceHost', () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    cleanup?.(); cleanup = null;
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('no electronAPI present → no-op subscribe (returns unsubscribe)', () => {
    const unsubscribe = installExternalReplaceHost({ findViewForDocId: () => null });
    expect(typeof unsubscribe).toBe('function');
    expect(() => unsubscribe()).not.toThrow();
  });

  it("replaces in this window's doc and acks a freshly minted source token", () => {
    const bridge = installFakeBridge();
    const id = newHeadingId();
    const { view, cleanup: vc } = buildView(id);
    cleanup = vc;
    // The route is silent by contract: no focus, no raise, no scroll.
    const focus = vi.spyOn(view, 'focus');
    installExternalReplaceHost({
      findViewForDocId: (docId) => (docId === 'd1' ? view : null),
    });

    const token = mintSourceToken({ docId: 'd1', docTitle: 'T', headingId: id, anchor: null });
    bridge.fire({ requestId: 'r1', source: token, text: 'The plan causes poverty.' });

    expect(bridge.acks).toHaveLength(1);
    const ack = bridge.acks[0]!;
    expect(ack.requestId).toBe('r1');
    expect(ack.ok).toBe(true);
    // The re-mint is mandatory: the request token anchors the OLD text,
    // so a stale echo would cap the cell at exactly one edit.
    expect(typeof ack.source).toBe('string');
    expect(ack.source).not.toBe(token);
    expect(view.state.doc.textContent).toContain('The plan causes poverty.');
    expect(view.state.doc.textContent).not.toContain('inequality');
    expect(focus).not.toHaveBeenCalled();
  });

  it("acks not-mine for a token naming a doc this window doesn't hold", () => {
    const bridge = installFakeBridge();
    const id = newHeadingId();
    const { view, cleanup: vc } = buildView(id);
    cleanup = vc;
    installExternalReplaceHost({
      findViewForDocId: (docId) => (docId === 'd1' ? view : null),
    });

    const token = mintSourceToken({ docId: 'other', docTitle: 'O', headingId: id, anchor: null });
    bridge.fire({ requestId: 'r2', source: token, text: 'nope' });

    expect(bridge.acks[0]).toEqual({ requestId: 'r2', ok: false, error: 'not-mine' });
    expect(view.state.doc.textContent).not.toContain('nope');
  });

  it('acks doc-readonly when the addressed doc is in read mode', () => {
    const bridge = installFakeBridge();
    const id = newHeadingId();
    const { view, cleanup: vc } = buildView(id);
    cleanup = vc;
    // Mimic the read-mode plugin flipping editable to false.
    view.setProps({ editable: () => false });
    installExternalReplaceHost({ findViewForDocId: () => view });

    const token = mintSourceToken({ docId: 'd1', docTitle: 'T', headingId: id, anchor: null });
    bridge.fire({ requestId: 'r3', source: token, text: 'locked out' });

    expect(bridge.acks[0]).toEqual({ requestId: 'r3', ok: false, error: 'doc-readonly' });
    expect(view.state.doc.textContent).not.toContain('locked out');
  });

  it('acks bad-request for a garbage token, whatever is open', () => {
    const bridge = installFakeBridge();
    const id = newHeadingId();
    const { view, cleanup: vc } = buildView(id);
    cleanup = vc;
    installExternalReplaceHost({ findViewForDocId: () => view });

    bridge.fire({ requestId: 'r4', source: 'garbage', text: 'x' });

    expect(bridge.acks[0]).toEqual({ requestId: 'r4', ok: false, error: 'bad-request' });
  });

  it('unsubscribing stops answering', () => {
    const bridge = installFakeBridge();
    const id = newHeadingId();
    const { view, cleanup: vc } = buildView(id);
    cleanup = vc;
    const unsubscribe = installExternalReplaceHost({ findViewForDocId: () => view });

    unsubscribe();
    const token = mintSourceToken({ docId: 'd1', docTitle: 'T', headingId: id, anchor: null });
    bridge.fire({ requestId: 'r5', source: token, text: 'after teardown' });

    expect(bridge.acks).toHaveLength(0);
    expect(view.state.doc.textContent).not.toContain('after teardown');
  });
});
