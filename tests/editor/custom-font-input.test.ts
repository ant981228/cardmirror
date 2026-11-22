// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ bodyFont: 'Times New Roman' } as Record<string, string>));
vi.mock('../../src/editor/settings.js', () => ({
  settings: { get: (k: string) => store[k], set: (k: string, v: string) => (store[k] = v), subscribe: () => () => {} },
}));
vi.mock('../../src/editor/font-detect.js', () => ({ isFontAvailable: (f: string) => f === 'Real Font' }));

import { attachCustomFontInput } from '../../src/editor/custom-font-input.js';

function pick(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event('change'));
}

describe('custom font input', () => {
  it('saves any typed font name and warns when it is not installed', () => {
    const wrap = document.createElement('div');
    const select = document.createElement('select');
    for (const v of ['Arial', '__pmd_other_font__']) select.append(new Option(v, v));
    attachCustomFontInput(wrap, select, 'bodyFont');
    const input = wrap.querySelector('input')!;
    const note = wrap.querySelector('[role=status]')!;

    pick(select, '__pmd_other_font__');
    expect(input.hidden).toBe(false);
    expect(store.bodyFont).toBe('Times New Roman');

    input.value = '"Made Up", serif';
    input.dispatchEvent(new Event('change'));
    expect(store.bodyFont).toBe('Made Up serif');
    expect(note.textContent).toContain('not found');

    input.value = 'Real Font';
    input.dispatchEvent(new Event('change'));
    expect(store.bodyFont).toBe('Real Font');
    expect(note.textContent).toBe('');

    pick(select, 'Arial');
    expect(store.bodyFont).toBe('Arial');
    expect(input.hidden).toBe(true);
  });
});
