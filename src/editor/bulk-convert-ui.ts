/**
 * Bulk convert — a home-screen utility to batch-convert between
 * `.docx` and `.cmir`, and to turn PDFs exported from Verbatim or CardMirror
 * back into `.docx` (src/import/pdf).
 *
 * Pick an input (a single file or a folder, recursed incl. subfolders)
 * and a destination folder, choose the direction and output form
 * (loose files or a single `.zip`), then Convert. Files are written
 * into the destination (preserving the input's subfolder structure);
 * a zip is written there too.
 *
 * Electron-only: needs recursive directory listing + write-to-path, so
 * the home screen only surfaces the entry on the desktop edition.
 */

import { zipSync } from 'fflate';
import { fromDocxFull, parseNative, serializeNative, toDocx } from '../index.js';
import { getHost, getElectronHost } from './host/index.js';
import { settings } from './settings.js';
import { runWebFileTool } from './web-file-tools.js';
import { setIcon } from './icons';
import { convertPdf } from './pdf-open.js';

type Direction = 'docx2cmir' | 'cmir2docx' | 'pdf2docx';
type Output = 'files' | 'zip';

interface InputSel {
  kind: 'file' | 'folder';
  path: string;
  name: string;
  /** Bytes (file input only). */
  bytes?: Uint8Array;
}

async function convertBytes(bytes: Uint8Array, dir: Direction): Promise<Uint8Array> {
  if (dir === 'pdf2docx') {
    return toDocx(await convertPdf(bytes), { defaultFont: settings.get('bodyFont') });
  }
  if (dir === 'docx2cmir') {
    const { doc, threads } = await fromDocxFull(bytes);
    return serializeNative(doc, threads.length ? { threads } : undefined);
  }
  const { doc, threads } = parseNative(bytes);
  return toDocx(doc, {
    ...(threads.length ? { threads } : {}),
    defaultFont: settings.get('bodyFont'),
  });
}

/** The extension each direction reads. */
function sourceExt(dir: Direction): 'docx' | 'cmir' | 'pdf' {
  return dir === 'docx2cmir' ? 'docx' : dir === 'pdf2docx' ? 'pdf' : 'cmir';
}

function swapExt(p: string, dir: Direction): string {
  if (dir === 'docx2cmir') return p.replace(/\.docx$/i, '.cmir');
  if (dir === 'pdf2docx') return p.replace(/\.pdf$/i, '.docx');
  return p.replace(/\.cmir$/i, '.docx');
}

function baseName(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;
}

function baseNoExt(name: string): string {
  return name.replace(/\.(docx|cmir|pdf)$/i, '');
}

/** Join a destination dir + relative path with a forward slash
 *  (Node's fs accepts it on every platform). */
function joinPath(dir: string, rel: string): string {
  return `${dir.replace(/[\\/]+$/, '')}/${rel.replace(/^[\\/]+/, '')}`;
}

class BulkConvertModal {
  private readonly overlay: HTMLDivElement;
  private readonly dialog: HTMLDivElement;
  private statusEl!: HTMLDivElement;
  private inputPathEl!: HTMLDivElement;
  private outputPathEl!: HTMLDivElement;
  private convertBtn!: HTMLButtonElement;
  private busy = false;
  private settled = false;
  private dirRadios!: Record<Direction, HTMLInputElement>;
  private outRadios!: Record<Output, HTMLInputElement>;

  private inputSel: InputSel | null = null;
  private outputDir: string | null = null;

  constructor() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'pmd-bulk-overlay';
    this.dialog = document.createElement('div');
    this.dialog.className = 'pmd-bulk-dialog';
    this.overlay.appendChild(this.dialog);
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });
    document.addEventListener('keydown', this.onKey, true);
    this.render();
    document.body.appendChild(this.overlay);
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !this.busy) {
      e.preventDefault();
      // Capture-phase listener: stop the Escape here so it doesn't also
      // reach the home screen's keydown handler (which would dismiss
      // home out from under the closing modal).
      e.stopPropagation();
      this.close();
    }
  };

  private close(): void {
    if (this.settled || this.busy) return;
    this.settled = true;
    document.removeEventListener('keydown', this.onKey, true);
    this.overlay.remove();
  }

  private direction(): Direction {
    if (this.dirRadios.pdf2docx.checked) return 'pdf2docx';
    return this.dirRadios.cmir2docx.checked ? 'cmir2docx' : 'docx2cmir';
  }
  private output(): Output {
    return this.outRadios.zip.checked ? 'zip' : 'files';
  }

  private render(): void {
    const header = document.createElement('header');
    header.className = 'pmd-bulk-header';
    const h = document.createElement('h2');
    h.textContent = 'Bulk convert';
    header.appendChild(h);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'pmd-bulk-close';
    setIcon(close, 'close');
    close.title = 'Close';
    close.addEventListener('click', () => this.close());
    header.appendChild(close);
    this.dialog.appendChild(header);

    const body = document.createElement('div');
    body.className = 'pmd-bulk-body';

    // Direction. Changing it invalidates a picked input (the source
    // extension changes), so clear it.
    this.dirRadios = {
      docx2cmir: radio('pmd-bulk-dir', '.docx → .cmir', true),
      cmir2docx: radio('pmd-bulk-dir', '.cmir → .docx', false),
      pdf2docx: radio('pmd-bulk-dir', '.pdf → .docx (Verbatim or CardMirror PDFs)', false),
    };
    const dirs = [this.dirRadios.docx2cmir, this.dirRadios.cmir2docx, this.dirRadios.pdf2docx];
    for (const r of dirs) {
      r.addEventListener('change', () => {
        this.inputSel = null;
        this.refresh();
      });
    }
    body.appendChild(fieldset('Direction', dirs));

    // Output form.
    this.outRadios = {
      files: radio('pmd-bulk-out', 'Save as files', true),
      zip: radio('pmd-bulk-out', 'Save as a single .zip', false),
    };
    body.appendChild(fieldset('Output', [this.outRadios.files, this.outRadios.zip]));

    // Input.
    const inField = document.createElement('div');
    inField.className = 'pmd-bulk-field';
    const inLabel = document.createElement('div');
    inLabel.className = 'pmd-bulk-field-label';
    inLabel.textContent = 'Input';
    inField.appendChild(inLabel);
    const inBtns = document.createElement('div');
    inBtns.className = 'pmd-bulk-pickrow';
    inBtns.append(
      button('Choose file…', () => void this.pickFile()),
      button('Choose folder…', () => void this.pickFolder()),
    );
    inField.appendChild(inBtns);
    this.inputPathEl = document.createElement('div');
    this.inputPathEl.className = 'pmd-bulk-path';
    inField.appendChild(this.inputPathEl);
    body.appendChild(inField);

    // Destination.
    const outField = document.createElement('div');
    outField.className = 'pmd-bulk-field';
    const outLabel = document.createElement('div');
    outLabel.className = 'pmd-bulk-field-label';
    outLabel.textContent = 'Destination';
    outField.appendChild(outLabel);
    const outBtns = document.createElement('div');
    outBtns.className = 'pmd-bulk-pickrow';
    outBtns.append(button('Choose destination…', () => void this.pickDestination()));
    outField.appendChild(outBtns);
    this.outputPathEl = document.createElement('div');
    this.outputPathEl.className = 'pmd-bulk-path';
    outField.appendChild(this.outputPathEl);
    body.appendChild(outField);

    // Convert.
    const actions = document.createElement('div');
    actions.className = 'pmd-bulk-actions';
    this.convertBtn = button('Convert', () => void this.run());
    this.convertBtn.classList.add('pmd-bulk-btn-primary');
    actions.appendChild(this.convertBtn);
    body.appendChild(actions);

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'pmd-bulk-status';
    body.appendChild(this.statusEl);

    this.dialog.appendChild(body);
    this.refresh();
  }

  /** Update the path displays + the Convert button's enabled state. */
  private refresh(): void {
    this.inputPathEl.textContent = this.inputSel
      ? `${this.inputSel.kind === 'folder' ? 'Folder' : 'File'}: ${this.inputSel.path}`
      : 'None selected';
    this.inputPathEl.classList.toggle('pmd-bulk-path-set', !!this.inputSel);
    this.outputPathEl.textContent = this.outputDir ? this.outputDir : 'None selected';
    this.outputPathEl.classList.toggle('pmd-bulk-path-set', !!this.outputDir);
    this.convertBtn.disabled = this.busy || !this.inputSel || !this.outputDir;
  }

  private setBusy(on: boolean): void {
    this.busy = on;
    this.dialog.classList.toggle('pmd-bulk-busy', on);
    this.refresh();
  }

  private setStatus(msg: string): void {
    this.statusEl.textContent = msg;
  }

  // ── Pickers ───────────────────────────────────────────────────────

  private async pickFile(): Promise<void> {
    const srcExt = sourceExt(this.direction());
    const opened = await getHost().openFile({
      filters: [{ name: `.${srcExt}`, extensions: [srcExt] }],
    });
    if (!opened || typeof opened.handle !== 'string') return;
    this.inputSel = { kind: 'file', path: opened.handle, name: opened.name, bytes: opened.bytes };
    this.refresh();
  }

  private async pickFolder(): Promise<void> {
    const electron = getElectronHost();
    if (!electron) return;
    const folder = await electron.pickDirectory({ title: 'Choose a folder to convert' });
    if (!folder) return;
    this.inputSel = { kind: 'folder', path: folder, name: baseName(folder) };
    this.refresh();
  }

  private async pickDestination(): Promise<void> {
    const electron = getElectronHost();
    if (!electron) return;
    const dest = await electron.pickDirectory({ title: 'Choose a destination folder' });
    if (!dest) return;
    this.outputDir = dest;
    this.refresh();
  }

  // ── Convert ───────────────────────────────────────────────────────

  private async run(): Promise<void> {
    if (this.busy || !this.inputSel || !this.outputDir) return;
    const electron = getElectronHost();
    if (!electron) {
      this.setStatus('Bulk convert requires the desktop edition.');
      return;
    }
    const dir = this.direction();
    const out = this.output();
    const dest = this.outputDir;
    const input = this.inputSel;
    this.setBusy(true);
    try {
      if (input.kind === 'file') {
        this.setStatus(`Converting ${input.name}…`);
        const converted = await convertBytes(input.bytes!, dir);
        if (out === 'zip') {
          const bytes = zipSync({ [swapExt(input.name, dir)]: converted });
          await electron.writeFileAtPath(joinPath(dest, `${baseNoExt(input.name)}.zip`), bytes);
        } else {
          await electron.writeFileAtPath(joinPath(dest, swapExt(input.name, dir)), converted);
        }
        this.setStatus(`Converted “${input.name}”.`);
      } else {
        const srcExt = sourceExt(dir);
        this.setStatus('Scanning…');
        const files = await electron.listFilesRecursive(input.path, srcExt);
        if (files.length === 0) {
          this.setStatus(`No .${srcExt} files found in that folder.`);
          return;
        }
        const zipParts: Record<string, Uint8Array> | null = out === 'zip' ? {} : null;
        let ok = 0;
        let failed = 0;
        let firstError = '';
        for (let i = 0; i < files.length; i++) {
          const f = files[i]!;
          this.setStatus(`Converting ${i + 1} / ${files.length}…`);
          try {
            const read = await electron.readFileAtPath(f.path);
            if (!read) throw new Error('unreadable');
            const converted = await convertBytes(read.bytes, dir);
            const rel = swapExt(f.relPath, dir);
            if (zipParts) zipParts[rel.replace(/\\/g, '/')] = converted;
            else await electron.writeFileAtPath(joinPath(dest, rel), converted);
            ok++;
          } catch (err) {
            failed++;
            if (!firstError) firstError = `${f.relPath}: ${err instanceof Error ? err.message : String(err)}`;
            console.error('Bulk convert failed for', f.path, err);
          }
        }
        if (zipParts && ok > 0) {
          const bytes = zipSync(zipParts);
          await electron.writeFileAtPath(joinPath(dest, `${input.name}.zip`), bytes);
        }
        this.setStatus(
          `Done — ${ok} converted${failed ? `, ${failed} failed (first: ${firstError})` : ''}.`,
        );
      }
    } catch (err) {
      this.setStatus(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.setBusy(false);
    }
  }
}

// ── Small DOM helpers ────────────────────────────────────────────────

function radio(name: string, label: string, checked: boolean): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = name;
  input.checked = checked;
  (input as HTMLInputElement & { _label?: string })._label = label;
  return input;
}

function fieldset(legend: string, radios: HTMLInputElement[]): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-bulk-field';
  const lg = document.createElement('div');
  lg.className = 'pmd-bulk-field-label';
  lg.textContent = legend;
  wrap.appendChild(lg);
  for (const input of radios) {
    const row = document.createElement('label');
    row.className = 'pmd-bulk-radio';
    const text = document.createElement('span');
    text.textContent = (input as HTMLInputElement & { _label?: string })._label ?? '';
    row.append(input, text);
    wrap.appendChild(row);
  }
  return wrap;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'pmd-bulk-btn';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

export function openBulkConvert(): void {
  new BulkConvertModal();
}

/** Web single-file Convert: pick one `.docx` or `.cmir` and Save-As it in the
 *  other format, or a `.pdf` and Save-As it as `.docx` (direction inferred from
 *  the input's extension). The web edition
 *  can't do the desktop folder-recursive batch, so it works one file at a time. */
export function runConvertSingleFileWeb(): Promise<void> {
  return runWebFileTool({
    label: 'Convert',
    verb: 'Converting',
    accept: /\.(docx|cmir|pdf)$/i,
    acceptMsg: 'Convert works on .docx, .cmir or .pdf files — please choose one.',
    run: async (bytes, name) => {
      const dir: Direction = /\.docx$/i.test(name) ? 'docx2cmir' : /\.pdf$/i.test(name) ? 'pdf2docx' : 'cmir2docx';
      const ext = dir === 'docx2cmir' ? 'cmir' : 'docx';
      return {
        bytes: await convertBytes(bytes, dir),
        outputName: swapExt(name, dir),
        filter: {
          name: ext === 'cmir' ? 'CardMirror document' : 'Word document',
          extensions: [ext],
        },
      };
    },
  });
}
