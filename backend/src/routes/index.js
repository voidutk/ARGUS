/**
 * All routes, in one place, mirroring docs/API.md section by section.
 *
 * A single router file rather than nine: the API is ~25 endpoints, and having
 * them visible together makes drift from the frozen contract obvious at a
 * glance. If this file stops fitting on two screens, split it then.
 */

const express = require('express');
const multer = require('multer');
const env = require('../config/env');

const authJwt = require('../middleware/authJwt');
const rbac = require('../middleware/rbac');
const { loginLimiter } = require('../middleware/rateLimit');

const auth = require('../controllers/authController');
const complaints = require('../controllers/complaintsController');
const graph = require('../controllers/graphController');
const evidence = require('../controllers/evidenceController');
const dashboard = require('../controllers/dashboardController');
const I = require('../controllers/intelControllers');

const router = express.Router();

// Evidence is held in memory just long enough to hash and encrypt it; the
// plaintext never touches disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.maxUploadMb * 1024 * 1024 },
});

// --- auth ------------------------------------------------------------------
router.post('/auth/login', loginLimiter, auth.login);
router.get('/auth/me', authJwt, auth.me);

// Everything below requires a valid token.
router.use(authJwt);

// --- dashboard -------------------------------------------------------------
router.get('/dashboard/summary', dashboard.summary);

// --- complaints ------------------------------------------------------------
router.get('/complaints', complaints.list);
router.get('/complaints/:id', complaints.detail);
router.post('/complaints', complaints.create);

// --- entities --------------------------------------------------------------
router.get('/entities', I.listEntities);
router.get('/entities/:id', I.entityDetail);

// --- graph -----------------------------------------------------------------
router.get('/graph/overview', graph.overview);
router.get('/graph/neighbors/:nodeId', graph.neighbors);
router.get('/graph/cluster/:clusterKey', graph.cluster);
router.post('/graph/rebuild', rbac('ADMIN'), graph.rebuild);

// --- clusters & analytics --------------------------------------------------
router.get('/clusters', I.listClusters);
router.get('/clusters/:key', I.clusterDetail);
router.post('/analytics/run', rbac('ADMIN', 'ANALYST'), I.runAnalytics);

// --- geo -------------------------------------------------------------------
router.get('/geo/states', I.geoStates);
router.get('/geo/routes', I.geoRoutes);

// --- money flow ------------------------------------------------------------
router.get('/money/trace/:complaintId', I.moneyTrace);

// --- alerts / threat feed --------------------------------------------------
router.get('/alerts', I.listAlerts);
router.patch('/alerts/:id', I.updateAlert);

// --- timeline --------------------------------------------------------------
router.get('/timeline', I.timeline);

// --- evidence & chain ------------------------------------------------------
router.get('/evidence', evidence.list);
router.post('/evidence/upload', upload.single('file'), evidence.upload);
router.post('/evidence/:id/verify', evidence.verify);
router.get('/evidence/:id/history', evidence.history);
router.get('/evidence/:id/download', evidence.download);
router.get('/chain/status', evidence.chainStatus);
router.get('/chain/transactions', evidence.chainTransactions);

// --- admin -----------------------------------------------------------------
router.get('/admin/users', rbac('ADMIN', 'SUPERVISOR'), I.adminUsers);
router.get('/admin/health', I.adminHealth);

module.exports = router;
