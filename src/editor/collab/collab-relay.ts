/**
 * Rooms-relay endpoint resolution, factored out of collab-ui so LIGHT
 * consumers (the invite seed prefetcher, fired from the always-loaded
 * Receive pill) can build a RoomsClient without pulling the Loro wasm
 * chunk. Resolution order: settings → dev env → baked desktop default
 * (same base + shared token card sharing uses).
 */

import { settings } from '../settings.js';
import { getElectronHost } from '../host/index.js';
import { collabDevRelay } from './collab-gate.js';
import { webEntitlementToken, webRoutingCodeSync } from './web-account.js';
import { RoomsClient, RoomsError } from './room-client.js';
import { WEB_DEFAULT_RELAY_URL } from './relay-endpoint.js';

/** Baked relay endpoint from the desktop main process — resolved once,
 *  used as the LAST fallback so packaged builds work with zero setup.
 *  '' fields mean web edition / old preload / nothing baked.
 *  `routingCode` is non-'' only when the baked token is an entitlement
 *  (machine binding — see relay-protocol.ts). */
let bakedRelay: { url: string; token: string; routingCode: string } | null = null;
let bakedRefreshWired = false;

export async function ensureBakedRelay(): Promise<void> {
  if (bakedRelay) return;
  try {
    const got = await getElectronHost()?.collabRelayDefaults();
    bakedRelay = { url: got?.url ?? '', token: got?.token ?? '', routingCode: got?.routingCode ?? '' };
  } catch {
    bakedRelay = { url: '', token: '', routingCode: '' };
  }
  // Entitlement renewed / relinked in main → re-pull url/token/routing
  // so LIVE sessions serve the fresh credential on their next request
  // (field case 2026-08-29: the 72h entitlement expired mid-session
  // and a stale snapshot 401'd every room call until app restart —
  // renewal, and even unlink+relink, couldn't reach it).
  if (!bakedRefreshWired) {
    bakedRefreshWired = true;
    getElectronHost()?.onPairingEntitlementChanged?.(() => void refreshBakedRelay());
  }
}

/** Re-fetch the baked defaults (fresh entitlement after a renewal
 *  broadcast). Keeps the previous values on failure — a transient IPC
 *  hiccup must not blank a working credential. */
export async function refreshBakedRelay(): Promise<void> {
  try {
    const got = await getElectronHost()?.collabRelayDefaults();
    if (got) {
      bakedRelay = { url: got.url ?? '', token: got.token ?? '', routingCode: got.routingCode ?? '' };
    }
  } catch {
    /* keep previous */
  }
}

// Endpoint isolated in relay-endpoint.ts so Lite builds compile the
// hostname out (desktop still gets its baked URL from the main process
// alongside the shared token, which must never appear here).

/** The resolved relay base URL ('' when nothing is configured) —
 *  shared by the rooms client and the web account-connect flow. */
export function relayBaseUrl(): string {
  const dev = collabDevRelay();
  const webDefault = getElectronHost() ? '' : WEB_DEFAULT_RELAY_URL;
  return (
    settings.get('pairingRelayUrl').trim() ||
    dev?.url ||
    bakedRelay?.url ||
    webDefault
  ).replace(/\/+$/, '');
}

/** A rooms client authenticating with a room GUEST PASS instead of a
 *  token/entitlement — the account-less joiner's credential (Phase 3).
 *  Scope matches the server's: room-data endpoints only, so joins and
 *  live sync work while create/delete stay closed. Null when no relay
 *  URL resolves. */
export function relayClientWithGuestPass(pass: string): RoomsClient | null {
  const url = relayBaseUrl();
  if (!url || !pass) return null;
  return new RoomsClient({
    baseUrl: () => url,
    token: () => pass,
    routingCode: () => '',
    guestAuth: true,
  });
}

/** Resolve the CURRENT credential + its paired routing code. Called
 *  per request (see relayClient) — never snapshot the result into a
 *  long-lived closure: entitlements expire after ~72h and renew in the
 *  background, and a frozen snapshot 401'd every room call of a
 *  long-running session until app restart (field case 2026-08-29).
 *
 *  A linked account's entitlement outranks the dev/prototype token:
 *  it's the real credential class, and it carries the wk1 routing code
 *  the relay's machine binding expects. Settings-field overrides
 *  (self-host) still win over everything. The routing code is bound to
 *  the ENTITLEMENT that minted it — a settings/dev token override is
 *  never an entitlement, so the header must not ride along there. */
function resolveCredential(): { token: string; routingCode: string } {
  const dev = collabDevRelay();
  const webToken = webEntitlementToken();
  const settingsToken = settings.get('pairingRelayToken').trim();
  const token = settingsToken || webToken || dev?.token || bakedRelay?.token || '';
  const routingCode = settingsToken
    ? ''
    : webToken
      ? webRoutingCodeSync()
      : dev?.token
        ? ''
        : (bakedRelay?.routingCode ?? '');
  return { token, routingCode };
}

export function relayClient(): RoomsClient | null {
  const url = relayBaseUrl();
  if (!url || !resolveCredential().token) return null;
  // LIVE suppliers — the entitlement swap seam the interface
  // documents. The one construction-time decision is existence (null
  // when nothing is configured); everything else is read per request
  // so renewal/relink heals a running session on its next call.
  return new RoomsClient({
    baseUrl: () => relayBaseUrl() || url,
    token: () => resolveCredential().token,
    routingCode: () => resolveCredential().routingCode,
    // ONE resolution per request: the separate token/routingCode
    // suppliers each re-ran the full resolution (~4 storage reads + the
    // settings reads) — three times per request, at cursor-presence
    // rates on the typing thread (2026-09-01 review, T13). Still
    // re-read per request: no memo, no staleness.
    credentials: () => resolveCredential(),
  });
}

/** Tombstone a room on the relay — the home-screen Sessions list's host-side
 *  "End Session" (no live session object exists there, so this speaks to the
 *  relay directly). A room that is already ended (410) or expired/GC'd (404)
 *  counts as success: the goal — nobody can rejoin — already holds. Throws on
 *  anything else (offline, auth) so the caller can KEEP the record and let
 *  the host retry; deleting it without the tombstone would strand a live room
 *  that invited participants can silently rejoin. */
export async function endRoomOnRelay(roomId: string): Promise<void> {
  await ensureBakedRelay();
  const client = relayClient();
  if (!client) throw new Error('no relay configured');
  try {
    await client.deleteRoom(roomId);
  } catch (err) {
    if (err instanceof RoomsError && (err.status === 410 || err.status === 404)) return;
    throw err;
  }
}
