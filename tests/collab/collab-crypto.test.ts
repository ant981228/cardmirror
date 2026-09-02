/**
 * Room crypto: AES-256-GCM sealing round-trips, tampering fails closed,
 * and share codes carry exactly {roomId, key}.
 */

import { describe, it, expect } from 'vitest';
import {
  generateRoomKeyBytes,
  importRoomKey,
  encryptBlob,
  decryptBlob,
  encodeShareCode,
  decodeShareCode,
  bytesToBase64,
  base64ToBytes,
} from '../../src/editor/collab/collab-crypto.js';

describe('blob sealing', () => {
  it('round-trips arbitrary bytes', async () => {
    const key = await importRoomKey(generateRoomKeyBytes());
    const plain = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const sealed = await encryptBlob(key, plain);
    expect(sealed.byteLength).toBeGreaterThan(plain.byteLength); // IV + tag overhead
    expect(await decryptBlob(key, sealed)).toEqual(plain);
  });

  it('produces distinct ciphertexts for identical plaintexts (fresh IVs)', async () => {
    const key = await importRoomKey(generateRoomKeyBytes());
    const plain = new TextEncoder().encode('same update twice');
    const a = await encryptBlob(key, plain);
    const b = await encryptBlob(key, plain);
    expect(bytesToBase64(a)).not.toBe(bytesToBase64(b));
  });

  it('fails closed on tampering and on the wrong key', async () => {
    const key = await importRoomKey(generateRoomKeyBytes());
    const sealed = await encryptBlob(key, new TextEncoder().encode('payload'));
    const tampered = sealed.slice();
    tampered[tampered.length - 1]! ^= 0xff;
    await expect(decryptBlob(key, tampered)).rejects.toThrow();
    const otherKey = await importRoomKey(generateRoomKeyBytes());
    await expect(decryptBlob(otherKey, sealed)).rejects.toThrow();
  });
});

describe('share codes', () => {
  it('round-trips roomId + key', () => {
    const keyBytes = generateRoomKeyBytes();
    const roomId = 'e0720dd8a2df4479bbdad0ed9f48cb21';
    const code = encodeShareCode(roomId, keyBytes);
    expect(code.startsWith('cmshare1.')).toBe(true);
    const decoded = decodeShareCode(code)!;
    expect(decoded.roomId).toBe(roomId);
    expect(decoded.keyBytes).toEqual(keyBytes);
  });

  it('rejects malformed codes', () => {
    expect(decodeShareCode('nonsense')).toBeNull();
    expect(decodeShareCode('cmshare1.onlytwo')).toBeNull();
    expect(decodeShareCode('cmshare2.abc123abc123abc1.AAAA')).toBeNull();
    // short key
    expect(decodeShareCode('cmshare1.e0720dd8a2df4479bbdad0ed9f48cb21.AAAA')).toBeNull();
    // roomId with path-hostile characters
    expect(decodeShareCode(`cmshare1.../../etc.${'A'.repeat(43)}`)).toBeNull();
  });
});

describe('base64 helpers', () => {
  it('round-trips binary safely', () => {
    const bytes = new Uint8Array(70000).map((_, i) => i % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});

describe('base64 fast path (2026-09-01 review, T14)', () => {
  it('encodes/decodes byte-exact across sizes, including multi-MB', async () => {
    const { bytesToBase64, base64ToBytes } = await import('../../src/editor/collab/collab-crypto.js');
    for (const n of [0, 1, 2, 3, 255, 4096, 100_000, 2 * 1024 * 1024 + 1]) {
      const src = new Uint8Array(n);
      for (let i = 0; i < n; i++) src[i] = (i * 7919 + 13) & 0xff;
      const b64 = bytesToBase64(src);
      // Canonical: the platform's own encoder must agree.
      expect(b64).toBe(Buffer.from(src).toString('base64'));
      const back = base64ToBytes(b64);
      expect(back.length).toBe(n);
      expect(Buffer.compare(Buffer.from(back), Buffer.from(src))).toBe(0);
    }
  });
});
