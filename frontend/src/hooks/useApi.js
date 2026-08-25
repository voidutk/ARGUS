import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Fetch-on-mount with loading, error and refetch.
 *
 * Deliberately not React Query. This app has ~15 read endpoints, no mutation
 * cache to invalidate, no offline story and no infinite scroll — the whole
 * surface a query library exists to manage. Forty lines that the team can read
 * in full beats a dependency whose behaviour has to be learned.
 *
 * What it does get right, because these are the bugs that actually bite:
 *
 *   - an in-flight request is ABORTED when deps change, so a slow first
 *     response cannot overwrite a fast second one (the classic filter race)
 *   - state is never set after unmount
 *   - `deps` is the dependency array, so callers control refetching explicitly
 *     rather than the hook guessing from an unstable function identity
 */
export function useApi(fn, deps = [], { enabled = true } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(enabled);
  const [tick, setTick] = useState(0);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) { setLoading(false); return undefined; }

    const controller = new AbortController();
    let superseded = false;

    setLoading(true);
    setError(null);

    Promise.resolve(fnRef.current({ signal: controller.signal }))
      .then((result) => {
        if (superseded || !alive.current) return;
        setData(result);
        setError(null);
      })
      .catch((err) => {
        // An abort is this hook doing its job, not a failure to report.
        if (superseded || !alive.current || err?.name === 'AbortError') return;
        setError(err);
      })
      .finally(() => {
        if (superseded || !alive.current) return;
        setLoading(false);
      });

    return () => {
      superseded = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, enabled]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  return { data, error, loading, refetch };
}

/**
 * Re-runs `refetch` on an interval while the tab is visible.
 *
 * Visibility matters more than it looks: a dashboard left open on a second
 * monitor overnight would otherwise make thousands of pointless requests, and
 * during a demo the laptop is asleep right up until it is not.
 */
export function usePoll(refetch, intervalMs) {
  useEffect(() => {
    if (!intervalMs) return undefined;

    let timer = null;
    const start = () => {
      stop();
      timer = setInterval(() => {
        if (document.visibilityState === 'visible') refetch();
      }, intervalMs);
    };
    const stop = () => { if (timer) clearInterval(timer); timer = null; };

    start();
    document.addEventListener('visibilitychange', start);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', start);
    };
  }, [refetch, intervalMs]);
}
