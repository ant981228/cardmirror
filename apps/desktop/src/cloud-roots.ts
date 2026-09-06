/**
 * Which cloud-sync service, if any, holds a file — so the editor can
 * show its cloud badge and main can poll the file for changes made on
 * another machine. Detection is by path prefix against the roots each
 * client publishes; it runs once per open (and on Save As / rename)
 * and is cached by the caller. A miss means no badge and no poller;
 * the save-time guard protects every path regardless.
 *
 * Pure: every environmental input is injected so the matcher is unit
 * testable; `detectCloudProvider` wires the real ones.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type CloudProvider = 'dropbox' | 'onedrive' | 'gdrive' | 'icloud' | 'other';

export interface CloudEnv {
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
  /** Parsed contents of Dropbox's info.json (`~/.dropbox/info.json`,
   *  Windows `%APPDATA%\Dropbox\info.json`), or null. */
  dropboxInfo: unknown;
}

/** Path ops for the platform being classified — the classifier runs
 *  under test on a Mac against Windows paths, and Node's default `path`
 *  is the host's. */
function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

function isUnder(filePath: string, root: string, P: path.PlatformPath): boolean {
  const rel = P.relative(root, filePath);
  return rel !== '' && !rel.startsWith('..') && !P.isAbsolute(rel);
}

function dropboxRoots(info: unknown): string[] {
  if (!info || typeof info !== 'object') return [];
  const out: string[] = [];
  for (const account of Object.values(info as Record<string, unknown>)) {
    const p = (account as { path?: unknown } | null)?.path;
    if (typeof p === 'string' && p) out.push(p);
  }
  return out;
}

/** Classify an ABSOLUTE, symlink-resolved path. */
export function classifyCloudPath(filePath: string, env: CloudEnv): CloudProvider | null {
  const P = pathFor(env.platform);
  const home = env.home;
  for (const root of dropboxRoots(env.dropboxInfo)) {
    if (isUnder(filePath, root, P)) return 'dropbox';
  }
  if (isUnder(filePath, P.join(home, 'Dropbox'), P)) return 'dropbox';
  if (env.platform === 'darwin') {
    // File Provider mounts: ~/Library/CloudStorage/<Provider>-<account>/…
    const cloudStorage = P.join(home, 'Library', 'CloudStorage');
    if (isUnder(filePath, cloudStorage, P)) {
      const mount = P.relative(cloudStorage, filePath).split(P.sep)[0] ?? '';
      const lower = mount.toLowerCase();
      if (lower.startsWith('dropbox')) return 'dropbox';
      if (lower.startsWith('onedrive')) return 'onedrive';
      if (lower.startsWith('googledrive')) return 'gdrive';
      return 'other';
    }
    if (isUnder(filePath, P.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'), P)) return 'icloud';
  }
  for (const key of ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer']) {
    const root = env.env[key];
    if (root && isUnder(filePath, root, P)) return 'onedrive';
  }
  if (env.platform === 'win32') {
    // Google Drive for desktop mounts a drive letter whose root holds "My Drive".
    if (/^[A-Za-z]:[\\/]+My Drive[\\/]/u.test(filePath)) return 'gdrive';
    if (/^[A-Za-z]:[\\/]+Shared drives[\\/]/u.test(filePath)) return 'gdrive';
  }
  if (isUnder(filePath, P.join(home, 'Google Drive'), P)) return 'gdrive';
  return null;
}

async function readDropboxInfo(platform: NodeJS.Platform, home: string, env: Record<string, string | undefined>): Promise<unknown> {
  const candidates =
    platform === 'win32'
      ? [env['APPDATA'] && path.join(env['APPDATA'], 'Dropbox', 'info.json'), env['LOCALAPPDATA'] && path.join(env['LOCALAPPDATA'], 'Dropbox', 'info.json')]
      : [path.join(home, '.dropbox', 'info.json')];
  for (const c of candidates) {
    if (!c) continue;
    try {
      return JSON.parse(await fs.readFile(c, 'utf8')) as unknown;
    } catch {
      /* not installed / unreadable */
    }
  }
  return null;
}

let envPromise: Promise<CloudEnv> | null = null;
function realEnv(): Promise<CloudEnv> {
  return (envPromise ??= (async () => {
    const platform = process.platform;
    const home = os.homedir();
    return { platform, home, env: process.env, dropboxInfo: await readDropboxInfo(platform, home, process.env) };
  })());
}

/** Provider for `filePath`, resolving symlinks first (Dropbox roots
 *  are often symlinked). Null when the file is in no known sync root. */
export async function detectCloudProvider(filePath: string): Promise<CloudProvider | null> {
  let real = filePath;
  try {
    real = await fs.realpath(filePath);
  } catch {
    /* gone / unreadable — classify the given path */
  }
  const env = await realEnv();
  return classifyCloudPath(pathFor(env.platform).resolve(real), env);
}
