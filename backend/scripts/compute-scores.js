/**
 * Compute and persist entity influence + risk scores.
 *
 *   npm run compute-scores
 *
 * `seed.js` inserts every entity with `influence_score = 0` and
 * `risk_score = 0`, because at insert time neither is knowable — both are
 * properties of the finished graph, not of a row. Something has to run
 * afterwards to fill them in, and until this script existed nothing did: the
 * columns stayed at zero, and the Networks page rendered "influence 0" next to
 * the coordinator whose entire significance is that centrality ranks him first.
 *
 * This is the same code path `POST /api/analytics/run` takes, called directly
 * so a fresh database can be brought to a demo-ready state without a running
 * API or a login. It belongs in `npm run setup` for that reason.
 */

const pool = require('../src/db/pool');
const graph = require('../src/services/graphService');

async function main() {
  console.log('ARGUS — computing entity influence and risk\n');

  const t0 = Date.now();
  const result = await graph.persistScores();
  const ms = Date.now() - t0;

  console.log(`  entities scored   ${result.scored} / ${result.entities}`);
  console.log(`  highest influence ${result.top_influence}`);
  console.log(`  highest risk      ${result.top_risk}`);
  console.log(`  took              ${ms}ms\n`);

  // The demo claim is that centrality finds a coordinator who appears in no
  // complaint. Print the evidence rather than asserting it — if a change to the
  // graph ever breaks the ranking, this is where it shows up first.
  const { rows } = await pool.query(
    `SELECT e.value, e.entity_type, e.influence_score, e.risk_score,
            cl.cluster_key,
            (SELECT count(*)::int FROM complaint_entities ce WHERE ce.entity_id = e.id) AS complaints
       FROM entities e
       LEFT JOIN clusters cl ON cl.id = e.cluster_id
      ORDER BY e.influence_score DESC LIMIT 5`
  );

  console.log('  Top 5 by influence');
  for (const r of rows) {
    console.log(
      `    ${String(r.influence_score).padStart(3)}  risk ${String(r.risk_score).padStart(2)}  `
      + `${(r.cluster_key || '—').padEnd(6)} ${r.entity_type.padEnd(13)} ${r.value}`
      + `  (${r.complaints} complaint${r.complaints === 1 ? '' : 's'})`
    );
  }

  const top = rows[0];
  if (top && top.complaints === 0) {
    console.log(
      `\n  ${top.value} tops influence at ${top.influence_score} while appearing in NO complaint,`
      + `\n  and scores only ${top.risk_score} on risk — risk counts victims, and this one has none.`
      + '\n  That gap is the demo: a risk-ranked list cannot surface this entity.'
    );
  }
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\ncompute-scores failed:', err.message);
    pool.end().finally(() => process.exit(1));
  });
