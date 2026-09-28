/**
 * Opening a PDF: convertPdf returns the converted document (inline here —
 * no Worker in the test host) and turns the converter's refusals into a
 * PdfOpenError carrying its user-facing message.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { convertPdf, PdfOpenError, bytesLookLikePdf } from '../../src/editor/pdf-open.js';

const fixture = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../import/fixtures/pdf/verbatim-word.pdf', import.meta.url))),
);

describe('convertPdf', () => {
  it('converts a debate PDF into a document', async () => {
    const doc = await convertPdf(fixture);
    expect(doc.firstChild?.type.name).toBe('pocket');
    expect(doc.textContent).toContain('Single payer saves money');
  });

  it('reports a refusal as PdfOpenError with the reason', async () => {
    const scan = new TextEncoder().encode(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
        '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R>>endobj\n' +
        '4 0 obj<</Length 20>>stream\n0 0 100 100 re f\nendstream endobj\ntrailer<</Root 1 0 R>>\n%%EOF',
    );
    await expect(convertPdf(scan)).rejects.toBeInstanceOf(PdfOpenError);
    await expect(convertPdf(scan)).rejects.toThrow(/no readable text/);
  });
});

describe('bytesLookLikePdf', () => {
  it('knows a PDF by its header, not a docx or cmir', () => {
    expect(bytesLookLikePdf(fixture)).toBe(true);
    expect(bytesLookLikePdf(new Uint8Array([0x50, 0x4b, 3, 4]))).toBe(false);
    expect(bytesLookLikePdf(new TextEncoder().encode('{"format":"cmir"}'))).toBe(false);
  });
});
