/**
 * Rooms transport: REST client + SSE stream for the relay's
 * collaboration-session endpoints (`/relay/rooms/*`).
 *
 * Transport only — blobs in and out of this module are opaque bytes
 * (the session layer encrypts/decrypts). Runs in the renderer on both
 * web and desktop: plain `fetch` with a streamed reader (no undici, no
 * EventSource — EventSource cannot send an Authorization header).
 *
 * `RoomStream` is the rooms sibling of the desktop mailbox subscriber
 * (`apps/desktop/src/relay-stream.ts`): same frame grammar, same
 * backoff-with-jitter reconnect discipline, same restart() hook for
 * wake-from-sleep. Differences: the hello frame carries `{lastSeq}`
 * (the caller's catch-up cursor), data frames are typed
 * (`u` update / `p` presence / `end` session-over), and HTTP 410 means
 * the session ended (stop, permanently) while 409 means the room is
 * full (stop; the caller surfaces it).
 */

import { base64ToBytes } from './collab-crypto.js';
import { appVersion } from '../install-info.js';
import { RELAY_CLIENT_ROUTING_HEADER, RELAY_CLIENT_VERSION_HEADER } from '../relay-protocol.js';

export type RoomsFetch = typeof fetch;

/** Browser `window.fetch` throws "Illegal invocation" when called
 *  unbound (assigned to a variable and invoked with `this` ≠ window);
 *  Node's fetch does not care. Wrapping keeps both happy. */
const boundFetch: RoomsFetch = (input, init) => fetch(input, init);

/** Typed transport failure; `status` is 0 for network-level errors. */
/** Best-effort ' — <detail>' suffix from a non-2xx body (FastAPI's
 *  `{detail}` or the mock's `{error}`; a non-JSON body contributes a
 *  short trimmed prefix). Never throws; at most 512 bytes read. */
async function errorDetail(res: Response): Promise<string> {
  try {
    const text = (await res.text()).slice(0, 512).trim();
    if (!text) return '';
    try {
      const parsed = JSON.parse(text) as { detail?: unknown; error?: unknown };
      const d = parsed.detail ?? parsed.error;
      if (typeof d === 'string' && d) return ` — ${d}`;
      return '';
    } catch {
      return /^</.test(text) ? '' : ` — ${text.slice(0, 120)}`;
    }
  } catch {
    return '';
  }
}

export interface TransportStats {
  requests: number;
  failures: number;
  networkErrors: number;
  clientErrors: number;
  serverErrors: number;
  lastError: string | null;
  lastErrorAt: number;
  lastOkAt: number;
}

export interface StreamStats {
  /** Connection attempts (incl. ones that never helloed). */
  attempts: number;
  hellos: number;
  /** Failed attempts since the last hello. */
  consecutiveFailures: number;
  lastHelloAt: number;
}

export class RoomsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'RoomsError';
  }
}

export interface RoomUpdate {
  seq: number;
  blob: Uint8Array;
}

export interface FetchUpdatesResult {
  snapshot: { blob: Uint8Array; coversThroughSeq: number } | null;
  /** True when the server withheld the snapshot because the caller's
   *  `haveSnap` tag matched (conditional snapshot). */
  snapshotUnchanged: boolean;
  updates: RoomUpdate[];
  lastSeq: number;
  more: boolean;
  /** The room's current compaction epoch — coversThroughSeq of the
   *  stored snapshot, 0 when none. Present on every page (pre-epoch
   *  servers report 0), so a steady-state catch-up learns about a
   *  compaction without ever downloading the snapshot. */
  snapCovers: number;
}

export interface RoomsClientOptions {
  /** Relay base URL including the `/relay` prefix, re-read per request. */
  baseUrl: () => string;
  /** Bearer token, re-read per request (entitlement swap seam). */
  token: () => string;
  /** This machine's routing code, sent as X-CardMirror-Routing when the
   *  bearer is an entitlement (machine binding). ''/absent = omit the
   *  header (shared-token or self-hosted relay — nothing to bind). */
  routingCode?: () => string;
  /** True when the bearer is a room GUEST PASS — an immutable,
   *  room-scoped credential the client can never refresh (re-minting is
   *  a host-only endpoint). Lets the session treat a relay-confirmed
   *  401 as terminal instead of retrying a credential that cannot come
   *  back. Absent/false for tokens and entitlements, which CAN renew. */
  guestAuth?: boolean;
  fetchImpl?: RoomsFetch;
  /** Per-request deadline for reads/small posts (default 15s) and for
   *  the multi-MB update/snapshot posts (default 120s — school uplinks).
   *  A request that never settles (half-open TCP after a lid-close or
   *  NAT rebind) used to wedge the send queue and the catch-up path
   *  permanently: their mutexes clear only in `finally`. An aborted
   *  request surfaces as RoomsError(0) — the same retryable shape as a
   *  dropped connection. */
  requestTimeoutMs?: number;
  postTimeoutMs?: number;
}

/** Compose the caller's signal (if any) with a deadline. */
function withDeadline(signal: AbortSignal | null | undefined, ms: number): AbortSignal | undefined {
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return signal ?? undefined;
  const deadline = AbortSignal.timeout(ms);
  if (!signal) return deadline;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, deadline]);
  return deadline;
}

export class RoomsClient {
  /** Public: RoomStream construction reuses the same suppliers. */
  constructor(readonly opts: RoomsClientOptions) {}

  private get fetchImpl(): RoomsFetch {
    return this.opts.fetchImpl ?? boundFetch;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const routing = this.opts.routingCode?.() ?? '';
    return {
      Authorization: `Bearer ${this.opts.token()}`,
      [RELAY_CLIENT_VERSION_HEADER]: appVersion,
      ...(routing ? { [RELAY_CLIENT_ROUTING_HEADER]: routing } : {}),
      ...extra,
    };
  }

  /** Live transport counters for diagnostics (folded into
   *  CollabSession.debugState). Nothing here is read by sync logic. */
  readonly stats: TransportStats = {
    requests: 0,
    failures: 0,
    networkErrors: 0,
    clientErrors: 0,
    serverErrors: 0,
    lastError: null,
    lastErrorAt: 0,
    lastOkAt: 0,
  };

  private noteFailure(err: RoomsError): void {
    const st = this.stats;
    st.failures++;
    if (err.status === 0) st.networkErrors++;
    else if (err.status >= 500) st.serverErrors++;
    else st.clientErrors++;
    st.lastError = err.message;
    st.lastErrorAt = Date.now();
  }

  private async request(path: string, init?: RequestInit, timeoutMs?: number): Promise<Response> {
    // No credential at all (web: an expired entitlement resolves to ''
    // by design) — fail locally instead of sending `Bearer ` to be
    // 401'd all night (2026-09-01 review, T5). The retry backoff still
    // applies, so a renewal heals it.
    if (!this.opts.token()) {
      const e = new RoomsError(0, 'no relay credential');
      this.noteFailure(e);
      throw e;
    }
    let res: Response;
    this.stats.requests++;
    const ms = timeoutMs ?? this.opts.requestTimeoutMs ?? 15_000;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl()}${path}`, {
        ...init,
        signal: withDeadline(init?.signal, ms),
      });
    } catch (err) {
      const name = (err as Error)?.name;
      const timedOut = name === 'TimeoutError' || name === 'AbortError';
      const e = new RoomsError(
        0,
        timedOut ? `rooms request timed out after ${ms}ms` : ((err as Error).message ?? 'network error'),
      );
      this.noteFailure(e);
      throw e;
    }
    if (!res.ok) {
      // Fold the relay's own detail into the error: its 413 alone covers
      // both 'update too large' and 'room storage cap reached', and pool
      // exhaustion is a distinct 503 — a bare status was undiagnosable in
      // the field (2026-09-01 review). Bounded read: an interceptor's
      // HTML page must not be inhaled whole. Reading also releases the
      // connection back to the pool (an abandoned body holds it).
      const e = new RoomsError(res.status, `rooms request failed: ${res.status}${await errorDetail(res)}`);
      this.noteFailure(e);
      throw e;
    }
    this.stats.lastOkAt = Date.now();
    return res;
  }

  /** Parse a JSON body, but fail LOUDLY and clearly when the relay hands back
   *  something that isn't JSON. A captive portal, filtering proxy, antivirus
   *  web-shield, or a misconfigured relay URL that resolves to a web app all
   *  answer with a 200 HTML page; without this the caller would surface the
   *  cryptic `Unexpected token '<', "<!DOCTYPE"... is not valid JSON`. We read
   *  the body as text FIRST (a Response body reads once), then parse, so the
   *  error message can quote the URL and the page. */
  private async readJson<T>(res: Response, path: string): Promise<T> {
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      const url = `${this.opts.baseUrl()}${path}`;
      const trimmed = text.trimStart();
      const looksHtml = /^<(?:!doctype|html|\?xml)/i.test(trimmed);
      const ctype = res.headers.get('content-type') ?? 'unknown type';
      throw new RoomsError(
        res.status,
        looksHtml
          ? `the relay returned a web page instead of session data ` +
              `(HTTP ${res.status}, ${ctype}) from ${url} — a proxy, content ` +
              `filter, or wrong relay URL is likely intercepting the connection.`
          : `the relay returned an unreadable (non-JSON) response ` +
              `(HTTP ${res.status}, ${ctype}) from ${url}.`,
      );
    }
  }

  async createRoom(): Promise<{ roomId: string; guestPass: string | null }> {
    const res = await this.request('/rooms', { method: 'POST', headers: this.headers() });
    const body = await this.readJson<{ roomId?: string; guestPass?: string }>(res, '/rooms');
    if (!body.roomId) throw new RoomsError(0, 'malformed createRoom response');
    // guestPass rides along only when the relay's guest_pass flip is on
    // (web-collab Phase 1); absence is the dormant default, not an error.
    return { roomId: body.roomId, guestPass: body.guestPass ?? null };
  }

  /** Re-mint a guest pass for a live room (host resume path). Null when
   *  the feature is off server-side (404) or the relay predates it. */
  async fetchGuestPass(roomId: string): Promise<string | null> {
    try {
      const res = await this.request(`/rooms/${roomId}/guest-pass`, {
        method: 'GET',
        headers: this.headers(),
      });
      const body = await this.readJson<{ guestPass?: string }>(res, 'guest-pass');
      return body.guestPass ?? null;
    } catch {
      return null;
    }
  }

  async postUpdate(roomId: string, blob: Uint8Array): Promise<number> {
    const path = `/rooms/${roomId}/updates`;
    const res = await this.request(path, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/octet-stream' }),
      body: blob as unknown as BodyInit,
    }, this.opts.postTimeoutMs ?? 120_000);
    const body = await this.readJson<{ seq?: number }>(res, path);
    if (typeof body.seq !== 'number') throw new RoomsError(0, 'malformed postUpdate response');
    return body.seq;
  }

  /** One page; loop while `more` (the session layer drives paging so it
   *  can apply between pages on huge backlogs). `opts.haveSnap` is the
   *  conditional-snapshot tag: "I already hold the snapshot covering
   *  through this seq — don't resend it if unchanged." */
  async fetchUpdates(
    roomId: string,
    after: number,
    opts: { haveSnap?: number } = {},
  ): Promise<FetchUpdatesResult> {
    const cond = opts.haveSnap !== undefined ? `&haveSnap=${opts.haveSnap}` : '';
    const path = `/rooms/${roomId}/updates?after=${after}${cond}`;
    const res = await this.request(path, {
      headers: this.headers(),
    });
    const body = await this.readJson<{
      snapshot?: { blob: string; coversThroughSeq: number };
      snapshotUnchanged?: boolean;
      snapCovers?: number;
      updates?: Array<{ seq: number; blob: string }>;
      lastSeq?: number;
      more?: boolean;
    }>(res, path);
    const snapshot = body.snapshot
      ? { blob: base64ToBytes(body.snapshot.blob), coversThroughSeq: body.snapshot.coversThroughSeq }
      : null;
    return {
      snapshot,
      snapshotUnchanged: body.snapshotUnchanged === true,
      updates: (body.updates ?? []).map((u) => ({ seq: u.seq, blob: base64ToBytes(u.blob) })),
      lastSeq: body.lastSeq ?? after,
      more: body.more === true,
      // Pre-epoch servers omit the field; fall back to what the embedded
      // snapshot itself reveals so callers get a best-effort tag.
      snapCovers: body.snapCovers ?? snapshot?.coversThroughSeq ?? 0,
    };
  }

  async postSnapshot(roomId: string, blobB64: string, coversThroughSeq: number): Promise<void> {
    await this.request(`/rooms/${roomId}/snapshot`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ blob: blobB64, coversThroughSeq }),
    }, this.opts.postTimeoutMs ?? 120_000);
  }

  /** `from` = the sender's own stream sid (see RoomStreamOptions.sid):
   *  the server skips echoing this frame back to that stream. Old
   *  servers ignore the param; the client-side own-peer filter still
   *  drops the echo, so behavior is identical either way. */
  async postPresence(roomId: string, blob: Uint8Array, from?: string): Promise<void> {
    const q = from ? `?from=${encodeURIComponent(from)}` : '';
    await this.request(`/rooms/${roomId}/presence${q}`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/octet-stream' }),
      body: blob as unknown as BodyInit,
    });
  }

  async deleteRoom(roomId: string): Promise<void> {
    await this.request(`/rooms/${roomId}`, { method: 'DELETE', headers: this.headers() });
  }
}

// --- SSE stream ---

export interface RoomStreamCallbacks {
  /** Connected; `lastSeq` is the server's cursor at connect time. The
   *  caller runs its catch-up fetch from its OWN cursor — hello's value
   *  is informational (a quick "am I behind?" check). */
  onHello: (lastSeq: number) => void;
  onUpdate: (update: RoomUpdate) => void;
  onPresence: (blob: Uint8Array) => void;
  /** Session ended (server tombstone or live `end` frame). Terminal. */
  onEnded: () => void;
  /** Room at participant capacity (409). Terminal. */
  onFull: () => void;
  /** An ESTABLISHED session's reconnect has hit 409 repeatedly — past the
   *  relay's ghost-stream reap window, so the seat really is taken. Fired
   *  once per run of 409s; the stream keeps retrying (a seat may open).
   *  Lets the UI explain instead of showing a bare offline chip. */
  onCrowdedOut?: () => void;
  /** A previously-connected stream dropped; reconnection with backoff
   *  is already underway. Lets the session mark itself offline instead
   *  of discovering the outage on the next failed send. */
  onDown?: () => void;
  /** The RELAY (confirmed by response shape — not a captive portal)
   *  refused our credential twice in a row. Policy belongs to the
   *  caller: a guest-pass session ends (the pass can't heal), a member
   *  session notifies and keeps retrying (entitlements renew). The
   *  stream itself keeps its backoff retry unless the callback stops
   *  it. May fire again on later consecutive refusals. */
  onAuthDead?: () => void;
}

export interface RoomStreamOptions {
  baseUrl: () => string;
  token: () => string;
  /** See RoomsClientOptions.routingCode. */
  routingCode?: () => string;
  roomId: string;
  /** Opaque per-session nonce identifying THIS client's stream to the
   *  server, so presence posts carrying the same value as `from` are
   *  not echoed back (the client filters its own frames anyway — this
   *  just stops the bytes). Optional; old servers ignore it. */
  sid?: string;
  callbacks: RoomStreamCallbacks;
  fetchImpl?: RoomsFetch;
  /** Backoff bounds, injectable for tests. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** How long a connection must stay up before the backoff resets to
   *  its minimum (default 15s). A hello alone is not "success": a
   *  draining relay accepts, hellos, and closes — resetting on hello
   *  made every client reconnect at the 1s floor forever. */
  resetAfterMs?: number;
  /** Silence bound: no bytes (heartbeats included) for this long on a
   *  helloed stream → the socket is presumed dead and reconnected
   *  (default 70s ≈ 2.8× the relay's 25s heartbeat). Armed only after
   *  the first byte following hello, so a relay that sends no
   *  heartbeats degrades to the old behavior instead of restart-looping. */
  stallMs?: number;
  /** restart() debounce window (default 2s): a wake fires powerResumed,
   *  'online' and 'visible' a beat apart; only the first aborts an
   *  in-flight handshake. Tests that use restart() as a raw "drop the
   *  connection now" primitive set 0. */
  restartDebounceMs?: number;
}

export class RoomStream {
  private controller: AbortController | null = null;
  private stopped = true;
  private backoffMs: number;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private helloed = false;
  private everHelloed = false;
  /** Consecutive relay-confirmed 401/403 handshakes. Portal/HTML 401s
   *  never count; a hello resets it. At 2, onAuthDead fires. */
  private authFails = 0;
  /** Consecutive reconnect-409s (see onCrowdedOut). */
  private reconnect409s = 0;
  private survivalTimer: ReturnType<typeof setTimeout> | null = null;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  private lastByteAt = 0;
  private lastRestartAt = 0;
  readonly stats: StreamStats = { attempts: 0, hellos: 0, consecutiveFailures: 0, lastHelloAt: 0 };

  constructor(private readonly opts: RoomStreamOptions) {
    this.backoffMs = opts.minBackoffMs ?? 1000;
  }

  get running(): boolean {
    return !this.stopped;
  }

  /** True while the current connection has received its hello (i.e.
   *  live push delivery is actually flowing). */
  get connected(): boolean {
    return !this.stopped && this.helloed;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.backoffMs = this.opts.minBackoffMs ?? 1000;
    this.authFails = 0;
    void this.connectLoop();
  }

  stop(): void {
    this.stopped = true;
    this.clearSurvival();
    this.clearStall();
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.controller?.abort();
    this.controller = null;
  }

  /** Abort and reconnect promptly — wake-from-sleep, network change,
   *  where the current socket may be silently dead. NOT for "the relay
   *  is reachable, hurry up": that is `nudge()` — aborting an in-flight
   *  attempt from a send-success loop kills every handshake before its
   *  hello, and the stream never connects while the user types. */
  restart(): void {
    if (this.stopped) return;
    this.backoffMs = this.opts.minBackoffMs ?? 1000;
    if (this.retryTimer !== null) {
      // Sitting out a backoff wait — wake-from-sleep must not serve the
      // remainder of a pre-sleep delay before reconnecting (audit find,
      // 2026-07-10). Connect now.
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      void this.connectLoop();
      return;
    }
    // Debounce the abort: a laptop wake fires powerResumed AND 'online'
    // a beat apart, and the second call found no retry timer and aborted
    // the handshake the first had just started — a full extra round trip
    // at exactly the moment the stream was wanted back (2026-09-01
    // review). Within the window, the in-flight reconnect IS the restart.
    const now = Date.now();
    if (now - this.lastRestartAt < (this.opts.restartDebounceMs ?? 2000)) return;
    this.lastRestartAt = now;
    this.controller?.abort();
  }

  private clearStall(): void {
    if (this.stallTimer !== null) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
  }

  /** First byte after hello: arm the silence watchdog. */
  private armStall(): void {
    if (this.stallTimer !== null) return;
    const stallMs = this.opts.stallMs ?? 70_000;
    this.stallTimer = setInterval(() => {
      if (this.stopped || !this.helloed) return;
      if (Date.now() - this.lastByteAt > stallMs) {
        console.warn(`[room-stream] no bytes for ${stallMs}ms — presuming a dead socket, reconnecting`);
        this.clearStall();
        this.lastRestartAt = 0; // a stall restart must never be debounced away
        this.restart();
      }
    }, Math.max(50, Math.floor(stallMs / 2)));
  }

  /** Gentle hurry-up: if a backoff wait is pending, connect now; if an
   *  attempt is already in flight (or connected), do nothing. */
  nudge(): void {
    if (this.stopped || this.helloed) return;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.backoffMs = this.opts.minBackoffMs ?? 1000;
      void this.connectLoop();
    }
  }

  private clearSurvival(): void {
    if (this.survivalTimer !== null) {
      clearTimeout(this.survivalTimer);
      this.survivalTimer = null;
    }
  }

  private scheduleRetry(): void {
    this.stats.consecutiveFailures++;
    this.clearSurvival();
    this.clearStall();
    if (this.stopped) return;
    if (this.helloed) {
      this.helloed = false;
      this.opts.callbacks.onDown?.();
    }
    const max = this.opts.maxBackoffMs ?? 60_000;
    // Jitter INSIDE the cap (30-100% of it): the old ±30% applied after
    // the clamp, so a 60s cap really meant 78s — and its narrow band put
    // a whole fleet's first retry inside ~600ms after a relay restart.
    const cap = Math.min(this.backoffMs, max);
    const delay = cap * (0.3 + Math.random() * 0.7);
    this.backoffMs = Math.min(this.backoffMs * 2, max);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connectLoop();
    }, delay);
  }

  private dispatchFrame(eventName: string, dataText: string): void {
    if (eventName === 'hello') {
      // NOT a backoff reset — that waits for the connection to survive
      // resetAfterMs (a draining relay hellos and closes; resetting here
      // turned a deploy into a 1Hz reconnect + catch-up storm per client,
      // whose ghost streams then 409'd the room).
      this.clearSurvival();
      this.survivalTimer = setTimeout(() => {
        this.survivalTimer = null;
        this.backoffMs = this.opts.minBackoffMs ?? 1000;
      }, this.opts.resetAfterMs ?? 15_000);
      this.reconnect409s = 0;
      this.helloed = true;
      this.everHelloed = true;
      this.authFails = 0;
      this.stats.hellos++;
      this.stats.consecutiveFailures = 0;
      this.stats.lastHelloAt = Date.now();
      let lastSeq = 0;
      try {
        const parsed = JSON.parse(dataText || '{}') as { lastSeq?: number };
        if (typeof parsed.lastSeq === 'number') lastSeq = parsed.lastSeq;
      } catch {
        /* malformed hello data — treat as 0 */
      }
      this.opts.callbacks.onHello(lastSeq);
      return;
    }
    if (!dataText) return;
    try {
      const frame = JSON.parse(dataText) as { t?: string; seq?: number; blob?: string };
      if (frame.t === 'u' && typeof frame.seq === 'number' && typeof frame.blob === 'string') {
        this.opts.callbacks.onUpdate({ seq: frame.seq, blob: base64ToBytes(frame.blob) });
      } else if (frame.t === 'p' && typeof frame.blob === 'string') {
        this.opts.callbacks.onPresence(base64ToBytes(frame.blob));
      } else if (frame.t === 'end') {
        this.stopped = true;
        this.opts.callbacks.onEnded();
      }
    } catch {
      console.warn('[room-stream] undecodable frame; ignoring');
    }
  }

  private async connectLoop(): Promise<void> {
    if (this.stopped) return;
    if (!this.opts.token()) {
      // An absent credential is unambiguously local — no need to burn
      // two round trips proving it. Signal auth-dead now; keep the
      // backoff so a renewal (or re-link) reconnects.
      this.opts.callbacks.onAuthDead?.();
      if (this.stopped) return;
      this.scheduleRetry();
      return;
    }
    this.stats.attempts++;
    this.controller = new AbortController();
    const fetchImpl = this.opts.fetchImpl ?? boundFetch;
    try {
      const sidQ = this.opts.sid ? `?sid=${encodeURIComponent(this.opts.sid)}` : '';
      const routing = this.opts.routingCode?.() ?? '';
      const res = await fetchImpl(`${this.opts.baseUrl()}/rooms/${this.opts.roomId}/stream${sidQ}`, {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${this.opts.token()}`,
          [RELAY_CLIENT_VERSION_HEADER]: appVersion,
          ...(routing ? { [RELAY_CLIENT_ROUTING_HEADER]: routing } : {}),
        },
        signal: this.controller.signal,
      });
      // Release bodies we don't read: an abandoned response body holds
      // its pool connection until GC — one per retry, for hours, during
      // an outage (2026-09-01 review).
      const drop = (): void => void res.body?.cancel().catch(() => {});
      if (res.status === 410 || res.status === 404) {
        // Tombstoned (or GC'd all the way to gone): the session is over.
        drop();
        this.stopped = true;
        this.opts.callbacks.onEnded();
        return;
      }
      if (res.status === 409) {
        drop();
        // On a FIRST join, full means full — terminal. On a RECONNECT,
        // the count may include our own not-yet-reaped ghost connection
        // from the drop; the server clears those within a heartbeat
        // cycle, so retry instead of ending an established session.
        if (!this.everHelloed) {
          this.stopped = true;
          this.opts.callbacks.onFull();
          return;
        }
        // Past the reap window (the relay notices a departed stream within
        // one heartbeat, 25s; four backoff steps is comfortably longer), the
        // slot is genuinely taken: say so once, keep retrying.
        if (++this.reconnect409s === 4) this.opts.callbacks.onCrowdedOut?.();
        this.scheduleRetry();
        return;
      }
      if (res.status === 401 || res.status === 403) {
        // Only a refusal the RELAY actually sent counts: its error
        // bodies are JSON objects (FastAPI `detail`, mock/self-host
        // variants), while a captive portal intercepting everything
        // with its own 401 serves an HTML login page. One confirmed
        // refusal is still not enough — a second consecutive one
        // (i.e. after a full backoff interval) fires onAuthDead, and
        // the wifi-login case self-heals through the ordinary retry.
        let relayShaped = false;
        try {
          const parsed = JSON.parse(await res.text()) as unknown;
          relayShaped = !!parsed && typeof parsed === 'object';
        } catch {
          /* HTML / empty / opaque body — not the relay speaking */
        }
        if (relayShaped && ++this.authFails >= 2) {
          this.opts.callbacks.onAuthDead?.();
          if (this.stopped) return; // the callback ended the session
        }
        this.scheduleRetry();
        return;
      }
      if (!res.ok || !res.body) {
        drop();
        this.scheduleRetry();
        return;
      }

      // SSE grammar: lines to a blank line make one event; `:` comments
      // (heartbeats) are dropped. getReader() rather than for-await —
      // browser ReadableStream is not async-iterable everywhere.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let eventName = '';
      let dataLines: string[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.lastByteAt = Date.now();
        if (this.helloed) this.armStall();
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (line === '') {
            this.dispatchFrame(eventName, dataLines.join('\n'));
            eventName = '';
            dataLines = [];
            if (this.stopped) return;
          } else if (line.startsWith(':')) {
            continue;
          } else if (line.startsWith('event:')) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart());
          }
        }
      }
      // Server closed (deploy, idle reap) — reconnect.
      this.scheduleRetry();
    } catch (err) {
      if (this.stopped) return;
      if ((err as Error).name !== 'AbortError') {
        console.warn('[room-stream] stream error:', (err as Error).message ?? err);
      }
      this.scheduleRetry();
    }
  }
}
