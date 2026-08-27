const crypto = require('crypto');
const env = require('../config/env');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the size GCM is specified for
const KEY_BYTES = 32;

function parseKeyHex(hex, label) {
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== KEY_BYTES) {
    throw new Error(`${label} must be ${KEY_BYTES} bytes (${KEY_BYTES * 2} hex chars), got ${buf.length}`);
  }
  return buf;
}

/**
 * Versioned keyring, rebuilt from env on every call — this module is not on a
 * hot enough path for that to matter, and it means a key rotation only needs
 * an env change plus a restart, no code path that could go stale.
 *
 * The ACTIVE version (env.evidenceEncryptionKeyVersion) is what encrypts every
 * new exhibit. Anything in EVIDENCE_ENCRYPTION_KEY_PREVIOUS is decrypt-only —
 * present so exhibits sealed under an old key stay readable after rotation,
 * without forcing an immediate re-encryption of everything already stored.
 * Each evidence row remembers which version sealed it (evidence.key_version)
 * precisely so this lookup has something to key on.
 */
function keyring() {
  const map = new Map();
  map.set(env.evidenceEncryptionKeyVersion, parseKeyHex(env.evidenceEncryptionKey, 'EVIDENCE_ENCRYPTION_KEY'));
  if (env.evidenceEncryptionKeyPrevious) {
    for (const entry of env.evidenceEncryptionKeyPrevious.split(',').map((s) => s.trim()).filter(Boolean)) {
      const [version, hex] = entry.split(':');
      map.set(Number(version), parseKeyHex(hex, `EVIDENCE_ENCRYPTION_KEY_PREVIOUS entry ${version}`));
    }
  }
  return map;
}

function keyFor(version) {
  const k = keyring().get(version);
  if (!k) {
    throw new Error(`No encryption key configured for key_version ${version} — check EVIDENCE_ENCRYPTION_KEY_PREVIOUS`);
  }
  return k;
}

/**
 * Encrypt an evidence file buffer.
 * A fresh IV per file is mandatory — reusing one under the same key breaks
 * GCM catastrophically. The auth tag is what makes this tamper-evident at rest:
 * decryption of modified ciphertext throws rather than returning garbage.
 *
 * `aad` (associated authenticated data) is optional but should always be
 * passed by callers that have a stable identity to bind to — typically the
 * evidence row's own id (see evidenceController.aadFor). Without it, a valid
 * (ciphertext, iv, authTag) triple copied wholesale from one evidence row onto
 * another still decrypts and authenticates cleanly, because GCM only proves
 * "this ciphertext was produced under this key with this IV" — it says nothing
 * about which database row it belongs to. AAD closes that gap: it is not
 * encrypted, but it IS authenticated, so decrypting with the wrong AAD fails
 * even though the ciphertext and auth tag are individually valid.
 */
function encrypt(plaintext, aad) {
  const keyVersion = env.evidenceEncryptionKeyVersion;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, keyFor(keyVersion), iv);
  if (aad) cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext,
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
    keyVersion,
  };
}

/** keyVersion defaults to the active one, but callers decrypting an existing
 * row MUST pass its stored evidence.key_version — a rotated exhibit will not
 * decrypt under the current active key. */
function decrypt(ciphertext, ivHex, authTagHex, aad, keyVersion = env.evidenceEncryptionKeyVersion) {
  const decipher = crypto.createDecipheriv(ALGORITHM, keyFor(keyVersion), Buffer.from(ivHex, 'hex'));
  if (aad) decipher.setAAD(Buffer.from(String(aad), 'utf8'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

module.exports = { encrypt, decrypt, ALGORITHM };
