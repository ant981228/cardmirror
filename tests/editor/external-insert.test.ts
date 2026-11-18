// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  buildExternalInsertTransaction,
  type ExternalInsertRole,
} from '../../src/editor/external-insert.js';
import { absorbPlugin } from '../../src/editor/absorb-plugin.js';

function tag(text: string, id = newHeadingId()) {
  return schema.nodes['tag']!.create({ id }, schema.text(text));
}
function cardBody(text: string) {
  return text
    ? schema.nodes['card_body']!.create(null, schema.text(text))
    : schema.nodes['card_body']!.create(null, []);
}
function paragraph(text: string) {
  return text
    ? schema.nodes['paragraph']!.create(null, schema.text(text))
    : schema.nodes['paragraph']!.create(null, []);
}
function cardWith(...children: any[]) {
  return schema.nodes['card']!.createChecked(null, children);
}
function makeDoc(children: any[]) {
  return schema.nodes['doc']!.createChecked(null, children);
}

function makeState(doc: any): EditorState {
  return EditorState.create({ doc, plugins: [absorbPlugin] });
}

function shapeOf(doc: any): string[] {
  const out: string[] = [];
  doc.forEach((child: any) => {
    if (child.type.name === 'card' || child.type.name === 'analytic_unit') {
      const inner: string[] = [];
      child.forEach((g: any) => inner.push(`${g.type.name}("${g.textContent}")`));
      out.push(`${child.type.name}[${inner.join(', ')}]`);
    } else {
      out.push(`${child.type.name}("${child.textContent}")`);
    }
  });
  return out;
}

function findPos(doc: any, predicate: (n: any) => boolean, off = 0): number {
  let pos = -1;
  doc.descendants((n: any, p: number) => {
    if (pos !== -1) return false;
    if (predicate(n)) {
      pos = n.isText ? p + off : p + 1 + off;
      return false;
    }
    return true;
  });
  if (pos < 0) throw new Error('predicate not matched');
  return pos;
}

describe('buildExternalInsertTransaction — newParagraph=true (card / cite)', () => {
  it('single-line text mid-card_body → splits at cursor; merges with after-half', () => {
    // Mirrors "press Return; F2 paste 'X'" with cursor mid-card_body.
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('hello world')),
    ]);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(
        TextSelection.create(doc, findPos(doc, (n) => n.isText && n.text === 'hello world', 6)),
      ),
    );
    const plan = buildExternalInsertTransaction(state, { text: 'X', newParagraph: true });
    expect(plan).not.toBeNull();
    const after = state.apply(plan!.tr);
    expect(shapeOf(after.doc)).toEqual([
      'card[tag("TAG"), card_body("hello "), card_body("Xworld")]',
    ]);
  });

  it('multi-line text mid-card_body → multiple card_body siblings, all in the same card', () => {
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('hello world')),
    ]);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(
        TextSelection.create(doc, findPos(doc, (n) => n.isText && n.text === 'hello world', 6)),
      ),
    );
    const plan = buildExternalInsertTransaction(state, { text: 'X\nY\nZ', newParagraph: true });
    expect(plan).not.toBeNull();
    const after = state.apply(plan!.tr);
    expect(shapeOf(after.doc)).toEqual([
      'card[tag("TAG"), card_body("hello "), card_body("X"), card_body("Y"), card_body("Zworld")]',
    ]);
  });

  it('multi-line text at END of card_body → trailing bodies become siblings, last merges with empty after-half', () => {
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('hello')),
    ]);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(
        TextSelection.create(doc, findPos(doc, (n) => n.isText && n.text === 'hello', 5)),
      ),
    );
    const plan = buildExternalInsertTransaction(state, { text: 'X\nY', newParagraph: true });
    expect(plan).not.toBeNull();
    const after = state.apply(plan!.tr);
    expect(shapeOf(after.doc)).toEqual([
      'card[tag("TAG"), card_body("hello"), card_body("X"), card_body("Y")]',
    ]);
  });

  it('text at START of card_body → leading bodies become siblings before original content', () => {
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('hello')),
    ]);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(
        TextSelection.create(doc, findPos(doc, (n) => n.isText && n.text === 'hello', 0)),
      ),
    );
    const plan = buildExternalInsertTransaction(state, { text: 'X\nY', newParagraph: true });
    expect(plan).not.toBeNull();
    const after = state.apply(plan!.tr);
    // Empty before-split collapses (no orphan empty card_body left);
    // X is the new first sibling; Y's content merges with the
    // remaining "hello" via the open end.
    expect(shapeOf(after.doc)).toEqual([
      'card[tag("TAG"), card_body("X"), card_body("Yhello")]',
    ]);
  });

  it('text in card with multi-line — every line is a card_body, no tag promotion, no escape', () => {
    // Critical test mirroring the spec's §9 multi-line `card` curl
    // case. Multi-line `card`-role insert must keep every line as a
    // card_body inside the SAME card, no matter how many newlines.
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('body')),
    ]);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(
        TextSelection.create(doc, findPos(doc, (n) => n.isText && n.text === 'body', 4)),
      ),
    );
    const plan = buildExternalInsertTransaction(state, {
      text: 'First line of the card.\nSecond line.\nThird line.',
      newParagraph: true,
    });
    expect(plan).not.toBeNull();
    const after = state.apply(plan!.tr);
    expect(shapeOf(after.doc)).toEqual([
      'card[tag("TAG"), card_body("body"), card_body("First line of the card."), card_body("Second line."), card_body("Third line.")]',
    ]);
  });

  it('at doc level (no card / analytic_unit ancestor): uses `paragraph`, not `card_body`', () => {
    const doc = makeDoc([
      paragraph('top-level paragraph'),
    ]);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(
        TextSelection.create(doc, findPos(doc, (n) => n.isText && n.text === 'top-level paragraph', 9)),
      ),
    );
    const plan = buildExternalInsertTransaction(state, { text: 'X\nY', newParagraph: true });
    expect(plan).not.toBeNull();
    const after = state.apply(plan!.tr);
    expect(shapeOf(after.doc)).toEqual([
      'paragraph("top-level")',
      'paragraph("X")',
      'paragraph("Y paragraph")',
    ]);
  });

  it('newParagraph=true with empty text — still inserts a fresh empty body paragraph', () => {
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('hello')),
    ]);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(
        TextSelection.create(doc, findPos(doc, (n) => n.isText && n.text === 'hello', 5)),
      ),
    );
    const plan = buildExternalInsertTransaction(state, { text: '', newParagraph: true });
    expect(plan).not.toBeNull();
    const after = state.apply(plan!.tr);
    expect(shapeOf(after.doc)).toEqual([
      'card[tag("TAG"), card_body("hello"), card_body("")]',
    ]);
  });

  it('text ends in newline → trailing empty body paragraph (matches the F2 "fresh line" case)', () => {
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('hello')),
    ]);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(
        TextSelection.create(doc, findPos(doc, (n) => n.isText && n.text === 'hello', 5)),
      ),
    );
    const plan = buildExternalInsertTransaction(state, { text: 'X\n', newParagraph: true });
    expect(plan).not.toBeNull();
    const after = state.apply(plan!.tr);
    expect(shapeOf(after.doc)).toEqual([
      'card[tag("TAG"), card_body("hello"), card_body("X"), card_body("")]',
    ]);
  });
});

describe('buildExternalInsertTransaction — heading roles', () => {
  // Cursor mid-body of the doc's only card, for every case below.
  function stateInCard() {
    const doc = makeDoc([cardWith(tag('TAG'), cardBody('hello world'))]);
    return makeState(doc).apply(
      makeState(doc).tr.setSelection(
        TextSelection.create(doc, findPos(doc, (n) => n.isText && n.text === 'hello world', 6)),
      ),
    );
  }

  function shapeAfter(role: any, text = 'X') {
    const state = stateInCard();
    const plan = buildExternalInsertTransaction(state, { text, role, newParagraph: true });
    expect(plan).not.toBeNull();
    return shapeOf(state.apply(plan!.tr).doc);
  }

  it('analytic — lands in its own analytic_unit, leaving the card whole', () => {
    expect(shapeAfter('analytic')).toEqual([
      'card[tag("TAG"), card_body("hello world")]',
      'analytic_unit[analytic("X")]',
    ]);
  });

  it('tag — lands as a new card headed by that tag', () => {
    expect(shapeAfter('tag')).toEqual([
      'card[tag("TAG"), card_body("hello world")]',
      'card[tag("X")]',
    ]);
  });

  it.each(['pocket', 'hat', 'block'])('%s — lands as a bare doc-level heading', (role) => {
    expect(shapeAfter(role)).toEqual([
      'card[tag("TAG"), card_body("hello world")]',
      `${role}("X")`,
    ]);
  });

  it('one heading per line', () => {
    expect(shapeAfter('analytic', 'first\nsecond')).toEqual([
      'card[tag("TAG"), card_body("hello world")]',
      'analytic_unit[analytic("first")]',
      'analytic_unit[analytic("second")]',
    ]);
  });

  it('stamps a heading id — an id-less heading is invisible to the nav pane', () => {
    const state = stateInCard();
    const plan = buildExternalInsertTransaction(state, {
      text: 'X',
      role: 'block',
      newParagraph: true,
    });
    const ids: unknown[] = [];
    state.apply(plan!.tr).doc.descendants((n: any) => {
      if (n.type.name === 'block') ids.push(n.attrs['id']);
    });
    expect(ids).toHaveLength(1);
    expect(typeof ids[0]).toBe('string');
  });

  it('reports every heading it created — where it landed, its id, its line', () => {
    // The `/insert` ack mints one provenance token per entry, so the
    // reported content start must hold exactly that line in the doc the
    // transaction produces.
    const state = stateInCard();
    const plan = buildExternalInsertTransaction(state, {
      text: 'first\nsecond\nthird',
      role: 'analytic',
      newParagraph: true,
    });
    const after = state.apply(plan!.tr);
    expect(plan!.headings.map((h) => h.text)).toEqual(['first', 'second', 'third']);
    for (const h of plan!.headings) {
      const $at = after.doc.resolve(h.contentStart);
      expect($at.parent.type.name).toBe('analytic');
      expect($at.parentOffset).toBe(0);
      expect($at.parent.textContent).toBe(h.text);
      expect($at.parent.attrs['id']).toBe(h.headingId);
      expect(h.type).toBe('analytic');
    }
    // Document order, and one entry per line — not per node inserted.
    const starts = plan!.headings.map((h) => h.contentStart);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it('a bare heading and a wrapped one both report their own content start', () => {
    // `pocket` goes in alone, `tag` inside a fresh card: one token to
    // enter the first, two the second.
    for (const role of ['pocket', 'tag'] as const) {
      const state = stateInCard();
      const plan = buildExternalInsertTransaction(state, { text: 'L', role, newParagraph: true });
      const $at = state.apply(plan!.tr).doc.resolve(plan!.headings[0]!.contentStart);
      expect($at.parent.type.name).toBe(role);
      expect($at.parent.textContent).toBe('L');
    }
  });

  it('a blank line still reports a heading — an empty tag is addressable text', () => {
    const state = stateInCard();
    const plan = buildExternalInsertTransaction(state, {
      text: 'X\n',
      role: 'block',
      newParagraph: true,
    });
    expect(plan!.headings.map((h) => h.text)).toEqual(['X', '']);
    const $at = state.apply(plan!.tr).doc.resolve(plan!.headings[1]!.contentStart);
    expect($at.parent.type.name).toBe('block');
    expect($at.parent.textContent).toBe('');
  });

  it('body / omitted role still build body paragraphs', () => {
    const expected = ['card[tag("TAG"), card_body("hello "), card_body("Xworld")]'];
    expect(shapeAfter('body')).toEqual(expected);
    expect(shapeAfter(undefined)).toEqual(expected);
  });

  it.each<ExternalInsertRole | undefined>(['body', 'card', 'cite', undefined])(
    'role %s reports no headings — a card body is not addressable text',
    (role) => {
      // `/replace` and `/insert-after` refuse card bodies as `body-text`,
      // so there is nothing here for a caller to be handed.
      const state = stateInCard();
      const plan = buildExternalInsertTransaction(state, { text: 'X\nY', role, newParagraph: true });
      expect(plan!.headings).toEqual([]);
    },
  );
});

describe('buildExternalInsertTransaction — newParagraph=false (inline)', () => {
  it('inserts text at cursor with no block break', () => {
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('hello world')),
    ]);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(
        TextSelection.create(doc, findPos(doc, (n) => n.isText && n.text === 'hello world', 6)),
      ),
    );
    const plan = buildExternalInsertTransaction(state, { text: 'INSERTED', newParagraph: false });
    expect(plan).not.toBeNull();
    const after = state.apply(plan!.tr);
    expect(shapeOf(after.doc)).toEqual([
      'card[tag("TAG"), card_body("hello INSERTEDworld")]',
    ]);
  });

  it('with leading space (client convention) — inserts as-is', () => {
    // §4.2: "The client may include a leading space in `text`;
    // insert it as-is. CardMirror should not add or trim spacing."
    const doc = makeDoc([
      cardWith(tag('TAG'), cardBody('see also')),
    ]);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(
        TextSelection.create(doc, findPos(doc, (n) => n.isText && n.text === 'see also', 8)),
      ),
    );
    const plan = buildExternalInsertTransaction(state, { text: ' citation note', newParagraph: false });
    expect(plan).not.toBeNull();
    const after = state.apply(plan!.tr);
    expect(shapeOf(after.doc)).toEqual([
      'card[tag("TAG"), card_body("see also citation note")]',
    ]);
  });

  it('reports no headings — inline text is part of a block nobody named', () => {
    const doc = makeDoc([cardWith(tag('TAG'), cardBody('hello world'))]);
    const state = makeState(doc).apply(
      makeState(doc).tr.setSelection(
        TextSelection.create(doc, findPos(doc, (n) => n.isText && n.text === 'hello world', 6)),
      ),
    );
    const plan = buildExternalInsertTransaction(state, { text: 'X', role: 'tag', newParagraph: false });
    // The role still outranks `newParagraph` — a heading role reports its
    // headings either way; only true inline mode reports none.
    expect(plan!.headings).toHaveLength(1);
    const inline = buildExternalInsertTransaction(state, { text: 'X', newParagraph: false });
    expect(inline!.headings).toEqual([]);
  });
});
