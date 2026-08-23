const crypto = require('crypto');

/**
 * SHA-256 of the PLAINTEXT evidence file.
 *
 * Hashing the plaintext, not the ciphertext, is deliberate: the digest must
 * identify the evidence itself. Ciphertext changes every time it is re-encrypted
 * (new IV), so a ciphertext hash would never match across re-encryption and
 * would prove nothing about the content. This digest is what goes on-chain and
 * what an investigator recomputes to prove the exhibit has not been altered.
 */
function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** 0x-prefixed for passing to the contract as bytes32. */
function toBytes32(hexDigest) {
  return '0x' + hexDigest;
}

module.exports = { sha256, toBytes32 };
