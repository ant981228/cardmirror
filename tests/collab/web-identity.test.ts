/**
 * Web browser identity + account linking (web-collab Phase 2).
 * Runs in Node (real WebCrypto) with fake-indexeddb; localStorage is a
 * stub since there is no window here.
 *
 * Pinned:
 *  - the routing code is stable, "wk1."-prefixed, and derived from the
 *    public key (verified independently from the exported spki)
 *  - proofs verify with the real public key over the canonical payload
 *    and are purpose-scoped
 *  - connect stores the entitlement; the sync suppliers serve it until
 *    expiry; renewal is a no-op with margin left, posts a code-less
 *    key-proof body when due, and a 401 answer drops the credential
 *    but keeps the key's routing code
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

function makeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  } as Storage;
}

(globalThis as Record<string, unknown>)['window'] = { localStorage: makeStorage() };

import {
  webRoutingCode,
  signWebProof,
  b64url,
  __resetWebIdentityCacheForTests,
} from '../../src/editor/collab/web-identity.js';
import {
  webAccountConnect,
  webAccountRenew,
  webAccountStatus,
  webEntitlementToken,
  webRoutingCodeSync,
  webAccountDisconnect,
  webAccountUnlink,
  __resetWebAccountForTests,
  scheduleWebRenewal,
  webDeviceLabel,
} from '../../src/editor/collab/web-account.js';

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}

afterEach(() => {
  __resetWebAccountForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('web identity', () => {
  it('routing code is stable, prefixed, and is the spki hash', async () => {
    const rc1 = await webRoutingCode();
    __resetWebIdentityCacheForTests(); // reload from IndexedDB, not memory
    const rc2 = await webRoutingCode();
    expect(rc1).toBe(rc2);
    expect(rc1.startsWith('wk1.')).toBe(true);

    const proof = await signWebProof('connect');
    const spki = b64urlToBytes(proof.webSpki);
    const hash = await crypto.subtle.digest('SHA-256', spki as BufferSource);
    expect(rc1).toBe('wk1.' + b64url(hash));
  });

  it('proofs verify with the real public key and are purpose-scoped', async () => {
    const rc = await webRoutingCode();
    const proof = await signWebProof('renew');
    const spki = b64urlToBytes(proof.webSpki);
    const pub = await crypto.subtle.importKey(
      'spki',
      spki as BufferSource,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const sig = b64urlToBytes(proof.webSig);
    const payloadFor = (purpose: string) =>
      new TextEncoder().encode(`cmweb1:${purpose}:${rc}:${proof.webTs}`);
    const verify = (purpose: string) =>
      crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        pub,
        sig as BufferSource,
        payloadFor(purpose) as BufferSource,
      );
    expect(await verify('renew')).toBe(true);
    expect(await verify('connect')).toBe(false); // purpose is in the payload
    expect(Math.abs(proof.webTs - Date.now() / 1000)).toBeLessThan(10);
    expect(sig.length).toBe(64); // raw r||s, WebCrypto's shape
  });
});

describe('web account linking', () => {
  const BASE = 'http://relay.test/relay';
  let fetchMock: ReturnType<typeof vi.fn>;
  let lastBody: Record<string, unknown> = {};

  beforeEach(() => {
    fetchMock = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      lastBody = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
      return {
        ok: true,
        json: async () => ({
          entitlement: 'ent-token-1',
          expiresAt: Date.now() + 24 * 3600 * 1000,
          email: 'user@example.com',
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  it('connect posts code + key proof, stores, and the sync suppliers serve it', async () => {
    const status = await webAccountConnect(BASE, ' abc123 ');
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/connect`, expect.anything());
    expect(lastBody['connectCode']).toBe('abc123');
    expect(String(lastBody['routingCode'])).toMatch(/^wk1\./);
    expect(typeof lastBody['webSpki']).toBe('string');
    expect(typeof lastBody['webSig']).toBe('string');
    expect(status.connected).toBe(true);
    expect(status.email).toBe('user@example.com');
    expect(webEntitlementToken()).toBe('ent-token-1');
    expect(webRoutingCodeSync()).toBe(String(lastBody['routingCode']));
  });

  it('connect carries the picked seat + a device label; renewal refreshes the label (2026-09-02)', async () => {
    await webAccountConnect(BASE, 'code-1', { confirmEvict: true, evict: 'wk1.other-machine' });
    expect(lastBody['confirmEvict']).toBe(true);
    expect(lastBody['evict']).toBe('wk1.other-machine');
    expect(typeof lastBody['deviceLabel']).toBe('string');
    expect(String(lastBody['deviceLabel']).length).toBeGreaterThan(0);
    expect(webDeviceLabel()).toBe(lastBody['deviceLabel']);
    // No pick → no `evict` key at all (older relays never see it).
    await webAccountConnect(BASE, 'code-2');
    expect('evict' in lastBody).toBe(false);
    await webAccountRenew(BASE, true);
    expect(lastBody['connectCode']).toBe('');
    expect(lastBody['deviceLabel']).toBe(webDeviceLabel());
  });

  it('an expired entitlement stops being served', async () => {
    await webAccountConnect(BASE, 'abc');
    window.localStorage.setItem('pmd-web-entitlement-exp', String(Date.now() - 1000));
    expect(webEntitlementToken()).toBe('');
    expect(webAccountStatus().connected).toBe(false);
  });

  it('renewal: margin no-op, code-less proof when forced, 401 drops the link but keeps the rc', async () => {
    await webAccountConnect(BASE, 'abc');
    fetchMock.mockClear();
    await webAccountRenew(BASE); // 24h left > 12h margin
    expect(fetchMock).not.toHaveBeenCalled();

    await webAccountRenew(BASE, true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastBody['connectCode']).toBe('');
    expect(typeof lastBody['webSig']).toBe('string');

    const rc = webRoutingCodeSync();
    fetchMock.mockImplementation(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ detail: 'no binding' }),
    }));
    await webAccountRenew(BASE, true);
    expect(webAccountStatus().connected).toBe(false);
    expect(webRoutingCodeSync()).toBe(rc); // the key's identity survives
  });

  it('renewal hardening (2026-09-01 review, T6): single-flight, portal 401s are transient, wake triggers renew', async () => {
    await webAccountConnect(BASE, 'abc');
    fetchMock.mockClear();
    // (a) Two forced renewals racing → ONE /connect (desktop's renewing
    // guard, mirrored). Both settle; the loser must not clobber.
    await Promise.all([webAccountRenew(BASE, true), webAccountRenew(BASE, true)]);
    expect(fetchMock, 'single-flight renewal').toHaveBeenCalledTimes(1);
    expect(webAccountStatus().connected).toBe(true);

    // (b) A captive portal's HTML 401 is NOT the relay speaking — keep the link.
    fetchMock.mockImplementationOnce(async () => ({
      ok: false,
      status: 401,
      json: async () => {
        throw new Error('not json');
      },
    }));
    await webAccountRenew(BASE, true);
    expect(webAccountStatus().connected, 'portal 401 keeps the credential').toBe(true);

    // (c) Waking up (online / tab visible) triggers a renewal check when
    // the entitlement is inside the margin — the 30-minute timer alone
    // left a laptop asleep past the margin burning 401s. This file's
    // window/document stubs have no event machinery; lend them one.
    const et = new EventTarget();
    const g = globalThis as unknown as { window: Record<string, unknown>; document?: Record<string, unknown> };
    Object.assign(g.window, {
      addEventListener: et.addEventListener.bind(et),
      removeEventListener: et.removeEventListener.bind(et),
      dispatchEvent: et.dispatchEvent.bind(et),
    });
    g.document = Object.assign(g.document ?? {}, {
      addEventListener: () => {},
      removeEventListener: () => {},
      visibilityState: 'visible',
    });
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ entitlement: 'ent-short', expiresAt: Date.now() + 60 * 60 * 1000 }),
    }));
    await webAccountRenew(BASE, true); // now 1h left < 12h margin
    fetchMock.mockClear();
    scheduleWebRenewal(BASE);
    await new Promise((r) => setTimeout(r, 0));
    fetchMock.mockClear(); // the schedule's own immediate check
    window.dispatchEvent(new Event('online'));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock, 'online → renewal attempted').toHaveBeenCalled();
    __resetWebAccountForTests();
  });

  it('disconnect clears the credential, not the identity', async () => {
    await webAccountConnect(BASE, 'abc');
    const rc = webRoutingCodeSync();
    webAccountDisconnect();
    expect(webEntitlementToken()).toBe('');
    expect(webRoutingCodeSync()).toBe(rc);
  });

  it('unlink wipes locally FIRST, then posts a disconnect-purpose seat release', async () => {
    await webAccountConnect(BASE, 'abc');
    const rc = webRoutingCodeSync();
    fetchMock.mockClear();
    let sawTokenAtFetchTime: string | null = null;
    let releaseBody: Record<string, unknown> = {};
    const released = new Promise<void>((resolve) => {
      fetchMock.mockImplementation(async (_url: unknown, init?: { body?: string }) => {
        sawTokenAtFetchTime = webEntitlementToken();
        releaseBody = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
        resolve();
        return { ok: true, json: async () => ({ ok: true, released: true }) };
      });
    });
    webAccountUnlink(BASE);
    // Local wipe is synchronous — a quick re-connect can't be clobbered.
    expect(webEntitlementToken()).toBe('');
    expect(webRoutingCodeSync()).toBe(rc);
    await released;
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/disconnect`, expect.anything());
    expect(sawTokenAtFetchTime).toBe(''); // release ran after the wipe
    expect(releaseBody['routingCode']).toBe(rc);
    // The proof is purpose-scoped to 'disconnect' — a captured connect
    // proof must not release seats, and vice versa.
    const pub = await crypto.subtle.importKey(
      'spki',
      b64urlToBytes(String(releaseBody['webSpki'])) as BufferSource,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const verify = (purpose: string) =>
      crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        pub,
        b64urlToBytes(String(releaseBody['webSig'])) as BufferSource,
        new TextEncoder().encode(
          `cmweb1:${purpose}:${rc}:${releaseBody['webTs']}`,
        ) as BufferSource,
      );
    expect(await verify('disconnect')).toBe(true);
    expect(await verify('connect')).toBe(false);
  });

  it('unlink with nothing linked posts nothing', async () => {
    fetchMock.mockClear();
    webAccountUnlink(BASE);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
