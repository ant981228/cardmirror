/**
 * Verbatim-adjacent "Create Reference" — given a card_body-only
 * selection inside a single card, copy a richly-formatted "for-
 * reference" excerpt to the system clipboard. Each step is
 * configurable via `CreateReferenceOptions` (backed by the "Create
 * Reference" settings section); the defaults produce:
 *
 *   1. A heading paragraph: `<<{cite} FOR REFERENCE>>`, normal 11pt
 *      black body text (regardless of the Gray-50% setting).
 *      Skipped when `includeHeading` is off; the delimiter pair, the
 *      cite's presence, and the label text are all configurable (see
 *      `referenceHeadingText`).
 *   2. The selected card_body paragraphs, with:
 *      - every text run's effective font-size reduced by `shrinkPt`
 *        points (emitted as an explicit `font_size` mark); with
 *        `shrink` off, runs keep their sizes untouched;
 *      - every text run colored black (or Gray-50% `#808080`
 *        if `useGray50` is on);
 *      - `highlightMode`: any `highlight` mark converted to a
 *        `shading` mark — light gray (`C0C0C0`) so the highlight
 *        isn't lost on paste into Word but reads as a quiet
 *        background (`'shading'`, default) or the highlight's own
 *        color (`'convert'`) — kept as a highlight (`'keep'`), or
 *        stripped (`'remove'`). Existing shading marks are untouched.
 *
 * No-op (returns false) if the selection is empty, touches any
 * non-card_body content, or spans more than one card.
 *
 * Writes both `text/html` (for rich pastes back into this editor or
 * into Word) and `text/plain` (fallback) to the clipboard.
 */

import { DOMSerializer, Fragment, Slice, type Mark, type Node as PMNode } from 'prosemirror-model';
import { withFrozenStyles } from './clipboard-styles.js';
import { writeClipboardHtml } from './clipboard-write.js';
import type { Command, EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { newHeadingId, schema } from '../schema/index.js';
import { collectCiteText } from './headings.js';
import { highlightRgbFor } from './color-palette.js';
import {
  condenseWarningCloseFor,
  type CreateReferenceDelimiter,
  type CreateReferenceHighlightMode,
} from './settings.js';
import { clearLinkedCopy, rememberLinkedCopy } from './clipboard-link-cache.js';
import { createLiveReferenceNode } from './self-transclusion.js';

/** Light gray for highlight → shading conversion in references. */
const REFERENCE_SHADING_HEX = 'C0C0C0';

interface CardBodySelection {
  paragraphs: { node: PMNode; pos: number }[];
  parentCard: PMNode;
}

/** Collect the card_body paragraphs a selection touches, requiring every
 *  touched textblock to be a card_body living inside ONE shared card.
 *  Returns null if the selection touches anything else or spans more than
 *  one card. (Create Reference's strict single-card validation.) */
function collectCardBodySelection(
  state: EditorState,
  from: number,
  to: number,
): CardBodySelection | null {
  let parentCardPos: number | null = null;
  let parentCard: PMNode | null = null;
  const paragraphs: { node: PMNode; pos: number }[] = [];
  let invalid = false;

  state.doc.nodesBetween(from, to, (node, pos) => {
    if (invalid) return false;
    if (!node.isTextblock) return true;
    if (node.type.name !== 'card_body') {
      invalid = true;
      return false;
    }
    // Card_body must live inside a card. depth 2: doc → card → card_body.
    const $start = state.doc.resolve(pos + 1);
    if ($start.depth < 2) {
      invalid = true;
      return false;
    }
    const cardDepth = $start.depth - 1;
    const card = $start.node(cardDepth);
    const cardPos = $start.before(cardDepth);
    if (card.type.name !== 'card') {
      invalid = true;
      return false;
    }
    if (parentCardPos === null) {
      parentCardPos = cardPos;
      parentCard = card;
    } else if (cardPos !== parentCardPos) {
      invalid = true;
      return false;
    }
    paragraphs.push({ node, pos });
    return false;
  });

  if (invalid || paragraphs.length === 0 || parentCard === null) return null;
  return { paragraphs, parentCard };
}

export type EffectivePtForNode = (
  node: PMNode | null,
  parent: PMNode,
) => number;

/** The user-configurable knobs of Create Reference — built from the
 *  "Create Reference" settings section at the call site so the
 *  transform itself stays pure and testable. */
export interface CreateReferenceOptions {
  /** Emit the `<<CITE FOR REFERENCE>>` heading line. */
  includeHeading: boolean;
  /** Bracket pair wrapping the heading line. */
  delimiter: CreateReferenceDelimiter;
  /** Put the card's cite (SMITH 24) in the heading. */
  includeCite: boolean;
  /** Custom label replacing FOR REFERENCE; `%Cite%` (any case) marks
   *  where the cite goes, otherwise the cite is prepended. Empty =
   *  the default label. */
  customHeading: string;
  /** Make the heading line bold. */
  headingBold: boolean;
  /** Make the heading line italic. */
  headingItalic: boolean;
  /** Apply the emphasis style to the heading line. Wins over `headingUnderlined`
   *  when both are set (emphasis and underline are mutually exclusive). */
  headingEmphasized: boolean;
  /** Underline the heading line. Ignored when `headingEmphasized` is also on. */
  headingUnderlined: boolean;
  /** Reduce every run's font size by `shrinkPt`. */
  shrink: boolean;
  /** Points to reduce by when `shrink` is on (result floors at 1pt). */
  shrinkPt: number;
  /** What highlighted runs become in the excerpt. */
  highlightMode: CreateReferenceHighlightMode;
  /** Gray-50% body text instead of black. */
  useGray50: boolean;
}

/** The heading line's text for a given cite + options — extracted so
 *  the interplay of delimiter / include-cite / custom-label rules
 *  stays in one place. `cite` is the raw collected cite (may be ''). */
export function referenceHeadingText(
  cite: string,
  opts: Pick<CreateReferenceOptions, 'delimiter' | 'includeCite' | 'customHeading'>,
): string {
  const citePart = opts.includeCite ? cite.trim().toUpperCase() : '';
  const custom = opts.customHeading.trim();
  let label: string;
  if (custom) {
    label = /%cite%/i.test(custom)
      ? custom.replace(/%cite%/gi, citePart)
      : citePart
        ? `${citePart} ${custom}`
        : custom;
    // Substituting an empty cite can leave doubled spaces behind.
    label = label.replace(/\s{2,}/g, ' ').trim();
    if (!label) label = 'FOR REFERENCE';
  } else {
    label = citePart ? `${citePart} FOR REFERENCE` : 'FOR REFERENCE';
  }
  return `${opts.delimiter}${label}${condenseWarningCloseFor(opts.delimiter)}`;
}

/** Build the excerpt's nodes (heading + transformed body paragraphs),
 *  or null when the selection isn't a valid single-card card_body
 *  range. Pure — no DOM, no clipboard — so tests can exercise every
 *  option combination directly. */
export function buildReferenceNodes(
  state: EditorState,
  effectivePtForNode: EffectivePtForNode,
  opts: CreateReferenceOptions,
): PMNode[] | null {
  const sel = state.selection;
  if (sel.empty) return null;

  // 1. Validate: every touched textblock must be a card_body in one card.
  const found = collectCardBodySelection(state, sel.from, sel.to);
  if (!found) return null;
  const { paragraphs, parentCard } = found;

  // 2. Compute the cite for the heading via the same logic the nav
  // pane uses (handles cite_mark bridging, the ampersand fix-up).
  // The cite portion is forced to all-caps by referenceHeadingText.
  const headingText = referenceHeadingText(collectCiteText(parentCard), opts);

  // 3. Build the output nodes.
  const fontSizeType = schema.marks['font_size']!;
  const fontColorType = schema.marks['font_color']!;
  const highlightType = schema.marks['highlight']!;
  const shadingType = schema.marks['shading']!;
  const bodyColor = opts.useGray50 ? '808080' : '000000';
  const stripHighlight = opts.highlightMode !== 'keep';

  const outNodes: PMNode[] = [];

  // Heading paragraph — 11pt body text, always black. Optionally bold /
  // italic / emphasized per the Create Reference settings. Generic
  // `paragraph` so it pastes cleanly into any context (PM normalization
  // will reshape it to card_body if the paste lands inside a card).
  if (opts.includeHeading) {
    const headingMarks: Mark[] = [];
    if (opts.headingBold) headingMarks.push(schema.marks['bold']!.create());
    if (opts.headingItalic) headingMarks.push(schema.marks['italic']!.create());
    // Emphasis and underline are mutually exclusive; emphasis wins if both set.
    if (opts.headingEmphasized) headingMarks.push(schema.marks['emphasis_mark']!.create());
    else if (opts.headingUnderlined) headingMarks.push(schema.marks['underline_mark']!.create());
    outNodes.push(
      schema.nodes['paragraph']!.create(null, schema.text(headingText, headingMarks)),
    );
  }

  for (const { node: para } of paragraphs) {
    const transformed: PMNode[] = [];
    para.forEach((child) => {
      if (!child.isText) {
        transformed.push(child);
        return;
      }
      // Strip the marks we're about to override (font_color, plus
      // font_size when shrinking and highlight unless keeping it).
      const filtered = child.marks.filter(
        (m) =>
          (!opts.shrink || m.type !== fontSizeType) &&
          m.type !== fontColorType &&
          (!stripHighlight || m.type !== highlightType),
      );

      // Re-build the mark set in rank order (Mark.addToSet handles
      // that for us).
      let newMarks = filtered as readonly import('prosemirror-model').Mark[];
      const hlMark = child.marks.find((m) => m.type === highlightType);
      if (hlMark && (opts.highlightMode === 'shading' || opts.highlightMode === 'convert')) {
        // 'shading' → the quiet grey; 'convert' → the highlight's own
        // color, matching the Convert Highlighting to Background command.
        const hex =
          opts.highlightMode === 'shading'
            ? REFERENCE_SHADING_HEX
            : highlightRgbFor(String(hlMark.attrs['color'] ?? 'yellow')) ?? 'FFFF00';
        newMarks = shadingType.create({ color: hex }).addToSet(newMarks);
      }
      if (opts.shrink) {
        const existingFs = child.marks.find((m) => m.type === fontSizeType);
        const currentPt = existingFs
          ? Number(existingFs.attrs['halfPoints'] ?? 22) / 2
          : effectivePtForNode(child, para);
        const newPt = Math.max(1, currentPt - opts.shrinkPt);
        newMarks = fontSizeType
          .create({ halfPoints: Math.round(newPt * 2) })
          .addToSet(newMarks);
      }
      newMarks = fontColorType.create({ color: bodyColor }).addToSet(newMarks);

      transformed.push(child.mark(newMarks));
    });
    // Use `card_body` for the body paragraphs (rather than the
    // generic `paragraph`). When pasted back into a card, this
    // matches the surrounding paragraph type exactly, so PM doesn't
    // have to lift the slice to a higher depth — a lift that scrolls
    // the viewport to a far-off paste landing position.
    outNodes.push(
      schema.nodes['card_body']!.create(null, Fragment.fromArray(transformed)),
    );
  }

  return outNodes;
}

export type CreateReferenceResult = 'copied' | 'invalid-selection' | 'clipboard-failed';

export async function createReference(
  state: EditorState,
  effectivePtForNode: EffectivePtForNode,
  opts: CreateReferenceOptions,
): Promise<CreateReferenceResult> {
  const outNodes = buildReferenceNodes(state, effectivePtForNode, opts);
  if (!outNodes) return 'invalid-selection';

  const outputFragment = Fragment.fromArray(outNodes);

  // 4. Serialize to HTML via PM's DOMSerializer so the marks
  // round-trip via the same data-* attribute spans we parse on
  // import — with the copier's appearance frozen in as inline styles
  // for other apps (clipboard-styles.ts), as every copy does.
  const serializer = withFrozenStyles(DOMSerializer.fromSchema(schema));
  const container = document.createElement('div');
  container.appendChild(serializer.serializeFragment(outputFragment));
  const html = container.innerHTML;

  // Plain-text fallback: paragraphs joined by blank lines.
  const plain = outNodes.map((n) => n.textContent).join('\n\n');

  // 5. Write to the clipboard via the shared host-first / retrying
  // path (see clipboard-write.ts for why one-shot renderer writes
  // fail one-click-in-N next to Word).
  const ok = await writeClipboardHtml(html, plain);
  return ok ? 'copied' : 'clipboard-failed';
}

/** Create Reference's live mode: mark the exact source selection, then copy a
 *  self_ref that is restored only when pasted back into this same document.
 *  The system clipboard still receives the regular static reference, so an
 *  external or cross-document paste can never create a dangling link. */
export async function createLiveReference(
  view: EditorView,
  effectivePtForNode: EffectivePtForNode,
  opts: CreateReferenceOptions,
): Promise<CreateReferenceResult> {
  const outNodes = buildReferenceNodes(view.state, effectivePtForNode, opts);
  if (!outNodes) return 'invalid-selection';

  const output = Fragment.fromArray(outNodes);
  const serializer = withFrozenStyles(DOMSerializer.fromSchema(schema));
  const container = document.createElement('div');
  container.appendChild(serializer.serializeFragment(output));

  const anchorId = newHeadingId();
  const anchorType = view.state.schema.marks['live_reference_source']!;
  const { from, to } = view.state.selection;
  const tr = view.state.tr;
  view.state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isInline) return true;
    const start = Math.max(from, pos);
    const end = Math.min(to, pos + node.nodeSize);
    if (start >= end) return false;
    const existing = node.marks.find((mark) => mark.type === anchorType);
    const ids = new Set(String(existing?.attrs['ids'] ?? '').split(' ').filter(Boolean));
    ids.add(anchorId);
    tr.removeMark(start, end, anchorType);
    tr.addMark(start, end, anchorType.create({ ids: [...ids].join(' ') }));
    return false;
  });
  view.dispatch(tr);

  const heading = opts.includeHeading ? outNodes[0]?.textContent ?? '' : '';
  const liveNode = createLiveReferenceNode(view.state.schema, anchorId, heading, {
    gray: opts.useGray50,
    bold: opts.headingBold,
    italic: opts.headingItalic,
    emphasized: opts.headingEmphasized,
    underlined: !opts.headingEmphasized && opts.headingUnderlined,
  });
  const clipboardSlice = new Slice(output, 0, 0);
  const ok = await writeClipboardHtml(
    container.innerHTML,
    outNodes.map((node) => node.textContent).join('\n\n'),
  );
  if (!ok) {
    clearLinkedCopy();
    const cleanup = view.state.tr;
    view.state.doc.descendants((node, pos) => {
      if (!node.isInline) return true;
      const anchor = node.marks.find((mark) => mark.type === anchorType);
      const ids = String(anchor?.attrs['ids'] ?? '').split(' ').filter(Boolean);
      if (!ids.includes(anchorId)) return false;
      cleanup.removeMark(pos, pos + node.nodeSize, anchorType);
      const remaining = ids.filter((id) => id !== anchorId);
      if (remaining.length) {
        cleanup.addMark(
          pos,
          pos + node.nodeSize,
          anchorType.create({ ids: remaining.join(' ') }),
        );
      }
      return false;
    });
    if (cleanup.docChanged) view.dispatch(cleanup);
    return 'clipboard-failed';
  }
  rememberLinkedCopy(new Slice(Fragment.from(liveNode), 0, 0), view, clipboardSlice);
  return 'copied';
}

/** The [before, after] range of the nearest enclosing card / analytic_unit
 *  container for `$pos`, or null if the cursor isn't inside one. */
function enclosingCardRange(
  $pos: import('prosemirror-model').ResolvedPos,
): { from: number; to: number } | null {
  for (let d = $pos.depth; d >= 1; d--) {
    const name = $pos.node(d).type.name;
    if (name === 'card' || name === 'analytic_unit') {
      return { from: $pos.before(d), to: $pos.after(d) };
    }
  }
  return null;
}

/**
 * "Lock Highlighting" — the in-place sibling of Create Reference. Converts
 * every `highlight` mark in scope to the light-gray "protected" `shading`
 * color, freeing the highlight layer so the user can re-highlight in one
 * pass. Scope follows the selection: with a selection it locks just the
 * selected range; with no selection it locks the whole card (or
 * analytic_unit) the cursor is in.
 *
 * Unlike Create Reference it edits in place, writes no `<<… FOR REFERENCE>>`
 * heading, leaves font size alone, and NEVER colors the underlying text gray
 * — its whole point is to keep the card editable. An existing `shading` mark
 * is left untouched (matching Create Reference), so re-running won't re-tint
 * already-locked runs.
 *
 * No-op (returns false) when there's no selection and the cursor isn't in a
 * card, or when the scope contains no highlights to lock.
 */
export function lockHighlighting(): Command {
  return (state, dispatch) => {
    const sel = state.selection;
    let from: number;
    let to: number;
    if (sel.empty) {
      const range = enclosingCardRange(sel.$from);
      if (!range) return false; // card-scoped, but not in a card
      ({ from, to } = range);
    } else {
      from = sel.from;
      to = sel.to;
    }

    const highlightType = schema.marks['highlight']!;
    const shadingType = schema.marks['shading']!;
    const tr = state.tr;
    let changed = false;

    state.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isText) return true;
      if (!node.marks.some((m) => m.type === highlightType)) return true;
      const start = Math.max(from, pos);
      const end = Math.min(to, pos + node.nodeSize);
      if (start >= end) return true;
      tr.removeMark(start, end, highlightType);
      // Convert to the protected gray background — but never overwrite an
      // existing shading (matches Create Reference).
      if (!node.marks.some((m) => m.type === shadingType)) {
        tr.addMark(start, end, shadingType.create({ color: REFERENCE_SHADING_HEX }));
      }
      changed = true;
      return true;
    });

    if (!changed) return false; // nothing highlighted in scope
    if (!dispatch) return true;
    dispatch(tr);
    return true;
  };
}
