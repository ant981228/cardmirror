/**
 * Settings modal UI.
 *
 * Click the gear icon in the header → opens a modal listing every entry
 * in `SETTING_METADATA`. The modal renders the appropriate control
 * (toggle / number / etc.) for each setting and writes through to the
 * settings store immediately.
 */

import { confirmDialog, promptForRouteChoice } from './text-prompt.js';
import { isLiteBuild } from './lite.js';
import { entryConflictWarnings } from './custom-autocorrect-plugin.js';
import {
  CUSTOMIZABLE_COLOR_TOKENS,
  DISPLAY_COLOR_TOKEN_TO_KEY,
  DEFAULT_DISPLAY_COLORS,
  SETTING_METADATA,
  SETTINGS_DEFAULTS,
  settings,
  DISPLAY_SIZE_KEYS,
  DISPLAY_COLOR_KEYS,
  type SettingMeta,
  type SettingsCategory,
  type Settings,
  type SettingCondition,
  evalDependsOn,
  hiddenInLite,
  type ReaderConfig,
  type DisplaySizes,
  DEFAULT_DISPLAY_SIZES,
  DEFAULT_PARAGRAPH_SPACING,
  type ParagraphSpacingKey,
  type DisplayTypography,
  type DisplayColors,
  type FormattingPanelMode,
  type HeadingMode,
  type CondenseWarningDelimiter,
  type ShrinkProtection,
  type PairingPartner,
  type PairingGroup,
  type RibbonCustomButton,
  MAX_RIBBON_CUSTOM_BUTTONS,
  condenseWarningCloseFor,
  NUMBERING_SEPARATORS,
  type NumberingSeparator,
  ZOOM_MIN_PCT,
  ZOOM_MAX_PCT,
  type StyleAlignments,
  type StyleAlignment,
} from './settings.js';
import { CATEGORY_TABS, visibleCategoryTabs, type SettingsTarget } from './settings-categories.js';
import { generateGroupId, normalizePairingCode } from './pairing/pairing-ids.js';
import { inboxStore, recentSenders } from './pairing/inbox-store.js';
import { regenerateOwnCode } from './pairing/pairing-wiring.js';
import { isFontAvailable } from './font-detect.js';
import { repointFolderRoot } from './folder-list-repoint.js';
import {
  WORD_HIGHLIGHT_COLORS,
  WORD_SHADING_COLORS,
  highlightColorLabel,
  shadingColorLabel,
} from './color-palette.js';
import { buildKeybindingsEditor } from './keybindings-editor.js';
import { TRANSLATION_LANGUAGES } from './translate.js';
import { getHost, getElectronHost, isWindowsHost } from './host/index.js';
import { pushOverlay, popOverlay } from './overlay-stack.js';
import {
  installModalKeys,
  armDialogFocus,
  captureFocusForDialog,
  promptForText,
} from './text-prompt.js';
import { getInstallInfo } from './install-info.js';
import { launchBenchmarkOverlay } from './benchmark-ui.js';
import { resetTimer } from './timer-state.js';
import { applyTimerProfile } from './timer-profile.js';
import { showToast } from './toast.js';
import { setIcon, CUSTOM_BUTTON_ICONS, type IconName } from './icons';
import { availableRibbonCommandIds } from './ribbon-availability.js';
import { commandLabelFor, RIBBON_COMMAND_LABELS, type RibbonCommandId } from './ribbon-commands.js';
import { settingCommandOptions } from './setting-commands.js';
import {
  FILE_OBJECT_KINDS,
  FILE_OBJECT_KIND_LABELS,
  type FileObjectKind,
} from './file-search.js';
import {
  DEFAULT_SPEECH_FILENAME_TEMPLATE,
  renderSpeechFilename,
} from './speech-filename.js';

interface SeatCandidateUi {
  routingCode: string;
  boundAt: string;
  lastSeenAt?: string;
  label?: string;
}

/** Seat-limit prompt. With a candidate list (relay ≥ 2026-09-02) the
 *  user picks WHICH machine to unlink — route-style buttons with 1/2/3
 *  keys, one per seat, labelled with the machine name that build
 *  reported plus its link and last-active dates. Without one (older
 *  relay) it is the legacy "unlink the oldest?" confirm. Resolves to the
 *  routing code to evict, `undefined` for the legacy confirm, or
 *  'cancel'. The relay used to evict the OLDEST link unconditionally,
 *  which was a member's long-used primary machine whenever a stale
 *  seat (a wiped laptop, a VM) had been linked later (identity audit
 *  2026-09-02). */
async function pickSeatToUnlink(
  candidates: SeatCandidateUi[],
  limit: number,
  legacyBoundAt: string | undefined,
  thisKind: 'machine' | 'browser',
): Promise<string | undefined | 'cancel'> {
  const fmt = (iso?: string): string => {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
  };
  if (candidates.length > 0) {
    const choices = candidates.map((c) => {
      const linked = fmt(c.boundAt);
      const seen = fmt(c.lastSeenAt);
      return {
        value: c.routingCode,
        label: `Unlink ${c.label?.trim() || `the machine linked ${linked || 'earlier'}`}`,
        description: [linked ? `Linked ${linked}` : '', seen ? `last active ${seen}` : '']
          .filter(Boolean)
          .join(' · '),
      };
    });
    const picked = await promptForRouteChoice({
      message:
        `Your membership covers ${limit} machines and every seat is taken. ` +
        `Choose a machine to unlink so this ${thisKind} can be linked:`,
      choices,
      cancelLabel: 'Keep my current machines',
    });
    return picked ?? 'cancel';
  }
  const go = await confirmDialog(
    `Your membership covers ${limit} machines and both seats are taken. ` +
      `Link this ${thisKind} anyway and unlink the machine added ${fmt(legacyBoundAt) || 'earlier'}?`,
    { okLabel: thisKind === 'browser' ? 'Link This Browser' : 'Link This Machine' },
  );
  return go ? undefined : 'cancel';
}

/**
 * Body fonts for the font dropdowns, grouped into `<optgroup>`s.
 * Fonts not installed on the system are filtered out per-group via
 * `isFontAvailable`; a group with no available fonts is suppressed.
 *
 * In "Recommended for readability": Atkinson Hyperlegible, Lexend,
 * and OpenDyslexic are SIL OFL fonts bundled with the app (see
 * `style.css`'s @font-face block and `src/editor/fonts/`), so every
 * install has a readability-tuned option regardless of the host OS.
 * Verdana, Tahoma, and Comic Sans MS are the British Dyslexia
 * Association's 2023 endorsed system sans-serifs for body text aimed
 * at dyslexic readers; they show only when installed.
 */
interface FontGroup {
  label: string;
  fonts: string[];
}

const FONT_GROUPS: FontGroup[] = [
  {
    label: 'Recommended for readability',
    fonts: [
      // Bundled (SIL OFL). Always available.
      'Atkinson Hyperlegible',
      'Lexend',
      'OpenDyslexic',
      // System fonts — BDA-recommended; shown only if installed.
      'Verdana',
      'Tahoma',
      'Comic Sans MS',
    ],
  },
  {
    label: 'Microsoft Office defaults',
    fonts: ['Calibri', 'Cambria', 'Times New Roman', 'Arial', 'Arial Narrow', 'Georgia'],
  },
  {
    label: 'Apple defaults',
    fonts: ['Helvetica'],
  },
  {
    label: 'Open-source / cross-platform',
    fonts: [
      'Liberation Serif',
      'Liberation Sans',
      'DejaVu Serif',
      'DejaVu Sans',
      'Noto Serif',
      'Noto Sans',
    ],
  },
  {
    label: 'Generic',
    fonts: ['serif', 'sans-serif', 'monospace'],
  },
];

/** Human-readable label for each display-size key. */
const DISPLAY_SIZE_LABELS: Record<keyof DisplaySizes, string> = {
  normal: 'Normal (body)',
  pocket: 'Pocket',
  hat: 'Hat',
  block: 'Block',
  tag: 'Tag',
  analytic: 'Analytic',
  cite: 'Cite',
  underline: 'Underline',
  emphasis: 'Emphasis',
  undertag: 'Undertag',
};

/** Cleanup callbacks for the settings modal's CURRENT DOM generation
 *  (one per row/widget with a live settings subscription). Flushed by
 *  `SettingsModal.close()` and at the top of every `render()`. */
let rowCleanups: Array<() => void> = [];

function flushRowCleanups(): void {
  const list = rowCleanups;
  rowCleanups = [];
  for (const cb of list) {
    try {
      cb();
    } catch {
      // One row's cleanup must not block the rest.
    }
  }
}

/** Register `callback` to run when the settings modal tears down its
 *  current DOM generation (close, or the rebuild at the top of the
 *  next render). This is the release point for the settings
 *  subscription each row/widget creates. Cleanup is tied to the MODAL
 *  lifecycle rather than to `el` detaching: the dialog DOM stays
 *  connected (merely hidden) after close, so detach-based cleanup
 *  would never fire and every open would leak ~60 subscriptions.
 *  An element removed mid-session (nothing does this today) keeps its
 *  subscription until close; release it manually via the returned
 *  cancel if that ever matters. `el` is accepted only to document
 *  ownership at the call site. */
function registerRowCleanup(_el: Element, callback: () => void): () => void {
  rowCleanups.push(callback);
  return () => {
    const i = rowCleanups.indexOf(callback);
    if (i >= 0) rowCleanups.splice(i, 1);
  };
}

/** Nudge a tab into the visible band of its scrolling container.
 *  If the tab's bounding rect is fully inside the container's
 *  rect, no-op. Otherwise scroll just enough to reveal it on the
 *  nearer side. Avoids `el.scrollIntoView` because that scrolls
 *  the WHOLE page (including the editor surface behind the modal)
 *  when the container itself is fully on-screen. */
/** Fill a `.pmd-settings-folder-path` cell. The cell truncates on the
 *  LEFT (CSS `direction: rtl`) so the informative tail of a long path —
 *  the file/folder name — stays visible; the LRM guards pin the string's
 *  leading separator in place, which bidi would otherwise float to the
 *  visual right end. Full text goes in the tooltip. */
function setPathCell(el: HTMLElement, text: string): void {
  el.textContent = `\u{200e}${text}\u{200e}`;
  el.title = text;
}

function scrollTabIntoView(tab: HTMLElement, container: HTMLElement): void {
  const tr = tab.getBoundingClientRect();
  const cr = container.getBoundingClientRect();
  if (tr.left < cr.left) {
    container.scrollBy({ left: tr.left - cr.left, behavior: 'smooth' });
  } else if (tr.right > cr.right) {
    container.scrollBy({ left: tr.right - cr.right, behavior: 'smooth' });
  }
}

// CATEGORY_TABS / visibleCategoryTabs / SettingsTarget live in
// settings-categories.ts so the command palette (main chunk) can use
// them without pulling this lazily-loaded module in with them.

/** The settings dialog. `open()` takes a deep-link target: a tab to
 *  activate and optionally a setting row — or a named non-setting
 *  section (e.g. "About this install") via its `data-anchor` — to
 *  scroll to and flash. */
class SettingsModal {
  private overlay: HTMLDivElement;
  private dialog: HTMLDivElement;
  /** Overlay-stack token while open, so Escape only closes this modal
   *  when it's the topmost (a dialog opened from here — e.g. the AI
   *  cite-prompt editor — handles its own Escape first). */
  private overlayToken: symbol | null = null;
  /** Modal-key uninstaller while open; null when closed. */
  private removeModalKeys: (() => void) | null = null;
  /** Returns focus to wherever it was before open(); null when closed. */
  private restoreFocus: (() => void) | null = null;
  /** Rows whose enabled state is gated on a `dependsOn` condition.
   *  Refilled each open() via renderEntry bookkeeping; consumed by
   *  `refreshDependents`. */
  private dependentRows: Array<{
    row: HTMLElement;
    dependsOn: SettingCondition | readonly SettingCondition[];
  }> = [];
  /** Unsubscribe handle returned by `settings.subscribe` while the
   *  dialog is open. Cleared on close. */
  private settingsUnsubscribe: (() => void) | null = null;
  /** Currently-selected tab. Persists for the lifetime of the modal
   *  instance (across opens) so reopening lands you back where you
   *  were, but resets if the page reloads. */
  private activeCategory: SettingsCategory = 'general';
  /** ResizeObserver for the tab strip, used to show / hide the
   *  scroll-arrow buttons when the tabs overflow horizontally.
   *  Disconnected on close() and on each new render(). */
  private tabsResizeObserver: ResizeObserver | null = null;

  constructor() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'pmd-settings-overlay';
    this.overlay.style.display = 'none';

    this.dialog = document.createElement('div');
    this.dialog.className = 'pmd-settings-dialog';
    this.overlay.appendChild(this.dialog);

    // Click outside the dialog → close.
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });

    document.body.appendChild(this.overlay);
  }

  open(target?: SettingsTarget): void {
    this.render();
    this.overlay.style.display = '';
    if (this.overlayToken === null) {
      const token = pushOverlay();
      this.overlayToken = token;
      this.restoreFocus = captureFocusForDialog();
      // Own the keyboard while open (Escape closes; anything not aimed
      // at the dialog's own controls is swallowed) — installModalKeys
      // stands down by itself when a dialog opened from here (e.g. the
      // AI cite-prompt editor) is stacked on top.
      this.removeModalKeys = installModalKeys(this.dialog, token, (e) => {
        if (e.key === 'Escape') {
          this.close();
          return true;
        }
        return false;
      });
    }
    armDialogFocus(this.dialog, 'dialog', 'Settings');
    // Subscribe so toggling any "parent" setting (AI master switch,
    // multi-doc, etc.) greys / un-greys the dependent rows live
    // without needing a re-open.
    this.settingsUnsubscribe = settings.subscribe(() => this.refreshDependents());
    this.refreshDependents();
    // Deep-link: jump to a tab and (optionally) scroll to one setting,
    // e.g. when reached from the search palette's `s` shortcuts. Ignore a
    // category that isn't visible on this host (e.g. a stale link to the
    // desktop-only Collaboration tab on web) so we don't strand a blank panel.
    if (
      target?.category &&
      visibleCategoryTabs().some((t) => t.id === target.category)
    ) {
      this.setActiveCategory(target.category);
    }
    if (target?.settingKey) this.revealSetting(target.settingKey);
    if (target?.anchor) this.revealAnchor(target.anchor);
  }

  /** Scroll a named non-setting section (by `data-anchor`) into view and
   *  flash it — the deep-link target for things like "About this install"
   *  that aren't editable settings rows. */
  private revealAnchor(anchor: string): void {
    const el = this.dialog.querySelector<HTMLElement>(
      `[data-anchor="${CSS.escape(anchor)}"]`,
    );
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.remove('pmd-settings-row-flash');
      void el.offsetWidth; // restart the animation if already applied
      el.classList.add('pmd-settings-row-flash');
      el.addEventListener(
        'animationend',
        () => el.classList.remove('pmd-settings-row-flash'),
        { once: true },
      );
    });
  }

  /** Scroll a specific setting row into view and flash it. Runs on the
   *  next frame so the just-activated panel has laid out. */
  private revealSetting(key: keyof Settings): void {
    const row = this.dialog.querySelector<HTMLElement>(
      `.pmd-settings-row[data-setting-key="${CSS.escape(key)}"]`,
    );
    if (!row) return;
    requestAnimationFrame(() => {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.classList.remove('pmd-settings-row-flash');
      void row.offsetWidth; // restart the animation if already applied
      row.classList.add('pmd-settings-row-flash');
      row.addEventListener(
        'animationend',
        () => row.classList.remove('pmd-settings-row-flash'),
        { once: true },
      );
    });
  }

  close(): void {
    if (this.settingsUnsubscribe) {
      this.settingsUnsubscribe();
      this.settingsUnsubscribe = null;
    }
    if (this.tabsResizeObserver) {
      this.tabsResizeObserver.disconnect();
      this.tabsResizeObserver = null;
    }
    // Release every row/widget settings subscription registered during
    // render() — the dialog DOM stays connected (just hidden), so
    // nothing else would ever release them.
    flushRowCleanups();
    this.overlay.style.display = 'none';
    if (this.overlayToken !== null) {
      popOverlay(this.overlayToken);
      this.overlayToken = null;
    }
    this.removeModalKeys?.();
    this.removeModalKeys = null;
    this.restoreFocus?.();
    this.restoreFocus = null;
  }

  private render(): void {
    // Tear down the outgoing generation's subscriptions before its DOM
    // is replaced.
    flushRowCleanups();
    this.dialog.innerHTML = '';

    const header = document.createElement('header');
    header.className = 'pmd-settings-header';
    const title = document.createElement('h2');
    title.textContent = 'Settings';
    header.appendChild(title);
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'pmd-settings-close';
    setIcon(closeBtn, 'close');
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', () => this.close());
    header.appendChild(closeBtn);
    this.dialog.appendChild(header);

    // Tab strip + arrow scrollers. The bar wraps the nav so the
    // arrows sit flush against the divider line (it lives on the
    // bar, not the nav). The arrows are hidden when the strip
    // fits its container and revealed via ResizeObserver when it
    // overflows; each arrow disables at the end of its scroll
    // range. No native scrollbar — overflow-x: hidden on the nav.
    const tabsBar = document.createElement('div');
    tabsBar.className = 'pmd-settings-tabs-bar';

    const scrollLeftBtn = document.createElement('button');
    scrollLeftBtn.type = 'button';
    scrollLeftBtn.className = 'pmd-settings-tabs-scroll pmd-settings-tabs-scroll-left';
    scrollLeftBtn.setAttribute('aria-label', 'Scroll settings tabs left');
    setIcon(scrollLeftBtn, 'chevron-left');
    scrollLeftBtn.hidden = true;
    tabsBar.appendChild(scrollLeftBtn);

    const tabStrip = document.createElement('nav');
    tabStrip.className = 'pmd-settings-tabs';
    tabStrip.setAttribute('role', 'tablist');
    const tabButtons: Partial<Record<SettingsCategory, HTMLButtonElement>> = {};
    for (const { id, label } of visibleCategoryTabs()) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pmd-settings-tab';
      btn.setAttribute('role', 'tab');
      btn.textContent = label;
      btn.addEventListener('click', () => this.setActiveCategory(id));
      tabStrip.appendChild(btn);
      tabButtons[id] = btn;
    }
    tabsBar.appendChild(tabStrip);

    const scrollRightBtn = document.createElement('button');
    scrollRightBtn.type = 'button';
    scrollRightBtn.className = 'pmd-settings-tabs-scroll pmd-settings-tabs-scroll-right';
    scrollRightBtn.setAttribute('aria-label', 'Scroll settings tabs right');
    setIcon(scrollRightBtn, 'chevron-right');
    scrollRightBtn.hidden = true;
    tabsBar.appendChild(scrollRightBtn);

    this.dialog.appendChild(tabsBar);

    const scrollTabsBy = (dir: -1 | 1): void => {
      const step = Math.max(60, tabStrip.clientWidth * 0.6);
      tabStrip.scrollBy({ left: dir * step, behavior: 'smooth' });
    };
    scrollLeftBtn.addEventListener('click', () => scrollTabsBy(-1));
    scrollRightBtn.addEventListener('click', () => scrollTabsBy(1));

    const updateArrows = (): void => {
      const overflowing = tabStrip.scrollWidth > tabStrip.clientWidth + 1;
      if (!overflowing) {
        scrollLeftBtn.hidden = true;
        scrollRightBtn.hidden = true;
        return;
      }
      scrollLeftBtn.hidden = false;
      scrollRightBtn.hidden = false;
      scrollLeftBtn.disabled = tabStrip.scrollLeft <= 0;
      scrollRightBtn.disabled =
        tabStrip.scrollLeft + tabStrip.clientWidth >= tabStrip.scrollWidth - 1;
    };
    tabStrip.addEventListener('scroll', updateArrows);
    if (this.tabsResizeObserver) this.tabsResizeObserver.disconnect();
    this.tabsResizeObserver = new ResizeObserver(updateArrows);
    this.tabsResizeObserver.observe(tabStrip);
    // Initial pass — sizes are available immediately because the
    // dialog is already in the DOM (constructor appended overlay).
    updateArrows();

    // Panels — one per category. Only the active panel is visible
    // (set via `hidden`); we build all of them up-front so the
    // refreshDependents pass can find rows under inactive tabs too.
    this.dependentRows = [];
    const panels: Partial<Record<SettingsCategory, HTMLDivElement>> = {};
    for (const { id } of visibleCategoryTabs()) {
      const panel = document.createElement('div');
      panel.className = 'pmd-settings-list pmd-settings-panel';
      panel.setAttribute('role', 'tabpanel');
      const hostKind = getHost().kind;
      const entries = SETTING_METADATA.filter(
        (m) =>
          m.category === id &&
          (!m.electronOnly || hostKind === 'electron') &&
          (!m.windowsOnly || isWindowsHost()) &&
          (!m.webOnly || hostKind === 'browser') &&
          !hiddenInLite(m) &&
          (!m.revealWhen || !!settings.get(m.revealWhen)),
      );
      let lastSection: string | undefined;
      for (const meta of entries) {
        // Section headers: emitted when consecutive entries' `section`
        // changes (entries sharing a section are contiguous in
        // SETTING_METADATA by convention — see SettingMeta.section).
        if (meta.section && meta.section !== lastSection) {
          const heading = document.createElement('h3');
          heading.className = 'pmd-settings-section-title';
          heading.textContent = meta.section;
          panel.appendChild(heading);
        }
        lastSection = meta.section;
        const row = this.renderEntry(meta);
        if (meta.dependsOn) {
          this.dependentRows.push({ row, dependsOn: meta.dependsOn });
        }
        panel.appendChild(row);
      }
      if (entries.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'pmd-settings-empty';
        empty.textContent = 'No settings in this section yet.';
        panel.appendChild(empty);
      }
      // "About this install" diagnostic block at the bottom of
      // General — read-only labels users can copy-paste into bug
      // reports. Lives here rather than in SETTING_METADATA
      // because it isn't a user-editable setting. The Benchmark
      // action (run the in-app perf suite) sits alongside it.
      if (id === 'general') {
        panel.appendChild(buildBenchmarkSection(() => this.close()));
        panel.appendChild(buildInstallInfoSection());
        const crashDumps = buildCrashDumpsSection();
        if (crashDumps) panel.appendChild(crashDumps);
        panel.appendChild(this.buildSettingsBackupSection());
        panel.appendChild(buildDocLinksSection());
      }
      // Installed-plugins manager under the Plugins tab — install field,
      // plugin rows, and the dev load-from-file row. Not settings rows, so
      // it lives outside SETTING_METADATA (like General's info sections
      // above), and loads lazily so the panel code stays off the settings
      // open path — same style as the other heavy, on-demand panels.
      if (id === 'plugins') {
        const section = document.createElement('section');
        section.className = 'pmd-plugins-panel';
        panel.appendChild(section);
        // Everything below the plugin manager is deliberately NOT behind
        // Enable plugins (the bridge / Flow COM are not the plugin
        // system), so these rows render even while the manager shows only
        // the gate placeholder. The generic loop above already built each
        // row (with its section heading right before it); re-appending
        // moves them to the end in order: External apps, then Verbatim
        // Flow last.
        const moveRowToEnd = (settingKey: string): void => {
          const row = panel.querySelector(`[data-setting-key="${settingKey}"]`);
          if (!row) return;
          const heading = row.previousElementSibling;
          if (heading?.classList.contains('pmd-settings-section-title')) {
            panel.appendChild(heading);
          }
          panel.appendChild(row);
        };
        moveRowToEnd('externalInsertPolicy');
        if (panel.querySelector('[data-setting-key="externalInsertPolicy"]')) {
          panel.appendChild(buildExternalAppsEditor());
        }
        moveRowToEnd('flowHostOnLaunch');
        void import('./plugins-settings-ui.js').then((m) => m.renderPluginsPanel(section));
      }
      this.dialog.appendChild(panel);
      panels[id] = panel;
    }

    // Wire tab selection logic.
    const applyActive = (): void => {
      for (const { id } of visibleCategoryTabs()) {
        const isActive = id === this.activeCategory;
        const btn = tabButtons[id];
        const panel = panels[id];
        if (btn) {
          btn.classList.toggle('pmd-settings-tab-active', isActive);
          btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
          btn.tabIndex = isActive ? 0 : -1;
        }
        if (panel) panel.hidden = !isActive;
      }
      // If the newly-active tab is clipped by the scroll viewport
      // (clicked at the edge of view, or activated programmatically
      // while not in view), nudge it into the visible band.
      const activeBtn = tabButtons[this.activeCategory];
      if (activeBtn) scrollTabIntoView(activeBtn, tabStrip);
    };
    this.setActiveCategory = (id: SettingsCategory) => {
      this.activeCategory = id;
      applyActive();
    };
    applyActive();
  }

  /** Export / Import settings — pinned at the bottom of General. */
  private buildSettingsBackupSection(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'pmd-settings-backup';

    const title = document.createElement('div');
    title.className = 'pmd-settings-row-title';
    title.textContent = 'Back up settings';
    section.appendChild(title);

    const desc = document.createElement('div');
    desc.className = 'pmd-settings-row-desc';
    desc.textContent =
      'Save all your settings — shortcuts, keyboard macros, appearance, and the rest — to a file, or import a file to replace them. Importing overwrites your current settings. Your API keys (Anthropic, OpenRouter, Google Translate) and MyMemory email are never included.';
    section.appendChild(desc);

    const actions = document.createElement('div');
    actions.className = 'pmd-settings-backup-actions';
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'pmd-settings-backup-btn';
    exportBtn.textContent = 'Export settings…';
    exportBtn.addEventListener('click', () => void this.doExportSettings());
    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.className = 'pmd-settings-backup-btn';
    importBtn.textContent = 'Import settings…';
    importBtn.addEventListener('click', () => void this.doImportSettings());
    actions.append(exportBtn, importBtn);
    section.appendChild(actions);

    return section;
  }

  private async doExportSettings(): Promise<void> {
    const payload = JSON.stringify(
      { version: 1, settings: settings.exportObject() },
      null,
      2,
    );
    const bytes = new TextEncoder().encode(payload);
    await getHost().saveAs('cardmirror-settings.json', bytes, {
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
  }

  private async doImportSettings(): Promise<void> {
    const opened = await getHost().openFile({
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!opened) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(opened.bytes));
    } catch {
      showToast(`Couldn't read “${opened.name}” as JSON.`);
      return;
    }
    // Accept the wrapped `{ version, settings }` shape or a bare object.
    const obj =
      parsed && typeof parsed === 'object'
        ? ((parsed as { settings?: unknown }).settings ?? parsed)
        : null;
    if (!obj || typeof obj !== 'object') {
      showToast(`“${opened.name}” doesn't look like a settings export.`);
      return;
    }
    if (
      !(await confirmDialog(
        'Import settings? This replaces all your current settings (your API key is kept).',
        { okLabel: 'Import' },
      ))
    ) {
      return;
    }
    settings.replaceAll(obj);
    this.render(); // rebuild the dialog so every control reflects the import
    showToast('Settings imported.');
  }

  /** Re-binding handle so tab buttons can change the active panel
   *  without re-rendering the whole dialog. Reassigned each
   *  `render()` to point at the just-built tabButtons / panels. */
  private setActiveCategory: (id: SettingsCategory) => void = () => {};

  /** Toggle the `pmd-settings-row-disabled` class on every row that
   *  has `dependsOn` set, whenever the parent setting changes. Also
   *  disables every input / button inside those rows so the controls
   *  don't fire events while the row reads as "off". */
  private refreshDependents(): void {
    // (A Phase-3 special case held 'pairingEnabled' true on browser
    // hosts while its toggle was desktop-only; Phase 4 surfaced the
    // toggle on web, so the dependency greys identically everywhere.)
    for (const { row, dependsOn } of this.dependentRows) {
      const enabled = evalDependsOn(dependsOn);
      row.classList.toggle('pmd-settings-row-disabled', !enabled);
      const controls = row.querySelectorAll<
        HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement | HTMLSelectElement
      >('input, button, textarea, select');
      for (const c of controls) c.disabled = !enabled;
    }
  }

  private renderEntry(meta: SettingMeta): HTMLElement {
    const row = document.createElement('div');
    row.className = 'pmd-settings-row';
    // Tag the row so the palette's settings shortcuts can scroll to it.
    row.dataset['settingKey'] = meta.key;

    const label = document.createElement('label');
    label.className = 'pmd-settings-row-label';

    const text = document.createElement('div');
    text.className = 'pmd-settings-row-text';
    const head = document.createElement('span');
    head.className = 'pmd-settings-row-title';
    head.textContent = meta.label;
    text.appendChild(head);
    const descText = meta.descriptionFn ? meta.descriptionFn() : meta.description;
    if (descText) {
      const desc = document.createElement('span');
      desc.className = 'pmd-settings-row-desc';
      desc.textContent = descText;
      text.appendChild(desc);
    }
    label.appendChild(text);

    if (meta.kind === 'toggle') {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'pmd-settings-toggle';
      checkbox.checked = !!settings.get(meta.key);
      checkbox.addEventListener('change', () => {
        settings.set(meta.key as 'showCitePreview', checkbox.checked as never);
      });
      // Sync the checkbox visual state back to the setting on
      // every settings change — covers the case where another
      // subscriber rejects the toggle (e.g., the multi-doc
      // workspace switch shows a confirm dialog and reverts when
      // the user cancels; without this listener, the checkbox
      // visually stays flipped even though the setting reverted).
      const unsub = settings.subscribe(() => {
        const cur = !!settings.get(meta.key);
        if (checkbox.checked !== cur) checkbox.checked = cur;
      });
      registerRowCleanup(checkbox, () => unsub());
      label.appendChild(checkbox);
    } else if (meta.kind === 'readers') {
      // Description above, list editor below — different shape from
      // the inline label+toggle layout.
      row.appendChild(text);
      row.appendChild(buildReadersEditor());
      return row;
    } else if (meta.kind === 'displaySizes') {
      row.appendChild(text);
      row.appendChild(buildDisplaySizesEditor());
      return row;
    } else if (meta.kind === 'displayTypography') {
      row.appendChild(text);
      row.appendChild(buildTypographyEditor());
      return row;
    } else if (meta.kind === 'displayColors') {
      row.appendChild(text);
      row.appendChild(buildColorsEditor());
      return row;
    } else if (meta.kind === 'bodyFont') {
      row.appendChild(text);
      row.appendChild(buildBodyFontEditor());
      return row;
    } else if (meta.kind === 'uiFont') {
      row.appendChild(text);
      row.appendChild(buildUiFontEditor());
      return row;
    } else if (meta.kind === 'lineHeights') {
      row.appendChild(text);
      row.appendChild(buildLineHeightsEditor());
      return row;
    } else if (meta.kind === 'paragraphSpacing') {
      row.appendChild(text);
      row.appendChild(buildParagraphSpacingEditor());
      return row;
    } else if (meta.kind === 'formattingPanelMode') {
      label.appendChild(buildFormattingPanelModeEditor());
    } else if (meta.kind === 'ribbonTooltipMode') {
      label.appendChild(buildRibbonTooltipModeEditor());
    } else if (meta.kind === 'externalInsertPolicy') {
      label.appendChild(buildExternalInsertPolicyEditor());
    } else if (meta.kind === 'cardNumberFormat') {
      label.appendChild(buildCardNumberFormatEditor());
    } else if (meta.kind === 'cardNumberSubFormat') {
      label.appendChild(buildCardNumberSubFormatEditor());
    } else if (meta.kind === 'cardNumberIndent') {
      label.appendChild(buildCardNumberIndentEditor());
    } else if (meta.kind === 'cardNumberSubIndent') {
      label.appendChild(buildCardNumberSubIndentEditor());
    } else if (meta.kind === 'cardNumberColor') {
      label.appendChild(buildCardNumberColorEditor());
    } else if (meta.kind === 'multiDocLayoutMode') {
      row.appendChild(text);
      row.appendChild(buildMultiDocLayoutModeEditor());
      return row;
    } else if (meta.kind === 'mobileLayout') {
      row.appendChild(text);
      row.appendChild(buildMobileLayoutEditor());
      return row;
    } else if (meta.kind === 'cardCutterReadTime') {
      row.appendChild(text);
      row.appendChild(buildCardCutterReadTimeRadio());
      return row;
    } else if (meta.kind === 'cardCutterDisable') {
      row.appendChild(text);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pmd-settings-btn';
      btn.textContent = 'Disable card cutter';
      btn.addEventListener('click', () => settings.set('cardCutterEnabled', false));
      row.appendChild(btn);
      return row;
    } else if (meta.kind === 'number') {
      // Inline: the numeric input sits on the right of the label, like
      // toggles / text inputs. Falls through to `row.appendChild(label)`
      // so the description stays width-limited inside the flex row.
      label.appendChild(buildNumberEditor(meta.key as keyof Settings, meta.min));
    } else if (meta.kind === 'defaultZoomPct') {
      row.appendChild(text);
      row.appendChild(buildDefaultZoomEditor());
      return row;
    } else if (meta.kind === 'customDash') {
      row.appendChild(text);
      row.appendChild(buildCustomDashEditor());
      return row;
    } else if (meta.kind === 'customAutocorrect') {
      row.appendChild(text);
      row.appendChild(buildCustomAutocorrectEditor());
      return row;
    } else if (meta.kind === 'voiceInputDevice') {
      row.appendChild(text);
      row.appendChild(buildVoiceInputDeviceEditor());
      return row;
    } else if (meta.kind === 'voiceDashStyle') {
      row.appendChild(text);
      row.appendChild(buildVoiceDashStyleEditor());
      return row;
    } else if (meta.kind === 'voiceDictationModel') {
      row.appendChild(text);
      row.appendChild(buildVoiceDictationModelEditor());
      return row;
    } else if (meta.kind === 'speechDocFormat') {
      row.appendChild(text);
      row.appendChild(buildSpeechDocFormatEditor());
      return row;
    } else if (meta.kind === 'speechFilenameTemplate') {
      row.appendChild(text);
      row.appendChild(buildSpeechFilenameTemplateEditor());
      return row;
    } else if (meta.kind === 'saveFormat') {
      row.appendChild(text);
      row.appendChild(buildSaveFormatEditor());
      return row;
    } else if (meta.kind === 'aiProvider') {
      row.appendChild(text);
      row.appendChild(buildAiProviderEditor());
      return row;
    } else if (meta.kind === 'formattingGapClass') {
      row.appendChild(text);
      row.appendChild(buildFormattingGapClassEditor());
      return row;
    } else if (meta.kind === 'translationConfig') {
      row.appendChild(text);
      row.appendChild(buildTranslationEditor());
      return row;
    } else if (meta.kind === 'sendDocDestination') {
      row.appendChild(text);
      row.appendChild(buildSendDocDestinationEditor());
      return row;
    } else if (meta.kind === 'markedCardsDestination') {
      row.appendChild(text);
      row.appendChild(buildMarkedCardsDestinationEditor());
      return row;
    } else if (meta.kind === 'findCategoryOrder') {
      row.appendChild(text);
      row.appendChild(buildFindCategoryOrderEditor());
      return row;
    } else if (meta.kind === 'color') {
      row.appendChild(text);
      row.appendChild(buildColorEditor(meta.key as keyof typeof SETTINGS_DEFAULTS));
      return row;
    } else if (meta.kind === 'acronymPatterns') {
      row.appendChild(text);
      row.appendChild(buildAcronymPatternsEditor());
      return row;
    } else if (meta.kind === 'createReferenceHighlightMode') {
      row.appendChild(text);
      row.appendChild(buildCreateReferenceHighlightModeEditor());
      return row;
    } else if (meta.kind === 'createReferenceDelimiter') {
      row.appendChild(text);
      row.appendChild(buildCreateReferenceDelimiterEditor());
      return row;
    } else if (meta.kind === 'standardizeHighlightException') {
      row.appendChild(text);
      row.appendChild(buildHighlightExceptionEditor());
      return row;
    } else if (meta.kind === 'standardizeShadingException') {
      row.appendChild(text);
      row.appendChild(buildShadingExceptionEditor());
      return row;
    } else if (meta.kind === 'colorSlots') {
      row.appendChild(text);
      row.appendChild(buildColorSlotsEditor(meta.key as keyof Settings));
      return row;
    } else if (meta.kind === 'theme') {
      row.appendChild(text);
      row.appendChild(buildThemeEditor());
      return row;
    } else if (meta.kind === 'iconSet') {
      row.appendChild(text);
      row.appendChild(buildIconSetEditor());
      return row;
    } else if (meta.kind === 'reduceMotion') {
      row.appendChild(text);
      row.appendChild(buildReduceMotionEditor());
      return row;
    } else if (meta.kind === 'accessibilityRenderer') {
      row.appendChild(text);
      row.appendChild(buildAccessibilityRendererEditor());
      return row;
    } else if (meta.kind === 'timerProfile') {
      row.appendChild(text);
      row.appendChild(buildTimerProfileEditor());
      return row;
    } else if (meta.kind === 'timerProfileDurations') {
      row.appendChild(text);
      row.appendChild(buildTimerProfileDurationsEditor());
      return row;
    } else if (meta.kind === 'timerPrepLabel') {
      row.appendChild(text);
      row.appendChild(buildTimerPrepLabelEditor());
      return row;
    } else if (meta.kind === 'timerFlashSeconds') {
      row.appendChild(text);
      row.appendChild(buildTimerFlashSecondsEditor());
      return row;
    } else if (meta.kind === 'timerPosition') {
      row.appendChild(text);
      row.appendChild(buildTimerPositionEditor());
      return row;
    } else if (meta.kind === 'enterAfterStyle') {
      row.appendChild(text);
      row.appendChild(buildEnterAfterStyleEditor());
      return row;
    } else if (meta.kind === 'colorOverrides') {
      row.appendChild(text);
      row.appendChild(buildColorOverridesEditor());
      return row;
    } else if (meta.kind === 'headingMode') {
      row.appendChild(text);
      row.appendChild(buildHeadingModeEditor());
      return row;
    } else if (meta.kind === 'pasteCursor') {
      row.appendChild(text);
      row.appendChild(buildPasteCursorEditor());
      return row;
    } else if (meta.kind === 'versionHistory') {
      row.appendChild(text);
      row.appendChild(buildVersionHistoryEditor());
      return row;
    } else if (meta.kind === 'condenseWarningDelimiter') {
      row.appendChild(text);
      row.appendChild(buildCondenseWarningDelimiterEditor());
      return row;
    } else if (meta.kind === 'shrinkCustomProtections') {
      row.appendChild(text);
      row.appendChild(buildShrinkProtectionsEditor());
      return row;
    } else if (meta.kind === 'fileSearchFormats') {
      row.appendChild(text);
      row.appendChild(buildFileSearchFormatsEditor());
      return row;
    } else if (meta.kind === 'fileSearchObjectTypes') {
      row.appendChild(text);
      row.appendChild(buildFileObjectTypesEditor());
      return row;
    } else if (meta.kind === 'fileSearchOutlineDepth') {
      row.appendChild(text);
      row.appendChild(buildOutlineDepthEditor('fileSearchOutlineDepth'));
      return row;
    } else if (meta.kind === 'navDefaultDepth') {
      row.appendChild(text);
      row.appendChild(buildOutlineDepthEditor('navMaxLevel'));
      return row;
    } else if (meta.kind === 'styleAlignments') {
      row.appendChild(text);
      row.appendChild(buildStyleAlignmentsEditor());
      return row;
    } else if (meta.kind === 'maxTextWidth') {
      row.appendChild(text);
      row.appendChild(buildMaxTextWidthEditor());
      return row;
    } else if (meta.kind === 'fileSearchTiebreak') {
      row.appendChild(text);
      row.appendChild(buildFileSearchTiebreakEditor());
      return row;
    } else if (meta.kind === 'keybindings') {
      row.appendChild(text);
      // The per-command keybindings list (~150 rows) is the single
      // heaviest part of opening Settings, and it lives under the
      // Keyboard tab — which isn't the default. Build it on the next
      // frame instead of blocking the open: the dialog appears instantly
      // and the list fills in invisibly (its panel starts hidden).
      const slot = document.createElement('div');
      row.appendChild(slot);
      requestAnimationFrame(() => slot.appendChild(buildKeybindingsEditor()));
      return row;
    } else if (meta.kind === 'ribbonCustomButtons') {
      row.appendChild(text);
      row.appendChild(buildRibbonCustomButtonsEditor());
      return row;
    } else if (meta.kind === 'folder') {
      // Path display + Browse… / Clear buttons, mounted UNDER the
      // explainer paragraph (same shape as readers / displaySizes /
      // etc). The inline-label layout would cram the path next to
      // the title and clip on anything longer than `~/foo`. Only
      // ever used for electronOnly settings, so the picker host is
      // always present at click time.
      const wrap = document.createElement('div');
      wrap.className = 'pmd-settings-folder';
      const pathEl = document.createElement('span');
      pathEl.className = 'pmd-settings-folder-path';
      const refreshPath = (): void => {
        const value = settings.get(meta.key) as string;
        setPathCell(pathEl, value || '(not set)');
        pathEl.classList.toggle('pmd-settings-folder-empty', !value);
      };
      refreshPath();
      const browseBtn = document.createElement('button');
      browseBtn.type = 'button';
      browseBtn.className = 'pmd-settings-btn';
      browseBtn.textContent = 'Browse…';
      browseBtn.addEventListener('click', () => {
        void (async (): Promise<void> => {
          // `folder` kind is gated by `electronOnly`, so the host
          // is always Electron here. If it's somehow not, no-op
          // safely rather than throw.
          const electron = getElectronHost();
          if (!electron) return;
          const current = settings.get(meta.key) as string;
          const picked = await electron.pickDirectory({
            defaultPath: current || undefined,
            title: meta.label,
          });
          if (picked == null) return;
          settings.set(meta.key, picked as never);
          refreshPath();
        })();
      });
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'pmd-settings-btn';
      clearBtn.textContent = 'Clear';
      clearBtn.addEventListener('click', () => {
        settings.set(meta.key, '' as never);
        refreshPath();
      });
      wrap.appendChild(pathEl);
      wrap.appendChild(browseBtn);
      wrap.appendChild(clearBtn);
      row.appendChild(text);
      row.appendChild(wrap);
      return row;
    } else if (meta.kind === 'folderList') {
      // A list of folders, each removable, plus "+ Add folder". Used for the
      // multi-folder file search. electronOnly, so the picker host is present.
      const wrap = document.createElement('div');
      wrap.className = 'pmd-settings-folderlist';
      const getRoots = (): string[] => (settings.get(meta.key) as string[]) ?? [];
      const render = (): void => {
        wrap.innerHTML = '';
        const roots = getRoots();
        if (roots.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'pmd-settings-folderlist-empty';
          empty.textContent = '(none — file search is off)';
          wrap.appendChild(empty);
        } else {
          roots.forEach((rootPath, i) => {
            const rowEl = document.createElement('div');
            rowEl.className = 'pmd-settings-folder';
            const pathEl = document.createElement('span');
            pathEl.className = 'pmd-settings-folder-path';
            setPathCell(pathEl, rootPath);
            // Same Browse… affordance as the single-folder settings, so a
            // folder that moved can be repointed instead of removed and
            // re-added. (The delete button says "Remove", not "Clear" —
            // on a list row it deletes the entry, it doesn't empty a value.)
            const browseBtn = document.createElement('button');
            browseBtn.type = 'button';
            browseBtn.className = 'pmd-settings-btn';
            browseBtn.textContent = 'Browse…';
            browseBtn.addEventListener('click', () => {
              void (async (): Promise<void> => {
                const electron = getElectronHost();
                if (!electron) return;
                const picked = await electron.pickDirectory({
                  defaultPath: rootPath,
                  title: meta.label,
                });
                if (picked == null) return;
                // Resolved by VALUE, not the render-time index — the list
                // can change under an open picker (see folder-list-repoint).
                const next = repointFolderRoot(getRoots(), rootPath, picked);
                if (next === null) return;
                settings.set(meta.key, next as never);
                render();
              })();
            });
            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'pmd-settings-btn';
            removeBtn.textContent = 'Remove';
            removeBtn.title = 'Remove folder';
            removeBtn.addEventListener('click', () => {
              settings.set(meta.key, getRoots().filter((_, j) => j !== i) as never);
              render();
            });
            rowEl.append(pathEl, browseBtn, removeBtn);
            wrap.appendChild(rowEl);
          });
        }
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'pmd-readers-add';
        addBtn.textContent = '+ Add folder';
        addBtn.addEventListener('click', () => {
          void (async (): Promise<void> => {
            const electron = getElectronHost();
            if (!electron) return;
            const picked = await electron.pickDirectory({ title: meta.label });
            if (picked == null) return;
            const roots = getRoots();
            if (!roots.includes(picked)) {
              settings.set(meta.key, [...roots, picked] as never);
              render();
            }
          })();
        });
        wrap.appendChild(addBtn);
      };
      render();
      row.appendChild(text);
      row.appendChild(wrap);
      return row;
    } else if (meta.kind === 'pathList') {
      // Like folderList, but entries can be FOLDERS or FILES (the file-search
      // exclusion list). Two add buttons; a row's Browse… reopens the picker
      // kind that plausibly created it (file extension → file picker).
      // electronOnly, so the folder picker host is present; the file picker
      // is a newer preload method, so its button hides on older shells.
      const wrap = document.createElement('div');
      wrap.className = 'pmd-settings-folderlist';
      const getPaths = (): string[] => (settings.get(meta.key) as string[]) ?? [];
      const looksLikeFile = (p: string): boolean => /\.(cmir|docx)$/i.test(p);
      const render = (): void => {
        wrap.innerHTML = '';
        const paths = getPaths();
        if (paths.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'pmd-settings-folderlist-empty';
          empty.textContent = '(none)';
          wrap.appendChild(empty);
        } else {
          paths.forEach((entryPath, i) => {
            const rowEl = document.createElement('div');
            rowEl.className = 'pmd-settings-folder';
            const pathEl = document.createElement('span');
            pathEl.className = 'pmd-settings-folder-path';
            setPathCell(pathEl, entryPath);
            const browseBtn = document.createElement('button');
            browseBtn.type = 'button';
            browseBtn.className = 'pmd-settings-btn';
            browseBtn.textContent = 'Browse…';
            browseBtn.addEventListener('click', () => {
              void (async (): Promise<void> => {
                const electron = getElectronHost();
                if (!electron) return;
                const picked = looksLikeFile(entryPath)
                  ? await electron.pickFile?.({
                      defaultPath: entryPath,
                      title: meta.label,
                      filters: [{ name: 'Documents', extensions: ['cmir', 'docx'] }],
                    })
                  : await electron.pickDirectory({
                      defaultPath: entryPath,
                      title: meta.label,
                    });
                if (picked == null) return;
                // Resolved by VALUE, not the render-time index — the list
                // can change under an open picker (see folder-list-repoint).
                const next = repointFolderRoot(getPaths(), entryPath, picked);
                if (next === null) return;
                settings.set(meta.key, next as never);
                render();
              })();
            });
            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'pmd-settings-btn';
            removeBtn.textContent = 'Remove';
            removeBtn.title = 'Remove entry';
            removeBtn.addEventListener('click', () => {
              settings.set(meta.key, getPaths().filter((_, j) => j !== i) as never);
              render();
            });
            rowEl.append(pathEl, browseBtn, removeBtn);
            wrap.appendChild(rowEl);
          });
        }
        const addTo = (picked: string | null | undefined): void => {
          if (picked == null) return;
          const paths = getPaths();
          if (!paths.includes(picked)) {
            settings.set(meta.key, [...paths, picked] as never);
            render();
          }
        };
        // Side by side (the list container is a column flex): folder
        // first, then file.
        const addRow = document.createElement('div');
        addRow.className = 'pmd-settings-pathlist-add';
        const addFolderBtn = document.createElement('button');
        addFolderBtn.type = 'button';
        addFolderBtn.className = 'pmd-readers-add';
        addFolderBtn.textContent = '+ Add folder';
        addFolderBtn.addEventListener('click', () => {
          void (async (): Promise<void> => {
            const electron = getElectronHost();
            if (!electron) return;
            addTo(await electron.pickDirectory({ title: meta.label }));
          })();
        });
        addRow.appendChild(addFolderBtn);
        if (getElectronHost()?.pickFile) {
          const addFileBtn = document.createElement('button');
          addFileBtn.type = 'button';
          addFileBtn.className = 'pmd-readers-add';
          addFileBtn.textContent = '+ Add file';
          addFileBtn.addEventListener('click', () => {
            void (async (): Promise<void> => {
              const electron = getElectronHost();
              if (!electron?.pickFile) return;
              addTo(
                await electron.pickFile({
                  title: meta.label,
                  filters: [{ name: 'Documents', extensions: ['cmir', 'docx'] }],
                }),
              );
            })();
          });
          addRow.appendChild(addFileBtn);
        }
        wrap.appendChild(addRow);
      };
      render();
      row.appendChild(text);
      row.appendChild(wrap);
      return row;
    } else if (meta.kind === 'cardCutterEnginePath') {
      // Like `folder`, but picks a FILE (the engine bundle) via the
      // native file dialog. electronOnly, so the host is always present.
      const wrap = document.createElement('div');
      wrap.className = 'pmd-settings-folder';
      const pathEl = document.createElement('span');
      pathEl.className = 'pmd-settings-folder-path';
      const refreshPath = (): void => {
        const value = settings.get(meta.key) as string;
        setPathCell(pathEl, value || '(default location)');
        pathEl.classList.toggle('pmd-settings-folder-empty', !value);
      };
      refreshPath();
      const browseBtn = document.createElement('button');
      browseBtn.type = 'button';
      browseBtn.className = 'pmd-settings-btn';
      browseBtn.textContent = 'Browse…';
      browseBtn.addEventListener('click', () => {
        void (async (): Promise<void> => {
          const electron = getElectronHost();
          if (!electron?.cardCutterPickFile) return;
          const picked = await electron.cardCutterPickFile();
          if (picked == null) return;
          settings.set(meta.key, picked as never);
          refreshPath();
        })();
      });
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'pmd-settings-btn';
      clearBtn.textContent = 'Clear';
      clearBtn.addEventListener('click', () => {
        settings.set(meta.key, '' as never);
        refreshPath();
      });
      wrap.appendChild(pathEl);
      wrap.appendChild(browseBtn);
      wrap.appendChild(clearBtn);
      row.appendChild(text);
      row.appendChild(wrap);
      return row;
    } else if (meta.kind === 'text' || meta.kind === 'password') {
      // Plain string input. Used for comment author / initials,
      // Anthropic API key, etc. Password kind masks the value.
      const input = document.createElement('input');
      input.type = meta.kind === 'password' ? 'password' : 'text';
      input.className = 'pmd-settings-text';
      input.autocomplete = 'off';
      input.spellcheck = false;
      const initial = settings.get(meta.key);
      input.value = typeof initial === 'string' ? initial : '';
      input.addEventListener('change', () => {
        settings.set(meta.key as 'commentAuthor', input.value as never);
      });
      label.appendChild(input);
    } else if (meta.kind === 'aiCitePrompt') {
      // A button only — the prompt editor opens in its own modal
      // because the prompt is long enough that an inline textarea
      // would shove the rest of the settings dialog off-screen.
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pmd-settings-btn';
      btn.textContent = 'Edit prompt';
      btn.addEventListener('click', () => {
        void import('./ai/edit-prompt-modal.js').then((m) => m.openCitePromptEditor());
      });
      label.appendChild(btn);
    } else if (meta.kind === 'pairingOwnCode') {
      row.appendChild(text);
      row.appendChild(buildPairingOwnCodeEditor());
      return row;
    } else if (meta.kind === 'pairingAccount') {
      row.appendChild(text);
      row.appendChild(buildPairingAccountEditor(row));
      return row;
    } else if (meta.kind === 'pairingPartners') {
      row.appendChild(text);
      row.appendChild(buildPairingPartnersEditor());
      return row;
    } else if (meta.kind === 'pairingGroups') {
      row.appendChild(text);
      row.appendChild(buildPairingGroupsEditor());
      return row;
    } else if (meta.kind === 'pairingBlocked') {
      row.appendChild(text);
      row.appendChild(buildPairingBlockedEditor());
      return row;
    } else if (meta.kind === 'pairingReceiveFlash') {
      row.appendChild(text);
      row.appendChild(buildPairingReceiveFlashEditor());
      return row;
    } else if (meta.kind === 'clod') {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'pmd-settings-toggle';
      checkbox.checked = !!settings.get(meta.key);
      checkbox.addEventListener('change', () => {
        settings.set(meta.key as 'clodEnabled', checkbox.checked as never);
      });
      label.appendChild(checkbox);
    } else if (meta.kind === 'clodCustomize') {
      // Opens the Clod customization dialog — persona name + pronouns,
      // the activity pools per time period, and the time-period
      // boundaries.
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pmd-settings-btn';
      btn.textContent = 'Customize…';
      btn.addEventListener('click', () => {
        void import('./ai/clod-configurator.js').then((m) => m.openClodConfigurator());
      });
      label.appendChild(btn);
    }

    row.appendChild(label);
    return row;
  }
}

function buildTypographyEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-typography-editor';

  function flagRow(
    key: keyof DisplayTypography,
    labelText: string,
  ): HTMLElement {
    const row = document.createElement('label');
    row.className = 'pmd-typography-flag-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!settings.get('displayTypography')[key];
    cb.addEventListener('change', () => {
      settings.set('displayTypography', {
        ...settings.get('displayTypography'),
        [key]: cb.checked,
      });
    });
    row.appendChild(cb);
    const lbl = document.createElement('span');
    lbl.textContent = labelText;
    row.appendChild(lbl);
    return row;
  }

  // Hierarchy order: the top-of-outline styles (pocket, hat) lead.
  wrap.appendChild(flagRow('pocketBox', 'Pocket: boxed'));
  wrap.appendChild(flagRow('hatUnderlineDouble', 'Hat: double underline'));
  wrap.appendChild(flagRow('citeUnderlined', 'Cite: underlined'));
  wrap.appendChild(flagRow('underlineBold', 'Underline: bold'));
  wrap.appendChild(flagRow('undertagItalic', 'Undertag: italic'));
  wrap.appendChild(flagRow('undertagBold', 'Undertag: bold'));
  wrap.appendChild(flagRow('emphasisBold', 'Emphasis: bold'));
  wrap.appendChild(flagRow('emphasisItalic', 'Emphasis: italic'));
  wrap.appendChild(flagRow('emphasisBox', 'Emphasis: boxed'));

  const sizeRow = document.createElement('label');
  sizeRow.className = 'pmd-typography-size-row';
  const sizeLbl = document.createElement('span');
  sizeLbl.textContent = 'Emphasis box thickness:';
  sizeRow.appendChild(sizeLbl);
  const sizeInput = document.createElement('input');
  sizeInput.type = 'number';
  sizeInput.className = 'pmd-typography-size-input';
  sizeInput.min = '0.25';
  sizeInput.max = '12';
  sizeInput.step = '0.25';
  sizeInput.value = String(settings.get('displayTypography').emphasisBoxSize);
  sizeInput.addEventListener('change', () => {
    const v = parseFloat(sizeInput.value);
    if (!Number.isFinite(v) || v <= 0) {
      sizeInput.value = String(settings.get('displayTypography').emphasisBoxSize);
      return;
    }
    settings.set('displayTypography', {
      ...settings.get('displayTypography'),
      emphasisBoxSize: v,
    });
  });
  sizeRow.appendChild(sizeInput);
  const unit = document.createElement('span');
  unit.className = 'pmd-typography-unit';
  unit.textContent = 'pt';
  sizeRow.appendChild(unit);
  wrap.appendChild(sizeRow);

  // Lives in this sub-editor (not as a top-level row) because it's a
  // sub-option of emphasis-box rendering — sits below the box thickness.
  const hideBordersRow = document.createElement('label');
  hideBordersRow.className = 'pmd-typography-flag-row pmd-typography-flag-row-with-desc';
  const hideBordersCb = document.createElement('input');
  hideBordersCb.type = 'checkbox';
  hideBordersCb.checked = !!settings.get('hideEmphasisBordersInReadMode');
  hideBordersCb.addEventListener('change', () => {
    settings.set('hideEmphasisBordersInReadMode', hideBordersCb.checked);
  });
  hideBordersRow.appendChild(hideBordersCb);
  const hideBordersText = document.createElement('div');
  hideBordersText.className = 'pmd-typography-flag-text';
  const hideBordersLbl = document.createElement('span');
  hideBordersLbl.textContent = 'Hide all emphasis borders in read mode';
  hideBordersText.appendChild(hideBordersLbl);
  const hideBordersDesc = document.createElement('span');
  hideBordersDesc.className = 'pmd-typography-flag-desc';
  hideBordersDesc.textContent =
    'Turn this on to strip every emphasis border in read mode, including around highlighted text.';
  hideBordersText.appendChild(hideBordersDesc);
  hideBordersRow.appendChild(hideBordersText);
  wrap.appendChild(hideBordersRow);

  // Pocket box thickness — mirrors the emphasis control above; placed
  // after the emphasis-box cluster (thickness + its read-mode
  // sub-option) so that cluster stays together.
  const pocketSizeRow = document.createElement('label');
  pocketSizeRow.className = 'pmd-typography-size-row';
  const pocketSizeLbl = document.createElement('span');
  pocketSizeLbl.textContent = 'Pocket box thickness:';
  pocketSizeRow.appendChild(pocketSizeLbl);
  const pocketSizeInput = document.createElement('input');
  pocketSizeInput.type = 'number';
  pocketSizeInput.className = 'pmd-typography-size-input';
  pocketSizeInput.min = '0.25';
  pocketSizeInput.max = '12';
  pocketSizeInput.step = '0.25';
  pocketSizeInput.value = String(settings.get('displayTypography').pocketBoxSize);
  pocketSizeInput.addEventListener('change', () => {
    const v = parseFloat(pocketSizeInput.value);
    if (!Number.isFinite(v) || v <= 0) {
      pocketSizeInput.value = String(settings.get('displayTypography').pocketBoxSize);
      return;
    }
    settings.set('displayTypography', {
      ...settings.get('displayTypography'),
      pocketBoxSize: v,
    });
  });
  pocketSizeRow.appendChild(pocketSizeInput);
  const pocketUnit = document.createElement('span');
  pocketUnit.className = 'pmd-typography-unit';
  pocketUnit.textContent = 'pt';
  pocketSizeRow.appendChild(pocketUnit);
  wrap.appendChild(pocketSizeRow);

  // Underline thickness — applies to the underline / emphasis marks
  // (and cite under the citeUnderlined flag). Unlike the box sizes,
  // 0 is meaningful: the font's automatic weight, shown as a blank
  // input with an "auto" placeholder rather than a misleading "0 pt".
  const underlineSizeRow = document.createElement('label');
  underlineSizeRow.className = 'pmd-typography-size-row';
  const underlineSizeLbl = document.createElement('span');
  underlineSizeLbl.textContent = 'Underline thickness:';
  underlineSizeRow.appendChild(underlineSizeLbl);
  const underlineSizeInput = document.createElement('input');
  underlineSizeInput.type = 'number';
  underlineSizeInput.className = 'pmd-typography-size-input';
  underlineSizeInput.min = '0.25';
  underlineSizeInput.max = '12';
  underlineSizeInput.step = '0.25';
  underlineSizeInput.placeholder = 'auto';
  const underlineSizeDisplay = (): string => {
    const v = settings.get('displayTypography').underlineSize;
    return v > 0 ? String(v) : '';
  };
  underlineSizeInput.value = underlineSizeDisplay();
  underlineSizeInput.addEventListener('change', () => {
    const raw = underlineSizeInput.value.trim();
    const v = raw === '' ? 0 : parseFloat(raw);
    if (!Number.isFinite(v) || v < 0) {
      underlineSizeInput.value = underlineSizeDisplay();
      return;
    }
    settings.set('displayTypography', {
      ...settings.get('displayTypography'),
      underlineSize: v,
    });
  });
  underlineSizeRow.appendChild(underlineSizeInput);
  const underlineUnit = document.createElement('span');
  underlineUnit.className = 'pmd-typography-unit';
  underlineUnit.textContent = 'pt';
  underlineSizeRow.appendChild(underlineUnit);
  wrap.appendChild(underlineSizeRow);

  // Re-render input values if settings change elsewhere.
  const unsubscribe = settings.subscribe(() => {
    const t = settings.get('displayTypography');
    sizeInput.value = String(t.emphasisBoxSize);
    pocketSizeInput.value = String(t.pocketBoxSize);
    underlineSizeInput.value = underlineSizeDisplay();
    // Sync checkboxes — the first N are typography flags (column order
    // matches flagKeys), the last is the hide-emphasis-borders toggle.
    const checkboxes = wrap.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    const flagKeys: (keyof DisplayTypography)[] = [
      'pocketBox', 'hatUnderlineDouble',
      'citeUnderlined', 'underlineBold',
      'undertagItalic', 'undertagBold',
      'emphasisBold', 'emphasisItalic', 'emphasisBox',
    ];
    flagKeys.forEach((k, i) => {
      const cb = checkboxes[i];
      if (cb) cb.checked = !!t[k];
    });
    const hideCb = checkboxes[flagKeys.length];
    if (hideCb) hideCb.checked = !!settings.get('hideEmphasisBordersInReadMode');
  });
  registerRowCleanup(wrap, () => unsubscribe());

  return wrap;
}

function buildColorsEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-colors-editor';

  const inputs: Partial<Record<keyof DisplayColors, HTMLInputElement>> = {};
  const resets: Partial<Record<keyof DisplayColors, HTMLButtonElement>> = {};

  const LABELS: Record<keyof DisplayColors, string> = {
    analytic: 'Analytic',
    undertag: 'Undertag',
    readingMarker: 'Reading marker',
    zoneDiverged: 'Linked-copy source-updated badge',
  };

  function setColor(key: keyof DisplayColors, value: string): void {
    settings.set('displayColors', { ...settings.get('displayColors'), [key]: value });
  }

  // The linked-copy source-updated badge is adjusted ONLY under Accessibility →
  // Color overrides (its `pmd-color-zone-diverged` token is still linked to this
  // `zoneDiverged` value), so it's omitted from the Style-colors editor here.
  const EDITOR_KEYS = DISPLAY_COLOR_KEYS.filter((k) => k !== 'zoneDiverged');

  for (const key of EDITOR_KEYS) {
    // A plain <div> wrapper, not <label> — a <label> would forward
    // clicks on the reset button to the color input and pop the picker.
    const row = document.createElement('div');
    row.className = 'pmd-colors-row';

    const lbl = document.createElement('span');
    lbl.className = 'pmd-colors-label';
    lbl.textContent = LABELS[key];
    row.appendChild(lbl);

    const picker = document.createElement('input');
    picker.type = 'color';
    picker.className = 'pmd-colors-input';
    picker.value = settings.get('displayColors')[key];
    picker.addEventListener('input', () => setColor(key, picker.value));
    row.appendChild(picker);

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'pmd-colors-reset';
    setIcon(reset, 'reset');
    reset.title = 'Reset to default';
    reset.setAttribute('aria-label', `Reset ${LABELS[key]} color to default`);
    reset.addEventListener('click', () => setColor(key, DEFAULT_DISPLAY_COLORS[key]));
    row.appendChild(reset);

    inputs[key] = picker;
    resets[key] = reset;
    wrap.appendChild(row);
  }

  // Keep pickers + reset-enabled state in sync with the store (covers
  // edits from the linked Accessibility panel, another tab, or reset).
  function refresh(): void {
    const c = settings.get('displayColors');
    for (const key of EDITOR_KEYS) {
      const inp = inputs[key];
      if (inp && inp.value !== c[key]) inp.value = c[key];
      const rst = resets[key];
      if (rst) rst.disabled = c[key].toLowerCase() === DEFAULT_DISPLAY_COLORS[key].toLowerCase();
    }
  }
  refresh();
  const unsubscribe = settings.subscribe(refresh);
  registerRowCleanup(wrap, () => unsubscribe());

  return wrap;
}

/** Read-only "About this install" diagnostic block. Lives at the
 *  bottom of Settings → General so a user filing a bug report can
 *  grab their version + platform + UA in one place. The actions
 *  (Check for Updates, Open Crash Dumps Folder) are Electron-only;
 *  they're omitted on the web edition. */
function buildInstallInfoSection(): HTMLElement {
  const wrap = document.createElement('section');
  wrap.className = 'pmd-install-info-section';
  // Deep-link target: the command palette's "version / about this install"
  // result scrolls here (SettingsTarget.anchor).
  wrap.dataset['anchor'] = 'about-this-install';

  const hr = document.createElement('hr');
  hr.className = 'pmd-install-info-divider';
  wrap.appendChild(hr);

  const heading = document.createElement('div');
  heading.className = 'pmd-install-info-heading';
  heading.textContent = 'About this install';
  wrap.appendChild(heading);

  const list = document.createElement('dl');
  list.className = 'pmd-install-info-list';
  for (const entry of getInstallInfo()) {
    const dt = document.createElement('dt');
    dt.textContent = entry.label;
    list.appendChild(dt);
    const dd = document.createElement('dd');
    dd.textContent = entry.value;
    if (entry.mono) dd.classList.add('pmd-install-info-mono');
    list.appendChild(dd);
  }
  wrap.appendChild(list);

  // Action buttons — Electron-only because they shell out to the
  // OS (update check via electron-updater, crash-dumps folder via
  // shell.openPath). The web edition has neither capability.
  const electronHost = getElectronHost();
  if (electronHost && !isLiteBuild()) {
    // "Check for updates automatically" toggle — kept next to the
    // manual Check-for-updates button since both govern updates.
    // When enabled, the app checks at launch AND once a day, staying
    // silent unless an update is found. Only the first window of a
    // session runs the checks; spawned windows skip them. The
    // triggers live in `index.ts`'s boot path.
    const launchRow = document.createElement('label');
    launchRow.className = 'pmd-install-info-launch-toggle';
    const launchInput = document.createElement('input');
    launchInput.type = 'checkbox';
    launchInput.checked = settings.get('checkForUpdatesOnLaunch');
    launchInput.addEventListener('change', () => {
      settings.set('checkForUpdatesOnLaunch', launchInput.checked);
    });
    const launchText = document.createElement('span');
    launchText.textContent = 'Check for updates automatically';
    launchRow.appendChild(launchInput);
    launchRow.appendChild(launchText);
    wrap.appendChild(launchRow);

    // Tournament mode (mirrors ebb): pause the AUTOMATIC checks for a
    // week so nothing downloads or changes mid-tournament. Manual
    // checks still work — a deliberate "check now" should always
    // answer. While paused the row shows when checks resume and the
    // button flips to an immediate resume.
    const pauseWrap = document.createElement('div');
    pauseWrap.className = 'pmd-update-pause';
    const pauseStatus = document.createElement('div');
    pauseStatus.className = 'pmd-update-pause-status';
    const pauseBtn = document.createElement('button');
    pauseBtn.type = 'button';
    pauseBtn.className = 'pmd-install-info-btn';
    const pauseDesc = document.createElement('div');
    pauseDesc.className = 'pmd-update-pause-desc';
    pauseDesc.textContent =
      'Going to a tournament? Pausing stops automatic update checks and downloads; manual checks still work.';
    const renderPause = (): void => {
      const until = settings.get('updateChecksPausedUntil');
      if (until > Date.now()) {
        const resume = new Date(until).toLocaleDateString(undefined, {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
        });
        pauseStatus.textContent = `Automatic update checks are paused — they resume ${resume}.`;
        pauseStatus.hidden = false;
        pauseBtn.textContent = 'Resume update checks now';
      } else {
        pauseStatus.hidden = true;
        pauseBtn.textContent = 'Pause update checks for 1 week';
      }
    };
    pauseBtn.addEventListener('click', () => {
      const paused = settings.get('updateChecksPausedUntil') > Date.now();
      settings.set(
        'updateChecksPausedUntil',
        paused ? 0 : Date.now() + 7 * 24 * 60 * 60 * 1000,
      );
      renderPause();
    });
    const unsubscribePause = settings.subscribe(() => renderPause());
    registerRowCleanup(pauseWrap, () => unsubscribePause());
    renderPause();
    // Caption above the button — description-then-control is the
    // ordering everywhere else in Settings.
    pauseWrap.appendChild(pauseStatus);
    pauseWrap.appendChild(pauseDesc);
    pauseWrap.appendChild(pauseBtn);

    const actions = document.createElement('div');
    actions.className = 'pmd-install-info-actions';

    const updatesBtn = document.createElement('button');
    updatesBtn.type = 'button';
    updatesBtn.className = 'pmd-install-info-btn';
    updatesBtn.textContent = 'Check for updates';
    updatesBtn.addEventListener('click', () => {
      updatesBtn.disabled = true;
      updatesBtn.textContent = 'Checking…';
      const restore = (): void => {
        updatesBtn.disabled = false;
        updatesBtn.textContent = 'Check for updates';
      };
      // .catch handles the case where the main process is older
      // than the renderer (dev hot-reload of the renderer without
      // restarting Electron leaves no IPC handler registered, so
      // `invoke` rejects). Without it the button would stay in
      // the disabled "Checking…" state forever.
      electronHost.checkForUpdates().then((result) => {
        restore();
        if (result.status === 'latest') {
          showToast("You're on the latest version.");
        } else if (result.status === 'updating') {
          // All platforms stage in the background now (mac via the
          // swap updater); the chip appears when it's ready.
          showToast('Update available — downloading in the background; watch for the status-bar chip.');
        } else if (result.status === 'dev') {
          showToast('Update checks are only active in packaged builds.');
        } else {
          showToast(`Update check failed: ${result.message ?? 'unknown error'}`);
        }
      }).catch((err: unknown) => {
        restore();
        showToast(`Update check failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
    actions.appendChild(updatesBtn);
    // Order (user spec, 2026-08-18): auto-check checkbox, then the
    // manual Check button, then the tournament-pause area.
    wrap.appendChild(actions);
    wrap.appendChild(pauseWrap);
  }

  if (electronHost && isLiteBuild()) {
    // Lite: say WHY there is no update UI instead of showing
    // controls that silently do nothing (field find, 2026-08-18).
    const liteNote = document.createElement('div');
    liteNote.className = 'pmd-update-pause-desc';
    liteNote.textContent =
      'CardMirror Lite never checks for updates or connects to the ' +
      'internet. To upgrade, install a newer Lite build from the ' +
      'releases page.';
    wrap.appendChild(liteNote);
  }

  return wrap;
}

/** Crash-dumps section — its own header between About this install and
 *  Back up settings (same markup as the backup section). Desktop only:
 *  the folder is an OS path the web edition doesn't have. */
function buildCrashDumpsSection(): HTMLElement | null {
  const electronHost = getElectronHost();
  if (!electronHost) return null;
  const section = document.createElement('section');
  section.className = 'pmd-settings-backup';

  const title = document.createElement('div');
  title.className = 'pmd-settings-row-title';
  title.textContent = 'Crash dumps';
  section.appendChild(title);

  const desc = document.createElement('div');
  desc.className = 'pmd-settings-row-desc';
  desc.textContent =
    'If CardMirror ever crashes, the system saves a diagnostic dump in this ' +
    'folder. Attaching the newest file to a bug report helps pin down the ' +
    'cause — nothing is sent anywhere unless you share it yourself.';
  section.appendChild(desc);

  const actions = document.createElement('div');
  actions.className = 'pmd-settings-backup-actions';
  const crashBtn = document.createElement('button');
  crashBtn.type = 'button';
  crashBtn.className = 'pmd-settings-backup-btn';
  crashBtn.textContent = 'Open crash dumps folder';
  crashBtn.addEventListener('click', () => {
    electronHost.openCrashDumpsFolder().catch((err: unknown) => {
      showToast(
        `Open crash dumps folder failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  });
  actions.appendChild(crashBtn);
  section.appendChild(actions);

  return section;
}

/** GitHub-hosted copies of the user-facing docs — opened from Settings → General
 *  (and, on macOS, the Help menu). Pinned in Settings so they stay reachable on
 *  Windows/Linux, which carry no native menu bar. */
const MANUAL_URL = 'https://github.com/ant981228/cardmirror/blob/main/MANUAL.md';
const PRIVACY_URL = 'https://github.com/ant981228/cardmirror/blob/main/PRIVACY.md';
const TERMS_URL = 'https://github.com/ant981228/cardmirror/blob/main/TERMS.md';

/** One external doc link. On desktop it routes through the host so it opens in
 *  the OS browser rather than a new Electron window; on web the anchor opens a
 *  normal tab. */
function buildDocLink(label: string, url: string): HTMLAnchorElement {
  const link = document.createElement('a');
  link.className = 'pmd-settings-manual-link';
  link.href = url;
  link.textContent = label;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.addEventListener('click', (e) => {
    const electron = getElectronHost();
    if (electron) {
      e.preventDefault();
      void electron.openExternal(url);
    }
  });
  return link;
}

/** "User Manual", "Privacy Policy", and "Terms of Use" links pinned at the
 *  bottom of Settings → General, separated by middots. */
function buildDocLinksSection(): HTMLElement {
  const section = document.createElement('section');
  section.className = 'pmd-settings-manual';
  const docs: Array<[string, string]> = [
    ['User Manual ↗', MANUAL_URL],
    ['Privacy Policy ↗', PRIVACY_URL],
    ['Terms of Use ↗', TERMS_URL],
  ];
  docs.forEach(([label, url], i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'pmd-settings-manual-sep';
      sep.textContent = '·';
      sep.setAttribute('aria-hidden', 'true');
      section.appendChild(sep);
    }
    section.appendChild(buildDocLink(label, url));
  });
  return section;
}

/** Settings → Benchmark: a game-style in-app perf suite. The button closes the
 *  dialog first (the editor must be visible — occluded content gets its paints
 *  culled, which would falsify the frame times) and launches the overlay. */
function buildBenchmarkSection(closeDialog: () => void): HTMLElement {
  const section = document.createElement('section');
  section.className = 'pmd-settings-benchmark';

  const title = document.createElement('h3');
  title.className = 'pmd-settings-section-title';
  title.textContent = 'Performance benchmark';
  section.appendChild(title);

  const desc = document.createElement('div');
  desc.className = 'pmd-settings-row-desc';
  desc.textContent =
    'Runs a battery of real in-editor operations on the currently open document — ' +
    'scrolling, jumping between headings, a drag-move, and a short editing sequence ' +
    '— and reports frame rate, frame-time percentiles, and latencies. Open your ' +
    'test document first (a large one tells the most); it is driven on screen while ' +
    'it runs and restored exactly afterward.';
  section.appendChild(desc);

  const actions = document.createElement('div');
  actions.className = 'pmd-settings-backup-actions';
  const run = document.createElement('button');
  run.type = 'button';
  run.className = 'pmd-settings-backup-btn';
  run.textContent = 'Run benchmark';
  run.addEventListener('click', () => {
    closeDialog();
    void launchBenchmarkOverlay();
  });
  actions.appendChild(run);
  section.appendChild(actions);

  return section;
}

function buildBodyFontEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-body-font-editor';

  const select = document.createElement('select');
  select.className = 'pmd-body-font-select';

  function populate(): void {
    select.innerHTML = '';
    const current = settings.get('bodyFont');
    const GENERICS = new Set([
      'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
    ]);
    function buildOption(font: string): HTMLOptionElement {
      const opt = document.createElement('option');
      opt.value = font;
      opt.textContent = font;
      // Render each option in the font itself so the user can preview
      // before committing. Generic CSS keywords (serif, sans-serif,
      // monospace) must NOT be quoted; named fonts must be.
      opt.style.fontFamily = GENERICS.has(font) ? font : `"${font}", sans-serif`;
      if (font === current) opt.selected = true;
      return opt;
    }
    // If the user's current selection isn't in any group (e.g., a
    // saved-but-unavailable bundled font, or a name the user typed
    // by hand), show it as a stand-alone option above the groups so
    // it's still visible and re-selectable.
    const currentInGroups = FONT_GROUPS.some((g) => g.fonts.includes(current));
    if (!currentInGroups) {
      select.appendChild(buildOption(current));
    }
    for (const group of FONT_GROUPS) {
      const available = group.fonts.filter(isFontAvailable);
      if (available.length === 0) continue;
      const og = document.createElement('optgroup');
      og.label = group.label;
      for (const font of available) og.appendChild(buildOption(font));
      select.appendChild(og);
    }
  }

  populate();

  select.addEventListener('change', () => {
    settings.set('bodyFont', select.value);
  });

  wrap.appendChild(select);

  const unsubscribe = settings.subscribe(() => {
    if (select.value !== settings.get('bodyFont')) populate();
  });
  registerRowCleanup(wrap, () => unsubscribe());

  return wrap;
}

/** UI-font picker. Same shape as the body-font picker, but the
 *  default value is an empty string (= use the stylesheet's
 *  system-UI default) and the first option is an explicit "System
 *  default" entry that resolves to that empty string. */
function buildUiFontEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-body-font-editor';

  const select = document.createElement('select');
  select.className = 'pmd-body-font-select';

  function populate(): void {
    select.innerHTML = '';
    const current = settings.get('uiFont');
    const GENERICS = new Set([
      'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
    ]);

    // "System default" sentinel — value '' means "no override, use
    // the stylesheet's `--pmd-ui-font` default (the platform UI
    // stack)."
    const systemOpt = document.createElement('option');
    systemOpt.value = '';
    systemOpt.textContent = 'System default';
    if (current === '') systemOpt.selected = true;
    select.appendChild(systemOpt);

    function buildOption(font: string): HTMLOptionElement {
      const opt = document.createElement('option');
      opt.value = font;
      opt.textContent = font;
      opt.style.fontFamily = GENERICS.has(font) ? font : `"${font}", sans-serif`;
      if (font === current) opt.selected = true;
      return opt;
    }
    const currentInGroups = FONT_GROUPS.some((g) => g.fonts.includes(current));
    if (current !== '' && !currentInGroups) {
      select.appendChild(buildOption(current));
    }
    for (const group of FONT_GROUPS) {
      const available = group.fonts.filter(isFontAvailable);
      if (available.length === 0) continue;
      const og = document.createElement('optgroup');
      og.label = group.label;
      for (const font of available) og.appendChild(buildOption(font));
      select.appendChild(og);
    }
  }

  populate();

  select.addEventListener('change', () => {
    settings.set('uiFont', select.value);
  });

  wrap.appendChild(select);

  const unsubscribe = settings.subscribe(() => {
    if (select.value !== settings.get('uiFont')) populate();
  });
  registerRowCleanup(wrap, () => unsubscribe());

  return wrap;
}

type LineHeightKey =
  | 'lineHeight'
  | 'lineHeightCite'
  | 'lineHeightTag'
  | 'lineHeightAnalytic'
  | 'lineHeightHeading'
  | 'lineHeightUndertag';

const LINE_HEIGHT_ROWS: { key: LineHeightKey; label: string }[] = [
  { key: 'lineHeight', label: 'Body' },
  { key: 'lineHeightCite', label: 'Cite paragraphs' },
  { key: 'lineHeightTag', label: 'Tags' },
  { key: 'lineHeightAnalytic', label: 'Analytics' },
  { key: 'lineHeightHeading', label: 'Pocket / Hat / Block' },
  { key: 'lineHeightUndertag', label: 'Undertags' },
];

const PARAGRAPH_SPACING_ROWS: { label: string; before: ParagraphSpacingKey; after: ParagraphSpacingKey }[] = [
  { label: 'Body', before: 'bodyBefore', after: 'bodyAfter' },
  { label: 'Cite paragraphs', before: 'citeBefore', after: 'citeAfter' },
  { label: 'Tags', before: 'tagBefore', after: 'tagAfter' },
  { label: 'Analytics', before: 'analyticBefore', after: 'analyticAfter' },
  { label: 'Pockets', before: 'pocketBefore', after: 'pocketAfter' },
  { label: 'Hats', before: 'hatBefore', after: 'hatAfter' },
  { label: 'Blocks', before: 'blockBefore', after: 'blockAfter' },
  { label: 'Undertags', before: 'undertagBefore', after: 'undertagAfter' },
];

function buildParagraphSpacingEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-para-spacing-editor';

  const rowsContainer = document.createElement('div');
  rowsContainer.className = 'pmd-para-spacing-rows';
  wrap.appendChild(rowsContainer);

  function cell(key: ParagraphSpacingKey, value: number): HTMLElement {
    const c = document.createElement('span');
    c.className = 'pmd-para-spacing-cell';
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'pmd-para-spacing-input';
    input.min = '0';
    input.max = '96';
    input.step = '0.5';
    input.value = String(value);
    input.addEventListener('change', () => {
      const cur = settings.get('displayParagraphSpacing');
      const v = parseFloat(input.value);
      if (!Number.isFinite(v) || v < 0) {
        input.value = String(cur[key]);
        return;
      }
      settings.set('displayParagraphSpacing', { ...cur, [key]: v });
    });
    c.appendChild(input);
    const unit = document.createElement('span');
    unit.className = 'pmd-para-spacing-unit';
    unit.textContent = 'pt';
    c.appendChild(unit);
    return c;
  }

  function render(): void {
    rowsContainer.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'pmd-para-spacing-row pmd-para-spacing-head';
    head.appendChild(document.createElement('span')); // label column spacer
    for (const t of ['Before', 'After']) {
      const h = document.createElement('span');
      h.className = 'pmd-para-spacing-colhead';
      h.textContent = t;
      head.appendChild(h);
    }
    rowsContainer.appendChild(head);

    const spacing = settings.get('displayParagraphSpacing');
    for (const { label, before, after } of PARAGRAPH_SPACING_ROWS) {
      const row = document.createElement('div');
      row.className = 'pmd-para-spacing-row';
      const lbl = document.createElement('span');
      lbl.className = 'pmd-para-spacing-row-label';
      lbl.textContent = label;
      row.appendChild(lbl);
      row.appendChild(cell(before, spacing[before]));
      row.appendChild(cell(after, spacing[after]));
      rowsContainer.appendChild(row);
    }
  }

  const footer = document.createElement('div');
  footer.className = 'pmd-line-heights-footer';
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'pmd-line-heights-reset-btn';
  setIcon(resetBtn, 'reset');
  resetBtn.title = 'Restore defaults';
  resetBtn.setAttribute('aria-label', 'Restore paragraph spacing defaults');
  resetBtn.addEventListener('click', () => {
    settings.set('displayParagraphSpacing', { ...DEFAULT_PARAGRAPH_SPACING });
    // Re-sync the inputs (the subscriber skips re-render while focus is in
    // this editor, and the reset button holds focus).
    render();
  });
  footer.appendChild(resetBtn);
  wrap.appendChild(footer);

  const unsubscribe = settings.subscribe(() => {
    if (!(document.activeElement && wrap.contains(document.activeElement))) {
      render();
    }
  });
  render();
  registerRowCleanup(wrap, () => unsubscribe());

  return wrap;
}

function buildLineHeightsEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-line-heights-editor';

  const rowsContainer = document.createElement('div');
  rowsContainer.className = 'pmd-line-heights-rows';
  wrap.appendChild(rowsContainer);

  function render(): void {
    rowsContainer.innerHTML = '';
    for (const { key, label: labelText } of LINE_HEIGHT_ROWS) {
      const row = document.createElement('div');
      row.className = 'pmd-line-height-row';

      const label = document.createElement('label');
      label.className = 'pmd-line-height-row-label';
      label.textContent = labelText;
      row.appendChild(label);

      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'pmd-line-height-input';
      input.min = '1.0';
      input.max = '2.0';
      input.step = '0.05';
      input.value = String(settings.get(key));
      input.addEventListener('change', () => {
        const v = parseFloat(input.value);
        if (!Number.isFinite(v)) {
          input.value = String(settings.get(key));
          return;
        }
        settings.set(key, v);
      });
      row.appendChild(input);

      const unit = document.createElement('span');
      unit.className = 'pmd-line-height-unit';
      unit.textContent = '× font size';
      row.appendChild(unit);

      rowsContainer.appendChild(row);
    }
  }

  // Reset button — same styling/shape as the status bar's zoom reset.
  const footer = document.createElement('div');
  footer.className = 'pmd-line-heights-footer';
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'pmd-line-heights-reset-btn';
  setIcon(resetBtn, 'reset');
  resetBtn.title = 'Restore defaults';
  resetBtn.setAttribute('aria-label', 'Restore line spacing defaults');
  resetBtn.addEventListener('click', () => {
    for (const { key } of LINE_HEIGHT_ROWS) {
      settings.set(key, SETTINGS_DEFAULTS[key]);
    }
    // Re-sync the inputs to the defaults. The settings subscriber skips
    // re-rendering while focus is inside this editor (so it can't clobber
    // a value you're typing) — and the reset button itself holds focus —
    // so the reset must redraw explicitly.
    render();
  });
  footer.appendChild(resetBtn);
  wrap.appendChild(footer);

  const unsubscribe = settings.subscribe(() => {
    if (!(document.activeElement && wrap.contains(document.activeElement))) {
      render();
    }
  });
  render();
  registerRowCleanup(wrap, () => unsubscribe());

  return wrap;
}

function buildDisplaySizesEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-display-sizes-editor';

  function commit(next: DisplaySizes): void {
    settings.set('displaySizes', next);
  }

  function render(): void {
    wrap.innerHTML = '';
    const sizes = settings.get('displaySizes');
    for (const key of DISPLAY_SIZE_KEYS) {
      const row = document.createElement('div');
      row.className = 'pmd-display-size-row';

      const label = document.createElement('label');
      label.className = 'pmd-display-size-label';
      label.textContent = DISPLAY_SIZE_LABELS[key];
      row.appendChild(label);

      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'pmd-display-size-input';
      input.min = '1';
      input.max = '144';
      input.step = '0.5';
      input.value = String(sizes[key]);
      input.addEventListener('change', () => {
        const v = parseFloat(input.value);
        if (!Number.isFinite(v) || v <= 0) {
          input.value = String(sizes[key]);
          return;
        }
        commit({ ...settings.get('displaySizes'), [key]: v });
      });
      row.appendChild(input);

      const unit = document.createElement('span');
      unit.className = 'pmd-display-size-unit';
      unit.textContent = 'pt';
      row.appendChild(unit);

      wrap.appendChild(row);
    }

    // Reset-to-defaults footer (reuses the line-heights footer/button
    // look — same icon-button treatment, no new CSS).
    const footer = document.createElement('div');
    footer.className = 'pmd-line-heights-footer';
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'pmd-line-heights-reset-btn';
    setIcon(resetBtn, 'reset');
    resetBtn.title = 'Restore defaults';
    resetBtn.setAttribute('aria-label', 'Restore style font size defaults');
    resetBtn.addEventListener('click', () => {
      commit({ ...DEFAULT_DISPLAY_SIZES });
    });
    footer.appendChild(resetBtn);
    wrap.appendChild(footer);
  }

  const unsubscribe = settings.subscribe((s) => {
    void s;
    render();
  });
  render();

  registerRowCleanup(wrap, () => unsubscribe());

  return wrap;
}

function buildReadersEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-readers-editor';

  const list = document.createElement('div');
  list.className = 'pmd-readers-list';
  wrap.appendChild(list);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'pmd-readers-add';
  addBtn.textContent = '+ Add reader';
  wrap.appendChild(addBtn);

  function commit(readers: ReaderConfig[]): void {
    settings.set('readers', readers);
  }

  function render(): void {
    list.innerHTML = '';
    const readers = settings.get('readers');

    readers.forEach((reader, idx) => {
      const row = document.createElement('div');
      row.className = 'pmd-reader-row';

      const primary = document.createElement('span');
      primary.className = 'pmd-reader-rank';
      primary.textContent = idx < 2 ? `#${idx + 1}` : '';
      primary.title = idx < 2 ? 'Shown live in the status bar' : 'Shown in Word Count Selection only';
      row.appendChild(primary);

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'pmd-reader-name';
      nameInput.value = reader.name;
      nameInput.placeholder = 'Name';
      nameInput.addEventListener('change', () => {
        const next = settings.get('readers').map((r, i) =>
          i === idx ? { ...r, name: nameInput.value.trim() || r.name } : r,
        );
        commit(next);
      });
      row.appendChild(nameInput);

      const wpmInput = document.createElement('input');
      wpmInput.type = 'number';
      wpmInput.className = 'pmd-reader-wpm';
      wpmInput.min = '1';
      wpmInput.step = '1';
      wpmInput.value = String(reader.wpm);
      wpmInput.addEventListener('change', () => {
        const v = parseInt(wpmInput.value, 10);
        if (!Number.isFinite(v) || v <= 0) {
          wpmInput.value = String(reader.wpm);
          return;
        }
        const next = settings.get('readers').map((r, i) =>
          i === idx ? { ...r, wpm: v } : r,
        );
        commit(next);
      });
      row.appendChild(wpmInput);

      const wpmLabel = document.createElement('span');
      wpmLabel.className = 'pmd-reader-wpm-label';
      wpmLabel.textContent = 'wpm';
      row.appendChild(wpmLabel);

      // Optional SECOND rate: tags, analytics, and cites (the structural
      // read). Blank = the main rate covers everything.
      const tagWpmInput = document.createElement('input');
      tagWpmInput.type = 'number';
      tagWpmInput.className = 'pmd-reader-wpm pmd-reader-tagwpm';
      tagWpmInput.min = '1';
      tagWpmInput.step = '1';
      tagWpmInput.value = reader.tagWpm != null ? String(reader.tagWpm) : '';
      tagWpmInput.placeholder = 'same';
      tagWpmInput.title =
        'Optional separate rate for tags, analytics, and cites. '
        + 'Blank: the main rate covers everything.';
      tagWpmInput.addEventListener('change', () => {
        const trimmed = tagWpmInput.value.trim();
        const clear = trimmed === '';
        const v = parseInt(trimmed, 10);
        if (!clear && (!Number.isFinite(v) || v <= 0)) {
          tagWpmInput.value = reader.tagWpm != null ? String(reader.tagWpm) : '';
          return;
        }
        const next = settings.get('readers').map((r, i) => {
          if (i !== idx) return r;
          const { tagWpm: _prev, ...rest } = r;
          return clear ? rest : { ...rest, tagWpm: v };
        });
        commit(next);
      });
      row.appendChild(tagWpmInput);

      const tagWpmLabel = document.createElement('span');
      tagWpmLabel.className = 'pmd-reader-wpm-label';
      tagWpmLabel.textContent = 'tags/cites wpm';
      tagWpmLabel.title = tagWpmInput.title;
      row.appendChild(tagWpmLabel);

      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'pmd-reader-move';
      setIcon(upBtn, 'arrow-up');
      upBtn.title = 'Move up';
      upBtn.disabled = idx === 0;
      upBtn.addEventListener('click', () => {
        const cur = [...settings.get('readers')];
        if (idx === 0) return;
        [cur[idx - 1], cur[idx]] = [cur[idx]!, cur[idx - 1]!];
        commit(cur);
      });
      row.appendChild(upBtn);

      const downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.className = 'pmd-reader-move';
      setIcon(downBtn, 'arrow-down');
      downBtn.title = 'Move down';
      downBtn.disabled = idx === readers.length - 1;
      downBtn.addEventListener('click', () => {
        const cur = [...settings.get('readers')];
        if (idx >= cur.length - 1) return;
        [cur[idx], cur[idx + 1]] = [cur[idx + 1]!, cur[idx]!];
        commit(cur);
      });
      row.appendChild(downBtn);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'pmd-reader-delete';
      setIcon(delBtn, 'close');
      delBtn.title = 'Remove reader';
      delBtn.addEventListener('click', () => {
        const next = settings.get('readers').filter((_, i) => i !== idx);
        if (next.length === 0) return; // keep at least one
        commit(next);
      });
      row.appendChild(delBtn);

      list.appendChild(row);
    });
  }

  addBtn.addEventListener('click', () => {
    const cur = settings.get('readers');
    commit([...cur, { name: `Reader ${cur.length + 1}`, wpm: 200 }]);
  });

  // Re-render on any settings change (covers edits made elsewhere).
  const unsubscribe = settings.subscribe((s) => {
    void s;
    render();
  });
  render();

  registerRowCleanup(wrap, () => unsubscribe());

  return wrap;
}

/** Blog-account row: account linking, required for card sharing and
 *  co-editing on the official relay (gating flipped on server-side
 *  2026-08-17). Paste-a-connect-code UI with the seat-limit
 *  confirm flow: a 409 names the oldest seat and carries a fresh
 *  retryCode (codes are single-use), so the confirm retry never bounces
 *  the user back to the blog page. The row waits for the main process
 *  to report the flow available, so an older main (or the web edition,
 *  which has no pairing IPC at all) leaves it hidden. */
function buildPairingAccountEditor(row: HTMLElement): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-pairing-account';
  row.style.display = 'none'; // shown only once main confirms the flow is available

  // Real link (external browser on desktop) — nobody should have to
  // retype a URL out of the description text.
  const linkRow = document.createElement('div');
  linkRow.className = 'pmd-pairing-account-link';
  linkRow.appendChild(
    buildDocLink('Open the connect page', 'https://debate-decoded.ghost.io/cardmirror-connect/'),
  );
  wrap.appendChild(linkRow);

  // One row in both states. Connected: the "✓ Connected as …" chip
  // fills the row with Disconnect at the right edge. Disconnected: a
  // compact "✗ Not connected" chip, then the code input filling the
  // row, then Connect.
  const controls = document.createElement('div');
  controls.className = 'pmd-pairing-account-controls';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'pmd-settings-text';
  input.placeholder = 'paste the connect code here';
  input.spellcheck = false;
  controls.appendChild(input);
  const connectedInfo = document.createElement('div');
  connectedInfo.className = 'pmd-pairing-account-connected';
  controls.insertBefore(connectedInfo, input); // status chip leads the row

  const connectBtn = document.createElement('button');
  connectBtn.type = 'button';
  connectBtn.className = 'pmd-settings-btn';
  connectBtn.textContent = 'Connect';
  controls.appendChild(connectBtn);
  const disconnectBtn = document.createElement('button');
  disconnectBtn.type = 'button';
  disconnectBtn.className = 'pmd-settings-btn';
  disconnectBtn.textContent = 'Disconnect';
  disconnectBtn.hidden = true; // shown only in the connected state
  controls.appendChild(disconnectBtn);
  wrap.appendChild(controls);

  const message = document.createElement('div');
  message.className = 'pmd-pairing-account-message';
  wrap.appendChild(message);

  // Inactive-membership notice — its own line below the row, so it shows
  // in either state without disturbing the left/right layout.
  const lapseNotice = document.createElement('div');
  lapseNotice.className = 'pmd-pairing-account-lapsed';
  lapseNotice.hidden = true;
  lapseNotice.textContent =
    '⚠ Debate Decoded reports this membership inactive, so the link will pause soon. ' +
    'Renew on Debate Decoded to keep it.';
  wrap.appendChild(lapseNotice);

  function renderStatus(st: {
    connected: boolean;
    expiresAt: number;
    email?: string;
    lapsed?: boolean;
  }): void {
    // Connected: this machine is already linked, so the helper line, the
    // connect-page link, the code box, and Connect are all dead weight.
    // The link is durable and self-renewing, so no expiry date — it
    // reads like a deadline when it's an implementation detail.
    const connected = st.connected;
    linkRow.hidden = connected;
    input.hidden = connected;
    connectBtn.hidden = connected;
    disconnectBtn.hidden = !connected;

    // The status chip renders in BOTH states: "✓ Connected as …"
    // filling the row, or a compact "✗ Not connected" leading it.
    connectedInfo.replaceChildren();
    connectedInfo.classList.toggle('pmd-pairing-account-notlinked', !connected);
    const glyph = document.createElement('span');
    glyph.className = connected
      ? 'pmd-pairing-account-check'
      : 'pmd-pairing-account-check pmd-pairing-account-cross';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = connected ? '✓' : '✕';
    connectedInfo.appendChild(glyph);
    connectedInfo.appendChild(
      document.createTextNode(
        connected ? (st.email ? `Connected as ${st.email}` : 'Connected') : 'Not connected',
      ),
    );
    lapseNotice.hidden = !st.lapsed;
  }

  const ERROR_TEXT: Record<string, string> = {
    badCode: 'That code is invalid or expired — generate a fresh one on the blog page.',
    subscription:
      'Your membership isn\u2019t active \u2014 renew it on Debate Decoded to link this machine.',
    evicted: 'Another machine took this seat. Generate a new code to re-link.',
    unsupported: 'The relay doesn\u2019t support accounts.',
    network: 'Couldn\u2019t reach the relay.',
    disabled: 'Account linking isn\u2019t enabled in this build.',
  };

  async function connect(code: string, confirmEvict: boolean, evict?: string): Promise<void> {
    const electron = getElectronHost();
    if (!electron?.pairingConnectAccount) return;
    connectBtn.disabled = true;
    message.textContent = 'Connecting\u2026';
    try {
      const res = await electron.pairingConnectAccount({
        connectCode: code,
        confirmEvict,
        ...(evict ? { evict } : {}),
      });
      if (res.ok) {
        message.textContent = '';
        input.value = '';
        renderStatus({ connected: true, expiresAt: res.expiresAt ?? 0, email: res.email ?? '' });
        settings.set('pairingConnectedUntil', res.expiresAt ?? 0);
        showToast('Connected to Debate Decoded');
        return;
      }
      if (res.error === 'seatLimit' && res.retryCode) {
        const pick = await pickSeatToUnlink(
          res.candidates ?? [],
          res.limit ?? 2,
          res.wouldEvict?.boundAt,
          'machine',
        );
        if (pick === 'cancel') {
          message.textContent = 'Not linked — your existing machines keep their seats.';
          return;
        }
        await connect(res.retryCode, true, pick);
        return;
      }
      message.textContent = ERROR_TEXT[res.error ?? ''] ?? `Couldn\u2019t connect (${res.error}).`;
    } finally {
      connectBtn.disabled = false;
    }
  }

  connectBtn.addEventListener('click', () => {
    const code = input.value.trim();
    if (code) void connect(code, false);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) void connect(input.value.trim(), false);
  });
  disconnectBtn.addEventListener('click', () => {
    const electron = getElectronHost();
    if (!electron?.pairingDisconnectAccount) return;
    void electron.pairingDisconnectAccount().then((st) => {
      renderStatus({ connected: false, expiresAt: 0 });
      settings.set('pairingConnectedUntil', 0);
      message.textContent = '';
      void st;
    });
  });

  // Web edition (web-collab Phase 3): same row, same chip, backed by
  // the browser's WebCrypto identity + web-account store instead of
  // Electron IPC. Reveals whenever a relay endpoint resolves — the
  // account is exactly what makes that relay usable from a browser.
  if (!getElectronHost()) {
    void (async () => {
      const [account, relay] = await Promise.all([
        import('./collab/web-account.js'),
        import('./collab/collab-relay.js'),
      ]);
      if (!relay.relayBaseUrl()) return; // no relay configured → keep hidden
      row.style.display = '';
      const st = account.webAccountStatus();
      renderStatus({ connected: st.connected, expiresAt: st.expiresAt ?? 0, email: st.email });

      const webConnect = async (code: string, confirmEvict: boolean, evict?: string): Promise<void> => {
        connectBtn.disabled = true;
        message.textContent = 'Connecting…';
        try {
          const got = await account.webAccountConnect(relay.relayBaseUrl(), code, {
            confirmEvict,
            ...(evict ? { evict } : {}),
          });
          message.textContent = '';
          input.value = '';
          renderStatus({
            connected: got.connected,
            expiresAt: got.expiresAt ?? 0,
            email: got.email,
          });
          showToast('Connected to Debate Decoded');
        } catch (err) {
          const e = err as { status?: number; detailObj?: Record<string, unknown> };
          const d = e.detailObj ?? {};
          if (e.status === 409 && d['error'] === 'seatLimit' && typeof d['retryCode'] === 'string') {
            const wouldEvict = d['wouldEvict'] as { boundAt?: string } | undefined;
            const pick = await pickSeatToUnlink(
              Array.isArray(d['candidates']) ? (d['candidates'] as SeatCandidateUi[]) : [],
              Number(d['limit'] ?? 2) || 2,
              wouldEvict?.boundAt,
              'browser',
            );
            if (pick === 'cancel') {
              message.textContent = 'Not linked — your existing machines keep their seats.';
              return;
            }
            // confirmEvict MUST ride the retry — retrying with false
            // just consumes the fresh retryCode, 409s again, and
            // re-shows this dialog forever (field report 2026-08-27).
            // The picked machine rides as `evict` (relay ≥ 2026-09-02).
            await webConnect(d['retryCode'], true, pick);
            return;
          }
          if (e.status === 409 && d['error'] === 'youWereEvicted') {
            message.textContent = ERROR_TEXT['evicted']!;
            return;
          }
          if (e.status === 401) {
            message.textContent = ERROR_TEXT['badCode']!;
            return;
          }
          if (e.status === 403) {
            message.textContent = ERROR_TEXT['subscription']!;
            return;
          }
          message.textContent = ERROR_TEXT['network']!;
        } finally {
          connectBtn.disabled = false;
        }
      };

      connectBtn.addEventListener('click', () => {
        const code = input.value.trim();
        if (code) void webConnect(code, false);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && input.value.trim()) void webConnect(input.value.trim(), false);
      });
      disconnectBtn.addEventListener('click', () => {
        // Unlink (not bare disconnect): also releases this browser's
        // seat server-side, best-effort, so it frees immediately.
        account.webAccountUnlink(relay.relayBaseUrl());
        renderStatus({ connected: false, expiresAt: 0 });
        message.textContent = '';
      });
    })();
    return wrap;
  }

  // Reveal the row only when main reports the flow enabled; keep the
  // status live while the dialog is open.
  const electron = getElectronHost();
  if (electron?.pairingAccountStatus) {
    void electron.pairingAccountStatus().then((st) => {
      if (!st.enabled) return;
      row.style.display = '';
      renderStatus(st);
    });
    const off = electron.onPairingEntitlementChanged?.((st) => {
      renderStatus(st);
      if (st.evicted) message.textContent = ERROR_TEXT['evicted']!;
    });
    registerRowCleanup(row, () => off?.());
  }

  return wrap;
}

function buildPairingOwnCodeEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-pairing-owncode';

  const codeEl = document.createElement('code');
  codeEl.className = 'pmd-pairing-owncode-value';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'pmd-settings-btn';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', () => {
    const code = settings.get('pairingOwnCode');
    if (!code) return;
    void navigator.clipboard?.writeText(code).then(
      () => showToast('Pairing code copied'),
      () => showToast('Could not copy code'),
    );
  });

  const regenBtn = document.createElement('button');
  regenBtn.type = 'button';
  regenBtn.className = 'pmd-settings-btn';
  regenBtn.title =
    'Make a new code. Anyone using your old code can no longer reach you until you re-share.';
  regenBtn.addEventListener('click', () => {
    void (async () => {
      const had = !!settings.get('pairingOwnCode');
      if (
        had &&
        !(await confirmDialog(
          'Regenerate your pairing code? Anyone you already shared the old code with will need the new one.',
          { okLabel: 'Regenerate' },
        ))
      ) {
        return;
      }
      // The keypair lives in the main process; ask it to mint a fresh one.
      void regenerateOwnCode().then(() => showToast('New pairing code generated'));
    })();
  });

  wrap.append(codeEl, copyBtn, regenBtn);

  function refresh(): void {
    const code = settings.get('pairingOwnCode');
    if (code) {
      codeEl.textContent = code;
      codeEl.classList.remove('pmd-pairing-owncode-empty');
      copyBtn.disabled = false;
      regenBtn.textContent = 'Regenerate';
    } else {
      codeEl.textContent = '(created when you enable collaboration)';
      codeEl.classList.add('pmd-pairing-owncode-empty');
      copyBtn.disabled = true;
      regenBtn.textContent = 'Generate now';
    }
  }
  refresh();
  const unsub = settings.subscribe(refresh);
  registerRowCleanup(wrap, () => unsub());
  return wrap;
}

/** Is this recipient/group the single starred "Send to Starred" target? */
function isStarredTarget(kind: 'partner' | 'group', ref: string): boolean {
  const s = settings.get('pairingStarred');
  return !!s && s.kind === kind && s.ref === ref;
}

/** Star this recipient/group (un-starring whatever was starred), or un-star it
 *  if it's already the target. Setting the single `pairingStarred` value re-fires
 *  both editors' `settings.subscribe`, so the star visibly moves. */
function toggleStarredTarget(kind: 'partner' | 'group', ref: string): void {
  settings.set('pairingStarred', isStarredTarget(kind, ref) ? null : { kind, ref });
}

/** A small star toggle for a recipient/group row. Filled (via CSS) when it's the
 *  current Send-to-Starred target. */
function makeStarButton(starred: boolean, disabled: boolean, onToggle: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pmd-pairing-star';
  btn.setAttribute('aria-pressed', starred ? 'true' : 'false');
  btn.disabled = disabled;
  btn.title = starred
    ? 'Starred — the "Send to Starred" shortcut sends here'
    : 'Star as the "Send to Starred" target';
  btn.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 ' +
    '5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
  btn.addEventListener('click', onToggle);
  return btn;
}

/** Up / down reorder pair for a settings-list row — the Find-category-order
 *  arrow pattern (same button class, disabled at the ends). Reorders the
 *  settings array itself: array order is what the consumer renders (send
 *  pill, tag groups, ribbon custom buttons), so the UI follows
 *  automatically. */
function makeReorderButtons(
  idx: number,
  count: number,
  onSwap: (a: number, b: number) => void,
): HTMLButtonElement[] {
  const make = (dir: 'up' | 'down'): HTMLButtonElement => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-find-category-order-btn';
    setIcon(btn, dir === 'up' ? 'arrow-up' : 'arrow-down');
    btn.title = dir === 'up' ? 'Move up' : 'Move down';
    btn.disabled = dir === 'up' ? idx === 0 : idx === count - 1;
    btn.addEventListener('click', () => onSwap(idx, dir === 'up' ? idx - 1 : idx + 1));
    return btn;
  };
  return [make('up'), make('down')];
}

function buildPairingPartnersEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-pairing-editor';

  const list = document.createElement('div');
  list.className = 'pmd-pairing-list';
  wrap.appendChild(list);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'pmd-readers-add';
  addBtn.textContent = '+ Add recipient';
  wrap.appendChild(addBtn);

  const commit = (partners: PairingPartner[]): void => {
    settings.set('pairingPartners', partners);
  };

  function render(): void {
    list.innerHTML = '';
    const partners = settings.get('pairingPartners');
    if (partners.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pmd-pairing-empty';
      empty.textContent = 'No recipients yet. Add one with the code it shared with you.';
      list.appendChild(empty);
    }
    partners.forEach((partner, idx) => {
      const row = document.createElement('div');
      row.className = 'pmd-pairing-row';

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'pmd-pairing-name';
      nameInput.value = partner.name;
      nameInput.placeholder = 'Name';
      nameInput.addEventListener('change', () => {
        commit(
          settings
            .get('pairingPartners')
            .map((p, i) => (i === idx ? { ...p, name: nameInput.value.trim() } : p)),
        );
      });
      row.appendChild(nameInput);

      const codeInput = document.createElement('input');
      codeInput.type = 'text';
      codeInput.className = 'pmd-pairing-code';
      codeInput.value = partner.code;
      codeInput.placeholder = 'paste their code (cmk1.…)';
      codeInput.spellcheck = false;
      codeInput.autocomplete = 'off';
      codeInput.addEventListener('change', () => {
        const code = normalizePairingCode(codeInput.value);
        codeInput.value = code;
        commit(
          settings.get('pairingPartners').map((p, i) => (i === idx ? { ...p, code } : p)),
        );
      });
      row.appendChild(codeInput);

      for (const b of makeReorderButtons(idx, partners.length, (a, b2) => {
        const cur = settings.get('pairingPartners').slice();
        const tmp = cur[a]!;
        cur[a] = cur[b2]!;
        cur[b2] = tmp;
        commit(cur);
      })) {
        row.appendChild(b);
      }

      // Hide from the Send pill without deleting the contact.
      // Deliberately orthogonal to the star — a hidden starred partner
      // stays one keystroke away via the starred quick-send commands
      // while no longer taking a row in the pill.
      const hide = document.createElement('button');
      hide.type = 'button';
      hide.className = 'pmd-pairing-hide';
      hide.disabled = !partner.code;
      hide.setAttribute('aria-pressed', String(partner.hidden === true));
      hide.title = partner.hidden
        ? 'Hidden from the Send pill. Click to show again.'
        : 'Hide from the Send pill (keeps the contact)';
      hide.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/></svg>';
      hide.addEventListener('click', () => {
        commit(
          settings
            .get('pairingPartners')
            .map((p, i) =>
              i === idx ? { ...p, ...(p.hidden ? { hidden: false } : { hidden: true }) } : p,
            ),
        );
      });
      row.appendChild(hide);
      if (partner.hidden) row.classList.add('pmd-pairing-row-hidden');

      row.appendChild(
        makeStarButton(isStarredTarget('partner', partner.code), !partner.code, () =>
          toggleStarredTarget('partner', partner.code),
        ),
      );

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'pmd-pairing-delete';
      setIcon(delBtn, 'close');
      delBtn.title = 'Remove recipient';
      delBtn.addEventListener('click', () => {
        commit(settings.get('pairingPartners').filter((_, i) => i !== idx));
      });
      row.appendChild(delBtn);

      list.appendChild(row);
    });
  }

  addBtn.addEventListener('click', () => {
    const cur = settings.get('pairingPartners');
    // Placeholder name — the set→sanitize round-trip drops rows with no code and no name.
    commit([...cur, { code: '', name: `Recipient ${cur.length + 1}` }]);
  });

  render();
  const unsub = settings.subscribe(() => render());
  registerRowCleanup(wrap, () => unsub());
  return wrap;
}

/** Custom ribbon buttons editor: up to 10 rows, each choosing an icon + a
 *  command. The ribbon rebuilds live via the settings subscriber. */
function buildRibbonCustomButtonsEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-custom-ribbon-editor';

  const list = document.createElement('div');
  list.className = 'pmd-custom-ribbon-list';
  wrap.appendChild(list);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'pmd-readers-add';
  addBtn.textContent = '+ Add button';
  wrap.appendChild(addBtn);

  const get = (): RibbonCustomButton[] => settings.get('ribbonCustomButtons');
  const commit = (arr: RibbonCustomButton[]): void => {
    settings.set('ribbonCustomButtons', arr as never);
    render();
  };

  // Bindable actions, by label: every ribbon command (with a label), the
  // generated Toggle/Cycle setting commands, and any registered plugin
  // commands (labels from the plugin registry — commandLabelFor resolves
  // both pools), sorted alphabetically. A plugin command's entry exists
  // only while the plugin is enabled; uninstall unconfigures its buttons.
  const options: { value: string; label: string }[] = [
    ...settingCommandOptions().map((o) => ({ value: o.command, label: o.label })),
    ...availableRibbonCommandIds().map((id) => ({
      value: id as string,
      label: commandLabelFor(id),
    })),
  ].sort((a, b) => a.label.localeCompare(b.label));

  function render(): void {
    list.innerHTML = '';
    const buttons = get();
    if (buttons.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pmd-pairing-empty';
      empty.textContent = 'No custom buttons yet. Add one to place it on the ribbon.';
      list.appendChild(empty);
    }
    buttons.forEach((cfg, idx) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'pmd-custom-ribbon-row';

      const preview = document.createElement('span');
      preview.className = 'pmd-custom-ribbon-preview';
      setIcon(preview, cfg.icon);

      const iconSelect = document.createElement('select');
      iconSelect.className = 'pmd-custom-ribbon-icon';
      iconSelect.title = 'Icon';
      for (const name of CUSTOM_BUTTON_ICONS) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        if (name === cfg.icon) opt.selected = true;
        iconSelect.appendChild(opt);
      }
      iconSelect.addEventListener('change', () => {
        setIcon(preview, iconSelect.value as IconName);
        commit(
          get().map((b, i) => (i === idx ? { ...b, icon: iconSelect.value as IconName } : b)),
        );
      });

      const cmdSelect = document.createElement('select');
      cmdSelect.className = 'pmd-custom-ribbon-cmd';
      cmdSelect.title = 'Command';
      // A saved command that's no longer offered (obsolete / gated off on this
      // host) still needs a slot so the row shows it rather than silently
      // snapping to the first option.
      if (cfg.command && !options.some((o) => o.value === cfg.command)) {
        const opt = document.createElement('option');
        opt.value = cfg.command;
        opt.textContent = `${cfg.command} (unavailable)`;
        opt.selected = true;
        cmdSelect.appendChild(opt);
      }
      for (const o of options) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        if (o.value === cfg.command) opt.selected = true;
        cmdSelect.appendChild(opt);
      }
      cmdSelect.addEventListener('change', () => {
        commit(get().map((b, i) => (i === idx ? { ...b, command: cmdSelect.value } : b)));
      });

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'pmd-pairing-delete';
      setIcon(del, 'close');
      del.title = 'Remove button';
      del.addEventListener('click', () => commit(get().filter((_, i) => i !== idx)));

      rowEl.append(preview, iconSelect, cmdSelect);
      // Row order IS ribbon order (column-major, 2 per column), so the
      // reorder arrows move the button on the ribbon itself.
      for (const b of makeReorderButtons(idx, buttons.length, (a, b2) => {
        const arr = [...get()];
        const tmp = arr[a]!;
        arr[a] = arr[b2]!;
        arr[b2] = tmp;
        commit(arr);
      })) {
        rowEl.appendChild(b);
      }
      rowEl.appendChild(del);
      list.appendChild(rowEl);
    });
    addBtn.style.display = buttons.length >= MAX_RIBBON_CUSTOM_BUTTONS ? 'none' : '';
  }

  addBtn.addEventListener('click', () => {
    if (get().length >= MAX_RIBBON_CUSTOM_BUTTONS) return;
    const first = options[0];
    if (!first) return;
    commit([...get(), { command: first.value, icon: CUSTOM_BUTTON_ICONS[0]! }]);
  });

  render();
  return wrap;
}

/** External-apps consent rows (Plugins tab, below the plugin manager):
 *  one row per app that has ever been allowed/denied on the local
 *  bridge, with a decision select and a forget button (forget →
 *  re-prompts on next contact). Registered flow apps upgrade the raw
 *  app id to a friendly "name vVersion" label, best-effort and async.
 *  Empty registry renders a quiet placeholder. */
function buildExternalAppsEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-external-apps-editor';

  function render(): void {
    wrap.innerHTML = '';
    const consents = settings.get('externalAppConsents');
    // Per-app decisions only operate under the "Ask for each app"
    // policy — under Allow all / Block all the rows are kept (the
    // stored decisions come back when the policy does) but greyed
    // and disabled so they don't read as live controls.
    const operative = settings.get('externalInsertPolicy') === 'ask';
    wrap.classList.toggle('pmd-external-apps-inoperative', !operative);
    if (consents.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pmd-pairing-empty';
      empty.textContent = 'No external apps have asked to insert yet.';
      wrap.appendChild(empty);
      return;
    }
    const labels = new Map<string, HTMLElement>();
    for (const consent of consents) {
      const row = document.createElement('div');
      row.className = 'pmd-external-apps-row';

      const label = document.createElement('span');
      label.className = 'pmd-external-apps-name';
      label.textContent = consent.id;
      labels.set(consent.id, label);

      const decision = document.createElement('select');
      decision.className = 'pmd-external-apps-decision';
      decision.title = 'Permission';
      for (const [value, text] of [
        ['allow', 'Allowed'],
        ['deny', 'Denied'],
      ] as const) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = text;
        if (value === consent.decision) opt.selected = true;
        decision.appendChild(opt);
      }
      decision.disabled = !operative;
      decision.addEventListener('change', () => {
        const next = decision.value === 'deny' ? 'deny' : 'allow';
        settings.set(
          'externalAppConsents',
          settings
            .get('externalAppConsents')
            .map((c) => (c.id === consent.id ? { ...c, decision: next } : c)),
        );
      });

      const forget = document.createElement('button');
      forget.type = 'button';
      forget.className = 'pmd-pairing-delete';
      setIcon(forget, 'close');
      forget.title = 'Forget this app (it will ask again next time)';
      forget.disabled = !operative;
      forget.addEventListener('click', () => {
        settings.set(
          'externalAppConsents',
          settings.get('externalAppConsents').filter((c) => c.id !== consent.id),
        );
      });

      row.append(label, decision, forget);
      wrap.appendChild(row);
    }
    // Best-effort friendly names from the bridge's registered identity
    // files ("ebb v0.7.1"); ids without a registration keep the raw id.
    void getElectronHost()
      ?.flowApps?.()
      .then((apps) => {
        for (const raw of apps ?? []) {
          const a = raw as { id?: string; app?: string; appVersion?: string };
          const label = a.id && labels.get(a.id);
          if (label && a.app) {
            label.textContent = a.appVersion ? `${a.app} v${a.appVersion}` : a.app;
          }
        }
      })
      .catch(() => {});
  }

  render();
  // Re-render on any settings change: cheap (a handful of rows), and it
  // keeps the list live when the consent prompt or a bridge lastSeen
  // stamp lands while the dialog is open.
  const unsubscribe = settings.subscribe(() => render());
  registerRowCleanup(wrap, () => unsubscribe());
  return wrap;
}

/** Blocked senders: a list of codes whose cards and room invites are
 *  dropped from the Receive inbox. Two ways to add: paste a code, or block
 *  one of the people who recently shared with you (derived from the inbox).
 *  Codes are self-declared, so this is a convenience filter, not security. */
function buildPairingBlockedEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-pairing-editor';

  const block = (rawCode: string): void => {
    const code = normalizePairingCode(rawCode);
    if (!code) return;
    const cur = settings.get('pairingBlockedCodes');
    if (cur.some((c) => normalizePairingCode(c) === code)) return; // already blocked
    settings.set('pairingBlockedCodes', [...cur, code]);
  };
  const unblock = (rawCode: string): void => {
    const code = normalizePairingCode(rawCode);
    settings.set(
      'pairingBlockedCodes',
      settings.get('pairingBlockedCodes').filter((c) => normalizePairingCode(c) !== code),
    );
  };
  // Your nickname for the code if it's a known recipient, else a short tail.
  const nicknameFor = (code: string): string | null => {
    const partner = settings
      .get('pairingPartners')
      .find((p) => p.code && normalizePairingCode(p.code) === code);
    return partner?.name?.trim() || null;
  };

  // --- Currently blocked ---
  const list = document.createElement('div');
  list.className = 'pmd-pairing-list';
  wrap.appendChild(list);

  // --- Paste-a-code-to-block row ---
  const addRow = document.createElement('div');
  addRow.className = 'pmd-pairing-row';
  const codeInput = document.createElement('input');
  codeInput.type = 'text';
  codeInput.className = 'pmd-pairing-code';
  codeInput.placeholder = 'paste a code to block (cmk1.…)';
  codeInput.spellcheck = false;
  codeInput.autocomplete = 'off';
  const blockBtn = document.createElement('button');
  blockBtn.type = 'button';
  blockBtn.className = 'pmd-readers-add';
  blockBtn.textContent = 'Block';
  const submitCode = (): void => {
    block(codeInput.value);
    codeInput.value = '';
  };
  blockBtn.addEventListener('click', submitCode);
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitCode();
    }
  });
  addRow.appendChild(codeInput);
  addRow.appendChild(blockBtn);
  wrap.appendChild(addRow);

  // --- Recent senders: promoted to a full setting-style block (its own
  //     title + description, same typography as the row labels) — it
  //     stopped being "the list you block from" the day it grew Add:
  //     anyone who recently sent you cards OR a session invite can be
  //     saved as a recipient (and named) right here. ---
  const recentWrap = document.createElement('div');
  recentWrap.className = 'pmd-pairing-recent pmd-pairing-recent-promoted';
  wrap.appendChild(recentWrap);

  function render(): void {
    // Blocked list.
    list.innerHTML = '';
    const blocked = settings.get('pairingBlockedCodes');
    if (blocked.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pmd-pairing-empty';
      empty.textContent = 'No one is blocked. Paste a code, or block a recent sender below.';
      list.appendChild(empty);
    }
    blocked.forEach((code) => {
      const row = document.createElement('div');
      row.className = 'pmd-pairing-row';

      const name = document.createElement('span');
      name.className = 'pmd-pairing-blocked-name';
      const nick = nicknameFor(normalizePairingCode(code));
      name.textContent = nick ?? `…${normalizePairingCode(code).slice(-6)}`;
      row.appendChild(name);

      const codeSpan = document.createElement('span');
      codeSpan.className = 'pmd-pairing-blocked-code';
      codeSpan.textContent = code;
      codeSpan.title = code;
      row.appendChild(codeSpan);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'pmd-pairing-delete';
      setIcon(del, 'close');
      del.title = 'Unblock';
      del.addEventListener('click', () => unblock(code));
      row.appendChild(del);

      list.appendChild(row);
    });

    // Recent senders — from the persistent ledger (already deduped +
    // newest-first), so it includes people whose item is no longer in the
    // inbox: a collaboration invite is consumed on Join, but its sender
    // stays blockable here. Card shares AND invites are covered. Exclude
    // anyone already blocked.
    recentWrap.innerHTML = '';
    const blockedNorm = new Set(
      settings.get('pairingBlockedCodes').map((c) => normalizePairingCode(c)),
    );
    const recents: { code: string; label: string }[] = [];
    for (const r of recentSenders()) {
      const code = normalizePairingCode(r.code);
      if (!code || blockedNorm.has(code)) continue;
      const label = nicknameFor(code) || (r.name || '').trim() || `…${code.slice(-6)}`;
      recents.push({ code: r.code, label });
    }
    // Full-styled section header (same classes as a settings-row label,
    // per the promotion) — shown even when the list is empty so the
    // feature is discoverable.
    const heading = document.createElement('span');
    heading.className = 'pmd-settings-row-head';
    heading.textContent = 'Recent senders';
    recentWrap.appendChild(heading);
    const desc = document.createElement('span');
    desc.className = 'pmd-settings-row-desc';
    desc.textContent =
      'People who recently sent you cards or a session invite. Add one to your ' +
      'recipients (and name them), or block them. Senders you block never appear here.';
    recentWrap.appendChild(desc);
    if (recents.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pmd-pairing-empty';
      empty.textContent = 'No recent senders yet.';
      recentWrap.appendChild(empty);
    }
    recents.forEach(({ code, label }) => {
      const row = document.createElement('div');
      row.className = 'pmd-pairing-row';
      const name = document.createElement('span');
      name.className = 'pmd-pairing-blocked-name';
      name.textContent = label;
      row.appendChild(name);
      const norm = normalizePairingCode(code);
      const already = settings
        .get('pairingPartners')
        .some((p) => p.code && normalizePairingCode(p.code) === norm);
      if (already) {
        const badge = document.createElement('span');
        badge.className = 'pmd-pairing-recent-added';
        badge.textContent = 'In recipients';
        row.appendChild(badge);
      } else {
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'pmd-readers-add';
        add.textContent = 'Add…';
        add.title = 'Add to recipients and name them';
        add.addEventListener('click', () => {
          void (async () => {
            const suggested = /^…/.test(label) ? '' : label;
            const nameFor = await promptForText({
              message: 'Name this recipient',
              detail: 'Shown in the Send pill and on cards you receive from them.',
              initial: suggested,
              placeholder: 'Name',
              okLabel: 'Add',
            });
            if (nameFor == null) return;
            const cur = settings.get('pairingPartners');
            if (cur.some((p) => p.code && normalizePairingCode(p.code) === norm)) return;
            settings.set('pairingPartners', [...cur, { code: norm, name: nameFor.trim() }]);
          })();
        });
        row.appendChild(add);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pmd-readers-add';
      btn.textContent = 'Block';
      btn.addEventListener('click', () => block(code));
      row.appendChild(btn);
      recentWrap.appendChild(row);
    });
  }

  render();
  const unsub = settings.subscribe(() => render());
  const unsubInbox = inboxStore.subscribe(() => render());
  registerRowCleanup(wrap, () => {
    unsub();
    unsubInbox();
  });
  return wrap;
}

/** Groups: a label + a checkbox per partner. Sending to a group fans
 *  the card out to every checked member. */
function buildPairingGroupsEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-pairing-editor';

  const list = document.createElement('div');
  list.className = 'pmd-pairing-group-list';
  wrap.appendChild(list);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'pmd-readers-add';
  addBtn.textContent = '+ Add group';
  wrap.appendChild(addBtn);

  const commit = (groups: PairingGroup[]): void => {
    settings.set('pairingGroups', groups);
  };

  function render(): void {
    list.innerHTML = '';
    const groups = settings.get('pairingGroups');
    const partners = settings.get('pairingPartners').filter((p) => p.code);
    if (groups.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pmd-pairing-empty';
      empty.textContent = 'No groups yet. A group sends one card to several recipients at once.';
      list.appendChild(empty);
    }
    groups.forEach((group, idx) => {
      const card = document.createElement('div');
      card.className = 'pmd-pairing-group';

      const header = document.createElement('div');
      header.className = 'pmd-pairing-group-header';

      const labelInput = document.createElement('input');
      labelInput.type = 'text';
      labelInput.className = 'pmd-pairing-name';
      labelInput.value = group.label;
      labelInput.placeholder = 'Group name';
      labelInput.addEventListener('change', () => {
        commit(
          settings
            .get('pairingGroups')
            .map((g, i) => (i === idx ? { ...g, label: labelInput.value.trim() } : g)),
        );
      });
      header.appendChild(labelInput);

      for (const b of makeReorderButtons(idx, groups.length, (a, b2) => {
        const cur = settings.get('pairingGroups').slice();
        const tmp = cur[a]!;
        cur[a] = cur[b2]!;
        cur[b2] = tmp;
        commit(cur);
      })) {
        header.appendChild(b);
      }

      header.appendChild(
        makeStarButton(isStarredTarget('group', group.id), false, () =>
          toggleStarredTarget('group', group.id),
        ),
      );

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'pmd-pairing-delete';
      setIcon(delBtn, 'close');
      delBtn.title = 'Remove group';
      delBtn.addEventListener('click', () => {
        commit(settings.get('pairingGroups').filter((_, i) => i !== idx));
      });
      header.appendChild(delBtn);
      card.appendChild(header);

      const members = document.createElement('div');
      members.className = 'pmd-pairing-group-members';
      if (partners.length === 0) {
        const hint = document.createElement('span');
        hint.className = 'pmd-pairing-empty';
        hint.textContent = 'Add recipients first, then check who belongs to this group.';
        members.appendChild(hint);
      } else {
        partners.forEach((p) => {
          const memberLabel = document.createElement('label');
          memberLabel.className = 'pmd-pairing-member';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = group.memberCodes.includes(p.code);
          cb.addEventListener('change', () => {
            commit(
              settings.get('pairingGroups').map((g, i) => {
                if (i !== idx) return g;
                const set = new Set(g.memberCodes);
                if (cb.checked) set.add(p.code);
                else set.delete(p.code);
                return { ...g, memberCodes: [...set] };
              }),
            );
          });
          const nameSpan = document.createElement('span');
          nameSpan.textContent = p.name || p.code;
          memberLabel.append(cb, nameSpan);
          members.appendChild(memberLabel);
        });
      }
      card.appendChild(members);
      list.appendChild(card);
    });
  }

  addBtn.addEventListener('click', () => {
    const cur = settings.get('pairingGroups');
    commit([...cur, { id: generateGroupId(), label: `Group ${cur.length + 1}`, memberCodes: [] }]);
  });

  render();
  const unsub = settings.subscribe(() => render());
  registerRowCleanup(wrap, () => unsub());
  return wrap;
}

/** Three-button segmented control for the receive-pill flash behavior,
 *  visually parallel to the reduce-motion / theme editors. */
function buildPairingReceiveFlashEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-theme-editor';
  const options: { value: Settings['pairingReceiveFlash']; label: string }[] = [
    { value: 'once', label: 'Flash once' },
    { value: 'repeat', label: 'Keep flashing' },
    { value: 'off', label: 'Off' },
  ];
  for (const o of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-theme-editor-btn';
    btn.textContent = o.label;
    btn.dataset['value'] = o.value;
    btn.addEventListener('click', () => settings.set('pairingReceiveFlash', o.value));
    wrap.appendChild(btn);
  }
  function refresh(): void {
    const cur = settings.get('pairingReceiveFlash');
    for (const btn of wrap.querySelectorAll<HTMLButtonElement>('.pmd-theme-editor-btn')) {
      btn.setAttribute('aria-pressed', btn.dataset['value'] === cur ? 'true' : 'false');
    }
  }
  refresh();
  const unsub = settings.subscribe(refresh);
  registerRowCleanup(wrap, () => unsub());
  return wrap;
}

/** The trailing glyph each separator renders — mirrors `FORMAT_SEP` in the
 *  numbering plugin, so the dropdown labels read exactly as the numbers will. */
const NUMBERING_SEP_GLYPH: Record<NumberingSeparator, string> = {
  period: '.',
  paren: ')',
  dash: ' -',
  colon: ':',
  emdash: '—',
  endash: '–',
  doublehyphen: '--',
  triplehyphen: '---',
};

/** A separator picker for one numbering level. `sample` is the leading glyph the
 *  options preview against ("1" for numbers, "a" for substructure). */
function buildSeparatorSelect(
  key: 'cardNumberingFormat' | 'cardNumberingSubFormat',
  sample: string,
): HTMLElement {
  const select = document.createElement('select');
  select.className = 'pmd-formatting-panel-mode-select';
  for (const sep of NUMBERING_SEPARATORS) {
    const opt = document.createElement('option');
    opt.value = sep;
    opt.textContent = `${sample}${NUMBERING_SEP_GLYPH[sep]}`;
    if (sep === settings.get(key)) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    settings.set(key as 'cardNumberingFormat', select.value as never);
  });
  return select;
}

function buildCardNumberFormatEditor(): HTMLElement {
  return buildSeparatorSelect('cardNumberingFormat', '1');
}

function buildCardNumberSubFormatEditor(): HTMLElement {
  return buildSeparatorSelect('cardNumberingSubFormat', 'a');
}

function buildIndentSelect(
  key: 'cardNumberingIndent' | 'cardNumberingSubIndent',
): HTMLElement {
  const select = document.createElement('select');
  select.className = 'pmd-formatting-panel-mode-select';
  const options: { value: 'off' | 'tag' | 'card'; label: string }[] = [
    { value: 'off', label: 'No indent' },
    { value: 'tag', label: 'Indent the tag' },
    { value: 'card', label: 'Indent the whole card' },
  ];
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    if (o.value === settings.get(key)) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    settings.set(key as 'cardNumberingIndent', select.value as never);
  });
  return select;
}

function buildCardNumberIndentEditor(): HTMLElement {
  return buildIndentSelect('cardNumberingIndent');
}

function buildCardNumberSubIndentEditor(): HTMLElement {
  return buildIndentSelect('cardNumberingSubIndent');
}

/** Compact color control for the numbering glyphs. Reads/writes
 *  customColorOverrides['pmd-c-card-number'] — the SAME value as the "Card
 *  numbering" swatch under Accessibility → Color overrides — so the two stay
 *  linked. Solid color only (no alpha); numbering glyphs are never translucent. */
function buildCardNumberColorEditor(): HTMLElement {
  const TOKEN = 'pmd-c-card-number';
  const wrap = document.createElement('div');
  wrap.className = 'pmd-inline-color-control';

  const input = document.createElement('input');
  input.type = 'color';
  input.setAttribute('aria-label', 'Numbering color');

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'pmd-color-override-reset';
  setIcon(reset, 'reset');
  reset.title = 'Reset to default';

  // Off-screen probe resolves any CSS color (hex / rgb / var) to rgb — the
  // color input needs #rrggbb regardless of how the value is stored.
  const probe = document.createElement('span');
  probe.style.cssText =
    'position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none';
  document.body.appendChild(probe);

  const toHex = (css: string): string => {
    probe.style.color = '';
    probe.style.color = css || 'var(--pmd-c-card-number)';
    const m = getComputedStyle(probe).color.match(/\d+/g);
    if (!m || m.length < 3) return '#666666';
    const h = (n: string): string =>
      Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, '0');
    return `#${h(m[0]!)}${h(m[1]!)}${h(m[2]!)}`;
  };
  const isOverridden = (): boolean =>
    Object.prototype.hasOwnProperty.call(settings.get('customColorOverrides'), TOKEN);
  const effective = (): string => {
    const ov = settings.get('customColorOverrides');
    return isOverridden()
      ? ov[TOKEN]!
      : getComputedStyle(document.documentElement).getPropertyValue('--' + TOKEN).trim();
  };

  // "Match heading": numbers follow their tag/analytic text color instead of
  // the numbering-color token; the swatch and reset gray out while it's on.
  const matchWrap = document.createElement('label');
  matchWrap.className = 'pmd-inline-color-match';
  const matchBox = document.createElement('input');
  matchBox.type = 'checkbox';
  matchBox.setAttribute('aria-label', 'Match heading color');
  const matchText = document.createElement('span');
  matchText.textContent = 'Match heading';
  matchWrap.appendChild(matchBox);
  matchWrap.appendChild(matchText);
  matchBox.addEventListener('change', () => {
    settings.set('cardNumberingMatchHeadingColor', matchBox.checked);
  });

  function refresh(): void {
    input.value = toHex(effective());
    const matching = settings.get('cardNumberingMatchHeadingColor');
    matchBox.checked = matching;
    input.disabled = matching;
    reset.disabled = matching || !isOverridden();
  }
  input.addEventListener('input', () => {
    settings.set('customColorOverrides', {
      ...settings.get('customColorOverrides'),
      [TOKEN]: input.value,
    });
  });
  reset.addEventListener('click', () => {
    const cur = settings.get('customColorOverrides');
    if (!Object.prototype.hasOwnProperty.call(cur, TOKEN)) return;
    const next = { ...cur };
    delete next[TOKEN];
    settings.set('customColorOverrides', next);
  });

  wrap.appendChild(matchWrap);
  wrap.appendChild(input);
  wrap.appendChild(reset);
  refresh();
  const unsub = settings.subscribe(refresh);
  registerRowCleanup(wrap, () => {
    unsub();
    probe.remove();
  });
  return wrap;
}

function buildExternalInsertPolicyEditor(): HTMLElement {
  const select = document.createElement('select');
  select.className = 'pmd-formatting-panel-mode-select';
  const options: { value: 'ask' | 'open' | 'off'; label: string }[] = [
    { value: 'ask', label: 'Ask for each app' },
    { value: 'open', label: 'Allow all (identification optional)' },
    { value: 'off', label: 'Block all' },
  ];
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    if (o.value === settings.get('externalInsertPolicy')) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    const v = select.value;
    settings.set('externalInsertPolicy', v === 'off' || v === 'open' ? v : 'ask');
  });
  return select;
}

function buildRibbonTooltipModeEditor(): HTMLElement {
  const select = document.createElement('select');
  select.className = 'pmd-formatting-panel-mode-select';
  const options: { value: 'none' | 'tooltip' | 'shortcut' | 'both'; label: string }[] = [
    { value: 'both', label: 'Label and shortcut' },
    { value: 'tooltip', label: 'Label only' },
    { value: 'shortcut', label: 'Shortcut only' },
    { value: 'none', label: 'No tooltips' },
  ];
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    if (o.value === settings.get('ribbonTooltipMode')) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    settings.set('ribbonTooltipMode', select.value as 'none' | 'tooltip' | 'shortcut' | 'both');
  });
  return select;
}

function buildFormattingPanelModeEditor(): HTMLElement {
  const select = document.createElement('select');
  select.className = 'pmd-formatting-panel-mode-select';
  const options: { value: FormattingPanelMode; label: string }[] = [
    { value: 'labels', label: 'Show style names' },
    { value: 'shortcuts', label: 'Show keyboard shortcuts' },
    { value: 'both', label: 'Show name · shortcut' },
    { value: 'hidden', label: 'Hide the panel' },
  ];
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    if (o.value === settings.get('formattingPanelMode')) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    settings.set('formattingPanelMode', select.value as FormattingPanelMode);
  });
  return select;
}

/** Microphone picker for voice control. Options populate async from
 *  enumerateDevices(); labels are blank until some getUserMedia call
 *  has been granted (the first voice session does this), so a generic
 *  "Microphone N" fallback keeps the list usable. */
function buildVoiceInputDeviceEditor(): HTMLElement {
  const select = document.createElement('select');
  select.className = 'pmd-body-font-select'; // shared themed-select style
  const current = settings.get('voiceInputDeviceId');

  const addOption = (value: string, label: string): void => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    opt.selected = value === current;
    select.appendChild(opt);
  };
  addOption('', 'System default');

  if (navigator.mediaDevices?.enumerateDevices) {
    void navigator.mediaDevices.enumerateDevices().then((devices) => {
      let n = 0;
      let sawCurrent = current === '';
      for (const d of devices) {
        if (d.kind !== 'audioinput' || d.deviceId === 'default') continue;
        n += 1;
        addOption(d.deviceId, d.label || `Microphone ${n}`);
        if (d.deviceId === current) sawCurrent = true;
      }
      // A previously-chosen device that's now unplugged still shows,
      // so the user can see (and clear) a stale selection.
      if (!sawCurrent) addOption(current, 'Saved device (not connected)');
    });
  }

  select.addEventListener('change', () => {
    settings.set('voiceInputDeviceId', select.value);
  });
  return select;
}

/** The four dash outputs the custom-dash remapping can target. */
const CUSTOM_DASH_OPTIONS: ReadonlyArray<[Settings['customDashStyle'], string]> = [
  ['en', '– en dash'],
  ['en-spaced', ' – en dash (spaced)'],
  ['em', '— em dash'],
  ['em-spaced', ' — em dash (spaced)'],
];

/** A checkbox enabling the remapping + a trigger dropdown ("---" or
 *  "--") + an output dropdown, both disabled until the checkbox is on:
 *  "Replace [---] with [-- em dash]". */
function buildCustomDashEditor(): HTMLElement {
  const row = document.createElement('label');
  row.className = 'pmd-multi-doc-layout-mode-row';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = settings.get('customDashEnabled');
  const replaceText = document.createElement('span');
  replaceText.className = 'pmd-multi-doc-layout-mode-row-label';
  replaceText.textContent = 'Replace';
  const triggerSelect = document.createElement('select');
  triggerSelect.className = 'pmd-body-font-select';
  for (const value of ['---', '--'] as const) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value;
    opt.selected = value === settings.get('customDashTrigger');
    triggerSelect.appendChild(opt);
  }
  const withText = document.createElement('span');
  withText.className = 'pmd-multi-doc-layout-mode-row-label';
  withText.textContent = 'with';
  const select = document.createElement('select');
  select.className = 'pmd-body-font-select';
  for (const [value, text] of CUSTOM_DASH_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    opt.selected = value === settings.get('customDashStyle');
    select.appendChild(opt);
  }
  triggerSelect.disabled = !cb.checked;
  select.disabled = !cb.checked;
  cb.addEventListener('change', () => {
    settings.set('customDashEnabled', cb.checked);
    triggerSelect.disabled = !cb.checked;
    select.disabled = !cb.checked;
  });
  triggerSelect.addEventListener('change', () => {
    settings.set('customDashTrigger', triggerSelect.value as Settings['customDashTrigger']);
  });
  select.addEventListener('change', () => {
    settings.set('customDashStyle', select.value as Settings['customDashStyle']);
  });
  row.append(cb, replaceText, triggerSelect, withText, select);
  return row;
}

/** Enable checkbox + the user's replacement table: rows of "from → to" with
 *  remove buttons and an add row. CLASH FLAGGING (user requirement,
 *  2026-07-13): adding a key that already exists is REFUSED with an inline
 *  error naming the existing entry — two rebindings of the same input can
 *  never coexist; and rows whose key a char-triggered rule would consume as
 *  it's typed (straight quotes under Smart quotes; hyphen runs under the
 *  active Custom dash trigger) show a non-blocking ⚠ warning, since the
 *  entry can't fire until that feature is toggled off. Warnings are
 *  recomputed on every list render (add/remove and dialog reopen). */
function buildCustomAutocorrectEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-autocorrect-editor';

  const enableRow = document.createElement('label');
  enableRow.className = 'pmd-multi-doc-layout-mode-row';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = settings.get('customAutocorrectEnabled');
  const cbLabel = document.createElement('span');
  cbLabel.className = 'pmd-multi-doc-layout-mode-row-label';
  cbLabel.textContent = 'Replace text as you type';
  enableRow.append(cb, cbLabel);
  wrap.appendChild(enableRow);

  const list = document.createElement('div');
  list.className = 'pmd-autocorrect-list';
  wrap.appendChild(list);

  const addRow = document.createElement('div');
  addRow.className = 'pmd-autocorrect-add-row';
  const fromInput = document.createElement('input');
  fromInput.type = 'text';
  fromInput.placeholder = 'Replace…';
  fromInput.maxLength = 64;
  fromInput.className = 'pmd-autocorrect-input';
  const arrow = document.createElement('span');
  arrow.textContent = '→';
  const toInput = document.createElement('input');
  toInput.type = 'text';
  toInput.placeholder = 'with…';
  toInput.maxLength = 256;
  toInput.className = 'pmd-autocorrect-input pmd-autocorrect-input-to';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'pmd-settings-btn';
  addBtn.textContent = 'Add';
  addRow.append(fromInput, arrow, toInput, addBtn);
  wrap.appendChild(addRow);

  const message = document.createElement('div');
  message.className = 'pmd-autocorrect-message';
  message.hidden = true;
  wrap.appendChild(message);

  const setMessage = (msg: string | null): void => {
    message.hidden = !msg;
    message.textContent = msg ?? '';
  };

  const conflictContext = () => ({
    smartQuotes: settings.get('smartQuotes'),
    customDashEnabled: settings.get('customDashEnabled'),
    customDashTrigger: settings.get('customDashTrigger'),
  });

  function renderList(): void {
    list.textContent = '';
    const entries = settings.get('customAutocorrects');
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pmd-autocorrect-empty';
      empty.textContent = 'No entries yet.';
      list.appendChild(empty);
    }
    const ctx = conflictContext();
    entries.forEach((entry, idx) => {
      const row = document.createElement('div');
      row.className = 'pmd-autocorrect-row';
      const label = document.createElement('span');
      label.className = 'pmd-autocorrect-row-label';
      label.textContent = `${entry.from} → ${entry.to}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'pmd-settings-btn';
      remove.textContent = '✕';
      remove.setAttribute('aria-label', `Remove entry ${entry.from}`);
      remove.addEventListener('click', () => {
        const next = settings.get('customAutocorrects').filter((_, i) => i !== idx);
        settings.set('customAutocorrects', next);
        setMessage(null);
        renderList();
      });
      row.append(label, remove);
      list.appendChild(row);
      for (const warning of entryConflictWarnings(entry.from, ctx)) {
        const warn = document.createElement('div');
        warn.className = 'pmd-autocorrect-warning';
        warn.textContent = `⚠ ${warning}`;
        list.appendChild(warn);
      }
    });
  }

  const syncDisabled = (): void => {
    const off = !cb.checked;
    fromInput.disabled = off;
    toInput.disabled = off;
    addBtn.disabled = off;
    list.classList.toggle('pmd-autocorrect-list-disabled', off);
  };

  addBtn.addEventListener('click', () => {
    const from = fromInput.value.trim();
    const to = toInput.value;
    if (!from || !to) {
      setMessage('Both fields are required.');
      return;
    }
    if (/\s/.test(from)) {
      setMessage(`The "replace" text can't contain spaces.`);
      return;
    }
    const entries = settings.get('customAutocorrects');
    const existing = entries.find((e) => e.from.toLowerCase() === from.toLowerCase());
    if (existing) {
      // Two rebindings of the same input can never coexist — refuse, and
      // name the entry so the user can remove or reconsider it.
      setMessage(
        `An entry for "${existing.from}" already exists (→ ${existing.to}). Remove it first to rebind.`,
      );
      return;
    }
    settings.set('customAutocorrects', [...entries, { from, to }]);
    fromInput.value = '';
    toInput.value = '';
    setMessage(null);
    renderList();
    fromInput.focus();
  });
  cb.addEventListener('change', () => {
    settings.set('customAutocorrectEnabled', cb.checked);
    syncDisabled();
  });

  renderList();
  syncDisabled();
  return wrap;
}

/** Clamped 50–300% / step-10 number input for the default document zoom. */
function buildDefaultZoomEditor(): HTMLElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'pmd-line-height-input';
  input.min = String(ZOOM_MIN_PCT);
  input.max = String(ZOOM_MAX_PCT);
  input.step = '10';
  input.value = String(settings.get('defaultZoomPct'));
  input.addEventListener('change', () => {
    const raw = Math.round(parseFloat(input.value) / 10) * 10;
    const v = Number.isFinite(raw)
      ? Math.max(ZOOM_MIN_PCT, Math.min(ZOOM_MAX_PCT, raw))
      : settings.get('defaultZoomPct');
    settings.set('defaultZoomPct', v);
    input.value = String(v);
  });
  return input;
}

function buildNumberEditor(key: keyof Settings, min = 0): HTMLElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'pmd-line-height-input';
  input.min = String(min);
  input.step = '1';
  input.value = String(settings.get(key));
  input.addEventListener('change', () => {
    const v = Math.max(min, Math.round(parseFloat(input.value)));
    if (!Number.isFinite(v)) {
      input.value = String(settings.get(key));
      return;
    }
    settings.set(key, v as never);
    input.value = String(settings.get(key));
  });
  return input;
}

/** Comma-separated seconds-remaining editor for the timer's alert
 *  points (shared by the visual flash and the audible alerts).
 *  Commit on change; junk entries drop, duplicates collapse, and the
 *  committed value reads back sanitized (sorted descending) so the
 *  field always shows what will actually fire. An entry that
 *  parses to nothing reverts rather than wiping the list. */
function buildTimerFlashSecondsEditor(): HTMLElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'pmd-settings-text';
  input.spellcheck = false;
  input.placeholder = '5, 3, 1';
  const current = (): string => settings.get('timerFlashSeconds').join(', ');
  input.value = current();
  input.addEventListener('change', () => {
    const parsed = [
      ...new Set(
        input.value
          .split(/[\s,;]+/)
          .filter((t) => t.length > 0)
          .map((t) => Math.floor(Number(t)))
          .filter((v) => Number.isFinite(v) && v > 0 && v <= 3600),
      ),
    ]
      .sort((a, b) => b - a)
      .slice(0, 12); // canonicalize here — set() doesn't re-sanitize
    if (parsed.length === 0) {
      input.value = current(); // nothing usable — keep the old list
      return;
    }
    settings.set('timerFlashSeconds', parsed);
    input.value = current(); // read back the canonical list
  });
  return input;
}

function buildVoiceDashStyleEditor(): HTMLElement {
  const select = document.createElement('select');
  select.className = 'pmd-body-font-select';
  const current = settings.get('voiceDashStyle');
  const options: Array<{ value: typeof current; label: string }> = [
    { value: 'em', label: '— em dash (default)' },
    { value: 'em-spaced', label: ' — em dash, spaced' },
    { value: 'en', label: '– en dash' },
    { value: 'en-spaced', label: ' – en dash, spaced' },
    { value: 'hyphen', label: '- hyphen' },
    { value: 'hyphen-spaced', label: ' - hyphen, spaced' },
    { value: 'double', label: '-- double dash' },
    { value: 'double-spaced', label: ' -- double dash, spaced' },
    { value: 'triple', label: '--- triple dash' },
    { value: 'triple-spaced', label: ' --- triple dash, spaced' },
  ];
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    opt.selected = o.value === current;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    settings.set('voiceDashStyle', select.value as typeof current);
  });
  return select;
}

function buildCreateReferenceHighlightModeEditor(): HTMLElement {
  const select = document.createElement('select');
  select.className = 'pmd-body-font-select';
  const current = settings.get('createReferenceHighlightMode');
  const options: Array<{ value: typeof current; label: string }> = [
    { value: 'shading', label: 'Grey background (default)' },
    { value: 'convert', label: 'Background of the same color' },
    { value: 'keep', label: 'Kept as highlights' },
    { value: 'remove', label: 'Removed' },
  ];
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    opt.selected = o.value === current;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    settings.set('createReferenceHighlightMode', select.value as typeof current);
  });
  return select;
}

function buildCreateReferenceDelimiterEditor(): HTMLElement {
  const select = document.createElement('select');
  select.className = 'pmd-body-font-select';
  const current = settings.get('createReferenceDelimiter');
  // Same mirror pairs as "Condense with warning"; each option shows
  // the wrapped heading so the choice reads at a glance.
  const opens: Array<typeof current> = ['[', '[[', '<', '<<', '{', '{{'];
  for (const open of opens) {
    const opt = document.createElement('option');
    opt.value = open;
    opt.textContent = `${open}FOR REFERENCE${condenseWarningCloseFor(open)}`;
    opt.selected = open === current;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    settings.set('createReferenceDelimiter', select.value as typeof current);
  });
  return select;
}

function buildVoiceDictationModelEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-multi-doc-layout-mode-editor';
  const api = (window as unknown as {
    electronAPI?: {
      voiceBaseModelInfo(): Promise<{ present: boolean; downloading: boolean }>;
      voiceDownloadBaseModel(): Promise<{ ok: boolean; error?: string }>;
      voiceDeleteBaseModel(): Promise<{ ok: boolean; error?: string }>;
      voiceDictationModelInfo(): Promise<{ present: boolean; downloading: boolean }>;
      voiceDownloadDictationModel(): Promise<{ ok: boolean; error?: string }>;
      voiceDeleteDictationModel(): Promise<{ ok: boolean; error?: string }>;
      onVoiceDownloadProgress(
        h: (p: { model?: string; pct: number; extracting?: boolean }) => void,
      ): () => void;
    };
  }).electronAPI;

  // Radio choice first (which model voice uses), then the download
  // controls for each below.
  const groupName = `pmd-voice-dict-model-${Math.random().toString(36).slice(2, 8)}`;
  for (const o of [
    { value: 'standard' as const, label: 'Standard' },
    { value: 'large' as const, label: 'Large — better general-English dictation' },
  ]) {
    const row = document.createElement('label');
    row.className = 'pmd-multi-doc-layout-mode-row';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = groupName;
    input.checked = o.value === settings.get('voiceDictationModel');
    input.addEventListener('change', () => {
      if (input.checked) settings.set('voiceDictationModel', o.value);
    });
    const labelText = document.createElement('span');
    labelText.textContent = o.label;
    row.append(input, labelText);
    wrap.appendChild(row);
  }

  // Base (standard) model: the one voice needs to run at all. First-use
  // download, pre-fetchable here (useful before going somewhere with no
  // wifi).
  if (api?.voiceBaseModelInfo) {
    const baseStatus = document.createElement('div');
    baseStatus.className = 'pmd-voice-model-status';
    const baseButton = document.createElement('button');
    baseButton.type = 'button';
    baseButton.className = 'pmd-voice-model-download';
    const baseDeleteBtn = document.createElement('button');
    baseDeleteBtn.type = 'button';
    baseDeleteBtn.className = 'pmd-voice-model-delete';
    baseDeleteBtn.textContent = 'Delete standard model';
    baseDeleteBtn.style.display = 'none';
    wrap.append(baseStatus, baseButton, baseDeleteBtn);
    const refreshBase = async (): Promise<void> => {
      const info = await api.voiceBaseModelInfo();
      if (info.present) {
        baseStatus.textContent = 'Standard model downloaded ✓';
        baseButton.style.display = 'none';
        baseDeleteBtn.style.display = '';
      } else {
        baseStatus.textContent = info.downloading
          ? 'Downloading standard model…'
          : 'Standard model not downloaded.';
        baseButton.style.display = info.downloading ? 'none' : '';
        baseButton.textContent = 'Download standard model (~130 MB)';
        baseDeleteBtn.style.display = 'none';
      }
    };
    void refreshBase();
    baseDeleteBtn.addEventListener('click', () => {
      void confirmDialog(
        "Delete the standard voice model? Voice control won't work until you download it again.",
        { okLabel: 'Delete' },
      ).then((go) => {
        if (!go) return;
        baseDeleteBtn.style.display = 'none';
        baseStatus.textContent = 'Deleting…';
        void api.voiceDeleteBaseModel().then((res) => {
          if (!res.ok) baseStatus.textContent = `Delete failed: ${res.error ?? 'unknown'}`;
          void refreshBase();
        });
      });
    });
    baseButton.addEventListener('click', () => {
      baseButton.style.display = 'none';
      const unsub = api.onVoiceDownloadProgress((p) => {
        if (p.model && p.model !== 'base-model') return;
        baseStatus.textContent = p.extracting ? 'Extracting…' : `Downloading… ${p.pct}%`;
      });
      void api.voiceDownloadBaseModel().then((res) => {
        unsub();
        if (!res.ok) baseStatus.textContent = `Download failed: ${res.error ?? 'unknown'}`;
        void refreshBase();
      });
    });
  }

  const status = document.createElement('div');
  status.className = 'pmd-voice-model-status';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pmd-voice-model-download';
  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'pmd-voice-model-delete';
  deleteButton.textContent = 'Delete large model';
  deleteButton.style.display = 'none';
  wrap.append(status, button, deleteButton);

  const refresh = async (): Promise<void> => {
    if (!api) {
      status.textContent = 'Desktop only.';
      button.style.display = 'none';
      deleteButton.style.display = 'none';
      return;
    }
    const info = await api.voiceDictationModelInfo();
    if (info.present) {
      status.textContent = 'Large model downloaded ✓';
      button.style.display = 'none';
      deleteButton.style.display = '';
    } else {
      status.textContent = info.downloading ? 'Downloading…' : 'Large model not downloaded.';
      button.style.display = info.downloading ? 'none' : '';
      button.textContent = 'Download large model (1.8 GB)';
      deleteButton.style.display = 'none';
    }
  };
  void refresh();

  deleteButton.addEventListener('click', () => {
    if (!api) return;
    void confirmDialog(
      'Delete the large dictation model (1.8 GB)? Voice will fall back to the standard model.',
      { okLabel: 'Delete' },
    ).then((go) => {
      if (!go) return;
      deleteButton.style.display = 'none';
      status.textContent = 'Deleting…';
      void api.voiceDeleteDictationModel().then((res) => {
        if (!res.ok) status.textContent = `Delete failed: ${res.error ?? 'unknown'}`;
        void refresh();
      });
    });
  });

  button.addEventListener('click', () => {
    if (!api) return;
    button.style.display = 'none';
    const unsub = api.onVoiceDownloadProgress((p) => {
      // Shared progress channel — ignore base-model / node-runtime ticks.
      if (p.model && p.model !== 'large-model') {
        if (p.model === 'node-runtime') status.textContent = 'Downloading runtime…';
        return;
      }
      status.textContent = p.extracting ? 'Extracting…' : `Downloading… ${p.pct}%`;
    });
    void api.voiceDownloadDictationModel().then((res) => {
      unsub();
      if (!res.ok) status.textContent = `Download failed: ${res.error ?? 'unknown'}`;
      void refresh();
    });
  });
  return wrap;
}

function buildFileSearchFormatsEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-multi-doc-layout-mode-editor';
  const options: { value: 'both' | 'cmir' | 'docx'; label: string }[] = [
    { value: 'both', label: 'Both .cmir and .docx (default)' },
    { value: 'cmir', label: '.cmir only' },
    { value: 'docx', label: '.docx only' },
  ];
  const groupName = `pmd-file-search-formats-${Math.random().toString(36).slice(2, 8)}`;
  const inputs: HTMLInputElement[] = [];
  for (const o of options) {
    const row = document.createElement('label');
    row.className = 'pmd-multi-doc-layout-mode-row';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = groupName;
    input.value = o.value;
    input.checked = o.value === settings.get('fileSearchFormats');
    input.addEventListener('change', () => {
      if (input.checked) settings.set('fileSearchFormats', o.value);
    });
    inputs.push(input);
    row.appendChild(input);
    const labelText = document.createElement('span');
    labelText.className = 'pmd-multi-doc-layout-mode-row-label';
    labelText.textContent = o.label;
    row.appendChild(labelText);
    wrap.appendChild(row);
  }
  // Re-sync if the value changes elsewhere while the panel is open.
  const unsub = settings.subscribe(() => {
    const cur = settings.get('fileSearchFormats');
    for (const input of inputs) input.checked = input.value === cur;
  });
  registerRowCleanup(wrap, () => unsub());
  return wrap;
}

function buildSpeechDocFormatEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-multi-doc-layout-mode-editor';
  const options: { value: 'docx' | 'cmir'; label: string }[] = [
    { value: 'docx', label: '.docx — Verbatim-compatible (default)' },
    { value: 'cmir', label: '.cmir — CardMirror native (enables autosave)' },
  ];
  const groupName = `pmd-speech-doc-format-${Math.random().toString(36).slice(2, 8)}`;
  for (const o of options) {
    const row = document.createElement('label');
    row.className = 'pmd-multi-doc-layout-mode-row';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = groupName;
    input.value = o.value;
    input.checked = o.value === settings.get('defaultSpeechDocFormat');
    input.addEventListener('change', () => {
      if (input.checked) settings.set('defaultSpeechDocFormat', o.value);
    });
    row.appendChild(input);
    const labelText = document.createElement('span');
    labelText.className = 'pmd-multi-doc-layout-mode-row-label';
    labelText.textContent = o.label;
    row.appendChild(labelText);
    wrap.appendChild(row);
  }
  return wrap;
}

/** Template text box plus a live preview. The preview matters more
 *  than usual here: the template has a syntax, and without a preview
 *  the user only discovers a typo at the moment they create a doc
 *  mid-round. Input event, not change, so it updates per keystroke. */
function buildSpeechFilenameTemplateEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-speech-filename-editor';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'pmd-settings-text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.value = settings.get('speechDocFilenameTemplate');

  const preview = document.createElement('div');
  preview.className = 'pmd-speech-filename-preview';
  // A screen reader should hear the corrected preview, not each
  // intermediate keystroke.
  preview.setAttribute('aria-live', 'polite');

  // A fixed sample, not the real clock: the preview must not shift
  // under the user while they type.
  const SAMPLE_SPEECH = '1NC';
  const SAMPLE_DATE = new Date(2026, 3, 12, 19, 5, 7);

  const refresh = () => {
    const template = input.value.trim() || DEFAULT_SPEECH_FILENAME_TEMPLATE;
    preview.textContent = `Example: ${renderSpeechFilename(
      template,
      SAMPLE_SPEECH,
      settings.get('defaultSpeechDocFormat'),
      SAMPLE_DATE,
    )}`;
  };
  refresh();

  input.addEventListener('input', refresh);
  input.addEventListener('change', () => {
    // Blank reverts to the default rather than storing an empty
    // template. `sanitize` enforces the same rule on load.
    const next = input.value.trim() || DEFAULT_SPEECH_FILENAME_TEMPLATE;
    input.value = next;
    settings.set('speechDocFilenameTemplate', next);
    refresh();
  });

  // Keep the preview honest when the format radio above changes,
  // since the extension comes from that setting.
  const unsub = settings.subscribe(() => {
    const cur = settings.get('speechDocFilenameTemplate');
    if (document.activeElement !== input && input.value !== cur) {
      input.value = cur;
    }
    refresh();
  });
  registerRowCleanup(wrap, () => unsub());

  wrap.appendChild(input);
  wrap.appendChild(preview);
  return wrap;
}

/** Color editor: a free `<input type="color">` plus a row of
 *  preset swatches for the 15 OOXML highlight colors. Picking a
 *  preset writes its canonical hex into the setting and updates
 *  the free picker; using the free picker leaves the preset
 *  selection unhighlighted. Reads / writes the hex value (with
 *  leading `#`) directly via the settings store. */
function buildColorEditor(key: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-color-editor';
  const get = () => settings.get(key as keyof Settings) as string;
  const set = (v: string) => settings.set(key as keyof Settings, v as never);

  const top = document.createElement('div');
  top.className = 'pmd-color-editor-row';
  const input = document.createElement('input');
  input.type = 'color';
  input.className = 'pmd-color-editor-input';
  input.value = get();
  top.appendChild(input);
  const hex = document.createElement('span');
  hex.className = 'pmd-color-editor-hex';
  hex.textContent = input.value;
  top.appendChild(hex);
  wrap.appendChild(top);

  // Preset row: the 15 Word highlight colors as quick-pick swatches.
  const presets = document.createElement('div');
  presets.className = 'pmd-color-editor-presets';
  const swatchButtons: { btn: HTMLButtonElement; hex: string }[] = [];
  for (const c of WORD_HIGHLIGHT_COLORS) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'pmd-color-editor-swatch';
    sw.style.background = `#${c.rgb}`;
    sw.title = c.label;
    sw.setAttribute('aria-label', c.label);
    const hexValue = `#${c.rgb.toLowerCase()}`;
    sw.addEventListener('click', () => {
      set(hexValue);
      input.value = hexValue;
      hex.textContent = hexValue;
      refreshActive();
    });
    presets.appendChild(sw);
    swatchButtons.push({ btn: sw, hex: hexValue });
  }
  wrap.appendChild(presets);

  function refreshActive(): void {
    const current = get().toLowerCase();
    for (const { btn, hex } of swatchButtons) {
      btn.classList.toggle('pmd-color-editor-swatch-active', hex === current);
    }
  }

  input.addEventListener('input', () => {
    set(input.value);
    hex.textContent = input.value;
    refreshActive();
  });

  refreshActive();
  return wrap;
}

/** Highlighting-exception editor: a swatch row of Word's 15 named
 *  highlight colors (highlight marks can only be one of these) plus
 *  a label naming the current pick. Stores the OOXML color name. */
function buildHighlightExceptionEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-color-editor';

  const top = document.createElement('div');
  top.className = 'pmd-color-editor-row';
  const label = document.createElement('span');
  label.className = 'pmd-color-editor-hex';
  top.appendChild(label);
  wrap.appendChild(top);

  const presets = document.createElement('div');
  presets.className = 'pmd-color-editor-presets';
  const swatchButtons: { btn: HTMLButtonElement; name: string }[] = [];
  for (const c of WORD_HIGHLIGHT_COLORS) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'pmd-color-editor-swatch';
    sw.style.background = `#${c.rgb}`;
    sw.title = c.label;
    sw.setAttribute('aria-label', c.label);
    sw.addEventListener('click', () => {
      settings.set('standardizeHighlightException', c.name);
      refresh();
    });
    presets.appendChild(sw);
    swatchButtons.push({ btn: sw, name: c.name });
  }
  wrap.appendChild(presets);

  function refresh(): void {
    const current = settings.get('standardizeHighlightException');
    label.textContent = highlightColorLabel(current);
    for (const { btn, name } of swatchButtons) {
      btn.classList.toggle('pmd-color-editor-swatch-active', name === current);
    }
  }

  refresh();
  return wrap;
}

/** Background-color-exception editor: same shape as the free color
 *  editor (picker + preset swatches) but stores a bare uppercase hex
 *  (matching the shading mark's attr) and adds a Protected Grey
 *  swatch after the shading palette. */
function buildShadingExceptionEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-color-editor';
  const get = () => settings.get('standardizeShadingException');
  const set = (v: string) =>
    settings.set('standardizeShadingException', v.replace(/^#/, '').toUpperCase());

  const top = document.createElement('div');
  top.className = 'pmd-color-editor-row';
  const input = document.createElement('input');
  input.type = 'color';
  input.className = 'pmd-color-editor-input';
  input.value = `#${get().toLowerCase()}`;
  top.appendChild(input);
  const label = document.createElement('span');
  label.className = 'pmd-color-editor-hex';
  top.appendChild(label);
  wrap.appendChild(top);

  const presets = document.createElement('div');
  presets.className = 'pmd-color-editor-presets';
  const swatchButtons: { btn: HTMLButtonElement; hex: string }[] = [];
  const swatchColors = [
    ...WORD_SHADING_COLORS,
    { name: 'protectedGrey', rgb: 'D2D2D2', label: 'Protected Grey' },
  ];
  for (const c of swatchColors) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'pmd-color-editor-swatch';
    sw.style.background = `#${c.rgb}`;
    sw.title = c.label;
    sw.setAttribute('aria-label', c.label);
    sw.addEventListener('click', () => {
      set(c.rgb);
      input.value = `#${c.rgb.toLowerCase()}`;
      refresh();
    });
    presets.appendChild(sw);
    swatchButtons.push({ btn: sw, hex: c.rgb.toUpperCase() });
  }
  wrap.appendChild(presets);

  function refresh(): void {
    const current = get();
    label.textContent = shadingColorLabel(current);
    for (const { btn, hex } of swatchButtons) {
      btn.classList.toggle('pmd-color-editor-swatch-active', hex === current);
    }
  }

  input.addEventListener('input', () => {
    set(input.value);
    refresh();
  });

  refresh();
  return wrap;
}

/** Theme selector — light / dark / system. Renders as a small
 *  segmented control. */
function buildThemeEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-theme-editor';
  const options: { value: 'light' | 'dark' | 'system'; label: string }[] = [
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
    { value: 'system', label: 'System' },
  ];
  for (const o of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-theme-editor-btn';
    btn.textContent = o.label;
    btn.dataset['value'] = o.value;
    btn.addEventListener('click', () => settings.set('theme', o.value));
    wrap.appendChild(btn);
  }
  function refresh(): void {
    const cur = settings.get('theme');
    for (const btn of wrap.querySelectorAll<HTMLButtonElement>('.pmd-theme-editor-btn')) {
      btn.setAttribute('aria-pressed', btn.dataset['value'] === cur ? 'true' : 'false');
    }
  }
  refresh();
  const unsub = settings.subscribe(refresh);
  registerRowCleanup(wrap, () => unsub());
  return wrap;
}

/** Profile picker for the built-in timer. Each profile carries
 *  its own saved durations (see `timerProfiles` in settings);
 *  picking a profile loads that profile's saved
 *  `speechPresets` + `prepMinutes` into the live settings and
 *  refills the prep clocks. */
function buildTimerProfileEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-theme-editor';
  const options: { value: Settings['timerProfile']; label: string }[] = [
    { value: 'highSchool', label: 'High school' },
    { value: 'college', label: 'College' },
    { value: 'pomodoro', label: 'Pomodoro' },
  ];
  for (const o of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-theme-editor-btn';
    btn.textContent = o.label;
    btn.dataset['value'] = o.value;
    btn.addEventListener('click', () => {
      // Shared with the Cycle Timer Preset command — applies the profile's saved
      // durations to the live settings and refills the prep clocks.
      applyTimerProfile(o.value);
    });
    wrap.appendChild(btn);
  }
  function refresh(): void {
    const cur = settings.get('timerProfile');
    for (const btn of wrap.querySelectorAll<HTMLButtonElement>('.pmd-theme-editor-btn')) {
      btn.setAttribute('aria-pressed', btn.dataset['value'] === cur ? 'true' : 'false');
    }
  }
  refresh();
  const unsub = settings.subscribe(refresh);
  registerRowCleanup(wrap, () => unsub());
  return wrap;
}

/** Inline number-input editor for the active profile's three
 *  speech-preset durations + per-side prep total. Edits write
 *  to BOTH the live setting (`timerSpeechPresets` /
 *  `timerPrepMinutes`) AND the active profile's saved slot
 *  inside `timerProfiles`, so switching to another profile and
 *  back picks the user's customization up again. */
function buildTimerProfileDurationsEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-timer-durations-editor';

  function makeField(label: string, getValue: () => number, onChange: (v: number) => void): HTMLElement {
    const field = document.createElement('label');
    field.className = 'pmd-timer-durations-field';
    const labelEl = document.createElement('span');
    labelEl.className = 'pmd-timer-durations-label';
    labelEl.textContent = label;
    field.appendChild(labelEl);
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.max = '99';
    input.step = '1';
    input.className = 'pmd-timer-durations-input';
    input.dataset['label'] = label;
    input.value = String(getValue());
    input.addEventListener('input', () => {
      const v = parseInt(input.value, 10);
      if (!Number.isFinite(v) || v < 0 || v > 99) return;
      onChange(v);
    });
    field.appendChild(input);
    const unit = document.createElement('span');
    unit.className = 'pmd-timer-durations-unit';
    unit.textContent = 'min';
    field.appendChild(unit);
    return field;
  }

  function buildFields(): void {
    wrap.innerHTML = '';
    const active = settings.get('timerProfile');
    const profileCfg = settings.get('timerProfiles')[active];
    const presets = profileCfg.speechPresets;
    // The fourth field appears only while the fourth preset button is
    // enabled — an input for a button that isn't shown would read as
    // broken.
    const presetCount = settings.get('timerShowFourthPreset') ? 4 : 3;
    for (let i = 0; i < presetCount; i++) {
      const labels = ['Preset 1', 'Preset 2', 'Preset 3', 'Preset 4'];
      const field = makeField(
        labels[i]!,
        () => presets[i] ?? 0,
        (v) => {
          const profiles = { ...settings.get('timerProfiles') };
          const cur = profiles[active];
          const nextPresets = cur.speechPresets.slice();
          nextPresets[i] = v;
          profiles[active] = { ...cur, speechPresets: nextPresets };
          settings.set('timerProfiles', profiles);
          settings.set('timerSpeechPresets', nextPresets as never);
        },
      );
      wrap.appendChild(field);
    }
    const prepField = makeField(
      'Prep',
      () => profileCfg.prepMinutes,
      (v) => {
        const profiles = { ...settings.get('timerProfiles') };
        const cur = profiles[active];
        profiles[active] = { ...cur, prepMinutes: v };
        settings.set('timerProfiles', profiles);
        settings.set('timerPrepMinutes', v);
        // Prep-total change refills the live prep clocks (same
        // semantics as the profile-switch case).
        resetTimer(v * 60 * 1000);
      },
    );
    wrap.appendChild(prepField);
  }

  buildFields();
  // Rebuild ONLY when the active profile changes, to show that profile's saved
  // durations. We must NOT rebuild on every settings change: each keystroke in a
  // field calls settings.set, and a full rebuild here would destroy the focused
  // input mid-entry (you couldn't type past one digit). Same-profile value
  // edits already display what the user typed, so no rebuild is needed.
  let lastProfile = settings.get('timerProfile');
  let lastFourth = settings.get('timerShowFourthPreset');
  const unsub = settings.subscribe(() => {
    const active = settings.get('timerProfile');
    const fourth = settings.get('timerShowFourthPreset');
    // The fourth-preset toggle also re-fields the row (it's a
    // checkbox elsewhere in the modal, never the focused input, so
    // the destroy-while-typing hazard above doesn't apply to it).
    if (active === lastProfile && fourth === lastFourth) return;
    lastProfile = active;
    lastFourth = fourth;
    buildFields();
  });
  registerRowCleanup(wrap, () => unsub());
  return wrap;
}

/** All six "Enter after a …" choices in one row: a labeled dropdown
 *  per structural style, sharing the single row description. Reuses
 *  the display-sizes 2-column grid and the body-font select styling
 *  (already shared with the translation language selects). */
type EnterAfterStyleKey =
  | 'enterAfterPocket'
  | 'enterAfterHat'
  | 'enterAfterBlock'
  | 'enterAfterTag'
  | 'enterAfterAnalytic'
  | 'enterAfterUndertag';
function buildEnterAfterStyleEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-display-sizes-editor pmd-enter-style-editor';
  const fields: { key: EnterAfterStyleKey; label: string }[] = [
    { key: 'enterAfterPocket', label: 'After a Pocket' },
    { key: 'enterAfterHat', label: 'After a Hat' },
    { key: 'enterAfterBlock', label: 'After a Block' },
    { key: 'enterAfterTag', label: 'After a Tag' },
    { key: 'enterAfterAnalytic', label: 'After an Analytic' },
    { key: 'enterAfterUndertag', label: 'After an Undertag' },
  ];
  const options: { value: Settings[EnterAfterStyleKey]; label: string }[] = [
    { value: 'normal', label: 'Normal paragraph' },
    { value: 'pocket', label: 'Pocket' },
    { value: 'hat', label: 'Hat' },
    { value: 'block', label: 'Block' },
    { value: 'tag', label: 'Tag' },
    { value: 'analytic', label: 'Analytic' },
    { value: 'undertag', label: 'Undertag' },
  ];
  const selects: [EnterAfterStyleKey, HTMLSelectElement][] = [];
  for (const f of fields) {
    const row = document.createElement('div');
    row.className = 'pmd-display-size-row';
    const label = document.createElement('label');
    label.className = 'pmd-display-size-label';
    label.textContent = f.label;
    row.appendChild(label);
    const select = document.createElement('select');
    select.className = 'pmd-body-font-select';
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      select.appendChild(opt);
    }
    select.value = settings.get(f.key);
    select.addEventListener('change', () => {
      settings.set(f.key, select.value as Settings[EnterAfterStyleKey]);
    });
    row.appendChild(select);
    selects.push([f.key, select]);
    wrap.appendChild(row);
  }
  const unsub = settings.subscribe(() => {
    for (const [key, select] of selects) select.value = settings.get(key);
  });
  registerRowCleanup(wrap, () => unsub());
  return wrap;
}

/** Two-button segmented control for which ribbon edge the timer
 *  panel occupies. Same visual language as the prep-label control. */
function buildTimerPositionEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-theme-editor';
  const options: { value: Settings['timerPosition']; label: string }[] = [
    { value: 'left', label: 'Far left' },
    { value: 'right', label: 'Far right' },
  ];
  for (const o of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-theme-editor-btn';
    btn.textContent = o.label;
    btn.dataset['value'] = o.value;
    btn.addEventListener('click', () => settings.set('timerPosition', o.value));
    wrap.appendChild(btn);
  }
  function refresh(): void {
    const cur = settings.get('timerPosition');
    for (const btn of wrap.querySelectorAll<HTMLButtonElement>('.pmd-theme-editor-btn')) {
      btn.setAttribute('aria-pressed', btn.dataset['value'] === cur ? 'true' : 'false');
    }
  }
  refresh();
  const unsub = settings.subscribe(refresh);
  registerRowCleanup(wrap, () => unsub());
  return wrap;
}

/** Three-button segmented control for the Aff / Neg prep-button
 *  label style: text-only, color-only, or both. */
function buildTimerPrepLabelEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-theme-editor';
  const options: { value: Settings['timerPrepLabel']; label: string }[] = [
    { value: 'both', label: 'Both' },
    { value: 'text', label: 'Text only' },
    { value: 'color', label: 'Color only' },
  ];
  for (const o of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-theme-editor-btn';
    btn.textContent = o.label;
    btn.dataset['value'] = o.value;
    btn.addEventListener('click', () => settings.set('timerPrepLabel', o.value));
    wrap.appendChild(btn);
  }
  function refresh(): void {
    const cur = settings.get('timerPrepLabel');
    for (const btn of wrap.querySelectorAll<HTMLButtonElement>('.pmd-theme-editor-btn')) {
      btn.setAttribute('aria-pressed', btn.dataset['value'] === cur ? 'true' : 'false');
    }
  }
  refresh();
  const unsub = settings.subscribe(refresh);
  registerRowCleanup(wrap, () => unsub());
  return wrap;
}

/** Two-button segmented control for the `iconSet` setting, visually
 *  parallel to the theme editor. Modern (Untitled UI) / Classic (emoji). */
function buildIconSetEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-theme-editor';
  const options: { value: 'modern' | 'classic'; label: string }[] = [
    { value: 'modern', label: 'Modern' },
    { value: 'classic', label: 'Classic' },
  ];
  for (const o of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-theme-editor-btn';
    btn.textContent = o.label;
    btn.dataset['value'] = o.value;
    btn.addEventListener('click', () => settings.set('iconSet', o.value));
    wrap.appendChild(btn);
  }
  function refresh(): void {
    const cur = settings.get('iconSet');
    for (const btn of wrap.querySelectorAll<HTMLButtonElement>('.pmd-theme-editor-btn')) {
      btn.setAttribute('aria-pressed', btn.dataset['value'] === cur ? 'true' : 'false');
    }
  }
  refresh();
  const unsub = settings.subscribe(refresh);
  registerRowCleanup(wrap, () => unsub());
  return wrap;
}

/** Desktop-only toggle for Chromium's renderer accessibility tree (screen-reader
 *  support). Default off because building that tree currently crashes the window
 *  (a Chromium AX bug). The authoritative value is a main-process pref read at
 *  startup; this reads/writes it via the electron host and prompts a restart,
 *  since the `--disable-renderer-accessibility` switch only applies at process
 *  start. The synced `accessibilityTreeEnabled` setting is a display mirror, kept
 *  reconciled to the pref here. */
function buildAccessibilityRendererEditor(): HTMLElement {
  const wrap = document.createElement('div');

  // Off / On segmented control, visually consistent with the other multi-option
  // settings (theme, icon set, reduce motion).
  const seg = document.createElement('div');
  seg.className = 'pmd-theme-editor';
  const options: { value: boolean; label: string }[] = [
    { value: false, label: 'Off' },
    { value: true, label: 'On' },
  ];
  const electron = getElectronHost();

  function applyChange(enabled: boolean): void {
    if (enabled === !!settings.get('accessibilityTreeEnabled')) return; // no change
    settings.set('accessibilityTreeEnabled', enabled as never);
    if (!electron) return;
    void electron.setAccessibilityTreeEnabled(enabled).then(async () => {
      // The Chromium switch only applies at process start, so this needs a full
      // app restart. Offer to do it now; otherwise it applies next launch.
      const restartNow = await confirmDialog(
        `Screen reader support will turn ${enabled ? 'on' : 'off'} after CardMirror restarts. Restart now?`,
        { okLabel: 'Restart' },
      );
      if (restartNow) {
        void electron.relaunchApp();
      } else {
        showToast(
          `Restart CardMirror to ${enabled ? 'enable' : 'disable'} screen reader support.`,
        );
      }
    });
  }

  for (const o of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-theme-editor-btn';
    btn.textContent = o.label;
    btn.dataset['value'] = String(o.value);
    btn.addEventListener('click', () => applyChange(o.value));
    seg.appendChild(btn);
  }
  wrap.appendChild(seg);

  // Restart-pending notice: shown only when the selection differs from what's
  // actually applied this session (compares the saved choice to the value
  // main read at startup), so the user knows a restart is still needed.
  const status = document.createElement('div');
  status.className = 'pmd-settings-row-desc';
  wrap.appendChild(status);
  let appliedState: boolean | null = null;

  // Dynamic hint: whether an assistive-tech client is currently active on this
  // device (i.e. enabling support would re-activate the known crash).
  const hint = document.createElement('div');
  hint.className = 'pmd-settings-row-desc';
  wrap.appendChild(hint);

  function refresh(): void {
    const cur = !!settings.get('accessibilityTreeEnabled');
    for (const btn of seg.querySelectorAll<HTMLButtonElement>('.pmd-theme-editor-btn')) {
      btn.setAttribute('aria-pressed', btn.dataset['value'] === String(cur) ? 'true' : 'false');
    }
    // Only surface a status when a restart is pending (the selection differs
    // from what's applied this session); stay quiet when they already match.
    status.textContent =
      appliedState !== null && appliedState !== cur
        ? cur
          ? 'Restart CardMirror to turn screen reader support on.'
          : 'Restart CardMirror to turn screen reader support off.'
        : '';
  }

  if (electron) {
    // Reconcile the displayed value with the authoritative main-process pref.
    void electron.getAccessibilityTreeEnabled().then((enabled) => {
      if (!!settings.get('accessibilityTreeEnabled') !== enabled) {
        settings.set('accessibilityTreeEnabled', enabled as never);
      }
      refresh();
    });
    // The state actually applied this session (drives the "Currently on/off" +
    // "restart to apply" status above).
    void electron.getAccessibilityTreeApplied().then((a) => {
      appliedState = a;
      refresh();
    });
    void electron.isAccessibilitySupportActive().then((active) => {
      hint.textContent = active
        ? 'An accessibility tool is active on this device — turning support on would re-activate the known crash.'
        : '';
    });
  }

  refresh();
  const unsub = settings.subscribe(refresh);
  registerRowCleanup(wrap, () => unsub());
  return wrap;
}

/** Three-button segmented control for the `reduceMotion` setting,
 *  visually parallel to the theme editor. System / On / Off. */
function buildReduceMotionEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-theme-editor';
  const options: { value: 'auto' | 'on' | 'off'; label: string }[] = [
    { value: 'auto', label: 'System' },
    { value: 'on', label: 'On' },
    { value: 'off', label: 'Off' },
  ];
  for (const o of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-theme-editor-btn';
    btn.textContent = o.label;
    btn.dataset['value'] = o.value;
    btn.addEventListener('click', () => settings.set('reduceMotion', o.value));
    wrap.appendChild(btn);
  }
  function refresh(): void {
    const cur = settings.get('reduceMotion');
    for (const btn of wrap.querySelectorAll<HTMLButtonElement>('.pmd-theme-editor-btn')) {
      btn.setAttribute('aria-pressed', btn.dataset['value'] === cur ? 'true' : 'false');
    }
  }
  refresh();
  const unsub = settings.subscribe(refresh);
  registerRowCleanup(wrap, () => unsub());
  return wrap;
}

/** Ordered list of 1-3 color slots for the highlight / shading
 *  display overrides. Slot 0 maps to the most-common source
 *  color in the doc, slot 1 to the second-most-common, and the
 *  last slot doubles as the "everything else" catch-all. Frequency
 *  ranking happens in the highlight-frequency plugin; this UI
 *  just owns the values.
 *
 *  Renders as a stack of color pickers; the user can grow / shrink
 *  the list with `+ Add slot` / trash buttons. The last slot's
 *  trash is disabled (always at least one). */
function buildColorSlotsEditor(key: keyof Settings): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-color-slots-editor';

  const get = (): string[] => settings.get(key) as string[];
  const set = (slots: string[]) => settings.set(key, slots as never);

  function render(): void {
    wrap.innerHTML = '';
    const slots = get();
    for (let i = 0; i < slots.length; i++) {
      const row = document.createElement('div');
      row.className = 'pmd-color-slot-row';
      const rank = document.createElement('span');
      rank.className = 'pmd-color-slot-rank';
      // Last slot's caption clarifies it's the catch-all when N > 1.
      const isLast = i === slots.length - 1;
      const isOnly = slots.length === 1;
      if (isOnly) rank.textContent = '1';
      else if (isLast) rank.textContent = `${i + 1} · catch-all`;
      else rank.textContent = `${i + 1}`;
      row.appendChild(rank);
      const input = document.createElement('input');
      input.type = 'color';
      input.className = 'pmd-color-slot-input';
      input.value = slots[i]!;
      input.addEventListener('input', () => {
        const next = get().slice();
        next[i] = input.value;
        set(next);
      });
      row.appendChild(input);
      const hex = document.createElement('span');
      hex.className = 'pmd-color-slot-hex';
      hex.textContent = slots[i]!;
      input.addEventListener('input', () => {
        hex.textContent = input.value;
      });
      row.appendChild(hex);
      const trash = document.createElement('button');
      trash.type = 'button';
      trash.className = 'pmd-color-slot-trash';
      setIcon(trash, 'close');
      trash.title = 'Remove this slot';
      trash.disabled = slots.length <= 1;
      trash.addEventListener('click', () => {
        const next = get().slice();
        next.splice(i, 1);
        set(next);
      });
      row.appendChild(trash);
      wrap.appendChild(row);
    }
    if (slots.length < 3) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'pmd-color-slot-add';
      add.textContent = '+ Add slot';
      add.addEventListener('click', () => {
        const next = get().slice();
        // New slot defaults to the previous-last value so the
        // user sees a visible swatch immediately and can adjust.
        next.push(next[next.length - 1] ?? '#888888');
        set(next);
      });
      wrap.appendChild(add);
    }
  }

  render();
  const unsub = settings.subscribe(render);
  registerRowCleanup(wrap, () => unsub());
  return wrap;
}

/** Per-token color override panel. Structured like the
 *  keybindings editor: one row per overridable token, grouped
 *  into sections. Each row shows the current effective color +
 *  hex, a color picker that writes to the override, and a reset
 *  button that drops the override (revealing the default or
 *  whichever preset is active). */
function buildColorOverridesEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-color-overrides-editor';

  // Global reset header — clears every override at once.
  const header = document.createElement('div');
  header.className = 'pmd-color-overrides-header';
  const resetAll = document.createElement('button');
  resetAll.type = 'button';
  resetAll.className = 'pmd-color-overrides-reset-all';
  resetAll.textContent = '↺ Reset all overrides';
  resetAll.title = 'Drop every override and fall back to defaults';
  resetAll.addEventListener('click', () => {
    settings.set('customColorOverrides', {});
    // The document-text rows are backed by displayColors, not the
    // overrides blob — reset them too so "Reset all" clears every
    // row the user sees in this panel.
    settings.set('displayColors', { ...DEFAULT_DISPLAY_COLORS });
  });
  header.appendChild(resetAll);
  wrap.appendChild(header);

  function displayColorsAtDefault(): boolean {
    const dc = settings.get('displayColors');
    return DISPLAY_COLOR_KEYS.every(
      (k) => dc[k].toLowerCase() === DEFAULT_DISPLAY_COLORS[k].toLowerCase(),
    );
  }
  function refreshResetAll(): void {
    const has =
      Object.keys(settings.get('customColorOverrides')).length > 0 ||
      !displayColorsAtDefault();
    resetAll.disabled = !has;
  }
  refreshResetAll();
  const unsubResetAll = settings.subscribe(refreshResetAll);
  registerRowCleanup(wrap, () => unsubResetAll());

  // Group tokens by their `group` field, preserving manifest order.
  const groups = new Map<string, typeof CUSTOMIZABLE_COLOR_TOKENS[number][]>();
  for (const tok of CUSTOMIZABLE_COLOR_TOKENS) {
    let g = groups.get(tok.group);
    if (!g) { g = []; groups.set(tok.group, g); }
    g.push(tok);
  }

  function currentValue(name: string): string {
    return getComputedStyle(document.documentElement)
      .getPropertyValue('--' + name)
      .trim();
  }

  // One reused, hidden probe for resolving color strings to rgba.
  // Appending + removing a fresh probe to <body> per call (×37 rows ×
  // every settings change) would force a full-document layout recalc
  // each time — the dominant settings-lag source on large docs. Kept
  // connected + laid out (`visibility:hidden`, off-screen) so
  // `getComputedStyle(probe).color` resolves; changing only its own
  // color dirties just this leaf element, not the whole document.
  const probe = document.createElement('span');
  probe.style.cssText =
    'position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none';
  document.body.appendChild(probe);
  registerRowCleanup(wrap, () => probe.remove());

  /** Resolve any CSS color string (hex / rgba / named / hsl) to
   *  numeric RGB + alpha. Used to pre-fill the color picker AND
   *  the alpha slider with the token's current effective value
   *  regardless of how it's stored. */
  function parseToRgbaParts(css: string): {
    r: number; g: number; b: number; a: number;
  } {
    probe.style.color = css;
    const resolved = getComputedStyle(probe).color;
    const m = resolved.match(
      /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?/,
    );
    if (!m) return { r: 0, g: 0, b: 0, a: 1 };
    return {
      r: +m[1]!,
      g: +m[2]!,
      b: +m[3]!,
      a: m[4] !== undefined ? +m[4]! : 1,
    };
  }
  function toHex(r: number, g: number, b: number): string {
    const h = (n: number) => Math.round(n).toString(16).padStart(2, '0');
    return '#' + h(r) + h(g) + h(b);
  }
  /** Compose a numeric RGB + alpha back into a CSS color string.
   *  Alpha == 1 → `#rrggbb`; otherwise → `rgba(r, g, b, a)`.
   *  Keeps the override storage compact when no transparency is
   *  needed. */
  function composeColor(r: number, g: number, b: number, a: number): string {
    if (a >= 0.999) return toHex(r, g, b);
    return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${
      Math.round(a * 1000) / 1000
    })`;
  }

  function isOverridden(name: string): boolean {
    const overrides = settings.get('customColorOverrides');
    return Object.prototype.hasOwnProperty.call(overrides, name);
  }

  function setOverride(name: string, value: string): void {
    const next = { ...settings.get('customColorOverrides'), [name]: value };
    settings.set('customColorOverrides', next);
  }
  function clearOverride(name: string): void {
    const cur = settings.get('customColorOverrides');
    if (!Object.prototype.hasOwnProperty.call(cur, name)) return;
    const next = { ...cur };
    delete next[name];
    settings.set('customColorOverrides', next);
  }

  function renderRow(tok: typeof CUSTOMIZABLE_COLOR_TOKENS[number]): HTMLElement {
    const row = document.createElement('div');
    row.className = 'pmd-color-override-row';

    const label = document.createElement('span');
    label.className = 'pmd-color-override-label';
    label.textContent = tok.label;
    row.appendChild(label);

    const right = document.createElement('span');
    right.className = 'pmd-color-override-right';

    const swatch = document.createElement('span');
    swatch.className = 'pmd-color-override-swatch';
    const hex = document.createElement('span');
    hex.className = 'pmd-color-override-hex';

    const input = document.createElement('input');
    input.type = 'color';
    input.className = 'pmd-color-override-input';

    // Document-text tokens (analytic / undertag) are backed by the
    // `displayColors` setting, linked to the Appearance → Style colors
    // picker. For these the row reads / writes displayColors (a plain
    // opaque hex) instead of the overrides blob, and the alpha slider
    // is hidden — document text is never translucent.
    const dcKey = DISPLAY_COLOR_TOKEN_TO_KEY[tok.name];

    // Alpha slider, sized 0–1 with two-decimal steps. Lets the
    // user tune translucent tokens (`pmd-c-overlay`, the various
    // soft accents) — important for an accessibility tool, where
    // a user might need to dial the modal-scrim alpha way up for
    // readability or way down to keep underlying text legible.
    const alpha = document.createElement('input');
    alpha.type = 'range';
    alpha.className = 'pmd-color-override-alpha';
    alpha.min = '0';
    alpha.max = '1';
    alpha.step = '0.01';
    alpha.title = 'Opacity';
    if (dcKey) alpha.hidden = true;

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'pmd-color-override-reset';
    setIcon(reset, 'reset');
    reset.title = 'Reset to default';

    function refresh(): void {
      if (dcKey) {
        const value = settings.get('displayColors')[dcKey];
        swatch.style.background = value;
        hex.textContent = value;
        input.value = value;
        reset.disabled =
          value.toLowerCase() === DEFAULT_DISPLAY_COLORS[dcKey].toLowerCase();
        return;
      }
      const value = currentValue(tok.name);
      const { r, g, b, a } = parseToRgbaParts(value);
      swatch.style.background = value;
      hex.textContent = value;
      input.value = toHex(r, g, b);
      alpha.value = String(a);
      // Keep the button in the layout always so the row doesn't
      // shift width as the alpha slider drags into / out of
      // overridden territory; only `disabled` toggles.
      reset.disabled = !isOverridden(tok.name);
    }

    function write(): void {
      if (dcKey) {
        settings.set('displayColors', {
          ...settings.get('displayColors'),
          [dcKey]: input.value,
        });
        return;
      }
      const { r, g, b } = parseToRgbaParts(input.value);
      const a = Math.max(0, Math.min(1, +alpha.value));
      setOverride(tok.name, composeColor(r, g, b, a));
    }

    input.addEventListener('input', write);
    alpha.addEventListener('input', write);
    reset.addEventListener('click', () => {
      if (dcKey) {
        settings.set('displayColors', {
          ...settings.get('displayColors'),
          [dcKey]: DEFAULT_DISPLAY_COLORS[dcKey],
        });
      } else {
        clearOverride(tok.name);
      }
    });

    right.appendChild(swatch);
    right.appendChild(hex);
    right.appendChild(input);
    right.appendChild(alpha);
    right.appendChild(reset);
    row.appendChild(right);

    refresh();
    // Refresh this row only when ITS OWN token's value changes — the
    // document-text rows track `displayColors[dcKey]`, the rest their
    // own `customColorOverrides[name]`. `refresh` reads a computed
    // style, so re-running all ~37 rows on every settings change
    // would dominate settings lag on large docs; the customizable
    // tokens are independent base colors, so editing one never
    // changes another's effective value.
    const tokenValue = (s: ReturnType<typeof settings.all>): unknown =>
      dcKey ? s.displayColors[dcKey] : s.customColorOverrides[tok.name];
    let lastBacking = tokenValue(settings.all());
    const unsub = settings.subscribe((s) => {
      const cur = tokenValue(s);
      if (cur !== lastBacking) {
        lastBacking = cur;
        refresh();
      }
    });
    registerRowCleanup(row, () => unsub());

    return row;
  }

  for (const [groupName, tokens] of groups) {
    const heading = document.createElement('div');
    heading.className = 'pmd-color-override-group-label';
    heading.textContent = groupName;
    wrap.appendChild(heading);
    for (const t of tokens) wrap.appendChild(renderRow(t));
  }

  return wrap;
}

function buildFindCategoryOrderEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-find-category-order-editor';
  const labels: Record<string, string> = {
    heading: 'Headings (Pocket / Hat / Block)',
    tag: 'Tags',
    analytic: 'Analytics',
    undertag: 'Undertags',
    cite: 'Cites',
    other: 'Other (body, …)',
  };

  function render(): void {
    wrap.innerHTML = '';
    const order = settings.get('findCategoryOrder');
    for (let i = 0; i < order.length; i++) {
      const cat = order[i]!;
      const row = document.createElement('div');
      row.className = 'pmd-find-category-order-row';
      const rank = document.createElement('span');
      rank.className = 'pmd-find-category-order-rank';
      rank.textContent = String(i + 1);
      row.appendChild(rank);
      const labelEl = document.createElement('span');
      labelEl.className = 'pmd-find-category-order-label';
      labelEl.textContent = labels[cat] ?? cat;
      row.appendChild(labelEl);
      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'pmd-find-category-order-btn';
      setIcon(upBtn, 'arrow-up');
      upBtn.title = 'Move up';
      upBtn.disabled = i === 0;
      upBtn.addEventListener('click', () => swap(i, i - 1));
      row.appendChild(upBtn);
      const downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.className = 'pmd-find-category-order-btn';
      setIcon(downBtn, 'arrow-down');
      downBtn.title = 'Move down';
      downBtn.disabled = i === order.length - 1;
      downBtn.addEventListener('click', () => swap(i, i + 1));
      row.appendChild(downBtn);
      wrap.appendChild(row);
    }
  }

  function swap(a: number, b: number): void {
    const cur = settings.get('findCategoryOrder').slice();
    const tmp = cur[a]!;
    cur[a] = cur[b]!;
    cur[b] = tmp;
    settings.set('findCategoryOrder', cur);
    render();
  }

  render();
  return wrap;
}

function buildSaveFormatEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-multi-doc-layout-mode-editor';
  const options: { value: 'docx' | 'cmir'; label: string }[] = [
    { value: 'docx', label: '.docx — Word / Verbatim-compatible (default)' },
    { value: 'cmir', label: '.cmir — CardMirror native (enables autosave)' },
  ];
  const groupName = `pmd-save-format-${Math.random().toString(36).slice(2, 8)}`;
  for (const o of options) {
    const row = document.createElement('label');
    row.className = 'pmd-multi-doc-layout-mode-row';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = groupName;
    input.value = o.value;
    input.checked = o.value === settings.get('defaultSaveFormat');
    input.addEventListener('change', () => {
      if (input.checked) settings.set('defaultSaveFormat', o.value);
    });
    row.appendChild(input);
    const labelText = document.createElement('span');
    labelText.className = 'pmd-multi-doc-layout-mode-row-label';
    labelText.textContent = o.label;
    row.appendChild(labelText);
    wrap.appendChild(row);
  }
  return wrap;
}

function buildAiProviderEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-multi-doc-layout-mode-editor';
  const options: { value: 'anthropic' | 'openrouter'; label: string }[] = [
    { value: 'anthropic', label: 'Anthropic (api.anthropic.com)' },
    { value: 'openrouter', label: 'OpenRouter (openrouter.ai, OpenAI-compatible)' },
  ];
  const groupName = `pmd-ai-provider-${Math.random().toString(36).slice(2, 8)}`;
  for (const o of options) {
    const optRow = document.createElement('label');
    optRow.className = 'pmd-multi-doc-layout-mode-row';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = groupName;
    input.value = o.value;
    input.checked = o.value === settings.get('aiProvider');
    input.addEventListener('change', () => {
      if (input.checked) settings.set('aiProvider', o.value);
    });
    optRow.appendChild(input);
    const labelText = document.createElement('span');
    labelText.className = 'pmd-multi-doc-layout-mode-row-label';
    labelText.textContent = o.label;
    optRow.appendChild(labelText);
    wrap.appendChild(optRow);
  }
  return wrap;
}

function buildFormattingGapClassEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-multi-doc-layout-mode-editor';
  const options: { value: 'both' | 'whitespace'; label: string }[] = [
    { value: 'both', label: 'Whitespace and punctuation' },
    { value: 'whitespace', label: 'Whitespace only' },
  ];
  const groupName = `pmd-formatting-gap-class-${Math.random().toString(36).slice(2, 8)}`;
  for (const o of options) {
    const row = document.createElement('label');
    row.className = 'pmd-multi-doc-layout-mode-row';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = groupName;
    input.value = o.value;
    input.checked = o.value === settings.get('formattingGapClass');
    input.addEventListener('change', () => {
      if (input.checked) settings.set('formattingGapClass', o.value);
    });
    row.appendChild(input);
    const labelText = document.createElement('span');
    labelText.className = 'pmd-multi-doc-layout-mode-row-label';
    labelText.textContent = o.label;
    row.appendChild(labelText);
    wrap.appendChild(row);
  }
  return wrap;
}

function buildTranslationEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-translation-editor';

  // --- Backend radios ---
  // The stored value stays 'anthropic' for compatibility; the label says
  // "AI provider" because the backend follows the Comments & AI provider
  // selection (Anthropic or OpenRouter).
  const providers: { value: 'auto' | 'mymemory' | 'anthropic' | 'google'; label: string; note?: string }[] = [
    { value: 'auto', label: 'Automatic — your AI provider when AI features are on, otherwise MyMemory' },
    { value: 'mymemory', label: 'MyMemory — free, no key, works with AI features off' },
    { value: 'anthropic', label: 'AI provider — highest quality (requires AI features)' },
    { value: 'google', label: 'Google Cloud Translation — needs an API key below' },
  ];
  const groupName = `pmd-translation-provider-${Math.random().toString(36).slice(2, 8)}`;
  // Radios for the AI-provider backend (stored value 'anthropic'),
  // greyed when AI features are off.
  const anthropicRadios: HTMLInputElement[] = [];
  const fieldLabel = (txt: string): HTMLElement => {
    const l = document.createElement('div');
    l.className = 'pmd-settings-row-title';
    l.textContent = txt;
    return l;
  };

  for (const o of providers) {
    const row = document.createElement('label');
    row.className = 'pmd-multi-doc-layout-mode-row';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = groupName;
    input.value = o.value;
    input.checked = o.value === settings.get('translationProvider');
    input.addEventListener('change', () => {
      if (input.checked) settings.set('translationProvider', o.value);
    });
    if (o.value === 'anthropic') anthropicRadios.push(input);
    row.appendChild(input);
    const labelText = document.createElement('span');
    labelText.className = 'pmd-multi-doc-layout-mode-row-label';
    labelText.textContent = o.label;
    row.appendChild(labelText);
    wrap.appendChild(row);
  }

  // Note shown when AI features are off and the AI backend is greyed.
  const aiNote = document.createElement('div');
  aiNote.className = 'pmd-settings-row-desc pmd-translation-ai-note';
  aiNote.textContent = 'AI translation is unavailable until you enable AI features under Comments & AI.';
  wrap.appendChild(aiNote);

  // Determinism / evidence-ethics caveat for the AI backend.
  const caveat = document.createElement('div');
  caveat.className = 'pmd-settings-row-desc pmd-translation-caveat';
  caveat.textContent =
    'Note: The AI translation prompt directs the model to preserve the original meaning above all else. However, the translation may not be deterministic — re-running can produce slightly different wording. Keep this in mind if you are debating in a league or circuit where translated evidence requires a paper trail or reproducibility.';
  wrap.appendChild(caveat);

  const langRow = document.createElement('div');
  langRow.className = 'pmd-translation-langs';

  // --- Source language ---
  const srcWrap = document.createElement('div');
  srcWrap.appendChild(fieldLabel('Source language'));
  const srcSel = document.createElement('select');
  srcSel.className = 'pmd-body-font-select';
  const autoOpt = document.createElement('option');
  autoOpt.value = 'auto';
  autoOpt.textContent = 'Auto-detect';
  srcSel.appendChild(autoOpt);
  for (const l of TRANSLATION_LANGUAGES) {
    const opt = document.createElement('option');
    opt.value = l.code;
    opt.textContent = l.name;
    srcSel.appendChild(opt);
  }
  srcSel.value = settings.get('translationSourceLang');
  srcSel.addEventListener('change', () => settings.set('translationSourceLang', srcSel.value));
  srcWrap.appendChild(srcSel);
  langRow.appendChild(srcWrap);

  // --- Target language ---
  const tgtWrap = document.createElement('div');
  tgtWrap.appendChild(fieldLabel('Target language'));
  const tgtSel = document.createElement('select');
  tgtSel.className = 'pmd-body-font-select';
  for (const l of TRANSLATION_LANGUAGES) {
    const opt = document.createElement('option');
    opt.value = l.code;
    opt.textContent = l.name;
    tgtSel.appendChild(opt);
  }
  tgtSel.value = settings.get('translationTargetLang');
  tgtSel.addEventListener('change', () => settings.set('translationTargetLang', tgtSel.value));
  tgtWrap.appendChild(tgtSel);
  langRow.appendChild(tgtWrap);
  wrap.appendChild(langRow);

  // --- MyMemory email (optional, raises the daily limit) ---
  const emailWrap = document.createElement('div');
  emailWrap.className = 'pmd-translation-field';
  emailWrap.appendChild(fieldLabel('MyMemory email (optional)'));
  const emailDesc = document.createElement('div');
  emailDesc.className = 'pmd-settings-row-desc';
  emailDesc.textContent = 'Supplying an email raises MyMemory’s free limit from ~5,000 to ~50,000 characters/day.';
  emailWrap.appendChild(emailDesc);
  const email = document.createElement('input');
  email.type = 'email';
  email.className = 'pmd-settings-text';
  email.value = settings.get('myMemoryEmail');
  email.placeholder = 'you@example.com';
  email.addEventListener('change', () => settings.set('myMemoryEmail', email.value.trim()));
  emailWrap.appendChild(email);
  wrap.appendChild(emailWrap);

  // --- Google API key (only used by the Google backend) ---
  const keyWrap = document.createElement('div');
  keyWrap.className = 'pmd-translation-field';
  keyWrap.appendChild(fieldLabel('Google Cloud Translation API key'));
  const keyDesc = document.createElement('div');
  keyDesc.className = 'pmd-settings-row-desc';
  keyDesc.textContent = 'Only used by the Google backend. 500,000 characters/month are free; beyond that Google bills per character. Stored locally.';
  keyWrap.appendChild(keyDesc);
  const key = document.createElement('input');
  key.type = 'password';
  key.className = 'pmd-settings-text';
  key.value = settings.get('googleTranslateApiKey');
  key.addEventListener('change', () => settings.set('googleTranslateApiKey', key.value.trim()));
  keyWrap.appendChild(key);
  wrap.appendChild(keyWrap);

  // Live-grey the AI-backend radio + note based on the AI master switch.
  const applyAiState = (): void => {
    const ready = settings.get('aiFeaturesEnabled');
    for (const r of anthropicRadios) {
      r.disabled = !ready;
      r.closest('label')?.classList.toggle('pmd-settings-row-disabled', !ready);
    }
    aiNote.style.display = ready ? 'none' : '';
  };
  applyAiState();
  const unsub = settings.subscribe(() => {
    // Self-detach once the widget leaves the DOM (dialog re-render / close).
    if (!document.body.contains(wrap)) { unsub(); return; }
    applyAiState();
  });

  return wrap;
}

function buildSendDocDestinationEditor(): HTMLElement {
  return buildDestinationEditor('sendDocDestination', 'pmd-send-doc-dest');
}

function buildMarkedCardsDestinationEditor(): HTMLElement {
  return buildDestinationEditor('markedCardsDestination', 'pmd-marked-cards-dest');
}

/** Same/fixed-folder radio for a save destination setting (Send Doc, Marked
 *  Cards). `key` is the setting; `idPrefix` keeps the radio group distinct. */
function buildDestinationEditor(
  key: 'sendDocDestination' | 'markedCardsDestination',
  idPrefix: string,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-multi-doc-layout-mode-editor';
  const options: { value: 'sameFolder' | 'fixedFolder'; label: string }[] = [
    { value: 'sameFolder', label: 'Same folder as the document (default)' },
    { value: 'fixedFolder', label: 'Fixed folder (set below)' },
  ];
  const groupName = `${idPrefix}-${Math.random().toString(36).slice(2, 8)}`;
  for (const o of options) {
    const row = document.createElement('label');
    row.className = 'pmd-multi-doc-layout-mode-row';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = groupName;
    input.value = o.value;
    input.checked = o.value === settings.get(key);
    input.addEventListener('change', () => {
      if (input.checked) settings.set(key, o.value);
    });
    row.appendChild(input);
    const labelText = document.createElement('span');
    labelText.className = 'pmd-multi-doc-layout-mode-row-label';
    labelText.textContent = o.label;
    row.appendChild(labelText);
    wrap.appendChild(row);
  }
  return wrap;
}

function buildMultiDocLayoutModeEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-multi-doc-layout-mode-editor';
  const options: { value: 'compact' | 'wide'; label: string }[] = [
    { value: 'compact', label: 'Compact — all 3 panes side by side' },
    { value: 'wide', label: 'Wide-scroll — 2 full + edge of 3rd (click to snap)' },
  ];
  const groupName = `pmd-multi-doc-layout-${Math.random().toString(36).slice(2, 8)}`;
  for (const o of options) {
    const row = document.createElement('label');
    row.className = 'pmd-multi-doc-layout-mode-row';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = groupName;
    input.value = o.value;
    input.checked = o.value === settings.get('multiDocLayoutMode');
    input.addEventListener('change', () => {
      if (input.checked) settings.set('multiDocLayoutMode', o.value);
    });
    row.appendChild(input);
    const labelText = document.createElement('span');
    labelText.className = 'pmd-multi-doc-layout-mode-row-label';
    labelText.textContent = o.label;
    row.appendChild(labelText);
    wrap.appendChild(row);
  }
  return wrap;
}

function buildFileSearchTiebreakEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-multi-doc-layout-mode-editor';
  const options: { value: 'recency' | 'alphabetical'; label: string }[] = [
    { value: 'recency', label: 'Recency — most recently edited first' },
    { value: 'alphabetical', label: 'Alphabetical — by file name' },
  ];
  const groupName = `pmd-file-search-tiebreak-${Math.random().toString(36).slice(2, 8)}`;
  for (const o of options) {
    const row = document.createElement('label');
    row.className = 'pmd-multi-doc-layout-mode-row';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = groupName;
    input.value = o.value;
    input.checked = o.value === settings.get('fileSearchTiebreak');
    input.addEventListener('change', () => {
      if (input.checked) settings.set('fileSearchTiebreak', o.value);
    });
    row.appendChild(input);
    const labelText = document.createElement('span');
    labelText.className = 'pmd-multi-doc-layout-mode-row-label';
    labelText.textContent = o.label;
    row.appendChild(labelText);
    wrap.appendChild(row);
  }
  return wrap;
}

/** Radio for the default read length — the same five options as the
 *  cut panel's chips (0 = Efficient / no limit), with the word counts
 *  computed at the user's reader WPM so the labels match what the
 *  panel will show. */
function buildCardCutterReadTimeRadio(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-heading-mode-editor';
  const readers = settings.get('readers');
  const wpm = readers[0]?.wpm && readers[0].wpm > 0 ? readers[0].wpm : 350;
  const options: [number, string][] = [
    [0, 'Efficient — no limit (default)'],
    ...[8, 12, 20, 30].map(
      (sec): [number, string] => [sec, `\u2264 ${sec}s \u00b7 ~${Math.round((sec * wpm) / 60)} words`],
    ),
  ];
  const groupName = `pmd-cardCutterReadTimeSec-${Math.random().toString(36).slice(2, 8)}`;
  const current = settings.get('cardCutterReadTimeSec');
  for (const [value, label] of options) {
    const row = document.createElement('label');
    row.className = 'pmd-heading-mode-row';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = groupName;
    input.value = String(value);
    input.checked = current === value;
    input.addEventListener('change', () => {
      if (input.checked) settings.set('cardCutterReadTimeSec', value);
    });
    row.appendChild(input);
    const span = document.createElement('span');
    span.className = 'pmd-heading-mode-row-label';
    span.textContent = label;
    row.appendChild(span);
    wrap.appendChild(row);
  }
  return wrap;
}

function buildMobileLayoutEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-heading-mode-editor';
  const options: { value: 'auto' | 'mobile' | 'desktop'; label: string }[] = [
    { value: 'auto', label: 'Auto — mobile layout on small touch screens (default)' },
    { value: 'mobile', label: 'Mobile — always the view-first layout' },
    { value: 'desktop', label: 'Desktop — always this layout' },
  ];
  const groupName = `pmd-mobile-layout-${Math.random().toString(36).slice(2, 8)}`;
  for (const o of options) {
    const row = document.createElement('label');
    row.className = 'pmd-heading-mode-row';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = groupName;
    input.value = o.value;
    input.checked = o.value === settings.get('mobileLayout');
    input.addEventListener('change', () => {
      if (!input.checked) return;
      settings.set('mobileLayout', o.value);
      // The shell is chosen once per load; offer the reload here so
      // the choice takes effect now rather than on the next visit.
      void confirmDialog('Reload now to apply the layout change?', { okLabel: 'Reload' }).then(
        (go) => {
          if (go) window.location.reload();
        },
      );
    });
    row.appendChild(input);
    const labelText = document.createElement('span');
    labelText.className = 'pmd-heading-mode-row-label';
    labelText.textContent = o.label;
    row.appendChild(labelText);
    wrap.appendChild(row);
  }
  return wrap;
}

function buildVersionHistoryEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-heading-mode-editor';
  const options: { value: 'off' | 'standard' | 'extended' | 'custom'; label: string }[] = [
    { value: 'off', label: 'Off \u2014 keep no version snapshots' },
    { value: 'standard', label: 'Standard \u2014 up to 30 days, capped at 500 MB (default)' },
    { value: 'extended', label: 'Extended \u2014 up to 90 days, capped at 2 GB' },
    { value: 'custom', label: 'Custom \u2014 up to 90 days, caps of your choosing' },
  ];
  // Custom's cap fields — built up front so the radio handler can
  // toggle them; wired after the loop.
  const customRow = document.createElement('div');
  customRow.className = 'pmd-version-history-custom';
  const syncCustomVisibility = (): void => {
    customRow.style.display = settings.get('versionHistory') === 'custom' ? '' : 'none';
  };
  const groupName = `pmd-version-history-${Math.random().toString(36).slice(2, 8)}`;
  for (const o of options) {
    const row = document.createElement('label');
    row.className = 'pmd-heading-mode-row';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = groupName;
    input.value = o.value;
    input.checked = o.value === settings.get('versionHistory');
    input.addEventListener('change', () => {
      if (input.checked) settings.set('versionHistory', o.value);
      syncCustomVisibility();
    });
    row.appendChild(input);
    const text = document.createElement('span');
    text.className = 'pmd-heading-mode-row-label';
    text.textContent = o.label;
    row.appendChild(text);
    wrap.appendChild(row);
  }

  const capField = (
    label: string,
    key: 'versionHistoryDocCapMb' | 'versionHistoryTotalCapMb',
  ): HTMLElement => {
    const holder = document.createElement('label');
    holder.className = 'pmd-version-history-cap';
    const caption = document.createElement('span');
    caption.textContent = label;
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'pmd-settings-text';
    input.min = '0';
    input.style.width = '6.5rem';
    input.style.flex = '0 0 auto';
    input.value = String(settings.get(key));
    input.addEventListener('change', () => {
      const n = Number.parseFloat(input.value);
      if (Number.isFinite(n) && n >= 0) {
        settings.set(key, Math.round(n));
      }
      // Snap the field to the stored (clamped) value either way.
      input.value = String(settings.get(key));
    });
    const unit = document.createElement('span');
    unit.textContent = 'MB';
    holder.append(caption, input, unit);
    return holder;
  };
  const zeroHint = document.createElement('span');
  zeroHint.className = 'pmd-settings-row-desc';
  zeroHint.style.margin = '0';
  zeroHint.textContent = '0 = no cap';
  customRow.append(
    capField('Per-document cap', 'versionHistoryDocCapMb'),
    capField('Total cap', 'versionHistoryTotalCapMb'),
    zeroHint,
  );
  syncCustomVisibility();
  wrap.appendChild(customRow);

  // Usage readout + clear — the snapshots live in app data where the
  // user can't see them, so the disk cost must be visible HERE.
  const host = getElectronHost();
  if (host) {
    const usageRow = document.createElement('div');
    usageRow.className = 'pmd-settings-row-desc';
    usageRow.textContent = 'Checking disk usage\u2026';
    const refreshUsage = (): void => {
      void host
        .historyUsage()
        .then(({ totalBytes, snapshots }) => {
          const mb = totalBytes / (1024 * 1024);
          usageRow.textContent =
            snapshots === 0
              ? 'No version snapshots stored yet.'
              : `Currently using ${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB across ${snapshots} snapshot${snapshots === 1 ? '' : 's'}.`;
        })
        .catch(() => {
          usageRow.textContent = '';
        });
    };
    refreshUsage();
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'pmd-install-info-btn';
    clearBtn.textContent = 'Clear version history';
    clearBtn.addEventListener('click', () => {
      void (async () => {
        if (!(await confirmDialog('Delete every stored version snapshot? Documents themselves are not affected.'))) {
          return;
        }
        await host.historyClear();
        showToast('Version history cleared.');
        refreshUsage();
      })();
    });
    const actions = document.createElement('div');
    actions.style.marginTop = '0.4rem';
    actions.appendChild(clearBtn);
    wrap.append(usageRow, actions);
  }
  return wrap;
}

function buildPasteCursorEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-heading-mode-editor';
  const options: { value: 'after' | 'tag'; label: string }[] = [
    { value: 'after', label: 'End of the pasted content (default)' },
    { value: 'tag', label: 'End of the pasted tag \u2014 ready to rename it' },
  ];
  const groupName = `pmd-paste-cursor-${Math.random().toString(36).slice(2, 8)}`;
  for (const o of options) {
    const row = document.createElement('label');
    row.className = 'pmd-heading-mode-row';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = groupName;
    input.value = o.value;
    input.checked = o.value === settings.get('pasteCursor');
    input.addEventListener('change', () => {
      if (input.checked) settings.set('pasteCursor', o.value);
    });
    row.appendChild(input);
    const text = document.createElement('span');
    text.className = 'pmd-heading-mode-row-label';
    text.textContent = o.label;
    row.appendChild(text);
    wrap.appendChild(row);
  }
  return wrap;
}

function buildHeadingModeEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-heading-mode-editor';
  const options: { value: HeadingMode; label: string }[] = [
    { value: 'strict', label: "Strict — don't condense if headings are in the selection" },
    { value: 'respect', label: 'Respect — keep headings separate, merge the rest (default)' },
    { value: 'demolish', label: 'Demolish — merge everything, headings included' },
  ];
  // Radio buttons instead of a <select> so the long option labels
  // wrap to multiple lines if the dialog is narrow.
  const groupName = `pmd-heading-mode-${Math.random().toString(36).slice(2, 8)}`;
  for (const o of options) {
    const row = document.createElement('label');
    row.className = 'pmd-heading-mode-row';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = groupName;
    input.value = o.value;
    input.checked = o.value === settings.get('headingMode');
    input.addEventListener('change', () => {
      if (input.checked) settings.set('headingMode', o.value);
    });
    row.appendChild(input);
    const text = document.createElement('span');
    text.className = 'pmd-heading-mode-row-label';
    text.textContent = o.label;
    row.appendChild(text);
    wrap.appendChild(row);
  }
  return wrap;
}

function buildCondenseWarningDelimiterEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-condense-warning-delimiter-editor';
  const opens: CondenseWarningDelimiter[] = ['[', '[[', '<', '<<', '{', '{{'];
  const groupName = `pmd-cw-delim-${Math.random().toString(36).slice(2, 8)}`;
  for (const open of opens) {
    const close = condenseWarningCloseFor(open);
    const row = document.createElement('label');
    row.className = 'pmd-condense-warning-delimiter-row';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = groupName;
    input.value = open;
    input.checked = open === settings.get('condenseWarningDelimiter');
    input.addEventListener('change', () => {
      if (input.checked) settings.set('condenseWarningDelimiter', open);
    });
    row.appendChild(input);
    const sample = document.createElement('span');
    sample.className = 'pmd-condense-warning-delimiter-sample';
    sample.textContent = `${open}PARAGRAPH INTEGRITY PAUSES${close}`;
    row.appendChild(sample);
    wrap.appendChild(row);
  }

  // Custom row: radio + two short text inputs for open/close. When
  // 'custom' is selected, the inputs become live; otherwise they're
  // still editable (so the user can type before committing the radio
  // — Word-style) but visually muted.
  const customRow = document.createElement('label');
  customRow.className =
    'pmd-condense-warning-delimiter-row pmd-condense-warning-delimiter-row-custom';
  const customRadio = document.createElement('input');
  customRadio.type = 'radio';
  customRadio.name = groupName;
  customRadio.value = 'custom';
  customRadio.checked = settings.get('condenseWarningDelimiter') === 'custom';
  customRadio.addEventListener('change', () => {
    if (customRadio.checked) settings.set('condenseWarningDelimiter', 'custom');
  });
  customRow.appendChild(customRadio);

  const pauseInput = document.createElement('input');
  pauseInput.type = 'text';
  pauseInput.className = 'pmd-condense-warning-delimiter-input';
  pauseInput.placeholder = 'replaces [PARAGRAPH INTEGRITY PAUSES]';
  pauseInput.value = settings.get('condenseWarningCustomPauseMarker');
  pauseInput.addEventListener('input', () => {
    settings.set('condenseWarningCustomPauseMarker', pauseInput.value);
  });

  const resumeInput = document.createElement('input');
  resumeInput.type = 'text';
  resumeInput.className = 'pmd-condense-warning-delimiter-input';
  resumeInput.placeholder = 'replaces [PARAGRAPH INTEGRITY RESUMES]';
  resumeInput.value = settings.get('condenseWarningCustomResumeMarker');
  resumeInput.addEventListener('input', () => {
    settings.set('condenseWarningCustomResumeMarker', resumeInput.value);
  });

  // The label-text portion: a column with the "Custom" header and
  // the two full-marker inputs stacked. Each input is the WHOLE
  // text that goes into the marker paragraph (not just a bracket),
  // so there's no sample preview — the input value IS the preview.
  // The outer row's `align-items: flex-start` keeps the radio
  // aligned with the header at the top of the column.
  const customInner = document.createElement('div');
  customInner.className = 'pmd-condense-warning-delimiter-custom-inner';
  const customLabel = document.createElement('div');
  customLabel.textContent = 'Custom (must set both):';
  customLabel.className = 'pmd-condense-warning-delimiter-custom-label';
  customInner.appendChild(customLabel);
  customInner.appendChild(pauseInput);
  customInner.appendChild(resumeInput);
  customRow.appendChild(customInner);
  wrap.appendChild(customRow);

  return wrap;
}

/** Four-button segmented control for `fileSearchOutlineDepth` — the
 *  deepest level the file-search outline expands to by default. */
/** Accessibility → Maximum text width: an enable checkbox + a px
 *  input. Off stores 0; enabling restores the last width (or 800). */
function buildMaxTextWidthEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-max-text-width-editor';
  let lastOnValue = 800;

  const row = document.createElement('label');
  row.className = 'pmd-typography-flag-row';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  row.appendChild(cb);
  const lbl = document.createElement('span');
  lbl.textContent = 'Limit text width to';
  row.appendChild(lbl);
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '400';
  input.max = '3000';
  input.step = '10';
  input.className = 'pmd-max-text-width-input';
  row.appendChild(input);
  const px = document.createElement('span');
  px.textContent = 'px';
  row.appendChild(px);
  wrap.appendChild(row);

  cb.addEventListener('change', () => {
    settings.set('maxTextWidthPx', cb.checked ? lastOnValue : 0);
  });

  // Column position: centered, or pinned to an edge. Rendered under the
  // width row; inert (like the width) while the cap is off.
  const posRow = document.createElement('div');
  posRow.className = 'pmd-style-alignments-row';
  const posLbl = document.createElement('span');
  posLbl.className = 'pmd-style-alignments-label';
  posLbl.textContent = 'Column position';
  posRow.appendChild(posLbl);
  const posGroup = document.createElement('div');
  posGroup.className = 'pmd-theme-editor';
  const positions: { value: 'left' | 'center' | 'right'; label: string }[] = [
    { value: 'left', label: 'Left' },
    { value: 'center', label: 'Center' },
    { value: 'right', label: 'Right' },
  ];
  for (const o of positions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-theme-editor-btn';
    btn.textContent = o.label;
    btn.dataset['value'] = o.value;
    btn.addEventListener('click', () => settings.set('maxTextWidthAlign', o.value));
    posGroup.appendChild(btn);
  }
  posRow.appendChild(posGroup);
  wrap.appendChild(posRow);
  input.addEventListener('change', () => {
    const n = Math.round(Number(input.value));
    if (Number.isFinite(n) && n >= 400 && n <= 3000) {
      lastOnValue = n;
      if (cb.checked) settings.set('maxTextWidthPx', n);
    }
  });

  function refresh(): void {
    const v = settings.get('maxTextWidthPx');
    cb.checked = v > 0;
    input.disabled = v <= 0;
    if (v > 0) {
      lastOnValue = v;
      input.value = String(v);
    } else if (!input.value) {
      input.value = String(lastOnValue);
    }
    const align = settings.get('maxTextWidthAlign');
    for (const btn of posGroup.querySelectorAll<HTMLButtonElement>('.pmd-theme-editor-btn')) {
      btn.setAttribute('aria-pressed', btn.dataset['value'] === align ? 'true' : 'false');
      btn.disabled = v <= 0;
    }
  }
  refresh();
  const unsub = settings.subscribe(refresh);
  registerRowCleanup(wrap, () => unsub());
  return wrap;
}

/** Per-style alignment rows (Accessibility → Text alignment): one
 *  Default / Center / Justify picker per structural style. */
function buildStyleAlignmentsEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-style-alignments-editor';
  const styles: { key: keyof StyleAlignments; label: string }[] = [
    { key: 'tag', label: 'Tags' },
    { key: 'paragraph', label: 'Paragraphs' },
    { key: 'cardBody', label: 'Card bodies' },
    { key: 'analyticBody', label: 'Analytic bodies' },
    { key: 'analytic', label: 'Analytics' },
    { key: 'undertag', label: 'Undertags' },
    { key: 'citeParagraph', label: 'Cite paragraphs' },
  ];
  const options: { value: StyleAlignment; label: string }[] = [
    { value: 'default', label: 'Default' },
    { value: 'center', label: 'Center' },
    { value: 'justify', label: 'Justify' },
  ];
  for (const style of styles) {
    const row = document.createElement('div');
    row.className = 'pmd-style-alignments-row';
    const lbl = document.createElement('span');
    lbl.className = 'pmd-style-alignments-label';
    lbl.textContent = style.label;
    row.appendChild(lbl);
    const group = document.createElement('div');
    group.className = 'pmd-theme-editor';
    for (const o of options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pmd-theme-editor-btn';
      btn.textContent = o.label;
      btn.dataset['styleKey'] = style.key;
      btn.dataset['value'] = o.value;
      btn.addEventListener('click', () => {
        settings.set('styleAlignments', {
          ...settings.get('styleAlignments'),
          [style.key]: o.value,
        });
      });
      group.appendChild(btn);
    }
    row.appendChild(group);
    wrap.appendChild(row);
  }
  function refresh(): void {
    const cur = settings.get('styleAlignments');
    for (const btn of wrap.querySelectorAll<HTMLButtonElement>('.pmd-theme-editor-btn')) {
      const key = btn.dataset['styleKey'] as keyof StyleAlignments;
      btn.setAttribute('aria-pressed', cur[key] === btn.dataset['value'] ? 'true' : 'false');
    }
  }
  refresh();
  const unsub = settings.subscribe(refresh);
  registerRowCleanup(wrap, () => unsub());
  return wrap;
}

/** Pocket/Hat/Block/Tag depth picker, shared by the file-search
 *  outline depth and the nav pane's default depth. */
function buildOutlineDepthEditor(key: 'fileSearchOutlineDepth' | 'navMaxLevel'): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-theme-editor';
  const options: { value: number; label: string }[] = [
    { value: 1, label: 'Pocket' },
    { value: 2, label: 'Hat' },
    { value: 3, label: 'Block' },
    { value: 4, label: 'Tag' },
  ];
  for (const o of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-theme-editor-btn';
    btn.textContent = o.label;
    btn.dataset['value'] = String(o.value);
    btn.addEventListener('click', () => settings.set(key, o.value));
    wrap.appendChild(btn);
  }
  function refresh(): void {
    const cur = String(settings.get(key));
    for (const btn of wrap.querySelectorAll<HTMLButtonElement>('.pmd-theme-editor-btn')) {
      btn.setAttribute('aria-pressed', btn.dataset['value'] === cur ? 'true' : 'false');
    }
  }
  refresh();
  const unsub = settings.subscribe(refresh);
  registerRowCleanup(wrap, () => unsub());
  return wrap;
}

/** Checklist of which structural objects the within-file search
 *  surfaces (pocket / hat / block / tag / cite / analytic), editing
 *  the `fileSearchObjectTypes` array. */
function buildFileObjectTypesEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-file-object-types-editor';
  for (const kind of FILE_OBJECT_KINDS) {
    const row = document.createElement('label');
    row.className = 'pmd-file-object-type-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.addEventListener('change', () => {
      const cur = new Set(settings.get('fileSearchObjectTypes'));
      if (cb.checked) cur.add(kind);
      else cur.delete(kind);
      // Persist in canonical outline order.
      settings.set(
        'fileSearchObjectTypes',
        FILE_OBJECT_KINDS.filter((k) => cur.has(k)),
      );
    });
    const span = document.createElement('span');
    span.textContent = FILE_OBJECT_KIND_LABELS[kind];
    row.append(cb, span);
    wrap.appendChild(row);
  }
  const refresh = (): void => {
    const set = new Set(settings.get('fileSearchObjectTypes') as FileObjectKind[]);
    const boxes = wrap.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    FILE_OBJECT_KINDS.forEach((kind, i) => {
      const box = boxes[i];
      if (box) box.checked = set.has(kind);
    });
  };
  refresh();
  const unsub = settings.subscribe(refresh);
  registerRowCleanup(wrap, () => unsub());
  return wrap;
}

/**
 * Custom shrink-protections editor — analogous to the readers editor
 * but with a per-row `regex` checkbox. Each row: text input for the
 * pattern, regex checkbox, delete button. Footer "+ Add" button.
 *
 * Validation: invalid regex sources flash an inline note on the row.
 * Shrink itself silently skips them at compile time, so a typo
 * doesn't break the command — the note is purely a UX hint.
 */
/** Custom acronym letters: rows of phrase input + a letter picker.
 *  The picker renders the phrase as clickable character cells —
 *  clicking toggles that character into the marked set, and the
 *  marked cells ARE the preview of what the acronym commands will
 *  mark. Direct manipulation instead of a pattern syntax: positions
 *  come from clicks, so there is nothing to mistype or validate.
 *  Editing the phrase keeps a mark only where the character at that
 *  offset is unchanged (appending an "s" keeps your picks; a rewrite
 *  drops stale ones rather than drifting onto wrong letters). */
function buildAcronymPatternsEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-acronym-editor';

  const list = document.createElement('div');
  list.className = 'pmd-acronym-list';
  wrap.appendChild(list);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'pmd-shrink-protections-add';
  addBtn.textContent = '+ Add phrase';
  wrap.appendChild(addBtn);

  type Entry = { phrase: string; chars: number[] };
  function commit(next: Entry[]): void {
    settings.set('acronymPatterns', next);
  }
  function update(idx: number, entry: Entry): void {
    const cur = settings.get('acronymPatterns');
    commit(cur.map((e, i) => (i === idx ? entry : e)));
  }

  function renderPicker(picker: HTMLElement, idx: number, entry: Entry): void {
    picker.innerHTML = '';
    if (!entry.phrase) {
      const hint = document.createElement('span');
      hint.className = 'pmd-acronym-hint';
      hint.textContent = 'Type a phrase, then click the letters to mark.';
      picker.appendChild(hint);
      return;
    }
    const marked = new Set(entry.chars);
    for (let i = 0; i < entry.phrase.length; i++) {
      const ch = entry.phrase[i]!;
      if (/\s/.test(ch)) {
        const gap = document.createElement('span');
        gap.className = 'pmd-acronym-gap';
        picker.appendChild(gap);
        continue;
      }
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'pmd-acronym-cell';
      cell.textContent = ch;
      cell.setAttribute('aria-pressed', marked.has(i) ? 'true' : 'false');
      cell.classList.toggle('pmd-acronym-cell-on', marked.has(i));
      const at = i;
      cell.addEventListener('click', () => {
        const next = new Set(entry.chars);
        if (next.has(at)) next.delete(at);
        else next.add(at);
        const updated = { ...entry, chars: [...next].sort((a, b) => a - b) };
        update(idx, updated);
        entry = updated;
        cell.classList.toggle('pmd-acronym-cell-on', next.has(at));
        cell.setAttribute('aria-pressed', next.has(at) ? 'true' : 'false');
      });
      picker.appendChild(cell);
    }
  }

  function render(): void {
    list.innerHTML = '';
    const entries = settings.get('acronymPatterns');
    entries.forEach((entry, idx) => {
      const row = document.createElement('div');
      row.className = 'pmd-acronym-row';

      const top = document.createElement('div');
      top.className = 'pmd-acronym-row-top';
      const phraseInput = document.createElement('input');
      phraseInput.type = 'text';
      phraseInput.className = 'pmd-settings-text pmd-acronym-phrase';
      phraseInput.value = entry.phrase;
      phraseInput.placeholder = 'phrase, e.g. nuclear weapons';
      phraseInput.spellcheck = false;
      top.appendChild(phraseInput);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'pmd-shrink-protection-delete';
      removeBtn.textContent = '×';
      removeBtn.title = 'Remove phrase';
      removeBtn.addEventListener('click', () => {
        commit(settings.get('acronymPatterns').filter((_, i) => i !== idx));
        render();
      });
      top.appendChild(removeBtn);
      row.appendChild(top);

      const picker = document.createElement('div');
      picker.className = 'pmd-acronym-picker';
      renderPicker(picker, idx, entry);
      row.appendChild(picker);

      phraseInput.addEventListener('input', () => {
        const old = settings.get('acronymPatterns')[idx];
        if (!old) return;
        const phrase = phraseInput.value;
        // Keep a mark only where the character survived the edit.
        const chars = old.chars.filter(
          (c) => c < phrase.length && phrase[c] === old.phrase[c],
        );
        const updated = { phrase, chars };
        update(idx, updated);
        renderPicker(picker, idx, updated);
      });

      list.appendChild(row);
    });
    if (entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'pmd-acronym-hint';
      empty.textContent =
        'No phrases yet. Example: add "weapons of mass destruction" and click the w, m, and d — the acronym commands then mark those letters, reading "WMD".';
      list.appendChild(empty);
    }
  }

  addBtn.addEventListener('click', () => {
    commit([...settings.get('acronymPatterns'), { phrase: '', chars: [] }]);
    render();
    const inputs = list.querySelectorAll<HTMLInputElement>('.pmd-acronym-phrase');
    inputs[inputs.length - 1]?.focus();
  });

  render();
  return wrap;
}

function buildShrinkProtectionsEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-shrink-protections-editor';

  const list = document.createElement('div');
  list.className = 'pmd-shrink-protections-list';
  wrap.appendChild(list);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'pmd-shrink-protections-add';
  addBtn.textContent = '+ Add protection';
  wrap.appendChild(addBtn);

  function commit(next: ShrinkProtection[]): void {
    settings.set('shrinkCustomProtections', next);
  }

  function render(): void {
    list.innerHTML = '';
    const rules = settings.get('shrinkCustomProtections');
    rules.forEach((rule, idx) => {
      const row = document.createElement('div');
      row.className = 'pmd-shrink-protection-row';

      const patternInput = document.createElement('input');
      patternInput.type = 'text';
      patternInput.className = 'pmd-shrink-protection-pattern';
      patternInput.value = rule.pattern;
      patternInput.placeholder = rule.isRegex
        ? 'regex source'
        : 'literal string';
      patternInput.addEventListener('change', () => {
        const next = settings.get('shrinkCustomProtections').map((r, i) =>
          i === idx ? { ...r, pattern: patternInput.value } : r,
        );
        commit(next);
      });
      row.appendChild(patternInput);

      const regexLabel = document.createElement('label');
      regexLabel.className = 'pmd-shrink-protection-regex-toggle';
      const regexCb = document.createElement('input');
      regexCb.type = 'checkbox';
      regexCb.checked = rule.isRegex;
      regexCb.addEventListener('change', () => {
        const next = settings.get('shrinkCustomProtections').map((r, i) =>
          i === idx ? { ...r, isRegex: regexCb.checked } : r,
        );
        commit(next);
      });
      regexLabel.appendChild(regexCb);
      const regexTxt = document.createElement('span');
      regexTxt.textContent = 'regex';
      regexLabel.appendChild(regexTxt);
      row.appendChild(regexLabel);

      // Inline note for invalid regex sources. Updated on input so
      // the user gets immediate feedback.
      const note = document.createElement('span');
      note.className = 'pmd-shrink-protection-note';
      const validate = (): void => {
        if (!regexCb.checked || !patternInput.value) {
          note.textContent = '';
          return;
        }
        try {
          new RegExp(patternInput.value, 'gi');
          note.textContent = '';
        } catch (err) {
          note.textContent = `invalid: ${(err as Error).message}`;
        }
      };
      patternInput.addEventListener('input', validate);
      regexCb.addEventListener('change', validate);
      validate();

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'pmd-shrink-protection-delete';
      setIcon(delBtn, 'close');
      delBtn.title = 'Remove protection';
      delBtn.addEventListener('click', () => {
        const next = settings
          .get('shrinkCustomProtections')
          .filter((_, i) => i !== idx);
        commit(next);
      });
      row.appendChild(delBtn);

      // Note goes after the delete button so its `flex: 0 0 100%`
      // wraps to its own line BELOW the row instead of pushing the
      // delete button down. Order in DOM dictates wrap order.
      row.appendChild(note);

      list.appendChild(row);
    });

    if (rules.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'pmd-shrink-protections-empty';
      empty.textContent = 'No custom protections.';
      list.appendChild(empty);
    }
  }

  addBtn.addEventListener('click', () => {
    const cur = settings.get('shrinkCustomProtections');
    commit([...cur, { pattern: '', isRegex: false }]);
  });

  const unsubscribe = settings.subscribe((s) => {
    void s;
    // Skip re-render while the user is TYPING in a text input — a
    // re-render would replace the input element and drop focus. But
    // do re-render when buttons / checkboxes are focused (so + Add
    // and × delete refresh the list live).
    const active = document.activeElement;
    const isTextInputFocused =
      active instanceof HTMLInputElement &&
      active.type === 'text' &&
      wrap.contains(active);
    if (!isTextInputFocused) render();
  });
  render();
  registerRowCleanup(wrap, () => unsubscribe());

  return wrap;
}

let singleton: SettingsModal | null = null;

export function openSettings(target?: SettingsTarget): void {
  if (!singleton) singleton = new SettingsModal();
  singleton.open(target);
}

/** Close the Settings modal if it's open (idempotent). Used before the web
 *  mode-switch prompts to save/close each doc, so those per-slot prompts appear
 *  over the workspace — not over the Settings pane the toggle was flipped in. */
export function closeSettings(): void {
  singleton?.close();
}
