const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const env = require('../config/env');

const ROOT = path.resolve(process.cwd(), env.storageDir);

async function ensureRoot() {
  await fs.mkdir(ROOT, { recursive: true });
}

/** Writes ciphertext under an opaque uuid. Returns the path stored in the DB. */
async function write(ciphertext) {
  await ensureRoot();
  const name = `${crypto.randomUUID()}.enc`;
  await fs.writeFile(path.join(ROOT, name), ciphertext);
  return name;
}

function resolveSafe(storedName) {
  // storedName comes from our own DB, but resolve and re-check anyway so a bad
  // row can never read outside the storage directory.
  const full = path.resolve(ROOT, storedName);
  if (!full.startsWith(ROOT + path.sep) && full !== ROOT) {
    throw new Error('Refusing to read outside the storage directory');
  }
  return full;
}

async function read(storedName) {
  return fs.readFile(resolveSafe(storedName));
}

async function remove(storedName) {
  await fs.rm(resolveSafe(storedName), { force: true });
}

module.exports = { write, read, remove, ROOT };
