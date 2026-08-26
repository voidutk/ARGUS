/**
 * Canonical Indian state and union territory names.
 *
 * docs/PLAN-V2-DATA-AND-INTEL.md §2 calls this "the whole job", and it is not
 * an exaggeration. Four sources have to agree on a string before the Geo page
 * renders anything:
 *
 *   NCRB 2001–2012   `A & N ISLANDS`, `DELHI UT`, `ODISHA`, all upper case
 *   NCRB 2014        `A&N Islands`, `D&N Haveli`, title case, plus Telangana
 *   our complaints   `Delhi`, `Odisha`
 *   the map TopoJSON `Andaman and Nicobar`, `NCT of Delhi`
 *
 * A state that fails to match does not throw and does not warn — it silently
 * renders as an empty polygon, and half the map goes blank for a reason nobody
 * can see. So matching is done here, once, and `canonical()` refuses to guess:
 * anything it cannot map is returned with a flag, and the loader reports it
 * rather than writing a row nothing will ever join to.
 *
 * Historical note that matters for correctness: Telangana was carved out of
 * Andhra Pradesh in June 2014. Pre-2014 rows have no Telangana, and its
 * districts are counted under Andhra Pradesh. They are NOT back-filled — moving
 * historical counts into a state that did not exist would be falsifying the
 * source. A trend line for Telangana therefore starts in 2014, correctly.
 */

/** Everything that reduces to one canonical name. Keys are pre-normalised. */
const ALIASES = {
  // Union territories with punctuation that varies by file
  'a & n islands': 'Andaman and Nicobar Islands',
  'a&n islands': 'Andaman and Nicobar Islands',
  'a and n islands': 'Andaman and Nicobar Islands',
  'andaman & nicobar islands': 'Andaman and Nicobar Islands',
  'andaman and nicobar islands': 'Andaman and Nicobar Islands',
  'andaman & nicobar island': 'Andaman and Nicobar Islands',

  'd & n haveli': 'Dadra and Nagar Haveli',
  'd&n haveli': 'Dadra and Nagar Haveli',
  'dadra & nagar haveli': 'Dadra and Nagar Haveli',
  'dadra and nagar haveli': 'Dadra and Nagar Haveli',
  // The 2020 merger. Kept separate for historical rows, which predate it.
  'dadra and nagar haveli and daman and diu': 'Dadra and Nagar Haveli',

  'daman & diu': 'Daman and Diu',
  'daman and diu': 'Daman and Diu',

  'delhi ut': 'Delhi',
  'delhi': 'Delhi',
  'nct of delhi': 'Delhi',
  'national capital territory of delhi': 'Delhi',

  'jammu & kashmir': 'Jammu and Kashmir',
  'jammu and kashmir': 'Jammu and Kashmir',

  'puducherry': 'Puducherry',
  'pondicherry': 'Puducherry',

  'lakshadweep': 'Lakshadweep',
  'chandigarh': 'Chandigarh',
  'ladakh': 'Ladakh',

  // Renamed states — the old name appears throughout the older NCRB files.
  'orissa': 'Odisha',
  'odisha': 'Odisha',
  'uttaranchal': 'Uttarakhand',
  'uttarakhand': 'Uttarakhand',
  'pondichery': 'Puducherry',

  // Straightforward, listed so `canonical()` never has to guess casing.
  'andhra pradesh': 'Andhra Pradesh',
  'arunachal pradesh': 'Arunachal Pradesh',
  'assam': 'Assam',
  'bihar': 'Bihar',
  'chhattisgarh': 'Chhattisgarh',
  'chattisgarh': 'Chhattisgarh',
  'goa': 'Goa',
  'gujarat': 'Gujarat',
  'haryana': 'Haryana',
  'himachal pradesh': 'Himachal Pradesh',
  'jharkhand': 'Jharkhand',
  'karnataka': 'Karnataka',
  'kerala': 'Kerala',
  'madhya pradesh': 'Madhya Pradesh',
  'maharashtra': 'Maharashtra',
  'manipur': 'Manipur',
  'meghalaya': 'Meghalaya',
  'mizoram': 'Mizoram',
  'nagaland': 'Nagaland',
  'punjab': 'Punjab',
  'rajasthan': 'Rajasthan',
  'sikkim': 'Sikkim',
  'tamil nadu': 'Tamil Nadu',
  'telangana': 'Telangana',
  'tripura': 'Tripura',
  'uttar pradesh': 'Uttar Pradesh',
  'west bengal': 'West Bengal',
};

/**
 * Rows that are ROLLUPS, not places.
 *
 * NCRB files carry `TOTAL (ALL-INDIA)` and per-state `TOTAL` rows alongside the
 * districts. Loading them would double every figure — the state would be
 * counted once as the sum of its districts and once again as its own total —
 * and the resulting choropleth would be exactly twice as alarming as reality.
 * The plan flags this specifically; it is the single easiest way to publish a
 * wrong national number.
 */
const ROLLUP_PATTERNS = [
  /^total$/i,
  /^total\s*\(?all[\s-]?india\)?$/i,
  /^total\s*\(?states?\)?$/i,
  /^total\s*\(?uts?\)?$/i,
  /\btotal\b/i,          // "DELHI UT TOTAL", "ZZ TOTAL"
  /^all[\s-]?india$/i,
  /^grand\s+total$/i,
];

/** Header rows that survive a naive CSV read. */
const HEADER_VALUES = new Set(['state/ut', 'states/uts', 'state', 'area_name', 'district', '']);

const squash = (raw) => String(raw ?? '')
  .replace(/﻿/g, '')          // BOM, present on 31_Serious_fraud.csv
  .trim()
  .toLowerCase()
  .replace(/\s+/g, ' ');

/** True for a row that aggregates other rows rather than naming a place. */
function isRollup(value) {
  const s = squash(value);
  if (!s) return false;
  return ROLLUP_PATTERNS.some((p) => p.test(s));
}

function isHeader(value) {
  return HEADER_VALUES.has(squash(value));
}

/**
 * Maps any spelling to the canonical name.
 *
 * Returns `{ name, matched }`. When `matched` is false the input is passed
 * through title-cased rather than dropped — a state we have not seen is still
 * data, and the loader's job is to report it loudly, not to discard it quietly.
 */
function canonical(raw) {
  const key = squash(raw);
  if (!key) return { name: null, matched: false };

  if (ALIASES[key]) return { name: ALIASES[key], matched: true };

  // Punctuation-insensitive retry: "a&n islands" vs "a & n islands".
  const loose = key.replace(/[&]/g, ' and ').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (ALIASES[loose]) return { name: ALIASES[loose], matched: true };

  const titled = key.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return { name: titled, matched: false };
}

/** District names get casing normalised only; there is no authoritative list. */
function canonicalDistrict(raw) {
  const s = squash(raw);
  if (!s || isRollup(s) || isHeader(s)) return null;
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase()).slice(0, 80);
}

/** The canonical set, for validating a load or driving a dropdown. */
const ALL_STATES = [...new Set(Object.values(ALIASES))].sort();

module.exports = { canonical, canonicalDistrict, isRollup, isHeader, ALL_STATES, ALIASES };
