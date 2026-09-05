import { describe, expect, it, afterEach } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema } from '../../src/schema/index.js';
import { settings } from '../../src/editor/settings.js';
import {
  DEFAULT_RIBBON_KEYS,
  RIBBON_COMMAND_ALIASES,
  RIBBON_COMMAND_IDS,
  RIBBON_COMMAND_LABELS,
  getRibbonCommand,
} from '../../src/editor/ribbon-commands.js';

describe('Convert Cards to Read Mode command', () => {
  it('is available from the command palette without claiming a default shortcut', () => {
    const id = 'convertCardsToReadMode' as const;

    expect(RIBBON_COMMAND_IDS).toContain(id);
    expect(RIBBON_COMMAND_LABELS).toHaveProperty(id, 'Convert Cards to Read Mode');
    expect(DEFAULT_RIBBON_KEYS).toHaveProperty(id, '');
    expect(RIBBON_COMMAND_ALIASES).toHaveProperty(id, expect.arrayContaining(['zap card', 'zap cards']));
    expect(getRibbonCommand(id as never)).toEqual(expect.any(Function));
  });

  it('converts the cursor card to the same audible content as default read mode', () => {
    const highlight = schema.marks['highlight']!.create({ color: 'yellow' });
    const cite = schema.marks['cite_mark']!.create();
    const emphasis = schema.marks['emphasis_mark']!.create();
    const tag = schema.nodes['tag']!.create({ id: 'tag-1' }, schema.text('Tag stays'));
    const source = schema.nodes['cite_paragraph']!.create(null, [
      schema.text('ignore '),
      schema.text('Smith 24', [cite]),
      schema.text(' noise '),
      schema.text('p. 3', [highlight]),
    ]);
    const card = schema.nodes['card']!.createChecked(
      { numRole: 'number', numRestart: true },
      [
        tag,
        schema.nodes['undertag']!.create(null, schema.text('Undertag disappears')),
        source,
        schema.nodes['card_body']!.create(null, [
          schema.text('unread '),
          schema.text('first card text', [highlight]),
        ]),
        schema.nodes['card_body']!.create(null, [
          schema.text('more noise '),
          schema.text('second card text', [highlight, emphasis]),
        ]),
        schema.nodes['card_body']!.create(null, schema.text('all unread')),
      ],
    );
    const doc = schema.nodes['doc']!.createChecked(null, [card]);
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(doc, 2)));
    let next: EditorState | null = null;

    const handled = getRibbonCommand('convertCardsToReadMode')(
      state,
      (tr) => { next = state.apply(tr); },
    );

    expect(handled).toBe(true);
    expect(next).not.toBeNull();
    const converted = next!.doc.firstChild!;
    expect(converted.attrs).toMatchObject({ numRole: 'number', numRestart: true });
    expect(converted.childCount).toBe(3);
    expect(converted.child(0).type.name).toBe('tag');
    expect(converted.child(0).attrs['id']).toBe('tag-1');
    expect(converted.child(0).textContent).toBe('Tag stays');
    expect(converted.child(1).type.name).toBe('cite_paragraph');
    expect(converted.child(1).textContent).toBe('Smith 24 p. 3');
    expect(converted.child(2).type.name).toBe('card_body');
    expect(converted.child(2).textContent).toBe('first card text second card text');
    expect(converted.child(2).lastChild!.marks.map((mark) => mark.type.name)).toEqual([
      'emphasis_mark',
      'highlight',
    ]);
  });

  it('converts every selected card in one transaction without converting analytics', () => {
    const highlight = schema.marks['highlight']!.create({ color: 'yellow' });
    const makeCard = (id: string, kept: string) =>
      schema.nodes['card']!.createChecked(null, [
        schema.nodes['tag']!.create({ id }, schema.text(id)),
        schema.nodes['card_body']!.create(null, [
          schema.text('unread '),
          schema.text(kept, [highlight]),
        ]),
      ]);
    const analytic = schema.nodes['analytic_unit']!.createChecked(null, [
      schema.nodes['analytic']!.create({ id: 'analytic-1' }, schema.text('Analysis')),
      schema.nodes['card_body']!.create(null, [
        schema.text('analytic unread '),
        schema.text('analytic kept', [highlight]),
      ]),
    ]);
    const doc = schema.nodes['doc']!.createChecked(null, [
      makeCard('card-a', 'alpha'),
      analytic,
      makeCard('card-b', 'bravo'),
      makeCard('card-c', 'charlie'),
    ]);
    let cardBPos = -1;
    doc.forEach((node, offset) => {
      if (node.type.name === 'card' && node.firstChild!.attrs['id'] === 'card-b') cardBPos = offset;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(doc, 2, cardBPos + 2)),
    );
    let next: EditorState | null = null;
    let dispatches = 0;

    const handled = getRibbonCommand('convertCardsToReadMode')(
      state,
      (tr) => {
        dispatches++;
        next = state.apply(tr);
      },
    );

    expect(handled).toBe(true);
    expect(dispatches).toBe(1);
    expect(next!.doc.child(0).lastChild!.textContent).toBe('alpha');
    expect(next!.doc.child(1).eq(analytic)).toBe(true);
    expect(next!.doc.child(2).lastChild!.textContent).toBe('bravo');
    expect(next!.doc.child(3).lastChild!.textContent).toBe('unread charlie');
  });

  it('collects every audible body source into document order', () => {
    const highlight = schema.marks['highlight']!.create({ color: 'yellow' });
    const marker = schema.marks['font_color']!.create({ color: 'FF0000' });
    const firstCell = schema.nodes['table_cell']!.create(null, [
      schema.nodes['paragraph']!.create(null, [
        schema.text('cell noise '),
        schema.text('table alpha', [highlight]),
      ]),
    ]);
    const secondCell = schema.nodes['table_cell']!.create(null, [
      schema.nodes['paragraph']!.create(null, [
        schema.text('table bravo', [highlight]),
        schema.text(' more noise'),
      ]),
    ]);
    const table = schema.nodes['table']!.create(null, [
      schema.nodes['table_row']!.create(null, [
        firstCell,
        secondCell,
      ]),
    ]);
    const card = schema.nodes['card']!.createChecked(null, [
      schema.nodes['tag']!.create({ id: 'table-card' }, schema.text('Table card')),
      schema.nodes['card_body']!.create(null, [
        schema.text('body', [highlight]),
        schema.text(' hidden '),
        schema.text('marker', [marker]),
      ]),
      table,
    ]);
    const doc = schema.nodes['doc']!.createChecked(null, [card]);
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(doc, 2)));
    let next: EditorState | null = null;

    const handled = getRibbonCommand('convertCardsToReadMode')(
      state,
      (tr) => { next = state.apply(tr); },
    );

    expect(handled).toBe(true);
    expect(next!.doc.firstChild!.childCount).toBe(2);
    expect(next!.doc.firstChild!.lastChild!.textContent).toBe(
      'body marker table alpha table bravo',
    );
  });

  it('expands a within-card text selection to the whole card', () => {
    const highlight = schema.marks['highlight']!.create({ color: 'yellow' });
    const card = schema.nodes['card']!.createChecked(null, [
      schema.nodes['tag']!.create({ id: 'selected-card' }, schema.text('Selected card')),
      schema.nodes['card_body']!.create(null, [
        schema.text('unread prefix '),
        schema.text('kept words', [highlight]),
        schema.text(' unread suffix'),
      ]),
    ]);
    const doc = schema.nodes['doc']!.createChecked(null, [card]);
    let bodyStart = -1;
    doc.descendants((node, pos) => {
      if (node.type.name === 'card_body') bodyStart = pos + 1;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(doc, bodyStart + 2, bodyStart + 5)),
    );
    let next: EditorState | null = null;

    const handled = getRibbonCommand('convertCardsToReadMode')(
      state,
      (tr) => { next = state.apply(tr); },
    );

    expect(handled).toBe(true);
    expect(next!.doc.firstChild!.lastChild!.textContent).toBe('kept words');
  });

  it('preserves audible body and cite order', () => {
    const highlight = schema.marks['highlight']!.create({ color: 'yellow' });
    const cite = schema.marks['cite_mark']!.create();
    const card = schema.nodes['card']!.createChecked(null, [
      schema.nodes['tag']!.create({ id: 'ordered-card' }, schema.text('Ordered card')),
      schema.nodes['card_body']!.create(null, [
        schema.text('ignore '),
        schema.text('before', [highlight]),
      ]),
      schema.nodes['cite_paragraph']!.create(null, [
        schema.text('source', [cite]),
        schema.text(' ignored'),
      ]),
      schema.nodes['card_body']!.create(null, [
        schema.text('after', [highlight]),
        schema.text(' ignored'),
      ]),
    ]);
    const doc = schema.nodes['doc']!.createChecked(null, [card]);
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(doc, 2)));
    let next: EditorState | null = null;

    getRibbonCommand('convertCardsToReadMode')(
      state,
      (tr) => { next = state.apply(tr); },
    );

    const converted = next!.doc.firstChild!;
    expect(Array.from({ length: converted.childCount }, (_, index) =>
      converted.child(index).type.name,
    )).toEqual(['tag', 'card_body', 'cite_paragraph', 'card_body']);
    expect(Array.from({ length: converted.childCount }, (_, index) =>
      converted.child(index).textContent,
    )).toEqual(['Ordered card', 'before', 'source', 'after']);
  });

  it('keeps an undertag\'s highlighted text as an undertag, the way read mode reads it', () => {
    const highlight = schema.marks['highlight']!.create({ color: 'yellow' });
    const card = schema.nodes['card']!.createChecked(null, [
      schema.nodes['tag']!.create({ id: 'under-card' }, schema.text('Under card')),
      schema.nodes['undertag']!.create(null, [
        schema.text('unread under '),
        schema.text('kept under', [highlight]),
      ]),
      schema.nodes['card_body']!.create(null, [
        schema.text('unread '),
        schema.text('kept body', [highlight]),
      ]),
    ]);
    const doc = schema.nodes['doc']!.createChecked(null, [card]);
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(doc, 2)));
    let next: EditorState | null = null;

    getRibbonCommand('convertCardsToReadMode')(
      state,
      (tr) => { next = state.apply(tr); },
    );

    const converted = next!.doc.firstChild!;
    expect(Array.from({ length: converted.childCount }, (_, index) => converted.child(index).type.name))
      .toEqual(['tag', 'undertag', 'card_body']);
    expect(converted.child(1).textContent).toBe('kept under');
    expect(converted.child(2).textContent).toBe('kept body');
  });

  describe('follows read mode\'s paragraph-integrity setting', () => {
    const before = settings.get('readModeParagraphIntegrity');
    afterEach(() => settings.set('readModeParagraphIntegrity', before));

    function twoBodyCard() {
      const highlight = schema.marks['highlight']!.create({ color: 'yellow' });
      const card = schema.nodes['card']!.createChecked(null, [
        schema.nodes['tag']!.create({ id: 'para-card' }, schema.text('Paragraphs')),
        schema.nodes['card_body']!.create(null, [schema.text('unread '), schema.text('first', [highlight])]),
        schema.nodes['card_body']!.create(null, schema.text('nothing read here')),
        schema.nodes['card_body']!.create(null, [schema.text('second', [highlight]), schema.text(' unread')]),
      ]);
      const doc = schema.nodes['doc']!.createChecked(null, [card]);
      const base = EditorState.create({ doc });
      return base.apply(base.tr.setSelection(TextSelection.create(doc, 2)));
    }
    function convert(state: EditorState): EditorState {
      let next: EditorState | null = null;
      getRibbonCommand('convertCardsToReadMode')(state, (tr) => { next = state.apply(tr); });
      return next!;
    }

    it('off: the body paragraphs flow together into one', () => {
      settings.set('readModeParagraphIntegrity', false);
      const converted = convert(twoBodyCard()).doc.firstChild!;
      expect(converted.childCount).toBe(2);
      expect(converted.child(1).textContent).toBe('first second');
    });

    it('on: each paragraph with audible text keeps its own line; empty ones collapse', () => {
      settings.set('readModeParagraphIntegrity', true);
      const converted = convert(twoBodyCard()).doc.firstChild!;
      expect(converted.childCount).toBe(3);
      expect(converted.child(1).textContent).toBe('first');
      expect(converted.child(2).textContent).toBe('second');
    });
  });

  describe('follows "Read mode: keep entire cite"', () => {
    const before = settings.get('readModeKeepEntireCite');
    afterEach(() => settings.set('readModeKeepEntireCite', before));

    function citeCard() {
      const highlight = schema.marks['highlight']!.create({ color: 'yellow' });
      const cite = schema.marks['cite_mark']!.create();
      const card = schema.nodes['card']!.createChecked(null, [
        schema.nodes['tag']!.create({ id: 'cite-card' }, schema.text('Cites')),
        schema.nodes['cite_paragraph']!.create(null, [
          schema.text('Smith 24', [cite]),
          schema.text(' — professor of things, Journal, 2024, '),
          schema.text('p. 3', [highlight]),
        ]),
        schema.nodes['cite_paragraph']!.create(null, schema.text('an unmarked second cite')),
        schema.nodes['card_body']!.create(null, [schema.text('unread '), schema.text('read', [highlight])]),
      ]);
      const doc = schema.nodes['doc']!.createChecked(null, [card]);
      const base = EditorState.create({ doc });
      return base.apply(base.tr.setSelection(TextSelection.create(doc, 2)));
    }
    function convert(state: EditorState): EditorState {
      let next: EditorState | null = null;
      getRibbonCommand('convertCardsToReadMode')(state, (tr) => { next = state.apply(tr); });
      return next!;
    }

    it('off: only the marked and highlighted words of the cite survive', () => {
      settings.set('readModeKeepEntireCite', false);
      const converted = convert(citeCard()).doc.firstChild!;
      expect(converted.childCount).toBe(3);
      expect(converted.child(1).textContent).toBe('Smith 24 p. 3');
      expect(converted.child(2).textContent).toBe('read');
    });

    it('on: the whole cite survives; an unmarked cite still goes; the body is unchanged', () => {
      settings.set('readModeKeepEntireCite', true);
      const converted = convert(citeCard()).doc.firstChild!;
      expect(converted.childCount).toBe(3);
      expect(converted.child(1).type.name).toBe('cite_paragraph');
      expect(converted.child(1).textContent).toBe('Smith 24 — professor of things, Journal, 2024, p. 3');
      expect(converted.child(2).textContent).toBe('read');
    });
  });

  it('removes inline images that read mode hides from tags', () => {
    const image = schema.nodes['image']!.create({
      data: 'aGVsbG8=',
      contentType: 'image/png',
      widthEmu: 9525,
      heightEmu: 9525,
      alt: 'hidden image',
    });
    const tag = schema.nodes['tag']!.create({ id: 'image-tag' }, [
      schema.text('Visible '),
      image,
      schema.text('tag'),
    ]);
    const card = schema.nodes['card']!.createChecked(null, [
      tag,
      schema.nodes['card_body']!.create(null, schema.text('unread')),
    ]);
    const doc = schema.nodes['doc']!.createChecked(null, [card]);
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(doc, 2)));
    let next: EditorState | null = null;

    getRibbonCommand('convertCardsToReadMode')(
      state,
      (tr) => { next = state.apply(tr); },
    );

    const convertedTag = next!.doc.firstChild!.firstChild!;
    expect(convertedTag.textContent).toBe('Visible tag');
    expect(convertedTag.childCount).toBe(1);
    expect(convertedTag.firstChild!.isText).toBe(true);
  });
});
