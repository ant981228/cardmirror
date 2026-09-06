/**
 * The learn store owner (main-process side): applies operations to the
 * canonical copy, writes the file debounced and atomically, keeps one
 * backup per day, and sets an unreadable file aside instead of
 * overwriting it (field report 2026-09-05).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createLearnStoreOwner,
  LEARN_STORE_FILE,
  LEARN_BACKUP_DIR,
} from '../../apps/desktop/src/learn-store-owner.js';

const TODAY = '2026-09-05';
const card = (id: string) => ({ id, type: 'qa' as const, front: `Q${id}`, back: `A${id}` });
const upsert = (id: string) => ({ m: 'upsertCard' as const, a: [card(id), TODAY] as [ReturnType<typeof card>, string] });

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-learn-owner-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const readStore = async (): Promise<{ cards: Array<{ id: string }> }> =>
  JSON.parse(await fs.readFile(path.join(dir, LEARN_STORE_FILE), 'utf8')) as { cards: Array<{ id: string }> };

describe('learn store owner', () => {
  it('starts empty without a file, applies operations, writes once per burst, notifies', async () => {
    const seen: string[] = [];
    const owner = createLearnStoreOwner({ dir, onChanged: (j) => seen.push(j), debounceMs: 5 });
    expect(JSON.parse(await owner.read())).toMatchObject({ cards: [] });
    await owner.apply(upsert('c1'));
    await owner.apply(upsert('c2'));
    expect(seen.length).toBe(2);
    await owner.flush();
    expect((await readStore()).cards.map((c) => c.id)).toEqual(['c1', 'c2']);
    await expect(fs.access(path.join(dir, `${LEARN_STORE_FILE}.tmp`))).rejects.toThrow();
  });

  it('rejects a malformed operation without touching the store', async () => {
    const owner = createLearnStoreOwner({ dir, debounceMs: 5 });
    await expect(owner.apply({ m: 'nope', a: [] })).rejects.toThrow(/malformed/u);
    await expect(owner.apply('upsertCard')).rejects.toThrow(/malformed/u);
    await expect(owner.apply({ m: 'loadJson', a: ['{}'] })).rejects.toThrow(/malformed/u);
    await owner.flush();
    await expect(fs.access(path.join(dir, LEARN_STORE_FILE))).rejects.toThrow();
  });

  it('keeps one backup per day of the pre-write file and prunes old ones', async () => {
    let clock = new Date('2026-09-05T10:00:00');
    const owner = createLearnStoreOwner({ dir, now: () => clock, debounceMs: 5, keepBackups: 2 });
    await owner.apply(upsert('c1'));
    await owner.flush(); // first write: nothing existed to back up
    await expect(fs.readdir(path.join(dir, LEARN_BACKUP_DIR))).rejects.toThrow();
    await owner.apply(upsert('c2'));
    await owner.flush(); // same day, second write: today's backup = the c1-only file
    let names = await fs.readdir(path.join(dir, LEARN_BACKUP_DIR));
    expect(names).toEqual(['learn-store-2026-09-05.json']);
    const day1 = JSON.parse(await fs.readFile(path.join(dir, LEARN_BACKUP_DIR, names[0]!), 'utf8')) as { cards: unknown[] };
    expect(day1.cards.length).toBe(1);
    await owner.apply(upsert('c3'));
    await owner.flush(); // still 2026-09-05: no second backup that day
    expect((await fs.readdir(path.join(dir, LEARN_BACKUP_DIR))).length).toBe(1);
    clock = new Date('2026-09-06T10:00:00');
    await owner.apply(upsert('c4'));
    await owner.flush();
    clock = new Date('2026-09-07T10:00:00');
    await owner.apply(upsert('c5'));
    await owner.flush();
    names = (await fs.readdir(path.join(dir, LEARN_BACKUP_DIR))).sort();
    expect(names, 'pruned to the two newest days').toEqual(['learn-store-2026-09-06.json', 'learn-store-2026-09-07.json']);
  });

  it('sets an unreadable file aside instead of overwriting it', async () => {
    await fs.writeFile(path.join(dir, LEARN_STORE_FILE), '{"cards": [truncated');
    const owner = createLearnStoreOwner({ dir, now: () => new Date('2026-09-05T10:00:00Z'), debounceMs: 5 });
    expect(JSON.parse(await owner.read())).toMatchObject({ cards: [] });
    await owner.apply(upsert('fresh'));
    await owner.flush();
    const names = (await fs.readdir(dir)).sort();
    const aside = names.find((n) => n.startsWith(`${LEARN_STORE_FILE}.unreadable-`));
    expect(aside, 'the bad file survives under a new name').toBeDefined();
    expect(await fs.readFile(path.join(dir, aside!), 'utf8')).toBe('{"cards": [truncated');
    expect((await readStore()).cards.map((c) => c.id)).toEqual(['fresh']);
  });

  it('loads an existing file and continues from it', async () => {
    const first = createLearnStoreOwner({ dir, debounceMs: 5 });
    await first.apply(upsert('c1'));
    await first.flush();
    const second = createLearnStoreOwner({ dir, debounceMs: 5 });
    await second.apply(upsert('c2'));
    await second.flush();
    expect((await readStore()).cards.map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('flush with nothing pending resolves at once', async () => {
    const owner = createLearnStoreOwner({ dir });
    await expect(owner.flush()).resolves.toBeUndefined();
  });
});
