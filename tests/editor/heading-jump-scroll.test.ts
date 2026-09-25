// @vitest-environment jsdom
/**
 * Go to Next / Previous Pocket … Tag land the heading where a nav-pane
 * click puts it (2026-09-25): the heading's own `data-id` element is
 * scrolled with `block: 'start'` (the headings' scroll-margin then holds
 * it just under the ribbon), instead of the transaction's minimal
 * scroll, which left it flush with the edge the caret came from.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { moveToHeadingOfType } from '../../src/editor/word-selection-keymap.js';

interface ScrollCall { el: Element; opts: unknown }
const calls: ScrollCall[] = [];
const original = Element.prototype.scrollIntoView;

beforeEach(() => {
  calls.length = 0;
  Element.prototype.scrollIntoView = function (this: Element, opts?: unknown) {
    calls.push({ el: this, opts });
  };
});
afterEach(() => {
  Element.prototype.scrollIntoView = original;
});

function mount() {
  const tagId = newHeadingId();
  const doc = schema.nodes['doc']!.createChecked(null, [
    schema.nodes['paragraph']!.create(null, schema.text('intro text')),
    schema.nodes['card']!.createChecked(null, [
      schema.nodes['tag']!.create({ id: tagId }, schema.text('THE TAG')),
      schema.nodes['card_body']!.create(null, schema.text('body words')),
    ]),
  ]);
  const el = document.createElement('div');
  document.body.appendChild(el);
  const view = new EditorView(el, { state: EditorState.create({ doc }) });
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
  return { view, tagId };
}

describe('Go to Next Tag scrolling', () => {
  it("scrolls the heading's own element to the top, like a nav-pane click", () => {
    const { view, tagId } = mount();
    expect(moveToHeadingOfType('tag', 'next')(view.state, view.dispatch, view)).toBe(true);
    expect(view.state.selection.$head.parent.textContent).toBe('THE TAG');
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const first = calls[0]!;
    expect(first.el.getAttribute('data-id')).toBe(tagId);
    expect(first.opts).toMatchObject({ block: 'start' });
    view.destroy();
  });

  it('still moves the caret with no view (the minimal scroll path)', () => {
    const { view } = mount();
    let next: EditorState | null = null;
    expect(moveToHeadingOfType('tag', 'next')(view.state, (tr) => { next = view.state.apply(tr); })).toBe(true);
    expect(next!.selection.$head.parent.textContent).toBe('THE TAG');
    expect(calls).toHaveLength(0);
    view.destroy();
  });
});
