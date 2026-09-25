/**
 * .docx zip read/write helpers.
 *
 * A .docx is a zip with a specific file layout:
 *   [Content_Types].xml          — declares MIME types per part
 *   _rels/.rels                  — top-level relationships
 *   word/document.xml            — the actual document content
 *   word/styles.xml              — style definitions
 *   word/_rels/document.xml.rels — document part relationships
 *   word/settings.xml            — editor settings
 *   word/fontTable.xml           — fonts referenced
 *   word/webSettings.xml, etc.   — optional
 *
 * For our v0 we emit a minimal but valid set: document.xml + styles.xml +
 * the boilerplate Content_Types + rels files. Anything more elaborate
 * (themes, fonts, settings) we copy through if present in an input zip
 * but don't generate from scratch.
 */

import { unzipSync, zipSync } from 'fflate';
import { canonicalStylesXml } from './styles.js';
import { XML_PROLOG, escText } from './xml.js';

const utf8Decoder = new TextDecoder('utf-8');
const utf8Encoder = new TextEncoder();

/** Loaded docx — an in-memory zip we can read parts from and modify.
 *
 *  Backed by fflate (the same DEFLATE the `.cmir` codec uses) over a
 *  part-name → bytes Map. Insertion order is preserved through
 *  `toBuffer`, so a loaded file re-serializes with its original part
 *  order. Reads/writes are synchronous internally; the async method
 *  signatures are part of the public API. */
export class Docx {
  private constructor(private parts: Map<string, Uint8Array>) {}

  /** Load a .docx from a Uint8Array (Node Buffer / browser ArrayBuffer-derived). */
  static async load(bytes: Uint8Array | ArrayBuffer): Promise<Docx> {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const entries = unzipSync(u8);
    const parts = new Map<string, Uint8Array>();
    for (const [path, data] of Object.entries(entries)) {
      // Skip explicit directory entries — parts are files; consumers
      // (`paths()` copy-through, media enumeration) expect file paths.
      if (path.endsWith('/')) continue;
      parts.set(path, data);
    }
    return new Docx(parts);
  }

  /** Construct a fresh, minimal .docx with the canonical style block.
   *  `defaultFont` becomes the literal docDefaults font — read only by
   *  theme-blind converters (previews); Word resolves the theme
   *  attributes instead (see canonicalStylesXml). */
  static empty(opts?: { defaultFont?: string }): Docx {
    const docx = new Docx(new Map());
    docx.writeText('[Content_Types].xml', CONTENT_TYPES_XML);
    docx.writeText('_rels/.rels', TOP_LEVEL_RELS_XML);
    docx.writeText('word/styles.xml', canonicalStylesXml(opts?.defaultFont));
    docx.writeText('word/_rels/document.xml.rels', DOCUMENT_RELS_XML);
    docx.writeText('word/document.xml', EMPTY_DOCUMENT_XML);
    // Verbatim-recognition surface: <w:attachedTemplate> in
    // word/settings.xml with a Target ending in "/Debate.dotm" makes
    // Verbatim's per-doc visibility callback
    // (Ribbon.GetRibbonVisibility, registered on every group in
    // customUI14.xml) return True, so the Debate ribbon activates
    // when a Verbatim user opens our export without clicking
    // "Verbatimize" first. Verified experimentally: Word doesn't
    // validate that a file exists at the stored path, it
    // basename-matches the URI, and Windows and Mac Verbatim
    // installs read the same XML shape. The methodology for
    // re-deriving this if Verbatim's recognition ever shifts lives
    // in `reference-docs/experiment-verbatimize.mjs` (gitignored
    // local diagnostic).
    docx.writeText('word/settings.xml', SETTINGS_XML);
    docx.writeText('word/_rels/settings.xml.rels', SETTINGS_RELS_XML);
    return docx;
  }

  /** Read a part as a string. */
  async readText(path: string): Promise<string | null> {
    const bytes = this.parts.get(path);
    if (!bytes) return null;
    return utf8Decoder.decode(bytes);
  }

  /** Write or overwrite a part. */
  writeText(path: string, content: string): void {
    this.parts.set(path, utf8Encoder.encode(content));
  }

  /** Read a part as raw bytes. */
  async readBinary(path: string): Promise<Uint8Array | null> {
    return this.parts.get(path) ?? null;
  }

  /** Write or overwrite a binary part. */
  writeBinary(path: string, bytes: Uint8Array): void {
    this.parts.set(path, bytes);
  }

  /** Insert one or more `<Override>` entries into the
   *  `[Content_Types].xml` part. Used by `toDocx` to declare any
   *  optional parts beyond the baseline (comments.xml,
   *  commentsExtended.xml, etc.). */
  async addContentTypeOverrides(overrides: { partName: string; contentType: string }[]): Promise<void> {
    if (overrides.length === 0) return;
    const ct = await this.readText('[Content_Types].xml');
    if (!ct) return;
    const additions = overrides
      .map((o) => `<Override PartName="${o.partName}" ContentType="${o.contentType}"/>`)
      .join('');
    const updated = ct.replace('</Types>', `${additions}</Types>`);
    this.writeText('[Content_Types].xml', updated);
  }

  /** Write the CardMirror `docId` as a custom document property
   *  (`docProps/custom.xml`) — verified to survive a real Word round-trip. */
  async writeDocId(docId: string): Promise<void> {
    await this.writeCustomProperty('cmirDocId', docId);
  }

  /** Write one string-valued custom document property
   *  (`docProps/custom.xml`). Adds the part, its content-type override,
   *  and a package relationship the first time. Merges into an existing
   *  `custom.xml`, replacing any prior property of the same name while
   *  preserving other custom properties the user or Word set. */
  async writeCustomProperty(name: string, value: string): Promise<void> {
    const prop = (pid: number): string =>
      `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="${pid}" name="${escText(name)}"><vt:lpwstr>${escText(value)}</vt:lpwstr></property>`;
    const existing = await this.readText('docProps/custom.xml');
    let propsXml: string;
    if (existing && existing.includes('<Properties')) {
      // Drop any prior property of this name, then append ours with a
      // fresh pid that doesn't collide with the surviving properties' pids.
      const stripped = existing.replace(
        new RegExp(`<property\\b[^>]*\\bname="${name}"[^>]*>[\\s\\S]*?<\\/property>`),
        '',
      );
      const pids = [...stripped.matchAll(/\bpid="(\d+)"/g)].map((m) => Number(m[1]));
      const nextPid = (pids.length ? Math.max(...pids) : 1) + 1;
      propsXml = stripped.replace('</Properties>', `${prop(nextPid)}</Properties>`);
    } else {
      propsXml = `${XML_PROLOG}
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">${prop(2)}</Properties>`;
    }
    this.writeText('docProps/custom.xml', propsXml);

    const ct = await this.readText('[Content_Types].xml');
    if (ct && !ct.includes('docProps/custom.xml')) {
      this.writeText(
        '[Content_Types].xml',
        ct.replace(
          '</Types>',
          '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>',
        ),
      );
    }

    const rels = await this.readText('_rels/.rels');
    if (rels && !rels.includes('custom-properties')) {
      const ids = [...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
      const nextId = `rId${(ids.length ? Math.max(...ids) : 0) + 1}`;
      this.writeText(
        '_rels/.rels',
        rels.replace(
          '</Relationships>',
          `<Relationship Id="${nextId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/></Relationships>`,
        ),
      );
    }
  }

  /** Read the CardMirror `docId` custom property, or null if absent. */
  async readDocId(): Promise<string | null> {
    return this.readCustomProperty('cmirDocId');
  }

  /** Read one string-valued custom document property, or null. */
  async readCustomProperty(name: string): Promise<string | null> {
    const xml = await this.readText('docProps/custom.xml');
    if (!xml) return null;
    const m = xml.match(new RegExp(`name="${name}"[^>]*>\\s*<vt:lpwstr>([^<]*)<\\/vt:lpwstr>`));
    return m ? m[1]! : null;
  }

  /** Stamp who wrote the file, invisibly: `Application` + `AppVersion`
   *  in `docProps/app.xml` (the standard generator fields — Word shows
   *  them nowhere and overwrites both on its own save, so they mean
   *  "last written by"), plus the `cmirGenerator` custom property, which
   *  Word preserves, so "made by CardMirror at some point" survives a
   *  Word round-trip. Merges into an existing app.xml (a Word-authored
   *  file re-saved here keeps its page counts and the like); creates the
   *  part, its content type and its package relationship otherwise. */
  async writeGenerator(application: string, version: string): Promise<void> {
    const appVersion = wordAppVersion(version);
    const existing = await this.readText('docProps/app.xml');
    let xml: string;
    if (existing && existing.includes('<Properties')) {
      xml = setPropertyElement(
        setPropertyElement(existing, 'Application', escText(application)),
        'AppVersion',
        appVersion,
      );
    } else {
      xml = `${XML_PROLOG}
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>${escText(application)}</Application><AppVersion>${appVersion}</AppVersion></Properties>`;
    }
    this.writeText('docProps/app.xml', xml);

    const ct = await this.readText('[Content_Types].xml');
    if (ct && !ct.includes('docProps/app.xml')) {
      this.writeText(
        '[Content_Types].xml',
        ct.replace(
          '</Types>',
          '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>',
        ),
      );
    }
    const rels = await this.readText('_rels/.rels');
    if (rels && !rels.includes('relationships/extended-properties')) {
      const ids = [...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
      const nextId = `rId${(ids.length ? Math.max(...ids) : 0) + 1}`;
      this.writeText(
        '_rels/.rels',
        rels.replace(
          '</Relationships>',
          `<Relationship Id="${nextId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
        ),
      );
    }
    await this.writeCustomProperty('cmirGenerator', `${application} ${version}`);
  }

  /** Serialize the zip to bytes. */
  async toBuffer(): Promise<Uint8Array> {
    return zipSync(Object.fromEntries(this.parts), { level: 6 });
  }

  /** List all part paths in the zip. */
  paths(): string[] {
    return [...this.parts.keys()];
  }
}

/** Word's `AppVersion` is validated as `NN.NNNN` (Word writes "16.0000");
 *  a free-form "1.13.0" there has made Word flag files as damaged. Encode
 *  a semver as major.minor+patch, two digits each: 1.13.0 → "01.1300".
 *  Anything unparsable becomes "00.0000". Exported for the tests. */
export function wordAppVersion(version: string): string {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
  if (!m) return '00.0000';
  const two = (s: string | undefined): string => String(Math.min(99, Number(s ?? 0))).padStart(2, '0');
  return `${two(m[1])}.${two(m[2])}${two(m[3])}`;
}

/** Replace the text of `<tag>…</tag>` (or an empty `<tag/>`) in an
 *  app.xml, appending the element when absent. The schema's property
 *  set is unordered, so appending is valid. */
function setPropertyElement(xml: string, tag: string, value: string): string {
  const full = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>|<${tag}(?:\\s[^>]*)?/>`);
  const el = `<${tag}>${value}</${tag}>`;
  return full.test(xml) ? xml.replace(full, el) : xml.replace('</Properties>', `${el}</Properties>`);
}

// -------- Boilerplate XML for fresh docx --------

const CONTENT_TYPES_XML = `${XML_PROLOG}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Default Extension="gif" ContentType="image/gif"/>
  <Default Extension="bmp" ContentType="image/bmp"/>
  <Default Extension="svg" ContentType="image/svg+xml"/>
  <Default Extension="webp" ContentType="image/webp"/>
  <Default Extension="tif" ContentType="image/tiff"/>
  <Default Extension="tiff" ContentType="image/tiff"/>
  <Default Extension="emf" ContentType="image/x-emf"/>
  <Default Extension="wmf" ContentType="image/x-wmf"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
</Types>`;

const TOP_LEVEL_RELS_XML = `${XML_PROLOG}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCUMENT_RELS_XML = `${XML_PROLOG}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const EMPTY_DOCUMENT_XML = `${XML_PROLOG}
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14">
  <w:body>
    <w:p/>
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;

// `word/settings.xml` — two payloads:
//
//  - The minimum Verbatim-recognition element, <w:attachedTemplate>.
//    Its r:id resolves against `word/_rels/settings.xml.rels`, NOT
//    document.xml.rels — an easy mix-up.
//  - <w:compat> declaring compatibilityMode 15. Word treats a file
//    with no declared mode as Word-2007-era (val 12) and opens it in
//    Compatibility Mode: "[Compatibility Mode]" in the title bar, the
//    modern margin-comments UI disabled, and a File → Convert prompt
//    whose re-save subtly reflows the document. 15 marks the file as
//    modern docx — the same mode every Word-authored and
//    Verbatim-template document already uses.
//
// ORDER CONSTRAINT: CT_Settings is a schema-ordered sequence, and
// w:compat must come AFTER w:attachedTemplate — Word rejects the whole
// package as unreadable when settings children are out of sequence.
const SETTINGS_XML = `${XML_PROLOG}
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:attachedTemplate r:id="rId1"/>
  <w:compat>
    <w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>
  </w:compat>
</w:settings>`;

// `word/_rels/settings.xml.rels` — Verbatim's `GetRibbonVisibility`
// callback checks `ActiveDocument.AttachedTemplate.Name`. Word
// reads the basename of the Target URI for this property; it
// doesn't validate that a file actually exists at the path. So a
// minimal URI ending in `/Debate.dotm` makes the recognition check
// pass on any user's machine, regardless of where (or whether)
// they have Debate.dotm installed. `TargetMode="External"` tells
// Word the Target is a file-system reference, not an in-package
// part.
const SETTINGS_RELS_XML = `${XML_PROLOG}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="file:///Debate.dotm" TargetMode="External"/></Relationships>`;
