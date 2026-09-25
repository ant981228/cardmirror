// @vitest-environment jsdom
/**
 * One popup anatomy for the dropzone, Send and Receive pills
 * (2026-09-25): every expansion is a `.pmd-pill-popup` rising from the
 * pill row, left-anchored on the tray; the open pill's bar keeps its own
 * accent outline. The CSS contract is pinned by regex (like
 * cloud-pill-runway) and the DOM by mounting the three controllers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DropzoneController } from '../../src/editor/dropzone-ui.js';
import { dropzoneStore } from '../../src/editor/dropzone-store.js';
import { SendPillController } from '../../src/editor/pairing/send-pill-ui.js';
import { ReceivePillController } from '../../src/editor/pairing/receive-pill-ui.js';
import { settings } from '../../src/editor/settings.js';

const css = readFileSync(resolve(process.cwd(), 'src/editor/style.css'), 'utf8');

function rect(left: number, right: number, top = 0, bottom = 30): DOMRect {
  return { left, right, top, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

beforeEach(() => {
  settings.set('pairingEnabled', true);
});
afterEach(() => {
  document.body.innerHTML = '';
  settings.set('pairingEnabled', false);
  vi.restoreAllMocks();
});

describe('pill popup CSS contract', () => {
  it('pills are static inside the tray, so popups anchor on the tray', () => {
    expect(css).toMatch(/\.pmd-pill-tray > \.pmd-pill,\n\.pmd-pill-tray > \.pmd-dropzone-root \{\n\s*position: static;/u);
  });
  it('a popup rises from the top of the row at the tray\'s left edge and spans the row', () => {
    const rule = css.match(/\n\.pmd-pill-popup \{\n([^}]*)\}/u)?.[1] ?? '';
    expect(rule).toMatch(/position: absolute;/u);
    expect(rule).toMatch(/left: 0;/u);
    expect(rule).toMatch(/bottom: calc\(100% \+ var\(--pmd-pill-popup-gap, 8px\)\);/u);
    expect(rule).toMatch(/min-width: 100%;/u);
    expect(rule).toMatch(/--pmd-pill-popup-max/u);
  });
  it('the open bar keeps its own accent outline, the popup floats a gap above the row, and all three bars share the hover border', () => {
    expect(css).toMatch(/\[data-open="true"\] > \.pmd-dropzone-bar,\n\[data-open="true"\] > \.pmd-pill-bar \{[^}]*border-color: var\(--pmd-c-accent\);/u);
    expect(css).not.toMatch(/\[data-open="true"\] > \.pmd-pill-bar::after/u);
    const popup = css.match(/\n\.pmd-pill-popup \{\n([^}]*)\}/u)?.[1] ?? '';
    expect(popup).toMatch(/bottom: calc\(100% \+ var\(--pmd-pill-popup-gap/u);
    expect(popup).toMatch(/border: 1px solid var\(--pmd-c-border\);/u);
    expect(css).toMatch(/\.pmd-dropzone-bar:hover,\n\.pmd-send-bar:hover,\n\.pmd-receive-bar:hover \{\n\s*border-color: var\(--pmd-c-accent\);/u);
  });
  it('the browser focus ring is suppressed app-wide (the app draws its own where it matters)', () => {
    expect(css).toMatch(/\n:focus,\n:focus-visible \{\n\s*outline: none;\n\}/u);
  });
});

describe('the three pills share the popup anatomy', () => {
  it('dropzone: a .pmd-pill whose list is the popup, with Clear in the popup footer only when there are items', () => {
    vi.spyOn(dropzoneStore, 'init').mockResolvedValue();
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    new DropzoneController().mount({ parent, getFocusedView: () => null });
    const root = parent.querySelector('.pmd-dropzone-root') as HTMLElement;
    expect(root.classList.contains('pmd-pill')).toBe(true);
    const list = root.querySelector('.pmd-dropzone-list') as HTMLElement;
    expect(list.classList.contains('pmd-pill-popup')).toBe(true);
    // The bar holds no Clear button any more.
    expect(root.querySelector('.pmd-dropzone-bar .pmd-dropzone-clear')).toBeNull();
    const store = dropzoneStore as unknown as { items: unknown[]; fire: () => void };
    store.items = [];
    store.fire();
    expect(list.querySelector('.pmd-dropzone-actions')).toBeNull();
    store.items = [{ id: 'i1', label: 'Alpha', type: 'card', sliceJson: { content: [] }, createdAt: 1 }];
    store.fire();
    expect(list.querySelector('.pmd-dropzone-actions .pmd-dropzone-clear')).not.toBeNull();
    (root.querySelector('.pmd-dropzone-bar') as HTMLElement).click();
    expect(root.dataset['open']).toBe('true');
    store.items = [];
    store.fire();
  });

  it('send and receive: their panels carry the popup class', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    new SendPillController().mount({ parent });
    new ReceivePillController().mount({ parent, getFocusedView: () => null });
    expect(parent.querySelector('.pmd-send-panel')!.classList.contains('pmd-pill-popup')).toBe(true);
    expect(parent.querySelector('.pmd-receive-list')!.classList.contains('pmd-pill-popup')).toBe(true);
  });

  it('the three bars use one icon set: a storage box, an out-tray and an in-tray', () => {
    vi.spyOn(dropzoneStore, 'init').mockResolvedValue();
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    new DropzoneController().mount({ parent, getFocusedView: () => null });
    new SendPillController().mount({ parent });
    new ReceivePillController().mount({ parent, getFocusedView: () => null });
    expect(parent.querySelector('.pmd-dropzone-bar .pmd-icon-archive')).not.toBeNull();
    expect(parent.querySelector('.pmd-send-bar .pmd-icon-upload')).not.toBeNull();
    expect(parent.querySelector('.pmd-receive-bar .pmd-icon-download')).not.toBeNull();
    expect(parent.querySelector('.pmd-pill-bar svg, .pmd-dropzone-bar svg')).toBeNull();
  });

  it('dropzone drop surface: the open list counts even though it lies outside the root\'s box', () => {
    vi.spyOn(dropzoneStore, 'init').mockResolvedValue();
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const dz = new DropzoneController();
    dz.mount({ parent, getFocusedView: () => null });
    const root = parent.querySelector('.pmd-dropzone-root') as HTMLElement;
    const list = root.querySelector('.pmd-dropzone-list') as HTMLElement;
    root.getBoundingClientRect = () => rect(10, 60, 500, 530);
    list.getBoundingClientRect = () => rect(10, 400, 200, 500);
    const surface = (dz as unknown as { surface: { hitTest: (x: number, y: number) => unknown } }).surface;
    expect(surface.hitTest(200, 300)).toBeNull(); // closed: only the bar counts
    (root.querySelector('.pmd-dropzone-bar') as HTMLElement).click();
    expect(surface.hitTest(200, 300)).not.toBeNull(); // open: the popup counts
    expect(surface.hitTest(30, 515)).not.toBeNull(); // the bar still counts
  });
});
