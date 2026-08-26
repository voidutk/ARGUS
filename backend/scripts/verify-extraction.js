/**
 * Prove that every identifier written into a narrative is actually extracted.
 *
 *   npm run verify-extraction
 *
 * ARGUS makes one claim above all others: it reads what a victim wrote and
 * turns the identifiers in it into nodes. The Complaint Detail page states that
 * claim out loud — it highlights each identifier in the narrative and counts
 * them ("4 of 6 quoted in the narrative"). So any identifier sitting in the
 * text WITHOUT a matching `complaint_entities` row is a visible refutation,
 * rendered in the product, on the screen a judge is most likely to read closely.
 *
 * That is exactly what this check was written to catch. The seeder used to
 * interpolate a throwaway wallet address into crypto narratives whenever the
 * caller passed no wallet, and never register it — leaving a 42-character
 * address in the text, unhighlighted and missing from the extracted list.
 *
 * The check runs the other way round from the seeder, deliberately: it reads
 * finished narratives out of the database and re-finds identifiers with
 * independent regexes. A bug in the seeder's bookkeeping cannot hide from it,
 * because it never consults the seeder's bookkeeping.
 */

const pool = require('../src/db/pool');
const { normalize } = require('../src/services/normalize');

/**
 * Deliberately separate from the extraction service's own patterns.
 *
 * If this file imported those regexes, the check would prove that extraction
 * agrees with itself. Written independently, it proves the narrative and the
 * database agree — which is the property the UI depends on.
 */
const PATTERNS = [
  { type: 'WALLET', re: /\b0x[a-fA-F0-9]{40}\b/g },
  { type: 'EMAIL', re: /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g },
  { type: 'UPI', re: /\b[\w.-]{3,}@(?:okhdfcbank|oksbi|okaxis|okicici|ybl|paytm|upi|ibl|apl|axl)\b/gi },
  { type: 'TELEGRAM', re: /@[a-zA-Z][\w]{4,}\b/g },
  { type: 'PHONE', re: /(?:\+91[\s-]?)?\b[6-9]\d{9}\b/g },
  { type: 'BANK_ACCOUNT', re: /(?<!\d)\d{11,18}(?!\d)/g },
];

/**
 * UPI ids and emails both contain '@', and a UPI id at a bank handle also
 * matches the email shape. Claim the more specific type first so a VPA is not
 * reported as a missing EMAIL.
 */
function identifiersIn(text) {
  const found = new Map();     // "TYPE::normalized" -> raw
  const claimed = [];          // [start, end) spans already taken

  const overlaps = (a, b) => a[0] < b[1] && b[0] < a[1];

  for (const { type, re } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const span = [m.index, m.index + m[0].length];
      if (claimed.some((c) => overlaps(span, c))) continue;
      claimed.push(span);
      const raw = m[0].trim();
      found.set(`${type}::${normalize(type, raw)}`, raw);
    }
  }
  return found;
}

async function main() {
  console.log('ARGUS — verifying narrative extraction coverage\n');

  const { rows } = await pool.query(`
    SELECT c.id, c.complaint_ref, c.narrative, c.victim_phone, c.victim_email,
           COALESCE(
             array_agg(e.entity_type || '::' || e.normalized_value)
               FILTER (WHERE e.id IS NOT NULL),
             '{}'
           ) AS linked
      FROM complaints c
      LEFT JOIN complaint_entities ce ON ce.complaint_id = c.id
      LEFT JOIN entities e ON e.id = ce.entity_id
     GROUP BY c.id
     ORDER BY c.id`);

  let quoted = 0;
  let missing = 0;
  const examples = [];
  const byType = {};

  for (const c of rows) {
    const linked = new Set(c.linked);
    for (const [key, raw] of identifiersIn(c.narrative)) {
      const [type] = key.split('::');
      byType[type] ??= { quoted: 0, missing: 0 };
      byType[type].quoted++;
      quoted++;

      if (linked.has(key)) continue;

      // The victim's own phone and email are quoted in some templates and are
      // linked under the VICTIM role — already covered by `linked`. Anything
      // still missing here is genuinely absent.
      byType[type].missing++;
      missing++;
      if (examples.length < 12) {
        examples.push(`${c.complaint_ref}  ${type.padEnd(13)} ${raw}`);
      }
    }
  }

  console.log(`  complaints scanned  ${rows.length}`);
  console.log(`  identifiers quoted  ${quoted}`);
  console.log(`  not extracted       ${missing}\n`);

  console.log('  by type');
  for (const [type, s] of Object.entries(byType).sort()) {
    const pct = s.quoted ? (100 * (s.quoted - s.missing)) / s.quoted : 100;
    console.log(
      `    ${type.padEnd(14)} ${String(s.quoted - s.missing).padStart(4)}/${String(s.quoted).padEnd(4)}`
      + `  ${pct.toFixed(1)}%${s.missing ? '   <-- gap' : ''}`
    );
  }

  if (missing) {
    console.log('\n  Identifiers present in a narrative but absent from complaint_entities:');
    for (const e of examples) console.log(`    ${e}`);
    console.log(
      '\n  FAILED — the Complaint Detail page will render these in the narrative'
      + '\n           without a highlight and omit them from the extracted list.\n'
    );
    process.exitCode = 1;
    return;
  }

  console.log('\n  Every identifier quoted in a narrative resolves to a linked entity.\n');
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error('\nverify-extraction failed:', err.message);
    process.exitCode = 1;
    return pool.end();
  });
