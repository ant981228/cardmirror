// @vitest-environment jsdom
/**
 * Comment-thread sync (plan §4.7): thread content mirrors into a
 * `comments` root LoroMap (per-thread nested map keyed by comment id)
 * and rides the session's normal update pipeline. Field symptom being
 * pinned: comment paint synced but the partner's comments pane stayed
 * empty. Merge granularity: concurrent replies to one thread BOTH
 * survive; edits are LWW per comment; root deletion beats a concurrent
 * reply.
 */

import { describe, it, expect } from 'vitest';
import type { EditorView } from 'prosemirror-view';
import { LoroDoc, UndoManager } from 'loro-crdt';
import { schema } from '../../src/schema/index.js';
import {
  commentsPlugin,
  commentsKey,
  getCommentsState,
  loadThreads,
  addThreadMeta,
  addReplyMeta,
  editCommentTextMeta,
  deleteThreadMeta,
  setResolvedMeta,
  type Comment,
  type Thread,
} from '../../src/editor/comments-plugin.js';
import {
  installCommentsSync,
  type CommentsSyncHandle,
} from '../../src/editor/collab/collab-comments.js';
import { LoroUndoPlugin, undo as loroUndo } from 'loro-prosemirror';
import {
  createLoroPeers,
  syncAll,
  settle,
  docOf,
  para,
  findText,
  typeAfter,
  type LoroPeer,
} from './_loro-helpers.js';

function comment(id: string, text: string, parentId: string | null, date: string): Comment {
  return { id, author: 'Tester', initials: 'T', date, text, kind: 'human', parentId };
}
function thread(id: string, text: string): Thread {
  return { id, comments: [comment(id, text, null, '2026-07-05T10:00:00Z')] };
}

interface CommentPeer extends LoroPeer {
  handle: CommentsSyncHandle;
}

/** Two session-shaped peers: sync plugin + comments plugin + adapter. */
async function commentPeers(): Promise<[CommentPeer, CommentPeer]> {
  const views = new Map<LoroDoc, EditorView>();
  const handles = new Map<LoroDoc, CommentsSyncHandle>();
  const peers = await createLoroPeers(docOf(para('some commented text here')), 2, (ldoc) => {
    const handle = installCommentsSync(ldoc, () => views.get(ldoc) ?? null);
    handles.set(ldoc, handle);
    return [commentsPlugin, handle.plugin];
  });
  for (const p of peers) views.set(p.ldoc, p.view);
  const [a, b] = peers as CommentPeer[];
  a!.handle = handles.get(a!.ldoc)!;
  b!.handle = handles.get(b!.ldoc)!;
  return [a!, b!];
}

function threadsOf(peer: LoroPeer): Map<string, Thread> {
  return getCommentsState(peer.view.state).threads;
}

describe('collab comment-thread sync', () => {
  it('a new comment reaches the partner: paint AND thread content', async () => {
    const [a, b] = await commentPeers();
    // the real add flow: comment_range mark + add meta in one tr
    const r = findText(a.doc(), 'commented');
    const t = thread('42', 'what is this card even saying');
    const tr = a.view.state.tr
      .addMark(r.from, r.to, schema.marks['comment_range']!.create({ threadId: '42' }))
      .setMeta(commentsKey, addThreadMeta(t));
    a.view.dispatch(tr);
    await settle();
    await syncAll([a, b]);

    const bThreads = threadsOf(b);
    expect(bThreads.get('42')?.comments[0]?.text).toBe('what is this card even saying');
    const mark = b.doc().nodeAt(findText(b.doc(), 'commented').from)?.marks;
    expect(mark?.some((m) => m.type.name === 'comment_range')).toBe(true);
    a.destroy();
    b.destroy();
  });

  it('concurrent replies to one thread BOTH survive, ordered by date', async () => {
    const [a, b] = await commentPeers();
    a.view.dispatch(a.view.state.tr.setMeta(commentsKey, addThreadMeta(thread('7', 'root'))));
    await settle();
    await syncAll([a, b]);

    a.view.dispatch(
      a.view.state.tr.setMeta(
        commentsKey,
        addReplyMeta('7', comment('100', 'reply from A', '7', '2026-07-05T11:00:00Z')),
      ),
    );
    b.view.dispatch(
      b.view.state.tr.setMeta(
        commentsKey,
        addReplyMeta('7', comment('200', 'reply from B', '7', '2026-07-05T10:30:00Z')),
      ),
    );
    await settle();
    await syncAll([a, b]);

    for (const peer of [a, b]) {
      const t = threadsOf(peer).get('7');
      expect(t?.comments.map((c) => c.text)).toEqual(['root', 'reply from B', 'reply from A']);
    }
    a.destroy();
    b.destroy();
  });

  it('resolve propagates to the partner and back', async () => {
    const [a, b] = await commentPeers();
    a.view.dispatch(a.view.state.tr.setMeta(commentsKey, addThreadMeta(thread('4', 'check me'))));
    await settle();
    await syncAll([a, b]);

    // B (the student) resolves; A (the teacher) sees it.
    b.view.dispatch(b.view.state.tr.setMeta(commentsKey, setResolvedMeta('4', true)));
    await settle();
    await syncAll([a, b]);
    for (const peer of [a, b]) {
      expect(threadsOf(peer).get('4')?.comments[0]?.resolved).toBe(true);
    }

    // Reopen flows the other way.
    a.view.dispatch(a.view.state.tr.setMeta(commentsKey, setResolvedMeta('4', false)));
    await settle();
    await syncAll([a, b]);
    for (const peer of [a, b]) {
      expect(threadsOf(peer).get('4')?.comments[0]?.resolved).toBe(false);
    }
    a.destroy();
    b.destroy();
  });

  it('edit-text and delete-thread propagate', async () => {
    const [a, b] = await commentPeers();
    a.view.dispatch(a.view.state.tr.setMeta(commentsKey, addThreadMeta(thread('9', 'draft'))));
    a.view.dispatch(a.view.state.tr.setMeta(commentsKey, addThreadMeta(thread('10', 'doomed'))));
    await settle();
    await syncAll([a, b]);
    expect(threadsOf(b).size).toBe(2);

    b.view.dispatch(b.view.state.tr.setMeta(commentsKey, editCommentTextMeta('9', '9', 'final')));
    a.view.dispatch(a.view.state.tr.setMeta(commentsKey, deleteThreadMeta('10')));
    await settle();
    await syncAll([a, b]);

    for (const peer of [a, b]) {
      expect(threadsOf(peer).get('9')?.comments[0]?.text).toBe('final');
      expect(threadsOf(peer).has('10')).toBe(false);
    }
    a.destroy();
    b.destroy();
  });

  it('reply racing a remote thread-delete stays deleted (delete wins)', async () => {
    const [a, b] = await commentPeers();
    a.view.dispatch(a.view.state.tr.setMeta(commentsKey, addThreadMeta(thread('5', 'root'))));
    await settle();
    await syncAll([a, b]);

    a.view.dispatch(a.view.state.tr.setMeta(commentsKey, deleteThreadMeta('5')));
    b.view.dispatch(
      b.view.state.tr.setMeta(
        commentsKey,
        addReplyMeta('5', comment('300', 'too late', '5', '2026-07-05T12:00:00Z')),
      ),
    );
    await settle();
    await syncAll([a, b]);

    expect(threadsOf(a).has('5')).toBe(false);
    expect(threadsOf(b).has('5')).toBe(false);
    a.destroy();
    b.destroy();
  });

  it('a remote comments event that changes nothing does not dispatch into the editor (2026-09-01 review, PH-A12)', async () => {
    // pull() rebuilt every thread and dispatched a PM transaction on
    // EVERY remote comments event — one partner toggling "resolved"
    // materialized the whole thread set and fired a transaction on
    // everyone, even when the derived threads were identical.
    const [a, b] = await commentPeers();
    a.view.dispatch(a.view.state.tr.setMeta(commentsKey, addThreadMeta(thread('20', 'steady'))));
    await settle();
    await syncAll([a, b]);
    // First set lands the value (a real change → one dispatch, not counted).
    a.view.dispatch(a.view.state.tr.setMeta(commentsKey, setResolvedMeta('20', false)));
    await settle();
    await syncAll([a, b]);
    let syncDispatches = 0;
    const inner = b.view.dispatch.bind(b.view);
    (b.view as { dispatch: (tr: unknown) => void }).dispatch = (tr) => {
      const t = tr as { getMeta: (k: unknown) => unknown };
      if (t.getMeta(commentsKey)) syncDispatches++;
      inner(tr as never);
    };
    // A re-sets the SAME value: the map changes bytes (LWW rewrite) but
    // the derived threads on B are identical.
    a.view.dispatch(a.view.state.tr.setMeta(commentsKey, setResolvedMeta('20', false)));
    await settle();
    await syncAll([a, b]);
    expect(syncDispatches, 'no-change events must not dispatch').toBe(0);
    a.destroy();
    b.destroy();
  });

  it('host seeding pushes pre-session threads; partner receives them', async () => {
    const [a, b] = await commentPeers();
    // threads that existed before the session (e.g. from a docx import)
    a.view.dispatch(loadThreads(a.view.state, [thread('1', 'old note'), thread('2', 'older note')]));
    await settle();
    a.handle.seedFromView(a.view);
    await syncAll([a, b]);

    expect(threadsOf(b).get('1')?.comments[0]?.text).toBe('old note');
    expect(threadsOf(b).get('2')?.comments[0]?.text).toBe('older note');
    a.destroy();
    b.destroy();
  });

  it("undo steps over comment ops (excluded origin) — Ctrl+Z can't delete comments", async () => {
    // Session-shaped peer with the SAME undo config installSeams uses: an
    // UndoManager excluding the comments/meta commit origins. Regression for
    // the audit find where the undo stack interleaved doc edits with the
    // mirror's map writes, so an undo after a comment op deleted the comment.
    const views = new Map<LoroDoc, EditorView>();
    const handles = new Map<LoroDoc, CommentsSyncHandle>();
    const peers = await createLoroPeers(docOf(para('some commented text here')), 1, (ldoc) => {
      const handle = installCommentsSync(ldoc, () => views.get(ldoc) ?? null);
      handles.set(ldoc, handle);
      return [
        commentsPlugin,
        handle.plugin,
        LoroUndoPlugin({
          doc: ldoc as Parameters<typeof LoroUndoPlugin>[0]['doc'],
          undoManager: new UndoManager(ldoc, {
            excludeOriginPrefixes: ['cm-comments', 'cm-meta'],
          }),
        }),
      ];
    });
    const a = peers[0]! as CommentPeer;
    views.set(a.ldoc, a.view);
    a.handle = handles.get(a.ldoc)!;

    // Edit 1 (undoable) → comment op (must be skipped) → edit 2 (undoable).
    typeAfter(a.view, 'commented', ' ONE');
    await settle();
    const r = findText(a.doc(), 'commented');
    a.view.dispatch(
      a.view.state.tr
        .addMark(r.from, r.to, schema.marks['comment_range']!.create({ threadId: 'u1' }))
        .setMeta(commentsKey, addThreadMeta(thread('u1', 'survives undo'))),
    );
    await settle();
    typeAfter(a.view, 'text', ' TWO');
    await settle();

    // Undo twice: both text edits unwind; the comment thread survives in
    // plugin state AND in the shared map.
    loroUndo(a.view.state, a.view.dispatch);
    await settle();
    loroUndo(a.view.state, a.view.dispatch);
    await settle();
    expect(a.doc().textContent).not.toContain('TWO');
    expect(threadsOf(a).get('u1')?.comments[0]?.text).toBe('survives undo');
    expect(
      (a.ldoc.getMap('comments').toJSON() as Record<string, Record<string, Comment>>)['u1'],
    ).toBeTruthy();
    a.destroy();
  });
});
