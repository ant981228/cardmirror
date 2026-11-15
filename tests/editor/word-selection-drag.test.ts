// @vitest-environment jsdom
/**
 * Single-click drag dynamic granularity — direction-based head
 * (field request 2026-07-15, simplified after two feel-test rounds):
 * moving AWAY from the anchor (the drag's extension direction) snaps
 * word-by-word; moving back TOWARD the anchor is always character-
 * precise. A long word-by-word sweep terminates mid-word by backing
 * up to the exact endpoint, in one gesture. Stationary pointer
 * re-reports are no-ops (the flicker source in round one).
 *
 * Drives `extendActiveEndTo` directly with synthetic doc positions
 * (the drag listeners only translate mouse coords into exactly these
 * calls), asserting on the live view selection after each move.
 */
import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  wordSelectionPlugin,
  createPointAnchor,
  extendActiveEndTo,
} from '../../src/editor/word-selection-plugin.js';
import { settings } from '../../src/editor/settings.js';

// One card body: "alpha bravo charlie delta echo"
const TEXT = 'alpha bravo charlie delta echo';

function makeView(): EditorView {
  const doc = schema.nodes['doc']!.create(null, [
    schema.nodes['card']!.createChecked(null, [
      schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('T')),
      schema.nodes['card_body']!.create(null, schema.text(TEXT)),
    ]),
  ]);
  const container = document.createElement('div');
  document.body.appendChild(container);
  return new EditorView(container, {
    state: EditorState.create({ doc, plugins: [wordSelectionPlugin] }),
  });
}

/** Doc position of `offset` within the body text. */
function bodyPos(view: EditorView, offset: number): number {
  let base = -1;
  view.state.doc.descendants((n, pos) => {
    if (base < 0 && n.type.name === 'card_body') base = pos + 1;
    return base < 0;
  });
  return base + offset;
}

const sel = (view: EditorView): [number, number] => [
  view.state.selection.from,
  view.state.selection.to,
];

// Word offsets within TEXT: alpha 0-5, bravo 6-11, charlie 12-19,
// delta 20-25, echo 26-30 (bareUnit excludes the space).
const ALPHA = { from: 0, to: 5 };
const CHARLIE = { from: 12, to: 19 };
const DELTA = { from: 20, to: 25 };

describe('direction-based head during single-click drags', () => {
  it('moving away from the anchor snaps word-by-word', () => {
    const view = makeView();
    const p = (o: number): number => bodyPos(view, o);
    const anchor = createPointAnchor(view, p(2)); // mid-"alpha"
    extendActiveEndTo(view, anchor, p(15)); // mid-"charlie"
    expect(sel(view)).toEqual([p(ALPHA.from), p(CHARLIE.to)]);
    extendActiveEndTo(view, anchor, p(22)); // onward into delta
    expect(sel(view)).toEqual([p(ALPHA.from), p(DELTA.to)]);
    view.destroy();
  });

  it('any move back toward the anchor is character-precise — including multi-word retreats', () => {
    const view = makeView();
    const p = (o: number): number => bodyPos(view, o);
    const anchor = createPointAnchor(view, p(2));
    extendActiveEndTo(view, anchor, p(27)); // sweep out to echo
    extendActiveEndTo(view, anchor, p(26)); // one char back → precise
    expect(sel(view)).toEqual([p(ALPHA.from), p(26)]);
    extendActiveEndTo(view, anchor, p(15)); // long retreat into charlie → still precise
    expect(sel(view)).toEqual([p(ALPHA.from), p(15)]);
    view.destroy();
  });

  it('turning away again resumes snapping immediately', () => {
    const view = makeView();
    const p = (o: number): number => bodyPos(view, o);
    const anchor = createPointAnchor(view, p(2));
    extendActiveEndTo(view, anchor, p(22)); // out to delta
    extendActiveEndTo(view, anchor, p(14)); // back into charlie → precise
    extendActiveEndTo(view, anchor, p(16)); // forward again → snap
    expect(sel(view)).toEqual([p(ALPHA.from), p(CHARLIE.to)]);
    view.destroy();
  });

  it('flicker regression: stationary pointer re-reports are no-ops', () => {
    const view = makeView();
    const p = (o: number): number => bodyPos(view, o);
    const anchor = createPointAnchor(view, p(2));
    extendActiveEndTo(view, anchor, p(15)); // snap
    extendActiveEndTo(view, anchor, p(15)); // re-report — must not un-snap
    extendActiveEndTo(view, anchor, p(15));
    expect(sel(view)).toEqual([p(ALPHA.from), p(CHARLIE.to)]);
    // …and after a precise step, re-reports keep the precise head.
    extendActiveEndTo(view, anchor, p(14));
    extendActiveEndTo(view, anchor, p(14));
    expect(sel(view)).toEqual([p(ALPHA.from), p(14)]);
    view.destroy();
  });

  it('mirrors for leftward drags (away = leftward, back = rightward)', () => {
    const view = makeView();
    const p = (o: number): number => bodyPos(view, o);
    const anchor = createPointAnchor(view, p(28)); // mid-"echo"
    extendActiveEndTo(view, anchor, p(14)); // sweep left into charlie → snap
    expect(sel(view)).toEqual([p(CHARLIE.from), p(30)]);
    extendActiveEndTo(view, anchor, p(16)); // back toward anchor (rightward) → precise
    expect(sel(view)).toEqual([p(16), p(30)]);
    extendActiveEndTo(view, anchor, p(9)); // away again (leftward, into bravo) → snap
    expect(sel(view)).toEqual([p(6), p(30)]);
    view.destroy();
  });

  it('re-entering W0 still resets to exact point selection (existing rule intact)', () => {
    const view = makeView();
    const p = (o: number): number => bodyPos(view, o);
    const anchor = createPointAnchor(view, p(2));
    extendActiveEndTo(view, anchor, p(15));
    extendActiveEndTo(view, anchor, p(4)); // back inside alpha (W0)
    expect(sel(view)).toEqual([p(2), p(4)]); // exact point→pos
    view.destroy();
  });

  it('a doc-level position never installs an invalid selection (the below-content click)', () => {
    // Field bug 2026-07-27: clicking below the last line resolves to a
    // position whose parent is the DOC node. PM's TextSelection.create
    // doesn't throw there — it console.warns ONCE per session and
    // returns a broken selection, which was then dispatched into
    // state; every selection-dependent command silently no-oped until
    // a real text click. The chokepoint must coerce endpoints to
    // inline content instead.
    const view = makeView();
    const p = (o: number): number => bodyPos(view, o);
    const docEnd = view.state.doc.content.size; // parent = doc, no inline content
    const anchor = createPointAnchor(view, p(2));
    extendActiveEndTo(view, anchor, docEnd);
    expect(view.state.selection.$head.parent.inlineContent).toBe(true);
    expect(view.state.selection.$anchor.parent.inlineContent).toBe(true);
    view.destroy();
  });

  it('with dragSelectsWholeWords off, a drag past the first word stays character-precise', () => {
    settings.set('dragSelectsWholeWords', false);
    try {
      const view = makeView();
      const p = (o: number): number => bodyPos(view, o);
      const anchor = createPointAnchor(view, p(2)); // mid-"alpha"
      extendActiveEndTo(view, anchor, p(15)); // mid-"charlie", moving away
      expect(sel(view)).toEqual([p(2), p(15)]);
      view.destroy();
    } finally {
      settings.set('dragSelectsWholeWords', true);
    }
  });
});
