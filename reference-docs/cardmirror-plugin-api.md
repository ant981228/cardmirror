# CardMirror plugin API v1

The published contract for CardMirror plugins and for flowing apps.
The sources of truth are `src/editor/plugin-api.ts`,
`src/editor/plugin-registry.ts`, `apps/desktop/src/plugin-manager.ts`,
`apps/desktop/src/bridge-handshake.ts`, and
`apps/desktop/src/fast-paste-bridge.ts`.

Stability: **sections 4 and 5 (the cardmirror-bridge handshake and the
HTTP routes) are FROZEN** — flowing apps ship against them, and changes
must stay backward compatible. Adding a route is the one compatible way
to extend the HTTP surface: no existing client calls a path it has
never heard of, so a new route needs no schema bump, while any change
to a route already documented here does. **Sections 1 to 3 and 6 (the
renderer plugin API) are a DRAFT**: v1 plugins are full-trust code (see
the install model below), and a future sandboxed v2 may change this
surface — write plugins against it with that expectation.

Audience: plugin authors and authors of flowing apps. Sections 1 to 3
and 6 cover renderer plugins. Sections 4 and 5 cover cross-app
integration over HTTP.

## 1. Plugin packaging

A plugin is one GitHub repository. Each release attaches two assets:

- `cardmirror-plugin.json` - the manifest.
- `plugin.js` - the built bundle. Only the released bundle loads. The
  repo source format does not matter.

### Manifest fields

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `id` | string | yes | Lowercase. Must match `^[a-z0-9][a-z0-9-]*$`. Cannot be a Windows reserved device name (`con`, `prn`, `aux`, `nul`, `comN`, `lptN`). |
| `name` | string | yes | Display name. |
| `version` | string | yes | Semver, for example `0.1.0` or `0.2.0-beta.1`. |
| `description` | string | no | One line for the Plugins tab. Also shown on your plugin's card in the Browse-plugins picker when it is listed in the public directory. |
| `author` | string | no | Shown in the consent prompt. |
| `apiVersion` | number | yes | Must be `1`. |
| `minAppVersion` | string | no | Oldest CardMirror version that the plugin supports. |
| `repo` | string | never in your release | The installer stamps `owner/repo` into the saved manifest. Update checks read it. Do not set it yourself. |

Example:

```json
{
  "id": "cardmirror-ebb",
  "name": "ebb Flow Integration",
  "version": "0.1.0",
  "description": "Send to flow, send extension, and inverse search for ebb.",
  "author": "smodi",
  "apiVersion": 1,
  "minAppVersion": "0.1.0-beta.18"
}
```

### The curated allowlist

Plugins run with full access to CardMirror and the user's documents, so
the GitHub installer only accepts repositories on a curated allowlist.
The check runs in the main process — the renderer cannot route around
it. The list itself is served by the CardMirror relay at
`GET /plugin-allowlist` (ungated; response
`{ "schema": 1, "repos": ["owner/repo", ...] }`) and consulted fresh on
each install attempt, so listing a new plugin is a server-side change —
no app release. The last fetched list is cached on disk for offline
installs, and a baked-in floor (`PLUGIN_INSTALL_ALLOWLIST` in
`apps/desktop/src/plugin-manager.ts`) covers a machine that has never
reached the relay. An empty or malformed server response is treated as
a failed fetch (cache/baked fallback), never as "block everything". To
get a plugin listed, contact the CardMirror maintainer.

Self-hosted relays serve the same endpoint (see `relay/README.md`):
the fetch goes to whichever relay the client is configured to use, so
a self-hosting operator curates their own users' allowlist via
`RELAY_PLUGIN_ALLOWLIST` on their relay. Its default matches the app's
baked list, so an unconfigured self-hosted relay changes nothing.

Separately from the allowlist, the relay serves a **public plugin
directory** at `GET /plugin-directory` (since 1.4.0) — the browsable,
maintainer-curated subset of the allowlist that appears in the app's
Browse-plugins picker, each entry carrying the name, `description`,
`author`, and `version` from the repo's latest-release manifest.
Allowlisted-but-unlisted plugins stay installable by `owner/repo`;
the directory only controls what is advertised.

Users who understand the trust model can unlock arbitrary-repo installs
from the developer console with `__plugins('community-on')` (persisted;
`__plugins('community-off')` reverts, `__plugins('status')` reports).
The "Load plugin from file..." developer path below is independent of
the allowlist.

### Install flow

1. The user pastes a GitHub URL or an `owner/repo` shorthand into the
   Plugins settings tab — or (since 1.4.0) picks the plugin from the
   Browse list, which fills the same role. Both continue identically.
2. The main process checks the allowlist, fetches the latest GitHub
   release, and downloads the two assets. Each asset must be 5 MiB or
   less.
3. The app validates the manifest and applies the version gates below.
4. The app checks for an id collision. If a different repository
   already owns the id, install fails and asks the user to uninstall
   the existing plugin first.
5. The app stages the release in memory and asks for consent. The
   dialog shows the manifest's name/version/author AND the actual
   `owner/repo` the release came from (which a manifest cannot spoof).
   Nothing touches disk before consent; declining a reinstall leaves
   the existing installed version untouched.
6. On consent, the app writes both files into `userData/plugins/<id>/`
   with an atomic write (tmp file, then rename).
7. The user enables the plugin in the Plugins tab. Enabled plugins
   load from disk at each launch and work offline.

A developer path exists: "Load plugin from file..." in the Plugins tab
loads a local `plugin.js` without an install.

### Uninstall

Uninstalling removes the install directory, the plugin's enabled flag
and storage bag, the user's key overrides for its commands, AND its
live registration — palette rows, keybinding rows, and hotkeys vanish
immediately. One caveat: bundle code that already executed this
session cannot be unloaded; with its commands deregistered it is inert
and fully gone on the next launch. As a backstop, launch reconciles
stored state against the install directories on disk, so a plugin
folder deleted outside the app also gets its leftovers pruned (a
plugin that merely fails to LOAD is still installed and loses
nothing).

### Version gates

- `apiVersion` must equal `1`. Install rejects any other value.
  Registration rejects it again at load time (section 2).
- If `minAppVersion` is newer than the app version, install fails with
  "This plugin needs CardMirror `<minAppVersion>` or newer."
- Both gates also run at every app launch, not only at install. An
  installed plugin that fails the `minAppVersion` gate does not load
  (the app refuses to serve its bundle) but stays LISTED in the
  Plugins tab, marked "needs CardMirror `<version>` or newer" with its
  toggle disabled — it can still be uninstalled.
- The gate is two-sided. At run time, read `api.appVersion` and refuse
  an app that is too old for your plugin.

## 2. Registration

The bundle self-registers. Call the window global once at load:

```js
window.__registerCardMirrorPlugin?.({ /* PluginDefinition */ });
```

The definition types, verbatim from `src/editor/plugin-registry.ts`:

```ts
export const PLUGIN_API_VERSION = 1;

export interface PluginCommandDef {
  /** Must start with `<pluginId>.` */
  id: string;
  label: string;
  keywords?: readonly string[];
  defaultKey?: string | string[] | null;
  run: (api: CardMirrorPluginApi) => void | Promise<void>;
}

export type PluginSettingValue = boolean | string | number;

export interface PluginSettingDef {
  key: string;
  label: string;
  /** `text` renders a single-line input; `multiline` a full-width
   *  textarea (for list-shaped values — one entry per line by
   *  convention). Both hold a plain string value. */
  type: 'boolean' | 'text' | 'multiline' | 'number' | 'select';
  /** Must match `type`; for `select`, must be one of `options`. */
  default: PluginSettingValue;
  /** Required for `select` (the choices), forbidden otherwise. */
  options?: readonly string[];
  /** Muted helper line rendered under the control. */
  description?: string;
}

export interface PluginDefinition {
  id: string;
  name: string;
  apiVersion: number;
  commands: PluginCommandDef[];
  settings?: PluginSettingDef[];
}
```

Rules:

- `id` must match the manifest `id`.
- Every command `id` must start with `<pluginId>.`, for example
  `cardmirror-ebb.sendToFlow`.
- Command ids must be unique, both inside the definition and across
  all registered plugins.
- Every command needs a non-empty `label` and a `run` function.
- Each registered plugin receives one `CardMirrorPluginApi` object,
  minted for its plugin id. Registered commands appear in the command
  palette and the keymap, and (since 0.1.0-beta.22) users can bind
  them to custom ribbon buttons — uninstalling the plugin unconfigures
  any buttons bound to its commands.

### Declared settings (since 0.1.0-beta.22)

The optional `settings` array declares user-configurable settings.
CardMirror renders the controls: an enabled plugin that declared
settings gets a gear on its row in Settings → Plugins, which opens a
modal with one control per entry (checkbox, text field, multiline
textarea, number field, or dropdown). Changes apply immediately —
there is no save step. The `multiline` type (since 1.4.0) renders a
full-width textarea for list-shaped values — one entry per line by
convention; its value is a plain string, and a plugin adopting it
should set `minAppVersion` to `1.4.0`.

- `key` must match `[a-zA-Z0-9][a-zA-Z0-9_-]*` and be unique within
  the plugin.
- Values persist in the plugin's storage bag under the reserved
  `__settings` key, so they survive restarts and are removed with the
  plugin on uninstall.
- Read values with `api.settings.get(key)` (section 3). A stored value
  that no longer matches the declared type — or, for `select`, is no
  longer among `options` — reads as the declared `default`.
- The gear only appears while the plugin is enabled: a disabled
  plugin's bundle never ran, so its declared settings are unknown to
  the host.

### Failure behavior

Registration never throws and never crashes the app. The registry
rejects a bad definition, writes a console warning, and shows the
toast "Plugin failed to load: `<reason>`". Rejection reasons:

- `apiVersion` is not `1`.
- The plugin id is missing, or a plugin with that id is already
  registered.
- `commands` is not an array.
- A command id lacks the `<pluginId>.` prefix, or is a duplicate.
- A command lacks a `label` or a `run` function.
- A declared setting is off-shape: bad or duplicate `key`, missing
  `label`, unknown `type`, a `default` that doesn't match `type`, a
  `select` without a non-empty `options` list (or whose `default`
  isn't among them), or `options` on a non-`select` type. One bad
  setting rejects the whole registration.

A `run` function that throws, or that returns a rejected promise, does
not crash the app. The registry logs the error and shows a toast with
the plugin name.

## 3. The capability API

Each command's `run` receives one `api` argument. The full surface,
verbatim from `src/editor/plugin-api.ts`:

```ts
export type ExtractedKind =
  | 'pocket'
  | 'hat'
  | 'block'
  | 'tag'
  | 'analytic'
  | 'undertag'
  | 'cite';

export interface ExtractedItem {
  kind: ExtractedKind;
  text: string;
  /** Opaque provenance token (see plugin-source-token.ts). */
  source: string;
}

export interface ExtractResult {
  ok: true;
  docId: string;
  docTitle: string;
  items: ExtractedItem[];
}

export type ExtractErrorCode = 'no-heading-at-cursor' | 'no-active-doc' | 'empty-selection';
export interface ExtractError {
  ok: false;
  error: ExtractErrorCode;
}

export type JumpResult =
  | { ok: true }
  | { ok: false; error: 'doc-not-open' | 'not-found' | 'bad-request'; docTitle?: string };

export interface FlowAppInfo {
  id: string;
  app: string;
  appVersion: string;
  schema: number;
  kind: 'flow';
  /** A session file exists AND the app answered /ping just now. */
  running: boolean;
}

export type FlowPostResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; error: 'no-such-app' | 'app-not-running' | 'timeout' | 'bad-response' | 'unsupported' };

export interface PluginStorage {
  get(key: string): unknown;
  /** `__settings` is reserved for declared-setting values (section 2). */
  set(key: string, value: unknown): void;
}

export interface PluginSettingsApi {
  get(key: string): boolean | string | number | undefined;
  onChanged(cb: (key: string, value: boolean | string | number) => void): () => void;
}

export interface CardMirrorPluginApi {
  readonly appVersion: string;
  extractSelection(): ExtractResult | ExtractError;
  jumpToSource(token: string): Promise<JumpResult>;
  flowApps(): Promise<FlowAppInfo[]>;
  flowPost(appId: string, route: string, body: unknown): Promise<FlowPostResult>;
  docInfo(): { docId: string; docTitle: string } | null;
  showToast(message: string): void;
  storage: PluginStorage;
  settings: PluginSettingsApi;
}
```

### Methods

- `appVersion` - the CardMirror version string. Use it for your own
  compatibility check.
- `extractSelection()` - synchronous typed extraction from the focused
  document (rules below). If the document has no `docId` yet, the call
  mints and stamps one.
- `jumpToSource(token)` - scroll to and select the source of an
  extracted item. The resolver tries the focused document first, then
  every open window. `doc-not-open` carries `docTitle` so you can tell
  the user which document to open.
- `flowApps()` - every REGISTERED flowing app from the handshake
  directory (section 4), each with a `running` flag from a liveness
  ping. Closed apps are listed with `running: false` — selection UIs
  must not require an app to be running; a send to one fails at
  runtime with `app-not-running`.
- `flowPost(appId, route, body)` - a brokered loopback POST to a
  flowing app. The main process reads the target's handshake files,
  attaches the token header, and applies a timeout. Plugins never see
  tokens or sockets. `unsupported` means the desktop host surface is
  absent. The `ok` field shows transport success only. Read the
  `status` field for the HTTP result.
- `docInfo()` - `docId` and `docTitle` of the focused document, or
  `null` when there is none or the doc has no id yet.
- `showToast(message)` - a transient notification in the app.
- `storage` - per-plugin persistent key-value storage. Values must be
  JSON-serializable. The `__settings` key is reserved (section 2).
- `settings` (since 0.1.0-beta.22) - values of the settings declared in
  the definition. `get(key)` returns the current value (the declared
  default when the user hasn't set it) or `undefined` for undeclared
  keys. `onChanged(cb)` fires when the user changes a value in the
  settings modal and returns an unsubscribe function — most plugins
  can skip it and read lazily in each command's `run`.

### Extraction rules

The selection rule:

- An explicit selection wins. Extraction walks only the selected range.
- A collapsed cursor expands to the enclosing heading section: from
  the nearest enclosing heading to the next heading of the same or a
  shallower level.
- A cursor above all headings returns `no-heading-at-cursor`. Core
  does not guess.
- A range that yields no items returns `empty-selection`.
- No focused document returns `no-active-doc`.

The item rules, in document order:

- Pocket, hat, block, tag, and analytic nodes emit their full text.
- Cite paragraphs emit the short cite only, with kind `cite`.
- Undertags always emit, with kind `undertag`. The plugin decides what
  to do with them: skip, treat as header, or treat as extension.
- Card bodies and loose paragraphs never emit. This rule is deliberate
  and has no override.
- Whitespace in each item collapses to single spaces. Empty items are
  dropped.

Heading attribution per item: pocket, hat, block, tag, and analytic
items carry their own heading UUID. An undertag or cite inside a card
carries the UUID of the parent card's tag or analytic. A top-level
undertag carries the UUID of the nearest preceding heading.

### The source token

Each extracted item carries one provenance string in `source`. The
current format starts with the `cmsrc1` prefix. The token is opaque:

- Store it.
- Pass it back verbatim, to `jumpToSource` or to the `/jump`,
  `/replace` or `/insert-after` route.
- Replace your stored copy whenever a route hands you a new one.
  `/replace` does, because rewriting the text invalidates the token
  that anchored on it (section 5). `/insert-after` hands back a token
  for the line it just created: store that one as the new item's, and
  keep the anchor's unchanged.
- Never parse it and never build one. Only CardMirror mints and parses
  tokens. A future format change bumps the prefix, and old tokens stay
  valid.

What a token survives, and what it does not:

- **The line being rewritten in CardMirror.** A heading kind - pocket,
  hat, block, tag, analytic - carries a stable id, so retyping the line
  leaves the token resolving.
- **A cut and paste can give the pasted heading a new id.** The token then
  falls back to its text and the context around it, which a move
  changes, so expect `not-found` after the user moves a line by
  clipboard. A nav-pane drag moves the node whole and keeps the id.
- **An undertag or a cite has no id**, so a token naming one resolves by
  its text and the context around it, searched INSIDE the card (or
  section) it was extracted from. Two cards worded identically therefore
  never get confused for each other, and a token whose own line is gone
  answers `not-found` rather than retargeting a look-alike elsewhere. A
  rewrite of nearby text survives; a move of the line to another card does
  not.
- **A token names one line, never its heading.** An undertag's token
  addresses that undertag, and a cite's addresses that cite - `/replace`
  and `/insert-after` act on the line you were given, not on the tag above
  it. Tokens minted by earlier builds conflated the two; they are still
  accepted and resolve to the right line, and a `/replace` through one
  hands back a corrected token - which is one more reason to store every
  token a route returns.
- **Deleting the line loses it**, which is the honest answer:
  `not-found`.
- **A move to a DIFFERENT document loses it.** A token names one
  document, and the routes refuse a token whose document is not the one
  they resolve against.

## 4. The cardmirror-bridge handshake

This section and section 5 are the frozen cross-app contract. Flowing
apps build against this file format and these routes. Changes require
a schema bump.

Each debate app announces its local HTTP endpoint in a shared
directory. The directory per platform:

- macOS: `~/Library/Application Support/cardmirror-bridge/`
- Windows: `%APPDATA%/cardmirror-bridge/`
- Linux: `$XDG_DATA_HOME/cardmirror-bridge/` (fallback
  `~/.local/share/cardmirror-bridge/`)

Each app writes TWO files, atomically (write a tmp file, then rename
it into place):

- `<appId>.json` — the IDENTITY file. Written on launch, **never
  deleted**. This is what app pickers list, so a closed app stays
  selectable in a peer's settings.
- `<appId>.session.json` — the SESSION file. Written on launch with a
  fresh token, **deleted on quit**. Its absence means the app isn't
  running right now.

CardMirror writes `cardmirror.json` / `cardmirror.session.json` with
`kind: "editor"`. Flowing apps register with `kind: "flow"`. The file
name (without the suffix) is the app id and must match
`^[a-z0-9][a-z0-9-]*$`.

Identity file, schema 1:

```json
{
  "schema": 1,
  "app": "ebb",
  "appVersion": "0.3.0",
  "kind": "flow"
}
```

Session file:

```json
{
  "port": 17700,
  "token": "hoyfR3k9vXqLmZ2wN8cT1bUj",
  "pid": 12345
}
```

Rules:

- The token is random and rotates each session — which is WHY the
  session data lives in its own deleted-on-quit file: a kept combined
  file would advertise a dead or wrong endpoint.
- Every request between apps carries the target's token in the
  `X-Bridge-Token` header. The receiver must compare it in constant
  time.
- Liveness: a reader sends `GET /ping` with the token before it trusts
  a session file. A stale session from a crashed process fails the
  ping and reads as "registered but not running" — never as absent.
  Sending to a registered app with no live session fails with
  `app-not-running`; a dead connection is a runtime error, not a
  reason to hide the app from selection.
- Before SENDING, check the session file's `pid` is still alive (e.g.
  `kill(pid, 0)`; treat EPERM as alive) and map a dead pid to
  `app-not-running` without touching the port. A dead writer proves
  the file is stale — whatever answers that port now is not the app
  that wrote it. This is cheaper than a ping and catches what a ping
  cannot (any process answers a knock); a crashed-and-relaunched app
  self-heals by writing a fresh session file, and pid recycling merely
  degrades the check to a plain failed send.
- Create the directory `0700` and write both files `0600` where the
  platform supports modes — session tokens must not be readable by
  other users on a shared machine.
- Bind the endpoint to `127.0.0.1` only. Never bind `0.0.0.0`.
- Compatibility: a reader should tolerate a combined single
  `<appId>.json` carrying `port`/`token` (the pre-split shape) by
  treating those fields as the session. Writers must produce the
  two-file form.

## 5. CardMirror's HTTP routes for flowing apps

CardMirror serves these routes on the port in `cardmirror.json`. All
routes require the token, in `X-Bridge-Token` or in the legacy
`X-FDP-Token` header. A request with an `Origin` or `Referer` header
is rejected with 403; those requests come from browser pages.

### Identity and consent (since 0.1.0-beta.23)

Every route EXCEPT `/ping` also requires an **`X-App-Id`** header: a
stable identifier for the sending app matching
`^[a-z0-9][a-z0-9-]{0,63}$` (use your bridge identity-file id, e.g.
`X-App-Id: ebb`). New routes added to this surface inherit this
requirement by default unless explicitly classed as discovery.

The user picks the overall policy in Settings → Plugins → External
apps: **Ask for each app** (the default — everything below describes
this mode), **Allow all** (every sender accepted, identification
optional — the pre-identity behavior, kept so legacy senders like old
Fast Debate Paste builds still work when the user opts into it), or
**Block all**. Clients MUST still send `X-App-Id` — the default mode
rejects requests without it.

The first request from an app raises a consent prompt in CardMirror
naming the app (name + version come from its registered identity file
when present, else the raw id): **Always Allow / Allow Once / Deny**.
Always/Deny are remembered and manageable under Settings → Plugins →
External apps; dismissing records nothing and asks again next time.
One decision covers the whole gated surface — a denied app can
neither insert, jump, replace, nor add a line beside an item. This is
consent UX for cooperating local apps, not a security boundary:
identity is self-declared, and any same-user process is inside the
trust line regardless.

While the prompt is open, requests are **queued** (up to 10 per app,
arrival order) and answered with:

```json
{ "ok": true, "inserted": false, "pending": "consent" }
```

(`jumped` instead of `inserted` on `/jump`; `/replace` and
`/insert-after` carry neither.) Do not retry — if the user allows, the
queued actions apply immediately, so their click is the redo; if they
deny or dismiss, the queue is discarded. Show something neutral like
"waiting for approval in CardMirror".

Consent-layer errors, all HTTP 200 with `ok: false`:

| Error | Meaning | Client behavior |
| --- | --- | --- |
| `unidentified` | No/invalid `X-App-Id`. CardMirror also tells its own user the sending app needs an update. | Terminal. Ship the header. |
| `inserts-disabled` | The user turned off "Accept inserts from external apps". | Terminal; surface it, don't retry. |
| `not-allowed` | The user denied this app (or its consent queue overflowed). | Terminal; surface it, don't retry. |

Never fall back to alternative delivery (keystroke synthesis etc.) on
these errors — that would bypass a decision the user made on purpose.
Reserve fallbacks for transport-level failures (connection refused,
timeout).

`/ping` stays identity-free — discovery has to work before identity
exists — and deliberately content-free: it must never grow doc
titles, paths, or previews. Anything content-bearing belongs behind
an identified, consented route.

### GET /ping

Liveness and capability probe. Response, schema 2:

```json
{
  "ok": true,
  "app": "cardmirror",
  "appVersion": "0.1.0-beta.18",
  "schema": 2,
  "hasActiveDoc": true
}
```

`schema: 2` signals that `/jump` is available. It does not move for a
route added after it: probe a newer route by calling it and reading
the status code (see `/replace`).

### GET /docs (since 0.1.0-beta.23)

Every open document across every CardMirror window and pane — the
address book for doc-targeted inserts. Identified + consented (doc
titles are content; one per-app decision covers docs/insert/jump).

```json
{ "ok": true, "docs": [
  { "target": "u-3f9c…", "title": "1AC — Ports.cmir", "focusedWindow": true, "isSpeech": false },
  { "target": "u-88a1…", "title": null, "focusedWindow": false, "isSpeech": true }
] }
```

`target` is an opaque, SESSION-SCOPED token (it does not survive a
CardMirror restart — re-list rather than persisting it). `title` is
null for never-saved docs. `isSpeech` marks the doc currently
designated as the speech doc (at most one, across all windows) — a
client offering a "send to the speech doc" mode should re-list and
target it at send time rather than caching, since the designation
moves. While consent is pending the response is
`{ "ok": true, "docs": null, "pending": "consent" }` — re-query after
the user decides.

### POST /insert

Insert text into a document. This route predates the plugin API;
since 0.1.0-beta.23 it also requires `X-App-Id` and consent (see
above). The full wire contract is in `cardmirror-integration-spec.md`
in this folder. In short: the body is
`{ "text": "...", "role": "...", "newParagraph": true, "omitted": false }`,
and the response is
`{ "ok": true, "inserted": true, "docTitle": "...", "sources": ["cmsrc1..."] }`
or `{ "ok": false, "error": "no-target-doc" | "doc-readonly" | "bad-request" }`
— plus the consent-layer responses above.

**Roles** (since 0.1.0-beta.23; older CardMirrors degrade unknown
roles to `card` silently, so the failure mode against an old build is
wrong FORMAT, not an error):

| `role` | Result |
| --- | --- |
| `card` (default), `body`, `cite` | Body paragraphs at the cursor (the pre-role behavior). |
| `inline` | Bare characters at the cursor (`newParagraph: false` semantics). |
| `pocket` / `hat` / `block` | One doc-level heading per line of `text`, each with a fresh heading id. |
| `tag` | One new card per line, headed by that tag. |
| `analytic` | One new analytic_unit per line, headed by that analytic. |

Heading roles never insert at a raw caret — they snap to the nearest
outline slot a drag-and-drop would use (so a mid-card cursor can't
split the card) — and a heading role outranks `newParagraph`.

**Rich payloads** (since 1.5.0, additive): the body may carry an
optional `"html": "<...>"` field (2 MiB max) alongside `text`. A
rich-aware CardMirror parses it through the document schema in an
inert DOM — only schema-valid content survives, so scripts and
unknown markup are simply dropped — and inserts the result with full
fidelity: CardMirror-native HTML (the app's own serialization format,
which is what a copy from CardMirror produces) round-trips structure,
highlight colors, and cite/underline marks exactly. Whole cards and
headings snap to the nearest valid outline slot like the heading
roles; purely inline content follows `newParagraph`. **`text` remains
required** — it is the fallback rendered by an older CardMirror
(which ignores `html`) and by a rich-aware one when the html parses
to nothing, so always send a faithful plain-text version. When `html`
is used, `role` and `citeTokens` are ignored: the markup carries its
own structure and marks.

**Cite emphasis** (since 1.3.0, additive): a role-`cite` text insert
may include `"citeTokens": ["Smith", "24"]` — verbatim substrings of
the first line styled with the cite mark on arrival. Ignored by older
CardMirrors and when `html` is used.

**Provenance: `sources`.** On success a heading-role insert also
carries `sources` - one `cmsrc1` token per line of `text`, in document
order, minted for the heading that line became. They are the same
tokens `/extract` emits, so each one is a full handle to the line you
just dictated: `/replace` rewrites it, `/insert-after` adds under it,
`/jump` steers the user to it. Store them the way you store extracted
items; nothing else in the reply identifies what you wrote.

`sources` is ABSENT, not empty, in every other case:

- **A body-ish role** - `card`, `body`, `cite`, or `inline` /
  `newParagraph: false` with one of them. Those land as card body text
  or a loose paragraph, and `/replace` and `/insert-after` refuse both
  as `body-text` - so a token there would be a handle to a line you
  could never use. The route does not link this kind of insert at all.
  (A heading role still reports its headings under
  `newParagraph: false`: the role outranks the flag, so what landed is
  a heading either way.)
- **A queued insert** (`{ "ok": true, "inserted": false, "pending":
  "consent" }`). Nothing has landed yet, and the tokens minted when the
  user's Allow replays it have no reply left to travel on.
- **An older CardMirror**, which never sent the field.
- **A doc-targeted heading insert into a document that has never been
  saved.** A token names a document, and an unsaved one has no
  persistent id to name yet. The focus-follow path mints that id on the
  spot; an addressed background pane does not, because stamping an
  identity onto a document the user is not looking at belongs to that
  document's own first save.
- **A heading insert CardMirror could not verify.** Every token is
  checked against the document that actually landed; if one heading is
  not where it was expected, the whole field is dropped rather than
  shipped short or naming the wrong line. An absent `sources` is
  provenance lost, never an insert that failed: `ok` and `inserted`
  still report what happened to the text.

So test for the field, never for its length, and treat "no `sources`"
as "this line is not linked" - not as an error and not as a reason to
re-send.

**Targeting.** Two modes, the caller's choice per request:

- **Doc-targeted** (since 0.1.0-beta.23): include
  `"target": "<token from GET /docs>"` in the body. The text lands in
  that exact document — the right pane of a three-pane window, a
  background window, anywhere — without CardMirror needing or taking
  focus. A closed-since-listed doc answers
  `{ "ok": false, "error": "target-not-found" }`; never a fallback to
  a doc the caller didn't name.
- **Legacy / focus-follow** (no `target`): the focused CardMirror
  window's active pane, else the most recently focused window's (so a
  flow app can send while it holds focus itself). An app steering by
  window (an OS-window target picker) should activate that window
  before calling — focus is the only window-addressing this mode has.
  Never an arbitrary window.

### POST /jump

Inverse search: jump to the source of an extracted item. Requires
`X-App-Id` and consent (see above) — jump steers the user's editor
and steals focus, so a denied app can't do it either. Send the
stored source token, verbatim:

```json
{ "source": "cmsrc1.eyJkb2NJZCI6..." }
```

On success, CardMirror focuses the right window, scrolls to the
source, and selects it:

```json
{ "ok": true }
```

Error responses:

| Error | HTTP status | Meaning | Extra field |
| --- | --- | --- | --- |
| `doc-not-open` | 200 | The token's document is not open in any window. | `docTitle` - show "open `<docTitle>` first". |
| `not-found` | 200 | The document is open, but the heading and the text anchor both failed to resolve. | none |
| `bad-request` | 400 | The body is not JSON, `source` is missing, or the token does not parse. | none |

Example `doc-not-open` response:

```json
{ "ok": false, "error": "doc-not-open", "docTitle": "AT - Cap K" }
```

### POST /replace

Update the text of an item a flowing app previously received: the
companion app's user edits their copy, and the document follows.
Requires `X-App-Id` and consent (see above), governed by the SAME
per-app decision as `/insert` and `/jump` - one decision covers the
whole gated surface, so an app allowed to insert is allowed to
replace. Send the stored source token verbatim plus the new text:

```json
{ "source": "cmsrc1.eyJkb2NJZCI6...", "text": "The plan causes poverty." }
```

On success, CardMirror rewrites the item in place and answers with a
token:

```json
{ "ok": true, "source": "cmsrc1.eyJkb2NJZCI6..." }
```

**Store the returned `source` in place of the one you sent.** The
token you sent anchors on the text this call just replaced, so it
stops resolving the instant the edit lands; the reply carries a
freshly minted token for the same item in its new state. This is not
decorative. A caller that ignores the reply gets exactly one
successful edit per item and `not-found` for every edit after that -
including from `/jump`, which reads the same tokens.

**One textblock, one line.** The token names a single textblock (a tag,
an analytic, an undertag, a cite), and the route replaces that block's
whole content. It never edits part of a block, and it never splits,
joins, or creates nodes: `text` is one line, and a newline in it is
`bad-request` rather than a node split. Send structure through
`/insert`, which has roles for it. There is also no delete - empty or
whitespace-only `text` is rejected, so this route can never remove text
from a document.

**Card bodies are never rewritten.** The route only accepts the kinds
`/extract` emits: pockets, hats, blocks, tags, analytics, undertags and
cites. Card bodies and loose paragraphs are refused with `body-text`,
because they are quoted source text - the one thing in the document that
must stay verbatim. This matches what you were sent: card bodies do not
leave the document through `/extract`, so a token naming one can only
come from an anchor that drifted onto body text, and applying that edit
would corrupt evidence rather than update your item.

Marks carry, approximately. The replacement takes the styling of the
run the replaced range starts on, so a highlighted or underlined tag
does not come back as plain text. That is an approximation and not a
promise: the new text has no correspondence to the old, so nothing is
guaranteed about which words inside the block keep partial
formatting, and marks anchored to that exact run rather than to the
block - a link, a comment range - are dropped on purpose.

The write goes in as one transaction, so the user undoes it with a
single Cmd-Z, and a co-editing session receives it as one step.

**No focus, no scrolling, no caret movement.** Unlike `/jump`, this
route never raises or focuses a window, never scrolls the user's
view, and never moves their caret or selection. That silence is the
point: the route is meant to be called on every settled edit in the
companion app, and one that stole the reader's focus or place per
keystroke would be unusable. When you do want the user's eyes on the
item, call `/jump` yourself.

Error responses:

| Error | HTTP status | Meaning | Extra field |
| --- | --- | --- | --- |
| `doc-not-open` | 200 | The token's document is not open in any window. | `docTitle` - show "open `<docTitle>` first". |
| `not-found` | 200 | The document is open, but the token no longer resolves - the text was edited elsewhere or deleted. (A match inside a read-only mirrored copy does not count, same rule as `/jump`.) | none |
| `doc-readonly` | 200 | The document is open in a read-only view. | none |
| `body-text` | 200 | The token resolves to a card body or a loose paragraph. Card body text is never rewritten; see above. | `docTitle` |
| `internal` | 200 or 500 | CardMirror could not apply the edit, or applied it and could not mint the replacement token. | none |
| `bad-request` | 400 | The body is not JSON or exceeds 64 KiB; `source` is missing or is not a `cmsrc1` token; `text` is missing, empty after trimming, longer than 8192 characters, or contains a carriage return or line feed. | none |

Do not blind-retry `internal` with the same token: the write may have
landed, in which case the token you hold no longer resolves and every
retry is `not-found`. Treat the item as unlinked and re-establish it.

Body validation runs BEFORE the consent gate, so a malformed request
is a 400 even from an app whose first request is still waiting for
approval - a 400 is never a consent problem in disguise.

Plus the consent-layer responses above. While the consent prompt is
open, a replace is queued and answered with:

```json
{ "ok": true, "pending": "consent" }
```

Note what that reply does NOT carry: a `source`. It is not a success.
Do not store anything, do not retry, and do not mark the item as
pushed. If the user allows, the queued replace applies immediately -
their click is the redo; if they deny or dismiss, the queue is
discarded.

Availability: `/ping`'s `schema` does not move for an additive route,
so probe by calling. A CardMirror without `/replace` answers HTTP
**404** with `{ "ok": false, "error": "bad-request" }` - the status
code, not the error string, is what separates "no such route" from
this route rejecting a malformed body with a 400.

### POST /insert-after

Add a line to the document, immediately after an item a flowing app
previously received. `/extract` hands items out, `/replace` edits one
of them, and neither can put text in the document that was never there:
when the companion app's user types a NEW line between two items they
took from a document, that line belongs in the document too. Requires
`X-App-Id` and consent (see above), governed by the SAME per-app
decision as `/insert`, `/jump` and `/replace`. Send the stored token of
the item the new line goes after, plus the text:

```json
{ "source": "cmsrc1.eyJkb2NJZCI6...", "text": "And a second reason it fails." }
```

On success, the line is in the document and the reply carries a token
for it:

```json
{ "ok": true, "source": "cmsrc1.eyJkb2NJZCI6..." }
```

**Store the returned `source`: it is the only handle to the line you
just created.** Unlike `/replace`, which re-mints a token for text you
already had one for, this reply names text that did not exist when you
sent the request. Drop it and the line is orphaned from your side: you
cannot edit it through `/replace`, jump to it, or insert after it in
turn - you would have to find it by hand. A success without a token is
not something the route ever answers; if it cannot mint one, it answers
`internal` (see below).

**What lands: one sibling of the anchor's own kind.** The kind is read
off the item you named, never sent - an outside app names a line, not a
structure:

| Anchor kind | Result |
| --- | --- |
| `tag` | A new card, headed by a new tag, after the anchor's card. |
| `analytic` | A new analytic_unit, headed by a new analytic, after the anchor's unit. |
| `pocket`, `hat`, `block` | A new heading of the same level, after the anchor. |
| `undertag`, `cite_paragraph` | A sibling of the same kind, inside the same card or unit, right after the anchor. |

A tag is only ever a card's first child and an analytic only ever an
analytic_unit's, which is why those two arrive wrapped in a fresh
single-heading container rather than squeezed in beside the anchor. In
every case **the anchor's own line is untouched** - this route only
adds. Send structure through `/insert`, which has roles for it.

**One line, and plain.** `text` is a single line: a carriage return or
line feed is `bad-request`, not a node split, and empty or
whitespace-only `text` is rejected, so this route can never remove or
reshape anything. The text arrives unstyled. That is the one place it
deliberately differs from `/replace`, which carries the styling of the
run it overwrites: here there is no run to inherit from, and dressing
new text in a neighbour's marks would be a guess about intent.

**Card bodies are never written beside.** The anchor must be one of the
kinds `/extract` emits: pockets, hats, blocks, tags, analytics,
undertags and cites - the same whitelist `/replace` accepts. A token
resolving to a card body or a loose paragraph is refused with
`body-text`, because a card body sibling would mean an outside app
authoring evidence.

The insert goes in as one transaction, so the user undoes it with a
single Cmd-Z, and a co-editing session receives it as one step.

**No focus, no scrolling, no caret movement.** Like `/replace` and
unlike `/jump`, this route never raises or focuses a window, never
scrolls the user's view, and never moves their caret or selection. It is
meant to be called while the companion app's user types.

Error responses:

| Error | HTTP status | Meaning | Extra field |
| --- | --- | --- | --- |
| `doc-not-open` | 200 | Every window answered, and none of them holds the token's document. | `docTitle` - show "open `<docTitle>` first". |
| `not-found` | 200 | The document is open, but the token no longer resolves, so there is no line to add after. | none |
| `doc-readonly` | 200 | The document is open in a read-only view. | none |
| `body-text` | 200 | The token resolves to a card body or a loose paragraph; see above. | `docTitle` |
| `internal` | 200 or 500 | CardMirror could not add the line, **or added it and could not mint a token for it, or a window holding the document did not answer in time.** Anything that might have changed the document without reporting a token is reported here rather than as a definite refusal. | none |
| `bad-request` | 400 | The body is not JSON or exceeds 64 KiB; `source` is missing or is not a `cmsrc1` token; `text` is missing, empty after trimming, longer than 8192 characters, or contains a carriage return or line feed. | none |

**Never retry `internal`, and never retry a transport timeout.** They
are the outcomes where the line may already be in the user's document
with no token coming back, so a retry writes the line a second time -
and the user, not you, is the one who finds the duplicate. Note that
`internal` deliberately absorbs a case `/replace` reports as
`doc-not-open`: a window that holds the document but stops answering.
Bar that line at that anchor for the rest of the session and treat it as
unlinked. Every other error above is definite: nothing was added, so
once you have fixed the cause (or the user has opened the document) the
same request is safe to send again.

Body validation runs BEFORE the consent gate, so a malformed request is
a 400 even from an app whose first request is still waiting for
approval - a 400 is never a consent problem in disguise.

Plus the consent-layer responses above. While the consent prompt is
open, an insert-after is queued and answered with:

```json
{ "ok": true, "pending": "consent" }
```

That is not a success and it carries no `source`. If the user allows,
the queued insert applies immediately - their click is the redo - but
the token minted for it has nobody left to go to, so the line lands
unaddressed; if they deny or dismiss, the queue is discarded. Do not
re-send after an allow: you would add the line twice. Wait for a plain
`ok` before recording anything.

Availability: `/ping`'s `schema` does not move for an additive route,
so probe by calling. A CardMirror without `/insert-after` answers HTTP
**404** with `{ "ok": false, "error": "bad-request" }` - the status
code, not the error string, is what separates "no such route" from
this route rejecting a malformed body with a 400.

Any other path returns 404 with `{ "ok": false, "error": "bad-request" }`.

## 6. A minimal example plugin

`plugin.js` - registers one command. The command extracts the
selection and toasts the item count:

```js
// plugin.js - complete example bundle
window.__registerCardMirrorPlugin?.({
  id: 'item-counter',
  name: 'Item Counter',
  apiVersion: 1,
  settings: [
    {
      key: 'tags-only',
      label: 'Count tags only',
      type: 'boolean',
      default: false,
      description: 'Ignore every extracted kind except tags.',
    },
  ],
  commands: [
    {
      id: 'item-counter.countSelection',
      label: 'Count extracted items',
      keywords: ['count', 'extract'],
      defaultKey: null,
      run(api) {
        const result = api.extractSelection();
        if (!result.ok) {
          api.showToast('Extraction failed: ' + result.error);
          return;
        }
        const items = api.settings.get('tags-only')
          ? result.items.filter((i) => i.kind === 'tag')
          : result.items;
        const n = items.length;
        api.showToast(
          'Extracted ' + n + (n === 1 ? ' item from "' : ' items from "') +
            result.docTitle + '"',
        );
      },
    },
  ],
});
```

`cardmirror-plugin.json`:

```json
{
  "id": "item-counter",
  "name": "Item Counter",
  "version": "0.1.0",
  "description": "Count the items that selection extraction returns.",
  "author": "you",
  "apiVersion": 1,
  "minAppVersion": "0.1.0-beta.18"
}
```

To test it, open Settings, then Plugins, then "Load plugin from
file...", and pick `plugin.js`. Run "Count extracted items" from the
command palette.
