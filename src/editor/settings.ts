/**
 * Editor settings — typed user preferences with localStorage persistence
 * and pub/sub for change notifications.
 *
 * Per ARCHITECTURE.md §5 the bigger "display config" (per-node typography,
 * accessibility presets, etc.) is a separate substantial feature. This
 * module is the simpler feature-toggle / numeric-pref store. Display
 * config can layer on later as its own module without colliding.
 */

import { isWordHighlightName, isHex6 } from './color-palette.js';
import { sanitizeAcronymPattern, type AcronymPattern } from './acronym-patterns.js';
import type { IconName } from './icons.js';
import { getHost } from './host/index.js';
import { isLiteBuild } from './lite.js';
import { DEFAULT_SPEECH_FILENAME_TEMPLATE } from './speech-filename-default.js';

/** Body-text zoom bounds (percent). The live per-window / per-pane zoom AND the
 *  default-open zoom setting all clamp to these — one source of truth so
 *  single-doc and multi-pane can't drift. */
export const ZOOM_MIN_PCT = 50;
export const ZOOM_MAX_PCT = 300;

/** Chrome (whole-page) scale bounds (percent). A separate axis from body zoom —
 *  wired to Chromium's `webFrame.setZoomFactor` — kept as its own constant so
 *  the two can be tuned independently (both currently 50–300). */
export const CHROME_SCALE_MIN_PCT = 50;
export const CHROME_SCALE_MAX_PCT = 300;

/** Dynamic description for the `multiDocWorkspace` (three-pane
 *  workspace) toggle. The OFF state behaves differently on Electron
 *  vs the web edition, so we surface that difference at the point
 *  the user reads the setting. */
function workspaceLayoutDescription(): string {
  const kind = getHost().kind;
  const offBehavior =
    kind === 'electron'
      ? 'each open document gets its own native window. Opening a new file (or making a new document) spawns a new window — recommended when you have screen space and a good window manager.'
      : 'one document at a time in this browser tab. The web edition can\'t spawn its own windows, so to work with multiple documents in this mode, open additional browser tabs and load a doc in each — or turn this setting ON to use three panes inside this tab.';
  return (
    `OFF (default): ${offBehavior} ON: a single window with three side-by-side panes inside it, for working multi-doc with limited screen real estate. Comments are unavailable while ON. Toggling reloads the editor; open documents are restored in the new layout.`
  );
}

const STORAGE_KEY = 'pmd-settings';

/** Keys whose values are per-window/per-session: never written to
 *  localStorage, never synced via storage events, and reset to
 *  defaults on reload. Read mode is the canonical case — Verbatim
 *  exits read mode on document close, and we already treat it as
 *  per-pane in multi-doc mode; making it per-window matches that
 *  intent for the multi-window case. Autosave joins it for the
 *  same reason: a workflow toggle the user wants to control per
 *  doc, not a global preference. */
const TRANSIENT_SETTING_KEYS = new Set<string>([
  'readMode',
  // `autosaveEnabled` stays transient as a SETTING (per-window, never
  // in `pmd-settings`), but the choice is remembered PER FILE in
  // `autosave-prefs-store.ts` so reopening a doc restores its toggle.
  'autosaveEnabled',
  // Nav-pane visibility — the user might want the outline open in
  // one window (a doc they're navigating heavily) and hidden in
  // another (a doc they're reading). Per-window matches that
  // intent; on the web edition there's only one tab so it's
  // effectively a session preference.
  'navPaneVisible',
]);

/** Secret credentials — never written to a settings export, and
 *  preserved (not overwritten) on import. */
const SECRET_SETTING_KEYS = new Set<string>([
  'anthropicApiKey',
  'openrouterApiKey',
  'googleTranslateApiKey',
  'myMemoryEmail',
]);

/** Reader profile for read-time estimates: name + words-per-minute.
 *  `tagWpm` is the optional SECOND speed most readers actually have —
 *  the rate for tags, analytics, and cites (the structural read), with
 *  `wpm` then covering just highlighted card bodies. Absent → `wpm`
 *  covers everything. */
export interface ReaderConfig {
  name: string;
  wpm: number;
  tagWpm?: number;
}

/** A paired machine you can send cards to. `code` is that machine's
 *  shareable pairing code (its relay address); `name` is your local
 *  nickname for it, used to disambiguate in the send picker and to label
 *  received cards. */
export interface PairingPartner {
  code: string;
  name: string;
  /** Hidden = not shown in the Send pill (both its click rows and its
   *  drag targets) without deleting the contact. Orthogonal to
   *  starring: a hidden starred partner stays reachable through the
   *  starred quick-send commands — hiding is about pill clutter, not
   *  reachability. */
  hidden?: boolean;
}

/** A named set of partners (e.g. a coach's "Smith/Jones" partnership).
 *  Sending to a group fans the card out to every member. `memberCodes`
 *  references `PairingPartner.code` values. */
export interface PairingGroup {
  id: string;
  label: string;
  memberCodes: string[];
}

/** Receive-pill flash behavior when a card arrives. `once` = one green
 *  pulse; `off` = none; `repeat` = pulse then re-pulse every 10s until
 *  you open the receive pill and see the new card(s). */
export type PairingReceiveFlash = 'once' | 'off' | 'repeat';
const PAIRING_RECEIVE_FLASHES: PairingReceiveFlash[] = ['once', 'off', 'repeat'];

/**
 * Per-style font sizes (in points). Mirrors Verbatim's Styles tab so
 * users can adjust how each named style renders without touching the
 * underlying doc — the §5 three-layer rendering model in action. Each
 * field becomes a CSS custom property on `#editor` (e.g. `--pmd-size-
 * cite: 13pt`); CSS rules consume the variables.
 *
 * Defaults (`DEFAULT_DISPLAY_SIZES`) match Verbatim's for parity with
 * existing docs.
 */
export interface DisplaySizes {
  normal: number;
  pocket: number;
  hat: number;
  block: number;
  tag: number;
  analytic: number;
  cite: number;
  underline: number;
  emphasis: number;
  undertag: number;
}

export const DISPLAY_SIZE_KEYS: (keyof DisplaySizes)[] = [
  'normal', 'pocket', 'hat', 'block', 'tag',
  'analytic', 'cite', 'underline', 'emphasis', 'undertag',
];

export const DEFAULT_DISPLAY_SIZES: DisplaySizes = {
  normal: 11,
  pocket: 26,
  hat: 22,
  block: 16,
  tag: 13,
  analytic: 13,
  cite: 13,
  underline: 11,
  emphasis: 11,
  undertag: 12,
};

/**
 * Per-style paragraph spacing — the blank space BEFORE and AFTER a
 * paragraph (its top/bottom margin), in points. A display setting like
 * line spacing: it overrides how the editor renders, independent of the
 * doc's own spacing. Keys are `<style>Before` / `<style>After`.
 */
export const PARAGRAPH_SPACING_KEYS = [
  'bodyBefore', 'bodyAfter',
  'citeBefore', 'citeAfter',
  'tagBefore', 'tagAfter',
  'analyticBefore', 'analyticAfter',
  'pocketBefore', 'pocketAfter',
  'hatBefore', 'hatAfter',
  'blockBefore', 'blockAfter',
  'undertagBefore', 'undertagAfter',
] as const;
export type ParagraphSpacingKey = (typeof PARAGRAPH_SPACING_KEYS)[number];
export type DisplayParagraphSpacing = Record<ParagraphSpacingKey, number>;

const DEFAULT_PARAGRAPH_SPACING: DisplayParagraphSpacing = {
  bodyBefore: 0, bodyAfter: 0,
  citeBefore: 0, citeAfter: 0,
  tagBefore: 9, tagAfter: 3,
  analyticBefore: 9, analyticAfter: 3,
  pocketBefore: 18, pocketAfter: 9,
  hatBefore: 15, hatAfter: 6,
  blockBefore: 12, blockAfter: 6,
  undertagBefore: 0, undertagAfter: 0,
};
export { DEFAULT_PARAGRAPH_SPACING };

/**
 * Per-style typography flags. Mirrors the boolean side of Verbatim's
 * Styles tab — whether each named style is bold, italic, underlined,
 * boxed, plus the box thickness. Each flag becomes a class toggle on
 * `#editor` (e.g. `pmd-emphasis-bold`); CSS rules predicated on the
 * class enable the typography. Defaults match Verbatim's, except
 * `emphasisBox` (true — CardMirror renders emphasis boxed by default).
 */
/** Per-style text alignment (Accessibility → Text alignment).
 *  'default' = the style's normal start-aligned rendering; 'center' /
 *  'justify' override it display-wide. Tags and body-level paragraph
 *  styles only — pockets/hats/blocks are deliberately not covered
 *  (their alignment is part of the document look, not readability).
 *  A paragraph's own alignment attr (inline style) still wins. */
export type StyleAlignment = 'default' | 'center' | 'justify';
export interface StyleAlignments {
  tag: StyleAlignment;
  paragraph: StyleAlignment;
  cardBody: StyleAlignment;
  analyticBody: StyleAlignment;
  analytic: StyleAlignment;
  undertag: StyleAlignment;
  citeParagraph: StyleAlignment;
}
const DEFAULT_STYLE_ALIGNMENTS: StyleAlignments = {
  tag: 'default',
  paragraph: 'default',
  cardBody: 'default',
  analyticBody: 'default',
  analytic: 'default',
  undertag: 'default',
  citeParagraph: 'default',
};

export interface DisplayTypography {
  citeUnderlined: boolean;
  underlineBold: boolean;
  /** Hat headings: double underline (default, the Verbatim look) or
   *  single. Display-only — export styling is unchanged. */
  hatUnderlineDouble: boolean;
  emphasisBold: boolean;
  emphasisItalic: boolean;
  emphasisBox: boolean;
  emphasisBoxSize: number; // pt
  /** Whether pocket headings draw their box at all (default true).
   *  Display-only, like the emphasis flag. */
  pocketBox: boolean;
  /** Thickness of the box drawn around pocket headings, in pt.
   *  Display-only (export borders are unchanged). Default 2.25pt =
   *  the 3px the CSS hardcoded before this was a setting, so existing
   *  documents look identical. */
  pocketBoxSize: number; // pt
  /** Thickness of the underline drawn by the underline / emphasis
   *  marks (and cite, when `citeUnderlined` is on), in pt. 0 = the
   *  font's automatic thickness. Display-only. Hat / block heading
   *  underlines are part of the document look and keep theirs — same
   *  stance as the alignment settings. */
  underlineSize: number; // pt, 0 = auto
  undertagItalic: boolean;
  undertagBold: boolean;
}

const DEFAULT_DISPLAY_TYPOGRAPHY: DisplayTypography = {
  citeUnderlined: false,
  underlineBold: false,
  hatUnderlineDouble: true,
  emphasisBold: true,
  emphasisItalic: false,
  emphasisBox: true,
  emphasisBoxSize: 1,
  pocketBox: true,
  pocketBoxSize: 2.25,
  underlineSize: 0,
  undertagItalic: true,
  undertagBold: false,
};

/**
 * Per-style display colors (hex strings, e.g. `"#1F3864"`). Per
 * ARCHITECTURE.md §18 every user-visible color should be reachable
 * through display config — analytic and undertag are the first two
 * surfaced as direct controls. Each becomes a CSS custom property on
 * `:root` (e.g. `--pmd-color-analytic`). Both the editor and the nav
 * pane consume those variables.
 */
export interface DisplayColors {
  analytic: string;
  undertag: string;
  /** Reading-marker text AND the "unread after a marker" tint (one shared hue).
   *  Display-only — the stored mark stays FF0000, so export + detection are
   *  unaffected; this just recolors both on screen. */
  readingMarker: string;
  /** The live-zone "source updated" (diverged) badge / nav rail. A muted red —
   *  kept soft so, as a second nav rail beside the teal transclusion rail, it
   *  pairs with rather than overpowers it (and stays clear of the AI purple used
   *  elsewhere). */
  zoneDiverged: string;
}

export const DEFAULT_DISPLAY_COLORS: DisplayColors = {
  analytic: '#1F3864',
  undertag: '#385623',
  readingMarker: '#FF0000',
  zoneDiverged: '#C0504D',
};

export const DISPLAY_COLOR_KEYS: (keyof DisplayColors)[] = [
  'analytic',
  'undertag',
  'readingMarker',
  'zoneDiverged',
];

/** A user-defined keyboard macro: pressing `key` types `text` at the
 *  cursor. `id` is a stable local handle for the editor UI. */
export interface KeyboardMacro {
  id: string;
  /** ProseMirror-keymap key string, e.g. `Mod-Shift-q` (same format as
   *  `ribbonKeyOverrides`). Empty = not yet bound. */
  key: string;
  /** Literal text inserted at the cursor when the key fires. */
  text: string;
}

/** A user-configured custom ribbon button: runs `command` when clicked and
 *  shows `icon`. Up to 10 sit to the right of the comments buttons; an empty
 *  list hides the whole section. */
export interface RibbonCustomButton {
  /** Command to run: a `RibbonCommandId`, a plugin command id
   *  (`<pluginId>.<name>`), or a setting command `toggle:<settingKey>` /
   *  `cycle:<settingKey>` (see setting-commands.ts). */
  command: string;
  icon: IconName;
}

/** Max custom ribbon buttons (the reserved slots to the right of comments —
 *  5 columns of 2). */
export const MAX_RIBBON_CUSTOM_BUTTONS = 10;

/** One external app's remembered consent for the local bridge's gated
 *  routes. `id` is the app's self-declared `X-App-Id` (stable across
 *  launches — pid/token rotate per session, identity doesn't). */
export interface ExternalAppConsent {
  id: string;
  decision: 'allow' | 'deny';
  /** ISO timestamps — first consent prompt, most recent served request. */
  firstSeen: string;
  lastSeen: string;
}

/** Same shape the bridge enforces on `X-App-Id` (main side). */
export const EXTERNAL_APP_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** See `Settings.externalInsertPolicy`. */
export type ExternalInsertPolicy = 'off' | 'ask' | 'open';

/** "New paragraph on Enter" choices — 'normal' means the default Enter
 *  behavior for that context; the rest name a structural style. */
export type EnterAfterStyle =
  | 'normal'
  | 'pocket'
  | 'hat'
  | 'block'
  | 'tag'
  | 'analytic'
  | 'undertag';

/** Separator glyph that trails a card-numbering number/letter (display-only).
 *  `period` = ".", `paren` = ")", `dash` = " -", `colon` = ":", `emdash` = "—",
 *  `endash` = "–", `doublehyphen` = "--", `triplehyphen` = "---". */
export type NumberingSeparator =
  | 'period'
  | 'paren'
  | 'dash'
  | 'colon'
  | 'emdash'
  | 'endash'
  | 'doublehyphen'
  | 'triplehyphen';

/** Runtime list of every valid `NumberingSeparator` (persistence validation +
 *  the settings-UI option lists read from this). */
export const NUMBERING_SEPARATORS: readonly NumberingSeparator[] = [
  'period',
  'paren',
  'dash',
  'colon',
  'emdash',
  'endash',
  'doublehyphen',
  'triplehyphen',
];

/** Schema for all editor settings. Add new fields here with sensible defaults. */
export interface Settings {
  /** Width of the navigation pane in pixels. */
  navWidth: number;
  /** Default navigation-pane depth for NEWLY OPENED documents (1
   *  Pocket … 4 Tag). The nav pane's 1–4 buttons adjust the open
   *  doc's view only (transient, per-pane); this setting is what
   *  every new doc starts at. */
  navMaxLevel: number;
  /** When true, the nav pane scrolls to keep the outline row the cursor
   *  is in visible — the pane follows your place in the document instead
   *  of sitting wherever it was last left.
   *
   *  Two occasions, both resolving to whichever row currently carries the
   *  caret highlight (the deepest RENDERED ancestor, when the cursor's own
   *  heading is collapsed away): moving the cursor into a different
   *  section scrolls that row into view, and only when it's actually
   *  off-screen, so typing within one section never moves the pane and a
   *  hand-scrolled outline is left alone. Switching level (the 1–4 buttons
   *  or the context menu's "Show heading level N") rebuilds the list and
   *  destroys its scroll offset outright, so there the row is pinned to
   *  the top instead.
   *
   *  Scroll only: the cursor, the nav selection, and the collapsed set are
   *  untouched. On by default. */
  navFollowCursor: boolean;
  /** Master switch for drag-to-rearrange: nav-pane row drags and the
   *  editor's pickup-modifier drag. OFF turns those gestures inert
   *  (clicks still navigate; nothing moves) — for touch devices where
   *  a scrolling finger reads as a drag (iPad classroom request,
   *  2026-08-31). Sends/receives and pane resizing are unaffected. */
  dragInteractions: boolean;
  /** When true (default), `New document` mounts the CardMirror
   *  welcome / onboarding doc. When false, it mounts a blank
   *  doc — a single empty paragraph. The starter is the same one
   *  every fresh window opens with, so this also governs the
   *  initial content of newly spawned windows. */
  showOnboardingStarter: boolean;
  /** UI tour (coach marks) shown/acknowledged. Auto-set on any run;
   *  no settings row — reruns go through the `startUiTour` command. */
  hasSeenUiTour: boolean;
  /** First cut-in-place notice (shared documents) shown. Auto-set; no
   *  settings row. See cut-in-place.ts. */
  hasSeenCutInPlaceNotice: boolean;
  /** Desktop-only. When set, "New Speech Document" saves into this
   *  directory by default (instead of leaving the doc unsaved until
   *  the user picks a location). Empty string means no default — the
   *  doc stays unsaved until an explicit Save. Stored as an absolute
   *  path. */
  defaultSpeechDocFolder: string;
  /** Format that "New Speech Document" creates the doc in. `docx`
   *  is the Verbatim-compatible default. `cmir` is CardMirror's
   *  native format — the only format that supports autosave (the
   *  background save path skips .docx because `toDocx` is too
   *  expensive to run on a debounce). */
  defaultSpeechDocFormat: 'cmir' | 'docx';
  /** Template for the filename of a doc created by "New Speech
   *  Document". Fields: `{speech}` is the name typed at the prompt,
   *  `{date:FMT}` is a date in day.js-style tokens (`YYYY-MM-DD`,
   *  `h-mmA`). The extension is not part of the template —
   *  `defaultSpeechDocFormat` owns it. */
  speechDocFilenameTemplate: string;
  /** Format the Save-As dialog defaults to for a doc that doesn't
   *  yet have an on-disk handle (new doc, first save). Existing
   *  on-disk files always Save As in their current format — the
   *  handle wins over this default. */
  defaultSaveFormat: 'cmir' | 'docx';
  /** When on (default), saving via the Save-As dialog's Send Doc / Read Doc /
   *  Marked Doc presets (and their commands) prepends a per-type prefix to the
   *  file name (e.g. `SEND_1AC.docx`). The As-Is preset and the Save Custom
   *  button are never prefixed. Off saves presets under the exact name shown in
   *  the box. The prefix strings are `sendDocPrefix` / `readDocPrefix` /
   *  `markedDocPrefix`. */
  prefixPresetSaveFilenames: boolean;
  /** Filename prefix for Send Doc saves when `prefixPresetSaveFilenames` is on.
   *  Default `SEND_`. Empty = no prefix for this type. */
  sendDocPrefix: string;
  /** Filename prefix for Read Doc saves when `prefixPresetSaveFilenames` is on.
   *  Default `READ_`. */
  readDocPrefix: string;
  /** Filename prefix for Marked Doc saves when `prefixPresetSaveFilenames` is on.
   *  Default `MARKED_`. */
  markedDocPrefix: string;
  /** Where Save Send Doc writes. `sameFolder` (default) drops the
   *  send doc beside the source file; `fixedFolder` always writes into
   *  `sendDocFolder`. Either way, an unresolvable destination (a
   *  never-saved doc in same-folder mode, or an unset fixed folder)
   *  falls the command back to the Save-As dialog. */
  sendDocDestination: 'sameFolder' | 'fixedFolder';
  /** Destination folder for Save Send Doc when `sendDocDestination`
   *  is `fixedFolder`. Empty falls the command back to the OS save
   *  dialog. */
  sendDocFolder: string;
  /** Where Save Marked Cards writes — same model as `sendDocDestination`:
   *  `sameFolder` (default) drops it beside the source file, `fixedFolder`
   *  always writes into `markedCardsFolder`. Unresolvable → Save-As dialog. */
  markedCardsDestination: 'sameFolder' | 'fixedFolder';
  /** Destination folder for Save Marked Cards when `markedCardsDestination`
   *  is `fixedFolder`. Empty falls the command back to the OS save dialog. */
  markedCardsFolder: string;
  /** When on, the highlight marks in the doc render in the colors
   *  defined by `overrideHighlightSlots` rather than their stored
   *  colors. Display-only — does NOT mutate the doc, so saving
   *  back to `.cmir` / `.docx` preserves the original per-mark
   *  colors. Useful when cards from many sources have
   *  inconsistent highlight conventions and the user wants a
   *  visually-unified read. */
  overrideHighlightColor: boolean;
  /** 1–3 hex/rgba colors used to remap highlights at display
   *  time. If length 1: every highlight renders as that color.
   *  If length > 1: the most-common source highlight color gets
   *  slot 0, the second-most-common gets slot 1, and everything
   *  else gets the LAST slot (so "third" slot doubles as the
   *  catch-all when length is 3). Frequency ranking is computed
   *  per-doc by the highlight-frequency plugin. */
  overrideHighlightSlots: string[];
  /** Same idea, applied to `shading` marks (the protected
   *  highlight variant Verbatim uses for "remove highlighting"-
   *  resistant emphasis). Default slot color matches the
   *  protected-grey convention. */
  overrideShadingColor: boolean;
  /** 1–3 hex/rgba colors mirroring `overrideHighlightSlots` for
   *  shading marks. */
  overrideShadingSlots: string[];
  /** Show the actual highlight / shading color NAMES at the caret in
   *  the status bar, independent of the display overrides above. The
   *  15 OOXML hues carry meaning in shared files (each author's
   *  color-coding convention); this exposes that meaning as text —
   *  the colorblind-accessible channel. */
  showCursorColorNames: boolean;
  /** Theme. `'light'` and `'dark'` force the corresponding
   *  palette. `'system'` (default) follows the OS-level
   *  `prefers-color-scheme` and tracks live changes. Setting
   *  resolves to the `data-theme` attribute on the document
   *  root; CSS rules at `:root[data-theme="dark"]` (in style.css)
   *  swap the `--pmd-c-*` token values. */
  theme: 'light' | 'dark' | 'system';
  /** Whether the active theme applies to the editor document
   *  area too. Default OFF: the chrome (ribbon, nav, status bar)
   *  follows the theme, but the document itself keeps a light /
   *  paper-like surface — the configuration most people want
   *  when running dark mode. Turn on to make the document area
   *  follow the chrome theme as well. */
  themeAppliesToDocument: boolean;
  /** Icon style for the app chrome (ribbon buttons, banners,
   *  dialog glyphs). `'modern'` (default) uses the Untitled UI
   *  line-icon set, painted in `currentColor` via CSS masks;
   *  `'classic'` falls back to the original emoji/text glyphs.
   *  Resolves to the `data-icons` attribute on the document
   *  root, consumed by `icons.css`. */
  iconSet: 'modern' | 'classic';
  /** Show a pill in the center of the ribbon displaying the
   *  active doc's filename. Off by default — the OS title bar
   *  carries this info on most platforms. Useful when the
   *  title bar is hidden, unstyled, or non-existent (tiling
   *  window managers without decorations, frameless windows,
   *  embedded web edition). Single-doc only; multi-pane shows
   *  per-pane chips regardless of this setting. */
  showDocNameChip: boolean;
  /** Whether the ribbon shows a vertically stacked Undo / Redo button
   *  pair at the far left (right of the timer panel when that's on
   *  the left, left of the file buttons). Off by default — undo/redo
   *  always work by keyboard; this is a mouse-first affordance. */
  showUndoRedoButtons: boolean;
  /** Whether to check for updates automatically (desktop only).
   *  ON by default since 2026-07-27 (opt-OUT — was opt-in; the fleet
   *  wasn't converging and old builds dominated relay traffic). The
   *  first window of an app session triggers a silent check at boot
   *  plus a silent daily recheck; anything found surfaces the update
   *  chip. Turn off here or pause for a week via the tournament
   *  button (`updateChecksPausedUntil`). Because `persist()` snapshots
   *  EVERY key, older installs have the old `false` default baked
   *  into their stored blob — `migrateAutoUpdateOptOut` flips those
   *  once at boot (marker-keyed, so a post-migration opt-out sticks).
   *  Manual checks via the About-this-install button always work
   *  regardless. No effect on the web edition (no update mechanism). */
  checkForUpdatesOnLaunch: boolean;
  /** Tournament mode: epoch ms until which the AUTOMATIC update checks
   *  (launch + daily) are paused; 0 = not paused. Set by the "Pause
   *  update checks for 1 week" button next to the auto-check toggle.
   *  Manual checks (Help menu / About section button) are unaffected —
   *  a deliberate "check now" should always work. */
  updateChecksPausedUntil: number;
  /** Width of the comments column in CSS pixels. User-resizable via
   *  the drag handle on the column's left edge. Clamped to
   *  `COMMENTS_WIDTH_MIN` … `COMMENTS_WIDTH_MAX` (240–560) — below
   *  240 threads get cramped, above 560 the column eats too much
   *  editor space. Default 320. */
  commentsColumnWidth: number;
  /** UI motion preference. `'auto'` (default) follows the OS
   *  `prefers-reduced-motion` media query and gives the user the
   *  motion-reduction state their system advertises. `'on'` always
   *  reduces motion (animations and transitions become instant);
   *  `'off'` always plays full motion even if the OS asked for
   *  reduced. Resolved into a `data-motion` attribute on the
   *  document root; CSS rules in `style.css` consume it. */
  reduceMotion: 'auto' | 'on' | 'off';
  /** Skip the reading view's page-flip animation regardless of the
   *  global reduceMotion resolution (mid-speech readers who want
   *  instant flips without flattening every other animation). */
  readerReduceMotion: boolean;
  /** Accessibility: remap the meaning-carrying hues (annotation
   *  accents, voice-mode dots, timer Aff/Neg, search matches, category
   *  chips) onto the Okabe-Ito colorblind-safe palette. Resolved into
   *  a `data-cvd` attribute on the document root; the token blocks in
   *  style.css consume it. Composes with light/dark; explicit Color
   *  overrides still win (inline styles beat the CSS blocks). */
  colorVisionFriendly: boolean;
  /** Accessibility: add a shape-coded underline to each in-document
   *  annotation kind (comment dotted, flashcard solid, AI thread
   *  dashed, private note double) so the kinds don't rely on tint hue
   *  alone. Off shows just the tinted backgrounds. Resolved into a
   *  `data-annotation-shapes` attribute on the document root;
   *  style.css consumes it. */
  annotationShapes: boolean;
  /** Subtle visual cue telling background color (shading) apart from
   *  highlighting in the editor: a faint 4px dot grid over each
   *  shaded run, in a mix of its own fill. Off (default) keeps the
   *  two visually identical. Resolved into a `data-shading-cue`
   *  attribute on the document root; style.css consumes it,
   *  branching on `data-shading-band` for dark fills. A hairline
   *  "plate edge" variant was prototyped and cut — it collides with
   *  boxed-emphasis borders. Display-only — never affects the file
   *  or exports. */
  distinguishShading: boolean;
  /** Accessibility: render the nav pane's Analytic entries in italics
   *  so they differ from sibling entries by shape, not color alone.
   *  The color cue is also entirely absent in dark mode (nav text is
   *  forced uniform) and with formatNavPaneByType off — italics
   *  survive both. Resolved into an `html.pmd-nav-analytic-italic`
   *  class (same pattern as pmd-nav-flat); style.css consumes it. */
  navAnalyticItalics: boolean;
  /** Accessibility: render cite-marked text at normal weight instead
   *  of the Verbatim bold. Display-only — export weight is unchanged.
   *  Resolved into an `html.pmd-cite-unbold` class; style.css
   *  consumes it in the editor and the ribbon style preview. */
  unboldCites: boolean;
  /** Accessibility: when true, the text cursor doesn't blink — the
   *  native blinking caret is hidden and a steady custom caret is drawn
   *  in its place. */
  disableCursorBlink: boolean;
  /** Desktop only. When true, Chromium builds the renderer accessibility tree
   *  so screen readers / assistive tech work — at the cost of re-exposing a
   *  known Chromium crash (blink::AXBlockFlowData::ComputeNeighborOnLine). OFF
   *  by default, which appends `--disable-renderer-accessibility` at startup.
   *  The authoritative value lives in a main-process pref file (read before the
   *  renderer exists); this mirror exists only so the settings UI can show it.
   *  Changing it requires an app restart. */
  accessibilityTreeEnabled: boolean;
  /** Windows/Verbatim Flow: when true, the persistent PowerShell host
   *  that talks to Excel is started at app launch, so the first Send to
   *  Flow is fast instead of paying the cold start. */
  flowHostOnLaunch: boolean;
  /** Policy for the local bridge's gated routes (`/insert`, `/jump`,
   *  `/docs`). `ask` (default): identified apps get per-app consent,
   *  unidentified callers are rejected with guidance. `open`: accept
   *  everything, identification optional — keeps legacy senders (Fast
   *  Debate Paste builds that predate X-App-Id) fully working.
   *  `off`: block the whole surface. Enforced in MAIN (mirrored via
   *  `host:sync-external-consent`); per-app decisions below apply in
   *  `ask` mode. */
  externalInsertPolicy: ExternalInsertPolicy;
  /** Per-app consent decisions for the local bridge, keyed by the
   *  app's self-declared `X-App-Id`. Written by the first-contact
   *  consent prompt and the External apps settings rows. */
  externalAppConsents: ExternalAppConsent[];
  /** Per-token UI color overrides. Keyed by CSS-variable name
   *  WITHOUT the `--` prefix (e.g. `"pmd-c-accent"`); values are
   *  CSS color strings the user picked in the accessibility
   *  panel. Applied as inline styles on documentElement so they
   *  win over the :root defaults AND over any future preset
   *  (high-contrast, colorblind, dark) that sets the variable
   *  via a body class. Empty by default. */
  customColorOverrides: Record<string, string>;
  /** Whether the navigation pane (outline) is visible in THIS
   *  window. Default on. Toggled via the ribbon's nav-pane
   *  button or the left-edge pull-tab that appears when the pane
   *  is hidden. Transient: not persisted to disk, not propagated
   *  to other windows — each window starts with the pane visible
   *  and the user can hide it independently. */
  navPaneVisible: boolean;
  /** Whether the nav pane styles entries by heading level / type
   *  (default on). When on: top-level headings render bold, lower
   *  levels in lighter weight / size, analytic entries in the
   *  analytic-blue accent. When off: every entry renders in the
   *  same weight, size, and color — only indentation conveys
   *  hierarchy. Display-only; doesn't touch the underlying doc.
   *  Symmetric in single-doc and multi-pane layouts. */
  formatNavPaneByType: boolean;
  /** Built-in countdown timer settings. (Panel visibility lives
   *  in `timer-state.ts`, not here — shared via BroadcastChannel
   *  so toggling the timer on in one window opens it in every
   *  other open window too. Settings here are configuration, not
   *  per-window UI state.) */
  /** Currently-active timer profile. All three profiles are
   *  user-customizable (see `timerProfiles`); there's no
   *  separate "custom" — edits go straight to the active
   *  profile's saved slot. */
  timerProfile: 'highSchool' | 'college' | 'pomodoro';
  /** Per-profile saved durations. Picking a profile loads its
   *  speech presets + prep total into the live settings
   *  (`timerSpeechPresets` / `timerPrepMinutes`); editing a
   *  value updates BOTH the live setting AND the active
   *  profile's saved slot here. Four preset slots — the panel
   *  shows the fourth only under `timerShowFourthPreset`.
   *  Defaults match each profile's conventional values: High
   *  school 3/5/8 + 8 prep, College 3/6/9 + 10 prep, Pomodoro
   *  25/15/5 + 0 prep. */
  timerProfiles: Record<'highSchool' | 'college' | 'pomodoro', {
    speechPresets: number[];
    prepMinutes: number;
  }>;
  /** The active profile's speech presets (four slots), lifted to
   *  the top level so the timer state + UI read it from one
   *  predictable spot instead of indexing into
   *  `timerProfiles[timerProfile]`. */
  timerSpeechPresets: number[];
  /** Show a fourth speech-preset button (expanded layout only —
   *  compact drops all presets). Preset 4 takes the Start/Pause
   *  cell and Start/Pause becomes a full-height column beside the
   *  display. For events whose speeches come in four distinct
   *  lengths. */
  timerShowFourthPreset: boolean;
  /** Per-side prep total in minutes. Reset refills both prep
   *  clocks to this value. */
  timerPrepMinutes: number;
  /** When the speech timer's remaining time crosses one of the
   *  configured `timerFlashSeconds`, the display flashes red.
   *  Off → no flashing regardless of remaining. */
  timerFlashEnabled: boolean;
  /** Audible alert (accessibility): beep when the running clock
   *  crosses each `timerFlashSeconds` threshold — the same alert
   *  points as the visual flash — plus a double beep at 0:00. Off
   *  by default. */
  timerSoundEnabled: boolean;
  /** Alert loudness, 0–100. */
  timerSoundVolume: number;
  /** Remaining-time thresholds (in seconds) at which the display
   *  flashes red when `timerFlashEnabled` is on. Default 5/3/1. */
  timerFlashSeconds: number[];
  /** Compact layout: drops the 9/6/3 preset column and stacks
   *  Reset under Start/Pause. */
  timerCompact: boolean;
  /** How to label the Aff / Neg prep buttons:
   *    'text'  → "A: 10:00" / "N: 10:00", no special color
   *    'color' → "10:00" / "10:00", blue + red border
   *    'both'  → "A: 10:00" / "N: 10:00", blue + red (default)
   *  Color-blind users can pick 'text'; minimalist users can pick
   *  'color' to drop the redundant A:/N: prefix. */
  timerPrepLabel: 'text' | 'color' | 'both';
  /** Which edge of the ribbon the timer panel occupies when shown.
   *  'left' (default) renders it as the first flex child; 'right'
   *  moves it past the settings/right stack via flex order (see
   *  html.pmd-timer-right in style.css). */
  timerPosition: 'left' | 'right';
  /** When read mode is toggled (either direction), scroll the
   *  editor to the very top of the doc and place the cursor at
   *  the start. Default off — toggling read mode keeps the
   *  viewport / cursor where they were. */
  jumpToDocTopOnReadModeToggle: boolean;
  /** Whether the find bar's "results list" expansion panel (the
   *  scrollable box of matches-in-context below the bar) starts
   *  open on the next find session. Mirrors the user's last
   *  toggle of the chevron button — defaults false so the bar
   *  opens compact unless the user expanded it last. */
  findResultsExpanded: boolean;
  /** Whether the find bar pre-fills its input with the user's
   *  last search query when reopened. When off, the bar opens
   *  empty (or with the current selection, if any, as the seed).
   *  When on (default), a non-empty selection still wins over the
   *  remembered query — matches Word's behavior. */
  findRememberLastQuery: boolean;
  /** The user's last find-bar query — empty string when none has
   *  been entered yet. Persisted only when `findRememberLastQuery`
   *  is on; capped to a sane length so the settings blob doesn't
   *  grow unbounded if a user pastes massive strings. */
  findLastQuery: string;
  /** Priority order for the categorized find sort (Ctrl-F). Each
   *  match falls into one of six categories — `heading` (pocket /
   *  hat / block), `tag`, `analytic`, `undertag`, `cite`, `other` —
   *  and the find bar's Next steps through matches in this order,
   *  with cursor-as-top proximity within each category. Must be a
   *  permutation of the six category names. Alt-F ignores this
   *  setting (proximity only). */
  findCategoryOrder: ('heading' | 'tag' | 'analytic' | 'undertag' | 'cite' | 'other')[];
  /** Whether "New Speech Document" seeds the doc with a Pocket
   *  heading carrying the speech's name. On (default) matches
   *  Verbatim's `NewSpeech`. Off creates a fully blank doc — one
   *  empty paragraph — for users who'd rather title their speeches
   *  inline. */
  includeSpeechDocPocket: boolean;
  /** Whether to show the cite preview on hover in the nav pane. */
  showCitePreview: boolean;
  /** Whether computed card numbers (the auto-numbering skeleton) render. Numbers
   *  are display-only; turning this off hides them without touching the doc.
   *  Authoring a role auto-enables it. See NUMBERING_PLAN.md §6. */
  showCardNumbering: boolean;
  /** Whether the ribbon's numbering button cluster (number / substructure /
   *  restart / visibility) is shown. On by default; this only hides the buttons,
   *  never the numbers themselves (that's `showCardNumbering`). */
  showNumberingButtons: boolean;
  /** Separator after the NUMBER glyph (display-only, does NOT round-trip — the
   *  `.docx` carries a canonical `1.`). One of `NumberingSeparator`. */
  cardNumberingFormat: NumberingSeparator;
  /** Separator after the SUBSTRUCTURE letter (display-only). Configured
   *  independently of the number separator. */
  cardNumberingSubFormat: NumberingSeparator;
  /** Whether substructure letters render uppercase (`A)`) instead of lowercase
   *  (`a)`). Display-only. */
  cardNumberingSubCapitalized: boolean;
  /** Whether substructure letters render bold like the numbers (default) or at
   *  normal weight. Display-only. */
  cardNumberingSubBold: boolean;
  /** Whether/where NUMBER cards indent (display-only). `off` = none; `tag` =
   *  indent just the tag line; `card` = indent the whole card. */
  cardNumberingIndent: 'off' | 'tag' | 'card';
  /** Whether/where SUBSTRUCTURE cards indent (display-only), configured
   *  independently of the number indent. Same values as `cardNumberingIndent`. */
  cardNumberingSubIndent: 'off' | 'tag' | 'card';
  /** Numbers take their heading's color instead of the numbering-color token:
   *  the tag/analytic text color settings drive the glyph, and a heading whose
   *  ENTIRE text carries one manual font color recolors its number to match
   *  (a partial recolor changes nothing). Overrides the numbering-color swatch
   *  while on. Display-only. */
  cardNumberingMatchHeadingColor: boolean;
  /** Show a red dot on the ribbon's Manage Flashcards button when one or
   *  more flashcards are due for review today. On by default. */
  flashcardDueDot: boolean;
  /** Spellcheck the editor (custom viewport-scoped checker — see
   *  `viewport-spellcheck.ts`). Underlines misspellings in the visible
   *  document, including text in opened files (not just what you type);
   *  right-click a flagged word for suggestions, Add to Dictionary, or
   *  Ignore. Off by default because debate evidence (author names,
   *  jargon) produces many false positives. */
  editorSpellcheck: boolean;
  /** Word-style smart quotes: as you type a straight ' or ", curl it to the
   *  right direction based on the preceding character. Off by default. */
  smartQuotes: boolean;
  /** Auto-capitalize sentence starts (and standalone `i`) in TAGS and
   *  ANALYTICS only — the user's own prose. Card bodies / cites are source
   *  excerpts whose casing must be preserved verbatim. Off by default. */
  autoCapitalizeSentences: boolean;
  /** Word-style "replace text as you type": user-defined expansions from the
   *  customAutocorrects table, committed by a delimiter. Off by default. */
  customAutocorrectEnabled: boolean;
  /** The replacement table. `from` keys are whitespace-free (≤64 chars),
   *  unique case-insensitively; `to` ≤256 chars. Applies everywhere (an
   *  expansion is explicit user intent, unlike auto-capitalization). */
  customAutocorrects: Array<{ from: string; to: string }>;
  /** Custom dash autoformat — when you type `---`, replace it (on the third
   *  hyphen) with a chosen dash output (en/em dash, with or without surrounding
   *  spaces). Backspace right after reverts to the literal `---`. Off by
   *  default. */
  customDashEnabled: boolean;
  /** Copy Previous Cite (Alt-F8): when true (default), copy only the
   *  single nearest preceding cite paragraph. Off = every cite under
   *  the source card / run (the Verbatim-style behavior). */
  copyPreviousCiteNearestOnly: boolean;
  /** "New paragraph on Enter": what pressing Enter at the END of each
   *  structural textblock creates. 'normal' keeps the default
   *  behavior (a plain paragraph — or, for tag/analytic, the
   *  tag-keymap's body-line-inside-the-card). Any other choice
   *  behaves exactly like pressing Enter and then that style's
   *  command (F4/F5/F6/F7/Mod-F7/Mod-F8) on the fresh block — card
   *  splits, doc-level escapes, and wrapping all inherit those
   *  commands' semantics. See enter-style.ts. */
  enterAfterPocket: EnterAfterStyle;
  enterAfterHat: EnterAfterStyle;
  enterAfterBlock: EnterAfterStyle;
  enterAfterTag: EnterAfterStyle;
  enterAfterAnalytic: EnterAfterStyle;
  enterAfterUndertag: EnterAfterStyle;
  customDashStyle: 'en' | 'en-spaced' | 'em' | 'em-spaced';
  /** What typed sequence the custom dash replaces: '---' (fires on
   *  the third hyphen) or '--' (fires on the second). An exclusive
   *  choice because a '--' rule fires before it can know whether a
   *  third hyphen is coming — the two triggers can't coexist. */
  customDashTrigger: '---' | '--';
  /** Microphone for voice control (MediaDeviceInfo.deviceId).
   *  Empty string = system default. Desktop only. */
  voiceInputDeviceId: string;
  /** Idle seconds before the voice session auto-sleeps. 0 disables. */
  voiceAutoSleepSeconds: number;
  /** Glyph the bare spoken word "dash" inserts during dictation.
   *  Explicit names (hyphen, m dash, …) always bypass this. */
  voiceDashStyle:
    | 'em' | 'em-spaced' | 'en' | 'en-spaced' | 'hyphen' | 'hyphen-spaced'
    | 'double' | 'double-spaced' | 'triple' | 'triple-spaced';
  /** Dictation decode model: shipped standard, or the opt-in large
   *  download (better general-English accuracy; ~5 GB RAM). */
  voiceDictationModel: 'standard' | 'large';
  /** Whether autosave is on. When true, doc-changing edits schedule
   *  a background write-back to the file's existing on-disk
   *  location, debounced by ~5s of idle. Only fires for `.cmir`
   *  documents (native format serialization is cheap); `.docx`
   *  files are skipped because `toDocx` is expensive enough that
   *  per-keystroke autosaves would visibly stutter the editor. */
  autosaveEnabled: boolean;
  /** Whether read mode is currently active (dims non-read-aloud content,
   *  blocks editing). Transient — per-window, never persisted (see
   *  `TRANSIENT_SETTING_KEYS`). */
  readMode: boolean;
  /** When true, strip ALL emphasis-mark borders in read mode (not just
   *  the ones around hidden text). Some users prefer the cleanest look
   *  in read mode regardless of what's emphasized. */
  hideEmphasisBordersInReadMode: boolean;
  /** When true, read mode keeps each body paragraph on its own line
   *  instead of flowing a card's paragraphs together as one continuous
   *  run. The display-only counterpart of the condense setting of the
   *  same name (`paragraphIntegrity`) — that one rewrites the doc, this
   *  one only changes what read mode draws. Off by default: the single
   *  continuous flow is what most people want at the podium. */
  readModeParagraphIntegrity: boolean;
  /** When true, tint every run of card body text that falls AFTER a
   *  reading-position marker red, a visual record of what you didn't reach
   *  in a round. Bounded per-card; display-only (a decoration, never a doc
   *  edit). See `mark-unread-plugin.ts`. */
  markUnreadAfterMarker: boolean;
  /** The body-text zoom (50–300%, step 10) any editor OPENS at. The live
   *  per-editor zoom is NOT a setting — it's transient per window / per pane and
   *  resets to this default on reload, so different documents can sit at
   *  different zooms. Only this default persists and syncs. */
  defaultZoomPct: number;
  /** Chrome (page) zoom for the whole window, as a percentage
   *  (50–300, step 10). Wired to Chromium's `webFrame.setZoom-
   *  Factor` on Electron, which reflows the page exactly the
   *  way the browser's built-in Ctrl-+ chord does — chrome AND
   *  doc content both scale uniformly. Stacks multiplicatively
   *  with the body zoom: if the doc looks too big at a higher
   *  chromeScalePct, dial the body zoom down to compensate. Unlike
   *  body zoom, chrome scale stays linked across windows. No-op
   *  on the web edition (use the browser's own page-zoom). */
  chromeScalePct: number;
  /** Zoom the editor with a trackpad pinch or Ctrl+mouse-wheel. Off by
   *  default. Both gestures arrive as the same event (Chromium delivers a
   *  trackpad pinch as a `wheel` with `ctrlKey`), so this one toggle
   *  governs both. Adjusts the live body zoom, in 10% steps, and
   *  suppresses Chromium's own native page-zoom on the gesture. */
  gestureZoom: boolean;
  /**
   * Readers used for read-time estimates. The full list shows up in the
   * Word Count Selection function (Ctrl+F11). The first two readers are
   * also displayed in the bottom status bar live.
   */
  readers: ReaderConfig[];
  /**
   * When on, the status-bar read-time / word counter updates live as
   * you change the selection (showing the selection's read time). Off
   * by default: the counter then always reflects the whole doc, and a
   * selection's read time is available on demand via the Word Count
   * button. Live updates re-count on every selection change, which is
   * O(selection) work per drag tick — opt-in so users on very large
   * docs don't pay it.
   */
  liveSelectionWordCount: boolean;
  /**
   * Append the smallest enclosing container's read time (card /
   * analytic unit / block section) to the live word-count readout —
   * or the selection's when one exists. Cursor moves within a
   * container reuse a cached count, so the per-keypress cost is an
   * ancestor walk; crossing containers costs one O(container) count.
   */
  liveContainerReadTime: boolean;
  /**
   * Append a third segment to the live word-count readout: the
   * read-aloud words still ahead of the cursor, with the same per-reader
   * times ("what's left to read"). Off by default. Measured from the
   * selection's end, so a selection counts as already read. Cheap — a
   * suffix-sum table over the doc's top-level children is built once per
   * doc, so a cursor move only counts the child it lands in.
   */
  liveRemainingReadTime: boolean;
  /**
   * Per-style font sizes (in points). See DisplaySizes for details.
   * Each field becomes a CSS custom property on `#editor`.
   */
  displaySizes: DisplaySizes;
  /** Per-style paragraph spacing (top/bottom margins) in points. A
   *  display override applied via CSS variables, like line spacing. */
  displayParagraphSpacing: DisplayParagraphSpacing;
  /**
   * Per-style typography flags (bold/italic/underlined/box). See
   * DisplayTypography. Each becomes a class toggle on `#editor`.
   */
  displayTypography: DisplayTypography;
  /** Per-style center/justify alignment overrides (accessibility).
   *  Applied as CSS custom properties; see StyleAlignments. */
  styleAlignments: StyleAlignments;
  /** Maximum text-column width in px, 0 = off (default). Caps the
   *  ProseMirror content column, so reading long lines doesn't require
   *  sweeping the eyes across a wide screen (accessibility).
   *  Display-only. */
  maxTextWidthPx: number;
  /** Where the capped column sits in the editor: centered (default),
   *  or pinned to the left / right edge. Inert while the cap is off. */
  maxTextWidthAlign: 'center' | 'left' | 'right';
  /**
   * Per-style display colors. See DisplayColors. Each becomes a CSS
   * custom property on `:root`.
   */
  displayColors: DisplayColors;
  /**
   * Body font family. Mirrors Verbatim's NormalFont. Applied as a CSS
   * custom property on `#editor`; rendered with sans-serif fallback.
   */
  bodyFont: string;
  /**
   * What to show in ribbon tooltips. Four modes:
   *   - `none`      — no tooltips on any ribbon button.
   *   - `tooltip`   — label only (e.g., "Apply Tag Style"). Dropdown
   *                   menu items get NO tooltip (the menu item label
   *                   already states what it does).
   *   - `shortcut`  — only the current keyboard shortcut (e.g., "F7").
   *                   Buttons / items without a shortcut get no tooltip.
   *   - `both`      — label + shortcut (e.g., "Apply Tag Style (F7)").
   *                   Dropdown items still show shortcut-only because
   *                   their label is already in the menu.
   */
  ribbonTooltipMode: 'none' | 'tooltip' | 'shortcut' | 'both';
  /** Whether the cross-window dropzone pill (the floating shelf in
   *  the editor's bottom-left corner) is visible. The shelf state still
   *  works when off (Ctrl+\` sends, content is reachable from the
   *  next window opened); the pill is just hidden from the chrome. */
  showDropzonePill: boolean;
  /** Whether the Quick Cards ribbon cluster (the 2×2 stack: command bar, tag
   *  picker, manage, add) is shown in the chrome. Off by default. Quick cards
   *  still work when hidden — the store and commands stay live, and the command
   *  bar still opens via its keyboard shortcut. */
  showQuickCardButtons: boolean;
  /** Folders for the command-palette file search (the `f` prefix). Each is
   *  searched recursively for `.cmir`/`.docx` files on demand; folders that
   *  overlap are fine — a file found under more than one is searched once.
   *  Empty list disables file search. Electron only. */
  fileSearchRoots: string[];
  /** Folders and files the file search must never list, no matter which
   *  root they live under. A folder excludes everything beneath it.
   *  Absolute paths; applied to the listing before matching, so excluded
   *  entries never reach results, pins, or the background warm pass.
   *  Electron only. */
  fileSearchExclusions: string[];
  /** Which file formats appear in the command-palette file search:
   *  'both' (default), 'cmir' only, or 'docx' only. */
  fileSearchFormats: 'both' | 'cmir' | 'docx';
  /** Which structural objects appear when searching within a file
   *  (`f` → Tab). Subset of pocket/hat/block/tag/cite/analytic;
   *  defaults to block/tag/cite. Stored as kind strings. */
  fileSearchObjectTypes: string[];
  /** How deep the file-search outline browse is expanded by default
   *  (1 Pocket … 4 Tag) — headings at this level or deeper start
   *  collapsed, so depth 3 (default) shows blocks with their tags
   *  collapsed. Mirrors the nav pane's `navMaxLevel`. */
  fileSearchOutlineDepth: number;
  /** Same-tier ordering for file-search results (and the no-query browse
   *  list): 'recency' (most-recently-modified first, default) or
   *  'alphabetical'. Results are first ranked by match quality; this only
   *  breaks ties within a tier. */
  fileSearchTiebreak: 'recency' | 'alphabetical';
  /** Whether file search auto-pins recent + frequently-used files
   *  (keeping them warm for instant dives). Default on; turn off to
   *  warm only files pinned by hand (for memory-sensitive users). */
  pinAutoEnabled: boolean;
  /**
   * User-interface font family. Applied as `--pmd-ui-font` on
   * documentElement; flows into every UI surface (ribbon, dialogs,
   * nav pane, comments column, etc.). Empty string keeps the
   * stylesheet's system-UI default — distinct from `bodyFont`,
   * which is the editor-content font.
   */
  uiFont: string;
  /**
   * Per-paragraph-type line-height multipliers. Each maps to a CSS
   * variable on `#editor` (--pmd-line-height, --pmd-line-height-cite,
   * etc.). `lineHeight` is the body knob — it also scales shrunken-
   * paragraph line-heights via the font-size-class plugin's ramp.
   * Each is unitless; range 1.0–2.0.
   */
  lineHeight: number;
  lineHeightCite: number;
  lineHeightTag: number;
  lineHeightAnalytic: number;
  lineHeightHeading: number;
  lineHeightUndertag: number;
  /**
   * Display mode for the ribbon's formatting panel (Pocket / Hat /
   * Block / Tag / Analytic buttons). 'labels' shows the style name on
   * each button, 'shortcuts' shows the keyboard binding, 'hidden'
   * removes the panel entirely.
   */
  formattingPanelMode: FormattingPanelMode;
  /**
   * When true, the formatting-panel buttons preview the visual
   * treatment of the style they apply (Pocket boxed, Hat double-
   * underlined, Tag bold, etc.). When false, buttons are rendered as
   * plain text. Has no effect when formattingPanelMode is 'hidden'.
   */
  formattingPanelPreview: boolean;
  /**
   * When true (default), the cite/underline/emphasis "character
   * styles" sub-panel is shown in the ribbon. When false, just that
   * sub-panel is hidden (the rest of the formatting panel, color
   * controls, etc. stay visible). Independent of formattingPanelMode:
   * setting the mode to "Hidden" hides everything regardless.
   */
  showCharacterStyles: boolean;
  /**
   * Last highlight color picked from the ribbon dropdown. One of the
   * 15 Word named highlight colors (`yellow`, `green`, `darkRed`, …),
   * or null for "No highlight" — the pen paints nothing, so F11 / the
   * paintbrush strip the mark instead of applying one. Used as the
   * active color when F11 toggles highlight on; persisted so the
   * editor remembers each user's preferred color.
   */
  lastHighlightColor: string | null;
  /**
   * Last shading color picked from the ribbon dropdown. 6-char hex
   * (no leading `#`), or null for "No background color" (the pen
   * strips the mark, mirroring lastHighlightColor). Default is
   * Verbatim's D2D2D2 protected-highlight grey. Used as the active
   * color when Ctrl-F11 toggles shading on.
   */
  lastShadingColor: string | null;
  /**
   * Last font color picked from the ribbon dropdown. 6-char hex
   * (no leading `#`), or null for "Automatic" (no font_color mark).
   * When null, the Automatic option in the dropdown is the active
   * selection; applying font color removes the mark entirely instead
   * of writing a black explicitly.
   */
  lastFontColor: string | null;
  /**
   * Condense settings — drive the behavior of the default condense
   * hotkey (F3) and modify selection-based condense semantics. See
   * ARCHITECTURE.md §15 condense for the full rule table.
   *
   * `paragraphIntegrity`:
   *   - true  → F3 keeps paragraphs separate (Branch C); only intra-
   *             paragraph whitespace is cleaned.
   *   - false → F3 merges collapsible paragraph runs (Branch A or B
   *             depending on `usePilcrows`).
   *   Toggled from the ribbon (paragraph-integrity button) and the
   *   settings panel.
   *
   * `usePilcrows`:
   *   - false → merging joins paragraphs with spaces (Branch A).
   *   - true  → merging inserts a 6-pt ¶ at each original boundary
   *             (Branch B), so paragraph splits are recoverable via
   *             Uncondense. Only consulted when `paragraphIntegrity`
   *             is false (no boundaries to mark otherwise).
   *
   * `headingMode`:
   *   - 'strict'   → selection-based condense **no-ops** if the
   *                  selection touches any structural element
   *                  (heading / cite_paragraph / undertag). Safest
   *                  mode — won't accidentally cross a structural
   *                  boundary. Body-only selections behave like
   *                  'respect'.
   *   - 'respect'  → selection keeps headings + cite_paragraphs +
   *                  undertags as their own paragraphs; only
   *                  consecutive runs of card_body / doc-level
   *                  paragraph merge.
   *   - 'demolish' → selection demolishes everything in its range;
   *                  the collapsed textblock's type = type of the
   *                  first touched paragraph; cards / analytic_units
   *                  whose head was touched dissolve and orphan body
   *                  slots absorb into the receiving container.
   */
  paragraphIntegrity: boolean;
  usePilcrows: boolean;
  /** When on, the Extract Undertag command wraps the excerpt it pulls
   *  into a new undertag in double quotes. Off by default. */
  extractUndertagInQuotes: boolean;
  headingMode: HeadingMode;
  /**
   * When true, F2 (Paste Text) runs the default condense pass on the
   * card after pasting. Mirrors Verbatim's `CondenseOnPaste` flag —
   * off by default; useful for users who almost always paste a long
   * blob of text that needs to be tightened up. The condense it runs
   * is the same one F3 invokes (respects `paragraphIntegrity` /
   * `usePilcrows` / `headingMode`).
   */
  condenseOnPaste: boolean;
  /** Smart paste conversion (default on): clipboard HTML recognized as
   *  coming from Word or haku.cards is converted into CardMirror
   *  structure — cards, cites, headings, named-style marks, highlights,
   *  numbering — via the docx importer's assembly path. Off, or when
   *  nothing recognizable is found, pastes behave exactly as before.
   *  F2 plain paste always overrides. */
  smartPasteConversion: boolean;
  /** Where the cursor lands after a paste that splits a card around
   *  pasted structure (a whole card / tag / heading pasted into a card
   *  body). 'after' (default): the end of the pasted content, like
   *  every other paste. 'tag': the end of the FIRST pasted heading —
   *  the F7/setHeading convention, ready to rename the tag. */
  pasteCursor: 'after' | 'tag';
  /** Version-history snapshots for saved documents (userData/history):
   *  'standard' (default) keeps capped periodic .cmir snapshots on
   *  every save trigger; 'extended' keeps more, longer; 'off' keeps
   *  none. Browsable via Recover Previous Version. Never a substitute
   *  for the crash journals — see version-history.ts. */
  versionHistory: 'off' | 'standard' | 'extended' | 'custom';
  /** Custom-tier caps (MB), used only when versionHistory = 'custom';
   *  0 = uncapped. Rendered inside the Keep-version-history editor,
   *  not as their own settings rows. */
  versionHistoryDocCapMb: number;
  versionHistoryTotalCapMb: number;
  /** Which gaps the formatting-gap bridge treats as bridgeable: 'both'
   *  (whitespace and punctuation) or 'whitespace' (whitespace only). Feeds both
   *  the auto-bridge and the manual Fix Formatting Gaps command. */
  formattingGapClass: FormattingGapClass;
  /** When on (default), applying a formatting mark auto-bridges the gaps at the
   *  edges of what changed to an adjacent same-formatted word. Off disables only
   *  the auto-bridge — the manual Fix Formatting Gaps command still runs. */
  autoBridgeFormattingGaps: boolean;
  /**
   * When true, removing a named-style mark (F8 Emphasis / F9 Underline /
   * F10 Cite) via the apply key ALSO strips direct formatting (font
   * size / color / family, bold, italic, strikethrough, highlight,
   * shading, direct underline) from the same range. Mirrors Verbatim's
   * "press F9 twice to clear formatting" workflow. When off, toggling
   * the named-style off leaves any direct formatting the user manually
   * added intact.
   *
   * Always applies on the apply direction (adding the named-style mark
   * strips direct formatting unconditionally — the user can manually
   * re-apply direct formatting after).
   */
  clearFormattingOnNamedStyleToggleOff: boolean;
  /**
   * The highlight color the "Standardize Highlighting (with
   * Exception)" command leaves untouched. One of Word's 15 named
   * highlight colors (`yellow`, `green`, …). Runs highlighted in this
   * color are skipped when the command rewrites everything else to
   * the active pen color (or strips, when the pen is "No highlight").
   */
  standardizeHighlightException: string;
  /**
   * The background color the "Standardize Background Color (with
   * Exception)" command leaves untouched. 6-char hex, no leading `#`
   * (matching the shading mark's stored attr); compared
   * case-insensitively.
   */
  standardizeShadingException: string;
  /** When true, "Create Reference" (Card menu) emits its body text
   *  in Gray-50% (#808080) instead of black. Heading line stays
   *  black either way. */
  forReferenceUseGray50: boolean;
  /** When true (default), the Create Reference excerpt starts with
   *  the `<<CITE FOR REFERENCE>>` heading line. Off copies just the
   *  reformatted body paragraphs. */
  createReferenceIncludeHeading: boolean;
  /** Bracket pair wrapping the heading line (default `<<` … `>>`). */
  createReferenceDelimiter: CreateReferenceDelimiter;
  /** When true (default), the card's cite (e.g. SMITH 24) appears in
   *  the heading — before the label, or wherever `%Cite%` sits in a
   *  custom heading. Off drops it (and empties `%Cite%`). */
  createReferenceIncludeCite: boolean;
  /** Custom heading text replacing the default FOR REFERENCE label.
   *  `%Cite%` (any case) marks where the cite goes; without it the
   *  cite is prepended as in the default heading. Empty = default. */
  createReferenceCustomHeading: string;
  /** Bold the Create Reference heading line. */
  createReferenceHeadingBold: boolean;
  /** Italicize the Create Reference heading line. */
  createReferenceHeadingItalic: boolean;
  /** Apply the emphasis style to the heading line. Wins over underline
   *  when both are on (they're mutually exclusive). */
  createReferenceHeadingEmphasized: boolean;
  /** Underline the heading line. Ignored when emphasized is also on. */
  createReferenceHeadingUnderlined: boolean;
  /** When true (default), Create Reference reduces every run's font
   *  size in the copied excerpt (by `createReferenceShrinkPt`). Off
   *  keeps each run's size untouched. */
  createReferenceShrinks: boolean;
  /** How many points Create Reference reduces text size by (default
   *  3). Results never drop below 1pt. Only applies while
   *  `createReferenceShrinks` is on. */
  createReferenceShrinkPt: number;
  /** What Create Reference does with highlighted text in the copied
   *  excerpt. 'shading' (default) converts highlights to the
   *  Protected Grey background; 'convert' turns each into a
   *  background of the same color; 'keep' leaves them as highlights;
   *  'remove' strips them. */
  createReferenceHighlightMode: CreateReferenceHighlightMode;
  /** When true, Shrink (Mod-8) treats bracketed "Omitted" spans AND
   *  the `[PARAGRAPH INTEGRITY PAUSES/RESUMES]` markers emitted by
   *  "Condense with warning" specially: their existing size is
   *  excluded from the cycle decision, and after the size pass they're
   *  restored to Normal so they remain visible in the shrunken output.
   *  When off, both are shrunk along with the surrounding text. */
  shrinkRestoresOmissionsToNormal: boolean;
  /**
   * Delimiter family for "Condense with warning". One of the six
   * bracket pairs (which produce `<open>PARAGRAPH INTEGRITY
   * PAUSES<close>` / `…RESUMES<close>`) or `'custom'` (which uses
   * the user-typed marker strings below in place of the entire
   * marker text). Default `[` matches the most common convention in
   * user docs.
   */
  condenseWarningDelimiter: CondenseWarningDelimiter;
  /** When `condenseWarningDelimiter` is `'custom'`, this string is
   *  inserted verbatim as the pause-marker paragraph (replacing the
   *  entire `[PARAGRAPH INTEGRITY PAUSES]` text). Empty string
   *  disables the command (it no-ops with a console warn). */
  condenseWarningCustomPauseMarker: string;
  /** Companion to `condenseWarningCustomPauseMarker` — inserted as
   *  the resume-marker paragraph. */
  condenseWarningCustomResumeMarker: string;
  /**
   * User-supplied strings (or regexes) that Shrink should treat as
   * protected — same pipeline as the built-in bracketed-Omitted
   * patterns and the PARAGRAPH INTEGRITY PAUSES/RESUMES markers. The
   * whole list is gated by `shrinkRestoresOmissionsToNormal`. Each
   * entry: a string and an `isRegex` flag. When false, the string is
   * regex-escaped and matched case-insensitively. When true, it's
   * compiled as a regex source verbatim (still with `gi` flags).
   * Invalid regex sources are silently dropped at compile time.
   */
  shrinkCustomProtections: ShrinkProtection[];
  /** Custom letter selections for the acronym commands: when an
   *  acronym command's selection matches an entry's phrase, the
   *  picked characters are marked instead of each word's first
   *  letter (so "weapons of mass destruction" can read as "WMD",
   *  skipping the "of"). Edited via the letter-picker in Settings →
   *  Editing → Acronym marking. */
  acronymPatterns: AcronymPattern[];
  /**
   * User-supplied overrides for command key bindings. Each entry maps
   * a command id (a `RibbonCommandId` or a plugin command id) to its
   * custom key spec - either a
   * single key string (e.g. `'F8'`, `'Mod-Shift-7'`) or an array for
   * multi-binding commands (e.g. `['F9', 'Mod-u']`). An empty string
   * or empty array means "explicitly unbound" (the command exists in
   * the menu / ribbon but has no key). Commands not present in this
   * map fall back to `DEFAULT_RIBBON_KEYS`.
   */
  ribbonKeyOverrides: Partial<Record<string, string | string[]>>;
  /** Up to 10 user-configured custom buttons, shown to the right of the
   *  comments buttons on the ribbon (empty = the section is hidden). */
  ribbonCustomButtons: RibbonCustomButton[];
  /** User-defined "press a key → type this text" macros. */
  keyboardMacros: KeyboardMacro[];
  /** Display name attached to new comments authored locally. */
  commentAuthor: string;
  /** Initials attached to new comments authored locally (Word shows
   *  these in the margin badge). Auto-derived from `commentAuthor`
   *  if left empty. */
  commentAuthorInitials: string;
  /** Whether the right-side comments column is currently visible.
   *  Toggled by the comments-show-hide ribbon button; persisted so
   *  the editor remembers the last state. */
  commentsVisible: boolean;
  /** Anthropic API key for AI features. Empty until the user sets
   *  one. Stored locally; never sent anywhere except direct calls
   *  to the Anthropic API. */
  anthropicApiKey: string;
  /** Optional override for the Claude model id used by every AI feature.
   *  Empty (or malformed) falls back to the app's built-in default; a
   *  well-formed id is sent as-is. Lets a user move to a newer model
   *  without updating the whole app when the default is retired. */
  aiModelOverride: string;
  /** Which inference provider the AI features talk to. `'anthropic'`
   *  uses the Anthropic Messages API + `anthropicApiKey`; `'openrouter'`
   *  uses OpenRouter (OpenAI-chat-compatible) + `openrouterApiKey` /
   *  `openrouterModel`. */
  aiProvider: 'anthropic' | 'openrouter';
  /** OpenRouter API key. Used only when `aiProvider === 'openrouter'`.
   *  Stored locally; sent only to openrouter.ai. */
  openrouterApiKey: string;
  /** OpenRouter model id (e.g. `anthropic/claude-sonnet-4.6`). Required
   *  when OpenRouter is selected; there is no built-in default. */
  openrouterModel: string;
  /** Max output tokens for AI calls that don't set their own ceiling
   *  (cite, explain, flashcards, image alt text). Applies to both
   *  providers. Reasoning models count hidden thinking tokens against
   *  this budget, so a low value can leave no room for the actual reply
   *  — hence a 1024 floor and a recommendation to go higher. */
  aiMaxTokens: number;
  /** Master switch for AI features (the explainer comment shortcut,
   *  @AI mentions inside comments, etc.). When false, no UI for
   *  AI shows up and no API calls happen even if a key is set. */
  aiFeaturesEnabled: boolean;
  /** Friendlier "Clod" persona for the AI in-flight indicator —
   *  while the model is composing a reply, the placeholder cycles
   *  through time-of-day Clod activities ("Clod is making toast…").
   *  Off by default; the easter-egg configurator (shift+right-click
   *  on the toggle in Settings) opens a dialog to customize the
   *  activity pools per time period. */
  clodEnabled: boolean;
  /** Per-time-period activity override pools. Empty arrays fall
   *  back to the built-in lists in `src/editor/ai/clod.ts`. */
  clodActivitiesByTime: {
    morning: string[];
    day: string[];
    evening: string[];
    night: string[];
  };
  /** Hour boundaries (0-23) for each Clod time period. Periods may
   *  cross midnight (start > end), which is normal for "night". */
  clodTimePeriods: {
    morning: { start: number; end: number };
    day: { start: number; end: number };
    evening: { start: number; end: number };
    night: { start: number; end: number };
  };
  /** Display name for the AI persona — drives the comment author
   *  name (when Clod mode is on), the in-flight activity text
   *  (substituted into the built-in "Clod is …" templates), and the
   *  AI button tooltip. Default: "Clod". */
  aiPersonaName: string;
  /** Pronoun set used to template the built-in Clod activities.
   *  `'custom'` reads from `aiPersonaCustomPronouns`. */
  aiPersonaPronouns: 'he' | 'she' | 'they' | 'it' | 'custom';
  /** Used only when `aiPersonaPronouns === 'custom'`. */
  aiPersonaCustomPronouns: {
    subject: string;
    object: string;
    possessive: string;
    reflexive: string;
  };
  /** System prompt for the AI cite creator. Editable via the
   *  Settings dialog's "Edit prompt" modal — long enough that a
   *  full textarea makes more sense than an inline input. Empty
   *  string falls back to `DEFAULT_AI_CITE_PROMPT`. */
  aiCitePrompt: string;
  /** Translator backend. `'auto'` uses the AI provider when AI features
   *  are ready, otherwise MyMemory. `'mymemory'` (no key, works with AI
   *  off), `'anthropic'` (the AI-provider backend — follows the Comments
   *  & AI provider, needs AI features), `'google'` (needs an API key). */
  translationProvider: 'auto' | 'mymemory' | 'anthropic' | 'google';
  /** Target language for translation (ISO 639-1). Default `'en'`. */
  translationTargetLang: string;
  /** Source language for translation (ISO 639-1), or `'auto'` to detect.
   *  MyMemory needs a concrete source, so on `'auto'` we detect locally
   *  (tinyld) first; Anthropic / Google detect server-side. */
  translationSourceLang: string;
  /** Optional email for MyMemory — raises its free daily char limit. */
  myMemoryEmail: string;
  /** Google Cloud Translation API key (only used by the `'google'`
   *  backend). Stored locally; sent only to translation.googleapis.com. */
  googleTranslateApiKey: string;
  /** When on, the Translator prepends a `[TRANSLATION BY <attribution>]`
   *  marker line (wrapped in the "Condense with warning" delimiter) to the
   *  clipboard output — the attribution is the model for Anthropic,
   *  MYMEMORY for MyMemory, or GOOGLE TRANSLATE for Google. */
  prependTranslationMarker: boolean;
  /** Master switch for the multi-doc workspace shell — three slots,
   *  each holding a stack of 0+ docs. Toggling this requires a
   *  page reload to (re)build the editor shell. Comments are
   *  unavailable while this is on. See SPEC-multi-pane.md. */
  multiDocWorkspace: boolean;
  /** Which UI shell the web edition uses on this device. `'auto'`
   *  picks the mobile shell on coarse-pointer screens narrower than
   *  1024px (resolved once per load — rotating mid-session doesn't
   *  thrash the shell); `'mobile'` / `'desktop'` force it. The
   *  mobile shell is view-first: no on-screen keyboard, reading +
   *  outline navigation + crude structural moves. See
   *  SPEC-mobile-view.md. */
  mobileLayout: 'auto' | 'mobile' | 'desktop';
  /** When `multiDocWorkspace` is on and three slots are populated:
   *  `compact` shows all three panes side by side; `wide` widens
   *  each pane and lets the user paged-scroll between them
   *  (2 full + edge of 3rd visible). With 1 or 2 active slots the
   *  two modes render identically. */
  multiDocLayoutMode: 'compact' | 'wide';
  /** Quick Cards: tags currently active in the search-palette filter
   *  (edited by the Tag Picker). Empty = no filter (all cards in
   *  scope); non-empty scopes search to cards with >=1 active tag.
   *  Untagged cards are always in scope. Stored normalized
   *  (lowercased). Global + persisted. */
  quickCardActiveTags: string[];
  /** Master switch for the experimental AI card-cutter. Hidden and
   *  OFF by default; flipped on only via the console command
   *  `window.__cardcutter('on')`. When on, the card-cutter ribbon
   *  commands + shortcuts activate and the Card Cutter settings tab
   *  appears (with a Disable button that flips this back off). The
   *  cutting logic itself lives in the separately-versioned
   *  @cardmirror/card-cutter package, loaded dev-only. */
  cardCutterEnabled: boolean;
  /** Card-cutter: absolute path to the engine bundle to load (packaged
   *  builds only). Empty = use CARDCUTTER_ENGINE env or the default
   *  userData/plugins/cardcutter.global.js location. */
  cardCutterEnginePath: string;
  /** Card-cutter: emphasis style. FIXED at 'voice' — the setting has no
   *  UI anymore (the other variants tested worse, and we only present
   *  options with multiple valid choices). The key survives because the
   *  port ships it to the engine and the engine keeps the variants; if
   *  a better variant ever emerges, re-add the UI, not a new key. */
  cardCutterEmphasisStyle: 'voice' | 'independent' | 'minimal';
  /** Card-cutter: which read-length chip the cut panel opens with.
   *  0 = Efficient (no limit) — today's behaviour; otherwise one of the
   *  panel's presets (8/12/20/30s at the user's reader WPM). A legacy
   *  free-number value snaps to the nearest preset at panel open. */
  cardCutterReadTimeSec: number;

  /** Plugins: master switch for the plugin system (the registry, boot
   *  loading of enabled plugins, and the manage-plugins UI). Off by
   *  default. Desktop only for v1. */
  pluginsEnabled: boolean;
  /** Plugins: unlock GitHub installs from OUTSIDE the curated allowlist.
   *  Console-only (`window.__plugins('community-on')`), no settings row —
   *  plugins are full-trust code, so casual discovery is the thing being
   *  prevented. Re-armed into main each boot; enforcement lives there. */
  pluginCommunityInstalls: boolean;
  /** Pairing: master switch for cross-machine card sharing (the send /
   *  receive pills + the delivery channel). Off by default. Desktop +
   *  web (web since the Phase-4 renderer mailbox). */
  pairingEnabled: boolean;
  /** Pairing: fallback poll cadence in seconds. New cards arrive by live
   *  push; this paces the interval polling used against relays without
   *  the push endpoint (and, floored to 5 min, the belt-and-suspenders
   *  catch-up while streaming). Clamped to [5, 3600]; default 30. */
  pairingPollSeconds: number;
  /** Pairing: self-hosted relay base URL (e.g. https://relay.example.com/relay).
   *  Empty (default) = the official relay baked into the build. */
  pairingRelayUrl: string;
  /** Pairing: bearer token for a self-hosted relay (its RELAY_TOKEN).
   *  Empty (default) = the official build token. Stored locally. */
  pairingRelayToken: string;
  /** Pairing: display mirror of the blog-account entitlement expiry
   *  (epoch ms; 0 = not connected). The entitlement itself lives in
   *  Electron main; this mirror only drives the settings row's status
   *  line. Linking gates nothing while the relay runs ungated. */
  pairingConnectedUntil: number;
  /** Pairing: this machine's own shareable code — its relay address.
   *  Generated once (lazily on first enable) and shown in settings with
   *  Copy / Regenerate. Share it with a partner so they can send to you. */
  pairingOwnCode: string;
  /** Pairing: optional human name this machine stamps on outgoing cards,
   *  so a partner who hasn't nicknamed you yet still sees a readable
   *  sender. Empty falls back to the short code on the receiver. */
  pairingDisplayName: string;
  /** Collaboration sessions: render the partner's live cursor and
   *  selection (presence). Off = the doc still syncs, just without
   *  the cursor overlay. */
  collabShowCursors: boolean;
  /** Pairing: machines you can send to (their code + your nickname). */
  pairingPartners: PairingPartner[];
  /** Pairing: named groups of partners for one-drop fan-out sends. */
  pairingGroups: PairingGroup[];
  /** Pairing: sender codes to block. Cards and room invites from any of
   *  these codes are dropped silently — they never appear in the Receive
   *  inbox or its unread count. The sender code is self-declared, so this
   *  is a convenience filter, not a security boundary. */
  pairingBlockedCodes: string[];
  /** Pairing: the single starred send target — a partner (by code) or a group
   *  (by id) — that the "Send to Starred" shortcut sends to. null when nothing is
   *  starred. Sanitize clears it if it no longer points at a live recipient. */
  pairingStarred: { kind: 'partner' | 'group'; ref: string } | null;
  /** Pairing: how the receive pill flashes when a card arrives. */
  pairingReceiveFlash: PairingReceiveFlash;
  /** Clean: style names the .docx style cleaner must never prune, remove, or
   *  reassign away from (their basedOn/linked dependencies are kept too).
   *  Managed from the Clean utility's protected-styles panel. */
  cleanProtectedStyles: string[];
}

/** Open-delimiter options for "Condense with warning" markers. The
 *  six built-ins use mirror-pair closers via `condenseWarningCloseFor`;
 *  `'custom'` reads the close string from `condenseWarningCustomClose`. */
export type CondenseWarningDelimiter =
  | '[' | '[[' | '<' | '<<' | '{' | '{{' | 'custom';
const CONDENSE_WARNING_DELIMITERS: CondenseWarningDelimiter[] = [
  '[', '[[', '<', '<<', '{', '{{', 'custom',
];

/** Return the mirror close for a built-in open. Throws on 'custom'
 *  (callers should branch on the enum first and read the user-typed
 *  close string from settings instead). */
export function condenseWarningCloseFor(d: CondenseWarningDelimiter): string {
  switch (d) {
    case '[': return ']';
    case '[[': return ']]';
    case '<': return '>';
    case '<<': return '>>';
    case '{': return '}';
    case '{{': return '}}';
    case 'custom':
      throw new Error("condenseWarningCloseFor: 'custom' has no mirror — read from settings");
  }
}

/** User-supplied shrink protection rule. `pattern` is treated as a
 *  literal string by default (escaped, matched case-insensitively
 *  with `i` flag, like the built-in omission patterns) or as a raw
 *  regex source when `isRegex` is true. Invalid regex sources are
 *  silently dropped at compile time. */
export interface ShrinkProtection {
  pattern: string;
  isRegex: boolean;
}

export type HeadingMode = 'strict' | 'respect' | 'demolish';
const HEADING_MODES: HeadingMode[] = ['strict', 'respect', 'demolish'];


/** What Create Reference does with highlighted text in the copied
 *  excerpt: convert to the grey background (default), convert to a
 *  background of the same color (like the Convert Highlighting to
 *  Background command), keep the highlights as-is, or remove them. */
export type CreateReferenceHighlightMode = 'shading' | 'convert' | 'keep' | 'remove';
const CREATE_REFERENCE_HIGHLIGHT_MODES: CreateReferenceHighlightMode[] = [
  'shading',
  'convert',
  'keep',
  'remove',
];

/** Bracket pair wrapping the Create Reference heading line — the
 *  same mirror-pair choices as "Condense with warning" (minus the
 *  custom markers, which the free heading text covers instead). */
export type CreateReferenceDelimiter = Exclude<CondenseWarningDelimiter, 'custom'>;
const CREATE_REFERENCE_DELIMITERS: CreateReferenceDelimiter[] = [
  '[', '[[', '<', '<<', '{', '{{',
];

/** Which gaps the formatting-gap bridge treats as bridgeable. */
export type FormattingGapClass = 'both' | 'whitespace';
const FORMATTING_GAP_CLASSES: FormattingGapClass[] = ['both', 'whitespace'];

export type FormattingPanelMode = 'labels' | 'shortcuts' | 'both' | 'hidden';
const FORMATTING_PANEL_MODES: FormattingPanelMode[] = ['labels', 'shortcuts', 'both', 'hidden'];

export const VOICE_DASH_STYLES: ReadonlyArray<Settings['voiceDashStyle']> = [
  'em', 'em-spaced', 'en', 'en-spaced', 'hyphen', 'hyphen-spaced',
  'double', 'double-spaced', 'triple', 'triple-spaced',
];

/** Output options for the custom dash remapping. */
export const CUSTOM_DASH_STYLES: ReadonlyArray<Settings['customDashStyle']> = [
  'en', 'en-spaced', 'em', 'em-spaced',
];

const DEFAULTS: Settings = {
  navWidth: 300,
  navMaxLevel: 3,
  navFollowCursor: true,
  dragInteractions: true,
  copyPreviousCiteNearestOnly: true,
  showOnboardingStarter: true,
  hasSeenUiTour: false,
  hasSeenCutInPlaceNotice: false,
  defaultSpeechDocFolder: '',
  defaultSpeechDocFormat: 'docx',
  speechDocFilenameTemplate: DEFAULT_SPEECH_FILENAME_TEMPLATE,
  defaultSaveFormat: 'docx',
  prefixPresetSaveFilenames: true,
  sendDocPrefix: 'SEND_',
  readDocPrefix: 'READ_',
  markedDocPrefix: 'MARKED_',
  sendDocDestination: 'sameFolder',
  sendDocFolder: '',
  markedCardsDestination: 'sameFolder',
  markedCardsFolder: '',
  theme: 'system',
  themeAppliesToDocument: false,
  iconSet: 'modern',
  showDocNameChip: false,
  showUndoRedoButtons: false,
  checkForUpdatesOnLaunch: true,
  updateChecksPausedUntil: 0,
  commentsColumnWidth: 320,
  reduceMotion: 'auto',
  readerReduceMotion: false,
  colorVisionFriendly: false,
  annotationShapes: false,
  distinguishShading: false,
  navAnalyticItalics: false,
  unboldCites: false,
  disableCursorBlink: false,
  accessibilityTreeEnabled: false,
  flowHostOnLaunch: false,
  externalInsertPolicy: 'ask',
  externalAppConsents: [],
  overrideHighlightColor: false,
  overrideHighlightSlots: ['#ffff00'],
  overrideShadingColor: false,
  overrideShadingSlots: ['#d2d2d2'],
  showCursorColorNames: false,
  customColorOverrides: {},
  navPaneVisible: true,
  formatNavPaneByType: true,
  timerProfile: 'college',
  timerProfiles: {
    highSchool: { speechPresets: [3, 5, 8, 10], prepMinutes: 8 },
    college: { speechPresets: [3, 6, 9, 12], prepMinutes: 10 },
    pomodoro: { speechPresets: [25, 15, 5, 45], prepMinutes: 0 },
  },
  timerSpeechPresets: [3, 6, 9, 12],
  timerShowFourthPreset: false,
  timerPrepMinutes: 10,
  timerFlashEnabled: true,
  timerFlashSeconds: [5, 3, 1],
  timerSoundEnabled: false,
  timerSoundVolume: 70,
  timerCompact: false,
  timerPrepLabel: 'both',
  timerPosition: 'left',
  jumpToDocTopOnReadModeToggle: false,
  findResultsExpanded: false,
  findRememberLastQuery: false,
  findLastQuery: '',
  findCategoryOrder: ['heading', 'tag', 'analytic', 'undertag', 'cite', 'other'],
  includeSpeechDocPocket: true,
  showCitePreview: true,
  showCardNumbering: true,
  showNumberingButtons: true,
  cardNumberingFormat: 'period',
  cardNumberingSubFormat: 'period',
  cardNumberingSubCapitalized: false,
  cardNumberingSubBold: true,
  cardNumberingIndent: 'off',
  cardNumberingSubIndent: 'off',
  cardNumberingMatchHeadingColor: false,
  flashcardDueDot: true,
  editorSpellcheck: false,
  smartQuotes: false,
  autoCapitalizeSentences: false,
  customAutocorrectEnabled: false,
  customAutocorrects: [],
  customDashEnabled: false,
  enterAfterPocket: 'normal',
  enterAfterHat: 'normal',
  enterAfterBlock: 'normal',
  enterAfterTag: 'normal',
  enterAfterAnalytic: 'normal',
  enterAfterUndertag: 'normal',
  customDashStyle: 'em',
  customDashTrigger: '---',
  voiceInputDeviceId: '',
  voiceAutoSleepSeconds: 60,
  voiceDashStyle: 'em',
  voiceDictationModel: 'standard',
  // Default OFF — autosave is meaningful only when the user has
  // saved at least once (so we have a handle) AND the doc is in
  // .cmir format. We let the user opt in via the ribbon toggle
  // rather than silently saving in the background.
  autosaveEnabled: false,
  readMode: false,
  hideEmphasisBordersInReadMode: false,
  readModeParagraphIntegrity: false,
  markUnreadAfterMarker: false,
  defaultZoomPct: 100,
  chromeScalePct: 100,
  gestureZoom: false,
  readers: [
    { name: 'Reader 1', wpm: 200 },
    { name: 'Reader 2', wpm: 250 },
  ],
  liveSelectionWordCount: false,
  liveContainerReadTime: true,
  liveRemainingReadTime: false,
  displaySizes: { ...DEFAULT_DISPLAY_SIZES },
  displayParagraphSpacing: { ...DEFAULT_PARAGRAPH_SPACING },
  displayTypography: { ...DEFAULT_DISPLAY_TYPOGRAPHY },
  styleAlignments: { ...DEFAULT_STYLE_ALIGNMENTS },
  maxTextWidthPx: 0,
  maxTextWidthAlign: 'center',
  displayColors: { ...DEFAULT_DISPLAY_COLORS },
  bodyFont: 'Times New Roman',
  uiFont: '',
  ribbonTooltipMode: 'both',
  showDropzonePill: false,
  showQuickCardButtons: false,
  fileSearchRoots: [],
  fileSearchExclusions: [],
  fileSearchFormats: 'both',
  fileSearchObjectTypes: ['block', 'tag'],
  fileSearchOutlineDepth: 3,
  fileSearchTiebreak: 'recency',
  pinAutoEnabled: true,
  lineHeight: 1.3,
  lineHeightCite: 1.2,
  lineHeightTag: 1.2,
  lineHeightAnalytic: 1.2,
  lineHeightHeading: 1.2,
  lineHeightUndertag: 1.2,
  formattingPanelMode: 'labels',
  formattingPanelPreview: true,
  showCharacterStyles: true,
  lastHighlightColor: 'yellow',
  lastShadingColor: 'C0C0C0',
  lastFontColor: null,
  paragraphIntegrity: true,
  usePilcrows: true,
  extractUndertagInQuotes: false,
  headingMode: 'respect',
  condenseOnPaste: false,
  smartPasteConversion: true,
  pasteCursor: 'after',
  versionHistory: 'standard',
  versionHistoryDocCapMb: 200,
  versionHistoryTotalCapMb: 2048,
  formattingGapClass: 'both',
  autoBridgeFormattingGaps: true,
  clearFormattingOnNamedStyleToggleOff: true,
  standardizeHighlightException: 'yellow',
  standardizeShadingException: 'FFFF00',
  forReferenceUseGray50: false,
  createReferenceIncludeHeading: true,
  createReferenceDelimiter: '<<',
  createReferenceIncludeCite: true,
  createReferenceCustomHeading: '',
  createReferenceHeadingBold: false,
  createReferenceHeadingItalic: false,
  createReferenceHeadingEmphasized: false,
  createReferenceHeadingUnderlined: false,
  createReferenceShrinks: true,
  createReferenceShrinkPt: 3,
  createReferenceHighlightMode: 'shading',
  shrinkRestoresOmissionsToNormal: false,
  condenseWarningDelimiter: '[',
  condenseWarningCustomPauseMarker: '',
  condenseWarningCustomResumeMarker: '',
  shrinkCustomProtections: [],
  acronymPatterns: [],
  ribbonKeyOverrides: {},
  ribbonCustomButtons: [],
  keyboardMacros: [],
  commentAuthor: 'You',
  commentAuthorInitials: '',
  commentsVisible: false,
  anthropicApiKey: '',
  aiModelOverride: '',
  aiProvider: 'anthropic',
  openrouterApiKey: '',
  openrouterModel: '',
  aiMaxTokens: 4096,
  aiFeaturesEnabled: false,
  clodEnabled: false,
  clodActivitiesByTime: { morning: [], day: [], evening: [], night: [] },
  clodTimePeriods: {
    morning: { start: 5, end: 9 },
    day: { start: 9, end: 20 },
    evening: { start: 20, end: 23 },
    night: { start: 23, end: 5 },
  },
  aiPersonaName: 'Clod',
  aiPersonaPronouns: 'he',
  aiPersonaCustomPronouns: {
    subject: 'they',
    object: 'them',
    possessive: 'their',
    reflexive: 'themself',
  },
  aiCitePrompt: '',
  translationProvider: 'auto',
  translationTargetLang: 'en',
  translationSourceLang: 'auto',
  myMemoryEmail: '',
  googleTranslateApiKey: '',
  prependTranslationMarker: true,
  multiDocWorkspace: false,
  mobileLayout: 'auto',
  multiDocLayoutMode: 'compact',
  quickCardActiveTags: [],
  cardCutterEnabled: false,
  cardCutterEnginePath: '',
  cardCutterEmphasisStyle: 'voice',
  cardCutterReadTimeSec: 0,
  pluginsEnabled: false,
  pluginCommunityInstalls: false,
  pairingEnabled: false,
  pairingPollSeconds: 30,
  pairingRelayUrl: '',
  pairingRelayToken: '',
  pairingConnectedUntil: 0,
  pairingOwnCode: '',
  pairingDisplayName: '',
  collabShowCursors: true,
  pairingPartners: [],
  pairingGroups: [],
  pairingBlockedCodes: [],
  pairingStarred: null,
  pairingReceiveFlash: 'once',
  cleanProtectedStyles: [],
};

/** Public read-only view of the built-in defaults — handy for any UI
 *  that wants a "Restore defaults" button. */
export const SETTINGS_DEFAULTS: Readonly<Settings> = DEFAULTS;

/** Whether the persisted store differs from the defaults in ANY key
 *  (minus `ignore`d ones). The UI tour's upgrade heuristic: a machine
 *  with customized settings belongs to an established user, so the
 *  tour initializes as already-seen there. Diff-based rather than
 *  presence-based — boot code persisting an all-defaults store must
 *  not disqualify a genuinely fresh profile. */
export function hasCustomizedSettings(
  ignore: readonly (keyof Settings)[] = ['hasSeenUiTour', 'hasSeenCutInPlaceNotice'],
): boolean {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Record<
      string,
      unknown
    > | null;
    if (!raw || typeof raw !== 'object') return false;
    // Compare against SANITIZED defaults — persistence runs values
    // through sanitize() (which e.g. lowercases hex colors), so raw
    // DEFAULTS would false-diff on every profile ever written.
    const defaults = sanitize({ ...DEFAULTS }) as unknown as Record<string, unknown>;
    return Object.keys(raw).some((k) => {
      if ((ignore as readonly string[]).includes(k)) return false;
      if (!(k in defaults)) return false; // stale/unknown keys aren't user intent
      return JSON.stringify(raw[k]) !== JSON.stringify(defaults[k]);
    });
  } catch {
    return false;
  }
}

/**
 * Tabs in the settings dialog. Each setting carries a `category`
 * and is rendered under the matching tab. Order here is the tab
 * order in the dialog.
 */
export type SettingsCategory =
  | 'general'
  | 'files'
  | 'appearance'
  | 'accessibility'
  | 'editing'
  | 'shortcuts'
  | 'comments-ai'
  | 'pairing'
  | 'plugins';

export type SettingCondition =
  | keyof Settings
  | { key: keyof Settings; equals: unknown };

/** Evaluate a row's `dependsOn` against current settings. Bare key →
 *  truthy check; object → equality; array → conjunction. Undefined → true. */
export function evalDependsOn(
  dependsOn: SettingCondition | readonly SettingCondition[] | undefined,
  get: (key: keyof Settings) => unknown = (k) => settings.get(k),
): boolean {
  if (dependsOn === undefined) return true;
  const conds = Array.isArray(dependsOn) ? dependsOn : [dependsOn as SettingCondition];
  return conds.every((c) =>
    typeof c === 'object' ? get(c.key) === c.equals : Boolean(get(c)),
  );
}

/**
 * Human-readable metadata for each setting, used by the settings UI.
 * Add new entries when introducing new settings.
 */
export interface SettingMeta {
  key: keyof Settings;
  label: string;
  description?: string;
  /** Optional section header within the tab. The settings dialog emits
   *  a header row whenever this changes between consecutive entries of
   *  a category — so entries sharing a section must be contiguous in
   *  SETTING_METADATA. Purely presentational. */
  section?: string;
  /** Optional dynamic description that takes precedence over
   *  `description` at render time. Used by entries whose copy needs
   *  to vary by host capability (e.g. the workspace-layout entry,
   *  which describes window-spawning differently on Electron vs
   *  web). */
  descriptionFn?: () => string;
  /** Settings UI hint: how should this be rendered? */
  kind:
    | 'toggle'
    | 'number'
    | 'defaultZoomPct'
    | 'customDash'
    | 'customAutocorrect'
    | 'accessibilityRenderer'
    | 'level'
    | 'readers'
    | 'displaySizes'
    | 'paragraphSpacing'
    | 'displayTypography'
    | 'displayColors'
    | 'bodyFont'
    | 'uiFont'
    | 'ribbonTooltipMode'
    | 'externalInsertPolicy'
    | 'cardNumberFormat'
    | 'cardNumberSubFormat'
    | 'cardNumberIndent'
    | 'cardNumberSubIndent'
    | 'cardNumberColor'
    | 'lineHeights'
    | 'formattingPanelMode'
    | 'headingMode'
    | 'condenseWarningDelimiter'
    | 'shrinkCustomProtections'
    | 'standardizeHighlightException'
    | 'standardizeShadingException'
    | 'acronymPatterns'
    | 'createReferenceHighlightMode'
    | 'createReferenceDelimiter'
    | 'keybindings'
    | 'ribbonCustomButtons'
    | 'text'
    | 'folder'
    | 'folderList'
    | 'pathList'
    | 'fileSearchFormats'
    | 'fileSearchObjectTypes'
    | 'fileSearchOutlineDepth'
    | 'navDefaultDepth'
    | 'styleAlignments'
    | 'maxTextWidth'
    | 'fileSearchTiebreak'
    | 'speechDocFormat'
    | 'speechFilenameTemplate'
    | 'saveFormat'
    | 'formattingGapClass'
    | 'pasteCursor'
    | 'versionHistory'
    | 'sendDocDestination'
    | 'markedCardsDestination'
    | 'findCategoryOrder'
    | 'color'
    | 'colorSlots'
    | 'colorOverrides'
    | 'theme'
    | 'iconSet'
    | 'reduceMotion'
    | 'timerProfile'
    | 'timerProfileDurations'
    | 'timerFlashSeconds'
    | 'timerPrepLabel'
    | 'timerPosition'
    | 'enterAfterStyle'
    | 'password'
    | 'voiceInputDevice'
    | 'voiceDashStyle'
    | 'voiceDictationModel'
    | 'clod'
    | 'clodCustomize'
    | 'aiCitePrompt'
    | 'aiProvider'
    | 'translationConfig'
    | 'multiDocLayoutMode'
    | 'mobileLayout'
    | 'cardCutterReadTime'
    | 'cardCutterEnginePath'
    | 'cardCutterDisable'
    | 'pairingOwnCode'
    | 'pairingAccount'
    | 'pairingPartners'
    | 'pairingGroups'
    | 'pairingBlocked'
    | 'pairingReceiveFlash';
  /** Which tab this setting lives under in the settings dialog. */
  category: SettingsCategory;
  /** When set, this row is greyed out and its controls disabled unless
   *  its condition holds. A bare key means "that boolean setting is
   *  truthy"; an object means "that setting equals a value"; an array
   *  means "all of these hold". */
  dependsOn?: SettingCondition | readonly SettingCondition[];
  /** When true, this setting is only relevant on Electron-style
   *  hosts (real file paths, native dialogs). The settings UI
   *  hides the row entirely on the web edition. */
  electronOnly?: boolean;
  /** When true, this setting is only relevant on the Windows desktop
   *  (the Verbatim Flow COM bridge). Hidden everywhere else. */
  windowsOnly?: boolean;
  /** When true, this setting is only relevant on the web edition
   *  (browser host). The settings UI hides the row on Electron. */
  webOnly?: boolean;
  /** When true, the row also appears in the MOBILE settings page.
   *  Explicit opt-in (default false) so editing- and desktop-shaped
   *  settings can never leak onto phones by omission. The desktop
   *  dialog ignores this flag. */
  mobile?: boolean;
  /** When true, the command palette's settings search never lists
   *  this row — for niche bootstrapping settings (e.g. the mobile
   *  layout choice) that would be noise next to real commands. The
   *  settings dialog still shows it. */
  searchHidden?: boolean;
  /** When set, the row only renders while this boolean setting is on.
   *  Used to hide the console-gated card-cutter rows until enabled. */
  revealWhen?: keyof Settings;
  /** Floor for `kind: 'number'` editors — the input's `min` and the
   *  clamp applied on change. Defaults to 0 when unset. */
  min?: number;
  /** Extra search terms for the command palette. The label often
   *  uses one name for a thing the user might search by another
   *  ("Theme" vs "dark mode", "Line spacing" vs "line height"); these
   *  let those queries surface the row. Match-only — never displayed.
   *  Keep them lowercase. */
  aliases?: readonly string[];
}

export const SETTING_METADATA: SettingMeta[] = [
  {
    key: 'multiDocWorkspace',
    label: 'Three-pane workspace',
    descriptionFn: workspaceLayoutDescription,
    kind: 'toggle',
    category: 'general',
    section: 'Workspace',
    aliases: ['split view', 'split screen', 'multi pane', 'multi-doc'],
  },
  {
    key: 'multiDocLayoutMode',
    label: 'Multi-doc layout',
    description:
      'When three docs are open, choose compact (all three visible at once, narrow) or wide-scroll (two full panes + edge of third; click the peek to snap). With 1 or 2 docs open, both modes render identically.',
    kind: 'multiDocLayoutMode',
    category: 'general',
    section: 'Workspace',
    dependsOn: 'multiDocWorkspace',
  },
  {
    key: 'navMaxLevel',
    label: 'Default navigation depth',
    description:
      'How deep the navigation pane opens for a newly opened document: Pocket shows only top-level headings; Tag expands everything. The 1–4 buttons in the pane itself change the current document only — this sets what the next document starts at.',
    kind: 'navDefaultDepth',
    category: 'general',
    section: 'Workspace',
    aliases: ['nav depth', 'outline depth', 'navigation level', 'nav pane depth'],
  },
  {
    key: 'dragInteractions',
    label: 'Drag to rearrange',
    description:
      'Move cards and sections by dragging — rows in the navigation pane, and the pickup-modifier drag in the editor. Turn this off on touch devices where scrolling with a finger keeps picking things up instead; clicking still navigates, and moving content still works via cut/paste and Send.',
    kind: 'toggle',
    category: 'general',
    section: 'Workspace',
    aliases: ['drag and drop', 'click drag', 'touch drag', 'reorder', 'drag to move'],
  },
  {
    key: 'navFollowCursor',
    label: 'Navigation pane follows the cursor',
    description:
      'The navigation pane scrolls to keep your place in sight: moving the cursor into a different section brings that heading into view',
    kind: 'toggle',
    category: 'general',
    section: 'Workspace',
    aliases: [
      'nav scroll',
      'outline scroll position',
      'keep place',
      'nav pane place',
      'follow cursor',
      'sync outline',
      'outline follows',
    ],
  },
  {
    key: 'mobileLayout',
    label: 'Layout on this device',
    description:
      'Which layout the web edition uses here. Auto picks the view-first mobile layout on windows narrower than 768px, and up to 1024px on touch screens; Mobile / Desktop force one. Changing this reloads the page.',
    kind: 'mobileLayout',
    category: 'general',
    section: 'Workspace',
    webOnly: true,
    mobile: true,
    searchHidden: true,
  },
  {
    key: 'editorSpellcheck',
    label: 'Editor spellcheck',
    description:
      "Underline misspellings in the visible part of the document — including text in files you've opened, not just words you're typing. Right-click a flagged word for suggestions, Add to Dictionary, or Ignore. Off by default: debate evidence (author names, jargon, citations) generates a lot of false-positive squiggles.",
    kind: 'toggle',
    category: 'general',
    section: 'Editor behavior',
  },
  {
    key: 'gestureZoom',
    label: 'Pinch / Ctrl+Scroll to zoom',
    description:
      'Zoom the document with a trackpad pinch or Ctrl + mouse-wheel (in 10% steps, same as the zoom buttons and Ctrl-= / Ctrl-- chords). Off by default; enable for pinch / Ctrl-scroll zooming.',
    kind: 'toggle',
    category: 'general',
    section: 'Editor behavior',
    aliases: ['gesture zoom', 'pinch zoom', 'ctrl scroll', 'wheel zoom', 'trackpad zoom'],
  },
  {
    key: 'jumpToDocTopOnReadModeToggle',
    label: 'Jump to doc top when read mode toggles',
    description:
      'When on, toggling read mode (in either direction) scrolls to the top of the doc and places the cursor at the start. Off by default — the viewport stays where it was.',
    kind: 'toggle',
    category: 'general',
    section: 'Editor behavior',
  },
  {
    key: 'readModeParagraphIntegrity',
    label: 'Read mode: preserve paragraph integrity',
    description:
      'When on, read mode keeps each body paragraph on its own line instead of flowing a card\'s paragraphs together into one block of text. Body paragraphs with nothing read-aloud in them still collapse away entirely, so no blank lines appear. Off by default — display-only, exactly like the rest of read mode (the document is untouched).',
    kind: 'toggle',
    category: 'general',
    section: 'Editor behavior',
    aliases: ['paragraph breaks', 'paragraph integrity', 'separate lines', 'read mode paragraphs'],
  },
  // ─── General ────────────────────────────────────────────────────
  {
    key: 'readers',
    label: 'Readers for read-time estimates',
    description:
      'Each reader has a name and a words-per-minute rate, plus an optional second rate '
      + 'for tags, analytics, and cites — most people read those faster than highlighted '
      + 'card bodies. Leave the second rate blank and the main rate covers everything. '
      + 'The first two readers are displayed live in the bottom bar; all show up in the '
      + 'Word Count Selection dialog.',
    kind: 'readers',
    category: 'general',
    section: 'Word counts',
    mobile: true,
  },
  {
    key: 'liveSelectionWordCount',
    label: 'Live word count for the current selection',
    description:
      "Off by default. When on, the bottom bar's word count / read time updates the moment you change the selection, showing the selection's read time. Off keeps the bar on the whole-doc count — use the Word Count button (Σ) for a selection's read time on demand. Live updates re-count on every selection change, so leave this off on very large documents if you notice drag lag.",
    kind: 'toggle',
    category: 'general',
    section: 'Word counts',
  },
  {
    key: 'liveContainerReadTime',
    label: 'Live read time for the enclosing card / block',
    description:
      "On by default. Appends a second segment to the bottom bar's word count: with the cursor parked, the read time of the smallest enclosing card, analytic unit, or block section; with a selection, the selection's read time instead. Off shows the read-time estimate exactly as before. Cheap — the count is cached per container, so plain cursor moves don't re-count anything.",
    kind: 'toggle',
    category: 'general',
    section: 'Word counts',
    aliases: ['container read time', 'card read time', 'block read time', 'enclosing read time'],
  },
  {
    key: 'liveRemainingReadTime',
    label: 'Live read time for what is left to read',
    description:
      "Off by default. Appends one more segment to the bottom bar's word count: everything still ahead of your cursor — the read-aloud words from the cursor to the end of the document, with each reader's time for them.",
    kind: 'toggle',
    category: 'general',
    section: 'Word counts',
    aliases: ['time left', 'remaining read time', 'words left', 'unread words'],
  },
  {
    key: 'findRememberLastQuery',
    label: 'Find: remember the last search query',
    description:
      "When on, reopening the find bar (Ctrl-F / Ctrl-H / Alt-F) pre-fills the input with whatever you last searched for. Off by default — the bar opens empty so each search is a clean slate.",
    kind: 'toggle',
    category: 'general',
    section: 'Find',
  },
  {
    key: 'findCategoryOrder',
    label: 'Find: category priority order',
    description:
      'Ctrl-F groups search results by which kind of paragraph they appear in, and Next steps through groups in this order. Within each group, the first match is whichever is closest to your cursor (the cursor counts as the top — matches AFTER it come first, then matches before, like wrap-around). Reorder via the up / down buttons. Alt-F ignores this and goes purely by proximity.',
    kind: 'findCategoryOrder',
    category: 'general',
    section: 'Find',
  },
  {
    key: 'timerProfile',
    label: 'Timer profile',
    description:
      "Picks which set of durations the timer is currently running on. Each profile remembers its own customizations, so changing values below saves to the active profile (no separate 'custom' option). Defaults: High school = 3/5/8 + 8 min prep, College = 3/6/9 + 10 min prep, Pomodoro = 25/15/5 + 0 prep.",
    kind: 'timerProfile',
    category: 'general',
    section: 'Timer',
    aliases: ['timer preset', 'timer presets'],
  },
  {
    key: 'timerProfiles',
    label: 'Timer durations',
    description:
      "Edit the active profile's preset durations (in minutes — these become the preset buttons on the panel; a fourth field appears when the fourth preset is enabled below) and the per-side prep total. Changes save into the currently-selected profile only.",
    kind: 'timerProfileDurations',
    category: 'general',
    section: 'Timer',
  },
  {
    key: 'timerShowFourthPreset',
    label: 'Show a fourth speech preset',
    description:
      'Adds a fourth preset button for events whose speeches come in four distinct lengths (and a fourth duration field above).',
    kind: 'toggle',
    category: 'general',
    section: 'Timer',
    aliases: ['fourth preset', 'four presets', 'preset 4'],
  },
  {
    key: 'showOnboardingStarter',
    label: 'Onboarding doc for new documents',
    description:
      'When on (default), New Document opens the CardMirror welcome doc — the same starter you get the first time you launch. When off, New opens a blank doc with a single empty paragraph. Affects every freshly created doc, including newly spawned windows.',
    kind: 'toggle',
    category: 'files',
    section: 'New documents',
  },
  {
    key: 'defaultSpeechDocFolder',
    label: 'Default folder for new speech documents',
    description:
      'When set, "New Speech Document" saves the new doc into this folder by default. Leave empty (the default) to keep the current behavior of leaving the doc unsaved until you explicitly Save / Save As.',
    kind: 'folder',
    category: 'files',
    section: 'New documents',
    electronOnly: true,
  },
  {
    key: 'defaultSpeechDocFormat',
    label: 'Default format for new speech documents',
    description:
      'Docx is the Verbatim-compatible default — best when you\'re sharing speech docs with teammates who use Verbatim. Picking .cmir enables autosave on the new doc (autosave only fires for .cmir files; the Docx serializer is too expensive to run on a debounce).',
    kind: 'speechDocFormat',
    category: 'files',
    section: 'New documents',
  },
  {
    key: 'speechDocFilenameTemplate',
    label: 'Speech document filename',
    description:
      // Rendered with white-space: pre-line, so a \n is a line break
      // but leading indentation collapses. Keep every line flush left.
      'The name New Speech Document gives a new file.\n' +
      '{speech} is the name you type at the prompt.\n' +
      '{date:...} is a date. Double a token to zero-pad it:\n' +
      'year - YYYY 2026, YY 26\n' +
      'month - M 4, MM 04, MMM Apr, MMMM April\n' +
      'day - D 12, DD 12, ddd Sun, dddd Sunday\n' +
      'hour - h 7, hh 07 (12-hour), H 19, HH 19 (24-hour)\n' +
      'minute - m 5, mm 05. second - s 7, ss 07. A PM, a pm\n' +
      '\n' +
      'Anything that is not a token stays as you typed it, so dashes, ' +
      'slashes and spaces need no escaping. Inside {date:...} the letters ' +
      'are tokens, so wrap a literal word in brackets: {date:h-mmA [on] MMM D}.\n',
    kind: 'speechFilenameTemplate',
    category: 'files',
    section: 'New documents',
  },
  {
    key: 'defaultSaveFormat',
    label: 'Default file format for new documents',
    description:
      'Sets the format the Save-As dialog defaults to for a doc you haven\'t saved before. .docx is the default — Word- and Verbatim-compatible. Pick .cmir to make every new doc save in CardMirror\'s native format (lossless, and the only format that supports autosave). Doesn\'t affect existing files on disk — those always re-save in whatever format they were opened from.',
    kind: 'saveFormat',
    category: 'files',
    section: 'New documents',
    mobile: true,
  },
  {
    key: 'includeSpeechDocPocket',
    label: 'Seed new speech docs with a Pocket heading',
    description:
      'When on (default), New Speech Document opens with a Pocket carrying the speech\'s name (e.g. "Speech 1NC 5-15 9-30AM") at the top. Turn off to start with a fully blank doc — one empty paragraph.',
    kind: 'toggle',
    category: 'files',
    section: 'New documents',
  },
  {
    key: 'prefixPresetSaveFilenames',
    label: 'Prefix preset saves',
    description:
      'When on (default), the Save As dialog\'s Send Doc / Read Doc / Marked Doc presets (and their commands) prepend the prefixes below to the file name (e.g. SEND_1AC.docx). The As-Is preset and the Save Custom button are never prefixed. Turn off to save presets under the exact name shown in the box.',
    kind: 'toggle',
    category: 'files',
    section: 'Send / Read / Marked docs',
  },
  {
    key: 'sendDocPrefix',
    label: 'Send Doc filename prefix',
    description: 'Prepended to Send Doc saves when the option above is on. Default SEND_. Leave empty for no prefix.',
    kind: 'text',
    category: 'files',
    section: 'Send / Read / Marked docs',
    dependsOn: 'prefixPresetSaveFilenames',
  },
  {
    key: 'readDocPrefix',
    label: 'Read Doc filename prefix',
    description: 'Prepended to Read Doc saves when the option above is on. Default READ_. Leave empty for no prefix.',
    kind: 'text',
    category: 'files',
    section: 'Send / Read / Marked docs',
    dependsOn: 'prefixPresetSaveFilenames',
  },
  {
    key: 'markedDocPrefix',
    label: 'Marked Doc filename prefix',
    description: 'Prepended to Marked Doc saves when the option above is on. Default MARKED_. Leave empty for no prefix.',
    kind: 'text',
    category: 'files',
    section: 'Send / Read / Marked docs',
    dependsOn: 'prefixPresetSaveFilenames',
  },
  {
    key: 'sendDocDestination',
    label: 'Send Doc destination',
    description:
      'Where the Save Send Doc command (and its shortcut) writes — a send doc is the document with comments, analytics, and undertags stripped, the same content the Save As dialog\'s Send Doc preset produces. "Same folder as the document" drops it beside the source file; "Fixed folder" always writes into the folder below. Either way, a doc you haven\'t saved yet (same-folder mode) or an unset fixed folder falls back to the normal Save As dialog. The send doc is written in your default new-document format, and prefixed SEND_ when that option is on.',
    kind: 'sendDocDestination',
    category: 'files',
    section: 'Send / Read / Marked docs',
    electronOnly: true,
  },
  {
    key: 'sendDocFolder',
    label: 'Send Doc folder',
    description:
      'Destination folder for Save Send Doc when the destination above is set to "Fixed folder". Leave empty to fall back to the Save As dialog.',
    kind: 'folder',
    category: 'files',
    section: 'Send / Read / Marked docs',
    electronOnly: true,
  },
  {
    key: 'markedCardsDestination',
    label: 'Marked Cards destination',
    description:
      'Where the Save Marked Cards command (and its shortcut) writes — a marked-cards doc is just the cards that contain a reading marker, flattened (no headings, no analytics), the same content the Save As dialog\'s Marked Cards preset produces. "Same folder as the document" drops it beside the source file; "Fixed folder" always writes into the folder below. Either way, a doc you haven\'t saved yet (same-folder mode) or an unset fixed folder falls back to the normal Save As dialog. Written in your default new-document format, and prefixed MARKED_ when that option is on.',
    kind: 'markedCardsDestination',
    category: 'files',
    section: 'Send / Read / Marked docs',
    electronOnly: true,
  },
  {
    key: 'markedCardsFolder',
    label: 'Marked Cards folder',
    description:
      'Destination folder for Save Marked Cards when the destination above is set to "Fixed folder". Leave empty to fall back to the Save As dialog.',
    kind: 'folder',
    category: 'files',
    section: 'Send / Read / Marked docs',
    electronOnly: true,
  },
  {
    key: 'fileSearchRoots',
    label: 'File search folders',
    description:
      'Folders for the command-palette file search (type "f " in the search bar). Each is scanned recursively for .cmir and .docx files. Add as many as you like — overlapping folders are fine; a file found under more than one is searched only once. Leave the list empty to disable file search.',
    kind: 'folderList',
    category: 'files',
    section: 'File search',
    electronOnly: true,
  },
  {
    key: 'fileSearchExclusions',
    label: 'File search: exclusions',
    description:
      'Folders and files the file search never shows, even inside a search folder above. '
      + 'An excluded folder hides everything under it. Add entries here, or use the '
      + 'exclude button (⊘) on a file result in the search bar.',
    kind: 'pathList',
    category: 'files',
    section: 'File search',
    electronOnly: true,
  },
  {
    key: 'fileSearchFormats',
    label: 'File search: file formats to list',
    description:
      'Which document formats appear in the file search results — both .cmir and .docx, or just one. Each result shows its format on its badge.',
    kind: 'fileSearchFormats',
    category: 'files',
    section: 'File search',
    electronOnly: true,
  },
  {
    key: 'fileSearchObjectTypes',
    label: 'File search: objects to find within a file',
    description:
      'After picking a file in the search palette (Tab), which structural objects show up as you search inside it. Inserting one drops the matching card (tag/cite), block section (block/hat/pocket), or analytic unit into your document. Tags are always findable by their citation, so Cite (standalone cite rows) is off by default — turn it on to also list cites on their own.',
    kind: 'fileSearchObjectTypes',
    category: 'files',
    section: 'File search',
    electronOnly: true,
  },
  {
    key: 'fileSearchOutlineDepth',
    label: 'File search: default outline depth',
    description:
      "How far the outline is expanded when you first dive into a file (before typing). Pocket shows only top-level headings; Tag expands everything. Default Block. Right-click any pocket / hat / block in the outline to expand or collapse it.",
    kind: 'fileSearchOutlineDepth',
    category: 'files',
    section: 'File search',
    electronOnly: true,
  },
  {
    key: 'fileSearchTiebreak',
    label: 'File search: tie-break order',
    description:
      'How equally-relevant file results are ordered. Results are ranked by match quality first (exact name, then prefix, then word-start, then anywhere in the name or folder); this decides ties within a tier — and the order of the browse list before you type. Recency (default) puts the most recently edited file first; Alphabetical sorts by name.',
    kind: 'fileSearchTiebreak',
    category: 'files',
    section: 'File search',
    electronOnly: true,
    aliases: ['file search sort', 'file sort order', 'recency', 'alphabetical', 'sort files'],
  },
  {
    key: 'pinAutoEnabled',
    label: 'File search: auto-pin recent & frequent files',
    description:
      "On by default. Keeps your recent and frequently-used .cmir files 'warm' (parsed and held in memory) so diving into them from the search palette is instant. Turn off if you're sensitive to memory use — then only files you pin by hand (★ / Alt+P) are kept warm.",
    kind: 'toggle',
    category: 'files',
    section: 'File search',
    electronOnly: true,
  },
  {
    key: 'defaultZoomPct',
    label: 'Default document zoom',
    description:
      'The body-text zoom level every document opens at (50–300%). Zooming an open document (the zoom buttons, Ctrl-= / Ctrl--, or pinch) only affects that window or pane and resets to this default on reload — so different documents can sit at different zooms. Chrome scale is separate and stays linked across windows.',
    kind: 'defaultZoomPct',
    category: 'accessibility',
    aliases: ['zoom', 'default zoom', 'text size', 'document zoom'],
  },
  {
    key: 'styleAlignments',
    label: 'Text alignment',
    description:
      'Center or fully justify text per structural style — tags, plain paragraphs, card bodies, analytic bodies, analytics, undertags, and cite paragraphs. Default keeps the normal left-aligned rendering. Headings above tags (pockets, hats, blocks) are not affected, and a paragraph you have aligned yourself keeps its own alignment.',
    kind: 'styleAlignments',
    category: 'accessibility',
    section: 'Text alignment',
    aliases: ['justify', 'justified text', 'center text', 'alignment', 'flush margins'],
  },
  {
    key: 'maxTextWidthPx',
    label: 'Maximum text width',
    description:
      "Cap how wide the document text column can get — long lines stop stretching across the whole screen, so reading doesn't require sweeping your eyes edge to edge. Off by default; when on, the width is in pixels (400–3000) and the column can sit centered or pinned to the left or right edge.",
    kind: 'maxTextWidth',
    category: 'accessibility',
    section: 'Text width',
    aliases: ['line length', 'column width', 'narrow text', 'reading width'],
  },
  {
    key: 'colorVisionFriendly',
    label: 'Color-vision friendly palette',
    description:
      "Remaps the colors that carry meaning — annotation accents, voice-mode dots, prep-timer Aff/Neg, search-match highlights, category chips — onto a palette engineered to stay distinguishable under red-green and blue-yellow color-vision deficiencies (Okabe-Ito). Works with both light and dark themes. Any colors you set under Color overrides below still win. Note: this preset changes CardMirror's interface colors only — it does not recolor highlights or background colors stored in documents. For those, use 'Override highlight/background color in display' and 'Show highlight & background color names in the status bar' below.",
    kind: 'toggle',
    category: 'accessibility',
    aliases: ['colorblind', 'color blind', 'cvd', 'deuteranopia', 'protanopia', 'tritanopia'],
  },
  {
    key: 'annotationShapes',
    label: 'Distinguish annotations by underline shape',
    description:
      'Add a shape-coded underline to in-document annotations so you can tell them apart without relying on their tint colors: comments dotted, flashcards solid, AI threads dashed, private notes double. Off shows just the tinted backgrounds. Works independently of the palette above.',
    kind: 'toggle',
    category: 'accessibility',
    aliases: ['underline shapes', 'annotation shapes', 'dashed', 'colorblind', 'cvd'],
  },
  {
    key: 'navAnalyticItalics',
    label: 'Italicize analytic entries in the nav pane',
    description:
      "Show the navigation pane's Analytic entries in italics so they stand out from tags and other entries by shape, not color alone. Also useful in dark mode and with 'Format nav pane entries by type' off, where the analytic color cue doesn't appear at all.",
    kind: 'toggle',
    category: 'accessibility',
    aliases: ['analytic italics', 'nav pane', 'navigation', 'colorblind', 'cvd'],
  },
  {
    key: 'unboldCites',
    label: 'Remove bold from cites',
    description:
      "Render cite-marked text at normal weight instead of bold. Dense bold runs are a visual-crowding trigger for some readers; this keeps cites readable without changing the document — exports and other machines still see the standard bold cite.",
    kind: 'toggle',
    category: 'accessibility',
    aliases: ['cite bold', 'unbold', 'font weight', 'visual crowding'],
  },
  {
    key: 'reduceMotion',
    label: 'Reduce motion',
    description:
      "Disable UI animations and transitions (drag-pickup vacuum, popover slides, etc.). 'System' follows your OS preference; 'On' always reduces motion; 'Off' overrides the OS and plays full motion.",
    kind: 'reduceMotion',
    category: 'accessibility',
    mobile: true,
    aliases: ['animations', 'disable animations'],
  },
  {
    key: 'readerReduceMotion',
    label: 'Reduce animations in reading view',
    description:
      'Page flips in the reading view snap instantly instead of sliding. Use this if the flip animation ever stutters while you are reading a speech; the global Reduce motion setting also disables it.',
    kind: 'toggle',
    category: 'accessibility',
    aliases: ['reading view animation', 'page flip animation', 'reader animations'],
  },
  {
    key: 'disableCursorBlink',
    label: 'Steady text cursor (no blinking)',
    description:
      'Stop the text cursor from blinking — the caret stays solid (in the usual cursor color) instead of flashing on and off while you type.',
    kind: 'toggle',
    category: 'accessibility',
    aliases: ['caret', 'cursor blink', 'blinking cursor', 'non-blinking'],
  },
  {
    key: 'accessibilityTreeEnabled',
    label: 'Screen reader support',
    description:
      'Let screen readers and other assistive technology read CardMirror. OFF by default: a current Chromium bug crashes the whole window (white screen, lost work) while building the accessibility tree, so we disable it to keep CardMirror stable. Turn this on only if you rely on a screen reader — it re-activates the known crash. Takes effect after restarting CardMirror.',
    kind: 'accessibilityRenderer',
    category: 'accessibility',
    electronOnly: true,
    aliases: ['screen reader', 'accessibility', 'a11y', 'narrator', 'nvda', 'jaws', 'voice access'],
  },
  {
    key: 'overrideHighlightColor',
    label: 'Override highlight color in display',
    description:
      "When on, highlights in the doc render in the override colors below regardless of what's stored on the mark. Display-only — the doc itself is untouched.",
    kind: 'toggle',
    category: 'accessibility',
  },
  {
    key: 'overrideHighlightSlots',
    label: 'Highlight override colors',
    description:
      "Up to 3 ordered colors. With one slot, every highlight renders in that color. With two or three, the most-common highlight color in the doc gets slot 1, the second-most-common gets slot 2, and everything else gets the last slot. The ranking re-computes automatically as the doc changes.",
    kind: 'colorSlots',
    category: 'accessibility',
    dependsOn: 'overrideHighlightColor',
  },
  {
    key: 'overrideShadingColor',
    label: 'Override background color in display',
    description:
      'Same idea, applied to background color. Display-only — the doc itself is untouched.',
    kind: 'toggle',
    category: 'accessibility',
    aliases: ['shading', 'override shading color'],
  },
  {
    key: 'overrideShadingSlots',
    label: 'Background override colors',
    kind: 'colorSlots',
    category: 'accessibility',
    dependsOn: 'overrideShadingColor',
    aliases: ['shading override colors'],
  },
  {
    key: 'showCursorColorNames',
    label: 'Show highlight & background color names in the status bar',
    description:
      'Displays the actual stored highlight and background color names for the text at your cursor (e.g. "Hl: Yellow · Sh: none"), whether or not the display overrides above are on. Highlight hues often carry meaning in shared files — this gives you that meaning as text, useful when colors are hard to tell apart.',
    kind: 'toggle',
    category: 'accessibility',
    aliases: ['shading names', 'color names'],
  },
  {
    key: 'customColorOverrides',
    label: 'Color overrides',
    description:
      "Override any color in the interface. Explicit overrides here always win over the defaults and over future accessibility presets (high-contrast, dark mode, colorblind-friendly, etc.) — pick a color to override it; reset a row to fall back to whichever preset is active.",
    kind: 'colorOverrides',
    category: 'accessibility',
  },
  {
    key: 'uiFont',
    label: 'Interface font',
    description:
      'Font family for the user interface — ribbon, dialogs, navigation pane, comments column, etc. Distinct from the body font (the editor content font). "System default" uses the platform\'s native UI font stack.',
    kind: 'uiFont',
    category: 'accessibility',
    aliases: ['ui font', 'app font'],
  },
  {
    key: 'voiceInputDeviceId',
    label: 'Voice control microphone',
    description:
      'Which microphone the voice session (Ctrl-Shift-V) listens to. "System default" follows the OS setting. Device names appear after the first voice session grants microphone access. Desktop only.',
    kind: 'voiceInputDevice',
    category: 'accessibility',
  },
  {
    key: 'voiceAutoSleepSeconds',
    label: 'Voice auto-sleep (seconds)',
    description:
      'How long the voice session can sit idle before it parks itself asleep, so a forgotten mic doesn\'t eat a conversation. The status pill dims during the last ten seconds. Say "voice wake" to resume. 0 disables auto-sleep.',
    kind: 'number',
    category: 'accessibility',
  },
  {
    key: 'voiceDashStyle',
    label: 'Spoken "dash" inserts',
    description:
      'The glyph dictated by the bare word "dash". Explicit names always work regardless of this setting: "hyphen", "n dash", "m dash", "double dash", "triple dash", each optionally followed by "spaced".',
    kind: 'voiceDashStyle',
    category: 'accessibility',
  },
  {
    key: 'voiceDictationModel',
    label: 'Dictation model',
    description:
      'The standard model — a one-time ~130 MB download — handles all commands and dictation, and is what voice needs to run at all. The large model — a one-time 1.8 GB download, ~5 GB of memory while voice is on — roughly halves dictation word errors on general English, and changes dictation only (not commands, targeting, paint, or debate jargon). Download either below, or let the first voice start fetch the standard model. Takes effect the next time voice starts.',
    kind: 'voiceDictationModel',
    category: 'accessibility',
  },

  // ─── Appearance ─────────────────────────────────────────────────
  {
    key: 'theme',
    label: 'Theme',
    description:
      "Light, dark, or follow the operating system's preference. System mode tracks OS-level changes live.",
    kind: 'theme',
    category: 'appearance',
    section: 'Theme & chrome',
    mobile: true,
    aliases: ['light mode', 'dark mode', 'toggle theme', 'system theme', 'color scheme'],
  },
  {
    key: 'themeAppliesToDocument',
    label: 'Apply theme to the document area',
    description:
      "Off by default: when the theme is dark (or system-resolved dark), only the chrome — ribbon, nav, status bar — goes dark. The document area stays light, so cards still read like paper. Turn on to make the document itself follow the theme.",
    kind: 'toggle',
    category: 'appearance',
    section: 'Theme & chrome',
    aliases: ['dark document', 'dark paper', 'dark mode document'],
  },
  {
    key: 'iconSet',
    label: 'Icon style',
    description:
      "Modern (default) draws the toolbar, banner, and dialog icons from the Untitled UI line-icon set, tinted to match the theme. Classic reverts to the original emoji / text glyphs. Affects the app chrome only — the document is untouched.",
    kind: 'iconSet',
    category: 'appearance',
    section: 'Theme & chrome',
  },
  {
    key: 'showDocNameChip',
    label: 'Show doc name in ribbon',
    description:
      "Off by default. When on, the active document's filename appears as a pill in the center of the ribbon — useful when the OS title bar is hidden, unstyled, or non-existent (tiling window managers, frameless windows, web embeds). Hidden in multi-pane mode because each per-pane chip already shows its slot's filename.",
    kind: 'toggle',
    category: 'appearance',
    section: 'Theme & chrome',
  },
  {
    key: 'showUndoRedoButtons',
    label: 'Show undo / redo buttons',
    description:
      'Off by default. When on, a stacked Undo / Redo button pair appears at the far left of the ribbon, before the file buttons (after the timer panel when that is shown on the left). Undo and redo always work by keyboard either way.',
    kind: 'toggle',
    category: 'appearance',
    section: 'Theme & chrome',
    aliases: ['undo button', 'redo button', 'undo redo'],
  },
  {
    key: 'ribbonTooltipMode',
    label: 'Ribbon tooltips',
    description:
      'What hovering a ribbon button reveals. "Both" shows the action label and its current keyboard shortcut. "Label only" hides the shortcut. "Shortcut only" hides the label and is recommended for users who already know what each button does but still want a key reminder. "None" disables ribbon tooltips entirely. Dropdown menu items (Doc / Card / Table menus, etc.) always show shortcut-only — the menu label already says what the action does.',
    kind: 'ribbonTooltipMode',
    category: 'appearance',
    section: 'Theme & chrome',
  },
  {
    key: 'ribbonCustomButtons',
    label: 'Custom ribbon buttons',
    description:
      'Up to 10 buttons to the right of the comments buttons, each running a command of your choice with an icon you pick. Add as many as you like — with none configured the section is hidden. They are the third thing to disappear when the ribbon runs out of room.',
    kind: 'ribbonCustomButtons',
    category: 'appearance',
    section: 'Custom ribbon buttons',
    aliases: ['custom buttons', 'ribbon buttons', 'toolbar buttons', 'custom toolbar'],
  },
  {
    key: 'displaySizes',
    label: 'Style font sizes (pt)',
    description:
      "Render size for each named style. Doesn't change the underlying doc — only how it looks here.",
    kind: 'displaySizes',
    category: 'appearance',
    section: 'Document typography',
    mobile: true,
  },
  {
    key: 'displayTypography',
    label: 'Style typography',
    kind: 'displayTypography',
    category: 'appearance',
    section: 'Document typography',
    mobile: true,
  },
  {
    key: 'bodyFont',
    label: 'Body font',
    description:
      'Font family for body text.',
    kind: 'bodyFont',
    category: 'appearance',
    section: 'Document typography',
    aliases: ['document font', 'card font', 'editor font'],
  },
  {
    key: 'lineHeight',
    label: 'Line spacing',
    description:
      'Line-spacing multiplier per paragraph type (unitless × font-size).',
    kind: 'lineHeights',
    category: 'appearance',
    section: 'Document typography',
    aliases: ['line height'],
  },
  {
    key: 'displayParagraphSpacing',
    label: 'Paragraph spacing',
    description:
      'Blank space before and after each paragraph type, in points (the paragraph’s top/bottom margin — distinct from line spacing, which is the gap between lines).',
    kind: 'paragraphSpacing',
    category: 'appearance',
    section: 'Document typography',
    aliases: ['space before', 'space after', 'paragraph margin', 'before spacing', 'after spacing'],
  },
  {
    key: 'displayColors',
    label: 'Style colors',
    description:
      'Pick the color used for Analytic text, Undertag text, and the reading marker (which also tints the "unread after a marker" text). The same colors appear under Accessibility → Color overrides (Document text) — editing either place changes both. Analytic/Undertag switch to a lighter built-in blue/green in dark mode when the theme is applied to the document; the reading marker keeps your color.',
    kind: 'displayColors',
    category: 'appearance',
    section: 'Document typography',
  },
  {
    key: 'distinguishShading',
    label: 'Distinguish background color from highlighting',
    description:
      'When on, background color gets a faint dot grid over its fill so it can be told apart from highlighting at a glance. Off by default — the two stay visually identical. Display-only — the file and exports are untouched.',
    kind: 'toggle',
    category: 'appearance',
    section: 'Document typography',
    aliases: ['dot grid', 'shading cue', 'background color cue', 'dotted background'],
  },
  {
    key: 'markUnreadAfterMarker',
    label: 'Turn text after a mark red',
    description:
      "When on, all card body text after a mark turns red, which visually denotes portions you didn't read. This is bounded per card, and is preserved in exported versions of the document. Its color follows the reading-marker Style color.",
    kind: 'toggle',
    category: 'appearance',
    section: 'Document typography',
    aliases: ['reading marker', 'unread', 'red text', 'marked'],
  },
  {
    key: 'showCharacterStyles',
    label: 'Show character styles in ribbon',
    description:
      'Show the cite / underline / emphasis character-style buttons in the ribbon. When off, just that sub-panel is hidden; the rest of the formatting panel stays visible.',
    kind: 'toggle',
    category: 'appearance',
    section: 'Formatting panel',
  },
  {
    key: 'formattingPanelMode',
    label: 'Formatting panel',
    description:
      'How the Pocket / Hat / Block / Tag / Analytic buttons in the ribbon are displayed. "Labels" shows the style name, "Shortcuts" shows the keyboard binding, "Both" shows name · shortcut, "Hidden" removes the panel.',
    kind: 'formattingPanelMode',
    category: 'appearance',
    section: 'Formatting panel',
  },
  {
    key: 'formattingPanelPreview',
    label: 'Preview styles in formatting panel',
    description:
      'When on, formatting-panel buttons preview the visual treatment of the style they apply.',
    kind: 'toggle',
    category: 'appearance',
    section: 'Formatting panel',
  },
  {
    key: 'formatNavPaneByType',
    label: 'Format nav pane entries by type',
    description:
      "On by default. When on, top-level headings render bold, lower levels in lighter weight and size, and analytic entries in the analytic-blue accent. Turn off for a uniform list where only indentation conveys hierarchy.",
    kind: 'toggle',
    category: 'appearance',
    section: 'Nav pane & indicators',
  },
  {
    key: 'showCitePreview',
    label: 'Cite preview on hover',
    description:
      'Show the cite-formatted text from a card on the right side of its nav-pane entry when you hover.',
    kind: 'toggle',
    category: 'appearance',
    section: 'Nav pane & indicators',
    aliases: ['hover preview'],
  },
  {
    key: 'flashcardDueDot',
    label: 'Flashcards-due dot',
    description:
      "Show a red dot on the ribbon's Manage Flashcards button when one or more flashcards are due for review today. On by default; turn off if you'd rather not be nudged.",
    kind: 'toggle',
    category: 'appearance',
    section: 'Nav pane & indicators',
    aliases: ['flashcard due', 'review reminder', 'due indicator', 'red dot'],
  },
  {
    key: 'showCardNumbering',
    label: 'Show card numbering',
    description:
      'Render the computed numbers/letters for cards you have marked as numbered or substructure. Display-only — turning this off hides the numbers but keeps the structure; authoring a role turns it back on.',
    kind: 'toggle',
    category: 'appearance',
    section: 'Card numbering',
    aliases: ['numbering', 'card numbers', 'auto number'],
  },
  {
    key: 'showNumberingButtons',
    label: 'Show numbering buttons in the ribbon',
    description:
      'Show the ribbon cluster for numbering (number, substructure, restart, and show/hide). On by default; turning it off hides only the buttons — your numbering and its display are untouched.',
    kind: 'toggle',
    category: 'appearance',
    section: 'Card numbering',
    aliases: ['numbering buttons', 'numbering ribbon', 'numbering cluster'],
  },
  {
    key: 'cardNumberingFormat',
    label: 'Number separator',
    description:
      'The glyph after a number — “1.”, “1)”, “1:”, “1 -”, and dash/hyphen variants. Display-only — the .docx carries a canonical format each reader can override.',
    kind: 'cardNumberFormat',
    category: 'appearance',
    section: 'Card numbering',
    aliases: ['numbering format', 'number style', 'number separator'],
  },
  {
    key: 'cardNumberingSubFormat',
    label: 'Substructure separator',
    description:
      'The glyph after a substructure letter — configured independently of the number separator. Display-only.',
    kind: 'cardNumberSubFormat',
    category: 'appearance',
    section: 'Card numbering',
    aliases: ['substructure format', 'sub separator', 'letter separator'],
  },
  {
    key: 'cardNumberingSubCapitalized',
    label: 'Capitalize substructure letters',
    description: 'Render substructure as “A)”, “B)”… instead of “a)”, “b)”…. Display-only.',
    kind: 'toggle',
    category: 'appearance',
    section: 'Card numbering',
    aliases: ['uppercase substructure', 'capital letters', 'sub capitalization'],
  },
  {
    key: 'cardNumberingSubBold',
    label: 'Bold substructure letters',
    description:
      'Render substructure letters bold, like the numbers. Turn off for normal-weight letters. Display-only.',
    kind: 'toggle',
    category: 'appearance',
    section: 'Card numbering',
    aliases: ['substructure bold', 'sub weight', 'letter weight'],
  },
  {
    // Backed by customColorOverrides['pmd-c-card-number'] (a custom builder, not
    // the generic `key` path), so it's the SAME value as the "Card numbering"
    // swatch under Accessibility → Color overrides — edit either, both track.
    key: 'customColorOverrides',
    label: 'Numbering color',
    description:
      'The color of card numbers and substructure letters. Linked with the “Card numbering” swatch under Accessibility → Color overrides — changing one changes the other. “Match heading” makes each number follow its tag/analytic text color instead (including a manual font color that covers the whole heading).',
    kind: 'cardNumberColor',
    category: 'appearance',
    section: 'Card numbering',
    aliases: ['numbering color', 'number color', 'substructure color'],
  },
  {
    key: 'cardNumberingIndent',
    label: 'Number indent',
    description:
      'Whether numbered cards indent — none, the tag line only, or the whole card. Display-only.',
    kind: 'cardNumberIndent',
    category: 'appearance',
    section: 'Card numbering',
    aliases: ['numbering indent', 'number indent'],
  },
  {
    key: 'cardNumberingSubIndent',
    label: 'Substructure indent',
    description:
      'Whether substructure cards indent — configured independently of the number indent. Display-only.',
    kind: 'cardNumberSubIndent',
    category: 'appearance',
    section: 'Card numbering',
    aliases: ['substructure indent', 'sub indent'],
  },
  {
    key: 'timerPosition',
    label: 'Timer position in the ribbon',
    description:
      'Which edge of the ribbon the timer panel sits on when shown: the far left (default) or the far right.',
    kind: 'timerPosition',
    category: 'appearance',
    section: 'Timer display',
    aliases: ['timer left', 'timer right', 'timer side', 'move timer'],
  },
  {
    key: 'timerPrepLabel',
    label: 'Prep button label style',
    description:
      "How the Aff / Neg prep buttons identify which side they belong to. 'Text' uses A: / N: prefixes with no special color. 'Color' uses blue / red without the prefix. 'Both' (default) uses prefix and color together.",
    kind: 'timerPrepLabel',
    category: 'appearance',
    section: 'Timer display',
  },
  {
    key: 'timerCompact',
    label: 'Compact timer layout',
    description:
      "Drops the 9 / 6 / 3 speech-preset buttons and tucks Reset under Start / Pause. Useful when the ribbon is tight.",
    kind: 'toggle',
    category: 'appearance',
    section: 'Timer display',
  },
  {
    key: 'timerFlashEnabled',
    label: 'Flash timer when countdown is low',
    description:
      'Flash the timer display red as remaining time crosses each of the alert points configured below.',
    kind: 'toggle',
    category: 'appearance',
    section: 'Timer display',
  },
  {
    key: 'timerFlashSeconds',
    label: 'Alert points (seconds remaining)',
    description:
      'When the running clock crosses each of these seconds-remaining values, the display flashes (if flashing is on) and a beep plays (if audible alerts are on). Comma-separated, e.g. "60, 30, 5, 3, 1".',
    kind: 'timerFlashSeconds',
    category: 'appearance',
    section: 'Timer display',
    aliases: ['thresholds', 'alert points', 'time signals', 'countdown warning'],
  },
  {
    key: 'timerSoundEnabled',
    label: 'Audible timer alerts',
    description:
      'Play a short beep when the running clock crosses each alert point configured above (the same points the visual flash uses), and a double beep when time runs out. Works from every window, including the popped-out timer — exactly one sound plays no matter how many windows are open. Off by default.',
    kind: 'toggle',
    category: 'appearance',
    section: 'Timer display',
    aliases: ['beep', 'sound', 'audio alert', 'timer beep', 'time signal'],
  },
  {
    key: 'timerSoundVolume',
    label: 'Alert volume',
    description: 'Loudness of the timer beeps, 0–100.',
    kind: 'number',
    category: 'appearance',
    section: 'Timer display',
    revealWhen: 'timerSoundEnabled',
  },

  // ─── Editing ────────────────────────────────────────────────────
  {
    key: 'smartQuotes',
    label: 'Smart quotes',
    description:
      'As you type a straight \' or ", curl it to the right direction based on context — opening after a space, dash, or start of line; closing (and apostrophe) otherwise. Press Backspace right after to revert to the straight character. Off by default.',
    kind: 'toggle',
    category: 'editing',
    section: 'Typing',
    aliases: ['curly quotes', 'smart quotes', 'autocorrect quotes', 'typographic quotes'],
  },
  {
    key: 'customDashEnabled',
    label: 'Custom dash',
    description:
      'As you type, replace "---" (or "--" — your choice) with a dash of your choice (en or em dash, with or without surrounding spaces). The replacement happens on the last hyphen of the trigger; press Backspace right after to revert to the literal hyphens. Off by default.',
    kind: 'customDash',
    category: 'editing',
    section: 'Typing',
    aliases: ['dash', 'em dash', 'en dash', 'triple dash', 'autocorrect dash'],
  },
  {
    key: 'autoCapitalizeSentences',
    label: 'Auto-capitalize tags and analytics',
    description:
      'Capitalize the first word of each sentence (and a standalone "i") in tags and analytics as you type — the fix happens when you finish the word with a space or punctuation, and Backspace right after reverts it. Only applies to tags and analytics: card bodies and cites are quoted source text, which is never altered. Off by default.',
    kind: 'toggle',
    category: 'editing',
    section: 'Typing',
    aliases: ['autocapitalize', 'capitalize sentences', 'auto capitalization', 'capitalise'],
  },
  {
    key: 'customAutocorrectEnabled',
    label: 'Custom autocorrect',
    description:
      'Replace text as you type, Word-style: define your own entries (like "fwk" → "framework", or "--" → "---") and they expand the moment you finish the sequence with a space or punctuation. Press Backspace right after to get back exactly what you typed. Applies everywhere. If Auto-capitalize is also on, an expansion at the start of a sentence in a tag or analytic is capitalized too. Off by default.',
    kind: 'customAutocorrect',
    category: 'editing',
    section: 'Typing',
    aliases: ['autocorrect', 'text replacement', 'replace as you type', 'custom autocorrect', 'expansion', 'abbreviation'],
  },
  {
    key: 'copyPreviousCiteNearestOnly',
    label: 'Copy Previous Cite: nearest cite only',
    description:
      'Copy Previous Cite (Alt-F8) copies only the single nearest preceding cite paragraph. Turn this off to copy every cite under the most recent source (card or free-floating run) instead.',
    kind: 'toggle',
    category: 'editing',
    section: 'Cites',
    aliases: ['copy last cite', 'previous cite', 'nearest cite', 'single cite'],
  },
  {
    key: 'enterAfterPocket',
    label: 'Enter at the end of a structural style creates',
    description:
      "What pressing Enter at the end of each structural style creates. 'Normal paragraph' keeps the default behavior; any other choice acts exactly like pressing Enter and then that style's key on the new line — so Tag → Tag starts a fresh card on every Enter. One undo reverts the whole step.",
    kind: 'enterAfterStyle',
    category: 'editing',
    section: 'New paragraph on Enter',
    aliases: ['enter behavior', 'return key', 'new paragraph', 'enter after pocket', 'enter after hat', 'enter after block', 'enter after tag', 'enter after analytic', 'enter after undertag'],
  },
  {
    key: 'paragraphIntegrity',
    label: 'F3 condense: preserve paragraph integrity',
    description:
      'When on, F3 only removes intra-paragraph whitespace — paragraphs stay separate. When off, F3 merges consecutive collapsible paragraphs.',
    kind: 'toggle',
    category: 'editing',
    section: 'Condense',
  },
  {
    key: 'usePilcrows',
    label: 'F3 condense: use pilcrow markers',
    description:
      'When paragraph integrity is off and this is on, F3 inserts a 6-pt ¶ at each original paragraph boundary in the merged result, so that the split can be reversed via Ctrl/Cmd+Alt+Shift+F3 (Uncondense).',
    kind: 'toggle',
    category: 'editing',
    section: 'Condense',
  },
  {
    key: 'condenseOnPaste',
    label: 'Condense after Paste Text (F2)',
    description:
      'When on, text that you paste will be condensed using your default "condense" settings.',
    kind: 'toggle',
    category: 'editing',
    section: 'Condense',
  },
  {
    key: 'smartPasteConversion',
    label: 'Smart paste conversion',
    description:
      'Recognize content copied from Microsoft Word or haku.cards and convert it into CardMirror structure on paste — tags, cites, headings, underlining, and highlighting instead of unformatted text. Best effort: for full fidelity, open the .docx in CardMirror and copy from there. When off, or when the pasted content has no recognizable structure, pasting works exactly as before. Paste Text (F2) always pastes plain.',
    kind: 'toggle',
    category: 'editing',
    section: 'Paste',
    aliases: ['word paste', 'paste from word', 'haku', 'paste conversion', 'convert paste'],
  },

  {
    key: 'pasteCursor',
    label: 'Cursor after pasting a card',
    description:
      'Where the cursor lands after pasting a whole card (or heading) into a card body. "End of the pasted content" (default) matches every other paste. "End of the pasted tag" puts the cursor at the end of the first pasted heading, ready to rename it.',
    kind: 'pasteCursor',
    category: 'editing',
    section: 'Paste',
    aliases: ['paste cursor', 'cursor position', 'after paste', 'tag cursor'],
  },

  {
    key: 'versionHistory',
    label: 'Keep version history',
    description:
      'Keeps periodic snapshots of saved documents on this computer, browsable with Recover Previous Version. Standard keeps up to 30 days within modest disk caps. Extended keeps up to 90 days with much larger caps and can use several gigabytes of disk space. Custom lets you set the per-document and total disk caps yourself.',
    kind: 'versionHistory',
    category: 'general',
    section: 'Backup',
    aliases: ['version history', 'snapshots', 'backup versions', 'recover version', 'history'],
  },

  {
    key: 'headingMode',
    label: 'Condense: heading handling',
    description:
      'How selection-based condense without paragraph integrity treats structural elements (headings, cites, undertags) inside the selection. "Strict" blocks attempts to condense that include structural elements. "Respect" (default) keeps structural paragraphs unmerged and merges everything else in the selection. "Demolish" merges everything in the selection.',
    kind: 'headingMode',
    category: 'editing',
    section: 'Condense',
  },
  {
    key: 'condenseWarningDelimiter',
    label: 'Condense with warning: marker delimiter',
    description:
      'Which bracket style wraps the PARAGRAPH INTEGRITY PAUSES / RESUMES markers added by "Condense with warning" (Card menu).',
    kind: 'condenseWarningDelimiter',
    category: 'editing',
    section: 'Condense',
  },
  {
    key: 'extractUndertagInQuotes',
    label: 'Extract Undertag: wrap in quotes',
    description:
      'When on, the Extract Undertag command (Card menu → Excerpt) wraps the excerpt it pulls into the new undertag in double quotes. Off by default — the text is inserted as-is.',
    kind: 'toggle',
    category: 'editing',
    section: 'Formatting operations',
    aliases: ['extract undertag'],
  },

  {
    key: 'autoBridgeFormattingGaps',
    label: 'Bridge formatting across gaps automatically',
    description:
      'When on, applying highlight / underline / etc. next to an already-formatted word extends it across the small gap between them. Off disables this automatic bridging; the manual "Fix Formatting Gaps" command still works.',
    kind: 'toggle',
    category: 'editing',
    section: 'Formatting operations',
  },
  {
    key: 'formattingGapClass',
    label: 'Bridge formatting across',
    description:
      'Which gaps between two formatted words get bridged — both the automatic bridge and the manual "Fix Formatting Gaps" command.',
    kind: 'formattingGapClass',
    category: 'editing',
    section: 'Formatting operations',
  },
  {
    key: 'shrinkRestoresOmissionsToNormal',
    label: 'Shrink keeps protected text at Normal size',
    description:
      'When on, Shrink (Mod-8) leaves bracketed "Omitted" spans, the PARAGRAPH INTEGRITY PAUSES/RESUMES markers from "Condense with warning", and any custom protections (below) at Normal size so they stay visible in the shrunken output. When off, all of these are shrunk along with the rest of the text.',
    kind: 'toggle',
    category: 'editing',
    section: 'Formatting operations',
  },
  {
    key: 'shrinkCustomProtections',
    label: 'Custom shrink protections',
    description:
      'Strings (or regex sources, if the box is checked) that Shrink should leave at Normal size whenever protection is on. Literal entries are matched case-insensitively after escaping; regex entries are compiled with `gi` flags. Invalid regex entries are skipped.',
    kind: 'shrinkCustomProtections',
    category: 'editing',
    section: 'Formatting operations',
  },
  {
    key: 'clearFormattingOnNamedStyleToggleOff',
    label: 'F9 toggle-off also clears direct formatting',
    description:
      'When on, pressing F9 to toggle underlining off also strips direct formatting in the range. When off, only the underline style mark is removed; direct formatting applied to the underlined text is preserved.',
    kind: 'toggle',
    category: 'editing',
    section: 'Formatting operations',
  },
  {
    key: 'createReferenceIncludeHeading',
    label: 'Include the FOR REFERENCE heading',
    description:
      'When on (default), the copied excerpt starts with a heading line like <<SMITH 24 FOR REFERENCE>>. Turn off to copy just the reformatted body paragraphs.',
    kind: 'toggle',
    category: 'editing',
    section: 'Create Reference',
    aliases: ['create reference heading', 'for reference heading'],
  },
  {
    key: 'createReferenceDelimiter',
    label: 'Heading delimiter',
    description:
      'Which bracket pair wraps the heading line, e.g. <<SMITH 24 FOR REFERENCE>> vs [SMITH 24 FOR REFERENCE].',
    kind: 'createReferenceDelimiter',
    category: 'editing',
    section: 'Create Reference',
    dependsOn: 'createReferenceIncludeHeading',
    aliases: ['create reference delimiter', 'reference brackets'],
  },
  {
    key: 'createReferenceIncludeCite',
    label: 'Include the cite in the heading',
    description:
      "When on (default), the card's cite appears in the heading — the SMITH 24 in <<SMITH 24 FOR REFERENCE>>. In a custom heading it goes wherever %Cite% sits (or is prepended if there's no %Cite%).",
    kind: 'toggle',
    category: 'editing',
    section: 'Create Reference',
    dependsOn: 'createReferenceIncludeHeading',
    aliases: ['create reference cite', 'reference cite'],
  },
  {
    key: 'createReferenceCustomHeading',
    label: 'Custom heading text',
    description:
      'Replaces the default FOR REFERENCE label. Type %Cite% where the cite should go — e.g. "FROM %Cite%" gives <<FROM SMITH 24>>. Without %Cite%, the cite is prepended as usual. Leave empty for the default.',
    kind: 'text',
    category: 'editing',
    section: 'Create Reference',
    dependsOn: 'createReferenceIncludeHeading',
    aliases: ['create reference custom heading', 'reference heading text'],
  },
  {
    key: 'createReferenceHeadingBold',
    label: 'Bold heading',
    description: 'Make the FOR REFERENCE heading line bold in the copied excerpt.',
    kind: 'toggle',
    category: 'editing',
    section: 'Create Reference',
    dependsOn: 'createReferenceIncludeHeading',
    aliases: ['create reference bold heading', 'reference heading bold'],
  },
  {
    key: 'createReferenceHeadingItalic',
    label: 'Italic heading',
    description: 'Italicize the FOR REFERENCE heading line in the copied excerpt.',
    kind: 'toggle',
    category: 'editing',
    section: 'Create Reference',
    dependsOn: 'createReferenceIncludeHeading',
    aliases: ['create reference italic heading', 'reference heading italic'],
  },
  {
    key: 'createReferenceHeadingEmphasized',
    label: 'Emphasize heading',
    description:
      'Apply the emphasis style to the heading line. Mutually exclusive with Underline heading — if both are on, emphasis wins.',
    kind: 'toggle',
    category: 'editing',
    section: 'Create Reference',
    dependsOn: 'createReferenceIncludeHeading',
    aliases: ['create reference emphasize heading', 'reference heading emphasis'],
  },
  {
    key: 'createReferenceHeadingUnderlined',
    label: 'Underline heading',
    description:
      'Underline the heading line. Ignored when Emphasize heading is also on (emphasis wins).',
    kind: 'toggle',
    category: 'editing',
    section: 'Create Reference',
    dependsOn: 'createReferenceIncludeHeading',
    aliases: ['create reference underline heading', 'reference heading underline'],
  },
  {
    key: 'createReferenceShrinks',
    label: 'Reduce text size',
    description:
      'When on (default), every run in the copied excerpt has its font size reduced by the amount below.',
    kind: 'toggle',
    category: 'editing',
    section: 'Create Reference',
    aliases: ['create reference shrink', 'reference text size'],
  },
  {
    key: 'createReferenceShrinkPt',
    label: 'Reduce text size by (points)',
    description:
      'How many points the excerpt\'s text size is reduced by (default 3). Sizes never drop below 1pt.',
    kind: 'number',
    category: 'editing',
    section: 'Create Reference',
    dependsOn: 'createReferenceShrinks',
    aliases: ['create reference shrink amount'],
  },
  {
    key: 'createReferenceHighlightMode',
    label: 'Highlights become',
    description:
      'What happens to highlighted text in the copied excerpt: converted to a grey background (default — the marking stays visible in Word without occupying the highlight layer), converted to a background of the same color, kept as highlights, or removed.',
    kind: 'createReferenceHighlightMode',
    category: 'editing',
    section: 'Create Reference',
    aliases: ['create reference highlights', 'reference grey background', 'reference gray background'],
  },
  {
    key: 'forReferenceUseGray50',
    label: 'Use Gray-50% body text',
    description:
      'When on, the body text of the copied excerpt is rendered in Gray-50% (#808080) instead of black. The heading line stays black either way.',
    kind: 'toggle',
    category: 'editing',
    section: 'Create Reference',
    aliases: ['create reference gray', 'create reference grey', 'reference gray text'],
  },
  {
    key: 'standardizeHighlightException',
    label: 'Highlighting exception',
    description:
      'The highlight color that "Standardize Highlighting (with Exception)" (Doc menu) leaves untouched. Text highlighted in this color is skipped; everything else is rewritten to your active highlight color as usual.',
    kind: 'standardizeHighlightException',
    category: 'editing',
    section: 'Standardize exceptions',
    aliases: ['standardize highlighting exception', 'protected highlight color'],
  },
  {
    key: 'standardizeShadingException',
    label: 'Background color exception',
    description:
      'The background color that "Standardize Background Color (with Exception)" (Doc menu) leaves untouched. Text shaded in this color is skipped; everything else is rewritten to your active background color as usual.',
    kind: 'standardizeShadingException',
    category: 'editing',
    section: 'Standardize exceptions',
    aliases: ['standardize background exception', 'protected background color', 'protected grey', 'protected gray'],
  },
  {
    key: 'acronymPatterns',
    label: 'Custom acronym letters',
    description:
      'Teach the acronym commands (Alt-F10 emphasize, Alt-F11 highlight, Underline Acronym) which letters to mark for specific phrases, instead of the default first letter of each word. Type a phrase, then click its letters: pick the w, m, and d of "weapons of mass destruction" and the marked text reads "WMD" (the default would also mark the o of "of"). Matching is case-insensitive and applies when the selection is exactly that phrase.',
    kind: 'acronymPatterns',
    category: 'editing',
    section: 'Acronym marking',
    aliases: ['acronym', 'acronyms', 'custom acronym', 'acronym letters'],
  },
  {
    key: 'showDropzonePill',
    label: 'Show dropzone shelf',
    description:
      "When on, the cross-window dropzone pill sits in the editor's bottom-left corner (the editor nearest the nav pane in multi-pane layouts). Turning it off hides the pill from the chrome; the shelf state and the Send to Dropzone shortcut still work — items pile up in the store and can be retrieved from any window that has the pill visible.",
    kind: 'toggle',
    category: 'editing',
    section: 'Insert surfaces',
  },
  {
    key: 'showQuickCardButtons',
    label: 'Show quick card buttons',
    description:
      'When on, the Quick Cards cluster — the command bar, tag picker, manage, and add buttons — appears in the ribbon. Off by default. Turning it off hides all four; quick cards still work, and the command bar still opens with its keyboard shortcut.',
    kind: 'toggle',
    category: 'editing',
    section: 'Insert surfaces',
  },
  {
    key: 'translationProvider',
    label: 'Translation',
    description:
      'Translate the selected text and copy the result to the clipboard (the document is left unchanged). Pick a backend, the source and target languages, and any keys below.',
    kind: 'translationConfig',
    category: 'editing',
    section: 'Translation',
    aliases: ['translate', 'translator', 'language', 'mymemory', 'google translate', 'deepl'],
  },
  {
    key: 'prependTranslationMarker',
    label: 'Prepend a “translation by” marker',
    description:
      'When on, the Translator puts a marker line — e.g. [TRANSLATION BY OPUS 4.8], [TRANSLATION BY MYMEMORY], or [TRANSLATION BY GOOGLE TRANSLATE] — above the translated text on the clipboard. It uses the same delimiter as “Condense with warning” above, and (when “Shrink keeps protected text at Normal size” is on) all of these markers are protected from Shrink. On by default.',
    kind: 'toggle',
    category: 'editing',
    section: 'Translation',
    aliases: ['translation marker', 'translation by', 'attribution'],
  },

  // ─── Keyboard shortcuts ─────────────────────────────────────────
  {
    key: 'ribbonKeyOverrides',
    label: 'Keyboard shortcuts',
    description:
      'Rebind any ribbon / menu command to your own keys. Click + on a row to add a binding; click × on a chip to remove one; click ↺ to restore that row\'s defaults.',
    kind: 'keybindings',
    category: 'shortcuts',
  },

  // ─── Comments & AI ──────────────────────────────────────────────
  {
    key: 'commentAuthor',
    label: 'Comment author name',
    description: 'Display name attached to comments you create. Stored locally.',
    kind: 'text',
    category: 'comments-ai',
  },
  {
    key: 'commentAuthorInitials',
    label: 'Comment author initials',
    description: 'Short badge shown on your comments. Auto-derived from the name if left empty.',
    kind: 'text',
    category: 'comments-ai',
  },
  {
    key: 'aiFeaturesEnabled',
    label: 'Enable AI features',
    description:
      'Master switch for AI-powered comment features (in-comment "Explain" prompts, @AI mentions). Requires selecting a provider and pasting its API key below.',
    kind: 'toggle',
    category: 'comments-ai',
    mobile: true,
  },
  {
    key: 'aiProvider',
    label: 'AI provider',
    description:
      'Which inference service the AI features use. Anthropic talks to the ' +
      'Anthropic API; OpenRouter talks to openrouter.ai (OpenAI-compatible). ' +
      'Each provider has its own key below.',
    kind: 'aiProvider',
    category: 'comments-ai',
    mobile: true,
    dependsOn: 'aiFeaturesEnabled',
    aliases: ['openrouter', 'provider', 'model provider'],
  },
  {
    key: 'anthropicApiKey',
    label: 'Anthropic API key',
    description: 'Used when AI features are enabled and the provider is Anthropic.',
    kind: 'password',
    category: 'comments-ai',
    mobile: true,
    dependsOn: ['aiFeaturesEnabled', { key: 'aiProvider', equals: 'anthropic' }],
  },
  {
    key: 'aiModelOverride',
    label: 'AI model (advanced)',
    description:
      'Optional. The Claude model id used by all AI features (e.g. claude-opus-4-8). Leave blank to use the version built into this release. Set a newer id here if the built-in model has been retired and you’d rather not update the whole app. A malformed entry is ignored and the default is used.',
    kind: 'text',
    category: 'comments-ai',
    mobile: true,
    dependsOn: ['aiFeaturesEnabled', { key: 'aiProvider', equals: 'anthropic' }],
    aliases: ['model', 'claude model', 'model override', 'opus', 'sonnet', 'haiku'],
  },
  {
    key: 'openrouterApiKey',
    label: 'OpenRouter API key',
    description:
      'Used when the provider is OpenRouter. Stored locally in browser ' +
      'settings; sent only to openrouter.ai.',
    kind: 'password',
    category: 'comments-ai',
    mobile: true,
    dependsOn: ['aiFeaturesEnabled', { key: 'aiProvider', equals: 'openrouter' }],
  },
  {
    key: 'openrouterModel',
    label: 'OpenRouter model',
    description:
      'Required when the provider is OpenRouter. The model id, e.g. ' +
      'anthropic/claude-sonnet-4.6 or openai/gpt-4o. No default - AI features ' +
      'will not run until this is set.',
    kind: 'text',
    category: 'comments-ai',
    mobile: true,
    dependsOn: ['aiFeaturesEnabled', { key: 'aiProvider', equals: 'openrouter' }],
    aliases: ['openrouter model', 'model'],
  },
  {
    key: 'aiMaxTokens',
    label: 'Max output tokens',
    description:
      'Token budget for AI features that do not set their own (cite, explain, ' +
      'flashcards, image alt text). Applies to both providers. Reasoning models ' +
      'spend hidden thinking tokens from this budget, so we recommend higher ' +
      'values (e.g. 4096-8192) - too low and the model can run out before it ' +
      'writes the reply. Minimum 1024.',
    kind: 'number',
    min: 1024,
    category: 'comments-ai',
    mobile: true,
    dependsOn: 'aiFeaturesEnabled',
    aliases: ['max tokens', 'output tokens', 'token budget', 'reasoning', 'thinking'],
  },
  {
    key: 'clodEnabled',
    label: 'Enable Clod mode',
    description:
      'When the AI is composing a reply, the in-flight placeholder cycles through time-of-day Clod activities ("Clod is making toast…") instead of plain "Thinking…".',
    kind: 'clod',
    category: 'comments-ai',
    dependsOn: 'aiFeaturesEnabled',
    mobile: true,
  },
  {
    key: 'clodActivitiesByTime',
    label: 'Customize Clod',
    description:
      'Set the name and pronouns for Clod, write your own activity phrases for each time of day, and adjust when those periods begin. Opens a full editor.',
    kind: 'clodCustomize',
    category: 'comments-ai',
    dependsOn: 'aiFeaturesEnabled',
    aliases: ['clod', 'persona', 'clod activities', 'pronouns', 'clod name'],
  },
  {
    key: 'aiCitePrompt',
    label: 'AI cite-creator prompt',
    description:
      'System prompt the cite-creator hands to the model. Click "Edit prompt" to open a full-size editor. Leave blank to use the built-in default.',
    kind: 'aiCitePrompt',
    category: 'comments-ai',
    dependsOn: 'aiFeaturesEnabled',
  },
  // ─── Card Cutter (experimental; console-gated, hidden until on) ──
  {
    key: 'cardCutterReadTimeSec',
    label: 'Default read length',
    description:
      'Which read-length option the cut panel opens with. Efficient cuts as tight as the content allows with no fixed cap; a seconds cap trims the read to fit at your reader words-per-minute. Every cut can still override this in the panel.',
    kind: 'cardCutterReadTime',
    category: 'comments-ai',
    searchHidden: true,
    revealWhen: 'cardCutterEnabled',
  },
  {
    key: 'cardCutterEnginePath',
    label: 'Engine file',
    description:
      'Path to the card-cutter engine bundle this build loads (packaged installs only — the engine is never shipped with the app). Leave empty to use the CARDCUTTER_ENGINE environment variable, or the default plugins location in the app data folder. Reload after changing.',
    kind: 'cardCutterEnginePath',
    category: 'comments-ai',
    electronOnly: true,
    searchHidden: true,
    revealWhen: 'cardCutterEnabled',
  },
  {
    key: 'cardCutterEnabled',
    label: 'Disable the card cutter',
    description:
      'Turns the experimental card cutter back off, hides its ribbon commands and shortcuts, and removes this settings tab. Re-enable with the console command.',
    kind: 'cardCutterDisable',
    category: 'comments-ai',
    searchHidden: true,
    revealWhen: 'cardCutterEnabled',
  },
  {
    key: 'pairingEnabled',
    label: 'Enable collaboration',
    description:
      'Turn on cross-machine collaboration — both card sharing and real-time co-editing. Card sharing adds a Send and a Receive pill next to the dropzone (drag a card onto Send to push it to a recipient; cards others send you land in Receive). Co-editing lets you share a document and edit it together live.',
    kind: 'toggle',
    category: 'pairing',
    aliases: ['share', 'send card', 'recipient', 'to', 'pairing', 'card sharing', 'collaboration', 'co-edit', 'coedit', 'co-editing'],
  },
  {
    key: 'pairingOwnCode',
    label: 'Your pairing code',
    description:
      "This machine's code. Share it with anyone you want to be able to send you cards. Anyone with this code (and the app) can send to you; regenerate it to cut off old shares.",
    kind: 'pairingOwnCode',
    category: 'pairing',
    dependsOn: 'pairingEnabled',
  },
  {
    key: 'pairingConnectedUntil',
    label: 'Debate Decoded account',
    description:
      'Links this machine to your paid Debate Decoded membership, required for card sharing ' +
      'and co-editing on the official relay. To link, open ' +
      'debate-decoded.ghost.io/cardmirror-connect, sign in, and paste the code it shows you ' +
      'here. Each membership covers two machines; linking a third asks before unlinking the ' +
      'oldest.',
    kind: 'pairingAccount',
    category: 'pairing',
    dependsOn: 'pairingEnabled',
    aliases: ['account', 'auth', 'authorize', 'debate decoded', 'connect code', 'membership'],
  },
  {
    key: 'pairingDisplayName',
    label: 'Your display name',
    // Web too (not electronOnly): co-editing presence cursors carry
    // this name — without the row, web users are stuck as "Guest NNN".
    description:
      "Optional name shown to collaborators — on your live cursor in co-editing sessions, and stamped on cards you send. Leave empty for a generic name.",
    kind: 'text',
    category: 'pairing',
    dependsOn: 'pairingEnabled',
  },
  {
    key: 'pairingPartners',
    label: 'Recipients',
    description:
      'Machines you can send to. Add one by pasting the code it shared with you and giving it a name (shown in the To list when sending, and on cards you receive from it). Hide a recipient from the Send pill (the eye button) without deleting it.',
    kind: 'pairingPartners',
    category: 'pairing',
    dependsOn: 'pairingEnabled',
  },
  {
    key: 'pairingGroups',
    label: 'Groups',
    description:
      'Named sets of recipients for one-drop sends — e.g. a "Smith/Jones" team. Dropping a card on a group sends it to every member.',
    kind: 'pairingGroups',
    category: 'pairing',
    dependsOn: 'pairingEnabled',
  },
  {
    key: 'pairingBlockedCodes',
    label: 'Blocked senders',
    description:
      'Cards and room invites from these senders never appear — they are dropped silently from the Receive inbox and its unread count. Paste a code to block it, or block someone who recently shared with you. The sender code is self-declared, so this is a convenience filter, not a security guarantee.',
    kind: 'pairingBlocked',
    category: 'pairing',
    dependsOn: 'pairingEnabled',
    aliases: ['block', 'blocklist', 'ignore sender', 'mute sender'],
  },
  {
    key: 'collabShowCursors',
    label: 'Show partner cursors in sessions',
    description:
      "Render your partner's live cursor and selection during a collaboration session. Turning this off keeps the document syncing — it only hides the cursor overlay (and stops broadcasting yours).",
    kind: 'toggle',
    category: 'pairing',
    electronOnly: true,
    dependsOn: 'pairingEnabled',
  },
  {
    key: 'pairingReceiveFlash',
    label: 'Flash the Receive pill on a new card',
    description:
      'Flash the Receive pill green when a card arrives. "Flash once" pulses a single time; "Keep flashing" re-pulses every 10 seconds until you open the Receive pill and see the new card(s); "Off" never flashes.',
    kind: 'pairingReceiveFlash',
    category: 'pairing',
    dependsOn: 'pairingEnabled',
  },
  {
    key: 'pairingPollSeconds',
    label: 'Fallback poll every (seconds)',
    description:
      'New cards normally arrive instantly by live push. This sets the polling cadence used only against relays without push support, and (at least every 5 minutes) the safety-net catch-up while push is connected. Default 30; clamped to 5–3600.',
    kind: 'number',
    category: 'pairing',
    electronOnly: true,
    dependsOn: 'pairingEnabled',
  },
  {
    key: 'pairingRelayUrl',
    label: 'Custom relay URL',
    description:
      'Point card sharing at your own relay server instead of the official one — e.g. https://relay.example.com/relay. The relay server ships in the CardMirror repo\'s relay/ folder (see its README); everyone sharing cards must use the same relay. Leave empty for the official relay.',
    kind: 'text',
    category: 'pairing',
    dependsOn: 'pairingEnabled',
    aliases: ['self-hosted relay', 'relay server', 'custom server'],
  },
  {
    key: 'pairingRelayToken',
    label: 'Custom relay token',
    description:
      "The RELAY_TOKEN configured on your self-hosted relay. Only used when a custom relay URL is set; stored locally on this machine. Leave empty when using the official relay.",
    kind: 'password',
    category: 'pairing',
    dependsOn: 'pairingEnabled',
    aliases: ['relay token', 'relay password'],
  },
  {
    key: 'pluginsEnabled',
    label: 'Enable plugins',
    description:
      'Load installed third-party plugins at startup. Plugins run with full access to CardMirror and your documents - install only plugins whose author you trust. Takes effect on the next launch.',
    kind: 'toggle',
    category: 'plugins',
    electronOnly: true,
  },
  {
    // Lives on the Plugins tab below the plugin manager (re-appended by
    // the settings-ui plugins block, like Verbatim Flow) and is NOT
    // gated by Enable plugins — the bridge is not the plugin system.
    key: 'externalInsertPolicy',
    label: 'Inserts from external apps',
    description:
      'Local companion apps (like ebb or Fast Debate Paste) can insert text and jump to sources over the local bridge. "Ask for each app" (default) prompts the first time an app sends and remembers your answer below. "Allow all" accepts every sender — including older apps that don\u2019t identify themselves. "Block all" turns the whole surface off. This does not affect plugins running inside CardMirror.',
    kind: 'externalInsertPolicy',
    category: 'plugins',
    section: 'External apps',
    electronOnly: true,
    aliases: ['external apps', 'bridge', 'inbound inserts', 'consent', 'allow all'],
  },
  {
    // Lives on the Plugins tab (it's plugin-shaped: a bundled Verbatim
    // integration) but is NOT gated by Enable plugins — the settings-ui
    // plugins block re-appends this row below the plugin manager.
    key: 'flowHostOnLaunch',
    label: 'Keep a Verbatim Flow connection warm',
    description:
      'Start the background connection to Excel when CardMirror launches, so your first Send to Flow is fast instead of waiting a second or two for it to spin up. Leave off to start it on demand the first time you use a Flow command (every send after that is fast either way). You can also start it any time with the "Start Flow Connection" command.',
    kind: 'toggle',
    category: 'plugins',
    section: 'Verbatim Flow',
    windowsOnly: true,
    aliases: ['flow', 'verbatim flow', 'powershell', 'warm', 'prewarm', 'excel'],
  },
];

/** Host / state lookups needed to decide which toggles are actionable right
 *  now — passed in (rather than read from a live host module) so the
 *  derivation stays pure and unit-testable. */
export interface ToggleEnv {
  /** `getHost().kind` — 'electron' | 'browser' | … */
  hostKind: string;
  /** Whether this is the Windows desktop (Verbatim Flow host). */
  isWindows: boolean;
  /** Current value lookup, used to hide toggles whose dependency / reveal
   *  condition isn't met (toggling them would be a silent no-op). */
  get: (key: keyof Settings) => unknown;
}

/** The boolean settings that can be toggled directly from the command bar:
 *  every `kind: 'toggle'` row, minus those hidden from search, gated off on
 *  this host, or currently inert because a `dependsOn` / `revealWhen`
 *  condition isn't met. Derived from SETTING_METADATA so the command bar's
 *  "Toggle …" list tracks the registry automatically — adding or removing a
 *  toggle setting adds or removes its command with no extra wiring.
 *
 *  (If a specific `kind: 'toggle'` setting should NOT be command-bar
 *  toggleable in the future, the cleanest lever is to add an opt-out flag to
 *  SettingMeta and filter it here; for now the set is exactly the visible
 *  toggles.) */
/** Whether a setting's command-bar action should be offered right now:
 *  visible in search, applicable on this host, and not inert because a
 *  dependency / reveal condition is unmet. Shared by the toggle and cycle
 *  derivations so both gate identically to the settings dialog. */
function isSettingActionable(m: SettingMeta, env: ToggleEnv): boolean {
  return (
    !m.searchHidden &&
    (!m.electronOnly || env.hostKind === 'electron') &&
    (!m.windowsOnly || env.isWindows) &&
    (!m.webOnly || env.hostKind === 'browser') &&
    (!m.revealWhen || env.get(m.revealWhen) === true) &&
    evalDependsOn(m.dependsOn, env.get)
  );
}

/** Whether a settings row is hidden in a LITE build (see lite.ts):
 *  everything AI, everything collaboration/plugins (their tabs hide
 *  wholesale, this also covers palette/toggle surfaces), and the
 *  dictation-model row (its download talks to the internet). Keyed by
 *  prefix + category so new AI/pairing rows inherit the rule. */
export function hiddenInLite(meta: SettingMeta): boolean {
  if (!isLiteBuild()) return false;
  if (meta.category === 'pairing' || meta.category === 'plugins') return true;
  const k = meta.key as string;
  if (/^(ai|clod|anthropic|openrouter)/i.test(k)) return true;
  return k === 'voiceDictationModel';
}

export function toggleableSettingMetas(env: ToggleEnv): SettingMeta[] {
  return SETTING_METADATA.filter(
    (m) => m.kind === 'toggle' && isSettingActionable(m, env) && !hiddenInLite(m),
  );
}

/** An enum/mode setting the command bar can cycle through, with each value's
 *  display label (for the command's toast + search terms). This is the
 *  curated set — the revision surface for "Cycle <setting>" commands. Only
 *  small, ordered domains that read well as a one-key cycle belong here;
 *  boolean settings use the toggle path instead, and `theme` already has the
 *  built-in `cycleTheme` ribbon command. */
export interface CyclableSetting {
  key: keyof Settings;
  /** Ordered values; the command advances to the next (wrapping). */
  values: readonly { value: string; label: string }[];
}

export const CYCLABLE_SETTINGS: readonly CyclableSetting[] = [
  {
    key: 'pasteCursor',
    values: [
      { value: 'after', label: 'End of pasted content' },
      { value: 'tag', label: 'End of pasted tag' },
    ],
  },
  {
    key: 'headingMode',
    values: [
      { value: 'strict', label: 'Strict' },
      { value: 'respect', label: 'Respect' },
      { value: 'demolish', label: 'Demolish' },
    ],
  },
  {
    key: 'formattingPanelMode',
    values: [
      { value: 'labels', label: 'Labels' },
      { value: 'shortcuts', label: 'Shortcuts' },
      { value: 'both', label: 'Both' },
      { value: 'hidden', label: 'Hidden' },
    ],
  },
  {
    key: 'ribbonTooltipMode',
    values: [
      { value: 'none', label: 'None' },
      { value: 'tooltip', label: 'Tooltip' },
      { value: 'shortcut', label: 'Shortcut' },
      { value: 'both', label: 'Both' },
    ],
  },
  {
    key: 'iconSet',
    values: [
      { value: 'modern', label: 'Modern' },
      { value: 'classic', label: 'Classic' },
    ],
  },
  {
    key: 'reduceMotion',
    values: [
      { value: 'auto', label: 'Auto' },
      { value: 'on', label: 'On' },
      { value: 'off', label: 'Off' },
    ],
  },
  {
    key: 'timerPosition',
    values: [
      { value: 'left', label: 'Left' },
      { value: 'right', label: 'Right' },
    ],
  },
  {
    key: 'multiDocLayoutMode',
    values: [
      { value: 'compact', label: 'Compact' },
      { value: 'wide', label: 'Wide-scroll' },
    ],
  },
  {
    key: 'fileSearchTiebreak',
    values: [
      { value: 'recency', label: 'Recency' },
      { value: 'alphabetical', label: 'Alphabetical' },
    ],
  },
];

/** The cyclable settings actionable right now (same host/dependency gating as
 *  toggles). Each result pairs the cycle table entry with its live metadata. */
export function cyclableSettings(env: ToggleEnv): { setting: CyclableSetting; meta: SettingMeta }[] {
  const out: { setting: CyclableSetting; meta: SettingMeta }[] = [];
  for (const setting of CYCLABLE_SETTINGS) {
    const meta = SETTING_METADATA.find((m) => m.key === setting.key);
    if (meta && isSettingActionable(meta, env)) out.push({ setting, meta });
  }
  return out;
}

/** The value the cycle command should move to, given the current value. Wraps;
 *  falls back to the first value if the current one isn't in the list. */
export function nextCycleValue(
  setting: CyclableSetting,
  current: unknown,
): { value: string; label: string } {
  const i = setting.values.findIndex((v) => v.value === current);
  return setting.values[(i + 1) % setting.values.length] ?? setting.values[0]!;
}

/** Display label for the current value (for a command's secondary text). */
export function currentCycleLabel(setting: CyclableSetting, current: unknown): string {
  return setting.values.find((v) => v.value === current)?.label ?? String(current);
}

/** Sections whose setting labels are context-free outside the settings dialog
 *  — the dialog shows the section header above them, but a search result or a
 *  generated command shows the label alone ("Bold heading", "Highlighting
 *  exception"). Rows in these sections are prefixed with the section header
 *  everywhere they surface in search: the settings-search rows AND the
 *  Toggle/Cycle commands. Add a section here to prefix all of its settings. */
export const CONTEXTLESS_SECTIONS = new Set<string>([
  'Create Reference',
  'Standardize exceptions',
]);

/** "<Section>: " when the setting lives in a context-free section, else "". */
export function settingContextPrefix(m: SettingMeta): string {
  return m.section && CONTEXTLESS_SECTIONS.has(m.section) ? `${m.section}: ` : '';
}

/** The name a setting shows under in the command bar's settings search: its
 *  real label (matching the dialog), prefixed with the section for
 *  context-free sections so a fragment like "Bold heading" reads as
 *  "Create Reference: Bold heading". */
export function settingSearchName(m: SettingMeta): string {
  return `${settingContextPrefix(m)}${m.label}`;
}

/** A setting label with a redundant leading verb stripped, so a "Toggle
 *  <this>" command name doesn't read as "Toggle Enable …"; the first letter
 *  is re-capitalized. The command bar still matches the ORIGINAL label, so
 *  "enable collaboration" continues to find "Toggle Collaboration". */
export function cleanToggleLabel(label: string): string {
  const stripped = label.replace(/^(?:enable|show|include|use)\s+(?:the\s+)?/i, '');
  if (!stripped || stripped === label) return label;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

/** Display name for a setting's toggle command: "Toggle <clean label>",
 *  prefixed with the section for context-free sections. */
export function toggleCommandName(m: SettingMeta): string {
  return `Toggle ${settingContextPrefix(m)}${cleanToggleLabel(m.label)}`;
}

/** Display name for a setting's cycle command — "Cycle <clean label>",
 *  prefixed with the section for context-free sections. */
export function cycleCommandName(m: SettingMeta): string {
  return `Cycle ${settingContextPrefix(m)}${cleanToggleLabel(m.label)}`;
}

/** Origin info handed to settings subscribers. `remote` is true when
 *  the change arrived from ANOTHER window via the cross-window storage
 *  event, rather than a `set()` in this window. Subscribers that drive
 *  window-level side effects — notably the `multiDocWorkspace` mode
 *  switch, which closes the other windows and reloads — must act on
 *  LOCAL changes only; otherwise every window runs the switch at once
 *  and they close each other, leaving nothing open. */
export interface SettingsChangeMeta {
  remote: boolean;
}
type Listener = (s: Readonly<Settings>, meta: SettingsChangeMeta) => void;

export class SettingsStore {
  private values: Settings;
  private listeners: Set<Listener> = new Set();

  constructor() {
    this.values = this.load();
    // Cross-window propagation. The browser `storage` event fires on
    // every window that shares the origin EXCEPT the one that wrote
    // the change — so this won't infinite-loop. Electron's
    // BrowserWindows follow the same Web standard, which means
    // settings changes in any window flow to all other live windows
    // without explicit IPC. We reload the full snapshot rather than
    // patching by key: localStorage holds the whole settings object
    // under one key, so the simplest correct behavior is "reapply
    // what's now on disk."
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (event) => {
        if (event.storageArea !== localStorage) return;
        if (event.key !== STORAGE_KEY && event.key !== null) return;
        const incoming = this.load();
        // Transient keys (e.g., read mode) stay window-local: don't
        // let another window's persisted state override what THIS
        // window has chosen. The originating window persists only
        // the non-transient keys, but a fresh load() would still
        // hydrate transients from DEFAULTS — which would erase
        // this window's current value if we didn't pin it.
        for (const key of TRANSIENT_SETTING_KEYS) {
          (incoming as unknown as Record<string, unknown>)[key] = (
            this.values as unknown as Record<string, unknown>
          )[key];
        }
        this.values = incoming;
        this.notify(true);
      });
    }
  }

  get<K extends keyof Settings>(key: K): Settings[K] {
    // Lite: the network-touching masters read as OFF no matter what
    // storage holds or what a console call set — the read side is the
    // enforcement every feature gate actually consults, so hiding the
    // rows plus this makes the state unreachable rather than merely
    // undocumented.
    if (
      isLiteBuild() &&
      (key === 'aiFeaturesEnabled' || key === 'pairingEnabled' || key === 'pluginsEnabled')
    ) {
      return false as Settings[K];
    }
    return this.values[key];
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    if (this.values[key] === value) return;
    this.values[key] = value;
    if (!TRANSIENT_SETTING_KEYS.has(key as string)) this.persist();
    this.notify();
  }

  all(): Readonly<Settings> {
    return { ...this.values };
  }

  /** Snapshot for export: every persisted setting EXCEPT transient
   *  (per-window) keys and the secret credentials (API keys / the
   *  MyMemory email), which are never exported. */
  exportObject(): Record<string, unknown> {
    const out: Record<string, unknown> = { ...this.values };
    for (const key of SECRET_SETTING_KEYS) delete out[key];
    for (const key of TRANSIENT_SETTING_KEYS) delete out[key];
    return out;
  }

  /** Overwrite ALL settings from an imported (untrusted) object. Runs
   *  through `sanitize({ ...DEFAULTS, ...raw })` — the same boundary as
   *  load — so it tolerates schema drift: fields added since the export
   *  fall back to defaults, fields removed since are dropped, and bad
   *  values are coerced/clamped. The secret credentials (never exported)
   *  and transient per-window values are preserved, not wiped. */
  replaceAll(raw: unknown): void {
    const parsed = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const preserved: Record<string, unknown> = {};
    for (const key of SECRET_SETTING_KEYS) {
      preserved[key] = (this.values as unknown as Record<string, unknown>)[key];
    }
    for (const key of TRANSIENT_SETTING_KEYS) {
      preserved[key] = (this.values as unknown as Record<string, unknown>)[key];
    }
    this.values = sanitize({ ...DEFAULTS, ...parsed, ...preserved } as Settings);
    this.persist();
    this.notify();
  }

  /** Subscribe to any settings change. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private load(): Settings {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          // Strip transient keys before merging — they're per-
          // session/per-window. If an earlier version of the app
          // happened to persist `readMode`, we don't want this
          // window to boot into it.
          for (const key of TRANSIENT_SETTING_KEYS) {
            delete (parsed as Record<string, unknown>)[key];
          }
          return sanitize({ ...DEFAULTS, ...parsed });
        }
      }
      // Migrate legacy individual keys, if any.
      const legacy: Partial<Settings> = {};
      const navWidth = localStorage.getItem('pmd-nav-width');
      if (navWidth != null) {
        const n = parseInt(navWidth, 10);
        if (Number.isFinite(n)) legacy.navWidth = n;
      }
      const navMaxLevel = localStorage.getItem('pmd-nav-max-level');
      if (navMaxLevel != null) {
        const n = parseInt(navMaxLevel, 10);
        if (Number.isFinite(n)) legacy.navMaxLevel = n;
      }
      return sanitize({ ...DEFAULTS, ...legacy });
    } catch {
      return { ...DEFAULTS };
    }
  }

  private persist(): void {
    try {
      // Strip transient keys before serializing so they neither
      // survive a reload nor (more importantly) trigger a storage
      // event with a stale read-mode flag for other windows.
      const toStore: Record<string, unknown> = { ...this.values };
      for (const key of TRANSIENT_SETTING_KEYS) delete toStore[key];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
    } catch {
      /* localStorage full / disabled — ignore */
    }
  }

  private notify(remote = false): void {
    const snapshot = { ...this.values };
    const meta: SettingsChangeMeta = { remote };
    for (const listener of this.listeners) listener(snapshot, meta);
  }
}

/** customAutocorrects sanitizer: drop malformed rows, trim keys, forbid
 *  whitespace in keys, cap sizes, and dedupe case-insensitively (first
 *  entry wins — matches the settings table's add-time duplicate refusal). */
function sanitizeCustomAutocorrects(raw: unknown): Array<{ from: string; to: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ from: string; to: string }> = [];
  const seen = new Set<string>();
  for (const row of raw) {
    if (typeof row !== 'object' || row === null) continue;
    const from = String((row as { from?: unknown }).from ?? '').trim();
    const to = String((row as { to?: unknown }).to ?? '');
    if (!from || from.length > 64 || /\s/.test(from)) continue;
    if (!to || to.length > 256) continue;
    const key = from.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from, to });
    if (out.length >= 200) break;
  }
  return out;
}

function sanitize(s: Settings): Settings {
  return {
    navWidth: clamp(s.navWidth, 150, 800),
    navMaxLevel: clamp(Math.round(s.navMaxLevel), 1, 4),
    navFollowCursor: s.navFollowCursor !== false,
    dragInteractions: s.dragInteractions !== false,
    readerReduceMotion: s.readerReduceMotion === true,
    // Default-on: preserve `false` only when explicitly set so the
    // onboarding shows up for new installs and survives upgrades
    // from before this setting existed.
    showOnboardingStarter: s.showOnboardingStarter === false ? false : true,
    hasSeenUiTour: s.hasSeenUiTour === true,
    hasSeenCutInPlaceNotice: s.hasSeenCutInPlaceNotice === true,
    defaultSpeechDocFolder:
      typeof s.defaultSpeechDocFolder === 'string'
        ? s.defaultSpeechDocFolder
        : '',
    defaultSpeechDocFormat:
      s.defaultSpeechDocFormat === 'cmir' ? 'cmir' : 'docx',
    // An empty string is a legitimate stored value only by accident
    // (it renders to the "Speech" fallback), so treat blank as unset
    // and restore the default.
    speechDocFilenameTemplate:
      typeof s.speechDocFilenameTemplate === 'string' &&
      s.speechDocFilenameTemplate.trim()
        ? s.speechDocFilenameTemplate
        : DEFAULT_SPEECH_FILENAME_TEMPLATE,
    defaultSaveFormat:
      s.defaultSaveFormat === 'cmir' ? 'cmir' : 'docx',
    // Default-on: only an explicit `false` disables the preset
    // filename prefixes (survives upgrades from before this existed).
    prefixPresetSaveFilenames: s.prefixPresetSaveFilenames === false ? false : true,
    sendDocPrefix: typeof s.sendDocPrefix === 'string' ? s.sendDocPrefix : 'SEND_',
    readDocPrefix: typeof s.readDocPrefix === 'string' ? s.readDocPrefix : 'READ_',
    markedDocPrefix: typeof s.markedDocPrefix === 'string' ? s.markedDocPrefix : 'MARKED_',
    sendDocDestination:
      s.sendDocDestination === 'fixedFolder' ? 'fixedFolder' : 'sameFolder',
    sendDocFolder: typeof s.sendDocFolder === 'string' ? s.sendDocFolder : '',
    markedCardsDestination:
      s.markedCardsDestination === 'fixedFolder' ? 'fixedFolder' : 'sameFolder',
    markedCardsFolder:
      typeof s.markedCardsFolder === 'string' ? s.markedCardsFolder : '',
    theme:
      s.theme === 'light' || s.theme === 'dark' ? s.theme : 'system',
    themeAppliesToDocument: !!s.themeAppliesToDocument,
    // Default-on (modern): only an explicit `'classic'` reverts to the
    // original emoji/text glyphs (survives upgrades from before this existed).
    iconSet: s.iconSet === 'classic' ? 'classic' : 'modern',
    showDocNameChip: !!s.showDocNameChip,
    showUndoRedoButtons: !!s.showUndoRedoButtons,
    checkForUpdatesOnLaunch: !!s.checkForUpdatesOnLaunch,
    updateChecksPausedUntil:
      Number.isFinite(Number(s.updateChecksPausedUntil)) && Number(s.updateChecksPausedUntil) > 0
        ? Math.floor(Number(s.updateChecksPausedUntil))
        : 0,
    commentsColumnWidth:
      typeof s.commentsColumnWidth === 'number' && Number.isFinite(s.commentsColumnWidth)
        ? Math.max(240, Math.min(560, s.commentsColumnWidth))
        : 320,
    reduceMotion:
      s.reduceMotion === 'on' || s.reduceMotion === 'off' ? s.reduceMotion : 'auto',
    disableCursorBlink: s.disableCursorBlink === true,
    accessibilityTreeEnabled: s.accessibilityTreeEnabled === true,
    flowHostOnLaunch: s.flowHostOnLaunch === true,
    externalInsertPolicy:
      s.externalInsertPolicy === 'off' || s.externalInsertPolicy === 'open'
        ? s.externalInsertPolicy
        : 'ask',
    externalAppConsents: sanitizeExternalAppConsents(s.externalAppConsents),
    overrideHighlightColor: !!s.overrideHighlightColor,
    overrideHighlightSlots: sanitizeColorSlots(
      s.overrideHighlightSlots,
      (s as { overrideHighlightColorValue?: unknown }).overrideHighlightColorValue,
      '#ffff00',
    ),
    overrideShadingColor: !!s.overrideShadingColor,
    showCursorColorNames: !!s.showCursorColorNames,
    colorVisionFriendly: !!s.colorVisionFriendly,
    annotationShapes: !!s.annotationShapes,
    distinguishShading: !!s.distinguishShading,
    navAnalyticItalics: !!s.navAnalyticItalics,
    unboldCites: !!s.unboldCites,
    overrideShadingSlots: sanitizeColorSlots(
      s.overrideShadingSlots,
      (s as { overrideShadingColorValue?: unknown }).overrideShadingColorValue,
      '#d2d2d2',
    ),
    customColorOverrides: sanitizeCustomColorOverrides(s.customColorOverrides),
    // navPaneVisible defaults to TRUE when missing — the user
    // opens to an outline-visible window unless they've already
    // dismissed it during the session (transient — see
    // TRANSIENT_SETTING_KEYS).
    navPaneVisible: s.navPaneVisible === false ? false : true,
    // Default-on: only an explicit `false` disables it.
    formatNavPaneByType: s.formatNavPaneByType === false ? false : true,
    timerProfile:
      s.timerProfile === 'highSchool' || s.timerProfile === 'pomodoro'
        ? s.timerProfile
        : 'college',
    timerProfiles: sanitizeTimerProfiles(s.timerProfiles),
    timerSpeechPresets: sanitizeSpeechPresets(s.timerSpeechPresets, [3, 6, 9, 12]),
    timerShowFourthPreset: !!s.timerShowFourthPreset,
    timerPrepMinutes:
      typeof s.timerPrepMinutes === 'number' && s.timerPrepMinutes > 0 && s.timerPrepMinutes <= 99
        ? Math.floor(s.timerPrepMinutes)
        : 10,
    timerFlashEnabled: s.timerFlashEnabled === false ? false : true,
    timerFlashSeconds: sanitizeFlashSeconds(s.timerFlashSeconds),
    timerSoundEnabled: s.timerSoundEnabled === true,
    timerSoundVolume:
      typeof s.timerSoundVolume === 'number' && Number.isFinite(s.timerSoundVolume)
        ? Math.min(100, Math.max(0, Math.round(s.timerSoundVolume)))
        : 70,
    timerCompact: !!s.timerCompact,
    timerPrepLabel:
      s.timerPrepLabel === 'text' || s.timerPrepLabel === 'color'
        ? s.timerPrepLabel
        : 'both',
    timerPosition: s.timerPosition === 'right' ? 'right' : 'left',
    jumpToDocTopOnReadModeToggle: !!s.jumpToDocTopOnReadModeToggle,
    findResultsExpanded: !!s.findResultsExpanded,
    findRememberLastQuery:
      s.findRememberLastQuery === true ? true : false,
    findLastQuery:
      typeof s.findLastQuery === 'string'
        ? s.findLastQuery.slice(0, 1024)
        : '',
    findCategoryOrder: sanitizeFindCategoryOrder(s.findCategoryOrder),
    includeSpeechDocPocket:
      s.includeSpeechDocPocket === false ? false : true,
    showCitePreview: !!s.showCitePreview,
    showCardNumbering: s.showCardNumbering === false ? false : true,
    showNumberingButtons: s.showNumberingButtons === false ? false : true,
    cardNumberingFormat: NUMBERING_SEPARATORS.includes(
      s.cardNumberingFormat as NumberingSeparator,
    )
      ? (s.cardNumberingFormat as NumberingSeparator)
      : 'period',
    cardNumberingSubFormat: NUMBERING_SEPARATORS.includes(
      s.cardNumberingSubFormat as NumberingSeparator,
    )
      ? (s.cardNumberingSubFormat as NumberingSeparator)
      : 'period',
    cardNumberingSubCapitalized: !!s.cardNumberingSubCapitalized,
    cardNumberingSubBold: s.cardNumberingSubBold === false ? false : true,
    cardNumberingIndent:
      s.cardNumberingIndent === 'tag' || s.cardNumberingIndent === 'card'
        ? s.cardNumberingIndent
        : 'off',
    cardNumberingSubIndent:
      s.cardNumberingSubIndent === 'tag' || s.cardNumberingSubIndent === 'card'
        ? s.cardNumberingSubIndent
        : 'off',
    cardNumberingMatchHeadingColor: !!s.cardNumberingMatchHeadingColor,
    flashcardDueDot: s.flashcardDueDot === false ? false : true,
    editorSpellcheck: !!s.editorSpellcheck,
    copyPreviousCiteNearestOnly: s.copyPreviousCiteNearestOnly === false ? false : true,
    smartQuotes: !!s.smartQuotes,
    autoCapitalizeSentences: !!s.autoCapitalizeSentences,
    customAutocorrectEnabled: !!s.customAutocorrectEnabled,
    customAutocorrects: sanitizeCustomAutocorrects(s.customAutocorrects),
    customDashEnabled: !!s.customDashEnabled,
    enterAfterPocket: sanitizeEnterAfter(s.enterAfterPocket),
    enterAfterHat: sanitizeEnterAfter(s.enterAfterHat),
    enterAfterBlock: sanitizeEnterAfter(s.enterAfterBlock),
    enterAfterTag: sanitizeEnterAfter(s.enterAfterTag),
    enterAfterAnalytic: sanitizeEnterAfter(s.enterAfterAnalytic),
    enterAfterUndertag: sanitizeEnterAfter(s.enterAfterUndertag),
    customDashStyle: CUSTOM_DASH_STYLES.includes(s.customDashStyle as Settings['customDashStyle'])
      ? (s.customDashStyle as Settings['customDashStyle'])
      : 'em',
    customDashTrigger: s.customDashTrigger === '--' ? '--' : '---',
    voiceInputDeviceId: typeof s.voiceInputDeviceId === 'string' ? s.voiceInputDeviceId : '',
    voiceAutoSleepSeconds:
      typeof s.voiceAutoSleepSeconds === 'number' && s.voiceAutoSleepSeconds >= 0
        ? Math.round(s.voiceAutoSleepSeconds)
        : 60,
    voiceDashStyle: VOICE_DASH_STYLES.includes(s.voiceDashStyle as Settings['voiceDashStyle'])
      ? (s.voiceDashStyle as Settings['voiceDashStyle'])
      : 'em',
    voiceDictationModel: s.voiceDictationModel === 'large' ? 'large' : 'standard',
    autosaveEnabled: !!s.autosaveEnabled,
    readMode: !!s.readMode,
    hideEmphasisBordersInReadMode: !!s.hideEmphasisBordersInReadMode,
    readModeParagraphIntegrity: !!s.readModeParagraphIntegrity,
    markUnreadAfterMarker: !!s.markUnreadAfterMarker,
    // A legacy persisted `zoomPct` is deliberately ignored — live body
    // zoom is transient; documents open at this default.
    defaultZoomPct: clamp(Math.round(s.defaultZoomPct / 10) * 10, ZOOM_MIN_PCT, ZOOM_MAX_PCT),
    chromeScalePct: clamp(Math.round(s.chromeScalePct / 10) * 10, CHROME_SCALE_MIN_PCT, CHROME_SCALE_MAX_PCT),
    gestureZoom: !!s.gestureZoom,
    readers: sanitizeReaders(s.readers),
    liveSelectionWordCount: s.liveSelectionWordCount === true,
    // Default-on: preserve `false` only when explicitly set, so
    // installs upgrading from before this setting existed get it on.
    liveContainerReadTime: s.liveContainerReadTime === false ? false : true,
    liveRemainingReadTime: s.liveRemainingReadTime === true,
    displaySizes: sanitizeDisplaySizes(s.displaySizes),
    displayParagraphSpacing: sanitizeParagraphSpacing(s.displayParagraphSpacing),
    displayTypography: sanitizeDisplayTypography(s.displayTypography),
    styleAlignments: sanitizeStyleAlignments(s.styleAlignments),
    maxTextWidthPx:
      Number.isFinite(s.maxTextWidthPx) && s.maxTextWidthPx > 0
        ? clamp(Math.round(s.maxTextWidthPx), 400, 3000)
        : 0,
    maxTextWidthAlign:
      s.maxTextWidthAlign === 'left' || s.maxTextWidthAlign === 'right'
        ? s.maxTextWidthAlign
        : 'center',
    displayColors: sanitizeDisplayColors(s.displayColors, s.customColorOverrides),
    bodyFont: sanitizeBodyFont(s.bodyFont),
    uiFont: sanitizeUiFont(s.uiFont),
    ribbonTooltipMode: sanitizeRibbonTooltipMode(s.ribbonTooltipMode),
    showDropzonePill: s.showDropzonePill === true,
    showQuickCardButtons: s.showQuickCardButtons === true,
    fileSearchRoots: sanitizeFileSearchRoots(s),
    fileSearchExclusions: sanitizeStringList(
      (s as { fileSearchExclusions?: unknown }).fileSearchExclusions,
    ),
    fileSearchFormats:
      s.fileSearchFormats === 'cmir'
        ? 'cmir'
        : s.fileSearchFormats === 'docx'
          ? 'docx'
          : 'both',
    fileSearchObjectTypes: sanitizeFileObjectTypes(s.fileSearchObjectTypes),
    fileSearchOutlineDepth: Number.isFinite(s.fileSearchOutlineDepth)
      ? clamp(Math.round(s.fileSearchOutlineDepth), 1, 4)
      : 3,
    fileSearchTiebreak: s.fileSearchTiebreak === 'alphabetical' ? 'alphabetical' : 'recency',
    pinAutoEnabled: s.pinAutoEnabled === false ? false : true,
    lineHeight: sanitizeLineHeight(s.lineHeight, DEFAULTS.lineHeight),
    lineHeightCite: sanitizeLineHeight(s.lineHeightCite, DEFAULTS.lineHeightCite),
    lineHeightTag: sanitizeLineHeight(s.lineHeightTag, DEFAULTS.lineHeightTag),
    lineHeightAnalytic: sanitizeLineHeight(s.lineHeightAnalytic, DEFAULTS.lineHeightAnalytic),
    lineHeightHeading: sanitizeLineHeight(s.lineHeightHeading, DEFAULTS.lineHeightHeading),
    lineHeightUndertag: sanitizeLineHeight(s.lineHeightUndertag, DEFAULTS.lineHeightUndertag),
    formattingPanelMode: FORMATTING_PANEL_MODES.includes(s.formattingPanelMode as FormattingPanelMode)
      ? (s.formattingPanelMode as FormattingPanelMode)
      : DEFAULTS.formattingPanelMode,
    formattingPanelPreview:
      s.formattingPanelPreview === undefined
        ? DEFAULTS.formattingPanelPreview
        : !!s.formattingPanelPreview,
    showCharacterStyles:
      s.showCharacterStyles === undefined
        ? DEFAULTS.showCharacterStyles
        : !!s.showCharacterStyles,
    lastHighlightColor:
      s.lastHighlightColor === null
        ? null
        : isWordHighlightName(String(s.lastHighlightColor ?? ''))
        ? String(s.lastHighlightColor)
        : DEFAULTS.lastHighlightColor,
    lastShadingColor:
      s.lastShadingColor === null
        ? null
        : isHex6(s.lastShadingColor)
        ? String(s.lastShadingColor).toUpperCase()
        : DEFAULTS.lastShadingColor,
    lastFontColor:
      s.lastFontColor === null || s.lastFontColor === undefined
        ? DEFAULTS.lastFontColor
        : isHex6(s.lastFontColor)
        ? String(s.lastFontColor).toUpperCase()
        : DEFAULTS.lastFontColor,
    paragraphIntegrity:
      s.paragraphIntegrity === undefined
        ? DEFAULTS.paragraphIntegrity
        : !!s.paragraphIntegrity,
    usePilcrows:
      s.usePilcrows === undefined
        ? DEFAULTS.usePilcrows
        : !!s.usePilcrows,
    extractUndertagInQuotes: !!s.extractUndertagInQuotes,
    headingMode: HEADING_MODES.includes(s.headingMode as HeadingMode)
      ? (s.headingMode as HeadingMode)
      : DEFAULTS.headingMode,
    condenseOnPaste:
      s.condenseOnPaste === undefined
        ? DEFAULTS.condenseOnPaste
        : !!s.condenseOnPaste,
    smartPasteConversion: s.smartPasteConversion === false ? false : true,
    pasteCursor: s.pasteCursor === 'tag' ? 'tag' : 'after',
    versionHistory:
      s.versionHistory === 'off' ||
      s.versionHistory === 'extended' ||
      s.versionHistory === 'custom'
        ? s.versionHistory
        : 'standard',
    versionHistoryDocCapMb:
      typeof s.versionHistoryDocCapMb === 'number' && Number.isFinite(s.versionHistoryDocCapMb)
        ? Math.min(1_048_576, Math.max(0, Math.round(s.versionHistoryDocCapMb)))
        : DEFAULTS.versionHistoryDocCapMb,
    versionHistoryTotalCapMb:
      typeof s.versionHistoryTotalCapMb === 'number' && Number.isFinite(s.versionHistoryTotalCapMb)
        ? Math.min(1_048_576, Math.max(0, Math.round(s.versionHistoryTotalCapMb)))
        : DEFAULTS.versionHistoryTotalCapMb,
    formattingGapClass: FORMATTING_GAP_CLASSES.includes(
      s.formattingGapClass as FormattingGapClass,
    )
      ? (s.formattingGapClass as FormattingGapClass)
      : DEFAULTS.formattingGapClass,
    autoBridgeFormattingGaps:
      s.autoBridgeFormattingGaps === undefined
        ? DEFAULTS.autoBridgeFormattingGaps
        : !!s.autoBridgeFormattingGaps,
    clearFormattingOnNamedStyleToggleOff:
      s.clearFormattingOnNamedStyleToggleOff === undefined
        ? DEFAULTS.clearFormattingOnNamedStyleToggleOff
        : !!s.clearFormattingOnNamedStyleToggleOff,
    standardizeHighlightException: isWordHighlightName(
      String(s.standardizeHighlightException ?? ''),
    )
      ? String(s.standardizeHighlightException)
      : DEFAULTS.standardizeHighlightException,
    standardizeShadingException: isHex6(s.standardizeShadingException)
      ? String(s.standardizeShadingException).toUpperCase()
      : DEFAULTS.standardizeShadingException,
    forReferenceUseGray50:
      s.forReferenceUseGray50 === undefined
        ? DEFAULTS.forReferenceUseGray50
        : !!s.forReferenceUseGray50,
    createReferenceIncludeHeading:
      s.createReferenceIncludeHeading === undefined
        ? DEFAULTS.createReferenceIncludeHeading
        : !!s.createReferenceIncludeHeading,
    createReferenceDelimiter: CREATE_REFERENCE_DELIMITERS.includes(
      s.createReferenceDelimiter as CreateReferenceDelimiter,
    )
      ? (s.createReferenceDelimiter as CreateReferenceDelimiter)
      : DEFAULTS.createReferenceDelimiter,
    createReferenceIncludeCite:
      s.createReferenceIncludeCite === undefined
        ? DEFAULTS.createReferenceIncludeCite
        : !!s.createReferenceIncludeCite,
    createReferenceCustomHeading:
      typeof s.createReferenceCustomHeading === 'string'
        ? s.createReferenceCustomHeading
        : DEFAULTS.createReferenceCustomHeading,
    createReferenceHeadingBold:
      s.createReferenceHeadingBold === undefined
        ? DEFAULTS.createReferenceHeadingBold
        : !!s.createReferenceHeadingBold,
    createReferenceHeadingItalic:
      s.createReferenceHeadingItalic === undefined
        ? DEFAULTS.createReferenceHeadingItalic
        : !!s.createReferenceHeadingItalic,
    createReferenceHeadingEmphasized:
      s.createReferenceHeadingEmphasized === undefined
        ? DEFAULTS.createReferenceHeadingEmphasized
        : !!s.createReferenceHeadingEmphasized,
    createReferenceHeadingUnderlined:
      s.createReferenceHeadingUnderlined === undefined
        ? DEFAULTS.createReferenceHeadingUnderlined
        : !!s.createReferenceHeadingUnderlined,
    createReferenceShrinks:
      s.createReferenceShrinks === undefined
        ? DEFAULTS.createReferenceShrinks
        : !!s.createReferenceShrinks,
    createReferenceShrinkPt: Number.isFinite(Number(s.createReferenceShrinkPt))
      ? Math.min(20, Math.max(1, Math.round(Number(s.createReferenceShrinkPt))))
      : DEFAULTS.createReferenceShrinkPt,
    createReferenceHighlightMode: CREATE_REFERENCE_HIGHLIGHT_MODES.includes(
      s.createReferenceHighlightMode as CreateReferenceHighlightMode,
    )
      ? (s.createReferenceHighlightMode as CreateReferenceHighlightMode)
      : DEFAULTS.createReferenceHighlightMode,
    shrinkRestoresOmissionsToNormal:
      s.shrinkRestoresOmissionsToNormal === undefined
        ? DEFAULTS.shrinkRestoresOmissionsToNormal
        : !!s.shrinkRestoresOmissionsToNormal,
    condenseWarningDelimiter: CONDENSE_WARNING_DELIMITERS.includes(
      s.condenseWarningDelimiter as CondenseWarningDelimiter,
    )
      ? (s.condenseWarningDelimiter as CondenseWarningDelimiter)
      : DEFAULTS.condenseWarningDelimiter,
    condenseWarningCustomPauseMarker:
      typeof s.condenseWarningCustomPauseMarker === 'string'
        ? s.condenseWarningCustomPauseMarker
        : DEFAULTS.condenseWarningCustomPauseMarker,
    condenseWarningCustomResumeMarker:
      typeof s.condenseWarningCustomResumeMarker === 'string'
        ? s.condenseWarningCustomResumeMarker
        : DEFAULTS.condenseWarningCustomResumeMarker,
    shrinkCustomProtections: sanitizeShrinkProtections(s.shrinkCustomProtections),
    acronymPatterns: Array.isArray(s.acronymPatterns)
      ? (s.acronymPatterns as unknown[])
          .map(sanitizeAcronymPattern)
          .filter((p): p is AcronymPattern => p !== null)
      : DEFAULTS.acronymPatterns,
    ribbonKeyOverrides: sanitizeRibbonKeyOverrides(s.ribbonKeyOverrides),
    ribbonCustomButtons: sanitizeRibbonCustomButtons(s.ribbonCustomButtons),
    keyboardMacros: sanitizeKeyboardMacros(s.keyboardMacros),
    commentAuthor:
      typeof s.commentAuthor === 'string' && s.commentAuthor.length > 0
        ? s.commentAuthor
        : DEFAULTS.commentAuthor,
    commentAuthorInitials:
      typeof s.commentAuthorInitials === 'string'
        ? s.commentAuthorInitials
        : DEFAULTS.commentAuthorInitials,
    commentsVisible: !!s.commentsVisible,
    anthropicApiKey:
      typeof s.anthropicApiKey === 'string'
        ? s.anthropicApiKey
        : DEFAULTS.anthropicApiKey,
    aiModelOverride: typeof s.aiModelOverride === 'string' ? s.aiModelOverride.trim() : '',
    aiProvider: s.aiProvider === 'openrouter' ? 'openrouter' : 'anthropic',
    openrouterApiKey:
      typeof s.openrouterApiKey === 'string' ? s.openrouterApiKey : DEFAULTS.openrouterApiKey,
    openrouterModel: typeof s.openrouterModel === 'string' ? s.openrouterModel.trim() : '',
    aiMaxTokens:
      typeof s.aiMaxTokens === 'number' && Number.isFinite(s.aiMaxTokens)
        ? Math.max(1024, Math.round(s.aiMaxTokens))
        : DEFAULTS.aiMaxTokens,
    aiFeaturesEnabled: !isLiteBuild() && !!s.aiFeaturesEnabled,
    clodEnabled: !!s.clodEnabled,
    clodActivitiesByTime: sanitizeClodActivitiesByTime(s.clodActivitiesByTime),
    clodTimePeriods: sanitizeClodTimePeriods(s.clodTimePeriods),
    aiPersonaName:
      typeof s.aiPersonaName === 'string' && s.aiPersonaName.trim()
        ? s.aiPersonaName.trim()
        : DEFAULTS.aiPersonaName,
    aiPersonaPronouns: ['he', 'she', 'they', 'it', 'custom'].includes(s.aiPersonaPronouns as string)
      ? (s.aiPersonaPronouns as Settings['aiPersonaPronouns'])
      : DEFAULTS.aiPersonaPronouns,
    aiPersonaCustomPronouns: sanitizeCustomPronouns(s.aiPersonaCustomPronouns),
    aiCitePrompt:
      typeof s.aiCitePrompt === 'string' ? s.aiCitePrompt : DEFAULTS.aiCitePrompt,
    translationProvider: (['auto', 'mymemory', 'anthropic', 'google'] as const).includes(
      s.translationProvider as Settings['translationProvider'],
    )
      ? (s.translationProvider as Settings['translationProvider'])
      : DEFAULTS.translationProvider,
    translationTargetLang:
      typeof s.translationTargetLang === 'string' && s.translationTargetLang.trim()
        ? s.translationTargetLang.trim().toLowerCase()
        : DEFAULTS.translationTargetLang,
    translationSourceLang:
      typeof s.translationSourceLang === 'string' && s.translationSourceLang.trim()
        ? s.translationSourceLang.trim().toLowerCase()
        : DEFAULTS.translationSourceLang,
    myMemoryEmail: typeof s.myMemoryEmail === 'string' ? s.myMemoryEmail.trim() : '',
    googleTranslateApiKey:
      typeof s.googleTranslateApiKey === 'string' ? s.googleTranslateApiKey.trim() : '',
    prependTranslationMarker: s.prependTranslationMarker === false ? false : true,
    multiDocWorkspace: !!s.multiDocWorkspace,
    mobileLayout:
      s.mobileLayout === 'mobile' || s.mobileLayout === 'desktop'
        ? s.mobileLayout
        : DEFAULTS.mobileLayout,
    multiDocLayoutMode:
      s.multiDocLayoutMode === 'wide' || s.multiDocLayoutMode === 'compact'
        ? s.multiDocLayoutMode
        : DEFAULTS.multiDocLayoutMode,
    quickCardActiveTags: Array.isArray(s.quickCardActiveTags)
      ? s.quickCardActiveTags.filter((t): t is string => typeof t === 'string')
      : [],
    cardCutterEnabled: s.cardCutterEnabled === true,
    cardCutterEnginePath:
      typeof s.cardCutterEnginePath === 'string' ? s.cardCutterEnginePath : '',
    // Fixed at 'voice' regardless of any persisted legacy choice — the
    // variant UI is gone; see the model comment.
    cardCutterEmphasisStyle: 'voice',
    cardCutterReadTimeSec:
      typeof s.cardCutterReadTimeSec === 'number' && s.cardCutterReadTimeSec > 0
        ? Math.min(120, Math.max(3, Math.round(s.cardCutterReadTimeSec)))
        : DEFAULTS.cardCutterReadTimeSec,

    pluginsEnabled: !isLiteBuild() && s.pluginsEnabled === true,
    pluginCommunityInstalls: s.pluginCommunityInstalls === true,
    pairingEnabled: !isLiteBuild() && s.pairingEnabled === true,
    pairingConnectedUntil: Number.isFinite(Number(s.pairingConnectedUntil))
      ? Math.max(0, Number(s.pairingConnectedUntil))
      : DEFAULTS.pairingConnectedUntil,
    pairingRelayUrl:
      typeof s.pairingRelayUrl === 'string' ? s.pairingRelayUrl : DEFAULTS.pairingRelayUrl,
    pairingRelayToken:
      typeof s.pairingRelayToken === 'string' ? s.pairingRelayToken : DEFAULTS.pairingRelayToken,
    pairingPollSeconds: Number.isFinite(Number(s.pairingPollSeconds))
      ? clamp(Math.round(Number(s.pairingPollSeconds)), 5, 3600)
      : 30,
    pairingOwnCode: typeof s.pairingOwnCode === 'string' ? s.pairingOwnCode.trim() : '',
    pairingDisplayName:
      typeof s.pairingDisplayName === 'string' ? s.pairingDisplayName.trim().slice(0, 80) : '',
    collabShowCursors: s.collabShowCursors !== false,
    pairingPartners: sanitizePairingPartners(s.pairingPartners),
    pairingGroups: sanitizePairingGroups(s.pairingGroups, s.pairingPartners),
    pairingBlockedCodes: Array.isArray(s.pairingBlockedCodes)
      ? Array.from(
          new Set(
            s.pairingBlockedCodes
              .filter((x): x is string => typeof x === 'string')
              // Match the normalization the sender code goes through
              // (trim + strip all internal whitespace) so a pasted code
              // compares equal to the one stamped on an inbox item.
              .map((x) => x.trim().replace(/\s+/g, ''))
              .filter((x) => x.length > 0),
          ),
        )
      : [],
    pairingStarred: sanitizePairingStarred(s.pairingStarred, s.pairingPartners, s.pairingGroups),
    pairingReceiveFlash: PAIRING_RECEIVE_FLASHES.includes(s.pairingReceiveFlash)
      ? s.pairingReceiveFlash
      : 'once',
    cleanProtectedStyles: Array.isArray(s.cleanProtectedStyles)
      ? Array.from(
          new Set(
            s.cleanProtectedStyles
              .filter((x): x is string => typeof x === 'string')
              .map((x) => x.trim())
              .filter((x) => x.length > 0),
          ),
        )
      : [],
  };
}

/** Coerce an arbitrary value into a clean string list: strings only,
 *  trimmed, empties dropped, de-duplicated. Non-arrays become []. */
function sanitizeStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const t = item.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** Coerce the file-search folders, migrating the pre-multi-folder single
 *  `fileSearchRoot` string. Trims, drops empties, de-duplicates. */
function sanitizeFileSearchRoots(s: Settings): string[] {
  const raw = s as { fileSearchRoots?: unknown; fileSearchRoot?: unknown };
  const list = Array.isArray(raw.fileSearchRoots)
    ? raw.fileSearchRoots
    : typeof raw.fileSearchRoot === 'string' && raw.fileSearchRoot
      ? [raw.fileSearchRoot]
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const t = item.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** Validate + clamp the 1–3-color slots arrays used by the
 *  highlight / shading display overrides. Accepts hex or
 *  rgba/rgb strings. Migrates from the previous single-color
 *  field (`overrideHighlightColorValue` / `overrideShadingColorValue`)
 *  when the new array is absent. Always returns at least one
 *  entry — `defaultValue` if everything else is missing. */
function sanitizeColorSlots(
  raw: unknown,
  legacy: unknown,
  defaultValue: string,
): string[] {
  const isColor = (v: unknown): v is string =>
    typeof v === 'string' &&
    (
      /^#[0-9a-fA-F]{6}$/.test(v.trim()) ||
      /^rgba?\(/.test(v.trim())
    );
  if (Array.isArray(raw)) {
    const out: string[] = [];
    for (const v of raw) {
      if (isColor(v)) out.push(v.trim());
      if (out.length >= 3) break;
    }
    if (out.length > 0) return out;
  }
  // Migration: pre-multi-slot installs had a single color stored
  // in `overrideHighlightColorValue` / `overrideShadingColorValue`.
  // Copy it into slot 0 if present.
  if (isColor(legacy)) return [legacy.trim()];
  return [defaultValue];
}

/** Filter a Record<string, string> against the registered list of
 *  customizable color tokens. Keeps entries whose key matches a
 *  known token and whose value is a non-empty string (CSS silently
 *  rejects malformed values when applied). Used to scrub the
 *  persisted `customColorOverrides` blob. */
function sanitizeCustomColorOverrides(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const known = new Set(CUSTOMIZABLE_COLOR_TOKENS.map((t) => t.name));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(k)) continue;
    // Document-text colors are backed by `displayColors`; legacy
    // values migrate there (see `sanitizeDisplayColors`) and must not
    // linger here, or `applyCustomColorOverrides` would re-clobber
    // the `displayColors` write.
    if (k in DISPLAY_COLOR_TOKEN_TO_KEY) continue;
    if (typeof v !== 'string' || v.trim() === '') continue;
    out[k] = v.trim();
  }
  return out;
}

/** Manifest of color tokens the user can override via the
 *  accessibility panel. Keys are CSS-variable names without the
 *  `--` prefix; labels are human-readable; groups cluster the UI
 *  into sections. Defaults come from the cascade at runtime
 *  (`getComputedStyle`) so the manifest stays in sync with
 *  style.css without duplicating values here.
 *
 *  To add a new override, append an entry; to remove one, delete
 *  the entry (existing user overrides for that token will be
 *  dropped by `sanitizeCustomColorOverrides` on next load). */
export interface CustomizableColorToken {
  name: string;
  label: string;
  group: string;
}
export const CUSTOMIZABLE_COLOR_TOKENS: readonly CustomizableColorToken[] = [
  // Surface
  { group: 'Surface', name: 'pmd-c-bg', label: 'Background (page / panels / buttons)' },
  { group: 'Surface', name: 'pmd-c-bg-soft', label: 'Off-white row background' },
  { group: 'Surface', name: 'pmd-c-surface', label: 'Chrome surface (ribbon / status bar)' },
  { group: 'Surface', name: 'pmd-c-surface-soft', label: 'Soft surface (nav header)' },
  { group: 'Surface', name: 'pmd-c-surface-alt', label: 'Alt surface (editor viewport / code)' },
  { group: 'Surface', name: 'pmd-c-overlay', label: 'Modal scrim' },

  // Borders
  { group: 'Borders', name: 'pmd-c-border', label: 'Button border' },
  { group: 'Borders', name: 'pmd-c-border-soft', label: 'Chrome border (ribbon, nav)' },
  { group: 'Borders', name: 'pmd-c-divider', label: 'Divider' },
  { group: 'Borders', name: 'pmd-c-divider-faint', label: 'Faint divider' },

  // Text
  { group: 'Text', name: 'pmd-c-text', label: 'Body text' },
  { group: 'Text', name: 'pmd-c-text-strong', label: 'Strong text (max contrast)' },
  { group: 'Text', name: 'pmd-c-text-secondary', label: 'Secondary text' },
  { group: 'Text', name: 'pmd-c-text-muted', label: 'Muted text' },
  { group: 'Text', name: 'pmd-c-text-faint', label: 'Faint text' },
  { group: 'Text', name: 'pmd-c-text-on-accent', label: 'Text on accent surface' },

  // Hover / press
  { group: 'Interaction', name: 'pmd-c-hover', label: 'Hover background' },
  { group: 'Interaction', name: 'pmd-c-hover-strong', label: 'Selected / pressed background' },

  // Accent
  { group: 'Accent', name: 'pmd-c-accent', label: 'Accent (primary)' },
  { group: 'Accent', name: 'pmd-c-accent-hover', label: 'Accent hover' },
  { group: 'Accent', name: 'pmd-c-accent-soft', label: 'Accent tint' },
  { group: 'Accent', name: 'pmd-c-focus', label: 'Focus ring' },

  // Status
  { group: 'Status', name: 'pmd-c-success', label: 'Success' },
  { group: 'Status', name: 'pmd-c-warning', label: 'Warning' },
  { group: 'Status', name: 'pmd-c-error', label: 'Error' },
  { group: 'Status', name: 'pmd-c-danger', label: 'Danger (close)' },

  // Drop / drag
  { group: 'Drag affordances', name: 'pmd-c-drop', label: 'Drop indicator' },
  { group: 'Drag affordances', name: 'pmd-c-drop-soft', label: 'Drop indicator (soft)' },
  { group: 'Drag affordances', name: 'pmd-c-drop-mid', label: 'Drop indicator (mid)' },

  // Speech-doc
  { group: 'Speech doc', name: 'pmd-c-speech-bg', label: 'Speech-doc band background' },
  { group: 'Speech doc', name: 'pmd-c-speech-border', label: 'Speech-doc band border' },
  { group: 'Speech doc', name: 'pmd-c-speech-text', label: 'Speech-doc band text' },

  // Editor decorations
  { group: 'Editor', name: 'pmd-c-card-hover', label: 'Card hover indicator' },
  { group: 'Editor', name: 'pmd-c-emphasis-box', label: 'Emphasis box border' },
  { group: 'Editor', name: 'pmd-c-highlight-default', label: 'New-highlight default color' },

  // Per-style document colors. These are reachable here too, but
  // they're BACKED BY `displayColors` (Appearance → Style colors),
  // not `customColorOverrides` — see DISPLAY_COLOR_TOKEN_TO_KEY. The
  // Accessibility rows for them read / write displayColors so the two
  // pickers stay linked to one value.
  { group: 'Document text', name: 'pmd-color-analytic', label: 'Analytic text' },
  { group: 'Document text', name: 'pmd-color-undertag', label: 'Undertag text' },
  { group: 'Document text', name: 'pmd-color-reading-marker', label: 'Reading marker & unread text' },

  // Live-zone chrome — also backed by displayColors (linked to the Appearance
  // Style-colors picker), grouped apart from document text.
  { group: 'Linked copies', name: 'pmd-color-zone-diverged', label: 'Source-updated badge' },
  // ── Meaning-carrying hues, rebindable so colorblind users have
  //    direct recourse. The band foreground pair (band-fg-light/dark)
  //    is deliberately NOT here: text-on-band contrast only makes
  //    sense authored together with band rendering (preset territory),
  //    and a bad pick makes highlighted document text invisible.
  { group: 'Timer', name: 'pmd-c-aff', label: 'Prep timer: Aff' },
  { group: 'Timer', name: 'pmd-c-neg', label: 'Prep timer: Neg' },
  { group: 'Annotations', name: 'pmd-c-comment-thread', label: 'AI accent (comments + working indicator)' },
  { group: 'Annotations', name: 'pmd-c-note', label: 'Private note accent' },
  { group: 'Annotations', name: 'pmd-c-repair-accent', label: 'Paragraph repair accent' },
  { group: 'Annotations', name: 'pmd-c-transclusion', label: 'Live-zone rail' },
  { group: 'Editor', name: 'pmd-c-link', label: 'Hyperlink' },
  { group: 'Editor', name: 'pmd-c-spellcheck', label: 'Misspelling underline' },
  { group: 'Editor', name: 'pmd-c-card-number', label: 'Card numbering' },
  { group: 'Status', name: 'pmd-c-notify-dot', label: 'Due-date dot' },
  { group: 'Find matches', name: 'pmd-c-find-match', label: 'Match highlight' },
  { group: 'Find matches', name: 'pmd-c-find-match-current', label: 'Current match highlight' },
  { group: 'Category chips', name: 'pmd-c-cat-heading-bg', label: 'Heading chip background' },
  { group: 'Category chips', name: 'pmd-c-cat-heading-fg', label: 'Heading chip text' },
  { group: 'Category chips', name: 'pmd-c-cat-tag-bg', label: 'Tag chip background' },
  { group: 'Category chips', name: 'pmd-c-cat-tag-fg', label: 'Tag chip text' },
  { group: 'Category chips', name: 'pmd-c-cat-cite-bg', label: 'Cite chip background' },
  { group: 'Category chips', name: 'pmd-c-cat-cite-fg', label: 'Cite chip text' },
  { group: 'Category chips', name: 'pmd-c-cat-analytic-bg', label: 'Analytic chip background' },
  { group: 'Category chips', name: 'pmd-c-cat-analytic-fg', label: 'Analytic chip text' },
  { group: 'Category chips', name: 'pmd-c-cat-undertag-bg', label: 'Undertag chip background' },
  { group: 'Category chips', name: 'pmd-c-cat-undertag-fg', label: 'Undertag chip text' },
];

/** The CUSTOMIZABLE_COLOR_TOKENS whose value lives in `displayColors`
 *  (Appearance → Style colors) instead of `customColorOverrides`.
 *  Maps the CSS-var token name (no `--`) to its DisplayColors key.
 *  `applyDisplayColors` writes the user's pick to `--pmd-user-color-*`;
 *  style.css layers the theme on top (light/dark/apply-to-doc) and
 *  resolves `--pmd-color-*` from it. Both the Appearance and the
 *  Accessibility pickers read / write displayColors, so they're one
 *  linked value. */
export const DISPLAY_COLOR_TOKEN_TO_KEY: Readonly<Record<string, keyof DisplayColors>> = {
  'pmd-color-analytic': 'analytic',
  'pmd-color-undertag': 'undertag',
  'pmd-color-reading-marker': 'readingMarker',
  'pmd-color-zone-diverged': 'zoneDiverged',
};

/** Token names actually managed by `customColorOverrides` — every
 *  CUSTOMIZABLE_COLOR_TOKENS name EXCEPT the displayColors-backed ones.
 *  Passed to `applyCustomColorOverrides` so it never `removeProperty`s
 *  the document-text vars, which would wipe the `displayColors` write
 *  and leave the Appearance picker with no effect. */
export const CUSTOM_OVERRIDE_TOKEN_NAMES: readonly string[] = CUSTOMIZABLE_COLOR_TOKENS
  .filter((t) => !(t.name in DISPLAY_COLOR_TOKEN_TO_KEY))
  .map((t) => t.name);

/** Validate the timer's speech presets: four positive integer
 *  minutes. Fills missing / invalid entries with the fallback —
 *  which is how a stored 3-slot array (from before the fourth
 *  preset existed) gains its fourth slot on load. */
function sanitizeSpeechPresets(raw: unknown, fallback: number[]): number[] {
  const out = [...fallback];
  if (!Array.isArray(raw)) return out;
  for (let i = 0; i < 4; i++) {
    const v = raw[i];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 99) {
      out[i] = Math.floor(v);
    }
  }
  return out;
}

/** Validate the per-profile saved-config map. Each profile id
 *  gets a `{ speechPresets, prepMinutes }` object back; missing
 *  / malformed slots fall back to the profile's conventional
 *  defaults. */
function sanitizeTimerProfiles(
  raw: unknown,
): Settings['timerProfiles'] {
  const defaults: Settings['timerProfiles'] = {
    highSchool: { speechPresets: [3, 5, 8, 10], prepMinutes: 8 },
    college: { speechPresets: [3, 6, 9, 12], prepMinutes: 10 },
    pomodoro: { speechPresets: [25, 15, 5, 45], prepMinutes: 0 },
  };
  if (!raw || typeof raw !== 'object') return defaults;
  const src = raw as Record<string, unknown>;
  const out: Settings['timerProfiles'] = {
    highSchool: defaults.highSchool,
    college: defaults.college,
    pomodoro: defaults.pomodoro,
  };
  for (const id of ['highSchool', 'college', 'pomodoro'] as const) {
    const entry = src[id];
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    out[id] = {
      speechPresets: sanitizeSpeechPresets(e['speechPresets'], defaults[id].speechPresets),
      prepMinutes:
        typeof e['prepMinutes'] === 'number' &&
        e['prepMinutes'] >= 0 &&
        e['prepMinutes'] <= 99
          ? Math.floor(e['prepMinutes'])
          : defaults[id].prepMinutes,
    };
  }
  return out;
}

/** Validate a list of flash-threshold seconds. Filters to positive
 *  integers ≤ 3600 (1 hour); falls back to [5, 3, 1] if empty. */
function sanitizeFlashSeconds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [5, 3, 1];
  // Dedupe + sort descending (the order alerts will fire) + cap the
  // count — a hundred alert points is a config mistake, not a wish.
  const cleaned = [
    ...new Set(
      raw
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 3600)
        .map((v) => Math.floor(v)),
    ),
  ]
    .sort((a, b) => b - a)
    .slice(0, 12);
  return cleaned.length > 0 ? cleaned : [5, 3, 1];
}

function sanitizeFindCategoryOrder(
  raw: unknown,
): Settings['findCategoryOrder'] {
  // `valid` is also the canonical order — used to place any missing category.
  const valid: Settings['findCategoryOrder'] = [
    'heading',
    'tag',
    'analytic',
    'undertag',
    'cite',
    'other',
  ];
  if (!Array.isArray(raw)) return valid.slice();
  const seen = new Set<string>();
  const out: Settings['findCategoryOrder'] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    if (!valid.includes(v as Settings['findCategoryOrder'][number])) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v as Settings['findCategoryOrder'][number]);
  }
  // Insert any categories missing from `raw` at their CANONICAL position (right
  // after their predecessor in `valid`) rather than at the end — so a legacy save
  // that predates a newly-added category (e.g. `analytic`) places it where the
  // default would (analytic next to tag), not dumped last.
  for (let i = 0; i < valid.length; i++) {
    const c = valid[i]!;
    if (seen.has(c)) continue;
    let insertAt = out.length;
    for (let j = i - 1; j >= 0; j--) {
      const predIdx = out.indexOf(valid[j]!);
      if (predIdx >= 0) {
        insertAt = predIdx + 1;
        break;
      }
    }
    out.splice(insertAt, 0, c);
    seen.add(c);
  }
  return out;
}

function sanitizeCustomPronouns(raw: unknown): Settings['aiPersonaCustomPronouns'] {
  const out = { ...DEFAULTS.aiPersonaCustomPronouns };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Partial<Settings['aiPersonaCustomPronouns']>;
  for (const k of ['subject', 'object', 'possessive', 'reflexive'] as const) {
    const v = r[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

function sanitizeClodActivitiesByTime(raw: unknown): Settings['clodActivitiesByTime'] {
  const out = {
    morning: [] as string[],
    day: [] as string[],
    evening: [] as string[],
    night: [] as string[],
  };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Partial<Record<keyof typeof out, unknown>>;
  for (const k of ['morning', 'day', 'evening', 'night'] as const) {
    const v = r[k];
    if (Array.isArray(v)) {
      out[k] = v.filter((x): x is string => typeof x === 'string' && x.length > 0);
    }
  }
  return out;
}

function sanitizeClodTimePeriods(raw: unknown): Settings['clodTimePeriods'] {
  const out = { ...DEFAULTS.clodTimePeriods };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Partial<Record<keyof typeof out, unknown>>;
  for (const k of ['morning', 'day', 'evening', 'night'] as const) {
    const v = r[k];
    if (!v || typeof v !== 'object') continue;
    const obj = v as { start?: unknown; end?: unknown };
    const start = Number(obj.start);
    const end = Number(obj.end);
    if (
      Number.isInteger(start) && start >= 0 && start <= 23 &&
      Number.isInteger(end) && end >= 0 && end <= 23
    ) {
      out[k] = { start, end };
    }
  }
  return out;
}

/** Keep only recognized object-kind strings; default to block/tag/cite
 *  when the value is missing/garbage (but allow an explicit empty set). */
function sanitizeFileObjectTypes(raw: unknown): string[] {
  const known = ['pocket', 'hat', 'block', 'tag', 'cite', 'analytic'];
  if (!Array.isArray(raw)) return ['block', 'tag'];
  return [...new Set(raw.filter((x): x is string => typeof x === 'string' && known.includes(x)))];
}

function sanitizeShrinkProtections(raw: unknown): ShrinkProtection[] {
  if (!Array.isArray(raw)) return [];
  const out: ShrinkProtection[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const pattern = (r as ShrinkProtection).pattern;
    if (typeof pattern !== 'string') continue;
    out.push({ pattern, isRegex: !!(r as ShrinkProtection).isRegex });
  }
  return out;
}

/** Keep only string / string[] entries, coercing arrays to plain arrays
 *  of strings. Unknown keys pass through — we don't import the
 *  ribbon-command ID list here (it would create an import cycle), so
 *  any obsolete IDs from a future schema change have no effect at
 *  lookup time. */
function sanitizeRibbonKeyOverrides(
  raw: unknown,
): Partial<Record<string, string | string[]>> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Partial<Record<string, string | string[]>> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') {
      out[k] = v;
    } else if (Array.isArray(v)) {
      const cleaned = v.filter((x): x is string => typeof x === 'string');
      out[k] = cleaned;
    }
  }
  return out;
}

/** Keep well-formed `{ command, icon }` custom-button entries, capped at
 *  MAX_RIBBON_CUSTOM_BUTTONS. Command / icon are validated loosely (non-empty
 *  strings) — we don't import the ribbon-command id list or the icon set here
 *  (import cycle), so obsolete ids just don't render at build time. */
function sanitizeRibbonCustomButtons(raw: unknown): RibbonCustomButton[] {
  if (!Array.isArray(raw)) return [];
  const out: RibbonCustomButton[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const command = (e as { command?: unknown }).command;
    const icon = (e as { icon?: unknown }).icon;
    if (typeof command !== 'string' || !command.trim()) continue;
    if (typeof icon !== 'string' || !icon.trim()) continue;
    out.push({ command, icon: icon as IconName });
    if (out.length >= MAX_RIBBON_CUSTOM_BUTTONS) break;
  }
  return out;
}

/** Keep well-formed `{ id, decision, firstSeen, lastSeen }` external-app
 *  consent entries: valid app id, known decision, string timestamps.
 *  Deduped by id (first wins) and capped — the registry only ever grows
 *  by explicit user decisions, so 50 is generous. */
function sanitizeExternalAppConsents(raw: unknown): ExternalAppConsent[] {
  if (!Array.isArray(raw)) return [];
  const out: ExternalAppConsent[] = [];
  const seen = new Set<string>();
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const c = e as Partial<ExternalAppConsent>;
    if (typeof c.id !== 'string' || !EXTERNAL_APP_ID_RE.test(c.id) || seen.has(c.id)) continue;
    if (c.decision !== 'allow' && c.decision !== 'deny') continue;
    seen.add(c.id);
    out.push({
      id: c.id,
      decision: c.decision,
      firstSeen: typeof c.firstSeen === 'string' ? c.firstSeen : '',
      lastSeen: typeof c.lastSeen === 'string' ? c.lastSeen : '',
    });
    if (out.length >= 50) break;
  }
  return out;
}

/** Keep only well-formed `{ id, key, text }` macro entries. */
function sanitizeKeyboardMacros(raw: unknown): KeyboardMacro[] {
  if (!Array.isArray(raw)) return [];
  const out: KeyboardMacro[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const m = r as Partial<KeyboardMacro>;
    if (typeof m.id !== 'string') continue;
    out.push({
      id: m.id,
      key: typeof m.key === 'string' ? m.key : '',
      text: typeof m.text === 'string' ? m.text : '',
    });
  }
  return out;
}

function sanitizeLineHeight(raw: unknown, fallback: number): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
  // Round to 0.05 steps; clamp to [1.0, 2.0] — the input UI uses the
  // same step / range.
  return clamp(Math.round(n * 20) / 20, 1.0, 2.0);
}

function sanitizeBodyFont(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULTS.bodyFont;
  // Strip any quotes or commas — bodyFont must be a single font-family
  // name. Values persisted by builds that accepted free-form input may
  // contain `"Calibri", sans-serif` or similar.
  const cleaned = raw.replace(/["',]/g, '').trim();
  return cleaned || DEFAULTS.bodyFont;
}

function sanitizeUiFont(raw: unknown): string {
  // uiFont is `''` by default (= use the stylesheet's system-UI
  // default). Any other value must be a single family name; same
  // quote / comma stripping as `sanitizeBodyFont`.
  if (typeof raw !== 'string') return DEFAULTS.uiFont;
  return raw.replace(/["',]/g, '').trim();
}

function sanitizeRibbonTooltipMode(
  raw: unknown,
): 'none' | 'tooltip' | 'shortcut' | 'both' {
  if (raw === 'none' || raw === 'tooltip' || raw === 'shortcut' || raw === 'both') {
    return raw;
  }
  return DEFAULTS.ribbonTooltipMode;
}

function sanitizeStyleAlignments(raw: unknown): StyleAlignments {
  const out = { ...DEFAULT_STYLE_ALIGNMENTS };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Partial<Record<keyof StyleAlignments, unknown>>;
  for (const key of Object.keys(out) as (keyof StyleAlignments)[]) {
    const v = r[key];
    if (v === 'center' || v === 'justify') out[key] = v;
  }
  return out;
}

function sanitizeDisplayTypography(raw: unknown): DisplayTypography {
  const out = { ...DEFAULT_DISPLAY_TYPOGRAPHY };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Partial<Record<keyof DisplayTypography, unknown>>;
  out.citeUnderlined = !!r.citeUnderlined;
  out.underlineBold = !!r.underlineBold;
  out.hatUnderlineDouble = r.hatUnderlineDouble === undefined
    ? DEFAULT_DISPLAY_TYPOGRAPHY.hatUnderlineDouble : !!r.hatUnderlineDouble;
  out.emphasisBold = r.emphasisBold === undefined
    ? DEFAULT_DISPLAY_TYPOGRAPHY.emphasisBold : !!r.emphasisBold;
  out.emphasisItalic = !!r.emphasisItalic;
  out.emphasisBox = r.emphasisBox === undefined
    ? DEFAULT_DISPLAY_TYPOGRAPHY.emphasisBox : !!r.emphasisBox;
  out.undertagItalic = r.undertagItalic === undefined
    ? DEFAULT_DISPLAY_TYPOGRAPHY.undertagItalic : !!r.undertagItalic;
  out.undertagBold = r.undertagBold === undefined
    ? DEFAULT_DISPLAY_TYPOGRAPHY.undertagBold : !!r.undertagBold;
  const bs = Number(r.emphasisBoxSize);
  if (Number.isFinite(bs) && bs > 0 && bs <= 12) {
    out.emphasisBoxSize = Math.round(bs * 4) / 4; // quarter-pt precision
  }
  out.pocketBox = r.pocketBox === undefined
    ? DEFAULT_DISPLAY_TYPOGRAPHY.pocketBox : !!r.pocketBox;
  const ps = Number(r.pocketBoxSize);
  if (Number.isFinite(ps) && ps > 0 && ps <= 12) {
    out.pocketBoxSize = Math.round(ps * 4) / 4; // quarter-pt precision
  }
  // >= 0, unlike the box sizes: 0 is the meaningful "auto" value.
  const us = Number(r.underlineSize);
  if (Number.isFinite(us) && us >= 0 && us <= 12) {
    out.underlineSize = Math.round(us * 4) / 4; // quarter-pt precision
  }
  return out;
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function sanitizeColor(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  // Accept #abc and #abcdef; normalize to 6-digit lowercase.
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const r = trimmed[1]!;
    const g = trimmed[2]!;
    const b = trimmed[3]!;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  if (HEX_COLOR_RE.test(trimmed)) return trimmed.toLowerCase();
  return fallback;
}

function sanitizeDisplayColors(raw: unknown, rawOverrides?: unknown): DisplayColors {
  const out = { ...DEFAULT_DISPLAY_COLORS };
  const r =
    raw && typeof raw === 'object'
      ? (raw as Partial<Record<keyof DisplayColors, unknown>>)
      : {};
  for (const key of DISPLAY_COLOR_KEYS) {
    out[key] = sanitizeColor(r[key], DEFAULT_DISPLAY_COLORS[key]);
  }
  // Migration: older builds let the Accessibility "Color overrides"
  // panel set pmd-color-analytic / pmd-color-undertag via
  // customColorOverrides, which — applied last — is what actually
  // rendered. Fold any such value into displayColors so the linked
  // pickers reflect the color the user was really seeing. The legacy
  // override wins over the displayColors entry (which never rendered).
  // `sanitizeCustomColorOverrides` then drops these tokens from the
  // overrides blob, so there's no double source going forward.
  if (rawOverrides && typeof rawOverrides === 'object') {
    const ov = rawOverrides as Record<string, unknown>;
    for (const [token, key] of Object.entries(DISPLAY_COLOR_TOKEN_TO_KEY)) {
      if (Object.prototype.hasOwnProperty.call(ov, token)) {
        out[key] = sanitizeColor(ov[token], out[key]);
      }
    }
  }
  return out;
}

function sanitizeDisplaySizes(raw: unknown): DisplaySizes {
  const out = { ...DEFAULT_DISPLAY_SIZES };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Partial<Record<keyof DisplaySizes, unknown>>;
  for (const key of DISPLAY_SIZE_KEYS) {
    const v = Number(r[key]);
    if (Number.isFinite(v) && v >= 1 && v <= 144) {
      out[key] = Math.round(v * 2) / 2; // half-point precision
    }
  }
  return out;
}

function sanitizeParagraphSpacing(raw: unknown): DisplayParagraphSpacing {
  const out = { ...DEFAULT_PARAGRAPH_SPACING };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Partial<Record<ParagraphSpacingKey, unknown>>;
  for (const key of PARAGRAPH_SPACING_KEYS) {
    const v = Number(r[key]);
    // 0–96 pt, half-point precision (negative margins are never wanted).
    if (Number.isFinite(v) && v >= 0 && v <= 96) {
      out[key] = Math.round(v * 2) / 2;
    }
  }
  return out;
}

function sanitizeReaders(raw: unknown): ReaderConfig[] {
  if (!Array.isArray(raw)) return [...DEFAULTS.readers];
  const out: ReaderConfig[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const name = String((r as ReaderConfig).name ?? '').trim();
    const wpm = Number((r as ReaderConfig).wpm);
    if (!name || !Number.isFinite(wpm) || wpm <= 0) continue;
    const reader: ReaderConfig = { name, wpm: Math.round(wpm) };
    // Optional tags/analytics/cites rate: keep only a usable value —
    // anything else reads as blank ("main rate covers everything").
    const tagWpm = Number((r as ReaderConfig).tagWpm);
    if (Number.isFinite(tagWpm) && tagWpm > 0) reader.tagWpm = Math.round(tagWpm);
    out.push(reader);
  }
  return out.length > 0 ? out : [...DEFAULTS.readers];
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/** Coerce a stored partner list: drop non-objects and fully-empty rows
 *  (no code AND no name), dedupe by code. A row with a name but no code
 *  yet is kept so the editor can hold a partner mid-add (you typed the
 *  nickname before pasting the code); downstream send/group logic ignores
 *  partners whose code is still empty. */
function sanitizePairingPartners(raw: unknown): PairingPartner[] {
  if (!Array.isArray(raw)) return [];
  const out: PairingPartner[] = [];
  const seen = new Set<string>();
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const code = String((p as PairingPartner).code ?? '').trim();
    const name = String((p as PairingPartner).name ?? '').trim().slice(0, 80);
    if (!code && !name) continue;
    if (code && seen.has(code)) continue;
    if (code) seen.add(code);
    out.push({ code, name, ...((p as PairingPartner).hidden === true ? { hidden: true } : {}) });
  }
  return out;
}

/** Coerce a stored group list: require a label, dedupe ids, and drop any
 *  member code that is not (any longer) a known partner. */
function sanitizePairingGroups(rawGroups: unknown, rawPartners: unknown): PairingGroup[] {
  if (!Array.isArray(rawGroups)) return [];
  const validCodes = new Set(
    sanitizePairingPartners(rawPartners)
      .map((p) => p.code)
      .filter(Boolean),
  );
  const out: PairingGroup[] = [];
  const seenIds = new Set<string>();
  for (const g of rawGroups) {
    if (!g || typeof g !== 'object') continue;
    const label = String((g as PairingGroup).label ?? '').trim().slice(0, 80);
    if (!label) continue;
    let id = String((g as PairingGroup).id ?? '').trim();
    if (!id || seenIds.has(id)) id = `grp-${Math.random().toString(36).slice(2, 10)}`;
    const rawMembers = (g as PairingGroup).memberCodes;
    const memberCodes = Array.isArray(rawMembers)
      ? Array.from(
          new Set(rawMembers.map((c) => String(c).trim()).filter((c) => validCodes.has(c))),
        )
      : [];
    seenIds.add(id);
    out.push({ id, label, memberCodes });
  }
  return out;
}

const ENTER_AFTER_VALUES: readonly EnterAfterStyle[] = [
  'normal', 'pocket', 'hat', 'block', 'tag', 'analytic', 'undertag',
];
function sanitizeEnterAfter(v: unknown): EnterAfterStyle {
  return ENTER_AFTER_VALUES.includes(v as EnterAfterStyle) ? (v as EnterAfterStyle) : 'normal';
}

/** Coerce the starred send target: keep it only if it still points at a live
 *  recipient (by code) or group (by id); otherwise clear it. */
function sanitizePairingStarred(
  raw: unknown,
  rawPartners: unknown,
  rawGroups: unknown,
): { kind: 'partner' | 'group'; ref: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const kind = (raw as { kind?: unknown }).kind;
  const ref = String((raw as { ref?: unknown }).ref ?? '').trim();
  if (!ref) return null;
  if (kind === 'partner') {
    const live = new Set(
      sanitizePairingPartners(rawPartners)
        .map((p) => p.code)
        .filter(Boolean),
    );
    return live.has(ref) ? { kind: 'partner', ref } : null;
  }
  if (kind === 'group') {
    const live = new Set(sanitizePairingGroups(rawGroups, rawPartners).map((g) => g.id));
    return live.has(ref) ? { kind: 'group', ref } : null;
  }
  return null;
}

/** Singleton store. */
export const settings = new SettingsStore();

/** One-shot migration for the 2026-07-27 default flip: automatic update
 *  checks became opt-OUT. `persist()` snapshots EVERY settings key, so
 *  any install that ever changed any setting has the old `false`
 *  default baked into its stored blob — flipping `DEFAULTS` alone
 *  would reach only fresh installs, defeating the point (fleet
 *  convergence). This flips a stored `false` to `true` exactly once
 *  per install, keyed by a marker OUTSIDE the settings blob, and fires
 *  `onMigrated` so the caller can show a one-time notice. Full-snapshot
 *  storage can't distinguish "deliberately off" from "inherited
 *  default", so deliberate opt-outs get flipped once too — the notice
 *  tells them where the toggle is, and their re-toggle then sticks
 *  forever (marker present). Desktop boot path only — the web edition
 *  has no updater. */
export function migrateAutoUpdateOptOut(onMigrated: () => void): void {
  const MARKER = 'cm-update-check-optout-migrated';
  try {
    if (localStorage.getItem(MARKER) !== null) return;
    localStorage.setItem(MARKER, '1');
  } catch {
    return; // storage unavailable — leave the setting alone
  }
  if (!settings.get('checkForUpdatesOnLaunch')) {
    settings.set('checkForUpdatesOnLaunch', true);
    onMigrated();
  }
}
