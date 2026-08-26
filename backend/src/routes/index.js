/**
 * All routes, in one place, mirroring docs/API.md section by section.
 *
 * A single router file rather than nine: the API is ~35 endpoints, and having
 * them visible together makes drift from the frozen contract obvious at a
 * glance. If this file stops fitting on three screens, split it then.
 *
 * Every route that takes input declares its schema here rather than validating
 * inside the handler. Two reasons: the route table becomes a readable statement
 * of what the API accepts, and a handler cannot forget — an unvalidated field
 * simply is not present on `req.valid`.
 */

const express = require('express');
const multer = require('multer');
const env = require('../config/env');

const authJwt = require('../middleware/authJwt');
const rbac = require('../middleware/rbac');
const { loginLimiter, writeLimiter } = require('../middleware/rateLimit');
const {
  z, validate, idParam, limit, offset, searchText, rupees,
  SCAM_CATEGORIES, COMPLAINT_STATUSES, ENTITY_TYPES, SEVERITIES, ALERT_STATUSES, EVIDENCE_TYPES,
} = require('../lib/validate');

const auth = require('../controllers/authController');
const complaints = require('../controllers/complaintsController');
const graph = require('../controllers/graphController');
const evidence = require('../controllers/evidenceController');
const dashboard = require('../controllers/dashboardController');
const reference = require('../controllers/referenceController');
const I = require('../controllers/intelControllers');

const router = express.Router();

// Evidence is held in memory just long enough to hash and encrypt it; the
// plaintext never touches disk. `files: 1` matters as much as the size cap — a
// request with 500 small files would otherwise pass the size limit and exhaust
// memory one part at a time.
//
// fileFilter is a plausibility check, not a security boundary by itself —
// MIME type is client-supplied and trivially spoofable — but it does stop
// obviously-wrong uploads (executables, archives) before they are ever
// encrypted and anchored as if they were legitimate evidence. The real XSS
// defense is in evidenceController.download(), which never trusts this value
// on the way back out.
const ALLOWED_EVIDENCE_MIME = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'application/pdf',
  'text/plain', 'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4',
  'video/mp4',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.maxUploadMb * 1024 * 1024, files: 1, fields: 12 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_EVIDENCE_MIME.has(file.mimetype)) {
      const err = new Error(`rejected upload: unsupported mime type "${file.mimetype}"`);
      err.status = 400;
      err.publicMessage = `File type "${file.mimetype}" is not accepted as evidence`;
      return cb(err);
    }
    cb(null, true);
  },
});

// Roles that legitimately handle raw exhibit bytes. ANALYST can still see
// metadata and the custody trail via list()/history() — just not the
// decrypted file itself.
const EVIDENCE_ROLES = ['ADMIN', 'SUPERVISOR', 'INVESTIGATOR'];

/**
 * Graph node ids look like `wallet:0x4a2b…`, `complaint:812`, or
 * `person:vikram rathore`. They are matched against a cached map rather than
 * interpolated into SQL, but they are still bounded and character-restricted —
 * an unbounded path segment reaching a Map lookup is how a 4 MB URL becomes a
 * memory spike.
 *
 * Spaces are allowed and must be: PERSON and LOCATION entities normalise to
 * lowercased text with internal spaces intact, so `person:vikram rathore` is a
 * real id and rejecting it would break the Explorer on exactly the nodes that
 * matter most. Slashes and control characters are not allowed — neither can
 * occur in a normalised value, and both are how a path segment stops being one.
 */
const nodeId = z.string().trim().min(3).max(200).regex(
  /^[a-z_]+:[^/\x00-\x1f]{1,180}$/i,
  'must look like "<type>:<value>", e.g. "wallet:0x4a2b…"'
);

const clusterKey = z.string().trim().min(1).max(20)
  .transform((s) => s.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9_-]+$/, 'cluster keys are alphanumeric'));

const stateName = z.string().trim().min(2).max(80);
const REFERENCE_METRICS = ['CHEATING', 'CRIMINAL_BREACH_OF_TRUST', 'FORGERY', 'TOTAL_IPC'];

// --- auth ------------------------------------------------------------------
router.post('/auth/login',
  loginLimiter,
  validate({
    body: z.object({
      // Not `.email()`: the lookup is an exact match on a stored address, and
      // rejecting an unusual-but-valid address at the edge would lock out a
      // real account. Length and lowercasing are what actually matter here.
      email: z.string().trim().toLowerCase().min(3).max(255),
      password: z.string().min(1).max(200),
    }),
  }),
  auth.login);

router.get('/auth/me', authJwt, auth.me);

// Everything below requires a valid token.
router.use(authJwt);

// --- dashboard -------------------------------------------------------------
router.get('/dashboard/summary', dashboard.summary);

// --- complaints ------------------------------------------------------------
router.get('/complaints',
  validate({
    query: z.object({
      limit: limit(50, 200),
      offset,
      state: stateName.optional(),
      category: z.enum(SCAM_CATEGORIES).optional(),
      status: z.enum(COMPLAINT_STATUSES).optional(),
      cluster: clusterKey.optional(),
      q: searchText.optional(),
    }),
  }),
  complaints.list);

router.get('/complaints/:id',
  validate({ params: z.object({ id: idParam }) }),
  complaints.detail);

router.post('/complaints',
  writeLimiter,
  validate({
    body: z.object({
      victim_name: z.string().trim().min(2).max(120),
      victim_phone: z.string().trim().max(20).optional().nullable().transform((v) => v || null),
      victim_email: z.string().trim().toLowerCase().max(255).optional().nullable()
        .transform((v) => v || null),
      // The narrative is what /extract reads. A floor stops empty filings; the
      // ceiling stops a multi-megabyte body becoming an 8-second NLP call.
      narrative: z.string().trim().min(10).max(20_000),
      scam_category: z.enum(SCAM_CATEGORIES).default('OTHER'),
      amount_inr: rupees.default(0),
      state: stateName.optional().nullable().transform((v) => v || null),
      district: z.string().trim().max(80).optional().nullable().transform((v) => v || null),
      lat: z.coerce.number().min(-90).max(90).optional().nullable().default(null),
      lon: z.coerce.number().min(-180).max(180).optional().nullable().default(null),
    }),
  }),
  complaints.create);

router.patch('/complaints/:id',
  writeLimiter,
  rbac('ADMIN', 'SUPERVISOR', 'INVESTIGATOR'),
  validate({
    params: z.object({ id: idParam }),
    body: z.object({ status: z.enum(COMPLAINT_STATUSES) }),
  }),
  complaints.updateStatus);

// --- entities --------------------------------------------------------------
router.get('/entities',
  validate({
    query: z.object({
      limit: limit(50, 200),
      offset,
      type: z.enum(ENTITY_TYPES).optional(),
      // `?flagged=true` arrives as a string; coerced here so the handler gets a
      // boolean and `?flagged=false` means what it says rather than being truthy.
      flagged: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
      cluster: clusterKey.optional(),
      q: searchText.optional(),
    }),
  }),
  I.listEntities);

router.get('/entities/:id',
  validate({ params: z.object({ id: idParam }) }),
  I.entityDetail);

// PLAN-V2 §3.1 — explainability, addressed by database id.
router.get('/entities/:id/why',
  validate({ params: z.object({ id: idParam }) }),
  I.entityWhy);

// PLAN-V2 §3.4 — OSINT enrichment. Every result carries its own provenance.
router.get('/entities/:id/osint',
  validate({ params: z.object({ id: idParam }) }),
  I.entityOsint);

router.get('/osint/adapters', I.osintAdapters);

// --- graph -----------------------------------------------------------------
router.get('/graph/overview',
  validate({ query: z.object({ limit: limit(150, 600) }) }),
  graph.overview);

router.get('/graph/neighbors/:nodeId',
  validate({
    params: z.object({ nodeId }),
    query: z.object({ depth: limit(1, 3), limit: limit(50, 200) }),
  }),
  graph.neighbors);

router.get('/graph/cluster/:clusterKey',
  validate({ params: z.object({ clusterKey }) }),
  graph.cluster);

// PLAN-V2 §3.1 / §3.2 — the investigator's explanation tools.
router.get('/graph/why/:nodeId',
  validate({ params: z.object({ nodeId }) }),
  graph.why);

router.get('/graph/path',
  validate({ query: z.object({ from: nodeId, to: nodeId }) }),
  graph.path);

router.get('/graph/common',
  validate({ query: z.object({ a: nodeId, b: nodeId }) }),
  graph.common);

router.post('/graph/rebuild', writeLimiter, rbac('ADMIN'), graph.rebuild);

// --- clusters & analytics --------------------------------------------------
router.get('/clusters', I.listClusters);

router.get('/clusters/:key',
  validate({ params: z.object({ key: clusterKey }) }),
  I.clusterDetail);

router.post('/analytics/run', writeLimiter, rbac('ADMIN', 'ANALYST'), I.runAnalytics);

// --- reference data (NCRB · OFFICIAL) — PLAN-V2 §2 --------------------------
router.get('/reference/meta', reference.meta);

router.get('/reference/states',
  validate({
    query: z.object({
      metric: z.enum(REFERENCE_METRICS).default('CHEATING'),
      year: z.coerce.number().int().min(1990).max(2100).default(2014),
    }),
  }),
  reference.states);

router.get('/reference/district/:state/:district',
  validate({
    params: z.object({
      state: stateName,
      district: z.string().trim().min(1).max(80),
    }),
  }),
  reference.district);

router.get('/reference/trend',
  validate({
    query: z.object({
      metric: z.enum(REFERENCE_METRICS).default('CHEATING'),
      state: stateName.optional(),
      district: z.string().trim().min(1).max(80).optional(),
    }),
  }),
  reference.trend);

router.get('/reference/fraud',
  validate({
    query: z.object({
      year: z.coerce.number().int().min(1990).max(2100).optional(),
      state: stateName.optional(),
    }),
  }),
  reference.fraud);

// --- geo -------------------------------------------------------------------
router.get('/geo/states', I.geoStates);
router.get('/geo/routes', I.geoRoutes);

// --- money flow ------------------------------------------------------------
router.get('/money/trace/:complaintId',
  validate({ params: z.object({ complaintId: idParam }) }),
  I.moneyTrace);

// --- alerts / threat feed --------------------------------------------------
router.get('/alerts',
  validate({
    query: z.object({
      limit: limit(40, 200),
      severity: z.enum(SEVERITIES).optional(),
      status: z.enum(ALERT_STATUSES).optional(),
      rule: z.string().trim().max(40).optional(),
    }),
  }),
  I.listAlerts);

router.get('/alerts/rules', I.listAlertRules);

router.get('/alerts/:id/explain',
  validate({ params: z.object({ id: idParam }) }),
  I.explainAlert);

router.patch('/alerts/:id',
  writeLimiter,
  validate({
    params: z.object({ id: idParam }),
    body: z.object({ status: z.enum(ALERT_STATUSES) }),
  }),
  I.updateAlert);

router.post('/alerts/regenerate', writeLimiter, rbac('ADMIN', 'ANALYST'), I.regenerateAlerts);

// --- timeline --------------------------------------------------------------
router.get('/timeline',
  validate({
    query: z.object({
      limit: limit(80, 300),
      offset,
      action: z.string().trim().max(80).optional(),
      actor_id: idParam.optional(),
    }),
  }),
  I.timeline);

// --- evidence & chain ------------------------------------------------------
router.get('/evidence',
  validate({
    query: z.object({
      limit: limit(100, 200),
      offset,
      complaint_id: idParam.optional(),
    }),
  }),
  evidence.list);

router.post('/evidence/upload',
  writeLimiter,
  rbac(...EVIDENCE_ROLES),
  upload.single('file'),
  // Runs AFTER multer, which is what populates req.body for a multipart request.
  validate({
    body: z.object({
      title: z.string().trim().max(255).optional(),
      evidence_type: z.enum(EVIDENCE_TYPES).default('DOCUMENT'),
      complaint_id: idParam.optional().nullable().default(null),
    }),
  }),
  evidence.upload);

router.post('/evidence/:id/verify',
  writeLimiter,
  rbac(...EVIDENCE_ROLES),
  validate({ params: z.object({ id: idParam }) }),
  evidence.verify);

router.post('/evidence/:id/anchor',
  writeLimiter,
  rbac('ADMIN', 'SUPERVISOR'),
  validate({ params: z.object({ id: idParam }) }),
  evidence.reanchor);

router.get('/evidence/:id/history',
  validate({ params: z.object({ id: idParam }) }),
  evidence.history);

router.get('/evidence/:id/download',
  rbac(...EVIDENCE_ROLES),
  validate({ params: z.object({ id: idParam }) }),
  evidence.download);

router.post('/evidence/integrity-sweep', writeLimiter, rbac('ADMIN'), evidence.integritySweep);

router.get('/chain/status', evidence.chainStatus);
router.get('/chain/transactions', evidence.chainTransactions);
router.post('/chain/retry-failed', writeLimiter, rbac('ADMIN'), evidence.retryFailedAnchors);

// --- admin -----------------------------------------------------------------
router.get('/admin/users', rbac('ADMIN', 'SUPERVISOR'), I.adminUsers);
router.get('/admin/health', I.adminHealth);

module.exports = router;
