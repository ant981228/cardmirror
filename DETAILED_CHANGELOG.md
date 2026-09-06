# Detailed Changelog

In-depth release notes for CardMirror. Each entry covers the
behavior, rationale, and (where useful) the implementation context
behind a change. For a shorter, jargon-free summary of what's new
in each release, see `CHANGELOG.md`.

## Unreleased

### Added + Fixed: disk-conflict guard rework and the cloud badge

Users on shared Dropbox folders overwrote each other's `.cmir` edits
silently. Dropbox creates no conflicted copy when the winning version
has already synced down before the losing write, so nothing warned
anyone. The changed-on-disk guard existed, but its baseline was a
single main-process map keyed by path that EVERY read refreshed: the
quick-card warm pass (every window boot and every palette open reads
every pinned file, and every open file is pinned through recents),
transclusion resolution, the docId stamp, a second window's open. Any
of those, after a teammate's version had synced down, made that
version the baseline, and the next save passed the guard. The prompt
that did fire had Overwrite as the primary button.

The baseline now belongs to the window that owns the document. Reads
record only a candidate; a window promotes the candidate when it
registers the path after mounting (the same registration the
cross-window duplicate-open guard already required), and its own
writes refresh it. A save by a window that holds no baseline for the
path is refused the same way as a changed file: unknown is no longer a
bypass. Crash journals carry the owner's baseline, so a recovered
document registers with it; main adopts it when the file still
matches and otherwise reports the file as changed, so the first save
keeps both instead of overwriting whatever landed while the app was
down. Just before the rename that replaces the file, the writer stats
it a second time, which shrinks the check-then-write gap to the rename
itself.

Cloud detection classifies the resolved path against Dropbox's
info.json roots, the legacy `~/Dropbox`, macOS File Provider mounts
under `~/Library/CloudStorage`, iCloud Drive, the OneDrive environment
roots and Google Drive's letter mounts. For those documents one
main-process timer stats every open file every four seconds and pushes
a change to the owning window. It never reads bytes: a byte read of an
online-only placeholder on Windows forces hydration, the stall from the
August support case. A sync client touching a timestamp therefore shows
as a change; the save-time byte comparison corrects it.

The badge is a pill in its own fixed tray at the editor's bottom-right
corner, the mirror of the Send / Receive / Dropzone tray at the
bottom-left and styled as the same family (it started beside the
filename chip in the ribbon, which is opt-in and off by default, so it
floated beside nothing and was easy to miss; moved on review). One per
window, showing the active document's state (three-pane switches it
with focus). Cloud glyph plus the provider's name when synced, amber
with a relative time when changed, a "Conflicted copy" label when the
window is editing one. No toast,
modal or animation on a transition; the badge is frozen while read
mode or the timer pop-out is active and catches up afterwards. Clicking
the amber badge opens the route-style decision: Reload from disk
(withheld while hosting a co-editing session, with a note to end the
session first), Keep mine as a copy, or Overwrite behind a second
confirmation. A refused save, manual or autosave, writes the in-memory
document beside the original as `<name> (<user>'s conflicted copy
<date>).<ext>` with a numeric suffix on collision, and switches the
window to the copy so a second save cannot mint a second copy. The
pill's "Conflicted copy" state is the only announcement (a status-bar
notice was tried and dropped on review as redundant); the recovery
sidebar's Save, which mounts nothing, toasts the copy's name instead.
A copy of a conflicted copy, when someone changes the copy under the
window, is named as the next numbered copy of the original rather than
a nested name. The user name is the co-editing display name, else
the comment author name, else the computer account username, never
anything from the Debate Decoded account. Tests cover the owner-keyed
guard, the journaled baseline, the pre-rename recheck, copy naming, the
cloud classifier, the poller and the badge state machine. The web build
is out of scope: it has no equivalent guard and cannot poll a folder.

### Fixed: flashcards lost between windows (single-owner learn store)

The flashcard store (cards, schedules, anchors, notes, AI threads,
decks, the document registry) was one JSON blob that every window
loaded once at launch and rewrote in full on any change. Nothing told
other windows. Because merely opening a file registers it in the store,
a window that had loaded before another window created cards overwrote
those cards the next time it opened or saved a file; the first window
kept showing them until it restarted, so the loss surfaced at the next
launch, which is often an update. A read that failed for any reason
other than a missing file also started the app with an empty store and
let the next change overwrite the file with it.

Windows no longer write the store. A mutation on the window's copy is
applied locally, so callers can read back synchronously as before, and
the same call is sent as an operation (method name plus arguments) to
the single owner of the canonical copy. On desktop the owner is the
main process: it applies the operation, writes the file (debounced,
serialized, temp-and-rename), and broadcasts the resulting blob to
every window; a quit is held until a pending write lands. On the web
the owner is whichever tab holds a Web Lock for the write; the others
follow through the storage event. A window adopts a canonical blob only
while none of its own operations are in flight, so a reply that
predates a later local change never rolls that change back. The owner
keeps one backup per local day for two weeks, and a file it cannot read
or parse is set aside under an `.unreadable-` name before the first
write instead of being overwritten. The owner is bundled with esbuild
like the file-index service because it imports the shared store from
the editor tree, outside the desktop tsconfig's root. A test guards
that every store method which persists is in the operation list.

## 1.7.0 — 2026-09-05

### Added: choose which machine to unlink (seat picker)

A membership carries two machine seats. Linking a third used to evict
the least-recently-renewed seat with a yes/no confirm — which, for a
member who set up a laptop, a desktop and then a school machine, was
usually the machine they use most. The relay's seat-limit refusal now
carries the machines already linked (a device label the client reports
at link and refreshes on every renewal, the link date, and last
activity), and the client's Settings → Collaboration flow shows them as
a route-style list: pick the one to unlink, or cancel. The retry names
the chosen seat; if that seat vanished in between (unlinked from its
own machine, or evicted by a parallel link), the relay refuses again
with a fresh list rather than guessing. The web client offers the same
pick. Older clients keep working against the new relay — the legacy
"would evict" field is still sent, and a retry without a named target
still evicts the oldest. The relay side of this went live on 2026-09-04
ahead of the client.

Two adjacent seat fixes ride along. Regenerating a pairing code now
releases the old code's seat first (its identity row was left held, so
a regenerated machine's re-link counted as a THIRD machine and pushed
out one you still use). And a machine whose renewal the relay refuses
backs off — the client used to retry every few minutes for the life of
the process, which showed up in relay logs as a steady stream of 403s
from lapsed or unlinked machines.

Server-side, and independent of the client build: a membership that
lapses and later re-subscribes recovers its linked machines without
re-linking. Ghost now notifies the relay on member edits and deletions
(the relay's seat-eviction state is left alone by those notifications;
an earlier handler would have resurrected evicted seats), so the next
renewal after re-subscribing succeeds on its own.

### Added: Send to Recipient

Send to Starred sends the focused card or selection to the starred
contact. Send to Recipient is its keyboard sibling for everyone else:
it lists contacts and groups (type to filter), then sends the same
payload through the same path. Unbound by default; run it from the
command bar or bind a key in Keyboard settings.

### Fixed: the Send pill scrolls during a drag

Dragging a card onto the Send pill opens the recipient list, but a
native drag never fires scroll events, so any recipient past the first
screenful was unreachable. Holding the drag near the top or bottom
edge now scrolls the list on a frame loop and re-dispatches the hit
test as it moves, so the highlighted target follows the pointer.

### Fixed: co-editing — undo can no longer delete a partner's typing

Undo in a shared session is per-author, but a container is not: undo
your Enter-in-tag, card insert or card paste after a partner had
already typed into the card it created, and the card went away with
their text inside it, silently, on every peer. Undo/redo now run
through a guard that keeps a ledger of containers a partner has touched
(from the sync layer's import events; your own later edits clear a
mark). After each undo it checks which heading ids left the document;
if any of them is partner-touched, it reverses the undo on the spot and
shows a note. Undoing your own untouched edits is unchanged, and the
check is a microtask, not a keystroke cost. The chaos rig described
below drove this: the mechanism is deterministic, not a race.

### Fixed: co-editing — moves and splits keep cards' identities

When a card was moved or split while a partner was editing it, the sync
layer could fail to recognise the moved card as the same container and
rebuild it from scratch: a delete plus a fresh insert. The partner's
concurrent edit was addressed to the deleted container and vanished, or
their copy of the card survived alongside the rebuilt one. The binding
now reconciles a rebuilt container against the existing one in tiers —
equality, then a unique heading id, then text similarity, then
positional pairing of the same type — and reuses the existing
identity, so a move stays a move and a split keeps the first half.

### Fixed: co-editing — typed text no longer tears under a concurrent split or delete

The root cause behind most of the "lost a few characters" reports from
shared sessions. The sync layer turned every local edit into CRDT
operations by diffing the paragraph's before and after strings: common
prefix, common suffix, replace the middle. When the text you typed
began or ended with the same letters as its neighbour, the diff reused
part of the neighbour as "your" text and inserted a different slice as
new — visually identical, but the character identities were shuffled.
A partner splitting or deleting that neighbour at the same moment then
took a piece of your word with it, and the merge converged on the
damage. Deterministic reproduction: insert "«tk16» " before "«tk3»"
while a partner splits before "«tk3»" and you get "16» «tk" in one
paragraph and "«tk3» end" in the other. In prose that is any word
sharing its first or last letters with the next or previous one.

The ProseMirror transaction already says what changed, so the binding
now records each inline replace and each split per final paragraph and
applies them as exact delete/insert operations. A replace is first
trimmed to its changed middle WITHIN its own range — a command that
rewrites a whole tag head to drop the first word is a prefix delete,
and treating it literally would re-mint the kept tail on every peer
that runs it — and that bounded trim is the only place existing
identity is reused; it can never borrow from outside the step. Block
steps in the same batch (card inserts, moves, attribute changes) stay
with the container diff. Anything else (marks, joins, plugin repairs)
sends the whole batch to the old diff, and every exact result is
replayed against the ProseMirror text before it is written, falling
back on mismatch.

Verification: a new opt-in chaos rig runs real clients against a local
copy of the production relay through a fault-injecting proxy
(disconnects, reconnects, delayed deliveries, concurrent moves, splits,
duplicate pastes and undo), and an in-memory pairwise-sync fuzz runs
alongside it. Across the campaign nothing diverged, no heading id
duplicated and no schema-invalid document appeared; every loss traced
to the two mechanisms fixed above. One residual is documented rather
than hidden: two peers splitting the SAME paragraph before syncing each
copy its tail into their own new paragraph (a split is delete-plus-copy
in the CRDT, not a text move), so the overlap shows twice — visible,
and a one-keystroke fix for the user, unlike a loss.

### Fixed: Enter mid-tag keeps the number on the first half

Splitting a numbered tag or heading with Enter built the NEW container
with default attributes and inserted it before the original, so the
number rode the post-cursor half (field report 2026-09-02). The
pre-cursor half now inherits the original's attributes (numRole,
numRestart, and a block's numRestart) and the original — now the
second, new unit — resets to the type defaults. Same rule in
enterMidTag (cards, analytics) and enterInHeading (blocks, pockets,
hats).

### Fixed: co-editing liveness — deadlines, stall watchdog, restart debounce

Three wedge classes from the 2026-09-01 collaboration review, each
pinned by a reproduction that failed before the fix. No rooms request
had a deadline, and the send mutex and the correctness catch-up's
running flag clear only in `finally`, so a fetch that never settled
(half-open TCP after a lid close or a NAT rebind) wedged sending or
catch-up permanently: chip stuck on "queued N", no retry. Every request
now composes an abort timeout — 15 s for reads and small posts, 120 s
for the multi-megabyte update and snapshot posts, and (a knock-on found
in the audit that followed) the same long deadline for update PAGES,
which run to 4 MB and carry the room snapshot on the first one; under
the short deadline a big room on a slow link re-fetched the same page
into the same timeout forever. A deadline surfaces as the same
retryable error shape as a dropped connection. Second, the live stream
had no stall detection: heartbeats were dropped unnoted and the
self-echo watchdog arms only after WE post, so a reader-only peer never
noticed a dead socket. A silence watchdog (70 s, about 2.8 relay
heartbeats) restarts the stream, arming only after the first byte
following hello so a heartbeat-less relay degrades to the old behavior
rather than restart-looping. Third, restart() was undebounced: a wake
fires the power-resume and online events a beat apart and the second
aborted the handshake the first had just started; a 2 s window makes
the in-flight reconnect the restart, and tab-visible joined the wake
sources (a throttled background tab is where sockets go stale).

### Fixed: co-editing reconnect policy — backoff on survival, jitter inside the cap, crowded-out signal

Backoff reset on every hello meant a draining relay (accept, hello,
close — a Railway deploy) turned every client into a 1 Hz reconnect
plus catch-up loop, and the ghost streams that rate leaves behind
(reaped only per heartbeat) filled the room. The reset now waits for
the connection to survive 15 s; connections that die sooner keep
escalating. Jitter was applied after the clamp (a 60 s cap became 78 s)
and its ±30 % band put a whole fleet's first retry inside roughly
600 ms after a relay restart; it is now 30–100 % of the capped delay.
A reconnect refused as "room full" retried forever with the room-full
callback unreachable after the first hello, so a peer shut out of an
established session saw only a bare offline chip; after four
consecutive refusals a crowded-out notice fires once while retrying
continues. Joining gained the same resilience: the one strict initial
catch-up now retries up to three times with jittered backoff on
connection failures and 5xx only (a relay deploy's 502/503 used to fail
the join outright or, with a prefetched seed, silently open a possibly
stale offline copy); 401/403/404/409/410 stay terminal. All four
update-paging loops (catch-up, full resync, audit scan, invite
prefetch) now stop, with one warning, when a page says "more" without
advancing the cursor — a proxy-mangled body or a half-deployed relay
used to be an unbounded, undelayed fetch loop pinning the relay. On
web, an expired entitlement resolves to an empty credential by design,
but every request then went out as a literal empty bearer token and
401'd all night; an empty credential now fails locally and the stream
signals auth-dead immediately, keeping the backoff so a renewal or
re-link reconnects.

### Fixed: co-editing egress — coalesced sends, smarter catch-up, bucketed audit ledger

The outbound path pushed one queue entry per 500 ms tick and drained
them strictly one at a time, so ten offline minutes became ~1200
sequential posts, 1200 relay rows, and 1200 rows for every other peer
to fetch and decrypt. Every entry carries its starting version, so a
run now collapses into one export from the head's version (remote ops
imported since ride along; idempotent), with ack bookkeeping and
oversized-result chunking unchanged. Coalescing runs once per drain,
before the loop — per-iteration it re-merged the chunks it had just
split, forever. Catch-up used to re-fetch, re-decrypt and re-import
every row the stream had already pushed since its cursor, one awaited
decrypt at a time (up to 200 per page on the join path); frames the
stream delivered are now remembered by sequence and skipped, and the
rest decrypt in parallel. The half-hourly history audit had its own
timer, unaligned with catch-up, so its opening probe fetched every row
since a cursor that was minutes stale; it now runs behind a fresh
catch-up. The audit's tail ledger kept one entry per relay row with a
4000-entry cap, past which a busy five-typist room (about ten rows a
second, under ten minutes to the cap) forced the audit into a download
of the whole room — a partial return of the egress problem the
incremental audit was built to kill; rows now fold into buckets of 64,
pruned only once the verified snapshot covers them. Two unbounded
synchronous imports were bounded at 8 MB: the inbound micro-batch
buffer (a reconnect repost or the audit's full-history chunks landed as
one import of everything a 120 ms window collected) and the full-resync
escalation (which buffered every decrypted blob of the whole room and
then blocked the main thread on one giant import). Hiding the tab now
flushes unsent edits at once instead of waiting for the next tick, and
an oversized queue entry exports only up to its own version rather than
the live one.

### Fixed: the room log grew without bound (pending-imports latch)

The flag that blocks snapshot compaction while updates are still
missing was set on any import with parked ops but cleared in exactly
one place, inside the full-resync escalation. The common heal — a shed
frame's dependencies fetched by the ordinary catch-up — never reached
that block, so the flag stayed latched for the session and snapshot
upload returned early forever: the room log grew without bound, giving
slower joins, more egress and longer catch-ups for every peer, and a
likely contributor to the August volume incident. The session now keeps
the parked spans per peer, folds every import's status into that
ledger, prunes a span once the document's version vector covers its
end, and derives the flag from the ledger; the compaction guard itself
is unchanged. Two related holes: a catch-up requested while one was
running was discarded outright, including the "expect missing
dependencies" signal that forces a full resync, so recovery waited for
the five-minute timer — a concurrent request is now latched and re-run
once; and the catch-up skip list was populated BEFORE the import ran,
so a batch that failed on one corrupt frame had every row in it skipped
by every later catch-up, a permanent gap — sequences are recorded only
after the import succeeds.

### Fixed: co-editing performance on big documents

The repair plugin runs on every remote binding batch (up to ~8 per
second at the default receive window) and each pass walked the ENTIRE
document three to five times on a tournament master: exclusive-mark
sweep, table normalization, heal-sentinel canonicalization, the
leader's first-child sweep, and the sentinel notice scan — whose
"cooldown gate" was not a gate, because its timestamp was stamped only
after a heal was found. Every sweep is now bounded to the batch's
changed ranges (the soundness argument fixTables' bounded path already
rests on: a violation a merge creates lies inside that merge's changed
region), with import and open keeping the full scan as the backstop.
The causal heal's first pass decoded the full op log inside the ~10 s
join freeze because the binding's init transaction has the whole
document as its changed range; that transaction is skipped (verdicts
are a pure function of op history and the fail-safe direction is
keep), the history index is built at idle after mount, and per-pass
costs that grew with session length are now flat. The vendored cursor
plugin decoded every peer's anchor and focus in wasm several times per
rebuild and built a fresh caret element per peer per rebuild, so
ProseMirror re-inserted every remote caret on every remote keystroke;
the store now memoizes until the next mutation and the same caret
element is returned while a peer's name and color are unchanged.
Status notifications while typing rebuilt every slot footer and the
chip's presence dots on every keystroke; copresence notifications
coalesce leading plus trailing per 150 ms, byte-identical statuses are
skipped, and the dot roster is signature-compared before touching the
DOM. Crash-recovery persistence wrote on a flat 2.5 s interval
regardless of size, structured-cloning a multi-megabyte record and
rebasing onto a full snapshot export every 40th write (0.3–0.8 s of
synchronous wasm on a 20 MB master); it now slows to 10 s past 4 MB and
shares one memoized snapshot export with version history. Both durable
writers treated tab-in as "flush now" as well as tab-out, so
alt-tabbing back to a big co-edited document froze the renderer; they
fire on hide only. Base64 decoding of compaction snapshots uses the
platform's native codec when present. Credentials are resolved once per
request instead of three times (at cursor-presence rates on the typing
thread), with no memo, so a settings write still reaches the very next
request. Comments no longer dispatch a transaction on every peer when a
remote event derives an identical thread set, and the session-history
dialog imports its source snapshot once per open instead of once per
preview click.

### Fixed: co-editing problems are reported, not swallowed

A send that kept failing retried the same queue head forever while the
queue grew behind it and nothing told the user; the session now counts
consecutive failures and, past a threshold of about a minute, the UI
posts a keyed "Edits aren't reaching the session" notice that clears
when a later send succeeds. Offline showed only as chip text (five
seconds and forty minutes read identically), so after three minutes
disconnected a notice names the duration and the queued edit count.
Both durable writers swallowed storage errors by design, so a full disk
or a denied IndexedDB quota silently disabled crash recovery and
Recover Previous Version for the whole session; three consecutive
failures now post an "isn't being saved" notice. Relay errors carry the
relay's own detail (a 413 alone covers "update too large" and "room
storage cap reached"; pool exhaustion is a distinct 503), and the
stream's early-return branches cancel the response body instead of
holding a pool connection until garbage collection, one per retry, for
hours during an outage. The transport and stream keep live counters
(requests, failures by class, last error, last success) folded into the
debug state, and the failure paths that used to be bare catches warn on
first occurrence and every fifth after. A comment edit the room silently
dropped (its thread container gone) now warns and is counted.

### Fixed: co-editing presence and lifecycle races

Leaving a session sent no departure: the ephemeral store's 45 s expiry
was the only thing that removed a departed peer's caret and "who's
here" dot, during exactly the "did they leave?" moment. A farewell
frame is pushed synchronously before the stream comes down, on every
terminal path, and presence is re-announced on the disconnected-to-
connected edge (nothing re-announced until the 15 s keepalive before).
A farewell that aborted — a host End that failed to tombstone, a
keep-resumable close whose flush failed — used to leave nothing to
re-announce; the parting state is now stashed and restored. Join and
resume had no in-flight guard, so a double-click (or an invite pill
plus a Sessions row) ran two sessions on one room, with two persist
writers on one key and a history writer silently overwritten but still
writing; both flows are now per-room single-flight and an existing live
history writer is kept. The room-full and join-failure paths tore down
the UI without stopping the session, leaving an orphan polling a room
this window was no longer in, every five minutes, for the life of the
window. stop() called a drain that returned at once whenever a post
was in flight and never set a stopping flag, so that request's failure
re-armed a retry timer after stop() had cleared it; it now awaits the
live drain under a stopping flag. The mode-switch and quit handoff
flushed the recovery record but not version history, dropping up to a
minute of history on exactly the events that precede "let me recover".
A start already in flight now toasts instead of returning silently; the
session-preparation veil has a 120 s failsafe; a history writer's
dispose no longer leaves one stray timer; and the seven call sites that
discarded a teardown rejection now route it through the error surface
with a subsystem name, instead of a generic "Something went wrong" chip
on top of "Session ended".

### Fixed: web account renewals — single-flight, deadline, wake triggers, portal-safe unlink

Four gaps in the web entitlement renewal path, each with a shipped
counter-example elsewhere in the repo: no in-flight guard (a forced
renewal racing the 30-minute tick posted twice and the loser could
overwrite the newer entitlement, and a 401/403/409 on either arm
dropped a live credential); no timeout on the renewal fetch; only the
timer drove it, so a laptop asleep past the 12-hour margin woke to up
to 30 minutes of 401s; and a captive portal's HTML 401 unlinked the
account. Renewals are single-flight, carry a 10 s deadline, run on
online and tab-visible (margin-gated), and unlink only when the body is
relay-shaped JSON.

### Added: cut in place — a whole-card cut in a shared document is a move

A nav-pane drag has always been safe in a session: it is one
transaction, delete plus insert, which the binding turns into a real
move that keeps the card's container identity. Cut then paste was not:
the container died on the cut and a fresh copy (fresh ids — the paste
path stamps them) appeared on the paste. Racing a partner, the chaos rig
showed the three shapes of that: their concurrent typing into the card
vanished with the delete, a delete of theirs was resurrected by the
paste, and against their move of the same card the merge kept both the
moved original and the pasted copy.

So in a document bound to a live session, a cut whose every operating
range is exactly a whole card, analytic unit or outline subtree deletes
nothing. It marks the units (dimmed, dashed, "Cut — paste to move"),
writes them to the clipboard with a marker (an opaque document key and
a nonce) and waits. A paste in the same document that carries the
marker resolves the units by their head ids in the current document,
so partner edits and moves since the cut are honored, and moves them in
one transaction, the drag transaction, to the nearest outline slot for
the caret. Ids stay continuous, so live views and linked copies never
see a dangling window.

The rules that keep a cut that no longer deletes legible: Esc, or Cmd-Z
while a mark is pending, clears the mark (a reflexive "undo the cut"
must not undo the last real edit); Delete removes the marked unit as
always, and a drag of it is already the move and clears the mark; a
paste of anything else clears it (the paste event is the observation
point, so an external copy the app cannot see costs nothing); our own
payload pasted after the mark cleared inserts a copy, as before. A
partner deleting the marked unit makes the paste refuse with a note
rather than quietly re-inserting what someone removed; pasting again
inserts a copy on purpose. Cross-document paste is Word-like: a fresh
copy lands there, and the unit is removed from the source when that
document is open in the window; a closed source, or one in another
window, keeps it and the note says so. Marks are transient editor state
and deliberately survive the session ending: a paste in the now-solo
document still moves the unit, which beats clearing the mark and
pasting a copy. A first-time notice explains the mode once.

### Added: Ctrl/Cmd-triple-click adds a whole paragraph to a discontinuous selection

Adding to a selection with Ctrl/Cmd (the discontinuous "add to
selection" gesture) ignored the click count: the modifier branch in the
mouse-selection plugin ran before the double- and triple-click checks,
so every Ctrl/Cmd-click added the word under the pointer and a
Ctrl/Cmd-triple-click added the same word three times, which the shadow
merge collapsed to nothing new. Selecting several separate paragraphs
therefore meant dragging each one out by hand.

The gesture now follows the same ladder as plain clicking. A single
decision, `discontinuousRangeFor`, takes the pointer-down position, the
release position and the click count and returns the range to add: a
click or double-click adds the word (with its trailing space, as
before), a triple-click adds the containing paragraph, and a drag adds
the dragged range snapped outward to whole words after a double-click
or whole paragraphs after a triple-click. The drag preview is snapped
the same way, so what is outlined while dragging is exactly what the
release adds. The second and third clicks of a sequence each add their
own range and the existing overlap merge folds the earlier words into
the paragraph, so nothing needed to change in the shadow-selection
plugin. Tests drive the decision directly with document positions
(`tests/editor/discontinuous-click-ladder.test.ts`); the manual's
mouse-selection section now documents the gesture, which it had not
mentioned before.

### Added: "Read mode: keep entire cite"

Read mode keeps, of a cite paragraph, only the runs carrying the cite
mark or a highlight; the qualifications, source and date between them
collapse. Some readers want the whole citation on screen at the podium.
A new General setting next to "Read mode: preserve paragraph
integrity", off by default, keeps every text node of a cite paragraph
that has at least one read-aloud run. A cite with nothing marked still
collapses, the same principle as a body paragraph with nothing
highlighted under paragraph integrity, so an unmarked cite never shows
as a stray line.

The rule lives in one place in the read-mode plugin
(`keepsWholeParagraph`) and is consulted by the decoration builder, the
two read-mode scroll-anchor searches, and `isReadModeKeptText`, which
Convert Cards to Read Mode uses, so the destructive conversion cannot
drift from the display. The setting is read when decorations are
built: the single-document path already re-sends the read-mode toggle
whenever a read-mode display setting changes, which rebuilds the set,
and the multi-pane shell now does the same for every pane currently in
read mode when this setting flips, diff-gated like its mark-unread
nudge because the rebuild is O(doc). Tests cover the whole-cite keep,
the unmarked-cite collapse, the rebuild on a flip and the anchor search,
plus the conversion command.

### Fixed: empty pockets shrank in read mode

Read mode hides ProseMirror's trailing line break (the `<br>` it places
in every empty textblock so the caret has somewhere to sit) so that
empty body and cite paragraphs flow away instead of each costing a
line. The rule was unscoped and so also hit heading blocks, where an
empty pocket, hat, block or tag has nothing else to set its height: the
box collapsed to its padding in read mode while a pocket with text kept
its full line. The trailing break is now left alone inside heading
blocks (`display: revert`), so an empty pocket is the same height in
both modes. Headings never flow inline, so nothing else changes.

### Fixed: merge-born duplicate heading ids are repaired in a session

The heading-id guard heals local transactions only, deliberately: it
must not fight an older client edit for edit. Pasted cards get fresh
ids, so a duplicate id normally cannot arise, but an older client's
paste or a merge edge case could leave two cards sharing one id, and
nothing looked at remote edits to repair it. The session repair pass
now keeps a heading-id count index in its plugin state, maintained from
each transaction's step ranges (a body keystroke visits no heading, so
the hot path is untouched; one full walk at install). After a binding
batch the leader checks the merged region's bearers against the index
and re-mints every bearer after the first in document order, the
guard's own fallback rule and identical on every peer once documents
converge, so followers agree with the fix that arrives.

### Fixed: the binding's mapping went stale under the caret after every bounded render

The loro-prosemirror binding builds a fresh ProseMirror tree from the
CRDT on every incoming batch and maps each Loro container to the node
objects it just built. Upstream then replaced the whole document with
that tree, so those objects became the document and the mapping held.
A CardMirror patch from August replaced the whole-document replace with
a bounded one, splicing only the changed span in so plugin positions
survive remote batches (the "card moved — cut not applied" fix). The
cost nobody saw: ProseMirror rebuilds the ancestors around the splice
boundary as new node objects, typically the card and the paragraph
being edited, and the mapping kept pointing at objects that never
entered the document. Every cursor conversion under the caret then
failed, one "Cannot find the loroNode" per transaction, until a local
edit happened to re-map that paragraph; the undo path renders this way
every time, so the undo guard's extra dispatches made it loud in the
1.7.0 test build. The render now walks the built tree and the document
in parallel and points the mapping at the document's own objects
wherever they differ; identical subtrees are skipped, so the walk is
bounded to the splice's ancestors. Pinned by a test that undoes an edit
and checks every container is mapped and no error is logged.

Two more sources of the same message turned out to be noise rather than
staleness, and are silenced by construction: the binding's own init
runs on a timer after the view is built, so a selection dispatched in
that window met an empty mapping; and a selection-only transaction
appended after another plugin's document change in the same batch was
converted against a document the sync had not yet seen. The selection
stash now runs only against a document the binding has synced, and so
does the undo plugin's per-transaction selection capture, which had the
same exposure whenever a plugin ahead of the sync appended a document
change (the app's own numbering, heading-id and autocorrect plugins all
do). One real case of staleness remained beyond the bounded render: a
remote batch that produced exactly what this peer already showed (both
peers moved the same card the same way) rebuilt the touched containers'
mapping entries as fresh objects and then, having nothing to render,
never re-pointed them; the re-map now runs after every render, visible
change or not.

The chaos rig gained a silent-failure battery from this: a
console-error oracle, a per-round check that every container in every
live document is in the binding's mapping, schema validity per round, a
guard that the session repair pass never full-scans, a check that no
peer ends with pending imports latched, and an end-of-seed comparison
between each peer's live document and a fresh render of its own CRDT
state; selection-only transactions and undo/redo are now in the default
op mix, and a last-position plugin on every rig peer records the first
batch that leaves a container unmapped, so a future stale mapping
arrives with its own attribution. Every "Cannot find the loroNode" the
rig had been printing — 65 per undo sweep, unread — resolved to the
causes above.

### Fixed: a comments pane could keep a lost resolved toggle on screen

The comment sync's pull skips its editor dispatch when the room's thread
set has the same signature as the last one it pulled, so a same-value
last-write-wins rewrite on a partner's side does not re-render every
thread on every peer. A local write, though, moves the pane past that
last pull without touching the signature. When this peer's "resolved"
toggle lost a last-write-wins race with a partner's toggle of the same
thread, the room settled back to exactly the state this peer had pulled
before its write; the next pull matched the old signature and skipped,
and the pane kept the losing value while every peer's map agreed on the
other (the chaos rig's comments oracle, 2026-09-05; never a CRDT
divergence, and any later comment change or a reload cleared it). Every
local write now resets the pulled signature, so the next pull renders.

### Added: community PRs — card count in Word Count; Convert Cards to Read Mode

Two contributions from Shreeram. The Word Count window's scope line now
ends with the number of cards in the document, or intersecting the
selection (cards only — analytics are not cards); a nested card inside a
pocket or block counts. And a new command, Convert Cards to Read Mode
(aliases: zap card), is the destructive counterpart of read mode, in the
spirit of the ZapCard macro: the selected cards, or the card at the
cursor, are reduced in one undoable transaction to what read mode
displays. Every rule is read mode's own — which text is audible comes
from the read-mode plugin's kept-text function (highlights, cites, the
reading-marker color, whatever the settings say), the paragraph shape
follows the "Read mode: preserve paragraph integrity" setting (off, a
card's body paragraphs flow together; on, each paragraph with audible
text keeps its line and empty ones collapse), undertags and cites keep
their own node with only their audible text, tables fold their cell
text in, and inline images go the way read mode hides them. Analytics
are skipped; heading ids and numbering attributes survive, so live
views and a co-editing partner's container pairing are unaffected.

### Fixed: web tab return and tab close (web-build audit)

The web build and the desktop build are one bundle; the differences are
runtime branches, and an audit of those branches against this release's
co-editing changes found two. First, the visibility wake hook added
with the liveness work called restart on every return to the tab, and
restart aborts the live stream unconditionally outside its two-second
debounce. Electron only flips visibility on minimize or occlusion, so
desktop testing barely exercised it; in a browser it is every tab
switch: a reconnect, a catch-up fetch, a presence rebroadcast, a chip
flicker for the user and their partners, and a ghost stream the relay
reaps a heartbeat later. The hook now asks the stream to restart only
if it is stale: sitting out a backoff wait (connect now), or helloed but
silent past the stall threshold, which is the dead-socket case the hook
exists for. A healthy, byte-fresh stream is left alone; an in-flight
handshake too. Sleep and network-return keep their unconditional
restart, since those sockets are dead in practice.

Second, a web tab close had no unload path at all. Desktop's close flow
says goodbye and drains the queue before the window goes; on the web,
the hidden-tab flush started an ordinary fetch that the browser cancels
at unload, and no departure frame went out, so partners kept the ghost
caret for 45 seconds. A pagehide hook now sends the departure frame and
re-posts the queue head as keepalive requests, which the browser
finishes after the page is gone. The handler cannot wait on WebCrypto,
so only a blob the drain has already encrypted can go out from the
handler itself; the drain therefore keeps each entry's encryption, and
while the document is hidden it posts with keepalive in the first
place, so the send started by the hide-time flush survives the close.
Browsers cap keepalive bodies at about 64 KB, so larger blobs stay on
the ordinary path. Everything here is idempotent for the CRDT and
best-effort by nature: the crash-recovery record still re-sends
whatever did not make it on the next resume, and partners still expire
a silent caret.

## 1.6.0 — 2026-09-01

### Added: Reading view (Word-style paginated columns)

The ribbon's permanent nav-pane toggle gave way to a book button that
flips the focused document into full-screen column pages for reading a
speech (the nav-pane toggle lives on as a command / custom ribbon
button / bindable key). The live ProseMirror element becomes a
height-capped CSS multicolumn strip whose extra columns overflow
horizontally; the host clips to exactly one screenful and page flips
are NATIVE scrolls of that clipped host, driven by a fast ~120 ms
ease-out animator. The naive alternative — translating a
`will-change: transform` strip — was tried and reverted: a
pages-wide compositor layer blows Chromium's layer budget on real
tournament files, silently demoting every flip to a main-thread paint
of the whole strip (multi-second clicks that got *faster* when read
mode shrank the doc — the tell that led to the rewrite). Native
scrolling uses the browser's tiled raster path, which only ever paints
near the viewport.

Geometry is measured, not assumed: relayout derives the visible band
from the scroller, reserves flip lanes so the edge buttons never sit
on text, measures the strip's real offset and compensates, and
calibrates scroll units (CSS zoom makes them engine-dependent).
Repagination triggers cover the cases layout can't see coming: doc
edits, resizes, and — via class observation — read-mode toggles (the
rendered doc collapses with no doc change; without this, flipping into
the phantom tail looked like a freeze), the send/receive pill tray
(columns end above it), and three-pane doc swaps. Drop targets don't
render on a reading-view host: its transaction lock (read mode's
allowances minus the drag exception) would reject the drop anyway.

Interaction follows Word: 1–3 columns from pane width (the
maximum-text-width cap bounds column width), arrows / PgUp / PgDn /
Space / Home / End, one mouse-wheel detent or trackpad swipe = one
flip, click zones at each edge, a page indicator, nav-pane clicks land
on the containing page. Combinable with read mode; per-document in the
three-pane workspace (each doc in a slot keeps its own state).
Animations flatten to instant flips under the new "Reduce animations
in reading view" accessibility setting or the global reduce-motion
preference.

### Added: Recover Previous Version overhaul (preview, digests, save triggers)

Version rows used to be a timestamp and a size; seeing what a version
held meant opening it in a new window. Both dialogs — the solo
document's snapshot list and the shared session's history — are now
two-pane: the version list on the left, and a click-to-preview pane on
the right that renders the version read-only with the real document
stylesheet AND a real navigation pane (an actual NavigationPanel
instance in a new read-only mode: level buttons, chevron and
double-click expand/collapse, per-type styling — but it never starts
drags or registers as a drop target, and the preview view drops any
doc-changing transaction by construction).

Rows carry digests: word and card counts, a delta line vs the previous
version ("+3 cards · −1 card · +1,240 words"), and a badge counting
cards that version holds which the current document lacks — computed
from tag-id set differences, answering the actual recovery question
("which version has the thing I lost?"). The solo dialog digests all
its snapshots progressively in the background (one parse at a time,
cached for the session — snapshot content is immutable); the session
dialog computes digests lazily on preview clicks instead, because
reconstructing a session version is a synchronous CRDT checkout that
must never run as an eager background sweep.

Snapshots now also record their save trigger — manual save vs
autosave — encoded in the snapshot filename (no sidecar for pruning to
manage; pre-existing snapshots still parse, they just show no chip).
Dedup stays purely content-based, so identical content saved twice
keeps the first snapshot's chip.

### Added: Drag to rearrange setting (Settings → General)

A teacher's iPad classroom kept triggering nav-pane drags when
students scrolled with a finger. The new toggle (default on) gates the
content-move drag surfaces — nav-pane row drags and the editor's
pickup drag — in both the single-doc and three-pane editors. Clicking
still navigates; pane resizing is unrelated and unaffected.

### Added: Open Containing Folder command

Reveals the focused document, highlighted, in Finder / File Explorer
(`shell.showItemInFolder`; the desktop file handle is the absolute
path). Unbound by default; command-bar aliases cover "reveal in
finder" / "show in folder" / "file location", and it sits in the File
group for custom ribbon buttons. Focus-aware in the three-pane
workspace; toasts when the document has never been saved, and on the
web edition.

### Fixed: heading identities can no longer duplicate or vanish mid-edit

1.5.1 healed duplicate heading ids arriving from docx round trips;
this release closes the doors that could mint them (or their opposite,
null ids) during native editing. A purpose-built fuzzer — real command
chains against a live view, clipboard HTML round-trips included —
found the actual culprits: pasting into the middle of a heading
duplicates the heading node around the paste (ProseMirror's
replace-split copies attrs, ids included), and several
cross-container selection shapes crashed the keystroke instead of
editing. Three layers shipped: a schema-level appendTransaction guard
that re-mints duplicate/null ids in the same transaction that would
create them (provenance-aware — the ORIGINAL heading keeps its id,
the copy gets the new one, so nav selection and collab cursors stay
put; sync-origin transactions are exempt, since remote peers heal
their own), crash-free paste and deletion fallbacks that produce the
sensible merge instead of throwing (deleting across a card boundary
now carries the tail content up into the surviving container, exactly
as if the intervening structure had been deleted first), and the
fuzzer graduated into the suite as a regression fence.

### Fixed: timer threshold flash lagged typing on big documents

The flash animated `background-color` and `color` — paint properties
that cannot run on the compositor (their keyframes resolve CSS
variables, forcing per-frame style resolution too). For the whole
flash window the main thread ran a style → paint → commit cycle at
~60 fps, and on large documents those frames interleaved with
ProseMirror's keystroke layout work: visible input hiccups every time
the timer flashed. The pulse is now the opacity of a promoted overlay
pseudo-element behind the time text — compositor-only after the first
frame, so typing cost is untouched. Visual delta: the flash peak shows
the normal text color on red rather than white on red.

### Fixed: small UI polish (community PR)

Elli (@0-elli): color-picker triggers now toggle their picker closed
instead of reopening it; Doc / Card / Table menu chevrons align
consistently; the settings theme buttons gained proper hover and
selected contrast (selected text now uses the shared on-accent token,
so it stays correct across themes); and switching settings tabs no
longer shifts the tab bar's layout. Thanks, Elli!

## 1.5.1 — 2026-08-29

### Fixed: duplicate heading ids from docx round trips (nav misjumps)

The importer adopted `pmd-heading-*` bookmark ids verbatim; Word
enforces bookmark uniqueness but the tools around it (Verbatim OOXML
ops, LibreOffice, Google Docs) duplicate a bookmarked heading
paragraph happily — e.g. a heading line copied as a style template
and retyped. Two headings then shared one id, and every id-keyed
lookup (the nav pane's [data-id] jump, transclusion's extractSection,
the docx anchor locator) resolves first-match-in-document-order, so
clicking one heading navigated to the other. `dedupeHeadingIds` now
walks in document order and re-mints later occurrences — first wins,
which is exactly behavior-preserving for anything that resolved
before. Runs in both fromDocx variants and in the `.cmir` load chain,
so already-infected files heal on open, and re-export writes each
bookmark once again instead of propagating the duplicate.

### Fixed: long-session credential staleness killed collab sync

The rooms client froze its bearer into a closure at construction,
defeating the interface's own re-read-per-request entitlement seam.
Entitlements expire after 72 hours and renew in the background; the
fresh token landed in the store while a long-running session kept
presenting the old one — every room call 401'd (updates, presence,
stream) until an app restart, and even unlink + relink couldn't reach
the frozen closure. Credentials now resolve per request, with the
routing code paired to the credential source at call time; on desktop
the renderer's cached baked defaults refresh on the main process's
entitlement-changed broadcast. An entitlement that expires with no
renewal also stops being presented rather than 401ing as a dead
bearer.

### Fixed: a dead gzip worker hung every .cmir save forever

`.cmir` serialization compresses on fflate's worker thread; the
fallback only caught a worker that failed to SPAWN. One that spawned
and then died (a weeks-old renderer under memory pressure) never
called back, stranding the save promise BEFORE the save watchdog
(which wraps only the disk write) and before Save As even opened the
OS file picker — while `.docx` saves, which zip synchronously, worked
throughout. A 5-second timeout now falls back to synchronous
compression (byte-identical output) and latches the session to the
sync path — fflate spawns a fresh worker per call, so there is
nothing to restart, and re-probing would tax every save with the
timeout while the killing condition persists. The save flows'
serialization phase is now also covered by a slow-save notice, so any
future pre-write hang surfaces instead of ambering silently.

### Fixed: editing over a head-tail cross-container selection threw

A selection ending INSIDE a container's required head block (a card's
tag, an analytic unit's head) is the one range shape ProseMirror's
replace cannot fit — closing it must join the tail container's
remainder onto the from-side container, which no depth combination
allows. Typing or deleting over such a selection threw "Cannot join
card onto analytic_unit" uncaught and did nothing. The rebuild now
applies merge-up semantics, exactly as if the boundary had been
deleted first: the head's remaining text flows up inline into the cut
block and the tail container's remaining body blocks follow it into
the from-side container. Engaged only after the direct replace
throws; every legal selection (including body-to-body, which always
merged correctly) keeps ProseMirror's existing behavior.

## 1.5.0 — 2026-08-28

### Added: rich payloads on the local insert bridge

The `/insert` bridge accepts an optional `html` field alongside the
(still required) plain `text`. When present and usable, the HTML is
parsed through the editor schema's own parseDOM inside an inert
detached document, with script/style/iframe/object/embed stripped
before parsing — so CardMirror-native markup round-trips at full
fidelity (cards, highlight colors, cite/underline marks), generic
formatted HTML maps to the nearest schema constructs, and hostile
markup is inert. Whole cards land at a valid outline slot via the
same nearest-valid-position logic as internal pastes, never splitting
the card under the cursor. Anything unusable (empty, over the 2 MiB
cap, nothing parseable) falls back to the `text` path, which is also
what older CardMirror versions do with the same payload — senders
need no version detection. The insert consent prompt now says
"insert content" rather than "insert text."

### Fixed: the Windows .docx association, done right

electron-builder's fileAssociations mechanism overwrites an
extension's DEFAULT ProgId, and Explorer only shows the "New >" menu
entry belonging to the current default — so installing (or updating)
CardMirror removed Word's "New > Microsoft Word Document" right-click
entry, and uninstalling left .docx pointing at a deleted class. The
installer now registers .docx by hand: a properly-namespaced
CardMirror.docx class listed under OpenWithProgids ONLY — CardMirror
appears in "Open with" and default-apps UI while Word keeps its
default, its New-menu entry, and double-click. A healing pass runs on
every install/update and on uninstall: machines the old installers
broke (default still reading our old "Word Document" class name) get
Word.Document.12 restored when Word is present, or the dangling value
deleted so Windows re-resolves. `.cmir` also gains its own ShellNew
template ("New > CardMirror Document"). Verified in a real Windows
VM, both healing branches. Thanks to
[Q Cooper](https://github.com/mosuqc) for diagnosing the mechanism
and sketching out the fix.

### Fixed: genuinely empty files open as blank documents

A zero-byte file — Explorer's "New > Microsoft Word Document"
(Office's ShellNew template is literally 0 bytes by design), `touch`,
some export tools — was refused with "This file is empty or hasn't
finished downloading," a guard meant for cloud placeholders. The two
cases are distinguishable on disk: a not-yet-downloaded placeholder
stats at the file's REAL size while reading short (the Windows Cloud
Files API requires the size in placeholder metadata; macOS dataless
files keep true st_size — verified empirically against Dropbox and
Google Drive), so stat size 0 means genuinely empty. The host flags
such files at read time and every open path substitutes canonical
blank-document bytes for the format, so the file mounts as a blank
doc bound to its path — exactly Word's behavior — and saves write
real content back to it. Short reads with a non-zero stat keep the
placeholder message, and a 0-byte journal still reports corrupt.

### Fixed: account seats release on unlink; web confirm-evict loop

Disconnecting a Debate Decoded account only wiped local state; the
server-side seat stayed occupied until another machine evicted it, so
the seat-limit dialog kept naming machines the user had already
unlinked. A new relay endpoint releases the caller's own seat, and
both editions fire it best-effort on Disconnect — after the local
wipe (so a quick re-link can't be clobbered), authenticated by the
machine's own entitlement (desktop) or a purpose-scoped key proof
(web); a bare routing code can never release a seat. Offline
disconnects simply leave the seat held until an evict, the previous
behavior. Separately, the web edition's seat-limit dialog retried
with the confirmation flag unset, so "Link This Browser" consumed the
fresh retry code, hit the limit again, and re-showed the same dialog
forever; the confirmation now rides the retry (the desktop dialog was
always correct).

### Fixed: guest sessions end cleanly when the invite expires

Room-data authentication runs before the room lookup server-side, so
once a guest's invite pass (immutable, 7-day lifetime, not
refreshable by guests) expires, the client only ever sees 401 — the
"session ended" answers it treats as terminal are unreachable — and
it retried forever, indistinguishable from being offline (observed as
all-night presence/stream churn in relay logs). The stream now
detects credential death conservatively: only a 401/403 whose body is
the relay's JSON shape counts (a captive portal's HTML login page
never does — school-wifi sign-in pages self-heal through ordinary
retry), and only on the second consecutive refusal, a full backoff
interval apart; being offline can't trigger it at all. Guest-pass
sessions then end with a "Session invite expired" notice, keep the
document as a local copy, and clear the persisted record so they
can't auto-resume against a dead pass. Member sessions keep the
notify-once-and-retry behavior, since an expired entitlement can
quietly renew mid-session. Presence also posts only while the stream
is connected — presence is delivered over the stream, so posting into
a dead one was pure waste.

## 1.4.0 — 2026-08-25

### Added: version history for saved documents

A new snapshot store (`userData/history/{docId}/`) keeps complete
`.cmir` snapshots per saved document: content-hash dedup (an unchanged
doc costs zero new bytes), tmp+rename writes, per-doc write chains,
and three-way pruning — retention age, per-doc byte cap, global byte
cap — with the invariant that a doc's newest snapshot is never
size-pruned (a doc bigger than its own cap keeps one version, not
none). Both save paths (manual and autosave) offer their serialized
bytes to the store BEFORE the disk write is awaited, so a save whose
destination folder hangs still leaves a recoverable version in app
data. Interval-gated per doc (5 min standard / 2 min extended),
fire-and-forget, never blocks a save. Deliberately NOT a replacement
for the crash journals (always-on, seconds-fresh, self-clearing,
covers never-saved drafts) — the journal is the hot copy, history the
capped browsable trail behind it. The `versionHistory` setting
defaults to Standard — insurance that is opt-in fails the people it
exists for — with Extended, Custom (user caps in MB, 0 = uncapped,
sent as a finite stand-in because the policy crosses IPC and main
validates isFinite), and Off; a live disk-usage readout and a
clear-history button sit with the radios. Recover Previous Version,
with no session active, now lists the focused doc's snapshots
directly by docId (no history-file picking); the manual envelope
picker remains as the escape hatch for orphaned session history.

### Fixed: the silent hung save (watchdog + in-flight button state)

Field case (Windows + Dropbox): a save to a cloud-sync online-only
placeholder whose hydration stalls BLOCKS the write syscall — no
error, no UI, and every later save queues silently behind it on the
per-path chain, indistinguishable from a dead Save button. Node
cannot cancel a blocked fs call, so the fix converts silence into
feedback: a coalesced warning notice at 10s (phrased as in-progress —
a slow-but-healthy write may still land), and on manual saves a
route-style dialog at 30s offering Save As… (the one real exit; the
abandoned write stays queued, so a recovering folder yields two
copies, never zero). The dialog closes itself the moment the write
settles — `promptForRouteChoice` gained an optional AbortSignal
(abort ≡ cancel) for prompts whose question goes moot while open.
Rejections propagate unchanged, so EMODIFIED/ENOENT/ELOCKED handling
is untouched. Alongside it, the save button now pulses amber (the
pre-reserved `--pmd-c-warning` tokens) from click until the save
settles, behind a 250ms flicker guard so healthy saves jump straight
to the ✓ flash; the close-window flows inherit both behaviors because
they route through the same save flow.

### Added: plugin directory + Browse picker

The relay serves a public plugin directory — the browsable, admin-
curated SUBSET of the install allowlist — at `/plugin-directory`,
each entry carrying name/description/author/version read server-side
from the repo's latest-release `cardmirror-plugin.json` (the same
asset the installer fetches, so the card shows what installs; cached
6h, served stale on fetch failure). Main fetches it and filters
through the effective allowlist so Browse can never offer what
install would refuse. Settings → Plugins gains a Browse button
opening a searchable picker; installing from a row runs the exact
inspect → consent → commit flow as typing the slug — one click saves
typing, never consent. Hidden in the Lite build (no internet).

### Added: `multiline` plugin setting type

`text` renders single-line, which left list-shaped plugin values
(keyword lists) homeless — plugins built custom modals and hand-
rolled the cross-window sync that declared settings get from the host
for free. `multiline` renders a full-width stacked textarea in the
plugin settings modal; the value is a plain string, one entry per
line by convention. Purely additive to the spec (validation, value
coercion, modal render); a plugin adopting it should set
`minAppVersion` accordingly.

### Changed: paste cursor lands after the pasted content

Container-splitting pastes (a whole card / tag / heading pasted into
a card body) put the cursor at the end of the first pasted head — the
F7/setHeading convention, deliberate but inconsistent with every
other paste. New enum setting `pasteCursor`: 'after' (new default)
ends at the pasted content, stopping at the boundary BEFORE the
absorbed destination remainder (content the user never pasted);
'tag' keeps the legacy rename-ready convention. One shared builder
(`buildContainerSplit`) means the change covers all four routes:
direct structural paste, reparsed-clipboard recovery,
body-then-structural, and smart-paste conversions.

### Added: Arial Narrow (bundled Liberation Sans Narrow)

`Arial Narrow` joins the Microsoft Office defaults group in the font
picker, following the established substitute pattern: @font-face
under the real name, `local()` preferring an installed Arial Narrow,
falling back to bundled Liberation Sans Narrow — the metric-
compatible clone, taken from the 1.07.4 TTFs (the 2.x Croscore line
dropped the Narrow faces) and repackaged as WOFF2 UNMODIFIED, no
subsetting: the Liberation license is GPLv2 with the font-embedding
exception, and modification would trigger its rename-the-trademark
clause. Full text in `fonts/Liberation-License.txt`; the docx export
writes the literal name so files round-trip into Word.

### Fixed: assorted

Whitespace-only headings rendered squashed nav rows (a space-filled
text node defeats the `:empty::before` NBSP height fallback while
still collapsing to zero width — normalize to truly empty at render).
Verbatim Flow sends now apostrophe-prefix cells starting with
`=`/`+`/`-`/`@` — Excel parsed those as formulas and rejected
ordinary analytics outright. Long toasts wrap (width cap +
`overflow-wrap: anywhere`) and clamp inside the viewport instead of
running off screen from a cursor near the edge.

## 1.3.0 — 2026-08-20

### Added: citeTokens on the insert bridge (styled external cites)

The Fast Debate Paste `/insert` payload accepts an optional
`citeTokens: string[]` on role-`cite` inserts: verbatim substrings of
the first line (the lastname + shortdate emphasis spans) that arrive
wearing `cite_mark`. The sender states intent, never presentation —
CardMirror decides what the emphasis looks like. Matching reuses the
AI cite creator's fuzzy token matcher, extracted into
`cite-token-match.ts` (the bridge path must not drag the LLM stack,
and Lite carries the bridge without AI); landing position is read
from the replace step's range with a block-head match, never position
arithmetic, and a token that misses marks nothing. The field is
optional in both directions, so old senders and old receivers are
both unaffected; structured runs are the agreed upgrade path if
general styling is ever needed. First consumer: Fast Debate Paste
2.2.0/1.2.0.

### Changed: About-this-install cleanup

Auto-check checkbox, then the manual Check button, then the
tournament-pause area (caption above its button, matching the rest of
Settings); Open crash dumps folder moved to its own section between
About and Back up settings; the Version row reads
"1.3.0 (CardMirror Lite)" on Lite installs.

### Added: web collaboration ungated (soft launch)

The web-collab stack that shipped dark behind the `pmd-collab-web`
console flag is now on by default for every desktop-layout browser
host; the flag is retired. The gate (`collab-gate.ts`) now decides
only where collaboration CAN exist — open on all desktop hosts and
desktop-layout browsers, closed in the mobile shell and Lite builds —
while whether it is ACTIVE remains the user's `Enable collaboration`
master toggle, default off, so the ungating changes nothing for anyone
who hasn't opted in. The pre-launch join-link and session-record gate
overrides became redundant and were removed; invite links opened on a
phone still get the clean "needs a desktop layout" refusal, which is
now gate-independent. Web builds carry the official relay URL as
their baked default, so no configuration is needed. Under the hood
the stack is unchanged from its flagged form: WebCrypto account
identities, room guest passes for account-less joiners, leader-tab
mailbox delivery via Web Locks, and empty-poll 304s.

## 1.2.0 — 2026-08-18

### Added: CardMirror Lite (no-AI / no-internet edition)

A build VARIANT (never a fork — Lite inherits every editor fix) for
school-managed environments, driven by a district audit that flagged
student-supplied AI keys as unfilterable. Three enforcement layers:
UI (collab gate closed on all hosts, AI commands out of availability,
AI/pairing/plugins settings hidden via a shared predicate, and
`settings.get` force-reads the network masters as off so console
flips can't resurrect them); bundle (the AI-provider and relay
endpoints live in modules the Lite build aliases to empty variants —
`verify-lite-bundle.mjs` hard-fails on any reachable endpoint in an
entry chunk); network (the web deploy at lite.cardmirror.app ships a
`connect-src 'self'` CSP the browser enforces, and the desktop Lite
main process cancels all http(s)/ws renderer requests at the session
layer, skips update checks and pairing IPC, and blocks voice-model
downloads — the base model is a first-use download too). Release
builds produce "CardMirror Lite" installers with their own appId for
side-by-side installs; Lite carries no relay token and never touches
the auto-update manifests.



### Fixed: exported numbering never restarted in Word (startOverride)

Field report (Reddit, 2026-08-17): docx exports rendered all numbered
lists as one continuous counter in Word. `buildNumberingXml` allocated
a fresh `w:numId` per restart run — correct instinct — but all nums
share one `abstractNum`, and Word runs ONE counter per abstractNum
unless each `<w:num>` carries `<w:lvlOverride><w:startOverride>`.
Our own round-trip couldn't see it: the importer derives restarts from
numId transitions, not Word's counter semantics, so export→import was
self-consistently wrong. Every num instance now restates start=1 for
both levels; pinned by an export test counting per-num overrides.

## 1.1.0 — 2026-08-17

### Added: live remaining read time (third readout segment)

`src/editor/live-read-time.ts` gains `remainingReadSegment(state)`, a
sibling of `liveContainerSegment` behind the new `liveRemainingReadTime`
setting (boolean, **default off**, General → Word counts, `kind:
'toggle'` so it also gets a command-palette toggle). It appends a third
pipe-joined segment — `Left: 1,204 · Amy: 6:31 · Ben: 5:44` — counting
the read-aloud words from the cursor to the end of the document. The
predicate is the existing one (`countReadAloudSplit`): nothing new
decides what "readable" means, so the three segments can never disagree
about which words a reader says out loud.

Measured from `selection.to`, not `from`: the end of a selection is the
furthest point the user has accounted for, so a selection reads as
"I've been through this much" and the remainder starts after it. With a
bare cursor the two coincide.

The cost model is the point of the design. Counted directly, a suffix
is O(doc − cursor) on **every cursor move and every keystroke** — an
arrow key near the top of a large brief would pay a full document walk,
which is exactly the regression the container segment was built to
avoid. Instead a **suffix-sum table over the doc's top-level children**
is built once per doc: for each child index `i`, the `ReadAloudCounts`
of children `i..end`. Building it is one O(doc) pass — the same cost the
whole-doc readout already pays per doc change. A cursor move is then
`$pos.index(0)` (O(depth)) to find the child the cursor sits in, the
table's suffix total for the next child on, plus one partial count of
that single child. Never O(doc). The table is a one-slot module cache
keyed on the doc NODE identity, matching the container cache's pattern:
an edit produces a new node, so a stale table cannot be served for a
changed doc.

Both readouts compose in the same two mirrored places
(`src/editor/index.ts` `refreshWordCount`, `multi-pane-shell.ts`
`refreshWordCount`), which now build a segment list and drop the nulls
rather than nesting conditionals — so container-off/remaining-on reads
`Doc: … | Left: …` in scope order. The selection-only refresh gates in
both surfaces take the new setting alongside `liveContainerReadTime`:
the cursor is what the count runs from, so a plain caret move has to
recompute.

### Fixed: a level change dropped the caret highlight

Pre-existing, and the reason the feature below was worth building. Every
rebuild of `liEntries` has to be followed by a positional resync —
`setCaretHeading` re-resolved against the rows that now exist — which is
why the editor runs one after its debounced `update()`. `setMaxLevel`
rebuilds the list and never did. `selectedIds` kept the caret heading's
id, but when the new depth collapsed that heading away no rendered row
carried it, so `render`'s selected-class pass matched nothing and the
outline lost its "you are here" entirely.

`setMaxLevel` now resyncs after the render, unconditionally — this is a
bug fix, not part of the setting. It resolves the way every other caret
consumer does (largest rendered `entry.pos <= caret pos`), which lands
on the deepest rendered ancestor when the exact heading is gone. Passed
as a positional resync, so an explicit nav multi-select survives a depth
change the same way it survives a rebuild.

### Added: the nav pane can follow the cursor

`navFollowCursor` (General → Workspace, **on by default**, `kind:
'toggle'` so it also gets a command-palette toggle). `setCaretHeading`
has always resolved and highlighted the caret's row while explicitly
declining to scroll to it — "that'd dominate scroll behavior for users
who scroll the editor freely. Add later if it turns out to be desired."
This is that later; the concern is answered by *when* it scrolls rather
than by leaving it out.

The scroll target is whichever row currently carries the highlight, read
back off the DOM rather than re-derived from the doc. That's the point:
`setCaretHeading` already owns the resolution, and a scroll that
disagreed with the visible highlight would be worse than no scroll. (The
first cut of this change re-derived the caret's heading with its own
ancestor walk and doc-level sibling scan — ~60 lines reaching the same
answer by a second route, now deleted.)

Two modes:

- **`'nearest'`** — caret movement. Runs only where `setCaretHeading`
  has established the highlight moved to a *different* row (every
  no-change path returns before it), and then only if that row is
  off-screen, scrolling the minimum distance to reveal it. So typing
  inside one section never moves the pane, and an outline the user
  scrolled by hand stays put until the caret actually leaves the visible
  span. Positional resyncs are excluded outright — the caret didn't
  move, the doc changed under it, and yanking the pane after a
  drag-reorder or a debounced rebuild is exactly the behavior the
  original note was guarding against.
- **`'top'`** — level change, where `render()` has already destroyed the
  scroll offset. There is no position left to preserve, so the row is
  pinned to the top of the viewport and the section the user was reading
  heads the list.

`offsetTop` is measured from the nearest positioned ancestor, which is
the panel (`position: fixed`) — `.pmd-nav-list` is an unpositioned flex
child — so the list's own offset comes off to get a content-relative
coordinate; both are scroll-independent. Results clamp to the scrollable
range. Scroll only: the editor selection, the nav multi-selection, and
the collapsed set are all left alone. No view, no doc, an empty outline,
or a caret ahead of the first heading all fall through to doing nothing.
`scrollToTop()`, the doc-load reset, is untouched — a freshly opened
document still starts at the top of its outline.

Both surfaces inherit it: the single-doc panel and each pane's panel in
the three-pane shell attach a view at construction, and the mobile shell
reuses the single-doc instance.

Tests (`tests/editor/nav-follow-cursor.test.ts`) stub the geometry jsdom
doesn't have — rows `ROW_H` apart, a fixed viewport — and assert the
offsets the panel computes: the bottom clamp, the collapsed-away
fallback, the minimum-distance reveal, and the two guarantees that keep
following from fighting the user (an already-visible row isn't touched;
moving within one section doesn't scroll). The highlight fix is asserted
with the setting off, where it belongs. The flag-OFF scroll reset can't
be observed directly: jsdom stores `scrollTop` as a plain number and
never re-clamps it when the list is emptied, so the browser's "wipe the
list, lose the offset" doesn't happen there. Those cases assert instead
that the panel never writes `scrollTop`, which is exactly the
pre-existing behavior a real browser turns into a snap-to-top.

Both the remaining-read-time segment and the nav-follow feature are
Cora's (@coralynnkc, PRs #37 and #36); the default flip to on, the
three-pane scroller fix, and the trimmed settings copy landed as
merge fixups.

### Added: guided UI tour (spotlight onboarding)

A coach-marks overlay walks the chrome in first-session order: editor
canvas → structural styles → character styles (cite + color panels in
one cutout) → outline (level buttons ringed) → files → speech → read
mode → live word count → timer → flashcards → command bar → the ⚙
button → keyboard reference. Back/Next/Skip, step dots, ←/→/Esc; a
first boot that lands on the home screen gets a leading step that has
the user create their first document (Next clicks New for them, and
backing across the boundary re-opens home). The command-bar step is a
guided flow: the user presses the shortcut, the palette is spotlighted
(it renders below the tour layer — the cutout lifts it), the card asks
them to run "settings", the opened dialog is spotlighted, and closing
it hands off to the ⚙ step.

Robustness is the core of the design. Targets re-resolve on a 250ms
tick (animated panes, the growing palette, dialogs). Visibility is
judged by ancestor-clip intersection — the ribbon clips clusters at
narrow widths without moving them off-screen — with an absolute-size
escape so large scrollable surfaces (the editor is its document's full
height inside a scroller, i.e. always "mostly clipped") spotlight
their visible slice. A structurally absent target (the speech stack
outside three-pane), a clipped one, or a renamed id all degrade to a
centered card with adapted copy — never a crash, a dead end, or a
silent skip — and upgrade to a live spotlight if the element appears.

Auto-runs once, only for profiles whose persisted settings match the
(sanitized) defaults; any customization marks an established user and
initializes the seen-flag on. Rerun via the `startUiTour` ribbon
command. Desktop layout only.

### Fixed: headless cards from clipboard round trips (issue #34)

Root cause of the long-lived "invalid content for node card"
corruption: `parseSlice` rebuilds closed nodes without schema
validation and the paste fitter trusts slice interiors, so a cut that
opened mid-card could paste back a `card(card_body)` with no tag —
invalid, and invisible until something walked it. Wounded docs then
made normalizer `appendTransaction` walks throw `contentMatchAt`,
aborting entire dispatches — the reporter's "disappearing line
breaks." Three layers ship: `transformPasted` heals closed headless
containers in the incoming slice by prepending a blank head
(start-open spine exempt — that's a legitimate partial node); a
container-integrity plugin registered ahead of absorb repairs wounds
in the live doc via whole-node `replaceWith` (inserting INTO a wound
throws the same error being healed) and deletes empty shells; and the
absorb/cite-classifier/named-style-normalizer walks are crash-proofed
to skip a round instead of killing the dispatch. Doctrine: an
occasional blank tag the user re-deletes beats ever deleting content.
Documents wounded by earlier versions heal on reopen. Pinned by
`tests/editor/paste-slice-heal.test.ts`; the crash-aware clipboard
sweep that found the 72 failing recipes now reports zero invalid docs
and zero dispatch crashes.

### Added: status-bar notice chip; toast timing; decision dialogs

Toast-audit follow-through (364 call sites reviewed). A toast is a
cursor-anchored tooltip — fine for confirmations, information-loss
for anything worth re-reading. `postNotice` keeps the immediate toast
and additionally files the message under a status-bar chip where it
persists until dismissed. Severity tiers color the chip by the worst
message present (grey info / yellow warning / red error); repeats
coalesce by key into a ×N counter and never re-toast (the save-heal
tripwire's once-a-minute heartbeat becomes one entry); the panel
offers Copy, Dismiss, and Dismiss all, capped at 50 entries. Routed
in: the error-surface catch-all, save-heal tripwire, autosave
failures, pairing/relay auth rejections, AI-feature failures, and
plugin toast overflow. Toast duration now derives from reading time
(200ms/word on a 1.6s floor, 8s cap) instead of a flat second.

Three act-on-it toasts became real decisions, using the compact
dialog family (not the route-style Save/Don't-save look): the
changed-on-disk conflict prompt is shared between manual save and the
first autosave failure of a streak on single-doc paths (multi-pane
records stay pause-plus-notice — their manual-save flow targets the
focused record); a failed live-zone anchor write offers a
close-it-in-Word retry loop; the repaired-copy completion message
files as an info notice (the real decision dialog already runs before
opening).

### Changed: settings account row status chip

The disconnected helper paragraph is gone; a status chip renders in
both states — "✓ Connected as …" filling the controls row, or a
compact red "✕ Not connected" leading it. Underlying fix: the chip's
class carries `display: flex`, which outranks the `hidden`
attribute's UA rule, so after Disconnect the old chip stayed painted
with stale contents until the dialog was rebuilt; the row now swaps
state immediately. Account-link copy across Settings and the manual
moved to present tense: a linked paid membership is required for card
sharing and co-editing on the official relay.

### Changed: welcome guide refresh + numbering default

The onboarding starter gained a "Share and co-edit" section (pairing
codes, Send-pill invites, session share codes, the membership note),
renamed its workspace section to match the "Three-pane workspace"
settings label, corrected the tour-off toggle's path (Files, not
General) and gave it its own hat for discoverability, fixed the nav
multi-select modifier to Mod-click, and dropped the alpha-era save
warning on both desktop and mobile variants. Substructure numbering
separator now defaults to `period` ("a.") to match numbers; stored
choices are respected.

## 1.0.1 — 2026-08-15

### Added: editor text context menu (Cut / Copy / Paste)

Right-click on editor text opens a fallback menu wherever the image,
link, and spellcheck menus don't claim the click. Cut and Copy
serialize the live selection through the editor's own clipboard
serialization (so custom copy hooks apply exactly as a keyboard copy
would) and the shared main-process-first clipboard-write ladder; Cut
deletes only after the write reports success, so a busy Win32
clipboard can never eat text. Paste reads both html and plain flavors
in a single main-process IPC on desktop — no permission UI, rich
flavor preserved; older packaged shells fall back to text-only, and
the web edition asks the async clipboard API, surfacing a
press-the-shortcut toast if the browser blocks it. Cut/Copy disable
with no selection; Cut/Paste disable in read-only views.

### Fixed: paintbrush stroke-gesture guard

The sticky paintbrush applied its color on ANY mouseup over a live
selection — no button filter, no tie to how the selection was made.
The field failure: with the brush armed, select-all followed by a
right-click (a context-menu attempt; the browser preserves the
selection for it) painted 74% of a shared document in one event.
Painting now requires the full gesture: a primary-button mousedown
inside the same editor pane, released with real pointer travel or as
a double/triple-click select. Shift-click extends are excluded
(that's the select-to-copy gesture); genuine drags and double-click
word selects behave exactly as before, including the strip-pen
modifier.

### Fixed: concurrent table edits (ragged-table detonation)

Concurrent "add row" + "add column" merge to a table whose rows have
unequal widths — legal, since schema content expressions cannot
constrain widths. prosemirror-tables' TableMap misbehaves on that
shape: addRowAfter from a short-row cell nested an empty row INSIDE
the trailing row, ProseMirror's replace fitter accepted the invalid
document, and the sync layer faithfully replicated it — remote peers
dropped the whole damaged row while the originator kept it,
permanently splitting what each participant saw. Three independent
layers now cover the sequence: structural table commands normalize
the table in the same transaction before running (one undo step);
the repair pass straightens already-damaged tables instead of
crashing on them (hoisting real cells, dropping the empty artifact),
on every peer since only the originator's document holds the damage;
and the CRDT materializer salvages a damaged row's legal cells for
remote peers instead of discarding the row. Fuzzed to 2,700 seeds
across three fuzzers and both room formats with zero convergence,
validity, or loss failures.

### Fixed: canonical mark equality in the sync binding

The binding compared text formatting with JSON string equality, but
the CRDT round-trip reorders attribute keys and null-valued keys are
semantically identical to absent ones — so unchanged formatting near
minimized (8pt) runs re-diffed on every pass and could ride along as
redundant mark operations wherever nearby text was genuinely
formatted, last-writer-wins stomping a partner's concurrent
formatting edits on the same range. Equality is now canonical
(key-order-insensitive, null ≡ absent, segmentation-insensitive), and
stored values are never migrated — old and new sessions interoperate
unchanged.

## 1.0.0 — 2026-08-13

### Changed: movable-list co-editing rooms (per-room format, no flag day)

New sessions seeded by a 1.0 host store top-level children in a
movable-list CRDT container instead of a plain list. Moves are now
first-class operations that preserve card identity, which fixes the
one concurrency corner beta.32's rotation diff could not: two peers
concurrently moving the *same* card could merge to a visible
duplicate (never a loss). Movable rooms are strict exactly-once under
the same 150-seed fuzz. Comments, marks, and any state keyed to a
card's container identity also survive moves instead of being
silently re-created.

The room format is fixed at seeding and inherited by every container
created later in that room, so rooms are homogeneous forever — a 1.0
client joining an old room writes old-format containers, and there is
no flag day. Old builds cannot read movable containers at all, so
invites to movable rooms carry a `1.0.0` compatibility floor and
pre-1.0 builds decline cleanly. Old rooms keep working for everyone
and age out on the relay's 7-day idle sweep.

### Changed: X-CardMirror-Routing header (entitlement machine binding)

Requests whose bearer is a Debate Decoded entitlement now carry the
machine's routing code (the public sha256 of its pairing key) in an
`X-CardMirror-Routing` header, on both relay surfaces: card sharing
(main process `authHeaders()`) and co-editing rooms (renderer;
`host:collab-relay-defaults` hands the routing code over exactly when
the token it returns is an entitlement). The relay can then verify the
token's `rc` claim names the requesting machine — entitlements are
otherwise freely-copyable bearer tokens. The header is omitted for
shared-token and self-hosted-relay requests: there is no claim to
match, and a strict self-hosted CORS setup shouldn't need to allow
it. Server-side enforcement is a dormant admin-console toggle, to be
flipped only alongside a ≥ 1.0.0 minimum-version floor.

### Fixed: reorders emit real move ops (span-drag fusion)

The movable migration shipped the container format but the binding
still delete-and-recreated on reorder — the first real movable-room
session's history contains zero move ops. A nav-pane section drag
relocates a SPAN of flat siblings, a shape the single-rotation
detector didn't cover, so concurrent span drags fell through to
upstream's index-aligned rewrite: both peers rewrote the same
surviving text containers (concurrent same-position inserts both
survive — doubled tag text, observed live) and both recreated the
dragged block (twins). A general pure-permutation detector now serves
both list kinds: movable rooms apply real `move()` ops
(identity-preserving, exactly-once under any concurrency — 150-seed
span fuzz), pre-1.0 list rooms rebuild only the dragged children
(nothing lost; same-card contention still twins, visibly). Child
identity is weak-map-first with content-equality residue matching, so
a remote recreation's PM-node reuse can't stale the detector into
the upstream path.

### Fixed: Recover Previous Version hang (checkout-free rebuild)

Loro's `checkout()` spun unboundedly (100% CPU, 10+ minutes, no
return) materializing versions of a real movable room's history —
every machine that opened Recover on that session hung. Recover never
needed checkout: `materializeVersion` now cuts the update log at the
row's version (`frontiersToVV` → `exportJsonUpdates` prefix) and
imports it into a fresh doc — identical state, seconds (the hanging
session's own rows rebuild in 1.6–5s), and the scratch doc stays
attached so mid-node cuts need no detached editing. A regression test
booby-traps `checkout()` to keep it out.

### Fixed: join-by-code fence for versioned rooms (cmshare2)

The invite path enforces `minReceiverVersion`, but "Join Collaboration
Session" with a pasted share code bypassed it entirely: a pre-1.0
build joined a movable room and crashed on the first arriving move op
(wasm "Unreachable code" — found in live testing). Old builds cannot
be patched, so the fence is the code format itself: movable rooms mint
`cmshare2.<roomId>.<key>.<minVersion>`, which every parser shipped
since co-editing's debut (beta.10 — verified byte-identical through
beta.32) rejects with its existing "does not look like a share code"
message. Current builds read the embedded floor and show "update to
join" for any future floor above the running version; list rooms keep
minting v1 codes so old builds can still join them. Remaining join
surfaces audited: invites (floor-gated since beta.8), resume (own
records only — unreachable for movable rooms once the code fence
exists), no deep-link handlers, web edition cannot join.

### Version 1.0.0

The version bump itself activates two dormant mechanisms shipped
earlier: movable-room seeding + invite floors (above), and the
relay-side minimum-version gate's ability to distinguish 1.0 builds
(the version header shipped in beta.32; the floor remains off until
flipped server-side).

## 0.1.0-beta.32 — 2026-08-12

### Added: Recover Previous Version (session history files)

Co-editing gives each participant undo over only their own changes, so
a session that gets wrecked had no recovery path once it ended: the
crash-recovery session record is deleted on Leave/End/tombstone by
design, `.cmir` files carry no CRDT history, and the relay compacts and
then tombstones its copy. Every past state was gone everywhere the
moment a session ended normally — no attacker required.

Each session now writes `{roomId}.cmir-history` into the journals
folder: a full Loro snapshot (state + complete oplog) in a JSON
envelope, written every ~20s while the session runs, on pagehide, and
once at teardown — and **retained** through Leave, End, and remote
tombstone alike, since a hostile joiner can end a session for everyone.
Age/size pruning (30 days; 500 MB oldest-first as a runaway guard) runs
in the main process at startup and hourly. The distinct extension keeps
the crash-recovery scanner from ever offering one as a crash candidate.

The CRDT deliberately records no wall-clock time (`setRecordTimestamp`
would grow every change and publish per-peer edit times), so the
envelope carries *local observation times*: each write notes how far
every peer's op counter had advanced. The version list is derived at
dialog-open from the snapshot's change graph — one frontier per change,
grouped by >1-minute idle gaps, expandable to individual changes —
and timestamps come from those observations. Recovery checks the chosen
frontier out on a scratch `LoroDoc` (never the live session's),
materializes it via `createNodeFromLoroObj`, and spawns a new window
with the result as an unsaved document: impossible to confuse with, or
reflex-overwrite onto, the canonical file. Tests pin the full
round-trip (derived frontier → checkout → materialize equals the
checkpoint doc, marks and attrs included), that every derived row of a
branching two-peer graph yields a valid frontier, grouping edge cases,
and that the writer's dispose path flushes but can never delete.

### Fixed: concurrent card moves corrupted co-edited documents

`loro-prosemirror` reconciles a reordered children list by
delete-and-recreating every misaligned pair, so moving one card past N
siblings destroyed and rebuilt all N containers. Measured on a 300-card
file: ~0.65 KiB of permanent oplog per position traversed (~206 KiB for
one long nav-pane drag, carried by every subsequent snapshot, joiner
download, and history file for the life of the room) — and, far worse,
concurrent partitioned moves corrupted the merge: 16 cards lost and 16
duplicated across six two-peer scenarios, silently, with both peers
agreeing on the damaged result. The heal stack cannot help; the lost
containers' ops no longer exist. Requires true concurrency — both
moves made before either peer saw the other's, which live sync
narrows to a sub-second window — so offline/partitioned editing was
the realistic trigger and most sessions never hit it.

The dependency patch now detects that the misaligned middle is a pure
rotation and emits one delete + one insert instead of rewriting the
span. Identity is matched through the binding's own container→node
mapping, so a child *edited* in the same transaction falls through to
the upstream path untouched. Mixed-version safe (the diff only shapes
ops a peer emits for its own edits; both paths emit plain `LoroList`
ops), so it protects proportionally as users update. New tests pin
zero loss/duplication under partitioned concurrent moves, a canary
that re-detects the upstream bug with the patch disabled, the
wire-cost reduction, and undo/redo round-tripping a long move.

A dedicated move fuzzer (3 peers, offline partitions, moves at 45% of
the op mix, 150-seed sweep) established the shipped semantics
precisely: **zero cards lost across every seed**, full convergence and
validity — with one known corner: two peers concurrently moving the
SAME card can leave a convergent duplicate, because each move
recreates the card and both recreations survive the merge. Visible
and user-fixable, unlike the silent loss this fix eliminated. The
same fuzzer running in movable-list mode passes the strict
exactly-once invariant across all 150 seeds, confirming the flagged
`LoroMovableList` container (planned for the v1.0 cutover) closes
that corner completely.

Also carried in the patch, inert behind a flag: a `LoroMovableList`
children container for the planned v1.0 cutover (container types
cannot be mixed across builds — an old build cannot read a movable
children list at all, and concurrent creation with different types
silently discards one side), plus read-side tolerance for it.

### Fixed: Clean's overwrite confirmation was unenterable as displayed

The in-place overwrite dialog gates on typing a phrase. The phrase
constant is sentence case, but the instruction label is rendered with
a class carrying `text-transform: uppercase` — a purely visual
transform that leaves the DOM text untouched. The gate compared
`input.value.trim()` to the constant exactly, so a user who typed what
the label displayed could never enable **Confirm Overwrite**, and the
Enter shortcut was closed off by the same comparison. The input's
`placeholder` is set from the constant and is not covered by that
class, so it showed the accepted form — which is why the dialog worked
for anyone who copied the placeholder and failed for anyone who read
the instruction above it.

Matching now runs through one exported helper (`matchesOverwriteConfirmPhrase`)
that lowercases and collapses whitespace on both sides; the button's
enable check, its click handler, and the Enter shortcut all call it
instead of repeating an inline `===` that could drift apart. The
phrase itself moved to an exported constant. The label additionally
opts out of the uppercase treatment via `.pmd-clean-overwrite-prompt`,
so instruction, placeholder, and comparison agree — but the
case-insensitive match is the load-bearing half, since it keeps the
dialog correct no matter what styling is later applied to the text.

### Fixed: OS detection missed ChromeOS entirely and mislabeled iOS

`detectOS` in `install-info.ts` walks a chain of user-agent substring
checks. Two of them were wrong in ways that only showed on the
platforms where the answer matters most.

iPhone agents contain the string `like Mac OS X`, and the macOS branch
ran two checks ahead of the iOS branch, so every iPhone was reported as
macOS — the iOS branch was unreachable. iOS now runs first (and covers
iPod alongside iPhone/iPad). Desktop-class iPadOS remains reported as
macOS and is pinned as such by test: Safari on a modern iPad sends the
`Macintosh; Intel Mac OS X` agent verbatim, so no string-based check
can separate them, and guessing from touch points would mislabel real
Macs.

Chromebook agents read `X11; CrOS x86_64 …` and match neither `Linux`
nor `Android`, so they fell through every branch to `Unknown`. A
`CrOS` case now runs ahead of the `Linux` check (order matters for the
same reason Android precedes it). This is diagnostic-only text, but it
appears on the platform whose reports are hardest to reason about
without it.

### Changed: relay requests carry the client version

Every request to the relay now sends `X-CardMirror-Version` naming the
running build: from the mailbox's shared `authHeaders` (covering the
send POST, the catch-up poll, deletes, and the delivery stream), from
the entitlement `connect` call, and from the rooms client's REST and
stream paths. The header name lives in a dependency-free module so the
main and renderer bundles can share it without dragging in each other's
environment.

Nothing reads it yet — it is advisory. The relay previously had no way
to distinguish client versions at all: the version travelling with a
shared card sits inside the sealed envelope and is unreadable by the
host by design, and requests otherwise carried only a bearer token.

Ordering note for whoever wires up a consumer: the relay's `/relay/*`
CORS layer answers preflights with an explicit allowlist rather than
the app-level wildcard, and a preflight that omits a requested header
fails the entire request. The header had to be allowlisted and
deployed *before* any client could send it, or every browser-context
client — the desktop renderer included, since rooms traffic originates
there — would have lost co-editing. That deploy is live and was
verified against production.

## 0.1.0-beta.31 — 2026-08-10

### Morph mode (Sensel control surface)

The Sensel Morph's overlays can't be remapped without the
discontinued Sensel App and a USB data connection, so Morph mode
takes the opposite approach: the video-editing overlay's fixed HID
keyboard vocabulary is interpreted *inside the editor*. Movement
stays native — the jog wheel emits arrow keys (burst-damped: the
overlay sends several ticks per detent, so sub-60ms same-direction
ticks are coalesced, while held-key auto-repeat passes through
untouched), and the overlay's real modifier keys give the exact
keyboard selection semantics. Formatting pads fire only while a
selection is active and are interpreted before any keymap sees them;
with a bare caret every pad types its letter, so tag and cite text
can be written without disarming. Pads that emit chords (⌘K, ⌘D, ⌥.)
are matched exactly, and the Slip/Nudge pads — which emit bare
right-side modifiers — bind via tap-vs-hold detection on the
right-hand key codes only, so the physical modifier cluster and
normal typing never misfire them. Bindings persist in localStorage
and are edited from a schematic of the overlay labeled with its
printed legends; every pad picker is searchable. Armed state is
toggled by the `toggleMorphMode` command (no default key) and
survives plugin reconfigures and multi-pane rebuilds.

### Open Crash-Recovery Journals Folder

`openJournalsFolder` opens the OS file manager at
`{userData}/journals`, creating the folder first so the command
never lands on an error. Electron-gated (hidden on web). Palette
aliases cover "crash", "recovery", "restore", "lost work", and
"autosave folder" so it's findable under whatever name a user
reaches for.

## 0.1.0-beta.30 — 2026-08-07

- **Read-mode paragraph integrity** (new `readModeParagraphIntegrity`
  setting; `style.css`, `index.ts`, `multi-pane-shell.ts`). Read mode
  fuses a card's body paragraphs into one flow via `display: contents`
  on `.pmd-card-body` — the paragraphs' boxes leave layout entirely and
  their kept runs become inline siblings of the tag/cite. Readers who
  navigate by the document's shape had no way back. The setting stamps
  `pmd-rm-para-integrity` on the editor host (single-doc) or the pane
  element (multi-doc, beside the existing `pmd-rm-no-emphasis-borders`)
  and restores `display: block` to `.pmd-card-body` and to table cell
  paragraphs — the table's container chain deliberately stays
  `contents`, so only the cell paragraphs come back as lines, not the
  table's boxes. Paragraphs holding no read-aloud text are hidden
  outright by `:not(:has(.pmd-rm-keep))`, or every un-highlighted
  paragraph would leave a blank line, which is worse than the fusing
  the setting exists to fix. Display-only, mirroring the condense
  setting of the same name; off by default. (PR #33, thanks to
  [Cora](https://github.com/coralynnkc).)

  Fixed alongside: the single-doc settings subscriber routed read-mode
  display-preference changes through `applyReadMode(s.readMode)`. Under
  multi-doc, `settings.readMode` stays `false` while a pane reads (read
  mode is per-pane), so flipping either display preference dispatched
  toggle-OFF into the focused pane's view — its hide decorations went
  away while the pane element kept `pmd-read-mode`, i.e. read mode
  suddenly showing every word of every card. The subscriber now skips
  the block entirely under `multiDocActive`; the shell's own subscriber
  re-stamps the classes per pane, which is all a display preference
  needs. Reachable before this release via **Hide all emphasis borders
  in read mode**.

- **Changed-on-disk guard: content-hash rescue for sync metadata churn**
  (`apps/desktop/src/doc-writes.ts`). The guard remembered mtime+size
  per path; cloud sync layers rewrite mtimes without touching content
  (rclone finalizing its upload of OUR OWN save — field report
  2026-08-06, Linux + rclone Dropbox mount — refused every second save
  as changed-on-disk). The baseline now also carries a sha256 of the
  bytes CardMirror last read/wrote (all read and write paths pass
  them); on a stat mismatch the guard reads the file back and compares
  before refusing — identical bytes = metadata churn, save proceeds
  and re-baselines. Real edits, including same-size ones, still refuse
  (covered by the existing regression test). Baselines recorded
  without bytes (older paths, journal recovery) keep the strict
  behavior.

- **EPIPE-proof main-process stdio** (new `apps/desktop/src/
  stdio-harden.ts`, first executable statement in main.ts). On Linux
  the app's stdout/stderr are often pipes owned by a since-closed
  launcher; any console call — including Electron's own
  `replyWithError` console.error when an ipcMain.handle rejects —
  then raised EPIPE as an UNCAUGHT exception and popped the
  main-process crash dialog, masking the real error (same field
  report: every refused save produced the dialog). One 'error'
  listener per stream makes logging best-effort; the cardmirror-read
  CLI has shipped the same guard for piped stdout since 2026-07.

- **Web saves: refresh-and-retry ladder + Save-As routing for blocked
  writes** (`browser-host.ts`, `error-surface.ts`, `index.ts`). Field
  report (ChromeOS, beta.27): in-place saves failed with Chromium's
  raw InvalidStateError ("state cached in an interface object …
  changed since it was read from disk") in cloud-provider mounts —
  and on a Chromebook both Dropbox and the natural "outside Dropbox"
  destination (Google Drive) are Files-app provider mounts. Two app
  bugs made it a dead end: the changed-on-disk handling matched only
  the Electron EMODIFIED marker (browser DOMExceptions fell to a raw
  Save-failed alert), and BrowserHost accepted-and-ignored the
  Overwrite path's force flag, so the retry repeated the identical
  failing call. BrowserHost.saveExisting now runs a ladder: on
  InvalidStateError / NoModificationAllowedError, refresh the
  handle's cached state (getFile), pause 300ms, retry once (rescues
  the transient sync-churn variant), then rethrow marked
  EWRITEBLOCKED — which the renderer routes to Save As, the only
  honest exit on a mount that refuses in-place writes.

## 0.1.0-beta.29 — 2026-08-05

- **Comments travel with the clipboard** (new
  `src/editor/comment-clipboard.ts`, wired beside `commentsPlugin` in
  `index.ts`). The `comment_range` mark always survived copy/paste
  (its toDOM carries the threadId — hence the orphaned yellow span),
  but thread content lives in plugin state, not the document. The
  plugin closes that gap end to end:
  - **Copy:** a custom `clipboardSerializer` inlines each thread as
    JSON in a `data-pmd-thread` attribute on the comment span, read
    live from the copying view's comments state. The OS clipboard is
    the carrier, so cross-window and cross-machine pastes work; older
    builds pasting the same HTML simply ignore the attribute.
  - **Paste:** `transformPastedHTML` lifts the payloads into a
    short-TTL stash and strips the attribute (it must never become
    document content); an `appendTransaction` restores any referenced
    thread the target document lacks through the ordinary add-thread
    meta, so undo, the collab mirror, and every serialization path see
    it like a user-created thread.
  - **Duplicate over share:** pasting where the thread already exists
    clones it under a fresh id — every comment id in the clone
    re-minted, reply parent links remapped — matching Word. The pass
    is gated on the transaction's paste/drop `uiEvent` *and* a
    stashed payload for that id, so ordinary typing inside a commented
    range can never re-id the original. Same-document cut + paste
    still resurrects the parked thread via the comments GC's tombstone
    path, untouched.

- **Comment integrity guard** (new `src/editor/comment-guard.ts`,
  wired after the clipboard plugin in `buildEditorPlugins`, so both
  shells get it). The clipboard plugin can only fix the paths it sits
  on; every OTHER duplication mechanism (Alt-drag copies, nav-pane
  option-drag, dropzone re-inserts, self-sends, future paths) copies
  `comment_range` marks too, and two spans with one threadId render
  as a single comment bridged across everything between them. The
  guard enforces the invariant at the one chokepoint all mechanisms
  share — the transaction:
  - Triggers only when a step INSERTS comment-marked slice content
    (mark-only steps — comment creation — never trigger; the O(doc)
    span scan never runs on ordinary typing).
  - Diffs each thread's spans against the old state's spans mapped
    through the transaction (tight bias at insertion boundaries):
    surviving content is the original and untouchable; disjoint new
    content with a known thread (live or tombstoned) is re-ided to a
    fresh duplicate thread, trimmed at the mapped boundary so even an
    exactly-adjacent copy can't fuse; content whose thread nobody has
    is stripped (no phantom highlights — this is what makes
    cross-machine sends safe, since the send pipeline doesn't carry
    thread content).
  - Moves (all old spans deleted in the same transaction) keep their
    id; deletion splits keep their id on both halves; sync-origin and
    history transactions are skipped entirely (remote content is
    already-merged fact — each replica guards its own edits before
    they ship; undo restoring a span is not duplication).

- **Comments panel redesign** (`comments-ui.ts`, `style.css`; notes
  and AI Q&A inherit — same classes). Field complaint: every identity
  row wrapped differently at panel width, so nothing aligned. Changes:
  identity rows are now avatar + a stacked `pmd-comment-idcol` (name
  over nowrap muted timestamp — nothing can wrap raggedly); comment
  bodies indent 1.8rem to align with the name column; the expanded
  card head drops its date (it duplicated the root comment's,
  two lines down — collapsed cards keep theirs, it's their only one);
  the resolve control is a quiet borderless check (accent glyph when
  resolved, card still dims) matching the pencil/✕ language instead
  of a filled accent circle; per-comment edit/delete reveal on
  hover/focus-within (thread-level controls stay visible); the
  composer's send key is a compact 1.9rem square pinned to the
  textarea's bottom edge (was stretched to its full height) and the
  👍 is a matching ghost square. All four composer textareas (reply,
  AI question, note, inline edit) auto-grow via a shared `autoGrow`:
  rows=1 at spawn (matching the 1.9rem buttons when empty), height
  tracks scrollHeight per input, CSS max-height (~6 lines) caps it
  and hands off to the internal scrollbar; manual `resize: vertical`
  removed (the drag handle fought the auto-height every keystroke).
  The inline-edit form's line-count row guess is gone — pre-filled
  text measures itself on the next frame.

- **Pill-tray scroll clearance** (new
  `src/editor/pill-scroll-clearance.ts`, in `buildEditorPlugins` —
  both shells). The tray already triggered a bottom padding runway on
  the doc (`pmd-pill-tray-active` rules), so the last lines COULD
  scroll clear — but PM's type-time auto-scroll didn't know the
  bottom strip was obscured and parked the caret behind the pills.
  The plugin supplies PM's `scrollThreshold`/`scrollMargin` props
  with a live bottom value: prop-object side getters re-measure the
  tray's rect on every scroll pass (no listeners; correct across pill
  show/hide, panel expansion, editor zoom), clamped so a transient
  expanded panel can't yank the viewport, and zeroed for multi-pane
  panes other than the tray-anchored one. Clicking to park the caret
  at the bottom deliberately does not scroll — PM only applies these
  props on its scrollIntoView passes (typing, arrow keys, paste).

- **Send pill actions row** (`send-pill-ui.ts`, `settings-ui.ts`,
  `pairing-ids.ts`). A second bottom row in the expanded pill: **Add
  contact** and **Start session** buttons in click mode; the same
  geometry becomes two drag zones in drag mode (send to a pasted code
  as a one-off; recent senders). Details:
  - Add contact prompts for the code (validated with the new
    `looksLikePairingCode` — `cmk1.` prefix — since a blind paste has
    no other sanity check), then for a display name, pre-filled from
    the recent-senders ledger when the sender self-declared one;
    cancelling the name prompt aborts the add. New contacts append to
    the *bottom* of the recipients list. Duplicates and junk codes are
    refused with a toast.
  - Start session reuses the Start Collaboration Session flow through
    a new `collab-hooks.ts` seam and hides when collaboration is
    unavailable.
  - The recent-senders list opens as a flyout to the *right* of the
    pill (the pill panel scroll-clips absolute children, so the flyout
    is a sibling positioned off the panel's live rect) with sticky
    reveal — it stays open while the drag crosses the gap and only
    hides on a genuine other target or pill collapse. Blocked codes
    are excluded; your own nickname for a known partner wins over
    their self-declared name.
  - Settings: **Recent senders** is promoted to a titled row in
    Settings → Collaboration (blocked-senders styling) with per-row
    Add… (name prompt) / Block and an "In recipients" badge.
    Recipients gained a hide toggle (`PairingPartner.hidden`,
    preserved by the settings sanitizer); hidden partners are
    filtered from pill rows only — group fan-out and Send to Starred
    still include them.

- **Atomic multi-selection bundles** (`send-pill-ui.ts`
  `bundleSendItems`, `inbox-store.ts`, `receive-pill-ui.ts`). A
  multi-item drag concatenates the captured slices into ONE SendItem
  (label "First + N more"), falling back to per-item sends when any
  slice has open ends. The receive row shows a **×N** badge computed
  from the slice itself — no wire change, so mixed versions agree:
  `inboxItemCardCount` counts top-level nodes at the *highest outline
  rank present* (pocket > hat > block > card), so one dragged block
  with its cards is ×1, two blocks are ×2 regardless of card count,
  and a slice with no headings counts its nodes. Grabs are atomic by
  construction: click, drag, and ✕ all act on the single bundled item.

- **Nav depth on arrival** (`inbox-insert.ts` nav hook; `index.ts` /
  `multi-pane-shell.ts`). Inserting from the Receive pill and
  sync-arrived headings (session join, catch-up) now run the nav
  pane's `applyMaxLevelToNewHeadings` — new headings fold to the
  pane's active depth instead of arriving fully expanded. Sync
  transactions are detected via `isSyncOrigin` in both the single-pane
  and multi-pane dispatchers.

- **Cursor overlay: per-peer error containment**
  (`patches/loro-prosemirror+0.4.3.patch`, both dist builds;
  regression test `tests/collab/cursor-missing-container.test.ts`).
  Field storm: "The container does not exist in the doc" on every
  presence frame. A peer's cursor can reference a Loro container this
  replica doesn't have — deleted here concurrently, or the presence
  frame outran the doc frame (presence and doc updates are separate
  channels with no cross-ordering). The vendored cursor plugin rebuilt
  all decorations with no per-peer containment, so one unresolvable
  cursor killed the whole redraw, repeatedly, until the presence store
  expired the entry (45s). Each peer now resolves inside its own
  try/catch: the unresolvable peer's cursor is skipped (their next
  frame or the arriving doc update heals it) and every other peer
  still renders; the peer stays in the roster.

## 0.1.0-beta.28 — 2026-08-05

- **Reformat Every Cite in Document (AI)** (new
  `src/editor/ai/reformat-all-cites.ts`; ribbon `reformatAllCites`,
  unbound by default, in the AI group; wired in `index.ts` /
  `ribbon-groups.ts`). Runs the existing `aiCreateCite` pipeline — same
  prompt, `parseCiteResponse`, `buildCiteTransaction` — over every
  `cite_paragraph` in the open document, one at a time. Nothing about
  per-cite behavior is re-implemented; this is the driver. Design points,
  all forced by "one model request per cite, on a doc that can hold
  hundreds":
  - **Confirm first.** A short dialog states the exact request count
    ("2 cites … that is 2 model requests"), that each cite is its own
    undo step, and that Esc stops the pass. Declining touches nothing.
  - **One lease at a time, not one per cite.** A whole-document lease
    would block the user from typing for the entire run; N live leases
    would make every keystroke run N `leaseTouched` region diffs in
    `coordinatorBlocks`. The pass claims and releases per cite, so the
    rest of the doc stays editable and a cite another AI op already
    holds is skipped (counted, not failed).
  - **No cached positions.** The pass walks a document cursor and asks
    the LIVE doc for the next `cite_paragraph` each iteration. A
    precomputed position list or an ordinal index breaks on three real
    cases: the rewritten cite changing length, a user edit elsewhere
    during the run, and a rewrite the cite classifier DEMOTES to
    `card_body` because no token could be located (cite-ness is the
    mark). All three are covered by tests.
  - **One transaction per cite**, so partial progress survives a failure
    and a bad cite undoes on its own. A single failed cite doesn't abort
    the pass; an `auth`/`model` `LlmError` does (it would otherwise
    repeat identically for every remaining cite).
  - **Progress and stop.** The activity pill narrates "Cite N of M · Esc
    to stop"; Escape sets a cancel flag checked between cites (the
    request in flight still lands) and stands down while a modal is open
    so it can't swallow a dialog's Escape. One end-of-run summary toast
    tallies reformatted / failed / skipped / left-unstyled — the
    per-cite unstyled toast from `applyCiteToSelection` would be a toast
    storm across a document, so the pass calls `buildCiteTransaction`
    directly and reads `CITE_TOKENS_MARKED_META` itself.
  Smoke-tested in the browser against a stubbed provider: the palette
  finds it by "reformat all cites", the confirm text pluralizes
  correctly (1 cite / 2 cites), both cites were rewritten in place with
  `cite_mark` intact, undo stepped back one cite at a time, and Escape
  mid-flight stopped after one request with "Reformatted 1 of 2 cites ·
  stopped." Docs: MANUAL.md §13 AI table + the Verbatim-users note (the
  "ReformatAllCites isn't in CardMirror" claim was stale),
  ARCHITECTURE.md §13/§14, PROJECT.md status.

- **Causal mark heal** (`src/editor/collab/causal-mark-heal.ts`, wired
  in `collab-ui.ts` installSeams). Peritext range marks cover text
  concurrently inserted inside their range, so a paragraph one peer
  retyped while another was highlighting it converged fully
  highlighted with no op recording anyone's intent. The heal enforces
  *inserter intent* causally exactly: a governed mark (highlight /
  underline / emphasis / shading; `comment_range` deliberately
  ungoverned — region growth is its job) may cover a character iff the
  char's insert op and the covering mark op are causally related in
  the CRDT's dependency graph — the typist had seen the mark, or the
  marker had seen the text. Concurrent pairs strip, on every replica
  identically (verdicts are pure functions of op history; pinned by
  running the 15-seed loro fuzz with the heal active per import).
  Mechanics: binding transactions only, changed-range-scoped, cheap
  governed-mark pre-check, incremental op-log index
  (`exportJsonUpdates` with peer compression OFF — compressed ids
  index a peers[] table and match nothing), char origins via the Loro
  cursor API through the binding's container mapping, strips ride a
  normalizer-guarded history-excluded PM transaction, and every
  ambiguous case fails toward keep. Not compatibility-breaking:
  strips are ordinary unmark edits; one healed peer heals a mixed
  room.

- **Co-editing performance batch** (perf study 2026-08-06; the
  keystroke-latency reports from five-person sessions). Three fixes:
  (1) cursor presence frames now buffer on a 150ms receive-side drain
  (`CoalescingCursorStore` in `collab-cursors.ts`; the vendored
  adapter subscribes via `subscribeBy`, whose implementation bypasses
  `subscribe` — the override targets it, and the batch resolves to ONE
  listener notification, so 20 frames/sec became 5 dispatches/sec
  measured); (2) inbound doc frames micro-batch on a 120ms window
  (`collab-session.ts` — per-row audit-ledger folds and the echo
  watchdog stay per-frame; one `importBatch` → one binding transaction
  → one plugin-pipeline pass per window; the `lastSeq` cursor-lag
  invariant untouched, and buffered frames are droppable at teardown
  precisely because the cursor never passed them); (3) the leader's
  per-frame repair now hands `fixTables` its `oldState`
  (prosemirror-tables' changed-regions fast path; import/open keep the
  full scan as backstop) and the heal-toast sentinel scan is gated
  behind its own 60s cooldown (provably behavior-identical — a
  sentinel found during cooldown was both toast-suppressed and
  canonicalized in the same pass). Related: the "synced offline
  edits" toast now requires a ≥60s stream-blind window whose catch-up
  actually advanced the doc version — the fetch cursor deliberately
  lags the stream, so the old frame-count trigger fired on routine
  re-fetches of already-applied frames.

- **Open-from-disk session rejoin** (`checkSessionRejoinForOpenedDoc`
  in `index.ts`, both open funnels; records stamp the doc's persistent
  id via a uid→docId resolver in `collab-persist.ts`). Opening a file
  whose docId matches a resumable session record offers exactly two
  doors: Rejoin — `resumeSessionFlow`'s previously-uncalled
  `existingDoc` mode binds the session into the just-opened doc in
  place (multi-pane deps pinned to the opened pane's uid; no slot
  picker, the open already chose placement) — or Leave, which deletes
  the record. Esc counts as Rejoin; there is deliberately no
  edit-locally door. Companion: session titles republish on save
  (host-only) and joiners adopt live via a meta-map subscription, with
  saved-doc guards so adoption never renames a copy the user saved.

- **Comments: resolve + 👍, and focus retention under co-editing.**
  Resolve is modeled as `resolved` on the thread's root comment,
  flipped via a plugin meta (undo, collab mirror, and both docx
  directions see it like any mutation); export writes real `w15:done`
  per comment of a resolved thread and import reads it back — the one
  comment primitive beyond replies the format durably supports. The 👍
  button posts an ordinary emoji reply (Word has no portable reaction
  primitive; a reply is the round-trippable equivalent). The comments
  column's render loop also switched to minimal-move reconciliation —
  its unconditional `appendChild` re-parented every card each render,
  which detached (and blurred) the focused reply textarea on every
  remote edit.

- **Nav pane: multi-selection context ops + creators.** The four
  context-menu operations act on the whole multi-selection when the
  clicked row belongs to it (file-manager semantics); cut/copy
  concatenate doc-ordered subtree ranges (overlap-merged, so
  parent+child never double-copies), deletes apply back-to-front in
  one transaction, and multi-Select routes through
  `setManualShadowSelection` — the discontinuous shadow selection the
  format commands already consume. New creator items build a live view
  or in-doc linked copy of the clicked heading at the cursor via the
  same functions the pickers call, with the picker's self-containment
  guard.

- **Color toggles: same-color-only toggle + gap-fix interplay.**
  `applyHighlight`/`applyShading` only strip when the whole range
  already wears the *active* color (scanTextMarkPresence grew attr
  matching); a different color repaints via the existing
  removeMark+addMark path. And the toggle *decision* now scans the
  operating range with edge whitespace shaved (`toggleScanRange`):
  the auto-bridge gap-fix polices selected edge whitespace (protects
  punctuation, deliberately not spaces), so counting those characters
  locked select-F11-F11 into a repaint fixpoint. Applied to
  highlight/shading/underline; emphasis is not a toggle.

- **Smaller fixes.** The transclusion-divergence check gates on the
  VIEW's own read mode (host-element class) instead of the global
  setting multi-doc mode deliberately ignores — restoring the
  "source updated" nav rail in panes. The paint strip-pen override
  moved to ⌃ Control on macOS (⌥-drag is the OS window-move gesture;
  ⌘ is spoken for; Alt elsewhere), with the platform read per call.
  In-flight AI narration is composed by one persona-aware function
  (`inFlightLine`), so a configured persona name shows everywhere and
  stage strings like the cite pass's counter read as sentences in
  both modes; the progress pill also wraps long narration at its cap
  instead of shearing mid-word (its container tracks the measured
  line box, which previously locked wrap width to a stale value).

## 0.1.0-beta.27 — 2026-07-30

- **File-index service (utilityProcess) + off-thread warm parsing.** The
  boot-window resize freeze (external move/resize right after a window
  opened showed a stretched stale frame for seconds) was the file-search
  boot pipeline: main loaded/persisted the index and walked every root
  (55k+ stats over Dropbox's File Provider), every launch structured-
  cloned the whole corpus into the renderer, and the pin warm pass
  parsed files on the renderer thread at idle+2s. The index AND the
  search now live in a utilityProcess (`file-index-core.ts` +
  `file-index-service.ts`, esbuild-bundled; main only brokers one
  MessagePort per window) — a query sends params, ranked top-N rows +
  total come back, and the corpus never crosses a process boundary.
  Ranking imports the same `searchFiles` the renderer used, so
  semantics can't drift. Warm-pass parse+extract moved to a Web Worker
  (`warm-parse-worker.ts`); the doc crosses back as ProseMirror JSON and
  materializes once on a real dive. Arrivals fold in latest-wins-
  PROGRESSIVELY (dropping superseded responses read as a debounce);
  known-root revalidation waits 3s past configure so the palette-open
  typing burst never shares the service thread with the walk.

- **Index prunes removed roots** (`host:cmir-prune-index` era, now
  `configure`): removed search folders persisted in the on-disk index
  forever, growing the file without bound. The
  renderer reports the full current-roots set at boot and palette open;
  the service drops the rest and rewrites only when something changed.

- **File search exclusions** (`fileSearchExclusions`, pathList settings
  widget, ⊘ row button behind a confirm): filtered service-side at the
  single choke point where listings become results, so exclusions also
  keep excluded pins out of the warm pass (pin left dormant by design).

- **Two-rate read times** (`ReaderConfig.tagWpm`): counting splits into
  highlighted-body vs tag/analytic/cite buckets (`countReadAloudSplit`);
  blank second rate reproduces the single-rate arithmetic exactly. All
  four surfaces (status bar, pane footers, container segment, Word
  Count dialog) use the split; both reader editors gained the field.

- **Live-view picker matches like the palette**: `matchesAllTokens` /
  `tokenizeQuery` exported from file-search.ts and used by
  self-ref-picker.ts over heading text + tag cite (collected in its one
  collectHeadings pass). Outline order kept — it's a tree, not a
  ranked list.

- **In-file right-click jump**: flat search hits reveal themselves in
  the outline browse (ancestors expanded, row selected, pinned to the
  viewport top via an explicit `block: 'start'` scroll after
  selection's `nearest`).

- **Recents**: multi-pane `loadOpenedIntoSlot` records string-handle
  opens (same guard as the single-doc mount); the store re-notifies on
  the cross-window `storage` event; cap 6 → 10 (list grows, no inner
  scroll — user's call); home rows and settings path cells tail-
  truncate (direction:rtl + LRM guards in `setPathCell`).

- **Card-by-tag linked copies from .docx**: `ensureDocxSourceAnchor`
  re-derived the heading id with naive `nodeAt(pos).attrs.id` — for a
  tag row that position is the CARD wrapper (no id; it lives on the tag
  child) — and passed the wrapper's whole-card text to the anchor's
  paragraph cross-check. Now uses `resolveHeadingIdAt` + the heading
  paragraph's own text (`headingTextAt`). Importer provenance and
  bookmark-id reimport already covered tags.

- **Palette keyboard focus**: Chromium's click-focusable scrollable
  containers meant any click in the results list (esp. right-click
  expand/collapse) moved focus to the scroller — arrows then scrolled
  natively and keys never reached the palette. `mousedown` on the
  results container is now default-prevented; the input keeps the
  keyboard through every list interaction.

- **cardmirror-read CLI** (`src/tools/cardmirror-read-{lib,cli}.ts`,
  bundled single-file to `packaging/cardmirror-read/cardmirror-read.cjs`
  via `npm run build:readtool`; README with curl one-liner). Field
  request: an AI desktop assistant reading a user's Dropbox can't
  consume `.cmir` (gzip envelope) or `.docx` (zip) directly. Two
  forms: `--form json` = uncompressed envelope — for `.cmir` a pure
  gunzip+pretty (works on damaged files; forensics-friendly), for
  `.docx` the real importer + real `serializeNative` save path, so
  output ≡ Save-As-.cmir; `--form text` = markdown-flavored rendering
  (#/##/### Pocket/Hat/Block, #### tag/analytic, `Cite:` lines,
  ==highlight==/__underline__/*emphasis* with adjacent-run merging and
  wrapper-outside-whitespace, tables as pipe rows, transclusions
  rendered as labeled cached copies, footnotes inline). Default
  output: ONE stdout line = absolute path of a chmod-444 temp file
  (agent-friendly); `--stdout`/`--out` variants. Reuses parseNative
  (heals incl.) + fromDocxFull — both proven DOM-free — so the tool
  can't drift from the app. Errors: NativeDamagedError → suggests
  --form json; unsupported types exit 1. Tests: renderer + serialize
  round-trip (tests/tools/). Verified against real backfiles: Space
  Aff Demo .cmir (52 MB pretty JSON — README warns text is the
  reading form) and a real cut .docx. FOLLOW-UP (same day): two
  automation modes, both in the same single file. `--mcp --root …`
  (repeatable): a hand-rolled tools-only MCP stdio server
  (newline-delimited JSON-RPC; initialize/ping/tools list+call;
  notifications get no reply) exposing `list_debate_files` (substring
  filter, 2000-entry cap) and `read_debate_file` (text/json;
  400KB-text truncation + 2MB-json refusal so a result can't blow an
  assistant's context) — dependency-free by design to keep the
  one-file curl story; path resolution realpaths against the
  configured roots so `..`/symlink escapes are refused (tested).
  `--mirror … --out-dir …` (repeatable): initial mtime-skipped sweep +
  recursive fs.watch with 1.5s coalesce (Dropbox sync bursts) →
  always-current .txt shadow tree; multi-source maps into
  de-duplicated basename subfolders; orphan shadows removed
  per-source; 60s-polling fallback if the watch fails; no feedback
  loops by construction (inputs .cmir/.docx, outputs .txt). README:
  MCP client config snippet + launchd KeepAlive template. Live-tested
  end-to-end: scripted MCP session (handshake/list/read/escape
  attempts) and a real mirror run (sweep, live add, live
  orphan-removal). Motivation: the requesting user's assistant
  (Littlebird) has a no-node/no-network sandbox but reads Dropbox and
  reportedly supports MCP — both integration shapes are now covered.
  SECOND FOLLOW-UP: the assistant's custom-MCP UI turned out to take
  ONLY a server URL → added `--mcp-http [--port N]` (default 3323):
  the same dispatch behind MCP Streamable HTTP — stateless POST →
  JSON (202 for notifications, 405 for GET). Binds 127.0.0.1 ONLY
  (serves file contents; must never be LAN-reachable) and rejects
  non-localhost Origin headers (DNS-rebinding guard). Live-verified:
  handshake/read over HTTP, 403 on foreign Origin, 405 on GET,
  connection refused on the LAN address. launchd template in the
  README covers both long-running modes.

## 0.1.0-beta.26 — 2026-07-28

- **Automatic update checks flip to opt-OUT** (`settings.ts` default +
  `migrateAutoUpdateOptOut`, boot call in `index.ts`, PRIVACY.md §7 +
  third-party table, MANUAL Updates section). Motivation: the fleet
  wasn't converging — 35-40% of ~750-780 daily machines run old builds
  and generate ~90% of relay traffic, lack the structural-integrity
  fixes, and keep already-fixed bugs alive in the field. The flip is
  NOT just a DEFAULTS change: `persist()` snapshots every key, so any
  install that ever changed a setting has the old `false` baked into
  its stored blob and a default change alone reaches only fresh
  installs. `migrateAutoUpdateOptOut` runs on the desktop first-window
  boot path, flips a stored `false` exactly once (marker key OUTSIDE
  the settings blob: `cm-update-check-optout-migrated`), and shows a
  one-time toast pointing at the toggle + tournament pause. Trade-off,
  accepted: full-snapshot storage can't distinguish a deliberate
  opt-out from the inherited default, so pre-flip deliberate opt-outs
  are flipped once too — their next toggle-off then sticks forever.
  Existing safeguards unchanged: silent unless an update is ready,
  nothing installs without a click, tournament pause honored by both
  the launch and daily checks, web edition untouched. 4 migration
  tests.

- **Nav pane: empty-outline drop targets** (`renderDropIndicators` /
  `removeDropIndicators` in `nav-panel.ts`). The empty state hides
  `listEl` behind the "No headings." placeholder — but the drop
  indicators, including the always-valid end-of-doc slot, are
  appended INTO `listEl`, so an empty pane's nav had zero hittable
  drop targets (field report 2026-07-27, three-pane; the editor-
  surface drop into the empty doc worked, only the nav path was
  dead). During a drag session the panel now surfaces the
  (zero-height) list so the end slot has a real rect — the
  extreme-snap fall-through in `hitTestDropIndicators` then makes the
  entire section droppable — and `removeDropIndicators` restores the
  empty state when the outline is still headingless (a successful
  drop re-renders with headings via the normal path). Placeholder
  stays visible during the drag. 2 tests.

- **Read mode: bare editing keys swallowed at the DOM level**
  (`read-mode-plugin.ts` keydown). Follow-up to the read-mode
  alignment below: with the view editable in read mode, a bare
  keystroke let the browser mutate the DOM before the transaction
  filter rejected it — a parse-reject-redraw round trip per key, and
  the first such mutation trips PM's once-per-session checkCSS
  console warning (single-pane read mode deliberately resets
  white-space to `normal` for chunk-separator collapsing; field
  report of exactly this warning, 2026-07-27). The plugin now
  preventDefaults bare printable keys + Enter/Backspace/Delete
  (Shift allowed — shifted letters are typing) after the Space/Enter
  marker branch; chords, navigation, and F-keys pass. Restores the
  old contenteditable=false keystroke inertness without giving up
  the placeable caret. 3 tests (read-mode-keys.test.ts).

- **Focus-audit follow-through: chord guard, read-only modals, read-mode
  alignment** (the audit's two bonus CONFIRMED bugs + slim Phase 2).
  (1) The global ribbon chord handler (`index.ts` window keydown) now
  skips VIEW-dispatching commands when the keystroke targets a native
  form field (INPUT/TEXTAREA/SELECT) — previously Cmd-B while typing
  in the font-size box / tag filter applied bold to the background
  doc. The PM editor is contenteditable (not a native field), so
  editor chords are unaffected; VIEWLESS file commands (new/open/
  save-as) still fire from fields; the skip does NOT preventDefault,
  so the field keeps native behavior. (2) Word-count and
  shortcuts-reference modals converted to the shared modal wiring
  (pushOverlay + installModalKeys + armDialogFocus + focus restore) —
  both previously held no focus and had permanent unregistered
  Escape-only listeners, so typing over them fell through to the doc.
  (3) Single-pane's `editable: () => !readMode` EditorView prop
  REMOVED: it predates (2026-05-09) the read-mode plugin's
  editable+filterTransaction design (2026-06-08, which multi-pane
  follows) — contenteditable=false also made PM's view.focus() a DOM
  no-op in single-pane read mode. The filter admits only
  sync/normalizer/marker/bounded-undo/drag transactions, so edit
  blocking is unchanged. Deliberately NOT registered (by design, per
  audit): command palette, comments column, tag picker. Tests: both
  modals' register/swallow/restore in dialog-key-capture.test.ts.

- **Word-selection: doc-level click positions coerced to inline
  content — THE root cause of the "styling dead until caret-line
  click" class** (`dispatchSelection` in `word-selection-plugin.ts`).
  User-supplied console warning cracked it: "TextSelection endpoint
  not pointing into a node with inline content (doc)". PM's
  `TextSelection.create` does NOT throw on invalid endpoints — it
  `console.warn`s ONCE PER SESSION (`warnedAboutTextSelection` flag;
  why the report was so hard to correlate) and returns a broken
  selection anyway. The plugin's try/catch "fallback" was therefore
  dead code, and a click below the last line (which still hits
  view.dom padding, resolving to a doc-level position) DISPATCHED the
  broken selection into state — after which every selection-dependent
  command silently no-oped until a real text click installed a valid
  selection. Explains the entire original phenomenology: layout-
  independent, "intermittent" (depends on clicking below content),
  revived only by a caret-line click (pane-background clicks don't
  reach the plugin), and worst in fresh docs (one line, everything
  below it is the trap). Fix at the single chokepoint all ten
  click/drag/extend paths funnel through: clamp + resolve both
  endpoints and construct via `TextSelection.between`, which coerces
  to the nearest inline content — a below-content click now lands the
  caret at the end of the last line (the natural affordance).
  Regression test drives `extendActiveEndTo` to a doc-level position
  and asserts endpoint validity (verified failing pre-fix). The
  earlier focus-audit fixes remain valid and necessary — they were
  real co-existing holes — but this was the driver of the field
  reports. NOTE the reusable lesson: TextSelection.create is
  warn-not-throw; any code path feeding it posAtCoords-derived
  positions must validate/coerce first.

- **Focus-audit Phase 1: every mount path focuses; dialog hygiene**
  (driven by a 15-agent audit, 93 findings; full record in the
  gitignored FOCUS_AUDIT.md). The "new doc ignores styling until a
  text-line click" class = DOM focus never landing in the mounted
  view (PM keymaps need contenteditable focus; pane-background clicks
  fix only bookkeeping). Fixes: (1) `promptForSlot` — the ONE overlay
  dialog with no focus arming, and the prime suspect for the
  intermittent three-pane ribbon-New repro (Electron's async focus
  restoration on dialog teardown has twice before landed after a
  renderer-side .focus()) — now does captureFocusForDialog +
  armDialogFocus + synchronous restore-before-caller-focus. (2)
  Missing focus-after-mount added everywhere the audit enumerated:
  multi-pane `loadOpenedIntoSlot` (ribbon Open / drag-drop),
  `onRecoveredDoc` (crash recovery AND every mode-switch reload —
  likely the biggest real-world hole), `createSessionDocIntoSlot`;
  single-pane home New/Open tiles (focus AFTER homeScreen.hide() —
  home hides the editor tree via ancestor CSS, so an earlier focus()
  silently no-ops), `loadFileInPlace` tail (covers Cmd-O/recents/
  drag-drop), `mountFromSpawnPayload`, `replaceWithSessionDoc`. All
  multi-pane focuses carry the hidden-pane guard (focus follows
  visibility). (3) `showConfirm` (confirm-dialog.ts — the primitive
  the modal-key sweep missed; audit CONFIRMED it leaked non-Enter/
  Escape keys during its pre-focus window and never registered on the
  overlay stack) → installModalKeys + pushOverlay + focus restore.
  (4) `SaveAsModal` → overlay registration + installModalKeys +
  focus capture/restore (previously Escape-only bare listener, never
  restored focus). (5) Ribbon Open/New buttons preventDefault their
  mousedown (toolbar convention, matching homeBtn) so a dropped
  async step can't leave the keyboard on the button. The audit also
  killed the proposed global focus reconciler as designed (overlay
  stack unreliable as a guard; body-focus predicate wrong in both
  directions; PM focus() no-ops when uneditable) — Phase 2 (overlay
  registration sweep) and the revised reconciler remain contingent on
  field feedback. Tests: showConfirm overlay/swallow/restore trio in
  dialog-key-capture.test.ts.

- **Three-pane: focused highlight is derived, not transferred**
  (`focusSlot` + `handleSlotEmptied` in `multi-pane-shell.ts`).
  Pre-existing stale-class leak, unmasked by the focus-follows-
  visibility guard: `handleSlotEmptied` nulls `focusedSlot` before
  transferring, so focusSlot's remove-from-previous branch skipped
  and the EMPTIED pane kept `pmd-pane-focused` — invisible while the
  pane sat empty+hidden, but the next doc pushed into that slot
  showed BOTH panes focused (field repro: expand, create doc behind,
  un-expand; clicking the true-focused pane could never clear it
  since bookkeeping already pointed there, only focusing the stale
  pane and leaving healed it). The old code masked the leak by
  accident: hidden slots could seize focus during creation and
  re-normalize the class. Fix: focusSlot stamps the class across ALL
  panes every time (`classList.toggle(..., s === slot)`), and
  handleSlotEmptied explicitly clears the emptied pane's class for
  the no-successor / hidden-successor branches. No shell unit
  harness exists (recorded gap) — verified manually.

- **Three-pane focus follows visibility** (`focusSlot` guard +
  `createNewDoc`/`createNewSpeechDocument` in `multi-pane-shell.ts`).
  Investigating the intermittent "new doc ignores styling until I
  click the caret line" report surfaced a confirmed split-routing
  hole: `Slot.push` unconditionally transferred `focusedSlot` +
  activeView to the receiving slot, and in expand mode the receiving
  pane can be `hidden` — so ribbon/command routing pointed at an
  invisible doc while DOM focus (which a hidden subtree silently
  refuses) stayed with the visible one. Chords (view keymaps, need
  DOM focus) and commands (active view) then disagree, reading as
  "styling does nothing"; clicking any text line re-syncs both, but
  clicking pane background fixes only the bookkeeping — exactly the
  reported asymmetry. Per the user's design call, the invariant is
  now FOCUS FOLLOWS VISIBILITY: `focusSlot` early-returns for a
  hidden pane (the expanded pane is what you're looking at; it keeps
  the keyboard), and the two creation paths skip their DOM `focus()`
  into hidden panes. NOTE: the user's own repro was NOT in expand
  mode, so at least one more focus-dropper is at large in the
  three-pane ribbon-New path; the single-pane home-tile new/open
  paths also never focus after mount (`mountView` has no focus call)
  — both are candidates for the proposed focus-follows-active-doc
  reconciler, not yet built. No automated test: the multi-pane shell
  has no unit harness (its constructor needs live app scaffolding) —
  standing one up is its own task.

- **CSS content glyphs escaped repo-wide (mojibake-proofing)**
  (`style.css` ×5, `icons.css` ×85 via `gen-icons.mjs` `cssGlyph`,
  guard test in `icon-coverage.test.ts`). Field report: the 🎤 pane
  chip showed "ðŸŽ¤" and the numbering flow-in arrows garbled in a
  three-pane dev session; a reload fixed both. Mechanism (reproduced
  with a headless-Chrome probe against the live dev server): vite
  serves CSS as `text/css` with NO charset and the files carry no
  BOM/`@charset`, so the browser decodes the stylesheet per the
  REFERENCING document's encoding — with a charset-bearing document
  the probe computes `\1F3A4`, without one it computes exactly
  `f0,178,17d,a4` (windows-1252 mojibake). The steady-state document
  declares UTF-8, so the field hit was a transient context slip
  during a mode-switch reload; rather than chase the race, every
  non-ASCII `content:` value is now a hex escape (`\1F3A4 ` — the
  trailing space is the parser-consumed terminator), which is pure
  ASCII and immune to ANY decode context (dev, prod, file://).
  Escaping is emitted by the icon generator (regen verified: 85
  classic-glyph lines changed, 0 mask lines) and enforced by a test
  scanning both stylesheets for non-ASCII content values. The
  charset-less probe now renders the correct glyph end-to-end.

- **Tilde send: blank-line fill narrowed to legal placeholders**
  (`insertSpeechSlice` in `src/editor/speech-doc-send.ts`). Field
  report: sending a card added "2 empty tag headers" after it; second
  report: the phantom tags carried numbering. Mechanism (reproduced in
  a harness): the fill branch — designed in 0f48fce to consume the
  doc-level trailer/seed placeholder so consecutive sends stack
  cleanly — accepted ANY empty textblock, including a blank
  `card_body` inside a card or an empty `tag`. `replaceRange` then
  split the host card (each half's schema-mandated leading `tag`
  synthesized empty = phantom #1), and the trailer-paragraph insert at
  the mapped end position split the tail half AGAIN (= phantom #2);
  the split halves copy the host's attrs, so in speech docs built from
  numbered sends the phantoms rendered numbered (the attrs come from
  the card the caret sat in, not the sent card — verified both
  directions). The two earlier hardening passes (bf14404, e0b12c5)
  snapped the neighboring branches but left the fill first-in-chain
  and unguarded. Fix: the fill now additionally requires
  `parent.canReplace(index, index+1, content)` — i.e. the incoming
  content may legally stand where the blank line stands — else it
  falls through to the same `nearestValidInsertPos` snap as every
  other caret shape. The zone-flatten rewrite now happens BEFORE
  placement so the check and the snap judge the content that actually
  lands. Regression matrix extended with both caret shapes + a
  numbering-variant test (verified failing pre-fix, 2 tests).

- **Web GitHub button: octocat restored + icon-coverage guard**
  (`style.css`, `tests/editor/icon-coverage.test.ts`). The button's
  `.pmd-icon-github` rule was hand-added to the GENERATED `icons.css`
  (692a11b); the next `gen-icons.mjs` regeneration (c52d9ee, shipped
  beta.22) silently dropped it. An icon class with no `--pmd-icon`
  doesn't render blank — the mask property fails and the box paints
  solid `currentColor`, hence the black square. The rule now lives in
  hand-maintained `style.css` beside the web-button styles, and a new
  test scans every literal `pmd-icon-<name>` reference (index.html +
  src TS — the raw-HTML gap the typed `icon()` helper can't cover)
  against the union of mask definitions, so a regen can never silently
  orphan an icon class again. Sweep found no other orphans.

## 0.1.0-beta.25 — 2026-07-27

- **Salvage-mode open for damaged files** (`src/schema/salvage.ts`,
  `parseNativeSalvage` + `NativeDamagedError` in `src/native/index.ts`,
  `offerDamagedSalvage` in the editor). When a `.cmir` fails `check()`
  even after the heal chain, the refusal now carries a typed error and
  the open paths (single-doc AND three-pane, file picker / drag /
  recents) offer a repaired copy. The salvage walk is bottom-up and
  deterministic: children first, then a greedy content-match refit
  that (1) keeps every child the expression accepts, (2) GENERATES
  missing required content via `fillBefore` — both before a misplaced
  child (a body where a head belongs keeps the body behind a generated
  empty head) and at the end (a hollow cell gains its paragraph) —
  and (3) drops only what can't fit even with filling, recording each
  loss with a type + 80-char text preview; a whole-node drop subsumes
  its inner entries. The result is re-`check()`ed; anything still
  invalid keeps the plain refusal. Consent-first UI quotes the
  concrete losses; the copy mounts with NO file handle (first save
  forces Save As, so the damaged original stays byte-intact for
  forensics) under a "(repaired)" name, marked dirty; the drop report
  joins the `cm-save-heal-log` diagnostics ring buffer.

- **Structural-integrity hardening batch** (audit tier 4, four items).
  (1) The AI edit-coordinator's lease `apply`/`release` catches are
  scoped to actual view teardown (`view.isDestroyed`) — swallowing
  every dispatch error let repair flows count failed edits as applied
  and toast success for work that never landed; real failures now
  rethrow to the caller and the global error surface. (2) The
  paste-then-condense catches route through the (new) `surfaceError`
  export instead of a silent `console.warn`, so a condense bug is
  visible in the field while the committed paste is kept. (3) Fragile-
  by-convention constructions verified: the AI table builder uses
  `createChecked` (model-derived JSON spliced as closed content — a
  future schema tightening now throws at build instead of inserting
  invalid), and export's `filterChildren` verifies the filtered
  content and falls back to the unfiltered node rather than ever
  exporting an invalid container. (4) The docx import pipeline gained
  the `doc.check()` enforcement net the `.cmir` path has — the
  importer's head-first convention was the only thing between a future
  regression and silently-corrupt imports; an invalid import now fails
  loudly with a report-this message. Passes against every existing
  import fixture (i.e. it never fires today).

- **Save-time structural tripwire** (`src/native/index.ts`,
  audit tier 1). `doc.check()` had exactly one call site — .cmir load
  — so an invalid live doc reached the journal in ~1–2s and the file
  at the next autosave: the persistence mechanism behind both
  hollow-shell field incidents. `buildNativeEnvelope` (the choke point
  under every save: manual, autosave, journal, both window modes) now
  checks the doc; on failure it runs the same known-shape heals as the
  load path and saves the HEALED doc, reporting through an injectable
  listener (the module stays UI-free for node tooling) — the renderer
  listener toasts (rate-limited), console.errors, and appends to a
  durable localStorage ring buffer (`cm-save-heal-log`, capped 20), so
  the still-unidentified producer gets caught red-handed at its first
  save. An unhealable doc saves UNCHANGED: a save is never refused
  (the journal is the crash lifeline), the original bytes preserve the
  forensic shape, and load treats them exactly as before.

- **Validated slice reconstruction** (`src/schema/slice-check.ts`,
  audit tier 2). `Slice.fromJSON` validates nothing and the step
  machinery validates only the splice frontier, so the seven surfaces
  that rebuild stored slice JSON — quick cards (insert + manage
  preview), dropzone (×2), pairing inbox + Receive pill, speech-doc
  send — could re-inject a corrupted payload into live docs forever,
  cross-machine via pairing. `checkedSliceFromJSON` gives CLOSED nodes
  a full recursive `node.check()` while nodes on the open left/right
  spines stay exempt (a mid-card copy legitimately arrives headless-
  open; the Fitter closes those on insertion — the guard mirrors the
  threat model exactly). All seven sites route through it, feeding
  their existing bad-payload handling; the manage-UI preview degrades
  to a placeholder doc; quick-cards bulk import filters invalid
  records via `sliceJsonIsValid` and reports the skip count.

- **CRDT merge heal: hollow containers materialize repaired instead of
  vanishing** (loro-prosemirror patch + `src/doc-repair.ts` +
  `src/editor/collab/collab-repair.ts`). Element-wise CRDT merges can
  hollow a container's children list (a card that lost its tag element
  but kept bodies) — a schema-invalid state no peer ever saw. The
  bridge's materializer builds nodes with the checked constructor; its
  catch used to drop the whole node (`console.error` → null → parent
  filter), silently deleting surviving content on every peer, forever
  (the invalid container stayed in the CRDT, re-dropping on every
  join). Two-layer fix mirroring the §4.3 leader pattern:
  (1) *display layer, all peers* — the patched materializer heals a
  headless card/analytic_unit by synthesizing a head whose id derives
  from the stable Loro container id (`crdt-heal-<cid>`), so every peer
  heals byte-identically with no cross-peer writes (empty shells stay
  dropped: the union of deletes reads as "gone"; hollow table cells
  refill with an empty paragraph);
  (2) *write-back, leader only* — `buildDocRepairTr` canonicalizes
  sentinel-prefixed head ids (deterministic rewrite to `ch-<cid>`),
  giving the repair transaction a step on the healed node so the sync
  diff writes the head into the CRDT as an ordinary edit; followers
  and fresh joiners then materialize cleanly with no heal at all.
  Never all-peer write-back: concurrent compensating inserts would
  merge into duplicate heads and ping-pong. The one residual conflict
  window — degraded leader election (presence empty → everyone leads)
  letting several peers write their blank head back concurrently,
  merging to `[tag, tag, …]` — is closed by the same heal: a
  duplicate mid-tail head normalizes deterministically (an empty one
  is dropped, one carrying text demotes to a body), so even that
  corner converges to the single-blank-head endpoint instead of a
  drop. A rate-limited toast surfaces the repair (the silent version
  is how the data loss went unnoticed). Locked by `tests/collab/hollow-merge.test.ts` — written
  red-first against the old drop behavior: headless-with-content
  heals + converges, fully-empty converges to gone, and a fresh
  joiner from the leader's state gets a canonical (non-sentinel)
  head, proving the CRDT itself was repaired.

- **healCards + healTables** (`src/schema/migrate.ts`, wired into the
  `parseNative` heal chain after `healAnalyticUnits`). Field report: a
  working doc saved mid-session carried an EMPTY `card` (`<>`), which
  the beta.21 reject-invalid check refuses ("Invalid content for node
  card"). Cards get the exact `healAnalyticUnits` treatment — empty
  shell dropped, headless children floated to the parent (all card
  content types are legal at the doc root and in zones), a mid-tail
  tag re-heads its own card — with zones walked one level deep. A
  schema audit then closed out the whole empty-shell family: the only
  other nodes with required content are `table` (`table_row+`) and
  `table_cell`/`table_header` (`paragraph+`); an empty table drops
  losslessly (every possible parent has a `*` tail), and an empty cell
  is refilled with one empty paragraph instead of dropped, since
  removal would shift the row's column count. The reject-invalid
  test's example (a tagless card) moved to a shape no heal covers, so
  `check()` provably still guards everything outside the known-legacy
  set. OPEN QUESTION: the file was saved by a LIVE session, meaning
  some editing path can still hollow a card without removing the
  shell (the unit variant in the beta.22 report was likewise never
  root-caused) — the heal recovers the files, but the producer is
  still at large.

- **Search-bar first-keystroke latency batch** (`quick-card-search-ui.ts`,
  `file-search.ts`, `idle-scheduler.ts`). Root-caused the "first few
  characters freeze with a large corpus" report to four stacked costs,
  each fixed:
  (1) The warm pass parses pinned/recent files with a synchronous
  `parseNative`/`fromDocx` on the renderer main thread, "yielding to
  idle" via `requestIdleCallback({timeout: 500})` — but during a typing
  burst there are no idle frames, so the 500ms cap FORCED each parse
  into the burst (this also explains the user's "wait a bit and it
  gets faster": the queue drains). Now `waitForParseWindow()`: rIC
  with NO timeout cap (`scheduleIdle(…, Infinity)`) AND ≥600ms since
  the last document-level keydown, so a monolithic parse can never be
  scheduled into active typing (a 200ms inter-word gap presents idle
  frames; the keydown clock is the difference).
  (2) The file list was requested on the first everything-search
  keystroke, so its arrival re-ran search+render mid-typing; `open()`
  now kicks `ensureFileList()` immediately (main serves it from the
  disk-backed index in ms).
  (3) Per-keystroke ranking lowercased every file's name + folder (2
  allocs × corpus × keystroke) and materialized a PaletteResult per
  match. `FileEntry` now carries `nameLower`/`dirLower` built once in
  `makeFileEntry`; `matchTier` takes pre-lowered fields (per-field
  `includes` replaces the joined-haystack alloc — equivalent since
  tokens are whitespace-free); file matches stay as a lazy `fileTail`
  and materialize only for the rendered window (memoized across "show
  more"). The manual-pins localStorage read is also memoized per
  palette session.
  (4) `RESULT_PAGE_SIZE` 100 → 50.
  Deliberately NOT done: skip-identical-render signature (stale-row
  risk for pin stars/snippets outweighed the rare redundant render) and
  the parse worker (parked — both parse paths are DOM-free so it's
  viable; becomes the foundation for full-corpus content search if the
  batch proves insufficient). Tests: paging/laziness over a 120-file
  corpus driving the real singleton with a mocked Electron host
  (`quick-card-search-paging.test.ts`), `makeFileEntry` + mixed-case
  matching regressions; jsdom setup gains an `Element.scrollIntoView`
  no-op (same layout-free class as the getClientRects stubs).

- **Modal keys stop leaking into the editor** (`installModalKeys` +
  `armDialogFocus` in `src/editor/text-prompt.ts`). Field bug: Enter
  confirming the three-pane mode-switch dialog ALSO split-blocked at
  the cursor. Mechanism (verified against prosemirror-view): the five
  text-prompt primitives listened on `document` in BUBBLE phase
  without moving focus, so a keydown reached ProseMirror's handler on
  `view.dom` first and the transaction was already dispatched — Enter
  and Backspace dispatch synchronously inside keydown, while digits
  are deferred default actions, which is why the beta.24 slot-picker
  fix held for numbers while Enter kept leaking. Fix: a shared
  capture-phase document listener, gated on `isTopOverlay`; handled
  keys get preventDefault + stopPropagation (PM's `eventBelongsToView`
  skips any default-prevented event), and every unhandled key not
  aimed at the dialog's own controls is swallowed — a modal can never
  let typing through. Dialogs also focus their container on open (not
  a button, which would native-activate on Enter and double-fire) with
  `role`/`aria-modal`/`aria-label`, restoring focus on close.
  Converted: all five primitives plus the three hand-rolled dialogs
  (`confirmCloseUnsaved`, `confirmNewDocOverwrite`, the three-pane
  slot picker); `promptForRouteChoice` now actually implements its
  documented Enter-confirms-first-choice. Follow-up sweep over the
  remaining Escape-only surfaces: the Settings dialog and the
  speech-doc picker were the same bug class (true modals listening
  only for Escape, never moving focus — opened from the command bar,
  typing fell through to the document behind the overlay) and now use
  `installModalKeys` + `armDialogFocus` with focus restore; the three
  non-modal surfaces (footnote popover, Doc menu, recovery sidebar)
  keep letting typing through by design but now consume the Escape
  they handle (pd + sp, Doc menu moved to capture) and stand down via
  `isAnyOverlayOpen()` when a modal is stacked above — so one press
  closes exactly one thing, top-most first. The deliberately-untouched
  tier (context menus, font-size picker, anchored dropdowns) dismisses
  on any interaction by design; swallowing keys there would change
  correct behavior. Regression tests in
  `tests/editor/dialog-key-capture.test.ts` drive a live EditorView
  with `baseKeymap`; `tests/_setup-jsdom.ts` (wired via vitest
  `setupFiles`) polyfills `Range.getClientRects`, which jsdom lacks —
  without it, any test moving focus with a live view throws inside
  PM's selection-reconcile listener and fails the run with every
  assertion passing.

## 0.1.0-beta.24 — 2026-07-26

- **Modal dialogs join the shared overlay stack**
  (`src/editor/text-prompt.ts`, the multi-pane slot picker, and the
  remaining one-off modals). Background key handlers — the home
  screen's 1-9 shortcuts and its Escape — stand down while a modal is
  up by checking `isAnyOverlayOpen()`, but the shared dialog
  primitives (`promptForText`/`Choice`/`RouteChoice`, `alertDialog`,
  `confirmDialog`) and several hand-rolled modals never registered on
  the stack. Any number-key dialog over the home screen double-fired:
  the three-pane "Open into…" picker's 1/2/3 chose a slot AND ran the
  matching home action; the close-unsaved dialog's 1/2/3 had the same
  leak. Every modal now pushes a token for its lifetime and guards its
  key handler with `isTopOverlay`, which also fixes two adjacent
  defects: stacked dialogs collapsing together on one Escape, and
  capture-phase modals swallowing a stacked dialog's keys before it
  saw them. Non-modal floating panels deliberately stay OFF the stack
  — editing continues while they're open, so parking them there would
  wrongly disable background shortcuts.

- **Nav pane: Cut heading and contents** (`src/editor/nav-panel.ts`).
  Sits between Select and Copy (standard cut/copy order). Cut is
  copy-then-delete with the delete gated twice: it runs only after
  the async clipboard write succeeds (a busy clipboard must never
  destroy content), and only if no transaction landed during the
  write — a collab peer's edit or typing during a clipboard retry
  would shift the captured range, so a stale doc aborts the delete
  with a toast instead of removing the wrong span. That second gate
  also covers the nav reattaching to a different pane's view
  mid-write. Serialization is shared with Copy via a
  `rangeClipboardPayload` helper.

- **Live enclosing-container read time**
  (`src/editor/live-read-time.ts`; setting `liveContainerReadTime`,
  default on, General → Word counts). One shared module drives both
  the single-pane status bar and the three-pane pane footers. The
  container ladder: nearest wrapping `card` or `analytic_unit` wins;
  otherwise the block SECTION is resolved positionally (block heading
  through the next equal-or-shallower heading via
  `sectionEndFromHeading` — blocks aren't containers in the schema).
  Pocket/hat headings and loose doc-level content stay silent by
  design. With a selection the segment shows the selection's time
  instead, and is dropped when `liveSelectionWordCount` already makes
  the selection the primary readout. The whole-doc side reads "Doc:"
  while the feature is on, so the two sides are symmetric; off
  restores the exact pre-feature bare-number readout. Cursor moves
  now refresh the readout when enabled; cost is held down by caching
  the container count on (doc identity, range) — within-container
  moves are an ancestor walk — and the pane footers gained the
  whole-doc count cache the single-pane bar already had. Upgraded
  installs get the feature via the default-on sanitize pattern.

- **Paint mode: Alt/Option strip-pen override**
  (`src/editor/color-panel.ts`). While a colored paintbrush is armed,
  a stroke released with Alt held paints "no color" — the same strip
  the null pen does, run through `applyAndCollapseSelection` so it
  keeps the single-undo-step and brush-lift collapse. The apply
  decision reads `e.altKey` off the mouseup event itself; the
  keydown/keyup listeners only keep the cursor truthful (red-slash
  none glyph, matching the pickers' none swatch, while Alt is down),
  so a missed keyup can never make the wrong pen fire. Window blur
  clears the override — Cmd-Tabbing away with Alt down eats the keyup
  and would otherwise leave a stuck strip-pen. A pen already set to
  "none" ignores Alt. Persisted pen colors are never touched.

- **Paint-mode visuals follow pane focus** (`src/editor/color-panel.ts`
  + `setActiveView`). The brush already followed focus — the mouseup
  handler resolves the view at stroke time — but the armed
  cursor/class are DOM state on a specific editor element, synced only
  on arm/disarm/settings/Alt transitions and cleared only from the
  CURRENTLY focused view. In multi-pane that left the old pane showing
  a live-looking brush while the pane the brush actually applied to
  showed none, and disarming from another pane left the armed pane's
  brush cursor stuck permanently. `syncPaintbrushUI` now remembers
  which element carries the visuals and always clears THAT element
  before re-applying to the current view; `setActiveView` triggers a
  resync on real focus changes (no-op when nothing is armed). Apply
  behavior is untouched.

## 0.1.0-beta.23 — 2026-07-25

- **External-app consent gate** (`apps/desktop/src/external-consent.ts`
  + `src/editor/external-consent-ui.ts`). Every bridge route except
  `/ping` now requires an `X-App-Id` header and is governed by a
  per-app consent decision; first contact raises a route-style prompt
  (Always Allow / Allow Once / Deny, Esc asks again later) naming the
  app from its bridge identity file, while requests queue behind the
  prompt (cap 10) answering `pending: "consent"` — Allow applies the
  queue, so the user's click is the redo. Enforcement lives in MAIN
  (one authority, multi-window-consistent); settings own persistence
  (the renderer mirrors the policy + decisions over
  `host:sync-external-consent`). The policy is three-state: `ask`
  (default), `open` (identification optional — keeps pre-identity
  senders working for users who opt in), `off`. Unidentified callers
  under `ask` are rejected with guidance in the response AND explained
  by CardMirror itself — a dialog where the consent prompt would have
  appeared, rate-limited toasts after — with no fingerprinting of
  which legacy app knocked (guessing would put one app's name on
  another's traffic). Jump is gated by the same decision as insert —
  a denied app can't seize focus either. This is consent/legibility
  UX for cooperating local apps, not a security boundary: identity is
  self-declared, and any same-user process is inside the trust line
  regardless. Full wire contract in the plugin-API spec §5.

- **Doc-targeted inserts** (`GET /docs` + `target` on `/insert`).
  Three-pane mode puts several docs in one window, so window-level
  focus addressing can't name a specific doc. `/docs` lists every
  open doc across windows/panes (session-scoped target token, title,
  `focusedWindow`, `isSpeech`) straight from the directory main
  already maintains for the Select-Speech-Doc picker; a targeted
  insert routes to the owning window and lands in the addressed pane
  via the speech-doc registry — three-pane aware, focused or not,
  never stealing focus. A vanished doc answers `target-not-found`,
  never a fallback to a doc the caller didn't name. The legacy
  no-target path is unchanged: focused window's active pane, else the
  most recently focused window — the else-branch is new and matters,
  because a flow app sends while IT holds focus (the old any-window
  fallback could mistarget with several windows open).

- **Styled inserts** (PR #28 by Shreeram Modi). `/insert`'s `role`
  now carries the five outline levels plus body/cite/inline: one
  heading per line, each with a fresh minted id, wrapped in its
  schema container (tag → card, analytic → analytic_unit), placed at
  the nearest outline slot a drag would use (`nearestValidInsertPos`)
  so a mid-card cursor can never split the card. Older CardMirrors
  degrade unknown roles to `card` silently.

- **Heal hollow analytic_units at load** (`schema/migrate.ts`). Files
  written by some older builds carry an `analytic_unit` with no
  children (a delete/drag path hollowed the unit without removing the
  shell); `nodeFromJSON` accepted these silently for years until
  beta.21's reject-invalid check refused the whole file ("Invalid
  content for node analytic_unit: <>", field report beta.17 →
  beta.22). Now a known-legacy shape, healed losslessly by one
  normalize loop: empty unit dropped, headless children floated to
  the parent level, a mid-tail analytic re-headed into its own unit
  (same absorb rule as the card-split migration). Unknown invalid
  shapes still fail cleanly.

- **Gap-caret Backspace/Delete** (`boundary-cursor-keymap.ts`). A
  click in the blank spacing between paragraphs parks the caret at a
  non-textblock GAP position, visually indistinguishable from the
  start of the next line. The gap handler (built for clicks past the
  LAST card) either deleted the previous block's last character or
  dispatched a caret-move-only first press. A between-blocks gap now
  joins the two sides when the schema allows — `canJoin` refusing
  preserves the card/tag structural protections — and normalizes the
  caret otherwise; the edge-of-doc behavior is kept.

- **Cite-creator token matching** (`ai/cite-creator.ts`). `cite_mark`
  was applied to the model's [[TOKENS]] by exact substring search in
  its own [[CITE]] text; drift between the two sections (case, curly
  quotes, dashes, edge punctuation) silently marked nothing — so the
  classifier never promoted the paragraph to `cite_paragraph` and
  shrink treated the cite as body text. Matching now folds both sides
  1:1 per character with an edge-punctuation-trim retry. Deliberately
  NO fallback: a paragraph must never be a cite while it contains no
  cite mark, so a genuinely absent token leaves body text — loudly,
  via a toast telling the user to F8 the author/date.

## 0.1.0-beta.22 — 2026-07-24

- **Plugin-declared settings** (`plugin-registry.ts`,
  `plugin-settings.ts`, `plugin-settings-modal.ts`). A definition's
  optional `settings` array declares typed settings
  (boolean/text/number/select) validated at registration with the same
  read-once snapshot discipline as commands — one off-shape entry
  rejects the whole registration, so the modal renders only shapes it
  can trust. Values live inside the existing `plugin:<id>` storage bag
  under a reserved `__settings` key, which makes uninstall purge and
  boot reconciliation cover them with zero new bookkeeping; plugins
  read via `api.settings.get` (a type-corrupted stored value degrades
  to the declared default) and can subscribe with
  `api.settings.onChanged`. The gear renders only for
  enabled-and-registered plugins — a disabled plugin's bundle never
  ran, so its declared settings are unknowable. The modal rides the
  shared overlay stack, so Escape closes it alone rather than
  collapsing the settings dialog under it. Additive and optional:
  still `apiVersion: 1`.

- **Custom ribbon buttons: cap 10, 54 icons, plugin commands,
  reorder.** The panel already filled column-major with two fixed
  rows, so columns 4–5 are implicit grid tracks — the cap change is
  data-level (`MAX_RIBBON_CUSTOM_BUTTONS`). Thirty new Untitled UI
  glyphs join the curated picker via `scripts/gen-icons.mjs`, each
  with a classic-mode fallback. Plugin commands are offered in the
  command picker and resolve labels through `commandLabelFor`;
  `primaryKeyFor` now falls back to `pluginDefaultKey` so their
  tooltips show live shortcuts; and the plugin registration hook
  re-renders the panel, so a button bound to a plugin command
  materializes when its plugin loads (async after boot) and vanishes
  at uninstall. Uninstall and boot reconciliation unconfigure buttons
  by the same dot-prefix rule as key overrides, keyed strictly on
  install-directory absence — a plugin that merely failed to load
  keeps its buttons configured, hidden until it registers again.
  Row reordering reuses the pairing rows' arrow pair (now the shared
  `makeReorderButtons`); row order is what the ribbon renders.

- **Verbatim Flow keep-warm relocated to the Plugins tab, ungated**
  (`settings.ts`, `settings-ui.ts`). The toggle is plugin-shaped — a
  bundled Verbatim integration — so it now sits under its own heading
  at the bottom of Settings → Plugins, below the plugin manager.
  Deliberately not behind Enable plugins: it renders as a plain
  settings row even while the manager shows only the gate placeholder.
  Still windowsOnly, which already implies the desktop host, so
  nothing reachable moved out of reach.

## 0.1.0-beta.21 — 2026-07-24

- **Plugin API v1 + cardmirror-bridge** (PR #25 by Shreeram Modi,
  author of the [ebb](https://github.com/shreerammodi/ebb) flowing
  app; merged with the agreed modification set; ~4k LOC. Spec:
  `reference-docs/cardmirror-plugin-api.md` — bridge sections frozen,
  plugin-API sections draft). Plugins are one-GitHub-repo packages
  (manifest + bundle release assets) loaded into the renderer main
  world — FULL-TRUST, which drives the guardrails: installs gate on a
  curated allowlist enforced in MAIN and served by the relay
  (`/plugin-allowlist`, cached, baked floor; self-hosted relays serve
  their own via RELAY_PLUGIN_ALLOWLIST; community installs behind
  `__plugins('community-on')`); install is two-phase (stage in memory →
  consent naming the actual owner/repo → commit; declining a reinstall
  deletes nothing); registration enforces `<pluginId>.`-namespaced
  command ids and rebuilds live keymaps both on load and on the new
  immediate deregistration at uninstall, which also purges the
  plugin's key overrides — with boot reconciliation pruning leftovers
  keyed strictly on install-directory absence. The bridge: a shared
  handshake directory with per-app PERSISTENT identity files +
  session-scoped port/token files (0700/0600), so closed apps stay
  selectable and sends fail at runtime (`app-not-running`), with a
  pid-liveness probe before every send (a dead writer proves a stale
  file; cheaper than a ping and catches what a ping can't). Hardening
  that rode along: `parseNative` runs `doc.check()` after the heal
  passes (reject-invalid on the OS-file-association attack path), and
  `read-file-at-path` is scoped to a main-side grant registry (library
  roots + dialog/OS/drop grants + persisted journal + one-shot recents
  import).

- **Relay egress ×5-6 reduction** (2026-07-24 audit: 12-15 GB/day,
  ~65% of it `auditRoomHistory` re-downloading entire rooms every 30
  min). Client: the audit folds version-vector maxima from bytes
  already in flight and verifies compaction epochs at most once each
  (`snapCovers` tag), escalating to the ground-truth full scan only on
  suspected loss — P14 semantics preserved; cursor presence throttled
  120→250ms with identical-frame dedupe; stream `?sid`/presence
  `?from` stop sender echo. Server (official + self-hosted, contract
  suite 42→47): negotiated gzip on blob-heavy JSON, conditional
  snapshots (`haveSnap`), presence no-echo.

- **`minimizeWindow` command (all platforms) + macOS Window menu**
  (`ribbon-commands.ts`, main.ts). The custom app menu never carried
  the standard Window menu, so Cmd+M (which exists only as its
  Minimize accelerator) did nothing. Minimize is a first-class
  rebindable command (default Mod-m, desktop-only) routed through the
  renderer-driven menuBindings rebuild, so the menu accelerator
  follows rebinds live; Bring All to Front ships as the native role
  with no accelerator; Zoom deliberately omitted (collides with the
  app's text-zoom commands).

## 0.1.0-beta.20 — 2026-07-24

- **Live-view read-only filter: per-step coordinate spaces**
  (`src/editor/self-transclusion-plugin.ts` `editsInsideView`; field
  report: intermittent dead drops near live views + a broken undo
  chain after dragging one). The filter resolved EVERY step of a
  transaction against the pre-transaction doc, but steps after the
  first are expressed in intermediate coordinates. A drag's
  delete-then-insert whose delete sat above a live view shifted the
  insert position down; read against the wrong doc it landed
  numerically inside the view's OLD span, and the whole transaction
  was silently rejected. Same mechanism killed undo after moving a
  view by less than its own size — and a filtered undo never pops the
  history item, so undo stayed dead until the next fresh action. The
  filter now checks each step against `tr.docs[i]`, the doc that step
  actually applies to. Both symptoms pinned by tests.

- **Drag move/copy: duplicate-range dedup**
  (`src/editor/drag-controller.ts` `buildMoveTransaction` /
  `buildCopyTransaction`). A nav multi-select of several headings
  inside the SAME live zone promotes each to the identical whole-zone
  range (`zoneRangeForEntry`); the move path deleted that range once
  per duplicate, eating whatever content slid into the range after
  the first cut. Items sharing an identical `[from,to]` now collapse
  to one before any mutation.

- **Whole-zone drag detection is order-independent**
  (`src/editor/drag-editor-surface.ts`, `src/editor/nav-panel.ts`).
  Both drop-indicator surfaces decided "is this a whole-zone drag"
  from `session.items[0]` alone, so a mixed multi-select scoped its
  slots differently depending on which item sat first in document
  order. Both now treat a drag as doc-level if ANY dragged item is a
  transclusion unit. (Also from the same audit: the stale `zonePos`
  comment describing the pre-`cd30df3` drag regime was rewritten to
  state the actual design.)

## 0.1.0-beta.19 — 2026-07-24

- **Enter below a live view**
  (`src/editor/self-transclusion-commands.ts` `enterBelowSelfRef`,
  bound FIRST in the Enter chain in `buildEditorPlugins`). With the
  caret at the bottom of a `self_ref` mirror, Enter was dead: the
  mirror is read-only, so the split it would produce was rejected by
  the content plugin's `filterTransaction` — and the styled-Enter /
  tag-end handlers claimed the key first and died the same way
  (handled-but-filtered). The new command detects the bottom edge
  structurally (caret at its textblock's end, every wrapper up to the
  window a last child), inserts a fresh paragraph after the window,
  and puts the caret in it; anywhere else in the mirror the key stays
  a deliberate no-op, and outside live views it never triggers. One
  shared keymap assembly serves both single- and three-pane.

- **Live-view rows carry nav-pane numbers** (`src/editor/nav-panel.ts`
  `collectOutlineWithWindows` + `render`,
  `HeadingEntry.windowCardPos`). `computeNumbering` files a live
  view's labels under the REAL doc positions of the window's mirrored
  children, but the nav's projected (windowed) rows were skipped by
  the glyph pass entirely — numbers appeared in the editor and not
  the outline. The projection walk now records each card-heading
  row's real wrapper position (`windowCardPos`) and the glyph pass
  resolves windowed rows through it, so outline numbers match the
  editor's, including host-continued counts.

- **Cross-pane drop vs nav depth: ordering**
  (`src/editor/multi-pane-shell.ts` drag-'end' handler). The
  drop-aware collapse (`applyMaxLevelToNewHeadings`) diffs the doc's
  heading ids against the ids seen at the nav's LAST RENDER — but the
  handler ran `flushHeavyUpdateNow` first, whose nav update re-renders
  and refreshes that baseline, so the dropped ids looked already-seen
  and the collapse silently no-opped (drops landed fully expanded,
  ignoring the pane's depth setting). The collapse now runs before
  the flush; the ordering constraint is documented at both ends and
  pinned by tests, including the hazard itself (an intervening render
  eats the diff).

- **Find bar: close on focus switch; cleanup targets the opened pane**
  (`src/editor/index.ts` `setActiveView`,
  `src/editor/find-replace-ui.ts`). The bar resolves "the view"
  lazily so it follows the focused pane — which meant that after a
  pane switch, closing it cleared the NEW pane's (empty) find state
  while the outgoing pane's match decorations and nav-pane hit
  markers stayed stuck. `setActiveView` now closes an open bar on any
  real view-identity change (pane switch, stack switch, home screen —
  not the per-transaction re-run with the same view), and the bar
  captures the view + nav panel it OPENED against and cleans those on
  close — skipping the editor refocus on this path (focus is already
  moving) and skipping a destroyed opened view outright (its
  decorations died with it).

## 0.1.0-beta.18 — 2026-07-23

- **Atomic-save in-place fallback** (`apps/desktop/src/doc-writes.ts`
  `writeAtomic`; field report: Windows + Dropbox, ELOCKED on nearly
  every save). The beta.16 atomic write (tmp + rename) assumed
  sub-second sharing-violation holds; a Dropbox upload of a large doc
  holds the target for many seconds, and Windows refuses to rename over
  a file whose holders lack delete-sharing — so the ~1.5s retry backoff
  always lost and the rename-only pipeline turned a survivable hold
  into a failed save. When a TRANSIENT code (EPERM/EACCES/EBUSY)
  outlives the whole backoff, the write now degrades to a plain
  in-place overwrite (the Word model: safe save when the filesystem
  cooperates, full save when it doesn't) — an overwrite needs only
  write-sharing, which sync clients grant. The tmp survives until the
  overwrite lands (complete-bytes breadcrumb beside the journal-covered
  target if a crash tears it); ELOCKED now surfaces only when even the
  overwrite fails, and non-transient rename errors behave exactly as
  before.

- **commentsExtended content type** (`src/export/index.ts`; field
  report: mac Word repair prompt on every commented file). The
  `[Content_Types].xml` Override for `word/commentsExtended.xml`
  declared an invented `application/vnd.ms-word.commentsExtended+xml`;
  the Open XML SDK's constant is `application/vnd.openxmlformats-
  officedocument.wordprocessingml.commentsExtended+xml`. Word validates
  each part's declared content type against its relationship and fails
  the WHOLE package on a mismatch (recovery re-reads loosely, which is
  why repair always worked). Wrong since comments first shipped; our
  importer reads parts by path, so round-trip tests never saw it.
  Regression test pins both comment part content types to the SDK
  constants.

- **Modern-format exports: compatibilityMode 15**
  (`src/ooxml/docx.ts` SETTINGS_XML). With no declared mode Word
  assumes Word-2007-era (val 12) and opens exports in Compatibility
  Mode — banner, modern margin comments disabled, and a File → Convert
  re-save that reflows. The `w:compat` block sits AFTER
  `w:attachedTemplate` (CT_Settings is schema-ordered; a misplaced
  child fails the package) and the Verbatim-recognition payload in the
  same part is untouched — both pinned by tests.

- **Preview fonts: literal docDefaults = the author's display font**
  (`src/ooxml/styles.ts` `canonicalStylesXml`, `toDocx`
  `opts.defaultFont`, editor call sites pass `bodyFont`). docDefaults
  carried only THEME font references with no theme part in the package,
  so preview render farms fell back to Liberation Serif. Two-step fix,
  field-verified against LibreOffice 26.2: write the display font as
  literal `w:ascii`/`w:hAnsi` — and DROP the latin theme attributes,
  because OOXML gives `asciiTheme` precedence and modern theme-aware
  LO resolved it, found no theme part, and never read the literal.
  Consequence, accepted deliberately: vanilla non-Verbatim Word shows
  the author's font for fallback-styled text instead of Word's
  built-in theme font (also immunizes files against the Calibri→Aptos
  drift). Verbatim machines are untouched — verified against Verbatim
  source: frmSettings writes fonts into STYLE definitions and
  Startup.bas re-applies them per machine on open (UpdateStyles), and
  style-level fonts outrank docDefaults everywhere it could matter.
  eastAsia/cs theme refs stay (CJK keeps engine-appropriate defaults).
  Core defaults to Calibri when no font is passed, so API callers and
  tests stay deterministic.

- **Exotic-whitespace folding** (`src/editor/exotic-whitespace.ts`
  NEW; wired into F2 plain paste, Condense, and Repair OCR/PDF's new
  deterministic pass 0; field file: 561× U+2007 FIGURE SPACE). PDF
  extractors emit Unicode space separators as word gaps; U+2007 is
  NON-breaking, so a pasted card has no legal wrap points and renders
  fake mid-word line breaks no backspace can remove. Three disjoint
  buckets: category-Zs spaces fold to ' ' (they can't encode breaks,
  so folding is structurally lossless), in-text break characters
  (VT/FF/NEL/LS/PS) become paragraph splits on paste and spaces in the
  in-place cleanups, soft hyphens / zero-widths strip. Deliberately
  NOT global — rich paste, file load, and serialize are untouched, so
  existing documents never mutate silently. Repair's pass 0 runs
  through the edit lease before the AI passes (the model can't echo
  invisible characters in find-strings), collapses into the same
  single undo, and reports its count in the toast.

- **New-doc focus + caret** (`createNewDoc`, web in-place New, the
  spawned-blank-window boot — gated on the home overlay). No creation
  path focused the editor in any mode; three-pane's `createNewDoc` was
  additionally the only slot-populating operation missing the
  `view.focus()` its siblings have, and its blank doc parked the
  default selection inside the pocket. The F-key named styles keep
  their deliberate expand-to-word-only contract (an empty-block press
  is a no-op; arming-for-typing belongs to the Mod- chords) — the
  restored tests now say why.

- **Blank-doc parity** (`src/editor/blank-doc.ts` NEW, shared by both
  modes so the shapes cannot drift). The shell's blank doc seeded a
  `pocket("Untitled")` heading — undocumented, its own docstring said
  "one empty paragraph", and it broke the speech-doc pocket-OFF branch
  twice (users who disabled the pocket got one anyway; that branch's
  cursor math assumed a one-paragraph doc and landed inside the
  phantom pocket's text). Pocket seeding remains exactly where it's
  deliberate: `makeSpeechBlankDoc` behind its setting.

- **Zoom burst anchoring** (`src/editor/scroll-anchor.ts` +
  `index.ts` zoom gesture). Two races under rapid zooming: a step
  landing while the previous restore's ≤6-rAF refine loop (cv:auto
  materialization) was still running captured its anchor against a
  half-corrected transient layout, and nothing retired the old loop —
  concurrent loops alternated scrollTop writes toward different
  targets. Fixes: `restoreViewportAnchor` takes a generation ticket
  (latest wins — the precise-scroll `scrollGeneration` pattern,
  shared with the read-mode toggle), the gesture anchor is HELD 250ms
  past each commit and reused by steps inside the hold (one anchor
  per burst → no transient captures, no cumulative drift; rapid +/−
  clicks never coalesce, so the hold is what protects them), and the
  commit window widens 70→120ms to cover default key-repeat. A
  mid-burst Reset reuses the held anchor for the same reason. Test
  scripts the interleave with queued rAFs.

- **Appearance settings order** (`settings.ts` SETTING_METADATA). The
  panel walks the metadata array and emits a section header on every
  section change; three entries sat outside their sections' runs
  (markUnreadAfterMarker amid the general settings, ribbonTooltipMode
  after Custom ribbon buttons, flashcardDueDot after Card numbering),
  rendering duplicate one-row headers and pushing "Turn text after a
  mark red" above Theme. Every Appearance section now renders exactly
  once, Theme first.

- **Empty multi-pane workspace → home screen** (`multi-pane-shell.ts`
  + boot). The home screen was already mounted in multi-pane with
  slot-picker-routed actions but never auto-shown ("the workspace is
  the landing surface" — reversed). Blank multi-pane boot shows home
  before recovery (single-pane's order; the sidebar overlays it, and
  a mode-switch reload's reopened docs hide it); any doc entering a
  slot hides it (one chokepoint, `notifySlotPopulated`); the last doc
  closing shows it again — checked BEFORE `handleSlotEmptied`'s
  focused-slot early-return, since a clean doc's ✕ closes without
  focusing its slot. goHome's "Return to doc" is suppressed when the
  workspace is empty.

- **Receive pill on the home screen**
  (`home-screen.ts` `pillDock()` + `onVisibilityChange`,
  `pairing-wiring.ts`, `receive-pill-ui.ts`, `index.ts`). Collab
  invites arrive in the receive pill, which sat at z 220 under the
  home overlay (z 500) — so accepting an invitation required opening
  an unrelated document even though joining creates a NEW doc. The
  pill NODE is re-parented into a bottom-centered dock owned by the
  home screen while home is visible (listeners ride along; position
  is the hub's layout, not the editor layer's tray anchor) and
  returns to the tray on dismiss; dropzone + send pill stay
  tray-only, covered by the overlay. Card inserts interdict while
  home is up — the pills' view resolver reports no view, the insert
  row toasts a shared message instead of writing into a hidden doc
  (also upgrading the silent empty-workspace no-op), and the two
  rebindable insert-most-recent commands carry the same guard. Joins
  land in both modes: multi-pane via the slot-populated hook,
  single-pane via `replaceWithSessionDoc` now hiding home.

## 0.1.0-beta.17 — 2026-07-22

- **Custom speech-document filename template**
  (`speechDocFilenameTemplate`; `src/editor/speech-filename.ts` +
  `speech-filename-default.ts`; PR #20, thanks to
  [Shreeram Modi](https://github.com/shreerammodi)). The hardcoded
  "Speech &lt;name&gt; M-D h-mmA" pattern became a template setting:
  literal text plus `{speech}` (the prompt answer — renamed from the
  PR's `{round}` before release, since the prompt asks "Which speech?"
  and the answers are 1NC / 2AC) and `{date:...}` with day.js-style
  tokens. Letters are tokens only *inside* the date block, so literal
  words there need brackets (`{date:h-mmA [on] MMM D}`) while text
  outside the block never does. The settings row live-previews the
  rendered name against a fixed sample date, and setting descriptions
  gained multi-line rendering (`white-space: pre-line`) to fit the
  token reference. Hardening on merge (a643e74): rendered names are
  sanitized (a template could otherwise inject path traversal into the
  write path) and collisions with an existing file report and fall
  back to the native save dialog instead of overwriting. The default
  template's output is byte-identical to the old naming.

- **File-search folder rows: repoint in place**
  (`src/editor/settings-ui.ts`; PR #19, thanks to
  [Shreeram Modi](https://github.com/shreerammodi)). Each folder in
  the file-search list gains the same Browse…/Clear pair as the
  single-folder settings, so a renamed or moved root is repointed in
  place instead of removed and re-added. Merge follow-ups (c65e4b6,
  40731a9): the repoint used the row's index captured before the
  native picker opened, which goes stale if the list re-renders while
  the picker is up — resolution now re-derives the target from the
  current list, extracted into a pure helper and pinned with tests.

- **Password-protected Word files: open support**
  (`src/ooxml/sha512.ts` / `aes.ts` / `decrypt-docx.ts`,
  `src/editor/open-encrypted.ts`). A password-encrypted `.docx` is an
  OLE/CFB container holding the real zip encrypted under ECMA-376
  Agile encryption; CardMirror previously fed the container to the zip
  reader and died with a cryptic error. Opening one now detects the
  container, prompts for the password (wrong password re-prompts;
  cancel aborts the open), derives the key (SHA-512 spin, 100k
  iterations), verifies it against the stored verifier, decrypts
  (AES-256-CBC, per-segment IVs), and routes the plaintext zip into
  the normal import. Hash and cipher are small pure-TS
  implementations, verified against a real Word-encrypted fixture
  (`tests/ooxml/fixtures/agile-encrypted.docx`). Deliberate scope:
  open-only — saving writes plain files; the legacy pre-2007
  "standard" scheme gets a clear re-save-in-modern-Word message
  instead of support.

- **Stale recovery draft: overwrite guard, autosave hold-off, durable
  provenance** (`src/editor/journal-staleness.ts`, `host.statFile`
  across both hosts + desktop IPC; `recoveredFromSavedAt` on
  `JournalEntry` and the spawn payload). The reported data loss:
  crash-recovery journals are keyed by session doc-uid, not file path,
  so a journal from an old crashed session lingers while later
  sessions edit and save the same file under fresh uids — and on a
  later launch, its recovery-sidebar Save wrote the old bytes straight
  over the newer file. The changed-on-disk guard can't see it (a fresh
  launch has no disk baseline for the path). Now every recovery save
  path compares the journal's `savedAt` against the file's mtime (5s
  tolerance; unparseable timestamps fail open) and a meaningfully
  newer file raises a route-style confirmation whose safe choice is
  the default: keep the file on disk, save the draft elsewhere (the
  Save-As modal / flow, keeping both), or explicitly replace. Guarded
  paths: the sidebar's Save, and open-then-first-Ctrl-S via a
  uid-keyed mark set when a draft opens from the sidebar. The mark
  also blocks BOTH layouts' autosaves until the first manual save
  lands — three-pane re-arms autosave from the per-path preference the
  moment a draft opens, so without the hold-off a stale draft opened
  "just to look" would silently overwrite the newer file one keystroke
  later. Because editing a recovered draft re-journals it with
  `savedAt` = now (which would launder the staleness across a
  crash-relaunch or a workspace mode switch), journals now carry the
  ORIGINAL draft's timestamp in `recoveredFromSavedAt` while the mark
  is live; every staleness check reads provenance-first, mode-switch
  reopen paths re-mark from the field, and the panes→windows respawn
  ferries it in the spawn payload. The web edition's sidebar in-place
  save, which dead-ended on non-string handles (reserialize, then
  silently return false), now routes to the Save-As modal instead.

- **Backspace/Delete node-selection of whole cards blocked**
  (`src/editor/boundary-cursor-keymap.ts` — `blockBackspaceNodeSelect`
  / `blockDeleteNodeSelect`). At card-adjacent boundaries (easiest at
  the very end of the document) the base keymap's
  `selectNodeBackward` / `selectNodeForward` fallbacks node-selected
  an entire card or card body, so the next keystroke deleted it
  wholesale. The guards run ahead of the base keymap and block the
  node-selection; at a GAP position (caret clicked past the last card)
  they instead redirect the caret into the adjacent card body and
  perform the deletion there, so the first Backspace acts immediately
  rather than after an arrow-key nudge. Real block merges still work
  (the guards query `joinBackward` / `joinForward` first) and atom
  nodes (images) stay selectable. Both directions, both layouts;
  tests in `tests/editor/backspace-node-select.test.ts`.

- **Fourth timer preset** (`timerShowFourthPreset`; off by default;
  General → Timer). For four-length events. Preset 4 takes the
  Start/Pause cell so the block reads P1 P2 / P3 P4, Start/Pause
  becomes a full-height one-wide button in its own column beside the
  display, and the profile durations row gains a fourth field.
  Expanded layout only — compact drops all presets.

- **Timer holds red after expiry** (`expiredMode` latch in
  `src/editor/timer-state.ts`). At 0:00 the display latches solid
  warning-red until the clock is re-armed — load a preset, Reset, or
  type a new time; pausing or switching clocks doesn't dismiss it.
  The latch rides the shared timer state, so every window and the
  popped-out float agree, and the expiry sound stays a single double
  beep.

- **Underline thickness control** (Appearance → Typography). Same
  row family as emphasis/pocket box thickness; blank keeps the font's
  automatic weight. Applies to underline, emphasis, and underlined
  cites.

- **Cites at normal weight** (accessibility). Renders cite-marked text
  unbolded for readers who find dense bold runs visually crowding.
  Display-only — serialization and export never change, so
  collaborators and Word output still see the standard bold cite.
  Deliberately lives ONLY under accessibility: there's no
  non-accessibility reason to turn it on.

- **(AI) labels on every AI-backed command.** An audit found several
  commands that call the AI provider without the (AI) suffix — Format
  cite from selection, most visibly. Every AI-backed command now
  carries the label in the ribbon, palette, and shortcut tables, so
  the user knows before invoking.

- **Shift-F3 case cycling preserves a mid-node selection.**
  `toggleCase` replaced each touched text node whole, and a
  ReplaceStep maps positions strictly inside its range to the range's
  edge — so a selection that started or ended mid-node collapsed to a
  caret and repeating Shift-F3 went dead. Each edit is now bounded by
  the selection itself: from/to sit on edit boundaries where the
  mapping is exact, and the re-selected range survives every cycle.
  (Selections spanning whole text nodes were never affected, which is
  why the existing preserve-selection test missed this.)

- **Visual marks stripped from inline images** (#18; invariant 3 of
  the named-style normalizer + a `stripImageVisualMarks` load-time
  pass in `parseNative`). Emphasis applied across an image drew a
  text-height box through it — a mark span's height comes from font
  metrics, not its image child. The marks were also dead weight
  beyond display (the importer never creates them; `emitImageRun`
  writes no run styling, so Word showed nothing either way). Images
  now carry only functional marks (`comment_range`, link) as a live
  normalizer invariant, and docs saved with marked images heal on
  open.

- **Emphasis-box padding fix ported to three-pane**
  (`src/editor/style.css`). Highlighting crossing an emphasis box
  showed a white sliver inside the box in the three-pane workspace:
  the single-doc rule had already dropped the box's horizontal
  padding, but the workspace's parallel rule still carried
  `padding: 0 0.1em`. The two rules now match.

- **Per-doc scroll position in the three-pane workspace**
  (`savedScrollTop` on `DocRecord`). The scroller is the slot's
  shared pane body, which clamps to 0 the moment a doc's editor
  detaches — so scroll was effectively per-pane and switching stacked
  docs landed wherever the pane happened to be. The viewport now
  rides each DocRecord: captured on detach, reapplied on mount, 0 for
  fresh docs (a doc opened on top of another starts at the top).

## 0.1.0-beta.16 — 2026-07-17

- **Floating always-on-top timer pop-out** (desktop;
  `timer.html` / `src/editor/timer-popout.ts` second vite entry;
  `setTimerPoppedOut` / `reconcileTimerPopout` in
  `src/editor/timer-state.ts`; window management in
  apps/desktop main.ts). The timer panel gains a ⇱ button that
  moves the timer into a small frameless `alwaysOnTop: 'floating'`
  window. Architecture rides the timer's existing sync layer: state
  already lives in localStorage + a BroadcastChannel with each
  window deriving the live countdown from `runningSince + base`, so
  the pop-out is just another subscriber — its preload exposes
  exactly one call (self-resize, so the frameless window re-hugs the
  panel when the compact ↔ expanded toggle reflows it; settings
  persist in the same origin localStorage, so presets / compact /
  theme read identically) and it controls the shared clocks with a
  near-zero host surface. The window opens sized to the opener's
  measured panel at the opener's chrome-zoom factor, which the main
  process also applies to the float so both surfaces render at the
  same scale; the float carries its own pop-in button (⇲), and in
  BOTH layouts reset + pop-out stack half-height in the first
  column. Compact was redesigned to absorb the new button at zero
  width cost: the aff/neg pair gives way to a single prep button
  (side per the shared `prepShownSide` — an active prep mode always
  wins, else the sticky last-chosen side) spanning a ⇄ side-switch
  and the start/pause button. The ⇄ is a pure display flip in speech
  mode but a real pause-and-switch while a prep mode is selected —
  a switch that only changed a hidden preference would read as
  broken. A shared `poppedOut` flag drives
  everything: main windows render the panel iff
  `visible && !poppedOut` (the timer never shows in the float and a
  window at once), popping out forces `visible: true`, hiding the
  timer anywhere retracts the pop-out, and the float closes itself
  whenever the flag clears — state is the single driver, with a
  main-process `timer:popout-closed` broadcast as the crash-path
  backstop. The persisted flag is reconciled at boot against the
  host's live "does a timer window exist?" answer rather than
  cleared unconditionally: a fresh launch always starts popped-in
  (per design — no stale-flag landmine), while a three-pane
  mode-switch reload (which reloads the window under a surviving
  float) keeps the flag and the invariant. The pop-out window is
  excluded from quit accounting (a lone float closes with the last
  document window rather than keeping the app alive) and from
  dialog parenting; its per-session position is remembered and
  clamped to a connected display. Deliberately out of scope:
  macOS fullscreen-space floating (keep the timer popped in there)
  and cross-launch pop-out persistence. State semantics tested in
  `tests/editor/timer-state.test.ts`.

- **Audible timer alerts** (`src/editor/timer-audio.ts`;
  `timerSoundEnabled` / `timerSoundVolume` settings; opt-in). Beeps
  at the `timerFlashSeconds` thresholds — one "alert points" concept
  with two outputs, flash and sound — plus a double beep at 0:00
  (A5 single pulse vs B5 double, distinguishable without looking).
  Synthesized oscillator tones, no bundled assets. Two structural
  mechanisms, both consequences of the timer's every-window-ticks
  architecture: EXACTLY-ONCE ownership via a `cardmirror-timer-audio`
  Web Lock (one surface plays; the rest queue and fail over
  automatically; main windows stand down while the pop-out exists —
  the float is never occluded, hence never throttled, making it the
  preferred owner), and THROTTLE-PROOF scheduling on the AudioContext
  timeline (beeps are armed sample-accurately at absolute audio-clock
  times derived from `runningSince + base`, so Chromium's background
  timer throttling — the same mechanism that produced this session's
  false perf reproductions — cannot delay a signal; every state or
  settings change cancels and re-derives the schedule). Only
  strictly-future crossings are armed (no retro-fire on
  reschedule/resume; tested in `tests/editor/timer-audio.test.ts`).
  Desktop waives Chromium's autoplay policy
  (`autoplay-policy=no-user-gesture-required`) since the audio owner
  may be a window the user never clicked; the web edition installs a
  one-time gesture hook instead. `timerFlashSeconds` also finally got
  a real editor (kind `timerFlashSeconds`, comma-separated seconds,
  canonicalized dedupe/sort-desc/cap-12 on commit AND in the load
  sanitizer) — the flash toggle's description had claimed "configured
  thresholds" since the feature shipped while no UI existed to
  configure them.

- **All clipboard writes: transient failures retried, surfaced, and
  routed around** (new `src/editor/clipboard-write.ts` —
  `writeClipboardHtml` / `writeClipboardText` /
  `writeClipboardWithRetry`; `host:clipboard-write-html` IPC; field
  report 2026-07-17 against Create Reference: "requires me to click
  the button like 5 times").
  `navigator.clipboard.write` fails TRANSIENTLY — Win32's clipboard is
  a global lock briefly held by whatever app copied last (Word,
  clipboard managers; the exact app a references workflow alternates
  with), and Chromium rejects writes from an unfocused document — and
  the old catch logged to a console nobody watches and returned the
  same `false` as cursor-outside-a-card, which the caller dropped on
  the floor (`if (ok) showToast('Copied!')` — no else). Three-part
  fix, same philosophy as the beta.15 ELOCKED save fix: (1) desktop
  writes via the MAIN process (`clipboard.write({html, text})` — no
  renderer-focus requirement, native Win32 path; optional host member,
  old shells fall back), (2) the renderer path retries 100/250/500ms
  (`writeClipboardWithRetry`, tested in
  `tests/editor/create-reference-retry.test.ts`), (3) every outcome
  toasts — 'copied' / 'invalid-selection' (select body text inside a
  single card) / 'clipboard-failed' are now distinct results instead
  of one silent boolean. A sweep found the same silent one-shot
  pattern in the outline's copy-heading-and-contents, Copy Current
  Heading, and the translate copy (which toasted "copied to
  clipboard" even when the write had failed); all now route through
  the shared module with success/busy toasts, and the link context
  menu (already honest) switched to it for the retry + host path.
  Follow-up hardening from the regression audit: the main-process
  handler VERIFIES the write by reading the text flavor back
  (Electron's `clipboard.write` returns void, so success was
  otherwise a claim, not a fact; bounded length+prefix compare, and
  the only blind spot — another app overwriting between write and
  read-back — errs toward false failure, the safe direction); empty
  flavors are omitted from the payload (passing `html: ''` would
  register an empty text/html format, and Word/Docs prefer HTML, so
  text-only copies would have pasted as nothing there); and the
  ClipboardItem-less plain-text fallback the old heading-copy paths
  had (old Firefox web) is restored inside the shared writer.
  Retry ladder tested in `tests/editor/clipboard-write.test.ts`.

- **Nav drag scroll-gate cache validated against re-parenting**
  (`findNavScrollGate` in `src/editor/nav-panel.ts`; field report
  2026-07-17, three-pane). The drag hit-test gates pointer positions
  against the panel's nearest scrolling ancestor, cached per instance
  and revalidated with `isConnected` only. The multi-pane shell
  re-parents nav sections between containers when panes are
  rearranged, so the cached gate could remain in the DOM — as another
  slot's scroller — while no longer being this panel's ancestor. Every
  drag hit-test then failed the gate rect check and returned null:
  pickup and hover-highlighting worked (separate code path), but no
  drop indicator ever lit anywhere in that doc — including the
  always-valid end-of-doc slot — and drops snapped back, until the doc
  was closed and reopened. The cache now also requires
  `contains(this.root)`, recomputing whenever the panel has moved.
  Regression test: `tests/editor/nav-scroll-gate-reparent.test.ts`.

## 0.1.0-beta.15 — 2026-07-17

- **Per-card `contain-intrinsic-height` estimates — fixes the
  rapid-nav-click freeze on very large documents** (`intrinsicHeightStyle`
  in `src/schema/nodes.ts`, emitted by the `card` / `analytic_unit`
  toDOM; field report 2026-07-16). Cards carry
  `content-visibility: auto`, so never-rendered cards are laid out as
  placeholder boxes sized by `contain-intrinsic-size` — previously a
  flat `auto 200px` for every card. On documents whose card heights
  vary widely, a nav jump into unvisited territory ran its scroll math
  on guesses wrong by up to a screenful per card; Chromium then spent
  seconds of main thread correcting layout card-by-card as each
  materialization replaced a guess and shifted everything below it.
  The jump itself landed instantly (which is why the first click in a
  burst always felt fine), but the correction wave from click N landed
  on clicks N+1…, freezing the interface — including outline-pane
  scrolling — under rapid successive clicks. Measured live on a real
  ~1MB tournament file: 8 cold jumps = 18 long tasks totaling ~1.8s
  stock, ~0.3s with estimates, ~2.3s again after reverting. The
  estimate is a pure content heuristic (chars-per-line × line height +
  per-paragraph margins, floor 40px) computed in toDOM with no layout
  reads; the `auto` keyword still memoizes each card's real height
  after first render, so the estimate only governs cards that have
  never been on screen. Latent since content-visibility landed
  (pre-beta.14) — surfaced on files large and height-varied enough to
  make the correction wave visible. Regression-tested in
  `tests/schema/intrinsic-height.test.ts`.

- **Explicit document icons for the file associations**
  (`apps/desktop/scripts/generate-doc-icons.py` → `build/docx.icns` /
  `.ico` + `build/cmir.icns` / `.ico`; field report 2026-07-16). The
  `fileAssociations` shipped no document icon, so macOS DERIVED one
  from the app icon at render time — and that derivation failed
  reproducibly on a user's machine (uniform corrupted tiles on every
  .docx in their file manager; an iconservices cache flush didn't fix
  it, and a third-party Finder replacement rendering through its own
  icon pipeline made it worse). Shipping real icons removes the
  fragile step for every consumer — Finder, third-party file managers,
  and Windows Explorer (the .ico twins ride the same electron-builder
  by-extension convention: `build/<ext>.icns`/`.ico` are picked up with
  no config change; verified in the built bundle's
  CFBundleDocumentTypes). Icons are generated, not hand-drawn —
  standard macOS document language (white folded-corner page, app
  mark, extension label); regenerate with the script after changing
  `build/icon.png`.

- **Atomic-save rename: retry transient Windows locks, friendly
  ELOCKED error** (`doc-writes.ts` writeAtomic; classifier
  `fileLockedMessage` in `error-surface.ts`; tests in
  `tests/desktop/doc-writes.test.ts` +
  `tests/editor/error-surface.test.ts`; field report 2026-07-16,
  Windows + Dropbox). Windows refuses `rename` over a file
  another process holds open (POSIX doesn't care), and Dropbox /
  antivirus grab a freshly-saved file within milliseconds to
  sync/scan it — so the SECOND of two quick saves hit EPERM renaming
  its .cmtmp over the target while Dropbox still held the FIRST
  save's output. The rename now retries on EPERM/EACCES/EBUSY with
  50→800ms backoff (~1.5s total — the holds are sub-second, matching
  the field timing of "seconds apart fails, minutes apart fine");
  non-transient errors still throw immediately, and per-path
  serialization already prevents CardMirror racing itself. If the
  backoff is exhausted, the error is marked ELOCKED with a
  human sentence ("temporarily locked by another program — often
  Dropbox or an antivirus scanner…"), and all three renderer
  save-failure alerts strip Electron's IPC wrapper and show just that
  sentence. The .cmtmp is still cleaned up and the original file left
  intact on every failure path.

- **Tournament pause for automatic update checks**
  (`updateChecksPausedUntil` setting; button in the About-this-install
  section next to the auto-check toggle; sanitize test in
  `tests/editor/update-pause.test.ts`; mirrors ebb's tournament mode).
  One click pauses the AUTOMATIC checks (launch + daily) for 7 days by
  storing an epoch-ms resume timestamp; both renderer auto-check sites
  gate on `pausedUntil <= Date.now()`, so stale timestamps self-heal
  as unpaused with no cleanup migration. While paused the row shows
  the resume date and the button flips to resume-now (sets 0). Manual
  checks (Help menu, About button) are deliberately unaffected. Also
  fixed the About section's stale "macOS can't self-install" toast —
  all platforms stage in the background since the swap updater.

- **Cross-built Windows/Linux artifacts: koffi natives guaranteed**
  (`apps/desktop/scripts/fetch-koffi-cross.sh`, wired into
  pack/dist/release before the build steps). koffi resolves its native
  module from per-platform `@koromix/koffi-*` optionalDependencies,
  and npm installs — and on every subsequent `npm install`, PRUNES —
  only the host platform's package. A Windows exe cross-built on the
  mac after such a prune shipped without its native module and crashed
  at startup ("Cannot find the native Koffi module", via main.ts's
  top-level ax-suppress import chain; caught in the Parallels
  update-flow rehearsal, 2026-07-16). Published releases were
  unaffected (the beta.14 exe verifiably contains the win32 prebuild —
  the prune happened after that cut), but every future cut was one
  `npm install` away from shipping broken Windows/Linux builds. The
  script fetches the win32-x64 + linux-x64 prebuilds via `npm pack`
  (which has no platform gate), pinned to the installed koffi version,
  idempotently.

- **Update flow overhaul: install-on-confirm chip, universal mac
  build, mac self-update, stable signing** (modeled on ebb's update UX
  after a comparative review, 2026-07-16; verified against a local
  universal build). Four pieces:
  1. *Install-on-confirm chip* (`src/editor/update-chip.ts`, wired in
     the status bar; main-process state + IPC in `main.ts`; tests in
     `tests/editor/update-chip.test.ts`). Auto-update paths no longer
     show ANY dialog — Windows/Linux stage silently (autoDownload) and
     a status-bar chip appears on update-downloaded; clicking it
     restarts into the update (`quitAndInstall`), and
     install-on-quit remains the fallback for users who never click.
     Late-opened windows pull the chip state at boot; the manual Help →
     Check for Updates flow keeps its dialogs.
  2. *Universal mac build*: `mac.target` is now dmg+zip at
     `arch: ["universal"]` (the zip is the updater artifact).
     `x64ArchFiles: "**/node_modules/@koromix/**"` exempts koffi's
     per-platform prebuilds from the lipo-merge check (identical in
     both arch builds by design); our own dylibs were already fat.
     Verified: merged app's main binary is x86_64+arm64; dmg ~213MB /
     zip ~206MB (vs ~120MB per-arch). `pickInstallerAsset` prefers a
     universal dmg for both mac targets, per-arch fallback for old
     releases.
  3. *macOS self-update by bundle swap*
     (`apps/desktop/src/mac-swap-update.ts`; tests in
     `tests/desktop/mac-swap-update.test.ts`). Squirrel.Mac refuses
     unsigned installs, but electron-updater's DOWNLOAD path (zip +
     sha512 against release metadata) works — so mac stages via
     `downloadUpdate()` after a self-updatability check (real bundle,
     not Gatekeeper-translocated, writable), and the chip click spawns
     a detached helper script that waits for exit, extracts, strips
     quarantine (app-downloaded files never carry it — why Gatekeeper
     never re-assesses), swaps the bundle with backup-and-restore on
     any failure, and relaunches. Not-updatable installs and staging
     failures degrade to an 'available' chip that opens the release
     page (the old behavior).
  4. *Stable self-signed release signing*
     (`apps/desktop/scripts/setup-signing.sh` + `scripts/sign-mac.js`
     afterSign hook). electron-builder rejects non-Apple identities
     (CSC_NAME → "falling back to ad-hoc"), so the hook re-signs the
     packed app with the "CardMirror Local Signing" cert (FDP's proven
     TCC-stability scheme), preserving per-binary entitlements and the
     hardened-runtime flag. Ad-hoc identities change every build and
     wipe TCC grants (microphone) on every update; the stable cert
     keeps them. No-ops on machines without the cert (CI stays
     ad-hoc). Existing installs re-prompt for the microphone ONCE at
     the first signed update, then never again. First-install
     Gatekeeper friction is unchanged (only notarization removes it).

- **Style font sizes: reset-to-defaults button**
  (`buildDisplaySizesEditor` in `settings-ui.ts`). One-click restore
  of `DEFAULT_DISPLAY_SIZES` (now exported from `settings.ts`), using
  the same footer/icon-button treatment as the paragraph-spacing
  reset. Also reordered the Style typography flag checkboxes into
  outline-hierarchy order — pocket and hat first, then cite /
  underline / undertag / emphasis (the index-based sync list updated
  to match).

- **Pocket box settings: on/off + thickness** (`pocketBox` /
  `pocketBoxSize` in `DisplayTypography`; UI rows in the Style
  typography editor; tests in
  `tests/editor/display-typography-sanitize.test.ts`). The box around
  pocket headings was a hardcoded `border: 3px` in `.pmd-pocket`; it's
  now `var(--pmd-pocket-box-size, 3px)`, driven by a pt-valued setting
  mirroring `emphasisBoxSize` (same quarter-pt sanitize, same (0, 12]
  clamp, same number-input row). Default 2.25pt = exactly the old 3px,
  so existing documents render identically. A "Pocket: boxed" flag
  (default on) disables the box entirely via the hat-toggle pattern —
  a `pmd-pocket-box-off` predicate class for the NON-default state
  that drops the border and its padding, leaving a plain centered
  heading. The CSS var + class are set on both `#editor` and
  `documentElement` like the emphasis ones, so multi-pane editors and
  the formatting-panel previews inherit them. Display-only — docx
  export borders are unchanged.

- **Smart paste conversion: Word clipboard HTML → CardMirror structure**
  (`import/html-paste.ts`, new; wiring in `paste-plugin.ts`; setting
  `smartPasteConversion`, default on, Settings → Editing → Paste; tests
  in `tests/import/word-html-paste.test.ts` +
  `tests/editor/smart-paste-conversion.test.ts`). Word pastes used to
  degrade to plain paragraphs because the schema's parse rules are
  pmd-class-qualified. Now, clipboard HTML that `detectPasteDialect`
  recognizes as Word converts through the docx importer's own assembly
  seam: a front-end classifies the HTML into the importer's
  `ParaInfo[]` intermediate — by NAME where Word's head `<style>` block
  supplies classes/mso-style-names (resolved through the same
  vocabulary as `PSTYLE_TO_NODE`/`RSTYLE_TO_MARK`, legacy ids
  included), by VISUAL convention where names are absent (bold 26pt
  pocket / 22pt hat / 16pt underlined block, gated on
  mso-outline-level like the importer's outline promotion; a bold-13pt
  LEAD run classifies a cite) — then `assembleDoc` builds the doc
  (card grouping, cite slotting via cite_mark,
  `reconstructNumbering` fed from `mso-list` lfo/level, underline
  normalization), so paste and `.docx` import can never disagree.
  Also mapped: highlights (mso-highlight/named/hex → OOXML named
  colors; unknown hexes → shading, Word's protected-highlight
  convention), font sizes (suppressing style-implied sizes: 11pt
  Normal, each heading's canonical size, cite's 13pt), boxed spans →
  emphasis, links, sub/superscript, strikethrough; Word's fake
  auto-number glyphs (`mso-list:Ignore`) and `<o:p>` noise are
  dropped; XML-illegal control characters are stripped at entry with
  the same definition as the export chokepoint. Guardrails: the
  conversion returns null when it finds no debate structure (no
  card/heading/cite) and the paste falls through to the previous
  behavior; F2 plain paste runs before it; the setting turns the whole
  layer off.

- **Smart paste conversion: haku.cards** (`convertHakuHtml` in
  `import/html-paste.ts`; tests in
  `tests/import/haku-html-paste.test.ts`). haku's copy builders emit
  classless, entirely inline-styled HTML that deliberately mimics
  Verbatim's visual conventions — which makes it exactly the shared
  pipeline's visual-rules path (the class dictionary is a natural
  no-op): 13pt bold `<h4>` → tag, bold-13pt cite lead span →
  cite_mark → cite_paragraph, `<u>` → underline (normalized to the
  named style in bodies), highlight group spans
  (`background`/`mso-highlight`/hex, traditional #FF0/#0F0/#03FFFF
  and new #ffeb70/#b8f277/#88c9ff palettes) → highlight marks,
  small-pt runs → font_size (shrunk text), bordered spans → emphasis,
  26/22pt `h1`/`h2` case exports → pocket/hat. haku's `color:#1b1b1c`
  contrast stamp on highlight spans is dropped (font color on a
  highlighted run is the tool's rendering choice, not the user's —
  CardMirror's highlight mark forces contrast itself). Known quirk,
  accepted: haku's source-file breadcrumb lines (plain 11pt paragraphs
  naming the original pocket/hat/block, between cite and body) are
  indistinguishable from body text and import as card_body
  paragraphs.

- **haku paste conventions: emphasis reconstruction + font-size
  cleanup** (`applyHakuBodyConventions` in `import/html-paste.ts`;
  field-tested rules specified 2026-07-16). haku's search-copy run
  model is `{bold, italic, underline, highlight, sz_half}` — no box
  concept (original Emphasis was flattened at their ingestion) and
  `sz_half` is the source document's per-run size passed through
  verbatim (only when haku's "variable font size" mode is on; unsized
  runs fall back to the card's minimum size). Two per-card passes on
  haku pastes only: (1) bold+underline → emphasis_mark, with the bold
  dropped — UNLESS exactly 100% of the card's underlined text is bold,
  the signature of a pre-modern-Verbatim file whose underline style
  WAS bold+underline; those keep plain underline (bold dropped),
  matching how the docx importer treats the legacy
  `StyleBoldUnderline`. Composes with highlights (haku wraps every
  highlighted run in `<u>`, so bold-inside-highlight becomes
  emphasis+highlight). (2) A `font_size` mark survives only when the
  run is under 10pt (real shrinking, including haku's min-size
  fallback on unsized runs) or when a kept (underlined/emphasized) run
  is strictly larger than the card's kept-text baseline — the
  char-weighted modal kept size, ties to larger, unmarked runs
  counting as 11pt — i.e. a deliberately enlarged phrase. A uniform
  12pt-base file pastes clean. Word pastes are deliberately untouched
  by both passes: there the sizes and bold+underline combinations are
  the user's own formatting (guarded by test).

- **Word paste: the CANONICAL Emphasis style is recognized — Word
  spells it `<em>`** (`StyleDict.elements` in `import/html-paste.ts`;
  root-caused against two field docs whose style tables were perfectly
  canonical yet still lost their borders on paste). Word maps built-in
  character styles to semantic HTML elements: a run styled with
  (Verbatim's redefined) Emphasis is copied as a bare `<em>` — no
  class, no inline style — with ALL the formatting in a head `em {…}`
  ELEMENT rule (`border:solid windowtext 1.0pt; padding:0in;
  font-weight:normal; font-style:normal; text-decoration:underline`,
  verified from a live Word 15 Mac clipboard capture of the field
  doc). The style dictionary read only class selectors, so the rule
  was invisible and every emphasis run imported as italic (the `<em>`
  tag default). The dictionary now also records bare inline-element
  rules (em/strong/b/i/u/s), and `foldElement` folds the tag's element
  rule between the tag's own semantics and its classes — so the rule's
  `border` makes the run boxed → emphasis_mark, and its
  `font-style:normal` cancels the tag-implied italic (foldCss now lets
  an explicit `normal` reset italic). In a non-Verbatim doc whose `em`
  rule is italic-only, `<em>` still imports as plain italic — the
  border decides, same formatting-truth principle as the rename
  handling. Verified end-to-end against the real captured clipboard:
  46 emphasis runs, zero italic leakage, full structure (pocket / hat
  / blocks / cards / cite).

- **Word paste: renamed Emphasis styles are recognized**
  (`charTokenToMark` + widened border detection in
  `import/html-paste.ts`). Word's style-duplication bugs rename
  Emphasis to "Emphasis1", "Emphasis Char Char", "Text Bold", or
  arbitrary names — the failure family the style cleaner utility
  repairs in .docx files. The paste converter now catches them three
  ways, name-first then formatting-truth: (1) any char-style token
  containing "emphasis" maps to emphasis_mark (mirroring the paragraph
  side's contains-"analytic" rule), excluding Word's italic built-ins
  Subtle/Intense Emphasis; (2) "Text Bold" — the most common rename —
  is an explicit token; (3) the box border identifies the style
  through ANY rename (the style cleaner's key insight: `w:bdr` is the
  one attribute unique to Emphasis in the Verbatim vocabulary), now
  matching Word's `mso-border-alt` spelling as well as the `border`
  shorthand, in class CSS and inline styles. Per-side border
  properties are deliberately not matched (paragraph-border spellings,
  not the run box). Note the .docx IMPORTER still has none of this —
  it maps only the exact `Emphasis` rStyle; renamed emphasis in a
  .docx still needs the style cleaner. No contextual conversion was
  added for Word (bold+underline stays bold+underline): pastes from
  Word are expected to be high-fidelity, unlike haku's already
  post-processed content.

- **haku pastes arrive gap-fixed** (`fixGapsInConvertedDoc` in
  `import/html-paste.ts`; machinery extracted to
  `editor/formatting-gaps.ts`). haku splits underlining at punctuation
  on copy (its `underlinePunctuationSegments` strips trailing
  punctuation out of `<u>` runs), so converted cards were full of
  one-character formatting gaps the user would fix by hand. The manual
  Fix Formatting Gaps command now runs on the converted doc — on a
  throwaway EditorState, before the content is pasted — honoring the
  user's `formattingGapClass` setting, after the emphasis/size
  conventions so the bridge sees final marks. The bridge's font-size
  tie-break uses a local mirror of the app shell's
  `effectivePtForNode` (the shell can't be imported from the converter
  graph). Word pastes are not gap-fixed (guarded by test). Supporting
  refactor with no behavior change: the whole gap cluster
  (`fixFormattingGaps`, `forEachGap`, gap-char class, structural
  no-bridge sets) moved from `ribbon-commands.ts` to a new
  `formatting-gaps.ts` — ribbon-commands imports paste-plugin, so the
  converter importing ribbon-commands would have been a module cycle;
  ribbon-commands re-exports `fixFormattingGaps` for existing
  callers.

- **Word paste no longer inserts a picture of the copied text**
  (`paste-plugin.ts` `handlePaste`; tests in
  `tests/editor/paste-image-precedence.test.ts`). Word (and other
  rich editors) put a rendered bitmap of the copied selection on the
  clipboard alongside the real `text/html`/`text/plain` flavors, and
  `handlePaste`'s image branch ran before the text branches — so
  pasting cards from Word inserted an image node. The image branch is
  now gated on `clipboardHasMeaningfulText`: text flavors win whenever
  they carry actual content once tags and whitespace entities are
  discounted. Image-only clipboards (screenshots, browser "Copy
  image" — whose `text/html` is at most a bare `<img>` wrapper) take
  the image branch exactly as before. First slice of the smart-paste
  conversion work; the Word/haku structure converters build on this.

- **Paste-source detection for smart paste conversion**
  (`paste-dialect.ts`, new; tests in
  `tests/editor/paste-dialect.test.ts`). `detectPasteDialect(html)`
  routes clipboard HTML to a converter — `'word'`, `'haku'`, or null
  for "leave it alone." Word is recognized by its document shell
  (Generator/ProgId metas, `xmlns:w` office namespace), which only
  Word itself writes — browsers serialize just the selected fragment
  on web copies, so page metas can't ride along; bare `mso-*`
  properties or `Mso*` classes deliberately do NOT match
  (CMS-laundered Word remnants). haku.cards emits classless
  inline-styled HTML, so it's matched by a scored structural
  fingerprint of its copy builders (Calibri wrapper div, 13pt bold
  `<h4>` tag, pt-sized runs with literal `<u>`,
  `mso-highlight`/`box-decoration-break:clone` highlight spans,
  26/22pt `h1`/`h2` case exports). CardMirror's own clipboard
  (`pmd-*` classes) and Google Docs (`docs-internal-guid`) are
  explicit excluders. Not yet wired into `handlePaste` — the
  converters land next, gated behind a "smart paste conversion"
  setting (default on).

- **Importer's assembly seam exported for the paste converters**
  (`import/importer.ts`). `ParaInfo` and `assembleDoc` — the
  paragraph-level intermediate and the phase-(b) back-end that does
  card grouping, cite slotting, and numbering reconstruction — are
  now exported. The paste converters classify foreign clipboard HTML
  into `ParaInfo[]` and reuse `assembleDoc` verbatim, so paste and
  `.docx` import can never disagree about document structure. No
  behavior change.

- **Direction-based head in dynamic drag selection**
  (`word-selection-plugin.ts`; tests in
  `tests/editor/word-selection-drag.test.ts`). Single-click drags had
  one escape from word granularity: re-entering W0 (the origin word).
  The head now follows a simple direction rule, settled over three
  feel-test rounds: moving AWAY from the anchor snaps word-by-word;
  moving back TOWARD the anchor is always character-precise (multi-word
  retreats included); turning away again resumes snapping. Direction is
  judged per observed move against the previous active position —
  stationary pointer re-reports are no-ops, which killed the
  snap↔precise flicker of the first iteration (position-vs-max rules
  couldn't distinguish "nudged back" from "re-reported the same spot").
  Runs reset on side flips and on re-entering W0; double/triple-click
  fixed granularities untouched. `extendActiveEndTo` +
  `createPointAnchor` exported so tests drive the machine with
  synthetic position sequences.

- **XML-illegal characters stripped at export** (`ooxml/xml.ts`; tests
  in `tests/export/xml-illegal-chars.test.ts`). Field report: a shared
  .docx wouldn't open — `word/document.xml` carried a
  U+001D. `escText`/`escAttr` only entity-escaped `&<>"`; characters
  XML 1.0 cannot represent AT ALL (C0 controls besides tab/LF/CR, the
  noncharacters U+FFFE/U+FFFF, lone surrogate halves — typically pasted
  in from PDFs) passed through raw, and Word rejects the whole package
  over one of them. Both escapers now strip that set first — stripped,
  not escaped, because XML 1.0 has no legal spelling for them. The
  pattern captures valid surrogate pairs first and keeps them,
  avoiding lookbehind (parse-time syntax error on older engines).
  Reproduced exactly per the report before fixing; five tests pin the
  full C0 sweep, tab/LF/CR preservation, lone vs paired surrogates,
  noncharacters, and the untouched entity escaping.

- **Numbering survives tag↔analytic swaps** (`ribbon-commands.ts`;
  tests in `ribbon-commands.test.ts`). `cardToAnalyticUnitNode` /
  `analyticUnitToCardNode` created the converted node with null attrs,
  resetting `numRole`/`numRestart` to defaults. Both node types share
  `numberingCardAttrs`, so the source node's attrs now pass straight
  through — covering the single-card converts AND the selection-
  spanning restyle path, which routes through the same two functions.

- **Maximum text width (accessibility)** (`maxTextWidthPx` in
  `settings.ts`, 0 = off/default, clamp 400–3000px; `index.ts`,
  `settings-ui.ts`, `style.css`). Caps + centers the ProseMirror
  content column via a `--pmd-max-text-width` var (removed entirely
  when off — the everyday layout is the pre-feature CSS;
  `margin-inline: auto` is inert at full width). `maxTextWidthAlign`
  (center default / left / right) drives a `--pmd-max-text-margin`
  margin-inline pair so the capped column can pin to either edge.
  Applying a cap changes the width cards lay out into, so
  `applyMaxTextWidth` explicitly re-schedules the content-visibility
  intrinsic-width measurement. UI: enable checkbox + px input +
  Left/Center/Right position group; enabling restores the last width
  (or 800). The boot-time apply also surfaced the index.ts TDZ trap —
  the intrinsic-width sync state now lives above the module-level
  apply calls.

- **Per-style text alignment (accessibility)** (`styleAlignments` in
  `settings.ts`; `index.ts`, `settings-ui.ts`, `style.css`). Seven
  structural styles (tag, doc-level paragraph, card body, analytic
  body, analytic, undertag, cite paragraph) each get a Default/Center/Justify picker
  under Settings → Accessibility. Deliberately filed under
  accessibility despite being formatting — there is no non-
  accessibility reason to justify debate evidence. Applied as
  `--pmd-align-*` custom properties (set only for non-default states;
  every hooked rule falls back to `start`), so the everyday rendering
  is byte-identical CSS. Card bodies split by context (`.pmd-card` vs
  `.pmd-analytic-unit` ancestors); pockets/hats/blocks are not
  covered; a paragraph's own `alignment` attr renders as an inline
  style and beats all of it. Display-only — exports unchanged.

- **Hat underline single/double flag** (`hatUnderlineDouble` in
  `DisplayTypography`, default true; `settings.ts`, `index.ts`,
  `settings-ui.ts`, `style.css`). Follows the established typography-
  flag pattern: a checkbox row in the Document typography editor, a
  predicate class (`pmd-hat-underline-single`, the NON-default state)
  toggled on `#editor` + `:root` by `applyDisplayTypography`, and CSS
  overrides for the editor hat and the ribbon formatting-panel preview.
  Missing-key sanitize resolves true, so existing configs keep the
  double underline. Display-only; docx export unchanged.

- **Copy Previous Cite: nearest-only mode** (`ribbon-commands.ts`,
  `settings.ts`; tests in `copy-last-cite-bug.test.ts`).
  `copyPreviousCiteNearestOnly` (toggle, default ON — a behavior
  change for existing users, called out in the changelog) narrows the
  copied set to the last member of whatever cite group
  `findPreviousCites` resolves — the cite closest to the cursor in
  document order. All source-selection semantics (own-card phase,
  previous-card / free-floating-run phase) are unchanged; only the
  slice copied differs, so the two modes can never disagree about
  WHICH source wins.

- **Nav width per-window** (`nav-panel.ts`; tests in
  `tests/editor/nav-width.test.ts`). `--nav-width` was applied from the
  `navWidth` setting in every panel's settings subscriber — and since
  settings sync across windows via the `storage` event, a drag in one
  window resized every window live. The setting now seeds the CSS var
  ONCE at window boot (module init, not panel construction — multi-pane
  constructs panels per opened doc, which would re-pull whatever
  another window persisted since); drags apply locally and persist the
  value only as the default for future windows. The single-doc panel
  and multi-pane rail still share `--nav-width` within a window.
  Double-clicking the handle resets to the factory default
  (`SETTINGS_DEFAULTS.navWidth`), persisted like a drag — one rule:
  any manual width change is also the default for future windows.

- **Restart toggle is scope-aware** (`numbering-commands.ts`,
  `nav-panel.ts`; tests in `numbering-commands.test.ts` +
  `nav-panel-card-numbers.test.ts`). `toggleNumRestart` gains the same
  selection scoping as the role toggles, level-aware: the nav scope
  hook generalizes from level-4 card positions to
  `{ kind: 'blocks' | 'cards', positions }` — level-3 rows resolve to
  the block nodes themselves (which carry `numRestart`), level-4 rows
  to the wrapping card/analytic_unit. Editor RANGE selections act on
  the blocks they span, falling back to card units only when no block
  is in range (blocks win: flipping every card to "restart here"
  because a selection crossed a block would be catastrophic). Whole-set
  semantics normalize to the NON-DEFAULT state per kind — blocks all →
  "continue" (the consecutive-numbering-across-blocks use case), cards
  all → "restart here"; a second press restores defaults. The ribbon
  restart button's pressed state follows the same scope (true when
  every in-scope unit restarts the count), resolved independently of
  the selection chrome's precomputed card units, which would miss a
  blocks selection. Role toggles consume only the 'cards' flavor —
  a blocks selection falls through to the caret for those.

- **Nav depth: default-for-new-docs setting; level buttons transient**
  (`nav-panel.ts`, `settings.ts`, `settings-ui.ts`; tests in
  `tests/editor/nav-panel-depth.test.ts`). `navMaxLevel` is reframed as
  "Default navigation depth" (Settings → General, registry kind
  `navDefaultDepth`, rendered by the Pocket/Hat/Block/Tag picker shared
  with the file-search depth). Every NavigationPanel now keeps a
  per-instance `localMaxLevel` — the single-pane special case where the
  1–4 buttons wrote through to settings (silently making the last click
  the default for future docs) is gone, unifying with the multi-pane
  behavior. `attach()` resets the panel to the setting, so new docs
  open at the configured depth; changing the setting deliberately does
  NOT re-filter already-open docs. Existing users' persisted
  `navMaxLevel` value carries over as their default (no migration).

## 0.1.0-beta.14 — 2026-07-13

- **Web-edition download + GitHub header buttons** (new
  `web-download.ts`; `index.html`, `icons.css`; 9 tests in
  `tests/editor/web-download.test.ts`). The ribbon's right-hand grid
  grows a third column on the web (download above GitHub, left of the
  shortcuts/timer column); both buttons start hidden and are revealed
  only when no Electron host is present, so the desktop app never
  advertises its own installer. Download resolves platform + chip via
  Chromium's high-entropy `userAgentData.architecture` — the ONLY
  reliable Apple-Silicon signal (`navigator.platform` reports
  "MacIntel" on M-series too) — and falls back to a route-style picker
  (Windows / macOS ARM / macOS Intel / Linux AppImage) when ambiguous,
  including phones. Asset URLs come from the GitHub releases LIST API
  at click time (`/releases/latest` is a trap: it only serves full
  releases, and every CardMirror release is a pre-release), matched by
  extension + arch marker so version-stamped filenames and
  .blockmap/.yml siblings can't confuse it; any failure opens the
  releases page. Navigation uses the anchor-click pattern (reliable in
  installed-PWA windows where `window.open` can be blocked).

- **Web app rehosted: GitHub Pages → Cloudflare Workers static assets at
  `cardmirror.app`** (new `wrangler.jsonc` + `.node-version`;
  `vite.config.ts` base default now `/`; `web-redirect/`;
  `deploy-pages.yml` repurposed). Cloudflare's Git integration builds
  (`VITE_BASE=/ npm run build`) and deploys (`npx wrangler deploy`) on
  every push to main; assets-only Worker (no script), SPA not-found
  handling, requests free. The old Pages URL serves a redirect stub that
  preserves deep paths, PLUS a self-destructing service worker — the old
  PWA's autoUpdate fetches sw.js on launch, and without a cache-clearing
  replacement, installed apps would serve the stale offline copy forever
  and never see the redirect. Per-origin storage (settings/recents/pins/
  quick cards/learn data) does not transfer between origins; documents
  are on-disk files and are unaffected. Relay features are desktop-only
  (web build is inert) so no relay CORS changes were needed.

- **Save write pipeline hardened** (new `apps/desktop/src/doc-writes.ts`;
  `main.ts`, `error-surface.ts`, `index.ts`; 15 tests in
  `tests/desktop/doc-writes.test.ts`). Field reports showed documents
  renamed or deleted in Finder while open were silently *forked*: the
  old bare `fs.writeFile` recreated the file at the stale path, the ✓
  flashed, and the user ended up with two quietly diverging copies (the
  beta.12 ENOENT rescue only fired when the *folder* was gone). All four
  document-writing IPC handlers now route through a shared pipeline:

  - *Existence check* — in-place saves `stat` first, so a renamed or
    deleted file surfaces as ENOENT and lands in the existing
    "file location not found → Save As…" rescue flow (autosave shows its
    failure toast). The recovery sidebar's in-place save falls through
    to the Save-As modal on the same signal instead of dead-ending.
  - *Changed-on-disk guard* — main records each document's on-disk
    mtime+size after every read and write; an in-place save to a file
    that no longer matches is refused with an `EMODIFIED`-marked error
    (message-marked, like the ENOENT convention, because only the
    message survives the IPC boundary). Save answers it with a
    route-style **Overwrite / Save As… / Cancel** prompt — Overwrite
    retries with `force`. Autosave never forces: it pauses with a
    "changed on disk" toast until the user reviews via Save. This
    closes the silent-clobber path where Dropbox syncs down another
    machine's edit and the next save destroys it — a case where Dropbox
    creates NO conflicted copy, because by write time the remote version
    is just "the file on disk". Unknown paths (e.g. journal recovery
    after a restart) skip the guard; in-app writers that bypass the
    pipeline (`writeSourceAnchor`, bulk compress) refresh the baseline
    so they don't trip false conflicts.
  - *Atomic writes* — documents now stage into a hidden `.cmtmp`
    sibling and rename into place (the crash-journal pattern), with the
    original file's permission bits preserved, so a crash mid-save can't
    tear the document. Previously the user's most valuable bytes were
    the only write in the app WITHOUT this protection.
  - *Per-path serialization* — writes to the same path chain onto each
    other (the `journalWriteTails` pattern), so a manual ⌘S landing
    while an autosave write is in flight can't interleave into a torn
    file.

  The new-speech-doc auto-save (which wrote a brand-new file through
  `saveExisting`) moved to `writeFileAtPath`, since in-place saves now
  require the file to exist.

- **Save-As dialog opens next to the document** (`SaveAsOptions.nearPath`;
  `nearestExistingDir` in `doc-writes.ts`). The OS save dialog used to
  get a bare filename as `defaultPath`, i.e. it opened at the app's
  last-used dialog directory — unrelated to the document, and
  actively unhelpful mid-rescue. The doc save flows (Save As, the
  send-doc/marked-cards dialog fallbacks, the recovery sidebar's
  Save As) now pass the doc's own path; main walks up its ancestor
  chain to the deepest directory that still exists and opens there.
  Intact path → the file's own folder; folder renamed/moved → the
  nearest surviving parent, beside wherever the file went (Word's
  behavior on a stale-path save). Electron-only — the web
  `showSaveFilePicker` has no equivalent for a gone file.

- **Bold-substructure toggle** (`cardNumberingSubBold`, default true;
  `settings.ts`, `numbering-plugin.ts`, tests in
  `numbering-format.test.ts`). Parallel to `cardNumberingSubCapitalized`:
  off adds `.pmd-card-number-sub-plain` (weight 400) to sub glyphs in
  BOTH the editor decorations and the nav-pane rows (shared
  `createNumberGlyph`). The flag joins `numberingDisplaySig` (drives
  NUMBERING_REFRESH + the nav re-render) AND the widget key — same
  lesson as the separator field bug: anything that bakes into the
  render without changing text or position must bust the key, or PM
  reuses the old DOM. Registry `kind: 'toggle'` → the settings row and
  the command-bar Toggle command derive automatically.

  The ON state also FIXES the letters' weight: `.pmd-card-number-sub`
  carried `font-weight: 500` + `opacity: 0.85`, and CSS resolves an
  unavailable 500 DOWNWARD — body fonts with only 400/700 faces (Times
  New Roman) rendered "bold" letters as normal-weight faded text, while
  the number glyph's 600 resolves UP to 700 and looked right (field
  report 2026-07-13). Sub glyphs now carry no weight/opacity overrides
  of their own, inheriting the number glyph's styling exactly.

- **Card numbers in the nav pane** (`nav-panel.ts`; tests in
  `tests/editor/nav-panel-card-numbers.test.ts`). The outline now runs
  the same `computeNumbering` pass as the editor's decoration plugin
  and prefixes each numbered card/analytic_unit's row with the computed
  glyph — same `showCardNumbering` gate, same format/capitalization
  settings (the nav settings subscriber diffs `numberingDisplaySig` so
  a toggle or format change re-renders without a doc edit). Only the
  wrapper's FIRST heading row carries the number (matching the editor's
  tag-line decoration); live-view projection rows are skipped (their
  entries point at the window, not the mirrored cards — cards inside
  linked copies/zones are numbered normally); the glyph always uses the
  numbering color token, since "match heading color" reads editor
  colors that don't apply to nav rows.

- **Nav-pane drop indicators are overlays, not spacers** (`nav-panel.ts`,
  `style.css`). Drop slots used to render as 4px in-flow spacer divs
  between entries, which accumulated down the outline — on a long doc
  the bottom entries visibly jumped at drag start, and an entire
  transform-compensation mechanism existed just to hold the dragged
  item still under the cursor (counting indicators above it and
  `translateY`-ing it back). Indicators are now zero-height anchors:
  no layout space, no shift, and the hovered slot's bar paints via
  `::before` centered on the item boundary (`top: -1px`, z-indexed
  above the item backgrounds). The compensation machinery and its
  drag-end cleanup are deleted; slot hit-testing is untouched (it was
  already geometric — nearest boundary within a 24px band).

- **Edits made while a save is writing no longer marked clean** (new
  `src/editor/save-clean-token.ts`; `index.ts`, `multi-pane-shell.ts`;
  tests in `tests/editor/save-clean-token.test.ts`). Every save is
  async — snapshot, serialize (toDocx can be slow), await the write —
  and all completion paths in both layouts cleared the dirty flag
  unconditionally. Keystrokes landing inside that window were therefore
  marked saved without being in the written bytes: close within the
  next autosave debounce and the save prompt was skipped AND the
  explicit-close path dropped the recovery journal — silent loss. Saves
  now capture the doc's edit generation immediately before serializing
  and only mark clean / clear the journal if it hasn't moved; a moved
  generation leaves the doc dirty for the already-armed autosave/journal
  debounces. The token also pins the DocRecord in multi-pane (a save
  that completes after focus moved can't clear the wrong pane's flag)
  and single-doc swaps bump the generation, so a save of the previous
  doc can't mark its replacement clean. Replaces the
  `notifyFocusedSaved` / `clearFocusedJournal` shell hooks with one
  `captureFocusedCleanToken`.

## 0.1.0-beta.13 — 2026-07-12

- **Global error surface: benign ResizeObserver noise filtered**
  (`error-surface.ts`). Chromium dispatches "ResizeObserver loop
  completed with undelivered notifications" (older wording: "loop limit
  exceeded") as a window `error` event with no `.error` object on
  perfectly healthy launches; the beta.12 last-resort surface toasted it
  as "Something went wrong…". Both wordings are now dropped before the
  console record + toast; a regression test asserts the filter doesn't
  gate real errors behind the throttle.

- **Relay auth architecture activated — enforcement stays off**
  (`pairing-ipc.ts`, new `pairing-entitlement.ts`; 18 tests across
  `tests/desktop/pairing-entitlement.test.ts` +
  `tests/editor/send-outcome-toast.test.ts`). The account-entitlement
  flow built dormant in beta.7 no longer hides behind the runtime
  `PAIRING_AUTH` env flag (which a packaged, double-clicked app could
  never satisfy — it inherits no shell env): the Debate Decoded account
  row in Settings → Collaboration now shows for every desktop user, and
  a valid stored entitlement is preferred as the Authorization bearer on
  the OFFICIAL relay (which accepts it alongside the shared token while
  ungated — the server has taken entitlement bearers since 5a11a10, so
  adoption accrues with zero enforcement). Custom self-hosted relays
  still always use their own token. The pure decision core — stored-
  state validation, the 60s validity slack, the renew-inside-final-24h
  window, and the full /relay/connect response taxonomy (bind, renewal
  keeping the last-known email past a fail-open lookup, seat-limit
  confirm flow with retryCode, visible eviction, badCode / lapsed /
  unsupported) — moved to `pairing-entitlement.ts` where it's unit-
  tested. Send declines are now surfaced: the main process counts
  per-recipient 401/403s separately (`authFail` on the send IPC), and
  both the send pill and Send-to-Starred use one shared toast builder
  (`sendOutcomeToast`) that names the fix — account or self-hosted
  relay, never "subscription" — instead of "couldn't reach"; inert
  while the relay is ungated. Every user-facing auth surface (settings
  row + description, connect errors, eviction toast, card-sharing 401,
  co-editing session-start/mid-session 401s) now states that linking is
  OPTIONAL during the beta and gates nothing. Future gating flip is
  server-config only (webhooks + `RELAY_GATING`), per the runbook.
  Field-test follow-ups (first real pairing, 2026-07-12): the connected
  status line no longer shows the entitlement's expiry date — it read as
  a disconnection deadline when the credential auto-rotates (now "stays
  linked; the app re-authorizes itself automatically"); the row carries
  a real **Open the connect page** link (`buildDocLink` → external
  browser) instead of a retype-me URL; the label is "Debate Decoded
  account (optional in beta)"; and a lapsed membership is now visible —
  main tracks a `membershipLapsed` flag (pure transition `nextLapsedFlag`
  in pairing-entitlement.ts: 403 sets, success/eviction clears, other
  failures leave it), reports it through `accountStatus()`/entitlement
  broadcasts, and the settings row appends an inactive-membership notice
  (previously the `lapsed` broadcast existed but nothing displayed it).
  The connected state was also cleaned up to follow the app's
  left-field / right-button row: once linked, the helper line,
  connect-page link, code box, and Connect button hide, and the controls
  row instead holds a green-check "Connected as <email>" confirmation on
  the left (where the input was) with Disconnect at the right edge (where
  Connect was); the disconnected state restores the input + Connect, and
  the inactive-membership notice is its own line below the row in either
  state.

- **LLM client hardening** (`llm.ts`; 24 tests in
  `tests/editor/llm-errors.test.ts`). Both providers now share a failure
  envelope beyond the kind-tagged `LlmError`s: (1) ONE automatic retry on
  transient statuses — 429 (honoring `retry-after` up to 8 s; longer waits
  surface immediately rather than stalling an interactive action), 408, and
  5xx including Anthropic's 529 "overloaded", which also gets a friendly
  message; (2) a 5-minute `AbortController` timeout on every request so a
  hung connection can't spin the AI activity pill forever (timeouts and
  connection failures both read as `'network'`); (3) sampling-param
  compatibility — the newest Claude models reject `temperature` with a 400
  naming the parameter (directly and passed through OpenRouter), so the
  client strips it and retries once instead of failing, and such 400s are
  excluded from the retired-model heuristic (their messages contain
  "model", which previously would have misdiagnosed them as a retired id
  and told the user to "set a newer model" they'd just set); (4) safety
  declines become `'refusal'`-kind errors that explain themselves —
  Anthropic's `stop_reason: 'refusal'` (checked before the empty-content
  fallback, and a refusal-cut partial is never passed off as an answer),
  OpenRouter moderation 403s (surfacing `metadata.reasons` +
  `provider_name`), and `finish_reason: 'content_filter'`; (5) OpenRouter
  402 gets a first-class out-of-credits message, and failures OpenRouter
  embeds in an HTTP 200 (top-level `error` envelope, `finish_reason:
  'error'`) throw instead of parsing as an empty/truncated reply; (6)
  Anthropic 403 maps to `'auth'` with a message naming the key. Callers
  are untouched — everyone still toasts `e.message`. Test seams:
  `llmSleep.wait` (stubbed pause) and exported `transientRetryDelayMs`.

- **OpenRouter as a second AI provider** (PR #13, thanks to
  [Shreeram Modi](https://github.com/shreerammodi); `anthropic.ts` →
  `llm.ts`). All nine AI call sites now go through one `callLlm`
  dispatcher keyed on the `aiProvider` setting. The Anthropic path is the
  previous client unchanged (same headers, same error kinds, same
  friendly retired-model message). The OpenRouter path speaks the
  OpenAI-compatible chat API: system prompts become a leading `system`
  message, base64 image blocks become data-URL `image_url` parts, and
  `finish_reason: "length"` maps onto the existing `max_tokens`
  truncation contract so downstream repair passes keep working. New
  settings: `aiProvider`, `openrouterApiKey` (secret — stripped from
  settings exports like the other keys), `openrouterModel` (required, no
  default), and `aiMaxTokens` (shared output budget for features without
  their own; floor 1024, default 4096 — reasoning models spend hidden
  thinking tokens from the same budget). `dependsOn` in the settings
  registry generalized from a bare key to a `SettingCondition`
  (key | {key, equals} | array) so provider-specific fields show only
  under their provider. Translate's AI backend follows the provider
  (marker: `[TRANSLATION BY OPENROUTER]`); PRIVACY §5/§10 and TERMS §5
  updated for the new recipient.

- **Custom autocorrections + engine decorator phase** (new
  `custom-autocorrect-plugin.ts`; `autocorrect.ts` gains decorators +
  shared `marksAreUniform`/`WORD_COMMIT_DELIMITER`; settings
  `customAutocorrectEnabled` + `customAutocorrects` table (sanitized:
  whitespace-free keys ≤64, values ≤256, ≤200 rows, case-insensitive
  dedupe); table widget in settings-ui (kind `customAutocorrect`); 20
  tests in `tests/editor/custom-autocorrect.test.ts`). Commit-time
  replacement: suffix match against the entry table at the delimiter,
  longest key wins, boundaries per key shape (word-led keys need a word
  boundary; punctuation-led keys refuse inside a run of their lead char),
  case adaptation for lowercase keys (First-cap/ALL-CAPS; other mixed
  refuses), atoms break matching, mixed-mark sequences skip. Scope:
  everywhere (an expansion is explicit intent — unlike autocap). CLASH
  DESIGN: deterministic priority (registration order: quotes → dash →
  custom → autocap; first match wins; conversions are atomic and output
  is never re-fed, so no cascades); `entryConflictWarnings` statically
  detects UNREACHABLE entries (keys containing straight quotes under
  smart quotes, or the active dash trigger's hyphen run) → per-row ⚠ in
  the table; duplicate keys are REFUSED at add time with an inline error
  naming the existing entry (user requirement). COMPOSITION: engine
  decorator phase — decorators may adjust only `insert`, `revertTo`
  stays the typed literal; `autoCapitalizeDecorator` capitalizes an
  expansion's leading word under the standalone rule's exact conditions
  (fwk → Framework at a tag's sentence start), and one Backspace unwinds
  replacement + capitalization together. Runtime clash tests enact the
  motivating scenario both ways: dash-trigger `--` beats the `--`→`---`
  entry deterministically (entry unreachable, warned in UI); trigger
  `---` coexists with it; the entry's output never cascades.

- **Auto-capitalization for tags/analytics** (new
  `auto-capitalize-plugin.ts` — the third rule on the shared autocorrect
  engine; `settings.ts`, registration in `index.ts`, MANUAL typing-aids +
  settings sections; 39 tests in `tests/editor/auto-capitalize.test.ts`).
  Word-style commit-time capitalization: fires on the delimiter (space or
  `. , ; : ! ?`) that finishes a word, never while typing it. SCOPE is
  tags/analytics ONLY (user decision: card bodies/cites/paragraphs are
  source excerpts whose casing must be preserved verbatim — the inverse of
  Word's apply-everywhere). Decision logic is a pure exported function
  (`capitalizationFor`, the curlFor pattern) over the textblock's
  before-caret text with atoms encoded as U+FFFC: sentence start = block
  start or `.!?` terminator, with closers (`)]}"'"`) allowed between
  terminator and gap; a `.` is NOT a terminator after a single letter
  (initials, `e.g.`/`U.S.` middles), a known abbreviation (~40-entry
  built-in set incl. cite vocabulary and months), or another `.`
  (ellipses); no-whitespace-after-`.` (URLs/decimals) never fires;
  standalone `i` → `I` anywhere except after `(` (enumeration markers);
  atoms are opaque non-context. Words with NON-uniform marks are skipped —
  the whole-word replacement inherits marksAcross, which would collapse a
  partially-marked word's marking (uniformly-marked words round-trip, with
  the delimiter inheriting the word's marks exactly like default typing).
  Engine gives Backspace-revert (restores lowercase word + delimiter) and
  the noise-immune revert window for free. Deliberate v1 limits: Enter
  doesn't commit a word (keydown, not text input); quote characters aren't
  delimiters (smart-quotes owns them; rule composition is a future engine
  feature); pasted text untouched. The abbreviation list is built-in for
  now — user-editable exceptions belong to the planned custom-autocorrects
  settings table.

- **Shared autocorrect engine** (new `autocorrect.ts`;
  `smart-quotes-plugin.ts` and `custom-dash-plugin.ts` rebuilt on it; tests
  in `tests/editor/autocorrect.test.ts`). Review finding (2026-07-13): the
  two plugins were line-for-line clones of the same pattern — a
  handleTextInput trigger, a meta-tracked one-shot Backspace-revert window,
  and a handleKeyDown revert with cursor/content safety checks. Extracted
  `makeAutocorrectPlugin(key, rules)` with a rule interface (triggers /
  enabled / match → {replaceFrom, insert, revertTo}) explicitly shaped for
  the two PLANNED consumers: user-defined text replacements and
  auto-capitalization (multi-rule engines supported; first enabled match
  wins). Both existing plugins keep their public exports (keys, curlFor,
  dashOutput, factories) and registration. Fixes folded into the engine:
  (1) the revert window now ends on docChanged/selectionSet instead of ANY
  transaction — meta-only background traffic (collab cursor leases,
  spellcheck results, numbering refreshes) no longer kills it, and the
  stored positions remain valid by construction since meta-only
  transactions move nothing; (2) the revert compares against the inserted
  string captured at conversion time (the dash revert used to compare
  against the CURRENT dashOutput(), which a mid-window settings change
  could invalidate — it now also restores the conversion-time trigger);
  (3) quotes: a preceding inline atom (footnote marker) is closing
  context — textBetween yields '' for atoms, which fell into the
  block-start=opening branch; (4) the `---` trigger gained `--`'s
  hyphen-run guard. Equivalence: existing suites (33 tests) pass
  unchanged; new table test drives 23 contexts × both quote chars and 23
  contexts × both dash triggers against reference implementations of the
  OLD decision logic — identical outcomes except the run-guard delta,
  asserted explicitly with proof the old behavior differed.

- **Numbering widget keys: position component dropped** (perf audit A-02
  follow-up; `numbering-plugin.ts`, tests in `numbering-fastpath.test.ts`).
  Widget keys were `cnum:<cardPos>:<kind>:<glyph>:<color>` — but PM only
  compares keys between widgets aligned at the same position, so the
  position added nothing for disambiguation while guaranteeing that every
  structural rebuild recreated the DOM of every downstream glyph (shifted
  positions → new keys → eq false), even when every glyph read the same.
  Verified before changing: nothing in src/ reads `spec.key` (the only
  consumer is prosemirror-view's one-line equality check), and nothing
  outside the plugin reads its state (docx export numbers independently).
  Keys are now `cnum:<kind>:<glyph>:<color>` — the stale-glyph protection
  (rendered glyph + color mode in the key, field bug 2026-07-11) is
  untouched. New DOM-level tests: inserting an unnumbered card at the top
  (structural rebuild, all positions shift, all glyphs unchanged) preserves
  the number spans; inserting a numbered card re-renders the glyphs that
  actually change. The map-vs-rebuild test probe (which had exploited the
  position drift) is replaced by an exported build counter
  (`numberingPerfProbe`) — decoration/DOM identity can no longer
  distinguish the paths, which is the point.

- **Numbering fast path** (perf audit A-02 tier 2; `numbering-plugin.ts`;
  comprehensive suite in `tests/editor/numbering-fastpath.test.ts`).
  apply() rebuilt the full DecorationSet on every doc-changing transaction.
  Now, with the display on: NUMBERING_REFRESH → build; match-heading-color
  ON → always build (a plain text edit inside a colored tag changes the
  glyph's color input without touching labels — untrackable cheaply, so
  that mode keeps pre-change behavior); `isStructuralTr` (conservative
  step classification: mark steps pass except none needed — color handled
  above; Replace/ReplaceAround steps pass iff their inserted slice
  contains no card/analytic_unit/heading/zone/view; ANY other step type —
  attr steps carry numRole/numRestart — rebuilds); surviving transactions
  recompute the label signature via computeNumbering (O(top-level
  children) — it never descends into card content) and compare: unchanged
  → `DecorationSet.map`, changed → build. Deletions of numbered cards are
  caught by the signature; moves carry the card in their insert slice;
  restart-badge flips with identical labels (first-card-in-scope edge) are
  attr steps → structural. Measured through the real plugin at 2,000
  cards: 5.99 → 0.18 ms per keystroke (33x). Accepted cosmetic: mapped
  widget keys keep their build-time positions, so the NEXT structural
  rebuild re-creates glyph DOM that pure position-shifts would have reused
  (the key-scheme change that avoids this was deliberately deferred).
  Tests: per-edit equivalence vs a from-scratch build across every
  structure kind (typing in body/tag/cite/undertag/analytic/paragraph/
  heading/zone-inner/view-inner; insertion+deletion of every top-level
  kind incl. zones and live views; card move; real toggle commands;
  restart-badge-with-identical-labels; undo/redo; mixed multi-step
  transactions; match-heading rebuilds), a map-not-rebuild fingerprint
  (mapped keys drift from positions), and a 120-op seeded random soup
  with equivalence asserted after every op.

- **Numbering display-off gate** (perf audit A-02 tier 1;
  `numbering-plugin.ts`, `index.ts`, `multi-pane-shell.ts`; tests in
  `numbering-live-update.test.ts`). build() ran on EVERY doc-changing
  transaction regardless of `showCardNumbering` — the props-level gate only
  hid the result, so display-off docs still paid the full
  O(numbered cards × top-level children) rebuild per keystroke (~5.5 ms
  measured at 2,000 cards). build()/apply() now early-return an empty state
  while the display is off (the off-flip's refresh drops the stale set).
  Correctness of the on-flip: `numberingDisplaySig` moved into the plugin
  module and is now diffed by BOTH settings subscribers — single-doc
  index.ts nudges the focused view (as before), and the multi-pane shell
  broadcasts NUMBERING_REFRESH to every pane stack's views including hidden
  stacked docs (new — previously those healed via the rebuild-per-keystroke
  behavior this gate removes). The fast-path tier (structural-transaction
  classification) lands separately with its own equivalence suite.

- **Selection-chrome: relevance gate + frame coalescing + fused walk**
  (perf audit A-01, the 2026-07-01 audit's open P-4; new
  `selection-chrome.ts`; `index.ts`, `numbering-commands.ts`; property
  tests in `tests/editor/selection-chrome.test.ts`). dispatchTransaction
  ran four chrome refreshers unconditionally on EVERY transaction; with a
  range selection three did O(selection) work (font-size nodesBetween,
  rangeHasMark per mark button, numbering-units nodesBetween), and
  multi-pane's per-transaction setActiveView ran all four AGAIN.
  Drag-select dispatches a selection transaction per pointermove
  (~60-125/s). Now: (1) GATE — refresh only when doc, selection, or
  storedMarks changed (complete: the readouts are pure functions of those
  + settings, and settings changes keep their own direct refresh calls —
  which now also include refreshFormattingPanelButtonStates, fixing a
  re-show sync gap); meta-only ticks (spellcheck, comments GC, collab
  leases) skip entirely. (2) COALESCE — one requestAnimationFrame flush
  reads view.state at frame time; a burst of drag transactions costs one
  refresh, and setActiveView routes through the same scheduler so
  three-pane stops double-paying. (3) FUSE — computeSelectionChrome
  answers font uniformity + mark presence (early-exit once all found) +
  numbering units in one dependency-injected walk; consumers keep their
  O(1) empty-selection paths; numberingSelectionState accepts precomputed
  units; numbering buttons skip DOM writes when unchanged; the mark
  computation is skipped when the formatting panel is hidden. HONEST
  NUMBERS (1,920-card doc, whole-doc selection, 115k text runs): per
  refresh the fusion is ~parity in the realistic case (3.08 → 3.13 ms —
  prosemirror's rangeHasMark stops DESCENDING after a hit, so
  present-mark queries were already cheap; the audit's 3-walk cost is the
  absent-mark case, where fused wins 7.07 → 6.18 ms). The structural
  wins dominate: during drag-select at ~100 tx/s, main-thread chrome time
  drops ~308 → ~188 ms/s (worst case ~707 → ~371), three-pane halves
  again on top (no double-run), and idle/meta transactions go to zero.
  Behavior: property test (60 random docs × 8 selections) pins fused ≡
  the three naive references; readouts land ≤1 frame later.

- **Section-boundary family: flat sibling scans replace O(rest of doc)
  walks** (perf audit A-12/A-13/A-14/A-49; `headings.ts`,
  `speech-doc-send.ts`, `drag-editor-surface.ts`, `word-selection-keymap.ts`,
  `move-container.ts`; tests in `tests/editor/section-boundaries.test.ts` +
  new PageUp/PageDown suite in `word-selection-keymap.test.ts`). Four sites
  answered "where does this section end?" with
  `doc.nodesBetween(headingEnd, doc.content.size, …)` — which can neither
  stop at the boundary (nodesBetween has no abort; returning false only
  skips descent) nor avoid descending into every text run before it. New
  `sectionEndFromHeading(parent, headingIndex, headingEndPos, level)` in
  headings.ts type-checks SIBLINGS only. Call sites: computeHeadingRange's
  pocket/hat/block branch; enclosingStructureRange (send/select/copy/
  delete-current-heading); findContainerAt's heading branch (per-pointermove
  pickup-drag hover); collectHeadingPositions gets `return !node.isTextblock`
  (headings can't nest in a textblock); move-container's grabbedHeading
  (collectHeadings + a per-entry O(doc) scan for EVERY heading, per
  keypress) is deleted in favor of the existing flat `unitRangeAtPos`, with
  an explicit zone/view no-op check replacing the old
  reject-via-alignment-guard path. Measured (1,920-card doc, fragmented
  ~60-run bodies, equivalence-checked identical outputs): move-container
  grab 64.96 ms → 0.0005 ms per keypress; section end (worst-case first
  pocket) 0.432 ms → 0.006 ms (72x); heading collection 3.42 ms → 0.198 ms
  (17x). Two latent bugs fixed BY CONSTRUCTION and pinned by tests: the old
  computeHeadingRange scan guarded zones but not live views, so a mirrored
  heading inside a `self_ref` truncated the enclosing section; the
  send-current-heading scan had NO opacity guard at all, so zone innards
  truncated its sections too. Semantic delta (tested): zone-INNER headings
  now get ranges bounded to their zone instead of escaping into the host
  doc. Property test: 40 seeded random docs, every top-level heading,
  new ≡ old reference scan byte-identically; PageUp/PageDown destination
  parity incl. zone/view innards remaining navigation stops.

- **Regression tests for the hardening rounds + a real bug they caught**
  (`error-surface.ts`, new `tests/editor/error-surface.test.ts`, additions
  to `tests/editor/speech-send-insert.test.ts`). `isFileGoneError` moved
  from index.ts into error-surface.ts (exported, testable) — and its first
  test caught a production bug: the guard was `err instanceof Error`, but
  DOMException doesn't inherit from Error in every runtime, so the web FS
  Access `NotFoundError` case — one of the two cases the helper exists
  for — could fail to classify. Now shape-checked (name/message on any
  object). Tests: ENOENT raw + IPC-wrapped, NotFoundError, negative cases
  (EACCES, NotAllowedError, non-Errors); global error surface (uncaught
  error → console + toast, throttle collapses a storm to one toast then
  re-arms, unhandledrejection event handled without throwing); speech
  insert failure mode (dispatch throws inside the 0 ms defer → alert with
  the reason, card not silently lost) and destroyed-view no-op. The
  index.ts app-shell wrappers (save flows, close/quit, mode switch,
  recovery) remain untestable as units — index.ts has top-level boot side
  effects; covered by the tested chokepoints + global hooks instead.

- **Fail-safe hardening round 3: speech insert, close-to-home, pane close**
  (`speech-doc-send.ts`, `index.ts`, `multi-pane-shell.ts`). Swept the
  remaining high-sensitivity entry points for the invisible-exception class.
  (1) `insertSpeechSlice` runs its ENTIRE insert in a 0 ms `setTimeout` —
  no caller try/catch can reach a throw there, and on a cross-window send
  the sender is told "delivered" before the receiving window inserts: a
  mid-round throw = card silently lost. The deferred body is now wrapped —
  failure alerts in the receiving window ("Couldn't insert the card into
  the speech document: …"). Covers every caller at the chokepoint: tilde
  send, palette insert, dropzone pull, and both cross-window transports.
  (2) `handleCloseDocToHome` (Home button) and (3) multi-pane
  `closeVisible` (pane ✕, stack closes, quit sweep) get the same
  never-reject wrapper as the save flows: crash → alert + "didn't close"
  (false), doc stays open. AUDITED-CLEAN, no change needed: mode-switch
  window coordination on both platforms (web `handlePleaseClose` catches
  journaling failures + initiator has REPORT_CAP_MS; Electron main
  destroys hung windows after a 10 s timeout and the renderer handler
  try/catches journaling and closes regardless), and the send-side
  transports (deserialize failures caught; web acks gate a 600 ms
  "isn't open in any tab" alert).

- **Fail-safe hardening: close/quit, mode switch, startup recovery**
  (`index.ts`). Follow-up to the error-surfacing pass — these three flows
  needed to fail SAFE, not just loud, because their half-completed state is
  itself the damage. (1) `handleUserCloseRequest` (the `host:close-request`
  handler): every path must end in `closeSelf()` or `cancelClose()`; an
  escaped throw ran neither, leaving a pending macOS quit waiting forever.
  Now wrapped — crash alerts and cancels the close (window stays open,
  nothing lost). (2) `handleModeSwitch`: only the journaling middle was
  guarded; a throw before it (confirm dialog, session-count bridge) or at
  the marker write left `modeSwitchInFlight` stuck true — every later
  toggle a silent no-op for the session, with the setting flipped but no
  switch. Outer wrapper reverts the setting and unsticks the guard.
  (3) `runStartupRecovery`: scan layers were already per-entry guarded
  (main skips corrupt journals; multi-doc reopen guarded per doc), but the
  single-doc mode-switch branch's WINNER reopen was not — one unreadable
  journal stranded every other healthy doc behind it; and all reopen
  failures were console-only. Winner now guarded (spawn loop proceeds),
  the whole flow wrapped (crash → toast; journals persist so the offer
  defers to next launch), and every per-doc reopen failure now toasts
  naming the document.

- **Error-surfacing hardening: no invisible failures** (new
  `error-surface.ts`; `index.ts`, `multi-pane-shell.ts`). Field bug
  2026-07-12: a user's Save, Save As, AND autosave all did literally
  nothing — no dialog, no pulse, no error. Recording analysis showed the
  app's architecture made that possible: (1) save entries are
  fire-and-forget (`void runSaveFlow()`) and the renderer had NO
  unhandledrejection/error hooks, so an exception thrown before the flows'
  internal try blocks vanished without UI; (2) the debounce chains
  (`autosaveChain`/`journalWriteChain` + the per-record multi-pane
  equivalents) link with bare `.then()`, and each runner's guard lines
  (`settings.get`/`activeFile`/`getHost`) execute BEFORE its internal try —
  one throw rejected the chain and every later `.then` silently skipped:
  autosave/journaling dead for the session while the button stayed lit;
  (3) the close prompt's `await runSaveFlow()` rethrow silently aborted
  the close. Fixes: `runSaveFlow`/`runSaveAsFlow` wrapped in never-reject
  outer try/catch (crash → explicit alertDialog + `false`, covering every
  call site: buttons, keybindings, close/quit prompts, both layouts); all
  four debounce chains get `.catch` links (autosave crashes route into
  `reportAutosaveFailure`, journal crashes to console) so chains stay
  FULFILLED and self-heal next attempt; `installGlobalErrorSurface()`
  installed before any boot wiring — console.error with full details plus
  a 10s-throttled toast for unhandled rejections/uncaught errors.
  Diagnosis note: fresh-per-click manual saves failing repeatedly implies
  a DETERMINISTIC thrower in the user's session (awaiting her console
  output); the poisoned-chain fix addresses the one-off case.

- **Stale-path save rescue + loud autosave failures** (`index.ts`,
  `multi-pane-shell.ts`, `style.css`). Field bugs 2026-07-11 (two reports,
  same root cause — a shared Dropbox folder rename left open docs with
  stale absolute paths): (1) `host:save-existing` is a bare `fs.writeFile`,
  so a renamed parent folder = ENOENT; `runSaveFlow`'s catch showed the raw
  error and returned false, which the close flow treats as "abort close" —
  a doc whose folder moved could not be closed via Save. (2) Autosave
  failures were `console.warn`-only, so with autosave on the user believed
  the doc was saved while every write bounced; the close prompt's
  "unsaved changes" then looked like a false positive. Fixes: new
  `isFileGoneError` (ENOENT via Electron IPC message / `NotFoundError`
  DOMException from the web FS Access API) → `runSaveFlow` catch offers a
  confirmDialog rescue ("File location not found" → **Save As…**), which
  also serves every close/quit prompt since they all route through
  `runSaveFlow`. New `reportAutosaveFailure`/`reportAutosaveSuccess`
  (exported; wired into BOTH autosave paths — single-doc
  `runAutosaveAttempt` and multi-pane `runAutosaveForRecord`): one toast
  per failure streak, `data-autosave-error` attr on the ribbon button
  (solid `--pmd-c-error` outline vs the inert state's dashed warning —
  shape channel preserved for colorblind users; dark-theme error tokens
  already existed), tooltip suffix while failing. Cleared by any
  successful save, including the Save As rescue (`commitSaveResult`).
  Recents were already self-healing (`openRecentInPlace` prunes dead
  paths with a toast; `commitSaveResult` records the new handle), so no
  recents work was needed.

## 0.1.0-beta.12 — 2026-07-10

Co-editing bug-fix release, driven by a multi-agent audit of the collaboration
workflow (three-pane focus) plus field reports. The root class behind the
three-pane failures: the invite-join and session-resume flows always ran the
SINGLE-PANE `collabDeps` (module-singleton registrations in `collab-hooks.ts`),
whose `newSessionDoc` (`replaceWithSessionDoc`) bails `false` under
`multiDocActive` and whose `spawnJoinWindow` gates on `isPristineStarter` —
single-pane module state that is stale garbage in the workspace.

- **Three-pane invite accept: slot-picker session docs** (`multi-pane-shell.ts`
  `createSessionDocIntoSlot`/`setFilenameForUid`, `index.ts`
  `makeMultiPaneSessionDeps`, `collab/collab-ui.ts`). Joining in the workspace
  now creates a fresh unsaved doc in a user-picked slot (the same slot picker
  as Open) and binds the session to THAT doc's uid — the per-uid deps pattern
  the mode-switch auto-resume already used. Previously the single-pane deps
  either (K1) streamed the room's whole backlog and then bailed with a lying
  "Join cancelled" (`replaceWithSessionDoc`'s `multiDocActive` guard), or (K2,
  once the window had ever saved) spawned a second OS window whose multi-pane
  boot dropped `payload.joinShareCode` on the floor and dead-ended the
  empty-bytes payload in the file-open path ("This file is empty or hasn't
  finished downloading…"). The single-pane deps' `spawnJoinWindow` is now also
  hard-gated on `!multiDocActive`, and `routeInitialDocIntoWorkspace` handles a
  `joinShareCode` payload by running the join through the slot-picker deps —
  belt and suspenders for stale spawn payloads around a mode toggle.
- **Three-pane home-screen resume** (`index.ts` homeCallbacks, ribbon
  `collabJoinSession`, invite joiner registration). All three
  join/resume entry points now pick deps per invocation:
  `multiDocActive ? makeMultiPaneSessionDeps() : collabDeps`. Resuming from the
  Sessions list in the workspace slot-picks like join; before, it always
  failed with "Resume cancelled" through the same `multiDocActive` bail.
- **Invites survive failed joins** (`receive-pill-ui.ts`, `collab-hooks.ts`,
  `collab-ui.ts`). The Receive pill consumed the invite row — and the join flow
  deleted the prefetched offline seed — on CLICK, before the join could
  succeed, so every cancelled slot pick or network failure burned the share
  code and forced a re-invite. `joinSessionWithCode` now returns
  `Promise<boolean>`; the pill removes the row only on `true`, and
  `deletePrefetch` moved after the join commits. A 410 (room ended) still
  reports consumed — a dead invite should clear itself — and purges its seed.
- **Strict join fails on tombstoned rooms** (`collab-session.ts` `catchUp`).
  The 410 branch returned BEFORE the `rethrow` check, so `join()`'s strict
  initial sync silently "succeeded" on an ended/expired room: blank doc,
  "Joined the session" toast, synced chip, and a phantom resumable record
  (audit-confirmed; reachable from any stale invite — the relay idle-GCs
  rooms). Strict syncs now rethrow after `handleEnded()`; steady-state
  catch-ups still swallow. `joinSessionWithCode` skips the offline-seed
  fallback on 410 (an ended room is not an offline condition), and
  `relayFailureMessage` gained a 410 branch ("That co-editing session has
  ended — ask for a fresh invite…").
- **Owner-uid drift fixed at the seam** (`collab-ui.ts` `installSeams`).
  `installSeams` re-read `deps.getOwnerUid()` AFTER each flow's confirm dialog
  and relay round-trip, so a focus change mid-flow registered/bound the
  session onto whatever doc the user had since clicked into (multi-pane; the
  start flow shares doc A's content but would bind to focused doc B). The
  owner uid is now an explicit parameter captured at the moment that fixes the
  target: start = the focused doc when Start was chosen; join/resume = the doc
  `newSessionDoc()` just created.
- **HTML-response guard in the rooms transport** (`room-client.ts`
  `readJson`). Field bug (issue #11): a Securly school-content-filter agent
  intercepted the renderer's `/relay/rooms/*` GETs with a 302 → HTML block
  page (the desktop mailbox traffic runs in the main process and sails past
  the PAC proxy, which is why card sharing worked while co-editing failed
  with `Unexpected token '<', "<!DOCTYPE"…`). Every rooms-REST `res.json()`
  now reads the body as text first and, on a parse failure, throws a
  `RoomsError` naming the URL and classifying the payload ("returned a web
  page instead of session data … a proxy, content filter, or wrong relay URL
  is likely intercepting"). Regression tests: HTML-interceptor response in
  `room-client.test.ts`, tombstoned-room join in `collab-session.test.ts`.
- **Message fixes** (`collab-ui.ts`): the initiating-401 relay toast pointed
  at "Settings → Card Sharing" (pane renamed in beta.11) — now
  "Collaboration"; `guardReady`'s no-view toast said co-editing "needs a
  single-document window" (a lie in three-pane, which supports several
  sessions) — now "Open and focus a document to start a co-editing session,"
  and join/resume no longer require an up-front view at all (an empty
  workspace can join straight into a slot).
- **Home-screen Recents/Sessions spawn a new window over an open doc**
  (`index.ts` openRecentInPlace + homeCallbacks.resumeSession,
  `host/types.ts` + `apps/desktop/src/{main,preload}.ts`). Reaching the home
  screen via the Home button and clicking a recent (or a session) loaded
  in-place — which fails/evicts when this window already holds a real doc.
  Single-pane now spawns: recents ship the read file as a normal spawn
  payload; sessions use a new `resumeRoomId` spawn field mirroring
  `joinShareCode` (blank starter in the new window, then the full resume runs
  there — `mountResumedSession`). The pristine starter (home at launch) still
  loads in place, and multi-pane keeps its slot-picker routing; the
  multi-pane boot also handles a stray `resumeRoomId` payload via the
  slot-picker deps instead of the empty-file dead end.

- **Native-dialog extermination: the untypeable-editor class closed**
  (`text-prompt.ts` + 11 call-site files). Field bug (2026-07-11, tilde with
  no speech doc): Electron's native `window.alert`/`confirm` on Windows/Linux
  never hand keyboard focus back to the webContents on dismiss — mouse events
  work (selection) but keystrokes are dead until a reload. Prior fixes were
  per-site `.focus()` bandaids, which only help on macOS (why the owner could
  never reproduce reports). This pass removes the CLASS: (1) new
  `alertDialog()` / `confirmDialog()` in text-prompt.ts, composed from the
  existing route-dialog vocabulary (overlay + header + choice-detail body +
  accent OK / quiet Cancel; Enter/Esc/overlay-click); (2) every native
  dialog in renderer code replaced — speech-doc-send ×4 (the reported bug),
  index.ts ×23, quick-cards-manage-ui ×9 (close/select now async),
  settings-ui ×7, web-file-tools ×4, voice/controller ×2, flow-port,
  multi-pane-shell, mobile-shell, mobile-settings-ui ×1 each — and the old
  `.focus()` bandaids deleted; (3) centralized focus restore: a new
  `captureFocusForDialog()` records `document.activeElement` at open and
  every dialog helper (including the pre-existing promptForText/Choice/
  RouteChoice and the select-speech-doc modal) restores it on close, so
  in-DOM overlays no longer drop the caret to `<body>` either. Zero native
  alert/confirm/prompt calls remain under src/.
- **Numbering: stale-glyph fix + match-heading color**
  (`numbering-plugin.ts`, `settings.ts`, `settings-ui.ts`, `index.ts`,
  `style.css`; tests in `tests/editor/numbering-live-update.test.ts`). The
  widget decoration key used the RAW label (`1`/`a`) while the separator and
  capitalization bake into the rendered glyph (`1.` vs `1)`), and ProseMirror
  treats same-key widgets as equal — reusing the stale DOM without re-running
  the render fn. So the settings subscriber's NUMBERING_REFRESH rebuilt the
  set, but every widget "matched" and nothing repainted until the visibility
  toggle destroyed/recreated them (field bug, 2026-07-11). The key now
  includes `glyphText(label)` plus the color mode. NEW
  `cardNumberingMatchHeadingColor` setting ("Match heading" checkbox on the
  numbering-color control, which grays the swatch while on): glyphs get
  `.pmd-card-number-match { color: inherit }` — the widget sits inside the
  heading element but outside its text runs' font_color spans, so inherit
  picks up the block color (Analytic-text option, theme, dark mode) — and
  `wholeHeadingFontColor()` detects a single manual font color covering the
  heading's ENTIRE text (000000 = Word "Automatic" never counts; any
  uncolored or differently-colored run breaks uniformity) and applies it
  inline per glyph. The heading-color detection re-runs on every doc change,
  and the color joins the widget key + numberingDisplaySig, so recolors and
  the checkbox both repaint live.
- **Send-to-speech: range selections snap like carets**
  (`speech-doc-send.ts`, regression matrix in
  `tests/editor/speech-send-insert.test.ts`). insertSpeechSlice's
  range-selection branch raw-inserted at `selection.from` — mid-text inside
  whatever the leftover range touched — and `replaceRange` resolved that by
  splitting the host card. The schema requires every card to lead with a
  `tag`, so ProseMirror synthesized empty ones for each split half: the
  field report's "single card F7'd puts 2-3 blank F7 lines after the card"
  (2026-07-11). The branch now routes through `nearestValidInsertPos` like
  the non-blank-caret case directly above it. Family audit: the receive-pill
  insert (`inbox-insert.ts`) and the dropzone (`dropzone-ui.ts`) already
  snapped via `nearestValidInsertPos`; the search palette reuses
  insertSpeechSlice, so tilde / send-to-end / palette / cross-window /
  cross-tab sends are all covered by the one fix.
- **Dialog follow-ups from the sweep's field test** (`style.css`,
  `text-prompt.ts` call sites). (1) `.pmd-route-overlay` gets its own
  z-index (1400, scoped so the other overlay families keep their stacking):
  at the shared 1000, a confirm spawned from the Quick Cards manager
  (z 1200) rendered BEHIND it — invisible, but its Enter/Esc keydown still
  ran, reading as "the manager is stuck until I hit Enter" (the native
  dialogs it replaced were always-on-top, which had masked the layering
  question entirely). Only the toast (2000) and cursor-attached transients
  (drag pill, ribbon tooltip) sit above dialogs now. (2) In button rows,
  `.pmd-route-cancel` matches the accent button's size (the compact
  trailing-link style remains for the route-choice card layout). (3) Plain
  yes/no confirmations converted from single-choice route cards to
  `confirmDialog`'s two equal buttons: start-session, end/leave-session,
  and the mode-switch confirm — route cards are reserved for genuine
  multi-option decisions (Save/Don't-Save, keep/end/leave, End/Forget).
- **Round 3 audit follow-through: transport taxonomy + polish**
  (`collab-session.ts`, `room-client.ts`, `collab-ui.ts`,
  `collab-persist.ts`, `comments-plugin.ts`, `home-screen.ts`, `index.ts`).
  TRANSPORT: mid-session 401/403 now fires a once-per-session
  `onAuthRejected` callback (toast names Settings → Collaboration) and backs
  send-retry off to the 30s ceiling — the silent hot-retry loop was
  indistinguishable from being offline; REST 404 is now terminal-ended like
  the stream already treated it (relay idle-GC deletes rooms outright — 404
  on a known room means expired, and `relayFailureMessage`/join-flow
  consumption handle 404 like 410); a stream 409 (room full) after the REST
  join half-succeeded now tears the session down keep-record with an honest
  toast instead of leaving a dead "offline" doc mounted;
  `RoomStream.restart()` clears a pending backoff timer and reconnects
  immediately (wake-from-sleep served out pre-sleep delays); `catchUp`'s
  `pendingLeft` accumulates across pages (a clean later page cancelled the
  full resync a dirty earlier page requested); both snapshot decrypts are
  guarded like update decrypts (one undecryptable server snapshot wedged
  every subsequent catch-up permanently).
  POLISH: `startSessionFlow` has an in-flight guard per owner uid
  (double-click minted two rooms); a mid-session rename republishes the doc
  title to the room's meta map (excluded `cm-meta` origin) and defeats the
  persist skip-write, so the Sessions list and new joiners see the new name;
  the mode-switch confirm is a route-style dialog (native `window.confirm`
  never returns keyboard focus on Windows/Linux — same class as the
  2026-07-03 field bug); session random comment ids no longer bump the
  window-global sequential counter (the ranges are disjoint below 1,000,000
  by design); the home-screen Sessions row says "saved …" (the timestamp is
  the local persist-write time, not a sync time). Manual §9 documents the
  host-✕ End/Forget choice.
- **Round 2 audit follow-through: comments correctness + chip truthfulness**
  (`collab-comments.ts`, `collab-ui.ts`, `comments-plugin.ts`,
  `comments-ui.ts`, `collab-hooks.ts`, `index.ts`).
  COMMENTS: (1) the session UndoManager tracked the comment-mirror's LoroMap
  writes alongside doc edits, so Ctrl+Z with a comment op on top of the stack
  deleted comments/replies session-wide — comment (and meta/title) commits
  now carry excluded origins (`cm-comments`/`cm-meta`) and installSeams
  passes a pre-configured `UndoManager({excludeOriginPrefixes})` to
  LoroUndoPlugin (regression test: undo unwinds text edits, thread survives
  in plugin state AND the shared map). (2) `sync-load` rebuilt the tombstone
  map exclusively from the shared map, but parking is local-only by design
  (seedFromView shares live threads only; gc is never mirrored) — every
  pre-session parked thread lost its resurrection path on the first pull;
  the tombstone now seeds from prev and refreshes entries present in the
  map. (3) The async AI reply resolved `this.getView()` and `newCommentId()`
  at COMPLETION — landing the reply, with a wrong-mode id, in whichever pane
  had focus when the answer arrived; both are now pinned at initiation, and
  a reply whose thread vanished mid-flight is dropped.
  CHIP: `isChipSession` now delegates to `chipSession()` (they disagreed on
  the sole-session fallback, freezing/ghosting the label while the dots kept
  rendering); a new `refreshChipForFocus` repaints the chip on focus change
  (wired from `setActiveView` via `notifyCollabFocusChange`); Copy Share
  Code / Invite Starred act via a new `actionSession()` — strictly the
  focused doc's session (sole-session fallback only when focus is
  unresolvable), so no more inviting partners into a different doc's
  session. Session-END paths (remote onEnded, endSessionFlow, and
  resolveCoEditedClose's End/Leave-then-Cancel) rebuild the OWNER doc's
  plugin stack via the new `refreshPluginsForUid` dep instead of the
  focused view's.
- **Batch A session-lifecycle hardening (audit follow-through)**
  (`multi-pane-shell.ts`, `collab-persist.ts`, `collab-ui.ts`,
  `collab-hooks.ts`, `index.ts`). Five confirmed audit findings:
  (1) `closeRecord` (stack-dropdown close) routed CLEAN non-visible co-edited
  docs down the raw teardown — no keep/end/leave dialog, view destroyed under
  a live session; they now surface + run `closeVisible` like dirty docs.
  (2) The keep-resumable close awaited `persist.flush()`, but `writeInner`
  swallows storage errors by design — the record could silently fail while
  the close path dropped the recovery journal (the doc's only other copy).
  New `PersistHandle.verifiedFlush()` re-reads the record and checks it
  covers the session's current version; on false the close ABORTS, the
  session reconnects, and the user is told to check disk space. The close
  actions (`collabCloseKeepResumable`/`collabEndOrLeaveSession`) now return
  booleans and `resolveCoEditedClose` maps failures to 'cancel'.
  (3) In-session host End (`endOrLeaveSession`) tore down + deleted the
  record BEFORE tombstoning, and `CollabSession.end()` swallowed the delete
  failure — an offline End reported success while the room lived on.
  Restructured: stop → `endRoomOnRelay` (410/404 = already gone) → teardown;
  on failure the session restarts and the End aborts with a toast (matches
  the home-screen ✕ fix).
  (4) `joinSessionWithCode` now resumes when a persisted record exists for
  the decoded room (unsynced local edits flush to the room) instead of
  minting a second copy whose later Leave deleted the old record;
  `resumeSessionFlow` returns Promise<boolean> and its failure unwind keeps
  the record (`teardownSession(sess, true)`).
  (5) Multi-pane quit explicitly awaits `collabCaptureSessionHandoff()` (the
  all-sessions flush) before `closeSelf` — persistence rode a
  fire-and-forget pagehide write.
- **Cross-window + same-window duplicate guards for home-screen rows**
  (`collab-hooks.ts`, `collab-ui.ts`, `index.ts`). The new-window
  Recents/Sessions flows re-check for duplicates before spawning: recents
  compare against THIS window's open handle (`isSameOpenHandle`; the
  cross-window case was already covered by `openPathCheck`), and sessions
  get a live-room probe (new `collabRoomIsLive` bridge) plus a NEW
  cross-window guard: while a session is live, its window claims
  `cardmirror-collab-room://<roomId>` in the same main-process registry the
  duplicate-file-open guard uses (`openPathRegister` in `installSeams`,
  released in `teardownSession`, stale-cleaned by main on window death), so
  probing focuses the owning window. `resumeSessionFlow` also refuses (and
  reports redundant-success so invite rows clear) when the room is live in
  this or another window. All claim calls are best-effort and tolerate an
  absent openPath API.
- **Host ✕ on the home-screen Sessions list actually ends the session**
  (`home-screen.ts`, `collab-relay.ts` `endRoomOnRelay`). The ✕ only called
  `deleteSessionRecord` — a local IndexedDB delete — for host and participant
  alike, so a host "ending" a session from the home screen left the room live
  on the relay: previously-invited partners could rejoin and keep editing,
  and the host had discarded their only handle for ending it (field bug,
  2026-07-10). Host ✕ now opens a route-style choice — **End Session**
  (tombstone the room via the relay, then delete the record; on relay
  failure the record is KEPT so the host can retry, since deleting without
  the tombstone recreates the silent-rejoin hole) or **Forget My Copy** (the
  old local-only behavior). 410/404 from the relay count as already-ended.
  Participant ✕ is unchanged. Composes with this release's strict-410 join:
  a stale invite to the ended room now reports "That co-editing session has
  ended" and clears itself.
- **Mode-switch: co-edited docs close resumable instead of auto-resuming**
  (`index.ts`, `collab-hooks.ts`, `collab-ui.ts`). The single↔three-pane
  toggle previously captured live sessions to sessionStorage
  (`MODE_SWITCH_SESSIONS_KEY`) and auto-resumed them after the reload
  (`resumePreservedSessions`). Audit-confirmed problems: the binding installed
  over the doc AFTER it reopened editable, silently replacing anything typed
  in the reload gap with the CRDT state; only the toggling window's sessions
  were captured (sessionStorage is per-window), so multi→single restored one
  arbitrary survivor and single→multi stranded other windows' sessions; and
  other windows' co-edited docs reopened as static copies beside their live
  Sessions-list records. New contract via a shared helper
  (`journalForModeSwitchExcludingSessions`) used at all three
  journal-for-switch sites (toggling window, Electron please-close handler,
  web BroadcastChannel coordination): explicitly flush every live session's
  record, journal open docs, then exclude the co-edited ones from the reopen
  marker and delete their journals — they close across the toggle and reopen
  from the Sessions list (which slot-picks in three-pane). The confirm
  dialogs warn when live sessions exist, via a new synchronous
  `collabLiveSessionCount` bridge. `resumeSessionFlow`'s `existingDoc` option
  remains as a caller-less capability.
- **Self-ref section picker rebuilt on the peek pattern** (new
  `self-ref-picker.ts`; old picker + `sectionRange` deleted from
  `self-transclusion-commands.ts`; tests in
  `tests/editor/selfref-picker.test.ts`; spec:
  CardMirror-selfref-picker-spec.md). The old in-document picker for
  Insert Live View / Linked Copy resolved EVERY heading's full section
  content just to decide list eligibility — per heading, a
  `resolveSelfProjection` (which re-ran `collectHeadings` internally, then
  `computeHeadingRange`'s doc scan, then materialized the section as a
  Fragment via `doc.slice`) plus a `sectionRange` (another full
  `collectHeadings`) — O(headings × doc) with allocation, taking seconds on
  tournament master files. The rebuild computes everything from ONE
  `collectHeadings({skipCite:true})` pass: span boundaries via a stack sweep
  over the flat entry list (zone-inner entries are never boundaries,
  mirroring `computeHeadingRange`'s refusal to descend into
  `transclusion_ref`), wrapper extents (tags, analytics in
  analytic_unit/card) from `doc.resolve` geometry — O(doc + headings), no
  Fragments. UI switches from a flat `promptForChoice` list to a
  collapsible leveled outline in the route-dialog vocabulary — disclosure
  triangles (blocks start collapsed past 150 rows), a type-to-filter box
  (matches + their ancestors stay visible; Enter picks the first pickable
  MATCH, not a visible ancestor), arrow-key navigation, and disabled (not
  hidden) ineligible rows so hierarchy stays readable. Two deliberate
  behavior deltas (spec §3.4): the guard interval now includes the heading
  line (cursor ON a heading can no longer pick that section — an immediate
  cycle), and a section whose only content is dead windows is pickable
  (renders an empty window; cycles are still caught at render).
- **Live views visible in read mode again** (`style.css` only). Read mode
  hides all top-level doc children (`.pmd-read-mode .ProseMirror > * {
  display: none }`) and re-shows a whitelist (pocket/hat/block/card/
  analytic_unit/`.pmd-transclusion`). Before the transclusion
  re-architecture (286372f) intra-doc live content was a `transclusion_ref`
  (`.pmd-transclusion`) and rode the zone whitelist; the re-architecture
  introduced `self_ref` / `.pmd-self-ref` without teaching the read-mode
  CSS about it, so top-level live views vanished wholesale. Fix mirrors the
  zone rules: re-show `.pmd-self-ref` + its body (rail kept, like the
  zone's), hide the missing-source note (the glyph is already hidden via
  its shared `pmd-transclusion-glyph-btn` class). The mirrored children are
  real editor content, so the depth-independent card rules and the
  keep/hide text decorations apply inside with no plugin change.
- **Docx-flatten warning counts live views** (`index.ts`). The
  pre-re-architecture `confirmDocxUnlinksZones` counted only
  `transclusion_ref` nodes, so a doc whose only live content was `self_ref`
  live views wrote to `.docx` (flattening them via `flattenSelfRefs` /
  the exporter's `transclusion_ref` unwrap) with no warning. Renamed to
  `confirmDocxDropsLiveLinks`; the count walks both node types (matched
  nodes not descended into) and the message names the mix ("a live view
  and 2 linked copies"). No new call sites needed: every `.docx`-writing
  path funnels through `runSaveFlow` / `runSaveAsFlow` — Save, Save As,
  single-pane close + Electron please-close, three-pane `closeVisible`
  and `promptSaveDirtyForQuit` (each focuses the pane first, so
  `activeFile()` / the counted doc is the closing doc) — and autosave is
  `.cmir`-only by design.

## 0.1.0-beta.11 — 2026-07-10

- **Real-time co-editing — now on by default, per-document** (`collab/collab-ui.ts`,
  `collab/collab-hooks.ts`, `collab/collab-session.ts`, `collab/collab-cursors.ts`,
  `collab/collab-comments.ts`, `collab/collab-persist.ts`, `collab/collab-gate.ts`,
  `multi-pane-shell.ts`, `index.ts`, `text-prompt.ts`, `comments-plugin.ts`,
  `home-screen.ts`, and many `tests/collab` suites). Co-editing ships enabled on
  desktop — the build-time `VITE_COLLAB` / runtime `localStorage['pmd-collab']`
  gate is removed; `collabEnabled()` is now just "desktop host, not browser." The
  session model is fully **per-document**: one window can host N independent
  sessions, one per open doc. A session is keyed by its owning `DocRecord.uid`
  (`CollabPluginSource.ownerUid`), and `collabPluginsFor(targetUid)` hands a
  session's binding plugins only to its own doc's view — so opening a second
  document while a session is live can no longer bind that pane to the session's
  LoroDoc and overwrite it (the multi-pane document-fusion bug, released beta.10).
  The single `active` slot became a `Map<ownerUid, ActiveSession>`; cursors and
  comments bind to the OWNER's view via `getViewForUid`, not the focused one, so
  each doc's collaborators render in its own pane. **Per-slot footer copresence:**
  each pane footer shows its visible doc's session status + presence dots, fed by
  a zero-dependency copresence bridge in `collab-hooks` (provider + change
  notifier) so the always-loaded shell reads session state without importing the
  lazy collab module. **Lifecycle:** closing a co-edited doc is confirmed with a
  session-aware dialog (Close-but-keep-resumable vs End/Leave), closing a pane
  tears down only that doc's session, and per-doc comment-id allocation
  (`setCommentIdSessionResolver`) replaced the window-global toggle so a
  non-co-edited doc open beside a co-edited one keeps clean sequential comment
  ids. **Mode-toggle hand-off:** the single↔three-pane toggle is a full reload, so
  each live session's `{uid, roomId}` is captured + flushed before the reload and
  auto-resumed into the reopened doc (`resumeSessionFlow(…, { existingDoc })`).
  Start / close / end-leave confirmations share the unsaved-changes dialog's
  route-style look with 1/2/3 keys (`promptForRouteChoice`). Also fixed: a shared
  session is named after its OWNER doc (not the whole-window title, which in
  multi-pane joins every open doc with " · "), and a persistence `clear()` race
  where an in-flight write could resurrect a just-deleted session record. The
  feature is shipped as **experimental** — some jank is expected, and users are
  advised to keep independent saved copies rather than treat a session as their
  only copy.

- **Transclusion re-architecture: read-only live views + in-document linked
  copies** (`schema/nodes.ts`, `transclusion.ts`, `transclusion-actions.ts`,
  `transclusion-resolve.ts`, `transclusion-nodeview.ts`, `nav-panel.ts`,
  `paste-plugin.ts`, `drag-controller.ts`, `index.ts`, `style.css`, and many
  tests). The intra-document case was split from the single editable "living zone"
  into two node types. A **live view** is a by-reference, READ-ONLY projection of
  another section of the *same* document — resolved on a shared pass and memoized,
  reflecting source edits live, with nesting + cycles handled. It's rendered as a
  selectable content node (selects like text for send-to-speech; native drag /
  shift-click / manual selection span the projection), gets nav-pane parity, and
  never writes its source. A **linked copy** is the by-value editable snapshot —
  what the old file-backed "live zone" became, now creatable linked to a file OR
  to a section of the current document — and it flattens any embedded live views
  to a flat snapshot on creation. See the divergence indicator entry below for the
  source-changed badge.

- **Automatic card numbering (display-only)** (`numbering.ts` NEW,
  `numbering-plugin.ts` NEW, `numbering-commands.ts` NEW, `docx-numbering.ts` NEW,
  `settings.ts`, `settings-ui.ts`, `index.html`, `style.css`, `docx` export/import,
  tests). Card and sub-part numbers are computed at render time and at `.docx`
  export from a stored skeleton (`numRole` / `numRestart` per card) — the card
  text itself is never mutated. A ribbon numbering cluster (role / sub-role /
  restart / visibility) plus a **Card numbering** settings section: independent
  formats for the number and its substructure, separators (period, hyphen,
  m-dash, n-dash, colon, double/triple hyphen), substructure capitalization, a
  configurable glyph color linked to the accessibility color overrides, and
  separate number vs substructure indents (also display-only). Numbers flow
  through live views and round-trip through `.docx`.

- **Zoom / chrome scale ceiling raised to 300%** (`settings.ts`, `index.ts`,
  `mobile-shell.ts`, `settings-ui.ts`, `multi-pane-shell.ts`, `ribbon-commands.ts`).
  The 200% maximum was raised to 300% and pulled into shared `ZOOM_MIN_PCT` /
  `ZOOM_MAX_PCT` constants that every body-zoom clamp reads (single-doc
  `clampZoom`, multi-pane per-pane zoom, the mobile slider, the default-zoom
  setting) so single- and multi-pane can't drift; chrome (whole-window) scale got
  its own `CHROME_SCALE_MIN_PCT` / `CHROME_SCALE_MAX_PCT` (also 50–300).

- **AI "Thinking…" pill anchored per pane in three-pane** (`ai/thinking-tooltip.ts`).
  The pill's vertical band was computed from the scrolled editor CONTENT box
  (`#editor` / `.pmd-pane-editor`), whose top slides negative as the doc scrolls,
  so an off-top / near-top pill fell back to the ribbon bottom — which in
  multi-pane sits above the pane's doc-name chip, so pills piled onto it. The band
  is now derived from the scroll VIEWPORT (`#app` single-doc, `.pmd-pane-body` per
  pane), whose rect is the visible editor area (starting below the chip); the left
  edge still hugs the content box.

- **Partly-highlighted underline no longer darkens its unhighlighted part**
  (`style.css`). A card underlined across a partly-highlighted span no longer
  tints the un-highlighted portion.

- **Read mode: highlighted text inside a table shows inline** (`style.css`). A
  table is a non-listed card child, so `.pmd-card > *` hid it wholesale in read
  mode, taking any highlighted cell content with it. The read-mode plugin already
  decorates cell paragraphs (`nodesBetween` recurses; `readKeptKind('paragraph')`
  = `highlight`), so the fix is CSS: `display: contents` down the whole table
  structure (`.tableWrapper` → table → tbody → tr → cell → cell `<p>`) removes
  every table box from layout, so the kept runs flow inline like the card body.

- **"Card Sharing" settings → "Collaboration"** (`settings-categories.ts`,
  `settings.ts`, `settings-ui.ts`, and the collab/pairing toasts). The tab and
  the `pairingEnabled` toggle (now **Enable collaboration**) house both card
  sharing and co-editing; the `id: 'pairing'` key is unchanged so stored settings
  don't churn, and "card sharing" stays a search alias. `collabShowCursors` gained
  `dependsOn: 'pairingEnabled'` (+ `electronOnly`) so it greys out when
  collaboration is off, and moved below Blocked senders.

- **Multi-pane ⌘Q prompts to save unsaved panes** (`index.ts`,
  `multi-pane-shell.ts`). `handleUserCloseRequest` only checked the single-doc
  `currentDocDirty`, so a three-pane quit closed the window without prompting for
  unsaved panes (exposed by this release's ⌘Q fix). It now routes through a shell
  `promptSaveAllForQuit` (per-slot `promptSaveDirtyForQuit`) that prompts per
  unsaved doc without closing the panes; a cancel/failed save aborts the quit via
  `cancelClose` and leaves the workspace intact.

- **Live-zone divergence indicator** (`schema/nodes.ts`, `transclusion.ts`,
  `transclusion-actions.ts`, `transclusion-divergence.ts` NEW,
  `transclusion-divergence-plugin.ts` NEW, `transclusion-nodeview.ts`,
  `settings.ts`, `settings-ui.ts`, `style.css`, `index.ts`). A live zone now
  surfaces when its *source* has changed since it was pulled, distinct from
  whether the local copy has been *edited*. The two are separable because the
  existing `source_content_hash` includes the freshly-stamped child ids (so it
  only detects local edits); a new **id-independent** `source_shape_hash` attr
  stores the source's content signature at pull time, and a later read of the
  source is hashed the same way (`idIndependentHash`, nested zones flattened)
  and compared. Zones created before the attr fall back to the mirror's own
  shape when unedited, and are left unflagged when edited (unknowable). Detection
  is read-only: `checkAllZoneDivergence` reads each cross-file zone's source via
  the existing `resolveTransclusion` (desktop-only; self-zones and unreadable
  sources are skipped, never falsely flagged) and returns the diverged zone
  identities. A plugin (`makeTransclusionDivergencePlugin`) holds that set,
  paints a node decoration on each diverged zone, and schedules the check on
  open and on a ~10-minute idle cadence (reset by edits so it lands in a quiet
  moment), never in read mode. The NodeView reads the decoration's `spec.diverged`
  to badge the glyph (a colourblind-safe dot + amended tooltip/aria, surfaced at
  rest so a stale zone is noticeable without hovering) and to add a menu hint. A
  Refresh stamps a `ZONE_REFRESHED_META` so the plugin rechecks promptly and
  clears the badge rather than waiting for the idle cadence. The badge colour is
  a configurable `displayColors.zoneDiverged` Style color (`--pmd-color-zone-
  diverged`), linked across Appearance and Accessibility like the other
  document-text colors.
- **⌘Q now quits on macOS** (`apps/desktop/src/main.ts`,
  `apps/desktop/src/preload.ts`, `src/editor/host/electron-host.ts`,
  `src/editor/index.ts`). The per-window `close` interception always
  `preventDefault()`s so the renderer can confirm unsaved work — which aborts
  the `app.quit()` that ⌘Q (and the app-menu Quit) triggers. The windows then
  close via `host:close-self`, but `window-all-closed` deliberately no-ops on
  darwin, leaving the app alive with no windows so ⌘Q appeared to do nothing. A
  `quitInitiated` flag, set in `before-quit`, now lets `window-all-closed`
  finish the quit once every window has confirmed. A new `host:close-cancelled`
  IPC — called from the renderer when a close-request resolves WITHOUT closing
  (Cancel, or a failed Save / Save As) — clears the flag, so a later ordinary
  window close still keeps the app in the dock per macOS convention rather than
  terminating it. (PR #9, thanks to [Cora](https://github.com/coralynnkc).)
- **Intel Mac build no longer ships without its koffi native binary**
  (`.github/workflows/release.yml`, `.github/workflows/mac-test-build.yml`).
  koffi 3.x delivers its `.node` as per-arch `@koromix/koffi-darwin-<arch>`
  optional dependencies, gated on `cpu`, so a plain `npm ci` installs only the
  runner's arch. The `macos-latest` runners are Apple Silicon, yet
  electron-builder builds BOTH the x64 and arm64 dmgs from that one install —
  so the x64 dmg went out with no koffi binary and threw "Cannot find the
  native Koffi module" on launch. This deterministically broke every Intel Mac
  (and any Apple Silicon Mac running the Intel dmg under Rosetta); the arm64
  dmg was unaffected, which is why most machines were fine. Both mac workflows
  now force-install both `@koromix/koffi-darwin-x64` and `-arm64` at koffi's
  resolved version after the desktop `npm ci` (`--force` bypasses the `cpu`
  guard, `--no-save` keeps the lockfile clean but still records the package in
  the hidden lockfile so electron-builder's dependency collector bundles it),
  so each dmg carries the binary its arch needs.

## 0.1.0-beta.10 — 2026-07-07

- **Live zones (transclusion)** (`schema/nodes.ts`, `transclusion.ts` NEW,
  `transclusion-actions.ts` NEW, `transclusion-nodeview.ts` NEW,
  `transclusion-resolve.ts` NEW, `transclusion-selection-guard.ts` NEW,
  `transclusion-doc-path.ts` NEW, `schema/migrate.ts`, `paste-plugin.ts`,
  `nav-panel.ts`, `drag-controller.ts`, `headings.ts`, `ribbon-commands.ts`,
  `ribbon-groups.ts`, `ribbon-availability.ts`, `quick-card-search-ui.ts`,
  `speech-doc-send.ts`, `confirm-dialog.ts` NEW, `index.ts`, `style.css`, and
  many tests). A `transclusion_ref` block node holds a live-linked, EDITABLE
  snapshot of a section (a heading + its cards) pulled from another file. It's
  `isolating` + `defining` with real block children, so the cached cards are
  edited in place — no unlink-first — while editing ops (backspace, lift,
  fitting) can't cross the boundary. `source_ref` (portable, root- or
  doc-relative) + `source_heading_id` identify the source; `source_content_hash`
  vs the live children drives the "edited" dot. `extractSection` snapshots the
  heading's content (header line excluded for grouping headings; the whole card
  for a tag/analytic); `buildLiveZoneAttrs` is the single create choke point,
  reached from normal file search via Mod-Enter ("⌘↵ transclude"). Rendering is
  a NodeView: a hover/selection-revealed teal rail (a `::before` overlay in the
  card's existing 2px gutter, so a transcluded card sits exactly where a normal
  one would), a rail-head glyph opening a menu (Open source / Refresh from
  source / Re-pick source… / Unlink / Delete), and an "edited" state. The nav
  pane mirrors the rail as a faint `--pmd-c-transclusion` `::before` down the
  transcluded run (start/end caps; offset off the selection accent). Refresh
  (`refreshZoneAtPos`) re-reads the source, re-locates the target by identity
  after the async gap (refusing on duplicate-identity ambiguity), and replaces
  the node with fresh, id-rewritten children; it confirms before discarding
  local edits via the new in-editor `confirm-dialog.ts` (replacing
  `window.confirm`). A live zone drags as one doc-level unit; dropping a zone
  inside another is banned; boundary gestures create headings OUTSIDE the zone
  at its edges; and a new heading inside a zone can't outrank the zone's own top
  heading. Nested zones are flattened on load, create, refresh, and paste
  (`flattenZones`), so a zone's content is always structurally zone-free and
  can't cycle.

- **Live zones from Word (`.docx`) sources via heading-anchor injection**
  (`anchor-docx.ts` NEW, `ooxml/parse.ts`, `import/importer.ts`,
  `import/index.ts`, `quick-card-search-ui.ts`,
  `apps/desktop/src/{main,preload}.ts`). A `.docx` heading carries no stable id,
  so before creating a zone from one CardMirror injects a single `pmd-heading-<uuid>`
  Word bookmark at just that heading (nothing else in the file changes) and
  imports the id back, so the zone can re-locate the section on refresh. A
  containment-checked write IPC (same boundary as the source read) performs the
  surgical byte edit on main; if the anchor can't be written the create declines
  ("Live zone not created — the Word file was left unchanged") rather than mint a
  zone that could never refresh. Only CardMirror-anchored (or CardMirror-exported)
  `.docx` files are refreshable.

- **Empty live zones can't linger as invisible phantoms** (`schema/migrate.ts`,
  `transclusion-selection-guard.ts`, `transclusion-actions.ts`,
  `transclusion-resolve.ts`, `transclusion-nodeview.ts`, `native/index.ts`). A
  zone with no content renders invisibly yet is a real node — counted by refresh
  and re-filled from source. Four defenses: `dropEmptyZones` heals zero-content
  zones on load (beside `flattenNestedZones`); `transclusionEmptyZoneReaper`
  (appendTransaction) removes a zone the moment an edit empties it, riding the
  same history step so one undo restores it; create refuses an empty source
  heading (`empty-section`) and refresh refuses to blank a zone whose source was
  emptied since the last sync (`source-empty`), keeping the cache; and the glyph
  menu's Delete (`deleteZoneAtPos`) removes a zone and its contents outright.
  Verified to converge without divergence or phantoms under Loro co-editing —
  including a zone emptied only by the MERGE of two peers' deletions — since
  loro-prosemirror routes remote updates through the normal dispatch pipeline, so
  the reaper fires on merges too.

- **Live-zone commands + clipboard/read-mode/send fixes** (`ribbon-commands.ts`,
  `ribbon-availability.ts`, `ribbon-groups.ts`, `paste-plugin.ts`, `style.css`,
  `speech-doc-send.ts`, `transclusion.ts`). *Refresh Live Zone* now acts on the
  zone the cursor is IN (not only a node-selected one), mirroring the glyph menu;
  *Refresh All Live Zones* re-pulls every zone bottom-to-top behind one
  confirmation (per-zone edit prompts suppressed), summarizing successes /
  unreachable sources. Copy/paste of part of a zone pastes a PLAIN cached copy
  (no live link travels, and open-depths are corrected so headers keep their
  formatting); keyboard send-to-dropzone works for a selection inside a zone
  (snapped to whole transcluded cards); and read / invisibility mode shows tags,
  cites, and highlighting inside zones (the read-mode allow-list now re-shows the
  zone + body, hiding only its own chrome).

- **Live zones: colorblind-safe state + rebindable rail hue**
  (`transclusion-nodeview.ts`, `settings.ts`, `scripts/gen-icons.mjs`,
  `icons.css`, `icons.ts`, tests). The rail-head glyph now encodes
  synced-vs-edited as SHAPE, not tint alone — an intact chain (`link`) when
  synced, a broken chain (`link-broken`, NEW icon) when the zone differs from
  its source — with the state also on the button's `aria-label`/`title`, so it
  reads without color. `refreshEditedState` swaps the glyph's icon class (works
  in both modern-SVG and classic-glyph skins). The `--pmd-c-transclusion` rail
  hue joins `CUSTOMIZABLE_COLOR_TOKENS` (Annotations group, `customColorOverrides`-
  backed), so colorblind users can rebind it from Settings → Accessibility; one
  override cascades to the editor rail, the nav-pane rail, and the glyph. (A
  `.docx` save still flattens live zones to plain cards — docx has no
  transclusion concept — so the link survives only in `.cmir`.)

- **Tiered file-search ranking + a tie-break setting** (`file-search.ts`,
  `settings.ts`, `settings-ui.ts`, `quick-card-search-ui.ts`, tests). Replaced
  the old rank-by-first-token-`indexOf` with a tiered `matchTier`: exact (0) →
  prefix (1) → word-start (2) → substring (3) → secondary-field-only (4), lower
  wins, ties broken by a caller-supplied comparator. `searchFiles` keys tiers off
  the file NAME and now treats the folder (`dirName(relPath)`) as the secondary
  field, so a folder term matches (ranked at tier 4 below a name hit) — closing
  the old "name-only, path unsearchable" gap. `searchFileObjects` (within-file)
  uses the same ranker with the tag/heading label as primary and the card cite as
  secondary, tie-broken by a stable no-op so same-tier hits keep document order.
  New `fileSearchTiebreak: 'recency' | 'alphabetical'` (default recency) drives
  same-tier file ordering AND the no-query browse list: recency sorts by
  `mtimeMs` desc, alphabetical by name. It's a `CYCLABLE_SETTINGS` entry (so the
  command bar gets a Cycle command for free, electron-gated via the meta) with a
  radio in Settings → Files. Manual pins are still partitioned to the top in the
  caller — unaffected. `startsAtWordBoundary` powers the word-start tier
  (boundary = string start or a non-`[a-z0-9]` char before the token).

- **Timer accepts keypad-style digit entry** (`timer-ui.ts`, tests).
  `parseTimeInput`'s no-colon branch changed from `parseInt(s) * 1000` (raw
  seconds) to keypad/microwave semantics: the last two digits are seconds, the
  rest minutes — `800` → 8:00, `1230` → 12:30. One- or two-digit input is pure
  seconds so it's unchanged (`90` → 1:30, since 90 seconds carry), and a
  seconds part ≥ 60 carries (`870` → 9:10). `MM:SS` is still parsed literally.
  Exported for tests.

- **Opening an un-materialized cloud file no longer dies in the parser**
  (`native/index.ts`, `apps/desktop/src/main.ts`, tests). A Dropbox / iCloud
  "online only" placeholder reads back as 0 bytes, which surfaced as "Not a
  CardMirror file: failed to parse JSON (Unexpected end of JSON input)".
  `parseNative` now special-cases an empty read with an actionable message
  (the file may be an online-only cloud placeholder — make it available offline
  and retry). A new main-process `readDocumentBytes` reads tolerant of
  placeholders: a materialized file returns on the first read; a short/empty
  read is re-tried on a 400 ms interval for up to 20 s (each re-open re-posts
  the provider's fetch) to let an in-flight download finish. Wired into the
  Finder/"Open with", in-app Open dialog, Open Recent, and transclusion
  source-read paths.

- **Unread-after-marker tint + rebindable marker/unread color** (PR #8 by
  @shreerammodi: `mark-unread-plugin.ts` NEW, `index.ts`, `multi-pane-shell.ts`,
  `reading-marker.ts`, `settings.ts`, `style.css`, `transform-for-export.ts`,
  tests; follow-up: `style.css`, `settings.ts`). A default-off
  `markUnreadAfterMarker` toggle decorates every card-body run AFTER a reading
  marker with `.pmd-unread` — a `Decoration` set (display-only, zero cost when
  off, diff-gated rebuild, bounded per card), mirrored into every multi-pane
  slot. On `.docx` export, `transformForExport` reuses the plugin's exact
  `computeUnreadDecorations` walk to bake the same ranges into real `font_color`
  FF0000 runs (so screen and export match, and the two can't drift). A `toggle`
  setting (moved to Appearance → Document typography), so it auto-registers a
  command-bar Toggle. Follow-up: the marker's own red (`READING_MARKER_COLOR`
  FF0000) and the unread tint both resolve from one shared, rebindable color — a
  new `readingMarker` key in `DisplayColors` (a Style color, so the Appearance →
  Style colors picker and the Accessibility → Document-text row stay linked to
  one value, like analytic/undertag). `applyDisplayColors` writes
  `--pmd-user-color-readingMarker`; `--pmd-color-reading-marker` resolves from it
  (theme-invariant, default red). Display-only — the stored mark stays FF0000, so
  export + `isReadingMarkerColor` detection are unchanged; a case-insensitive
  `[data-color="ff0000" i]` rule (plus a dark-theme variant that out-specifies
  the dark-band readability override) recolors the marker on screen in both
  themes. Also renamed the ribbon "Show character styles" setting → "…in ribbon"
  and moved it under Appearance → Formatting panel.

## 0.1.0-beta.9 — 2026-07-07

- **Custom ribbon buttons** (`index.html`, `index.ts`, `settings.ts`,
  `settings-ui.ts`, `setting-commands.ts` NEW, `icons.ts`,
  `scripts/gen-icons.mjs`, `icons.css`, `style.css`,
  `tests/editor/ribbon-custom-buttons.test.ts`). Up to 6 user buttons
  (`ribbonCustomButtons: { command, icon }[]`) in a static `#custom-ribbon-panel`
  to the right of the comments cluster, populated live from settings
  (`renderCustomRibbonButtons`, re-run on the settings subscriber; the whole
  panel hides when none are configured). Inserted at cascade index 2 so it's the
  third panel to hide when the ribbon narrows, and added to the resize-observe
  list so a populate/empty re-runs the cascade. The command picker offers every
  available `RibbonCommandId` PLUS the generated Toggle/Cycle setting commands —
  which aren't ribbon commands, so a new `setting-commands.ts` module models them
  as `toggle:<key>` / `cycle:<key>` ids and runs / labels / enumerates them
  (`runSettingCommand`, `settingCommandLabel`, `settingCommandOptions`); the
  command palette's toggle/cycle activation now shares those helpers. Icons: a
  curated general-purpose set (star, bookmark, flag, bold, italic, underline,
  list, check, heart, trash, copy, download, upload, printer, bell, zap,
  lightbulb, scissors) added to the gen-icons MAP + `IconName` and regenerated
  into `icons.css` (both modern SVG + classic glyph); `CUSTOM_BUTTON_ICONS` is
  the curated picker list.

- **Collab: presence dots on the session chip** (`collab-cursors.ts`,
  `collab-ui.ts`, `style.css`, `tests/collab/collab-cursors.test.ts`). New
  `CursorsHandle.presence()` reads the cursor presence store — self plus
  visible remotes, each with a display name and the deterministic per-peer
  color. The chip renders a dot strip (a text label + dots kept as stable
  children), refreshed on a 3s timer since chip text only updates on
  connection-status changes. Remotes require `collabShowCursors` (default on),
  since presence rides the cursor channel; self is always shown.

- **Collab: accepting an invite opens in a new window** (`host/types.ts`,
  `preload.ts`, `main.ts`, `collab-ui.ts`, `index.ts`,
  `tests/collab/collab-ui-flows.test.ts`). New optional
  `CollabUiDeps.spawnJoinWindow`, checked at the top of `joinSessionWithCode`
  (before the session is created and before the "already in a session" guard):
  index.ts spawns a window when `canSpawnWindow && !isPristineStarter`. A
  `joinShareCode` rides the existing SpawnWindowPayload (passed through main +
  preload opaquely); the spawned window runs the FULL join
  (`mountJoinedSession`) so the session and its Loro binding are born together —
  avoiding the stranded-binding field bug. Pristine-starter / web /
  single-window join in place.

- **Send pill: per-contact "invite to collaborate" button** (`send-pill-ui.ts`,
  `style.css`). Replaced the click-to-invite mode's top header + whole-row
  click with a two-people button on each recipient/group row, revealed only by
  the `pmd-send-invite-mode` class (click-open) so a drag-to-send never shows
  it. The bar gains a hover recolor when it's actually clickable (collab on +
  card sharing on). Receive-pill empty state simplified to "You haven't
  received anything yet."

- **Block senders: recent-senders ledger covers invite senders**
  (`pairing/inbox-store.ts`, `settings-ui.ts`, `tests/editor/pairing.test.ts`).
  A collaboration invite is consumed (deleted from the inbox) on Join, so it
  never lingered to appear as a "recent sender". A persistent localStorage
  ledger (`recentSenders` / `mergeRecentSenders`, deduped by code, cap 10)
  records each arriving item's sender the moment it lands (new `ingest` path),
  before it can be consumed; the Blocked-senders UI drives its recent list from
  the ledger (minus already-blocked) instead of the live inbox.

- **Voice: delete installed dictation models** (`apps/desktop/src/voice/ipc.ts`,
  `preload.ts`, `settings-ui.ts`, `style.css`). Two IPC handlers
  (`host:voice-delete-{base,dictation}-model`) `fs.rmSync` the userData model
  dir — base (~130 MB) and large (~1.8 GB, plus its bundled-Node runtime) —
  refused while a download is in flight, safe while voice runs (the worker
  holds the model in memory). Per-model Delete buttons appear when a model is
  installed; the large model deletion falls voice back to standard, the base
  re-offers download on next start.

- **Command bar can toggle and cycle settings** (`quick-card-search-ui.ts`,
  `settings.ts`, `tests/editor/setting-toggles.test.ts`). Every `kind: 'toggle'`
  setting gets a "Toggle <label>" palette command, and a curated set of enum
  settings (`CYCLABLE_SETTINGS`) gets "Cycle <label>" — both derived at runtime
  from `SETTING_METADATA` (`toggleableSettingMetas` / `cyclableSettings`) rather
  than hand-registered, so the list tracks the registry with no upkeep.
  Deliberately NOT modeled as ribbon commands: that path is static-TS across ~9
  tables and would flood the keybindings editor + shortcuts reference, so the
  trade-off is these aren't individually keybindable. Shown under the `c`
  (commands), `s` (settings), and no-prefix searches; gating mirrors the dialog
  (host flags, `dependsOn`/`revealWhen`, `searchHidden`, via the shared
  `isSettingActionable`). Names are cleaned (`cleanToggleLabel`: "Enable AI
  features" → "Toggle AI features") and context-free sections are prefixed
  ("Create Reference: Bold heading") — the same prefix
  (`CONTEXTLESS_SECTIONS` = Create Reference + Standardize exceptions,
  `settingSearchName`) now also labels the DIRECT settings-search rows. Toggling/
  cycling routes through `settings.set` and reads the value back for the toast,
  so subscriber side effects (e.g. the workspace switch's confirm-and-revert)
  behave exactly as from the dialog.

- **Fixed "Applying a mismatched transaction" on in-place editor re-mount**
  (`index.ts`, `multi-pane-shell.ts`, `highlight-frequency-plugin.ts`,
  `tests/editor/remount-mismatched-transaction.test.ts`). A plugin that
  dispatches from its own `view()` setup (the highlight-frequency mount scan,
  armed only by a multi-slot highlight/shading color override) fired during
  `new EditorView(...)`, before `mountView` bound the module-level `view`; on a
  SECOND in-place mount `dispatchTransaction` read the stale, just-destroyed
  `view` and applied a fresh-doc transaction to the old state → the error.
  Guarded `dispatchTransaction` on the dispatching view's identity
  (`this !== view`); multi-pane got a `mounted` flag for the same
  temporal-dead-zone hazard; the highlight-freq mount scan now defers one
  microtask so it lands on the real view (also fixing the latent "colors don't
  populate until the first edit" gap). Explains the field report exactly: only
  in-place re-mounts (home-screen New / Open) hit it — Explorer-open spawns a
  fresh window and never re-mounts.

- **Create Reference: heading style options** (`create-reference.ts`,
  `settings.ts`, `index.ts`, `tests/editor/create-reference-options.test.ts`).
  Four new toggles — bold / italic / emphasized / underlined — apply marks to the
  FOR REFERENCE heading line. Emphasis and underline are mutually exclusive;
  emphasis wins if both are set. Bold/italic render in Word; emphasize/underline
  are CardMirror named styles. Gated on "Include the FOR REFERENCE heading".

- **Card Sharing: block senders** (`settings.ts`, `settings-ui.ts`,
  `pairing/inbox-store.ts`, `style.css`, `tests/editor/pairing.test.ts`). New
  `pairingBlockedCodes` setting; `filterBlockedItems` drops blocked sender codes
  from the inbox store's `list`/`unreadCount`/subscriber snapshots (one
  type-agnostic filter covers both received cards and room invites) and the store
  re-fires when the block list changes, so blocking/unblocking updates the
  Receive pill immediately. Blocked items stay in the on-disk inbox (renderer-side
  filter), so unblocking restores them. UI: paste-a-code + a one-click "recent
  senders" list derived from the inbox. Sender codes are self-declared, so
  blocking is a convenience filter, not a security boundary.

- **Fixed collapsed path in the settings folder pickers** (`style.css`).
  Regression from the beta.8 CSS dedup (`2d810cf`): `.pmd-settings-folder` was
  grouped with the column `.pmd-pairing-account`, so the path span's `flex: 1 1 0`
  applied its basis-0 to the vertical axis and collapsed the box to padding.
  Restored `.pmd-settings-folder`'s own row rule (path grows, Browse/Clear and
  the folder-list remove × sit inline, wrapping when narrow).

- **macOS: native swizzle stops the accessibility path that
  `--disable-renderer-accessibility` misses** (`apps/desktop/native/ax-suppress.m`
  NEW, `apps/desktop/scripts/build-ax-suppress.cjs` NEW,
  `apps/desktop/src/ax-suppress-mac.ts` NEW, `apps/desktop/src/main.ts`,
  `apps/desktop/package.json`, `.gitignore`). The renderer-accessibility CHECK
  crash (see the recovery entry below) is switched on, on macOS, when an
  assistive-tech client sets `AXEnhancedUserInterface` / `AXManualAccessibility`
  on the shared `NSApplication` — a path Chromium's
  `--disable-renderer-accessibility` switch does NOT intercept (field crash
  dumps showed `ax_mode` fully enabled despite the switch, which is Windows-only
  in practice). A small Obj-C dylib swizzles
  `-[NSApplication accessibilitySetValue:forAttribute:]` on the concrete app
  class to drop those two attributes and forward everything else, so Chromium
  accessibility never turns on. The swizzled implementation is plain compiled C
  invoked directly by AppKit — a `koffi.register` JS callback could NOT stand in,
  because AppKit invoking a JS trampoline mid-runloop aborts under V8's
  control-flow-integrity check (`brk 0` in `CrBrowserMain`, reproduced from a
  crash report); koffi is used only for the one outbound `cm_suppress_ax()` call
  at startup, and the dylib loads via the same koffi / `extraResources` path as
  libvosk. Built as a universal (arm64 + x86_64) binary by a `clang` prebuild
  step (`build:native`), so there is no node-gyp / N-API and nothing coupled to
  Electron's ABI. Gated on the same `accessibilityTreeEnabled` pref as the switch
  and installed in `whenReady` before the first window: opting the tree back on
  (screen-reader users) skips suppression, accepting the crash risk to match the
  opt-in. Verified in a packaged `electron-builder --dir` build — the universal
  dylib lands at `Contents/Resources/native/ax-suppress.dylib`, and the packaged
  app logs `ax-suppress installed=true` at startup with an exported drop-counter
  confirming a simulated `AXEnhancedUserInterface` activation was dropped and
  `isAccessibilitySupportEnabled()` stayed false, no crash.

- **Renderer-crash recovery: reload + restore instead of a terminal white
  screen** (`apps/desktop/src/main.ts`). A native renderer death — the Chromium
  accessibility CHECK (`blink::AXBlockFlowData::ComputeNeighborOnLine`, confirmed
  from field crash dumps), a GPU-process crash, or an OOM — left a permanently
  blank window with no way back: the journal / autosave timers die with the
  renderer, so unsaved work was stranded. `createWindow` now handles
  `render-process-gone`: it records the reason + exit code to
  `renderer-crashes.log` (userData) and the main-process console — in-app crash
  telemetry we completely lacked (only Crashpad minidumps existed, which a user
  has to dig out), with the `reason` field finally distinguishing `crashed` (the
  a11y CHECK) from `oom` and `killed` — then reloads to recover from the crash
  journal, turning a terminal white screen into a blink-and-recover, with a
  3-reloads-in-30s guard so a document that deterministically re-crashes on load
  can't spin. Cross-platform; complements the macOS prevention above (prevention
  stops the known trigger at the source, recovery catches anything that still
  slips through, on any platform).

## 0.1.0-beta.8 — 2026-07-04

- **Bulk compress retired from the Home screen (console-gated)**
  (`bulk-compress-gate.ts` NEW, `index.ts`, `home-screen.ts`, `MANUAL.md`,
  test). Bulk compress was a one-time remediation for the handful of
  uncompressed early-alpha `.cmir` files; those are long since migrated
  (and any stragglers shrink automatically on the next save), so the tile
  is retired from the Home screen. It stays in the build behind a console
  gate (`localStorage['pmd-compress']='1'`, or `VITE_COMPRESS=1`) for the
  rare support case. With the gate closed the `bulkCompress` callback is
  `undefined`, so the tile is hidden and **Quick Cards takes its slot**;
  the Home-screen number-key shortcuts are now built from the tiles
  actually present, so they **reflow** around the gap (Manage quick cards
  becomes 6 instead of 7, etc.) instead of leaving a dead key. Regression
  test pins the reflow both ways.

- **Zoom is Word-style: show the % you'll land at, then land once**
  (`index.ts`, `scroll-anchor.ts` NEW, `style.css`). Zoom previously wrote
  the CSS `zoom` value on every 10% step, so a continuous ctrl+wheel /
  key-repeat reflowed the whole editor once per step (choppy). Now every
  zoom input shows the TARGET % immediately (a centered badge + the status
  readout) but defers the reflow: steps within ~70ms coalesce and the real
  zoom applies ONCE when the input settles, then the viewport re-anchors.
  All input paths (keyboard, buttons, ctrl+wheel/pinch) funnel through the
  single `zoomActiveBy`/`zoomActiveReset` chokepoint, so single-doc and
  per-pane multi-doc both get it.

- **Read-mode and zoom stay anchored to the top of the viewport**
  (`scroll-anchor.ts` NEW, `read-mode-plugin.ts`, `index.ts`,
  `precise-scroll.ts`, tests). Toggling read mode (content collapses) and
  zooming (content scales) did no scroll-position preservation, so
  whatever was at the top of the viewport drifted away by an amount
  proportional to how far down the doc you were. Both now restore
  `scrollTop` after layout settles (refining across a few
  `requestAnimationFrame`s for cv:auto materialization, the same engine as
  heading-landing), but with different anchors because the two operations
  differ: **zoom** SCALES and hides nothing, so it anchors to the *exact*
  position at the viewport top and preserves its precise screen Y (a
  distant block would drift proportionally under scaling). **Read mode**
  HIDES content, so the top line often vanishes; it scans DOWN from the
  viewport top for the first text read mode keeps visible — a highlighted
  run, cite, or heading (`firstReadKeptPos`, reusing the plugin's own keep
  predicate so "what we anchor to" == "what stays visible") — and pins
  that to the viewport TOP, since the hidden content above it collapses to
  nothing and it rises to the top; if the whole viewport collapses, the
  nearest kept content either way. Read-mode anchoring is skipped entirely
  when the "Jump to doc top when read mode toggles" setting is on, so the
  toggle's jump-to-top wins instead of being overridden by a rAF restore.
  Unit tests cover the correction math (scripted-geometry drift measured
  and cancelled) and the anchor targeting (first survivor lands on the
  heading below a hidden body; a reading position on a highlight is
  returned unchanged).

  Zoom, separately, is Word-style (see the entry above).

- **Collab: co-editing is categorically desktop-only (web has no
  server-dependent capabilities)** (`collab-gate.ts`, `collab-ui.ts`,
  test). The web edition now cannot run co-editing under any
  circumstance: `collabEnabled()` hard-closes on a browser host
  (`getHost().kind === 'browser'`) BEFORE consulting either the
  build-time `VITE_COLLAB` flag or the runtime
  `localStorage['pmd-collab']` console flip, so neither can open a
  server-backed session in a browser. This makes explicit a guarantee
  the architecture mostly already held — card sharing's crypto and
  keystore are Electron-main-only, so pairing is inert on the web — by
  closing the one remaining server-backed feature a console flag could
  otherwise switch on in a browser tab. Defense-in-depth: `start`- and
  `resumeSessionFlow` also early-return on a closed gate (join already
  did), so no entry point can reach the relay from the web build even
  if a caller is added later. A future Tauri desktop host reports a
  non-`browser` kind and is treated like Electron. `collab-gate.test.ts`
  pins all four cases (browser + flag → off, browser + `VITE_COLLAB` →
  off, desktop + flag → on, desktop + no flag → off, i.e. still dormant
  by default on desktop). Developer testing of the collab UI now happens
  in the Electron dev build (or headless in the harnesses), not a
  browser tab.

- **Relay auth messaging is accurate about what's required.** Both the
  co-editing session-start 401 and the card-sharing relay-401
  (previously a dev-only console warning, now a throttled user toast)
  say a **relay** is required and offer both paths — "connect your
  Debate Decoded account **or set up your own relay**" — rather than
  implying a subscription is required (a self-hosted relay needs none).

- **Collab: gating-aware session-start error (co-editing auth parity)**
  (`collab-ui.ts`, test). With subscription gating live (§5.4: paid
  accounts initiate sessions, free accounts join), a free user's
  "Start Collaboration Session" gets a relay 401 on room creation — it
  now surfaces an actionable message (final wording per the entry above:
  "starting a session requires a relay — connect your Debate Decoded
  account or set up your own relay", since a self-hosted relay is a
  valid path and a 401 is ambiguous anyway) instead of a raw "rooms
  request failed: 401". Join/resume 401s get the credentials message;
  non-401 failures keep their reason. Server-side gating was already a
  pure env flip (rooms `POST /rooms` is send-gated through the same
  `_authorize` seam as card sharing); this closes the last client gap.

- **Collab: fixed the one-way desync (silent send-drop) + invalid-mark
  merges** (`collab-session.ts`, `doc-repair.ts`, `collab-repair.ts`,
  tests). Root-caused via an adversarial stress study (up to 10 peers,
  latency/loss/partitions, real editor macros). **The desync:** on a
  merge, plugin-generated repair/heal transactions land a microtask
  after the import, and the sync layer's post-import
  `lastSentVersion = version()` absorbed those un-posted local ops into
  the "already sent" frontier — so the next flush saw nothing to send,
  the queue emptied, the status read "synced," and those ops never
  reached the relay, leaving other peers permanently unable to catch up
  (nothing was ever destroyed — the author's replica held the truth,
  which is why re-hosting recovered it). Fix: our own peer's sent
  counter now advances ONLY when flush actually exports, never absorbed
  by an import; the room-history audit was hardened to compare against
  the live doc version rather than the (previously self-corrupting)
  acked bookkeeping. **The invalid marks:** concurrent underline-vs-
  emphasis (and the bold/super-sub pairs) over overlapping text merged
  to a schema-illegal combination; the resolver now runs on every peer
  (not just the session leader) using a schema-derived priority order
  (cite > emphasis > underline), so a follower never holds an invalid
  run waiting on a leader's fix. Regression tests pin both (P17 verified
  to fail against the pre-fix code).

- **Collab: tables/cards repair pass wired into sessions (§4.4
  complete)** (`collab/collab-repair.ts` NEW, `collab-cursors.ts`,
  `collab-ui.ts`, tests). The M0 repair (`buildDocRepairTr`:
  prosemirror-tables fixTables + exclusive-marks sweep + container
  first-child invariant) now runs AUTOMATICALLY after every remote
  batch and undo/redo, leader-gated per §4.3: lowest peer id among
  self + presence-visible peers dispatches; followers receive the
  synced fix. The gate is best-effort dedup, not a correctness
  dependency — with presence empty (cursors off) everyone repairs,
  which idempotence + the normalizer round cap make safe. Repairs
  carry the normalizer origin (read mode admits; round cap applies).
  T4 pins the session-level behavior: the ragged row-vs-column merge
  squares itself with no manual step, zero cell-content loss,
  idempotent on both peers. Peer ids compare NUMERICALLY (BigInt) —
  decimal u64 strings sort wrong lexically.

- **Collab: delivery-cursor discipline — the recurring one-way desync
  and the permanent gap, both closed** (`collab-session.ts`,
  `patches/`, `style.css`, tests). Field round 3, triggered by network
  flaps (ERR_NETWORK_CHANGED): (a) *Stream frames no longer advance
  the delivery cursor.* A pushed frame proves nothing about the rows
  below it — pushes are shed under backpressure and dropped by dying
  connections — and a cursor that jumped past an unfetched row made
  every later catch-up ("rows after N") skip it FOREVER: the field's
  "specific set of changes never recovered", plus a compaction hazard
  (coversThroughSeq trusts this cursor). The cursor now advances ONLY
  from catch-up pages (server-confirmed contiguous coverage); the
  stream stays the fast path. P16 regression, verified to fail against
  the old logic. (b) *The pending-deps healer's full resync now
  PAGINATES* — it read one page (200 rows) of what can be a much
  longer log and parked forever short of the deps it needed: why the
  one-way desync recurred despite the compaction guard. (c) The
  import-transaction selection restore skips endpoints outside inline
  content (silences PM's "TextSelection endpoint…(table)" warning and
  its surprise caret hop). (d) Partner cursor name flags render above
  all other document decorations (z-index over the AI box).

- **Collab: click-to-invite Send pill, chunked large-doc sync, quieter
  console** (`send-pill-ui.ts`, `collab-hooks.ts`, `collab-ui.ts`,
  `collab-session.ts`, `patches/`, tests). (a) *The Send pill is now
  clickable* (when the collab gate is open): click → the same
  partner/group rows in invite mode with an "Invite to collaboration
  session" header — picking one starts a session on the current doc if
  none is active, then sends the invite (§6's picker-first flow, now
  ~2 clicks total). Drag-to-send is unchanged. (b) *Large documents
  can host sessions* — the field 413: the seed (full CRDT snapshot)
  exceeded the relay's 5MB per-update cap on big master files. All
  oversized payloads (seeds, huge pastes, the audit's full-history
  repost) now ship as CAP-SIZED UPDATE CHUNKS via loro's
  updates-in-range export — ordinary log entries that streams push
  live and importers assemble through the causal-dependency queue. No
  snapshot detour, no truncation, no new data-loss surface; a server
  413 on a normal-sized blob re-chunks at half size as a backstop
  (P15). Intermediate chunks ack back to the span start, so a crash
  mid-sequence re-sends the whole span instead of losing the tail.
  (c) *"Cannot find the loroNode" per keystroke silenced*: the
  selection stash ran on the raw keystroke transaction, one step
  before the doc-changed sync pushes the edit into loro — it now
  captures only at agreement points (the doc-changed follow-up, or
  doc-untouched transactions). The occasional "posted update never
  echoed" console line is the self-echo watchdog working as designed
  (transient network) — bursts of it would point at relay health.

- **Collab field fixes (stress-test round 2): compaction data loss +
  minimal-diff imports + lease-ad polish**
  (`collab-session.ts`, `patches/loro-prosemirror+0.4.3.patch`,
  `collab-cursors.ts`, `style.css`, tests). (a) *The one-way sync
  split.* The host's compaction snapshot covered `lastSeq`
  unconditionally — but the delivery cursor advances even when imports
  park in Loro's causal-dependency queue, so a compaction fired while
  the partner's ops were pending exported a snapshot WITHOUT them
  while its truncation deleted their stored blobs: the room
  permanently lost the partner's causal ancestors, every later edit of
  theirs parked forever, and both chips honestly said "synced"
  (surviving restarts — the room itself was damaged). Two-part fix:
  compaction now refuses to run while any import is pending
  (`pendingImports`, cleared only by a clean full-resync), and a
  ROOM-HISTORY AUDIT (15s after start, then every 30min) compares the
  room's blob metadata (decodeImportBlobMeta — no full import) against
  this replica's relay-ACKNOWLEDGED version and reposts full history
  when the room lost ops — which also self-heals rooms already
  damaged, including live field sessions, once the affected peer runs
  this build (P14 regression). (b) *AI routines survive partner
  edits.* The binding replaced the WHOLE doc on every import, so
  `tr.mapping` collapsed and every tracked position (AI-lease regions,
  decorations) broke whenever the partner typed — "card moved — cut
  not applied" during AI runs. Patched to a MINIMAL-DIFF replace
  (findDiffStart/findDiffEnd, verify-result-and-fallback for
  structural edge cases): remote edits now map like local ones. (c)
  *Lease-ad polish*: sender identity travels in the ad — your own
  echo no longer renders on the machine running the AI; the tag names
  the partner ("Priya's AI"); and the advisory region uses the same
  outline+fill box treatment as the local AI-working affordance, in
  the collab blue.

- **Collab field fixes (stress-test round): viewport stability +
  joiner doc naming** (`patches/loro-prosemirror+0.4.3.patch`,
  `collab-ui.ts`, `index.ts`, tests). (a) *Remote edits no longer
  fight the local caret/viewport.* The binding's remote-update path
  replaces the whole doc, remapping the local selection to a bogus
  boundary position, and only restored it in a `setTimeout` — under
  continuous partner typing that bogus-selection window flickered the
  nav-pane indicator twice a second and let local keystrokes land (and
  scroll) at the PARTNER's position: the field's viewport ping-pong.
  Worse, the restore itself was drift-prone: it captured the selection
  as loro cursors AFTER the import, anchoring against already-shifted
  text (caret drifted by the inserted length per batch). Patched: the
  selection is stashed as loro cursors on every LOCAL transaction
  (while PM and loro agree) and restored ON the import transaction —
  no async window, no drift (P13 regression: caret pinned through
  every imported batch, checked after every transaction). Also dropped
  an upstream bug where rendering a partner's stale cursor WROTE the
  re-encoded position under the LOCAL peer's store key, teleporting
  your advertised cursor to the partner's location. (b) *Joiners now
  know the doc's name.* The host publishes the title into the room's
  `meta` map with the seed; join/resume adopt it for the window title,
  filename chip, save-as default, and the Sessions-list rows (which
  previously just said "collaboration session").

- **Collab M4 (coediting branch): presence cursors, lease
  advertisement, read-mode undo clamps** (`collab/collab-cursors.ts`
  NEW, `collab-ui.ts`, `ai/edit-coordinator.ts`, `settings.ts`,
  `style.css`, tests). Partners now see each other's live cursor and
  selection: loro-prosemirror's ephemeral-cursor plugin does the
  position math (PM selection → stable loro cursors → decorations);
  our layer pipes its store over the room's encrypted presence channel
  with a 1-byte frame type (0x01 cursor bytes, 0x02 lease ads),
  throttled to ≤1 frame/120ms trailing-edge plus a 15s keepalive so a
  reading partner doesn't expire out of the overlay. Per-peer
  deterministic colors; name flag fades to a sliver until hover.
  "Show partner cursors in sessions" settings row (default on; off =
  doc still syncs, overlay hidden and yours stops broadcasting). AI
  leases are advertised NON-enforcing (§4.6): while the coordinator
  holds leases, their live ranges broadcast every 2s and render on the
  partner as a dashed advisory underline + tag, remapped through local
  edits between refreshes (raw-position advisory by design — exact when
  converged, approximate under divergence, never blocking). New
  `leasedRanges()` read API on the edit coordinator. Read-mode clamp:
  session undo/redo are SWALLOWED while reading — Loro undo can't be
  depth-bounded like prosemirror-history, and its transactions carry
  the binding meta (→ sync-origin) so they'd bypass the read-mode lock
  and revert real edits from under a reading user.

- **Collab M3 (coediting branch): session persistence + offline
  resilience** (`collab/collab-store.ts` NEW, `collab-persist.ts` NEW,
  `collab-relay.ts` NEW, `collab-prefetch.ts` NEW, `collab-session.ts`,
  `collab-ui.ts`, `home-screen.ts`, desktop wake plumbing, tests).
  Sessions now survive an app nuke: a per-room record (share code,
  role, delivery cursor, CRDT snapshot + increments) persists to a
  dedicated IndexedDB store on a 2.5s cadence + pagehide, cleared only
  on explicit end/leave or tombstone. The load-bearing subtlety the
  tests caught: the persisted version must be what the relay has
  ACKNOWLEDGED, not what was exported to the send queue — export-time
  tracking would silently drop every queued-but-unposted update on
  crash (new `ackedVersion`, advanced per posted entry, snapped to the
  export version when the queue drains). `CollabSession.resume()`
  rebuilds from the record; the first flush sends exactly the unsent
  diff. Home screen gains a DEDICATED "Sessions" section below Recent
  (never merged with recents — sessions must not be displaced by doc
  churn; scrollable; per-row Forget). Also: join is now STRICT about
  its initial sync (a network failure used to "succeed" with an empty
  doc — catchUp swallows errors by design, joins must not); invite
  receipt prefetches the encrypted room seed so an invite accepted
  offline still joins locally (ciphertext at rest, key stays in the
  share code) and syncs on reconnect; wake-from-sleep hard-restarts
  the stream (powerMonitor broadcast on desktop, 'online' event both
  editions); catch-ups that merge a big offline backlog announce it
  ("synced N offline updates") instead of silently reshaping the doc.

- **Collab field fixes (draft-installer round 1).** (a) *Joining now
  swaps the doc IN the joining window.* The join flow reused
  `newDocument()`, which on desktop SPAWNS a window — the session
  binding installed into the original window's plugin source, but its
  editor was never rebuilt, and the spawned window knew nothing about
  the session: joiner saw an unrelated new window plus an inert
  "Session: synced" chip (the stream WAS connected; nothing bound it to
  an editor). New `replaceWithSessionDoc()` runs the web edition's
  New-in-place path with the same overwrite prompt; cancelling unwinds
  the join without touching the room (regression-tested). (b) *End/
  leave confirm is an in-app overlay.* `window.confirm` on Windows/
  Linux Electron never returns keyboard focus to the renderer — the
  editor was untypeable until reload. Editor refocused after end/join.

- **Open Developer Console ribbon command** (`openDevConsole`;
  desktop-only, hidden on web; no default binding — command-bar
  triggered, rebindable like any command; new "Diagnostics" group).
  Backed by a `host:toggle-devtools` IPC that toggles Chromium DevTools
  on the invoking window. Load-bearing on Windows/Linux: the packaged
  app sets a null application menu there, and Electron's stock DevTools
  accelerators (F12/Ctrl+Shift+I) only exist as menu accelerators — so
  packaged builds had NO console access (discovered while flipping the
  dormant-collab localStorage gate for field testing). Deliberately not
  bound to F12, which is `clearToNormal`.

- **Collab M2 (coediting branch): pairing-mailbox session invites +
  baked relay defaults** (`pairing/room-invite.ts` NEW,
  `receive-pill-ui.ts`, `relay-client.ts`, `collab-ui.ts`,
  `collab-hooks.ts`, ribbon registration, desktop `pairing-ipc.ts` +
  `preload.ts` + `electron-host.ts`). An invite is a normal sealed
  pairing message whose item carries `{shareCode, title}` under type
  `room-invite` — the payload rides `sliceJson`, which main passes
  through verbatim, so the desktop pipeline needed only a per-message
  `minReceiverVersion` override (invites declare the first
  invite-aware version; pre-invite clients drop them with the existing
  update-required toast instead of rendering a dead card row). New
  "Invite Starred Partner to Session" ribbon command sends the active
  session's share code to the starred partner/group; the Receive pill
  renders invite rows ("«name» invited you to collaborate on «doc»")
  with a Join button that hands the code to the lazy collab module
  through a new collab-hooks seam (invite rows don't drag/insert; the
  code is consumed on join). Rooms clients also gain a LAST-fallback
  relay endpoint: the desktop main process exposes its baked relay
  base + shared token over a new `host:collab-relay-defaults` IPC, so
  packaged builds can host/join sessions with zero settings setup
  (resolution stays settings → dev env → baked). Deferred: invite
  seed-snapshot prefetch (plan §4.1) lands with M3 session persistence.

- **Collab M2 (coediting branch): comment-thread sync**
  (`collab/collab-comments.ts` NEW, `comments-plugin.ts`,
  `collab-ui.ts`, tests). Field symptom: comment paint synced (the
  `comment_range` mark rides the doc CRDT) but thread content lives in
  plugin state and never left the machine — the partner's comments
  pane stayed empty. Threads now mirror into a `comments` root LoroMap
  on the session doc (same flush timer, same E2E encryption): nested
  per-thread map keyed by comment id, so concurrent replies MERGE
  rather than LWW-clobbering whole threads; edits are LWW per comment;
  root deletion beats a concurrent reply. Outbound, a session plugin
  mirrors the `commentsKey` mutation metas (scoped to the session view
  — other panes can't leak comments into the room); inbound imports
  dispatch a new `sync-load` refresh that, unlike `load`, PRESERVES
  the GC tombstone parking (orphan parking stays local so undo can
  still resurrect; only explicit deletes touch the shared map). Hosts
  seed their existing threads before the first flush; joiners pull the
  map after the session doc lands. Comment ids switch to random
  Word-compatible int32s during sessions — two peers advancing the
  same small-int counter WOULD collide on concurrent new comments.

- **Collab M2 (coediting branch): formatting-fusion heal — provenance-
  tagged shrink sizes + session invariant plugin** (`schema/marks.ts`,
  `ribbon-commands.ts`, `collab/collab-invariants.ts` NEW,
  `collab-ui.ts`, tests). Field root cause (plan §14): Peritext range
  marks cover text concurrently inserted INSIDE their range, so a
  partner's underlined typing inside a shrunk span inherits the small
  `font_size` at merge — on both replicas, with no op recording it —
  and Loro's UndoManager compounds it by re-marking drifted ranges
  across interleaved remote ops (undo also leaves residue by skipping
  remote interior characters). Worse, fused runs are shrink-EXEMPT, so
  regrow could never clear them. Fix: `font_size` gains an `origin`
  attr — `'shrink'` when the protection-aware sizing machinery
  (shrink/regrow cycle, smart shrink) applied it, `null` for anything
  the user chose (size chip, ± nudge, pasted content; the attr is
  deliberately not DOM-serialized, so clipboard round-trips demote to
  manual). A session-only plugin then heals on the Loro binding's
  transactions (remote imports, init replace, undo/redo): within
  changed ranges, strip `font_size` where `origin === 'shrink'` AND
  the run carries underline/emphasis. Both fusion paths copy the
  enclosing mark's attrs verbatim, so provenance travels with every
  fused copy; user-chosen sizes survive all of them (pinned by a
  manual-wins regression test that doubles as the no-heal control).
  Old saved docs parse fine (attr defaults in) but pre-upgrade shrink
  marks are untagged and won't auto-heal.

- **Collab M2 (coediting branch): field-test fixes — differ mark-kill
  patch, stale-instance watchdog, healer escalation, zombie-proof
  shutdown** (`patches/loro-prosemirror+0.4.3.patch` NEW + postinstall,
  `collab-session.ts`, `room-client.ts`, `_rooms-mock.ts`, relay
  Dockerfile/README, tests). Live two-window testing with relay
  kill/restart cycles surfaced four defects:
  1. *Concurrent highlight loss (upstream binding bug, patched).*
     loro-prosemirror's text differ "normalized" mark state by emitting
     blanket `key: null` retains over every unmarked run on every
     transaction — local no-ops that are REAL unmark ops, LWW-killing
     the partner's concurrent highlights (field: per-paragraph
     winner-take-all). Sibling defect unconditionally delete()d null
     node attrs, clobbering concurrent attr sets. Patched (per-run
     diffing; delete only existing keys) via patch-package; regression
     tests P11/P12 pin both. Upstream report TODO.
  2. *Send-success restarts starved the stream.* restart() aborts the
     in-flight handshake, so steady typing killed every reconnect
     before its hello; live push never resumed while the user typed.
     Now a nudge() (skips backoff wait, never touches an in-flight
     attempt), pinned by a deterministic connect-attempt-count test.
     "Synced" now strictly means the stream's hello state — catch-up
     success no longer paints the chip.
  3. *Zombie relay instances after deploy/restart.* Uvicorn's default
     graceful shutdown waits forever for SSE streams: a stopped
     instance lingers unbound, heartbeating its old streams while the
     new instance owns the port — pushes fan out where nobody listens
     ("synced but updates arrive in 5-minute batches"). Server:
     --timeout-graceful-shutdown 5 in both Dockerfiles. Client:
     self-echo watchdog — the server pushes your own update back to
     your stream, so "posted seq N, stream silent past the deadline"
     proves staleness and hard-restarts the stream.
  4. *Pending-deps healer couldn't reach below the cursor.* A frame
     whose causal deps were shed advanced the cursor past the gap, and
     the healing catch-up (fetching after the cursor) found nothing.
     Catch-ups invoked for missing deps now escalate to a full resync
     from seq 0 when the tail is empty. 409 on stream RECONNECT retries
     (our own ghost may briefly inflate the count) instead of
     terminally reporting the room full.

- **Collab M2 (coediting branch): session UI wiring** (`collab-gate.ts`
  NEW, `collab-hooks.ts` NEW, `collab-ui.ts` NEW; `index.ts`,
  `index.html`, `ribbon-commands.ts`, `ribbon-groups.ts`,
  `ribbon-availability.ts`). Four view-less ribbon commands under a new
  "Collaboration" group — Start / Join / Copy Session Share Code /
  End-or-Leave — all unbound, searchable in the command bar, and hidden
  entirely unless the collab gate is open (`VITE_COLLAB=1` at build
  time or a manual localStorage flip; packaged releases stay dormant).
  Everything heavy loads lazily: the editor core touches only two
  loro-free seams (`collab-hooks.ts`) — a transaction tagger in
  `dispatchTransaction` that stamps sync-origin on the Loro binding's
  transactions BEFORE filters run (so read mode and the AI coordinator
  admit remote edits — the M0 contract cashing in), and a plugin source
  consulted by `buildEditorPlugins` that appends the session's binding
  plugins and swaps `history()` for the CRDT undo manager while a
  session is live (undo never reverts a partner's edits). Session flows
  in `collab-ui.ts`: host = share code auto-copied to the clipboard;
  join = paste-code prompt into a fresh unsaved doc populated by the
  binding; a `#collab-chip` status segment shows synced / sending /
  offline-with-queue; end/leave confirms and restores the normal plugin
  stack. Integration test (`collab-ui-flows.test.ts`) drives the real
  flows end-to-end over the mock relay, including read-mode-on remote
  delivery with local typing still locked.

- **Collab M2 (coediting branch): rooms protocol + client sync core**
  (`relay/server.py` rooms endpoints; `src/editor/collab/` NEW —
  `collab-crypto.ts`, `room-client.ts`, `collab-session.ts`;
  `loro-crdt` 1.13.6 + `loro-prosemirror` 0.4.3 exact-pinned;
  `tests/collab/` NEW, 30 tests). Not user-facing yet — no UI is wired;
  everything is dormant modules + tests.
  - *Server*: durable rooms on the self-hosted relay — create,
    append-update (server-assigned delivery cursor `seq`), cursor-paged
    fetch with snapshot fast-path, client-uploaded encrypted snapshot
    compaction (server truncates the log it cannot read), SSE stream
    (hello{lastSeq} / update / presence / end frames), ephemeral
    presence fan-out (zero-DB hot path), tombstoned deletion (410 ≠
    404), 10-stream participant cap at connect, ≥7-day idle GC. Sync
    handlers per the overload-hardening pattern; fan-out scheduled onto
    the loop with call_soon_threadsafe.
  - *Client*: AES-256-GCM room crypto (WebCrypto; 12-byte IV ‖ ct+tag;
    `cmshare1.<roomId>.<key>` share codes); renderer-portable rooms REST
    client + SSE `RoomStream` (getReader-based sibling of the desktop
    `relay-stream.ts`, same backoff+jitter discipline, 410→ended,
    409→full); `CollabSession` conducting LoroDoc ↔ transport — outbound
    debounce-flush via version-vector diff export, synchronous
    export-before-import so remote ops are never echoed, offline send
    queue with retry, hello-triggered + periodic catch-up (heals shed
    push frames via Loro's causal-dependency queue), host-side snapshot
    compaction cadence, seed state as the room's first regular update.
  - *Tests*: crypto round-trip/tamper (6), transport incl. 10-cap and
    outage reconnect (6), end-to-end two-editor sessions over the
    in-process mock relay — seed propagation, live convergence, the
    travel-day offline/reconnect cycle, the P1 highlight-union
    regression through the full encrypted stack, session end (5) — plus
    the promoted bake-off suites: Peritext criteria + structural merges
    with leader-gated repair (12; concurrent-creation boundary
    insertion documented as peer-id tie-broken, asserted for
    convergence not inclusion) and a 15-seed 3-peer CRDT fuzz (1).

- **Collab groundwork (M0): sync-origin meta contract, normalizer loop
  guard, deterministic doc repair** (`sync-origin.ts` NEW,
  `normalizer-guard.ts` NEW, `doc-repair.ts` NEW; `read-mode-plugin.ts`,
  `ai/edit-coordinator.ts`, `absorb-plugin.ts`,
  `cite-classifier-plugin.ts`, `named-style-normalizer-plugin.ts`,
  `import/index.ts`). Three standalone-valuable pieces of the
  collaborative-editing groundwork:
  1. *Sync-origin transactions.* `markSyncOrigin(tr)` tags a transaction
     as already-merged remote content. Read mode's `filterTransaction`
     and the AI edit coordinator now admit such transactions
     unconditionally — rejecting one would desynchronize the editor from
     a shared document. The coordinator instead *releases* any lease a
     sync edit touches (checked against pre-mapping positions); the
     owning AI feature already treats a vanished lease as abort-and-retry.
  2. *Normalizer round guard.* ProseMirror re-runs `appendTransaction`
     with no bound, so two normalizers that each "fix" the other's output
     could wedge the renderer in an infinite dispatch loop (a
     WHITE_SCREEN_AUDIT wedge contributor). All three normalizers now
     route appended transactions through `guardNormalizerTr`, which
     stamps origin + round metas and drops the pass (with a console
     warning) past round 8. Normalizer output is admitted in read mode —
     it only fires in response to transactions the lock already admitted.
  3. *Deterministic doc repair.* `repairDoc`/`buildDocRepairTr`: pads
     ragged tables (prosemirror-tables `fixTables`), sweeps co-present
     `excludes` marks (keeps the earlier-declared), and restores the
     card/analytic_unit first-child invariant. Pure and idempotent by
     construction. Wired into `fromDocx`/`fromDocxFull` so Word's
     tolerated-ragged tables arrive rectangular.
  Tests: `sync-origin.test.ts` (7), `normalizer-guard.test.ts` (5),
  `doc-repair.test.ts` (4), and `collab-fuzz.test.ts` — a seeded fuzz
  skeleton (25 seeds × 25 random ops against the real schema with the
  normalizer trio active) asserting validity, no cap trips, and repair
  idempotence; the CRDT bindings slot into this harness later.

- **Relay test harnesses preserved in-repo** (`dev/relay-contract.mjs`
  NEW, `dev/relay-load.mjs` NEW). The 20-check wire-contract suite (the
  old-client compatibility gate for any relay change) and the SSE/POST
  load client used for the capacity study and the hardening acceptance
  runs, previously session-local scripts.

- **Relay hardening: blocking DB work moved off the event loop**
  (`relay/server.py`, `relay/Dockerfile`). Load-testing found the
  single-worker relay wedged permanently at ~200 POST/s: the async
  POST handler ran synchronous SQLAlchemy commits on the asyncio event
  loop, and under burst the loop + threadpool-dependency convoy stopped
  reading new connections entirely (CPU idle, DB pool idle, established
  SSE streams unaffected — but new requests dead until restart).
  `POST /relay/messages` is now a sync `def` handler (Starlette runs it
  in the threadpool, like GET/DELETE already were), with the request
  body read on the loop via a small async dependency. Because
  asyncio.Queues are loop-owned and not thread-safe, the store-then-push
  fan-out is scheduled onto the loop with `call_soon_threadsafe` instead
  of being touched from the worker thread. The connection pool is sized
  to the threadpool (40/0, `pool_timeout=5`) and pool exhaustion maps to
  a clean 503; the Dockerfile adds `--limit-concurrency 4096` as a
  connection-storm backstop (it counts long-lived SSE streams, so it
  must stay far above the expected stream population). Measured: the
  ~200 msg/s permanent-wedge cliff is gone — ~590 msg/s sustained on
  the test box with stable latencies (ack p95 ≤51 ms), delivery p95
  90 ms → 25 ms at 100 msg/s, zero lost pushes across an 18,443-message
  ramp, and the 20-check wire-contract suite passes identically before
  and after (old clients unaffected by construction).

## 0.1.0-beta.7 — 2026-07-02

- **Card sharing v2 transport: SSE push + self-hosted relays**
  (`relay-stream.ts` NEW, `pairing-ipc.ts`, `preload.ts`,
  `electron-host.ts`, `pairing-wiring.ts`, `settings.ts`,
  `dev/mock-relay/server.js`; server counterpart in the
  scouting-assistant repo).
  Replaces the 30-second receive poller with push delivery.
  `RelayStream` (new module, zero deps — streamed undici fetch + hand
  parser) subscribes to the relay's `GET /relay/stream?recipient=` SSE
  channel: `event: hello` on connect, one `data:` frame per POSTed
  bundle in the same wire shape as `GET /messages`, `: hb` heartbeat
  comments every 25s. Reconnects forever with exponential backoff +
  jitter; 404 → the relay predates push, so the session falls back to
  today's interval polling (capability detection — old servers and old
  clients both keep working; the server keeps `GET /messages`
  unchanged); 401 → surfaced distinctly and retried at max backoff.
  `pairing-ipc` gains a delivery manager: catch-up `pollOnce()` on
  every (re)connect and on `powerMonitor` resume (dead-socket
  restart), `pollSeconds` repurposed as the legacy-fallback cadence
  and (floored to 5 min) the belt-and-suspenders catch-up while
  streaming; delivery is at-least-once with the existing
  `consumed`/`rx-<msgId>` dedupe absorbing push/catch-up overlap. The
  decrypt→inbox path is untouched (extracted to `processMessages`,
  shared by both paths). The renderer re-configures on every settings
  change, so the configure handler now only restarts delivery when a
  delivery-relevant field changed — a display-name edit must not sever
  the stream. New settings `pairingRelayUrl`/`pairingRelayToken`
  (Card Sharing tab) point at a self-hosted relay; URL/token
  resolution is settings → env → baked default, with all requests
  routing Authorization through one supplier function. The dev mock
  relay grows a matching `/stream` (and `PAIRING_NO_STREAM=1` to
  simulate a legacy relay). Server side (scouting-assistant): SSE
  endpoint with per-connection asyncio queues + single-worker
  registry, store-then-push on POST, the per-GET full-table sweep
  replaced by a `created_at` cutoff filter (sweeper thread still owns
  deletion), and a composite `(recipient_code, created_at)` index.
  A standalone, self-hostable relay implementing the identical wire
  contract ships in the new `relay/` folder (single-file FastAPI +
  Postgres, Dockerfile + docker-compose, README) — the scouting
  backend is not public, so self-hosters get the server from here.
  Verified: 5 RelayStream tests against a live local HTTP server
  (`tests/desktop/relay-stream.test.ts`), a 13-check contract suite
  against the real backend on local Postgres (push, catch-up, ack,
  auth, expiry semantics), and the same 13 checks against the
  standalone `relay/` server.

- **Standardize with exceptions** (`ribbon-commands.ts`, `ribbon-groups.ts`,
  `settings.ts`, `settings-ui.ts`, `index.ts`).
  Two new commands, `standardizeHighlightExcept` and
  `standardizeShadingExcept`, mirror the plain standardize pair — same
  auto-scoping (selection when non-empty, whole doc otherwise), same
  rewrite-to-active-pen semantics, same null-pen strip — but skip any run
  whose *current* color matches a configured exception, leaving it
  completely untouched (including under a null pen, which makes the
  commands double as "strip everything except my exception color").
  Implementation is a single optional `except` getter threaded through
  `runUniColor` → `uniHighlight` / `uniShade`; the run's mark color is
  compared against the exception before the remove/add — highlight by
  exact Word name, shading case-insensitively via the existing `upperHex`
  normalization (stored shading attrs from imports can be lowercase).
  Two new settings back the commands: `standardizeHighlightException`
  (one of Word's 15 highlight names; sanitized through
  `isWordHighlightName`, default `yellow`) and
  `standardizeShadingException` (bare 6-char hex, uppercased on write via
  `isHex6`, default `FFFF00` — yellow, matching the highlight default).
  They render in a new Editing-tab section,
  "Standardize exceptions": the highlight editor is a name-storing swatch
  row of the 15 Word colors plus a label naming the pick (highlights can
  only be those 15); the shading editor reuses the free-color-editor shape
  (picker + swatches, storing bare hex) with a Protected Grey swatch
  appended after the shading palette. Doc menu → Highlighting gains both
  entries below the plain pair; since the menu rebuilds on every open, the
  labels interpolate the live exception ("Standardize Highlighting (except
  Bright Green)"). Both commands are registered keybindable (unbound by
  default, "Highlight tools" group) with find-palette aliases. New test
  file `tests/editor/standardize-except.test.ts` (7 tests): rewrite-with-
  skip, null-pen + exception, plain-standardize regression, selection
  scoping, and case-insensitive shading matching.

- **Search palette: truncation tooltips** (`quick-card-search-ui.ts`).
  Every result row's name span and meta span (the file's directory) are
  ellipsis-truncated by CSS with no way to see the full text. Rows now
  get a `mouseenter` handler that compares `scrollWidth` to `clientWidth`
  and sets the native `title` to the full text only when the ellipsis
  actually cut something off (clearing it otherwise). The check runs
  lazily on hover rather than at render time because layout isn't final
  while rows are being built, and this way it stays correct across
  palette resizes; it also costs nothing for keyboard-only use. Covers
  all result sources — file rows, in-file object rows (headings / tags /
  cites), and outline browse rows all render through the same spans.

- **Create Reference customization** (`create-reference.ts`, `settings.ts`,
  `settings-ui.ts`, `index.ts`).
  User-requested: control over what Create Reference puts on the
  clipboard. `createReference` now takes a `CreateReferenceOptions`
  object instead of the lone `useGray50` boolean, and the transform is
  extracted into `buildReferenceNodes` — a pure node builder (no DOM, no
  clipboard) so every option combination is directly testable. Seven new
  settings in a new Editing-tab "Create Reference" section (the existing
  `forReferenceUseGray50` toggle moved in, relabeled "Use Gray-50% body
  text" since the section supplies the context):
  `createReferenceIncludeHeading` (default on — off drops the
  `<<CITE FOR REFERENCE>>` heading paragraph); three heading-shape
  settings `dependsOn`-greyed while the heading is off —
  `createReferenceDelimiter` (the six "Condense with warning" mirror
  pairs, default `<<`; heading assembly lives in the exported pure
  helper `referenceHeadingText`), `createReferenceIncludeCite`
  (default on), and `createReferenceCustomHeading` (free label
  replacing FOR REFERENCE; a case-insensitive `%Cite%` token marks
  where the cite goes, no token = cite prepended as in the default;
  whitespace left by an emptied token is collapsed, and a label that
  ends up empty falls back to FOR REFERENCE rather than emitting bare
  brackets); `createReferenceShrinks` (default on) with
  `createReferenceShrinkPt` (default 3, sanitizer-clamped 1–20,
  `dependsOn`-greyed while shrinking is off; with shrinking off, runs
  keep their existing `font_size` marks untouched rather than being
  restamped); and `createReferenceHighlightMode`
  (`'shading'` default = the old highlight → grey C0C0C0 conversion;
  `'convert'` = a background in the highlight's own color via
  `highlightRgbFor`, matching the Highlight to Background command;
  `'keep'` leaves highlight marks in place; `'remove'` strips them
  without adding shading). Body coloring and the 1pt floor are
  unchanged. Per maintainer direction, user-facing text says "grey",
  not "Protected Grey", where no disambiguation from the other grey
  swatches is needed. New test file
  `tests/editor/create-reference-options.test.ts` (16 tests) covering
  the default composition, each option axis, cite collection, the
  heading-assembly rules, and the empty-selection guard.

- **Hover fixes** (`style.css`). Recover Drafts: `…-row-btn-save` had
  no hover rule and `…-row-btn-open:hover` filled with
  `--pmd-c-accent-hover` under themed text (illegible dark-on-dark);
  both now share `--pmd-c-hover` + accent border-color. Receive pill:
  `.pmd-receive-bar:hover` joined the shared hover-scaffolding group
  (dropzone-bar family). Send pill deliberately untouched — its
  drag-over "hot" state is its affordance. Settings: the Receive-pill
  flash row moved above the fallback-poll row in the Card Sharing tab.

- **Custom acronym letters + Underline Acronym**
  (`acronym-patterns.ts` NEW, `ribbon-commands.ts`, `ribbon-groups.ts`,
  `settings.ts`, `settings-ui.ts`, `style.css`).
  Feature request modeled on the acronym customization in
  [shreerammodi/debate-scripts](https://github.com/shreerammodi/debate-scripts)
  (GPLv3 — reimplemented from scratch, no code ported): the acronym
  commands consult a user table before the
  classic first-letter-per-word behavior. Where his VBA uses a
  hardcoded phrase → "wordIdx:charSpec" DSL table, ours stores
  `acronymPatterns: Array<{phrase, chars}>` — raw character offsets
  picked by CLICKING letters in a settings letter-picker (new
  "Acronym marking" section, Editing tab). Direct manipulation
  deliberately replaces the DSL: positions come from clicks, so
  nothing can be mistyped, no validation UI is needed, and the marked
  cells double as the live preview. Phrase edits keep a pick only
  where the character at that offset is unchanged. Command side: the
  duplicated first-letter walks in `emphasizeAcronym` /
  `highlightAcronym` are extracted into a shared
  `acronymTargetRanges(state, skipBlocks)` which also builds the
  expanded-selection text (inline leaves as `\0`); when the selection
  lives in ONE textblock and its whole-word-expanded text equals a
  phrase case-insensitively (exact spacing/punctuation — offsets then
  map 1:1), the picked offsets are marked instead of first letters.
  Multi-paragraph selections and non-matches keep classic behavior;
  per-command semantics unchanged (emphasis strip rules, highlight
  null-pen strip, structural-block skip differences). New
  `underlineAcronym` command (unbound, Character styles group)
  completes the trio, mirroring `emphasizeAcronym` with
  `underline_mark`. Table ships empty by design. 10 tests in
  `tests/editor/acronym-patterns.test.ts`: matching/sanitizing, all
  three commands, partial-selection expansion, null pen,
  multi-paragraph fallback.

- **Background-color cue: faint dot grid** (`settings.ts`, `index.ts`,
  `marks.ts`, `style.css`).
  New Appearance toggle `distinguishShading` (default off) rendering a
  subtle visual distinction between `shading` and `highlight` marks,
  which are otherwise deliberately identical: a faint 4px
  radial-gradient dot grid over each shaded run. Resolved into
  `data-shading-cue="dots"` on the document root (the attribute-swap
  pattern); style.css gates the treatment on
  `.ProseMirror [data-shading-band]` spans. The dot color is
  `color-mix`ed from the span's own fill toward the existing
  `--pmd-c-band-fg-*` tokens, reusing the shading luminance-band
  machinery — light fills get slightly darker dots (89/11), dark
  fills flip toward white (80/20) so navy and black fills stay
  legible. To expose the fill to CSS, the shading `toDOM` now also
  emits `--sh: #hex` alongside the literal `background-color` (kept
  for clipboard consumers; `parseDOM` reads `data-shading`, so
  round-trip is unaffected — verified by the existing mark-fidelity
  suite). Dot-grid phase resets at span boundaries within a run;
  accepted over `background-attachment: fixed`, which costs scroll
  repaints on large docs. A 1px top "plate edge" variant was
  prototyped against a live mockup and cut: boxed emphasis draws 1px
  borders around runs, so a hairline reads as a stray box fragment.

- **Fix: table cell borders vanished after any keybinding change**
  (`table-plugins.ts` NEW, `index.ts`, `style.css`). The reported
  main-editor case: prosemirror-tables' `columnResizing()` registers
  its table nodeView — the one that wraps tables in `.tableWrapper`,
  which ALL table CSS hangs off — by mutating its own plugin spec
  inside `state.init`. The app reconfigures the editor with a fresh
  `buildEditorPlugins()` on every `ribbonKeyOverrides` /
  `keyboardMacros` change, and `reconfigure` skips `init` for
  plugins whose key already exists — so the fresh instance's
  `nodeViews` map stayed empty, the view rebuilt node views from it,
  and every table re-rendered unwrapped: no cell borders, no
  column-resize handles, stable until reload. Fix: `tableEditing()` /
  `columnResizing()` are now module-level singletons
  (`table-plugins.ts`) reused by every `buildEditorPlugins()` call —
  the nodeView registered by the first `init` rides along through
  every reconfigure. Verified by
  `tests/editor/table-wrapper.test.ts` (2 jsdom tests): one
  reproduces the upstream trap with fresh instances (if it ever
  fails, prosemirror-tables fixed the side effect and the singleton
  can be revisited), one proves the singletons keep the wrapper
  across repeated reconfigures. An initial zoom/border-collapse
  hypothesis was disproven by an Electron pixel-capture harness
  (collapsed borders paint correctly at 12 zoom levels × DPR
  1/1.25/1.5/2 on this Chromium), so the interim
  `border-collapse: separate` change was reverted. Second, smaller
  fix kept: the table rules were scoped to
  `:is(#editor, .pmd-pane-editor) .tableWrapper`, so the Quick Cards
  manage editor (`.pmd-qc-manage-editor` host) rendered tables with
  no borders at all; rescoped to `.ProseMirror .tableWrapper`.
  Border DATA was never involved — OOXML borders ride opaquely in
  `rawTblPr`/`rawTcPr`; the editor paints its own uniform 1px grid.
  Note: read mode hiding tables entirely is by design.

- **Fix: condense-on-paste scoped to the cursor, not the paste**
  (`paste-plugin.ts`).
  With `condenseOnPaste` on, both F2 paths (Electron's
  `applyPlainPasteFromText` and the browser armed-mode `handlePaste`)
  dispatched the paste and then ran `condenseBranchC` /
  `condenseMerge` against the post-paste collapsed cursor.
  `resolveCondenseScope` treats an empty selection as "the enclosing
  card, else nothing" — so the common case, pasting a plain-text blob
  at doc level, condensed nothing (all intraparagraph whitespace
  survived), and a mid-card paste over-condensed the whole card. Both
  sites now share `condensePastedRange`: capture the selection start
  before the paste, take the post-paste cursor as the end, select
  that range, run the settings-driven condense (the same pattern
  `pasteTextAndCondense` already used), and collapse the cursor back
  to the end of the range. A whole paragraph the paste merges into is
  cleaned in full — identical to F3 over a selection touching it. New
  `tests/editor/condense-on-paste.test.ts` (5 tests): the doc-level
  repro, out-of-range content untouched, merge branch, cursor
  restoration, and setting-off passthrough.

- **Comment-audit follow-ups** (`settings.ts`, `settings-ui.ts`,
  `word-break.ts`, `word-selection-keymap.ts`, `word-selection-plugin.ts`,
  `find-replace-plugin.ts`, `ribbon-commands.ts`).
  Removed two dead symbols the audit's reviewers surfaced —
  `sanitizeHexColor` (superseded by the slots-array sanitizer) and
  `COMMON_FONTS` (only reference was its own definition; `FONT_GROUPS`
  itself stays live). Removed all six references to the
  never-vendored spec doc `word-selection-behavior.md` (two of which
  embedded a machine-local `~/Downloads` path): `word-break.ts`'s
  header is now the canonical definition of the word-selection model
  and its Layer 1/2/3 taxonomy, and the other five sites point there.

- **Code comment audit** (140 files across `src/`, `apps/desktop/src/`,
  `tests/`, `scripts/`, `dev/`; comments only — no user-facing impact).
  A 52-agent audit rationalized the comments accumulated across AI
  sessions: 554 rewritten, 38 deleted (net −475 lines). Removed
  change-narration documenting transitions whose earlier state no longer
  exists, conversation echoes ("per user…", dated session markers),
  stranded/misattached JSDoc, and restating-the-code noise; enforced
  consistent formatting and terminology (code identifiers in backticks,
  user-facing features by their UI names). Unverifiable-but-plausible
  claims (perf measurements, platform anecdotes, Word/Verbatim domain
  knowledge) were kept deliberately. Verified three ways: every changed
  file minifies byte-identically to its pre-audit version (esbuild,
  comments stripped), an adversarial reviewer pass per shard restored
  over-trimmed load-bearing info (7 restorations, 17 drift fixes), and
  typecheck + the full suite stay green. Excluded: experimental
  files, generated `icons.css`, CI-owned `pairing-build.ts`.

- **Terminology: "shading" → "background color" in user-facing text**
  (`settings.ts`, `MANUAL.md`).
  Per maintainer direction, user-facing text uses Word's name for the
  feature. Accessibility settings renamed: "Override shading color in
  display" → "Override background color in display", "Shading override
  colors" → "Background override colors", "Show highlight & shading
  names…" → "Show highlight & background color names…" (labels and
  descriptions only — setting keys, the `shading` mark, and the `Sh:`
  status-bar abbreviation are unchanged; `aliases` with the old wording
  keep palette search working). Two override descriptions were also
  shortened per maintainer wording. MANUAL swept with the convention:
  first use reads "background color (or shading)", every later use just
  "background color". The ribbon and command labels already said
  "Background color", so this closes the gap rather than opening one.
  Released changelog sections keep their historical wording.

## 0.1.0-beta.6 — 2026-07-02

- **Settings navigability: section headers, Files tab, category moves**
  (`settings.ts`, `settings-categories.ts`, `settings-ui.ts`, `style.css`,
  `MANUAL.md`).
  The General / Appearance / Editing tabs had become walls of 20+ rows.
  Two structural changes, per maintainer direction (a third layer — a
  filter box — was proposed and declined): (1) `SettingMeta` gains an
  optional presentational `section` field; the dialog's render loop emits
  an `<h3 class="pmd-settings-section-title">` whenever `section` changes
  between consecutive entries of a tab, so entries sharing a section must
  stay contiguous in SETTING_METADATA (documented on the field). No
  per-tab config table — the manifest stays the single source of truth.
  (2) A new `files` category (tab between General and Appearance)
  collects the 18 file-flow settings that dominated General: new-document
  defaults (onboarding doc, speech-doc folder/format, save format, Pocket
  seed), the Send/Read/Marked preset family (prefix toggle + three
  prefixes + two destination/folder pairs), and the five file-search
  settings. General keeps Workspace / Editor behavior / Word counts /
  Find / Timer / Integrations; Appearance gets Theme & chrome / Document
  typography / Formatting panel / Nav pane & indicators / Timer display;
  Editing gets Typing / Condense / Formatting operations / Insert
  surfaces / Translation. MANUAL's settings-reference chapter rewritten
  to mirror the tab + section order (bold lines = in-app section
  headers). While restructuring, three pre-existing MANUAL drifts were
  fixed: "Show dropzone shelf" was listed under Appearance but has been
  an Editing setting; a "Skip mid-text confirm when inserting quick
  cards" bullet documented a setting that doesn't exist (the mid-text
  guard is a plain `window.confirm` with no toggle) and was dropped; and
  three undocumented settings gained bullets (Layout on this device,
  Keep a Verbatim Flow connection warm, Paragraph spacing), with the
  platform-marker note extended to *(web)* / *(Windows)*. In the same
  push, several settings changed category per maintainer direction: the
  four voice entries (microphone, auto-sleep, dash style, dictation
  model) moved from the top to the bottom of Accessibility; Timer
  profile + Timer durations moved Appearance → General (now the Timer
  section — the other three timer settings, prep label style / compact
  layout / low-time flash, stay in Appearance under Timer display); Cite
  preview on hover + Flashcards-due dot moved General → Appearance (Nav
  pane & indicators), and the one "Settings → General → Flashcards-due
  dot" path reference was updated. Header styling matches the existing
  "About this install" heading; all settings dividers — between rows and
  between sections — share the faint token, with a `:has()` rule
  dropping a row's own divider when it sits against a section boundary
  so lines never stack.

- **Footnote / endnote support** (`schema/nodes.ts` + NEW
  `schema/footnotes.ts`, NEW `import/footnotes.ts`, `importer.ts`,
  `import/index.ts`, `exporter.ts`, `export/index.ts`, NEW
  `editor/footnote-popover.ts`, `style.css`, `MANUAL.md`). Previously
  an open→save cycle destroyed footnotes entirely (references dropped
  by the importer, footnotes.xml never read or written) — a standing
  §3 round-trip violation. Design: a self-contained inline atom
  `footnote` node (the image pattern), attrs { kind:
  footnote|endnote, content: paragraphs of simplified runs {text,
  bold?, italic?, underline?, link?} } — deliberately NOT
  ProseMirror's nested-content footnote (inner EditorView, undo
  handoff): debate footnotes are read-only source citations.
  Import: importNotes() parses footnotes/endnotes.xml (separator
  furniture skipped, the footnoteRef+spacer opening of each body
  stripped, hyperlink targets resolved through the part's own rels);
  references import as empty-bodied markers when the part is absent.
  Export: fresh 1-based ids per part; reference runs use direct
  superscript (no style dependency); parts carry the mandatory
  separator/continuationSeparator entries (Word repair-prompts
  without them); note hyperlinks emit a footnotes.xml.rels with
  escaped targets; content-type overrides + document.xml.rels
  entries only when notes exist. Display: an empty <sup> whose
  number is a pure CSS counter in document order (footnotes 1,2,3…,
  endnotes i,ii,iii… independently — zero JS bookkeeping); click
  opens a popover (title, rendered runs with working links, Edit →
  plain-text textarea → setNodeMarkup; single instance, Escape/
  outside-click dismiss). .cmir support is free (node lives in the
  doc JSON). 7 tests in tests/round-trip/footnotes.test.ts including
  a full toDocx→fromDocx inverse; package structure verified at the
  byte level (well-formed XML, separators, content types, rels).
  Creation: an `insertFootnote` registry command (unbound by default,
  keyboard-only per maintainer — deliberately no Format-menu entry)
  replaces the selection with an empty footnote node and opens the
  popover straight into edit mode (exported `openFootnoteEditor`), so
  the flow is invoke → type → Save. Deletion: a Delete button in the
  popover removes the marker node (error-colored; Backspace over the
  atom in the document works too — the button is the discoverable
  route).

- **Custom dash: configurable trigger** (`settings.ts`,
  `custom-dash-plugin.ts`, `settings-ui.ts`, `MANUAL.md`). New
  `customDashTrigger` ('---' default | '--'). The plugin's original
  header ruled out a `--` rule because it "could never tell a
  forthcoming --- apart" — as an explicit user choice that ambiguity
  dissolves (picking '--' IS the answer). The conversion fires on the
  trigger's last hyphen; in '--' mode the rule refuses to fire
  mid-hyphen-run (a preceding third hyphen — pasted runs, ASCII art —
  blocks it) so only a clean pair converts. Backspace-revert restores
  the configured trigger. The settings row reads "Replace [---|--]
  with [dash style]", both dropdowns gated on the enable checkbox.
  5 new tests (12 total in custom-dash.test.ts).

- **"New paragraph on Enter" settings** (`enter-style.ts` NEW,
  `settings.ts`, `settings-ui.ts`, `index.ts`, `MANUAL.md`). Six
  `enterAfter{Pocket,Hat,Block,Tag,Analytic,Undertag}` settings
  (shared `EnterAfterStyle` union: normal | pocket | hat | block |
  tag | analytic | undertag; all default 'normal' = zero behavior
  change), rendered as ONE settings row — a single shared description
  with six labeled dropdowns on the display-sizes 2-column grid (per
  maintainer: six near-identical descriptions were noise) — in a new
  Editing → "New paragraph on Enter" section. The load-bearing design decision: a non-normal
  choice is DEFINED as "Enter, then that style's command" — the
  handler (`enterWithConfiguredStyle`, bound first in the Enter chain)
  delegates the split to the existing pipeline (tag-keymap overrides,
  then baseKeymap's Enter) and then dispatches the exported
  setHeading/setTag/setAnalytic/setUndertag on the fresh block, so all
  structural edge semantics (card splits, doc-level escapes,
  analytic_unit wrapping) inherit those commands' tested behavior
  instead of duplicating it. Notable inherited consequence, asserted
  in tests: Enter at end of a tag inserts the new body line directly
  under the tag, so Tag → Tag yields a new card that takes over the
  rest of the original card's children, and Tag → Pocket is the
  mid-body split (tag-only card, empty pocket, loose body). 'normal'
  returns false so the untouched pipeline (including user macro /
  ribbon Enter bindings) proceeds exactly as before. The split +
  conversion are two transactions but prosemirror-history groups them
  — one Ctrl-Z reverts both (asserted). 8 tests in
  tests/editor/enter-style.test.ts.

- **Card sharing: reorderable recipients & groups** (`settings-ui.ts`,
  `MANUAL.md`). The send pill renders groups then recipients in raw
  `pairingGroups` / `pairingPartners` array order, but the editors were
  append-only. Each row now carries the Find-category-order up/down
  arrow pair (shared `makePairingReorderButtons`, same button class,
  disabled at the ends) that swaps entries in the settings array itself
  — no new setting, no pill changes (it already rebuilds on settings
  changes), order persists like any settings edit. Groups and
  recipients reorder within their own sections, matching the pill's
  two-section layout. Maintainer decision: the Send to Starred shortcut
  keeps its strict no-op when nothing is starred — sending a card is
  too impactful for a silent fallback to "top of list" — so ordering
  affects the pill only; the star remains the sole shortcut target.

- **Optional undo/redo ribbon stack** (`index.html`, `index.ts`,
  `settings.ts`, `style.css`, `icons.ts`, `scripts/gen-icons.mjs`,
  `icons.css` regenerated, `MANUAL.md`). New `showUndoRedoButtons`
  toggle (Appearance → Theme & chrome, off by default) reveals a
  2-row `.ribbon-button-stack` as `.ribbon-left`'s first child —
  right of the timer panel when that's on the left, left of the file
  buttons. Visibility follows the quick-cards pattern
  (`html.pmd-undoredo-hidden` class in `applyPillVisibility`).
  Buttons run prosemirror-history undo/redo on the focused pane's
  view, swallowing mousedown so the editor keeps selection and focus.
  Two new icons (`undo`/`redo` → Untitled UI `reverse-left/right`,
  classic glyphs ↶/↷): the gitignored icon-source clone was restored
  from github.com/untitleduico/icons, verified byte-identical regen
  against the committed icons.css before adding the MAP entries, then
  regenerated (+6 lines, additive).

- **Timer position setting** (`settings.ts`, `settings-ui.ts`,
  `index.ts`, `style.css`, `MANUAL.md`). New `timerPosition`
  ('left' | 'right', default left) at the top of Appearance's Timer
  display section, rendered as a two-button segmented control (the
  prep-label pattern). Applied as an `html.pmd-timer-right` class →
  one CSS rule gives `#timer-panel` flex `order: 99`, which lands it
  past the right stack at the true edge because `.ribbon-center`'s
  flex-grow absorbs the slack; the panel's separator margin/border
  flips from its right side to its left. No DOM surgery and no
  timer-ui changes — the panel stays the ribbon's first child.

- **Timer transport as bindable commands** (`ribbon-commands.ts`,
  `ribbon-groups.ts`, `MANUAL.md`). Eight new RibbonCommandIds —
  `timerToggleVisible`, `timerStartPause`, `timerPreset1/2/3`,
  `timerStartAffPrep`, `timerStartNegPrep`, `timerReset` — all
  defaulting to no binding (the existing `''` convention), grouped
  under a new "Timer" section in the Keyboard tab (`cycleTimerPreset`
  moved there from View). Each wraps the corresponding
  `timer-state.ts` action behind a shared `timerCommand()` gate: when
  the timer panel is hidden the command returns false so the key falls
  through to other handlers. `timerToggleVisible` is the one exception
  — not gated (its point is bringing the panel up); there was
  previously no registry command for panel visibility at all (the
  ribbon button calls `setTimerVisible` directly). Presets are the one-keystroke version of "click the 9/6/3
  button, then Start" (`loadSpeechPreset` + `startTimer`; a
  missing/zero preset is a no-op), and the prep commands select the
  side's clock and start it. Timer state is BroadcastChannel-synced,
  so keys drive every window like the buttons do. No timer-ui changes;
  timer-state imports nothing, so the new ribbon-commands dependency
  adds no cycle. Also fixed a stale MANUAL path (timer profile /
  durations are under Settings → General since the settings
  reorganization, not Appearance).

- **"No color" is a paintable pen for highlight & shading**
  (`settings.ts`, `ribbon-commands.ts`, `color-panel.ts`, `MANUAL.md`).
  Font color's "Automatic" already worked this way (null persists in
  `lastFontColor`, paint strips); highlight/shading's none swatch was a
  one-shot selection strip that never became the pen.
  `lastHighlightColor` / `lastShadingColor` are now `string | null`
  (null = no-color pen; sanitizers preserve explicit null; defaults
  unchanged). Pen consumers updated: `applyHighlight` / `applyShading`
  (F11 / Mod-F11 / main button / paintbrush) with a null pen always
  strip — the color toggle branch is untouched; `highlightAcronym`
  strips the first-letter ranges; `uniHighlight` / `uniShade`
  ("standardize onto none") strip every marked run in scope, leaving
  unmarked text untouched. The picker's none swatch now persists the
  pick AND strips the selection (the same persist-and-apply shape as
  colored swatches — its strip keeps the trailing-space trim via the
  existing helper, which `setHighlightColor` deliberately doesn't do).
  Indicator bars and the paint-cursor swatch render the null pen as
  plain white (maintainer call: no strikethrough). Untouched by
  design: `setHighlightColor`/`setShadingColor` stay string-only (their
  only null-adjacent caller is the picker, and voice's `applyPen`
  guards on `pen.color`); the experimental port already null-safes with
  `|| 'yellow'` (no changes near the live experiment); the status-bar
  Hl:/Sh: names read marks at the cursor, not the pen. Two null-pen
  regression tests added to ribbon-commands.test.ts.

- **Accessibility: nav-pane analytic italics toggle** (`settings.ts`,
  `index.ts`, `style.css`, `MANUAL.md`). Color-audit item (LOW-MEDIUM):
  analytic entries in the nav pane are marked by text color alone
  (`--pmd-color-analytic` on the label) — and the investigation showed
  the cue is worse than hue-confusable: it's entirely absent in dark
  mode (the nav forces uniform white text) and in the flat nav
  (`formatNavPaneByType` off overrides it to inherit). New
  `navAnalyticItalics` toggle (Accessibility, off by default, gated per
  maintainer direction rather than always-on) sets an
  `html.pmd-nav-analytic-italic` class — the `pmd-nav-flat` pattern —
  and one CSS rule italicizes `.pmd-nav-type-analytic .pmd-nav-label`.
  font-style survives both the dark-mode color override and the flat
  nav's flattening, and covers the single-doc panel and multi-pane rail
  (both render the same entry classes). Declined the audit's
  alternative (leading glyph) — italics mirror the editor surface's
  own analytic typography convention. The prep-timer 'color' label
  mode item from the same audit list was closed won't-fix: the
  text/both label modes exist precisely as the non-color channel, and
  'color' is an explicit user opt-out.

- **Accessibility: autosave inert state is now hollow, not just amber**
  (`style.css`, `MANUAL.md`). Color-audit item (MEDIUM, data-loss
  consequence): the autosave toggle's two on-states — effective (blue
  filled) vs inert/armed-but-not-firing (amber filled) — were
  geometrically identical, distinguished by hue plus a hover tooltip
  that the ribbonTooltipMode setting can disable entirely. The inert
  state now drops its background fill and draws a 1.5px dashed
  warning-color outline (outline + negative offset, not border, so no
  layout shift): filled block vs dashed hollow reads in full grayscale,
  and the dashed stroke connotes "armed but not engaged". Applied at
  the button level rather than as a hollow icon variant — the icon
  glyphs are generated assets in two icon sets (Untitled UI line +
  classic emoji), so an icon-level treatment would need new artwork in
  both for less visual payoff. A :focus-visible override restores the
  ribbon's standard solid focus ring, which the persistent outline
  would otherwise swallow. CSS-only: the state attributes
  (aria-pressed + data-autosave-effective) already existed and are
  live-maintained by refreshAutosaveBtn.

- **Fix: voice-model download offer was unreachable at session start**
  (`apps/desktop/src/voice/ipc.ts`, `voice/controller.ts`). The
  first-use flow shipped with the model-download feature intended
  Ctrl-Shift-V on a model-less install to return `voice-model-missing`
  so the controller offers the download. But `resolveVoiceAssets()`
  returned null unless BOTH libvosk and the model resolved, and the
  start handler derived `libPresent` from that collapsed null — so a
  fresh install (libvosk bundled, model not yet downloaded) always
  reported `voice-assets-missing` and showed the dead-end
  "set CARDMIRROR_VOICE_DIR" toast. Slipped through testing because the
  model had been downloaded via the settings widget (separate presence
  probe) before any cold session start. The resolver now returns
  `{ libPath, modelDir }` with independent nulls and the handler checks
  the pieces separately; `voice-assets-missing` now genuinely means
  libvosk is absent (broken install), and both toasts were reworded
  (reinstall / update guidance first, the env var demoted to a
  developer hint). Found while confirming the dev-only variant of the
  symptom: dev builds resolve libvosk from the recognizer spike's cache
  (`spikes/voice-recognizer/lib/`), not from `resources/voice/`, so
  after `npm run fetch:voice` the lib must also land there.

- **Accessibility: persistent voice-mode badge** (`voice/ui.ts`,
  `style.css`, `MANUAL.md`). Color-audit item (MEDIUM-HIGH): the voice
  session's mode was conveyed by dot hue + a matching editor-boundary
  ring — dictation green vs paint amber is a classic red-green
  confusion pair — and the only text redundancy was the transition hint
  `setMode()` wrote into the echo slot, silently overwritten by the
  next recognized word. The pill now carries a dedicated mode badge
  (command / dictation / paint / asleep chip between the dot and the
  pen badge, styled in the pen chip's language: mixed case, mode-
  colored text on the matching soft tint — accent/success/warning-soft,
  the same tokens as the editor ring) that only `setMode()` writes, so
  echo traffic can never clobber it. The color-vision preset remaps the
  tokens for free. With the badge naming the mode persistently, the
  echo's mode narration became redundant on screen and was trimmed:
  `setMode` now clears the echo for command/dictation and keeps only
  guidance the badge can't carry ('say "voice wake" to resume', 'speak
  words to ink them'), and the post-calibration message dropped
  '— command mode'. The badge is aria-live polite so mode changes stay
  announced to screen readers now that the echo no longer narrates
  them. Always-on by design (no toggle — it corrects a feedback gap
  rather than adding a presentation preference).

- **Accessibility: annotation underline shapes toggle** (`settings.ts`,
  `index.ts`, `style.css`, `MANUAL.md`). The color audit flagged the
  in-document annotation ranges as HIGH severity for red-green CVD: the
  flashcard / AI-thread / private-note decorations shared an identical
  2px-solid contrast-edge underline and differed only by tint hue
  (accent blue / purple / green) — and purple collapses toward blue when
  the red channel is impaired. New `annotationShapes` toggle (off by
  default, deferred from the audit at maintainer direction as its own
  feature) drives `data-annotation-shapes` on the document root — fifth
  use of the attribute-swap pattern — and a CSS block adds the per-kind
  underlines: comment 1px dotted, flashcard 2px solid, AI 2px dashed,
  note 3px double (double needs ≥3px to draw two lines). Per maintainer
  direction the toggle OWNS the underlines outright: with it off, all
  annotation ranges render as tint + the accent click-outline
  (.pmd-annotation-active) only — both the previous always-on 2px solid
  underline on flashcard/AI/note and the always-on dotted comment
  underline are gone. Known tradeoff, accepted by the maintainer: the
  comment dotted underline was the fix for gold-tint-on-yellow
  invisibility (a comment tint on matching highlighted text can
  vanish); with the toggle off that cue is absent. To compensate for
  losing the underlines, all four tints were strengthened ~5 points
  (comment gold 0.12→0.17 light / 0.18→0.23 dark, flashcard accent
  13%→18%, AI + note 14%→19%); the color-mix percentages reference the
  identity tokens, so the color-vision preset inherits the change. This
  mirrors in-document the text redundancy the comments column's type
  chips already provide. No decoration/plugin changes — the per-kind
  classes already existed; underlines keep the theme-contrast edge
  token, so the toggle composes with light/dark and with the
  color-vision preset.

- **Accessibility: color-vision friendly palette preset** (`settings.ts`,
  `index.ts`, `style.css`, `MANUAL.md`, `ARCHITECTURE.md`). New
  `colorVisionFriendly` toggle drives a `data-cvd="friendly"` attribute on
  the document root via `applyColorVision()` — the fourth use of the
  attribute-swap pattern (`data-theme`/`data-icons`/`data-motion`). Two CSS
  token blocks remap the meaning-carrying hues onto the Okabe–Ito palette
  (distinguishable under protanopia, deuteranopia AND tritanopia — one
  preset instead of three per-type ones, per maintainer decision): blue
  anchor (accent/focus/link/Aff), vermillion (AI identity + Neg), bluish
  green (notes/success/dictation/paragraph-repair), current-find-match
  stepped to vermillion with a luminance drop so it survives grayscale, and
  all category chips; a `[data-theme="dark"][data-cvd]` block brightens for
  dark. Precedence comes free from the architecture: hand-set Color
  overrides are inline styles and beat the preset; the preset beats base
  themes by cascade position. Deliberately not remapped: OOXML band colors
  (document data — mitigated by the status-bar names toggle), band
  foregrounds (pure luminance contrast already), comment gold + warning
  amber (already CVD-safe), error reds (text-redundant). Declined the
  audit's suggestion to auto-seed the highlight-override slots — a display
  preset silently rewriting other settings can't be cleanly undone; the
  description points at the companion settings instead. ARCHITECTURE §15's
  deferred list updated.

- **Accessibility: 20 more tokens in the Color overrides allowlist**
  (`settings.ts` CUSTOMIZABLE_COLOR_TOKENS, 37 → 57 entries). Added the
  meaning-carrying hues from the color-semantics audit so colorblind users
  have direct recourse before dedicated presets exist: prep-timer Aff/Neg
  (color is the ONLY signal in the timer's "color" label mode), the
  annotation accent family (AI comment purple / private note green / AI
  repair green — flagged as hue-only distinctions), hyperlink blue,
  misspelling-underline red, the due-date dot, the find-match highlight pair,
  and all ten category-chip tokens (bg + fg × heading/tag/cite/analytic/
  undertag). Translucent tokens work because the overrides widget already
  has an alpha slider with rgba round-tripping (originally added for the
  modal scrim). Deliberately excluded: `--pmd-c-band-fg-light/dark` — text
  contrast on the fixed OOXML bands is a paired decision that belongs to
  preset authoring, and a bad standalone pick makes highlighted document
  text invisible. Zero widget changes: the manifest design (runtime
  defaults via getComputedStyle, sanitizer keyed on the manifest) makes
  additions declarative.

- **Accessibility: standalone "Show highlight & shading names in the status
  bar" toggle** (`settings.ts`, `index.ts`, `MANUAL.md`). The status-bar
  cursor-color readout (actual stored highlight/shading names via
  `highlightColorLabel`) existed but was gated on the display overrides —
  the exact mechanism a colorblind user needs, locked behind an unrelated
  setting. New `showCursorColorNames` toggle shows it independently; each
  part (Hl/Sh) renders if its override OR the toggle is on. This is the
  chosen mitigation for the top hazard in the color-semantics audit (the 15
  OOXML hues carry author meaning and collapse under red-green deficiency).
  No new refresh wiring needed: the settings subscription already re-runs
  the readout, and multi-pane was already live because the pane dispatch
  re-runs setActiveView (which refreshes all status-bar chrome) per
  focused-pane transaction — the readout reads the focused pane's view.

- **Multi-pane chip: focused-chip hover glyphs are theme-invariant**
  (`src/editor/style.css`). Hovering the focused chip's outline/expand
  buttons flipped the glyph to `--pmd-c-text-strong` — black in light mode
  (visible) but WHITE in dark mode, identical to the resting on-accent
  glyph, so the hover was invisible there. The chip's accent fill is
  effectively theme-invariant, so its hover glyph now is too: new
  `--pmd-c-on-accent-hover` (#000) in the theme-invariant token group,
  applied via a focused-chip variant. (User call: match light-mode
  behavior in dark mode rather than invent a third treatment.)

- **Multi-pane chip: pressed nav/expand buttons use a box, not an accent
  glyph** (`src/editor/style.css`). `aria-pressed` on the unfocused chip's
  outline + expand buttons colored the glyph `--pmd-c-accent` (from the
  nav-rail PR, 5743557). Because outlines default open on every pane, the
  accent glyph was effectively always-on — reading as an inexplicably blue
  icon rather than a state indicator (user report). Now a subtle
  `--pmd-c-hover-strong` box with the glyph color unchanged, consolidating
  the two rules into one and matching the on-accent-overlay box the FOCUSED
  chip already uses for the same states. Also a marginal win for the
  colorblind-hazard list: state is now shape+contrast, not hue.

- **Fix: invisible hover states on multi-pane footer buttons + receive pill**
  (`src/editor/style.css`). The pane open-file button, doc-stack chip,
  slot-picker buttons, and recovery-sidebar Done button had hover rules
  pointing at the never-defined `--pmd-c-surface-3`, falling back to
  `--pmd-c-surface` — the same color as the footer they sit on, so the hover
  painted the color already underneath it. A no-op since multi-pane's
  first-cut commit (bd37dc0); surfaced by user testing after the dedup pass
  made the group visible. Now `--pmd-c-hover`, the token that phantom was
  reaching for. The receive pill separately had NO hover rule; added one at
  `--pmd-c-hover-strong` (its resting bg is already `--pmd-c-hover`) with a
  `:not(.pmd-receive-badge-unread)` guard so hovering an unread badge doesn't
  gray out its accent fill.

- **CSS dedup: 28 copy-pasted rule groups consolidated to grouped selectors**
  (`src/editor/style.css`, −249 lines / −7 KB minified). The audit's dedup map
  found ~90 rules whose bodies are exact duplicates across feature families —
  the 7× modal overlay, 9× input focus ring, 8× accent-fill CTA, 8× hover
  highlight, plus modal headers/buttons/close, layout utilities, category
  chips, and more. Each group is now ONE rule with a grouped selector list and
  a comment stating the shared role ("diverge by pulling a selector out, not
  by re-copying"). Pure CSS change — no base classes added, no TS touched
  (that's the future modal-helper refactor's job). Every consolidation was
  machine-verified first: member bodies byte-identical, or identical up to
  declaration order with no duplicate properties (9 groups were order-scrambled
  copies). Consolidated rules live at their first member's original position;
  feature-specific overrides (`:hover`, `-primary`, z-index) all remain later
  in the file. The read-mode `:is()` consolidation suggestion was deliberately
  deferred.

- **Color-compliance pass: ~100 hardcoded colors tokenized** (`src/editor/style.css`,
  `benchmark-ui.ts`, `window-coordination.ts`). Audited the whole codebase
  against ARCHITECTURE.md §15 ("a hardcoded color anywhere is a bug") via a
  multi-agent sweep, reviewer-verified. Compliance was already ~94%; the
  violations clustered in a few late-added features (repair UI, benchmark
  overlay, home-screen file tools, prep-timer Aff/Neg, OOXML band foregrounds).
  Every literal outside the token-definition blocks is now a `var(--pmd-c-*)`
  except the 15 sanctioned OOXML highlight *backgrounds* (document data) and
  `index.html`'s `theme-color` meta (read by the OS before CSS loads). Also:
  defined seven **phantom tokens** that were referenced-but-never-defined
  (`--pmd-c-aff`/`-neg` given real values; five others collapsed onto their
  fallback token), stripped 49 dead `var(--token, #literal)` fallbacks where
  the token is defined, and grouped new feature accents (repair green,
  aff/neg, band foregrounds, bench chip) as explicitly theme-invariant tokens
  so a future colorblind/high-contrast preset can add dark/preset variants in
  one block without touching call sites. User-visible effects are limited to
  the dark-mode home-screen file tools (previously stuck light — now themed)
  and two tiny light-mode hue shifts (pairing unread badge → standard accent
  blue; one repair error border → `--pmd-c-error-alt`). NOTE for future
  tokenization work: a literal-free grep is NOT sufficient verification — a
  self-referential token (`--x: var(--x)`, which a naive global find/replace
  can create) is also literal-free but renders nothing; confirm tokens
  *resolve*, and watch for a whole feature's color vanishing, not just wrong
  shades. (One such cycle was introduced and caught in dev here.)

First tier of fixes from a systematic performance & housecleaning audit
(multi-agent review across hot paths, startup, memory, the Electron main
process, and repo hygiene; every finding adversarially verified before
acceptance).

- **Settings dialog: per-row document-wide MutationObservers replaced with
  explicit disposal** (`src/editor/settings-ui.ts`). The `onDetached(el, cb)`
  helper ("run cleanup when the row leaves the DOM") created a NEW
  MutationObserver on `document.documentElement` `{childList, subtree}` per
  call — ~28 call sites per render (one per toggle row plus one per widget
  editor), so one Settings open instantiated ~60 document-wide observers,
  each pairing a `settings.subscribe()`. `close()` only hides the singleton
  overlay, so nothing ever detached: after closing Settings once, every DOM
  mutation for the rest of the session dispatched through all of them, and
  every settings change kept rebuilding hidden widget DOM (the file's own
  comment calls this subscriber class "the dominant settings lag on large
  docs"). Now `registerRowCleanup` pushes the callback onto a disposer list
  flushed by `close()` and at the top of `render()` — zero observers, and
  subscriptions live only while the dialog is open. The narrowed contract
  (cleanup at close/re-render, not at actual detach) is documented on the
  helper; no current caller detaches elements mid-session.

- **Journal + autosave: gzip moved off the main thread**
  (`src/native/codec.ts`, `src/native/index.ts`, `src/editor/index.ts`,
  `src/editor/multi-pane-shell.ts`, new `tests/native/serialize-async.test.ts`).
  Every pause in typing arms the 3s journal write (always) and the 5s
  autosave (opt-in, .cmir) — both ran `serializeNative`'s fflate `gzipSync`
  level 6 synchronously on the renderer main thread, a 50–300ms freeze on
  large docs landing right when typing resumes (doubled with autosave on;
  duplicated per record in multi-pane). New `gzipAsync` in the codec uses
  fflate's worker-backed async `gzip` with the same `{level: 6, mtime: 0}` —
  byte-identical output (unit-tested), preserving the codec's determinism
  guarantee — with a remembered fallback to sync where Workers are
  unavailable. `serializeNativeAsync` shares the envelope builder with the
  sync variant; the four debounced paths (single-doc journal + autosave via
  `serializeForSave`, per-record journal + autosave) now use it, which also
  makes MANUAL .cmir saves smoother for free. Journal/autosave rounds are
  now chained per doc (module promise / per-record WeakMap) so two in-flight
  writes can't land out of order — a pre-existing theoretical race the async
  gzip would have widened. The JSON envelope build (`doc.toJSON` +
  `JSON.stringify`) stays on the main thread by necessity (it reads the live
  doc), so the very largest docs keep a small synchronous blip per pause —
  the dominant ~70% (compression) is what moved off-thread.

- **Dead-export sweep: 17 unreferenced exported symbols deleted, 5
  annotated as spec references** (audit H-3; ten files across src/ +
  apps/desktop). A repo-wide reference scan (re-verified fresh before each
  deletion; every symbol occurred exactly once — its own declaration)
  found 23 exported symbols nothing imports or calls. Git archaeology
  sorted them: one true refactor orphan (`personaInitials` — its caller
  was removed in 92cd31b, which cleaned the import but not the export);
  the rest were born unreferenced as speculative API symmetry
  (`subscribePins`/`isManualPinned` + the whole pins-store listener
  apparatus, `removeFlashcardRangeTr`, `getMobileUnitSelection`,
  `isMultiPaneActive`, `withRepairFlash`, `clearSimilarSelection`,
  `setSpeechDocResolver`, `DEFAULT_FILE_OBJECT_KINDS`,
  `isBodyTextblock`/`isStructuralTextblock`, `findChildren`,
  `textEl`/`rootNamespaces`, `ensureId`, `voiceSessionInfo`). Deliberate
  keepers: one experimental integration hook (untouched by decision),
  and word-break.ts's five unit-boundary
  functions, now under an explicit "spec reference implementations"
  banner — their doc comments claimed they served Ctrl+Arrow caret
  movement, but the live caret code walks `classifyChar` directly; the
  comments now say so instead of misleading. Zero shipped-byte change
  (tree-shaking already dropped them); this is maintenance-rot and
  stale-documentation cleanup.

- **jszip dropped; the .docx container now runs on fflate**
  (`src/ooxml/docx.ts`, `src/editor/bulk-convert-ui.ts`,
  `tests/round-trip/structural-validity.test.ts`, `package.json`,
  `THIRD-PARTY-NOTICES.md`). The app shipped two DEFLATE implementations:
  fflate (the `.cmir` codec) and jszip's bundled pako fork, used only by
  the `Docx` wrapper class and bulk-convert's zip output (audit P-9). The
  `Docx` class now holds a part-name → bytes Map over fflate's
  `unzipSync`/`zipSync` (insertion order preserved, so loaded files
  re-serialize with their original part order; level 6 as before). Public
  API unchanged — async signatures kept so no caller moved — except the
  never-used `raw(): JSZip` escape hatch, deleted (it was the one thing
  leaking the JSZip type). Bulk-convert's output zips switch from jszip's
  default STORE to deflate (smaller, still standard). Verified: the full
  ooxml/import/export/round-trip suites, plus `bin/round-trip` on a real
  Word-produced .docx with images — identical structure/mark counts, the
  fflate-written file re-imports as a byte-identical fixed point, and the
  archive passes system `unzip -t`. Both a fresh export and the image-bearing
  round-trip file were then opened in Microsoft Word directly: clean open,
  no repair prompt. Main chunk 1,263 → 1,168 KB; one zip implementation and
  one fewer dependency (JSZip removed from THIRD-PARTY-NOTICES).

- **Startup: Settings subtree lazy-loaded** (`src/editor/index.ts`,
  `quick-card-search-ui.ts`, `settings-ui.ts`, new `settings-categories.ts`
  + `benchmark-state.ts`). The entry point statically imported
  `openSettings`/`closeSettings`, chaining the app's largest UI module
  (settings-ui, 4,100+ lines) plus keybindings-editor, benchmark-ui,
  benchmark.ts, and benchmark-sample's embedded card text into the main
  chunk — parsed on every launch though most sessions never open Settings
  (audit P-10). Two extractions unblocked the split: `settings-categories.ts`
  (CATEGORY_TABS / visibleCategoryTabs / SettingsTarget) so the palette's
  `s`-prefix search stops pinning settings-ui, and `benchmark-state.ts`
  (the is/setBenchmarkActive flag) so dispatchTransaction's hot-path check
  stops pinning the benchmark harness. The three openSettings call sites go
  through a cached dynamic import (recovery-ui pattern); the one
  closeSettings site is guarded on the module having been loaded (never
  fetch the chunk just to close a dialog that can't be open). Main chunk
  1,366 → 1,263 KB (−103 KB; gzip −26 KB); settings-ui is its own 110 KB
  chunk fetched on first open (instant on desktop, PWA-precached on web).
  Byte-verified the benchmark sample string left the main chunk.

- **THIRD-PARTY-NOTICES.md: cover everything that actually ships**
  (`THIRD-PARTY-NOTICES.md`). The file previously listed only ProseMirror
  and the Untitled UI icons, while claiming to satisfy the project's
  attribution obligations — but the bundle compiles in fast-xml-parser,
  fflate, JSZip, nspell, and tinyld (renderer) and koffi + electron-updater
  (main process), none of which ship a `node_modules/` whose notices could
  be "preserved" (audit H-10). Added an MIT section reproducing the license
  once with a per-library copyright table, cross-linked the existing
  `src/editor/fonts/LICENSES.md` for the bundled fonts, added an entry for
  the bundled Hunspell English spellcheck dictionary (SCOWL-derived), and an
  entry for Vosk (`libvosk` + models, Apache-2.0) — noting the models are now
  a runtime download (see the voice-model change) rather than installer
  contents. JSZip is documented as used under MIT (its dual MIT/GPL offer);
  it will drop off this list when P-9 (jszip → fflate) lands.

- **Voice: base recognition model + Node runtime are first-use downloads,
  not bundled** (`apps/desktop/src/voice/ipc.ts`, `preload.ts`,
  `scripts/fetch-voice-assets.cjs`, `src/editor/voice/controller.ts`,
  `settings-ui.ts`, `settings.ts`, `MANUAL.md`). The installer shipped the
  standard model (~230 MB extracted) plus a standalone Node runtime (~30 MB
  compressed) in `resources/voice/` for every user, though most never enable
  voice (audit finding P-13). Now `fetch-voice-assets.cjs` bundles only
  libvosk by default (kept in the signed artifact — a downloaded native
  `.dylib`/`.so`/`.dll` would raise Gatekeeper/library-validation issues that
  pure-data model files don't); the base model downloads on first use into
  `{userData}/voice-models/…-lgraph`, mirroring the existing large-model flow
  (`downloadLargeModel`), and the Node runtime (needed only by the large
  model — Electron's allocator SIGTRAPs on it) is fetched alongside the large
  model. `resolveVoiceAssets` now resolves lib and model independently and
  checks userData before packaged resources, so **existing fat installs keep
  working** until they update. `voice-start` returns a distinct
  `voice-model-missing` (vs `voice-assets-missing`) when libvosk is present
  but the model isn't; the controller then offers a one-time download and —
  by explicit UX decision — does NOT auto-start when it lands (a multi-minute
  download outlasts attention; a surprise hot mic is worse than a second key
  press), instead notifying via a modal so the "ready" state can't be missed.
  Settings → Accessibility → **Dictation model** gains a "Download standard
  model" button beside the existing large-model one (pre-fetch before going
  offline), with the two sharing one progress channel (tagged by `model`).
  A `--full` flag on the fetch script reproduces the old fat bundle for an
  offline-appliance build. Net: installer ~130 MB smaller, installed
  footprint ~250+ MB smaller for non-voice users. Trade-offs: first-time
  voice users wait for a one-time download (mitigated by the Settings
  pre-fetch + a MANUAL note), and an updated install that previously used
  voice re-downloads the model once.

- **Search palette: paginated results (100 per page, "show more")**
  (`src/editor/quick-card-search-ui.ts`, `style.css`, `MANUAL.md`). The
  palette hard-capped every search at 50 rows with no indication anything
  was cut off. Ranking always ran over the full source list; the cap only
  bounded DOM construction — so `finishSearch` now keeps the full ranked
  list (`fullResults`) and renders a window of `RESULT_PAGE_SIZE` (100)
  rows. When more exist, a trailing "Showing X of Y — show more" row
  extends the window by a page; ArrowDown past the last rendered row does
  the same instead of wrapping (the keyboard path). A div rather than a
  button so clicks can't steal focus from the search input. The in-file
  outline browse stays deliberately un-paginated (it's a nav-pane-style
  overview); its two direct render paths keep `fullResults` in sync so no
  overflow row appears. Uncapping entirely was considered and rejected:
  file libraries at real scale (~150k indexed .cmir files on the reference
  machine) can match tens of thousands of rows on broad queries, and
  building that much DOM per keystroke would freeze the palette for
  seconds; pagination gives access to everything while bounding each
  build. Selection restores (`togglePinPath`, `restoreSelection`) also now
  use the O(1) in-place `setSelected` instead of full rebuilds.

- **Multi-pane: caret clicks no longer re-resolve the whole document's
  annotations** (`src/editor/multi-pane-shell.ts` `focusSlot`). Every pane
  mousedown called `commentsColumn.refreshFlashcardAnchors()` (full
  `flattenDoc` walk + descriptor re-resolution + a dispatched transaction +
  cards re-render) and re-attached the scroll-sync listener, even when the
  clicked pane was already focused — the `wasSame` guard existed but only
  gated `setActiveView`. Both calls now live inside the guard; the
  incremental paths (`reconcileAnchors`, highlight-range mapping,
  `lastDropCount`) keep anchors current between actual focus changes.

- **Quick-card palette: selection moves no longer rebuild the list**
  (`src/editor/quick-card-search-ui.ts`). Hovering across rows or holding an
  arrow key tore down and rebuilt every result row per event
  (`innerHTML = ''` + 4–6 elements and 2–4 listeners per row + a forced
  layout) — O(rows²) across a mouse sweep, and outline-browse mode is
  deliberately uncapped, so on big files that was hundreds of rows per
  hover twitch. New `setSelected` swaps the active class/aria-selected
  between the two affected rows, refreshes the hint strip (Enter/Tab/pin
  hints are per-row-type), and scrolls the new row into view; full rebuilds
  are reserved for changes to the result set itself. Same treatment applied
  to the tag picker's `renderList`.

- **Find/Replace: incremental doc-change rescan**
  (`src/editor/find-replace-plugin.ts`, new
  `tests/editor/find-replace-incremental.test.ts`). With a query active, every
  doc-changing transaction re-ran `findMatches` over EVERY textblock in the
  doc — O(doc chars) time plus a per-block offset-map allocation per keystroke
  while the find bar was open. Now the existing matches are mapped through
  `tr.mapping` (they live in untouched textblocks, so mapping is exact) and
  only the top-level children the change touched are re-scanned
  (`changedRange` + `expandToTopLevel`, the same helpers font-size-class and
  read-mode already use), then the merged list is re-sorted with the existing
  comparator. Falls back to the full rescan when the list is at
  `FIND_MATCH_CAP` (which hits survive the cap depends on whole-doc scan
  order) or when the scope band collapses (the search re-widens doc-wide).
  The active match now survives edits by its MAPPED position, so typing above
  the current hit no longer risks bumping the selection to a different match.
  The contract — incremental result set identical to a full rescan — is
  enforced by a 14-case equivalence suite incl. a deterministic 40-edit fuzz.
  Synthetic worst case (3,000 paragraphs, 3,000 hits): 3.7ms → 0.5ms per
  keystroke; real docs (fewer matches) improve far more.

- **Find/Replace: results panel + nav markers debounced off the keystroke
  path** (`src/editor/find-replace-ui.ts`). The `input`/`keyup` handler on the
  editor DOM synchronously rebuilt up to 500 snippet rows (`innerHTML = ''`,
  `doc.resolve` + `textBetween` + a listener per row) plus a full nav-panel
  render per keystroke — the identity guards never hit because the plugin
  returns a fresh matches array per rescan. The O(1) count label stays
  synchronous; the O(matches) rebuilds now coalesce behind a 150ms trailing
  timer (cleared on bar close).

- **Startup: tinyld's language model moved out of the main chunk**
  (`src/editor/translate.ts`). A static `import { detect } from 'tinyld'`
  embedded the 577 KB n-gram model (~30% of the main chunk), parsed on every
  launch, to serve one fallback — source-language detection when MyMemory
  translation runs with source='auto'. `detectSourceLanguage` now dynamically
  imports tinyld inside its existing try/catch (chunk-load failure degrades to
  the same "pick a source language" error). Main chunk: 1,957 KB → 1,366 KB.
  Deliberately NOT the 69 KB `tinyld/light` build: tested empirically, light
  misidentifies several picker languages with confidence (uk→ru, cs→fi,
  vi→hu, fa→ar, id/ms→tr), which would silently mistranslate; the full model
  scores 27/29 on the picker language set vs light's 21/29.

- **Desktop: folder-wide Compress off the main-process event loop**
  (`apps/desktop/src/main.ts`). `host:bulk-compress` ran `gzipSync` +
  `gunzipSync` (the losslessness verify) per file on the Electron main
  process — ~100–300ms of event-loop blockage per multi-MB `.cmir`, stalling
  every window's IPC (journal writes, autosaves, menus, dialogs) for the
  duration of a run. Now `util.promisify(zlib.gzip/gunzip)` on libuv's thread
  pool; identical output bytes, level 6, same per-file order / verify / mtime
  restoration.

- **Desktop: temporary cross-window debug probe removed** (`main.ts`,
  `preload.ts`, `src/editor/host/electron-host.ts`, `src/editor/index.ts`;
  ~250 lines). The self-labeled TEMPORARY probe (`xlog` / `pathForensics` /
  `dedupeNearMisses`, the per-window focus/blur/hide/show listeners, the
  renderer→main `host:debug-log` bridge, and the `modeSwitchAskedAt` timing
  map) shipped in release builds, appending an uncapped JSON log to
  `{userData}/cross-window-debug.log` on every focus change (1.4 MB in ~3
  weeks on one machine) and running sync `realpathSync` forensics inside the
  file-open IPC handlers. The investigation it served is driven by crash
  dumps instead. The behavior it observed (mode-switch close/destroy timing,
  open-path dedup) is untouched. The stale log file is deleted at boot as a
  one-time cleanup, and the accessibility-crash telemetry that piggybacked on
  the boot log survives as two plain console lines.

- **Leftover per-keystroke debug logging removed**
  (`src/editor/multi-pane-shell.ts`, `nav-panel.ts`, `speech-doc-send.ts`).
  The `[cardmirror] wc:` warns from the 2026-06-10 stale-word-count hunt
  fired on every doc-changing transaction in multi-pane mode (plus per
  debounced flush and per `refreshWordCount`), and the mobile nav-pan
  `console.log` did forced-layout reads purely to build its message. The
  `navPanel.update` catch now reports via `console.error` instead of being
  deleted with the rest — it was the only error visibility on that path.

- **Three-pane: slot-picker keydown listener leak / swallowed digit**
  (`src/editor/multi-pane-shell.ts`). `promptForSlot` removed its
  document-level keydown listener only on the Escape / digit paths; completing
  the picker with the MOUSE leaked it, and the stale handler
  `preventDefault()`ed the next unmodified 1/2/3 typed into the editor before
  self-healing. All four resolution paths now route through one `finish()`
  that detaches the listener.

- **Desktop package declares its compiler**
  (`apps/desktop/package.json` + lockfile). `build:main` runs `tsc` but
  typescript was undeclared in the desktop tree — it resolved only via npm's
  ancestor `.bin` PATH from the ROOT devDependency, undermining the package's
  documented self-contained `npm --prefix apps/desktop ci` install. Declared
  `typescript ^5.7.2` (resolves to the same 5.9.3 the root uses).

- **Repo hygiene** (`.gitignore`): local investigation working docs
  (WHITE_SCREEN_*, CRASH_REPORTING_SCOPE, PERF_HOUSECLEANING_AUDIT,
  repro-white-screen.ts) no longer clutter `git status`.

## 0.1.0-beta.5 — 2026-07-01

- **Web: suppress password-manager DOM crawl on palette / Find focus**
  (`src/editor/autofill-ignore.ts` new, `quick-card-search-ui.ts`,
  `find-replace-ui.ts`, `README.md`). A user-supplied Chrome performance trace
  of a "slow to open" command palette showed ~2s per open spent entirely in
  extension content scripts (1Password's `injected.js` `$t`/`findLabelText`,
  a second autofill extension's `querySelectorAllIncludingWithinShadowRoots` /
  `_collectTextSample`), driven by a full-document `TreeWalker` +
  per-node `getBoundingClientRect` — triggered by the `focusin` that fires when
  the palette focuses its search `<input>`. Our own code was 0.3% of the freeze;
  it's O(DOM) so it scaled with doc size, and web-only because Electron loads no
  extensions. `autocomplete="off"` was already present and (as expected) ignored
  by the managers, so a new `autofill-ignore.ts` centralizes the vendor opt-out
  hints (`data-1p-ignore`, `data-lpignore="true"`, `data-bwignore`,
  `data-form-type="other"`) as both an attribute string (for `innerHTML`
  templates) and a `suppressAutofill(el)` helper (for `createElement`). Applied
  to the search palette input and both Find/Replace inputs. Best-effort — a
  manager may still collect page details on load/mutation — so the README gains a
  note pointing users to Chrome's per-site "run on click" extension access as the
  guaranteed fix.

- **Web edition: installable PWA + offline** (`vite.config.ts`, `public/` icons,
  `index.html`, `src/editor/host/browser-host.ts`). Added `vite-plugin-pwa`: a web
  app manifest (`display: standalone`, maskable icon, base-aware `start_url`/scope
  for the `/cardmirror/` Pages deploy) and a Workbox service worker precaching the
  app shell for offline use, `registerType: 'prompt'` so a running editor is never
  force-reloaded. The plugin is gated to the WEB build only — the Electron renderer
  reuses the same `vite build` with `--base=./`, which is detected and skips the
  plugin (no service worker under `file://`). A `NO_PWA=1` env flag builds without
  the SW for local iteration. `BrowserHost` now calls `navigator.storage.persist()`
  so the install's IndexedDB/localStorage isn't evicted.

- **Web edition: in-session in-place save** (`src/editor/host/browser-host.ts`,
  `electron-host.ts`, `host/types.ts`, `src/editor/index.ts`, `style.css`). Web
  `openFile` now uses `showOpenFilePicker` (Chromium) to obtain a
  `FileSystemFileHandle`, falling back to the handle-less `<input>` elsewhere; the
  handle is threaded through the file-state model (previously coerced to null in
  `resolveOpenedFile`, which forced Save-As), so Save writes back via
  `handle.createWritable()`. The picker's accept types now drop extensions the File
  System Access API rejects (e.g. `-` in `.cmir-journal`; still reachable via "All
  files"). New host method `ensureWritable(handle)` (no-op `true` on Electron)
  requests the readwrite permission from a user gesture at the START of Save
  (before serialize) and when autosave is toggled on — so the prompt appears on
  save intent, not on open; `saveExisting` only verifies (never prompts) so a
  gesture-less autosave fire fails cleanly. The autosave button is gated on a new
  `pmd-inplace-save` body class (Chromium browser or Electron) instead of host kind.

- **Web edition: direct clipboard read for Paste Text** (`src/editor/ribbon-commands.ts`,
  `src/editor/index.ts`, `index.html`, `style.css`, `ribbon-tooltips.ts`). F2 /
  Paste-and-Condense now read the clipboard via `navigator.clipboard.readText()` on
  the web, invoked from the keypress (the required user gesture); Chromium prompts
  once for `clipboard-read` and persists the grant, giving one-keystroke plain
  paste like desktop. On denial/unsupported, F2 falls back to the existing
  arm-a-flag workflow. The ribbon **Paste Text** button was relabelled from a toggle
  to an action ("Paste the clipboard as unformatted text") with a state-aware
  tooltip that switches to "Plain paste armed — press Ctrl/Cmd+V to paste as text"
  when the fallback arms.

- **Web edition: hide the desktop-only Card Sharing settings tab**
  (`src/editor/settings-ui.ts`, `quick-card-search-ui.ts`). Pairing is desktop-only,
  so its settings are all `electronOnly` and its "Card Sharing" tab rendered empty on
  web. Marked the category `electronOnly` and added `visibleCategoryTabs()`, which the
  settings tab strip, panels, active-tab styling, deep-link guard, and command-palette
  settings search all route through — so neither the tab nor a palette entry for it
  appears on web.

- **Web multi-tab sync for the dropzone, quick cards, and send-to-speech**
  (`src/editor/web-shared-store.ts` (new), `dropzone-store.ts`, `quick-cards-store.ts`,
  `speech-doc-registry.ts`, `speech-doc-send.ts`, `index.ts`). New `WebSharedStore<T>`
  backs a value with IndexedDB (large disk-fraction quota, past localStorage's ~5 MB)
  plus a BroadcastChannel for cross-tab live sync — best-effort, with a toast on a
  quota refusal and graceful in-memory fallback where IndexedDB/BroadcastChannel are
  absent. The **dropzone** and **quick-cards** web backends moved onto it (quick
  cards migrate once from the old `localStorage` key, left intact as a fallback).
  The dropzone stays session-scoped: on a fresh browser session — a new tab that
  isn't an in-tab reload (a `sessionStorage` marker distinguishes the multi-pane
  toggle's reload) and with no peer answering a presence ping — the stale shelf is
  cleared; concurrent tabs share it. **Send-to-speech** gains a web cross-tab path:
  a `WebSpeechDocResolver` shares the speech-doc designation across tabs
  (`localStorage` + `storage` event), and `sendToSpeech` broadcasts the serialized
  slice over a BroadcastChannel with an ack — the tab owning that uid's view inserts
  it through the SAME `insertSpeechSlice` the Electron receive path uses (extracted
  as `applyIncomingSlice`; no duplicate handler), and a no-ack timeout surfaces the
  "speech doc isn't open in any tab" notice (mirroring Electron's window-gone case).
  The speech-stack ribbon buttons now appear on web single-doc (`pmd-multi-window`
  gated on the browser host too), and the desktop-only "New Speech Document" error
  was rewritten to point users at the Three-pane workspace.

- **Web edition: multi-window in the installed PWA** (`src/editor/host/browser-host.ts`,
  `host/types.ts`, `src/editor/index.ts`). The browser host can now spawn editor
  windows, so New Document / New Speech Document / opening a second file open a new
  window (like the desktop editions) instead of replacing the current doc.
  `spawnWindow` hands the doc payload to the new window through IndexedDB (a new
  `spawns` object store, DB bumped to v2) keyed by an id in a `?spawn=` URL param; the
  spawned window reads it back in `getInitialDoc` (one-shot — strips the param via
  `replaceState` and deletes the record), and the existing `mountFromSpawnPayload`
  boot path mounts it, reusing the same flow Electron uses so the `markAsSpeech`
  designation carries across. `getInitialDoc` is now consulted at boot regardless of
  the window's own `canSpawnWindow` (a spawned tab isn't itself standalone but must
  still mount its payload). `canSpawnWindow` is gated to an installed PWA and made
  STICKY via a `localStorage` flag once the app has run standalone, so a window Chrome
  opens as a plain tab (rather than a standalone app window) still behaves as
  multi-window — New Document spawns rather than overwriting, and New Speech Document
  doesn't refuse. Windows are opened with a `rel="noopener"` anchor click rather than
  `window.open`: Chrome's navigation capturing routes a navigation into the installed
  app window only when it targets a non-auxiliary browsing context (no opener), and
  `window.open` always creates an auxiliary context — so it's excluded from capture and
  lands in a browser tab even with the app's link-capturing enabled (Chrome offers only
  a manual "Open in app" button). A noopener link click is capturable, so an installed
  PWA with "open in app" set opens spawned windows as real app windows (Chrome 139+,
  HTTPS); elsewhere — a plain tab, `http://localhost`, or capture disabled — they open
  as tabs, and the editor behaves identically either way. One current limit:
  a file opened into a spawned window loses its `FileSystemFileHandle` (Save-As only),
  since the handle isn't yet threaded through the spawn payload.

- **Web edition: cross-window coordination + multi-pane mode-switch**
  (`src/editor/window-coordination.ts` (new), `index.ts`, `multi-pane-shell.ts`,
  `settings-ui.ts`). A single persistent BroadcastChannel per window
  (`installWindowCoordination`) is the browser counterpart to Electron's main
  process: it tracks live peers (hello / here / bye) and answers coordination
  requests, with every handler ignoring its own `WINDOW_ID` (a channel delivers to
  same-window instances too). The multi-pane mode switch now manages the other
  windows the way desktop does through main. One-window-per-doc → three-pane: the
  initiating window broadcasts please-close and collects each peer's `{uid,dirty}`
  (their journals ride in the shared journal store; only the uid list travels,
  folded into the mode-switch marker), and each peer journals + self-closes via
  `closeSelfWithFallback` — `window.close()` from a message handler has no user
  activation and is usually blocked, so a window that can't close covers its stale
  content with a "moved" overlay instead. Three-pane → one-window-per-doc can't
  reopen the other docs in their own windows (opening a window needs a user
  gesture, and the post-reload spawn runs during boot; browsers also cap ~1
  `window.open` per gesture), so `reduceToFocusedForModeSwitch` keeps the focused
  doc and closes the rest through the pane's existing save / discard flow (Cancel
  aborts the switch); Settings closes first so those prompts appear over the
  workspace. Singleton enforcement: a window booting into three-pane asks whether
  an older three-pane window is already open (by `openedAt`, ties by id) and, if
  so, bounces a browser-spawned duplicate (Cmd+N / app icon) via
  `closeSelfWithFallback` rather than opening a second workspace. All of it no-ops
  on Electron and degrades to nothing without BroadcastChannel.

- **Web edition: cross-window same-file guard + handle-preserving journals**
  (`window-coordination.ts`, `index.ts`, `multi-pane-shell.ts`,
  `host/browser-host.ts`, `host/types.ts`). Opening a file already open in another
  window is now refused on the web (the desktop path-registry check,
  `openPathCheck`, was Electron-only): `isFileOpenInAnotherWindow` routes Electron
  → `openPathCheck`, web → a BroadcastChannel query that broadcasts the handle and
  resolves true if a peer matches it via `FileSystemFileHandle.isSameEntry`,
  short-circuiting when this window is alone. For that to survive a three-pane mode
  switch (or crash recovery), web journals now PRESERVE the `FileSystemFileHandle`
  — `JournalEntry.handle` widened to `unknown`, the two `writeJournal` callers pass
  it through, and the browser `writeJournal` stores it (handles ARE
  structured-cloneable into IndexedDB; the prior code wrongly forced `handle:
  null`, so a mode-switched doc came back with no file identity). The restored
  handle carries `prompt` permission, which is fine: `isSameEntry` needs no grant
  and in-place save re-requests on first write.

- **Web edition: single-file document tools** (`src/editor/web-file-tools.ts`
  (new), `clean-ui.ts`, `bulk-convert-ui.ts`, `bulk-compress-ui.ts`,
  `home-screen.ts`, `index.ts`, `style.css`). The Clean / Bulk convert / Bulk
  compress home-screen tools were Electron-only (folder-recursive I/O) and absent
  on web. Single-file web versions run each transform on one picked file:
  `cleanDocumentBytes` (Clean), `convertBytes` in the extension-inferred direction
  (Convert, `.docx` ↔ `.cmir`), and `parseNative` + `serializeNative` preserving
  threads + docId (Compress — `.cmir` is gzip-wrapped, so a round-trip
  recompresses). A shared `runWebFileTool` drives pick → validate → a two-phase
  progress modal → Save. The modal's spinner is a compositor-driven `transform:
  rotate` animation, so it keeps turning even while the CPU-bound transform blocks
  the main thread; and the actual save is deferred to a Save button on the "ready"
  step, because `showSaveFilePicker` throws without a user gesture and the original
  click's activation is long gone once the transform finishes. Output goes through
  `host.saveAs` (File System Access picker on Chromium, download elsewhere); the
  home-screen copy is host-aware (single file vs. folder batch).

- **Web edition: Paste and Destructively Condense; disable the reload shortcut**
  (`src/editor/ribbon-availability.ts`, `index.ts`). `pasteCondensed` already read
  the clipboard through the shared `readClipboardText` (Electron IPC or the async
  Clipboard API) but its ribbon / palette visibility was still hard-gated to
  Electron; it's now shown wherever a clipboard read is available. Separately, the
  browser build disables the reload shortcut (`Mod+R` / `F5`) with a capture-phase
  `keydown` + `preventDefault`, matching the desktop build's removed reload
  accelerator — an accidental reload would discard the in-memory session, while
  programmatic reloads (the mode switch) are unaffected.

- **Per-document outline close + vertical resize in the multi-doc rail**
  (`editor/nav-panel.ts`, `editor/multi-pane-shell.ts`, `editor/style.css`). In
  the multi-doc workspace the navigation rail stacks one `NavigationPanel`
  section per open document. The section header's × previously called
  `settings.set('navPaneVisible', false)`, which hid the whole rail for every
  document; and the sections were locked to `flex: 1 1 0`, so they always split
  the rail evenly. `NavigationPanel` now takes an optional `onClose` callback —
  when set (multi-doc), the × routes to it instead of the global setting; the
  single-doc panel keeps the old "hide the pane" behavior. The shell wires
  `onClose` to a per-slot `navHidden` flag and a new `reconcileNavRail()` that is
  the single source of truth for section visibility (expand mode → only the
  expanded slot; otherwise every populated slot, minus individually-closed ones),
  the resize handles, the per-slot flex weights, and whether the rail shows at
  all. When every open document's outline is closed the rail is dropped
  (`pmd-multi-nav-empty` body class zeroes `#app`'s left margin, mirroring the
  global nav toggle). Each non-topmost section grows a top-edge `row-resize`
  handle; dragging it trades flex weight between the section and its visible
  neighbour above (combined weight held constant so the rest hold their size),
  double-click resets to an even split, and any composition change (open / close
  / hide / show) re-evens the split so a reopened section doesn't inherit a stale
  weight. Each pane's title chip gains an outline-toggle button (the reopen
  affordance and a one-click hide), pressed when the outline is shown. The
  global nav-pane toggle (`toggleNavPane`, the rail's toggle button, and the
  restore pull-tab) now cooperates with these per-slot flags instead of
  overriding them: in multi-doc mode it routes to `toggleAllNav()` (any slot
  outline hidden → show all; none hidden → hide all) and the pull-tab routes to
  `setAllNavHidden(false)`, while `reconcileNavRail()` writes `navPaneVisible`
  back so the toggle's pressed state always matches whether any outline is
  actually showing — previously the global toggle was a separate override, so
  hiding all three outlines individually left it stuck reading "on" and pressing
  it did nothing. *Per-document outlines contributed by
  [@coralynnkc](https://github.com/coralynnkc); global-toggle integration built
  on top.*

## 0.1.0-beta.4 — 2026-06-29

- **Discontinuous (Ctrl/Cmd) selection** (`editor/word-selection-plugin.ts`,
  `editor/similar-selection-plugin.ts`, `editor/style.css`,
  `tests/editor/discontinuous-selection.test.ts`). Ctrl + drag (Cmd on macOS —
  Ctrl-click is the OS context menu there) adds an arbitrary range to the
  selection; Ctrl/Cmd-click adds the word under the pointer, folding the current
  normal selection in as the first range. It reuses the Select Similar "shadow
  selection" machinery: the ranges populate the plugin's match set via a new
  `setManualShadowSelection`, so the ~15 format commands that already consume
  `getOperatingRanges` act across all of them in one transaction — no per-command
  work. A new `copy` DOM handler on the shadow plugin serializes every range (text
  joined by newlines, HTML concatenated) when a shadow set is active and the PM
  selection is collapsed; cut/paste are intentionally not special-cased, and any
  real edit / Escape / plain click clears the set (the existing shadow dismissal).
  The set renders with the native-`::selection` accent tint — a `style` flag on
  the shadow state keeps it distinct from Select Similar's dashed outline — and
  the live drag shows as a `pending` decoration rather than the real selection, so
  the already-selected ranges aren't dismissed mid-drag.

- **Renderer accessibility tree disabled by default to work around a Chromium
  accessibility crash** (`apps/desktop/src/main.ts`,
  `apps/desktop/src/accessibility-pref.ts`, `apps/desktop/src/preload.ts`,
  `editor/host/electron-host.ts`, `editor/settings.ts`, `editor/settings-ui.ts`,
  `tests/desktop/accessibility-pref.test.ts`,
  `tests/editor/settings-backup.test.ts`). Crash dumps from two independent
  Windows users (seven dumps total) symbolicated to a byte-identical, deterministic
  `CHECK` failure in Blink's accessibility serialization —
  `blink::AXBlockFlowData::ComputeNeighborOnLine`, reached via `RunAccessibilitySteps
  → AXObjectCacheImpl::SerializeUpdatesAndEvents → ui::AXTreeSerializer →
  AXObject::SerializeInlineTextBox → SerializeLineAttributes →
  AXInlineTextBox::NeighboringOnLineWithAXBlockFlowIterator`. The path runs only when
  an assistive-tech / UI-Automation client (screen reader, Windows Voice Access, …)
  turns on the `kInlineTextBoxes` AX mode, and it trips over the dense, overlapping
  highlight/underline run structure of debate cards (the triggering 1AC had 311
  paragraphs but 2,582 runs / 825 highlights / 1,478 underlines). The bug is in
  the new `AXBlockFlowIterator` line-navigation code and is unfixed on current
  Chromium trunk (Electron 42.2.0 = Chromium 148; the one related fix,
  crbug `461193182`, is already included and covers a different case). CardMirror
  isn't on an old Chromium, so an Electron bump won't help.

  `main` now appends `--disable-renderer-accessibility` at startup unless a
  machine-local pref opts back in (`{userData}/accessibility-pref.json`,
  `apps/desktop/src/accessibility-pref.ts`; fail-safe — anything but an explicit
  `true` reads as disabled, so a missing/corrupt/restored-backup file can never
  silently re-expose the crash). The switch is read before `app.whenReady()`
  (Chromium reads switches at process start). New **Settings → Accessibility →
  "Screen reader support"** is an Off/On segmented control (matching the reduce-motion
  / theme controls) that writes the pref via IPC and offers an immediate relaunch;
  it shows a "restart pending" notice only when the selection differs from the state
  actually applied this session (`host:get-accessibility-tree-applied` exposes the
  startup value). The boot log records `rendererAccessibilityTreeDisabled` and
  `accessibilitySupportActive` so a pasted log confirms whether the trigger is
  present on a given machine. Default-off is the fix; opting in re-activates the
  known crash and the setting says so.

## 0.1.0-beta.3 — 2026-06-29

- **Nav-pane caret-tracking no longer flickers to the next heading while typing**
  (`editor/nav-panel.ts`, `editor/index.ts`, `editor/multi-pane-shell.ts`,
  `tests/editor/nav-panel-caret-tracking.test.ts`). The nav pane caches each
  heading's doc position at render time and rebuilds on a ~200ms idle debounce;
  `setCaretHeading` (which picks the last heading whose cached pos ≤ caret) runs
  synchronously on every keystroke, so it compared a post-edit caret against
  pre-edit positions. Typing on the bottom-most line just above a heading
  advanced the caret past that heading's STALE position, briefly lighting it
  until the debounced rebuild refreshed positions. New
  `NavigationPanel.remapPositions(mapping)` maps the cached `liEntries` positions
  (and their `data-pos`) forward through a doc change; it runs on every
  doc-changing transaction alongside the heavy-update scheduling in both the
  single-pane (`index.ts`) and per-pane (`multi-pane-shell.ts`) dispatch hooks,
  so cached positions track the caret's frame and the comparison is always
  current. Also removes the same latent staleness for nav click-to-jump between
  rebuilds. Test reproduces the stale-position mis-selection and confirms the
  remap keeps the highlight on the correct heading.

- **Custom dash autoformat** (`editor/custom-dash-plugin.ts` new,
  `editor/settings.ts`, `editor/settings-ui.ts`, `editor/index.ts`,
  `tests/editor/custom-dash.test.ts`). New `customDashPlugin()` (pushed in
  `buildEditorPlugins` next to `smartQuotesPlugin`), gated on `customDashEnabled`
  + `customDashStyle` (`'en' | 'en-spaced' | 'em' | 'em-spaced'`, default `'em'`;
  spaced variants add a regular space each side). `handleTextInput` converts on
  the THIRD hyphen — when the typed `-` completes `---` (two hyphens immediately
  before within the textblock), it replaces all three with the configured output
  in one `insertText` and stamps a `converted` meta. `handleKeyDown` Backspace
  reverts that output back to the literal `---` within the one-transaction undo
  window (the same plugin-state pattern as the smart-quotes revert). Settings UI:
  a custom `customDash` kind rendering a checkbox + an output dropdown (disabled
  until checked) in the Editing category. Converting on the third hyphen rather
  than deferring to the next character is why only `---` is offered — a `--` rule
  would have to fire on the second hyphen and could never coexist with `---`.

- **Configurable preset filename prefixes + overwrite guard in fixed-folder
  mode** (`editor/settings.ts`, `editor/save-as-ui.ts`, `editor/index.ts`,
  `apps/desktop/src/main.ts`, `tests/editor/settings-backup.test.ts`). New string
  settings `sendDocPrefix` / `readDocPrefix` / `markedDocPrefix` (General,
  `kind: 'text'`, `dependsOn: 'prefixPresetSaveFilenames'`, defaults SEND_ /
  READ_ / MARKED_); the previously-hardcoded literals in the Save-As presets
  (`save-as-ui.ts`) and the silent `runSaveSendDocFlow` / `runSaveMarkedCardsFlow`
  (`index.ts`) now read them, and the `prefixPresetSaveFilenames` toggle's
  label/description were de-hardcoded. Overwrite guard: both silent flows now
  ALWAYS pass the source document's path as `siblingHandle` and gate the silent
  write on a per-mode resolvable destination
  (`fixedFolderMode ? folder !== null : sourceHandle !== null`), so the desktop's
  existing `resolve(target) === resolve(siblingHandle)` collision check fires in
  fixed-folder mode too — a custom/empty prefix colliding with the original →
  'collision' → Save As dialog — not just same-folder mode. The IPC/main code is
  unchanged (only its comment); the fix is renderer-side. Tests cover the prefix
  defaults + custom/empty values.

- **Per-editor (unlinked) body-text zoom** (`editor/settings.ts`,
  `editor/settings-ui.ts`, `editor/index.ts`, `editor/multi-pane-shell.ts`,
  `editor/drag-editor-surface.ts`, `editor/mobile-shell.ts`,
  `editor/mobile-settings-ui.ts`, `tests/editor/settings-backup.test.ts`). Body
  zoom was a synced, persisted `zoomPct` setting applied through one
  `--editor-zoom` var on `documentElement`, so it linked across windows
  (storage-event sync) and panes (shared var). Replaced with: (1) a new
  synced/persisted `defaultZoomPct` setting (Accessibility, 50–200%/step-10,
  default 100, clamped editor) = the value editors OPEN at; (2) live body zoom
  that's per-editor and transient — single-pane keeps a module `liveZoomPct`
  (per window, applied via the per-window `--editor-zoom` var), multi-pane keeps
  a `zoomPct` on each `DocRecord` applied INLINE to its `.pmd-pane-editor` so
  panes don't share. The zoom commands/buttons/Ctrl-wheel run through a
  `zoomActiveBy`/`zoomActiveReset` shim that routes to the focused pane in
  multi-pane via new `enableMultiDocMode` hooks (`zoomFocusedBy`/
  `zoomFocusedReset`), mirroring the per-pane `readMode` pattern; the status-bar
  % uses a `setZoomStateResolver` and refreshes on `setActiveView` focus change.
  The settings subscriber no longer re-applies zoom (the default governs only new
  editors, never re-zooms an open one). `applyZoomToTarget` / `clampZoom` /
  `getLiveZoomPct` / `setLiveZoomPct` are exported for the shell + mobile;
  `drag-editor-surface` reads each editor element's effective `zoom` instead of
  the setting. Chrome scale (`chromeScalePct`) is untouched — still a synced
  global via `setZoomFactor`. The old persisted `zoomPct` is intentionally not
  migrated (zoom no longer persists). Tests cover the `defaultZoomPct` clamp /
  default.

- **Paste and Destructively Condense command** (`editor/ribbon-commands.ts`,
  `editor/ribbon-groups.ts`, `editor/ribbon-availability.ts`,
  `tests/editor/paste-condensed.test.ts`). New desktop-only `pasteCondensed`
  ribbon command — unbound by default, Editing-utilities group, palette aliases —
  a direct PM Command modeled on `pasteAsText`: reads the OS clipboard via
  `electron.clipboardReadText()`, pastes through `applyPlainPasteFromText` with
  its settings-driven condense-on-paste suppressed, then runs a forced
  `condenseMerge({ withPilcrows: false, headingMode: ctx.headingMode() })` over
  the captured inserted range — equivalent to F2 then Alt-F3 (Condense Without
  Paragraph Integrity) on the pasted content, regardless of the user's condense
  settings. Web-gated via `isRibbonCommandAvailable` (`getElectronHost() !== null`,
  like `toggleVoice`) plus a body self-guard that returns false so the key falls
  through. The orchestration is extracted into an exported
  `pasteTextAndCondense(view, text, headingMode)` (paste → capture range →
  destructive condense) for testing; the test covers a 3-line paste merging into
  a single card_body with no surviving breaks, and the empty no-op.

- **Save Marked Cards** (`export/transform-for-export.ts`, `editor/save-as-ui.ts`,
  `editor/index.ts`, `editor/ribbon-commands.ts`, `editor/ribbon-groups.ts`,
  `editor/settings.ts`, `editor/settings-ui.ts`,
  `tests/export/transform-for-export.test.ts`). New `markedCardsOnly` branch in
  `transformForExport` → `extractMarkedCards`: keeps only doc-level `card` nodes
  whose subtree contains a reading-marker run (the `font_color` mark at FF0000,
  via the exported `isReadingMarkerColor`), flat — headings, analytics, and
  unmarked cards drop. `countMarkedCards` is exported for an empty-doc guard.
  Threaded through `serializeForSave` (optional opt), the modal
  (`SaveAsResult`/`buildPreset`/`confirmWith` + a new "Marked Doc" preset,
  `MARKED_` prefix), and `runSaveAsFlow` (a derived/lossy export → working doc
  identity untouched). New `saveMarkedCards` ribbon command (label "Save Marked
  Cards", default `Mod-Alt-m`, File group, palette aliases) → the new
  `runSaveMarkedCardsFlow`, modeled on `runSaveSendDocFlow`: silent write to
  `markedCardsDestination` (`sameFolder`/`fixedFolder` → `markedCardsFolder`)
  reusing the Send Doc IPC, with dialog fallback, `MARKED_` prefix honoring
  `prefixPresetSaveFilenames`, and format from `defaultSaveFormat`; toasts + no-op
  when nothing is marked. New `markedCardsDestination`/`markedCardsFolder`
  settings (4-step + metadata, `electronOnly`) — the same/fixed-folder radio
  editor was generalized (`buildDestinationEditor`) to serve both Send Doc and
  Marked Cards. Tests cover marker detection anywhere in a card
  (tag/body/cite/undertag), cards-only (analytics excluded), the flat output,
  `countMarkedCards`, and the empty case.

- **Bottom scroll runway gated on the whole pill tray, not just the dropzone**
  (`editor/index.ts`, `editor/style.css`). The editable's `padding-bottom: 4.5rem`
  runway (so the last line clears the fixed bottom-left tray) was gated on
  `html:not(.pmd-dropzone-pill-hidden)` — driven solely by `showDropzonePill`. But
  the send/receive pills share that tray and are gated on `pairingEnabled`, so
  pairing-on / dropzone-pill-off left the pills covering the last line with no
  runway. `applyPillVisibility()` now also toggles `pmd-pill-tray-active` on
  `<html>` = `showDropzonePill || pairingEnabled`, and both runway rules — single-
  pane (`#editor .ProseMirror`) and multi-pane (`.pmd-pane-pill-anchored
  .pmd-pane-editor .ProseMirror`) — gate on `html.pmd-pill-tray-active` instead.
  `pmd-dropzone-pill-hidden` still hides the dropzone root (style.css ~3198); only
  the runway gate moved. `positionDropzone` already tags the correct anchor pane.

- **Smart quotes (typing-time) + Flip Quote Direction command**
  (`editor/smart-quotes-plugin.ts` new, `editor/flip-quote-direction.ts` new,
  `editor/index.ts`, `editor/settings.ts`, `editor/ribbon-commands.ts`,
  `editor/ribbon-groups.ts`, `tests/editor/smart-quotes.test.ts`,
  `tests/editor/flip-quote-direction.test.ts`). `smartQuotesPlugin()` uses a
  `handleTextInput` prop (same shape as `type-over-boundary.ts`), gated on a new
  `smartQuotes` boolean setting (default off). `curlFor(typed, prev)` picks the
  direction from the preceding character via PM's built-in opening set —
  whitespace, `{[(<`, straight quotes, opening curly quotes — PLUS the em-dash and
  en-dash (Word's behavior PM lacks); the closing single quote doubles as the
  apostrophe. Word-parity revert: the curl transaction stamps a meta recording
  `{from, straight}`, the plugin state holds it for exactly one transaction, and a
  `handleKeyDown` Backspace handler restores the straight character when the
  cursor sits right after the just-curled char (defensively re-checking it's still
  a curly quote). Registered in `buildEditorPlugins()` (one push). The
  `flipQuoteDirection` ribbon command (unbound by default, Editing-utilities
  group, returned directly from `getRibbonCommand` since it's a plain PM Command)
  swaps every curly quote in a non-empty selection to its opposite direction via
  `tr.replaceWith(pos, pos+1, schema.text(flipped, marks))` (same length, marks
  preserved); a collapsed selection is a no-op. Produces curly characters that
  the existing `normalizeForMatch`/`foldQuotes` fold for search. Aliases on the
  command and the setting (`curly quotes`, `smart quotes`, `flip quotes`, `fix
  apostrophe`, …).

- **Find + Paragraph Integrity: dash and ellipsis normalization**
  (`editor/word-break.ts`, `editor/find-replace-plugin.ts`,
  `editor/repair-paragraph-plugin.ts`, `tests/editor/quote-fold.test.ts`,
  `tests/editor/repair-paragraph.test.ts`). New `normalizeForMatch(s)` returns the
  folded string PLUS an index map back to original offsets. It folds curly quotes
  (via `foldQuotes`), every `\p{Dash}` character → ASCII `-` (hyphen, en/em dash,
  minus sign, two/three-em dash, fullwidth hyphen, …), and collapses both an ASCII
  `...` and the `…` char to a single canonical `…`. Quotes/dashes are
  length-preserving (all single BMP chars); the `...`→`…` collapse (3→1) is the
  only length-changing step, which is why the map exists — both matchers now
  translate match start/end (and Find's whole-word boundary checks) through it, so
  highlights, Replace ranges, and the split-before-phrase still land on the real
  characters even when an earlier `...` shifted offsets. Replaces the previous
  length-preserving `foldQuotes`-only path in both matchers. Soft hyphen U+00AD
  (not a `\p{Dash}` char, and invisible) is intentionally left unfolded. Tests
  cover the folds, the map, both directions for each class, and that an earlier
  `...` doesn't shift a later match.

- **"Cycle Timer Preset" command + shared timer-profile module**
  (`editor/timer-profile.ts` new, `editor/ribbon-commands.ts`,
  `editor/ribbon-groups.ts`, `editor/index.ts`, `editor/settings-ui.ts`,
  `editor/settings.ts`, `tests/editor/timer-profile.test.ts`). New bindable
  `cycleTimerPreset` ribbon command — unbound by default, in the View group,
  label "Cycle Timer Preset (College → High School → Pomodoro)". Wired through
  `ctx.cycleTimerPreset` → `cycleTimerProfile()`: it advances the active
  `timerProfile` College → High School → Pomodoro (wrapping), applies that
  profile's saved speech presets + prep total to the live settings, refills the
  prep clocks (`resetTimer`), makes the timer visible, and toasts the profile
  label. The profile-switch logic moved into a new `timer-profile.ts`
  (`applyTimerProfile` / `cycleTimerProfile` / `TIMER_PROFILE_LABELS`), which the
  Settings profile picker (`buildTimerProfileEditor`) now also calls, so the two
  can't drift. Aliases modeled on `cycleTheme`:
  `switch`/`toggle`/`next`/`change timer preset`, plus `timer profile` and
  `timer preset`; the `timerProfile` setting also gained
  `aliases: ['timer preset', 'timer presets']` so settings search matches both
  terms. (The first pass mistakenly cycled the three within-profile speech
  presets via a `cycleSpeechPreset`; that was removed.)

- **Timer: editable prep clocks, prep-aware display, capped/focus-stable
  durations** (`editor/timer-state.ts`, `editor/timer-ui.ts`, `editor/style.css`,
  `editor/settings.ts`, `editor/settings-ui.ts`,
  `tests/editor/timer-state.test.ts`). Five related changes:
  - *Editable prep time.* The display click-to-edit is no longer gated to speech
    mode (`if (s.running || s.mode !== 'speech')` → `if (s.running)`), and commit
    now routes through the new `setActiveRemainingMs` (renamed from
    `setSpeechRemainingMs`), which writes the active mode's base — speech, or the
    aff/neg prep base. Since prep balances only zero on Reset, an edit persists
    across mode switches. Covered by a new `timer-state.test.ts`.
  - *Prep-aware big display.* `render()` sets `data-mode` on the display; CSS
    keyed on `data-prep-label` + `[data-mode="affPrep"|"negPrep"]` gives it the
    same aff/neg color (and an `A:`/`N:` `::before` for the text/both modes) as
    the prep buttons. The `::before` keeps the editable time text node clean.
  - *Prep-button padding.* In the text/both modes the aff/neg buttons get
    `padding: 0 1.7rem` so the prefix isn't crowded against a 4-digit time (the
    `min-width: 3.2rem` floor means smaller bumps are absorbed by centering).
  - *Durations capped at 99.* The durations editor `<input max>`/guard and the
    three sanitize bounds (live `timerPrepMinutes`, per-profile `prepMinutes`,
    and `sanitizeNumberTriple` for live + per-profile speech presets) went
    `999` → `99`. Flash seconds (separate `sanitizeFlashSeconds`) are unaffected.
  - *Durations editor focus.* `buildTimerProfileDurationsEditor` subscribed to
    `settings.subscribe(buildFields)`, so each keystroke's `settings.set` tore
    down and rebuilt the focused input. It now rebuilds only when the active
    `timerProfile` actually changes (tracked via `lastProfile`), preserving focus
    during multi-digit entry.

- **iOS web file-open: drop `accept` so custom extensions are selectable**
  (`editor/host/browser-host.ts`). iOS's Files picker maps a file input's
  `accept` to UTIs and greys out any extension with no UTI — our `.cmir` /
  `.cmir-journal` (`.docx` has one, so it stayed pickable) — making them
  unselectable; desktop browsers honor the raw extension list, so it only
  reproduced on-device. Added `isIOS()` (UA `iP(hone|od|ad)`, plus a
  touch-capable `MacIntel` for iPadOS-as-desktop-Safari) and, in `openOnce`,
  skip setting `accept` on iOS so any file can be chosen; the format is validated
  downstream. No behavior change off iOS. Not unit-tested (UA + iOS-picker
  runtime behavior) — verify on a real device.

- **Repair Paragraph Integrity: in-workflow undo (Mod-Z)**
  (`editor/repair-paragraph-plugin.ts`, `editor/repair-paragraph-ui.ts`,
  `tests/editor/repair-paragraph.test.ts`). The bar tracks a per-session action
  stack (`split` / `split-designate` / `designate`), pushed on each confirm. The
  document-level handler (reusing the Escape gating — defers to a supervening
  modal or the command bar) intercepts Mod-Z (no Shift/Alt) while the workflow is
  open and reverses the most recent action: a new `{ type: 'popDesignation' }`
  meta drops the designation it added (if any), and prosemirror-history `undo`
  reverses the split's doc change (if any). The designate-only case (Ctrl-Enter
  on an already-broken paragraph — no doc change) is reversed by `popDesignation`
  alone. No-op once the session's actions are exhausted, so it never reaches into
  pre-workflow history, and it's consumed while open so it can't fall through to
  the editor's global undo. Added a `popDesignation` plugin test; the full undo
  path (needs the history plugin + view) is verified in the dev build.

- **Repair Paragraph Integrity: Ctrl-Enter designates a paragraph that already
  starts a line** (`editor/repair-paragraph-plugin.ts`,
  `editor/repair-paragraph-ui.ts`, `tests/editor/repair-paragraph.test.ts`).
  `buildSplitForSingleMatch` returned null when the single match was at
  `parentOffset === 0` (the phrase already leads its paragraph). Now plain Enter
  still returns null, but Ctrl-Enter returns a no-split transaction emitting a
  new `{ type: 'designate', pos }` meta that records the paragraph for
  indent-on-exit and clears the query — the only way to mark a card's
  already-broken first body paragraph, which can't be split. `splitAtSingleMatch`
  now returns `'split' | 'designated' | null`, and the bar's hint distinguishes
  the two ("Marked for indent — it already starts a line." vs "Paragraph break
  added…"). Test added: Ctrl-Enter at paragraph start leaves the doc unchanged,
  bumps `designatedCount` to 1, and exit indents that paragraph.

- **Repair Paragraph Integrity: Escape exits from anywhere**
  (`editor/repair-paragraph-ui.ts`). The Escape handler lived only on the bar's
  input, so once focus left the bar (e.g. clicking back into the card) there was
  no exit avenue. Moved Escape to a capture-phase document handler
  (`onDocKeyDown`, installed on open / removed on close) so it fires regardless
  of focus and ahead of the editor. It defers — checked in the capture phase,
  before anything pops itself in bubble — to a supervening overlay-stack modal
  (`isAnyOverlayOpen()`) or the open command bar (`quickCardSearchUI.isOpen()`),
  so those absorb Escape first. The input's own Escape branch was removed so
  there's a single Escape path.

- **Multi-pane nav pane tracks the caret** (`editor/multi-pane-shell.ts`).
  Single-doc highlights the caret's heading via `navPanel.setCaretHeading` in its
  `dispatchTransaction` (plus a re-apply after each outline rebuild); the
  per-pane dispatch never did, so the three-pane nav didn't follow the cursor.
  Added, mirroring single-doc: (1) `record.navPanel.setCaretHeading(next.
  selection.from)` on caret-position change in the per-pane `dispatchTransaction`;
  (2) an initial `setCaretHeading` right after `navPanel.attach`; (3) a re-apply
  after each `navPanel.update(doc)` (the debounced heavy-update flush and
  `flushHeavyUpdateNow`) — since `render()` rebuilds entries, this keeps a
  structural edit from leaving the wrong heading lit. Per-pane, so each pane
  tracks its own cursor.

- **Move-container commands: reorder the cursor's outline node up/down**
  (`editor/move-container.ts` (new), `editor/ribbon-commands.ts`,
  `editor/ribbon-groups.ts`, `tests/editor/move-container.test.ts`,
  `tests/editor/ribbon-groups.test.ts`). `moveContainerUp` / `moveContainerDown`
  find the deepest heading whose `computeHeadingRange` encloses the cursor (the
  card / analytic unit, or a pocket/hat/block section) and move that range one
  spot among same-level top-level items. Mechanism: each top-level child carries
  an outline level (card / analytic = 4, block = 3, hat = 2, pocket = 1; loose
  content = deepest); the move skips items *deeper* than the grabbed level (a
  sibling's contents travel as a unit) and lands beside the first item at that
  level or shallower — so a card hops a shallower block heading in one step
  (entering/leaving the section) while a block hops a whole sibling block section.
  Boundaries flow (reparenting); no-op when there's no same-level-or-shallower
  neighbor; the cursor stays in the moved container so the key repeats. Bound by
  default to `Mod-Alt-ArrowUp` / `Mod-Alt-ArrowDown` (distinct from the
  single-modifier `Ctrl/Alt-Arrow` caret nav; search aliases move/reorder
  up/down), placed in the Editing-utilities ribbon group. Also added a
  ribbon-groups↔registry coverage test — a command missing from a group
  previously only crashed at boot, not in the suite.

- **Same-type structural re-press: uniform reset of indent + font-size +
  font-color** (`editor/ribbon-commands.ts`, `tests/editor/ribbon-commands.test.ts`).
  Centralized the cleared direct marks into `REAPPLY_CLEAR_MARK_NAMES =
  ['font_size', 'font_color']` and routed all three re-press paths through it:
  `clearFontSizeOnNode` → `clearReapplyFormatting` (tag / analytic via
  `computeStructuralReplacement`) now also resets `indent`; `stripIndentAtDepth`
  (pocket / hat / block / undertag) drops its `clearFontSize` option and always
  clears font_size + font_color (so undertag now clears font_size, previously
  omitted); `bulkReapplyStructuralOnShadow` (the right-click select-all-of-style
  path) extended to match (indent + both marks). `spacing` is never touched.
  Replaces the prior inconsistency (tag/analytic kept indent; undertag kept
  font_size; none cleared font_color). The re-press test suite was rewritten to
  assert the full per-style matrix (indent→0, font_size gone, font_color gone,
  spacing preserved).

- **Mod+A no longer selects the whole GUI when focus isn't in a text box**
  (`editor/editable-target.ts` (new), `editor/index.ts`, `editor/home-screen.ts`,
  `tests/editor/editable-target.test.ts`). With nothing editable focused (e.g.
  just alt-tabbed back, no click yet), the browser's default Mod+A selected the
  entire chrome. New shared `editable-target.ts` exports `isEditableTarget`
  (input / textarea / select / contenteditable — `isContentEditable` with an
  attribute fallback for jsdom) and `suppressGuiSelectAll`, registered as a
  capture-phase keydown listener in `index.ts`: plain Mod/Ctrl+A (no Shift/Alt)
  with a non-editable target → `preventDefault`; inside a text box it's a no-op,
  so the ProseMirror editor's and a native input's select-all still apply.
  `home-screen.ts` now imports the shared `isEditableTarget` (dropping its local
  copy). Covered by a jsdom test (the prevent / don't-prevent matrix).

- **Drag-and-drop file opening (desktop)** (`apps/desktop/src/preload.ts`,
  `editor/host/electron-host.ts`, `editor/index.ts`). New `installDragToOpen`
  registers capture-phase `dragover`/`drop` listeners (run in both single-doc and
  multi-pane boot). `dragover` preventDefaults only when the drag carries OS
  `Files` (suppresses Electron's navigate-to-file; never touches internal card
  drags, which carry no `Files` type). `drop` intercepts the first
  `.cmir`/`.cmir-journal`/`.docx`, resolves its path via the new `getPathForFile`
  bridge (`webUtils.getPathForFile` — Electron 32+ removed `File.path`), and
  routes it through the existing `openFileByPath` → `routeOpenedFile`, so dedup,
  the unsaved-changes prompt, and recovery-journal handling are all reused.
  Capture phase + `stopPropagation` so an editor drop is handled here, not by
  ProseMirror; unsupported files fall through untouched. No-op on the web edition
  (no filesystem paths). Verified manually in the dev build — not unit-testable
  (needs real Electron + an OS drag).

- **Add/insert cross-verb aliases on the element-insertion commands**
  (`editor/ribbon-commands.ts`). Added the missing verb as a per-command alias so
  both phrasings match in command search: `insertTable` ← "add table",
  `addRowBefore`/`addRowAfter`/`addColumnBefore`/`addColumnAfter` (labelled
  "Insert Row/Column …") ← "add row/column …", `insertReceivedAtCursor`/`AtEnd` ←
  "add received card …" (`insertImage` already had "add image"). Deliberately a
  per-command alias, NOT a synonym group — `addQuickCard` / `addCommentToSelection`
  / `addNoteToSelection` CREATE rather than place an element, so "insert" is not
  an equivalent for them.

- **Quick-card ribbon cluster gated behind `showQuickCardButtons` (default off)**
  (`editor/settings.ts`, `editor/index.ts`, `editor/style.css`). New boolean
  setting (interface + default `false` + sanitize + an Editing-category toggle),
  mirroring `showDropzonePill`. The settings-apply subscriber toggles
  `pmd-quickcards-hidden` on `<html>`, and `html.pmd-quickcards-hidden
  #quickcards-stack { display: none }` hides the whole 2×2 cluster — all four
  buttons (`qc-search-btn` / command bar, `qc-tagpicker-btn`, `qc-manage-btn`,
  `qc-add-btn`). Visibility only: the quick-card store, commands, and the command
  bar's `Mod-Shift-Space` shortcut are unaffected.

- **Quick-card delete: two-click confirm replacing native `confirm()`**
  (`editor/quick-cards-manage-ui.ts`, `editor/style.css`). Added a `confirmButton`
  helper mirroring the learn manager's two-click arm pattern (first click →
  `"<label>?"` + `.is-armed`; a second click within 3s runs the action, else it
  disarms). Both delete buttons — per-card (detail footer) and bulk (selection
  bar) — now use it, and the native `confirm()` was removed from `deleteCard` /
  `deleteChecked` (native confirm is disabled in Electron, so the delete
  confirmation was unreliable there). Added a `.pmd-qc-manage-danger.is-armed`
  rule (solid danger fill) matching the learn armed style.

- **Quick-card creation routed through `takeSendSlice`** (`editor/index.ts`).
  `runAddQuickCard` previously took a raw `doc.slice(selection.from, selection.to)`
  after only a non-empty-selection check, so a partial/arbitrary selection
  produced a structurally-broken quick card. It now calls `takeSendSlice(source
  View)` — the same path the send-to dropzone / starred / speech commands use —
  which normalizes an explicit selection to whole structural units (and
  re-highlights it as feedback), or captures the cursor's enclosing card/section
  when the selection is empty; returns null (→ toast) when there's nothing
  structural. No new tests: the normalization is already covered by
  `send-normalize.test.ts`; this is a thin wiring swap.

- **Command-palette synonym groups (data-driven) + a delete/remove group**
  (`editor/quick-card-search-ui.ts`, `editor/ribbon-commands.ts`). Replaced the
  hardcoded fix↔repair check in `searchCommandSource`'s `haystack` with a
  data-driven `SYNONYM_GROUPS` table — `[['fix','repair','restore'],
  ['delete','remove']]` — expanded generically: a command whose label contains
  any word in a group gains that group's other words as searchable terms. This
  makes fix/repair/restore fully mutual and adds delete/remove. Trimmed the
  now-redundant cross-verb aliases (`'delete links'` off `removeHyperlinks`,
  `'remove card'` off `deleteCurrentHeading`), and the delete/remove group newly
  covers the alias-less `deleteTableRow`/`Column`/`Table`. Command-search only
  (the settings search still keys on aliases), matching prior scope.

- **Formatting-gap bridging: structural-paragraph exemption + two settings**
  (`editor/ribbon-commands.ts`, `editor/settings.ts`, `editor/settings-ui.ts`,
  `tests/editor/formatting-gaps.test.ts`). The gap-fill/bookend bridge — both the
  per-apply `withGapFix` wrapper (8 formatting commands) and the manual
  `fixFormattingGaps` command — now: (1) **skips structural textblocks**
  (`STRUCTURAL_NO_BRIDGE` = tag / analytic / pocket / hat / block / undertag),
  gated **per-textblock** inside `forEachGap` and the manual walk, so a selection
  spanning a structural block and a body paragraph still bridges the body
  paragraph (bridges never cross a paragraph break, so the boundary is never a
  gap); and (2) reads two new **Editing** settings. `formattingGapClass`
  (`'both'` default / `'whitespace'`) drives the gap-char class — `both` →
  `[.,;:?()! ]`, `whitespace` → `[ ]` — consumed by both paths via the
  consolidated `gapCharSet`/`makeGapRegex`/`isGapChar` helpers (this also removes
  the duplicated gap regex that lived in `fixFormattingGaps`). `autoBridgeFormatting`
  Gaps (default true) short-circuits only `withGapFix`; the manual command ignores
  it. UI: a toggle plus a two-option radio labeled "Whitespace and punctuation" /
  "Whitespace only" (`buildFormattingGapClassEditor`, modeled on the saveFormat
  radio). Two existing tests that asserted in-tag bridging were updated to the new
  no-bridge behavior; added per-textblock, gap-class, and auto-toggle coverage.

- **Pasting card content over a range selection no longer breaks the card**
  (`editor/paste-plugin.ts`, `tests/editor/paste-cite-tag-disconnect.test.ts`).
  `tryPasteCardContent` previously bailed on any non-collapsed selection
  (`sel.from !== sel.to → return null`), so pasting fittable content (a
  cite / body / undertag, which serialize as a single OPEN `card` slice) over a
  selection fell through to `tryPasteSplitContainer`; that path saw the open-card
  lead and split the destination card — detaching the tag and spawning a phantom
  empty-tag sibling. The range case now deletes the selection first, then runs
  the existing card-paste matrix at the resulting cursor. `fitBlocks` was
  refactored to operate on a caller-supplied transaction (so the delete and the
  fit are one transaction), and a new `rangeFitsInOneContainer` guard restricts
  in-place fitting to selections that stay within a single card's content slots
  (or all at doc level); a selection crossing into a tag/heading or spanning two
  cards still falls through to the default/split path. A structural lead
  (tag / analytic / heading / whole closed card) still bails before the range
  logic, so it correctly starts a new card. Covered by 7 new range-selection
  tests in the card-paste matrix suite.

- **`analytic` is no longer legal card content; in-card analytics split out into
  their own `analytic_unit`** (`schema/nodes.ts`, `schema/migrate.ts` (new),
  `native/index.ts`, `import/importer.ts`, `editor/paste-plugin.ts`, +tests).
  The card content expression dropped `analytic` — it is now
  `tag (card_body | undertag | cite_paragraph | table)*`. `analytic` was only
  ever an in-card child as the original "cite-slot alternative" (in the schema
  since the foundational commit, surfaced by the importer in the cite-handling
  bundle); it was never a deliberate, documented feature, and it left the
  Backspace/Delete/Enter guards in `tag-keymap.ts` (which key off "is the cursor
  in the container's FIRST child") blind to it — a cite-slot analytic could fold
  into the tag (id lost) or duplicate its id on Enter. An analytic that reaches a
  card — a legacy `.cmir`, or a `.docx` whose author put an Analytic paragraph
  under a tag — is now split out the same way pasting an analytic into a card
  already did (`tryPasteSplitContainer`): the tag + pre-analytic children stay in
  the card, and each analytic heads a trailing `analytic_unit` that absorbs the
  children below it up to the next analytic. The new `splitInCardAnalytics` runs
  in `parseNative` beside `stampMissingHeadingIds`, so every native load (open,
  journal recovery, multi-pane spawn) repairs old files in place —
  `nodeFromJSON` builds the now-invalid node without validating, then the walk
  fixes it before the doc reaches the editor. The importer's "optional in-card
  analytic" special-case was removed so an analytic naturally terminates the card
  and starts its own unit; `fitForCard` coerces a stray analytic to `card_body`
  defensively. Net effect: the cite-slot-analytic boundary bugs are now
  structurally impossible. Covered by new migration tests plus updated
  importer / schema / transform-for-export expectations.

- **Inserts snap to the nearest valid drop target for the kind of content being
  inserted** (`editor/insert-position.ts` (new), `editor/dropzone-ui.ts`,
  `editor/speech-doc-send.ts`, `editor/quick-card-search-ui.ts`,
  `editor/settings.ts`, `tests/editor/insert-position.test.ts` (new)). Inserting
  a structural slice — a dropzone shelf item (click-to-insert), a quick card, a
  sent slice — at `selection.head` / `selection.from` forced ProseMirror to
  split the enclosing card to fit it, spawning a phantom blank-tag (`id: null`)
  card for the orphaned tail. New `nearestValidInsertPos(doc, pos, content)`
  mirrors drag-and-drop, where what counts as a drop target depends on what's
  being dropped. Inline text stays at the caret and card content (a cite / body /
  undertag / table) drops INSIDE the enclosing card — both found by walking
  outward to the innermost ancestor that accepts `content` (via
  `Node.canReplace`) and snapping to the nearer surrounding gap. A doc-level
  structural object (`card` / `analytic_unit` / `pocket` / `hat` / `block`)
  instead snaps to the nearest OUTLINE slot for its level, reusing the drag
  surface's own logic (`collectHeadings` + `headingInsertPos` + the same
  `entry.level <= draggedLevel` filter, plus the doc-end slot): a card lands
  between cards, a block between blocks, a hat between hats. None of them split
  the card the caret is in. `dropzone-ui`'s `insertItem` and `speech-doc-send`'s `insertSpeechSlice`
  pass the slice's content to it for a non-blank collapsed caret (an empty
  placeholder line is still filled in place; a range selection still inserts at
  its start). The `insertSpeechSlice` mid-text `window.confirm` and the
  `quickCardSkipMidTextInsertConfirm` setting it gated (interface / default /
  metadata / sanitize) were removed — snapping makes the warning moot. Covered by
  tests for each content kind (card → doc gap, cite → inside the card, inline →
  at the caret) plus an end-to-end check versus the raw-caret split. The same
  snap is applied to the pairing **receive** insert (`pairing/inbox-insert.ts`'s
  `insertReceivedItem`), which had the identical raw-`selection.head` insert, so
  a card received from a partner no longer splits the card the caret is in.

- **Send commands normalize the selection to whole top-level nodes that lead with
  a structural unit** (`editor/send-normalize.ts` (new), `editor/speech-doc-send.ts`,
  `editor/index.ts`, `editor/pairing/send-to-starred.ts`,
  `tests/editor/send-normalize.test.ts` (new)). All three send pipelines
  (dropzone, starred recipient, speech doc) funnel through `resolveSendRange`,
  whose non-empty-selection branch previously returned the raw `{from, to}` — so
  an arbitrary selection (a partial card, a leading loose paragraph) produced a
  slice that couldn't be placed cleanly on receipt (it split a card / spawned a
  phantom). New `normalizeSelectionForSend(doc, from, to)` rounds each endpoint to
  a top-level boundary off the RAW selection (so rounding one endpoint never
  erases what another rule needs): the **end** rounds to nearest; the **start**
  rounds to nearest for a card / analytic_unit, includes-or-skips a heading by
  which half the caret is in (its intro riding along when included), and for a
  leading loose paragraph trims forward to the first structural unit UNLESS > 75%
  of that section's intro text is selected — in which case it grabs the heading +
  the whole intro so the intro travels under a structural lead. Collapsing
  endpoints fall back to the most-overlapped structural unit; a result holding no
  structural unit returns null (nothing sent). This leans on the absorb invariant
  that loose paragraphs only sit at doc-top or right after a heading, so only a
  *leading* loose paragraph is ever a problem. New `takeSendSlice` reflects the
  normalized range back as the source selection (feedback) for an explicit
  selection, leaving a bare cursor's enclosing-structure send untouched. Covered
  by 13 tests across cards, headings, the 75% intro carve-out, and loose paragraphs.

- **Paste that leads with body content then turns structural no longer breaks the
  card** (`editor/paste-plugin.ts`, `tests/editor/paste-body-then-structural.test.ts`
  (new)). A clipboard slice shaped `[body…, heading/card…]` — a paragraph copied
  with a following heading, common via OS copy/paste, which bypasses the (now
  normalized) send pipelines — was caught by neither `tryPasteCardContent` (bails
  on the structural node) nor `tryPasteSplitContainer` (bails on the
  non-structural lead), so it fell to PM's default fitter and split the
  destination card (phantom tag). `tryPasteSplitContainer`'s body was extracted
  into a shared `buildContainerSplit(state, structuralFlat, bodyPrefix)`, and new
  `tryPasteBodyThenStructural` splits the slice at the first structural node,
  requires the prefix to be card-fittable, and runs the split with the body
  prefix merged into the pre-cursor content (`mergeBodyPrefix`: the first body
  paragraph merges inline, subsequent paragraphs become their own `card_body`
  blocks, a cite/undertag lands as its own block). `handlePaste` tries it after
  the structural-led split — on the reparsed flat, doc-level slice (falling back
  to the raw slice). The result mirrors the structural-led split with the body
  folded in: the leading body joins the cursor's card, the structural content
  starts its own container, and the post-cursor tail rides under the last pasted
  node. Covered by 7 tests (paragraph + heading / whole card / bare tag,
  body-start, multi-paragraph prefix, cite-in-prefix, bail cases).

- **Loose tables after a card / analytic_unit are now absorbed into it**
  (`editor/absorb-plugin.ts`, `tests/editor/absorb.test.ts`). The absorb plugin
  pulled loose `paragraph` / `cite_paragraph` / `undertag` / `card_body` siblings
  into a preceding `card` / `analytic_unit` but STOPPED at a `table`, so tagging
  a run of content that included a table (F7 on the lead line, then absorb)
  produced a card that ended at the table — the table and everything after it
  stranded at doc level. `table` is valid content of both `card` and
  `analytic_unit` (the importer already nests inline tables in cards), so it's
  now in the absorbable set in both `findAbsorbRegions` (the live plugin path)
  and `absorbedDocChildren`, passed through unchanged like cite / undertag /
  card_body. (Images need no handling — they're inline atoms inside a textblock,
  so they absorb along with their paragraph.) Covered by 4 tests: table after a
  card, table doesn't break the zone, table after an analytic_unit, and the live
  plugin path.

- **`liftSurvivorToDocLevel` downcasts a lifted `card_body` to `paragraph`**
  (`editor/tag-keymap.ts`, `tests/editor/tag-keymap.test.ts`). When a blank-tag
  card is dissolved (Backspace/Delete at the blank head) and its survivors lift
  to doc level with no card before them, a `card_body` was lifted unchanged,
  leaving card-body-styled text orphaned at the doc root. It now downcasts to a
  plain `paragraph`. `cite_paragraph` / `undertag` are valid, meaningful
  doc-level nodes and pass through unchanged (deliberately *not* matching
  `liftCardChild`, which downcasts cites — here there's no reason to strip the
  cite typing); `analytic` is still wrapped in an `analytic_unit`.

- **Repair-paragraph indent-on-exit is clamped to the workflow's card**
  (`editor/repair-paragraph-plugin.ts`, `tests/editor/repair-paragraph.test.ts`).
  `buildExitTransaction` indents each designated paragraph; because designated
  positions are mapped forward through every edit, one could in principle drift
  across a card boundary and indent a paragraph in a neighboring card (indent
  attr only — not a structural break). It now skips any designated textblock that
  resolves outside the current `cardRange`, so the deferred indent can only ever
  land inside the card the workflow opened on. Covered by a test that a
  designated position planted in another card is left untouched on exit.

- **Voice "new card" mints a real tag id** (`editor/voice/dispatch.ts`,
  `tests/editor/voice-new-card.test.ts`). The `newCard` voice command built its
  card with `card.createAndFill()`, which fills the required tag from attr
  defaults (`id: null`) — an id-less heading is invisible to the nav pane / level
  filter and the cursor→nav highlight falls back to the previous card
  (`schema/ids.ts`). Extracted `newCardNode(schema)`, which builds the card with
  a tag carrying a fresh `newHeadingId()`, and the command now uses it; other
  card-creating paths (ribbon F7) already stamp ids, so this brings voice in
  line. (Load-time `stampMissingHeadingIds` would have repaired it on the next
  reload, but the card was nav-invisible until then.)

- **Home-screen 1–9 shortcuts stand down under a modal or a focused input**
  (`editor/home-screen.ts`, `editor/overlay-stack.ts`,
  `tests/editor/home-screen-shortcuts.test.ts`,
  `tests/editor/overlay-stack.test.ts`). The home screen's document-level keydown
  handler fired its number (and Escape) shortcuts unconditionally, so with a
  dialog or the command bar layered over it the shortcut ran AND swallowed number
  input meant for the modal. `onKeyDown` now bails when `isAnyOverlayOpen()` (new
  export on the shared overlay stack — settings / quick-card / learn dialogs all
  push to it) or when the keydown target is a text-entry element
  (`isEditableTarget`, which covers the command bar's focused search field and any
  dialog input). Covered by a jsdom test (fires when home is the active layer,
  suppressed under an overlay or with a focused input, resumes once the overlay
  closes) plus an `isAnyOverlayOpen` unit test.

- **The AI edit coordinator blocks length-neutral edits (marks / styles / attrs)
  inside a live lease** (`editor/ai/edit-coordinator.ts`,
  `tests/editor/edit-coordinator.test.ts`). `leaseTouched` only detected
  content-length changes and boundary deletions, so an add/remove-mark or style
  application inside a lease — which produces identity step maps (no length
  change) — slipped through and was applied mid-operation. After the
  length/boundary fast paths, it now compares the region's slice before vs after
  (`tr.before.slice(from, to).eq(tr.doc.slice(f, t))`) and blocks any
  difference — inline marks, node attrs, or same-length text. Edits *outside* the
  lease still only remap it (the region's content is unchanged, so the slices
  compare equal), preserving concurrent disjoint ops. Covered by a test that
  add/remove of a mark inside a lease is blocked while the same mark outside is
  allowed.

- **Non-glyph-changing decorations split ligatures at formatting boundaries**
  (`editor/style.css`). Highlight / shading (background) and underline / emphasis
  (text-decoration) render as mark spans, and the browser shapes a ligature
  *across* such span boundaries — background and text-decoration aren't
  shaping-relevant, so the run isn't broken there — so applying one to part of a
  ligature painted the whole joined glyph. Adding `font-variant-ligatures: none`
  to `.pmd-highlight`, `[data-shading]`, `.pmd-underline`, `.pmd-emphasis` is a
  shaping-relevant difference, so the run breaks at the mark boundary: the
  ligature splits and each character is decorated on its own. Trade-off: a
  ligature wholly inside one uniform decoration also un-ligates (CSS targets the
  whole span, not just its edges), so highlighted / underlined text doesn't form
  ligatures at all. Bold / italic / cite already break shaping (they change the
  glyph). Text color and cite-when-not-bold have the same class of issue but were
  left out of scope. CSS-only — verified visually in the dev build, not the test
  suite (jsdom can't shape fonts).

## 0.1.0-beta.2 — 2026-06-25

- **Rebindable single-press doc-cycle commands for three-pane mode**
  (`editor/ribbon-commands.ts`, `editor/ribbon-groups.ts`,
  `editor/multi-pane-shell.ts`, `editor/index.ts`). Added two `RibbonCommandId`s,
  `cycleDocNext` / `cycleDocPrev` (labels "Next / Previous Document in Slot",
  default keys `''` → unbound + rebindable), in the "Multi-pane workspace" group.
  They dispatch via `runViewlessRibbon` → `runMultiPaneCycle(±1)` → the new module
  export `cycleFocusedSlotDoc`, which calls `MultiPaneShell.cycleFocusedSlotDoc`:
  it instantly switches the focused slot's visible doc one step through the stack
  (from `visibleIndex`, wrapping) via `slot.showRecord`, with no Alt+Tab overlay.
  The existing hold-to-preview Ctrl-Tab (`onDocCycleKey`, a raw window listener)
  is untouched. Every `RibbonCommandId` exhaustive switch + the group drift guard
  required adding the ids in each place.

- **`one` / `two` / `three` aliased to the slot commands**
  (`editor/ribbon-commands.ts`). Added spelled-out-number aliases to
  `RIBBON_COMMAND_ALIASES` for `focusSlot1-3` / `sendDocToSlot1-3`, which the
  command-bar search (`quick-card-search-ui.ts`, which folds aliases into each
  command's search haystack) now matches by word.

- **Auto-update: renamed the setting and added a daily background check**
  (`editor/settings-ui.ts`, `editor/index.ts`). The toggle "Check for updates on
  launch" is renamed "Check for updates automatically." Alongside the existing
  at-launch trigger (first window only — `triggerAutoUpdateCheck` →
  `runUpdateCheck({ alertOnLatest: false, alertOnError: false })`), the boot path
  now also arms a 24h `setInterval` (first window only) that re-fires the same
  silent check, re-reading `checkForUpdatesOnLaunch` each tick so toggling it off
  stops the checks. Both paths stay silent unless an update is found. The setting
  key (`checkForUpdatesOnLaunch`) is unchanged, so there's no settings migration.

- **Bundle metric-compatible open-source substitutes for the proprietary / system
  fonts the picker offers** (`editor/style.css`, `editor/font-detect.ts`,
  `editor/fonts/`). The picker listed Calibri / Cambria / Times New Roman / Arial /
  Georgia / Helvetica / Comic Sans MS / Verdana / Tahoma / Liberation / DejaVu /
  Noto but shipped none of them, so a user without the font got a generic fallback.
  Added latin-subset woff2 (regular / bold / italic / bold-italic) for Carlito
  (→Calibri), Caladea (→Cambria), Tinos (→Times New Roman / Liberation Serif),
  Arimo (→Arial / Helvetica / Liberation Sans), Gelasio (→Georgia), Comic Neue
  (→Comic Sans MS), DejaVu Sans (→Verdana / Tahoma), DejaVu Serif, and Noto
  Sans / Serif — 40 files, fetched from the Fontsource CDN. Each is declared in
  `@font-face` under the PROPRIETARY family name, `src` listing **style-specific**
  `local()` faces first (`local('Times New Roman Bold')` for the 700 face, with
  `Oblique` aliases for the italic faces) then the bundled `url()` — so a user's
  real font, including its true bold/italic, still wins, and the clone is fetched
  only when the real font is absent. All families added to `BUNDLED_FONTS` in
  `font-detect.ts` so they show in the picker unconditionally. Licenses (OFL 1.1 /
  Apache 2.0 / DejaVu-Bitstream Vera) are documented in `fonts/LICENSES.md`, with
  the full Apache and DejaVu texts saved as `Apache-2.0.txt` / `DejaVu-License.txt`.

- **Doc loading sniffs the bytes for the parser instead of trusting the `format`
  field** (`editor/index.ts`, `editor/multi-pane-shell.ts`). A doc's `format`
  (`'cmir'` / `'docx'`) is its SAVE format, but the in-memory + journal
  serialization is ALWAYS `serializeNative` (native cmir) regardless of format —
  so a docx-saved doc's journal / mode-switch payload carries native cmir bytes
  stamped `format: 'docx'`. The paths that load already-obtained bytes
  (`routeOpenedFile`, `loadFileInPlace`, `mountFromSpawnPayload`, and multi-pane
  `loadOpenedIntoSlot`) branched on `format` to pick the parser, so those cmir
  bytes were sent to `fromDocxFull` (JSZip) → "Can't find end of central
  directory". This silently dropped docx-saved docs on every three-pane toggle
  (the mode-switch respawns through `mountFromSpawnPayload`) and broke opening a
  docx-saved doc's `.cmir-journal`. Fix: a `bytesLookLikeDocx` sniff (a `.docx`
  is a `PK` zip — `0x50 0x4b`; native cmir is gzipped or raw JSON and never is)
  chooses the parser at all four sites, while `format` still drives saving (a
  docx doc re-saves as docx). The crash-recovery loaders (`applyRecovery`, the
  auto-recovery paths, and the recovery reserializer) were already correct — they
  hardcode `parseNative` on the always-cmir journal bytes — so they're unchanged.

- **Open `.cmir-journal` files directly via File → Open** (`editor/index.ts`). A
  `.cmir-journal` is the crash-recovery envelope (`{ uid, filename, handle,
  format, savedAt, bytesB64 }`) wrapping the same doc bytes a `.cmir` holds. Added
  `cmir-journal` to `OPEN_FILE_FILTERS` and a shared `resolveOpenedFile(opened)`
  that, for a `.cmir-journal`, JSON-parses the envelope, base64-decodes `bytesB64`
  to the real doc bytes, and returns `{ name, bytes, handle: null, format,
  recovered: true }` — opening the wrapped doc as a RECOVERED, unsaved copy:
  `handle` is null so Save can't clobber the original (which may be newer or live
  on another machine), it mounts dirty (`markCurrentDocDirty`), and it isn't
  recorded as a recent (the Save flow records it once written). Format comes from
  the envelope (`cmir`→`parseNative`, `docx`→`fromDocxFull`), not assumed `cmir`
  like the crash-recovery path. Both `routeOpenedFile` (ribbon / Ctrl-O Open +
  command-palette file search) and `pickAndLoadInPlace` (home-screen Open) route
  through `resolveOpenedFile`, so the Open dialog, home-screen Open, and the web
  build (same extension-based dispatch) all get it for free; the resolved name
  carries the format's extension so multi-pane (which re-derives format from the
  name) agrees. Plain `.cmir` / `.docx` pass through unchanged. Finder
  double-click / OS file-association was intentionally left out of scope.

- **Tooltips are custom-rendered instead of native `title`** (`editor/ribbon-tooltips.ts`,
  `editor/style.css`, `index.html`, `editor/nav-panel.ts`). The ribbon tooltip
  controller set `el.title = …`; Electron/Chromium on macOS renders native `title`
  tooltips erratically (long, inconsistent trigger delay, flicker, frequently
  swallowed), so the desktop build's tooltips were slow / missing while the same
  attributes were fine in the web build's real browser. Replaced `el.title` with a
  small custom renderer: one shared `.pmd-ribbon-tooltip` element, delegated
  `pointerover` / `pointerout` (so dynamically added/removed targets need no
  per-element listeners), a ~450 ms hover delay, positioned under the target
  (flips above / clamps to the viewport), hidden on `pointerdown` / scroll / blur.
  Icon buttons get an `aria-label` so screen readers keep a name (and there's no
  double-tooltip, since `title` is gone). Because most of the app sets `title`
  directly and bypasses the controller (find/replace, comments, dropzone, command
  bar, speech controls, …), the controller also ADOPTS any native `title` on first
  hover — moving the text into the same renderer and stripping the flaky attribute
  — except inside the contenteditable document, so it doesn't fight ProseMirror's
  DOM. `reapplyAllRibbonTooltips()` still tracks `ribbonTooltipMode` / rebinds.
  Two related tweaks rode along: the command-bar button's tooltip was relabeled
  `Search quick cards` → `Toggle command bar` (`index.html`), and the redundant
  per-row type-label `title` on nav-pane outline entries (`nav-panel.ts`) was
  dropped.

- **Pasting card content fits INTO the card instead of splitting it — new
  `tryPasteCardContent` matrix** (`editor/paste-plugin.ts`,
  `tests/editor/paste-cite-tag-disconnect.test.ts`). A cite / body / undertag
  copied from inside a card serializes to the clipboard as a single OPEN `card`
  (`openStart` 2, its required `tag` cut off by the openness). On paste,
  `handlePaste`'s structural path (`tryPasteSplitContainer`) saw the leading
  `card` and SPLIT the destination card to insert it, detaching the tag into its
  own empty-bodied card — un-selectable, un-draggable, the gray `.pmd-card` rail
  no longer reaching the tag. An interim inline-merge attempt then over-corrected,
  flattening pasted cites into plain `card_body` text (silent data loss — a
  `cite_paragraph` is only subtly styled, so it was easy to miss). Replaced both
  with `tryPasteCardContent`, run BEFORE the split path: it unwraps a leading open
  `card` / `analytic_unit` and fits the carried blocks into the cursor's card per
  an agreed matrix that never breaks the card and preserves block types —
  - body (`card_body` / `paragraph`) into a `card_body` / `cite_paragraph` → absorbed inline;
  - a same-type paste (cite→cite, undertag→undertag) → merges inline;
  - otherwise the block inserts as its OWN type, splitting the cursor's block and
    coalescing empty edges (cite → card_body becomes a real cite line; body →
    undertag splits the undertag with a `card_body` between the halves);
  - an EMPTY target block is overwritten (filled), not split;
  - OUTSIDE a card the blocks drop in loose with body → `paragraph` (no more
    phantom empty-tag card), and the cursor lands at the END of the pasted run —
    matching the in-card / F2 paste paths instead of stranding it behind an empty
    line.
  A `tag` / `analytic` / heading / whole closed `card` lead still bails to the
  split path (those SHOULD start a new card). `tryPasteAsCardBodies` is restored
  to its narrow role as the F2 plain-text helper. Locked by 17 matrix-cell tests.

- **Plain reload keeps its menu item but drops the Cmd/Ctrl+R accelerator**
  (`apps/desktop/src/main.ts`). `buildMenu`'s View menu used `{ role: 'reload' }`,
  which auto-binds CmdOrCtrl+R — a stray Cmd-R mid-edit reloaded the renderer and
  read like a crash / data loss. Replaced it with a plain
  `{ label: 'Reload', click: () => BrowserWindow.getFocusedWindow()?.webContents.reload() }`
  (no accelerator), so the menu entry stays but the hotkey is gone;
  `{ role: 'forceReload' }` (Cmd-Shift-R) is untouched. The menu is the only
  source of the reload accelerator (Windows/Linux already run menu-less, so Ctrl+R
  was unbound there), so dropping it from the role is sufficient — no
  `before-input-event` needed.

- **Web "Layout on this device" options use the shared radio styling**
  (`editor/settings-ui.ts`). `buildMobileLayoutEditor` set
  `pmd-mobile-layout-{editor,row,row-label}` classes that were never defined in
  `style.css`, so the `webOnly` `mobileLayout` radios rendered unstyled (no column
  layout, gap, or matching font). Repointed them at the shared `pmd-heading-mode-*`
  classes used by the other radio editors (Heading Mode among them) —
  the DOM is identical, so they now match exactly. The radio `groupName` keeps its
  own value (it's the input `name` attribute, not a CSS class).

## 0.1.0-beta.1 — 2026-06-24

- **Right-click a file search result dives in instead of pinning**
  (`editor/quick-card-search-ui.ts`). In the Search Everything palette, a
  file row's context menu used to toggle the pin — redundant with the ★ star
  sitting right on the row (and the **Alt-P** shortcut). Right-click now
  selects that row and calls the same `enterInFile()` path **Tab** uses,
  diving into the file to search its objects. The star and `Alt-P` still pin;
  the outline rows' right-click (toggle-collapse) is unchanged.

- **Escape steps out of a dived-into file regardless of focus**
  (`editor/quick-card-search-ui.ts`). The palette's keydown handler was bound
  only to the search input, so once focus left the box (clicking or scrolling
  the results) Escape went unheard and the user was stranded in the file view.
  Added a document-level Escape fallback that fires whenever the palette is
  open — guarded against double-handling so a focused Escape (owned by the
  input's handler) doesn't both step back *and* close. Stepping back also
  re-focuses the search box.

- **Clod customizer surfaced as a real setting** (`editor/settings.ts`,
  `editor/settings-ui.ts`, `editor/mobile-settings-ui.ts`). The configurator
  (persona name + pronouns, the activity pools per time period, the time-period
  boundaries) was reachable only via a deliberately obscure Mod+Alt+Shift+click
  on the **Enable Clod mode** toggle. Replaced that easter egg with a plain
  toggle plus a new **Customize Clod** setting row (new `clodCustomize` kind — a
  button that opens the same `openClodConfigurator()` dialog), placed right
  after the toggle and gated on `aiFeaturesEnabled` like the rest of the AI
  settings. Desktop-only; mobile keeps just the toggle.

- **Multi-pane gets the same bottom-pill runway as single-pane**
  (`editor/index.ts`, `editor/style.css`). The single-doc editor pads
  `#editor .ProseMirror` with `padding-bottom: 4.5rem` so the bottom pill tray
  (dropzone / send / receive) doesn't overlap the last lines — but that rule is
  gated `body:not(.pmd-multi-doc)`, and the multi-pane equivalent was never
  actually built (a `positionDropzone` comment pointed at a
  `.pmd-dropzone-runway-spacer` that exists only as a mobile hide-rule). The tray
  anchors to the leftmost visible pane, so `positionDropzone` now tags that pane
  `pmd-pane-pill-anchored` (moving the class as the anchor changes), and a mirror
  CSS rule gives only that pane's editor the same 4.5rem runway. Other panes stay
  flush; gated on pill-hidden like single-pane. The stale comment is corrected.

- **Highlight / shading / font-size no longer rewrite the underline / emphasis /
  cite of adjacent gaps** (`editor/ribbon-commands.ts`). `applyFullGapTarget`'s
  `appliesNamedStyle = false` branch normalized the named-style family from the
  gap's bookends even though the command that ran never touched it — so for
  `<E> <underlined join> <E>`, highlighting either emphasized side saw emphasis on
  both bookends and overwrote the deliberate underlined read-aloud join with
  emphasis. The whole named-style normalization is now gated on
  `appliesNamedStyle`; an unrelated command leaves underline / emphasis / cite
  completely untouched and only tidies its own family. This also subsumes the
  earlier "don't break emphasis on a continuous phrase" fix (now it's just "don't
  touch it"). Regression test added in `formatting-gaps.test.ts`.

- **Hyphens are exempt from gap filling, like the other dashes/operators**
  (`editor/ribbon-commands.ts`). The gap normalizer's fillable-gap-char set
  (`GAP_REGEX` / `GAP_CHAR_RE`, plus the duplicate inside `fixFormattingGaps`) is
  a deliberate allowlist — `.,;:?()!` and space — so em-dash, en-dash, `=`, and
  `+` already break gaps rather than getting bridged/stripped. The hyphen was the
  lone dash that had slipped into the list, so underlining/emphasizing/citing two
  hyphen-joined words (`well-known`) pulled the hyphen into the run. Removed `\-`
  from all four copies of the char-class and documented the allowlist so it isn't
  re-added. Regression tests (hyphen + em-dash) in `formatting-gaps.test.ts`.

- **Importer promotes outline-leveled "Normal" paragraphs to their structural
  node** (`import/importer.ts`). Tags/headings authored as plain Normal text with
  only a direct `<w:outlineLvl>` (no Heading style) imported as flat paragraphs —
  `resolveNodeType` keyed entirely off `pStyle`, so a style-less paragraph
  short-circuited to `paragraph` and the outline level was never consulted. Added
  `outlineHeadingNode`, a mirror of the style cleaner's first-pass header
  detection (`ooxml/style-clean/style-cleaner.ts`): when style-based
  classification yields `paragraph`, an effective outline level of 0–3 plus the
  matching run formatting promotes it — `0`+bold+26pt → pocket, `1`+bold+22pt →
  hat, `2`+bold+underline+16pt → block, `3`+bold → tag. The formatting conjuncts
  are the cleaner's guardrails, so an ordinary outline-leveled Word doc isn't
  mis-structured. Verified on real send docs (one went from 0 detected tags / 94
  loose paragraphs to 11 tags + 7 blocks + 11 cards; another from 2 tags to 27).
  Tests in `import/importer.test.ts`. Outline level and bold are resolved through
  each style's `basedOn` chain — once, in `parseStyles` (`StyleInfo` now carries
  the effective `outlineLevel` + `bold`) — and the tag uses the cleaner's
  `effectivelyBold` (direct run bold, else the run's char style or the paragraph
  style), so a heading/tag that is one only through an inherited style is caught
  too. The chain walk is once-per-style, never per-paragraph, so the per-paragraph
  classification stays a plain property read with an early-out on no outline
  level — the fast path for body text is unchanged.

- **Find: O(log N) navigation, match/row caps, scroll coalescing, and
  analytic/undertag categories** (`editor/find-replace-plugin.ts`,
  `editor/find-replace-ui.ts`, `editor/precise-scroll.ts`, `editor/settings.ts`,
  `editor/settings-ui.ts`, `editor/style.css`). Three things scaled with match
  count on every navigation step; all three are now split so only the active
  marker moves:
  - The match decoration set was rebuilt from scratch each step (the memo was
    keyed on `currentIndex`). Split into a base set — all matches with
    `pmd-find-match`, cached on (doc, matches, scope) — plus a single current-match
    overlay layered on via `.add` keyed on `currentIndex`, so a step is O(log N).
  - The in-context results list re-`innerHTML`'d and rebuilt a row + a `buildSnippet`
    per match each step; now built once per search (cached on the `matches` ref),
    with only the active row's `data-active` toggled on navigation.
  - The nav-pane hit markers re-mapped `matches.map(m => m.from)` and re-rendered
    each step; now skipped when the match list is unchanged.
  Caps: `FIND_MATCH_CAP` (10 000) bounds the match/decoration set on a pathological
  query (the count shows `10000+`); the results list renders the first
  `FIND_RESULT_ROW_CAP` (500) rows with a "refine to narrow" footer.
  `preciseScrollIntoView` carries a generation token so a newer scroll cancels an
  older one's rAF refine loop — holding "next match" no longer stacks materialize
  passes. Separately, standalone `analytic` and `undertag` paragraphs are now
  their own find categories (were lumped into `other`), ordered after `tag`
  (analytic → undertag → cite), badge-colored to match the editor's analytic/
  undertag colors and reorderable in Settings → Find; the `findCategoryOrder`
  sanitizer slots a newly-added category into an existing saved order at its
  canonical position rather than appending it.

- **Command-bar file pre-warm starts at boot instead of on first idle**
  (`editor/quick-card-search-ui.ts`). `prewarmQuickCardFiles` already warmed both
  the file LIST (`listCmirFiles` → main's `cmirIndexMem`) and the pinned-file
  CONTENT parse (`runWarmPass` → `warmCache`), but the whole thing was wrapped in
  `scheduleIdle(…, 2000)` — so neither started until the renderer first went idle
  (≤2s post-launch), and a command-bar open in that window still raced a
  not-yet-started warm. Split it: the per-root `listCmirFiles` calls now fire
  synchronously at boot — they're just async IPC, and the recursive walk /
  disk-index load runs in the main process, so they don't compete with the
  renderer's launch render — while the renderer-CPU pin parse (`runWarmPass`)
  stays on the idle delay. The file index is now building from t≈0, so a search
  opened a second after launch hits a warm cache instead of a cold scan.

## 0.1.0-alpha.20 — 2026-06-23

- **No native menu bar on Windows/Linux — Alt-key editor shortcuts now work**
  (`apps/desktop/src/main.ts`, `editor/settings-ui.ts`, `editor/style.css`). On
  Windows/Linux the native application menu reserved `Alt`+`<key>` for mnemonics,
  swallowing any editor command bound to a bare-Alt chord (Alt without Mod) before
  it reached the keymap — a rebind of "create analytic" to `Alt+A` did nothing,
  as did defaults like `selectCurrentHeading`'s `Alt-A`. An initial fix that
  forwarded those bindings through focus-scoped `globalShortcut`s was scrapped: a
  global shortcut grabs the chord at the OS level, so it can never be *captured*
  in the keybindings editor, making such bindings impossible to set or change.
  Instead the native menu is now installed on **macOS only**
  (`setApplicationMenu(process.platform === 'darwin' ? buildMenu() : null)` at
  both call sites), where Option doesn't trigger mnemonics and the global menu bar
  is expected. Every menu command's accelerator is already a renderer keybinding
  (handled by the editor keymap + the editor-unfocused global handler), so
  dropping the bar loses no shortcut; Cut/Copy/Paste/Undo work natively in the
  contenteditable. To keep the manual reachable without the menu, a **User Manual**
  link (`buildManualLinkSection`, opened via `openExternal`) is pinned at the
  bottom of Settings → General. Also removed the obsolete **Copy GPU Info**
  Help-menu item.

- **Benchmark — an in-app, game-style performance suite** (`editor/benchmark.ts`,
  `editor/benchmark-ui.ts`, `editor/benchmark-sample.ts`; surfaced via
  `buildBenchmarkSection` in `editor/settings-ui.ts`; wired through
  `beginBenchmark`/`endBenchmark` in `editor/index.ts`). A button in
  Settings → General runs a battery of real in-editor operations on the open
  document and reports rendering performance as a scrollable readout with a
  scroll-frame-time graph, footnoted metrics, and a single composite score.
  Tests: a continuous top→bottom scroll sampling each frame's interval (mean fps,
  p50/p95/p99 frame time, a 1%-low derived from p99, jank-frame count); nav jumps
  to headings spread across the doc via the same `preciseScrollIntoView` the nav
  pane uses (median + p90 click→settled); a forced relayout; a long-task tally via
  `PerformanceObserver`; and a scripted card-cutting sequence that builds a card
  the way a debater does — new heading + tag, then a real cite line that becomes
  the cite only once the cite mark is applied to its author/short-cite, then a
  paste of a real multi-paragraph card from the corpus **with extra blank lines
  between paragraphs**, a condense to drop the blanks and make it "cutting ready",
  and underline/emphasis/highlight sweeps (reported as the **average time per mark
  application**, since totals only track card length) plus a Smart Shrink. It is
  self-instrumented via `requestAnimationFrame` + `PerformanceObserver` — it
  measures CardMirror's own renderer, not a cross-application comparison.
  Implementation notes: the run executes against a `view.updateState` snapshot
  with a `benchmarkActive` flag that suppresses autosave / dirty-tracking / nav
  rebuilds, and the document is reverted to that snapshot when the user **closes**
  the results (by any path, once-guarded), so a benchmark never touches the file
  or the undo history. The cut spans are re-derived per paragraph from the
  post-condense document by sequential text match, so they survive condense's
  whitespace cleanup. The benchmark no-ops in read mode (it edits the document,
  which read mode locks). The fixture is auto-extracted into `benchmark-sample.ts`
  and guarded by `tests/editor/benchmark-sample.test.ts`.

- **Keyboard shortcuts to insert the most-recently-received card**
  (`editor/pairing/inbox-insert.ts` new; `editor/ribbon-commands.ts`,
  `editor/ribbon-groups.ts`, `editor/index.ts`; `editor/pairing/receive-pill-ui.ts`
  refactored). Two new rebindable ribbon commands — `insertReceivedAtCursor`
  (default **Mod-P**) and `insertReceivedAtEnd` (default **Mod-Alt-P**) — grab the
  last item in the inbox (`inboxStore.list().at(-1)`, which is newest-last) and
  insert it at the selection head or at `doc.content.size`. The pill's click /
  drag-out insert and the two shortcuts now share one helper,
  `insertReceivedItem(view, item, atEnd)` in the new `inbox-insert.ts` (heading-id
  rewrite so ids can't collide, read-mode-tagged dispatch, scroll-into-view; the
  item is left in the inbox, since insertion isn't consumption). Registered
  through the `RibbonCommandId` system, so they auto-appear in the keybindings
  editor with automatic conflict detection; their keybindings group is merged
  with the existing Send-to-Dropzone command under one section,
  "Dropzone / Send and Receive Cards".

- **"Send to Starred" — a one-key send to a starred recipient/group**
  (`editor/pairing/send-to-starred.ts` new; `editor/settings.ts`,
  `editor/settings-ui.ts`, `editor/ribbon-commands.ts`, `editor/ribbon-groups.ts`,
  `editor/index.ts`, `editor/multi-pane-shell.ts`, `editor/style.css`). A new
  single-valued setting `pairingStarred` (`{ kind: 'partner' | 'group'; ref } |
  null`) holds the one starred target. Star toggles on every recipient and group
  row in Card Sharing set it; because it's a single value, starring one inherently
  un-stars the rest, and both editors re-render off the shared `settings.subscribe`
  so the star moves visibly — exactly-one is enforced by the data model, not the
  UI. `sanitizePairingStarred` clears the ref when its recipient/group no longer
  exists. The new rebindable ribbon command `sendToStarred` (ships unbound)
  resolves the ref to recipient codes (partner → its code; group → its members,
  re-filtered against current partners) and sends the cursor's card — sourced
  exactly like Send to Dropzone via `resolveSendSlice` — through
  `relayClient.send`, building the same `{ label, type, sliceJson }` payload as the
  Send pill. It silently no-ops when nothing is starred, and toasts only on
  sharing-off / empty-group / send result. Wired through the `multiDocSendToStarred`
  hook for both single-doc and multi-pane, and grouped with the other send/receive
  commands in the keybindings editor.

- **Clean — optional in-place overwrite, gated behind a typed confirmation**
  (`editor/clean-ui.ts`, `editor/style.css`). Clean previously hard-coded a
  `cleaned_` prefix on every output (single-file `cleaned_${name}`, bulk
  `cleanedRel`). A new `prepend` toggle (a per-session field, on by default — so
  the safe behavior is the default each time the modal opens) selects between the
  `cleaned_` copy and the original filename. With `prepend` off and the
  destination resolving to the source's own folder, the output path equals an
  input path, i.e. an in-place overwrite. `wouldOverwriteInPlace()` detects this
  — off **and** `normPath(outputDir ?? sourceRoot) === normPath(sourceRoot)`,
  covering both the default (no destination) and an explicitly-chosen
  same-as-source folder. The Clean button now routes through `onCleanClick`,
  which, when an overwrite is staged, awaits `confirmOverwrite()` — a stacked
  sub-modal (same `pushSubOverlay` mechanism as the protected-styles editor)
  whose Confirm Overwrite button stays disabled until the user types the exact
  phrase "I accept the risk"; Cancel / Escape / click-out resolve false and abort.
  The output-path line shows a live red overwrite hint so the consequence is
  visible before clicking. Prepending always writes new files; a different
  destination writes copies — neither warns. (The phrase input and button row
  reuse `.pmd-clean-prot-input` / `.pmd-bulk-actions`, scoped-overridden because
  the dialog body is a flex column, not the row those classes assume.)

- **Clean — robustness on a full-library bulk run** (`apps/desktop/src/main.ts`,
  `ooxml/style-clean/legacy-remap.ts`, `ooxml/style-clean/style-cleaner.ts`,
  `editor/clean-ui.ts`). Cleaning an entire file library surfaced three failure
  modes. (1) The recursive `.docx` walk (`host:list-files-recursive`) picked up
  Word lock/owner files (`~$…`), macOS AppleDouble sidecars (`._…`), and
  `__MACOSX` folders — none are real documents, and each failed JSZip's
  end-of-central-directory check; they're now skipped in the walk. (2)
  `no style with id or name 'Heading5'`: `legacy-remap` injects the canonical
  set before assigning, but it tops out at Heading4, while the *shared*
  `buildLegacyHeadingMap` can yield level 5 (the importer maps `Heading5→block`).
  The cleaner's `headingIdFor` now caps at `Heading4` — its deepest injectable
  heading — leaving the shared map untouched for the importer. (3)
  `no style with id or name 'Heading1'/'Heading4'`: the header-detection pass
  assigns these, but the canonical set is only injected when the *required*
  styles (`Style13ptBold`/`StyleUnderline`/`Emphasis`) are missing, so a doc that
  had the required styles but lacked a `HeadingN` threw on assignment —
  python-docx treats built-in headings as always-available, our `Styles.get`
  shim doesn't. A new `ensureHeadingStyle` injects the canonical set on demand
  (idempotent) right before the lookup. Finally, the bulk runner classifies an
  unreadable-zip error (empty / truncated / non-document) as **skipped (not a
  valid .docx)** rather than a cleaning **failure**, so a few corrupt cloud
  conflict-copies don't inflate the failure count. The byte-for-byte parity
  suite against the Python reference still passes.

## 0.1.0-alpha.19 — 2026-06-22

- **Clean — a client-side `.docx` style cleaner** (`ooxml/style-clean/style-cleaner.ts`,
  `ooxml/style-clean/ooxml-doc.ts`, `ooxml/style-clean/template-styles.ts`,
  `ooxml/style-clean/style-fixup.ts`, `editor/clean-ui.ts`, `editor/home-screen.ts`).
  A faithful TypeScript port of the scouting-assistant `style_cleaner.py`, running
  entirely in the renderer over a small python-docx-equivalent shim
  (`OoxmlDoc`/`Styles`/`Style`/`Paragraph`/`Run`) on the JSZip `Docx` layer.
  Pipeline: normalize style aliases → convert direct formatting to semantic styles
  (cite/underline/emphasis run classification; heading detection by effective
  outline level + bold resolved through the `basedOn` chain; case-insensitive
  Analytic matching) → rename/remove to the canonical Verbatim set
  (`COMBINED_STYLE_MAP`) → strip hyperlinks → repair dangling style refs. Validated
  byte-identical to the Python reference on clean files. Engine work beyond the
  port: a Chromium-only double-`<?xml?>`-declaration bug — the `XMLSerializer`
  emits the declaration itself, so prepending a second one broke the re-parse and
  silently yielded zero styles — fixed in `serializeXmlDoc`; O(1) style lookups via
  a lazily-built id/name index (the Python's O(styles × runs) scans timed out on
  3,786-style merged docs); and removal of the prune passes (the canonical
  reduction already covers them, and with O(1) lookups they gave no speedup —
  `style-pruner.ts` became `style-fixup.ts`, keeping only the dangling-ref repair).
  The Home-screen UI cleans a file or a recursed folder, defaults the destination
  to each source's own folder (writing `cleaned_…`), shows a per-file progress bar,
  and exposes **protected styles** (never removed/reassigned, their `basedOn`/`link`
  dependencies kept) behind a gear that opens a separate modal.

- **Injecting + repairing required styles so more docs clean** (`ooxml/style-clean/style-cleaner.ts`,
  `ooxml/style-clean/ooxml-doc.ts`). When a document lacks the required Verbatim
  styles, `OoxmlDoc.injectMissingStyles` imports the canonical definitions before
  cleaning (gated on `requiredStylesMissing`, so styled docs are untouched, and
  invalidating the style index so the additions resolve). A separate
  `normalizeRequiredStyleNames` pass runs *before* the availability check to repair
  styles present under the canonical styleId but an unrecognized name — e.g. a
  Verbatim `!!Style Underline` — which the name-based check would otherwise call
  "missing" while injection (keyed on styleId) couldn't add a duplicate. Computing
  "missing" after the repair also makes the legacy-remap mixed/pure mode correct.

- **Legacy debate styles, shared between the cleaner and the importer**
  (`ooxml/legacy-styles.ts`, `ooxml/style-clean/legacy-remap.ts`, `import/importer.ts`,
  `ooxml/styles.ts`). A single source of truth (`legacyRole`, `isUnambiguousLegacy`,
  `buildLegacyHeadingMap`) classifies the pre-Verbatim vocabulary — `Tags`/`Cards`/
  `Cites`/`Block Headings`/`Nothing` paragraph styles, `Author-Date`/`Debate
  Underline` character styles, plus earlier-Verbatim ids like `StyleBoldUnderline`.
  The **cleaner's** `remapLegacyStyles` runs only when a doc actually *uses* an
  unambiguous legacy style (resolved from usage, so a merged doc that merely defines
  them is untouched), reassigns each paragraph/run by name to the canonical style,
  and picks heading levels per document: in a "mixed" doc (Verbatim styles present)
  it trusts each heading's own outline level (0→H1 … 3→H4); in a pure pre-Verbatim
  doc it infers depth (deepest heading above tags → Block, growing up). Tags are
  Heading 4 regardless. The **importer** consumes the same table: `parseRPr`
  classifies legacy character styles via `legacyRole` (and now `Cite → cite_mark`,
  for files that store the cite under its alias-as-styleId), and a per-document
  `planLegacy` maps legacy paragraph styles to schema nodes with the same adaptive
  heading logic — so opening a legacy `.docx` reconstructs cards/tags/cites/headings
  instead of importing flat text. `StyleInfo` gained an `outlineLevel` for this.

- **Multiple file-search folders** (`editor/settings.ts`, `editor/settings-ui.ts`,
  `editor/quick-card-search-ui.ts`). The single `fileSearchRoot` setting became a
  `fileSearchRoots` list, with a `sanitizeFileSearchRoots` migration from the old
  single value and a new `folderList` settings control (rows with a remove ×, plus
  "+ Add folder"). The palette loads every folder, keyed per-root so the existing
  per-root background index-update events merge in incrementally, and the merged
  view is de-duplicated by absolute path so nested/overlapping folders never search
  a file twice. The main-process indexer was already per-root, so it was unchanged.

- **Read mode permits drag-move + dropzone/receive edits** (`editor/read-mode-plugin.ts`,
  `editor/reading-marker.ts`, `editor/drag-controller.ts`, `editor/dropzone-ui.ts`,
  `editor/pairing/receive-pill-ui.ts`, `editor/nav-panel.ts`). Read mode's
  `filterTransaction` rejected every doc change except the reading marker; a new
  `READ_MODE_DRAG_META` is now also allowed (and dirties read mode so its redo
  works). The drag controller tags its move/copy and shelf-drop commits with it, so
  drag-move, cross-pane drops, and dropzone/receive drag-outs all land while
  reading; the nav panel no longer blocks starting a drag in read mode (its drop
  commits through the same controller). Dropzone and receive-pill click-inserts are
  tagged too, and in read mode append to the bottom of the doc (no editing caret to
  target). Plain typing stays locked.

- **Editor no longer locks after a blocking pop-up on Windows/Linux**
  (`editor/speech-doc-send.ts`, `editor/index.ts`, `editor/mobile-shell.ts`).
  `window.alert`/`confirm` steals OS-level focus from the contenteditable; macOS
  Chromium restores it on dismiss, Windows/Linux don't. The no-speech-doc `alert`
  (the `` ` `` path) — and the image-insert error alerts, the mobile unit-delete
  confirm, and the web "needs desktop" alert — now reclaim focus via `view.focus()`
  after the modal, matching the pattern the existing mid-text `confirm` paths
  already used.

- **Pointer-centric drag auto-scroll** (`editor/drag-autoscroll.ts`,
  `editor/pill-tray.ts`, `editor/drag-controller.ts`, `editor/drag-editor-surface.ts`,
  `editor/nav-panel.ts`). Auto-scroll was tied to the drag's source surface and so
  didn't follow the pointer across panes. Replaced both per-surface implementations
  with a single `autoScrollUnderPointer`, driven once per move from the controller's
  `setPointer`: it `elementFromPoint`s the surface under the pointer (the pickup
  pill is `pointer-events:none`, so this sees through it) and nudges the nearest
  vertically-scrollable ancestor near its edge — so nav→editor, nav→nav, and
  editor→editor drags all scroll the right pane. The downward scroll is suppressed
  over the bottom-left pill-tray column (`pointerOverPillTrayColumn`) so a drag
  toward the dropzone/send/receive pills isn't fought by scrolling, and the up-band
  is offset below a `position: sticky` header pinned at a scroll container's top
  (`stickyTopInset`) so the multi-pane nav's sticky level bar no longer eats it.

- **Tolerant card-sharing version guard with a compatibility floor**
  (`editor/install-info.ts`, `editor/pairing/pairing-wiring.ts`,
  `apps/desktop/src/pairing-ipc.ts`, `editor/host/electron-host.ts`,
  `apps/desktop/src/preload.ts`). The cross-version guard previously dropped any
  received card whose sender version didn't `===` the receiver's, so two machines
  on different CardMirror versions couldn't share at all. It's now a compatibility
  *floor*: each sealed card carries an optional `minReceiverVersion`, and the
  poller accepts it unless that floor is set AND the local version is below it
  (`compareVersions`, a self-contained semver-ish comparator — numeric
  pre-release identifiers compare numerically, a bare release outranks a
  pre-release on the same core). A blank floor means any version may receive, so
  sharing is tolerant by default. The floor is a single documented constant,
  `CARD_COMPAT_MIN_VERSION` (currently `''`), stamped onto every outgoing card; a
  future release that changes the shared-card payload incompatibly sets it to its
  own version, after which clients older than that refuse the card and prompt to
  update while equal-or-newer clients accept — a breaking version can thus lock
  out already-shipped older clients (that carry this floor logic) without pushing
  them an update. `minReceiverVersion` is threaded through the pairing config, the
  sealed `InnerPayload`, and the configure/version-mismatch IPC types; the mismatch
  toast now reads "a shared card needs a newer CardMirror version (X or newer) —
  update to receive it." Note this governs clients from this release forward;
  alpha.18's exact-match guard is unchanged in already-built copies.

## 0.1.0-alpha.18 — 2026-06-21

- **Cross-machine card sharing — identity, crypto, and relay**
  (`apps/desktop/src/pairing-crypto.ts`, `apps/desktop/src/pairing-ipc.ts`,
  `apps/desktop/src/pairing-build.ts`, `dev/mock-relay/server.js`,
  `src/editor/pairing/relay-client.ts`, `src/editor/pairing/inbox-store.ts`,
  `src/editor/pairing/pairing-ids.ts`). Each install has a generated-once X25519
  keypair persisted to `userData/pairing-keys.json` (load-or-create, so updates
  never regenerate it); the public key, base64url-encoded with a `cmk1.` prefix, is
  the machine's shareable **code**, and a hash of it is the relay routing id.
  Sending seals each card (the dropzone's existing `Slice.toJSON()` payload) to the
  recipient's public key with an ephemeral-X25519 + AES-256-GCM sealed box, so the
  relay only ever stores opaque ciphertext — never the card, the sender, or the
  recipient. The Electron main process holds the relay base URL + bearer token
  (`pairing-ipc.ts`; token injected at build time into `pairing-build.ts`), POSTs
  one sealed message per recipient, and runs a poller (default 30 s) that GETs
  messages for its own routing id, unseals, `DELETE`s, and broadcasts them to the
  renderer; the inbox is persisted to `userData/pairing-inbox.json`. The relay
  forgets messages after 3 hours. A `dev/mock-relay` store-and-forward server
  implements the exact contract for local testing; production points at the
  scouting-assistant `/relay`. The renderer `relay-client` is transport-agnostic
  (delegates to the main-process bridge), so a web edition can be added without a
  client rewrite.

- **Cross-machine card sharing — Send/Receive pills + settings**
  (`src/editor/pairing/send-pill-ui.ts`, `src/editor/pairing/receive-pill-ui.ts`,
  `src/editor/pairing/pairing-wiring.ts`, `src/editor/settings.ts`,
  `src/editor/settings-ui.ts`, `src/editor/index.ts`). Two pills sit in a fixed
  `.pmd-pill-tray` next to the dropzone. The **Send** pill registers a `DragSurface`
  with the drag controller: dragging a card onto it expands a list of your
  recipients and groups as drop rows; dropping resolves recipient codes (a group
  fans out to its members) and routes the slice through the relay. The **Receive**
  pill is dropzone-style, backed by an `inbox-store`: incoming cards show the sender
  (your nickname for their code, else their self-name, else the code) and a relative
  time, the count badge tracks unread, and it green-pulses on arrival per the
  `pairingReceiveFlash` setting (`once` / `off` / `repeat`-every-10s-until-opened);
  opening it marks all read. Setup lives in **Settings → Card Sharing**:
  `pairingEnabled`, your own code (copy / regenerate — regenerating cuts off old
  shares), `pairingDisplayName`, a `pairingPartners` editor (nickname + code),
  `pairingGroups` (labeled member sets), and `pairingPollSeconds`. Directed
  addressing means you only ever poll for messages addressed to your own code and
  never address one to yourself, so there's no self-echo or delete-race. Desktop
  only for this version.

## 0.1.0-alpha.17 — 2026-06-20

- **Quote-insensitive text matching** (`editor/word-break.ts`,
  `editor/find-replace-plugin.ts`, `editor/repair-paragraph-plugin.ts`). New
  shared `foldQuotes()` maps Word's smart quotes (`‘ ’ ‚ ‛` → `'`, `“ ” „ ‟` →
  `"`) to straight ASCII. Both Find's `findMatches` and the paragraph-repair
  `findBodyMatches` now fold the haystack AND the needle before `indexOf`, so a
  query typed with straight quotes matches curly text and vice versa. The fold
  is strictly length-preserving (each BMP char → one ASCII char), so the
  character offsets still map back to the correct doc positions — match ranges
  land on the real (curly) characters, and Replace edits the right span.

- **Repair Paragraph Integrity workflow** (`editor/repair-paragraph-plugin.ts`,
  `editor/repair-paragraph-ui.ts`). A card-scoped workflow for re-splitting a
  collapsed body. `repairParagraphPlugin` owns the workflow view-state (active
  flag, the operated-on card range, the query, and match positions) and paints:
  a green `Decoration.node` box around the operated-on card the whole time it's
  open (`.pmd-repair-card-box`, the green analog of the AI working box's
  `.pmd-ai-working` card outline), plus green inline decorations over every body
  match — `.pmd-repair-match`, with the lone Enter-ready match a stronger
  `.pmd-repair-match-single` (the green analog of Find's current-match). `findBodyMatches` scans only the card's body
  textblocks (`card_body` / `cite_paragraph` / `undertag`), never the tag, using
  the same `pos + 1 + idx` offset mapping Find uses. The bar UI captures the
  enclosing card range at open (so focusing the input doesn't lose scope),
  pushes the query via `setQuery` meta, reads the match count back to toggle the
  in-box check + green entrance/reached-one pulse, and on Enter calls
  `buildSplitForSingleMatch` — `tr.split(matchFrom)` (guarded by `canSplit` and a
  parentOffset>0 "already a paragraph start" check) which yields two `card_body`
  siblings with the phrase leading the second; the same transaction clears the
  query for the next phrase. The card range maps forward through every doc
  change (including the split) so highlights track edits.
  **Ctrl-Enter** splits the same way but also *designates* the new paragraph for
  indent-on-exit: `buildSplitForSingleMatch(state, true)` tags its `afterSplit`
  meta, and the plugin records the tr's caret position in `designated[]`. Those
  positions map forward through every later edit, so as subsequent splits shrink
  the paragraph the marker keeps pointing at its (moving) start — the indent is
  deliberately deferred so it lands on the *final* paragraph, not the whole rest
  of the body. A `Decoration.node` (`.pmd-repair-indent-pending`, faint tint +
  a green bar in the left gutter) marks each designated paragraph. On exit,
  `buildExitTransaction` resolves each designated position to its current
  textblock and `setNodeMarkup`s `indent += INDENT_STEP_DXA` (deduped by block),
  then closes — so Esc both applies the pending indents and tears the workflow
  down. Wired as a new ribbon
  command `repairParagraphIntegrity` (label *Repair Paragraph Integrity*, no
  default key so it's rebindable, search aliases, a `ctx.openRepairParagraph`
  hook), registered in the editor plugin list and command bar.

- **Gap-fix no longer converts emphasis to underline for unrelated commands**
  (`editor/ribbon-commands.ts`). `withGapFix` runs `applyFullGapTarget` over the
  edge gaps after *every* formatting command. Its underline-family rule treats
  underline and emphasis as one family, so both bookends emphasized → the gap
  fills with underline — the continuous read-aloud marker. That conversion was
  firing unconditionally, including for highlight/shading/font-size, so toggling
  highlight on a continuously-emphasized run rewrote its edge gaps to underline
  and visibly broke the emphasis at the selection boundaries. `withGapFix` now
  takes an `appliesNamedStyle` flag (true only for `applyUnderline` and
  `applyBodyMark`, i.e. underline/emphasis/cite); `applyFullGapTarget` keeps the
  emphasis→underline conversion when it's set, and otherwise falls back to the
  manual `fixFormattingGaps` rule, where emphasis+emphasis bridges with emphasis
  (preserved). Only the emphasis-on-both-sides case differs between the two
  rules — underline+underline, mixed underline/emphasis→underline, and cite+cite
  are identical either way. The `withGapFix` second argument changed from a bare
  `effectivePt` to an options object (`{ effectivePt, appliesNamedStyle }`); the
  two font-size callers updated accordingly.

- **Re-emphasizing inside a continuous emphasized phrase preserves it**
  (`editor/ribbon-commands.ts`). The `appliesNamedStyle` fix above still let the
  emphasis→underline conversion fire on the emphasis command itself: emphasis is
  a one-directional apply (`applyBodyMark` always adds, never toggles off), so
  pressing F10 on a word inside an already-emphasized run re-ran the per-apply
  rule over its edge gaps (both bookends emphasized) and converted them to
  underline — same broken seams as the highlight case, but it couldn't be solved
  by the flag because this *is* a named-style apply and the conversion is wanted
  when joining two separately-emphasized words. The distinguishing signal is the
  gap's own pre-command emphasis: separately-emphasized words have a plain gap (a
  real seam); a continuous phrase has an already-emphasized gap. `applyFullGapTarget`'s
  `appliesNamedStyle` branch now bridges with emphasis (not underline) when both
  bookends *and* the gap are emphasized (`rangeFullyHasMark(tr.doc, gapFrom,
  gapTo, emphasisType)` — a new "throughout" helper, since PM's `rangeHasMark`
  is "anywhere"). The command only marks the operating word, never the flanking
  edge gaps, so `tr.doc` at the gap still reflects its pre-command state. The
  formatting-gaps test for the separate-words join was rewritten to use a
  realistic plain-gap setup (it previously used pre-emphasized gaps, which the
  new rule correctly reads as continuous).

- **Explicitly-selected edge punctuation is formatted, not gap-stripped**
  (`editor/ribbon-commands.ts`). The operating range can include trailing/leading
  punctuation the user deliberately selected (`government.` with the period);
  the command marks it, but `withGapFix` then ran `applyFullGapTarget` over the
  whole bookend-to-bookend gap and, when the neighbor disagreed, stripped the
  mark right back off that punctuation. Punctuation should only count as gap for
  *bridging* (an unselected `. ` between two underlined words still bridges); a
  selected punctuation mark is the user's choice. New `gapModRange(doc, gapFrom,
  gapTo, r)` shaves the in-selection punctuation run off each end of the gap and
  returns the sub-range the gap-fix may write; `applyFullGapTarget` takes that
  `[modFrom, modTo)` and confines its `addMark`/`removeMark` (and the
  `rangeFullyHasMark` continuity check) to it, while still deciding bridge-vs-strip
  from the unchanged bookends. Whitespace is intentionally *not* protected, so a
  selected trailing space is still normalized away — matching the Layer-3 trim's
  space-only policy (`government. ` → period underlined, space not).

- **A structural-led paste preserves its full structure instead of demoting**
  (`editor/paste-plugin.ts`). When the clipboard leads with structural content
  and the cursor is in a card/analytic_unit body, PM's default fitting demoted
  it: the clipboard's flat, open `[tag, card_body, …]` shape (what a selection
  starting inside a tag, or a whole-card copy, produces) has its *open* head
  merged into the cursor's body, stripping the tag and absorbing the rest.
  Diagnosis: a *closed* structural slice splits correctly on its own, but PM
  leaves a phantom empty-tag card for the post-cursor remainder. The rewritten
  `tryPasteSplitContainer` now (a) accepts any structural lead — `tag` /
  `analytic` / `pocket` / `hat` / `block` / whole `card` / `analytic_unit` — not
  just a lone tag/analytic; (b) re-groups the flat nodes into proper containers
  via `groupStructuralNodes` (a bare `tag` + following bodies → `card`, a bare
  `analytic` → `analytic_unit`, with `fitForCard`/`fitForAnalyticUnit` coercing
  bodies to each container's content rule); (c) preserves the WHOLE pasted
  structure (head + content), where the previous code synthesized a single head
  and dropped the body; and (d) absorbs the destination's post-cursor remainder
  into the LAST pasted container (so two clean cards result, no phantom), or —
  when the paste ends in a doc-level heading — ejects and lifts the remainder to
  the doc root via `liftToDocRoot`. `handlePaste` tries the slice PM handed us
  first, falling back to `reparseClipboardStructuralSlice` (a doc-level,
  context-free re-parse of the clipboard `text/html`, re-running the
  `transformPasted` fresh-id + table-unwrap normalization) for the case where PM
  already flattened the head to inline in the slice. Replaces the old
  `detectPastedHead` / `findHeadInSlice` / `parseHeadFromHTML` single-head path.

- **"Fix" / "repair" are command-search synonyms** (`editor/quick-card-search-ui.ts`).
  `searchCommandSource`'s per-command `haystack` now appends `repair` to any
  command whose label contains `fix`, and `fix` to any whose label contains
  `repair`, so each word matches commands named with the other. This covers the
  three existing fix/repair commands (`repairText`, `repairFormatting`,
  `fixFormattingGaps`) and any future ones automatically — the expansion is
  driven off the label text, not a hardcoded id list. The synonym terms join the
  existing `RIBBON_COMMAND_ALIASES` in the haystack, so they affect matching only,
  not display, and label hits still outrank alias/synonym-only hits in the
  ranking pass.

## 0.1.0-alpha.16 — 2026-06-17

- **`fileSearchFormats` setting controls which formats the file search lists**
  (`editor/settings.ts`, `editor/settings-ui.ts`,
  `editor/quick-card-search-ui.ts`). New `'both' | 'cmir' | 'docx'` setting
  (default `'both'`), added to the `Settings` type, `DEFAULTS`, `sanitize`
  (garbage → `'both'`), the `SettingMeta` kind union, and `SETTING_METADATA`
  (Settings → General, `electronOnly`, next to the file-search folder option).
  Rendered as a three-way radio group (`buildFileSearchFormatsEditor`,
  mirroring `buildSpeechDocFormatEditor`, with a `settings.subscribe` re-sync).
  The search UI filters the cached file list at search time via
  `filterFilesByFormatSetting` (using the existing `fileFormat(f.path)`) at both
  result-building sites (the `f ` prefix and the no-prefix everything-search),
  so toggling it needs no re-scan and takes effect on the next search. The scan
  still lists both formats; this is a display filter. (The empty-folder message
  no longer hardcodes ".cmir".)

- **Command-bar file search lists `.docx` files**
  (`apps/desktop/src/main.ts`, `editor/file-search.ts`,
  `editor/quick-card-search-ui.ts`). The recursive scan behind
  `host:list-cmir-files` (`scanCmirFiles`) now matches `.docx` as well as
  `.cmir` (and skips Word's `~$…` owner/lock files). Results badge the format:
  `badgeText` for a `file` row returns `fileFormat(filePath).toUpperCase()`
  (`CMIR` / `DOCX`) instead of `FILE`, and the displayed name is run through
  `stripFileExt` so the extension isn't shown (the badge already conveys it;
  the search now matches on the bare name, not the extension). Enter opens
  either format — `openFileByPath` → `routeOpenedFile` already routes `.docx`
  through `fromDocxFull`, and `host:read-file-at-path` already returns docx
  bytes — so no open-path change was needed. Tab dives into either format to
  search its objects: the in-file dive (`enterInFile`) and the background warm
  pass (`runWarmPass`) parse via a new `parseFileDoc(bytes, format)` helper
  (`.docx` → `fromDocx`, `.cmir` → `parseNative`) instead of `parseNative`
  directly. Everything downstream — `extractFile`, the outline, the warm cache,
  slice-on-insert — already worked off the parsed schema doc, which `fromDocx`
  and `parseNative` produce identically, so no other change was needed for full
  `.docx`/`.cmir` parity. (Internal IPC/type names keep the `cmir` prefix.)

- **Emphasized selections fill only their EDGE gaps with underline**
  (`editor/ribbon-commands.ts`). When a formatting apply runs, `withGapFix`
  normalizes the gaps around the edit, but only at the OUTER edges of the user's
  selection — internal seams are left as the command set them. The edges are now
  derived from the OPERATING ranges (`getOperatingRangesForFormatting` with the
  `wordRangeAtCursor` fallback — the same ranges the wrapped commands use),
  computed from the pre-command state, NOT from the transaction's mark steps.
  Mark steps were the wrong source: on a mixed-format selection `addMark` skips
  an already-styled sub-range and an excluded-mark removal becomes its own step,
  so step edges land on internal seams (e.g. F10 across emphasized→underlined→
  plain text produced an `addMark` step starting at the emphasized/underlined
  seam, and the merge wrongly underlined that seam). The operating range spans
  the whole selection, so its only edges are the true outer ones; a gap whose
  bookends are both inside it (`gapFrom-1 >= r.from && gapTo < r.to`) is skipped.
  (Mark steps don't move positions, so pre-command ranges stay valid in the
  resulting doc.) Edge gaps get `applyFullGapTarget`, whose named-style rule
  treats underline and emphasis as one family: both bookends carrying either
  (including emphasis+emphasis) → the gap fills with UNDERLINE, so two
  separately-emphasized words join by underline — seamless because
  `.pmd-emphasis` already renders `text-decoration: underline` (the extra
  bold/italic/box/size stays on the words). The manual Fix Formatting Gaps
  command keeps its own per-gap rule unchanged (emphasis+emphasis → emphasis):
  it's a stateless normalizer with no selection-edge concept, so bridging
  like-with-like preserves contiguous emphasized phrases. Cite is unchanged.

- **Per-apply gap normalization honors explicit punctuation selections**
  (`editor/ribbon-commands.ts`). `withGapFix` skips its cleanup for a changed
  range the user selected deliberately. That skip was whitespace-only
  (`/^\s*$/`); it now fires for any changed range with no bookend word
  character — whitespace, punctuation, or a mix. A new `WORD_CHAR_RE`
  (the same `[A-Za-z0-9'"‘’“”]` bookend class `GAP_REGEX` uses) drives the
  test (`if (!WORD_CHAR_RE.test(textBetween)) continue`), so a selection that
  is entirely gap content (e.g. `...`, `, `, ` -- `) keeps the style applied to
  it instead of being stripped/bridged, even when a flanking word is styled.
  Formatting a real word still bridges punctuation gaps to a styled neighbor as
  before (the changed range has a word char, so the cleanup runs).

- **Name/id-based analytic recognition on import**
  (`ooxml/styles.ts`, `import/importer.ts`, `import/index.ts`). The importer
  used to resolve a paragraph's node type by an exact match of its `w:pStyle`
  styleId against `PSTYLE_TO_NODE` (`Heading1`…`Heading4`, `Analytic`,
  `Undertag`) — it never read `word/styles.xml`, so it had no access to a
  style's human-readable name or its type. Analytics authored under a
  different template's style therefore imported as plain body paragraphs.
  Import now reads and parses `styles.xml` into a `styleId → {name, type}`
  map (`parseStyles`, threaded through `importDoc`'s new optional `stylesXml`
  arg and `ImportContext.styles`), and `resolveNodeType` adds a fallback
  (`fallbackNodeType` in `styles.ts`) when the exact lookup misses: (1) a
  style whose name or styleId is "Analytic Real" → `analytic`; (2) a
  **paragraph-type** style whose name or styleId contains "analytic" →
  `analytic`. Matching is case-insensitive and whitespace-insensitive (so the
  display name "Analytic Real" and the space-stripped styleId "AnalyticReal"
  both match). The paragraph-type guard keeps linked character styles out of
  rule 2; ordering after the exact lookup means canonical styles are never
  reclassified. The styleId-based checks still fire when `styles.xml` is
  absent (a minimal `StyleInfo` is synthesized from the pStyle token).

- **Outline pane resizable in multi-pane mode**
  (`editor/nav-panel.ts`, `editor/multi-pane-shell.ts`, `editor/style.css`).
  The single-doc nav panel has always carried a right-edge drag handle that
  writes the `--nav-width` CSS variable and persists the `navWidth` setting. In
  multi-doc mode the per-section `NavigationPanel`s each still built that handle,
  but they're hidden by CSS (`.pmd-multi-nav-body .pmd-nav-resize-handle`) —
  the sections share the rail evenly via flex and have no independent width to
  drag, so multi-pane had no working handle at all. The handle logic is now an
  exported `installNavResizeHandle(host)` (factored out of
  `NavigationPanel.installResizeHandle`, which delegates to it), and the
  `MultiPaneShell` constructor calls it on the rail element (`.pmd-multi-nav`,
  also sized by `--nav-width`). Because both layouts read and write the same
  variable and the same `navWidth` setting, the width carries across a
  single-↔multi layout switch. The rail handle is a direct child of
  `.pmd-multi-nav` (not `.pmd-multi-nav-body`), so the existing hide rule
  doesn't catch it; the hover/drag highlight selector gains a
  `.pmd-multi-nav.pmd-nav-resizing` variant.

## 0.1.0-alpha.15 — 2026-06-17

- **Per-apply gap normalization for the formatting family**
  (`editor/ribbon-commands.ts`, `editor/index.ts`). Formatting operating ranges
  are trailing-trimmed by `getOperatingRangesForFormatting` (Layer 3, so a
  double-clicked `word ` styles only the word) — right for toggle-ON, but a
  toggle-OFF left the adjacent space still styled, and word-by-word toggle-ON
  left visible breaks between styled words. Both are now handled by running the
  gap logic automatically after each formatting apply. A new
  `withGapFix(command, effectivePt?)` wraps each formatting factory
  (`applyUnderline`, `applyBodyMark` cite/emphasis, `applyHighlight`,
  `applyShading`, `setHighlightColor`, `setShadingColor`, `adjustFontSize`,
  `setFontSize`). After the wrapped command runs, it reads the ranges its mark
  steps changed (positions are stable across `AddMarkStep`/`RemoveMarkStep`),
  expands each to the adjacent bookend word via `expandToAdjacentBookends`, and
  runs the FULL gap target — `applyFullGapTarget`, every formatting family, the
  same rule the manual Fix Formatting Gaps command uses — over those gaps via
  `forEachGap`, in the command's OWN transaction (one undo step). So applying
  any one style also tidies the others' gaps around the edit (bridge a style
  both new neighbors share, strip one the bookends don't agree on). Two limits
  keep it from surprising: it runs only around the **changed ranges** (a far
  gap elsewhere in the paragraph is untouched), and a changed range that is
  itself **whitespace-only** is skipped — explicitly formatting only whitespace
  is honored even when a flanking word is styled. (`font_size` gaps are
  normalized only when an `effectivePt` resolver is supplied — the size
  commands; the visible styles always are.) Replaces the bespoke
  `clearDanglingBoundaryStyle`. The shared underline handling now covers
  `underline_direct` (structural blocks like tags), in both `applyFullGapTarget`
  and `fixFormattingGaps`, so the manual command also bridges direct underline
  in tags.

- **Bulk structural re-apply / replace over a shadow selection**
  (`editor/ribbon-commands.ts`). `selectAllOfStyle` (right-click a ribbon style
  button) sets shadow ranges and collapses the PM selection, but
  `applyStructuralToSelection` only read the real selection — so a shadow
  spanning many blocks couldn't be re-styled. The structural commands
  (`setTag`/`setAnalytic`/`setUndertag`/`setHeading`) now, in their
  empty-selection branch, try two shadow handlers before the single-cursor
  logic. (1) `bulkReapplyStructuralOnShadow` — when the shadow's blocks already
  match the pressed style, `removeMark`s `font_size` across every same-type
  block in one transaction (the same-type re-press effect, scaled to all
  matches; keeps the shadow alive via `META_OPERATING_ON_SHADOW`). The intended
  way to scrub stray imported `.docx` sizes off all tags. (2)
  `bulkReplaceStructuralOnShadow` — converts each matched block to a different
  style. `applyStructuralToSelection`'s core is extracted to
  `computeStructuralReplacement(state, from, to, opts)`; the bulk path runs it
  per shadow range and applies the per-doc-child replacements back-to-front (so
  lower positions stay valid) in one transaction. Container head swaps go
  through dedicated node-builders `cardToAnalyticUnitNode` /
  `analyticUnitToCardNode` (extracted from the cursor commands) instead of
  `transformDocChild`, which would dissolve the card and lift the cite/body to
  doc level; heading↔heading and rarer cross-tier conversions use the shared
  transform. No `META_OPERATING_ON_SHADOW`, so the now-stale matches dissipate.
  Only fires for `fromShadow` selections; real selections keep the contiguous
  apply.

- **Trailing-pilcrow selection cue** (`editor/pilcrow-selection-plugin.ts`,
  `editor/index.ts`, `editor/style.css`). A selection's end can land at offset
  0 of a later textblock — the shape Ctrl/Alt-Shift-Down produces (and native
  Shift-Down past a block's end). The paragraph break between the last
  visibly-selected block and that block is then *inside* the selection with no
  glyph marking it, so deleting or replacing the range merges the two blocks —
  surprising, because the grabbed break is invisible. A display-only plugin now
  makes it visible the way Word's end-of-paragraph selection decoration does:
  its `decorations(state)` checks the same predicate as `type-over-boundary.ts`
  (selection end at `parentOffset === 0` of a textblock, selection start before
  that block), finds the leading block's content-end via
  `Selection.near(resolve(tailBlockStart), -1).to`, and draws a
  `Decoration.widget` (`¶`, `side: -1`, `ignoreSelection: true`) there. It
  changes no behavior — it's recomputed from the live selection and is never a
  mark. The cue is styled to read as a flush continuation of the selection: it
  inherits the line's font metrics and uses `display: inline-block` so its
  highlight box matches the full line-box height of the native `::selection`
  rectangle around it (an inline span would paint only the glyph's
  ascent/descent and pinch in where line-height exceeds the glyph). Covers the
  trailing/downward case only.

- **Caret stays in the leading block when a cross-boundary delete can't merge**
  (`editor/boundary-cursor-keymap.ts`, `editor/index.ts`,
  `editor/voice/dispatch.ts`, `editor/ai/cite-creator.ts`). The same
  trailing-break-grab selection that the pilcrow cue marks lands the caret at
  the START of the next block after a delete, because `deleteSelection` leaves
  it at the mapped selection end. When the two blocks merge (plain paragraphs)
  that's fine, but when an `isolating` boundary blocks the merge — e.g. select a
  card's tag including the break and Backspace — the delete empties the leading
  block yet leaves both blocks standing, and the caret wrongly jumps into the
  untouched next block. New `deleteSelectionKeepingLeadingCursor` runs a
  throwaway `deleteSelection` probe and compares the doc's textblock count: if
  it's unchanged the leading block survived (emptied) without merging, so it
  instead does a clean delete of only the leading block's selected content
  (`[from, leadingEnd]`, where `leadingEnd = Selection.near(resolve(
  tailBlockStart), -1).to`), which leaves the break/trailing block untouched and
  the caret maps cleanly into the emptied block; if the count dropped the blocks
  really merged (or a whole tag-only card was removed) and the plain delete's
  caret is correct. Position-mapping the survivor directly is unreliable —
  `deleteSelection` collapses the content and the boundary into one cut point,
  so no original position resolves back inside the emptied block. Wired as the
  last Backspace/Delete fallback after the tag-boundary commands
  (`keepCursorInLeadingBlockOnBlockedMerge`), and reused by the voice `delete`/
  `deleteQuote`/`retype` commands. AI Format Cite gets the equivalent at its
  insert site: after the `TextSelection.between` clamp, a `to` that sits at
  `parentOffset === 0` of a later block is pulled back to the leading block's
  end before `insertText`, and the caret is pinned to the end of the inserted
  cite (a selection reaching INTO the next block's text — `parentOffset > 0` —
  is left to the existing own-paragraph split). Enter/`splitBlock` over such a
  selection is not yet covered.

- **Explicit font size overrides the per-style display size on cite / underline
  / emphasis** (`schema/marks.ts`, `editor/style.css`). `.pmd-cite`,
  `.pmd-underline`, and `.pmd-emphasis` hard-set `font-size: var(--pmd-size-*)`
  (the per-style display size). Since these named-style marks render INSIDE the
  outermost `font_size` wrapper, that rule clamped the glyph to the display size
  and an explicit per-run size only grew the wrapper's box — line height and the
  selection band changed, the letters didn't. The `font_size` mark's `toDOM`
  now also publishes `--pmd-run-font-size`, and the three rules read
  `font-size: var(--pmd-run-font-size, var(--pmd-size-<style>))` — so a run that
  carries a `font_size` mark uses it, otherwise it falls back to the display
  size. This makes the render match `ptForRun`'s precedence (a `font_size` mark
  is "direct" and wins) and Word's direct-`<w:sz>`-over-character-style
  semantics. Note: imported docs whose cite/underline/emphasis runs carry a
  stored `<w:sz>` now render at that size instead of the uniform display size
  (consistent with the size chip, which already flagged them as direct).

## 0.1.0-alpha.14 — 2026-06-13

- **macOS voice no-audio: microphone permission/entitlement + capture fixes**
  (`apps/desktop/package.json`, `apps/desktop/build/entitlements.mac.plist`,
  `apps/desktop/src/voice/ipc.ts`, `editor/voice/controller.ts`,
  `editor/voice/capture.ts`). The mic could be selected and the stream
  connected, but every sample was zero (running context, native rate, processor
  firing, peak ≈ 0). The **root cause**: the packaged app is hardened-runtime +
  ad-hoc-signed, but electron-builder's default entitlements omit
  `com.apple.security.device.audio-input` and there was no
  `NSMicrophoneUsageDescription` — so macOS handed back a silent track while
  getUserMedia "succeeded". Fixes: a custom `entitlements.mac.plist` granting
  `audio-input` (wired via `mac.entitlements` + `entitlementsInherit`, with
  `hardenedRuntime: true` explicit) — **including
  `com.apple.security.cs.disable-library-validation`**, which electron-builder's
  default carries and a custom file must keep, or the hardened runtime refuses
  to load the Electron Framework in an ad-hoc build and the app crashes at
  launch; an `NSMicrophoneUsageDescription` in `mac.extendInfo`; and a
  `systemPreferences.askForMediaAccess('microphone')` call in the
  `host:voice-start` handler (darwin-only) that prompts on first use and returns
  `voice-mic-denied` (surfaced as an "enable it in System Settings" toast) if
  refused. Two supporting audio-path fixes: (1) the `AudioContext` is created
  after `await getUserMedia` — outside the user-gesture tick — so Chromium could
  start it *suspended*, leaving the ScriptProcessor's `onaudioprocess` to never
  fire; now `await ctx.resume()` after creation. (2) It no longer forces
  `new AudioContext({ sampleRate: 16000 })`, which makes a `MediaStreamSource`
  emit silence on macOS Core Audio when the input device runs at 44.1/48 kHz
  (Linux/PulseAudio happened to resample it); it now uses the context's native
  rate and downsamples each capture buffer to 16 kHz in-app (`downsampleTo16k`,
  box-average anti-aliasing; the worker still expects 16 kHz mono s16le).

- **`bold_off` mark — un-bolding inside bold-by-default blocks**
  (`schema/marks.ts`, `ribbon-commands.ts`, `import/importer.ts`,
  `export/exporter.ts`). Tags/headings render bold via CSS, and the `bold`
  mark only ADDS bold — so there was no way to represent (or display) a word
  explicitly un-bolded inside a tag: docx `<w:b w:val="0"/>` was dropped on
  import (the run then rendered bold from the tag's style) and never emitted
  on export. New `bold_off` mark, mutually exclusive with `bold` (`excludes`),
  renders an inline `font-weight: normal` that beats the `.pmd-tag` rule and
  round-trips to `<w:b w:val="0"/>`. Mod-B / the Bold button is now
  context-aware (`toggleBold`): in a bold-by-default structural block
  (tag / analytic / pocket / hat / block) it toggles `bold_off`; in body it
  toggles `bold` as before. `bold_off` is in the direct-formatting strip set,
  so Clear to Normal and promotion restore the block's default bold — but NOT
  the named-style apply-strip, so applying cite/underline/emphasis to a
  deliberately un-bolded word doesn't silently re-bold it. Import maps
  `<w:b w:val="0"/>` → `bold_off` (was: dropped); export emits it. Like
  `font_size`, it parses only its own `data-bold-off` span (not arbitrary
  `font-weight: normal`), so it isn't sprayed onto pastes carrying an
  explicit-normal weight.

- **Lock Highlighting** (`create-reference.ts` `lockHighlighting`, wired in
  `ribbon-commands.ts` + `ribbon-groups.ts` + the Card menu's Highlighting
  submenu). In-place sibling of Create Reference: a `Command` that drops each
  highlighted run's `highlight` mark and adds the protected light-gray
  (`C0C0C0`) `shading`, freeing the highlight layer so the card can be
  re-highlighted in one pass. Scope follows the selection: non-empty selection
  → the selected range; empty selection → the nearest enclosing `card` /
  `analytic_unit` (`enclosingCardRange`), and a no-op if the cursor isn't in
  one — deliberately NOT the smallest enclosing container, so it never locks a
  whole `block` / `hat` / `pocket`. One undo step. Differs from Create
  Reference: edits in place (no clipboard), writes no `<<… FOR REFERENCE>>`
  heading, leaves font size alone, and never sets a gray `font_color` (the
  point is to keep the card editable). Existing `shading` runs are left
  untouched, so it's idempotent on already-locked text. No default keybinding;
  rebindable; in the command palette via aliases (lock highlights / grey
  highlights / rehighlight). Distinct from the existing `highlightToShading`,
  which preserves each highlight's color rather than forcing gray.

- **Spell check joins style-split words** (`viewport-spellcheck.ts`).
  `computeDecos` ran the word regex over each text node separately, so a word
  whose styling changes mid-word — which ProseMirror stores as adjacent text
  nodes with different marks ("signifi" underlined + "cant") — was checked as
  fragments and the fragments flagged. It now iterates textblocks (not text
  nodes), joins each block's inline content into one string with a
  char→doc-position map (non-text inline nodes insert a sentinel `WORD_RE`
  can't match, so words don't span an image/break), and checks/decorates the
  whole word across the mark boundary. The per-block detection is extracted to
  a pure `misspelledRangesIn` helper. Analogous to the earlier possessive-
  apostrophe fix: check the real word, not a fragment.

- **`.cmir` gzip compression** (`native/codec.ts`, `native/index.ts`,
  `docid.ts`). The native file is now a gzip-wrapped JSON envelope — the JSON
  shape and `formatVersion` are unchanged, since compression is a container
  concern. The format is self-describing by magic bytes: legacy plaintext
  always begins with `{` (0x7B), gzip with 0x1F 0x8B, which never collide, so
  `parseNative` sniffs the first two bytes and either inflates or passes the
  bytes through. Old uncompressed files keep opening with no version flag;
  `serializeNative` minifies then gzips (level 6). `looksLikeNative` and the
  one direct-bytes bypass (`docid.ts`) are gzip-aware; `stampDocId` mirrors
  the input's format (compressed stays compressed, plaintext stays plaintext).
  Codec is **fflate** (synchronous, dependency-free): `parseNative`/
  `serializeNative` run in the Electron renderer and the browser build, where
  `node:zlib` isn't available and `CompressionStream` is async — going async
  would ripple through every call site. ~10× smaller corpus-wide; inflation on
  open is a small fraction of the JSON parse and happens only on open/dive
  (never on the file listing or repeated in-file search). Alpha policy:
  one-shot read+write, no two-phase rollout — users update rather than sharing
  across versions.

- **Bulk-compress migration tool** (`bulk-compress-ui.ts`; `host:bulk-compress`
  in `apps/desktop/src/main.ts`, exposed via preload + `electron-host.ts`).
  Existing files only shrink as they're re-saved, so a bulk-converted corpus
  would stay uncompressed indefinitely; this Home-screen modal (Electron only)
  rewrites every `.cmir` under a chosen folder compressed, in place. The
  per-file loop runs in the **main process** — not the renderer like
  bulk-convert — to avoid streaming the whole corpus across IPC and to get
  atomic rename + `utimes`. Each file is read, **skipped if already gzip**
  (idempotent / re-runnable / mixed-folder safe), gzipped (`node:zlib`),
  **verified** by inflating and comparing to the original, written to a temp
  file, **atomically renamed** over the original, and its **mtime restored**
  (so the command bar's recency ordering isn't disturbed). Progress streams
  back throttled (~10/s). Deliberately a transitional tool — isolated in its
  own file + handler so it's a clean deletion after a few releases.

## 0.1.0-alpha.13 — 2026-06-12

- **AI edit coordinator** (`ai/edit-coordinator.ts`, wired in `index.ts` +
  `multi-pane-shell.ts`, `style.css`). AI operations apply their edits after
  an async model call, capturing target positions up front. Concurrent ops —
  another AI op, or the user typing — moved the document underneath them, so
  positions drifted (cites landed at the wrong offset) or the op aborted
  outright (formatting repair bailed on any doc change). A new per-view
  plugin holds **edit leases**: each in-flight op claims its region, and the
  plugin remaps every lease through `tr.mapping` on every transaction (the
  same anchoring the comment marks and voice plugin use). Two guarantees fall
  out: edits *outside* a lease remap it (the op reads `lease.region()` at
  apply time instead of a stale offset), and edits *inside* a lease are
  blocked (`filterTransaction` rejects a non-bypass transaction that changes
  content length inside any live lease; the op's own writes carry a bypass
  meta). The shells also pre-check `coordinatorBlocks` in `dispatchTransaction`
  so a rejected user edit flashes the locked region (`.pmd-ai-locked-flash`).
  Disjoint ops run concurrently; an overlapping claim is rejected
  (`claimRegion` returns null → the caller toasts "try again in a moment").
  Leases are plugin state, never serialized; register/release/flash are
  meta-only, so they add no undo steps, and `markBypass` deliberately does
  *not* force `addToHistory: false` so an AI content edit stays undoable.
  Migrated every async doc-mutating AI op onto leases: cite creation
  (`cite-creator.ts`), text repair (`repair-text.ts` — its two passes share
  one lease, and `collapseToSingleUndo` was confined to the leased range via
  slices so it no longer reverts the whole doc, which would clobber a
  concurrent op's edits elsewhere), formatting repair (`repair-formatting.ts`
  — dropped the `doc !== startDoc` hard-abort; `applyFormatPlan` takes a
  uniform `delta` since in-region edits are blocked), and image alt-text and
  table extraction (`image-ai.ts`). For ops that captured many interior
  positions, a single `delta` re-anchors them all (valid because in-region
  edits are blocked, so the whole region moves uniformly).

  Making concurrency routine surfaced the single-slot AI cues
  (`ai-working-plugin.ts`, `ai-activity.ts`, `cite-creator.ts`,
  `thinking-tooltip.ts`): the ai-working plugin held one decoration and
  cite-creator kept a module-level `activeActivity` singleton, so a newly
  started op tore down a still-running op's box/pill. The plugin now keys its
  decorations by an `AiActivity` token (one box per op, each remapped
  independently through edits); cite-creator drops the singleton and gives
  each call its own activity, cleaned up in its own `finally`. The pinned
  "Thinking…" pills also queued onto the same spot when several targets
  scrolled off an edge; `ThinkingTooltip` now keeps a static registry and
  lays every pill out together — targets in view anchor above themselves,
  off-top targets stack downward from the top edge and off-bottom targets
  upward from the bottom edge in creation order, advancing as each finishes,
  grouped by editor so multi-pane panes stay independent.

- **Per-style paragraph spacing** (`settings.ts`, `settings-ui.ts`,
  `index.ts`, `style.css`). New `displayParagraphSpacing` setting — a
  `Record<'<style>Before' | '<style>After', number>` in points — defaulting
  to the editor's previous hard-coded per-style margins (e.g. pocket
  18/9 pt, tag 9/3 pt, body 0/0). `applyParagraphSpacing` pushes each to a
  CSS variable (`--pmd-para-<style>-before` / `-after`), and the `.pmd-*`
  margin rules now read those (with the original rem values as fallbacks,
  so zero-config rendering is unchanged). The Appearance editor
  (`buildParagraphSpacingEditor`, kind `paragraphSpacing`) is a 3-column
  grid (style / Before / After) with a reset-to-defaults button. The
  body-level CSS rule was split so cite, undertag, and body paragraphs take
  independent spacing, and the heading levels (pocket/hat/block) get their
  own values (line spacing groups them, but their margins differ).
  Display-only, like line spacing — not written to docx.

- **Structural-style apply: selection boundary and same-type re-press**
  (`ribbon-commands.ts`). Two refinements to applying tag/analytic/heading
  styles:
  - `applyStructuralToSelection` over-applied on a downward selection.
    Ctrl-Shift-Down extends the selection to offset 0 of the *next*
    textblock; that paragraph has nothing actually selected, but the
    doc-child sweep counted it as touched (its `cStart < to`) and restyled
    it. The function now pulls `to` back across the opening boundary when
    `$to.parentOffset === 0`, so only the genuinely-selected blocks convert.
    (The `selectionAcross` test helper had the same offset-0 shape — an
    inner text node overwriting `to` to the block start — and was fixed to
    `Math.max` to the block end so its multi-paragraph drags still include
    the last block under the new rule.)
  - Re-pressing a structural shortcut on a node that's already that type now
    clears its direct `font_size` marks (tag, analytic, pocket, hat, block —
    not undertag, per request). `stripIndentAtDepth` gained a `clearFontSize`
    option used by the same-type cursor branches; it strips `font_size` over
    the node's content alongside the existing indent reset, dispatching
    nothing when neither changes (no empty undo step). The selection path's
    same-type-in-container case (`transformDocChild`, kept untouched to avoid
    dissolving the card — audit 2026-06-10 P1#4) now routes those heads
    through a new `clearFontSizeOnNode` so an in-place re-press cleans their
    size without breaking the container; doc-level same-type heads already
    cleared via `asTransformed`'s promotion strip.

- **Settings + AI cite-prompt editor: stacked-Escape** (`settings-ui.ts`,
  `ai/edit-prompt-modal.ts`). Both opened their own `document` Escape
  listener, so Escape from the cite-prompt editor (opened from Settings)
  closed both. Both now join the overlay stack (`overlay-stack.ts`): push
  on open, pop on close, and guard Escape with `isTopOverlay`. The Settings
  modal is a shown/hidden singleton, so it pushes in `open()` (idempotent)
  and pops in `close()`.

- **AI cite-prompt editor instructions were stale**
  (`ai/edit-prompt-modal.ts`). The note claimed the model "MUST return JSON
  with `cite` and `tokens` fields", but the default prompt switched to a
  delimited `[[CITE]] … [[TOKENS]] … [[END]]` block (no JSON) that the
  parser splits on. Updated the note to describe that format and why it's
  parser-critical.

- **Line-spacing reset left stale input values** (`settings-ui.ts`,
  `buildLineHeightsEditor`). The editor re-renders on settings change only
  when focus isn't inside it (so it can't clobber a value mid-edit) — but
  the reset button holds focus, so clicking it set the settings (and CSS
  vars) without redrawing the number inputs. The reset handler now calls
  `render()` explicitly.

- **Appearance tab order** (`settings.ts`). Moved the `bodyFont` and
  `lineHeight` metadata entries to directly after `displayTypography` so
  Body font and Line spacing group with the other type controls.

- **Mobile starter doc** (`index.ts`, `makeMobileStarterDoc` +
  `isMobileLayout`). `makeNewDocBody` now picks a layout-specific
  onboarding doc: the desktop starter is all ribbon buttons / F-keys /
  Mod-chords, so on the mobile layout it would describe controls that
  don't exist. The mobile starter introduces the real touch affordances
  (☰ outline, ⋮ menu, Read/Move/Repair mode bar). The layout decision
  reuses `resolveMobileLayout`, recomputed because `makeNewDocBody` runs
  before the boot-time `BOOT_MOBILE` constant initializes.

- **Mobile nav drawer slid out under the mode sheets** (`style.css`). The
  drawer was `z-index: 320`, below the move/repair bottom sheet (325, which
  reuses `.pmd-mobile-movesheet`), the generic sheet (330), and the
  badge/popup layer (340), so opening the outline in Repair/Move mode left
  the sheet on top. Lifted the drawer to 350 and its scrim to 345 so the
  nav pane (and its dimming scrim) sit above every mobile bottom sheet.

- **Voice startup crashed on macOS: missing `vosk_recognizer_set_grm`**
  (`apps/desktop/src/voice/vosk.ts`). The macOS build is pinned to libvosk
  0.3.42 (the last with a prebuilt macOS binary); the dynamic-grammar
  swap `vosk_recognizer_set_grm` was added in 0.3.43, so koffi threw
  "cannot find function" while binding it and voice never started. The
  binding is now optional (bound in a try/catch), and `Recognizer.set-
  Grammar` falls back to recreating the recognizer via
  `vosk_recognizer_new_grm` (present in 0.3.42) when the in-place swap is
  unavailable — a graph rebuild, but it only fires on actual vocabulary
  changes, so dynamic doc vocab keeps working on macOS. Linux and Windows
  (libvosk 0.3.45) still use the in-place swap. Verified both paths against
  the bundled library.

- **Mic capture falls back to the default device** (`src/editor/voice/
  capture.ts`). `getUserMedia` was called with `deviceId: { exact }` from
  the saved `voiceInputDevice`; if that device isn't present (a deviceId
  from another machine, an unplugged mic) Chromium throws
  NotFoundError/OverconstrainedError and voice failed outright. It now
  retries without the device constraint, so it opens the system default;
  a genuinely device-less machine still surfaces "microphone unavailable."

The following came out of validating the 2026-06-10 audit against current
code (`reference-docs/AUDIT-2026-06-10.md`):

- **Change Case truncated text under length-growing case maps**
  (`src/editor/condense.ts`, `toggleCase`). It cased the whole selection to
  one string and re-sliced it back across text nodes by the *original*
  segment lengths, so a character whose uppercase is longer (German ß→SS,
  Turkish İ→i̇) shifted every later slice and ate the final character.
  Rewritten to transform each text-node segment in place (length-safe),
  with title-case carrying word state across segments (so a word split by a
  mark boundary capitalizes only its first letter), edits applied
  back-to-front so positions stay valid, and the selection re-mapped
  through the transaction. Regression tests in `tests/editor/condense.test.ts`.

- **Condense/merge dropped a merged heading's id** (`condense.ts`,
  `mergeRun`). `targetType.create(null, …)` discarded all attrs, so a
  demolish-mode merge whose first touched block was a tag/analytic emitted
  the merged heading with `id: null` — the documented "cursor appears in
  the card above" defect (`schema/ids.ts`): the heading still renders, but
  the nav pane skips it for caret-tracking/selection, and it's only
  repaired on the next `.cmir` load by `stampMissingHeadingIds`. `mergeRun`
  now carries the first source's attrs that the target type supports
  (notably `id`).

- **Find-bar decorations rebuilt on every view update**
  (`src/editor/find-replace-plugin.ts`). `props.decorations` rebuilt the
  full match `DecorationSet` on every update, including selection-only
  ones. Added a per-plugin-instance memo keyed on reference identity of
  (doc, matches, scope, currentIndex) — the plugin's `apply` returns the
  same state object when nothing relevant changed, so selection moves now
  reuse the prior set instead of re-allocating thousands of decorations.

- **Voice grammar-recreate fallback had a use-after-free window**
  (`apps/desktop/src/voice/vosk.ts`, from the macOS fix above). The
  fallback freed the old recognizer before building the replacement; if
  `vosk_recognizer_new_grm` failed/threw, `this.ptr` was left pointing at
  freed memory. It now builds the new recognizer first and frees the old
  only on success.

- **Persistent Flow host could be orphaned on abnormal quit**
  (`apps/desktop/src/flow-bridge.ts`). Only `before-quit` killed the
  PowerShell child, which is skipped on `app.exit()` or a `preventDefault`'d
  quit. Added a `will-quit` handler and a synchronous `process.on('exit')`
  backstop so the child (and its Excel COM reference) is always torn down.

- **Uncondense crashed on an invalid split** (`condense.ts`). A pilcrow in
  a container head (a tag — from a demolish merge, or pasting condensed
  body into a tag) made `tr.split` throw an uncaught `TransformError`
  (two tags in one card violates `tag (…)*`). Guarded with `canSplit`;
  when the split would be invalid the marker is just deleted. Regression
  test in `tests/editor/condense.test.ts`.

- **Editor comment ids overflowed Word's int32 `w:id`**
  (`comments-plugin.ts`). The counter seeded from `Date.now()` (~1.7e12),
  outside the signed-32-bit range OOXML allows. It now starts at 0 and is
  advanced past every id already present whenever threads load
  (`seedCommentIdCounter` in `loadThreads`), keeping new ids small and
  collision-free. Test in `tests/editor/comments-id.test.ts`.

- **Spellcheck flagged possessives** (`viewport-spellcheck.ts`). `WORD_RE`
  kept a trailing apostrophe, so "dogs'"/"James'" were looked up — and
  underlined — with the apostrophe attached. The trailing apostrophe is now
  trimmed before the dictionary check.

- **Floating format panel ignored `ribbonContext`** (`index.ts`). Its
  buttons called `getRibbonCommand(id)` with no context, so they fell back
  to `DEFAULT_RIBBON_CONTEXT` — e.g. applying the default highlight color
  instead of the live one, and ignoring the clear-on-toggle-off setting.
  They now pass the live `ribbonContext` like the ribbon and keymap.

- **Nav-drag editor auto-scroll was a no-op** (`nav-panel.ts`,
  `maybeAutoScroll`). It called `scrollBy` on `#editor`, which isn't the
  scroll container (the overflow is on an ancestor, `#app` single-doc), and
  gated on a mislabeled Y-only check. It now walks up to the real scroll
  container (`findEditorScrollGate`, mirroring `findNavScrollGate`) and
  gates on the pointer being over the editor in both axes (so a drag within
  the nav pane doesn't scroll the doc).

- **`insertSpeechSlice` could dispatch into a destroyed view**
  (`speech-doc-send.ts`). The `setTimeout(…, 0)` insertion read
  `speechView.state` and dispatched with no liveness check; closing the
  speech doc inside the defer window threw. Bails when ProseMirror has
  nulled the view's `docView`.

- **Nav and spellcheck context menus could both be open**
  (`nav-panel.ts`, `viewport-spellcheck.ts`). They tracked open state
  independently. Added a shared `context-menu-registry.ts`: each menu
  registers its closer on open (closing any other) and clears it on close.

- **docId stamping clobbered `docProps/custom.xml`** (`ooxml/docx.ts`,
  `writeDocId`). It wrote a fresh part containing only `cmirDocId`,
  deleting any other custom document properties — contradicting the
  lossless contract. It now reads the existing part and merges: strips a
  prior `cmirDocId`, appends ours with a fresh `pid`, and preserves every
  other property. Tests in `tests/round-trip/docid.test.ts`.

- **Tab/line-break export loss** (`export/exporter.ts`, `emitTextRun`).
  The importer maps `<w:tab/>`→'\t' and `<w:br/>`→'\n', but the exporter
  left those characters inside `<w:t>` content, where Word ignores them.
  `emitTextRun` now splits on '\t'/'\n' and emits `<w:tab/>`/`<w:br/>`
  (mirroring the existing no-break/soft-hyphen handling). Page-break type
  is still not preserved — a `<w:br w:type="page"/>` imports as '\n' and
  re-exports as a plain `<w:br/>` — because the doc model has no node for
  it; tracked separately. Test in `tests/round-trip/inverse.test.ts`.

- **Escape collapsed every stacked overlay at once** (new
  `overlay-stack.ts`; `learn-session-ui.ts`, `learn-create-ui.ts`,
  `learn-manage-ui.ts`, `quick-card-add-ui.ts`, `quick-cards-manage-ui.ts`).
  Those dialogs each attach a `document`-capture Escape listener;
  `stopPropagation` doesn't stop sibling listeners on the same node, so two
  stacked dialogs (e.g. opening the add/edit dialog from a manager list)
  both closed on one Escape. Added a shared overlay stack: each overlay
  pushes a token on open, pops it on close (paired with the existing
  `removeEventListener`), and guards its Escape branch with
  `isTopOverlay(token)` so only the most recently opened reacts. The
  command/search palette uses an input-scoped (target-phase) Escape, not a
  document-capture one, so it isn't part of this and is unchanged; broader
  rollout to other modals (settings, save-as, …) and a full shared-modal
  primitive (focus trap, `role="dialog"`) remain follow-ups. Logic test in
  `tests/editor/overlay-stack.test.ts`.

- **Comment lost when undoing a deletion** (`comments-plugin.ts`).
  `gcOrphanThreads` removed a thread whose `comment_range` mark was gone via
  a non-undoable transaction, so undoing the deletion restored the text and
  the mark but not the thread content — leaving a mark pointing at nothing.
  Added a per-document tombstone (in plugin state, so it can't leak across
  docs/panes; cleared on `load`). The GC pass is now bidirectional: it parks
  an orphaned thread in the tombstone instead of discarding it, and
  resurrects it when its mark reappears (undo/redo/paste). A new `gc` meta
  carries the reconciled `{threads, tombstone}`. Tests in
  `tests/editor/comments-gc.test.ts`.

- **Demolish-mode condense flattened tables** (`condense.ts`). The demolish
  path flattens every container in range into a single textblock run;
  `flattenForDemolish` recursed into a `table` too, pulling its cell
  paragraphs into the merge and destroying the rows/cells. The replacement
  builder also has nowhere to place an atomic block mid-merge. The command
  now scans the affected range for a `table` and bails (no-op) when it finds
  one, leaving the doc — and the table — intact. Test in
  `tests/editor/condense.test.ts`.

- **Block-level content controls dropped on import** (`import/importer.ts`).
  The body loop handled only `w:p`/`w:tbl`, so a `<w:sdt>` (structured
  document tag / content control) and everything inside it was skipped. It
  now unwraps `w:sdt` and imports its `w:sdtContent` children recursively
  (the wrapper carries no content of its own). Test in
  `tests/round-trip/import-sdt.test.ts`. Inline-level sdt and body-paragraph
  `w:jc` alignment remain unhandled (separate, lower-priority).

## 0.1.0-alpha.12 — 2026-06-12

- **Voice control failed to start in packaged builds.** The recognizer
  worker is forked under a real Node binary (`execPath`), which has no
  asar support and so could not load `worker.js` — or koffi — from inside
  `app.asar`; the forked process died instantly with `MODULE_NOT_FOUND`
  and the session ended before it began. (Dev runs were unaffected:
  `__dirname` there is an ordinary directory.) Fixed by unpacking the
  worker tree and koffi — whose native binary lives in the per-platform
  `@koromix/koffi-<os>-<arch>` package — via electron-builder's
  `asarUnpack`, and rewriting the fork target from `app.asar` to
  `app.asar.unpacked` so the real Node loads it off disk. Windows, Linux,
  and Apple Silicon macOS now start a session in the packaged app. Intel
  macOS is still pending: the arm64 CI runner installs only the arm64
  koffi binary, so the x64 dmg ships without its native module.

- **Persistent Verbatim Flow host** (`apps/desktop/resources/flow/
  verbatim-flow.ps1` rewritten as a stdin server; `flow-bridge.ts`
  rewritten as a host manager). Each Flow action used to spawn a fresh
  `powershell.exe -File … -Verb …`, paying Windows PowerShell's cold start
  (CLR load, the OS scanning the launch) plus a fresh COM attach to Excel
  every time — seconds per send on a VM. The helper is now one long-lived
  process: it reads newline-delimited JSON requests on stdin and writes
  one JSON response per line, so payloads travel inline (no more per-call
  temp file). `flow-bridge.ts` spawns it lazily on the first verb,
  serializes requests (one in-flight; Excel COM is single-threaded),
  reassembles responses across stdout chunks, restarts the host if it
  dies, times a wedged request out at 20 s (tearing the host down so the
  next call respawns clean), and kills it on app quit. After the first
  send the cold start is gone and verbs run in milliseconds. Three ways to
  start it, all idempotent: lazily on first use, the new **Start Flow
  Connection** command (`startFlowHost`, a `ping` that warms the process
  without touching Excel), and a Windows-only **flowHostOnLaunch** setting
  that pre-warms it at renderer boot. No idle timeout — the host stays up
  for the session.

- **Voice-control toggle is now a rebindable command** (`toggleVoice`,
  default `Mod-Shift-V`). It moved off a fixed editor keymap into the
  ribbon-command registry, so it shows in the command bar and the
  keybindings editor and honors user overrides. It's view-less (works
  with no pane focused) and hidden off the desktop.

- **Ribbon-command availability gating** (new `ribbon-availability.ts`).
  The command bar, keybindings editor, and shortcuts reference now filter
  the command list through `isRibbonCommandAvailable()` — Flow commands
  appear only on the Windows desktop, voice only on desktop — and skip a
  group when nothing in it is available. The keymap still binds every
  command (each self-guards), and conflict detection still scans the full
  set, so a hidden binding can't be silently reused. Settings gained a
  `windowsOnly` flag with matching gating, used by the new Flow warm-host
  setting; `isWindowsHost()` (Electron + a `Windows` user-agent) is the
  shared check.

- **Send Headings to Flow sends only cite-marked text** (`flow-port.ts`).
  In headings-only mode a `cite_paragraph` now runs through
  `collectCiteText()` — the same nav-pane logic, with discontinuous
  cite-mark bridging and the ampersand-spacing fix — instead of emitting
  the whole paragraph's `textContent`. A cite line with no marks sends
  nothing, mirroring the nav preview.

- **Flow overwrite-prompt cancel no longer blurs the editor**
  (`flow-port.ts`). `window.confirm` steals focus from the contenteditable
  and the cancel branch returned without restoring it, so the editor
  silently stopped accepting keystrokes. Both the cancel and success paths
  now call `view.focus()` — the same fix `speech-doc-send.ts` already used.

- **Help → User Manual** (`main.ts`). The native Help menu links to the
  manual (MANUAL.md on GitHub) via `shell.openExternal`, alongside the
  existing Keyboard Shortcuts entry.

- **AI "Thinking…" pill anchors to an image's real box** (`thinking-
  tooltip.ts`, `ai-working-box.ts`). The shared pill positioned itself
  from `coordsAtPos(from/to)`, which returns only a degenerate caret rect
  for an inline atom like an image — so image alt-text / table-from-image
  ops pinned the pill to the editor's top-left corner. `rangeRect()` (the
  DOM-Range bounding box already used by the purple working box) is now
  exported and used by the pill too, so it anchors to the image and clamps
  to the corner only when the image scrolls off. Equivalent to the old
  behavior for text ranges; a collapsed range still falls back to a
  `coordsAtPos` point anchor.

- **Mobile settings gained the style-typography editor** (`mobile-
  settings-ui.ts`; `displayTypography` now `mobile: true`). A touch
  renderer for the `displayTypography` kind exposes the same per-style
  flags as the desktop (cite underline; undertag/emphasis bold-italic;
  emphasis box) plus an emphasis-box-thickness stepper (0.25–12 pt), not
  just the font-size steppers.

- **Mobile settings stack block editors under their description**
  (`mobile-settings-ui.ts`, `style.css`). The readers list and the
  per-style stepper/toggle editors used to sit in a fixed right-hand
  column, crushing a long description on a narrow screen. Rows whose kind
  is a multi-row block editor now get `pmd-msettings-row-block`, which
  switches the row to a vertical stack with a full-width control.

## 0.1.0-alpha.11 — 2026-06-11

- **Revamped "AI is working" affordance** (new `src/editor/ai/
  ai-activity.ts`, `ai-working-plugin.ts`; rebuilt `thinking-tooltip.ts`;
  used by cite-creator, repair-text, repair-formatting, image alt-text).
  A single `AiActivity` handle now pairs the floating "Thinking…" pill
  with a purple box over the worked-on region, kept in sync. The pill is
  anchored to the editor's left edge and clamps into the visible band —
  pinning to the top or bottom corner (above the dropzone) when the
  target scrolls off-screen, instead of spawning off-view as it did
  before. The box is a view-only decoration in two scopes: `container`
  outlines the enclosing card/unit (mirrors the blue drag-pickup box, in
  the pill's purple), while `selection` marks exactly the worked-on range
  — so selection-based actions (Format Cite, repair) box only the
  selected text rather than the whole containing card.

- **Steady-cursor accessibility setting** (`disableCursorBlink`; new
  `pmd-steady-cursor` body class via `applyCursorBlink` in `index.ts`;
  generalizes `italic-caret-plugin.ts`). The native text caret's blink
  can't be turned off in CSS, so when the setting is on the native caret
  is hidden in the editor (`caret-color: transparent` on `.ProseMirror`)
  and the custom-caret plugin — previously only drawn for a pending
  italic cursor — draws a steady, upright caret (in `--pmd-c-text`) at
  any collapsed cursor, repositioned on selection / scroll / resize /
  focus / settings change. Scoped to `.ProseMirror` so other inputs keep
  their native caret (hiding it there would leave no visible cursor).
  Off by default, under Accessibility.

- **Verbatim Flow integration — experimental, Windows only** (new
  `src/editor/flow-port.ts`, `apps/desktop/src/flow-bridge.ts`,
  `apps/desktop/resources/flow/verbatim-flow.ps1`; `flow*` host methods).
  The six commands are registered as command-palette / keyboard commands
  only — NO ribbon-toolbar buttons, and no default keybindings; the
  "Flow" entry in `ribbon-groups.ts` is purely the shortcuts-cheat-sheet
  / keybindings-editor taxonomy, not a toolbar group. Interoperates with
  Verbatim Flow (the Excel
  template `Debate.xltm`) the same way the Verbatim Word add-in does:
  entirely through the standard Excel COM object model, requiring no
  modification to Flow (a passive recipient of active-cell writes). The
  renderer can't speak COM, so the desktop main process spawns a fixed,
  bundled Windows-PowerShell helper that attaches to the running Excel
  (`[Marshal]::GetActiveObject`), finds the workbook whose name contains
  "flow", and writes the serialized blocks down its active column
  (`ActiveCell.Value2` → `Offset(1,0)`) — or reads the selected cells for
  Pull, or opens `Debate.xltm` for Create. Payloads cross via a temp-file
  arg (never the command line); results return as JSON on stdout. Send
  has four variants (cell vs column × all vs headings-only, where
  "headings" keeps tags/cites/headings and drops `card_body`) plus the
  overwrite guard Verbatim shows. Off Windows every call resolves to a
  "windows-only" result and nothing spawns. Audit + design in
  `reference-docs/SPEC-verbatim-flow-interop.md`.

- **Mobile layout — view-first shell for the web edition** (new
  `src/editor/mobile-shell.ts`, `mobile-plugin.ts`,
  `mobile-layout.ts`, `mobile-settings-ui.ts`, `structural-move.ts`;
  boot branch in `index.ts`; `body.pmd-mobile` CSS section).

  Activation: a new `mobileLayout` setting (`auto`/`mobile`/
  `desktop`, web-only) resolved ONCE per load by the pure
  `resolveMobileLayout` — `auto` picks mobile on any viewport
  narrower than 768px regardless of pointer, and up to 1024px on
  coarse pointers; native hosts never qualify. A `[cardmirror]
  mobile:` boot line logs the inputs and decision on the web
  edition. The shell rides the single-doc machinery (same mountView,
  open/save flows, recovery, home screen) rather than running its
  own editor: it forces the multi-pane branch off for the session
  WITHOUT writing the synced `multiDocWorkspace` setting (the
  mode-switch subscriber is gated so the disagreement never reads as
  a toggle), hides the desktop chrome via CSS, and re-points the
  single-doc layout variables at its own app bar / mode bar / status
  strip. The home screen shows documents only (no Quick Cards or
  flashcard sections), the dropzone pill is not mounted, and
  `runStartupRecovery` is skipped outright — the recovery sidebar is
  a desktop surface, so journals stay put and surface on the next
  desktop-layout launch.

  View-first mechanics: `mobilePlugin` (first in
  `buildEditorPlugins`, no-op outside the shell) supplies
  `editable: () => false` — PM treats editable as false if ANY prop
  says so, composing with the read-mode prop — which keeps the
  on-screen keyboard away entirely while history, decorations, and
  programmatic selection stay live. There is NO grab-and-drag from
  the editor surface on mobile (on touch it is indistinguishable
  from a scroll); structural movement is Move mode and the outline.
  In read mode the plugin's `handleClick` turns a tap into the
  reading-marker toggle at the tapped word (the touch equivalent of
  the Space/Enter binding, which a non-editable view never
  receives). Undo/redo sit permanently in the app bar and run
  `readModeAwareUndo/Redo`.

  Chrome: the outline drawer ADOPTS the desktop `#nav-panel` mount
  (same NavigationPanel instance — caret sync, level filters, and
  click-to-jump unchanged), slides in via left-edge swipe or ☰, and
  on tablet density (≥768px, `pmd-mobile-tablet`) pins as a
  persistent 260px rail that the same ☰ collapses and restores
  (anything that needs the outline — "Send to…" — un-collapses it). The drawer clips overflow and outline
  labels wrap up to three lines before ellipsis. Pinch on `#app`
  drives the SAME content zoom as the desktop status bar (`zoomPct`
  → `--editor-zoom`, CSS `zoom`): live preview writes the variable
  directly, the setting commits once at gesture end in 5% steps; an
  `Aa` sheet carries the slider, a reset-to-100% button, and theme
  segments. The ⋮ menu routes through `runRibbon` (now exported):
  Open, New, Export a copy (Save As → download on mobile browsers),
  Word count, Settings, Use desktop layout (reload), Home.

  Move mode (new `structural-move.ts`): tap a card or heading →
  `unitRangeAtPos` (position-based port of the drag surface's
  `findContainerAt` hit-test) selects the smallest structural unit,
  visualized by node decorations held in the mobile plugin's state;
  an action strip offers Up / Down / Send to… / Copy / Delete. One
  "step" is subtree-aware (`moveInsertPos`): the outermost heading
  subtree ending exactly at the unit's start is hopped whole
  (sibling swap), a bare parent heading line steps the unit out of
  its section, any other heading line is entered (the unit lands as
  the section's first child), and loose neighbors are hopped one
  node at a time. Execution rides the drag system's exported
  `buildMoveTransaction`, so a button move and a drag-drop produce
  identical docs and identical single undo steps; after each move
  the landing selection re-derives the unit so the highlight and
  sheet follow it. "Send to…" reuses the nav panel via a new
  destination-mode API (`enterDestinationMode(cb)`): the drawer
  opens with a banner, a row tap pops an above/below chooser
  anchored at the row, and the unit lands BESIDE the target's whole
  subtree (`entryUnitRange`), never inside it — inserting after a
  same-level heading's line would strand the target's own content
  under the moved unit. The chooser commits on release over a
  choice, so press-slide-release works as well as two taps;
  releasing elsewhere keeps destination mode for another pick, and
  dismissing the drawer cancels. Move and Read modes are mutually
  exclusive (read mode locks the doc and owns taps).

  Repair mode shares Move's tap-select machinery (a `tapMode` in the
  mobile plugin), restricted to CARDS — repairs run one card at a
  time, so heading taps resolve to no unit (with a toast saying so)
  rather than scoping a whole section. The repair sheet offers
  Repair Text / Repair Formatting — scoped to the card's BODY blocks
  only (first card_body/paragraph through the last; the tag and cite
  never enter the scope) — plus Repair Cite, which selects the
  tapped card's `cite_paragraph` — or, when the card has none, the
  first non-undertag paragraph beneath the tag (imported cards often
  carry their citation as plain body text) — and fires the AI cite
  creator (the Mod-Shift-X command). The buttons set a text selection and fire
  the existing ribbon commands — the repair flows read
  `state.selection` and can't tell a tap-made scope from a
  keyboard-made one, so the thinking/Clod progress pill (Clod
  governed by the same setting as desktop, exposed as a toggle in
  mobile Settings), orange flashes, toasts, and single-undo-step
  behavior are the shared implementation verbatim; the scope is
  scrolled on-screen before firing so the pill's anchor is visible.
  With AI features off or no API key on the device, the sheet
  explains and links to the mobile Settings page instead.

  Outline gestures on mobile: the list owns its pointer stream
  (`touch-action: none`). A drag pans the list manually under the
  pointer — identical behavior for mouse, emulated touch, and real
  touch — and a 450ms still-press picks the row up for a drag
  (haptic tick where supported, lifted-row styling); movement within
  the window cancels the press into a scroll. While a drag lives, a
  non-passive `touchmove` blocker keeps the browser from hijacking
  it into a pan; the row context menu is suppressed on mobile (the
  same long-press would otherwise open it), and read mode disables
  pickup, matching the desktop arm path.

  Mobile settings: a second renderer over the SAME
  `SETTING_METADATA` — entries opt in via a new `mobile: true` flag
  (default false, so editing/desktop settings can't leak in by
  omission); flagged: readers, default save format, layout choice,
  theme, display sizes (steppers), reduce motion, AI
  enable/key/model. One scrolling page with section headers rather
  than subpages (the flagged set is small). `SettingMeta` also gains
  `webOnly` (the desktop dialog and the command palette's settings
  search now both apply it, mirroring `electronOnly` — web-only rows
  can't surface in the desktop app's palette) and `searchHidden`
  (the layout setting is reachable from Settings and the mobile menu
  but stays out of command search). The desktop dialog gets a radio
  editor for the layout setting.

- **Web-edition Open could deadlock behind a hung picker**
  (`src/editor/host/browser-host.ts`). `openFile` serialized every
  call behind an in-flight promise; an `openOnce` that never settles
  — a dismissed picker on a browser without the `cancel` event, or
  an `input.click()` silently ignored because its transient user
  activation had expired — wedged the chain, killing every later
  Open across every entry point (they all share the host method). A
  new attempt now supersedes the pending one (settling it as null)
  instead of queueing behind it, so a single hung picker self-heals
  on the next try.

- **Mode-switch (three-pane ↔ windows) restores exactly the open
  set** (`src/editor/index.ts`, new `src/editor/mode-switch.ts`,
  `multi-pane-shell.ts`, `apps/desktop/src/main.ts`, preload +
  electron-host). Primarily a macOS glitch — the trigger was the
  app outliving its windows, which only happens there (see the
  first hole below). The toggle works by journaling every open doc,
  reloading, and letting startup recovery reopen them in the new
  layout. Three holes in that handoff:

  - *Multi→single reopened nothing.* Single-doc boot gates startup
    recovery on `isFirstWindow()`, and main set `firstWindowId` once
    per app session, never reassigning it. On macOS the app stays
    alive after its last window closes, so any window created after
    that point — or surviving a switch that closed the original
    first window — was never "first" and silently skipped recovery;
    the journals just sat there. (On Linux/Windows the app quits
    with its last window, so every launch reset the id — which is
    why this direction only broke on the Mac.) The mode-switch
    reload now runs recovery in the surviving window regardless of
    first-window status (the sessionStorage marker identifies it
    precisely), and main lets the next created window reclaim
    firstness once the last window closes.

  - *Single→multi swept in stale docs.* The post-reload recovery
    auto-opened EVERY journal in the store, not just the ones this
    switch wrote — so leftovers from earlier sessions (including the
    failed multi→single direction above, which consumed nothing)
    reappeared on every toggle. The marker now carries the exact
    uid list the switch journaled: the initiating window's docs via
    sessionStorage, and the docs of the windows the switch closes
    via a main-process accumulator (`host:mode-switch-journaled` /
    `host:take-mode-switch-journaled` — sessionStorage is
    per-window, so a closing window's list can only travel through
    main). Recovery reopens exactly that set; unrelated journals
    stay put for the next normal launch's recovery sidebar, which
    is where crash leftovers belong.

  - *Every switch left bogus journals and dirty flags behind.* The
    switch journals clean docs too (the journal is the transport),
    but the reopen marked everything dirty and never deleted the
    consumed entries — breaking the journals-mean-unsaved-work
    invariant: clean docs came back prompting to save on close, and
    quitting after a switch resurfaced the whole workspace as
    recovery offers. The marker now records each doc's pre-switch
    dirty state; clean docs reopen clean and their journals are
    deleted once they're open (the on-disk file already matches),
    dirty docs reopen dirty with the journal kept. Spawned windows
    (multi→single distribution) get the flag via a new `markDirty`
    field on the spawn payload. A doc reported dirty by any channel
    stays dirty — losing an unsaved-changes flag is worse than a
    redundant prompt. The untouched onboarding starter is skipped
    entirely (it used to journal as a redundant "Untitled" that
    reopened as an extra pane).

  `[cardmirror] modeswitch:` diagnostics along the journal → marker
  → recovery path (forwarded to the dev terminal) for the
  verification loop, alongside the existing main-process `xlog`
  probes.

- **Typing over a block-tail selection preserves the boundary** (new
  `src/editor/type-over-boundary.ts`, wired in `buildEditorPlugins`).
  Triple-click selects a paragraph's inline content, so typing over it
  replaces in place; Ctrl-Shift-Down extends the selection to offset 0
  of the NEXT textblock, so the boundary sat inside the replace range
  and typing merged the blocks — cursor at a tag's start +
  Ctrl-Shift-Down + type folded the cite into the tag. A
  handleTextInput plugin intercepts text input over any non-empty
  selection whose tail sits at parentOffset 0 of a textblock with the
  head in an earlier block, and trims the replace range back to the
  end of the previous textblock (Selection.near walking backward
  across however many structural tokens separate the blocks — works
  for tag|cite inside a card as well as sibling paragraphs).
  Selections genuinely reaching INTO the next block's text are left
  to the standard merging behavior, as are IME composition and paste
  (out of scope: the reported gesture is plain typing).

- **Multi-pane word-count staleness after a pane move fixed**
  (`src/editor/multi-pane-shell.ts`). Full trace of the live counter,
  both modes: single-pane refreshes from (a) the heavy debounced flush
  on doc changes, (b) the selection-only branch under
  `liveSelectionWordCount`, (c) the settings subscriber, (d) initial
  mount/setActiveView. Multi-pane mirrors all four — but its (a) and
  (b) live in the per-record `dispatchTransaction`, which closed over
  the SLOT captured at `buildDocRecord` time. `sendVisibleToSlotByIndex`
  (the Send Doc to Slot commands) moves records between slots via
  `releaseVisible` + `push`, leaving that closure pointed at the old
  slot: every doc-changed flush and selection refresh then updated the
  WRONG pane's footer (a visual no-op there, masking the bug), so a
  moved speech doc's count froze — the reported symptom: Send to
  Speech in multi-pane didn't update the count until something else
  (any settings write → refresh-all, or a stack switch → mountVisible)
  repainted it. DocRecord now carries an `owner: Slot` backref that
  `Slot.push` re-points on every move, and both dispatch-path refresh
  sites use `record.owner` instead of the captured slot. Settings-
  change and mount paths were already parity-correct. THE ACTUAL
  reported bug sat one layer up (found by instrumenting the path
  after the owner fix didn't resolve it — the trace showed flushes
  scheduled but never completing): the shell's send-to-speech wrapper
  passes an afterInsert hook that CANCELLED the destination record's
  pending heavy-update timer ("so the new headings show up
  immediately") without performing the work the timer owed — the
  word-count refresh and full nav rebuild silently never ran, on
  every send. The cross-pane drag-drop handler had the same
  cancel-without-flush pattern. Both now call a shared
  `flushHeavyUpdateNow(record)` (cancel + nav update + word-count
  refresh, synchronously), so the count updates instantly on send —
  ahead of the 200ms debounce an ordinary edit gets. The console
  bridge also now forwards all error-level renderer output
  unconditionally; invisible exceptions in deferred callbacks were
  repeatedly the missing diagnostic.

- **Smart Shrink** (`src/editor/ribbon-commands.ts` `smartShrinkText`;
  ribbon `smartShrink`, Mod-Alt-8, grouped beside Shrink/Regrow).
  One-shot per-paragraph shrink depth: a block with no
  underline_mark / underline_direct / emphasis_mark anywhere goes
  straight to 5pt; blocks carrying those marks shrink their eligible
  text to 8pt. Deliberately deterministic (no AI). Scope mirrors the
  regular shrink cycle via a block-aware variant
  (`computeSmartShrinkBlocks`) — cursor in card/analytic → all its
  bodies, doc paragraph → itself, selection → clipped card_body/
  paragraph portions — with one wrinkle the cycle doesn't have:
  classification reads the WHOLE paragraph even when only part is
  selected (a partial selection in a marked paragraph shrinks to 8pt,
  not 5pt). Eligibility and the protected-span machinery
  (findProtectedRanges + restore-to-Normal under
  shrinkRestoresOmissionsToNormal) are shared with the cycle.
  Idempotent with honest no-op reporting: when every eligible range
  already sits at its target size the command returns false instead
  of burning an undo step. (`src/editor/ai/repair-text.ts`
  `applyPass`). The animated one-at-a-time walk (110ms cadence,
  per-fix flash + scroll) is replaced by one transaction per pass via
  `buildRepairTransaction`, with `setRepairFlashes` blinking every
  replacement range at once — the same presentation as Repair
  Formatting; the two passes read as two blinks. The walk's
  reduced-motion fallback became dead code and is removed (the batch
  path is what it collapsed to). Edits stay off-history with the
  single-undo collapse at the end, unchanged.

- **Repair Formatting (AI)** (new `src/editor/ai/repair-formatting.ts`;
  ribbon `repairFormatting`, Mod-Alt-R; wired in `index.ts` /
  `ribbon-groups.ts`). Normalizes imported body text to Verbatim's
  four-layer scheme (underline ⊇ emphasis; highlight ⊇ shading; bold /
  italic only as a deliberate extra layer or reproduced source
  formatting). Architecture deliberately differs from Repair Text's
  find/replace diffs: the model NEVER re-emits the card. The editor
  computes the card's distinct formatting SIGNATURES (the exact mark
  set per run, plus `du` for direct underline, `small` for
  below-base-size text, `cite` for cite-style debris) and sends the
  plain text plus a signature table with run counts and sample
  excerpts; the model returns a constant-size JSON mapping — signature
  → canonical target — plus optional verbatim-fragment exceptions for
  idiosyncratic spans (e.g. a book title keeping italics against the
  blanket italics→emphasis rule). `applyFormatPlan` rewrites each
  mapped run (scheme marks wholesale-replaced; identity mappings
  skipped so the transaction stays minimal), then applies exceptions
  over every occurrence of each fragment. Guarantees by construction:
  text untouchable (the model has no channel to change it), font sizes
  never modified (they encode shrink state and, in the size-recovery
  pattern, the only surviving underline evidence), highlight/shading
  colors carried over from the original runs. One request per card —
  card-scoped judgments like "is ALL underlining bold?" (which decides
  bold-underline → underline vs emphasis, per the Doc-Style-Cleaner
  heuristic) stay card-scoped; doc-level loose paragraphs pool as one
  group. Base size = largest size with ≥10% char share (largest, not
  modal: shrunk connective text is usually the majority in
  size-encoded cards). The pattern-3 discriminator — does the card
  have any plain (non-bold) underlining? — is computed by the editor
  and stated as a FACTS line in the request rather than left for the
  model to infer: a live all-bold-underline card was mapped b+u → em
  because the model failed to notice the ABSENCE of a bare-u
  signature (models reliably miss absences); the run loop also logs a
  WARNING when a plan contradicts the stated fact. Existing
  emphasis_mark is HARD-protected: a live size-recovery card's one
  emphasized sentence was bulldozed into the blanket plain→u rule, so
  a plan that strips em from an em-carrying signature gets em
  reinstated by the parser (u dropped, since em implies underline),
  with a logged WARNING — the exceptions channel remains the
  deliberate per-fragment override. Target parsing tolerates the
  signature notation the table teaches ("u+hl" splits to ["u","hl"]).
  All requests resolve before a SINGLE
  transaction applies every card (formatting-only edits keep positions
  stable), so the whole repair is one undo step; repaired ranges flash
  like Repair Text. [repair-fmt]-tagged console diagnostics log the
  signature table sent, the full plan and exceptions returned,
  unmapped signatures, dropped/invalid entries, and per-card rewrite
  counts — same refinement loop as [repair]; the main-process console
  forwarder now matches the [repair-fmt] tag too.

- **Repair JSON salvage: unescaped quotes no longer kill the
  response** (`src/editor/ai/repair-text.ts` `salvageJson`, shared by
  `repair-formatting.ts`). Live failure: the model echoed evidence
  containing quotation marks without escaping them inside the JSON
  strings — one missed escape made the whole reply unparseable
  ("Expected ',' or '}' after property value"). On a parse failure
  both parsers retry through a salvage pass that walks the string
  tracking inside-string state and escapes any interior quote not
  followed by a structural character (and folds literal newlines to
  \\n), logging when salvage was needed; the prompt also now tells the
  model explicitly to escape interior quotes. A second live failure —
  a complete JSON object followed by ANOTHER object or trailing prose
  ("unexpected non-whitespace character after JSON"; first-to-LAST-
  brace slicing poisoned the parse even though each piece was fine) —
  falls back to string-aware balanced-object extraction: each
  top-level {...} parses separately and the fixes arrays merge
  (formatting repair takes the first object carrying a map). Only when
  nothing parses does the original error surface.
  output cap raised; failure paths logged**
  (`src/editor/ai/repair-text.ts`, console forwarding in
  `apps/desktop/src/main.ts`). Live diagnosis on a real imported card
  (46 fixes returned, only 31 placed) showed the dominant
  "could not place" cause: the model echoes straight quotes/apostrophes
  in its `find` strings where the document has curly ones — every
  skipped fix in the log was a quoted span. Repro tests confirmed the
  full failure taxonomy: smart-punctuation echoes (dominant), inline
  pilcrows omitted from finds, overlapping context windows, and a
  flattenSelection block-boundary miss when duplicated blocks share a
  node object (copy/paste reuses nodes). Fixes: (1) when the verbatim
  search misses, a folded-space fallback retries — curly quotes/dashes
  → ASCII, ligatures (ﬀ ﬁ ﬂ ﬃ ﬄ) expanded, NBSP/tab/newline → space,
  soft-hyphen/zero-widths dropped (pilcrow deliberately NOT folded:
  it's meaningful content and a folded match spanning one would delete
  it) — and ONLY the differing middle of find→replace (the actual
  correction) is applied. The agreeing prefix/suffix are never edited,
  so the document keeps its punctuation and ligatures there, and the
  context may legitimately span a block boundary (a second live run
  showed the model writing a space where the doc has a newline);
  only an edit middle crossing a boundary is rejected — joining or
  splitting blocks from a non-verbatim match is too ambiguous.
  Middle-only edits can be pure deletions, so both apply sites guard
  the empty-replace case (insertText('') throws). VERBATIM matches
  also reduce to their middles before overlap resolution — fixes whose
  context windows overlap now coexist when their actual edits are
  disjoint (live: a detected "self- help" fix was dropped under
  another fix's context). Exact duplicates of an already-placed edit
  (the model lists one correction under two context wordings) drop
  SILENTLY — they're not losses, so they no longer inflate the
  "couldn't be placed" count in the toast; conflicting same-point
  insertions still count. The fold
  is also case-insensitive (live: the model echoed "in much of…" for a
  doc reading "In much of…" — safe because the agreeing context is
  never edited, so the doc keeps its case), and a LAST-RESORT trimmed
  retry handles word-level context misquotes (live: the model dropped
  "the" from "of the re sis tance literature"): whole context words
  are cut from the find's ends — within the agreeing prefix/suffix
  only, smallest trim first, minimum-needle-length guarded — and the
  shorter pair retried through the folded locator; the reading-order
  cursor keeps a less-unique needle honest. This also rescues "--"
  echoed for an em-dash when the corrupted word is trimmable context.
  Case folding applies to the SEARCH only: the find→replace diff is
  computed case-sensitively (the comparison is model-internal), so a
  fix whose whole point is a case change ("Of" → "of", live miss) is a
  real edit middle rather than folding away to a discarded no-op.
  Remaining pinned gap: a find that omits an inline pilcrow. (2) The
  reply cap rises
  4096→16K with stop_reason checked — a truncated fix list previously
  surfaced as an opaque "not valid JSON" error; now it's an actionable
  "repair a smaller region". (3) Every outcome logs a [repair]-tagged
  console line (per-pass placement summary, classified skips, errors),
  and the Electron main process forwards [repair]/[cardmirror]-tagged
  renderer console lines to stdout so terminal dev sessions can see
  them. (4) Detection: the prompt now names the
  stray-space-after-hyphen artifact explicitly with both resolutions —
  keep the hyphen for genuine compounds ("neo- Gramscian" →
  "neo-Gramscian"), drop it for ordinary words split across a line
  ("re- search" → "research"); the old prompt only covered line-break
  hyphenation, and the strict leave-it-if-uncertain guideline made the
  model skip mid-line hyphen-space errors entirely. Known remaining
  gaps (pinned in tests): omitted pilcrows, and the shared-node
  flatten boundary miss.

- **Anthropic translation output ceiling raised; truncation surfaced**
  (`src/editor/translate.ts`). `translateAnthropic` inherited the
  client's `DEFAULT_MAX_TOKENS = 1024` — sized for chat replies, not
  translations, whose output is roughly input-sized. Anything past a
  few paragraphs came back with `stop_reason: 'max_tokens'`, which the
  translator ignored: the cut-off text was copied to the clipboard as
  if complete. Now: the translation call requests a 16K-token ceiling
  (output tokens only bill as generated, so the headroom is free on
  short selections; 16K stays within non-streaming HTTP comfort), and
  `stop_reason === 'max_tokens'` threads through `TranslateOutcome.
  truncated` — the toast warns, and the clipboard text itself gains a
  trailing `[TRANSLATION INCOMPLETE — OUTPUT LENGTH LIMIT REACHED]`
  line so the incomplete result can't be pasted without notice. Other
  AI features keep the 1024 chat default. The MyMemory/Google paths
  are unchanged (MyMemory chunks at its per-request cap and errors
  loudly on quota; neither silently truncates).

- **Cite-debris cleanup: shadow ranges skip the Layer-3 trim;
  classification ignores whitespace-only cite runs**
  (`src/editor/ribbon-commands.ts` `getOperatingRangesForFormatting` +
  `sizeCycleCommand`, `src/import/importer.ts` `hasCiteMark`,
  `src/editor/cite-classifier-plugin.ts`,
  `src/editor/similar-selection-plugin.ts` `computeSimilarMatches`).
  Real-doc case (burgum 18): a card body imported with its entire
  un-underlined text as 8pt runs carrying `cite_mark` — the original
  cut's condensed un-underlined text, cite-styled in the source docx,
  boundary spaces inside the runs. The failure chain: content-based
  classification (any cite_mark → cite_paragraph) typed the body as a
  cite line; shrink's scope only collects card_body/paragraph, so it
  silently no-opped; and the natural cleanup — Select Similar on the
  un-underlined text, then F12 — ALMOST worked: the matches were
  correct, but `getOperatingRangesForFormatting` applied the Layer-3
  trailing-space trim (built to undo double-click word-unit
  absorption, one selection at a time) to EACH of the ~55 matched run
  ranges, shaving one space per run. Those 55 still-cite-marked spaces
  kept the live classifier re-affirming cite_paragraph, so the
  paragraph stayed unshrinkable with no visible formatting left.
  Fixes: (1) shadow-selection ranges skip the Layer-3 trim — they're
  text-run-exact, nothing was absorbed; (2) both `hasCiteMark` sites
  skip whitespace-only runs, so space-only cite debris can't classify
  a paragraph (root cause — the doc now imports as card_body in the
  first place; the inverse suite pins it); (3) whitespace-only runs
  match Select Similar fingerprints on marks alone, size ignored —
  relevant when re-sampling already-cleaned text whose size no longer
  matches the debris; (4) shrink with the cursor in a cite_paragraph
  shows a toast naming the blocker instead of silently returning
  false. Existing .cmir files with debris reclassify on the first edit
  that touches the paragraph (the classifier is transaction-scoped).

- **Structural command with a selection inside a same-type head fixed**
  (`src/editor/ribbon-commands.ts` `applyStructuralToSelection` /
  `transformDocChild`). With a non-empty selection, F7 routed through
  the selection path, which marked the tag as "touched": the tag was
  re-wrapped as its own card, but every following card child was lifted
  to doc level — the cite_paragraph became a plain paragraph (losing
  the cite slot and styling) and the body detached from the card. The
  cursor path treats F7-in-a-tag as a no-op, so the two gestures
  disagreed destructively. Subtle in practice because the tag keeps its
  card wrapper — the visible symptoms are the cite losing its
  formatting and condense no longer folding the body. Fix: a child the
  command would re-create as the type it already is (tag under setTag,
  analytic under setAnalytic, undertag under setUndertag, matching
  heading under setPocket/Hat/Block) now counts as untouched, and a
  changed-content check makes a fully same-type selection return false
  instead of dispatching an identical replace (which burned an undo
  step and yanked the cursor). The deliberate split semantics —
  selection in a card_body splits a new card; multi-paragraph
  selections wrap each paragraph — are unchanged. Known residual
  asymmetry: a CROSS-type selection on a head (F7 with analytic text
  selected) still converts only the head where the cursor path converts
  the whole unit; recorded in the audit doc.

- **NavigationPanel leak on doc close fixed** (`src/editor/nav-panel.ts`,
  `src/editor/multi-pane-shell.ts`). The multi-pane shell creates one
  NavigationPanel per open doc; closing a doc destroyed the EditorView
  and detached the drag surface but never the panel. The panel's
  constructor-time `settings.subscribe` and attach-time
  `dragController.subscribe`/`registerSurface` closures therefore kept
  the panel reachable for the whole session — pinning `currentDoc` (a
  full ProseMirror doc snapshot, MBs for a real file) and the rendered
  `liEntries` map, and the leaked drag subscriber kept running
  hover/auto-expand hit-testing on every drag move event. New
  `NavigationPanel.destroy()` releases all three subscriptions, removes
  the document-level drag listeners (covers closing mid-drag), cancels
  the auto-expand/auto-restore timers, clears the entry map, nulls
  doc/view, and removes the root element; both shell close paths call
  it beside `view.destroy()`. A `destroyed` flag turns any late
  debounced `update()` into a no-op so a straggler can't re-pin the
  snapshot the destroy just released.

- **Global hotkey fallback case-folding fixed**
  (`src/editor/ribbon-commands.ts` `ribbonKeyStringFor` /
  `ribbonCommandForKey`). The window-level keydown fallback (the path
  that fires when focus is on the ribbon/nav/chrome rather than the
  editor) built its lookup string from `e.key` verbatim — but a real
  Shift or CapsLock keydown produces an uppercase letter ('S'), while
  bindings are registered lowercase ('Mod-Shift-s'), so every letter
  chord missed and the browser default fired instead. Inside the
  editor prosemirror-keymap normalizes case, which is why the same
  shortcuts worked there. `ribbonKeyStringFor` now folds
  single-character keys to lowercase, and `ribbonCommandForKey` folds
  both sides of the comparison — necessary because the keybindings
  editor captured overrides through the unfolded path, so a user's
  saved `Mod-Shift-Y` must keep matching after the fix.

- **Find/Replace offset corruption after inline images fixed**
  (`src/editor/find-replace-plugin.ts` `findMatches`,
  `src/editor/find-replace-ui.ts` `buildSnippet`). Match positions were
  computed as character offsets into each textblock's `textContent` —
  but inline image atoms occupy one document position while contributing
  zero characters, so every match after an image sat one position left
  per preceding image: decorations misaligned, snippets sliced wrong,
  and Replace edited a shifted range (corrupting the neighboring text).
  Both sites now scan `textBetween` with a one-character leaf
  placeholder, which keeps string offsets identical to document
  positions. The scan uses `U+0000` (impossible in a query, so a match
  can never span an image — correct, since there IS an image between
  those words); the snippet uses U+FFFC so an image shows as the
  standard object-replacement glyph in find results.

- **Undertag italic round-trip fixed** (`src/import/importer.ts`,
  `parseRPr`). The exporter dual-encodes `undertag_mark` as
  rStyle="UndertagChar" + `<w:i/>` (the style implies italic display in
  Word — same parity precedent as underline's `<w:u/>`), but the
  importer mapped `w:i` → italic unconditionally, so one save/open
  cycle added a real italic mark to every undertag run. `w:i` is now
  deferred to the end of the rPr scan (OOXML guarantees no order
  between rStyle and run properties, the same reason `w:u` defers) and
  swallowed when `undertag_mark` is present. Consequence, accepted: a
  *user-applied* italic on undertag text is lost on round-trip — the
  exporter emits byte-identical runs for undertag and undertag+italic,
  so no inverse can distinguish them, and rendering is identical either
  way (the style already displays italic). This mirrors underline's
  long-standing dual-encoding trade.

## 0.1.0-alpha.10 — 2026-06-08

- **Reading-position marker** (`src/editor/reading-marker.ts`, read-mode
  wiring in `src/editor/read-mode-plugin.ts`, ribbon `toggleReadingMarker`).
  Inserts a red text run `Marked h:mm` (the `font_color` mark at `FF0000`,
  Verbatim's red-text convention) at the cursor and places the caret after
  it; the inclusive red mark is stripped from stored marks so it doesn't
  bleed into the next typing. Toggling: `readingMarkerRunAt` detects when
  the cursor sits on (or at either edge of) an existing red run — expanded
  over adjacent marker text nodes — and the command deletes it instead of
  inserting. Round-trips to Word as a normal colored run.
  - **Own undo step.** Both the insert and delete paths call
    `closeHistory(tr)` so each marker is isolated in history — never grouped
    (PM's `newGroupDelay` / adjacency) with a nearby edit, which would make
    undoing the marker also revert that edit.
  - **Read-mode integration.** Read mode now keeps the editor `editable`
    (caret placeable) and blocks edits via `filterTransaction`, which lets
    through only transactions flagged `READING_MARKER_META` or
    `READ_MODE_UNDO_META`. A `handleDOMEvents.keydown` handler (fires even
    though keymaps don't, under `editable: false` historically — now under
    the filter) maps bare Space/Enter to the toggle. The plugin's
    `isReadKept` keeps red marker text visible in read mode.
  - **Undo bounded to markers.** On read-mode entry the plugin snapshots
    `baseUndoDepth`; `readModeAwareUndo` (Mod-Z) only undoes while the depth
    exceeds it, so undo can't reach edits made before read mode.
    `readModeAwareRedo` (Mod-Y / Mod-Shift-Z) is gated on a `dirtied` flag
    set by a marker edit, so redo only re-applies undone markers. Both tag
    their transactions `READ_MODE_UNDO_META` to pass the filter.

- **Slanted caret for pending italic** (`src/editor/italic-caret-plugin.ts`).
  Browsers can't slant the native caret, so when a collapsed cursor's
  effective marks (`storedMarks ?? $from.marks()`) include `italic`, the
  plugin hides the native caret (`.pmd-italic-caret-active` →
  `caret-color: transparent`) and draws a thin `position: fixed`, skewed,
  blinking caret at `coordsAtPos(head)`, repositioned on selection / scroll
  (capture) / resize / focus. Reduced motion → static slanted caret.

- **Mod-U decoupled from F9 for the collapsed-cursor case**
  (`src/editor/ribbon-commands.ts`). New `toggleUnderlineTyping` command,
  default-bound to `Mod-u` (F9 keeps `applyUnderline`). With a selection or
  shadow ranges it delegates to `applyUnderline`; on a collapsed cursor it
  toggles a STORED underline mark (parity with Mod-I/Mod-B) instead of F9's
  expand-to-word-and-underline — `underline_direct` in structural blocks,
  the named `underline_mark` in body. `applyUnderline`'s default keys drop
  `Mod-u` (now `['F9']`).

- **Repair Text** (`src/editor/ai/repair-text.ts`,
  `src/editor/repair-highlight-plugin.ts`, ribbon wiring). Diff-based OCR /
  PDF repair: the model returns `{ fixes: [{ find, replace }] }` (verbatim
  substrings + corrections) instead of a full rewrite — less hallucination
  surface, fewer output tokens. `flattenSelection` flattens the selection
  to text with `\n` between blocks (so paragraph boundaries aren't read as
  run-together words) plus a char→PM-position map; `locateFixes` finds each
  `find` sequentially and maps it to a doc range (a cross-block range joins
  on apply, repairing hyphenation split across lines).
  - **Two passes** at `temperature: 0` (new `temperature` option on
    `callAnthropic`): the model occasionally skips a token on one read, so
    a second pass over the corrected text catches it. Pass 2 is skipped
    when pass 1 found nothing.
  - **Animation**: each fix is applied as its own off-history transaction
    (sequential text replacement, orange flash via `repairHighlightPlugin`,
    scroll-into-view, ~110ms cadence); the Clod/"Thinking…" tooltip stays
    anchored where it spawned. Reduced-motion collapses to an instant apply
    + one static highlight.
  - **Single undo**: because PM groups history by time + range adjacency,
    scattered fixes across two passes can't merge naturally — so
    `collapseToSingleUndo` reverts to the pre-repair doc (off-history) and
    re-applies the corrected content in two synchronous dispatches (no
    intermediate paint), recording the whole repair as ONE undoable change.

- **Translator** (`src/editor/translate.ts`, `src/editor/settings.ts`,
  `src/editor/settings-ui.ts`, ribbon wiring). Mirror of the "Card
  Formatting Tools" Translator. `runTranslate` reads the selection,
  translates via the resolved backend, and copies the result to the
  clipboard (no doc edit). Backends:
  - **MyMemory** — keyless, CORS-OK (renderer fetch), works with AI off.
    Needs a concrete source language; MyMemory's own auto-detect is
    unreliable, so on `'auto'` we detect locally with `tinyld` (new dep)
    first. Per-request `q` is capped, so text is chunked at sentence
    boundaries (`chunkText`) and rejoined. Optional `myMemoryEmail` raises
    the daily limit.
  - **Anthropic** — reuses the reference Translator prompt (parameterized
    by target language); only when AI features are ready.
  - **Google Cloud Translation** v2 — `googleTranslateApiKey`; auto-detects
    source.
  - `translationProvider` `'auto'` resolves to Anthropic when ready else
    MyMemory. `translationSourceLang` / `translationTargetLang` (default
    `en`) pickers. All under Settings → Editing via a custom
    `translationConfig` widget; the Anthropic radio greys out when AI is
    off (live, via a self-detaching `settings.subscribe`).
  - `prependTranslationMarker` (default **on**): prepends
    `<delim>TRANSLATION BY <attr><close>` to the clipboard output, where
    `<attr>` is the model (`modelMarkerName`), `MYMEMORY`, or
    `GOOGLE TRANSLATE`, wrapped in the `condenseWarningDelimiter` (custom
    condense delimiter → square-bracket fallback, since condense's custom
    is full pause/resume strings, not an open/close pair). Six
    `TRANSLATION BY .*?` shapes added to `BUILTIN_PROTECTED_REGEXES` so all
    attributions/delimiters survive Shrink.
  - `googleTranslateApiKey` + `myMemoryEmail` join `anthropicApiKey` in a
    new `SECRET_SETTING_KEYS` set — excluded from settings export, never
    overwritten on import.

- **Unified AI model + override + retired-model message**
  (`src/editor/ai/anthropic.ts`, `src/editor/settings.ts`). `DEFAULT_MODEL`
  is documented as the single source of truth; new `resolveAiModel()`
  returns the user's `aiModelOverride` when it passes a loose id check,
  else the default. `callAnthropic` calls it when no explicit model is
  passed, so every feature (cite, explain, translate, flashcards, image)
  honors the override at once. New Settings → Comments & AI → "AI model
  (advanced)" text field (greys with the AI master switch). On a 404 /
  `not_found_error` / model-naming 4xx, `callAnthropic` throws a friendly
  `'model'`-kind error telling the user to update or set a newer model id.

- **AI cite creator: off-by-one on whole-document selections + cite
  sanitization** (`src/editor/ai/cite-creator.ts`). Two fixes:
  - `buildCiteTransaction` now clamps the incoming range to valid text
    positions with `TextSelection.between(state.doc.resolve(from),
    state.doc.resolve(to))` before inserting. The caller passes the raw
    selection bounds; a whole-document / top-of-doc selection (Ctrl+A) has
    `from === 0`, which is a block-boundary position, not inline — PM lands
    the cite at position 1, but the old code computed the cite-mark range
    AND the "cite is its own paragraph" split from the raw `from`, shifting
    every position one left. Result: the trailing token lost its last char
    (`" Cary 2"` instead of `Cary 24`) and the cite's last char was shunted
    to its own line — together, since both derive from the same anchor.
    Clamping (e.g. `0 → 1`, or `0 → 2` when the doc starts with a card)
    makes the inserted run exactly `[from, from + cite.length]` again.
  - `parseCiteResponse` now runs cite and tokens through `sanitizeCiteText`
    (strip zero-width / format / control characters, collapse every
    whitespace run incl. newlines to a single space). Messy source (often
    PDF-pasted) makes the model echo invisibles or wrap the cite across
    lines; under `white-space: pre-wrap` a stray `\n` renders as a real
    line break, and a wrap inside the author block stops the token from
    substring-matching. Tokens get the same treatment (left-trimmed,
    trailing space preserved for the two-author `"X & "` convention) so
    `indexOf` still matches.

- **Gesture zoom — pinch / Ctrl+wheel** (`src/editor/index.ts`,
  `src/editor/settings.ts`). A `window` `wheel` listener (capture,
  non-passive) intercepts events with `ctrlKey` set — Chromium delivers a
  trackpad pinch as exactly that, so one handler covers pinch AND
  Ctrl+mouse-wheel. It `preventDefault`s (otherwise Chromium also fires
  its own native page-zoom → double zoom), accumulates `deltaY`, and steps
  `zoomPct` ±10% per ~40 delta-units via the existing `setZoom` (so the
  gesture round-trips through settings and the multi-pane shell like the
  buttons / `Mod-=` chords). Gated on the new `gestureZoom` setting
  (default **false**); drives the document zoom, not chrome scale.

- **Keyboard macros surfaced in the Search Everything palette**
  (`src/editor/quick-card-search-ui.ts`, `src/editor/keybindings-editor.ts`).
  The macros editor lives inside the keybindings editor (the
  `ribbonKeyOverrides` row, Settings → Shortcuts) rather than as its own
  `SETTING_METADATA` row, so it had no auto-generated palette entry. Added
  an explicit result (same pattern as the "About this install" special)
  matched on `keyboard macros` / `macro` / `snippet` / `text expansion`,
  deep-linking via `settingsTarget: {category:'shortcuts',
  anchor:'keyboard-macros'}`; the macros `<section>` now carries
  `data-anchor="keyboard-macros"` for `revealAnchor` to scroll/flash. Also
  added a `gesture zoom` alias to the `gestureZoom` setting.

- **Removed the `enableTextDragDrop` setting** (`src/editor/settings.ts`,
  `src/editor/index.ts`). The toggle was off by default (PM's native
  text-move drag produced un-cleanly-undoable edits) and the feature never
  worked reliably, so the setting is gone entirely (interface field,
  default, metadata, sanitize). The `dragstart`-swallowing plugin now
  `preventDefault`s unconditionally — same behavior as the old default-off
  state. The card / heading pickup-drag (pointerdown-driven) is unaffected.

- **Show-in-context closes the launching Manage overlay**
  (`src/editor/learn-session-ui.ts`, `src/editor/learn-manage-ui.ts`).
  `openLearnSession` gained an `onShowInContext` callback; the Manage
  screen passes its `cleanup`, and the session invokes it (alongside its
  own cleanup) only when `showFlashcardInContext` opens the source in
  THIS window — the same in-window path that already hides the home
  screen. Cases that open the card in a separate window leave the session
  and Manage overlay up.

- **Manage Flashcards ribbon button + due-today dot** (`index.html`,
  `src/editor/index.ts`, `src/editor/settings.ts`, `src/editor/style.css`).
  Added a `manage-flashcards-btn` to the comments cluster (the 2×3 grid's
  second row is now `manage-flashcards · create-flashcard · ask-ai`),
  wired to the existing `manageFlashcards` command. A red dot
  (`.pmd-ribbon-due-dot` ::after) shows when
  `learnStore.dueCount({kind:'all'}, localToday()) > 0` and the new
  `flashcardDueDot` setting (default true) is on; `refreshFlashcardDueDot`
  recomputes on `learnStore.subscribe`, the settings subscriber (toggle),
  and `visibilitychange` (catches a day-rollover while idle).

- **Backspace on an empty first-body slot deletes the blank line**
  (`src/editor/tag-keymap.ts`). `backspaceAtFirstBodyStart` swallowed
  Backspace at the start of a card/analytic_unit's first body whenever
  the head was non-empty (the anti-collision rule). Added an exception:
  when that body is itself empty (`content.size === 0`) there's nothing
  to collide, so delete the empty paragraph and place the cursor at the
  end of the head. Non-empty bodies still no-op. (`card`/`analytic_unit`
  content is `head (…)*`, so dropping the only body is schema-valid.)

- **`selectCurrentHeading` default-bound to `Alt-a`** (`ribbon-commands.ts`
  `DEFAULT_RIBBON_KEYS`). The command existed but shipped unbound (`''`);
  no conflict with existing defaults. User-rebindable via
  `ribbonKeyOverrides`.

- **Drag-from-editor auto-scroll fixed** (`src/editor/drag-editor-surface.ts`).
  `maybeAutoScroll` scrolled `this.host`, but the host (`#editor` /
  `.pmd-pane-editor`) isn't the scroll container — `#app` is in single-doc,
  the pane body in multi-pane — so it was a no-op and the edge test never
  fired (the host's full-height rect has its bottom far below the
  viewport). Now scrolls `findScrollGate()` (the same element `hitTest`
  gates on). (A companion fix — suppressing the text selection the pickup
  chord's Shift/Alt triggers on click, via a capture-phase pointerdown
  interceptor + `user-select: none` in pickup mode — is in the code but
  held out of the changelog pending macOS verification.)

- **`@AI` mentions fire from comments + notes again; AI author name
  cleaned up** (`src/editor/comments-ui.ts`). The `@AI` / has-AI-history
  re-invocation check lived only in `submitReply`, so it was lost on the
  comment thread's first message (`commitRootText`) and was never wired
  for notes (`addNoteComment`). Extracted into `maybeInvokeAiForComment`
  (called from the root input and replies) and added `maybeInvokeAiForNote`;
  `invokeAiLocal` / `contextFromLocal` are generalized over `'ai' | 'note'`
  so a note's AI reply lands as a private `ai: true` turn (with the
  Thinking placeholder + a re-render-signature flag added to notes). The
  redundant ` (AI)` author suffix is dropped — AI comments now store the
  plain persona name and rely on `initials: 'AI'` for round-trip
  detection (it survives via comments.xml `w:initials`); a legacy trailing
  `(AI)` is stripped at display and still recognized by `isAiComment`.

- **Annotations (comment / note / ask-AI) work on images** (`learn-anchor.ts`,
  `comments-plugin.ts`, `comments-ui.ts`, `ai/explain-context.ts`,
  `ai/anthropic.ts`, `ai/image-ai.ts`, `import/importer.ts`, `index.ts`).
  Previously all three silently failed on a picture (orphaned comment /
  empty-quote note / unanchored AI). Now:
  - *Anchoring (notes + AI).* `flatten()` emits a sentinel per image —
    object-replacement char + a cheap FNV-1a fingerprint of its base64
    data — so an image is one token in the flattened text stream. The
    existing quote/prefix/suffix matcher then handles image-only and mixed
    selections unchanged: re-anchors by content (not position), with
    different images distinguished by fingerprint and identical copies
    disambiguated by surrounding context, like a repeated phrase.
  - *Comments.* A `comment_range` mark already applies to an image (inline
    atom, no `marks` restriction); the only gap was that the live-thread
    scans walked text nodes only. `collectRanges`, `collectLiveThreadIds`
    (the GC), and the delete-strip now also read marks off `image` nodes.
    Round-trip: the docx exporter already brackets images
    (`exporter.ts:416`); fixed the importer to re-apply open comment
    ranges to imported images (cmir round-trips natively as PM JSON).
  - *Ask AI sends the image.* `ExplainContext` gains `images` (vision-
    supported formats only, document order, capped at 5);
    `formatExplainFirstTurn` prepends `image` content blocks before the
    text prompt (Anthropic's recommended order), and both AI paths
    (`invokeAi`, `invokeAiLocal`) use it. `buildExplainContext` allows an
    image-only selection (empty text + images). `aiAskAboutSelection`
    toasts when the selection has >5 images. Vision media-type set
    promoted to a shared `VISION_MEDIA_TYPES` in `anthropic.ts`.

- **Editor spellcheck: a custom viewport-scoped checker** (new
  `src/editor/viewport-spellcheck.ts`, `src/editor/proto-dict/`, `nspell`
  dep; `src/editor/index.ts`, `src/editor/multi-pane-shell.ts`,
  `apps/desktop/src/main.ts`). The `editorSpellcheck` setting is now
  served by a ProseMirror decoration plugin instead of the browser's
  built-in checker. Why the switch: the built-in checker only flags words
  as you *type* them (never text in opened/imported files), needed the
  Electron session engine enabled + a language set to work at all on
  Windows/Linux, and — decisively — does not paint squiggles under native
  Wayland. The custom checker fixes all three.
  - *How it works.* On scroll/edit (trailing-debounced ~120ms), it
    hit-tests the viewport top/bottom to find the on-screen doc range,
    tokenizes only that range, and decorates misspellings
    (`.pmd-misspelled`, a CSS wavy underline that renders everywhere
    incl. Wayland). Cost tracks words-on-screen, not document size; word
    verdicts are memoized. Gated on `editorSpellcheck` (no work, and no
    dictionary load, when off). Lands via `buildEditorPlugins`, so it
    covers both single-doc and multi-pane.
  - *Dictionary.* nspell (Hunspell-in-JS) over the en `.aff`/`.dic`
    (vendored under `proto-dict/`), **dynamically imported** so the
    ~550KB dictionary is a separate async chunk fetched only the first
    time spellcheck is turned on — a spellcheck-off session never pays
    for it. Build is ~67ms (one-time).
  - *Native checker disabled.* The editable's `spellcheck` attribute is
    now always `false`; the prior native-engine wiring
    (`setupSpellChecker`, `webPreferences.spellcheck`, the
    `editor-spellcheck.ts` focus-bounce) is removed.
  - *Right-click menu.* A `contextmenu` handler on a flagged word (falls
    through otherwise, so links/images/default menus still win) shows up
    to 7 `nspell.suggest` results (click to replace), **Add to
    Dictionary** (persisted to `localStorage['pmd-user-dictionary']`,
    re-applied via `nspell.add` on load — so it also drops from
    suggestions), and **Ignore** (session-only suppression). Word
    verdicts are memoized; the cache is invalidated on add. Menu reuses
    the `.pmd-nav-context-menu` styling.
  - *Not yet done*: a Web Worker for the one-time dictionary build (the
    user accepted the ~67ms hitch for now).
- **Suppress the auto-update-in-progress messaging on macOS**
  (`apps/desktop/src/main.ts`, `src/editor/settings-ui.ts`). Unsigned
  macOS builds can't self-install via Squirrel.Mac, so the auto-updater
  could detect a new version but the download/install never landed —
  while the UI still promised a background download and a restart-to-
  install. Detection stays on; on `darwin` we now set
  `autoUpdater.autoDownload = false` and `autoInstallOnAppQuit = false`,
  skip registering the `update-downloaded` "restart to install" dialog,
  and reword the "Update available" dialog detail + the Settings
  "Check for updates" toast to send the user to the `.dmg` instead of
  claiming a background download. Windows/Linux behavior is unchanged
  (still full auto-download + install-on-quit). Pairs with the README
  note that macOS updates are manual.

- **macOS cross-window bugs fixed: Finder-open duplicate guard + the
  multi-window three-pane toggle storm** (`apps/desktop/src/main.ts`,
  `src/editor/settings.ts`, `src/editor/index.ts`). Both were pinned down
  from the temporary `cross-window-debug.log` probe.
  - *Duplicate-open guard.* The OS-open path (`openExternalFile` — macOS
    `open-file`, Windows/Linux argv) spawned a window and registered the
    path WITHOUT the dedup check the in-app Open dialog runs through
    `host:open-path-check`, so a Finder double-click of an already-open
    file opened a second copy — and closing either copy then released the
    shared `openPathOwners` claim, orphaning the other. Not a path-
    canonicalization hole (the probe's `pathForensics` were clean: empty
    `nearMisses`, matching NFC/NFD, no realpath divergence) — a missing
    call site. Fix: a shared `focusExistingOwner(p, excludeWinId?)`
    helper focuses the owning window (pruning stale entries);
    `openExternalFile` calls it before spawning, and `host:open-path-
    check` now delegates to it.
  - *Three-pane toggle.* `multiDocWorkspace` is a synced (non-transient)
    setting, so toggling it in one window fired the `storage` event in
    every OTHER window, and each ran `handleModeSwitch` independently —
    two overlapping close rounds whose senders were each other's
    targets, so both windows closed and none survived to host the new
    layout (the backgrounded window also took ~9 s to answer its
    please-close, which read as "nothing happened" and prompted the
    second toggle). Fix: `notify()` passes a `{ remote }` origin flag to
    subscribers (true when the change arrived via the storage event); the
    mode-switch subscriber ignores remote changes, so only the
    initiating window drives the switch. A `modeSwitchInProgress`
    re-entrancy guard in `host:journal-and-close-other-windows` is the
    backstop.
  The temporary instrumentation stays in this build so the next capture
  can confirm the fix; it'll be removed once verified.

## 0.1.0-alpha.9 — 2026-06-03

- **Autosave toggle persists per document across close + reopen**
  (`autosave-prefs-store.ts` new, `index.ts`, `multi-pane-shell.ts`,
  `settings.ts`). `autosaveEnabled` stays a transient per-window setting
  (still in `TRANSIENT_SETTING_KEYS`, never written to `pmd-settings`),
  but the choice is now mirrored PER FILE PATH in a tiny localStorage
  store (`pmd-autosave-paths`, a set of ON paths; absence = off).
  - Single-pane: the `toggleAutosave` ctx handler writes
    `setAutosaveForPath(activeFile().handle, next)`; both open paths
    (`routeOpenedFile`, `loadFileInPlace`) restore via
    `settings.set('autosaveEnabled', isAutosaveOnForPath(handle))` right
    after setting the handle/format.
  - Multi-pane: `DocRecord` init reads `isAutosaveOnForPath(opts.handle)`
    instead of hard `false`; `toggleFocusedAutosave` persists the flip.
  - Only Electron string-path docs key into the store; web
    `FileSystemFileHandle`s and unsaved docs no-op (stay default-off).
    Save-As to a new path doesn't retro-persist (the in-session flag is
    untouched; the new path remembers once toggled) — a minor edge, not
    the close/reopen case this targets.

- **Cross-window diagnostic instrumentation (TEMPORARY, macOS bug
  hunt)** (`apps/desktop/src/main.ts`, `preload.ts`,
  `src/editor/host/electron-host.ts`, `src/editor/index.ts`). Logging
  only — no behavior change, and deliberately NOT disabling native
  window occlusion so the bugs still reproduce. Targets two Mac-only,
  Windows/Linux-fine symptoms suspected of a shared cause: the
  duplicate-open guard missing, and the three-pane toggle's
  close/reopen being flaky (send-to-speech, which only pushes to one
  live window, works). All three use the same main-process IPC, so the
  differentiator is what each needs a *non-foreground* window to do.
  Writes one JSON line per event to `{userData}/cross-window-debug.log`
  (and console) via an `xlog` helper; a renderer→main `host:debug-log`
  bridge (`ElectronHost.debugLog`) folds renderer events into the same
  clock. Captured:
  - **Dedup canonicalization** — `canonicalOpenPath` is just
    `path.resolve` (no case-fold, no Unicode NFC/NFD normalization, no
    `/private`/`/Volumes` symlink resolution). Each
    check/register/release logs `pathForensics` (resolved key, isNFC/
    isNFD, `realpathSync.native`, realDiffers) and, on a missed check,
    `dedupeNearMisses` — registered keys that point at the SAME file
    under a DIFFERENT string (sameNFC / sameLower / sameReal). A hit
    there is direct proof of the canonicalization hole.
  - **Mode-switch close** — `host:journal-and-close-other-windows` logs
    each other window's visible/minimized/focused state, then per
    window `closed-clean` vs `destroyed-timeout` + elapsed ms (the
    10s `destroy()` skips the renderer's journal → lost doc =
    "flaky"). `host:close-self` logs `modeSwitchWakeMs` (please-close
    send → close-self arrival = the background renderer's wake+journal
    latency). Renderer logs `please-close-received` with
    `document.visibilityState` (`hidden` ⇒ occluded) and
    `please-close-journaled` with journal ms.
  - **Renderer freeze / occlusion** — per-window `wc-unresponsive`/
    `wc-responsive` and `win-blur`/`focus`/`hide`/`show`; `setdochandle`
    logs the owning window's visibility at path (re)register; a `boot`
    header records platform / Electron / Chromium versions + log path.

- **Word Count Selection button per pane in multi-pane mode**
  (`multi-pane-shell.ts`). The single-pane status bar's Σ button
  (`#word-count-btn`, hidden in multi-doc mode) had no equivalent in the
  pane footers. Each `Slot` footer now builds a `.pmd-pane-wc-btn` before
  the `.pmd-pane-wc` readout; its click focuses the slot
  (`shell.focusSlot`) and calls `openWordCount(this.visible.view)` —
  scoping the modal to that pane's own visible doc and selection rather
  than the module-level single-pane `view`. `mousedown` is
  preventDefault'd and the click `stopPropagation`'d like the sibling
  open-file button; it no-ops when the slot is empty. Styled in
  `style.css` like `.status-bar-btn`, scaled to the footer. The shared
  status-bar Σ button (`#word-count-btn`) is now also hidden in
  multi-doc mode (alongside the already-hidden `#word-count-display`) —
  it otherwise sat in the corner below the nav rail and was redundant
  with the per-pane buttons.

- **Live selection word count had no effect in multi-pane mode**
  (`multi-pane-shell.ts`). Two gaps vs. single-pane: (1) the per-pane
  `dispatchTransaction` called `slot.refreshWordCount()` only inside
  `if (tx.docChanged)`, so selection-only transactions never refreshed
  the footer — the "Sel:" readout only appeared after the next edit,
  looking permanently off. Added an `else if` mirroring single-pane's
  `index.ts` gate (`liveSelectionWordCount` on, selection changed, and a
  range on either side so empty→empty cursor moves do nothing). (2)
  `Slot.refreshWordCount` computed `hasSel = !sel.empty` WITHOUT checking
  the setting, so when it did run with a selection it showed the
  selection count regardless of the toggle; now gated on
  `settings.get('liveSelectionWordCount') && !sel.empty` like single-pane
  `refreshWordCount`. The settings-toggle path was already covered — the
  shell's settings subscriber refreshes every slot's word count on any
  change.

- **Dropzone pill stranded over the pane footer on multi-pane boot**
  (`index.ts`, `style.css`). The floating dropzone pill anchors to the
  leftmost VISIBLE pane body via `positionDropzone`, but multi-pane has
  TWO stacked bottom bars — the per-pane `.pmd-pane-footer` (word count
  + Σ) sits on top of the still-visible full-width `#status-bar`. Three
  things conspired: (1) the boot `requestAnimationFrame(positionDropzone)`
  runs in single-pane context (`#app` still visible, `pmd-multi-doc` not
  yet set) and INLINES a `bottom` measured against `#app` — clearing the
  status bar but not the footer; (2) the later multi-doc pass early-
  returns because panes boot `[hidden]` (no `.pmd-pane:not([hidden])
  .pmd-pane-body` anchor exists yet), leaving that stale inline value in
  place; (3) the `#app` `ResizeObserver` wired at boot is dead in
  multi-doc (`#app` is `display:none`), so nothing re-ran the pass when a
  pane un-hid on doc-load — only an unrelated reflow (cycling the theme)
  did. Fixes: a `body.pmd-multi-doc .pmd-dropzone-root` CSS fallback that
  clears BOTH bars (`calc(var(--status-bar-height) +
  var(--pmd-pane-footer-height) + 0.5rem)`, the footer height now a
  shared `:root` var so it can't drift from `.pmd-pane-footer`'s
  `min-height`); `positionDropzone` now REMOVES its inline `left` /
  `bottom` / `max-width` when it can't measure the anchor, so the mode-
  aware CSS fallback applies instead of a stale single-pane value; and a
  `ResizeObserver` + a `hidden`-attribute `MutationObserver` on
  `.pmd-multi-row` so the pass re-runs (and inlines the exact position)
  the moment a pane un-hides as its first doc mounts.

- **Version / "About this install" in the command palette.** A synthetic
  settings result in `searchSettingsSource` (`quick-card-search-ui.ts`),
  prepended when the query prefix-matches "version" / "about" / "about
  this install" / "release". Its name shows `CardMirror <appVersion>`
  (`appVersion` newly exported from `install-info.ts`), and it carries
  `settingsTarget: { category: 'general', anchor: 'about-this-install' }`.
  `SettingsTarget` gains an `anchor` field; `SettingsModal.open` handles
  it via a new `revealAnchor` that scrolls + flashes the `[data-anchor]`
  section (the About block, now tagged `data-anchor="about-this-install"`)
  — reusing the existing settings-search deep-link piping.

- **Settings open + change performance on large docs.** Several
  settings-subscriber paths did O(doc) work on every change (and at open):
  - `buildColorOverridesEditor` (`settings-ui.ts`) was the dominant cost:
    each of ~37 color rows ran `getComputedStyle` — via `currentValue`
    (`getComputedStyle(documentElement)`) and `parseToRgbaParts`, which
    **appended + removed a probe `<span>` to `<body>` per call** — on
    every settings change, forcing a full-document style recalc each time
    (read/write thrash × 37). Now: one persistent off-screen probe reused
    across calls (no per-call append/remove), and each row subscribes only
    to ITS OWN token (`displayColors[dcKey]` or `customColorOverrides[name]`)
    so editing one color refreshes one row, not all 37.
  - The global apply subscriber (`index.ts`) called `applyReadMode` on
    every change, which dispatches a transaction that makes the read-mode
    plugin re-walk the doc to rebuild hiding decorations — now guarded on
    `readMode` / `hideEmphasisBordersInReadMode` actually changing.
  - The nav/outline panel (`nav-panel.ts`) rebuilt the whole outline (one
    node per heading) on every settings change — now only when `navMaxLevel`
    or `showCitePreview` changes.
  - The apply subscriber's `refreshWordCount()` walked the whole doc on
    every change; now `refreshWordCount({ selectionOnly: true })` reuses
    the cached whole-doc count (the doc is unchanged on a settings toggle).
  - The Keyboard tab's ~150-row keybindings list is built on the next
    frame (`requestAnimationFrame`) rather than blocking the dialog open
    (it's not the default tab, and its panel starts hidden).

- **Convert Cited Analytics to Tags command.** New bindable command
  `convertCitedAnalyticsToTags` (`ribbon-commands.ts`, label "Convert
  Cited Analytics to Tags", no default key, Cleanup group, doc-dropdown
  Cleanup section). The existing `convertAnalyticsToTags` body was
  extracted into a shared `analyticsToTagsCommand(shouldConvert)` helper:
  the original passes `() => true`, the new one passes a predicate that
  checks the `analytic_unit` has a `cite_paragraph` child. Same
  selection-scoping as the original (selection range, or whole doc when
  empty) and same per-unit transform (analytic_unit→card, analytic→tag,
  heading id + body slots preserved).

- **AI table-from-image: large tables + a repair fallback** (`image-ai.ts`,
  `anthropic.ts`). Large tables were truncated by the 4096-token cap — the
  dominant cause, confirmed via `stop_reason === 'max_tokens'`. Fixes:
  - The table JSON schema (now shared between the extraction and repair
    prompts as `TABLE_SCHEMA_AND_RULES`) is COMPACT: cells emit only
    non-default fields, so a plain cell is `{ "text": "..." }` instead of
    carrying `bold/italic/colspan/rowspan` defaults. `validateTableSpec`
    already defaults missing fields, so no parse change was needed — this
    just cuts output size ~5×.
  - `maxTokens` raised 4096 → 16384.
  - `callAnthropic` now returns `stopReason` (the API `stop_reason`).
  - On validation failure: if `stopReason === 'max_tokens'` the data is
    genuinely cut off → a clear "too large" toast (no repair, since
    reformatting truncated JSON would silently drop rows). Otherwise (a
    real format error) a text-only repair call (`TABLE_REPAIR_SYSTEM_PROMPT`)
    reformats the broken output via the shared `parseTableSpec` helper.

- **Extract Undertag command.** New bindable command `extractUndertag`
  (`ribbon-commands.ts`, label "Extract Undertag", no default key, card
  dropdown → Excerpt section, Editing-utilities group). Walks up from the
  selection to the enclosing `card` (requires a non-empty selection and a
  card whose first child is a `tag`), reads the selection text
  (`textBetween` with block→space collapse), and inserts a new `undertag`
  node after the card's last existing undertag (or right after the tag).
  It's a copy — the original text is untouched — and the cursor lands at
  the end of the new undertag. A new `extractUndertagInQuotes` boolean
  setting (Editing category, off by default) wraps the excerpt in double
  quotes; it reaches the command via a new `RibbonContext` getter
  `extractUndertagInQuotes` → `settings.get('extractUndertagInQuotes')`.

- **Word-style paragraph navigation: cleaner collapse / cross-block
  targets** (`word-selection-keymap.ts`).
  - `verticalCommandPair`'s Down (`to-end`) move with a non-empty
    selection now collapses to the START of the paragraph after the
    selection-end paragraph (`nextTextblock(corner.end()).start`) instead
    of `corner.end()` — so a following Ctrl/Alt+Down continues downward
    rather than stopping at the current paragraph's end first. The
    `$to.parentOffset === 0` spill case (after Ctrl/Alt+Shift+Down)
    collapses to that paragraph's own start (it already IS the next
    paragraph); a selection ending in the last textblock parks at its end.
    Up (`from-start`) is unchanged (start of the selection's paragraph).
  - `destPrevUnit`'s cross-block case (Ctrl/Alt+Left at a paragraph start)
    now returns `prev.end` — the END of the previous textblock, after its
    trailing word/punctuation — instead of the start of that block's last
    unit. Mirrors the forward direction (`destNextUnit` → `next.start`):
    both stop just across the paragraph break.

- **Notes — a private, threaded annotation (fourth comments-bar kind).** A
  `Note` entity in `learn-store.ts` (`{ noteId, docId, comments:
  LocalComment[], anchor, createdAt }`), parallel to `AiThread`: stored in
  the LearnStore (never serialized into the doc → private), anchored by
  `AnchorDescriptor` + a green decoration (`'note'` kind in
  `learn-highlight-plugin.ts` → `.pmd-note-range`). Store methods
  (`addNote` / `getNote` / `appendNoteComment` / `editNoteComment` /
  `setNoteAnchor` / `removeNote` / `notesForDoc`) plus JSON (de)serialize
  and the doc-lifecycle hooks (`copyDocAnnotations` fork-copies with fresh
  ids, `rekeyDoc`, `forgetDoc`). The comments column (`comments-ui.ts`)
  gets a `NOTE_PREFIX`, a green `'note'` chip, and a full render path
  (merge/sort by doc position, `populateNote` reusing `renderAiComment`,
  `buildNoteInput` / `addNoteComment`, `activateNote`, `deleteNote`,
  unanchored row + `regroundNote`). Creation is a new ribbon command
  `addNoteToSelection` (`ribbon-commands.ts`, default `Mod-Shift-n`,
  Comments group) + a ribbon button (new `note` icon) wired in `index.ts`;
  `threadIdAtCursor` maps the `'note'` range kind to `NOTE_PREFIX`.

- **Inline edit for comments and notes.** A pencil edit button
  (`buildEditButton`) on every human-comment turn (`renderComment`) and
  note turn (`renderAiComment` gains an optional `onEdit`; AI threads omit
  it). Clicking swaps the body for a textarea + Save/Cancel via a shared
  `startInlineEdit`; human comments commit through the existing
  `editCommentTextMeta`, notes through a new `editNoteComment(noteId,
  index, text)`. New `edit` icon added to the `gen-icons.mjs` MAP
  (`edit-02`); the note button's icon also comes from the MAP (`file-02`).

- **Opt-in export of the private layer as comments.** Two new Save As
  Custom-Save checkboxes (off by default) on `SaveAsResult` —
  `includeNotes` / `includeAiThreads` (`save-as-ui.ts`). `serializeForSave`
  (`index.ts`) gains `bakePrivateThreadsIntoDoc`: for each opted-in
  note / AI thread it resolves the anchor against the export doc, mints a
  `comment_range` mark + a real `Thread` (user turns → `human`, AI turns →
  `ai`) via a temp `EditorState`, and hands the marked-up doc + threads to
  the serializer. Baking the private layer forces a derived (non-identity-
  adopting) save so the working doc keeps both its identity and its
  private notes (no double-load on reopen).

- **Performance: annotation creation no longer re-anchors the whole doc.**
  `resolveDescriptor` flattens the entire document; the comments column
  used to re-resolve EVERY flashcard / AI thread / note on EVERY
  `learnStore` change (creation did it twice; each reply did it again).
  Fixes:
  - `learn-anchor.ts` exposes `flattenDoc` + `resolveDescriptorIn(flat,
    d)` so a batch resolve flattens once, not per descriptor.
  - `learn-highlight-plugin.ts` gains `upsert` / `remove` range metas
    (`upsertFlashcardRangeTr` / `removeFlashcardRangeTr`) to set or drop a
    single range by id at a KNOWN position — no walk.
  - The store subscription now runs `reconcileAnchors` (incremental):
    resolves a descriptor only for an annotation that's newly anchored
    but absent from the plugin, prunes ranges for deleted ones, and
    short-circuits to a plain render otherwise. Note / AI creation and
    re-ground call `placeLocalAnnotation` to set the range from the live
    selection BEFORE the store mutation, so the reconcile finds it already
    present and never resolves. `activateNote` / `activateAiThread` render
    instead of re-resolving. Full resolution (`refreshFlashcardAnchors`,
    now also flatten-once) is reserved for doc load, column show, pane
    switch, and edit-driven range drops.

- **Save Send Doc command + shortcut.** A new bindable command
  `saveSendDoc` (`ribbon-commands.ts`, default `Mod-Alt-s`, File group,
  palette aliases "send doc" / "export send doc" / "send version") that
  automates the Save As dialog's Send Doc preset: it saves the document
  with comments, analytics, and undertags stripped (full, non-read-mode
  export — same `transformForExport` filter the preset uses) in one
  keystroke, with no dialog. Driven by `runSaveSendDocFlow` (`index.ts`),
  a lossy export that leaves the working doc's identity, dirty state, and
  journal untouched (only a recents entry is added), mirroring the
  preset's non-full-save branch.

  Destination and format come from settings rather than the dialog:
  - `sendDocDestination` (new `sendDocDestination` setting kind — radio
    editor in `settings-ui.ts`, electron-only) chooses between
    `sameFolder` (write beside the source file) and `fixedFolder`.
  - `sendDocFolder` (reuses the existing `folder` setting kind, with the
    `pickDirectory` browse/clear UI) is the fixed-folder target.
  - Format follows `defaultSaveFormat`; the `SEND_` filename prefix
    honors `prefixPresetSaveFilenames`, exactly like the preset.

  The silent write goes through a new Electron host method
  `ElectronHost.saveSendDoc` → IPC `host:save-send-doc` (`main.ts`):
  the renderer resolves the destination (`folder`, or the source's
  `siblingHandle`) plus the final filename, and main joins, `mkdir -p`s,
  and writes. Main returns the literal `'collision'` when the resolved
  target would overwrite the source document (prefix off + same folder +
  same format) so the renderer can fall back to the dialog instead of
  clobbering it. The flow also falls back to `getHost().saveAs` for a
  never-saved doc in same-folder mode, an unset fixed folder, or a
  non-Electron host — so the command always does *something* sensible.

- **Select all instances of a style (right-click a ribbon style button).**
  A `contextmenu` handler on each structural / character style button
  (`index.ts`, `FORMATTING_PANEL_SELECT_ALL`) lights up every instance of
  that style as a shadow selection, reusing the Select Similar Formatting
  machinery so the result is `getOperatingRanges`-visible and the
  existing format commands act across all instances at once. New plugin
  exports in `similar-selection-plugin.ts`:
  - `StyleSelector` — `{ kind: 'block'; nodeType }` (matches a textblock
    type's content runs) or `{ kind: 'mark'; markTypes }` (matches text
    runs carrying any of the marks, contiguous runs merged).
  - `computeStyleMatches(doc, selector, scope?)` — pure matcher, scope-
    clamped.
  - `selectAllOfStyle(selector)` — the command. Scope is **sticky**: a
    fresh non-empty PM selection sets/replaces the scope (bounded match +
    scope tint, via a new `setMatchesScoped` plugin meta that sets
    matches + scope in one idle-mode step); with no fresh selection an
    existing scope is reused, so repeated right-clicks and the format
    operations chained between them stay bounded to the same region
    (format ops already preserve the shadow via `META_OPERATING_ON_SHADOW`
    and the scope rides along in the same plugin state). It collapses a
    live selection so the shadow, not the browser selection, drives bulk
    ops, and returns false (no dispatch) when nothing matches so the
    caller can toast without disturbing the existing shadow.

  The Underline selector deliberately matches only `underline_mark` (the
  named body style), not `underline_direct` — by the schema's body-vs-
  structural invariant the latter is the raw underline used inside tags /
  analytics / other structural blocks, which aren't instances of the
  underline *style*.

- **Cursor-on-style indicator on the ribbon style buttons.** A new
  `refreshFormattingPanelButtonStates()` (`index.ts`) sets `aria-pressed`
  on each formatting-panel button to reflect the cursor's current style,
  wired into `dispatchTransaction` next to the existing font-size / color
  refreshers (plus the view-chrome re-sync and mount paths). Structural
  buttons match the cursor's enclosing textblock type
  (`$from.parent.type.name`); character buttons match its marks via a
  standard `markActive` helper (`isMarkActiveInSelection`). Two guards
  worth noting: it skips the refresh when `$from.parent` isn't a
  textblock — a gap cursor between blocks (or a node selection) otherwise
  blanks every button even though the visible caret hasn't moved into new
  text, so the indicator holds the last real run's style; and Underline
  matches only `underline_mark`, not `underline_direct` (same body-vs-
  structural reasoning as select-all — direct underline in tags /
  analytics isn't the underline style). One CSS rule reuses the standard
  toggle wash: `#ribbon .formatting-panel-btn[aria-pressed="true"]` →
  `--pmd-c-button-active`.

- **Select Similar / select-all decorations reuse the Find palette.** The
  scope band (`.pmd-similar-scope`) now uses the same faint-blue
  within-selection tint as `.pmd-find-scope` (`--pmd-c-drop-*`), and each
  match (`.pmd-similar-match`) uses Find's current-match orange band +
  outline (`--pmd-c-find-match-current*`, kept dashed to read as a shadow
  selection). Previously both were near-identical ambers that blurred
  together. The now-dead `--pmd-c-similar-{scope,match}-*` variables were
  removed from both themes (`--pmd-c-similar-deep-text` stays — still used
  by the manage-cards list).

- **Documentation streamlined** (`README.md`, `ARCHITECTURE.md`,
  `PROJECT.md`, `src/editor/index.ts`). The prior docs were
  agent-generated — long, repetitive, padded with implementation
  narration, and in places inaccurate about what shipped. Rewritten
  against the voice of Verbatim's own published manual (plain, direct,
  task-first): ARCHITECTURE 1651 → ~640 lines (kept the schema,
  round-trip contract, rendering model, and editing-boundary rules; cut
  the changelog-style ribbon catalog and play-by-play; corrected
  overstated status — transclusion, corpus-search indexing, the cleanup
  ribbon family, and collaboration moved to a clearly-marked roadmap, and
  Electron noted as settled). PROJECT reduced to a one-screen orientation
  + accurate shipped/planned/out-of-scope snapshot. README intro and
  updates sections tightened (verbose install steps and acknowledgements
  kept). The in-editor welcome doc (`makeStarterDoc`) trimmed to the same
  voice with every interactive structure demo preserved, plus a new
  "Study your evidence" section for flashcards. ARCHITECTURE §17 gained a
  "Why this design (the evidence)" subsection grounding the
  spaced-repetition choices in the mnemonic-medium research (Quantum
  Country, Orbit, Augmenting Long-term Memory, Matuschak's notes), cited
  by public URL; the dead pointer to the gitignored learn-system spec was
  dropped. CHANGELOG/DETAILED_CHANGELOG untouched except for this note.

## 0.1.0-alpha.8 — 2026-06-01

- **"Show in context" from a flashcard review.** A third action in the
  review session (`learn-session-ui.ts`, button + key `3`, shown only
  when the card has an anchor whose doc has a known path —
  `pickCardSource`, unit-tested) opens the card's source focused on its
  anchored text, without grading the card. The session UI stays
  store-only and reaches the app through a host hook in
  `learn-store-host.ts` (`setShowInContextHandler` /
  `showFlashcardInContext`, passed the session's `cleanup` so the handler
  decides whether to close the review). `index.ts` registers
  `showFlashcardSource`, which routes by context, reusing a shared
  `focusDescriptorInActiveView` (resolveDescriptor → select +
  `preciseScrollIntoView`):
  - **Multi-pane:** delegates to `MultiPaneShell.showInContext` (new
    `enableMultiDocMode` hook) — focuses the slot already holding the doc
    and scrolls, or loads it into the first empty slot (slot 1 if all
    three are occupied; no picker) and scrolls on mount; closes the
    review + home (they cover the whole workspace).
  - **Single-doc, source is the current doc:** closes the review *and the
    home screen* (both overlay the doc) and focuses in place.
  - **Single-doc, open in another window:** new cross-window IPC
    (`host:focus-anchor-in-window` → main focuses the owner window and
    sends it `host:focus-anchor`; every window registers an
    `onFocusAnchor` receiver that scrolls its doc). Review stays up.
  - **Single-doc, not open:** spawns a new window carrying a
    `focusAnchor` on the spawn payload (`SpawnWindowPayload` /
    `InitialDocPayload`), which `mountFromSpawnPayload` focuses on mount.
    Review stays up.
  - **Web / no spawn host:** opens in place + focuses; closes review.
  New host-bridge surface: `focusAnchorInWindow` / `onFocusAnchor` on the
  preload, `ElectronAPI` interface, and `ElectronHost` class (guarded so
  an older preload degrades gracefully).

- **Cursor focus for AI-comment / flashcard cards (consistent with
  comments).** Clicking commented text focuses its thread because
  `threadIdAtCursor` (`index.ts`) reads the `comment_range` mark at the
  cursor and the existing `dispatchTransaction` wiring hands the id to
  `commentsColumn.setActiveThread`. AI threads and flashcards are
  local-only (`learnStore` + an `AnchorDescriptor`) and anchor via
  `learnHighlightPlugin` decorations, not a mark — so they never
  serialize, but a mark lookup missed them and `setActiveThread(null)`
  actually cleared any active card. Fix: new pure
  `flashcardRangeAt(state, pos)` in `learn-highlight-plugin.ts` returns
  the resolved highlight range containing a position (both ends
  inclusive, first match wins); `threadIdAtCursor` falls back to it when
  no comment mark is found and returns the column's prefixed id
  (`AI_PREFIX`/`FC_PREFIX`, now exported from `comments-ui.ts`) by
  `range.kind`. Comment marks still win when text carries both.
  Everything downstream (`setActiveThread`, card expand/scroll, in-doc
  active-range emphasis) already keys on the prefixed id, so AI and
  flashcard cards now focus on cursor exactly like comments and collapse
  when the cursor leaves.

- **Optional live selection word count (`liveSelectionWordCount`, default
  off).** The status-bar read-time counter (`refreshWordCount` in
  `index.ts`) only re-ran inside the debounced, `tx.docChanged`-gated
  `scheduleHeavyUpdate`, so selecting text without editing never updated
  the readout — and the `Selection: …` branch only ever showed on the
  next edit, against whatever selection happened to exist then. Rather
  than make every selection change pay an O(doc) recount (a cursor move
  with no selection recomputes the whole doc), this is now an opt-in
  setting:
  - When on, `dispatchTransaction` has a selection-only branch that
    calls `refreshWordCount({ selectionOnly: true })` — gated on the
    selection actually changing and a range being involved on either
    side, so plain cursor moves (empty → empty) do nothing. A non-empty
    selection counts only its range (`countReadAloudWords(doc, from,
    to)`); a collapse reuses a cached whole-doc count
    (`lastWholeDocWords`) instead of re-walking. The cache is nulled on
    any doc change so a collapse before the debounced recount can't show
    a stale total.
  - When off (default), `refreshWordCount` ignores the selection
    entirely and always shows the whole-doc count, and the
    selection-only branch is skipped — no per-selection work, and no
    stale `Selection: …`. A selection's read time stays available via
    the Word Count button (Σ / Word Count Selection dialog).
  Added the boolean to the `Settings` interface, defaults (false),
  sanitizer, and `SETTING_METADATA` (General, toggle); the existing
  settings subscription re-renders the bar when the toggle flips.

## 0.1.0-alpha.7 — 2026-05-30

- **"Delete Current Heading" bindable command (`deleteCurrentHeading`).**
  Sibling to `selectCurrentHeading` / `copyCurrentHeading` — same
  cursor-only enclosing-structure bounds (`enclosingStructureRange` via
  the shared `speech-doc-send.ts` helpers), but it removes the structure
  instead of selecting it. Importantly it deletes the whole node range
  (`tr.delete(from, to)`) rather than emulating select-then-Delete: a
  text-selection delete over an `isolating` card empties the card but
  keeps its now-blank shell, which this command must not do. New pure,
  testable `buildDeleteStructureTr(state)` returns the delete transaction
  (or null when the cursor isn't in a deletable structure) and re-homes
  the cursor to the nearest valid spot; `deleteCurrentHeadingIn(view)` in
  `index.ts` dispatches it via the same `view`-is-the-focused-pane ctx
  hook the select/copy commands use (works single-doc + multi-pane).
  Registered through the standard path (id union, IDs, label, alias
  "delete card"/"delete heading", unbound default key, View ribbon
  group, `commandFor` case, `RibbonContext` hook).

- **Windows "New → CardMirror Document" context-menu entry (drafted,
  UNVERIFIED on Windows).** Scaffolding for a right-click "New" submenu
  item via the classic ShellNew registry mechanism — no shell-extension
  DLL, just a registry value + a template file. `scripts/gen-new-template.ts`
  (run via `npm run gen:new-template`) serializes a minimal blank doc (a
  single empty paragraph) to `apps/desktop/resources/new-template.cmir`
  through the real `serializeNative`, so it's always a valid current-
  format `.cmir`; the file is committed and shipped via electron-builder
  `extraResources` to `$INSTDIR\resources\new-template.cmir`.
  `apps/desktop/build/installer.nsh` (auto-included by electron-builder)
  writes `SHCTX\Software\Classes\.cmir\ShellNew\FileName` to that path on
  install and removes it on uninstall; SHCTX follows the per-user /
  per-machine install scope, matching where the existing `.cmir`
  `fileAssociations` registration lives (which also supplies the menu
  label "CardMirror Document"). Not yet tested on a real Windows machine
  — left as a ready-to-verify draft; kept out of the user-facing
  changelog until confirmed working.

- **In-file object search matches a tag by its card's cite.** Diving
  into a file (`extractFile` in `file-search.ts`) produced a `tag`
  `FileObject` whose only searchable text was the tag's own words, and
  `searchFileObjects` matched on `label` alone — so an author/date never
  surfaced its tag (unlike Ctrl-F, which can match the card via the
  `cite_paragraph`). `FileObject` gains an optional `cite` field;
  `extractFile` now always collects cite text (`collectHeadings` without
  `skipCite`, so it's available even when the standalone `cite` object
  *kind* is off — that flag still only gates the separate CITE rows) and
  attaches the card's cite to its tag object. `searchFileObjects` matches
  against `label + cite` for tags (label leads, so a label hit still
  outranks a cite-only hit). `fileObjectResult` shows the cite as the
  row's secondary text for tags, so a cite-match reads clearly and tags
  carry their citation like the nav pane. Since a tag is now findable by
  its cite, the standalone `cite` object kind is redundant and now
  defaults OFF (`fileSearchObjectTypes` default + sanitize fallback +
  `DEFAULT_FILE_OBJECT_KINDS` all drop `'cite'`); it stays a configurable
  toggle for anyone who wants separate CITE rows.

- **OS "Open with…" routes into the workspace in multi-pane mode.**
  `openExternalFile` (main) always did `createWindow({ initialDoc })`,
  but the renderer's multi-pane boot never read `getInitialDoc()` (only
  single-doc boot did), so an externally-opened `.docx`/`.cmir` produced
  a blank workspace window. Fix has two halves:
  - Main keeps a `multiPaneWindows` set, populated/cleared by a new
    `host:register-multipane` IPC the renderer calls at boot (true in
    multi-pane boot, false in single-pane boot — so it survives the
    reload a workspace-mode toggle triggers, and is cleared on window
    `closed`). `openExternalFile` now `pickMultiPaneTarget()`s a
    multi-pane window (focused first, else any) and forwards the path
    via `host:external-open` (focusing/restoring it) instead of
    spawning; with no multi-pane window it falls back to the existing
    read-and-`createWindow` path — so single-pane is byte-for-byte
    unchanged, and cold launch still spawns.
  - The renderer (multi-pane boot) registers, subscribes to
    `host:external-open` (→ `openFileByPath` → `routeOpenedFile` → slot
    picker), and runs `routeInitialDocIntoWorkspace()` — reading any
    spawn payload and routing it through `routeOpenedFile` (slot picker)
    rather than booting blank; recovery is skipped when a payload was
    consumed, mirroring single-doc. New bridge methods
    `registerMultipane` / `onExternalOpen` on the preload, `ElectronAPI`
    interface, and `ElectronHost` class (guarded for older preloads).
  - Net behavior (the user's choice): a workspace window already open —
    populated or empty — is reused and shows the slot picker (no new
    window); only when no workspace window exists does it open one and
    show the picker there. Single-pane keeps spawning a window per file.

- **Command-bar file search refreshes the open palette live.** The
  background `.cmir` revalidation in main (`revalidateCmirIndex`,
  `apps/desktop/src/main.ts`) updated its cache but never told the
  renderer, so the comment's "picked up on the next palette open" was
  literally the only way to see fresh results. Now, when the re-scan
  finds the listing changed, main `broadcastCmirIndexUpdated(root,
  entries)` to every window via `host:cmir-files-updated`. The preload
  exposes `onCmirFileIndexUpdated(handler)` (mirroring
  `onDropzoneChanged`), surfaced on the `ElectronAPI` interface +
  `ElectronHost` class (guarded so an older preload degrades to no live
  refresh). `QuickCardSearchUI` subscribes on open / unsubscribes on
  close and handles the event in `onFileIndexUpdated`, designed so an
  in-progress search is never disrupted:
  - filters by `root` (ignores broadcasts for a different search
    folder) and bails if the palette is closed;
  - swaps `this.fileList` to the fresh listing and re-warms pins against
    the new mtimes, but does NOT bump `asyncToken` — so it can't abort
    an in-flight `enterInFile` read (and there's no `loadFileList` race:
    main returns the cached listing before starting the walk that emits
    the event, so the load always resolves first);
  - if the user has Tab'd into a file (`inFile`), leaves the visible
    object results untouched — the fresh listing is just staged for when
    they Esc back;
  - otherwise re-runs the current query (the input text is the source of
    truth, untouched) only when files are actually on screen (prefix `f`
    or a non-empty everything search), and restores the selection by
    identity (`resultKey`) so the cursor doesn't bounce to the top.

- **Edge autoscroll while selecting text.** Dragging a text selection to
  the top/bottom of the viewport now scrolls the document so the
  selection can extend past the originally visible area. Built into
  `word-selection-plugin.ts`, which already owns all mouse text
  selection (it `preventDefault`s the native drag and drives the
  selection via dispatched transactions in `installDragListeners`). The
  drag listeners now also: resolve the nearest scrollable ancestor of
  `view.dom` (`#app` single-doc, `.pmd-pane-body` per pane), track the
  pointer, and run a `requestAnimationFrame` loop while the pointer sits
  in a top/bottom edge band. Each frame scrolls the viewport by
  `edgeAutoscrollDelta(top, bottom, clientY)` (ramped 1px→20px with
  depth into the band, exported + unit-tested) and re-extends the
  selection to `posAtCoords` of the pointer — clamped just inside the
  scroller so a pointer parked past the edge keeps pulling in the
  edge-most line even while held still. The loop self-reschedules only
  while it actually scrolls, so it stops at the scroll limit or when the
  pointer leaves the band; it tears down on mouseup. Works in both
  single-doc and multi-pane because it's keyed off each view's own
  scroller, and needs no new wiring since the plugin is already in
  `buildEditorPlugins`.

- **`findRememberLastQuery` is honored again.** The find bar
  (`find-replace-ui.ts`) reuses one DOM input across open/close and
  never cleared it, so once a query was typed it lingered in the
  element. `open()` only pre-filled "when the input is empty", which was
  never true after the first use — so the remembered query stayed
  visible regardless of the setting (and `close()`'s gated persist was
  irrelevant). Fix: capture `wasClosed = this.root.hidden` before
  un-hiding, and on a fresh open set the input value deterministically —
  `settings.get('findLastQuery')` when `findRememberLastQuery` is on,
  `''` when off — instead of conditionally pre-filling only an
  already-empty field. Guarding on `wasClosed` means re-triggering while
  the bar is open (Ctrl-F → Ctrl-H mode switch) still preserves what's
  typed.

- **"Cycle Theme" ribbon command (`cycleTheme`).** A bindable command
  that rotates the `theme` setting light → dark → system → light. Added
  through the standard registry path: the `RibbonCommandId` union,
  `RIBBON_COMMAND_IDS`, `RIBBON_COMMAND_LABELS` ("Cycle Theme (Light →
  Dark → System)"), `RIBBON_COMMAND_ALIASES` (dark mode / light mode /
  toggle theme / switch theme), `DEFAULT_RIBBON_KEYS` (`''` — unbound),
  the `View` ribbon group (satisfies the drift guard), and a
  `commandFor` case that calls a new `RibbonContext.cycleTheme` hook.
  The hook is implemented in `index.ts` where the context is built: it
  reads `settings.get('theme')`, advances through `['light','dark',
  'system']`, calls `settings.set('theme', next)` (the existing
  subscription re-runs `applyTheme`), and shows a `Theme: <next>` toast.
  Being in the registry, it auto-appears in the keybindings editor, the
  shortcuts reference, and the command palette — no per-surface wiring.

- **Analytic / Undertag document colors: unified the two settings,
  fixed the inert Appearance picker, and made dark-mode behavior
  correct.** Two settings both targeted the same CSS vars and fought.
  `applyDisplayColors` (Appearance → "Style colors", `displayColors`)
  wrote `--pmd-color-analytic` / `--pmd-color-undertag` inline on
  `:root`; `applyCustomColorOverrides` (Accessibility → "Color
  overrides", `customColorOverrides`, whose `CUSTOMIZABLE_COLOR_TOKENS`
  includes those two) ran *last* and, for any token not in the
  overrides blob, called `removeProperty('--pmd-color-analytic')` —
  wiping the displayColors write. Net effect: the Appearance picker did
  nothing unless you also set an Accessibility override.

  Reworked onto a single source of truth (`displayColors`) with a
  CSS-variable indirection so the theme can layer on top:
  - `applyDisplayColors` now writes the user's pick to
    `--pmd-user-color-*` (not `--pmd-color-*`). `style.css` resolves
    the effective `--pmd-color-*` from it: `:root` →
    `var(--pmd-user-color-analytic, #1F3864)` (light = user color);
    `:root[data-theme="dark"]` → the built-in `#8aa9d1` / `#8fb377`
    (chrome/nav, readable on dark — now actually effective because the
    inline write targets a *different* variable);
    `:root[data-theme="dark"]:not([data-theme-doc="dark"]) :is(#editor,
    .pmd-pane-editor)` → back to `var(--pmd-user-color-*, …)` so the
    document keeps the user color while it's on paper; with apply-to-doc
    ON the editor inherits the dark `#8aa9d1` instead. Behavior matrix:
    light = user / user; dark not-applied = light-blue nav / user doc;
    dark applied = light-blue / light-blue.
  - `applyCustomColorOverrides` is now passed `CUSTOM_OVERRIDE_TOKEN_NAMES`
    (the manifest minus the two document-text tokens) so it can no
    longer remove/clobber them.
  - The Accessibility "Document text" rows (`buildColorOverridesEditor`)
    are special-cased via `DISPLAY_COLOR_TOKEN_TO_KEY`: they read/write
    `displayColors`, hide the alpha slider, and reset to
    `DEFAULT_DISPLAY_COLORS` — so they're a linked view of the same
    value the Appearance picker edits.
  - `buildColorsEditor` (Appearance) gains a per-row reset-to-default
    button; "Reset all overrides" also resets `displayColors`.
  - Migration: `sanitizeDisplayColors(raw, rawOverrides)` folds any
    legacy `customColorOverrides['pmd-color-analytic'|'pmd-color-undertag']`
    into `displayColors` (the override wins — it's what actually
    rendered), and `sanitizeCustomColorOverrides` drops those two tokens
    so there's no double source going forward.

- **Command-palette search aliases for settings and commands.** The
  Search-Everything palette matched a query only against a command's
  `RIBBON_COMMAND_LABELS` entry or a setting's `SettingMeta.label`, so
  anything phrased differently than the label simply didn't appear.
  Two new alias registries fix that, matched but never displayed:
  `RIBBON_COMMAND_ALIASES` (a `Partial<Record<RibbonCommandId,
  readonly string[]>>` in `ribbon-commands.ts`) and an optional
  `aliases?: readonly string[]` on `SettingMeta` (`settings.ts`).
  `searchCommandSource` / `searchSettingsSource` in
  `quick-card-search-ui.ts` now build the match haystack from
  `label + ' ' + aliases.join(' ')` while still ranking by first-token
  position *within the label* (an alias-only hit ranks via `Infinity`,
  so label hits always sort ahead). Two recurring motivations: the
  show/hide ⇄ toggle bridge the user asked for (`toggleCommentsVisible`
  ⇄ "toggle comments", `toggleNavPane` ⇄ "toggle navigation pane" /
  "sidebar"), and vague or Word-flavored labels ("Clear" ⇄ "clear
  formatting", "Paste Plain Text" ⇄ "paste without formatting"). The
  Theme setting gains `light mode` / `dark mode` / `toggle theme` /
  `system theme` / `color scheme`; other settings get the obvious
  alternate names (Line spacing ⇄ "line height", Interface font ⇄ "ui
  font", Reduce motion ⇄ "animations", Three-pane workspace ⇄ "split
  view", etc.). Aliases are lowercase because the palette lowercases
  the query before matching.

- **Learn section keeps Manage reachable with zero flashcards.**
  `renderLearn` in `src/editor/home-screen.ts` used to replace the
  whole section with a single muted placeholder card when
  `totalCount({ kind: 'all' }) === 0`. But "Manage flashcards" opens
  the manage UI, which carries the Import button — the only way to
  bring in cards from a file — so the empty state was a dead end for
  anyone trying to import. The empty branch now renders the same
  two-card row as the populated state: a disabled "Review all" card
  (new `{ disabled }` option on `actionCard` — sets `btn.disabled`,
  adds `.pmd-home-action-disabled`, skips the click listener) and a
  live "Manage flashcards" card. The keyboard-shortcut runner for
  Manage lost its `totalCount > 0` guard for the same reason. The
  orphaned `.pmd-home-action-placeholder` CSS was repurposed into
  `.pmd-home-action-disabled` (muted opacity, neutral hover).

## 0.1.0-alpha.6 — 2026-05-30

- **`.cmir` loader stamps fresh ids on id-less headings at parse
  time.** New `stampMissingHeadingIds(doc)` in `src/schema/ids.ts`
  walks the parsed `PMNode` tree and reconstructs any pocket /
  hat / block / tag / analytic whose `id` attr is null with a
  fresh UUID. `parseNative` calls it on the
  `schema.nodeFromJSON(file.doc)` output. Origin of the id-less
  headings: PM's schema fitter, when it bubbled up F2's
  multi-line plain-paste split to the card level, synthesized
  the second-half card's mandatory first-child tag from the
  schema's `headingAttrs.id.default` (= `null`) rather than via
  `newHeadingId()`. That path is closed at the source as of the
  F2 fix earlier in this release, but old docs written before
  the fix carry those id-less tags frozen into the file.
  `setCaretHeading` in `nav-panel.ts` keys the cursor → nav
  highlight on the heading id (skipping null), so an id-less tag
  is functionally invisible to the highlight — the cursor in
  that card appears in the *previous* card's slot. Stamping at
  load repairs the file in place; the next save (in any path
  that writes the doc back through `serializeNative`) makes the
  repair persistent. The walk runs once at parse time, returns
  the original node by identity when nothing needed stamping
  (no-op cost), and preserves indent / spacing / other attrs
  on the stamped heading. A pair of tests in
  `tests/native/native.test.ts` covers the load-time stamp and
  the existing-id no-op; a focused suite in
  `tests/schema/stamp-missing-heading-ids.test.ts` covers the
  helper across the full heading set + edge cases (round-trip
  identity when nothing's null, isolated stamping in mixed docs,
  attr preservation).

- **Fast Debate Paste integration — main-process HTTP bridge +
  renderer-side insertion primitive.** Spec lives at
  `reference-docs/cardmirror-integration-spec.md`. New
  `apps/desktop/src/fast-paste-bridge.ts` boots a Node `http`
  server on `127.0.0.1:17699` (ephemeral fallback on EADDRINUSE)
  in `app.whenReady()`. On start it generates a fresh per-launch
  token via `crypto.randomBytes(24)`, writes the discovery file
  at `app.getPath('userData')/fast-paste-bridge.json` via
  tmp-then-rename, and tears both down on `before-quit`. Both
  routes constant-time-compare `X-FDP-Token`; mismatched / absent
  token → 403. Any request carrying `Origin` or `Referer` is
  also rejected (the DNS-rebinding-from-a-browser-page guard the
  spec calls out). `GET /ping` replies with
  `{ok, app, appVersion, schema, hasActiveDoc}`. `POST /insert`
  forwards `{requestId, text, role, newParagraph, omitted}` to
  the focused window's renderer via `external:insert-text` IPC
  and awaits the renderer's `external:insert-result` reply with
  a hard 1200ms timeout so the client never hangs (it enforces
  1500ms on its end before falling back to keystrokes). Error
  codes map: `no-target-doc` / `doc-readonly` → 200 with
  `ok:false`, `bad-request` → 400, `unauthorized` → 403,
  anything else → 500. Unknown `role` values degrade to `card`.

  Renderer side: new preload channels (`external:insert-text`
  receive, `external:insert-result` send) on the existing
  contextBridge surface — no `executeJavaScript` under
  contextIsolation. `src/editor/external-insert-host.ts`
  subscribes via `installExternalInsertHost`, called from the
  boot block in `index.ts` alongside the dropzone controller.
  When a request arrives it resolves the live `EditorView` (or
  returns `no-target-doc` if none), checks `view.editable` for
  the read-mode gate (returns `doc-readonly` when the flag is
  off — the same gate that swallows F2 keystrokes today), and
  hands `{text, newParagraph}` to
  `src/editor/external-insert.ts`'s
  `buildExternalInsertTransaction`. The primitive splits `text`
  on `/\r\n|\r|\n/`, builds each piece as a `card_body` node
  (or `paragraph` when the cursor has no `card` / `analytic_unit`
  ancestor — i.e. at doc level), assembles a closed-start /
  open-end Slice, and `tr.replaceSelection`. The closed start
  makes the first inserted body a fresh sibling at the cursor
  (mirrors the keystroke bridge's "press Return first"); the
  open end merges the last body's content with whatever was
  after the cursor in the original textblock (mirrors what F2
  paste does after the Return). Because the node types are
  chosen directly, the schema's content expression is satisfied
  in one pass — no contextual fitting, no fitter bubble-up, no
  way for a pasted line to be elevated to a tag (which is the
  same failure mode the F2 fix in this release closes from the
  other direction).

  Tests cover the route layer (`tests/desktop/fast-paste-bridge.test.ts`,
  16 cases — token, ping shape, Origin/Referer rejection, all
  five error codes, payload validation, unknown-role degradation,
  no-focused-window short-circuit, discovery-file lifecycle),
  the primitive (`tests/editor/external-insert.test.ts`, 10
  cases — mid/start/end of card_body, multi-line, the spec's
  §9 acceptance case, doc-level fallback to `paragraph`, empty
  text, trailing newline, inline + leading-space convention),
  and the renderer-side host (`tests/editor/external-insert-host.test.ts`,
  7 cases — happy path with docTitle, inline, no-target-doc,
  doc-readonly, bad-request, docTitle suppression when no
  filename). Vitest's `electron` module is aliased to
  `tests/desktop/_electron-stub.ts` (electron isn't installed at
  the project root) so the bridge can be driven without
  bootstrapping a real Electron process.

- **F2 plain-paste: route through `tryPasteAsCardBodies` like rich
  paste does.** `applyPlainPasteFromText` (the Electron F2 entry
  point) and the armed-paste branch of `handlePaste` (the browser
  F2 entry point) both used to do `tr.replaceSelection(slice)`
  directly with the slice that `buildPlainTextSlice` produces — a
  `Fragment([paragraph(line1), paragraph(line2), …])` with
  `openStart=1 / openEnd=1`. `paragraph` is not in the `card`
  content expression (`tag (card_body | undertag | cite_paragraph
  | analytic | table)*`), so when the slice landed inside a
  `card_body` PM's Fitter could only fit the first and last
  paragraphs via the openings — every middle paragraph then bubbled
  the split up to the card level. The Fitter's second-half
  reconstruction has to start with a `tag` (the card's content rule
  is non-negotiable), so it would either synthesize a phantom
  empty-tag card sibling or, in the configurations the FDP spec
  flagged, convert the first content node it had on hand into a
  tag — which is where the "extra spacing between pasted lines"
  user reports come from (the tag's `margin: 0.75rem 0 0.25rem 0`
  rendering as the gap). The absorb plugin re-claims orphan
  paragraphs into the preceding card, but the brief bubble-up plus
  re-absorption still moves the cursor through an awkward
  trajectory before landing it. The fix is the same one
  `handlePaste` already uses on the rich-paste path
  (`paste-plugin.ts:269-272`): call `tryPasteAsCardBodies` first to
  pre-convert the slice's `paragraph` nodes to `card_body` nodes
  before `tr.replace`, so the Fitter has no fitting problem to
  solve. The cursor now lands at the end of the last pasted line
  (or on the trailing empty body when the text ends in a newline,
  which is the "cursor on a fresh line is fine" case). Slices where
  `tryPasteAsCardBodies` returns null (single-line paste, non-
  card-body cursor, non-paragraph children) keep going through
  `replaceSelection` as before.

- **F12 dissolve + absorb-plugin: cursor preservation for the
  inside-the-replaced-range case.** Two related fixes in one entry.

  (1) `applyClearToNormalDemote` in `ribbon-commands.ts` dissolves a
  card or analytic_unit when F12 lands on its head (tag / analytic):
  it builds a `paragraph(cleanedHeadContent)` plus a lifted version
  of each trailing child (`card_body` / `cite_paragraph` →
  `paragraph`, `undertag` kept, `analytic` → `analytic_unit`-wrapped),
  then `tr.replaceWith(containerStart, containerEnd, lifted)`. PM's
  default `ReplaceStep` selection mapping pushes any position inside
  the replaced range to the END of the replacement (the assoc=1
  right-association convention) — same root cause as the original
  absorb-plugin "viewport rockets to doc end" bug. After the replace
  we now compute the cursor's logical position in the new structure
  via a new `mapPosThroughDissolve` helper (which walks the original
  container's children to find which one held the cursor + the
  intra-child offset, then resolves the corresponding position in
  the lifted-children sequence, accounting for the extra opening
  boundary that the analytic → analytic_unit wrap adds) and call
  `tr.setSelection(TextSelection.between(...))`. Same template as
  `dissolveContainerToHeading` at `ribbon-commands.ts:625-631`,
  which had this fix from the start.

  (2) `absorb-plugin.ts`'s surgical insert+delete preserved cursor
  positions outside the absorbed-orphan range but lost the ones
  inside it: step 2's `tr.delete(orphansStart+insertSize,
  orphansEnd+insertSize)` claims the cursor's range, and PM's
  default assoc=1 mapping pushes the cursor to the end of the
  deletion (which auto-snaps to the last textblock of the now-
  absorbed card). The plugin now captures `newState.selection`'s
  head/anchor before its steps run, flags whether either fell into
  any region's orphan range, and after the steps calls
  `tr.setSelection` with each flagged endpoint mapped to
  `origPos - 1` — the absorbed orphan now lives just before the
  card's closing boundary (one fewer doc-level boundary stands
  between the original orphan position and the new card_body
  position), so the position offset is `-1` regardless of how many
  orphans the region absorbs or how many regions absorb to the
  left.

  Together these handle the F12 → absorb cascade the user hit:
  F12 on Card B's tag (with Card A preceding it) demotes the tag
  to a paragraph at doc level, absorb claims that paragraph plus
  the lifted bodies into Card A, and the cursor follows the
  demoted text into Card A at the original character offset
  instead of landing at the tail of Card A's content. The probe
  test at `tests/editor/paste-viewport-bug.test.ts` (already a
  catalogue of this family of bugs) grows new F12 cases plus
  improved expectations on the pre-existing `H` scenario (cursor
  in an orphan paragraph that absorb claims).

- **Dropzone pill fallback now clears the status bar.** `.pmd-dropzone-
  root`'s CSS fallback `bottom` is now `calc(var(--status-bar-height)
  + 0.5rem)` (was `0.5rem`), and its `z-index` is `220` (was `12`,
  above the status bar's `200`). `positionDropzone` (`index.ts`) still
  reads `#app`'s / the focused pane body's live rect and inlines the
  exact `bottom`, but on some Windows machines that pass landed when
  the target's `getBoundingClientRect()` was 0×0 — the function
  early-returns there, and nothing later was firing to re-run it
  (`ResizeObserver` only fires on size *changes*; the layout-stabilizes-
  to-its-final-size case doesn't trigger a delta). The pill stayed at
  its CSS fallback, ~8px above the viewport bottom, sitting in the
  status bar's vertical band. A second symptom in the same screenshot
  (the pill rendering visibly on top of the status bar rather than
  being clipped by it despite `z-index: 12` losing to the bar's `200`)
  is consistent with a Chromium layer-promotion quirk on Windows,
  rooted in two body-level `position: fixed` elements with `box-
  shadow` ending up on independent composited layers whose paint
  order doesn't always honor the in-spec stacking. The new fallback
  prevents the overlap from happening in the first place; the z-index
  bump keeps the pill visible and clickable if a future layout change
  recreates an overlap.

- **Paste-time unwrap of single-cell layout tables.** `paste-plugin.ts`'s
  `transformPasted` hook now runs a new `unwrapSingleCellTables` pass
  ahead of `freshHeadingIds`. Pasting from sources that use `<table>`
  as a layout primitive (Google Docs published views, news-site article
  bodies, marketing emails, .docx page-frame copies) used to leave the
  wrapping `table` node intact in the parsed clipboard slice — and
  because both `table` and `table_cell` are `isolating: true` in our
  schema (`src/schema/nodes.ts:528, 573`), the surrounding `card_body`
  could neither join across the boundary nor be deleted around it.
  Visible failure modes: (a) an empty 1×1 table between a card's cite
  and its first body paragraph rendered as an apparently-empty line
  that Backspace would refuse to remove, expanding to swallow the
  whole card on retry; (b) a 1×1 with content rendered text inset
  from a real card body, with a small extra vertical gap above,
  because of the cell's default padding + the table's block-level
  margin. New rule: any `table` whose every row contains exactly one
  cell unwraps to the concatenation of its cells' paragraphs. Multi-
  cell-per-row tables (real data tables) pass through unchanged.
  Empty 1×1 tables fall out as the degenerate case (no paragraphs to
  lift). At the slice root we emit generic `paragraph` nodes so PM's
  contextual fitting and our own `tryPasteAsCardBodies` adapt them to
  the cursor's body slot; when the unwrap happens inside a `card` /
  `analytic_unit` already present in the slice (whole-card paste case),
  we emit `card_body` directly so the parent's content rule is
  satisfied without depending on downstream fitting. F2 plain-paste
  is unaffected because that path bypasses the HTML parser and
  builds the slice from `text/plain` via `buildPlainTextSlice`,
  which can only produce `paragraph` and `text` nodes.

## 0.1.0-alpha.5 — 2026-05-29

- **Find ordering: document-order-from-cursor, not proximity.**
  `find-replace-plugin.ts`'s `compareByProximity` (nearest-first in both
  directions) is replaced by `compareFromCursor`: matches at/after the
  anchor come first, then those before it, each side ascending by
  document position — i.e. top-to-bottom from the cursor, wrapping to the
  top. Both sort modes use it: `categorized` (Ctrl-F) as the
  within-category tiebreak (after category priority + the cite sub-rank);
  the former `proximity` mode is renamed **`uncategorized`** (Alt-F) and
  is just `compareFromCursor` over the flat match set. `openFindByProximity`
  keeps its command id (so existing rebinds don't orphan) but its label is
  now "Find Without Category Grouping" and `index.ts` opens it with
  `sortMode: 'uncategorized'`; the find-bar mode chip + tooltips updated.

- **Flashcard export / import (Manage flashcards).** `learn-store.ts`
  gains `exportCards()` → `ExportedCard[]` (per card: content + a
  cardId-less `schedule` + its `{ docId, anchor }[]` groundings) and
  `importCards(entries, today)`, which mints a **fresh cardId per entry**
  so import always ADDs (re-importing duplicates, by design; never
  overwrites), carrying the schedule (cardId reassigned) or a fresh one,
  plus anchors. The Manage GUI's bar gets **Import** / **Export** buttons
  over the host `saveAs` / `openFile` JSON pickers (`{ version: 1, cards }`,
  bare array also accepted). `parseImportedCard` / `parseImportedAnchor`
  defensively coerce each untrusted entry (type ∈ qa|cloze, non-empty
  front, well-formed schedule-or-fresh, valid `AnchorDescriptor`-or-null),
  so older/foreign files import cleanly. The open list refreshes via the
  store subscription; no overwrite confirm needed (import is additive).

- **Settings export / import.** `SettingsStore.exportObject()` returns all
  values minus the transient per-window keys and `anthropicApiKey`;
  `replaceAll(raw)` overwrites through the same
  `sanitize({ ...DEFAULTS, ...raw })` boundary as `load` — so it tolerates
  schema drift (added fields → defaults, removed → dropped, bad values
  coerced/clamped) and preserves the current API key + transient values.
  Settings → General gains a "Back up settings" section
  (`buildSettingsBackupSection`) with Export / Import buttons over the host
  `saveAs` / `openFile` JSON pickers (writes `{ version: 1, settings }`,
  also accepts a bare object). Import confirms, runs `replaceAll`, then
  re-renders the dialog so every control reflects the imported values.

- **Settings tab underline no longer clipped when the tab strip scrolls.**
  The active tab's 2px `border-bottom` is pulled 1px below
  `.pmd-settings-tabs`'s content box via `margin-bottom: -1px` (to overlap
  the bar divider). That strip is a horizontal scroll container
  (`overflow: hidden`); at scrollLeft 0 the negative-margin overflow isn't
  clipped, but once `scrollTabIntoView` nudges a mid-strip tab to a
  non-zero scroll the clip drops the underline — so the middle tabs
  (Keyboard, Comments & AI) lost it while the edge tabs kept it. Added
  `padding-bottom: 1px` to the strip so the underline stays inside the
  clip box at any scroll position.

- **Keyboard macros — bind a key to type a snippet.** New
  `keyboardMacros: KeyboardMacro[]` setting (`{ id, key, text }`;
  sanitized; default `[]`). `keyboard-macros.ts`'s `buildMacroKeymap`
  turns the list into a `keymap()` where each key inserts its text at the
  cursor (`tr.insertText`), installed in `buildEditorPlugins` **before**
  the ribbon keymap so a macro key wins over a same-key command. The
  reconfigure subscriber in `index.ts` rebuilds the plugin stack when
  `keyboardMacros` changes (alongside `ribbonKeyOverrides`), so edits take
  effect live without a reload. UI: a "Keyboard macros" section appended
  below the shortcut list in `keybindings-editor.ts`, reusing the
  shortcuts' visual vocabulary so it reads as the same control — section
  title + description use the settings-row classes
  (`.pmd-settings-row-title` / `-desc`) to match the "Keyboard shortcuts"
  heading; the same boxed `.pmd-keybindings-list` container and
  `.pmd-keybinding-row` rows, with the shortcut shown as a
  `.pmd-keybinding-chip` (empty `—` + "+" until set) and the typed-text
  field in the row's flex "label" slot. Key
  capture reuses `ribbonKeyStringFor` + `validateKey`; the text field
  commits on `change` (not per keystroke, to avoid a focus-stealing
  re-render); per-row delete + an "Add macro" button below the box; an
  empty-state row when there are none. Setting a key clears it from any
  other macro (one key = one macro); macro-vs-command conflicts are
  resolved at runtime by plugin order (macro wins), not dislodged.

- **Home screen: number keys 5-7 for the newer action cards.** Extended
  `actionRunners` + the `onKeyDown` digit map (`home-screen.ts`) from 1-4
  to 1-7: 5 = Bulk convert, 6 = Review all, 7 = Manage flashcards. The
  three new runners guard on the same conditions that render their card
  (`callbacks.bulkConvert` present; `learnStore.totalCount > 0`), so a key
  only fires while its button is on screen.

- **Ribbon: Create-flashcard + Ask-AI buttons in the comments group.**
  Both commands were bindable / palette-only; they now have ribbon
  buttons. The comments ops-panel becomes a 2×2 grid (`ribbon-doc-ops-
  panel-2col`): comments-toggle / add-comment on top, create-flashcard /
  ask-ai below. Clicks `preventDefault` on mousedown (keep the selection
  live) and run the bindable command via `runRibbonCommandById`. The
  **Ask-AI** button is hidden unless `aiFeaturesEnabled`
  (`applyAskAiButtonVisibility`, driven by the central `settings.subscribe`
  + an explicit `#ribbon .ribbon-doc-ops-btn[hidden]` rule, since
  `#ribbon button { display: inline-flex }` otherwise defeats `[hidden]`).
  Two new icons (`flashcard` → graduation-hat-02, `ai` → stars-02) added
  to `gen-icons.mjs` + the `IconName` union. Tooltips use sentence-case
  label overrides (`Create flashcard from selection` / `Ask AI about
  selection`) while the command-palette labels stay title-case.

- **Frozen selection: keep the selection painted while the editor is
  blurred.** A contenteditable's native selection vanishes when focus
  leaves it (the command / search palette input, the find bar, etc.), so
  a user who selected text then opened a palette lost sight of it. New
  `frozen-selection-plugin.ts` tracks focus via `blur`/`focus` listeners
  on `view.dom` (a doc-neutral `addToHistory:false` meta) and, while
  blurred, renders an inline decoration over the current `TextSelection`
  with the same tint as the live `::selection` (`.pmd-frozen-selection`,
  accent 30%); cleared on focus so PM's real selection takes back over.
  Registered in `buildEditorPlugins`, so single-doc, multi-pane, and the
  quick-cards editors all get it. Node selections keep their own
  `ProseMirror-selectednode` styling, so the plugin paints text
  selections only.

- **Comments column: one unified card design (comments / flashcards / AI).**
  The three card types had drifted into three visual vocabularies; this
  unifies them.
  - **Type chip.** Every card leads with a shared chip (`makeCardTypeChip`
    → `.pmd-card-type-chip`): `COMMENT` / `Q&A` · `CLOZE` / `AI`, colored
    to mirror the in-text highlight hue (gold / accent / purple).
    Replaces the flashcard's bespoke `.pmd-flashcard-card-badge` and the
    per-turn `.pmd-ai-chip`.
  - **No left borders.** Per-card identity is now a CSS var
    `--pmd-card-accent` (gold / accent / purple) set on the card, driving
    both the chip and the **active** state — which now takes the card's
    own color (border + a same-hue tinted glow) instead of always-blue.
  - **Avatar only when expanded.** Collapsed previews drop the round
    avatar (chip + excerpt + count); the avatar returns when expanded,
    where it separates the thread-opening turn from replies. AI turns
    keep the purple avatar (`pmd-comment-ai`) + persona name; the
    per-turn AI tag is gone (the card chip carries it).
  - **AI opening question renders as root.** `populateAiThread` renders
    the first turn via `renderAiComment(c, isRoot=true)` → un-indented
    `pmd-comment-root` (it begins the conversation); answers + follow-ups
    are `pmd-comment-reply`. Previously every AI turn was a reply, so the
    opening question looked like a reply to nothing.
  - **Delete affordances split by type.** Comment + AI cards get a
    thread-delete `✕` in a shared card header (`buildThreadHeader`);
    comment replies keep a per-reply `✕`; flashcards keep the two-click
    Delete pill. The AI ghost-pill action row is gone — **Convert to
    Flashcard** is promoted to a filled-blue button (`.pmd-ai-convert-btn`)
    below Reply.
  - **Header row + date; send-key input.** The type chip sits in its own
    header row in every state (collapsed too, via `buildThreadHeader`),
    with the card's date right-aligned beside it (comment = root date, AI
    = thread `createdAt`) — the slot the flashcard's status chip occupies.
    The reply / ask / comment submit is now a compact `send-cursor` icon
    button to the right of the textarea (row layout), not a full-width
    button below.
  - Removed `renderAiHeader` / `renderRootHeader` / `buildAiActions` /
    `aiChip`. Unanchored rows unchanged.

- **AI threads → local annotation layer.** Migrated the "Ask AI about
  selection" explainer off comment threads (round-tripping
  `comment_range` marks) onto the same per-user local layer flashcards
  use (SPEC-learn-system §"one local layer"), so AI questions never
  serialize into a shared `.docx`/`.cmir`. Design (per the user):
  **local-only** (like flashcards) and **going-forward only** (existing
  AI *comments* in documents stay as comments; no auto-migration).
  - **Store.** Wired the previously-unused `AiThread` / `LocalComment`
    scaffolding in `learn-store.ts`: added `getAiThread` and
    `appendAiComment` alongside the existing `addAiThread` /
    `setAiThreadAnchor` / `removeAiThread` / `aiThreadsForDoc`. AI threads
    persist in the same host KV blob (`aiThreads[]`) keyed by `docId`.
  - **Anchoring + highlight.** AI threads ground via the shared
    `AnchorDescriptor` (`buildDescriptor`/`resolveDescriptor`) and paint a
    **purple** decoration. The highlight plugin's `FlashcardRange` gained
    a `kind: 'flashcard' | 'ai'` (mapped through edits + the drop-recovery
    re-resolve); `buildDecos` picks `.pmd-ai-range` vs `.pmd-flashcard-range`.
    `comments-ui`'s `refreshFlashcardAnchors` now resolves AI-thread
    anchors too.
  - **Create.** The `aiAskAboutSelection` command (`index.ts`) now mirrors
    `createFlashcard`: build a descriptor, `ensureActiveDocId` +
    `registerDoc` + `stampActiveFileDocId`, `learnStore.addAiThread`, then
    `commentsColumn.activateAiThread`. **No `comment_range` mark.**
  - **Render.** `comments-ui` render() adds AI threads as a third item
    kind in the sorted column list (purple `pmd-ai-card`): producer
    "ask" input when empty, collapsed preview, active conversation
    (`LocalComment[]`) with reply box + two-click delete, plus a
    re-ground row + Unanchored section (mirroring flashcards). AI turns
    show the persona name with initials derived from it (`aiPersonaName`
    / `aiPersonaInitials`) and an **"AI" chip** (`.pmd-ai-chip`) — the
    round-trip-safe `'AI'` initials + `(AI)` name suffix the comment path
    needs are dropped here, since a local thread never serializes so the
    docx-survival heuristic is moot; the chip carries the AI signal.
  - **Model call.** `askAi` records the user's turn then calls
    `invokeAiLocal`, which mirrors the comment-thread `invokeAi` against
    the store `AiThread`: builds the multi-turn message list from
    `LocalComment[]` (user turns → `user`, `ai: true` turns →
    `assistant`, first user turn wrapped in `formatExplainPrompt`), shows
    the Thinking… placeholder + Clod activity ticker while in-flight, and
    `appendAiComment`s the reply as an `ai: true` turn. Context is cached
    at activation from the original selection (`buildExplainContext`,
    captured before scroll moves the caret), with `contextFromAiThread`
    (resolve the anchor → range → context) as the post-reload fallback.
    Reply turns re-invoke automatically (it's an AI thread).
  - **Convert to Flashcard.** Active AI cards get a **Convert to
    Flashcard** action (beside Delete). It asks the model for one card
    (Q&A or cloze) capturing the thread's line of inquiry, then opens the
    create-flashcard editor pre-populated so the user edits/confirms; the
    new card grounds to the **same** selection as the AI question
    (`setAnchor(cardId, thread.docId, thread.anchor)`). New module
    `ai/flashcard-gen.ts` holds the research-grounded `FLASHCARD_SYSTEM_
    PROMPT`, `formatFlashcardPrompt` (highlight + card context + the
    conversation, with the user's questions called out as the angle
    signal and the AI replies demoted to background), and a tolerant
    `parseFlashcardReply` (extracts the outermost `{...}`, validates type
    / non-empty front / Q&A-needs-back). The prompt is built from the
    `reference-docs/mnemonic-medium/` corpus: it leans on the highlight +
    questions + card tag as the signal of what the user wants reinforced
    ("highlights → interests"), defaults to Q&A over cloze, and names the
    five `probes/` pathologies (shallow / narrow / wordy / lacks-context
    / solicits-multiple-responses) plus the positive attributes as
    explicit constraints — atomicity foregrounded as the top rule (one
    fact per card; no compound "and"/list/fact-plus-reason cards) with
    the binary Remembered/Forgot grading as the rationale; richness goes
    in separate cards. Then self-contained, unambiguous, deep, concise.
  - **Cleanup.** Removed the now-dead comment-based AI creation path:
    `addAiThreadFromSelection` and the `pendingAiFirst` machinery (its
    only writer) — `renderPrimaryInput` / `commitRootText` lose their
    AI-specific branches. The `@AI`-mention-in-a-comment path (a separate
    surface) is unchanged and still uses the comment-thread `invokeAi`.

- **Paste stamps fresh heading ids (nav pane works on pasted sections).**
  The heading nodes (pocket/hat/block/tag/analytic) carry a stable `id`
  that the nav pane keys expand/collapse, jump-to, and the 1/2/3/4 level
  filter off of — but the schema's `parseDOM.getAttrs` reads only
  `indent`, never `data-id`, so PM's clipboard parser returns pasted
  headings with `id: null`. Drag-copy / dropzone / send-to-speech all
  call `rewriteHeadingIds` to keep ids unique, but paste had no
  equivalent, so pasted pockets/hats/blocks/tags were id-less and inert
  in the destination outline (permanently expanded, un-jumpable, ignored
  by the level filter). `rewriteHeadingIds` couldn't be reused as-is — it
  only rewrites *existing* non-null ids — so `drag-controller.ts` now
  factors the slice walk into `mapSliceIds(slice, predicate)` behind two
  exports: `rewriteHeadingIds` (assign when the node already has a
  non-empty id) and the new `freshHeadingIds` (assign to every id-bearing
  node, filling nulls). The paste plugin gains a `transformPasted` prop
  that runs `freshHeadingIds` — it fires inside PM's `parseFromClipboard`
  before `handlePaste` sees the slice, so the tag/analytic split and
  card-body paths get fresh ids too. The `parseHeadFromHTML` fallback
  (which re-parses the raw clipboard HTML and so bypasses
  `transformPasted`) stamps its reconstructed head directly.

- **Drag-and-drop now jumps to the dropped section like a nav-pane
  click.** Before, every drop path in `drag-controller.ts` ended in
  `tr.scrollIntoView()` over a transaction that never set a selection —
  so PM scrolled to the *default mapped selection* (the pre-drag caret,
  shifted by the move's delete+insert), which only coincidentally pointed
  at the moved content. Two parts to the fix: (1) `buildMoveTransaction` /
  `buildCopyTransaction` capture the first-insert position and end with a
  shared `selectTopOfInsert(tr, insertStart)` helper — `tr.setSelection(
  Selection.near(tr.doc.resolve(insertStart), 1))` — putting the caret at
  the top of the dropped content (its first heading); the cross-view /
  virtual-source (dropzone shelf) path applies the same helper to its
  inline insert transaction. (2) After dispatching the drop transaction
  (no more `tr.scrollIntoView()`), `scrollToDroppedTop(view)` resolves the
  DOM element at the new selection and `preciseScrollIntoView`s it — the
  identical primitive `nav-panel.ts`'s `jumpTo` uses, which re-measures /
  converges (handling `content-visibility: auto` undershoot) and pins the
  heading to the top of the viewport, rather than PM's `scrollIntoView`
  which only guarantees the caret lands somewhere on screen at an
  inconsistent offset. The same-view move path also now `focus()`es the
  source view after dispatch (the cross-view path already did) so PM
  syncs the DOM caret to the transaction's selection — otherwise the
  state selection was correct but the *visible* cursor stayed wherever it
  was before the drag. End result: a drop leaves both the viewport and
  the caret exactly where clicking that heading in the outline would.
  `Selection` is now a value import from `prosemirror-state`;
  `drag-controller.ts` now imports `preciseScrollIntoView`.

- **Nav-pane caret highlight re-applies after the debounced rebuild.**
  `dispatchTransaction` calls `navPanel.setCaretHeading(selection.from)`
  synchronously, but that scans `liEntries`' *cached* positions — which
  only refresh in the debounced `scheduleHeavyUpdate` → `navPanel.update`
  (~200ms). For small edits the drift is harmless (the comment on
  `setCaretHeading` already notes this), but a structural change like a
  drag-move leaves the wrong heading highlighted, and `update()` never
  re-ran the highlight, so it stayed wrong until the next caret movement.
  The heavy-update callback now calls `setCaretHeading(selection.from)`
  immediately after `navPanel.update`, against the freshly-rebuilt
  positions, so the highlight self-corrects. Single-doc path only; the
  multi-pane per-pane nav doesn't track the caret highlight at all.

- **Nav-pane double-click (collapse toggle) no longer relies on the
  native `dblclick`.** A plain nav click's `jumpTo` dispatches a
  selection-only transaction; `dispatchTransaction` then scheduled the
  debounced `scheduleHeavyUpdate` → `navPanel.update()` → `render()`,
  which does `listEl.innerHTML = ''` and rebuilds every `<li>`. Because
  `scheduleIdle` (requestIdleCallback) fires in the idle gap *between*
  the two clicks of a double, the clicked `<li>` was usually gone before
  the second click — and `dblclick` only fires when both clicks share a
  target node, so the collapse toggle silently dropped. (A regression
  since the heavy flush moved from a fixed 200ms `setTimeout` to idle
  dispatch in alpha.1; the multi-pane code even had a comment warning a
  per-keystroke rebuild "would invalidate any dblclick in progress".)
  Two-part fix: (1) the nav pane detects double-clicks itself in
  `onDragUp` — `handlePlainClickDouble(entry)` matches `entry.id` +
  timestamp (`NAV_DOUBLE_CLICK_MS`, 500ms) across two plain clicks and
  toggles via `toggleCollapsed` when the id is in a per-render
  `collapsibleIds` set; keying on the stable id rather than the DOM node
  makes it immune to the `<li>` being recreated between clicks. (2) Both
  `dispatchTransaction`s (single-doc and the multi-pane per-pane view)
  now gate the heavy flush on `tx.docChanged`, so a selection-only jump
  doesn't rebuild the outline at all — killing the mid-gesture re-render
  (and an O(doc) nav rebuild on every cursor move). The native `dblclick`
  listener is removed.

- **Comments column: Docs-like reflow layout.** `comments-ui.ts`'s
  `render()` no longer wipes + rebuilds the card DOM each pass — it
  reconciles a persistent `Map<threadId, element>` (and `fc:<cardId>`
  for flashcards), gated by a content signature so a card is
  re-populated only when its content / active state actually changed
  (the active reply textarea keeps focus + value across unrelated
  renders). A per-card `ResizeObserver` reflows the whole stack whenever
  any card's height changes (expand/collapse, AI text streaming in,
  reply box), and `top` animates (`transition`, suppressed on first
  placement via `pmd-card-settled`) so cards glide around each other
  rather than snapping. Fixes the previous one-shot layout that froze
  positions until the next debounced render. This is the shared layout
  the flashcard cards plug into.

- **Learn: create→review loop over a local annotation layer.** First
  user-facing slice of the spaced-repetition system (SPEC-learn-system).
  Flashcards never enter the document — they live in a per-user
  `LearnStore` (`learn-store.ts`) persisted as a single host KV blob
  (`learn-store-host.ts` → `read/writeLearnStore`), keyed by a stable
  per-document id.
  - **Identity.** A document carries a hidden `cmirDocId`: a `.cmir`
    field and, for `.docx`, a custom document property
    (`docProps/custom.xml`) that survives a real Word round-trip. The
    store splits identity so file-copies share one logical card + one
    schedule while each file keeps its own grounding: `CardDef` +
    `ScheduleEntry` per `cardId`; `CardAnchor` per (`cardId`,`docId`).
    Create Flashcard also stamps the id straight into the on-disk file
    (`stampActiveFileDocId` — reads the file, `stampDocId`, writes back),
    so a card made in a file CardMirror didn't author re-associates on
    reload without a manual save (no-op on web / never-saved docs / files
    that already carry an id).
    The docId is resolved mode-agnostically so single-doc and multi-pane
    behave identically: `index.ts` keeps `activeDocIdentity()` (focused
    `DocRecord`'s `{docId, uid}` or the single-doc globals),
    `ensureActiveDocId()` (mint + rekey the session uid), and
    `setActiveDocId()` (write back, in multi-pane via the
    `setFocusedDocId` shell hook). It's read from the file on open,
    backfilled on save, persisted on every save / autosave / journal
    write (so an autosave never strips identity), restored through crash
    recovery, and forked on a full Save As (`copyDocAnnotations`).
  - **Create Flashcard.** New ribbon command (`createFlashcard`, in the
    Learn group; reachable from the command palette) anchors a card to
    the selection: `buildDescriptor` (`learn-anchor.ts`, Hypothesis-style
    quote+context+position) captures the grounding, `learn-create-ui.ts`
    collects Q&A or cloze content, and the store gets a `CardDef` +
    due-today `ScheduleEntry` + `CardAnchor` keyed to
    `activeAnnotationDocId()`.
  - **Review.** `learn-session-ui.ts` is a full-screen overlay driven by
    `learnStore.queue(scope, today)`. Front → reveal → binary grade;
    grading goes through the Orbit-style scheduler (`learn-scheduler.ts`,
    binary interval ladder, no ease factor) which reports
    `retryInSession`, so a forgotten card is re-queued for later in the
    same session while its schedule is updated and persisted per grade.
    Cloze cards blank `{{deletion}}` on the front and highlight it on the
    reveal.
  - **Home Learn section.** `home-screen.ts` rebuilds from the store (on
    change + each show): "Review all due" + "Manage cards" cards plus a
    per-file / per-deck breakdown of scopes with cards due today, each
    opening a scoped session.
  - **Manage flashcards.** `learn-manage-ui.ts` (the `manageFlashcards`
    command, or the Home button) lists every card grouped by the file
    it's anchored to — built from new store reads `listCards()` /
    `listAnchors()` — with a text filter, a show-suspended toggle, and
    per-card edit (reuses `openCardEditor` with an `initial`),
    suspend/resume (`setSuspended`), and a two-click delete
    (`deleteCard`; native confirm is unavailable in Electron). A **New
    card** action creates a standalone card with no `CardAnchor` (still
    scheduled + reviewable under the 'all' scope). Cards shared across
    files are flagged; an "Unanchored" group collects standalone cards
    and any whose anchor is gone. Each unanchored card has a **link**
    button (new `link` icon): pick a file, and the card gets a
    file-level `CardAnchor` (null text anchor — grounded to text later
    from inside the file). Reading/assigning the file's identity uses
    new package helpers `readDocIdFromBytes` / `stampDocId`
    (`src/docid.ts`) — for a file with no id, one is minted and stamped
    in losslessly (`.docx` via `Docx.load → writeDocId → toBuffer`, no
    content re-render; `.cmir` via a minimal JSON field edit) and written
    back with `saveExisting`, so a future open re-associates. `openCreateFlashcard` was generalized to
    `openCardEditor({ selectedText? , initial? })` to serve both create
    and edit.
  - **In-context (comments column).** Anchored flashcards render in the
    comments column alongside genuine comments. The in-doc highlight is a
    **view-only decoration** (`learn-highlight-plugin.ts`,
    `.pmd-flashcard-range`), never a `comment_range` mark — so a card's
    grounding can't leak into a shared file by construction (no
    serialize-strip needed at any of the ~4 save sites). The plugin maps
    ranges through edits (bias from→right / to→left, matching
    `inclusive:false`) and drops a fully-deleted span. `comments-ui.ts`
    resolves each card's descriptor against the live doc lazily — on
    column open (SPEC §4.2), doc load (`mountView` rAF), multi-pane focus
    switch (`focusSlot`), and any store change while open — via
    `refreshFlashcardAnchors`, hands resolved ranges to the plugin
    (`setFlashcardRangesTr`), and renders flashcard cards positioned by
    those ranges (synthetic `fc:<cardId>` ids merged into the layout
    map). Unresolved cards (foreign edit / linked-but-not-grounded) go to
    a collapsible **"Unanchored (n)"** section pinned at the pane bottom
    (`positionUnanchored`) showing `anchor.quote` + a **Re-ground** button
    (`buildDescriptor` from the current selection → `setAnchor`). Each
    card has Edit / Suspend / Delete. A broken anchor never touches the
    card's schedule or file association (the store is never mutated by
    edit-tracking; "unanchored" is derived from non-resolution).
    Resolution gates on context, not just the quote: `resolveDescriptor`
    scores every quote hit (even a lone one) by how much its surroundings
    overlap the stored prefix/suffix and **rejects** the best (→ null →
    Unanchored) unless it clears `MIN_CONTEXT_FRACTION` (⅓) of the
    available context (`avail = min(prefix,CONTEXT)+min(suffix,CONTEXT)`),
    so a card whose anchored text was deleted unanchors instead of
    grounding onto a coincidental same-words hit elsewhere; one intact
    side clears the bar, and quotes near a doc boundary aren't
    over-penalized. `CONTEXT` is 60 chars each side.
  - Deferred: refreshing a descriptor from its live range on save (§4.2 —
    editing the *quoted text* unanchors on reload; re-resolution covers
    moves, re-ground covers the rest), deck management, and migrating
    Ask-AI threads into the local layer.

- **Command palette: file search (`f` prefix) — a first slice of corpus
  search.** Two on-demand stages, no persistent index yet (see
  ARCHITECTURE.md §11):
  - **File stage.** `f <query>` lists `.cmir` files under the new
    `fileSearchRoot` folder setting via `host:list-cmir-files` (cached —
    see the file-index note below), matched on filename with the same
    token-substring ranking the rest of the palette uses. The listing is
    held for the palette session; an `asyncToken` guards against stale
    list/read results from a prior query or a closed palette. Enter opens
    the file through `openFileByPath` → `routeOpenedFile` (extracted from
    `runOpenFlow`): the cross-window dup guard, then spawn-a-new-window
    (single-doc) or the slot picker (multi-pane), so it never overwrites
    the current window's doc.
  - **Within-file stage.** Tab on a highlighted file reads + `parseNative`s
    it once, runs `extractFile` (new `file-search.ts`), and enters a
    sticky in-file mode (the bar clears, prefix parsing is bypassed, Esc
    restores the prior file query). `extractFile` returns both an
    `outline` (the full pocket→hat→block→tag hierarchy with levels) and
    flat searchable `objects` (the enabled kinds + cites), reusing
    `collectHeadings` + `computeHeadingRange`. An **empty** query browses
    the outline — rendered indented, nav-pane style, in full (no 50-cap),
    cites excluded since they aren't headings; a non-empty query runs the
    flat object search. Insert granularity is whatever
    `computeHeadingRange` gives: tag/cite → the card, block/hat/pocket →
    the heading + its section, analytic → its unit. The parsed doc is
    kept on the in-file state and slices are taken **lazily** on insert
    (`doc.slice(from, to)`, same schema — no eager per-heading slicing or
    JSON round-trip), which also keeps the dive cheap. Inserts go through
    `insertSpeechSlice`, like quick cards.
  - **Collapsible outline.** The browse is collapsible: each pocket/hat/
    block carries a chevron (and the row's right-click toggles), hiding
    its subtree via a single-boundary visibility walk over the flat
    outline. The initial collapsed set is seeded from a new
    `fileSearchOutlineDepth` setting (default 3 = blocks shown, tags
    collapsed), mirroring the nav pane's `navMaxLevel`; collapse state
    lives on the in-file state and survives toggling between browse and
    search within a dive.
  - **Settings.** `fileSearchRoot` (folder), `fileSearchObjectTypes`
    (checklist; default block/tag/cite), and `fileSearchOutlineDepth`
    (Pocket/Hat/Block/Tag segmented control; default Block) under
    General, all Electron-only.
  - **Multi-grab.** Inserting a within-file object keeps the palette open
    and the parsed file in memory, so you can pull several blocks in a
    row (the parse cost is paid once per Tab, not per insert). Toast +
    bar refocus happen in the `afterInsert` hook (after the deferred
    insert's own `speechView.focus()`), and Ctrl/Cmd+Z / Shift+Z / Y are
    routed to the editor's `undo`/`redo` from the bar so a misfire can be
    taken back without leaving it. Other sources still close on insert.
  - **Pinned files — a warm working set.** A small curated set of files
    is kept "warm" (parsed `doc` + extracted objects/outline held in a
    module-level `warmCache` in the renderer) so dives into them skip the
    read+parse and are instant. Two kinds of pins:
    - *Manual* (★ on a file row / **Alt+P** on the selected one): shown
      with a solid star and floated to the top of `f`. Stored in a new
      `pins-store.ts` (localStorage, like `recents-store` — durable +
      cross-window without IPC).
    - *Auto* (silent): recents (top 6) ∪ frequents (used ≥ 2×, top 10),
      capped at 10 total; manual pins are exempt from the cap. Gated by
      the `pinAutoEnabled` setting (default on) for memory-sensitive users.
    The warm cache is keyed by path + `mtimeMs` (carried on `FileEntry`
    from `host:list-cmir-files`) with an `enabledSig` so a change to the
    searchable-object set re-extracts from the cached doc without
    re-parsing. The warm pass — `runWarmPass()`, a module-level function
    shared by the open palette and a proactive boot-time pre-warm — walks
    the effective set sequentially, **yielding to an idle slot
    (`scheduleIdle`) before each synchronous `parseNative`** so a `.docx`
    parse never lands on a keystroke (the renderer defers idle callbacks
    until the user pauses). It runs two ways: `prewarmQuickCardFiles()`
    fires once at boot (scheduled on idle), listing + warming the set
    before the palette is ever opened — so the first search finds files
    already cached rather than parsing on the first keystroke; and the
    open palette re-runs it when its file list loads (with a `keepGoing`
    guard so it bails if the palette closes). Both skip already-fresh
    files and prune rotated-out pins. A dive uses a warm hit when the
    mtime matches, else reads/parses and warms it if pinned. Usage is
    recorded on open + dive (feeds frequents). All renderer-side — no
    main-process store, no parser refactor (see
    reference-docs/SPEC-pinned-files.md).

  - **Cached file index (main process).** `host:list-cmir-files` caches
    the recursive `.cmir` listing — with per-file mtime + size — in
    memory and on disk (`{userData}/cmir-file-index.json`), returning
    instantly and revalidating the tree in the background (coalesced
    per root, rewritten only when it changed). Replaces the per-palette
    directory walk; the stored mtimes set up the future content index's
    reparse-only-what-changed pass. Files now also join the no-prefix
    "search everything" (the scan is kicked off lazily and folded in
    once ready).

- **Fix: palette commands that open a prompt (e.g. New Speech Document)
  did nothing.** The Enter that ran the command bubbled to `document`,
  where the just-opened `promptForText` modal had synchronously
  registered its keydown listener — which caught that same Enter and
  instantly submitted itself with an empty value. The palette's Enter
  now `stopPropagation()`s, so it can't leak into a modal the command
  spawns. (Ribbon buttons were unaffected — a click has no Enter to
  bleed.)

- **Search palette: a settings source (`s` prefix).** The command
  palette gains a fourth source alongside quick cards (`q`), the
  dropzone (`d`), and commands (`c`): settings (`s`), also folded into
  the no-prefix "search everything". `searchSettingsSource` surfaces
  two kinds of rows — the top-level tabs from `CATEGORY_TABS` (opening
  the tab) and every individual setting from `SETTING_METADATA` (opening
  its tab and scrolling to it), ranked by where the query hits the
  label and respecting `electronOnly` so web never offers a row that
  won't render. Selecting a settings row calls a new
  `openSettings(target)` overload; `SettingsModal.open` then activates
  the target tab and `revealSetting` scrolls the row (now tagged with
  `data-setting-key`) into view and runs a one-shot highlight
  animation. Rows carry a `SET` badge.

- **Fix: the save button's icon vanished after the saved-✓ flash.**
  `flashSavedGlyph` swapped the button's `textContent` to `✓` and back,
  which worked when the glyph was text but wiped the new icon `<span>`
  for good once the chrome moved to masked icons. It now snapshots and
  restores the button's inner markup (via a `flashOrigHtml` WeakMap),
  so the floppy-disk icon returns after the flash in both icon modes.

- **Icon system: Untitled UI line icons with a Modern/Classic toggle.**
  The app chrome's glyphs (ribbon buttons, the speech-doc banner,
  dialog close/reset/reorder buttons, status-bar zoom, nav-tree
  chevrons, etc.) were a mix of emoji and Unicode symbols that rendered
  inconsistently across platforms and ignored the theme. They're now a
  single line-icon set drawn from the Untitled UI free icons.
  - **Mechanism.** Each icon is a `<span class="pmd-icon pmd-icon-NAME">`
    painted in `currentColor` via a CSS `mask` whose image is a
    data-URL SVG (so the icon inherits text color and theme for free).
    `scripts/gen-icons.mjs` reads the source SVGs from the gitignored
    `reference-docs/untitled-ui-icons` clone and generates the
    committed `src/editor/icons.css` (the app ships self-contained — no
    SVG files at runtime). The generator's `MAP` pairs each pmd icon
    name with its Untitled UI filename and a classic-fallback glyph.
    `src/editor/icons.ts` exposes `icon(name)` / `setIcon(el, name)` for
    JS-created buttons; static markup uses the span directly.
  - **Toggle.** A new `iconSet: 'modern' | 'classic'` setting (default
    `'modern'`) resolves to a `data-icons` attribute on the document
    root, applied at boot and on change (`applyIconSet` in index.ts,
    alongside the theme/motion appliers). `icons.css` masks the SVG
    under `[data-icons="modern"]`; under `"classic"` it drops the mask
    and renders the original emoji/text glyph via `::before`, releasing
    the fixed 1em box so wide emoji size and center exactly as the old
    text nodes did. The setting lives under Appearance as a two-button
    segmented control parallel to the theme picker.
  - **Licensing.** Untitled UI's free icons are © Untitled UI, used
    under their free license (not MIT, despite the upstream package's
    metadata). Attribution and the license terms are recorded in a new
    `THIRD-PARTY-NOTICES.md`, referenced from `LICENSE` and the README;
    the generator/CSS headers point there too. The upstream `.svg`
    files and the set as a whole stay in the gitignored reference clone
    and are not committed — only the specific glyphs the app uses are
    baked into `icons.css`.

- **Dropzone moved to the editor's bottom-left corner.** It used to be
  pinned at the bottom of the nav pane, where dragging onto it landed
  in the outline list's auto-scroll zone and scrolled the outline.
  Now a SINGLE `DropzoneController` is mounted at boot (index.ts) into
  `document.body`, `position: fixed`, with `positionDropzone()`
  anchoring it to the editor element's live rect — `#app` in
  single-doc (so it tracks nav-width / status-bar / nav-hidden), the
  leftmost visible `.pmd-pane-body` in multi-pane. Repositioned on
  window resize + a `ResizeObserver` on `#app` + after the multi-pane
  shell mounts. `getFocusedView` now resolves via `getActiveView()`.
  Removed the per-nav-panel `installDropzone` (was one pill per
  nav-pane) and the nav-list's bottom-padding reserve.
  - **Scroll runway under the pill.** The pill floats over the editor's
    bottom-left, covering content there with no way to scroll it clear at
    the doc's end. The fix is a fixed `padding-bottom: 4.5rem` on the
    editable (`#editor .ProseMirror`), gated on
    `html:not(.pmd-dropzone-pill-hidden)` (single-doc) — this extends the
    doc content's own height, the same thing that drives `#app`'s scroll
    for any long doc, so the last line scrolls clear of the pill. (Earlier
    attempts — padding the flex item `.pmd-editor-row`, a JS-measured
    `--pmd-dropzone-runway`, and a dedicated spacer flex child of `#app` —
    didn't reliably extend the scroll area; padding the content does.)
  - **Palette gating.** The command palette's dropzone source (`d`
    prefix, its empty-state hint, and inclusion in "search everything")
    now appears only when the dropzone is on (`showDropzonePill`); typing
    `d ` while it's off shows an "it's off" hint instead.

- **Bulk convert utility (desktop).** Home-screen button in its own
  labeled "Convert" group beside the Quick Cards group (shown only when
  `getHost().kind === 'electron'`), opening `bulk-convert-ui.ts`'s
  modal. Two toggles — direction (`.docx`→`.cmir` / reverse) and output
  (loose files vs a single `.zip`) — both written into a chosen
  destination folder. Separate input (file / folder) + destination
  pickers, with the chosen paths shown and a Convert button enabled
  once both are set; changing direction clears the picked input.
  - Conversion (`convertBytes`): docx→cmir = `fromDocxFull` →
    `serializeNative`; cmir→docx = `parseNative` → `toDocx`. Threads
    (comments) preserved.
  - Both output forms write into the destination via `writeFileAtPath`:
    loose files keep the input's relative subfolder structure (swapped
    extension); a zip is written as `<inputName>.zip`. File input uses
    `host.openFile` (scoped to the source ext); folder input is recursed
    via the new `host.listFilesRecursive(dir, ext)`, each file read,
    converted, then written / added to a JSZip; failures counted, not
    fatal.
  - New main IPC + host methods: `host:list-files-recursive` (recursive
    `readdir` by extension) and `host:write-file-at-path` (now mkdir-ps
    the parent so nested + destination writes work).
  - The modal's Escape handler (a capture-phase `document` keydown)
    `stopPropagation()`s so closing the dialog doesn't also reach the
    home screen's bubble-phase keydown and dismiss Home underneath it.

- **Quick Cards — store foundation (no UI yet).** First slice of the
  Quick Cards feature (see `reference-docs/SPEC-quick-cards.md`): a
  persistent, cross-window library of reusable rich-text snippets.
  - `src/editor/quick-cards-store.ts` — dual-backend reactive store
    (`quickCardsStore`) mirroring `dropzone-store.ts` but persistent.
    `QuickCard` shape: id (UUID), name, tags, `contentJson`
    (`Slice.toJSON()`), denormalized search keys
    (`nameLower`/`tagsLower`/`textLower`), `sourceName` provenance,
    created/updated (epoch ms). API: `init` / `list` / `byId` /
    `upsert` / `importMany` / `remove` / `clear` / `subscribe`, plus
    `normalizeTag` + `tagSetKey` helpers for the (forthcoming)
    duplicate-name-only-if-tags-differ rule. Electron backend reads
    main + subscribes to `quick-cards:changed`; web backend uses
    `localStorage` (persists across sessions, unlike the dropzone's
    sessionStorage) + a `storage` listener.
  - Host layer: `quickCardsList/Upsert/BulkUpsert/Remove/Clear` +
    `onQuickCardsChanged` on `ElectronHost` (+ a local `QuickCardIpc`
    type) and the preload bridge.
  - Main process (`apps/desktop/src/main.ts`): authoritative
    `quickCards` array persisted to `{userData}/quick-cards.json`
    (lazy load, atomic tmp→rename writes serialized on a write-tail,
    same discipline as the journal) and broadcast to every window on
    mutation. New IPC: `host:quick-cards-list/upsert/bulk-upsert/
    remove/clear`.
  - Boot: `quickCardsStore.init()` runs at renderer startup so every
    surface reads one cache.

- **Quick Cards — Add surface.** Second slice: capture the current
  selection as a named, tagged quick card.
  - New `addQuickCard` ribbon command (unbound by default; in the new
    "Quick Cards" `RIBBON_GROUPS` entry, so bindable via Settings →
    Keybindings). Registered through the full pipeline (union, ids,
    label, empty default key, `RibbonContext` + stub, `commandFor`).
  - `runAddQuickCard` (index.ts): requires a non-empty selection
    (toast otherwise); pre-fills the name with the **smallest enclosing
    heading** via `smallestEnclosingHeadingText` (nearest preceding
    block → hat → pocket — that nearest heading IS the smallest
    enclosing one); opens the dialog; on confirm builds the card from
    the selection slice (`slice.toJSON()` + plain-text key) and
    `upsert`s it. `sourceName` = the active filename (provenance).
  - `quick-card-add-ui.ts`: promise-based modal (Save As scaffolding)
    with a name field + a tag chip-input (commit on Enter/comma,
    remove via × / Backspace, suggestions drawn from existing tags).
    Enforces the **(name, identical tag-set)** uniqueness rule through
    an inline validator (`findDuplicate`); a name may repeat only if
    its tags differ.
  - Store helpers added: `buildQuickCard`, `distinctTags`,
    `findDuplicate`. CSS: `.pmd-qc-add-*`.

- **Quick Cards — Manage overlay.** Third slice: a full-window
  master/detail surface (`quick-cards-manage-ui.ts`, `quickCardsManageUI`).
  - List (left): every card with name, tags, source file; filter box
    (multi-token substring over name/tags/text), sort (recently
    updated / name / source), per-row checkbox for multi-select →
    bulk Export / Delete.
  - Detail (right): edit name + tags (chip input reusing the Add
    dialog's `.pmd-qc-add-*` classes) and content in an **embedded
    `EditorView`** (shared `schema` + `buildEditorPlugins()`,
    dynamic-imported from index.js to dodge the import cycle). The
    editor is seeded by inserting the stored slice into an empty doc
    (`replaceSelection`, robust for open/inline slices); Save extracts
    it back via `slice.toJSON()` + a trailing-empty-paragraph trim,
    re-checks the (name, tag-set) uniqueness rule (`findDuplicate`,
    excluding self), and `upsert`s. Delete removes.
  - Export (selected or all) / Import via the host file pickers as
    **plain JSON** (`{version,cards}`); import re-mints ids ("import as
    new", never overwrites). No custom extension.
  - Live-syncs from the store while open, but **preserves an
    in-progress edit** — an external library change re-renders the
    list but only rebuilds the detail editor when nothing is unsaved
    (and resets only if the open card was deleted).
  - Entry points: the 🗂️ Manage ribbon button (was a stub) and a new
    **Quick Cards** section on the Home screen (below Recent, above
    the forthcoming Learn section). CSS: `.pmd-qc-manage-*`.
  - Known v1 limitation: the embedded editor uses base ProseMirror
    styling (it's not under `#editor`, so per-style size/font
    variables don't cascade) — content is fully editable, just not a
    pixel match for the main editor.
  - Re-entrancy fix: every Electron mutation fires the store
    subscription twice (optimistic + main broadcast echo); with the
    detail's editor mount being async (dynamic import), two renders
    interleaved and double-appended the footer (and left stale DOM).
    `renderDetail` now appends all DOM (incl. footer) synchronously and
    guards the async editor mount with a `renderSeq` token, so stale
    mounts are discarded.
  - The Add dialog now offers **"Open it"** on a duplicate (same name +
    identical tags): `openQuickCardAdd` takes `findConflict` +
    `onOpenConflict`, the latter opening the Manage overlay at that card
    (`quickCardsManageUI.open({ selectId })`).
  - Ribbon: a 2×2 Quick Cards cluster (`#quickcards-stack`) between the
    speech stack and the formatting panel, shown in both single- and
    multi-doc (unlike the speech stack). Buttons: 🔍 Search · 🏷️ Tag
    Picker (top), 🗂️ Manage · ➕ Add (bottom). `mousedown`
    preventDefault on all four preserves the editor selection. CSS
    `.ribbon-quickcards-stack` mirrors the speech stack.

- **Quick Cards — Search palette + Tag Picker (feature complete).**
  - `quick-cards-match.ts`: pure Block-Search matcher
    (`searchQuickCards`) — order-independent multi-token substring AND,
    scoped by the active-tags filter (`isInScope`: empty filter = all;
    else ≥1 active tag; untagged always in scope), two-tier (name
    matches, then content-only matches with a ~40-char snippet of the
    matched region). Name tier ordered by first-token position then
    recency; content tier by recency.
  - `quick-card-search-ui.ts`: the floating palette (`quickCardSearchUI`)
    — centered over the target pane, pinned bottom, results ABOVE the
    bar; input focused synchronously; one-shot blue pulse
    (`pmd-qcs-pulse`, auto-suppressed by the reduce-motion rule);
    live search; ↑/↓ nav, Enter = insert at cursor, Alt+Enter = at
    end, Tab = inline tag filter, Esc/click-away to close; keyboard
    hints footer; no-editable-target → toast, no insert. Insert
    reuses `insertSpeechSlice` with the new mid-text-confirm option
    gated on `quickCardSkipMidTextInsertConfirm`. Also exports
    `openQuickCardTagPicker` (the ribbon 🏷️ dropdown) — both it and
    the inline Tab filter edit the global `quickCardActiveTags` setting.
  - `insertSpeechSlice` gained a 5th `midTextConfirm: { enabled,
    message? }` param (defaults preserve speech-doc behavior).
  - Command `openQuickCardSearch` (`Mod-Shift-Space`), registered +
    view-less (opens browse-only with no doc). 🔍 and 🏷️ ribbon
    buttons wired (were stubs); ➕ Add unchanged.
  - Settings: `quickCardActiveTags` (the global tag filter; edited via
    the Tag Picker, not a settings row) and
    `quickCardSkipMidTextInsertConfirm` (Editing tab, default off).
  - Prefix system (first slice of the eventual full set): `parsePrefix`
    splits a leading `q `/`d `/`c ` off the query. `q ` searches quick
    cards, `d ` the dropzone, `c ` **commands** (`searchCommandSource`
    — multi-token substring over `RIBBON_COMMAND_LABELS`, showing the
    command's current keybinding; activating runs it via the new
    `runRibbonCommandById` passed in as `opts.runCommand`, which is
    view-less-aware). No prefix searches EVERYTHING (cards + dropzone +
    commands) but shows nothing until the user types. Results are a
    unified `PaletteResult` (source badge QC/DZ/CMD); quickcard/dropzone
    insert their `sliceJson`, commands run their `commandId`.
  - Re-triggering the open hotkey while open toggles the palette
    closed. The bar sits higher (`bottom: 6rem`) and its width clamps
    to the target pane (`min(540, paneWidth − 24)`, floor 240) so it
    shrinks gracefully in narrow / multi-pane windows; hints wrap.
  - The tag picker (inline + ribbon popover) is keyboard-navigable:
    auto-selects the best match, ↑/↓ move, Enter toggles, Tab /
    Shift-Tab / Esc return to the query.

- **Select Current Heading / Copy Current Heading commands.** Two new
  ribbon commands (`selectCurrentHeading`, `copyCurrentHeading`) that
  reuse the send-to-speech / send-to-dropzone cursor→bounds logic.
  Refactored that logic in `speech-doc-send.ts` into a shared
  `enclosingStructureRange(doc, $pos)` (the enclosing `card` /
  `analytic_unit` / heading + everything up to the next
  equal-or-shallower heading), with two callers:
  `resolveSendRange` (selection if non-empty, else the enclosing
  structure — unchanged send-to-* behavior; `resolveSendSlice` slices
  over it) and `resolveCursorStructureRange` (always the cursor's
  structure, **ignoring any selection**, keyed off `selection.$head`).
  Select/copy use the latter — a pre-existing selection is irrelevant
  to them (re-selecting it is a no-op, and Ctrl+C copies it). Select
  dispatches a `TextSelection.between(from, to)` (+ `scrollIntoView`,
  refocus); Copy serializes the range's slice to HTML + plain text and
  writes the clipboard without disturbing the selection (same
  serialization the nav pane's copy-heading uses). Source-only
  operations on the focused `view`, so no multi-doc routing. Registered
  through the full pipeline (id union, `RIBBON_COMMAND_IDS`, labels,
  `DEFAULT_RIBBON_KEYS` empty = unbound, `RibbonContext` + stub,
  `commandFor`, `RIBBON_GROUPS` "Editing utilities"); rebindable via
  Settings → Keybindings.

- **Fixed: large `.docx` files failing to import with "Entity
  expansion limit exceeded: N > 1000".** `src/ooxml/parse.ts`
  configures `fast-xml-parser`, whose entity-expansion guard (added
  in the 4.5.x security hardening) defaults to
  `maxTotalExpansions: 1000`. That counter increments per match for
  *every* entity replaced — including the standard XML entities
  (`&amp; &lt; &gt; &quot; &apos;`) — cumulatively across the whole
  `document.xml`, reset only per parse. Large debate docs blow past
  1000 standard entities easily, so the parse threw before the
  importer ever ran (no ProseMirror involvement — this is upstream
  of the editor entirely). Fix: pass `processEntities` as an object
  with `maxTotalExpansions: Infinity` / `maxExpandedLength: Infinity`.
  Safe because (a) standard entities and numeric char-refs are 1:1,
  non-recursive — no exponential blow-up — and (b) the real
  billion-laughs vector is DOCTYPE-declared nested custom entities,
  which OOXML never emits (and the depth / size / count guards for
  those remain at their defaults). We also only ever open trusted
  local files.

- **Save As dialog reorganized around presets.** The dialog body
  now reads top-to-bottom: a **Name** section
  (`buildFileNameSection`) → a **Format** section
  (`buildFormatSection`) → a **Save** heading → preset buttons → a
  divider → the **Custom Save** section → a divider → Cancel
  (right-aligned).

  - Three presets — a three-column grid (`.pmd-save-as-presets`),
    each cell (`.pmd-save-as-preset`) a primary (blue) button
    (`.pmd-save-as-preset-btn`) over a caption
    (`.pmd-save-as-preset-sub`) — each call `confirmWith(opts)` with
    a fixed content configuration and save immediately using the
    name + format above: **As-Is**
    `{comments:true, analytics:true, undertags:true}`, **Send Doc**
    `{comments:false, analytics:false, undertags:false}`, **Read
    Doc** `{…false, readMode:true}`.
  - The previous read-mode checkbox (and its mutual-exclusivity
    logic that disabled the other boxes when checked) is removed;
    `readModeBox` is gone. Read-mode export is now reachable only
    via the Save Read Doc preset.
  - The Custom Save section keeps the comments / analytics /
    undertags checkboxes and gains a left-aligned **Save Custom**
    submit button (`.pmd-save-as-custom-save`) directly below them;
    the form's submit handler routes through `confirmWith` with the
    live checkbox state and `readMode:false`.
  - `SaveAsResult` is unchanged, so the save pipeline downstream
    needed no edits — only how the four flags get chosen.
  - Preset filename prefixes: the Send Doc / Read Doc presets pass a
    `SEND_` / `READ_` prefix to `confirmWith(opts, prefix)`, which
    prepends it to the (extension-normalized) file name when the new
    `prefixPresetSaveFilenames` setting is on (default; General tab).
    As-Is and the Save Custom submit pass no prefix. The prefix lands
    in `SaveAsResult.filename` like any other name, so nothing
    downstream special-cases it.
  - Derived exports don't rebind the working doc's identity:
    `runSaveAsFlow` now computes `isFullSave = includeComments &&
    includeAnalytics && includeUndertags && !readMode`. Only a full
    save calls `commitSaveResult` (name/handle/format adopt) +
    `markCurrentDocClean` + `multiDocNotifyFocusedSaved` +
    `clearJournalForActiveDoc`. A content-dropping save (Send/Read
    presets, partial Custom) instead just `recordRecent`s the
    exported file and leaves the working doc's name, dirty flag, and
    journal intact — fixing the bug where the open doc adopted the
    `SEND_`/`READ_` name and the duplicate-open guard then refused to
    reopen the export. The crash-recovery Save-As path
    (`reserializeJournalAs`) was already full-fidelity-only and
    doesn't rebind identity, so it's unaffected.

- **Home / start screen (single-doc mode).** A full-window hub
  shown on launch-with-no-file, on closing the current doc
  (Ctrl+W), and via a new Home button (🏠) at the left of the
  ribbon. Offers New document / New speech document / Open and a
  recently-opened-files list.

  Architecture:
  - `home-screen.ts` — the overlay view. Toggled via the
    `pmd-home-active` class on documentElement, which CSS uses to
    hide the ribbon / nav / editor / status bar and reveal
    `.pmd-home-screen`. The editor stays mounted underneath
    (home is an overlay, not a separate route), so showing /
    hiding is a pure visibility flip. When opened over a live
    doc (Home button) a "Back to document" affordance + Esc
    dismiss it; on launch / close-doc there's a fresh blank
    behind it and no back affordance.
  - `recents-store.ts` — localStorage-backed recent-files list
    (newest first, capped at 12, de-duped by path). Persists
    across restarts; shared across same-session Electron windows.
    Each entry stores the path handle (a string on Electron),
    filename, format, timestamp. Recorded on every in-place
    open and on save (so Save-As of a new doc registers it).
  - New `host:read-file-at-path` IPC (+ preload + electron-host
    wrappers) reads a file at a known path without a picker, for
    the "open recent" flow. Returns null on missing / unreadable
    so the home screen prunes the stale entry.
  - `index.ts` wiring: home actions load IN-PLACE (this window),
    distinct from the ribbon's New/Open which spawn windows.
    `loadFileInPlace`, `pickAndLoadInPlace`, `openRecentInPlace`,
    `createSpeechDocInPlace`, and `mountFreshBlankDoc` share the
    mount + state-reset + recents-record + home-hide steps.
    `initSingleDocBoot` shows home (over the blank starter) when
    it's the first window with no file; recovery + open + the
    spawn-payload path all hide home when they mount real content.
  - Close behavior: the `closeDocOrWindow` command (Ctrl+W) in
    single-doc now routes to `handleCloseDocToHome` — confirm
    unsaved, then mount a fresh blank + show home — instead of
    closing the window. The OS close button (`onCloseRequest`)
    still calls `handleUserCloseRequest` and actually closes, so
    quitting is unaffected; Ctrl+W from home (no doc) also falls
    through to the real close.
  - Web: recents render but `handle` is null (FileSystemFileHandle
    isn't JSON-serializable), so those rows are disabled with a
    tooltip. A future pass could persist handles via IndexedDB.

- **Formatting panel grid columns now share equal width.**
  `.ribbon-formatting-panel` had `grid-template-columns:
  repeat(3, auto)`, which sized each column to its widest
  occupant. With column-major DOM order
  (Pocket-Tag / Hat-Block / Analytic-Undertag), the three
  columns ended up roughly 56px / 49px / 70px wide. When
  style-preview was off (every button has the same 1px gray
  border), the eye picked up the column-width asymmetry as
  inconsistent gaps even though the CSS column-gap was a
  uniform 3px throughout. (Style-preview on hides the
  asymmetry visually by giving Pocket a heavy colored border
  that dominates the eye's reference points.)

  Fix: switch to `repeat(3, 1fr)` — equal-width columns sized
  to the widest occupant's max-content. All buttons now sit at
  the same width, so Pocket → Hat and Hat → Analytic
  center-to-center distances are identical regardless of
  `formattingPanelMode` (labels / shortcuts / both) or
  `formattingPanelPreview`.

- **Ribbon panel column gaps normalized to 3px across the
  board.** An audit found two outliers among the ~10 ribbon
  panels: `.ribbon-color-panel` used `gap: 2px 4px` (claimed
  intentional for split-button readability) and
  `.ribbon-format-menu-panel` used a uniform `gap: 2px`, while
  every other panel used `gap: 2px 3px`. Both are now `gap: 2px
  3px` so adjacent buttons sit at the same visual rhythm
  regardless of which panel they live in. Row gaps were
  already a uniform 2px and are unchanged. The ribbon overflow
  buffer (which measures `column-gap` from a sample panel)
  picks up the new value automatically.

- **Application menu bar restructured + accelerators tracked
  to live keybindings.** `buildMenu()` in `apps/desktop/src/main.ts`
  used to emit a static template with hardcoded `CmdOrCtrl+O`,
  `CmdOrCtrl+S`, etc. The Help menu had three diagnostics-only
  entries; the Window menu was Electron's default `role:
  'windowMenu'`; the View menu's Zoom In / Out / Reset used
  Electron's native `role: 'zoomIn'` etc., which triggered
  Chromium's page-zoom rather than CardMirror's `chromeScale*`
  ribbon commands. The File menu's New Document carried a
  hardcoded `CmdOrCtrl+Alt+N` even though the ribbon command's
  default key is `Mod-n` on Electron.

  Restructure:
  - File → Open, New, Save, Save As, separator, Toggle
    Autosave, separator, Close, Quit (Linux / Windows only).
  - New **Speech** submenu between File and Edit: New Speech
    Document, Mark / Unmark Active as Speech Doc, separator,
    Send to Speech (At Cursor), Send to Speech (At End),
    separator, Select Speech Doc….
  - Edit: explicit submenu instead of `role: 'editMenu'` so we
    can override Redo's accelerator to `CmdOrCtrl+Y` (Electron's
    default is `CmdOrCtrl+Shift+Z`). Both chords still fire
    redo via the renderer's `keymap({ 'Mod-y': redo, 'Mod-Shift-z':
    redo })`.
  - View: reload / forceReload / toggleDevTools kept; the three
    Zoom items now dispatch our `chromeScaleReset / Up / Down`
    ribbon commands with accelerators sourced from the
    renderer-pushed binding map; togglefullscreen kept.
  - Window: removed entirely.
  - Help: Settings, Keyboard Shortcuts, separator, Check for
    Updates, Open Crash Dumps Folder, Copy GPU Info.

  Accelerator sync: new `host:set-menu-bindings` IPC. Renderer
  collects `primaryKeyFor(id, ribbonKeyOverrides)` for every
  menu-bound command in a `NATIVE_MENU_COMMANDS` array and pushes
  the map after every settings change (alongside applyBodyFont /
  applyUiFont in applyAll). Main stores the map in a
  `menuBindings: Record<string, string | null>` module variable
  and re-runs `Menu.setApplicationMenu(buildMenu())`. The
  template helper `menuAccelerator(commandId)` converts the
  PM-keymap string ("Mod-o", "Shift-Mod-s", "Ctrl-ArrowLeft")
  to Electron's accelerator form ("CmdOrCtrl+O",
  "Shift+CmdOrCtrl+S", "Ctrl+Left") via the new
  `pmKeyToAccelerator(key)` translator.

  Menu-command routing: the renderer's `onMenuCommand` switch
  in `index.ts` learned a default branch that runs any
  recognized `RibbonCommandId` through `runRibbon(...)`. Means
  the Speech / View / Help / Toggle-Autosave menu items don't
  need bespoke cases — they all flow through the same single
  implementation as ribbon-button clicks and keyboard shortcuts.

- **Select Speech Doc modal.** New
  `src/editor/select-speech-doc-ui.ts` opens a centered overlay
  that lists every open document across every CardMirror
  window. Each row shows the filename (or "Untitled"), the
  owning window's title (or "this window" when in the caller's
  own window), and a "current speech doc" tag with a microphone
  glyph when applicable. Clicking a row that's NOT the current
  speech doc calls `host.speechSet(uid)`; clicking the current
  speech doc clears it (`speechSet(null)`). Both paths close
  the modal. A dedicated "Clear speech doc designation" footer
  button surfaces the unset path more discoverably (greyed out
  when no speech doc is set). Esc and click-outside close.

  Cross-window data path:
  - New `host:doc-info-update(uid, info)` IPC — renderer pushes
    `{ filename }` for a registered uid. Called from
    `updateWindowTitle` (single-doc) and from
    `setFocusedFilename` / `setFocusedFile` plus the
    `registerView` site (multi-pane shell), so the map stays
    fresh as docs mount, save, save-as, rename.
  - New `host:list-docs()` IPC — returns every entry in the
    main-process `docOwners` map, enriched with the cached
    filename, the owning window's id + title, whether it's the
    current speech doc, and convenience flags for "is this the
    caller's own window" / "is its window focused."
  - Existing `host:speech-set` / `speech:changed` infrastructure
    drives the actual designation flip. The modal doesn't
    refocus the picked doc's window — picking is a designation-
    only operation per the user spec.

  Theming: `--pmd-c-speech-bg / -border / -text` tokens drive
  the header and the current-speech-doc row so the gold theming
  stays consistent with the speech banner and other speech-
  flavored UI elements.

  Command wiring: new `selectSpeechDoc` ribbon command (added
  to RibbonCommandId, RIBBON_COMMAND_IDS, RIBBON_COMMAND_LABELS,
  DEFAULT_RIBBON_KEYS with empty default, RibbonContext, and
  the ribbon-groups Speech section). `commandFor` routes it
  through `ctx.selectSpeechDoc()`; `index.ts` binds that to
  `openSelectSpeechDocModal()`.

- **Dropzone shelf — cross-window scratch space for dragged
  content.** Floating bubble pinned to the bottom of every nav
  pane; absorbs any drag from the existing `drag-controller`
  (nav-pane headings, editor surface card/analytic drags) and
  exposes the absorbed items via a click-to-open popover where
  each row is draggable back out into the editor or nav pane.
  Items are shared across every CardMirror window in the same
  session.

  Architecture:
  - **Store** (`src/editor/dropzone-store.ts`) — backend-agnostic
    cross-window state. In Electron, mutations flow through new
    `host:dropzone-{list,add,remove,clear}` IPCs; main holds the
    list in a module variable and broadcasts `dropzone:changed`
    on every change. In web, the store falls back to
    `sessionStorage` (single-window but survives the in-tab
    reload that the multi-pane mode toggle triggers).
  - **Drag-controller extension** (`drag-controller.ts`) —
    `DragItem.prebuilt?: Slice` lets a session carry a slice
    that wasn't sliced from any view's doc; `DragSession.virtual`
    marks the session as having no real source location; new
    `DropTarget.absorb?` callback lets a surface act as a shelf-
    style sink instead of inserting into a view. `commit()`
    routes through `absorb` first when present, falls through to
    the standard cross-view insert path otherwise.
  - **UI** (`src/editor/dropzone-ui.ts`) — one
    `DropzoneController` per nav-pane (so each multi-pane slot
    has its own bubble; they all share state via the store).
    Registers a `DragSurface` whose hitTest returns the bubble's
    bounding rect and whose `absorb` extracts each session
    item's slice (or uses `item.prebuilt` for virtual sessions),
    derives a label, and pushes to the store. The popover's
    rows watch pointerdown + threshold-crossing pointermove to
    start a `virtual` drag session via
    `dragController.begin({...virtual: true})`; the existing
    controller pipeline routes the drop through the normal
    surfaces.
  - **Styling** uses `--pmd-c-drop`, `--pmd-c-drop-outline`,
    `--pmd-c-drop-tint` — the same blue accent the nav drop
    indicator and editor drop indicator use — so the
    accept-state highlight matches the rest of the drag UI.
    Resting state is a muted grey bubble with the
    `--pmd-c-surface-soft` / `--pmd-c-border-soft` tokens to
    blend into the nav-pane chrome.

  Notes:
  - When the nav pane is hidden via `toggleNavPane`, the bubble
    hides with it — accessible again by re-showing the nav.
  - Drag-out always copies (the source isn't a real view
    location), regardless of whether the user holds the
    copy modifier.
  - Drag-out targeting: the virtual `DragItem`'s level is derived from
    the item's stored `type` (`dropzoneDragLevel`: headings via
    `TYPE_TO_LEVEL`; card / analytic_unit at tag level 4; generic content
    anywhere at 4), so the editor / nav surfaces gate drop indicators the
    same way the native drag does — a block lands only at pocket/hat/block
    boundaries, not inside another block. (At the earlier `level: 0` the
    surfaces gated *all* indicators out, so the drag had no target and
    appeared to vanish; a blanket `level: 4` fixed that but wrongly let a
    block drop inside another block.) The shelf's own `hitTest` returns
    null while a `virtual` session is active, so dropping a shelf item
    back onto the shelf is a no-op rather than duplicating it. (Indicators
    are heading-based, so a doc with no headings only offers the doc-end
    target — click-to-insert still covers that case.)
  - No drag-out-to-other-app yet; the controller's surfaces
    only know about nav-pane and editor-surface drops.

- **Ribbon tooltip system unified behind a controller +
  `ribbonTooltipMode` setting.** Previously, ribbon button
  tooltips were a patchwork: the formatting / cite panel buttons
  re-derived their title from `primaryKeyFor` in
  `applyFormattingPanel` (so they tracked rebinds), the autosave
  and plain-paste buttons set their titles imperatively with the
  shortcut hardcoded into the string, and most other ribbon
  buttons had a static `title="..."` in `index.html` that never
  updated. Dropdown menu items (Doc / Card / Table) had no
  tooltips at all.

  New `src/editor/ribbon-tooltips.ts` exports a
  `registerRibbonTooltip({ el, commandId?, label?, kind? })`
  function. The controller stores targets in an array; every
  call to `reapplyAllRibbonTooltips()` walks the array and
  recomputes each title from
  `(settings.ribbonTooltipMode, settings.ribbonKeyOverrides)`.
  Compose rules:

  | mode       | button                        | menu item        |
  | ---------- | ----------------------------- | ---------------- |
  | `none`     | (no title)                    | (no title)       |
  | `tooltip`  | `Label`                       | (no title)       |
  | `shortcut` | `Shortcut` or empty           | `Shortcut` or empty |
  | `both`     | `Label (Shortcut)` or `Label` | `Shortcut` or empty |

  Menu items never repeat their visible menu-row label; only
  the current shortcut shows up on hover (per user spec).

  Wiring: `index.ts` registers every top-level ribbon button by
  id in one block near the end of init, using
  `RIBBON_COMMAND_LABELS` + the command id to derive the label
  by default and an optional explicit label override for state-
  aware buttons (autosave, plain-paste explainer). The
  formatting-panel loop registers its 10 buttons inline.
  `doc-menu-ui.ts` accepts an optional `commandId` field on
  `DocMenuItem` and registers each matching menu button with
  `kind: 'menuItem'`; the close path unregisters them so the
  controller's array doesn't accumulate stale refs across
  many open / close cycles. `applyFormattingPanel` keeps
  ownership of the visible textContent (label vs shortcut vs
  both, driven by `formattingPanelMode`), but no longer sets
  `title` — the controller handles that. Same for the autosave
  and plain-paste state callbacks (they call
  `registerRibbonTooltip` with the updated state-derived
  label).

  Subscriber hookup: `reapplyAllRibbonTooltips()` is called
  from the settings subscriber's `applyAll` so any change to
  `ribbonTooltipMode` or `ribbonKeyOverrides` flows through
  every registered target in one pass.

  Setting metadata: `ribbonTooltipMode` lives at the top of
  Appearance with `kind: 'ribbonTooltipMode'`, a new
  `buildRibbonTooltipModeEditor` in `settings-ui.ts` (a plain
  `<select>` with four options, default `both`), and
  `sanitizeRibbonTooltipMode` in `settings.ts` to validate
  persisted values.

- **UI font is now configurable via Settings → Accessibility →
  "Interface font."** The chrome was previously pinned to
  `'Calibri', 'Helvetica Neue', sans-serif` in every surface that
  used a font-family override (`body`, plus ~14 redundant
  restatements across `.pmd-settings-dialog`, `.pmd-nav-panel`,
  `.pmd-comments-column`, `.pmd-ai-cite-tooltip`,
  `.pmd-prompt-dialog`, `.pmd-clod-dialog`, `.pmd-recovery-sidebar`,
  `.pmd-save-as-dialog`, `.pmd-reference-dialog`,
  `.pmd-doc-switcher`, `.pmd-timer-panel`, `.pmd-doc-menu`,
  `.pmd-nav-context-menu`, `.pmd-nav-pickup-pill`,
  `#ribbon .formatting-panel-btn`).

  Refactor:
  1. New `--pmd-ui-font` CSS variable on `:root` defaulting to a
     platform system-UI stack (`-apple-system, BlinkMacSystemFont,
     'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`).
  2. Every Calibri-stack `font-family` declaration in `style.css`
     swapped for `var(--pmd-ui-font)`. The font-color glyph
     (`#fontcolor-glyph`'s `'Calibri', serif`) and the four
     monospace stacks (keybinding chips, delimiter samples, code
     blocks, AI prompt) are left alone — those are intentional
     per-element design choices.
  3. New `uiFont` setting (string; `''` = use the CSS default,
     non-empty = override) added to the `Settings` interface with
     `kind: 'uiFont'` and category `accessibility`.
     `sanitizeUiFont` mirrors `sanitizeBodyFont`'s quote / comma
     stripping but allows empty.
  4. `applyUiFont(font)` in `index.ts`: empty value removes the
     inline override on `documentElement` (CSS default applies);
     non-empty sets `--pmd-ui-font` to `"<font>", sans-serif`
     (quoted unless `font` is one of the generic keywords).
     Mirrors `applyBodyFont`'s shape; called from both the
     settings subscriber and the initial-load pass.
  5. New `buildUiFontEditor` in `settings-ui.ts` reuses
     `FONT_GROUPS` and `isFontAvailable` but prepends a "System
     default" sentinel option that resolves to `''`.

- **Settings dialog tab strip now scrolls behind arrow buttons
  instead of overflowing the dialog.** The previous
  `.pmd-settings-tabs` was a plain flex row with no overflow
  handling — labels just spilled past the dialog's right edge
  when the dialog was narrower than the strip's natural width.

  New shape: wrap the existing `<nav class="pmd-settings-tabs">`
  in a `.pmd-settings-tabs-bar` flex container that also holds
  left and right `.pmd-settings-tabs-scroll` arrow buttons.
  The nav itself is `flex: 1 1 auto; min-width: 0; overflow-x:
  hidden; scroll-behavior: smooth` — no native scrollbar, only
  the JS-driven arrows scroll it. The border-bottom and
  horizontal padding moved from the nav to the bar so the
  active-tab border overlay still works and the arrows sit
  flush against the divider line.

  Arrow visibility is driven by a per-render `ResizeObserver`
  on the nav: when `nav.scrollWidth > nav.clientWidth + 1`,
  both arrows show; otherwise both hide via `[hidden]`. Each
  arrow's `disabled` flag toggles based on `nav.scrollLeft`
  (left at 0, right at end). A scroll-event listener on the
  nav re-runs the same updater so the disabled state stays in
  sync as the user scrolls. Click handler calls `scrollBy(±step,
  smooth)` where step is `max(60, clientWidth * 0.6)` — about
  half the visible width, with a 60px floor so it still
  advances at very narrow widths. Observer is held on the
  modal instance and disconnected in `close()` and on each
  new `render()`.

- **Ribbon resizer reserves a column-gap-sized buffer before the
  overflow trigger fires.** `initRibbonResizer` in `index.ts`
  previously used `scrollWidth > clientWidth + 1` as its overflow
  predicate, hiding a panel only after the ribbon's content had
  literally exceeded its available width. The visible artifact:
  just before the next panel hid, the rightmost panel button
  collided with the right-pinned timer button (no visible gap).

  Naïvely subtracting a buffer from `clientWidth` in that
  predicate doesn't work — `.ribbon-center` is `flex: 1 1 auto`,
  so when the ribbon isn't actually overflowing the center grows
  to fill remaining space and `scrollWidth === clientWidth`. The
  buffered predicate would therefore fire unconditionally and
  hide every panel.

  Instead, measure the actual visual gap: take
  `ribbon-right.left − ribbon-left.right`, subtract any visible
  center-section content (the doc-name chip, when shown), and
  trigger when that remaining free space drops below the buffer.
  The buffer itself is read once at init from a sample panel's
  computed `column-gap` (cite-panel / formatting-panel / color-
  panel — all use 3-4px gaps; fallback 4). The un-hide branch
  uses the same predicate, so the trigger is symmetric — panels
  wait one extra gap of growing room before reappearing,
  preventing flicker right at the threshold.

- **Layer 3 trailing-space trim no longer eats a whitespace-only
  selection.** The `trimRangesForFormatting` in
  `ribbon-commands.ts` used to shave one trailing space from
  every range whose last char was a space, regardless of what
  else was in the range. For an explicitly-selected single space
  (or any whitespace-only run), the shave produced an empty
  range and F9 / F10 / F11 / cite / underline / shading all
  no-op'd silently — there was no way to format a deliberately-
  selected trailing space.

  New rule (the spec calls it Rule 3): trim the trailing space
  iff `[from, to - 1]` contains at least one non-space text
  character. Monotonic — when there's word content, exactly one
  trailing space is always shaved; when the range is whitespace
  only, nothing is shaved. New `hasNonSpaceChar(doc, from, to)`
  helper walks text leaves between the positions and short-
  circuits on the first non-space char (per `classifyChar` from
  `word-break.ts`). Considered Rule 2 ("trim iff the char at
  `to - 2` isn't a space"), which lets the user deliberately
  format multi-trailing-space tails after a word — rejected for
  the surprising toggle (adding one more trailing space to your
  selection flips whether the others get formatted). Rule 3 is
  predictable; the rare multi-trailing-space case can be worked
  around by selecting one char past the spaces or by selecting
  just the spaces.

- **AI cite creator now guarantees the cite stands alone in its
  own paragraph.** Refactor of `applyCiteToSelection` in
  `ai/cite-creator.ts` into a (testable) `buildCiteTransaction`
  helper. The existing pipeline still runs first — `tr.insertText`
  to replace the selection, `tr.removeMark` to strip inherited
  boundary marks, per-token `tr.addMark` to apply `cite_mark` to
  the leading "Lastname Date" pieces. After that, two new
  defensive splits: if the surrounding textblock has inline
  content AFTER the cite end (the common bug case — selection
  spanned a paragraph break and the trailing text from the last
  selected paragraph is now joined onto the cite), `tr.split(end)`
  to break out the tail. Symmetric `tr.split(start)` when there's
  pre-cite content in the same textblock. The after-split runs
  first so the start position doesn't need remapping. Both
  wrapped in try/catch — schema-illegal splits (e.g., a second
  tag inside one card) fall back to the inline-cite shape rather
  than crashing. `applyCiteToSelection` now just calls the
  builder and dispatches.

- **Highlight Acronym (Alt+F11) added; Emphasize Acronym
  rebound from Ctrl+F10 to Alt+F10.** New
  `highlightAcronym(activeColor)` in `ribbon-commands.ts`
  mirrors `emphasizeAcronym`'s per-word-first-letter walk: for
  each textblock the selection touches, build a word-class map
  (`isWordChar` from `word-break.ts`), expand the selection
  range to whole-word boundaries, then emit the start position
  of each word inside that expanded range. The selection-expand
  rule and word definition are identical to Emphasize Acronym
  (so `U.S.A.` is three words per the spec, and the command
  marks `U`, `S`, `A` individually).

  Two deliberate deviations from Emphasize Acronym, parallel to
  the differences between `applyHighlight` and `applyEmphasis`:
  (1) no `NAMED_STYLE_SKIP_BLOCKS` gate — highlight is allowed
  in structural textblocks (tags, analytics, pockets, hat,
  block, undertag), matching the F11 toggle's reach; (2) no
  `stripDirectFormattingOnApply` — highlight is additive and
  shouldn't change the marked character's other formatting. The
  apply uses `tr.removeMark(...highlight) + tr.addMark(...
  highlight.create({color}))` per first-letter slot so a new
  active color wins over any existing highlight on those slots
  (parallel to `applyHighlight`'s apply-branch behavior).

  Bindings: `Mod-F10` → `Alt-F10` for Emphasize Acronym, plus
  new `Alt-F11` → Highlight Acronym in `DEFAULT_RIBBON_KEYS`.
  Both stay rebindable via Settings → Keybindings. The Ctrl-F10
  rebinding choice keeps Mod-F10 (which on Win/Linux is
  Ctrl-F10) available for future use; symmetric to Mod-F11
  (Ctrl-F11, Apply Shading) and F11 (Apply Highlight) already
  occupying the highlight column. `ribbon-groups.ts` lists
  Highlight Acronym next to Apply Highlight in the Character
  Styles group so the settings UI surfaces it near its
  conceptual sibling.

- **Viewport-rockets-to-doc-end on paste / F7 fixed by
  changing the absorb-plugin from a wholesale doc replace to
  per-region surgical edits.** Two community reports surfaced
  the same underlying bug: (1) Cumdog: pasting multi-line text
  with an F7-styled tag somewhere above sends the cursor to the
  very end of the doc; (2) Buntin: pressing F7 on a paragraph
  that has any doc-level paragraphs below it does the same.
  Both reduce to the same root cause — the card-body
  absorption rule (an `appendTransaction` plugin that absorbs
  doc-level paragraphs / cite_paragraphs / undertags after a
  card or analytic_unit) was doing the rewrite in a single
  `tr.replaceWith(0, doc.content.size, rebuilt)`. PM's default
  selection mapping treats the deleted range as fully replaced
  and pushes the cursor (with association-right) to the END of
  the inserted content, which for the absorb tr is the end of
  the last absorbed orphan-now-card-body.

  The new shape: walk the doc to find each contiguous
  absorption region (a `card` / `analytic_unit` followed by
  one or more absorbable doc-level siblings), then for each
  region, in a single transaction, perform two surgical steps
  right-to-left so position arithmetic stays valid: (a)
  `tr.insert(cardContentEnd, absorbedBodiesFragment)` to put
  the new bodies inside the card just before its closing
  boundary, and (b) `tr.delete(orphansStart + insertedSize,
  orphansEnd + insertedSize)` to remove the originals from doc
  level. The cursor (typically NOT inside the moved orphans —
  it's in the absorbing card's tag, or somewhere unrelated)
  stays exactly where it was. The existing
  `absorbedDocChildren` helper is retained for tests that
  probe absorb behavior directly. New `findAbsorbRegions`
  function returns the per-region `{ absorbingPos,
  absorbingNodeSize, orphansStart, orphansEnd, bodiesContent }`
  shape that the new appendTransaction consumes.

- **Phantom-empty-tag card on multi-paragraph paste fixed by
  pre-fitting the slice in the paste handler.** Pasting two or
  more paragraphs into a `card_body` that has sibling
  `card_body`s used to bubble PM's slice fit up to the card
  level: the original card split into two cards with the
  second one carrying an empty `tag` and the original
  trailing card_bodies absorbed into it. Root cause: PM's
  `replace`-with-slice fitting can't insert a multi-paragraph
  slice into a `card_body` (whose content rule is `inline*`)
  without splitting, so it lifts the split up until the slice
  fits as siblings — which at the card level requires opening
  a new card, which requires a tag (= empty placeholder tag).

  New `tryPasteAsCardBodies(state, slice)` in
  `paste-plugin.ts` runs after the existing head-detection
  branch in `handlePaste`. When the slice is 2+ top-level
  paragraphs and the cursor's parent is a `card_body` inside
  a `card` or `analytic_unit`, it converts each paragraph into
  a `card_body` of the same content (preserving inline marks)
  and dispatches the replace with the new slice. The cursor's
  containing card now naturally accepts multiple `card_body`s
  as siblings, so the split stays inside the card.
  `openStart` / `openEnd` carry through from the original
  slice so the first body still joins inline with the
  pre-cursor text and the last body still joins inline with
  the post-cursor text — same UX as a single-paragraph paste,
  just with the multi-line break preserved at the card_body
  boundary. Falls through to PM's default for single-paragraph
  slices, slices with non-paragraph top-level children
  (carries / wholesale-card pastes go through the existing
  head-detection branch), and cursors outside the card_body
  context.

- **Copy Last Cite at offset 0 of a paragraph now inserts the
  cite BEFORE that paragraph instead of after.** Community
  report (Cumdog): in a multi-paragraph card with a tag but no
  cite, putting the cursor at the start of the card and
  pressing the Copy Last Cite hotkey lands the cite at the
  start of the SECOND body, not between the tag and the first
  body. Cursor at the END of the tag worked correctly. Root
  cause was in `computeCitePasteLocation` in
  `ribbon-commands.ts`: outside the empty-paragraph branch the
  code always returned `$from.after(paraDepth)` — the position
  AFTER the cursor's containing paragraph. For a cursor at
  offset 0 of the first body, "after the first body" is
  visually where the second body begins, which is where the
  cite ended up.

  Added a new branch: when the cursor sits at `parentOffset
  === 0` of a `REPLACE_IF_EMPTY` paragraph (`card_body`,
  `cite_paragraph`, `undertag`, `paragraph`) that has content,
  return `$from.before(paraDepth)` — the position BEFORE the
  paragraph — so the cite lands at the visual cursor position
  (above that paragraph in the parent's child list). Cursor
  mid-paragraph and end-of-paragraph still fall through to the
  existing `$from.after(paraDepth)` branch. The empty-paragraph
  branch (replace-the-paragraph-with-the-cite) is unchanged
  and still runs first.

- **Ctrl+Up / Ctrl+Down with an active selection no longer
  carries the caret into the adjacent paragraph.** The plain
  (no-Shift) variants now collapse the selection by snapping to
  the start (Up) or end (Down) of the paragraph that contains
  the corresponding selection edge (`$from` for Up, `$to` for
  Down), instead of computing the destination from
  `selection.$head`. Previously, with a selection where the
  head was at the bottom edge, Ctrl+Down ran
  `destNextParaStart` and moved to the NEXT paragraph's start;
  symmetric for Ctrl+Up with head at the top edge running
  `destPrevParaStart`. New `verticalCommandPair` in
  `word-selection-keymap.ts` mirrors the existing
  `horizontalCommandPair` (which handled the Ctrl+Left/Right
  collapse case): when `selection.empty` is false and Shift is
  not held, the move command snaps to the paragraph edge of
  the relevant selection corner and stops. Shift-extend
  variants (`Ctrl-Shift-ArrowUp / -ArrowDown`) keep the
  existing extend semantics by passing through to the base
  command pair.

  Down-side asymmetry: after `Ctrl-Shift-ArrowDown`,
  `selection.$to` lands at `parentOffset === 0` of the
  paragraph BELOW the last visually-selected paragraph
  (`destNextParaStart` walks to the next paragraph's START,
  not the current one's end). A naïve `$to.end()` snap there
  would carry the cursor to the end of a paragraph the user
  never saw as part of the selection. When the down-side
  corner is at `parentOffset === 0`, the fix falls back to
  `prevTextblock(doc, corner.start()).end` — the end of the
  last *visibly* selected paragraph. The symmetric Up case
  doesn't arise via `Ctrl-Shift-ArrowUp` because
  `destPrevParaStart` lands inside the upper textblock (at its
  content-start, not past it), so `selection.$from` is always
  inside the visual selection.

- **Ctrl+Left / Ctrl+Right with a selection now snap to the
  word edge of the corner, not just collapse.** Refines the
  earlier "collapse to selection.from / .to" behavior of
  `horizontalCommandPair` so it matches `verticalCommandPair`'s
  paragraph-edge snap, one notch finer. With a non-empty
  selection and Shift NOT held: take the corner (`$from` for
  Ctrl+Left, `$to` for Ctrl+Right); if the corner is INSIDE a
  word/punct run (left and right flanking chars are the same
  word/punct class), snap to that run's edge via the same
  `prevUnitStart` / `nextUnitStart` iterator the no-selection
  variants use (including the spec's trailing-space absorption
  on the right side); otherwise collapse to the corner. The
  "otherwise" branch is the analog of `verticalCommandPair`'s
  `$to.parentOffset === 0` fallback — when the corner already
  sits at a unit boundary (textblock edge, adjacent to
  space/tab, or at a word↔punct transition), end-of-prev-unit
  and start-of-next-unit are the same position, so the snap is
  a no-op and we just collapse.

  Concrete: select "The" inside "Therefore" → Ctrl+Right lands
  the cursor at the end of "Therefore" (with trailing-space
  absorption if the word has one). After a Ctrl+Shift+Right
  that absorbed past a word's trailing space (head at start of
  the next word), plain Ctrl+Right just collapses there — does
  NOT push further into the next word, matching the analogous
  Ctrl+Shift+Down → Ctrl+Down behavior. Helper
  `isInsideWordOrPunctUnit(map, offset)` does the boundary
  check.

## 0.1.0-alpha.4 — 2026-05-22

- **Layer 2 (keyboard navigation keymap) from the Word-selection
  spec.** New `src/editor/word-selection-keymap.ts` adds bindings
  that override the browser's regex-style word iteration:

  - `Ctrl-ArrowLeft / Ctrl-ArrowRight` (`Alt-` variants for Mac)
    → start of previous / next unit. Walks the textblock's
    per-position class map using `classifyChar` from
    `word-break.ts`, so `don't` is one unit, `U.S.A.` is three.
    Cross-textblock: at offset 0 jumps to the start of the
    previous textblock's LAST unit; at offset == content.size
    jumps to the next textblock's first unit start.
  - `Ctrl-ArrowUp / Ctrl-ArrowDown` (`Alt-` variants on Mac) →
    start of current / next paragraph. Asymmetric: Ctrl+Up has
    an intermediate stop at the current paragraph's start
    (matching Word); Ctrl+Down skips straight to the next
    paragraph with no equivalent stop at the current
    paragraph's end.
  - `PageUp / PageDown` → previous / next heading marker. Same
    shape as Ctrl+Up/Down but using `collectHeadings`'s set
    (pocket / hat / block / tag / analytic from
    `headings.ts:TYPE_TO_LEVEL`). PageUp is asymmetric the same
    way Ctrl+Up is — first stop at the current heading's
    start, then the previous heading on a subsequent press.
  - `Shift-` variants of every move command extend the
    selection (anchor pinned, head moves) so the keymap
    naturally pairs with the mouse state machine.

  The keymap sits ABOVE `baseKeymap` in the plugin list so its
  Ctrl+Arrow / PageUp/Down bindings take precedence. `Home`,
  `End`, `Ctrl+Home`, `Ctrl+End` are deliberately left on the
  browser default — visual-line and doc start/end already match
  the spec.

- **Layer 2 (mouse-selection state machine) from the Word-
  selection spec.** New `src/editor/word-selection-plugin.ts`
  implements the click + drag + shift+click contract:

  - **Single click.** Anchor = a point (the click position).
    Granularity = character, dynamic. Dragging within the
    click's enclosing unit (W0) keeps character granularity
    and the selection is exactly `point..activeEnd`. Dragging
    PAST W0's boundary upgrades to word granularity and pulls
    the rest of W0 into the selection (anchor unit becomes W0
    in full); subsequent extension proceeds by full units.
    Reversing back inside W0 downgrades to character granularity
    and snaps back to `point..activeEnd`.
  - **Double click.** Anchor = the Layer 1 query unit (with
    trailing-space absorption). Granularity = word, fixed.
    Drag extends by bare units (only the initiating click
    absorbs trailing space; subsequent units do NOT). The
    anchor unit stays fully selected even when the drag
    reverses direction.
  - **Shift+click.** Same operation as drag: moves the active
    end under the current anchor + granularity. After a
    double-click, shift+click extends by word. After a single
    click, follows the dynamic single-click rule. Shift+
    double-click and shift+triple-click are no-ops per spec.
  - **Triple click.** Anchor = the containing textblock range,
    granularity = paragraph (fixed). Drag extends one whole
    paragraph at a time; the anchor paragraph stays fully
    selected when the drag reverses. Shift+click after a
    triple-click extends paragraph-by-paragraph — same
    mechanism as the drag.

  The earlier `triple-click-drag-plugin.ts` has been removed —
  its drag-extension logic is folded into the unified state
  machine, and dispatches now carry the
  `pmd:word-selection-plugin` meta so the `apply` hook doesn't
  treat them as external selection changes (which would have
  invalidated the freshly-set paragraph anchor before the next
  shift+click could read it).

  The plugin tracks a module-level `currentAnchor` so shift+
  click after a gesture remembers granularity. An external
  selection-changing transaction (typing, arrow keys,
  programmatic dispatch) marks the anchor stale via a
  `selectionSet`-watching `apply` hook; the next shift+click
  rebuilds a fresh point anchor from PM's
  `selection.anchor`. Dispatches set a
  `pmd:word-selection-plugin` meta on each transaction so we
  can tell ours apart from external ones.

  Atom inline-nodes (images) skip the plugin so PM's default
  NodeSelection still fires on image clicks. `event.preventDefault()`
  on mousedown blocks the browser's default focus transfer in
  the no-op-selection case (single-click at an existing caret
  spot); `view.focus()` is called explicitly to compensate.

- **Layer 1 (word-break iterator) + Layer 3 (formatting trim)
  from the Word-selection spec.** Spec lives at
  `~/Downloads/word-selection-behavior.md`; this commit lands
  the first two of three layers (Layer 2 — custom mouse +
  keyboard selection gestures — comes later).

  New `src/editor/word-break.ts` is the single source of truth
  for what counts as a word. Three-class scheme: word-character
  (letters, digits, `'` U+0027, `'` U+2019), space (U+0020 +
  Unicode whitespace, excluding tab), tab (atomic, never
  groups), punctuation (everything else, including `'` U+2018,
  `_`, `-`, em / en dashes, `.`, `,`, `:`, `;`, `…`). Four base
  units (word, punctuation, space, tab) with asymmetric
  trailing-space absorption: querying a word OR punctuation
  unit extends to include any immediately-following space unit,
  but querying a space unit does NOT reach backward. Tab never
  absorbs. Implementation uses Unicode-aware character classes
  (`\p{L}\p{N}`) so non-ASCII letters and digits are word
  characters; surrogate pairs fall through whichever class
  their first code unit suggests.

  Both pre-existing word-iterators have been replaced:
  `wordRangeAtCursor` in `ribbon-commands.ts` (used by the F7
  Emphasis, F8 Cite, F10 Emphasize Acronym word-expansion
  fallback) and `isWordChar` in `find-replace-plugin.ts` (used
  by the whole-word Find toggle) both call into the new
  iterator. Behavioral consequences: whole-word Find treats `_`
  as a boundary now (`\w`-style regex matched it as a word
  char), F10 Emphasize Acronym on "U.S.C.P." emphasizes
  U / S / C / P instead of just the leading U, and so on.

  Layer 3 lands as a `trimRangesForFormatting(doc, ranges)`
  helper in `ribbon-commands.ts` and a
  `getOperatingRangesForFormatting(state)` wrapper around the
  similar-selection-plugin's `getOperatingRanges` — every
  formatting command's call-site swapped to the wrapper.
  Commands that bypass `getOperatingRanges` (the non-shadow
  branches in `adjustFontSize` / `setFontSize` / `runUniColor`
  / `highlightToShading` / `shadingToHighlight` / strip-mark in
  `color-panel.ts`) trim inline against `sel.from / sel.to`.
  `shadowAwareToggleMark` was previously falling through to
  PM's `toggleMark` on the non-shadow path; it now unifies
  through the trimmed-ranges path so the keyboard Ctrl+B /
  Ctrl+I / Ctrl+U bindings get the trim too.

- **Duplicate-open guard on the file-open path.** The workspace
  doesn't currently support having multiple copies of the same
  doc open — opening a duplicate would create a second
  `DocRecord` with its own undo history, journal, and dirty
  state, which is a confusing UX. The two entry points now
  check before loading:

  - Single-pane (`runOpenFlow`): compares `opened.handle`
    against `currentDocHandle`.
  - Multi-pane shell (`onFileOpen` ribbon path +
    `openFileIntoSlot` per-slot button): a new
    `findOpenRecordByHandle` walks every slot's stack. On
    match, the existing copy is brought to its slot's visible
    record and the slot is focused, so the user lands on the
    doc they "tried to open."

  Handle equality goes through a new
  `isSameOpenHandle(a, b)` helper in `host/index.ts` — string
  comparison on Electron paths, `FileSystemFileHandle
  .isSameEntry()` on the browser. Never-saved docs (handle
  null) aren't deduped — we have no identity to compare yet.

  Cross-window duplicates are also covered on Electron via a
  main-process path map (`Map<canonical-path, windowId>`).
  Three new IPC handlers in `apps/desktop/src/main.ts`:

  - `host:open-path-check(path)` is the read-only pre-load
    probe. If another window owns the path, main focuses that
    window (restoring it if minimized) and returns
    `{ takenByOther: true }` so the caller can toast + abort.
  - `host:open-path-register(path)` claims a path for the
    caller window once a doc has finished mounting.
  - `host:open-path-release(path)` drops the claim on
    unmount / Save-As to a new path.

  Window-close auto-cleanup runs in the existing `browser-
  window-created → closed` listener so a force-quit can't
  leave stale entries blocking re-opens. The `host:spawn-
  window` handler also claims the new window's path
  atomically at spawn time so a concurrent open from a third
  window can't sneak in between spawn and the new window's
  mount. Renderers wire through a centralized
  `setCurrentDocHandle` helper (single-pane) /
  `syncDocPathClaim` helper (multi-pane shell) — each is
  called at every handle-assignment site (open, recovery,
  spawn-target initial mount, Save-As, close) so the
  registration map stays in sync. Browser host has no
  multi-window concept and no-ops these methods.

- **Comments column ported to multi-pane as a shell-row
  sibling.** Previously the column was hidden whenever
  `multiDocWorkspace` was on and the Add Comment / Ask AI ribbon
  commands refused to run. The shell now adopts the shared
  `#comments-column` as a sibling of `.pmd-multi-row` —
  `.pmd-multi-shell` is `flex-direction: row` so the multi-row
  takes `flex: 1` and the column takes its persisted width via
  `--pmd-comments-width`. Visually it reads as a narrow fourth
  slot that shrinks the three doc panes equally instead of
  cutting into the focused pane only.

  Threads follow focus: `focusSlot` calls
  `commentsColumn.render()` so cards rebuild against the newly
  active view (the column's `getView` already returns
  `setActiveView`'s tracked view). Because the column lives
  outside every pane's scroll container, scrolling the focused
  doc would otherwise leave cards stranded at the wrong Y —
  `attachFocusedScrollSync` installs a rAF-throttled scroll
  listener on the focused `.pmd-pane-body` that calls
  `CommentsColumn.relayoutCards()`. The listener tears down and
  re-installs on every focus change; `handleSlotEmptied`
  detaches it when the last doc closes.

  Per-record `dispatchTransaction` now calls
  `notifyCommentsForActiveTransaction` (a new helper exported
  from `editor/index.ts`); it short-circuits unless the
  transaction belongs to the active view, so background-stack
  edits in non-focused panes don't paint over the focused doc's
  column. `buildDocRecord` now accepts an optional `threads`
  array and dispatches `loadThreads` after `record` is
  initialized (a `dispatchTransaction` closing over `record`
  meant earlier dispatch placement hit a TDZ);
  `loadOpenedIntoSlot` (docx + cmir) and `onRecoveredDoc` pass
  threads through so docs land in multi-pane with their
  comments already in plugin state.

  Layout-pinning cleanups carried over from the single-pane
  fix: `desiredTop` no longer clamps at 0 — a heading scrolled
  above the editor's top gives a negative diff in multi-pane
  (column is decoupled from the scroll container), and cards
  should slide off the top symmetrically with the bottom rather
  than pile against `top: 0`. `actualTop` packing math
  similarly allows negative values. Single-pane is unaffected
  because column and editor share a scroll container — the
  diff stays positive in that mode.

- **AI-comment identification moved from `kind: 'ai'` to a
  round-trip-safe shape: fixed `'AI'` initials + a `(AI)` suffix
  on the author name.** The `kind` field doesn't survive a docx
  round-trip — Word has no concept of AI vs human, so when a doc
  is saved as docx and re-imported, every comment comes back as
  `kind: 'human'`. AI comments lost their purple-badge styling
  in the process. New AI comments now carry the AI marker in
  fields that DO round-trip: `initials: 'AI'` (regardless of
  persona) and an author name like `Clod (AI)` (or just `'AI'`
  when no custom persona is set — no double-suffix). A new
  `isAiComment(comment)` helper recognizes either signal and
  drives the existing `.pmd-comment-ai` purple styling path.
  The helper also honors legacy `kind: 'ai'` so comments saved
  before this change keep their styling. New AI comments are
  written with `kind: 'human'`. The small inline "AI" tag that
  used to sit next to the author name has been removed —
  redundant with the `(AI)` suffix that's now baked into the
  name. CSS class `.pmd-comment-kind-tag` deleted.

- **Multi-pane workspace shortcuts moved into the ribbon
  registry; all rebindable via Settings → Keybindings.** Eight
  new `RibbonCommandId`s with defaults matching what shipped
  earlier in this Unreleased cycle:

  - `focusSlot1` / `focusSlot2` / `focusSlot3` → `Mod-1/2/3`
  - `sendDocToSlot1` / `sendDocToSlot2` / `sendDocToSlot3` →
    `Mod-Shift-1/2/3`
  - `toggleSlotExpand` → `Mod-Shift-f`
  - `closeDocOrWindow` → `Mod-w`

  Each gets a label, default-key entry, group placement (new
  "Multi-pane workspace" section in `ribbon-groups.ts`), a
  no-op `Command` case in `commandFor` (the keymap matcher
  doesn't need to do anything — these are view-less actions),
  and an entry in `VIEWLESS_RIBBON_COMMANDS`. The global
  window keydown handler in `editor/index.ts` dispatches them
  via `runViewlessRibbon`, which now calls into a small new
  `runMultiPane` helper that dynamic-imports the shell module
  and invokes one of three new exports:

  - `focusSlotByIndex(idx)`
  - `sendVisibleToSlotByIndex(idx)`
  - `toggleFocusedSlotExpand()`

  These are thin wrappers around new `MultiPaneShell` methods
  (`focusSlotByIndex`, `sendVisibleToSlotByIndex`,
  `toggleFocusedSlotExpand`). `closeDocOrWindow` uses the
  existing `tryCloseVisibleInFocusedSlot` + fallback to
  `handleUserCloseRequest`.

  Two standalone `window` keydown listeners removed
  (`onSlotShortcutKey` and `onExpandToggleKey`) — the work
  flows through the global ribbon-keymap path now. The
  Electron menu's `CmdOrCtrl+W` accelerator stays hardcoded
  as a discoverability cue; if the user rebinds
  `closeDocOrWindow`, both paths fire the same action.

  Ribbon keymap matcher (`ribbonKeyStringFor`) now normalizes
  digit keys via `e.code` (e.g., `Digit1` → `1`) so
  `Mod-Shift-1` matches even though Shift+1 produces
  `e.key === '!'` on US keyboards (and layout-specific shifted
  digits elsewhere). Without the fix, the new `sendDocToSlotN`
  bindings wouldn't fire from the global handler. Letters and
  symbol keys still use `e.key`.

  The Ctrl+Tab doc-cycling overlay is the lone exception —
  its hold-and-press semantics (modifier held, Tab pressed
  repeatedly, modifier released to commit) don't fit the
  discrete-press ribbon-command model. The
  `onDocCycleKey` / `onDocCycleKeyUp` listeners stay on
  `window` with hardcoded `Tab` matching.

- **Multi-pane: Ctrl+Tab / Ctrl+Shift+Tab cycle docs within the
  focused slot.** New `Slot.cycleVisible(delta)` advances the
  visible doc index in a slot's stack with wrap-around. Wired
  via a new `onDocCycleKey` window keydown listener (mounted
  alongside the existing `onSlotShortcutKey` for Mod-N slot
  focus). Routes through the existing `showRecord` so the
  shared-chrome / focusSlot dance fires the same way as a
  click on the stack-dropdown menu would.

  Desktop (Electron) accepts plain Mod+Tab — Electron windows
  have no native tabs to cycle, so the keydown passes through
  to the renderer's JS unmodified. Web reserves the plain
  Mod+Tab chord for the browser's own tab cycling, so the
  renderer never sees the keydown there. The handler also
  accepts Mod+Alt+Tab as the web-edition fallback (and on
  desktop, which makes Mod+Alt+Tab a universal alias).
  Shift toggles direction.

- **Multi-pane: Ctrl+Shift+1 / 2 / 3 send the focused slot's
  visible doc to slot N.** Mirror of the Mod-N slot-focus
  chord. New `Slot.releaseVisible()` is closeVisible without
  the view destroy / journal drop: detaches the visible
  record's DOM, removes it from the stack, mounts the next
  visible doc (or empties the slot), and returns the released
  `DocRecord` so the shell can re-push it into the target
  slot's stack. The view stays live across the move, so the
  doc keeps its cursor, selection, undo history, autosave
  state, and any other view-attached state.

  Extended `onSlotShortcutKey` to differentiate the Mod-only
  chord (focus) from the Mod-Shift chord (send-to). The
  digit-match uses `e.code === 'Digit1'/'Digit2'/'Digit3'`
  rather than `e.key === '1'/'2'/'3'` because Shift-modified
  digits render as `!`/`@`/`#` (or layout-specific characters)
  in `e.key`; `e.code` is the physical-key identifier and
  works for both shifted and unshifted chords.

  Expand-mode edges handled via the existing notification
  callbacks: source emptying in expand mode drops expand
  mode; target receiving a doc while a different slot is
  expanded keeps the doc hidden until expand mode exits.

- **Exported .docx is Verbatim-recognized on open.** Verbatim's
  per-doc ribbon-visibility callback
  (`Ribbon.GetRibbonVisibility`, registered on every `<group>`
  in Debate.dotm's `customUI14.xml`) decides activation by
  reading `ActiveDocument.AttachedTemplate.Name`. To make our
  exports activate the Debate ribbon without the user clicking
  Verbatimize first, `Docx.empty()` in `src/ooxml/docx.ts` now
  emits:

  - `word/settings.xml` containing
    `<w:attachedTemplate r:id="rId1"/>`.
  - `word/_rels/settings.xml.rels` containing the rel with
    `Type=".../attachedTemplate"`,
    `Target="file:///Debate.dotm"`,
    `TargetMode="External"`.
  - The matching `<Override>` for the settings part in
    `[Content_Types].xml`.
  - A `<Relationship>` linking `document.xml` →
    `settings.xml` in `word/_rels/document.xml.rels` (added in
    `exporter.ts`'s `buildRelsXml`, claiming `rId2`; dynamic
    rels now start at `rId3`).

  Methodology: extracted Debate.dotm and the VBA strings dump
  pointed at `AttachedTemplate` + `InstallCheckTemplateName` as
  the recognition predicate. First experiment (the docVar
  hypothesis — setting `VerbatimVersion` in `<w:docVars>` to
  various values) was falsified — none of v2 / v3 / v4 / v5
  activated the ribbon. Second experiment
  (`<w:attachedTemplate>` with the rel in `document.xml.rels`)
  also failed; the diff against a doc that the Verbatimize
  macro itself produced showed the rel belongs in
  `settings.xml.rels`, not `document.xml.rels`. Third
  experiment landed it:

  - v8 (`Target="Debate.dotm"`, bare filename): failed.
  - v9 (full Windows path the Verbatimize macro wrote on the
    author's machine): worked on two different Windows
    installs, even though the path was hardcoded to the
    original user's folder — confirming Word doesn't validate
    the stored path file-system-exists, just reads the
    basename of the URI.
  - v10 / v11 / v12 (URI shapes with no / fake-Unix /
    fake-Windows path components): all three worked on
    Windows. v10 / v11 also worked on Mac Verbatim (a separate
    Mac Word notification-daemon hang was diagnosed via the
    crash report's call stack and confirmed unrelated).

  Picked v10 (`file:///Debate.dotm`) as the shippable Target —
  shortest URI that activates recognition; Word doesn't care
  whether the path is reachable.

  Round-trip safety: today's exporter doesn't preserve the
  input docx's `word/settings.xml`; `toDocx` always starts
  from `Docx.empty()`. So no merge logic is needed — every
  export ships with the recognition surface, whether the
  source was fresh or imported. Users who don't have Verbatim
  installed see no impact: the stored attached-template
  Target is unresolvable to them, Word falls back to
  Normal.dotm, no prompt, no UI shift.

  The experiment script
  (`reference-docs/experiment-verbatimize.mjs`, gitignored)
  stays around as a local diagnostic if Verbatim's
  recognition mechanism ever shifts in a future release.

- **Emphasize Acronym (Mod-F10).** New ribbon command for
  marking the source letters of an acronym. Algorithm:
  1. Bail if the selection is empty.
  2. For each textblock that overlaps the selection (skipping
     structural blocks via the existing `NAMED_STYLE_SKIP_BLOCKS`
     set — emphasis_mark is body-only), find the leftmost and
     rightmost non-whitespace character indices within the
     selection's clip range. If neither exists (selection is
     entirely whitespace), skip the block.
  3. Expand leftward and rightward through non-whitespace to
     reach whole-word boundaries (same word definition as
     `wordRangeAtCursor` — maximal run of non-whitespace within
     the textblock, inline leaves break words, mark boundaries
     don't).
  4. Walk the expanded range and emit a 1-character mark range
     for every word-start position (WS-to-non-WS transitions
     plus the initial position if non-WS).
  5. Apply `emphasis_mark` to each range plus the same direct-
     formatting strip `applyEmphasis` uses.

  Wired the standard ribbon-command surface — type union,
  registry array, label ("Emphasize Acronym"), default key
  (`Mod-F10` → "Ctrl+F10" on Win/Linux, "⌘F10" on Mac),
  dispatcher case, and `ribbon-groups.ts` placement next to
  `applyEmphasis` in the Character styles group so both the
  cheat sheet and the keybindings editor inherit the
  grouping.

- **Keybindings editor grouped by thematic section.** Lifted
  the `GROUPS` taxonomy out of `reference-ui.ts` into a new
  shared `ribbon-groups.ts` module as `RIBBON_GROUPS`. The
  drift-guard assertion (every `RibbonCommandId` lands in
  exactly one group, no duplicates, no orphans) moved with it
  and now protects BOTH surfaces — adding a new command
  without categorizing it throws at module load.

  Settings → Keybindings used to call
  `[...RIBBON_COMMAND_IDS].sort((a, b) => labelA.localeCompare(labelB))`
  and render every row in one alphabetical flat list (~70
  rows). Now iterates `RIBBON_GROUPS` instead: each group
  becomes a `<section>` with an uppercase muted `<h3>` heading
  + that group's commands in the order the group defines them
  (matching the cheat sheet's ergonomic clustering, not raw
  alphabetical). Group headings are `position: sticky; top:
  0` inside the scrollable list so users keep their place as
  they scroll through long sections like "Table" (10 rows).

  Single source of truth: editing `ribbon-groups.ts` updates
  both the cheat sheet and the rebinding editor. No more
  "remembered to update both" failure mode for future
  command additions.

- **Round-trip: hyperlink rel Targets are XML-attribute-escaped.**
  `exporter.ts`'s `buildRelsXml` was interpolating `rel.target`
  raw into the `Target="..."` attribute of each hyperlink
  `<Relationship>`. URLs containing `&` (the standard
  query-string parameter separator — extremely common in cite
  links) ended up as raw `&` in the XML, which is malformed.
  Word's loader uses a recovery-mode parser that pulls the
  document body through anyway, but flags the file as
  corrupted on open. User-reported symptom: round-trip of a
  doc with many cite hyperlinks opened on another machine as
  "we found a problem with some content" and images failed to
  display (likely because the rels XML failure cascaded into
  the relationship resolver giving up partway).

  Fix: pipe `rel.target` through the existing `escAttr` helper
  (`src/ooxml/xml.ts`) for both the hyperlink and image rel
  emission paths. `escAttr` escapes `&`, `<`, `>`, and `"` —
  the four chars that can break an attribute value. Image
  Targets are internally generated and currently safe, but
  symmetry / defense in depth justifies the escape there too
  (a future media filename with a special char would have the
  same problem).

  Detected via diff of a doc round-tripped through CardMirror
  against the same doc untouched: both opened in Word, but the
  round-tripped one reported corrupted on open. `xmllint
  --noout document.xml.rels` returned `EntityRef: expecting
  ';'` errors at exactly the unescaped `&` positions.

- **Plain-paste no longer splits cards on a trailing newline.**
  Long-standing user-reported bug ("skipping around on paste"
  / "viewport shoots to the bottom") had a narrow trigger:
  copy-and-plain-paste of text containing a line break into a
  tag (or other single-line block). A common real-world
  occurrence is triple-clicking an article title in the
  browser; most browsers grab a trailing `\n` alongside the
  visible text.

  `buildPlainTextSlice("Article Title\n")` produced a
  two-paragraph slice (`Slice([paragraph("Article Title"),
  paragraph("")], 1, 1)`). When `replaceSelection`'d into a
  `tag` (which our schema constrains to a single textblock
  inside a `card`), PM split the surrounding card at the
  paragraph boundary to accommodate the multi-paragraph
  slice — the existing tag/cite ended up separated with a
  floating card-boundary separator at the newline position,
  and the post-paste `scrollIntoView()` landed at the new
  doc-end (since the structural mutation moved the cursor
  to the synthesized split point's end-of-doc cascade).

  Fix: new `normalizeClipboardTextForPaste(text, parentTypeName)`
  helper in `paste-plugin.ts`. In single-line contexts
  (`tag`, `cite_paragraph`, `undertag`, `analytic`) it
  collapses whitespace runs (`\s+`) to single spaces and
  trims edges before the text reaches `buildPlainTextSlice`.
  In multi-paragraph contexts (`card_body`, `paragraph`, etc.)
  it returns the text unchanged so intentional paragraph
  splits in the clipboard still produce multi-paragraph
  slices.

  Wired into both plain-paste entry points: the browser
  `handlePaste` handler (when `plainPasteArmed` is set, e.g.
  F2 in the web edition) and the Electron-host
  `applyPlainPasteFromText` function (called from the
  desktop menu's "Paste as plain text" / native F2 mapping).

- **Nav pane: highlight follows the editor caret.** Previously
  the `.pmd-nav-item-selected` blue highlight was driven purely
  by click events on the nav-pane (`selectSingle` / shift-click
  range / ctrl-click toggle); editor caret movements didn't
  update it. New `NavigationPanel.setCaretHeading(pos)` finds
  the heading whose section contains the caret (= largest
  `entry.pos <= pos` from the rendered `liEntries`) and calls
  `selectSingle` on it. Wired from `index.ts`'s
  `dispatchTransaction`, gated on `prevState.selection.from !==
  next.selection.from` so doc-only transactions away from the
  cursor don't pay the find-heading walk.

  Caret-tracking always produces a single selection — explicit
  multi-select via Ctrl/Shift-click still works for drag-and-
  drop and similar workflows, but collapses on the next caret
  movement. Matches the user mental model that the nav-pane
  reflects "where the cursor is."

  Doesn't auto-scroll the nav pane to bring the highlight into
  view — explicit decision; auto-scrolling on every cursor move
  would dominate the user's scroll behavior on long docs. Worth
  revisiting if it turns out users want it for outline-following
  workflows.

  Edge cases:
  - Caret before the first heading → `clearSelection()`, no
    highlight.
  - Caret inside a heading whose nav entry is hidden under a
    collapsed parent → the closest ancestor in `liEntries` gets
    highlighted (we iterate only rendered items).
  - Position drift between a doc edit and the next debounced
    `update()` (~200ms): the highlight may briefly point at a
    stale neighbor. Acceptable for a visual indicator.

- **Comments column: user-draggable width with resize handle.**
  Mirror of the nav-pane resize-handle pattern. New
  `commentsColumnWidth` setting (default 320, range 240–560)
  persists the width across sessions. CSS custom property
  `--pmd-comments-width` drives `.pmd-comments-column { width }`;
  the resize handle on the column's LEFT edge (the
  `right`-anchored opposite of the nav-pane's right-edge
  handle) updates the custom property during drag. Mouseup
  writes the final value to `settings`.

  Range chosen by squint: 240 px is the threshold below which
  thread cards start feeling cramped; 560 px is where the
  column starts eating too much of the editor width on a
  laptop. Same clamp in the settings sanitizer + the JS drag
  handler so persisted out-of-range values get pulled back in.

  The handle's bg is transparent at rest; tints on hover
  (`--pmd-c-accent-soft`) and during drag. Mirrors the
  nav-pane handle exactly — col-resize cursor on hover is the
  discovery cue, no permanent visible affordance. (An earlier
  iteration added a grip-dot indicator; removed when the user
  preferred the cleaner pattern of the nav-pane.)

- **Comments column: resize handle survives render() wipes.**
  Initial implementation appended the handle as a direct child
  of `#comments-column`. The column's `render()` method (fired
  from `dispatchTransaction` on every keystroke that affects
  comments state) does `this.root.innerHTML = ''` to rebuild
  threads from scratch, which wiped the handle along with
  everything else. User reported "can't see the resize handle"
  after typing — exactly the post-wipe state.

  Fix: introduce an inner `.pmd-comments-content` wrapper
  inside the column. `render()` now wipes that inner wrapper
  rather than the column root. The resize handle stays as a
  sibling of the wrapper (installed in the constructor BEFORE
  the wrapper, so DOM order is handle-then-content). Sticky
  positioning context for any column children remains the
  column itself (via `position: relative`); the inner wrapper
  is `height: 100%; width: 100%` so containment doesn't shift.

- **Comments column: full-scroll-extent layout via inner grid
  wrapper.** Same family of post-path-A regression as the
  multi-doc top-shift and recovery-sidebar offset that landed
  in alpha.3. With `#app` migrated to `position: fixed` +
  `overflow-y: auto` (the bounded scroller), the inner flex
  layout's cross-axis was viewport-bounded — items stretched
  to viewport, not to content height. The comments column's
  background only rendered at the top of the page and didn't
  cover the full scroll strip.

  Two-stage fix:
  1. `<div class="pmd-editor-row">` wrapper added inside `#app`
     in `index.html`, holding `#editor` + `#comments-column`.
     The flex / grid layout lives on this inner wrapper rather
     than `#app` itself.
  2. The wrapper uses `display: grid; grid-template-columns:
     1fr auto`. Initial attempt was flex with `min-height:
     100%`, but flex's cross-size determination floors at
     `min-height` and doesn't grow with overflowing items
     (measured: wrapper box 807px while `#editor.scrollHeight`
     was 5971px). Grid track sizing is content-based and
     handles this case cleanly — items end up content-tall
     (≈ 5982px on a long doc), the column's background covers
     the full scroll strip.

  Short / empty document case (separate issue surfaced in
  testing): with `grid-auto-rows: max-content`, an empty doc
  produced a short track and the column rendered as a small
  strip at the top of the visible area with empty space below.
  Fixed by NOT setting an explicit `grid-template-rows`
  initially, then trying `minmax(100%, max-content)` (collapsed
  to 100% per CSS Grid spec's "treat percentages as auto when
  the container's size depends on its tracks" rule, regressing
  the long-doc fix). Final shape: no explicit `grid-template-
  rows`; track auto-sizes. Combined with `min-height: 100%` on
  the wrapper, this gives items max(viewport, content) cross-
  size in both cases.

  Hidden in multi-doc layout via
  `body.pmd-multi-doc .pmd-editor-row { display: none }` —
  multi-pane's per-pane shell sits as a sibling of the wrapper
  and uses its own internal layout.

- **Comments column: bottom-left collapse/expand toggle removed.**
  The `.pmd-comments-toggle-active` button (▾/▴ circle pinned
  with `position: sticky; bottom: 0.5rem`) is gone. Removed:
  the `renderToggle` method, its call site in `render()`, the
  "skip click on toggle" branch in the sticky-dismiss handler,
  the `lastActiveThreadId` field + assignments (only the
  toggle button used it for "re-expand most recent thread"),
  and the three CSS rules for the button.

  Active-comment collapse still works — the sticky-dismiss
  global mousedown handler still dismisses when the user
  clicks outside the active card. The lost affordance is the
  "explicitly re-expand the most recently active thread"
  button-click; users now click the card they want to re-open.

## 0.1.0-alpha.3 — 2026-05-21

- **Auto-update check on launch (opt-in).** New setting
  `checkForUpdatesOnLaunch`, off by default in this release.
  When on, the first window of an app session triggers a silent
  update check during boot (gated on `host.isFirstWindow()`,
  same pattern as the doc-recovery UI — subsequent windows in
  the same session skip the check). If `update-available` fires,
  the same modal the manual Help → Check for Updates path uses
  pops up with "Open release page" + "Close" buttons; the
  "Open release page" button calls `shell.openExternal` to deep-
  link to `https://github.com/ant981228/cardmirror/releases/tag/v$VERSION`
  in the user's default browser. Errors and "you're current"
  outcomes stay silent on this path — the wishlist explicitly
  flagged that surfacing them every launch would be obnoxious
  for users who happen to be offline at boot.

  Implementation:
  - Renderer-driven trigger: a new
    `host:trigger-auto-update-check` IPC handler in `main.ts`
    calls a shared `runUpdateCheck(opts)` function with
    `{ alertOnLatest: false, alertOnError: false }`. The same
    function backs the manual Help-menu path with
    `{ alertOnLatest: true, alertOnError: true }`.
  - Shared `showUpdateAvailableDialog(info)` helper holds the
    modal definition, so the available-update dialog is
    byte-identical between manual and auto-launch paths.
  - Single `updateCheckInFlight` guard prevents the manual and
    auto paths from racing if they happen to overlap (e.g.,
    user clicks Help menu before the boot check completes).
  - `startAutoUpdate` no longer calls `checkForUpdates()`
    itself — the renderer owns the at-launch trigger now,
    gated on the setting + `isFirstWindow()`. The persistent
    `update-downloaded` handler stays in `startAutoUpdate` so
    the "Update ready, restart now?" dialog still fires when
    the background download completes (regardless of whether
    the trigger came from manual, auto-launch, or the Settings-
    panel button).
  - Setting toggle lives in `buildInstallInfoSection` (Settings
    → General → "About this install") via a plain checkbox
    above the existing Check-for-updates / Open-crash-dumps
    action buttons. Electron-only (web edition has no update
    mechanism).

- **Manual update check: three-dialog feedback.** The Help →
  Check for Updates click handler in `apps/desktop/src/main.ts`
  used to register only an `update-not-available` handler;
  `update-available` and `error` paths were silent (auto-update
  proceeded in the background, errors went to `console.warn`).
  Replaced the inline click handler with a `runManualUpdateCheck()`
  function that registers `.once` handlers for all three events
  plus a `catch` on the `checkForUpdates()` promise, with a
  mutual-cleanup pattern so exactly one dialog fires per check.
  Dialogs:
  - **Not available**: "You're on the latest version." + version.
  - **Available**: "Update available: vX.Y.Z." With buttons
    "Open release page" (deep-links to the tag's release page via
    `shell.openExternal`) and "Close." The download still proceeds
    in the background via the persistent `startAutoUpdate`
    handlers, which will show the existing "Update ready,
    restart now?" dialog when finished.
  - **Error**: "Couldn't check for updates: <message>" with the
    Releases URL as a manual-download fallback.
  Re-entrancy guard (`manualCheckInFlight`) prevents rapid double-
  clicks from registering duplicate handler sets. Auto-check
  errors on launch still go to `console.warn` per the wishlist —
  popping a dialog on every offline boot would be obnoxious.

- **`getFocusedWindow()` null guard via `dialogParentWindow()`.**
  Both the manual update-check dialogs above and the existing
  startAutoUpdate `update-downloaded` handler look up the dialog
  parent via `BrowserWindow.getFocusedWindow()`. If the user
  alt-tabs away between clicking "Check for Updates" and the
  response arriving, that returns `null` and the previous code
  silently early-returned, dropping the dialog on the floor.
  Centralized the lookup in `dialogParentWindow()` which falls
  back to `BrowserWindow.getAllWindows()[0]` — worst case the
  dialog attaches to "some" CardMirror window instead of the
  focused one, which is far better than the dialog never
  appearing.

- **About panel surfaces Chromium and Electron versions.**
  `src/editor/install-info.ts` parses `Chrome/X.Y.Z` and
  `Electron/A.B.C` out of `navigator.userAgent` and lists them
  as their own labelled rows above the full UA string. The
  underlying versions were already discoverable by reading the
  UA, but separate rows make "is the user actually running the
  version they think they are?" a one-line check during bug
  triage. Web edition shows Chromium but no Electron row.

  Context for this: a user-reported "Linux build shows version
  0.1.0-alpha.1 on alpha.2 install" bug whose code-path
  investigation came back clean — `pkg.version` is Vite-inlined
  from the root `package.json` at build time, the alpha.2 tag's
  `package.json` was `0.1.0-alpha.2`, the AppImage filename
  itself is `cardmirror-0.1.0-alpha.2.AppImage`. The most plausible
  explanation is the user had an earlier alpha.1 AppImage still
  installed (AppImages don't auto-update). Adding the separate
  version rows is the defensive measure that makes future
  version-mismatch confusion easier to diagnose.

- **Release workflow: two-stage to avoid the matrix-race.**
  alpha.2's release produced two separate drafts because the
  three OS matrix jobs concurrently saw "no release for this tag"
  and each created its own — Mac + Windows assets ended up on
  one draft and Linux's on another, requiring manual
  reconciliation. New `prepare-release` job runs first on a
  single Ubuntu runner, idempotently creates a draft release via
  `gh release create $TAG --draft --title $TAG --generate-notes`
  (no-op if a release for the tag already exists), and the
  `build` matrix job `needs: prepare-release` so it never starts
  until the draft is in place. electron-builder's GitHub
  provider then finds the existing draft and uploads to it
  instead of racing to create one.

- **Single-doc scroll container migrated from `body` to `#app`.**
  Diagnosis: a multi-trace investigation (Mac Electron, Mac Chrome,
  Linux Chrome, with and without `--enable-skia-graphite`) plus a
  layer-tree audit on macOS pinned single-doc's continuous heavy
  `UpdateLayer` cost during scrolling to the document being the
  rootScroller. The DevTools Layers panel showed `#document` at
  2206 × 558272 px, ~4.9 GB nominal memory, compositing reason
  *"Is the document.rootScroller. Is a scrollable overflow element
  using accelerated scrolling."* Every scroll position change
  triggered a recomposition of that giant layer. Trace-data
  signature: 10 big (>100 ms) `UpdateLayer` events spread across
  a 13 s scroll session in single-doc vs. zero in multi-pane
  (which already used the bounded `.pmd-pane-body` scroller).

  Fix: scope a new `body:not(.pmd-multi-doc) #app` rule that pins
  `#app` to the chrome-clipped viewport rectangle via
  `position: fixed` (top/left/right/bottom set from the existing
  `--ribbon-height` / `--nav-width` / `--status-bar-height`
  tokens) and gives it `overflow-y: auto` + `overscroll-behavior:
  contain`. The editor + comments column scroll *inside* `#app`;
  `body` stops being the rootScroller; the composited scrollable
  layer is bounded by `#app`'s viewport-sized box instead of the
  doc-content height. Multi-doc layout is untouched — it has its
  own `body.pmd-multi-doc #app` rule that already pins height and
  manages overflow via per-pane `.pmd-pane-body` scrollers.

  Companion changes:
  - `body.pmd-speech-banner-visible:not(.pmd-multi-doc) #app` now
    adjusts `top:` instead of `margin-top:` (multi-doc never
    surfaces the banner, so this is single-doc-only).
  - The dark-chrome-light-document background paint extends to
    `#app` (was `.pmd-pane-editor` + `.pmd-pane-body` previously) —
    container backgrounds in `overflow: auto` cover the full
    scrollable extent at every scroll position, so any gap below
    the editor's content extent now reads as light rather than
    dark.
  - `index.ts` reset path: `appEl.scrollTop = 0` replaces
    `window.scrollTo(0, 0)` in the doc-open scroll-to-top sequence.
  - `precise-scroll.ts` `desiredTop` now reads from the nearest
    scrolling-overflow ancestor's `getBoundingClientRect()` instead
    of `window.innerHeight`. Falls back to viewport bounds when
    no scroller is found (tests, detached nodes). This keeps the
    convergence math working across single-doc (`#app`), multi-pane
    (`.pmd-pane-body`), and any future container.

  Verified end-to-end: typecheck + 683 tests pass. Most scroll-
  path call sites needed no changes — `tr.scrollIntoView()` (the
  PM Transaction method) walks up from the selection's DOM to
  find the nearest scrolling ancestor; element-level `scrollIntoView`
  does the same; `drag-editor-surface.ts`'s host-relative math
  was already 0 in single-doc and stays so.

  Standalone, this fix narrowed but didn't close the macOS gap
  (see Electron bump entry below for the second half of the
  story).

- **Electron bumped from 33 (Chromium 130) to 42 (Chromium 148).**
  Second half of the macOS scroll-perf fix. The path A
  architectural change above eliminated the doc-as-rootScroller
  giant layer in single-doc, but the residual gap to the same
  content rendered in the user's installed Chrome 148 remained —
  measured most acutely as click-jump tail latency
  (electron-multi p99 frame interval 974ms vs chrome-multi 343ms
  on identical content + hardware) and per-event `UpdateLayer`
  cost magnitude (electron-single avg 472ms vs chrome-single
  78ms). Trace data attributed the gap to Chromium 130's
  compositor pipeline being more tightly coupled to main-thread
  work than 148's — Chrome did similar total work per scroll but
  produced frames smoothly through it, while Electron 130
  blocked frame production on the heavy work.

  GPU-feature-status diff between the two builds on the same Mac
  landed cleanly on one line:
  `skia_graphite: disabled_off` (Electron 33) vs `Enabled`
  (Chrome 148). Skia Graphite is the newer Dawn-on-Metal Skia
  backend that ships the relevant compositor decoupling. The
  `--enable-skia-graphite` switch we added to `main.ts` engaged
  the feature in Electron 33 (verified by re-running the GPU diff
  post-switch) but the M130 iteration of Graphite is two cycles
  pre-default-on; engaging the flag helped substantially but
  didn't reach Chrome 148's behavior. The actual cure was
  upgrading to a Chromium build that ships the mature Graphite
  implementation.

  Electron 42's bundled Chromium is `148.0.7778.96`, effectively
  matching the user's installed Chrome 148.0.7778.168 — maximum
  apples-to-apples perf parity. Bumps:
  - `electron`: `^33.2.0` → `^42.2.0` (9 major version jump)
  - `electron-builder`: `^25.1.8` → `^26.8.1`
  - `electron-updater`: `^6.3.9` → `^6.8.3`
  - `electronVersion` in build config: `33.2.0` → `42.2.0`

  Migration was uneventful: full `rm -rf node_modules
  package-lock.json && npm install`, `npm run build:main` clean
  against Electron 42 types (no main-process API breakages
  caught by tsc against the 9-major delta), renderer typecheck +
  683 vitest tests still pass. End-user verification on the Mac
  confirmed the perf gap closed — scrolling, typing, and
  nav-pane click latency now feel parity with the in-browser
  experience.

  The `--enable-skia-graphite` switch we added during the
  investigation is now a no-op on Electron 42 (Graphite is
  default-on for Apple in Chromium 148) but stays in place as
  belt-and-suspenders. The "Copy GPU Info" menu item that was
  added as a temporary diagnostic stays as a permanent
  bug-report aid — one click, zero runtime cost.

- **Keyboard Shortcuts cheat sheet caught up with the keybindings
  registry.** The `GROUPS` array in `src/editor/reference-ui.ts`
  was hand-maintained and had drifted behind the registry — alpha.2
  added twenty-some new bindable commands (the twelve previously
  click-only ribbon actions plus `zoomIn` / `zoomOut` / `zoomReset` /
  `chromeScaleUp` / `chromeScaleDown` / `chromeScaleReset` /
  `togglePaintbrushHighlight` / `togglePaintbrushShading` /
  `openFind` / `openFindReplace` / `openFindByProximity` /
  `toggleNavPane`) and none of them appeared in the cheat sheet.
  Two changes:

  1. **Expanded GROUPS to cover every `RIBBON_COMMAND_ID`.** Added
     three new categories — `Color pickers & menus`, `Find`,
     `Zoom & scale` — and slotted the missing commands into
     existing categories (`save` and `toggleAutosave` into File,
     `insertImage` into Editing utilities, paintbrush toggles into
     Highlight tools, the picker openers into the new Color pickers
     & menus group, etc.).
  2. **Module-init drift guard** asserts every `RIBBON_COMMAND_ID`
     appears in exactly one group. Throws on load if anyone adds a
     new command to the registry and forgets the cheat-sheet
     update, or accidentally lists the same command in two groups.
     Error message names the missing / duplicated / extra ids so
     the fix is obvious from the stack trace.

  Verified end-to-end via CDP: 86 rows across 17 groups (was 14
  groups and a smaller subset before; the previous version was
  missing ~26 commands). Module init returned `ok` rather than
  throwing, confirming the assertion accepts the current registry.
  Unbound commands continue to display `—` (we briefly shipped
  `(no shortcut)` instead; reverted at user request because it was
  too noisy with ~46 unbound commands).

- **New setting: Format nav pane entries by type** (Settings →
  Appearance, default on). Wishlist follow-up to the dark-mode
  nav-pane flatten-to-white tweak: some users find the per-level
  font weight cascade (700 → 600 → 500 → normal) and the analytic-
  blue label accent noisy and prefer a uniform list keyed only on
  indentation. Implementation:
  - New `formatNavPaneByType: boolean` field on `Settings`,
    default `true`, sanitized in `loadSettings` so missing-or-
    truthy is treated as on and explicit-`false` as off.
  - `SETTING_METADATA` entry under category `appearance` next to
    `showDocNameChip`, so it lands in Settings → Appearance with
    the other nav / chrome toggles.
  - `applyFormatNavPaneByType(on)` in `index.ts` toggles
    `html.pmd-nav-flat` (class present when the toggle is OFF;
    parallels `pmd-doc-name-chip-on` / `pmd-nav-hidden`). Called
    at module init and from the settings subscriber so live
    toggling works.
  - CSS rules in `style.css` near the existing per-level rules:
    when `html.pmd-nav-flat` is set, `.pmd-nav-level-{1,2,3,4}`
    collapse to `font-weight: normal`, `font-size: 0.85rem`,
    `color: var(--pmd-c-text)`, and
    `.pmd-nav-type-analytic .pmd-nav-label` inherits instead of
    forcing the analytic-blue accent. Padding-left rules are
    untouched — indentation is the surviving hierarchy cue.
  - The dark-mode nav-pane-flatten-to-white rule still wins
    inside dark mode because it carries the higher-specificity
    `:root[data-theme="dark"] :is(.pmd-nav-panel, .pmd-multi-nav)`
    chain — both rules want uniform color anyway, so the cascade
    interaction is by design.
  Verified end-to-end via CDP on the 1NC v. Dartmouth doc: with
  `pmd-nav-flat` set, level-1 / 2 / 3 entries all report
  `font-weight: 400`, `font-size: 13.6px`; default state has 700 /
  600 / 500.

- **Scroll chaining from the nav pane no longer bleeds into the
  editor.** With the pointer over the nav pane, scrolling past its
  top or bottom limit would propagate the leftover wheel delta to
  the body's scroll container (single-doc) or the multi-pane row.
  Once the browser picked the editor as the gesture's scroll
  target, reversing direction kept scrolling the editor until the
  user paused fully and started a new gesture. Fix: add
  `overscroll-behavior: contain` on the two `overflow-y: auto`
  containers that own the nav and pane scrolls — `.pmd-nav-list`
  and `.pmd-pane-body` (multi-pane). `contain` cuts the scroll
  chain at the element's boundary, which also kills the "sticky
  target" follow-up because the chain never starts. Single-doc
  editor scrolls on the body / html, which has no ancestor scroll
  container to chain into, so no symmetric change needed there.
  Verified: `getComputedStyle(.pmd-nav-list).overscrollBehaviorY ===
  "contain"` post-fix.

- **Dark mode: end-to-end readability guarantee on imported docs.**
  Reported against the Health Care Topic Area Paper and 1NC v.
  Dartmouth CG docxs: with Settings → Appearance → Theme: Dark
  and "Apply theme to the document area" enabled, large swaths
  of body text were invisible (literal black on dark), shading-
  background text was invisible (themed white on yellow shading
  from Verbatim's `HighlightToBackgroundColor` macro), and
  hyperlinks were either browser-default `#0000EE` blue or
  Word's `#0563C1` — neither readable on `#1a1a1a`. Four
  coordinated changes in `src/schema/marks.ts` and
  `src/editor/style.css`:

  1. **`font_color="000000"` skip-inline-style.** The
     `000000` sentinel emits only `data-color="000000"` (no
     `style="color: #000000"`). The run inherits the
     surrounding text color: near-black via `--pmd-c-text` in
     light mode, `#e6e6e6` in dark mode, whatever the user
     picked in the per-token-override panel.

  2. **`colorBand(hex)` helper + `data-color-band` /
     `data-shading-band` attributes.** New exported helper
     classifies a 6-hex RGB into `dark` (perceived luminance
     `(0.299r + 0.587g + 0.114b) / 255 < 0.4`) or `light`.
     `font_color` and `shading` `toDOM` each emit a band
     attribute on the rendered span. Threshold tuned so the
     common Word sentinels — `000000` (lum 0), `0563C1`
     hyperlink blue (~0.32), dark grays / reds — land in
     `dark`, and mid-gray (`888888` ~0.53) onward stays
     `light` (user-intentional choices preserved).

  3. **Shading mandates contrast like highlight does.** CSS:
     `.ProseMirror [data-shading-band="light"] { color: #000; }`
     and the dark counterpart. Mirrors the per-named-color
     rules on `.pmd-highlight` for arbitrary hex shading.
     Always-on (not dark-mode-gated) because shading is doc
     data and needs contrast in any theme.

  4. **`--pmd-c-link` token + dark-band override + container
     scoping.** Light mode `#0563C1` (matches Word); dark
     mode `#7AB0FF` (bright sky blue, ~0.71 luminance).
     `.ProseMirror a` uses the token with `!important` so it
     beats the canonical Word-blue `font_color` marks Word
     stamps onto hyperlink runs. In dark mode + apply-to-doc,
     `[data-color-band="dark"]` falls back to `--pmd-c-text`
     via `!important`, catching dark-band font_color marks
     anywhere in the doc. Three higher-specificity rules
     reverse the override inside `.pmd-highlight`,
     `[data-shading-band]`, and `<a>` so those containers'
     mandated colors win (otherwise the override would make
     yellow-shaded text white-on-yellow, etc.).

  Round-trip unchanged: exporter reads `attrs.color`,
  importer / `parseDOM` read `data-color` / `data-shading`,
  neither touches inline style or `data-*-band`.

  Verified end-to-end via CDP on the 1NC v. Dartmouth doc:
  108/108 shading runs compute high-contrast (`color: #000` on
  the yellow shading), all 503 highlight runs compute
  high-contrast per their named highlight, 9/16 link runs
  render in sky blue and 7 render black because they sit
  inside `.pmd-highlight` spans where black-on-yellow contrast
  takes priority over link visibility (acceptable — the
  highlight rule already preserves readability and the link
  is still clickable). Six new test cases in
  `tests/schema/schema.test.ts` lock the contracts: the
  `000000` style skip, the `data-color-band` luminance buckets
  (`000000`/`0563C1`/`FF0000` → `dark`; `888888`/`FFFFFF`/
  `FFFF00` → `light`), and the shading band attribute on
  `toDOM`.

- **Underline color matches text color inside highlights and
  shading.** Follow-up to the dark-mode-readability work above.
  `.pmd-underline` / `.pmd-emphasis` are outer to highlight /
  shading in the mark stack (underline_mark at schema position 117,
  highlight at 311, shading at 271 — earlier-defined marks render
  outermost in the DOM). The text-decoration line is painted by the
  outermost element, and its `text-decoration-color` defaults to
  that element's `color` — which in dark mode is the themed light
  body text. So an underlined-highlighted run renders as black text
  on yellow (correct), with a white underline cutting through it
  (wrong). Added two `:has()` rule sets in `style.css` that set
  `text-decoration-color` on `.pmd-underline` / `.pmd-emphasis` (and
  `.pmd-cite` under the `citeUnderlined` flag) when they contain a
  highlight or shading band: black for light-band containers
  (yellow / green / cyan / magenta / red / lightGray highlight,
  `data-shading-band="light"`), white for dark-band containers
  (blue / darkBlue / darkCyan / darkGreen / darkMagenta / darkRed
  / darkYellow / darkGray / black highlight, `data-shading-band="dark"`).
  Verified on 1NC v. Dartmouth: 232 underline-inside-highlight/shading
  spans now paint `rgb(0, 0, 0)` underlines (correct against the
  yellow backgrounds in that doc); plain underlines outside any
  band still paint with themed body color so they read as light on
  the dark surface.

- **Native form controls render in dark mode.** The body-font
  dropdown in Settings → Appearance was painting its `<select>`
  with `var(--pmd-c-bg)` (dark in dark mode) but had no explicit
  text `color`, and the dropdown popup was being drawn by the
  browser in its OS-default light style — black option text on
  white in a UI surrounded by dark chrome. Two fixes: (1) set
  `color: var(--pmd-c-text)` on `.pmd-body-font-select` so the
  collapsed value is readable; (2) declare `color-scheme: dark`
  on `:root[data-theme="dark"]` so the browser draws every
  native form control (popup option lists, scrollbars, native
  date/color pickers, etc.) in its dark variant. Not gated on
  apply-to-document — native form controls only appear in chrome
  surfaces, never inside the ProseMirror editor, so the
  doc-area-stays-light mode doesn't need a light counterpart.
  Verified: `getComputedStyle(html).colorScheme === "dark"` and
  the select reports `color: rgb(230, 230, 230)` /
  `background: rgb(26, 26, 26)` in dark mode.

- **Sky-blue hyperlink color is now gated on apply-to-document.**
  Follow-up to the readability-guarantee work: the dark-mode
  `--pmd-c-link: #7AB0FF` override was set at `:root[data-theme=
  "dark"]` scope and so applied to the editor whenever the theme
  was dark — including when "Apply theme to the document area" was
  OFF and the document was rendering as light paper. Word's
  canonical hyperlink blue (`#0563C1`) is the right color against
  a white doc, so the sky-blue override leaked the wrong palette.
  Fix: add `--pmd-c-link: #0563C1` to the existing
  `:root[data-theme="dark"]:not([data-theme-doc="dark"]) :is(#editor,
  .pmd-pane-editor)` rule that already re-declares the other light-
  mode tokens for the editor scope when apply-to-doc is off. The
  chrome scope keeps `#7AB0FF` in dark mode (no chrome surface
  actually uses the token, but the symmetry is correct). Verified
  via CDP: dark + off → editor link computes `rgb(5, 99, 193)`;
  dark + on → editor link computes `rgb(122, 176, 255)`.

- **"Dark chrome, light document" mode actually paints the document
  area white, across the full scroll, in both single-doc and
  multi-pane.** The CSS rule that scopes light-mode-token
  redeclarations inside `:is(#editor, .pmd-pane-editor)` under
  `:root[data-theme="dark"]:not([data-theme-doc="dark"])` redefined
  `--pmd-c-bg: #fff` at the editor scope, but nothing in that rule
  applied the token to the editor's own paint — `#editor` /
  `.pmd-pane-editor` carry no `background` declaration of their own,
  so they inherited body's `background: var(--pmd-c-bg)` which
  resolves to `#1a1a1a` in dark mode. The editor read as black-on-
  dark even though the user explicitly opted OUT of "Apply theme to
  the document area." Two coordinated paints land the fix:

  1. **`background: var(--pmd-c-bg)` on `:is(#editor, .pmd-pane-editor)`**
     within the same scoped rule, so the scoped `--pmd-c-bg: #fff`
     actually applies to the editor's box. This covers single-doc
     entirely — `body` is its scroller, `#editor` sits inside the
     flex layout, and `#editor`'s painted box extends with the
     content.

  2. **`background: #fff` on `.pmd-pane-body`** in the same scoped
     rule. Multi-pane's per-pane editor surface (`.pmd-pane-editor`)
     is sized `height: 100%` of its parent `.pmd-pane-body` — which
     is the `overflow-y: auto` scroller bounded to the pane's
     viewport. So `.pmd-pane-editor`'s painted white box only
     covered the visible viewport portion; ProseMirror content
     overflows past that box and the dark `.pmd-pane-body` showed
     through under the overflowed content as the user scrolled.
     Painting `.pmd-pane-body` itself covers the full scrollable
     extent (container backgrounds in `overflow: auto` paint behind
     the visible viewport at every scroll position).

  The body / ribbon / nav / status-bar chrome around the editor
  stays dark because their backgrounds resolve `--pmd-c-bg` from
  the root scope (`#1a1a1a`) — the redeclare only escapes into the
  editor scope. Per-token Accessibility-panel overrides of
  `--pmd-c-bg` still win for single-doc because the `#editor`
  paint uses the token, not a literal hex.

- **Nav pane reads in solid white in dark mode.** The per-level grey
  cascade (level-4 → `--pmd-c-text-muted`, level-1/2/3 → inherited
  body text) and the analytic-blue label (`--pmd-color-analytic`)
  rendered as inconsistent dim entries against the dark chrome
  surface, and the "No headings." empty-state message disappeared
  into the background at `--pmd-c-text-faint` (#7a7a7a in dark
  mode). Added a dark-mode-scoped block that sets `color:
  var(--pmd-c-text-strong)` on the nav-panel container, the empty
  state, the level-4 entries, and the analytic label / hover —
  covering both single-doc (`.pmd-nav-panel`) and multi-pane
  (`.pmd-multi-nav`) layouts. Light mode is unchanged. The
  in-flight wishlist item "Setting: disable nav-pane formatting"
  will let users opt out of the per-type formatting in light mode
  too when shipped; this fix is the dark-mode-specific tactical
  flatten.

- **Web-edition Open button: selection no longer silently dropped.**
  Clicking the 📂 button on the web edition would open the OS
  file picker, let the user pick a file, then do nothing. `Ctrl-O`
  worked on the same page. Root cause: `BrowserHost.openOnce` had
  a focus-event-plus-200ms-setTimeout heuristic to detect
  cancellation — when the dialog closed and the window regained
  focus, the timer fired 200ms later and checked `input.files`.
  If the browser hadn't populated `input.files` by then (which
  varies with the previously-focused element — the button vs.
  editor — and with OS dialog implementation), the timer
  resolved the promise to `null`, then the actual `change` event
  fired but ran into `settled=true` and dropped on the floor.
  Keyboard `Mod-O` happened to win the race; mouse-button click
  reliably lost it on Chrome 148+ on Linux and on Zen (Firefox
  fork). Fix: replace the focus-and-timeout polling with the
  native `cancel` event (Chrome 113+, Firefox 91+, Safari 16.4+),
  which fires only when the user actually dismisses the picker
  without picking. No race. The byte-identical code in alpha.1
  was already buggy; nothing changed in this file between
  releases — what likely shifted was timing pressure elsewhere
  on the page (timer UI mount, dark-mode boot, find-replace
  decorations) that pushed the focus event past the
  `input.files` population threshold often enough that the
  symptom started manifesting reliably.

## 0.1.0-alpha.2 — 2026-05-20

- **Nav-pane navigation: dramatically faster on big docs.**
  Clicking a heading in the nav pane used to pay a full-doc
  layout pass on every click — about 2 seconds on a 2000-card
  debate file, paid regardless of whether the destination was
  already on screen. The scroll algorithm now does an optimistic
  `scrollIntoView` against whatever layout state already exists,
  then iteratively refines (up to 10 frames) when cv:auto's
  placeholder heights caused the first try to land imprecisely.
  Result: clicks where the target heading is already visible
  cost a few ms; clicks into fresh regions of the doc pay only
  what cv:auto would have charged anyway for materializing the
  destination, instead of re-laying-out the entire doc each
  time. The per-keystroke editing-perf win from cv:auto is
  preserved end-to-end (we no longer flip it off at all).
- **Chrome scale — Mod-Alt-= / Mod-Alt-- / Mod-Alt-0.** Three
  new keybindable commands (`chromeScaleUp` / `chromeScaleDown`
  / `chromeScaleReset`) that scale the whole window — chrome
  AND doc content together — the same way the browser's built-
  in Ctrl-+ chord does. On Electron this drives Chromium's
  `webFrame.setZoomFactor`, so layout reflows at the new
  factor rather than just resizing pixels. Helpful on high-DPI
  displays where the chrome reads too small, or low-DPI where
  it crowds the editor. No-op on the web edition (use the
  browser's own page-zoom). No ribbon button — keyboard-only
  (the chord is shown in Settings → Keybindings and can be
  rebound). The editor's existing `Mod--` / `Mod-=` zoom stays
  separate, so you can dial doc content size up or down on top
  of the page-zoom factor.
- **Bug fix — Nav-pane drag drop-back precision.** When you grab
  a heading in the nav pane, the pane inserts thin drop-indicator
  bars between every entry to show valid drop slots. The cursor
  still followed the pickup pill, but the pile-of-indicators
  above the source heading pushed the source's slot down out from
  under the cursor — so releasing without moving (a "drop it back
  where it came from" gesture) landed the heading in a sibling
  slot instead. The source `<li>` now anchors at its original
  screen-Y for the duration of the drag, so a no-move release
  reliably drops back into the original slot. Other entries
  still shift down by the full indicator stack, so the nav pane
  still visibly expands at drag-start (the affordance you'd
  expect).
- **Bug fix — Multi-pane → single-window switch was losing open
  docs.** Toggling from the three-pane workspace back to one-doc-
  per-window only restored the active pane; the others were
  silently dropped. Root cause was a journal-write race: two IPC
  writes to the same crash-recovery file could land at once,
  producing a valid-JSON-then-garbage file that the post-reload
  reader threw out as corrupt. Writes are now serialized per uid
  and committed via an atomic rename, so journals stay valid even
  under concurrent edit-debounce + mode-switch traffic.
- **Accessibility — Reduce motion.** Settings → Accessibility →
  Reduce motion: System / On / Off. System (default) follows the
  OS `prefers-reduced-motion` preference. On flattens all
  animations and transitions in the UI (drag-pickup vacuum,
  popover slides, save-flash pulse, smooth scrolls) to effectively
  instant. Off forces full motion even when the OS asks for
  reduced — useful for users on an OS where the setting is
  always-on but they prefer animations in this app.
- **Accessibility — Body-font readability presets.** The Settings
  → Appearance → Body font dropdown now groups options by
  category, with "Recommended for readability" leading. Three
  bundled SIL OFL fonts ship with the app so every install has
  a readability-tuned choice regardless of what's on the host OS:
  **Atkinson Hyperlegible** (Braille Institute; designed for low
  vision, disambiguated letter pairs), **Lexend** (Font Bureau;
  the readability-tuned sans-serif with the strongest positive
  reading-speed evidence among "dyslexia fonts"), and
  **OpenDyslexic** (weighted-bottom shapes; preferred by some
  dyslexic readers — independent studies have NOT shown
  reading-speed improvements vs. Arial, but the option is
  popular). The British Dyslexia Association's 2023 endorsed
  system sans-serifs (Verdana, Tahoma, Comic Sans MS) follow
  when installed; remaining groups are "Microsoft Office
  defaults", "Apple defaults", "Open-source / cross-platform",
  and "Generic". Groups whose fonts aren't available are hidden.
- **"Open with CardMirror" actually opens the file on desktop.**
  `.docx` and `.cmir` are now registered file associations in the
  electron-builder config, so the installers wire up CardMirror
  as a right-click "Open with…" target (and as the default-app
  candidate for both extensions). The main process gained a
  single-instance lock plus open-file / second-instance / argv
  handling so double-clicking a registered file in Finder /
  Explorer / a file manager opens that file in CardMirror —
  spawning a new window when the app is already running, or
  launching directly into the file if the app wasn't open. Web
  edition unchanged.
- **Built-in countdown timer.** Native replacement for Verbatim's
  bundled timer. New ⏱ button in the right side of the ribbon
  (next to ⚙) toggles a timer panel into the ribbon's left edge.
  The panel has a big speech-timer display, Start/Pause, three
  speech-duration presets (default 9/6/3 minutes), Aff and Neg
  prep clocks (default 10 minutes each, blue and red), and a
  Reset column that re-fills the prep balances. Click a preset
  to load it (paused — hit ▶ to start). Click Aff or Neg to make
  that side's prep clock the active countdown. Type into the big
  display while paused to set a custom duration. Prep balances
  persist across closes; speech timer doesn't. Cross-window
  sync via BroadcastChannel — open the timer in two windows
  AND the visibility toggle in lockstep too: arming the panel
  in one window opens it in every CardMirror window. New
  Settings → Appearance entries:
  **Timer profile** (High school 3/5/8 + 8 min prep, College
  3/6/9 + 10 min prep, Pomodoro 25/15/5). Each profile's
  three preset durations and prep length are independently
  editable in Settings — pick a profile, then dial the four
  numbers to whatever your league actually uses. Switching
  profiles refills the prep clocks to that profile's total.
  **Compact timer layout** (drops the preset buttons, tucks
  Reset under Start). **Flash timer when countdown is low**
  (flashes the display red as remaining drops below 5 / 3 / 1
  seconds; the flash thresholds are editable too). **Prep
  side label** (Both / Text / Color) — controls how the Aff /
  Neg sides are labeled, with a color-only mode for a quieter
  panel.
- **"About this install" block at the bottom of Settings →
  General.** A read-only diagnostic section below a divider
  showing app version, host (Desktop / Web), operating system,
  and the full user-agent string — easy to copy-paste into a bug
  report. On desktop, two action buttons live underneath:
  **Check for updates** (mirrors Help → Check for Updates…,
  toast surfaces the result) and **Open crash dumps folder**
  (mirrors the Help-menu item) so both actions are now reachable
  from Settings.
- **Every ribbon action is now bindable.** Twelve previously
  click-only ribbon actions are now registered commands in the
  keybinding registry, available in Settings → Keybindings. None
  ship with a default binding — they're all already reachable via
  the ribbon, so a default chord would just be noise. The new
  bindable commands: increase / decrease font size by 1 pt,
  apply font color, open settings, toggle paragraph integrity,
  open each color picker dropdown (highlight / shading / font
  color), open the font-size picker, and open the doc / card /
  table tools menus.
- **Active doc filename in a ribbon pill (opt-in).** New Settings
  → Appearance → "Show doc name in ribbon" toggle (default off).
  When on, the active doc's filename appears as a pill centered in
  the ribbon between the comments toggle and the settings button.
  Useful on platforms / layouts where the OS title bar isn't
  visible: tiling window managers without decorations,
  hidden-title-bar themes, web edition embedded in another page,
  etc. Long filenames ellipsis-truncate with the full name in the
  tooltip. The chip hides when there's no filename yet
  (untitled / fresh doc before Save-As), in multi-pane mode (each
  per-pane chip already shows the slot's doc), and falls out of
  the ribbon's progressive-hide cascade between paragraph styles
  and the format-menu cluster when the ribbon runs out of room.
- **Multi-pane window title summarizes all open slots.** The OS
  window title in multi-pane mode used to show just the focused
  doc's filename. It now shows every non-empty slot's filename
  joined by `·` — e.g. "Foo · Bar — CardMirror" — so the title
  bar conveys the whole workspace at a glance rather than
  changing with every focus shift. Single-doc mode unchanged.
- **Fixed: Copy Last Cite now finds cite_mark text you just
  applied.** Adding the cite mark to a word in a body paragraph
  is supposed to promote that paragraph to a `cite_paragraph`
  (the cite classifier plugin does this automatically). But the
  classifier was gated on a "did the doc change?" range that
  excluded mark-only transactions — `AddMarkStep` doesn't shift
  any positions, so its step-map was empty and the classifier
  bailed early. Result: the paragraph stayed a regular
  `paragraph`, and Copy Last Cite fell through to whatever older
  `cite_paragraph` it could find further up the doc. The same
  silent-skip affected the named-style normalizer (it would
  miss underline/cite/emphasis conflicts created via mark-add
  transactions). Both now see mark-only transactions.
- **F8 / Apply Cite Style now expands to the word at the cursor**
  when there's no selection — matching the behavior F10 / Apply
  Emphasis Style already had. Previously pressing F8 with the
  cursor in a word silently did nothing; users had to double-click
  to select the word first.
- **Fixed: Underline / Emphasis font-size settings were dead.**
  Settings → Styles → font size for the Underline and Emphasis
  styles did write a CSS variable, but no CSS rule consumed it, so
  the change was silently dropped. The marks now pick up
  `--pmd-size-underline` / `--pmd-size-emphasis` and behave like the
  other per-style size knobs.
- **Image alt text is now editable and round-trips through Word.**
  Three changes that ship together:
  - Right-clicking an image shows a new **Edit alt text…** menu item
    (above the AI options, always enabled). Opens a multi-line dialog
    pre-filled with the current alt text; saving writes the new value
    back to the image node and survives docx export.
  - The OOXML importer now reads `wp:docPr@descr` (with `pic:cNvPr@descr`
    as a fallback for older producers) into `image.attrs.alt`. Previously
    the importer dropped alt text on the floor; exporting was the only
    half of the round-trip that worked.
  - The AI alt-text generator now updates `image.attrs.alt` as well as
    inserting the visible `[ALT TEXT: …]` bracket. If the image already
    has alt text on its attribute, the AI command pops a dialog
    showing the existing alt text and offers **Keep current** (copy it
    to a bracket below the image, no API call) or **Regenerate with
    AI** (overwrite both the attribute and the bracket).
- **Dark mode.** Settings → Appearance → Theme: Light / Dark /
  System (default). System mode tracks the OS-level
  `prefers-color-scheme` and switches live when the user changes
  their system appearance. Sibling toggle, **Apply theme to the
  document area**, defaults off — the chrome (ribbon, nav, status
  bar, settings panels) follows the dark theme but the document
  itself stays light / paper-like. Flip on for full dark. User
  per-token color overrides win over either theme via inline
  style on `<html>`.
- **Accessibility settings section** (new tab, far right of the
  Settings dialog).
  - Highlight + shading display overrides moved here from
    Appearance. Replaced the single-color picker with **1–3
    ordered slots** that map to source colors by usage
    frequency. Slot 1 → most-common color in the doc, slot 2 →
    second-most-common, last slot = catch-all for everything
    else. Frequency ranking is incremental + debounced, and
    inactive when only one slot is set, so big docs don't pay
    perf cost unless they're using the multi-color feature.
  - **Per-token color overrides** panel: every UI color in the
    interface (background, borders, accent, hover, status, find
    decorations, table chrome, etc.) is overridable with a
    color picker + alpha slider. Reset-per-row + reset-all
    affordances. Overrides win over the active theme and any
    future preset (high-contrast, colorblind-friendly, etc.).
- **Cursor-position color readout** on the status bar. Visible
  only when an override is on. Shows the ACTUAL stored colors on
  the run at the cursor ("Hl: Yellow · Sh: Protected Grey") so
  you don't lose awareness of what's encoded in the doc while
  the override hides it from view.
- New setting: **default file format for new docs**. Pick `.docx`
  (default — Word- / Verbatim-compatible) or `.cmir` (CardMirror's
  native format, enables autosave); the Save-As dialog defaults to
  that format for any doc that doesn't yet have an on-disk handle.
  Existing files on disk still re-save in whatever format they were
  opened from.
- New setting: **jump to doc top when read mode toggles**. Off by
  default (today's stay-put behavior). When on, toggling read mode
  in either direction scrolls to the top of the doc and places the
  cursor at the start.
- Zoom in / out / reset and the highlight / shading paint-mode
  toggles are now registered ribbon commands, so users can bind
  them to keys via Settings → Keybindings. Default bindings:
  `Mod-=` for zoom in, `Mod--` for zoom out; `zoomReset` and the
  paintbrush toggles ship unbound (`Mod-0` is a browser-level
  reset that Chromium won't always let the page intercept, so the
  status-bar reset button remains the discoverable affordance).
- Keyboard-shortcut command labels (Settings → Keybindings) now
  use consistent title casing across the board.
- **Find and Replace** (Ctrl-F / Ctrl-H / Alt-F). Floating bar in
  the upper-right with case-sensitive and whole-word toggles,
  next / prev navigation, a match count, Replace, and Replace
  All. Every match is highlighted in light yellow; the
  currently-active one gets a stronger orange band. Escape
  closes and restores editor focus.

  Result ordering:
  - **Ctrl-F** (categorized): hits in headings come first, then
    tags, then cites, then everything else. Within each group,
    the closest match to your cursor ranks first (cursor counts
    as the top — matches after wrap around to matches before).
    The category priority is reorderable in Settings → General.
  - **Alt-F** (proximity-only): ignores categories — just orders
    by proximity to the cursor.
  - **Ctrl-H** opens the find+replace bar with the same
    categorized ordering as Ctrl-F.

  Surfaces beyond the floating bar:
  - **Expandable results panel** below the bar — toggles open
    via a chevron, lists every match with surrounding context,
    and clicking an entry jumps to it. Open/closed state
    persists per session via `findResultsExpanded`.
  - **Nav-pane integration** — outline entries whose subtree
    contains a match get a small accent decoration, so you can
    see at a glance which sections of the doc match the current
    query without scrolling through results.
  - **Scope** — search can be restricted to a range (e.g. the
    current selection) instead of the whole doc. Toggling the
    scope chip clears it.
- Re-pressing a heading shortcut (F4 / F5 / F6 / F7 / Mod-F7 /
  Mod-F8) on a paragraph that already has that heading style now
  strips the paragraph's indentation while keeping the heading
  style and all other formatting intact, instead of being a
  no-op.
- Opening a doc now starts both the editor and the nav pane
  scrolled to the top, instead of inheriting the previous doc's
  scroll position.
- A "New document" window spawned while CardMirror is already
  running no longer offers to "recover" the docs you have open
  in other windows. Only the first window of an app session
  surfaces the startup-recovery sidebar.
- The navigation pane can now be hidden. Three ways to toggle:
  the new ☰ button in the View tools section of the ribbon, the
  × close button in the top-right of the nav pane itself, and a
  small pull-tab pinned to the left edge of the viewport (only
  visible when the nav pane is hidden). State is per-window; in
  multi-doc mode the toggle applies to all panes' nav at once.
- The word-count selection button (Σ) moved off the ribbon to
  the left edge of the status bar, next to the live read-aloud
  word counter — same family of question, fewer ribbon buttons.
- Zoom-strip controls (zoom in/out/reset + word-count) are
  slightly smaller and stay centered on the bar.
- Triple-click + drag now extends the selection paragraph-by-
  paragraph (instead of switching back to character-level on the
  first move). Matches Word and most browsers' contenteditable
  default.
- Right-clicking a link now opens a context menu (Open Link /
  Copy Link Address / Edit Link… / Remove Link). Open routes
  through the OS default browser via `shell.openExternal` on
  desktop; Edit reuses the in-app text prompt; Remove strips the
  link mark while preserving the text. Non-link right-clicks
  pass through to the browser / image context menu as before.
- Paint mode (highlight / shading paintbrush) now shows an I-beam
  precision cursor with a small swatch of the active color, so
  you can target characters precisely AND see which color the
  next paint will apply. Picking a new color while paint mode is
  armed updates the cursor live.
- Text selection inside the editor is now translucent (~30%
  alpha) instead of fully opaque, so the underlying highlight,
  shading, and other colors show through. Side effect: you can
  now tell at a glance whether selected text is currently
  highlighted (F11) — the highlight color shows through the
  selection overlay instead of being hidden by it.
- Clicking an image now shows a visible selected state — a 2px
  accent outline so it's obvious the click registered before
  pressing Delete / Copy. Unsupported-format placeholder spans
  also get a subtle background tint when selected.
- The caret no longer hides behind the fixed ribbon (top) or
  status bar (bottom) after Enter / arrow / new-heading actions.
  The browser's auto-scroll-into-view now reserves space for both
  fixed bars via `scroll-padding`.
- Legacy Verbatim character-style ids are now recognized on import
  — pre-modern distributions used `StyleBoldUnderline` for the
  underline mark and `StyleStyleBold12pt` for the cite mark. Files
  from those distributions (e.g. 2013-14 era debate evidence) now
  import with their underlining and cites intact instead of
  silently losing them. Export still normalizes to the current
  styleIds, so re-saving an old file cleans up the rStyle output.
- The AI alt-text generator now ships surrounding context with the
  image — the enclosing card's tag and cite, plus the paragraphs
  immediately before and after the image — so descriptions reflect
  what the image is *doing* in the argument instead of generic
  "a chart with bars" captions.
- Shift-F3 (cycle case) now keeps the selection after each press,
  so the user can re-press to advance to the next case state
  (lower → UPPER → Title → lower) without re-selecting.
- Speech-doc designation now uses the same warm-gold accent in both
  single-window multi-window mode (the banner under the ribbon) and
  single-window multi-pane mode (the per-pane chip), so the "this
  is the speech doc" affordance reads the same regardless of window
  topology.
- The window can now shrink to any size — the previous 800×600
  Electron floor is gone, so the status bar (zoom strip) stays
  on-screen on small / tiled / split-screen layouts. Ribbon
  panels hide progressively when there's literally no room left.
  The cascade is 11 steps, least-essential first: character
  styles → structural styles → doc-name chip → format menu →
  table / image / sub / sup / strike cluster → font-size step
  buttons → highlight + shading + font color panel → comments
  toggle + add-comment → file-ops buttons (Open / New / Save /
  Autosave) → read-mode + nav-pane toggle → settings gear +
  keyboard-shortcut button. The timer toggle (⏱) stays outside
  the cascade so it's always reachable mid-round. The hide/show
  is measurement-driven (not media-query breakpoints), so it
  adapts to chrome scale, OS font size, and which panels are
  even visible to begin with.
- Ribbon cleanup: the plain-paste toggle (`T`) is hidden on desktop
  (F2 reads the clipboard directly there — no armed state to show),
  and the autosave toggle (⏱) is hidden on the web edition
  (autosave requires an on-disk file handle, which the browser
  can't provide).

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
