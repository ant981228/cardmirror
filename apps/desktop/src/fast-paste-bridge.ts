/**
 * Fast Debate Paste integration — main-process HTTP server.
 *
 * Wire contract: `reference-docs/cardmirror-integration-spec.md`
 * (and the F2 fix companion note in the same folder).
 *
 * Boundary contract:
 *   - Bind `127.0.0.1` only (never 0.0.0.0). Off the network entirely.
 *   - Per-launch random token via `crypto.randomBytes`. Constant-time
 *     compare on `X-FDP-Token` for both endpoints.
 *   - Discovery file at `app.getPath('userData')/fast-paste-bridge.json`,
 *     atomic tmp-then-rename write on start, deleted on `before-quit`.
 *   - Prefer port 17699; on `EADDRINUSE` retry with `listen(0)` and
 *     record the actual port in the discovery file.
 *   - Optionally reject requests carrying an `Origin` / `Referer`
 *     header to blunt DNS-rebinding from a page in the user's browser.
 *
 * Routes:
 *   - `GET  /ping`   → `{ok, app, appVersion, schema, hasActiveDoc}`.
 *     Identity-free (discovery must bootstrap before identity exists)
 *     and deliberately content-free — it must never grow doc titles,
 *     paths, or previews; anything content-bearing belongs behind an
 *     identified, consented route.
 *   - `POST /insert` → forwards to the focused window's renderer via
 *     `external:insert-text` IPC and awaits the renderer's
 *     `external:insert-result` reply (with a hard timeout so the
 *     client never hangs and can fall back to its keystroke path).
 *   - `POST /jump`   → broadcast to doc windows; the token-holding
 *     window scrolls/selects and is focused.
 *   - `POST /replace` → broadcast to doc windows; the token-holding
 *     window rewrites that token's own text in place and mints a fresh
 *     token. Focuses, shows and scrolls NOTHING: it fires on every
 *     settled edit in the sending app, so activating a window here
 *     would fight the reader for their own screen.
 *
 * Identity & consent: every route EXCEPT /ping requires an
 * `X-App-Id` header and is governed by the user's per-app consent
 * decision (see external-consent.ts) — new routes inherit this
 * default unless explicitly classed as discovery.
 *
 * Insert routing: the focused window, else the most recently
 * focused doc window (flow apps send while THEY hold focus), never
 * an arbitrary any-window pick — that could mistarget.
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { readAppIdentity } from './bridge-handshake.js';
import { ConsentGate, parseAppId, type ConsentMirror, type PromptOutcome } from './external-consent.js';

const PREFERRED_PORT = 17699;
const SCHEMA_VERSION = 2;
const TOKEN_BYTES = 24;
/** Hard timeout the client also enforces at 1500ms — keep ours
 *  slightly under so the server fails fast before the client
 *  cancels its own request and falls back to keystrokes. */
const RENDERER_ACK_TIMEOUT_MS = 1200;

interface DiscoveryFile {
  schema: number;
  port: number;
  token: string;
  pid: number;
  app: string;
  appVersion: string;
}

interface InsertPayload {
  text?: unknown;
  role?: unknown;
  newParagraph?: unknown;
  omitted?: unknown;
  /** Session-scoped doc target (a uid from GET /docs). Absent = the
   *  legacy path: focused/last-focused window, active pane. */
  target?: unknown;
  /** Rich payload (schema-2+, additive): HTML the renderer parses
   *  through the document schema. Optional both directions — an older
   *  CardMirror ignores it and renders `text`; a sender that omits it
   *  behaves exactly as before. */
  html?: unknown;
}

interface RendererAck {
  requestId: string;
  ok: boolean;
  error?: string;
  docTitle?: string;
  /** Minted tokens for the textblocks the insert created, in document
   *  order - one per line of `text`. OPTIONAL, unlike the replace /
   *  insert-after acks: only a heading role produces addressable
   *  blocks, and the renderer drops the field wholesale rather than
   *  hand back a list it couldn't verify. Absent is never an error
   *  here; the text landed either way. */
  sources?: string[];
}

interface JumpAck {
  requestId: string;
  ok: boolean;
  error?: string;
}

interface ReplaceAck {
  requestId: string;
  ok: boolean;
  error?: string;
  docTitle?: string;
  /** Freshly minted token for the rewritten range. Mandatory on ok:
   *  the caller's stored token anchors the pre-edit text, so without a
   *  re-mint exactly one edit per cell would ever land. */
  source?: string;
}

interface InsertAfterAck {
  requestId: string;
  ok: boolean;
  error?: string;
  docTitle?: string;
  /** Minted token for the line the renderer just added. Mandatory on
   *  ok: the line is text nothing named before this call, so without it
   *  the caller holds no handle to what it wrote. */
  source?: string;
}

let serverState: { server: http.Server; token: string; port: number } | null = null;

const pendingAcks = new Map<string, {
  resolve: (ack: RendererAck) => void;
  timer: NodeJS.Timeout;
}>();

const pendingJumpAcks = new Map<string, {
  resolve: (ack: JumpAck) => void;
  timer: NodeJS.Timeout;
}>();

const pendingReplaceAcks = new Map<string, {
  resolve: (ack: ReplaceAck) => void;
  timer: NodeJS.Timeout;
}>();

const pendingInsertAfterAcks = new Map<string, {
  resolve: (ack: InsertAfterAck) => void;
  timer: NodeJS.Timeout;
}>();

function discoveryFilePath(): string {
  return path.join(app.getPath('userData'), 'fast-paste-bridge.json');
}

async function writeDiscoveryFile(token: string, port: number): Promise<void> {
  const data: DiscoveryFile = {
    schema: SCHEMA_VERSION,
    port,
    token,
    pid: process.pid,
    app: 'cardmirror',
    appVersion: app.getVersion(),
  };
  const finalPath = discoveryFilePath();
  const tmpPath = `${finalPath}.tmp`;
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2));
  await fs.rename(tmpPath, finalPath);
}

async function deleteDiscoveryFile(): Promise<void> {
  await fs.unlink(discoveryFilePath()).catch(() => {});
}

function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function checkToken(req: http.IncomingMessage, token: string): boolean {
  // Schema 2 accepts the cross-app X-Bridge-Token header alongside
  // the legacy FDP one; both compare constant-time.
  const header = req.headers['x-bridge-token'] ?? req.headers['x-fdp-token'];
  if (typeof header !== 'string') return false;
  return constantTimeEqual(header, token);
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function readRequestBody(req: http.IncomingMessage, maxBytes = 4 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on('data', (c: Buffer) => {
      received += c.length;
      if (received > maxBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/** Roles the renderer's insert primitive understands
 *  (`src/editor/external-insert.ts` — keep the two in step). The heading
 *  levels come from the outline (`src/editor/headings.ts`); a client that
 *  sends one gets that style applied, so the relay must not flatten them. */
const INSERT_ROLES = new Set([
  'pocket',
  'hat',
  'block',
  'tag',
  'analytic',
  'body',
  'card',
  'cite',
  'inline',
]);

function normalizeRole(value: unknown): string {
  // Unknown values degrade to `card` per §10.
  return typeof value === 'string' && INSERT_ROLES.has(value) ? value : 'card';
}

function focusedRenderTarget(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  // Fall back to the first available window so a non-focused-but-
  // running app can still serve `/ping` (and consent prompts/toasts
  // still land somewhere) and not look broken. Inserts do NOT use
  // this fallback — see insertTarget.
  const all = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  return all.length > 0 ? all[0]! : null;
}

/** The most recently focused DOC window — the insert target while
 *  CardMirror is in the background. The two client styles differ: FDP
 *  activates its picked window before calling (focus IS how its target
 *  picker's choice travels — the wire has no window addressing), while
 *  ebb deliberately sends without activating (a flow app must not
 *  steal focus on every send), so its inserts land in the window the
 *  user most recently worked in. The timer pop-out never tracks — it
 *  has no insert handler. */
let lastFocusedWindow: BrowserWindow | null = null;
let focusTrackingInstalled = false;

function installFocusTracking(): void {
  if (focusTrackingInstalled) return;
  focusTrackingInstalled = true;
  (app as unknown as {
    on?: (event: string, cb: (evt: unknown, win: BrowserWindow) => void) => void;
  }).on?.('browser-window-focus', (_evt, win) => {
    if (win.webContents.getURL().endsWith('timer.html')) return;
    lastFocusedWindow = win;
  });
}

export function resetFocusTrackingForTests(): void {
  lastFocusedWindow = null;
}

/** Insert targeting: the focused window, else the most recently
 *  focused doc window, else `no-target-doc`. Never an arbitrary
 *  "first window in the list" — with several windows open that could
 *  land text in the wrong doc. */
function insertTarget(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  if (lastFocusedWindow && !lastFocusedWindow.isDestroyed()) return lastFocusedWindow;
  return null;
}

/** Cross-window doc directory, injected by main (which already tracks
 *  every open doc's uid → filename + owning window for the
 *  Select-Speech-Doc picker). Powers GET /docs and targeted inserts. */
export interface DocDirectory {
  listDocs(): Array<{ uid: string; filename: string | null; windowId: number }>;
  ownerWindow(uid: string): BrowserWindow | null;
  /** The uid currently designated as the speech doc, or null. Lets a
   *  client offer "send to the speech doc" without tracking focus. */
  speechUid(): string | null;
}
let docDirectory: DocDirectory | null = null;
export function setDocDirectory(dir: DocDirectory | null): void {
  docDirectory = dir;
}

/** Sanitized citeTokens of an insert payload: a small array of short
 *  strings, or null. Caps (8 tokens, 200 chars) are far above any real
 *  cite head and keep a malformed sender from shipping bulk data
 *  through a styling field. */
function citeTokensOf(payload: InsertPayload): string[] | null {
  const raw = (payload as { citeTokens?: unknown }).citeTokens;
  if (!Array.isArray(raw)) return null;
  const tokens = raw
    .filter((t): t is string => typeof t === 'string' && t.length > 0 && t.length <= 200)
    .slice(0, 8);
  return tokens.length > 0 ? tokens : null;
}

/** Sanitized html of an insert payload: a non-empty string within the
 *  renderer's parse cap (mirrored there), else null. */
const INSERT_HTML_MAX_BYTES = 2 * 1024 * 1024;
function htmlOf(payload: InsertPayload): string | null {
  const raw = payload.html;
  return typeof raw === 'string' && raw.length > 0 && raw.length <= INSERT_HTML_MAX_BYTES
    ? raw
    : null;
}

/** The target uid of an insert payload, or null for the legacy
 *  focused-window path. Opaque session-scoped token from /docs. */
function targetUidOf(payload: InsertPayload): string | null {
  return typeof payload.target === 'string' && payload.target.length > 0 && payload.target.length <= 128
    ? payload.target
    : null;
}

/** Resolve the window an insert should go to — the target's owner
 *  when addressed, else the legacy focused/last-focused window. */
function windowForInsert(payload: InsertPayload): BrowserWindow | null {
  const uid = targetUidOf(payload);
  if (uid) return docDirectory?.ownerWindow(uid) ?? null;
  return insertTarget();
}

function dispatchToRenderer(payload: InsertPayload, win: BrowserWindow | null): Promise<RendererAck> {
  return new Promise((resolve) => {
    if (!win) {
      resolve({ requestId: '', ok: false, error: 'no-target-doc' });
      return;
    }
    const requestId = crypto.randomBytes(8).toString('hex');
    const timer = setTimeout(() => {
      pendingAcks.delete(requestId);
      resolve({ requestId, ok: false, error: 'internal' });
    }, RENDERER_ACK_TIMEOUT_MS);
    pendingAcks.set(requestId, { resolve, timer });
    win.webContents.send('external:insert-text', {
      requestId,
      text: typeof payload.text === 'string' ? payload.text : '',
      role: normalizeRole(payload.role),
      newParagraph:
        typeof payload.newParagraph === 'boolean' ? payload.newParagraph : true,
      omitted: payload.omitted === true,
      ...(targetUidOf(payload) ? { target: targetUidOf(payload) } : {}),
      ...(citeTokensOf(payload) ? { citeTokens: citeTokensOf(payload) } : {}),
      ...(htmlOf(payload) ? { html: htmlOf(payload) } : {}),
    });
  });
}

function onRendererAck(_evt: unknown, ack: RendererAck): void {
  if (!ack || typeof ack.requestId !== 'string') return;
  const pending = pendingAcks.get(ack.requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingAcks.delete(ack.requestId);
  pending.resolve(ack);
}

function onJumpAck(_evt: unknown, ack: JumpAck): void {
  if (!ack || typeof ack.requestId !== 'string') return;
  const pending = pendingJumpAcks.get(ack.requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingJumpAcks.delete(ack.requestId);
  pending.resolve(ack);
}

function onReplaceAck(_evt: unknown, ack: ReplaceAck): void {
  if (!ack || typeof ack.requestId !== 'string') return;
  const pending = pendingReplaceAcks.get(ack.requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingReplaceAcks.delete(ack.requestId);
  pending.resolve(ack);
}

function onInsertAfterAck(_evt: unknown, ack: InsertAfterAck): void {
  if (!ack || typeof ack.requestId !== 'string') return;
  const pending = pendingInsertAfterAcks.get(ack.requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingInsertAfterAcks.delete(ack.requestId);
  pending.resolve(ack);
}

// keep in sync with SOURCE_TOKEN_PREFIX in src/editor/plugin-source-token.ts
// (this literal adds the dot separator; the source constant is the bare prefix)
const SOURCE_TOKEN_PREFIX = 'cmsrc1.';

// ---------------------------------------------------------------------------
// External-app consent (see external-consent.ts for the model). The gate
// lives main-side; prompts run in the focused renderer over their own
// request/result IPC pair, mirroring the insert/jump ack plumbing.

/** Generous — a human is reading a dialog. The renderer resolves
 *  'dismissed' on Esc; this timeout only covers a closed/hung window. */
const CONSENT_PROMPT_TIMEOUT_MS = 180_000;
const UNIDENTIFIED_TOAST_MIN_INTERVAL_MS = 60_000;

interface ConsentPromptAck {
  requestId: string;
  outcome?: unknown;
}

const pendingConsentAcks = new Map<
  string,
  { resolve: (outcome: PromptOutcome) => void; timer: NodeJS.Timeout }
>();

function onConsentPromptAck(_evt: unknown, ack: ConsentPromptAck): void {
  if (!ack || typeof ack.requestId !== 'string') return;
  const pending = pendingConsentAcks.get(ack.requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingConsentAcks.delete(ack.requestId);
  const o = ack.outcome;
  pending.resolve(
    o === 'allow-always' || o === 'allow-once' || o === 'deny' ? o : 'dismissed',
  );
}

/** Coerce a renderer-supplied mirror to a safe shape (the renderer is
 *  trusted code, but the IPC payload shape is still validated). */
function sanitizeMirror(raw: unknown): ConsentMirror {
  const r = (raw ?? {}) as { policy?: unknown; apps?: unknown };
  const apps: Record<string, 'allow' | 'deny'> = {};
  if (r.apps && typeof r.apps === 'object') {
    for (const [id, decision] of Object.entries(r.apps as Record<string, unknown>)) {
      if ((decision === 'allow' || decision === 'deny') && parseAppId(id) !== null) {
        apps[id] = decision;
      }
    }
  }
  const policy = r.policy === 'off' || r.policy === 'open' ? r.policy : 'ask';
  return { policy, apps };
}

function onConsentSync(_evt: unknown, raw: unknown): void {
  consentGate.setState(sanitizeMirror(raw));
}

async function promptRendererForConsent(appId: string): Promise<PromptOutcome> {
  const win = focusedRenderTarget();
  if (!win) return 'dismissed';
  const identity = await readAppIdentity(appId).catch(() => null);
  return new Promise((resolve) => {
    const requestId = crypto.randomBytes(8).toString('hex');
    const timer = setTimeout(() => {
      pendingConsentAcks.delete(requestId);
      resolve('dismissed');
    }, CONSENT_PROMPT_TIMEOUT_MS);
    pendingConsentAcks.set(requestId, { resolve, timer });
    win.webContents.send('external:consent-prompt', {
      requestId,
      appId,
      appName: identity?.app ?? null,
      appVersion: identity?.appVersion ?? null,
    });
  });
}

let lastUnidentifiedToastAt = 0;

/** Stamp the app's lastSeen in the renderer-held settings registry. */
function noteSeen(appId: string): void {
  focusedRenderTarget()?.webContents.send('external:consent-note', {
    kind: 'seen',
    appId,
    when: new Date().toISOString(),
  });
}

const consentGate = new ConsentGate({
  prompt: promptRendererForConsent,
  recordSeen: noteSeen,
});

export function consentGateForTests(): ConsentGate {
  return consentGate;
}

export function resetExternalConsentForTests(): void {
  consentGate.resetForTests();
  lastUnidentifiedToastAt = 0;
}

/** Identity for a gated request: the declared `X-App-Id` or nothing.
 *  Deliberately NO inference from other request features — ebb is the
 *  only legacy client we know of, but anyone may have built against
 *  the pre-identity spec, and guessing wrong would put one app's name
 *  on another app's traffic. Unidentified callers are rejected with a
 *  generic explanation instead (notifyUnidentifiedCaller). */
function requestAppId(req: http.IncomingMessage): string | null {
  return parseAppId(req.headers['x-app-id']);
}

/** Tell the user (in the focused window) that an unidentified app
 *  knocked and was turned away — where the consent prompt would have
 *  appeared. The renderer shows a full dialog the first time and a
 *  toast after; this side just rate-limits the stream. */
function notifyUnidentifiedCaller(): void {
  const now = Date.now();
  if (now - lastUnidentifiedToastAt < UNIDENTIFIED_TOAST_MIN_INTERVAL_MS) return;
  lastUnidentifiedToastAt = now;
  focusedRenderTarget()?.webContents.send('external:consent-note', { kind: 'unidentified' });
}

function dispatchJumpTo(win: BrowserWindow, source: string): Promise<JumpAck> {
  return new Promise((resolve) => {
    if (win.isDestroyed()) {
      resolve({ requestId: '', ok: false, error: 'not-mine' });
      return;
    }
    const requestId = crypto.randomBytes(8).toString('hex');
    const timer = setTimeout(() => {
      pendingJumpAcks.delete(requestId);
      resolve({ requestId, ok: false, error: 'not-mine' });
    }, RENDERER_ACK_TIMEOUT_MS);
    pendingJumpAcks.set(requestId, { resolve, timer });
    try {
      win.webContents.send('external:jump', { requestId, source });
    } catch {
      // Window torn down between the isDestroyed() check and send
      // (render process gone). Don't leave the route hanging on a
      // timeout that can never be acked.
      clearTimeout(timer);
      pendingJumpAcks.delete(requestId);
      resolve({ requestId, ok: false, error: 'not-mine' });
    }
  });
}

/** Minimal token peek — main only needs docTitle for the
 *  doc-not-open message; full parsing stays renderer-side. */
function docTitleFromToken(source: string): string | undefined {
  if (!source.startsWith(SOURCE_TOKEN_PREFIX)) return undefined;
  const dot = source.indexOf('.');
  if (dot < 0) return undefined;
  try {
    const obj = JSON.parse(
      Buffer.from(source.slice(dot + 1), 'base64url').toString('utf8'),
    ) as { docTitle?: unknown };
    return typeof obj.docTitle === 'string' && obj.docTitle ? obj.docTitle : undefined;
  } catch {
    return undefined;
  }
}

/** The windows a token broadcast may ask. Doc windows all install the
 *  token listeners; the timer pop-out (timer.html,
 *  main.ts:openTimerWindow) is the one window kind that doesn't, and
 *  broadcasting to it would just burn the full ack timeout. Skip it by
 *  URL - a future non-doc window kind that isn't added here costs only
 *  that timeout (it can never mis-ack, so correctness doesn't depend on
 *  this list being complete). */
function tokenBroadcastWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(
    (w) => !w.isDestroyed() && !w.webContents.getURL().endsWith('timer.html'),
  );
}

/** Ask each window in turn to resolve the token; the first ok wins and
 *  its window is focused. Exported for the host:plugin-jump IPC. */
export async function broadcastJump(
  source: string,
): Promise<{ ok: boolean; error?: string; docTitle?: string }> {
  // An unparseable token can never match any window; reject it up front
  // rather than broadcasting and misreporting doc-not-open (which would
  // echo a forged docTitle from a token that isn't ours).
  if (!source.startsWith(SOURCE_TOKEN_PREFIX)) {
    return { ok: false, error: 'bad-request' };
  }
  const wins = tokenBroadcastWindows();
  const acks = await Promise.all(
    wins.map((win) => dispatchJumpTo(win, source).then((ack) => ({ win, ack }))),
  );
  // First ok wins. Only one open doc holds a given docId in normal use,
  // so multiple-ok isn't a real case; if it ever is, the first still wins.
  const winner = acks.find((a) => a.ack.ok);
  if (winner) {
    if (winner.win.isMinimized()) winner.win.restore();
    winner.win.show();
    winner.win.focus();
    return { ok: true };
  }
  if (acks.some((a) => a.ack.error === 'bad-request')) {
    return { ok: false, error: 'bad-request' };
  }
  if (acks.some((a) => a.ack.error === 'not-found')) {
    return { ok: false, error: 'not-found' };
  }
  const docTitle = docTitleFromToken(source);
  return { ok: false, error: 'doc-not-open', ...(docTitle ? { docTitle } : {}) };
}

/** A replace carries one line of a card, never a document. The body cap
 *  stops a runaway client from streaming megabytes into a route that can
 *  only ever apply a single line; the text cap states the same bound on
 *  the field the renderer actually applies. */
const REPLACE_BODY_MAX_BYTES = 64 * 1024;
const REPLACE_TEXT_MAX_CHARS = 8 * 1024;

function dispatchReplaceTo(
  win: BrowserWindow,
  source: string,
  text: string,
): Promise<ReplaceAck> {
  return new Promise((resolve) => {
    if (win.isDestroyed()) {
      resolve({ requestId: '', ok: false, error: 'not-mine' });
      return;
    }
    const requestId = crypto.randomBytes(8).toString('hex');
    const timer = setTimeout(() => {
      pendingReplaceAcks.delete(requestId);
      resolve({ requestId, ok: false, error: 'not-mine' });
    }, RENDERER_ACK_TIMEOUT_MS);
    pendingReplaceAcks.set(requestId, { resolve, timer });
    try {
      win.webContents.send('external:replace-text', { requestId, source, text });
    } catch {
      // Window torn down between the isDestroyed() check and send
      // (render process gone). Answer as a non-holder so the route
      // never waits on an ack that can no longer arrive.
      clearTimeout(timer);
      pendingReplaceAcks.delete(requestId);
      resolve({ requestId, ok: false, error: 'not-mine' });
    }
  });
}

/** Ask each window in turn to rewrite the token's own text; the first ok
 *  wins and carries back the fresh token its renderer minted.
 *
 *  Unlike broadcastJump, the winning window is deliberately NOT
 *  restored, shown or focused, and nothing scrolls. ebb calls this on
 *  every settled edit, so raising a window here would yank the reader's
 *  screen away mid-sentence; that silence is the whole reason /replace
 *  exists instead of a /jump + /insert composition. */
async function broadcastReplace(
  source: string,
  text: string,
): Promise<{ ok: boolean; error?: string; docTitle?: string; source?: string }> {
  const acks = await Promise.all(
    tokenBroadcastWindows().map((win) => dispatchReplaceTo(win, source, text)),
  );
  const winner = acks.find((a) => a.ok);
  if (winner) {
    if (typeof winner.source === 'string' && winner.source) {
      return { ok: true, source: winner.source };
    }
    // An ok without a fresh token would leave the caller holding a
    // token whose anchor quotes text that no longer exists: the next
    // edit to that cell could never resolve. A hard error beats a cell
    // that silently stops accepting edits.
    return { ok: false, error: 'internal' };
  }
  // Precedence: a real complaint from any window beats the absence of
  // an answer. `not-mine` is per-window bookkeeping (this window does
  // not hold the token's doc) and never reaches the wire.
  // `body-text` sits ahead of `not-found`: a window that holds the doc
  // and refuses the target is a definite answer about that target, while
  // another window's `not-found` is only the absence of one.
  for (const code of ['bad-request', 'doc-readonly', 'body-text', 'not-found'] as const) {
    const hit = acks.find((a) => a.error === code);
    if (hit) {
      return { ok: false, error: code, ...(hit.docTitle ? { docTitle: hit.docTitle } : {}) };
    }
  }
  const docTitle = docTitleFromToken(source);
  return { ok: false, error: 'doc-not-open', ...(docTitle ? { docTitle } : {}) };
}

function dispatchInsertAfterTo(
  win: BrowserWindow,
  source: string,
  text: string,
): Promise<InsertAfterAck> {
  return new Promise((resolve) => {
    if (win.isDestroyed()) {
      resolve({ requestId: '', ok: false, error: 'not-mine' });
      return;
    }
    const requestId = crypto.randomBytes(8).toString('hex');
    const timer = setTimeout(() => {
      pendingInsertAfterAcks.delete(requestId);
      // `internal`, where the replace pair answers `not-mine`. A window
      // that went quiet may hold the doc and have inserted the line
      // without answering; `not-mine` from every window is
      // `doc-not-open`, a definite refusal, which the caller retries -
      // and a retry after a landed line puts a second copy in the user's
      // evidence file. The trade is deliberate: a merely slow window
      // costs this line staying in the flowing app, while the
      // alternative costs a duplicate in the document.
      resolve({ requestId, ok: false, error: 'internal' });
    }, RENDERER_ACK_TIMEOUT_MS);
    pendingInsertAfterAcks.set(requestId, { resolve, timer });
    try {
      win.webContents.send('external:insert-after', { requestId, source, text });
    } catch {
      // Window torn down between the isDestroyed() check and send
      // (render process gone). Answer as a non-holder so the route
      // never waits on an ack that can no longer arrive.
      clearTimeout(timer);
      pendingInsertAfterAcks.delete(requestId);
      resolve({ requestId, ok: false, error: 'not-mine' });
    }
  });
}

/** Ask each window in turn to add a line after the one the token names;
 *  the first ok wins and carries back the token its renderer minted for
 *  the line it created. Silent like broadcastReplace: the winning window
 *  is not restored, shown or focused, and nothing scrolls.
 *
 *  Where this parts from broadcastReplace: the token a winner carries
 *  names a line that did not exist a moment ago, so there is nothing to
 *  fall back to when it is missing. A `{ ok: true }` with no token would
 *  leave the caller having written a line into the user's document that
 *  it can never name, edit or jump to again - `internal` is the truthful
 *  answer. */
async function broadcastInsertAfter(
  source: string,
  text: string,
): Promise<{ ok: boolean; error?: string; docTitle?: string; source?: string }> {
  const acks = await Promise.all(
    tokenBroadcastWindows().map((win) => dispatchInsertAfterTo(win, source, text)),
  );
  const winner = acks.find((a) => a.ok);
  if (winner) {
    if (typeof winner.source === 'string' && winner.source) {
      return { ok: true, source: winner.source };
    }
    return { ok: false, error: 'internal' };
  }
  // `internal` LEADS the precedence, which is where this parts from
  // broadcastReplace a second time. A window reporting it may have put
  // the line in the document without a token for it, and every other
  // code is a definite refusal that changed nothing - so a caller told
  // one of those retries, and a retry after a landed line writes the
  // line twice. The rest follows broadcastReplace: a real complaint
  // beats the absence of an answer, `not-mine` is per-window bookkeeping
  // and never reaches the wire, and `body-text` sits ahead of
  // `not-found` because a window holding the doc that refuses the anchor
  // has answered about that anchor.
  for (const code of ['internal', 'bad-request', 'doc-readonly', 'body-text', 'not-found'] as const) {
    const hit = acks.find((a) => a.error === code);
    if (hit) {
      return { ok: false, error: code, ...(hit.docTitle ? { docTitle: hit.docTitle } : {}) };
    }
  }
  const docTitle = docTitleFromToken(source);
  return { ok: false, error: 'doc-not-open', ...(docTitle ? { docTitle } : {}) };
}
let ipcSubscribed = false;

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string,
): Promise<void> {
  // Optional Origin / Referer rejection — anything carrying either
  // header almost certainly came from a browser page, which has no
  // business talking to us. Plain `curl` / the FDP client do not
  // set these.
  if (req.headers['origin'] || req.headers['referer']) {
    jsonResponse(res, 403, { ok: false, error: 'unauthorized' });
    return;
  }

  if (!checkToken(req, token)) {
    jsonResponse(res, 403, { ok: false, error: 'unauthorized' });
    return;
  }

  const url = req.url ?? '';
  if (req.method === 'GET' && url === '/ping') {
    const hasActiveDoc = !!focusedRenderTarget();
    jsonResponse(res, 200, {
      ok: true,
      app: 'cardmirror',
      appVersion: app.getVersion(),
      schema: SCHEMA_VERSION,
      hasActiveDoc,
    });
    return;
  }

  if (req.method === 'GET' && url === '/docs') {
    // Content-bearing (doc titles) → identified + consented, per the
    // §5 default posture. One per-app decision covers docs/insert/jump.
    const appId = requestAppId(req);
    const disposition = consentGate.check(appId);
    if (disposition === 'unidentified') {
      notifyUnidentifiedCaller();
      jsonResponse(res, 200, {
        ok: false,
        error: 'unidentified',
        message:
          'This CardMirror requires apps to identify themselves with an X-App-Id header. Update the sending app.',
      });
      return;
    }
    if (disposition === 'off') {
      jsonResponse(res, 200, { ok: false, error: 'inserts-disabled' });
      return;
    }
    if (disposition === 'deny') {
      jsonResponse(res, 200, { ok: false, error: 'not-allowed' });
      return;
    }
    if (disposition === 'ask') {
      // Nothing sensible to queue for a listing — raise the prompt and
      // tell the caller to re-query after the user decides.
      consentGate.enqueue(appId!, () => {});
      jsonResponse(res, 200, { ok: true, docs: null, pending: 'consent' });
      return;
    }
    const focusedId = insertTarget()?.id;
    const speechUid = docDirectory?.speechUid() ?? null;
    const docs = (docDirectory?.listDocs() ?? []).map((d) => ({
      target: d.uid,
      title: d.filename,
      focusedWindow: d.windowId === focusedId,
      isSpeech: d.uid === speechUid,
    }));
    if (appId) noteSeen(appId);
    jsonResponse(res, 200, { ok: true, docs });
    return;
  }

  if (req.method === 'POST' && url === '/insert') {
    let bodyText: string;
    try {
      bodyText = await readRequestBody(req);
    } catch {
      jsonResponse(res, 400, { ok: false, error: 'bad-request' });
      return;
    }
    let payload: InsertPayload;
    try {
      payload = JSON.parse(bodyText) as InsertPayload;
    } catch {
      jsonResponse(res, 400, { ok: false, error: 'bad-request' });
      return;
    }
    if (typeof payload.text !== 'string') {
      jsonResponse(res, 400, { ok: false, error: 'bad-request' });
      return;
    }
    const appId = requestAppId(req);
    const disposition = consentGate.check(appId);
    if (disposition === 'unidentified') {
      notifyUnidentifiedCaller();
      jsonResponse(res, 200, {
        ok: false,
        error: 'unidentified',
        message:
          'This CardMirror requires apps to identify themselves with an X-App-Id header. Update the sending app.',
      });
      return;
    }
    if (disposition === 'off') {
      jsonResponse(res, 200, { ok: false, error: 'inserts-disabled' });
      return;
    }
    if (disposition === 'deny') {
      jsonResponse(res, 200, { ok: false, error: 'not-allowed' });
      return;
    }
    if (disposition === 'ask') {
      // Queue behind the consent prompt; Allow applies the queued insert
      // so the user's click IS the redo. `ok:true` — the request was
      // accepted for delivery; `pending` tells a new client what state
      // it's in. Deny/dismiss discards it silently (the user's call).
      const queued = consentGate.enqueue(appId!, () => {
        void dispatchToRenderer(payload, windowForInsert(payload));
      });
      if (queued) {
        jsonResponse(res, 200, { ok: true, inserted: false, pending: 'consent' });
      } else {
        jsonResponse(res, 200, { ok: false, error: 'not-allowed' });
      }
      return;
    }
    const targetUid = targetUidOf(payload);
    if (targetUid && !(docDirectory?.ownerWindow(targetUid))) {
      // Addressed doc is gone (closed since /docs) or targeting isn't
      // wired on this host. Clean error, never a fallback to a doc the
      // caller didn't name.
      jsonResponse(res, 200, { ok: false, error: 'target-not-found' });
      return;
    }
    const ack = await dispatchToRenderer(payload, windowForInsert(payload));
    // Map error → status code per §4.5.
    if (ack.ok) {
      if (appId) noteSeen(appId);
      // Targeted acks skip the renderer's focused-doc title; the
      // directory knows the addressed doc's name.
      const docTitle =
        ack.docTitle ??
        (targetUid
          ? docDirectory?.listDocs().find((d) => d.uid === targetUid)?.filename ?? undefined
          : undefined);
      // Provenance for the blocks that landed, relayed untouched. Every
      // entry must be one of our tokens: a malformed list is dropped
      // whole, the same all-or-nothing the renderer applies, since a
      // caller can't tell which entry of a short list belongs to which
      // line. Absent stays absent - `sources` is a handle, not a receipt.
      const sources =
        Array.isArray(ack.sources) &&
        ack.sources.length > 0 &&
        ack.sources.every((s) => typeof s === 'string' && s.startsWith(SOURCE_TOKEN_PREFIX))
          ? ack.sources
          : undefined;
      jsonResponse(res, 200, { ok: true, inserted: true, docTitle, sources });
      return;
    }
    if (ack.error === 'no-target-doc' || ack.error === 'doc-readonly') {
      jsonResponse(res, 200, { ok: false, error: ack.error });
      return;
    }
    if (ack.error === 'bad-request') {
      jsonResponse(res, 400, { ok: false, error: 'bad-request' });
      return;
    }
    jsonResponse(res, 500, { ok: false, error: ack.error ?? 'internal' });
    return;
  }

  if (req.method === 'POST' && url === '/jump') {
    let payload: { source?: unknown };
    try {
      payload = JSON.parse(await readRequestBody(req)) as { source?: unknown };
    } catch {
      jsonResponse(res, 400, { ok: false, error: 'bad-request' });
      return;
    }
    if (typeof payload.source !== 'string' || !payload.source) {
      jsonResponse(res, 400, { ok: false, error: 'bad-request' });
      return;
    }
    // Jump is gated by the same per-app decision as insert: a denied app
    // shouldn't be able to seize focus and steer the editor either. One
    // consent covers the app, not the route.
    const appId = requestAppId(req);
    const disposition = consentGate.check(appId);
    if (disposition === 'unidentified') {
      notifyUnidentifiedCaller();
      jsonResponse(res, 200, {
        ok: false,
        error: 'unidentified',
        message:
          'This CardMirror requires apps to identify themselves with an X-App-Id header. Update the sending app.',
      });
      return;
    }
    if (disposition === 'off') {
      jsonResponse(res, 200, { ok: false, error: 'inserts-disabled' });
      return;
    }
    if (disposition === 'deny') {
      jsonResponse(res, 200, { ok: false, error: 'not-allowed' });
      return;
    }
    if (disposition === 'ask') {
      const source = payload.source;
      const queued = consentGate.enqueue(appId!, () => {
        void broadcastJump(source);
      });
      if (queued) {
        jsonResponse(res, 200, { ok: true, jumped: false, pending: 'consent' });
      } else {
        jsonResponse(res, 200, { ok: false, error: 'not-allowed' });
      }
      return;
    }
    let result: { ok: boolean; error?: string; docTitle?: string };
    try {
      result = await broadcastJump(payload.source);
    } catch {
      // Never let an unexpected broadcast failure hang the client.
      jsonResponse(res, 500, { ok: false, error: 'internal' });
      return;
    }
    if (result.ok) {
      if (appId) noteSeen(appId);
      jsonResponse(res, 200, { ok: true });
      return;
    }
    if (result.error === 'bad-request') {
      jsonResponse(res, 400, { ok: false, error: 'bad-request' });
      return;
    }
    jsonResponse(res, 200, {
      ok: false,
      error: result.error,
      ...(result.docTitle ? { docTitle: result.docTitle } : {}),
    });
    return;
  }

  if (req.method === 'POST' && url === '/replace') {
    let bodyText: string;
    try {
      bodyText = await readRequestBody(req, REPLACE_BODY_MAX_BYTES);
    } catch {
      jsonResponse(res, 400, { ok: false, error: 'bad-request' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      jsonResponse(res, 400, { ok: false, error: 'bad-request' });
      return;
    }
    // Optional-chained off a nullable cast so a body of `null` or a bare
    // scalar (both valid JSON) reads as absent fields instead of
    // throwing out of the route and hanging the client on the socket.
    const payload = parsed as { source?: unknown; text?: unknown } | null;
    const source = payload?.source;
    const text = payload?.text;
    if (
      typeof source !== 'string' ||
      // A token that isn't ours can never match a window; refuse it here
      // rather than broadcasting and echoing a forged docTitle back.
      !source.startsWith(SOURCE_TOKEN_PREFIX) ||
      typeof text !== 'string' ||
      text.trim().length === 0 ||
      text.length > REPLACE_TEXT_MAX_CHARS ||
      // One line only: the token names a single line of a cell, and a
      // newline would silently split the anchored range in two. Callers
      // that want structure use /insert.
      /[\r\n]/.test(text)
    ) {
      jsonResponse(res, 400, { ok: false, error: 'bad-request' });
      return;
    }
    // Same per-app decision as insert and jump: rewriting the user's
    // words is at least as consequential as adding to them.
    const appId = requestAppId(req);
    const disposition = consentGate.check(appId);
    if (disposition === 'unidentified') {
      notifyUnidentifiedCaller();
      jsonResponse(res, 200, {
        ok: false,
        error: 'unidentified',
        message:
          'This CardMirror requires apps to identify themselves with an X-App-Id header. Update the sending app.',
      });
      return;
    }
    if (disposition === 'off') {
      jsonResponse(res, 200, { ok: false, error: 'inserts-disabled' });
      return;
    }
    if (disposition === 'deny') {
      jsonResponse(res, 200, { ok: false, error: 'not-allowed' });
      return;
    }
    if (disposition === 'ask') {
      // Queue behind the prompt as /insert does: Allow applies the held
      // replace. `ok:true` reports acceptance for delivery, not that the
      // doc changed - there is no fresh token yet, so the caller keeps
      // the one it has and the edit lands (or is discarded) unattended.
      const queued = consentGate.enqueue(appId!, () => {
        void broadcastReplace(source, text);
      });
      if (queued) {
        jsonResponse(res, 200, { ok: true, pending: 'consent' });
      } else {
        jsonResponse(res, 200, { ok: false, error: 'not-allowed' });
      }
      return;
    }
    let result: { ok: boolean; error?: string; docTitle?: string; source?: string };
    try {
      result = await broadcastReplace(source, text);
    } catch {
      // Never let an unexpected broadcast failure hang the client.
      jsonResponse(res, 500, { ok: false, error: 'internal' });
      return;
    }
    if (result.ok) {
      if (appId) noteSeen(appId);
      jsonResponse(res, 200, { ok: true, source: result.source });
      return;
    }
    if (result.error === 'bad-request') {
      jsonResponse(res, 400, { ok: false, error: 'bad-request' });
      return;
    }
    jsonResponse(res, 200, {
      ok: false,
      error: result.error,
      ...(result.docTitle ? { docTitle: result.docTitle } : {}),
    });
    return;
  }

  if (req.method === 'POST' && url === '/insert-after') {
    let bodyText: string;
    try {
      bodyText = await readRequestBody(req, REPLACE_BODY_MAX_BYTES);
    } catch {
      jsonResponse(res, 400, { ok: false, error: 'bad-request' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      jsonResponse(res, 400, { ok: false, error: 'bad-request' });
      return;
    }
    // Nullable cast for the same reason /replace uses one: a body of
    // `null` or a bare scalar (both valid JSON) must read as absent
    // fields instead of throwing out of the route and hanging the
    // client on the socket.
    const payload = parsed as { source?: unknown; text?: unknown } | null;
    const source = payload?.source;
    const text = payload?.text;
    if (
      typeof source !== 'string' ||
      // A token that isn't ours can never match a window; refuse it here
      // rather than broadcasting and echoing a forged docTitle back.
      !source.startsWith(SOURCE_TOKEN_PREFIX) ||
      typeof text !== 'string' ||
      text.trim().length === 0 ||
      text.length > REPLACE_TEXT_MAX_CHARS ||
      // One line, one block: this route adds a single sibling, and a
      // newline would ask it for a structure the caller never
      // described. Callers that want structure use /insert's roles.
      /[\r\n]/.test(text)
    ) {
      jsonResponse(res, 400, { ok: false, error: 'bad-request' });
      return;
    }
    // The same per-app decision as insert, jump and replace: writing a
    // new line into the user's document is no smaller a step than
    // rewriting one that is already there.
    const appId = requestAppId(req);
    const disposition = consentGate.check(appId);
    if (disposition === 'unidentified') {
      notifyUnidentifiedCaller();
      jsonResponse(res, 200, {
        ok: false,
        error: 'unidentified',
        message:
          'This CardMirror requires apps to identify themselves with an X-App-Id header. Update the sending app.',
      });
      return;
    }
    if (disposition === 'off') {
      jsonResponse(res, 200, { ok: false, error: 'inserts-disabled' });
      return;
    }
    if (disposition === 'deny') {
      jsonResponse(res, 200, { ok: false, error: 'not-allowed' });
      return;
    }
    if (disposition === 'ask') {
      // Queue behind the prompt as /replace does: Allow applies the held
      // insert, and the user's click is the redo. `ok:true` reports
      // acceptance for delivery, never a landed line - and the token the
      // renderer mints for a queued insert has nobody left to go to, so
      // the line lands unaddressed. That is the honest cost of queueing
      // rather than dropping the request.
      const queued = consentGate.enqueue(appId!, () => {
        void broadcastInsertAfter(source, text);
      });
      if (queued) {
        jsonResponse(res, 200, { ok: true, pending: 'consent' });
      } else {
        jsonResponse(res, 200, { ok: false, error: 'not-allowed' });
      }
      return;
    }
    let result: { ok: boolean; error?: string; docTitle?: string; source?: string };
    try {
      result = await broadcastInsertAfter(source, text);
    } catch {
      // Never let an unexpected broadcast failure hang the client.
      jsonResponse(res, 500, { ok: false, error: 'internal' });
      return;
    }
    if (result.ok) {
      if (appId) noteSeen(appId);
      jsonResponse(res, 200, { ok: true, source: result.source });
      return;
    }
    if (result.error === 'bad-request') {
      jsonResponse(res, 400, { ok: false, error: 'bad-request' });
      return;
    }
    jsonResponse(res, 200, {
      ok: false,
      error: result.error,
      ...(result.docTitle ? { docTitle: result.docTitle } : {}),
    });
    return;
  }

  jsonResponse(res, 404, { ok: false, error: 'bad-request' });
}

function tryListen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      const addr = server.address();
      const actualPort = addr && typeof addr === 'object' ? addr.port : port;
      resolve(actualPort);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

export async function startFastPasteBridge(): Promise<void> {
  if (serverState) return;
  installFocusTracking();
  if (!ipcSubscribed) {
    ipcMain.on('external:insert-result', onRendererAck);
    ipcMain.on('external:jump-result', onJumpAck);
    ipcMain.on('external:replace-result', onReplaceAck);
    ipcMain.on('external:insert-after-result', onInsertAfterAck);
    ipcMain.on('external:consent-prompt-result', onConsentPromptAck);
    ipcMain.on('host:sync-external-consent', onConsentSync);
    ipcSubscribed = true;
  }

  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const server = http.createServer((req, res) => {
    void handleRequest(req, res, token);
  });

  let port: number;
  try {
    port = await tryListen(server, PREFERRED_PORT);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      port = await tryListen(server, 0);
    } else {
      // Some other fatal listen error — drop the server and don't
      // write the discovery file. The client will read no file →
      // fall back to keystrokes, which is exactly what we want.
      return;
    }
  }

  try {
    await writeDiscoveryFile(token, port);
  } catch {
    // Can't write discovery file (permission, disk full, …). Bail
    // gracefully — same outcome as not starting the server: the
    // client falls back to its keystroke path.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return;
  }
  serverState = { server, token, port };
}

export async function stopFastPasteBridge(): Promise<void> {
  if (!serverState) {
    // No server, but a stale discovery file may exist from a prior
    // crash — clean it up anyway so the next launch starts fresh.
    await deleteDiscoveryFile();
    return;
  }
  const { server } = serverState;
  serverState = null;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const pending of pendingAcks.values()) {
    clearTimeout(pending.timer);
    pending.resolve({ requestId: '', ok: false, error: 'internal' });
  }
  pendingAcks.clear();
  for (const pending of pendingJumpAcks.values()) {
    clearTimeout(pending.timer);
    pending.resolve({ requestId: '', ok: false, error: 'not-mine' });
  }
  pendingJumpAcks.clear();
  for (const pending of pendingReplaceAcks.values()) {
    clearTimeout(pending.timer);
    pending.resolve({ requestId: '', ok: false, error: 'not-mine' });
  }
  pendingReplaceAcks.clear();
  for (const pending of pendingInsertAfterAcks.values()) {
    clearTimeout(pending.timer);
    // Same reasoning as the ack timeout above: a request in flight at
    // shutdown may have landed its line, so it must not degrade to the
    // retryable `doc-not-open`.
    pending.resolve({ requestId: '', ok: false, error: 'internal' });
  }
  pendingInsertAfterAcks.clear();
  // Drop the IPC subscription so a subsequent `start` re-installs
  // it cleanly. Production only ever calls `start` once per app
  // lifetime, but tests cycle the bridge across describe/it blocks
  // and would otherwise carry a stale subscription that the stub
  // can't see.
  if (ipcSubscribed) {
    const im = ipcMain as unknown as {
      removeListener?: (ch: string, l: (...args: never[]) => void) => void;
    };
    im.removeListener?.('external:insert-result', onRendererAck);
    im.removeListener?.('external:jump-result', onJumpAck);
    im.removeListener?.('external:replace-result', onReplaceAck);
    im.removeListener?.('external:insert-after-result', onInsertAfterAck);
    im.removeListener?.('external:consent-prompt-result', onConsentPromptAck);
    im.removeListener?.('host:sync-external-consent', onConsentSync);
    ipcSubscribed = false;
  }
  await deleteDiscoveryFile();
}

/** Test/diagnostic accessor — returns the running port + token,
 *  or null if the server isn't running. Production code never
 *  needs this; tests use it to issue requests against an
 *  ephemeral port. */
export function getRunningEndpoint(): { port: number; token: string } | null {
  if (!serverState) return null;
  return { port: serverState.port, token: serverState.token };
}
