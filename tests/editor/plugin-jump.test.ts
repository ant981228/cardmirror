// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { jumpToTokenInView } from '../../src/editor/plugin-jump.js';
import { installPluginJumpHost } from '../../src/editor/plugin-jump-host.js';
import { mintSourceToken } from '../../src/editor/plugin-source-token.js';

/** Minimal stand-in for the preload jump bridge (`window.electronAPI`).
 *  Captures the single registered handler so a test can fire a request,
 *  and records every ack the host sends back. */
function installStubBridge() {
  let handler: ((req: { requestId: string; source: string }) => void) | null = null;
  const acks: { requestId: string; ok: boolean; error?: string }[] = [];
  (window as any).electronAPI = {
    onExternalJumpRequest(h: (req: { requestId: string; source: string }) => void) {
      handler = h;
      return () => {
        handler = null;
      };
    },
    sendExternalJumpResult(result: { requestId: string; ok: boolean; error?: string }) {
      acks.push(result);
    },
  };
  return {
    fire: (source: string) => handler?.({ requestId: 'r1', source }),
    acks,
  };
}

function heading(type: string, text: string, id = newHeadingId()) {
  return schema.nodes[type]!.create({ id }, schema.text(text));
}
function makeView(doc: any) {
  let state = EditorState.create({ doc });
  // Detached DOM so `scrollToHeadingId` runs querySelector (finds nothing,
  // no `[data-id]` rendered) and select() falls back to tr.scrollIntoView.
  const dom = document.createElement('div');
  return {
    dom,
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
    focus() {},
  } as any;
}

const id = newHeadingId();
const doc = schema.nodes['doc']!.createChecked(null, [
  heading('block', 'One'),
  heading('block', 'Target heading', id),
]);

describe('jumpToTokenInView', () => {
  it('jumps to a heading by UUID', () => {
    const view = makeView(doc);
    const token = mintSourceToken({ docId: 'd1', docTitle: 'T', headingId: id, scopeId: id, anchor: null });
    expect(jumpToTokenInView(view, 'd1', token)).toEqual({ ok: true });
    expect(view.state.doc.resolve(view.state.selection.from).parent.textContent).toBe(
      'Target heading',
    );
  });
  it('falls back to the text anchor when the UUID is gone', () => {
    const view = makeView(doc);
    const token = mintSourceToken({
      docId: 'd1',
      docTitle: 'T',
      headingId: newHeadingId(), // not in the doc
      scopeId: null,
      anchor: { quote: 'Target heading', prefix: '', suffix: '', approxPos: 5 },
    });
    expect(jumpToTokenInView(view, 'd1', token)).toEqual({ ok: true });
  });
  it("reports not-mine for another doc's token", () => {
    const view = makeView(doc);
    const token = mintSourceToken({ docId: 'other', docTitle: 'O', headingId: id, scopeId: id, anchor: null });
    expect(jumpToTokenInView(view, 'd1', token)).toBe('not-mine');
  });
  it('reports not-found with the docTitle when nothing resolves', () => {
    const view = makeView(doc);
    const token = mintSourceToken({
      docId: 'd1',
      docTitle: 'T',
      headingId: newHeadingId(),
      scopeId: null,
      anchor: { quote: 'absent text zzz', prefix: '', suffix: '', approxPos: 0 },
    });
    expect(jumpToTokenInView(view, 'd1', token)).toEqual({
      ok: false,
      error: 'not-found',
      docTitle: 'T',
    });
  });
  it('reports bad-request for garbage tokens', () => {
    const view = makeView(doc);
    expect(jumpToTokenInView(view, 'd1', 'garbage')).toEqual({ ok: false, error: 'bad-request' });
  });
});

describe('installPluginJumpHost', () => {
  it('acks bad-request for garbage even with no view', () => {
    const bridge = installStubBridge();
    installPluginJumpHost({ findViewForDocId: () => null });
    bridge.fire('garbage');
    expect(bridge.acks).toEqual([{ requestId: 'r1', ok: false, error: 'bad-request' }]);
  });

  it('resolves in a non-focused pane view via findViewForDocId', () => {
    const bridge = installStubBridge();
    const viewA = makeView(doc); // wrong doc, never returned
    const viewB = makeView(doc);
    installPluginJumpHost({
      findViewForDocId: (docId) => (docId === 'dB' ? viewB : docId === 'dA' ? viewA : null),
    });
    const token = mintSourceToken({ docId: 'dB', docTitle: 'B', headingId: id, scopeId: id, anchor: null });
    bridge.fire(token);
    expect(bridge.acks).toEqual([{ requestId: 'r1', ok: true }]);
    expect(viewB.state.doc.resolve(viewB.state.selection.from).parent.textContent).toBe(
      'Target heading',
    );
  });

  it('raises a background stacked doc so the jump lands in a visible view', () => {
    const bridge = installStubBridge();
    // Model a slot stack: vA visible, vB stacked-but-hidden. The shell's
    // findViewForDocId raises the matching record before returning it, so
    // the host selects in what the user actually sees.
    const vA = makeView(doc);
    const vB = makeView(doc);
    let visible = vA;
    installPluginJumpHost({
      findViewForDocId: (docId) => {
        if (docId !== 'dB') return null;
        visible = vB; // showRecord equivalent: raise the background record
        return vB;
      },
    });
    const token = mintSourceToken({ docId: 'dB', docTitle: 'B', headingId: id, scopeId: id, anchor: null });
    bridge.fire(token);
    expect(bridge.acks).toEqual([{ requestId: 'r1', ok: true }]);
    expect(visible).toBe(vB); // the hidden doc was raised
    expect(vB.state.doc.resolve(vB.state.selection.from).parent.textContent).toBe(
      'Target heading',
    );
  });

  it('refuses to land inside a self_ref mirror', () => {
    const mirror = schema.nodes['self_ref']!.create(
      { source_heading_id: 'src', source_label: 'L' },
      [heading('block', 'Mirror only quote')],
    );
    const selfRefDoc = schema.nodes['doc']!.createChecked(null, [heading('block', 'Real'), mirror]);
    const view = makeView(selfRefDoc);
    const token = mintSourceToken({
      docId: 'd1',
      docTitle: 'T',
      headingId: newHeadingId(), // absent — force the anchor fallback
      scopeId: null,
      anchor: { quote: 'Mirror only quote', prefix: '', suffix: '', approxPos: 0 },
    });
    expect(jumpToTokenInView(view, 'd1', token)).toEqual({
      ok: false,
      error: 'not-found',
      docTitle: 'T',
    });
  });

  it('refuses to land inside a transclusion_ref mirror', () => {
    const mirror = schema.nodes['transclusion_ref']!.create(
      { source_heading_id: 'src', source_label: 'L' },
      [heading('block', 'Mirror only quote')],
    );
    const transclusionDoc = schema.nodes['doc']!.createChecked(null, [
      heading('block', 'Real'),
      mirror,
    ]);
    const view = makeView(transclusionDoc);
    const token = mintSourceToken({
      docId: 'd1',
      docTitle: 'T',
      headingId: newHeadingId(), // absent — force the anchor fallback
      scopeId: null,
      anchor: { quote: 'Mirror only quote', prefix: '', suffix: '', approxPos: 0 },
    });
    expect(jumpToTokenInView(view, 'd1', token)).toEqual({
      ok: false,
      error: 'not-found',
      docTitle: 'T',
    });
  });
});
