// @vitest-environment node
/**
 * The entitlement decision core (pairing-entitlement.ts): stored-state
 * validation, the validity slack, the renewal window, and the
 * /relay/connect response taxonomy the runbook verified against the
 * live relay (bind, renew-keeping-email, seatLimit confirm flow,
 * visible eviction, badCode/subscription/unsupported).
 */
import { describe, it, expect } from 'vitest';
import {
  parseStoredEntitlement,
  entitlementIfValid,
  renewalDue,
  interpretConnectResponse,
  nextLapsedFlag,
  type EntitlementState,
  renewalRetryDelayMs,
} from '../../apps/desktop/src/pairing-entitlement.js';

const NOW = 1_800_000_000_000;
const HOUR = 3600 * 1000;
const state = (over: Partial<EntitlementState> = {}): EntitlementState => ({
  entitlement: 'jwt-abc',
  expiresAt: NOW + 72 * HOUR,
  email: 'member@example.com',
  ...over,
});

describe('parseStoredEntitlement', () => {
  it('accepts the persisted shape and defaults a missing email', () => {
    expect(parseStoredEntitlement({ entitlement: 'e', expiresAt: 5 })).toEqual({
      entitlement: 'e',
      expiresAt: 5,
      email: '',
    });
  });

  it('rejects malformed payloads', () => {
    for (const bad of [null, 42, 'x', {}, { entitlement: 'e' }, { entitlement: 7, expiresAt: 5 }]) {
      expect(parseStoredEntitlement(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('entitlementIfValid (60s slack)', () => {
  it('is valid comfortably before expiry and null within the slack', () => {
    expect(entitlementIfValid(state(), NOW)).not.toBeNull();
    expect(entitlementIfValid(state({ expiresAt: NOW + 61_000 }), NOW)).not.toBeNull();
    // Inside the final 60s a token could expire mid-request — treat as gone.
    expect(entitlementIfValid(state({ expiresAt: NOW + 59_000 }), NOW)).toBeNull();
    expect(entitlementIfValid(state({ expiresAt: NOW - 1 }), NOW)).toBeNull();
    expect(entitlementIfValid(null, NOW)).toBeNull();
  });
});

describe('renewalDue', () => {
  it('is quiet while more than 24h remain (with a known email)', () => {
    expect(renewalDue(state({ expiresAt: NOW + 25 * HOUR }), NOW)).toBe(false);
  });

  it('renews inside the final 24h and after expiry (30-day relay grace)', () => {
    expect(renewalDue(state({ expiresAt: NOW + 23 * HOUR }), NOW)).toBe(true);
    expect(renewalDue(state({ expiresAt: NOW - 5 * 24 * HOUR }), NOW)).toBe(true);
  });

  it('renews immediately when the stored state predates the email echo', () => {
    expect(renewalDue(state({ email: '', expiresAt: NOW + 60 * 24 * HOUR }), NOW)).toBe(true);
  });
});

describe('interpretConnectResponse', () => {
  it('200 binds and reports the linked email', () => {
    const r = interpretConnectResponse(
      200,
      { entitlement: 'jwt-new', expiresAt: NOW + 24 * HOUR, email: 'm@x.com' },
      null,
    );
    expect(r.outcome).toEqual({ ok: true, expiresAt: NOW + 24 * HOUR, email: 'm@x.com' });
    expect(r.next).toEqual({ entitlement: 'jwt-new', expiresAt: NOW + 24 * HOUR, email: 'm@x.com' });
    expect(r.evicted).toBe(false);
  });

  it('a renewal that blanked the (fail-open) email lookup keeps the last-known email', () => {
    const r = interpretConnectResponse(
      200,
      { entitlement: 'jwt-new', expiresAt: NOW + 24 * HOUR },
      state(),
    );
    expect((r.next as EntitlementState).email).toBe('member@example.com');
    expect(r.outcome.email).toBe('member@example.com');
  });

  it('a 200 missing the entitlement fields is a plain http error, not a bind', () => {
    const r = interpretConnectResponse(200, {}, state());
    expect(r.outcome.ok).toBe(false);
    expect(r.next).toBeUndefined(); // stored state untouched
  });

  it('409 seatLimit carries the confirm-flow payload and leaves state untouched', () => {
    const r = interpretConnectResponse(
      409,
      {
        detail: {
          error: 'seatLimit',
          limit: 2,
          wouldEvict: { routingCode: 'rc-old', boundAt: '2026-07-01' },
          retryCode: 'FRESH-CODE',
        },
      },
      state(),
    );
    expect(r.outcome).toMatchObject({
      ok: false,
      error: 'seatLimit',
      limit: 2,
      retryCode: 'FRESH-CODE',
    });
    expect(r.outcome.wouldEvict?.routingCode).toBe('rc-old');
    expect(r.next).toBeUndefined();
    expect(r.evicted).toBe(false);
  });

  it('409 youWereEvicted clears the stored entitlement and flags the broadcast', () => {
    const r = interpretConnectResponse(409, { detail: { error: 'youWereEvicted' } }, state());
    expect(r.outcome).toEqual({ ok: false, error: 'evicted' });
    expect(r.next).toBeNull(); // clear
    expect(r.evicted).toBe(true);
  });

  it('maps 401/403/404 to badCode/subscription/unsupported without touching state', () => {
    for (const [status, error] of [
      [401, 'badCode'],
      [403, 'subscription'],
      [404, 'unsupported'],
    ] as const) {
      const r = interpretConnectResponse(status, {}, state());
      expect(r.outcome).toEqual({ ok: false, error });
      expect(r.next).toBeUndefined();
      expect(r.evicted).toBe(false);
    }
  });

  it('any other status surfaces the raw code', () => {
    expect(interpretConnectResponse(500, {}, null).outcome).toEqual({
      ok: false,
      error: 'http 500',
    });
  });
});

describe('nextLapsedFlag', () => {
  it('a 403 marks the membership lapsed; success or eviction clears it', () => {
    expect(nextLapsedFlag(false, { ok: false, error: 'subscription' }, false)).toBe(true);
    expect(nextLapsedFlag(true, { ok: true }, false)).toBe(false);
    expect(nextLapsedFlag(true, { ok: false, error: 'evicted' }, true)).toBe(false);
  });

  it('failures that say nothing about the membership leave the flag alone', () => {
    for (const error of ['network', 'badCode', 'seatLimit', 'http 500']) {
      expect(nextLapsedFlag(true, { ok: false, error }, false), error).toBe(true);
      expect(nextLapsedFlag(false, { ok: false, error }, false), error).toBe(false);
    }
  });
});

describe('seat picker (relay ≥ 2026-09-02)', () => {
  it('409 seatLimit carries the candidate list when the relay sends one, state untouched', () => {
    const candidates = [
      { routingCode: 'rc-laptop-full', boundAt: '2026-08-16T00:00:00Z', lastSeenAt: '2026-09-01T00:00:00Z', label: 'Laptop (macOS)' },
      { routingCode: 'rc-vm-full', boundAt: '2026-08-20T00:00:00Z', lastSeenAt: '2026-08-25T00:00:00Z', label: '' },
    ];
    const r = interpretConnectResponse(
      409,
      { detail: { error: 'seatLimit', limit: 2, retryCode: 'R2', wouldEvict: { routingCode: 'rc-lapt', boundAt: '2026-08-16T00:00:00Z' }, candidates } },
      state(),
    );
    expect(r.outcome.error).toBe('seatLimit');
    expect(r.outcome.candidates).toEqual(candidates);
    expect(r.outcome.retryCode).toBe('R2');
    expect(r.next).toBeUndefined();
    expect(r.evicted).toBe(false);
  });

  it('an older relay (no candidates) leaves the field absent — the legacy confirm flow', () => {
    const r = interpretConnectResponse(
      409,
      { detail: { error: 'seatLimit', limit: 2, retryCode: 'R', wouldEvict: { routingCode: 'abc', boundAt: 'x' } } },
      state(),
    );
    expect(r.outcome.candidates).toBeUndefined();
    expect(r.outcome.wouldEvict).toEqual({ routingCode: 'abc', boundAt: 'x' });
  });
});

describe('renewalRetryDelayMs (refused renewals back off instead of retrying every poll)', () => {
  it('refusals only a person can fix wait 6h; transient failures 15min; success and eviction 0', () => {
    expect(renewalRetryDelayMs({ ok: true })).toBe(0);
    expect(renewalRetryDelayMs({ ok: false, error: 'evicted' })).toBe(0);
    for (const error of ['subscription', 'badCode', 'unsupported']) {
      expect(renewalRetryDelayMs({ ok: false, error }), error).toBe(6 * HOUR);
    }
    expect(renewalRetryDelayMs({ ok: false, error: 'network' })).toBe(15 * 60 * 1000);
    expect(renewalRetryDelayMs({ ok: false, error: 'http 502' })).toBe(15 * 60 * 1000);
  });
});
