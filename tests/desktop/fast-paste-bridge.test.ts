// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  sentToRenderer,
  ipcListeners,
  resetElectronStub,
  setMockFocusedWindow,
  setMockAllWindows,
  makeMockWindow,
  emitAppEvent,
} from './_electron-stub.js';
import * as bridge from '../../apps/desktop/src/fast-paste-bridge.js';

const tmpRoot = path.join(os.tmpdir(), `cardmirror-bridge-test-${process.pid}`);

async function fetchJson(opts: {
  method: 'GET' | 'POST';
  path: string;
  port: number;
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** X-App-Id for the consent gate. Defaults to the suite's pre-allowed
   *  'testapp' so route-behavior tests aren't about consent; pass null
   *  to send an unidentified (legacy-shaped) request. */
  appId?: string | null;
}): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  const appId = opts.appId === undefined ? 'testapp' : opts.appId;
  if (appId !== null) headers['x-app-id'] = appId;
  // No keep-alive: undici's global pool can hand a later test a socket
  // the previous test's server.close() already destroyed (Node ≥19
  // closes idle connections), which surfaces as a load-sensitive
  // "TypeError: fetch failed". Each request gets a fresh socket; this
  // also lets afterEach's close() resolve without idle-socket waits.
  headers['connection'] ??= 'close';
  if (opts.token) headers['x-fdp-token'] = opts.token;
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const doFetch = async (): Promise<{ status: number; json: any }> => {
    const res = await fetch(`http://127.0.0.1:${opts.port}${opts.path}`, {
      method: opts.method,
      headers,
      body,
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* tolerate */ }
    return { status: res.status, json };
  };
  try {
    return await doFetch();
  } catch {
    // One retry on connect-level failure only (HTTP error statuses
    // return normally above and still hit the assertions). A loopback
    // server this test just started gets one second chance under
    // parallel-suite load; a real bridge bug fails the retry too.
    await new Promise((r) => setTimeout(r, 50));
    return doFetch();
  }
}


/** Wait until the bridge has forwarded to the renderer — the fixed
 *  20ms sleeps this replaces flaked on loaded CI runners (run
 *  33458582069, 2026-09-01): the HTTP round-trip + dispatch can take
 *  longer than any constant. Polls fast, fails loud at 2s. */
async function untilForwarded(count = 1, channel?: string): Promise<void> {
  const deadline = Date.now() + 2000;
  const matched = (): number =>
    channel ? sentToRenderer.filter((s) => s.channel === channel).length : sentToRenderer.length;
  while (matched() < count) {
    if (Date.now() > deadline) {
      throw new Error(
        `renderer never received forward #${count}${channel ? ` on ${channel}` : ''} (got ${matched()})`,
      );
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

function fireRendererAck(ack: any): void {
  const listeners = ipcListeners.get('external:insert-result') ?? [];
  for (const l of listeners) l(null, ack);
}

/** The renderer -> main half of the replace contract, exactly as
 *  external-replace-host.ts sends it. */
function fireReplaceAck(ack: {
  requestId: string;
  ok: boolean;
  error?: string;
  docTitle?: string;
  source?: string;
}): void {
  const listeners = ipcListeners.get('external:replace-result') ?? [];
  for (const l of listeners) l(null, ack);
}

/** The renderer -> main half of the insert-after contract, exactly as
 *  external-insert-after-host.ts sends it. */
function fireInsertAfterAck(ack: {
  requestId: string;
  ok: boolean;
  error?: string;
  docTitle?: string;
  source?: string;
}): void {
  const listeners = ipcListeners.get('external:insert-after-result') ?? [];
  for (const l of listeners) l(null, ack);
}

/** A cmsrc1 token shaped like the renderer's; docTitle is the only
 *  field main decodes (for the doc-not-open message). */
function sourceToken(docTitle: string, docId = 'd'): string {
  return 'cmsrc1.' + Buffer.from(JSON.stringify({ docId, docTitle })).toString('base64url');
}

/** Push a consent mirror to the gate over the real sync IPC. */
function fireConsentSync(state: { policy: string; apps: Record<string, string> }): void {
  const listeners = ipcListeners.get('host:sync-external-consent') ?? [];
  for (const l of listeners) l(null, state);
}

function fireConsentPromptResult(result: { requestId: string; outcome: string }): void {
  const listeners = ipcListeners.get('external:consent-prompt-result') ?? [];
  for (const l of listeners) l(null, result);
}

describe('fast-paste-bridge', () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = path.join(tmpRoot, `t-${Math.random().toString(36).slice(2, 8)}`);
    await fs.mkdir(userDataDir, { recursive: true });
    resetElectronStub(userDataDir);
    await bridge.startFastPasteBridge();
    // Pre-allow the suite's default app id so route-behavior tests run
    // with consent out of the way; the consent block below manages its
    // own state.
    bridge.resetExternalConsentForTests();
    bridge.resetFocusTrackingForTests();
    fireConsentSync({ policy: 'ask', apps: { testapp: 'allow' } });
  });

  afterEach(async () => {
    await bridge.stopFastPasteBridge();
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  });

  it('writes discovery file with port + token + appVersion on start', async () => {
    const ep = bridge.getRunningEndpoint();
    expect(ep).not.toBeNull();
    const data = JSON.parse(
      await fs.readFile(path.join(userDataDir, 'fast-paste-bridge.json'), 'utf-8'),
    );
    expect(data).toMatchObject({
      app: 'cardmirror',
      schema: 2,
      appVersion: 'TEST-1.2.3',
      port: ep!.port,
      token: ep!.token,
    });
    expect(typeof data.pid).toBe('number');
  });

  it('GET /ping with valid token returns full shape', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const r = await fetchJson({ method: 'GET', path: '/ping', port: ep.port, token: ep.token });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      ok: true,
      app: 'cardmirror',
      appVersion: 'TEST-1.2.3',
      schema: 2,
      hasActiveDoc: true,
    });
  });

  it('GET /ping with no token → 403', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const r = await fetchJson({ method: 'GET', path: '/ping', port: ep.port });
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('GET /ping with wrong token → 403', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const r = await fetchJson({ method: 'GET', path: '/ping', port: ep.port, token: 'wrong' });
    expect(r.status).toBe(403);
  });

  it('rejects requests carrying an Origin header (DNS-rebinding guard)', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const r = await fetchJson({
      method: 'GET',
      path: '/ping',
      port: ep.port,
      token: ep.token,
      headers: { origin: 'http://evil.example.com' },
    });
    expect(r.status).toBe(403);
  });

  it('rejects requests carrying a Referer header', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const r = await fetchJson({
      method: 'GET',
      path: '/ping',
      port: ep.port,
      token: ep.token,
      headers: { referer: 'http://evil.example.com/page' },
    });
    expect(r.status).toBe(403);
  });

  it('POST /insert dispatches to renderer and resolves with docTitle on ok ack', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const inserted = fetchJson({
      method: 'POST',
      path: '/insert',
      port: ep.port,
      token: ep.token,
      body: { text: 'hello', role: 'card', newParagraph: true },
    });
    await untilForwarded();
    expect(sentToRenderer).toHaveLength(1);
    const sent = sentToRenderer[0]!;
    expect(sent.channel).toBe('external:insert-text');
    expect(sent.payload).toMatchObject({ text: 'hello', role: 'card', newParagraph: true });
    expect(typeof sent.payload.requestId).toBe('string');
    fireRendererAck({ requestId: sent.payload.requestId, ok: true, docTitle: 'mydoc.cmir' });
    const r = await inserted;
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, inserted: true, docTitle: 'mydoc.cmir' });
  });

  it('POST /insert forwards a valid html payload to the renderer', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const inserted = fetchJson({
      method: 'POST',
      path: '/insert',
      port: ep.port,
      token: ep.token,
      body: {
        text: 'fallback text',
        role: 'card',
        newParagraph: true,
        html: '<p>rich <strong>content</strong></p>',
      },
    });
    await untilForwarded();
    const sent = sentToRenderer[0]!;
    // Both travel: html for a rich-aware renderer, text as the fallback
    // an older renderer (or unusable html) renders.
    expect(sent.payload).toMatchObject({
      text: 'fallback text',
      html: '<p>rich <strong>content</strong></p>',
    });
    fireRendererAck({ requestId: sent.payload.requestId, ok: true });
    await inserted;
  });

  it('POST /insert drops an off-shape or oversized html field (payload still delivers)', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const inserted = fetchJson({
      method: 'POST',
      path: '/insert',
      port: ep.port,
      token: ep.token,
      body: { text: 'plain', newParagraph: true, html: 12345 },
    });
    await untilForwarded();
    const sent = sentToRenderer[0]!;
    expect(sent.payload.text).toBe('plain');
    expect('html' in sent.payload).toBe(false);
    fireRendererAck({ requestId: sent.payload.requestId, ok: true });
    await inserted;
  });

  it('POST /insert relays the renderer\'s provenance tokens in order', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const inserted = fetchJson({
      method: 'POST', path: '/insert', port: ep.port, token: ep.token,
      body: { text: 'one\ntwo', role: 'analytic', newParagraph: true },
    });
    await new Promise((r) => setTimeout(r, 20));
    const sources = [sourceToken('mydoc.cmir', 'd1'), sourceToken('mydoc.cmir', 'd2')];
    fireRendererAck({
      requestId: sentToRenderer[0]!.payload.requestId,
      ok: true,
      docTitle: 'mydoc.cmir',
      sources,
    });
    const r = await inserted;
    // Untouched and in order: main can't tell which token names which
    // line, so it relays the list or nothing.
    expect(r.json).toEqual({ ok: true, inserted: true, docTitle: 'mydoc.cmir', sources });
  });

  it('POST /insert drops a provenance list that is not ours', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const inserted = fetchJson({
      method: 'POST', path: '/insert', port: ep.port, token: ep.token,
      body: { text: 'one', role: 'analytic', newParagraph: true },
    });
    await new Promise((r) => setTimeout(r, 20));
    fireRendererAck({
      requestId: sentToRenderer[0]!.payload.requestId,
      ok: true,
      sources: ['not-a-cardmirror-token'],
    });
    // The text landed, so this is still a success - just one the caller
    // gets no handle from.
    expect((await inserted).json).toEqual({ ok: true, inserted: true });
  });

  it('POST /insert: no-target-doc ack → 200 ok:false', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const inserted = fetchJson({
      method: 'POST', path: '/insert', port: ep.port, token: ep.token,
      body: { text: 'X', role: 'card', newParagraph: true },
    });
    await untilForwarded();
    fireRendererAck({ requestId: sentToRenderer[0]!.payload.requestId, ok: false, error: 'no-target-doc' });
    const r = await inserted;
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: false, error: 'no-target-doc' });
  });

  it('POST /insert: doc-readonly ack → 200 ok:false', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const inserted = fetchJson({
      method: 'POST', path: '/insert', port: ep.port, token: ep.token,
      body: { text: 'X', role: 'card', newParagraph: true },
    });
    await untilForwarded();
    fireRendererAck({ requestId: sentToRenderer[0]!.payload.requestId, ok: false, error: 'doc-readonly' });
    const r = await inserted;
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: false, error: 'doc-readonly' });
  });

  it('POST /insert: internal ack → 500', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const inserted = fetchJson({
      method: 'POST', path: '/insert', port: ep.port, token: ep.token,
      body: { text: 'X', role: 'card', newParagraph: true },
    });
    await untilForwarded();
    fireRendererAck({ requestId: sentToRenderer[0]!.payload.requestId, ok: false, error: 'internal' });
    const r = await inserted;
    expect(r.status).toBe(500);
  });

  it('POST /insert with non-string text → 400 bad-request', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const r = await fetchJson({
      method: 'POST', path: '/insert', port: ep.port, token: ep.token,
      body: { role: 'card', newParagraph: true },
    });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ ok: false, error: 'bad-request' });
  });

  it('POST /insert with malformed JSON → 400', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const res = await fetch(`http://127.0.0.1:${ep.port}/insert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fdp-token': ep.token },
      body: '{ broken',
    });
    expect(res.status).toBe(400);
  });

  it('unknown route → 404', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const r = await fetchJson({ method: 'GET', path: '/banana', port: ep.port, token: ep.token });
    expect(r.status).toBe(404);
  });

  it('unknown role degrades to "card" (per §10)', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const inserted = fetchJson({
      method: 'POST', path: '/insert', port: ep.port, token: ep.token,
      body: { text: 'X', role: 'mystery', newParagraph: true },
    });
    await untilForwarded();
    expect(sentToRenderer[0]!.payload.role).toBe('card');
    fireRendererAck({ requestId: sentToRenderer[0]!.payload.requestId, ok: true });
    await inserted;
  });

  it.each(['pocket', 'hat', 'block', 'tag', 'analytic', 'body'])(
    'heading role "%s" reaches the renderer unflattened',
    async (role) => {
      const ep = bridge.getRunningEndpoint()!;
      const inserted = fetchJson({
        method: 'POST', path: '/insert', port: ep.port, token: ep.token,
        body: { text: 'X', role, newParagraph: true },
      });
      await untilForwarded();
      expect(sentToRenderer[0]!.payload.role).toBe(role);
      fireRendererAck({ requestId: sentToRenderer[0]!.payload.requestId, ok: true });
      await inserted;
    },
  );

  it('no focused window and no focus history → no-target-doc, no round-trip', async () => {
    setMockFocusedWindow(null);
    const ep = bridge.getRunningEndpoint()!;
    const r = await fetchJson({
      method: 'POST', path: '/insert', port: ep.port, token: ep.token,
      body: { text: 'X', role: 'card', newParagraph: true },
    });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: false, error: 'no-target-doc' });
    expect(sentToRenderer).toHaveLength(0);
  });

  it('background app → insert targets the most recently focused doc window', async () => {
    // ebb's send style: it POSTs while ebb itself holds OS focus, so
    // getFocusedWindow() is null — the insert must land in the window
    // the user most recently worked in, never an arbitrary one. (FDP
    // never reaches this path: it activates its picked window first.)
    const docWin = makeMockWindow();
    emitAppEvent('browser-window-focus', docWin);
    // A later timer-popout focus must NOT steal the target.
    emitAppEvent('browser-window-focus', makeMockWindow({ url: 'http://localhost/timer.html' }));
    setMockFocusedWindow(null);
    setMockAllWindows([docWin]);
    const ep = bridge.getRunningEndpoint()!;
    const inserted = fetchJson({
      method: 'POST', path: '/insert', port: ep.port, token: ep.token,
      body: { text: 'from background', role: 'card', newParagraph: true },
    });
    await untilForwarded();
    expect(sentToRenderer).toHaveLength(1);
    expect(sentToRenderer[0]!.channel).toBe('external:insert-text');
    fireRendererAck({ requestId: sentToRenderer[0]!.payload.requestId, ok: true });
    expect((await inserted).json.ok).toBe(true);
  });

  it('stop deletes the discovery file', async () => {
    const file = path.join(userDataDir, 'fast-paste-bridge.json');
    await fs.access(file);
    await bridge.stopFastPasteBridge();
    await expect(fs.access(file)).rejects.toBeTruthy();
    // Restart so afterEach can stop a server cleanly.
    await bridge.startFastPasteBridge();
  });
  describe('POST /jump', () => {
    it('rejects a missing token', async () => {
      const ep = bridge.getRunningEndpoint()!;
      const r = await fetchJson({
        method: 'POST', path: '/jump', port: ep.port,
        body: { source: 'x' },
      });
      expect(r.status).toBe(403);
    });

    it('accepts the token in X-Bridge-Token', async () => {
      const ep = bridge.getRunningEndpoint()!;
      const r = await fetchJson({
        method: 'GET', path: '/ping', port: ep.port,
        headers: { 'x-bridge-token': ep.token },
      });
      expect(r.status).toBe(200);
      expect((r.json as { schema: number }).schema).toBe(2);
    });

    it('400s on a body without a source string', async () => {
      const ep = bridge.getRunningEndpoint()!;
      const r = await fetchJson({
        method: 'POST', path: '/jump', port: ep.port, token: ep.token,
        body: {},
      });
      expect(r.status).toBe(400);
    });

    it('reports doc-not-open with the docTitle when no window matches', async () => {
      // The stub's default window would swallow the jump broadcast
      // and run out the ack timeout; clear it so getAllWindows()
      // returns [] and the no-window path resolves immediately.
      setMockFocusedWindow(null);
      const ep = bridge.getRunningEndpoint()!;
      const source =
        'cmsrc1.' +
        Buffer.from(JSON.stringify({ docId: 'd', docTitle: 'AT Cap K.docx' })).toString('base64url');
      const r = await fetchJson({
        method: 'POST', path: '/jump', port: ep.port, token: ep.token,
        body: { source },
      });
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ ok: false, error: 'doc-not-open', docTitle: 'AT Cap K.docx' });
    });

    it('400s a source without the cmsrc1 prefix, with no broadcast', async () => {
      const ep = bridge.getRunningEndpoint()!;
      const source =
        'x.' + Buffer.from(JSON.stringify({ docTitle: 'forged' })).toString('base64url');
      const r = await fetchJson({
        method: 'POST', path: '/jump', port: ep.port, token: ep.token,
        body: { source },
      });
      expect(r.status).toBe(400);
      expect(r.json).toEqual({ ok: false, error: 'bad-request' });
      expect(r.json.docTitle).toBeUndefined();
      // The bad prefix short-circuits before any window is asked to jump.
      expect(sentToRenderer.some((s) => s.channel === 'external:jump')).toBe(false);
    });

    it('answers even when a window is destroyed mid-broadcast', async () => {
      // Only window in the broadcast throws on send (render process gone);
      // the dispatch guard must resolve not-mine instead of rejecting and
      // hanging the /jump route.
      setMockAllWindows([makeMockWindow({ sendThrows: true })]);
      const ep = bridge.getRunningEndpoint()!;
      const source =
        'cmsrc1.' +
        Buffer.from(JSON.stringify({ docId: 'd', docTitle: 'Gone.docx' })).toString('base64url');
      const r = await fetchJson({
        method: 'POST', path: '/jump', port: ep.port, token: ep.token,
        body: { source },
      });
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ ok: false, error: 'doc-not-open', docTitle: 'Gone.docx' });
    });

    it('restores a minimized window that acks ok', async () => {
      const win = makeMockWindow({ minimized: true });
      setMockAllWindows([win]);
      const ep = bridge.getRunningEndpoint()!;
      const source =
        'cmsrc1.' +
        Buffer.from(JSON.stringify({ docId: 'd', docTitle: 'Min.docx' })).toString('base64url');
      const jumped = fetchJson({
        method: 'POST', path: '/jump', port: ep.port, token: ep.token,
        body: { source },
      });
      await untilForwarded();
      const sent = sentToRenderer.find((s) => s.channel === 'external:jump')!;
      const listeners = ipcListeners.get('external:jump-result') ?? [];
      for (const l of listeners) l(null, { requestId: sent.payload.requestId, ok: true });
      const r = await jumped;
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ ok: true });
      expect(win.__restored).toBe(true);
    });
  });

  // These tests use real waits, not fake timers: the request crosses a
  // live loopback socket into a real http.Server, so the clock the
  // route waits on is the OS clock. The 20ms waits let the in-flight
  // request reach the stub renderer before the ack is fired (the
  // pattern the /insert and /jump tests above already use), and the
  // no-ack test deliberately runs out the real 1200ms ack timeout.
  describe('POST /replace', () => {
    const token = sourceToken('AT Cap K.docx');

    const post = (body: unknown, port: number, fdpToken: string) =>
      fetchJson({ method: 'POST', path: '/replace', port, token: fdpToken, body });

    const replaceSent = () => sentToRenderer.filter((s) => s.channel === 'external:replace-text');

    it('rejects a missing token', async () => {
      const ep = bridge.getRunningEndpoint()!;
      const r = await fetchJson({
        method: 'POST', path: '/replace', port: ep.port,
        body: { source: token, text: 'hi' },
      });
      expect(r.status).toBe(403);
      expect(r.json).toEqual({ ok: false, error: 'unauthorized' });
    });

    it('rewrites the token and answers with the fresh token the renderer minted', async () => {
      const win = makeMockWindow();
      setMockAllWindows([win]);
      const ep = bridge.getRunningEndpoint()!;
      const replaced = post({ source: token, text: 'The plan causes poverty.' }, ep.port, ep.token);
      await new Promise((r) => setTimeout(r, 20));
      const sent = replaceSent();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.payload).toMatchObject({
        source: token,
        text: 'The plan causes poverty.',
      });
      expect(typeof sent[0]!.payload.requestId).toBe('string');
      // A real re-mint differs from the token that was sent: its anchor
      // quote names the NEW text. Distinct on purpose, so this can't
      // pass on a route that merely echoes what it was given.
      const fresh =
        'cmsrc1.' +
        Buffer.from(
          JSON.stringify({ docId: 'd', docTitle: 'AT Cap K.docx', quote: 'The plan causes poverty.' }),
        ).toString('base64url');
      expect(fresh).not.toBe(token);
      fireReplaceAck({ requestId: sent[0]!.payload.requestId, ok: true, source: fresh });
      const r = await replaced;
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ ok: true, source: fresh });
    });

    it('never shows, focuses or restores the window that took the edit', async () => {
      // The reason /replace exists instead of a /jump + /insert pair:
      // ebb calls it on every settled keystroke, so a window that comes
      // forward here would fight the reader for their own screen. A
      // minimized window stays minimized.
      const win = makeMockWindow({ minimized: true });
      setMockAllWindows([win]);
      const ep = bridge.getRunningEndpoint()!;
      const replaced = post({ source: token, text: 'edited' }, ep.port, ep.token);
      await new Promise((r) => setTimeout(r, 20));
      fireReplaceAck({
        requestId: replaceSent()[0]!.payload.requestId,
        ok: true,
        source: sourceToken('AT Cap K.docx'),
      });
      expect((await replaced).json.ok).toBe(true);
      expect(win.__shown).toBe(false);
      expect(win.__focused).toBe(false);
      expect(win.__restored).toBe(false);
    });

    it.each([
      ['a null body', null],
      ['a missing source', { text: 'hi' }],
      ['a source without the cmsrc1 prefix', { source: 'x.abc', text: 'hi' }],
      ['a non-string text', { source: sourceToken('d.docx'), text: 42 }],
      ['empty text', { source: sourceToken('d.docx'), text: '' }],
      ['whitespace-only text', { source: sourceToken('d.docx'), text: '  \t ' }],
      ['text with a newline', { source: sourceToken('d.docx'), text: 'one\ntwo' }],
      ['text with a carriage return', { source: sourceToken('d.docx'), text: 'one\rtwo' }],
      ['text over the cap', { source: sourceToken('d.docx'), text: 'x'.repeat(8 * 1024 + 1) }],
    ])('400s %s and dispatches nothing', async (_label, body) => {
      const ep = bridge.getRunningEndpoint()!;
      const r = await post(body, ep.port, ep.token);
      expect(r.status).toBe(400);
      expect(r.json).toEqual({ ok: false, error: 'bad-request' });
      expect(replaceSent()).toHaveLength(0);
    });

    it('400s a malformed body', async () => {
      const ep = bridge.getRunningEndpoint()!;
      const res = await fetch(`http://127.0.0.1:${ep.port}/replace`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-fdp-token': ep.token,
          'x-app-id': 'testapp',
          connection: 'close',
        },
        body: '{ broken',
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: 'bad-request' });
    });

    it('all not-mine → doc-not-open with the docTitle from the token', async () => {
      setMockAllWindows([makeMockWindow(), makeMockWindow()]);
      const ep = bridge.getRunningEndpoint()!;
      const replaced = post({ source: token, text: 'edited' }, ep.port, ep.token);
      await new Promise((r) => setTimeout(r, 20));
      for (const s of replaceSent()) {
        fireReplaceAck({ requestId: s.payload.requestId, ok: false, error: 'not-mine' });
      }
      const r = await replaced;
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ ok: false, error: 'doc-not-open', docTitle: 'AT Cap K.docx' });
    });

    it.each(['not-found', 'doc-readonly', 'body-text'])('passes a %s ack through', async (error) => {
      setMockAllWindows([makeMockWindow()]);
      const ep = bridge.getRunningEndpoint()!;
      const replaced = post({ source: token, text: 'edited' }, ep.port, ep.token);
      await new Promise((r) => setTimeout(r, 20));
      fireReplaceAck({ requestId: replaceSent()[0]!.payload.requestId, ok: false, error });
      const r = await replaced;
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ ok: false, error });
    });

    it('a complaining window beats a silent one', async () => {
      // One window holds the doc and reports it read-only; the other
      // simply isn't the holder. The real complaint must win rather
      // than degrading to doc-not-open.
      setMockAllWindows([makeMockWindow(), makeMockWindow()]);
      const ep = bridge.getRunningEndpoint()!;
      const replaced = post({ source: token, text: 'edited' }, ep.port, ep.token);
      await new Promise((r) => setTimeout(r, 20));
      const sent = replaceSent();
      fireReplaceAck({ requestId: sent[0]!.payload.requestId, ok: false, error: 'not-mine' });
      fireReplaceAck({ requestId: sent[1]!.payload.requestId, ok: false, error: 'doc-readonly' });
      expect((await replaced).json).toEqual({ ok: false, error: 'doc-readonly' });
    });

    it('body-text beats another window not-found', async () => {
      // A window that holds the doc and refuses the target has answered
      // about that target; another window's not-found is the absence of
      // an answer, and a caller told "not-found" would re-anchor and try
      // again against card body text forever.
      setMockAllWindows([makeMockWindow(), makeMockWindow()]);
      const ep = bridge.getRunningEndpoint()!;
      const replaced = post({ source: token, text: 'edited' }, ep.port, ep.token);
      await new Promise((r) => setTimeout(r, 20));
      const sent = replaceSent();
      fireReplaceAck({ requestId: sent[0]!.payload.requestId, ok: false, error: 'not-found' });
      fireReplaceAck({ requestId: sent[1]!.payload.requestId, ok: false, error: 'body-text' });
      expect((await replaced).json).toEqual({ ok: false, error: 'body-text' });
    });

    it('an ok ack with no fresh token is internal, never a bare success', async () => {
      // Without a re-mint the caller's stored token still anchors the
      // pre-edit text, so exactly one edit per cell would ever land.
      setMockAllWindows([makeMockWindow()]);
      const ep = bridge.getRunningEndpoint()!;
      const replaced = post({ source: token, text: 'edited' }, ep.port, ep.token);
      await new Promise((r) => setTimeout(r, 20));
      fireReplaceAck({ requestId: replaceSent()[0]!.payload.requestId, ok: true });
      const r = await replaced;
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ ok: false, error: 'internal' });
    });

    it('answers doc-not-open when no window ever acks', async () => {
      // The ack timeout, not the socket, ends this request: a silent
      // renderer must never hang the sending app's edit loop.
      setMockAllWindows([makeMockWindow()]);
      const ep = bridge.getRunningEndpoint()!;
      const r = await post({ source: sourceToken('Silent.docx'), text: 'edited' }, ep.port, ep.token);
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ ok: false, error: 'doc-not-open', docTitle: 'Silent.docx' });
    });

    it('skips the timer pop-out, which has no replace listener', async () => {
      const docWin = makeMockWindow();
      setMockAllWindows([docWin, makeMockWindow({ url: 'http://localhost/timer.html' })]);
      const ep = bridge.getRunningEndpoint()!;
      const replaced = post({ source: token, text: 'edited' }, ep.port, ep.token);
      await new Promise((r) => setTimeout(r, 20));
      expect(replaceSent()).toHaveLength(1);
      fireReplaceAck({
        requestId: replaceSent()[0]!.payload.requestId,
        ok: true,
        source: sourceToken('AT Cap K.docx'),
      });
      expect((await replaced).json.ok).toBe(true);
    });
  });

  // Same real-clock caveat as the /replace block above: the request
  // crosses a live loopback socket, so the 20ms waits let it reach the
  // stub renderer before the ack fires, and the no-ack test runs out the
  // real 1200ms timeout.
  describe('POST /insert-after', () => {
    const token = sourceToken('AT Cap K.docx');

    const post = (body: unknown, port: number, fdpToken: string) =>
      fetchJson({ method: 'POST', path: '/insert-after', port, token: fdpToken, body });

    const insertAfterSent = () =>
      sentToRenderer.filter((s) => s.channel === 'external:insert-after');

    it('rejects a missing token', async () => {
      const ep = bridge.getRunningEndpoint()!;
      const r = await fetchJson({
        method: 'POST', path: '/insert-after', port: ep.port,
        body: { source: token, text: 'hi' },
      });
      expect(r.status).toBe(403);
      expect(r.json).toEqual({ ok: false, error: 'unauthorized' });
    });

    it('answers with the token the renderer minted for the new line', async () => {
      const win = makeMockWindow();
      setMockAllWindows([win]);
      const ep = bridge.getRunningEndpoint()!;
      const added = post({ source: token, text: 'And a second reason.' }, ep.port, ep.token);
      await new Promise((r) => setTimeout(r, 20));
      const sent = insertAfterSent();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.payload).toMatchObject({ source: token, text: 'And a second reason.' });
      expect(typeof sent[0]!.payload.requestId).toBe('string');
      // The reply names a line that did not exist when the request was
      // sent, so it can never be the token that was sent.
      const minted =
        'cmsrc1.' +
        Buffer.from(
          JSON.stringify({ docId: 'd', docTitle: 'AT Cap K.docx', quote: 'And a second reason.' }),
        ).toString('base64url');
      expect(minted).not.toBe(token);
      fireInsertAfterAck({ requestId: sent[0]!.payload.requestId, ok: true, source: minted });
      const r = await added;
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ ok: true, source: minted });
    });

    it('never shows, focuses or restores the window that took the line', async () => {
      // Silent for the same reason /replace is: the flowing app calls
      // this while its user types, and a window coming forward per line
      // would fight the reader for their own screen.
      const win = makeMockWindow({ minimized: true });
      setMockAllWindows([win]);
      const ep = bridge.getRunningEndpoint()!;
      const added = post({ source: token, text: 'added line' }, ep.port, ep.token);
      await new Promise((r) => setTimeout(r, 20));
      fireInsertAfterAck({
        requestId: insertAfterSent()[0]!.payload.requestId,
        ok: true,
        source: sourceToken('AT Cap K.docx'),
      });
      expect((await added).json.ok).toBe(true);
      expect(win.__shown).toBe(false);
      expect(win.__focused).toBe(false);
      expect(win.__restored).toBe(false);
    });

    it.each([
      ['a null body', null],
      ['a missing source', { text: 'hi' }],
      ['a source without the cmsrc1 prefix', { source: 'x.abc', text: 'hi' }],
      ['a non-string text', { source: sourceToken('d.docx'), text: 42 }],
      ['empty text', { source: sourceToken('d.docx'), text: '' }],
      ['whitespace-only text', { source: sourceToken('d.docx'), text: '  \t ' }],
      ['text with a newline', { source: sourceToken('d.docx'), text: 'one\ntwo' }],
      ['text with a carriage return', { source: sourceToken('d.docx'), text: 'one\rtwo' }],
      ['text over the cap', { source: sourceToken('d.docx'), text: 'x'.repeat(8 * 1024 + 1) }],
    ])('400s %s and dispatches nothing', async (_label, body) => {
      const ep = bridge.getRunningEndpoint()!;
      const r = await post(body, ep.port, ep.token);
      expect(r.status).toBe(400);
      expect(r.json).toEqual({ ok: false, error: 'bad-request' });
      expect(insertAfterSent()).toHaveLength(0);
    });

    it('400s a malformed body', async () => {
      const ep = bridge.getRunningEndpoint()!;
      const res = await fetch(`http://127.0.0.1:${ep.port}/insert-after`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-fdp-token': ep.token,
          'x-app-id': 'testapp',
          connection: 'close',
        },
        body: '{ broken',
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: 'bad-request' });
    });

    it('all not-mine → doc-not-open with the docTitle from the token', async () => {
      setMockAllWindows([makeMockWindow(), makeMockWindow()]);
      const ep = bridge.getRunningEndpoint()!;
      const added = post({ source: token, text: 'added line' }, ep.port, ep.token);
      await new Promise((r) => setTimeout(r, 20));
      for (const s of insertAfterSent()) {
        fireInsertAfterAck({ requestId: s.payload.requestId, ok: false, error: 'not-mine' });
      }
      const r = await added;
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ ok: false, error: 'doc-not-open', docTitle: 'AT Cap K.docx' });
    });

    it.each(['not-found', 'doc-readonly', 'body-text'])('passes a %s ack through', async (error) => {
      setMockAllWindows([makeMockWindow()]);
      const ep = bridge.getRunningEndpoint()!;
      const added = post({ source: token, text: 'added line' }, ep.port, ep.token);
      await new Promise((r) => setTimeout(r, 20));
      fireInsertAfterAck({ requestId: insertAfterSent()[0]!.payload.requestId, ok: false, error });
      const r = await added;
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ ok: false, error });
    });

    it('an ok ack with no token is internal, never a bare success', async () => {
      // The line is in the document and nothing names it. A caller told
      // `ok` would record an item it can never edit, jump to or insert
      // after again.
      setMockAllWindows([makeMockWindow()]);
      const ep = bridge.getRunningEndpoint()!;
      const added = post({ source: token, text: 'added line' }, ep.port, ep.token);
      await new Promise((r) => setTimeout(r, 20));
      fireInsertAfterAck({ requestId: insertAfterSent()[0]!.payload.requestId, ok: true });
      const r = await added;
      expect(r.json).toEqual({ ok: false, error: 'internal' });
    });

    it("an internal ack outranks another window's not-found", async () => {
      // internal means the line may have landed unnamed; not-found means
      // nothing happened and invites a retry. Reporting the retryable
      // one would put a second copy of the line in the document.
      setMockAllWindows([makeMockWindow(), makeMockWindow()]);
      const ep = bridge.getRunningEndpoint()!;
      const added = post({ source: token, text: 'added line' }, ep.port, ep.token);
      await new Promise((r) => setTimeout(r, 20));
      const sent = insertAfterSent();
      fireInsertAfterAck({ requestId: sent[0]!.payload.requestId, ok: false, error: 'not-found' });
      fireInsertAfterAck({ requestId: sent[1]!.payload.requestId, ok: false, error: 'internal' });
      expect((await added).json).toEqual({ ok: false, error: 'internal' });
    });

    it('answers internal, not doc-not-open, when no window ever acks', async () => {
      // The ack timeout, not the socket, ends this request: a silent
      // renderer must never hang the sending app. What it ends AS is the
      // point here - a window that went quiet may hold the doc and have
      // inserted the line, and doc-not-open is a definite refusal the
      // caller would retry, duplicating the line. /replace answers
      // doc-not-open in this same case, and is right to: a retried
      // replace still leaves one node.
      setMockAllWindows([makeMockWindow()]);
      const ep = bridge.getRunningEndpoint()!;
      const r = await post({ source: sourceToken('Silent.docx'), text: 'added' }, ep.port, ep.token);
      expect(r.json).toEqual({ ok: false, error: 'internal' });
    });
  });
});

describe('external-app consent (identity gate)', () => {
  const sent = (channel: string) => sentToRenderer.filter((s) => s.channel === channel);
  let consentDataDir: string;

  beforeEach(async () => {
    consentDataDir = path.join(tmpRoot, `c-${Math.random().toString(36).slice(2, 8)}`);
    await fs.mkdir(consentDataDir, { recursive: true });
    resetElectronStub(consentDataDir);
    await bridge.startFastPasteBridge();
    bridge.resetExternalConsentForTests();
    bridge.resetFocusTrackingForTests();
    fireConsentSync({ policy: 'ask', apps: { testapp: 'allow' } });
  });

  afterEach(async () => {
    await bridge.stopFastPasteBridge();
    await fs.rm(consentDataDir, { recursive: true, force: true }).catch(() => {});
  });

  it('unidentified insert → rejected with guidance + a renderer note, rate-limited', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const r = await fetchJson({
      method: 'POST', path: '/insert', port: ep.port, token: ep.token, appId: null,
      body: { text: 'X', role: 'card', newParagraph: true },
    });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toBe('unidentified');
    expect(r.json.message).toContain('X-App-Id');
    expect(sent('external:insert-text')).toHaveLength(0);
    expect(sent('external:consent-note')).toEqual([
      expect.objectContaining({ payload: { kind: 'unidentified' } }),
    ]);
    // Second knock inside the rate-limit window: rejected again, no new note.
    await fetchJson({
      method: 'POST', path: '/insert', port: ep.port, token: ep.token, appId: null,
      body: { text: 'X', role: 'card', newParagraph: true },
    });
    expect(sent('external:consent-note')).toHaveLength(1);
  });

  it("policy 'open': an anonymous legacy sender inserts as before the gate", async () => {
    fireConsentSync({ policy: 'open', apps: {} });
    const ep = bridge.getRunningEndpoint()!;
    const inserted = fetchJson({
      method: 'POST', path: '/insert', port: ep.port, token: ep.token, appId: null,
      body: { text: 'legacy hello', role: 'card', newParagraph: true },
    });
    await untilForwarded();
    const inserts = sent('external:insert-text');
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.payload.text).toBe('legacy hello');
    fireRendererAck({ requestId: inserts[0]!.payload.requestId, ok: true, docTitle: 'doc.cmir' });
    const r = await inserted;
    expect(r.json).toEqual({ ok: true, inserted: true, docTitle: 'doc.cmir' });
    expect(sent('external:consent-note')).toHaveLength(0); // no toast, no prompt
  });

  it('a malformed X-App-Id is unidentified, not a fresh identity', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const r = await fetchJson({
      method: 'POST', path: '/insert', port: ep.port, token: ep.token, appId: 'NOT VALID!',
      body: { text: 'X', role: 'card', newParagraph: true },
    });
    expect(r.json.error).toBe('unidentified');
  });

  it('master toggle off → inserts-disabled on both routes', async () => {
    fireConsentSync({ policy: 'off', apps: { testapp: 'allow' } });
    const ep = bridge.getRunningEndpoint()!;
    const insert = await fetchJson({
      method: 'POST', path: '/insert', port: ep.port, token: ep.token,
      body: { text: 'X', role: 'card', newParagraph: true },
    });
    expect(insert.json).toEqual({ ok: false, error: 'inserts-disabled' });
    const jump = await fetchJson({
      method: 'POST', path: '/jump', port: ep.port, token: ep.token,
      body: { source: 'cmsrc1.abc' },
    });
    expect(jump.json).toEqual({ ok: false, error: 'inserts-disabled' });
    expect(sent('external:insert-text')).toHaveLength(0);
  });

  it('a denied app → not-allowed on both routes', async () => {
    fireConsentSync({ policy: 'ask', apps: { testapp: 'deny' } });
    const ep = bridge.getRunningEndpoint()!;
    const insert = await fetchJson({
      method: 'POST', path: '/insert', port: ep.port, token: ep.token,
      body: { text: 'X', role: 'card', newParagraph: true },
    });
    expect(insert.json).toEqual({ ok: false, error: 'not-allowed' });
    const jump = await fetchJson({
      method: 'POST', path: '/jump', port: ep.port, token: ep.token,
      body: { source: 'cmsrc1.abc' },
    });
    expect(jump.json).toEqual({ ok: false, error: 'not-allowed' });
  });

  it('first contact queues, prompts, and Allow applies the held insert', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const r = await fetchJson({
      method: 'POST', path: '/insert', port: ep.port, token: ep.token, appId: 'newapp',
      body: { text: 'held text', role: 'card', newParagraph: true },
    });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, inserted: false, pending: 'consent' });
    expect(sent('external:insert-text')).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const prompts = sent('external:consent-prompt');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.payload.appId).toBe('newapp');

    fireConsentPromptResult({ requestId: prompts[0]!.payload.requestId, outcome: 'allow-always' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const inserts = sent('external:insert-text');
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.payload.text).toBe('held text');
    fireRendererAck({ requestId: inserts[0]!.payload.requestId, ok: true });

    // Remembered optimistically: the next request flows straight through.
    const again = fetchJson({
      method: 'POST', path: '/insert', port: ep.port, token: ep.token, appId: 'newapp',
      body: { text: 'direct', role: 'card', newParagraph: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const direct = sent('external:insert-text');
    expect(direct).toHaveLength(2);
    fireRendererAck({ requestId: direct[1]!.payload.requestId, ok: true });
    expect((await again).json.ok).toBe(true);
  });

  it('a queued heading insert answers pending with no provenance', async () => {
    // Nothing has happened yet, so there is nothing to name — and the
    // tokens the renderer mints when the user's Allow replays this have
    // no reply left to travel on. The caller learns it holds no handle.
    const ep = bridge.getRunningEndpoint()!;
    const r = await fetchJson({
      method: 'POST', path: '/insert', port: ep.port, token: ep.token, appId: 'newapp',
      body: { text: 'held analytic', role: 'analytic', newParagraph: true },
    });
    expect(r.json).toEqual({ ok: true, inserted: false, pending: 'consent' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const prompt = sent('external:consent-prompt')[0]!;
    fireConsentPromptResult({ requestId: prompt.payload.requestId, outcome: 'allow-once' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The replay does reach the renderer; its ack (tokens and all) has
    // nowhere to go, and the caller was never told otherwise.
    const inserts = sent('external:insert-text');
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.payload.role).toBe('analytic');
  });

  it('Deny while pending discards the held insert and sticks', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const r = await fetchJson({
      method: 'POST', path: '/insert', port: ep.port, token: ep.token, appId: 'newapp',
      body: { text: 'held', role: 'card', newParagraph: true },
    });
    expect(r.json.pending).toBe('consent');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const prompt = sent('external:consent-prompt')[0]!;
    fireConsentPromptResult({ requestId: prompt.payload.requestId, outcome: 'deny' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent('external:insert-text')).toHaveLength(0);
    const after = await fetchJson({
      method: 'POST', path: '/insert', port: ep.port, token: ep.token, appId: 'newapp',
      body: { text: 'again', role: 'card', newParagraph: true },
    });
    expect(after.json).toEqual({ ok: false, error: 'not-allowed' });
  });

  it('a successful allowed insert stamps lastSeen via a renderer note', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const inserted = fetchJson({
      method: 'POST', path: '/insert', port: ep.port, token: ep.token,
      body: { text: 'X', role: 'card', newParagraph: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    fireRendererAck({ requestId: sent('external:insert-text')[0]!.payload.requestId, ok: true });
    await inserted;
    const notes = sent('external:consent-note');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.payload).toMatchObject({ kind: 'seen', appId: 'testapp' });
    expect(typeof notes[0]!.payload.when).toBe('string');
  });

  it('pending consent on /jump answers jumped:false', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const r = await fetchJson({
      method: 'POST', path: '/jump', port: ep.port, token: ep.token, appId: 'newapp',
      body: { source: 'cmsrc1.abc' },
    });
    expect(r.json).toEqual({ ok: true, jumped: false, pending: 'consent' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const prompt = sent('external:consent-prompt')[0]!;
    fireConsentPromptResult({ requestId: prompt.payload.requestId, outcome: 'dismissed' });
  });

  it('unidentified /replace is turned away with the same guidance as /insert', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const r = await fetchJson({
      method: 'POST', path: '/replace', port: ep.port, token: ep.token, appId: null,
      body: { source: sourceToken('d.docx'), text: 'edited' },
    });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toBe('unidentified');
    expect(r.json.message).toContain('X-App-Id');
    expect(sent('external:replace-text')).toHaveLength(0);
  });

  it('master toggle off → inserts-disabled on /replace too', async () => {
    fireConsentSync({ policy: 'off', apps: { testapp: 'allow' } });
    const ep = bridge.getRunningEndpoint()!;
    const r = await fetchJson({
      method: 'POST', path: '/replace', port: ep.port, token: ep.token,
      body: { source: sourceToken('d.docx'), text: 'edited' },
    });
    expect(r.json).toEqual({ ok: false, error: 'inserts-disabled' });
    expect(sent('external:replace-text')).toHaveLength(0);
  });

  it('a denied app cannot rewrite text either', async () => {
    fireConsentSync({ policy: 'ask', apps: { testapp: 'deny' } });
    const ep = bridge.getRunningEndpoint()!;
    const r = await fetchJson({
      method: 'POST', path: '/replace', port: ep.port, token: ep.token,
      body: { source: sourceToken('d.docx'), text: 'edited' },
    });
    expect(r.json).toEqual({ ok: false, error: 'not-allowed' });
    expect(sent('external:replace-text')).toHaveLength(0);
  });

  it('pending consent on /replace answers ok with pending and no token', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const r = await fetchJson({
      method: 'POST', path: '/replace', port: ep.port, token: ep.token, appId: 'newapp',
      body: { source: sourceToken('d.docx'), text: 'edited' },
    });
    // `pending` is neither success nor retry: nothing was rewritten, so
    // there is no fresh token for the caller to write back.
    expect(r.json).toEqual({ ok: true, pending: 'consent' });
    expect(r.json.source).toBeUndefined();
    expect(sent('external:replace-text')).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const prompt = sent('external:consent-prompt')[0]!;
    fireConsentPromptResult({ requestId: prompt.payload.requestId, outcome: 'dismissed' });
  });

  it('unidentified /insert-after is turned away with the same guidance as /insert', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const r = await fetchJson({
      method: 'POST', path: '/insert-after', port: ep.port, token: ep.token, appId: null,
      body: { source: sourceToken('d.docx'), text: 'added' },
    });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toBe('unidentified');
    expect(r.json.message).toContain('X-App-Id');
    expect(sent('external:insert-after')).toHaveLength(0);
  });

  it('master toggle off → inserts-disabled on /insert-after too', async () => {
    fireConsentSync({ policy: 'off', apps: { testapp: 'allow' } });
    const ep = bridge.getRunningEndpoint()!;
    const r = await fetchJson({
      method: 'POST', path: '/insert-after', port: ep.port, token: ep.token,
      body: { source: sourceToken('d.docx'), text: 'added' },
    });
    expect(r.json).toEqual({ ok: false, error: 'inserts-disabled' });
    expect(sent('external:insert-after')).toHaveLength(0);
  });

  it('a denied app cannot add a line either', async () => {
    fireConsentSync({ policy: 'ask', apps: { testapp: 'deny' } });
    const ep = bridge.getRunningEndpoint()!;
    const r = await fetchJson({
      method: 'POST', path: '/insert-after', port: ep.port, token: ep.token,
      body: { source: sourceToken('d.docx'), text: 'added' },
    });
    expect(r.json).toEqual({ ok: false, error: 'not-allowed' });
    expect(sent('external:insert-after')).toHaveLength(0);
  });

  it('pending consent on /insert-after answers ok with pending and no token', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const r = await fetchJson({
      method: 'POST', path: '/insert-after', port: ep.port, token: ep.token, appId: 'newapp',
      body: { source: sourceToken('d.docx'), text: 'added' },
    });
    // `pending` is not a success: nothing was added yet, and if the user
    // allows, the line lands with its token going nowhere - so there is
    // nothing here for the caller to store.
    expect(r.json).toEqual({ ok: true, pending: 'consent' });
    expect(r.json.source).toBeUndefined();
    expect(sent('external:insert-after')).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const prompt = sent('external:consent-prompt')[0]!;
    fireConsentPromptResult({ requestId: prompt.payload.requestId, outcome: 'dismissed' });
  });
});

describe('doc targeting (/docs + insert target)', () => {
  const sent = (channel: string) => sentToRenderer.filter((s) => s.channel === channel);
  let dataDir: string;
  let winA: ReturnType<typeof makeMockWindow>;
  let winB: ReturnType<typeof makeMockWindow>;

  beforeEach(async () => {
    dataDir = path.join(tmpRoot, `d-${Math.random().toString(36).slice(2, 8)}`);
    await fs.mkdir(dataDir, { recursive: true });
    resetElectronStub(dataDir);
    winA = makeMockWindow();
    winB = makeMockWindow();
    setMockFocusedWindow(winA);
    setMockAllWindows([winA, winB]);
    bridge.setDocDirectory({
      listDocs: () => [
        { uid: 'doc-a', filename: 'alpha.cmir', windowId: winA.id },
        { uid: 'doc-b', filename: null, windowId: winB.id },
      ],
      ownerWindow: (uid) => (uid === 'doc-a' ? (winA as any) : uid === 'doc-b' ? (winB as any) : null),
      speechUid: () => 'doc-b',
    });
    await bridge.startFastPasteBridge();
    bridge.resetExternalConsentForTests();
    bridge.resetFocusTrackingForTests();
    fireConsentSync({ policy: 'ask', apps: { testapp: 'allow' } });
  });

  afterEach(async () => {
    bridge.setDocDirectory(null);
    await bridge.stopFastPasteBridge();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  it('GET /docs lists every open doc with session targets + focus flag', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const r = await fetchJson({ method: 'GET', path: '/docs', port: ep.port, token: ep.token });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.docs).toEqual([
      { target: 'doc-a', title: 'alpha.cmir', focusedWindow: true, isSpeech: false },
      { target: 'doc-b', title: null, focusedWindow: false, isSpeech: true },
    ]);
  });

  it('GET /docs is consent-gated like the mutating routes', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const anon = await fetchJson({ method: 'GET', path: '/docs', port: ep.port, token: ep.token, appId: null });
    expect(anon.json.error).toBe('unidentified');
    const unknown = await fetchJson({ method: 'GET', path: '/docs', port: ep.port, token: ep.token, appId: 'newapp' });
    expect(unknown.json).toEqual({ ok: true, docs: null, pending: 'consent' });
    // Channel-scoped: a consent-NOTE forward can land first and satisfy
    // an any-channel wait while the prompt is still in flight (Ubuntu
    // CI flake, run 33459739485).
    await untilForwarded(1, 'external:consent-prompt');
    const prompt = sent('external:consent-prompt')[0]!;
    fireConsentPromptResult({ requestId: prompt.payload.requestId, outcome: 'dismissed' });
  });

  it('a targeted insert routes to the owning window with the target attached', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const inserted = fetchJson({
      method: 'POST', path: '/insert', port: ep.port, token: ep.token,
      body: { text: 'aimed', role: 'card', newParagraph: true, target: 'doc-b' },
    });
    await untilForwarded();
    const inserts = sent('external:insert-text');
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.payload.target).toBe('doc-b');
    // Renderer ack without docTitle → main fills it from the directory
    // (null filename here, so it stays absent rather than lying).
    fireRendererAck({ requestId: inserts[0]!.payload.requestId, ok: true });
    const r = await inserted;
    expect(r.json).toEqual({ ok: true, inserted: true });
  });

  it('a targeted insert to a vanished doc → target-not-found, no dispatch', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const r = await fetchJson({
      method: 'POST', path: '/insert', port: ep.port, token: ep.token,
      body: { text: 'aimed', role: 'card', newParagraph: true, target: 'doc-gone' },
    });
    expect(r.json).toEqual({ ok: false, error: 'target-not-found' });
    expect(sent('external:insert-text')).toHaveLength(0);
  });

  it('main fills docTitle for targeted inserts from the directory', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const inserted = fetchJson({
      method: 'POST', path: '/insert', port: ep.port, token: ep.token,
      body: { text: 'aimed', role: 'card', newParagraph: true, target: 'doc-a' },
    });
    await untilForwarded();
    fireRendererAck({ requestId: sent('external:insert-text')[0]!.payload.requestId, ok: true });
    expect((await inserted).json).toEqual({ ok: true, inserted: true, docTitle: 'alpha.cmir' });
  });

  it('an untargeted insert still follows focus — legacy path untouched', async () => {
    const ep = bridge.getRunningEndpoint()!;
    const inserted = fetchJson({
      method: 'POST', path: '/insert', port: ep.port, token: ep.token,
      body: { text: 'legacy', role: 'card', newParagraph: true },
    });
    await untilForwarded();
    const inserts = sent('external:insert-text');
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.payload.target).toBeUndefined();
    fireRendererAck({ requestId: inserts[0]!.payload.requestId, ok: true, docTitle: 'alpha.cmir' });
    expect((await inserted).json.ok).toBe(true);
  });
});
