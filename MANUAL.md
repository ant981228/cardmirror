# CardMirror User Manual

CardMirror is an editor for competitive debate evidence. It reads and
writes the same Microsoft Word `.docx` files as
[Verbatim](https://paperlessdebate.com) — same Pocket / Hat / Block / Tag
structure, same F-key shortcuts, same send-to-speech workflow — but it's
a standalone app, so you don't need Word, macros, or an add-in. It runs
on Windows, macOS, and Linux, and in any modern browser.

This manual covers the whole editor. If you already know Verbatim, most
of it will feel familiar; skip to **[New in CardMirror](#new-in-cardmirror)**
for the parts that aren't.

> Throughout this manual, **Mod** means the platform's main modifier key:
> **Ctrl** on Windows and Linux, **⌘ Cmd** on macOS. Every keyboard
> shortcut shown is the default — all of them are rebindable in
> **Settings → Keyboard shortcuts**.

---

## Contents

1. [Getting started](#1-getting-started)
2. [Organizing your files](#2-organizing-your-files)
3. [Cutting and formatting cards](#3-cutting-and-formatting-cards)
4. [Editing structure](#4-editing-structure)
5. [Finding things](#5-finding-things)
6. [Quick Cards](#6-quick-cards)
7. [The multi-doc workspace](#7-the-multi-doc-workspace)
8. [Reading and delivering a speech](#8-reading-and-delivering-a-speech)
9. [Collaboration](#9-collaboration)
10. [Live views and linked copies](#10-live-views-and-linked-copies)
11. [Comments and notes](#11-comments-and-notes)
12. [Learn: spaced-repetition flashcards](#12-learn-spaced-repetition-flashcards)
13. [AI features](#13-ai-features)
14. [Send to Verbatim Flow](#14-send-to-verbatim-flow)
15. [Voice control](#15-voice-control)
16. [Saving and file formats](#16-saving-and-file-formats)
17. [Settings reference](#17-settings-reference)
18. [Appearance and accessibility](#18-appearance-and-accessibility)
19. [Keyboard shortcuts](#19-keyboard-shortcuts)
20. [Plugins (experimental)](#20-plugins-experimental)
21. [Glossary](#21-glossary)

## 1. Getting started

### Installing CardMirror

Download the desktop app for your operating system from the
[Releases page](https://github.com/ant981228/cardmirror/releases), or try
the [live web preview](https://cardmirror.app/) in a
browser. Full install instructions — including the one-time "unsigned
app" prompts on Windows and macOS — are in the project README.

Save often and keep a copy of anything critical in a second format —
no editor is bug-free, and your own backups are the last line of
defense.

### Desktop vs. web

You can run CardMirror two ways:

- **Desktop app** (recommended for tournaments). Fully offline, reads and
  writes files directly on your disk, supports autosave and crash
  recovery, and can search your file library.
- **Web edition** (good for trying it out, or working from a Chromebook
  or locked-down school machine). The same editor in a browser — and on
  Chromium browsers you can **install it as an app** for most of the
  desktop experience.

**Installing the web edition as an app (Chrome / Edge / ChromeOS).** Open
it and click the **Install** button in the address bar to run CardMirror in
its own window — offline, and updating itself when you relaunch. On a
Chromebook, this is the best way to run it. Installed, the web app covers
most of the desktop experience; what follows is only what still differs.

A few capabilities still need the **desktop app**: the background
**[file-library search](#the-search-everything-palette-mod-shift-space)**,
**folder-wide** bulk operations (the web app runs Clean / Convert one
file at a time instead),
**[Send to Verbatim Flow](#14-send-to-verbatim-flow)**, and
**[voice control](#15-voice-control)**. And saving in
place needs a Chromium browser — in **Firefox and Safari** the editor runs
but **[Save](#saving)** downloads a copy instead.

Features that work in only one edition are marked **(desktop only)** or
**(web only)** throughout, so you'll find the specifics in each relevant
section as you read.

**The web edition has a mobile layout.** Open CardMirror in a phone or
tablet browser — or any browser window narrower than about 768px — and
it switches to a view-first **mobile layout**: a slim top bar, the
document full-bleed, a **Read** button for read mode (tap the page to
drop or remove a reading marker), pinch-zoom, an outline drawer, and a
touch-sized Settings page. **Use desktop layout** switches back to the
full editor.

### CardMirror Lite

**CardMirror Lite** is a third option, built for school-managed devices
whose IT policies restrict AI tools or network access. It's the same
editor — same files, same shortcuts, same formatting engine — with the
network-dependent features removed from the build entirely: no AI
features, no card sharing or co-editing, no account linking, no
plugins, and no update checks. The web version at
**lite.cardmirror.app** is locked down by a browser-enforced security
policy so it cannot contact anything but its own address; the desktop
version ("CardMirror Lite" installers on the releases page) blocks
network requests at the application level and installs alongside a
standard copy without touching it.

Everything in this manual applies to Lite **except** the sections on
AI features, collaboration, plugins, and updates. Documents move
freely between Lite and the standard edition — if your school uses
Lite and your home machine runs the full app, they read and write the
same files. Desktop Lite doesn't update itself; install a newer Lite
build from the releases page when you want one.

### First launch and the welcome guide

On a fresh install, CardMirror starts with a **guided UI tour**: a
step-by-step spotlight over the interface — the editor, the style
clusters, the outline, read mode, the timer, and a hands-on stop at the
command bar. Step with the on-screen buttons or **← →**, skip with
**Esc**, and rerun it whenever you like with the **Take the UI Tour**
command (command bar).

The first time you open CardMirror — and every time you press **New
Document** — you also get an interactive welcome guide built out of real
Pockets, Hats, cards, and analytics. It's a live document: type in it,
press the shortcuts, and try things as you read. When you're done, turn
it off in **Settings → Files → "Onboarding doc for new documents"** and
new documents will open blank instead.

### A two-minute tour of the ribbon

The ribbon across the top is grouped into panels, left to right:

- **File** — open, new, save, and the autosave toggle.
- **Structural styles** — Pocket, Hat, Block, Tag, Analytic, Undertag.
- **Cite / Underline / Emphasis / Clear** — the inline marks.
- **Colors** — highlight, background, and font color, each a split button
  with a swatch picker.
- **Format** — tables, image insert, super/subscript, strikethrough,
  font size.
- **Doc / Card** menus — bulk operations on the document or a card.
- **View** — read mode, the navigation pane, and the comments column.
- **Comments cluster** — add a comment, a note, or a flashcard (and Ask
  AI, if AI is on).
- **Right side** — the keyboard-shortcut reference (📖), settings (⚙),
  and Home (🏠).

Toggle buttons light up to show the current state — including the **style
buttons**, which highlight to show what styles the text at your cursor
already carries (Cite / Underline / Emphasis, and Pocket / Hat / Block /
Tag / Analytic / Undertag).

The **status bar** at the bottom shows the word count and read-time
estimate (click it for details), the zoom controls, and — when there
is something to report — the [notice chip](#the-notice-chip).

<a id="new-in-cardmirror"></a>
### New in CardMirror

If you're coming from stock Verbatim, these are the new features. Each is
covered in full in the section linked.

- **[Built-in Analytic and Undertag styles](#cards-analytics-and-undertags)**
  — both ship as first-class structural styles with their own shortcuts and
  structure-aware handling (read mode, send-to-speech, Extract Undertag).
  Verbatim doesn't ship them; you'd have to roll your own Word styles, which
  it wouldn't treat as structure.
- **[Highlight and background color as independent tracks](#colors-highlight-background-and-font-color)**
  — highlight and background color (or shading) are separate, coexisting
  colors, each with its own apply / standardize / convert functions that
  leave the other untouched.
- **[Acronym variants](#colors-highlight-background-and-font-color)** —
  emphasize or highlight just the source letters of an acronym (the **U**
  and **S** in United States) in one keystroke.
- **[Shrink protections and Condense with warning](#shrink-mod-8)** —
  Shrink can keep omission notes, warning markers, and your own custom
  strings at normal size while everything else shrinks.
- **[Repair paragraph integrity](#repair-paragraph-integrity)** —
  rebuild a card's paragraph breaks one at a time when a PDF or a paste
  collapsed them into a single run.
- **[Create Reference](#citations)** — copy a formatted reference for the
  current document to the clipboard, built in.
- **[Extract Undertag](#document-and-card-cleanup)** — pull a phrase out of
  a card into a new undertag beneath the tag, leaving the original in place.
- **[Editing at card boundaries](#editing-at-card-boundaries)** — deliberate
  behavior for what backspace, delete, and merging do at the edges of a
  card, tag, or analytic, so the structure stays intact.
- **[Structure-aware Find](#5-finding-things)** — find results group by
  structural type by default (with a flag to order by position instead).
- **[A command palette](#5-finding-things)** that searches your files,
  your Quick Cards, the dropzone, and your settings from one box.
- **[Cross-window Quick Cards](#6-quick-cards)** — a tagged snippet
  library with a search palette, available from any window.
- **[Drag-to-reorder everywhere](#4-editing-structure)** — pick up a card
  or a whole heading and drop it, in the outline or on the page, with
  drop targets that refuse invalid moves.
- **[A real multi-doc workspace](#7-the-multi-doc-workspace)** — three
  editable panes side by side, each with its own outline and history, and
  drag-copy between them.
- **[Live views and linked copies](#10-live-views-and-linked-copies)** — show a
  section in more than one place: a read-only **live view** that always tracks
  its source, or an editable **linked copy** you refresh — from this document or
  another file.
- **[Read mode that locks the keyboard](#8-reading-and-delivering-a-speech)**
  — a non-destructive reading view at the podium that stray keystrokes
  can't edit, with a reading-position marker for stopping mid-card.
- **[Read-time word counts](#read-time-estimates)** — the status bar shows
  how long the visible (or selected) text takes to read, per reader, not
  just a raw word count.
- **[Send-to-speech with a dropzone](#send-to-speech-and-the-dropzone)** —
  send cards and headings into a speech doc, with a holding shelf for
  staging evidence before you place it.
- **[Collaboration](#9-collaboration)** — send cards to other people's
  machines, or co-edit a document in real time; end-to-end encrypted.
  *(Desktop only.)*
- **[Spaced-repetition flashcards](#12-learn-spaced-repetition-flashcards)**
  — study your own evidence; cards live on your machine and never travel
  with a shared file.
- **[Private notes](#11-comments-and-notes)** — a personal annotation that,
  like flashcards, stays out of the file you share unless you opt in.
- **[AI features](#13-ai-features)** — format a cite, repair OCR/PDF
  extraction errors, ask a question about a selection, or generate alt text
  and tables from an image.
- **[Translate a selection](#13-ai-features)** — to the clipboard, with a
  keyless backend that works even without AI features set up.
- **[Display customizations and accessibility](#18-appearance-and-accessibility)**
  — themes, dyslexia-friendly fonts, per-style colors, and color overrides
  that change how styles look on your screen without altering the document
  or its style definitions.

---

## 2. Organizing your files

Good structure is the foundation of everything else. As in Verbatim, you
build a file out of nested headings and cards, and the **navigation pane**
on the left gives you an outline you can fold, jump around, and reorder.

### Heading levels

CardMirror uses Verbatim's four heading levels, each on a function key:

| Level | Style | Shortcut | Use it for |
|-------|-------|----------|------------|
| 1 | **Pocket** | F4 | A top-level argument or file ("Politics DA") |
| 2 | **Hat** | F5 | A major grouping inside a pocket |
| 3 | **Block** | F6 | A set of related cards on one point |
| 4 | **Tag** | F7 | The claim line on a single card |

Put the cursor in a paragraph and press the key to convert it. As in
Verbatim, let the content dictate the structure — a short file might use
only Blocks and Tags. CardMirror is happy with files that skip levels or
start partway down; you don't have to start with a Pocket.

A single document can hold several "files" in a row, separated by blank
top-level headings — the same convention Verbatim uses for, say, a DA
shipped with its companion CP.

### Cards, analytics, and undertags

- A **card** is a Tag plus the evidence beneath it: the cite and the
  body text. Tag (F7) creates a card.
- An **analytic** (**Mod-F7**) is standalone analysis — a claim with no
  card behind it. It behaves like a card structurally: the lines beneath
  it belong to it.
- An **undertag** (**Mod-F8**) is a short annotation on a tag — a
  qualifier or sub-claim.

Loose, unstyled paragraphs can sit outside of a card, but will be absorbed
into the card if they are directly beneath a tag.

### The navigation pane

Toggle it from the **Nav Pane** button in the ribbon's View group. It
mirrors Word's Navigation Pane, but does more:

- **Jump** — click any entry to scroll to it.
- **Fold** — double-click an entry to collapse or expand its subtree
  (this only changes the outline view, not the document).
- **Level filter** — the **1 · 2 · 3 · 4** buttons at the top set how
  deep the outline shows. Click **2** to see only Pockets and Hats; **4**
  to see everything down through Tags. This is a per-document view
  change; what depth a **newly opened** document starts at is the
  **Default navigation depth** setting (Settings → General), Block by
  default. Clicking the already-active level re-collapses any manual
  expansions. Changing depth keeps the section your cursor is in at the
  top of the outline (turn off **Navigation pane follows the cursor**
  in Settings → General to return to the top of the document instead).
- **Multi-select** — Mod-click adds an entry to the selection,
  Shift-click selects a contiguous range.
- **Reorder** — drag an entry (or a multi-selection) up or down. It
  carries the whole heading and its contents and drops it wherever the
  structure allows. Hold **Ctrl** (or **Alt** on macOS) while dragging to
  **copy** instead of move.
- **Right-click menu** — right-click an entry for **Select / Cut /
  Copy / Delete**, each acting on the heading *and everything under
  it*, plus quick access to the level filter. **Cut** copies the
  section to the clipboard and removes it in one step, ready to paste
  elsewhere (Ctrl-Z restores; the removal only happens once the copy
  has safely landed on the clipboard). Delete and Cut are both
  undoable like any edit. Right-clicking an entry that's part of a
  **multi-selection** runs the action on *every* selected heading —
  Cut and Copy stitch a scattered selection together in document
  order, so it pastes as if the sections had been dragged next to
  each other first, and a multi-Delete is a single undo step. The
  menu also offers **Create live view of heading** and **Create
  linked copy of heading**, which drop a [live view or linked
  copy](#10-live-views-and-linked-copies) of that section at your
  cursor — no picker needed, since the clicked heading *is* the pick.

### Card numbering

CardMirror can number your cards and substructure automatically — handy for
referring to e.g. "2AC 3" while you edit or read. Numbering is **display only**: it
never changes your card text, and you can turn it off any time.

Turn it on from the **numbering** cluster in the ribbon (or search "numbering"
in the command bar). You mark which cards carry a number, mark which cards carry substructure, 
and set where numbering starts over; CardMirror computes the numbers and keeps them 
current as you reorder. The same numbers appear next to each card in the 
**navigation pane**, so the outline reads like your speech doc.

You can also number straight from the outline: **Shift-click or Ctrl/Cmd-click
several tags in the navigation pane**, then hit the number or substructure
button (or their shortcuts) — the toggle applies to every selected card at
once, and the selection stays put so you can toggle again. The **restart
toggle** works the same way: select several **blocks** in the
outline and hit restart to flip them all to "continue", so arguments
separated by blocks number consecutively straight through (press again to
restore the per-block restarts). 

While numbering is on, a block whose count **continues** from the block
above shows a small grey **↓** at the right edge of its heading. No glyph
means the default: the count restarts at that block. 

Tune how they look in **Settings → Appearance → Card numbering**: independent
formats for the number and its substructure, the separator between them (period,
dash, colon, and more), whether the substructure is capitalized and whether it's
bold, the number color, and how far each is indented — all display settings that
change how the numbers *look*, never the content. Numbers are exported to Word if
you save as .docx.

---

## 3. Cutting and formatting cards

### How commands choose what to act on

Like Verbatim, most formatting commands follow a priority order to decide
what to operate on:

1. **If you have text selected, the command acts on the selection.**
2. **If nothing is selected, it falls back to the smallest structure your
   cursor is in** — the enclosing card or analytic, or the heading section
   you're sitting in, whatever level that is. **Condense** (F3) and
   **Shrink** (Mod-8) work this way.

Two caveats:

- When there is no selection, some commands will act on the **whole
  document** — the bulk cleanup commands like **Standardize Highlighting**
  and **Select Similar Formatting**.
- A few inline-mark commands fall back to the **word at the cursor**
  (**Underline**, **Emphasis**, **Cite**). Some **do nothing** when there's no selection
  (**Highlight**), since that's text you would normally select on purpose.

CardMirror extends this selection-awareness to more commands than
Verbatim does, but the model should feel familiar. The per-command notes
below say which fallback applies where it matters.

### The core formatting keys

| Function | Shortcut | What it does |
|----------|----------|--------------|
| **Cite** | F8 | Applies the Cite style — meant for just the author last name and date, not the whole line. With nothing selected, it applies to the word at the cursor. Skips heading text in a mixed selection. |
| **Underline** | F9 / Mod-U | Toggles underline on the selection (press again to remove). With **nothing selected** the two differ: **F9** underlines the word at the cursor; **Mod-U** instead turns on underline for the text you're about to type (like Mod-I for italics). |
| **Emphasis** | F10 | Applies the Emphasis style (a box, by default). Apply-only; use Clear or Underline to swap it off. |
| **Highlight** | F11 | Toggles the active highlight color. Press again to remove. |
| **Clear** | F12 | Strips direct formatting back to plain text (leaves highlighting — toggle that off separately). |
| **Bold / Italic** | Mod-B / Mod-I | Standard direct formatting. With nothing selected, toggles it for the text you're about to type; while italic typing is on, the cursor tilts to match. Tags and headings are bold by default, so **Bold inside a tag un-bolds** the selected words (press it again to restore) — and .docx files with un-bolded words in tags now show that correctly. |

Super/subscript and strikethrough live in the **Format** menu (super and
subscript also have shortcuts: **Mod-Shift-=** and **Mod-=**).

<a id="paste-text-f2"></a>
### Paste Text (F2)

Use **F2** instead of Ctrl/Cmd-V when pasting card text from a webpage or
PDF — this strips the source's styles, which will otherwise bloat your file. 
On the desktop app and in Chromium browsers (Chrome /
Edge / ChromeOS) F2 pastes immediately — the web edition reads the
clipboard directly, so the first time it's used it will ask for permission. 
**(Web only:)** where the browser won't grant clipboard
access — including Firefox and Safari — F2 falls back to *arming* plain
paste: the status bar shows a pill, and your next Ctrl/Cmd-V pastes as
plain text.

If **Condense on paste** is on (Settings → Editing), the
pasted text is condensed as it lands.

<a id="smart-paste"></a>
### Smart paste from Word and haku.cards

A regular Ctrl/Cmd-V of content copied from Microsoft Word (including
Verbatim files) or from haku.cards is converted into real CardMirror
structure — tags, cites, headings, underlining, emphasis, highlighting,
and card numbering — instead of arriving as unformatted text. Content
with no recognizable structure pastes exactly as before, and F2 still
pastes plain. The **Smart paste conversion** toggle lives in Settings →
Editing → Paste (on by default).

Know its place: smart paste is a best-effort convenience working from
the clipboard's HTML rendition of the source, and it is deliberately
not built to handle every edge case. When fidelity matters — or when a
paste comes out wrong — **open the .docx in CardMirror and copy from
there**: the real importer reads the actual document and may do
better.

### Condense, pilcrows, and case

The F3 family collapses card text the way Verbatim's does:

| Function | Shortcut | What it does |
|----------|----------|--------------|
| **Condense** | F3 | Collapses whitespace and merges paragraphs using your current paragraph-integrity and pilcrow settings. |
| **Condense without integrity** | Alt-F3 | Forces a merge to a single paragraph, no integrity markers. |
| **Condense with pilcrows** | Mod-Alt-F3 | Merges but marks the original breaks with small ¶ pilcrows. |
| **Uncondense** | Mod-Alt-Shift-F3 | Restores the original paragraph breaks from pilcrows. |
| **Toggle case** | Shift-F3 | Cycles the selection: lowercase → UPPERCASE → Title Case. |

**Paragraph integrity** is a toggle (in the ribbon's doc-ops controls and
in Settings). With it on, condense keeps your paragraph breaks (as
pilcrows, or as real breaks if pilcrows are off) instead of flattening
everything to one block. As in Verbatim, when you cut a PDF that breaks
every line, turn integrity off for that article so you don't get a
pilcrow on every line, then turn it back on.

The **Heading Mode** setting controls how a condense that spans headings
behaves — `respect` (the default; leaves headings separate, merges only
body runs), `strict` (refuses to touch a selection that includes
structure), or `demolish` (flattens everything touched).

**Paste and Destructively Condense** (desktop; unbound by default — assign a
key in Settings → Keybindings) rolls two steps into one: it pastes the
clipboard's plain text and immediately runs a destructive condense (Alt-F3)
over just what you pasted, merging its paragraphs into a single block. It's the
quick way to drop in a quote you want condensed on arrival. Desktop only, since
the web edition can't read the clipboard on a keypress.

### Autocorrect: quotes, dashes, replacements, and capitalization

CardMirror ships a family of Word-style autocorrects: all fire as you type and 
every conversion is reversible with **Backspace** right after it fires. 

- **Smart quotes** (Settings → Editing → "Smart quotes") curl a straight `'` or
  `"` to the right direction as you type — opening after a space, dash, bracket,
  or the start of a line; closing (and the apostrophe) otherwise — so `don't`
  and `(he said "hi")` come out right.

- **Custom dash** (Settings → Editing → "Custom dash") turns a typed `---` into
  an en or em dash, with or without surrounding spaces (your choice), the moment
  you type the third hyphen.

- **Custom autocorrect** (Settings → Editing → "Custom autocorrect") is
  Word's "replace text as you type": define your own entries — `fwk` →
  `framework`, `--` → `---`, `(c)` → `©` — and they expand the moment you
  finish the sequence with a space or punctuation. Lowercase entries adapt to
  how you typed them (`Fwk` → `Framework`, `FWK` → `FRAMEWORK`). Entries
  apply everywhere, including card bodies — an expansion is something you
  asked for by name. The table warns you about clashes: adding a second
  entry for the same input is refused outright, and an entry that another
  typing aid would intercept (say `--` → `---` while Custom dash converts on
  the second hyphen) gets a ⚠ explaining why it can't fire. If
  Auto-capitalize is also on, an expansion at a sentence start in a tag or
  analytic comes out capitalized (`fwk` → `Framework`) — and one Backspace
  still restores exactly what you typed.

- **Auto-capitalize tags and analytics** (Settings → Editing) capitalizes the
  first word of each sentence — and a standalone `i` — in **tags and analytics
  only**, the moment you finish the word with a space or punctuation. Card
  bodies, cites, and everything else are quoted source text and are never
  touched. It knows not to fire after abbreviations (`etc.`, `vs.`, `pp.`),
  initials, or an ellipsis, and skips `(i)`-style enumeration markers.

- **Flip Quote Direction** (a command, unbound by default) flips every curly
  quote in your selection to its opposite direction, keeping the formatting.
  It's the manual fix for the cases smart quotes — like Word — guess wrong, such
  as a leading apostrophe in `'tis` or `'90s` that should curl the other way.

### Shrink (Mod-8)

**Shrink** cycles the non-underlined text in the current card or
analytic through progressively smaller sizes and back to normal, so a
card reads compactly at the podium. By default it leaves **omission
notes** — bracketed text like `[Table Omitted]` or `<Figure Omitted>` —
at full size; you can turn that protection off in Settings.

### Smart Shrink (Mod-Alt-8)

**Smart Shrink** shrinks a card's connective text in one pass, working
paragraph by paragraph: a paragraph with no underlining or emphasis at all
— the long, fully-unread stretches — drops to **5pt**, while a paragraph
that carries marks shrinks only its connective text to the standard
**8pt**. Unlike Shrink, it doesn't cycle: running it again changes nothing.
It honors the same protections as Shrink (omission markers, integrity
warnings, your custom rules), and regular **Shrink (Mod-8)** and **Regrow
(Mod-Shift-8)** still work on the result.

### Citations

- **Cite (F8)** applies the cite character style to the author and date,
  as above.
- **Copy Previous Cite (Alt-F8)** pulls the cite from the previous card
  into the current one — handy when cutting a long article.
- **Format Cite from selection (Mod-Shift-X)** uses AI to turn a pasted
  citation or URL into a properly styled cite (see
  [AI features](#13-ai-features)).
- **Create Reference** copies the selected card text to your clipboard as
  a "for reference" excerpt: a `<<CITE FOR REFERENCE>>` heading line,
  body text reduced by 3pt, and highlights converted to a quiet grey
  background. Every step is customizable under **Settings → Editing →
  Create Reference** — skip the heading or reshape it (bracket style,
  whether the cite appears, or a fully custom label with `%Cite%` marking
  where the cite goes), keep the original text size (or change how much
  it shrinks), choose what highlights become (grey background, a
  background in the same color, kept, or removed), and the Gray-50% body
  text option.
- **Lock Highlighting** converts highlighting to a light-gray background
  color in place, freeing the highlight layer so you can re-highlight from
  scratch. With nothing selected it locks the whole card your cursor is in;
  with a selection it locks just the selection. (With no selection and no
  card under the cursor it does nothing — it won't lock an entire
  pocket/hat/block.) Unlike Create Reference it edits the card directly,
  adds no heading, and does not turn the text gray — the card stays fully
  editable. (Any background color you'd already applied is left as-is.)

### Colors: highlight, background, and font color

CardMirror directly supports both **highlighting** and **background
color**. Highlighting and background color appear the same but operations
affecting one don't affect the other, allowing you to perform bulk edits on
your document that leave some things unaffected. (If you'd like to tell
them apart at a glance, **Settings → Appearance → Distinguish background
color from highlighting** adds a subtle display-only cue.) As an example, you might
want to recut an opponent's card and keep their highlighting for reference, but 
distinguish your own highlighting pass; you can do this by
turning their highlighting into background color so it isn't affected by
"standardize highlighting" in the future.

Each of the three color controls is a **split button**: the main button
applies the active color, and the small arrow opens a 16-swatch picker.
The picker remembers your last color per control. The top-left swatch
selects **no color** (No highlight / No background / Automatic) — and
"no color" is a real pen, not just a one-off eraser: it stays active
(the indicator bar under the button turns white), and the main button,
paintbrush mode, and F11 / Mod-F11 then *strip* the mark wherever you
paint, until you pick a color again.

- **Highlight (F11)** — toggles the active highlight on the selection.
  Supports all 15 Word highlight colors.
- **Background color (Mod-F11)** — a separate background color that
  can coexist with a highlight; takes any color.
- **Font color** — applies a text color; the "Automatic" swatch removes
  it.

**Paintbrush mode** (the way Word's highlighter works): click a main
color button with *nothing* selected to arm it. The cursor changes, and
every drag-select you make applies that color until you press **Esc** or
click the button again. While a colored brush is armed, hold **Alt**
(**⌃ Control** on macOS, where an ⌥ drag moves the window) to
temporarily flip it to the **no-color** pen —
the cursor's swatch shows the red-slash glyph, and each drag *strips*
the mark instead of painting. Release the key and your color is back;
the saved pen color never changes.

The **acronym variants** mark just the first letter of each word in the
selection: **Alt-F10** (emphasis) and **Alt-F11** (highlight) — for
marking the source letters of an acronym, like **U**nited **S**tates.
An underline variant (*Underline Acronym*) is keybindable, unbound by
default. And for phrases whose shorthand isn't first letters, teach
them your own under **Settings → Editing → Acronym marking**: type the
phrase, click the letters to mark — pick the w, m, and d of "weapons of
mass destruction" and all three commands mark exactly those letters,
reading "WMD" instead of the default "womd". Applies whenever the
selection is exactly that phrase (case-insensitive).

For cleanup, the Card/Doc menus include **Standardize Highlighting** (and
background) to convert every color in scope to your active one (with the
"no color" pen active, they remove every highlight or background in
scope), and converters between highlight and background.

Each standardize command also has a **(with Exception)** variant in the
Doc menu that works the same way but leaves one color of your choice
completely untouched — pick the protected colors under **Settings →
Editing → Standardize exceptions**. The menu label always shows the
current exception (e.g. "Standardize Highlighting (except Yellow)");
both exceptions default to yellow. With the "no color" pen active, the
variants strip everything *except* your exception color. Both are
keybindable (unbound by default).

**Tip:** right-click any structural-style or character-style button to
select *every* instance of that style in the document — then apply a
color to all of them at once.

### Tables and images

- **Insert Table** (Format menu) drops in a table; further menu items add
  or delete rows and columns and merge or split cells. Tables round-trip
  to Word with their borders and background colors intact.
- **Insert Image** (Format menu) inserts an image from a file; you can
  also paste one from the clipboard. Right-click an image to **edit its
  alt text** (or have AI write it) and to **generate a table from the
  image** (see [AI features](#13-ai-features)). Alt text round-trips to
  Word.

### Footnotes and endnotes

Word footnotes and endnotes survive the round trip: opening a `.docx`
keeps every note, and saving writes them back so a Word user sees them
exactly where they were. In the editor each note is a small superscript
number (footnotes count 1, 2, 3…; endnotes i, ii, iii…) — **click it to
read the note** in a popover, links included. The popover's **Edit**
button lets you correct a note as plain text (formatting inside the
note is dropped when you save an edit). Notes travel with their text:
cut, copy, and send a card and its footnotes go along.

To create a new footnote, use the **Insert Footnote** command — unbound
by default; assign a key under Settings → Keyboard. It drops a marker
at the cursor and opens the note editor right away, so the flow is:
invoke, type the note, Save. To remove one, click the marker and hit
**Delete** in the popover — or just Backspace over the marker in the
text.

### Document and card cleanup

The **Doc** and **Card** ribbon menus hold document- and card-level
operations. From the **Doc** menu: **Convert Analytics to Tags**,
**Convert Cited Analytics to Tags** (the same, but only for analytics
that actually carry a cite — bare analytics stay analytics), **Fix
Formatting Gaps**, and **Remove Hyperlinks**. **Select Similar
Formatting** selects everything that matches the cursor's styles.

When you apply formatting to a word right next to an already-formatted word,
CardMirror automatically bridges the small gap between them so the styling reads
as continuous. Two Settings → Editing controls govern this: a toggle to turn the
automatic bridging on or off (the manual **Fix Formatting Gaps** command above is
unaffected), and a choice of which gaps it bridges — **whitespace and
punctuation** (the default) or **whitespace only**. Bridging happens only in body
text, never inside structural lines (tags, analytics, headings, undertags) — so a
selection spanning both bridges its body paragraphs and leaves its structure
alone.

From the **Card** menu's Excerpt section, **Extract Undertag** takes your
selection inside a card and drops it as a new undertag beneath the tag
(below any existing undertags), leaving the original text in place — handy
for pulling a key phrase up into an undertag. A Settings → Editing toggle,
**"Extract Undertag: wrap in quotes"** (off by default), controls whether
the excerpt is quoted.

Verbatim's other bulk cleanup macros (AutoNumberTags,
ConvertToDefaultStyles, and the rest) aren't in CardMirror.
ReformatAllCites has an AI counterpart — see **Reformat Every Cite**
under [AI features](#13-ai-features).

### Repair paragraph integrity

When a card's body has collapsed into one run — a PDF that lost its breaks,
or text pasted as a single block — **Repair Paragraph Integrity** rebuilds
the paragraphs one break at a time. Put your cursor in the card (or select
it) and run the command; a small bar opens and a green box outlines the card
it's working on.

Type a phrase that should *begin* a paragraph. As you type, every occurrence
of it in the card's body is highlighted in green. Once you've typed enough
that exactly **one** occurrence matches, the bar flashes green and shows a
check — press **Enter** to drop a paragraph break right before that phrase.
The box clears so you can type the next paragraph's opening phrase, and so on.

Press **Ctrl-Enter** instead of Enter to break *and* mark that paragraph to be
**indented** — it gets a thick green bar in the left margin. The indent isn't applied
right away; it lands when you exit, on whatever that paragraph has become by
then. So if you later split it again, only the final paragraph (up to the next
break) is indented, not the rest of the card. Press **Esc** to apply any
pending indents and leave the workflow.

It only searches the card's body (not the tag), so you can't accidentally
break a heading. The command ships without a default shortcut — assign one in
Settings → Keybindings.

---

## 4. Editing structure

CardMirror follows Word's keyboard and mouse conventions for moving
around and selecting text, and — because it knows what a card *is* —
editing around a card's edges behaves predictably instead of letting you
create half-formed structures.

### Moving the cursor

Alongside the usual arrow keys, CardMirror has Word-style jumps. Use
**Ctrl** on Windows/Linux or **Alt/Option** on macOS — both work
everywhere:

- **Ctrl/Alt-Left / -Right** — jump to the start of the previous / next
  word, crossing into the neighboring paragraph at a line's edge.
- **Ctrl/Alt-Up / -Down** — jump by paragraph. Up lands at the start of
  the current paragraph first, then the previous one; Down goes straight
  to the next paragraph.
- **PageUp / PageDown** — jump by heading, to the previous / next
  structural marker (Pocket, Hat, Block, Tag, Analytic), skipping over
  body text — a quick way to move through a file by its outline.

Hold **Shift** with any of these to **extend the selection** instead of
just moving the cursor, exactly as in Word. So **Shift-Ctrl/Alt-Right**
selects to the end of the next word, **Shift-Ctrl/Alt-Down** selects to
the next paragraph, and **Shift-PageDown** selects to the next heading.
The selection grows or shrinks from a fixed anchor as you keep going.

### Selecting text with the mouse

Mouse selection mirrors Word too:

- **Double-click** selects a word; keep dragging and the selection extends
  word by word (the word you started on stays fully selected even if you
  drag back the other way).
- **Triple-click** selects the whole paragraph; dragging then extends a
  paragraph at a time.
- **Click and drag** selects by character — but once you drag past the
  first word it snaps up to selecting whole words (and back to characters
  if you drag back inside that first word), again matching Word.
- **Shift-click** extends the current selection to where you click, using
  whatever unit you last selected by: Shift-click after a double-click
  extends by word, after a triple-click by paragraph.

### Converting blocks

Pressing a structural key (F4–F7, Mod-F7, Mod-F8) converts the current
block:

- On a plain paragraph or heading, it changes the style in place; **Tag**
  and **Analytic** wrap the block into a new card or analytic.
- On a card's **tag**, a heading key (F4–F6) dissolves the card and lifts
  its body out; **Mod-F7** swaps the card to an analytic.
- Inside a card's **body**, a heading key splits the card at that line.
- With **several paragraphs selected**, the style applies to all of them
  at once.

Re-applying an already-applied style clears indentation **and any manual
font-size override** while keeping the style — the way to reset an
over-indented or hand-resized line back to the style's defaults. (Tags,
analytics, pockets, hats, and blocks reset the font size; undertags clear
only indentation.)

### Editing at card boundaries

When your cursor is in a tag (or analytic), a few keys behave
deliberately rather than the way they would in Word:

- **Backspace at the start of a tag** removes a blank line above it;
  otherwise it does nothing (it won't merge body text up into the
  heading).
- **Backspace on an empty line directly below a tag** deletes that blank
  line. A line *with* text is left alone, so you can't accidentally merge
  body text into the heading.
- **Delete at the end of a tag** merges with the next tag if there is
  one; otherwise nothing.
- **Enter** at the end of a tag starts a card body; in the middle of a tag
  splits the card; at the start inserts an empty card above.

Empty tags and stray blank lines clean themselves up as you delete around
them.

### Indenting

**Tab** and **Shift-Tab** indent and outdent the current block (or
selection) by one step. Indentation doesn't change a heading's outline level. 
(Inside a table, Tab moves between cells.)

### Drag-and-drop

Two ways to move things, both schema-aware (drop targets that would
create an invalid structure don't light up, and bad drops are refused):

- **From the navigation pane** — drag any heading (or multi-selection) to
  reorder; Ctrl/Alt-drag to copy.
- **From the page** — hold **Mod-Shift-Alt** and drag a card or analytic
  directly. The cursor switches to a grab cursor and the card's boundary
  highlights as you go.

In the [multi-doc workspace](#7-the-multi-doc-workspace), dragging across
panes copies the content into the other document.

### Moving cards and sections

To reorder by keyboard, put your cursor in a card or section and press
**Mod-Alt-↑** or **Mod-Alt-↓** — the **Move Container Up** / **Move Container
Down** commands. CardMirror grabs the smallest outline item enclosing your
cursor — a card or analytic unit, or a heading together with its whole section —
and slides it one spot among its same-level neighbors in the navigation pane.
Cards reorder among cards, blocks among blocks, and so on; nudging past the edge
of a section carries the item into the adjacent one. Both commands are rebindable
under Settings → Keybindings (listed with the Editing utilities).

### Spellcheck

Off by default — debate evidence (author names, jargon, citations) trips a
lot of false positives. Turn it on under **Settings → General → Editor
spellcheck**. Misspellings get a red underline. **Right-click** a flagged
word for spelling suggestions, **Add to Dictionary** (your personal
dictionary persists across documents and sessions), or **Ignore** (for this
session).

Leaving spellcheck on slightly degrades editor performance, so if you
notice typing or scrolling feeling less responsive on a large file, turning
it off may help.

---

## 5. Finding things

### Find and Find/Replace

- **Find (Mod-F)** opens the find bar.
- **Find and Replace (Mod-H)** adds a replace field.
- **Find without category grouping (Alt-F)** orders matches by position
  rather than grouping them by structural type.

### The Search Everything palette (Mod-Shift-Space)

A single floating box that searches across everything CardMirror knows
about — your Quick Cards, the dropzone, every command, every setting, and
your files — and acts on what you pick. It opens centered over the active
pane with results listed above the bar; **↑/↓** move the selection,
**Enter** activates it, and **Esc** closes.

By default it searches **everything at once**: as you type it blends matches
from all the sources below. To narrow to one source, start your query with
its **one-letter prefix** followed by a space. With a prefix and no query,
you *browse* that whole source.

| Prefix | Searches | Enter |
|--------|----------|-------|
| *(none)* | Everything — cards, commands, settings, files by name, and the dropzone (if on) | Acts on the selected row |
| **`q`** | Your **Quick Cards** (honoring your active tag filter) | Inserts the card at your cursor |
| **`d`** | The **dropzone** (only when it's turned on) | Inserts the item at your cursor |
| **`c`** | Ribbon **commands** — each row shows its current shortcut | Runs the command |
| **`s`** | **Settings** — both the section tabs and individual settings | Opens that tab and scrolls to the setting |
| **`f`** | Your **files** by filename *(desktop only)* | Opens the file |

Searching **version** (or "about this install") shows the running app
version, and Enter jumps to the About this install section of Settings.

Results show 50 at a time. When there are more, the last row says so —
click **show more** (or just keep arrowing down past the end) to reveal
the next fifty. When a result's name or folder path is too long to fit
the row, hovering it shows the full text in a tooltip.

**Inserting evidence.** Quick-card, dropzone, and in-file results drop in
at your cursor (the same insertion the send-to-speech and Quick Card
buttons use). If your cursor is in the middle of a paragraph, the insertion
will drop at the nearest valid target. 

**Diving into a file (`f`, desktop only).** Press **Tab** on a selected file
— or right-click any file — to dive *into* it without leaving the palette.
With the query empty you get the file's outline — indented by level and
collapsible, like the navigation pane — and as you type you search that
file's blocks, tags, cites, and analytics. **Enter** inserts the chosen
object straight into your current document; **right-click** a search hit to
see it in context — the query clears and the outline opens to that spot,
ancestors expanded. **Esc** returns you to the file
list with your search restored. Undo (**Mod-Z**) works while you're diving,
so you can take an insert back without closing the palette.

**Pinning and speed.** Press **Alt-P** to pin or unpin the selected file
(★). Pinned files sort to the top and stay parsed for instant search;
your pinned and recent files are warmed in the background, and the file
list refreshes itself as files change on disk.

**Excluding files.** The **⊘** button beside the star hides a file from
file search everywhere, after a confirmation — useful for templates,
archives, or anything that keeps outranking what you actually want.
Manage the list (folders too — an excluded folder hides its whole
subtree) under **Settings → Files → File search: exclusions**. Excluding
a pinned file keeps the pin dormant; remove the exclusion and the star
comes back.

**How file results are ordered.** Matches rank by how well the query hits the
**name** — an exact name first, then a name the query *starts*, then a
word-start match (`war` → **War**ming, not Soft**war**e), then a match
anywhere in the name. You can now match on the **folder** too: `neg warming`
finds `Neg/Warming DA`, ranked below a plain name hit. Files that tie on match
quality — and the whole browse list before you've typed — fall back to your
**tie-break** setting: **Recency** (most-recently-edited first, the default)
or **Alphabetical**, under Settings → Files (or cycle it from the command
bar). Pinned files still sort above everything. Searching *inside* a file
ranks the same way, on each object's tag/heading text (or its cite),
breaking ties by document order.

**Quick Card tags.** With a quick-card result selected, **Tab** opens the
tag filter (the same active-tag filter the ribbon's Tag Picker controls),
so you can narrow cards by topic.

---

## 6. Quick Cards

Quick Cards are a personal library of reusable snippets — a stock card, a
standard overview, an analytic you paste constantly. Unlike Verbatim's
shortcut-word system, CardMirror's are tagged and searchable, and they're
available from **any window**.

- **Add** — select content and choose **Add** in the Quick Cards group
  (or run *Add Quick Card*). Give it a name and tags.
- **Search and insert** — open the palette with **Mod-Shift-Space** and
  the **`q`** prefix (or the **Search** ribbon button), filter by tag, and
  insert the match at your cursor.
- **Manage** — the Manage button opens the full list to rename, retag, or
  delete.

---

## 7. The multi-doc workspace

Verbatim shows you one document at a time. CardMirror can show up to **three
editable panes side by side**, which makes assembling a speech,
comparing files, and working on something while keeping something up for
reference against a block practical without juggling windows.

### Turning it on

Enable **Settings → General → Multi-doc workspace** and reload. With one
document open it looks like a normal editor; the layout fills in
as you open more. 

### Working with slots

- Each of the three slots is independent: its own outline section, its own
  footer word count (with its own **Σ** Word Count button), and its own
  document history. Think of each slot as its own "document pile." 
- **Mod-1 / Mod-2 / Mod-3** focus a slot; **Mod-Shift-1/2/3** move the
  active document into a slot.
- **Expand** a slot to full width with **Mod-Shift-F**, and restore it
  the same way.
- When you have more than one document in a slot, jump between them using
  the drop-down in the document's title bar or by using **Ctrl-Tab**.

### Per-document outlines

The navigation rail stacks one outline section per open document. Each is
independent:

- **Close one outline** — click the **×** at the top of a section (or the
  outline button in that document's title bar) to hide just that
  document's outline. The document stays open; the other outlines are
  untouched. Click the title-bar outline button again to bring it back.
  When every open document's outline is closed, the rail collapses and the
  panes reclaim the space.
- **Resize** — drag the divider between two sections to give one outline
  more height and the other less; double-click the divider to even them
  back out.

### Layouts

When all three slots are full, two layouts are available (pick in
Settings → General): **Compact** shows all three side by side, and
**Wide-scroll** shows two at a comfortable width with the edge of the
third peeking — click the peek or its nav pane, or use the focus shortcuts,
to snap to it.

### Moving content between panes

Drag a card, or a heading from a pane's outline, into another pane to
**copy** it there (the source keeps its copy). This is the same gesture
as [send-to-speech](#8-reading-and-delivering-a-speech).

---

## 8. Reading and delivering a speech

### Read mode

Click the **eye** in the ribbon (or bind a key to *Toggle Read Mode*) to
enter read mode — CardMirror's version of Verbatim's invisibility, with
two improvements:

- It hides everything that isn't read aloud: only **Tags, Cites,
  Analytics, and highlighted text** stay visible. Loose paragraphs,
  undertags, and un-highlighted body text disappear.
- It **locks the keyboard**, so a stray key or trackpad twitch at the
  podium can't edit your file.

Only two editing actions are allowed in read mode. First, you can drop a
**reading-position marker** — red text like "Marked 7:32" at your cursor
(Verbatim's red-text convention), for when you stop mid-card. In read mode
it's deliberately effortless: **Space, Enter, or Mod-Shift-D** all drop one;
triggering it again on a marker removes it. (Red text stays visible in read
mode, so the marker shows.)

You can also drop a marker while editing — **Mod-Shift-D** works any time
(Space and Enter only stand in for it inside read mode).

Second, you can perform **click-and drag** actions - move headers around in
the document, add received cards to your document, or grab cards from the
Dropzone.

Press the eye again to exit. In the
[multi-doc workspace](#7-the-multi-doc-workspace), read mode is
per-pane, so one slot can be a reading surface while another stays
editable.

### Reading view

Click the **book** in the ribbon (or bind a key to *Toggle Reading
View*) to flip the document into Word-style full-screen pages: one to
three columns sized from the pane's width, flipped a whole screen at a
time. It's built for reading a speech without scrolling — every flip
lands on a clean page boundary, and tags and cites are kept with the
first line of their card so nothing strands at a column bottom.

Flipping: **←/→**, **PgUp/PgDn**, **Space / Shift-Space**, one
mouse-wheel click (or one trackpad swipe), or the click zones at the
left and right edges. **Home/End** jump to the first and last page,
and the indicator at the bottom shows where you are. The navigation
pane stays available — clicking an entry lands on the page containing
it.

Like read mode, reading view locks editing; dropping a
[reading marker](#read-mode) is the only edit allowed (drag-and-drop
is disabled entirely here). The two combine well: read mode strips the
document down to what's read aloud, and reading view paginates
whatever is showing — together they're a teleprompter. Reading view is
per-document in the [multi-doc workspace](#7-the-multi-doc-workspace),
so stack your speech docs in one slot, flip each into reading view as
you finish prepping it, and full-screen the slot when you stand up.

The maximum-text-width accessibility cap bounds the column width, and
page flips animate by default — **Reduce animations in reading view**
(Settings → Accessibility) or the global reduce-motion preference
makes them instant.

### Read-time estimates

The status bar shows live read-time estimates — how long the visible
(read-aloud) content would take to deliver. Configure your readers in
**Settings → General → "Readers for read-time estimates"**: each reader
is a name plus a words-per-minute rate, and you can list as many as you
like. Each reader can also carry an optional **second rate for tags,
analytics, and cites** — most people deliver those faster than
highlighted card bodies. Leave it blank ("same") and the main rate
covers everything; set it, and every readout splits the math (the Word
Count dialog shows both, e.g. "200 / 260"). The **first two** readers appear live in the status bar; the
numbers update as you highlight and trim.

Click the word count (the **Σ** button / Word Count) for the full
breakdown — that dialog shows the read time for **every** reader on your
list, not just the two in the bar, and the word count and read time for
the current selection.

The bar also shows a second, **enclosing-container** readout — the read
time of the smallest structure your cursor is inside: the **card**, the
**analytic**, or the **block section** (a block heading through the next
equal-or-higher heading): `Doc: 1,234 · Amy: 8:12 | Card: 42 ·
Amy: 0:31`. Select text and the second readout shows the **selection's**
time instead. On pocket or hat headings (and content outside any card
or block) it stays quiet — the whole-doc number covers those scales. In
the three-pane workspace, each pane's footer tracks its own cursor.
Controlled by **Settings → General → "Live read time for the enclosing
card / block"** — on by default, and cheap even on large files (the
count is cached per container, so moving the cursor doesn't re-count
anything). Turning it off restores the plain whole-doc readout exactly
as it was.

A third readout — **what's left to read** — is available and **off by
default**: turn on **Settings → General → "Live read time for what is
left to read"** and the bar appends everything still ahead of your
cursor, from the cursor to the end of the document, with each reader's
time for it: `Doc: 1,234 · Amy: 8:12 | Card: 42 · Amy: 0:31 | Left: 806
· Amy: 5:20`. Only read-aloud text counts, same as every other readout,
so trimming highlights lowers it. Select text and it measures from the
**end** of the selection — a selection reads as "I've been through this
much". It's cheap on large files too: CardMirror keeps a running total
per section of the document, so moving the cursor only re-counts the
card or paragraph it lands in.

By default the primary readout always reflects the **whole document**.
Turn on **Settings → General → "Live selection word count"** to have the
bar switch to the **selection's** word count and read time the moment you
select text — handy for checking how long a block will take before you
send it. It's off by default because re-counting on every selection
change can lag on very large files; with it off, use the **Σ** button to
get a selection's read time on demand. (With the enclosing-container
readout on, a selection's time already appears in the second readout
either way.)

### The speech and prep timer

The ribbon's **timer** button shows or hides a compact timer panel for running
speeches and prep in a round. Left to right it holds **Reset** (↻, which resets
every clock) stacked over **Pop out** (⇱, desktop only), the big **time
display**, **Start / Pause** (▶), three **speech preset** buttons, and the
**Aff** and **Neg** prep clocks.

- **Speech timer.** Click a preset to load that length — the presets come from
  the active timer profile (College, High School, or Pomodoro) — then Start /
  Pause to run it down. As the clock crosses each configured **alert point**
  (Settings → Appearance → Timer display; e.g. "60, 30, 5, 3, 1" seconds
  remaining) it can flash red, play a short beep, or both — see the Audible
  alerts bullet below. When time runs out, the display turns solid red and
  stays red until you re-arm that clock — load a preset, hit Reset, or type
  a new time. (Pausing or switching clocks doesn't dismiss it; the sound,
  if on, is a single double beep, never repeated.)

- **Pop the timer out** *(desktop)*. The **⇱** button moves the timer into a
  small floating window that stays on top of every app — handy for keeping
  speech and prep time in view while reading a speech doc or anything else.
  While popped out, the timer leaves the CardMirror ribbon entirely (it is
  never in both places); the float drives the same shared clocks, and its **⇲**
  button — or closing the float, or hiding the timer from any window — pops it
  back in. Drag anywhere on the float to move it. The timer always starts a
  fresh launch inside the app; pop it back out when you need it.

- **Audible alerts** *(off by default; Settings → Appearance → Timer display)*.
  An accessibility option that plays a short beep at each alert point and a
  distinct double beep when time runs out. Exactly one sound plays no matter
  how many windows are open — the popped-out timer included — and the beeps
  stay on time even when CardMirror is buried behind other apps. Volume is
  adjustable.

- **Prep clocks.** Click **Aff** or **Neg** to run that side's prep; each keeps
  its own remaining balance and only counts down while it's the running clock, so
  you can switch sides freely. When a prep clock is loaded, the big display takes
  on that side's styling — the **Prep button label style** setting (text `A:` /
  `N:`, color, or both) now also marks the display, so it's clear at a glance that
  the time shown is prep, and whose.

- **Edit a clock.** While a clock is **paused**, click the big display to type a
  new time — either **`MM:SS`**, or bare digits keypad-style, where the last two
  digits are seconds (`800` → 8:00, `130` → 1:30; one or two digits are just
  seconds, so `90` → 1:30). Handy if you started or stopped a beat late. For a
  prep clock the edit is saved to that side's prep balance, so it sticks when
  you switch clocks and back (until you Reset).

- **Switching profiles.** The **Cycle Timer Preset** command (unbound by default
  — assign a key under Settings → Keybindings) cycles the profile College → High
  School → Pomodoro, applies that profile's durations, and pops the timer into
  view. You can also set the profile and edit each profile's speech durations and
  per-side prep total under Settings → General; the compact layout lives under
  Settings → Appearance.

- **Keyboard transport.** Eight more unbound commands drive the timer from the
  keyboard (assign keys under Settings → Keyboard): **Timer: Show / Hide
  Panel**, **Timer: Start / Pause**, **Timer: Start Speech Preset 1–3** (loads
  that preset *and* starts it counting), **Timer: Start Aff Prep** / **Start
  Neg Prep** (switches to that side's clock and starts it), and **Timer:
  Reset**. Apart from Show / Hide, they only fire while the timer panel is
  visible, and — like the buttons — a press in one window drives the clocks in
  every window.

### Send-to-speech and the dropzone

Assemble a speech document by sending cards into it:

1. **Mark a speech doc.** Open the document you'll read from and mark it
   as the active speech (in the Speech group, or *Mark Active as Speech*).
2. **Send cards.** From a source file, press **`` ` ``** (backtick) to
   send the current card or selection to the speech doc at your cursor,
   or **Alt-`` ` ``** to append it at the end. You can also drag a card or
   heading across panes.
3. **Read.** Switch the speech doc to read mode; everything that isn't
   read aloud (loose paragraphs, undertags, un-highlighted text) drops
   away, leaving what you'll deliver.

The **dropzone** is a holding shelf: press **Mod-`` ` ``** to send a card
there and pull it back later — useful for parking common evidence temporarily,
or parking a card you know you need but are not sure where to put yet.

### Saving a send doc

When it's time to share a speech with the judge or opponent, use the
**Send Doc** options described under
[Saving and file formats](#16-saving-and-file-formats) — a clean copy
with comments, analytics, and undertags stripped — either through Save As
or in one keystroke with **Save Send Doc (Mod-Alt-S)**.

### Saving marked cards

To send a copy of just the cards you marked in your speech, use **Save Marked Cards** 
— it pulls just those cards out and saves them on their own, in your default format. 
Two ways in: a **Marked Doc** button in the Save As dialog, and a **Save Marked Cards** 
command (default **Mod-Alt-M**, rebindable) that saves silently to a destination you 
choose under Settings → *Marked Cards destination* (the source file's folder, or a 
fixed folder), using the `MARKED_` filename prefix and your default format — mirroring 
Save Send Doc. It keeps cards only (analytics and headings are dropped); if nothing is marked,
it does nothing and tells you so.

---

## 9. Collaboration

There are two collaboration features: **card sharing** (send cards to
another machine) and **co-editing** (edit a document together in real time).
Both are off until you enable them, and both are end-to-end encrypted — the
relay server that passes traffic along sees only scrambled data. Both work
in the desktop app and the web editor (see
**[Collaboration on the web](#collaboration-on-the-web)** below); the web
edition's mobile layout has neither.

### Setting up

1. In **Settings → Collaboration**, turn on **Enable collaboration**. Two
   pills — **Send** and **Receive** — appear next to the dropzone, and your
   machine gets a **pairing code**, shown in the same settings section.
2. Swap codes. Give your code to anyone who should be able to send to you.
   To send to *them*, paste the code they gave you under **Recipients** and
   give it a name.
3. To cooperate just once, run the **Start Collaboration Session** command from
   the command bar. This will copy a document code to your clipboard. Anyone you
   share this code with will be able to collaborate on your document by running the
   **Join Collaboration Session** command and pasting the code. 
4. Optional, all in the same settings section:
   - **Groups** — a named set of recipients; sending to a group sends to
     every member. The **↑ / ↓** arrows reorder recipients and groups, and
     the Send pill lists them in that order.
   - **Star** one recipient or group to make it the target of the
     one-keystroke commands mentioned below (starring another moves the
     star).
   - **Your display name** — stamped on cards you send and on your cursor when
     co-editing, so someone who hasn't named your code yet still sees who it's from.
   - **Blocked senders** — cards and invites from these codes are dropped
     silently.

**Debate Decoded account.** A linked paid membership is required for card sharing and co-editing on the official relay. To link: click **Open the connect page** in the settings row (or visit
[debate-decoded.ghost.io/cardmirror-connect](https://debate-decoded.ghost.io/cardmirror-connect/)),
sign in, and paste the code the page shows into the settings row. Codes are
single-use and expire after ten minutes. A membership covers **two
machines**; linking a third shows your linked machines and asks which one to
unlink (older relays unlink the oldest automatically).
**Disconnect** unlinks this machine; regenerating your pairing code also
unlinks it.

### Sending and receiving cards

**Send:** drag a card — from the document, the dropzone, or the Receive
pill — onto the **Send** pill. It expands into your recipients and groups;
drop on a row to send. Dragging a **multi-selection** (from the nav pane)
sends everything as **one bundle**: the recipient sees a single item and
takes the whole set at once. **Send to Starred** sends the card under the
cursor (or the current selection) to your starred target without opening
the pill; **Send to Recipient** (unbound by default — run it from the
command bar or give it a key) does the same but asks which contact or
group to send to first.

The pill's bottom row does more than send. **Clicking** the pill opens it
with two buttons there: **Add contact** (paste a pairing code, name them,
and they join the bottom of your recipients) and **Start session** (the
same flow as the Start Collaboration Session command, for the current
document). While **dragging**, the same two spots become drop zones:
the left sends the card to a pasted pairing code as a one-off (no contact
saved), and hovering the right opens a list of people who **recently sent
you** things — drop on one to send back, no pairing setup needed.

Recipients you rarely send to can be **hidden** (the eye button in
Settings → Collaboration → Recipients): a hidden contact disappears from
the pill without being deleted — groups still reach them, and a hidden
starred partner still gets Send to Starred. **Recent senders** in the same
settings tab lists everyone who recently sent you cards or a session
invite; add them to your recipients (and name them) or block them from
there.

**Receive:** incoming cards land in the **Receive** pill, which flashes
and shows a "total · N new" badge. Click it to open the inbox; each
row shows the card's label, who sent it, and when. From a row:

- **Click** inserts the card at the cursor; **Alt-click** appends it at the
  end of the document; or **drag** it in like any dropzone item. Inserting
  copies — the card stays in the pill until you ✕ it. A bundled
  multi-selection send shows a **×N** count and is taken as one piece —
  click, drag, and ✕ all act on the whole bundle.
- Inserted cards fold in the nav pane to your current outline depth
  instead of arriving fully expanded.
- **Mod-P** inserts the most recently received card at the cursor, and
  **Mod-Alt-P** appends it, without opening the pill (both rebindable).

The flash is configurable — **Flash the Receive pill on a new card**: once,
every 10 seconds until you open the pill, or off.

The Receive pill also appears on the **Home screen** (bottom center), so
session invitations can be seen and joined without opening a document
first. Received *cards* still need an open document to insert into —
while the Home screen is up, inserting shows a note instead, and the
card stays in the pill.

**Delivery:** cards arrive instantly over a live push connection, with a
catch-up on every reconnect (waking from sleep included). Unretrieved cards
are deleted from the relay after **three hours**. 

### Co-editing

Up to **10 people** can edit one document live — typing,
cursors, and comments all sync, and simultaneous edits merge automatically. 
The document belongs to the **host**; everyone else edits a synced copy, 
and everyone keeps their copy when the session ends. A session is not a 
permanent shared document: when the host ends it — or after about a week 
idle — it's gone and participants retain local copies.

**Invite from your recipients:** click the **Send** pill and press the
invite button on a recipient or group row. That starts a session on the
current document and sends the invite; the recipient
gets a **SESSION** row in their Receive pill and clicks **Join**.
**Invite Starred Partner to Session** does the same for your starred target
in one keystroke. Anyone in a session can invite others, not just the host.
Inviting requires the person's code in *your* Recipients list.

**Or use a share code:** run **Start Collaboration Session** (ribbon
**Collaboration** group, or the command bar). It confirms which document
you're sharing, then copies a **share code** to the clipboard — send it
however you like (**Copy Session Share Code** re-copies it). The other
person runs **Join Collaboration Session** and pastes it. The shared
document opens in a new window — in three-pane, you pick which pane.

**Interruptions:** joiners past the 10-person cap get a "session is full"
message until someone leaves. Offline edits queue and sync on reconnect
(a notice appears only after a real offline stretch whose sync actually
changed the document). You can close the app entirely — the session is
saved under **Sessions** on the home screen, and rejoining syncs your
offline changes. If you saved your session copy to disk and later open
that **file** while the session still exists, CardMirror asks whether to
**rejoin** (the document reconnects in place) or **leave** (the file
becomes an independent copy) — editing the file outside a live session
would otherwise split it into two diverging copies with the same name. Switching
between single-pane and three-pane closes co-edited documents (the dialog
warns you); reopen them from the Sessions list. Each open document runs its
own independent session, so several can be live at once; in three-pane,
each pane's footer shows its own session's collaborators.

**Ending or leaving:** run **End or Leave Collaboration Session** — the
host ends it for everyone, a guest just leaves; either way each person
keeps their current copy. Closing a co-edited document asks whether to keep
the session (rejoin later from the Sessions list) or end/leave it now. The
✕ on a home-screen Sessions row: as host, asks whether to end for everyone
or just forget your copy; as guest, forgets your copy.

### Collaboration on the web

Everything above works in the web editor on a desktop-layout browser —
including a Chromebook, and including the installed web app. The
differences:

- **Invite links.** Starting a session on the web copies an **invite
  link** (`https://cardmirror.app/#join=…`) instead of a bare share
  code; on any edition, **Copy Session Invite Link** produces one for
  the current session. Opening the link in a desktop-layout browser
  offers the join directly — no account, no setup; pasting it into the
  **Join Collaboration Session** dialog works too, so a Chromebook with
  the app already open can join from a link received in a chat. Treat
  the link like the document itself: it carries the session's
  encryption key, and anyone holding it can join. A guest who closes
  the tab can rejoin later from **Sessions** on the home screen — same
  browser, same profile.
- **Your account lives in the browser profile.** Card sharing (both
  sending and receiving) and *hosting* sessions on the web need your
  Debate Decoded account linked from Settings → Collaboration — the
  same connect-code flow as desktop, and a linked browser counts as one
  of your membership's machines. The link is stored in that browser
  profile, so a private/incognito window or clearing site data leaves
  it behind (relink to recover; the seat is reclaimed, not lost).
- **Tabs coordinate.** With several CardMirror tabs open, incoming
  cards arrive exactly once — whichever tab is leading receives for all
  of them, the same way the timer and send-to-speech already cooperate
  across tabs.

Phones and small screens get the mobile layout, which has no
collaboration; an invite link opened there explains it needs a
computer. CardMirror Lite has no collaboration in either edition.

### Privacy and self-hosting

Cards and sessions are end-to-end encrypted — the relay never sees content,
sender, or recipient, forgets card mailboxes after three hours, and deletes
idle session rooms after about a week. Sender codes are self-declared, so
**Blocked senders** is a convenience filter, not a security guarantee.

To run your own relay: the `relay/` folder of the repo deploys standalone
(one `docker compose up`; see its README). Set **Custom relay URL** (e.g.
`https://relay.example.com/relay`) and **Custom relay token** (the
`RELAY_TOKEN` you configured on it) in Settings → Collaboration. Everyone
collaborating must point at the same relay; leave both fields empty to use
the official relay.

---

## 10. Live views and linked copies

CardMirror can show one section of content in more than one place, kept
connected to its source. There are two flavors, and the difference is simple —
**do you want a window that shows the original, or make a self-updating copy?**

- A **live view** is a read-only window onto another section of *this*
  document. It always shows the source's current content — edit the source and
  the view updates instantly. You don't edit *through* it; you edit at the
  source. Nothing is duplicated.
- A **linked copy** is your own *editable* copy of a section, kept linked to its
  source so you can **Refresh** it and get nudged when the original changes. The
  source can be **another file** (pull a block from a backfile) or **this
  document**.

|                | This document | Another file |
| -------------- | ------------- | ------------ |
| **Live view**  | ✓             | —            |
| **Linked copy**| ✓             | ✓            |

**Make one.** From the command bar (Mod-Shift-Space, or the ribbon):

- **Insert Live View** / **Insert Linked Copy from This Document** — pick a
  section of the current document. The picker is a collapsible outline of your
  headings with a filter box — type a few letters to narrow it, use the arrow
  keys, press Enter to pick.
- **Insert Linked Copy from a File** — open the Search Everything palette, dive
  into the source file, land on a heading — or on a card's tag, to copy just
  that one card — and press **Mod-Enter**. The source
  can be a `.cmir` or a Word `.docx`; for a Word file CardMirror adds a small,
  invisible bookmark so it can find the section again (nothing else changes), and
  declines if it can't. *(Making and refreshing a copy from a file is
  desktop-only — it reads the other file from disk; in-document views and copies
  work everywhere.)*

**Spot one.** A live view shows a **dotted green rail** that brightens on hover;
a linked copy shows a **solid teal rail**. In the navigation pane, both show
their content under a matching green rail so you can see at a glance which parts
of your outline are borrowed. A small glyph at the top-left opens the menu.

**Edit.** A *linked copy* is fully editable in place — cut, highlight, re-tag —
without unlinking. Once you change a copy so it no longer matches its source, its
glyph icon turns from an intact chain into a **broken chain** — a reminder that
your copy has diverged from the original (a Refresh would replace your edits). A
*live view* is read-only; to change what it shows, edit the source (use **Go to
source section** in the menu to jump there). Pressing **Enter** at the very
bottom of a live view starts a new line just below it.

**When the source moves on.** Separately from your own edits, a linked copy can
drift because its *source* changed. CardMirror marks such a copy with a small
colored **"source updated" dot** on the glyph (the menu says *Source has new
content · Refresh to update*) — it
checks when you open a document, periodically while it's idle, and on demand via
*Check Linked Copy Sources for Updates*. Nothing is overwritten until you
**Refresh**. (For a copy from *this document* the badge tracks the live section,
so it appears the moment the source diverges.) You can recolor the badge under
Settings → Appearance → Style colors ("Linked-copy source-updated badge"). A live
view never shows this — it's always current, so there's nothing to flag.

**Refresh** (linked copies). *Refresh Linked Copy* (command bar, or the glyph
menu) re-pulls the current source into the copy your cursor is in; *Refresh All
Linked Copies* does the whole document behind one confirmation. If you've edited
a copy, CardMirror confirms before overwriting your changes; if the source
heading has been *emptied*, a refresh keeps your cached copy rather than blanking
it.

**The glyph menu.** A **linked copy** offers Open source file (or Go to source
section, for an in-document copy) · Refresh from source · Re-pick source (file
copies) · Unlink (keep the content as ordinary cards) · Delete. A **live view**
offers Go to source section · Re-pick source · Unlink (freezes the current view
into editable cards and stops tracking) · Delete.

**Nesting.** A linked copy can contain a live view (a static copy with a live
window inside it — that's fine). Live views can even be nested and CardMirror
resolves them recursively; if a view points back at itself through a chain, the
cycle is detected and left out with a small notice.

**Word (`.docx`) flattens everything.** Live views and linked copies only stay
connected in CardMirror's own `.cmir` format. **Saving to Word flattens every
view and copy to plain cards and drops the link** — the content stays, but it
stops being connected, and re-opening that `.docx` won't bring the links back.
CardMirror warns you before any `.docx` save that would do this — including
when you save while closing a document. Keep the working copy as `.cmir` if
you want them live; export to `.docx` only for a hand-off.

---

## 11. Comments and notes

Toggle the **comments column** on the right with the Comments button. It
holds four kinds of entity, each pinned beside the text it refers to:

Keeping the comments column open slightly degrades editor performance
(its cards reposition as you scroll and edit). If a large file feels
sluggish, hiding it may help.

| Entity | Travels in the shared file? | What it's for |
|--------|-----------------------------|----------------|
| **Comment** | Yes (standard Word comment) | Feedback others should see |
| **AI note** | No, unless you opt in | Answers from Ask AI |
| **Private note** | No, unless you opt in | Your own annotations |
| **Flashcard** | No, never | Study material (see [Learn](#12-learn-spaced-repetition-flashcards)) |

- **Add a comment** to a selection from the comments cluster; comments
  are threads — others can reply.
- **Add a note (Mod-Shift-N)** for a private annotation. Notes are green
  throughout — chip, in-text highlight, card accent — and behave like
  comments (a root message plus replies) but stay on your machine.
- **Edit in place** — hover a comment, reply, or note and a pencil
  appears; Enter saves, Esc cancels. Typing boxes start one line tall
  and grow as you type (up to a few lines, then they scroll).
- **Resolve** — the check on a comment's header marks the thread
  handled: the card dims, and the state travels with the file (it's
  Word's own resolve, so threads you resolve here show resolved in
  Word and vice versa). Click again to reopen. It works on collapsed
  cards too, so acknowledging feedback never takes more than one
  click.
- **👍** — the thumbs-up beside the reply box posts a one-click 👍
  reply: a fast "seen it" that needs no typing and travels everywhere
  a normal reply does.
- **Copied text brings its comments along.** Copy a commented span and
  paste it — in another document, another window, or the same one —
  and the comment comes with it. Pasting where the comment already
  exists duplicates it (Word's behavior), so each pasted copy has its
  own thread. The same holds for every other way of copying content
  (Alt-drag, nav-pane copies, the dropzone): each copy gets its own
  comment, and a comment's range only ever grows by typing inside it.
  If commented content arrives where its comment can't follow — a card
  sent from another machine — the stray highlight is dropped rather
  than shown empty.
- Click a note's or comment's colored text to jump to its card.
- **Annotate a picture, too.** Comments, notes, and Ask AI all work on a
  selected image — or on a span of text that includes images, not just
  plain text. They re-anchor by content when the document changes, the
  same as text annotations, and a comment on an image is preserved when
  you save to Word.

**Privacy.** Private notes, AI notes, and flashcards live in your local
layer and **do not** get written into the `.docx`/`.cmir` you share — so
your study material and private thoughts don't leak to opponents. If you
*want* to include them (say, sharing notes with a partner), the **Save As**
dialog has opt-in checkboxes (off by default) to write private notes
and/or AI comments into the saved file as real Word comments. Flashcards
never travel.

A comment or note whose anchor text was edited away by someone else moves
to an **Unanchored** section at the bottom of the column, with a
**Re-ground** button: select text and re-attach it.

---

## 12. Learn: spaced-repetition flashcards

CardMirror can turn your evidence into spaced-repetition flashcards, so
you can study your files. 

The cards live **only on your machine** and never travel with a shared
file — your study material stays yours. (The design and the research
behind it are written up in the project's ARCHITECTURE doc.)

### Making a card

Select some text and run **Create Flashcard** (in the comments cluster).
You can make two kinds:

- **Question and answer** — write a question and its answer.
- **Cloze deletion** — hide a word or phrase in the selected sentence;
  reviewing asks you to recall the hidden part.

The card is **anchored** to the text you selected, and shows up in the
comments column beside it.

### Reviewing

The **Home screen's Learn section** shows what's due and runs your
reviews. In a session, you see the front of each card, reveal the answer,
and grade yourself **remembered** or **forgotten**. Remembered cards move
out along an expanding schedule; a forgotten card is shown again later in
the **same session** before you finish — a retry step that measurably
improves recall.

You can review everything due, or scope a session to a single file or
deck.

### Managing cards

Open **Manage Flashcards** from its button in the ribbon's comments
cluster (next to Create Flashcard). It lists your cards grouped by file,
where you can edit, suspend, or delete them. If a card's anchor text
changes or its file moves, the card becomes **unanchored** — it keeps its
schedule, and you can **re-ground** it by selecting text again, or link
it to a different file.

The button shows a small **red dot** when one or more cards are due for
review today — a nudge to start a session. If you'd rather not be nudged,
turn it off under Settings → Appearance → **Flashcards-due dot**.

---

## 13. AI features

A handful of features call a large language model. They're **off by
default** and require a key. Two providers are supported, chosen under
**Settings → Comments & AI → AI provider**: **Anthropic** (the default —
CardMirror talks straight to Anthropic's Claude, and picks a current model
automatically) and **OpenRouter** (one account that can route to many
models, including Claude).

### Setup (Anthropic, the default)

You need an Anthropic API key — a personal access code that lets
CardMirror talk to Claude on your behalf. It's separate from a Claude.ai
chat account, and there's no free API tier, so expect to put in a small
amount of credit. If you've never made one, here's the whole process:

1. Go to [console.anthropic.com](https://console.anthropic.com/) and
   **sign up** (or sign in — a Claude.ai login works, but the console
   account and its billing are separate from any chat subscription).
2. Add credit: find **Billing** (or **Plans & billing**) in the console
   and buy the minimum credit — a few dollars goes a very long way; a
   typical CardMirror AI action costs a fraction of a cent, so $5 can
   last a season. Without credit, requests are refused.
3. Open the **API keys** page, click **Create key**, give it any name
   (e.g. "CardMirror"), and **copy it immediately** — the full key
   (it starts with `sk-ant-`) is shown only once. If you lose it, just
   delete that key and create a new one.
4. In CardMirror, open **Settings → Comments & AI**, turn **AI
   features** on, and paste the key into the **Anthropic API key**
   field.

Treat the key like a password: anyone who has it can spend your
credit. Don't share it, don't paste it into documents you send.

### Setup (OpenRouter)

If you'd rather use [OpenRouter](https://openrouter.ai/) — say, you
already have an account there, or you want a non-Claude model — set **AI
provider** to **OpenRouter**, paste your key (from openrouter.ai →
**Keys**) into the **OpenRouter API key** field, and fill in the
**OpenRouter model** field with a model id from their catalog (for
example `anthropic/claude-sonnet-4.6`). The model field is **required**:
there is no built-in default, and AI features won't run until it's set.
Two things to know:

- CardMirror's prompts are written and tested against Claude. Other
  models generally work, but cite formatting, text repair, and table
  extraction are tuned for Claude — an `anthropic/…` model id is the
  safe choice.
- OpenRouter is a routing service: it forwards each request to the
  company that serves the model you picked. Free-tier models on
  OpenRouter may allow their operators to train on your prompts — avoid
  them for evidence you care about (see the privacy policy).

### Keys and privacy

Whichever provider you pick, the key is stored locally and sent directly
to that provider when you trigger a feature — it doesn't pass through
any CardMirror server. API keys are also stripped from settings exports,
so sharing a settings file never shares a key. With AI off, every AI
control is hidden, and AI features gray out cleanly when you're offline.

### What AI can do

| Feature | How to run it | What it does |
|---------|---------------|--------------|
| **Format Cite** | Mod-Shift-X on a selection | Turns a pasted citation or URL into a properly styled cite, with the cite mark on the author and date. |
| **Reformat Every Cite** | Search Everything → "reformat all cites" (unbound; assign a key in Settings → Keyboard) | Runs **Format Cite** over every cite in the open document, one at a time. Because that is one model request per cite, a confirmation first tells you how many requests it will make, and the pass never makes more than that — cites pasted in mid-run are left for a second pass. Each cite is its own undo step, **Esc** stops the pass after the cite in flight, and a summary reports how many were reformatted, failed, or were left unstyled. Three failures in a row (a rejected key, an exhausted quota) end the run instead of repeating the same failure on every remaining cite. One document can only have one pass running at a time, but in three-pane mode each pane can run its own, and **Esc** then stops the pass in the pane you are working in. |
| **Repair Text** | Mod-Shift-R on a selection | Fixes OCR / PDF extraction errors (dropped ligatures, `rn`/`m`, mid-word hyphenation, run-together words) without changing the wording. Corrections apply in place, one at a time with a highlight; the whole repair is a single undo. |
| **Repair Formatting** | Mod-Alt-R on a selection | Normalizes an imported card's formatting to Verbatim's four-layer scheme (underline / emphasis / highlighting / background color) — fixing bold or italics standing in for emphasis, direct underlining, bold-underline, and underlining lost to an unsupported style. It never changes your text. |
| **Translate** | Mod-Shift-T on a selection | Translates the selection and copies it to the clipboard, leaving your document unchanged. Uses your AI provider when AI is on; otherwise falls back to a free, keyless backend, so it works even with AI off. |
| **Ask AI about selection** | Mod-Shift-Q on a selection | Asks Claude a question about the selection — including any images in it (up to five pictures are sent to the model), with the surrounding card as context; the answer lands as an AI note. Works on a selected image on its own, too ("what does this chart show?"). Or type **@AI** in any comment or note — including its first message — to summon the AI right there; once a thread has an AI reply, further replies continue the conversation. |
| **Generate alt text** | Right-click an image | Writes an alt-text description and inserts it under the image; offers to keep or regenerate if the image already has alt text. |
| **Generate table from image** | Right-click an image | Extracts a real, editable table from a picture of one. |
| **Draft a flashcard** | From Create Flashcard | Drafts a question/answer or cloze from the selection. |

You can set the author name AI notes are attributed under, customize
the cite-formatting prompt, and — on the Anthropic provider — point AI
at a specific Claude model (**AI model (advanced)** — leave blank to use
the model built into your release) in Settings → Comments & AI. If a
model is ever retired, AI features show a message telling you to update
CardMirror or set a newer model id there. On OpenRouter, the model is
whatever the **OpenRouter model** field says. **Max output tokens** caps
how long AI replies can run (both providers); if you use a reasoning
model, raise it — hidden thinking spends from the same budget, and too
low a cap can cut the answer off.

You can keep working while an AI action runs, and you can run more than one
at once — they don't trip over each other. Each action reserves the stretch
of text it's working on: edits you make elsewhere (or another AI action's
edits) move its target along so the result still lands in the right place.
While an action is working on a stretch, that stretch is locked — typing
into it does nothing and the locked text flashes — but the rest of the
document stays editable. Starting a second action on text another action is
already working on just asks you to try again in a moment.

### Repair Text

Select text pulled from a PDF or OCR and press **Mod-Shift-R** to clean up
extraction artifacts — dropped ligatures (`signicant` → significant),
`rn`/`m` mix-ups, words split across a line with a hyphen (`re-` / `search`
→ research, rejoining the break), run-together words, and stray
spaces/punctuation. It's deliberately conservative: it only touches clear
extraction errors and never rewrites your wording. The AI returns just the
specific fixes (not a rewrite), which apply directly in your document —
each correction appears one at a time with a brief highlight, and the
entire repair undoes in a single step. Requires AI features.

### Repair Formatting

Select body text and press **Mod-Alt-R** to normalize a card's formatting
to Verbatim's four-layer scheme: **underline** for the broad pass,
**emphasis** for what stands out within it, **highlighting** for what's
read aloud, and **background color** to set off some of that highlighting.
It fixes
the classic ways an imported card breaks down — bold or italics standing
in for emphasis, direct underlining used instead of the named underline
style, bold-underline used for all underlining, and underlining destroyed
by an unsupported style (recoverable from the font size). Bold and italics
are left alone where they're a deliberate extra layer or reproduce the
source (book titles, foreign terms).

The model **never touches your text**: it returns a mapping from each
formatting pattern to what that pattern should become, and the editor
applies it. It works on one card at a time, on body paragraphs only —
never tags, cites, or headings — leaves your colors and font sizes
untouched, and is a single undo. Requires AI features.

### Translate

Select text and press **Mod-Shift-T** to translate it and copy the result
to the clipboard (your document isn't changed — paste the translation
where you want it). Configure it under Settings → Editing → **Translation**:

- **Backend** — **MyMemory** (free, needs no key, and works even with AI
  features off; add your email to raise its daily limit), **AI provider**
  (used when AI features are on; highest quality — it translates through
  whichever provider you picked under Comments & AI, Anthropic or
  OpenRouter), or **Google Cloud Translation** (paste a Google API key).
  The default, *Automatic*, uses the AI backend when AI is on and
  MyMemory otherwise.
- **Languages** — the source auto-detects; the target defaults to English
  and is configurable.
- **Marker** — by default a `[TRANSLATION BY …]` line is placed above the
  translation on the clipboard, naming the engine (the Claude model for
  Anthropic, OPENROUTER, MYMEMORY, or GOOGLE TRANSLATE). It uses the same
  delimiter as "Condense with warning" and is protected from Shrink. Turn
  it off in the same settings group.

A note on AI translation (either provider): the prompt directs the model
to preserve the original meaning above all, but its output isn't
deterministic —
re-running can reword slightly. Keep that in mind in leagues or circuits
where translated evidence needs a paper trail or reproducibility.

### Clod mode

A bit of fun, off by default (Settings → Comments & AI → **Enable Clod
mode**). While the AI is composing a reply, the
"Thinking…" placeholder is replaced by a friendlier persona — "Clod" —
who cycles through time-of-day activities like "Clod is making toast…" or
"Clod is reading by candlelight…". The persona's name, pronouns, and
activity lists are all customizable.

---

## 14. Send to Verbatim Flow

**(Windows only. Experimental.)** With Excel open and a workbook whose name
contains "Flow", CardMirror can push your work straight into Verbatim
Flow. Commands send the selected tags, cites, or text into Flow's current
column, pull the selected Flow cells back into your document, or open a new
Flow from the Verbatim template. They drive Excel directly and need no
changes to Verbatim Flow itself.

The **Send Headings to Flow** variants send only the heading-level labels
— and from a cite line, only the marked citation (the same short cite the
navigation pane previews), not the whole bibliographic paragraph.

**Keeping the connection warm.** The first time you use a Flow command in a
session, CardMirror opens a background connection to Excel and keeps it
open, so every send and pull after that is near-instant instead of pausing
a second or more to reconnect. If you'd rather not wait on that first send
mid-round, warm the connection ahead of time with the **Start Flow
Connection** command, or turn on **"Keep a Verbatim Flow connection warm"**
at the bottom of Settings → **Plugins** to open it automatically the moment
CardMirror launches (it works regardless of the Enable plugins switch). The
connection closes when you quit.

These commands aren't on the ribbon and have no default shortcuts — find
them in the command palette, or bind keys to them under **Settings →
Keyboard shortcuts**. They appear only on Windows.

---

## 15. Voice control

**(Desktop only. Experimental.)** Press **Ctrl-Shift-V** to start a
hands-free editing session and work a card by voice — read text aloud to
ink it, dictate tags and cites, and move around the document without
touching the keyboard. Recognition runs **entirely on your own machine** —
no audio ever leaves it, with or without a network connection.

The speech model is a **one-time ~130 MB download** rather than part of
the installer, so the app itself stays small for the many people who never
use voice. The first time you turn voice on, CardMirror asks to download it
and notifies you when it's ready (you can keep working meanwhile — it does
not start listening on its own). If you'll be somewhere without a
connection, download it ahead of time under **Settings → Accessibility →
Dictation accuracy model**.

This is early, experimental software; expect rough edges, particularly
pertaining to the voice recognition model, and keep the keyboard within
reach. On macOS, voice requires Apple Silicon.

### Starting a session

**Ctrl-Shift-V** turns the microphone on. A **status pill** appears
showing whether CardMirror is listening, the current **mode** as a
labeled badge (command / dictation / paint / asleep — always visible, so
you never have to read the mode from the dot's color alone), the active
**pen**, what it last heard, and a live mic level. Click the pill to
choose which microphone to use. To park the mic without ending the session, say **`voice sleep`**; say
**`voice wake`** to start listening again. The mic also **auto-sleeps**
after a stretch of silence (configurable) so a forgotten session doesn't
keep transcribing the room — the pill dims as a warning before it does.

### Commands

Every command starts with a spoken verb. A few you'll use constantly:

- **`pen highlight`** (or `pen underline`, `pen emphasis`, `pen cite`) sets
  the active pen — the mark that `mark` and paint apply. The pen sticks
  until you change it.
- **`take <words you can see>`** selects exactly those words on screen;
  **`mark`** then applies the pen, or **`mark <words>`** does both at once.
- **`next card`** / **`go back`** move you around; **`condense`** and
  **`shrink`** run the usual card commands.

When words you speak appear more than once on screen, numbered badges pop
up over each match — say **`pick two`** to choose.

### Paint mode

Say **`paint`** and then simply **read the card aloud**: the words you read
are inked with the active pen as you go, the voice-native way to highlight
or underline a card. Switch pens mid-pass (`pen highlight`), skip ahead
without marking, and say **`stop paint`** when you're done.

### Dictation

Say **`start typing`** to dictate at the cursor and **`stop typing`** to
stop; while you talk, words stream in as gray preview text before they
land. Dictation understands spoken punctuation (`period`, `comma`,
`question mark`, quotes), a configurable **dash** word, and capitalizes
sentences for you. To dictate a word that's also a command, prefix it with
**`literal`** (so `literal stop typing` types the words instead of
exiting).

### Precise targeting

Targeting composes, so you can be specific without reaching for the mouse:

- **Ordinals count inside their natural container.** `take second
  sentence` is the second sentence of this paragraph; `go to third card`
  is the third card in this block.
- **`mark every tag`** marks every tag in the block in a single step.
- **`take head card`** / **`take tail paragraph`** select to a scope's
  start or end.
- **`take from <words> to <words>`** spans two spoken anchors.

### Undo

Every voice action is a single undo step, and voice undo (**`scratch
that`**) and **Ctrl-Z** always agree — so you can take back a voice action
with the keyboard, or vice versa, and never lose your place.

### Options

Voice settings live under **Settings → Accessibility**. They include an
optional **large dictation model** — a one-time 1.8 GB download that uses
around 5 GB of memory while it's on and roughly halves general-English
dictation errors (it doesn't change command recognition).

---

## 16. Saving and file formats

### Opening files

Open a working file with **File → Open**, or from the Home screen's recents. On
desktop you can also **drag a `.docx`, `.cmir`, or `.cmir-journal`** from your
file manager onto any CardMirror window — the editor, the navigation pane, or the
home screen — to open it, exactly like File → Open (including the unsaved-changes
prompt, and focusing a copy that's already open). Other file types are ignored,
and dragging cards around inside the editor is unaffected.

**Password-protected Word files.** If you open a `.docx` that Word encrypted
with a password, CardMirror asks for the password and opens it. Saving writes
a normal, unencrypted file — CardMirror doesn't re-apply the password. (Only
the modern Word encryption is supported; a file from very old Office versions
will ask you to re-save it in a current Word first.)

**Finding a file on disk.** The **Open Containing Folder** command
(desktop; command bar — try "reveal in finder" — or a custom ribbon
button / shortcut) opens your file manager with the current document
highlighted in its folder. In the multi-doc workspace it acts on the
focused document.

### Two formats

- **`.cmir`** — CardMirror's native format. Lossless, and required for
  autosave and crash recovery. Use it for your working files. Files are
  saved compressed (roughly 10× smaller than before) and open just as fast;
  any older uncompressed file shrinks automatically the next time you save
  it — no action needed.
- **`.docx`** — Word/Verbatim format. Use it to share. CardMirror writes
  docx that's indistinguishable from Verbatim's own output; some
  CardMirror-only extras (private notes, AI notes, flashcards) are left
  out unless you opt in, and [live views and linked copies](#10-live-views-and-linked-copies) flatten
  to plain cards (their links don't survive Word).

### Cleaning .docx styles ("stylepox")

As cards get copied between documents, junk styles
hitchhike along — files end up with hundreds or thousands of redundant,
malformed styles that bloat the file, slow Word to a crawl, can break
Verbatim's macros, and eventually hit Word's hard cap of 4,085 styles.
**Clean**, on the Home screen, cures this. For each document it:

- removes the junk styles, keeping only the standard Verbatim set;
- converts stray direct formatting (manual bold / underline / highlight) back
  into the right styles;
- restores Verbatim's style names and aliases so macros work; and
- strips hyperlinks and other invisible cruft.

**On the web**, Clean does one file at a time: pick a `.docx` and it saves a
`cleaned_` copy (a spinner runs while it works, then you choose where to save).
The rest of this section — cleaning a whole folder, the destination and filename
options, and the protected-styles list — is **desktop only**.

Point it at a single file or a whole folder (it recurses) and a destination —
or leave the destination blank to write each cleaned copy next to its original.
A progress bar tracks the current file.

By default Clean prepends **`cleaned_`** to every output filename, so it always
writes new files and never touches your originals. Turn off **"Prepend
'cleaned_' to output filenames"** to save with the original names instead. If you
do that *and* the destination is the originals' own folder, Clean **overwrites
them in place** — which can't be undone and can occasionally destroy some
formatting, so it makes you confirm by typing "I accept the risk" before it runs.
Prepending, or saving to a different folder, leaves your originals untouched.

The **gear** opens **Protected styles** — a list of styles Clean must never
remove or reassign (matched by name, case-insensitively; their dependencies
are kept too). Add them by name, or upload a template `.docx` and pick from
its styles.

This is the same idea as the **"Curing Stylepox"** cleaner described on
[Debate Decoded](https://debate-decoded.ghost.io/leveling-up-your-debate-software-3-curing-stylepox/),
but it runs entirely inside CardMirror. It's **much faster** and has **much
better handling of old files**. It recognizes the common pre-Verbatim style
conventions
(`Tags` / `Cards` / `Cites` / `Block Headings`, `Author-Date`, `Debate
Underline`, …) and rebuilds them into the modern Verbatim structure, injects
the standard styles when a document is missing them, and repairs `!!`-marked
style names that older cleaners choke on — so it handles **many** old files
cleanly, though not every one (unusual or one-off style schemes may still not
be fully understood). The same applies when you simply **open** an old `.docx`
in CardMirror: for files it recognizes, it reconstructs the cards, tags, cites,
and headings instead of importing flat text.

### Saving

- **Save (Mod-S)** / **Save As… (Mod-Shift-S)**.
- **Autosave** is a toggle in the ribbon that applies to `.cmir`
  files. The button shows whether autosave is actually protecting the
  current doc: a **solid filled** button means it's saving; a **hollow
  button with a dashed outline** means it's on but not firing (the doc
  is `.docx`, or hasn't been saved once yet); a **red button with a solid
  outline** means the last autosave FAILED and your latest changes are not
  on disk — hover over it for the reason. **(Desktop only.)**
- **If a file (or its folder) gets renamed, moved, or deleted** while the
  document is open (say, someone reorganizes a shared Dropbox), the next
  save can't find the old location. CardMirror will tell you what happened
  and offer **Save As…** so you can put the document somewhere new —
  nothing is lost, and the app never silently recreates a file at the old
  location. The Save As dialog opens as close to the old location as still
  exists, so the file's new home is usually a click away.
- **If the file changes on disk while it's open** — edited on another
  device, by another program, or replaced by a sync service — Save asks
  before replacing it: **Overwrite** (keep this window's version),
  **Save As…** (keep both), or cancel. Autosave never overwrites a file
  that changed underneath it; it pauses and tells you to use Save to
  review. **(Desktop only.)**

### Save As presets

The Save As dialog offers presets so you can produce the right kind of
copy:

- **As-is** — a full copy.
- **Send Doc** — a clean reading copy with comments, analytics, and
  undertags stripped, for the judge or opponent (optionally with a
  `SEND_` filename prefix).
- Checkboxes (off by default) let you include **private notes** and **AI
  comments** in the saved file.

**Save Send Doc (Mod-Alt-S)** does the Send Doc export in one keystroke,
no dialog. Two Settings → Files options control where it goes (the
source file's folder, or a fixed folder you pick).

The filename prefixes for the preset saves — **Send Doc**, **Read Doc**, and
**Marked Doc** (defaults `SEND_`, `READ_`, `MARKED_`) — are configurable under
Settings → Files; change any of them, or leave one empty for no prefix. They
apply to both the Save As preset buttons and the one-keystroke Save Send Doc /
[Save Marked Cards](#saving-marked-cards) commands, gated on the existing
"Prefix preset saves" toggle.

### Crash recovery

**(Desktop only.)** CardMirror journals your work as you go, so if it's
killed mid-edit it offers to recover the unsaved documents the next time
you launch: each draft in the recovery list can be opened for a look,
saved, or discarded.

One safety check to know about: if a recovered draft is **older than the
file it would save over** — typically a leftover draft from a crash long
ago, surfacing after you've already edited and saved that same file in
later sessions — Save stops and asks. You can keep the newer file,
save the draft elsewhere (keeping both), or explicitly replace the file
with the older draft; the safe choice is the default. Until a recovered
draft has been saved once by hand, autosave also leaves it alone, so a
stale draft never overwrites newer work silently. Recovering normally —
your unsaved edits from the crashed session are newer than the file —
never triggers the extra question.

### Version history and Recover Previous Version

**(Desktop only.)** With **Keep version history** on (Settings →
Files), CardMirror quietly keeps periodic snapshots of your saved
documents in its own app data — snapshots are written at save time
*before* the file write happens, so even a save that hangs (a
cloud-sync folder acting up) leaves a recoverable version. Standard
keeps up to 30 days within modest disk caps; Extended keeps up to 90
days with larger caps; Custom sets the caps yourself.

**Recover Previous Version** (command bar, or the Collaboration group)
browses them. Versions list newest first, and each row tells you
what's inside: when it was saved and by what (a manual save or
autosave), its word and card counts, what changed vs the previous
version, and — most useful when something's gone missing — how many
cards that version contains that your **current document doesn't**.
Click a row to read the whole version in place: the preview renders
with your real document styling and its own navigation pane, so you
can check a version's actual content without opening anything.

When you've found the right one, **Open a copy** opens it as a new,
unsaved document — deliberately: a recovered copy can never silently
overwrite the file (or a shared session) it came from. Copy across
what you need.

For documents in a [shared session](#9-collaboration), the same
command opens the session's own change history instead — grouped by
editing bursts, with per-editor detail rows — with the same
click-to-preview and per-version digests.

### Damaged files

Structural damage to a `.cmir` file is rare, and CardMirror defends
against it in layers. Every save validates the document first: known
damage is repaired on the spot, the repaired version is what gets
written, and a notice asks you to report it (that report is how the
underlying bug gets found and fixed). On open, files carrying
known-fixable damage — like an invisible empty shell left by an old
bug — are repaired automatically and simply load.

If a file is too damaged even for the automatic repairs, the "This
CardMirror file is damaged" message offers **Repair**: CardMirror
shows you exactly what would be removed — quoting each damaged
element's text, or noting when nothing visible would be lost — and, if
you accept, opens a repaired copy. The original file is never touched:
the repaired copy opens unsaved under a "(repaired)" name, and saving
it asks where to save, so the damaged original stays intact on disk.
If you'd rather not repair, you can restore the file from a backup
instead.

### Updates

**(Desktop only.)** CardMirror checks for updates automatically — silently
at launch and once a day — and only speaks up when a new version is
actually ready. You can turn this off with the **Check for updates
automatically** toggle in Settings → General → About this install;
**Help → Check for Updates…** always works either way. Linux users who
installed via the AUR update with `yay -Syu`.

**Going to a tournament?** The **Pause update checks for 1 week**
button (next to the auto-check toggle in Settings → General → About
this install) stops all automatic checks and downloads until the shown
resume date — nothing about the app changes mid-tournament. While
paused, the row shows when checks resume and offers a **Resume update
checks now** button. Manual checks still work.

Automatic updates never interrupt you: when a new version has been
downloaded in the background, a small **chip appears in the status bar**
("Update x.y.z ready — restart to install"). Nothing installs until you
click it — on Windows and Linux, quitting the app normally also applies
a downloaded update on the way out. On macOS the update is staged the
same way and clicking the chip restarts straight into the new version;
if your install can't be updated in place (for example the app isn't in
a writable location), the chip opens the releases page instead so you
can grab the new `.dmg`.

<a id="the-notice-chip"></a>
### The notice chip

Errors and important status updates appear as a brief pop-up message,
and also land under a small **notice chip** in the status bar, where
they stay until you dismiss them. The chip shows a count and takes
the color of the most serious message waiting: grey for routine
notes, yellow when something needs your attention, red for problems.
Click it to open the list — each entry can be re-read in full,
**copied** (handy for bug reports), or **dismissed**, and **Dismiss
all** clears the lot. If the same problem fires repeatedly, it
collapses into a single entry with a ×N counter instead of nagging.

---

## 17. Settings reference

Open settings with the **gear** icon. Settings are grouped into tabs.

Some rows only exist on one platform — marked *(desktop)*, *(web)*, or
*(Windows)* below — and don't appear elsewhere.

### General

Workflow and editor behavior. Bold lines below mirror the section
headers shown inside each tab.

**Workspace**

- **Three-pane workspace** — switch between one document per window and a
  single window with three panes
  (see [The multi-doc workspace](#7-the-multi-doc-workspace)).
- **Default navigation depth** — the outline level the nav pane starts
  at when a document opens (Pocket / Hat / Block / Tag; Block by
  default). The 1–4 buttons in the pane change the depth for that
  window only.
- **Navigation pane follows the cursor** — on by default. The
  outline scrolls to keep your place in sight. Moving the cursor into a
  different section brings that heading into view, and clicking the
  pane's 1–4 buttons keeps the section you were in at the top of the
  outline instead of jumping back to the top of the document. If your
  section is hidden at the current depth, the outline follows its
  nearest visible parent. The pane only moves when the heading would
  otherwise be off-screen, so typing within one section — or scrolling
  the outline by hand to look somewhere else — leaves it where you put
  it. Only the outline's scroll position moves; your cursor and the
  document stay put.
- **Multi-doc layout** — with three docs open, show all three at once
  (compact) or two-and-a-bit with click-to-snap (wide). No effect with
  one or two docs.
- **Layout on this device** *(web)* — which layout the web edition uses:
  Auto picks the view-first mobile layout on narrow or touch screens;
  Mobile / Desktop force one. Changing this reloads the page.

**Editor behavior**

- **Editor spellcheck** — underline misspellings in the visible document,
  including text in files you've opened (not just what you're typing).
  Right-click a flagged word for suggestions, Add to Dictionary, or
  Ignore. Off by default — debate evidence (author names, jargon) trips a
  lot of false positives.
- **Pinch / Ctrl+Scroll to zoom** — zoom the document with a trackpad
  pinch or Ctrl + mouse-wheel, in the same 10% steps as the zoom buttons
  and Mod-= / Mod--. Off by default; enable it if you'd rather zoom by
  gesture.
- **Drag to rearrange** — the drag gestures that move content:
  navigation-pane row drags and the editor's pickup drag. On by
  default. Turn it off on touch devices (iPads) where scrolling with a
  finger keeps picking up headings; clicking still navigates, and pane
  resizing is unaffected.
- **Jump to doc top when read mode toggles** — when on, toggling read
  mode scrolls to the top and puts the cursor at the start.
- **Read mode: preserve paragraph integrity** — when on, read mode keeps
  each body paragraph on its own line instead of flowing a card's
  paragraphs together into one block. Body paragraphs with nothing
  read-aloud in them still disappear completely, so you never get blank
  lines. Off by default. Display-only, like the rest of read mode — the
  document isn't touched (that's what
  [Condense](#condense-pilcrows-and-case) does).

**Word counts**

- **Readers for read-time estimates** — each reader is a name and a
  words-per-minute rate. The first two show live in the status bar; all
  appear in the Word Count dialog
  (see [Read-time estimates](#read-time-estimates)).
- **Live word count for the current selection** — off by default. When
  on, the status bar's count and read time follow your selection as you
  change it; leave it off on very large docs if you notice drag lag.
- **Live read time for what is left to read** — off by default. When on,
  the status bar appends everything still ahead of the cursor (measured
  from the end of a selection); cheap even on large files
  (see [Read-time estimates](#read-time-estimates)).

**Find**

- **Find: remember the last search query** — when on, the find bar
  reopens pre-filled with your last search.
- **Find: category priority order** — the order Ctrl-F steps through
  result groups (heading / tag / cite / other); Alt-F ignores it and goes
  purely by proximity (see [Find and Find/Replace](#find-and-findreplace)).

**Timer**

- **Timer profile** — which duration set the timer runs: High school,
  College, or Pomodoro. Each remembers its own edits.
- **Timer durations** — the active profile's speech presets (the
  preset buttons) and per-side prep total.
- **Show a fourth speech preset** — for events whose speeches come in
  four distinct lengths. The presets form a 2×2 block in order, and
  Start/Pause becomes a full-height button beside the display (a fourth
  duration field appears above). Expanded layout only — compact drops
  all presets. Off by default.

### Files

Where new documents go, how the save presets name their files, what
file search scans, and how much version history to keep.

**New documents**

- **Onboarding doc for new documents** — when on, New Document opens the
  welcome doc; off opens a single blank paragraph.
- **Default folder for new speech documents** *(desktop)* — where New
  Speech Document saves by default. Empty leaves the doc unsaved until
  you Save.
- **Default format for new speech documents** — `.docx`
  (Verbatim-compatible) or `.cmir` (native, and the only format that
  supports autosave).
- **Speech document filename** — the name New Speech Document gives a
  new file: literal text plus two fields. `{speech}` is the name you
  type at the prompt (1NC, 2AC, …); `{date:...}` writes the current
  date/time with familiar tokens (`{date:YYYY-MM-DD}` → 2026-04-12;
  double a token to zero-pad it; inside the date block letters are
  tokens, so wrap a literal word in brackets: `{date:h-mmA [on] MMM D}`).
  The row previews the result as you type. Default:
  `Speech {speech} {date:M-D h-mmA}`.
- **Default file format for new documents** — the format the Save As
  dialog defaults to for a doc you haven't saved yet. Existing files
  always re-save in their own format.
- **Seed new speech docs with a Pocket heading** — when on, New Speech
  Document opens with a Pocket carrying the speech's name; off starts
  blank.

**Send / Read / Marked docs**

- **Prefix preset saves** — when on, the Save As Send Doc / Read Doc /
  Marked Doc presets and the silent Save Send Doc / Save Marked Cards commands
  prepend a filename prefix.
- **Send Doc / Read Doc / Marked Doc filename prefix** — the prefix each
  preset uses (defaults `SEND_` / `READ_` / `MARKED_`); change any, or leave one
  empty for no prefix.
- **Send Doc destination** *(desktop)* — whether Save Send Doc writes
  beside the source file or into a fixed folder
  (see [Saving a send doc](#saving-a-send-doc)).
- **Send Doc folder** *(desktop)* — the fixed folder used when the
  destination above is "Fixed folder."
- **Marked Cards destination** *(desktop)* — whether Save Marked Cards writes
  beside the source file or into a fixed folder (see
  [Saving marked cards](#saving-marked-cards)).
- **Marked Cards folder** *(desktop)* — the fixed folder used when the Marked
  Cards destination is "Fixed folder."

**File search**

- **File search folders** *(desktop)* — the roots scanned for the palette's
  file search (the `f` prefix). Each folder row has a **Browse…** button, so
  a folder that gets renamed or moved can be repointed in place instead of
  removed and re-added. Empty disables file search (see
  [The Search Everything palette](#the-search-everything-palette-mod-shift-space)).
- **File search: file formats to list** *(desktop)* — which document
  formats appear in results: both `.cmir` and `.docx`, or just one.
- **File search: objects to find within a file** *(desktop)* — which
  structural objects (blocks, tags, cites, …) the palette lists when you
  dive into a file.
- **File search: default outline depth** *(desktop)* — how far a file's
  outline is expanded the moment you dive in.
- **File search: tie-break order** *(desktop)* — how equally-relevant file
  results (and the browse list before you type) are ordered: **Recency**
  (most-recently-edited first, the default) or **Alphabetical**.
- **File search: auto-pin recent & frequent files** *(desktop)* — keeps
  recent and frequent files warm for instant dives; turn off to warm only
  files you pin by hand.

**Version history**

- **Keep version history** *(desktop)* — periodic snapshots of saved
  documents, kept on this computer and browsable with
  [Recover Previous Version](#version-history-and-recover-previous-version).
  **Standard** (the default) keeps up to 30 days within modest disk
  caps; **Extended** keeps up to 90 days with much larger caps and can
  use several gigabytes; **Custom** sets the per-document and total
  disk caps yourself (0 = uncapped). Off stops new snapshots; a
  Clear button removes existing ones. Never a substitute for saving —
  the crash journal guards unsaved work; this is a browsable trail
  behind your saves.

### Appearance

How things look. None of these change the file — only your view (see
[Appearance and accessibility](#18-appearance-and-accessibility)).

**Theme & chrome**

- **Theme** — light, dark, or follow the system.
- **Apply theme to the document area** — off by default, so dark mode
  darkens only the interface and the document stays paper-like; on darkens
  the document too.
- **Icon style** — modern line icons (default) or classic glyphs;
  interface only.
- **Show doc name in ribbon** — show the active filename as a pill in the
  ribbon's center, handy when the title bar is hidden. Off by default;
  hidden in multi-pane (each pane shows its own chip).
- **Show undo / redo buttons** — a stacked Undo / Redo button pair at the
  far left of the ribbon, before the file buttons. Off by default —
  undo/redo always work by keyboard either way.
- **Ribbon tooltips** — what a hovered ribbon button shows: both, label
  only, shortcut only, or none.

**Custom ribbon buttons**

- **Custom ribbon buttons** — up to 10 buttons of your own to the right
  of the comments buttons, each running a command of your choice with an
  icon picked from a 54-icon set. Bindable commands are any ribbon
  command, the generated Toggle/Cycle setting commands, and any enabled
  plugin's commands. Rows reorder with up/down arrows, and row order is
  ribbon order (the section fills two per column). With none configured
  the section is hidden; it's the third thing to disappear when the
  ribbon runs out of room.

**Document typography**

- **Style font sizes (pt)** — render size for each named style.
- **Style typography** — bold / italic / underline / box per named
  style, including: hat underline style (double, the classic look, or
  single), whether pockets draw their box (and its thickness), the
  emphasis box thickness, the underline thickness (blank = the font's
  automatic weight; applies to underline, emphasis, and underlined
  cites), and whether substructure letters are bolded.
  The font-size editor above it has a reset button that restores every
  style's default size.
- **Body font** — the editor's content font, including dyslexia-friendly
  options.
- **Line spacing** — the line-height multiplier, per paragraph type.
- **Paragraph spacing** — blank space before and after each paragraph
  type, in points (distinct from line spacing, which is the gap between
  lines).
- **Style colors** — the color of Analytic and Undertag text (the same
  control as Accessibility → Color overrides → Document text).
- **Distinguish background color from highlighting** — overlays a
  deliberately faint dot grid on background color so it can be told
  apart from highlighting at a glance. Off by default — the two stay
  visually identical. Display-only; the file and anything you copy or
  export are untouched.
- **Show character styles** — show the cite / underline / emphasis
  buttons in the ribbon.

**Formatting panel**

- **Formatting panel** — how the Pocket / Hat / Block / Tag / Analytic
  buttons read: labels, shortcuts, both, or hidden.
- **Preview styles in formatting panel** — make the formatting buttons
  preview the look of the style they apply.

**Nav pane & indicators**

- **Format nav pane entries by type** — style navigation entries by
  heading level and type (on), or as a uniform list where only
  indentation shows hierarchy (off).
- **Cite preview on hover** — show a card's cite-formatted text beside its
  navigation-pane entry when you hover.
- **Flashcards-due dot** — show a red dot on the ribbon's Manage
  Flashcards button when cards are due for review today. On by default.

**Timer display**

- **Timer position in the ribbon** — which edge of the ribbon the timer
  panel sits on when shown: the far left (default) or the far right.
- **Prep button label style** — how the Aff / Neg prep buttons are
  marked: text (A: / N:), color, or both.
- **Compact timer layout** — drop the 9 / 6 / 3 presets and collapse the
  two prep clocks into one (with a ⇄ side-switch), keeping Reset and
  Pop-out stacked on the left.
- **Flash timer when countdown is low** — flash the timer display red as
  remaining time crosses each alert point.
- **Alert points (seconds remaining)** — the comma-separated
  seconds-remaining values (default 5, 3, 1) at which the flash and the
  audible alert fire.
- **Audible timer alerts** — play a short beep at each alert point and a
  double beep when time runs out; exactly one sound plays regardless of
  how many windows are open. Off by default.
- **Alert volume** — loudness of the timer beeps, 0–100.

**Card numbering** *(see §2 — all display-only)*

- **Show card numbering** — whether the automatic card numbers appear at all.
- **Number format** and **substructure format** — how the number and its
  sub-part are written, set independently.
- **Separator** — what goes between a number and its substructure (period,
  hyphen, m-dash, n-dash, colon, or a double / triple hyphen).
- **Capitalize substructure** — upper- or lower-case the sub-part.
- **Number color** — the color of the numbers, linked to the Accessibility
  color overrides. Or check **Match heading** to have each number follow its
  own tag or analytic's text color instead — including a manual font color,
  when it covers the heading's entire text.
- **Number indent** and **substructure indent** — how far each is indented.

### Editing

Typing helpers and the behavior of the cutting and condense commands
(see [Cutting and formatting cards](#3-cutting-and-formatting-cards)).

**Typing**

- **Smart quotes** — curl a straight `'` / `"` to the right direction as you
  type; Backspace right after reverts. Off by default.
- **Custom dash** — turn a typed `---` (or `--`, your choice) into an en
  or em dash (spaced or unspaced) on the trigger's last hyphen;
  Backspace right after reverts to the literal hyphens. Off by default.
- **Auto-capitalize tags and analytics** — sentence starts (and a
  standalone `i`) capitalize as you finish each word, in tags and
  analytics only; Backspace right after reverts. Off by default.
- **Custom autocorrect** — your own replace-as-you-type entries, with
  duplicate-entry refusal and clash warnings against the other typing
  aids; Backspace right after reverts to what you typed. Off by default.

**New paragraph on Enter**

- **Enter at the end of a structural style creates** — six dropdowns,
  one per structural style, choosing what pressing Enter at the *end*
  of that style creates. "Normal paragraph" (the default for all six)
  keeps today's behavior. Any other choice acts exactly like pressing
  Enter and then that style's key on the new line — including card
  splits — so Tag → Tag starts a fresh card on every Enter, and
  Analytic → Analytic chains analytics. One Ctrl-Z undoes the whole
  step.

**Condense**

- **F3 condense: preserve paragraph integrity** — keep paragraphs
  separate (on) or merge collapsible runs (off).
- **F3 condense: use pilcrow markers** — when merging, mark each old
  paragraph break with a 6-pt ¶ so Uncondense can restore it.
- **Condense after Paste Text (F2)** — run your default condense
  automatically on pasted text.
- **Condense: heading handling** — how selection condense treats
  headings, cites, and undertags: Strict (block it), Respect (keep them
  separate, default), or Demolish (merge everything).
- **Condense with warning: marker delimiter** — the bracket style around
  the PARAGRAPH INTEGRITY PAUSES / RESUMES markers.

**Paste**

- **Smart paste conversion** — recognize content copied from Microsoft
  Word or haku.cards and convert it into CardMirror structure on paste
  (see the Smart paste section above). On by default; Paste Text (F2)
  always pastes plain.

**Cites**

- **Copy Previous Cite: nearest cite only** — Copy Previous Cite
  (Alt-F8) copies only the single nearest preceding cite paragraph (the
  default). Off copies every cite under the most recent source, the
  Verbatim-style behavior.

**Formatting operations**

- **Extract Undertag: wrap in quotes** — wrap the excerpt that Extract
  Undertag pulls in double quotes.
- **Bridge formatting across gaps automatically** — when you format a word
  next to an already-formatted one, close the small gap so the styling reads as
  continuous (the manual Fix Formatting Gaps command is unaffected). Body text
  only.
- **Bridge formatting across** — which gaps the automatic bridging closes:
  whitespace and punctuation (default), or whitespace only.
- **Shrink keeps protected text at Normal size** — keep Omitted spans,
  warning markers, and your custom protections full-size when Shrinking.
- **Custom shrink protections** — extra strings (or regexes) Shrink
  should leave at Normal size.
- **F9 toggle-off also clears direct formatting** — toggling underline
  off also strips direct formatting in the range.

**Create Reference**

- **Include the FOR REFERENCE heading** — start the copied excerpt with
  the `<<CITE FOR REFERENCE>>` heading line (on by default). The three
  settings below shape that line and are disabled while it's off.
- **Heading delimiter** — which bracket pair wraps the heading:
  `<< >>` (default), `[ ]`, `[[ ]]`, `< >`, `{ }`, or `{{ }}`.
- **Include the cite in the heading** — whether the card's cite appears
  (the SMITH 24 in `<<SMITH 24 FOR REFERENCE>>`).
- **Custom heading text** — replace the FOR REFERENCE label with your
  own. Type `%Cite%` where the cite should go — e.g. `FROM %Cite%`
  gives `<<FROM SMITH 24>>`; without `%Cite%` the cite is
  prepended as usual. Leave empty for the default label.
- **Reduce text size** / **Reduce text size by (points)** — whether the
  excerpt's text shrinks, and by how many points (default 3; never below
  1pt).
- **Highlights become** — what happens to highlighted text in the
  excerpt: a grey background (default), a background in the same color
  as the highlight (like the Highlight to Background command), kept as
  highlights, or removed.
- **Use Gray-50% body text** — render the excerpt's body text in gray;
  the heading line stays black.

**Standardize exceptions**

- **Highlighting exception** — the highlight color that "Standardize
  Highlighting (with Exception)" leaves untouched. One of Word's 15
  highlight colors; defaults to yellow.
- **Background color exception** — the background color that "Standardize
  Background Color (with Exception)" leaves untouched. Any color; defaults
  to yellow.

**Acronym marking**

- **Custom acronym letters** — teach the acronym commands (Alt-F10
  emphasize, Alt-F11 highlight, Underline Acronym) which letters to mark
  for specific phrases instead of each word's first letter. Type a
  phrase, then click its letters in the picker — the marked letters are
  exactly what the commands will mark when your selection is that phrase.

**Insert surfaces**

- **Show dropzone shelf** — show or hide the dropzone pill; the shelf
  still works when hidden
  (see [Send-to-speech and the dropzone](#send-to-speech-and-the-dropzone)).
- **Show quick card buttons** — show the Quick Cards ribbon cluster (off by
  default; quick cards still work while hidden, and the command bar still opens
  by shortcut).

**Translation**

- **Translation** — backend (MyMemory / Anthropic / Google Cloud
  Translation), source and target languages, MyMemory email, and Google
  API key for the Translate command (Mod-Shift-T). See
  [Translate](#13-ai-features).
- **Prepend a "translation by" marker** — put a `[TRANSLATION BY …]` line
  above the translated text on the clipboard. On by default.

### Keyboard shortcuts

Rebind any command: search for it, click **+** to add a binding, **×** to
remove one, **↺** to restore its default. A few window-level shortcuts
(like Mod-W) are handled by the OS and can't be overridden (see
[Keyboard shortcuts](#19-keyboard-shortcuts)).

### Comments & AI

- **Comment author name** — the name attached to comments you write.
- **Comment author initials** — the badge on your comments;
  auto-derived from the name if left blank.
- **Enable AI features** — master switch for the AI comment features;
  needs an API key (see [AI features](#13-ai-features)).
- **Anthropic API key** — stored locally; sent only to api.anthropic.com.
- **AI model (advanced)** — the Claude model id all AI features use; blank
  uses the model built into your release. Set a newer id if the built-in
  one is retired. A malformed entry is ignored.
- **Enable Clod mode** — the playful in-flight placeholder ("Clod is
  making toast…") while the AI composes a reply.
- **AI cite-creator prompt** — the system prompt the cite creator uses;
  leave blank for the built-in default.

### Accessibility

- **Reduce motion** — turn off UI animations: follow the system, always
  on, or always off.
- **Steady text cursor (no blinking)** — stop the text cursor blinking and
  show a steady caret instead. Off by default.
- **Remove bold from cites** — render cite-marked text at normal weight
  instead of bold, for readers who find dense bold runs visually
  crowding. Display-only: exports and other machines still see the
  standard bold cite. Off by default.
- **Default document zoom** — the body-text zoom level documents open at, and
  reset to on reload (zoom is per-editor and does not persist across reloads).
  50–300%, 100% by default.
- **Text alignment** — center or fully justify text per structural
  style (tags, paragraphs, card bodies, analytic bodies, analytics,
  undertags, cite paragraphs). Pockets, hats, and blocks keep their
  normal look, and a paragraph you've aligned yourself keeps its own
  alignment.
- **Maximum text width** — cap how wide the document text column gets,
  so reading doesn't require sweeping your eyes across the whole
  screen. Off by default; when on, choose whether the column sits
  centered or pinned to the left or right edge. In
  [reading view](#reading-view) it caps the column width instead.
- **Reduce animations in reading view** — make
  [reading view's](#reading-view) page flips instant instead of
  animated. Off by default; the global reduce-motion preference also
  flattens them.
- **Screen reader support** *(desktop)* — let screen readers and other
  assistive technology read CardMirror. **Off by default**: a current Chromium
  bug crashes the window (white screen, lost work) while building the
  accessibility tree, so CardMirror disables it to stay stable. Turn it on only
  if you rely on a screen reader — it re-activates the known crash — and restart
  CardMirror to apply.
- **Color-vision friendly palette** — remaps the colors that carry meaning
  (annotation accents, voice-mode dots, prep-timer Aff/Neg, search-match
  highlights, category chips) onto a palette engineered to stay
  distinguishable under red-green and blue-yellow color-vision deficiencies.
  Works with both light and dark themes; any colors you set under **Color
  overrides** still win. This preset changes CardMirror's interface colors
  only — highlights and background colors stored in documents are
  untouched. For those, use the **Override highlight/background color**
  settings below and the status-bar color names setting above.
- **Distinguish annotations by underline shape** — add a shape-coded
  underline to in-document annotation ranges so you can tell them apart
  without relying on their tint colors: comments dotted, flashcards
  solid, AI threads dashed, private notes double. Off shows just the
  tinted backgrounds. Works independently of the palette above.
- **Italicize analytic entries in the nav pane** — show the navigation
  pane's Analytic entries in italics so they stand out from tags by
  shape, not color alone. Also useful in dark mode and with "Format nav
  pane entries by type" off, where the analytic color cue doesn't
  appear at all.
- **Override highlight color in display** — render highlights in your
  chosen colors regardless of what's stored on the mark (display-only).
- **Highlight override colors** — up to three ordered colors; the
  most-common highlight in the doc maps to the first, the next to the
  second, the rest to the last.
- **Override background color in display** — the same, for background
  color.
- **Background override colors** — the colors used for the above.
- **Show highlight & background color names in the status bar** — the
  status bar
  reports the actual stored color names for the text at your cursor
  (e.g. `Hl: Yellow · Sh: none`). Highlight hues often carry meaning in
  shared files; this gives you that meaning as text — useful if colors
  are hard to tell apart, or alongside the overrides above. Works in the
  three-pane workspace too (it follows the focused pane).
- **Color overrides** — override any interface color (and document text);
  your picks win over the built-in themes and presets.
- **Interface font** — the font for the app's interface (ribbon, dialogs,
  navigation, comments), separate from the body font; includes
  dyslexia-friendly options.

**Plugins** — the Plugins tab has its own chapter: see
[section 20](#20-plugins-experimental).

---

## 18. Appearance and accessibility

Everything visual in CardMirror is customizable, and — importantly — your
display choices **never change the file**. The way you like to see Tags is
separate from how Tags look for everyone else (to change that for
everyone, apply direct formatting in the document itself).

- **Themes.** Light, dark, or follow the system. *Cycle Theme* rotates
  through them.
- **Icon sets.** Modern line icons (default) or classic emoji/text
  glyphs.
- **Per-style colors.** Set the color of Analytics, Undertags, and other
  styles for your own viewing.
- **Accessibility overrides.** Remap highlight and background colors,
  override document text color, and pick dyslexia-friendly body fonts
  (Atkinson Hyperlegible, Lexend, OpenDyslexic, and others). CardMirror
  also forces readable contrast on highlighted and shaded text
  automatically. A **Steady text cursor (no blinking)** option (off by
  default) replaces the blinking caret with a steady one.
- **Zoom.** **Mod-=** / **Mod--** zoom the document text; the status bar
  shows the level (click to reset). Zoom is **per editor** — it applies only
  to the document you're in, so you can zoom one document in while another
  stays out, independently per pane in the three-pane workspace. It doesn't
  sync across windows or persist; instead documents open at a default you can
  set (Settings → Accessibility → **Default document zoom**, 100% by default)
  and reset to it on reload. You can also pinch on a trackpad or hold Ctrl and
  scroll, once you turn that on under Settings → General → **Pinch /
  Ctrl+Scroll to zoom** (off by default). **(Desktop only:)** **Mod-Alt-=** /
  **Mod-Alt--** scale the whole interface uniformly across windows, not just
  the document.

---

## 19. Keyboard shortcuts

All defaults; rebind any of them in **Settings → Keyboard shortcuts**.
**Mod** = Ctrl (Windows/Linux) or ⌘ (macOS).

### Structure and formatting
| Shortcut | Action |
|----------|--------|
| F4 / F5 / F6 / F7 | Pocket / Hat / Block / Tag |
| Mod-F7 / Mod-F8 | Analytic / Undertag |
| F8 | Cite |
| F9 / Mod-U | Underline |
| F10 / Alt-F10 | Emphasis / Emphasize acronym |
| F11 / Alt-F11 | Highlight / Highlight acronym |
| Mod-F11 | Background color |
| Mod-B / Mod-I | Bold / Italic |
| Mod-Shift-= / Mod-= | Superscript / Subscript |
| F12 | Clear formatting |
| F2 | Paste Text |
| F3 / Alt-F3 / Mod-Alt-F3 | Condense / no integrity / with pilcrows |
| Mod-Alt-Shift-F3 | Uncondense |
| Shift-F3 | Toggle case |
| Mod-8 | Shrink |
| Mod-Alt-8 | Smart Shrink |
| Alt-F8 | Copy previous cite |
| Tab / Shift-Tab | Indent / Outdent |
| Mod-Alt-Up / Mod-Alt-Down | Move container (card / section) up / down |

### Moving and selecting
On macOS, use **Alt/Option** in place of **Ctrl**. Add **Shift** to any of
these to extend the selection.
| Shortcut | Action |
|----------|--------|
| Ctrl-Left / Ctrl-Right | Previous / next word |
| Ctrl-Up / Ctrl-Down | Previous / next paragraph |
| PageUp / PageDown | Previous / next heading |
| Alt-A | Select the current heading and everything under it |

### Find, files, and Quick Cards
| Shortcut | Action |
|----------|--------|
| Mod-F / Mod-H | Find / Find and Replace |
| Alt-F | Find without grouping |
| Mod-Shift-Space | Search Everything palette (files `f`, Quick Cards `q`) |

### Speech, comments, and AI
| Shortcut | Action |
|----------|--------|
| `` ` `` / Alt-`` ` `` | Send to speech at cursor / at end |
| Mod-`` ` `` | Send to dropzone |
| *(unbound)* | Send to the starred recipient / group — bind it in Settings |
| Mod-P / Mod-Alt-P | Insert most recently received card at cursor / at end of doc |
| Mod-Shift-N | Add note to selection |
| Mod-Shift-Q | Ask AI about selection |
| Mod-Shift-X | Format cite from selection (AI) |
| Mod-Shift-R | Repair OCR/PDF text in selection (AI) |
| Mod-Alt-R | Repair Formatting in selection (AI) |
| Mod-Shift-T | Translate selection to clipboard (AI) |
| Mod-Shift-D | Toggle a reading-position marker (Space / Enter also work in read mode) |

### Files and view
| Shortcut | Action |
|----------|--------|
| Mod-S / Mod-Shift-S | Save / Save As |
| Mod-Alt-S | Save Send Doc |
| Mod-Alt-M | Save Marked Cards |
| Mod-= / Mod-- | Zoom in / out |
| Mod-Alt-= / Mod-Alt-- / Mod-Alt-0 | Interface scale up / down / reset (desktop) |

### Multi-doc workspace
| Shortcut | Action |
|----------|--------|
| Mod-1 / Mod-2 / Mod-3 | Focus slot 1 / 2 / 3 |
| Mod-Shift-1/2/3 | Move active doc to slot |
| Mod-Shift-F | Expand / restore the focused slot |
| Mod-W | Close the focused document or window |

### Voice control (desktop)
| Shortcut | Action |
|----------|--------|
| Ctrl-Shift-V | Start / stop a voice control session |

The full, current list is always in the app: press **📖** in the ribbon.

---

## 20. Plugins (experimental)

Plugins extend CardMirror with new commands and integrations written
by third parties. The system is experimental and desktop-only.

**Turning it on.** The Settings → **Plugins** tab holds the master
switch (**Enable plugins** — takes effect on the next launch) and the
install list.

**Installing.** Paste a GitHub URL or `owner/repo` into the install
field. Plugins run with **full access to CardMirror and your
documents**, so installs are limited to a curated list, and every
install shows a consent prompt naming the exact GitHub repository the
code comes from — nothing is written until you accept. The first
listed integration is the companion plugin for the
[ebb](https://github.com/shreerammodi/ebb) flowing app. (If you run a
self-hosted relay, its operator curates the list; see the relay
README.)

**Using.** A plugin's commands appear in the command palette and the
printed shortcut reference, can be rebound in Settings → Keyboard like
any built-in command, and can be bound to
[custom ribbon buttons](#17-settings-reference).

**Plugin settings.** A plugin that offers its own options shows a
gear on its row while it's enabled. Clicking it opens a small dialog
of the plugin's settings; changes apply immediately, and Done just
closes.

**Uninstalling.** The Uninstall button removes the plugin, its
settings, its shortcuts, and any custom ribbon buttons bound to its
commands immediately; any background code it was running stops on the
next launch. Note that a companion *app* (like ebb itself) connects
to CardMirror separately from its plugin — uninstalling the plugin
doesn't cut that connection. That's what **External apps** below is
for.

**External apps.** Companion apps on your computer can insert text
into your documents (and jump you to sources) over a local
connection. The External apps section of this tab controls who may:
the first time an app sends, CardMirror asks — **Always Allow / Allow
Once / Deny** — naming the app, and remembers your answer in a list
here where you can flip a decision or forget an app (it will ask
again next time). The policy dropdown above the list sets the overall
stance: **Ask for each app** (default), **Allow all** — every sender
accepted, including older apps that don't identify themselves — or
**Block all**. Under the default policy, an app too old to identify
itself is turned away and CardMirror tells you to update it. Like
Verbatim Flow, this section works regardless of the Enable plugins
switch.

**Connecting Ebb.** [Ebb](https://github.com/shreerammodi/ebb) is a
flowing app with a two-way CardMirror integration: send what you're
reading onto your flow, and jump from a flow cell back to the passage
it came from. To set it up:

1. Install and open Ebb itself at least once (its own releases page
   has installers; CardMirror and Ebb must run on the same computer).
2. In CardMirror, turn on **Enable plugins** in Settings → **Plugins**
   (takes effect on the next launch), then paste
   `shreerammodi/cardmirror-ebb-plugin` into the install field and
   accept the consent prompt.
3. The first time Ebb selects something in CardMirror (see below),
   the standard External apps prompt asks whether to allow it —
   choose **Always Allow** to set it up once.

The plugin adds its commands to the command palette (rebindable like
any command, and bindable to custom ribbon buttons): **Send to Flow**
pushes the current card or selection into the active Ebb sheet, with
variants for one-cell-per-line or everything-in-one-cell; **Reveal in
Flow** selects the Ebb cell that came from the current passage,
cycling through matches; **Choose Flow App** picks the target when
more than one flow app is available. The plugin's gear icon holds its
two settings — the default send layout, and how many empty cells to
leave after each send.

Everything travels over a local connection between the two apps on
your computer; nothing about your flows or documents goes online.
Requires an Ebb build newer than 0.6.1.

**Verbatim Flow.** On Windows, the **"Keep a Verbatim Flow connection
warm"** toggle sits at the bottom of this tab. It's a bundled
integration rather than an installable plugin, so it works regardless
of the Enable plugins switch
(see [Send to Verbatim Flow](#14-send-to-verbatim-flow)).

**For developers.** The plugin API and the local bridge protocol are
documented in the repository README and reference docs.

---

## 21. Glossary

- **Pocket / Hat / Block / Tag** — the four heading levels (Word Heading
  1–4).
- **Card** — a Tag plus its cite and body text.
- **Analytic** — standalone analysis with no card behind it.
- **Undertag** — a short annotation on a tag.
- **Cite mark** — the character style on an author's name and date.
- **Condense** — collapse a card's paragraphs into a tight block.
- **Pilcrow** — the small ¶ that marks an original paragraph break in a
  condensed card.
- **Shrink** — cycle a card's un-underlined text through smaller sizes.
- **Read mode** — a non-destructive reading view that hides non-read-aloud
  content and locks editing.
- **Read-aloud content** — Tags, Cites, Analytics, and highlighted text:
  what read mode keeps and read-time counts.
- **Send-to-speech** — sending a card into your speech document.
- **Dropzone** — a holding shelf for cards you've set aside.
- **Send Doc** — a clean copy for sharing, with comments, analytics, and
  undertags stripped.
- **Quick Card** — a tagged, reusable snippet in your personal library.
- **Live view** — a read-only window onto another section of the *same*
  document; it always shows the source's current content.
- **Linked copy** — your own editable copy of a section (from another file or
  this document), kept linked to its source so you can refresh it and see when
  the original changes. *(Formerly called a "live zone.")*
- **Co-editing** — real-time collaborative editing of a shared document over the
  encrypted relay; join with a share code or an invitation.
- **Card numbering** — automatic, display-only numbering of cards and their
  sub-parts.
- **Flashcard** — a spaced-repetition study card anchored to evidence,
  stored only on your machine.
- **Anchor / unanchored / re-ground** — how a flashcard or note attaches
  to a span of text; an anchor that can't be found is unanchored until you
  re-ground it.
- **`.cmir` / `.docx`** — CardMirror's native format / the Word format
  for sharing.
- **Mod** — Ctrl on Windows/Linux, ⌘ on macOS.
