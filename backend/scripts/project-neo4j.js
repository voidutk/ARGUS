/**
 * Project the Postgres corpus into Neo4j.
 *
 *   npm run project-neo4j
 *
 * Neo4j holds the graph projection that intel-service reads. Nothing populates
 * it at seed time — the API projects a complaint when one is FILED, so a freshly
 * seeded database leaves Neo4j holding only whatever was filed live since the
 * container started. The stack looked healthy the whole time, because it was:
 * Admin reported "Neo4j UP · connected" over a store with 19 nodes in it while
 * Postgres held 1,074 entities.
 *
 * This is the setup-time equivalent of `POST /api/graph/rebuild`, and exists
 * separately from it because `npm run setup` has no running API to call and no
 * token to call it with.
 *
 * Safe to re-run: the projection MERGEs on a deterministic node id, so a second
 * pass updates the same nodes instead of duplicating them.
 */

const pool = require('../src/db/pool');
const graph = require('../src/services/graphService');
const intel = require('../src/services/intelClient');

const CHUNK = 40;

async function main() {
  console.log('ARGUS — projecting the corpus into Neo4j\n');

  const health = await intel.health();
  if (!health.ok) {
    console.log(`  intel-service unreachable — ${health.reason}`);
    console.log('  Nothing to do. Postgres remains the graph of record, and every');
    console.log('  page keeps working from it (PROJECT.md §F).\n');
    return;
  }
  if (health.data?.neo4j_connected === false) {
    console.log(`  intel-service is up but Neo4j is not — ${health.data.neo4j_reason}`);
    console.log('  Start Neo4j and re-run. Nothing else is affected.\n');
    return;
  }

  console.log(`  intel-service ok · neo4j holds ${health.data?.node_count ?? '?'} nodes before this run`);

  const corpus = await graph.projectionCorpus();
  const entityLinks = corpus.reduce((n, c) => n + c.entities.length, 0);
  console.log(`  sending ${corpus.length} complaints · ${entityLinks} entity links\n`);

  const totals = { ingested: 0, nodes: 0, edges: 0, failed: 0 };

  for (let i = 0; i < corpus.length; i += CHUNK) {
    const chunk = corpus.slice(i, i + CHUNK);
    const res = await intel.ingestBulk({ source: 'postgres', complaints: chunk });

    if (!res.ok) {
      console.log(`\n  FAILED at complaint ${i + 1} — ${res.reason}`);
      console.log(`  ${totals.ingested} complaints were projected before the failure.\n`);
      process.exitCode = 1;
      return;
    }

    totals.ingested += res.data.ingested ?? 0;
    totals.nodes += res.data.nodes ?? 0;
    totals.edges += res.data.edges ?? 0;
    totals.failed += res.data.failed ?? 0;

    process.stdout.write(
      `\r  projected ${String(totals.ingested).padStart(4)} / ${corpus.length} complaints`
    );
  }

  const after = await intel.health();
  console.log(`\n\n  complaints projected  ${totals.ingested}`);
  console.log(`  entity nodes merged   ${totals.nodes}`);
  console.log(`  edges merged          ${totals.edges}`);
  if (totals.failed) console.log(`  failed                ${totals.failed}`);
  console.log(`  neo4j node count      ${after.data?.node_count ?? '?'}\n`);
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error('\nprojection failed:', err.message);
    process.exitCode = 1;
    return pool.end();
  });
