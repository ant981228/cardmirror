// @vitest-environment jsdom
/**
 * The status-bar CardMirror mark (2026-09-25): a drag handle for the
 * focused document's file. Hidden without a desktop host that can start
 * a native drag, dimmed and inert without a file on disk, and otherwise
 * dragstart → host.dragFileOut(path, mark icon), click → reveal.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DRAG_TITLE,
  FILE_MARK_DATA_URL,
  INERT_TITLE,
  fileDragMarkState,
  installFileDragMark,
  type FileDragHost,
} from '../../src/editor/file-drag-mark.js';

function fakeHost(can = true): FileDragHost & { drags: [string, string][]; reveals: string[] } {
  const h = {
    drags: [] as [string, string][],
    reveals: [] as string[],
    canDragFileOut: () => can,
    dragFileOut(path: string, icon: string) { h.drags.push([path, icon]); },
    showItemInFolder: vi.fn(async (p: string) => { h.reveals.push(p); }),
  };
  return h;
}

describe('fileDragMarkState', () => {
  it('hides without a host, or on a shell that cannot start a native drag', () => {
    expect(fileDragMarkState(null, '/a/b.cmir').hidden).toBe(true);
    expect(fileDragMarkState(fakeHost(false), '/a/b.cmir').hidden).toBe(true);
  });
  it('is live with a file on disk and dimmed without one', () => {
    expect(fileDragMarkState(fakeHost(), '/a/b.cmir')).toEqual({ hidden: false, inert: false, title: DRAG_TITLE });
    expect(fileDragMarkState(fakeHost(), null)).toEqual({ hidden: false, inert: true, title: INERT_TITLE });
    expect(fileDragMarkState(fakeHost(), '').inert).toBe(true);
    expect(fileDragMarkState(fakeHost(), { web: 'handle' }).inert).toBe(true);
  });
});

describe('installFileDragMark', () => {
  it('starts the native drag with the mark as icon, reveals on click, and goes inert with no file', () => {
    const host = fakeHost();
    const el = document.createElement('button');
    document.body.appendChild(el);
    const sync = installFileDragMark(el, () => host);
    expect(el.draggable).toBe(true);
    expect(el.style.backgroundImage).toContain('data:image/png;base64,');
    sync('/docs/Aff.cmir');
    expect(el.hidden).toBe(false);
    expect(el.dataset['inert']).toBeUndefined();
    const ev = new Event('dragstart', { bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(host.drags).toEqual([['/docs/Aff.cmir', FILE_MARK_DATA_URL]]);
    el.click();
    expect(host.reveals).toEqual(['/docs/Aff.cmir']);
    sync(null);
    expect(el.dataset['inert']).toBe('true');
    expect(el.title).toBe(INERT_TITLE);
    el.dispatchEvent(new Event('dragstart', { bubbles: true, cancelable: true }));
    el.click();
    expect(host.drags).toHaveLength(1);
    expect(host.reveals).toHaveLength(1);
  });
  it('stays hidden on the web', () => {
    const el = document.createElement('button');
    const sync = installFileDragMark(el, () => null);
    sync('/docs/Aff.cmir');
    expect(el.hidden).toBe(true);
  });
});
