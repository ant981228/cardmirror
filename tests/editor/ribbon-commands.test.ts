/**
 * Verbatim ribbon commands: structural hotkeys (F4–F7), character
 * styles (F8–F11), gap fixing, keymap/alias registry, paste helpers.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import { Fragment, Slice } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  setHeading,
  setTag,
  setAnalytic,
  setUndertag,
  applyCite,
  applyEmphasis,
  emphasizeAcronym,
  applyHighlight,
  highlightAcronym,
  applyShading,
  setHighlightColor,
  setShadingColor,
  setFontColor,
  copyPreviousCite,
  removeHyperlinks,
  convertAnalyticsToTags,
  convertCitedAnalyticsToTags,
  extractUndertag,
  fixFormattingGaps,
  buildRibbonKeymap,
  ribbonKeyStringFor,
  ribbonCommandForKey,
  DEFAULT_RIBBON_KEYS,
  RIBBON_COMMAND_IDS,
  RIBBON_COMMAND_LABELS,
  RIBBON_COMMAND_ALIASES,
  getRibbonCommand,
  type RibbonContext,
} from '../../src/editor/ribbon-commands.js';
import { SETTING_METADATA, settings } from '../../src/editor/settings.js';
import {
  buildPlainTextSlice,
  normalizeClipboardTextForPaste,
  tryPasteSplitContainer,
} from '../../src/editor/paste-plugin.js';

// ---- Doc builders ----

function paragraph(text: string) {
  return text
    ? schema.nodes['paragraph']!.create(null, schema.text(text))
    : schema.nodes['paragraph']!.create(null, []);
}

function pocket(text: string, id = newHeadingId()) {
  return schema.nodes['pocket']!.create({ id }, schema.text(text));
}

function hat(text: string, id = newHeadingId()) {
  return schema.nodes['hat']!.create({ id }, schema.text(text));
}

function block(text: string, id = newHeadingId()) {
  return schema.nodes['block']!.create({ id }, schema.text(text));
}

function tag(text: string, id = newHeadingId()) {
  return schema.nodes['tag']!.create({ id }, text ? schema.text(text) : []);
}

function cardWith(...children: ReturnType<typeof tag>[]) {
  return schema.nodes['card']!.createChecked(null, children);
}

function cardBody(text: string) {
  return text
    ? schema.nodes['card_body']!.create(null, schema.text(text))
    : schema.nodes['card_body']!.create(null, []);
}

function citePara(text: string) {
  return schema.nodes['cite_paragraph']!.create(null, schema.text(text));
}

function undertag(text: string) {
  return schema.nodes['undertag']!.create(null, schema.text(text));
}

function analytic(text: string, id = newHeadingId()) {
  return schema.nodes['analytic']!.create({ id }, schema.text(text));
}

function analyticUnit(...children: ReturnType<typeof analytic>[]) {
  return schema.nodes['analytic_unit']!.createChecked(null, children);
}

function makeDoc(children: ReturnType<typeof tag>[]) {
  return schema.nodes['doc']!.createChecked(null, children);
}

function apply(state: EditorState, cmd: Command): EditorState | null {
  let next: EditorState | null = null;
  const ok = cmd(state, (tr) => { next = state.apply(tr); });
  return ok ? next : null;
}

function cursorIn(doc: ReturnType<typeof makeDoc>, findFn: (node: import('prosemirror-model').Node) => boolean, offsetInside = 0): EditorState {
  let pos = -1;
  doc.descendants((node, p) => {
    if (pos !== -1) return false;
    if (findFn(node)) {
      pos = p + 1 + offsetInside;
      return false;
    }
    return true;
  });
  if (pos < 0) throw new Error('cursor target not found');
  const state = EditorState.create({ doc });
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}

// ---- Tests ----

describe('setHeading (F4/F5/F6)', () => {
  it('converts a doc-level paragraph to pocket', () => {
    const doc = makeDoc([paragraph('hello')]);
    const state = cursorIn(doc, (n) => n.type.name === 'paragraph');
    const next = apply(state, setHeading('pocket'));
    expect(next).not.toBeNull();
    expect(next!.doc.firstChild!.type.name).toBe('pocket');
    expect(next!.doc.firstChild!.textContent).toBe('hello');
    expect(typeof next!.doc.firstChild!.attrs['id']).toBe('string');
  });

  it('changes a pocket to a hat while preserving id', () => {
    const doc = makeDoc([pocket('hello', 'fixed-id')]);
    const state = cursorIn(doc, (n) => n.type.name === 'pocket');
    const next = apply(state, setHeading('hat'));
    expect(next!.doc.firstChild!.type.name).toBe('hat');
    expect(next!.doc.firstChild!.attrs['id']).toBe('fixed-id');
  });

  it('accepts a no-op when target type matches current (zero indent)', () => {
    const doc = makeDoc([pocket('hello', 'same-id')]);
    const state = cursorIn(doc, (n) => n.type.name === 'pocket');
    const next = apply(state, setHeading('pocket'));
    // Command returns true but doesn't dispatch (or dispatches a no-op).
    expect(next === null || next.doc.eq(doc)).toBe(true);
  });

  it('strips indent when re-applying the same heading shortcut', () => {
    const doc = makeDoc([
      schema.nodes['pocket']!.create(
        { id: 'p1', indent: 720 },
        schema.text('hello'),
      ),
    ]);
    const state = cursorIn(doc, (n) => n.type.name === 'pocket');
    const next = apply(state, setHeading('pocket'));
    expect(next).not.toBeNull();
    // Type and id preserved; indent zeroed out.
    expect(next!.doc.firstChild!.type.name).toBe('pocket');
    expect(next!.doc.firstChild!.attrs['id']).toBe('p1');
    expect(next!.doc.firstChild!.attrs['indent']).toBe(0);
    expect(next!.doc.firstChild!.textContent).toBe('hello');
  });

  it('dissolves a card-with-only-tag to a single pocket', () => {
    const doc = makeDoc([cardWith(tag('hello', 'tag-id'))]);
    const state = cursorIn(doc, (n) => n.type.name === 'tag');
    const next = apply(state, setHeading('pocket'));
    expect(next).not.toBeNull();
    expect(next!.doc.childCount).toBe(1);
    expect(next!.doc.firstChild!.type.name).toBe('pocket');
    expect(next!.doc.firstChild!.attrs['id']).toBe('tag-id');
    expect(next!.doc.firstChild!.textContent).toBe('hello');
  });

  it('dissolves a card with body and cite — body and cite become loose paragraphs', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('TheTag', 'tag-id'),
        citePara('Source 2024'),
        cardBody('Body text.'),
      ]),
    ]);
    const state = cursorIn(doc, (n) => n.type.name === 'tag');
    const next = apply(state, setHeading('block'));
    expect(next).not.toBeNull();
    const children = next!.doc.content.content;
    expect(children.map((c) => c.type.name)).toEqual(['block', 'paragraph', 'paragraph']);
    expect(children[0]!.textContent).toBe('TheTag');
    expect(children[1]!.textContent).toBe('Source 2024');
    expect(children[2]!.textContent).toBe('Body text.');
    expect(children[0]!.attrs['id']).toBe('tag-id');
  });

  it('preserves undertag when dissolving a card', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('TheTag'),
        undertag('sub note'),
        cardBody('body'),
      ]),
    ]);
    const state = cursorIn(doc, (n) => n.type.name === 'tag');
    const next = apply(state, setHeading('hat'));
    expect(next).not.toBeNull();
    const types = next!.doc.content.content.map((c) => c.type.name);
    expect(types).toEqual(['hat', 'undertag', 'paragraph']);
  });

  it('dissolves an analytic_unit on an analytic cursor', () => {
    const doc = makeDoc([
      analyticUnit(analytic('Alpha', 'analytic-id')),
    ]);
    const state = cursorIn(doc, (n) => n.type.name === 'analytic');
    const next = apply(state, setHeading('pocket'));
    expect(next).not.toBeNull();
    expect(next!.doc.childCount).toBe(1);
    expect(next!.doc.firstChild!.type.name).toBe('pocket');
    expect(next!.doc.firstChild!.attrs['id']).toBe('analytic-id');
  });

});

describe('setTag (F7)', () => {
  it('wraps a doc-level paragraph as a card+tag', () => {
    const doc = makeDoc([paragraph('claim')]);
    const state = cursorIn(doc, (n) => n.type.name === 'paragraph');
    const next = apply(state, setTag());
    expect(next).not.toBeNull();
    expect(next!.doc.childCount).toBe(1);
    expect(next!.doc.firstChild!.type.name).toBe('card');
    expect(next!.doc.firstChild!.firstChild!.type.name).toBe('tag');
    expect(next!.doc.firstChild!.firstChild!.textContent).toBe('claim');
  });

  it('wraps a pocket as a card+tag preserving id', () => {
    const doc = makeDoc([pocket('claim', 'orig-id')]);
    const state = cursorIn(doc, (n) => n.type.name === 'pocket');
    const next = apply(state, setTag());
    expect(next).not.toBeNull();
    const tagNode = next!.doc.firstChild!.firstChild!;
    expect(tagNode.type.name).toBe('tag');
    expect(tagNode.attrs['id']).toBe('orig-id');
    expect(tagNode.textContent).toBe('claim');
  });

  it('accepts a no-op when cursor is already in a tag', () => {
    const doc = makeDoc([cardWith(tag('x'))]);
    const state = cursorIn(doc, (n) => n.type.name === 'tag');
    const next = apply(state, setTag());
    expect(next === null || next.doc.eq(doc)).toBe(true);
  });

  it('converts analytic_unit to card; analytic to tag; preserves children', () => {
    const doc = makeDoc([
      schema.nodes['analytic_unit']!.createChecked(null, [
        analytic('claim', 'a-id'),
        cardBody('body'),
        undertag('sub'),
      ]),
    ]);
    const state = cursorIn(doc, (n) => n.type.name === 'analytic');
    const next = apply(state, setTag());
    expect(next).not.toBeNull();
    const card = next!.doc.firstChild!;
    expect(card.type.name).toBe('card');
    const childTypes: string[] = [];
    card.forEach((c) => childTypes.push(c.type.name));
    expect(childTypes).toEqual(['tag', 'card_body', 'undertag']);
    expect(card.firstChild!.attrs['id']).toBe('a-id');
    expect(card.firstChild!.textContent).toBe('claim');
  });

  it('places the cursor inside the new tag at the same offset', () => {
    const doc = makeDoc([paragraph('hello world')]);
    const state = cursorIn(doc, (n) => n.type.name === 'paragraph', 6);
    const next = apply(state, setTag());
    expect(next).not.toBeNull();
    const sel = next!.selection;
    expect(sel.$from.parent.type.name).toBe('tag');
    expect(sel.$from.parentOffset).toBe(6);
  });
});

// ---- Card-body splits ----

function findNthCardBody(doc: ReturnType<typeof makeDoc>, n: number): number {
  let count = 0;
  let pos = -1;
  doc.descendants((node, p) => {
    if (pos !== -1) return false;
    if (node.type.name === 'card_body') {
      if (count === n) pos = p + 1;
      count++;
    }
    return true;
  });
  if (pos < 0) throw new Error(`card_body #${n} not found`);
  return pos;
}

function cursorAtCardBody(doc: ReturnType<typeof makeDoc>, n: number): EditorState {
  const pos = findNthCardBody(doc, n);
  const state = EditorState.create({ doc });
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}

describe('setHeading on a card_body — splits the card', () => {
  it('cursor in middle body: leaves [tag, prefix] in card; body becomes heading; following bodies become loose paragraphs', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('TheTag'),
        cardBody('body1'),
        cardBody('body2'),
        cardBody('body3'),
      ]),
    ]);
    const state = cursorAtCardBody(doc, 1); // body2
    const next = apply(state, setHeading('pocket'));
    expect(next).not.toBeNull();
    const types = next!.doc.content.content.map((c) => c.type.name);
    expect(types).toEqual(['card', 'pocket', 'paragraph']);
    const card = next!.doc.firstChild!;
    const cardChildren: string[] = [];
    card.forEach((c) => cardChildren.push(c.textContent));
    expect(cardChildren).toEqual(['TheTag', 'body1']);
    expect(next!.doc.content.content[1]!.textContent).toBe('body2');
    expect(next!.doc.content.content[2]!.textContent).toBe('body3');
  });

  it('cursor in first body: card keeps just the tag', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('TheTag'),
        cardBody('body1'),
        cardBody('body2'),
      ]),
    ]);
    const state = cursorAtCardBody(doc, 0);
    const next = apply(state, setHeading('block'));
    expect(next).not.toBeNull();
    const card = next!.doc.firstChild!;
    expect(card.childCount).toBe(1);
    expect(card.firstChild!.type.name).toBe('tag');
    const types = next!.doc.content.content.map((c) => c.type.name);
    expect(types).toEqual(['card', 'block', 'paragraph']);
  });

  it('cursor in last body: no trailing paragraphs', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('TheTag'),
        cardBody('body1'),
        cardBody('body2'),
      ]),
    ]);
    const state = cursorAtCardBody(doc, 1);
    const next = apply(state, setHeading('hat'));
    const types = next!.doc.content.content.map((c) => c.type.name);
    expect(types).toEqual(['card', 'hat']);
  });

  it('preserves cite_paragraph and undertag before the cursor body', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('TheTag'),
        undertag('sub'),
        citePara('cite'),
        cardBody('body1'),
        cardBody('body2'),
      ]),
    ]);
    const state = cursorAtCardBody(doc, 1); // body2
    const next = apply(state, setHeading('pocket'));
    const card = next!.doc.firstChild!;
    const cardTypes: string[] = [];
    card.forEach((c) => cardTypes.push(c.type.name));
    expect(cardTypes).toEqual(['tag', 'undertag', 'cite_paragraph', 'card_body']);
  });

  it('works inside an analytic_unit (same split semantics)', () => {
    const doc = makeDoc([
      schema.nodes['analytic_unit']!.createChecked(null, [
        analytic('A'),
        cardBody('body1'),
        cardBody('body2'),
      ]),
    ]);
    const state = cursorAtCardBody(doc, 1);
    const next = apply(state, setHeading('block'));
    const types = next!.doc.content.content.map((c) => c.type.name);
    expect(types).toEqual(['analytic_unit', 'block']);
    const unit = next!.doc.firstChild!;
    const unitTypes: string[] = [];
    unit.forEach((c) => unitTypes.push(c.type.name));
    expect(unitTypes).toEqual(['analytic', 'card_body']);
  });

  it('places the cursor inside the new heading at the same offset', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [tag('t'), cardBody('hello world')]),
    ]);
    const pos = findNthCardBody(doc, 0) + 6; // offset 6 inside "hello world"
    const state = EditorState.create({ doc }).apply(
      EditorState.create({ doc }).tr.setSelection(
        TextSelection.create(EditorState.create({ doc }).doc, pos),
      ),
    );
    const next = apply(state, setHeading('pocket'));
    const sel = next!.selection;
    expect(sel.$from.parent.type.name).toBe('pocket');
    expect(sel.$from.parentOffset).toBe(6);
  });
});

describe('heading commands on cite_paragraph and undertag cursors — splits like card_body', () => {
  it('F4 (setHeading pocket) on a cite_paragraph splits the card and converts to Pocket', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('T'),
        citePara('SourceCite'),
        cardBody('body after cite'),
      ]),
    ]);
    // Cursor inside the cite_paragraph (index 1 within the card).
    let pos = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'SourceCite') pos = p + 2;
      return true;
    });
    const state = EditorState.create({ doc }).apply(
      EditorState.create({ doc }).tr.setSelection(TextSelection.create(doc, pos)),
    );
    const next = apply(state, setHeading('pocket'));
    expect(next).not.toBeNull();
    const types = next!.doc.content.content.map((c) => c.type.name);
    expect(types).toEqual(['card', 'pocket', 'paragraph']);
    // Card keeps the tag only (cite was index 1 = first body, so no preceding bodies).
    const card = next!.doc.firstChild!;
    expect(card.childCount).toBe(1);
    expect(card.firstChild!.type.name).toBe('tag');
    expect(next!.doc.content.content[1]!.textContent).toBe('SourceCite');
    expect(next!.doc.content.content[2]!.textContent).toBe('body after cite');
  });

  it('F7 (setTag) on an undertag splits into two cards', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('First'),
        cardBody('preBody'),
        undertag('an undertag'),
        cardBody('postBody'),
      ]),
    ]);
    let pos = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'an undertag') pos = p + 2;
      return true;
    });
    const state = EditorState.create({ doc }).apply(
      EditorState.create({ doc }).tr.setSelection(TextSelection.create(doc, pos)),
    );
    const next = apply(state, setTag());
    expect(next).not.toBeNull();
    const types = next!.doc.content.content.map((c) => c.type.name);
    expect(types).toEqual(['card', 'card']);
    // First card keeps [tag, preBody]. New card has [new tag (from undertag text), postBody].
    const firstCard = next!.doc.firstChild!;
    const firstChildren: string[] = [];
    firstCard.forEach((c) => firstChildren.push(c.textContent));
    expect(firstChildren).toEqual(['First', 'preBody']);
    const secondCard = next!.doc.content.content[1]!;
    const secondChildren: string[] = [];
    secondCard.forEach((c) => secondChildren.push(c.textContent));
    expect(secondChildren[0]).toBe('an undertag');
    expect(secondCard.firstChild!.type.name).toBe('tag');
  });

  it('F4 (setHeading pocket) on a doc-level cite_paragraph converts in place', () => {
    const doc = makeDoc([citePara('SomeCite')]);
    const state = cursorIn(doc, (n) => n.type.name === 'cite_paragraph');
    const next = apply(state, setHeading('pocket'));
    expect(next).not.toBeNull();
    expect(next!.doc.firstChild!.type.name).toBe('pocket');
    expect(next!.doc.firstChild!.textContent).toBe('SomeCite');
    expect(next!.doc.firstChild!.attrs['id']).toBeDefined();
  });

  it('F4 (setHeading pocket) on a doc-level undertag converts in place', () => {
    const doc = makeDoc([undertag('an undertag')]);
    const state = cursorIn(doc, (n) => n.type.name === 'undertag');
    const next = apply(state, setHeading('pocket'));
    expect(next).not.toBeNull();
    expect(next!.doc.firstChild!.type.name).toBe('pocket');
    expect(next!.doc.firstChild!.textContent).toBe('an undertag');
  });

  it('F7 (setTag) on a doc-level undertag wraps it into a card+tag', () => {
    const doc = makeDoc([undertag('an undertag')]);
    const state = cursorIn(doc, (n) => n.type.name === 'undertag');
    const next = apply(state, setTag());
    expect(next).not.toBeNull();
    expect(next!.doc.firstChild!.type.name).toBe('card');
    expect(next!.doc.firstChild!.firstChild!.type.name).toBe('tag');
    expect(next!.doc.firstChild!.firstChild!.textContent).toBe('an undertag');
  });

  it('Mod-F7 (setAnalytic) on a cite_paragraph splits into card + analytic_unit', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('T'),
        cardBody('body1'),
        citePara('SomeCite'),
        cardBody('body2'),
      ]),
    ]);
    let pos = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'SomeCite') pos = p + 2;
      return true;
    });
    const state = EditorState.create({ doc }).apply(
      EditorState.create({ doc }).tr.setSelection(TextSelection.create(doc, pos)),
    );
    const next = apply(state, setAnalytic());
    expect(next).not.toBeNull();
    const types = next!.doc.content.content.map((c) => c.type.name);
    expect(types).toEqual(['card', 'analytic_unit']);
    const firstCard = next!.doc.firstChild!;
    const firstChildren: string[] = [];
    firstCard.forEach((c) => firstChildren.push(c.textContent));
    expect(firstChildren).toEqual(['T', 'body1']);
    const unit = next!.doc.content.content[1]!;
    expect(unit.firstChild!.type.name).toBe('analytic');
    expect(unit.firstChild!.textContent).toBe('SomeCite');
  });
});

describe('setTag on a card_body — splits into two cards', () => {
  it('cursor in middle body: original keeps prefix; new card holds cursor body + suffix', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('First'),
        cardBody('b1'),
        cardBody('b2'),
        cardBody('b3'),
      ]),
    ]);
    const state = cursorAtCardBody(doc, 1);
    const next = apply(state, setTag());
    expect(next).not.toBeNull();
    expect(next!.doc.childCount).toBe(2);
    const c0 = next!.doc.content.content[0]!;
    const c1 = next!.doc.content.content[1]!;
    expect(c0.type.name).toBe('card');
    expect(c1.type.name).toBe('card');
    const c0Types: string[] = [];
    c0.forEach((c) => c0Types.push(c.type.name));
    expect(c0Types).toEqual(['tag', 'card_body']);
    expect(c0.firstChild!.textContent).toBe('First');
    const c1Types: string[] = [];
    c1.forEach((c) => c1Types.push(c.type.name));
    expect(c1Types).toEqual(['tag', 'card_body']);
    expect(c1.firstChild!.textContent).toBe('b2');
    expect(c1.child(1).textContent).toBe('b3');
  });

  it('cursor in last body: new card has just a tag', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [tag('First'), cardBody('b1')]),
    ]);
    const state = cursorAtCardBody(doc, 0);
    const next = apply(state, setTag());
    expect(next!.doc.childCount).toBe(2);
    const c1 = next!.doc.content.content[1]!;
    expect(c1.childCount).toBe(1);
    expect(c1.firstChild!.type.name).toBe('tag');
    expect(c1.firstChild!.textContent).toBe('b1');
  });

  it('preserves cite_paragraph and undertag before the cursor body', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('First'),
        undertag('sub'),
        citePara('cite'),
        cardBody('b1'),
        cardBody('b2'),
      ]),
    ]);
    const state = cursorAtCardBody(doc, 1);
    const next = apply(state, setTag());
    const c0 = next!.doc.content.content[0]!;
    const c0Types: string[] = [];
    c0.forEach((c) => c0Types.push(c.type.name));
    expect(c0Types).toEqual(['tag', 'undertag', 'cite_paragraph', 'card_body']);
  });

  it('inside analytic_unit: original stays as analytic_unit; new card holds split content', () => {
    const doc = makeDoc([
      schema.nodes['analytic_unit']!.createChecked(null, [
        analytic('A'),
        cardBody('b1'),
        cardBody('b2'),
      ]),
    ]);
    const state = cursorAtCardBody(doc, 1);
    const next = apply(state, setTag());
    const types = next!.doc.content.content.map((c) => c.type.name);
    expect(types).toEqual(['analytic_unit', 'card']);
    const newCard = next!.doc.content.content[1]!;
    expect(newCard.firstChild!.type.name).toBe('tag');
    expect(newCard.firstChild!.textContent).toBe('b2');
  });

  it('places the cursor inside the new tag at the same offset', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [tag('t'), cardBody('hello world')]),
    ]);
    const baseState = EditorState.create({ doc });
    const pos = findNthCardBody(doc, 0) + 6;
    const state = baseState.apply(baseState.tr.setSelection(TextSelection.create(baseState.doc, pos)));
    const next = apply(state, setTag());
    const sel = next!.selection;
    expect(sel.$from.parent.type.name).toBe('tag');
    expect(sel.$from.parentOffset).toBe(6);
  });
});

// ---- setAnalytic (Mod-F7) ----

describe('setAnalytic (Mod-F7)', () => {
  it('wraps a doc-level paragraph as analytic_unit + analytic', () => {
    const doc = makeDoc([paragraph('claim')]);
    const state = cursorIn(doc, (n) => n.type.name === 'paragraph');
    const next = apply(state, setAnalytic());
    expect(next).not.toBeNull();
    expect(next!.doc.firstChild!.type.name).toBe('analytic_unit');
    expect(next!.doc.firstChild!.firstChild!.type.name).toBe('analytic');
    expect(next!.doc.firstChild!.firstChild!.textContent).toBe('claim');
  });

  it('wraps a pocket as analytic_unit preserving id', () => {
    const doc = makeDoc([pocket('claim', 'orig-id')]);
    const state = cursorIn(doc, (n) => n.type.name === 'pocket');
    const next = apply(state, setAnalytic());
    const analyticNode = next!.doc.firstChild!.firstChild!;
    expect(analyticNode.type.name).toBe('analytic');
    expect(analyticNode.attrs['id']).toBe('orig-id');
  });

  it('no-op accept when cursor is already in an analytic anchor', () => {
    const doc = makeDoc([analyticUnit(analytic('a'))]);
    const state = cursorIn(doc, (n) => n.type.name === 'analytic');
    const next = apply(state, setAnalytic());
    expect(next === null || next.doc.eq(doc)).toBe(true);
  });

  it('converts card → analytic_unit when cursor is in the tag', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('claim', 'tag-id'),
        cardBody('body'),
        undertag('sub'),
      ]),
    ]);
    const state = cursorIn(doc, (n) => n.type.name === 'tag');
    const next = apply(state, setAnalytic());
    expect(next).not.toBeNull();
    const unit = next!.doc.firstChild!;
    expect(unit.type.name).toBe('analytic_unit');
    expect(unit.firstChild!.type.name).toBe('analytic');
    expect(unit.firstChild!.attrs['id']).toBe('tag-id');
    const types: string[] = [];
    unit.forEach((c) => types.push(c.type.name));
    expect(types).toEqual(['analytic', 'card_body', 'undertag']);
  });

  it('preserves cite_paragraph type when converting card → analytic_unit', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('claim'),
        citePara('Source'),
        cardBody('body'),
      ]),
    ]);
    const state = cursorIn(doc, (n) => n.type.name === 'tag');
    const next = apply(state, setAnalytic());
    const unit = next!.doc.firstChild!;
    const types: string[] = [];
    const texts: string[] = [];
    unit.forEach((c) => { types.push(c.type.name); texts.push(c.textContent); });
    expect(types).toEqual(['analytic', 'cite_paragraph', 'card_body']);
    expect(texts).toEqual(['claim', 'Source', 'body']);
  });

  it('splits a card at a card_body into card prefix + analytic_unit', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('First'),
        cardBody('b1'),
        cardBody('b2'),
        cardBody('b3'),
      ]),
    ]);
    const state = cursorAtCardBody(doc, 1);
    const next = apply(state, setAnalytic());
    expect(next!.doc.childCount).toBe(2);
    const types = next!.doc.content.content.map((c) => c.type.name);
    expect(types).toEqual(['card', 'analytic_unit']);
    const unit = next!.doc.content.content[1]!;
    expect(unit.firstChild!.type.name).toBe('analytic');
    expect(unit.firstChild!.textContent).toBe('b2');
    const unitTypes: string[] = [];
    unit.forEach((c) => unitTypes.push(c.type.name));
    expect(unitTypes).toEqual(['analytic', 'card_body']);
    expect(unit.child(1).textContent).toBe('b3');
  });

  it('places the cursor inside the new analytic at the same offset', () => {
    const doc = makeDoc([paragraph('hello world')]);
    const state = cursorIn(doc, (n) => n.type.name === 'paragraph', 6);
    const next = apply(state, setAnalytic());
    const sel = next!.selection;
    expect(sel.$from.parent.type.name).toBe('analytic');
    expect(sel.$from.parentOffset).toBe(6);
  });
});

// ---- Keymap binding registry ----

describe('buildRibbonKeymap', () => {
  it('produces the default bindings (including aliases) when called with no overrides', () => {
    const km = buildRibbonKeymap();
    for (const id of RIBBON_COMMAND_IDS) {
      const spec = DEFAULT_RIBBON_KEYS[id];
      const keys = Array.isArray(spec) ? spec : [spec];
      for (const key of keys) {
        // Empty-string defaults mean "command exists but is intentionally
        // unbound" (e.g. menu-only items like condenseWithWarning).
        if (!key) continue;
        expect(km[key]).toBeTypeOf('function');
      }
    }
  });

  it('replaces a key when an override is provided', () => {
    const km = buildRibbonKeymap({ setPocket: 'Mod-1' });
    expect(km['Mod-1']).toBeTypeOf('function');
    expect(km['F4']).toBeUndefined();
    expect(km['F5']).toBeTypeOf('function');
  });

  it('unbinds a command when the override is an empty string', () => {
    const km = buildRibbonKeymap({ setTag: '' });
    expect(km['F7']).toBeUndefined();
    expect(km['F4']).toBeTypeOf('function');
  });

  it('binds both underline keys: F9 (applyUnderline) and Mod-u (toggleUnderlineTyping)', () => {
    const km = buildRibbonKeymap();
    expect(km['F9']).toBeTypeOf('function');
    expect(km['Mod-u']).toBeTypeOf('function');
  });
});

describe('global hotkey fallback (focus outside the editor)', () => {
  const kbd = (init: Partial<KeyboardEvent>) => init as KeyboardEvent;

  it('folds shifted letters: a real Shift keydown produces an uppercase key', () => {
    // Bindings are registered lowercase; e.key for Ctrl+Shift+S is 'S'.
    const s = ribbonKeyStringFor(kbd({ key: 'S', code: 'KeyS', ctrlKey: true, shiftKey: true }));
    expect(s).toBe('Mod-Shift-s');
    expect(ribbonCommandForKey(s)).not.toBeNull();
  });

  it('folds CapsLock letters on unshifted chords', () => {
    const s = ribbonKeyStringFor(kbd({ key: 'S', code: 'KeyS', ctrlKey: true }));
    expect(s).toBe('Mod-s');
    expect(ribbonCommandForKey(s)).toBe(ribbonCommandForKey('Mod-s'));
  });

  it('matches saved overrides captured uppercase before the fold', () => {
    expect(ribbonCommandForKey('Mod-Shift-y', { setPocket: 'Mod-Shift-Y' })).toBe('setPocket');
  });

  it('leaves F-keys and multi-char names untouched', () => {
    expect(ribbonKeyStringFor(kbd({ key: 'F7', code: 'F7' }))).toBe('F7');
    expect(ribbonCommandForKey('F7')).toBe('setTag');
  });

  it('names an Option-chord letter from e.code (macOS reports the layout character as e.key)', () => {
    // Option-Shift-V types "◊" on a US Mac layout; the chord must still read as Alt-Shift-v.
    expect(ribbonKeyStringFor(kbd({ key: '◊', code: 'KeyV', altKey: true, shiftKey: true }))).toBe('Alt-Shift-v');
    expect(ribbonKeyStringFor(kbd({ key: 'å', code: 'KeyA', altKey: true }))).toBe('Alt-a');
    // Without Alt, e.key is authoritative (layout-specific letters stay themselves).
    expect(ribbonKeyStringFor(kbd({ key: 'é', code: 'KeyE' }))).toBe('é');
  });
});

// ---- Selection-spanning application ----

function selectionAcross(
  doc: ReturnType<typeof makeDoc>,
  findFrom: (n: import('prosemirror-model').Node) => boolean,
  findTo: (n: import('prosemirror-model').Node) => boolean,
): EditorState {
  let from = -1;
  let to = -1;
  doc.descendants((node, p) => {
    if (from === -1 && findFrom(node)) from = p + 1;
    // Land `to` at the END of the matched block's content. Use Math.max so
    // an inner text node (which also matches a textContent predicate) can't
    // pull `to` back to the block's start — a boundary at offset 0 reads
    // as "this block is not selected" and is excluded from the restyle.
    if (findTo(node)) to = Math.max(to, p + node.nodeSize - 1);
    return true;
  });
  if (from < 0 || to < 0) throw new Error('selection anchors not found');
  const base = EditorState.create({ doc });
  return base.apply(base.tr.setSelection(TextSelection.create(base.doc, from, to)));
}

describe('setHeading on a multi-paragraph selection', () => {
  it('converts every touched doc-level paragraph to the target heading', () => {
    const doc = makeDoc([paragraph('a'), paragraph('b'), paragraph('c')]);
    // Selection from a to b (leaves c alone).
    const state = selectionAcross(doc, (n) => n.textContent === 'a', (n) => n.textContent === 'b');
    const next = apply(state, setHeading('pocket'));
    expect(next).not.toBeNull();
    const types = next!.doc.content.content.map((c) => c.type.name);
    expect(types).toEqual(['pocket', 'pocket', 'paragraph']);
  });

  it('dissolves a card when the selection includes the tag and a body', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('T'),
        cardBody('b1'),
        cardBody('b2'),
      ]),
    ]);
    const state = selectionAcross(doc, (n) => n.type.name === 'tag', (n) => n.textContent === 'b1');
    const next = apply(state, setHeading('pocket'));
    expect(next).not.toBeNull();
    const types = next!.doc.content.content.map((c) => c.type.name);
    expect(types).toEqual(['pocket', 'pocket', 'paragraph']);
    expect(next!.doc.content.content[0]!.textContent).toBe('T');
    expect(next!.doc.content.content[1]!.textContent).toBe('b1');
    expect(next!.doc.content.content[2]!.textContent).toBe('b2');
  });

  it('splits a card when the selection only spans bodies', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('T'),
        cardBody('b1'),
        cardBody('b2'),
        cardBody('b3'),
      ]),
    ]);
    const state = selectionAcross(doc, (n) => n.textContent === 'b1', (n) => n.textContent === 'b2');
    const next = apply(state, setHeading('pocket'));
    const types = next!.doc.content.content.map((c) => c.type.name);
    expect(types).toEqual(['card', 'pocket', 'pocket', 'paragraph']);
    const card = next!.doc.firstChild!;
    expect(card.childCount).toBe(1);
    expect(card.firstChild!.type.name).toBe('tag');
  });

  it('spans two cards: first card splits, second card dissolves (its tag is touched)', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [tag('T1'), cardBody('a1'), cardBody('a2')]),
      schema.nodes['card']!.createChecked(null, [tag('T2'), cardBody('b1'), cardBody('b2')]),
    ]);
    // Selection from a2 to T2.
    const state = selectionAcross(doc, (n) => n.textContent === 'a2', (n) => n.textContent === 'T2');
    const next = apply(state, setHeading('pocket'));
    const types = next!.doc.content.content.map((c) => c.type.name);
    // card1[T1,a1] | pocket(a2) | pocket(T2) | paragraph(b1) | paragraph(b2)
    expect(types).toEqual(['card', 'pocket', 'pocket', 'paragraph', 'paragraph']);
    const c0 = next!.doc.content.content[0]!;
    const c0Types: string[] = [];
    c0.forEach((c) => c0Types.push(c.type.name));
    expect(c0Types).toEqual(['tag', 'card_body']);
    expect(c0.firstChild!.textContent).toBe('T1');
    expect(next!.doc.content.content[1]!.textContent).toBe('a2');
    expect(next!.doc.content.content[2]!.textContent).toBe('T2');
    expect(next!.doc.content.content[3]!.textContent).toBe('b1');
    expect(next!.doc.content.content[4]!.textContent).toBe('b2');
  });

  it('keeps undertag inside container when only later children are touched', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('T'),
        undertag('sub'),
        cardBody('b1'),
        cardBody('b2'),
      ]),
    ]);
    const state = selectionAcross(doc, (n) => n.textContent === 'b1', (n) => n.textContent === 'b1');
    const next = apply(state, setHeading('hat'));
    const card = next!.doc.firstChild!;
    const cardTypes: string[] = [];
    card.forEach((c) => cardTypes.push(c.type.name));
    expect(cardTypes).toEqual(['tag', 'undertag']);
    const docTypes = next!.doc.content.content.map((c) => c.type.name);
    expect(docTypes).toEqual(['card', 'hat', 'paragraph']);
  });
});

describe('setUndertag', () => {
  it('converts a doc-level paragraph to an undertag in place', () => {
    const doc = makeDoc([paragraph('annotation')]);
    const state = cursorIn(doc, (n) => n.type.name === 'paragraph');
    const next = apply(state, setUndertag());
    expect(next).not.toBeNull();
    expect(next!.doc.firstChild!.type.name).toBe('undertag');
    expect(next!.doc.firstChild!.textContent).toBe('annotation');
  });

  it('converts a doc-level heading to an undertag and drops the id', () => {
    const doc = makeDoc([pocket('annotation', 'orig-id')]);
    const state = cursorIn(doc, (n) => n.type.name === 'pocket');
    const next = apply(state, setUndertag());
    expect(next!.doc.firstChild!.type.name).toBe('undertag');
    expect(next!.doc.firstChild!.attrs['id']).toBeUndefined();
  });

  it('converts a card_body to an undertag IN PLACE — card structure preserved', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('T'),
        cardBody('b1'),
        cardBody('b2'),
      ]),
    ]);
    const state = cursorAtCardBody(doc, 0); // b1
    const next = apply(state, setUndertag());
    expect(next).not.toBeNull();
    expect(next!.doc.childCount).toBe(1); // still one card, no split
    const card = next!.doc.firstChild!;
    const types: string[] = [];
    card.forEach((c) => types.push(c.type.name));
    expect(types).toEqual(['tag', 'undertag', 'card_body']);
    expect(card.child(1).textContent).toBe('b1');
  });

  it('cite_paragraph cursor: in-place conversion to undertag', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('T'),
        citePara('Source 2024'),
        cardBody('body'),
      ]),
    ]);
    // Cursor inside the cite_paragraph.
    let pos = -1;
    doc.descendants((n, p) => {
      if (n.type.name === 'cite_paragraph' && pos === -1) pos = p + 1;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, pos)));
    const next = apply(state, setUndertag());
    const card = next!.doc.firstChild!;
    const types: string[] = [];
    card.forEach((c) => types.push(c.type.name));
    expect(types).toEqual(['tag', 'undertag', 'card_body']);
  });

  it('dissolves a card when the cursor is in the tag', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [tag('T'), cardBody('b')]),
    ]);
    const state = cursorIn(doc, (n) => n.type.name === 'tag');
    const next = apply(state, setUndertag());
    const types = next!.doc.content.content.map((c) => c.type.name);
    expect(types).toEqual(['undertag', 'paragraph']);
    expect(next!.doc.content.content[0]!.textContent).toBe('T');
  });

  it('accepts no-op when cursor is already in an undertag', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [tag('T'), undertag('sub')]),
    ]);
    const state = cursorIn(doc, (n) => n.type.name === 'undertag');
    const next = apply(state, setUndertag());
    expect(next === null || next.doc.eq(doc)).toBe(true);
  });

  it('absorbs a dissolved card into the previous card when one exists', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [tag('First'), cardBody('preBody')]),
      schema.nodes['card']!.createChecked(null, [tag('Second'), cardBody('postBody')]),
    ]);
    // Cursor in the SECOND card's tag.
    let pos = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'Second') pos = p + 1;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, pos)));
    const next = apply(state, setUndertag());
    expect(next).not.toBeNull();
    const docTypes = next!.doc.content.content.map((c) => c.type.name);
    expect(docTypes).toEqual(['card']);
    const card = next!.doc.firstChild!;
    const children: { type: string; text: string }[] = [];
    card.forEach((c) => children.push({ type: c.type.name, text: c.textContent }));
    expect(children).toEqual([
      { type: 'tag', text: 'First' },
      { type: 'card_body', text: 'preBody' },
      { type: 'undertag', text: 'Second' },
      { type: 'card_body', text: 'postBody' },
    ]);
  });
});

describe('setTag/setAnalytic on a multi-paragraph selection', () => {
  it('setTag wraps each touched paragraph into its own card', () => {
    const doc = makeDoc([paragraph('a'), paragraph('b'), paragraph('c')]);
    const state = selectionAcross(doc, (n) => n.textContent === 'a', (n) => n.textContent === 'b');
    const next = apply(state, setTag());
    const types = next!.doc.content.content.map((c) => c.type.name);
    expect(types).toEqual(['card', 'card', 'paragraph']);
    expect(next!.doc.content.content[0]!.firstChild!.textContent).toBe('a');
    expect(next!.doc.content.content[1]!.firstChild!.textContent).toBe('b');
  });

  it('setAnalytic wraps each touched paragraph into its own analytic_unit', () => {
    const doc = makeDoc([paragraph('a'), paragraph('b')]);
    const state = selectionAcross(doc, (n) => n.textContent === 'a', (n) => n.textContent === 'b');
    const next = apply(state, setAnalytic());
    const types = next!.doc.content.content.map((c) => c.type.name);
    expect(types).toEqual(['analytic_unit', 'analytic_unit']);
    expect(next!.doc.content.content[0]!.firstChild!.type.name).toBe('analytic');
    expect(next!.doc.content.content[0]!.firstChild!.textContent).toBe('a');
  });
});

describe('structural command with a selection inside a same-type head (audit 2026-06-10 P1#4)', () => {
  /** Select [fromOff, toOff) inside the first node matching `typeName`. */
  function selectInsideNode(
    doc: ReturnType<typeof makeDoc>,
    typeName: string,
    fromOff: number,
    toOff: number,
  ): EditorState {
    let start = -1;
    doc.descendants((n, p) => {
      if (start === -1 && n.type.name === typeName) start = p + 1;
      return start === -1;
    });
    if (start < 0) throw new Error(`${typeName} not found`);
    const base = EditorState.create({ doc });
    return base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, start + fromOff, start + toOff)),
    );
  }

  it('F7 with a word selected inside a tag preserves the card (mirrors cursor no-op)', () => {
    const doc = makeDoc([
      cardWith(tag('Aggression likely'), citePara('Author 24'), cardBody('warrant text')),
    ]);
    const state = selectInsideNode(doc, 'tag', 0, 10);
    const next = apply(state, setTag());
    expect(next === null || next.doc.eq(doc)).toBe(true);
  });

  it('Mod-F7 with a selection on analytic text preserves the analytic_unit', () => {
    const doc = makeDoc([
      analyticUnit(analytic('Extend this'), cardBody('because reasons')),
    ]);
    const state = selectInsideNode(doc, 'analytic', 0, 6);
    const next = apply(state, setAnalytic());
    expect(next === null || next.doc.eq(doc)).toBe(true);
  });

  it('F8 with a selection on an undertag preserves the card', () => {
    const doc = makeDoc([
      cardWith(tag('T'), undertag('sub claim'), cardBody('body')),
    ]);
    const state = selectInsideNode(doc, 'undertag', 0, 3);
    const next = apply(state, setUndertag());
    expect(next === null || next.doc.eq(doc)).toBe(true);
  });

  it('selection spanning tag into body still splits the body off, tag card intact', () => {
    const doc = makeDoc([cardWith(tag('First'), cardBody('warrant'))]);
    const state = selectionAcross(
      doc,
      (n) => n.type.name === 'tag',
      (n) => n.type.name === 'card_body',
    );
    const next = apply(state, setTag());
    expect(next).not.toBeNull();
    const types = next!.doc.content.content.map((c) => c.type.name);
    expect(types).toEqual(['card', 'card']);
    expect(next!.doc.content.content[0]!.firstChild!.textContent).toBe('First');
    expect(next!.doc.content.content[1]!.firstChild!.textContent).toBe('warrant');
  });
});

describe('structural apply on a Ctrl-Shift-Down selection (boundary at next-para start)', () => {
  it('restyles only the selected paragraph, not the one below', () => {
    const doc = makeDoc([paragraph('alpha'), paragraph('beta')]);
    const base = EditorState.create({ doc });
    // Ctrl-Shift-Down lands `to` at offset 0 of the following textblock:
    // from = start of para1 content (1); to = start of para2 content.
    const to = doc.firstChild!.nodeSize + 1;
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, 1, to)),
    );
    const next = apply(state, setHeading('pocket'));
    expect(next).not.toBeNull();
    const types = next!.doc.content.content.map((c) => c.type.name);
    expect(types).toEqual(['pocket', 'paragraph']);
    expect(next!.doc.firstChild!.textContent).toBe('alpha');
    expect(next!.doc.content.content[1]!.textContent).toBe('beta');
  });
});

describe('re-pressing a structural style resets indent + font-size + font-color (keeps spacing)', () => {
  const FONT_SIZE = schema.marks['font_size']!;
  const FONT_COLOR = schema.marks['font_color']!;
  const SPACING = { 'w:after': '240' };
  /** Text carrying a direct font_size AND font_color mark. */
  function styled(text: string) {
    return schema.text(text, [
      FONT_SIZE.create({ halfPoints: 28 }),
      FONT_COLOR.create({ color: 'FF0000' }),
    ]);
  }
  function has(node: import('prosemirror-model').Node, type: typeof FONT_SIZE): boolean {
    let found = false;
    node.descendants((n) => {
      if (type.isInSet(n.marks)) found = true;
      return !found;
    });
    return found;
  }
  const hasFontSize = (n: import('prosemirror-model').Node) => has(n, FONT_SIZE);
  const hasFontColor = (n: import('prosemirror-model').Node) => has(n, FONT_COLOR);

  it('F4–F6 on a same-type heading clears indent + font-size + font-color, keeps spacing', () => {
    const doc = makeDoc([
      schema.nodes['pocket']!.create({ id: 'p1', indent: 720, spacing: SPACING }, styled('hello')),
    ]);
    const state = cursorIn(doc, (n) => n.type.name === 'pocket', 1);
    const next = apply(state, setHeading('pocket'));
    expect(next).not.toBeNull();
    const head = next!.doc.firstChild!;
    expect(head.type.name).toBe('pocket');
    expect(head.attrs['id']).toBe('p1');
    expect(head.attrs['indent']).toBe(0);
    expect(head.attrs['spacing']).toEqual(SPACING);
    expect(hasFontSize(next!.doc)).toBe(false);
    expect(hasFontColor(next!.doc)).toBe(false);
  });

  it('F7 on a tag clears indent (new) + font-size + font-color, keeps the card', () => {
    const doc = makeDoc([
      cardWith(schema.nodes['tag']!.create({ id: 't1', indent: 720, spacing: SPACING }, styled('claim'))),
    ]);
    const state = cursorIn(doc, (n) => n.type.name === 'tag', 1);
    const next = apply(state, setTag());
    expect(next).not.toBeNull();
    expect(next!.doc.firstChild!.type.name).toBe('card');
    const tagNode = next!.doc.firstChild!.firstChild!;
    expect(tagNode.type.name).toBe('tag');
    expect(tagNode.textContent).toBe('claim');
    expect(tagNode.attrs['indent']).toBe(0);
    expect(tagNode.attrs['spacing']).toEqual(SPACING);
    expect(hasFontSize(next!.doc)).toBe(false);
    expect(hasFontColor(next!.doc)).toBe(false);
  });

  it('Mod-F7 on an analytic clears indent (new) + font-size + font-color, keeps the analytic_unit', () => {
    const doc = makeDoc([
      analyticUnit(schema.nodes['analytic']!.create({ id: 'a1', indent: 720 }, styled('point'))),
    ]);
    const state = cursorIn(doc, (n) => n.type.name === 'analytic', 1);
    const next = apply(state, setAnalytic());
    expect(next).not.toBeNull();
    expect(next!.doc.firstChild!.type.name).toBe('analytic_unit');
    const an = next!.doc.firstChild!.firstChild!;
    expect(an.type.name).toBe('analytic');
    expect(an.attrs['indent']).toBe(0);
    expect(hasFontSize(next!.doc)).toBe(false);
    expect(hasFontColor(next!.doc)).toBe(false);
  });

  it('undertag re-press clears indent + font-size (new) + font-color', () => {
    const doc = makeDoc([
      schema.nodes['undertag']!.create({ indent: 720 }, styled('note')),
    ]);
    const state = cursorIn(doc, (n) => n.type.name === 'undertag', 1);
    const next = apply(state, setUndertag());
    expect(next).not.toBeNull();
    expect(next!.doc.firstChild!.attrs['indent']).toBe(0);
    expect(hasFontSize(next!.doc)).toBe(false);
    expect(hasFontColor(next!.doc)).toBe(false);
  });

  it('a selection inside a same-type tag resets it but keeps the card intact', () => {
    const doc = makeDoc([
      cardWith(schema.nodes['tag']!.create({ id: 't1', indent: 720 }, styled('aggression likely'))),
    ]);
    const base = EditorState.create({ doc });
    // Select a word inside the tag (does not span the whole node).
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, 3, 9)),
    );
    const next = apply(state, setTag());
    expect(next).not.toBeNull();
    const card = next!.doc.firstChild!;
    expect(card.type.name).toBe('card');
    expect(card.firstChild!.type.name).toBe('tag');
    expect(card.firstChild!.attrs['id']).toBe('t1');
    expect(card.firstChild!.attrs['indent']).toBe(0);
    expect(card.firstChild!.textContent).toBe('aggression likely');
    expect(hasFontSize(next!.doc)).toBe(false);
    expect(hasFontColor(next!.doc)).toBe(false);
  });
});

// ---- copyPreviousCite ----

function cardWithChildren(...children: import('prosemirror-model').Node[]) {
  return schema.nodes['card']!.createChecked(null, children);
}

function setCursorIn(doc: ReturnType<typeof makeDoc>, find: (n: import('prosemirror-model').Node) => boolean, offset = 0): EditorState {
  let pos = -1;
  doc.descendants((n, p) => {
    if (pos === -1 && find(n)) pos = p + 1 + offset;
    return true;
  });
  if (pos < 0) throw new Error('cursor target not found');
  const base = EditorState.create({ doc });
  return base.apply(base.tr.setSelection(TextSelection.create(base.doc, pos)));
}

describe('copyPreviousCite', () => {
  // These tests pin the SOURCE-GROUP semantics (which cites a source
  // contributes), so they run in copy-the-whole-group mode; the
  // default nearest-only narrowing has its own suite in
  // copy-last-cite-bug.test.ts.
  beforeEach(() => settings.set('copyPreviousCiteNearestOnly', false));
  afterEach(() => settings.set('copyPreviousCiteNearestOnly', true));

  it('no-op when there is no previous cite anywhere', () => {
    const doc = makeDoc([cardWithChildren(tag('T'), cardBody('b'))]);
    const state = setCursorIn(doc, (n) => n.type.name === 'tag');
    expect(apply(state, copyPreviousCite())).toBeNull();
  });

  it('cursor in tag with no cite above: pulls from previous card', () => {
    const doc = makeDoc([
      cardWithChildren(tag('T1'), citePara('Source 2024')),
      cardWithChildren(tag('T2')),
    ]);
    const state = setCursorIn(doc, (n) => n.type.name === 'tag' && n.textContent === 'T2');
    const next = apply(state, copyPreviousCite());
    expect(next).not.toBeNull();
    const card2 = next!.doc.lastChild!;
    const types: string[] = [];
    card2.forEach((c) => types.push(c.type.name));
    expect(types).toEqual(['tag', 'cite_paragraph']);
    expect(card2.child(1).textContent).toBe('Source 2024');
  });

  it('cursor in empty card_body with cite above (same card): empty body replaced by copied cite', () => {
    const doc = makeDoc([
      cardWithChildren(tag('T'), citePara('Source 2024'), cardBody('')),
    ]);
    const state = setCursorIn(doc, (n) => n.type.name === 'card_body');
    const next = apply(state, copyPreviousCite());
    expect(next!.doc.childCount).toBe(1);
    const card = next!.doc.firstChild!;
    const types: string[] = [];
    card.forEach((c) => types.push(c.type.name));
    expect(types).toEqual(['tag', 'cite_paragraph', 'cite_paragraph']);
    expect(card.child(1).textContent).toBe('Source 2024');
    expect(card.child(2).textContent).toBe('Source 2024');
  });

  it('whitespace-only body in a card with no cite: empty body replaced by cite IN PLACE (no new card)', () => {
    const doc = makeDoc([
      cardWithChildren(tag('T1'), citePara('Source 2024')),
      cardWithChildren(tag('T2'), cardBody('   ')),
    ]);
    const state = setCursorIn(doc, (n) => n.type.name === 'card_body');
    const next = apply(state, copyPreviousCite());
    // card2 has no cite yet → no split; the empty body is replaced by
    // the cite inside card2.
    expect(next!.doc.childCount).toBe(2);
    const card2 = next!.doc.lastChild!;
    const card2Types: string[] = [];
    card2.forEach((c) => card2Types.push(c.type.name));
    expect(card2Types).toEqual(['tag', 'cite_paragraph']);
  });

  it('cursor at start of non-empty body in a card with no cite: cite inserted before the body, same card', () => {
    const doc = makeDoc([
      cardWithChildren(tag('T1'), citePara('Source 2024')),
      cardWithChildren(tag('T2'), cardBody('Body text')),
    ]);
    const state = setCursorIn(doc, (n) => n.type.name === 'card_body');
    const next = apply(state, copyPreviousCite());
    expect(next!.doc.childCount).toBe(2);
    const card2 = next!.doc.lastChild!;
    const types: string[] = [];
    card2.forEach((c) => types.push(c.type.name));
    expect(types).toEqual(['tag', 'cite_paragraph', 'card_body']);
  });

  it('cursor at start of non-empty body in a card with an existing cite: cite inserted before the body', () => {
    const doc = makeDoc([
      cardWithChildren(tag('T1'), citePara('FromPrev')),
      cardWithChildren(tag('T2'), citePara('AlreadyHere'), cardBody('Body text')),
    ]);
    const state = setCursorIn(doc, (n) => n.type.name === 'card_body');
    const next = apply(state, copyPreviousCite());
    expect(next!.doc.childCount).toBe(2);
    const card2 = next!.doc.lastChild!;
    const types: string[] = [];
    card2.forEach((c) => types.push(c.type.name));
    expect(types).toEqual(['tag', 'cite_paragraph', 'cite_paragraph', 'card_body']);
  });

  it('cite in current card above cursor wins over previous-card cite', () => {
    const doc = makeDoc([
      cardWithChildren(tag('T1'), citePara('FromPrevious')),
      cardWithChildren(tag('T2'), citePara('FromCurrent'), cardBody('')),
    ]);
    const state = setCursorIn(doc, (n) => n.type.name === 'card_body');
    const next = apply(state, copyPreviousCite());
    // Empty body replaced by the FromCurrent copy (in-card insert).
    const card2 = next!.doc.lastChild!;
    const types: string[] = [];
    card2.forEach((c) => types.push(c.type.name));
    expect(types).toEqual(['tag', 'cite_paragraph', 'cite_paragraph']);
    expect(card2.child(2).textContent).toBe('FromCurrent');
  });

  it('cursor inside a cite_paragraph excludes that cite, falls back to previous if it was the only one', () => {
    const doc = makeDoc([
      cardWithChildren(tag('T1'), citePara('FromPrevious')),
      cardWithChildren(tag('T2'), citePara('CurrentCite')),
    ]);
    const state = setCursorIn(doc, (n) => n.type.name === 'cite_paragraph' && n.textContent === 'CurrentCite', 4);
    const next = apply(state, copyPreviousCite());
    // FromPrevious copy inserted as sibling after the current cite.
    const card2 = next!.doc.lastChild!;
    const types: string[] = [];
    card2.forEach((c) => types.push(c.type.name));
    expect(types).toEqual(['tag', 'cite_paragraph', 'cite_paragraph']);
    expect(card2.child(1).textContent).toBe('CurrentCite');
    expect(card2.child(2).textContent).toBe('FromPrevious');
  });

  it('grabs free-floating cite paragraphs at doc level instead of walking past them', () => {
    const doc = makeDoc([
      cardWithChildren(tag('T1'), citePara('InCard')),
      citePara('Floater1'),
      citePara('Floater2'),
      cardWithChildren(tag('T2')),
    ]);
    const state = setCursorIn(doc, (n) => n.type.name === 'tag' && n.textContent === 'T2');
    const next = apply(state, copyPreviousCite());
    expect(next).not.toBeNull();
    const card2 = next!.doc.lastChild!;
    const types: string[] = [];
    card2.forEach((c) => types.push(c.type.name));
    // T2 + two cite_paragraphs grabbed from the floaters (not "InCard").
    expect(types).toEqual(['tag', 'cite_paragraph', 'cite_paragraph']);
    expect(card2.child(1).textContent).toBe('Floater1');
    expect(card2.child(2).textContent).toBe('Floater2');
  });

  it('a non-cite node between floaters breaks the run; most recent group wins', () => {
    const doc = makeDoc([
      citePara('OldFloater'),
      paragraph('a regular paragraph'),
      citePara('NewFloater'),
      cardWithChildren(tag('T')),
    ]);
    const state = setCursorIn(doc, (n) => n.type.name === 'tag' && n.textContent === 'T');
    const next = apply(state, copyPreviousCite());
    const card = next!.doc.lastChild!;
    expect(card.child(1).textContent).toBe('NewFloater');
  });

  it('walks farther back when the immediate previous card has no cites', () => {
    const doc = makeDoc([
      cardWithChildren(tag('T1'), citePara('FromWayBack')),
      cardWithChildren(tag('T2')),
      cardWithChildren(tag('T3')),
    ]);
    const state = setCursorIn(doc, (n) => n.type.name === 'tag' && n.textContent === 'T3');
    const next = apply(state, copyPreviousCite());
    const card3 = next!.doc.lastChild!;
    expect(card3.child(1).textContent).toBe('FromWayBack');
  });

  it('cursor in an EMPTY doc-level paragraph: paragraph is replaced by the cite at doc level', () => {
    const doc = makeDoc([
      cardWithChildren(tag('T1'), citePara('Source 2024')),
      paragraph(''),
    ]);
    const state = setCursorIn(doc, (n) => n.type.name === 'paragraph');
    const next = apply(state, copyPreviousCite());
    const types = next!.doc.content.content.map((c) => c.type.name);
    expect(types).toEqual(['card', 'cite_paragraph']);
    expect(next!.doc.lastChild!.textContent).toBe('Source 2024');
  });

  it('cursor at start of a doc-level paragraph (non-empty): cite inserted as a sibling at doc level', () => {
    const doc = makeDoc([
      cardWithChildren(tag('T1'), citePara('Source 2024')),
      paragraph('a doc-level note'),
    ]);
    const state = setCursorIn(doc, (n) => n.type.name === 'paragraph');
    const next = apply(state, copyPreviousCite());
    const types = next!.doc.content.content.map((c) => c.type.name);
    expect(types).toEqual(['card', 'cite_paragraph', 'paragraph']);
    expect(next!.doc.child(1).textContent).toBe('Source 2024');
  });

  it('cursor in analytic head: cite inserted as sibling inside the same analytic_unit', () => {
    const doc = makeDoc([
      cardWithChildren(tag('T1'), citePara('Source')),
      schema.nodes['analytic_unit']!.createChecked(null, [
        analytic('Alpha'),
        cardBody('body1'),
      ]),
    ]);
    const state = setCursorIn(doc, (n) => n.type.name === 'analytic');
    const next = apply(state, copyPreviousCite());
    expect(next!.doc.childCount).toBe(2);
    const unit = next!.doc.lastChild!;
    const types: string[] = [];
    unit.forEach((c) => types.push(c.type.name));
    expect(types).toEqual(['analytic', 'cite_paragraph', 'card_body']);
  });

  it('cursor at start of analytic body: cite inserted as sibling before the body, same unit', () => {
    const doc = makeDoc([
      cardWithChildren(tag('T1'), citePara('Source')),
      schema.nodes['analytic_unit']!.createChecked(null, [
        analytic('A'),
        cardBody('body1'),
        cardBody('body2'),
      ]),
    ]);
    const state = setCursorIn(doc, (n) => n.type.name === 'card_body' && n.textContent === 'body1');
    const next = apply(state, copyPreviousCite());
    expect(next!.doc.childCount).toBe(2);
    const unit = next!.doc.lastChild!;
    const types: string[] = [];
    unit.forEach((c) => types.push(c.type.name));
    expect(types).toEqual(['analytic', 'cite_paragraph', 'card_body', 'card_body']);
    expect(unit.child(1).textContent).toBe('Source');
    expect(unit.child(2).textContent).toBe('body1');
    expect(unit.child(3).textContent).toBe('body2');
  });

  it('cursor at start of last child of analytic_unit: cite inserted before that child', () => {
    const doc = makeDoc([
      cardWithChildren(tag('T1'), citePara('Source')),
      schema.nodes['analytic_unit']!.createChecked(null, [
        analytic('A'),
        cardBody('only body'),
      ]),
    ]);
    const state = setCursorIn(doc, (n) => n.type.name === 'card_body');
    const next = apply(state, copyPreviousCite());
    expect(next!.doc.childCount).toBe(2);
    const unit = next!.doc.lastChild!;
    const types: string[] = [];
    unit.forEach((c) => types.push(c.type.name));
    expect(types).toEqual(['analytic', 'cite_paragraph', 'card_body']);
  });

  it('cursor lands inside the inserted cite_paragraph', () => {
    const doc = makeDoc([
      cardWithChildren(tag('T1'), citePara('Source')),
      paragraph('here'),
    ]);
    const state = setCursorIn(doc, (n) => n.type.name === 'paragraph');
    const next = apply(state, copyPreviousCite());
    const sel = next!.selection;
    expect(sel.$from.parent.type.name).toBe('cite_paragraph');
  });

  it('collapses non-empty selection to selection.from', () => {
    const doc = makeDoc([
      cardWithChildren(tag('T1'), citePara('Source')),
      cardWithChildren(tag('T2'), cardBody('hello world')),
    ]);
    // Selection spans inside the second card's body.
    let bodyStart = -1;
    doc.descendants((n, p) => {
      if (bodyStart === -1 && n.type.name === 'card_body' && n.textContent === 'hello world') {
        bodyStart = p + 1;
      }
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, bodyStart, bodyStart + 5)),
    );
    const next = apply(state, copyPreviousCite());
    // selection.from is at offset 0 in the body → cite inserts before the body.
    expect(next!.doc.childCount).toBe(2);
    const card2 = next!.doc.lastChild!;
    const types: string[] = [];
    card2.forEach((c) => types.push(c.type.name));
    expect(types).toEqual(['tag', 'cite_paragraph', 'card_body']);
  });
});

// ---- applyCite (F8) ----

function citeMarkIdsForText(doc: import('prosemirror-model').Node, search: string): boolean {
  // True iff every text run that matches `search` carries cite_mark.
  let allCited = true;
  let found = false;
  doc.descendants((n) => {
    if (!n.isText) return;
    if ((n.text ?? '').includes(search)) {
      found = true;
      if (!n.marks.some((m) => m.type.name === 'cite_mark')) allCited = false;
    }
  });
  return found && allCited;
}

describe('applyCite (F8)', () => {
  it('empty selection inside a word in body: applies cite_mark to that word', () => {
    const doc = makeDoc([
      cardWithChildren(tag('T'), cardBody('hello world')),
    ]);
    // Cursor in the middle of "hello".
    let pos = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'hello world') pos = p + 2;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, pos)));
    const next = apply(state, applyCite());
    expect(next).not.toBeNull();
    // "hello" cited; " world" not.
    let helloMarked = false;
    let worldMarked = false;
    next!.doc.descendants((n) => {
      if (!n.isText) return;
      const c = n.marks.some((m) => m.type.name === 'cite_mark');
      if (n.text === 'hello') helloMarked = c;
      if ((n.text ?? '').includes('world')) worldMarked = c || worldMarked;
    });
    expect(helloMarked).toBe(true);
    expect(worldMarked).toBe(false);
  });

  it('empty selection in whitespace: no-op', () => {
    const doc = makeDoc([
      cardWithChildren(tag('T'), cardBody('a  b')),
    ]);
    let pos = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'a  b') pos = p + 2; // between the two spaces
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, pos)));
    expect(apply(state, applyCite())).toBeNull();
  });

  it('empty selection in a tag (skip block): no-op', () => {
    const doc = makeDoc([cardWithChildren(tag('TheTag'))]);
    let pos = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'TheTag') pos = p + 2;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, pos)));
    expect(apply(state, applyCite())).toBeNull();
  });

  it('empty selection in an empty paragraph: no-op (arming belongs to the Mod- chords)', () => {
    const doc = makeDoc([paragraph('')]);
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, 1)));
    expect(apply(state, applyCite())).toBeNull();
  });

  it('applies cite_mark to text in a body paragraph', () => {
    const doc = makeDoc([
      cardWithChildren(tag('T'), cardBody('hello world')),
    ]);
    // Select the whole body content ("hello world" → 11 chars).
    let bodyStart = -1;
    doc.descendants((n, p) => {
      if (bodyStart === -1 && n.type.name === 'card_body') bodyStart = p + 1;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, bodyStart, bodyStart + 11)),
    );
    const next = apply(state, applyCite());
    expect(next).not.toBeNull();
    expect(citeMarkIdsForText(next!.doc, 'hello world')).toBe(true);
  });

  it('spanning a tag in the middle: marks the bodies, skips the tag', () => {
    const doc = makeDoc([
      cardWithChildren(tag('T1'), cardBody('first body')),
      cardWithChildren(tag('T2'), cardBody('second body')),
    ]);
    // Select from start of "first body" through end of "second body".
    let firstStart = -1;
    let secondEnd = -1;
    doc.descendants((n, p) => {
      if (n.isText) {
        if (firstStart === -1 && n.text === 'first body') firstStart = p;
        if (n.text === 'second body') secondEnd = p + n.nodeSize;
      }
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, firstStart, secondEnd)),
    );
    const next = apply(state, applyCite());
    expect(next).not.toBeNull();
    // Both bodies are cited; the tags are skipped.
    expect(citeMarkIdsForText(next!.doc, 'first body')).toBe(true);
    expect(citeMarkIdsForText(next!.doc, 'second body')).toBe(true);
    expect(citeMarkIdsForText(next!.doc, 'T1')).toBe(false);
    expect(citeMarkIdsForText(next!.doc, 'T2')).toBe(false);
  });

  it('skips undertags', () => {
    const doc = makeDoc([
      cardWithChildren(
        tag('T'),
        cardBody('body 1'),
        undertag('an undertag'),
        cardBody('body 2'),
      ),
    ]);
    let from = -1;
    let to = -1;
    doc.descendants((n, p) => {
      if (n.isText) {
        if (from === -1 && n.text === 'body 1') from = p;
        if (n.text === 'body 2') to = p + n.nodeSize;
      }
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, from, to)),
    );
    const next = apply(state, applyCite());
    expect(citeMarkIdsForText(next!.doc, 'body 1')).toBe(true);
    expect(citeMarkIdsForText(next!.doc, 'body 2')).toBe(true);
    expect(citeMarkIdsForText(next!.doc, 'an undertag')).toBe(false);
  });

  it('skips pocket / hat / block headings in the span', () => {
    const doc = makeDoc([
      paragraph('intro text'),
      schema.nodes['hat']!.create({ id: newHeadingId() }, schema.text('Hat heading')),
      paragraph('outro text'),
    ]);
    let from = -1;
    let to = -1;
    doc.descendants((n, p) => {
      if (n.isText) {
        if (from === -1 && n.text === 'intro text') from = p;
        if (n.text === 'outro text') to = p + n.nodeSize;
      }
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, from, to)),
    );
    const next = apply(state, applyCite());
    expect(citeMarkIdsForText(next!.doc, 'intro text')).toBe(true);
    expect(citeMarkIdsForText(next!.doc, 'outro text')).toBe(true);
    expect(citeMarkIdsForText(next!.doc, 'Hat heading')).toBe(false);
  });

  it('selection entirely inside a tag is a no-op (nothing marked)', () => {
    const doc = makeDoc([cardWithChildren(tag('a tag'))]);
    let from = -1;
    let to = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'a tag') {
        from = p;
        to = p + n.nodeSize;
      }
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, from, to)),
    );
    expect(apply(state, applyCite())).toBeNull();
  });
});

// ---- applyUnderline (F9 / Mod-U) ----

import { applyUnderline, toggleUnderlineTyping } from '../../src/editor/ribbon-commands.js';

function hasMark(node: import('prosemirror-model').Node, search: string, markName: string): boolean {
  let found = false;
  let matched = false;
  node.descendants((n) => {
    if (!n.isText) return;
    if ((n.text ?? '').includes(search)) {
      matched = true;
      if (n.marks.some((m) => m.type.name === markName)) found = true;
    }
  });
  return matched && found;
}

function everyHasMark(node: import('prosemirror-model').Node, search: string, markName: string): boolean {
  let matched = false;
  let allHave = true;
  node.descendants((n) => {
    if (!n.isText) return;
    if ((n.text ?? '').includes(search)) {
      matched = true;
      if (!n.marks.some((m) => m.type.name === markName)) allHave = false;
    }
  });
  return matched && allHave;
}

describe('applyUnderline (F9 / Mod-U)', () => {
  it('non-empty selection in card_body: applies underline_mark (named style)', () => {
    const doc = makeDoc([
      cardWithChildren(tag('T'), cardBody('hello world')),
    ]);
    let from = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'hello world') from = p;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, from, from + 11)),
    );
    const next = apply(state, applyUnderline());
    expect(next).not.toBeNull();
    expect(everyHasMark(next!.doc, 'hello world', 'underline_mark')).toBe(true);
  });

  it('non-empty selection in a tag: applies underline_direct (not the named style)', () => {
    const doc = makeDoc([cardWithChildren(tag('TheTag'))]);
    let from = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'TheTag') from = p;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, from, from + 6)),
    );
    const next = apply(state, applyUnderline());
    expect(next).not.toBeNull();
    expect(everyHasMark(next!.doc, 'TheTag', 'underline_direct')).toBe(true);
    expect(hasMark(next!.doc, 'TheTag', 'underline_mark')).toBe(false);
  });

  it('selection across body + tag + body: bodies get underline_mark, tag gets underline_direct', () => {
    const doc = makeDoc([
      cardWithChildren(tag('T1'), cardBody('body1')),
      cardWithChildren(tag('T2'), cardBody('body2')),
    ]);
    let from = -1;
    let to = -1;
    doc.descendants((n, p) => {
      if (n.isText) {
        if (from === -1 && n.text === 'body1') from = p;
        if (n.text === 'body2') to = p + n.nodeSize;
      }
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, from, to)),
    );
    const next = apply(state, applyUnderline());
    expect(everyHasMark(next!.doc, 'body1', 'underline_mark')).toBe(true);
    expect(everyHasMark(next!.doc, 'body2', 'underline_mark')).toBe(true);
    expect(everyHasMark(next!.doc, 'T2', 'underline_direct')).toBe(true);
    // No underline_mark on the tag (would violate body-vs-structural).
    expect(hasMark(next!.doc, 'T2', 'underline_mark')).toBe(false);
  });

  it('toggle off only when ALL selected chars are underlined', () => {
    const doc = makeDoc([
      cardWithChildren(
        tag('T'),
        schema.nodes['card_body']!.create(null, [
          schema.text('plain '),
          schema.text('underlined', [schema.marks['underline_mark']!.create()]),
        ]),
      ),
    ]);
    // Select all of "plain underlined" — mixed state, should ADD underline (not toggle off).
    let bodyStart = -1;
    doc.descendants((n, p) => {
      if (n.type.name === 'card_body' && bodyStart === -1) bodyStart = p + 1;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, bodyStart, bodyStart + 'plain underlined'.length)),
    );
    const next = apply(state, applyUnderline());
    expect(everyHasMark(next!.doc, 'plain ', 'underline_mark')).toBe(true);
    expect(everyHasMark(next!.doc, 'underlined', 'underline_mark')).toBe(true);
  });

  it('toggle off when ALL selected chars are underlined (uniform state)', () => {
    const doc = makeDoc([
      cardWithChildren(
        tag('T'),
        schema.nodes['card_body']!.create(null, schema.text('hello', [schema.marks['underline_mark']!.create()])),
      ),
    ]);
    let from = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'hello') from = p;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, from, from + 5)),
    );
    const next = apply(state, applyUnderline());
    expect(hasMark(next!.doc, 'hello', 'underline_mark')).toBe(false);
    expect(hasMark(next!.doc, 'hello', 'underline_direct')).toBe(false);
  });

  it('applying to cite-marked body text strips cite, replaces with underline', () => {
    const doc = makeDoc([
      cardWithChildren(
        tag('T'),
        schema.nodes['cite_paragraph']!.create(null, schema.text('Stein 24', [schema.marks['cite_mark']!.create()])),
      ),
    ]);
    let from = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'Stein 24') from = p;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, from, from + 8)),
    );
    const next = apply(state, applyUnderline());
    expect(hasMark(next!.doc, 'Stein 24', 'cite_mark')).toBe(false);
    expect(everyHasMark(next!.doc, 'Stein 24', 'underline_mark')).toBe(true);
  });

  it('empty selection on a word inside a card_body: toggles underline_mark on the word', () => {
    const doc = makeDoc([
      cardWithChildren(tag('T'), cardBody('hello')),
    ]);
    // Cursor at middle of "hello".
    let pos = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'hello') pos = p + 2; // inside the word
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, pos)));
    const next = apply(state, applyUnderline());
    expect(everyHasMark(next!.doc, 'hello', 'underline_mark')).toBe(true);
  });

  it('empty selection inside multi-word body: only the word at cursor is underlined', () => {
    const doc = makeDoc([
      cardWithChildren(tag('T'), cardBody('hello world')),
    ]);
    // Cursor in middle of "world".
    let pos = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'hello world') pos = p + 8; // inside "world"
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, pos)));
    const next = apply(state, applyUnderline());
    // "world" carries underline_mark, "hello " does not.
    let helloMarked = false;
    let worldMarked = false;
    next!.doc.descendants((n) => {
      if (!n.isText) return;
      const u = n.marks.some((m) => m.type.name === 'underline_mark');
      if ((n.text ?? '').includes('hello')) helloMarked = u || helloMarked;
      if (n.text === 'world') worldMarked = u;
    });
    expect(worldMarked).toBe(true);
    expect(helloMarked).toBe(false);
  });

  it('empty selection at PM text-node boundary within a word: toggles full word across the boundary', () => {
    // "plain" + "bold" — two text nodes with different marks, no
    // whitespace between. By the word rule, this is ONE word "plainbold".
    const doc = makeDoc([
      cardWithChildren(
        tag('T'),
        schema.nodes['card_body']!.create(null, [
          schema.text('plain'),
          schema.text('bold', [schema.marks['bold']!.create()]),
        ]),
      ),
    ]);
    let pos = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'plain') pos = p + n.nodeSize; // boundary
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, pos)));
    const next = apply(state, applyUnderline());
    expect(next).not.toBeNull();
    expect(everyHasMark(next!.doc, 'plain', 'underline_mark')).toBe(true);
    expect(everyHasMark(next!.doc, 'bold', 'underline_mark')).toBe(true);
  });

  it('empty selection in whitespace between two words: no-op', () => {
    // With a single space "hello world" there's no "in the whitespace"
    // position — offset 5 has 'o' to the left, offset 6 has 'w' to the
    // right, both pick a word. A double-space gap with the cursor
    // between the two spaces has whitespace on both sides.
    const doc = makeDoc([
      cardWithChildren(tag('T'), cardBody('a  b')),
    ]);
    let pos = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'a  b') pos = p + 2; // between the two spaces
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, pos)));
    expect(apply(state, applyUnderline())).toBeNull();
  });

  it('empty selection in an empty paragraph: no-op (F9 is expand-to-word; Mod-U arms)', () => {
    const doc = makeDoc([paragraph('')]);
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, 1)));
    expect(apply(state, applyUnderline())).toBeNull();
  });
});

describe('toggleUnderlineTyping (Mod-U)', () => {
  function storedMarkNames(state: EditorState): string[] {
    return (state.storedMarks ?? []).map((m) => m.type.name);
  }
  function collapsedIn(text: string, offset: number) {
    const doc = makeDoc([cardWithChildren(tag('TheTag'), cardBody('hello world'))]);
    let pos = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === text) pos = p + offset;
      return true;
    });
    const base = EditorState.create({ doc });
    return base.apply(base.tr.setSelection(TextSelection.create(base.doc, pos)));
  }

  it('collapsed cursor in body: stores underline_mark for the next typed text', () => {
    const next = apply(collapsedIn('hello world', 3), toggleUnderlineTyping());
    expect(next).not.toBeNull();
    expect(storedMarkNames(next!)).toContain('underline_mark');
    // It does NOT underline the word the cursor sits in (unlike F9).
    expect(hasMark(next!.doc, 'hello world', 'underline_mark')).toBe(false);
  });

  it('collapsed cursor in a tag: stores underline_direct (not the named style)', () => {
    const next = apply(collapsedIn('TheTag', 2), toggleUnderlineTyping());
    expect(next).not.toBeNull();
    expect(storedMarkNames(next!)).toContain('underline_direct');
    expect(storedMarkNames(next!)).not.toContain('underline_mark');
  });

  it('toggles the stored mark back off on a second press', () => {
    const first = apply(collapsedIn('hello world', 3), toggleUnderlineTyping());
    const second = apply(first!, toggleUnderlineTyping());
    expect(second).not.toBeNull();
    expect(storedMarkNames(second!)).not.toContain('underline_mark');
  });

  it('non-empty selection: behaves like F9 (body → underline_mark)', () => {
    const doc = makeDoc([cardWithChildren(tag('T'), cardBody('hello world'))]);
    let from = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'hello world') from = p;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, from, from + 11)));
    const next = apply(state, toggleUnderlineTyping());
    expect(next).not.toBeNull();
    expect(everyHasMark(next!.doc, 'hello world', 'underline_mark')).toBe(true);
  });
});

// ---- applyEmphasis (F10) ----

function emphMarkOnText(doc: import('prosemirror-model').Node, search: string): boolean {
  let allMarked = true;
  let found = false;
  doc.descendants((n) => {
    if (!n.isText) return;
    if ((n.text ?? '').includes(search)) {
      found = true;
      if (!n.marks.some((m) => m.type.name === 'emphasis_mark')) allMarked = false;
    }
  });
  return found && allMarked;
}

describe('applyEmphasis (F10)', () => {
  it('empty selection inside a word in body: applies emphasis to that word', () => {
    const doc = makeDoc([
      cardWithChildren(tag('T'), cardBody('hello world')),
    ]);
    // Cursor in the middle of "hello".
    let pos = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'hello world') pos = p + 2;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, pos)));
    const next = apply(state, applyEmphasis());
    expect(next).not.toBeNull();
    // "hello" emphasized; " world" not.
    let helloMarked = false;
    let worldMarked = false;
    next!.doc.descendants((n) => {
      if (!n.isText) return;
      const e = n.marks.some((m) => m.type.name === 'emphasis_mark');
      if (n.text === 'hello') helloMarked = e;
      if ((n.text ?? '').includes('world')) worldMarked = e || worldMarked;
    });
    expect(helloMarked).toBe(true);
    expect(worldMarked).toBe(false);
  });

  it('empty selection at PM text-node boundary within a word: emphasizes full word', () => {
    const doc = makeDoc([
      cardWithChildren(
        tag('T'),
        schema.nodes['card_body']!.create(null, [
          schema.text('plain'),
          schema.text('bold', [schema.marks['bold']!.create()]),
        ]),
      ),
    ]);
    let pos = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'plain') pos = p + n.nodeSize;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, pos)));
    const next = apply(state, applyEmphasis());
    expect(emphMarkOnText(next!.doc, 'plain')).toBe(true);
    expect(emphMarkOnText(next!.doc, 'bold')).toBe(true);
  });

  it('empty selection in whitespace: no-op', () => {
    const doc = makeDoc([
      cardWithChildren(tag('T'), cardBody('a  b')),
    ]);
    let pos = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'a  b') pos = p + 2; // between the two spaces
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, pos)));
    expect(apply(state, applyEmphasis())).toBeNull();
  });

  it('empty selection in a tag (structural): no-op', () => {
    const doc = makeDoc([cardWithChildren(tag('TheTag'))]);
    let pos = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'TheTag') pos = p + 2;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, pos)));
    expect(apply(state, applyEmphasis())).toBeNull();
  });

  it('empty selection in an undertag (skip): no-op', () => {
    const doc = makeDoc([
      cardWithChildren(tag('T'), undertag('an undertag')),
    ]);
    let pos = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'an undertag') pos = p + 4;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, pos)));
    expect(apply(state, applyEmphasis())).toBeNull();
  });

  it('empty selection in an empty paragraph: no-op (arming belongs to the Mod- chords)', () => {
    const doc = makeDoc([paragraph('')]);
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, 1)));
    expect(apply(state, applyEmphasis())).toBeNull();
  });

  it('applies emphasis_mark to text in a body paragraph', () => {
    const doc = makeDoc([
      cardWithChildren(tag('T'), cardBody('hello world')),
    ]);
    let bodyStart = -1;
    doc.descendants((n, p) => {
      if (bodyStart === -1 && n.type.name === 'card_body') bodyStart = p + 1;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, bodyStart, bodyStart + 11)),
    );
    const next = apply(state, applyEmphasis());
    expect(next).not.toBeNull();
    // A contiguous selection is emphasized whole — internal spaces included.
    expect(emphMarkOnText(next!.doc, 'hello world')).toBe(true);
  });

  it('spanning a tag in the middle: marks the bodies, skips the tag', () => {
    const doc = makeDoc([
      cardWithChildren(tag('T1'), cardBody('first body')),
      cardWithChildren(tag('T2'), cardBody('second body')),
    ]);
    let firstStart = -1;
    let secondEnd = -1;
    doc.descendants((n, p) => {
      if (n.isText) {
        if (firstStart === -1 && n.text === 'first body') firstStart = p;
        if (n.text === 'second body') secondEnd = p + n.nodeSize;
      }
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, firstStart, secondEnd)),
    );
    const next = apply(state, applyEmphasis());
    expect(next).not.toBeNull();
    expect(emphMarkOnText(next!.doc, 'first body')).toBe(true);
    expect(emphMarkOnText(next!.doc, 'second body')).toBe(true);
    expect(emphMarkOnText(next!.doc, 'T1')).toBe(false);
    expect(emphMarkOnText(next!.doc, 'T2')).toBe(false);
  });

  it('skips undertags', () => {
    const doc = makeDoc([
      cardWithChildren(
        tag('T'),
        cardBody('body 1'),
        undertag('an undertag'),
        cardBody('body 2'),
      ),
    ]);
    let from = -1;
    let to = -1;
    doc.descendants((n, p) => {
      if (n.isText) {
        if (from === -1 && n.text === 'body 1') from = p;
        if (n.text === 'body 2') to = p + n.nodeSize;
      }
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, from, to)),
    );
    const next = apply(state, applyEmphasis());
    expect(emphMarkOnText(next!.doc, 'body 1')).toBe(true);
    expect(emphMarkOnText(next!.doc, 'body 2')).toBe(true);
    expect(emphMarkOnText(next!.doc, 'an undertag')).toBe(false);
  });

  it('selection entirely inside a tag is a no-op (nothing marked)', () => {
    const doc = makeDoc([cardWithChildren(tag('a tag'))]);
    let from = -1;
    let to = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'a tag') {
        from = p;
        to = p + n.nodeSize;
      }
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, from, to)),
    );
    expect(apply(state, applyEmphasis())).toBeNull();
  });

  it('applied to cite-marked text: schema excludes strips cite, leaves emphasis', () => {
    const doc = makeDoc([
      cardWithChildren(
        tag('T'),
        schema.nodes['cite_paragraph']!.create(
          null,
          schema.text('Stein 24', [schema.marks['cite_mark']!.create()]),
        ),
      ),
    ]);
    let from = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'Stein 24') from = p;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, from, from + 8)),
    );
    const next = apply(state, applyEmphasis());
    expect(hasMark(next!.doc, 'Stein 24', 'cite_mark')).toBe(false);
    expect(emphMarkOnText(next!.doc, 'Stein 24')).toBe(true);
  });

  it('applied to underlined text: schema excludes strips underline, leaves emphasis', () => {
    const doc = makeDoc([
      cardWithChildren(
        tag('T'),
        schema.nodes['card_body']!.create(
          null,
          schema.text('important', [schema.marks['underline_mark']!.create()]),
        ),
      ),
    ]);
    let from = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'important') from = p;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, from, from + 9)),
    );
    const next = apply(state, applyEmphasis());
    expect(hasMark(next!.doc, 'important', 'underline_mark')).toBe(false);
    expect(emphMarkOnText(next!.doc, 'important')).toBe(true);
  });

  it('apply-only: re-running on already-emphasized text leaves the mark in place', () => {
    const doc = makeDoc([
      cardWithChildren(
        tag('T'),
        schema.nodes['card_body']!.create(
          null,
          schema.text('hi', [schema.marks['emphasis_mark']!.create()]),
        ),
      ),
    ]);
    let from = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'hi') from = p;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, from, from + 2)),
    );
    const next = apply(state, applyEmphasis());
    expect(emphMarkOnText(next!.doc, 'hi')).toBe(true);
  });

  it('default key binding: F10 → applyEmphasis', () => {
    expect(DEFAULT_RIBBON_KEYS['applyEmphasis']).toBe('F10');
  });
});

// ---- emphasizeAcronym (Alt-F10) ----

describe('emphasizeAcronym (Alt-F10)', () => {
  // Character offsets, local to the textblock whose textContent
  // equals `target`, that carry `emphasis_mark`.
  function emphPositionsInBlock(
    doc: import('prosemirror-model').Node,
    target: string,
  ): Set<number> {
    const out = new Set<number>();
    let foundBlock: import('prosemirror-model').Node | null = null;
    doc.descendants((n) => {
      if (n.isTextblock && n.textContent === target) {
        foundBlock = n;
        return false;
      }
      return true;
    });
    if (!foundBlock) return out;
    let offset = 0;
    (foundBlock as import('prosemirror-model').Node).forEach((child) => {
      if (child.isText) {
        const t = child.text ?? '';
        const isEmph = child.marks.some((m) => m.type.name === 'emphasis_mark');
        for (let i = 0; i < t.length; i++) {
          if (isEmph) out.add(offset + i);
        }
        offset += t.length;
      } else {
        offset += child.nodeSize;
      }
    });
    return out;
  }

  it('empty selection: no-op', () => {
    const doc = makeDoc([cardWithChildren(tag('T'), cardBody('hello world'))]);
    let pos = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'hello world') pos = p + 2;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, pos)));
    expect(apply(state, emphasizeAcronym())).toBeNull();
  });

  it('selection spans two whole words: emphasizes "h" + "w"', () => {
    const doc = makeDoc([cardWithChildren(tag('T'), cardBody('hello world'))]);
    let from = -1;
    let to = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'hello world') {
        from = p;
        to = p + n.nodeSize;
      }
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, from, to)),
    );
    const next = apply(state, emphasizeAcronym());
    expect(next).not.toBeNull();
    const marked = emphPositionsInBlock(next!.doc, 'hello world');
    // Offsets in the body text "hello world": 0 (h), 6 (w).
    expect(marked).toEqual(new Set([0, 6]));
  });

  it('partial-word selection: expands to full words then emphasizes first letters', () => {
    // Pick a selection that starts inside "United" and ends inside
    // "Capitol". Should expand to cover "United States Capitol" and
    // emphasize "U", "S", "C".
    const doc = makeDoc([
      cardWithChildren(tag('T'), cardBody('United States Capitol Police')),
    ]);
    let textPos = -1;
    doc.descendants((n, p) => {
      if (n.isText && (n.text ?? '').startsWith('United')) textPos = p;
      return true;
    });
    // "United States Capitol Police"
    //  0123456789012345678901234567
    //        ^ from inside "United" (offset 3)
    //                          ^ to inside "Capitol" (offset 17)
    const from = textPos + 3;
    const to = textPos + 17;
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, from, to)));
    const next = apply(state, emphasizeAcronym());
    expect(next).not.toBeNull();
    const marked = emphPositionsInBlock(next!.doc, 'United States Capitol Police');
    // Word starts at offsets 0 (U), 7 (S), 14 (C), 22 (P).
    // Selection expanded covered U-S-C (3 words). Police (offset 22)
    // is OUTSIDE the expanded range (selection ended at offset 17
    // which expanded to 21 = end of "Capitol", short of "Police"
    // which starts at 22).
    expect(marked).toEqual(new Set([0, 7, 14]));
  });

  it('selection touching the start of a word: includes that word', () => {
    // Selection [0, 3) — starts at "U" (the word start itself) and
    // ends mid-United. Should expand to whole "United" and
    // emphasize the U.
    const doc = makeDoc([cardWithChildren(tag('T'), cardBody('United States'))]);
    let textPos = -1;
    doc.descendants((n, p) => {
      if (n.isText && (n.text ?? '').startsWith('United')) textPos = p;
      return true;
    });
    const from = textPos;
    const to = textPos + 3;
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, from, to)));
    const next = apply(state, emphasizeAcronym());
    expect(next).not.toBeNull();
    const marked = emphPositionsInBlock(next!.doc, 'United States');
    // Only "U" — selection didn't reach "States".
    expect(marked).toEqual(new Set([0]));
  });

  it('selection entirely in whitespace: no-op', () => {
    const doc = makeDoc([cardWithChildren(tag('T'), cardBody('hello   world'))]);
    let textPos = -1;
    doc.descendants((n, p) => {
      if (n.isText && (n.text ?? '').includes('hello')) textPos = p;
      return true;
    });
    // Selection covers the three spaces only.
    const from = textPos + 5;
    const to = textPos + 8;
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, from, to)));
    expect(apply(state, emphasizeAcronym())).toBeNull();
  });

  it('selection spans a structural block: skips the structural block, processes body', () => {
    const doc = makeDoc([
      cardWithChildren(tag('Tag Text'), cardBody('body text here')),
    ]);
    // Select from inside the tag through the card body.
    let tagPos = -1;
    let bodyEnd = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'Tag Text') tagPos = p;
      if (n.isText && n.text === 'body text here') bodyEnd = p + n.nodeSize;
      return true;
    });
    const from = tagPos + 2;
    const to = bodyEnd;
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, from, to)));
    const next = apply(state, emphasizeAcronym());
    expect(next).not.toBeNull();
    // Tag content unchanged — emphasis_mark must NOT have been
    // applied inside the structural block.
    expect(emphPositionsInBlock(next!.doc, 'Tag Text')).toEqual(new Set());
    // Body had its word-start letters emphasized: "body text here"
    //                                              0    5    10
    expect(emphPositionsInBlock(next!.doc, 'body text here'))
      .toEqual(new Set([0, 5, 10]));
  });

  it('default key binding: Alt-F10 → emphasizeAcronym', () => {
    expect(DEFAULT_RIBBON_KEYS['emphasizeAcronym']).toBe('Alt-F10');
  });
});

// ---- highlightAcronym (Alt-F11) ----

describe('highlightAcronym (Alt-F11)', () => {
  // Local helper: positions in a textblock that carry the
  // `highlight` mark, with the color attribute.
  function highlightPositionsInBlock(
    doc: import('prosemirror-model').Node,
    target: string,
  ): Map<number, string> {
    const out = new Map<number, string>();
    let foundBlock: import('prosemirror-model').Node | null = null;
    doc.descendants((n) => {
      if (n.isTextblock && n.textContent === target) {
        foundBlock = n;
        return false;
      }
      return true;
    });
    if (!foundBlock) return out;
    let offset = 0;
    (foundBlock as import('prosemirror-model').Node).forEach((child) => {
      if (child.isText) {
        const t = child.text ?? '';
        const hl = child.marks.find((m) => m.type.name === 'highlight');
        for (let i = 0; i < t.length; i++) {
          if (hl) out.set(offset + i, String(hl.attrs['color']));
        }
        offset += t.length;
      } else {
        offset += child.nodeSize;
      }
    });
    return out;
  }

  it('empty selection: no-op', () => {
    const doc = makeDoc([cardWithChildren(tag('T'), cardBody('hello world'))]);
    let pos = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'hello world') pos = p + 2;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, pos)));
    expect(apply(state, highlightAcronym(() => 'yellow'))).toBeNull();
  });

  it('selection spans two whole words: highlights "h" + "w" with active color', () => {
    const doc = makeDoc([cardWithChildren(tag('T'), cardBody('hello world'))]);
    let from = -1;
    let to = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'hello world') {
        from = p;
        to = p + n.nodeSize;
      }
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, from, to)),
    );
    const next = apply(state, highlightAcronym(() => 'cyan'));
    expect(next).not.toBeNull();
    const marked = highlightPositionsInBlock(next!.doc, 'hello world');
    expect([...marked.entries()].sort((a, b) => a[0] - b[0]))
      .toEqual([[0, 'cyan'], [6, 'cyan']]);
  });

  it('partial-word selection: expands to full words then highlights first letters', () => {
    const doc = makeDoc([
      cardWithChildren(tag('T'), cardBody('United States Capitol Police')),
    ]);
    let textPos = -1;
    doc.descendants((n, p) => {
      if (n.isText && (n.text ?? '').startsWith('United')) textPos = p;
      return true;
    });
    const from = textPos + 3;
    const to = textPos + 17;
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, from, to)));
    const next = apply(state, highlightAcronym(() => 'yellow'));
    expect(next).not.toBeNull();
    const marked = highlightPositionsInBlock(next!.doc, 'United States Capitol Police');
    expect([...marked.keys()].sort((a, b) => a - b)).toEqual([0, 7, 14]);
  });

  it('selection entirely in whitespace: no-op', () => {
    const doc = makeDoc([cardWithChildren(tag('T'), cardBody('hello   world'))]);
    let textPos = -1;
    doc.descendants((n, p) => {
      if (n.isText && (n.text ?? '').includes('hello')) textPos = p;
      return true;
    });
    const from = textPos + 5;
    const to = textPos + 8;
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, from, to)));
    expect(apply(state, highlightAcronym(() => 'yellow'))).toBeNull();
  });

  it('selection spans a structural block: highlights run in BOTH the tag and the body', () => {
    // Differs from emphasizeAcronym, which skips structural blocks.
    // highlightAcronym mirrors applyHighlight: no structural skip.
    const doc = makeDoc([
      cardWithChildren(tag('Tag Text'), cardBody('body text here')),
    ]);
    let tagPos = -1;
    let bodyEnd = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'Tag Text') tagPos = p;
      if (n.isText && n.text === 'body text here') bodyEnd = p + n.nodeSize;
      return true;
    });
    const from = tagPos;
    const to = bodyEnd;
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, from, to)));
    const next = apply(state, highlightAcronym(() => 'yellow'));
    expect(next).not.toBeNull();
    // Tag: word-start letters in "Tag Text" → offsets 0 (T), 4 (T).
    expect([...highlightPositionsInBlock(next!.doc, 'Tag Text').keys()].sort((a, b) => a - b))
      .toEqual([0, 4]);
    // Body: word-start letters in "body text here" → offsets 0, 5, 10.
    expect([...highlightPositionsInBlock(next!.doc, 'body text here').keys()].sort((a, b) => a - b))
      .toEqual([0, 5, 10]);
  });

  it('default key binding: Alt-F11 → highlightAcronym', () => {
    expect(DEFAULT_RIBBON_KEYS['highlightAcronym']).toBe('Alt-F11');
  });
});

// ---- applyHighlight (F11) ----

function hasMarkOfNameWithAttr(
  doc: import('prosemirror-model').Node,
  search: string,
  markName: string,
  attr: string,
): string | undefined {
  let found: string | undefined;
  doc.descendants((n) => {
    if (!n.isText) return;
    if ((n.text ?? '').includes(search)) {
      const m = n.marks.find((mm) => mm.type.name === markName);
      if (m) found = String(m.attrs[attr]);
    }
  });
  return found;
}

describe('applyHighlight (F11)', () => {
  it('empty selection: no-op (no word expansion)', () => {
    const doc = makeDoc([paragraph('hello world')]);
    const state = setCursorIn(doc, (n) => n.type.name === 'paragraph');
    expect(apply(state, applyHighlight(() => 'yellow'))).toBeNull();
  });

  it('selection with no highlights: applies the active color to the entire range', () => {
    const doc = makeDoc([
      cardWithChildren(tag('T'), cardBody('hello world')),
    ]);
    let start = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'hello world') start = p;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, start, start + 11)),
    );
    const next = apply(state, applyHighlight(() => 'green'));
    expect(next).not.toBeNull();
    expect(hasMarkOfNameWithAttr(next!.doc, 'hello world', 'highlight', 'color')).toBe('green');
  });

  it('uniformly highlighted (same color): toggle off — strips the mark', () => {
    const doc = makeDoc([
      cardWithChildren(
        tag('T'),
        schema.nodes['card_body']!.create(
          null,
          schema.text('hi', [schema.marks['highlight']!.create({ color: 'yellow' })]),
        ),
      ),
    ]);
    let start = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'hi') start = p;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, start, start + 2)),
    );
    const next = apply(state, applyHighlight(() => 'yellow'));
    expect(hasMarkOfNameWithAttr(next!.doc, 'hi', 'highlight', 'color')).toBeUndefined();
  });

  it('uniformly highlighted in a DIFFERENT color: repaints, never strips', () => {
    // Selection is all-yellow; user invokes F11 with active color = green.
    // Field report 2026-08-05: the old color-agnostic toggle stripped the
    // highlight entirely; a different active color must repaint instead.
    const doc = makeDoc([
      cardWithChildren(
        tag('T'),
        schema.nodes['card_body']!.create(
          null,
          schema.text('hi', [schema.marks['highlight']!.create({ color: 'yellow' })]),
        ),
      ),
    ]);
    let start = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'hi') start = p;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, start, start + 2)),
    );
    const next = apply(state, applyHighlight(() => 'green'));
    expect(hasMarkOfNameWithAttr(next!.doc, 'hi', 'highlight', 'color')).toBe('green');
  });

  it('partially highlighted: applies active color to the entire range', () => {
    // Half yellow, half plain.
    const doc = makeDoc([
      cardWithChildren(
        tag('T'),
        schema.nodes['card_body']!.create(null, [
          schema.text('lit', [schema.marks['highlight']!.create({ color: 'yellow' })]),
          schema.text('plain'),
        ]),
      ),
    ]);
    let start = -1;
    doc.descendants((n, p) => {
      if (start === -1 && n.isText && (n.text ?? '') === 'lit') start = p;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, start, start + 'litplain'.length)),
    );
    const next = apply(state, applyHighlight(() => 'red'));
    // The whole range now carries red.
    expect(hasMarkOfNameWithAttr(next!.doc, 'lit', 'highlight', 'color')).toBe('red');
    expect(hasMarkOfNameWithAttr(next!.doc, 'plain', 'highlight', 'color')).toBe('red');
  });

  it('highlights a selection inside a tag (no structural skip)', () => {
    const doc = makeDoc([cardWithChildren(tag('TheTag'))]);
    let start = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'TheTag') start = p;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, start, start + 6)),
    );
    const next = apply(state, applyHighlight(() => 'yellow'));
    expect(hasMarkOfNameWithAttr(next!.doc, 'TheTag', 'highlight', 'color')).toBe('yellow');
  });

  it('default key binding: F11 → applyHighlight', () => {
    expect(DEFAULT_RIBBON_KEYS['applyHighlight']).toBe('F11');
  });

  // ---- Layer 3 trailing-space trim cases ---------------------------
  //
  // The formatting-pipeline trim shaves ONE trailing space from the
  // selection's right edge when there's word/punct content elsewhere
  // in the range (un-doing the spec's word-unit absorption). When the
  // range is entirely whitespace, the trim must NOT fire — otherwise
  // the user can't deliberately format a trailing space.

  function highlightedOffsets(
    doc: import('prosemirror-model').Node,
    text: string,
  ): Set<number> {
    const out = new Set<number>();
    let foundBlock: import('prosemirror-model').Node | null = null;
    doc.descendants((n) => {
      if (foundBlock) return false;
      if (n.isTextblock && n.textContent === text) {
        foundBlock = n;
        return false;
      }
      return true;
    });
    if (!foundBlock) return out;
    let off = 0;
    (foundBlock as import('prosemirror-model').Node).forEach((child) => {
      if (child.isText) {
        const t = child.text ?? '';
        const hl = child.marks.find((m) => m.type.name === 'highlight');
        for (let i = 0; i < t.length; i++) {
          if (hl) out.add(off + i);
        }
        off += t.length;
      } else {
        off += child.nodeSize;
      }
    });
    return out;
  }

  it('range "word ": trim shaves the trailing space → only "word" highlighted', () => {
    const doc = makeDoc([cardWithChildren(tag('T'), cardBody('word here'))]);
    let start = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'word here') start = p;
      return true;
    });
    const base = EditorState.create({ doc });
    // Selection covers "word " (5 chars: word + trailing space).
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, start, start + 5)),
    );
    const next = apply(state, applyHighlight(() => 'yellow'));
    expect(next).not.toBeNull();
    // Trim shaved the space; only offsets 0..3 (w/o/r/d) carry highlight.
    expect(highlightedOffsets(next!.doc, 'word here')).toEqual(new Set([0, 1, 2, 3]));
  });

  it('range " " (single trailing space only): trim does NOT fire → the space gets highlighted', () => {
    const doc = makeDoc([cardWithChildren(tag('T'), cardBody('word here'))]);
    let start = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'word here') start = p;
      return true;
    });
    const base = EditorState.create({ doc });
    // Selection covers just the space at offset 4.
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, start + 4, start + 5)),
    );
    const next = apply(state, applyHighlight(() => 'yellow'));
    expect(next).not.toBeNull();
    expect(highlightedOffsets(next!.doc, 'word here')).toEqual(new Set([4]));
  });

  it('range "  " (whitespace-only): trim does NOT fire → both spaces highlighted', () => {
    const doc = makeDoc([cardWithChildren(tag('T'), cardBody('word  here'))]);
    let start = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'word  here') start = p;
      return true;
    });
    const base = EditorState.create({ doc });
    // Selection covers the two spaces (offsets 4..6).
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, start + 4, start + 6)),
    );
    const next = apply(state, applyHighlight(() => 'yellow'));
    expect(next).not.toBeNull();
    expect(highlightedOffsets(next!.doc, 'word  here')).toEqual(new Set([4, 5]));
  });

  it('range "word  " (word + 2 trailing spaces): trim shaves ONE, then the gap-fix cleans the rest → only "word"', () => {
    // The trim is monotonic (shaves one trailing space, leaving "word "),
    // but the per-apply gap-fix then strips the still-dangling trailing
    // space because the next word ("here") isn't highlighted — a space is
    // highlighted only when the words on both sides are. Net: just "word".
    const doc = makeDoc([cardWithChildren(tag('T'), cardBody('word  here'))]);
    let start = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'word  here') start = p;
      return true;
    });
    const base = EditorState.create({ doc });
    // Selection covers "word  " (offsets 0..6).
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, start, start + 6)),
    );
    const next = apply(state, applyHighlight(() => 'yellow'));
    expect(next).not.toBeNull();
    expect(highlightedOffsets(next!.doc, 'word  here')).toEqual(new Set([0, 1, 2, 3]));
  });

  it('null pen ("No highlight" active): strips a partially-highlighted range instead of applying', () => {
    const doc = makeDoc([
      cardWithChildren(
        tag('T'),
        schema.nodes['card_body']!.create(null, [
          schema.text('ab', [schema.marks['highlight']!.create({ color: 'yellow' })]),
          schema.text('cd'),
        ]),
      ),
    ]);
    let start = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'ab') start = p;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, start, start + 4)),
    );
    // Mixed range would normally take the apply branch — a null pen
    // must strip instead.
    const next = apply(state, applyHighlight(() => null));
    expect(next).not.toBeNull();
    expect(hasMarkOfNameWithAttr(next!.doc, 'ab', 'highlight', 'color')).toBeUndefined();
    expect(hasMarkOfNameWithAttr(next!.doc, 'cd', 'highlight', 'color')).toBeUndefined();
  });
});

// ---- double-tap toggle with the gap fix (quick unhighlight) ----

describe('double-tap toggles with a selected trailing space (gap-fix interplay)', () => {
  // The field workflow: select text, tap the toggle twice — once to
  // paint the whole selection, once to strip it. Selections routinely
  // grab a trailing space; the gap fix normalizes that selected edge
  // space (strips the style when the outside bookend disagrees), so
  // the toggle scan must not count edge whitespace or tap 2 sees "not
  // fully styled" and repaints forever instead of stripping.
  function selectFirstWordPlusSpace(text: string, word: string): EditorState {
    const doc = makeDoc([cardWithChildren(tag('T'), cardBody(text))]);
    let start = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === text) start = p;
      return true;
    });
    const base = EditorState.create({ doc });
    return base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, start, start + word.length + 1)),
    );
  }
  const markOn = (
    doc: import('prosemirror-model').Node,
    search: string,
    names: string[],
  ): boolean => {
    let found = false;
    doc.descendants((n) => {
      if (n.isText && (n.text ?? '').includes(search)) {
        if (n.marks.some((m) => names.includes(m.type.name))) found = true;
      }
      return true;
    });
    return found;
  };

  it('F11 twice: highlight lands, then strips — despite the gap-fixed edge space', () => {
    const state = selectFirstWordPlusSpace('alpha beta', 'alpha');
    const s1 = apply(state, applyHighlight(() => 'yellow'))!;
    // Tap 1 painted the word; the gap fix stripped the SELECTED trailing
    // space (right bookend "beta" is unhighlighted) — the trap's setup.
    expect(markOn(s1.doc, 'alpha', ['highlight'])).toBe(true);
    expect(markOn(s1.doc, ' ', ['highlight'])).toBe(false);
    const s2 = apply(s1, applyHighlight(() => 'yellow'))!;
    expect(markOn(s2.doc, 'alpha', ['highlight'])).toBe(false);
  });

  it('Mod-F11 twice: shading strips on the second tap', () => {
    const state = selectFirstWordPlusSpace('alpha beta', 'alpha');
    const s1 = apply(state, applyShading(() => 'D2D2D2'))!;
    expect(markOn(s1.doc, 'alpha', ['shading'])).toBe(true);
    const s2 = apply(s1, applyShading(() => 'D2D2D2'))!;
    expect(markOn(s2.doc, 'alpha', ['shading'])).toBe(false);
  });

  it('F9 twice: underline strips on the second tap', () => {
    const state = selectFirstWordPlusSpace('alpha beta', 'alpha');
    const s1 = apply(state, applyUnderline())!;
    expect(markOn(s1.doc, 'alpha', ['underline_mark', 'underline_direct'])).toBe(true);
    const s2 = apply(s1, applyUnderline())!;
    expect(markOn(s2.doc, 'alpha', ['underline_mark', 'underline_direct'])).toBe(false);
  });

  it('a whitespace-only selection still toggles deliberately', () => {
    // Trimming must not break formatting whitespace on purpose: with
    // nothing but the space selected, the fallback scans it untrimmed.
    const doc = makeDoc([
      cardWithChildren(
        tag('T'),
        schema.nodes['card_body']!.create(null, [
          schema.text('alpha', [schema.marks['highlight']!.create({ color: 'yellow' })]),
          schema.text(' '),
          schema.text('beta', [schema.marks['highlight']!.create({ color: 'yellow' })]),
        ]),
      ),
    ]);
    let start = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === ' ') start = p;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, start, start + 1)),
    );
    // Both bookends highlighted → the gap fix BRIDGES; the deliberate
    // gap-only selection stays actionable either way.
    const s1 = apply(state, applyHighlight(() => 'yellow'));
    expect(s1).not.toBeNull();
  });
});

// ---- applyShading (Mod-F11) ----

describe('applyShading (Mod-F11)', () => {
  it('empty selection: no-op', () => {
    const doc = makeDoc([paragraph('hello')]);
    const state = setCursorIn(doc, (n) => n.type.name === 'paragraph');
    expect(apply(state, applyShading(() => 'D2D2D2'))).toBeNull();
  });

  it('no-shading selection: applies active color across the range', () => {
    const doc = makeDoc([cardWithChildren(tag('T'), cardBody('text'))]);
    let start = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'text') start = p;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, start, start + 4)),
    );
    const next = apply(state, applyShading(() => 'D2D2D2'));
    expect(hasMarkOfNameWithAttr(next!.doc, 'text', 'shading', 'color')).toBe('D2D2D2');
  });

  it('uniformly shaded in a DIFFERENT color: repaints, never strips', () => {
    // Same defect class as the highlight field report (2026-08-05):
    // the color-agnostic toggle erased shading when repainting.
    const doc = makeDoc([
      cardWithChildren(
        tag('T'),
        schema.nodes['card_body']!.create(
          null,
          schema.text('shaded', [schema.marks['shading']!.create({ color: 'FFFF00' })]),
        ),
      ),
    ]);
    let start = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'shaded') start = p;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, start, start + 6)),
    );
    const next = apply(state, applyShading(() => 'D2D2D2'));
    expect(hasMarkOfNameWithAttr(next!.doc, 'shaded', 'shading', 'color')).toBe('D2D2D2');
  });

  it('uniformly shaded in the SAME color: toggles off', () => {
    const doc = makeDoc([
      cardWithChildren(
        tag('T'),
        schema.nodes['card_body']!.create(
          null,
          schema.text('shaded', [schema.marks['shading']!.create({ color: 'FFFF00' })]),
        ),
      ),
    ]);
    let start = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'shaded') start = p;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, start, start + 6)),
    );
    const next = apply(state, applyShading(() => 'FFFF00'));
    expect(hasMarkOfNameWithAttr(next!.doc, 'shaded', 'shading', 'color')).toBeUndefined();
  });

  it('shading and highlight coexist on the same range', () => {
    // Apply shading first then highlight — both marks should be present.
    const doc = makeDoc([cardWithChildren(tag('T'), cardBody('mixed'))]);
    let start = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'mixed') start = p;
      return true;
    });
    const base = EditorState.create({ doc });
    let state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, start, start + 5)),
    );
    const s1 = apply(state, applyShading(() => 'D2D2D2'))!;
    state = s1.apply(s1.tr.setSelection(TextSelection.create(s1.doc, start, start + 5)));
    const s2 = apply(state, applyHighlight(() => 'yellow'))!;
    expect(hasMarkOfNameWithAttr(s2.doc, 'mixed', 'shading', 'color')).toBe('D2D2D2');
    expect(hasMarkOfNameWithAttr(s2.doc, 'mixed', 'highlight', 'color')).toBe('yellow');
  });

  it('default key binding: Mod-F11 → applyShading', () => {
    expect(DEFAULT_RIBBON_KEYS['applyShading']).toBe('Mod-F11');
  });

  it('null pen ("No background color" active): strips instead of applying', () => {
    const doc = makeDoc([
      cardWithChildren(
        tag('T'),
        schema.nodes['card_body']!.create(null, [
          schema.text('ab', [schema.marks['shading']!.create({ color: 'D2D2D2' })]),
          schema.text('cd'),
        ]),
      ),
    ]);
    let start = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'ab') start = p;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, start, start + 4)),
    );
    const next = apply(state, applyShading(() => null));
    expect(next).not.toBeNull();
    expect(hasMarkOfNameWithAttr(next!.doc, 'ab', 'shading', 'color')).toBeUndefined();
  });
});

// ---- Direct-apply commands (dropdown picks) ----

describe('setHighlightColor / setShadingColor / setFontColor', () => {
  it('setHighlightColor replaces any existing highlight color across the range', () => {
    const doc = makeDoc([
      cardWithChildren(
        tag('T'),
        schema.nodes['card_body']!.create(null, [
          schema.text('A', [schema.marks['highlight']!.create({ color: 'yellow' })]),
          schema.text('B', [schema.marks['highlight']!.create({ color: 'green' })]),
        ]),
      ),
    ]);
    let start = -1;
    doc.descendants((n, p) => {
      if (start === -1 && n.isText && n.text === 'A') start = p;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, start, start + 2)));
    const next = apply(state, setHighlightColor('red'));
    expect(hasMarkOfNameWithAttr(next!.doc, 'A', 'highlight', 'color')).toBe('red');
    expect(hasMarkOfNameWithAttr(next!.doc, 'B', 'highlight', 'color')).toBe('red');
  });

  it('setShadingColor normalizes hex to uppercase', () => {
    const doc = makeDoc([cardWithChildren(tag('T'), cardBody('text'))]);
    let start = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'text') start = p;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, start, start + 4)));
    const next = apply(state, setShadingColor('abcdef'));
    expect(hasMarkOfNameWithAttr(next!.doc, 'text', 'shading', 'color')).toBe('ABCDEF');
  });

  it('setFontColor(null) strips the font_color mark (Automatic)', () => {
    const doc = makeDoc([
      cardWithChildren(
        tag('T'),
        schema.nodes['card_body']!.create(
          null,
          schema.text('colored', [schema.marks['font_color']!.create({ color: 'FF0000' })]),
        ),
      ),
    ]);
    let start = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'colored') start = p;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, start, start + 7)));
    const next = apply(state, setFontColor(null));
    expect(hasMarkOfNameWithAttr(next!.doc, 'colored', 'font_color', 'color')).toBeUndefined();
  });

  it('setFontColor with a hex replaces any existing color', () => {
    const doc = makeDoc([cardWithChildren(tag('T'), cardBody('text'))]);
    let start = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'text') start = p;
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, start, start + 4)));
    const next = apply(state, setFontColor('1F3864'));
    expect(hasMarkOfNameWithAttr(next!.doc, 'text', 'font_color', 'color')).toBe('1F3864');
  });
});

// ---- Schema mark order: highlight nests inside shading ----

describe('schema mark ordering for visual stacking', () => {
  it('highlight has a higher rank than shading (renders inside)', () => {
    // `rank` is internal PM (set by MarkType.compile in definition order)
    // but exposed at runtime. Higher rank = later in marks array = inner
    // DOM element.
    const hRank = (schema.marks['highlight'] as unknown as { rank: number }).rank;
    const sRank = (schema.marks['shading'] as unknown as { rank: number }).rank;
    expect(hRank).toBeGreaterThan(sRank);
  });

  it('Mark.setFrom puts shading before highlight in a mixed mark set', () => {
    const m = schema.text('x', [
      schema.marks['highlight']!.create({ color: 'yellow' }),
      schema.marks['shading']!.create({ color: 'D2D2D2' }),
    ]);
    const names = m.marks.map((mm) => mm.type.name);
    expect(names.indexOf('shading')).toBeLessThan(names.indexOf('highlight'));
  });
});

describe('buildPlainTextSlice (F2 Paste Text)', () => {
  it('single line: inline content, no opens', () => {
    const slice = buildPlainTextSlice('hello world');
    expect(slice.openStart).toBe(0);
    expect(slice.openEnd).toBe(0);
    expect(slice.content.childCount).toBe(1);
    expect(slice.content.firstChild!.type.name).toBe('text');
    expect(slice.content.firstChild!.text).toBe('hello world');
    expect(slice.content.firstChild!.marks).toEqual([]);
  });

  it('empty string: empty slice, no opens', () => {
    const slice = buildPlainTextSlice('');
    expect(slice.openStart).toBe(0);
    expect(slice.openEnd).toBe(0);
    expect(slice.content.childCount).toBe(0);
  });

  it('multi-line LF: one paragraph per line, openStart/End = 1', () => {
    const slice = buildPlainTextSlice('first\nsecond\nthird');
    expect(slice.openStart).toBe(1);
    expect(slice.openEnd).toBe(1);
    expect(slice.content.childCount).toBe(3);
    const types: string[] = [];
    const texts: string[] = [];
    slice.content.forEach((c) => {
      types.push(c.type.name);
      texts.push(c.textContent);
    });
    expect(types).toEqual(['paragraph', 'paragraph', 'paragraph']);
    expect(texts).toEqual(['first', 'second', 'third']);
  });

  it('handles CRLF and CR alongside LF', () => {
    const slice = buildPlainTextSlice('a\r\nb\rc\nd');
    expect(slice.content.childCount).toBe(4);
    const texts: string[] = [];
    slice.content.forEach((c) => texts.push(c.textContent));
    expect(texts).toEqual(['a', 'b', 'c', 'd']);
  });

  it('blank line in the middle stays as an empty paragraph', () => {
    const slice = buildPlainTextSlice('a\n\nb');
    expect(slice.content.childCount).toBe(3);
    expect(slice.content.child(1).textContent).toBe('');
    expect(slice.content.child(1).type.name).toBe('paragraph');
  });

  describe('normalizeClipboardTextForPaste', () => {
    it('collapses whitespace in single-line parents (tag)', () => {
      expect(normalizeClipboardTextForPaste('Article Title\n', 'tag'))
        .toBe('Article Title');
      expect(normalizeClipboardTextForPaste('  Article Title  ', 'tag'))
        .toBe('Article Title');
      expect(normalizeClipboardTextForPaste('a\nb\nc', 'tag'))
        .toBe('a b c');
      expect(normalizeClipboardTextForPaste('a\r\nb\rc', 'tag'))
        .toBe('a b c');
      expect(normalizeClipboardTextForPaste('a\tb', 'tag'))
        .toBe('a b');
    });

    it('applies same flatten in cite_paragraph / undertag / analytic', () => {
      expect(normalizeClipboardTextForPaste('x\ny', 'cite_paragraph')).toBe('x y');
      expect(normalizeClipboardTextForPaste('x\ny', 'undertag')).toBe('x y');
      expect(normalizeClipboardTextForPaste('x\ny', 'analytic')).toBe('x y');
    });

    it('passes through multi-line parents unchanged (card_body, paragraph)', () => {
      // Multi-paragraph contexts: intentional paragraph splits in
      // the clipboard should survive.
      expect(normalizeClipboardTextForPaste('a\nb', 'card_body')).toBe('a\nb');
      expect(normalizeClipboardTextForPaste('a\nb', 'paragraph')).toBe('a\nb');
      expect(normalizeClipboardTextForPaste('  a  ', 'card_body')).toBe('  a  ');
    });

    it('folds PDF-extraction exotic spaces to plain spaces in multi-line parents (the nora figure-space case)', () => {
      // A libgen PDF's word gaps arrived as U+2007 FIGURE SPACE — a
      // NON-breaking space — so the pasted card could only wrap at
      // stray intra-word spaces or mid-word, rendering fake line
      // breaks that survive backspace. Plain paste must fold them.
      expect(
        normalizeClipboardTextForPaste('offensive\u2007mari time\u2007power', 'card_body'),
      ).toBe('offensive mari time power');
      expect(
        normalizeClipboardTextForPaste('a\u00A0b\u2009c\u202Fd', 'card_body'),
      ).toBe('a b c d');
    });

    it('strips soft hyphens and zero-widths, and routes LINE/PARAGRAPH SEPARATOR to paragraph splits', () => {
      expect(
        normalizeClipboardTextForPaste('mari\u00ADtime a\u200Bb', 'card_body'),
      ).toBe('maritime ab');
      // U+2028/U+2029 DO carry break semantics — they become newlines
      // (paragraph splits via buildPlainTextSlice), never spaces.
      expect(
        normalizeClipboardTextForPaste('one\u2028two\u2029three', 'card_body'),
      ).toBe('one\ntwo\nthree');
      // …and in single-line parents they flatten like any newline.
      expect(normalizeClipboardTextForPaste('one\u2028two', 'tag')).toBe('one two');
    });

    it('plain-paste into a tag with trailing newline no longer creates a multi-paragraph slice (regression test for the "skipping around on paste" / scroll-to-bottom bug)', () => {
      // Triple-click in a browser commonly yields "Article Title\n".
      // Without normalization, buildPlainTextSlice would return a
      // 2-paragraph slice that, replaceSelection'd into a tag, splits
      // the surrounding card at the newline boundary and jumps the
      // viewport to the doc-end.
      const normalized = normalizeClipboardTextForPaste('Article Title\n', 'tag');
      const slice = buildPlainTextSlice(normalized);
      expect(slice.content.childCount).toBe(1);
      expect(slice.content.firstChild!.type.name).toBe('text');
      expect(slice.openStart).toBe(0);
      expect(slice.openEnd).toBe(0);
    });
  });

  it('inserts into a paragraph cleanly via replaceSelection (cursor in mid-text)', () => {
    const doc = makeDoc([paragraph('abc def')]);
    let pos = -1;
    doc.descendants((n, p) => { if (n.isText) pos = p + 4; return true; }); // between 'abc ' and 'def'
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, pos)));
    const slice = buildPlainTextSlice('X\nY');
    const next = state.apply(state.tr.replaceSelection(slice));
    const docTypes = next.doc.content.content.map((c) => c.type.name);
    expect(docTypes).toEqual(['paragraph', 'paragraph']);
    expect(next.doc.firstChild!.textContent).toBe('abc X');
    expect(next.doc.lastChild!.textContent).toBe('Ydef');
  });

  it('inside a card_body, the split halves keep card_body type', () => {
    // The slice's paragraph splits cause the enclosing block to split.
    // Inside a card, PM may lift the trailing half out as a doc-level
    // paragraph; the runtime absorb-plugin then re-absorbs it as a
    // card_body. Test scope here is just: the split halves of the
    // cursor's BODY each carry the original text on the right side.
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [tag('T'), cardBody('hello')]),
    ]);
    let pos = -1;
    doc.descendants((n, p) => { if (n.isText && n.text === 'hello') pos = p + 4; return true; });
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, pos)));
    const slice = buildPlainTextSlice('A\nB');
    const next = state.apply(state.tr.replaceSelection(slice));
    // First doc child: card with [tag, card_body('helA')].
    const card = next.doc.firstChild!;
    expect(card.type.name).toBe('card');
    expect(card.lastChild!.type.name).toBe('card_body');
    // Cursor at offset 4 in 'hello' splits as 'hell' + 'o'.
    expect(card.lastChild!.textContent).toBe('hellA');
    // The trailing 'Bo' lands somewhere; the absorb plugin in the
    // running editor will re-claim it as a sibling card_body.
    expect(next.doc.textContent).toContain('Bo');
  });
});

describe('tryPasteSplitContainer (paste tag/analytic into a container body)', () => {
  function tagSlice(text: string) {
    return new Slice(Fragment.from(tag(text)), 0, 0);
  }
  function analyticSlice(text: string) {
    return new Slice(Fragment.from(analytic(text)), 0, 0);
  }

  function stateInBody(card: ReturnType<typeof cardWith>, bodyText: string, offset: number): EditorState {
    const doc = makeDoc([card]);
    let pos = -1;
    doc.descendants((n, p) => { if (n.isText && n.text === bodyText) pos = p + offset; return true; });
    const base = EditorState.create({ doc });
    return base.apply(base.tr.setSelection(TextSelection.create(base.doc, pos)));
  }

  it('tag pasted into a card_body in the middle splits the card', () => {
    const card = cardWith(tag('Original'), cardBody('foobar'));
    const state = stateInBody(card, 'foobar', 3); // cursor: 'foo|bar'
    const tr = tryPasteSplitContainer(state, tagSlice('Pasted'));
    expect(tr).not.toBeNull();
    const next = state.apply(tr!);
    expect(next.doc.childCount).toBe(2);
    const c1 = next.doc.firstChild!;
    const c2 = next.doc.lastChild!;
    expect(c1.type.name).toBe('card');
    expect(c2.type.name).toBe('card');
    const c1kids: { type: string; text: string }[] = [];
    c1.forEach((c) => c1kids.push({ type: c.type.name, text: c.textContent }));
    expect(c1kids).toEqual([
      { type: 'tag', text: 'Original' },
      { type: 'card_body', text: 'foo' },
    ]);
    const c2kids: { type: string; text: string }[] = [];
    c2.forEach((c) => c2kids.push({ type: c.type.name, text: c.textContent }));
    expect(c2kids).toEqual([
      { type: 'tag', text: 'Pasted' },
      { type: 'card_body', text: 'bar' },
    ]);
  });

  it('cursor at start of body: original card keeps no pre-body, new card holds the full body', () => {
    const card = cardWith(tag('T'), cardBody('content'));
    const state = stateInBody(card, 'content', 0);
    const tr = tryPasteSplitContainer(state, tagSlice('New'));
    const next = state.apply(tr!);
    const c1Kids: string[] = [];
    next.doc.firstChild!.forEach((c) => c1Kids.push(c.type.name));
    expect(c1Kids).toEqual(['tag']);
    const c2Kids: { type: string; text: string }[] = [];
    next.doc.lastChild!.forEach((c) => c2Kids.push({ type: c.type.name, text: c.textContent }));
    expect(c2Kids).toEqual([
      { type: 'tag', text: 'New' },
      { type: 'card_body', text: 'content' },
    ]);
  });

  it('cursor at end of body: new card has just the pasted tag, no post-body', () => {
    const card = cardWith(tag('T'), cardBody('content'));
    const state = stateInBody(card, 'content', 'content'.length);
    const tr = tryPasteSplitContainer(state, tagSlice('New'));
    const next = state.apply(tr!);
    const c1Kids: { type: string; text: string }[] = [];
    next.doc.firstChild!.forEach((c) => c1Kids.push({ type: c.type.name, text: c.textContent }));
    expect(c1Kids).toEqual([
      { type: 'tag', text: 'T' },
      { type: 'card_body', text: 'content' },
    ]);
    const c2Kids: string[] = [];
    next.doc.lastChild!.forEach((c) => c2Kids.push(c.type.name));
    expect(c2Kids).toEqual(['tag']);
    expect(next.doc.lastChild!.firstChild!.textContent).toBe('New');
  });

  it('following bodies move to the new card', () => {
    const card = cardWith(
      tag('T'),
      cardBody('a'),
      cardBody('b'),
      cardBody('c'),
    );
    // Cursor at end of 'b' (the middle body).
    const state = stateInBody(card, 'b', 1);
    const tr = tryPasteSplitContainer(state, tagSlice('NewTag'));
    const next = state.apply(tr!);
    expect(next.doc.childCount).toBe(2);
    const c1Texts: string[] = [];
    next.doc.firstChild!.forEach((c) => c1Texts.push(c.textContent));
    expect(c1Texts).toEqual(['T', 'a', 'b']);
    const c2Texts: string[] = [];
    next.doc.lastChild!.forEach((c) => c2Texts.push(c.textContent));
    // No post-body (cursor at end of 'b'), so just NewTag + the trailing 'c'.
    expect(c2Texts).toEqual(['NewTag', 'c']);
  });

  it('analytic pasted into a card_body splits into card + analytic_unit', () => {
    const card = cardWith(tag('T'), cardBody('foobar'));
    const state = stateInBody(card, 'foobar', 3);
    const tr = tryPasteSplitContainer(state, analyticSlice('Pasted'));
    expect(tr).not.toBeNull();
    const next = state.apply(tr!);
    expect(next.doc.firstChild!.type.name).toBe('card');
    expect(next.doc.lastChild!.type.name).toBe('analytic_unit');
    expect(next.doc.lastChild!.firstChild!.type.name).toBe('analytic');
    expect(next.doc.lastChild!.firstChild!.textContent).toBe('Pasted');
  });

  it('a whole copied card (tag + body) keeps its structure when pasted into a card', () => {
    // The flat [tag, card_body] shape a whole-card copy produces. Pasting it
    // mid-body must preserve the pasted card, NOT absorb its tag into the
    // destination body.
    const card = cardWith(tag('T'), cardBody('foobar'));
    const state = stateInBody(card, 'foobar', 3); // 'foo|bar'
    const slice = new Slice(Fragment.fromArray([tag('Pasted'), cardBody('B')]), 0, 0);
    const next = state.apply(tryPasteSplitContainer(state, slice)!);
    expect(next.doc.childCount).toBe(2);
    const c1: { type: string; text: string }[] = [];
    next.doc.firstChild!.forEach((c) => c1.push({ type: c.type.name, text: c.textContent }));
    expect(c1).toEqual([
      { type: 'tag', text: 'T' },
      { type: 'card_body', text: 'foo' },
    ]);
    const c2: { type: string; text: string }[] = [];
    next.doc.lastChild!.forEach((c) => c2.push({ type: c.type.name, text: c.textContent }));
    // Pasted card keeps tag + its body, and absorbs the destination remainder.
    expect(c2).toEqual([
      { type: 'tag', text: 'Pasted' },
      { type: 'card_body', text: 'B' },
      { type: 'card_body', text: 'bar' },
    ]);
  });

  it('a whole copied card pasted at the END of a card lands as its own card', () => {
    // Paste a card at the end of another card: the pasted card must
    // NOT be absorbed/demoted.
    const card = cardWith(tag('Dest'), cardBody('foobar'));
    const state = stateInBody(card, 'foobar', 'foobar'.length);
    const slice = new Slice(Fragment.fromArray([tag('Pasted'), cardBody('body')]), 0, 0);
    const next = state.apply(tryPasteSplitContainer(state, slice)!);
    const types: string[] = [];
    next.doc.forEach((c) => types.push(c.type.name));
    expect(types).toEqual(['card', 'card']);
    expect(next.doc.firstChild!.textContent).toBe('Destfoobar');
    const c2: string[] = [];
    next.doc.lastChild!.forEach((c) => c2.push(c.type.name + ':' + c.textContent));
    expect(c2).toEqual(['tag:Pasted', 'card_body:body']);
  });

  it('a whole copied card as a card NODE slice also lands as its own card', () => {
    const cardNode = cardWith(tag('Pasted'), cardBody('body'));
    const dest = cardWith(tag('Dest'), cardBody('foobar'));
    const state = stateInBody(dest, 'foobar', 'foobar'.length);
    const slice = new Slice(Fragment.from(cardNode), 0, 0);
    const next = state.apply(tryPasteSplitContainer(state, slice)!);
    const types: string[] = [];
    next.doc.forEach((c) => types.push(c.type.name));
    expect(types).toEqual(['card', 'card']);
    expect(next.doc.lastChild!.firstChild!.type.name).toBe('tag');
    expect(next.doc.lastChild!.firstChild!.textContent).toBe('Pasted');
  });

  it('a heading pasted MID-body ejects the remainder to a doc-root paragraph', () => {
    const card = cardWith(tag('T'), cardBody('foobar'));
    const state = stateInBody(card, 'foobar', 3); // 'foo|bar'
    const slice = new Slice(Fragment.from(pocket('P')), 0, 0);
    const next = state.apply(tryPasteSplitContainer(state, slice)!);
    const top: { type: string; text: string }[] = [];
    next.doc.forEach((c) => top.push({ type: c.type.name, text: c.textContent }));
    expect(top).toEqual([
      { type: 'card', text: 'Tfoo' },
      { type: 'pocket', text: 'P' },
      { type: 'paragraph', text: 'bar' },
    ]);
  });

  it('a copied heading + its content keeps BOTH when pasted into a card', () => {
    const card = cardWith(tag('Dest'), cardBody('foobar'));
    const state = stateInBody(card, 'foobar', 'foobar'.length);
    const slice = new Slice(Fragment.fromArray([pocket('Heading'), paragraph('content')]), 0, 0);
    const next = state.apply(tryPasteSplitContainer(state, slice)!);
    const top: { type: string; text: string }[] = [];
    next.doc.forEach((c) => top.push({ type: c.type.name, text: c.textContent }));
    expect(top).toEqual([
      { type: 'card', text: 'Destfoobar' },
      { type: 'pocket', text: 'Heading' },
      { type: 'paragraph', text: 'content' },
    ]);
  });

  it("returns null when the slice's first child isn't a tag/analytic/heading", () => {
    const card = cardWith(tag('T'), cardBody('foobar'));
    const state = stateInBody(card, 'foobar', 3);
    const slice = new Slice(Fragment.from(cardBody('X')), 0, 0);
    expect(tryPasteSplitContainer(state, slice)).toBeNull();
  });

  it('returns null when the cursor is at doc level (not in a container body)', () => {
    const doc = makeDoc([paragraph('something')]);
    const state = cursorIn(doc, (n) => n.type.name === 'paragraph');
    expect(tryPasteSplitContainer(state, tagSlice('X'))).toBeNull();
  });

  it('returns null when the cursor is in the head (tag), not a body slot', () => {
    const card = cardWith(tag('Original'), cardBody('body'));
    const doc = makeDoc([card]);
    let pos = -1;
    doc.descendants((n, p) => { if (n.isText && n.text === 'Original') pos = p + 1; return true; });
    const base = EditorState.create({ doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, pos)));
    expect(tryPasteSplitContainer(state, tagSlice('X'))).toBeNull();
  });
});

// ---- Style-apply formatting strip rules ----

function bodyParagraphWithMarkedText(...runs: { text: string; markName: string; attrs?: Record<string, unknown> }[]) {
  const nodes = runs.map((r) => {
    const mt = schema.marks[r.markName]!;
    return schema.text(r.text, [mt.create(r.attrs ?? {})]);
  });
  return schema.nodes['card_body']!.create(null, nodes);
}

function hasMarkOnText(
  doc: import('prosemirror-model').Node,
  textFragment: string,
  markName: string,
): boolean {
  let any = false;
  doc.descendants((n) => {
    if (!n.isText) return;
    if (!(n.text ?? '').includes(textFragment)) return;
    if (n.marks.some((m) => m.type.name === markName)) any = true;
  });
  return any;
}

describe('F8/F9/F10 apply strips direct formatting', () => {
  it('applyCite (F10): strips font_size + bold + highlight, keeps cite_mark', () => {
    const doc = makeDoc([
      cardWithChildren(
        tag('T'),
        bodyParagraphWithMarkedText(
          { text: 'small bold', markName: 'font_size', attrs: { halfPoints: 16 } },
        ),
      ),
    ]);
    let from = -1;
    let to = -1;
    doc.descendants((n, p) => {
      if (n.isText && (n.text ?? '').includes('small bold')) {
        from = p;
        to = p + n.nodeSize;
      }
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, from, to)),
    );
    const next = apply(state, applyCite());
    expect(next).not.toBeNull();
    expect(hasMarkOnText(next!.doc, 'small bold', 'cite_mark')).toBe(true);
    expect(hasMarkOnText(next!.doc, 'small bold', 'font_size')).toBe(false);
  });

  it('applyEmphasis (F10): strips bold but PRESERVES highlight on apply', () => {
    // Applying a named character style (cite / emphasis / underline)
    // keeps the highlight color — highlights mark "this is the
    // argument-text" regardless of the typographic re-skin.
    // Toggle-off behaviors still strip highlight when the user
    // opts in.
    const bold = schema.marks['bold']!.create();
    const hl = schema.marks['highlight']!.create({ color: 'yellow' });
    const text = schema.text('important', [bold, hl]);
    const body = schema.nodes['card_body']!.create(null, text);
    const doc = makeDoc([cardWithChildren(tag('T'), body)]);
    let from = -1;
    let to = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'important') {
        from = p;
        to = p + n.nodeSize;
      }
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, from, to)),
    );
    const next = apply(state, applyEmphasis());
    expect(next).not.toBeNull();
    expect(hasMarkOnText(next!.doc, 'important', 'emphasis_mark')).toBe(true);
    expect(hasMarkOnText(next!.doc, 'important', 'bold')).toBe(false);
    // Highlight survives the apply.
    expect(hasMarkOnText(next!.doc, 'important', 'highlight')).toBe(true);
  });

  it('applyUnderline (F9): apply direction strips direct formatting', () => {
    const bold = schema.marks['bold']!.create();
    const fs = schema.marks['font_size']!.create({ halfPoints: 16 });
    const text = schema.text('hello', [bold, fs]);
    const body = schema.nodes['card_body']!.create(null, text);
    const doc = makeDoc([cardWithChildren(tag('T'), body)]);
    let from = -1;
    let to = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'hello') {
        from = p;
        to = p + n.nodeSize;
      }
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, from, to)),
    );
    const next = apply(state, applyUnderline());
    expect(next).not.toBeNull();
    expect(hasMarkOnText(next!.doc, 'hello', 'underline_mark')).toBe(true);
    expect(hasMarkOnText(next!.doc, 'hello', 'bold')).toBe(false);
    expect(hasMarkOnText(next!.doc, 'hello', 'font_size')).toBe(false);
  });

  it('applyUnderline (F9): toggle-off WITH setting on strips direct formatting too', () => {
    const um = schema.marks['underline_mark']!.create();
    const bold = schema.marks['bold']!.create();
    const text = schema.text('hello', [um, bold]);
    const body = schema.nodes['card_body']!.create(null, text);
    const doc = makeDoc([cardWithChildren(tag('T'), body)]);
    let from = -1;
    let to = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'hello') {
        from = p;
        to = p + n.nodeSize;
      }
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, from, to)),
    );
    const next = apply(state, applyUnderline(() => true));
    expect(next).not.toBeNull();
    // Toggle off: underline_mark removed AND bold cleared.
    expect(hasMarkOnText(next!.doc, 'hello', 'underline_mark')).toBe(false);
    expect(hasMarkOnText(next!.doc, 'hello', 'bold')).toBe(false);
  });

  it('applyUnderline (F9): toggle-off WITH setting off preserves direct formatting', () => {
    const um = schema.marks['underline_mark']!.create();
    const bold = schema.marks['bold']!.create();
    const text = schema.text('hello', [um, bold]);
    const body = schema.nodes['card_body']!.create(null, text);
    const doc = makeDoc([cardWithChildren(tag('T'), body)]);
    let from = -1;
    let to = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'hello') {
        from = p;
        to = p + n.nodeSize;
      }
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, from, to)),
    );
    const next = apply(state, applyUnderline(() => false));
    expect(next).not.toBeNull();
    // Toggle off: underline_mark removed but bold kept.
    expect(hasMarkOnText(next!.doc, 'hello', 'underline_mark')).toBe(false);
    expect(hasMarkOnText(next!.doc, 'hello', 'bold')).toBe(true);
  });

  it('applyUnderline (F9) in a tag: applies underline_direct AND preserves it (not stripped)', () => {
    // Structural F9 puts underline_direct, which is itself direct
    // formatting. The strip pass must NOT erase the mark it just added.
    const doc = makeDoc([cardWithChildren(tag('TagText'))]);
    let from = -1;
    let to = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'TagText') {
        from = p;
        to = p + n.nodeSize;
      }
      return true;
    });
    const base = EditorState.create({ doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, from, to)),
    );
    const next = apply(state, applyUnderline());
    expect(next).not.toBeNull();
    expect(hasMarkOnText(next!.doc, 'TagText', 'underline_direct')).toBe(true);
  });
});

describe('F4–F7 promotion strips marks; tag↔analytic preserves them', () => {
  it('F4 setHeading: doc-level paragraph with bold+font_size → pocket clears both marks', () => {
    const bold = schema.marks['bold']!.create();
    const fs = schema.marks['font_size']!.create({ halfPoints: 16 });
    const para = schema.nodes['paragraph']!.create(null, schema.text('hello', [bold, fs]));
    const doc = makeDoc([para]);
    const state = cursorIn(doc, (n) => n.type.name === 'paragraph');
    const next = apply(state, setHeading('pocket'));
    expect(next).not.toBeNull();
    expect(next!.doc.firstChild!.type.name).toBe('pocket');
    expect(hasMarkOnText(next!.doc, 'hello', 'bold')).toBe(false);
    expect(hasMarkOnText(next!.doc, 'hello', 'font_size')).toBe(false);
  });

  it('F7 setTag: paragraph with cite_mark+highlight → tag strips both', () => {
    const cite = schema.marks['cite_mark']!.create();
    const hl = schema.marks['highlight']!.create({ color: 'yellow' });
    const para = schema.nodes['paragraph']!.create(null, schema.text('hello', [cite, hl]));
    const doc = makeDoc([para]);
    const state = cursorIn(doc, (n) => n.type.name === 'paragraph');
    const next = apply(state, setTag());
    expect(next).not.toBeNull();
    // After wrap: doc → card → tag → text 'hello'
    expect(hasMarkOnText(next!.doc, 'hello', 'cite_mark')).toBe(false);
    expect(hasMarkOnText(next!.doc, 'hello', 'highlight')).toBe(false);
  });

  it('Mod-F7 setAnalytic on a card anchor tag: PRESERVES bold (same-tier swap)', () => {
    const bold = schema.marks['bold']!.create();
    const tagNode = schema.nodes['tag']!.create(
      { id: 'tag-id' },
      schema.text('TagWithBold', [bold]),
    );
    const cardNode = schema.nodes['card']!.create(null, [tagNode]);
    const doc = makeDoc([cardNode]);
    const state = cursorIn(doc, (n) => n.type.name === 'tag');
    const next = apply(state, setAnalytic());
    expect(next).not.toBeNull();
    // analytic_unit → analytic → text 'TagWithBold'
    expect(hasMarkOnText(next!.doc, 'TagWithBold', 'bold')).toBe(true);
  });

  it('F7 setTag on an analytic_unit anchor analytic: PRESERVES bold (same-tier swap)', () => {
    const bold = schema.marks['bold']!.create();
    const analyticNode = schema.nodes['analytic']!.create(
      { id: 'analytic-id' },
      schema.text('AnalyticBold', [bold]),
    );
    const unitNode = schema.nodes['analytic_unit']!.create(null, [analyticNode]);
    const doc = makeDoc([unitNode]);
    const state = cursorIn(doc, (n) => n.type.name === 'analytic');
    const next = apply(state, setTag());
    expect(next).not.toBeNull();
    expect(hasMarkOnText(next!.doc, 'AnalyticBold', 'bold')).toBe(true);
  });

  it('F4 setHeading dissolving a card anchor tag: strips marks (tag → pocket is a real swap)', () => {
    const bold = schema.marks['bold']!.create();
    const tagNode = schema.nodes['tag']!.create(
      { id: 'tag-id' },
      schema.text('PromoteMe', [bold]),
    );
    const cardNode = schema.nodes['card']!.create(null, [tagNode]);
    const doc = makeDoc([cardNode]);
    const state = cursorIn(doc, (n) => n.type.name === 'tag');
    const next = apply(state, setHeading('pocket'));
    expect(next).not.toBeNull();
    expect(next!.doc.firstChild!.type.name).toBe('pocket');
    expect(hasMarkOnText(next!.doc, 'PromoteMe', 'bold')).toBe(false);
  });

  it('Mod-F8 setUndertag from a body paragraph: strips marks', () => {
    const hl = schema.marks['highlight']!.create({ color: 'yellow' });
    const para = schema.nodes['paragraph']!.create(null, schema.text('plain', [hl]));
    const doc = makeDoc([para]);
    const state = cursorIn(doc, (n) => n.type.name === 'paragraph');
    const next = apply(state, setUndertag());
    expect(next).not.toBeNull();
    expect(next!.doc.firstChild!.type.name).toBe('undertag');
    expect(hasMarkOnText(next!.doc, 'plain', 'highlight')).toBe(false);
  });
});

// ---- removeHyperlinks ----

describe('removeHyperlinks', () => {
  function withLink(text: string, href: string) {
    return schema.text(text, [schema.marks['link']!.create({ href })]);
  }

  function hasLink(doc: import('prosemirror-model').Node): boolean {
    let found = false;
    doc.descendants((node) => {
      if (found) return false;
      if (!node.isText) return true;
      if (node.marks.some((m) => m.type.name === 'link')) found = true;
      return true;
    });
    return found;
  }

  it('is a no-op when no link marks exist in scope', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['paragraph']!.create(null, schema.text('plain text')),
    ]);
    const state = EditorState.create({ doc, schema });
    const result = removeHyperlinks()(state, undefined);
    expect(result).toBe(false);
  });

  it('with empty selection, strips link marks doc-wide', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['paragraph']!.create(null, [
        schema.text('before '),
        withLink('linked', 'https://a'),
        schema.text(' after'),
      ]),
      schema.nodes['paragraph']!.create(null, withLink('another link', 'https://b')),
    ]);
    const state = EditorState.create({ doc, schema });
    expect(hasLink(state.doc)).toBe(true);
    let next: EditorState | null = null;
    removeHyperlinks()(state, (tr) => { next = state.apply(tr); });
    expect(next).not.toBeNull();
    expect(hasLink(next!.doc)).toBe(false);
    // The text content survives the unlink.
    // PM joins block children with a NUL char in textContent; check
    // each paragraph independently.
    expect(next!.doc.firstChild!.textContent).toBe("before linked after");
    expect(next!.doc.lastChild!.textContent).toBe("another link");
  });

  it('with non-empty selection, strips only link marks in the selection', () => {
    const link1 = withLink('linkA', 'https://a');
    const link2 = withLink('linkB', 'https://b');
    const para1 = schema.nodes['paragraph']!.create(null, [
      schema.text('p1 '),
      link1,
    ]);
    const para2 = schema.nodes['paragraph']!.create(null, [
      schema.text('p2 '),
      link2,
    ]);
    const doc = schema.nodes['doc']!.createChecked(null, [para1, para2]);
    const state0 = EditorState.create({ doc, schema });

    // Select inside paragraph 1 only — covers link1's text range.
    // Doc layout: <doc><p>0 p1<sp>linkA</p><p>p2<sp>linkB</p></doc>
    // Position 1 = inside p1 at start. Want to cover "linkA" only.
    const para1Start = 1;                       // inside <p1>
    const link1Start = para1Start + 'p1 '.length;
    const link1End = link1Start + 'linkA'.length;
    const state = state0.apply(
      state0.tr.setSelection(TextSelection.create(state0.doc, link1Start, link1End)),
    );
    let next: EditorState | null = null;
    const ran = removeHyperlinks()(state, (tr) => { next = state.apply(tr); });
    expect(ran).toBe(true);
    expect(next).not.toBeNull();
    // link1 removed, link2 untouched.
    const link2Text = next!.doc.lastChild!.lastChild!;
    expect(link2Text.marks.some((m) => m.type.name === 'link')).toBe(true);
    const para1Children: import('prosemirror-model').Node[] = [];
    next!.doc.firstChild!.forEach((c) => para1Children.push(c));
    expect(
      para1Children.every(
        (c) => !c.isText || !c.marks.some((m) => m.type.name === 'link'),
      ),
    ).toBe(true);
  });

  it('splits a partially-selected link, leaving the unselected portion linked', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['paragraph']!.create(
        null,
        withLink('hello world', 'https://x'),
      ),
    ]);
    const state0 = EditorState.create({ doc, schema });

    // Select just the "hello " part. Position 1 = inside the paragraph.
    const start = 1;
    const end = start + 'hello '.length;
    const state = state0.apply(
      state0.tr.setSelection(TextSelection.create(state0.doc, start, end)),
    );
    let next: EditorState | null = null;
    removeHyperlinks()(state, (tr) => { next = state.apply(tr); });
    expect(next).not.toBeNull();
    // The paragraph should now have one unlinked "hello " + one linked "world".
    const children: import('prosemirror-model').Node[] = [];
    next!.doc.firstChild!.forEach((c) => children.push(c));
    expect(children.length).toBe(2);
    expect(children[0]!.text).toBe('hello ');
    expect(children[0]!.marks.some((m) => m.type.name === 'link')).toBe(false);
    expect(children[1]!.text).toBe('world');
    expect(children[1]!.marks.some((m) => m.type.name === 'link')).toBe(true);
  });
});

// ---- convertAnalyticsToTags ----

describe('convertAnalyticsToTags', () => {
  function analyticUnit(headingText: string, bodyText: string, id = newHeadingId()) {
    const analytic = schema.nodes['analytic']!.create(
      { id },
      schema.text(headingText),
    );
    const body = schema.nodes['card_body']!.create(null, schema.text(bodyText));
    return schema.nodes['analytic_unit']!.create(null, [analytic, body]);
  }
  function cardWith(tagText: string, bodyText: string, id = newHeadingId()) {
    const tag = schema.nodes['tag']!.create({ id }, schema.text(tagText));
    const body = schema.nodes['card_body']!.create(null, schema.text(bodyText));
    return schema.nodes['card']!.create(null, [tag, body]);
  }

  it('is a no-op when the doc has no analytic_units', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      cardWith('Tag', 'body'),
    ]);
    const state = EditorState.create({ doc, schema });
    expect(convertAnalyticsToTags()(state, undefined)).toBe(false);
  });

  it('with empty selection, converts every analytic_unit in the doc', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      analyticUnit('A1', 'body1'),
      cardWith('CardTag', 'cardBody'),
      analyticUnit('A2', 'body2'),
    ]);
    const state = EditorState.create({ doc, schema });
    let next: EditorState | null = null;
    convertAnalyticsToTags()(state, (tr) => { next = state.apply(tr); });
    expect(next).not.toBeNull();
    expect(next!.doc.childCount).toBe(3);
    const types = [
      next!.doc.child(0).type.name,
      next!.doc.child(1).type.name,
      next!.doc.child(2).type.name,
    ];
    expect(types).toEqual(['card', 'card', 'card']);
    // Each card's first child should be a tag, and the heading text
    // should survive the swap.
    expect(next!.doc.child(0).firstChild!.type.name).toBe('tag');
    expect(next!.doc.child(0).firstChild!.textContent).toBe('A1');
    expect(next!.doc.child(2).firstChild!.textContent).toBe('A2');
    // The middle (already a card) is untouched.
    expect(next!.doc.child(1).firstChild!.textContent).toBe('CardTag');
  });

  it('preserves the heading id when converting', () => {
    const id = newHeadingId();
    const doc = schema.nodes['doc']!.createChecked(null, [
      analyticUnit('Heading', 'body', id),
    ]);
    const state = EditorState.create({ doc, schema });
    let next: EditorState | null = null;
    convertAnalyticsToTags()(state, (tr) => { next = state.apply(tr); });
    expect(next!.doc.firstChild!.firstChild!.attrs['id']).toBe(id);
  });

  it('with non-empty selection, only converts analytic_units the selection touches', () => {
    const a1 = analyticUnit('First', 'b1');
    const a2 = analyticUnit('Second', 'b2');
    const a3 = analyticUnit('Third', 'b3');
    const doc = schema.nodes['doc']!.createChecked(null, [a1, a2, a3]);
    const state0 = EditorState.create({ doc, schema });

    // Select inside a2's body. Doc layout:
    //   <doc>
    //     <analytic_unit>… (a1.nodeSize)
    //     <analytic_unit>… (a2.nodeSize)
    //     <analytic_unit>… (a3.nodeSize)
    //   </doc>
    const a2Start = a1.nodeSize;
    // Position somewhere inside a2 (a2's first child is analytic at +1,
    // body starts after analytic). Anywhere within suffices.
    const selPos = a2Start + 3;
    const state = state0.apply(
      state0.tr.setSelection(TextSelection.create(state0.doc, selPos)),
    );
    let next: EditorState | null = null;
    // An empty selection means doc-wide scope, so expand to a
    // non-empty selection to exercise the intersect-selection branch.
    const expanded = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, selPos, selPos + 1)),
    );
    convertAnalyticsToTags()(expanded, (tr) => { next = expanded.apply(tr); });
    expect(next).not.toBeNull();
    // Only a2 was touched → card; a1 + a3 remain analytic_units.
    expect(next!.doc.child(0).type.name).toBe('analytic_unit');
    expect(next!.doc.child(1).type.name).toBe('card');
    expect(next!.doc.child(2).type.name).toBe('analytic_unit');
  });

  it('preserves body slots (card_body / cite_paragraph / undertag)', () => {
    const id = newHeadingId();
    const analytic = schema.nodes['analytic']!.create(
      { id },
      schema.text('H'),
    );
    const body = schema.nodes['card_body']!.create(null, schema.text('body'));
    const cite = schema.nodes['cite_paragraph']!.create(
      null,
      schema.text('the cite', [schema.marks['cite_mark']!.create()]),
    );
    const undertag = schema.nodes['undertag']!.create(
      null,
      schema.text('undertag text'),
    );
    const unit = schema.nodes['analytic_unit']!.create(null, [
      analytic, body, cite, undertag,
    ]);
    const doc = schema.nodes['doc']!.createChecked(null, [unit]);
    const state = EditorState.create({ doc, schema });
    let next: EditorState | null = null;
    convertAnalyticsToTags()(state, (tr) => { next = state.apply(tr); });
    const card = next!.doc.firstChild!;
    expect(card.type.name).toBe('card');
    expect(card.childCount).toBe(4);
    expect(card.child(0).type.name).toBe('tag');
    expect(card.child(1).type.name).toBe('card_body');
    expect(card.child(2).type.name).toBe('cite_paragraph');
    expect(card.child(3).type.name).toBe('undertag');
  });
});

// ---- convertCitedAnalyticsToTags ----

describe('convertCitedAnalyticsToTags', () => {
  function citelessUnit(headingText: string, id = newHeadingId()) {
    const analytic = schema.nodes['analytic']!.create({ id }, schema.text(headingText));
    const body = schema.nodes['card_body']!.create(null, schema.text('body'));
    return schema.nodes['analytic_unit']!.create(null, [analytic, body]);
  }
  function citedUnit(headingText: string, id = newHeadingId()) {
    const analytic = schema.nodes['analytic']!.create({ id }, schema.text(headingText));
    const cite = schema.nodes['cite_paragraph']!.create(
      null,
      schema.text('the cite', [schema.marks['cite_mark']!.create()]),
    );
    return schema.nodes['analytic_unit']!.create(null, [analytic, cite]);
  }

  it('converts only analytic_units that contain a cite_paragraph', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      citelessUnit('Bare'),
      citedUnit('Cited'),
    ]);
    const state = EditorState.create({ doc, schema });
    let next: EditorState | null = null;
    convertCitedAnalyticsToTags()(state, (tr) => { next = state.apply(tr); });
    expect(next).not.toBeNull();
    // The bare analytic stays an analytic_unit; the cited one becomes a card.
    expect(next!.doc.child(0).type.name).toBe('analytic_unit');
    expect(next!.doc.child(1).type.name).toBe('card');
    expect(next!.doc.child(1).firstChild!.type.name).toBe('tag');
    expect(next!.doc.child(1).firstChild!.textContent).toBe('Cited');
  });

  it('is a no-op when no analytic_unit in scope has a cite', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [citelessUnit('Bare')]);
    const state = EditorState.create({ doc, schema });
    expect(convertCitedAnalyticsToTags()(state, undefined)).toBe(false);
  });

  it('with a selection, only converts cited analytics the selection touches', () => {
    const a1 = citedUnit('One');
    const a2 = citedUnit('Two');
    const doc = schema.nodes['doc']!.createChecked(null, [a1, a2]);
    const state0 = EditorState.create({ doc, schema });
    // Select inside a1 only.
    const sel = state0.apply(
      state0.tr.setSelection(TextSelection.create(state0.doc, 3, 4)),
    );
    let next: EditorState | null = null;
    convertCitedAnalyticsToTags()(sel, (tr) => { next = sel.apply(tr); });
    expect(next).not.toBeNull();
    expect(next!.doc.child(0).type.name).toBe('card');
    expect(next!.doc.child(1).type.name).toBe('analytic_unit');
  });
});

// ---- extractUndertag ----

describe('extractUndertag', () => {
  function cardDoc(bodyText: string, undertags: string[] = []) {
    const children = [
      schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('TAG')),
      ...undertags.map((u) => schema.nodes['undertag']!.create(null, schema.text(u))),
      schema.nodes['card_body']!.create(null, schema.text(bodyText)),
    ];
    return schema.nodes['doc']!.createChecked(null, [
      schema.nodes['card']!.create(null, children),
    ]);
  }
  function findText(doc: ReturnType<typeof cardDoc>, text: string): number {
    let pos = -1;
    doc.descendants((n, p) => {
      if (pos !== -1) return false;
      if (n.isText && n.text && n.text.includes(text)) {
        pos = p + n.text.indexOf(text);
        return false;
      }
      return true;
    });
    if (pos < 0) throw new Error(`text "${text}" not found`);
    return pos;
  }
  function run(doc: ReturnType<typeof cardDoc>, needle: string, inQuotes: boolean): EditorState {
    const start = findText(doc, needle);
    const base = EditorState.create({ doc, schema });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(doc, start, start + needle.length)),
    );
    let next: EditorState | null = null;
    extractUndertag(() => inQuotes)(state, (tr) => { next = state.apply(tr); });
    if (!next) throw new Error('extractUndertag did not dispatch');
    return next;
  }

  it('inserts the selection as an undertag right after the tag', () => {
    const card = run(cardDoc('hello world body'), 'world', false).doc.firstChild!;
    const types: string[] = [];
    card.forEach((c) => types.push(c.type.name));
    expect(types).toEqual(['tag', 'undertag', 'card_body']);
    expect(card.child(1).textContent).toBe('world');
    // The original body text is untouched (extract = copy).
    expect(card.child(2).textContent).toBe('hello world body');
  });

  it('inserts below existing undertags', () => {
    const card = run(cardDoc('hello world', ['first', 'second']), 'world', false).doc.firstChild!;
    const undertags: string[] = [];
    card.forEach((c) => { if (c.type.name === 'undertag') undertags.push(c.textContent); });
    expect(undertags).toEqual(['first', 'second', 'world']);
  });

  it('wraps the excerpt in quotes when the setting is on', () => {
    const card = run(cardDoc('hello world body'), 'world', true).doc.firstChild!;
    expect(card.child(1).textContent).toBe('"world"');
  });

  it('is a no-op with an empty selection', () => {
    const doc = cardDoc('body');
    const state = EditorState.create({ doc, schema });
    expect(extractUndertag(() => false)(state, undefined)).toBe(false);
  });

  it('is a no-op when the selection is not inside a card', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['paragraph']!.create(null, schema.text('loose text')),
    ]);
    const start = 1;
    const state = EditorState.create({ doc, schema }).apply(
      EditorState.create({ doc, schema }).tr.setSelection(
        TextSelection.create(doc, start, start + 4),
      ),
    );
    expect(extractUndertag(() => false)(state, undefined)).toBe(false);
  });
});

// ---- fixFormattingGaps ----

describe('fixFormattingGaps', () => {
  // Mirror the production `effectivePtForNode` resolver from
  // index.ts but with hardcoded defaults so tests don't depend on
  // the live settings store.
  const effectivePt = (
    node: import('prosemirror-model').Node | null,
    parent: import('prosemirror-model').Node,
  ): number => {
    const parentDefault: Record<string, number> = {
      pocket: 26, hat: 22, block: 16, tag: 13, analytic: 13, undertag: 12,
    };
    const namedDefault: Record<string, number> = {
      cite_mark: 13, underline_mark: 11, emphasis_mark: 11,
      undertag_mark: 12, analytic_mark: 13,
    };
    const fallback = parentDefault[parent.type.name] ?? 11;
    if (!node || !node.isText) return fallback;
    const fs = node.marks.find((m) => m.type.name === 'font_size');
    if (fs) return Number(fs.attrs['halfPoints']) / 2;
    for (const m of node.marks) {
      const d = namedDefault[m.type.name];
      if (d != null) return d;
    }
    return fallback;
  };

  function underline(text: string) {
    return schema.text(text, [schema.marks['underline_mark']!.create()]);
  }
  function emphasis(text: string) {
    return schema.text(text, [schema.marks['emphasis_mark']!.create()]);
  }
  function cite(text: string) {
    return schema.text(text, [schema.marks['cite_mark']!.create()]);
  }
  function withHighlight(text: string, color: string) {
    return schema.text(text, [schema.marks['highlight']!.create({ color })]);
  }
  function withShading(text: string, color: string) {
    return schema.text(text, [schema.marks['shading']!.create({ color })]);
  }
  function p(...children: import('prosemirror-model').Node[]) {
    return schema.nodes['paragraph']!.create(null, children);
  }
  function makeDoc(...children: import('prosemirror-model').Node[]) {
    return schema.nodes['doc']!.createChecked(null, children);
  }

  // For each char in textContent, get the set of mark type names
  // carried at that position.
  function marksByChar(
    doc: import('prosemirror-model').Node,
  ): { char: string; marks: Set<string> }[] {
    const out: { char: string; marks: Set<string> }[] = [];
    doc.descendants((node) => {
      if (!node.isText || !node.text) return true;
      const names = new Set(node.marks.map((m) => m.type.name));
      for (const ch of node.text) {
        out.push({ char: ch, marks: names });
      }
      return false;
    });
    return out;
  }

  it('is a no-op when no bridgeable gap exists', () => {
    const doc = makeDoc(p(schema.text('plain text here')));
    const state = EditorState.create({ doc, schema });
    expect(fixFormattingGaps(effectivePt)(state, undefined)).toBe(false);
  });

  it('bridges underline_mark across a single-space gap', () => {
    const doc = makeDoc(p(underline('foo'), schema.text(' '), underline('bar')));
    const state = EditorState.create({ doc, schema });
    let next: EditorState | null = null;
    fixFormattingGaps(effectivePt)(state, (tr) => { next = state.apply(tr); });
    expect(next).not.toBeNull();
    const chars = marksByChar(next!.doc);
    // Every char including the space carries underline_mark.
    for (const c of chars) {
      expect(c.marks.has('underline_mark')).toBe(true);
    }
  });

  it('bridges emphasis_mark', () => {
    const doc = makeDoc(p(emphasis('alpha'), schema.text(', '), emphasis('beta')));
    const state = EditorState.create({ doc, schema });
    let next: EditorState | null = null;
    fixFormattingGaps(effectivePt)(state, (tr) => { next = state.apply(tr); });
    const chars = marksByChar(next!.doc);
    for (const c of chars) {
      expect(c.marks.has('emphasis_mark')).toBe(true);
    }
  });

  it('bridges cite_mark', () => {
    // cite_mark inside a cite_paragraph is the natural home, but the
    // command should bridge wherever the bookends both have it.
    const doc = makeDoc(
      schema.nodes['cite_paragraph']!.create(null, [
        cite('Smith'),
        schema.text(', '),
        cite('2024'),
      ]),
    );
    const state = EditorState.create({ doc, schema });
    let next: EditorState | null = null;
    fixFormattingGaps(effectivePt)(state, (tr) => { next = state.apply(tr); });
    const chars = marksByChar(next!.doc);
    for (const c of chars) {
      expect(c.marks.has('cite_mark')).toBe(true);
    }
  });

  // After a bridge, the gap carries the first bookend's marks, so
  // PM merges it with that bookend into a single text node — "just
  // the space" can't be found as its own node. Walk to the char's
  // doc position and read the mark/color there.
  function colorAt(
    doc: import('prosemirror-model').Node,
    markName: 'highlight' | 'shading',
    docPos: number,
  ): string | null {
    let result: string | null = null;
    doc.descendants((node, pos) => {
      if (result != null) return false;
      if (!node.isText || !node.text) return true;
      if (docPos >= pos && docPos < pos + node.nodeSize) {
        const m = node.marks.find((mk) => mk.type.name === markName);
        result = m ? String(m.attrs['color'] ?? '') : null;
        return false;
      }
      return true;
    });
    return result;
  }

  // Highlight / shading bridge whenever BOTH bookends carry the
  // mark, taking the FIRST bookend's color on a mismatch. The
  // underline on the bookends bridges independently.
  it('bridges highlight using the first bookend color when colors differ (qualifying bookends)', () => {
    const u = schema.marks['underline_mark']!.create();
    const doc = makeDoc(p(
      schema.text('aaa', [u, schema.marks['highlight']!.create({ color: 'yellow' })]),
      schema.text(' '),
      schema.text('bbb', [u, schema.marks['highlight']!.create({ color: 'green' })]),
    ));
    const state = EditorState.create({ doc, schema });
    let next: EditorState | null = null;
    fixFormattingGaps(effectivePt)(state, (tr) => { next = state.apply(tr); });
    expect(colorAt(next!.doc, 'highlight', 4)).toBe('yellow');
    const chars = marksByChar(next!.doc);
    for (const c of chars) expect(c.marks.has('highlight')).toBe(true);
  });

  it('bridges shading similarly when bookends qualify', () => {
    const u = schema.marks['underline_mark']!.create();
    const doc = makeDoc(p(
      schema.text('xxx', [u, schema.marks['shading']!.create({ color: 'C0C0C0' })]),
      schema.text('. '),
      schema.text('yyy', [u, schema.marks['shading']!.create({ color: 'D0D0D0' })]),
    ));
    const state = EditorState.create({ doc, schema });
    let next: EditorState | null = null;
    fixFormattingGaps(effectivePt)(state, (tr) => { next = state.apply(tr); });
    expect(colorAt(next!.doc, 'shading', 4)).toBe('C0C0C0');
    expect(colorAt(next!.doc, 'shading', 5)).toBe('C0C0C0');
    const chars = marksByChar(next!.doc);
    for (const c of chars) expect(c.marks.has('shading')).toBe(true);
  });

  it('bridges highlight even when neither bookend carries a named-style mark', () => {
    // Every mark shared by both bookends is bridged — there is no
    // named-style prerequisite. Two highlight-only bookends → the
    // gap gets highlight.
    const doc = makeDoc(p(
      withHighlight('aaa', 'yellow'),
      schema.text(' '),
      withHighlight('bbb', 'yellow'),
    ));
    const state = EditorState.create({ doc, schema });
    let next: EditorState | null = null;
    fixFormattingGaps(effectivePt)(state, (tr) => { next = state.apply(tr); });
    expect(next).not.toBeNull();
    expect(colorAt(next!.doc, 'highlight', 4)).toBe('yellow');
  });

  it('strips a stale named-style mark from a gap whose bookends do not share it', () => {
    // Cleanup behavior: bookends are plain text, but the gap carries
    // a stale underline_mark. Marks the bookends don't share are
    // stripped from the gap.
    const doc = makeDoc(p(
      schema.text('foo'),
      schema.text(' ', [schema.marks['underline_mark']!.create()]),
      schema.text('bar'),
    ));
    const state = EditorState.create({ doc, schema });
    let next: EditorState | null = null;
    fixFormattingGaps(effectivePt)(state, (tr) => { next = state.apply(tr); });
    expect(next).not.toBeNull();
    const chars = marksByChar(next!.doc);
    expect(chars[3]!.marks.has('underline_mark')).toBe(false);
  });

  it('strips highlight from a gap whose bookends do not share it', () => {
    const u = schema.marks['underline_mark']!.create();
    // Bookends both underlined, but only the left bookend has
    // highlight. The gap (also highlighted) should lose its
    // highlight since right bookend doesn't have it.
    const doc = makeDoc(p(
      schema.text('foo', [u, schema.marks['highlight']!.create({ color: 'yellow' })]),
      schema.text(' ', [schema.marks['highlight']!.create({ color: 'yellow' })]),
      schema.text('bar', [u]),
    ));
    const state = EditorState.create({ doc, schema });
    let next: EditorState | null = null;
    fixFormattingGaps(effectivePt)(state, (tr) => { next = state.apply(tr); });
    const chars = marksByChar(next!.doc);
    // Gap (index 3) should NOT have highlight anymore; should still
    // have underline (bridged from both bookends).
    expect(chars[3]!.marks.has('highlight')).toBe(false);
    expect(chars[3]!.marks.has('underline_mark')).toBe(true);
  });

  it('does not bridge when only one bookend has the mark', () => {
    const doc = makeDoc(p(underline('foo'), schema.text(' bar')));
    const state = EditorState.create({ doc, schema });
    expect(fixFormattingGaps(effectivePt)(state, undefined)).toBe(false);
  });

  it('does not cross paragraph breaks', () => {
    const doc = makeDoc(
      p(underline('foo')),
      p(underline('bar')),
    );
    const state = EditorState.create({ doc, schema });
    expect(fixFormattingGaps(effectivePt)(state, undefined)).toBe(false);
  });

  it('respects selection scope', () => {
    // Two paragraphs each have a bridgeable gap. Select only the first.
    const para1 = p(underline('aa'), schema.text(' '), underline('bb'));
    const para2 = p(emphasis('cc'), schema.text(' '), emphasis('dd'));
    const doc = makeDoc(para1, para2);
    const state0 = EditorState.create({ doc, schema });
    // Selection within para1 only.
    const selStart = 1;
    const selEnd = 1 + para1.content.size;
    const state = state0.apply(
      state0.tr.setSelection(TextSelection.create(state0.doc, selStart, selEnd)),
    );
    let next: EditorState | null = null;
    fixFormattingGaps(effectivePt)(state, (tr) => { next = state.apply(tr); });
    // Para1 bridged; para2 untouched.
    const para1Chars = marksByChar(next!.doc.child(0));
    for (const c of para1Chars) expect(c.marks.has('underline_mark')).toBe(true);
    // Para2: the space between cc and dd should NOT have emphasis.
    let spaceMarks: Set<string> | null = null;
    next!.doc.child(1).descendants((node) => {
      if (!node.isText) return true;
      if (node.text === ' ') {
        spaceMarks = new Set(node.marks.map((m) => m.type.name));
      }
      return false;
    });
    expect(spaceMarks).not.toBeNull();
    expect(spaceMarks!.has('emphasis_mark')).toBe(false);
  });

  it('bridges multiple mark types simultaneously', () => {
    const both = schema.marks['underline_mark']!.create();
    const hl = schema.marks['highlight']!.create({ color: 'yellow' });
    const doc = makeDoc(p(
      schema.text('foo', [both, hl]),
      schema.text(' '),
      schema.text('bar', [both, hl]),
    ));
    const state = EditorState.create({ doc, schema });
    let next: EditorState | null = null;
    fixFormattingGaps(effectivePt)(state, (tr) => { next = state.apply(tr); });
    const chars = marksByChar(next!.doc);
    for (const c of chars) {
      expect(c.marks.has('underline_mark')).toBe(true);
      expect(c.marks.has('highlight')).toBe(true);
    }
  });

  // Mixed bookend cases — the user's "F9 on the blank space" mental
  // model. The bookends keep their own marks; only the gap chars are
  // touched.
  it('bridges mixed underline/emphasis bookends to underline on the gap', () => {
    const doc = makeDoc(p(
      underline('foo'),
      schema.text(' '),
      emphasis('bar'),
    ));
    const state = EditorState.create({ doc, schema });
    let next: EditorState | null = null;
    fixFormattingGaps(effectivePt)(state, (tr) => { next = state.apply(tr); });
    expect(next).not.toBeNull();
    // 'foo' keeps underline_mark, 'bar' keeps emphasis_mark, and the
    // space gains underline_mark.
    const chars = marksByChar(next!.doc);
    const fooChars = chars.slice(0, 3);
    const spaceChar = chars[3]!;
    const barChars = chars.slice(4, 7);
    for (const c of fooChars) expect(c.marks.has('underline_mark')).toBe(true);
    for (const c of fooChars) expect(c.marks.has('emphasis_mark')).toBe(false);
    expect(spaceChar.marks.has('underline_mark')).toBe(true);
    expect(spaceChar.marks.has('emphasis_mark')).toBe(false);
    for (const c of barChars) expect(c.marks.has('emphasis_mark')).toBe(true);
    for (const c of barChars) expect(c.marks.has('underline_mark')).toBe(false);
  });

  it('bridges mixed emphasis/underline bookends to underline on the gap (reverse order)', () => {
    const doc = makeDoc(p(
      emphasis('foo'),
      schema.text(' '),
      underline('bar'),
    ));
    const state = EditorState.create({ doc, schema });
    let next: EditorState | null = null;
    fixFormattingGaps(effectivePt)(state, (tr) => { next = state.apply(tr); });
    const chars = marksByChar(next!.doc);
    // Gap is at index 3 (after 'foo').
    expect(chars[3]!.marks.has('underline_mark')).toBe(true);
    // Bookends keep their original marks.
    expect(chars[0]!.marks.has('emphasis_mark')).toBe(true);
    expect(chars[0]!.marks.has('underline_mark')).toBe(false);
    expect(chars[4]!.marks.has('underline_mark')).toBe(true);
    expect(chars[4]!.marks.has('emphasis_mark')).toBe(false);
  });

  // Font size on the gap.
  function withFs(text: string, halfPoints: number, otherMarks: import('prosemirror-model').Mark[] = []) {
    return schema.text(text, [
      schema.marks['font_size']!.create({ halfPoints }),
      ...otherMarks,
    ]);
  }

  function fontSizeAtChar(
    doc: import('prosemirror-model').Node,
    charIdx: number,
  ): number | null {
    let cur = 0;
    let result: number | null = null;
    let done = false;
    doc.descendants((node) => {
      if (done) return false;
      if (!node.isText || !node.text) return true;
      if (charIdx >= cur && charIdx < cur + node.text.length) {
        const fs = node.marks.find((m) => m.type.name === 'font_size');
        result = fs ? Number(fs.attrs['halfPoints']) : null;
        done = true;
        return false;
      }
      cur += node.text.length;
      return false;
    });
    return result;
  }

  it('clears the gap font_size when neither bookend has explicit font_size', () => {
    // Bookends have only a named-style mark (no font_size). Gap is
    // explicitly 8pt (shrunken). After: the gap's font_size is
    // cleared so it falls back to the parent's natural size,
    // matching the bookends visually.
    const u = (t: string) =>
      schema.text(t, [schema.marks['underline_mark']!.create()]);
    const doc = makeDoc(p(
      u('foo'),
      withFs(' ', 16),
      u('bar'),
    ));
    const state = EditorState.create({ doc, schema });
    let next: EditorState | null = null;
    fixFormattingGaps(effectivePt)(state, (tr) => { next = state.apply(tr); });
    expect(next).not.toBeNull();
    // Char index 3 = the space.
    expect(fontSizeAtChar(next!.doc, 3)).toBeNull();
  });

  it('clears the gap font_size when only one bookend has explicit font_size', () => {
    // Bookends differ: first has font_size:22 (11pt), last has none.
    // Same-mark named-style bridge happens (both underline). The gap
    // had its own font_size; that should be cleared.
    const u = schema.marks['underline_mark']!.create();
    const doc = makeDoc(p(
      schema.text('foo', [u, schema.marks['font_size']!.create({ halfPoints: 22 })]),
      withFs(' ', 16, []),
      schema.text('bar', [u]),
    ));
    const state = EditorState.create({ doc, schema });
    let next: EditorState | null = null;
    fixFormattingGaps(effectivePt)(state, (tr) => { next = state.apply(tr); });
    // Gap font_size cleared (was 16, now null).
    expect(fontSizeAtChar(next!.doc, 3)).toBeNull();
    // First bookend keeps its 22.
    expect(fontSizeAtChar(next!.doc, 0)).toBe(22);
    // Last bookend stays clear.
    expect(fontSizeAtChar(next!.doc, 4)).toBeNull();
  });

  it('sets the gap font_size to MIN of bookend sizes when both have explicit', () => {
    // First bookend 22 (11pt), last bookend 16 (8pt). Gap was 26
    // (13pt). After: gap should be 16 (min). Bookends keep their
    // own values.
    const u = schema.marks['underline_mark']!.create();
    const doc = makeDoc(p(
      schema.text('foo', [u, schema.marks['font_size']!.create({ halfPoints: 22 })]),
      withFs(' ', 26, []),
      schema.text('bar', [u, schema.marks['font_size']!.create({ halfPoints: 16 })]),
    ));
    const state = EditorState.create({ doc, schema });
    let next: EditorState | null = null;
    fixFormattingGaps(effectivePt)(state, (tr) => { next = state.apply(tr); });
    expect(fontSizeAtChar(next!.doc, 0)).toBe(22);
    expect(fontSizeAtChar(next!.doc, 3)).toBe(16);
    expect(fontSizeAtChar(next!.doc, 4)).toBe(16);
  });

  it('does not touch bookends even on same-style bridge (range is gap-only)', () => {
    // Sanity check that the bridge range is gap-only — addMark over
    // the bookends would be idempotent for same-attr marks, but for
    // highlight with mismatched colors it would repaint the last
    // bookend with the first's color.
    const u = schema.marks['underline_mark']!.create();
    const doc = makeDoc(p(
      schema.text('foo', [u, schema.marks['highlight']!.create({ color: 'yellow' })]),
      schema.text(' '),
      schema.text('bar', [u, schema.marks['highlight']!.create({ color: 'green' })]),
    ));
    const state = EditorState.create({ doc, schema });
    let next: EditorState | null = null;
    fixFormattingGaps(effectivePt)(state, (tr) => { next = state.apply(tr); });
    // 'foo' stays yellow, 'bar' stays green, gap gets yellow (first
    // bookend wins).
    let fooColor: string | null = null;
    let gapColor: string | null = null;
    let barColor: string | null = null;
    let charIdx = 0;
    next!.doc.descendants((node) => {
      if (!node.isText || !node.text) return true;
      for (const ch of node.text) {
        const hl = node.marks.find((m) => m.type.name === 'highlight');
        const color = hl ? String(hl.attrs['color']) : null;
        if (charIdx < 3) fooColor = color;
        else if (charIdx === 3) gapColor = color;
        else if (charIdx < 7) barColor = color;
        charIdx++;
      }
      return false;
    });
    expect(fooColor).toBe('yellow');
    expect(gapColor).toBe('yellow');
    expect(barColor).toBe('green');
  });

  it('bridges both gaps in `<emp>foo</emp> <u>a</u> <emp>bar</emp> (single-char interior word)`', () => {
    // The gap regex matches the right bookend with a lookahead, so
    // only the first bookend + gap are consumed and the single-char
    // "a" can start the next match. A regex that consumed both
    // bookends would eat "foo a" and never see the second gap
    // (between "a" and "bar"). Both gaps must bridge.
    const u = schema.marks['underline_mark']!.create();
    const e = schema.marks['emphasis_mark']!.create();
    const doc = makeDoc(p(
      schema.text('foo', [e]),
      schema.text(' '),
      schema.text('a', [u]),
      schema.text(' '),
      schema.text('bar', [e]),
    ));
    const state = EditorState.create({ doc, schema });
    let next: EditorState | null = null;
    fixFormattingGaps(effectivePt)(state, (tr) => { next = state.apply(tr); });
    expect(next).not.toBeNull();
    const chars = marksByChar(next!.doc);
    // Positions: foo(0..2), gap1(3), a(4), gap2(5), bar(6..8).
    // Both gaps should carry underline_mark (mixed bookends bridge
    // to underline; same-mark bookends are still bridged).
    expect(chars[3]!.marks.has('underline_mark')).toBe(true);
    expect(chars[5]!.marks.has('underline_mark')).toBe(true);
  });

  it('bridges across gaps where a bookend is a curly quote', () => {
    // Verbatim docs frequently quote-wrap argument text. The opening
    // curly quote is usually the start of the next styled run, so
    // the regex needs to accept it as a valid bookend.
    const u = schema.marks['underline_mark']!.create();
    const doc = makeDoc(p(
      schema.text('foo', [u]),
      schema.text(' '),
      schema.text('“bar”', [u]),
    ));
    const state = EditorState.create({ doc, schema });
    let next: EditorState | null = null;
    fixFormattingGaps(effectivePt)(state, (tr) => { next = state.apply(tr); });
    expect(next).not.toBeNull();
    // The space (char index 3) should have gained underline_mark.
    const chars = marksByChar(next!.doc);
    expect(chars[3]!.marks.has('underline_mark')).toBe(true);
  });

  it('does NOT clear font_size on gaps that do not qualify', () => {
    // First bookend has underline; second is shrunken plain text
    // (font_size only, no named style). The bookends share no mark,
    // so nothing bridges, and the gap's font_size:16 already matches
    // the target (the smaller-effective-pt bookend's explicit size)
    // — the command is a no-op.
    const doc = makeDoc(p(
      schema.text('foo', [schema.marks['underline_mark']!.create()]),
      schema.text(' ', [schema.marks['font_size']!.create({ halfPoints: 16 })]),
      schema.text('bar', [schema.marks['font_size']!.create({ halfPoints: 16 })]),
    ));
    const state = EditorState.create({ doc, schema });
    expect(fixFormattingGaps(effectivePt)(state, undefined)).toBe(false);
  });
});

describe('insertTable — context-aware depth', () => {
  function applyInsertTable(state: EditorState): EditorState | null {
    let next: EditorState | null = null;
    const ok = getRibbonCommand('insertTable')(state, (tr) => { next = state.apply(tr); });
    return ok ? next : null;
  }

  it('inserts at doc level when cursor is in a doc-level paragraph', () => {
    const doc = makeDoc([paragraph('hello'), paragraph('world')]);
    const state = cursorIn(doc, (n) => n.isText && n.text === 'hello');
    const next = applyInsertTable(state);
    expect(next).not.toBeNull();
    // First child of the doc should now be the table.
    expect(next!.doc.firstChild!.type.name).toBe('table');
  });

  it('inserts inside a card when the cursor is in a card_body', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [tag('T'), cardBody('text')]),
    ]);
    const state = cursorIn(doc, (n) => n.isText && n.text === 'text');
    const next = applyInsertTable(state);
    expect(next).not.toBeNull();
    // The card should now have [tag, table, card_body] — table lives
    // inside the card, just before the card_body that holds the cursor.
    const card = next!.doc.firstChild!;
    expect(card.type.name).toBe('card');
    expect(card.childCount).toBe(3);
    expect(card.child(0).type.name).toBe('tag');
    expect(card.child(1).type.name).toBe('table');
    expect(card.child(2).type.name).toBe('card_body');
  });

  it('inserts inside an analytic_unit when the cursor is in its body', () => {
    const doc = makeDoc([
      analyticUnit(analytic('A'), cardBody('body')),
    ]);
    const state = cursorIn(doc, (n) => n.isText && n.text === 'body');
    const next = applyInsertTable(state);
    expect(next).not.toBeNull();
    const au = next!.doc.firstChild!;
    expect(au.type.name).toBe('analytic_unit');
    expect(au.child(1).type.name).toBe('table');
  });

  it('falls back to doc level when cursor is in a tag (card rejects table at idx 0)', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [tag('T'), cardBody('body')]),
    ]);
    const state = cursorIn(doc, (n) => n.isText && n.text === 'T');
    const next = applyInsertTable(state);
    expect(next).not.toBeNull();
    // The table is placed before the card, not inside it — because
    // the card's schema requires `tag` to be its first child, so a
    // table at index 0 is illegal. The walk decrements to doc level.
    expect(next!.doc.firstChild!.type.name).toBe('table');
    expect(next!.doc.child(1).type.name).toBe('card');
  });
});

// ── Command-palette aliases ──────────────────────────────────────────
// The palette lowercases the query before matching, so every alias must
// itself be lowercase or it can never match. These guard the alias data
// (command + settings) against the one silent-failure mode: casing /
// stray whitespace. Command-id validity is already enforced by the
// `Record<RibbonCommandId, …>` type.
describe('command palette aliases', () => {
  it('every command alias is lowercase, trimmed, and non-empty', () => {
    for (const [id, aliases] of Object.entries(RIBBON_COMMAND_ALIASES)) {
      for (const a of aliases ?? []) {
        expect(a, `${id} alias "${a}"`).toBe(a.toLowerCase());
        expect(a, `${id} alias "${a}"`).toBe(a.trim());
        expect(a.length, `${id} alias`).toBeGreaterThan(0);
      }
    }
  });

  it('no command alias merely repeats its own label', () => {
    // An alias identical to the (lowercased) label is dead weight —
    // the label already matches. Catches copy-paste mistakes.
    for (const [id, aliases] of Object.entries(RIBBON_COMMAND_ALIASES)) {
      const label = RIBBON_COMMAND_LABELS[id as keyof typeof RIBBON_COMMAND_LABELS].toLowerCase();
      for (const a of aliases ?? []) {
        expect(a, `${id} alias duplicates label`).not.toBe(label);
      }
    }
  });

  it('every setting alias is lowercase, trimmed, and non-empty', () => {
    for (const m of SETTING_METADATA) {
      for (const a of m.aliases ?? []) {
        expect(a, `${m.key} alias "${a}"`).toBe(a.toLowerCase());
        expect(a, `${m.key} alias "${a}"`).toBe(a.trim());
        expect(a.length, `${m.key} alias`).toBeGreaterThan(0);
      }
    }
  });

  it('the theme setting answers to light/dark mode and toggle theme', () => {
    const theme = SETTING_METADATA.find((m) => m.key === 'theme');
    expect(theme).toBeDefined();
    expect(theme!.aliases).toEqual(
      expect.arrayContaining(['light mode', 'dark mode', 'toggle theme']),
    );
  });

  it('show/hide visibility commands also answer to "toggle"', () => {
    // The reverse direction (toggle-labeled → "show"/"hide") is covered
    // by the lowercase guard; here we assert the show/hide ⇄ toggle
    // bridge exists on the two visibility commands.
    expect(RIBBON_COMMAND_ALIASES.toggleCommentsVisible).toContain('toggle comments');
    expect(RIBBON_COMMAND_ALIASES.toggleNavPane).toEqual(
      expect.arrayContaining(['toggle navigation pane', 'toggle nav pane']),
    );
  });
});

// ── cycleTheme command ───────────────────────────────────────────────
// Bindable command that cycles the theme setting. The actual
// light → dark → system rotation lives in the editor's RibbonContext
// wiring (index.ts); here we lock down the command plumbing: it's
// registered, labeled, searchable, and dispatches to the ctx hook.
describe('cycleTheme command', () => {
  it('is registered with a label', () => {
    expect(RIBBON_COMMAND_IDS).toContain('cycleTheme');
    expect(RIBBON_COMMAND_LABELS.cycleTheme).toBeTruthy();
  });

  it('is searchable by "dark mode" / "toggle theme"', () => {
    expect(RIBBON_COMMAND_ALIASES.cycleTheme).toEqual(
      expect.arrayContaining(['dark mode', 'light mode', 'toggle theme']),
    );
  });

  it('dispatches to ctx.cycleTheme only when a dispatch fn is present', () => {
    let calls = 0;
    const ctx = { cycleTheme: () => { calls++; } } as unknown as RibbonContext;
    const cmd = getRibbonCommand('cycleTheme', ctx);
    // Dry run (no dispatch) reports availability without side effects.
    expect(cmd(null as never, undefined)).toBe(true);
    expect(calls).toBe(0);
    // Real run fires the hook.
    expect(cmd(null as never, () => {})).toBe(true);
    expect(calls).toBe(1);
  });
});

// ── setNavDepth1–4 commands ─────────────────────────────────────────
// Keyboard route to the nav pane's 1 · 2 · 3 · 4 buttons. The panel
// call is wired through RibbonContext in index.ts; here we lock down the
// registry entries and the level each command passes.
describe('setNavDepth commands', () => {
  const ids = ['setNavDepth1', 'setNavDepth2', 'setNavDepth3', 'setNavDepth4'] as const;

  it('are registered with no default binding', () => {
    for (const id of ids) {
      expect(RIBBON_COMMAND_IDS).toContain(id);
      expect(DEFAULT_RIBBON_KEYS[id]).toBe('');
    }
  });

  it('pass their own level to ctx.setNavDepth, only on dispatch', () => {
    const seen: number[] = [];
    const ctx = { setNavDepth: (l: number) => { seen.push(l); } } as unknown as RibbonContext;
    for (const id of ids) {
      const cmd = getRibbonCommand(id, ctx);
      expect(cmd(null as never, undefined)).toBe(true);
      expect(cmd(null as never, () => {})).toBe(true);
    }
    expect(seen).toEqual([1, 2, 3, 4]);
  });
});

// ── minimizeWindow command ───────────────────────────────────────────
// Restores the stock macOS Cmd+M as a first-class, rebindable command
// (field request 2026-07-24). The OS minimize itself is a host IPC wired
// through RibbonContext in index.ts; here we lock down the registry
// plumbing: registered, labeled, searchable, DEFAULT Mod-m, ctx dispatch.
describe('minimizeWindow command', () => {
  it('is registered with a label and defaults to Mod-m (the stock Cmd+M)', () => {
    expect(RIBBON_COMMAND_IDS).toContain('minimizeWindow');
    expect(RIBBON_COMMAND_LABELS.minimizeWindow).toBe('Minimize Window');
    expect(DEFAULT_RIBBON_KEYS.minimizeWindow).toBe('Mod-m');
  });

  it('is searchable by "minimize"', () => {
    expect(RIBBON_COMMAND_ALIASES.minimizeWindow).toEqual(
      expect.arrayContaining(['minimize']),
    );
  });

  it('binds Mod-m in the default keymap', () => {
    let calls = 0;
    const ctx = { minimizeWindow: () => { calls++; } } as unknown as RibbonContext;
    const km = buildRibbonKeymap({}, ctx);
    expect(km['Mod-m']).toBeDefined();
    expect(km['Mod-m']!(null as never, () => {})).toBe(true);
    expect(calls).toBe(1);
  });

  it('dispatches to ctx.minimizeWindow only when a dispatch fn is present', () => {
    let calls = 0;
    const ctx = { minimizeWindow: () => { calls++; } } as unknown as RibbonContext;
    const cmd = getRibbonCommand('minimizeWindow', ctx);
    expect(cmd(null as never, undefined)).toBe(true);
    expect(calls).toBe(0);
    expect(cmd(null as never, () => {})).toBe(true);
    expect(calls).toBe(1);
  });
});

// ── deleteCurrentHeading command ─────────────────────────────────────
// The structure-deletion logic itself is covered by
// delete-current-heading.test.ts. Here we lock down the registry
// plumbing (mirrors selectCurrentHeading) and the ctx dispatch.
describe('deleteCurrentHeading command', () => {
  it('is registered with a label and is unbound by default', () => {
    expect(RIBBON_COMMAND_IDS).toContain('deleteCurrentHeading');
    expect(RIBBON_COMMAND_LABELS.deleteCurrentHeading).toBe('Delete Current Heading');
    expect(DEFAULT_RIBBON_KEYS.deleteCurrentHeading).toBe('');
  });

  it('is searchable by "delete card" / "delete heading"', () => {
    expect(RIBBON_COMMAND_ALIASES.deleteCurrentHeading).toEqual(
      expect.arrayContaining(['delete card', 'delete heading']),
    );
  });

  it('dispatches to ctx.deleteCurrentHeading only when a dispatch fn is present', () => {
    let calls = 0;
    const ctx = { deleteCurrentHeading: () => { calls++; } } as unknown as RibbonContext;
    const cmd = getRibbonCommand('deleteCurrentHeading', ctx);
    expect(cmd(null as never, undefined)).toBe(true);
    expect(calls).toBe(0);
    expect(cmd(null as never, () => {})).toBe(true);
    expect(calls).toBe(1);
  });
});

describe('tag ↔ analytic swaps preserve the numbering skeleton', () => {
  it('card → analytic_unit keeps numRole and numRestart', () => {
    const card = schema.nodes['card']!.createChecked(
      { numRole: 'number', numRestart: true },
      [
        schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('T')),
        schema.nodes['card_body']!.create(null, schema.text('body')),
      ],
    );
    const doc = makeDoc([card]);
    const state = setCursorIn(doc, (n) => n.type.name === 'tag');
    const next = apply(state, setAnalytic());
    const unit = next!.doc.child(0);
    expect(unit.type.name).toBe('analytic_unit');
    expect(unit.attrs['numRole']).toBe('number');
    expect(unit.attrs['numRestart']).toBe(true);
  });

  it('analytic_unit → card keeps numRole and numRestart', () => {
    const unit = schema.nodes['analytic_unit']!.createChecked(
      { numRole: 'sub', numRestart: true },
      [
        schema.nodes['analytic']!.create({ id: newHeadingId() }, schema.text('A')),
        schema.nodes['card_body']!.create(null, schema.text('body')),
      ],
    );
    const doc = makeDoc([unit]);
    const state = setCursorIn(doc, (n) => n.type.name === 'analytic');
    const next = apply(state, setTag());
    const card = next!.doc.child(0);
    expect(card.type.name).toBe('card');
    expect(card.attrs['numRole']).toBe('sub');
    expect(card.attrs['numRestart']).toBe(true);
  });
});
