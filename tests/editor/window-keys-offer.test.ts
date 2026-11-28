// @vitest-environment jsdom

/**
 * macOS one-time offer to bind Move Window to ⌘ + arrows. Pinned:
 *  - policy: asked once, only on the Mac desktop; moot (recorded as
 *    seen, never asked) when the user already touched those commands'
 *    bindings or bound one of the four keys elsewhere
 *  - answers: "bind" writes exactly the four overrides and keeps the
 *    rest; "leave" writes nothing; "ask me next time" clears the flag
 *    so the next launch asks again
 *  - the proposed keys collide with no built-in default
 *  - sequencing: with a tour coming, nothing is asked until it ends
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { settings } from '../../src/editor/settings.js';
import { DEFAULT_RIBBON_KEYS, ribbonCommandForKey } from '../../src/editor/ribbon-commands.js';
import {
  WINDOW_MOVE_KEYS,
  windowKeysOfferDecision,
  withWindowMoveKeys,
  runWindowKeysOffer,
  scheduleWindowKeysOffer,
  type WindowKeysChoice,
} from '../../src/editor/window-keys-offer.js';

const mac = (prompt: () => Promise<WindowKeysChoice | null>) => ({
  isMacDesktop: () => true,
  prompt,
});

beforeEach(() => {
  settings.set('hasSeenWindowKeysOffer', false);
  settings.set('ribbonKeyOverrides', {});
});

afterEach(() => {
  vi.useRealTimers();
  document.documentElement.classList.remove('pmd-home-active');
});

describe('windowKeysOfferDecision', () => {
  it('asks a Mac desktop profile that has not seen it', () => {
    expect(windowKeysOfferDecision({ seen: false, isMacDesktop: true, overrides: {} })).toBe('ask');
  });

  it('never asks twice', () => {
    expect(windowKeysOfferDecision({ seen: true, isMacDesktop: true, overrides: {} })).toBe('skip');
  });

  it('stays out of the way off the Mac desktop, without consuming the flag', () => {
    expect(windowKeysOfferDecision({ seen: false, isMacDesktop: false, overrides: {} })).toBe('skip');
  });

  it('is moot once the user has bound a Move Window command themselves', () => {
    expect(
      windowKeysOfferDecision({
        seen: false,
        isMacDesktop: true,
        overrides: { moveWindowLeft: 'Mod-Alt-h' },
      }),
    ).toBe('mark-seen');
  });

  it('is moot when a Move Window command was explicitly unbound', () => {
    expect(
      windowKeysOfferDecision({ seen: false, isMacDesktop: true, overrides: { moveWindowUp: [] } }),
    ).toBe('mark-seen');
  });

  it('is moot when one of the four keys already belongs to another command', () => {
    expect(
      windowKeysOfferDecision({
        seen: false,
        isMacDesktop: true,
        overrides: { zoomIn: 'Mod-ArrowUp' },
      }),
    ).toBe('mark-seen');
  });
});

describe('the proposed bindings', () => {
  it('collide with no built-in default key', () => {
    for (const key of Object.values(WINDOW_MOVE_KEYS)) {
      expect(ribbonCommandForKey(key, {})).toBeNull();
    }
  });

  it('name real, default-unbound commands', () => {
    for (const id of Object.keys(WINDOW_MOVE_KEYS)) {
      expect(id in DEFAULT_RIBBON_KEYS).toBe(true);
      expect((DEFAULT_RIBBON_KEYS as Record<string, string | string[]>)[id]).toBe('');
    }
  });

  it('resolve to their commands once written, leaving other overrides alone', () => {
    const next = withWindowMoveKeys({ zoomIn: 'Mod-Alt-9' });
    expect(next.zoomIn).toBe('Mod-Alt-9');
    expect(ribbonCommandForKey('Mod-ArrowLeft', next)).toBe('moveWindowLeft');
    expect(ribbonCommandForKey('Mod-ArrowRight', next)).toBe('moveWindowRight');
    expect(ribbonCommandForKey('Mod-ArrowUp', next)).toBe('moveWindowUp');
    expect(ribbonCommandForKey('Mod-ArrowDown', next)).toBe('moveWindowDown');
    // Shift-select to line start/end is a different chord and stays free.
    expect(ribbonCommandForKey('Shift-Mod-ArrowLeft', next)).toBeNull();
  });
});

describe('runWindowKeysOffer', () => {
  it('"bind" writes the four overrides and records the offer as seen', async () => {
    settings.set('ribbonKeyOverrides', { zoomIn: 'Mod-Alt-9' });
    const prompt = vi.fn(async () => 'bind' as const);
    expect(await runWindowKeysOffer(mac(prompt))).toBe('bound');
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(settings.get('ribbonKeyOverrides')).toEqual({ zoomIn: 'Mod-Alt-9', ...WINDOW_MOVE_KEYS });
    expect(settings.get('hasSeenWindowKeysOffer')).toBe(true);
  });

  it('"leave" changes no bindings and is not asked again', async () => {
    const prompt = vi.fn(async () => 'leave' as const);
    expect(await runWindowKeysOffer(mac(prompt))).toBe('left');
    expect(settings.get('ribbonKeyOverrides')).toEqual({});
    expect(settings.get('hasSeenWindowKeysOffer')).toBe(true);
    expect(await runWindowKeysOffer(mac(prompt))).toBe('not-asked');
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('"ask me next time" leaves everything as it was', async () => {
    const prompt = vi.fn(async () => null);
    expect(await runWindowKeysOffer(mac(prompt))).toBe('deferred');
    expect(settings.get('ribbonKeyOverrides')).toEqual({});
    expect(settings.get('hasSeenWindowKeysOffer')).toBe(false);
    expect(await runWindowKeysOffer(mac(prompt))).toBe('deferred');
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('holds the flag while the dialog is open, so a second window stays quiet', async () => {
    let seenDuringPrompt = false;
    await runWindowKeysOffer(
      mac(async () => {
        seenDuringPrompt = settings.get('hasSeenWindowKeysOffer');
        return null;
      }),
    );
    expect(seenDuringPrompt).toBe(true);
  });

  it('does not ask off the Mac desktop and leaves the flag unset', async () => {
    const prompt = vi.fn(async () => 'bind' as const);
    expect(await runWindowKeysOffer({ isMacDesktop: () => false, prompt })).toBe('not-asked');
    expect(prompt).not.toHaveBeenCalled();
    expect(settings.get('hasSeenWindowKeysOffer')).toBe(false);
  });

  it('records a moot profile as seen without asking', async () => {
    settings.set('ribbonKeyOverrides', { moveWindowDown: 'Mod-Alt-j' });
    const prompt = vi.fn(async () => 'bind' as const);
    expect(await runWindowKeysOffer(mac(prompt))).toBe('not-asked');
    expect(prompt).not.toHaveBeenCalled();
    expect(settings.get('hasSeenWindowKeysOffer')).toBe(true);
    expect(settings.get('ribbonKeyOverrides')).toEqual({ moveWindowDown: 'Mod-Alt-j' });
  });
});

describe('scheduleWindowKeysOffer', () => {
  it('asks once the app is ready when no tour is coming', async () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const prompt = vi.fn(async () => 'leave' as const);
    scheduleWindowKeysOffer(null, mac(prompt));
    await vi.advanceTimersByTimeAsync(1500);
    expect(prompt).not.toHaveBeenCalled(); // nothing on screen yet
    document.documentElement.classList.add('pmd-home-active');
    await vi.advanceTimersByTimeAsync(600);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('waits for the tour to end when one is coming', async () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    document.documentElement.classList.add('pmd-home-active');
    const prompt = vi.fn(async () => 'leave' as const);
    let endTour: () => void = () => {};
    scheduleWindowKeysOffer((cb) => {
      endTour = cb;
    }, mac(prompt));
    await vi.advanceTimersByTimeAsync(5000);
    expect(prompt).not.toHaveBeenCalled(); // tour still running
    endTour();
    await vi.advanceTimersByTimeAsync(1000);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('does not ask while this window is in the background', async () => {
    vi.useFakeTimers();
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    document.documentElement.classList.add('pmd-home-active');
    const prompt = vi.fn(async () => 'leave' as const);
    scheduleWindowKeysOffer(null, mac(prompt));
    await vi.advanceTimersByTimeAsync(3000);
    expect(prompt).not.toHaveBeenCalled();
    focus.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('schedules nothing off the Mac desktop', async () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    document.documentElement.classList.add('pmd-home-active');
    const prompt = vi.fn(async () => 'bind' as const);
    scheduleWindowKeysOffer(null, { isMacDesktop: () => false, prompt });
    await vi.advanceTimersByTimeAsync(3000);
    expect(prompt).not.toHaveBeenCalled();
  });
});
