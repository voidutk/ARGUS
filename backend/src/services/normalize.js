/**
 * Identifier normalisation.
 *
 * This module is the reason ARGUS finds networks at all. Two complaints only
 * link when the same identifier reduces to the same string, so every write path
 * — the seeder, the complaint intake controller, the intelligence service —
 * must normalise identically. `entities` has UNIQUE (entity_type,
 * normalized_value) as the backstop, but the backstop only helps if the value
 * arriving is already canonical.
 *
 * The Python extractor in intel-service mirrors these rules. If you change one,
 * change both, and re-run the seed.
 */

/** Indian mobile: drop +91/0 prefixes, punctuation and spaces down to 10 digits. */
function phone(raw) {
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length > 10 && digits.startsWith('91')) return digits.slice(-10);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits.slice(-10);
}

/** UPI handles are case-insensitive; banks hand them out in mixed case. */
function upi(raw) {
  return String(raw).trim().toLowerCase();
}

function email(raw) {
  return String(raw).trim().toLowerCase();
}

/**
 * Wallets: lowercase. EVM addresses are checksum-CASED, not checksum-valued —
 * 0xAbC and 0xabc are the same account, and treating them as two entities would
 * split a laundering chain in half.
 */
function wallet(raw) {
  return String(raw).trim().toLowerCase();
}

/** Account numbers arrive with spaces and dashes from statements. */
function bankAccount(raw) {
  return String(raw).replace(/\D/g, '');
}

function ip(raw) {
  return String(raw).trim();
}

function device(raw) {
  return String(raw).trim().toLowerCase();
}

/** Telegram/social handles: strip the leading @, lowercase. */
function handle(raw) {
  return String(raw).trim().replace(/^@/, '').toLowerCase();
}

/** Names and places: lowercase, collapse internal whitespace. */
function text(raw) {
  return String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
}

const BY_TYPE = {
  PHONE: phone,
  UPI: upi,
  EMAIL: email,
  WALLET: wallet,
  BANK_ACCOUNT: bankAccount,
  IP: ip,
  DEVICE: device,
  TELEGRAM: handle,
  PERSON: text,
  LOCATION: text,
};

/** Normalise by entity type. Unknown types fall back to trimmed lowercase. */
function normalize(entityType, value) {
  const fn = BY_TYPE[entityType] || text;
  return fn(value);
}

module.exports = {
  normalize,
  phone,
  upi,
  email,
  wallet,
  bankAccount,
  ip,
  device,
  handle,
  text,
};
