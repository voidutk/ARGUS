const crypto = require('crypto');
const env = require('../config/env');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the size GCM is specified for
const KEY_BYTES = 32;

function key() {
  const buf = Buffer.from(env.evidenceEncryptionKey, 'hex');
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `EVIDENCE_ENCRYPTION_KEY must be ${KEY_BYTES} bytes (${KEY_BYTES * 2} hex chars), got ${buf.length}`
    );
  }
  return buf;
}

/**
 * Encrypt an evidence file buffer.
 * A fresh IV per file is mandatory — reusing one under the same key breaks
 * GCM catastrophically. The auth tag is what makes this tamper-evident at rest:
 * decryption of modified ciphertext throws rather than returning garbage.
 */
function encrypt(plaintext) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext,
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
  };
}

function decrypt(ciphertext, ivHex, authTagHex) {
  const decipher = crypto.createDecipheriv(ALGORITHM, key(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

module.exports = { encrypt, decrypt, ALGORITHM };
