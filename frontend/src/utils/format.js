/**
 * Formatting and the categorical palettes.
 *
 * docs/PROJECT.md §K makes one rule non-negotiable: cluster colours are
 * categorical and must stay STABLE ACROSS EVERY PAGE. Alpha is the same purple
 * in the graph, on the map, and in the threat feed. That is not decoration — an
 * investigator builds a mental index on those colours, and a cluster that
 * changes hue between two pages silently destroys it. So the mapping lives
 * here, in one file, and nothing else is allowed to pick a cluster colour.
 */

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Rupees, in the Indian numbering system.
 *
 * The API sends a number and the frontend formats it (docs/API.md). Indian
 * digit grouping is 2,2,3 — ₹12,34,567 not ₹1,234,567 — and `en-IN` handles it
 * correctly. Getting this wrong is the kind of detail an Indian police officer
 * notices in the first three seconds.
 */
export function inr(value, { compact = false } = {}) {
  const n = Number(value) || 0;
  if (compact) {
    if (n >= 1e7) return `₹${(n / 1e7).toFixed(n >= 1e8 ? 0 : 2)} Cr`;
    if (n >= 1e5) return `₹${(n / 1e5).toFixed(n >= 1e6 ? 0 : 2)} L`;
    if (n >= 1e3) return `₹${(n / 1e3).toFixed(0)}K`;
  }
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

/** Plain counts, grouped. */
export const num = (value) => (Number(value) || 0).toLocaleString('en-IN');

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const UNITS = [
  ['year', 31536000],
  ['month', 2592000],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
];

/** "3 hours ago". Used wherever recency matters more than the exact instant. */
export function ago(iso) {
  if (!iso) return '—';
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 45) return 'just now';
  for (const [unit, size] of UNITS) {
    if (seconds >= size) return RELATIVE.format(-Math.round(seconds / size), unit);
  }
  return 'just now';
}

/** "12 Aug, 14:32" — the exact instant, for audit rows and evidence. */
export function stamp(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

export function dateOnly(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/**
 * Elides a long identifier in the MIDDLE, never at the end.
 *
 * A wallet address truncated to `0x4a2b8c1d…` is ambiguous — the tail is what
 * distinguishes two addresses sharing a prefix, and vanity prefixes make that
 * common. Keeping both ends means an investigator can compare two on sight.
 */
export function elide(value, head = 8, tail = 6) {
  const s = String(value ?? '');
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/** A graph node id is `<type>:<value>`; sometimes only the value is wanted. */
export const nodeValue = (nodeId) => String(nodeId ?? '').split(':').slice(1).join(':');

// ---------------------------------------------------------------------------
// Categorical palettes
// ---------------------------------------------------------------------------

/**
 * Cluster identity colours.
 *
 * Assigned by cluster_key so the same organisation is the same colour on every
 * surface, and by a stable hash for keys beyond the seeded three — a fourth
 * cluster discovered live still gets a consistent colour rather than falling
 * through to grey.
 */
const CLUSTER_COLOURS = {
  ALPHA: '#a855f7',
  BETA: '#2e6ff2',
  GAMMA: '#10b981',
  DELTA: '#f5a623',
  EPSILON: '#ec4899',
  ZETA: '#06b6d4',
};

const FALLBACK_CYCLE = ['#a855f7', '#2e6ff2', '#10b981', '#f5a623', '#ec4899', '#06b6d4'];

export function clusterColour(key) {
  if (!key) return '#556074';
  const known = CLUSTER_COLOURS[String(key).toUpperCase()];
  if (known) return known;
  let hash = 0;
  for (const ch of String(key)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK_CYCLE[hash % FALLBACK_CYCLE.length];
}

/**
 * Severity colours, shared by the threat feed, the map and every badge.
 *
 * Deliberately only four, and deliberately the conventional ones: red reads as
 * urgent to everyone, and an intelligence tool is the wrong place to be
 * inventive about that.
 */
export const SEVERITY = {
  CRITICAL: { colour: '#ff4757', label: 'Critical' },
  HIGH: { colour: '#f5a623', label: 'High' },
  MEDIUM: { colour: '#5b93ff', label: 'Medium' },
  LOW: { colour: '#8b9bb4', label: 'Low' },
};

export const severityColour = (s) => (SEVERITY[String(s).toUpperCase()]?.colour ?? '#8b9bb4');

/**
 * Entity type glyphs and colours for the graph and the entity chips.
 *
 * Type colour is intentionally MUTED compared with cluster colour: in the
 * Network Explorer, cluster membership is the signal an investigator is reading
 * and entity type is context. If both shouted, neither would be legible.
 */
export const ENTITY_TYPES = {
  PHONE: { label: 'Phone', glyph: '☏' },
  UPI: { label: 'UPI', glyph: '⇄' },
  BANK_ACCOUNT: { label: 'Account', glyph: '▤' },
  WALLET: { label: 'Wallet', glyph: '◈' },
  EMAIL: { label: 'Email', glyph: '✉' },
  IP: { label: 'IP', glyph: '⌂' },
  DEVICE: { label: 'Device', glyph: '▣' },
  LOCATION: { label: 'Location', glyph: '⌖' },
  PERSON: { label: 'Person', glyph: '◉' },
  TELEGRAM: { label: 'Telegram', glyph: '➤' },
  COMPLAINT: { label: 'Complaint', glyph: '▢' },
};

export const entityLabel = (type) => ENTITY_TYPES[type]?.label ?? type;

/** Scam categories, humanised. The API sends SCREAMING_SNAKE. */
export function scamLabel(category) {
  if (!category) return '—';
  return String(category)
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Complaint and investigation statuses, humanised the same way. */
export const statusLabel = scamLabel;

// ---------------------------------------------------------------------------
// Provenance — docs/PLAN-V2-DATA-AND-INTEL.md §1
// ---------------------------------------------------------------------------

/**
 * Resolves the badge for a payload.
 *
 * The rule the plan sets is that provenance is driven by a field IN THE
 * RESPONSE, never by which page is rendering. A page cannot decide it is
 * showing official data; only the payload can say so. This function is the
 * single place that reads it, so no surface can quietly skip the badge.
 */
export function provenanceOf(payload) {
  const declared = payload?.provenance;
  if (declared === 'NCRB · OFFICIAL') {
    return { key: 'OFFICIAL', label: 'NCRB · OFFICIAL', colour: '#10b981' };
  }
  if (declared === 'SYNTHETIC') {
    return { key: 'SYNTHETIC', label: 'SYNTHETIC', colour: '#5b93ff' };
  }
  if (payload?.simulated === true) {
    return { key: 'SIMULATED', label: 'SIMULATED', colour: '#f5a623' };
  }
  return null;
}
