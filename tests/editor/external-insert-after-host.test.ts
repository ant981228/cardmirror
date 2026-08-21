// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { installExternalInsertAfterHost } from '../../src/editor/external-insert-after-host.js';
import { mintSourceToken, parseSourceToken } from '../../src/editor/plugin-source-token.js';

/** Live view over a one-card doc whose tag carries `id`, which is what
 *  the request tokens address. */
function buildView(id: string): { view: EditorView; cleanup: () => void } {
  const doc = schema.nodes['doc']!.createChecked(null, [
    schema.nodes['card']!.createChecked(null, [
      schema.nodes['tag']!.create({ id }, schema.text('The plan causes inequality.')),
      schema.nodes['card_body']!.create(
        null,
        schema.text('Body sentence long enough to supply real anchor context.'),
      ),
    ]),
  ]);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const view = new EditorView(container, { state: EditorState.create({ doc }) });
  return { view, cleanup: () => { view.destroy(); container.remove(); } };
}

interface InsertAfterRequest {
  requestId: string;
  source: string;
  text: string;
}
interface InsertAfterAck {
  requestId: string;
  ok: boolean;
  error?: string;
  docTitle?: string;
  source?: string;
}
interface InsertAfterHandler {
  (req: InsertAfterRequest): void;
}

/** Minimal stand-in for the preload insert-after bridge
 *  (`window.electronAPI`). Captures the registered handler so a test
 *  can fire a request, and records every ack the host sends back. */
function installFakeBridge(): {
  fire: (req: InsertAfterRequest) => void;
  acks: InsertAfterAck[];
} {
  const acks: InsertAfterAck[] = [];
  let pending: InsertAfterHandler | null = null;
  const w = window as unknown as { electronAPI?: unknown };
  w.electronAPI = {
    onExternalInsertAfterRequest: (h: InsertAfterHandler): (() => void) => {
      pending = h;
      return () => { pending = null; };
    },
    sendExternalInsertAfterResult: (r: InsertAfterAck): void => { acks.push(r); },
  };
  return { fire: (req) => pending?.(req), acks };
}

describe('installExternalInsertAfterHost', () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    cleanup?.(); cleanup = null;
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('no electronAPI present → no-op subscribe (returns unsubscribe)', () => {
    const unsubscribe = installExternalInsertAfterHost({ findViewForDocId: () => null });
    expect(typeof unsubscribe).toBe('function');
    expect(() => unsubscribe()).not.toThrow();
  });

  it("adds a line in this window's doc and acks a token naming it", () => {
    const bridge = installFakeBridge();
    const id = newHeadingId();
    const { view, cleanup: vc } = buildView(id);
    cleanup = vc;
    // The route is silent by contract: no focus, no raise, no scroll.
    const focus = vi.spyOn(view, 'focus');
    installExternalInsertAfterHost({
      findViewForDocId: (docId) => (docId === 'd1' ? view : null),
    });

    const token = mintSourceToken({ docId: 'd1', docTitle: 'T', headingId: id, anchor: null });
    bridge.fire({ requestId: 'r1', source: token, text: 'And it causes poverty.' });

    expect(bridge.acks).toHaveLength(1);
    const ack = bridge.acks[0]!;
    expect(ack.requestId).toBe('r1');
    expect(ack.ok).toBe(true);
    // The token is mandatory and new: it names a line that did not exist
    // when the request was sent, so it can never be the token that came in.
    expect(ack.source).not.toBe(token);
    expect(parseSourceToken(ack.source!)!.anchor!.quote).toBe('And it causes poverty.');
    // A tag anchor gets a new card of its own, and the anchor's card keeps
    // its own text.
    expect(view.state.doc.childCount).toBe(2);
    expect(view.state.doc.child(1).child(0).textContent).toBe('And it causes poverty.');
    expect(view.state.doc.child(0).child(0).textContent).toBe('The plan causes inequality.');
    expect(focus).not.toHaveBeenCalled();
  });

  it("acks not-mine for a token naming a doc this window doesn't hold", () => {
    const bridge = installFakeBridge();
    const id = newHeadingId();
    const { view, cleanup: vc } = buildView(id);
    cleanup = vc;
    installExternalInsertAfterHost({
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
    installExternalInsertAfterHost({ findViewForDocId: () => view });

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
    installExternalInsertAfterHost({ findViewForDocId: () => view });

    bridge.fire({ requestId: 'r4', source: 'garbage', text: 'x' });

    expect(bridge.acks[0]).toEqual({ requestId: 'r4', ok: false, error: 'bad-request' });
  });

  it('unsubscribing stops answering', () => {
    const bridge = installFakeBridge();
    const id = newHeadingId();
    const { view, cleanup: vc } = buildView(id);
    cleanup = vc;
    const unsubscribe = installExternalInsertAfterHost({ findViewForDocId: () => view });

    unsubscribe();
    const token = mintSourceToken({ docId: 'd1', docTitle: 'T', headingId: id, anchor: null });
    bridge.fire({ requestId: 'r5', source: token, text: 'after teardown' });

    expect(bridge.acks).toHaveLength(0);
    expect(view.state.doc.textContent).not.toContain('after teardown');
  });
});
