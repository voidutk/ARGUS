/**
 * Layer 1 — official NCRB statistics (docs/PLAN-V2-DATA-AND-INTEL.md §2).
 *
 * Every response from this file carries `provenance: 'NCRB · OFFICIAL'`, and
 * that field is the point of the endpoints existing at all. ARGUS shows three
 * kinds of data — real aggregates, our synthetic operational corpus, and live
 * OSINT — and the one thing that must never happen is a viewer being unable to
 * tell which is on screen. The badge is not a disclaimer bolted on; it is part
 * of the payload, so a UI cannot render this data without it.
 *
 * These are counts of recorded cases, per district, per year. They cannot be
 * correlated, they name nobody, and they are not the network layer. What they
 * are is verifiable — the district sums reconcile exactly with NCRB's own
 * published totals — and that verifiability is what makes the synthetic layer
 * sitting next to them credible.
 */

const pool = require('../db/pool');
const { asyncHandler, notFound } = require('../lib/errors');
const { ALL_STATES } = require('../services/stateNames');

const PROVENANCE = 'NCRB · OFFICIAL';
const SOURCE_NOTE =
  'National Crime Records Bureau, district-wise IPC crime statistics 2001–2014. '
  + 'Counts of cases recorded, not individuals. State totals reconcile with NCRB published rollups.';

/**
 * GET /api/reference/states?metric=CHEATING&year=2014
 *
 * The choropleth's data source. Returns one row per state with the value, plus
 * an `intensity` scaled to the worst-hit state so the map stays readable at any
 * absolute volume — the same relative banding the synthetic layer uses, so the
 * two layers are visually comparable when toggled.
 */
const states = asyncHandler(async (req, res) => {
  const { metric, year } = req.valid.query;

  const { rows } = await pool.query(
    `SELECT state,
            SUM(value)::int                  AS value,
            count(DISTINCT district)::int    AS districts
       FROM crime_reference
      WHERE metric = $1 AND year = $2
      GROUP BY state
      ORDER BY SUM(value) DESC`,
    [metric, year]
  );

  const max = Math.max(...rows.map((r) => r.value), 1);
  res.json({
    metric,
    year,
    provenance: PROVENANCE,
    source_note: SOURCE_NOTE,
    max_value: max,
    states: rows.map((r) => ({
      ...r,
      intensity: Number((r.value / max).toFixed(3)),
      risk_level:
        r.value / max > 0.66 ? 'CRITICAL'
        : r.value / max > 0.4 ? 'HIGH'
        : r.value / max > 0.15 ? 'MEDIUM' : 'LOW',
    })),
  });
});

/**
 * GET /api/reference/district/:state/:district
 *
 * The baseline panel on Complaint Intelligence: "Cheating cases in Bengaluru
 * City, 2014: 3,045 (NCRB)". One real, cited number beside our synthetic
 * network, which is worth more than a page of synthetic numbers alone.
 */
/**
 * Resolves our district name to NCRB's.
 *
 * They disagree far more often than they agree — only 15 of the 30 districts in
 * our corpus match exactly. NCRB carries administrative suffixes our complaints
 * do not: "Bengaluru City", "Hyderabad City", "Pune Commr." (Commissionerate),
 * "Kanpur Dehat". Matching on equality alone meant the baseline panel silently
 * vanished for half the country, which reads as missing data rather than as a
 * naming mismatch.
 *
 * Candidates are tried most-specific first, and the name that MATCHED is
 * returned alongside the figures. That is the important part: "Kanpur" resolving
 * to "Kanpur Dehat" is arguably the wrong place — Dehat is rural Kanpur, not
 * the city — and showing the resolved name is what lets a reader catch it
 * instead of trusting a number attributed to somewhere it did not come from.
 */
async function resolveDistrict(state, wanted) {
  /**
   * Urban variants are tried before the bare prefix, because our complaints
   * name CITIES — Pune, Bengaluru, Surat — while NCRB splits each into an
   * urban and a rural unit. A plain prefix match sorted by name length picks
   * "Pune Rural" over "Pune Commr.", attributing a city complaint's baseline to
   * the surrounding countryside, where the figures are several times lower.
   *
   * "Commr." is a Commissionerate: the metropolitan police jurisdiction, which
   * is the right counterpart to a city complaint. "Nagar" likewise distinguishes
   * urban Kanpur from "Kanpur Dehat".
   */
  const attempts = [
    { param: wanted, exact: true },
    { param: `${wanted} City`, exact: false },
    { param: `${wanted} Commr.`, exact: false },
    { param: `${wanted} Nagar`, exact: false },
    { param: `${wanted} Urban`, exact: false },
    { param: `${wanted}%`, exact: false },
    { param: `%${wanted}%`, exact: false },
  ];

  for (const attempt of attempts) {
    const { rows } = await pool.query(
      `SELECT district FROM crime_reference
        WHERE state = $1 AND district ILIKE $2
        GROUP BY district
        ORDER BY count(*) DESC, length(district) ASC
        LIMIT 1`,
      [state, attempt.param]
    );
    if (rows[0]) return { district: rows[0].district, exact: attempt.exact };
  }
  return null;
}

const district = asyncHandler(async (req, res) => {
  const { state, district: requested } = req.valid.params;

  const resolved = await resolveDistrict(state, requested);
  if (!resolved) throw notFound(`NCRB reference data for ${requested}, ${state}`);
  const districtName = resolved.district;

  const { rows } = await pool.query(
    `SELECT metric, year, value
       FROM crime_reference
      WHERE state = $1 AND district = $2
      ORDER BY year DESC, metric`,
    [state, districtName]
  );
  if (!rows.length) throw notFound(`NCRB reference data for ${requested}, ${state}`);

  const latestYear = Math.max(...rows.map((r) => r.year));
  const latest = Object.fromEntries(
    rows.filter((r) => r.year === latestYear).map((r) => [r.metric, r.value])
  );

  // The state's own figure for the same year, so a district number has
  // something to be a proportion of rather than floating unanchored.
  const { rows: stateTotals } = await pool.query(
    `SELECT metric, SUM(value)::int AS value
       FROM crime_reference
      WHERE state = $1 AND year = $2
      GROUP BY metric`,
    [state, latestYear]
  );

  res.json({
    state,
    district: districtName,
    // What was asked for, and whether NCRB spells it the same way. The UI shows
    // the resolved name so a figure is never attributed to a place it did not
    // come from.
    requested_district: requested,
    exact_match: resolved.exact,
    provenance: PROVENANCE,
    source_note: SOURCE_NOTE,
    latest_year: latestYear,
    latest,
    state_totals: Object.fromEntries(stateTotals.map((r) => [r.metric, r.value])),
    share_of_state: Object.fromEntries(
      stateTotals
        .filter((s) => latest[s.metric] !== undefined && s.value > 0)
        .map((s) => [s.metric, Number((latest[s.metric] / s.value).toFixed(4))])
    ),
    series: rows,
  });
});

/**
 * GET /api/reference/trend?state=X&metric=CHEATING
 *
 * The 2001–2014 sparkline. Returns the state series and the national series
 * together: a state rising while the country is flat is a finding, and the same
 * state rising with the country is not.
 */
const trend = asyncHandler(async (req, res) => {
  const { state, metric, district: districtName } = req.valid.query;

  const params = [metric];
  let scope = '';
  if (state) { params.push(state); scope += ` AND state = $${params.length}`; }
  if (districtName) { params.push(districtName); scope += ` AND district ILIKE $${params.length}`; }

  const [series, national] = await Promise.all([
    pool.query(
      `SELECT year, SUM(value)::int AS value
         FROM crime_reference
        WHERE metric = $1 ${scope}
        GROUP BY year ORDER BY year`,
      params
    ),
    pool.query(
      `SELECT year, SUM(value)::int AS value
         FROM crime_reference
        WHERE metric = $1
        GROUP BY year ORDER BY year`,
      [metric]
    ),
  ]);

  if (!series.rows.length) throw notFound('NCRB reference data for that selection');

  const first = series.rows[0];
  const last = series.rows[series.rows.length - 1];
  const changePct = first.value > 0
    ? Number((((last.value - first.value) / first.value) * 100).toFixed(1))
    : null;

  res.json({
    metric,
    state: state || null,
    district: districtName || null,
    provenance: PROVENANCE,
    source_note: SOURCE_NOTE,
    series: series.rows,
    national: national.rows,
    summary: {
      from_year: first.year,
      to_year: last.year,
      from_value: first.value,
      to_value: last.value,
      change_pct: changePct,
    },
  });
});

/**
 * GET /api/reference/fraud?year=2010
 *
 * Serious-fraud case counts bucketed by loss. Kept separate from the IPC
 * metrics because the unit differs: these are cases above a rupee threshold,
 * not offences of a type, and plotting them on the same axis would be wrong.
 */
const fraud = asyncHandler(async (req, res) => {
  const { year, state } = req.valid.query;

  const params = [];
  const where = [];
  if (year) { params.push(year); where.push(`year = $${params.length}`); }
  if (state) { params.push(state); where.push(`state = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const { rows } = await pool.query(
    `SELECT state, year, loss_bracket, cases
       FROM fraud_reference ${whereSql}
      ORDER BY year, state, loss_bracket`,
    params
  );

  const byBracket = {};
  for (const r of rows) byBracket[r.loss_bracket] = (byBracket[r.loss_bracket] || 0) + r.cases;

  res.json({
    provenance: PROVENANCE,
    source_note: 'NCRB serious fraud statistics 2001–2010, bucketed by property loss.',
    year: year || null,
    state: state || null,
    rows,
    totals_by_bracket: byBracket,
  });
});

/**
 * GET /api/reference/meta
 *
 * What Layer 1 actually holds — the years, metrics and states available. The
 * frontend builds its year selector and layer toggle from this rather than
 * hardcoding a range that would quietly go stale when a new year is loaded.
 */
const meta = asyncHandler(async (req, res) => {
  const [coverage, years, statesRow] = await Promise.all([
    pool.query(
      `SELECT metric, min(year) AS from_year, max(year) AS to_year,
              count(*)::int AS rows, count(DISTINCT state)::int AS states
         FROM crime_reference GROUP BY metric ORDER BY metric`
    ),
    pool.query(`SELECT DISTINCT year FROM crime_reference ORDER BY year DESC`),
    pool.query(`SELECT DISTINCT state FROM crime_reference ORDER BY state`),
  ]);

  res.json({
    provenance: PROVENANCE,
    source_note: SOURCE_NOTE,
    loaded: coverage.rows.length > 0,
    metrics: coverage.rows,
    years: years.rows.map((r) => r.year),
    states: statesRow.rows.map((r) => r.state),
    canonical_states: ALL_STATES,
    // Stated in the payload rather than only in documentation, so any surface
    // that renders this data can repeat the caveat accurately.
    caveats: [
      'Counts of cases recorded by police, not individuals or amounts.',
      'Telangana appears from 2014 onward; earlier years count its districts under Andhra Pradesh.',
      'FORGERY is only reported in the 2014 schema.',
      'State rollup rows are excluded; district sums reconcile with NCRB published totals.',
    ],
  });
});

module.exports = { states, district, trend, fraud, meta };
