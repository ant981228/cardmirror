// tests/editor/plugin-source-token.test.ts
import { describe, expect, it } from 'vitest';
import {
  mintSourceToken,
  parseSourceToken,
  type SourcePayload,
} from '../../src/editor/plugin-source-token.js';

const payload: SourcePayload = {
  docId: 'doc-123',
  docTitle: 'AT Cap K — «weird» título.docx',
  headingId: 'a1b2c3d4-0000-0000-0000-000000000000',
  scopeId: 'a1b2c3d4-0000-0000-0000-000000000000',
  anchor: { quote: 'Perm solves', prefix: 'before ', suffix: ' after', approxPos: 42 },
};

describe('source token', () => {
  it('round-trips a payload, unicode included', () => {
    const token = mintSourceToken(payload);
    expect(token.startsWith('cmsrc1.')).toBe(true);
    expect(parseSourceToken(token)).toEqual(payload);
  });
  it('round-trips null headingId and null anchor', () => {
    const p: SourcePayload = {
      docId: 'd',
      docTitle: '',
      headingId: null,
      scopeId: null,
      anchor: null,
    };
    expect(parseSourceToken(mintSourceToken(p))).toEqual(p);
  });
  it('rejects a wrong prefix', () => {
    const token = mintSourceToken(payload).replace(/^cmsrc1/, 'cmsrc9');
    expect(parseSourceToken(token)).toBeNull();
  });
  it('rejects garbage and non-strings', () => {
    expect(parseSourceToken('cmsrc1.!!!not-base64!!!')).toBeNull();
    expect(parseSourceToken('no-dot-here')).toBeNull();
    expect(parseSourceToken(undefined as unknown as string)).toBeNull();
  });
  it('rejects a payload without docId', () => {
    const bare = 'cmsrc1.' + Buffer.from(JSON.stringify({ docTitle: 'x' })).toString('base64url');
    expect(parseSourceToken(bare)).toBeNull();
  });
  it('drops a malformed anchor but keeps the rest of the payload', () => {
    const mint = (anchor: unknown): string =>
      'cmsrc1.' +
      Buffer.from(
        JSON.stringify({ docId: 'doc-123', docTitle: 't', headingId: null, anchor }),
      ).toString('base64url');
    const expected = {
      docId: 'doc-123',
      docTitle: 't',
      headingId: null,
      scopeId: null,
      anchor: null,
    };
    // Inner fields are validated, not cast: a null quote fails the check.
    expect(
      parseSourceToken(mint({ quote: null, prefix: 'a', suffix: 'b', approxPos: 1 })),
    ).toEqual(expected);
    // A valid-JSON scalar is not an object at all.
    expect(parseSourceToken(mint(42))).toEqual(expected);
  });
  it('round-trips astral-plane text', () => {
    const p: SourcePayload = {
      docId: 'd',
      docTitle: 'Fire 🔥 doc',
      headingId: null,
      scopeId: null,
      anchor: { quote: '🧊❤️‍🔥 quote', prefix: '𝔭', suffix: '𐐷', approxPos: 1 },
    };
    expect(parseSourceToken(mintSourceToken(p))).toEqual(p);
  });
  it('rejects a non-finite approxPos and strips unknown anchor fields', () => {
    const mk = (anchor: unknown) =>
      'cmsrc1.' +
      Buffer.from(JSON.stringify({ docId: 'd', docTitle: 't', anchor })).toString('base64url');
    // Infinity: JSON.stringify would convert to null, so use raw JSON with literal exponent.
    // JSON.parse('{"x":1e999}').x === Infinity is the real attack vector.
    const rawInf =
      'cmsrc1.' +
      Buffer.from('{"docId":"d","docTitle":"t","anchor":{"quote":"q","prefix":"","suffix":"","approxPos":1e999}}').toString(
        'base64url',
      );
    expect(parseSourceToken(rawInf)!.anchor).toBeNull();
    const junk = parseSourceToken(
      mk({ quote: 'q', prefix: '', suffix: '', approxPos: 2, extra: 'x'.repeat(64) }),
    );
    expect(junk!.anchor).toEqual({ quote: 'q', prefix: '', suffix: '', approxPos: 2 });
    const missing = parseSourceToken(mk({ quote: 'q', prefix: '', approxPos: 2 }));
    expect(missing!.anchor).toBeNull();
  });
});
