// @vitest-environment jsdom
/** Disk-conflict state + badge (disk-conflict.ts). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  noteDocRegistered,
  noteDiskChanged,
  noteSavedInPlace,
  noteKeptCopy,
  noteReloaded,
  noteDocReleased,
  diskInfoFor,
  conflictedCopyUserName,
  relativeTime,
  installDiskBadge,
  refreshDiskBadge,
  __resetDiskConflictForTests,
  type DiskBadgeDeps,
} from '../../src/editor/disk-conflict.js';
import { settings } from '../../src/editor/settings.js';

const A = '/Dropbox/Aff.cmir';

function badge(over: Partial<DiskBadgeDeps> & { handle?: string | null; suppressed?: () => boolean } = {}) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  let handle: string | null = over.handle ?? A;
  installDiskBadge(
    {
      getActive: () => ({ handle, name: 'Aff.cmir' }),
      isSuppressed: over.suppressed ?? (() => false),
      isSessionHost: () => false,
      reveal: () => {},
      reloadFromDisk: async () => {},
      keepMineAsCopy: async () => {},
      overwrite: async () => {},
      openOriginal: async () => {},
      ...over,
    },
    { parent },
  );
  const el = document.querySelector('.pmd-disk-badge') as HTMLElement;
  return { el, setHandle: (h: string | null) => (handle = h) };
}

beforeEach(() => __resetDiskConflictForTests());
afterEach(() => {
  __resetDiskConflictForTests();
  document.body.innerHTML = '';
});

describe('state per document', () => {
  it('registration: local vs synced vs changed (journaled baseline no longer matches)', () => {
    noteDocRegistered('/local/x.cmir', 'fresh', null);
    expect(diskInfoFor('/local/x.cmir')?.state).toBe('local');
    noteDocRegistered(A, 'fresh', 'dropbox');
    expect(diskInfoFor(A)?.state).toBe('synced');
    noteDocRegistered('/Dropbox/r.cmir', 'changed', 'dropbox');
    expect(diskInfoFor('/Dropbox/r.cmir')?.state).toBe('changed');
  });

  it('poller change → changed; an accepted in-place save clears it; a reload clears it', () => {
    noteDocRegistered(A, 'fresh', 'dropbox');
    noteDiskChanged(A, 1000);
    expect(diskInfoFor(A)).toMatchObject({ state: 'changed', changedAt: 1000 });
    noteDiskChanged(A, 2000);
    expect(diskInfoFor(A)?.changedAt, 'first sighting is kept').toBe(1000);
    noteSavedInPlace(A);
    expect(diskInfoFor(A)?.state).toBe('synced');
    noteDiskChanged(A);
    noteReloaded(A);
    expect(diskInfoFor(A)?.state).toBe('synced');
  });

  it('a kept copy is marked before its registration and survives it', () => {
    noteDocRegistered(A, 'fresh', 'dropbox');
    noteDiskChanged(A);
    const copy = "/Dropbox/Aff (Anthony's conflicted copy 2026-09-06).cmir";
    noteKeptCopy(copy, A);
    noteDocRegistered(copy, 'fresh', 'dropbox'); // commitSaveResult registers the copy next
    expect(diskInfoFor(copy)).toMatchObject({ state: 'kept-copy', copyOf: A, provider: 'dropbox' });
    noteDocReleased(A);
    expect(diskInfoFor(A)).toBeNull();
  });
});

describe('user name for the copy filename', () => {
  const before = { pairing: settings.get('pairingDisplayName'), author: settings.get('commentAuthor') };
  afterEach(() => {
    settings.set('pairingDisplayName', before.pairing);
    settings.set('commentAuthor', before.author);
  });
  it('co-editing display name, else comment author (not the default "You"), else null for the OS username', () => {
    settings.set('pairingDisplayName', 'Ant');
    settings.set('commentAuthor', 'Anthony T');
    expect(conflictedCopyUserName()).toBe('Ant');
    settings.set('pairingDisplayName', '');
    expect(conflictedCopyUserName()).toBe('Anthony T');
    settings.set('commentAuthor', 'You');
    expect(conflictedCopyUserName()).toBeNull();
  });
});

describe('badge', () => {
  it('is a pill in its own bottom-right tray, styled as the Send/Receive family', () => {
    const { el } = badge();
    expect(el.parentElement?.className).toBe('pmd-pill-tray-right');
    expect(el.classList.contains('pmd-pill')).toBe(true);
    expect(el.querySelector('.pmd-pill-bar .pmd-pill-icon svg')).not.toBeNull();
    expect(el.querySelector('.pmd-pill-bar .pmd-pill-label')).not.toBeNull();
  });

  it('hidden for a local file, provider label when synced, amber text when changed, kept-copy label', () => {
    const { el } = badge();
    noteDocRegistered(A, 'fresh', 'dropbox');
    expect(el.hidden).toBe(false);
    expect(el.getAttribute('data-state')).toBe('synced');
    expect(el.textContent).toContain('Dropbox');
    expect(el.title).toContain('as of last sync');
    expect(document.documentElement.classList.contains('pmd-disk-pill-active')).toBe(true);
    noteDiskChanged(A, Date.now() - 120_000);
    expect(el.getAttribute('data-state')).toBe('changed');
    expect(el.textContent).toContain('Changed on disk 2m ago');
    const copy = '/Dropbox/copy.cmir';
    noteKeptCopy(copy, A);
    const { setHandle } = badge({ handle: copy });
    setHandle(copy);
    refreshDiskBadge();
    expect(el.getAttribute('data-state')).toBe('kept-copy');
    expect(el.textContent).toContain('Conflicted copy');
    noteDocRegistered('/local/x.cmir', 'fresh', null);
    setHandle('/local/x.cmir');
    refreshDiskBadge();
    expect(el.hidden).toBe(true);
    expect(document.documentElement.classList.contains('pmd-disk-pill-active')).toBe(false);
  });

  it('is frozen while suppressed (read mode / timer pop-out) and catches up afterwards', () => {
    let suppressed = false;
    const { el } = badge({ suppressed: () => suppressed });
    noteDocRegistered(A, 'fresh', 'dropbox');
    expect(el.getAttribute('data-state')).toBe('synced');
    suppressed = true;
    noteDiskChanged(A);
    expect(el.getAttribute('data-state'), 'no visible change mid-speech').toBe('synced');
    suppressed = false;
    refreshDiskBadge();
    expect(el.getAttribute('data-state')).toBe('changed');
  });

  it('relativeTime buckets', () => {
    const now = 1_000_000_000;
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2d ago');
  });
});
