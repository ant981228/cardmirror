// src/editor/plugin-source-token.ts
/**
 * Opaque provenance token — the versioned blob a flowing app stores and
 * hands back verbatim. Only CardMirror mints and parses these. The
 * `cmsrc1` prefix is the version indicator; a future format change
 * bumps the prefix and keeps this parser for old tokens.
 */
import type { AnchorDescriptor } from './learn-anchor.js';

export const SOURCE_TOKEN_PREFIX = 'cmsrc1';

export interface SourcePayload {
  docId: string;
  /** For user-facing "open <title> first" messages when the doc isn't open. */
  docTitle: string;
  /** Stable heading UUID this token NAMES, or null. Set only for heading
   *  kinds (pocket / hat / block / tag / analytic): an undertag or a cite
   *  names no heading, and putting its governing heading here made
   *  resolution answer with the tag above it. */
  headingId: string | null;
  /** Stable heading UUID of the section the item lives in, or null. Scope,
   *  never target: it narrows where the anchor may resolve, so an undertag
   *  quoted identically in two cards resolves inside its own. Its presence
   *  also marks a token minted after the target/scope split - a token
   *  without it may carry a governing heading in `headingId`. */
  scopeId: string | null;
  /** Text anchor over the item's own text. The only resolver for the
   *  id-less kinds, and the fallback for a heading whose id is gone. */
  anchor: AnchorDescriptor | null;
}

function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string | null {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

export function mintSourceToken(payload: SourcePayload): string {
  return `${SOURCE_TOKEN_PREFIX}.${toBase64Url(JSON.stringify(payload))}`;
}

export function parseSourceToken(token: string): SourcePayload | null {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 0 || token.slice(0, dot) !== SOURCE_TOKEN_PREFIX) return null;
  const json = fromBase64Url(token.slice(dot + 1));
  if (json === null) return null;
  try {
    const obj = JSON.parse(json) as Partial<SourcePayload>;
    if (typeof obj.docId !== 'string' || !obj.docId) return null;
    return {
      docId: obj.docId,
      docTitle: typeof obj.docTitle === 'string' ? obj.docTitle : '',
      headingId:
        typeof obj.headingId === 'string' && obj.headingId ? obj.headingId : null,
      scopeId: typeof obj.scopeId === 'string' && obj.scopeId ? obj.scopeId : null,
      anchor: isAnchorDescriptor(obj.anchor)
        ? {
            quote: obj.anchor.quote,
            prefix: obj.anchor.prefix,
            suffix: obj.anchor.suffix,
            approxPos: obj.anchor.approxPos,
          }
        : null,
    };
  } catch {
    return null;
  }
}

/** Field-level check mirroring `AnchorDescriptor` — a token is
 *  outside input handed back by other apps, so the inner shape is
 *  validated, never cast. Anything malformed degrades to no anchor. */
function isAnchorDescriptor(v: unknown): v is AnchorDescriptor {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a['quote'] === 'string' &&
    typeof a['prefix'] === 'string' &&
    typeof a['suffix'] === 'string' &&
    Number.isFinite(a['approxPos'])
  );
}
