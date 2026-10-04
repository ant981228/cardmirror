#!/usr/bin/env node
/**
 * Release CI: sign every installer / update artifact in apps/desktop/release
 * with the UPDATE_SIGNING_KEY secret (Ed25519, PKCS#8 PEM) and write
 * `<artifact>.sig` beside it. The message format must match
 * src/update-signature.ts `signingMessage`.
 *
 *   UPDATE_SIGNING_KEY=… node apps/desktop/scripts/sign-release.cjs <version>
 *
 * Also writes `update-signing-key.pub` (the public half, base64 SPKI): the
 * asset an app fetches when a user switches to this stream, so it can pin
 * the key after the user confirms its fingerprint.
 *
 * Without UPDATE_SIGNING_KEY: skips with a notice (an unsigned stream works
 * as before) — unless REQUIRE_UPDATE_SIGNING=true, then fails so a signed
 * stream can't publish an unsigned release by accident. Prints the paths to
 * upload.
 */
const { createHash, createPrivateKey, createPublicKey, sign } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const version = process.argv[2];
const pem = process.env.UPDATE_SIGNING_KEY;
if (!version) {
  console.error('usage: sign-release.cjs <version>');
  process.exit(2);
}
if (!pem || !pem.includes('PRIVATE KEY')) {
  if (process.env.REQUIRE_UPDATE_SIGNING === 'true') {
    console.error('UPDATE_SIGNING_KEY is not set — refusing to publish unsigned artifacts.');
    process.exit(1);
  }
  console.error('UPDATE_SIGNING_KEY is not set — this release is not signed (set it to sign releases).');
  process.exit(0);
}
const key = createPrivateKey(pem);
if (key.asymmetricKeyType !== 'ed25519') {
  console.error('UPDATE_SIGNING_KEY is not an Ed25519 key.');
  process.exit(1);
}

const dir = process.env.RELEASE_DIR || path.join(__dirname, '..', 'release');
const exts = ['.dmg', '.zip', '.exe', '.AppImage', '.pacman'];
const files = fs.readdirSync(dir).filter((f) => exts.some((e) => f.endsWith(e)) && f.includes(version));
if (files.length === 0) {
  console.error(`No ${version} artifacts in ${dir}.`);
  process.exit(1);
}
const pubPath = path.join(dir, 'update-signing-key.pub');
fs.writeFileSync(pubPath, createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64') + '\n');
console.log(pubPath);
for (const name of files) {
  // Sign under the PUBLISHED name: electron-builder uploads "CardMirror
  // Setup 1.2.3.exe" as "CardMirror-Setup-1.2.3.exe" (spaces → dashes), and
  // that is the name latest.yml lists and the app verifies against.
  const published = name.replace(/ /g, '-');
  const sha512 = createHash('sha512').update(fs.readFileSync(path.join(dir, name))).digest('base64');
  const msg = Buffer.from(`cardmirror-update-v1\n${published}\n${version}\n${sha512}`, 'utf8');
  const sigPath = path.join(dir, `${published}.sig`);
  fs.writeFileSync(sigPath, sign(null, msg, key).toString('base64') + '\n');
  console.log(sigPath);
}
