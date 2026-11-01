/**
 * Regression: `LoroDoc.diff` across an import burst on a snapshot-loaded
 * document must terminate. loro-crdt 1.13.6 looped forever in
 * `ChangeStore::get_change_by_lamport_lte` (snapshot-decoded change blocks
 * recorded a wrong end lamport) whenever the movable-list diff calculator
 * resolved historical positions — i.e. whenever the burst moved cards. The
 * binding's import hold (`__CM_HOLD_IMPORTS__`) runs exactly that diff, so
 * every rejoin / catch-up with card moves froze the window at 100% CPU.
 * Fixed upstream in 1.13.7; CardMirror pins 1.13.9. The diff runs in a
 * worker so a regression fails here by timeout instead of hanging vitest.
 */
import { describe, it, expect } from 'vitest';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./_loro-diff-worker.mjs', import.meta.url));

function diffInWorker(data: { cards: number; textLen: number; rounds: number }, timeoutMs: number) {
  return new Promise<{ containers: number; ms: number }>((resolve, reject) => {
    const w = new Worker(WORKER, { workerData: data });
    const timer = setTimeout(() => {
      void w.terminate();
      reject(new Error(`diff did not return within ${timeoutMs} ms (loro diff hang regression)`));
    }, timeoutMs);
    w.once('message', (m) => { clearTimeout(timer); void w.terminate(); resolve(m); });
    w.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

describe('LoroDoc.diff after a snapshot import', () => {
  it('terminates across a burst of card moves and marks', async () => {
    const r = await diffInWorker({ cards: 60, textLen: 3000, rounds: 6 }, 20_000);
    expect(r.containers).toBeGreaterThan(0);
    expect(r.ms).toBeLessThan(5_000);
  }, 30_000);
});
