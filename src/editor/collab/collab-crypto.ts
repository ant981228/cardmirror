/**
 * Collaboration-session crypto: per-room symmetric encryption and the
 * share-code format.
 *
 * Every update, snapshot, and presence blob a session sends is sealed
 * with the room's AES-256-GCM key before it leaves the client; the
 * relay stores and forwards ciphertext it cannot read (the same trust
 * envelope as card sharing's sealed boxes). The room key never reaches
 * the server — it travels only inside invites (sealed-box pairing
 * messages) or a share code the user hands over directly.
 *
 * Sealed layout: 12-byte random IV ‖ GCM ciphertext+tag. A fresh IV per
 * blob is mandatory for GCM; 12 bytes is the GCM-native size.
 *
 * Uses WebCrypto (`crypto.subtle`), available in the browser, the
 * Electron renderer, and Node ≥16 — the same code path everywhere.
 */

export const ROOM_KEY_BYTES = 32;

const SHARE_CODE_PREFIX = 'cmshare1';
const SHARE_CODE_PREFIX_V2 = 'cmshare2';

export function generateRoomKeyBytes(): Uint8Array {
  const key = new Uint8Array(ROOM_KEY_BYTES);
  crypto.getRandomValues(key);
  return key;
}

export function importRoomKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.byteLength !== ROOM_KEY_BYTES) {
    throw new Error('room key must be 32 bytes');
  }
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encryptBlob(key: CryptoKey, plain: Uint8Array): Promise<Uint8Array> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plain as BufferSource),
  );
  const out = new Uint8Array(iv.byteLength + ct.byteLength);
  out.set(iv, 0);
  out.set(ct, iv.byteLength);
  return out;
}

/** Throws on tampered or wrong-key input (GCM tag failure). */
export async function decryptBlob(key: CryptoKey, sealed: Uint8Array): Promise<Uint8Array> {
  if (sealed.byteLength < 13) throw new Error('sealed blob too short');
  const iv = sealed.subarray(0, 12);
  const ct = sealed.subarray(12);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ct as BufferSource),
  );
}

// --- base64 / base64url (portable: browser + Node, no Buffer) ---

// Native base64 (Uint8Array.fromBase64 / .toBase64, Chromium 144+ /
// Node 25+): a multi-megabyte compaction snapshot used to be decoded by
// a per-character JS loop over a multi-megabyte binary string — on the
// join path, behind the "working…" veil (2026-09-01 review, T14). The
// loop stays as the fallback everywhere the native API is absent.
type NativeB64 = {
  fromBase64?: (s: string) => Uint8Array;
};
const nativeU8 = Uint8Array as unknown as NativeB64;
const hasNativeDecode = typeof nativeU8.fromBase64 === 'function';
const hasNativeEncode =
  typeof (Uint8Array.prototype as unknown as { toBase64?: unknown }).toBase64 === 'function';

export function bytesToBase64(bytes: Uint8Array): string {
  if (hasNativeEncode) {
    return (bytes as unknown as { toBase64: () => string }).toBase64();
  }
  let bin = '';
  const CHUNK = 0x8000; // String.fromCharCode arg-count limit guard
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  if (hasNativeDecode) return nativeU8.fromBase64!(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return base64ToBytes(b64);
}

// --- share codes ---

/** v1: `cmshare1.<roomId>.<base64url room key>` — the out-of-band
 *  invite fallback for non-partners (paste or QR). Possession of the
 *  code IS the capability to join.
 *
 *  v2: `cmshare2.<roomId>.<key>.<minVersion>` — rooms with a
 *  compatibility floor (movable rooms, >= 1.0.0). The format change is
 *  itself the fence: every pre-1.0 parser requires exactly THREE
 *  dot-parts with the literal `cmshare1` prefix, so a v2 code fails
 *  cleanly there ("that does not look like a share code") instead of
 *  joining a room whose containers the build cannot read — join-by-code
 *  bypasses the invite path's minReceiverVersion floor entirely, and an
 *  old build that slipped through crashed on the first move op
 *  (found live, 2026-08-14). Old builds cannot be taught a better
 *  message; new builds read the floor and say "update". List rooms keep
 *  minting v1 codes so old builds can still join them. */
export function encodeShareCode(roomId: string, keyBytes: Uint8Array, minVersion?: string): string {
  if (minVersion) {
    return `${SHARE_CODE_PREFIX_V2}.${roomId}.${toBase64Url(keyBytes)}.${minVersion}`;
  }
  return `${SHARE_CODE_PREFIX}.${roomId}.${toBase64Url(keyBytes)}`;
}

export function decodeShareCode(
  code: string,
): { roomId: string; keyBytes: Uint8Array; minVersion?: string } | null {
  const parts = code.trim().split('.');
  // The version itself contains dots ("1.0.0"), so a v2 code splits
  // into 4+ parts: everything past the key is the floor, rejoined.
  const v2 = parts.length >= 4 && parts[0] === SHARE_CODE_PREFIX_V2;
  if (!v2 && (parts.length !== 3 || parts[0] !== SHARE_CODE_PREFIX)) return null;
  const roomId = parts[1]!;
  if (!/^[0-9a-f]{16,64}$/.test(roomId)) return null;
  const minVersion = v2 ? parts.slice(3).join('.') : undefined;
  if (v2 && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(minVersion!)) return null;
  try {
    const keyBytes = fromBase64Url(parts[2]!);
    if (keyBytes.byteLength !== ROOM_KEY_BYTES) return null;
    return v2 ? { roomId, keyBytes, minVersion } : { roomId, keyBytes };
  } catch {
    return null;
  }
}
