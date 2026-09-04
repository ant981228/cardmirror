/**
 * Word Count Selection modal.
 *
 * Shows the read-aloud word count for the current selection (or the
 * full doc if nothing is selected) plus read-time estimates for every
 * configured reader.
 */

import type { EditorView } from 'prosemirror-view';
import { settings } from './settings.js';
import { countCards, countReadAloudSplit, totalWords, formatReadTimeFor, formatNumber } from './word-count.js';
import { setIcon } from './icons';
import { pushOverlay, popOverlay } from './overlay-stack.js';
import {
  installModalKeys,
  armDialogFocus,
  captureFocusForDialog,
} from './text-prompt.js';

class WordCountModal {
  private overlay: HTMLDivElement;
  private dialog: HTMLDivElement;
  /** Modal plumbing while open (2026-07-27 focus audit: this modal
   *  held no focus and registered nothing — keystrokes typed over it
   *  fell through into the document behind, and background handlers
   *  saw "no modal open"). */
  private overlayToken: symbol | null = null;
  private removeKeys: (() => void) | null = null;
  private restoreFocus: (() => void) | null = null;

  constructor() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'pmd-settings-overlay'; // reuse modal overlay style
    this.overlay.style.display = 'none';

    this.dialog = document.createElement('div');
    this.dialog.className = 'pmd-settings-dialog';
    this.overlay.appendChild(this.dialog);

    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });

    document.body.appendChild(this.overlay);
  }

  open(view: EditorView): void {
    this.render(view);
    this.overlay.style.display = '';
    if (this.overlayToken === null) {
      const token = pushOverlay();
      this.overlayToken = token;
      this.restoreFocus = captureFocusForDialog();
      this.removeKeys = installModalKeys(this.dialog, token, (e) => {
        if (e.key === 'Escape') {
          this.close();
          return true;
        }
        return false;
      });
    }
    armDialogFocus(this.dialog, 'dialog', 'Word Count');
  }

  close(): void {
    this.overlay.style.display = 'none';
    if (this.overlayToken !== null) {
      popOverlay(this.overlayToken);
      this.overlayToken = null;
    }
    this.removeKeys?.();
    this.removeKeys = null;
    this.restoreFocus?.();
    this.restoreFocus = null;
  }

  private render(view: EditorView): void {
    this.dialog.innerHTML = '';

    const header = document.createElement('header');
    header.className = 'pmd-settings-header';
    const title = document.createElement('h2');
    title.textContent = 'Word Count Selection';
    header.appendChild(title);
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'pmd-settings-close';
    setIcon(closeBtn, 'close');
    closeBtn.addEventListener('click', () => this.close());
    header.appendChild(closeBtn);
    this.dialog.appendChild(header);

    const body = document.createElement('div');
    body.className = 'pmd-settings-list';
    this.dialog.appendChild(body);

    const sel = view.state.selection;
    const hasSelection = !sel.empty;
    const counts = hasSelection
      ? countReadAloudSplit(view.state.doc, sel.from, sel.to)
      : countReadAloudSplit(view.state.doc);
    const words = totalWords(counts);
    const cards = hasSelection
      ? countCards(view.state.doc, sel.from, sel.to)
      : countCards(view.state.doc);
    const cardLabel = `${formatNumber(cards)} ${cards === 1 ? 'card' : 'cards'}`;

    const scope = document.createElement('p');
    scope.className = 'pmd-wc-scope';
    scope.textContent = hasSelection
      ? `Selection: ${formatNumber(words)} read-aloud words · ${cardLabel}`
      : `Full document: ${formatNumber(words)} read-aloud words · ${cardLabel}`;
    body.appendChild(scope);

    const readers = settings.get('readers');
    if (readers.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'pmd-settings-empty';
      empty.textContent = 'No readers configured. Add some in Settings.';
      body.appendChild(empty);
      return;
    }

    const table = document.createElement('table');
    table.className = 'pmd-wc-table';
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    for (const h of ['Reader', 'WPM', 'Time']) {
      const th = document.createElement('th');
      th.textContent = h;
      trh.appendChild(th);
    }
    thead.appendChild(trh);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const r of readers) {
      const tr = document.createElement('tr');
      const tdName = document.createElement('td');
      tdName.textContent = r.name;
      tr.appendChild(tdName);
      const tdWpm = document.createElement('td');
      // Two-rate readers show both: "200 / 260" = body / tags·cites.
      tdWpm.textContent = r.tagWpm != null ? `${r.wpm} / ${r.tagWpm}` : String(r.wpm);
      if (r.tagWpm != null) tdWpm.title = 'card bodies / tags, analytics & cites';
      tdWpm.className = 'pmd-wc-numeric';
      tr.appendChild(tdWpm);
      const tdTime = document.createElement('td');
      tdTime.textContent = formatReadTimeFor(counts, r);
      tdTime.className = 'pmd-wc-numeric';
      tr.appendChild(tdTime);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    body.appendChild(table);
  }
}

let singleton: WordCountModal | null = null;

export function openWordCount(view: EditorView): void {
  if (!singleton) singleton = new WordCountModal();
  singleton.open(view);
}
