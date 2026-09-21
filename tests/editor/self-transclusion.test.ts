import { describe, it, expect } from 'vitest';
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  isSelfRef,
  createSelfRefNode,
  resolveSelfProjection,
  resolveLiveReferenceProjection,
  flattenSelfRefs,
  flattenSelfRefsInSlice,
  fragmentHasSelfRef,
} from '../../src/editor/self-transclusion.js';

const block = (text: string, id: string): PMNode => schema.nodes['block']!.create({ id }, schema.text(text));
function card(tag: string, body: string, id = newHeadingId()): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
const doc = (children: PMNode[]): PMNode => schema.nodes['doc']!.createChecked(null, children);
const selfRef = (headingId: string, label = '↳'): PMNode => createSelfRefNode(schema, headingId, label);

/** Card-body texts of a fragment, in order. */
function bodies(frag: Fragment): string[] {
  const out: string[] = [];
  frag.descendants((n) => {
    if (n.type.name === 'card_body') out.push(n.textContent);
    return true;
  });
  return out;
}

describe('isSelfRef / createSelfRefNode', () => {
  it('creates a self_ref carrying its source heading + label', () => {
    const n = selfRef('h1', '↳ Impacts');
    expect(isSelfRef(n)).toBe(true);
    expect(n.attrs['source_heading_id']).toBe('h1');
    expect(n.attrs['source_label']).toBe('↳ Impacts');
    expect(n.isAtom).toBe(false); // holds its mirrored section as (read-only) content
  });
  it('a card is not a self_ref', () => {
    expect(isSelfRef(card('A', 'a'))).toBe(false);
  });
});

describe('resolveSelfProjection', () => {
  it("projects the source section's current content", () => {
    const d = doc([block('Src', 'src'), card('A', 'alpha'), card('B', 'bravo'), block('End', 'end')]);
    const p = resolveSelfProjection(d, 'src');
    expect(p.missing).toBe(false);
    expect(p.cycle).toBe(false);
    expect(bodies(p.content)).toEqual(['alpha', 'bravo']);
  });

  it('reflects an edited source (resolved live, not a stored copy)', () => {
    const d1 = doc([block('Src', 'src'), card('A', 'alpha'), block('End', 'end')]);
    expect(bodies(resolveSelfProjection(d1, 'src').content)).toEqual(['alpha']);
    // A different doc state → different projection (there's no cached copy).
    const d2 = doc([block('Src', 'src'), card('A', 'ALPHA-edited'), card('C', 'charlie'), block('End', 'end')]);
    expect(bodies(resolveSelfProjection(d2, 'src').content)).toEqual(['ALPHA-edited', 'charlie']);
  });

  it('flags a missing source heading', () => {
    const d = doc([block('Src', 'src'), card('A', 'a')]);
    const p = resolveSelfProjection(d, 'gone');
    expect(p.missing).toBe(true);
    expect(p.content.size).toBe(0);
  });

  it('inlines a nested self-ref (recursive projection)', () => {
    // Section "outer" contains a card + a self_ref onto "inner".
    const d = doc([
      block('Inner', 'inner'),
      card('I', 'inner-ev'),
      block('Outer', 'outer'),
      card('O', 'outer-ev'),
      selfRef('inner'),
      block('End', 'end'),
    ]);
    const p = resolveSelfProjection(d, 'outer');
    expect(p.missing).toBe(false);
    expect(p.cycle).toBe(false);
    // Outer's own card + the inlined inner section.
    expect(bodies(p.content)).toEqual(['outer-ev', 'inner-ev']);
  });

  it('detects and drops a direct cycle (A mirrors A)', () => {
    const d = doc([block('A', 'a'), card('C', 'c'), selfRef('a'), block('End', 'end')]);
    const p = resolveSelfProjection(d, 'a');
    expect(p.cycle).toBe(true);
    // The card is kept; the self-pointer is dropped (no infinite recursion).
    expect(bodies(p.content)).toEqual(['c']);
  });

  it('detects a transitive cycle (A → B → A)', () => {
    const d = doc([
      block('A', 'a'),
      card('CA', 'a-ev'),
      selfRef('b'),
      block('B', 'b'),
      card('CB', 'b-ev'),
      selfRef('a'),
      block('End', 'end'),
    ]);
    const p = resolveSelfProjection(d, 'a');
    expect(p.cycle).toBe(true);
    // A's card, then B's card (via A→B); B's ref back to A is dropped.
    expect(bodies(p.content)).toEqual(['a-ev', 'b-ev']);
  });

  // Memoization (perf): a heading referenced repeatedly is resolved once, but its
  // content is still MATERIALIZED per reference — the memo caches, it doesn't dedupe.
  it('materializes a repeatedly-referenced heading once per reference', () => {
    // H → M, M ; M → G, G ; G is one card. So H inlines M twice, each M inlines G
    // twice → 4 copies of G's card.
    const d = doc([
      block('G', 'g'),
      card('GC', 'g-ev'),
      block('M', 'm'),
      selfRef('g'),
      selfRef('g'),
      block('H', 'h'),
      selfRef('m'),
      selfRef('m'),
      block('End', 'end'),
    ]);
    const p = resolveSelfProjection(d, 'h');
    expect(p.cycle).toBe(false);
    expect(bodies(p.content)).toEqual(['g-ev', 'g-ev', 'g-ev', 'g-ev']);
  });

  it('breaks a cycle even when the cyclic heading is also referenced off-cycle', () => {
    // A → B ; B → A (cycle, dropped) AND B → C (inlined). The memoized DFS must
    // still drop only the back-edge, not C.
    const d = doc([
      block('C', 'c'),
      card('CC', 'c-ev'),
      block('B', 'b'),
      selfRef('a'),
      selfRef('c'),
      block('A', 'a'),
      selfRef('b'),
      block('End', 'end'),
    ]);
    const p = resolveSelfProjection(d, 'a');
    expect(p.cycle).toBe(true);
    expect(bodies(p.content)).toEqual(['c-ev']); // B's back-ref to A dropped; C kept
  });
});

describe('resolveLiveReferenceProjection', () => {
  it('projects only anchored text and reflects later formatting changes', () => {
    const anchor = schema.marks['live_reference_source']!.create({ ids: 'ref-1' });
    const highlighted = schema.marks['highlight']!.create({ color: 'yellow' });
    const source = (marks: readonly import('prosemirror-model').Mark[]) =>
      doc([
        schema.nodes['card']!.createChecked(null, [
          schema.nodes['tag']!.create({ id: 'card-1' }, schema.text('Tag')),
          schema.nodes['card_body']!.create(null, [
            schema.text('before '),
            schema.text('selected', marks),
            schema.text(' after'),
          ]),
        ]),
      ]);

    const first = resolveLiveReferenceProjection(source([anchor]), 'ref-1');
    expect(first.missing).toBe(false);
    expect(first.content.textBetween(0, first.content.size)).toBe('selected');
    expect(first.content.firstChild!.firstChild!.marks).toHaveLength(0);

    const updated = resolveLiveReferenceProjection(source([anchor, highlighted]), 'ref-1');
    expect(updated.content.firstChild!.firstChild!.marks.map((m) => m.type.name)).toEqual([
      'highlight',
    ]);
  });
});

describe('flattenSelfRefs (.docx export) + .cmir round-trip', () => {
  let seq = 0;
  const freshId = (): string => `fresh-${seq++}`;

  it('materializes a self_ref to real cards, re-stamped (no id collision)', () => {
    const d = doc([
      block('Src', 'src'),
      card('A', 'alpha', 'orig-id'),
      block('Elsewhere', 'oth'),
      selfRef('src'),
    ]);
    const flat = flattenSelfRefs(d, freshId);
    // No self_ref survives.
    let refs = 0;
    flat.descendants((n) => {
      if (isSelfRef(n)) refs++;
      return true;
    });
    expect(refs).toBe(0);
    // The window materialized to a copy of 'alpha'.
    expect(bodies(flat.content)).toEqual(['alpha', 'alpha']);
    // The materialized copy's tag id was re-stamped, not the source's 'orig-id'.
    const ids: string[] = [];
    flat.descendants((n) => {
      if (n.type.name === 'tag') ids.push(String(n.attrs['id']));
      return true;
    });
    expect(ids.filter((id) => id === 'orig-id')).toHaveLength(1); // only the source keeps it
    expect(new Set(ids).size).toBe(ids.length); // all unique
  });

  it('a self_ref round-trips through .cmir JSON by reference (no content baked in)', () => {
    const n = selfRef('src', '↳ Source');
    const json = n.toJSON();
    // No content array — it's a reference, not a copy.
    expect(json.content).toBeUndefined();
    const back = schema.nodeFromJSON(json);
    expect(isSelfRef(back)).toBe(true);
    expect(back.attrs['source_heading_id']).toBe('src');
    expect(back.attrs['source_label']).toBe('↳ Source');
  });
});

describe('flattenSelfRefsInSlice / fragmentHasSelfRef (copy · send · drag)', () => {
  let seq = 0;
  const freshId = (): string => `sq-${seq++}`;

  it('detects a self_ref anywhere in a fragment', () => {
    expect(fragmentHasSelfRef(Fragment.fromArray([card('A', 'a')]))).toBe(false);
    expect(fragmentHasSelfRef(Fragment.fromArray([card('A', 'a'), selfRef('x')]))).toBe(true);
  });

  it('materializes a live view in a slice, resolving against the source doc', () => {
    const src = doc([block('Src', 'src'), card('A', 'alpha'), block('End', 'end'), selfRef('src')]);
    // A slice of just the trailing self_ref (as a copy of the live view would be).
    const from = src.content.size - selfRef('src').nodeSize;
    const slice = src.slice(from, src.content.size);
    expect(fragmentHasSelfRef(slice.content)).toBe(true);
    const flat = flattenSelfRefsInSlice(slice, src, freshId);
    // No self_ref survives; it became a copy of Src's content.
    expect(fragmentHasSelfRef(flat.content)).toBe(false);
    expect(bodies(flat.content)).toEqual(['alpha']);
  });

  it('leaves a self_ref-free slice untouched (same object)', () => {
    const src = doc([block('Src', 'src'), card('A', 'alpha')]);
    const slice = src.slice(0, src.content.size);
    expect(flattenSelfRefsInSlice(slice, src, freshId)).toBe(slice);
  });
});
