/**
 * Quick Cards — search palette (with the prefix system).
 *
 * A floating command-palette-style bar (see
 * `reference-docs/SPEC-quick-cards.md` §6): opens centered over the
 * target editor pane, results rendered ABOVE the bar, instant focus,
 * a one-shot blue pulse that fades.
 *
 * Prefix system (a small first slice of the eventual full set —
 * search-everything / transclude / quick cards / dropzone / index):
 *   - `q ` → search quick cards only
 *   - `d ` → search the dropzone only
 *   - `c ` → search ribbon commands only
 *   - `s ` → search settings (top-level tabs + individual settings);
 *            selecting one opens that tab and scrolls to the setting
 *   - `w ` → switch to another CardMirror window (desktop only), most
 *            recently used first; the `switchWindow` command opens the
 *            bar with this prefix typed
 *   - `f ` → search `.cmir` files under the configured root. Enter
 *            opens a file; Tab dives INTO the selected file (clearing
 *            the bar) to search its objects (blocks / tags / cites);
 *            Esc from there returns to the file list with the prior
 *            query restored. Selecting an object inserts it.
 *   - `/ ` → browse the file-search folders (desktop only): subfolders and
 *            files, Enter/Tab steps into a folder, Esc steps back up. Text
 *            after the prefix searches the folder you're in — every file
 *            beneath it plus subfolders whose name matches. `/c ` starts in
 *            the launching document's own folder instead of the roots.
 *   - no prefix → search EVERYTHING, but show nothing until the user
 *     types a query
 * With a prefix present, an empty query browses that source.
 *
 * Insertion reuses `insertSpeechSlice`, which snaps a block-level insert to
 * the nearest top-level boundary so it never splits the card the caret is in.
 *
 * Also exports `openQuickCardTagPicker` — the ribbon Tag Picker
 * dropdown — which edits the same global active-tags filter.
 */

import type { EditorView } from 'prosemirror-view';
import { flattenSelfRefsInSlice } from './self-transclusion.js';
import { Slice, type Node as PMNode } from 'prosemirror-model';
import { undo, redo } from 'prosemirror-history';
import { icon } from './icons';
import { schema, newHeadingId } from '../schema/index.js';
import {
  settings,
  SETTING_METADATA,
  toggleableSettingMetas,
  hiddenInLite,
  toggleCommandName,
  settingSearchName,
  cyclableSettings,
  cycleCommandName,
  nextCycleValue,
  currentCycleLabel,
  CYCLABLE_SETTINGS,
  type Settings,
  type SettingsCategory,
} from './settings.js';
import { runSettingToggle, runSettingCycle } from './setting-commands.js';
import { CATEGORY_TABS, visibleCategoryTabs, type SettingsTarget } from './settings-categories.js';
import { appVersion } from './install-info.js';
import { getHost, getElectronHost, isWindowsHost } from './host/index.js';
import type { WindowListEntry } from './host/electron-host.js';
import { showToast } from './toast.js';
import { confirmDialog } from './text-prompt.js';
import { showConfirm } from './confirm-dialog.js';
import {
  insertZoneAtSelection,
  replaceZoneAtPos,
  buildLiveZoneAttrs,
  buildZoneErrorMessage,
} from './transclusion-actions.js';
import { resolveHeadingIdAt } from './transclusion.js';
import type { TransclusionAttrs } from './transclusion.js';
import { AUTOFILL_IGNORE_ATTRS } from './autofill-ignore.js';
import { insertSpeechSlice } from './speech-doc-send.js';
import { quickCardsStore, distinctTags, normalizeTag } from './quick-cards-store.js';
import { dropzoneStore } from './dropzone-store.js';
import { searchQuickCards } from './quick-cards-match.js';
import { parseNative } from '../native/index.js';
import { fromDocx } from '../import/index.js';
import { ensureHeadingAnchor } from '../anchor-docx.js';
import {
  extractFile,
  searchFileObjects,
  dirName,
  fileFormat,
  matchesAllTokens,
  tokenizeQuery,
  FILE_OBJECT_KIND_BADGES,
  type FileObject,
  type FileObjectKind,
  type OutlineEntry,
} from './file-search.js';
import {
  getFileIndexClient,
  type FileBrowseLocation,
  type FileBrowseRow,
  type FileIndexRow,
} from './file-search-client.js';
import { toggleManualPin, recordUsage, effectivePins } from './pins-store.js';
import { listRecents } from './recents-store.js';
import { scheduleIdle } from './idle-scheduler.js';

/** Warm cache of parsed pinned files — module-level so it survives the
 *  palette opening/closing within a session (only cleared on reload).
 *  Keyed by path; `mtimeMs` is the freshness key, `enabledSig` lets a
 *  change to the searchable-object set re-extract from the cached doc
 *  without re-parsing. */
interface WarmEntry {
  mtimeMs: number;
  enabledSig: string;
  /** Exactly one of `doc`/`docJson` is set: the worker warm path stores
   *  ProseMirror JSON (a PMNode can't cross the worker boundary) and a
   *  real dive materializes it once via `warmDocOf`; a dive-time parse
   *  stores the live doc directly. */
  doc: PMNode | null;
  docJson: unknown | null;
  objects: FileObject[];
  outline: OutlineEntry[];
}
const warmCache = new Map<string, WarmEntry>();

/** The entry's live doc, materializing (and caching) from JSON on first
 *  need — the only fromJSON cost, paid on an actual dive. */
function warmDocOf(entry: WarmEntry): PMNode {
  if (!entry.doc) {
    entry.doc = schema.nodeFromJSON(entry.docJson);
    entry.docJson = null;
  }
  return entry.doc;
}
import {
  DEFAULT_RIBBON_KEYS,
  formatKeyForDisplay,
  commandLabelFor,
  commandAliasesFor,
  effectivePluginDefaultKeys,
  type AnyCommandId,
} from './ribbon-commands.js';
import { availableRibbonCommandIds } from './ribbon-availability.js';
import { checkedSliceFromJSON } from '../schema/slice-check.js';
import { isRightClickContextMenu } from './context-menu-gate.js';

// ── Warm-cache machinery (module-level, shared by the open palette and
//    the proactive idle pre-warm) ────────────────────────────────────

/** True while a warm pass is parsing files — a single global guard so
 *  the proactive pre-warm and an open palette never double-parse. */
let warmingFiles = false;

/** Paths to keep warm: manual pins always, plus the auto set
 *  (recents ∪ frequents) when the auto-pin setting is on. */
function effectivePinPaths(): Set<string> {
  const recentPaths = listRecents()
    .map((r) => r.handle)
    .filter((h): h is string => typeof h === 'string' && h.length > 0);
  return effectivePins(recentPaths, settings.get('pinAutoEnabled'));
}

function enabledSet(): Set<FileObjectKind> {
  return new Set(settings.get('fileSearchObjectTypes') as FileObjectKind[]);
}

function enabledSig(): string {
  return (settings.get('fileSearchObjectTypes') as string[]).slice().sort().join(',');
}

/** Drop warm entries for files that are no longer pinned. */
function pruneWarm(pins: Set<string>): void {
  for (const key of [...warmCache.keys()]) {
    if (!pins.has(key)) warmCache.delete(key);
  }
}

/** Last document-level keydown, tracked so the warm pass can tell "the
 *  renderer has an idle frame" apart from "the user is actually done
 *  typing" — a 200ms gap between words presents idle frames, and a
 *  parse started there still lands on the next keystroke. */
let lastKeydownAt = 0;
if (typeof document !== 'undefined') {
  document.addEventListener(
    'keydown',
    () => {
      lastKeydownAt = Date.now();
    },
    { capture: true, passive: true },
  );
}

/** Keyboard-quiet threshold before a warm parse may start. */
const PARSE_QUIET_MS = 600;

/** Resolve once the renderer is genuinely idle AND the keyboard has
 *  been quiet for PARSE_QUIET_MS. Each warm parse is a monolithic
 *  main-thread block (parseNative / fromDocx — up to hundreds of ms),
 *  so it must never be forced into a typing burst: no idle-timeout cap
 *  (starving while the user types is the point — the cold-dive path
 *  covers a file that never gets warmed). */
async function waitForParseWindow(): Promise<void> {
  for (;;) {
    await new Promise<void>((resolve) => scheduleIdle(() => resolve(), Infinity));
    const sinceKey = Date.now() - lastKeydownAt;
    if (sinceKey >= PARSE_QUIET_MS) return;
    await new Promise((resolve) => setTimeout(resolve, PARSE_QUIET_MS - sinceKey));
  }
}

/** Parse a listed file's bytes into a schema doc — `.docx` through the
 *  importer, `.cmir` through the native reader. The in-file object search
 *  (the Tab dive + the background warm pass) is otherwise format-agnostic:
 *  everything downstream (`extractFile`, the outline, slice-on-insert) works
 *  off the parsed doc, which is the same schema for both formats. */
async function parseFileDoc(
  bytes: Uint8Array,
  format: 'cmir' | 'docx',
): Promise<PMNode> {
  if (format === 'docx') return fromDocx(bytes);
  return parseNative(bytes).doc;
}

/** Text of the heading node carrying `headingId` at (or inside) the node
 *  at `pos`. For a tag/analytic row the range starts at the enclosing
 *  card / analytic_unit — its textContent is the WHOLE card, which would
 *  fail the docx anchor's paragraph-text cross-check; the anchor needs
 *  the heading paragraph's own text. */
function headingTextAt(doc: PMNode, pos: number, headingId: string): string {
  const node = doc.nodeAt(pos);
  if (!node) return '';
  if (node.attrs['id'] === headingId) return node.textContent;
  let text = node.textContent; // fallback: the old (wrapper) behavior
  node.descendants((n) => {
    if (n.attrs['id'] === headingId) {
      text = n.textContent;
      return false;
    }
    return true;
  });
  return text;
}

// ── Off-thread parsing (warm-parse-worker.ts) ───────────────────────
// Parse + extract run in a Web Worker so a multi-hundred-ms parse of a
// big pinned file can never stall the renderer thread (the boot-window
// resize-freeze symptom). Lazy: constructed on first use, and hosts
// without Worker (jsdom tests) fall back to the inline parse.

let parseWorker: Worker | null | undefined;
let parseWorkerNextId = 1;
const parseWorkerPending = new Map<
  number,
  {
    resolve: (r: { docJson: unknown; objects: FileObject[]; outline: OutlineEntry[] }) => void;
    reject: (e: Error) => void;
  }
>();

function getParseWorker(): Worker | null {
  if (parseWorker !== undefined) return parseWorker;
  try {
    if (typeof Worker === 'undefined') throw new Error('no Worker in this host');
    parseWorker = new Worker(new URL('./warm-parse-worker.ts', import.meta.url), {
      type: 'module',
    });
    parseWorker.onmessage = (e: MessageEvent): void => {
      const msg = e.data as
        | { id: number; ok: true; docJson: unknown; objects: FileObject[]; outline: OutlineEntry[] }
        | { id: number; ok: false; error: string };
      const pending = parseWorkerPending.get(msg.id);
      if (!pending) return;
      parseWorkerPending.delete(msg.id);
      if (msg.ok) pending.resolve(msg);
      else pending.reject(new Error(msg.error));
    };
    parseWorker.onerror = (): void => {
      for (const [, pending] of parseWorkerPending) {
        pending.reject(new Error('parse worker failed'));
      }
      parseWorkerPending.clear();
    };
  } catch {
    parseWorker = null;
  }
  return parseWorker;
}

interface ParsedFile {
  /** Live doc when the caller asked for one (or the inline fallback
   *  ran); otherwise null with `docJson` set for lazy materialization. */
  doc: PMNode | null;
  docJson: unknown | null;
  objects: FileObject[];
  outline: OutlineEntry[];
}

/** Parse + extract, off-thread when possible. `wantLiveDoc` pays the
 *  one fromJSON immediately (dive); warming skips it and stores JSON. */
async function parseAndExtract(
  bytes: Uint8Array,
  format: 'cmir' | 'docx',
  wantLiveDoc: boolean,
): Promise<ParsedFile> {
  const worker = getParseWorker();
  if (worker) {
    try {
      const res = await new Promise<{
        docJson: unknown;
        objects: FileObject[];
        outline: OutlineEntry[];
      }>((resolve, reject) => {
        const id = parseWorkerNextId++;
        parseWorkerPending.set(id, { resolve, reject });
        worker.postMessage({ id, bytes, format, kinds: [...enabledSet()] });
      });
      return {
        doc: wantLiveDoc ? schema.nodeFromJSON(res.docJson) : null,
        docJson: wantLiveDoc ? null : res.docJson,
        objects: res.objects,
        outline: res.outline,
      };
    } catch {
      /* worker died / parse failed there — retry inline below */
    }
  }
  const doc = await parseFileDoc(bytes, format);
  const { objects, outline } = extractFile(doc, enabledSet());
  return { doc, docJson: null, objects, outline };
}

/** Parse the pinned/recent files that aren't warm yet (or are stale by
 *  mtime), one at a time, waiting for an idle frame AND a pause in
 *  typing before each parse so it never blocks a keystroke. Prunes
 *  rotated-out pins first.
 *  Cheap on repeat passes — already-fresh files are skipped. `keepGoing`
 *  lets a caller bail early (e.g. the palette closed). */
async function runWarmPass(
  electron: NonNullable<ReturnType<typeof getElectronHost>>,
  entries: ReadonlyArray<{ path: string; mtimeMs: number }>,
  keepGoing: () => boolean,
): Promise<void> {
  if (warmingFiles) return;
  warmingFiles = true;
  try {
    const pins = effectivePinPaths();
    pruneWarm(pins);
    const byPath = new Map(entries.map((f) => [f.path, f]));
    for (const path of pins) {
      if (!keepGoing()) break;
      const entry = byPath.get(path);
      if (!entry) continue; // not under the search root → unknown mtime
      const warm = warmCache.get(path);
      if (warm && warm.mtimeMs === entry.mtimeMs) continue; // already fresh
      try {
        const file = await electron.readFileAtPath(path);
        if (!file) continue;
        // The parse itself runs off-thread (parseAndExtract → worker),
        // but the idle gate stays: the worker competes for CPU cores,
        // and the result's structured-clone receive lands on this
        // thread — neither belongs in a typing burst.
        await waitForParseWindow();
        if (!keepGoing()) break;
        const parsed = await parseAndExtract(file.bytes, file.format, /* wantLiveDoc */ false);
        warmCache.set(path, {
          mtimeMs: entry.mtimeMs,
          enabledSig: enabledSig(),
          doc: parsed.doc,
          docJson: parsed.docJson,
          objects: parsed.objects,
          outline: parsed.outline,
        });
      } catch {
        /* unreadable / not a valid .cmir — skip */
      }
    }
  } finally {
    warmingFiles = false;
  }
}

/** Pre-warm pinned/recent files during idle, before the palette is ever
 *  opened, so the first search's file parse is already cached and
 *  never lands on a keystroke. No-op off Electron or with no search
 *  folders; best-effort (the palette warms on open as a fallback).
 *  Called once at boot. */
export function prewarmQuickCardFiles(): void {
  const electron = getElectronHost();
  if (!electron) return;
  const roots = settings.get('fileSearchRoots');
  void getFileIndexClient().then(async (client) => {
    if (!client) return;
    // Configure BEFORE the roots-length gate: reporting the full
    // current-roots set (even an empty one) lets the service drop
    // removed roots from the persisted index, which otherwise carries
    // them forever — and kicks its scans/revalidation off the renderer
    // AND main-process threads entirely.
    await client.configure(roots).catch(() => {});
    if (!roots.length) return;
    // The pin CONTENT parse is renderer CPU, so it waits for idle so it
    // never janks the launch frame. Exclusions apply (the service omits
    // excluded paths): an excluded pin must not warm.
    scheduleIdle(() => {
      void (async () => {
        try {
          const entries = await client.entriesForPaths({
            paths: [...effectivePinPaths()],
            roots,
            exclusions: settings.get('fileSearchExclusions'),
          });
          await runWarmPass(electron, entries, () => true);
        } catch {
          /* ignore */
        }
      })();
    }, 2000);
  });
}

export interface QuickCardSearchOptions {
  view: EditorView | null;
  paneEl: HTMLElement | null;
  /** Trigger a ribbon command by id (the palette's command source). */
  runCommand: (id: AnyCommandId) => void;
  /** Open a `.cmir` file by absolute path (the file source's Enter). */
  openFilePath: (path: string, name: string) => void;
  /** When true, selecting a header inside a file inserts a live zone
   *  (transclusion) instead of a copy. Desktop-only entry point. */
  transcludeMode?: boolean;
  /** The launching document's on-disk path. It is both the `/c` browse
   *  origin and, in transclude mode, the base for a portable source_ref. */
  docPath?: string | null;
  /** "Re-pick source" for an existing zone: choosing a header re-targets that
   *  zone in place (located by identity, so a stale position is safe) rather
   *  than inserting a new one. */
  rePickTarget?: { pos: number; identity: string };
  /** Text to open with already typed — e.g. `w ` for Switch Window. */
  initialQuery?: string;
}

/** A unified palette row — a quick card, dropzone item, command,
 *  settings shortcut, a file, or an object within a file. */
interface PaletteResult {
  source:
    | 'quickcard'
    | 'dropzone'
    | 'command'
    | 'settingtoggle'
    | 'settingcycle'
    | 'settings'
    | 'folder'
    | 'file'
    | 'fileobject'
    | 'window';
  name: string;
  /** Right-aligned secondary text: card tags / command keybinding /
   *  the settings tab / the file's subfolder / a cite's owning tag. */
  meta: string;
  matchedName: boolean;
  snippet: string | null;
  /** Insert payload (quickcard / dropzone / fileobject). */
  sliceJson?: unknown;
  /** Command to run (command source). */
  commandId?: AnyCommandId;
  /** Boolean setting to flip in place (settingtoggle source). */
  toggleSettingKey?: keyof Settings;
  /** Enum/mode setting to advance to its next value (settingcycle source). */
  cycleSettingKey?: keyof Settings;
  /** Settings deep-link (settings source). */
  settingsTarget?: SettingsTarget;
  /** Absolute path to open (file source). */
  filePath?: string;
  /** File's mtime — the warm-cache freshness key (file source). */
  fileMtimeMs?: number;
  /** Whether this file is pinned (file source) — drives ★ + sort. */
  pinned?: boolean;
  /** Directory target for ROOT/DIR browse rows. */
  browseLocation?: FileBrowseLocation;
  /** True for a configured-root row in the virtual browse root. */
  browseRoot?: boolean;
  /** Object kind, for the badge (fileobject source). */
  fileObjectKind?: FileObjectKind;
  /** Doc range to slice from the dived-into file on insert (fileobject
   *  source) — lazy, so no slice is built until you actually insert. */
  fileRange?: { from: number; to: number };
  /** Window to bring to the front (window source). */
  windowId?: number;
  /** Outline depth (1-4) for indentation in the nav-pane-style browse. */
  indentLevel?: number;
  /** Index into `inFile.outline` (outline browse rows only) — the key
   *  for collapse toggling. */
  outlineIndex?: number;
  /** Outline row has descendants and so can be collapsed/expanded. */
  collapsible?: boolean;
  /** Outline row is currently collapsed (children hidden). */
  collapsed?: boolean;
}

type Prefix = 'q' | 'd' | 'c' | 's' | 'f' | 'w' | null;

function activeTagSet(): Set<string> {
  return new Set(settings.get('quickCardActiveTags').map(normalizeTag));
}

/** The two folder-browse prefixes: `/ ` starts at the configured roots,
 *  `/c ` in the launching document's folder. Like the letter prefixes they
 *  end at whitespace; a bare `/` or `/c` is a prefix still being typed. */
type BrowsePrefix = '/' | '/c';

function parseBrowsePrefix(
  raw: string,
): { prefix: BrowsePrefix; query: string } | 'pending' | null {
  const m = raw.match(/^\/(c?)\s+(.*)$/i);
  if (m) return { prefix: m[1] ? '/c' : '/', query: m[2]! };
  return /^\/c?$/i.test(raw) ? 'pending' : null;
}

/** Split a leading single-letter prefix (`q `/`d `/`c `/`s `) off the query. */
function parsePrefix(raw: string): { prefix: Prefix; query: string } {
  const m = raw.match(/^([a-zA-Z])\s+(.*)$/);
  if (m) {
    const p = m[1]!.toLowerCase();
    if (p === 'q' || p === 'd' || p === 'c' || p === 's' || p === 'f' || p === 'w')
      return { prefix: p, query: m[2]! };
  }
  return { prefix: null, query: raw };
}

function searchQuickCardSource(query: string): PaletteResult[] {
  return searchQuickCards(quickCardsStore.list(), query, activeTagSet()).map((r) => ({
    source: 'quickcard' as const,
    name: r.card.name,
    meta: r.card.tags.join(', '),
    matchedName: r.matchedName,
    snippet: r.snippet,
    sliceJson: r.card.contentJson,
  }));
}

function searchDropzoneSource(query: string): PaletteResult[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const items = dropzoneStore.list();
  const matched =
    tokens.length === 0
      ? [...items]
      : items.filter((it) => tokens.every((t) => it.label.toLowerCase().includes(t)));
  return matched
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((it) => ({
      source: 'dropzone' as const,
      name: it.label,
      meta: '',
      matchedName: true,
      snippet: null,
      sliceJson: it.sliceJson,
    }));
}

/** The current display keybinding for a command (first binding), or ''. */
function commandKeyDisplay(id: AnyCommandId): string {
  const overrides = settings.get('ribbonKeyOverrides');
  const isStatic = id in (DEFAULT_RIBBON_KEYS as Record<string, unknown>);
  // Plugin ids: show only the keys that survive static collision, so the
  // palette never advertises a chord the plugin doesn't actually own.
  const spec = isStatic
    ? (overrides[id] ??
      (DEFAULT_RIBBON_KEYS as Record<string, string | string[] | undefined>)[id] ??
      '')
    : effectivePluginDefaultKeys(id, overrides);
  const first = Array.isArray(spec) ? spec[0] : spec;
  return first ? formatKeyForDisplay(first) : '';
}

/** Word-equivalence groups for command search: if a command's label contains
 *  any word in a group, queries phrased with the OTHER words in that group also
 *  match it (e.g. "Repair OCR/PDF Text (AI)" via "fix" / "restore"; "Remove
 *  Hyperlinks" via "delete"; "Delete Row" via "remove"). Command-search only;
 *  add a group to extend. */
const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['fix', 'repair', 'restore'],
  ['delete', 'remove'],
];

/** Command source — any ribbon command (everything bindable), matched
 *  on its label, aliases, and synonyms; Enter runs it. */
function searchCommandSource(query: string): PaletteResult[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  // Searchable text = label + any aliases, so a query phrased like an
  // alias still matches. Ranking still prefers the label: an alias-only
  // hit (not in the label) sorts after label hits via the Infinity below.
  // Expand each label by the other words in any synonym group it touches (see
  // SYNONYM_GROUPS), so a query phrased with an equivalent word still matches.
  const haystack = (id: AnyCommandId): string => {
    const aliases = commandAliasesFor(id);
    const label = commandLabelFor(id).toLowerCase();
    const synonyms: string[] = [];
    for (const group of SYNONYM_GROUPS) {
      if (group.some((w) => label.includes(w))) {
        for (const w of group) if (!label.includes(w)) synonyms.push(w);
      }
    }
    const extra = [...(aliases ?? []), ...synonyms];
    return extra.length ? `${label} ${extra.join(' ')}` : label;
  };
  const available = availableRibbonCommandIds();
  const matched =
    tokens.length === 0
      ? available
      : available.filter((id) => {
          const hay = haystack(id);
          return tokens.every((t) => hay.includes(t));
        });
  const t0 = tokens[0];
  // First-token position within the *label* (not aliases) for ranking;
  // a label miss yields -1, which we treat as last so label hits win.
  const rank = (id: AnyCommandId): number => {
    if (!t0) return 0;
    const i = commandLabelFor(id).toLowerCase().indexOf(t0);
    return i === -1 ? Infinity : i;
  };
  matched.sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    return commandLabelFor(a).toLowerCase().localeCompare(commandLabelFor(b).toLowerCase());
  });
  return matched.map((id) => ({
    source: 'command' as const,
    name: commandLabelFor(id),
    meta: commandKeyDisplay(id),
    matchedName: true,
    snippet: null,
    commandId: id,
  }));
}

/** Setting-toggle source — a "Toggle <label>" command for every boolean
 *  (`kind: 'toggle'`) setting, derived from SETTING_METADATA so the list
 *  tracks the registry with zero upkeep (see `toggleableSettingMetas`).
 *  Selecting one flips the value in place (no dialog). Searchable both under
 *  the `c` (commands) prefix and in everything-search, so "toggle x" surfaces
 *  it the way the user reaches for it; an empty query lists them all (parity
 *  with the command source's browse-all behavior). */
function searchSettingToggleSource(query: string): PaletteResult[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const metas = toggleableSettingMetas({
    hostKind: getHost().kind,
    isWindows: isWindowsHost(),
    get: (k) => settings.get(k),
  });
  // Haystack: "toggle <label> <section> <aliases> on off enable disable". The
  // leading "toggle" makes a bare `toggle` query list them all (discovery);
  // the section lets a query like "create reference bold" match a prefixed
  // command; the ORIGINAL (unstripped) label keeps "enable …" queries working;
  // the on/off/enable/disable words match however the user phrases the intent.
  const haystack = (m: (typeof metas)[number]): string => {
    const parts = ['toggle', m.label.toLowerCase(), 'on off enable disable'];
    if (m.section) parts.push(m.section.toLowerCase());
    if (m.aliases && m.aliases.length) parts.push(m.aliases.join(' '));
    return parts.join(' ');
  };
  const matched =
    tokens.length === 0 ? metas : metas.filter((m) => tokens.every((t) => haystack(m).includes(t)));
  // Rank by first-token position within the LABEL (a match only via
  // "toggle"/synonyms sorts last), then alphabetically — same scheme as the
  // command source.
  const t0 = tokens[0];
  const rank = (m: (typeof metas)[number]): number => {
    if (!t0) return 0;
    const i = m.label.toLowerCase().indexOf(t0);
    return i === -1 ? Infinity : i;
  };
  const sorted = [...matched].sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    return a.label.localeCompare(b.label);
  });
  return sorted.map((m) => {
    const on = settings.get(m.key) === true;
    return {
      source: 'settingtoggle' as const,
      name: toggleCommandName(m),
      // Current state so the user knows what selecting it will do.
      meta: `${categoryLabel(m.category)} · ${on ? 'On' : 'Off'}`,
      matchedName: true,
      snippet: null,
      toggleSettingKey: m.key,
    };
  });
}

/** Setting-cycle source — a "Cycle <label>" command for each enum/mode
 *  setting in the curated CYCLABLE_SETTINGS table. Selecting one advances to
 *  the next value (wrapping). Same search surfaces and gating as the toggle
 *  source. */
function searchSettingCycleSource(query: string): PaletteResult[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const entries = cyclableSettings({
    hostKind: getHost().kind,
    isWindows: isWindowsHost(),
    get: (k) => settings.get(k),
  });
  // Haystack: "cycle <label> <section> <value labels> <aliases>" — the value
  // names let a query like "cycle icons classic" match; the leading "cycle"
  // lists them all on a bare `cycle` query.
  const haystack = (e: (typeof entries)[number]): string => {
    const parts = ['cycle', e.meta.label.toLowerCase(), e.setting.values.map((v) => v.label).join(' ').toLowerCase()];
    if (e.meta.section) parts.push(e.meta.section.toLowerCase());
    if (e.meta.aliases && e.meta.aliases.length) parts.push(e.meta.aliases.join(' '));
    return parts.join(' ');
  };
  const matched =
    tokens.length === 0
      ? entries
      : entries.filter((e) => tokens.every((t) => haystack(e).includes(t)));
  const t0 = tokens[0];
  const rank = (e: (typeof entries)[number]): number => {
    if (!t0) return 0;
    const i = e.meta.label.toLowerCase().indexOf(t0);
    return i === -1 ? Infinity : i;
  };
  const sorted = [...matched].sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    return a.meta.label.localeCompare(b.meta.label);
  });
  return sorted.map((e) => ({
    source: 'settingcycle' as const,
    name: cycleCommandName(e.meta),
    // Current value + where a cycle lands next, so the row is self-explaining.
    meta: `${categoryLabel(e.meta.category)} · ${currentCycleLabel(
      e.setting,
      settings.get(e.setting.key),
    )} → ${nextCycleValue(e.setting, settings.get(e.setting.key)).label}`,
    matchedName: true,
    snippet: null,
    cycleSettingKey: e.setting.key,
  }));
}

/** Whether the dropzone is on — gates its `d` prefix, hint, and
 *  inclusion in everything-search (mirrors the pill's visibility). */
const dropzoneOn = (): boolean => settings.get('showDropzonePill');

const categoryLabel = (id: SettingsCategory): string =>
  CATEGORY_TABS.find((c) => c.id === id)?.label ?? '';

/** Row label for a window: its saved docs' names, else its title minus
 *  the app suffix (a home-screen or untitled window is just "CardMirror"). */
export function windowLabel(w: WindowListEntry): string {
  if (w.docNames.length > 0) return w.docNames.join(' · ');
  const title = w.title.replace(/\s+—\s+CardMirror$/, '').trim();
  return title && title !== 'CardMirror' ? title : 'Untitled window';
}

/** Window source (`w `) — every OTHER CardMirror window, in the
 *  most-recently-focused order main hands back, so the top row is the
 *  window you were just in. Every query word must hit the label or title. */
export function searchWindowSource(windows: WindowListEntry[], query: string): PaletteResult[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  return windows
    .filter((w) => !w.isOwnWindow)
    .filter((w) => {
      const hay = `${windowLabel(w)} ${w.title}`.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    })
    .map((w) => ({
      source: 'window' as const,
      name: windowLabel(w),
      meta: [w.isSpeech ? 'Speech doc' : '', w.isMinimized ? 'Minimized' : '']
        .filter(Boolean)
        .join(' · '),
      matchedName: true,
      snippet: null,
      windowId: w.windowId,
    }));
}

/** Settings source — top-level tabs AND individual settings, matched on
 *  label. Selecting a tab opens it; selecting a setting opens its tab
 *  and scrolls to the row. Electron-only settings are hidden off
 *  Electron so the palette never offers a row that won't render. */
function searchSettingsSource(query: string): PaletteResult[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const match = (label: string): boolean =>
    tokens.length === 0 || tokens.every((t) => label.toLowerCase().includes(t));

  // Top-level tabs first (host-visible only, so the desktop-only Collaboration
  // tab isn't offered on web).
  const results: PaletteResult[] = visibleCategoryTabs().filter(({ label }) => match(label)).map(
    ({ id, label }) => ({
      source: 'settings' as const,
      name: label,
      meta: 'Section',
      matchedName: true,
      snippet: null,
      settingsTarget: { category: id },
    }),
  );

  // "Version / About this install" — surfaces the running app version and,
  // on Enter, deep-links to the About section (Settings → General). Matched
  // the way a user looks for it: "version", "about", "about this install".
  const q = tokens.join(' ');
  const aboutKeys = ['version', 'about this install', 'about', 'release'];
  if (q.length > 0 && aboutKeys.some((k) => k.startsWith(q) || q.startsWith(k))) {
    results.unshift({
      source: 'settings',
      name: `CardMirror ${appVersion}`,
      meta: 'About this install',
      matchedName: true,
      snippet: null,
      settingsTarget: { category: 'general', anchor: 'about-this-install' },
    });
  }

  // Keyboard macros — the macros editor lives inside the keybindings
  // editor (Settings → Shortcuts) rather than as its own SETTING_METADATA
  // row, so it has no auto-generated palette entry. Surface it explicitly,
  // deep-linking to the macros section. Matched on how a user looks for it.
  const macroKeys = ['keyboard macros', 'keyboard macro', 'macro', 'macros', 'snippet', 'text expansion'];
  if (q.length > 0 && macroKeys.some((k) => k.startsWith(q) || q.startsWith(k))) {
    results.unshift({
      source: 'settings',
      name: 'Keyboard macros',
      meta: categoryLabel('shortcuts'),
      matchedName: true,
      snippet: null,
      settingsTarget: { category: 'shortcuts', anchor: 'keyboard-macros' },
    });
  }

  // Then individual settings, ranked by where the first token hits.
  // A setting matches on its label OR any alias (aliases let queries
  // like "dark mode" surface the "Theme" row); ranking still keys on
  // the label so alias-only hits sort after label hits.
  const hostKind = getHost().kind;
  const settingHaystack = (m: (typeof SETTING_METADATA)[number]): string => {
    // Section too, so a context-free row (e.g. "Bold heading") is findable by
    // its section ("create reference bold") — matching how it's now displayed.
    const parts = [m.label.toLowerCase()];
    if (m.section) parts.push(m.section.toLowerCase());
    if (m.aliases && m.aliases.length) parts.push(m.aliases.join(' '));
    return parts.join(' ');
  };
  const matchSetting = (m: (typeof SETTING_METADATA)[number]): boolean => {
    const hay = settingHaystack(m);
    return tokens.length === 0 || tokens.every((t) => hay.includes(t));
  };
  const items = SETTING_METADATA.filter(
    (m) =>
      !m.searchHidden &&
      (!m.electronOnly || hostKind === 'electron') &&
      (!m.windowsOnly || isWindowsHost()) &&
      !hiddenInLite(m) &&
      (!m.webOnly || hostKind === 'browser') &&
      matchSetting(m),
  );
  const t0 = tokens[0];
  const rank = (label: string): number => {
    if (!t0) return 0;
    const i = label.toLowerCase().indexOf(t0);
    return i === -1 ? Infinity : i;
  };
  items.sort((a, b) => {
    const d = rank(a.label) - rank(b.label);
    if (d !== 0) return d;
    return a.label.localeCompare(b.label);
  });
  for (const m of items) {
    results.push({
      source: 'settings',
      // Prefix context-free sections (e.g. "Create Reference: Bold heading")
      // so the row reads clearly out of the dialog — same context the
      // Toggle/Cycle commands use.
      name: settingSearchName(m),
      meta: categoryLabel(m.category),
      matchedName: true,
      snippet: null,
      settingsTarget: { category: m.category, settingKey: m.key },
    });
  }
  return results;
}

function fileResult(f: FileIndexRow): PaletteResult {
  return {
    source: 'file',
    name: f.name,
    meta: dirName(f.relPath),
    matchedName: true,
    snippet: null,
    filePath: f.path,
    fileMtimeMs: f.mtimeMs,
    pinned: f.pinned,
  };
}

function fileObjectResult(o: FileObject): PaletteResult {
  return {
    source: 'fileobject',
    name: o.label,
    // Tags show their card's cite (so a cite-match reads clearly and
    // tags carry their citation like the nav pane); cites show their
    // owning tag; everything else has no secondary text.
    meta: o.cite ?? o.detail,
    matchedName: true,
    snippet: null,
    fileRange: { from: o.from, to: o.to },
    fileObjectKind: o.kind,
  };
}

function pathParts(p: string): string[] {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
}

function pathBase(p: string): string {
  const parts = pathParts(p);
  return parts[parts.length - 1] ?? p;
}

function pathParent(p: string): string {
  const clean = p.replace(/[\\/]+$/, '');
  const at = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  if (at < 0) return '';
  return at === 0 ? clean[0]! : clean.slice(0, at);
}

function parentRelativeDirectory(p: string): string {
  const clean = p.replace(/[\\/]+$/, '');
  const at = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return at < 0 ? '' : clean.slice(0, at);
}

function rootResult(root: string): PaletteResult {
  return {
    source: 'folder',
    name: pathBase(root),
    meta: pathParent(root),
    matchedName: true,
    snippet: null,
    browseLocation: { root, relativeDirectory: '' },
    browseRoot: true,
  };
}

function browseResult(row: FileBrowseRow, root: string): PaletteResult {
  // A folder search reaches any depth: the meta line says where the file
  // sits below the folder being browsed ('' for a direct child).
  if (row.kind === 'file') return { ...fileResult(row), meta: pathParts(row.subPath).join(' / ') };
  return {
    source: 'folder',
    name: row.name,
    meta: '',
    matchedName: true,
    snippet: null,
    browseLocation: { root, relativeDirectory: row.relativeDirectory },
  };
}

/** Results rendered per page: the initial window, and how many more each
 *  "show more" click (or arrowing past the end) adds. Searches rank the
 *  FULL list; this only bounds how much DOM is built at once. 50 (down
 *  from 100): the rebuild runs on every keystroke, and nobody scans
 *  past ~50 rows without narrowing the query instead. */
const RESULT_PAGE_SIZE = 50;

/** Short left-aligned badge for a result row. */
function badgeText(r: PaletteResult): string {
  switch (r.source) {
    case 'quickcard':
      return 'QC';
    case 'dropzone':
      return 'DZ';
    case 'command':
      return 'CMD';
    case 'settingtoggle':
      return 'TOG';
    case 'settingcycle':
      return 'CYC';
    case 'settings':
      return 'SET';
    case 'file':
      // Badge the file's format so .cmir and .docx results are distinct.
      return fileFormat(r.filePath ?? r.name).toUpperCase();
    case 'folder':
      return r.browseRoot ? 'ROOT' : 'DIR';
    case 'fileobject':
      return r.fileObjectKind ? FILE_OBJECT_KIND_BADGES[r.fileObjectKind] : 'OBJ';
    case 'window':
      return 'WIN';
  }
}

/** Stable identity of a result, used to restore the selected row across
 *  a re-render (e.g. a live file-index refresh) so the cursor doesn't
 *  bounce back to the top. */
function resultKey(r: PaletteResult): string {
  const id = r.filePath
    ?? (r.browseLocation
      ? `${r.browseLocation.root}:${r.browseLocation.relativeDirectory}`
      : r.commandId ?? (r.windowId !== undefined ? String(r.windowId) : r.name));
  return `${r.source}:${id}`;
}

/** Sources whose Enter inserts a slice (and so support Alt+Enter "at end"). */
function isInsertSource(source: PaletteResult['source']): boolean {
  return source === 'quickcard' || source === 'dropzone' || source === 'fileobject';
}

/** Verb for the Enter hint, given the selected result's source. */
function enterVerb(source: PaletteResult['source']): string {
  switch (source) {
    case 'command':
      return 'run';
    case 'settingtoggle':
      return 'toggle';
    case 'settingcycle':
      return 'cycle';
    case 'settings':
      return 'open';
    case 'file':
      return 'open';
    case 'folder':
      return 'enter';
    case 'window':
      return 'switch';
    default:
      return 'insert';
  }
}

const SEARCH_PLACEHOLDER = 'Search…';

class QuickCardSearchUI {
  private root: HTMLDivElement | null = null;
  private input!: HTMLInputElement;
  private resultsEl!: HTMLDivElement;
  private browseHeaderEl!: HTMLDivElement;
  private browseNoticeEl!: HTMLDivElement;
  private tagFilterEl!: HTMLDivElement;
  private hintsEl!: HTMLDivElement;
  private unsubscribe: (() => void) | null = null;
  private view: EditorView | null = null;
  private paneEl: HTMLElement | null = null;
  private runCommand: (id: AnyCommandId) => void = () => {};
  private openFilePath: (path: string, name: string) => void = () => {};
  private transcludeMode = false;
  private docPath: string | null = null;
  /** When set, choosing a header RE-TARGETS this existing zone (Re-pick source)
   *  instead of inserting a new one. Located by identity at replace time. */
  private rePickTarget: { pos: number; identity: string } | null = null;

  private results: PaletteResult[] = [];
  /** Materialized head of the current query's ranked results (every
   *  non-file source; in in-file mode, everything). File matches live
   *  in `fileTail` and are NOT part of this array. `results` holds the
   *  rendered window. Kept so "show more" can extend the window
   *  without re-running the search. */
  private fullResults: PaletteResult[] = [];
  /** Ranked file matches for the current query, kept as lightweight
   *  entries and materialized into PaletteResults lazily, only for the
   *  rendered window — a 1–2 char query matches most of the corpus,
   *  and building a result object per match every keystroke was pure
   *  GC churn. Always ordered AFTER `fullResults`; both search paths
   *  that surface files put them last (file mode: everything is a
   *  file, the head is empty). */
  private fileTail: FileIndexRow[] = [];
  /** The service's FULL match count behind `fileTail`'s fetched window —
   *  drives "Showing N of M" and showMore's refetch decision. */
  private fileTailTotal = 0;
  /** Memoized materialized prefix of `fileTail`, grown on demand by
   *  `windowResults` (keeps row identity stable across "show more"). */
  private materializedTail: PaletteResult[] = [];
  private visibleCount = RESULT_PAGE_SIZE;
  private selected = 0;
  /** Row elements as last built by `renderResults`, index-aligned with
   *  `results` — lets selection moves swap the active class in place
   *  instead of rebuilding the list. */
  private rowEls: HTMLElement[] = [];
  private emptyText = '';

  // ── Folder browse (the `/ ` and `/c ` prefixes) ──────────────────
  private browseActive = false;
  /** The prefix last applied; a change of prefix is what relocates. */
  private browsePrefix: BrowsePrefix | null = null;
  /** Text after the prefix — searched within `browseLocation`. */
  private browseQuery = '';
  /** null is the virtual level listing the configured roots. */
  private browseLocation: FileBrowseLocation | null = null;
  private browseRows: FileBrowseRow[] = [];
  private browseTotal = 0;
  private browseQueryKey: string | null = null;
  private browseQueryPending: string | null = null;
  private browseGen = 0;
  private browseGenApplied = 0;
  /** Bumped per `/c ` jump so a slow resolution can't land on a later one. */
  private browseLocateGen = 0;
  private browseNotice: string | null = null;

  // ── File-search state (the `f` prefix) ──────────────────────────────
  // The corpus lives in the file-index service; the palette only ever
  // holds the fetched WINDOW of ranked rows for the current query.
  /** Params key of the rows currently in `fileRows` (null = nothing
   *  fetched / stale — the next runSearch re-queries). */
  private fileQueryKey: string | null = null;
  /** Params key of the LATEST query in flight, if any. */
  private fileQueryPending: string | null = null;
  /** Monotonic query generations: every kick gets one, and an arrival
   *  applies only if newer than the last APPLIED one — so mid-typing
   *  responses render progressively (latest-wins) instead of being
   *  dropped for having been superseded, which read as a debounce. */
  private fileQueryGen = 0;
  private fileGenApplied = 0;
  /** Fetched ranked window + the full match count behind it. */
  private fileRows: FileIndexRow[] = [];
  private fileTotal = 0;
  /** Last file-bearing query params — lets showMore refetch a bigger
   *  window without re-deriving the mode. */
  private lastFileParams: { query: string; partitionPins: boolean } | null = null;
  /** Monotonic guard so a stale async (list / read) result from a
   *  prior query or a closed palette is ignored. */
  private asyncToken = 0;
  /** Set while diving into a file (Tab). Overrides prefix parsing: an
   *  empty query browses `outline` (nav-pane style), a non-empty query
   *  searches `objects`; Esc restores `savedQuery`. The parsed `doc` is
   *  kept so inserts slice lazily (no per-object slice held up front). */
  private inFile: {
    path: string;
    name: string;
    doc: PMNode;
    objects: FileObject[];
    outline: OutlineEntry[];
    /** Indices into `outline` whose children are collapsed (hidden). */
    collapsedIdx: Set<number>;
    savedQuery: string;
    /** Exact directory context when the file dive began in `/` mode. */
    returnBrowse: { location: FileBrowseLocation | null; selectedKey: string } | null;
  } | null = null;
  /** Unsubscribe from main's live `.cmir` index-refresh broadcasts
   *  (Electron only); set on open, cleared on close. */
  private fileIndexUnsub: (() => void) | null = null;
  /** Window list for the `w ` source, fetched once per open (null = not
   *  fetched yet). */
  private windowList: WindowListEntry[] | null = null;
  private windowListPending = false;

  open(opts: QuickCardSearchOptions): void {
    // Re-triggering the open hotkey while open toggles it closed.
    if (this.root) {
      this.close();
      return;
    }
    this.view = opts.view;
    this.paneEl = opts.paneEl;
    this.runCommand = opts.runCommand;
    this.openFilePath = opts.openFilePath;
    this.rePickTarget = opts.rePickTarget ?? null;
    this.transcludeMode = (opts.transcludeMode ?? false) || this.rePickTarget != null;
    this.docPath = opts.docPath ?? null;
    this.fileQueryKey = null;
    this.fileQueryPending = null;
    this.fileRows = [];
    this.fileTotal = 0;
    this.lastFileParams = null;
    this.inFile = null;
    this.resetBrowseState();
    this.pinsCache = null;
    this.fileTail = [];
    this.materializedTail = [];
    this.windowList = null;
    this.windowListPending = false;

    const root = document.createElement('div');
    root.className = 'pmd-qcs';
    root.innerHTML = `
      <div class="pmd-qcs-browse-header" hidden></div>
      <div class="pmd-qcs-browse-notice" hidden></div>
      <div class="pmd-qcs-results" role="listbox"></div>
      <div class="pmd-qcs-tagfilter" hidden></div>
      <input class="pmd-qcs-input" type="text" spellcheck="false" ${AUTOFILL_IGNORE_ATTRS}
             placeholder="${SEARCH_PLACEHOLDER}" aria-label="Search" />
      <div class="pmd-qcs-hints"></div>`;
    this.root = root;
    for (const cb of openListeners) cb();
    this.resultsEl = root.querySelector('.pmd-qcs-results')!;
    this.browseHeaderEl = root.querySelector('.pmd-qcs-browse-header')!;
    this.browseNoticeEl = root.querySelector('.pmd-qcs-browse-notice')!;
    // The search input owns the keyboard, but modern Chromium makes
    // scrollable containers CLICK-FOCUSABLE — any click in the results
    // list (rows, chevrons, ★/⊘, right-click expand/collapse) moved
    // focus to the scroller, after which arrows scrolled it natively
    // and Enter/Tab/⌘↵ never reached the palette (left-click rows
    // masked it by refocusing after insert; right-click had no such
    // save). Preventing the mousedown default stops the focus transfer
    // at the source while leaving click/contextmenu events intact.
    this.resultsEl.addEventListener('mousedown', (e) => e.preventDefault());
    this.tagFilterEl = root.querySelector('.pmd-qcs-tagfilter')!;
    this.input = root.querySelector('.pmd-qcs-input')!;
    this.hintsEl = root.querySelector('.pmd-qcs-hints')!;

    document.body.appendChild(root);
    this.reposition();
    this.input.focus();

    root.classList.add('pmd-qcs-pulse');
    root.addEventListener('animationend', () => root.classList.remove('pmd-qcs-pulse'), {
      once: true,
    });

    this.input.addEventListener('input', () => this.runSearch());
    this.input.addEventListener('keydown', this.onInputKey);
    document.addEventListener('keydown', this.onDocKey);
    document.addEventListener('pointerdown', this.onDocPointerDown, true);
    window.addEventListener('resize', this.onResize);
    this.unsubscribe = quickCardsStore.subscribe(() => this.runSearch());

    if (opts.initialQuery) this.input.value = opts.initialQuery;
    this.runSearch();
    // Wake the file-index service NOW instead of on the first keystroke:
    // configure kicks its revalidation (once per palette open, matching
    // the old per-open cadence), the changed-subscription keeps the open
    // palette live, and the warm pass refreshes pinned parses.
    void getFileIndexClient().then((client) => {
      if (!client || !this.root) return;
      void client.configure(settings.get('fileSearchRoots')).catch(() => {});
      this.fileIndexUnsub ??= client.onChanged(() => this.onIndexChanged());
      void this.warmPins();
    });
  }

  /** Center over the target pane and clamp the width to fit it, so the
   *  bar shrinks elegantly in narrow / multi-pane windows. Re-run on
   *  resize since panes reflow with the window. */
  private reposition(): void {
    if (!this.root) return;
    const rect = this.paneEl?.getBoundingClientRect();
    const available = rect && rect.width > 0 ? rect.width : window.innerWidth;
    const centerX = rect && rect.width > 0 ? rect.left + rect.width / 2 : window.innerWidth / 2;
    this.root.style.left = `${Math.round(centerX)}px`;
    this.root.style.width = `${Math.round(Math.max(240, Math.min(540, available - 24)))}px`;
  }

  private onResize = (): void => this.reposition();

  close(): void {
    if (!this.root) return;
    document.removeEventListener('keydown', this.onDocKey);
    document.removeEventListener('pointerdown', this.onDocPointerDown, true);
    window.removeEventListener('resize', this.onResize);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.fileIndexUnsub?.();
    this.fileIndexUnsub = null;
    this.asyncToken++; // invalidate any in-flight query / read
    this.fileQueryKey = null;
    this.fileQueryPending = null;
    this.fileRows = [];
    this.fileTotal = 0;
    this.lastFileParams = null;
    this.inFile = null;
    this.resetBrowseState();
    this.root.remove();
    this.root = null;
    this.view?.focus();
  }

  /** Whether the bar is open on the `w ` (Switch Window) source. */
  isInWindowMode(): boolean {
    return !!this.root && !this.inFile && parsePrefix(this.input.value).prefix === 'w';
  }

  /** Move the highlighted row — Switch Window pressed again while open
   *  steps down the list the way Alt+Tab does. */
  moveSelection(delta: number): void {
    this.move(delta);
  }

  isOpen(): boolean {
    return !!this.root;
  }

  private onDocPointerDown = (e: PointerEvent): void => {
    if (this.root && !this.root.contains(e.target as Node)) this.close();
  };

  private resetBrowseState(): void {
    this.browseActive = false;
    this.browsePrefix = null;
    this.browseQuery = '';
    this.browseLocation = null;
    this.browseRows = [];
    this.browseTotal = 0;
    this.browseQueryKey = null;
    this.browseQueryPending = null;
    this.browseLocateGen++;
    this.browseNotice = null;
  }

  /** Document-level Escape fallback. `onInputKey` only fires while the search
   *  box has focus, but Escape should still step back out of a file / close the
   *  palette when the user has clicked into the results and the box lost focus. */
  private onDocKey = (e: KeyboardEvent): void => {
    if (!this.root || e.key !== 'Escape') return;
    // The input's own handler already owns Escape while it's focused — skipping
    // here avoids double-handling (which would step back AND then close).
    if (e.target === this.input) return;
    e.preventDefault();
    this.escapeOut();
  };

  /** Escape behavior, shared by the input keydown and the document fallback:
   *  step back out of a dived-into file to the results, else close. */
  private escapeOut(): void {
    if (this.inFile) this.exitInFile();
    else if (this.browseActive && this.browseLocation) this.browseUp();
    else this.close();
  }

  private onInputKey = (e: KeyboardEvent): void => {
    // While diving in a file, route undo/redo to the editor so a just-
    // inserted block can be taken back without leaving the bar (matches
    // the editor's own Mod-z / Mod-Shift-z / Mod-y bindings). Focus stays
    // in the input — view.dispatch doesn't steal it.
    if (this.inFile && this.view && (e.metaKey || e.ctrlKey)) {
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo(this.view.state, this.view.dispatch);
        return;
      }
      if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        redo(this.view.state, this.view.dispatch);
        return;
      }
    }
    // Ctrl+Tab again in Switch Window mode steps through the windows
    // (Shift reverses) instead of reaching the Tab / tag-filter case.
    if (e.key === 'Tab' && (e.ctrlKey || e.metaKey) && this.isInWindowMode()) {
      e.preventDefault();
      e.stopPropagation();
      this.move(e.shiftKey ? -1 : 1);
      return;
    }
    // Alt+P pins / unpins the selected file (keeps it warm).
    if (e.altKey && e.key.toLowerCase() === 'p') {
      const sel = this.results[this.selected];
      if (sel?.source === 'file' && sel.filePath) {
        e.preventDefault();
        this.togglePinPath(sel.filePath);
        return;
      }
    }
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        this.escapeOut();
        break;
      case 'ArrowDown':
        e.preventDefault();
        this.move(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.move(-1);
        break;
      case 'Enter':
        e.preventDefault();
        // Stop the Enter from bubbling to `document`: activating a
        // command can synchronously open a modal (e.g. New Speech
        // Document → promptForText) that registers a document keydown
        // listener, which would otherwise catch this very Enter and
        // instantly dismiss itself.
        e.stopPropagation();
        this.activateSelected(e.altKey, e.metaKey || e.ctrlKey);
        break;
      case 'Tab':
        e.preventDefault();
        // In-file mode: Tab is a no-op (already searching within a file).
        if (this.inFile) break;
        // A selected file (file prefix OR everything search) → dive in to
        // search its objects. Works for both .cmir and .docx (the dive
        // parses either format into the same schema).
        if (this.results[this.selected]?.source === 'folder') {
          this.enterBrowseFolder(this.results[this.selected]!);
          break;
        }
        if (this.results[this.selected]?.source === 'file') {
          void this.enterInFile();
          break;
        }
        if (this.browseActive) break;
        // Otherwise: the quick-card tag filter.
        this.openTagFilter();
        break;
    }
  };

  // ── Search + results ──────────────────────────────────────────────

  private runSearch(): void {
    // In-file mode overrides prefix parsing — the raw query searches
    // the dived-into file's objects.
    if (this.inFile) {
      const query = this.input.value;
      if (query.trim() === '') {
        // Empty query → the file's outline (nav-pane-style hierarchy):
        // indented by level, collapsible, shown in full.
        // Cites never appear here — they aren't headings — so the
        // overview isn't doubled; they surface once you type a query.
        this.results = this.buildOutlineResults();
        // Outline browse stays deliberately un-paginated; keep the full
        // list in sync (and no file tail) so no "show more" row appears.
        this.fullResults = this.results;
        this.fileTail = [];
        this.materializedTail = [];
        this.emptyText = 'No headings in this file.';
        this.selected = 0;
        this.renderResults();
        return;
      }
      this.results = searchFileObjects(this.inFile.objects, query).map(fileObjectResult);
      this.emptyText = this.inFile.objects.length
        ? 'No matching objects in this file.'
        : 'No searchable objects in this file.';
      this.finishSearch();
      return;
    }
    const browse = parseBrowsePrefix(this.input.value);
    if (browse === 'pending') {
      // `/` or `/c` with no space yet: neither a query (a bare slash would
      // match every file path) nor a relocation — the folder you were in
      // is kept for when the space arrives.
      this.results = [];
      this.emptyText = 'Add a space: "/ " browses your file-search folders, "/c " starts in the current document’s folder.';
      this.finishSearch();
      return;
    }
    if (browse) {
      this.runBrowseInput(browse.prefix, browse.query);
      return;
    }
    if (this.browseActive) this.resetBrowseState();
    const { prefix, query } = parsePrefix(this.input.value);
    if (prefix === 'f') {
      this.runFileSearch(query);
      return;
    }
    if (prefix === 'q') {
      this.results = searchQuickCardSource(query);
      this.emptyText = quickCardsStore.list().length
        ? 'No matching quick cards.'
        : 'No quick cards yet.';
    } else if (prefix === 'd') {
      if (!dropzoneOn()) {
        this.results = [];
        this.emptyText = 'The dropzone is off — turn it on in Settings → Appearance.';
      } else {
        this.results = searchDropzoneSource(query);
        this.emptyText = dropzoneStore.list().length
          ? 'No matching dropzone items.'
          : 'The dropzone is empty.';
      }
    } else if (prefix === 'c') {
      // Commands include the auto-generated setting toggles + cycles, so the
      // `c` prefix covers "Toggle/Cycle <setting>" the way the user searches
      // for commands.
      this.results = [
        ...searchCommandSource(query),
        ...searchSettingToggleSource(query),
        ...searchSettingCycleSource(query),
      ];
      this.emptyText = 'No matching commands.';
    } else if (prefix === 'w') {
      this.runWindowSearch(query);
      return;
    } else if (prefix === 's') {
      // The settings filter shows the deep-link rows (open the dialog) AND
      // the in-place Toggle/Cycle actions, so a setting can be changed from
      // here without leaving the bar.
      this.results = [
        ...searchSettingsSource(query),
        ...searchSettingToggleSource(query),
        ...searchSettingCycleSource(query),
      ];
      this.emptyText = 'No matching settings.';
    } else if (query.trim() === '') {
      // No prefix, nothing typed — don't preview anything. The `d
      // dropzone` hint only shows when the dropzone is on.
      this.results = [];
      this.emptyText = `Type to search everything · / browse · c commands${
        dropzoneOn() ? ' · d dropzone' : ''
      } · f files · q cards · s settings${getElectronHost() ? ' · w windows' : ''}`;
    } else {
      // No prefix — search everything. Files (by filename) join the
      // other sources; the ranked rows come from the file-index service
      // asynchronously, so the first everything-search after opening may
      // show non-file results first and fold files in when the query
      // answer lands (the arrival re-runs this search). The dropzone is
      // included only when it's on. No pin partition here — matching the
      // pre-service ordering, where only `f`-mode floated pins.
      this.results = [
        ...searchQuickCardSource(query),
        ...(dropzoneOn() ? searchDropzoneSource(query) : []),
        ...searchCommandSource(query),
        ...searchSettingToggleSource(query),
        ...searchSettingCycleSource(query),
        ...searchSettingsSource(query),
      ];
      this.emptyText = 'No matches.';
      // Files join as the lazy tail — the service ranks in full and
      // returns the window; `fileTotal` keeps "Showing N of M" honest.
      this.ensureFileQuery(query, /* partitionPins */ false);
      this.finishSearch(this.fileRows, this.fileTotal);
      return;
    }
    this.finishSearch();
  }

  /** The `w ` source. The window list comes from main asynchronously; the
   *  first run fetches it and re-runs the search when it lands. */
  private runWindowSearch(query: string): void {
    const host = getElectronHost();
    if (!host) {
      this.results = [];
      this.emptyText = 'Switching windows requires the desktop edition.';
      this.finishSearch();
      return;
    }
    if (this.windowList === null) {
      this.results = [];
      this.emptyText = 'Loading windows…';
      this.finishSearch();
      if (!this.windowListPending) {
        this.windowListPending = true;
        const token = this.asyncToken;
        void host
          .listWindows()
          .catch(() => [] as WindowListEntry[])
          .then((list) => {
            if (!this.root || token !== this.asyncToken) return;
            this.windowListPending = false;
            this.windowList = list;
            this.runSearch();
          });
      }
      return;
    }
    this.results = searchWindowSource(this.windowList, query);
    this.emptyText = this.windowList.some((w) => !w.isOwnWindow)
      ? 'No matching windows.'
      : 'No other CardMirror windows are open.';
    this.finishSearch();
  }

  /** Clamp to the first page, reset selection, render — the shared tail
   *  of every search. `fileTail` is the ranked file matches (lazy;
   *  rendered after every materialized result). */
  private finishSearch(fileTail: FileIndexRow[] = [], fileTotal = fileTail.length): void {
    this.fullResults = this.results;
    this.fileTail = fileTail;
    this.fileTailTotal = fileTotal;
    this.materializedTail = [];
    this.visibleCount = RESULT_PAGE_SIZE;
    this.results = this.windowResults();
    this.selected = 0;
    this.renderResults();
  }

  /** Total result count across the materialized head and the file tail —
   *  what "Showing N of M" and the paging boundary report. The tail's
   *  count is the SERVICE's full match total, which can exceed the
   *  fetched window (showMore refetches a bigger one). */
  private totalCount(): number {
    if (this.browseActive && !this.inFile) return this.browseTotal;
    return this.fullResults.length + this.fileTailTotal;
  }

  /** The first `visibleCount` results: the materialized head, then file
   *  rows materialized on demand (and memoized, so paging deeper never
   *  rebuilds earlier rows). */
  private windowResults(): PaletteResult[] {
    const head = this.fullResults.slice(0, this.visibleCount);
    const needTail = Math.min(
      this.visibleCount - head.length,
      this.fileTail.length,
    );
    while (this.materializedTail.length < needTail) {
      const f = this.fileTail[this.materializedTail.length]!;
      this.materializedTail.push(fileResult(f));
    }
    return needTail > 0 ? head.concat(this.materializedTail.slice(0, needTail)) : head;
  }

  /** Extend the rendered window by one page (the "show more" row, or
   *  arrowing past the last rendered result). Selection is preserved —
   *  the rebuilt rows re-read `this.selected`. When the fetched file
   *  window runs out before the service's total, refetch a bigger one
   *  (the arrival folds the extra rows in). */
  private showMore(): void {
    this.visibleCount += RESULT_PAGE_SIZE;
    if (this.browseActive && this.browseLocation) {
      this.browseQueryKey = null;
      this.runBrowse();
      return;
    }
    if (this.lastFileParams && this.fileTail.length < this.fileTailTotal) {
      this.ensureFileQuery(this.lastFileParams.query, this.lastFileParams.partitionPins);
    }
    this.results = this.windowResults();
    this.renderResults();
  }

  // ── Folder browse (`/ ` and `/c `) ──────────────────────────────
  // The prefix names a STARTING point (`/ ` = the configured roots, `/c ` =
  // the launching document's folder); where you are afterwards lives in
  // `browseLocation`, moved by Enter/Tab (into a folder) and Esc (up), with
  // the header above the results showing the path. Three rules keep the
  // bar and the location in step:
  //   - a CHANGE of prefix relocates (`/ ` → the roots, `/c ` → the current
  //     folder); a keystroke in the query never does, so navigating away
  //     from where `/c ` landed and then typing doesn't snap back;
  //   - query text searches the current folder (see `file-browse.ts`);
  //   - stepping into or out of a folder clears the query.

  /** Rewrite the bar to the active prefix plus `query` without firing an
   *  input event — navigation owns the query, `runSearch` must not re-enter. */
  private setBrowseInput(query: string): void {
    this.input.value = `${this.browsePrefix ?? '/'} ${query}`;
    this.browseQuery = query;
  }

  private setBrowseLocation(location: FileBrowseLocation | null): void {
    this.browseLocation = location;
    this.browseRows = [];
    this.browseTotal = 0;
    this.browseQueryKey = null;
    this.browseQueryPending = null;
    this.visibleCount = RESULT_PAGE_SIZE;
    this.selected = 0;
    this.runBrowse();
  }

  private enterBrowseFolder(result: PaletteResult): void {
    if (!this.browseActive || result.source !== 'folder' || !result.browseLocation) return;
    this.setBrowseInput('');
    this.setBrowseLocation(result.browseLocation);
  }

  /** Esc: one level up (a root's parent is the roots list); from the roots
   *  the palette closes. The query is dropped on the way. */
  private browseUp(): void {
    const location = this.browseLocation;
    if (!location) {
      this.close();
      return;
    }
    this.setBrowseInput('');
    if (location.relativeDirectory === '') {
      this.setBrowseLocation(null);
      return;
    }
    this.setBrowseLocation({
      root: location.root,
      relativeDirectory: parentRelativeDirectory(location.relativeDirectory),
    });
  }

  /** `runSearch` entry for a parsed browse prefix + query. */
  private runBrowseInput(prefix: BrowsePrefix, query: string): void {
    const transition = !this.browseActive || prefix !== this.browsePrefix;
    const queryChanged = query !== this.browseQuery;
    this.browseActive = true;
    this.browsePrefix = prefix;
    this.browseQuery = query;
    if (transition) {
      this.browseNotice = null;
      const gen = ++this.browseLocateGen;
      // Both prefixes start at the roots; `/c ` moves on once the service has
      // resolved the document's folder (a notice explains when it can't).
      this.setBrowseLocation(null);
      if (prefix === '/c') void this.jumpBrowseToCurrent(gen);
      return;
    }
    if (queryChanged) {
      this.visibleCount = RESULT_PAGE_SIZE;
      this.selected = 0;
    }
    this.runBrowse();
  }

  private async jumpBrowseToCurrent(gen: number): Promise<void> {
    const token = this.asyncToken;
    const live = (): boolean =>
      !!this.root && token === this.asyncToken && this.browseActive
      && this.browsePrefix === '/c' && gen === this.browseLocateGen;
    if (!this.docPath) {
      this.browseNotice = 'The current document has no saved location yet. Save it inside a file-search folder to use /c.';
      this.runBrowse();
      return;
    }
    try {
      const client = await getFileIndexClient();
      if (!client || !live()) return;
      const located = await client.locateCurrentFile({
        filePath: this.docPath,
        roots: settings.get('fileSearchRoots'),
        exclusions: settings.get('fileSearchExclusions'),
      });
      if (!live()) return;
      if (located.ok) {
        this.browseNotice = null;
        this.setBrowseLocation(located.location);
      } else {
        this.browseNotice = located.reason === 'excluded'
          ? 'The current document is excluded from file search. Remove that exclusion to use /c.'
          : 'The current document is not inside a file-search folder. Add its folder under Settings → Files to use /c.';
        this.runBrowse();
      }
    } catch {
      if (!live()) return;
      this.browseNotice = 'The current document’s folder could not be resolved.';
      this.runBrowse();
    }
  }

  private browseParamsKey(location: FileBrowseLocation, query: string, limit: number): string {
    return JSON.stringify([
      location,
      query,
      limit,
      settings.get('fileSearchRoots'),
      settings.get('fileSearchExclusions'),
      settings.get('fileSearchFormats'),
      settings.get('fileSearchTiebreak'),
      [...this.manualPinPaths()].sort(),
    ]);
  }

  /** Fetch `location`'s rows for `query` from the index service unless the
   *  window already holds them. Mirrors `ensureFileQuery`: the arrival re-
   *  runs the search, and a result for a location or query the user has
   *  since left is dropped. */
  private ensureBrowse(location: FileBrowseLocation, query: string): 'ready' | 'loading' {
    const limit = Math.max(this.visibleCount, RESULT_PAGE_SIZE);
    const key = this.browseParamsKey(location, query, limit);
    if (this.browseQueryKey === key) return 'ready';
    if (this.browseQueryPending === key) return 'loading';
    this.browseQueryPending = key;
    const gen = ++this.browseGen;
    const token = this.asyncToken;
    const still = (): boolean =>
      !!this.root && token === this.asyncToken && this.browseActive
      && this.browseLocation?.root === location.root
      && this.browseLocation.relativeDirectory === location.relativeDirectory
      && this.browseQuery === query;
    void (async () => {
      try {
        const client = await getFileIndexClient();
        if (!client) throw new Error('no index client');
        const res = await client.browse({
          roots: settings.get('fileSearchRoots'),
          location,
          query,
          exclusions: settings.get('fileSearchExclusions'),
          formats: settings.get('fileSearchFormats'),
          tiebreak: settings.get('fileSearchTiebreak'),
          pins: [...this.manualPinPaths()],
          limit,
        });
        if (!still() || gen <= this.browseGenApplied) return;
        this.browseGenApplied = gen;
        if (this.browseQueryPending === key) this.browseQueryPending = null;
        if (!res.valid) {
          // The branch is gone from the index (a folder emptied / removed):
          // step up to the nearest one that still exists.
          this.browseQueryKey = null;
          this.browseUp();
          return;
        }
        this.browseQueryKey = key;
        this.browseRows = res.rows;
        this.browseTotal = res.total;
        this.rerunPreservingView();
      } catch {
        if (!still()) return;
        if (this.browseQueryPending === key) this.browseQueryPending = null;
        this.browseQueryKey = key;
        this.browseRows = [];
        this.browseTotal = 0;
        this.rerunPreservingView();
      }
    })();
    return 'loading';
  }

  private runBrowse(): void {
    const electron = getElectronHost();
    if (!electron) {
      this.browseTotal = 0;
      this.results = [];
      this.emptyText = 'Folder browsing needs the desktop app.';
      this.finishBrowse();
      return;
    }
    const roots = settings.get('fileSearchRoots');
    if (!roots.length) {
      this.browseTotal = 0;
      this.results = [];
      this.emptyText = 'No file-search folders yet — add one under Settings → Files → File search.';
      this.finishBrowse();
      return;
    }
    if (!this.browseLocation) {
      // The roots level: filter by folder name (full path as the secondary field).
      const tokens = tokenizeQuery(this.browseQuery);
      this.results = roots
        .filter((r) => tokens.length === 0 || matchesAllTokens(pathBase(r).toLowerCase(), r.toLowerCase(), tokens))
        .map(rootResult);
      this.browseTotal = this.results.length;
      this.emptyText = tokens.length ? 'No file-search folder matches.' : 'No file-search folders configured.';
      this.finishBrowse();
      return;
    }
    const state = this.ensureBrowse(this.browseLocation, this.browseQuery);
    this.results = this.browseRows.map((r) => browseResult(r, this.browseLocation!.root));
    this.emptyText = state === 'loading' && this.browseQueryKey === null
      ? 'Loading folder…'
      : this.browseQuery.trim() !== ''
        ? 'Nothing in this folder matches.'
        : 'No indexed documents in this folder.';
    this.finishBrowse();
  }

  private finishBrowse(): void {
    this.fullResults = this.results;
    this.fileTail = [];
    this.fileTailTotal = 0;
    this.materializedTail = [];
    this.results = this.fullResults.slice(0, this.visibleCount);
    this.selected = Math.min(this.selected, Math.max(0, this.results.length - 1));
    this.renderResults();
  }

  // ── File search (`f` prefix) ──────────────────────────────────────

  private runFileSearch(query: string): void {
    const electron = getElectronHost();
    if (!electron) {
      this.results = [];
      this.emptyText = 'File search needs the desktop app.';
      this.finishSearch();
      return;
    }
    const roots = settings.get('fileSearchRoots');
    if (!roots.length) {
      this.results = [];
      this.emptyText = 'Add a file-search folder in Settings → General.';
      this.finishSearch();
      return;
    }
    // ★ + top-sort reflect MANUAL pins (the user-controlled feature);
    // auto pins (recents/frequents) are warmed silently, not surfaced.
    // The ranking, pin partition, exclusion + format filters all run in
    // the file-index service; we hold only the returned window.
    const state = this.ensureFileQuery(query, /* partitionPins */ true);
    this.results = [];
    this.emptyText =
      state === 'loading' && this.fileQueryKey === null
        ? 'Searching files…'
        : query.trim() === '' && this.fileTotal === 0
          ? 'No files in the search folder.'
          : 'No matching files.';
    // Everything here is a file — the whole result set is the lazy tail.
    // While a fresh query is in flight the PREVIOUS rows stay up (no
    // flicker); the arrival re-runs this search with the new window.
    this.finishSearch(this.fileRows, this.fileTotal);
  }

  /** Params key for a file query — anything that changes the ranked
   *  window invalidates the fetched rows. */
  private fileParamsKey(query: string, partitionPins: boolean, limit: number): string {
    return JSON.stringify([
      query,
      partitionPins,
      limit,
      settings.get('fileSearchRoots'),
      settings.get('fileSearchExclusions'),
      settings.get('fileSearchFormats'),
      settings.get('fileSearchTiebreak'),
      [...this.manualPinPaths()].sort(),
    ]);
  }

  /** Ensure `fileRows`/`fileTotal` (eventually) reflect this query: kick
   *  an async service query unless the fetched or in-flight rows already
   *  match. The arrival re-runs the search, which finds 'ready'. */
  private ensureFileQuery(query: string, partitionPins: boolean): 'ready' | 'loading' {
    this.lastFileParams = { query, partitionPins };
    const limit = Math.max(this.visibleCount, RESULT_PAGE_SIZE);
    const key = this.fileParamsKey(query, partitionPins, limit);
    if (this.fileQueryKey === key) return 'ready';
    if (this.fileQueryPending === key) return 'loading';
    this.fileQueryPending = key;
    const gen = ++this.fileQueryGen;
    const token = this.asyncToken;
    void (async () => {
      let rows: FileIndexRow[] = [];
      let total = 0;
      try {
        const client = await getFileIndexClient();
        if (client) {
          const res = await client.query({
            query,
            roots: settings.get('fileSearchRoots'),
            exclusions: settings.get('fileSearchExclusions'),
            formats: settings.get('fileSearchFormats'),
            tiebreak: settings.get('fileSearchTiebreak'),
            pins: [...this.manualPinPaths()],
            partitionPins,
            limit,
          });
          rows = res.rows;
          total = res.total;
        }
      } catch {
        /* service down — treat as empty; the next keystroke retries */
      }
      if (token !== this.asyncToken || !this.root) return;
      // Latest-wins, applied PROGRESSIVELY: a response older than the
      // one already applied is dropped, but an in-order response is
      // folded in even when a newer query is still in flight — during
      // fast typing the rows keep moving instead of freezing until the
      // final keystroke's answer.
      if (gen <= this.fileGenApplied) return;
      this.fileGenApplied = gen;
      if (this.fileQueryPending === key) this.fileQueryPending = null;
      this.fileQueryKey = key;
      this.fileRows = rows;
      this.fileTotal = total;
      // Fold the fresh window in without disturbing the user's view.
      this.rerunPreservingView();
    })();
    return 'loading';
  }

  /** Re-run the current search keeping the user's place: the expanded
   *  "show more" window survives (finishSearch resets it) and the
   *  selected row is re-found by key — an async arrival or background
   *  index refresh must never yank the cursor or collapse the list. */
  private rerunPreservingView(): void {
    const keepVisible = this.visibleCount;
    const sel = this.results[this.selected];
    const prevKey = sel ? resultKey(sel) : null;
    this.runSearch();
    if (keepVisible > this.visibleCount) {
      this.visibleCount = keepVisible;
      this.results = this.windowResults();
      this.renderResults();
    }
    this.restoreSelection(prevKey);
  }

  /** A scan/revalidation landed a fresh listing in the service: drop the
   *  fetched window (stale) and, when a file view is showing, re-query
   *  live. Pins re-warm against the new mtimes either way. */
  private onIndexChanged(): void {
    if (!this.root) return;
    this.fileQueryKey = null;
    void this.warmPins();
    if (this.inFile) return;
    if (this.browseActive) {
      this.browseQueryKey = null;
      this.rerunPreservingView();
      return;
    }
    const { prefix, query } = parsePrefix(this.input.value);
    const fileVisible = prefix === 'f' || (prefix === null && query.trim() !== '');
    if (!fileVisible) return;
    this.rerunPreservingView();
  }

  /** Manually-pinned paths (★ + top-sort). `autoEnabled: false` makes
   *  `effectivePins` return just the manual set. Memoized for the
   *  palette session — the store read is a localStorage JSON parse,
   *  which has no place on the per-keystroke path. Invalidated by
   *  `togglePinPath` (pins can't otherwise change while we're open). */
  private pinsCache: Set<string> | null = null;
  private manualPinPaths(): Set<string> {
    return (this.pinsCache ??= effectivePins([], false));
  }

  /** Background pass while the palette is open: fetch fresh mtimes for
   *  the pinned paths from the service (exclusions honored there), then
   *  delegate to the shared warm pass (which yields to idle before each
   *  parse), bailing if the palette closes mid-flight. */
  private async warmPins(): Promise<void> {
    const electron = getElectronHost();
    if (!electron) return;
    const roots = settings.get('fileSearchRoots');
    if (!roots.length) return;
    const client = await getFileIndexClient();
    if (!client || !this.root) return;
    let entries: Array<{ path: string; mtimeMs: number }>;
    try {
      entries = await client.entriesForPaths({
        paths: [...effectivePinPaths()],
        roots,
        exclusions: settings.get('fileSearchExclusions'),
      });
    } catch {
      return; // service down — the next open retries
    }
    if (!this.root) return;
    await runWarmPass(electron, entries, () => !!this.root);
  }

  /** Toggle a file's manual pin, keeping it selected and re-warming. */
  private togglePinPath(path: string): void {
    toggleManualPin(path);
    this.pinsCache = null; // re-read the store on the next search
    this.runSearch(); // re-sort + refresh ★
    const at = this.results.findIndex((r) => r.filePath === path);
    if (at >= 0) this.setSelected(at);
    void this.warmPins();
  }

  /** Confirm, then add a file to the exclusion setting and drop it from
   *  the live results. A pin on the file is deliberately left in place —
   *  exclusion beats pins everywhere they could surface (the service
   *  filters both queries and the warm-pass entries), so the pin just
   *  goes dormant until the entry is removed in Settings. */
  private async excludeFile(path: string, displayName: string): Promise<void> {
    const confirmed = await showConfirm({
      title: `Exclude “${displayName}” from file search?`,
      message:
        'It will stop appearing in file search results everywhere. To undo, '
        + 'remove it under Settings → Files → File search: exclusions.',
      confirmLabel: 'Exclude',
      cancelLabel: 'Cancel',
    });
    if (!confirmed) return;
    const current = settings.get('fileSearchExclusions');
    if (!current.includes(path)) {
      settings.set('fileSearchExclusions', [...current, path]);
    }
    if (!this.root) return; // palette closed while the dialog sat open
    // Exclusions are part of the query key, so re-running re-fetches.
    if (!this.inFile) this.runSearch();
  }


  /** Re-point the selection at the row matching `key` after a re-render,
   *  so a background refresh doesn't bounce the cursor to the top. */
  private restoreSelection(key: string | null): void {
    if (!key) return;
    const at = this.results.findIndex((r) => resultKey(r) === key);
    if (at > 0) this.setSelected(at);
  }

  /** Tab from a selected file → enter in-file mode with the bar cleared.
   *  Uses the warm cache when the file is pinned + fresh (instant); else
   *  reads + parses, warming it if it's pinned. Records usage either way. */
  private async enterInFile(): Promise<void> {
    const sel = this.results[this.selected];
    if (!sel || sel.source !== 'file' || !sel.filePath) return;
    const electron = getElectronHost();
    if (!electron) return;
    const path = sel.filePath;
    const name = sel.name;
    const mtimeMs = sel.fileMtimeMs ?? 0;
    const savedQuery = this.input.value;
    const returnBrowse = this.browseActive
      ? {
          location: this.browseLocation ? { ...this.browseLocation } : null,
          selectedKey: resultKey(sel),
        }
      : null;
    recordUsage(path);

    // Warm hit — no read/parse; at most one fromJSON (warmDocOf) when
    // the entry came from the worker warm path. Re-extract from the doc
    // only if the searchable-object set changed since it was warmed.
    const warm = warmCache.get(path);
    if (warm && warm.mtimeMs === mtimeMs) {
      const warmDoc = warmDocOf(warm);
      if (warm.enabledSig !== enabledSig()) {
        const re = extractFile(warmDoc, enabledSet());
        warm.objects = re.objects;
        warm.outline = re.outline;
        warm.enabledSig = enabledSig();
      }
      this.mountInFile(path, name, warmDoc, warm.objects, warm.outline, savedQuery, returnBrowse);
      return;
    }

    // Cold — read, then parse + extract off-thread (worker; inline
    // fallback), materializing the live doc for the mount.
    this.results = [];
    this.emptyText = `Opening "${name}"…`;
    this.finishSearch();
    const token = ++this.asyncToken;
    let doc: PMNode;
    let objects: FileObject[];
    let outline: OutlineEntry[];
    try {
      const file = await electron.readFileAtPath(path);
      if (!file) throw new Error('read failed');
      const parsed = await parseAndExtract(file.bytes, file.format, /* wantLiveDoc */ true);
      doc = parsed.doc!;
      objects = parsed.objects;
      outline = parsed.outline;
    } catch {
      if (token !== this.asyncToken || !this.root) return;
      showToast(`Couldn't read "${name}".`);
      this.runSearch(); // stay in file mode
      return;
    }
    if (token !== this.asyncToken || !this.root) return;
    // Keep it warm if this file is pinned.
    if (mtimeMs && effectivePinPaths().has(path)) {
      warmCache.set(path, { mtimeMs, enabledSig: enabledSig(), doc, docJson: null, objects, outline });
      pruneWarm(effectivePinPaths());
    }
    this.mountInFile(path, name, doc, objects, outline, savedQuery, returnBrowse);
  }

  /** Enter in-file mode with an already-extracted file: seed the
   *  collapsed set from the default depth, clear the bar, render. */
  private mountInFile(
    path: string,
    name: string,
    doc: PMNode,
    objects: FileObject[],
    outline: OutlineEntry[],
    savedQuery: string,
    returnBrowse: { location: FileBrowseLocation | null; selectedKey: string } | null,
  ): void {
    // Headings at or deeper than the default depth start collapsed
    // (depth 3 → blocks closed), mirroring the nav pane's default depth.
    const depth = settings.get('fileSearchOutlineDepth');
    const collapsedIdx = new Set<number>();
    outline.forEach((e, i) => {
      if (e.level >= depth) collapsedIdx.add(i);
    });
    this.inFile = { path, name, doc, objects, outline, collapsedIdx, savedQuery, returnBrowse };
    this.input.value = '';
    this.input.placeholder = `Search in ${name}…`;
    this.runSearch();
  }

  /** Visible outline rows for the browse — walks `outline` honoring the
   *  collapsed set (a collapsed heading hides everything under it until
   *  the next equal-or-shallower heading). Each row carries its outline
   *  index + collapsible / collapsed flags for the chevron + toggle. */
  private buildOutlineResults(): PaletteResult[] {
    if (!this.inFile) return [];
    const { outline, collapsedIdx } = this.inFile;
    const out: PaletteResult[] = [];
    let hideBelow = Infinity; // hide entries with level > hideBelow
    outline.forEach((e, i) => {
      if (e.level <= hideBelow) hideBelow = Infinity; // left the collapsed subtree
      if (hideBelow !== Infinity) return; // still hidden
      const next = outline[i + 1];
      const collapsible = e.level <= 3 && !!next && next.level > e.level;
      const collapsed = collapsedIdx.has(i);
      out.push({
        source: 'fileobject',
        name: e.label || '(untitled)',
        meta: '',
        matchedName: true,
        snippet: null,
        fileRange: { from: e.from, to: e.to },
        fileObjectKind: e.kind,
        indentLevel: e.level,
        outlineIndex: i,
        collapsible,
        collapsed,
      });
      if (collapsible && collapsed) hideBelow = e.level;
    });
    return out;
  }

  /** Toggle a heading's collapsed state (right-click / chevron), keeping
   *  the toggled row selected. */
  private toggleOutlineCollapse(outlineIndex: number): void {
    if (!this.inFile) return;
    const set = this.inFile.collapsedIdx;
    if (set.has(outlineIndex)) set.delete(outlineIndex);
    else set.add(outlineIndex);
    this.results = this.buildOutlineResults();
    this.fullResults = this.results;
    const at = this.results.findIndex((r) => r.outlineIndex === outlineIndex);
    this.selected = at >= 0 ? at : Math.min(this.selected, this.results.length - 1);
    this.renderResults();
  }

  /** Right-click on an in-file SEARCH result: clear the query and reveal
   *  the same object in the outline browse, ancestors expanded and its
   *  row selected — the hit shown in the file's structure instead of a
   *  flat list. The row itself keeps its collapsed state; only what's
   *  ABOVE it needs opening for it to be visible. */
  private jumpToOutline(range: { from: number; to: number }): void {
    if (!this.inFile) return;
    const { outline, collapsedIdx } = this.inFile;
    // The object's outline row shares its `from` (a cite result carries
    // its tag's card range, so it lands on the tag row — cites aren't
    // outline rows). Fall back to the DEEPEST row whose span contains
    // the range start, for object kinds the outline doesn't list.
    let target = outline.findIndex((e) => e.from === range.from);
    if (target === -1) {
      for (let i = 0; i < outline.length; i++) {
        const e = outline[i]!;
        if (e.from <= range.from && range.from < e.to) target = i; // deepest wins
      }
    }
    if (target === -1) return;
    // Expand every ancestor (the nearest shallower entry, walking up).
    let level = outline[target]!.level;
    for (let i = target - 1; i >= 0 && level > 1; i--) {
      if (outline[i]!.level < level) {
        collapsedIdx.delete(i);
        level = outline[i]!.level;
      }
    }
    this.input.value = '';
    this.runSearch(); // empty in-file query → the outline browse
    const at = this.results.findIndex((row) => row.outlineIndex === target);
    if (at >= 0) {
      this.setSelected(at);
      // A jump is a navigation, not a keyboard step: pin the revealed
      // row to the TOP of the results viewport (setSelected's 'nearest'
      // leaves it hugging the bottom edge after the downward scroll).
      this.rowEls[at]?.scrollIntoView({ block: 'start' });
    }
    this.input.focus();
  }

  /** Esc from in-file mode → back to the file list, restoring the query. */
  private exitInFile(): void {
    if (!this.inFile) return;
    const { savedQuery, returnBrowse } = this.inFile;
    this.inFile = null;
    if (returnBrowse) this.browseLocation = returnBrowse.location;
    this.input.placeholder = SEARCH_PLACEHOLDER;
    this.input.value = savedQuery;
    this.runSearch();
    if (returnBrowse) {
      const at = this.results.findIndex((r) => resultKey(r) === returnBrowse.selectedKey);
      if (at >= 0) this.setSelected(at);
    }
    // Re-focus the box — Escape may have come from the results with the box
    // unfocused, and the user expects to land back in a usable search.
    this.input.focus();
  }

  private move(delta: number): void {
    if (this.results.length === 0) return;
    const next = this.selected + delta;
    // Arrowing past the last rendered row reveals the next page instead
    // of wrapping, when there is one — the keyboard path to "show more".
    if (next >= this.results.length && this.totalCount() > this.results.length) {
      this.showMore();
      this.setSelected(Math.min(next, this.results.length - 1));
      return;
    }
    this.setSelected((next + this.results.length) % this.results.length);
  }

  /** Bottom hint strip — reflects what Enter / Alt+Enter / Tab / Esc
   *  actually do given the current mode and the selected result. */
  private renderHints(): void {
    const sel = this.results[this.selected];
    const inFile = !!this.inFile;
    const segs: string[] = [];

    if (this.results.length > 0) segs.push('↑↓ navigate');
    if (sel) {
      segs.push(`↵ ${enterVerb(sel.source)}`);
      // Alt+Enter (insert at end of doc) only applies to inserts.
      if (isInsertSource(sel.source)) segs.push('⌥↵ at end');
      // In-file: any header can be transcluded (live zone) instead of copied.
      if (inFile && sel.source === 'fileobject' && !this.transcludeMode) {
        segs.push('⌘↵ transclude');
      }
    }
    // Tab: dive into a selected file, else open the tag filter — and
    // nothing while already inside a file.
    if (!inFile) {
      if (sel?.source === 'folder') segs.push('⇥ enter folder');
      else if (sel?.source === 'file') segs.push('⇥ search inside');
      else if (!this.browseActive) segs.push('⇥ tags');
    }
    if (sel?.source === 'file') segs.push(sel.pinned ? 'alt+p unpin' : 'alt+p pin');
    // Outline browse (in-file, empty query) → mention collapse.
    if (inFile && this.input.value.trim() === '' && this.results.some((r) => r.collapsible)) {
      segs.push('right-click: expand/collapse');
    }
    segs.push(inFile
      ? (this.inFile?.returnBrowse ? 'esc back to folder' : 'esc back to files')
      : this.browseActive && this.browseLocation ? 'esc folder up' : 'esc close');

    this.hintsEl.replaceChildren(
      ...segs.map((s) => {
        const span = document.createElement('span');
        span.textContent = s;
        return span;
      }),
    );
  }

  private renderResults(): void {
    this.renderHints();
    this.renderBrowseChrome();
    this.resultsEl.innerHTML = '';
    this.rowEls = [];
    if (this.results.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pmd-qcs-empty';
      if (this.emptyText.startsWith('Type to search everything · ')) {
        const parts = this.emptyText.split(' · ');
        parts.forEach((part, i) => {
          if (i > 0) {
            const separator = document.createElement('strong');
            separator.className = 'pmd-qcs-empty-separator';
            separator.textContent = ' · ';
            empty.appendChild(separator);
          }
          empty.appendChild(document.createTextNode(part));
        });
      } else {
        empty.textContent = this.emptyText;
      }
      this.resultsEl.appendChild(empty);
      return;
    }
    this.results.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'pmd-qcs-row';
      row.setAttribute('role', 'option');
      if (i === this.selected) {
        row.classList.add('pmd-qcs-row-active');
        row.setAttribute('aria-selected', 'true');
      }
      // Outline browse: indent by heading depth for a nav-pane look.
      if (r.indentLevel) {
        row.style.paddingLeft = `${0.5 + (r.indentLevel - 1) * 1}rem`;
      }
      const top = document.createElement('div');
      top.className = 'pmd-qcs-row-top';
      // Outline rows get a collapse chevron (collapsible) or a spacer
      // (to keep labels aligned). Right-click the row also toggles.
      if (r.indentLevel !== undefined) {
        const twisty = document.createElement('span');
        twisty.className = 'pmd-qcs-twisty';
        if (r.collapsible) {
          twisty.classList.add('pmd-qcs-twisty-btn');
          twisty.appendChild(icon(r.collapsed ? 'chevron-right' : 'chevron-down'));
          twisty.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (r.outlineIndex !== undefined) this.toggleOutlineCollapse(r.outlineIndex);
          });
        }
        top.appendChild(twisty);
        row.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          if (!isRightClickContextMenu(ev)) return;
          if (r.collapsible && r.outlineIndex !== undefined) {
            this.toggleOutlineCollapse(r.outlineIndex);
          }
        });
      } else if (this.inFile && r.source === 'fileobject' && r.fileRange) {
        // Flat in-file SEARCH result (left-click inserts): right-click
        // clears the query and reveals this hit in the outline browse —
        // "show me where this lives in the file".
        const range = r.fileRange;
        row.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          if (!isRightClickContextMenu(ev)) return;
          this.jumpToOutline(range);
        });
      } else if (r.source === 'folder') {
        row.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          if (!isRightClickContextMenu(ev)) return;
          this.selected = i;
          this.enterBrowseFolder(r);
        });
      }
      const badge = document.createElement('span');
      badge.className = `pmd-qcs-row-badge pmd-qcs-badge-${r.source}`;
      badge.textContent = badgeText(r);
      top.appendChild(badge);
      const name = document.createElement('span');
      name.className = 'pmd-qcs-row-name';
      name.textContent = r.name;
      top.appendChild(name);
      let meta: HTMLSpanElement | null = null;
      if (r.meta) {
        meta = document.createElement('span');
        meta.className = 'pmd-qcs-row-tags';
        meta.textContent = r.meta;
        top.appendChild(meta);
      }
      // Tooltip with the full name / directory, but only when the
      // ellipsis actually cut something off. Checked lazily on hover
      // — layout isn't final while rows are being built, and this
      // stays correct across palette resizes.
      row.addEventListener('mouseenter', () => {
        for (const el of meta ? [name, meta] : [name]) {
          if (el.scrollWidth > el.clientWidth) el.title = el.textContent ?? '';
          else el.removeAttribute('title');
        }
      });
      // Pin star on file rows — filled when pinned, faint otherwise.
      // Click the star to toggle the pin.
      if (r.source === 'file' && r.filePath) {
        const path = r.filePath;
        const star = document.createElement('span');
        star.className = r.pinned ? 'pmd-qcs-star pmd-qcs-star-on' : 'pmd-qcs-star';
        star.textContent = '★';
        star.title = r.pinned ? 'Unpin' : 'Pin (keep warm)';
        star.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.togglePinPath(path);
        });
        top.appendChild(star);
        // Exclude button beside the star: adds the file to the
        // file-search exclusion list (confirmed first — it's one click
        // away from vanishing from every search).
        const exclude = document.createElement('span');
        exclude.className = 'pmd-qcs-exclude';
        exclude.textContent = '⊘';
        exclude.title = 'Exclude from file search';
        exclude.addEventListener('click', (ev) => {
          ev.stopPropagation();
          void this.excludeFile(path, r.name);
        });
        top.appendChild(exclude);
        // Right-click dives into the file — same as Tab. Pinning has its own
        // star, so the context menu is free for the more useful action.
        row.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          if (!isRightClickContextMenu(ev)) return;
          this.selected = i;
          void this.enterInFile();
        });
      }
      row.appendChild(top);
      if (!r.matchedName && r.snippet) {
        const snip = document.createElement('div');
        snip.className = 'pmd-qcs-row-snippet';
        snip.textContent = r.snippet;
        row.appendChild(snip);
      }
      row.addEventListener('mousemove', () => {
        if (this.selected !== i) this.setSelected(i);
      });
      row.addEventListener('click', (e) => {
        this.selected = i;
        this.activateSelected(false, e.metaKey || e.ctrlKey);
      });
      this.resultsEl.appendChild(row);
      this.rowEls.push(row);
    });
    // Overflow indicator + expander. A div (not a button) so clicking it
    // can't steal focus from the search input, which owns the keyboard.
    if (this.totalCount() > this.results.length) {
      const more = document.createElement('div');
      more.className = 'pmd-qcs-more';
      more.setAttribute('role', 'button');
      more.textContent = `Showing ${this.results.length} of ${this.totalCount()} — show more`;
      more.addEventListener('click', () => this.showMore());
      this.resultsEl.appendChild(more);
    }
    this.resultsEl.querySelector('.pmd-qcs-row-active')?.scrollIntoView({ block: 'nearest' });
  }

  /** Move the active-row highlight without rebuilding the list.
   *  Selection changes (hover, arrow keys) only need the active class
   *  swapped between two rows plus a hints refresh — a full rebuild
   *  here is O(rows) per event (and outline browse is uncapped).
   *  `renderResults` remains the path for changes to `results` itself. */
  private setSelected(i: number): void {
    const prev = this.rowEls[this.selected];
    if (prev) {
      prev.classList.remove('pmd-qcs-row-active');
      prev.removeAttribute('aria-selected');
    }
    this.selected = i;
    const next = this.rowEls[i];
    if (next) {
      next.classList.add('pmd-qcs-row-active');
      next.setAttribute('aria-selected', 'true');
      next.scrollIntoView({ block: 'nearest' });
    }
    this.renderHints();
  }

  // ── Insert ────────────────────────────────────────────────────────

  private renderBrowseChrome(): void {
    const show = this.browseActive && !this.inFile;
    this.browseHeaderEl.hidden = !show;
    this.browseNoticeEl.hidden = !show || !this.browseNotice;
    if (!show) return;
    if (this.browseLocation) {
      const relativeParts = pathParts(this.browseLocation.relativeDirectory);
      const fullParts = [
        pathBase(this.browseLocation.root),
        ...relativeParts,
      ];
      const visibleParts = relativeParts.length >= 2
        ? ['…', ...relativeParts.slice(-2)]
        : fullParts;
      const path = document.createElement('span');
      path.className = 'pmd-qcs-browse-path';
      path.textContent = visibleParts.join(' / ');
      const hint = document.createElement('span');
      hint.className = 'pmd-qcs-browse-current-hint';
      hint.textContent = this.browseQuery.trim() !== ''
        ? 'searching this folder and below'
        : 'type to search this folder';
      this.browseHeaderEl.replaceChildren(path, hint);
    } else {
      const title = document.createElement('span');
      title.textContent = 'Browse folders';
      const currentHint = document.createElement('span');
      currentHint.className = 'pmd-qcs-browse-current-hint';
      currentHint.textContent = '/c  starts in the current document’s folder';
      this.browseHeaderEl.replaceChildren(title, currentHint);
    }
    this.browseNoticeEl.textContent = this.browseNotice ?? '';
  }

  private activateSelected(atEnd: boolean, transclude = false): void {
    const result = this.results[this.selected];
    if (!result) return;
    if (result.source === 'folder') {
      this.enterBrowseFolder(result);
      return;
    }
    // Commands: close the palette, then run the command (it acts on the
    // editor with focus restored). atEnd is irrelevant for commands.
    if (result.source === 'command') {
      const id = result.commandId!;
      this.close();
      this.runCommand(id);
      return;
    }
    // Setting toggle: flip the boolean in place and confirm with a toast.
    // The settings subscriber propagates the change to the live view / other
    // windows, so there's nothing else to wire here.
    if (result.source === 'settingtoggle') {
      this.close();
      runSettingToggle(result.toggleSettingKey!);
      return;
    }
    // Setting cycle: advance the enum/mode setting to its next value.
    if (result.source === 'settingcycle') {
      this.close();
      runSettingCycle(result.cycleSettingKey!);
      return;
    }
    // Settings: close the palette, then open the dialog to the tab and
    // scroll to the setting. atEnd is irrelevant. settings-ui is
    // lazy-loaded (see index.ts) — first open fetches its chunk.
    if (result.source === 'settings') {
      const target = result.settingsTarget;
      this.close();
      void import('./settings-ui.js').then((m) => m.openSettings(target));
      return;
    }
    // Window: close the palette and bring that window to the front.
    if (result.source === 'window') {
      const id = result.windowId!;
      this.close();
      void getElectronHost()
        ?.focusWindow(id)
        .then((ok) => {
          if (!ok) showToast('That window has closed.');
        });
      return;
    }
    // File: close the palette, then open the document. atEnd irrelevant.
    if (result.source === 'file') {
      const path = result.filePath;
      const name = result.name;
      if (path) recordUsage(path); // counts toward "frequents"
      this.close();
      if (path) this.openFilePath(path, name);
      return;
    }
    // Everything else (quickcard / dropzone / fileobject) inserts a slice.
    const view = this.view;
    if (!view || !view.editable) {
      showToast('No editable document to insert into.');
      return;
    }
    // Transclude a selected header into a live zone instead of a copy — either
    // per-pick via Mod+Enter / Mod+click while browsing normally, or by default
    // when the palette was opened in transclude mode. Keeps the palette open so
    // several can be grabbed in a row.
    if (
      (transclude || this.transcludeMode) &&
      result.source === 'fileobject' &&
      result.fileRange &&
      this.inFile
    ) {
      void this.insertLiveZoneFromFileObject(result);
      return;
    }
    let slice: Slice;
    try {
      if (result.source === 'fileobject' && result.fileRange && this.inFile) {
        // Slice lazily from the kept parsed doc (no per-object slice held).
        // A live view inside the section is a reference into THAT file:
        // materialize it here, while the file's doc is in hand (the insert
        // path can only unwrap linked copies).
        slice = flattenSelfRefsInSlice(
          this.inFile.doc.slice(result.fileRange.from, result.fileRange.to),
          this.inFile.doc,
          newHeadingId,
        );
      } else {
        slice = checkedSliceFromJSON(result.sliceJson);
      }
    } catch {
      showToast('That item is corrupted and can’t be inserted.');
      return;
    }
    // Inserting a within-file object keeps the palette open and the file
    // loaded so several blocks can be grabbed in a row (the file's slices
    // are already in memory — no re-parse). Everything else closes.
    //
    // The mid-text guard is a native `window.confirm`, so it can't
    // trigger the outside-click close. The disruption to guard against is
    // focus: insertSpeechSlice's deferred insert ends with a
    // `speechView.focus()`, so we re-claim the bar via `afterInsert`
    // (which also runs only on a real insert — no toast on cancel).
    const keepOpen = !!this.inFile && result.source === 'fileobject';
    if (!keepOpen) this.close();
    const name = result.name;
    insertSpeechSlice(
      view,
      slice,
      atEnd,
      keepOpen
        ? () => {
            showToast(`Inserted "${name}".`);
            this.input.focus();
          }
        : undefined,
    );
    // insertSpeechSlice's deferred dispatch ends by focusing the editor view;
    // pull focus back to the bar so a keep-open insert leaves you ready to
    // search again.
    if (keepOpen) this.input.focus();
  }

  /** Build and insert a live zone from a selected header inside the dived-into
   *  file. Snapshots the section now (the file is already parsed), computes a
   *  portable source ref, and guards against direct self-embedding. */
  private async insertLiveZoneFromFileObject(result: PaletteResult): Promise<void> {
    const view = this.view;
    if (!view || !this.inFile || !result.fileRange) return;
    const inFile = this.inFile;
    // Capture everything the insert needs BEFORE any await: the `.docx` anchor
    // flow shows an async confirm dialog, and clicking it fires the palette's
    // outside-pointer close — which nulls this.docPath / this.inFile / this.root
    // (a native `window.confirm` was synchronous, so it never did). Working off
    // captured locals lets the zone still land after OK.
    const docPath = this.docPath;
    const rePickTarget = this.rePickTarget;
    // A tag/analytic source's outline range starts at the enclosing card /
    // analytic_unit, whose id lives on its heading child — resolveHeadingIdAt
    // digs it out (nodeAt().attrs.id alone fails for single-card sources),
    // and the anchor cross-check needs that heading PARAGRAPH's text, not
    // the wrapper's whole-card textContent.
    const headingId = resolveHeadingIdAt(inFile.doc, result.fileRange.from);
    const headingText = headingTextAt(inFile.doc, result.fileRange.from, headingId);
    const roots = (settings.get('fileSearchRoots') as string[] | undefined) ?? [];
    const outcome = buildLiveZoneAttrs(
      schema,
      inFile.doc,
      headingId,
      inFile.name,
      docPath,
      inFile.path,
      roots,
    );
    if (!outcome.ok || !outcome.attrs) {
      showToast(buildZoneErrorMessage(outcome.reason));
      return;
    }
    // A `.docx` source can only refresh if the heading carries a stable
    // `pmd-heading` bookmark. If it doesn't, offer to add one (a tiny bookmark,
    // nothing else changes); if that can't happen, refuse rather than create a
    // zone that could never refresh. `.cmir` sources already carry stable ids.
    if (inFile.path.toLowerCase().endsWith('.docx')) {
      const ready = await this.ensureDocxSourceAnchor(
        result.fileRange.from,
        headingId,
        headingText,
        outcome.attrs,
        roots,
        docPath,
        inFile.name,
      );
      if (!ready) return; // messaged inside (the palette may have closed during
      // the confirm — the captured `view` / `outcome` below still insert).
    }
    if (rePickTarget != null) {
      // Re-pick source: re-target the existing zone in place (one-shot → close).
      const ok = replaceZoneAtPos(
        view,
        rePickTarget.pos,
        rePickTarget.identity,
        outcome.attrs,
        outcome.content,
      );
      showToast(ok ? `Re-linked live zone "${outcome.headingLabel}".` : 'That live zone is no longer here.');
      this.close();
      return;
    }
    insertZoneAtSelection(view, outcome.attrs, outcome.content);
    showToast(`Inserted live zone "${outcome.headingLabel}".`);
    this.input?.focus();
  }

  /** Ensure a `.docx` source's picked heading carries a `pmd-heading` bookmark
   *  so the live zone can refresh from it. Reads the file, re-derives the
   *  heading's source-paragraph index (a provenance re-parse — node positions
   *  are stable across parses even though a raw Word file's heading ids aren't),
   *  injects a single bookmark in-memory, and — only when a write is actually
   *  needed — confirms before writing it back atomically. Returns true when the
   *  file is anchored (safe to create the zone); false, with a toast, when it
   *  can't be, so we never create a zone that could never refresh. */
  private async ensureDocxSourceAnchor(
    headingPos: number,
    headingId: string,
    expectedText: string,
    attrs: TransclusionAttrs,
    roots: string[],
    docPath: string | null,
    fileName: string,
  ): Promise<boolean> {
    const electron = getElectronHost();
    if (!electron || !docPath) {
      showToast('Live zones from Word files need the desktop app.');
      return false;
    }
    const sourceAbs = attrs.source_abs ?? '';
    const file = await electron.readCmirFile(
      docPath,
      attrs.source_ref,
      attrs.source_ref_base,
      roots,
      sourceAbs,
    );
    if (!file) {
      showToast('Couldn’t read the source file to prepare it for live updates.');
      return false;
    }
    // Re-parse WITH provenance and find the picked heading at the same position
    // (structure is identical across parses); look up its source-paragraph index.
    const prov = new Map<string, number>();
    let freshDoc: PMNode;
    try {
      freshDoc = await fromDocx(file.bytes, prov);
    } catch {
      showToast('Couldn’t read the Word source file.');
      return false;
    }
    // Same wrapper-vs-heading trap as the caller: for a card-by-tag or
    // analytic source, `headingPos` is the WRAPPER's position, whose node
    // carries no id — resolveHeadingIdAt digs out the heading child's.
    // (The naive nodeAt().attrs.id here is what made "transclude a card
    // by its tag" fail for .docx sources while working from .cmir.)
    const freshId = resolveHeadingIdAt(freshDoc, headingPos);
    const srcPara = freshId ? prov.get(freshId) : undefined;
    if (srcPara == null) {
      showToast('This Word heading can’t be tracked for live updates — save the source as .cmir.');
      return false;
    }
    const anchor = await ensureHeadingAnchor(file.bytes, srcPara, headingId, expectedText);
    if (!anchor.ok) {
      showToast('This Word file can’t be prepared as a live source — save it as .cmir.');
      return false;
    }
    if (!anchor.added) return true; // already anchored — nothing to write.
    // A new bookmark must be written back — get explicit consent first, since
    // this modifies a file the user may share.
    const consented = await showConfirm({
      title: `Add a live-update anchor to “${fileName}”?`,
      message:
        'This writes a small bookmark to the Word file so this section can be ' +
        'refreshed later. Nothing else in the file changes.',
      confirmLabel: 'Add anchor',
      cancelLabel: 'Cancel',
    });
    if (!consented) {
      showToast('Live zone not created — the Word file was left unchanged.');
      return false;
    }
    // The user explicitly asked for this live zone — a vanishing toast
    // can't carry a retry decision (audit §3C). The usual cause is the
    // file being open in Word, so offer close-it-and-retry.
    for (;;) {
      const written = await electron.writeSourceAnchor(
        docPath,
        attrs.source_ref,
        attrs.source_ref_base,
        roots,
        sourceAbs,
        anchor.bytes,
      );
      if (written.ok) return true;
      const retry = await confirmDialog(
        'Couldn’t write to the Word file — it may be read-only or open in Word. ' +
          'Close it there and retry?',
        { okLabel: 'Retry', cancelLabel: 'Cancel' },
      );
      if (!retry) return false;
    }
  }

  // ── Inline tag filter (Tab) ───────────────────────────────────────

  private openTagFilter(): void {
    renderTagPicker(
      this.tagFilterEl,
      () => this.runSearch(),
      () => {
        this.tagFilterEl.hidden = true;
        this.input.focus();
      },
    );
    this.tagFilterEl.hidden = false;
    this.tagFilterEl.querySelector<HTMLInputElement>('.pmd-qctags-filter')?.focus();
  }
}

export const quickCardSearchUI = new QuickCardSearchUI();

/** Palette-opened hook (the UI tour's interactive step advances on
 *  it). Returns an unsubscribe. */
const openListeners = new Set<() => void>();
export function onQuickCardSearchOpen(cb: () => void): () => void {
  openListeners.add(cb);
  return () => openListeners.delete(cb);
}

// ── Shared tag-picker (inline + ribbon dropdown) ─────────────────────

/** Render a keyboard-navigable, type-to-filter tag list into `host`,
 *  editing the global `quickCardActiveTags`. Auto-selects the best
 *  (top) match; ↑/↓ move, Enter toggles, Esc calls `onDismiss` (Tab
 *  is swallowed, not a dismiss). `onChange` fires after any toggle. */
function renderTagPicker(host: HTMLElement, onChange: () => void, onDismiss: () => void): void {
  host.innerHTML = '';
  const all = distinctTags(quickCardsStore.list());
  let shown: string[] = all;
  let selected = 0;

  const filter = document.createElement('input');
  filter.type = 'text';
  filter.className = 'pmd-qctags-filter';
  filter.placeholder = 'Filter tags…';
  filter.spellcheck = false;
  filter.autocomplete = 'off';
  host.appendChild(filter);

  const list = document.createElement('div');
  list.className = 'pmd-qctags-list';
  host.appendChild(list);

  const computeShown = (): void => {
    const q = normalizeTag(filter.value);
    shown = all
      .filter((t) => (q ? normalizeTag(t).includes(q) : true))
      .sort((a, b) => {
        if (!q) return 0;
        const d = normalizeTag(a).indexOf(q) - normalizeTag(b).indexOf(q);
        return d !== 0 ? d : a.toLowerCase().localeCompare(b.toLowerCase());
      });
    selected = 0;
  };

  const rowEls: HTMLElement[] = [];
  const renderList = (): void => {
    const active = activeTagSet();
    list.innerHTML = '';
    rowEls.length = 0;
    if (all.length === 0) {
      const none = document.createElement('div');
      none.className = 'pmd-qctags-empty';
      none.textContent = 'No tags yet.';
      list.appendChild(none);
      return;
    }
    shown.forEach((tag, i) => {
      const row = document.createElement('label');
      row.className = 'pmd-qctags-row';
      if (i === selected) row.classList.add('pmd-qctags-row-active');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.tabIndex = -1;
      cb.checked = active.has(normalizeTag(tag));
      cb.addEventListener('change', () => toggle(tag));
      const span = document.createElement('span');
      span.textContent = tag;
      row.append(cb, span);
      row.addEventListener('mousemove', () => {
        if (selected !== i) setSelected(i);
      });
      list.appendChild(row);
      rowEls.push(row);
    });
    list.querySelector('.pmd-qctags-row-active')?.scrollIntoView({ block: 'nearest' });
  };

  // In-place active-row swap for selection moves (hover / arrows) —
  // full renderList rebuilds are reserved for content changes
  // (filter text, checkbox toggles).
  const setSelected = (i: number): void => {
    rowEls[selected]?.classList.remove('pmd-qctags-row-active');
    selected = i;
    const next = rowEls[i];
    if (next) {
      next.classList.add('pmd-qctags-row-active');
      next.scrollIntoView({ block: 'nearest' });
    }
  };

  const toggle = (tag: string): void => {
    const next = new Set(settings.get('quickCardActiveTags').map(normalizeTag));
    const n = normalizeTag(tag);
    if (next.has(n)) next.delete(n);
    else next.add(n);
    settings.set('quickCardActiveTags', [...next]);
    onChange();
    renderList();
  };

  filter.addEventListener('input', () => {
    computeShown();
    renderList();
  });
  filter.addEventListener('keydown', (e) => {
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        onDismiss();
        break;
      case 'Tab':
        // Only Escape dismisses ("Tab in, Esc out", consistent with file
        // search); preventDefault so focus can't escape the picker.
        e.preventDefault();
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (shown.length) setSelected((selected + 1) % shown.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (shown.length) setSelected((selected - 1 + shown.length) % shown.length);
        break;
      case 'Enter':
        e.preventDefault();
        if (shown[selected]) toggle(shown[selected]!);
        break;
    }
  });

  const footer = document.createElement('div');
  footer.className = 'pmd-qctags-footer';
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'pmd-qctags-clear';
  clear.textContent = 'Clear filter';
  clear.addEventListener('click', () => {
    settings.set('quickCardActiveTags', []);
    onChange();
    renderList();
  });
  footer.appendChild(clear);
  host.appendChild(footer);

  computeShown();
  renderList();
}

/** Ribbon Tag Picker dropdown — a standalone popover anchored under
 *  the 🏷️ button, editing the same global active-tags filter. */
export function openQuickCardTagPicker(anchorEl: HTMLElement): void {
  const existing = document.querySelector('.pmd-qctags-popover');
  if (existing) {
    existing.remove();
    return;
  }
  const pop = document.createElement('div');
  pop.className = 'pmd-qctags-popover';
  document.body.appendChild(pop);
  const rect = anchorEl.getBoundingClientRect();
  pop.style.left = `${Math.round(rect.left)}px`;
  pop.style.top = `${Math.round(rect.bottom + 4)}px`;

  const close = (): void => {
    pop.remove();
    document.removeEventListener('pointerdown', onDown, true);
  };
  const onDown = (e: PointerEvent): void => {
    if (!pop.contains(e.target as Node) && e.target !== anchorEl) close();
  };
  document.addEventListener('pointerdown', onDown, true);
  renderTagPicker(pop, () => {}, close);
  pop.querySelector<HTMLInputElement>('.pmd-qctags-filter')?.focus();
}
