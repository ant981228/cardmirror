import { describe, expect, it, afterEach } from 'vitest';
import { Schema, type Mark, type Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  serializeNative,
  parseNative,
  parseNativeSalvage,
  NativeDamagedError,
  looksLikeNative,
  setSaveHealListener,
  NATIVE_FILE_EXTENSION,
  type SaveHealReport,
} from '../../src/native/index.js';
import type { Thread } from '../../src/editor/comments-plugin.js';
import { gunzip } from '../../src/native/codec.js';

const { nodes, marks } = schema;

function makeSampleDoc(): PMNode {
  return nodes['doc']!.createChecked(null, [
    nodes['pocket']!.create({ id: newHeadingId() }, schema.text('Pocket title')),
    nodes['card']!.create(null, [
      nodes['tag']!.create({ id: newHeadingId() }, schema.text('Card tag')),
      nodes['cite_paragraph']!.create(null, [
        schema.text('Smith 24', [marks['cite_mark']!.create()]),
        schema.text(', professor, '),
        schema.text('Title', [marks['italic']!.create()]),
      ]),
      nodes['card_body']!.create(null, [
        schema.text('Plain text plus '),
        schema.text('underlined', [marks['underline_mark']!.create()]),
        schema.text(' and '),
        schema.text('highlighted', [marks['highlight']!.create({ color: 'yellow' })]),
        schema.text(' content.'),
      ]),
    ]),
    nodes['paragraph']!.create(null, schema.text('Loose paragraph after the card.')),
  ]);
}

describe('native format (.cmir)', () => {
  it('exposes the canonical extension', () => {
    expect(NATIVE_FILE_EXTENSION).toBe('cmir');
  });

  it('serializes + parses back to a structurally-equal doc', () => {
    const original = makeSampleDoc();
    const bytes = serializeNative(original);
    const { doc, threads } = parseNative(bytes);
    expect(threads).toEqual([]);
    // Compare via toJSON — PMNode.eq cares about marks too and is
    // the right semantic equality check for round-trip.
    expect(doc.toJSON()).toEqual(original.toJSON());
    expect(doc.eq(original)).toBe(true);
  });

  it('writes gzip-compressed bytes (magic 0x1f 0x8b), smaller than the JSON', () => {
    const original = makeSampleDoc();
    const bytes = serializeNative(original);
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
    // The compressed payload is well under the uncompressed JSON size.
    const rawJsonLen = JSON.stringify({
      format: 'cardmirror-doc',
      formatVersion: 1,
      createdBy: 'CardMirror',
      createdAt: '',
      doc: original.toJSON(),
    }).length;
    expect(bytes.length).toBeLessThan(rawJsonLen);
  });

  it('still parses a legacy (uncompressed) .cmir file', () => {
    const original = makeSampleDoc();
    // A pre-compression file: the plaintext envelope, exactly as old
    // builds wrote it (pretty-printed, begins with `{`).
    const legacy = new TextEncoder().encode(
      JSON.stringify(
        {
          format: 'cardmirror-doc',
          formatVersion: 1,
          createdBy: 'CardMirror 0.1.0-alpha.12',
          createdAt: '2026-06-01T00:00:00.000Z',
          doc: original.toJSON(),
        },
        null,
        2,
      ),
    );
    expect(legacy[0]).toBe(0x7b); // `{` — not gzip
    const { doc } = parseNative(legacy);
    expect(doc.eq(original)).toBe(true);
  });

  it('preserves heading IDs', () => {
    const original = makeSampleDoc();
    const bytes = serializeNative(original);
    const { doc } = parseNative(bytes);
    const originalIds: string[] = [];
    original.descendants((n) => {
      const id = n.attrs['id'];
      if (typeof id === 'string' && id) originalIds.push(id);
      return true;
    });
    const roundTripped: string[] = [];
    doc.descendants((n) => {
      const id = n.attrs['id'];
      if (typeof id === 'string' && id) roundTripped.push(id);
      return true;
    });
    expect(roundTripped).toEqual(originalIds);
  });

  it('round-trips threads', () => {
    const original = makeSampleDoc();
    const threads: Thread[] = [
      {
        id: 'thread-1',
        comments: [
          {
            id: 'thread-1',
            author: 'Anthony',
            initials: 'AT',
            date: '2026-05-15T20:00:00.000Z',
            text: 'Solid card',
            kind: 'human',
            parentId: null,
          },
          {
            id: 'thread-1-reply',
            author: 'Coach',
            initials: 'C',
            date: '2026-05-15T20:01:00.000Z',
            text: 'Agree',
            kind: 'human',
            parentId: 'thread-1',
          },
        ],
      },
    ];
    const bytes = serializeNative(original, { threads });
    const parsed = parseNative(bytes);
    expect(parsed.threads).toEqual(threads);
  });

  it('preserves AI comment kind through round-trip', () => {
    // The whole point of the native format vs docx: kind: 'ai'
    // survives. Docx export drops it (Word has no concept).
    const original = makeSampleDoc();
    const threads: Thread[] = [
      {
        id: 't-ai',
        comments: [
          {
            id: 't-ai',
            author: 'AI',
            initials: 'AI',
            date: '2026-05-15T20:00:00.000Z',
            text: 'Synthesis comment',
            kind: 'ai',
            parentId: null,
          },
        ],
      },
    ];
    const bytes = serializeNative(original, { threads });
    const parsed = parseNative(bytes);
    expect(parsed.threads[0]!.comments[0]!.kind).toBe('ai');
  });

  it('refuses non-CardMirror JSON', () => {
    const bytes = new TextEncoder().encode('{"hello": "world"}');
    expect(() => parseNative(bytes)).toThrow(/not a cardmirror file/i);
  });

  it('gives an actionable message for an empty read (undownloaded cloud file)', () => {
    // A Dropbox / iCloud "online only" placeholder reads back as 0 bytes; the
    // message must point at the real cause, not "failed to parse JSON".
    expect(() => parseNative(new Uint8Array())).toThrow(/online only|make it available offline/i);
    expect(() => parseNative(new Uint8Array())).not.toThrow(/parse JSON/i);
  });

  it('refuses non-JSON bytes', () => {
    const bytes = new TextEncoder().encode('plain text, no JSON');
    expect(() => parseNative(bytes)).toThrow(/cardmirror/i);
  });

  it('refuses files from a newer format version', () => {
    const payload = JSON.stringify({
      format: 'cardmirror-doc',
      formatVersion: 99,
      createdBy: 'future-cardmirror',
      createdAt: '2999-01-01T00:00:00.000Z',
      doc: { type: 'doc', content: [] },
    });
    const bytes = new TextEncoder().encode(payload);
    expect(() => parseNative(bytes)).toThrow(/newer than this build/i);
  });

  it('looksLikeNative recognizes valid bytes and rejects others', () => {
    const valid = serializeNative(makeSampleDoc());
    expect(looksLikeNative(valid)).toBe(true);
    expect(looksLikeNative(new TextEncoder().encode('plain text'))).toBe(false);
    expect(looksLikeNative(new TextEncoder().encode('{"other": true}'))).toBe(false);
  });

  // ── Journal envelope round-trip ───────────────────────────────
  // Journals store the doc bytes as serializeNative + a small
  // envelope (uid / filename / handle / format / savedAt). The
  // envelope is platform-specific (Electron writes a JSON file,
  // Browser writes to IndexedDB), but the doc-content round-trip
  // via the native format is the same in both. This test covers
  // that critical path.
  it('round-trips a journal-entry-shaped envelope', () => {
    const original = makeSampleDoc();
    const threads: Thread[] = [
      {
        id: 't-journal',
        comments: [
          {
            id: 't-journal',
            author: 'Anthony',
            initials: 'AT',
            date: '2026-05-15T20:00:00.000Z',
            text: 'mid-edit',
            kind: 'human',
            parentId: null,
          },
        ],
      },
    ];
    // Simulate what a host would store: the doc bytes plus the
    // envelope fields the recovery modal reads.
    const bytes = serializeNative(original, { threads });
    const envelope = {
      uid: 'doc-42',
      filename: 'Aff - Climate.cmir',
      handle: '/Users/example/Documents/Aff - Climate.cmir',
      format: 'cmir' as const,
      savedAt: '2026-05-15T20:00:00.000Z',
      bytes,
    };

    // Pretend the envelope went through a JSON round-trip (Electron
    // writes it as a JSON file, Browser stores in IndexedDB which
    // structured-clones — both preserve the Uint8Array bytes).
    const restored = {
      ...envelope,
      bytes: new Uint8Array(envelope.bytes),
    };

    expect(restored.uid).toBe('doc-42');
    expect(restored.filename).toBe('Aff - Climate.cmir');
    expect(restored.handle).toBe('/Users/example/Documents/Aff - Climate.cmir');
    expect(restored.format).toBe('cmir');

    const parsed = parseNative(restored.bytes);
    expect(parsed.doc.eq(original)).toBe(true);
    expect(parsed.threads).toEqual(threads);
  });

  // ── Heading-id stamping at load ────────────────────────────────
  // Old files (pre-alpha.6) can carry tag/analytic/etc. nodes with
  // `id: null` — synthesized by the F2 schema-fitter bubble-up
  // before that path was closed. An id-less heading is invisible to
  // the nav-pane highlight, so `parseNative` stamps a fresh id at
  // load to repair the doc in place.
  it('stamps a fresh id on a heading whose id is null in the file', () => {
    const payload = JSON.stringify({
      format: 'cardmirror-doc',
      formatVersion: 1,
      createdBy: 'cardmirror-test',
      createdAt: '2026-05-30T00:00:00.000Z',
      doc: {
        type: 'doc',
        content: [
          {
            type: 'card',
            content: [
              { type: 'tag', attrs: { id: null }, content: [{ type: 'text', text: 'orphan' }] },
              { type: 'card_body', content: [{ type: 'text', text: 'body' }] },
            ],
          },
        ],
      },
    });
    const bytes = new TextEncoder().encode(payload);
    const { doc } = parseNative(bytes);
    const tag = doc.firstChild!.firstChild!;
    expect(tag.type.name).toBe('tag');
    const id = tag.attrs['id'];
    expect(typeof id).toBe('string');
    expect(id).toMatch(/[0-9a-f-]{30,}/);
  });

  it('leaves existing heading ids alone (round-trip preserves them)', () => {
    const original = makeSampleDoc();
    const bytes = serializeNative(original);
    const { doc } = parseNative(bytes);
    expect(doc.eq(original)).toBe(true);
  });
});

describe('parseNative structural validation (reject-invalid)', () => {
  // A .cmir reaches this parser with one double-click via the OS file
  // association, and nodeFromJSON builds invalid structure of KNOWN types
  // without complaint — so a crafted/corrupted file must fail cleanly at
  // parse, not load broken state (PR #25 review hardening).
  const envelope = (doc: unknown): Uint8Array =>
    new TextEncoder().encode(
      JSON.stringify({ format: 'cardmirror-doc', formatVersion: 1, doc }),
    );

  it('rejects invalid structure of known types (paragraph inside a card)', () => {
    // NOTE: this example was a tagless card until 2026-07-26, when that
    // shape joined the heal-known-legacy set (healCards). A paragraph is
    // never legal card content and no heal touches it, so it still
    // proves check() guards everything the heals don't.
    const bad = envelope({
      type: 'doc',
      content: [
        {
          type: 'card',
          content: [
            { type: 'tag', attrs: { id: 't-1' }, content: [{ type: 'text', text: 't' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'illegal here' }] },
          ],
        },
      ],
    });
    expect(() => parseNative(bad)).toThrow(/damaged/);
  });

  it('rejects a non-doc top-level node', () => {
    const bad = envelope({ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] });
    expect(() => parseNative(bad)).toThrow(/damaged/);
  });

  it('rejects unknown node types with the same clean error shape', () => {
    const bad = envelope({ type: 'doc', content: [{ type: 'totally-made-up' }] });
    expect(() => parseNative(bad)).toThrow(/damaged/);
  });

  it('still accepts every legacy shape the heal passes exist for', () => {
    // A null heading id (alpha.6-era) heals via stampMissingHeadingIds and
    // must keep loading — check() runs AFTER the heals, not instead.
    const legacy = envelope({
      type: 'doc',
      content: [
        {
          type: 'card',
          content: [
            { type: 'tag', attrs: { id: null }, content: [{ type: 'text', text: 'Tag' }] },
            { type: 'card_body', content: [{ type: 'text', text: 'body' }] },
          ],
        },
      ],
    });
    const parsed = parseNative(legacy);
    expect(parsed.doc.firstChild!.firstChild!.attrs['id']).toBeTruthy();
  });
});

describe('healAnalyticUnits (beta.22 field report: empty analytic_unit)', () => {
  // Files written by older builds can carry analytic_units that violate
  // `analytic (card_body | undertag | cite_paragraph | table)*`. beta.17
  // opened them silently; the beta.21 reject-invalid check refused the
  // whole file ("Invalid content for node analytic_unit: <>"). Known
  // legacy shapes heal losslessly; check() still guards everything else.
  const envelope = (doc: unknown): Uint8Array =>
    new TextEncoder().encode(
      JSON.stringify({ format: 'cardmirror-doc', formatVersion: 1, doc }),
    );
  const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
  const analytic = (text: string) => ({
    type: 'analytic',
    attrs: { id: 'a-1' },
    content: [{ type: 'text', text }],
  });
  const body = (text: string) => ({ type: 'card_body', content: [{ type: 'text', text }] });

  it('drops a completely empty analytic_unit (the reported file shape)', () => {
    const file = envelope({
      type: 'doc',
      content: [para('before'), { type: 'analytic_unit', content: [] }, para('after')],
    });
    const { doc } = parseNative(file);
    expect(doc.childCount).toBe(2);
    expect(doc.textContent).toBe('beforeafter');
  });

  it('floats headless-unit children up to the parent level', () => {
    const file = envelope({
      type: 'doc',
      content: [{ type: 'analytic_unit', content: [body('stranded body')] }],
    });
    const { doc } = parseNative(file);
    expect(doc.firstChild!.type.name).toBe('card_body');
    expect(doc.textContent).toBe('stranded body');
  });

  it('re-heads a mid-tail analytic into its own unit', () => {
    const file = envelope({
      type: 'doc',
      content: [
        {
          type: 'analytic_unit',
          content: [body('floats up'), analytic('the head'), body('absorbed')],
        },
      ],
    });
    const { doc } = parseNative(file);
    expect(doc.childCount).toBe(2);
    expect(doc.child(0).type.name).toBe('card_body');
    const unit = doc.child(1);
    expect(unit.type.name).toBe('analytic_unit');
    expect(unit.childCount).toBe(2);
    expect(unit.firstChild!.type.name).toBe('analytic');
    expect(doc.textContent).toBe('floats upthe headabsorbed');
  });

  it('heals an empty unit inside a live zone too', () => {
    const file = envelope({
      type: 'doc',
      content: [
        {
          type: 'transclusion_ref',
          attrs: { src: 'x.cmir', base: 'doc' },
          content: [para('zone text'), { type: 'analytic_unit', content: [] }],
        },
      ],
    });
    const { doc } = parseNative(file);
    const zone = doc.firstChild!;
    expect(zone.type.name).toBe('transclusion_ref');
    expect(zone.childCount).toBe(1);
    expect(zone.textContent).toBe('zone text');
  });

  it('leaves a well-formed analytic_unit byte-identical', () => {
    const file = envelope({
      type: 'doc',
      content: [{ type: 'analytic_unit', content: [analytic('fine'), body('tail')] }],
    });
    const { doc } = parseNative(file);
    expect(doc.firstChild!.type.name).toBe('analytic_unit');
    expect(doc.firstChild!.childCount).toBe(2);
  });
});

describe('healCards + healTables (2026-07-26 field report: empty card)', () => {
  // Second and third members of the empty-shell family (see
  // healAnalyticUnits above): a hollowed `card` (`tag (…)*`) and
  // hollowed tables (`table_row+`, cells `paragraph+`) turn into
  // "file is damaged" refusals at the beta.21 check. Same treatment:
  // known-legacy shapes heal losslessly, check() guards the rest.
  const envelope = (doc: unknown): Uint8Array =>
    new TextEncoder().encode(
      JSON.stringify({ format: 'cardmirror-doc', formatVersion: 1, doc }),
    );
  const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
  const tag = (text: string) => ({
    type: 'tag',
    attrs: { id: 't-1' },
    content: [{ type: 'text', text }],
  });
  const body = (text: string) => ({ type: 'card_body', content: [{ type: 'text', text }] });

  it('drops a completely empty card (the reported file shape)', () => {
    const file = envelope({
      type: 'doc',
      content: [para('before'), { type: 'card', content: [] }, para('after')],
    });
    const { doc } = parseNative(file);
    expect(doc.childCount).toBe(2);
    expect(doc.textContent).toBe('beforeafter');
  });

  it('floats headless-card children up to the parent level', () => {
    const file = envelope({
      type: 'doc',
      content: [{ type: 'card', content: [body('stranded body')] }],
    });
    const { doc } = parseNative(file);
    expect(doc.firstChild!.type.name).toBe('card_body');
    expect(doc.textContent).toBe('stranded body');
  });

  it('re-heads a mid-tail tag into its own card', () => {
    const file = envelope({
      type: 'doc',
      content: [
        {
          type: 'card',
          content: [tag('first'), body('one'), { ...tag('second'), attrs: { id: 't-2' } }, body('two')],
        },
      ],
    });
    const { doc } = parseNative(file);
    expect(doc.childCount).toBe(2);
    expect(doc.child(0).type.name).toBe('card');
    expect(doc.child(0).textContent).toBe('firstone');
    expect(doc.child(1).type.name).toBe('card');
    expect(doc.child(1).textContent).toBe('secondtwo');
  });

  it('heals an empty card inside a live zone too', () => {
    const file = envelope({
      type: 'doc',
      content: [
        {
          type: 'transclusion_ref',
          attrs: { src: 'x.cmir', base: 'doc' },
          content: [para('zone text'), { type: 'card', content: [] }],
        },
      ],
    });
    const { doc } = parseNative(file);
    const zone = doc.firstChild!;
    expect(zone.childCount).toBe(1);
    expect(zone.textContent).toBe('zone text');
  });

  it('drops an empty table, including one nested in a card', () => {
    const file = envelope({
      type: 'doc',
      content: [
        { type: 'table', content: [] },
        { type: 'card', content: [tag('t'), { type: 'table', content: [] }, body('kept')] },
      ],
    });
    const { doc } = parseNative(file);
    expect(doc.childCount).toBe(1);
    const card = doc.child(0);
    expect(card.childCount).toBe(2); // tag + body; hollow table gone
    expect(card.textContent).toBe('tkept');
  });

  it('fills an empty table cell with an empty paragraph (column count kept)', () => {
    const cell = (text?: string) => ({
      type: 'table_cell',
      content: text === undefined ? [] : [para(text)],
    });
    const file = envelope({
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [{ type: 'table_row', content: [cell('a'), cell(), cell('c')] }],
        },
      ],
    });
    const { doc } = parseNative(file);
    const row = doc.child(0).child(0);
    expect(row.childCount).toBe(3);
    expect(row.child(1).childCount).toBe(1);
    expect(row.child(1).firstChild!.type.name).toBe('paragraph');
  });

  it('leaves a well-formed card byte-identical', () => {
    const file = envelope({
      type: 'doc',
      content: [{ type: 'card', content: [tag('fine'), body('tail')] }],
    });
    const { doc } = parseNative(file);
    expect(doc.firstChild!.type.name).toBe('card');
    expect(doc.firstChild!.childCount).toBe(2);
  });
});

describe('parseNativeSalvage (damaged-file salvage open)', () => {
  const envelope = (doc: unknown): Uint8Array =>
    new TextEncoder().encode(
      JSON.stringify({
        format: 'cardmirror-doc',
        formatVersion: 1,
        doc,
        docId: 'doc-123',
        threads: [],
      }),
    );
  // A paragraph inside a card: invalid, outside every heal — the
  // salvage-only class.
  const damagedDoc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'intro' }] },
      {
        type: 'card',
        content: [
          { type: 'tag', attrs: { id: 't-1' }, content: [{ type: 'text', text: 'kept tag' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'poisoned' }] },
          { type: 'card_body', content: [{ type: 'text', text: 'kept body' }] },
        ],
      },
    ],
  };

  it('parseNative refuses with the typed damaged error', () => {
    let caught: unknown;
    try {
      parseNative(envelope(damagedDoc));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NativeDamagedError);
  });

  it('salvage opens the valid remainder and reports the drops', () => {
    const result = parseNativeSalvage(envelope(damagedDoc));
    expect(() => result.doc.check()).not.toThrow();
    expect(result.doc.textContent).toContain('kept tag');
    expect(result.doc.textContent).toContain('kept body');
    expect(result.doc.textContent).not.toContain('poisoned');
    expect(result.dropped).toEqual([{ type: 'paragraph', textPreview: 'poisoned' }]);
    expect(result.docId).toBe('doc-123'); // metadata preserved
  });

  it('a healthy file salvage-parses with zero drops', () => {
    const clean = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'fine' }] }],
    };
    const result = parseNativeSalvage(envelope(clean));
    expect(result.dropped).toEqual([]);
    expect(result.doc.textContent).toBe('fine');
  });
});

describe('save-time structural tripwire (audit tier 1)', () => {
  // No save path validated anything, so an invalid live doc reached
  // the journal within seconds and the file at the next autosave —
  // the persistence mechanism behind both hollow-shell field
  // incidents. Every serialize now checks, heals known shapes, saves
  // the HEALED bytes, and reports through the injectable listener.
  const hollowCardDoc = () =>
    schema.nodes['doc']!.create(null, [
      schema.nodes['paragraph']!.create(null, schema.text('before')),
      schema.nodes['card']!.create(), // hollow — unchecked construction
      schema.nodes['card']!.createChecked(null, [
        schema.nodes['tag']!.create({ id: 't-keep' }, schema.text('kept tag')),
        schema.nodes['card_body']!.create(null, schema.text('kept body')),
      ]),
    ]);

  afterEach(() => setSaveHealListener(null));

  it('heals an invalid doc at save and reports healed=true', () => {
    const reports: SaveHealReport[] = [];
    setSaveHealListener((r) => reports.push(r));
    const bytes = serializeNative(hollowCardDoc());
    expect(reports).toHaveLength(1);
    expect(reports[0]!.healed).toBe(true);
    expect(reports[0]!.error).toContain('Invalid content for node card');
    // The SAVED bytes are the healed doc: they round-trip cleanly.
    const { doc } = parseNative(bytes);
    expect(doc.textContent).toContain('kept body');
    expect(doc.textContent).toContain('before');
    expect(doc.childCount).toBe(2); // hollow shell dropped at save
  });

  it('a valid doc saves silently — no report', () => {
    const reports: SaveHealReport[] = [];
    setSaveHealListener((r) => reports.push(r));
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['paragraph']!.create(null, schema.text('clean')),
    ]);
    const bytes = serializeNative(doc);
    expect(reports).toHaveLength(0);
    expect(parseNative(bytes).doc.textContent).toBe('clean');
  });

  it('an unhealable doc still saves (original bytes) and reports healed=false', () => {
    const reports: SaveHealReport[] = [];
    setSaveHealListener((r) => reports.push(r));
    // A paragraph inside a card — invalid, and outside the heal set.
    const doc = schema.nodes['doc']!.create(null, [
      schema.nodes['card']!.create(null, [
        schema.nodes['tag']!.create({ id: 't-1' }, schema.text('t')),
        schema.nodes['paragraph']!.create(null, schema.text('illegal')),
      ]),
    ]);
    const bytes = serializeNative(doc);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.healed).toBe(false);
    // Saving must never be refused; load-time still rejects the shape
    // exactly as it would have before the tripwire existed.
    expect(bytes.length).toBeGreaterThan(0);
    expect(() => parseNative(bytes)).toThrow(/damaged/);
  });
});

describe('live reference data is written only while linked', () => {
  /** The pre-live-reference schema: no anchor mark, legacy self_ref attrs only. */
  function olderBuildSchema(): Schema {
    const selfRef = schema.spec.nodes.get('self_ref')!;
    const attrs = selfRef.attrs!;
    return new Schema({
      nodes: schema.spec.nodes.update('self_ref', {
        ...selfRef,
        attrs: { source_heading_id: attrs['source_heading_id']!, source_label: attrs['source_label']! },
      }),
      marks: schema.spec.marks.remove('live_reference_source'),
    });
  }

  function savedDocJson(doc: PMNode): unknown {
    const envelope: unknown = JSON.parse(new TextDecoder().decode(gunzip(serializeNative(doc))));
    if (!envelope || typeof envelope !== 'object' || !('doc' in envelope)) throw new Error('no doc in envelope');
    return envelope.doc;
  }

  function docWithAnchor(ids: string, sizes: string, refs: PMNode[]): PMNode {
    const anchor = schema.marks['live_reference_source']!.create({ ids, sizes });
    return schema.nodes['doc']!.createChecked(null, [
      schema.nodes['card']!.create(null, [
        schema.nodes['tag']!.create({ id: 'tag-1' }, schema.text('Tag')),
        schema.nodes['cite_paragraph']!.create(null, schema.text('Smith 24')),
        schema.nodes['card_body']!.create(null, [schema.text('before '), schema.text('selected', [anchor])]),
      ]),
      ...refs,
    ]);
  }

  it('an unlinked anchor and a heading window save in a form older builds open', () => {
    const headingWindow = schema.nodes['self_ref']!.create({ source_heading_id: 'tag-1', source_label: '↳ Tag' });
    const doc = docWithAnchor('orphan', '{"orphan":11}', [headingWindow]);
    const json = savedDocJson(doc);
    expect(JSON.stringify(json)).not.toContain('live_reference_source');
    const older = olderBuildSchema();
    const reopened = older.nodeFromJSON(json);
    reopened.check();
    expect(reopened.lastChild!.attrs).toEqual({ source_heading_id: 'tag-1', source_label: '↳ Tag' });
    // Still round-trips in this build.
    expect(parseNative(serializeNative(doc)).doc.lastChild!.attrs['source_heading_id']).toBe('tag-1');
  });

  it('keeps only the anchor ids a live reference still links to', () => {
    const live = schema.nodes['self_ref']!.create({ source_anchor_id: 'linked', reference_gray: true });
    const doc = docWithAnchor('orphan linked', '{"orphan":11,"linked":9}', [live]);
    const { doc: reopened } = parseNative(serializeNative(doc));
    let anchor: Mark | undefined;
    reopened.descendants((node) => {
      anchor ??= node.marks.find((m) => m.type.name === 'live_reference_source');
      return true;
    });
    expect(anchor?.attrs).toEqual({ ids: 'linked', sizes: '{"linked":9}' });
    expect(reopened.lastChild!.attrs['source_anchor_id']).toBe('linked');
    expect(reopened.lastChild!.attrs['reference_gray']).toBe(true);
  });
});
