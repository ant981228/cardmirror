// @vitest-environment jsdom
/**
 * The Clod configurator opens on top of the Settings dialog, which owns
 * the keyboard through installModalKeys (every keystroke not aimed at
 * its own controls is swallowed while it is the top overlay). The
 * configurator must register on the overlay stack so the Settings trap
 * stands down — otherwise nothing could be typed into its fields (field
 * report 2026-09-05; broken since the 2026-07-27 modal-key sweep).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { pushOverlay, popOverlay, isAnyOverlayOpen } from '../../src/editor/overlay-stack.js';
import { installModalKeys } from '../../src/editor/text-prompt.js';
import { openClodConfigurator } from '../../src/editor/ai/clod-configurator.js';

function keydownOn(target: Element, key: string): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
  return ev;
}

afterEach(() => {
  document.querySelector('.pmd-clod-overlay')?.remove();
  document.body.innerHTML = '';
});

describe('Clod configurator over the Settings dialog', () => {
  it('typing into its fields is not swallowed by the Settings key trap; Escape closes only the configurator', () => {
    // The Settings dialog: a modal that swallows keys aimed outside itself.
    const settingsDialog = document.createElement('div');
    document.body.appendChild(settingsDialog);
    const settingsToken = pushOverlay();
    let settingsSawEscape = 0;
    const removeSettingsKeys = installModalKeys(settingsDialog, settingsToken, (e) => {
      if (e.key === 'Escape') {
        settingsSawEscape++;
        return true;
      }
      return false;
    });
    try {
      // Sanity: with only Settings open, a key aimed elsewhere IS swallowed.
      const stray = document.createElement('input');
      document.body.appendChild(stray);
      expect(keydownOn(stray, 'a').defaultPrevented).toBe(true);

      openClodConfigurator();
      const overlay = document.querySelector('.pmd-clod-overlay')!;
      expect(overlay).not.toBeNull();
      const nameInput = overlay.querySelector('input')!;
      expect(nameInput).not.toBeNull();

      // Typing into the configurator's own field reaches it.
      expect(keydownOn(nameInput, 'a').defaultPrevented, 'a keystroke into the configurator must not be swallowed').toBe(false);
      // …and Settings' Escape handler is not the one on duty.
      keydownOn(nameInput, 'Escape');
      expect(settingsSawEscape).toBe(0);
      expect(document.querySelector('.pmd-clod-overlay'), 'Escape closed the configurator').toBeNull();

      // The configurator popped its overlay: Settings is on top again and
      // swallows stray keys as before.
      expect(keydownOn(stray, 'b').defaultPrevented).toBe(true);
      keydownOn(stray, 'Escape');
      expect(settingsSawEscape).toBe(1);
    } finally {
      removeSettingsKeys();
      popOverlay(settingsToken);
    }
    expect(isAnyOverlayOpen()).toBe(false);
  });
});
