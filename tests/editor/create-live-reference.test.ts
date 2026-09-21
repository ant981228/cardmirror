// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOMParser as PMDOMParser, Fragment } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { newHeadingId, schema } from '../../src/schema/index.js';
import {
  buildReferenceNodes,
  createLiveReference,
  type CreateReferenceOptions,
} from '../../src/editor/create-reference.js';
import { clearLinkedCopy, recallLinkedCopy } from '../../src/editor/clipboard-link-cache.js';
import {
  flattenSelfRefsInFragment,
  isSelfRef,
  resolveSelfRefProjection,
} from '../../src/editor/self-transclusion.js';

const writeClipboardHtml = vi.fn(async (_html: string, _text: string) => true);
vi.mock('../../src/editor/clipboard-write.js', () => ({
  writeClipboardHtml: (html: string, text: string) => writeClipboardHtml(html, text),
}));

const options: CreateReferenceOptions = {
  includeHeading: true,
  delimiter: '<<',
  includeCite: false,
  customHeading: '',
  headingBold: false,
  headingItalic: false,
  headingEmphasized: false,
  headingUnderlined: false,
  shrink: true,
  shrinkPt: 3,
  highlightMode: 'shading',
  useGray50: true,
};

afterEach(() => {
  clearLinkedCopy();
  document.body.replaceChildren();
});

describe('Create Reference live mode', () => {
  it('anchors the exact selection and restores a live self_ref on same-doc paste', async () => {
    const body = schema.nodes['card_body']!.create(null, [
      schema.text('before '),
      schema.text('selected', [schema.marks['highlight']!.create({ color: 'yellow' })]),
      schema.text(' after'),
    ]);
    const doc = schema.nodes['doc']!.create(null, [
      schema.nodes['card']!.createChecked(null, [
        schema.nodes['tag']!.create({ id: 'card-1' }, schema.text('Tag')),
        body,
      ]),
    ]);
    let bodyPos = 0;
    doc.descendants((node, pos) => {
      if (node === body) bodyPos = pos;
      return true;
    });
    const from = bodyPos + 1 + 'before '.length;
    const state = EditorState.create({ doc }).apply(
      EditorState.create({ doc }).tr.setSelection(
        TextSelection.create(doc, from, from + 'selected'.length),
      ),
    );
    const host = document.body.appendChild(document.createElement('div'));
    const view = new EditorView(host, { state });
    expect(buildReferenceNodes(state, () => 11, options)).not.toBeNull();

    expect(await createLiveReference(view, () => 11, options)).toBe('copied');
    const clipboard = document.createElement('div');
    clipboard.innerHTML = writeClipboardHtml.mock.calls[0]![0];
    const restored = recallLinkedCopy(view, PMDOMParser.fromSchema(schema).parseSlice(clipboard));
    expect(restored).not.toBeNull();
    const live = restored!.content.firstChild!;
    expect(isSelfRef(live)).toBe(true);
    expect(live.attrs['reference_heading']).toBe('<<FOR REFERENCE>>');
    expect(live.attrs['reference_gray']).toBe(true);
    expect(live.attrs['reference_shrink']).toBe(true);
    expect(live.attrs['reference_highlight_mode']).toBe('shading');
    const projected = resolveSelfRefProjection(view.state.doc, live).content.firstChild!;
    expect(projected.textContent).toBe('selected');
    const marks = projected.firstChild!.marks;
    expect(marks.find((mark) => mark.type.name === 'font_size')?.attrs['halfPoints']).toBe(16);
    expect(marks.find((mark) => mark.type.name === 'font_color')?.attrs['color']).toBe('808080');
    expect(marks.find((mark) => mark.type.name === 'highlight')).toBeUndefined();
    expect(marks.find((mark) => mark.type.name === 'shading')?.attrs['color']).toBe('C0C0C0');
    const flattened = flattenSelfRefsInFragment(Fragment.from(live), view.state.doc, newHeadingId);
    expect(flattened.firstChild!.textContent).toBe('<<FOR REFERENCE>>');
    expect(flattened.lastChild!.firstChild!.marks.some((mark) => mark.type.name === 'shading')).toBe(true);
    view.dispatch(
      view.state.tr
        .insertText('updated', from, from + 'selected'.length)
        .removeMark(from, from + 'updated'.length, schema.marks['highlight']!)
        .addMark(from, from + 'updated'.length, schema.marks['underline_mark']!.create()),
    );
    const updated = resolveSelfRefProjection(view.state.doc, live).content.firstChild!;
    expect(updated.textContent).toBe('updated');
    expect(updated.firstChild!.marks.some((mark) => mark.type.name === 'underline_mark')).toBe(true);
    expect(updated.firstChild!.marks.some((mark) => mark.type.name === 'shading')).toBe(false);
    view.destroy();
  });
});
