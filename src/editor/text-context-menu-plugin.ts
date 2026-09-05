/**
 * Default right-click menu for editor text: Cut / Copy / Paste.
 *
 * Registered AFTER the image, link, and spellcheck context-menu
 * plugins, so it only sees right-clicks none of them claimed — it is
 * the editor's fallback menu, giving right-click a purpose everywhere
 * in the document. (Before this, a right-click on plain text did
 * nothing visible, which trained users to right-click repeatedly —
 * the exact posture behind the 2026-08-14 paintbrush incident.)
 *
 * Cut/Copy serialize through `view.serializeForClipboard`, so
 * transformCopied hooks and the schema's clipboard representation
 * apply exactly as a keyboard copy would, then write through the
 * shared clipboard-write ladder (main-process first; honest failure
 * toast — no silent failures). Cut only deletes AFTER the clipboard
 * write reports success, so a busy clipboard can never eat text.
 * Paste prefers the main-process html+text read on desktop (no
 * permission UI, rich flavor preserved); the web edition asks the
 * async clipboard API and, if the browser blocks it, tells the user
 * the keyboard shortcut instead of failing silently.
 *
 * Styling reuses `.pmd-nav-context-menu` to match the other context
 * menus; open/close is coordinated through the shared registry.
 */

import { Plugin } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { showToast } from './toast.js';
import { writeClipboardHtml, CLIPBOARD_BUSY_MESSAGE } from './clipboard-write.js';
import { cutInPlaceApplies, markCutInPlace } from './cut-in-place.js';
import { getElectronHost } from './host/index.js';
import { registerOpenContextMenu, clearOpenContextMenu } from './context-menu-registry.js';
import { formatKeyForDisplay } from './ribbon-commands.js';

export const textContextMenuPlugin: Plugin = new Plugin({
  props: {
    handleDOMEvents: {
      contextmenu(view, event) {
        // Image, link, and misspelling right-clicks were claimed by
        // their plugins (registered earlier); everything reaching
        // here gets the fallback menu.
        event.preventDefault();
        showTextContextMenu(event.clientX, event.clientY, view);
        return true;
      },
    },
  },
});

interface MenuItem {
  label: string;
  hint?: string;
  disabled?: boolean;
  action: () => void;
}

let openMenuEl: HTMLElement | null = null;

function showTextContextMenu(x: number, y: number, view: EditorView): void {
  closeTextContextMenu();

  const sel = view.state.selection;
  const items: MenuItem[] = [
    {
      label: 'Cut',
      hint: formatKeyForDisplay('Mod-X'),
      disabled: sel.empty || !view.editable,
      action: () => void cutSelection(view),
    },
    {
      label: 'Copy',
      hint: formatKeyForDisplay('Mod-C'),
      disabled: sel.empty,
      action: () => void copySelection(view),
    },
    {
      label: 'Paste',
      hint: formatKeyForDisplay('Mod-V'),
      disabled: !view.editable,
      action: () => void pasteFromClipboard(view),
    },
  ];

  const menu = document.createElement('div');
  menu.className = 'pmd-nav-context-menu';
  for (const item of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-nav-context-item';
    btn.textContent = item.label;
    if (item.hint) {
      const hint = document.createElement('span');
      hint.className = 'pmd-context-item-hint';
      hint.textContent = item.hint;
      btn.appendChild(hint);
    }
    if (item.disabled) {
      btn.disabled = true;
      btn.classList.add('pmd-nav-context-item-disabled');
    }
    // Keep focus (and the visible DOM selection Copy is about to
    // serialize) in the editor while the menu is clicked.
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      if (item.disabled) return;
      closeTextContextMenu();
      item.action();
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 4;
  const maxY = window.innerHeight - rect.height - 4;
  menu.style.left = `${Math.min(x, Math.max(0, maxX))}px`;
  menu.style.top = `${Math.min(y, Math.max(0, maxY))}px`;

  openMenuEl = menu;
  registerOpenContextMenu(closeTextContextMenu);
  // Defer, so the contextmenu's own trailing events can't instantly
  // dismiss the menu (same reason the image menu defers).
  setTimeout(() => {
    window.addEventListener('mousedown', maybeCloseTextContextMenu, { capture: true });
    window.addEventListener('keydown', maybeCloseTextContextMenu, { capture: true });
  });
}

function closeTextContextMenu(): void {
  if (!openMenuEl) return;
  openMenuEl.remove();
  openMenuEl = null;
  clearOpenContextMenu(closeTextContextMenu);
  window.removeEventListener('mousedown', maybeCloseTextContextMenu, { capture: true });
  window.removeEventListener('keydown', maybeCloseTextContextMenu, { capture: true });
}

function maybeCloseTextContextMenu(e: MouseEvent | KeyboardEvent): void {
  if (e instanceof KeyboardEvent) {
    if (e.key === 'Escape') closeTextContextMenu();
    return;
  }
  if (!openMenuEl) return;
  if (!openMenuEl.contains(e.target as Node)) closeTextContextMenu();
}

/** Serialize the live selection exactly as a keyboard copy would and
 *  push it through the shared write ladder. Returns whether the
 *  clipboard actually took it (cut's delete is gated on this). */
async function copySelection(view: EditorView): Promise<boolean> {
  const sel = view.state.selection;
  if (sel.empty) return false;
  const { dom, text } = view.serializeForClipboard(sel.content());
  const ok = await writeClipboardHtml(dom.innerHTML, text);
  if (!ok) showToast(CLIPBOARD_BUSY_MESSAGE);
  view.focus();
  return ok;
}

async function cutSelection(view: EditorView): Promise<void> {
  // Whole units in a shared document are cut in place (cut-in-place.ts).
  const units = cutInPlaceApplies(view);
  if (units) {
    await markCutInPlace(view, units);
    view.focus();
    return;
  }
  if (!(await copySelection(view))) return; // failed copy must not delete
  if (view.state.selection.empty) return;
  view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
  view.focus();
}

async function pasteFromClipboard(view: EditorView): Promise<void> {
  const deliver = (html: string, text: string): void => {
    view.focus();
    if (html) view.pasteHTML(html);
    else if (text) view.pasteText(text);
    // Both empty: clipboard has nothing pasteable — do nothing,
    // matching the keyboard shortcut's behavior.
  };

  const host = getElectronHost();
  if (host) {
    const rich = await host.clipboardReadHtml().catch(() => null);
    if (rich) {
      deliver(rich.html, rich.text);
      return;
    }
    // Older shell without the html read — text-only paste.
    const text = await host.clipboardReadText().catch(() => '');
    deliver('', text);
    return;
  }

  // Web edition: the async clipboard API, which the browser may gate
  // behind a permission prompt or refuse outright.
  try {
    if (navigator.clipboard?.read) {
      const clip = await navigator.clipboard.read();
      for (const item of clip) {
        if (item.types.includes('text/html')) {
          deliver(await (await item.getType('text/html')).text(), '');
          return;
        }
      }
      for (const item of clip) {
        if (item.types.includes('text/plain')) {
          deliver('', await (await item.getType('text/plain')).text());
          return;
        }
      }
      return; // nothing pasteable
    }
    if (navigator.clipboard?.readText) {
      deliver('', await navigator.clipboard.readText());
      return;
    }
    throw new Error('no async clipboard');
  } catch {
    showToast(
      `The browser blocked clipboard access — press ${formatKeyForDisplay('Mod-V')} to paste.`,
    );
  }
}
