/**
 * The learn store as OPERATIONS with a single owner (field report
 * 2026-09-05: flashcards vanished; cause = two windows each rewriting
 * the whole blob, last writer wins). A window's mirror applies a
 * mutation locally and forwards it; the owner applies it to the
 * canonical copy and every window adopts the result. Drives
 * `createLearnMirror` against a fake owner with asynchronous replies.
 */
import { describe, expect, it } from 'vitest';
import {
  LearnStore,
  LEARN_MUTATIONS,
  applyLearnOp,
  isLearnOp,
  type CardDef,
  type LearnOp,
} from '../../src/editor/learn-store.js';
import { createLearnMirror, type LearnStoreHostLike } from '../../src/editor/learn-store-host.js';

const TODAY = '2026-09-05';
const card = (id: string): CardDef => ({ id, type: 'qa', front: `Q${id}`, back: `A${id}` });
const desc = (q: string) => ({ quote: q, prefix: '', suffix: '', approxPos: 0 });
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A fake owner: one canonical store, N windows, replies delivered on a
 *  later macrotask (like IPC), broadcasts to every OTHER window. */
function fakeOwner(opts: { reject?: (op: LearnOp) => boolean } = {}) {
  const canonical = new LearnStore();
  const listeners = new Set<(json: string) => void>();
  let gate: Promise<void> = Promise.resolve();
  const owner = {
    canonical,
    /** Hold every reply until `release()` (models slow IPC). */
    hold(): () => void {
      let release!: () => void;
      gate = new Promise<void>((r) => (release = r));
      return release;
    },
    window(): { host: LearnStoreHostLike; mirror: ReturnType<typeof createLearnMirror> } {
      let mine: ((json: string) => void) | null = null;
      const host: LearnStoreHostLike = {
        readLearnStore: async () => canonical.toJson(),
        applyLearnOp: async (op) => {
          await tick();
          if (opts.reject?.(op)) throw new Error('refused');
          applyLearnOp(canonical, op);
          const json = canonical.toJson();
          for (const l of listeners) if (l !== mine) l(json);
          await gate;
          return json;
        },
        onLearnStoreChanged: (h) => {
          mine = h;
          listeners.add(h);
          return () => listeners.delete(h);
        },
      };
      const mirror = createLearnMirror(() => host);
      return { host, mirror };
    },
  };
  return owner;
}

describe('learn store operations', () => {
  it('every method that persists is an operation (drift guard)', () => {
    const persisting = Object.getOwnPropertyNames(LearnStore.prototype).filter((name) => {
      if (name === 'constructor' || name === 'changed') return false;
      const fn = (LearnStore.prototype as unknown as Record<string, unknown>)[name];
      return typeof fn === 'function' && String(fn).includes('this.changed(');
    });
    expect(persisting.sort()).toEqual([...LEARN_MUTATIONS].sort());
  });

  it('applies a serialized call to a store; rejects malformed shapes', () => {
    const s = new LearnStore();
    applyLearnOp(s, { m: 'upsertCard', a: [card('c1'), TODAY] });
    applyLearnOp(s, { m: 'setAnchor', a: ['c1', 'docA', desc('x')] });
    expect(s.totalCount({ kind: 'file', docId: 'docA' })).toBe(1);
    expect(isLearnOp({ m: 'upsertCard', a: [] })).toBe(true);
    expect(isLearnOp({ m: 'loadJson', a: ['{}'] })).toBe(false); // not a mutation
    expect(isLearnOp({ m: 'upsertCard' })).toBe(false);
    expect(isLearnOp('upsertCard')).toBe(false);
  });
});

describe('two windows, one owner', () => {
  it('a window that loaded earlier no longer overwrites cards another window created', async () => {
    const owner = fakeOwner();
    const A = owner.window();
    const B = owner.window();
    await A.mirror.load();
    await B.mirror.load(); // both loaded while the store was empty
    A.mirror.store.upsertCard(card('c1'), TODAY);
    A.mirror.store.setAnchor('c1', 'docA', desc('alpha'));
    // B, still on its stale copy, merely registers a file it opened —
    // the whole-blob write this used to trigger dropped c1.
    B.mirror.store.registerDoc({ docId: 'docB', name: 'B.cmir', format: 'cmir' });
    await A.mirror.settled();
    await B.mirror.settled();
    await tick();
    expect(owner.canonical.getCard('c1')?.front).toBe('Qc1');
    expect(owner.canonical.listDocs().map((d) => d.docId)).toContain('docB');
    for (const w of [A, B]) {
      expect(w.mirror.store.getCard('c1')?.front, 'every window converges').toBe('Qc1');
      expect(w.mirror.store.listDocs().map((d) => d.docId)).toContain('docB');
    }
  });

  it('reads stay synchronous and subscribers fire on adoption', async () => {
    const owner = fakeOwner();
    const A = owner.window();
    const B = owner.window();
    await A.mirror.load();
    await B.mirror.load();
    let notified = 0;
    B.mirror.store.subscribe(() => notified++);
    A.mirror.store.upsertCard(card('c2'), TODAY);
    expect(A.mirror.store.getCard('c2')?.back, 'read back at once').toBe('Ac2');
    await A.mirror.settled();
    await tick();
    expect(B.mirror.store.getCard('c2')?.back).toBe('Ac2');
    expect(notified).toBeGreaterThan(0);
  });

  it("a reply to an earlier operation never rolls back a later local one", async () => {
    const owner = fakeOwner();
    const A = owner.window();
    await A.mirror.load();
    const release = owner.hold();
    A.mirror.store.upsertCard(card('c1'), TODAY);
    A.mirror.store.upsertCard(card('c2'), TODAY);
    expect(A.mirror.pendingOps()).toBe(2);
    release();
    // The reply to op 1 (a blob holding only c1) arrives while op 2 is
    // still pending: it must not be adopted.
    await tick();
    await tick();
    expect(A.mirror.store.getCard('c2'), 'c2 survives the first reply').toBeDefined();
    await A.mirror.settled();
    expect(A.mirror.store.getCard('c1')).toBeDefined();
    expect(A.mirror.store.getCard('c2')).toBeDefined();
    expect(A.mirror.pendingOps()).toBe(0);
  });

  it('a broadcast that arrives mid-flight is deferred; the newest state wins', async () => {
    const owner = fakeOwner();
    const A = owner.window();
    const B = owner.window();
    await A.mirror.load();
    await B.mirror.load();
    const release = owner.hold();
    A.mirror.store.upsertCard(card('a1'), TODAY);
    B.mirror.store.upsertCard(card('b1'), TODAY); // broadcast to A while A's op is pending
    await tick();
    await tick();
    expect(A.mirror.store.getCard('a1'), 'A keeps its own pending change').toBeDefined();
    release();
    await A.mirror.settled();
    await B.mirror.settled();
    await tick();
    for (const w of [A, B]) {
      expect(w.mirror.store.getCard('a1')).toBeDefined();
      expect(w.mirror.store.getCard('b1')).toBeDefined();
    }
  });

  it('a refused operation is rolled back from the canonical copy', async () => {
    const owner = fakeOwner({ reject: (op) => op.m === 'deleteCard' });
    const A = owner.window();
    await A.mirror.load();
    A.mirror.store.upsertCard(card('c1'), TODAY);
    await A.mirror.settled();
    A.mirror.store.deleteCard('c1');
    expect(A.mirror.store.getCard('c1'), 'applied locally first').toBeUndefined();
    await A.mirror.settled();
    await tick();
    expect(A.mirror.store.getCard('c1'), 'restored from the owner').toBeDefined();
    expect(owner.canonical.getCard('c1')).toBeDefined();
  });
});
