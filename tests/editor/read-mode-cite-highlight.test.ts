// @vitest-environment jsdom
/**
 * Read mode keeps HIGHLIGHTED text inside cite paragraphs.
 *
 * The schema makes underline/emphasis EXCLUDE cite_mark, so an
 * underlined-and-highlighted phrase in a cite could never carry the
 * cite mark — and the old "keep iff cite_mark" rule hid it in read
 * mode even though the user had explicitly highlighted it (field
 * find, 2026-08-14). Cites now keep cite_mark OR highlight; plain
 * un-marked cite filler stays hidden.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { readModePlugin, PMD_READ_MODE_TOGGLE, firstReadKeptPos } from '../../src/editor/read-mode-plugin.js';
import { settings } from '../../src/editor/settings.js';

function mkReadModeView(extra: PMNode[] = []): EditorView {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const cite = schema.nodes['cite_paragraph']!.create(null, [
    schema.text('AuthorName ', [schema.marks['cite_mark']!.create()]),
    schema.text('plain filler the reader skips '),
    schema.text('underlined and highlighted phrase', [
      schema.marks['underline_mark']!.create(),
      schema.marks['highlight']!.create({ color: 'yellow' }),
    ]),
  ]);
  const doc = schema.nodes['doc']!.createChecked(null, [
    schema.nodes['card']!.createChecked(null, [
      schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('Tag')),
      cite,
      schema.nodes['card_body']!.create(null, schema.text('body words')),
      ...extra,
    ]),
  ]);
  const view = new EditorView(el, {
    state: EditorState.create({ doc, plugins: [readModePlugin] }),
  });
  view.dispatch(view.state.tr.setMeta(PMD_READ_MODE_TOGGLE, true));
  return view;
}

function classOf(view: EditorView, needle: string): string | null {
  for (const el of view.dom.querySelectorAll('.pmd-rm-keep, .pmd-rm-hide')) {
    if (el.textContent?.includes(needle)) {
      return el.classList.contains('pmd-rm-keep') ? 'keep' : 'hide';
    }
  }
  return null;
}

describe('read mode in cite paragraphs', () => {
  it('keeps cite-marked and highlighted runs; hides plain filler', () => {
    const view = mkReadModeView();
    expect(classOf(view, 'AuthorName'), 'cite-marked text').toBe('keep');
    expect(classOf(view, 'underlined and highlighted'), 'highlighted text').toBe('keep');
    expect(classOf(view, 'plain filler'), 'unmarked filler').toBe('hide');
    view.destroy();
  });
});

describe('"Read mode: keep entire cite"', () => {
  const before = settings.get('readModeKeepEntireCite');
  afterEach(() => settings.set('readModeKeepEntireCite', before));

  it('shows the whole cite once it has any read-aloud run; body text is unaffected', () => {
    settings.set('readModeKeepEntireCite', true);
    const view = mkReadModeView();
    expect(classOf(view, 'AuthorName')).toBe('keep');
    expect(classOf(view, 'plain filler'), 'the unmarked quals now show').toBe('keep');
    expect(classOf(view, 'underlined and highlighted')).toBe('keep');
    expect(classOf(view, 'body words'), 'a body paragraph still keeps only highlights').toBe('hide');
    view.destroy();
  });

  it('a cite with nothing marked stays hidden, so an unmarked cite is never a stray line', () => {
    settings.set('readModeKeepEntireCite', true);
    const unmarked = schema.nodes['cite_paragraph']!.create(null, schema.text('nobody marked this cite'));
    const view = mkReadModeView([unmarked]);
    expect(classOf(view, 'nobody marked')).toBe('hide');
    view.destroy();
  });

  it('flipping the setting rebuilds on the next toggle, and the scroll anchor follows the same rule', () => {
    settings.set('readModeKeepEntireCite', false);
    const view = mkReadModeView();
    expect(classOf(view, 'plain filler')).toBe('hide');
    const citeStart = view.state.doc.child(0).child(0).nodeSize + 1;
    const fillerPos = citeStart + 1 + 'AuthorName '.length;
    // Off: the first kept position at or after the filler is the highlighted phrase.
    expect(firstReadKeptPos(view.state.doc, fillerPos, view.state.doc.content.size)).toBe(
      fillerPos + 'plain filler the reader skips '.length,
    );
    settings.set('readModeKeepEntireCite', true);
    view.dispatch(view.state.tr.setMeta(PMD_READ_MODE_TOGGLE, true)); // what both shells send on a flip
    expect(classOf(view, 'plain filler')).toBe('keep');
    expect(firstReadKeptPos(view.state.doc, fillerPos, view.state.doc.content.size)).toBe(fillerPos);
    view.destroy();
  });
});
