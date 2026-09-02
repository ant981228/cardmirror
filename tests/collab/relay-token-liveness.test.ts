/**
 * Rooms-client credential LIVENESS (field bug 2026-08-29): the client
 * `relayClient()` builds must re-read its bearer per request — the
 * "entitlement swap seam" its interface documents. It was capturing a
 * snapshot instead, so a long-lived collab session kept presenting an
 * entitlement that expired (72h server TTL) — every room call 401'd
 * forever, background renewal couldn't reach the frozen closure, and
 * even unlink + relink didn't heal a running session.
 *
 * Pinned: token() and routingCode() reflect the CURRENT stores at
 * call time — entitlement rotation (renewal/relink), a settings
 * override appearing, and the settings override outranking the
 * entitlement, all without rebuilding the client.
 */
const store = new Map<string, string>();
(globalThis as Record<string, unknown>)['window'] = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as Storage,
  addEventListener: () => {},
  removeEventListener: () => {},
  location: { search: '', href: 'http://localhost/' },
};
(globalThis as Record<string, unknown>)['document'] = {
  addEventListener: () => {},
  removeEventListener: () => {},
  visibilityState: 'visible',
};

import { describe, it, expect, beforeEach } from 'vitest';
import { settings } from '../../src/editor/settings.js';
import { relayClient } from '../../src/editor/collab/collab-relay.js';

function linkWebAccount(token: string, routingCode = 'wk1.livenesstest'): void {
  store.set('pmd-web-entitlement', token);
  store.set('pmd-web-entitlement-exp', String(Date.now() + 3600_000));
  store.set('pmd-web-routing-code', routingCode);
}

beforeEach(() => {
  store.clear();
  settings.set('pairingRelayUrl', 'http://relay.test/relay');
  settings.set('pairingRelayToken', '');
});

describe('one credential resolution per request (2026-09-01 review, T13)', () => {
  it('a request resolves the credential once, not once per header', async () => {
    const { vi } = await import('vitest');
    settings.set('pairingRelayUrl', 'https://relay.example/relay');
    settings.set('pairingRelayToken', 'tok-A');
    const client = relayClient()!;
    // Stub the wire: the request must still assemble its headers.
    (client.opts as { fetchImpl?: unknown }).fetchImpl = async () =>
      new Response('{"seq":1}', { status: 202, headers: { 'Content-Type': 'application/json' } });
    const spy = vi.spyOn(window.localStorage, 'getItem');
    await client.postUpdate('room', new Uint8Array([1, 2, 3]));
    // Before: token() + routingCode() each ran the full resolution (dev
    // relay 2 reads + web token 2 reads each) → ~8 storage reads for the
    // credential alone. One combined resolution → at most ~4.
    expect(spy.mock.calls.length).toBeLessThanOrEqual(6);
    spy.mockRestore();
    // Liveness unchanged: the next request sees a settings write at once.
    settings.set('pairingRelayToken', 'tok-B');
    expect(client.opts.credentials!().token).toBe('tok-B');
  });
});

describe('relayClient credential liveness', () => {
  it('a renewed/relinked entitlement reaches an ALREADY-RUNNING session', () => {
    linkWebAccount('entitlement-A');
    const client = relayClient()!;
    expect(client.opts.token()).toBe('entitlement-A');
    // 72h later: renewal (or the user relinking) stores a fresh token.
    linkWebAccount('entitlement-B-fresh');
    expect(client.opts.token()).toBe('entitlement-B-fresh');
  });

  it('routingCode stays paired with the credential source at call time', () => {
    linkWebAccount('entitlement-A', 'wk1.originalcode');
    const client = relayClient()!;
    expect(client.opts.routingCode!()).toBe('wk1.originalcode');
    // A self-host token override appears mid-session: it is not an
    // entitlement, so the machine-binding header must drop with it.
    settings.set('pairingRelayToken', 'self-host-token');
    expect(client.opts.token()).toBe('self-host-token');
    expect(client.opts.routingCode!()).toBe('');
  });

  it('an entitlement that EXPIRES stops being presented (no stale bearer)', () => {
    linkWebAccount('entitlement-A');
    const client = relayClient()!;
    expect(client.opts.token()).toBe('entitlement-A');
    // Expiry passes with no renewal (offline machine): the supplier
    // must stop serving the dead bearer rather than 401 forever.
    store.set('pmd-web-entitlement-exp', String(Date.now() - 1000));
    expect(client.opts.token()).not.toBe('entitlement-A');
  });
});
