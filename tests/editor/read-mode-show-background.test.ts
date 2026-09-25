// @vitest-environment jsdom
/**
 * "Read mode: show background color" (2026-09-24): with the setting on,
 * text carrying `shading` is kept in read mode beside highlighted text —
 * so a pass locked to background (Lock Highlighting) still shows while
 * reading a re-highlight. Off, only highlighted runs are kept as before.
 * Either way the word count does not move: the counter excludes shading.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { readModePlugin, PMD_READ_MODE_TOGGLE, isReadModeKeptText } from '../../src/editor/read-mode-plugin.js';
import { countReadAloudSplit, totalWords } from '../../src/editor/word-count.js';
import { settings } from '../../src/editor/settings.js';

const before = settings.get('readModeShowBackground');
afterEach(() => settings.set('readModeShowBackground', before));

const hl = () => schema.marks['highlight']!.create({ color: 'yellow' });
const shd = () => schema.marks['shading']!.create({ color: 'D2D2D2' });

function buildDoc(): PMNode {
  return schema.nodes['doc']!.createChecked(null, [
    schema.nodes['card']!.createChecked(null, [
      schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('Tag words')),
      schema.nodes['card_body']!.create(null, [
        schema.text('plain filler '),
        schema.text('locked old pass ', [shd()]),
        schema.text('fresh highlight', [hl()]),
      ]),
    ]),
  ]);
}
function readModeView(doc: PMNode): EditorView {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const view = new EditorView(el, { state: EditorState.create({ doc, plugins: [readModePlugin] }) });
  view.dispatch(view.state.tr.setMeta(PMD_READ_MODE_TOGGLE, true));
  return view;
}
function classOf(view: EditorView, needle: string): string | null {
  for (const el of view.dom.querySelectorAll('.pmd-rm-keep, .pmd-rm-hide')) {
    if (el.textContent?.includes(needle)) return el.classList.contains('pmd-rm-keep') ? 'keep' : 'hide';
  }
  return null;
}

describe('"Read mode: show background color"', () => {
  it('off: background-colored text is hidden, highlighted text kept', () => {
    settings.set('readModeShowBackground', false);
    const view = readModeView(buildDoc());
    expect(classOf(view, 'plain filler')).toBe('hide');
    expect(classOf(view, 'locked old pass')).toBe('hide');
    expect(classOf(view, 'fresh highlight')).toBe('keep');
  });

  it('on: background-colored text is kept too; plain text still hidden', () => {
    settings.set('readModeShowBackground', true);
    const view = readModeView(buildDoc());
    expect(classOf(view, 'plain filler')).toBe('hide');
    expect(classOf(view, 'locked old pass')).toBe('keep');
    expect(classOf(view, 'fresh highlight')).toBe('keep');
  });

  it('the shared predicate follows it, so Convert Cards to Read Mode does too', () => {
    const body = buildDoc().child(0).child(1);
    const shaded = body.child(1);
    settings.set('readModeShowBackground', false);
    expect(isReadModeKeptText(shaded, body)).toBe(false);
    settings.set('readModeShowBackground', true);
    expect(isReadModeKeptText(shaded, body)).toBe(true);
  });

  it('never changes the word count or read time: shaded text stays uncounted', () => {
    const doc = buildDoc();
    settings.set('readModeShowBackground', false);
    const off = countReadAloudSplit(doc);
    settings.set('readModeShowBackground', true);
    const on = countReadAloudSplit(doc);
    expect(on).toEqual(off);
    // tag (2, other) + highlighted body (2, body)
    expect(totalWords(on)).toBe(4);
    expect(on.body).toBe(2);
  });
});
