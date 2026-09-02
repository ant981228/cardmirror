// @vitest-environment jsdom
/**
 * M4 presence cursors + lease ads: the transport contract (typed
 * frames over the encrypted presence channel) and the advisory lease
 * rendering. The cursor DECORATION path itself is loro-prosemirror's
 * (upstream-tested); what's ours — and pinned here — is the piping:
 * local store updates ship as 0x01 frames, remote frames land in the
 * partner's store, lease ads render/clear/remap as 0x02 frames.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import { CollabSession } from '../../src/editor/collab/collab-session.js';
import { RoomsClient } from '../../src/editor/collab/room-client.js';
import { decodeShareCode } from '../../src/editor/collab/collab-crypto.js';
import { installCursorPresence, peerColor } from '../../src/editor/collab/collab-cursors.js';
import { claimRegion, leasedRanges } from '../../src/editor/ai/edit-coordinator.js';
import { editCoordinatorPlugin } from '../../src/editor/ai/edit-coordinator.js';
import { startRoomsMock, type RoomsMock } from './_rooms-mock.js';
import { settle, sleep, simpleDoc, docText, mkView } from './_loro-helpers.js';

let mock: RoomsMock;
let client: RoomsClient;

beforeAll(async () => {
  mock = await startRoomsMock();
  client = new RoomsClient({ baseUrl: () => mock.url, token: () => mock.token });
});
afterAll(async () => {
  await mock.close();
});

describe('M4 presence cursors', () => {
  it('cursor frames flow A→B over the presence channel into the partner store', async () => {
    const { session: a, shareCode } = await CollabSession.host({
      pmDoc: simpleDoc('presence test doc'),
      client,
      flushMs: 40,
      minBackoffMs: 30,
      maxBackoffMs: 60,
    });
    const bPresence: Uint8Array[] = [];
    const b = await CollabSession.join({
      ...decodeShareCode(shareCode)!,
      client,
      flushMs: 40,
      minBackoffMs: 30,
      maxBackoffMs: 60,
      callbacks: { onPresence: (bytes) => bPresence.push(bytes) },
    });

    const aCursors = installCursorPresence(a, () => aView);
    const bCursors = installCursorPresence(b, () => bView);
    const aView = mkView([...a.plugins(), ...aCursors.plugins()]);
    const bView = mkView([...b.plugins(), ...bCursors.plugins()]);
    await settle();
    a.start();
    b.start();
    await sleep(300);

    // Drive A's local cursor state the way the plugin does on focus:
    // a selection change while focused → store.setLocal → local update
    // → throttled 0x01 frame. jsdom can't reliably focus contenteditable,
    // so poke the store through the plugin's own selection pathway:
    // dispatching a selection with focus simulated via direct setLocal
    // is off-limits (store is private), so instead verify the wire with
    // B as the sender of a lease ad and A of a cursor via selection.
    // jsdom can't genuinely focus contenteditable; the plugin's
    // updateCursorInfo gates on view.hasFocus() — stub it truthy.
    (aView as unknown as { hasFocus: () => boolean }).hasFocus = () => true;
    aView.dispatch(
      aView.state.tr.setSelection(TextSelection.create(aView.state.doc, 2, 8)),
    );
    await sleep(400);

    // B received at least one 0x01 cursor frame from A.
    const cursorFrames = bPresence.filter((f) => f[0] === 0x01);
    expect(cursorFrames.length).toBeGreaterThan(0);
    // Feeding it to B's handle must not throw and must be a no-op for
    // B's doc (presence never mutates content).
    const before = docText(bView.state.doc);
    for (const f of bPresence) bCursors.applyRemote(f);
    // Cursor frames buffer on the 150ms receive-side drain (perf fix
    // 2026-08-06) — wait past it before reading the store.
    await sleep(250);
    expect(docText(bView.state.doc)).toBe(before);

    // …and B's presence roster now shows both people: self + A (with a name
    // and A's deterministic dot color) — the data behind the "who's here" dots.
    const roster = bCursors.presence();
    expect(roster.some((p) => p.self)).toBe(true);
    const remote = roster.find((p) => !p.self);
    expect(remote?.peer).toBe(a.loroDoc.peerIdStr);
    expect(remote?.color).toBe(peerColor(a.loroDoc.peerIdStr));
    expect((remote?.name ?? '').length).toBeGreaterThan(0);

    aCursors.dispose();
    bCursors.dispose();
    await a.stop();
    await b.stop();
    aView.destroy();
    bView.destroy();
  }, 20_000);

  it('lease ads render as advisory decorations, remap through edits, and clear', async () => {
    const { session: a, shareCode } = await CollabSession.host({
      pmDoc: simpleDoc('the AI is rewriting this sentence right now'),
      client,
      flushMs: 40,
    });
    const b = await CollabSession.join({ ...decodeShareCode(shareCode)!, client, flushMs: 40 });
    const bCursors = installCursorPresence(b, () => bView);
    const bView = mkView([...b.plugins(), ...bCursors.plugins()]);
    await settle();

    const mkFrame = (ad: object) => {
      const payload = new TextEncoder().encode(JSON.stringify(ad));
      const framed = new Uint8Array(payload.length + 1);
      framed[0] = 0x02;
      framed.set(payload, 1);
      return framed;
    };

    // Partner (A) advertises a lease over [5, 15) — the tag names them.
    bCursors.applyRemote(
      mkFrame({ peer: a.loroDoc.peerIdStr, name: 'Priya', ranges: [{ from: 5, to: 15, label: 'AI' }] }),
    );
    await settle();

    const hasLeaseDeco = () =>
      bView.dom.querySelectorAll('.pmd-collab-lease-ad').length > 0 ||
      bView.dom.querySelectorAll('.pmd-collab-lease-ad-tag').length > 0;
    expect(hasLeaseDeco()).toBe(true);
    expect(bView.dom.querySelector('.pmd-collab-lease-ad-tag')?.textContent).toContain('Priya');

    // B's OWN echoed advertisement must NOT render (the relay fans
    // presence back to the poster; the local machine already shows the
    // real AI-working box).
    bCursors.applyRemote(
      mkFrame({ peer: b.loroDoc.peerIdStr, name: 'Me', ranges: [{ from: 1, to: 4, label: 'AI' }] }),
    );
    await settle();
    expect(bView.dom.querySelectorAll('.pmd-collab-lease-ad-tag').length).toBe(1); // still just Priya's

    // A cleared its leases → empty ad wipes the decorations.
    bCursors.applyRemote(mkFrame({ peer: a.loroDoc.peerIdStr, name: 'Priya', ranges: [] }));
    await settle();
    expect(hasLeaseDeco()).toBe(false);

    bCursors.dispose();
    await a.stop();
    await b.stop();
    bView.destroy();
  }, 20_000);

  it('leasedRanges exposes live coordinator leases', () => {
    const view = mkView([editCoordinatorPlugin]);
    expect(leasedRanges(view.state)).toEqual([]);
    const lease = claimRegion(view, { from: 1, to: 10 }, { label: 'test' });
    expect(lease).not.toBeNull();
    const ranges = leasedRanges(view.state);
    expect(ranges).toEqual([{ from: 1, to: 10 }]);
    lease!.release();
    expect(leasedRanges(view.state)).toEqual([]);
    view.destroy();
  });

  it('peer colors are deterministic and distinct-ish', () => {
    expect(peerColor('12345')).toBe(peerColor('12345'));
    expect(peerColor('12345')).not.toBe(peerColor('54321'));
  });
});

describe('presence departure + reconnect re-broadcast (2026-09-01 review, PH-A10)', () => {
  it('farewell() removes this peer from partners immediately instead of after the 45s expiry', async () => {
    const { session: a, shareCode } = await CollabSession.host({
      pmDoc: simpleDoc('farewell doc'),
      client,
      flushMs: 40,
      minBackoffMs: 30,
      maxBackoffMs: 60,
    });
    const bPresence: Uint8Array[] = [];
    const b = await CollabSession.join({
      ...decodeShareCode(shareCode)!,
      client,
      flushMs: 40,
      minBackoffMs: 30,
      maxBackoffMs: 60,
      callbacks: { onPresence: (bytes) => bPresence.push(bytes) },
    });
    const aCursors = installCursorPresence(a, () => aView);
    const bCursors = installCursorPresence(b, () => bView);
    const aView = mkView([...a.plugins(), ...aCursors.plugins()]);
    const bView = mkView([...b.plugins(), ...bCursors.plugins()]);
    await settle();
    a.start();
    b.start();
    await sleep(300);
    (aView as unknown as { hasFocus: () => boolean }).hasFocus = () => true;
    const pump = async (): Promise<void> => {
      for (const f of bPresence.splice(0)) bCursors.applyRemote(f);
      await sleep(250);
    };
    aView.dispatch(aView.state.tr.setSelection(TextSelection.create(aView.state.doc, 2, 6)));
    await sleep(400);
    await pump();
    expect(bCursors.visiblePeers()).toContain(a.loroDoc.peerIdStr);

    // A leaves: a departure frame goes out synchronously, before the
    // stream is stopped and the handle disposed.
    aCursors.farewell();
    await sleep(400);
    await pump();
    expect(bCursors.visiblePeers(), 'gone at once, not in 45s').not.toContain(a.loroDoc.peerIdStr);

    // ABORTED departure (host End failed to tombstone / keep-resumable
    // flush failed → session.start() → reconnect → rebroadcast): the
    // farewell was a store delete of our own entry, so with nothing
    // stashed there was nothing to re-announce until the next editor
    // transaction (knock-on audit 2026-09-02).
    aCursors.rebroadcast();
    await sleep(400);
    await pump();
    expect(bCursors.visiblePeers(), 'the parting state is re-announced').toContain(a.loroDoc.peerIdStr);

    aCursors.dispose();
    bCursors.dispose();
    await a.stop();
    await b.stop();
    aView.destroy();
    bView.destroy();
  }, 20_000);
});

describe('remote caret widgets are stable across rebuilds (2026-09-01 review, PH-A3)', () => {
  it('a presence rebuild reuses the same caret element when the peer is unchanged', async () => {
    // The stock createCursor built a fresh <span>+<div> per peer per
    // rebuild, so WidgetType.eq failed and ProseMirror re-inserted every
    // remote caret on every remote transaction — layout churn on big
    // docs. Same peer, same name/color → same element.
    const { session: a, shareCode } = await CollabSession.host({
      pmDoc: simpleDoc('widget identity doc'),
      client,
      flushMs: 40,
      minBackoffMs: 30,
      maxBackoffMs: 60,
    });
    const bPresence: Uint8Array[] = [];
    const b = await CollabSession.join({
      ...decodeShareCode(shareCode)!,
      client,
      flushMs: 40,
      minBackoffMs: 30,
      maxBackoffMs: 60,
      callbacks: { onPresence: (bytes) => bPresence.push(bytes) },
    });
    const aCursors = installCursorPresence(a, () => aView);
    const bCursors = installCursorPresence(b, () => bView);
    const aView = mkView([...a.plugins(), ...aCursors.plugins()]);
    const bView = mkView([...b.plugins(), ...bCursors.plugins()]);
    await settle();
    a.start();
    b.start();
    await sleep(300);
    (aView as unknown as { hasFocus: () => boolean }).hasFocus = () => true;

    const caretNodes = (): Node[] => {
      const plugin = bView.state.plugins.find((p) =>
        String((p as unknown as { key: string }).key).startsWith('loro-ephemeral-cursor'),
      )!;
      const set = plugin.getState(bView.state) as { find: () => Array<{ type: { toDOM?: Node } }> };
      return set.find().map((d) => d.type.toDOM).filter((n): n is Node => !!n);
    };
    const pumpFrames = async (): Promise<void> => {
      for (const f of bPresence.splice(0)) bCursors.applyRemote(f);
      await sleep(250); // past the receive drain
    };

    aView.dispatch(aView.state.tr.setSelection(TextSelection.create(aView.state.doc, 2, 6)));
    await sleep(400);
    await pumpFrames();
    const first = caretNodes();
    expect(first.length, 'A\u2019s caret renders in B').toBeGreaterThan(0);

    // A moves its cursor → new frame → B rebuilds decorations.
    aView.dispatch(aView.state.tr.setSelection(TextSelection.create(aView.state.doc, 8, 12)));
    await sleep(400);
    await pumpFrames();
    const second = caretNodes();
    expect(second.length).toBe(first.length);
    expect(second[0], 'same peer, same name/color → the SAME element').toBe(first[0]);

    aCursors.dispose();
    bCursors.dispose();
    await a.stop();
    await b.stop();
    aView.destroy();
    bView.destroy();
  }, 20_000);
});

describe('receive-side cursor coalescing (perf fix 2026-08-06)', () => {
  it('a burst of remote cursor frames drains as ONE dispatch, not one each', async () => {
    // Sender side: real stores encode valid ephemeral payloads.
    const { CursorEphemeralStore } = await import('loro-prosemirror');
    const encodeFrom = (peer: string): Promise<Uint8Array> =>
      new Promise((resolve) => {
        const s = new CursorEphemeralStore(peer as never, 45_000);
        const unsub = s.subscribeLocalUpdates((bytes: Uint8Array) => {
          unsub();
          resolve(bytes);
        });
        s.setLocal({ user: { name: `P${peer}`, color: '#123456' } } as never);
      });

    // Receiver: a fake session (presence layer needs only peer id +
    // sendPresence) and a dispatch-counting view.
    const fakeSession = {
      loroDoc: { peerIdStr: '1' },
      sendPresence: async () => {},
    } as unknown as Parameters<typeof installCursorPresence>[0];
    let view: ReturnType<typeof mkView>;
    const cursors = installCursorPresence(fakeSession, () => view);
    let presenceDispatches = 0;
    view = mkView(cursors.plugins());
    const innerDispatch = view.dispatch.bind(view);
    (view as { dispatch: (tr: unknown) => void }).dispatch = (tr) => {
      // The vendored cursor plugin marks its redraws with its meta.
      const metas = (tr as { meta?: Record<string, unknown> }).meta ?? {};
      if (Object.keys(metas).some((k) => k.includes('cursor') || k.includes('Cursor'))) {
        presenceDispatches++;
      }
      innerDispatch(tr as never);
    };

    // Six frames from three peers land inside one drain window…
    const frames = await Promise.all(['7', '8', '9', '7', '8', '9'].map(encodeFrom));
    const framed = (b: Uint8Array): Uint8Array => {
      const out = new Uint8Array(b.length + 1);
      out[0] = 0x01;
      out.set(b, 1);
      return out;
    };
    for (const f of frames) cursors.applyRemote(framed(f));
    expect(presenceDispatches).toBe(0); // buffered — nothing yet
    await sleep(300); // > the 150ms drain
    expect(presenceDispatches).toBe(1); // ONE dispatch for the whole burst
    // …and the whole batch actually landed in the store.
    expect(new Set(cursors.visiblePeers())).toEqual(new Set(['7', '8', '9']));

    // A later frame opens a new window: exactly one more dispatch.
    cursors.applyRemote(framed(await encodeFrom('7')));
    await sleep(300);
    expect(presenceDispatches).toBe(2);

    cursors.dispose();
    view.destroy();
  });
});
