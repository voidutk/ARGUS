/**
 * One named function per endpoint in docs/API.md.
 *
 * Pages never call `get('/api/...')` directly. Routing every call through a
 * named function means the frozen contract has exactly one representation in
 * this codebase — when a shape changes, the compiler-equivalent (a failing
 * import) points at the one file to fix, instead of a grep across twelve pages.
 */

import { get, post, patch, request } from './client';

export const auth = {
  login: (email, password) => post('/api/auth/login', { email, password }),
  me: () => get('/api/auth/me').then((d) => d.user),
};

export const dashboard = {
  summary: () => get('/api/dashboard/summary'),
};

export const complaints = {
  list: (params) => get('/api/complaints', params),
  detail: (id) => get(`/api/complaints/${id}`),
  create: (payload) => post('/api/complaints', payload),
  setStatus: (id, status) => patch(`/api/complaints/${id}`, { status }),
};

export const entities = {
  list: (params) => get('/api/entities', params),
  detail: (id) => get(`/api/entities/${id}`),
  why: (id) => get(`/api/entities/${id}/why`),
  osint: (id) => get(`/api/entities/${id}/osint`),
};

export const graph = {
  overview: (limit = 150) => get('/api/graph/overview', { limit }),
  neighbors: (nodeId, params) => get(`/api/graph/neighbors/${encodeURIComponent(nodeId)}`, params),
  cluster: (key) => get(`/api/graph/cluster/${encodeURIComponent(key)}`),
  why: (nodeId) => get(`/api/graph/why/${encodeURIComponent(nodeId)}`),
  path: (from, to) => get('/api/graph/path', { from, to }),
  common: (a, b) => get('/api/graph/common', { a, b }),
  rebuild: () => post('/api/graph/rebuild'),
};

export const clusters = {
  list: () => get('/api/clusters'),
  detail: (key) => get(`/api/clusters/${encodeURIComponent(key)}`),
  runAnalytics: () => post('/api/analytics/run'),
};

/** Layer 1 — the only genuinely official data. Every response is badged. */
export const reference = {
  meta: () => get('/api/reference/meta'),
  states: (params) => get('/api/reference/states', params),
  district: (state, district) =>
    get(`/api/reference/district/${encodeURIComponent(state)}/${encodeURIComponent(district)}`),
  trend: (params) => get('/api/reference/trend', params),
  fraud: (params) => get('/api/reference/fraud', params),
};

export const geo = {
  states: () => get('/api/geo/states'),
  routes: () => get('/api/geo/routes'),
};

export const money = {
  trace: (complaintId) => get(`/api/money/trace/${complaintId}`),
};

export const alerts = {
  list: (params) => get('/api/alerts', params),
  rules: () => get('/api/alerts/rules'),
  explain: (id) => get(`/api/alerts/${id}/explain`),
  setStatus: (id, status) => patch(`/api/alerts/${id}`, { status }),
  regenerate: () => post('/api/alerts/regenerate'),
};

export const timeline = {
  list: (params) => get('/api/timeline', params),
};

export const evidence = {
  list: (params) => get('/api/evidence', params),
  verify: (id) => post(`/api/evidence/${id}/verify`),
  history: (id) => get(`/api/evidence/${id}/history`),
  reanchor: (id) => post(`/api/evidence/${id}/anchor`),

  upload: (file, { title, evidenceType, complaintId } = {}) => {
    const form = new FormData();
    form.append('file', file);
    if (title) form.append('title', title);
    if (evidenceType) form.append('evidence_type', evidenceType);
    if (complaintId) form.append('complaint_id', String(complaintId));
    return request('/api/evidence/upload', { method: 'POST', body: form });
  },

  /**
   * Downloads through fetch rather than a plain link, because the exhibit is
   * behind a JWT and an `<a href>` cannot carry an Authorization header. The
   * blob is handed to a synthetic anchor so the browser still saves it with the
   * filename the server chose.
   */
  download: async (id, filename) => {
    const res = await request(`/api/evidence/${id}/download`, { raw: true });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || `evidence-${id}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
};

export const chain = {
  status: () => get('/api/chain/status'),
  transactions: () => get('/api/chain/transactions'),
};

export const osint = {
  adapters: () => get('/api/osint/adapters'),
};

export const admin = {
  users: () => get('/api/admin/users'),
  health: () => get('/api/admin/health'),
};
