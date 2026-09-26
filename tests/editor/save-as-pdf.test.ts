// @vitest-environment jsdom
/**
 * Save As → PDF: the dialog offers PDF only where the caller can handle a
 * PDF result (the explicit Save As — never crash recovery or a close
 * prompt), and the printable page is self-contained: the frozen inline
 * styles carry the look (highlights as backgrounds), nothing scripts,
 * and the title is escaped.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { openSaveAs } from '../../src/editor/save-as-ui.js';
import { buildPrintHtml } from '../../src/editor/pdf-export.js';

afterEach(() => {
  document.body.innerHTML = '';
});

const formatRadio = (id: string): HTMLInputElement | null =>
  document.querySelector<HTMLInputElement>(`.pmd-save-as-format input[value="${id}"]`);
const filenameInput = (): HTMLInputElement =>
  document.querySelector<HTMLInputElement>('.pmd-save-as-dialog input[type="text"]')!;
const submit = (): void => {
  document.querySelector('form.pmd-save-as-body')!.dispatchEvent(new Event('submit', { cancelable: true }));
};

describe('Save As dialog: PDF format', () => {
  it('is not offered unless the caller allows it', async () => {
    const pending = openSaveAs({ initialFilename: 'doc', defaultFormat: 'cmir' });
    expect(formatRadio('cmir')).not.toBeNull();
    expect(formatRadio('pdf')).toBeNull();
    submit();
    expect((await pending)?.format).toBe('cmir');
  });

  it('with allowPdf, picking PDF swaps the extension and returns format pdf', async () => {
    const pending = openSaveAs({ initialFilename: 'Warming Aff', defaultFormat: 'docx', allowPdf: true });
    expect(filenameInput().value).toBe('Warming Aff.docx');
    const pdf = formatRadio('pdf')!;
    pdf.checked = true;
    pdf.dispatchEvent(new Event('change'));
    expect(filenameInput().value).toBe('Warming Aff.pdf');
    submit();
    const result = await pending;
    expect(result?.format).toBe('pdf');
    expect(result?.filename).toBe('Warming Aff.pdf');
  });
});

describe('buildPrintHtml', () => {
  const mark = (name: string, attrs?: Record<string, unknown>) => schema.marks[name]!.create(attrs);
  const doc = schema.nodes['doc']!.createChecked(null, [
    schema.nodes['card']!.createChecked(null, [
      schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('Warming is real')),
      schema.nodes['card_body']!.create(null, [
        schema.text('plain '),
        schema.text('read this', [mark('highlight', { color: 'yellow' })]),
      ]),
    ]),
  ]);

  it('is a complete page carrying the doc text', () => {
    const html = buildPrintHtml(doc, 'Aff');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>Aff</title>');
    expect(html).toContain('Warming is real');
    expect(html).toContain('read this');
  });

  it('inlines the highlight as a background and asks the printer to keep it', () => {
    const html = buildPrintHtml(doc, 'Aff');
    expect(html).toMatch(/background(-color)?:\s*(#ffff00|rgb\(255, 255, 0\))/i);
    expect(html).toContain('print-color-adjust: exact');
  });

  it('escapes the title and never emits a script', () => {
    const html = buildPrintHtml(doc, '<script>alert(1)</script>');
    expect(html).toContain('<title>&lt;script&gt;alert(1)&lt;/script&gt;</title>');
    expect(html).not.toMatch(/<script/i);
  });
});
