/**
 * Threat Feed (docs/PROJECT.md §E.7) — the generated alerts of PLAN-V2 §3.3.
 *
 * The distinguishing feature is `/explain`. Every alert here was produced by a
 * rule that STORED THE QUERY IT RAN, so an investigator can open any row and
 * see the SQL and the matched record. That is the difference between a threat
 * feed and a list of assertions, and it is the reason the seeded prose alerts
 * were deleted rather than kept alongside these.
 *
 * Acknowledging is a real state change through PATCH /api/alerts/:id, so the
 * feed is something an analyst works THROUGH rather than only reads.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCheck, Code2, RefreshCw, X } from 'lucide-react';

import { alerts as alertsApi } from '@/api';
import { useApi, usePoll } from '@/hooks/useApi';
import { useAuth } from '@/context/AuthContext';
import { Chip, Dot, Empty, Failed, Loading, Panel, Severity } from '@/components/ui/Bits';
import { ago, clusterColour, num, severityColour } from '@/utils/format';
import { cn } from '@/lib/utils';

const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'];

/**
 * The audit drawer.
 *
 * Shows the rule, the query it ran and the row it matched. An alert an
 * investigator cannot audit is an assertion with a severity badge on it.
 */
function ExplainDrawer({ alertId, onClose }) {
  const { data, error, loading } = useApi(() => alertsApi.explain(alertId), [alertId]);

  return (
    <aside className="flex w-[420px] shrink-0 flex-col overflow-hidden border-l border-hair bg-panel">
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-hair px-3">
        <div className="flex items-center gap-2">
          <Code2 className="size-3.5 text-faint" strokeWidth={1.75} />
          <h2 className="lbl">Why this fired</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-[3px] p-1 text-faint transition-colors hover:bg-raise hover:text-txt"
        >
          <X className="size-3.5" strokeWidth={2} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <Loading label="Loading" />
        ) : error ? (
          <Failed error={error} />
        ) : (
          <>
            <section className="border-b border-hair px-3 py-3">
              <p className="text-[12.5px] leading-snug text-txt">{data.alert.title}</p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Severity level={data.alert.severity} />
                {data.rule && <Chip>{data.rule.key}</Chip>}
              </div>
              <p className="mt-2 text-[10.5px] leading-relaxed text-faint">{data.note}</p>
            </section>

            {data.alert.details && (
              <section className="border-b border-hair px-3 py-3">
                <h3 className="lbl mb-2">Finding</h3>
                <dl className="flex flex-col gap-1">
                  {Object.entries(data.alert.details).map(([k, v]) => (
                    <div key={k} className="flex items-baseline justify-between gap-3 py-[3px]">
                      <dt className="shrink-0 text-[10.5px] text-faint">{k.replace(/_/g, ' ')}</dt>
                      <dd className="mn min-w-0 truncate text-right text-[11px] text-txt">
                        {Array.isArray(v) ? v.join(', ') : String(v)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}

            {data.query_sql && (
              <section className="px-3 py-3">
                <h3 className="lbl mb-2">The query that produced it</h3>
                {/* Monospace, scrollable, unedited. The point is that it is the
                    real statement, not a paraphrase of one. */}
                <pre className="mn max-h-[380px] overflow-auto rounded-[3px] border border-hair bg-void p-2.5 text-[10.5px] leading-relaxed text-dim">
                  {data.query_sql}
                </pre>
              </section>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

export default function ThreatFeed() {
  const { user } = useAuth();
  const [severity, setSeverity] = useState('');
  const [status, setStatus] = useState('OPEN');
  const [explaining, setExplaining] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [regenerating, setRegenerating] = useState(false);

  const { data, error, loading, refetch } = useApi(
    () => alertsApi.list({ limit: 200, severity: severity || undefined, status: status || undefined }),
    [severity, status]
  );
  usePoll(refetch, 30_000);

  const canRegenerate = user?.role === 'ADMIN' || user?.role === 'ANALYST';

  async function setAlertStatus(id, next) {
    setBusyId(id);
    try {
      await alertsApi.setStatus(id, next);
      refetch();
    } finally {
      setBusyId(null);
    }
  }

  async function regenerate() {
    setRegenerating(true);
    try {
      await alertsApi.regenerate();
      refetch();
    } finally {
      setRegenerating(false);
    }
  }

  const counts = data?.counts ?? {};

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col gap-3 p-3">
        {/* ---- severity summary, doubling as the filter ---- */}
        <div className="glass grid grid-cols-4 divide-x divide-hair">
          {SEVERITIES.map((s) => {
            const active = severity === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => setSeverity(active ? '' : s)}
                className={cn('row-hover flex flex-col gap-1.5 p-3 text-left', active && 'bg-raise')}
              >
                <span className="flex items-center gap-1.5">
                  <Dot colour={severityColour(s)} size={5} pulse={s === 'CRITICAL' && counts[s] > 0} />
                  <span className="lbl">{s}</span>
                </span>
                <span
                  className="mn text-[22px] leading-none font-semibold"
                  style={{ color: counts[s] ? severityColour(s) : '#556074' }}
                >
                  {num(counts[s] ?? 0)}
                </span>
                <span className="text-[10px] text-faint">open</span>
              </button>
            );
          })}
        </div>

        <Panel
          title="Threat feed"
          subtitle={data ? `${num(data.alerts.length)} shown` : undefined}
          flush
          className="min-h-0 flex-1"
          right={
            <div className="flex items-center gap-1.5">
              {STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatus(status === s ? '' : s)}
                  className={cn('chip cursor-pointer', status === s && 'border-blue text-txt')}
                >
                  {s.toLowerCase()}
                </button>
              ))}
              {canRegenerate && (
                <button
                  type="button"
                  onClick={regenerate}
                  disabled={regenerating}
                  title="Re-run every rule over the live data"
                  className="flex h-[22px] items-center gap-1.5 rounded-[2px] border border-hair px-1.5 text-[11px] text-dim transition-colors hover:border-faint hover:text-txt disabled:opacity-50"
                >
                  <RefreshCw className={cn('size-3', regenerating && 'animate-spin')} strokeWidth={1.75} />
                  {regenerating ? 'Running' : 'Re-run rules'}
                </button>
              )}
            </div>
          }
        >
          <div className="h-full overflow-y-auto">
            {loading && !data ? (
              <Loading label="Loading alerts" />
            ) : error ? (
              <Failed error={error} onRetry={refetch} />
            ) : !data?.alerts?.length ? (
              <Empty
                icon={CheckCheck}
                title="Nothing open"
                hint="No alerts match this filter. Rules run on every filing, so new findings appear here automatically."
              />
            ) : (
              data.alerts.map((a) => (
                <div
                  key={a.id}
                  className={cn(
                    'row-hover flex items-start gap-3 border-b border-hair px-3 py-2.5 last:border-b-0',
                    explaining === a.id && 'bg-raise'
                  )}
                >
                  <span className="mt-[5px] shrink-0">
                    <Dot colour={severityColour(a.severity)} size={6} pulse={a.severity === 'CRITICAL' && a.status === 'OPEN'} />
                  </span>

                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <p className="text-[12.5px] leading-snug text-txt">{a.title}</p>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-faint">
                      <span className="mn tracking-wide uppercase" style={{ color: severityColour(a.severity) }}>
                        {a.severity}
                      </span>
                      {a.rule_key && <><span>·</span><span className="mn">{a.rule_key}</span></>}
                      {a.cluster_key && (
                        <>
                          <span>·</span>
                          <span className="mn" style={{ color: clusterColour(a.cluster_key) }}>{a.cluster_key}</span>
                        </>
                      )}
                      {a.complaint_ref && (
                        <>
                          <span>·</span>
                          <Link to={`/complaints/${a.complaint_id}`} className="mn text-bluehi hover:underline">
                            {a.complaint_ref}
                          </Link>
                        </>
                      )}
                      <span>·</span>
                      <span>{ago(a.updated_at ?? a.created_at)}</span>
                      {a.status !== 'OPEN' && (
                        <>
                          <span>·</span>
                          <span className="text-emerald">{a.status.toLowerCase()}</span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    {a.rule_key && (
                      <button
                        type="button"
                        onClick={() => setExplaining(explaining === a.id ? null : a.id)}
                        title="Show the query that produced this"
                        className="flex h-[22px] items-center gap-1 rounded-[2px] border border-hair px-1.5 text-[10.5px] text-dim transition-colors hover:border-faint hover:text-txt"
                      >
                        <Code2 className="size-3" strokeWidth={1.75} />
                        Why
                      </button>
                    )}
                    {a.status === 'OPEN' && (
                      <button
                        type="button"
                        disabled={busyId === a.id}
                        onClick={() => setAlertStatus(a.id, 'ACKNOWLEDGED')}
                        className="flex h-[22px] items-center rounded-[2px] border border-hair px-1.5 text-[10.5px] text-dim transition-colors hover:border-faint hover:text-txt disabled:opacity-50"
                      >
                        Acknowledge
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </Panel>
      </div>

      {explaining && <ExplainDrawer alertId={explaining} onClose={() => setExplaining(null)} />}
    </div>
  );
}
