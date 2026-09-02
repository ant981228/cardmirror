/**
 * Pairing main-process bridge — cross-machine card sharing.
 *
 * The main process is the single owner of:
 *   - the X25519 keypair (this machine's identity; private key in userData,
 *     never exposed to a renderer or the relay);
 *   - the relay base URL + bearer token (baked build constants; settings and
 *     env overrides for self-hosted relays);
 *   - the background delivery channel — an SSE push stream with poll
 *     catch-up, or interval polling against legacy relays (one channel,
 *     shared by all windows);
 *   - the inbox of received cards (persisted to userData, broadcast to
 *     every window via `pairing:inbox-changed`).
 *
 * DELIVERY: the relay live-pushes new cards over `GET /relay/stream` (see
 * relay-stream.ts); on every (re)connect — and on wake-from-sleep — the
 * client runs one catch-up `GET /messages`, so the store-and-forward
 * guarantee is unchanged. Relays without the stream endpoint (404) get
 * today's interval polling for the whole session. Delivery is
 * at-least-once; the `consumed` / `rx-<msgId>` dedupe absorbs overlap
 * between push and catch-up.
 *
 * END-TO-END ENCRYPTED: every card is sealed to the recipient's public key
 * (sealed box; see pairing-crypto.ts) before it leaves this process, and the
 * host sees only an opaque ciphertext bundle plus a hashed routing code. The
 * sender identity, group label, schema version, and card content all live
 * INSIDE the ciphertext — the relay host can interpret none of it.
 *
 * Addressing is DIRECTED: each machine receives only its own routing code
 * and never sends to itself, so there is no self-echo and no delete race.
 *
 * The relay contract here is identical to the scouting-assistant `/relay` API,
 * so pointing at production is a one-line change to DEFAULT_RELAY_URL.
 */

import { app, BrowserWindow, ipcMain, powerMonitor } from 'electron';
import { gzipSync } from 'node:zlib';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createPairingKeystore, routingId, type PairingKeystore, type SealedBundle } from './pairing-crypto.js';
import { BUILT_IN_RELAY_TOKEN } from './pairing-build.js';
import { RelayStream } from './relay-stream.js';
import {
  entitlementIfValid,
  interpretConnectResponse,
  nextLapsedFlag,
  parseStoredEntitlement,
  renewalDue,
  type ConnectOutcome,
  type ConnectResponseBody,
  type EntitlementState,
  renewalRetryDelayMs,
} from './pairing-entitlement.js';

// Mirrors src/editor/relay-protocol.ts (the renderer's copy). Declared
// locally because this tsc's rootDir excludes src/ — a VALUE import
// from there breaks the desktop build (type-only imports are fine; see
// file-index-core.ts). Parity is pinned by relay-version-header.test.ts.
const RELAY_CLIENT_VERSION_HEADER = 'X-CardMirror-Version';
const RELAY_CLIENT_ROUTING_HEADER = 'X-CardMirror-Routing';

/** Relay endpoint defaults. Resolution order (see relayUrl()/relayToken()):
 *  user settings (self-hosted relay) → env override → baked default. Env
 *  overrides point dev at the local mock, e.g.:
 *    PAIRING_RELAY_URL=http://127.0.0.1:3200 PAIRING_TOKEN=dev-pairing-token \
 *      npm run desktop:dev
 *
 *  The URL is not secret and is baked in. The TOKEN is NOT hard-coded here:
 *  this is a PUBLIC repo, so the real relay token is injected at build/run
 *  time via PAIRING_TOKEN (a packaged installer is built with that env set).
 *  It's only light gating anyway — the card payload is end-to-end encrypted,
 *  so the relay host can't read it.
 *
 *  NOTE: a double-clicked packaged app does not inherit shell env, so a
 *  distributed build must have PAIRING_TOKEN present in its BUILD env to bake
 *  the token into the artifact. For `desktop:dev` (launched from a shell) the
 *  env var is read directly at runtime. */
const DEFAULT_RELAY_URL =
  process.env.PAIRING_RELAY_URL || 'https://scouting-assistant.up.railway.app/relay';
const DEFAULT_RELAY_TOKEN = process.env.PAIRING_TOKEN || BUILT_IN_RELAY_TOKEN || 'dev-pairing-token';

interface PairingConfig {
  enabled: boolean;
  displayName: string;
  schemaVersion: string;
  /** Compatibility floor this build stamps on outgoing cards — the minimum
   *  receiver version that can read them. Blank = any version may receive. */
  minReceiverVersion: string;
  pollSeconds: number;
  /** Self-hosted relay base URL ('' = the official relay). */
  relayUrl: string;
  /** Bearer for a self-hosted relay ('' = the baked official token). */
  relayToken: string;
}

/** Effective relay base URL: settings override → env/baked default.
 *  Exported for the plugin installer's allowlist fetch — same server,
 *  same self-hosted-override semantics, no token involved (the
 *  allowlist route is deliberately ungated). */
export function relayUrl(): string {
  const custom = config.relayUrl.trim().replace(/\/+$/, '');
  return custom || DEFAULT_RELAY_URL;
}

/** Effective bearer. This supplier is the single seam of the
 *  account-entitlement flow — everything (POST, GET, DELETE, stream)
 *  routes its Authorization through here. A valid stored entitlement is
 *  preferred for the OFFICIAL relay (which accepts it alongside the
 *  shared token while it runs ungated — linking gates nothing until
 *  relay-side enforcement flips); custom self-hosted relays always
 *  use their own token, never entitlements. */
function relayToken(): string {
  const custom = config.relayToken.trim();
  if (custom) return custom;
  if (!config.relayUrl.trim()) {
    const ent = validEntitlement();
    if (ent) return ent.entitlement;
  }
  return DEFAULT_RELAY_TOKEN;
}

interface SendItem {
  label: string;
  type: string;
  sliceJson: unknown;
}

/** The plaintext sealed inside each message — never visible to the host. */
interface InnerPayload {
  schemaVersion?: string;
  /** Compatibility floor: the minimum receiver version that can read this card.
   *  Absent/blank = any version may receive it (the tolerant default). */
  minReceiverVersion?: string;
  senderCode?: string;
  senderName?: string;
  via?: string;
  item?: SendItem;
}

interface InboxItem {
  id: string;
  label: string;
  type: string;
  sliceJson: unknown;
  senderName: string;
  senderCode: string;
  via?: string;
  receivedAt: number;
  read: boolean;
}

/** What the relay returns per stored message: routing metadata in the clear
 *  plus the opaque encrypted bundle. */
interface RelayMessage extends Partial<SealedBundle> {
  msgId: string;
  recipientCode?: string;
  sentAt?: number;
  receivedAt?: number;
}

let config: PairingConfig = {
  enabled: false,
  displayName: '',
  schemaVersion: 'unknown',
  minReceiverVersion: '',
  pollSeconds: 30,
  relayUrl: '',
  relayToken: '',
};
/** Interval poller — legacy-relay fallback mode only. */
let pollTimer: ReturnType<typeof setInterval> | null = null;
/** Low-frequency belt-and-suspenders catch-up while streaming. */
let catchupTimer: ReturnType<typeof setInterval> | null = null;
/** Live push stream (null while disabled or in fallback-poll mode). */
let stream: RelayStream | null = null;
/** Relay base URL that 404'd on /stream this session — don't re-probe it
 *  on every settings change; a DIFFERENT URL gets a fresh probe. */
let streamUnsupportedUrl: string | null = null;
let polling = false;
/** msgIds already handled this session — guards against re-processing if a
 *  DELETE failed (the message would still be on the relay next poll), and
 *  absorbs push/catch-up overlap (at-least-once delivery). */
const consumed = new Set<string>();

// ── Keystore (this machine's X25519 identity) ────────────────────────

let keystore: PairingKeystore | null = null;
function ks(): PairingKeystore {
  if (!keystore) {
    keystore = createPairingKeystore(path.join(app.getPath('userData'), 'pairing-keys.json'));
  }
  return keystore;
}

// ── Blog-account entitlement (persisted; unenforced until gating) ─────

let entitlementState: EntitlementState | null = null;
let entitlementLoaded = false;
/** Guards against overlapping renewal calls. */
let renewing = false;
/** The relay 403'd a renewal — the linked membership is inactive. Kept
 *  in memory only: a restart re-discovers it within minutes via the
 *  renewal cadence, and the settings row reads it from accountStatus. */
let membershipLapsed = false;

function entitlementPath(): string {
  return path.join(app.getPath('userData'), 'pairing-entitlement.json');
}

async function ensureEntitlementLoaded(): Promise<void> {
  if (entitlementLoaded) return;
  entitlementLoaded = true;
  try {
    entitlementState = parseStoredEntitlement(
      JSON.parse(await fs.readFile(entitlementPath(), 'utf8')),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[pairing] Failed to read pairing-entitlement.json:', err);
    }
  }
}

async function persistEntitlement(): Promise<void> {
  try {
    if (entitlementState === null) {
      await fs.unlink(entitlementPath()).catch(() => {});
    } else {
      await fs.writeFile(entitlementPath(), JSON.stringify(entitlementState));
    }
  } catch (err) {
    console.warn('[pairing] Failed to persist entitlement:', err);
  }
}

function validEntitlement(): EntitlementState | null {
  return entitlementIfValid(entitlementState, Date.now());
}

function accountStatus(): {
  enabled: boolean;
  connected: boolean;
  expiresAt: number;
  email: string;
  lapsed: boolean;
} {
  return {
    // Always available on desktop. The renderer's settings row keys its
    // visibility off this flag, so an older renderer paired with this
    // main still behaves.
    enabled: true,
    connected: validEntitlement() !== null,
    expiresAt: entitlementState?.expiresAt ?? 0,
    email: entitlementState?.email ?? '',
    lapsed: membershipLapsed,
  };
}

function broadcastEntitlement(extra?: { evicted?: boolean; lapsed?: boolean }): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      w.webContents.send('pairing:entitlement-changed', { ...accountStatus(), ...extra });
    }
  }
}

/** Machine name for the relay's seat picker: hostname + platform
 *  ("Anthonys-MacBook-Pro (macOS)"). Sent on every connect and renewal
 *  so seats bound before the field existed pick one up. */
function deviceLabel(): string {
  let host = '';
  try {
    host = os.hostname().replace(/\.local$/i, '');
  } catch {
    /* unavailable — the platform alone still helps */
  }
  const plat = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux';
  return `${host ? `${host} ` : ''}(${plat})`.slice(0, 64);
}

/** Earliest time the automatic renewal may try again (see
 *  renewalRetryDelayMs). A user-pasted code resets it. */
let renewNotBefore = 0;

async function connectAccount(
  connectCode: string,
  confirmEvict: boolean,
  evict?: string,
): Promise<ConnectOutcome> {
  await ensureEntitlementLoaded();
  // Code-less renewal must prove continuity: present the stored
  // entitlement (even a recently-expired one — the relay accepts a
  // 30-day grace) as the bearer. A bare routing code mints nothing.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [RELAY_CLIENT_VERSION_HEADER]: app.getVersion(),
  };
  if (!connectCode.trim() && entitlementState) {
    headers['Authorization'] = `Bearer ${entitlementState.entitlement}`;
  }
  let res: Response;
  try {
    res = await fetch(`${relayUrl()}/connect`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        connectCode: connectCode.trim(),
        routingCode: ks().ownRoutingId(),
        confirmEvict,
        // Seat picker: the machine the user chose to unlink (relay ≥
        // 2026-09-02; older relays ignore it and evict the oldest).
        ...(evict ? { evict } : {}),
        deviceLabel: deviceLabel(),
      }),
    });
  } catch (err) {
    console.warn('[pairing] connect failed:', err);
    return { ok: false, error: 'network' };
  }
  const body = (await res.json().catch(() => ({}))) as ConnectResponseBody;
  const { outcome, next, evicted } = interpretConnectResponse(res.status, body, entitlementState);
  renewNotBefore = Date.now() + renewalRetryDelayMs(outcome);
  const wasLapsed = membershipLapsed;
  membershipLapsed = nextLapsedFlag(membershipLapsed, outcome, evicted);
  if (next !== undefined) {
    entitlementState = next;
    await persistEntitlement();
    broadcastEntitlement(evicted ? { evicted: true } : undefined);
  } else if (membershipLapsed !== wasLapsed) {
    // No state change to announce, but the lapse flag moved — an open
    // settings dialog should show it without waiting for a reopen.
    broadcastEntitlement();
  }
  return outcome;
}

/** Best-effort server-side seat release for a user-initiated unlink.
 *  The entitlement (even one expired within the relay's 30-day renewal
 *  grace) proves this machine owns the seat — a bare routing code must
 *  never release one. Failures are logged and swallowed: the seat then
 *  stays held until an evict, which is all Disconnect ever did before
 *  this existed. */
async function releaseSeat(entitlement: string, routingCode = ks().ownRoutingId()): Promise<void> {
  try {
    const res = await fetch(`${relayUrl()}/disconnect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${entitlement}`,
        [RELAY_CLIENT_VERSION_HEADER]: app.getVersion(),
      },
      // `routingCode` is explicit because a regenerate names the OLD
      // routing id — the one the entitlement was minted for.
      body: JSON.stringify({ routingCode }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) console.log('[pairing] seat released server-side');
    else console.warn(`[pairing] seat release refused (${res.status}); seat stays until evicted`);
  } catch (err) {
    console.warn('[pairing] seat release failed (seat stays until evicted):', err);
  }
}

/** Renew the entitlement when it is inside its final 24h (or already
 *  expired). Code-less renewal — the relay refreshes active bindings
 *  freely; a 409 here means this machine's seat was taken. */
async function maybeRenewEntitlement(): Promise<void> {
  if (renewing || config.relayUrl.trim()) return;
  await ensureEntitlementLoaded();
  if (entitlementState === null) return;
  if (!renewalDue(entitlementState, Date.now())) return;
  if (Date.now() < renewNotBefore) return; // a refused renewal backs off (renewalRetryDelayMs)
  renewing = true;
  try {
    const outcome = await connectAccount('', false);
    if (outcome.ok) {
      console.log('[pairing] entitlement renewed');
    } else if (outcome.error === 'evicted') {
      console.warn('[pairing] this machine was unlinked from the blog account');
    } else if (outcome.error === 'subscription') {
      // connectAccount already flipped + broadcast the lapse flag.
      console.warn('[pairing] renewal refused: membership inactive');
    }
  } finally {
    renewing = false;
  }
}

// ── Inbox state (persisted, broadcast) ───────────────────────────────

let inbox: InboxItem[] = [];
let inboxLoaded = false;

function inboxPath(): string {
  return path.join(app.getPath('userData'), 'pairing-inbox.json');
}

async function ensureInboxLoaded(): Promise<void> {
  if (inboxLoaded) return;
  inboxLoaded = true;
  try {
    const text = await fs.readFile(inboxPath(), 'utf8');
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.items)) {
      inbox = parsed.items.filter(
        (it: unknown): it is InboxItem =>
          !!it && typeof it === 'object' && typeof (it as InboxItem).id === 'string',
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[pairing] Failed to read pairing-inbox.json:', err);
    }
    inbox = [];
  }
}

let inboxWriteTail: Promise<void> = Promise.resolve();
function persistInbox(): Promise<void> {
  const snapshot = inbox;
  inboxWriteTail = inboxWriteTail.catch(() => {}).then(async () => {
    const finalPath = inboxPath();
    const tmpPath = `${finalPath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify({ version: 1, items: snapshot }));
    await fs.rename(tmpPath, finalPath);
  });
  return inboxWriteTail;
}

function broadcastInbox(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('pairing:inbox-changed', inbox);
  }
}

let lastUnauthorizedBroadcast = 0;
function broadcastUnauthorized(): void {
  const now = Date.now();
  if (now - lastUnauthorizedBroadcast < 60_000) return; // at most once a minute
  lastUnauthorizedBroadcast = now;
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('pairing:unauthorized');
  }
}

function broadcastVersionMismatch(
  partnerVersion: string,
  localVersion: string,
  requiredVersion: string,
): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      w.webContents.send('pairing:version-mismatch', {
        partnerVersion,
        localVersion,
        requiredVersion,
      });
    }
  }
}

/** Compare two semver-ish versions (`X.Y.Z` or `X.Y.Z-pre.N`). Returns <0 if
 *  `a` is older than `b`, 0 if equal, >0 if newer. A release with no pre-release
 *  ranks above the same core with one (`1.0.0` > `1.0.0-alpha.1`); numeric
 *  pre-release identifiers compare numerically (so `alpha.9` < `alpha.10`). */
function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre = ''] = v.trim().split('-');
    const nums = core.split('.').map((n) => parseInt(n, 10) || 0);
    return {
      nums: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0],
      pre: pre ? pre.split('.') : [],
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i]! - pb.nums[i]!;
  }
  // No pre-release outranks a pre-release on the same core.
  if (pa.pre.length === 0 && pb.pre.length > 0) return 1;
  if (pa.pre.length > 0 && pb.pre.length === 0) return -1;
  const n = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1; // fewer identifiers ranks lower
    if (y === undefined) return 1;
    const xnum = /^\d+$/.test(x);
    const ynum = /^\d+$/.test(y);
    if (xnum && ynum) {
      const d = parseInt(x, 10) - parseInt(y, 10);
      if (d !== 0) return d;
    } else if (xnum !== ynum) {
      return xnum ? -1 : 1; // numeric identifiers rank below alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// ── Relay HTTP ───────────────────────────────────────────────────────

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  // Machine binding: when the bearer is our entitlement, name the
  // machine it was minted for. Never sent with the shared token or a
  // self-hosted relay's token — there is no `rc` claim to match, and a
  // strict self-hosted CORS setup shouldn't have to allow the header.
  const ent = validEntitlement();
  const usingEntitlement = ent !== null && relayToken() === ent.entitlement;
  return {
    Authorization: `Bearer ${relayToken()}`,
    [RELAY_CLIENT_VERSION_HEADER]: app.getVersion(),
    ...(usingEntitlement ? { [RELAY_CLIENT_ROUTING_HEADER]: ks().ownRoutingId() } : {}),
    ...extra,
  };
}

function deleteMessage(msgId: string): void {
  const url = `${relayUrl()}/messages/${encodeURIComponent(msgId)}`;
  fetch(url, { method: 'DELETE', headers: authHeaders() }).catch((err) => {
    console.warn(`[pairing] DELETE ${msgId} failed:`, err);
  });
}

/** Last mailbox ETag — echoed as If-None-Match so empty polls come
 *  back as bodyless 304s (relays without the tag just ignore it). */
let lastPollTag = '';

/** One catch-up/poll cycle: pull our mailbox and process it. */
async function pollOnce(): Promise<void> {
  if (polling || !config.enabled) return;
  void maybeRenewEntitlement();
  polling = true;
  try {
    const url = `${relayUrl()}/messages?recipient=${encodeURIComponent(ks().ownRoutingId())}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: authHeaders(lastPollTag ? { 'If-None-Match': lastPollTag } : {}),
    });
    if (res.status === 304) return; // empty poll — bodyless (capacity, 2026-08-18)
    if (!res.ok) {
      console.warn(`[pairing] GET inbox returned ${res.status}`);
      return;
    }
    lastPollTag = res.headers.get('ETag') ?? '';
    const data = (await res.json()) as { messages?: RelayMessage[] };
    const messages = data.messages ?? [];
    if (messages.length === 0) return;
    await processMessages(messages);
  } catch (err) {
    console.warn('[pairing] poll error:', err);
  } finally {
    polling = false;
  }
}

/** Decrypt + dedupe + inbox + ack one batch of relay messages. Shared by
 *  the poll path and the live stream (which delivers the same per-message
 *  shape one frame at a time). */
async function processMessages(messages: RelayMessage[]): Promise<void> {
  await ensureInboxLoaded();
  let changed = false;
  for (const m of messages) {
      if (!m || typeof m.msgId !== 'string') continue;
      if (consumed.has(m.msgId)) continue;
      consumed.add(m.msgId);

      // Decrypt the sealed bundle with our private key. A failure means it
      // wasn't really for us (or was sealed to a stale key of ours) — drop it.
      if (!m.epk || !m.iv || !m.ct || !m.tag) {
        deleteMessage(m.msgId);
        continue;
      }
      let inner: InnerPayload;
      try {
        inner = ks().open({ epk: m.epk, iv: m.iv, ct: m.ct, tag: m.tag }) as InnerPayload;
      } catch {
        console.warn('[pairing] could not decrypt a message; dropping');
        deleteMessage(m.msgId);
        continue;
      }

      // Compatibility floor (travels inside the ciphertext): a card may declare
      // the minimum receiver version that can safely read it. Reject ONLY when
      // that floor is set and we're older than it — a blank floor means any
      // version may receive, so cross-version sharing is tolerant by default.
      // Drop the rejected card, tell the UI, and clear it from the relay.
      const partnerVersion = inner.schemaVersion || 'unknown';
      const requiredMin = (inner.minReceiverVersion ?? '').trim();
      if (requiredMin && compareVersions(config.schemaVersion, requiredMin) < 0) {
        console.log(
          `[pairing] dropping card requiring >= ${requiredMin} ` +
            `(local ${config.schemaVersion}, from ${partnerVersion})`,
        );
        broadcastVersionMismatch(partnerVersion, config.schemaVersion, requiredMin);
        deleteMessage(m.msgId);
        continue;
      }

      const item = inner.item;
      if (!item || typeof item !== 'object') {
        deleteMessage(m.msgId);
        continue;
      }
      // Dedupe by source msgId so a failed DELETE can't double-add.
      const id = `rx-${m.msgId}`;
      if (!inbox.some((it) => it.id === id)) {
        inbox = [
          ...inbox,
          {
            id,
            label: typeof item.label === 'string' ? item.label : 'Card',
            type: typeof item.type === 'string' ? item.type : '',
            sliceJson: item.sliceJson,
            senderName: typeof inner.senderName === 'string' ? inner.senderName : '',
            senderCode: typeof inner.senderCode === 'string' ? inner.senderCode : '',
            via: typeof inner.via === 'string' && inner.via ? inner.via : undefined,
            receivedAt: Date.now(),
            read: false,
          },
        ];
        changed = true;
      }
      deleteMessage(m.msgId);
    }

  if (changed) {
    broadcastInbox();
    await persistInbox();
  }
}

// ── Delivery channel (push stream, poll catch-up, legacy fallback) ───

function stopDelivery(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (catchupTimer !== null) {
    clearInterval(catchupTimer);
    catchupTimer = null;
  }
  stream?.stop();
  stream = null;
}

/** Legacy mode — the relay has no /stream endpoint: today's interval
 *  polling, at the configured cadence. */
function startFallbackPolling(): void {
  if (pollTimer !== null) return;
  const ms = Math.max(5, config.pollSeconds) * 1000;
  console.log(`[pairing] polling every ${ms / 1000}s for ${ks().ownRoutingId()}`);
  void pollOnce();
  pollTimer = setInterval(() => void pollOnce(), ms);
}

/** (Re)start the delivery channel to match `config`. Push-first: open the
 *  SSE stream and run a catch-up poll on every (re)connect; a 404 from
 *  /stream marks this relay URL legacy for the session and switches to
 *  interval polling. While streaming, `pollSeconds` (floored to 5 min)
 *  paces a low-frequency belt-and-suspenders catch-up. */
function applyDelivery(): void {
  stopDelivery();
  if (!config.enabled) {
    console.log('[pairing] delivery off');
    return;
  }
  if (streamUnsupportedUrl !== null && streamUnsupportedUrl === relayUrl()) {
    startFallbackPolling();
    return;
  }
  void maybeRenewEntitlement();
  console.log(`[pairing] connecting push stream for ${ks().ownRoutingId()}`);
  stream = new RelayStream({
    url: () => `${relayUrl()}/stream?recipient=${encodeURIComponent(ks().ownRoutingId())}`,
    headers: () => authHeaders(),
    label: 'pairing',
    callbacks: {
      onConnected: () => {
        console.log('[pairing] push stream connected; running catch-up poll');
        void pollOnce();
      },
      onMessage: (data) => {
        if (data && typeof (data as RelayMessage).msgId === 'string') {
          void processMessages([data as RelayMessage]).catch((err) => {
            console.warn('[pairing] stream message error:', err);
          });
        }
      },
      onUnsupported: () => {
        console.log('[pairing] relay has no /stream — falling back to interval polling');
        streamUnsupportedUrl = relayUrl();
        startFallbackPolling();
      },
      onUnauthorized: () => {
        // A 401 means the relay rejected our credentials — a wrong
        // self-host token today, or (once gating enforces) a missing
        // subscription. Surface it to the user, throttled, so it never
        // spams: the two paths forward are connect an account or run
        // your own relay.
        console.warn('[pairing] relay rejected our token (401)');
        broadcastUnauthorized();
      },
    },
  });
  stream.start();
  const catchupMs = Math.max(config.pollSeconds, 300) * 1000;
  catchupTimer = setInterval(() => void pollOnce(), catchupMs);
}

// ── IPC ──────────────────────────────────────────────────────────────

export function registerPairingIpc(): void {
  // Configure returns this machine's public CODE (its X25519 public key), so
  // the renderer can display it and the user can share it. The private key
  // stays in main.
  let configured = false;
  ipcMain.handle(
    'host:pairing-configure',
    (_event, cfg: Partial<PairingConfig>): { ownCode: string } => {
      const prev = config;
      config = {
        enabled: !!cfg?.enabled,
        displayName: typeof cfg?.displayName === 'string' ? cfg.displayName : '',
        schemaVersion: typeof cfg?.schemaVersion === 'string' ? cfg.schemaVersion : 'unknown',
        minReceiverVersion:
          typeof cfg?.minReceiverVersion === 'string' ? cfg.minReceiverVersion : '',
        pollSeconds:
          typeof cfg?.pollSeconds === 'number' && Number.isFinite(cfg.pollSeconds)
            ? cfg.pollSeconds
            : 30,
        relayUrl: typeof cfg?.relayUrl === 'string' ? cfg.relayUrl : '',
        relayToken: typeof cfg?.relayToken === 'string' ? cfg.relayToken : '',
      };
      // Only materialize a keypair once the user actually turns sharing on,
      // so a fresh install that never enables it writes no key file.
      const ownCode = config.enabled ? ks().ownPublicCode() : '';
      // The renderer re-configures on EVERY settings change; only restart
      // the delivery channel when a field it depends on actually moved —
      // a display-name edit must not sever a live push stream.
      const deliveryChanged =
        !configured ||
        prev.enabled !== config.enabled ||
        prev.pollSeconds !== config.pollSeconds ||
        prev.relayUrl !== config.relayUrl ||
        prev.relayToken !== config.relayToken;
      configured = true;
      if (deliveryChanged) applyDelivery();
      return { ownCode };
    },
  );

  // Mint a fresh keypair (invalidates the old code for partners). Returns the
  // new public code and re-points delivery at the new routing code.
  // Rooms (collab sessions) run their HTTP/SSE client in the renderer;
  // hand it the same baked relay base + shared token card sharing uses,
  // as the LAST fallback after settings/dev-env. The rooms transport is
  // E2E encrypted, so the renderer holding the shared bearer token is
  // equivalent exposure to the web edition.
  ipcMain.handle(
    'host:collab-relay-defaults',
    async (): Promise<{ url: string; token: string; routingCode: string }> => {
      // Await the entitlement load so the FIRST rooms fetch after launch
      // already carries the entitlement (and its routing code) instead of
      // racing the lazy file read and falling back to the shared token.
      await ensureEntitlementLoaded();
      const token = relayToken();
      const ent = validEntitlement();
      // routingCode only when the token IS the entitlement: it names the
      // machine for the relay's machine-binding check. ks() is only
      // touched in that case — an entitlement implies the keypair already
      // exists, so this never materializes a key file on an install that
      // never enabled sharing.
      const routingCode = ent !== null && token === ent.entitlement ? ks().ownRoutingId() : '';
      return { url: relayUrl(), token, routingCode };
    },
  );

  ipcMain.handle('host:pairing-regenerate-key', (): { ownCode: string } => {
    // The entitlement is bound to the OLD routing code — a new keypair
    // needs a fresh connect from the blog page. Capture the old identity
    // first: the seat release must name the routing id the entitlement
    // was minted for. Without the release the old seat stayed held and
    // the regenerated machine's re-link then evicted a machine the
    // member still uses (relay identity audit 2026-09-02).
    const oldRoutingId = ks().ownRoutingId();
    const oldEntitlement = entitlementState?.entitlement ?? '';
    const ownCode = ks().regenerate();
    consumed.clear();
    if (entitlementState !== null || membershipLapsed) {
      entitlementState = null;
      membershipLapsed = false;
      renewNotBefore = 0;
      void persistEntitlement();
      broadcastEntitlement();
      if (oldEntitlement) void releaseSeat(oldEntitlement, oldRoutingId);
    }
    applyDelivery();
    return { ownCode };
  });

  // Blog-account entitlement surface. An entitlement gates nothing
  // while the relay runs ungated; enforcement is a server-side flip.
  ipcMain.handle(
    'host:pairing-connect-account',
    async (_e, payload: { connectCode: string; confirmEvict?: boolean; evict?: string }) => {
      if (typeof payload?.connectCode !== 'string' || !payload.connectCode.trim()) {
        return { ok: false, error: 'badCode' };
      }
      renewNotBefore = 0; // a person is acting — never held back by a backoff
      const evict = typeof payload.evict === 'string' && payload.evict.trim() ? payload.evict.trim() : undefined;
      return connectAccount(payload.connectCode, !!payload.confirmEvict, evict);
    },
  );
  ipcMain.handle('host:pairing-account-status', async () => {
    await ensureEntitlementLoaded();
    return accountStatus();
  });
  ipcMain.handle('host:pairing-disconnect-account', async () => {
    await ensureEntitlementLoaded();
    if (entitlementState !== null || membershipLapsed) {
      const entitlement = entitlementState?.entitlement ?? '';
      entitlementState = null;
      membershipLapsed = false;
      renewNotBefore = 0;
      await persistEntitlement();
      broadcastEntitlement();
      // Release the seat server-side AFTER the local wipe (so a quick
      // re-connect can't be clobbered by a slow release) and best-effort:
      // offline / an older relay just leaves the seat held until an
      // evict — exactly the pre-release behavior (field report
      // 2026-08-27: unlinked machines kept holding seats).
      if (entitlement) void releaseSeat(entitlement);
    }
    return accountStatus();
  });

  // Wake-from-sleep: the stream's socket may be silently dead — force a
  // prompt reconnect (whose hello triggers the catch-up poll). In
  // fallback-poll mode just poll immediately instead of waiting a cycle.
  powerMonitor.on('resume', () => {
    // Renderers first (collab session streams restart themselves) —
    // NOT gated on pairing being enabled.
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('host:power-resumed');
    }
    if (!config.enabled) return;
    console.log('[pairing] system resumed — refreshing delivery channel');
    if (stream) stream.restart();
    else void pollOnce();
  });

  ipcMain.handle(
    'host:pairing-send',
    async (
      _event,
      payload: {
        recipientCodes: string[];
        item: SendItem;
        via?: string;
        minReceiverVersion?: string;
      },
    ): Promise<{ ok: number; fail: number; authFail: number }> => {
      const targets = Array.isArray(payload?.recipientCodes)
        ? Array.from(new Set(payload.recipientCodes.filter((c) => typeof c === 'string' && c)))
        : [];
      if (targets.length === 0 || !payload?.item) {
        return { ok: 0, fail: targets.length, authFail: 0 };
      }
      const senderCode = ks().ownPublicCode();
      let ok = 0;
      let fail = 0;
      /** How many of `fail` were the relay DECLINING our credentials
       *  (401/403) rather than an outage — the renderer names the fix
       *  instead of "couldn't reach". Inert while the relay is ungated. */
      let authFail = 0;
      await Promise.all(
        targets.map(async (recipientPublicCode) => {
          try {
            // Seal everything-but-routing to the recipient's public key.
            // Per-message floor (session invites) beats the config-level
            // card floor; blank still means tolerant.
            const floor =
              typeof payload.minReceiverVersion === 'string' && payload.minReceiverVersion.trim()
                ? payload.minReceiverVersion.trim()
                : config.minReceiverVersion;
            const inner: InnerPayload = {
              schemaVersion: config.schemaVersion,
              // Omit when blank so the payload stays minimal and older receivers
              // never see an unexpected field; absent = tolerant.
              minReceiverVersion: floor || undefined,
              senderCode,
              senderName: config.displayName,
              via: payload.via,
              item: {
                label: payload.item.label,
                type: payload.item.type,
                sliceJson: payload.item.sliceJson,
              },
            };
            const bundle = ks().seal(inner, recipientPublicCode);
            const body = {
              v: 1 as const,
              recipientCode: routingId(recipientPublicCode),
              sentAt: Date.now(),
              ...bundle,
            };
            const gz = gzipSync(Buffer.from(JSON.stringify(body), 'utf8'));
            const res = await fetch(`${relayUrl()}/messages`, {
              method: 'POST',
              headers: authHeaders({
                'Content-Type': 'application/json',
                'Content-Encoding': 'gzip',
              }),
              body: gz,
            });
            if (res.ok) ok++;
            else {
              fail++;
              if (res.status === 401 || res.status === 403) authFail++;
              console.warn(`[pairing] POST returned ${res.status}`);
            }
          } catch (err) {
            fail++;
            console.warn('[pairing] send failed:', err);
          }
        }),
      );
      return { ok, fail, authFail };
    },
  );

  ipcMain.handle('host:pairing-inbox-list', async () => {
    await ensureInboxLoaded();
    return inbox;
  });

  ipcMain.handle('host:pairing-inbox-remove', async (_event, id: string) => {
    if (typeof id !== 'string' || !id) return;
    await ensureInboxLoaded();
    const next = inbox.filter((it) => it.id !== id);
    if (next.length === inbox.length) return;
    inbox = next;
    broadcastInbox();
    await persistInbox();
  });

  ipcMain.handle('host:pairing-inbox-clear', async () => {
    await ensureInboxLoaded();
    if (inbox.length === 0) return;
    inbox = [];
    broadcastInbox();
    await persistInbox();
  });

  ipcMain.handle('host:pairing-inbox-mark-read', async () => {
    await ensureInboxLoaded();
    if (!inbox.some((it) => !it.read)) return;
    inbox = inbox.map((it) => (it.read ? it : { ...it, read: true }));
    broadcastInbox();
    await persistInbox();
  });
}
