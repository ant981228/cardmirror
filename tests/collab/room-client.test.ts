/**
 * Rooms transport against the in-process mock: REST round-trips,
 * snapshot-aware paging, typed errors, and the SSE stream's hello /
 * update / presence / end handling with reconnect.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RoomsClient, RoomsError, RoomStream, type RoomUpdate } from '../../src/editor/collab/room-client.js';
import { startRoomsMock, type RoomsMock } from './_rooms-mock.js';

let mock: RoomsMock;
let client: RoomsClient;

beforeAll(async () => {
  mock = await startRoomsMock();
  client = new RoomsClient({ baseUrl: () => mock.url, token: () => mock.token });
});
afterAll(async () => {
  await mock.close();
});

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('RoomsClient', () => {
  it('creates rooms, appends updates, pages them back', async () => {
    const { roomId } = await client.createRoom();
    const s1 = await client.postUpdate(roomId, bytes('one'));
    const s2 = await client.postUpdate(roomId, bytes('two'));
    expect(s2).toBeGreaterThan(s1);
    const page = await client.fetchUpdates(roomId, 0);
    expect(page.updates.map((u) => text(u.blob))).toEqual(['one', 'two']);
    expect(page.lastSeq).toBe(s2);
    const tail = await client.fetchUpdates(roomId, s1);
    expect(tail.updates.map((u) => text(u.blob))).toEqual(['two']);
  });

  it('serves the snapshot to joiners and truncates the log', async () => {
    const { roomId } = await client.createRoom();
    const s1 = await client.postUpdate(roomId, bytes('seed'));
    await client.postUpdate(roomId, bytes('after-snap'));
    await client.postSnapshot(roomId, btoa('SNAP'), s1);
    const page = await client.fetchUpdates(roomId, 0);
    expect(text(page.snapshot!.blob)).toBe('SNAP');
    expect(page.snapshot!.coversThroughSeq).toBe(s1);
    expect(page.updates.map((u) => text(u.blob))).toEqual(['after-snap']);
  });

  it('maps 404/410 to typed errors', async () => {
    await expect(client.fetchUpdates('nope', 0)).rejects.toMatchObject({ status: 404 });
    const { roomId } = await client.createRoom();
    await client.deleteRoom(roomId);
    const err = await client.fetchUpdates(roomId, 0).catch((e: RoomsError) => e);
    expect(err).toBeInstanceOf(RoomsError);
    expect((err as RoomsError).status).toBe(410);
  });

  it('carries the relay\u2019s error detail on non-2xx (413 texts differ and must reach the user)', async () => {
    // The relay answers 413 for BOTH 'update too large' and 'room storage
    // cap reached'; discarding the body left the field with a bare
    // 'rooms request failed: 413' (2026-09-01 review, T9).
    const { roomId } = await client.createRoom();
    mock.setUpdateFailure({ status: 413, detail: 'room storage cap reached' });
    try {
      await expect(client.postUpdate(roomId, bytes('x'))).rejects.toMatchObject({
        status: 413,
        message: expect.stringContaining('room storage cap reached'),
      });
    } finally {
      mock.setUpdateFailure(null);
    }
  });

  it('keeps live transport counters (requests, failures by class, last error)', async () => {
    const c = new RoomsClient({ baseUrl: () => mock.url, token: () => mock.token });
    const { roomId } = await c.createRoom();
    await c.postUpdate(roomId, bytes('ok'));
    expect(c.stats.requests).toBe(2);
    expect(c.stats.failures).toBe(0);
    expect(c.stats.lastOkAt).toBeGreaterThan(0);
    mock.setUpdateFailure({ status: 413, detail: 'update too large' });
    try {
      await c.postUpdate(roomId, bytes('big')).catch(() => {});
    } finally {
      mock.setUpdateFailure(null);
    }
    expect(c.stats.failures).toBe(1);
    expect(c.stats.clientErrors).toBe(1);
    expect(c.stats.lastError).toContain('update too large');
    mock.pause();
    try {
      await c.postUpdate(roomId, bytes('x')).catch(() => {});
    } finally {
      mock.resume();
    }
    expect(c.stats.serverErrors).toBe(1);
  });

  it('surfaces a clear RoomsError when an interceptor answers HTML instead of JSON', async () => {
    // A school content filter (Securly — field bug 2026-07-10), captive
    // portal, or misconfigured relay URL answers 200 + an HTML page; the
    // client must say so plainly rather than leak the raw JSON.parse error.
    const html = '<!DOCTYPE html><html><body>Blocked by your administrator</body></html>';
    const intercepted = new RoomsClient({
      baseUrl: () => 'https://relay.example',
      token: () => 't',
      fetchImpl: async () =>
        new Response(html, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    });
    const err = await intercepted.fetchUpdates('room1', 0).catch((e: RoomsError) => e);
    expect(err).toBeInstanceOf(RoomsError);
    expect((err as RoomsError).message).toMatch(/web page instead of session data/);
    // Names the URL it actually hit — the diagnostic we need from the field.
    expect((err as RoomsError).message).toContain('https://relay.example/rooms/room1/updates?after=0');
    expect((err as RoomsError).message).not.toMatch(/Unexpected token/);
  });
});

describe('RoomStream', () => {
  it('delivers hello, live updates, presence, and end', async () => {
    const { roomId } = await client.createRoom();
    await client.postUpdate(roomId, bytes('pre'));
    const events: string[] = [];
    const updates: RoomUpdate[] = [];
    const stream = new RoomStream({
      baseUrl: () => mock.url,
      token: () => mock.token,
      roomId,
      minBackoffMs: 20,
      maxBackoffMs: 50,
      callbacks: {
        onHello: (lastSeq) => events.push(`hello:${lastSeq}`),
        onUpdate: (u) => updates.push(u),
        onPresence: (b) => events.push(`presence:${text(b)}`),
        onEnded: () => events.push('ended'),
        onFull: () => events.push('full'),
      },
    });
    stream.start();
    await sleep(50);
    expect(events[0]).toMatch(/^hello:\d+$/);
    await client.postUpdate(roomId, bytes('live'));
    await client.postPresence(roomId, bytes('cursor'));
    await sleep(50);
    expect(updates.map((u) => text(u.blob))).toEqual(['live']);
    expect(events).toContain('presence:cursor');
    await client.deleteRoom(roomId);
    await sleep(50);
    expect(events).toContain('ended');
    expect(stream.running).toBe(false);
  });

  it('reconnects after a transport outage and re-hellos', async () => {
    const { roomId } = await client.createRoom();
    const hellos: number[] = [];
    const stream = new RoomStream({
      baseUrl: () => mock.url,
      token: () => mock.token,
      roomId,
      minBackoffMs: 20,
      maxBackoffMs: 60,
      callbacks: {
        onHello: (n) => hellos.push(n),
        onUpdate: () => {},
        onPresence: () => {},
        onEnded: () => {},
        onFull: () => {},
      },
    });
    stream.start();
    await sleep(50);
    expect(hellos.length).toBe(1);
    mock.pause();
    stream.restart(); // drop the live socket; retries now hit 503s
    await sleep(120);
    mock.resume();
    await sleep(200);
    expect(hellos.length).toBeGreaterThanOrEqual(2);
    stream.stop();
  });

  it('nudge never aborts an in-flight handshake; restart does', async () => {
    // The send loop calls nudge() on every success — during a slow
    // handshake that must be a no-op, or steady typing aborts every
    // connection before its hello (the field-observed starvation).
    mock.setHelloDelay(150);
    try {
      const { roomId } = await client.createRoom();
      let hellos = 0;
      const stream = new RoomStream({
        baseUrl: () => mock.url,
        token: () => mock.token,
        roomId,
        minBackoffMs: 20,
        maxBackoffMs: 50,
        callbacks: {
          onHello: () => hellos++,
          onUpdate: () => {},
          onPresence: () => {},
          onEnded: () => {},
          onFull: () => {},
        },
      });
      const before = mock.streamAttempts();
      stream.start();
      await sleep(40); // mid-handshake (hello still 110ms away)
      stream.nudge();
      stream.nudge();
      stream.nudge();
      await sleep(200);
      expect(hellos).toBe(1);
      expect(mock.streamAttempts() - before).toBe(1); // no extra connects
      stream.restart(); // the hard variant DOES abort + reconnect
      await sleep(250);
      expect(hellos).toBe(2);
      expect(mock.streamAttempts() - before).toBe(2);
      stream.stop();
    } finally {
      mock.setHelloDelay(0);
    }
  });

  it('fires onAuthDead on the SECOND relay-confirmed 401, not the first', async () => {
    const { roomId } = await client.createRoom();
    let authDead = 0;
    const stream = new RoomStream({
      baseUrl: () => mock.url,
      token: () => 'expired-guest-pass',
      roomId,
      // Jitter is 30-100% of the backoff, so the first retry lands no
      // sooner than 30ms here — the 15ms probe below sees exactly one
      // attempt.
      minBackoffMs: 100,
      maxBackoffMs: 200,
      callbacks: {
        onHello: () => {},
        onUpdate: () => {},
        onPresence: () => {},
        onEnded: () => {},
        onFull: () => {},
        onAuthDead: () => {
          authDead++;
          stream.stop(); // the guest-session policy: terminal
        },
      },
    });
    stream.start();
    await sleep(15); // one attempt so far
    expect(authDead).toBe(0);
    await sleep(250); // past the first backoff → second confirmed 401
    expect(authDead).toBe(1);
    expect(stream.running).toBe(false);
  });

  it('captive-portal 401s (HTML body) never count as auth-dead and heal on their own', async () => {
    const { roomId } = await client.createRoom();
    let authDead = 0;
    const hellos: number[] = [];
    mock.setPortalMode(true);
    const stream = new RoomStream({
      baseUrl: () => mock.url,
      token: () => mock.token, // credential is fine — the portal is in the way
      roomId,
      minBackoffMs: 20,
      maxBackoffMs: 40,
      callbacks: {
        onHello: (n) => hellos.push(n),
        onUpdate: () => {},
        onPresence: () => {},
        onEnded: () => {},
        onFull: () => {},
        onAuthDead: () => authDead++,
      },
    });
    try {
      stream.start();
      await sleep(150); // several portal 401s worth of retries
      expect(authDead).toBe(0);
      mock.setPortalMode(false); // user logged into the wifi
      await sleep(150);
      expect(hellos.length).toBeGreaterThanOrEqual(1); // ordinary retry healed it
      expect(authDead).toBe(0);
    } finally {
      mock.setPortalMode(false);
      stream.stop();
    }
  });

  it('a hello resets the consecutive-401 count', async () => {
    const { roomId } = await client.createRoom();
    let authDead = 0;
    let denyToken = false;
    const stream = new RoomStream({
      baseUrl: () => mock.url,
      token: () => (denyToken ? 'wrong' : mock.token),
      roomId,
      minBackoffMs: 20,
      maxBackoffMs: 40,
      restartDebounceMs: 0, // restart() here means "drop the connection now"

      callbacks: {
        onHello: () => {},
        onUpdate: () => {},
        onPresence: () => {},
        onEnded: () => {},
        onFull: () => {},
        onAuthDead: () => authDead++,
      },
    });
    stream.start();
    await sleep(50); // helloed with the good token
    denyToken = true;
    stream.restart(); // drop → one 401
    await sleep(30);
    denyToken = false; // credential "renewed" before the second refusal
    stream.restart();
    await sleep(60); // hello again — count must be back to zero
    denyToken = true;
    stream.restart();
    await sleep(30); // one 401 since the reset: still under threshold
    expect(authDead).toBe(0);
    stream.stop();
  });

  it('reports room-full as terminal', async () => {
    const { roomId } = await client.createRoom();
    const holders: RoomStream[] = [];
    const mkStream = (cb: { onFull?: () => void } = {}) =>
      new RoomStream({
        baseUrl: () => mock.url,
        token: () => mock.token,
        roomId,
        minBackoffMs: 20,
        maxBackoffMs: 50,
        callbacks: {
          onHello: () => {},
          onUpdate: () => {},
          onPresence: () => {},
          onEnded: () => {},
          onFull: cb.onFull ?? (() => {}),
        },
      });
    for (let i = 0; i < 10; i++) {
      const s = mkStream();
      s.start();
      holders.push(s);
    }
    await sleep(80);
    expect(mock.streamCount(roomId)).toBe(10);
    let full = false;
    const eleventh = mkStream({ onFull: () => (full = true) });
    eleventh.start();
    await sleep(60);
    expect(full).toBe(true);
    expect(eleventh.running).toBe(false);
    for (const s of holders) s.stop();
  });
});

describe('RoomStream backoff policy (2026-09-01 review)', () => {
  /** A fetch that answers every stream connect with `hello` and then
   *  closes — the shape of a draining/flapping relay. */
  const helloThenClose = (): Response =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('event: hello\ndata: {"lastSeq":0}\n\n'));
          c.close();
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    );
  const noop = { onHello: () => {}, onUpdate: () => {}, onPresence: () => {}, onEnded: () => {}, onFull: () => {} };

  it('retry delays never exceed maxBackoffMs (jitter is applied inside the cap)', async () => {
    // The clamp ran BEFORE the ±30% jitter, so a 60s cap really meant 78s.
    const stamps: number[] = [];
    const stream = new RoomStream({
      baseUrl: () => 'http://127.0.0.1:1', // refused
      token: () => 'x',
      roomId: 'r',
      minBackoffMs: 20,
      maxBackoffMs: 50,
      fetchImpl: () => {
        stamps.push(Date.now());
        return Promise.reject(new Error('ECONNREFUSED'));
      },
      callbacks: noop,
    });
    stream.start();
    await sleep(400);
    stream.stop();
    const gaps = stamps.slice(1).map((t, i) => t - stamps[i]!);
    expect(gaps.length).toBeGreaterThan(4);
    // Timer slop only (a few ms) — never the old cap×1.3 = 65.
    for (const g of gaps) expect(g).toBeLessThanOrEqual(50 + 8);
  });

  it('backoff resets only after a connection SURVIVES, so a hello-then-close relay is not hammered', async () => {
    let attempts = 0;
    const stream = new RoomStream({
      baseUrl: () => 'http://x',
      token: () => 'x',
      roomId: 'r',
      minBackoffMs: 20,
      maxBackoffMs: 160,
      resetAfterMs: 5_000, // "survived" = stayed up this long; never happens here
      fetchImpl: () => {
        attempts++;
        return Promise.resolve(helloThenClose());
      },
      callbacks: noop,
    });
    stream.start();
    await sleep(450);
    stream.stop();
    // Naive reset-on-hello: ~1 attempt per 20ms ≈ 20+. Escalating: 20, 40,
    // 80, 160, 160… ≈ 5-6 attempts in 450ms.
    expect(attempts).toBeLessThanOrEqual(8);
  });

  it('a reconnect that keeps hitting 409 eventually reports crowded-out (and keeps retrying)', async () => {
    let calls = 0;
    let crowded = 0;
    const stream = new RoomStream({
      baseUrl: () => 'http://x',
      token: () => 'x',
      roomId: 'r',
      minBackoffMs: 20,
      maxBackoffMs: 40,
      fetchImpl: () => {
        calls++;
        if (calls === 1) return Promise.resolve(helloThenClose()); // established once
        return Promise.resolve(
          new Response('{"detail":"room is full"}', {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      },
      callbacks: { ...noop, onCrowdedOut: () => crowded++ },
    });
    stream.start();
    await sleep(400);
    expect(crowded, 'reported once after the ghost-reap window').toBe(1);
    expect(stream.running, 'still retrying — a seat may open').toBe(true);
    stream.stop();
  });
});

describe('RoomStream restart hygiene (2026-09-01 review, T11)', () => {
  it('two restart() calls in quick succession (powerResumed + online) cost ONE reconnect', async () => {
    const { roomId } = await client.createRoom();
    const stream = new RoomStream({
      baseUrl: () => mock.url,
      token: () => mock.token,
      roomId,
      minBackoffMs: 20,
      maxBackoffMs: 50,
      callbacks: { onHello: () => {}, onUpdate: () => {}, onPresence: () => {}, onEnded: () => {}, onFull: () => {} },
    });
    stream.start();
    await sleep(60); // helloed
    const before = stream.stats.attempts;
    mock.setHelloDelay(100); // a slow handshake, so the second restart can abort the first
    try {
      stream.restart(); // powerResumed
      await sleep(30); // ...and 'online' a beat later, while the reconnect handshake is in flight
      stream.restart();
      await sleep(350);
      expect(stream.stats.attempts - before, 'one reconnect, not an aborted handshake + another').toBe(1);
      expect(stream.connected).toBe(true);
    } finally {
      mock.setHelloDelay(0);
      stream.stop();
    }
  });
});

describe('request deadlines + stream stall watchdog (2026-09-01 review, SC3/T1/T2)', () => {
  it('a hung update POST times out as a retryable RoomsError instead of pending forever', async () => {
    const c = new RoomsClient({
      baseUrl: () => mock.url,
      token: () => mock.token,
      postTimeoutMs: 100, // update posts carry the long deadline; shorten it here
    });
    const { roomId } = await c.createRoom();
    mock.hangNextUpdates(1);
    try {
      const outcome = await Promise.race([
        c.postUpdate(roomId, bytes('x')).then(
          () => 'resolved' as const,
          (e: RoomsError) => (e.status === 0 ? 'timed-out' : `err:${e.status}`),
        ),
        sleep(600).then(() => 'hung' as const),
      ]);
      expect(outcome).toBe('timed-out');
    } finally {
      mock.hangNextUpdates(0);
    }
  });

  it('a silently dead stream (heartbeats stop) is detected and restarted', async () => {
    const { roomId } = await client.createRoom();
    mock.setHeartbeat(40);
    const stream = new RoomStream({
      baseUrl: () => mock.url,
      token: () => mock.token,
      roomId,
      minBackoffMs: 20,
      maxBackoffMs: 50,
      stallMs: 150,
      callbacks: { onHello: () => {}, onUpdate: () => {}, onPresence: () => {}, onEnded: () => {}, onFull: () => {} },
    });
    stream.start();
    try {
      await sleep(150); // helloed + at least one heartbeat observed (arms the watchdog)
      const before = stream.stats.attempts;
      mock.freezeStreams(true); // socket open, nothing arrives
      await sleep(500);
      expect(stream.stats.attempts - before, 'the watchdog reconnected').toBeGreaterThanOrEqual(1);
    } finally {
      mock.freezeStreams(false);
      mock.setHeartbeat(0);
      stream.stop();
    }
  });
});

describe('egress protocol additions (2026-07-24)', () => {
  it('fetchUpdates: haveSnap suppresses an unchanged snapshot; a different tag ships it', async () => {
    const { roomId } = await client.createRoom();
    await client.postUpdate(roomId, bytes('a'));
    await client.postUpdate(roomId, bytes('b'));
    const full = await client.fetchUpdates(roomId, 0);
    const covers = full.lastSeq;
    await client.postSnapshot(roomId, Buffer.from('snapbytes').toString('base64'), covers);

    // No tag → full snapshot, and every page reports the epoch.
    const plain = await client.fetchUpdates(roomId, 0);
    expect(plain.snapshot).not.toBeNull();
    expect(plain.snapCovers).toBe(covers);

    // Matching tag → snapshot withheld, floor still advances.
    const cond = await client.fetchUpdates(roomId, 0, { haveSnap: covers });
    expect(cond.snapshot).toBeNull();
    expect(cond.snapshotUnchanged).toBe(true);
    expect(cond.lastSeq).toBeGreaterThanOrEqual(covers);

    // Stale tag → the newer snapshot ships in full.
    const stale = await client.fetchUpdates(roomId, 0, { haveSnap: covers - 1 });
    expect(stale.snapshot).not.toBeNull();
    expect(stale.snapshotUnchanged).toBe(false);
  });

  it('presence with ?from= is not echoed to the stream that declared that sid', async () => {
    const { roomId } = await client.createRoom();
    const seen = { a: [] as string[], b: [] as string[] };
    const mkStream = (sid: string, sink: string[]) =>
      new RoomStream({
        baseUrl: () => mock.url,
        token: () => mock.token,
        roomId,
        sid,
        minBackoffMs: 20,
        maxBackoffMs: 50,
        callbacks: {
          onHello: () => {},
          onUpdate: () => {},
          onPresence: (b) => sink.push(text(b)),
          onEnded: () => {},
          onFull: () => {},
        },
      });
    const sa = mkStream('sid-a', seen.a);
    const sb = mkStream('sid-b', seen.b);
    sa.start();
    sb.start();
    await sleep(60);
    await client.postPresence(roomId, bytes('from-a'), 'sid-a');
    await sleep(60);
    expect(seen.b).toContain('from-a'); // the peer got it
    expect(seen.a).not.toContain('from-a'); // the sender's bytes never came back
    sa.stop();
    sb.stop();
  });
});
