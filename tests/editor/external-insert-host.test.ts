// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState, Plugin, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { absorbPlugin } from '../../src/editor/absorb-plugin.js';
import { installExternalInsertHost } from '../../src/editor/external-insert-host.js';
import { resolveSourceRange } from '../../src/editor/plugin-source-range.js';
import { parseSourceToken } from '../../src/editor/plugin-source-token.js';
import { replaceTokenInView } from '../../src/editor/external-replace.js';
import { insertAfterTokenInView } from '../../src/editor/external-insert-after.js';

function tag(text: string, id = newHeadingId()) {
  return schema.nodes['tag']!.create({ id }, schema.text(text));
}
function cardBody(text: string) {
  return text
    ? schema.nodes['card_body']!.create(null, schema.text(text))
    : schema.nodes['card_body']!.create(null, []);
}

function buildViewInBody(
  cursorText: string,
  cursorOffset: number,
  extraPlugins: Plugin[] = [],
): { view: EditorView; cleanup: () => void } {
  const doc = schema.nodes['doc']!.createChecked(null, [
    schema.nodes['card']!.createChecked(null, [
      tag('TAG'),
      cardBody(cursorText),
    ]),
  ]);
  let cursorPos = -1;
  doc.descendants((n: any, p: number) => {
    if (cursorPos !== -1) return false;
    if (n.isText && n.text === cursorText) { cursorPos = p + cursorOffset; return false; }
    return true;
  });
  const state = EditorState.create({
    doc,
    plugins: [absorbPlugin, ...extraPlugins],
    selection: TextSelection.create(doc, cursorPos),
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const view = new EditorView(container, { state });
  return { view, cleanup: () => { view.destroy(); container.remove(); } };
}

interface PendingRequestHandler {
  (req: any): void;
}

function installFakeBridge(): {
  fire: (req: any) => void;
  results: any[];
  uninstall: () => void;
} {
  const results: any[] = [];
  let pendingHandler: PendingRequestHandler | null = null;
  const api = {
    onExternalInsertRequest: (h: PendingRequestHandler): (() => void) => {
      pendingHandler = h;
      return () => { pendingHandler = null; };
    },
    sendExternalInsertResult: (r: any): void => { results.push(r); },
  };
  (window as any).electronAPI = api;
  return {
    fire: (req: any) => { pendingHandler?.(req); },
    results,
    uninstall: () => { delete (window as any).electronAPI; },
  };
}

describe('installExternalInsertHost', () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    cleanup?.(); cleanup = null;
    delete (window as any).electronAPI;
  });

  it('no electronAPI present → no-op subscribe (returns unsubscribe)', () => {
    const unsubscribe = installExternalInsertHost({
      getFocusedView: () => null,
      getFocusedDocTitle: () => null,
    });
    expect(typeof unsubscribe).toBe('function');
    expect(() => unsubscribe()).not.toThrow();
  });

  it('happy path: card mode multi-line text → ack ok with docTitle, doc has new card_body siblings', () => {
    const bridge = installFakeBridge();
    const { view, cleanup: vc } = buildViewInBody('hello world', 6);
    cleanup = vc;
    installExternalInsertHost({
      getFocusedView: () => view,
      getFocusedDocTitle: () => 'doc.cmir',
    });

    bridge.fire({
      requestId: 'r1',
      text: 'X\nY',
      role: 'card',
      newParagraph: true,
      omitted: false,
    });

    expect(bridge.results).toHaveLength(1);
    expect(bridge.results[0]).toEqual({
      requestId: 'r1',
      ok: true,
      docTitle: 'doc.cmir',
    });
    const shape: string[] = [];
    view.state.doc.firstChild!.forEach((c: any) => shape.push(`${c.type.name}("${c.textContent}")`));
    expect(shape).toEqual([
      'tag("TAG")',
      'card_body("hello ")',
      'card_body("X")',
      'card_body("Yworld")',
    ]);
  });

  it('inline mode: text inserts at cursor with no block break', () => {
    const bridge = installFakeBridge();
    const { view, cleanup: vc } = buildViewInBody('hello world', 6);
    cleanup = vc;
    installExternalInsertHost({ getFocusedView: () => view, getFocusedDocTitle: () => null });

    bridge.fire({
      requestId: 'r2',
      text: 'INSERTED',
      role: 'inline',
      newParagraph: false,
      omitted: false,
    });

    expect(bridge.results[0]).toMatchObject({ requestId: 'r2', ok: true });
    expect(view.state.doc.textContent).toBe('TAGhello INSERTEDworld');
  });

  it('no focused view → ok:false, error:"no-target-doc"', () => {
    const bridge = installFakeBridge();
    installExternalInsertHost({ getFocusedView: () => null, getFocusedDocTitle: () => null });

    bridge.fire({
      requestId: 'r3',
      text: 'X',
      role: 'card',
      newParagraph: true,
      omitted: false,
    });

    expect(bridge.results[0]).toEqual({
      requestId: 'r3',
      ok: false,
      error: 'no-target-doc',
    });
  });

  it('focused view in read mode (editable=false) → ok:false, error:"doc-readonly"', () => {
    const bridge = installFakeBridge();
    const { view, cleanup: vc } = buildViewInBody('hello', 0);
    cleanup = vc;
    // Mimic the read-mode plugin flipping editable to false.
    view.setProps({ editable: () => false });
    installExternalInsertHost({ getFocusedView: () => view, getFocusedDocTitle: () => null });

    bridge.fire({
      requestId: 'r4',
      text: 'X',
      role: 'card',
      newParagraph: true,
      omitted: false,
    });

    expect(bridge.results[0]).toEqual({
      requestId: 'r4',
      ok: false,
      error: 'doc-readonly',
    });
  });

  it('malformed payload (missing text) → bad-request', () => {
    const bridge = installFakeBridge();
    const { view, cleanup: vc } = buildViewInBody('hello', 0);
    cleanup = vc;
    installExternalInsertHost({ getFocusedView: () => view, getFocusedDocTitle: () => null });

    bridge.fire({
      requestId: 'r5',
      role: 'card',
      newParagraph: true,
      omitted: false,
      // text is missing
    });

    expect(bridge.results[0]).toEqual({
      requestId: 'r5',
      ok: false,
      error: 'bad-request',
    });
  });

  it('docTitle is undefined when active filename is null', () => {
    const bridge = installFakeBridge();
    const { view, cleanup: vc } = buildViewInBody('hello', 0);
    cleanup = vc;
    installExternalInsertHost({ getFocusedView: () => view, getFocusedDocTitle: () => null });

    bridge.fire({
      requestId: 'r6',
      text: 'X',
      role: 'card',
      newParagraph: true,
      omitted: false,
    });

    expect(bridge.results[0]).toEqual({ requestId: 'r6', ok: true });
    expect(bridge.results[0]).not.toHaveProperty('docTitle');
  });
});

describe('doc-targeted inserts', () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    cleanup?.(); cleanup = null;
    delete (window as any).electronAPI;
  });

  it('inserts into the addressed pane view, not the focused one', () => {
    const bridge = installFakeBridge();
    const focused = buildViewInBody('FOCUSED', 3);
    const target = buildViewInBody('TARGETPANE', 4);
    cleanup = () => { focused.cleanup(); target.cleanup(); bridge.uninstall(); };
    installExternalInsertHost({
      getFocusedView: () => focused.view,
      getFocusedDocTitle: () => 'focused.cmir',
      resolveViewForUid: (uid) => (uid === 'pane-2' ? target.view : null),
    });
    bridge.fire({
      requestId: 'r1', text: 'aimed', role: 'card', newParagraph: false, omitted: false,
      target: 'pane-2',
    });
    expect(bridge.results).toHaveLength(1);
    expect(bridge.results[0]).toEqual({ requestId: 'r1', ok: true });
    // The text landed in the TARGET view; the focused view is untouched.
    expect(target.view.state.doc.textContent).toContain('aimed');
    expect(focused.view.state.doc.textContent).not.toContain('aimed');
  });

  it('unknown target → target-not-found, focused doc untouched', () => {
    const bridge = installFakeBridge();
    const focused = buildViewInBody('FOCUSED', 3);
    cleanup = () => { focused.cleanup(); bridge.uninstall(); };
    installExternalInsertHost({
      getFocusedView: () => focused.view,
      getFocusedDocTitle: () => 'focused.cmir',
      resolveViewForUid: () => null,
    });
    bridge.fire({
      requestId: 'r1', text: 'aimed', role: 'card', newParagraph: false, omitted: false,
      target: 'pane-gone',
    });
    expect(bridge.results[0]).toEqual({ requestId: 'r1', ok: false, error: 'target-not-found' });
    expect(focused.view.state.doc.textContent).not.toContain('aimed');
  });

  it('a host without a pane registry rejects targeted requests cleanly', () => {
    const bridge = installFakeBridge();
    const focused = buildViewInBody('FOCUSED', 3);
    cleanup = () => { focused.cleanup(); bridge.uninstall(); };
    installExternalInsertHost({
      getFocusedView: () => focused.view,
      getFocusedDocTitle: () => 'focused.cmir',
    });
    bridge.fire({
      requestId: 'r1', text: 'aimed', role: 'card', newParagraph: false, omitted: false,
      target: 'pane-2',
    });
    expect(bridge.results[0]).toEqual({ requestId: 'r1', ok: false, error: 'target-not-found' });
  });
});

describe('provenance on the insert ack', () => {
  let cleanup: (() => void) | null = null;
  const ident = { docId: 'doc-1', docTitle: 'doc.cmir' };

  afterEach(() => {
    cleanup?.(); cleanup = null;
    delete (window as any).electronAPI;
  });

  /** The round trip a caller makes with a token it was handed: resolve it
   *  against the doc that took the insert, exactly as `/replace`,
   *  `/jump` and `/insert-after` do. `anchorOnly` drops the heading id
   *  first, which forces resolution through the text anchor - the half
   *  that has to survive a heading being retyped. */
  function landing(view: EditorView, token: string, anchorOnly = false) {
    const payload = parseSourceToken(token);
    expect(payload).not.toBeNull();
    const range = resolveSourceRange(
      view.state.doc,
      anchorOnly ? { ...payload!, headingId: null } : payload!,
    );
    expect(range).not.toBeNull();
    const $from = view.state.doc.resolve(range!.from);
    return {
      payload: payload!,
      type: $from.parent.type.name,
      text: view.state.doc.textBetween(range!.from, range!.to),
      // Position of the container the line sits in, for the two kinds
      // that arrive wrapped in a fresh one.
      container: $from.depth > 1 ? $from.before($from.depth - 1) : -1,
    };
  }

  it('a three-line analytic send answers a token per line, in document order', () => {
    const bridge = installFakeBridge();
    const { view, cleanup: vc } = buildViewInBody('hello world', 6);
    cleanup = vc;
    installExternalInsertHost({
      getFocusedView: () => view,
      getFocusedDocTitle: () => 'doc.cmir',
      getDocIdentity: () => ident,
    });

    bridge.fire({
      requestId: 'p1',
      text: 'first\nsecond\nthird',
      role: 'analytic',
      newParagraph: true,
      omitted: false,
    });

    const ack = bridge.results[0];
    expect(ack).toMatchObject({ requestId: 'p1', ok: true, docTitle: 'doc.cmir' });
    const sources: string[] = ack.sources;
    expect(sources).toHaveLength(3);
    // Each token names its OWN line, in the order the caller sent them.
    expect(sources.map((s) => landing(view, s).text)).toEqual(['first', 'second', 'third']);
    expect(sources.map((s) => landing(view, s).type)).toEqual([
      'analytic',
      'analytic',
      'analytic',
    ]);
    // Identity comes from the host, so a later /replace can find the doc.
    expect(sources.map((s) => landing(view, s).payload.docId)).toEqual([
      'doc-1',
      'doc-1',
      'doc-1',
    ]);
    // And the anchor alone points at the same line: a caller's token
    // outlives the heading id it was minted with.
    expect(sources.map((s) => landing(view, s, true).text)).toEqual(['first', 'second', 'third']);
  });

  it('a tag send answers tokens that resolve inside the fresh cards', () => {
    const bridge = installFakeBridge();
    const { view, cleanup: vc } = buildViewInBody('hello world', 6);
    cleanup = vc;
    installExternalInsertHost({
      getFocusedView: () => view,
      getFocusedDocTitle: () => 'doc.cmir',
      getDocIdentity: () => ident,
    });

    bridge.fire({
      requestId: 'p2',
      text: 'one\ntwo',
      role: 'tag',
      newParagraph: true,
      omitted: false,
    });

    const sources: string[] = bridge.results[0].sources;
    expect(sources).toHaveLength(2);
    const landings = sources.map((s) => landing(view, s));
    expect(landings.map((l) => [l.type, l.text])).toEqual([
      ['tag', 'one'],
      ['tag', 'two'],
    ]);
    // Each tag heads a card of its own — never the card the cursor was in.
    expect(new Set(landings.map((l) => l.container)).size).toBe(2);
    expect(landings[0]!.container).toBeGreaterThan(0);
  });

  it.each(['body', 'card', 'cite'])('role %s answers no sources at all', (role) => {
    // These land as card bodies, which /replace and /insert-after refuse
    // as `body-text` — a token would name a line the caller can't use.
    const bridge = installFakeBridge();
    const { view, cleanup: vc } = buildViewInBody('hello world', 6);
    cleanup = vc;
    installExternalInsertHost({
      getFocusedView: () => view,
      getFocusedDocTitle: () => 'doc.cmir',
      getDocIdentity: () => ident,
    });

    bridge.fire({ requestId: 'p3', text: 'X\nY', role, newParagraph: true, omitted: false });

    expect(bridge.results[0]).toEqual({ requestId: 'p3', ok: true, docTitle: 'doc.cmir' });
    expect(bridge.results[0]).not.toHaveProperty('sources');
  });

  it('newParagraph:false answers no sources — the text joined a block nobody named', () => {
    const bridge = installFakeBridge();
    const { view, cleanup: vc } = buildViewInBody('hello world', 6);
    cleanup = vc;
    installExternalInsertHost({
      getFocusedView: () => view,
      getFocusedDocTitle: () => 'doc.cmir',
      getDocIdentity: () => ident,
    });

    bridge.fire({
      requestId: 'p4', text: 'INSERTED', role: 'inline', newParagraph: false, omitted: false,
    });

    expect(bridge.results[0]).toEqual({ requestId: 'p4', ok: true, docTitle: 'doc.cmir' });
    expect(view.state.doc.textContent).toContain('INSERTED');
  });

  it('a heading that did not land where the plan said drops sources, insert still ok', () => {
    // Something rewrote the doc in the same dispatch (a repair walk, a
    // collab rebase), so the reported content starts no longer hold the
    // lines that were sent. The field goes wholesale rather than naming
    // the wrong text — but the insert itself happened and still reports so.
    const shiftsEverything = new Plugin({
      appendTransaction(trs, _old, state) {
        if (!trs.some((tr) => tr.docChanged && !tr.getMeta('shifted'))) return null;
        const tr = state.tr.insertText('!', 2);
        tr.setMeta('shifted', true);
        return tr;
      },
    });
    const bridge = installFakeBridge();
    const { view, cleanup: vc } = buildViewInBody('hello world', 6, [shiftsEverything]);
    cleanup = vc;
    installExternalInsertHost({
      getFocusedView: () => view,
      getFocusedDocTitle: () => 'doc.cmir',
      getDocIdentity: () => ident,
    });

    bridge.fire({
      requestId: 'p5', text: 'first\nsecond', role: 'analytic', newParagraph: true, omitted: false,
    });

    expect(bridge.results[0]).toEqual({ requestId: 'p5', ok: true, docTitle: 'doc.cmir' });
    expect(bridge.results[0]).not.toHaveProperty('sources');
    expect(view.state.doc.textContent).toContain('first');
    expect(view.state.doc.textContent).toContain('second');
  });

  it('a host that cannot name the doc answers no sources', () => {
    // No docId, no token: it would resolve nowhere for every route the
    // caller could hand it to.
    const bridge = installFakeBridge();
    const { view, cleanup: vc } = buildViewInBody('hello world', 6);
    cleanup = vc;
    installExternalInsertHost({
      getFocusedView: () => view,
      getFocusedDocTitle: () => 'doc.cmir',
      getDocIdentity: () => null,
    });

    bridge.fire({
      requestId: 'p6', text: 'first', role: 'analytic', newParagraph: true, omitted: false,
    });

    expect(bridge.results[0]).toEqual({ requestId: 'p6', ok: true, docTitle: 'doc.cmir' });
    expect(view.state.doc.textContent).toContain('first');
  });

  it('a targeted insert mints against the addressed pane, not the focused one', () => {
    const bridge = installFakeBridge();
    const focused = buildViewInBody('FOCUSED', 3);
    const target = buildViewInBody('TARGETPANE', 4);
    cleanup = () => { focused.cleanup(); target.cleanup(); bridge.uninstall(); };
    installExternalInsertHost({
      getFocusedView: () => focused.view,
      getFocusedDocTitle: () => 'focused.cmir',
      resolveViewForUid: (uid) => (uid === 'pane-2' ? target.view : null),
      getDocIdentity: (uid) =>
        uid === 'pane-2' ? { docId: 'doc-2', docTitle: 'aimed.cmir' } : ident,
    });

    bridge.fire({
      requestId: 'p7', text: 'aimed', role: 'analytic', newParagraph: true, omitted: false,
      target: 'pane-2',
    });

    const sources: string[] = bridge.results[0].sources;
    expect(sources).toHaveLength(1);
    const landed = landing(target.view, sources[0]!);
    expect(landed.payload.docId).toBe('doc-2');
    expect(landed.payload.docTitle).toBe('aimed.cmir');
    expect(landed.text).toBe('aimed');
  });

  it('a token off the ack is accepted by /replace and /insert-after', () => {
    // The whole point of the field: a line the caller dictated is now as
    // addressable as one it received through /extract.
    const bridge = installFakeBridge();
    const { view, cleanup: vc } = buildViewInBody('hello world', 6);
    cleanup = vc;
    installExternalInsertHost({
      getFocusedView: () => view,
      getFocusedDocTitle: () => 'doc.cmir',
      getDocIdentity: () => ident,
    });

    bridge.fire({
      requestId: 'p8', text: 'dictated line', role: 'analytic', newParagraph: true, omitted: false,
    });
    const token: string = bridge.results[0].sources[0];

    const replaced = replaceTokenInView(view, ident.docId, token, 'edited line');
    if (replaced === 'not-mine' || !replaced.ok) throw new Error('/replace refused the token');
    expect(view.state.doc.textContent).toContain('edited line');
    // /replace hands back a fresh token, which /insert-after then anchors
    // to - the caller's chain continues off the insert's token.
    const added = insertAfterTokenInView(view, ident.docId, replaced.source, 'and another');
    if (added === 'not-mine' || !added.ok) throw new Error('/insert-after refused the token');
    expect(landing(view, added.source).text).toBe('and another');
  });
});
