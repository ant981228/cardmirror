// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  artifactNameFor,
  keyFingerprint,
  parsePublicKey,
  sha512File,
  verifyArtifactSignature,
  type TrustedUpdateKey,
} from '../../apps/desktop/src/update-signature.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cardmirror-sig-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function keypair(): { pem: string; trusted: TrustedUpdateKey } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    trusted: { id: 'test', spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') },
  };
}

/** Sign the way CI does: run the real release script over a temp dir. */
function signWithScript(pem: string, version: string): void {
  execFileSync(process.execPath, [path.join(__dirname, '../../apps/desktop/scripts/sign-release.cjs'), version], {
    env: { ...process.env, UPDATE_SIGNING_KEY: pem, RELEASE_DIR: dir },
  });
}

describe('update signatures', () => {
  it('a release signed by CI verifies against the trusted key', async () => {
    const { pem, trusted } = keypair();
    const name = 'CardMirror-Setup-1.14.2.exe';
    writeFileSync(path.join(dir, name), 'installer bytes');
    signWithScript(pem, '1.14.2');
    const sha = await sha512File(path.join(dir, name));
    const sig = readFileSync(path.join(dir, `${name}.sig`), 'utf8');
    expect(
      verifyArtifactSignature({ fileName: name, version: '1.14.2', sha512b64: sha, signatureB64: sig, trustedKeys: [trusted] }),
    ).toBe('test');
  });

  it('signs a Windows installer under its published (dashed) name', async () => {
    const { pem, trusted } = keypair();
    writeFileSync(path.join(dir, 'CardMirror Setup 1.14.3.exe'), 'nsis bytes');
    signWithScript(pem, '1.14.3');
    const published = 'CardMirror-Setup-1.14.3.exe';
    const sha = await sha512File(path.join(dir, 'CardMirror Setup 1.14.3.exe'));
    const sig = readFileSync(path.join(dir, `${published}.sig`), 'utf8');
    expect(
      verifyArtifactSignature({ fileName: published, version: '1.14.3', sha512b64: sha, signatureB64: sig, trustedKeys: [trusted] }),
    ).toBe('test');
  });

  it('refuses tampered bytes, another key, another file name, or another version', async () => {
    const { pem, trusted } = keypair();
    const other = keypair().trusted;
    const name = 'CardMirror-1.14.2-universal-mac.zip';
    writeFileSync(path.join(dir, name), 'zip bytes');
    signWithScript(pem, '1.14.2');
    const sig = readFileSync(path.join(dir, `${name}.sig`), 'utf8');
    const sha = await sha512File(path.join(dir, name));
    writeFileSync(path.join(dir, name), 'evil bytes');
    const evil = await sha512File(path.join(dir, name));
    const v = (o: Partial<Parameters<typeof verifyArtifactSignature>[0]>) =>
      verifyArtifactSignature({ fileName: name, version: '1.14.2', sha512b64: sha, signatureB64: sig, trustedKeys: [trusted], ...o });
    expect(v({ sha512b64: evil })).toBeNull();
    expect(v({ trustedKeys: [other] })).toBeNull();
    expect(v({ trustedKeys: [] })).toBeNull();
    expect(v({ fileName: 'CardMirror-Setup-1.14.2.exe' })).toBeNull();
    expect(v({ version: '1.14.1' })).toBeNull();
    expect(v({ signatureB64: 'not a signature' })).toBeNull();
    expect(v({ trustedKeys: [{ id: 'junk', spki: 'AAAA' }, trusted] })).toBe('test');
  });

  it('without the key: skips on an unsigned stream, fails on one that requires signing', () => {
    writeFileSync(path.join(dir, 'CardMirror-Setup-1.14.2.exe'), 'x');
    const run = (require: string) =>
      execFileSync(process.execPath, [path.join(__dirname, '../../apps/desktop/scripts/sign-release.cjs'), '1.14.2'], {
        env: { ...process.env, UPDATE_SIGNING_KEY: '', RELEASE_DIR: dir, REQUIRE_UPDATE_SIGNING: require },
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString();
    expect(run('')).toBe('');
    expect(() => run('true')).toThrow();
  });

  it('publishes the public key beside the signatures, matching the fingerprint', () => {
    const { pem, trusted } = keypair();
    writeFileSync(path.join(dir, 'CardMirror-1.14.2-universal-mac.zip'), 'zip');
    signWithScript(pem, '1.14.2');
    const published = readFileSync(path.join(dir, 'update-signing-key.pub'), 'utf8');
    expect(parsePublicKey(published)).toBe(trusted.spki);
    expect(keyFingerprint(parsePublicKey(published)!)).toBe(keyFingerprint(trusted.spki));
  });

  it('maps downloaded bytes to their published artifact name by hash', () => {
    const files = [
      { url: 'CardMirror-1.14.2-universal-mac.zip', sha512: 'aaa' },
      { url: 'https://example.com/x/CardMirror-1.14.2-universal.dmg', sha512: 'bbb' },
    ];
    expect(artifactNameFor(files, 'bbb')).toBe('CardMirror-1.14.2-universal.dmg');
    expect(artifactNameFor(files, 'ccc')).toBeNull();
  });
});

describe('published keys and fingerprints', () => {
  it('accepts an Ed25519 SPKI and rejects anything else', () => {
    const { trusted } = keypair();
    expect(parsePublicKey(`  ${trusted.spki}\n`)).toBe(trusted.spki);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    expect(parsePublicKey(rsa)).toBeNull();
    expect(parsePublicKey('<html>Not Found</html>')).toBeNull();
    expect(parsePublicKey('')).toBeNull();
  });

  it('fingerprints are stable, readable, and differ between keys', () => {
    const a = keypair().trusted.spki;
    const b = keypair().trusted.spki;
    expect(keyFingerprint(a)).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(keyFingerprint(a)).toBe(keyFingerprint(a));
    expect(keyFingerprint(a)).not.toBe(keyFingerprint(b));
    expect(keyFingerprint(a)).not.toMatch(/[01OI]/);
  });
});

describe('gen-update-key.cjs', () => {
  it('prints the same fingerprint the app shows', () => {
    const src = readFileSync(path.join(__dirname, '../../apps/desktop/scripts/gen-update-key.cjs'), 'utf8');
    const body = /function fingerprint\(spki\) \{[\s\S]*?\n\}/.exec(src)![0];
    const scriptFingerprint = new Function('createHash', `${body}; return fingerprint;`)(createHash) as (s: string) => string;
    for (let i = 0; i < 5; i++) {
      const spki = keypair().trusted.spki;
      expect(scriptFingerprint(spki)).toBe(keyFingerprint(spki));
    }
  });
});
