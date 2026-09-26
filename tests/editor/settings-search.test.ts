// @vitest-environment jsdom

/**
 * Settings dialog search box: typing filters every tab down to the
 * matching rows. "search" should surface the Find / File search rows,
 * and "customize toolbar" the ribbon rows — the UI says "ribbon", not
 * "toolbar", so the match has to go through a synonym.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

vi.mock('../../src/editor/toast.js', () => ({ showToast: vi.fn() }));
// benchmark-ui transitively imports editor/index.ts, whose module body
// wires the real app's DOM at import time — fatal in a bare jsdom.
vi.mock('../../src/editor/benchmark-ui.js', () => ({ launchBenchmarkOverlay: vi.fn() }));
// Host kind is switchable per test: the File search rows are desktop-only.
const hostState = vi.hoisted(() => {
  const state = { kind: 'electron' as 'electron' | 'browser' };
  const host = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'kind') return state.kind;
        return () => Promise.resolve({});
      },
    },
  );
  return Object.assign(state, { host });
});
vi.mock('../../src/editor/host/index.js', () => ({
  getElectronHost: () => hostState.host,
  getHost: () => hostState.host,
  isWindowsHost: () => false,
}));

import { openSettings, closeSettings } from '../../src/editor/settings-ui.js';
import { compileSettingsQuery } from '../../src/editor/settings-search.js';

// jsdom lacks ResizeObserver (the modal's tab-strip arrows use one).
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= FakeResizeObserver;

// The dialog is a singleton that stays mounted (just hidden) between
// opens, so only close it — clearing <body> would orphan it.
afterEach(() => {
  closeSettings();
  hostState.kind = 'electron';
});

describe('compileSettingsQuery', () => {
  it('requires every word, in any order, case-insensitively', () => {
    const m = compileSettingsQuery('search file');
    expect(m('File search: exclusions')).toBe(true);
    expect(m('File formats')).toBe(false);
  });

  it('matches "toolbar" against ribbon rows', () => {
    expect(compileSettingsQuery('toolbar')('Ribbon tooltips')).toBe(true);
    expect(compileSettingsQuery('toolb')('Ribbon tooltips')).toBe(true);
  });

  it('drops filler words when something more specific is typed', () => {
    const m = compileSettingsQuery('customize toolbar');
    expect(m('Show doc name in ribbon')).toBe(true);
    expect(m('Custom dash')).toBe(false);
  });

  it('keeps a filler word when it is the whole query', () => {
    const m = compileSettingsQuery('customize');
    expect(m('Custom ribbon buttons')).toBe(true);
    expect(m('Theme')).toBe(false);
  });

  it('matches everything on an empty query', () => {
    expect(compileSettingsQuery('  ')('anything')).toBe(true);
  });

  it('does not expand one- or two-letter fragments into synonyms', () => {
    expect(compileSettingsQuery('ri')('Ribbon tooltips')).toBe(true);
    expect(compileSettingsQuery('se')('Ribbon tooltips')).toBe(false);
  });
});

function search(query: string): void {
  const input = document.querySelector<HTMLInputElement>('.pmd-settings-search')!;
  input.value = query;
  input.dispatchEvent(new Event('input'));
}

/** Titles of the setting rows the search left visible. */
function visibleRowTitles(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.pmd-settings-panel')]
    .filter((p) => !p.hidden)
    .flatMap((p) => [
      ...p.querySelectorAll<HTMLElement>(':scope > .pmd-settings-row:not(.pmd-settings-search-miss)'),
    ])
    .map((r) => r.querySelector('.pmd-settings-row-title')?.textContent ?? '');
}

describe('settings dialog search', () => {
  it('opens with the search box focused', () => {
    openSettings();
    expect(document.activeElement).toBe(document.querySelector('.pmd-settings-search'));
  });

  it('"search" lists the Find and File search rows across tabs', () => {
    openSettings();
    search('search');
    const dialog = document.querySelector('.pmd-settings-dialog')!;
    expect(dialog.classList.contains('pmd-settings-searching')).toBe(true);
    const titles = visibleRowTitles();
    expect(titles).toContain('Find: remember the last search query');
    expect(titles).toContain('File search: exclusions');
    expect(titles).not.toContain('Theme');
  });

  it('"search" on web lists Find but not the desktop-only File search rows', () => {
    hostState.kind = 'browser';
    openSettings();
    search('search');
    const titles = visibleRowTitles();
    expect(titles).toContain('Find: remember the last search query');
    expect(titles.some((t) => t.startsWith('File search'))).toBe(false);
  });

  it('"customize toolbar" lists the ribbon rows', () => {
    openSettings();
    search('customize toolbar');
    const titles = visibleRowTitles();
    expect(titles).toContain('Custom ribbon buttons');
    expect(titles).toContain('Ribbon tooltips');
    expect(titles.every((t) => /ribbon/i.test(t))).toBe(true);
  });

  it('hides section headings with no matches under them', () => {
    openSettings();
    search('file search');
    const headings = [...document.querySelectorAll<HTMLElement>('.pmd-settings-section-title')]
      .filter((h) => !h.classList.contains('pmd-settings-search-miss'))
      .filter((h) => !h.closest<HTMLElement>('.pmd-settings-panel')!.hidden)
      .map((h) => h.textContent);
    expect(headings).toEqual(['File search']);
  });

  it('shows the empty message when nothing matches', () => {
    openSettings();
    search('zzzz-no-such-setting');
    expect(document.querySelector<HTMLElement>('.pmd-settings-search-empty')!.hidden).toBe(false);
    expect(
      [...document.querySelectorAll<HTMLElement>('.pmd-settings-panel')].every((p) => p.hidden),
    ).toBe(true);
  });

  it('clearing the search restores the tabbed view on the active tab', () => {
    openSettings();
    search('ribbon');
    search('');
    const dialog = document.querySelector('.pmd-settings-dialog')!;
    expect(dialog.classList.contains('pmd-settings-searching')).toBe(false);
    expect(document.querySelectorAll('.pmd-settings-search-miss')).toHaveLength(0);
    const shown = [...document.querySelectorAll<HTMLElement>('.pmd-settings-panel')].filter(
      (p) => !p.hidden,
    );
    expect(shown).toHaveLength(1);
  });

  it('Escape clears an active search before it closes the dialog', () => {
    openSettings();
    search('ribbon');
    const input = document.querySelector<HTMLInputElement>('.pmd-settings-search')!;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(input.value).toBe('');
    const overlay = document.querySelector<HTMLElement>('.pmd-settings-overlay')!;
    expect(overlay.style.display).toBe('');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(overlay.style.display).toBe('none');
  });
});
