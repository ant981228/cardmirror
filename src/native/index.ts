/**
 * CardMirror native file format (`.cmir`).
 *
 * The "no-roundtrip" save path: serialize the ProseMirror document
 * straight to JSON with a small format envelope, persist it as-is,
 * and parse it back without any conversion loss. Files saved this
 * way preserve everything the schema can express (including things
 * docx round-trip drops or rewrites — structural intent that
 * Word style-guessing can't recover, etc.).
 *
 * Users still get full `.docx` support for sharing with Verbatim
 * teammates; `.cmir` is the long-term canonical form for docs that
 * live entirely inside the CardMirror ecosystem.
 *
 * Format shape (current `formatVersion`):
 *
 *   {
 *     "format": "cardmirror-doc",
 *     "formatVersion": 1,
 *     "createdBy": "CardMirror 0.x",
 *     "createdAt": "2026-…",
 *     "doc": { ...PM-doc JSON },
 *     "threads": [ ...Thread[] ]   // optional
 *   }
 *
 * On disk: minified JSON, gzip-compressed (legacy plaintext files
 * still parse). Future enhancements (binary frame for images, etc.)
 * can ride formatVersion bumps; v1 keeps it simple.
 */

import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../schema/index.js';
import { salvageDoc, type DroppedNode } from '../schema/salvage.js';
import { stampMissingHeadingIds, dedupeHeadingIds } from '../schema/ids.js';
import {
  splitInCardAnalytics,
  flattenNestedZones,
  healAnalyticUnits,
  healCards,
  healTables,
  dropEmptyZones,
  stripImageVisualMarks,
} from '../schema/migrate.js';
import type { Thread } from '../editor/comments-plugin.js';
import { gzip, gzipAsync, gunzip, isGzip } from './codec.js';
import { stripUnlinkedLiveReferenceData } from './live-reference-compat.js';

/** Magic identifier present in every CardMirror native file. Rejects
 *  arbitrary JSON files. */
const FORMAT_ID = 'cardmirror-doc';

/** Current format version. Bump when the envelope or doc-JSON shape
 *  changes in a way that requires migration on parse. */
const FORMAT_VERSION = 1;

/** Canonical file extension (no leading dot). */
export const NATIVE_FILE_EXTENSION = 'cmir';

export interface NativeFile {
  format: typeof FORMAT_ID;
  formatVersion: number;
  /** App version that produced the file. Informational. */
  createdBy: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** ProseMirror doc JSON. Round-tripped via `PMNode.toJSON` and
   *  `Schema.nodeFromJSON`. */
  doc: unknown;
  /** Comment threads, if any. Omitted from the file when empty. */
  threads?: Thread[];
  /** Stable per-document UUID linking the local Learn annotation layer
   *  (flashcards / AI threads / schedule) to this doc across renames and
   *  format changes. Minted on first save; absent on older files. */
  docId?: string;
}

export interface SerializeNativeOptions {
  /** Comment threads to embed alongside the doc. Omit when there
   *  are none. */
  threads?: readonly Thread[];
  /** App version string written into `createdBy`. Defaults to a
   *  generic "CardMirror" if not supplied. */
  appVersion?: string;
  /** Stable per-document UUID (see `NativeFile.docId`). Written only
   *  when provided, so callers that don't track it are unaffected. */
  docId?: string;
}

/** Diagnostic hook for the save-time structural tripwire below. The
 *  renderer registers a listener (toast + durable log) — this module
 *  must stay UI- and DOM-free (node tooling imports it), so reporting
 *  is injected. Unset → console.error only. */
export interface SaveHealReport {
  /** The original check() failure message. */
  error: string;
  /** True when the heal chain produced a valid doc that was saved in
   *  place of the invalid one; false when even the heals couldn't fix
   *  it and the ORIGINAL bytes were saved (load will refuse them —
   *  same as before the tripwire, but now with a diagnostic trail). */
  healed: boolean;
}
let saveHealListener: ((report: SaveHealReport) => void) | null = null;
export function setSaveHealListener(cb: ((report: SaveHealReport) => void) | null): void {
  saveHealListener = cb;
}

/** Save-time structural tripwire (structural-integrity audit, tier 1).
 *  No save path validated anything: an invalid live doc reached the
 *  crash journal within seconds and the real file at the next autosave
 *  — which is exactly how both hollow-shell field incidents persisted.
 *  Every save now runs `doc.check()`; an invalid doc is healed with
 *  the same known-shape passes the load path uses and the HEALED doc
 *  is saved, with the failure reported via the listener — catching the
 *  (still unidentified) producer red-handed at its first save. A doc
 *  the heals can't fix saves UNCHANGED: a save must never be refused
 *  (the journal is the crash lifeline), the original bytes preserve
 *  the forensic shape, and load-time treats them exactly as it would
 *  have before. check() is a tree walk on par with the toJSON() walk
 *  below, and gzip dominates both. */
function tripwireForSave(doc: PMNode): PMNode {
  try {
    doc.check();
    return doc;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const healedDoc = healTables(healCards(healAnalyticUnits(doc)));
    let healed = false;
    let out = doc;
    try {
      healedDoc.check();
      healed = true;
      out = healedDoc;
    } catch {
      /* unhealable — save the original, report below */
    }
    if (saveHealListener) saveHealListener({ error, healed });
    else console.error(`[cardmirror] invalid doc at save (healed=${healed}): ${error}`);
    return out;
  }
}

/** Build the minified-JSON envelope both serialize variants gzip-wrap.
 *  Minified: gzip makes pretty-printing pointless for inspection
 *  (`gunzip file.cmir | jq` restores it on demand). Compression yields
 *  ~10× smaller files; the gzip magic (0x1F 0x8B) lets `parseNative`
 *  tell compressed files from legacy plaintext ones (which begin
 *  with `{`). */
function buildNativeEnvelope(doc: PMNode, opts: SerializeNativeOptions): Uint8Array {
  const file: NativeFile = {
    format: FORMAT_ID,
    formatVersion: FORMAT_VERSION,
    createdBy: opts.appVersion ?? 'CardMirror',
    createdAt: new Date().toISOString(),
    // Older builds can't open a file carrying live-reference data (unknown
    // mark type), so write it only while a live reference actually uses it.
    doc: stripUnlinkedLiveReferenceData(tripwireForSave(doc).toJSON()),
  };
  if (opts.threads && opts.threads.length > 0) {
    file.threads = [...opts.threads];
  }
  if (opts.docId) {
    file.docId = opts.docId;
  }
  return new TextEncoder().encode(JSON.stringify(file));
}

/** Serialize a ProseMirror doc + optional threads to bytes in the
 *  CardMirror native format. */
export function serializeNative(
  doc: PMNode,
  opts: SerializeNativeOptions = {},
): Uint8Array {
  return gzip(buildNativeEnvelope(doc, opts));
}

/** `serializeNative`, but the gzip DEFLATE runs off the main thread
 *  (see `gzipAsync`) — same bytes for the same envelope. For the
 *  editor's debounced journal/autosave paths, where the sync variant's
 *  compression stalls typing on large docs. The JSON envelope build
 *  (which must read the live doc) stays synchronous either way. */
export function serializeNativeAsync(
  doc: PMNode,
  opts: SerializeNativeOptions = {},
): Promise<Uint8Array> {
  return gzipAsync(buildNativeEnvelope(doc, opts));
}

export interface ParseNativeResult {
  doc: PMNode;
  /** Empty array when the file had no threads. */
  threads: Thread[];
  /** Stable per-document UUID, or null on files that predate it. */
  docId: string | null;
  meta: {
    createdBy: string;
    createdAt: string;
    formatVersion: number;
  };
}

/** The "damaged file" refusal — a distinct class so open flows can
 *  tell "this parsed but is structurally invalid" (salvage may apply)
 *  from "these bytes aren't a CardMirror file at all". */
export class NativeDamagedError extends Error {
  override name = 'NativeDamagedError';
}

/** Parse CardMirror native bytes back into a doc + threads. Throws
 *  with a descriptive message when the bytes aren't a valid CardMirror
 *  file — caller can show that to the user. */
export function parseNative(bytes: Uint8Array): ParseNativeResult {
  return parseNativeImpl(bytes, false);
}

/** Last-resort variant: when the doc fails `check()` even after the
 *  heal chain, run `salvageDoc` (drop the minimal invalid subtrees,
 *  fill required content) and return the valid remainder plus a
 *  report of what was dropped. Still throws when even salvage can't
 *  produce a valid doc. Callers MUST get user consent before opening
 *  the result, must open it WITHOUT the original's file handle (first
 *  save forces Save As, preserving the damaged original for
 *  forensics), and should log the drop report. */
export function parseNativeSalvage(
  bytes: Uint8Array,
): ParseNativeResult & { dropped: DroppedNode[] } {
  const result = parseNativeImpl(bytes, true);
  return { ...result, dropped: result.dropped ?? [] };
}

function parseNativeImpl(
  bytes: Uint8Array,
  salvage: boolean,
): ParseNativeResult & { dropped?: DroppedNode[] } {
  // An empty read is the tell-tale of a cloud "online-only" placeholder
  // (Dropbox / iCloud Drive) that hasn't downloaded: `readFile` hands back 0
  // bytes instead of the real content, which would otherwise die cryptically as
  // "failed to parse JSON (Unexpected end of JSON input)". Say what's actually
  // wrong and how to fix it.
  if (bytes.length === 0) {
    throw new Error(
      'This file is empty or hasn’t finished downloading. If it lives in Dropbox ' +
        'or iCloud Drive, it may be set to “online only” — make it available ' +
        'offline (in Finder, right-click → Make available offline / Download Now), ' +
        'then open it again.',
    );
  }
  let parsed: unknown;
  try {
    // Compressed files (gzip magic) inflate first; legacy plaintext files
    // (begin with `{`) pass straight through.
    const raw = isGzip(bytes) ? gunzip(bytes) : bytes;
    const text = new TextDecoder().decode(raw);
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Not a CardMirror file: failed to parse JSON (${err instanceof Error ? err.message : err}).`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Not a CardMirror file: expected a JSON object.');
  }
  const file = parsed as Partial<NativeFile>;
  if (file.format !== FORMAT_ID) {
    throw new Error(
      `Not a CardMirror file: missing or unrecognized format identifier (${String(file.format)}).`,
    );
  }
  if (typeof file.formatVersion !== 'number') {
    throw new Error('CardMirror file is missing formatVersion.');
  }
  if (file.formatVersion > FORMAT_VERSION) {
    throw new Error(
      `CardMirror file uses formatVersion ${file.formatVersion}, which is newer than this build supports (max ${FORMAT_VERSION}). Update CardMirror to read this file.`,
    );
  }
  if (file.doc === undefined) {
    throw new Error('CardMirror file is missing its doc field.');
  }
  // Defensive: stamp any heading whose `id` came in null. Old
  // files written before the alpha.6 F2 fix can contain
  // synthesized tag nodes that PM's schema fitter built from the
  // tag attrs' defaults, missing the id-generation step every code
  // path uses (see `stampMissingHeadingIds`'s JSDoc for the
  // mechanism). An id-less heading is invisible to the nav-pane
  // highlight + jump and to the level filter, so this stamps a
  // fresh id at load to repair the doc in place.
  // Then split out any `analytic` that an older file stored INSIDE a card
  // (`analytic` is no longer legal card content — it anchors its own
  // analytic_unit). `nodeFromJSON` builds the now-invalid node without
  // validating; this rewrites it into a trailing analytic_unit before the doc
  // reaches the editor. See `schema/migrate.ts`.
  let doc: PMNode;
  let dropped: DroppedNode[] | undefined;
  try {
    doc = stripImageVisualMarks(
      dropEmptyZones(
        healTables(
          healCards(
            healAnalyticUnits(
              flattenNestedZones(
                splitInCardAnalytics(dedupeHeadingIds(stampMissingHeadingIds(schema.nodeFromJSON(file.doc)))),
              ),
            ),
          ),
        ),
      ),
    );
    if (doc.type !== schema.nodes['doc']) {
      throw new Error(`top-level node is "${doc.type.name}", not a document`);
    }
    // Reject-invalid, not heal-known-only (PR #25 review): `nodeFromJSON`
    // builds invalid STRUCTURE of known types without complaint (only
    // unknown node/mark types throw), and a `.cmir` reaches this parser
    // with one double-click via the OS file association — so a crafted or
    // corrupted file must fail CLEANLY here, not load broken state that
    // misbehaves later. The heal passes above run first: they exist for
    // specific known-legacy shapes, and a healed doc passes; `check()`
    // walks everything else (content expressions, mark constraints) and
    // throws with a precise location. In salvage mode a check failure
    // falls through to `salvageDoc` — minimal drops, user-consented at
    // the call site — and only an unsalvageable doc still refuses.
    try {
      doc.check();
    } catch (checkErr) {
      if (!salvage) throw checkErr;
      const salvaged = salvageDoc(doc);
      if (!salvaged) throw checkErr;
      doc = salvaged.doc;
      dropped = salvaged.dropped;
    }
  } catch (err) {
    throw new NativeDamagedError(
      `This CardMirror file is damaged and can’t be opened (${
        err instanceof Error ? err.message : String(err)
      }).`,
    );
  }
  return {
    doc,
    threads: Array.isArray(file.threads) ? file.threads : [],
    docId: typeof file.docId === 'string' && file.docId ? file.docId : null,
    meta: {
      createdBy: typeof file.createdBy === 'string' ? file.createdBy : '',
      createdAt: typeof file.createdAt === 'string' ? file.createdAt : '',
      formatVersion: file.formatVersion,
    },
    ...(dropped ? { dropped } : {}),
  };
}

/** Quick non-throwing check for whether bytes start with our format
 *  identifier — useful for ambiguous file picks where the extension
 *  is missing or unreliable. */
export function looksLikeNative(bytes: Uint8Array): boolean {
  // Compressed files: inflate (only happens on an ambiguous single-file
  // pick, never in bulk) and check the inflated head.
  let head: Uint8Array = bytes;
  if (isGzip(bytes)) {
    try {
      head = gunzip(bytes);
    } catch {
      return false;
    }
  }
  // Peek at the first ~256 chars; the `format` key lands in the
  // first few-dozen bytes of any well-formed file we produce.
  return new TextDecoder().decode(head.subarray(0, 256)).includes(`"${FORMAT_ID}"`);
}
