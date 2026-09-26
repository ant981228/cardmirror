/**
 * Save As → PDF.
 *
 * The export doc (after the Save As preset's transforms — Send Doc, Read
 * Doc, Marked Doc, Custom) is serialized through the schema's own DOM with
 * the clipboard's frozen styles (clipboard-styles.ts): every `pmd-*` class
 * gets the look it has in the editor written inline, in the light palette,
 * so the page needs no app stylesheet. Images are already data: URIs.
 * That page is then printed: on the desktop by main in a hidden window
 * (`host:html-to-pdf`, straight to a file), on the web through the
 * browser's print dialog, where "Save as PDF" is a destination.
 */

import { DOMSerializer, type Node as PMNode } from 'prosemirror-model';
import { schema } from '../schema/index.js';
import { withFrozenStyles } from './clipboard-styles.js';
import { settings } from './settings.js';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A complete, self-contained HTML page for `doc`, ready to print. */
export function buildPrintHtml(doc: PMNode, title: string): string {
  const serializer = withFrozenStyles(DOMSerializer.fromSchema(schema));
  const body = document.createElement('div');
  body.appendChild(serializer.serializeFragment(doc.content, { document }));
  const font = settings.get('bodyFont').replace(/["<>]/g, '');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  @page { margin: 0.75in; }
  html, body { background: #fff; color: #000; }
  body {
    margin: 0;
    font-family: "${font}", Calibri, Arial, sans-serif;
    font-size: 11pt;
    /* Highlights and shading are backgrounds — print them. */
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  h1, h2, h3, h4 { break-after: avoid; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; }
  td, th { border: 1px solid #999; padding: 2px 4px; vertical-align: top; }
</style>
</head>
<body>${body.innerHTML}</body>
</html>`;
}

/** Web edition: open the browser's print dialog on `html` (its "Save as
 *  PDF" destination writes the file). Resolves once the dialog is up —
 *  the browser owns the save from there, so there is no result to report. */
export function printHtmlInBrowser(html: string): Promise<void> {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
    frame.addEventListener(
      'load',
      () => {
        const win = frame.contentWindow;
        if (!win) {
          frame.remove();
          resolve();
          return;
        }
        win.addEventListener('afterprint', () => frame.remove(), { once: true });
        win.focus();
        win.print();
        resolve();
      },
      { once: true },
    );
    frame.srcdoc = html;
    document.body.appendChild(frame);
  });
}
