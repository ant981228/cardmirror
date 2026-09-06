// @vitest-environment jsdom
/**
 * The review session is modal for the keyboard (field report 2026-09-06:
 * with nothing due, Space on the still-focused "Review all due" button
 * stacked another "Nothing due right now" session on every press).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openLearnSession } from '../../src/editor/learn-session-ui.js';

const overlays = () => document.querySelectorAll('.pmd-learn-session-overlay').length;
function pressSpace(target: Element): void {
  const down = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
  target.dispatchEvent(down);
  // jsdom does not synthesize the button's Space activation; emulate the
  // browser: an un-prevented Space keydown on a focused button clicks it.
  if (!down.defaultPrevented && target instanceof HTMLButtonElement && document.activeElement === target) target.click();
  target.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true }));
}

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  document.querySelectorAll('.pmd-learn-session-overlay').forEach((o) => o.remove());
});

describe('review session with nothing due', () => {
  it('moves focus into the panel, so Space cannot re-activate the opener; Space then closes it', () => {
    const btn = document.createElement('button');
    btn.textContent = 'Review all due';
    btn.addEventListener('click', () => openLearnSession({ kind: 'all' }));
    document.body.appendChild(btn);
    btn.focus();
    btn.click();
    expect(overlays()).toBe(1);
    expect(document.body.textContent).toContain('Nothing due right now');
    const panel = document.querySelector('.pmd-learn-session') as HTMLElement;
    expect(document.activeElement, 'focus left the opener').toBe(panel);
    pressSpace(document.activeElement!);
    expect(overlays(), 'Space acted as Done, not as another click on the opener').toBe(0);
    expect(document.activeElement, 'focus handed back to the opener').toBe(btn);
  });

  it('never opens a second session while one is up, even if the opener is clicked again', () => {
    const btn = document.createElement('button');
    btn.addEventListener('click', () => openLearnSession({ kind: 'all' }));
    document.body.appendChild(btn);
    btn.click();
    btn.click();
    btn.click();
    expect(overlays()).toBe(1);
  });
});
