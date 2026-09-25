/**
 * Emphasis + Background Color (2026-09-24): one command, one undo, that
 * leaves the text with both marks. F10 alone strips background, so the
 * background must be painted after the emphasis apply — the ordering
 * bug this command exists to avoid.
 */
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { history, undo } from 'prosemirror-history';
import { schema } from '../../src/schema/index.js';
import {
  applyEmphasis,
  applyEmphasisAndShading,
  applyShading,
  RIBBON_COMMAND_IDS,
  RIBBON_COMMAND_LABELS,
  DEFAULT_RIBBON_KEYS,
} from '../../src/editor/ribbon-commands.js';

const SHD = (color = 'D2D2D2') => schema.marks['shading']!.create({ color });

function stateOf(runs: [string, Mark[]?][], from: number, to: number): EditorState {
  const para = schema.nodes['paragraph']!.create(null, runs.map(([t, m]) => schema.text(t, m ?? [])));
  const doc = schema.nodes['doc']!.createChecked(null, [para]);
  const state = EditorState.create({ doc, plugins: [history()] });
  return state.apply(state.tr.setSelection(TextSelection.create(doc, from, to)));
}

function apply(state: EditorState, cmd: Command): EditorState {
  let next = state;
  cmd(state, (tr) => { next = state.apply(tr); });
  return next;
}

/** Marks on the text at doc position `pos`. */
function marksAt(doc: PMNode, pos: number): string[] {
  return (doc.resolve(pos).nodeAfter?.marks ?? []).map((m) =>
    m.type.name === 'shading' ? `shading:${m.attrs['color'] as string}` : m.type.name,
  );
}

describe('applyEmphasisAndShading', () => {
  it('applies emphasis and the active background color to the selection', () => {
    // "alpha beta" — select "alpha" (positions 1..6).
    const s = apply(stateOf([['alpha beta']], 1, 6), applyEmphasisAndShading(() => 'FFFF00'));
    expect(marksAt(s.doc, 1)).toEqual(expect.arrayContaining(['emphasis_mark', 'shading:FFFF00']));
    expect(marksAt(s.doc, 7)).toEqual([]);
  });

  it('keeps both, where Mod-F11 then F10 loses the background', () => {
    const start = stateOf([['alpha beta']], 1, 6);
    const twoStep = apply(apply(start, applyShading(() => 'FFFF00')), applyEmphasis());
    expect(marksAt(twoStep.doc, 1)).not.toContain('shading:FFFF00');
    const oneStep = apply(start, applyEmphasisAndShading(() => 'FFFF00'));
    expect(marksAt(oneStep.doc, 1)).toContain('shading:FFFF00');
  });

  it('repaints an existing background in the active color instead of toggling it off', () => {
    const s = apply(stateOf([['alpha', [SHD('FFFF00')]], [' beta']], 1, 6), applyEmphasisAndShading(() => 'FFFF00'));
    expect(marksAt(s.doc, 1)).toEqual(expect.arrayContaining(['emphasis_mark', 'shading:FFFF00']));
  });

  it('with the "No background" pen, emphasizes and leaves no background', () => {
    const s = apply(stateOf([['alpha', [SHD()]], [' beta']], 1, 6), applyEmphasisAndShading(() => null));
    expect(marksAt(s.doc, 1)).toEqual(['emphasis_mark']);
  });

  it('with a bare cursor, acts on the word at the cursor, like F10', () => {
    const s = apply(stateOf([['alpha beta']], 3, 3), applyEmphasisAndShading(() => 'FFFF00'));
    expect(marksAt(s.doc, 1)).toEqual(expect.arrayContaining(['emphasis_mark', 'shading:FFFF00']));
    expect(marksAt(s.doc, 7)).toEqual([]);
  });

  it('is one undo step', () => {
    const start = stateOf([['alpha beta']], 1, 6);
    const s = apply(start, applyEmphasisAndShading(() => 'FFFF00'));
    const undone = apply(s, undo);
    expect(undone.doc.eq(start.doc)).toBe(true);
  });

  it('is registered as an unbound ribbon command', () => {
    expect(RIBBON_COMMAND_IDS).toContain('applyEmphasisAndShading');
    expect(RIBBON_COMMAND_LABELS.applyEmphasisAndShading).toBe('Emphasis + Background Color');
    expect(DEFAULT_RIBBON_KEYS.applyEmphasisAndShading).toBe('');
  });
});
