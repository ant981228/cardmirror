/**
 * PDF import: a debate document exported to PDF converts back into the same
 * structure (headings, cards, cites, analytics) and card formatting
 * (Underline, Emphasis, highlight colors, cite text) as the source.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Node as PMNode } from 'prosemirror-model';
import { pdfToDoc, PdfImportError } from '../../src/import/pdf/index.js';
import { buildDebateFixture } from './fixtures/pdf/debate-fixture.js';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/pdf/${name}`, import.meta.url))));

/** [node type, text] for every textblock, with its container's type. */
function shape(doc: PMNode): string[] {
  const out: string[] = [];
  doc.descendants((node, _pos, parent) => {
    if (!node.isTextblock) return true;
    const where = parent && parent.type.name !== 'doc' ? `${parent.type.name}/` : '';
    out.push(`${where}${node.type.name}: ${node.textContent.replace(/\s+/g, ' ').trim()}`);
    return false;
  });
  return out;
}

/** The text carrying a mark, per mark (and highlight color), in order. */
function marked(doc: PMNode, mark: string, attr?: string): string[] {
  const runs: string[] = [];
  let cur = '';
  doc.descendants((node) => {
    if (!node.isText) {
      if (node.isTextblock && cur) {
        runs.push(cur.trim());
        cur = '';
      }
      return true;
    }
    const mk = node.marks.find((x) => x.type.name === mark && (!attr || x.attrs['color'] === attr));
    if (mk) cur += node.text;
    else if (cur) {
      runs.push(cur.trim());
      cur = '';
    }
    return false;
  });
  if (cur) runs.push(cur.trim());
  return runs.filter(Boolean);
}

describe.each([
  // Verbatim's heading styles start a new page, so Word's copy is 4 pages.
  ['CardMirror (Chromium) export', 'cardmirror-chromium.pdf', /Skia/, 1],
  ['Verbatim (Word for Mac) export', 'verbatim-word.pdf', /Quartz/, 4],
])('pdfToDoc — %s', (_label, file, producer, pages) => {
  const source = buildDebateFixture();
  const result = pdfToDoc(fixture(file));

  it('recovers the structure: headings, cards, cites, analytic, loose paragraph', () => {
    expect(shape(result.doc)).toEqual(shape(source));
  });

  it('recovers Underline, Emphasis, highlight colors and cite text', () => {
    for (const [mark, attr] of [
      ['underline_mark'],
      ['emphasis_mark'],
      ['cite_mark'],
      ['highlight', 'yellow'],
      ['highlight', 'cyan'],
    ] as const) {
      expect(marked(result.doc, mark, attr), `${mark} ${attr ?? ''}`).toEqual(marked(source, mark, attr));
    }
  });

  it('keeps shrunk card text shrunk', () => {
    const sizes = new Set<number>();
    result.doc.descendants((node) => {
      for (const mk of node.marks) if (mk.type.name === 'font_size') sizes.add(mk.attrs['halfPoints'] as number);
      return true;
    });
    expect([...sizes]).toEqual([16]);
  });

  it('is a valid document and names its producer', () => {
    expect(() => result.doc.check()).not.toThrow();
    expect(result.producer).toMatch(producer);
    expect(result.pages).toBe(pages);
  });
});

describe('pdfToDoc — files it refuses', () => {
  it('rejects a non-PDF with a clear message', () => {
    expect(() => pdfToDoc(new TextEncoder().encode('hello'))).toThrow(PdfImportError);
  });

  it('rejects a PDF with no text layer (a scan)', () => {
    const pdf =
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R>>endobj\n' +
      '4 0 obj<</Length 20>>stream\n0 0 100 100 re f\nendstream endobj\ntrailer<</Root 1 0 R>>\n%%EOF';
    expect(() => pdfToDoc(new TextEncoder().encode(pdf))).toThrow(/no readable text/);
  });

  it('rejects an encrypted PDF', () => {
    const pdf = '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R/Encrypt 5 0 R>>\n%%EOF';
    expect(() => pdfToDoc(new TextEncoder().encode(pdf))).toThrow(/encrypted/);
  });
});
