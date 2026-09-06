// @vitest-environment node
/**
 * The changed-on-disk guard after the 2026-09-06 rework: the baseline
 * belongs to the window that registered the document, reads by other
 * features can't re-arm it, an unknown baseline is refused (not a
 * bypass), a journaled baseline carries a recovered doc, the file is
 * re-checked right before the rename, and a conflicted copy is named
 * the way Dropbox names its own. Real fs in a temp dir — the module IS
 * the disk layer.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  saveExistingDoc,
  saveNewDoc,
  recordDiskStateFromDisk,
  claimBaseline,
  releaseBaseline,
  releaseBaselinesForWindow,
  baselineFor,
  ownedBaselines,
  refreshOwnedBaseline,
  conflictedCopyPath,
  fileNameSafe,
  resetDocWritesForTests,
  CHANGED_ON_DISK_MARKER,
} from '../../apps/desktop/src/doc-writes.js';

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cardmirror-disk-guard-'));
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

const W1 = 11;
const W2 = 22;
const docPath = (name = 'Aff.cmir'): string => path.join(caseDir, name);
const read = (p: string): Promise<string> => fs.readFile(p, 'utf8');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** What a window's open does: read (candidate), then register (claim). */
async function openInWindow(p: string, owner: number, content = 'original'): Promise<void> {
  await fs.writeFile(p, content);
  await recordDiskStateFromDisk(p, Buffer.from(content));
  expect(await claimBaseline(p, owner)).toBe('fresh');
}
/** Another machine's version syncing down: a distinct mtime + size. */
async function externalWrite(p: string, content: string): Promise<void> {
  await sleep(20);
  await fs.writeFile(p, content);
  const t = new Date(Date.now() + 5000);
  await fs.utimes(p, t, t);
}

describe('owner-keyed baseline', () => {
  it('the owning window saves; a read by another feature does not re-arm the baseline', async () => {
    const p = docPath();
    await openInWindow(p, W1);
    await externalWrite(p, 'partner version');
    // Quick-card warm pass / transclusion resolution / a second window
    // reading the path: candidates only.
    await recordDiskStateFromDisk(p, Buffer.from('partner version'));
    await expect(saveExistingDoc(p, Buffer.from('mine'), { ownerId: W1 })).rejects.toThrow(CHANGED_ON_DISK_MARKER);
    expect(await read(p), 'the partner version survives').toBe('partner version');
  });

  it('a window with no baseline for the path is refused (unknown is not a bypass)', async () => {
    const p = docPath();
    await fs.writeFile(p, 'on disk');
    await expect(saveExistingDoc(p, Buffer.from('mine'), { ownerId: W1 })).rejects.toThrow(/no baseline/u);
    expect(await read(p)).toBe('on disk');
  });

  it("another window cannot save over a path it does not own, even with a candidate", async () => {
    const p = docPath();
    await openInWindow(p, W1);
    await recordDiskStateFromDisk(p, Buffer.from('original')); // W2 read it
    await expect(saveExistingDoc(p, Buffer.from('w2'), { ownerId: W2 })).rejects.toThrow(CHANGED_ON_DISK_MARKER);
    await saveExistingDoc(p, Buffer.from('w1'), { ownerId: W1 });
    expect(await read(p)).toBe('w1');
  });

  it("the owner's own write becomes the new baseline; a later save proceeds", async () => {
    const p = docPath();
    await openInWindow(p, W1);
    const after = await saveExistingDoc(p, Buffer.from('v2'), { ownerId: W1 });
    expect(baselineFor(p)?.state.mtimeMs).toBe(after.mtimeMs);
    await saveExistingDoc(p, Buffer.from('v3'), { ownerId: W1 });
    expect(await read(p)).toBe('v3');
  });

  it('metadata churn (same bytes, new mtime) still saves', async () => {
    const p = docPath();
    await openInWindow(p, W1);
    const t = new Date(Date.now() + 5000);
    await fs.utimes(p, t, t);
    await saveExistingDoc(p, Buffer.from('v2'), { ownerId: W1 });
    expect(await read(p)).toBe('v2');
  });

  it('force (the double-confirmed Overwrite) writes regardless', async () => {
    const p = docPath();
    await openInWindow(p, W1);
    await externalWrite(p, 'partner');
    await saveExistingDoc(p, Buffer.from('mine'), { ownerId: W1, force: true });
    expect(await read(p)).toBe('mine');
  });

  it('release drops the baseline; a window close drops all of its baselines', async () => {
    const a = docPath('a.cmir');
    const b = docPath('b.cmir');
    await openInWindow(a, W1);
    await openInWindow(b, W1);
    releaseBaseline(a, W2); // not the owner: no-op
    expect(baselineFor(a)).toBeDefined();
    releaseBaseline(a, W1);
    expect(baselineFor(a)).toBeUndefined();
    releaseBaselinesForWindow(W1);
    expect(ownedBaselines()).toEqual([]);
  });

  it('an in-app rewrite by main refreshes the owner baseline (docx anchor stamp / bulk compress)', async () => {
    const p = docPath();
    await openInWindow(p, W1);
    await sleep(20);
    await fs.writeFile(p, 'rewritten in-app');
    await refreshOwnedBaseline(p, Buffer.from('rewritten in-app'));
    await saveExistingDoc(p, Buffer.from('next'), { ownerId: W1 });
    expect(await read(p)).toBe('next');
  });
});

describe('journaled baseline (crash recovery)', () => {
  it('a recovered doc whose file is unchanged claims the journaled baseline and saves normally', async () => {
    const p = docPath();
    await openInWindow(p, W1);
    const journaled = baselineFor(p)!.state;
    releaseBaselinesForWindow(W1); // the app died
    resetDocWritesForTests(); // fresh launch: no candidates
    expect(await claimBaseline(p, W1, journaled)).toBe('journaled');
    await saveExistingDoc(p, Buffer.from('after recovery'), { ownerId: W1 });
    expect(await read(p)).toBe('after recovery');
  });

  it('a recovered doc whose file changed while the app was down reports changed and is refused', async () => {
    const p = docPath();
    await openInWindow(p, W1);
    const journaled = baselineFor(p)!.state;
    resetDocWritesForTests();
    await externalWrite(p, 'edited elsewhere meanwhile');
    expect(await claimBaseline(p, W1, journaled)).toBe('changed');
    await expect(saveExistingDoc(p, Buffer.from('recovered'), { ownerId: W1 })).rejects.toThrow(CHANGED_ON_DISK_MARKER);
    expect(await read(p)).toBe('edited elsewhere meanwhile');
  });

  it('with neither a candidate nor a journaled baseline the claim is unknown', async () => {
    const p = docPath();
    await fs.writeFile(p, 'x');
    expect(await claimBaseline(p, W1, null)).toBe('unknown');
    expect(baselineFor(p)).toBeUndefined();
  });

  it('a re-claim after a fresh read (Reload from disk) adopts the new read', async () => {
    const p = docPath();
    await openInWindow(p, W1);
    await externalWrite(p, 'partner');
    await recordDiskStateFromDisk(p, Buffer.from('partner')); // the reload's read
    expect(await claimBaseline(p, W1)).toBe('fresh');
    await saveExistingDoc(p, Buffer.from('mine on top of partner'), { ownerId: W1 });
    expect(await read(p)).toBe('mine on top of partner');
  });
});

describe('second look before the rename', () => {
  it('a file that moves while the temp file is being written is not replaced', async () => {
    const p = docPath();
    await openInWindow(p, W1);
    // Race the write: a large buffer takes long enough that an external
    // write can land between the first stat and the rename.
    const big = Buffer.alloc(8 * 1024 * 1024, 'x');
    const save = saveExistingDoc(p, big, { ownerId: W1 });
    await externalWrite(p, 'landed mid-write');
    let refused = false;
    try {
      await save;
    } catch (err) {
      refused = (err as Error).message.includes(CHANGED_ON_DISK_MARKER);
    }
    const onDisk = await read(p);
    // Either the guard caught it (refused, partner intact) or the
    // external write landed after our rename (then our bytes are on
    // disk and nothing was silently lost). Never: our bytes replacing
    // a partner write that arrived before the rename.
    if (refused) expect(onDisk).toBe('landed mid-write');
    else expect(onDisk === 'landed mid-write' || onDisk.length === big.length).toBe(true);
    const leftovers = (await fs.readdir(caseDir)).filter((f) => f.endsWith('.cmtmp'));
    expect(leftovers).toEqual([]);
  });
});

describe('conflicted copy naming', () => {
  it('names the copy Dropbox-style beside the original and numbers collisions', async () => {
    const p = docPath('Aff.cmir');
    await fs.writeFile(p, 'x');
    const first = await conflictedCopyPath(p, 'Anthony', '2026-09-06');
    expect(path.basename(first)).toBe("Aff (Anthony's conflicted copy 2026-09-06).cmir");
    expect(path.dirname(first)).toBe(caseDir);
    await saveNewDoc(first, Buffer.from('copy 1'));
    const second = await conflictedCopyPath(p, 'Anthony', '2026-09-06');
    expect(path.basename(second)).toBe("Aff (Anthony's conflicted copy 2026-09-06) (2).cmir");
    await saveNewDoc(second, Buffer.from('copy 2'));
    expect(path.basename(await conflictedCopyPath(p, 'Anthony', '2026-09-06'))).toBe(
      "Aff (Anthony's conflicted copy 2026-09-06) (3).cmir",
    );
    expect(await read(first), 'never overwrites an earlier copy').toBe('copy 1');
  });

  it('a copy of a conflicted copy is the next numbered copy of the original', async () => {
    const p = docPath('Aff.cmir');
    await fs.writeFile(p, 'x');
    const first = await conflictedCopyPath(p, 'Anthony', '2026-09-06');
    await saveNewDoc(first, Buffer.from('copy 1'));
    // The window now edits `first`; someone changes it on disk; keep both again.
    const second = await conflictedCopyPath(first, 'Anthony', '2026-09-06');
    expect(path.basename(second)).toBe("Aff (Anthony's conflicted copy 2026-09-06) (2).cmir");
    await saveNewDoc(second, Buffer.from('copy 2'));
    const third = await conflictedCopyPath(second, 'Anthony', '2026-09-07');
    expect(path.basename(third)).toBe("Aff (Anthony's conflicted copy 2026-09-07).cmir");
  });

  it('sanitizes the user name for the filesystem and keeps the extension', async () => {
    const p = docPath('Neg Blocks.docx');
    await fs.writeFile(p, 'x');
    const c = await conflictedCopyPath(p, 'a/b:c*?"<>|  d', '2026-09-06');
    expect(path.basename(c)).toBe("Neg Blocks (abc d's conflicted copy 2026-09-06).docx");
    expect(fileNameSafe('   ')).toBe('');
    expect(path.basename(await conflictedCopyPath(p, '', '2026-09-06'))).toContain("user's conflicted copy");
  });
});
