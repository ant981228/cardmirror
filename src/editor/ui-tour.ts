/**
 * UI tour — spotlight onboarding for the editor chrome.
 *
 * A coach-marks overlay: dimmed viewport with a rounded cutout over
 * the current target and a floating card beside it (Back / Next /
 * Skip, step dots, ←/→/Esc). Sequenced as a first session's arc:
 * editor → structural styles → character styles → outline → files →
 * speech → read mode → word count → timer → learn → command bar
 * (interactive: open it, run "settings", tour the opened dialog) →
 * the ⚙ button → finish. A first boot that lands on the home screen
 * gets a leading step that has the user create their first document.
 *
 * Availability adapter: every step resolves its target at entry and
 * on a 250ms reposition tick (animated panes, the palette growing,
 * dialogs opening — none of it goes stale). Visibility is judged by
 * ancestor-clip intersection, not just viewport bounds — the ribbon
 * clips clusters at narrow widths without moving them off-screen. A
 * missing or invisible target NEVER dead-ends or silently skips the
 * step: the card renders centered with adapted copy, and upgrades to
 * a real spotlight if the element becomes visible mid-step. A
 * renamed id degrades the same way plus a console warning.
 *
 * Auto-runs once per FRESH profile (no customized settings); an
 * established profile is marked seen without touring — rerun via the
 * `startUiTour` ribbon command. Desktop layout only: the mobile UI
 * has no ribbon to tour.
 */

import { settings, hasCustomizedSettings } from './settings.js';
import { formatKeyForDisplay } from './ribbon-commands.js';
import { quickCardSearchUI, onQuickCardSearchOpen } from './quick-card-search-ui.js';

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** Resolve the spotlight target; null = centered card. Re-resolved
   *  on every reposition tick. */
  target?: () => HTMLElement | null;
  /** Copy used when the target is structurally absent (e.g. the
   *  speech stack outside three-pane). Falls back to `hiddenBody`. */
  absentBody?: string;
  /** Copy used when the target exists but can't be shown (clipped by
   *  a narrow window). Defaults to a generic widen-the-window note. */
  hiddenBody?: string;
  /** Side effect on entering the step (e.g. reveal the nav pane). */
  prepare?: () => void;
  /** Secondary highlight ring inside/near the main target. */
  ring?: () => HTMLElement | null;
  /** Additional element folded into the SAME spotlight cutout (a
   *  cluster pair that reads as one unit). */
  union?: () => HTMLElement | null;
  /** Steps the user acts through (clicks/keys reach the app). */
  interactive?: boolean;
  /** Checked on the reposition tick; true advances to the next step
   *  (e.g. the create-doc step completing when an editor mounts). */
  advanceWhen?: () => boolean;
}

function el(id: string): () => HTMLElement | null {
  return () => document.getElementById(id);
}

const COMMAND_BAR_STEP_ID = 'command-bar';

function buildSteps(opts: { includeCreateDoc: boolean }): TourStep[] {
  const mod = (k: string) => formatKeyForDisplay(k);
  const steps: TourStep[] = [
    {
      id: 'welcome',
      title: 'Welcome to CardMirror',
      body:
        'A quick tour of the interface — about a minute. Use the buttons or ← → to move, ' +
        'and Esc to skip. You can rerun it any time: it lives in the command bar as ' +
        '"Take the UI Tour".',
    },
  ];
  if (opts.includeCreateDoc) {
    steps.push({
      id: 'create-doc',
      title: 'Create your first document',
      body: 'This is the home screen. Click "New document" — the tour continues inside.',
      target: () => document.querySelector<HTMLElement>('.pmd-home-action'),
      interactive: true,
      advanceWhen: () => !homeScreenActive() && document.querySelector('.ProseMirror') !== null,
      // Backing into this step re-opens the home screen so the New
      // button is actually there to spotlight (lazy import: the home
      // module drags learn/collab UI the tour otherwise never needs).
      prepare: () => {
        if (!homeScreenActive()) {
          void import('./home-screen.js').then((m) => m.homeScreen.show({ canReturnToDoc: true }));
        }
      },
    });
  }
  steps.push(
    {
      id: 'editor',
      title: 'The editor',
      body:
        'This is a live document — everything in it can be typed in, styled, and ' +
        'rearranged. Right-click for cut, copy, and paste.',
      // Spotlight the whole canvas region, not the ProseMirror element
      // — a blank doc's contenteditable is one paragraph tall, which
      // made the cutout a thin strip at the top of an empty editor.
      target: () => {
        const pm = document.querySelector<HTMLElement>('.ProseMirror');
        return pm?.closest<HTMLElement>('#editor, .pmd-pane-editor') ?? pm;
      },
    },
    {
      id: 'styles',
      title: 'Structural styles',
      body:
        'Turn a paragraph into a Pocket, Hat, Block, Tag, Analytic, or Undertag with one ' +
        'click — or one keystroke (F4–F7 and friends; the keyboard reference lists them all).',
      target: el('formatting-panel'),
    },
    {
      id: 'char-styles',
      title: 'Character styles',
      body:
        'F9 underlines, F10 emphasizes, F11 highlights, F8 marks the cite. The color ' +
        'panel beside them handles highlight colors, background shading, and font color.',
      target: el('cite-panel'),
      union: el('color-panel'),
    },
    {
      id: 'nav',
      title: 'The outline',
      body:
        'Every heading those styles create shows up here. Click to jump, double-click to ' +
        'collapse or expand a heading, drag to reorder — and the 1 · 2 · 3 · 4 buttons ' +
        'set how many heading levels you can see in the outline.',
      // #nav-panel is a zero-size wrapper (the visible pane is a
      // position:fixed child) — target the pane itself.
      target: () => document.querySelector<HTMLElement>('.pmd-nav-panel'),
      ring: () => document.querySelector<HTMLElement>('.pmd-nav-level-group'),
      prepare: () => {
        if (!settings.get('navPaneVisible')) settings.set('navPaneVisible', true);
      },
    },
    {
      id: 'files',
      title: 'Open, new, save',
      body:
        'CardMirror reads and writes the same .docx files as Verbatim. Open a real file, ' +
        'start a new one, save — and the fourth button toggles autosave.',
      target: el('file-stack'),
    },
    {
      id: 'speech',
      title: 'Speech docs',
      body:
        'Build the doc you’ll actually read: start a speech, then send cards into it ' +
        'from your prep as you go.',
      absentBody:
        'One more thing lives here when the three-pane workspace is on: the Speech ' +
        'cluster — start a speech doc and send cards into it from your prep as you go. ' +
        'Turn on three panes in ⚙ → General → "Three-pane workspace" to see it.',
      target: el('speech-stack'),
    },
    {
      id: 'read-mode',
      title: 'Read mode',
      body:
        'And this is how you read that speech doc: everything but tags, cites, analytics, ' +
        'and highlighted text hides, and typing is locked so a stray key can’t edit the ' +
        'doc at the podium.',
      target: el('read-mode-btn'),
    },
    {
      id: 'word-count',
      title: 'Read time, live',
      body:
        'The status bar keeps a running read-aloud word count and per-reader read-time ' +
        'estimate as you edit — set your readers and their speeds in Settings.',
      target: el('word-count-display'),
    },
    {
      id: 'timer',
      title: 'Timer',
      body:
        'Speech and prep timers, with presets. It pops out into its own always-on-top ' +
        'window too, for reading off one screen while timing on another.',
      target: el('timer-toggle-btn'),
    },
    {
      id: 'learn',
      title: 'Study your evidence',
      body:
        'Turn evidence into spaced-repetition flashcards: create one from a selection, ' +
        'manage the deck, and watch for the red dot when reviews are due.',
      target: () => document.getElementById('manage-flashcards-btn')?.parentElement ?? null,
    },
    {
      id: COMMAND_BAR_STEP_ID,
      title: 'One shortcut to rule them all',
      body:
        `Press ${mod('Mod-Shift-Space')} now. It opens the command bar — it searches ` +
        'commands, settings, files, and your quick cards from one box. (Or press Next ' +
        'to move on.)',
      interactive: true,
    },
    {
      id: 'settings-btn',
      title: 'Settings, the clickable way',
      body: 'The ⚙ button gets you back to Settings any time.',
      target: el('settings-btn'),
    },
    {
      id: 'reference',
      title: 'Keyboard reference',
      body:
        'Every shortcut on one searchable sheet — the fastest way to pick up the ' +
        'keyboard workflow.',
      target: el('reference-btn'),
    },
    {
      id: 'finish',
      title: 'That’s the tour',
      // No welcome-doc pointer when the starter is toggled off — it
      // would point at a document that isn't there.
      body:
        (settings.get('showOnboardingStarter')
          ? 'The welcome document below walks you through the basics of editing. '
          : '') +
        'Rerun this tour any time from the command bar: "Take the UI Tour". Welcome aboard!',
    },
  );
  return steps;
}

/** Rect visible after clipping by every overflow-clipping ancestor
 *  and the viewport. Returns null unless a solid majority of the
 *  element survives — the ribbon clips clusters at narrow widths
 *  without moving them off-screen, so viewport bounds alone lie. */
function visibleRect(target: HTMLElement): DOMRect | null {
  const r = target.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  let left = r.left;
  let top = r.top;
  let right = r.right;
  let bottom = r.bottom;
  let node = target.parentElement;
  while (node && node !== document.body) {
    const cs = getComputedStyle(node);
    // OR every source: in real browsers the longhands are authoritative,
    // but jsdom leaves them at the default 'visible' while the shorthand
    // (or inline style) carries the truth.
    const clips = (v: string) =>
      v === 'hidden' || v === 'clip' || v === 'auto' || v === 'scroll';
    const shorthand = clips(cs.overflow) || clips(node.style.overflow);
    const ox = clips(cs.overflowX) || clips(node.style.overflowX) || shorthand;
    const oy = clips(cs.overflowY) || clips(node.style.overflowY) || shorthand;
    if (ox || oy) {
      const cr = node.getBoundingClientRect();
      if (ox) {
        left = Math.max(left, cr.left);
        right = Math.min(right, cr.right);
      }
      if (oy) {
        top = Math.max(top, cr.top);
        bottom = Math.min(bottom, cr.bottom);
      }
    }
    node = node.parentElement;
  }
  left = Math.max(left, 0);
  top = Math.max(top, 0);
  right = Math.min(right, window.innerWidth);
  bottom = Math.min(bottom, window.innerHeight);
  const w = right - left;
  const h = bottom - top;
  if (w < 2 || h < 2) return null;
  // "Mostly clipped" counts as hidden — but only for SMALL targets
  // (ribbon clusters cut off by a narrow window). Large surfaces like
  // the editor live inside scrollers and are ALWAYS mostly clipped
  // vertically; a generously-sized visible slice is a fine spotlight.
  const majorityVisible = w * h >= r.width * r.height * 0.5;
  const bigEnoughSlice = w >= 160 && h >= 80;
  if (!majorityVisible && !bigEnoughSlice) return null;
  return new DOMRect(left, top, w, h);
}

const GENERIC_HIDDEN_NOTE =
  ' (Your window is currently too narrow to show it — widen the window and it appears in the ribbon.)';

/** Interactive command-bar phases. */
type CmdPhase = 'ask' | 'palette' | 'settings';

export class UiTourController {
  private steps: TourStep[];
  private index = 0;
  private root: HTMLElement | null = null;
  private shade: HTMLElement | null = null;
  private ring: HTMLElement | null = null;
  private card: HTMLElement | null = null;
  private offPaletteOpen: (() => void) | null = null;
  private cmdPhase: CmdPhase = 'ask';
  private tick: number | null = null;
  private renderedKey = '';
  private readonly onResize = () => this.position();
  private readonly onKey = (e: KeyboardEvent) => {
    if (!this.root) return;
    const step = this.steps[this.index];
    if (e.key === 'Escape') {
      // On interactive steps Esc belongs to whatever the user opened
      // (palette, settings dialog) before it means "skip the tour".
      if (step?.interactive && (quickCardSearchUI.isOpen() || settingsDialogEl() !== null)) return;
      e.preventDefault();
      this.end();
    } else if (e.key === 'ArrowRight' && !typingContext()) {
      e.preventDefault();
      this.next();
    } else if (e.key === 'ArrowLeft' && !typingContext()) {
      e.preventDefault();
      this.back();
    }
  };

  constructor(steps?: TourStep[]) {
    this.steps = steps ?? buildSteps({ includeCreateDoc: homeScreenActive() });
  }

  get running(): boolean {
    return this.root !== null;
  }

  start(): void {
    if (this.root) this.end();
    this.index = 0;
    const root = document.createElement('div');
    root.className = 'pmd-tour';
    // Click-catcher: swallows app clicks while touring. Disabled on
    // interactive steps so the target UI stays reachable.
    const catcher = document.createElement('div');
    catcher.className = 'pmd-tour-catcher';
    root.appendChild(catcher);
    this.shade = document.createElement('div');
    this.shade.className = 'pmd-tour-shade';
    root.appendChild(this.shade);
    this.ring = document.createElement('div');
    this.ring.className = 'pmd-tour-ring';
    this.ring.hidden = true;
    root.appendChild(this.ring);
    this.card = document.createElement('div');
    this.card.className = 'pmd-tour-card';
    root.appendChild(this.card);
    document.body.appendChild(root);
    this.root = root;
    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.onKey, { capture: true });
    // Live reposition: animated panes, the palette growing as results
    // render, dialogs opening — a one-shot measure goes stale fast.
    this.tick = window.setInterval(() => this.onTick(), 250);
    this.enter();
  }

  end(): void {
    if (!this.root) return;
    this.offPaletteOpen?.();
    this.offPaletteOpen = null;
    if (this.tick !== null) window.clearInterval(this.tick);
    this.tick = null;
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKey, { capture: true });
    this.root.remove();
    this.root = this.shade = this.ring = this.card = null;
    fireTourEnd();
  }

  /** Leaving the interactive step in EITHER direction tidies up
   *  whatever the user still has open (palette, Settings dialog). */
  private leaveCommandBarCleanup(): void {
    if (this.steps[this.index]?.id !== COMMAND_BAR_STEP_ID) return;
    if (quickCardSearchUI.isOpen()) quickCardSearchUI.close();
    if (settingsDialogEl() !== null) {
      void import('./settings-ui.js').then((m) => m.closeSettings());
    }
  }

  next(): void {
    // Next on the create-doc prompt does the creating: click the home
    // screen's New-document card for the user; advanceWhen moves the
    // tour along once the editor takes over.
    const step = this.steps[this.index];
    if (step?.id === 'create-doc' && homeScreenActive()) {
      document.querySelector<HTMLElement>('.pmd-home-action')?.click();
      return;
    }
    this.leaveCommandBarCleanup();
    if (this.index >= this.steps.length - 1) {
      this.end();
      return;
    }
    this.index++;
    this.enter();
  }

  back(): void {
    if (this.index === 0) return;
    this.leaveCommandBarCleanup();
    this.index--;
    this.enter();
  }

  /** Render the current step. */
  private enter(): void {
    if (!this.root || !this.card) return;
    const step = this.steps[this.index]!;
    this.offPaletteOpen?.();
    this.offPaletteOpen = null;
    this.cmdPhase = 'ask';
    this.renderedKey = '';
    try {
      step.prepare?.();
    } catch (err) {
      console.warn('[ui-tour] step prepare failed:', err);
    }
    if (step.id === COMMAND_BAR_STEP_ID) {
      this.offPaletteOpen = onQuickCardSearchOpen(() => {
        this.cmdPhase = 'palette';
        this.position();
      });
    }
    this.root.classList.toggle('pmd-tour-interactive', !!step.interactive);
    this.position();
  }

  /** Reposition tick: dynamic advance conditions + live layout. */
  private onTick(): void {
    const step = this.steps[this.index];
    if (!step) return;
    if (step.advanceWhen?.()) {
      this.next();
      return;
    }
    if (step.id === COMMAND_BAR_STEP_ID) {
      const settingsOpen = settingsDialogEl() !== null;
      if (this.cmdPhase !== 'settings' && settingsOpen) {
        this.cmdPhase = 'settings';
      } else if (this.cmdPhase === 'settings' && !settingsOpen) {
        // They closed Settings — the natural hand-off to the ⚙ step.
        this.next();
        return;
      } else if (this.cmdPhase === 'palette' && !quickCardSearchUI.isOpen() && !settingsOpen) {
        this.cmdPhase = 'ask'; // palette dismissed without running anything
      }
    }
    this.position();
  }

  /** Compute target visibility and lay out shade + card. */
  private position(): void {
    if (!this.root || !this.card || !this.shade || !this.ring) return;
    const step = this.steps[this.index]!;

    // The interactive step's target follows its phase: the palette,
    // then the opened Settings dialog (both render BELOW the tour's
    // z-layer, so the cutout is what lifts them out of the dim).
    let target: HTMLElement | null = null;
    let mode: 'normal' | 'hidden' | 'absent' | CmdPhase = 'normal';
    if (step.id === COMMAND_BAR_STEP_ID) {
      mode = this.cmdPhase;
      if (this.cmdPhase === 'palette') {
        target = document.querySelector<HTMLElement>('.pmd-qcs');
      } else if (this.cmdPhase === 'settings') {
        target = settingsDialogEl();
      }
    } else if (step.target) {
      target = step.target();
      if (target === null) {
        mode = 'absent';
        console.warn(`[ui-tour] step "${step.id}": target missing — showing adapted card`);
      }
    }

    let rect: DOMRect | null = null;
    if (target) {
      rect = visibleRect(target);
      if (!rect) {
        try {
          target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        } catch {
          /* non-scrollable context */
        }
        rect = visibleRect(target);
      }
      if (!rect && mode === 'normal') mode = 'hidden';
      const unionEl = step.union?.() ?? null;
      const ur = rect && unionEl ? visibleRect(unionEl) : null;
      if (rect && ur) {
        const left = Math.min(rect.left, ur.left);
        const top = Math.min(rect.top, ur.top);
        rect = new DOMRect(
          left,
          top,
          Math.max(rect.right, ur.right) - left,
          Math.max(rect.bottom, ur.bottom) - top,
        );
      }
    }

    this.renderCard(step, mode);

    const pad = 6;
    if (rect) {
      this.root.classList.remove('pmd-tour-centered');
      Object.assign(this.shade.style, {
        left: `${rect.left - pad}px`,
        top: `${rect.top - pad}px`,
        width: `${rect.width + pad * 2}px`,
        height: `${rect.height + pad * 2}px`,
      });
      const ringTarget = step.ring?.() ?? null;
      const rr = ringTarget ? visibleRect(ringTarget) : null;
      this.ring.hidden = !rr;
      if (rr) {
        Object.assign(this.ring.style, {
          left: `${rr.left - 3}px`,
          top: `${rr.top - 3}px`,
          width: `${rr.width + 6}px`,
          height: `${rr.height + 6}px`,
        });
      }
      this.placeCardNear(rect);
    } else {
      // Centered card over a uniform dim: the ROOT paints the dim and
      // the shade blinks out entirely — animating it to a corner left
      // a bright sliver crawling across the screen.
      this.root.classList.add('pmd-tour-centered');
      this.ring.hidden = true;
      Object.assign(this.card.style, {
        left: `${Math.max(12, (window.innerWidth - this.card.offsetWidth) / 2)}px`,
        top: `${Math.max(12, (window.innerHeight - this.card.offsetHeight) / 2)}px`,
      });
    }
  }

  /** Card below the target when it fits, above otherwise; clamped. */
  private placeCardNear(r: DOMRect): void {
    if (!this.card) return;
    const cw = this.card.offsetWidth;
    const ch = this.card.offsetHeight;
    const margin = 14;
    let top = r.bottom + margin;
    if (top + ch > window.innerHeight - 12) top = r.top - margin - ch;
    if (top < 12) top = 12;
    let left = r.left + r.width / 2 - cw / 2;
    left = Math.min(Math.max(12, left), window.innerWidth - cw - 12);
    this.card.style.left = `${left}px`;
    this.card.style.top = `${top}px`;
  }

  private renderCard(step: TourStep, mode: 'normal' | 'hidden' | 'absent' | CmdPhase): void {
    if (!this.card) return;
    // Re-rendering every tick would eat button focus/clicks — only
    // rebuild when the content actually changes.
    const key = `${this.index}:${mode}`;
    if (key === this.renderedKey) return;
    this.renderedKey = key;

    let body = step.body;
    if (mode === 'absent') {
      body = step.absentBody ?? step.hiddenBody ?? step.body + GENERIC_HIDDEN_NOTE;
    } else if (mode === 'hidden') {
      body = step.hiddenBody ?? step.body + GENERIC_HIDDEN_NOTE;
    } else if (mode === 'palette') {
      body =
        'That’s the command bar. Now type "settings" and press Enter — the top result ' +
        'opens Settings. (Prefixes narrow the search: "c " commands, "s " settings, ' +
        '"f " files, "q " quick cards.)';
    } else if (mode === 'settings') {
      body =
        'Settings, opened from the keyboard. Everything is adjustable — have a look ' +
        'around, then press Esc to close it and the tour continues.';
    }

    this.card.replaceChildren();
    const title = document.createElement('div');
    title.className = 'pmd-tour-title';
    title.textContent = step.title;
    this.card.appendChild(title);
    const bodyEl = document.createElement('div');
    bodyEl.className = 'pmd-tour-body';
    bodyEl.textContent = body;
    this.card.appendChild(bodyEl);

    const dots = document.createElement('div');
    dots.className = 'pmd-tour-dots';
    this.steps.forEach((_, i) => {
      const d = document.createElement('span');
      d.className = 'pmd-tour-dot' + (i === this.index ? ' pmd-tour-dot-active' : '');
      dots.appendChild(d);
    });
    this.card.appendChild(dots);

    const row = document.createElement('div');
    row.className = 'pmd-tour-buttons';
    const mkBtn = (label: string, cls: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `pmd-settings-btn ${cls}`;
      b.textContent = label;
      b.addEventListener('click', fn);
      row.appendChild(b);
      return b;
    };
    if (this.index < this.steps.length - 1) {
      mkBtn('Skip tour', 'pmd-tour-skip', () => this.end());
    }
    if (this.index > 0) mkBtn('Back', 'pmd-tour-back', () => this.back());
    const last = this.index === this.steps.length - 1;
    const nextBtn = mkBtn(last ? 'Done' : 'Next', 'pmd-tour-next', () => this.next());
    this.card.appendChild(row);
    // Interactive steps need the app to receive clicks/keys — leave
    // focus where it is instead of stealing it into the card.
    if (!step.interactive) nextBtn.focus({ preventScroll: true });
  }
}

/** Whether the home/start screen is showing. The html class is the
 *  authoritative signal — the editor DOM persists HIDDEN behind the
 *  home screen, so "no .ProseMirror" is only true on the very first
 *  boot and misclassifies every later visit. */
/** Arrows must not steer the tour while the user is typing into a
 *  text field (the command-bar input on the interactive step). */
function typingContext(): boolean {
  const ae = document.activeElement;
  return ae instanceof HTMLElement && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA');
}

function homeScreenActive(): boolean {
  return (
    document.documentElement.classList.contains('pmd-home-active') ||
    (document.querySelector('.pmd-home-screen') !== null &&
      document.querySelector('.ProseMirror') === null)
  );
}

function settingsDialogEl(): HTMLElement | null {
  // The settings modal HIDES on close (display:none on the overlay)
  // rather than unmounting — bare presence checks would report it
  // open forever after its first use.
  const overlay = document.querySelector<HTMLElement>('.pmd-settings-overlay');
  if (!overlay || overlay.style.display === 'none') return null;
  return overlay.querySelector<HTMLElement>('.pmd-settings-dialog');
}

let controller: UiTourController | null = null;

const tourEndListeners = new Set<() => void>();

/** Run `cb` once, the next time a tour ends (Done, Skip or Esc).
 *  For one-time prompts that must follow onboarding rather than land
 *  on top of it (window-keys-offer.ts). Returns an unsubscribe. */
export function onNextUiTourEnd(cb: () => void): () => void {
  tourEndListeners.add(cb);
  return () => tourEndListeners.delete(cb);
}

function fireTourEnd(): void {
  const cbs = [...tourEndListeners];
  tourEndListeners.clear();
  for (const cb of cbs) {
    try {
      cb();
    } catch (err) {
      console.warn('[ui-tour] end listener failed', err);
    }
  }
}

/** Start (or restart) the tour. */
export function startUiTour(): void {
  controller?.end();
  controller = new UiTourController();
  settings.set('hasSeenUiTour', true);
  controller.start();
}

/** Auto-start once for fresh profiles. A profile with ANY customized
 *  setting belongs to an established user — the tour postdates them,
 *  and unprompted overlays on upgrade are rude — so it initializes as
 *  already-seen there without touring. Waits for either the editor
 *  chrome or the home screen (a first boot lands on home; the tour's
 *  leading step then walks creating the first document). Returns
 *  whether a tour is on its way (true = it will start once the chrome
 *  is ready), so callers can queue prompts behind it. */
export function maybeAutoStartUiTour(): boolean {
  if (settings.get('hasSeenUiTour')) return false;
  if (hasCustomizedSettings()) {
    settings.set('hasSeenUiTour', true);
    return false;
  }
  let tries = 0;
  const poll = window.setInterval(() => {
    tries++;
    if (settings.get('hasSeenUiTour')) {
      window.clearInterval(poll);
      return;
    }
    const ready =
      homeScreenActive() ||
      (document.querySelector('.ProseMirror') !== null &&
        document.getElementById('formatting-panel') !== null);
    if (ready) {
      window.clearInterval(poll);
      startUiTour();
    } else if (tries > 240) {
      window.clearInterval(poll);
    }
  }, 500);
  return true;
}
