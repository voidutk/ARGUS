/**
 * Loads the REAL NCRB statistics — docs/PLAN-V2-DATA-AND-INTEL.md §2.
 *
 *   node scripts/load-reference-data.js [--dry-run] [--verbose]
 *
 * This is Layer 1: the only data in ARGUS that is genuinely official. It powers
 * the Geo choropleth's `NCRB · OFFICIAL` layer and the district baseline line on
 * Complaint Intelligence, and it exists so that when a judge asks "is any of
 * this real?", the answer starts with something verifiable.
 *
 * What it loads, and what it deliberately does not:
 *
 *   loads   crime/01_District_wise_crimes_committed_IPC_{2001_2012,2013,2014}.csv
 *           — four financial-crime columns only: cheating, criminal breach of
 *             trust, forgery, and the IPC total for context.
 *   loads   31_Serious_fraud.csv — fraud case counts by loss bracket.
 *   ignores crime_dataset_india.csv — it is SYNTHETIC (21 crime types each
 *           appearing 1,859–1,980 times is a uniform draw, not a crime
 *           distribution) and presenting it as NCRB data would be a factual
 *           error a judge may well catch. Our own generator does that job
 *           better and says so.
 *
 * The two hazards this script exists to handle:
 *
 *   rollups     NCRB files carry `TOTAL` rows beside the districts. Loading them
 *               doubles every state figure. Skipped via stateNames.isRollup.
 *   headers     The 2014 file renames every column — `STATE/UT` becomes
 *               `States/UTs`, `TOTAL IPC CRIMES` becomes `Total Cognizable IPC
 *               crimes` — and adds a Forgery column the earlier files lack.
 *               Columns are matched by pattern, never by index.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const env = require('../src/config/env');
const { canonical, canonicalDistrict, isRollup, isHeader } = require('../src/services/stateNames');

const DATA_DIR = path.resolve(__dirname, '..', '..', 'crime-in-india-datasets');
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose');

// A bulk load is legitimately slower than any API request; it gets its own pool
// so it never inherits the API's statement timeout.
const pool = new Pool({ connectionString: env.databaseUrl, max: 2, application_name: 'argus-refload' });

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

/**
 * A minimal RFC-4180 reader.
 *
 * These files are machine-generated exports with quoted fields containing
 * commas (`"Delhi, New"`), so `split(',')` corrupts rows silently — the kind of
 * bug that shifts every column by one for a handful of districts and is
 * invisible until a total looks odd. Pulling in a CSV dependency for four files
 * we control is not worth it; handling quotes correctly is twenty lines.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }   // escaped quote
        else inQuotes = false;
      } else field += ch;
      continue;
    }

    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

function readCsv(relPath) {
  const full = path.join(DATA_DIR, relPath);
  if (!fs.existsSync(full)) return null;
  // The BOM on 31_Serious_fraud.csv would otherwise become part of the first
  // header name, and every lookup for that column would miss.
  const text = fs.readFileSync(full, 'utf8').replace(/^﻿/, '');
  const [header, ...body] = parseCsv(text);
  return { header: header.map((h) => h.trim()), rows: body, file: relPath };
}

/**
 * Finds a column by pattern rather than by index.
 *
 * The three IPC files disagree on every header spelling, and one of them has a
 * column the others do not. Matching on a regex means adding a fourth year's
 * file needs no code change unless NCRB renames something genuinely new.
 */
function columnIndex(header, patterns) {
  for (const pattern of patterns) {
    const idx = header.findIndex((h) => pattern.test(h.trim()));
    if (idx !== -1) return idx;
  }
  return -1;
}

const toInt = (raw) => {
  const n = Number(String(raw ?? '').replace(/[, ]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};

// ---------------------------------------------------------------------------
// IPC district files -> crime_reference
// ---------------------------------------------------------------------------

const IPC_FILES = [
  'crime/01_District_wise_crimes_committed_IPC_2001_2012.csv',
  'crime/01_District_wise_crimes_committed_IPC_2013.csv',
  'crime/01_District_wise_crimes_committed_IPC_2014.csv',
];

const METRIC_PATTERNS = {
  CHEATING: [/^cheating$/i],
  CRIMINAL_BREACH_OF_TRUST: [/^criminal\s+breach\s+of\s+trust$/i],
  FORGERY: [/^forgery$/i],
  TOTAL_IPC: [/^total\s+ipc\s+crimes?$/i, /^total\s+cognizable\s+ipc\s+crimes?$/i],
};

function parseIpcFile(csv, report) {
  const { header, rows, file } = csv;

  const iState = columnIndex(header, [/^state\s*\/\s*ut$/i, /^states?\s*\/\s*uts?$/i, /^state$/i]);
  const iDistrict = columnIndex(header, [/^district$/i]);
  const iYear = columnIndex(header, [/^year$/i]);

  if (iState === -1 || iYear === -1) {
    report.problems.push(`${file}: could not find STATE/UT and YEAR columns`);
    return [];
  }

  const metricCols = {};
  for (const [metric, patterns] of Object.entries(METRIC_PATTERNS)) {
    const idx = columnIndex(header, patterns);
    if (idx !== -1) metricCols[metric] = idx;
  }
  if (!Object.keys(metricCols).length) {
    report.problems.push(`${file}: no financial-crime columns found`);
    return [];
  }
  // Expected, not a defect: FORGERY only exists in the 2014 file. Recorded so
  // an absence is a stated fact rather than a silent gap in a trend line.
  for (const metric of Object.keys(METRIC_PATTERNS)) {
    if (!(metric in metricCols)) report.notes.push(`${file}: no ${metric} column (absent from this year's schema)`);
  }

  const out = [];
  for (const row of rows) {
    const rawState = row[iState];
    const rawDistrict = iDistrict === -1 ? null : row[iDistrict];

    if (isHeader(rawState)) continue;
    // Both levels must be checked: a state rollup and a district rollup are
    // different rows and either one double-counts.
    if (isRollup(rawState) || isRollup(rawDistrict)) { report.rollupsSkipped++; continue; }

    const { name: state, matched } = canonical(rawState);
    if (!state) continue;
    if (!matched) report.unmatchedStates.add(String(rawState).trim());

    const year = toInt(row[iYear]);
    if (!year || year < 1990 || year > 2100) { report.badYears++; continue; }

    const district = canonicalDistrict(rawDistrict);

    for (const [metric, idx] of Object.entries(metricCols)) {
      const value = toInt(row[idx]);
      if (value === null) continue;
      out.push({ state, district, year, metric, value, source_file: path.basename(file) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Serious fraud -> fraud_reference
// ---------------------------------------------------------------------------

const BRACKETS = {
  '1_10_CR': [/loss_of_property_1_10_crores/i],
  '10_25_CR': [/loss_of_property_10_25_crores/i],
  '25_50_CR': [/loss_of_property_25_50_crores/i],
  '50_100_CR': [/loss_of_property_50_100_crores/i],
  'ABOVE_100_CR': [/loss_of_property_above_100_crores/i],
};

function parseFraudFile(csv, report) {
  const { header, rows, file } = csv;
  const iArea = columnIndex(header, [/^area_name$/i]);
  const iYear = columnIndex(header, [/^year$/i]);

  if (iArea === -1 || iYear === -1) {
    report.problems.push(`${file}: could not find Area_Name and Year columns`);
    return [];
  }

  const bracketCols = {};
  for (const [bracket, patterns] of Object.entries(BRACKETS)) {
    const idx = columnIndex(header, patterns);
    if (idx !== -1) bracketCols[bracket] = idx;
  }

  // The file holds several Group_Name sub-tables (Cheating, Criminal Breach of
  // Trust, Counterfeiting) for the same state and year. They are summed per
  // bracket, because the loss bracket is the dimension the UI shows and keeping
  // the sub-groups would need a column the table does not have.
  const totals = new Map();
  for (const row of rows) {
    const rawArea = row[iArea];
    if (isHeader(rawArea) || isRollup(rawArea)) { if (isRollup(rawArea)) report.rollupsSkipped++; continue; }

    const { name: state, matched } = canonical(rawArea);
    if (!state) continue;
    if (!matched) report.unmatchedStates.add(String(rawArea).trim());

    const year = toInt(row[iYear]);
    if (!year) { report.badYears++; continue; }

    for (const [bracket, idx] of Object.entries(bracketCols)) {
      const value = toInt(row[idx]);
      if (value === null) continue;
      const key = `${state}|${year}|${bracket}`;
      totals.set(key, (totals.get(key) || 0) + value);
    }
  }

  return [...totals.entries()].map(([key, cases]) => {
    const [state, year, loss_bracket] = key.split('|');
    return { state, year: Number(year), loss_bracket, cases, source_file: path.basename(file) };
  });
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Inserts in batches with an upsert.
 *
 * Re-running the loader must be safe and must converge on the same table, so a
 * corrected CSV can simply be reloaded. Batching keeps the round trips down —
 * 36,000 individual INSERTs takes minutes, 36,000 rows in batches of 500 takes
 * seconds — without building one statement so large the server rejects it.
 */
async function bulkUpsert(client, table, columns, conflictColumns, rows, batchSize = 500) {
  let written = 0;
  const updateSet = columns
    .filter((c) => !conflictColumns.includes(c))
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(', ');

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const values = [];
    const params = [];

    batch.forEach((row, n) => {
      const offset = n * columns.length;
      values.push(`(${columns.map((_, k) => `$${offset + k + 1}`).join(',')})`);
      columns.forEach((c) => params.push(row[c]));
    });

    const { rowCount } = await client.query(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES ${values.join(',')}
       ON CONFLICT (${conflictColumns.join(',')}) DO UPDATE SET ${updateSet}`,
      params
    );
    written += rowCount;
  }
  return written;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const report = {
    unmatchedStates: new Set(),
    rollupsSkipped: 0,
    badYears: 0,
    problems: [],
    notes: [],
  };

  console.log('\nARGUS reference-data loader — NCRB official statistics\n');

  if (!fs.existsSync(DATA_DIR)) {
    console.error(`  Dataset directory not found: ${DATA_DIR}`);
    process.exit(1);
  }

  // --- parse ---------------------------------------------------------------
  const crimeRows = [];
  for (const file of IPC_FILES) {
    const csv = readCsv(file);
    if (!csv) { report.problems.push(`${file}: not found`); continue; }
    const parsed = parseIpcFile(csv, report);
    console.log(`  read     ${path.basename(file).padEnd(52)} ${String(parsed.length).padStart(6)} metric rows`);
    crimeRows.push(...parsed);
  }

  const fraudCsv = readCsv('31_Serious_fraud.csv');
  const fraudRows = fraudCsv ? parseFraudFile(fraudCsv, report) : [];
  if (fraudCsv) console.log(`  read     ${'31_Serious_fraud.csv'.padEnd(52)} ${String(fraudRows.length).padStart(6)} bracket rows`);
  else report.problems.push('31_Serious_fraud.csv: not found');

  // Deduplicate before writing. The 2001–2012 file overlaps nothing, but a
  // re-export with a repeated district would otherwise make the upsert fire
  // twice inside one statement, which Postgres rejects outright ("ON CONFLICT
  // DO UPDATE command cannot affect row a second time").
  const dedupe = (rows, keyOf) => {
    const seen = new Map();
    for (const row of rows) seen.set(keyOf(row), row);
    return [...seen.values()];
  };
  const crimeUnique = dedupe(crimeRows, (r) => `${r.state}|${r.district}|${r.year}|${r.metric}`);
  const fraudUnique = dedupe(fraudRows, (r) => `${r.state}|${r.year}|${r.loss_bracket}`);

  const crimeDropped = crimeRows.length - crimeUnique.length;
  const fraudDropped = fraudRows.length - fraudUnique.length;

  // --- report --------------------------------------------------------------
  console.log('');
  console.log(`  rollup rows skipped      ${report.rollupsSkipped}   (TOTAL rows — loading them would double every figure)`);
  if (crimeDropped || fraudDropped) {
    console.log(`  duplicate keys collapsed ${crimeDropped + fraudDropped}`);
  }
  if (report.badYears) console.log(`  rows with an unusable year ${report.badYears}`);

  for (const note of report.notes) console.log(`  note     ${note}`);

  if (report.unmatchedStates.size) {
    console.log(`\n  ${report.unmatchedStates.size} state name(s) did not match the canonical list:`);
    for (const s of report.unmatchedStates) console.log(`      • "${s}"  → add an alias in src/services/stateNames.js`);
    console.log('    These rows were still loaded, but nothing on the map will join to them.');
  } else {
    console.log('  every state name matched the canonical list');
  }

  if (report.problems.length) {
    console.log('\n  problems:');
    for (const p of report.problems) console.log(`      • ${p}`);
  }

  if (VERBOSE) {
    const byYear = new Map();
    for (const r of crimeUnique) byYear.set(r.year, (byYear.get(r.year) || 0) + 1);
    console.log('\n  rows per year:');
    for (const year of [...byYear.keys()].sort()) console.log(`      ${year}  ${byYear.get(year)}`);
  }

  if (DRY_RUN) {
    console.log(`\n  --dry-run: nothing written. Would load ${crimeUnique.length} crime_reference `
      + `and ${fraudUnique.length} fraud_reference rows.\n`);
    await pool.end();
    return;
  }

  // --- write ---------------------------------------------------------------
  const client = await pool.connect();
  const startedAt = Date.now();
  try {
    await client.query('BEGIN');

    const crimeWritten = await bulkUpsert(
      client, 'crime_reference',
      ['state', 'district', 'year', 'metric', 'value', 'source_file'],
      ['state', 'district', 'year', 'metric'],
      crimeUnique
    );
    const fraudWritten = await bulkUpsert(
      client, 'fraud_reference',
      ['state', 'year', 'loss_bracket', 'cases', 'source_file'],
      ['state', 'year', 'loss_bracket'],
      fraudUnique
    );

    await client.query('COMMIT');

    console.log(`\n  wrote    crime_reference   ${String(crimeWritten).padStart(6)} rows`);
    console.log(`  wrote    fraud_reference   ${String(fraudWritten).padStart(6)} rows`);
    console.log(`  duration ${Date.now() - startedAt}ms\n`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // --- verify what landed --------------------------------------------------
  const { rows: check } = await pool.query(`
    SELECT metric, count(*)::int AS rows, min(year) AS from_year, max(year) AS to_year,
           count(DISTINCT state)::int AS states
      FROM crime_reference GROUP BY metric ORDER BY metric`);
  console.log('  crime_reference contents:');
  for (const r of check) {
    console.log(`      ${r.metric.padEnd(26)} ${String(r.rows).padStart(6)} rows  ${r.from_year}–${r.to_year}  ${r.states} states`);
  }

  const { rows: joined } = await pool.query(`
    SELECT count(DISTINCT c.state)::int AS complaint_states,
           count(DISTINCT r.state) FILTER (WHERE r.state IS NOT NULL)::int AS matched_states
      FROM (SELECT DISTINCT state FROM complaints WHERE state IS NOT NULL) c
      LEFT JOIN (SELECT DISTINCT state FROM crime_reference) r ON r.state = c.state`);

  const { complaint_states, matched_states } = joined[0];
  console.log(`\n  join check: ${matched_states}/${complaint_states} states in our complaints have NCRB reference data`);
  if (matched_states < complaint_states) {
    console.log('    A gap here means the Geo page will show a blank baseline for those states.');
  }
  console.log('');

  await pool.end();
}

main().catch(async (err) => {
  console.error(`\nReference load failed:\n  ${err.message}\n`);
  await pool.end().catch(() => {});
  process.exit(1);
});
