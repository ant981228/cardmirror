// @vitest-environment jsdom

/**
 * Nav pane text size (`navFontScalePct`, PR #117). Pinned:
 *  - untrusted values are rounded and clamped to 50–200 at the
 *    load/import boundary; non-numbers fall back to 100
 *  - the settings row's number box carries min/max/step and clamps
 *    typed values on both sides (the first number setting with a
 *    ceiling), and a junk entry restores the stored value
 *  - number settings without a ceiling stay unbounded above
 */

import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';

vi.mock('../../src/editor/toast.js', () => ({ showToast: vi.fn() }));
// benchmark-ui transitively imports editor/index.ts, whose module body
// wires the real app's DOM at import time — fatal in a bare jsdom.
vi.mock('../../src/editor/benchmark-ui.js', () => ({ launchBenchmarkOverlay: vi.fn() }));
vi.mock('../../src/editor/host/index.js', () => {
  const host = new Proxy(
    {},
    { get: (_t, prop: string) => (prop === 'kind' ? 'electron' : () => Promise.resolve({})) },
  );
  return { getElectronHost: () => host, getHost: () => host, isWindowsHost: () => false, isMacHost: () => false };
});

import { openSettings, closeSettings } from '../../src/editor/settings-ui.js';
import { settings, SETTING_METADATA } from '../../src/editor/settings.js';

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= FakeResizeObserver;

beforeEach(() => settings.set('navFontScalePct', 100));
afterEach(() => closeSettings());

function importValue(v: unknown): number {
  settings.replaceAll({ ...settings.exportObject(), navFontScalePct: v });
  return settings.get('navFontScalePct');
}

/** The number box in the row whose title is `label`. */
function numberBox(label: string): HTMLInputElement {
  openSettings();
  const row = [...document.querySelectorAll<HTMLElement>('.pmd-settings-row')].find(
    (r) => r.querySelector('.pmd-settings-row-title')?.textContent === label,
  );
  const input = row?.querySelector<HTMLInputElement>('input[type="number"]');
  if (!input) throw new Error(`no number box for "${label}"`);
  return input;
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('change'));
}

describe('navFontScalePct at the load/import boundary', () => {
  it('defaults to 100', () => {
    expect(SETTING_METADATA.find((m) => m.key === 'navFontScalePct')).toMatchObject({
      kind: 'number',
      min: 50,
      max: 200,
    });
    expect(importValue(undefined)).toBe(100);
  });

  it('keeps in-range values, rounding fractions', () => {
    expect(importValue(130)).toBe(130);
    expect(importValue(87.6)).toBe(88);
  });

  it('clamps out-of-range values to 50–200', () => {
    expect(importValue(10)).toBe(50);
    expect(importValue(-40)).toBe(50);
    expect(importValue(999)).toBe(200);
  });

  it('falls back to 100 for non-numbers', () => {
    expect(importValue('150')).toBe(100);
    expect(importValue(null)).toBe(100);
  });
});

describe('the Nav pane text size row', () => {
  it('declares its range and step on the input', () => {
    const input = numberBox('Nav pane text size (%)');
    expect(input.min).toBe('50');
    expect(input.max).toBe('200');
    expect(input.step).toBe('10');
    expect(input.value).toBe('100');
  });

  it('stores an in-range typed value, including one off the step', () => {
    const input = numberBox('Nav pane text size (%)');
    type(input, '135');
    expect(settings.get('navFontScalePct')).toBe(135);
  });

  it('clamps a typed value above the ceiling and shows the clamped number', () => {
    const input = numberBox('Nav pane text size (%)');
    type(input, '500');
    expect(settings.get('navFontScalePct')).toBe(200);
    expect(input.value).toBe('200');
  });

  it('clamps a typed value below the floor', () => {
    const input = numberBox('Nav pane text size (%)');
    type(input, '5');
    expect(settings.get('navFontScalePct')).toBe(50);
    expect(input.value).toBe('50');
  });

  it('restores the stored value when the entry is not a number', () => {
    settings.set('navFontScalePct', 120);
    const input = numberBox('Nav pane text size (%)');
    type(input, '');
    expect(settings.get('navFontScalePct')).toBe(120);
    expect(input.value).toBe('120');
  });
});

describe('number settings without a ceiling', () => {
  it('carry no max attribute', () => {
    openSettings();
    const unbounded = SETTING_METADATA.filter((m) => m.kind === 'number' && m.max === undefined);
    expect(unbounded.length).toBeGreaterThan(0);
    const labels = new Set(unbounded.map((m) => m.label));
    const boxes = [...document.querySelectorAll<HTMLElement>('.pmd-settings-row')]
      .filter((r) => labels.has(r.querySelector('.pmd-settings-row-title')?.textContent ?? ''))
      .map((r) => r.querySelector<HTMLInputElement>('input[type="number"]'))
      .filter((i): i is HTMLInputElement => i !== null);
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) expect(box.max).toBe('');
  });
});
