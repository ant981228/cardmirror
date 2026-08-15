/**
 * Research-browser feature gate.
 *
 * The docked in-app browser embeds a native `WebContentsView`
 * (`apps/desktop/src/main.ts`), which only exists on the Electron
 * shell — the web edition has no such surface. Desktop-only, same
 * shape and same categorical guarantee as `collabEnabled()`
 * (`./collab/collab-gate.ts`).
 */

import { getHost } from './host/index.js';

export function researchBrowserEnabled(): boolean {
  try {
    return getHost().kind !== 'browser';
  } catch {
    return false;
  }
}
