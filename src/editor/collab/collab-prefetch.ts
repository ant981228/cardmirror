/**
 * Invite seed prefetch (§4.1). On invite receipt the Receive pill fires
 * this eagerly: the room's encrypted backlog (snapshot fast-path +
 * tail) is downloaded and stored AS CIPHERTEXT in the collab store, so
 * an invite accepted later — on a bus, fully offline — still opens the
 * doc and joins the session locally, syncing at the next connectivity
 * window. The room key never touches this module (it stays inside the
 * share code); consuming the prefetch is joinSessionWithCode's offline
 * fallback, which decrypts with the key it already holds.
 *
 * LIGHT by design: no Loro imports — this loads from the always-on
 * pairing UI without pulling the wasm chunk.
 */

import { ensureBakedRelay, relayClient } from './collab-relay.js';
import { loadPrefetch, savePrefetch } from './collab-store.js';

/** Re-fetch when the stored prefetch is older than this — the room
 *  gains updates while the invite sits unopened, and a fresher seed
 *  means less to sync after an offline join. */
const STALE_MS = 60 * 60 * 1000;

/** Room id straight off a share code (`cmshare1.<roomId>.<key>` or
 *  `cmshare2.<roomId>.<key>.<minVersion>`) — a string split, so light
 *  consumers don't need the crypto module. */
export function roomIdFromShareCode(code: string): string | null {
  const parts = code.trim().split('.');
  if (parts.length === 3 && parts[0] === 'cmshare1' && parts[1]) return parts[1];
  // v2 floors contain dots ("1.0.0"), so 4+ parts.
  if (parts.length >= 4 && parts[0] === 'cmshare2' && parts[1]) return parts[1];
  return null;
}

const inFlight = new Set<string>();

export async function prefetchInviteSeed(shareCode: string): Promise<void> {
  const roomId = roomIdFromShareCode(shareCode);
  if (!roomId || inFlight.has(roomId)) return;
  inFlight.add(roomId);
  try {
    const existing = await loadPrefetch(roomId);
    if (existing && Date.now() - existing.fetchedAt < STALE_MS) return;
    await ensureBakedRelay();
    const client = relayClient();
    if (!client) return;

    const blobs: Uint8Array[] = [];
    let after = 0;
    for (;;) {
      const page = await client.fetchUpdates(roomId, after);
      if (page.snapshot && after < page.snapshot.coversThroughSeq) {
        blobs.push(page.snapshot.blob);
      }
      for (const u of page.updates) blobs.push(u.blob);
      const next = page.lastSeq;
      if (page.more && next <= after) break; // non-advancing page: never loop on it
      after = next;
      if (!page.more) break;
    }
    if (blobs.length === 0) return;
    await savePrefetch({ roomId, blobs, lastSeq: after, fetchedAt: Date.now() });
  } catch {
    /* offline / room gone — the prefetch is opportunistic */
  } finally {
    inFlight.delete(roomId);
  }
}
