/**
 * Web Worker that runs PDF import (`pdfToDoc`) off the renderer thread. See
 * src/editor/pdf-open.ts for the client.
 *
 * Protocol: { id, bytes } →
 *   { id, progress } (0–1, every few percent), then
 *   { id, ok: true, docJson } | { id, ok: false, error, importError }
 */

import { pdfToDoc, PdfImportError } from './index.js';

const post = (message: unknown): void =>
  (self as unknown as { postMessage(m: unknown): void }).postMessage(message);

self.onmessage = (e: MessageEvent): void => {
  const req = e.data as { id: number; bytes: Uint8Array } | null;
  if (!req || typeof req.id !== 'number') return;
  try {
    let last = 0;
    const { doc } = pdfToDoc(req.bytes, (fraction) => {
      if (fraction - last < 0.05 && fraction < 1) return;
      last = fraction;
      post({ id: req.id, progress: fraction });
    });
    post({ id: req.id, ok: true, docJson: doc.toJSON() });
  } catch (err) {
    post({
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      importError: err instanceof PdfImportError,
    });
  }
};
