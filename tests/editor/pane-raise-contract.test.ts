// @vitest-environment jsdom
/**
 * Which bridge routes may change what the user is looking at.
 *
 * The multi-pane shell's `findViewForDocId` can RAISE a background,
 * stacked record to its slot's visible position, which runs
 * `detachVisible()` + `mountVisible()` + `focusSlot()`
 * (`multi-pane-shell.ts`, `Slot.showRecord`). That is right for `/jump`,
 * where surfacing the doc IS the request. It is wrong for every other
 * route: `/replace` promises no focus, no scrolling and no caret
 * movement, and `/insert-after` inherits that promise. A raising
 * resolution there lets a consented app's edit swap the visible
 * document, and detaches the `editorEl` of a doc being typed in when the
 * edited doc shares its slot.
 *
 * So the resolver takes `{ raise?: boolean }`, defaulting to quiet, and
 * only the jump asks. These tests pin who asks, at the seam where the
 * asking happens: the host. The shell's own branch (`if (opts?.raise)`)
 * is not reachable from a test - `Shell` and `Slot` are module-private
 * and `mountMultiPaneShell()` is the only export - so the quiet hosts
 * additionally take a ONE-PARAMETER resolver type, which makes asking a
 * type error rather than a convention.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { installPluginJumpHost } from '../../src/editor/plugin-jump-host.js';
import { installExternalReplaceHost } from '../../src/editor/external-replace-host.js';
import { installExternalInsertAfterHost } from '../../src/editor/external-insert-after-host.js';
import { mintSourceToken } from '../../src/editor/plugin-source-token.js';
import { newHeadingId } from '../../src/schema/index.js';

const DOC_ID = 'd1';
const teardowns: (() => void)[] = [];

afterEach(() => {
  while (teardowns.length > 0) teardowns.pop()!();
  delete (window as unknown as Record<string, unknown>).electronAPI;
});

function token(): string {
  const id = newHeadingId();
  return mintSourceToken({ docId: DOC_ID, docTitle: 'T', headingId: id, scopeId: id, anchor: null });
}

/**
 * Records every resolver call and answers null, so no route gets a view
 * and none of them reach a document. What is under test is the ARGUMENTS
 * each host resolves with, which every host computes before it touches a
 * view, so a null answer costs the test nothing and keeps it independent
 * of token resolution.
 */
function spy(): { calls: [string, { raise?: boolean } | undefined][]; resolve: (
  docId: string,
  opts?: { raise?: boolean },
) => null } {
  const calls: [string, { raise?: boolean } | undefined][] = [];
  return {
    calls,
    resolve: (docId, opts) => {
      calls.push([docId, opts]);
      return null;
    },
  };
}

/** Install the preload surface every host in this file reads. `deliver`
 *  hands one request to whichever channel the host subscribed to. */
function bridge(): { deliver: (req: unknown) => void } {
  let handler: ((req: unknown) => void) | null = null;
  const subscribe = (h: (req: unknown) => void): (() => void) => {
    handler = h;
    return () => {
      handler = null;
    };
  };
  (window as unknown as Record<string, unknown>).electronAPI = {
    onExternalJumpRequest: subscribe,
    sendExternalJumpResult: () => {},
    onExternalReplaceRequest: subscribe,
    sendExternalReplaceResult: () => {},
    onExternalInsertAfterRequest: subscribe,
    sendExternalInsertAfterResult: () => {},
  };
  return {
    deliver: (req) => {
      if (!handler) throw new Error('the host subscribed to no channel');
      handler(req);
    },
  };
}

describe('only /jump may raise a pane', () => {
  it('the jump host asks to raise: a caret in a detached editor shows nothing', () => {
    const wire = bridge();
    const resolver = spy();
    teardowns.push(installPluginJumpHost({ findViewForDocId: resolver.resolve }));

    wire.deliver({ requestId: 'j1', source: token() });

    expect(resolver.calls).toEqual([[DOC_ID, { raise: true }]]);
  });

  it('the replace host resolves quietly', () => {
    const wire = bridge();
    const resolver = spy();
    teardowns.push(installExternalReplaceHost({ findViewForDocId: resolver.resolve }));

    wire.deliver({ requestId: 'r1', source: token(), text: 'rewritten' });

    expect(resolver.calls).toHaveLength(1);
    expect(resolver.calls[0]![1], 'a settled keystroke elsewhere must not raise a pane').toBeUndefined();
  });

  it('the insert-after host resolves quietly', () => {
    const wire = bridge();
    const resolver = spy();
    teardowns.push(installExternalInsertAfterHost({ findViewForDocId: resolver.resolve }));

    wire.deliver({ requestId: 'a1', source: token(), text: 'a new line' });

    expect(resolver.calls).toHaveLength(1);
    expect(resolver.calls[0]![1], 'adding a line must not raise a pane').toBeUndefined();
  });
});
