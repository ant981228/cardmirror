// @vitest-environment jsdom
/**
 * Exact text ops for local edits (binding patch, 2026-09-04): inserted
 * characters are always NEW to the CRDT and deleted ones exactly the
 * deleted ones — the string diff used to borrow a neighbour's characters
 * when the inserted text shared a prefix or suffix with it, so a
 * partner's concurrent split/delete of the neighbour tore the new text.
 */
import { describe, it, expect } from 'vitest';
import type { Node as PMNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import { schema } from '../../src/schema/index.js';
import { enterMidTag } from '../../src/editor/tag-keymap.js';
import { createLoroPeers, settle, docOf, cardNode, type LoroPeer } from './_loro-helpers.js';

declare global {
  // eslint-disable-next-line no-var
  var __CM_MOVABLE_LIST__: boolean | undefined;
}
function bodies(d: PMNode): string[] {
  const out: string[] = [];
  d.descendants((n) => {
    if (n.type.name === 'card_body') out.push(n.textContent);
    return true;
  });
  return out;
}
function bodyStart(d: PMNode): number {
  let p = -1;
  d.descendants((n, pos) => {
    if (n.type.name === 'card_body' && p < 0) p = pos + 1;
    return p < 0;
  });
  return p;
}
async function sync(peers: LoroPeer[]): Promise<void> {
  for (let r = 0; r < 3; r++) {
    const blobs = peers.map((p) => p.exportAll());
    peers.forEach((p) => blobs.forEach((b) => p.import(b)));
    await settle(4);
  }
}
async function pair(text: string): Promise<[LoroPeer, LoroPeer]> {
  globalThis.__CM_MOVABLE_LIST__ = true;
  const peers = await createLoroPeers(docOf(cardNode('Tag', [text])), 2, () => []);
  return peers as [LoroPeer, LoroPeer];
}
function done(peers: LoroPeer[]): void {
  for (const p of peers) p.destroy();
  globalThis.__CM_MOVABLE_LIST__ = undefined;
}

describe('exact text ops: character identity survives concurrent structure changes', () => {
  it('insert sharing a PREFIX with the next token + concurrent split before that token', async () => {
    const [A, B] = await pair('golf «tk3» end');
    const at = bodyStart(A.view.state.doc) + 'golf '.length;
    A.view.dispatch(A.view.state.tr.insertText('«tk16» ', at));
    B.view.dispatch(B.view.state.tr.split(at));
    await settle(4);
    await sync([A, B]);
    expect(A.doc().eq(B.doc())).toBe(true);
    expect(bodies(A.doc())).toEqual(['golf «tk16» ', '«tk3» end']);
    done([A, B]);
  });

  it('insert sharing a SUFFIX with the previous word + concurrent delete of that word', async () => {
    const [A, B] = await pair('the there end');
    const start = bodyStart(A.view.state.doc);
    // A inserts " the" right after the first "the" (shares its suffix).
    A.view.dispatch(A.view.state.tr.insertText(' the', start + 'the'.length));
    // B concurrently deletes the first "the ".
    B.view.dispatch(B.view.state.tr.delete(start, start + 'the '.length));
    await settle(4);
    await sync([A, B]);
    expect(A.doc().eq(B.doc())).toBe(true);
    expect(bodies(A.doc())[0], "B removed the original word; A's inserted word survives whole").toBe(' thethere end');
    done([A, B]);
  });

  it('a whole-head rewrite that keeps the tail is a prefix delete: two peers splitting the same tag keep ONE head token', async () => {
    // enterMidTag rewrites the head as one replace step (whole content →
    // post-cursor content). Taken literally that re-mints the kept tail on
    // every peer that runs it, and two peers splitting the same head
    // concurrently converge on the tail twice (live-interleave seed 1,
    // 2026-09-04). The replace is trimmed within its own range first.
    globalThis.__CM_MOVABLE_LIST__ = true;
    const peers = await createLoroPeers(docOf(cardNode('Delta «hd3»', ['hotel india'])), 2, () => []);
    const [A, B] = peers as [LoroPeer, LoroPeer];
    const midTag = (p: LoroPeer): void => {
      let tagStart = -1;
      p.view.state.doc.descendants((n, pos) => {
        if (n.type.name === 'tag' && tagStart < 0) tagStart = pos + 1;
        return tagStart < 0;
      });
      p.view.dispatch(p.view.state.tr.setSelection(TextSelection.create(p.view.state.doc, tagStart + 'Delta '.length)));
      expect(enterMidTag(p.view.state, (tr) => p.view.dispatch(tr))).toBe(true);
    };
    midTag(A);
    midTag(B);
    await settle(4);
    await sync([A, B]);
    expect(A.doc().eq(B.doc())).toBe(true);
    const heads: string[] = [];
    A.doc().descendants((n) => {
      if (n.type.name === 'tag') heads.push(n.textContent);
      return n.type.name !== 'tag';
    });
    expect(heads.filter((h) => h.includes('«hd3»'))).toEqual(['«hd3»']);
    // The pre-cursor halves are fresh cards on each peer (copies, the
    // documented concurrent-split residual) — visible, never a loss.
    expect(heads.filter((h) => h === 'Delta ').length).toBe(2);
    done(peers);
  });

  it('typing with marks still lands with its marks; a split deletes the tail exactly and still converges', async () => {
    const [A, B] = await pair('plain text');
    const start = bodyStart(A.view.state.doc);
    A.view.dispatch(A.view.state.tr.insertText('BOLD ', start, start).addMark(start, start + 4, schema.marks['bold']!.create()));
    await settle(4);
    await sync([A, B]);
    expect(bodies(B.doc())[0]).toBe('BOLD plain text');
    let boldOnB = false;
    B.doc().descendants((n) => {
      if (n.isText && n.text === 'BOLD' && n.marks.some((m) => m.type.name === 'bold')) boldOnB = true;
      return true;
    });
    expect(boldOnB, 'the mark synced').toBe(true);
    // Split: the first block's tail is deleted by identity; the new block is a copy.
    A.view.dispatch(A.view.state.tr.split(bodyStart(A.view.state.doc) + 'BOLD '.length));
    await settle(4);
    await sync([A, B]);
    expect(A.doc().eq(B.doc())).toBe(true);
    expect(bodies(A.doc())).toEqual(['BOLD ', 'plain text']);
    done([A, B]);
  });
});
