/**
 * Host-bound Learn store singleton — this window's MIRROR of the
 * canonical store.
 *
 * The canonical copy lives with one owner (desktop: the main process;
 * web: whichever tab holds the Web Lock for the write). This module
 * exposes a `LearnStore` whose reads are the local copy and whose
 * mutations do two things: apply locally at once (so callers can read
 * back synchronously, as they always could) and forward the same call
 * as a `LearnOp` to the owner. The owner's reply — and every change
 * broadcast from other windows — replaces the local copy wholesale.
 *
 * Replacing the copy while this window's own operations are still in
 * flight would briefly roll them back (the reply to op 1 does not yet
 * contain op 2), so canonical blobs are adopted only when no operation
 * is pending. If another window's broadcast arrived during the flight,
 * the last reply and that broadcast have no order this window can
 * trust, so it re-reads the canonical copy once settled. Other modules
 * import `learnStore` directly; `loadLearnStore()` is awaited once at
 * boot.
 */

import { LearnStore, LEARN_MUTATIONS, type LearnOp } from './learn-store.js';
import { getHost } from './host/index.js';
import type { AnchorDescriptor } from './learn-anchor.js';

/** The slice of the host the mirror needs (the real host implements it;
 *  tests hand in a fake owner). */
export interface LearnStoreHostLike {
  readLearnStore(): Promise<string | null>;
  applyLearnOp(op: LearnOp): Promise<string>;
  onLearnStoreChanged(handler: (json: string) => void): () => void;
}

export interface LearnMirror {
  /** Reads answer from the local copy; mutations also reach the owner. */
  store: LearnStore;
  /** Fetch the canonical blob once and subscribe to changes. */
  load(): Promise<void>;
  /** Operations sent to the owner and not yet answered. */
  pendingOps(): number;
  /** Resolves once every in-flight operation has been answered. */
  settled(): Promise<void>;
}

const MUTATIONS: ReadonlySet<string> = new Set(LEARN_MUTATIONS);

export function createLearnMirror(host: () => LearnStoreHostLike): LearnMirror {
  const inner = new LearnStore();
  let pending = 0;
  let deferred: string | null = null;
  let broadcastInFlight = false;
  const waiters: Array<() => void> = [];

  const drain = (): void => {
    if (pending > 0) return;
    for (const w of waiters.splice(0)) w();
  };
  /** Take a canonical blob — now, or once our own operations settle. */
  const adopt = (json: string): void => {
    if (pending > 0) {
      deferred = json;
      broadcastInFlight = true;
      return;
    }
    deferred = null;
    inner.loadJson(json);
  };
  /** Once settled, if something else changed the store meanwhile, take
   *  the canonical copy rather than guess which blob is newer. */
  const reconcile = (): void => {
    if (!broadcastInFlight) return;
    broadcastInFlight = false;
    void host()
      .readLearnStore()
      .then((json) => {
        if (json !== null) adopt(json);
      })
      .catch(() => {});
  };
  const forward = (op: LearnOp): void => {
    pending++;
    let result: Promise<string>;
    try {
      result = host().applyLearnOp(op);
    } catch (err) {
      result = Promise.reject(err);
    }
    result.then(
      (json) => {
        pending--;
        // The last reply carries everything this window sent; earlier
        // replies (and broadcasts that arrived meanwhile) are superseded.
        if (pending === 0) {
          deferred = null;
          inner.loadJson(json);
          reconcile();
        }
        drain();
      },
      (err) => {
        pending--;
        console.warn('Learn store: an operation was not accepted by the owner:', err);
        // Our local copy applied it; fall back to the canonical state.
        void host()
          .readLearnStore()
          .then((json) => {
            if (json !== null) adopt(json);
          })
          .catch(() => {})
          .finally(drain);
      },
    );
  };

  const store = new Proxy(inner, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (typeof prop === 'string' && MUTATIONS.has(prop)) {
        return (...args: unknown[]): unknown => {
          const r = fn.apply(target, args);
          forward({ m: prop, a: args } as LearnOp);
          return r;
        };
      }
      return fn.bind(target);
    },
  }) as LearnStore;

  let loaded = false;
  return {
    store,
    async load() {
      if (loaded) return;
      loaded = true;
      const h = host();
      const json = await h.readLearnStore();
      if (json !== null) adopt(json);
      h.onLearnStoreChanged(adopt);
    },
    pendingOps: () => pending,
    settled: () => (pending === 0 ? Promise.resolve() : new Promise<void>((r) => waiters.push(r))),
  };
}

const mirror = createLearnMirror(() => getHost());

export const learnStore: LearnStore = mirror.store;

/** Load the canonical store once and follow its changes. Safe to call
 *  repeatedly. */
export async function loadLearnStore(): Promise<void> {
  try {
    await mirror.load();
  } catch (err) {
    console.warn('Failed to load learn store:', err);
  }
}

/** Today as a local-day `YYYY-MM-DD` string (the scheduler's day bucket). */
export function localToday(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ── "Show in context" host hook ──────────────────────────────────────
// The review session (`learn-session-ui.ts`) is store-only and must not
// import the editor entry (`index.ts`) — that would pull index.ts's
// boot-time side effects into the wrong load order. So index.ts (which
// owns file-open + the active view) registers a handler here, and the
// session UI calls `showFlashcardInContext` to open a card's source file
// and focus its anchored text. Mirrors the learn store's host seam.

export interface ShowInContextRequest {
  /** Absolute path to the source file. */
  path: string;
  /** Display name (for toasts / the open flow). */
  name: string;
  /** The card's stored anchor — resolved against the opened doc. */
  descriptor: AnchorDescriptor;
}

/** `closeSession` lets the handler dismiss the review overlay — it does
 *  so only when the source opens in THIS window (replacing the doc the
 *  overlay covers); opening a separate window leaves the review up. */
export type ShowInContextHandler = (
  req: ShowInContextRequest,
  closeSession: () => void,
) => void;

let showInContextHandler: ShowInContextHandler | null = null;

/** Wire the app-level handler. index.ts calls this at boot; pass null to
 *  clear. */
export function setShowInContextHandler(handler: ShowInContextHandler | null): void {
  showInContextHandler = handler;
}

/** Whether a "show in context" handler is registered (it isn't on hosts
 *  without file-open, e.g. the web build). */
export function canShowInContext(): boolean {
  return showInContextHandler !== null;
}

/** Open a card's source and focus its anchored text. `closeSession` is
 *  invoked by the handler only when it opens in the current window. */
export function showFlashcardInContext(
  req: ShowInContextRequest,
  closeSession: () => void,
): void {
  showInContextHandler?.(req, closeSession);
}
