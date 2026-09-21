/**
 * ProseMirror mark specs.
 *
 * The two main mark families (the rest are documented inline):
 *
 * 1. Named-style emphasis marks — round-trip to a Word character style:
 *    - cite_mark   ↔ rStyle "Style13ptBold" (Cite)
 *    - underline_mark ↔ rStyle "StyleUnderline" + direct <w:u w:val="single"/>
 *      (dual representation per NOTES-verbatim.md §5 gotcha #1)
 *    - emphasis_mark ↔ rStyle "Emphasis"
 *    - undertag_mark ↔ rStyle "UndertagChar"
 *    - analytic_mark ↔ rStyle "AnalyticChar"
 *
 * 2. Direct-formatting marks — round-trip to OOXML run properties:
 *    - bold      ↔ <w:b/>
 *    - italic    ↔ <w:i/> + <w:iCs/>
 *    - superscript ↔ <w:vertAlign w:val="superscript"/>
 *    - subscript ↔ <w:vertAlign w:val="subscript"/>
 *    - link      ↔ <w:hyperlink>...</w:hyperlink>  (URL in attrs)
 *    - highlight ↔ <w:highlight w:val="..."/>      (named color)
 *    - font_color ↔ <w:color w:val="..."/>         (RGB hex)
 *    - font_size ↔ <w:sz w:val="..."/>             (half-points)
 *    - shading   ↔ <w:shd w:fill="..."/>           (RGB hex; protected highlight)
 */

import type { MarkSpec } from 'prosemirror-model';

/** No-attribute named-style mark template. */
function namedStyleMark(): MarkSpec {
  return {
    inclusive: true,
  };
}

/**
 * Perceived-luminance bucket for a 6-hex RGB color (no leading `#`).
 * `dark`/`light` straddle a 0.4 threshold on the YIQ-style luma
 * approximation `(0.299r + 0.587g + 0.114b) / 255`. Used by
 * `font_color` and `shading` to emit `data-*-band` attributes that
 * downstream CSS rules read to force contrast against arbitrary
 * background colors (shading rules always-on; font_color override
 * dark-mode-only). Threshold picked so Word's hyperlink blue
 * (`0563C1` ≈ 0.32), default black (`000000` = 0), and dark grays
 * land in `dark`; mid-grays (`888888` ≈ 0.53) and lighter stay
 * `light`. Invalid hex falls back to `dark` (caller fault).
 */
export function colorBand(hex: string): 'dark' | 'light' {
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return 'dark';
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum < 0.4 ? 'dark' : 'light';
}

/**
 * Perceived-luminance band for each OOXML named highlight color.
 * Mirrors the per-color CSS rules at `.pmd-highlight[data-highlight=...]`
 * — `light` backgrounds get black text, `dark` backgrounds get white.
 * `none` opts out (no background fill, so no band-specific contrast
 * decision needed). Used as the source for `data-highlight-band`,
 * which downstream selectors read instead of expanding every named
 * color into its own `:has()` clause.
 */
export const HIGHLIGHT_BAND: Record<string, 'light' | 'dark' | 'none'> = {
  yellow: 'light',
  green: 'light',
  cyan: 'light',
  magenta: 'light',
  red: 'light',
  lightGray: 'light',
  blue: 'dark',
  darkBlue: 'dark',
  darkCyan: 'dark',
  darkGreen: 'dark',
  darkMagenta: 'dark',
  darkRed: 'dark',
  darkYellow: 'dark',
  darkGray: 'dark',
  black: 'dark',
  none: 'none',
};

export const marks: { [name: string]: MarkSpec } = {
  // -------- Outermost: per-run font size --------
  // `font_size` is listed first so it renders as the OUTERMOST DOM
  // wrapper. CSS paints an inline element's background/border on a box
  // sized by its OWN font-size, not its descendants'. Putting font_size
  // outermost means visible wrappers (emphasis box, highlight band,
  // strikethrough line, etc.) inherit the per-run size and size their
  // boxes correctly when the user scales text up or down. Order within
  // this object literal sets mark rank: earlier = lower rank = outer
  // DOM. Word treats direct `<w:sz>` as overriding a character style's
  // size, so this also matches OOXML semantics.

  font_size: {
    inclusive: true,
    attrs: {
      // Half-points (OOXML convention): 22 = 11pt, 24 = 12pt, 26 = 13pt, etc.
      halfPoints: {
        default: 22,
        validate: (v: unknown) =>
          typeof v === 'number' && Number.isInteger(v) && v > 0,
      },
      // Provenance: 'shrink' when the protection-aware sizing machinery
      // (shrink/regrow cycle, smart shrink) applied the size; null for
      // sizes the user chose (size chip, ± nudge, pasted content). The
      // collab invariant heal strips ONLY 'shrink'-origin sizes that
      // fuse with underline/emphasis at CRDT merge — Peritext range
      // marks cover concurrently-inserted interior text, so a partner's
      // underlined typing inside a shrunk span inherits the small size
      // with no op recording it. Intentionally absent from parseDOM/
      // toDOM: clipboard round-trips demote to null (= manual), so the
      // heal can only under-fire, never eat a deliberate size.
      origin: {
        default: null,
        validate: (v: unknown) => v === null || v === 'shrink',
      },
    },
    parseDOM: [
      {
        tag: 'span[data-half-points]',
        getAttrs: (dom: HTMLElement) => {
          const v = dom.getAttribute('data-half-points');
          const n = v ? parseInt(v, 10) : 22;
          return { halfPoints: Number.isFinite(n) ? n : 22 };
        },
      },
    ],
    toDOM: (mark) => {
      const hp = Number(mark.attrs['halfPoints'] ?? 22);
      // Also publish the size as `--pmd-run-font-size`. The named-style
      // marks (cite/underline/emphasis) render INSIDE this wrapper and
      // would otherwise pin the glyph to their per-style display size,
      // overriding an explicit per-run size — so their CSS reads this
      // variable first and falls back to the display size only when no
      // `font_size` mark is present. This matches `ptForRun`'s precedence
      // (a `font_size` mark is "direct" and wins) and Word's "direct
      // `<w:sz>` overrides a character style's size" semantics.
      return [
        'span',
        {
          style: `font-size: ${hp / 2}pt; --pmd-run-font-size: ${hp / 2}pt`,
          'data-half-points': String(hp),
        },
        0,
      ];
    },
  },

  // -------- Named-style emphasis marks --------

  cite_mark: {
    ...namedStyleMark(),
    // The three named-style "evidence" marks are mutually exclusive
    // — at most one of {cite, underline, emphasis} on any character.
    // Symmetric so that whichever mark is being added via tr.addMark
    // strips the others automatically. For passive coexistence
    // (legacy import data carrying overlapping marks), the named-
    // style normalizer plugin enforces cite/emphasis precedence over
    // underline.
    excludes: 'cite_mark underline_mark emphasis_mark',
    parseDOM: [{ tag: 'span.pmd-cite' }],
    toDOM: () => ['span', { class: 'pmd-cite' }, 0],
  },

  underline_mark: {
    ...namedStyleMark(),
    excludes: 'cite_mark underline_mark emphasis_mark',
    parseDOM: [{ tag: 'span.pmd-underline' }],
    toDOM: () => ['span', { class: 'pmd-underline' }, 0],
  },

  /**
   * Direct underline (no named style). Used in structural textblocks
   * (tag / analytic / pocket / hat / block / undertag) where applying
   * the named-style "Underline" would semantically mis-classify the
   * text. Round-trips to a bare `<w:u w:val="single"/>` with no
   * `<w:rStyle/>`. The named-style-normalizer plugin keeps the
   * body-vs-structural invariant (no underline_direct in body, no
   * underline_mark in structural).
   */
  underline_direct: {
    inclusive: true,
    parseDOM: [{ tag: 'u' }],
    toDOM: () => ['u', 0],
  },

  emphasis_mark: {
    ...namedStyleMark(),
    excludes: 'cite_mark underline_mark emphasis_mark',
    parseDOM: [{ tag: 'span.pmd-emphasis' }],
    toDOM: () => ['span', { class: 'pmd-emphasis' }, 0],
  },

  undertag_mark: {
    ...namedStyleMark(),
    parseDOM: [{ tag: 'span.pmd-undertag-mark' }],
    toDOM: () => ['span', { class: 'pmd-undertag-mark' }, 0],
  },

  analytic_mark: {
    ...namedStyleMark(),
    parseDOM: [{ tag: 'span.pmd-analytic-mark' }],
    toDOM: () => ['span', { class: 'pmd-analytic-mark' }, 0],
  },

  /**
   * Pilcrow marker — a non-inclusive mark applied to the 6-pt `¶`
   * characters Branch B inserts at original paragraph boundaries.
   * Non-inclusive so the cursor adjacent to a pilcrow doesn't pick
   * up its formatting and typing nearby stays at the surrounding
   * text size. Round-trips as `<w:r><w:rPr><w:sz w:val="12"/></w:rPr>
   * <w:t>¶</w:t></w:r>` — the exporter writes the equivalent of a
   * 6-pt `font_size` mark for any run carrying this marker, and the
   * importer recognizes the same pattern on the way back in.
   */
  pilcrow_marker: {
    inclusive: false,
    parseDOM: [{ tag: 'span.pmd-pilcrow' }],
    toDOM: () => ['span', { class: 'pmd-pilcrow' }, 0],
  },

  // -------- Direct-formatting marks --------

  bold: {
    inclusive: true,
    // Mutually exclusive with bold_off — a run is either bold or
    // explicitly-not-bold, never both.
    excludes: 'bold bold_off',
    parseDOM: [
      { tag: 'b' },
      { tag: 'strong' },
      { style: 'font-weight', getAttrs: (v) => /^(bold|[5-9]\d{2})/.test(String(v)) && null },
    ],
    toDOM: () => ['strong', 0],
  },

  /**
   * Explicit "not bold" — overrides the bold a structural block (tag /
   * analytic / pocket / hat / block) renders by DEFAULT via CSS, so a word
   * inside a tag can be un-bolded. Renders an inline `font-weight: normal`,
   * which beats the `.pmd-tag { font-weight: bold }` rule, tagged with
   * `data-bold-off` for a clean editor round-trip. Round-trips to OOXML
   * `<w:b w:val="0"/>`. In body text (not bold by default) it's a harmless
   * no-op, but it still faithfully preserves an explicit Word "bold off".
   *
   * Like `font_size`, it parses only its own `data-bold-off` span — NOT an
   * arbitrary `font-weight: normal` — so it isn't sprayed onto every paste
   * that carries an explicit-normal weight. The docx importer adds it
   * directly from `<w:b w:val="0"/>`.
   */
  bold_off: {
    inclusive: true,
    excludes: 'bold bold_off',
    parseDOM: [{ tag: 'span[data-bold-off]' }],
    toDOM: () => ['span', { 'data-bold-off': 'true', style: 'font-weight: normal' }, 0],
  },

  italic: {
    inclusive: true,
    parseDOM: [
      { tag: 'i' },
      { tag: 'em' },
      { style: 'font-style=italic' },
    ],
    toDOM: () => ['em', 0],
  },

  /**
   * Strikethrough — `<w:strike/>` in OOXML. Renders as `<s>`. We don't
   * differentiate single-strike vs double-strike (`<w:dstrike/>`); the
   * importer maps both to this mark and the exporter writes single-strike.
   */
  strikethrough: {
    inclusive: true,
    parseDOM: [
      { tag: 's' },
      { tag: 'strike' },
      { tag: 'del' },
      { style: 'text-decoration', getAttrs: (v) => /line-through/.test(String(v)) && null },
    ],
    toDOM: () => ['s', 0],
  },

  /**
   * Vertical alignment — `<w:vertAlign w:val="superscript|subscript"/>`
   * in OOXML. Two separate marks so the natural ProseMirror mark
   * lifecycle (toggle, exclude) handles mutual exclusion; a single
   * baseline of normal is the absence of either mark. Renders as
   * native `<sup>` / `<sub>` so browsers handle the baseline shift
   * and ~0.83em font scaling without per-mark CSS.
   */
  superscript: {
    inclusive: true,
    excludes: 'superscript subscript',
    parseDOM: [
      { tag: 'sup' },
      { style: 'vertical-align', getAttrs: (v) => /super/.test(String(v)) && null },
    ],
    toDOM: () => ['sup', 0],
  },

  subscript: {
    inclusive: true,
    excludes: 'superscript subscript',
    parseDOM: [
      { tag: 'sub' },
      { style: 'vertical-align', getAttrs: (v) => /sub/.test(String(v)) && null },
    ],
    toDOM: () => ['sub', 0],
  },

  link: {
    inclusive: false,
    attrs: {
      href: {
        default: '',
        validate: (v: unknown) => typeof v === 'string',
      },
    },
    parseDOM: [
      {
        tag: 'a[href]',
        getAttrs: (dom: HTMLElement) => ({
          href: dom.getAttribute('href') ?? '',
        }),
      },
    ],
    toDOM: (mark) => [
      'a',
      { href: String(mark.attrs['href'] ?? '') },
      0,
    ],
  },

  /**
   * Shading — `<w:shd w:fill="…"/>`, an RGB background that survives
   * Word's "remove highlighting" (which only strips `<w:highlight>`).
   * Verbatim's `HighlightToBackgroundColor` uses this as "protected
   * highlight" (canonically D2D2D2 grey). Defined BEFORE `highlight`
   * so highlight nests inside shading in the DOM — when both marks
   * coexist on the same run, highlight's background wins visually.
   */
  shading: {
    inclusive: true,
    attrs: {
      // Hex RGB, no leading "#"
      color: {
        default: 'D2D2D2',
        validate: (v: unknown) =>
          typeof v === 'string' && /^[0-9a-fA-F]{6}$/.test(v),
      },
    },
    parseDOM: [
      {
        tag: 'span[data-shading]',
        getAttrs: (dom: HTMLElement) => ({
          color: dom.getAttribute('data-shading') ?? 'D2D2D2',
        }),
      },
    ],
    toDOM: (mark) => {
      const color = String(mark.attrs['color'] ?? 'D2D2D2');
      // `data-shading-band` lets CSS pick a high-contrast text color
      // for arbitrary shading hexes (highlight does the same per
      // named color via `data-highlight=...`). Without it, a docx
      // with yellow shading (FFFF00, from Verbatim's
      // HighlightToBackgroundColor macro) would render the contained
      // text in the themed text color — white in dark mode — on a
      // bright yellow bg, which is unreadable. The band attribute
      // forces black/white based on the shading's luminance.
      // `--sh` mirrors the fill so the optional shading-cue CSS (the
      // plate-edge / dot-grid treatments under `data-shading-cue`)
      // can `color-mix` from it; the literal background-color stays
      // for clipboard consumers that read inline styles.
      return [
        'span',
        {
          style: `background-color: #${color}; --sh: #${color}`,
          'data-shading': color,
          'data-shading-band': colorBand(color),
        },
        0,
      ];
    },
  },

  highlight: {
    inclusive: true,
    attrs: {
      // OOXML highlight values: "yellow", "green", "cyan", "magenta", "blue",
      // "red", "darkBlue", "darkCyan", "darkGreen", "darkMagenta", "darkRed",
      // "darkYellow", "darkGray", "lightGray", "black", "none"
      color: {
        default: 'yellow',
        validate: (v: unknown) => typeof v === 'string',
      },
    },
    parseDOM: [
      { tag: 'mark', getAttrs: () => ({ color: 'yellow' }) },
      {
        tag: 'span.pmd-highlight',
        getAttrs: (dom: HTMLElement) => ({
          color: dom.dataset['highlight'] ?? 'yellow',
        }),
      },
    ],
    // Rendered as <span class="pmd-highlight"> rather than <mark>:
    // class targeting survives ProseMirror view-layer element
    // normalization that can defeat element-typed CSS rules.
    // Emphasis box padding is 0 so the highlight bg reaches the box's
    // inner border edge with no gap, even though emphasis is OUTER to
    // highlight in mark rank (a continuous emphasis run renders as one
    // `.pmd-emphasis` span regardless of which sub-runs carry
    // highlight — no phantom internal borders).
    toDOM: (mark) => {
      const color = String(mark.attrs['color'] ?? 'yellow');
      // `data-highlight-band` = perceived-luminance bucket for the
      // named color, so downstream CSS matches one band attribute
      // instead of 16 `:has(.pmd-highlight[data-highlight=…])` checks
      // per `.pmd-underline` — a large style-recalc win when cv:auto
      // cards stream into view. "none" for the explicit no-highlight
      // value keeps the selector chain off transparent containers.
      return [
        'span',
        {
          class: 'pmd-highlight',
          'data-highlight': color,
          'data-highlight-band': HIGHLIGHT_BAND[color] ?? 'none',
        },
        0,
      ];
    },
  },

  font_color: {
    inclusive: true,
    attrs: {
      // Hex string, no leading "#" (OOXML convention): "555555", "1F3864", etc.
      color: {
        default: '000000',
        validate: (v: unknown) =>
          typeof v === 'string' && /^[0-9a-fA-F]{6}$/.test(v),
      },
    },
    parseDOM: [
      {
        tag: 'span[data-color]',
        getAttrs: (dom: HTMLElement) => ({
          color: dom.getAttribute('data-color') ?? '000000',
        }),
      },
    ],
    toDOM: (mark) => {
      const color = String(mark.attrs['color'] ?? '000000');
      // Two display-only adjustments encoded here, both designed to
      // preserve round-trip (parseDOM reads `data-color`, exporter
      // reads `attrs.color`):
      //
      //   1. `000000` ("default / Automatic" in Word) emits no
      //      inline style. The run inherits the surrounding text
      //      color, which means dark mode and per-token text-color
      //      overrides actually take effect on the bulk of imported
      //      body text. Light mode still reads near-black because
      //      `--pmd-c-text` is near-black there.
      //   2. `data-color-band="dark"|"light"` (from `colorBand()`)
      //      lets the dark-mode CSS rule force dark-band font_color
      //      runs to inherit, beating their inline `color:` style
      //      via `!important`. Catches Word's hyperlink blue
      //      (`0563C1`), user-picked dark grays / dark reds / etc.
      //      that would be invisible against the dark surface, and
      //      keeps mid/high-luminance choices intact.
      const attrs: Record<string, string> = {
        'data-color': color,
        'data-color-band': colorBand(color),
      };
      if (color !== '000000') attrs['style'] = `color: #${color}`;
      return ['span', attrs, 0];
    },
  },

  /**
   * Per-run font family override. Round-trips to OOXML `<w:rFonts>`
   * (importer reads w:ascii / w:hAnsi / w:cs; exporter emits all three
   * to the same value). Intentionally NOT rendered in the editor — the
   * mark is data-only, with a span wrapper carrying a `data-font-family`
   * attribute. The body font (settings.bodyFont) governs how the editor
   * renders. Round-trip preserves the user's per-run font overrides
   * verbatim regardless.
   */
  font_family: {
    inclusive: true,
    attrs: {
      name: {
        default: '',
        validate: (v: unknown) => typeof v === 'string',
      },
    },
    parseDOM: [
      {
        tag: 'span[data-font-family]',
        getAttrs: (dom: HTMLElement) => ({
          name: dom.getAttribute('data-font-family') ?? '',
        }),
      },
    ],
    toDOM: (mark) => [
      'span',
      {
        'data-font-family': String(mark.attrs['name'] ?? ''),
      },
      0,
    ],
  },

  /**
   * Comment anchor — references a thread in the comments plugin
   * state via `threadId`. Non-inclusive so typing past either end
   * of a commented range doesn't extend the anchor. Renders as a
   * span with a `data-comment-id` attribute the CSS uses to draw
   * the subtle inline indicator. Thread content (author / text /
   * replies) lives in plugin state, not on the mark.
   *
   * Round-trips as `<w:commentRangeStart>` / `<w:commentRangeEnd>`
   * brackets in document.xml; the actual comment data goes into
   * `word/comments.xml` (+ `word/commentsExtended.xml` for thread
   * relationships).
   */
  comment_range: {
    inclusive: false,
    attrs: {
      threadId: {
        default: '',
        validate: (v: unknown) => typeof v === 'string',
      },
    },
    parseDOM: [
      {
        tag: 'span[data-comment-id]',
        getAttrs: (dom: HTMLElement) => ({
          threadId: dom.getAttribute('data-comment-id') ?? '',
        }),
      },
    ],
    toDOM: (mark) => [
      'span',
      {
        class: 'pmd-comment-range',
        'data-comment-id': String(mark.attrs['threadId'] ?? ''),
      },
      0,
    ],
  },

  /** Invisible source anchor for an exact-selection live reference. Multiple
   *  reference ids share one mark so overlapping live references remain valid. */
  live_reference_source: {
    // Keep replacement text and typing at the excerpt edge inside the live
    // reference; otherwise replacing the whole selection would orphan it.
    inclusive: true,
    attrs: {
      ids: {
        default: '',
        validate: (v: unknown) => typeof v === 'string',
      },
      /** JSON map of reference id to the run's effective source size in points. */
      sizes: {
        default: '{}',
        validate: (v: unknown) => typeof v === 'string',
      },
    },
    // Render as an unlabelled span so normal copy/paste strips the private
    // anchor instead of duplicating a live reference's source elsewhere.
    toDOM: () => ['span', 0],
  },

};
