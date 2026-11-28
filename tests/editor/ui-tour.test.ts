// @vitest-environment jsdom

/**
 * UI tour (spotlight onboarding, 2026-08-18). Pinned:
 *  - sequencing: next/back/skip/Esc, Done ends; new order (styles →
 *    char styles → outline → files → speech → read mode → word count
 *    → timer → learn → command bar → ⚙ → finish)
 *  - availability adapter: absent target → adapted centered card (the
 *    single-pane speech-stack case), never a crash or a silent skip;
 *    a target clipped by an overflow ancestor counts as hidden
 *  - null/renamed target degrades to the adapted card (resilience)
 *  - interactive command-bar step: palette open → "type settings"
 *    card; settings dialog open → settings card; dialog close →
 *    auto-advance to the ⚙ step
 *  - home-screen boot: leading create-doc step advances when an
 *    editor mounts
 *  - auto-start policy: fresh profile tours once; a profile with
 *    recent files is marked seen WITHOUT touring
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const qcsState = vi.hoisted(() => ({ open: false }));

vi.mock('../../src/editor/home-screen.js', () => ({
  homeScreen: {
    show: vi.fn(() => document.documentElement.classList.add('pmd-home-active')),
  },
}));

vi.mock('../../src/editor/quick-card-search-ui.js', () => {
  const listeners = new Set<() => void>();
  return {
    quickCardSearchUI: {
      isOpen: () => qcsState.open,
      close: vi.fn(() => {
        qcsState.open = false;
      }),
    },
    onQuickCardSearchOpen: (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    __fireOpen: () => {
      qcsState.open = true;
      for (const cb of listeners) cb();
    },
  };
});

import {
  UiTourController,
  startUiTour,
  maybeAutoStartUiTour,
  onNextUiTourEnd,
} from '../../src/editor/ui-tour.js';
import { settings } from '../../src/editor/settings.js';
import * as qcs from '../../src/editor/quick-card-search-ui.js';

function fakeRect(el: HTMLElement, r: Partial<DOMRect>): void {
  el.getBoundingClientRect = () =>
    ({
      left: 10,
      top: 10,
      width: 80,
      height: 40,
      right: (r.left ?? 10) + (r.width ?? 80),
      bottom: (r.top ?? 10) + (r.height ?? 40),
      ...r,
    }) as DOMRect;
}

function buildChrome(opts: { speech?: boolean } = {}): void {
  const ids = [
    'file-stack',
    'formatting-panel',
    'cite-panel',
    'color-panel',
    'read-mode-btn',
    'word-count-display',
    'timer-toggle-btn',
    'settings-btn',
    'reference-btn',
  ];
  for (const id of ids) {
    const el = document.createElement('div');
    el.id = id;
    fakeRect(el, {});
    document.body.appendChild(el);
  }
  const color = document.getElementById('color-panel')!;
  fakeRect(color, { left: 100, width: 60 });
  if (opts.speech) {
    const s = document.createElement('div');
    s.id = 'speech-stack';
    fakeRect(s, { left: 100 });
    document.body.appendChild(s);
  }
  const nav = document.createElement('div');
  nav.className = 'pmd-nav-panel';
  fakeRect(nav, { left: 0, top: 60, width: 240, height: 400 });
  document.body.appendChild(nav);
  const learn = document.createElement('div');
  const manage = document.createElement('button');
  manage.id = 'manage-flashcards-btn';
  learn.appendChild(manage);
  fakeRect(learn, { left: 200 });
  document.body.appendChild(learn);
  const pm = document.createElement('div');
  pm.className = 'ProseMirror';
  fakeRect(pm, { left: 10, top: 100, width: 500, height: 400 });
  document.body.appendChild(pm);
}

const card = () => document.querySelector<HTMLElement>('.pmd-tour-card');
const btn = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('.pmd-tour-card button')].find(
    (b) => b.textContent === label,
  );

beforeEach(() => {
  qcsState.open = false;
  settings.set('hasSeenUiTour', false);
  settings.set('navPaneVisible', true);
});

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  vi.useRealTimers();
});

describe('UI tour', () => {
  it('walks the full sequence in the settled order and ends on Done', () => {
    buildChrome({ speech: true });
    const tour = new UiTourController();
    tour.start();
    expect(tour.running).toBe(true);

    const expected = [
      'Welcome',
      'The editor',
      'Structural styles',
      'Character styles',
      'The outline',
      'Open, new, save',
      'Speech docs',
      'Read mode',
      'Read time, live',
      'Timer',
      'Study your evidence',
      'One shortcut',
      'Settings, the clickable way',
      'Keyboard reference',
      'That’s the tour',
    ];
    for (const [i, title] of expected.entries()) {
      expect(card()!.textContent).toContain(title);
      if (i < expected.length - 1) btn('Next')!.click();
    }
    btn('Done')!.click();
    expect(tour.running).toBe(false);
    expect(document.querySelector('.pmd-tour')).toBeNull();
  });

  it('Back returns to the previous step; Escape skips out', () => {
    buildChrome();
    const tour = new UiTourController();
    tour.start();
    btn('Next')!.click();
    expect(card()!.textContent).toContain('The editor');
    btn('Back')!.click();
    expect(card()!.textContent).toContain('Welcome');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(tour.running).toBe(false);
  });

  it('a structurally absent target shows the adapted card instead of skipping', () => {
    buildChrome({ speech: false }); // single-pane: no speech stack
    const tour = new UiTourController();
    tour.start();
    for (let i = 0; i < 6; i++) btn('Next')!.click();
    expect(card()!.textContent).toContain('Speech docs');
    expect(card()!.textContent).toContain('three-pane workspace');
    btn('Next')!.click();
    expect(card()!.textContent).toContain('Read mode');
  });

  it('a target mostly clipped by an overflow ancestor counts as hidden', () => {
    buildChrome();
    const clipper = document.createElement('div');
    clipper.style.overflow = 'hidden';
    fakeRect(clipper, { left: 0, top: 0, width: 30, height: 50 });
    const panel = document.getElementById('formatting-panel')!;
    clipper.appendChild(panel); // panel rect 10..90 x, clipper cuts at 30
    document.body.appendChild(clipper);
    const tour = new UiTourController();
    tour.start();
    btn('Next')!.click(); // editor
    btn('Next')!.click(); // styles
    expect(card()!.textContent).toContain('too narrow');
  });

  it('a large scrollable target (the editor) spotlights its visible slice, not the narrow card', () => {
    buildChrome();
    // Editor: 816px-wide page, 5000px tall, inside a 700x600 scroller —
    // mostly clipped by area, but the visible slice is generous.
    const scroller = document.createElement('div');
    scroller.style.overflow = 'auto';
    fakeRect(scroller, { left: 0, top: 60, width: 700, height: 600 });
    const pm = document.querySelector<HTMLElement>('.ProseMirror')!;
    fakeRect(pm, { left: 10, top: 60, width: 816, height: 5000 });
    scroller.appendChild(pm);
    document.body.appendChild(scroller);
    const tour = new UiTourController();
    tour.start();
    btn('Next')!.click(); // editor
    expect(card()!.textContent).toContain('The editor');
    expect(card()!.textContent).not.toContain('too narrow');
    const shade = document.querySelector<HTMLElement>('.pmd-tour-shade')!;
    // Cutout is the clamped visible slice (scroller ∩ viewport), padded.
    expect(parseFloat(shade.style.width)).toBeLessThanOrEqual(700 + 12);
    expect(parseFloat(shade.style.height)).toBeLessThanOrEqual(600 + 12);
  });

  it('a missing/renamed target degrades to the adapted card, not a crash', () => {
    buildChrome();
    document.getElementById('formatting-panel')!.remove();
    const tour = new UiTourController();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tour.start();
    btn('Next')!.click();
    btn('Next')!.click();
    expect(card()!.textContent).toContain('Structural styles');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('target missing'));
    warn.mockRestore();
  });

  it('the command-bar step: palette → type-settings card → settings card → auto-advance on close', () => {
    vi.useFakeTimers();
    buildChrome({ speech: true });
    const tour = new UiTourController();
    tour.start();
    for (let i = 0; i < 11; i++) btn('Next')!.click();
    expect(card()!.textContent).toContain('One shortcut');

    (qcs as unknown as { __fireOpen: () => void }).__fireOpen();
    const palette = document.createElement('div');
    palette.className = 'pmd-qcs';
    fakeRect(palette, { left: 100, top: 300, width: 540, height: 60 });
    document.body.appendChild(palette);
    vi.advanceTimersByTime(300);
    expect(card()!.textContent).toContain('type "settings"');

    // The "command" ran: palette closes, the settings dialog appears.
    qcsState.open = false;
    palette.remove();
    const overlay = document.createElement('div');
    overlay.className = 'pmd-settings-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'pmd-settings-dialog';
    fakeRect(dialog, { left: 100, top: 50, width: 500, height: 400 });
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    vi.advanceTimersByTime(300);
    expect(card()!.textContent).toContain('press Esc to close');

    // The modal closes the way the real one does: it HIDES, staying in
    // the DOM — detection must treat that as closed and auto-advance.
    overlay.style.display = 'none';
    vi.advanceTimersByTime(300);
    expect(card()!.textContent).toContain('Settings, the clickable way');

    // Returning to the step later starts from the shortcut prompt —
    // the hidden-but-present dialog must not read as still open.
    btn('Back')!.click();
    vi.advanceTimersByTime(300);
    expect(card()!.textContent).toContain('Press');
    expect(card()!.textContent).not.toContain('press Esc to close');
  });

  it('the char-styles spotlight covers cite AND color panels in one cutout', () => {
    buildChrome();
    const tour = new UiTourController();
    tour.start();
    for (let i = 0; i < 3; i++) btn('Next')!.click();
    expect(card()!.textContent).toContain('Character styles');
    const shade = document.querySelector<HTMLElement>('.pmd-tour-shade')!;
    // cite-panel spans x 10..90, color-panel x 100..160 — the cutout
    // must span both (plus padding), not ring them separately.
    expect(parseFloat(shade.style.left)).toBeLessThanOrEqual(10);
    expect(parseFloat(shade.style.width)).toBeGreaterThanOrEqual(150);
    expect(document.querySelector<HTMLElement>('.pmd-tour-ring')!.hidden).toBe(true);
  });

  it('centered steps dim via the root and blink the shade out', () => {
    buildChrome();
    const tour = new UiTourController();
    tour.start();
    const root = document.querySelector<HTMLElement>('.pmd-tour')!;
    expect(root.classList.contains('pmd-tour-centered')).toBe(true); // welcome
    btn('Next')!.click(); // editor — spotlighted
    expect(root.classList.contains('pmd-tour-centered')).toBe(false);
  });

  it('home-screen boot: create-doc step leads and advances when an editor mounts', () => {
    vi.useFakeTimers();
    // Home screen, no editor yet.
    const home = document.createElement('div');
    home.className = 'pmd-home-screen';
    const action = document.createElement('button');
    action.className = 'pmd-home-action';
    fakeRect(action, { left: 300, top: 200, width: 200, height: 80 });
    home.appendChild(action);
    document.body.appendChild(home);

    const tour = new UiTourController();
    tour.start();
    btn('Next')!.click();
    expect(card()!.textContent).toContain('Create your first document');

    // "User clicks New document": chrome + editor mount.
    buildChrome({ speech: true });
    vi.advanceTimersByTime(600);
    expect(card()!.textContent).toContain('The editor');
  });

  it('home screen with a hidden editor behind it still gets the create-doc step', () => {
    vi.useFakeTimers();
    buildChrome({ speech: true }); // editor DOM exists (hidden behind home)
    document.documentElement.classList.add('pmd-home-active');
    const home = document.createElement('div');
    home.className = 'pmd-home-screen';
    const action = document.createElement('button');
    action.className = 'pmd-home-action';
    fakeRect(action, { left: 300, top: 200, width: 200, height: 80 });
    home.appendChild(action);
    document.body.appendChild(home);
    try {
      const tour = new UiTourController();
      tour.start();
      btn('Next')!.click();
      expect(card()!.textContent).toContain('Create your first document');
      // "New document" clicked: home deactivates; the editor was there
      // all along — the step advances on the class flip, not on DOM.
      document.documentElement.classList.remove('pmd-home-active');
      vi.advanceTimersByTime(600);
      expect(card()!.textContent).toContain('The editor');
    } finally {
      document.documentElement.classList.remove('pmd-home-active');
    }
  });

  it('backing into create-doc reopens home; Next clicks New document for the user', async () => {
    vi.useFakeTimers();
    buildChrome({ speech: true }); // editor exists, hidden behind home
    document.documentElement.classList.add('pmd-home-active');
    const home = document.createElement('div');
    home.className = 'pmd-home-screen';
    const action = document.createElement('button');
    action.className = 'pmd-home-action';
    fakeRect(action, { left: 300, top: 200, width: 200, height: 80 });
    // The real card's click handler creates the doc + leaves home.
    action.addEventListener('click', () =>
      document.documentElement.classList.remove('pmd-home-active'),
    );
    home.appendChild(action);
    document.body.appendChild(home);
    try {
      const tour = new UiTourController();
      tour.start();
      btn('Next')!.click(); // create-doc
      // Next CREATES the doc instead of skipping the step…
      btn('Next')!.click();
      vi.advanceTimersByTime(600);
      expect(card()!.textContent).toContain('The editor');

      // …and Back from the editor step re-opens home (no glitch loop:
      // with home active again, advanceWhen stays false).
      btn('Back')!.click();
      await vi.advanceTimersByTimeAsync(600);
      expect(document.documentElement.classList.contains('pmd-home-active')).toBe(true);
      expect(card()!.textContent).toContain('Create your first document');
      vi.advanceTimersByTime(600);
      expect(card()!.textContent).toContain('Create your first document');
    } finally {
      document.documentElement.classList.remove('pmd-home-active');
    }
  });

  it('arrow keys steer the tour on the command-bar step unless a text input is focused', () => {
    buildChrome({ speech: true });
    const tour = new UiTourController();
    tour.start();
    for (let i = 0; i < 11; i++) btn('Next')!.click();
    expect(card()!.textContent).toContain('One shortcut');

    // Not typing: ArrowLeft backs out of the interactive step.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    expect(card()!.textContent).toContain('Study your evidence');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(card()!.textContent).toContain('One shortcut');

    // Typing into the palette input: arrows belong to the field.
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    expect(card()!.textContent).toContain('One shortcut');
    input.blur();
  });

  it('auto-start tours a fresh profile once and marks upgraders seen without touring', () => {
    vi.useFakeTimers();
    buildChrome({ speech: true });

    // Upgrader: any customized setting marks the tour seen, no overlay.
    settings.set('lastHighlightColor', 'green');
    maybeAutoStartUiTour();
    vi.advanceTimersByTime(2000);
    expect(document.querySelector('.pmd-tour')).toBeNull();
    expect(settings.get('hasSeenUiTour')).toBe(true);

    // Fresh: everything back at defaults (hasSeenUiTour is ignored by
    // the customization check).
    settings.set('lastHighlightColor', 'yellow');
    settings.set('hasSeenUiTour', false);
    maybeAutoStartUiTour();
    vi.advanceTimersByTime(2000);
    expect(document.querySelector('.pmd-tour')).not.toBeNull();
    expect(settings.get('hasSeenUiTour')).toBe(true);
  });

  it('startUiTour marks the tour seen', () => {
    buildChrome();
    startUiTour();
    expect(settings.get('hasSeenUiTour')).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  });

  it('onNextUiTourEnd fires once when a tour ends, and not for later tours', () => {
    buildChrome();
    const ended = vi.fn();
    onNextUiTourEnd(ended);
    const tour = new UiTourController();
    tour.start();
    expect(ended).not.toHaveBeenCalled();
    tour.end();
    expect(ended).toHaveBeenCalledTimes(1);
    const again = new UiTourController();
    again.start();
    again.end();
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('onNextUiTourEnd can be cancelled before the tour ends', () => {
    buildChrome();
    const ended = vi.fn();
    const cancel = onNextUiTourEnd(ended);
    cancel();
    const tour = new UiTourController();
    tour.start();
    tour.end();
    expect(ended).not.toHaveBeenCalled();
  });

  it('maybeAutoStartUiTour reports whether a tour is on its way', () => {
    vi.useFakeTimers();
    settings.set('hasSeenUiTour', true);
    expect(maybeAutoStartUiTour()).toBe(false);
  });
});
