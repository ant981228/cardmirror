// @vitest-environment node
/**
 * The document write pipeline (doc-writes.ts) — regression coverage for
 * the field failure modes behind the 2026-07 save reports:
 *
 *  - a file renamed/deleted in Finder while open must FAIL the next
 *    in-place save with ENOENT (the old bare writeFile silently
 *    recreated the file at the stale path, forking the document);
 *  - a file rewritten by another program/device (Dropbox syncing down
 *    another machine's edit) must be refused with an EMODIFIED-marked
 *    error unless the caller passes force (the user's explicit
 *    "Overwrite" choice);
 *  - writes stage into a hidden tmp sibling then rename (no torn docs,
 *    no leftovers), and writes to one path are serialized.
 *
 * Real-fs tests in a per-run temp dir — the module IS the disk layer,
 * so mocking fs would test nothing.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  saveExistingDoc,
  saveNewDoc,
  DocExistsError,
  chainDocWrite,
  recordDiskStateFromDisk,
  claimBaseline,
  resetDocWritesForTests,
  nearestExistingDir,
  CHANGED_ON_DISK_MARKER,
  FILE_LOCKED_MARKER,
} from '../../apps/desktop/src/doc-writes.js';

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cardmirror-doc-writes-'));
let caseDir: string;
let n = 0;

beforeEach(async () => {
  resetDocWritesForTests();
  caseDir = path.join(tmpRoot, `case-${n++}`);
  await fs.mkdir(caseDir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const docPath = (name = 'doc.cmir'): string => path.join(caseDir, name);
const read = (p: string): Promise<string> => fs.readFile(p, 'utf8');
const exists = async (p: string): Promise<boolean> =>
  fs.stat(p).then(
    () => true,
    () => false,
  );

/** Open-then-save baseline: the file exists and we've recorded what it
 *  looks like, exactly as a real document open does via readDocumentBytes. */
async function openedDoc(content = 'original', name?: string): Promise<string> {
  const p = docPath(name);
  await fs.writeFile(p, content);
  await recordDiskStateFromDisk(p);
  await claimBaseline(p, 1); // the window registers the doc it just read
  return p;
}

describe('saveExistingDoc — existence check (renamed/deleted file)', () => {
  it('saves in place when the file is present and unchanged', async () => {
    const p = await openedDoc();
    await saveExistingDoc(p, Buffer.from('v2'));
    expect(await read(p)).toBe('v2');
  });

  it('rejects with ENOENT when the file was deleted — and does NOT recreate it', async () => {
    const p = await openedDoc();
    await fs.unlink(p);
    await expect(saveExistingDoc(p, Buffer.from('v2'))).rejects.toThrow(/ENOENT/);
    // The old bare writeFile resurrected the file here; the fork bug.
    expect(await exists(p)).toBe(false);
  });

  it('rejects with ENOENT at the OLD path after a rename — the renamed file is untouched', async () => {
    const p = await openedDoc();
    const renamed = docPath('renamed.cmir');
    await fs.rename(p, renamed);
    await expect(saveExistingDoc(p, Buffer.from('v2'))).rejects.toThrow(/ENOENT/);
    expect(await exists(p)).toBe(false); // no silent fork at the stale path
    expect(await read(renamed)).toBe('original');
  });
});

describe('saveExistingDoc — changed-on-disk guard', () => {
  it('refuses to overwrite a file another program rewrote (size change)', async () => {
    const p = await openedDoc('original');
    await fs.writeFile(p, 'rewritten by another machine'); // different size
    await expect(saveExistingDoc(p, Buffer.from('v2'))).rejects.toThrow(
      new RegExp(CHANGED_ON_DISK_MARKER),
    );
    expect(await read(p)).toBe('rewritten by another machine'); // their version survives
  });

  it('refuses on an mtime-only change (same size)', async () => {
    const p = await openedDoc('original');
    await fs.writeFile(p, 'ORIGINAL'); // same byte length
    // Force a distinct mtime regardless of filesystem timestamp granularity.
    const st = await fs.stat(p);
    await fs.utimes(p, st.atime, new Date(st.mtimeMs + 5000));
    await expect(saveExistingDoc(p, Buffer.from('v2'))).rejects.toThrow(
      new RegExp(CHANGED_ON_DISK_MARKER),
    );
  });

  it('metadata-only churn (identical content, new mtime) passes with a hashed baseline', async () => {
    // Field report 2026-08-06 (Linux + rclone Dropbox mount): the sync
    // layer rewrites the file's mtime after finalizing its upload of
    // OUR OWN save — content untouched. The old mtime+size guard
    // refused every second save as changed-on-disk.
    const p = docPath('churn.cmir');
    await saveNewDoc(p, Buffer.from('my own content')); // baselines WITH hash
    await claimBaseline(p, 1); // the window registers its Save-As
    const st = await fs.stat(p);
    await fs.utimes(p, st.atime, new Date(st.mtimeMs + 5000)); // rclone's touch
    await saveExistingDoc(p, Buffer.from('my own content v2'));
    expect(await read(p)).toBe('my own content v2');
  });

  it('a hashed baseline still refuses a REAL same-size external edit', async () => {
    const p = docPath('real-edit.cmir');
    await saveNewDoc(p, Buffer.from('original'));
    await claimBaseline(p, 1); // the window registers its Save-As
    await fs.writeFile(p, 'ORIGINAL'); // same length, different bytes
    const st = await fs.stat(p);
    await fs.utimes(p, st.atime, new Date(st.mtimeMs + 5000));
    await expect(saveExistingDoc(p, Buffer.from('v2'))).rejects.toThrow(
      new RegExp(CHANGED_ON_DISK_MARKER),
    );
  });

  it('a READ-time baseline with bytes also arms the churn rescue', async () => {
    const p = docPath('read-baseline.cmir');
    await fs.writeFile(p, 'opened contents');
    await recordDiskStateFromDisk(p, Buffer.from('opened contents'));
    await claimBaseline(p, 1);
    const st = await fs.stat(p);
    await fs.utimes(p, st.atime, new Date(st.mtimeMs + 5000));
    await saveExistingDoc(p, Buffer.from('edited in-app'));
    expect(await read(p)).toBe('edited in-app');
  });

  it('force (the explicit Overwrite choice) writes and re-baselines', async () => {
    const p = await openedDoc('original');
    await fs.writeFile(p, 'rewritten elsewhere');
    await saveExistingDoc(p, Buffer.from('v2'), { force: true });
    expect(await read(p)).toBe('v2');
    // The force write re-recorded the baseline: a normal save now passes.
    await saveExistingDoc(p, Buffer.from('v3'));
    expect(await read(p)).toBe('v3');
  });

  it('REFUSES a path with no baseline in this window (unknown is not a bypass; journals carry the baseline)', async () => {
    const p = docPath();
    await fs.writeFile(p, 'on disk');
    // No claim — a fresh process saving a recovered doc without a journaled baseline.
    await expect(saveExistingDoc(p, Buffer.from('recovered'))).rejects.toThrow(CHANGED_ON_DISK_MARKER);
    expect(await read(p)).toBe('on disk');
  });

  it("our own writes don't trip the guard (each save re-baselines)", async () => {
    const p = await openedDoc();
    await saveExistingDoc(p, Buffer.from('v2'));
    await saveExistingDoc(p, Buffer.from('v3 — longer'));
    await saveExistingDoc(p, Buffer.from('v4'));
    expect(await read(p)).toBe('v4');
  });

  it('saveNewDoc (Save As) leaves a candidate the registering window promotes to its baseline', async () => {
    const p = docPath('saved-as.cmir');
    await saveNewDoc(p, Buffer.from('first'));
    expect(await claimBaseline(p, 1), 'the candidate from the write').toBe('fresh');
    await saveExistingDoc(p, Buffer.from('second'));
    expect(await read(p)).toBe('second');
  });
});

describe('atomic writes', () => {
  it('leaves no tmp sibling behind and preserves content byte-for-byte', async () => {
    const p = await openedDoc();
    const payload = 'x'.repeat(64 * 1024);
    await saveExistingDoc(p, Buffer.from(payload));
    expect(await read(p)).toBe(payload);
    const leftovers = (await fs.readdir(caseDir)).filter((f) => f.includes('.cmtmp'));
    expect(leftovers).toEqual([]);
  });

  it('saveNewDoc creates missing parent folders when asked (bulk convert / send doc)', async () => {
    const p = path.join(caseDir, 'sub', 'deeper', 'out.cmir');
    await saveNewDoc(p, Buffer.from('exported'), { mkdir: true });
    expect(await read(p)).toBe('exported');
  });

  it('saveNewDoc failIfExists rejects with DocExistsError and leaves the occupant untouched', async () => {
    const p = docPath('speech.docx');
    await fs.writeFile(p, 'the earlier speech doc');
    await expect(
      saveNewDoc(p, Buffer.from('clobber?'), { failIfExists: true }),
    ).rejects.toBeInstanceOf(DocExistsError);
    expect(await read(p)).toBe('the earlier speech doc');
    // And without the flag the path still writes normally.
    const free = docPath('speech-2.docx');
    await saveNewDoc(free, Buffer.from('fresh'), { failIfExists: true });
    expect(await read(free)).toBe('fresh');
  });

  it('two concurrent failIfExists creates at one path: exactly one wins', async () => {
    // The reason the check lives INSIDE the write chain: fired
    // together, the loser must see the winner's file. With the old
    // access-then-write in the IPC handler, both could pass the
    // check and the second would silently clobber the first.
    const p = docPath('speech.docx');
    const results = await Promise.allSettled([
      saveNewDoc(p, Buffer.from('first'), { failIfExists: true }),
      saveNewDoc(p, Buffer.from('second'), { failIfExists: true }),
    ]);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(['first', 'second']).toContain(await read(p));
  });

  it('preserves the existing file mode across the tmp+rename', async () => {
    if (process.platform === 'win32') return; // POSIX modes only
    const p = await openedDoc();
    await fs.chmod(p, 0o600);
    await saveExistingDoc(p, Buffer.from('v2'));
    expect((await fs.stat(p)).mode & 0o777).toBe(0o600);
  });
});

describe('nearestExistingDir — where the Save-As dialog should open', () => {
  it("an intact file path resolves to the file's own folder", async () => {
    const p = await openedDoc();
    expect(await nearestExistingDir(p)).toBe(caseDir);
  });

  it('a deleted file still resolves to its (surviving) folder', async () => {
    const p = await openedDoc();
    await fs.unlink(p);
    expect(await nearestExistingDir(p)).toBe(caseDir);
  });

  it('a renamed folder resolves to the nearest surviving ancestor (the Word behavior)', async () => {
    // caseDir/tubs/aff/Aff.cmir, then "tubs" gets renamed — the deepest
    // survivor on the old path's chain is caseDir itself.
    const old = path.join(caseDir, 'tubs', 'aff', 'Aff.cmir');
    await fs.mkdir(path.dirname(old), { recursive: true });
    await fs.writeFile(old, 'doc');
    await fs.rename(path.join(caseDir, 'tubs'), path.join(caseDir, 'tubs-2026'));
    expect(await nearestExistingDir(old)).toBe(caseDir);
  });

  it('walks past a FILE squatting on an ancestor name', async () => {
    // caseDir/notes is a file; the stale doc path claims it as a folder.
    await fs.writeFile(path.join(caseDir, 'notes'), 'plain file');
    const stale = path.join(caseDir, 'notes', 'phantom', 'Aff.cmir');
    expect(await nearestExistingDir(stale)).toBe(caseDir);
  });
});

describe('chainDocWrite — per-path serialization', () => {
  it('runs same-path writes strictly in order (no overlap)', async () => {
    const p = docPath();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const first = chainDocWrite(p, async () => {
      events.push('first:start');
      await gate;
      events.push('first:end');
    });
    const second = chainDocWrite(p, async () => {
      events.push('second:start');
    });
    // Give the second task every chance to start early if the chain leaked.
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('a failed write does not dam the queue — the next write still runs', async () => {
    const p = docPath();
    const first = chainDocWrite(p, async () => {
      throw new Error('disk on fire');
    });
    const second = chainDocWrite(p, async () => 'ran');
    await expect(first).rejects.toThrow('disk on fire');
    await expect(second).resolves.toBe('ran');
  });

  it('the manual-⌘S-during-autosave interleave: both writes land, last writer wins', async () => {
    const p = await openedDoc();
    await Promise.all([
      saveExistingDoc(p, Buffer.from('autosave bytes')),
      saveExistingDoc(p, Buffer.from('manual save bytes')),
    ]);
    expect(await read(p)).toBe('manual save bytes');
  });
});

describe('rename retry — transiently locked target (Dropbox/antivirus holds)', () => {
  // Field report 2026-07-16 (Windows + Dropbox): the second of two
  // quick saves hit EPERM because Dropbox still held the first save's
  // output for upload. Windows refuses rename-over-open-file; the
  // retry backoff must absorb sub-second holds and mark longer ones
  // with the friendly ELOCKED message.
  it('absorbs transient EPERM on rename and completes the save', async () => {
    const target = docPath('locked.docx');
    await fs.writeFile(target, 'v1');
    await recordDiskStateFromDisk(target);
    await claimBaseline(target, 1);
    const realRename = fs.rename;
    let failures = 2;
    let calls = 0;
    (fs as { rename: typeof fs.rename }).rename = async (a, b) => {
      calls++;
      if (failures-- > 0) {
        const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return realRename(a, b);
    };
    try {
      await saveExistingDoc(target, Buffer.from('v2'));
    } finally {
      (fs as { rename: typeof fs.rename }).rename = realRename;
    }
    expect(calls).toBe(3);
    expect(await fs.readFile(target, 'utf8')).toBe('v2');
  });

  it('a hold outliving every retry falls back to an in-place overwrite — the save still lands', async () => {
    // The nora field case (2026-07-22, Windows + Dropbox): the upload
    // hold on a multi-MB doc outlives the whole ~1.5s backoff, and
    // waiting + re-saving stays inside the next upload's hold. A plain
    // overwrite only needs write-sharing (which Dropbox grants), so the
    // save must degrade to it instead of failing with ELOCKED.
    const target = docPath('held.docx');
    await fs.writeFile(target, 'v1');
    await recordDiskStateFromDisk(target);
    await claimBaseline(target, 1);
    const realRename = fs.rename;
    (fs as { rename: typeof fs.rename }).rename = async () => {
      const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    };
    try {
      await saveExistingDoc(target, Buffer.from('v2'));
    } finally {
      (fs as { rename: typeof fs.rename }).rename = realRename;
    }
    expect(await fs.readFile(target, 'utf8')).toBe('v2');
    // Fallback landed → the tmp breadcrumb is no longer needed.
    const leftovers = (await fs.readdir(caseDir)).filter((f) => f.includes('cmtmp'));
    expect(leftovers).toEqual([]);
    // The overwrite re-baselined the path: the next ordinary save passes.
    await saveExistingDoc(target, Buffer.from('v3'));
    expect(await fs.readFile(target, 'utf8')).toBe('v3');
  }, 15000);

  it('ELOCKED only when even the in-place fallback fails — and the tmp survives as a breadcrumb', async () => {
    const target = docPath('stuck.docx');
    await fs.writeFile(target, 'v1');
    await recordDiskStateFromDisk(target);
    await claimBaseline(target, 1);
    const realRename = fs.rename;
    const realWrite = fs.writeFile;
    (fs as { rename: typeof fs.rename }).rename = async () => {
      const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    };
    // Tmp writes pass through; the fallback's write to the TARGET fails
    // (a genuinely exclusive hold that refuses even write-sharing).
    (fs as { writeFile: typeof fs.writeFile }).writeFile = (async (
      p: Parameters<typeof fs.writeFile>[0],
      data: Parameters<typeof fs.writeFile>[1],
      opts?: Parameters<typeof fs.writeFile>[2],
    ) => {
      if (String(p).includes('.cmtmp')) return realWrite(p, data, opts);
      const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    }) as typeof fs.writeFile;
    let message = '';
    try {
      await saveExistingDoc(target, Buffer.from('v2'));
    } catch (err) {
      message = (err as Error).message;
    } finally {
      (fs as { rename: typeof fs.rename }).rename = realRename;
      (fs as { writeFile: typeof fs.writeFile }).writeFile = realWrite;
    }
    expect(message).toContain(FILE_LOCKED_MARKER);
    expect(message).toContain('stuck.docx');
    expect(message).toContain('EPERM');
    // Old contents intact; the tmp is KEPT — it holds the complete new
    // bytes in case the failed overwrite tore the target.
    expect(await fs.readFile(target, 'utf8')).toBe('v1');
    const leftovers = (await fs.readdir(caseDir)).filter((f) => f.includes('cmtmp'));
    expect(leftovers).toHaveLength(1);
    expect(await fs.readFile(path.join(caseDir, leftovers[0]!), 'utf8')).toBe('v2');
  }, 15000);

  it('non-transient rename errors propagate immediately (no retry loop)', async () => {
    const target = docPath('hard-fail.docx');
    await fs.writeFile(target, 'v1');
    await recordDiskStateFromDisk(target);
    await claimBaseline(target, 1);
    const realRename = fs.rename;
    let calls = 0;
    (fs as { rename: typeof fs.rename }).rename = async () => {
      calls++;
      const err = new Error('EXDEV: cross-device link') as NodeJS.ErrnoException;
      err.code = 'EXDEV';
      throw err;
    };
    let message = '';
    try {
      await saveExistingDoc(target, Buffer.from('v2'));
    } catch (err) {
      message = (err as Error).message;
    } finally {
      (fs as { rename: typeof fs.rename }).rename = realRename;
    }
    expect(calls).toBe(1);
    expect(message).toContain('EXDEV');
    expect(message).not.toContain(FILE_LOCKED_MARKER);
    // Non-transient errors don't get the in-place fallback: the target
    // is untouched and the tmp is cleaned, not kept as a breadcrumb.
    expect(await fs.readFile(target, 'utf8')).toBe('v1');
    const leftovers = (await fs.readdir(caseDir)).filter((f) => f.includes('cmtmp'));
    expect(leftovers).toEqual([]);
  });
});
