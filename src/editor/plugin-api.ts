/**
 * Public plugin API surface — the types a plugin author codes against,
 * plus `createPluginApi`, the renderer-side implementation. Narrow by
 * design: only what flowing commands need (see the v1 spec).
 */
import type { EditorView } from 'prosemirror-view';
import { postNotice } from './status-notices.js';
import { getElectronHost } from './host/index.js';
import { showToast } from './toast.js';
import { extractSelection } from './plugin-extract.js';
import { jumpToTokenInView } from './plugin-jump.js';
import { getPluginSettingValue, subscribePluginSettings } from './plugin-settings.js';
import { parseSourceToken } from './plugin-source-token.js';

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
  /** Whether the app answered a liveness ping just now. Closed apps are
   *  LISTED (their identity registration persists) — selection never
   *  requires the app to be running; sends to a closed app fail at
   *  runtime with `app-not-running`. Keep in sync with the main-process
   *  declaration in apps/desktop/src/bridge-handshake.ts. */
  running: boolean;
}

export type FlowPostResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; error: 'no-such-app' | 'app-not-running' | 'timeout' | 'bad-response' | 'unsupported' };

export interface PluginStorage {
  get(key: string): unknown;
  /** `__settings` is reserved — it holds the values of the settings the
   *  plugin declared at registration (rendered by the host's settings
   *  modal). Writing it directly only corrupts your own settings; reads
   *  through `api.settings.get` fall back to declared defaults. */
  set(key: string, value: unknown): void;
}

export interface PluginSettingsApi {
  /** Current value of a setting DECLARED in the plugin definition's
   *  `settings` array (the declared default when the user hasn't set
   *  it); undefined for undeclared keys. */
  get(key: string): boolean | string | number | undefined;
  /** Fires when the user changes one of this plugin's settings in the
   *  settings modal. Returns an unsubscribe function. Most plugins
   *  don't need this — reading lazily via `get` when a command runs
   *  always sees the current value. */
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

export interface PluginApiDeps {
  appVersion: string;
  getView(): EditorView | null;
  /** Live view of any pane in this window holding `docId` (focused or
   *  not), or null. Lets a jump land locally without the IPC hop even
   *  when the target doc is in an unfocused pane. `raise` surfaces a
   *  background pane, which a jump wants and the silent bridge routes
   *  (`/replace`, `/insert-after`) must never ask for. */
  findViewForDocId(docId: string, opts?: { raise?: boolean }): EditorView | null;
  /** Identity of the focused doc; docId null until minted. */
  getDocIdentity(): { docId: string | null; docTitle: string } | null;
  /** Mint + stamp a docId for the focused doc; null when no doc. */
  ensureDocId(): string | null;
}

export function createPluginApi(pluginId: string, deps: PluginApiDeps): CardMirrorPluginApi {
  const storageKey = `plugin:${pluginId}`;
  const readBag = (): Record<string, unknown> => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) || '{}') as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  return {
    appVersion: deps.appVersion,
    extractSelection() {
      const view = deps.getView();
      if (!view) return { ok: false, error: 'no-active-doc' };
      const ident = deps.getDocIdentity();
      if (!ident) return { ok: false, error: 'no-active-doc' };
      // Extract against the doc's current identity FIRST, so a failed
      // extraction never mints/stamps a docId onto a pristine file.
      const res = extractSelection(view, { docId: ident.docId ?? '', docTitle: ident.docTitle });
      if (!res.ok) return res;
      if (ident.docId) return res;
      // First-ever successful extraction on an unstamped doc: mint + stamp,
      // then re-walk so the emitted tokens carry the real docId. The
      // double walk happens exactly once per document LIFETIME (the stamp
      // persists), so caching the first walk's items isn't worth the
      // staleness risk.
      const docId = deps.ensureDocId();
      if (!docId) return { ok: false, error: 'no-active-doc' };
      return extractSelection(view, { docId, docTitle: ident.docTitle });
    },
    async jumpToSource(token) {
      const payload = parseSourceToken(token);
      if (!payload) return { ok: false, error: 'bad-request' };
      const view = deps.findViewForDocId(payload.docId, { raise: true });
      // A matched view always carries payload.docId, so the local jump is
      // authoritative — jumpToTokenInView can't answer 'not-mine' here.
      if (view) {
        const local = jumpToTokenInView(view, payload.docId, token);
        if (local !== 'not-mine') return local;
      }
      const host = getElectronHost();
      if (host?.pluginJump) return (await host.pluginJump(token)) as JumpResult;
      return { ok: false, error: 'doc-not-open', docTitle: payload.docTitle };
    },
    async flowApps() {
      const host = getElectronHost();
      if (!host?.flowApps) return [];
      return (await host.flowApps()) as FlowAppInfo[];
    },
    async flowPost(appId, route, body) {
      const host = getElectronHost();
      if (!host?.flowPost) return { ok: false, error: 'unsupported' };
      return (await host.flowPost(appId, route, body)) as FlowPostResult;
    },
    docInfo() {
      const i = deps.getDocIdentity();
      return i && i.docId ? { docId: i.docId, docTitle: i.docTitle } : null;
    },
    showToast(message) {
      // Third-party text: attribute it to the plugin (so it can't
      // impersonate a CardMirror system message) and cap the toast;
      // anything longer lands as a durable chip notice instead of a
      // wall-of-text tooltip.
      const text = String(message);
      const attributed = `[${pluginId}] ${text}`;
      if (text.length > 300) {
        postNotice({ severity: 'info', title: `Plugin: ${pluginId}`, body: attributed });
      } else {
        showToast(attributed);
      }
    },
    storage: {
      get(key) {
        return readBag()[key];
      },
      set(key, value) {
        const bag = readBag();
        bag[key] = value;
        try {
          localStorage.setItem(storageKey, JSON.stringify(bag));
        } catch {
          /* quota — non-fatal */
        }
      },
    },
    settings: {
      get(key) {
        return getPluginSettingValue(pluginId, key);
      },
      onChanged(cb) {
        return subscribePluginSettings(pluginId, cb);
      },
    },
  };
}
