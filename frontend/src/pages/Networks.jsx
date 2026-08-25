/**
 * Criminal Networks — the cluster register.
 *
 * The Explorer shows the graph; this shows the ORGANISATIONS as records: who
 * runs each, how far it reaches, what it has taken, and which complaints belong
 * to it. It is the view a supervisor uses to decide where to put people, which
 * is a different question from the one an analyst asks at the canvas.
 *
 * Cluster colour is carried from utils/format so a network is the same colour
 * here, on the map, in the feed and in the graph (§K).
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Boxes, ExternalLink, RefreshCw } from 'lucide-react';

import { clusters as clustersApi } from '@/api';
import { useApi } from '@/hooks/useApi';
import { useAuth } from '@/context/AuthContext';
import { Dot, Empty, Failed, Loading, Meter, Panel, Severity } from '@/components/ui/Bits';
import { clusterColour, dateOnly, inr, num, scamLabel } from '@/utils/format';
import { cn } from '@/lib/utils';

function ClusterDetail({ clusterKey }) {
  const { data, error, loading } = useApi(() => clustersApi.detail(clusterKey), [clusterKey]);

  if (loading) return <Loading label="Loading network" className="my-auto" />;
  if (error) return <Failed error={error} className="my-auto" />;
  if (!data) return null;

  const { cluster, mastermind, top_entities: entities, complaints, states } = data;
  const colour = clusterColour(cluster.cluster_key);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <Panel
        title={cluster.cluster_key}
        right={<Severity level={cluster.risk_level} />}
      >
        <div className="flex flex-col gap-3">
          <div>
            <h2 className="text-[14px] font-semibold text-txt">{cluster.label}</h2>
            {cluster.description && (
              <p className="mt-1 text-[11.5px] leading-relaxed text-dim">{cluster.description}</p>
            )}
          </div>

          <div className="grid grid-cols-4 gap-3">
            {[
              { label: 'Complaints', value: num(cluster.complaint_count) },
              { label: 'States', value: num(cluster.states_touched) },
              { label: 'Entities', value: num(cluster.node_count) },
              { label: 'Exposure', value: inr(cluster.total_amount_inr, { compact: true }) },
            ].map((s) => (
              <div key={s.label} className="flex flex-col gap-1">
                <span className="lbl">{s.label}</span>
                <span className="mn text-[16px] leading-none font-semibold text-txt">{s.value}</span>
              </div>
            ))}
          </div>

          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <span className="lbl">Risk score</span>
              <span className="mn text-[12px] font-semibold" style={{ color: colour }}>
                {cluster.risk_score}
              </span>
            </div>
            <Meter value={cluster.risk_score} colour={colour} height={3} />
          </div>

          {/*
            The coordinator gets its own block. It is the finding the whole
            product exists to produce, so it does not sit in a list of fields.
          */}
          {mastermind && (
            <Link
              to="/network"
              className="group flex items-center gap-3 rounded-[3px] border px-2.5 py-2 transition-colors"
              style={{
                borderColor: `color-mix(in oklab, ${colour} 32%, transparent)`,
                background: `color-mix(in oklab, ${colour} 7%, transparent)`,
              }}
            >
              <Dot colour={colour} size={7} pulse />
              <div className="min-w-0 flex-1">
                <span className="lbl">Coordinator</span>
                <p className="text-[13px] font-semibold text-txt">{mastermind.label}</p>
                <p className="mt-0.5 text-[10.5px] text-faint">
                  {mastermind.type?.toLowerCase()} · influence {mastermind.influence}
                </p>
              </div>
              <ExternalLink className="size-3 text-faint transition-colors group-hover:text-txt" strokeWidth={1.75} />
            </Link>
          )}
        </div>
      </Panel>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-2">
        <Panel title="Top entities" subtitle="by influence" flush className="min-h-0">
          <div className="h-full max-h-[300px] overflow-y-auto">
            {entities.map((e) => (
              <div key={e.id} className="row-hover flex items-center gap-2.5 border-b border-hair px-3 py-1.5 last:border-b-0">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="mn truncate text-[11.5px] text-txt">{e.label || e.value}</span>
                  <span className="text-[10px] text-faint">
                    {e.entity_type?.toLowerCase().replace(/_/g, ' ')} · {e.complaint_count} complaints
                  </span>
                </div>
                {e.is_flagged && <Dot colour="#ff4757" size={5} />}
                <span className="mn shrink-0 text-[11px] text-dim">{e.influence_score}</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Reach" subtitle="by state" flush className="min-h-0">
          <div className="h-full max-h-[300px] overflow-y-auto">
            {states.map((s) => (
              <div key={s.state} className="flex items-center gap-2.5 border-b border-hair px-3 py-1.5 last:border-b-0">
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-dim">{s.state}</span>
                <span className="mn shrink-0 text-[11px] text-faint">{inr(s.amount, { compact: true })}</span>
                <span className="mn w-6 shrink-0 text-right text-[11.5px] text-txt">{s.n}</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel title="Complaints" subtitle={`${num(complaints.length)} attributed`} flush>
        <div className="max-h-[240px] overflow-y-auto">
          <table className="w-full text-left">
            <thead className="sticky top-0 bg-panel">
              <tr className="border-b border-hair">
                {['Reference', 'Category', 'Amount', 'State', 'Filed'].map((h) => (
                  <th key={h} className="lbl px-3 py-1.5 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {complaints.map((c) => (
                <tr key={c.id} className="row-hover border-b border-hair last:border-b-0">
                  <td className="px-3 py-1.5">
                    <Link to={`/complaints/${c.id}`} className="mn text-[11px] text-bluehi hover:underline">
                      {c.complaint_ref}
                    </Link>
                  </td>
                  <td className="px-3 py-1.5 text-[11px] text-dim">{scamLabel(c.scam_category)}</td>
                  <td className="mn px-3 py-1.5 text-[11px] text-txt">{inr(c.amount_inr, { compact: true })}</td>
                  <td className="px-3 py-1.5 text-[11px] text-dim">{c.state ?? '—'}</td>
                  <td className="px-3 py-1.5 text-[10.5px] whitespace-nowrap text-faint">{dateOnly(c.filed_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

export default function Networks() {
  const { user } = useAuth();
  const { data, error, loading, refetch } = useApi(() => clustersApi.list(), []);
  const [selectedKey, setSelectedKey] = useState(null);
  const [running, setRunning] = useState(false);

  const list = data?.clusters ?? [];
  const selected = selectedKey ?? list[0]?.cluster_key ?? null;
  const canRun = user?.role === 'ADMIN' || user?.role === 'ANALYST';

  async function runAnalytics() {
    setRunning(true);
    try {
      await clustersApi.runAnalytics();
      refetch();
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 gap-3 p-3">
      <Panel
        title="Criminal networks"
        subtitle={data ? `${num(list.length)}` : undefined}
        flush
        className="w-[290px] shrink-0"
        right={
          canRun && (
            <button
              type="button"
              onClick={runAnalytics}
              disabled={running}
              title="Recompute communities, influence and risk"
              className="flex h-[22px] items-center gap-1.5 rounded-[2px] border border-hair px-1.5 text-[10.5px] text-dim transition-colors hover:border-faint hover:text-txt disabled:opacity-50"
            >
              <RefreshCw className={cn('size-2.5', running && 'animate-spin')} strokeWidth={2} />
              {running ? 'Running' : 'Recompute'}
            </button>
          )
        }
      >
        <div className="h-full overflow-y-auto">
          {loading && !data ? (
            <Loading label="Loading" />
          ) : error ? (
            <Failed error={error} onRetry={refetch} />
          ) : !list.length ? (
            <Empty icon={Boxes} title="No networks identified" hint="Run analytics to compute clusters." />
          ) : (
            list.map((c) => {
              const colour = clusterColour(c.cluster_key);
              return (
                <button
                  key={c.cluster_key}
                  type="button"
                  onClick={() => setSelectedKey(c.cluster_key)}
                  className={cn(
                    'row-hover relative flex w-full flex-col gap-1 border-b border-hair px-3 py-2.5 text-left last:border-b-0',
                    selected === c.cluster_key && 'bg-raise'
                  )}
                >
                  <span className="absolute inset-y-2 left-0 w-[2px] rounded-full" style={{ background: colour }} />
                  <div className="flex items-center gap-1.5">
                    <span className="mn text-[10px] font-semibold tracking-wider" style={{ color: colour }}>
                      {c.cluster_key}
                    </span>
                    <Severity level={c.risk_level} showLabel={false} />
                  </div>
                  <span className="truncate text-[12px] text-txt">{c.label}</span>
                  <span className="truncate text-[10px] text-faint">
                    {c.mastermind_label ?? 'no coordinator'} · {num(c.complaint_count)} complaints ·{' '}
                    {inr(c.total_amount_inr, { compact: true })}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </Panel>

      {selected ? (
        <ClusterDetail clusterKey={selected} />
      ) : (
        <Panel className="flex-1">
          <Empty icon={Boxes} title="Select a network" className="my-auto" />
        </Panel>
      )}
    </div>
  );
}
