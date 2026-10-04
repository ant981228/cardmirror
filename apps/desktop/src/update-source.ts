/**
 * Where auto-update looks for new releases: a GitHub `owner/repo` whose
 * Releases carry electron-builder's `latest*.yml` manifests.
 *
 * Two layers:
 *   - the BAKED source — `app-update.yml`, which electron-builder writes into
 *     the packaged app from the `publish` config at build time. A fork's
 *     release workflow publishes to (and bakes) its own repo, so its builds
 *     follow that fork out of the box;
 *   - a per-machine OVERRIDE the user sets in Settings → General, so an
 *     install can follow another release stream (a coach's or a fork's
 *     builds) without reinstalling. Stored in a tiny main-process file
 *     because the main process owns the updater (the Help-menu check runs
 *     with no renderer involved).
 *
 * Pure module (no `electron` import) so it's unit-testable; `main.ts`
 * supplies `app.getPath('userData')` and `process.resourcesPath`.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const UPDATE_SOURCE_FILE = 'update-source.json';

export interface UpdateSource {
  owner: string;
  repo: string;
}

/** The official CardMirror release stream — used when the packaged app has
 *  no readable `app-update.yml` (it always should). */
export const DEFAULT_UPDATE_SOURCE: UpdateSource = { owner: 'ant981228', repo: 'cardmirror' };

// GitHub's own limits: owners are alphanumerics + single hyphens (≤39),
// repo names alphanumerics plus `-`, `_`, `.`.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** Parse what a user types into an update source: `owner/repo`, or any
 *  GitHub URL under the repo (`https://github.com/owner/repo/releases`,
 *  a `.git` clone URL). Returns null for anything else. */
export function parseUpdateSource(input: string): UpdateSource | null {
  let s = input.trim();
  s = s.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '');
  s = s.replace(/^git@github\.com:/i, '');
  const parts = s.split(/[/?#]/).filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/i, '');
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === '.' || repo === '..') return null;
  return { owner, repo };
}

export function formatUpdateSource(src: UpdateSource): string {
  return `${src.owner}/${src.repo}`;
}

export function sameUpdateSource(a: UpdateSource, b: UpdateSource): boolean {
  return a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();
}

/** The user's override, or null (follow the baked source) on a missing,
 *  corrupt, or wrong-shaped file. */
export function readUpdateSourceOverride(userDataDir: string): UpdateSource | null {
  try {
    const parsed = JSON.parse(readFileSync(join(userDataDir, UPDATE_SOURCE_FILE), 'utf8')) as Partial<UpdateSource>;
    if (typeof parsed?.owner !== 'string' || typeof parsed?.repo !== 'string') return null;
    return parseUpdateSource(`${parsed.owner}/${parsed.repo}`);
  } catch {
    return null;
  }
}

/** Persist the override (atomic temp + rename); null removes it. */
export function writeUpdateSourceOverride(userDataDir: string, src: UpdateSource | null): void {
  const target = join(userDataDir, UPDATE_SOURCE_FILE);
  if (!src) {
    rmSync(target, { force: true });
    return;
  }
  mkdirSync(userDataDir, { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify({ owner: src.owner, repo: src.repo }));
  renameSync(tmp, target);
}

/** The source baked into the packaged app's `app-update.yml` (flat
 *  `key: value` YAML, so a line scan is enough). Falls back to the
 *  official stream when the file is missing or isn't a GitHub config. */
export function readBakedUpdateSource(resourcesDir: string): UpdateSource {
  try {
    const yml = readFileSync(join(resourcesDir, 'app-update.yml'), 'utf8');
    const field = (key: string): string | undefined =>
      new RegExp(`^${key}:\\s*['"]?([^'"\\s]+)['"]?\\s*$`, 'm').exec(yml)?.[1];
    if (field('provider') !== 'github') return DEFAULT_UPDATE_SOURCE;
    const owner = field('owner');
    const repo = field('repo');
    if (!owner || !repo) return DEFAULT_UPDATE_SOURCE;
    return parseUpdateSource(`${owner}/${repo}`) ?? DEFAULT_UPDATE_SOURCE;
  } catch {
    return DEFAULT_UPDATE_SOURCE;
  }
}
