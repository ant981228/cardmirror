// @vitest-environment node
/** The stat-only poller (disk-watch.ts): reports a change once per
 *  on-disk state, re-arms when the owner's baseline catches up, never
 *  reads bytes. */
import { describe, it, expect, vi } from 'vitest';
import { createDiskWatch, type WatchedDoc } from '../../apps/desktop/src/disk-watch.js';

function rig() {
  const docs: WatchedDoc[] = [];
  const disk = new Map<string, { mtimeMs: number; size: number }>();
  const changes: Array<{ path: string; owner: number; mtimeMs: number; size: number }> = [];
  const stat = vi.fn(async (p: string) => {
    const st = disk.get(p);
    if (!st) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return st;
  });
  const watch = createDiskWatch({ list: () => docs, onChanged: (c) => changes.push(c), stat, intervalMs: 999_999 });
  return { docs, disk, changes, stat, watch };
}

describe('disk watch', () => {
  it('reports a differing stat once, not on every tick, and re-arms after the owner writes', async () => {
    const { docs, disk, changes, watch } = rig();
    docs.push({ path: '/d/a.cmir', owner: 1, state: { mtimeMs: 100, size: 10 } });
    disk.set('/d/a.cmir', { mtimeMs: 100, size: 10 });
    await watch.tick();
    expect(changes).toEqual([]);
    disk.set('/d/a.cmir', { mtimeMs: 200, size: 12 }); // partner's version synced down
    await watch.tick();
    await watch.tick();
    expect(changes).toEqual([{ path: '/d/a.cmir', owner: 1, mtimeMs: 200, size: 12 }]);
    disk.set('/d/a.cmir', { mtimeMs: 300, size: 12 }); // and again
    await watch.tick();
    expect(changes.length).toBe(2);
    docs[0]!.state = { mtimeMs: 300, size: 12 }; // the owner reloaded / saved: baseline caught up
    await watch.tick();
    expect(changes.length).toBe(2);
    disk.set('/d/a.cmir', { mtimeMs: 400, size: 12 });
    await watch.tick();
    expect(changes.length, 're-armed').toBe(3);
  });

  it('never reads bytes and tolerates a vanished file', async () => {
    const { docs, disk, changes, stat, watch } = rig();
    docs.push({ path: '/d/gone.cmir', owner: 1, state: { mtimeMs: 1, size: 1 } });
    await watch.tick();
    expect(changes).toEqual([]);
    expect(stat).toHaveBeenCalledTimes(1);
    disk.set('/d/gone.cmir', { mtimeMs: 2, size: 1 });
    await watch.tick();
    expect(changes.length).toBe(1);
  });

  it('forgets paths that are no longer watched', async () => {
    const { docs, disk, changes, watch } = rig();
    docs.push({ path: '/d/a.cmir', owner: 1, state: { mtimeMs: 1, size: 1 } });
    disk.set('/d/a.cmir', { mtimeMs: 2, size: 1 });
    await watch.tick();
    expect(changes.length).toBe(1);
    docs.length = 0; // closed
    await watch.tick();
    docs.push({ path: '/d/a.cmir', owner: 1, state: { mtimeMs: 1, size: 1 } }); // reopened with the old baseline
    await watch.tick();
    expect(changes.length, 'reported afresh for the new registration').toBe(2);
  });
});
