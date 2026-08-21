/**
 * Renderer-side handler for the Fast Debate Paste integration's
 * `POST /insert` requests (see the FDP integration spec in
 * `reference-docs/`).
 *
 * Wire:
 *   - Main process receives the HTTP `POST /insert` payload, picks
 *     the focused window's `webContents`, and sends an
 *     `external:insert-text` IPC with `{ requestId, text, role,
 *     newParagraph, omitted }`.
 *   - This module subscribes via the preload bridge, applies the
 *     insert against the focused window's live `EditorView` (or
 *     returns the right error if no editable doc is available /
 *     the doc is in read mode), and sends an
 *     `external:insert-result` IPC back with
 *     `{ requestId, ok, error?, docTitle?, sources? }`.
 *
 * Insertion itself goes through `buildExternalInsertTransaction`
 * (`./external-insert.ts`) so the renderer-side primitive is
 * shared with future F2 use and tested in isolation. We do NOT
 * route through `applyPlainPasteFromText` / `buildPlainTextSlice` /
 * PM's contextual fitting — the FDP spec is explicit on that
 * because that's the path the historical stray-tags bug came from.
 *
 * `sources` is the provenance half, and it is minted HERE rather
 * than in the primitive: a token names a document, and only the
 * host knows which one the insert landed in. See `mintSources` for
 * when the field is answered and why it is all-or-nothing.
 */

import type { EditorView } from 'prosemirror-view';
import {
  buildExternalInsertTransaction,
  buildExternalRichInsertTransaction,
  EXTERNAL_INSERT_HTML_MAX_BYTES,
  type ExternalInsertRole,
  type InsertedHeading,
} from './external-insert.js';
import { createDescriptorBuilder } from './learn-anchor.js';
import { mintSourceToken } from './plugin-source-token.js';

interface InsertRequest {
  requestId: string;
  text: string;
  role: ExternalInsertRole;
  newParagraph: boolean;
  omitted: boolean;
  /** Doc-targeted insert: the pane uid to land in (from GET /docs).
   *  Absent = the legacy path — this window's focused view. */
  target?: string;
  /** Cite-emphasis substrings (role `cite`) — see ExternalInsertOpts. */
  citeTokens?: string[];
  /** Rich payload: CardMirror-native (or arbitrary) HTML. When present
   *  and it parses to usable content, it supersedes `text`/`role`/
   *  `citeTokens`; unusable html falls back to the text path — the
   *  same rendering an older CardMirror (which never reads this
   *  field) produces. */
  html?: string;
}

interface InsertResult {
  requestId: string;
  ok: boolean;
  error?: 'no-target-doc' | 'doc-readonly' | 'bad-request' | 'internal' | 'target-not-found';
  docTitle?: string;
  /** One provenance token per inserted textblock, in document order.
   *  Heading roles only, and all-or-nothing — see `mintSources`. */
  sources?: string[];
}

/** Preload-exposed API surface this module reads. Defined here as
 *  a structural type so the renderer build doesn't take a
 *  build-time dependency on the desktop preload. */
interface ExternalInsertBridge {
  onExternalInsertRequest(handler: (req: InsertRequest) => void): () => void;
  sendExternalInsertResult(result: InsertResult): void;
}

export interface ExternalInsertHostOpts {
  /** Resolve the focused window's live editor view, or null when
   *  the focused surface isn't an editable doc (home screen,
   *  settings dialog, recovery sidebar, …). */
  getFocusedView: () => EditorView | null;
  /** Resolve a pane uid (from a doc-targeted insert) to its live view
   *  in THIS window — three-pane aware, focused or not. Absent on
   *  hosts without pane registries; targeted requests then fail with
   *  `target-not-found`. */
  resolveViewForUid?: (uid: string) => EditorView | null;
  /** The doc's user-facing label for the ack — filename if the
   *  doc has been saved, otherwise the synthesized title. May
   *  return null when no doc is open. */
  getFocusedDocTitle: () => string | null;
  /** Identity of the doc an insert landed in, for the provenance tokens
   *  on the ack: `uid` names the addressed pane on a targeted insert,
   *  and is absent for the focused one. `docId` is minted on demand the
   *  way `/extract` does it, since a never-saved doc carries none yet and
   *  a token without one addresses no document. Null — or an absent hook,
   *  on a host with no doc registry — answers no `sources` rather than
   *  tokens nothing can resolve. */
  getDocIdentity?: (uid?: string) => { docId: string; docTitle: string } | null;
}

/** Mount the external-insert handler. Returns an unsubscribe
 *  function for tests / shutdown — boot-mode callers can ignore. */
export function installExternalInsertHost(opts: ExternalInsertHostOpts): () => void {
  const bridge = pickBridge();
  if (!bridge) return () => {};

  const unsubscribe = bridge.onExternalInsertRequest((req) => {
    const result = handle(req, opts);
    bridge.sendExternalInsertResult(result);
  });
  return unsubscribe;
}

function handle(req: InsertRequest, opts: ExternalInsertHostOpts): InsertResult {
  const requestId = req.requestId;
  try {
    if (
      typeof req.text !== 'string' ||
      typeof req.requestId !== 'string' ||
      typeof req.newParagraph !== 'boolean'
    ) {
      return { requestId, ok: false, error: 'bad-request' };
    }
    let view: EditorView | null;
    if (typeof req.target === 'string' && req.target) {
      // Doc-targeted: land in the addressed pane, focused or not.
      // A miss is target-not-found (doc closed since /docs listed it,
      // or main mis-routed) — never a silent fallback to a doc the
      // caller didn't name.
      view = opts.resolveViewForUid?.(req.target) ?? null;
      if (!view) return { requestId, ok: false, error: 'target-not-found' };
    } else {
      view = opts.getFocusedView();
    }
    if (!view || !view.editable) {
      // §4.5 splits these: no live editor view → no-target-doc;
      // view present but read mode has flipped `editable` false
      // (the read-mode plugin's gate) → doc-readonly.
      if (!view) return { requestId, ok: false, error: 'no-target-doc' };
      return { requestId, ok: false, error: 'doc-readonly' };
    }
    // Rich path first: valid html that parses to content wins; anything
    // else falls through to the text path (identical to how an older
    // CardMirror, which never reads `html`, renders this payload).
    if (
      typeof req.html === 'string' &&
      req.html.length > 0 &&
      req.html.length <= EXTERNAL_INSERT_HTML_MAX_BYTES
    ) {
      const richTr = buildExternalRichInsertTransaction(view.state, {
        html: req.html,
        newParagraph: req.newParagraph,
      });
      if (richTr) {
        view.dispatch(richTr.scrollIntoView());
        const richResult: InsertResult = { requestId, ok: true };
        if (!(typeof req.target === 'string' && req.target)) {
          const docTitle = opts.getFocusedDocTitle();
          if (docTitle) richResult.docTitle = docTitle;
        }
        return richResult;
      }
    }
    // citeTokens off the wire: keep only a well-formed string array.
    const citeTokens = Array.isArray(req.citeTokens)
      ? req.citeTokens.filter((t): t is string => typeof t === 'string' && t.length > 0)
      : undefined;
    const plan = buildExternalInsertTransaction(view.state, {
      text: req.text,
      role: req.role,
      newParagraph: req.newParagraph,
      ...(citeTokens && citeTokens.length > 0 ? { citeTokens } : {}),
    });
    if (!plan) {
      // schema didn't carry the body type we asked for — should never
      // happen on our schema; defensive rail only.
      return { requestId, ok: false, error: 'internal' };
    }
    view.dispatch(plan.tr.scrollIntoView());
    const result: InsertResult = { requestId, ok: true };
    const targetUid = typeof req.target === 'string' && req.target ? req.target : undefined;
    if (targetUid) {
      // Targeted acks skip the focused-doc title (wrong doc); main
      // fills the addressed doc's name from its directory.
    } else {
      const docTitle = opts.getFocusedDocTitle();
      if (docTitle) result.docTitle = docTitle;
    }
    // Identity is resolved only once something addressable landed: the
    // hook may MINT a docId for a never-saved doc, and an insert that
    // reports no headings has nothing to stamp one for.
    if (plan.headings.length > 0) {
      const ident = opts.getDocIdentity?.(targetUid);
      const sources = ident ? mintSources(view, plan.headings, ident) : undefined;
      if (sources) result.sources = sources;
    }
    return result;
  } catch {
    return { requestId, ok: false, error: 'internal' };
  }
}

/**
 * A provenance token per inserted heading, in document order, or
 * undefined when the caller can be handed none.
 *
 * Heading roles only, and that is the plan's doing: `body` / `card` /
 * `cite` and inline mode land as `card_body` or a doc-level `paragraph`,
 * which `/replace` and `/insert-after` refuse as `body-text`, so they
 * report no headings and this answers nothing. A token over one would
 * promise a link the caller could never use.
 *
 * Verified against the doc that LANDED, never the plan's arithmetic
 * alone: slice fitting is free to move or wrap an inserted node, and a
 * token minted over the wrong range names a line the caller never sent.
 * One heading per line is predictable, so a mismatch means the placement
 * rules changed - which must surface as lost provenance here rather than
 * as a caller silently editing its neighbour's text.
 *
 * All-or-nothing, and never fatal: one entry that doesn't verify drops
 * the whole field. The text is already in the document, so a caller that
 * loses `sources` has lost a handle, while a caller handed a short or
 * lying list would corrupt what it writes back to next.
 */
function mintSources(
  view: EditorView,
  headings: readonly InsertedHeading[],
  ident: { docId: string; docTitle: string },
): string[] | undefined {
  const doc = view.state.doc;
  try {
    const buildDescriptor = createDescriptorBuilder(doc); // flatten once, not per heading
    const sources: string[] = [];
    for (const h of headings) {
      if (h.contentStart + h.text.length > doc.content.size) return undefined;
      const $at = doc.resolve(h.contentStart);
      if (
        $at.parent.type.name !== h.type ||
        $at.parentOffset !== 0 ||
        $at.parent.textContent !== h.text
      ) {
        return undefined;
      }
      sources.push(
        mintSourceToken({
          docId: ident.docId,
          docTitle: ident.docTitle,
          headingId: h.headingId,
          // No anchor for a blank line: the heading id resolves it, and an
          // empty quote would match anywhere (`plugin-extract.ts` guards
          // its zero-length ranges the same way).
          anchor: h.text
            ? buildDescriptor(h.contentStart, h.contentStart + h.text.length)
            : null,
        }),
      );
    }
    return sources;
  } catch {
    return undefined;
  }
}

function pickBridge(): ExternalInsertBridge | null {
  const w = window as unknown as { electronAPI?: ExternalInsertBridge };
  const api = w.electronAPI;
  if (!api) return null;
  if (typeof api.onExternalInsertRequest !== 'function') return null;
  if (typeof api.sendExternalInsertResult !== 'function') return null;
  return api;
}
