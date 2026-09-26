// @vitest-environment jsdom
/**
 * Switch Window: the `w ` palette source lists the OTHER CardMirror
 * windows (most recently focused first, as main returns them), filters
 * by typed name, and Enter brings the chosen window to the front.
 * Ctrl+Tab while the list is open steps down it, Alt+Tab style. The
 * `switchWindow` command binds Mod-Tab by default and runs view-less.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WindowListEntry } from '../../src/editor/host/electron-host.js';

const hostState = vi.hoisted(() => ({
  windows: [] as WindowListEntry[],
  focused: [] as number[],
  focusResult: true,
}));

vi.mock('../../src/editor/host/index.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/editor/host/index.js')>();
  return {
    ...mod,
    getElectronHost: () => ({
      readFileAtPath: async () => null,
      listWindows: async () => hostState.windows,
      focusWindow: async (id: number) => {
        hostState.focused.push(id);
        return hostState.focusResult;
      },
    }),
  };
});

vi.mock('../../src/editor/file-search-client.js', async () => {
  const { makeFakeFileIndexClient } = await import('./_fake-file-index.js');
  return {
    getFileIndexClient: async () => makeFakeFileIndexClient({ files: [] }),
    setFileIndexClientForTests: () => {},
  };
});

vi.mock('../../src/editor/toast.js', () => ({ showToast: vi.fn() }));

import {
  quickCardSearchUI,
  searchWindowSource,
  windowLabel,
} from '../../src/editor/quick-card-search-ui.js';
import {
  DEFAULT_RIBBON_KEYS,
  RIBBON_COMMAND_IDS,
  ribbonCommandForKey,
} from '../../src/editor/ribbon-commands.js';
import { showToast } from '../../src/editor/toast.js';

function win(id: number, over: Partial<WindowListEntry> = {}): WindowListEntry {
  return {
    windowId: id,
    title: 'CardMirror',
    docNames: [],
    isSpeech: false,
    isOwnWindow: false,
    isMinimized: false,
    ...over,
  };
}

const input = (): HTMLInputElement => document.querySelector<HTMLInputElement>('.pmd-qcs-input')!;

function type(q: string): void {
  input().value = q;
  input().dispatchEvent(new Event('input', { bubbles: true }));
}

function key(k: string, opts: KeyboardEventInit = {}): void {
  input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));
}

const rowNames = (): string[] =>
  [...document.querySelectorAll('.pmd-qcs-row-name')].map((el) => el.textContent ?? '');
const activeName = (): string | null =>
  document.querySelector('.pmd-qcs-row-active .pmd-qcs-row-name')?.textContent ?? null;

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function openOnWindows(): void {
  quickCardSearchUI.open({
    view: null,
    paneEl: null,
    runCommand: () => {},
    openFilePath: () => {},
    initialQuery: 'w ',
  });
}

beforeEach(() => {
  hostState.focused = [];
  hostState.focusResult = true;
  hostState.windows = [
    win(1, { title: 'Speech 1AC.cmir — CardMirror', docNames: ['Speech 1AC.cmir'], isOwnWindow: true }),
    win(2, { title: 'Warming Aff.cmir — CardMirror', docNames: ['Warming Aff.cmir'] }),
    win(3, { title: 'Politics DA.cmir — CardMirror', docNames: ['Politics DA.cmir'], isSpeech: true }),
    win(4, { title: 'CardMirror', isMinimized: true }),
  ];
});

afterEach(() => {
  quickCardSearchUI.close();
  vi.mocked(showToast).mockClear();
});

describe('windowLabel', () => {
  it('prefers the window’s doc names', () => {
    expect(windowLabel(win(1, { docNames: ['A.cmir', 'B.cmir'] }))).toBe('A.cmir · B.cmir');
  });
  it('falls back to the title minus the app suffix', () => {
    expect(windowLabel(win(1, { title: 'Draft — CardMirror' }))).toBe('Draft');
  });
  it('names a home-screen / untitled window', () => {
    expect(windowLabel(win(1))).toBe('Untitled window');
  });
});

describe('searchWindowSource', () => {
  it('skips the asking window and keeps main’s most-recent-first order', () => {
    const names = searchWindowSource(hostState.windows, '').map((r) => r.name);
    expect(names).toEqual(['Warming Aff.cmir', 'Politics DA.cmir', 'Untitled window']);
  });
  it('requires every typed word, case-insensitively', () => {
    expect(searchWindowSource(hostState.windows, 'da POLI').map((r) => r.name)).toEqual([
      'Politics DA.cmir',
    ]);
    expect(searchWindowSource(hostState.windows, 'speech 1ac')).toEqual([]);
  });
  it('notes speech-doc and minimized windows', () => {
    const rows = searchWindowSource(hostState.windows, '');
    expect(rows.find((r) => r.windowId === 3)!.meta).toBe('Speech doc');
    expect(rows.find((r) => r.windowId === 4)!.meta).toBe('Minimized');
  });
});

describe('Switch Window palette (`w `)', () => {
  it('lists the other windows once main answers', async () => {
    openOnWindows();
    expect(input().value).toBe('w ');
    await settle();
    expect(rowNames()).toEqual(['Warming Aff.cmir', 'Politics DA.cmir', 'Untitled window']);
    expect(activeName()).toBe('Warming Aff.cmir');
  });

  it('filters by typed name and Enter focuses that window', async () => {
    openOnWindows();
    await settle();
    type('w politics');
    expect(rowNames()).toEqual(['Politics DA.cmir']);
    key('Enter');
    await settle();
    expect(hostState.focused).toEqual([3]);
    expect(quickCardSearchUI.isOpen()).toBe(false);
  });

  it('Ctrl+Tab steps down the list; Ctrl+Shift+Tab steps back', async () => {
    openOnWindows();
    await settle();
    key('Tab', { ctrlKey: true });
    expect(activeName()).toBe('Politics DA.cmir');
    key('Tab', { ctrlKey: true });
    expect(activeName()).toBe('Untitled window');
    key('Tab', { ctrlKey: true, shiftKey: true });
    expect(activeName()).toBe('Politics DA.cmir');
    expect(quickCardSearchUI.isInWindowMode()).toBe(true);
  });

  it('says so when this is the only window', async () => {
    hostState.windows = [win(1, { isOwnWindow: true })];
    openOnWindows();
    await settle();
    expect(rowNames()).toEqual([]);
    expect(document.querySelector('.pmd-qcs-empty')!.textContent).toBe(
      'No other CardMirror windows are open.',
    );
  });

  it('toasts when the chosen window closed in the meantime', async () => {
    hostState.focusResult = false;
    openOnWindows();
    await settle();
    key('Enter');
    await settle();
    expect(showToast).toHaveBeenCalledWith('That window has closed.');
  });
});

describe('switchWindow command', () => {
  it('is registered and bound to Mod-Tab by default', () => {
    expect(RIBBON_COMMAND_IDS).toContain('switchWindow');
    expect(DEFAULT_RIBBON_KEYS.switchWindow).toBe('Mod-Tab');
    expect(ribbonCommandForKey('Mod-Tab')).toBe('switchWindow');
  });

  it('is the only command on Mod-Tab', () => {
    const holders = RIBBON_COMMAND_IDS.filter((id) => {
      const spec = DEFAULT_RIBBON_KEYS[id];
      return (Array.isArray(spec) ? spec : [spec]).includes('Mod-Tab');
    });
    expect(holders).toEqual(['switchWindow']);
  });
});
