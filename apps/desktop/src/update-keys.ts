import type { TrustedUpdateKey } from './update-signature.js';

/**
 * Public keys that sign this build's OWN release stream (the repository in
 * package.json's `publish` config). Empty = the official stream is not
 * signed yet, and its updates install as before. Once a key is listed,
 * updates from the official stream must carry a valid signature from it.
 *
 * Add one with `node apps/desktop/scripts/gen-update-key.cjs` (it also stores
 * the private half in the UPDATE_SIGNING_KEY secret). Custom update sources
 * (Settings → General → Update source) don't use this list: each one is
 * pinned to its own key when the user switches to it.
 */
export const TRUSTED_UPDATE_KEYS: readonly TrustedUpdateKey[] = [];
