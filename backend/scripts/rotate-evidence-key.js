/**
 * Re-encrypts every exhibit still under an old key onto the CURRENTLY ACTIVE
 * one (EVIDENCE_ENCRYPTION_KEY_VERSION).
 *
 *   node scripts/rotate-evidence-key.js
 *
 * Run this some time after rotating EVIDENCE_ENCRYPTION_KEY, while the
 * retired key is still available in EVIDENCE_ENCRYPTION_KEY_PREVIOUS —
 * rotation itself does not require this (old exhibits stay readable under
 * whichever key sealed them), but leaving exhibits scattered across
 * multiple live keys indefinitely is what eventually makes a retired key
 * impossible to safely delete from EVIDENCE_ENCRYPTION_KEY_PREVIOUS. Once
 * every row reports key_version = the active version, the old entry can be
 * dropped from the env for good.
 *
 * Talks to Postgres and disk storage directly rather than the HTTP API —
 * this is an operational/maintenance script, not something run from a
 * browser session, and re-encryption should not itself go through another
 * round of upload/anchor bookkeeping.
 */
require('dotenv').config();
const pool = require('../src/db/pool');
const storage = require('../src/services/storageService');
const crypto = require('../src/services/cryptoService');
const hashService = require('../src/services/hashService');
const env = require('../src/config/env');

const aadFor = (evidenceId) => `evidence:${evidenceId}`;

async function main() {
  const active = env.evidenceEncryptionKeyVersion;
  console.log(`\nActive key version: ${active}\n`);

  const { rows } = await pool.query(
    `SELECT id, title, sha256_hash, encrypted_path, iv, auth_tag, key_version
       FROM evidence WHERE key_version <> $1`,
    [active]
  );

  if (!rows.length) {
    console.log('Nothing to migrate — every exhibit is already under the active key.\n');
    await pool.end();
    return;
  }

  console.log(`${rows.length} exhibit(s) to re-encrypt:\n`);
  let migrated = 0;
  for (const ev of rows) {
    try {
      const ciphertext = await storage.read(ev.encrypted_path);
      const plaintext = crypto.decrypt(ciphertext, ev.iv, ev.auth_tag, aadFor(ev.id), ev.key_version);

      // Integrity check before writing anything back — never launder a
      // corrupted or tampered exhibit into a freshly "clean" envelope.
      if (hashService.sha256(plaintext) !== ev.sha256_hash) {
        console.log(`  SKIP  #${ev.id} "${ev.title}" — recomputed digest does not match the sealed hash, leaving untouched`);
        continue;
      }

      const { ciphertext: newCiphertext, iv, authTag, keyVersion } = crypto.encrypt(plaintext, aadFor(ev.id));
      const newStoredName = await storage.write(newCiphertext);
      const oldPath = ev.encrypted_path;

      await pool.query(
        `UPDATE evidence SET encrypted_path=$2, iv=$3, auth_tag=$4, key_version=$5 WHERE id=$1`,
        [ev.id, newStoredName, iv, authTag, keyVersion]
      );
      await storage.remove(oldPath);

      console.log(`  OK    #${ev.id} "${ev.title}" — key_version ${ev.key_version} -> ${keyVersion}`);
      migrated++;
    } catch (e) {
      console.log(`  FAIL  #${ev.id} "${ev.title}" — ${e.message}`);
    }
  }

  console.log(`\n${migrated}/${rows.length} exhibit(s) migrated to key_version ${active}.\n`);
  await pool.end();
}

main().catch((err) => { console.error('\nrotation script crashed:', err); process.exit(1); });
