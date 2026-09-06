/**
 * Stat-only poller for open documents in cloud-synced folders. One
 * timer stats every watched path each tick and reports a path whose
 * mtime or size differs from the owner's baseline — once per distinct
 * on-disk state, so a change is never reported twice and a baseline
 * refresh (the owner's own write) re-arms it.
 *
 * It NEVER reads file contents: a byte read of an online-only Dropbox /
 * OneDrive placeholder on Windows forces hydration, which can block
 * indefinitely (the 2026-08 hung-save case), and a timer doing that
 * from the main process would wedge the per-path write chain. A sync
 * client touching a timestamp therefore shows as a change; the
 * save-time byte comparison corrects it. Polling, not fs.watch —
 * watchers are unreliable on synced folders.
 */
import { promises as fs } from 'node:fs';

export interface WatchedDoc {
  path: string;
  owner: number;
  state: { mtimeMs: number; size: number };
}

export interface DiskChange {
  path: string;
  owner: number;
  mtimeMs: number;
  size: number;
}

export interface DiskWatchOptions {
  /** The current watch list (owned cloud documents). Called every tick. */
  list: () => WatchedDoc[];
  onChanged: (change: DiskChange) => void;
  intervalMs?: number;
  /** Injectable stat (tests). */
  stat?: (p: string) => Promise<{ mtimeMs: number; size: number }>;
}

export interface DiskWatch {
  start(): void;
  stop(): void;
  /** One poll, awaited — the tick the timer runs; exposed for tests. */
  tick(): Promise<void>;
}

export function createDiskWatch(opts: DiskWatchOptions): DiskWatch {
  const intervalMs = opts.intervalMs ?? 4000;
  const stat = opts.stat ?? (async (p: string) => {
    const st = await fs.stat(p);
    return { mtimeMs: st.mtimeMs, size: st.size };
  });
  /** Last on-disk state reported per path (null = nothing reported). */
  const reported = new Map<string, { mtimeMs: number; size: number }>();
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  async function tick(): Promise<void> {
    if (running) return; // a slow stat (sleeping disk) must not stack ticks
    running = true;
    try {
      const docs = opts.list();
      const live = new Set<string>();
      for (const doc of docs) {
        live.add(doc.path);
        let st: { mtimeMs: number; size: number };
        try {
          st = await stat(doc.path);
        } catch {
          continue; // gone / unreadable: the save's own stat reports it
        }
        const differs = st.mtimeMs !== doc.state.mtimeMs || st.size !== doc.state.size;
        if (!differs) {
          reported.delete(doc.path); // back in step (owner wrote) — re-arm
          continue;
        }
        const last = reported.get(doc.path);
        if (last && last.mtimeMs === st.mtimeMs && last.size === st.size) continue;
        reported.set(doc.path, st);
        opts.onChanged({ path: doc.path, owner: doc.owner, mtimeMs: st.mtimeMs, size: st.size });
      }
      for (const p of reported.keys()) if (!live.has(p)) reported.delete(p);
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
  };
}
