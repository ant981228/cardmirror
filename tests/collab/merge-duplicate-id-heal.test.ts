// @vitest-environment jsdom
/**
 * Merge-born duplicate heading ids are healed by the session repair
 * pass (chaos rig finding, 2026-09-04). The heading-id guard only looks
 * at LOCAL transactions, so a duplicate that arrives through the
 * binding — an old client's paste of a card copy that kept the id, or a
 * cut+paste racing a partner's move — was never repaired by anyone. The
 * leader re-mints every bearer after the first in document order;
 * followers receive that fix. Peer B here runs WITHOUT the guard (an
 * old client): its local paste of a copy keeps the id, and the
 * duplicate reaches the leader A as a remote batch.
 */
import { describe, it, expect } from 'vitest';
import type { Node as PMNode } from 'prosemirror-model';
import { collabRepairPlugin, lowestPeerIsLeader, repairStats } from '../../src/editor/collab/collab-repair.js';
import { createLoroPeers, syncAll, settle, docOf, cardNode, type LoroPeer } from './_loro-helpers.js';

declare global {
  // eslint-disable-next-line no-var
  var __CM_MOVABLE_LIST__: boolean | undefined;
}

function headingIds(doc: PMNode): string[] {
  const out: string[] = [];
  doc.descendants((n) => {
    if (n.type.name === 'tag') out.push(String(n.attrs['id']));
    return true;
  });
  return out;
}
function tagTexts(doc: PMNode): string[] {
  const out: string[] = [];
  doc.descendants((n) => {
    if (n.type.name === 'tag') out.push(n.textContent);
    return n.type.name !== 'tag';
  });
  return out;
}
function cardAt(doc: PMNode, headText: string): { pos: number; node: PMNode } {
  let found: { pos: number; node: PMNode } | null = null;
  let pos = 0;
  doc.forEach((child) => {
    if (!found && child.type.name === 'card' && child.firstChild?.textContent === headText) found = { pos, node: child };
    pos += child.nodeSize;
  });
  if (!found) throw new Error(`no card ${headText}`);
  return found;
}
function bodyEnd(doc: PMNode, headText: string): number {
  const { pos, node } = cardAt(doc, headText);
  const head = node.firstChild!;
  const body = node.child(1);
  return pos + 1 + head.nodeSize + 1 + body.content.size;
}
const dupes = (ids: string[]): string[] => ids.filter((id, i) => ids.indexOf(id) !== i);

describe('merge-born duplicate heading ids (cut+paste vs concurrent move)', () => {
  it('the leader re-mints the second bearer; both peers converge on unique ids', async () => {
    globalThis.__CM_MOVABLE_LIST__ = true;
    const peers: LoroPeer[] = [];
    const created = await createLoroPeers(
      docOf(cardNode('One', ['one body']), cardNode('Two', ['two body']), cardNode('Three', ['three body'])),
      2,
      (ldoc) => [collabRepairPlugin(() => lowestPeerIsLeader(ldoc.peerIdStr, peers.map((p) => p.ldoc.peerIdStr).filter((id) => id !== ldoc.peerIdStr)))],
    );
    // Lowest peer id is the leader: make it A, the peer that RECEIVES the duplicate.
    peers.push(...created.sort((x, y) => (BigInt(x.ldoc.peerIdStr) < BigInt(y.ldoc.peerIdStr) ? -1 : 1)));
    const [A, B] = peers as [LoroPeer, LoroPeer];
    const before = repairStats.duplicateIdHeals;
    const idTwo = headingIds(A.doc())[1]!;
    try {
      // B (no guard, like an old client) pastes a copy of "Two" at the end:
      // the copy keeps the id. A types into the original meanwhile.
      {
        const { node } = cardAt(B.doc(), 'Two');
        B.view.dispatch(B.view.state.tr.insert(B.view.state.doc.content.size, node.type.create(node.attrs, node.content, node.marks)));
      }
      A.view.dispatch(A.view.state.tr.insertText(' +leader', bodyEnd(A.doc(), 'Two')));
      await settle();
      await syncAll([A, B]);
      await settle(4);
      await syncAll([A, B]); // the leader's fix reaches the follower
      await settle(4);

      // The card IS duplicated (a copy is a copy — visible, user-fixable) …
      expect(tagTexts(A.doc()).filter((t) => t === 'Two').length).toBe(2);
      // … but the ids are unique again on both peers, the original id
      // survives on the first bearer, and the peers agree.
      for (const p of [A, B]) {
        const ids = headingIds(p.doc());
        expect(dupes(ids), 'no duplicate heading ids after the heal').toEqual([]);
        expect(ids.filter((id) => id === idTwo).length).toBe(1);
      }
      expect(JSON.stringify(A.doc().toJSON())).toBe(JSON.stringify(B.doc().toJSON()));
      expect(repairStats.duplicateIdHeals - before, 'exactly one re-mint, by the leader').toBe(1);
      // The original (first in document order, carrying A's typing) kept the id.
      const first = cardAt(A.doc(), 'Two');
      expect(first.node.firstChild!.attrs['id']).toBe(idTwo);
      expect(first.node.child(1).textContent).toBe('two body +leader');
    } finally {
      for (const p of peers) p.destroy();
      globalThis.__CM_MOVABLE_LIST__ = undefined;
    }
  });

  it('the index tracks ids through ordinary edits so a later merge still sees the duplicate', async () => {
    globalThis.__CM_MOVABLE_LIST__ = true;
    const peers: LoroPeer[] = [];
    const created = await createLoroPeers(
      docOf(cardNode('One', ['one body']), cardNode('Two', ['two body'])),
      2,
      (ldoc) => [collabRepairPlugin(() => lowestPeerIsLeader(ldoc.peerIdStr, peers.map((p) => p.ldoc.peerIdStr).filter((id) => id !== ldoc.peerIdStr)))],
    );
    peers.push(...created.sort((x, y) => (BigInt(x.ldoc.peerIdStr) < BigInt(y.ldoc.peerIdStr) ? -1 : 1)));
    const [A, B] = peers as [LoroPeer, LoroPeer];
    const before = repairStats.duplicateIdHeals;
    try {
      // Plenty of index traffic first: typing, a split, a fresh card.
      A.view.dispatch(A.view.state.tr.insertText(' more', bodyEnd(A.doc(), 'One')));
      A.view.dispatch(A.view.state.tr.split(bodyEnd(A.doc(), 'One') - 2));
      A.view.dispatch(A.view.state.tr.insert(A.view.state.doc.content.size, cardNode('Fresh', ['fresh body'])));
      await settle();
      await syncAll([A, B]);
      await settle(4);
      // Then the door: B's un-guarded copy of "Two" keeps the id.
      {
        const { node } = cardAt(B.doc(), 'Two');
        B.view.dispatch(B.view.state.tr.insert(B.view.state.doc.content.size, node.type.create(node.attrs, node.content, node.marks)));
      }
      await settle();
      await syncAll([A, B]);
      await settle(4);
      await syncAll([A, B]);
      await settle(4);
      for (const p of [A, B]) expect(dupes(headingIds(p.doc()))).toEqual([]);
      expect(repairStats.duplicateIdHeals - before).toBe(1);
    } finally {
      for (const p of peers) p.destroy();
      globalThis.__CM_MOVABLE_LIST__ = undefined;
    }
  });
});
