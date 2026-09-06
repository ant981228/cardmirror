/**
 * Bundle the file-index service (utilityProcess entry) with esbuild.
 *
 * A script rather than a CLI invocation because esbuild lives in the
 * ROOT node_modules (no workspace hoisting here) and its bin/ entry is
 * the native binary — `node <path>` can't run it, and .bin shims aren't
 * portable to the Windows release runner. Node's module resolution
 * walks up from here and finds the package either way.
 *
 * Bundled (not tsc-compiled) because the service imports the shared
 * matcher from src/editor/file-search.ts — outside the desktop
 * tsconfig's rootDir. Output lands in dist/, which electron-builder
 * already packages.
 */
const { buildSync } = require('esbuild');
const path = require('path');

buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'file-index-service.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: path.join(__dirname, '..', 'dist', 'file-index-service.cjs'),
  logLevel: 'warning',
});

// The learn-store owner (main-process side of the flashcard store) is
// bundled for the same reason: it imports the shared LearnStore from
// src/editor. main.ts `require`s the bundle at runtime.
buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'learn-store-owner.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: path.join(__dirname, '..', 'dist', 'learn-store-owner.cjs'),
  logLevel: 'warning',
});
