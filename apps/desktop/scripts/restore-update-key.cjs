#!/usr/bin/env node
/**
 * Put the update-signing key back into a repository's UPDATE_SIGNING_KEY
 * secret from an encrypted backup made by gen-update-key.cjs — e.g. after
 * the secret was deleted, or to sign from a new repository. Run it in a
 * real terminal (it asks for the passphrase):
 *
 *   node apps/desktop/scripts/restore-update-key.cjs <backup.enc.pem> [--repo owner/repo]
 *
 * Prints the key's public half so you can check it matches update-keys.ts.
 * The decrypted key goes only to `gh secret set` (stdin), never to disk.
 */
const { createPrivateKey, createPublicKey } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const file = process.argv[2];
const ri = process.argv.indexOf('--repo');
const publish = require(require('node:path').join(__dirname, '..', 'package.json')).build?.publish ?? {};
const repo =
  ri > 0 && process.argv[ri + 1]
    ? process.argv[ri + 1]
    : publish.owner && publish.repo
      ? `${publish.owner}/${publish.repo}`
      : '';
if (!file || !fs.existsSync(file)) {
  console.error('usage: restore-update-key.cjs <backup.enc.pem> [--repo owner/repo]');
  process.exit(2);
}

function askHidden(prompt) {
  return new Promise((resolve) => {
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
  if (!process.stdin.isTTY) throw new Error('Run this in a terminal: it needs to ask for the passphrase.');
  const pass = await askHidden('Backup passphrase: ');
  let key;
  try {
    key = createPrivateKey({ key: fs.readFileSync(file, 'utf8'), format: 'pem', passphrase: pass });
  } catch {
    throw new Error('Wrong passphrase, or not a key backup.');
  }
  const spki = createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');
  console.log(`Public key: ${spki}`);
  execFileSync('gh', ['secret', 'set', 'UPDATE_SIGNING_KEY', '--repo', repo], {
    input: key.export({ type: 'pkcs8', format: 'pem' }),
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  console.log(`UPDATE_SIGNING_KEY restored on ${repo}.`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
