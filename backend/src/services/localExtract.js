/**
 * The regex extraction tier, in Express.
 *
 * A deliberate second implementation, and the reasoning is narrow enough to be
 * worth stating: intel-service owns extraction, but Scene 2 of the demo
 * (docs/PROJECT.md §T) is the ONE moment that must be genuinely live, and it is
 * the moment where a dead optional service is most visible — the investigator
 * types a narrative and no entities appear. Everything else in §F degrades into
 * a slightly staler picture; this degrades into an empty panel.
 *
 * So intake tries FastAPI first and falls back to here. The response says which
 * tier answered, so nothing is misrepresented as AI when it was not.
 *
 * WHAT THIS IS NOT: it is not a reimplementation of the intelligence service.
 * There is no NER here and there never should be — spaCy's PERSON and LOCATION
 * tier is genuinely Python's job, and a JavaScript approximation of it would be
 * the kind of duplicated-maths trap that `intelClient`'s 501 handling exists to
 * avoid. This covers the deterministic tier only, which is the tier §I says
 * carries the demo.
 *
 * The patterns mirror intel-service/app/extract.py. If one changes, change both.
 */

const { normalize } = require('./normalize');

// An EVM address. Fixed length, unambiguous, so it is claimed first.
const WALLET_RE = /\b0x[a-fA-F0-9]{40}\b/g;

// Email before UPI: both contain '@', and the domain is what separates them —
// an email domain always has a dot, a UPI handle (okaxis, ybl, paytm) never does.
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const UPI_RE = /\b[A-Za-z0-9._-]{2,}@[A-Za-z][A-Za-z0-9]{1,}\b/g;

const TELEGRAM_RE = /(?<![A-Za-z0-9._%+-])@([A-Za-z][A-Za-z0-9_]{3,31})\b/g;

const IPV4_RE =
  /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g;

// Tolerant of separators inside the number — "+91 98765 43210" is how a person
// types a phone number, even though the generator writes them unspaced.
const PHONE_RE = /(?<!\d)(?:\+?91[\s-]?|0)?([6-9](?:[\s-]?\d){9})(?!\d)/g;

// 11–18 digits, bounded on digits only. The 11-digit minimum is what keeps
// rupee figures out: the largest amount in this corpus is seven digits.
const ACCOUNT_RE = /(?<!\d)(\d{11,18})(?!\d)/g;

// Recognised solely so its trailing digits cannot be read as an account number.
// Never emitted — `entities.entity_type` has no IFSC member, and adding one to
// hold a branch routing code would be modelling infrastructure as a suspect.
const IFSC_RE = /\b[A-Z]{4}0[A-Z0-9]{6}\b/g;

const CONTEXT_CHARS = 60;

function snippet(text, start, end) {
  const left = Math.max(0, start - CONTEXT_CHARS);
  const right = Math.min(text.length, end + CONTEXT_CHARS);
  const fragment = text.slice(left, right).replace(/\s+/g, ' ').trim();
  return `${left > 0 ? '…' : ''}${fragment}${right < text.length ? '…' : ''}`;
}

/**
 * Order is priority, and it is load-bearing. Each match claims its character
 * span so a later pattern cannot re-match inside it — without which
 * `imran@okhdfcbank` is both an EMAIL and a UPI, and `+919334825546` is a
 * twelve-digit bank account.
 */
const PIPELINE = [
  { re: WALLET_RE, type: 'WALLET', confidence: 0.99, group: 0 },
  { re: IFSC_RE, type: null, confidence: 0, group: 0 },
  { re: EMAIL_RE, type: 'EMAIL', confidence: 0.98, group: 0 },
  { re: UPI_RE, type: 'UPI', confidence: 0.97, group: 0 },
  { re: TELEGRAM_RE, type: 'TELEGRAM', confidence: 0.94, group: 1 },
  { re: IPV4_RE, type: 'IP', confidence: 0.96, group: 0 },
  { re: PHONE_RE, type: 'PHONE', confidence: 0.97, group: 1 },
  { re: ACCOUNT_RE, type: 'BANK_ACCOUNT', confidence: 0.95, group: 1 },
];

/**
 * Every identifier in one narrative.
 *
 * Returns the same shape as `POST /extract`, so the intake controller consumes
 * either source without branching on which one answered.
 */
function extract(narrative) {
  const startedAt = process.hrtime.bigint();
  const text = String(narrative ?? '');

  const claimed = [];
  const overlaps = (start, end) => claimed.some(([s, e]) => start < e && end > s);

  const found = [];
  for (const { re, type, confidence, group } of PIPELINE) {
    // The patterns are module-level and /g, so lastIndex must be reset or a
    // second call to this function resumes mid-string and misses matches.
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (overlaps(start, end)) continue;
      claimed.push([start, end]);
      if (!type) continue; // claimed but never emitted — IFSC

      const raw = match[group];
      const normalized = normalize(type, raw);
      if (!normalized) continue;

      found.push({
        type,
        value: String(raw).trim(),
        normalized_value: normalized,
        confidence,
        method: 'REGEX',
        context_snippet: snippet(text, start, end),
      });
    }
  }

  // One row per (type, normalized_value). The same UPI id named three times is
  // one entity mentioned three times — inserting it thrice would inflate that
  // node's degree and skew every centrality score computed from it.
  const seen = new Set();
  const entities = found.filter((e) => {
    const key = `${e.type}:${e.normalized_value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    entities,
    duration_ms: Number(process.hrtime.bigint() - startedAt) / 1e6,
    tiers: { regex: entities.length, ner: 0 },
  };
}

module.exports = { extract };
