/**
 * ProseMirror node specs.
 *
 * Design choice (see DECISIONS.md):
 *
 *   Most heading-level nodes (pocket, hat, block, analytic) are *flat
 *   paragraphs with inline content*, not tree containers. This matches
 *   how Word represents them in OOXML (paragraphs with Heading1-3 /
 *   Analytic styles, hierarchy implicit in document order + outline
 *   level). Tree-shaped grouping ("the cards under hat 2") is a derived
 *   view — the navigation panel walks paragraphs grouped by outline
 *   level — not a schema constraint.
 *
 *   `card` *is* tree-structured: it has a required `tag` child, optional
 *   cite_paragraph or analytic, and zero+ card_body paragraphs. This
 *   matches the user's mental model of cards as objects we can move /
 *   send / drag / select as units.
 *
 *   Heading-like nodes (pocket, hat, block, tag, analytic) carry a
 *   stable `id` attribute (UUID) for transclusion targeting per
 *   ARCHITECTURE.md §4 and §12.
 */

import type { NodeSpec, Node as PMNode } from 'prosemirror-model';
import { newHeadingId } from './ids.js';

/** Paragraph-level left indent in OOXML dxa (twentieths of a point;
 *  1440 dxa = 1 inch = 96 CSS px, so px = dxa / 15). Default 0.
 *  Applied to every node that serializes to `<w:p>` so the value
 *  round-trips through docx untouched. */
const indentAttr = {
  indent: {
    default: 0 as number,
    validate: (v: unknown) =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0,
  },
};

/** OOXML `<w:spacing>` attributes captured verbatim for round-trip.
 *  Stored as a plain `{ [attr]: value }` object whose keys are the
 *  OOXML attribute names (`w:before`, `w:after`, `w:line`,
 *  `w:lineRule`, etc.). Visual rendering is governed by per-type
 *  CSS, not this attr — see PROJECT.md's queued per-type display-
 *  spacing setting. Null when the source paragraph had no
 *  `<w:spacing>` element. */
const spacingAttr = {
  spacing: {
    default: null as Record<string, string> | null,
    validate: (v: unknown) =>
      v === null ||
      (typeof v === 'object' && v !== null && !Array.isArray(v)),
  },
};

const headingAttrs = {
  id: {
    default: null as string | null,
    validate: (v: unknown) => (v === null || typeof v === 'string'),
  },
  ...indentAttr,
  ...spacingAttr,
};

/**
 * Auto-numbering skeleton (display-only; see NUMBERING_PLAN.md). The number
 * GLYPH ("1", "a") is NEVER stored — only the authorial role and restart flag,
 * from which `computeNumbering` derives numbers positionally at render time.
 *
 *   numRole    'none' = skipped, transparent to both counters (the default);
 *              'number' = a level-0 count; 'sub' = a level-1 letter, subordinate
 *              to the current number.
 *   numRestart false (the card default) = numbering flows through this unit;
 *              true = the count restarts here.
 *
 * Lives on the card UNIT (`card` / `analytic_unit`). `block` carries only
 * `numRestart`, but defaulting TRUE (each block starts its own count unless the
 * author flips it to "continue").
 */
const numberingCardAttrs = {
  numRole: {
    default: 'none' as 'none' | 'number' | 'sub',
    validate: (v: unknown) => v === 'none' || v === 'number' || v === 'sub',
  },
  numRestart: {
    default: false as boolean,
    validate: (v: unknown) => typeof v === 'boolean',
  },
};
const blockAttrs = {
  ...headingAttrs,
  numRestart: {
    default: true as boolean,
    validate: (v: unknown) => typeof v === 'boolean',
  },
};

/** Convert a paragraph node's `indent` (dxa) to an inline CSS
 *  declaration, or return empty when unindented. */
function indentToStyle(indent: unknown): string {
  const n = Number(indent ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  return `padding-left: ${n / 15}px`;
}

/** Read a paragraph's left indent from its rendered HTML — used
 *  by parseDOM for round-trip through our own toDOM and for paste
 *  from sources that wrote padding-left. Returns 0 when absent
 *  or non-px. */
function readIndentFromStyle(dom: HTMLElement): number {
  const v = dom.style.paddingLeft;
  if (!v) return 0;
  const m = v.match(/^(\d+(?:\.\d+)?)px$/);
  if (!m) return 0;
  return Math.max(0, Math.round(parseFloat(m[1]!) * 15));
}

/**
 * Per-card `contain-intrinsic-height` estimate, emitted as an inline
 * style by the `card` / `analytic_unit` toDOM.
 *
 * Cards carry `content-visibility: auto` (style.css), so a card that
 * has never been on screen is laid out as a placeholder box whose
 * height comes from `contain-intrinsic-size`. With the stylesheet's
 * one-size-fits-all 200px fallback, a nav jump into unvisited
 * territory runs its scroll math on guesses that are wrong by up to a
 * screenful per card — and the browser then spends SECONDS of main
 * thread correcting layout card-by-card as each materialization
 * replaces a guess with a real height and shifts everything below
 * (measured: 8 nav jumps on a ~1MB doc = ~1.8s of 60–250ms stalls;
 * with per-card estimates ~0.3s).
 *
 * The estimate only has to beat "200px for everything": the `auto`
 * keyword means the browser memoizes a card's REAL height after its
 * first render and ignores this value from then on. Calibrated for
 * default typography (11pt body ≈ 21px line at the editor's default
 * width, ~95 chars/line) — zoom, narrow multi-pane slots, images and
 * tables all make it drift, which is fine; it stays far closer to
 * truth than the fixed fallback. Deliberately reads only textContent
 * and childCount: toDOM must never touch layout.
 */
function intrinsicHeightStyle(node: PMNode): string {
  const chars = node.textContent.length;
  const paras = node.childCount;
  const est = Math.max(40, Math.round((chars / 95) * 21 + paras * 8 + 24));
  return `contain-intrinsic-height: auto ${est}px`;
}

/**
 * Block-level content legal at the doc root. Note: `tag` and `analytic`
 * are *not* in this list — tags only appear as the required first child
 * of a `card`, analytics only appear inside an `analytic_unit` (or as a
 * cite-position alternative inside a card).
 *
 * Order matters: ProseMirror's `splitBlock` calls `defaultBlockAt` to
 * pick the type for a freshly-created paragraph at the doc level (e.g.
 * Enter at the end of an existing paragraph), and `defaultBlockAt`
 * returns the FIRST textblock in the alternation. Putting `paragraph`
 * first ensures Enter on a normal paragraph creates another normal
 * paragraph rather than a Pocket. The same trick is used inside `card`
 * (see its content expression).
 */
const BLOCK_CONTENT =
  '(paragraph | pocket | hat | block | card | analytic_unit | undertag | cite_paragraph | card_body | table | transclusion_ref | self_ref)*';

export const nodes: { [name: string]: NodeSpec } = {
  /** Top-level container. Sequence of block-level content. */
  doc: { content: BLOCK_CONTENT },

  /** A run of inline content. Plain text + marks. */
  text: { group: 'inline' },

  /**
   * Inline image. Round-trips to OOXML `<w:drawing><wp:inline>...`.
   *
   * The image bytes are stored as base64 in the `data` attr so the doc
   * is self-contained and survives JSON round-trips through localStorage,
   * collaboration sync, undo/redo, etc. without a separate manifest.
   * `widthEmu` / `heightEmu` carry the original OOXML dimensions in
   * English Metric Units (914400 EMU per inch); rendering converts to
   * pixels at 96dpi.
   *
   * Atomic + draggable: ProseMirror treats the image as an indivisible
   * inline glyph — cursor goes around it, not into it. `draggable` is
   * currently inert: the editor swallows all `dragstart` events (see
   * the text-drag-suppression plugin in `editor/index.ts`), so image
   * drag-and-drop needs a carve-out there before it works.
   */
  image: {
    inline: true,
    group: 'inline',
    atom: true,
    draggable: true,
    attrs: {
      data: {
        default: '',
        validate: (v: unknown) => typeof v === 'string',
      },
      contentType: {
        default: 'image/png',
        validate: (v: unknown) =>
          typeof v === 'string' && /^image\//.test(v),
      },
      widthEmu: {
        default: 0,
        validate: (v: unknown) =>
          typeof v === 'number' && Number.isFinite(v) && v >= 0,
      },
      heightEmu: {
        default: 0,
        validate: (v: unknown) =>
          typeof v === 'number' && Number.isFinite(v) && v >= 0,
      },
      alt: {
        default: '',
        validate: (v: unknown) => typeof v === 'string',
      },
    },
    parseDOM: [
      {
        tag: 'img[data-pmd-image]',
        getAttrs: (dom: HTMLElement) => {
          const src = dom.getAttribute('src') ?? '';
          const m = src.match(/^data:([^;]+);base64,(.+)$/);
          if (!m) return false;
          const widthEmu = parseInt(dom.getAttribute('data-width-emu') ?? '0', 10);
          const heightEmu = parseInt(dom.getAttribute('data-height-emu') ?? '0', 10);
          return {
            data: m[2],
            contentType: m[1],
            widthEmu: Number.isFinite(widthEmu) ? widthEmu : 0,
            heightEmu: Number.isFinite(heightEmu) ? heightEmu : 0,
            alt: dom.getAttribute('alt') ?? '',
          };
        },
      },
      {
        // Placeholder span — for non-browser-renderable formats (EMF /
        // WMF / TIFF). Carries the same data attributes so re-saving
        // through DOM round-trip works.
        tag: 'span[data-pmd-image]',
        getAttrs: (dom: HTMLElement) => {
          const data = dom.getAttribute('data-image-data') ?? '';
          const contentType = dom.getAttribute('data-content-type') ?? 'application/octet-stream';
          const widthEmu = parseInt(dom.getAttribute('data-width-emu') ?? '0', 10);
          const heightEmu = parseInt(dom.getAttribute('data-height-emu') ?? '0', 10);
          return {
            data,
            contentType,
            widthEmu: Number.isFinite(widthEmu) ? widthEmu : 0,
            heightEmu: Number.isFinite(heightEmu) ? heightEmu : 0,
            alt: dom.getAttribute('data-alt') ?? '',
          };
        },
      },
    ],
    toDOM: (node) => {
      const data = String(node.attrs['data'] ?? '');
      const contentType = String(node.attrs['contentType'] ?? 'image/png');
      const widthEmu = Number(node.attrs['widthEmu'] ?? 0);
      const heightEmu = Number(node.attrs['heightEmu'] ?? 0);
      const alt = String(node.attrs['alt'] ?? '');

      // 914400 EMU per inch; 96 px per inch → 9525 EMU per pixel.
      const widthPx = widthEmu > 0 ? Math.round(widthEmu / 9525) : 0;
      const heightPx = heightEmu > 0 ? Math.round(heightEmu / 9525) : 0;

      // Browser-renderable raster + svg formats: emit as <img data:>.
      // Non-renderable formats (EMF, WMF, TIFF, octet-stream): emit a
      // styled placeholder span instead of a broken image tag. Bytes
      // are still preserved on the element so round-trip works.
      const RENDERABLE = new Set([
        'image/png', 'image/jpeg', 'image/gif',
        'image/webp', 'image/bmp', 'image/svg+xml',
      ]);

      if (data && RENDERABLE.has(contentType)) {
        const attrs: Record<string, string> = {
          'data-pmd-image': '',
          src: `data:${contentType};base64,${data}`,
          alt,
          'data-width-emu': String(widthEmu),
          'data-height-emu': String(heightEmu),
          style: 'max-width: 100%; height: auto;',
        };
        if (widthPx > 0) attrs['width'] = String(widthPx);
        if (heightPx > 0) attrs['height'] = String(heightPx);
        return ['img', attrs];
      }

      // Placeholder for unsupported formats. Visual styling lives in
      // CSS (.pmd-image-placeholder); only per-instance dimensions are
      // inline so they don't clobber other rules — particularly the
      // `display: none` read-mode override.
      const sizeStyle = widthPx > 0 && heightPx > 0
        ? `width: ${widthPx}px; height: ${heightPx}px;`
        : 'min-width: 80px; min-height: 80px;';
      const subtype = contentType.replace(/^image\//, '').replace(/^x-/, '');
      const label = `[${subtype} image]`;
      return [
        'span',
        {
          'data-pmd-image': '',
          'data-image-data': data,
          'data-content-type': contentType,
          'data-width-emu': String(widthEmu),
          'data-height-emu': String(heightEmu),
          'data-alt': alt,
          class: 'pmd-image-placeholder',
          title: alt ? `${label} — ${alt}` : label,
          style: sizeStyle,
        },
        label,
      ];
    },
  },

  /**
   * Footnote / endnote reference — round-trips OOXML
   * `<w:footnoteReference w:id>` (+ `word/footnotes.xml`) and the
   * endnote equivalents.
   *
   * Like `image`, the node is self-contained: the note's body is
   * flattened into the `content` attr as paragraphs of simplified runs
   * ({ text, bold?, italic?, underline?, link? }) so it survives JSON
   * round-trips (.cmir, clipboard, undo) with no sidecar. Debate
   * footnotes are near-always read-only source citations, so the
   * simplified-run model deliberately avoids ProseMirror's
   * nested-content footnote pattern (inner EditorView, selection/undo
   * handoff) — display + light editing happens in the popover
   * (footnote-popover.ts).
   *
   * Rendering: an empty <sup>; the visible number is a pure CSS
   * counter (see .pmd-footnote-ref in style.css), so ordinals track
   * document order with zero bookkeeping.
   */
  footnote: {
    inline: true,
    group: 'inline',
    atom: true,
    attrs: {
      /** 'footnote' (page bottom) or 'endnote' (document end). */
      kind: {
        default: 'footnote',
        validate: (v: unknown) => v === 'footnote' || v === 'endnote',
      },
      /** Paragraphs of simplified runs — see FootnoteContent. */
      content: {
        default: [],
        validate: (v: unknown) =>
          Array.isArray(v) && v.every((p) => Array.isArray(p)),
      },
    },
    parseDOM: [
      {
        tag: 'sup.pmd-footnote-ref',
        getAttrs: (dom: HTMLElement) => {
          const kind = dom.getAttribute('data-kind') === 'endnote' ? 'endnote' : 'footnote';
          let content: unknown = [];
          try {
            content = JSON.parse(dom.getAttribute('data-content') ?? '[]');
          } catch {
            content = [];
          }
          if (!Array.isArray(content) || !content.every((p) => Array.isArray(p))) content = [];
          return { kind, content };
        },
      },
    ],
    toDOM: (node) => [
      'sup',
      {
        class: `pmd-footnote-ref pmd-footnote-kind-${String(node.attrs['kind'])}`,
        'data-kind': String(node.attrs['kind']),
        'data-content': JSON.stringify(node.attrs['content'] ?? []),
      },
    ],
  },

  /**
   * Transclusion "live zone" — a region mirroring the contents under a heading
   * in another CardMirror file (see TRANSCLUSION_PLAN.md).
   *
   * The transcluded cards are REAL child nodes (same block content as the doc),
   * so the zone is self-contained (a `.cmir` renders its zones anywhere it's
   * moved; a judge with none of the source files still sees the evidence), the
   * cards show up in the outline and Find, and — crucially — the zone is
   * EDITABLE: you can contextualise a tag or its highlighting in place without
   * breaking the link. Divergence from the last-pulled source is tracked by
   * `source_content_hash` (the NodeView shows an "edited" dot). Refresh
   * (desktop only) re-reads the source and replaces the children (confirming
   * first when edited); Detach unwraps the children and drops the link;
   * `.docx` export flattens (the zone is a transparent container).
   *
   * `isolating` keeps edits inside the zone (it moves and merges as a unit).
   * Rendering (the rail chrome + editable body) is the NodeView's job
   * (transclusion-nodeview.ts). The `.cmir` path round-trips via `toJSON`
   * (attrs + children serialize generically), independent of toDOM.
   */
  transclusion_ref: {
    content: BLOCK_CONTENT,
    isolating: true,
    defining: true,
    attrs: {
      /** Path to the source `.cmir`. Relative to the transcluding doc when
       *  `source_ref_base` is 'doc', or relative to a shared library root when
       *  'root' (both files live in the same team Dropbox folder). */
      source_ref: {
        default: '',
        validate: (v: unknown) => typeof v === 'string',
      },
      /** How `source_ref` is anchored: 'doc' (relative to this document) or
       *  'root' (relative to a configured library/Dropbox root — survives the
       *  doc being moved within the shared folder). */
      source_ref_base: {
        default: 'doc',
        validate: (v: unknown) => v === 'doc' || v === 'root',
      },
      /** Stable heading UUID of the target section in the source. */
      source_heading_id: {
        default: '',
        validate: (v: unknown) => typeof v === 'string',
      },
      /** The absolute path the ref was created against, used ONLY as a resolve
       *  tie-breaker: if this exact path still exists here (and inside an allowed
       *  root), it's the definitively-intended file — a local copy vs. the shared
       *  original, or a same-machine refresh. Machine-specific, so it silently
       *  doesn't match on another teammate's machine and resolution falls back to
       *  the relative `source_ref`. */
      source_abs: {
        default: '',
        validate: (v: unknown) => typeof v === 'string',
      },
      /** Hash of the children AS LAST PULLED from source. The zone is "edited"
       *  when the current children hash differs — that's how local
       *  contextualisation is detected without breaking the link. */
      source_content_hash: {
        default: '',
        validate: (v: unknown) => typeof v === 'string',
      },
      /** Id-INDEPENDENT hash of the source section as last pulled. Unlike
       *  `source_content_hash` (which includes the freshly-stamped child ids and
       *  so only detects LOCAL edits), this is the source's content signature
       *  ignoring heading ids — so a later read of the source can be compared to
       *  it to tell whether the SOURCE has moved on ("diverged"), independent of
       *  any local edits to the mirror. '' on zones created before this existed;
       *  such zones fall back to the mirror's own shape when unedited. */
      source_shape_hash: {
        default: '',
        validate: (v: unknown) => typeof v === 'string',
      },
      /** Epoch ms of the last successful resolve (0 = never refreshed). */
      last_refreshed: {
        default: 0,
        validate: (v: unknown) => typeof v === 'number' && Number.isFinite(v),
      },
      /** Human breadcrumb for the header bar, e.g. "Impacts › Decline…". */
      source_label: {
        default: '',
        validate: (v: unknown) => typeof v === 'string',
      },
    },
    parseDOM: [
      {
        tag: 'div.pmd-transclusion-ref',
        // Content (children) is parsed from the div's contents; only the
        // link metadata comes from data-attributes.
        getAttrs: (dom: HTMLElement) => {
          const lr = Number(dom.getAttribute('data-last-refreshed') ?? '0');
          return {
            source_ref: dom.getAttribute('data-source-ref') ?? '',
            source_ref_base:
              dom.getAttribute('data-source-ref-base') === 'root' ? 'root' : 'doc',
            source_heading_id: dom.getAttribute('data-source-heading-id') ?? '',
            source_content_hash: dom.getAttribute('data-source-content-hash') ?? '',
            last_refreshed: Number.isFinite(lr) ? lr : 0,
            source_label: dom.getAttribute('data-source-label') ?? '',
            source_abs: dom.getAttribute('data-source-abs') ?? '',
          };
        },
      },
    ],
    toDOM: (node) => [
      'div',
      {
        class: 'pmd-transclusion-ref',
        'data-source-ref': String(node.attrs['source_ref'] ?? ''),
        'data-source-ref-base': String(node.attrs['source_ref_base'] ?? 'doc'),
        'data-source-heading-id': String(node.attrs['source_heading_id'] ?? ''),
        'data-source-content-hash': String(node.attrs['source_content_hash'] ?? ''),
        'data-last-refreshed': String(node.attrs['last_refreshed'] ?? 0),
        'data-source-label': String(node.attrs['source_label'] ?? ''),
        'data-source-abs': String(node.attrs['source_abs'] ?? ''),
      },
      0,
    ],
  },

  /**
   * Intra-document live window ("self-transclusion"). A by-REFERENCE, read-only
   * projection of another section of THIS document: it stores only which section
   * it mirrors (`source_heading_id`) — no content copy — and its NodeView renders
   * that section's current content live (self-transclusion-nodeview.ts). `atom`:
   * you edit at the source, never through the window (which is what makes it
   * conflict-free — one editable copy, N live views). Flattens to plain cards on
   * `.docx` export (Word has no live-window concept); round-trips by reference in
   * `.cmir` (the source is in the same file, so the file stays self-contained).
   */
  self_ref: {
    // A live view holds its mirrored section as REAL, read-only child content
    // (not a leaf atom). That's what makes native selection just work — there's
    // no atom boundary to get stuck on; a selection flows through it exactly like
    // a linked copy (`transclusion_ref`). The children are DERIVED: a plugin keeps
    // them equal to the projected source (id-less), edits inside are blocked by a
    // filterTransaction, and the children are kept OUT of collab sync (a
    // loro-prosemirror patch) so each peer re-derives them locally from the shared
    // source — never a CRDT value, so no concurrent-re-projection conflict.
    content: BLOCK_CONTENT,
    isolating: true,
    defining: true,
    selectable: true,
    attrs: {
      /** Stable heading id of the mirrored section, in THIS document. */
      source_heading_id: {
        default: '',
        validate: (v: unknown) => typeof v === 'string',
      },
      /** Human label for the window header, e.g. "↳ Impacts". */
      source_label: {
        default: '',
        validate: (v: unknown) => typeof v === 'string',
      },
      /** Exact-selection source. Empty means the regular heading-based view. */
      source_anchor_id: {
        default: '',
        validate: (v: unknown) => typeof v === 'string',
      },
      /** Non-empty only for a Create Live Reference view. */
      reference_heading: {
        default: '',
        validate: (v: unknown) => typeof v === 'string',
      },
      reference_gray: {
        default: false,
        validate: (v: unknown) => typeof v === 'boolean',
      },
      reference_heading_bold: {
        default: false,
        validate: (v: unknown) => typeof v === 'boolean',
      },
      reference_heading_italic: {
        default: false,
        validate: (v: unknown) => typeof v === 'boolean',
      },
      reference_heading_emphasized: {
        default: false,
        validate: (v: unknown) => typeof v === 'boolean',
      },
      reference_heading_underlined: {
        default: false,
        validate: (v: unknown) => typeof v === 'boolean',
      },
      reference_shrink: {
        default: false,
        validate: (v: unknown) => typeof v === 'boolean',
      },
      reference_shrink_pt: {
        default: 3,
        validate: (v: unknown) => typeof v === 'number' && Number.isFinite(v),
      },
      reference_highlight_mode: {
        default: 'shading',
        validate: (v: unknown) =>
          v === 'shading' || v === 'convert' || v === 'keep' || v === 'remove',
      },
    },
    parseDOM: [
      {
        tag: 'div.pmd-self-ref',
        getAttrs: (dom: HTMLElement) => ({
          source_heading_id: dom.getAttribute('data-source-heading-id') ?? '',
          source_label: dom.getAttribute('data-source-label') ?? '',
          source_anchor_id: dom.getAttribute('data-source-anchor-id') ?? '',
          reference_heading: dom.getAttribute('data-reference-heading') ?? '',
          reference_gray: dom.getAttribute('data-reference-gray') === 'true',
          reference_heading_bold: dom.getAttribute('data-reference-heading-bold') === 'true',
          reference_heading_italic: dom.getAttribute('data-reference-heading-italic') === 'true',
          reference_heading_emphasized: dom.getAttribute('data-reference-heading-emphasized') === 'true',
          reference_heading_underlined: dom.getAttribute('data-reference-heading-underlined') === 'true',
          reference_shrink: dom.getAttribute('data-reference-shrink') === 'true',
          reference_shrink_pt: Number(dom.getAttribute('data-reference-shrink-pt') ?? '3'),
          reference_highlight_mode: dom.getAttribute('data-reference-highlight-mode') ?? 'shading',
        }),
      },
    ],
    toDOM: (node) => [
      'div',
      {
        class: 'pmd-self-ref',
        'data-source-heading-id': String(node.attrs['source_heading_id'] ?? ''),
        'data-source-label': String(node.attrs['source_label'] ?? ''),
        'data-source-anchor-id': String(node.attrs['source_anchor_id'] ?? ''),
        'data-reference-heading': String(node.attrs['reference_heading'] ?? ''),
        'data-reference-gray': String(node.attrs['reference_gray'] === true),
        'data-reference-heading-bold': String(node.attrs['reference_heading_bold'] === true),
        'data-reference-heading-italic': String(node.attrs['reference_heading_italic'] === true),
        'data-reference-heading-emphasized': String(node.attrs['reference_heading_emphasized'] === true),
        'data-reference-heading-underlined': String(node.attrs['reference_heading_underlined'] === true),
        'data-reference-shrink': String(node.attrs['reference_shrink'] === true),
        'data-reference-shrink-pt': String(node.attrs['reference_shrink_pt'] ?? 3),
        'data-reference-highlight-mode': String(node.attrs['reference_highlight_mode'] ?? 'shading'),
      },
      0,
    ],
  },

  /**
   * Heading paragraphs — flat in document order, hierarchy via the
   * derived outline view, not schema containment.
   */
  pocket: {
    content: 'inline*',
    attrs: headingAttrs,
    defining: true,
    parseDOM: [{
      tag: 'h1.pmd-pocket',
      getAttrs: (dom: HTMLElement) => ({ indent: readIndentFromStyle(dom) }),
    }],
    toDOM: (node) => {
      const attrs: Record<string, string> = {
        class: 'pmd-pocket',
        'data-id': String(node.attrs['id'] ?? ''),
      };
      const style = indentToStyle(node.attrs['indent']);
      if (style) attrs['style'] = style;
      return ['h1', attrs, 0];
    },
  },

  hat: {
    content: 'inline*',
    attrs: headingAttrs,
    defining: true,
    parseDOM: [{
      tag: 'h2.pmd-hat',
      getAttrs: (dom: HTMLElement) => ({ indent: readIndentFromStyle(dom) }),
    }],
    toDOM: (node) => {
      const attrs: Record<string, string> = {
        class: 'pmd-hat',
        'data-id': String(node.attrs['id'] ?? ''),
      };
      const style = indentToStyle(node.attrs['indent']);
      if (style) attrs['style'] = style;
      return ['h2', attrs, 0];
    },
  },

  block: {
    content: 'inline*',
    attrs: blockAttrs,
    defining: true,
    parseDOM: [{
      tag: 'h3.pmd-block',
      getAttrs: (dom: HTMLElement) => ({
        indent: readIndentFromStyle(dom),
        // Default is restart (true); only a "continue" block carries the attr.
        numRestart: dom.getAttribute('data-num-restart') !== 'false',
      }),
    }],
    toDOM: (node) => {
      const attrs: Record<string, string> = {
        class: 'pmd-block',
        'data-id': String(node.attrs['id'] ?? ''),
      };
      const style = indentToStyle(node.attrs['indent']);
      if (style) attrs['style'] = style;
      // Emit only the non-default: a block that CONTINUES the previous count.
      if (node.attrs['numRestart'] === false) attrs['data-num-restart'] = 'false';
      return ['h3', attrs, 0];
    },
  },

  /**
   * A card: required tag followed by any combination of supplementary
   * paragraphs (undertags, cite, card body) plus inline tables.
   *
   * Analytics are NOT card children: an analytic anchors its own
   * `analytic_unit`. An analytic that ends up inside a card — a legacy
   * `.cmir` file, or a `.docx` whose author put an Analytic paragraph
   * under a tag — is split out into a trailing analytic_unit (that
   * absorbs the content below it) on load (`schema/migrate.ts`'s
   * `splitInCardAnalytics`) and on import, mirroring what pasting an
   * analytic into a card already does.
   *
   * Content after the tag is order-free rather than a strict
   * `tag undertag* cite_paragraph? card_body*` sequence, so editing
   * operations can insert a card_body in any position — e.g., Enter at
   * end of tag drops a new body directly under the tag, above any
   * pre-existing cite/body.
   *
   * Undertags belong to the tag they follow — they don't mark a card
   * boundary.
   */
  card: {
    // Order matters: ProseMirror's splitBlock command (and other
    // schema-driven defaults) calls `defaultBlockAt` to pick the
    // "natural" type for a freshly-created paragraph in this slot.
    // It returns the FIRST textblock in the alternation. Putting
    // `card_body` first ensures that pressing Enter at the start of a
    // cite (or anywhere else inside a card) creates a normal body
    // paragraph — never an undertag. Undertag styling is reserved for
    // text the user explicitly opts into.
    content: 'tag (card_body | undertag | cite_paragraph | table)*',
    defining: true,
    isolating: true,
    attrs: numberingCardAttrs,
    parseDOM: [{
      tag: 'div.pmd-card',
      getAttrs: (dom: HTMLElement) => {
        const r = dom.getAttribute('data-num-role');
        return {
          numRole: r === 'number' || r === 'sub' ? r : 'none',
          numRestart: dom.getAttribute('data-num-restart') === 'true',
        };
      },
    }],
    toDOM: (node) => {
      const attrs: Record<string, string> = {
        class: 'pmd-card',
        style: intrinsicHeightStyle(node),
      };
      const role = node.attrs['numRole'];
      if (role && role !== 'none') attrs['data-num-role'] = String(role);
      if (node.attrs['numRestart'] === true) attrs['data-num-restart'] = 'true';
      return ['div', attrs, 0];
    },
  },

  /** Card label. Heading-level outline-4 with stable id. Card-only. */
  tag: {
    content: 'inline*',
    attrs: headingAttrs,
    defining: true,
    parseDOM: [{
      tag: 'h4.pmd-tag',
      getAttrs: (dom: HTMLElement) => ({ indent: readIndentFromStyle(dom) }),
    }],
    toDOM: (node) => {
      const attrs: Record<string, string> = {
        class: 'pmd-tag',
        'data-id': String(node.attrs['id'] ?? ''),
      };
      const style = indentToStyle(node.attrs['indent']);
      if (style) attrs['style'] = style;
      return ['h4', attrs, 0];
    },
  },

  /** Cite paragraph. Used inside a card or at the doc level. */
  cite_paragraph: {
    content: 'inline*',
    attrs: { ...indentAttr, ...spacingAttr },
    parseDOM: [{
      tag: 'p.pmd-cite-para',
      getAttrs: (dom: HTMLElement) => ({ indent: readIndentFromStyle(dom) }),
    }],
    toDOM: (node) => {
      const attrs: Record<string, string> = { class: 'pmd-cite-para' };
      const style = indentToStyle(node.attrs['indent']);
      if (style) attrs['style'] = style;
      return ['p', attrs, 0];
    },
  },

  /** Card body paragraph — implicit Normal style on export. */
  card_body: {
    content: 'inline*',
    attrs: { ...indentAttr, ...spacingAttr },
    parseDOM: [{
      tag: 'p.pmd-card-body',
      getAttrs: (dom: HTMLElement) => ({ indent: readIndentFromStyle(dom) }),
    }],
    toDOM: (node) => {
      const attrs: Record<string, string> = { class: 'pmd-card-body' };
      const style = indentToStyle(node.attrs['indent']);
      if (style) attrs['style'] = style;
      return ['p', attrs, 0];
    },
  },

  /**
   * Analytic paragraph — outline-level-4 with stable id. Distinct from
   * a tag in styling (color #1F3864) and semantic role. Appears as the
   * required first child of an `analytic_unit`, OR as a cite-position
   * alternative inside a `card`.
   */
  analytic: {
    content: 'inline*',
    attrs: headingAttrs,
    defining: true,
    parseDOM: [{
      tag: 'p.pmd-analytic',
      getAttrs: (dom: HTMLElement) => ({ indent: readIndentFromStyle(dom) }),
    }],
    toDOM: (node) => {
      const attrs: Record<string, string> = {
        class: 'pmd-analytic',
        'data-id': String(node.attrs['id'] ?? ''),
      };
      const style = indentToStyle(node.attrs['indent']);
      if (style) attrs['style'] = style;
      return ['p', attrs, 0];
    },
  },

  /**
   * An analytic-rooted unit, peer to `card`. Required analytic, optional
   * undertag(s), zero+ body paragraphs, and cite_paragraphs. Cite
   * paragraphs aren't a conventional part of an analytic — analytics
   * are commentary, not external evidence — but allowing them here
   * keeps cite-paste uniform across card and analytic_unit
   * destinations and avoids forced new-card creation when the user
   * just wants a cite below an analytic's body. Drags as a unit.
   */
  analytic_unit: {
    // Same alternation shape as `card` — see its content expression's
    // comment for why `card_body` comes first.
    content: 'analytic (card_body | undertag | cite_paragraph | table)*',
    defining: true,
    isolating: true,
    attrs: numberingCardAttrs,
    parseDOM: [{
      tag: 'div.pmd-analytic-unit',
      getAttrs: (dom: HTMLElement) => {
        const r = dom.getAttribute('data-num-role');
        return {
          numRole: r === 'number' || r === 'sub' ? r : 'none',
          numRestart: dom.getAttribute('data-num-restart') === 'true',
        };
      },
    }],
    toDOM: (node) => {
      const attrs: Record<string, string> = {
        class: 'pmd-analytic-unit',
        style: intrinsicHeightStyle(node),
      };
      const role = node.attrs['numRole'];
      if (role && role !== 'none') attrs['data-num-role'] = String(role);
      if (node.attrs['numRestart'] === true) attrs['data-num-restart'] = 'true';
      return ['div', attrs, 0];
    },
  },

  /** Undertag paragraph (linked to UndertagChar). */
  undertag: {
    content: 'inline*',
    attrs: { ...indentAttr, ...spacingAttr },
    parseDOM: [{
      tag: 'p.pmd-undertag',
      getAttrs: (dom: HTMLElement) => ({ indent: readIndentFromStyle(dom) }),
    }],
    toDOM: (node) => {
      const attrs: Record<string, string> = { class: 'pmd-undertag' };
      const style = indentToStyle(node.attrs['indent']);
      if (style) attrs['style'] = style;
      return ['p', attrs, 0];
    },
  },

  /** Generic body paragraph — implicit Normal style. Optional
   *  `alignment` attr surfaces OOXML's `<w:jc>` for paragraphs in
   *  contexts where alignment matters (table cells especially —
   *  Word tables routinely center their cell content). Null means
   *  default (left/inherited). Values match Word's set. */
  paragraph: {
    content: 'inline*',
    attrs: {
      alignment: {
        default: null as 'left' | 'center' | 'right' | 'justify' | null,
        validate: (v: unknown) =>
          v === null ||
          v === 'left' ||
          v === 'center' ||
          v === 'right' ||
          v === 'justify',
      },
      ...indentAttr,
      ...spacingAttr,
    },
    parseDOM: [
      {
        tag: 'p',
        getAttrs: (dom: HTMLElement) => {
          const align = dom.style.textAlign || null;
          return {
            alignment:
              align === 'left' ||
              align === 'center' ||
              align === 'right' ||
              align === 'justify'
                ? align
                : null,
            indent: readIndentFromStyle(dom),
          };
        },
      },
    ],
    toDOM: (node) => {
      const align = node.attrs['alignment'] as string | null;
      const indentStyle = indentToStyle(node.attrs['indent']);
      const styles: string[] = [];
      if (align) styles.push(`text-align: ${align}`);
      if (indentStyle) styles.push(indentStyle);
      const attrs: Record<string, string> = {};
      if (styles.length > 0) attrs['style'] = styles.join('; ');
      return ['p', attrs, 0];
    },
  },

  // ---- Tables (prosemirror-tables compatible) -------------------
  // Round-tripped from OOXML <w:tbl> / <w:tr> / <w:tc>. Cells hold
  // generic paragraphs only — no cards / analytics / pockets etc.
  // inside cells (matches OOXML's "no nesting of structural debate
  // elements inside table cells" practice).
  //
  // Cell attrs follow prosemirror-tables' convention so the
  // built-in commands (addRowAfter, deleteRow, mergeCells, etc.)
  // work without adaptation.

  table: {
    content: 'table_row+',
    tableRole: 'table',
    isolating: true,
    group: 'block',
    attrs: {
      // Opaque OOXML `<w:tblPr>` inner content captured at import time
      // and re-emitted verbatim on export. Lets us round-trip table-
      // level borders / styles / shading without modeling each
      // property in the schema. New tables created in the editor have
      // this null and get the exporter's default tblPr.
      rawTblPr: {
        default: null as string | null,
        validate: (v: unknown) => v === null || typeof v === 'string',
      },
    },
    parseDOM: [{ tag: 'table' }],
    toDOM: () => ['table', { class: 'pmd-table' }, ['tbody', 0]],
  },

  table_row: {
    content: '(table_cell | table_header)*',
    tableRole: 'row',
    parseDOM: [{ tag: 'tr' }],
    toDOM: () => ['tr', 0],
  },

  table_cell: {
    content: 'paragraph+',
    attrs: {
      colspan: { default: 1, validate: (v: unknown) => typeof v === 'number' && v >= 1 },
      rowspan: { default: 1, validate: (v: unknown) => typeof v === 'number' && v >= 1 },
      colwidth: {
        default: null as number[] | null,
        validate: (v: unknown) =>
          v === null || (Array.isArray(v) && v.every((n) => typeof n === 'number')),
      },
      // Opaque OOXML `<w:tcPr>` children captured at import time
      // (everything except `gridSpan`, `vMerge`, and `tcW`, which are
      // derived from the cell's structural attrs). Re-emitted after
      // the structural bits on export so per-cell borders / shading /
      // vAlign etc. round-trip.
      rawTcPr: {
        default: null as string | null,
        validate: (v: unknown) => v === null || typeof v === 'string',
      },
    },
    tableRole: 'cell',
    isolating: true,
    parseDOM: [
      {
        tag: 'td',
        getAttrs: (dom: HTMLElement) => readCellAttrs(dom),
      },
    ],
    toDOM: (node) => ['td', cellAttrsToDom(node.attrs), 0],
  },

  // Defined for prosemirror-tables compatibility even though OOXML
  // doesn't distinguish header cells from body cells. Importer always
  // produces table_cell; we keep table_header so the plugin's
  // commands (e.g. toggleHeaderRow) function should the user invoke
  // them.
  table_header: {
    content: 'paragraph+',
    attrs: {
      colspan: { default: 1, validate: (v: unknown) => typeof v === 'number' && v >= 1 },
      rowspan: { default: 1, validate: (v: unknown) => typeof v === 'number' && v >= 1 },
      colwidth: {
        default: null as number[] | null,
        validate: (v: unknown) =>
          v === null || (Array.isArray(v) && v.every((n) => typeof n === 'number')),
      },
      // See `table_cell.rawTcPr` for the round-trip contract.
      rawTcPr: {
        default: null as string | null,
        validate: (v: unknown) => v === null || typeof v === 'string',
      },
    },
    tableRole: 'header_cell',
    isolating: true,
    parseDOM: [
      {
        tag: 'th',
        getAttrs: (dom: HTMLElement) => readCellAttrs(dom),
      },
    ],
    toDOM: (node) => ['th', cellAttrsToDom(node.attrs), 0],
  },
};

function readCellAttrs(dom: HTMLElement): {
  colspan: number;
  rowspan: number;
  colwidth: number[] | null;
} {
  const colspan = parseInt(dom.getAttribute('colspan') || '1', 10) || 1;
  const rowspan = parseInt(dom.getAttribute('rowspan') || '1', 10) || 1;
  const widthAttr = dom.getAttribute('data-colwidth');
  const colwidth = widthAttr
    ? widthAttr.split(',').map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n))
    : null;
  return { colspan, rowspan, colwidth };
}

function cellAttrsToDom(attrs: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const colspan = Number(attrs['colspan'] ?? 1);
  const rowspan = Number(attrs['rowspan'] ?? 1);
  if (colspan !== 1) out['colspan'] = String(colspan);
  if (rowspan !== 1) out['rowspan'] = String(rowspan);
  const colwidth = attrs['colwidth'] as number[] | null;
  if (colwidth && colwidth.length > 0) {
    out['data-colwidth'] = colwidth.join(',');
  }
  return out;
}
