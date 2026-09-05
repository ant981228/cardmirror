// @vitest-environment jsdom
/**
 * The web tab-close path (web audit 2026-09-04): a page that is going
 * away cannot wait for WebCrypto, and a plain fetch started during
 * unload is cancelled by the browser. So (1) while the document is
 * hidden the drain posts with `keepalive`, (2) flushForUnload() re-posts
 * an already-encrypted queue head with `keepalive`, and (3) the
 * departure frame can go out keepalive too. The relay mock is a real
 * HTTP server, so the assertion is on the fetch init that reached the
 * client's fetchImpl.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RoomsClient } from '../../src/editor/collab/room-client.js';
import { CollabSession } from '../../src/editor/collab/collab-session.js';
import { startRoomsMock, type RoomsMock } from './_rooms-mock.js';
import { docOf, cardNode, sleep } from './_loro-helpers.js';

let mock: RoomsMock;
interface Seen {
  url: string;
  method: string;
  keepalive: boolean;
}
const seen: Seen[] = [];
function spyClient(): RoomsClient {
  return new RoomsClient({
    baseUrl: () => mock.url,
    token: () => mock.token,
    fetchImpl: (input, init) => {
      seen.push({ url: String(input), method: init?.method ?? 'GET', keepalive: init?.keepalive === true });
      return fetch(input, init);
    },
  });
}
function setVisibility(v: 'hidden' | 'visible'): void {
  Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}
const updatePosts = (): Seen[] => seen.filter((r) => r.method === 'POST' && /\/updates$/.test(r.url));
const presencePosts = (): Seen[] => seen.filter((r) => r.method === 'POST' && /\/presence/.test(r.url));

beforeAll(async () => {
  mock = await startRoomsMock();
});
afterAll(async () => {
  await mock.close();
});

describe('unload path: keepalive sends', () => {
  it('a hidden document drains with keepalive; flushForUnload re-posts the encrypted head; farewell can go keepalive', async () => {
    seen.length = 0;
    const { session } = await CollabSession.host({ pmDoc: docOf(cardNode('Tag', ['body'])), client: spyClient(), flushMs: 20, minBackoffMs: 20, maxBackoffMs: 50 });
    session.start();
    await sleep(150); // stream helloed
    try {
      // Visible: an ordinary edit posts WITHOUT keepalive. (Hosting already
      // posted the seed, so every step counts from its own baseline.)
      let n0 = updatePosts().length;
      session.loroDoc.getMap('probe').set('a', 1);
      session.flush();
      await sleep(150);
      expect(updatePosts().slice(n0).length).toBe(1);
      expect(updatePosts().slice(n0)[0]!.keepalive).toBe(false);

      // Hidden (Cmd-W is coming): the drain posts WITH keepalive.
      setVisibility('hidden');
      n0 = updatePosts().length;
      session.loroDoc.getMap('probe').set('b', 2);
      session.flush();
      await sleep(150);
      expect(updatePosts().slice(n0).length).toBe(1);
      expect(updatePosts().slice(n0)[0]!.keepalive, 'a hidden document may be about to unload').toBe(true);

      // A post that FAILED left its encrypted blob on the queue head; the
      // pagehide handler re-posts exactly that, keepalive, without waiting.
      mock.setUpdateFailure({ status: 503, detail: 'draining' });
      session.loroDoc.getMap('probe').set('c', 3);
      session.flush();
      await sleep(150); // the drain encrypted it and got refused
      const before = updatePosts().length;
      session.flushForUnload();
      await sleep(30); // no crypto in the way: the post is on the wire at once
      const after = updatePosts().slice(before);
      expect(after.length, 'the encrypted head went out again').toBeGreaterThanOrEqual(1);
      expect(after.every((r) => r.keepalive)).toBe(true);
      mock.setUpdateFailure(null);

      // Departure frame with keepalive reaches the presence endpoint keepalive.
      await session.sendPresence(new Uint8Array([1, 2, 3, 4]), { keepalive: true });
      expect(presencePosts().length).toBe(1);
      expect(presencePosts()[0]!.keepalive).toBe(true);
      await session.sendPresence(new Uint8Array([1, 2, 3, 4]));
      expect(presencePosts()[1]!.keepalive, 'the ordinary path is untouched').toBe(false);
    } finally {
      mock.setUpdateFailure(null);
      setVisibility('visible');
      await session.stop();
    }
  });
});
