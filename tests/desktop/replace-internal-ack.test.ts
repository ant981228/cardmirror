// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  sentToRenderer,
  ipcListeners,
  resetElectronStub,
  setMockAllWindows,
  makeMockWindow,
} from './_electron-stub.js';
import * as bridge from '../../apps/desktop/src/fast-paste-bridge.js';

const tmpRoot = path.join(os.tmpdir(), `cardmirror-replace-internal-test-${process.pid}`);
const token =
  'cmsrc1.' + Buffer.from(JSON.stringify({ docId: 'd', docTitle: 'AT Cap K.docx' })).toString('base64url');

function fire(channel: string, payload: unknown): void {
  for (const l of ipcListeners.get(channel) ?? []) l(null, payload);
}

describe('POST /replace renderer `internal` ack', () => {
  let dir: string;
  beforeEach(async () => {
    dir = path.join(tmpRoot, `t-${Math.random().toString(36).slice(2, 8)}`);
    await fs.mkdir(dir, { recursive: true });
    resetElectronStub(dir);
    await bridge.startFastPasteBridge();
    bridge.resetExternalConsentForTests();
    fire('host:sync-external-consent', { policy: 'ask', apps: { testapp: 'allow' } });
  });
  afterEach(async () => {
    await bridge.stopFastPasteBridge();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('reports internal (write may have landed), not doc-not-open', async () => {
    setMockAllWindows([makeMockWindow()]);
    const ep = bridge.getRunningEndpoint()!;
    const res = fetch(`http://127.0.0.1:${ep.port}/replace`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-app-id': 'testapp',
        'x-fdp-token': ep.token,
        connection: 'close',
      },
      body: JSON.stringify({ source: token, text: 'edited' }),
    }).then((r) => r.json());
    const sent = () => sentToRenderer.filter((s) => s.channel === 'external:replace-text');
    while (sent().length < 1) await new Promise((r) => setTimeout(r, 5));
    // What external-replace-host.ts sends when anything throws - including
    // AFTER view.dispatch landed the edit (its catch-all).
    fire('external:replace-result', {
      requestId: sent()[0]!.payload.requestId,
      ok: false,
      error: 'internal',
    });
    expect(await res).toEqual({ ok: false, error: 'internal' });
  });
});
