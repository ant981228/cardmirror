<p align="center">
  <img src="./logo.png" alt="CardMirror" width="280" />
</p>

# CardMirror

CardMirror is a debate text editor focused on high school and college
policy debate. It's a standalone
replacement for the editor side of
**[Verbatim](https://github.com/ashtarcommunications/verbatim)**, the
Microsoft Word add-in most US debate teams use: same organizational structure, 
same F-key shortcuts, same send-to-speech
workflow, same Word-compatible `.docx` files — but with no Word, no
macros, and no add-in. That keeps it fast on the multi-megabyte
evidence files debaters work in, and enables cross-platform feature parity.

Run it as a **desktop app** for tournament-day work, or as a **web
preview** in any browser for trying it out or working from a Chromebook
or locked-down school machine.

**▶ Try the live web preview: <https://cardmirror.app/>**

> **🚧 Beta preview.** Expect rough edges, missing features, and the
> occasional bug. Keep a Verbatim copy of anything important — not
> recommended for tournament-day use yet.
>
> **Desktop builds are unsigned**, so Windows and macOS warn you the
> first time you launch. The one-time workaround for each is in the
> install steps below.

See [`MANUAL.md`](./MANUAL.md) for the full user
manual; [`PRIVACY.md`](./PRIVACY.md) for how CardMirror handles your data;
[`TERMS.md`](./TERMS.md) for the terms of use;
[`CHANGELOG.md`](./CHANGELOG.md) for release notes;
[`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full design;
[`PROJECT.md`](./PROJECT.md) for project orientation.

You can find a video walkthrough of CardMirror's basic functions [here](https://www.youtube.com/playlist?list=PLXM5iwKNQkSs). 

## Install

Desktop builds live on the [Releases page](https://github.com/ant981228/cardmirror/releases).
Pick the file for your operating system, run the installer, and
launch CardMirror like any other app.

### macOS

1. Download the `.dmg` for your Mac:
   - **Apple Silicon (M1 / M2 / M3 / M4)**: `CardMirror-x.x.x-arm64.dmg`.
   - **Intel**: `CardMirror-x.x.x.dmg` (or `-x64.dmg`).
2. Open the `.dmg`, drag **CardMirror** to your Applications folder.
3. **First launch only.** Gatekeeper refuses to open unsigned apps.
   You'll see one of two messages depending on your macOS version:

   - **"can't be opened because Apple cannot check it for malicious
     software"** → Open Finder → Applications, **right-click** (or
     Control-click) **CardMirror** → **Open**. Click **Open** in the
     confirmation dialog. From then on, normal double-click works.

   - **"is damaged and can't be opened"** → macOS has hard-quarantined
     the app and the right-click workaround doesn't suffice. Open a
     terminal (Spotlight → "Terminal") and run:
     ```sh
     sudo xattr -cr /Applications/CardMirror.app
     ```
     You'll be asked for your password. After that, normal
     double-click works.

### Windows

1. Download `CardMirror Setup x.x.x.exe`.
2. Run the installer (Next → Install → Finish).
3. **First launch only.** SmartScreen shows "Windows protected your
   PC." Click **More info** → **Run anyway**.

### Linux

Two options for installation, depending upon distribution:

- **AppImage** (works on every modern distro): download
  `cardmirror-x.x.x.AppImage`. In a terminal, in the download
  folder, run:
  ```sh
  chmod +x cardmirror-x.x.x.AppImage
  ./cardmirror-x.x.x.AppImage
  ```
  For most graphical desktop environments with modern file managers, you should
  be able to run the AppImage by double-clicking after the `chmod +x` command.

- **Arch and Arch-based distributions** — use the AUR:
  ```sh
  yay -S cardmirror-bin
  # or with paru: paru -S cardmirror-bin
  ```
  Or grab `cardmirror-x.x.x.pacman` from the release directly and:
  ```sh
  sudo pacman -U cardmirror-x.x.x.pacman
  ```

### Web app (Chromebook & browser)

No download needed — open the
[live web app](https://cardmirror.app/) in a Chromium browser
(Chrome, Edge, or ChromeOS) and click the **Install** button in the address bar
to run CardMirror in its own window, offline, updating itself on relaunch. On a
Chromebook this is the way to run it — no desktop build required.

Installed, the web app does most of what the desktop editions do: **save in
place** and autosave (it may ask for permission to edit each file),
one-keystroke **Paste Text**, **multiple windows** (New Document / New Speech
Document open their own window) with the dropzone, Quick Cards, and send-to-speech
kept in sync across them, the **three-pane workspace**, and single-file **Clean /
Convert / Compress** tools on the home screen.

Still desktop-only: background file-library search, folder-wide bulk operations,
Send to Verbatim Flow, voice control, card sharing, and real-time **co-editing**
(share a document and edit it together live — experimental). Firefox and Safari run the
editor but lack the File System Access API, so there Save falls back to a
download. See **[Desktop vs. web](./MANUAL.md#desktop-vs-web)** in the manual for
the full breakdown.

> **Web feels slow on big documents? Check your extensions.** Some browser
> extensions — password managers (1Password, LastPass, Bitwarden) and form
> fillers especially — rescan the whole page every time you focus a text box,
> which can freeze the editor for a second or more on a large file. The desktop
> app never hits this because it loads no extensions. To confirm, open the app
> in an Incognito window (extensions are off there) — if it's snappy, an
> extension is the cause. To fix it without turning the extension off
> everywhere, tell Chrome to run it only on this site by request: click the
> **puzzle-piece (Extensions)** icon in the toolbar, click the **⋮** next to the
> extension, and set **"This can read and change site data" → "When you click
> the extension."**

### Updates

**Help → Check for Updates…** checks manually: it tells you you're
current, or offers an available update (downloaded in the background,
with a "restart now?" prompt when it's ready).

Auto-check on launch is off by default. Turn it on in Settings →
General → "About this install" → **Check for updates on launch**.

> **macOS: automatic updates don't work yet.** The in-app updater can
> tell you a new version exists, but it can't install it on Mac. To
> update, download the latest `.dmg` from the releases page and reinstall
> it (drag **CardMirror** to Applications, replacing the old copy) each
> time — same steps as the [macOS install](#macos) above. Windows and
> Linux are unaffected.

Linux users who installed via the AUR can update with `yay -Syu`
instead.

## (Optional) Set up AI features

CardMirror can use either **Anthropic** directly or **OpenRouter** for its AI features:

- AI-formatted citations from a pasted URL or freeform quote.
- AI repair of OCR / PDF extraction errors in a selection (Mod-Shift-R).
- AI image alt-text and table-from-image (right-click an image).
- AI commenting / explain features in the comments column.

To enable them, open CardMirror's settings with the ⚙ gear icon in the ribbon,
then turn on **AI features** under **Comments & AI** and choose a provider:

- **Anthropic** — get an API key from
  [console.anthropic.com](https://console.anthropic.com/), then paste it into
  the **Anthropic API key** field. CardMirror uses its built-in Claude model by
  default; the optional model override lets you enter a different Anthropic
  model ID.
- **OpenRouter** — get an API key from
  [openrouter.ai/keys](https://openrouter.ai/keys), paste it into the
  **OpenRouter API key** field, and enter an **OpenRouter model ID** such as
  `anthropic/claude-sonnet-4.6`. Unlike the Anthropic provider, OpenRouter has
  no built-in default model, so both the key and model ID are required.

The **max output tokens** setting applies to both providers. Reasoning models
may spend part of that budget on hidden reasoning tokens, so increase it if a
model returns an incomplete or empty response.

API keys are stored locally, excluded from settings exports, and sent only to
the provider you select when you trigger an AI feature. Anthropic requests go
directly to Anthropic; OpenRouter requests go directly to OpenRouter.

**Translation** (Mod-Shift-T on a selection → copied to the clipboard) still
works without any AI setup through the default keyless MyMemory backend. In
Settings → Editing → Translation, **Auto** uses the configured AI provider when
AI is ready and otherwise falls back to MyMemory. You can also explicitly use
MyMemory, the selected AI provider, or Google Cloud Translation.

## Run from source

You only need this if you want to **build CardMirror yourself**
(contribute, run a development branch, or use the editor on a
platform we don't publish binaries for). For day-to-day use,
download a release above.

### 1. Install Node.js

CardMirror is built with JavaScript / TypeScript and needs **Node.js**
to run. Node is a regular desktop installer.

- **macOS** — open [nodejs.org](https://nodejs.org/) in your browser
  and click the blue **"LTS"** download button. Open the `.pkg`
  file from Downloads and click through the installer.
- **Windows** — open [nodejs.org](https://nodejs.org/) and click the
  blue **"LTS"** download button. Open the `.msi` file from
  Downloads and click through the installer.
- **Linux** — the easiest path is the official installer at
  [nodejs.org/en/download](https://nodejs.org/en/download/) — pick
  your distro and follow the few commands it shows.

You don't need to verify the install — if the next step works, Node
is installed.

### 2. Download the source

1. Open
   [the CardMirror page on GitHub](https://github.com/ant981228/cardmirror)
   in your browser.
2. Click the **green `<> Code` button** near the top of the file list.
3. Click **"Download ZIP"** at the bottom of the dropdown.
4. Unzip the download. You'll get a folder called
   **`cardmirror-main`**. Move it somewhere you can find later —
   your Desktop or Documents is fine.
5. **Open the `cardmirror-main` folder and look inside.** Some
   unzippers double-wrap. You want the folder that directly
   contains `package.json`, `README.md`, `index.html`, and `src/`
   — if you only see another `cardmirror-main` folder, that's the
   wrapper; open it.

### 3. Open a terminal inside that folder

A "terminal" is a window where you type commands. You're going to
open one already pointing at the CardMirror folder.

- **macOS** — enable Finder → right-click → *Services → New
  Terminal at Folder* once via System Settings → Keyboard →
  Keyboard Shortcuts → Services → Files and Folders, then
  right-click the folder.
- **Windows** — open File Explorer in the folder, click the address
  bar, type `cmd`, press Enter.
- **Linux** — right-click inside the folder and pick *Open Terminal
  Here* (Nautilus / Dolphin / Thunar all offer it), or open in terminal and
  `cd` to the filepath.

To make sure you're in the right directory, type `ls` (macOS / Linux)
or `dir` (Windows) and press Enter. You should see `package.json`,
`README.md`, `src`, `apps`. If you don't, your terminal is likely one
folder too high up — verify your current folder with the `pwd` command
(macOS / Linux / Windows PowerShell) or by typing `echo %cd%` (Windows, non-PowerShell).

### 4. Install dependencies

```sh
npm install
```

Downloads everything CardMirror needs. Takes 30 seconds to a couple
of minutes. Deprecation warnings are normal; only red `error` lines
indicate trouble.

### 5. Run the web edition

```sh
npm run dev
```

After a few seconds, open `http://localhost:5173/` in your browser.

### Run the desktop edition (from source)

```sh
npm run desktop:dev
```

This builds the Electron main process, starts the Vite dev server,
and launches the desktop window. Same code, same renderer — but in
a native window with file-system access.

### Coming back later

Open a terminal in the same folder; run `npm run dev` (or
`npm run desktop:dev`) again. To pick up newer code, download a
fresh ZIP and rerun `npm install` in it.

## Other commands

These all run inside the terminal pointed at the CardMirror folder
(same setup as the install steps above):

```
npm test            # run all tests
npm run test:bench  # performance benchmarks
npm run typecheck   # strict TypeScript check
```

### Testing round-trip against your own .docx files

The round-trip test suite and the round-trip benchmark both walk a
folder of `.docx` fixtures and run universal preservation checks on
each one (text length, heading IDs, mark counts, indent / spacing
multisets, etc.). Point them at any folder by setting
`CARDMIRROR_DOCS_DIR`:

```
CARDMIRROR_DOCS_DIR="/path/to/your/docx/files" npm test
CARDMIRROR_DOCS_DIR="/path/to/your/docx/files" npm run test:bench
```

When the variable isn't set, the suite looks under
`reference-docs/example docs/` (the project owner's local corpus).
When that folder doesn't exist either — the default state on a fresh
clone — the file-dependent tests skip cleanly and the rest of the
suite still runs.

## Round-trip a docx

The CLI imports a Verbatim/Advanced-Verbatim docx, normalizes it through
our schema, and re-exports a fresh docx:

```sh
npm run round-trip path/to/input.docx [path/to/output.docx]
```

The output is fully native to Verbatim — same canonical style ids, same
direct-formatting conventions. Stylepox and other non-Verbatim cruft is
dropped on import (per [`ARCHITECTURE.md §3`](./ARCHITECTURE.md)).

## Public API

```ts
import {
  schema,        // the ProseMirror schema
  fromDocx,      // .docx bytes → ProseMirror doc
  toDocx,        // ProseMirror doc → .docx bytes
  exportDoc,     // schema doc → { documentXml, relsXml }
  importDoc,     // document.xml → schema doc
  newHeadingId,  // generate a fresh stable heading UUID
} from 'cardmirror';
```

### Example: read a docx, modify, write it back

```ts
import { fromDocx, toDocx } from 'cardmirror';
import { readFile, writeFile } from 'node:fs/promises';

const buf = await readFile('input.docx');
const doc = await fromDocx(buf);

// `doc` is a ProseMirror Node — walk it, transform it, edit it...
console.log(`${doc.nodeSize} chars in tree`);

const out = await toDocx(doc);
await writeFile('output.docx', out);
```

### Schema highlights

```
doc:        sequence of block-level kinds
pocket:     Heading 1 paragraph (with stable id)
hat:        Heading 2 paragraph (with stable id)
block:      Heading 3 paragraph (with stable id)
card:       structured: tag (card_body | undertag | cite_paragraph | analytic | table)*
tag:        Heading 4 (only inside card)
cite_paragraph, card_body: body paragraphs inside cards
analytic:   outline-4 paragraph (Analytic style; can be standalone or in-card)
undertag:   Undertag-styled paragraph
paragraph:  unstyled body text (first-class — can sit between any nodes)
table:      table_row+ (at doc level OR inside a card / analytic_unit)
table_row:  (table_cell | table_header)+
table_cell: paragraph+
image:      inline atom (base64 bytes + EMU dimensions + alt; round-trips through .docx)
```

Every paragraph-like textblock carries round-trip-only attrs
`indent` (left indent in OOXML dxa) and `spacing` (verbatim
`<w:spacing>` map). Tables carry `rawTblPr` (table-level borders /
style / shading captured opaquely); cells carry `rawTcPr`
(per-cell borders, shading, vAlign).

Marks: `cite_mark`, `underline_mark`, `underline_direct`,
`emphasis_mark`, `undertag_mark`, `analytic_mark`, plus direct
formatting `bold`, `italic`, `strikethrough`, `superscript`,
`subscript`, `link`, `highlight`, `font_color`, `font_size`,
`shading`, `pilcrow_marker`, `font_family`, `comment_range`
(anchors a thread to a range of text).

See [`src/schema/`](./src/schema/) for full specs and
[`ARCHITECTURE.md §4`](./ARCHITECTURE.md) for design rationale.

## Acknowledgements

CardMirror is built on [ProseMirror](https://prosemirror.net/), the
modular rich-text editor framework created and maintained by
[Marijn Haverbeke](https://marijnhaverbeke.nl/). Nearly every editor
primitive CardMirror leans on — the schema-validated transactions,
the typed-tree document model, NodeViews, plugin state, the keymap
and history modules — is ProseMirror's.

The idea to use ProseMirror, as well as credit for dozens of course-corrections along the way, belongs to [text editor wizard Slim Lim](https://slim.computer/). 

If you're curious how ProseMirror works under the hood,
[Marijn's launch post](https://marijnhaverbeke.nl/blog/prosemirror-1.html)
is the best high-level introduction, and
[the ProseMirror docs](https://prosemirror.net/docs/) cover the
APIs in depth.

Thank you to Marijn and the ProseMirror community for the years of
careful library design that made this project tractable. If
ProseMirror has been useful to you too, Marijn's work is supported
directly at <https://marijnhaverbeke.nl/fund/>.

CardMirror's voice control was shaped by ideas pioneered in the
hands-free-editing community — [Talon](https://talonvoice.com/),
[Cursorless](https://www.cursorless.org/), and
[Pokey Rule](https://github.com/pokey).

The card sharing feature was conceived and prototyped by
[Q Cooper](https://github.com/mosuqc) of Missouri State University; his
proof-of-concept demonstrated the cross-machine send-and-receive flow the
built-in version is based on. Thanks also to Shreeram Modi, whose
[debate-scripts](https://github.com/shreerammodi/debate-scripts) for
Verbatim inspired a few features here — notably the customizable
acronym marking.

The Word-style image resize handles were contributed by
[Neo Cai](https://github.com/caineoyuan). The multi-doc nav rail's
per-document outline close and vertical resize were contributed by
[cora](https://github.com/coralynnkc). The find bar's viewport
clamping on narrow windows was contributed by
[Shreeram Modi](https://github.com/shreerammodi).

The app's interface icons are from the
[Untitled UI free icons](https://www.untitledui.com/free-icons),
used under their free license. See
[`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md) for the full
third-party attributions and license terms.

This project was funded by the subscribers at
[Debate Decoded](https://debate-decoded.ghost.io/) — subscribing is the
best way to support my work.

## License

CardMirror is licensed under the
[PolyForm Noncommercial License 1.0.0](./LICENSE). You can read,
fork, modify, and share the source for any noncommercial purpose
(personal use, hobby projects, debate-team and academic use,
research, government use, charitable / public-interest
organizations); commercial use requires a separate license. See
[`LICENSE`](./LICENSE) for the full terms.

Underlying dependencies (ProseMirror and friends) ship under their
own permissive licenses, preserved in `node_modules/`.
