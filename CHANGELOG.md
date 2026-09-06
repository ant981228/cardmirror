# Changelog

User-facing release notes for CardMirror. Brief summaries of what
changes in each release, written for users of the editor. For
in-depth rationale and implementation context behind each entry,
see `DETAILED_CHANGELOG.md`.

## Unreleased

### Added

- **Cloud pill and conflicted copies for shared folders.** A document
  in a Dropbox, OneDrive, Google Drive or iCloud folder now shows a
  cloud pill in the bottom-right corner of the editor, the mirror of
  the Send and Receive pills. When the file changes on disk under you,
  because a teammate saved it on another machine, the pill turns amber
  with the time, quietly, with no pop-up. Saving then never
  overwrites their version: your document is written beside it as a
  conflicted copy, named the way Dropbox names its own, and the window
  switches to the copy, with the pill reading "Conflicted copy". Click
  the pill to reload from disk, keep yours as a copy, or overwrite
  after a second confirmation. Autosave keeps both too instead of
  pausing.

### Fixed

- **Saving over a teammate's edits in a shared folder.** Opening the
  quick-card palette, a second window, or a speech document that pulled
  from a file could quietly convince CardMirror that the file's newer
  version was its own, so the next save replaced a teammate's work
  without a warning, and without a Dropbox conflicted copy. The check
  now belongs to the window editing the document and cannot be reset by
  anything else, it is re-checked right before the file is replaced, and
  a document recovered after a crash keeps its check too.
- **Flashcards no longer vanish when two windows are open.** Each window
  used to save the whole flashcard store, so a window opened before you
  created cards could overwrite them the next time it opened a file.
  One owner now applies every change and every window sees it at once,
  on desktop and on the web. A daily backup of the store is kept for two
  weeks in the app's data folder, and a store that cannot be read is set
  aside rather than overwritten.

## 1.7.0 — 2026-09-05

### Added

- **Choose which machine to unlink.** Linking a third machine to a
  membership now lists the machines already linked (name, link date,
  last active) and asks which one to unlink, instead of silently
  unlinking the oldest one — which was often the machine you use most.

- **Send to Recipient.** A keyboard sibling of Send to Starred: the
  same card or selection, but you pick the contact or group from a
  list (type to filter). Unbound by default — run it from the command
  bar or bind a key.

- **Card count in Word Count.** The Word Count window now shows how
  many cards are in the full document, or how many cards intersect the
  current selection. Thanks to Shreeram (@shreerammodi)!

- **Convert Cards to Read Mode.** A command (also answers to *zap
  card*) that permanently reduces the selected cards, or the card at
  the cursor, to what read mode shows: the tag, the cite, an undertag's
  read words, and the highlighted or underlined text, with paragraphs
  flowed together or kept on their own lines to match the "Read mode:
  preserve paragraph integrity" setting. Undo restores the cards. Thanks
  to Shreeram (@shreerammodi)!

- **Co-editing: cut moves a card instead of copying it.** In a shared
  document, cutting a whole card (or a section) no longer removes it:
  the card stays where it is, dimmed and labelled, and pasting it in
  the same document moves it, with everything a partner typed into it
  in the meantime. Cut-then-paste used to be a delete and a fresh copy,
  which could drop a partner's concurrent typing or leave the card
  twice. Esc cancels the cut, Delete removes the card, and pasting
  anything else ends it. Pasting into another document copies the card
  there and removes it from the original when that document is open.
  Text cuts and solo documents are unchanged.

- **Ctrl/Cmd-triple-click adds a whole paragraph.** Adding to a
  selection with Ctrl/Cmd now follows the same ladder as plain
  clicking: a click adds a word, a triple-click adds the paragraph, and
  a drag snaps to whole words after a double-click and whole paragraphs
  after a triple-click. Ctrl/Cmd-triple-click used to add just the word
  under the pointer.

- **Read mode: keep entire cite.** A new setting (General, next to
  "Read mode: preserve paragraph integrity", off by default) makes read
  mode show the whole of any cite that has read-aloud text in it,
  qualifications and all, instead of only its cite-marked and
  highlighted words. Convert Cards to Read Mode follows it.

### Fixed

- **Empty pockets kept their height in read mode.** An empty pocket
  (or hat, block or tag) shrank to a thin box in read mode; it is now
  the same height as when editing.
- **Co-editing: undo can no longer delete a partner's typing.** Undoing
  an Enter-in-tag, a card insert, or a card paste while a partner had
  already typed into the new card used to remove the card and their
  text with it, silently. Such an undo is now reversed on the spot with
  a note; undoing your own untouched edits works as before.
- **Co-editing: moves and splits keep cards' identities.** When a card
  was moved or split while a partner edited it, the sync layer could
  rebuild the card, orphaning the partner's edit (lost text) or leaving
  two copies. Cards now keep their identity through those merges.
- **Co-editing: a duplicated heading id born from a merge is repaired.**
  Pasted cards get fresh ids, but an older client's paste, or an edge
  case in a merge, could leave two cards sharing one id, and nothing
  looked at remote edits to fix it. The session's repair pass now does,
  on the leader, and every peer converges on unique ids.
- **Co-editing: typed text no longer tears under a partner's concurrent
  split or delete.** When a word you typed began or ended with the same
  letters as its neighbour, the sync layer treated part of the
  neighbour as your new text; a partner splitting or deleting that
  neighbour at the same moment then took a piece of your word with it
  ("«tk16» «tk3»" came out as "16» «tk"). Local edits now sync as
  exactly the characters you typed or deleted.
- **Splitting a numbered tag keeps the number on the first half.** Enter
  in the middle of a numbered tag or heading built the new unit with
  default numbering and put it first, so the number followed the text
  after the cursor. The half before the cursor keeps the original
  numbering; the half after it starts fresh.
- **Co-editing: sessions no longer wedge on a dead connection.** A
  request that never answered (a laptop lid closed mid-send, a network
  that changed underneath) could leave a session stuck on "queued N"
  with no retry, and a silently dead live stream was never noticed by a
  peer who was only reading. Every request now has a deadline, the
  stream restarts after 70 seconds of silence, and a wake-up no longer
  cancels the reconnect it just started. Large catch-up pages get the
  long deadline, not the short one, so big rooms on slow links still
  join.
- **Co-editing: relay restarts and outages recover cleanly.** Reconnect
  backoff only resets once a connection has survived a while, retries
  spread out instead of stampeding, joining retries a relay that is
  briefly unavailable instead of failing or opening a stale copy, and a
  page loop that stops advancing ends instead of hammering the relay.
  A machine whose web login has expired stops sending empty
  credentials all night.
- **Co-editing: offline edits no longer land as hundreds of updates.**
  Ten minutes offline used to arrive as one relay row per half-second
  tick, for everyone to fetch and decrypt. Queued edits now coalesce
  into one update before sending; catch-up skips rows the live stream
  already delivered and decrypts the rest in parallel; the half-hourly
  history audit runs behind a fresh catch-up instead of re-fetching a
  stale window.
- **Co-editing: the room log stops growing without bound.** A flag that
  blocks snapshot compaction while updates are missing could latch on
  and never clear, so the room's history grew for the life of the
  session: slower joins for every peer. It is now derived from what is
  actually still missing. Corrupt frames no longer cause a permanent
  gap in catch-up either.
- **Co-editing: big documents stay responsive.** Repair passes after
  each remote update walk only the changed region instead of the whole
  document; the causal heal no longer decodes the full history during
  the join freeze; remote carets are reused instead of rebuilt on every
  keystroke; presence dots and footers repaint once per burst; crash
  recovery writes slow down for very large documents and share one
  snapshot with version history; switching back to a big co-edited tab
  no longer freezes the window.
- **Co-editing: problems are told, not swallowed.** A send that keeps
  failing, three minutes disconnected (with the count of edits waiting),
  a session that cannot save its recovery copy, and being crowded out of
  a full room each show a notice now. Relay errors carry the relay's
  own explanation ("update too large" vs "room storage cap reached").
- **Co-editing: leaving a session removes your caret at once** instead
  of up to 45 seconds later, and presence is re-announced after a
  reconnect or an aborted departure.
- **Co-editing: join, resume and teardown races closed.** Double-clicking
  Join or Resume could run two sessions on one room; a room-full or
  failed join left a ghost session polling for the life of the window;
  ending a session could leave a retry timer and a late send behind;
  the "working…" veil could stick forever; a failed cleanup showed a
  generic error over "Session ended". Switching to three-pane or
  quitting now flushes version history as well as the recovery copy,
  and hiding the tab flushes unsent edits immediately.
- **Co-editing: the caret's paragraph stays known to the sync layer
  after an undo or a partner's edit.** Every render from the shared
  document rebuilt the card and paragraph around the change as new
  objects without telling the sync layer, so cursor sharing and undo
  bookkeeping under the caret failed quietly, once per keystroke, until
  the next local edit in that paragraph. Loudest after undo; on the web,
  and in the console, as "Cannot find the loroNode". A remote batch that
  changed nothing visible left the same staleness behind; it no longer
  does. The same message also fired, harmlessly, for selections made
  before the sync layer had bound a freshly opened document or
  mid-batch; it no longer does.
- **Co-editing: a resolved/reopened comment no longer shows stale on the
  peer that lost the race.** If two people toggled a comment's resolved
  state at the same moment, the loser's own screen kept its value while
  everyone else showed the winner's, until the next comment change.
- **Co-editing: comments and Recover Previous Version do less work.** A
  partner resolving a comment no longer re-renders every thread on
  every peer; a comment edit the room silently dropped is now counted;
  the session-history dialog imports its source once per open instead
  of once per preview click.
- **Web account renewals are single-flight** with a deadline, run on
  wake and tab focus, and no longer unlink the account when a captive
  portal answers with an HTML error.
- **The AI persona's Customize dialog takes typing again.** Opened from
  Settings, its fields ignored every keystroke: the Settings dialog kept
  ownership of the keyboard because the dialog on top never registered
  as one. It does now, and Escape closes only the dialog on top.
- **Web: switching back to the tab no longer reconnects the session.**
  Returning to the tab restarted the live stream every time, which cost
  a reconnect, a catch-up and a presence flicker on every partner. It
  now reconnects only if the stream has actually gone quiet.
- **Web: closing the tab says goodbye and pushes your last edits.**
  A tab close used to drop the departure notice (partners saw your
  caret for 45 more seconds) and could cancel the final send. Both now
  go out as requests the browser finishes after the tab is gone; the
  crash-recovery record still re-sends anything that did not make it.
- **The Send pill scrolls while you drag.** Long recipient lists were
  unreachable past the first screenful during a drag; holding the
  dragged card near the top or bottom of the list now scrolls it.
- **Regenerating your pairing code releases its seat.** The old code's
  seat stayed held on the relay, so the regenerated machine's re-link
  could push out a machine you still use.
- **Refused account renewals back off** instead of retrying every few
  minutes.
- **A lapsed membership that re-subscribes reconnects on its own.**
  Linked machines used to need re-linking after a lapse; the relay now
  hears about membership changes directly (live since 2026-09-04,
  independent of this build).

## 1.6.0 — 2026-09-01

### Added

- **Reading view (Word-style paginated columns).** The new book
  button on the ribbon (in the navigation pane toggle's old spot)
  flips the current document into full-screen column pages for
  reading a speech: one to three columns sized from the pane width
  (respecting the maximum-text-width accessibility cap), arrow keys /
  Page keys / Space / one mouse-wheel click flip a full screen at a
  time, with click zones at each edge and a page indicator. The
  navigation pane stays available and clicking it jumps to the right
  page. Editing is locked except dropping reading markers, and it
  combines with Read Mode. Per-document: in the three-pane workspace
  each document keeps its own state — full-screen the slot you're
  speaking from as usual. Page flips are animated by default;
  "Reduce animations in reading view" in Accessibility (or the global
  Reduce motion setting) makes them instant. Show/Hide Navigation
  Pane remains available from the command bar, as a custom ribbon
  button, and as a bindable shortcut.
- **New setting: Drag to rearrange (Settings → General).** Turns the
  drag gestures for moving content — navigation-pane rows and the
  editor's pickup drag — on or off. Default on. Turn it off on touch
  devices (iPads) where scrolling with a finger keeps picking up
  headings instead; clicking still navigates, and pane resizing is
  unaffected.
- **Recover Previous Version, overhauled.** Both version dialogs — the
  saved-document snapshot list and a shared session's history — are now
  two-pane: click a version to read it right there in a full-fidelity
  preview, complete with its own navigation pane (level buttons,
  expand/collapse, your nav styling), instead of opening windows to
  find the right one. Version rows now tell you what's in them: word
  and card counts, what changed vs the previous version ("+3 cards ·
  +1,240 words"), and — the question you actually came to answer — a
  badge showing how many cards a version holds that your current
  document doesn't. Snapshots also record what saved them (manual save
  vs autosave), shown as a chip on each row. Opening a version still
  makes a separate unsaved copy; nothing touches your document or the
  shared session.
- **New command: Open Containing Folder.** Reveals the current
  document, highlighted, in Finder / File Explorer. Unbound by
  default — run it from the command bar (try "reveal in finder" or
  "show in folder"), or wire it to a custom ribbon button or shortcut.

### Fixed

- **Small UI polish.** Clicking a color-picker's arrow now closes its
  open picker instead of reopening it; the Doc, Card, and Table menu
  chevrons align consistently; the settings theme buttons have proper
  hover and selected contrast; and switching settings tabs no longer
  shifts the tab bar's layout. Thanks to Elli (@0-elli)!
- **Duplicate and missing heading identities can no longer be created
  while editing.** Certain edits — pasting into the middle of a
  heading, or deletions that rebuild a card's structure — could
  silently give two headings the same identity (making nav-pane
  clicks jump to the wrong one) or none at all (making a heading
  invisible to the nav pane). A safety net now repairs the identity
  on the spot, as part of the same edit. Documents already carrying
  these from older versions are still repaired when opened.
- **The timer's threshold flash no longer lags typing.** The flashing
  countdown animated in a way that competed with the editor for the
  main thread, so keystrokes hiccupped during every flash window on
  large documents. The pulse now runs entirely on the compositor —
  typing cost is unaffected no matter the document size. (The flash
  peak now shows your normal text color on red rather than white.)
- **Pasting or deleting across certain card boundaries no longer
  fails silently.** A few selection and paste shapes had no legal
  result and crashed internally, eating the keystroke or the paste
  with no feedback. They now complete sensibly where possible (the
  pasted content is placed whole; the selection merges cleanly) and
  otherwise do nothing visibly instead of breaking the editor.

## 1.5.1 — 2026-08-29

### Fixed

- **Long-running collaboration sessions no longer lose sync when
  their sign-in credential rotates.** A session held onto the
  credential it started with; when that credential expired (they
  refresh roughly every three days), syncing silently stopped and
  nothing short of restarting the app — not even unlinking and
  relinking your account — could revive it. Sessions now always
  present the current credential, so background renewal (or a relink)
  takes effect immediately.
- **Typing or deleting over a selection that ends inside a card's tag
  (or an analytic's heading) now works.** Selecting from one card or
  analytic into the middle of the next one's heading and then typing
  or pressing Delete used to do nothing at all. It now behaves as if
  the boundary had been deleted first: the rest of the heading's text
  and the remaining body flow up into the block you started the
  selection in.
- **Saving can no longer hang forever preparing a .cmir file.** The
  background thread that compresses .cmir saves could die silently in
  a long-lived window, leaving the Save button stuck in its saving
  state (and Save As never reaching the file picker) with no error.
  Compression now falls back to the main thread within a few seconds
  if the background thread stops responding, and the save-progress
  warning now also covers the preparation step, so any slowdown there
  shows a notice instead of silence.

- **Nav-pane clicks no longer jump to the wrong heading in documents
  that picked up duplicate heading identities from a Word round
  trip.** Word add-ins and other editors can duplicate the invisible
  bookmark CardMirror uses to identify a heading — for example when a
  heading line is copied as a formatting template and retyped —
  which made clicking one heading navigate to the other, and could
  point live views at the wrong section. Importing a .docx now keeps
  the first occurrence and assigns the copy its own identity, and
  documents that already carry duplicates are repaired automatically
  when opened.

## 1.5.0 — 2026-08-28

### Fixed

- **Installing CardMirror no longer removes Word's "New → Microsoft
  Word Document" right-click menu entry on Windows.** The installer
  claimed the .docx file type's default handler, which hid Word's
  New-menu entry and could leave the .docx association dangling after
  an uninstall. CardMirror now registers only as an "Open with" choice
  for .docx — Word keeps its default and its New menu — and installing
  this version automatically repairs machines the old installers
  affected. Thanks to [Q Cooper](https://github.com/mosuqc) for
  sketching out the fix.
- **Unlinking your Debate Decoded account now frees that machine's
  seat immediately.** Disconnecting used to only forget the link on the
  machine itself, so the seat stayed occupied server-side and could
  block linking a new machine until it was manually replaced. (If the
  app is offline when you disconnect, the seat is released the old way
  — when a new machine takes it.)
- **Linking a third browser past the seat limit now works when you
  confirm.** On the web edition, confirming "Link This Browser" in the
  seat-limit dialog re-showed the same dialog instead of linking; the
  confirmation now goes through.
- **A collaboration session joined by invite link now ends cleanly
  when the invite expires.** Invite credentials last seven days;
  before, a session past that point silently retried forever and just
  looked offline. It now shows "Session invite expired," keeps your
  copy of the document, and stops — ask the host for a fresh link to
  rejoin. A brief sign-in page on school or hotel wifi is not
  mistaken for an expired invite, and being offline never triggers
  this.
- **Genuinely empty files now open as blank documents.** A zero-byte
  file — like the one Explorer's "New → Microsoft Word Document"
  creates — opens as a blank document bound to that file, the same way
  Word treats it, instead of showing "This file is empty or hasn't
  finished downloading." Cloud-synced files that haven't finished
  downloading still get the downloading message as before.

### Added

- **External apps can insert fully formatted content.** The local
  insert bridge accepts an optional rich payload alongside the plain
  text: content arrives with structure, highlighting, and cite
  formatting intact, and whole cards land at the correct outline
  position. Plain-text senders and older versions are unaffected.

## 1.4.0 — 2026-08-25

### Changed

- **Pasting a card now leaves the cursor at the end of what you
  pasted**, matching every other paste. The old behavior — cursor at
  the end of the pasted card's tag, ready to rename it — is available
  as a setting: Settings → Editing → Paste → "Cursor after pasting a
  card".

### Fixed

- **A save that hangs is no longer silent.** When a document's folder
  stops responding mid-write — typically a cloud-synced file that has
  to download before it can be written — CardMirror now says so after
  10 seconds, and a manual save offers Save As… after 30 seconds so
  your work always has an exit. Previously the save button appeared to
  do nothing at all. The save button also now shows an amber
  in-progress state whenever a save is still running.

- **Very long toasts wrap instead of running off the screen**, and a
  toast near the screen edge now stays fully inside the window.

- **Whitespace-only headings no longer squash their navigation row.** A
  heading containing only spaces rendered as a sliver in the nav pane;
  it now gets the same full-height row as a blank heading.

- **Flow sends starting with `=`, `+`, `-`, or `@` no longer fail.** Excel
  reads those as the start of a formula, so an analytic like "- turns the
  case" was rejected instead of written. Sent cells are now always written
  as text.

### Added

- **Version history for saved documents.** CardMirror now keeps
  periodic snapshots of every saved document on your computer —
  protection against a bad edit, a corrupted file, or a sync service
  eating a save. Browse and restore them with **Recover Previous
  Version**: with no session active, the command now lists the current
  document's saved versions directly. Snapshots live in app data (never
  next to your files), are capped and expire automatically, and the
  new **Keep version history** setting (Settings → General) chooses
  Standard (default, up to 30 days within 500 MB), Extended (up to 90
  days within 2 GB), Custom (caps of your choosing), or Off — with a
  live disk-usage readout and a clear-history button.

- **Plugins can declare multiline settings.** A new `multiline` setting
  type renders a full-width textarea in the plugin's settings modal —
  for list-shaped values like keyword lists, one entry per line.

- **Browse plugins.** Settings → Plugins gains a Browse button next to
  the install field: a searchable list of curated plugins — name,
  description, and author from each plugin's own release — with
  one-click install. Installing from the list runs the same consent
  dialog as installing by name.

- **Arial Narrow in the font picker.** Available under Microsoft Office
  defaults for both the document and interface font. Machines without
  Arial Narrow installed render with the bundled metric-compatible
  Liberation Sans Narrow, so documents keep their layout everywhere —
  including the web editor and Linux.

## 1.3.0 — 2026-08-20

### Added

- **Collaboration works on the web.** Card sharing and co-editing are no
  longer desktop-only: the web editor on any desktop-layout browser —
  Chromebooks included — now has the full Collaboration settings tab,
  session hosting and joining, and card sharing. Sessions started on
  the web copy an **invite link** anyone can join from a browser with
  no account and no setup, and every edition has a **Copy Session
  Invite Link** command. Hosting sessions and sharing cards on the web
  use the same linked account as desktop. Everything stays off until
  you turn on **Enable collaboration**; the mobile layout and
  CardMirror Lite have no collaboration.

- **Cites sent from other apps can arrive pre-styled.** The Fast Debate
  Paste insert bridge accepts an optional list of cite-emphasis spans
  (the author/date "F8" part), applied on arrival — cites relayed
  through Fast Debate Paste can land already formatted.

### Changed

- **Settings → General → About this install got a tidy-up.** The
  pause-updates caption sits above its button (matching the rest of
  Settings), and **Open crash dumps folder** moved into its own
  "Crash dumps" section with a description of what the folder is for.

## 1.2.0 — 2026-08-18

### Added

- **CardMirror Lite.** A separate edition for school-managed devices:
  the same editor with every network-dependent feature removed from
  the build itself — no AI, no collaboration, no accounts, no
  plugins, no update checks, and no network communication at all. On
  the web at **lite.cardmirror.app** (locked down by a
  browser-enforced security policy IT departments can verify), and as
  "CardMirror Lite" desktop installers that live alongside a standard
  copy. Documents move freely between Lite and the full edition.

### Fixed

- **Numbered lists restart properly in Word again.** Exported documents
  wrote each list as its own Word counter but never told Word to
  restart it, so separate lists rendered as one continuous 1, 2, 3…
  sequence across the whole file when opened in Word — even though
  CardMirror displayed them correctly. Each list now restarts at 1.
  Exported substructure letters also match the editor's default
  separator now ("a." instead of "a)").

- **Clod's thinking indicator sits properly in comment threads.** The
  activity line now renders where a timestamp would, directly under
  the name, instead of floating mis-aligned below the block.

- **The AI status pill stays pinned to your text on the web editor.**
  It could drift to the top of the document when the page scrolled.

- **Reformat Every Cite on the web says "double-tap Esc to stop"** —
  matching how stopping actually behaves there. Desktop is unchanged
  (a single Esc).

- **Checking for new shared cards is much lighter on the network.**
  Empty mailbox checks now cost almost nothing, on both editions.

## 1.1.0 — 2026-08-17

### Added

- **The status bar can show how much is left to read.** Turn on
  **Settings → General → "Live read time for what is left to read"**
  and the bottom bar gains a third readout — every read-aloud word from
  your cursor to the end of the document, with each of your top two
  readers' times for it. Handy mid-speech, or for checking whether the
  rest of a block fits the time you have left. Off by default; with
  text selected it measures from the end of the selection, and it stays
  quick on long files. Thanks to Cora (@coralynnkc)!

- **The navigation pane follows your place in the document.** The
  outline now scrolls to keep the section you're in visible (on by
  default — turn off **Navigation pane follows the cursor** in Settings
  → General → Workspace to keep the old behavior). Moving the cursor into a different section brings
  that heading into view; changing depth with the **1 · 2 · 3 · 4**
  buttons — which rebuilds the outline and has always scrolled it back
  to the top of the document — instead keeps the section you were in at
  the top. If that section is hidden at the current depth, the outline
  follows its nearest visible parent. The pane only moves when the
  heading would otherwise be off-screen, so typing within one section,
  or scrolling the outline by hand, leaves it alone. Nothing but the
  outline's scroll position moves: your cursor, your selection, and the
  document are untouched. Thanks to Cora (@coralynnkc)!

- **A guided tour of the interface.** New installs start with a
  step-by-step spotlight walk over the editor, the style clusters, the
  outline, read mode, the timer, and more — including a hands-on stop
  where you open the command bar yourself and use it to reach
  Settings. Step with the buttons or ← →, skip with Esc, and rerun it
  any time with the **Take the UI Tour** command. If you've ever
  changed a setting, CardMirror assumes you know your way around and
  won't show it uninvited.

- **A notice center in the status bar.** Errors and important status
  updates now also land under a small chip at the bottom of the
  window, where they stay until you dismiss them — no more trying to
  read a toast before it fades. The chip is grey for routine notes,
  yellow when something needs your attention, and red for problems;
  click it to re-read, copy, or dismiss messages, individually or all
  at once. Repeats of the same message collapse into one entry with a
  counter.

### Fixed

- **Changing the outline depth no longer loses the "you are here"
  highlight.** The navigation pane highlights the heading your cursor is
  in, but clicking the **1 · 2 · 3 · 4** buttons rebuilt the outline
  without restoring it — so whenever the new depth hid your heading, the
  highlight simply vanished and nothing showed where you were. It now
  falls back to the nearest visible parent, the same as everywhere else.

- **Cards no longer lose their tag line after cut-and-paste round
  trips.** Certain cuts could paste back a card without its tag,
  quietly damaging the document — later symptoms included line breaks
  that refused to stick and repair prompts on save. Pastes are now
  healed as they arrive, the editor repairs any damaged card on the
  spot, and documents damaged by earlier versions heal when reopened.

### Changed

- **The welcome guide caught up with 1.0.** It now introduces card
  sharing and co-editing, matches the current settings names and
  locations, and gives "Done with the tour?" its own heading so the
  off-switch is easy to find. The out-of-date "alpha software" warning
  is gone.

- **The account row in Settings shows its state at a glance.** A green
  "✓ Connected as …" or a red "✕ Not connected" chip replaces the old
  explanatory paragraph, and disconnecting updates the row immediately
  instead of waiting for the dialog to be reopened. Wording across
  Settings and the manual now reflects that card sharing and
  co-editing on the official relay require a linked paid membership.

- **Pop-up messages stay visible long enough to read.** Toasts now
  time out based on how much text they hold instead of a flat one
  second.

- **Decisions come as dialogs, not disappearing toasts.** If a file
  changed on disk while autosave was on, CardMirror now asks whether
  to overwrite it or save elsewhere instead of silently pausing
  autosave; a failed write to a Word live-source file offers a retry
  once you've closed it in Word.

- **Substructure numbering now defaults to "a."** instead of "a)",
  matching the number style. Display-only — if you picked a separator
  yourself, your choice is kept.

## 1.0.1 — 2026-08-15

### Added

- **Right-click menu in the editor.** Right-clicking text now offers
  Cut, Copy, and Paste, with the usual shortcuts listed alongside.
  Links, images, and spelling suggestions keep their own menus. Cut
  never deletes anything unless the copy actually reached the
  clipboard, and a failed copy says so instead of failing silently.

### Fixed

- **The sticky highlighter pen only paints real strokes now.** With
  the pen armed, releasing any click over selected text used to apply
  the color — including a right-click, so select-all followed by a
  right-click could highlight an entire document in one accidental
  gesture, live in a shared session. Painting now requires a genuine
  stroke: a mouse drag (or a double/triple-click word select) made in
  the editor itself.

- **Tables no longer corrupt when co-editors change rows and columns
  at the same time.** Two people simultaneously adding a row and a
  column could leave a table with uneven rows, after which the next
  "Add Row" could corrupt the document — and leave participants
  permanently seeing different tables. Table commands now straighten
  the table out first, previously-damaged tables repair themselves
  automatically, and everyone else in the session keeps the affected
  row's contents intact.

- **Formatting syncs more cleanly in co-editing sessions.** Editing
  text near minimized runs no longer re-sends formatting that didn't
  change — redundant updates that could overwrite a partner's
  concurrent formatting edits on the same text.

## 1.0.0 — 2026-08-13

CardMirror 1.0. Thank you to everyone who used the editor through the
beta — it is what it is because of you.

### Changed

- **Co-editing sessions started on 1.0 use a new, sturdier document
  format.** Cards now keep their identity when moved, which closes the
  last known concurrent-reordering gap: in beta.32 two people moving
  the *same card* at the same moment could still leave a duplicate
  behind; in new sessions every card lands exactly once, no matter how
  simultaneously people reorder. Sessions started before updating keep working for everyone
  exactly as before — nothing to migrate. Because older builds can't
  read the new format, invites to 1.0 sessions ask participants on old
  versions to update instead of joining; updating everyone in your
  group together is the smoothest path.

- **Machines linked to a Debate Decoded account now identify
  themselves to the relay on each request.** This underpins upcoming
  account-security improvements (a linked account can be limited to
  the machines it was actually connected on). No visible change, and
  nothing changes for unlinked machines or self-hosted relays.

### Fixed

- **Dragging a section header (with everything under it) during a
  co-editing session now merges cleanly when others reorder at the
  same time.** Previously two people dragging sections simultaneously
  could garble a nearby card's text and leave a duplicate copy of the
  dragged section. In sessions started before updating, the same fix
  prevents cards from being lost or garbled in that situation; a
  simultaneous drag of the *same* section can still leave a visible
  duplicate there — new sessions don't even have that.

- **Recover Previous Version no longer hangs opening a version of a
  large, heavily edited session.** Versions are rebuilt by replaying
  the session's history rather than the previous method, which could
  spin forever on big documents.

- **The Send pill knows when you're already in a session.** With a
  live session on the document you're looking at, its "Start session"
  action becomes **"Copy code"** — clicking copies the session code
  for a teammate instead of dead-ending. It switches back the moment
  you focus a session-less document or the session ends. The Receive
  pill gains a matching **"Join session"** button at the bottom of its
  popup — always available, since joining needs nothing but a code.

- **Read mode shows highlighted text inside cites.** Underlining or
  emphasizing part of a cite blocks the cite style on that run, so
  highlighting it still left it hidden in read mode. Cite paragraphs
  now keep anything cite-styled *or* highlighted, in single-pane and
  three-pane alike; unmarked cite filler stays hidden. Word counts and
  read-time estimates agree: highlighted cite text counts at the full
  body reading rate, not the tag/cite rate.

- **Windows: the window and taskbar icon renders fully again.** The
  packaged icon had degraded to a single oversized layer that Windows
  could only draw as a thin sliver; the app now ships a properly
  layered icon (16–256 px).

- **Joining a new-format session by pasted share code on an old build
  now fails cleanly instead of joining and crashing.** Invites already
  told old versions to update, but a pasted code slipped past that
  check — the old build joined a session it couldn't read and hit
  errors on the first reorder. New sessions now use a share-code
  format old builds don't recognize (they see "that does not look like
  a share code"), and current builds show a proper "update to join"
  message for any future floors.

## 0.1.0-beta.32 — 2026-08-12

### Added

- **Recover Previous Version — get back what a bad co-editing session
  destroyed.** In a collaboration session everyone can only undo their
  *own* changes, so if a document gets wrecked — a bad merge, or someone
  joining just to deface it — there was no way back. CardMirror now
  keeps a history file for each session (in the same folder as the
  crash-recovery journals, cleaned up after 30 days). The new **Recover
  Previous Version** command (command bar; no default key) lists the
  session's earlier states grouped by pauses in the editing, lets you
  expand a group down to individual changes, and opens any of them as a
  **separate unsaved copy** — in its own window, or into a pane of the
  three-pane workspace — the shared document is never touched. Not in a session, the command opens the history folder
  directly so you can pick a file, and **Recover from file…** does the
  same from inside the dialog. The privacy policy's device-storage
  section describes the new file.

### Fixed

- **Three-pane: one session indicator per pane, and the Send pill's
  Start Session now works.** The status bar's global "Session: synced"
  chip duplicated the per-pane indicators in the multi-doc workspace —
  and could mislead, since it kept showing the one live session even
  while you were looking at a document without one. Three-pane now
  relies on the per-pane indicators alone (single-pane keeps the chip).
  Separately, starting a session from the Send pill in three-pane
  targeted the window rather than a document — a confirm dialog with
  every open doc's name mashed together, then a session no pane would
  claim. It now starts the session for the focused document, exactly
  like the Start Collaboration Session command.

- **Ending a session could leave the "Session: synced" chip stuck.**
  The chip cleared based on a snapshot of which session it was showing,
  taken before an async teardown — a focus change in that window let
  the ghost survive. It now repaints from the live session state, which
  can't go stale.

- **Starting or joining a session on a large document no longer looks
  like a hang.** Preparing a big document for collaboration is real
  work (the whole document is converted for syncing), and the editor
  used to simply freeze with no explanation — now a "Preparing
  collaboration session…" veil says so while it happens. The same
  honest busy state covers opening a large shared document when
  joining, and the recover dialog's **Open copy** while it rebuilds a
  version.

- **Reordering cards during a co-editing session could silently lose
  or duplicate cards.** This needed genuinely simultaneous reordering:
  two people each moving cards before either copy had synced the
  other's move (most likely while one was offline), so most sessions
  would never have hit it. When it did happen, the merge could quietly
  destroy some cards and double-print others, with no error and every
  copy of the document agreeing on the damaged result. Long-distance
  moves (dragging a card far in the outline) also generated wildly
  oversized sync traffic that stayed in the session's history forever;
  a single long drag now costs about as much as typing a few words.
  Between up-to-date copies, nothing is ever lost anymore. One narrow
  corner remains until the next major release: if two people move the
  *same* card at the same time, it can end up in both places — a
  visible duplicate you can just delete, rather than a silent loss.

### Changed

- **Requests to the relay now say which version of CardMirror sent
  them**, and the privacy policy has been updated to describe it. The
  relay previously had no way to tell releases apart; naming the
  version lets it keep serving older ones deliberately rather than by
  accident, and lets a version be turned away if it's too old to work
  correctly. It's the app's version number and nothing else — it says
  nothing about you, your device, or your documents.

### Fixed

- **Clean's overwrite confirmation accepts the phrase the way it's
  shown.** Cleaning files in place asks you to type a phrase to
  confirm, and the instruction displays it in capitals — but the
  check wanted it in sentence case, so typing exactly what the
  screen showed left **Confirm Overwrite** greyed out with nothing
  to explain why. The phrase now matches however you capitalize it
  (and doesn't mind extra spaces), and the instruction no longer
  shouts a form the box won't take.

- **About this install names ChromeOS and iOS.** Settings → General
  → About this install reported "Unknown" as the operating system on
  every Chromebook, and reported iPhones as macOS — the two most
  confusing possible answers on the two platforms hardest to guess
  from a bug report. Both are now named correctly. (An iPad running
  current iPadOS still reports macOS: it identifies itself to every
  website as a Mac, and nothing in what it sends distinguishes the
  two.)

## 0.1.0-beta.31 — 2026-08-10

### Added

- **Morph mode: a Sensel Morph control surface for cutting cards.**
  If you happen to own a Sensel Morph with the video-editing overlay
  (discontinued, beloved), CardMirror can now treat it as a dedicated
  card-cutting deck. Run **Toggle Morph Mode** from the command bar
  (no default key — bind one in Settings → Keyboard shortcuts). While
  armed: the jog wheel moves the caret — hold the overlay's
  Shift/Alt cluster while wheeling for letter- or word-wise selection
  — and the pad bank applies formatting to whatever you've selected:
  underline, emphasis, tag, cite, condense and friends, each pad
  rebindable to any command from the ⚙ on the status chip, which
  draws the whole overlay as a labeled schematic. Pads only fire
  while a selection is active, so with a bare caret everything still
  types normally. The chip echoes each command as it lands, exactly
  like the voice pill. Some features are just for me!

- **Open Crash-Recovery Journals Folder.** A command-bar command that
  opens the folder where CardMirror keeps its `.cmir-journal`
  crash-recovery files, for when you want to see (or back up) what
  would be restored after a crash. Desktop only; no default
  keybinding.

## 0.1.0-beta.30 — 2026-08-07

### Added

- **Read mode can keep your paragraphs apart.** Read mode has always
  run a card's highlighted text together into one continuous block.
  The new **Read mode: preserve paragraph integrity** setting
  (Settings → General → Editor behavior) puts each body paragraph back
  on its own line, so what you read follows the shape of the document.
  Paragraphs with nothing highlighted in them still vanish outright —
  you never get a blank line where a skipped paragraph used to be. Off
  by default, and display-only: nothing about the document changes,
  the same way the rest of read mode works. (PR #33, thanks to
  [Cora](https://github.com/coralynnkc).)

### Fixed

- **No more false "changed on disk" warnings from cloud sync.** Some
  sync setups (rclone-mounted Dropbox on Linux, most visibly) rewrite
  a file's timestamp after uploading CardMirror's own save, which made
  the next save warn that the file had been modified even though
  nothing touched its contents. CardMirror now checks whether the
  content actually changed before warning — real edits from another
  machine or program are still caught exactly as before.

- **Fixed a "JavaScript error in the main process" crash dialog on
  Linux.** When the app's logging pipe had been closed by whatever
  launched it, reporting any error could itself crash with
  `write EPIPE` — hiding the real message behind a scary dialog.
  Logging is now best-effort and can never take the app down.

- **Web app: saves blocked by cloud folders now recover or route to
  Save As.** On ChromeOS (and anywhere the browser's file access sits
  on a cloud-backed folder), saving in place could fail with a raw
  browser error and no way forward. The web app now refreshes and
  retries once — which rescues the common sync-churn case — and when
  the folder truly won't accept in-place writes, it offers Save As to
  a local folder instead of a dead-end error.

## 0.1.0-beta.29 — 2026-08-05

### Added

- **Copied text brings its comments along.** Copying a commented span
  used to carry only the faint yellow background — the comment itself
  stayed behind, so pasting into another document left an anchored
  highlight with nothing in it. Now the comment travels with the text:
  paste into another document, another window, or another machine's
  document and the full thread — replies, authors, resolved state —
  arrives with it. Pasting a copy where the comment already lives
  duplicates it under its own thread (the same thing Word does), so
  each pasted copy can be discussed separately. The same rule holds
  however a copy is made — Alt-drag, nav-pane section copies, cards
  dragged back out of the dropzone, cards sent to yourself: a comment's
  range can only ever grow by typing inside it, never by landing a copy
  next to it. And if commented content arrives somewhere its comment
  can't follow (a card sent from another machine), the leftover
  highlight is dropped instead of showing a comment with nothing in
  it.

- **Add contacts and start sessions right from the Send pill.** The
  Send pill grew an actions row. Click the pill open and you can **Add
  contact** (paste their pairing code, give them a name, done — no
  trip to Settings) or **Start session** for the current document.
  While dragging a card, the same two spots become drop zones: drop on
  the left to send to a pasted pairing code as a one-off, or hover the
  right to open your **recent senders** — people who recently sent you
  cards or invites — and send back to one without any pairing setup.

- **Recent senders is now a full setting.** Settings → Collaboration
  lists everyone who recently sent you something; from there you can
  add them to your recipients (with a name of your choosing) or block
  them, and rows already in your recipients say so.

- **Hide a recipient.** The eye button next to a recipient hides
  them from the Send pill without deleting them — groups they belong
  to still reach them, and hiding is independent of starring. Unhide
  any time from the same spot.

- **Multi-selections send as one bundle.** Dragging a nav-pane
  multi-selection onto the Send pill now ships everything as a single
  item. The recipient sees one row with a **×N** count — the N counts
  what you selected (three blocks is ×3 no matter how many cards they
  contain) — and takes the whole bundle in one click, drag, or
  dismissal; no grabbing half a set.

- **Received cards respect your outline depth.** Cards taken from the
  Receive pill — and documents arriving when you join a session — now
  fold in the nav pane to your current outline depth instead of
  landing fully expanded.

### Changed

- **The comments panel got a visual tune-up** (private notes and AI
  Q&A too — they share the design). Author names and timestamps now
  stack — name over a small muted time — so nothing wraps raggedly at
  narrow panel widths, and comment text aligns to one clean left
  edge. The resolve control is a quiet check like the other icons
  (blue when resolved) instead of a filled blue circle, edit and
  delete buttons appear when you hover a comment instead of
  cluttering every row, and the reply box's send and 👍 are compact
  matched buttons instead of a full-height blue slab. The reply box
  itself now spawns one line tall — matching its buttons — and grows
  as you type, up to about six lines before it scrolls.

### Fixed

- **Typing at the bottom of the document no longer hides behind the
  Send/Receive pills.** When the pills are showing and you type near
  the end of the doc, the editor now scrolls automatically so the
  line you're on stays clear of them — no more typing blind or
  scrolling by hand to see your own text. (The pills stay where they
  are.)

- **A collaborator's cursor could crash everyone else's cursor
  overlay.** If a presence update pointed at a spot this machine
  hadn't received yet (or had deleted), redrawing collaborator cursors
  failed for *everyone*, and kept failing on every update for the next
  while. Now only the one unresolvable cursor is skipped — it heals on
  its owner's next keystroke — and everyone else's cursors keep
  rendering.

## 0.1.0-beta.28 — 2026-08-05

### Added

- **Reformat every cite in a document with AI.** The AI cite formatter
  (Mod-Shift-X) now has a whole-document version: **Reformat Every Cite
  in Document (AI)**, found in Search Everything (try "reformat all
  cites") and rebindable under Settings → Keyboard. It rewrites every
  cite in the open document through the same formatter, one at a time.
  Because that's one AI request per cite, it asks first and tells you
  exactly how many requests it will make — and never makes more than
  that, so cites pasted in while it runs are left for a second pass. You
  can keep working elsewhere in the document while it runs, each cite is
  its own undo step, **Esc** stops the pass, and a summary at the end
  reports what was reformatted and what needs a look. If several cites
  fail in a row — a dead key, an exhausted quota — it stops rather than
  working through the rest of the document to fail on each one. Thanks to
  Shreeram Modi for building it.

- **Resolve a comment with one click.** Comment threads grew a round
  check in their header: click it and the thread is marked handled —
  the card dims, collapsed or expanded, and the state is Word's own
  *resolve*, so it round-trips both ways with `.docx`. Click again to
  reopen. Next to the reply box there's also a one-click **👍** reply
  for a no-typing "seen it" — an ordinary reply under the hood, so it
  travels everywhere replies do.

- **The nav pane's right-click menu understands multi-selections.**
  Right-click any entry that's part of a Mod-click / Shift-click
  selection and **Select / Cut / Copy / Delete** act on *every*
  selected heading. Cut and Copy stitch a scattered selection together
  in document order — it pastes as if you'd dragged the sections next
  to each other first — a multi-Delete or multi-Cut is one undo step,
  and Select gives you a real discontinuous selection (the same one
  Select Similar uses), ready for any formatting command.

- **Create live views and linked copies straight from the nav pane.**
  Right-click a heading → **Create live view of heading** or **Create
  linked copy of heading**: the section you clicked is the source, and
  the view or copy lands at your cursor — no picker. (The command bar
  also now finds Insert Live View under "create live view".)

- **Reopening a session file offers to rejoin.** If you save your copy
  of a co-edited document and later open that file from disk while the
  session still exists, CardMirror asks: **Rejoin** reconnects the
  session into the document you just opened, in place; **Leave**
  forgets the session and keeps the file as an independent copy. No
  silent third path — editing the file outside a live session would
  split it into two diverging copies with the same name.

### Changed

- **Highlighting under simultaneous edits follows the typist's view.**
  Highlight, underline, emphasis, and background color no longer
  "spread" onto text someone typed while never having seen the mark —
  the convergence quirk where a concurrently retyped paragraph came
  back fully highlighted for everyone. Typing inside a highlight you
  can see still continues it, and deliberately marking text you can
  see still sticks; only the nobody-meant-this case is stripped, and
  it converges identically for every participant.

- **Co-editing feels faster with several people typing.** A bundle of
  performance work on the sync path: incoming edits and cursor updates
  now batch into short windows instead of each forcing its own full
  editor update (with five people typing, roughly a quarter of the
  update churn), and the per-edit repair pass does a fraction of its
  former scanning. Remote edits and cursors appear a fraction of a
  second later than before; local typing is untouched.

- **The "synced offline edits" notice earned its interruptions.** It
  now appears only after a genuine offline stretch (a minute or more)
  whose catch-up actually changed the document — not on the routine
  reconnects and periodic re-checks that fire constantly in a healthy
  session. The message says what happened ("Caught up on edits made
  while you were offline") instead of quoting a frame count.

- **Untitled session documents pick up their name.** Start a session
  on a never-saved document and joiners used to see a nameless window
  forever. Now, when the host saves the document, its new name reaches
  every participant's window and Sessions list live — and a partner's
  rename never overwrites a name you chose by saving your own copy.

- **Painting "no color" on macOS moved to ⌃ Control.** Recent macOS
  moves the window when you drag with ⌥ Option held, which broke the
  hold-to-strip paintbrush stroke; ⌘ is spoken for, so the strip
  override is now **⌃**. Windows and Linux keep **Alt**.

### Fixed

- **Highlighting over a different color repaints instead of erasing.**
  Painting green over yellow used to strip the highlight entirely (the
  toggle only asked *whether* text was highlighted, never in what
  color). Now a different color repaints in one stroke; repeating the
  exact color still toggles off. Background color got the same fix.

- **Select-F11-F11 quick-unhighlight works with auto-bridged gaps.**
  When a selection grabbed a trailing space, the gap normalizer would
  strip the space's highlight after the first tap, and the second tap
  then saw "not fully highlighted" and repainted forever. The toggles
  (highlight, background, underline) now judge the selection without
  its edge whitespace, so the double-tap always lands.

- **Typing a comment during a live session no longer loses focus.**
  Every incoming co-editor keystroke re-rendered the comments column
  in a way that silently moved the focused reply box's DOM node,
  blurring it mid-word. The column now leaves settled cards alone, so
  you can type feedback while others edit.

- **The "source updated" rail reaches the multi-doc workspace.** The
  red rail marking a linked copy whose source moved on could fail to
  appear in pane outlines if read mode had ever been used in
  single-doc mode — the divergence check consulted a stale global
  flag. It now asks each pane for its own state.

## 0.1.0-beta.27 — 2026-07-30

### Added

- **File search exclusions.** Settings → Files → **File search:
  exclusions** takes folders and files the palette's file search must
  never show, no matter which search folder they live under (an
  excluded folder hides everything beneath it). Every file result also
  grows a **⊘** button beside the pin star — click it, confirm, and
  the file drops out of results on the spot. Excluding a pinned file
  leaves the pin dormant rather than deleting it.

- **A second reading speed per reader.** Most people read tags,
  analytics, and cites at a different clip than highlighted card
  bodies. Each reader in Settings → General can now carry an optional
  second words-per-minute rate for that structural read; leave it
  blank and the main rate covers everything, exactly as before. Every
  read-time surface uses the split — the status bar, the per-pane
  footers, the enclosing-container readout, and the Word Count dialog
  (which shows both rates, e.g. "200 / 260").

- **Right-click a within-file search hit to see it in context.** When
  searching inside a dived-into file, right-clicking a result clears
  the query and reveals that hit in the file's outline — ancestors
  expanded, the row selected and pinned to the top of the list.

- **`cardmirror-read`: a tiny companion tool for reading files without
  the app.** A single-file command-line utility (in
  `packaging/cardmirror-read/`, one `curl` to get) that turns a
  `.cmir` or `.docx` into a temporary, read-only copy in either
  markdown-flavored plain text (structure, cites, and the
  highlight/underline layers kept legible) or the full-fidelity
  uncompressed JSON. Built for AI assistants and screen-reader
  pipelines that can't open the app's formats; it reuses CardMirror's
  real parsers, so it reads exactly what the editor reads. The
  original file is never modified. Two automation modes for AI
  assistants: an **MCP server** (`--mcp --root <folder>`) exposing
  list/read tools scoped strictly to the folders you configure, and a
  **mirror** (`--mirror <folder> --out-dir <folder>`) that keeps an
  always-current plain-text shadow of chosen folders for assistants
  that can only read files (e.g. through a Dropbox integration).

### Changed

- **File search moved out of the app's critical path.** The file index
  and the search itself now run in a dedicated background process, and
  the parsing that keeps pinned files warm runs off the interface
  thread. The visible effect: opening a window and immediately moving
  or resizing it no longer freezes on a stretched stale frame while
  the index warms up, and typing in the palette stays fluid while the
  index refreshes behind it. Search results, ranking, pins, and
  exclusions behave identically.

- **The live-view / linked-copy picker matches like the search
  palette.** The section picker's filter box now uses the same
  order-independent, multi-word matching as everything else — partial
  and out-of-order words land, and a card's tag row also matches on
  its cite. Rows keep their outline order.

### Fixed

- **The Recent list missed files and went stale.** Files opened in the
  three-pane workspace were never recorded on the home screen's Recent
  list, and a home screen left visible didn't refresh when another
  window opened or saved a file — both fixed. While in there: the list
  now holds ten entries instead of six, and long paths trim from the
  left so the file and folder names stay readable (the full path is in
  the tooltip); Settings' folder-path fields trim the same way.

- **Linked copies of a single card from Word files.** Transcluding a
  card by its tag from a `.docx` source failed with "This Word heading
  can't be tracked" even though the same pick worked from `.cmir`
  sources. The Word bookmark step now resolves the card's tag the same
  way the rest of transclusion does, so card-by-tag linked copies work
  from Word files too.

- **The palette's keyboard no longer dies after clicking in the
  results.** Clicking anywhere in the results list — most noticeably
  right-clicking to expand or collapse an outline heading — could move
  keyboard focus into the list itself, after which the arrow keys
  scrolled instead of moving the selection and Enter went nowhere
  until you clicked back into the search box. The search box now keeps
  the keyboard through any click in the list.

- **Removed search folders no longer haunt the file index.** Folders
  taken out of the file-search settings stayed in the on-disk index
  cache forever, growing it without bound. The index now forgets
  roots the moment they leave settings.

## 0.1.0-beta.26 — 2026-07-28

### Changed

- **Automatic update checks are now on by default (desktop).**
  CardMirror silently checks GitHub for a newer release at launch and
  once a day, and only speaks up when an update is actually ready —
  nothing installs without your click. This was previously opt-in, and
  existing installs are switched over once, with a notice the first
  time. To opt out, turn off **Check for updates automatically** in
  Settings → General → About this install; heading to a tournament,
  use **Pause update checks for 1 week** right next to it. The privacy
  policy's update-check section reflects the new default.

### Fixed

- **Web: the GitHub button shows its icon again.** Since beta.22 the
  web edition's GitHub button rendered as a solid square instead of
  the GitHub mark. (Web only — the desktop app doesn't have this
  button.)

- **Three-pane: you can now drag into an empty pane's navigation
  section.** Dragging a card or heading onto the nav section of an
  empty document showed only "No headings." with nowhere to drop —
  the end-of-document drop slot was hidden along with the empty
  outline. The whole section now accepts the drop, landing the
  content in the empty document.

- **Formatting shortcuts typed into text boxes stay in the text box.**
  Pressing a formatting shortcut (bold, highlight, …) while typing in
  a small text field — the font-size box, a search filter — used to
  apply it to the document behind the field. Document-level shortcuts
  (new / open / save as) still work from anywhere.

- **The Word Count and Keyboard Shortcuts windows now hold the
  keyboard.** Typing while either was open fell through into the
  document behind them. Keys are now contained, Escape closes, and
  focus returns to the editor afterwards.

- **Read mode now works identically in both layouts.** The single-pane
  editor was made non-editable at the browser level in read mode — an
  older mechanism that could make the cursor unplaceable and the
  Space/Enter reading markers unreliable there. It now uses the same
  edit-blocking as three-pane panes: everything is still locked
  against changes, but the cursor and reading markers behave the same
  everywhere.

- **Clicking below the last line no longer breaks the editor.** THE
  root cause of the long-standing "typing and styling stop working
  until I click a text line" reports, in both layouts: a click below
  the document's content resolved to a position outside any text
  line, and the word-selection machinery installed a broken selection
  there — every command that acts on the selection then silently did
  nothing until a real text click replaced it. A below-content click
  now places the caret at the end of the last line, like every other
  editor.

- **Keyboard focus reliably lands in newly opened documents.** A
  family of intermittent "the editor ignores typing and styling until
  I click a text line" bugs, traced by a focus audit: several
  open/create paths never gave the new document keyboard focus —
  creating or opening from the Home screen, opening into a three-pane
  slot, crash recovery, every mode-switch reload, spawned windows
  with content, and joining a co-editing session — and the three-pane
  slot picker could lose a race with the system's own focus
  restoration. Every one of those paths now focuses the document
  explicitly, the slot picker holds focus properly while open, and
  the Save As and confirmation dialogs got the same keyboard
  hardening as the rest of the dialogs (Save As also returns focus to
  the editor when closed instead of leaving it stranded).

- **Three-pane: a pane can no longer show as focused when it isn't.**
  Closing a focused pane's last document left its "focused" highlight
  latched on the now-empty pane, invisibly — the next document to
  land in that slot then appeared focused alongside the actually
  focused pane (most visibly: expand a pane, create a document
  behind it, un-expand — both panes look focused). The highlight is
  now recomputed across all panes on every focus change.

- **Three-pane: an expanded pane now always keeps the keyboard.**
  Creating a new document routed to a slot hidden behind an expanded
  pane used to silently move command routing to the invisible doc
  while your keystrokes stayed with the visible one — typing and
  styling appeared dead until you clicked into a document. Focus now
  follows visibility: a hidden pane can receive documents but never
  takes focus; it gets its turn when it's shown.

- **Interface glyphs can no longer garble.** In rare cases (a reload
  race in certain window states) the speech-doc microphone on a pane
  chip and the numbering arrows could render as garbled characters
  (e.g. "ðŸŽ¤") until a reload. Every symbol the interface draws via
  CSS is now spelled in a form immune to that failure, including the
  entire classic icon set.

- **Sending a card no longer leaves empty tag headers behind.** If the
  speech document's cursor sat on a blank line *inside* a card, a
  tilde send (or a palette insert) split that card to make room —
  leaving two empty tag headers after the sent card, which also picked
  up the surrounding card's numbering. The sent card now lands as a
  clean neighbor instead; blank lines inside cards are left alone. The
  tidy behavior on a *placeholder* blank line — the one a previous
  send leaves — is unchanged: consecutive sends still stack without
  accumulating blank lines.

## 0.1.0-beta.25 — 2026-07-27

### Added

- **Damaged files can open as a repaired copy.** When a `.cmir` is so
  damaged that even the automatic repairs can't fix it, CardMirror now
  offers to open a repaired copy with the damaged elements removed —
  and tells you exactly what would be removed, quoting each element's
  text (or noting when no visible text is lost). The original file is
  never touched: the repaired copy opens unsaved, and saving it asks
  where to save. Previously the only options were a backup or asking
  for help.

### Fixed

- **Documents are now checked and repaired at every save.** Until now,
  if a bug ever corrupted a document's structure in memory, the broken
  state reached the crash journal within seconds and the file at the
  next autosave — which is how the "file is damaged" reports happened.
  Every save now validates the document first; known damage is
  repaired on the spot and the repaired version is what gets written,
  with a notice asking you to report it (that report is how we catch
  the underlying bug). A save is never refused.

- **Silent failures now speak up.** A handful of internal error paths
  that used to fail into the developer console — a condense step
  failing after a paste, an AI edit that couldn't be applied — now
  surface a visible notice, so problems get reported instead of
  quietly shrugged off.

- **Stored cards are validated before insertion.** Quick cards, the
  dropzone shelf, cards received from a paired machine, and
  send-to-speech now verify their stored content is structurally sound
  before inserting it — so one corrupted saved card can no longer
  quietly re-corrupt every document it's pasted into (or spread from
  another machine). Corrupt items are refused with a message instead,
  and the quick-cards bulk import skips structurally invalid records
  and tells you how many.

- **Co-editing no longer silently deletes a card caught in a merge
  conflict.** When two people's offline edits merged such that a card
  lost its heading (one deleted the body while the other's edit
  removed the tag), CardMirror used to drop the entire card — including
  the content that survived — on every screen, with no warning. Now the
  card is restored with an empty heading, everyone sees the same
  repaired result, a notice explains that a merge conflict was
  repaired, and the fix is written back to the shared session so the
  card stays whole for anyone who joins later. A card whose contents
  were *entirely* deleted by both sides still reads as deleted — there
  is nothing left to restore.

- **More "This CardMirror file is damaged" repairs.** beta.23 repaired
  files carrying an invisible, empty analytic shell; the same problem
  has now shown up with an empty **card** shell, and the same repair
  applies — the empty shell is removed on open (losslessly — there was
  nothing inside) and the file loads. An audit of every remaining
  structure found two more shapes that could refuse a file the same
  way — a hollow **table** and a hollow **table cell** — and both now
  repair on open too (the table is dropped; the cell is refilled with
  an empty line so the table's columns stay aligned).

- **Typing in the search bar is much faster with a large file
  library.** With thousands of files under the search folders, the
  first few characters typed into the everything-search bar could
  visibly freeze. Four fixes: the file list now loads the moment the
  bar opens instead of on the first keystroke; background preparation
  of pinned files for search-inside now waits until you actually stop
  typing (it used to be forced into the middle of a typing burst —
  the biggest freeze); each keystroke now does far less per-file
  matching work; and results render 50 at a time instead of 100, with
  "show more" unchanged.

- **Pressing Enter to confirm a dialog no longer also types into the
  document.** Confirming certain dialogs with the keyboard — most
  visibly Enter on the three-pane mode-switch confirmation — also sent
  that keystroke to the editor, leaving a stray newline at the cursor.
  Dialogs now claim the keyboard completely while open: the keys they
  use work, everything else is ignored, and nothing reaches the
  document behind them. Dialogs also take keyboard focus while open
  (and hand it back on close), and Enter now confirms the default
  choice in Save/Don't Save-style dialogs, matching their hints. The
  Settings dialog and the Select Speech Document picker had the same
  gap — opened from the keyboard, typing could land in the document
  behind them — and got the same treatment. And Escape-closable
  panels (the footnote popover, the Doc menu, the crash-recovery
  sidebar) no longer close on an Escape that was meant for a dialog
  stacked above them, and one Escape press now closes exactly one
  thing.

## 0.1.0-beta.24 — 2026-07-26

### Added

- **Cut from the navigation pane.** Right-clicking a heading in the
  nav pane now offers **Cut heading and contents** alongside Select,
  Copy, and Delete — copy the heading and everything under it to the
  clipboard and remove it in one step, ready to paste elsewhere.
  Ctrl-Z restores it. The removal only happens after the copy has
  safely landed on the clipboard, so a busy clipboard can never cost
  you content.

- **Live read time for the card you're in.** The status-bar word
  count gains a second readout showing the smallest thing enclosing
  your cursor — the card, the analytic, or the block section:
  "Doc: 1,234 · Amy: 8:12 | Card: 42 · Amy: 0:31". Select text and it
  shows the selection's time instead. In the three-pane workspace each
  pane's footer tracks its own cursor. Controlled by a new toggle in
  **Settings → General → Word counts** (on by default; turning it off
  restores the exact previous readout).

- **Hold Alt/Option to erase while painting.** With a colored
  highlight, background, or font-color paintbrush armed, holding
  **Alt** (**Option** on macOS) temporarily turns it into the
  "no color" pen — the cursor's swatch flips to the red-slash glyph,
  and each drag strips the mark instead of painting. Release the key
  and your color is back. Your saved pen color is never changed.

### Fixed

- **Dialog keys no longer fall through to the home screen.** Pressing
  a number key (or Esc) in a dialog shown over the home screen — the
  three-pane "Open into…" pane picker, the save-before-closing
  prompt, and others — also triggered the home-screen action on the
  same key, so picking pane 1 could simultaneously create a new
  document underneath. Dialogs now block the keys beneath them, and
  when two dialogs stack, Esc closes one at a time instead of both.

- **Paint mode's cursor now follows you between panes.** In the
  three-pane workspace the brush itself always applied to the pane
  you clicked into, but the paint cursor stayed drawn on the pane you
  left — and could get stuck there permanently if you left paint mode
  from a different pane. The visuals now move with your focus.

## 0.1.0-beta.23 — 2026-07-25

### Added

- **Permissions for external apps.** Local companion apps (like ebb)
  insert text into CardMirror over a local connection — and until now,
  anything on your machine could do that silently, even after
  uninstalling the related plugin. Now the first time an app sends,
  CardMirror asks — Always Allow / Allow Once / Deny — names the exact
  app, and remembers your answer. A new External apps section at the
  bottom of Settings → Plugins lists every app that has asked, lets
  you flip or forget decisions, and holds the overall policy: ask for
  each app (default), allow all (for older apps that don't identify
  themselves), or block everything. Apps must identify themselves to
  send; older versions that predate this get a clear "update the app
  you were sending from" message instead of a mystery failure.

- **Companion apps can target a specific document.** Senders can now
  list your open documents and aim an insert at one of them — the
  right pane of a three-pane window, a background window — without
  CardMirror taking focus, and can tell which doc is your speech doc.
  Sends can also carry a style now: tags, analytics, pockets, hats,
  and blocks arrive as real structure with proper outline placement
  instead of only body text. Thanks to Shreeram Modi for the styled
  sends. Sending to whatever is focused still works exactly as
  before.

### Fixed

- **"This CardMirror file is damaged" on files that opened fine in
  older versions.** Some older builds could leave an invisible, empty
  structural shell in a document; the file-safety check added in
  beta.21 then refused the whole file. Those shells are now repaired
  on open — losslessly, since they were empty — and the file loads.

- **Backspace and Delete at clicks in blank space.** Clicking in the
  empty spacing between paragraphs could park the cursor in a spot
  that looked like the start of the next line but wasn't — Backspace
  would then eat the last character of the paragraph above (or do
  nothing but move the cursor) instead of removing the line break.
  Both keys now remove the break, first press, like you expected.

- **Shrink no longer shrinks AI-created cites.** The AI cite creator
  could fail to style the author and date (making the cite an
  ordinary paragraph that shrink treats as body text). The styling
  is far more robust now, and if the author/date genuinely can't be
  located, CardMirror says so at creation instead of leaving a
  silently unprotected cite.

- Tightened the spacing above the Verbatim Flow section on the
  Plugins tab.

## 0.1.0-beta.22 — 2026-07-24

### Added

- **Plugins can offer their own settings.** When an enabled plugin
  declares settings, a gear appears on its row in Settings → Plugins;
  clicking it opens a dialog with the plugin's options (switches, text
  and number fields, dropdowns). Changes apply immediately, and a
  plugin's stored settings are removed when it's uninstalled.
  Experimental, like the rest of the plugin system.

- **Custom ribbon buttons, upgraded.** The limit rises from 6 to 10
  buttons (the section grows up to five columns of two), the icon
  picker more than doubles to 54 icons, and each row in the editor has
  up/down arrows to reorder — row order is ribbon order. Plugin
  commands can now be bound to custom buttons too; uninstalling a
  plugin unconfigures any buttons bound to its commands.

### Changed

- **"Keep a Verbatim Flow connection warm" moved** *(Windows)*. It now
  sits at the bottom of Settings → Plugins instead of General →
  Integrations — it's an integration in spirit, but it doesn't require
  the Enable plugins switch.

## 0.1.0-beta.21 — 2026-07-24

### Added

- **An experimental plugin system.** The new Settings → Plugins tab
  holds the master switch (Enable plugins; takes effect on the next
  launch) and the install list. Plugins extend CardMirror with new
  commands — searchable in the palette and rebindable like built-ins —
  and can talk to companion apps such as the
  [ebb](https://github.com/shreerammodi/ebb) flowing app over a local
  bridge. Because plugins run with full access to the editor and
  your documents, installs are limited to a curated list, and every
  install asks for consent naming the exact GitHub repository it comes
  from. Developers: the API and bridge protocol are documented in the
  repository. Thanks to Shreeram Modi for building the plugin API and
  the cardmirror-bridge.

- **Minimize is a keyboard command on every platform.** Cmd+M on
  macOS — where the standard Window menu (Minimize, Bring All to
  Front) is also back — and Ctrl+M on Windows and Linux. It's a real
  command: rebindable in Keyboard shortcuts, searchable in the
  palette, and on macOS the menu shortcut follows your binding.

### Changed

- **Collaboration uses far less data.** Sessions now verify their
  sync-safety bookkeeping locally instead of re-downloading the whole
  session history every half hour, cursor updates are lighter and no
  longer echo back to their sender, unchanged session snapshots are
  not re-sent, and responses are compressed. Nothing about how
  sessions look or behave changes — they just stop consuming
  gigabytes of bandwidth on busy days.

- **Damaged files are refused cleanly.** A corrupted or hand-crafted
  `.cmir` whose internal structure is invalid now fails to open with
  a clear "file is damaged" message instead of loading broken state
  that misbehaved later.

- **Self-hosting additions.** A self-hosted relay now serves the same
  data-saving endpoints as the official one, and its operator can
  curate which plugin repositories their users' installers accept
  (`RELAY_PLUGIN_ALLOWLIST` — see `relay/README.md`).

## 0.1.0-beta.20 — 2026-07-24

### Fixed

- **Drops next to live views land reliably.** Dragging content from
  above a live view to a spot at or past it sometimes did nothing —
  the drop indicator appeared, but releasing silently discarded the
  move. The drop now lands every time.

- **Undo works after moving a live view.** Moving a live view a short
  distance could break undo entirely: pressing it did nothing, over
  and over, until some other edit was made. Moves of live views now
  undo like any other drag.

- **Multi-selection drags from inside a linked copy are safe.**
  Dragging a navigation-pane multi-selection that included more than
  one heading from the same linked copy could delete content that
  followed the copy. The copy now moves once, intact. Mixed
  selections (a linked copy together with regular headings) also
  offer the same drop slots no matter the order they were selected
  in.

## 0.1.0-beta.19 — 2026-07-24

### Changed

- **Enter continues below a live view.** With the cursor at the very
  bottom of a live view, Enter used to do nothing — the mirrored
  content is read-only, so there was nowhere for a new line to go. It
  now starts a new line just below the live view and moves the cursor
  there.

### Fixed

- **Live views show their card numbers in the navigation pane.** With
  numbering on, numbered cards inside a live view showed their numbers
  in the editor but not in the outline (linked copies were fine). A
  live view's outline rows now carry the same numbers the editor
  shows.

- **Sections dragged between panes respect the outline depth.** A
  heading dragged from one pane to another landed fully expanded in
  the destination's navigation pane, ignoring its default expansion
  level. Dropped sections now collapse to the destination pane's
  depth; sections you had expanded yourself stay as they were.

- **Find closes when you switch panes.** Leaving find (or
  find/replace) open in one pane and clicking into another could
  leave the first pane's search highlights stuck — closing the bar
  from the new pane cleared the wrong one. Switching focus to a
  different pane or document now closes the find bar and clears its
  highlights and navigation-pane markers.

## 0.1.0-beta.18 — 2026-07-23

### Added

- **The home screen comes to the three-pane workspace.** An empty
  workspace — a fresh three-pane launch, or closing the last open
  document — used to leave a bare window. It now lands on the home
  screen, just like single-pane; opening or creating any document
  dismisses it.

- **Collaboration invites are joinable from the home screen.** The
  Receive pill now appears on the home screen (bottom center), so you
  can see and accept session invitations without opening an unrelated
  document first — joining opens its own document anyway. Received
  *cards* still need an open document: while the home screen is up,
  inserting shows a note instead (the card stays in the pill), since
  the destination document is hidden behind the home screen.

### Changed

- **Word exports are modern documents now.** Exported `.docx` files
  used to open in Word's Compatibility Mode — the title-bar banner,
  classic-only comment rendering, and a File → Convert prompt whose
  re-save reflowed the document. Exports now declare the modern format,
  so the banner is gone and Word's margin comment cards work.

- **File previews show your font.** Slack, Gmail, and similar preview
  thumbnails rendered exports in a generic serif no matter what your
  display font was. Exports now carry your display font as the
  document's base font, so previews approximate what you see in
  CardMirror. Verbatim users still see their own configured fonts
  exactly as before (per-machine style definitions always win); plain
  Word without Verbatim now shows the author's font for
  otherwise-unstyled text instead of Word's own default.

- **Appearance settings, tidied.** Theme (light / dark / follow
  system) is now the first thing in the Appearance tab, "Turn text
  after a mark red" lives with the other Document typography settings,
  and two sections ("Theme & chrome", "Nav pane & indicators") no
  longer appear twice with stray rows.

### Fixed

- **Saving into a Dropbox folder no longer fails over and over.** On
  Windows, the "temporarily locked by another program" error could
  appear on nearly every save — Dropbox holds the just-saved file for
  upload longer than the save's retry window, so the safe-save rename
  kept losing. When the rename stays blocked, saving now falls back to
  writing the file in place (the same thing pre-beta.16 saves did), so
  the save lands instead of failing. The error now only appears when
  even that is impossible.

- **Documents with comments no longer trigger Word's repair prompt.**
  Any file saved with a comment showed "unreadable content" when opened
  in Word, with recovery bringing the comments back — a wrong
  content-type declaration for one of the comment parts made Word
  reject the whole package. Files saved from this version open clean.

- **Fake line breaks from PDF pastes can now be cleaned.** Text copied
  out of some PDFs arrives with exotic non-breaking spaces between
  words, so pasted cards wrap mid-word at "line breaks" that backspace
  can't remove. F2 plain paste now folds these to normal spaces on the
  way in, and **Condense** or **Repair OCR/PDF text** cleans documents
  that already have them.

- **New documents are ready to type in.** Creating a document — in
  either mode — now places the cursor in it and focuses the editor, so
  typing (or arming a style) works immediately without clicking into
  the page first.

- **Three-pane New matches single-pane.** A new three-pane document
  used to open with an "Untitled" pocket heading nobody asked for; it's
  now the same bare paragraph single-pane creates. (This also fixes
  new *speech* documents ignoring the "Seed new speech docs with a
  Pocket heading" toggle when it's off.)

- **Zooming quickly no longer jumps the page.** Rapid zooming — holding
  the shortcut, spinning the wheel, or fast +/− clicks — could make the
  viewport lurch as competing scroll corrections fought each other. A
  whole zoom burst now holds one anchor and the latest correction wins,
  so the text under your eyes stays put.

## 0.1.0-beta.17 — 2026-07-22

### Added

- **Name new speech documents your way.** New Speech Document used to
  name every file "Speech 1NC 4-12 7-05PM" style, with only the speech
  name under your control. The whole pattern is now a setting (Settings
  → Files → New documents): literal text plus `{speech}` (the name you
  type at the prompt) and `{date:...}` (date/time written with familiar
  tokens — `{date:YYYY-MM-DD}` gives 2026-04-12), with a live preview
  as you type. The default matches the old naming exactly, so nothing
  changes unless you want it to. (PR #20, thanks to
  [Shreeram Modi](https://github.com/shreerammodi).)

- **A Browse… button on each file search folder.** If a search folder
  gets renamed or moved, you can now repoint that row in place —
  same picker as the other folder settings — instead of removing the
  folder and adding it back. (PR #19, thanks to
  [Shreeram Modi](https://github.com/shreerammodi).)

- **Password-protected Word files open now.** Opening a `.docx` that
  Word encrypted with a password used to fail with a cryptic error.
  CardMirror now asks for the password and opens the file (a wrong
  password just asks again). Saving writes a normal, unencrypted file —
  CardMirror doesn't re-apply the password.

- **A fourth timer preset** (off by default; Settings → General →
  Timer). For events whose speeches come in four distinct lengths.
  Preset 4 takes the Start/Pause cell so the presets form a 2×2 block,
  Start/Pause becomes a full-height button beside the display, and a
  fourth duration field appears in the profile durations row. Expanded
  timer layout only.

- **Choose your underline thickness** (Settings → Appearance →
  Typography). Same family as the emphasis and pocket box thickness
  controls; blank keeps the font's automatic weight. Applies to
  underlines, emphasis, and underlined cites.

- **An option to unbold your cites** (Settings → Appearance →
  Accessibility). An option to render cite-marked text at normal
  weight, for readers who find dense bold runs visually crowding.
  Display-only — exports and collaborators still see the standard
  bold cite.

### Changed

- **The timer stays red after time runs out.** When the countdown hits
  zero the display turns solid red — the same red as the low-time
  warnings — and stays that way until you re-arm the clock (load a
  preset, hit Reset, or type a new time). Pausing or switching clocks
  doesn't dismiss it, so a glance always tells you that time expired.
  The sound, if on, is still a single double beep.

- **Every AI-backed command now says (AI).** Commands that send text to
  the AI provider are labeled uniformly — Format cite from selection,
  Repair OCR/PDF text, Translate, and friends — so it's always clear
  before you run a command whether it uses AI.

- **Privacy policy updated for the optional account link.** The policy
  still said "no accounts" outright; it now accurately describes the
  optional Debate Decoded membership link that shipped in beta.13 —
  what the relay stores when you link (a routing-code-to-membership
  association, never your email or name), that it's required for
  nothing during the beta, and how to unlink or have the server-side
  record deleted.

### Fixed

- **A leftover recovery draft can no longer silently overwrite newer
  work.** Whenever a recovered draft is older than the file it would
  save over, CardMirror stops and asks — keep the newer file, save
  the draft elsewhere (keeping both), or explicitly replace the file —
  with the safe choice as the default. Autosave also leaves a
  recovered draft alone until you've saved it once by hand. Recovering
  normally (your unsaved edits are newer than the file) works the same
  as before.

- **Backspace can no longer swallow a whole card.** At certain card
  boundaries — most easily at the very end of the document — Backspace
  could select an entire card body, so the next keystroke deleted it
  completely. Backspace and Delete now work normally in that situation
  instead.

- **Highlighting across an emphasis box no longer leaves a white gap**
  in the three-pane workspace. The single-document editor was already
  right; the workspace's copy of the style hadn't kept up.

- **Shift-F3 case cycling keeps your selection.** Cycling a selection's
  case used to drop the selection when it started or ended mid-word,
  so you couldn't cycle again or apply another mark without
  re-selecting.

- **Boxes no longer cut through images.** Applying emphasis (or any
  boxed style) across an inline image drew a text-height box straight
  through the picture. Images no longer show formatting marks.

- **Each document remembers its own scroll position in the three-pane
  workspace.** Switching between the documents stacked in a pane now
  returns each one to where you left it, and a freshly opened document
  starts at the top instead of inheriting the previous one's scroll.

## 0.1.0-beta.16 — 2026-07-17

### Added

- **Pop the timer out into a floating window** (desktop). A new ⇱
  button on the timer panel moves the timer into a small
  always-on-top window that stays visible over other apps — handy
  for keeping speech and prep time in view while reading a speech
  doc or anything else. While popped out, the timer leaves the
  CardMirror window entirely; closing the float (or hiding the
  timer anywhere) brings it back. The float controls the same
  shared clocks as ever — start, pause, edit, and prep all sync
  instantly with every window. The timer always starts a fresh
  launch inside the app; pop it back out whenever you need it.

- **Audible timer alerts** (Settings → Appearance → Timer display;
  off by default). An accessibility option that plays a short beep
  when the running clock crosses each low-countdown point — the same
  thresholds as the visual flash — and a distinct double beep when
  time runs out. Exactly one sound plays no matter how many windows
  are open, the popped-out timer included, and the beeps stay on
  time even when CardMirror is buried behind other apps. Volume is
  adjustable — and the alert points themselves are now genuinely
  configurable (a new "Alert points" field, e.g. "60, 30, 5, 3, 1"),
  shared by the flash and the beeps. The flash setting had always
  claimed its thresholds were configurable; now it's true.

### Changed

- **A tighter compact timer.** The compact layout now shows one prep
  clock instead of two, with a ⇄ button to switch between the
  affirmative and negative balances (the shown side follows whichever
  prep you select anywhere), and the reset and pop-out buttons stack
  on the left just like the expanded layout. Net effect: compact
  stays as narrow as it was before the pop-out button existed.

### Fixed

- **Copying to the clipboard no longer randomly needs several
  clicks.** Clipboard writes could fail transiently — Windows briefly
  locks the clipboard for whichever app copied last (Word, most of
  all), and the browser engine refuses writes at unlucky focus
  moments — and several copy features swallowed the failure silently,
  so the button just seemed dead until a lucky click (reported
  against Create Reference as "requires me to click the button like
  5 times"). Every copy path — Create Reference, the outline's
  copy-heading command, Copy Current Heading, translation, and link
  copying — now writes through a native clipboard path on desktop
  that doesn't have these problems, retries the rare transient
  failure automatically, and says so if something still goes wrong
  instead of doing nothing. Create Reference with the cursor outside
  a card also gets a clear message instead of silence.

- **Drag-to-reorder in the outline no longer goes dead after
  rearranging panes.** In the three-pane workspace, rearranging panes
  could leave one document's outline unable to offer any drop
  position: picking up a heading worked, but the insertion line never
  appeared and releasing snapped it back, until the document was
  closed and reopened. Reordering now works regardless of how panes
  have been shuffled.

## 0.1.0-beta.15 — 2026-07-17

### Added

- **A smoother update experience on every platform.** Updates now
  download silently in the background and never interrupt you with
  dialogs — when one is ready, a small chip appears in the status bar
  and nothing installs until you click it (on Windows and Linux,
  quitting the app normally still applies a downloaded update). macOS
  gets automatic updates for the first time: click the chip and
  CardMirror restarts straight into the new version. Mac downloads are
  also now a single universal app — one .dmg that runs natively on
  both Apple Silicon and Intel, so there's no wrong version to
  accidentally install — and updates no longer reset the microphone
  permission for voice control. And for tournaments: a **Pause update
  checks for 1 week** button (Settings → General → About this install)
  stops all automatic checks and downloads until the shown resume
  date, with a resume-now button while paused.

- **Smart paste from Word and haku.cards** (Settings → Editing →
  Paste; on by default). Pasting cards copied from Microsoft Word —
  including Verbatim files — or from haku.cards now recreates real
  CardMirror structure: tags, cites, headings, underlining,
  highlighting, and card numbering, instead of unformatted text.
  Emphasis (boxed) text survives the paste in every spelling Word
  uses for it — the normal Emphasis style (which Word copies as a
  bare "em" tag), renames like "Emphasis1", "Text Bold", and "Char
  Char" duplicates, and even fully random names, which are recognized
  by their box border. One honest caveat: smart paste is a best-effort
  convenience, not built to chase every edge case — for full fidelity,
  open the .docx in CardMirror and copy from there instead.
  haku pastes additionally translate haku's formatting back into
  CardMirror semantics: bold-underlined text becomes Emphasis (old
  files where every underline is bold are recognized and kept as plain
  underline), haku's font-size noise is cleaned up — real shrinking
  (under 10 pt) and deliberately enlarged phrases keep their sizes,
  everything else pastes at your normal text size — and Fix Formatting
  Gaps runs automatically on the converted card, so underlining that
  haku split at punctuation arrives already bridged. Pasted content
  with no recognizable structure pastes exactly as before, and Paste
  Text (F2) still pastes plain.

- **Maximum text width** (Settings → Accessibility → Text width). Cap
  how wide the document text column gets — long lines stop stretching
  edge to edge, so reading doesn't require sweeping your eyes across
  the whole screen. Off by default; when on, choose whether the column
  sits centered or pinned to the left or right edge.

- **Text alignment per style** (Settings → Accessibility → Text
  alignment). Center or fully justify text for tags, plain paragraphs,
  card bodies, analytic bodies, analytics, undertags, and cite
  paragraphs — each style independently. Pockets, hats, and blocks are unaffected, and any
  paragraph you've aligned yourself keeps its own alignment.

- **Hat underline style** (Settings → Appearance → Document typography):
  choose between the classic double underline (default) and a single
  underline for hat headings. Display-only — exports are unchanged.

- **Pocket box controls** (Settings → Appearance → Document
  typography, under Style typography): turn the box around pocket
  headings off entirely ("Pocket: boxed", on by default) or adjust its
  thickness, mirroring the existing emphasis box controls.
  Display-only — exports are unchanged.

- **Reset style font sizes**: the per-style font size editor
  (Settings → Appearance) now has a reset button that restores every
  style's size to its default in one click.

### Changed

- **Jumping around large documents is now even faster.** Outline-pane
  jumps have always landed instantly, but on very large files a burst
  of rapid jumps could briefly bog the interface down right afterward.
  Cards now give the browser an accurate size hint before they're
  first rendered, so navigation stays smooth no matter how fast you
  click.

- **Copy Previous Cite now copies only the nearest cite.** Copy
  Previous Cite (Alt-F8) used to copy every cite paragraph under the
  most recent source; it now copies just the single nearest preceding
  one. A new setting (Settings → Editing → Cites) restores the old
  copy-the-whole-group behavior.

- **Nav pane width is now per-window.** Dragging the outline's edge
  resizes only the window you're in; other open windows keep their
  widths. The width you set still becomes the default for windows you
  open afterwards — same model as the new Default navigation depth.
  **Double-click the edge** to snap back to the standard width.

- **Numbering restart works on selections too.** Select several blocks
  in the navigation pane (Shift/Ctrl-click) and hit the restart toggle:
  every selected block flips to "continue" in one press, so arguments
  separated by blocks number consecutively (1…30 instead of restarting
  at each block); press again to restore the per-block restarts. Works
  symmetrically for a selection of tags (flag several cards to restart
  the count), and for text selections in the editor spanning blocks.

- **New setting: Default navigation depth** (Settings → General). Sets
  how deep the navigation pane opens for newly opened documents
  (Pocket / Hat / Block / Tag; default Block). The pane's 1–4 buttons
  now change the current document only — previously a level click
  quietly became the default for every future document.

### Fixed

- Pasting from Word no longer inserts a picture of the copied text.
  Word puts a rendered image of the selection on the clipboard
  alongside the actual text, and CardMirror preferred the image; the
  real text now wins whenever it's present. Screenshots and copied
  images still paste as images.

- Saving to Word no longer produces a corrupted file when the document
  contains invisible control characters (most often picked up by
  pasting from a PDF). Word refuses to open an XML file containing
  them; CardMirror now strips them at export.

- Rapid back-to-back saves into a Dropbox (or antivirus-watched)
  folder on Windows no longer fail with a scary EPERM error. Dropbox
  briefly locks a freshly-saved file to sync it, and Windows refuses
  to replace a locked file — CardMirror now retries for a moment,
  which absorbs nearly all of these, and if the file stays locked the
  message plainly says what happened and to try again in a few
  seconds.

- Turning a numbered tag into an analytic (or an analytic back into a
  tag) no longer clears the card's numbering or restart flag — the
  number carries across the swap.

- CardMirror now ships real document icons for `.docx` and `.cmir`
  files instead of letting the system derive one from the app icon —
  fixing the corrupted-looking file icons some users saw in Finder and
  third-party file managers after making CardMirror their default
  .docx app.

## 0.1.0-beta.14 — 2026-07-13

### Added

- **Web app: download + GitHub buttons.** The web edition's top-right
  button cluster gains a download button that fetches the right desktop
  installer for your computer (or asks — Windows, macOS Apple
  Silicon/Intel, or Linux — when the browser can't tell), and a GitHub
  button that opens the CardMirror repository. Desktop app unchanged.

### Changed

- **The web app moved to [cardmirror.app](https://cardmirror.app).** The
  old GitHub Pages address now redirects there automatically. Because
  browsers keep site data per-address, web settings, recents, pins, and
  quick cards don't carry over — your document files themselves are
  untouched (they live on your disk). Re-install the app from the new
  address if you had it installed, and use Settings → Export/Import to
  carry your settings across. The desktop app is unaffected.

- **Saving is much safer when files move or change underneath the app**
  (desktop).
  - If you rename or delete a file in Finder/Explorer while it's open,
    the next save no longer silently recreates a copy at the old
    name — CardMirror tells you the file is gone and offers **Save As…**
    so you choose where the document lives now. (Previously you could
    end up with two quietly diverging copies.)
  - **Save As… now opens next to the document** — in the file's own
    folder normally and, when the old location is gone (a renamed or
    moved folder), in the closest folder that still exists, right where
    the file used to be — instead of wherever you last saved something.
  - If a file changes on disk while it's open — edited on another
    device, by another program, or replaced by a sync service like
    Dropbox — Save now asks before replacing it: **Overwrite**,
    **Save As…** (keep both), or cancel. Autosave never overwrites a
    file that changed underneath it; it pauses with a notice instead.
  - Documents are now written atomically (staged then swapped into
    place), so a crash or power loss mid-save can no longer leave a
    half-written file, and rapid overlapping saves of the same file
    can no longer collide.

- **Card numbers now show in the navigation pane.** When auto-numbering
  is on, each numbered card's row in the outline carries the same
  computed number or letter as the editor, in your configured format.
  Toggling numbering or changing its format updates the outline
  immediately. You can also number from the outline directly:
  Shift-click or Ctrl/Cmd-click several tags, then hit the number or
  substructure toggle — it applies to all selected cards at once, and
  the selection persists for repeated toggles.

- **New numbering option: Bold substructure letters** (Settings →
  Appearance → Card numbering). On by default: substructure letters now
  render truly bold, matching the numbers and surrounding bold tag text
  (they previously came out normal-weight and slightly faded in common
  document fonts). Turn it off for normal-weight letters while numbers
  stay bold. Display-only, like the capitalization toggle.

- **Dragging in the navigation pane no longer shifts the outline.**
  Drop targets used to open up as small gaps that pushed every entry
  below them further down — noticeably so near the bottom of a long
  outline. The blue drop bar now appears directly on the boundary
  between entries instead, and the outline stays perfectly still while
  you drag.

### Fixed

- Keystrokes typed in the moment a save was still writing to disk are no
  longer marked as saved — the document correctly stays "unsaved" until
  they actually reach the file, so closing right after a save can't skip
  the save prompt for them.

## 0.1.0-beta.13 — 2026-07-12

### Added

- **Optional Debate Decoded account linking** (Settings → Collaboration).
  You can now link CardMirror to a Debate Decoded membership: click
  **Open the connect page** in the new **Debate Decoded account (optional
  in beta)** row, sign in, and paste the code the page shows you.
  **While CardMirror is in beta this is optional and required for
  nothing** — card sharing, co-editing, and every other feature work
  identically with or without it, and self-hosted relays never need an
  account. Linking simply readies this machine in case the hosted relay
  asks for accounts after the beta; once linked, the app re-authorizes
  itself automatically, and the row tells you if your membership ever
  shows as inactive. A membership covers two machines; linking a third
  asks before unlinking the oldest.

- **AI features can now use OpenRouter** as an inference provider, alongside
  the Anthropic API. Pick the provider under **Settings → Comments & AI → AI
  provider**. OpenRouter needs its own API key and a model id (for example
  `anthropic/claude-sonnet-4.6`); there is no built-in default, so set the
  model before using AI features. The translation backend formerly labeled
  *Anthropic* is now *AI provider* — it translates through whichever
  provider you picked. (PR #13, thanks to
  [Shreeram Modi](https://github.com/shreerammodi).)

- **Custom autocorrect** (Settings → Editing → Typing, off by default).
  Word-style "replace text as you type" with your own entries — `fwk` →
  `framework`, `--` → `---` — expanding when you finish the sequence with a
  space or punctuation, everywhere in the document. Lowercase entries adapt
  to your typed casing. The table flags clashes: a second entry for the same
  input is refused, and entries another typing aid would intercept show a
  warning explaining why they can't fire. Works together with
  Auto-capitalize (an expansion starting a sentence in a tag comes out
  capitalized), and Backspace right after any conversion restores exactly
  what you typed.

- **Auto-capitalization for tags and analytics** (Settings → Editing, off by
  default). The first word of each sentence — and a standalone `i` — is
  capitalized the moment you finish the word with a space or punctuation, in
  **tags and analytics only**: card bodies, cites, and everything else are
  quoted source text and are never altered. It won't fire after
  abbreviations (`etc.`, `vs.`, `pp.`, months), initials, or an ellipsis,
  and it leaves `(i)`-style enumeration markers alone. Press Backspace right
  after a capitalization to revert it, same as smart quotes and the custom
  dash.


### Changed

- **AI errors are clearer, and momentary failures fix themselves.** When the
  AI provider is briefly overloaded, rate-limiting, or having a server
  hiccup, the request now retries once on its own before showing an error —
  and a hung connection times out after five minutes instead of spinning
  forever. Error messages got smarter too: a safety-filter decline says so
  (instead of a confusing "empty response"), an out-of-credits OpenRouter
  account is pointed at where to add credits, a moderation block names what
  was flagged, and a model that doesn't accept CardMirror's temperature
  setting no longer fails the request — it's retried without it. This
  matters if you point the **AI model** setting at the newest Claude models,
  which reject that setting outright.

- **Structural commands are dramatically faster on large documents.** Finding
  where a section ends used to scan the rest of the document — now it checks
  siblings only. Move Container Up/Down drops from a hard freeze per press on
  tournament master files (~65 ms measured on a mid-size file, hundreds of ms
  on big ones) to effectively instant; send/select/copy-current-heading and
  drag-hover over headings are ~70x faster; PageUp/PageDown navigation ~17x.
  Two subtle bugs fixed along the way: a heading inside a live view could cut
  an enclosing section short, and send-current-heading could truncate a
  section at a live zone's mirrored heading.

- **Card numbering is ~30x cheaper per keystroke while displayed.** Typing
  used to renumber and rebuild every card's glyph on each edit (~6 ms per
  keystroke at 2,000 cards). Ordinary edits now keep the existing numbers
  and just shift their positions, doing the full rebuild only when structure
  actually changes (cards/headings added, removed, moved, or renumbered).
  With **Match heading** color on, every edit still rebuilds — a text edit
  inside a colored heading can change the number's color.

- **Card numbering no longer costs anything while its display is off.** The
  numbering plugin was recomputing every card's number on every edit even
  with numbering hidden (~5 ms per keystroke on a 2,000-card file). With the
  display off it now does nothing at all; toggling it on rebuilds instantly
  in every open pane.

- **Selecting and drag-selecting on large documents is much lighter.** The
  ribbon readouts that mirror the selection (font-size chip, style buttons,
  numbering buttons) used to recompute on every transaction — including ~60+
  times per second while drag-selecting, and twice per keystroke in
  three-pane. They now refresh at most once per frame, only when the
  document, selection, or pending marks actually changed, and share one pass
  over the selection. Readouts land within a frame (~16 ms) — visually
  identical, at a fraction of the cost.

### Fixed

- **A harmless browser notice no longer triggers the error toast.** The
  "something went wrong" safety net added in beta.12 could fire on launch
  for a benign internal browser message (`ResizeObserver loop…`) that
  signals nothing broken. It's now ignored, so that toast only ever means
  a real failure.

- **Autocorrect polish (smart quotes + custom dashes).** The
  Backspace-revert (press Backspace right after a conversion to get the
  literal characters back) no longer dies silently when background activity —
  a co-editing session's cursor updates, spellcheck results — happens between
  the conversion and the Backspace. A quote typed right after a footnote
  marker now curls closed instead of open. And the `---` dash trigger no
  longer converts the tail of a longer hyphen run (pasted hyphens, ASCII
  dividers) — only a clean sequence fires, matching the `--` trigger's
  existing behavior.



- **Renamed or moved folders no longer strand your document.** If a file's
  folder is renamed, moved, or deleted while the document is open (for
  example by a cloud-sync change on a shared Dropbox), saving used to fail
  with a raw "ENOENT" error and closing the document became impossible.
  Save now explains what happened and offers **Save As…** so your work has
  somewhere to go — including when the save was triggered from the
  close-document prompt.

- **Errors can no longer fail invisibly.** An unexpected error in the Save or
  Save As flow now shows an explicit message instead of doing nothing at all,
  a background error can't silently kill autosave or crash-recovery journaling
  for the rest of the session (they recover on the next attempt), and any
  otherwise-unhandled error now surfaces as a notification with details in the
  developer console — so "I clicked it and nothing happened" always comes with
  an error message we can act on.

- **Closing, quitting, switching layouts, and startup recovery are
  crash-proofed.** An unexpected error while closing a window or quitting now
  cancels the close cleanly (window stays open, with a message) instead of
  leaving the quit hanging; a failed layout switch reverts to the current
  layout and — fixing a subtle one — no longer silently disables the toggle
  for the rest of the session; and startup recovery now reopens every
  readable draft even if one journal is unreadable, telling you about any
  document it couldn't restore instead of skipping it silently.

- **Sending a card can no longer fail silently, and closing a document
  always responds.** If inserting a sent card into the speech document fails
  for any reason, both you and the error now get a clear message instead of
  the card quietly never arriving (the send flow used to report "delivered"
  even if the far end choked). And an unexpected error while closing a
  document — the Home button, or a pane's ✕ in three-pane — now shows why and
  leaves the document safely open, instead of a click that does nothing.

- **Autosave failures are no longer silent.** When an autosave can't write
  (stale path, permissions, full disk), CardMirror now shows a toast the
  first time it happens, and the autosave button turns red with a solid
  outline until a save succeeds — so "I thought it was saved" can't happen
  quietly anymore. Hover the button for the reason.

## 0.1.0-beta.12 — 2026-07-10

Co-editing bug-fix release, focused on the three-pane workspace. (Co-editing
remains **experimental** — keep your own saved copies.)

### Changed

- **Switching between single-pane and three-pane now closes co-editing
  sessions cleanly.** Your co-edited documents no longer try to carry their
  live session across the switch — they close (with your unsynced changes
  saved) and reappear in the home screen's **Sessions** list, where you reopen
  them in the new layout. The switch confirmation tells you when this will
  happen. The old behavior looked seamless but could silently lose edits made
  during the reload, only ever restored some sessions, and left stray copies
  of documents from other windows.

- **Card numbering: appearance changes apply instantly, and numbers can match
  their heading's color.** Changing the number or substructure separator (or
  capitalization) now repaints existing numbers immediately instead of waiting
  for the next numbering toggle. And the numbering-color setting gains a
  **Match heading** option: each number takes its own tag or analytic's text
  color — so the Analytic text color option (and the document text color)
  drive the numbers, and a manual font color recolors a number too, when it
  covers the heading's entire text (a partially recolored heading leaves its
  number on the base color).

- **Dialog polish.** Plain yes/no confirmations (starting or ending a
  co-editing session, switching workspace modes) now show two equal buttons
  instead of one large option card with a small cancel link — the big option
  cards are reserved for real multi-choice decisions like Save / Don't Save.
  Cancel buttons everywhere now match the primary button's size.

### Fixed

- **Accepting a co-editing invite works in three-pane.** Clicking **Join** in
  the three-pane workspace now asks which pane the shared document should open
  into and joins there — like opening a file. Before, it either downloaded the
  whole document and then failed with a misleading "Join cancelled," or opened
  a broken extra window that errored with "This file is empty or hasn't
  finished downloading."

- **Rejoining a session works in three-pane.** Resuming from the home screen's
  **Sessions** list (reach it with the Home button) now asks for a pane the
  same way, instead of failing with "Resume cancelled."

- **A failed join no longer eats the invitation.** The SESSION row stays in
  your Receive pill — with its share code — until you actually get into the
  session, so a cancelled pane pick or a connection problem doesn't force the
  host to re-invite you. (An invite whose session has already ended still
  clears itself.)

- **Joining an ended session now says so.** Joining or resuming a session the
  host has ended (or that expired) reports "That co-editing session has ended"
  instead of pretending to join: previously you'd get a blank document, a
  "Joined the session" toast, and a phantom entry in your Sessions list.

- **Clear error when a network filter blocks co-editing.** School content
  filters (such as Securly), captive portals, and antivirus web-shields that
  intercept the connection now produce a plain-language error naming the
  blocked address, instead of the cryptic `Unexpected token '<'` message. If
  you see it on a school-managed device, ask IT to allow
  `scouting-assistant.up.railway.app`.

- **Starting a session sticks to the right document.** In three-pane, a
  session now binds to the document you started it from even if you click
  into another pane while it connects.

- **Home-screen Recents and Sessions no longer collide with your open
  document.** In one-doc-per-window mode, clicking a recent file — or resuming
  a session — while a document is already open now opens it in a **new
  window** instead of trying (and failing) to load over the one you're in.
  The home screen at launch still opens into the window you're looking at,
  and three-pane still asks which pane to use.

- **The host's ✕ on a home-screen session now really ends it.** Clicking ✕ on
  a session you host asks whether to **End Session** (for everyone — nobody
  can rejoin) or just **Forget My Copy**. Before, it only removed the session
  from your own list, so people you'd invited could quietly rejoin and keep
  editing a session you thought was over. A guest's ✕ still just forgets
  their copy.

- **Ending a session while offline no longer pretends to succeed.** The
  in-session **End Session** now checks that the session was actually ended
  on the relay; if you're offline it says so and leaves the session running,
  instead of reporting success while everyone else keeps editing.

- **Closing a co-edited document from a pane's stack list now asks.** In
  three-pane, closing a co-edited document from the stacked-documents
  dropdown skipped the keep / end / leave question entirely when the doc had
  no unsaved file changes. It now gets the same session-aware close as
  clicking ✕ on the pane.

- **"Keep session" closes verify the save.** Choosing to keep a session
  resumable when closing its document now confirms the session record
  actually landed on disk before the document closes — if it can't be
  confirmed (disk full, storage denied), the document stays open with the
  session live instead of silently risking your work. Quitting the app with
  live sessions saves them the same way.

- **Rejoining a session you've been in picks up your copy.** Clicking Join
  (or pasting a share code) for a session you already have saved now resumes
  your saved copy — including unsynced changes — instead of downloading a
  fresh copy and stranding the old one. And a resume that fails no longer
  deletes your saved session.

- **No more duplicate copies from the home screen.** Recents and Sessions
  refuse to open a document or session that's already open — in this window
  or another one (the other window is brought to the front instead).

- **Undo can no longer delete comments in a session.** While co-editing,
  Ctrl+Z stepped through comment operations along with your edits — an undo
  right after someone commented could silently remove comments or replies for
  everyone. Undo now skips comment operations entirely; comments only change
  through the comments panel.

- **Parked comments survive sessions.** A comment whose highlighted text you
  deleted before a session (kept invisibly so undoing the deletion restores
  it) was silently discarded the first time the session synced comments. It
  now stays parked, and undoing the deletion still restores it.

- **AI comment replies land where you asked.** In three-pane, an AI reply
  requested in one pane could land in whichever pane you'd focused by the
  time the answer arrived. It now always lands in the thread you asked from —
  and is dropped cleanly if that thread was deleted while it was thinking.

- **The session status chip follows the document you're looking at.** In
  three-pane the shared status chip could keep showing another document's
  session — sometimes a *dead* one — until an unrelated event repainted it.
  It now repaints when you switch panes, and its label and presence dots can
  no longer disagree.

- **Invite Starred / Copy Share Code act on the focused document.** Both
  used to fall back to "whatever session exists" — inviting someone into a
  different document's session than the one you were looking at. They now
  act on the focused document's session, and say so if it doesn't have one.

- **Ending a session repaints the right pane.** When a session ended (by you
  or remotely), the cleanup refreshed whichever pane was focused — an
  unfocused co-edited pane kept dead session internals until you clicked
  into it and could behave oddly. The owner pane itself is now refreshed,
  including when you back out of the close dialog afterwards.

- **Honest connection errors mid-session.** If the relay rejects your
  credentials while you're in a session, CardMirror now says so once (with
  where to fix it) instead of silently retrying forever in a state that
  looked exactly like being offline. A session whose room has expired on the
  relay now ends cleanly ("this copy is now yours alone") instead of retrying
  into nothing. And joining a **full** session no longer half-succeeds — your
  copy is saved and you're told to rejoin from the Sessions list when someone
  leaves, instead of being left with a dead "offline" document.

- **Faster reconnect after sleep.** Waking your laptop mid-session could wait
  out a leftover reconnect delay from before it slept; it now reconnects
  immediately. Two rare sync-recovery bugs are also fixed: a multi-page
  catch-up could cancel a full resync one of its earlier pages had requested,
  and a single unreadable snapshot on the relay could permanently wedge
  syncing (it's now skipped like any other unreadable frame).

- **Double-clicking Start Session no longer creates two sessions.**

- **Renaming a co-edited document updates its name everywhere.** The name you
  see in the Sessions list — and the one new joiners get — now follows a
  mid-session rename instead of keeping the original title forever.

- **The mode-switch confirmation matches the app's other dialogs** (and no
  longer uses the system popup that could leave the editor untypeable on
  Windows/Linux).

- The Sessions list now says "saved …" instead of "last synced …" — the
  timestamp was always the local save time, which advances even offline.

- **Sending a card no longer leaves blank tag lines behind.** If the speech
  document happened to have a leftover text selection, a card sent with the
  tilde key (or the dropzone / palette) was inserted mid-text, splitting the
  card it landed in — and every split half grew an empty tag line to satisfy
  the card structure ("2-3 blank tag lines after the card"). Sends into a
  selection now snap to the nearest clean boundary, exactly like sends at a
  cursor already did.

- **Fixed the "can select but can't type" bug — for good.** Several flows
  (send-to-speech with no speech doc set, Verbatim Flow overwrite prompts,
  voice-model dialogs, various error notices) used the system's native
  alert/confirm popups, which on Windows and Linux never hand keyboard focus
  back to the editor when dismissed — you could still click and select, but
  typing was dead until a reload. We'd patched these one at a time; this
  release replaces **every** native popup in the app with CardMirror's own
  dialogs, which also now return your cursor to exactly where it was when
  any dialog closes.

- A couple of messages still pointed at the old "Card Sharing" settings name;
  they now say **Collaboration**.

- **Choosing a section for a live view or linked copy is instant on large
  documents** — the picker was re-resolving every section's full content just
  to list the headings. It is now a collapsible outline with a filter box and
  keyboard navigation.

- **Live views show up in read mode again.** They had been disappearing
  entirely when read mode was on. A live view now reads exactly like the cards
  it mirrors — headings, cites, and highlighted text — with its dotted rail
  still visible so you can tell mirrored content from its source.

- **The "saving to Word drops live links" warning now counts live views.** It
  only knew about linked copies, so a document whose only live content was
  live views saved to `.docx` — flattening them — without a word. The warning
  now covers both, on every path that writes a `.docx`: Save, Save As, and the
  save prompts when closing a document or quitting, in both layouts.

## 0.1.0-beta.11 — 2026-07-10

> **Renamed — please read if you used "live zones."** The beta.10 "live zones"
> feature has been **renamed to "linked copies"** and reworked into two distinct
> things (a read-only **live view** and an editable **linked copy**). Your
> existing documents keep working unchanged, but the names and menus are
> different. See **"Live zones" are now "linked copies"** under *Changed* below.

### Added

- **Real-time co-editing.** Work in a document together, live — edits, comments,
  and cursors sync as you type. Invite a partner from the **Send** menu (the same
  partners you use for card sharing); they accept from their **Receive** pill.
  (No saved partner? Start a session and share its one-off code, which they paste
  into **Join Collaboration Session**.) It keeps working offline — your changes
  sync back when you reconnect — and it survives closing the app: reopen and
  rejoin from the **Sessions** list on the home screen. Each open document runs
  its own session, so you can co-edit several at once — several documents in a
  three-pane window, or separate windows — each with its own collaborators shown
  alongside it. **Still experimental** — expect some rough edges, and keep your
  own saved copies rather than relying on a session as your only copy of a
  document. *(Desktop-only; it travels over the same end-to-end-encrypted relay
  as Card Sharing.)*

- **Show a section in more than one place — live views and linked copies.**
  CardMirror can now display one section of content wherever you need it, kept
  connected to its source. A **live view** is a read-only window onto another
  section of *this* document — it always shows the current content, updating the
  instant you edit the source (nesting and cycles handled automatically). A
  **linked copy** is your own editable copy, kept linked so you can **Refresh**
  it and get nudged when the source changes; its source can be another file *or*
  this document. Insert either from the command bar. *(The former "live zones"
  are the file-based linked copy — see below.)*

- **Linked copies flag when their source has changed.** A linked copy already
  shows a dot when *you've* edited it; now it also badges when the *original*
  has moved on, so a stale copy is visible at a glance. Nothing is overwritten —
  it's a prompt to **Refresh**, and the badge clears once you do. Check on demand
  with *Check Linked Copy Sources for Updates*. The badge color is configurable
  under Settings → Appearance. *(For a copy from another file the check is
  desktop-only; a copy from this document tracks its source live.)*

- **Automatic card numbering.** Number cards and their sub-parts automatically —
  computed as you go and renumbered when you reorder. Turn it on from the
  numbering cluster in the ribbon (or the command bar), and tune it in a new
  **Card numbering** section under Settings → Appearance: independent formats for
  the number and its substructure, a range of separators (period, dash, colon,
  and more), optional capitalization, a configurable color, and separate indents.
  It's display-only — your card text is never changed — and it round-trips
  cleanly to Word.

### Changed

- **"Live zones" are now "linked copies" — and the feature was reworked.** In
  beta.10, embedding a section from another file made a *live zone* (an editable
  copy you could refresh). That is now split into two clearer things, and
  renamed:
  - A **live view** is a *new*, read-only window onto another section of the
    *same* document — always showing the source's current content.
  - A **linked copy** is your own editable, refreshable copy — this is what the
    old "live zone" became, and it can now link to another file *or* to a
    section of the current document.

  Commands and menus use the new names ("embed" still works as a search alias),
  and existing documents open unchanged — only the wording and structure moved.
  If a tutorial or note says "live zones," read that as "linked copies."

- **Zoom now goes up to 300%.** The maximum body-text zoom and whole-window
  chrome scale were both raised from 200% to 300% (Settings → Appearance, the
  zoom controls, or ⌘=/⌘−).

- **The "Card Sharing" settings tab is now "Collaboration."** It houses both card
  sharing and co-editing, so the tab — and the switch that turns them on, now
  **Enable collaboration** — carry the broader name. Card sharing itself is
  unchanged; it's just grouped under Collaboration.

### Fixed

- **Intel Macs launch again.** The Intel build was shipping without its
  native accessibility helper, so some Macs — every Intel machine, plus Apple
  Silicon Macs that had grabbed the Intel download — failed to start with a
  "Cannot find the native Koffi module" error. Both builds now carry the right
  helper.

- **⌘Q now actually quits on macOS.** Pressing ⌘Q — or choosing Quit from the
  app menu — closed CardMirror's windows but left the app running in the dock
  instead of quitting. It now exits fully once any unsaved-changes prompts are
  handled. Backing out of a quit (Cancel, or a save that fails) still leaves
  the app running, the way macOS expects. (Thanks to
  [Cora](https://github.com/coralynnkc).)

- **The AI "Thinking…" pill is anchored correctly in three-pane mode.** While an
  AI action ran, the "Thinking…" pill could pile up at the top of a pane —
  overlapping the document bar — instead of sitting beside the text being worked
  on. It now tracks the right spot in each pane.

- **A partly-highlighted underline no longer darkens its unhighlighted part.**

- **Highlighted text inside a table now shows in read mode.** Highlighted
  evidence sitting inside a table used to vanish along with the table when you
  entered read mode; it now reads inline with the rest of the card, in document
  order.

## 0.1.0-beta.10 — 2026-07-07

### Added

- **Live zones (transclusion).** Embed a section from another file — a
  heading and its cards — into your document as a live-linked, editable copy.
  Find a heading in the Search Everything palette and press Mod-Enter to drop
  it in; it shows a teal rail, and the navigation pane marks the transcluded
  headings with a faint green rail. Edit the cards in place, then **Refresh
  Live Zone** — or **Refresh All Live Zones** — to pull the source's current
  version back in (it confirms before discarding your edits). The zone's glyph
  menu can open the source, re-pick it, unlink it (keeping the content as
  ordinary cards), or delete it. Sources can be `.cmir` or Word `.docx` files
  — for a Word file, CardMirror adds a tiny bookmark so it can find the
  section again, and declines rather than make a zone it could never refresh.
  Live links live only in `.cmir` files: **saving your document to Word
  (`.docx`) flattens each zone to plain cards and drops its link** (the
  content stays, but it's no longer live). *(Creating and refreshing are
  desktop-only; zones you've made render everywhere, including the web version
  and shared or co-edited copies.)*

- **Privacy policy.** CardMirror now has a privacy policy (`PRIVACY.md`),
  linked from Settings → General and the Help menu. It describes, in plain
  language, what each feature does with your data — no accounts, no tracking,
  work kept on your own device — and spells out data retention: shared cards
  are deleted from the relay once delivered and after 3 hours regardless, and
  co-editing sessions are deleted when the host ends them or after 7 days idle.

- **Terms of use.** CardMirror now has terms of use (`TERMS.md`), linked from
  Settings → General and the Help menu — covering eligibility, acceptable use
  of the sharing features, that you keep all rights to your content, and the
  beta "keep your own backups" disclaimer.

- **Mark unread text after a reading marker.** A new toggle (Settings →
  Appearance, or search "unread" in the command bar) tints card body text
  *after* a reading marker red — a visual record of what you didn't reach in a
  round. Off by default, bounded per card, and preserved when you export to
  Word. That red and the marker's own red are now a single, rebindable **Style
  color** (Settings → Appearance → Style colors, linked to Accessibility) so
  colorblind users can change it. (Thanks to
  [Shreeram Modi](https://github.com/shreerammodi).)

### Changed

- **Smarter file search, with a sort you choose.** File-search results now
  rank by how well the query hits the file **name** — exact, then a name that
  *starts* with it, then a word-start match (`war` → **War**ming, not
  Soft**war**e), then a match anywhere — and you can now match on the
  **folder** too, so `neg warming` finds `Neg/Warming DA`. Files that tie on
  match quality (and the browse list before you type) fall back to a new
  **tie-break** setting under Settings → Files: **Recency** (most-recently-
  edited first, the default) or **Alphabetical** — also cyclable from the
  command bar. Pinned files still sort above everything. Searching *inside* a
  file ranks the same way and breaks ties by document order.

- **Type timer values keypad-style.** Typing a number into the timer without a
  colon now reads the last two digits as seconds — `800` is 8:00, `130` is
  1:30 — instead of that many seconds. One- or two-digit entries are unchanged
  (`90` is still 1:30), and `MM:SS` still works exactly as before.

### Fixed

- **Opening an un-downloaded cloud file no longer errors out.** A `.cmir` or
  `.docx` in Dropbox or iCloud Drive that's set to "online only" and hasn't
  downloaded yet used to fail to open with a confusing "Not a CardMirror file"
  message. CardMirror now waits for the download to finish and then opens it;
  if it still can't, it tells you the file may not be downloaded (and to make
  it available offline) instead of the cryptic error.

## 0.1.0-beta.9 — 2026-07-07

### Added

- **Change settings from the command bar.** Every on/off setting now has a
  "Toggle …" command, and a set of mode settings (icon style, ribbon
  tooltips, formatting panel, reduce motion, timer position, multi-doc
  layout, condense heading handling) has a "Cycle …" command that steps to
  the next value. Open the command bar (⌘/Ctrl-Shift-Space), search "toggle"
  or "cycle" — or just the setting's name — and change it without opening
  Settings.

- **Style the FOR REFERENCE heading.** Create Reference can render the
  heading line bold, italic, emphasized, and/or underlined — set it under
  Settings → Editing → Create Reference. (Bold and italic show in Word too;
  emphasize and underline are CardMirror styles that fall back to plain text
  in Word.)

- **Block senders in Card Sharing.** Settings → Card Sharing → Blocked
  senders drops cards and room invites from specific people — paste a code to
  block, or one-click block someone who recently shared with you. Blocked
  items never appear in the Receive pill or its unread count; unblock to
  bring their earlier cards back.

- **Remove downloaded dictation models.** Settings → Voice: delete the
  standard (~130 MB) or large (~1.8 GB) recognition model to reclaim disk
  space. Voice re-offers the download whenever it next needs a missing model.

- **Custom ribbon buttons.** Add up to six of your own buttons to the ribbon
  (Settings → Appearance → Custom ribbon buttons), each running a command you
  choose — including the new Toggle / Cycle setting commands — with an icon you
  pick. They sit to the right of the comments buttons and hide when none are
  configured.

### Fixed

- **The white-screen crash no longer strands your work — and is
  prevented at the source on macOS.** On some machines the editor could
  turn solid white with no way back, usually right after an
  assistive-technology tool (a screen reader, Voice Access, or — on
  macOS — certain system accessibility features) touched a
  heavily-highlighted document. Turning the accessibility tree off by
  default in an earlier release reduced this but didn't fully close it on
  macOS. Two changes finish the job: macOS now blocks the exact system
  signal that set the crash off, so it doesn't start; and on every
  platform, if the editor ever does go down, CardMirror automatically
  reloads and restores your document from its recovery journal instead of
  leaving a blank window. If you turned Screen reader support back on
  under Settings → Accessibility, the macOS block is skipped to respect
  that choice — and the automatic recovery still covers you.

- **"New document" and opening files work from the home screen again.**
  With a multi-slot highlight or shading color override turned on, clicking
  "New document" on the home screen did nothing, and opening a file showed
  "Failed to load: Applying a mismatched transaction." Both work now, on the
  first and every subsequent open.

- **Folder pickers in Settings render correctly.** The Send Doc, Marked
  Cards, and new-speech-document folder settings (and the file-search folder
  list) had a collapsed, clipped path box; the path now shows on one line
  with Browse / Clear beside it.

### Changed

- **Settings search shows where a setting lives.** Context-free rows in the
  command bar's settings search now carry their section — "Bold heading"
  reads as "Create Reference: Bold heading" — so fragment labels are clear
  outside the Settings dialog, and you can find them by section too.

### Preview — collaboration sessions (desktop only, off by default)

Refinements to the experimental collaboration preview (still opt-in via the
developer console, as in beta.8):

- **Invite from the Send pill.** Each recipient/group row now has an "Invite
  to collaborate" button (shown when you click the Send pill and collaboration
  is on), instead of a separate invite mode.

- **See who's in the room.** The session status chip shows a colored dot per
  participant — hover a dot for their name.

- **Accepting an invite opens a new window.** Joining a session no longer
  overwrites the document you're working in — it opens in a new window (unless
  you're on a blank starter, which it reuses).

## 0.1.0-beta.8 — 2026-07-04

### Added

- **Word-style image resizing.** Click an image to get eight resize
  handles: corners resize proportionally, edges stretch one axis —
  exactly like Word. Sizes round-trip to .docx, so a resize here is
  the same resize in Word. (Thanks to [Neo Cai](https://github.com/caineoyuan).)

- **Open Developer Console command.** The command bar can now open the
  built-in developer console on desktop (search "Open Developer
  Console"; bindable to a key of your choice in Settings). Useful when
  support asks you to check for errors — packaged builds previously
  had no way to open it on Windows or Linux.

### Preview — collaboration sessions (desktop only, off by default)

This build carries an **early preview** of real-time collaboration. It
is experimental and **may break** — expect rough edges, and know that a
session can occasionally desync or need restarting while we field-test
it. It runs only in the **desktop app** (the web version has no
server-backed features), and it stays off unless you switch it on
yourself — there's no setting for it yet. To try the preview: open the
developer console (search the command bar for "Open Developer Console"),
run `localStorage['pmd-collab'] = '1'`, and reload. We'll announce it
properly, with a real on-switch, once it's ready. What's in the preview:

- **Collaboration sessions.** Start a session on the document you have
  open; a partner joins and you edit together live. Built for
  tournament reality: it keeps working through offline stretches,
  laptop sleep, and hotel wifi, syncing whenever either side gets a
  connection — even if you're never online at the same moment. Ending
  a session leaves everyone with their own copy.
- **Invites through card sharing.** Click the Send pill (or use the
  "Invite Starred Partner to Session" command) to invite a partner;
  the invite lands in their Receive pill with a Join button. Invites
  pre-download the document so joining works even if you've gone
  offline by the time you accept.
- **Partner presence.** See your partner's cursor and selection live,
  labeled with their name (toggle in Settings → Card Sharing), plus a
  marker over any region where their AI routine is working.
- **Comments sync.** Comment threads and replies travel with the
  session, not just the highlight.
- **Sessions survive restarts.** A Sessions list on the home screen
  resumes any session — including edits made offline that never got a
  chance to sync before the app closed.
- **Large documents supported.** Sessions work on big master files.
- Everything is end-to-end encrypted; the relay only ever stores
  ciphertext.

### Fixed

- **Word tables with uneven rows import cleanly.** A .docx table whose
  rows have different numbers of cells (Word allows this) is now padded
  to a clean rectangle on import, so row and column editing behaves
  predictably instead of misaligning.

- **Find bar stays on screen on narrow windows.** On a small or
  narrow window the find bar could extend past the edge and clip its
  controls; it now stays within the viewport. (Thanks to
  [Shreeram Modi](https://github.com/shreerammodi).)

### Changed

- **Zoom is smoother and shows where you'll land.** Zooming (⌘/Ctrl
  +/−, the zoom buttons, or Ctrl/pinch) now shows the target percentage
  as you go and re-renders once when you settle, instead of resizing on
  every step — and it holds the top of your screen where it was instead
  of drifting.

- **Read mode keeps your place.** Turning read mode on or off now keeps
  you where you were reading, instead of jumping to a different part of
  the document — the first visible content stays at the top of your
  screen. (If you prefer the old jump-to-top behavior, the "Jump to doc
  top when read mode toggles" setting still does exactly that.)

- **Bulk Compress retired from the Home screen.** The one-time tool for
  shrinking older uncompressed files has been removed from the Home
  screen — files already compress automatically when you save, so it's
  no longer needed. Quick Cards now sits where it was.

- **Editor stability: internal fix-up passes are now loop-guarded.**
  The automatic tidy-ups that run after every edit (card absorption,
  paragraph reclassification, underline style normalization) can no
  longer chase each other indefinitely in unusual documents — a
  safety cap stops the cycle instead of freezing the window.

- **Self-hosted relay: hardened against heavy traffic.** The bundled
  relay server (`relay/`) now stays responsive under sustained send
  bursts that could previously stall it until restarted. When genuinely
  overloaded it declines new requests cleanly (the app just retries)
  instead of hanging. No configuration changes needed; the wire
  protocol is unchanged, so existing apps and older CardMirror versions
  work exactly as before.

## 0.1.0-beta.7 — 2026-07-02

### Added

- **Card sharing: instant delivery.** Sent cards now arrive in about a
  second instead of on the next 30-second check: the app keeps a light
  push connection open to the relay, with a quick catch-up sweep on every
  reconnect and on waking from sleep, so nothing is missed while offline
  (cards still wait on the relay for up to three hours). Older relays
  without push support keep working — the app detects them and falls back
  to interval polling ("Fallback poll every" in settings). Note:
  **support for legacy card sharing will be deprecated soon** — older
  CardMirror versions will eventually stop being able to send and
  receive, so update to keep using the feature.
- **Card sharing: bring your own relay.** Two new settings — **Custom
  relay URL** and **Custom relay token** — point card sharing at a
  self-hosted relay server. The relay now ships in this repo's `relay/`
  folder as a standalone deployment (Docker compose, one command — see
  `relay/README.md`). Leave the settings empty for the official relay.
- **Standardize with exceptions.** Two new Doc-menu commands — **Standardize
  Highlighting (with Exception)** and **Standardize Background Color (with
  Exception)** — work exactly like the plain standardize commands but leave
  one color of your choice completely untouched. Pick the protected colors
  in Settings → Editing → Standardize exceptions (both default to yellow).
  The menu labels show your current exception, e.g. "Standardize
  Highlighting (except Yellow)". Both commands are
  keybindable (unbound by default). Combined with the "No color" pen, they
  also work as "clear everything except my exception color".
- **Search palette tooltips.** When a result's file name, heading, or
  folder path is too long to fit its row, hovering it now shows the full
  text in a tooltip. Results that fit show no tooltip.
- **Create Reference is now customizable.** A new **Create Reference**
  section in Settings → Editing controls each step of the copied excerpt:
  include or skip the heading line and shape it — bracket style, whether
  the cite appears, or a fully custom label with `%Cite%` marking where
  the cite goes; keep the original text size or choose how many points it
  shrinks by (default 3); and decide what happens to highlights — grey
  background (default), a background in the same color as the highlight,
  kept as highlights, or removed. The existing Gray-50% body text option
  moved into the same section.
- **Custom acronym letters.** The acronym commands (Alt-F10 emphasize,
  Alt-F11 highlight) can now be taught per-phrase letter selections: in
  Settings → Editing → Acronym marking, type a phrase and click the
  letters to mark — pick the w, m, and d of "weapons of mass
  destruction" and the commands mark exactly those letters, reading
  "WMD" instead of "womd". Also new: an **Underline Acronym** command
  (keybindable,
  unbound by default) completing the emphasize / highlight / underline
  trio. Inspired by shreerammodi's
  [debate-scripts](https://github.com/shreerammodi/debate-scripts) for
  Verbatim, with click-to-pick letters replacing its pattern syntax.
- **Tell background color apart from highlighting.** A new Appearance
  setting, **Distinguish background color from highlighting**, overlays
  a deliberately faint dot grid on background color. Off by default —
  the two stay visually identical, since reading as ordinary
  highlighting is the point of background color. The dots adapt to any
  fill color and both themes, and are display-only: your file,
  clipboard, and exports are untouched.

### Fixed

- **Hover polish.** The Recover Drafts pane's Save button gained a hover
  state and Open/Reopen's hover no longer renders dark-on-dark; the
  Receive pill now highlights on hover like its dropzone sibling.
- **Table cell borders vanished after editing keyboard shortcuts.**
  Changing any keybinding or macro silently broke table rendering for
  the rest of the session: every table lost its cell borders (and
  column-resize handles), while its contents stayed visible. Fixed —
  borders now survive shortcut changes. Also fixed: tables edited
  inside the Quick Cards manager never had cell borders at all.
- **Condense after Paste Text (F2) now actually condenses what you
  pasted.** Previously the automatic condense ran against the cursor
  position after the paste, so pasting outside a card — the usual way of
  bringing in a long article — condensed nothing at all, and pasting
  inside a card condensed the whole card instead of just the new text.
  It now runs on exactly the pasted range, honoring your condense
  settings (paragraph integrity, pilcrows, heading handling).

### Changed

- **"Background color" everywhere.** Settings and documentation now say
  "background color" (the Word name) instead of "shading" — e.g. the
  accessibility settings are now **Override background color in display**
  and **Show highlight & background color names in the status bar**.
  Searching the settings for "shading" still finds them. A couple of
  accessibility setting descriptions were also tightened.

## 0.1.0-beta.6 — 2026-07-02

### Added

- **Search palette: more results on demand.** The palette now shows up to
  100 results at once (up from 50), and when there are more, the last row
  tells you — click **show more**, or just keep arrowing down past the end,
  to reveal the next hundred.
- **See highlight colors by name.** A new Accessibility setting, **Show
  highlight & shading names in the status bar**, reports the stored color
  names for the text at your cursor (e.g. `Hl: Yellow`) — so a file's
  color-coding conventions are readable as text even when the hues are hard
  to tell apart. Works in the three-pane workspace too.
- **A color-vision friendly palette.** New Accessibility setting that remaps
  the colors that carry meaning — annotation accents, voice-mode dots, the
  prep timer's Aff/Neg, search-match highlights, category chips — onto a
  palette engineered to stay distinguishable under red-green and blue-yellow
  color-vision deficiencies. Works in light and dark themes, and any colors
  you've set by hand still win.
- **Word footnotes and endnotes are supported.** Opening a `.docx` now
  keeps its footnotes and endnotes (they previously disappeared on save),
  shows each as a clickable superscript number — click to read the note,
  links included, or edit it as plain text — and saving writes them back
  to Word format. Notes travel with their text when you cut, copy, or send
  cards. A new **Insert Footnote** command (unbound by default — assign a
  key under Settings → Keyboard) creates one at the cursor and opens the
  note editor immediately; the popover's Delete button (or Backspace over
  the marker) removes one.
- **Custom dash can trigger on `--`.** The custom dash setting now lets you
  choose what gets replaced — the classic `---`, or just `--` for a quicker
  dash. Backspace right after still reverts to the literal hyphens.
- **Choose what Enter creates after each structural style.** Six new
  Editing settings — one each for Pocket, Hat, Block, Tag, Analytic, and
  Undertag — control what pressing Enter at the end of that style creates:
  a normal paragraph (the default, today's behavior) or any structural
  style. Picking a style acts exactly like pressing Enter and then that
  style's key, so Tag → Tag starts a fresh card on every Enter.
- **Card sharing recipients can be reordered.** Recipient and group rows in
  Settings → Card Sharing now have up / down arrows, and the Send pill lists
  them in that order — put the targets you use most on top.
- **Optional undo / redo buttons.** A new Appearance setting, **Show undo /
  redo buttons**, adds a stacked Undo / Redo pair at the far left of the
  ribbon. Off by default — the keyboard shortcuts work either way.
- **The timer can sit on either end of the ribbon.** A new Appearance
  setting, **Timer position in the ribbon**, moves the timer panel to the
  far right if you'd rather keep the file buttons anchored on the left.
- **The timer is keyboard-drivable.** Eight new bindable commands — show/hide
  the panel, Start / Pause, start each of the three speech presets, start Aff
  or Neg prep, and Reset — all unbound by default (assign keys under Settings →
  Keyboard). Apart from show/hide, they're active only while the timer panel is
  showing.
- **"No color" is now a real pen.** Picking **No highlight** or **No
  background color** in the ribbon dropdowns now keeps "none" as your
  active color (the indicator bar turns white) — the main button,
  paintbrush mode, and F11 / Mod-F11 then erase wherever you paint, until
  you pick a color again. Standardize Highlighting / Background with the
  "no color" pen active removes every highlight or background in scope.
  Previously the "none" swatch only stripped the current selection.
- **Analytics can be italicized in the nav pane.** A new Accessibility
  toggle, **Italicize analytic entries in the nav pane**, marks Analytic
  entries by shape instead of color alone — handy under color-vision
  deficiencies, and in dark mode or the flat nav list, where the color cue
  doesn't appear at all.
- **The autosave button shows its real state by shape.** When autosave is
  on but not actually firing (a `.docx` file, or a doc that's never been
  saved), the ribbon button is now a hollow chip with a dashed outline
  instead of a filled one — so "protecting you" vs "armed but inert" no
  longer differ by color alone.
- **Fixed: first voice use now offers the model download.** On a fresh
  install, turning voice on before downloading the recognition model showed
  a dead-end error mentioning a developer environment variable instead of
  offering to download the model. It now offers the download as intended,
  and the error for genuinely broken installs says to reinstall.
- **The voice pill always names its mode.** The voice status pill now
  carries a persistent COMMAND / DICTATION / PAINT / ASLEEP badge, so the
  current mode is readable as text instead of only as the colored dot —
  previously the mode name flashed briefly and was overwritten by the next
  thing you said.
- **Annotations distinguishable by shape.** A new Accessibility toggle,
  **Distinguish annotations by underline shape**, adds a shape-coded
  underline to each kind of in-document annotation: comments dotted,
  flashcards solid, AI threads dashed, private notes double — so you can
  tell them apart even when their tint colors look alike. With the toggle
  off, annotations are also lighter-weight than before — just the tinted
  background, no underline — and the tints themselves are slightly
  stronger to compensate.
- **20 more colors are now rebindable** under Settings → Accessibility →
  Color overrides: the prep timer's Aff/Neg colors, AI comment / private
  note / AI repair accents, hyperlinks, the misspelling underline, the
  due-date dot, find-match highlights, and all ten search category chip
  colors. Useful if any of the defaults are hard to distinguish.

### Changed

- **Settings are easier to navigate.** The General, Appearance, and Editing
  tabs now group related options under section headers (Workspace, Timer,
  Document typography, Condense, …) instead of one long list, and a new
  **Files** tab collects everything about where documents go: new-document
  defaults, the Send / Read / Marked doc presets, and file search. Several
  settings also moved to more sensible homes: voice options now sit at the
  bottom of Accessibility, Timer profile and Timer durations moved to
  General, and Cite preview on hover and the Flashcards-due dot moved to
  Appearance.

- **Convert's .zip output is now compressed.** When bulk **Convert** is set
  to produce a .zip, the archive is now deflate-compressed (it was
  previously stored uncompressed), so the output is meaningfully smaller.

- **Smaller desktop installer; voice model downloads on first use.** The
  speech recognition model no longer ships inside the installer (which drops
  its size by roughly 130 MB) — the first time you turn voice control on,
  CardMirror offers to download it (~130 MB, one time) and tells you when
  it's ready, so you can keep working meanwhile. If you'll be offline, you
  can fetch it ahead of time under **Settings → Accessibility → Dictation
  model**, which is also where the optional large model lives.

### Fixed

- **Performance improvements** throughout the editor: the app itself loads
  about 40% lighter than beta.5 (faster startup on every launch, and a
  smaller download for the web edition), typing stays smooth with the Find
  bar open even in very large documents, no more brief stalls after typing
  pauses in big files, opening Settings no longer leaves the editor slightly
  slower for the rest of the session, and folder-wide **Compress** no longer
  makes the rest of the app unresponsive while it runs.
- **Three-pane: picking a slot with the mouse no longer swallows the next
  typed 1, 2, or 3.** Using the "Open into…" picker with the mouse previously
  left a hidden key handler behind that ate the next digit typed into the
  editor.
- **Dark mode: the home-screen file tools (Clean, Convert, Compress) now
  follow the dark theme** instead of rendering as light buttons on the dark
  background.
- **Hover feedback restored on several buttons that never had a visible
  one:** the per-pane open-file button and doc-stack chip in the three-pane
  workspace, the slot-picker buttons, the recovery sidebar's Done button, and
  the card-sharing receive pill.
- **Three-pane: the chip's outline and expand buttons now show their "on"
  state as a subtle box instead of turning blue.** Since outlines are open
  by default on every pane, the blue glyph read as noise rather than state;
  the box matches how the focused pane's chip already flags the same thing.

## 0.1.0-beta.5 — 2026-07-01

### Added

- **The web edition is now an installable app (PWA).** On Chrome, Edge, and
  ChromeOS you can install CardMirror straight from the browser (the address-bar
  **Install** button) and run it in its own window — and much of what used to be
  desktop-only now works there too.

  **What the installed web app can do:**

  - **Install and run offline** in its own window, and **update itself** — it
    picks up the latest version when you relaunch.
  - **Save in place.** Open a file, press Save, and it writes back to the *same*
    file (autosave works too) instead of a Save-As every time — via the browser's
    File System Access API. It asks once for permission to edit the file, and it
    won't let you open the same file in two windows at once.
  - **One-keystroke plain paste.** **Paste Text (F2)** and **Paste and
    Destructively Condense** read the clipboard directly (the browser asks once).
  - **Multiple windows.** In the installed app, **New Document** and **New Speech
    Document** open a separate window, and **Send to Speech** can reach a speech
    document open in another window. The dropzone, your Quick Cards, and the
    speech-doc designation all stay in sync across windows and tabs. The
    **Three-pane workspace** works as well — including switching between one
    window per document and three-pane — with a single three-pane window at a
    time.
  - **File tools on the home screen** — **Clean**, **Convert** (`.docx` ↔
    `.cmir`), and **Compress** — one file at a time.
  - **⌘/Ctrl-R no longer reloads** the app by accident.

  **What still requires a desktop edition:** the background **file-library search**,
  **folder-wide** clean / convert / compress, **Send to Verbatim Flow**, **voice
  control**, **card sharing**, and the native menu bar.
  Firefox and Safari don't support the File System Access API, so there Save
  falls back to a download and the file tools download their output.

- **Per-document outlines in the multi-doc workspace.** Each open document's
  outline section in the navigation rail can now be managed on its own. Click
  the **×** on a section (or the outline button in that document's title bar)
  to hide just that document's outline — the document stays open and the other
  outlines are untouched; the title-bar button brings it back. Drag the divider
  between two sections to resize them, and double-click the divider to even them
  out again. Previously the × closed the whole rail and the sections always
  split the rail evenly. The global **Show / Hide Navigation Pane** toggle now
  works together with these per-document controls: it reads "off" once every
  outline is hidden, and pressing it — or the restore pull-tab — brings them all
  back; press it again to hide them all. *Per-document outlines contributed by
  [@coralynnkc](https://github.com/coralynnkc).*

### Fixed

- **Web: less lag opening the command palette or Find bar when a password
  manager is installed.** Some browser extensions (1Password and other autofill
  tools) rescan the whole page whenever a text box gains focus, which could
  freeze the web app for a second or more on large documents every time you
  opened the search palette or Find bar. Those inputs now carry the standard
  "ignore this field" hints, so the managers are more likely to skip the scan.
  If it still lags, see the note in the
  [README](./README.md#web-app-chromebook--browser) about running the extension
  only on click. The desktop app is unaffected — it loads no extensions.

## 0.1.0-beta.4 — 2026-06-29

### Added

- **Screen reader support setting.** Settings → Accessibility → "Screen reader
  support" turns the browser accessibility tree on or off. It's **off by default**
  to avoid a crash (see Fixed below); switch it on if you use a screen reader or
  other assistive technology. The change takes effect after you restart CardMirror,
  and the setting tells you when a restart is still pending.

- **Select multiple separate ranges at once.** Hold **Ctrl** (**Cmd** on Mac)
  and drag to add another range to your selection, or Ctrl/Cmd-click to add a
  word — building a discontinuous selection across non-adjacent spots, like Word.
  You can **copy** the whole set, and run any formatting that already works on a
  Select Similar selection (highlight, underline, emphasis, cite, colors, shrink,
  clear formatting, …) across all the pieces in one go. The set shows in the
  selection color; Escape or a plain click clears it, and any edit ends it.

### Fixed

- **White screen and lost work when an accessibility tool was running.** On some
  machines with a screen reader, Windows Voice Access, or similar assistive
  technology active, CardMirror could crash — the editor turned solid white and
  unsaved work was lost. The cause is a bug in the underlying browser engine
  (Chromium) while it builds accessibility data for heavily-highlighted cards.
  CardMirror now keeps that accessibility data off by default, which avoids the
  crash; re-enable it under Settings → Accessibility if you rely on a screen
  reader.

## 0.1.0-beta.3 — 2026-06-29

### Added

- **Custom dash autoformat.** Settings → Editing → "Custom dash" turns a typed
  `---` into an en or em dash (with or without surrounding spaces) the moment you
  type the third hyphen. Press Backspace right after to revert to the literal
  `---`. Off by default.

- **Custom filename prefixes for preset saves.** Settings → General now lets you
  change the **Send Doc / Read Doc / Marked Doc** filename prefixes (defaults
  `SEND_` / `READ_` / `MARKED_`; leave one empty for no prefix). They apply to
  both the Save As preset buttons and the silent Save Send Doc / Save Marked
  Cards commands, gated on the existing "Prefix preset saves" toggle.

- **Paste and Destructively Condense (desktop).** A command that pastes the
  clipboard's plain text and immediately condenses just what you pasted, merging
  its paragraphs (paragraph integrity off, destructive) — the result of an F2
  paste followed by Alt-F3 over the pasted text. Unbound by default (bind it
  under Settings → Keybindings). Desktop only — the web build can't read the
  clipboard.

- **Save Marked Cards.** Pull out just the cards you've placed a reading marker
  in and save them on their own, in your chosen format. Two ways in: a **"Marked
  Doc"** button in the Save As dialog, and a **Save Marked Cards** command
  (default **Mod-Alt-M**, rebindable) that saves silently to a configurable
  destination — Settings → *Marked Cards destination* (same folder / fixed
  folder), with the `MARKED_` filename prefix and your default format — mirroring
  Save Send Doc. Cards only (analytics and headings are dropped); if nothing is
  marked it does nothing and says so.

- **Smart quotes (optional).** Turn on Settings → Editing → "Smart quotes" and a
  straight `'` or `"` you type curls to the right direction by context — opening
  after a space, dash, bracket, or start of line; closing (and the apostrophe)
  otherwise — so `don't` and `(he said "hi")` come out right. Press Backspace
  immediately after a curl to revert it to the straight character. Off by default.

- **New "Flip Quote Direction" command.** Bindable (unbound by default); with a
  selection it flips every curly quote to its opposite direction (left ↔ right),
  preserving formatting — the manual fix for cases like `'tis` or `'90s` that
  smart quotes (like Word) guess wrong.

- **Edit the timer's prep clocks directly.** When an Aff/Neg prep clock is loaded
  and paused, click the big display to type a new time — handy if you started or
  stopped prep a beat late. The edit saves to that side's prep balance, so it
  sticks when you switch to another clock and back (until you Reset).

- **The timer shows which prep clock is loaded.** The Aff/Neg "differentiate by"
  setting (color / text / both) now also styles the big display when a prep clock
  is showing — so it's clear at a glance that the time is prep, and which side.

- **New "Cycle Timer Preset" command.** Bindable (unbound by default — set it
  under Settings → Keybindings); it cycles the timer profile College → High
  School → Pomodoro, applies that profile's durations, and surfaces the timer.

- **Controls for formatting-gap bridging.** When you format a word next to an
  already-formatted word, the editor bridges the small gap between them so the
  styling is continuous. Two new Editing settings govern this: a toggle to turn
  the automatic bridging on or off (the manual "Fix Formatting Gaps" command is
  unaffected), and a choice of which gaps get bridged — **whitespace and
  punctuation** (default) or **whitespace only**. Bridging also no longer happens
  inside structural paragraphs (tags, analytics, headings, undertags) — only in
  body text — so a selection spanning both bridges in its body paragraphs and
  leaves its structural lines alone.

- **Open a file by dragging it into the window.** Drag a `.docx`, `.cmir`, or
  `.cmir-journal` from your file manager onto any CardMirror window — the editor,
  the navigation pane, or the home screen — to open it, the same as File → Open
  (including the unsaved-changes prompt, and focusing an already-open copy).
  Desktop only; other file types are ignored, and dragging cards around the
  editor is unaffected.

- **Move a card or section up/down in the outline.** New **Move Container Up** /
  **Move Container Down** commands (default **⌘/Ctrl-Alt-↑ / ↓**) grab the
  cursor's smallest enclosing outline item — a card / analytic unit, or a heading
  and its whole section — and move it one spot among same-level items in the
  navigation pane. Cards reorder among cards, blocks among blocks, and so on;
  moving past the edge of a section flows into the adjacent one. Rebindable in
  Settings (listed under Editing utilities).

### Changed

- **The command bar and settings search find more by synonym.** "fix", "repair",
  and "restore" now find each other (e.g. "restore" surfaces the Repair commands),
  as do "delete" and "remove" ("remove" finds the Delete Row / Column / Table
  commands). "add" and "insert" find the same element commands — "add table",
  "add row" / "add column", "add image", or "add received card" surface the
  corresponding Insert command, and vice versa (the create-type commands — Add
  Quick Card, Add Comment, Add Note — are intentionally left out, since they make
  something new rather than placing it). And "timer profile" and "timer preset"
  are interchangeable, each finding the Cycle Timer Preset command and the Timer
  profile setting.

- **Repair Paragraph Integrity: Ctrl-Enter can mark an already-broken paragraph
  for indent.** When the phrase already starts its paragraph, plain Enter still
  does nothing (no break is needed), but Ctrl-Enter now marks that paragraph for
  indent-on-exit — so a card's first body paragraph, which can't be split, can
  still be marked to indent.

- **AI operations now also lock styling and marks in the passage they're working
  on.** While an AI operation runs on a passage, the editor already refused typed
  edits there; it now also refuses style and mark changes (highlight, underline,
  font size, named styles, etc.) to that passage, so the operation's content
  can't shift under it mid-run.

- **Document zoom is now per-editor, not global.** Body-text zoom (the zoom
  buttons, Ctrl-= / Ctrl--, pinch / Ctrl-scroll) now applies only to the editor
  you're in — zoom one document in while another stays zoomed out, including
  independently per pane in the three-pane workspace. It no longer syncs across
  windows or persists; instead, documents open at a configurable default
  (Accessibility → "Default document zoom", 100% by default) and reset to it on
  reload. Chrome scale (Mod-Alt-=) is unchanged and still scales the whole window
  uniformly across windows.

- **Find and Paragraph Integrity match across dashes and ellipses.** Searching
  (or typing a paragraph-start phrase) now treats every kind of dash — hyphen,
  en-dash, em-dash, minus sign, and the rest of Unicode's dash family — as
  interchangeable, and treats an ASCII `...` and the single `…` character as the
  same. This joins the existing curly-vs-straight quote matching, so text pasted
  from Word matches whether you type the fancy character or the plain one. (The
  invisible soft hyphen is left as-is.)

- **Timer durations are capped at 99 minutes** in settings (speech presets and
  prep), up to which any value is allowed.

- **Saving a quick card now captures whole cards and sections.** Add Quick Card
  used to save exactly your raw selection — which could be half a card or a stray
  fragment. It now snaps the selection to the whole cards/sections it covers
  (re-highlighting them so you see what's saved), and you can save with no
  selection at all — it captures the card or section your cursor is in. This
  matches how sending to the dropzone, a starred recipient, or the speech doc
  already works.

- **Deleting a quick card now uses a two-click confirm instead of a popup.** The
  Delete buttons in the Quick Cards manager (both per-card and bulk) arm on the
  first click ("Delete?") and delete on a second click within a few seconds —
  matching the flashcard manager, and replacing a confirmation dialog that didn't
  fire reliably in the desktop app.

- **Quick card buttons are now hidden by default, behind a setting.** The Quick
  Cards ribbon cluster (command bar, tag picker, manage, add) is off by default —
  turn on Settings → Editing → "Show quick card buttons" to show it, mirroring
  the dropzone shelf toggle. Quick cards still work while hidden, and the command
  bar still opens with its keyboard shortcut.

- **Re-pressing a structural style now consistently resets indent, font size, and
  font color.** Pressing a Pocket / Hat / Block / Tag / Analytic / Undertag
  shortcut on text that's already that style resets it toward the style's
  canonical look — clearing the paragraph indent, any direct font-size override,
  and any direct font-color override — while leaving line spacing alone.
  Previously this was inconsistent: tags and analytics didn't clear indent,
  undertags didn't clear font size, and none cleared font color.

### Fixed

- **Nav pane no longer flickers while typing just above a heading.** Typing on
  the bottom-most line directly above a heading used to make the outline's
  highlight briefly jump to the next heading and snap back. The nav pane now
  keeps its cached heading positions in sync with every edit, so the
  active-heading highlight stays put (this also fixes the same brief staleness
  for nav click-to-jump).

- **Silent Send/Marked Doc saves won't overwrite the original document.** The
  Save Send Doc / Save Marked Cards commands now refuse to clobber the source
  file when the export would land on its exact path (e.g. an empty prefix at the
  same folder and format) — in fixed-folder mode as well as same-folder mode —
  falling back to the Save As dialog so you can rename. (More reachable now that
  the prefix is customizable.)

- **The bottom scroll runway now accounts for the send/receive pills.** The
  extra space that lets the last line of a document clear the bottom-left shelf
  was only added when the dropzone pill was showing. With pairing enabled but the
  dropzone pill hidden, the send/receive pills sat in that same band yet the
  runway was missing, so the last line clipped behind them. It now appears
  whenever any tray pill is showing — in both single-pane and multi-pane.

- **Timer duration fields no longer lose focus while typing.** In the timer
  durations settings, the field used to deselect after a single digit, so you
  couldn't type a two-digit value like "10" without it jumping away. It now stays
  focused as you type.

- **Timer prep buttons no longer crowd the label at 10:00.** In the text / both
  prep-label modes, the "A:" / "N:" prefix had too little room next to a 4-digit
  time; the buttons now have a bit more horizontal padding.

- **Open .cmir files on iPhone / iPad (web).** On iOS the file picker greyed out
  `.cmir` / `.cmir-journal` files — the browser can't map their custom extension
  to a recognized type — so you couldn't select them. The web open picker now
  lets you choose any file on iOS (the format is still checked after you pick);
  other browsers keep the type filter.

- **Escape now exits the Repair Paragraph Integrity workflow from anywhere.**
  Escape previously only worked while the workflow's input box was focused — once
  you clicked back into the card there was no obvious way out. It now exits the
  workflow regardless of focus, while still deferring to anything layered on top
  that should close first (a modal dialog, or the command bar).

- **Repair Paragraph Integrity: undo works inside the workflow.** Ctrl/Cmd-Z now
  undoes the most recent action without leaving the workflow — re-merging the
  last paragraph break and/or removing its deferred indent mark. Previously it
  did nothing (the bar's input swallowed it). It won't reach back into edits made
  before the workflow opened, and defers to a modal or the command bar layered on
  top.

- **The navigation pane now follows the cursor in three-pane mode.** Clicking or
  moving the cursor in a document highlights the heading it lands in in the nav
  pane — that already worked in single-pane view, and now works in each pane of
  the multi-pane workspace too (each pane tracks its own cursor), including right
  after a pane opens and after structural edits like moving a card.

- **Ctrl/Cmd+A no longer selects the whole interface.** When CardMirror was
  focused but you hadn't clicked into the document (e.g. just after alt-tabbing
  back), Ctrl/Cmd+A selected the entire GUI. It now selects everything within
  whatever text box you're in — the editor, a settings field — and does nothing
  when focus isn't in a text box, rather than selecting the chrome.

- **Pasting over a selection inside a card no longer breaks the card.** Pasting a
  cite, body, or undertag copied from inside a card on top of selected text in a
  card used to tear the card apart — detaching its tag and leaving a stray
  empty-tag card behind. The paste now replaces the selected text and fits the
  content into the card with its structure intact. Pasting a tag, analytic,
  heading, or whole card over a selection still starts a new card, as before.

- **Analytics no longer sit inside cards.** An analytic that ended up tucked
  inside a card — from an older document, or a Word file where an analytic line
  was placed under a tag — now becomes its own analytic unit (taking the content
  below it with it), exactly as pasting an analytic into a card already does.
  This removes a class of glitches where editing around such an analytic (e.g.
  backspacing at its start) could fold it into the tag or scramble the card.
  Existing files are repaired automatically when opened.

- **Inserting a saved card no longer splits the card you're in.** Clicking a
  card on the dropzone shelf, inserting a quick card, or inserting a card a
  partner sent you used to drop it at the exact cursor — splitting the
  surrounding card and leaving a broken, stray card behind (with a "insert into
  the middle of text?" prompt to warn you). It now
  lands as a clean separate card just above or below the one you're in, the same
  as dragging it there would. The mid-text confirmation prompt — and its "Skip
  mid-text confirm" setting — are gone.

- **Sending to the dropzone, a starred recipient, or the speech doc snaps your
  selection to whole cards and sections.** You could previously send an arbitrary
  selection — half a card, a stray paragraph — which arrived broken on the other
  side. Now the selection is rounded to the whole cards/sections it covers and
  re-highlighted so you see exactly what's sent: a partial card grows to the whole
  card, a card you only grazed is dropped, an intro paragraph comes along (with
  its heading) only if you selected most of it, and a selection with nothing
  structural in it sends nothing. Putting your cursor in a card or heading with no
  selection still sends that whole card/section, as before.

- **Pasting body text together with a heading or card no longer breaks the card.**
  Copying a paragraph along with a following heading (or a whole card) and pasting
  it into the middle of a card used to split the card and leave a broken, stray
  card behind. Now the body text merges into the card, the heading/card starts its
  own section, and the rest of the card you pasted into follows under it — the
  same way pasting a heading on its own already behaved.

- **Tagging content that includes a table now wraps the whole card.** When you
  put a tag on a run of paragraphs (with a cite and a table) to turn it into a
  card, the card used to stop at the table, leaving the table and everything
  after it stranded outside. Tables are now pulled into the card along with the
  rest, so the card covers the whole thing.

- **Dissolving a blank-tag card no longer leaves card-body-styled text loose.**
  In the edge case where a card with an empty tag is removed (Backspace at the
  start of the blank tag) and its body moves out to the document, the body now
  becomes a normal paragraph instead of keeping card-body styling with no card
  around it. (A cite stays a cite — it's a valid loose node.)

- **Repair Paragraph's deferred indents stay inside the card you're working on.**
  The Repair Paragraph workflow's indent-on-exit can now only ever apply inside
  the card it was opened on, never spill into a neighboring card.

- **A card made with the "new card" voice command is now tracked in the nav
  pane.** Such a card used to get a tag with no internal id, making it invisible
  to the navigation pane and the outline level filter until the next save. It now
  gets a real id like every other card.

- **Home screen number shortcuts no longer fire over a dialog or the command
  bar.** The 1–9 shortcuts on the home screen used to trigger even when a dialog
  or the command bar was open on top of it — running the wrong action and eating
  the number you were trying to type. They now stand down whenever a modal is up
  or a text field is focused.

- **Highlighting or underlining part of a ligature no longer decorates the whole
  ligature.** With a ligature font, applying highlight, shading, underline, or
  emphasis to only some characters of a ligature (like the "fi" in "find") used
  to paint the entire joined glyph. The ligature now splits at the formatting
  boundary, so only the marked characters are decorated. (As a result,
  highlighted / underlined text no longer forms ligatures.)

## 0.1.0-beta.2 — 2026-06-25

### Added

- **Rebindable "next / previous document" shortcuts for three-pane mode.** Two
  new commands — *Next Document in Slot* and *Previous Document in Slot* —
  single-press cycle through the documents stacked in the focused pane. They're
  unbound by default; assign keys under Settings → Keyboard shortcuts (the
  existing Ctrl+Tab hold-to-cycle is unchanged).

- **Missing fonts now have bundled open-source stand-ins.** When a document uses
  a font you don't have installed — Calibri, Cambria, Times New Roman, Arial,
  Georgia, Helvetica, Comic Sans MS, Verdana, Tahoma (plus Liberation, DejaVu,
  and Noto) — CardMirror now ships a metric-compatible open-source equivalent
  (Calibri→Carlito, Cambria→Caladea, Times New Roman→Tinos, Arial→Arimo,
  Georgia→Gelasio, and so on), so the text renders the way it should instead of
  falling back to a generic. If you *do* have the real font, you still get it —
  the bundled copy is only a fallback, and your real bold/italic still apply.

- **Open recovery journals (`.cmir-journal`) directly.** File → Open now accepts
  `.cmir-journal` files — it loads the document the journal was protecting, as a
  recovered, *unsaved* copy (so saving won't overwrite the original; use Save As
  to keep it somewhere). Handy for pulling a document out of a recovery journal
  without waiting for the automatic crash-recovery prompt.

### Changed

- **"one" / "two" / "three" find the slot commands in the command bar.** Typing a
  spelled-out number in Search Everything now surfaces that slot's Focus-Slot and
  Send-to-Slot commands.

- **"Check for updates on launch" is now "Check for updates automatically" — and
  it also checks daily.** With it enabled, the desktop app checks for updates at
  launch and once every 24 hours while it's running, staying silent and only
  surfacing a prompt when an update is actually available.

- **Mod-R no longer reloads the desktop app by accident.** A stray Mod-R mid-edit
  used to reload the whole window, which felt like a crash. Reload now lives only
  in the View menu; the Mod-Shift-R force-reload shortcut — far harder to hit by
  accident — still works.

- **The command-bar button's tooltip now reads "Toggle command bar"** (it used to
  say "Search quick cards").

- **Nav-pane headings no longer pop a tooltip on hover.** Each outline row used to
  show a redundant "Pocket" / "Card" / etc. type label when you moused over it;
  it's gone.

### Fixed

- **Severe: pasting between cards could detach a card from its tag and silently
  strip a cite — please update.** Copying a cite, body paragraph, or undertag and
  pasting it into another card could split that card away from its tag: the card
  became impossible to select or drag (only the tag moved), and the gray body rail
  no longer reached the tag. Cards left in this broken state behaved erratically —
  among other things they refused a variety of edits that should have been
  legitimate (for instance, pressing Enter to add a new line could silently do
  nothing). In some cases a pasted cite was also quietly demoted to plain body
  text, losing its cite formatting with no visible warning. And
  pasting card content *outside* a card left behind a stray empty card. All of it
  is fixed — pasted content now lands cleanly at your cursor, keeps its own kind
  (cites stay cites, undertags stay undertags, body stays body), and never breaks
  the card. **This was a severe bug, so anyone still on 0.1.0-beta.1 should update
  to this release.**

- **Toggling three-pane mode no longer drops Word (.docx) documents.** Switching
  in or out of three-pane mode reloads each open document from its recovered
  in-memory content; for a document that came from a `.docx`, that content was
  being handed to the Word importer and rejected ("Can't find end of central
  directory"), so the document vanished on the toggle. Recovery content is always
  kept in CardMirror's own lossless format regardless of a document's saved-as
  type, so loading now detects the format from the content itself rather than
  trusting the saved-as label — a docx document still *saves* back as docx. (The
  same fix lets you open a `.cmir-journal` belonging to a docx-saved document, and
  covers the three-pane slot loader. The crash-recovery prompt was never affected.)

- **The "Layout on this device" setting (web edition) now matches the others.**
  Its Auto / Mobile / Desktop options were showing as a cramped, unstyled stack —
  their CSS classes had never been defined — so they now use the same tidy column
  styling as every other radio setting.

- **Toolbar tooltips are reliable in the desktop app now.** On the Mac desktop
  build the ribbon tooltips were erratic — slow, flickery, or simply not appearing
  — because they relied on the operating system's native tooltip, which Electron
  renders unreliably on macOS (the web build, in a real browser, was always fine).
  They're now drawn by CardMirror itself, so they behave identically and show up
  reliably on both desktop and web. The same fix covers the other hover tooltips
  that had the problem — find & replace, the comments panel, the dropzone, the
  command-bar controls, and the speech-document buttons.

## 0.1.0-beta.1 — 2026-06-24

### Changed

- **Right-click a file in search to dive into it.** In the Search Everything
  palette's file search (the `f` prefix), right-clicking a file now dives
  into it to search its contents — the same as pressing **Tab** — instead of
  pinning it. Pinning still has its own ★ star (and **Alt-P**), so the
  right-click is free for the more useful action.

- **Clod customization is a normal setting now.** The Clod persona editor — its
  name and pronouns, your own activity phrases per time of day, and when those
  time periods begin — used to be hidden behind a secret modifier-click on the
  **Enable Clod mode** toggle. It's now a visible **Customize…** button right
  below that toggle in Settings → Comments & AI.

- **Analytics and undertags get their own categories in Find.** In the
  categorized results list they used to lump in with body text under "Other";
  now they're their own **Analytic** and **Undertag** groups — colored to match
  the editor — ordered right after Tags (analytics, then undertags, then cites).
  Reorder them like the other categories under Settings → Find.

### Fixed

- **Escape leaves a dived-into file even when the search box isn't focused.**
  In the Search Everything palette, after diving into a file, pressing **Esc**
  while scrolling the results (with the box unfocused) now steps back to the
  file list instead of doing nothing — and re-focuses the search box on the
  way back.

- **Bottom pills no longer cover your text in three-pane mode.** In single-pane,
  CardMirror leaves a little space at the end of the document so the dropzone /
  send / receive pills don't sit over the last lines when you scroll to the
  bottom. Three-pane mode never did — the leftmost pane (the one the pills sit
  over) now gets the same runway, while the other panes stay flush.

- **Highlighting no longer turns an underlined gap into emphasis.** When two
  emphasized words are joined by an underlined space (the read-aloud marker),
  highlighting either word used to rewrite that underline to emphasis. Highlight,
  shading, and font-size changes now leave underline / emphasis / cite alone —
  they only tidy their own formatting.

- **Hyphens are no longer swept into formatting gaps.** When you underline,
  emphasize, or cite two words joined by a hyphen (e.g. `well-known`), the hyphen
  between them is now left as-is instead of being pulled into the formatting —
  matching how em-dashes, en-dashes, `=`, and `+` already behave.

- **Docs whose tags are plain "Normal" text now import with their structure.**
  Some Word docs mark tags and headings only with an *outline level* (Word's
  h1–h4), not a heading style — so CardMirror imported them as flat body text and
  the tags didn't show up. The importer now recognizes a Normal paragraph that
  carries an outline level plus the matching heading formatting (e.g. a 13pt-bold
  paragraph at outline level 4 → Tag), mirroring what the style cleaner already
  does. The bold / size / underline checks gate it, so an ordinary non-debate doc
  that merely uses outline levels is unaffected.

- **Find stays fast on large documents with many matches.** Stepping between
  results — next/previous, or clicking a result — used to rebuild every
  highlight, the whole results list, and all the nav-pane markers on each step,
  which crawled once a search had thousands of hits. Now only the active match
  moves per step, so navigation stays quick no matter the match count. Find also
  caps at 10,000 matches (shown as `10000+`) and 500 listed rows ("Showing first
  500 of … — refine to narrow"), and rapid jumps no longer pile up scrolling
  work — so a pathological search can't choke the editor.

- **The command bar's first search is ready sooner after launch.** The search
  palette pre-warms its file index in the background, but that warm only kicked
  off once the app first went idle (up to ~2s after launch) — so opening the bar
  right after launching beat it and the first search hit a cold scan. The
  file-list scan (which runs in the background process) now starts the moment the
  app boots, while the heavier content pre-parse stays deferred so it still never
  janks the launch.

## 0.1.0-alpha.20 — 2026-06-23

### Added

- **Benchmark — measure how fast CardMirror runs on your machine.** A new button
  in Settings → General runs a battery of real in-editor operations on the open
  document — continuous scrolling, jumping between headings, and a full
  card-cutting sequence (type and mark a cite, paste a messy multi-paragraph
  card, condense it clean, then underline / emphasis / highlight and shrink) —
  while sampling frame rate, frame-time percentiles (including a 1%-low that
  captures stutter), and per-operation latency. It shows a scrollable readout
  with a scroll-frame-time graph, footnoted metrics, and an overall score. The
  whole run happens on a snapshot of your document and is fully reverted when you
  close the results, so it never touches your file — and it only runs when the
  document is editable (not in read mode).

- **Keyboard shortcuts to drop in a received card.** Two new rebindable shortcuts
  insert the most-recently-received card (from the **Receive** pill) without
  reaching for the mouse: **Mod-P** places it at the cursor, and **Mod-Alt-P**
  appends it at the end of the document. The card stays in the Receive pill, so
  you can place it again. Rebind them under Settings → Keyboard shortcuts, in the
  **Dropzone / Send and Receive Cards** group.

- **Star a recipient and send to them in one keystroke.** In Settings → Card
  Sharing you can now **star** one recipient or group. A new **Send to Starred**
  command then sends the card under your cursor (or the current selection)
  straight to that starred target — like Send to Dropzone, but to a person. It
  ships without a default key; assign one under Settings → Keyboard shortcuts (in
  the **Dropzone / Send and Receive Cards** group). Starring a target un-stars any
  other, and the star clears itself if you remove that recipient or group.

- **Type "question" to find Ask AI.** The command bar now surfaces **Ask AI About
  Selection** when you search for "question".

- **Clean can save over your originals (with a typed confirmation).** Clean used
  to always write `cleaned_…` copies. A new **"Prepend 'cleaned_' to output
  filenames"** toggle (on by default) lets you turn that off and save with the
  original filenames instead — and when the destination is the originals' own
  folder, that overwrites them in place. Because that's destructive and can't be
  undone, hitting Clean in that mode first pops a warning you must confirm by
  typing "I accept the risk". Prepending, or saving to a different folder, never
  touches your originals and skips the warning.

- **A User Manual link in Settings.** Settings → General now has a link to the
  user manual at the bottom, so it's easy to find (and stays reachable on Windows
  and Linux, where the native menu bar — which used to hold the link — is gone).

### Fixed

- **Alt-key shortcuts work on Windows and Linux.** The native menu bar reserved
  `Alt`+letter for its menus, so an editor command bound to a bare `Alt` chord
  (for example `Alt+A`) did nothing — the menu swallowed it before the editor saw
  it. CardMirror no longer shows a native menu bar on Windows and Linux (every
  menu command's keyboard shortcut still works, and the menu's actions are
  reachable from the app's own UI), so `Alt`-key shortcuts — including ones you
  rebind yourself — now work like the rest. macOS keeps its menu bar.

- **Clean handles a whole messy library without choking.** Cleaning a large
  folder no longer trips over Word lock files (`~$…`), macOS `._…` sidecars, or
  `__MACOSX` folders — those aren't real documents, so they're skipped — nor over
  certain docs that previously errored with an internal "no style named
  Heading…" message. Genuinely corrupt or empty files (e.g. cloud "conflicted
  copy" duplicates) are now reported as **skipped (not a valid .docx)** rather
  than counted as failures, so the summary reflects what actually happened.

- **Paragraph-spacing boxes match the other Appearance number fields.** Their
  inputs were using the browser-default border with left-aligned numbers; they
  now use the same border and right-aligned layout as every other number box in
  settings.

- **Deleting your last note or flashcard clears its anchor highlight.** Deleting
  the last private note, flashcard, or AI thread in a document used to leave the
  blue highlight marking where it was anchored painted on the text until you
  toggled the comments pane off. It now disappears immediately with the
  annotation, like it already did when other annotations remained.

- **Create-flashcard dialog buttons are now a matched pair.** The Cancel button
  in the "create flashcard from selection" dialog was noticeably smaller than
  Create; it now matches the manage screen's New card / Import / Export buttons,
  so the two sit the same size side by side.

- **Send and Receive pills match the dropzone.** The card-sharing **Send** and
  **Receive** pills were a solid gray that stood out next to the dropzone pill;
  they now share the dropzone bar's softer color scheme, so the three read as one
  family.

## 0.1.0-alpha.19 — 2026-06-22

### Added

- **Clean — a .docx style cleaner that cures "stylepox."** A new Home-screen
  utility (desktop) that fixes the junk-style buildup debate files accumulate
  from copy-pasting cards: it removes the redundant/malformed styles bloating the
  file, converts stray direct formatting (manual bold/underline/highlight) back
  into the right styles, restores Verbatim's style names and aliases so macros
  work, and strips hyperlinks. Run it on a single file or a whole folder; leave
  the destination blank to write each `cleaned_…` copy next to its original. A
  progress bar tracks each file, and a gear lets you mark **protected styles**
  Clean must never touch (by name; add them manually or pick from a template
  `.docx`). It's the same idea as the
  ["Curing Stylepox"](https://debate-decoded.ghost.io/leveling-up-your-debate-software-3-curing-stylepox/)
  cleaner, but it runs inside CardMirror, so it's **much faster** (seconds, not
  the overnight runs the worst files used to need) and has **far better handling
  of old files** — it rebuilds the common pre-Verbatim style conventions
  (Tags/Cards/Cites/Block Headings, Author-Date, Debate Underline, …) into the
  modern Verbatim structure, adds the standard styles when a document is missing
  them, and repairs `!!`-marked style names that trip up older cleaners. Coverage
  is broad but not universal — unusual or one-off style schemes may still not be
  fully handled.

- **Many old debate files open with their structure intact.** Opening a
  pre-Verbatim `.docx` that uses the common Tags/Cards/Cites/Block Headings style
  family now reconstructs cards, tags, cites, and headings instead of importing
  it as flat, unstyled text. (Coverage is broad but not universal — unusual or
  one-off style schemes may still come in as plain text.)

### Changed

- **File search can use multiple folders.** Settings → General's "File search
  folder" is now "File search folders" — add as many as you like. Each is
  scanned recursively; overlapping or nested folders are fine, since a file
  found under more than one is searched only once. Your existing folder is
  carried over automatically.

- **Read mode allows safe drag edits.** While reading, you can now drag cards to
  reorder them and drag into / out of the dropzone and the send/receive pills —
  moves the drag handles already validate — while ordinary typing edits stay
  locked to prevent accidents. Clicking a dropzone or received-card item in read
  mode appends it to the **bottom** of the document instead of at the cursor.

- **Card sharing works across CardMirror versions.** Sending a card to a machine
  on a different version no longer fails with a version-mismatch warning —
  cross-version transfers are now accepted by default. (A card can still carry a
  minimum-version requirement, so a future release that changes the card format
  could ask older versions to update first, but by default sharing just works.
  Both machines need this version or newer to get the tolerant behavior.)

### Fixed

- **Windows/Linux: the editor could lock up after a pop-up.** Pressing `` ` `` to
  send to the speech document when none is open — and a few similar cases (e.g.
  image-insert errors) — showed a warning that took keyboard focus; on
  Windows/Linux that focus wasn't returned, so the editor wouldn't accept edits
  until you clicked back into it. Focus is now reclaimed automatically. macOS was
  unaffected.

- **Drag auto-scroll works in more places.** Dragging a card toward the top or
  bottom edge now scrolls the pane under the pointer — including when dragging
  between panes or from the nav panel into the editor — and correctly scrolls
  past a pane's sticky nav header. It also no longer scrolls the document out
  from under you when you drag toward the bottom-left dropzone/send/receive
  pills.

- **More citations survive import.** Files whose cite style is stored under the
  legacy `Cite` name (rather than the modern `Style13ptBold`) now import as
  citations instead of plain text.

## 0.1.0-alpha.18 — 2026-06-21

### Added

- **Cross-machine card sharing (end-to-end encrypted).** Two new pills sit next
  to the dropzone — **Send** and **Receive**. Drag a card onto Send and it
  expands to the machines you've added (plus any groups); drop on one to send it
  there. Cards others send you land in **Receive**, which shows who they're from
  and when, flashes on arrival, and tracks an unread count. Set it up in
  **Settings → Card Sharing**: turn it on, share your code, add recipients by
  their code (name them however you like), and optionally group several
  recipients for one-drop sends. Everything is end-to-end encrypted — the relay
  server only ever sees opaque ciphertext, never your cards, who sent them, or to
  whom — and cards are deleted from the server after 3 hours. Desktop only.
  (The feature was conceived and prototyped by
  [Q Cooper](https://github.com/mosuqc) of Missouri State University —
  his proof-of-concept demonstrated the cross-machine send-and-receive
  flow this built-in version is based on.)

## 0.1.0-alpha.17 — 2026-06-20

### Added

- **Repair Paragraph Integrity workflow.** A focused way to re-introduce
  paragraph breaks into a card whose body collapsed into one run. Run it with
  your cursor in a card (or the card selected) and a small bar opens, with a
  green box around the card it's operating on. Type a phrase that should begin a
  paragraph; every occurrence in the card's body is highlighted in green. When
  exactly one match remains, the bar flashes green with a check — press Enter to
  insert a paragraph break right before that phrase and clear the box for the
  next one. **Ctrl-Enter** does the same but also marks that paragraph to be
  indented (shown with a green bar in the left margin); the indent is applied when
  you exit, to whatever that paragraph has become by then — so further splits
  inside it don't drag the indent across the rest of the card. Esc applies any
  pending indents and exits. The command (*Repair Paragraph Integrity*) ships
  unbound; assign a shortcut in Settings → Keybindings.

### Fixed

- **Find and the paragraph-repair search now match straight and curly quotes
  interchangeably.** Typing a straight `'` or `"` matches Word's smart quotes
  (`‘ ’ “ ”`) in the document, and vice versa — so searching `court's` finds
  `court’s` and `"clear"` finds `“clear”`.

- **Highlighting emphasized text no longer breaks the emphasis at the edges.**
  Toggling highlight (or shading, or a font-size change) over a run of
  emphasized text left underlined gaps where the highlighted span met its
  emphasized neighbors. Filling an emphasized gap with underline is now
  reserved for when you actually apply emphasis or underline; unrelated
  formatting leaves the emphasis intact.

- **Re-emphasizing part of an already-emphasized phrase no longer breaks it.**
  Pressing Emphasis on a word (or words) inside a continuously-emphasized run
  used to underline the gaps at the edges of what you selected. Emphasis now
  fills a gap with underline only where it joins two *separately*-emphasized
  words; a gap that's already emphasized stays emphasized, so a continuous
  phrase stays continuous.

- **Selecting trailing/leading punctuation now formats it.** If you select a
  word together with an adjacent punctuation mark — e.g. `government.` with the
  period, or `(government` with the paren — and apply a style, the punctuation
  now takes the style instead of being treated as part of the gap and left
  unformatted. Spaces still behave as before: selecting `government. ` with the
  trailing space underlines the period but not the space. Punctuation you didn't
  select still bridges normally between two formatted words.

- **Pasting a card, analytic, or heading into a card keeps its structure.**
  Pasting content that leads with a tag, analytic, or a Pocket/Hat/Block heading
  into a card — including dropping a whole copied card at the end of another —
  used to demote the heading into ordinary body text and absorb the content into
  the destination card. Now the pasted structure wins: the destination card
  splits at the cursor and the pasted card/analytic/heading lands intact, with
  its full content, as its own structural block.

### Changed

- **"Fix" and "repair" now match each other in the command bar.** Commands
  whose names contain one of those words — *Repair OCR/PDF Text*, *Repair
  Formatting (AI)*, *Fix Formatting Gaps* — are reachable by searching for
  either word. Typing "fix" surfaces the Repair commands, and "repair"
  surfaces Fix Formatting Gaps.

## 0.1.0-alpha.16 — 2026-06-17

### Added

- **The command bar's file search now finds `.docx` files too.** Searching
  files (the `f ` prefix, or the everything-search) lists both `.cmir` and
  `.docx` documents. Each result's badge shows its format — `CMIR` or `DOCX` —
  and the file name is shown without its extension. `.docx` and `.cmir` behave
  identically: press Enter to open either, or Tab to dive into either and
  search its contents (blocks, tags, cites) and insert from it. A new
  **Settings → General → File search: file formats to list** option restricts
  results to just `.cmir`, just `.docx`, or both (the default).

### Changed

- **Edge gaps between separately-emphasized words now fill with underline.**
  When you emphasize text, the whitespace and punctuation inside your selection
  stay emphasized along with the words — selecting a phrase and emphasizing it
  behaves as you'd expect. Only at the edges, where your emphasized selection
  butts up against an already-emphasized neighbor word, the connecting gap is
  joined with plain underline instead of emphasis. Emphasis already shows as an
  underline, so the join stays visually seamless while the extra emphasis
  styling stays on the words themselves.

- **Smarter recognition of analytics on import.** Files made from other
  templates often label their analytics with a style that isn't the one
  CardMirror writes, so those lines used to come in as plain body text. Import
  now also recognizes them: a style named (or whose id is) "Analytic Real"
  comes in as an analytic, and any paragraph style whose name or id contains
  the word "analytic" is treated as an analytic too.

### Fixed

- **Formatting punctuation directly is now honored.** When you select only
  whitespace and apply a style, the gap cleanup leaves it alone — it assumes
  you meant it. That now also holds for punctuation and for punctuation-plus-
  space selections: if what you selected has no actual word in it, the style
  you apply to it stays put instead of being cleaned away.

- **The outline pane is now resizable in multi-pane mode.** Dragging the
  outline's right edge to set its width already worked with a single document
  open; with two or three documents open side by side the drag handle was
  missing. The shared rail on the left now has its own drag handle, and the
  width it sets is the same one single-pane mode uses, so it carries over
  between the two layouts.

## 0.1.0-alpha.15 — 2026-06-17

### Added

- **Bulk re-apply and replace of structural styles across a "select all of this
  style" selection.** Right-click a structural ribbon button (Tag, Analytic,
  Undertag, or a Pocket/Hat/Block heading) to select every block of that style,
  then left-click a structural button to act on all of them at once:
  - the **same** button scrubs stray direct font sizes off every selected
    block — the quick way to clean up odd sizes that ride in from imported
    `.docx` files (right-click the style, left-click to re-apply);
  - a **different** structural button converts them all — e.g. turn every tag
    into an analytic, or every pocket into a hat. Tag↔analytic conversions keep
    the card/analytic structure and its cites/bodies intact; heading swaps keep
    their ids.

- **Visible paragraph-break cue in selections.** When a selection reaches to
  the very start of the next paragraph — for example after Ctrl-Shift-Down, or
  Shift-Down past the end of a line — a highlighted `¶` now appears at the end
  of the line you're on, showing that the paragraph break itself is part of the
  selection. This makes it clear up front that deleting or typing over the
  selection would merge the two paragraphs, instead of that happening as a
  surprise.

### Fixed

- **Formatting now keeps the spaces between words consistent automatically.**
  Applying or removing underline, highlight, emphasis, cite, shading, or a font
  size now fixes the gaps around what you changed, so a space carries a style
  only when the words on both sides of it do. Two everyday wins: underlining a
  word that sits between two already-underlined words now joins up into one
  continuous underline instead of leaving broken spaces; and turning a style
  off no longer strands it on the spaces next to the word (it used to leave the
  space before and after still underlined or highlighted, dangling between the
  now-plain word and its styled neighbor). Applying any one of these tidies the
  spacing of all the formatting around the edit at once, so it stays consistent.
  It only runs around what you just changed — not the rest of the document — and
  if you deliberately format just a space, that's left as you set it.

- **Cursor no longer jumps to the next paragraph after deleting a selection
  that can't merge.** When a selection includes the paragraph break after it
  but the two paragraphs can't actually join — for example a card's tag and the
  card below it — deleting it (Backspace, Delete, or voice delete) used to leave
  the cursor at the start of the next paragraph. The cursor now stays in the
  paragraph you were editing. The same fix applies to AI Format Cite, which no
  longer leaves the cursor in the following paragraph.

- **Changing the font size of cite / underlined / emphasized text now actually
  resizes the letters.** Increasing or decreasing the size on text in one of
  these styles used to grow the line height and selection highlight but leave
  the glyphs at the style's display size. An explicit per-run size now wins over
  the style's display size (matching the size shown in the toolbar, and Word's
  behavior where a directly-applied size overrides the character style). Text
  with no explicit size still renders at the configured per-style display size.

## 0.1.0-alpha.14 — 2026-06-13

### Changed

- **`.cmir` files are now compressed — about 10× smaller.** CardMirror saves
  its native files gzip-compressed, so a typical card file drops to roughly a
  tenth of its size, with no real change to how fast files open (decompression
  is a tiny fraction of the work opening a file already does). Older
  uncompressed files keep opening normally; they shrink the next time you save
  them.

### Added

- **Bulk compress (Home screen, desktop).** A migration tool that rewrites
  every `.cmir` in a folder and its subfolders in compressed form, in place —
  for shrinking an existing library without re-saving each file by hand. Files
  already compressed are skipped, each file is verified before it's replaced,
  and its modified date is preserved (so your "recent files" ordering is
  untouched). A transitional tool — it'll be retired once libraries have
  migrated.

- **Un-bold words in tags.** Tags (and other headings) are bold by default,
  and you can now turn bold *off* for individual words — select them in a tag
  and press Mod-B (or click Bold). Imported .docx files that have un-bolded
  words in tags now display that correctly, instead of showing everything bold.

- **Lock Highlighting (Card menu → Highlighting).** Converts highlighting to a
  light-gray background in one pass, freeing the highlight layer so you can
  re-highlight. With no selection it locks the whole card the cursor is in;
  with a selection it locks just the selection. (No card under the cursor and
  no selection → nothing happens; it won't lock a whole pocket/hat/block.)
  Unlike Create Reference it works in place, adds no "FOR REFERENCE" heading,
  and never grays the text — the card stays fully editable. Any background you'd
  already applied is left alone. No default shortcut; rebindable, and findable
  in the command bar.

### Fixed

- **macOS voice: capture the microphone correctly.** Voice mode could connect
  to a mic but receive no audio on macOS. The main cause was that the packaged
  app lacked the microphone entitlement and usage permission, so macOS handed
  back a *silent* track even though the mic appeared connected — the app now
  ships the microphone entitlement, declares why it needs the mic, and asks
  macOS for access on first use. Two supporting fixes to the audio path: the
  audio engine is resumed after it starts (it could come up paused), and the
  mic is recorded at its own sample rate and converted to 16 kHz in-app
  instead of forcing a 16 kHz engine.

- **Spell check no longer flags a word whose styling changes mid-word.** When
  part of a word was underlined, highlighted, or otherwise styled differently
  from the rest (e.g. an underline ending partway through), the checker saw it
  as two separate fragments and red-underlined the pieces; it now checks the
  whole word.

## 0.1.0-alpha.13 — 2026-06-12

### Added

- **AI edits no longer collide.** Each AI action (cite creation, text and
  formatting repair, image alt-text and table extraction, and others) now
  reserves the part of the document it's working on for the duration of the
  request. Edits anywhere else — another AI action, or your own typing —
  shift its target along instead of landing the result in the wrong place.
  While an AI action is working on a stretch of text, edits to *that* stretch
  are held and the locked region flashes if you try; the rest of the document
  stays fully editable. Two AI actions on the same text won't run at once —
  the second asks you to try again in a moment. Each running action keeps its
  own purple region box and "Thinking…" pill; when their targets scroll off
  the top or bottom of the editor, the pills line up in a queue along that
  edge instead of stacking on one spot, and advance as each action finishes.

- **Paragraph spacing controls.** Settings → Appearance → Paragraph spacing
  (just under Line spacing) sets the blank space *before* and *after* each
  paragraph type — Body, Cites, Tags, Analytics, Pockets, Hats, Blocks, and
  Undertags — in points, per style, with a reset-to-defaults button. (Line
  spacing is the gap between lines; this is the gap between paragraphs.)

- **"Manage Quick Cards" is now a command.** It's searchable in the command
  bar and rebindable under Settings → Keyboard shortcuts, like the other
  Quick Cards actions.

### Changed

- **The welcome document matches your device.** On the mobile view, the
  onboarding starter now explains the touch interface (the ☰ outline, the
  Read / Move / Repair mode bar) instead of the desktop ribbon and keyboard
  shortcuts.

- **Appearance settings: Body font and Line spacing sit under Style
  typography.** Grouped with the other type controls instead of further
  down the tab.

- **"Show dropzone shelf" moved to the Editing tab** (just above
  Translation), where it sits more naturally than under Appearance.

- **Re-applying a structural style clears that paragraph's manual font
  size.** Pressing the tag, analytic, pocket, hat, or block shortcut on a
  paragraph that's already that type now strips any direct font-size
  overrides, resetting it to the style's size — the same gesture already
  cleared manual indentation.

### Fixed

- **Applying a structural style to a downward selection no longer restyles
  the paragraph below.** Selecting a paragraph with Ctrl-Shift-Down — which
  lands the selection boundary at the very start of the next paragraph — and
  then applying a tag, analytic, or heading style used to convert that next
  paragraph too; it now styles only the paragraph you selected.

- **Line spacing reset now updates the boxes too.** Pressing the line-
  spacing reset restored the actual spacing but left the old numbers in the
  input fields; the fields now refresh to the defaults.

- **Mobile: the outline drawer slides out on top of the mode panels.**
  Opening the outline while the Repair (or Move) panel was up left the
  panel covering the drawer; the drawer now sits above it.

- **Voice control now starts on macOS.** The packaged Mac build bundles an
  older libvosk that lacks the dynamic-grammar function, so starting voice
  failed with "cannot find function 'vosk_recognizer_set_grm'". Voice now
  runs on macOS; live document vocabulary still updates (it rebuilds the
  recognizer when needed).

- **Voice falls back to your default microphone.** If the previously
  selected microphone isn't available on this machine — a device chosen on
  another computer, or one that's been unplugged — voice now uses the
  system default instead of failing with "microphone unavailable / device
  not found."

- **Change Case no longer drops the last letter of some text.** On a
  selection containing a character whose uppercase form is longer than one
  letter (German ß → SS), cycling case ate the final character; it now
  preserves the whole text.

- **Condensing into a heading keeps it tracked in the navigation pane.**
  When a condense that began inside a tag or analytic produced the merged
  heading, that heading came out without a stable id — so until you next
  saved and reopened the file, the nav pane couldn't follow the cursor into
  it (the highlight stuck to the heading above) and you couldn't select or
  collapse it from the pane. The merged heading now keeps the first
  source's id.

- **Find-match highlighting isn't re-rendered on every cursor move.** With
  the find bar open over a large match count, moving the cursor or stepping
  between matches no longer re-allocates the entire highlight overlay.

- **Uncondensing no longer crashes when a ¶ marker is inside a heading.**
  A pilcrow that ended up in a tag (e.g. from a merge) made Uncondense
  throw; it now removes the marker without trying an invalid split.

- **Comments stay readable in Word.** Editor-created comment ids could
  exceed Word's numeric limit (they were seeded from the clock); they're
  now small integers, allocated past any ids already in the document.

- **Possessives are no longer flagged as misspellings.** Words ending in
  an apostrophe ("dogs'", "James'") are checked on their base form.

- **The floating format panel honors your settings.** Its buttons used
  default settings (e.g. the wrong highlight color) instead of your current
  ones.

- **Dragging a card out of the navigation pane auto-scrolls the document.**
  Dragging toward the top or bottom edge now scrolls the doc into view; it
  was scrolling the wrong element and doing nothing.

- **The navigation and spellcheck right-click menus no longer stay open at
  once.** Opening one closes the other.

- **Saving keeps your file's other custom document properties.** Stamping
  the document id (used by the study/Learn layer) used to overwrite the
  file's other custom properties; it now merges, leaving them intact.

- **Tabs and line breaks export correctly to Word.** They were written as
  raw characters Word ignored; they now export as proper tab/break
  elements. (A page break still comes back as a line break — the break
  type isn't tracked yet.)

- **Escape closes one dialog at a time.** With two dialogs stacked (e.g.
  editing a card from the Quick Cards or flashcard manager, or opening the
  AI cite-prompt editor from Settings), Escape used to close both at once;
  it now closes only the topmost.

- **The AI cite-prompt editor's instructions are up to date.** They told you
  the model must return JSON; it actually replies in a delimited block
  format. The note now describes the real format the editor parses (and
  still warns against changing it).

- **Undoing a deletion restores its comments too.** Deleting commented text
  and then undoing used to bring the text back but leave the comment gone;
  the comment now comes back with it.

- **Condensing no longer destroys a table caught in the selection.** A
  demolish-mode condense over a range containing a table used to flatten
  the table into loose paragraphs; it now leaves the document untouched so
  the table survives.

- **Content controls no longer drop their contents on import.** Text inside
  a Word content control (a "structured document tag") was skipped; it now
  imports normally.

## 0.1.0-alpha.12 — 2026-06-12

### Added

- **Faster Verbatim Flow, with a warm connection you can control (Windows
  only).** CardMirror now keeps a single background connection to Excel
  alive instead of starting a new one for every action — so every Send or
  Pull after the first is near-instant instead of pausing a second or
  more. It starts on its own the first time you use a Flow command and
  stays ready; you can also start it up front with the new **Start Flow
  Connection** command, or turn on **"Keep a Verbatim Flow connection
  warm"** in Settings to have it ready the moment CardMirror launches.

- **The Help menu links to the user manual.** Help → User Manual opens
  the full manual.

- **Mobile settings can customize style typography.** The mobile settings
  page now offers the same per-style typography toggles as the desktop —
  cite underline, undertag and emphasis bold/italic, the emphasis box and
  its thickness — not just the per-style font sizes.

### Changed

- **The voice-control shortcut is now rebindable.** Turning voice mode on
  and off (default Ctrl-Shift-V) is a regular command now — searchable in
  the command bar and rebindable under Settings → Keyboard shortcuts.

- **Verbatim Flow commands appear only on Windows.** The integration is
  Windows-only, so its commands no longer show in the command bar, the
  keyboard-shortcuts editor, or the shortcuts reference on macOS and
  Linux.

- **Send Headings to Flow sends only the cite-marked text.** A cite line
  now contributes just its marked citation — the same text the nav pane's
  cite preview shows — instead of the whole bibliographic paragraph.

### Fixed

- **Voice control now starts in the packaged desktop app.** In the
  previous release the recognizer failed to launch on Windows, Linux,
  and macOS, so a voice session ended the instant it began. On macOS
  this currently works on Apple Silicon; Intel Mac support is still
  pending.

- **Canceling the Flow overwrite prompt no longer locks up the keyboard.**
  Dismissing the "there's already text where you're sending" confirmation
  with Cancel used to leave the editor unable to accept keystrokes until
  you clicked it; it now keeps focus.

- **The "AI is working" pill now appears next to an image being edited.**
  When generating alt text or a table from an image, the progress pill
  jumped to the editor's top-left corner instead of sitting by the image.
  It now anchors to the image like the other AI cues, pinning to the
  corner only when the image scrolls out of view.

- **Mobile settings: editors with a long description lay out better.** The
  reader time-estimate editor (and the other per-style editors) now stack
  their controls below the description instead of squeezing them into a
  narrow side column, so the text no longer piles up on a phone screen.

## 0.1.0-alpha.11 — 2026-06-11

### Added

- **A steady (non-blinking) text cursor.** A new accessibility setting
  (Settings → Accessibility → "Steady text cursor") stops the document's
  text cursor from blinking — the caret stays solid in the usual cursor
  color while you type, instead of flashing on and off. Off by default.

- **Send to Verbatim Flow (experimental, Windows only).** A set of
  commands connects CardMirror to Verbatim Flow — the Excel flowing
  template — exactly the way the Verbatim Word add-in does, with no
  changes needed to Flow itself. These are command-palette and
  keyboard-shortcut commands only — they are **not** buttons on the
  ribbon and take up no ribbon space. Find them by searching the command
  bar, or bind your own shortcuts in Settings → Keybindings (none are
  bound by default). With Excel open and a workbook whose name contains
  "Flow": "Send to Flow" drops your selected tags, cites, and text into
  the flow's current column (one cell per line, or all in a single
  cell); "Send Headings to Flow" leaves out card bodies; "Pull from
  Flow" reads the cells you've selected in Excel back into your document;
  and "Create New Flow" opens a fresh flow from the Verbatim template. It
  works only on Windows (it drives Excel over COM); on other platforms
  the commands report that and do nothing. Experimental — expect rough
  edges.

- **A mobile layout for the web edition.** Opening
  CardMirror in a phone or tablet browser — or any browser window
  narrower than 768px (touch screens up to 1024px) — now gets a
  view-first layout built for small screens: a slim top bar (outline
  drawer, undo/redo, display options, menu), the document full-bleed
  below it, and a Read button that turns on read mode — where a tap
  on the text drops or removes a reading marker, so you can read a
  speech doc straight off the phone. Pinch zooms the document (the
  chrome stays put; a Reset button in the display sheet returns to
  100%), the outline slides in from the left edge with entries
  wrapping up to three lines (tablets pin it as a sidebar the ☰
  button collapses and restores),
  and the menu covers Open, Export a copy, word count, and Home —
  which on mobile shows documents only, no Quick Cards or flashcard
  sections. A Settings page sized for touch carries the relevant
  settings — appearance, text sizes, readers, AI key — and "Use
  desktop layout" (or the new "Layout on this device" setting)
  switches back to the full UI any time. Crash-recovery offers
  don't pop up in the mobile layout — unsaved drafts wait for your
  next desktop-layout visit. Editing stays desktop-only:
  the mobile view never opens the on-screen keyboard, and there is no
  drag-from-the-document or dropzone on mobile — on touch, a drag is
  indistinguishable from a scroll. Rearranging is its own mode
  instead: tap **Move**, tap any card or heading to pick it up
  (dashed outline), and an action strip offers one-step **Up** /
  **Down** (sections hop whole sibling sections; cards step over
  neighbors and in/out of sections), **Send to…**, **Copy**, and
  **Delete** — every move is one undo step. Send to… picks the
  destination straight from the outline: tap a row and choose
  **Place above** or **Place below** — the moved section always
  lands beside the destination, never inside it. In the outline
  itself, press and hold a row for a moment to pick it up and drag
  it (a plain swipe still scrolls). The AI repairs work from the
  phone too: tap **Repair**, tap a card to set the scope (repairs
  run one card at a time), and run Repair Text or Repair Formatting
  on its body text (tags and cites stay out of scope), or **Repair Cite** to re-run the AI
  cite formatter on the tapped card's citation (or, for a card with
  no cite paragraph yet, on the first body paragraph under the tag) — with the same
  thinking/Clod progress indicator, fixes, flashes, and single undo
  step as on desktop (and a pointer to Settings if no API key is set
  up on the device; the Clod toggle is in mobile Settings too).


- **Smart Shrink.** Press **Mod-Alt-8** to shrink a card's connective
  text in one step, with per-paragraph depth: paragraphs containing no
  underlining or emphasis at all — the long fully-unread stretches —
  go straight to 5pt, while paragraphs that do carry those marks
  shrink their connective text to the standard 8pt. No cycling:
  running it again changes nothing. Underlined and emphasized text is
  never touched, and the same protections as regular Shrink apply
  (omission markers, integrity warnings, custom rules). Regular Shrink
  (Mod-8) and Regrow (Mod-Shift-8) work on the result as usual.

- **Repair Formatting (AI).** Select body text and press **Mod-Alt-R**
  to normalize it to Verbatim's four-layer scheme — underline as the
  broad pass, emphasis to make some of it stand out, highlighting for
  what's read aloud, shading to set off some of the highlighting. It
  repairs the classic breakdowns of imported cards: bold or italics
  standing in for emphasis, direct underlining instead of the named
  style, bold-underline used for ALL the underlining (no emphasis pass
  — converted to plain underline, not emphasis), and cards whose
  underlining was destroyed by an unsupported style, recoverable only
  from font size (full-size text was the underlined text). Bold and
  italics survive when they're a deliberate extra layer alongside real
  emphasis or reproduce the source's own formatting (book titles,
  foreign terms). The model never touches your text — it only returns
  a mapping from each formatting pattern found to what that pattern
  should be (plus targeted overrides for idiosyncratic fragments), and
  the editor applies it. Works one card at a time, only on body
  paragraphs (never tags, cites, or headings), highlight and shading
  colors preserved, font sizes untouched, one undo step. Requires AI
  features.

- **Voice control (experimental, desktop only).** Press **Ctrl-Shift-V** to start a
  hands-free editing session — recognition runs entirely on your machine
  (no network, ever). Speak commands like `pen highlight` · `take <words
  you can see>` · `mark` · `next card` · `condense` · `go back`, dictate
  with `start typing` … `stop typing` (your words stream in as gray
  preview text while you talk), or enter **paint mode** (`paint`) where
  the words you read aloud are inked with the active pen — the
  voice-native version of working a card. A status pill shows the
  listening state, active pen, what was heard, and your mic level; `voice
  sleep` / `voice wake` park the mic when someone walks up. Every voice
  action is one undo step, and voice undo (`scratch that`) and Ctrl-Z
  always agree. Dictation supports spoken punctuation ("period", "comma",
  "question mark", quotes), a configurable dash word, `literal <words>` for
  dictating command words, and automatic sentence capitalization. The
  session auto-sleeps after sitting idle (configurable; the pill dims as a
  warning), and clicking the pill opens a microphone picker. Voice options
  live under Settings → Accessibility — including an optional large
  dictation model (one-time 1.8 GB download) that roughly halves
  general-English dictation errors. Targeting composes Cursorless-style:
  ordinals count within their natural container (`take second sentence`,
  `go to third card` — third in this block), `mark every tag` inks every
  tag in the block with one undo step, `take head card` / `take tail
  paragraph` select to a scope's edge, and `take from <words> to <words>`
  spans two spoken anchors. When the words you spoke appear more than once
  on screen, numbered badges appear over each match — say `pick two` to
  choose. Speech models ship with the app (installers grow by roughly
  130 MB).

### Changed

- **A revamped "AI is working" indicator.** While an AI action runs —
  formatting a cite, repairing OCR/PDF text or formatting, generating
  image alt text — CardMirror now boxes the exact part of the document
  it's working on in purple and floats a "Thinking…" label at the
  editor's left edge, so you can tell what's happening even after your
  selection clears and even when that spot has scrolled out of view (the
  label pins to the top or bottom edge then). The box hugs just the text
  you selected for selection-based actions like Format Cite.

- **Repair Text applies each pass in one step.** Corrections used to
  land one at a time in an animated walk; they now apply all at once
  with a single orange flash over every replacement, matching Repair
  Formatting. The two passes read as two blinks. Still one undo step.

### Fixed

- **Picking up a card on macOS no longer selects a word.** Holding the
  drag-from-document chord and clicking used to trigger macOS
  word-selection (Option+Shift+click) instead of grabbing the card;
  clicks held under the pickup chord are now fully absorbed.

- **Open can no longer deadlock in the web edition.** If a file
  picker ever closed without delivering a result (some browsers
  don't report a cancelled dialog, and a request made without a
  fresh user gesture can be silently ignored), every later Open —
  shortcut, menu, and home screen alike — waited forever behind it.
  A new Open attempt now supersedes a stuck one instead of queueing
  behind it.

- **Switching between the three-pane workspace and one-window-per-
  document mode now restores exactly the documents you had open.**
  This glitch primarily affected Mac users. Both directions were
  broken: switching out of three-pane closed every pane and
  reopened nothing, and switching into it brought back documents
  from earlier sessions alongside the ones you actually had open.
  The switch now hands off precisely the open set — every open
  document reopens in the new layout, nothing tags along from the
  past, and documents with no unsaved changes come back clean
  instead of asking you to save when you close them.

- **Typing over a Ctrl+Shift+Down selection no longer eats the
  paragraph break.** Selecting a paragraph with Ctrl+Shift+Down
  extends the selection to the start of the next block, so typing
  replaced across the boundary and merged the blocks — worst case,
  selecting a tag that way and typing folded the cite into the tag.
  Typing now replaces only the block's own text, matching
  triple-click. Selections that visibly reach into the next block's
  text still merge as before.

- **Pane word counts update live after Send to Speech in multi-pane.**
  Two stacked causes. The send path's "show the new headings
  immediately" hook cancelled the pending refresh without doing the
  refresh's work — so the speech pane's count froze after every send
  (cross-pane card drops had the same flaw); the hook now flushes the
  nav rebuild and word count on the spot, making the count update
  instantly on send — faster than single-pane's debounce. Separately,
  a document moved between panes (Send Doc to Slot) kept refreshing
  its OLD pane's count; each pane's count now follows the document
  wherever it lives, for edits, sends, and live selection counts
  alike, under every word-count setting.

- **Repair Text now places far more of its fixes on imported cards.**
  The model frequently echoes straight quotes and apostrophes where
  the document has curly ones, and the exact-match placement quietly
  skipped every such fix — on a real card, over half the suggested
  repairs. A fallback matcher now tolerates those echo slips (smart
  quotes/dashes, ligatures like ﬂ, non-breaking spaces, tabs, invisible
  characters, and context that crosses a paragraph break) while
  preserving the document's original punctuation — only the actual
  correction is applied, never the surrounding context. Repair also
  now catches the stray-space-after-hyphen artifact ("neo- Gramscian"
  → "neo-Gramscian", "vis-a- vis" → "vis-a-vis") — keeping the hyphen
  for real compounds, dropping it for words split across a line. Long
  fix lists also no longer fail with a cryptic JSON error: the
  response limit is raised, and genuinely oversized lists ask you to
  repair a smaller region instead.

- **Anthropic translations no longer cut off silently on long
  selections.** The AI translation path capped its output at roughly
  750 words and quietly copied whatever fit — a long card came back
  missing its tail with no warning. The ceiling is now ~40,000
  characters (far beyond any realistic selection), and if a translation
  ever does hit it, the toast says so and the copied text ends with a
  visible `[TRANSLATION INCOMPLETE — OUTPUT LENGTH LIMIT REACHED]`
  marker instead of pretending to be complete.

- **Saving no longer adds italics to undertag text.** Exported files
  mark undertag runs italic so they display correctly in Word; reopening
  such a file turned that display hint into real italic formatting on
  every undertag, every save. Undertags now come back exactly as you
  wrote them.

- **Find/Replace works correctly in paragraphs containing images.**
  Every match after an inline image was shifted one position per
  preceding image — highlights landed slightly off and Replace edited
  the wrong characters, corrupting adjacent text. Matches, highlights,
  result snippets, and replacements now land exactly on the matched
  text.

- **Letter shortcuts now work when focus is outside the editor.**
  Shortcuts like Ctrl+Shift+S did nothing while focus sat on the
  ribbon, nav panel, or other chrome — and with CapsLock on, even
  plain Ctrl+S died everywhere. Letter shortcuts now match regardless
  of Shift or CapsLock casing, wherever focus is.

- **Closing a document now releases its memory.** Each closed pane
  quietly kept its outline panel — and with it a full snapshot of the
  document — alive until the app closed, and the orphaned panel kept
  doing work during drags. Long sessions that open and close many
  files (a tournament day) no longer accumulate that weight.

- **Body paragraphs with leftover cite styling now clean up properly.**
  Imported cuts can carry the cite character style across the whole
  un-underlined text of a card body. That classified the paragraph as
  a cite line, so Shrink refused it — and the obvious cleanup, Select
  Similar Formatting then Clear Formatting, left one styled space per
  matched run behind (the trailing-space trim that undoes double-click
  absorption was wrongly applied to each matched range), which kept
  the paragraph classified as a cite line. Now: Clear Formatting over
  a Select Similar match cleans whole runs including their spaces,
  invisible whitespace-only runs no longer make a paragraph a cite
  line, spaces match Select Similar by formatting alone (size
  ignored), and Shrink tells you when the cursor is in an actual cite
  line instead of silently doing nothing.

- **F7 with text selected inside a tag no longer breaks up the card.**
  Selecting a word in a tag and pressing F7 quietly pushed the card's
  cite and body out as plain paragraphs (the cite lost its formatting;
  condense stopped folding the body). With the cursor in a tag F7
  correctly did nothing — now the selection does nothing too. Same fix
  for Mod-F7 on analytic text and F8 on an undertag.

## 0.1.0-alpha.10 — 2026-06-08

### Added

- **Reading-position marker.** Press **Mod-Shift-D** (rebindable) to drop a
  red `Marked h:mm` note at the cursor — Verbatim's red-text convention for
  finding your place when you stop mid-card. Triggering it again while the
  cursor is on a marker removes it. It works any time, but shines in read
  mode: there the keyboard is otherwise locked, so **Space**, **Enter**, or
  the bound shortcut all drop (or clear) a marker, and **undo/redo** is
  bounded to just the markers you've placed — it won't reach back into edits
  from before you entered read mode. The marker is plain red text, so it
  saves to Word like any other colored run.

- **Repair Text (AI).** Select messy OCR / PDF-extracted text and press
  **Mod-Shift-R** to clean up extraction errors — dropped ligatures
  (`signicant` → significant), `rn`/`m` confusions, mid-word hyphenation
  split across lines (`re-`/`search` → research, rejoining the break),
  run-together words, stray-space and punctuation slips — while leaving the
  actual wording untouched. The model returns only the specific fixes (not
  a rewrite of your text), which are applied in place: you watch each
  correction appear one at a time with an orange highlight, and the whole
  repair is a single undo. Requires AI features.

- **Translate a selection (AI optional).** Select text and press
  **Mod-Shift-T** (rebindable) to translate it and copy the result to the
  clipboard — the document is left untouched. Three backends, picked under
  Settings → Editing → **Translation**: **MyMemory** (free, no key, works
  even with AI features off; optional email raises its daily limit),
  **Anthropic** (used when AI features are on; highest quality), and
  **Google Cloud Translation** (paste an API key). Source language
  auto-detects; the target language defaults to English and is
  configurable. Optionally (on by default) it prepends a
  `[TRANSLATION BY …]` marker line naming the engine (the model for
  Anthropic, MYMEMORY, or GOOGLE TRANSLATE), using the same delimiter as
  "Condense with warning" — and those markers are protected from Shrink.

- **Custom AI model (advanced).** Settings → Comments & AI → **AI model**
  lets you point all AI features at a specific Claude model id (e.g.
  `claude-opus-4-8`). Leave it blank to use the model built into the
  release; set a newer id if the built-in one is ever retired so you don't
  have to update the whole app. If the model is unavailable, CardMirror now
  shows a clear message telling you to update or set a newer model here.

- **Pinch / Ctrl+Scroll to zoom.** You can now zoom the document with a
  trackpad pinch or by holding Ctrl and scrolling the mouse wheel, in the
  same 10% steps as the zoom buttons and Ctrl-= / Ctrl--. Off by default;
  enable it under Settings → General → **Pinch / Ctrl+Scroll to zoom**
  (handy if you don't habitually scroll with Ctrl held).

- **Keyboard macros are now findable in the command bar.** Searching the
  Search Everything palette (Mod-Shift-Space) for "keyboard macros,"
  "macro," or "snippet" now surfaces a result that jumps straight to the
  macros editor under Settings → Keyboard shortcuts.

- **Manage Flashcards button in the ribbon, with a due-today dot.** The
  ribbon's comments cluster now has a **Manage Flashcards** button (next
  to Create Flashcard) that opens the flashcard manager. It shows a small
  **red dot** when one or more cards are due for review today; turn the
  dot off under Settings → General → **Flashcards-due dot**.

- **Comment, note, and ask AI about pictures.** Select an image — or a
  span of text that includes images — and you can now add a comment, add
  a private note, or ask AI about it, just like you can with text. Ask AI
  sends the actual picture(s) to the model (up to five from a selection),
  so you can ask things like "what does this chart show?" Image
  annotations re-anchor by content when the document changes, exactly
  like text annotations, and comments on an image survive saving to Word.

### Fixed

- **AI cite creator: no more chopped-off last character.** When you ran
  cite repair over a whole-document selection (e.g. Select All on a page
  of pasted citation info), the highlight could land one character early
  — missing the last character of the author tag — and the final
  character of the cite could get pushed onto its own line. Both are
  fixed. As a bonus, the cite is now cleaned of stray line breaks, double
  spaces, and invisible junk that often rides along in text pasted from
  PDFs or the web.

- **"Show in context" during review now closes the Manage Flashcards
  screen.** When you open Manage Flashcards, start a review, and use Show
  in context on a card that lives in the document you already have open,
  the manager now closes so you land on the card — it used to stay open
  over the document. (Matches how it already behaves from the Home
  screen.)

- **Dragging a card out of the editor now auto-scrolls.** When you pick
  up a card or heading from the page and drag toward the top or bottom
  edge, the document scrolls so you can drop it past what's currently on
  screen — previously it didn't scroll at all.

- **`@AI` mentions work again in comments and notes.** Typing `@AI` now
  summons the assistant from the **first** message of a comment (not just
  replies), and works in note threads too — both had stopped firing. The
  assistant's name also no longer shows a redundant `(AI)` after it (e.g.
  just "Clod"), matching the rest of the interface.

- **Opening an already-open file from Finder no longer makes a second
  copy.** Double-clicking a file in Finder (or "Open with… CardMirror")
  now jumps to the window that already has it open — the same thing the
  in-app Open dialog has always done.

- **Toggling the three-pane workspace no longer closes all your
  windows.** With more than one window open, flipping the three-pane
  setting now reliably reloads into the new layout with your documents
  intact, instead of occasionally closing every window and reopening
  none.

- **Editor spellcheck actually works now.** It previously did nothing
  even with the setting on. Spellcheck now underlines misspellings in the
  visible part of the document — including text in files you've opened,
  not just words you're currently typing — and works on every platform
  (the old browser checker didn't render on Linux). **Right-click a
  flagged word** for spelling suggestions, **Add to Dictionary** (your
  personal dictionary persists across documents and sessions), or
  **Ignore**. It's still off by default; turn it on under Settings →
  General.

### Changed

- **Italic typing now shows a slanted cursor.** When you turn on italics
  with no selection (Ctrl-I) — or place the cursor inside italic text — the
  caret tilts to match, so it's clear the next thing you type will be
  italic. The cursor returns to upright as soon as typing wouldn't be
  italic.

- **Ctrl-U with no selection now starts underlined typing.** With nothing
  selected, Ctrl-U toggles underline for the text you're about to type
  (matching how Ctrl-I / Ctrl-B work), instead of doing nothing. **F9 is
  unchanged** — it still underlines the whole word at the cursor. (Both
  remain rebindable under Settings → Keyboard shortcuts.)

- **Backspace removes a blank line directly below a tag.** An empty
  paragraph right under a tag or analytic used to swallow Backspace
  (to protect the heading from absorbing body text); now, since there's
  nothing to merge, it just deletes the blank line and puts the cursor at
  the end of the tag. A line with text is still protected.

- **Select Current Heading now has a default shortcut: Alt-A.** The
  command (select the current heading and everything under it) was
  previously unbound; rebind it like any other under Settings → Keyboard
  shortcuts.

- **macOS no longer pretends to auto-update.** CardMirror can detect a
  new version on macOS but can't install it automatically, so the
  "downloading in the background" / "restart to install" prompts no
  longer appear there. The update notice now simply points you to the
  releases page to download the new `.dmg`. Update checking, and full
  auto-update on Windows and Linux, are unchanged.

### Removed

- **The "Text drag-and-drop" setting.** Dragging selected text to move it
  never worked reliably, so the toggle (which was off by default anyway)
  has been removed; the behavior stays off. Selecting, copy/paste, and the
  card / heading pickup-drag are unaffected.

## 0.1.0-alpha.9 — 2026-06-03

### Added

- **A user manual.** A complete guide to the editor — installing, cutting
  and formatting, the workspace, read mode, flashcards, AI, settings, and
  shortcuts — now lives at `MANUAL.md`, written in the plain,
  task-first style of Verbatim's own manual.

- **Notes — a private, threaded annotation.** A fourth kind of comments-bar
  entity, alongside comments, AI notes, and flashcards. Add one with the
  new green **note button** in the comments cluster (its own third column)
  or the bindable **Add Note to Selection** command (default
  **Ctrl/Cmd+Shift+N**). Notes are green throughout — chip, in-text
  highlight, card accent — and behave like comments (a root message plus
  replies) but stay **private**: they live in your local layer and never
  enter the saved file unless you opt in. Click a note's green text to
  focus its card; unanchored notes get a Re-ground action like flashcards.

- **Edit any comment or note in place.** A pencil button on each comment,
  reply, and note turn opens an inline editor (Save / Cancel; Enter saves,
  Esc cancels) so you can fix text after writing it.

- **Opt-in export of private notes and AI comments.** The Save As dialog's
  Custom Save now has two checkboxes (off by default): include private
  notes, and include AI comments. When checked, they're written into the
  saved `.docx` / `.cmir` as real Word-style comments. Leaving them off
  keeps notes and AI threads entirely private, as before.

- **Save Send Doc command + shortcut.** A new bindable command (default
  **Ctrl/Cmd+Alt+S**) that saves a send doc — the document with comments,
  analytics, and undertags stripped, the same content as the Save As
  dialog's Send Doc preset — in one keystroke, no dialog. Two new
  Settings → General options control where it goes: **Send Doc
  destination** (the source file's own folder, or a fixed folder you
  pick) and the **Send Doc folder** for the fixed-folder option. It uses
  your default new-document format and the same `SEND_` prefix as the
  preset. If the document hasn't been saved yet (same-folder mode), the
  fixed folder isn't set, or the name would overwrite the source, it
  falls back to the normal Save As dialog so nothing is lost.

- **Right-click a style button to select every instance of that style.**
  Right-clicking any structural style button (Pocket / Hat / Block / Tag
  / Analytic / Undertag) or character style button (Cite / Underline /
  Emphasis) lights up every instance of that style across the document,
  shown the same way as Select Similar Formatting — so you can then apply
  a format (highlight, font color, etc.) to all of them at once. If you
  have a selection, the search is bounded to it and the region is tinted;
  that scope stays put across further right-clicks and format operations
  until you make a new selection or press Escape. Underline matches only
  the named underline style, not the direct underline that tags and
  analytics use.

- **Ribbon style buttons show what the cursor is on.** When the cursor
  sits on text carrying a character or structural style, the matching
  ribbon button (Cite / Underline / Emphasis, or Pocket / Hat / Block /
  Tag / Analytic / Undertag) lights up in its toggled-on state, the same
  way other toggle buttons do. Underline only lights for the named
  underline style, not the direct underline tags and analytics use.

- **Find the app version from the command bar.** Searching "version" or
  "about this install" in the command bar shows the running version, and
  pressing Enter jumps straight to the About this install section of
  Settings.

- **Convert Cited Analytics to Tags.** A new command in the document
  dropdown's Cleanup section (also bindable to a shortcut, unbound by
  default) that works like Convert Analytics to Tags but only converts
  analytics that actually carry a cite paragraph — bare, citeless
  analytics stay analytics. Bounded to your selection when you have one,
  whole-document otherwise.

- **Extract Undertag.** A new command in the card dropdown's Excerpt
  section (also bindable, unbound by default) that takes your selection
  inside a card and drops it as a new undertag beneath the tag, below any
  existing undertags. The original text stays put. A new Settings →
  Editing toggle, "Extract Undertag: wrap in quotes" (off by default),
  controls whether the excerpt is wrapped in quotes.

- **Word Count Selection button in every multi-pane pane.** The Σ button
  that opens the Word Count Selection summary, previously only in
  single-pane view, now appears in each pane's footer in multi-pane mode.
  Each one counts the document — and selection — in the pane it sits next
  to. The redundant shared button that used to sit in the corner below
  the nav rail is gone in multi-pane mode.

### Changed

- **Autosave remembers its setting per document.** Turning autosave on
  for a saved doc now sticks: close and reopen that file (in either
  single-pane or multi-pane mode) and autosave comes back on, instead of
  resetting to off every time. The choice is remembered per file, so
  other docs are unaffected.

- **Paragraph navigation lands on cleaner spots.** With a selection,
  Ctrl/Alt+Down now collapses to the **start of the next paragraph**
  (just past the break) instead of stopping at the end of the selected
  paragraph first — so the next Down continues to the paragraph after
  that. And Ctrl/Alt+Left at the start of a paragraph now lands at the
  **end of the previous paragraph** (after its last word/punctuation),
  matching how Ctrl/Alt+Right lands at the start of the next one.

- **Select Similar / select-all highlighting is easier to read.** The
  "selection" region and the matched instances now use the find bar's
  colors — a faint blue region band with orange match outlines — instead
  of two near-identical oranges that were hard to tell apart.

- **The welcome guide is shorter, and now covers flashcards.** The
  starter document you get on first launch (and on New Document) has been
  tightened throughout and gained a "Study your evidence" section
  introducing the spaced-repetition flashcards.

### Internal

- **Diagnostic logging for a macOS multi-window issue.** This build
  writes a `cross-window-debug.log` to the app's data folder to help
  track down a Mac-only problem where the duplicate-open guard and the
  three-pane toggle don't always coordinate between windows. It records
  window open/close coordination only — no document content — and will
  be removed once the cause is found.

- **Project documentation streamlined.** The README, ARCHITECTURE, and
  PROJECT docs were cut down and brought up to date — shorter, clearer,
  and accurate about what's shipped versus planned.

### Fixed

- **Live selection word count works in multi-pane mode.** With the
  "live selection word count" setting on, selecting text in a pane now
  immediately updates that pane's footer to the selection's word count
  and read time, the same as single-pane — previously it only refreshed
  after the next edit, so it looked permanently off. With the setting
  off, panes show the whole-doc count regardless of any selection.

- **Dropzone pill no longer briefly overlaps the reader count in
  multi-pane mode.** On a fresh multi-pane boot the floating dropzone
  pill could land on top of a pane's word-count / read-time readout
  until something refreshed the UI (e.g. cycling the theme). It now
  sits above the pane footer from the first paint.

- **AI "Generate table from image" handles large tables.** Big tables
  used to silently fail because the model's JSON got cut off at the token
  limit. The format the model returns is now much more compact and the
  token ceiling is far higher, so large tables come through intact. If a
  reply still comes back malformed (rather than truncated), it's sent to a
  second pass that reformats it instead of just failing; a table that's
  genuinely too big to return in one go now says so clearly.

- **Creating notes, AI comments, and flashcards is fast again on large
  documents.** Adding one of these annotations (and typing a reply) no
  longer re-scans the whole document to re-locate every annotation each
  time — a newly created or re-grounded annotation now uses the position
  you already selected, and the rest are left where they are. On big docs
  this takes note / AI-comment creation from sluggish to instant.

- **Opening Settings and changing a setting are fast again on large
  documents.** Both could take seconds on a big doc. The main offender was
  the Accessibility color panel, which forced a full-document style recalc
  for every one of its ~37 color rows on every settings change (and at
  open); it now reuses a single probe and refreshes only the row whose
  color actually changed — so editing one color touches one row, not all
  of them. A few settings were also re-applied on every change even when
  unrelated (read mode re-walking the doc, the outline panel rebuilding,
  a redundant word-count walk); those now run only when their own input
  changes. The keyboard-shortcuts list also builds a frame after the
  dialog opens rather than blocking it.

## 0.1.0-alpha.8 — 2026-06-01

### Added

- **"Show in context" in flashcard review.** After you reveal a card's
  answer, a third option (button or key **3**) opens the card's source
  document focused on the exact text it was made from. It appears only
  when the card is anchored in a file you have on disk, and it doesn't
  grade the card — it's a quick "show me where this is." Where it lands:
  in the three-pane workspace it opens into a slot of the current window
  (the one already holding it if any, otherwise the first free slot);
  in single-document mode it focuses the doc in place if it's already
  open here, jumps to it if you have it open in another window, or opens
  it in a new window otherwise — leaving the review running unless the
  document opens in this same window.

- **Live word count for the current selection (optional).** A new
  Settings → General toggle, off by default. When on, the bottom bar's
  word count / read time updates the moment you change the selection,
  showing the selection's read time; when off, the bar stays on the
  whole-document count and you get a selection's read time on demand via
  the Word Count button (Σ). Leave it off on very large documents if you
  notice lag while dragging a selection.

### Fixed

- **Clicking AI-comment or flashcard text now focuses its card** in the
  comments pane, the same way clicking commented text focuses its
  comment. Previously only human comments responded to the cursor — AI
  threads and flashcards would only open if you clicked their card in the
  pane directly.

## 0.1.0-alpha.7 — 2026-05-30

### Added

- **"Delete Current Heading" command.** Deletes the structure your
  cursor is in — a card, an analytic, or a heading and everything under
  it (the same thing "Select Current Heading" targets) — removed
  outright, with no empty heading left behind. Unbound by default;
  assign a key in Settings → Keybindings (or run it from the search
  palette — it also answers to "delete card" / "delete heading").

- **Search-Everything now finds settings and commands by their common
  names, not just their exact labels.** Searching "dark mode", "light
  mode", or "toggle theme" surfaces the Theme setting; "toggle
  comments" finds Show / Hide Comments (and vice versa); "clear
  formatting" finds Clear, "paste without formatting" finds Paste Plain
  Text, "line height" finds Line spacing, "sidebar" finds the
  navigation pane toggle, and more. These are search aliases only —
  the displayed names are unchanged.

- **Reset-to-default buttons next to the Analytic / Undertag color
  pickers** (Settings → Appearance → Style colors).

- **"Cycle Theme" command** that steps the theme Light → Dark → System.
  Unbound by default — assign a key in Settings → Keybindings (or run it
  from the search palette; it also answers to "dark mode" / "toggle
  theme").

- **Find a tag by its citation when searching inside a file.** Tab into
  a file from the command bar and type an author/date — the tag whose
  card carries that cite now shows up, the way Ctrl-F can find it. Tags
  also display their cite alongside them in the results. Because tags
  are now findable by cite, standalone "Cite" rows are off by default in
  the file-search object types (re-enable them in Settings if you want
  cites listed on their own).

- **Selecting text auto-scrolls at the edges.** Dragging a selection to
  the top or bottom of the document now scrolls the view so the
  selection keeps extending past the originally visible area — no more
  stopping to scroll by hand. Scrolls continuously while you hold near
  the edge, faster the closer you get.

### Fixed

- **"Open with… CardMirror" now works in three-pane workspace mode.**
  Opening a file from the OS file manager (right-click → Open with) used
  to pop a blank window in multi-pane mode — the file was silently
  dropped. It now routes the file into the slot picker: if a workspace
  window is already open it reuses that window (no new window); if none
  is open it opens one and shows the picker there. Single-pane is
  unchanged (a new window per file). Applies to both `.docx` and `.cmir`.

- **The command bar's file search refreshes while it's open.** Opening
  the palette kicks off a background re-scan of your `.cmir` folder, but
  that fresh listing used to appear only after you closed and reopened
  the bar. It now updates the open palette the moment the re-scan
  finishes — and seamlessly: whatever you're typing, your place in the
  results, and a file you've Tabbed into are all preserved across the
  refresh.

- **"Find: remember the last search query" now actually turns off.** The
  find bar kept the text you'd typed even after closing, so the last
  query reappeared on every open no matter how the setting was set. It
  now opens with the remembered query only when the setting is on, and
  with a clean slate when it's off.

- **The Analytic / Undertag color pickers now actually work, and the
  Appearance and Accessibility copies are linked.** The Appearance
  "Style colors" picker had no visible effect — the Accessibility
  "Color overrides" system silently wiped it on every load. The two are
  now one linked value: set the color in either place and both update.
  Dark-mode behavior follows what you'd expect: your colors stay put
  when dark mode is on but isn't applied to the document; the document
  switches to a lighter built-in blue/green only when you apply the
  theme to the document area (the navigation pane, being chrome, always
  uses the lighter colors in dark mode for contrast). Any color you'd
  previously set through the Accessibility panel is migrated over
  automatically.

- **The home screen's Learn section no longer locks you out of Manage
  when you have no flashcards.** Previously the whole section greyed
  out until your first card existed — but Manage is where you import
  flashcards from a file, so there was no way in. Now only "Review
  all" is greyed out when there's nothing to review; "Manage
  flashcards" stays live so you can import.

## 0.1.0-alpha.6 — 2026-05-30

### Added

- **Integration surface for a future external paste tool (Fast Debate
  Paste).** CardMirror now runs a tiny loopback HTTP server
  (127.0.0.1 only, token-gated, off the network) so a separate, not-
  yet-shipped client app can insert pasted text directly into the
  focused doc — replacing the Return-then-F2 keystroke synthesis
  that bridge currently uses. No user-visible feature today; nothing
  changes until the external app implements its side and ships.
  Discovery file at `{userData}/fast-paste-bridge.json` tells the
  client the per-launch token and port; the server tears it down on
  quit. Routes: `GET /ping` for a health probe, `POST /insert` for
  the insertion itself. Insertions go through a renderer-side
  primitive that builds `card_body` paragraphs (or `paragraph` at
  doc level) directly, so a multi-line insert always stays as body
  paragraphs in the same card — never as a tag.

### Fixed

- **Old docs with id-less tags now self-repair on load.** Tags
  synthesized by the pre-alpha.6 F2 schema-fitter bubble-up were
  saved into `.cmir` files with `id: null` (the schema's default
  — every code path that creates a tag stamps a fresh id, but
  PM's fitter bypassed all of them). The nav-pane highlight skips
  id-less headings, so the cursor sitting in one of those cards
  used to show as being in the *previous* card. Loading a `.cmir`
  now walks the doc and stamps a fresh id on any pocket / hat /
  block / tag / analytic whose id came in null.
- **F2 plain-paste no longer occasionally elevates a pasted line into
  a card tag.** Pasting 3+ lines of plain text into a card body used
  to let PM's schema-fitting bubble the split up to the card itself —
  which produced either content escaping the card to the document
  level (the absorb plugin would clean it up immediately, but with
  visible artifacts during the dance), or in worst cases a card
  split where the second half's mandatory tag got synthesized from
  one of the pasted lines (the "line becomes a heading with extra
  spacing" report). The plain-paste path now uses the same pre-fit
  the rich-paste path has had for a while: the paragraphs in the
  pasted slice are converted to card-body nodes before insertion,
  so the schema accepts them in place and no split bubbles up. As a
  side effect, the cursor lands at the end of the pasted content
  rather than bouncing through the lift-and-reabsorb dance.
- **F12 (Clear to Normal) no longer rockets the cursor to the bottom
  of the doc when it dissolves a tagged card.** Cursor stays in the
  demoted (former-tag) paragraph at the same character offset, and
  when the dissolved card was preceded by another card so the demoted
  paragraph gets re-absorbed into that card, the cursor tracks into
  the absorbed body. Same family as the prior paste / F7 cursor-jump
  fix — that one made the absorb plugin's doc rewrite cursor-safe
  for positions OUTSIDE the absorbed orphan range; this one extends
  the same protection to cursors INSIDE the orphans (and to F12's own
  dissolve replace, which had the same root cause as the original
  absorb-plugin bug).
- **Dropzone pill no longer ends up in the status bar's band on some
  Windows machines.** Before its dynamic positioning pass had a chance
  to land, the pill fell back to a CSS bottom that put it ~8px above
  the viewport bottom — in the same vertical strip as the zoom
  controls and reader read-time readouts. On some Windows boots the
  positioning pass never recovered (target rect came back zero-sized
  at the moment it ran), so the pill stayed there. The CSS fallback
  now already clears the status bar, and the pill stacks above the
  bar if anything ever does push the two together.
- **Paste no longer drops an undeletable "intermediate line" below a
  tag/cite.** Sources that wrap content in layout tables — Google Docs
  published views, news-site article bodies, marketing emails, .docx
  page-frame copies — used to leave their wrapping single-cell `<table>`
  intact on paste. Visible as either an empty, undeletable gap (Backspace
  / Delete would expand to swallow the whole card instead of removing it),
  or as text that looked inset from a real card body with a small extra
  vertical gap above it (the table cell's own padding / borders). Single-
  cell layout tables — and any table whose every row holds exactly one
  cell — now unwrap on paste, lifting their paragraphs out into normal
  body text. Real data tables (any row with two or more cells) pass
  through unchanged.

## 0.1.0-alpha.5 — 2026-05-29

### Added

- **Learn — flashcards & review (early).** Turn evidence into spaced-
  repetition flashcards without leaving the editor.
  - **Create Flashcard** (a button in the ribbon's comments group, the
    command palette, or a bound key): with text selected, anchor a new
    card to it. Pick **Q & A** (a question and an
    answer) or **Cloze** (one sentence with the deletion wrapped in
    `{{double braces}}`). The answer field pre-fills with the selected
    text. Cards are due immediately.
  - **Review** from the Home screen's **Learn** section: a "Review all
    due" card plus a per-file / per-deck breakdown of whatever's due
    today. A session shows one card at a time — Space reveals the
    answer, then **1 = Forgot** / **2 = Remembered** (binary grading).
    A forgotten card comes back later in the same session.
  - **In the document** — open the comments pane and the text a card is
    anchored to is highlighted; the card appears in the column next to
    it, alongside any comments, and clicking it reveals the answer. Edit,
    suspend, or delete a card right there. If an edit (yours or a
    collaborator's) breaks a card's anchor, it drops into an
    **"Unanchored"** section at the bottom of the pane showing the text
    it was attached to, with a **Re-ground** button — select new text and
    click it to re-attach. It won't silently re-attach to an unrelated
    passage that happens to share the same words. A broken anchor never
    affects the card's review schedule.
  - **Manage flashcards** (Home → Learn, or the command palette): browse
    every card grouped by the file it's anchored to — so you can see
    which cards belong to which document — filter by text, edit a card's
    question/answer, suspend/resume it, or delete it. **New card** makes
    a standalone card not tied to any document. Cards shared across files
    (via Save As) are marked, and an "Unanchored" group collects
    standalone cards and any whose text reference is gone. An unanchored
    card has a **link** button: pick a file to attach it to (CardMirror
    quietly tags the file with a hidden id if it doesn't have one), then
    ground it to specific text later from inside that file. **Export** and
    **Import** buttons save all your flashcards to a file / load them
    back: import **adds** cards (it never overwrites or replaces what you
    have), carrying each card's review schedule and its text groundings,
    and tolerates older export files.
  - Flashcards live in a **private, per-user layer on your machine** —
    they are never written into the document and never travel in
    comments, so sharing a `.docx`/`.cmir` never leaks your cards.
    Documents keep a stable hidden id (it survives a round-trip through
    Word) so your cards re-associate with the right file; the id is
    written into the file as soon as you create or link a card (no
    separate save needed). **Save As** forks a copy's cards alongside the
    new file. Works the same in single-document windows and the
    multi-pane workspace.

- **Smoother comments column** — comment (and flashcard) cards now shift
  around each other smoothly when one expands, collapses, or changes
  height, instead of jumping, and stay reliably positioned next to their
  text as you edit. Typing in a reply no longer loses focus on unrelated
  updates.

- **Modern icons** — the toolbar, banners, dialogs, and status bar now
  use a clean line-icon set (Untitled UI) that takes on the active
  theme color, replacing the old mix of emoji and text symbols. New
  under Settings → Appearance → **Icon style**: pick **Modern** (the
  new default) or **Classic** to bring back the original emoji/text
  glyphs. The choice affects the app's chrome only — your documents are
  untouched.

- **Bulk convert** (desktop) — a Home-screen button (under its own
  "Convert" heading, beside Quick Cards) that batch-converts between
  `.docx` and `.cmir`. Choose the direction, an input (a single file or
  a whole folder, recursed through subfolders), and a destination
  folder; then Convert. Output is either loose files (swapped
  extension, mirroring the input's subfolder structure) or a single
  `.zip`, both written into the destination you pick. The chosen input
  and destination paths are shown before you convert. Comments carry
  across the conversion. Esc closes the dialog without also dismissing
  the Home screen behind it.

- **Keyboard macros** — in **Settings → Keyboard shortcuts**, a new
  section below the shortcut list lets you bind a key to **type a snippet
  of text** at the cursor. Click **Set shortcut**, press your keys, type
  the text — done; add as many as you like. Handy for repetitive
  insertions you'd otherwise retype by hand. A macro key takes
  precedence over any command bound to the same key.

- **Export / import settings** — at the bottom of **Settings → General**,
  **Export settings…** saves everything (keyboard shortcuts, macros,
  appearance, and the rest) to a JSON file; **Import settings…** replaces
  your settings from a file. Import is version-tolerant: settings added
  since the export fall back to their defaults and ones removed since are
  dropped, so an old export still loads cleanly. Your Anthropic API key is
  never exported, and importing keeps your current key.

- **Quick Cards** — a persistent, cross-window library of reusable
  rich-text snippets (think Verbatim's quick cards), reached from a
  new 2×2 ribbon cluster (Search / Tag Picker / Manage / Add) between
  the speech-doc buttons and the structural styles.
  - **Add** (button, or bind a key in Settings → Keybindings): with
    text selected, save it as a quick card. The name pre-fills with
    the smallest enclosing heading; you can tag it (Enter or comma
    between tags). A name may repeat only if its tags differ.
  - **Tag Picker** (🏷️): choose which tags are in scope for search —
    handy when, say, several aff files each have a "2AC" card. The
    filter is global and persists.
  - **Manage** (🗂️, or the Home screen): a full-window browser to
    edit a card's name / tags / content (in an embedded editor),
    delete, and import/export as JSON.
  - Quick cards persist across sessions and are shared live across all
    open windows. Inserting into the middle of a paragraph asks for
    confirmation first; disable that via **Settings → Editing →
    "Skip mid-text confirm when inserting quick cards."**

- **Search — a command palette** (**Ctrl/Cmd+Shift+Space**, or the 🔍
  button in the Quick Cards ribbon cluster; press again to close): a
  floating palette over the current document that searches *everything*
  at once — quick cards, the dropzone, commands, settings, and files.
  Type to search across all of them, or scope to one source with a
  prefix — `q ` for quick cards, `d ` for the dropzone, `c ` for
  **commands** (anything bindable to a keyboard shortcut; the result
  shows its current binding, and selecting it runs the command), `s `
  for **settings**, and `f ` for **files** (desktop). Matches on name
  first, then contents; ↑/↓ to move, **Enter** to insert (or run a
  command / open a setting / open a file), **Alt+Enter** to insert at
  the end of the doc, Esc to close. **Tab** jumps to an inline tag
  filter (type to filter, ↑/↓ + Enter to toggle, Esc to return).
  - `s ` **settings** finds both the top-level settings sections
    (General, Appearance, …) and individual settings by name; selecting
    one opens that tab, scrolled to and briefly highlighting the setting.
  - `f ` **files** (desktop) finds `.cmir` files by name under a folder
    you set in Settings → General → "File search folder" (searched
    recursively). Enter opens a file in a new window (or the slot picker
    in multi-pane), leaving your current document untouched; **Tab**
    dives into the highlighted file. With the bar empty you get the
    file's outline (its pocket → hat → block → tag hierarchy, indented
    like the nav pane) to browse — right-click (or click the chevron on)
    any pocket / hat / block to expand or collapse it, and set how deep
    it opens by default via Settings → General → "File search: default
    outline depth" (default Block, the same idea as the nav pane). Start
    typing to search the cards, blocks, and cites inside the file.
    Inserting a match (Enter, like a quick card) keeps the palette open
    and the file loaded, so you can pull several blocks in a row —
    Ctrl/Cmd+Z undoes the last one without leaving the bar; Esc returns
    to the file list with your prior search intact. Which object types
    appear in search is configurable in Settings. The file list is
    cached between searches (and across launches), but there's no content
    index yet, so the first dive into a large file may feel slow.
  - **Pinning / warm files:** to make the files you use most feel
    instant, CardMirror keeps a small set "warm" (parsed and held in
    memory). **Pin a file** with the ★ on its row or **Alt+P** — pinned
    files stay warm and float to the top of `f`. It also auto-warms your
    recent and frequently-used files (the most recent 6 + up to your top
    10 by use); turn that off in Settings → General → "File search:
    auto-pin recent & frequent files" if you'd rather keep only
    hand-pinned files warm. Warming happens quietly in the background —
    at launch and as you work, in the editor's idle moments — so it never
    interrupts typing or stutters when you open the search box. Diving
    into a warm file is instant — no re-parse.

- **Select Current Heading** and **Copy Current Heading** commands.
  Each acts on the card, analytic, or heading (plus its subtree) your
  cursor is in — the same structure Send to Speech / Send to Dropzone
  target. They key off the cursor and **ignore any active selection**. 
  "Select" highlights that structure; "Copy" puts it on the
  clipboard without moving your cursor. Both ship **unbound** — assign
  keys via Settings → Keybindings.

- **Home screen.** Launching CardMirror without a file now opens
  a start screen instead of a blank document: New document, New
  speech document, Open, and a list of recently opened files
  (click to reopen in place). A **Home button** (🏠, in the
  ribbon's top-right button cluster; rebindable via Settings →
  Keybindings) returns to it any time — with a "Back to document"
  link and Esc to dismiss back to what you were editing. On the
  home screen, the number keys trigger the action cards in reading
  order — **1** New, **2** New speech, **3** Open, **4** Manage quick
  cards, **5** Bulk convert, **6** Review all, **7** Manage flashcards
  (each only while its card is shown).
  **Ctrl+W** (single-doc) now closes the current doc back to the
  home screen rather than closing the window (the window's close
  button still quits); confirms unsaved changes first. Available
  in multi-pane mode too — there the Home button's actions route
  through the slot picker instead of loading in-place. Recent
  files persist across restarts. On the web edition, recents show
  but can't be reopened directly (browser file handles aren't
  persistable yet).

- **Grayscale text antialiasing on high-DPI displays** (DPR ≥
  1.5 — Retina, most modern phones, HiDPI Windows / Linux
  scaled past 150%). On those displays the chrome and editor
  text now render with `font-smooth: grayscale` (via
  `-webkit-font-smoothing` and `-moz-osx-font-smoothing`),
  which matches the macOS system default since Mojave and
  produces a thinner, lighter glyph consistent with the rest
  of the OS. Low-DPI displays keep the browser-default
  subpixel rendering, which is crisper at that resolution.
- **Dropzone shelf** — opt-in floating pill in the editor's
  bottom-left corner (Settings → Appearance → "Show dropzone shelf in
  nav pane"; **default off**). When enabled, drag any card or
  heading onto the pill to absorb it into a cross-window shelf;
  click the pill to expand the shelf in place, click an item to
  insert it at the cursor (Alt+click to insert at end of doc),
  or drag an item out to drop it at a specific position in the
  editor / nav pane. **Ctrl+\`** (rebindable as `sendToDropzone`)
  sends the current selection or enclosing card/heading to the
  shelf even when the pill is hidden — items pile up in the
  store and become accessible the moment any window turns the
  pill on. Card items show the same tag + cite preview the nav
  pane uses; pocket / hat / block / analytic items show the
  heading text only. Shared across every CardMirror window in
  the same session; survives the renderer reload that toggling
  multi-pane mode triggers; does NOT persist between app
  restarts. On web, single-window only with `sessionStorage`
  survival.
- **Searchbar on Settings → Keybindings and the Keyboard
  Shortcuts reference modal.** Filters rows live against the
  command label AND its current keybinding text (searching "f7"
  surfaces every command bound to F7; "highlight" surfaces
  every command whose label contains it). Empty group sections
  collapse out of view so the surviving rows always read as a
  single coherent list.
- **Application menu bar overhaul** (desktop app):
  - **File** is now Open / New / Save / Save As / Toggle
    Autosave / Close.
  - **New Speech menu** between File and Edit holds the four
    speech-cluster actions plus a new **Select Speech Doc…**
    entry.
  - **Edit's Redo** is now `Ctrl/Cmd+Y` (was `Shift+Cmd/Ctrl+Z`;
    both still fire redo via the editor's keymap).
  - **View's Zoom In / Out / Reset** now point at the editor's
    `chromeScale*` commands (so the menu accelerators match what
    the keys actually do, instead of triggering Chromium's
    separate page-zoom).
  - **Window menu removed.**
  - **Help** gains Settings and Keyboard Shortcuts entries at
    the top.
  - **Every menu accelerator now tracks your current keybinding.**
    Rebinding a command in Settings → Keybindings updates the
    accelerator label shown next to its menu item — including
    the previously-static File entries.
- **Select Speech Doc** (Speech menu): new modal that lists
  every open document across every CardMirror window, marks the
  current speech doc with a gold accent, and lets you reassign
  or clear the designation. Picking a doc doesn't switch you to
  it; you stay where you are. No default keyboard shortcut —
  rebind via Settings → Keybindings if you want one.
- **Ribbon tooltips are now configurable** in Settings →
  Appearance → "Ribbon tooltips," with four modes:
  - **Label and shortcut** (default) — `Apply Tag Style (F7)`.
  - **Label only** — just the action name.
  - **Shortcut only** — just `F7`; buttons without a shortcut
    show no tooltip.
  - **No tooltips** — disables ribbon tooltips entirely.
  
  The displayed shortcut now tracks user rebinds (Settings →
  Keybindings) for every ribbon button, not just the
  formatting-panel buttons. Dropdown menu items (Doc / Card /
  Table) now also expose the current shortcut on hover —
  shortcut-only on those, since the menu label already says
  what the action does.
- **Interface font is now configurable** in Settings →
  Accessibility → "Interface font." Pick any of the body-font
  picker's familiar groups (readability fonts, Office defaults,
  Apple defaults, etc.) and the choice cascades to every UI
  surface — ribbon, dialogs, navigation pane, comments column,
  status bar, menus, tooltips. Default is the platform's
  system-UI font stack so the chrome blends with other native
  apps; "System default" stays selectable as a sentinel to
  return there. Independent of the editor body font.
- **Highlight Acronym command (Alt+F11).** Counterpart to
  Emphasize Acronym (now Alt+F10): expands the selection to
  whole-word boundaries, then applies the active highlight color
  to the first character of each word. Useful for visually
  popping the source letters of an acronym ("United States
  Capitol Police" → U, S, C, P each carry the active highlight).
  Unlike Emphasize Acronym, this works in structural blocks
  (tags, analytics, pockets) too, since highlight is a runtime
  annotation rather than a body-only named style.

### Changed

- **Find now walks the document top-to-bottom from your cursor.** Both
  Find modes used to rank matches by closeness to the cursor (nearest
  first, in either direction), so stepping through hits jumped around.
  Now they go in document order starting at the cursor and wrapping to
  the top: **Ctrl+F** still groups by category (headings, then tags, then
  cites, then everything else) with each group in document order;
  **Alt+F** ignores categories and runs straight down the document from
  the cursor (its command is now labeled "Find Without Category
  Grouping").

- **Comments, flashcards, and AI notes now share one card design.** Every
  card in the comments pane leads with a small **type chip** — `COMMENT`,
  `Q&A`/`CLOZE`, or `AI` — color-matched to the highlight it sits on
  (gold / blue / purple). Collapsed cards show just the chip and a
  one-line preview; expanding a comment or AI note brings back the round
  author avatars, so the question that *opens* a thread reads apart from
  the replies (an AI note's first question is no longer styled as a reply
  to nothing). The open card now glows in its own color. Delete is an `✕`
  on comments and AI notes and a confirm-press **Delete** on flashcards;
  on an AI note, **Convert to Flashcard** is now a prominent button under
  Reply. The reply box now has a compact **send** button at its right
  edge, and each card shows its date next to the type chip.

- **"Ask AI about selection" notes are now private to you.** AI
  explanations no longer live as comments in the document — they're kept
  in the same per-user, on-your-machine layer as flashcards, so they
  never get written into a `.docx`/`.cmir` you share (sending a file
  no longer leaks your AI Q&A). It works the same as before: select
  text, ask, and follow up in a back-and-forth — but the thread shows
  up as a purple note in the comments pane, under your AI persona's name
  with an **AI** chip (no more `(AI)` tacked onto the name), anchored to
  the text and following it as you edit (dropping into the **Unanchored**
  list with a **Re-ground** button if its text is deleted). Existing AI *comments*
  in older documents are left as-is. (Typing `@AI` inside a regular
  comment still works the usual way, as a comment.) **Ask AI about
  selection** has a ribbon button now (in the comments group, shown only
  while AI features are enabled), alongside Create Flashcard. An active AI
  note also
  has a **Convert to Flashcard** button: it asks the AI for a flashcard
  (a Q&A or a cloze, whichever fits) capturing what you were exploring —
  drawing on your questions and the card's tag to aim at what *you* cared
  about — then opens the create-flashcard editor pre-filled so you can
  tweak or just confirm. The new card is anchored to the same text as the
  AI note.

- **Save As dialog reorganized around presets.** **Name** and
  **Format** sections sit at the top; a **Save** section below
  offers three one-click save buttons — **As-Is** (everything),
  **Send Doc** (excludes analytics, undertags, and comments), and
  **Read Doc** (exports the read-mode view), each with a short
  description beneath it — saving immediately with the name and
  format above. A **Custom Save** block (comments / analytics /
  undertags checkboxes + a **Save Custom** button) remains below for
  hand-picking what to keep; Cancel sits at the bottom. The separate
  read-mode checkbox is gone, folded into the Read Doc preset.
  Saving via the **Send Doc** / **Read Doc** presets prepends
  `SEND_` / `READ_` to the file name (e.g. `SEND_1AC.docx`) by
  default — toggle off via **Settings → General → "Prefix preset
  saves with SEND_ / READ_"**. As-Is and Save Custom are never
  prefixed.

- **Emphasize Acronym moved from Ctrl+F10 to Alt+F10.** Frees
  Ctrl+F10 and makes room for Highlight Acronym on Alt+F11
  next to it. Rebind via Settings → Keybindings if you've been
  using the Ctrl chord.

### Fixed

- **Double-clicking a heading in the navigation pane reliably collapses
  / expands it.** The first click jumps the editor to that section,
  which used to re-render the outline a beat later and swap out the row
  you'd clicked — so the second click of a double often landed on a fresh
  row and the browser never registered the double-click. Double-clicks
  are now detected directly and survive the re-render, so collapsing /
  expanding from the outline works every time.

- **Settings: the selected-tab underline shows on every tab.** The blue
  active-tab line could vanish on tabs the tab strip has to scroll to
  reach (Keyboard, Comments & AI) — a scrolled tab strip was clipping the
  1px the underline overlaps the divider by. It now shows at any window
  width / scroll position.

- **Your selection stays visible when a palette or the find bar opens.**
  Selecting text and then opening the command / search palette (or any
  panel that takes keyboard focus) used to grey out or hide the
  selection, because the editor lost focus. It now stays highlighted, so
  you can see what a command will act on.

- **Pasted sections now work in the navigation pane.** When you copied
  pockets/hats/blocks (and the cards under them) from one document and
  pasted them into another, the pasted headings were inert in the
  destination's outline — you couldn't expand/collapse them (they stayed
  permanently open), couldn't jump to them, and the 1/2/3/4 level buttons
  ignored them. Pasted headings now get fresh internal ids (the copy step
  was dropping them), so they behave like any other heading.

- **After dragging a card to a new spot, the editor jumps to it.**
  Previously the view jumped to a seemingly random place after a
  drag-and-drop (it followed wherever your cursor happened to be before
  the drag, not the moved content), so a successful move often left you
  looking at the wrong part of the document. Now a drop lands you exactly
  where clicking that section's heading in the outline would — its first
  heading pinned to the top of the view — for both moves and copies, in
  single-document windows and across panes.

- **The outline's blue "you are here" highlight now follows big edits.**
  After a structural change like dragging a section to a new spot, the
  navigation pane could highlight the wrong heading (it scanned cached
  positions that hadn't caught up with the move) and stayed wrong until
  you next moved the cursor. It now re-checks once the outline rebuilds,
  so the highlight lands on the heading your cursor is actually in.

- **Large `.docx` files no longer fail to open with "Entity
  expansion limit exceeded".** The XML parser shipped a "billion
  laughs" safety cap that counted every ordinary `&amp;` / `&lt;` /
  `&gt;` / `&quot;` / `&apos;` toward a 1000-per-document budget, so
  big files (multi-tournament affs, large generics) tripped a
  malware-defense limit on perfectly valid content. The cap is
  lifted for import — standard entities are harmless 1:1
  replacements, and the documents we open are trusted local files.
- **Saving a Send Doc / Read Doc no longer renames the document
  you're working on.** Previously, saving via a content-dropping
  preset (or a partial Save Custom) rebound the open document's
  identity to the exported file's name — so the working doc thought
  it was named e.g. `SEND_1AC`, and trying to open that export was
  blocked by the "already open" guard. Now only a full-fidelity save
  (everything included, not read-mode) adopts the saved file as the
  document's name/handle; a derived export writes its own file
  (and shows up in Recent) while the working doc keeps its name,
  unsaved-changes state, and crash-recovery journal.
- **Settings → Keybindings list stays put when you rebind.**
  Capturing a new shortcut (or hitting × on a chip, or ↺ to
  restore defaults) used to rebuild the list and snap the
  panel back to the top — losing the row you were working on.
  The rebuild now preserves the surrounding scroll position.
- **Settings modal tab strip now scrolls with arrows instead
  of overflowing the dialog.** When the dialog is narrow enough
  that the tab labels don't fit, a left and right arrow appear
  on either side of the tab list; clicking either scrolls the
  tabs by about half the visible width. Each arrow disables
  when there's nothing more to scroll in its direction. When
  the tabs fit, the arrows disappear entirely. No native
  scrollbar.
- **Ribbon panel button gaps are now consistent** across every
  multi-button panel. The color panel was 4px and the
  format-menu panel (Table / image / sub / sup / strike) was
  2px while every other panel used 3px; both now use 3px so
  the spacing rhythm reads the same from left to right. Row
  gaps were already a uniform 2px and are unchanged.
- **Formatting panel (Pocket / Hat / Block / Tag / Analytic /
  Undertag) buttons are now equal-width**, so the visual
  rhythm between Pocket → Hat → Analytic stays uniform whether
  style preview is on or off. Previously the columns auto-
  sized to their widest occupant (Block is narrower than
  Analytic, so col 2 ended up tighter than col 3), and with
  style preview off the eye picked that up as asymmetric
  spacing.
- **Timer toggle now sits 3px from the settings / shortcuts
  stack** on the right side of the ribbon (was 5.6px from the
  default `.ribbon-section` flex-gap), matching the intra-
  panel column-gap used everywhere on the left side.
- **Ribbon panels now collapse one panel sooner**, so the
  rightmost visible panel no longer sits flush against the
  right-pinned buttons (timer / settings / reference). The
  progressive-hide overflow check reserves a small buffer —
  matched to the column-gap *inside* a single panel — so the
  spacing between the rightmost panel and the pinned right
  elements reads as the same visual unit as the spacing
  between buttons within a panel.
- **F9 / F10 / F11 (and the other formatting commands) now
  format a deliberately-selected trailing space instead of
  no-op-ing.** The Layer 3 trim that shaves the absorbed
  trailing space off a word selection used to fire even when
  the entire selection was whitespace, turning the operating
  range into empty and causing the command to no-op. The trim
  now skips when the range minus its trailing space has no
  non-space content — so selecting just ` ` (or any all-
  whitespace run) formats the spaces. Selections with word
  content still get exactly one trailing space shaved, same as
  before.
- **AI cite creator always lands the formatted cite in its own
  paragraph.** Previously, if the selection ended mid-paragraph
  or spanned a paragraph break, the formatted cite would inherit
  whatever trailing text was left in the textblock and merge
  with the paragraph after. The cite is now split out cleanly:
  any pre-cite text in the surrounding textblock stays as its
  own paragraph before, any post-cite text stays as its own
  paragraph after, and the cite is alone in the middle.
- **Viewport no longer rockets to the doc end after a paste or
  F7 wrap that triggers card-body absorption.** The card-body
  absorption rule (paragraphs and friends after a `card` get
  absorbed into it) was wholesale-rewriting the doc in a single
  `replaceWith(0, content.size, rebuilt)` transaction, and PM's
  default selection mapping for that shape pushed the cursor to
  the END of the rebuilt content. Absorb now does the same
  rewrite as two surgical steps per region (insert the absorbed
  bodies inside the card, then delete the doc-level orphans), so
  PM's mapping leaves the cursor in place. Affects any sequence
  that creates absorbable doc-level paragraphs near the
  cursor — F7 above orphan paragraphs, paste that lifts content
  to doc level, manually-built docs with pre-existing orphans.
- **Pasting multi-line text into the middle of a card_body that
  has sibling card_bodies no longer splits the card.** PM's
  default slice fitting was bubbling the multi-paragraph split
  up to the card level, producing a phantom empty-tag card
  carrying the trailing siblings. The paste handler now
  pre-fits the slice into `card_body` children when the cursor
  is in a card_body context, so the split stays cleanly inside
  the card.
- **Copy Last Cite now lands where the cursor visually is when
  the cursor sits at the start of a paragraph.** Previously, at
  offset 0 of a body / cite / undertag / doc-level paragraph,
  the new cite was inserted AFTER that paragraph — so in a
  multi-paragraph card with no cite, putting the cursor at the
  start of the first body and copying the last cite sent the
  cite to the wrong slot (between body 1 and body 2 instead of
  between the tag and body 1). The command now inserts the cite
  BEFORE the paragraph in that boundary case. Cursor
  mid-paragraph or at the end of a paragraph still inserts
  after, as before.
- **Ctrl+Left / Ctrl+Right with an active selection now snap
  to the WORD edge of the selection's relevant corner**, instead
  of just collapsing to the corner. If the corner sits INSIDE a
  word (e.g., you've selected "The" inside "Therefore"), the
  cursor jumps to the end of that word (Ctrl+Right) or the start
  of that word (Ctrl+Left). If the corner is already at a word
  boundary, the keystroke just collapses there with no further
  motion — same as before. Shift-extend variants are unchanged.
- **Ctrl+Up / Ctrl+Down with an active selection no longer
  skips into the adjacent paragraph.** Same idea as the
  Ctrl+Left/Right change above, one notch coarser: snap to the
  start (Up) or end (Down) of the paragraph that's actually
  visually part of the selection. Ctrl+Down in particular knows
  that after Ctrl+Shift+Down the selection's bottom edge sits
  at the very start of the paragraph *below* the visual
  selection (because the extend goes to the next paragraph's
  start, not the current one's end) and snaps to the previous
  paragraph's end accordingly. Shift-extend variants are
  unchanged.

## 0.1.0-alpha.4 — 2026-05-22

### Added

- **Selection model now follows Word's actual rules instead of
  the browser's regex-style word boundaries.** Affects every
  spot where the editor decides "what counts as a word":
  whole-word Find / Replace, the F7 / F8 / F10 cursor-expansion
  commands, and the keyboard + mouse selection gestures
  described separately below. The rules in brief: letters,
  digits, `'` (U+0027), and `'` (U+2019) are word characters;
  `_`, `.`, `,`, `:`, `;`, `-`, em / en dashes, ellipses, and
  `'` (U+2018) are NOT (they break words). So `user_name` is
  two words, `1,234` is three, `U.S.A.` is three (each letter
  alone), `H2O` is one, `don't` / `we're` are one each.
  Whole-word Find of "don" no longer matches "don" inside
  "don't", and "user" now matches "user" inside "user_name".
  F10 Emphasize Acronym on "U.S.C.P." now emphasizes U, S, C,
  P (instead of just U).
- **Mouse selection now uses Word's selection state machine.**
  Double-click selects a unit (word + trailing space, with the
  spec's class rules — `don't` selects as one word, `U.S.A.` as
  three) and dragging extends word-by-word with the original
  word staying fully selected when the drag reverses. Single-
  click + drag starts character-granularity; pulling past the
  clicked word's boundary upgrades to word granularity (and
  pulls the rest of that word in); pulling back inside
  downgrades to character. Triple-click selects a paragraph;
  dragging extends paragraph-by-paragraph, and shift+click
  after a triple-click extends paragraph-by-paragraph the same
  way (matching triple-click + drag). Shift+click after a
  single or double click extends with whatever granularity was
  set (drag and shift+click are the same operation). Shift+
  double-click and shift+triple-click are no-ops.
- **Keyboard navigation now uses Word's per-unit nav.**
  - `Ctrl+Left` / `Ctrl+Right` (`Alt+Left/Right` on Mac): jump
    to the start of the previous / next unit using the
    spec-compatible word iterator (so `don't` is one unit,
    `U.S.A.` is three, `user_name` is two). Trailing space
    absorbs into the unit it follows, so one `Ctrl+Right` from
    the start of `help to` lands just before `to`, and the
    symmetric `Ctrl+Left` rewinds. With an existing selection
    and no Shift, `Ctrl+Left/Right` collapses to the
    appropriate edge (same as plain Left/Right) instead of
    jumping by a unit — matches Word. Shift-variants extend.
  - `Ctrl+Up` (`Alt+Up`): go to the start of the current
    paragraph; if already there, the previous paragraph (Word's
    asymmetric "stop on current first" behavior).
  - `Ctrl+Down` (`Alt+Down`): go to the start of the next
    paragraph.
  - `PageUp`: same shape as `Ctrl+Up` but at the heading level —
    go to the start of the current heading marker (the most
    recently passed pocket / hat / block / tag / analytic);
    if already there, the previous heading marker. Useful for
    skipping over body content to land on the next structural
    anchor.
  - `PageDown`: go to the start of the next heading marker.
  - All paired with `Shift+` variants that extend the selection
    instead of collapsing.
  - `Home / End` (visual line start / end) and `Ctrl+Home /
    Ctrl+End` (doc start / end) are left on the browser default,
    which already matches the spec.
- **Formatting commands skip the selection's trailing space.**
  When you double-click "word" Word selects "word + space" and
  bolding bolds the word only — that behavior now applies in
  CardMirror across every formatting command (bold, italic,
  underline, cite, emphasis, highlight, shading, font size,
  font color, clear-formatting, and friends). A multi-word
  selection like "the quick fox " loses the trailing space
  from the formatting only — internal spaces stay formatted.
- **Opening a file that's already loaded surfaces the existing
  copy instead of opening a duplicate.** Picking the same file
  from the Open dialog (ribbon or per-slot "+ Open file" button)
  brings the existing copy into focus, shows its slot if it was
  in a stack, and toasts "<filename> is already open." rather
  than spawning a second copy with its own undo history and
  edits. The guard covers cross-window duplicates too: opening a
  file that's already loaded in a DIFFERENT CardMirror window
  focuses that window for you instead of opening another copy.
  Files without an on-disk handle (never-saved docs) aren't
  deduped — they have no identity to compare against yet.
- **Comments work in multi-pane mode.** A single shared comments
  column sits to the right of the three pane slots — visually a
  narrow fourth slot that shrinks the doc slots equally. Threads
  shown follow focus: click, drag, Ctrl+Tab, or Ctrl+1/2/3 — the
  column repaints with the new doc's threads. Add Comment, Ask
  AI, and the comments toggle all work the same as in
  single-pane. Cards re-layout against the focused pane's scroll
  so each card stays aligned with the heading it annotates.
- **Ctrl+1 / 2 / 3 — focus the named multi-pane slot.** No-op
  when the slot is empty. Rebindable in Settings → Keybindings.
- **Ctrl+Shift+1 / 2 / 3 — send the focused slot's visible doc
  to slot 1 / 2 / 3.** Mirrors the Ctrl+1 / 2 / 3 focus chord.
  Source slot collapses to its next-visible doc or empties; the
  moved doc keeps its cursor, selection, undo history, and
  unsaved-edits state. No-op when the focused slot is empty or
  when the target is the source slot itself. Rebindable in
  Settings → Keybindings.
- **Ctrl+Tab / Ctrl+Shift+Tab — cycle docs within the focused
  multi-pane slot** (when the slot holds 2+ docs). Holding
  Ctrl after pressing Ctrl+Tab shows an Alt+Tab-style overlay
  centered over the focused slot's pane, with each doc in the
  stack listed top-to-bottom; each Tab while Ctrl is held
  advances the highlight, releasing Ctrl commits the
  highlighted doc as visible, Escape cancels. List items show
  the filename plus a small blue dot when the doc has unsaved
  changes. Wraps around at both ends. Web users without the
  chord (browsers reserve it for tab cycling): use
  Ctrl+Alt+Tab — same handler accepts both shapes, so it also
  works on desktop. The chord itself is fixed — hold-and-press
  semantics don't fit the discrete-press rebindable-command
  model.
- **Ctrl+Shift+F — toggle expand-mode** on the focused
  multi-pane slot (same behavior as clicking the chip's ⛶
  expand button). Rebindable in Settings → Keybindings.
- **Ctrl+W — close the focused multi-pane doc** (or the entire
  window if no slot is focused / the focused slot is empty).
  Rebindable in Settings → Keybindings.
- **Slot number badge on each multi-pane chip** — a small `1` /
  `2` / `3` glyph immediately left of the expand button.
  Disambiguates which slot a chip belongs to when only some
  slots are occupied.
- **Exported .docx files now open as Verbatim-ready.** When a
  Verbatim user opens a CardMirror-saved .docx in Word, the
  Debate ribbon activates immediately — no need to click the
  Verbatimize button first. Works on both Mac and Windows
  Verbatim installs. Verbatim's own files, manually-Verbatimized
  files, and CardMirror's now-Verbatimized files all read the
  same way for users.
- **Emphasize Acronym (Ctrl+F10).** New ribbon command. Select
  any text (or a partial word — the selection auto-expands to
  whole-word boundaries) and the first letter of every word in
  the range gets the Emphasis style applied. Useful for marking
  the source letters of an acronym: select "United States
  Capitol Police", press Ctrl+F10, and U / S / C / P are
  emphasized. Selection-only — no-op without a selection, and
  no-op if the selection is entirely whitespace.
- **Keybindings editor (Settings → Keybindings) is now grouped
  by category** — same 17-section taxonomy as the Keyboard
  Shortcuts reference modal (File, Speech, Structural styles,
  Character styles, Inline formatting, Condense, Editing
  utilities, Highlight tools, Color pickers & menus, Find, View,
  Zoom & scale, Comments, AI, Select, Cleanup, Table). Each
  group's heading sticks to the top of the scrollable list as
  you scroll. Previously the editor rendered every command as
  one alphabetical flat list.
- **Resizable comments column.** Drag the column's left edge to
  resize it (240 – 560 px). The col-resize cursor appears when
  you hover near the edge. Persists across sessions via the new
  `commentsColumnWidth` setting.
- **Nav-pane highlight follows the editor cursor.** Previously
  the blue highlight only updated when you clicked a nav-pane
  entry. Now it tracks whichever heading's section contains the
  cursor — moving the caret, typing into a new heading, clicking
  in the editor, and find-next all update the highlight.
  Ctrl/Shift-click multi-selection still works but collapses on
  the next caret move (matches "the highlight shows where the
  cursor is").

### Fixed

- **Round-tripped .docx files with hyperlinks no longer open as
  corrupted in Word.** URLs containing `&` (very common in
  query-string-heavy citation links — multiple `&`-separated
  parameters) were being written into the hyperlink Target
  attribute without XML-escaping, producing malformed XML.
  Word recovered the doc body but flagged it as corrupted on
  open, and images attached to that doc could fail to display.
  Now properly escapes `&`, `<`, `>`, `"`, and `'` in all
  hyperlink and image relationship Targets.
- **Plain-paste no longer jumps the viewport to the doc end.**
  Pasting text that contained a line break (the common case:
  triple-clicking an article title in the browser, which grabs
  a trailing newline) into a tag / cite / undertag / analytic
  used to split the surrounding card at the newline boundary
  and scroll-to-bottom. Plain-paste now flattens internal
  whitespace to single spaces (and trims edges) when the target
  is a single-line block; multi-paragraph blocks like card_body
  still preserve intentional paragraph splits from the
  clipboard.
- **Comments column now extends through the full scroll
  height.** Was rendering only at the top of the document and
  cutting off below. Same family of post-path-A regression as
  the multi-doc top-shift and recovery-sidebar offset fixed
  during alpha.3 — `#app` becoming the bounded scroller meant
  the inner flex layout's cross-axis was viewport-bounded,
  leaving the column's box (and background strip) stranded at
  the top.
- **Comments column on short / empty documents no longer looks
  truncated.** Inner layout now sizes to max(viewport, content),
  so the column's background fills the visible area even when
  the doc has nothing in it.

### Changed

- **AI comments are now identified by name and initials, not by
  an invisible flag** — the initials badge always reads `AI`, and
  the author name has `(AI)` appended (e.g. `Clod (AI)` when a
  custom persona name is set). Previously the AI-ness lived on a
  `kind` field that didn't survive a docx round-trip, so AI
  comments lost their purple styling after being saved to Word
  and re-opened. The new identifiers ride along through docx
  naturally. The small "AI" tag that used to appear next to the
  author name is gone — redundant now that `(AI)` is in the
  name itself. Existing AI comments saved before this change
  still display as AI through a legacy back-compat check.

### Removed

- **Bottom-left collapse/expand toggle in the comments column**
  (the small ▾/▴ circle). Active-comment collapse still works
  by clicking outside the sticky card; the "re-expand most
  recent thread" affordance the button provided is gone.

## 0.1.0-alpha.3 — 2026-05-21

### Added

- **Setting: Format nav pane entries by type** (Settings →
  Appearance, on by default). Turn off for a uniform nav-pane
  list where only indentation conveys hierarchy — no bold
  top-level headings, no analytic-blue accent, no per-level
  size shifts. Display-only; the underlying doc is untouched.
- **Setting: Check for updates on launch** (desktop only,
  Settings → General → "About this install"). Off by default —
  opt in if you want the app to check for a new release at boot.
  When enabled, the first window of each app session does a
  silent check; if an update is available, a modal pops with a
  link to the GitHub release page in your default browser.
  Subsequent windows in the same session skip the check (mirrors
  the first-window-only gating used by the doc recovery UI).
  Errors and "you're current" outcomes are silent on the
  auto-launch path — no notification noise when you're offline
  or already up to date. The manual Help → Check for Updates…
  and the Settings panel button still give full feedback for
  every outcome.

### Fixed

- **Help → Check for Updates now reports a result.** Every click
  now resolves to one of three dialogs: "You're on the latest
  version" (with the version number), "Update available" (with a
  button to open the release page on GitHub so you can read what's
  in it; the actual download proceeds in the background), or
  "Couldn't check: <reason>" with the Releases URL as a manual
  fallback. The previous silent-no-feedback behavior is gone.
- **About this install panel** (Settings → General) now lists
  Chromium and Electron versions as separate fields, alongside the
  existing app version + OS + user-agent. Makes "is the user
  running the version they think they are?" a one-line check
  during bug triage instead of a UA-parsing exercise.
- **Release workflow no longer races itself.** alpha.2's release
  produced two separate drafts because three OS matrix jobs
  concurrently saw "no release for this tag" and each created its
  own. A new `prepare-release` job runs first to create the draft,
  then the matrix jobs upload to it. No user-facing change; cleaner
  release ergonomics.
- **macOS scrolling, typing, and nav-pane click latency now
  match the in-browser feel.** alpha.2 on macOS was materially
  slower than the web edition on the same machine. Two
  coordinated fixes close that gap: the editor's scroll
  container migrated from the document itself to an inner
  bounded container (`#app`), which eliminated a doc-height
  composited layer Chromium was re-compositing on every scroll;
  and the bundled Electron version was upgraded from 33
  (Chromium 130) to 42 (Chromium 148), which lands the newer
  Skia Graphite compositor backend and the per-event decoupling
  improvements that make Chrome on macOS feel smooth on the
  same content. Linux and Windows builds also benefit but the
  gap was smaller there to begin with.
- **Keyboard Shortcuts cheat sheet now lists every bindable
  action.** The reference modal was hand-maintained and had
  fallen behind the keybindings registry — twenty-plus
  commands added in alpha.2 (zoom, chrome scale, paintbrush
  toggles, find, font color, the four picker openers, the
  three tools menus, and several others) weren't appearing.
  Now drives off the full registry and won't silently drift
  out of sync again.
- **Scrolling past the nav pane's top or bottom no longer
  scrolls the editor.** The wheel-event chain now stops at the
  nav pane's boundary, which also fixes the follow-up bug where
  reversing scroll direction kept scrolling the editor instead
  of the nav pane.
- **Open button on the web edition no longer silently drops your
  selection.** Clicking the 📂 Open button, picking a file, and
  ending up with nothing loaded — while `Ctrl-O` worked on the
  same page — was a race in the file-picker cancellation
  detection. Fixed by switching to the native `cancel` event.
- **Dark mode now guarantees readable text everywhere.** Three
  related fixes that together make dark-mode-with-apply-to-doc
  actually usable on real Verbatim docs:
  - Runs that Word writes with an explicit "default black" color
    (`w:color="000000"`) used to stay literally black, leaving
    large swaths of body text invisible against the dark
    surface. Now they inherit the themed text color and flip
    light.
  - Shading (Verbatim's "protected highlight" — yellow, grey,
    etc.) now forces text contrast like highlights already did:
    black on light shading, white on dark shading, regardless
    of theme.
  - Hyperlinks use a bright sky blue in dark mode (Word's
    `#0563C1` is too dark to read on a dark background).
  - Beyond those: any text color you (or Word) wrote that's
    too dark to read against the dark surface — Word's
    hyperlink blue, deep grays, dark reds — falls back to the
    themed text color. Turn off "Apply theme to the document
    area" if you'd rather see the original colors.
  - Underlines under highlighted / shaded text now match the
    text color (black on light backgrounds, white on dark),
    instead of staying themed-white and cutting through the
    black text like a faded slash.
  - The nav pane flattens to white in dark mode — the
    per-level greys and analytic-blue cues read as
    inconsistent against the dark chrome.
  - "Dark chrome, light document" mode (dark theme with
    "Apply theme to the document area" OFF — the default)
    now actually paints the document area white, across the
    full scrollable extent in both single-doc and multi-pane.
    Previously the editor surface had no background of its
    own and showed the dark chrome's color through it,
    defeating the whole point of leaving "apply to document"
    off.
  - Native form controls in dark mode now render in their
    dark variant. Previously the body-font dropdown in
    Settings → Appearance painted its select with the dark
    background-color token but left the option text in the
    browser's default near-black, making the font names
    invisible against the dark dropdown.

## 0.1.0-alpha.2 — 2026-05-20

### Added

- **Built-in countdown timer.** Native replacement for Verbatim's
  bundled timer. Toggle with the ⏱ button in the ribbon. Includes
  a big speech-timer display with start / pause, three speech-
  duration presets, Aff and Neg prep clocks, and a reset column.
  Type into the display while paused to set a custom duration.
  State syncs across windows. Configurable in Settings →
  Appearance: profile (High School / College / Pomodoro) with
  per-profile editable durations, compact layout, low-time flash
  with editable thresholds, and prep-side label style (Both /
  Text / Color).
- **Dark mode** (Settings → Appearance → Theme: Light / Dark /
  System). The document area stays light by default; flip
  "Apply theme to the document area" for full dark.
- **Chrome scale chord** (`Mod-Alt-=` / `Mod-Alt--` /
  `Mod-Alt-0`) scales the whole window the way your browser's
  `Ctrl-+` zoom does. Independent of the editor zoom
  (`Mod-=` / `Mod--`), so you can fine-tune content size on top.
  Keyboard-only — rebind in Settings → Keybindings.
- **Open with CardMirror from your file manager.** `.docx` and
  `.cmir` are registered as CardMirror file types at install
  time. Double-clicking a file in Finder / Explorer / your Linux
  file manager opens it in CardMirror — spawning a new window if
  the app's already running.
- **Find and Replace** (Ctrl-F / Ctrl-H / Alt-F). Floating bar
  with case-sensitive and whole-word toggles, next / prev
  navigation, a match count, Replace, and Replace All. Every
  match highlights in light yellow with the active match in a
  stronger orange. Three result orderings: categorized (Ctrl-F:
  headings → tags → cites → body, with the category priority
  reorderable in Settings → General), proximity-only (Alt-F),
  and the same categorized order in replace mode (Ctrl-H). The
  bar's expandable results panel lists every match at a glance.
  The nav pane decorates outline entries whose subtree contains
  a match. Find can be scoped to a selection.
- **Editable image alt text** — right-click an image →
  Edit alt text… opens a dialog. Alt text now round-trips
  through `.docx` import and export (the importer used to drop
  it). The AI alt-text generator also updates the image's alt
  attribute and asks before regenerating existing alt text.
- **Active doc filename in a ribbon pill** (opt-in, Settings →
  Appearance → "Show doc name in ribbon"). Useful where the OS
  title bar isn't visible — tiling window managers, hidden-title
  themes, embedded web edition.
- **Multi-pane window title shows every open slot**, joined by
  `·` — e.g. "Foo · Bar — CardMirror" — instead of just the
  focused doc's name.
- **Show / hide the nav pane.** Three ways to toggle: the ☰
  button in the ribbon, the × in the nav-pane header, or a small
  pull-tab on the left edge of the viewport (visible only when
  the nav pane is hidden). Per-window state.
- **Right-click on a hyperlink** opens a context menu — Open
  Link, Copy Link Address, Edit Link…, Remove Link.
- **About this install in Settings → General** — version, host,
  OS, and full user-agent for bug reports. On desktop, includes
  Check for updates and Open crash dumps folder buttons.
- **Every ribbon action is now keybindable** in Settings →
  Keybindings. Twelve previously click-only actions joined the
  registry: font-size step up / down, apply font color, open
  settings, toggle paragraph integrity, the four color/size
  picker dropdowns, and the doc / card / table tools menus.
- **Zoom and paintbrush toggles are keybindable.** Defaults:
  Mod-= zoom in, Mod-- zoom out. The reset chord and paintbrush
  toggles ship unbound (assign them yourself if you want).

### Accessibility

- **Reduce motion** (Settings → Accessibility). System (follows
  OS preference) / On / Off. Flattens UI animations.
- **Readability-tuned body fonts.** Three SIL-OFL fonts ship
  with CardMirror: **Atkinson Hyperlegible**, **Lexend**, and
  **OpenDyslexic**. Plus the British Dyslexia Association's
  endorsed system sans-serifs (Verdana, Tahoma, Comic Sans MS)
  when installed on your OS. Settings → Appearance → Body font
  groups options by category with the readability options
  leading.
- **Highlight + shading display overrides** with 1–3 ordered
  slots. Slot 1 remaps the most-common color in the doc, slot 2
  the next-most-common, last slot is a catch-all.
- **Per-token color overrides** for every UI color (background,
  borders, accent, hover, etc.) with reset-per-row + reset-all
  controls. Overrides win over the active theme.
- **Cursor-position color readout** in the status bar — when an
  override is active, shows the actual stored colors at the
  cursor so you know what's encoded in the doc even when the
  override is hiding it.

### Changed

- **Nav-pane heading clicks are dramatically faster on big
  docs.** Clicks where the heading is already visible are nearly
  instant. First click into a fresh part of the doc no longer
  adds a multi-second pause on top of the unavoidable rendering
  cost. (Previously every click cost ~2 seconds on a 2000-card
  file.)
- **Re-pressing a heading shortcut** (F4 / F5 / F6 / F7 /
  Mod-F7 / Mod-F8) on a paragraph that already has that style
  strips the paragraph's indentation while keeping the style.
  Was a no-op before.
- **F8 / Apply Cite Style** now expands to the word at the
  cursor when there's no selection — matching F10's behavior.
- **Shift-F3 (cycle case)** keeps the selection across cycles,
  so you can re-press to advance lower → UPPER → Title → lower.
- **Triple-click + drag** extends the selection paragraph-by-
  paragraph (was: collapsed back to character-level on first
  drag move).
- **Text-selection background is translucent** — highlights,
  shading, and other colored backgrounds show through. You can
  now tell at a glance whether selected text is highlighted.
- **Selected images** show a 2 px accent outline so it's
  obvious the click registered.
- **Paint mode cursor** is an I-beam with a small swatch of the
  active paint color in the corner. Picking a different color
  while paint mode is armed updates the cursor live.
- **Caret stays visible** after Enter / arrow keys / new-
  heading actions. The browser's auto-scroll-into-view now
  respects the fixed ribbon and status bar.
- **Window adapts to any size.** The 800×600 floor is gone, so
  the status bar stays visible on small / tiled / split-screen
  layouts. Ribbon panels hide progressively in a deterministic
  order when the ribbon runs out of room; settings,
  keyboard-shortcut, read-mode, and nav-pane buttons hide last.
- **New setting: default file format for new docs** — `.docx`
  (default) or `.cmir`. Affects the Save-As default for any doc
  that doesn't yet have an on-disk handle.
- **New setting: jump to doc top on read-mode toggle**, off by
  default. When on, toggling read mode scrolls to the top and
  places the cursor at the doc's start.
- **Word-count selection button (Σ)** moved off the ribbon to
  the left edge of the status bar, next to the live read-aloud
  word counter.
- **Speech-doc designation** uses the same warm-gold accent in
  both multi-window mode (the banner under the ribbon) and
  multi-pane mode (the per-pane chip).
- **Ribbon cleanup**: the plain-paste toggle (`T`) is hidden on
  desktop where F2 reads the clipboard directly. The autosave
  toggle is hidden on the web edition where autosave can't fire.
- **Keyboard-shortcut command labels** in Settings →
  Keybindings use consistent title casing throughout.

### Fixed

- **Toggling multi-pane → single-window mode no longer silently
  drops open docs.** Some panes' contents were lost on the
  switch back to one-doc-per-window.
- **Picking up a nav-pane heading and releasing without moving
  drops it back where it came from.** Used to land in a sibling
  slot.
- **Copy Last Cite now finds cite-marked text you just
  applied.** Previously, applying the cite style via marking
  text (rather than a paragraph style change) didn't promote
  the paragraph, so Copy Last Cite fell back to an older cite.
- **Underline / Emphasis font-size settings take effect.** The
  per-style size sliders for these two styles were silently
  ignored before.
- **Files from 2013–14-era Verbatim distributions import with
  underline / cite formatting intact.** Those distributions
  used older character-style ids that CardMirror used to skip
  silently.
- **AI alt-text descriptions reflect what the image is doing in
  the argument.** Generations now include the enclosing card's
  tag and cite, plus the paragraphs immediately before and
  after the image, instead of producing generic captions.
- **"New document" while CardMirror is already running no
  longer offers to recover docs from other windows.** Only the
  first window of an app session surfaces the startup-recovery
  sidebar.
- **Opening a doc starts both the editor and nav pane scrolled
  to the top** instead of inheriting the previous doc's scroll
  position.

## 0.1.0-alpha.1 — 2026-05-16

First downloadable preview of CardMirror. **This is an alpha.**
Expect bugs, missing features, and occasional breakage. Don't use
it for tournament-day work yet; keep a Verbatim copy of anything
important.

What works:

- Open and save Microsoft Word `.docx` files. Round-trips against
  Verbatim-format docs.
- Native `.cmir` format for lossless save / restore (no Word
  conversion costs, autosave-eligible).
- Verbatim-parity editing model: Pocket / Hat / Block / Tag /
  Analytic / Undertag styles, F-key shortcuts, condense /
  uncondense / case-toggle, emphasis / underline / highlight,
  shrink, send-to-speech, paste-as-plain.
- Multi-doc workspace — pick between a three-pane single-window
  layout or one window per doc.
- Send-to-speech across windows in multi-window mode.
- Per-doc read mode and autosave.
- Crash-recovery journal — unsaved drafts come back on next
  launch.
- Word-style left navigation pane: outline view, multi-select,
  drag-reorder.

Not in this release (planned):

- Full-text and schema-aware search across open docs / the
  evidence library on disk.
- Transclusion (live-linked content from a source doc).
- Cross-window drag-and-drop. (Cross-pane drag within multi-pane
  mode works.)

Operational:

- **Crash dumps** are collected locally to disk only — never
  uploaded anywhere. If CardMirror crashes and you want to send
  a report, open *Help → Open Crash Dumps Folder* and attach
  the minidump to a GitHub issue.
- **Auto-update**: on launch, CardMirror checks GitHub Releases
  for a newer version and downloads it in the background. When
  one's ready, a dialog asks whether to restart now or install
  on next quit. *Help → Check for Updates…* triggers the same
  check on demand.

Platforms:

- **macOS** — `.dmg` for Intel (x64) and Apple Silicon (arm64).
- **Windows** — NSIS installer (`.exe`) for x64.
- **Linux** — `.AppImage` (distribution-agnostic) and `.pacman`
  (Arch-native; install with `sudo pacman -U file.pacman`) for
  x64.

Known gaps:

- Desktop builds are unsigned. First-launch warnings on
  Windows (SmartScreen) and macOS (Gatekeeper) require a
  right-click → Open. See README.
