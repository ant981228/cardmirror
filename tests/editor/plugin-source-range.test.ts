/**
 * Token -> content-range resolution, the piece /jump and /replace share.
 * Resolution order is heading UUID, then text anchor; a hit inside a
 * mirrored (read-only) subtree is refused.
 */

import { describe, expect, it } from 'vitest';
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { buildDescriptor, resolveDescriptor } from '../../src/editor/learn-anchor.js';
import { inMirroredContent, resolveSourceRange } from '../../src/editor/plugin-source-range.js';
import type { SourcePayload } from '../../src/editor/plugin-source-token.js';

function heading(type: string, text: string, id: string | null = newHeadingId()): PMNode {
  return schema.nodes[type]!.create({ id }, text ? schema.text(text) : null);
}
function cardBody(text: string): PMNode {
  return schema.nodes['card_body']!.create(null, schema.text(text));
}
function cardWith(...children: PMNode[]): PMNode {
  return schema.nodes['card']!.createChecked(null, children);
}
function selfRef(children: PMNode[]): PMNode {
  return schema.nodes['self_ref']!.createChecked(
    { source_heading_id: newHeadingId(), source_label: 'Mirror' },
    children,
  );
}
function makeDoc(children: PMNode[]): PMNode {
  return schema.nodes['doc']!.createChecked(null, children);
}

function payload(over: Partial<SourcePayload>): SourcePayload {
  return { docId: 'd1', docTitle: 'T', headingId: null, anchor: null, ...over };
}

/** Content range of the doc's first `tag`, so no test hard-codes an offset
 *  that a schema change would silently shift. */
function tagRange(doc: PMNode): { from: number; to: number } {
  let pos = -1;
  doc.descendants((n, p) => {
    if (pos < 0 && n.type.name === 'tag') pos = p;
    return pos < 0;
  });
  if (pos < 0) throw new Error('no tag in doc');
  return { from: pos + 1, to: pos + doc.nodeAt(pos)!.nodeSize - 1 };
}

describe('resolveSourceRange', () => {
  it("resolves a heading token to that heading's content range", () => {
    const id = newHeadingId();
    const doc = makeDoc([heading('block', 'One'), heading('block', 'Target heading', id)]);

    const r = resolveSourceRange(doc, payload({ headingId: id }));

    expect(r).not.toBeNull();
    expect(doc.textBetween(r!.from, r!.to)).toBe('Target heading');
    // The CONTENT range, not the node range: `from` sits inside the block.
    expect(doc.resolve(r!.from).parent.type.name).toBe('block');
  });

  it('resolves an empty heading to a zero-length range', () => {
    const id = newHeadingId();
    const doc = makeDoc([heading('block', 'One'), heading('block', '', id)]);

    // A blank heading is a legitimate target; refusing it here would make
    // the caller's decision for it.
    expect(resolveSourceRange(doc, payload({ headingId: id }))).toEqual({ from: 6, to: 6 });
  });

  it('resolves a tag token by anchor after an edit elsewhere shifted its position', () => {
    const doc = makeDoc([
      heading('block', 'Intro'),
      cardWith(
        heading('tag', 'Plan text'),
        cardBody('Body sentence long enough to supply real anchor context.'),
      ),
    ]);
    const original = tagRange(doc);
    const anchor = buildDescriptor(doc, original.from, original.to);
    const state = EditorState.create({ doc });
    const shift = 'Extra words. ';
    const shifted = state.apply(state.tr.insertText(shift, 1)).doc;

    const r = resolveSourceRange(shifted, payload({ anchor }));

    expect(r).not.toBeNull();
    expect(r!.from).toBe(original.from + shift.length);
    // `to` stops at the tag's content end. The raw descriptor reports the
    // next flat character instead, which sits in the card body - replacing
    // that range would merge the tag and the body into one node.
    expect(r!.to).toBe(original.to + shift.length);
    expect(shifted.resolve(r!.to).parent.type.name).toBe('tag');
    expect(shifted.textBetween(r!.from, r!.to)).toBe('Plan text');
  });

  it('returns null when the quoted text is gone', () => {
    const doc = makeDoc([
      heading('block', 'Intro'),
      cardWith(
        heading('tag', 'Plan text'),
        cardBody('Body sentence long enough to supply real anchor context.'),
      ),
    ]);
    const original = tagRange(doc);
    const anchor = buildDescriptor(doc, original.from, original.to);
    const state = EditorState.create({ doc });
    const retyped = state.apply(
      state.tr.insertText('Someone retyped this', original.from, original.to),
    ).doc;

    expect(resolveSourceRange(retyped, payload({ anchor }))).toBeNull();
  });

  it('returns null for a hit inside a mirrored subtree', () => {
    const doc = makeDoc([
      heading('block', 'Intro'),
      selfRef([
        cardWith(
          heading('tag', 'Mirrored only text', null),
          cardBody('Mirrored body sentence long enough to supply anchor context.'),
        ),
      ]),
    ]);
    const mirrored = tagRange(doc);
    const anchor = buildDescriptor(doc, mirrored.from, mirrored.to);

    // The quote DOES resolve - it is the doc's only occurrence - so the null
    // below proves the mirror rail fired, not that the anchor broke.
    expect(resolveDescriptor(doc, anchor)).not.toBeNull();
    expect(inMirroredContent(doc, mirrored.from)).toBe(true);
    expect(inMirroredContent(doc, 2)).toBe(false);
    expect(resolveSourceRange(doc, payload({ anchor }))).toBeNull();
  });

  it('returns null for a payload carrying neither a UUID nor an anchor', () => {
    const doc = makeDoc([heading('block', 'One')]);
    expect(resolveSourceRange(doc, payload({}))).toBeNull();
  });
});
