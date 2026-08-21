/**
 * External-insert primitive — backs the `POST /insert` endpoint
 * defined in `reference-docs/fdp-integration-f2-fix-note.md` / the
 * Fast Debate Paste integration spec (§4.2).
 *
 * Wire-contract goal: reproduce the observable result of the
 * keystroke bridge's "Return + F2 paste plain text" sequence (for
 * `newParagraph: true`) or "F2 paste plain text inline" (for
 * `newParagraph: false`), in ONE transaction so a single Cmd-Z
 * removes the whole insert.
 *
 *   - `newParagraph: true` — split `text` on `\r\n` / `\n` / `\r`,
 *     build a closed-start / open-end Slice of body paragraphs
 *     (`card_body` when the cursor lives inside a `card` /
 *     `analytic_unit`, `paragraph` at doc level), and
 *     `tr.replaceSelection(slice)`. The slice's closed start makes
 *     the first inserted body a fresh sibling rather than text
 *     merged into the cursor's textblock; the open end merges the
 *     last body's content with whatever was after the cursor in
 *     the original textblock — which is exactly the shape
 *     "Return + F2" produces (and the same shape F2's own
 *     `tryPasteAsCardBodies` fix lands inside the schema's content
 *     expression for `card` / `analytic_unit`, so a pasted line
 *     can NEVER be elevated to a tag).
 *
 *   - `newParagraph: false` — `tr.insertText(text)` at the current
 *     selection. Plain inline characters, no marks, no new block.
 *
 *   - a HEADING role (`pocket` / `hat` / `block` / `tag` /
 *     `analytic`) — one heading node per line, snapped to the
 *     outline slot a drag would drop it at. See below.
 *
 * No equation-marker handling (§4.4) in v1 — the spec lets v1
 * insert the placeholder as plain body text.
 */

import { DOMParser as PMDOMParser, Fragment, Slice, type Node as PMNode } from 'prosemirror-model';
import { type EditorState, type Transaction } from 'prosemirror-state';
import { ReplaceStep } from 'prosemirror-transform';
import { newHeadingId } from '../schema/ids.js';
import { insertAtCursorPos } from './insert-position.js';
import { markCiteTokensInText } from './cite-token-match.js';

/**
 * What the sender wants the text to become. `pocket` / `hat` / `block` /
 * `tag` / `analytic` are the outline's heading levels (`./headings.ts`);
 * `body` / `card` / `cite` all land as body paragraphs, and `inline` as
 * bare characters.
 */
export type ExternalInsertRole =
  | 'pocket'
  | 'hat'
  | 'block'
  | 'tag'
  | 'analytic'
  | 'body'
  | 'card'
  | 'cite'
  | 'inline';

export interface ExternalInsertOpts {
  text: string;
  /** Omitted means `card` — body paragraphs, the pre-role behavior. */
  role?: ExternalInsertRole;
  newParagraph: boolean;
  /** Cite emphasis (role `cite` only): verbatim substrings of the
   *  FIRST line — the lastname(s) + shortdate of the leading author
   *  block — to be styled with `cite_mark` on arrival. The sender
   *  states intent ("this span is the cite emphasis"), never
   *  presentation; matching is fuzzy (`./cite-token-match.ts`) and a
   *  token that isn't found marks nothing. */
  citeTokens?: readonly string[];
}

/**
 * The container a heading level needs around it to be schema-legal at the
 * doc root. Pocket / hat / block stand alone; `tag` is only ever a card's
 * first child and `analytic` only ever an analytic_unit's, which is why
 * sending one of those inserts a whole (single-heading) card or unit.
 *
 * Exported for `/insert-after` (`external-insert-after.ts`), which needs
 * the same wrapping rule to put a tag or an analytic next to one. A
 * present-but-undefined entry means "heading kind, stands alone", so the
 * heading test is `Object.hasOwn`, not a truthy read.
 */
export const HEADING_CONTAINER: Record<string, 'card' | 'analytic_unit' | undefined> = {
  pocket: undefined,
  hat: undefined,
  block: undefined,
  tag: 'card',
  analytic: 'analytic_unit',
};

function isHeadingRole(role: ExternalInsertRole): boolean {
  // hasOwn, not `in`: the role comes off the wire, and `in` would answer
  // true for every Object.prototype key.
  return Object.hasOwn(HEADING_CONTAINER, role);
}

/** One heading node (in its required container) per line, or null when the
 *  schema doesn't carry the types — same defensive rail as the body path. */
function buildHeadingNodes(
  state: EditorState,
  role: ExternalInsertRole,
  lines: string[],
): PMNode[] | null {
  const headingType = state.schema.nodes[role];
  if (!headingType) return null;
  const containerName = HEADING_CONTAINER[role];
  const containerType = containerName ? state.schema.nodes[containerName] : undefined;
  if (containerName && !containerType) return null;
  return lines.map((line) => {
    // Heading nodes carry a stable id (schema/ids.ts); one built without it
    // is invisible to the nav pane, so stamp it here rather than relying on
    // the load-time repair walk.
    const heading = headingType.create(
      { id: newHeadingId() },
      line ? state.schema.text(line) : null,
    );
    return containerType ? containerType.create(null, heading) : heading;
  });
}

/** Build the insertion transaction for an external `/insert` call.
 *  Returns `null` only when the schema doesn't carry the body type
 *  we need — never happens in our schema; the null is a defensive
 *  rail for callers in other host contexts. */
export function buildExternalInsertTransaction(
  state: EditorState,
  opts: ExternalInsertOpts,
): Transaction | null {
  const { text, newParagraph } = opts;
  const role = opts.role ?? 'card';

  if (isHeadingRole(role)) {
    // A heading is never inline, so the role outranks `newParagraph`.
    const nodes = buildHeadingNodes(state, role, text.split(/\r\n|\r|\n/));
    if (!nodes) return null;
    const content = Fragment.fromArray(nodes);
    // Dropping a doc-level object at a raw caret inside a card makes PM split
    // the card and leave a phantom blank-tag sibling behind; snap to the
    // outline slot a drag would use instead (mirrors the receive-pill insert).
    const at = insertAtCursorPos(state.doc, state.selection.head, content);
    return state.tr.insert(at, content);
  }

  if (!newParagraph) {
    // Inline mode: drop the text into the current selection as
    // plain characters. `insertText` clears the active mark set
    // implicitly on the inserted run; `setStoredMarks([])` then
    // prevents stored marks from leaking into the next keystroke
    // the user types.
    const tr = state.tr.insertText(text);
    tr.setStoredMarks([]);
    return tr;
  }

  // `card` / `cite` mode: build sibling body paragraphs from the
  // newline-separated pieces and insert them at the cursor.
  const lines = text.split(/\r\n|\r|\n/);
  const $from = state.selection.$from;

  // Pick the body type by walking up from the cursor until we
  // hit a `card` / `analytic_unit` — `card_body` belongs there.
  // No such ancestor → cursor is at doc level; use the generic
  // `paragraph` instead. (Both have `inline*` content, so the
  // slice's open end semantics are identical between the two.)
  let bodyTypeName: 'card_body' | 'paragraph' = 'paragraph';
  for (let d = $from.depth; d > 0; d--) {
    const t = $from.node(d).type.name;
    if (t === 'card' || t === 'analytic_unit') {
      bodyTypeName = 'card_body';
      break;
    }
  }
  const bodyType = state.schema.nodes[bodyTypeName];
  if (!bodyType) return null;

  const bodies = lines.map((line) =>
    bodyType.create(null, line ? state.schema.text(line) : null),
  );
  // Closed start so the first inserted body is a fresh sibling at
  // the cursor (mirrors the keystroke bridge's "press Return
  // first"); open end so the last body's content merges into
  // whatever was after the cursor in the original textblock
  // (mirrors what F2 paste does after the Return).
  const slice = new Slice(Fragment.fromArray(bodies), 0, 1);
  const tr = state.tr.replaceSelection(slice);
  tr.setStoredMarks([]);

  // Cite emphasis: apply `cite_mark` to the sender's tokens within the
  // FIRST inserted paragraph (the cite line — any article text the
  // sender bundled follows in later paragraphs and is never marked).
  // Position arithmetic can't be trusted here: slice fitting may split
  // the cursor's textblock or merge the first body into it, shifting
  // where the line lands. So read the replace step's affected range and
  // find the first textblock whose text BEGINS with the cite line (the
  // closed slice start pins the cite to a block head; the open end can
  // glue trailing text after it). No match → no marks — an unmarked
  // cite is today's behavior, a mismarked one would be a bug.
  const line = lines[0];
  if (role === 'cite' && opts.citeTokens?.length && line) {
    const citeType = state.schema.marks['cite_mark'];
    const step = tr.steps[tr.steps.length - 1];
    if (citeType && step instanceof ReplaceStep) {
      const rangeEnd = Math.min(step.from + step.slice.size, tr.doc.content.size);
      let markStart = -1;
      tr.doc.nodesBetween(step.from, rangeEnd, (node, pos) => {
        if (markStart !== -1) return false;
        if (node.isTextblock && node.textContent.startsWith(line)) {
          markStart = pos + 1;
          return false;
        }
        return true;
      });
      if (markStart !== -1) {
        markCiteTokensInText(tr, markStart, line, opts.citeTokens, citeType);
      }
    }
  }
  return tr;
}


// ─── Rich (HTML) inserts ────────────────────────────────────────────

/** Ceiling on an /insert html payload, mirrored by the bridge's
 *  main-side cap. Bounds the parse cost of a hostile-or-buggy sender;
 *  real cards are kilobytes. */
export const EXTERNAL_INSERT_HTML_MAX_BYTES = 2 * 1024 * 1024;

/** Elements whose CONTENT must never leak into the parse as text.
 *  ProseMirror skips unknown elements but still descends into their
 *  children, so a <script>'s source text would otherwise arrive as
 *  document text. Removed from the inert DOM before parsing. */
const STRIP_SELECTOR = 'script, style, template, iframe, object, embed, noscript';

/**
 * Build the insertion transaction for an /insert call carrying `html`.
 *
 * The HTML parses through the SCHEMA's own parseDOM rules in an inert
 * document (`document.implementation.createHTMLDocument` — scripts
 * never execute, resources never load), so only schema-valid content
 * survives: this is the same trust boundary as every user paste, and
 * CardMirror-native HTML (our own toDOM serialization, which is what
 * cooperating apps emit) round-trips at full fidelity by construction
 * — structure, highlight colors, cite/underline marks, everything.
 *
 * Placement is content-aware via `insertAtCursorPos`, mirroring
 * drag-and-drop: purely-inline content lands at the caret (inline
 * when `newParagraph` is false, as its own body block otherwise);
 * block content — whole cards included — snaps to the nearest valid
 * slot for its kind, never splitting the cursor's card.
 *
 * Returns null when the html yields no usable content — the caller
 * falls back to the plain-text path, which is also what an OLDER
 * CardMirror does with the same payload (it never reads `html`), so
 * sender behavior degrades identically across versions.
 */
export function buildExternalRichInsertTransaction(
  state: EditorState,
  opts: { html: string; newParagraph: boolean },
): Transaction | null {
  const { html, newParagraph } = opts;
  if (!html || html.length > EXTERNAL_INSERT_HTML_MAX_BYTES) return null;
  if (typeof document === 'undefined') return null;

  let body: HTMLElement;
  try {
    const inert = document.implementation.createHTMLDocument('external-insert');
    inert.body.innerHTML = html;
    for (const el of inert.body.querySelectorAll(STRIP_SELECTOR)) el.remove();
    body = inert.body;
  } catch {
    return null;
  }

  let slice: Slice;
  try {
    slice = PMDOMParser.fromSchema(state.schema).parseSlice(body);
  } catch {
    return null;
  }
  if (slice.content.size === 0) return null;

  // Purely inline content (a styled run, no block structure): honor the
  // inline/newParagraph contract the text path has.
  let allInline = true;
  slice.content.forEach((n) => {
    if (!n.isInline) allInline = false;
  });
  if (allInline) {
    if (!newParagraph) {
      const tr = state.tr.replaceSelection(new Slice(slice.content, 0, 0));
      tr.setStoredMarks([]);
      return tr;
    }
    // Block mode: wrap the run in the body type the cursor's container
    // wants (same walk as the text path).
    const $from = state.selection.$from;
    let bodyTypeName: 'card_body' | 'paragraph' = 'paragraph';
    for (let d = $from.depth; d > 0; d--) {
      const t = $from.node(d).type.name;
      if (t === 'card' || t === 'analytic_unit') {
        bodyTypeName = 'card_body';
        break;
      }
    }
    const bodyType = state.schema.nodes[bodyTypeName];
    if (!bodyType) return null;
    const block = bodyType.createChecked(null, slice.content);
    const tr = state.tr.replaceSelection(new Slice(Fragment.from(block), 0, 1));
    tr.setStoredMarks([]);
    return tr;
  }

  // Block content: re-parse as a fitted document so every container is
  // well-formed (the parser fills required children — a card always
  // gets its tag), then drop the children at the content-aware slot.
  let docNode: PMNode;
  try {
    docNode = PMDOMParser.fromSchema(state.schema).parse(body);
  } catch {
    return null;
  }
  if (docNode.content.size === 0) return null;
  const content = docNode.content;
  const at = insertAtCursorPos(state.doc, state.selection.head, content);
  const tr = state.tr.insert(at, content);
  tr.setStoredMarks([]);
  return tr;
}
