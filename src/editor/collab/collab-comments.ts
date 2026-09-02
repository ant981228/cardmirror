/**
 * Comment-thread sync for collab sessions (plan §4.7).
 *
 * `comment_range` marks travel with the doc CRDT already; thread
 * CONTENT lives in comments-plugin state and never leaves the machine
 * — the field symptom was yellow paint with an empty comments pane on
 * the partner's side. This adapter mirrors thread content into a
 * `comments` root LoroMap on the session doc, so it rides the same
 * update/snapshot pipeline (same flush timer, same E2E encryption).
 *
 * Layout: `comments` map → per-thread nested LoroMap keyed by comment
 * id. Per-comment keys make concurrent replies MERGE (both survive)
 * instead of LWW-clobbering whole threads; comment edits are LWW per
 * comment, which is the right granularity. Thread ordering is derived
 * (root first, replies by date, id tiebreak), matching the plugin's
 * "root then chronological" contract.
 *
 * Direction rules:
 *  - outbound: a session plugin mirrors the five user mutations
 *    (add/reply/edit-text/delete-thread/delete-comment, plus docx
 *    `load`) from `commentsKey` metas into the map. Living in the
 *    session's plugin set scopes it to the session view — other
 *    panes/windows never leak comments into the room.
 *  - inbound: map imports dispatch a `sync-load` refresh. GC parking is
 *    deliberately NOT propagated — each peer parks orphans locally so
 *    an undo that restores the mark can resurrect the thread; only
 *    explicit deletes touch the shared map.
 *  - a reply whose thread has vanished from the map is dropped, not
 *    recreated: the thread was deleted remotely, and delete wins.
 */

import { Plugin } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { LoroMap } from 'loro-crdt';
import type { LoroDoc } from 'loro-crdt';
import {
  commentsKey,
  getCommentsState,
  syncLoadThreads,
  type Comment,
  type CommentsMeta,
  type Thread,
} from '../comments-plugin.js';
import { markSyncOrigin } from '../sync-origin.js';

const COMMENTS_ROOT_KEY = 'comments';

/** Commit origin for every comments-map write. The session's UndoManager
 *  excludes this prefix (see installSeams), so Ctrl+Z steps over comment
 *  operations instead of silently deleting comments/replies — the undo
 *  stack otherwise interleaved doc edits with the mirror's map writes
 *  (audit find, 2026-07-10). */
export const COMMENTS_COMMIT_ORIGIN = 'cm-comments';

export interface CommentsSyncHandle {
  /** Stable instance for the session plugin set (survives reconfigure). */
  plugin: Plugin;
  /** Host: push the current view's threads into the shared map. */
  seedFromView(view: EditorView): void;
  /** Refresh plugin state from the shared map (joiner after the
   *  session doc lands; also used by the import subscription). */
  pull(): void;
  dispose(): void;
}

function rootMap(doc: LoroDoc): LoroMap {
  return doc.getMap(COMMENTS_ROOT_KEY);
}

function threadMap(root: LoroMap, threadId: string, createIfMissing: boolean): LoroMap | null {
  const existing = root.get(threadId);
  if (existing instanceof LoroMap) return existing;
  if (!createIfMissing) return null;
  return root.setContainer(threadId, new LoroMap());
}

function writeThread(root: LoroMap, thread: Thread): void {
  const t = threadMap(root, thread.id, true)!;
  for (const c of thread.comments) t.set(c.id, { ...c });
}

/** Rebuild ordered threads from the map's plain JSON. Root-less thread
 *  containers (delete/reply races) are skipped — root deletion means
 *  the thread is gone. */
function threadsFromMap(root: LoroMap): Thread[] {
  const json = root.toJSON() as Record<string, Record<string, Comment>>;
  const threads: Thread[] = [];
  for (const [threadId, byId] of Object.entries(json ?? {})) {
    if (!byId || typeof byId !== 'object') continue;
    const rootComment = byId[threadId];
    if (!rootComment) continue;
    const replies = Object.values(byId)
      .filter((c) => c && c.id !== threadId)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
    threads.push({ id: threadId, comments: [rootComment, ...replies] });
  }
  return threads;
}

/** Diagnostics: local mutations that could not be mirrored because the
 *  thread container was already gone (reply's silent no-op is the
 *  documented delete-wins case; edit-text / set-resolved landing here
 *  means the user's own pane shows a change the room never got). */
export const commentsSyncStats = { droppedMutations: 0 };
function noteDropped(kind: string, threadId: string): void {
  commentsSyncStats.droppedMutations++;
  console.warn(`[collab-comments] ${kind} on a thread the room no longer has (${threadId}) — not mirrored`);
}

export function installCommentsSync(
  doc: LoroDoc,
  getView: () => EditorView | null,
): CommentsSyncHandle {
  const root = rootMap(doc);
  let disposed = false;
  let pullQueued = false;

  const mirror = (meta: CommentsMeta): void => {
    switch (meta.type) {
      case 'add':
        writeThread(root, meta.thread);
        break;
      case 'add-batch':
        for (const t of meta.threads) writeThread(root, t);
        break;
      case 'load':
        // Mid-session docx import into the session pane: bulk-push so
        // the map stays a superset of plugin state.
        for (const t of meta.threads) writeThread(root, t);
        break;
      case 'reply': {
        const t = threadMap(root, meta.threadId, false);
        if (t) t.set(meta.comment.id, { ...meta.comment });
        break;
      }
      case 'edit-text': {
        const t = threadMap(root, meta.threadId, false);
        const existing = t?.get(meta.commentId);
        if (t && existing && typeof existing === 'object' && !(existing instanceof LoroMap)) {
          t.set(meta.commentId, { ...(existing as Comment), text: meta.text });
        } else {
          noteDropped('edit-text', meta.threadId);
        }
        break;
      }
      case 'set-resolved': {
        // Root-comment LWW, same granularity as edit-text.
        const t = threadMap(root, meta.threadId, false);
        const existing = t?.get(meta.threadId);
        if (t && existing && typeof existing === 'object' && !(existing instanceof LoroMap)) {
          t.set(meta.threadId, { ...(existing as Comment), resolved: meta.resolved });
        } else {
          noteDropped('set-resolved', meta.threadId);
        }
        break;
      }
      case 'delete-thread':
        root.delete(meta.threadId);
        break;
      case 'delete-comment': {
        // Deleting the root drops the whole thread (plugin semantics).
        if (meta.commentId === meta.threadId) {
          root.delete(meta.threadId);
        } else {
          threadMap(root, meta.threadId, false)?.delete(meta.commentId);
        }
        break;
      }
      default:
        return; // gc / sync-load / set-visible stay local
    }
    doc.commit({ origin: COMMENTS_COMMIT_ORIGIN });
  };

  // Last derived thread set this view was handed: a remote comments
  // event that changes nothing derivable (a same-value LWW rewrite)
  // used to rebuild every thread AND dispatch a transaction into the
  // editor anyway (2026-09-01 review, PH-A12).
  let lastPulledSig = '';
  const pull = (): void => {
    if (disposed) return;
    const view = getView();
    if (!view || view.isDestroyed) return;
    const threads = threadsFromMap(root);
    const sig = JSON.stringify(threads);
    if (sig === lastPulledSig) return;
    lastPulledSig = sig;
    view.dispatch(markSyncOrigin(syncLoadThreads(view.state, threads)));
  };

  const unsubscribe = root.subscribe((event) => {
    if (event.by === 'local' || disposed) return;
    // One refresh per import batch — events arrive per-container.
    if (pullQueued) return;
    pullQueued = true;
    queueMicrotask(() => {
      pullQueued = false;
      pull();
    });
  });

  const plugin = new Plugin({
    state: {
      init: () => null,
      apply(tr) {
        // Side-effect mirror: apply() is the one hook that sees this
        // view's transactions exactly once, metas included.
        const meta = tr.getMeta(commentsKey) as CommentsMeta | undefined;
        if (meta && !disposed) mirror(meta);
        return null;
      },
    },
  });

  return {
    plugin,
    seedFromView(view: EditorView): void {
      const { threads } = getCommentsState(view.state);
      for (const t of threads.values()) writeThread(root, t);
      doc.commit({ origin: COMMENTS_COMMIT_ORIGIN });
    },
    pull,
    dispose(): void {
      disposed = true;
      unsubscribe();
    },
  };
}
