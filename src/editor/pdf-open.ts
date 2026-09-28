/**
 * Opening a PDF: convert it to a CardMirror document (src/import/pdf) off
 * the renderer thread, so a long file doesn't freeze the window.
 *
 * The converter's own refusals (a scan, an encrypted file, not a PDF) come
 * back as `PdfImportError` with their message. Any other worker failure
 * re-runs the conversion inline, so the result is the same either way.
 * Hosts without Worker (tests) run it inline. The converter is loaded on
 * demand: no cost to anyone who never opens a PDF.
 */

import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../schema/index.js';

export class PdfOpenError extends Error {}

type Reply =
  | { id: number; ok: true; docJson: unknown }
  | { id: number; ok: false; error: string; importError: boolean };

let worker: Worker | null | undefined;
let nextId = 1;
const pending = new Map<number, (r: Reply | null) => void>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    if (typeof Worker === 'undefined') throw new Error('no Worker in this host');
    worker = new Worker(new URL('../import/pdf/pdf-import-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent): void => {
      const msg = e.data as Reply;
      const done = pending.get(msg.id);
      pending.delete(msg.id);
      done?.(msg);
    };
    worker.onerror = (): void => {
      for (const [, done] of pending) done(null);
      pending.clear();
      worker?.terminate();
      worker = undefined;
    };
  } catch {
    worker = null;
  }
  return worker;
}

/** True for bytes that start like a PDF (`%PDF-`, possibly after a little
 *  junk, which some producers write). */
export function bytesLookLikePdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes('%PDF-');
}

async function inline(bytes: Uint8Array): Promise<PMNode> {
  const { pdfToDoc, PdfImportError } = await import('../import/pdf/index.js');
  try {
    return pdfToDoc(bytes).doc;
  } catch (err) {
    if (err instanceof PdfImportError) throw new PdfOpenError(err.message);
    throw err;
  }
}

/** The PDF as a CardMirror document. Throws `PdfOpenError` (with a message
 *  for the user) when the file can't be converted. */
export async function convertPdf(bytes: Uint8Array): Promise<PMNode> {
  const w = getWorker();
  if (w) {
    const reply = await new Promise<Reply | null>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      w.postMessage({ id, bytes });
    });
    if (reply?.ok) return schema.nodeFromJSON(reply.docJson);
    if (reply && reply.importError) throw new PdfOpenError(reply.error);
    // Worker died or failed unexpectedly: convert here instead.
  }
  return inline(bytes);
}
