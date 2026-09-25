/**
 * Invisible provenance in .docx exports (2026-09-25): `docProps/app.xml`
 * Application / AppVersion (Word replaces both on its own save, so they
 * mean "last written by") and the `cmirGenerator` custom property (Word
 * preserves it, so it survives a round-trip). Both are outside the body.
 */

import { describe, expect, it } from 'vitest';
import { schema } from '../../src/schema/index.js';
import { toDocx } from '../../src/export/index.js';
import { fromDocxFull } from '../../src/import/index.js';
import { Docx, wordAppVersion } from '../../src/ooxml/docx.js';

const GEN = { application: 'CardMirror', version: '1.13.0' };

function sampleDoc() {
  return schema.nodes['doc']!.createChecked(null, [
    schema.nodes['paragraph']!.create(null, schema.text('Hello world.')),
  ]);
}

describe('wordAppVersion', () => {
  it('encodes a semver as the NN.NNNN form Word accepts', () => {
    expect(wordAppVersion('1.13.0')).toBe('01.1300');
    expect(wordAppVersion('0.1.0-beta.26')).toBe('00.0100');
    expect(wordAppVersion('12.4')).toBe('12.0400');
    expect(wordAppVersion('garbage')).toBe('00.0000');
  });
});

describe('generator stamp', () => {
  it('a fresh export carries app.xml fields, the custom property, the content type and the relationship', async () => {
    const bytes = await toDocx(sampleDoc(), { generator: GEN, docId: 'doc-1' });
    const docx = await Docx.load(bytes);
    const app = await docx.readText('docProps/app.xml');
    expect(app).toContain('<Application>CardMirror</Application>');
    expect(app).toContain('<AppVersion>01.1300</AppVersion>');
    expect(await docx.readCustomProperty('cmirGenerator')).toBe('CardMirror 1.13.0');
    expect(await docx.readDocId()).toBe('doc-1');
    expect(await docx.readText('[Content_Types].xml')).toContain('/docProps/app.xml');
    expect(await docx.readText('_rels/.rels')).toContain('relationships/extended-properties');
    // Nothing of it lands in the body, and the importer is unbothered.
    expect(await docx.readText('word/document.xml')).not.toContain('CardMirror');
    expect((await fromDocxFull(bytes)).docId).toBe('doc-1');
  });

  it('is absent when no generator is given (byte-stable callers)', async () => {
    const docx = await Docx.load(await toDocx(sampleDoc()));
    expect(await docx.readText('docProps/app.xml')).toBeNull();
    expect(await docx.readCustomProperty('cmirGenerator')).toBeNull();
  });

  it("merges into a Word-authored app.xml, keeping Word's other fields, without duplicating parts", async () => {
    const docx = await Docx.load(await toDocx(sampleDoc(), { generator: GEN }));
    docx.writeText(
      'docProps/app.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Microsoft Office Word</Application><Pages>3</Pages><Company>Acme</Company><AppVersion>16.0000</AppVersion></Properties>',
    );
    await docx.writeGenerator('CardMirror', '1.13.0');
    const app = (await docx.readText('docProps/app.xml'))!;
    expect(app).toContain('<Application>CardMirror</Application>');
    expect(app).toContain('<AppVersion>01.1300</AppVersion>');
    expect(app).not.toContain('Microsoft Office Word');
    expect(app).not.toContain('16.0000');
    expect(app).toContain('<Pages>3</Pages>');
    expect(app).toContain('<Company>Acme</Company>');
    expect((await docx.readText('[Content_Types].xml'))!.split('/docProps/app.xml').length).toBe(2);
    expect((await docx.readText('_rels/.rels'))!.split('relationships/extended-properties').length).toBe(2);
    // Re-stamping the property replaces rather than duplicates it.
    const custom = (await docx.readText('docProps/custom.xml'))!;
    expect(custom.split('name="cmirGenerator"').length).toBe(2);
  });
});
