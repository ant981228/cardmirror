/**
 * Research browser panel (desktop-only).
 *
 * Docks INTO one pane of the multi-pane workspace — never a fixed
 * overlay over the whole window, since a single-pane doc has no
 * screen real estate to spare and would just get half-covered. Only
 * opens when there's an ACTUAL visible split — 2+ occupied panes, not
 * merely the workspace mode toggled on — since with one pane there's
 * nothing to pick between and docking there would just replace the
 * one document the user has open. With 2+ candidates the user picks
 * which pane it takes over. The chosen pane's own content is visually
 * replaced (toolbar + native `WebContentsView`, both sized to that
 * pane's `getBoundingClientRect()`, tracked live via `ResizeObserver` so
 * window resizes and splitter drags keep it aligned) — closing the
 * panel just removes the overlay; nothing structural changes in the
 * pane underneath.
 *
 * The native view itself (`apps/desktop/src/main.ts`) sits BELOW this
 * module's DOM toolbar strip (`RESEARCH_BROWSER_TOOLBAR_HEIGHT`, kept
 * in sync between the two) — a WebContentsView always paints over
 * same-window DOM content it overlaps, so the toolbar has to occupy
 * space the native view doesn't cover.
 *
 * Selection actions:
 *   - "Insert as Cite" runs the SAME pipeline `ai/cite-creator.ts`
 *     uses for an in-doc selection (`callLlm` + `DEFAULT_AI_CITE_PROMPT`
 *     + `parseCiteResponse` + `buildCiteTransaction`), but against text
 *     captured from the embedded page instead of the editor, inserted
 *     at the focused pane's cursor (a zero-width `[pos, pos]` region).
 *   - "Insert as Text" is the plain fallback: `buildExternalInsertTransaction`
 *     with `role: 'cite'`, no AI round-trip — mirrors the Fast Debate
 *     Paste insert primitive.
 */

import type { EditorView } from 'prosemirror-view';
import { getElectronHost } from './host/index.js';
import { researchBrowserEnabled } from './research-browser-gate.js';
import {
  closeResearchBrowserPane,
  multiPaneShellActive,
  openResearchBrowserPane,
  researchBrowserSlotCandidates,
  setResearchBrowserChipTitle,
  type SlotId,
} from './multi-pane-shell.js';
import { onAnyOverlayChange } from './overlay-stack.js';
import { buildExternalInsertTransaction } from './external-insert.js';
import {
  DEFAULT_AI_CITE_PROMPT,
  applyCiteToSelection,
  parseCiteResponse,
  resolveCitePrompt,
} from './ai/cite-creator.js';
import { callLlm, LlmError, activeApiKey } from './ai/llm.js';
import { claimRegion } from './ai/edit-coordinator.js';
import { settings } from './settings.js';
import { showToast } from './toast.js';

/** Fixed title stamped over the docked pane's chip while the research
 *  browser occupies it — the pane isn't the underlying document
 *  anymore (visually), so its chip shouldn't claim to be one. */
const CHIP_TITLE = 'CardMirror Browser';

export interface ResearchBrowserPanelOpts {
  /** The pane currently in focus, or null when no doc is open/focused
   *  (home screen, settings dialog, …) — same resolver every other
   *  window-level "act on the focused doc" feature uses. */
  getFocusedView: () => EditorView | null;
  /** Ribbon toggle button (research-browser-toggle-btn in index.html)
   *  — its `aria-pressed` state is kept in sync with visibility.
   *  Optional so tests / hosts without ribbon markup still work. */
  toggleButton?: HTMLButtonElement | null;
}

export class ResearchBrowserPanel {
  private readonly el: HTMLDivElement;
  private readonly addressInput: HTMLInputElement;
  private readonly backBtn: HTMLButtonElement;
  private readonly forwardBtn: HTMLButtonElement;
  private readonly insertCiteBtn: HTMLButtonElement;
  private readonly insertTextBtn: HTMLButtonElement;
  private readonly pickerEl: HTMLDivElement;
  private readonly host = getElectronHost();
  private visible = false;
  private unsubscribeNavState: (() => void) | null = null;
  private dockedEl: HTMLElement | null = null;
  private dockedSlotId: SlotId | null = null;
  private resizeObserver: ResizeObserver | null = null;
  /** True while a dialog/modal is on top and the native view is
   *  hidden for it — see the class doc comment. Distinct from
   *  `visible`: the panel is still logically open, just paused. */
  private pausedForOverlay = false;

  constructor(private readonly opts: ResearchBrowserPanelOpts) {
    // Electron's WebContentsView always paints over ALL same-window DOM
    // content — including modals — regardless of CSS z-index. Pause it
    // (remove the native view; the DOM toolbar/picker are unaffected)
    // whenever ANY dialog opens, and resume when the stack drains, so a
    // "keep unsaved changes?" prompt etc. isn't rendered invisibly behind it.
    onAnyOverlayChange((anyOpen) => {
      if (!this.visible) return;
      if (anyOpen) {
        this.pausedForOverlay = true;
        void this.host?.browserToggle(false);
      } else if (this.pausedForOverlay) {
        this.pausedForOverlay = false;
        void this.host?.browserToggle(true);
        this.syncBounds();
      }
    });
    this.el = document.createElement('div');
    this.el.className = 'research-browser-toolbar';
    this.el.style.display = 'none';

    this.backBtn = document.createElement('button');
    this.backBtn.type = 'button';
    this.backBtn.textContent = '←';
    this.backBtn.title = 'Back';
    this.backBtn.addEventListener('click', () => void this.host?.browserBack());

    this.forwardBtn = document.createElement('button');
    this.forwardBtn.type = 'button';
    this.forwardBtn.textContent = '→';
    this.forwardBtn.title = 'Forward';
    this.forwardBtn.addEventListener('click', () => void this.host?.browserForward());

    const reloadBtn = document.createElement('button');
    reloadBtn.type = 'button';
    reloadBtn.textContent = '⟳';
    reloadBtn.title = 'Reload';
    reloadBtn.addEventListener('click', () => void this.host?.browserReload());

    this.addressInput = document.createElement('input');
    this.addressInput.type = 'text';
    this.addressInput.placeholder = 'Search or enter a URL';
    this.addressInput.className = 'research-browser-address';
    this.addressInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.navigate(this.addressInput.value.trim());
    });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '✕';
    closeBtn.title = 'Close research browser';
    closeBtn.addEventListener('click', () => this.close());

    this.insertCiteBtn = document.createElement('button');
    this.insertCiteBtn.type = 'button';
    this.insertCiteBtn.textContent = 'Insert as Cite';
    this.insertCiteBtn.title = 'AI-format the selected text into a card citation';
    this.insertCiteBtn.addEventListener('click', () => void this.insertAsCite());

    this.insertTextBtn = document.createElement('button');
    this.insertTextBtn.type = 'button';
    this.insertTextBtn.textContent = 'Insert as Text';
    this.insertTextBtn.title = 'Insert the selected text as-is';
    this.insertTextBtn.addEventListener('click', () => void this.insertAsText());

    const navRow = document.createElement('div');
    navRow.className = 'research-browser-nav-row';
    navRow.append(this.backBtn, this.forwardBtn, reloadBtn, this.addressInput, closeBtn);

    const actionRow = document.createElement('div');
    actionRow.className = 'research-browser-action-row';
    actionRow.append(this.insertCiteBtn, this.insertTextBtn);

    this.el.append(navRow, actionRow);

    this.pickerEl = document.createElement('div');
    this.pickerEl.className = 'research-browser-picker';
    this.pickerEl.style.display = 'none';
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.el);
    parent.appendChild(this.pickerEl);
  }

  isVisible(): boolean {
    return this.visible;
  }

  toggle(): void {
    if (this.visible) {
      this.close();
      return;
    }
    if (!researchBrowserEnabled() || !this.host) return;
    if (!multiPaneShellActive()) {
      showToast('Turn on the multi-pane workspace (split view) to use the research browser.');
      return;
    }
    // Prefer an EMPTY pane — auto-expanding the split (one doc open →
    // opens in pane 2; two docs open → pane 3) exactly like opening
    // another doc there would, including the layout mode's compact-
    // thirds vs wide-with-peek rendering. Falls back to picking one of
    // the already-occupied panes to take over only once every pane has
    // a real doc loaded.
    const opened = openResearchBrowserPane();
    if (opened) {
      this.openInPane(opened.id, opened.el);
      return;
    }
    const candidates = researchBrowserSlotCandidates();
    if (candidates.length === 0) {
      showToast('Open a document in a pane first.');
      return;
    }
    if (candidates.length === 1) {
      this.openInPane(candidates[0]!.id, candidates[0]!.el);
      return;
    }
    this.showPicker(candidates);
  }

  private showPicker(candidates: Array<{ id: SlotId; label: string; el: HTMLElement }>): void {
    this.pickerEl.replaceChildren();
    const heading = document.createElement('div');
    heading.className = 'research-browser-picker-heading';
    heading.textContent = 'Open research browser in…';
    this.pickerEl.appendChild(heading);
    for (const c of candidates) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = c.label;
      btn.addEventListener('click', () => {
        this.hidePicker();
        this.openInPane(c.id, c.el);
      });
      this.pickerEl.appendChild(btn);
    }
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'research-browser-picker-cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => this.hidePicker());
    this.pickerEl.appendChild(cancel);
    this.pickerEl.style.display = '';
  }

  private hidePicker(): void {
    this.pickerEl.style.display = 'none';
  }

  private openInPane(id: SlotId, el: HTMLElement): void {
    if (!this.host) return;
    this.dockedEl = el;
    this.dockedSlotId = id;
    setResearchBrowserChipTitle(id, CHIP_TITLE);
    this.visible = true;
    this.el.style.display = '';
    this.opts.toggleButton?.setAttribute('aria-pressed', 'true');
    void this.host.browserToggle(true);
    if (!this.unsubscribeNavState) {
      this.unsubscribeNavState = this.host.onBrowserNavState((state) => {
        this.addressInput.value = state.url;
        this.backBtn.disabled = !state.canGoBack;
        this.forwardBtn.disabled = !state.canGoForward;
      });
    }
    this.resizeObserver = new ResizeObserver(() => this.syncBounds());
    this.resizeObserver.observe(el);
    this.syncBounds();
  }

  private syncBounds(): void {
    const el = this.dockedEl;
    if (!el || !this.visible) return;
    if (!el.isConnected || el.hidden) {
      this.close();
      return;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      this.close();
      return;
    }
    this.el.style.left = `${rect.left}px`;
    this.el.style.top = `${rect.top}px`;
    this.el.style.width = `${rect.width}px`;
    void this.host?.browserSetBounds({
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    });
  }

  private close(): void {
    this.visible = false;
    this.pausedForOverlay = false;
    this.dockedEl = null;
    this.el.style.display = 'none';
    this.opts.toggleButton?.setAttribute('aria-pressed', 'false');
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.hidePicker();
    void this.host?.browserToggle(false);
    if (this.dockedSlotId) setResearchBrowserChipTitle(this.dockedSlotId, null);
    this.dockedSlotId = null;
    // No-op when the browser instead took over an already-occupied
    // pane (nothing was reserved).
    closeResearchBrowserPane();
  }

  private navigate(target: string): void {
    if (!target) return;
    void this.host?.browserNavigate(target);
  }

  private async captureSelection(): Promise<{ text: string; title: string; url: string } | null> {
    if (!this.host) return null;
    const result = await this.host.browserGetSelection();
    if (!result.text.trim()) {
      showToast('Select some text in the research browser first.');
      return null;
    }
    return result;
  }

  private async insertAsText(): Promise<void> {
    const view = this.opts.getFocusedView();
    if (!view) {
      showToast('Open a document to insert into first.');
      return;
    }
    const captured = await this.captureSelection();
    if (!captured) return;
    const text = captured.url ? `${captured.text.trim()} ${captured.url}` : captured.text.trim();
    const tr = buildExternalInsertTransaction(view.state, {
      text,
      role: 'cite',
      newParagraph: true,
    });
    if (tr) view.dispatch(tr);
  }

  private async insertAsCite(): Promise<void> {
    if (!settings.get('aiFeaturesEnabled')) {
      showToast('AI features are disabled — enable them in Settings.');
      return;
    }
    const apiKey = activeApiKey();
    if (!apiKey) {
      showToast('Set an API key in Settings to use AI features.');
      return;
    }
    const view = this.opts.getFocusedView();
    if (!view) {
      showToast('Open a document to insert into first.');
      return;
    }
    const captured = await this.captureSelection();
    if (!captured) return;
    const raw = captured.url ? `${captured.text.trim()}\n${captured.url}` : captured.text.trim();

    const cursor = view.state.selection.from;
    const lease = claimRegion(view, { from: cursor, to: cursor }, { label: 'research-browser-cite' });
    if (!lease) {
      showToast('Another AI edit is working there — click in the document and try again.');
      return;
    }

    this.insertCiteBtn.disabled = true;
    const previousLabel = this.insertCiteBtn.textContent;
    this.insertCiteBtn.textContent = 'Formatting…';
    try {
      const promptTemplate = settings.get('aiCitePrompt').trim() || DEFAULT_AI_CITE_PROMPT;
      const reply = await callLlm({
        apiKey,
        system: resolveCitePrompt(promptTemplate),
        messages: [{ role: 'user', content: raw }],
      });
      const parsed = parseCiteResponse(reply.text);
      const region = lease.region();
      if (!region) {
        showToast('Cite: the insert point is no longer in the document.');
        return;
      }
      applyCiteToSelection(view, region.from, region.to, parsed, (tr) => lease.apply(tr));
    } catch (e) {
      if (e instanceof LlmError) {
        showToast(`Cite: ${e.message}`);
      } else {
        showToast(`Cite: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      lease.release();
      this.insertCiteBtn.disabled = false;
      this.insertCiteBtn.textContent = previousLabel;
    }
  }
}
