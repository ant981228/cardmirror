#!/usr/bin/env node
/**
 * One-time: make the Ed25519 key that signs this fork's releases.
 * Run it in a real terminal (it asks for a passphrase):
 *
 *   node apps/desktop/scripts/gen-update-key.cjs \
 *     [--repo owner/repo] [--id <label>] [--backup <dir>]...
 *
 * - Stores the private key in the repository's UPDATE_SIGNING_KEY Actions
 *   secret via `gh secret set` (stdin — never on a command line).
 * - Writes a passphrase-ENCRYPTED copy (PKCS#8, AES-256) to your home folder
 *   and to every --backup folder (e.g. Dropbox, a USB drive). No unencrypted
 *   copy is ever written to disk. Keep the passphrase in your password
 *   manager: without key + passphrase, installs can't be updated again
 *   without a manual reinstall.
 * - Adds the PUBLIC key to apps/desktop/src/update-keys.ts, so builds made
 *   from then on trust it, and prints it.
 *
 * Restore the secret from a backup later (macOS's openssl can't read
 * Ed25519 keys, so use the script):
 *   node apps/desktop/scripts/restore-update-key.cjs <backup.enc.pem>
 */
const { createHash, generateKeyPairSync } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = process.argv.slice(2);
const one = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const all = (name) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []));

const publish = require(path.join(__dirname, '..', 'package.json')).build?.publish ?? {};
const repo = one('repo', publish.owner && publish.repo ? `${publish.owner}/${publish.repo}` : '');
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  console.error('Pass --repo owner/repo (the repository whose releases this key will sign).');
  process.exit(2);
}
const id = one('id', `${repo.split('/')[0]} ${new Date().toISOString().slice(0, 10)}`);
const FILE = 'cardmirror-update-signing-key.enc.pem';
const dirs = [os.homedir(), ...all('backup')].map((d) => path.resolve(d.replace(/^~(?=$|\/)/, os.homedir())));
const targets = [...new Set(dirs)].map((d) => path.join(d, FILE));

for (const t of targets) {
  if (fs.existsSync(t)) {
    console.error(`Refusing to overwrite ${t} — it may hold the key your installs already trust.`);
    process.exit(1);
  }
}

/** Same fingerprint the app shows (update-signature.ts keyFingerprint). */
function fingerprint(spki) {
  const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const digest = createHash('sha256').update(Buffer.from(spki, 'base64')).digest();
  let bits = 0, value = 0, out = '';
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 12) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= 12) break;
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

/** Read a line from the terminal without echoing it. */
function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('Run this in a terminal: it needs to ask for a passphrase.'));
      return;
    }
    process.stdout.write(prompt);
    const stdin = process.stdin;
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(value);
      } else if (ch === '\u0003') {
        process.stdout.write('\n');
        process.exit(130);
      } else if (ch === '\u007f' || ch === '\b') {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

(async () => {
  const pass = await askHidden('Passphrase for the backup copies (12+ characters): ');
  if (pass.length < 12) {
    console.error('Too short — use at least 12 characters (a few random words is good).');
    process.exit(1);
  }
  if ((await askHidden('Repeat the passphrase: ')) !== pass) {
    console.error("Passphrases don't match.");
    process.exit(1);
  }

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const plain = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const encrypted = privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: pass });
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

  try {
    execFileSync('gh', ['secret', 'set', 'UPDATE_SIGNING_KEY', '--repo', repo], {
      input: plain,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    console.log(`Stored as the UPDATE_SIGNING_KEY secret on ${repo}.`);
  } catch {
    console.error(`Couldn't set the secret with gh. Nothing was written; fix gh (gh auth status) and re-run.`);
    process.exit(1);
  }

  for (const t of targets) {
    fs.mkdirSync(path.dirname(t), { recursive: true });
    fs.writeFileSync(t, encrypted, { mode: 0o600 });
    console.log(`Encrypted backup: ${t}`);
  }

  const keysFile = path.join(__dirname, '..', 'src', 'update-keys.ts');
  const src = fs.readFileSync(keysFile, 'utf8');
  const entry = `  { id: ${JSON.stringify(id)}, spki: ${JSON.stringify(spki)} },\n`;
  const next = src.replace(
    /export const TRUSTED_UPDATE_KEYS: readonly TrustedUpdateKey\[\] = \[(\]|\n)/,
    (m, tail) => (tail === ']' ? `export const TRUSTED_UPDATE_KEYS: readonly TrustedUpdateKey[] = [\n${entry}]` : `${m}${entry}`),
  );
  if (next === src) {
    console.error(`Couldn't edit ${keysFile}; add this entry to TRUSTED_UPDATE_KEYS by hand:\n${entry}`);
  } else {
    fs.writeFileSync(keysFile, next);
    console.log(`Public key added to update-keys.ts: ${entry.trim()}`);
  }
  console.log(`\nKey fingerprint (share this with people you invite to this stream): ${fingerprint(spki)}`);
  console.log('\nSave the passphrase in your password manager now. To restore the secret later:');
  console.log(`  node apps/desktop/scripts/restore-update-key.cjs ${targets[0]}`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
