/**
 * Save As modal. Promise-based — resolves with the user's chosen
 * filename + format + export options, or `null` if they cancelled.
 *
 * Three output formats:
 *   - `cmir` — CardMirror native (lossless JSON, no Verbatim round-
 *     trip). Recommended for docs that live entirely in CardMirror.
 *   - `docx` — Microsoft Word / Verbatim. Use for sharing with
 *     teammates still on Verbatim, or for any tournament-day round
 *     where the receiving party needs Word.
 *   - `pdf` — a print-ready copy (pdf-export.ts). Always a separate
 *     export: the working doc keeps its own file, and comments aren't
 *     printed.
 *
 * Layout: a Name section, a Format section, then a Save section
 * with one-click presets — As-Is (everything), Send Doc (no
 * analytics / undertags / comments), Read Doc (read-mode export),
 * Marked Doc (marked cards only), each with its description as a
 * caption below the button — followed by a Custom Save block
 * (comments / analytics / undertags checkboxes + a Save Custom
 * button), then Cancel. The format radio drives the default
 * filename extension and which filter the OS dialog defaults to;
 * all content options apply equally to every format.
 */

import { settings } from './settings.js';
import type { NumberingExportMode } from './numbering-bake.js';
import { setIcon } from './icons';
import { pushOverlay, popOverlay } from './overlay-stack.js';
import { installModalKeys, captureFocusForDialog } from './text-prompt.js';

export type SaveAsFormat = 'cmir' | 'docx' | 'pdf';

export interface SaveAsResult {
  filename: string;
  /** Which on-disk format the user picked. */
  format: SaveAsFormat;
  /** Include comments in the saved doc. */
  includeComments: boolean;
  /** Include analytic content. When false, doc-level analytic_units
   *  drop entirely; in-card analytic paragraphs drop. */
  includeAnalytics: boolean;
  /** Include undertag paragraphs (doc-level and inside cards /
   *  analytic_units). */
  includeUndertags: boolean;
  /** Save only what's visible in read mode: headings, tags, in-card
   *  analytics, cite-marked text inside cite_paragraphs, highlighted
   *  text inside body paragraphs. Mutually exclusive with the three
   *  include-* options above. */
  readMode: boolean;
  /** Bake the private note layer into the file as real comments. Off by
   *  default — notes are private and normally never leave CardMirror. */
  includeNotes: boolean;
  /** Bake the private AI-thread layer into the file as real comments.
   *  Off by default, same rationale as notes. */
  includeAiThreads: boolean;
  /** Keep ONLY the cards that contain a reading marker, flat (no headings, no
   *  analytics). Mutually exclusive with the include-* / readMode options. */
  markedCardsOnly: boolean;
  /** Card numbers: `keep` the live skeleton (As-Is, or Custom with neither
   *  box ticked), `freeze` them as heading text, or `remove` them. The
   *  presets read the `*DocNumbering` settings. */
  numbering: NumberingExportMode;
}

export interface OpenSaveAsOptions {
  /** Initial filename suggestion (with or without an extension — the
   *  dialog will normalize on confirm). */
  initialFilename: string;
  /** Default format to pre-select. Usually the current doc's format
   *  (so re-saving stays in the same format unless the user changes
   *  it). New docs default to `'cmir'`, the native format. */
  defaultFormat: SaveAsFormat;
  /** Offer the PDF format. Off unless the caller handles a PDF result —
   *  e.g. crash recovery must not, since a PDF can't stand in for the
   *  recovered document. */
  allowPdf?: boolean;
}

export function openSaveAs(opts: OpenSaveAsOptions): Promise<SaveAsResult | null> {
  return new Promise((resolve) => {
    new SaveAsModal(opts, resolve);
  });
}

const FORMAT_LABELS: Record<SaveAsFormat, string> = {
  cmir: 'CardMirror native (.cmir)',
  docx: 'Microsoft Word (.docx)',
  pdf: 'PDF (.pdf)',
};

const FORMAT_BLURBS: Record<SaveAsFormat, string> = {
  cmir: 'Lossless. No conversion. Best for docs that stay in CardMirror.',
  docx: 'For sharing with Verbatim users or any Word-based workflow.',
  pdf: 'A print-ready copy to read or share. Saved alongside your document; comments aren’t printed.',
};

class SaveAsModal {
  private readonly overlay: HTMLDivElement;
  private readonly dialog: HTMLDivElement;
  private filenameInput!: HTMLInputElement;
  private commentsBox!: HTMLInputElement;
  private analyticsBox!: HTMLInputElement;
  private undertagsBox!: HTMLInputElement;
  private notesBox!: HTMLInputElement;
  private freezeNumbersBox!: HTMLInputElement;
  private removeNumbersBox!: HTMLInputElement;
  private aiThreadsBox!: HTMLInputElement;
  /** Radio inputs keyed by format id. */
  private formatRadios!: Record<SaveAsFormat, HTMLInputElement>;
  private settled = false;
  private currentFormat: SaveAsFormat;
  /** Overlay-stack token + modal-key uninstaller + focus restorer
   *  (2026-07-27 focus audit: this dialog registered nothing, so
   *  background handlers saw "no modal open" while it was up, its
   *  Escape-only listener let other keys pass, and closing it never
   *  returned focus to the editor). */
  private overlayToken = pushOverlay();
  private removeKeys: () => void = () => {};
  private restoreFocus: () => void = () => {};

  constructor(
    private readonly opts: OpenSaveAsOptions,
    private readonly settle: (r: SaveAsResult | null) => void,
  ) {
    this.currentFormat = opts.defaultFormat;
    this.overlay = document.createElement('div');
    this.overlay.className = 'pmd-save-as-overlay';

    this.dialog = document.createElement('div');
    this.dialog.className = 'pmd-save-as-dialog';
    this.overlay.appendChild(this.dialog);

    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.cancel();
    });

    this.restoreFocus = captureFocusForDialog();
    this.removeKeys = installModalKeys(this.dialog, this.overlayToken, (e) => {
      if (e.key === 'Escape') {
        this.cancel();
        return true;
      }
      // Everything else: keys aimed at the dialog's own inputs pass
      // through natively (Enter in the filename field submits the
      // form); keys aimed anywhere else are swallowed by the helper.
      return false;
    });

    this.render();
    document.body.appendChild(this.overlay);

    requestAnimationFrame(() => {
      this.filenameInput.focus();
      // Select just the basename, not the extension, so the user can
      // type a new name without clobbering the extension.
      const dot = this.filenameInput.value.lastIndexOf('.');
      if (dot > 0) {
        this.filenameInput.setSelectionRange(0, dot);
      } else {
        this.filenameInput.select();
      }
    });
  }

  private render(): void {
    const header = document.createElement('header');
    header.className = 'pmd-save-as-header';
    const title = document.createElement('h2');
    title.textContent = 'Save As';
    header.appendChild(title);
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'pmd-save-as-close';
    setIcon(closeBtn, 'close');
    closeBtn.title = 'Cancel';
    closeBtn.addEventListener('click', () => this.cancel());
    header.appendChild(closeBtn);
    this.dialog.appendChild(header);

    const form = document.createElement('form');
    form.className = 'pmd-save-as-body';
    // Enter / the Save Custom submit button save with the current
    // Include checkbox state.
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.confirmWith({
        includeComments: this.commentsBox.checked,
        includeAnalytics: this.analyticsBox.checked,
        includeUndertags: this.undertagsBox.checked,
        readMode: false,
        includeNotes: this.notesBox.checked,
        includeAiThreads: this.aiThreadsBox.checked,
        markedCardsOnly: false,
        numbering: this.freezeNumbersBox.checked ? 'freeze' : this.removeNumbersBox.checked ? 'remove' : 'keep',
      });
    });

    // FILE NAME and FORMAT — the what/where, each under its heading.
    form.appendChild(this.buildFileNameSection());
    form.appendChild(this.buildFormatSection());

    // SAVE section heading — covers the presets and the custom-save
    // block below.
    const saveHeading = document.createElement('div');
    saveHeading.className = 'pmd-save-as-options-heading';
    saveHeading.textContent = 'Save';
    form.appendChild(saveHeading);

    // One-click presets — common content configurations. Each saves
    // immediately with the filename + format above; the description
    // shows as a caption below the button.
    const presets = document.createElement('div');
    presets.className = 'pmd-save-as-presets';
    presets.appendChild(
      this.buildPreset(
        'As-Is',
        'Includes everything in the document.',
        {
          includeComments: true,
          includeAnalytics: true,
          includeUndertags: true,
          readMode: false,
          includeNotes: false,
          includeAiThreads: false,
          markedCardsOnly: false,
          numbering: 'keep',
        },
      ),
    );
    presets.appendChild(
      this.buildPreset(
        'Send Doc',
        'Excludes analytics, undertags, and comments.',
        {
          includeComments: false,
          includeAnalytics: false,
          includeUndertags: false,
          readMode: false,
          includeNotes: false,
          includeAiThreads: false,
          markedCardsOnly: false,
          numbering: settings.get('sendDocNumbering'),
        },
        settings.get('sendDocPrefix'),
      ),
    );
    presets.appendChild(
      this.buildPreset(
        'Read Doc',
        'Exports the read-mode view of the document.',
        {
          includeComments: false,
          includeAnalytics: false,
          includeUndertags: false,
          readMode: true,
          includeNotes: false,
          includeAiThreads: false,
          markedCardsOnly: false,
          // Read mode keeps every heading, so nothing renumbers: live numbering.
          numbering: 'keep',
        },
        settings.get('readDocPrefix'),
      ),
    );
    presets.appendChild(
      this.buildPreset(
        'Marked Doc',
        'Saves only the cards you marked.',
        {
          includeComments: false,
          includeAnalytics: false,
          includeUndertags: true,
          readMode: false,
          includeNotes: false,
          includeAiThreads: false,
          markedCardsOnly: true,
          numbering: settings.get('markedDocNumbering'),
        },
        settings.get('markedDocPrefix'),
      ),
    );
    form.appendChild(presets);

    // Custom Save: the Include checkboxes + a Save Custom button.
    const options = document.createElement('div');
    options.className = 'pmd-save-as-options';
    options.appendChild(this.buildOptionsHeading());

    this.commentsBox = this.buildCheckbox('Include comments', true);
    this.analyticsBox = this.buildCheckbox('Include analytics', true);
    this.undertagsBox = this.buildCheckbox('Include undertags', true);
    // Private annotation layers — off by default (they normally never
    // leave CardMirror). Checking them bakes the notes / AI threads into
    // the saved file as real Word-style comments.
    this.notesBox = this.buildCheckbox('Include private notes (as comments)', false);
    this.aiThreadsBox = this.buildCheckbox('Include AI comments (as comments)', false);
    // Card numbers: freeze as heading text, or remove — one or the other,
    // never both; neither ticked keeps the live numbering (an As-Is copy).
    this.freezeNumbersBox = this.buildCheckbox('Freeze card numbers as text', false);
    this.removeNumbersBox = this.buildCheckbox('Remove card numbers', false);
    this.freezeNumbersBox.addEventListener('change', () => {
      if (this.freezeNumbersBox.checked) this.removeNumbersBox.checked = false;
    });
    this.removeNumbersBox.addEventListener('change', () => {
      if (this.removeNumbersBox.checked) this.freezeNumbersBox.checked = false;
    });
    options.appendChild(this.commentsBox.parentElement!);
    options.appendChild(this.analyticsBox.parentElement!);
    options.appendChild(this.undertagsBox.parentElement!);
    options.appendChild(this.freezeNumbersBox.parentElement!);
    options.appendChild(this.removeNumbersBox.parentElement!);
    options.appendChild(this.notesBox.parentElement!);
    options.appendChild(this.aiThreadsBox.parentElement!);

    const customSave = document.createElement('button');
    customSave.type = 'submit';
    customSave.className = 'pmd-save-as-btn pmd-save-as-btn-primary pmd-save-as-custom-save';
    customSave.textContent = 'Save Custom';
    options.appendChild(customSave);

    form.appendChild(options);

    // Cancel sits alone at the very bottom.
    const footer = document.createElement('footer');
    footer.className = 'pmd-save-as-footer';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'pmd-save-as-btn pmd-save-as-btn-secondary';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => this.cancel());
    footer.appendChild(cancel);
    form.appendChild(footer);

    this.dialog.appendChild(form);
  }

  /** Build a preset cell: a primary (blue) button with its
   *  description as a caption below. Clicking the button saves
   *  immediately with the given content options (filename + format
   *  read live from the inputs). `prefix` is prepended to the file
   *  name (subject to the `prefixPresetSaveFilenames` setting). */
  private buildPreset(
    title: string,
    sub: string,
    opts: {
      includeComments: boolean;
      includeAnalytics: boolean;
      includeUndertags: boolean;
      readMode: boolean;
      includeNotes: boolean;
      includeAiThreads: boolean;
      markedCardsOnly: boolean;
      numbering: NumberingExportMode;
    },
    prefix = '',
  ): HTMLElement {
    const cell = document.createElement('div');
    cell.className = 'pmd-save-as-preset';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-save-as-btn pmd-save-as-btn-primary pmd-save-as-preset-btn';
    btn.textContent = title;
    btn.addEventListener('click', () => this.confirmWith(opts, prefix));
    cell.appendChild(btn);
    const caption = document.createElement('span');
    caption.className = 'pmd-save-as-preset-sub';
    caption.textContent = sub;
    cell.appendChild(caption);
    return cell;
  }

  /** FILE NAME section: a heading + the file-name input. */
  private buildFileNameSection(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'pmd-save-as-field';
    const heading = document.createElement('div');
    heading.className = 'pmd-save-as-options-heading';
    heading.textContent = 'Name';
    wrap.appendChild(heading);
    this.filenameInput = document.createElement('input');
    this.filenameInput.type = 'text';
    this.filenameInput.className = 'pmd-save-as-input';
    this.filenameInput.value = withExtension(this.opts.initialFilename, this.currentFormat);
    this.filenameInput.spellcheck = false;
    this.filenameInput.autocomplete = 'off';
    wrap.appendChild(this.filenameInput);
    return wrap;
  }

  /** FORMAT section: a heading + the cmir / docx / pdf radio rows. */
  private buildFormatSection(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'pmd-save-as-format';
    const heading = document.createElement('div');
    heading.className = 'pmd-save-as-options-heading';
    heading.textContent = 'Format';
    wrap.appendChild(heading);

    const groupName = `pmd-save-as-format-${Math.random().toString(36).slice(2, 8)}`;
    this.formatRadios = { cmir: null!, docx: null!, pdf: null! };
    const formats: SaveAsFormat[] = this.opts.allowPdf ? ['cmir', 'docx', 'pdf'] : ['cmir', 'docx'];
    for (const id of formats) {
      const row = document.createElement('label');
      row.className = 'pmd-save-as-format-row';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = groupName;
      input.value = id;
      input.checked = id === this.currentFormat;
      input.addEventListener('change', () => {
        if (input.checked) this.setFormat(id);
      });
      this.formatRadios[id] = input;
      row.appendChild(input);
      const text = document.createElement('span');
      text.className = 'pmd-save-as-format-row-text';
      const label = document.createElement('span');
      label.className = 'pmd-save-as-format-row-label';
      label.textContent = FORMAT_LABELS[id];
      text.appendChild(label);
      const blurb = document.createElement('span');
      blurb.className = 'pmd-save-as-format-row-blurb';
      blurb.textContent = FORMAT_BLURBS[id];
      text.appendChild(blurb);
      row.appendChild(text);
      wrap.appendChild(row);
    }
    return wrap;
  }

  /** Update the format and swap the filename's extension to match. */
  private setFormat(format: SaveAsFormat): void {
    this.currentFormat = format;
    this.filenameInput.value = withExtension(this.filenameInput.value, format);
  }

  private buildOptionsHeading(): HTMLElement {
    const h = document.createElement('div');
    h.className = 'pmd-save-as-options-heading';
    h.textContent = 'Custom Save';
    return h;
  }

  private buildCheckbox(labelText: string, defaultChecked: boolean): HTMLInputElement {
    const label = document.createElement('label');
    label.className = 'pmd-save-as-option';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = defaultChecked;
    label.appendChild(box);
    const text = document.createElement('span');
    text.textContent = labelText;
    label.appendChild(text);
    return box;
  }

  /** Save with the given content options + the live filename /
   *  format. Shared by every preset and the Save Custom submit.
   *  `prefix` (from the Send/Read/Marked Doc presets) is prepended
   *  to the file name when the `prefixPresetSaveFilenames` setting
   *  is on. No-op on an empty filename. */
  private confirmWith(
    opts: {
      includeComments: boolean;
      includeAnalytics: boolean;
      includeUndertags: boolean;
      readMode: boolean;
      includeNotes: boolean;
      includeAiThreads: boolean;
      markedCardsOnly: boolean;
      numbering: NumberingExportMode;
    },
    prefix = '',
  ): void {
    const trimmed = this.filenameInput.value.trim();
    if (!trimmed) return;
    const named = withExtension(trimmed, this.currentFormat);
    const usePrefix = prefix && settings.get('prefixPresetSaveFilenames');
    this.finish({
      filename: usePrefix ? prefix + named : named,
      format: this.currentFormat,
      ...opts,
    });
  }

  private cancel(): void {
    this.finish(null);
  }

  private finish(result: SaveAsResult | null): void {
    if (this.settled) return;
    this.settled = true;
    this.removeKeys();
    popOverlay(this.overlayToken);
    this.overlay.remove();
    this.restoreFocus();
    this.settle(result);
  }
}

/** Normalize a filename to end with the right extension for the
 *  chosen format. Strips other known extensions first so swapping
 *  the format radio replaces `.docx` with `.cmir` and vice versa
 *  without piling them up. */
function withExtension(filename: string, format: SaveAsFormat): string {
  let base = filename.trim();
  for (const ext of ['.cmir', '.docx', '.pdf']) {
    if (base.toLowerCase().endsWith(ext)) {
      base = base.slice(0, -ext.length);
      break;
    }
  }
  return `${base}.${format}`;
}
