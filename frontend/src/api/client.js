/**
 * The HTTP layer. Every request to the Express API goes through `request`.
 *
 * Three things are centralised here because getting them wrong in twelve places
 * is how a frontend rots:
 *
 *   auth      the token is attached in one place, so no call site can forget it
 *   401       a dead session tears down centrally rather than each page
 *             independently discovering it and rendering its own broken state
 *   errors    the backend's `{ error, code, request_id }` shape is unwrapped
 *             into a real Error, so callers `catch (e) { e.message }` and get
 *             the sentence the server actually wrote
 */

export const TOKEN_KEY = 'argus.token';

const BASE = import.meta.env.VITE_API_URL ?? '';

/**
 * Set by AuthContext. A 401 from anywhere calls this exactly once per response,
 * which is what lets an expired token log the user out without every page
 * needing to know that tokens expire.
 */
let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = typeof fn === 'function' ? fn : () => {};
}

/**
 * An API failure that still carries what the server said.
 *
 * `status` lets a caller distinguish "not found" from "you may not do that"
 * without string-matching, and `requestId` is the value to quote in a bug
 * report — the backend logs the full stack against it.
 */
export class ApiError extends Error {
  constructor(message, { status, code, requestId, details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}

/** A message worth showing a user, from anything that might have been thrown. */
export function errorMessage(err) {
  if (!err) return 'Something went wrong.';
  if (err instanceof ApiError) return err.message;
  // A fetch that never reached the server throws TypeError with a useless
  // message ("Failed to fetch"). Say the useful thing instead.
  if (err instanceof TypeError) return 'Cannot reach the ARGUS API. Is the server running on :4000?';
  return err.message || 'Something went wrong.';
}

function buildUrl(path, params) {
  const url = `${BASE}${path}`;
  if (!params) return url;

  // Empty values are DROPPED rather than sent. The backend treats an empty
  // query value as absent (docs/API.md), and not sending it at all keeps the
  // URL — and therefore the cache key and the browser history — clean.
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.append(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${url}?${qs}` : url;
}

export async function request(path, { method = 'GET', body, params, signal, raw = false } = {}) {
  const token = localStorage.getItem(TOKEN_KEY);
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  // FormData sets its own multipart boundary; setting Content-Type by hand
  // would produce a boundary-less header and the upload would fail server-side.
  const isForm = body instanceof FormData;
  if (body && !isForm) headers['Content-Type'] = 'application/json';

  const res = await fetch(buildUrl(path, params), {
    method,
    headers,
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
    signal,
  });

  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    onUnauthorized();
    throw new ApiError('Your session has expired. Sign in again.', { status: 401 });
  }

  if (raw) {
    if (!res.ok) throw new ApiError(`Request failed (${res.status})`, { status: res.status });
    return res;
  }

  // A 204 or an empty body is a success with nothing to parse.
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      if (res.ok) return null;
    }
  }

  if (!res.ok) {
    throw new ApiError(data?.error || `Request failed (${res.status})`, {
      status: res.status,
      code: data?.code,
      requestId: data?.request_id,
      details: data?.details,
    });
  }
  return data;
}

export const get = (path, params, opts) => request(path, { ...opts, params });
export const post = (path, body, opts) => request(path, { ...opts, method: 'POST', body });
export const patch = (path, body, opts) => request(path, { ...opts, method: 'PATCH', body });
