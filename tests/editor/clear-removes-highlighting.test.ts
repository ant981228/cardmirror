/**
 * F12 (Clear) and the `clearRemovesHighlighting` setting. Off (the
 * default) keeps highlighting, as Verbatim does; on strips it in every
 * coverage regime — cursor, full-paragraph selection, partial selection,
 * and the tag-dissolve path. Shading survives either way.
 */

import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { clearToNormal } from '../../src/editor/ribbon-commands.js';

const hl = () => schema.marks['highlight']!.create({ color: 'yellow' });
const shade = () => schema.marks['shading']!.create({ color: 'D2D2D2' });
const bold = () => schema.marks['bold']!.create();

function bodyDoc(): PMNode {
  const tag = schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('Tag', [hl()]));
  const body = schema.nodes['card_body']!.create(null, [
    schema.text('read this', [hl(), bold()]),
    schema.text(' and ', []),
    schema.text('shaded', [shade()]),
  ]);
  return schema.nodes['doc']!.createChecked(null, [
    schema.nodes['card']!.createChecked(null, [tag, body]),
  ]);
}

function textStart(doc: PMNode, text: string): number {
  let found = -1;
  doc.descendants((n, p) => {
    if (found === -1 && n.isText && n.text === text) found = p;
    return found === -1;
  });
  if (found < 0) throw new Error(`"${text}" not found`);
  return found;
}

function runClear(doc: PMNode, anchor: number, head: number, removeHighlight: boolean): PMNode {
  const base = EditorState.create({ doc });
  const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, anchor, head)));
  let next: EditorState | null = null;
  const ok = clearToNormal(() => removeHighlight)(state, (tr) => { next = state.apply(tr); });
  expect(ok).toBe(true);
  return next!.doc;
}

function has(doc: PMNode, markName: string): boolean {
  let found = false;
  doc.descendants((n) => {
    if (n.isText && n.marks.some((m) => m.type.name === markName)) found = true;
    return !found;
  });
  return found;
}

describe('F12 with clearRemovesHighlighting', () => {
  it('off (default): cursor clear keeps highlighting, still strips bold', () => {
    const doc = bodyDoc();
    const at = textStart(doc, 'read this') + 2;
    const out = runClear(doc, at, at, false);
    expect(has(out, 'bold')).toBe(false);
    expect(has(out, 'highlight')).toBe(true);
  });

  it('on: cursor clear strips highlighting, keeps shading', () => {
    const doc = bodyDoc();
    const at = textStart(doc, 'read this') + 2;
    const out = runClear(doc, at, at, true);
    // The tag's highlight is in a different paragraph and stays.
    expect(out.firstChild!.firstChild!.firstChild!.marks.some((m) => m.type.name === 'highlight')).toBe(true);
    expect(out.firstChild!.child(1).textContent).toBe('read this and shaded');
    let bodyHasHl = false;
    out.firstChild!.child(1).descendants((n) => {
      if (n.marks.some((m) => m.type.name === 'highlight')) bodyHasHl = true;
    });
    expect(bodyHasHl).toBe(false);
    expect(has(out, 'shading')).toBe(true);
  });

  it('on: a partial selection strips highlighting only inside the range', () => {
    const doc = bodyDoc();
    const from = textStart(doc, 'read this');
    const out = runClear(doc, from, from + 4, true); // "read"
    const body = out.firstChild!.child(1);
    expect(body.firstChild!.text).toBe('read');
    expect(body.firstChild!.marks.some((m) => m.type.name === 'highlight')).toBe(false);
    expect(body.child(1).text).toBe(' this');
    expect(body.child(1).marks.some((m) => m.type.name === 'highlight')).toBe(true);
  });

  it('on: clearing a tag (dissolve path) strips its highlighting', () => {
    const doc = bodyDoc();
    const at = textStart(doc, 'Tag') + 1;
    const out = runClear(doc, at, at, true);
    const para = out.firstChild!;
    expect(para.type.name).toBe('paragraph');
    expect(para.textContent).toBe('Tag');
    expect(para.firstChild!.marks.some((m) => m.type.name === 'highlight')).toBe(false);
  });

  it('off: clearing a tag keeps its highlighting', () => {
    const doc = bodyDoc();
    const at = textStart(doc, 'Tag') + 1;
    const out = runClear(doc, at, at, false);
    expect(out.firstChild!.firstChild!.marks.some((m) => m.type.name === 'highlight')).toBe(true);
  });
});
