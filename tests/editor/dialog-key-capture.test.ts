// @vitest-environment jsdom
/**
 * Modal keys must never reach the editor (field bug 2026-07-27:
 * pressing Enter to confirm the mode-switch dialog ALSO inserted a
 * newline at the cursor). The dialogs listen at the document level in
 * CAPTURE phase and preventDefault — ProseMirror's eventBelongsToView
 * then skips its own keydown handler entirely — and swallow any other
 * key not aimed at the dialog's own controls. Focus also moves into
 * the dialog on open (second, independent line of defense) and back on
 * close.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap } from 'prosemirror-commands';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  confirmDialog,
  promptForRouteChoice,
  installModalKeys,
} from '../../src/editor/text-prompt.js';
import { pushOverlay, popOverlay, isAnyOverlayOpen } from '../../src/editor/overlay-stack.js';
import { openDocMenu } from '../../src/editor/doc-menu-ui.js';
import { openRecoverySidebar } from '../../src/editor/recovery-ui.js';
import { showConfirm } from '../../src/editor/confirm-dialog.js';
import { openWordCount } from '../../src/editor/word-count-ui.js';
import { openReference } from '../../src/editor/reference-ui.js';

function mkView(): EditorView {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const doc = schema.nodes['doc']!.createChecked(null, [
    schema.nodes['card']!.createChecked(null, [
      schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('Tag')),
      schema.nodes['card_body']!.create(null, schema.text('body text')),
    ]),
  ]);
  const state = EditorState.create({ doc, plugins: [keymap(baseKeymap)] });
  const view = new EditorView(el, { state });
  // Cursor inside the body, focus on the editor — the field setup.
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 8)));
  view.focus();
  return view;
}

/** Dispatch Enter the way a real keypress arrives: on the focused
 *  editor DOM, bubbling to document. */
function pressOnEditor(view: EditorView, key: string): void {
  view.dom.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  );
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('dialog keys never reach the editor', () => {
  it('Enter confirms confirmDialog without inserting a newline (the mode-switch bug)', async () => {
    const view = mkView();
    const before = view.state.doc.toJSON();
    const p = confirmDialog('Switch modes?', { okLabel: 'Switch' });
    pressOnEditor(view, 'Enter');
    await expect(p).resolves.toBe(true);
    expect(view.state.doc.toJSON()).toEqual(before); // no split-block
    view.destroy();
  });

  it('Escape cancels without reaching the editor', async () => {
    const view = mkView();
    const before = view.state.doc.toJSON();
    const p = confirmDialog('Sure?');
    pressOnEditor(view, 'Escape');
    await expect(p).resolves.toBe(false);
    expect(view.state.doc.toJSON()).toEqual(before);
    view.destroy();
  });

  it('unhandled keys are swallowed while a modal is up — no typing into the doc', async () => {
    const view = mkView();
    const before = view.state.doc.toJSON();
    const p = promptForRouteChoice<'a'>({
      message: 'Pick',
      choices: [{ value: 'a', label: 'A' }],
    });
    // Backspace is ProseMirror-handled; it must be swallowed, not
    // applied to the doc.
    pressOnEditor(view, 'Backspace');
    expect(view.state.doc.toJSON()).toEqual(before);
    pressOnEditor(view, 'Enter'); // Enter picks the first choice
    await expect(p).resolves.toBe('a');
    expect(view.state.doc.toJSON()).toEqual(before);
    view.destroy();
  });

  it('installModalKeys contract — used directly by the hand-rolled dialogs', () => {
    // confirmCloseUnsaved (Mod-W), confirmNewDocOverwrite (Mod-N) and
    // the pane picker build their own DOM but share this helper, so
    // lock its three behaviors here.
    const view = mkView();
    const before = view.state.doc.toJSON();
    const dialog = document.createElement('div');
    const inner = document.createElement('input');
    dialog.appendChild(inner);
    document.body.appendChild(dialog);
    const token = pushOverlay();
    const seen: string[] = [];
    const remove = installModalKeys(dialog, token, (e) => {
      if (e.key === '1') {
        seen.push('handled-1');
        return true;
      }
      return false;
    });

    // (a) handled key: consumed, never reaches the editor.
    pressOnEditor(view, '1');
    expect(seen).toEqual(['handled-1']);

    // (b) unhandled key aimed at the editor: swallowed, no doc change.
    pressOnEditor(view, 'Enter');
    pressOnEditor(view, 'Backspace');
    expect(view.state.doc.toJSON()).toEqual(before);

    // (c) key aimed at the dialog's own control: passes through
    // untouched (so inputs/textareas keep native behavior).
    const evt = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    inner.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);

    remove();
    popOverlay(token);
    view.destroy();
  });

  it('focus moves into the dialog on open and back to the editor on close', async () => {
    const view = mkView();
    expect(document.activeElement).toBe(view.dom);
    const p = confirmDialog('Focus check');
    expect(document.activeElement).not.toBe(view.dom); // dialog holds focus
    pressOnEditor(view, 'Enter');
    await p;
    expect(document.activeElement).toBe(view.dom); // restored
    view.destroy();
  });
});

/** showConfirm (confirm-dialog.ts) is the standalone confirm primitive
 *  the 2026-07-27 modal-key sweep missed — the focus audit CONFIRMED it
 *  registered nothing on the overlay stack and swallowed only
 *  Enter/Escape, leaking every other key during its pre-focus window. */
describe('showConfirm modal hardening', () => {
  it('registers on the overlay stack for its lifetime', async () => {
    expect(isAnyOverlayOpen()).toBe(false);
    const p = showConfirm({ message: 'Sure?' });
    expect(isAnyOverlayOpen()).toBe(true);
    document.querySelector<HTMLButtonElement>('.pmd-confirm-ok')!.click();
    await expect(p).resolves.toBe(true);
    expect(isAnyOverlayOpen()).toBe(false);
  });

  it('swallows unhandled keys — nothing reaches the editor', async () => {
    const view = mkView();
    const before = view.state.doc.toJSON();
    const p = showConfirm({ message: 'Sure?' });
    pressOnEditor(view, 'Backspace'); // PM-handled — must be swallowed
    expect(view.state.doc.toJSON()).toEqual(before);
    pressOnEditor(view, 'Enter'); // confirms, no split-block
    await expect(p).resolves.toBe(true);
    expect(view.state.doc.toJSON()).toEqual(before);
    view.destroy();
  });

  it('Escape cancels and focus returns to the editor', async () => {
    const view = mkView();
    expect(document.activeElement).toBe(view.dom);
    const p = showConfirm({ message: 'Sure?' });
    pressOnEditor(view, 'Escape');
    await expect(p).resolves.toBe(false);
    expect(document.activeElement).toBe(view.dom); // restored
    view.destroy();
  });
});

/** The word-count and shortcuts-reference modals shared showConfirm's
 *  pattern (focus audit, CONFIRMED): no focus, no overlay registration,
 *  Escape-only listener — typing over them fell through to the doc. */
describe('read-only modals (word count, shortcuts reference)', () => {
  it('word count: registers, swallows keys, Escape closes + restores focus', () => {
    const view = mkView();
    const before = view.state.doc.toJSON();
    openWordCount(view);
    expect(document.querySelector('.pmd-wc-scope')?.textContent)
      .toBe('Full document: 1 read-aloud words · 1 card');
    expect(isAnyOverlayOpen()).toBe(true);
    pressOnEditor(view, 'Backspace');
    pressOnEditor(view, 'Enter');
    expect(view.state.doc.toJSON()).toEqual(before); // nothing reached the doc
    pressOnEditor(view, 'Escape');
    expect(isAnyOverlayOpen()).toBe(false);
    expect(document.activeElement).toBe(view.dom); // restored
    view.destroy();
  });

  it('shortcuts reference: registers, swallows keys, Escape closes + restores focus', () => {
    const view = mkView();
    const before = view.state.doc.toJSON();
    openReference();
    expect(isAnyOverlayOpen()).toBe(true);
    pressOnEditor(view, 'Backspace');
    expect(view.state.doc.toJSON()).toEqual(before);
    pressOnEditor(view, 'Escape');
    expect(isAnyOverlayOpen()).toBe(false);
    expect(document.activeElement).toBe(view.dom);
    view.destroy();
  });
});

/** Non-modal surfaces (menus, the recovery sidebar) close on Escape but
 *  deliberately let every other key through — the editor stays usable
 *  beside them. Their hardening is narrower: the Escape they DO handle
 *  is consumed (no second surface closes on the same press), and they
 *  stand down entirely while a modal overlay is stacked above. */
describe('non-modal Escape surfaces', () => {
  it('doc menu: Escape closes and is consumed; a modal above takes priority', () => {
    const view = mkView();
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    openDocMenu(anchor, view, [
      { title: 'Test', items: [{ label: 'X', run: () => {} }] },
    ]);
    expect(document.querySelector('.pmd-doc-menu')).not.toBeNull();

    // Modal overlay on top: the Escape is the modal's, menu stays.
    const token = pushOverlay();
    pressOnEditor(view, 'Escape');
    expect(document.querySelector('.pmd-doc-menu')).not.toBeNull();
    popOverlay(token);

    const evt = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    view.dom.dispatchEvent(evt);
    expect(document.querySelector('.pmd-doc-menu')).toBeNull();
    expect(evt.defaultPrevented).toBe(true); // consumed — no double-fire
    view.destroy();
  });

  it('recovery sidebar: Escape closes and is consumed; a modal above takes priority', async () => {
    const view = mkView();
    const done = openRecoverySidebar([], {
      onSave: () => true,
      onOpen: () => {},
      onDiscard: () => {},
    });
    expect(document.querySelector('.pmd-recovery-sidebar')).not.toBeNull();

    const token = pushOverlay();
    pressOnEditor(view, 'Escape');
    expect(document.querySelector('.pmd-recovery-sidebar')).not.toBeNull();
    popOverlay(token);

    const evt = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    view.dom.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
    await done; // close resolves the sidebar's promise
    expect(document.querySelector('.pmd-recovery-sidebar')).toBeNull();
    view.destroy();
  });
});
