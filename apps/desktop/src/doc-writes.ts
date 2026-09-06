/**
 * Document write pipeline — the hardened disk layer under every save.
 *
 * All four document-writing IPC handlers (`host:save-existing`,
 * `host:save-as`, `host:save-send-doc`, `host:write-file-at-path`)
 * route through here, which adds three protections a bare
 * `fs.writeFile` lacks:
 *
 *  1. EXISTENCE CHECK (in-place saves only): a save to a path whose
 *     file was renamed or deleted in Finder/Explorer used to silently
 *     recreate the file at the stale path — forking the document.
 *     `saveExistingDoc` stats first, so the miss surfaces as ENOENT
 *     and the renderer's "file location not found → Save As" rescue
 *     flow takes over.
 *
 *  2. CHANGED-ON-DISK GUARD (in-place saves only): the window that
 *     OWNS a document holds a baseline of its on-disk mtime+size (+
 *     content hash), taken when the window registered the document
 *     after reading it and refreshed by that window's own writes. If
 *     the file changed underneath it — another machine editing through
 *     a synced Dropbox folder is the field case; Dropbox will NOT mint
 *     a "conflicted copy" when the remote version already synced down
 *     before our write — the save is refused with an EMODIFIED-marked
 *     error and the renderer keeps both (a conflicted copy beside the
 *     original). A path with NO baseline for the saving window is
 *     refused the same way: "unknown" is not a bypass (it used to be —
 *     a doc restored from a journal skipped the check; journals now
 *     carry the baseline). Reads by other features — the quick-card
 *     warm pass, transclusion resolution, a second window's open —
 *     record only a CANDIDATE that a window promotes when it registers
 *     the path; they can never re-arm an open document's baseline
 *     (field report 2026-09-06: that re-arming was how partners
 *     silently overwrote each other).
 *
 *  3. ATOMIC WRITES + PER-PATH SERIALIZATION (all doc writes): bytes
 *     stage into a hidden sibling `.cmtmp` file, then rename over the
 *     real path — a crash mid-write can never leave a half-written
 *     document (same pattern as the crash-recovery journals). The
 *     atomicity is best-effort, not absolute: when the rename stays
 *     blocked by another process's hold on the target (a Dropbox
 *     upload on Windows can hold for many seconds), the write falls
 *     back to a plain in-place overwrite rather than failing the save
 *     — the Word model: safety when the filesystem cooperates,
 *     functionality always. Writes to the same path chain onto each
 *     other, so a manual ⌘S landing while an autosave write is still
 *     in flight can't interleave (see the kernel-race note above
 *     `host:write-journal` in main.ts).
 *
 * Both maps are keyed by resolved path. Baselines carry the owning
 * window's id, matching the cross-window duplicate-open guard's
 * invariant that a document is open in at most one window; an in-app
 * rewrite of a path by main itself (docx anchor stamp, bulk compress)
 * refreshes the owner's baseline through `refreshOwnedBaseline`, so
 * only writes by OTHER programs trip the guard.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** Marker embedded in the changed-on-disk error MESSAGE — the renderer
 *  classifies IPC failures by message text (Electron only preserves the
 *  message across the IPC boundary), same as its existing ENOENT check.
 *  Mirrored by `isFileChangedOnDiskError` in src/editor/error-surface.ts. */
export const CHANGED_ON_DISK_MARKER = 'EMODIFIED';

/** Marker for "the target file is transiently locked by another
 *  process" rename failures (same message-marker convention as
 *  EMODIFIED). Mirrored by `fileLockedMessage` in
 *  src/editor/error-surface.ts. */
export const FILE_LOCKED_MARKER = 'ELOCKED';

/** Windows refuses to rename over a file another process holds open
 *  (POSIX doesn't care) — and Dropbox/antivirus grab a freshly-saved
 *  file within milliseconds to sync/scan it. Field report 2026-07-16
 *  (Max U., Windows + Dropbox): two saves seconds apart — the second
 *  save's rename hit Dropbox's upload handle on the FIRST save's
 *  output → EPERM. Scanner holds are sub-second, so this backoff
 *  (~1.5s) absorbs nearly all of them and keeps the write atomic; a
 *  hold that outlives it (a Dropbox upload of a large doc on a slow
 *  uplink runs many seconds) routes to the in-place fallback in
 *  `writeAtomic` instead of failing the save. */
const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800];

function isTransientRenameCode(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface DiskState {
  mtimeMs: number;
  size: number;
  /** sha256 of the bytes CardMirror last read from / wrote to the
   *  path, when the caller had them in hand. Lets the changed-on-disk
   *  guard distinguish metadata churn from real edits: cloud sync
   *  layers rewrite mtimes without touching content — rclone mounts
   *  restat after upload finalization, Dropbox touches timestamps
   *  during sync (field report 2026-08-06, Ethan, Linux + rclone:
   *  every second save refused as changed-on-disk with only
   *  CardMirror writing). */
  contentHash?: string;
}

function hashOf(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** CANDIDATE baselines: what CardMirror last read from / wrote to a
 *  path, whoever asked. Consulted only when a window registers the
 *  path as its open document (`claimBaseline`), never by a save. */
const lastReadState = new Map<string, DiskState>();

/** The guard's source of truth: per open document, the owning window
 *  and the on-disk state it may overwrite. Set by `claimBaseline`
 *  (registration) and by the owner's own writes; cleared on release. */
const baselines = new Map<string, { owner: number; state: DiskState }>();

/** How a registration obtained its baseline. `changed` = the journaled
 *  baseline was adopted but the file on disk already differs from it
 *  (the badge starts amber; the first save keeps both). */
export type ClaimResult = 'fresh' | 'journaled' | 'changed' | 'unknown';

/** Per-path write tails — same serialization pattern as main.ts's
 *  `journalWriteTails`, for the same reason: two overlapping writes to
 *  one path interleave at the kernel level into a torn file. */
const writeTails = new Map<string, Promise<void>>();

function keyFor(filePath: string): string {
  return path.resolve(filePath);
}

/** Chain `task` onto the previous write to the same path. Returns the
 *  task's own promise (rejections propagate to THIS caller); the stored
 *  tail always settles fulfilled so one failed write can't dam the
 *  queue for the session. */
export function chainDocWrite<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const key = keyFor(filePath);
  const previous = writeTails.get(key) ?? Promise.resolve();
  const run = previous.then(task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  writeTails.set(key, tail);
  // GC the chain entry when this write settles — only if we're still
  // the tail (a later write may have chained onto us already).
  void tail.then(() => {
    if (writeTails.get(key) === tail) writeTails.delete(key);
  });
  return run;
}

/** Remember `filePath`'s current on-disk mtime+size — plus a content
 *  hash when the caller passes the bytes it just read/wrote, which
 *  arms the guard's metadata-churn rescue (see DiskState.contentHash)
 *  — as a CANDIDATE baseline. It becomes a window's baseline only when
 *  that window registers the path (`claimBaseline`). Best-effort: a
 *  stat failure (file vanished between read and stat) just leaves no
 *  candidate — never breaks the read that called us. */
export async function recordDiskStateFromDisk(
  filePath: string,
  contentBytes?: Buffer,
): Promise<void> {
  try {
    const st = await fs.stat(filePath);
    lastReadState.set(keyFor(filePath), {
      mtimeMs: st.mtimeMs,
      size: st.size,
      ...(contentBytes !== undefined ? { contentHash: hashOf(contentBytes) } : {}),
    });
  } catch {
    /* best-effort */
  }
}

/** A window registered `filePath` as its open document. The baseline
 *  is the candidate from the read that preceded the mount ('fresh');
 *  with no candidate (a crash-recovered doc mounts from journal bytes
 *  without reading the file) the journal's carried baseline is
 *  adopted — 'journaled' when the file still matches it, 'changed'
 *  when it doesn't; with neither there is no baseline ('unknown') and
 *  the window's first save keeps both. Always re-claims, so a Reload
 *  from disk (read, then re-register) takes the fresh candidate. */
export async function claimBaseline(
  filePath: string,
  ownerId: number,
  journaled?: DiskState | null,
): Promise<ClaimResult> {
  const key = keyFor(filePath);
  const candidate = lastReadState.get(key);
  if (candidate) {
    baselines.set(key, { owner: ownerId, state: candidate });
    return 'fresh';
  }
  if (journaled && typeof journaled.mtimeMs === 'number' && typeof journaled.size === 'number') {
    baselines.set(key, { owner: ownerId, state: { ...journaled } });
    try {
      const st = await fs.stat(filePath);
      return st.mtimeMs === journaled.mtimeMs && st.size === journaled.size ? 'journaled' : 'changed';
    } catch {
      return 'journaled'; // gone / unreadable — the save's stat reports it
    }
  }
  baselines.delete(key);
  return 'unknown';
}

/** The window released the path (close, replace, Save-As away). */
export function releaseBaseline(filePath: string, ownerId: number): void {
  const key = keyFor(filePath);
  if (baselines.get(key)?.owner === ownerId) baselines.delete(key);
}

/** Window gone (closed, crashed): drop everything it owned. */
export function releaseBaselinesForWindow(ownerId: number): void {
  for (const [key, b] of baselines) if (b.owner === ownerId) baselines.delete(key);
}

export function baselineFor(filePath: string): { owner: number; state: DiskState } | undefined {
  return baselines.get(keyFor(filePath));
}

/** Every owned baseline — the disk poller's watch list. */
export function ownedBaselines(): Array<{ path: string; owner: number; state: DiskState }> {
  return [...baselines.entries()].map(([path, b]) => ({ path, owner: b.owner, state: b.state }));
}

/** An in-app rewrite of `filePath` by main itself (docx anchor stamp,
 *  bulk compress): refresh the candidate and, if a window owns the
 *  path, its baseline too, so that window's next save is not refused. */
export async function refreshOwnedBaseline(filePath: string, contentBytes: Buffer): Promise<void> {
  await recordDiskStateFromDisk(filePath, contentBytes);
  const key = keyFor(filePath);
  const candidate = lastReadState.get(key);
  const b = baselines.get(key);
  if (candidate && b) baselines.set(key, { owner: b.owner, state: candidate });
}

function changedOnDiskError(filePath: string, why: string): Error {
  return new Error(
    `${CHANGED_ON_DISK_MARKER}: "${path.basename(filePath)}" ${why} — another program, ` +
      `device, or sync service may have written it.`,
  );
}

/** Stage-then-rename write. The tmp file is dot-prefixed (hidden in
 *  Finder) and lives in the target's own directory so the rename stays
 *  on one filesystem (atomic on POSIX; MoveFileEx-replace on Windows).
 *
 *  When a transient sharing violation outlives the whole retry backoff,
 *  the write falls back to a plain in-place overwrite: replacing an open
 *  file's directory entry needs delete-sharing from EVERY holder of the
 *  file (which sync clients and scanners don't grant), but writing its
 *  bytes needs only write-sharing (which they do) — so the overwrite
 *  succeeds against the same hold that blocks the rename. The tmp file
 *  survives until the overwrite lands: it holds the complete new bytes,
 *  so a crash that tears the non-atomic overwrite still leaves a full
 *  copy on disk next to the (journal-covered) torn target. Only when
 *  even the overwrite fails is the save reported failed, with the
 *  ELOCKED-marked message. Non-transient rename errors clean the tmp
 *  and propagate unchanged. */
async function writeAtomic(
  filePath: string,
  buf: Buffer,
  mode?: number,
  beforeRename?: () => Promise<void>,
): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.cmtmp`);
  await fs.writeFile(tmpPath, buf, mode !== undefined ? { mode } : {});
  // Second look before the rename: writing the tmp file takes real time
  // on a big document, and a synced-down remote version landing in that
  // gap would be replaced by the rename with the guard none the wiser.
  // A stat here shrinks the window to the rename itself.
  if (beforeRename) {
    try {
      await beforeRename();
    } catch (err) {
      await fs.unlink(tmpPath).catch(() => {});
      throw err;
    }
  }
  try {
    // Retry transient sharing violations (see RENAME_RETRY_DELAYS_MS);
    // anything else — and anything that outlives the backoff — throws.
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(tmpPath, filePath);
        break;
      } catch (err) {
        if (attempt >= RENAME_RETRY_DELAYS_MS.length || !isTransientRenameCode(err)) {
          throw err;
        }
        await sleep(RENAME_RETRY_DELAYS_MS[attempt]!);
      }
    }
  } catch (err) {
    if (!isTransientRenameCode(err)) {
      await fs.unlink(tmpPath).catch(() => {});
      throw err;
    }
    try {
      // `mode` only applies if the overwrite has to CREATE the target
      // (possible on the saveNewDoc path); an existing file keeps its
      // own bits, which is the point of writing in place.
      await fs.writeFile(filePath, buf, mode !== undefined ? { mode } : {});
    } catch (fallbackErr) {
      const code =
        (fallbackErr as NodeJS.ErrnoException).code ??
        (err as NodeJS.ErrnoException).code;
      throw new Error(
        `${FILE_LOCKED_MARKER}: "${path.basename(filePath)}" is locked by ` +
          `another program — often Dropbox or an antivirus scanner still ` +
          `processing the previous save. Wait a few seconds and save ` +
          `again. (${code})`,
      );
    }
    // Best-effort: the same scanner hold that blocked the rename may
    // still pin the tmp; the next save rewrites the same tmp path, so
    // a leftover never accumulates.
    await fs.unlink(tmpPath).catch(() => {});
  }
}

/** In-place save to a file that must already exist on disk, by the
 *  window `opts.ownerId` (omit only in tests / callers without a
 *  window, which then use whatever baseline exists).
 *
 *  Throws ENOENT (from the stat) when the file was renamed/deleted —
 *  the renderer's `isFileGoneError` → Save-As rescue path. Throws an
 *  EMODIFIED-marked error when the file changed on disk since the
 *  owner's baseline, when the saving window holds NO baseline for the
 *  path, or when the file moved during the write — unless `opts.force`
 *  (the renderer's explicit, double-confirmed "Overwrite"). Resolves
 *  with the post-write state, which also becomes the owner's baseline. */
export function saveExistingDoc(
  filePath: string,
  buf: Buffer,
  opts?: { force?: boolean; ownerId?: number },
): Promise<DiskState> {
  return chainDocWrite(filePath, async () => {
    // Existence check — a bare writeFile would silently recreate a
    // renamed/deleted file at the stale path.
    const st = await fs.stat(filePath);
    const key = keyFor(filePath);
    const base = baselines.get(key);
    const owned = base !== undefined && (opts?.ownerId === undefined || base.owner === opts.ownerId);
    if (!opts?.force) {
      if (!owned) {
        throw changedOnDiskError(
          filePath,
          'has no baseline in this window (it was not read here, or was restored without one)',
        );
      }
      const known = base.state;
      if (known.mtimeMs !== st.mtimeMs || known.size !== st.size) {
        // Metadata-churn rescue: when we know what the content SHOULD
        // be, a stat mismatch with identical bytes is a sync layer
        // rewriting timestamps (rclone upload finalization, Dropbox
        // touch) — not an edit. Read and compare before refusing; any
        // read failure falls through to the refusal. (This read can
        // hydrate an online-only placeholder; the save watchdog covers
        // that stall — the poller deliberately never reads.)
        let identicalContent = false;
        if (known.contentHash) {
          try {
            identicalContent = hashOf(await fs.readFile(filePath)) === known.contentHash;
          } catch {
            /* unreadable — treat as changed */
          }
        }
        if (!identicalContent) {
          throw changedOnDiskError(filePath, 'changed on disk after CardMirror last read or wrote it');
        }
      }
    }
    // Preserve the existing file's permission bits across the
    // tmp+rename (a plain in-place write would have kept them).
    await writeAtomic(filePath, buf, st.mode & 0o777, async () => {
      if (opts?.force) return;
      const again = await fs.stat(filePath);
      if (again.mtimeMs !== st.mtimeMs || again.size !== st.size) {
        throw changedOnDiskError(filePath, 'changed on disk while CardMirror was writing it');
      }
    });
    await recordDiskStateFromDisk(filePath, buf);
    const after = lastReadState.get(key) ?? { mtimeMs: st.mtimeMs, size: st.size, contentHash: hashOf(buf) };
    // The owner's own write is the new baseline (a forced overwrite by
    // the owner too; a baseline-less forced save leaves none).
    if (base && (opts?.ownerId === undefined || base.owner === opts.ownerId)) {
      baselines.set(key, { owner: base.owner, state: after });
    }
    return after;
  });
}

/** `saveNewDoc({failIfExists})` found the path already occupied. A
 *  class (not a sentinel string) so the IPC layer can distinguish it
 *  from real write failures with instanceof. */
export class DocExistsError extends Error {
  constructor(filePath: string) {
    super(`refusing to overwrite existing file: ${filePath}`);
    this.name = 'DocExistsError';
  }
}

/** Write a document to a path that need not exist yet (Save As, the
 *  silent send-doc/marked-cards exports, bulk convert). No freshness
 *  guard — the user just picked the destination — but the write is
 *  still atomic, serialized, and recorded so a follow-up in-place save
 *  to the same path starts with a fresh baseline.
 *
 *  `failIfExists` (the new-speech-doc auto-save): rejects with
 *  DocExistsError instead of overwriting. The check runs INSIDE the
 *  per-path write chain — every window's writes funnel through this
 *  one serialization, so two rapid create-at-same-path calls cannot
 *  interleave between check and rename. (An unrelated external
 *  process racing the same instant can still win the rename;
 *  writeAtomic has no exclusive mode, and that's outside the guard's
 *  threat model.) */
export function saveNewDoc(
  filePath: string,
  buf: Buffer,
  opts?: { mkdir?: boolean; failIfExists?: boolean },
): Promise<DiskState> {
  return chainDocWrite(filePath, async () => {
    if (opts?.failIfExists) {
      const occupied = await fs.access(filePath).then(
        () => true,
        () => false,
      );
      if (occupied) throw new DocExistsError(filePath);
    }
    if (opts?.mkdir) await fs.mkdir(path.dirname(filePath), { recursive: true });
    await writeAtomic(filePath, buf);
    // Candidate only: the window that adopts this file (Save As, a
    // conflicted copy) registers the path next and promotes it.
    await recordDiskStateFromDisk(filePath, buf);
    return lastReadState.get(keyFor(filePath)) ?? { mtimeMs: 0, size: buf.length, contentHash: hashOf(buf) };
  });
}

/** Sanitize a display name for use inside a filename. */
export function fileNameSafe(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '').replace(/\s+/gu, ' ').trim();
}

/** The path for a conflicted copy of `originalPath`, beside the
 *  original, named the way Dropbox names its own so the file reads as
 *  the convention users already know:
 *  `<name> (<user>'s conflicted copy <YYYY-MM-DD>).<ext>`, with
 *  ` (2)`, ` (3)` … appended when that name is taken. Date only — no
 *  colons (Windows) — and never overwrites an existing copy. */
export async function conflictedCopyPath(
  originalPath: string,
  userName: string,
  day: string,
): Promise<string> {
  const dir = path.dirname(originalPath);
  const ext = path.extname(originalPath);
  // A copy of a conflicted copy (the window switched to the copy, then
  // someone changed THAT file) is the next numbered copy of the
  // original, not a nested "(… conflicted copy …) (… conflicted copy …)".
  const stem = path
    .basename(originalPath, ext)
    .replace(/ \([^()]*'s conflicted copy \d{4}-\d{2}-\d{2}\)( \(\d+\))?$/u, '');
  const user = fileNameSafe(userName) || 'user';
  const suffix = `(${user}'s conflicted copy ${day})`;
  for (let n = 1; ; n++) {
    const candidate = path.join(dir, `${stem} ${suffix}${n > 1 ? ` (${n})` : ''}${ext}`);
    const taken = await fs.access(candidate).then(
      () => true,
      () => false,
    );
    if (!taken) return candidate;
  }
}

/** The deepest existing DIRECTORY on `fromPath`'s ancestor chain —
 *  `fromPath`'s own folder when the path is intact, or the nearest
 *  surviving parent after a rename/move/delete broke some segment.
 *  Used to open the Save-As dialog next to wherever the document's
 *  old location went (Word does the same on a stale-path save).
 *  Null only if nothing on the chain exists (unmounted volume). */
export async function nearestExistingDir(fromPath: string): Promise<string | null> {
  let dir = path.resolve(fromPath);
  for (;;) {
    try {
      // isDirectory guard: an existing FILE on the chain (fromPath
      // itself, or a file squatting on an ancestor name) is not a
      // place a save dialog can open.
      if ((await fs.stat(dir)).isDirectory()) return dir;
    } catch {
      /* segment gone — keep walking up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null; // hit the filesystem root
    dir = parent;
  }
}

/** Test seam — clears every map so vitest cases start cold. */
export function resetDocWritesForTests(): void {
  lastReadState.clear();
  baselines.clear();
  writeTails.clear();
}
