/**
 * Export public API: schema doc → .docx bytes.
 */

import type { Node as PMNode } from 'prosemirror-model';
import { Docx } from '../ooxml/docx.js';
import { exportDoc, type ExportOptions } from './exporter.js';

export { exportDoc } from './exporter.js';
export type { ExportResult, ExportOptions } from './exporter.js';

/**
 * Serialize a ProseMirror doc to a complete .docx byte buffer, ready
 * to write to disk or send across a wire. Image nodes contribute
 * media parts (binary writes under `word/media/`) tracked alongside
 * the document XML.
 *
 * Pass `opts.threads` to also emit `word/comments.xml` +
 * `word/commentsExtended.xml`; the doc's `comment_range` marks
 * become `<w:commentRangeStart/End>` brackets that Word reads as
 * thread anchors. Without `threads`, the comments parts are
 * omitted and the brackets are stripped from `document.xml`.
 */
export async function toDocx(doc: PMNode, opts: ExportOptions = {}): Promise<Uint8Array> {
  const result = exportDoc(doc, opts);
  const docx = Docx.empty(opts.defaultFont ? { defaultFont: opts.defaultFont } : undefined);
  docx.writeText('word/document.xml', result.documentXml);
  docx.writeText('word/_rels/document.xml.rels', result.relsXml);
  for (const part of result.mediaParts) {
    docx.writeBinary(part.path, part.bytes);
  }
  if (result.numberingXml) {
    docx.writeText('word/numbering.xml', result.numberingXml);
    await docx.addContentTypeOverrides([
      {
        partName: '/word/numbering.xml',
        contentType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml',
      },
    ]);
  }
  if (result.footnotesXml) {
    docx.writeText('word/footnotes.xml', result.footnotesXml);
    if (result.footnotesRelsXml) {
      docx.writeText('word/_rels/footnotes.xml.rels', result.footnotesRelsXml);
    }
    await docx.addContentTypeOverrides([
      {
        partName: '/word/footnotes.xml',
        contentType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
      },
    ]);
  }
  if (result.endnotesXml) {
    docx.writeText('word/endnotes.xml', result.endnotesXml);
    if (result.endnotesRelsXml) {
      docx.writeText('word/_rels/endnotes.xml.rels', result.endnotesRelsXml);
    }
    await docx.addContentTypeOverrides([
      {
        partName: '/word/endnotes.xml',
        contentType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml',
      },
    ]);
  }
  if (result.commentsXml && result.commentsExtendedXml) {
    docx.writeText('word/comments.xml', result.commentsXml);
    docx.writeText('word/commentsExtended.xml', result.commentsExtendedXml);
    await docx.addContentTypeOverrides([
      {
        partName: '/word/comments.xml',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml',
      },
      {
        // The exact string from the Open XML SDK's WordprocessingCommentsExPart —
        // Word validates each part's declared content type against its
        // relationship, and a mismatch here fails the WHOLE package
        // ("unreadable content", recoverable), even though every part's
        // XML is valid. Field report 2026-07-23 (Lily S., mac Word).
        partName: '/word/commentsExtended.xml',
        contentType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml',
      },
    ]);
  }
  // Stable per-document identity for the Learn annotation layer. Written
  // only when the caller supplies one, so doc-id-unaware callers (and the
  // round-trip tests) are unaffected.
  if (opts.docId) {
    await docx.writeDocId(opts.docId);
  }
  // Invisible provenance: app.xml Application/AppVersion + the
  // cmirGenerator custom property. Caller-supplied so core stays free of
  // the app's version and the round-trip tests are byte-stable.
  if (opts.generator) {
    await docx.writeGenerator(opts.generator.application, opts.generator.version);
  }
  return docx.toBuffer();
}
