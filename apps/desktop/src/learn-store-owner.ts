/**
 * Learn store OWNER — the main-process side of the flashcard store.
 *
 * Holds the one canonical `LearnStore`, applies the operations windows
 * send (`LearnOp`, see learn-store.ts), writes `learn-store.json`, and
 * tells the caller after each change so it can broadcast the blob to
 * every window. Windows used to write the whole blob themselves; two
 * windows were last-writer-wins and a stale one silently dropped the
 * other's cards (field report 2026-09-05).
 *
 * Writing discipline:
 *   - debounced (bursts of grades coalesce), serialized, tmp → rename;
 *     `flush()` lets the app hold a quit until the last write lands;
 *   - one backup per local day, kept for `keepBackups` days, taken from
 *     the file as it was before that day's first write;
 *   - a file that exists but cannot be read or parsed is NEVER
 *     overwritten: it is set aside as `learn-store.json.unreadable-<ts>`
 *     before the first write, so nothing is lost to a bad read.
 *
 * Bundled by esbuild (imports the shared store from src/editor, outside
 * the desktop tsconfig's rootDir); main.ts requires the bundle.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { LearnStore, applyLearnOp, isLearnOp } from '../../../src/editor/learn-store.js';

export const LEARN_STORE_FILE = 'learn-store.json';
export const LEARN_BACKUP_DIR = 'learn-store-backups';
const BACKUP_NAME = /^learn-store-\d{4}-\d{2}-\d{2}\.json$/u;

export interface LearnStoreOwnerOptions {
  /** The app's data directory (`app.getPath('userData')`). */
  dir: string;
  /** Called with the canonical blob after every applied operation. */
  onChanged?: (json: string) => void;
  /** Clock (tests). */
  now?: () => Date;
  /** Write debounce, ms (default 250). */
  debounceMs?: number;
  /** Daily backups to keep (default 14). */
  keepBackups?: number;
}

export interface LearnStoreOwner {
  /** The canonical blob (loads the file on first use). */
  read(): Promise<string>;
  /** Apply one operation; resolves with the resulting blob. Rejects a
   *  malformed operation without touching the store. */
  apply(op: unknown): Promise<string>;
  /** Write any pending change now; resolves when it is on disk. */
  flush(): Promise<void>;
}

function localDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function stamp(d: Date): string {
  return d.toISOString().replace(/[:.]/gu, '-');
}
function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

export function createLearnStoreOwner(opts: LearnStoreOwnerOptions): LearnStoreOwner {
  const file = path.join(opts.dir, LEARN_STORE_FILE);
  const backupDir = path.join(opts.dir, LEARN_BACKUP_DIR);
  const now = opts.now ?? (() => new Date());
  const debounceMs = opts.debounceMs ?? 250;
  const keep = opts.keepBackups ?? 14;

  const store = new LearnStore();
  let loading: Promise<void> | null = null;
  /** The file exists but could not be read or parsed — set it aside
   *  before the first write instead of overwriting it. */
  let unreadable = false;
  let dirty: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  let writeTail: Promise<void> = Promise.resolve();

  async function load(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (err) {
      if (isEnoent(err)) return;
      unreadable = true;
      console.warn('learn-store: could not read the store; it will be set aside, not overwritten:', err);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    } catch (err) {
      unreadable = true;
      console.warn('learn-store: could not parse the store; it will be set aside, not overwritten:', err);
      return;
    }
    store.loadJson(raw);
  }
  const ensureLoaded = (): Promise<void> => (loading ??= load());

  async function backupDaily(): Promise<void> {
    const target = path.join(backupDir, `learn-store-${localDay(now())}.json`);
    try {
      await fs.access(target);
      return; // today's backup exists
    } catch {
      /* not yet */
    }
    try {
      await fs.access(file);
    } catch {
      return; // nothing to back up before the first write
    }
    try {
      await fs.mkdir(backupDir, { recursive: true });
      await fs.copyFile(file, target);
    } catch (err) {
      console.warn('learn-store: backup failed:', err);
      return;
    }
    try {
      const names = (await fs.readdir(backupDir)).filter((n) => BACKUP_NAME.test(n)).sort();
      for (const n of names.slice(0, Math.max(0, names.length - keep))) {
        await fs.rm(path.join(backupDir, n), { force: true });
      }
    } catch (err) {
      console.warn('learn-store: backup prune failed:', err);
    }
  }

  async function writeNow(json: string): Promise<void> {
    await fs.mkdir(opts.dir, { recursive: true });
    if (unreadable) {
      const aside = `${file}.unreadable-${stamp(now())}`;
      try {
        await fs.rename(file, aside);
        console.warn(`learn-store: unreadable store set aside as ${path.basename(aside)}`);
      } catch (err) {
        if (!isEnoent(err)) throw err;
      }
      unreadable = false;
    } else {
      await backupDaily();
    }
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, json);
    await fs.rename(tmp, file);
  }

  function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const json = dirty;
    dirty = null;
    if (json !== null) {
      writeTail = writeTail
        .catch(() => {})
        .then(() => writeNow(json))
        .catch((err) => {
          console.warn('learn-store: write failed (kept pending):', err);
          dirty ??= json; // the next operation retries
        });
    }
    return writeTail;
  }

  function schedule(json: string): void {
    dirty = json;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, debounceMs);
  }

  return {
    async read() {
      await ensureLoaded();
      return store.toJson();
    },
    async apply(op) {
      if (!isLearnOp(op)) throw new Error('learn-store: malformed operation');
      await ensureLoaded();
      applyLearnOp(store, op);
      const json = store.toJson();
      schedule(json);
      opts.onChanged?.(json);
      return json;
    },
    flush,
  };
}
