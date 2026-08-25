/**
 * The node detail rail — and Scene 4 of the demo.
 *
 * Opening on a coordinator, this rail has to answer the hardest question a
 * judge can ask: "how do you know?". A centrality score is not an answer to
 * that, so the `/why` section leads with the three things that are —
 *
 *   what breaks if you remove them   (the removal test)
 *   which routes run through them    (concrete paths, not a number)
 *   how many victims ever named them (usually zero — the line that lands)
 *
 * — and `method` is shown, not hidden behind a tooltip. An explanation the
 * viewer cannot audit is just an assertion with better typography.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, Scan, Share2, X } from 'lucide-react';

import { graph as graphApi, entities as entitiesApi } from '@/api';
import { useApi } from '@/hooks/useApi';
import { Chip, Dot, Empty, Failed, Loading, Meter, Severity } from '@/components/ui/Bits';
import { clusterColour, elide, entityLabel, inr, num, ago, scamLabel } from '@/utils/format';
import { cn } from '@/lib/utils';

function Row({ label, children, mono = false }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[5px]">
      <span className="shrink-0 text-[11px] text-faint">{label}</span>
      <span className={cn('min-w-0 truncate text-right text-[11.5px] text-txt', mono && 'mn')}>
        {children}
      </span>
    </div>
  );
}

function Section({ title, children, right }) {
  return (
    <section className="border-b border-hair px-3 py-3 last:border-b-0">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="lbl">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

/**
 * The explainability panel.
 *
 * Everything here is derived at read time from the same cached graph the canvas
 * is drawing, so the explanation cannot describe a different picture from the
 * one on screen.
 */
function WhyPanel({ nodeId }) {
  const { data, error, loading } = useApi(() => graphApi.why(nodeId), [nodeId]);

  if (loading) return <Loading label="Deriving" className="py-6" />;
  if (error) return <Failed error={error} className="py-6" />;
  if (!data) return null;

  const { removal_test: removal, rank, appearances, bridge_paths: paths } = data;

  return (
    <>
      <Section title="Why this node">
        {/*
          The headline claim. `never_named` is the whole argument for the
          product: the most important person in the network is the one no
          victim ever met, so it gets stated first and in plain language.
        */}
        {appearances?.never_named ? (
          <p className="mb-3 border-l-2 border-amber/60 bg-amber/[0.06] py-1.5 pl-2.5 text-[12px] leading-relaxed text-txt">
            Named in <span className="mn font-semibold text-amber">0</span> complaints.
            <span className="text-dim">
              {' '}Invisible to anyone reading the filings — reachable only once they are
              assembled into a graph.
            </span>
          </p>
        ) : (
          <p className="mb-3 text-[12px] leading-relaxed text-dim">
            Named directly in{' '}
            <span className="mn font-semibold text-txt">{num(appearances?.complaint_count)}</span>{' '}
            complaint{appearances?.complaint_count === 1 ? '' : 's'}.
          </p>
        )}

        <div className="flex flex-col gap-1">
          {rank?.in_cluster && (
            <Row label="Rank in network" mono>
              #{rank.in_cluster} <span className="text-faint">of {num(rank.cluster_size)}</span>
            </Row>
          )}
          {rank?.graph_wide && (
            <Row label="Rank overall" mono>
              #{rank.graph_wide} <span className="text-faint">of {num(rank.graph_entities)}</span>
            </Row>
          )}
        </div>
      </Section>

      {/*
        The removal test. A fragment count is a claim an investigator can act
        on — "arrest this person and the organisation splits in four" — in a way
        that a betweenness score of 0.31 never is.
      */}
      <Section title="If removed">
        <div
          className={cn(
            'rounded-[3px] border px-2.5 py-2',
            removal?.fragmenting ? 'border-danger/30 bg-danger/[0.06]' : 'border-hair bg-raise/40'
          )}
        >
          <p className="text-[12px] leading-relaxed text-txt">{removal?.summary}</p>
          {removal?.fragmenting && (
            <div className="mt-2 flex items-center gap-3">
              <span className="mn text-[22px] leading-none font-semibold text-danger">
                {removal.fragments_after}
              </span>
              <span className="text-[10.5px] leading-tight text-faint">
                fragments, largest {num(removal.largest_fragment_after)} nodes
                {removal.isolated_nodes_after > 0 && `, ${removal.isolated_nodes_after} isolated`}
              </span>
            </div>
          )}
        </div>
      </Section>

      {paths?.length > 0 && (
        <Section
          title="Routes through this node"
          right={
            <span className="mn text-[10px] text-faint">
              {data.severing_pair_count} of {data.bridge_pair_count} sever
            </span>
          }
        >
          <div className="flex flex-col gap-1.5">
            {paths.slice(0, 5).map((p, i) => (
              <div
                key={`${p.from.id}-${p.to.id}-${i}`}
                className="rounded-[3px] border border-hair bg-raise/40 px-2 py-1.5"
              >
                <p className="text-[11px] leading-snug text-dim">
                  <span className="text-txt">{p.from.label}</span>
                  <span className="text-faint"> → </span>
                  <span className="text-bluehi">{p.via.label}</span>
                  <span className="text-faint"> → </span>
                  <span className="text-txt">{p.to.label}</span>
                </p>
                {p.severs && (
                  <span className="mt-1 inline-flex items-center gap-1 text-[9.5px] tracking-wide text-danger uppercase">
                    <Dot colour="#ff4757" size={4} />
                    no other route exists
                  </span>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Method, shown rather than buried. This is the audit trail for the
          three claims above. */}
      <Section title="How this was derived">
        <dl className="flex flex-col gap-1.5">
          {Object.entries(data.method ?? {}).map(([key, value]) => (
            <div key={key}>
              <dt className="text-[10px] tracking-wide text-faint uppercase">{key.replace(/_/g, ' ')}</dt>
              <dd className="text-[10.5px] leading-relaxed text-dim">{value}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </>
  );
}

/** OSINT enrichment. Every result carries its own provenance (PLAN-V2 §3.4). */
function OsintPanel({ entityId }) {
  const { data, error, loading } = useApi(() => entitiesApi.osint(entityId), [entityId]);

  if (loading) return <Loading label="Querying" className="py-5" />;
  if (error) return <Failed error={error} className="py-5" />;
  if (!data?.results?.length) {
    return <p className="py-2 text-[11px] text-faint">No adapter handles this entity type.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {data.results.map((r) => (
        <div key={r.adapter} className="rounded-[3px] border border-hair bg-raise/40 px-2 py-1.5">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="truncate text-[11px] text-txt">{r.label}</span>
            {/*
              The provenance chip is driven by the response, never by the page.
              A simulated adapter says so here because the framework stamped it,
              not because this component decided to be honest.
            */}
            <span
              className="shrink-0 rounded-[2px] border px-1 text-[9px] font-semibold tracking-wider uppercase"
              style={{
                color: r.simulated ? '#f5a623' : '#10b981',
                borderColor: r.simulated ? 'rgba(245,166,35,0.3)' : 'rgba(16,185,129,0.3)',
                background: r.simulated ? 'rgba(245,166,35,0.08)' : 'rgba(16,185,129,0.08)',
              }}
            >
              {r.simulated ? 'Simulated' : 'Live'}
            </span>
          </div>
          {r.available ? (
            <div className="flex flex-col gap-px">
              {Object.entries(r.data ?? {})
                .filter(([k]) => !['found', 'caveat', 'source_url'].includes(k))
                .slice(0, 5)
                .map(([k, v]) => (
                  <Row key={k} label={k.replace(/_/g, ' ')} mono>
                    {typeof v === 'object' ? JSON.stringify(v).slice(0, 40) : String(v)}
                  </Row>
                ))}
              {r.data?.caveat && (
                <p className="mt-1 text-[9.5px] leading-relaxed text-faint">{r.data.caveat}</p>
              )}
              {r.data?.source_url && (
                <a
                  href={r.data.source_url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-flex items-center gap-1 text-[10px] text-bluehi hover:underline"
                >
                  Source <ExternalLink className="size-2.5" />
                </a>
              )}
            </div>
          ) : (
            <p className="text-[10.5px] text-faint">{r.reason}</p>
          )}
        </div>
      ))}
    </div>
  );
}

export default function DetailRail({ node, onClose, onExpand, onFocus }) {
  const [tab, setTab] = useState('why');

  if (!node) {
    return (
      <aside className="flex w-[318px] shrink-0 flex-col border-l border-hair bg-panel">
        <Empty
          icon={Scan}
          title="Select a node"
          hint="Click any node to inspect it. Double-click to expand its neighbours. The coordinators are ringed in white."
          className="my-auto"
        />
      </aside>
    );
  }

  const isComplaint = node.type === 'COMPLAINT';
  const colour = node.cluster ? clusterColour(node.cluster) : '#556074';

  return (
    <aside className="flex w-[318px] shrink-0 flex-col overflow-hidden border-l border-hair bg-panel">
      {/* ---- header ---- */}
      <header className="shrink-0 border-b border-hair px-3 py-3">
        <div className="mb-2 flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="size-2 shrink-0 rounded-full" style={{ background: colour }} />
            <span className="lbl">{isComplaint ? 'Complaint' : entityLabel(node.type)}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-mt-1 shrink-0 rounded-[3px] p-1 text-faint transition-colors hover:bg-raise hover:text-txt"
          >
            <X className="size-3.5" strokeWidth={2} />
          </button>
        </div>

        <h2 className={cn('leading-tight break-words text-txt', node.label?.length > 28 ? 'mn text-[12px]' : 'text-[15px] font-semibold')}>
          {node.label}
        </h2>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {node.is_mastermind && (
            <span className="inline-flex h-[19px] items-center gap-1.5 rounded-[2px] border border-txt/25 bg-txt/[0.07] px-1.5 text-[10px] font-semibold tracking-wide text-txt uppercase">
              <Dot colour="#e6edf7" size={5} /> Coordinator
            </span>
          )}
          {node.cluster && (
            <Chip colour={colour} title={node.cluster_label}>{node.cluster}</Chip>
          )}
          {node.is_flagged && <Severity level="HIGH" showLabel={false} />}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* ---- measures ---- */}
        <Section title={isComplaint ? 'Case' : 'Measures'}>
          {isComplaint ? (
            <div className="flex flex-col gap-0.5">
              <Row label="Category">{scamLabel(node.category)}</Row>
              <Row label="Amount" mono>{inr(node.amount_inr)}</Row>
              <Row label="State">{node.state ?? '—'}</Row>
              <Row label="Filed">{ago(node.filed_at)}</Row>
              <Row label="Status">{scamLabel(node.status)}</Row>
              {node.pg_id && (
                <Link
                  to={`/complaints/${node.pg_id}`}
                  className="mt-2 inline-flex items-center gap-1 text-[11px] text-bluehi hover:underline"
                >
                  Open complaint <ExternalLink className="size-2.5" />
                </Link>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div>
                <div className="mb-1 flex items-baseline justify-between">
                  <span className="text-[11px] text-faint">Influence</span>
                  <span className="mn text-[13px] font-semibold text-txt">{node.influence}</span>
                </div>
                <Meter value={node.influence} colour={colour} height={2} />
              </div>
              <Row label="Connections" mono>{num(node.degree)}</Row>
              {node.value && node.value !== node.label && (
                <Row label="Value" mono>{elide(node.value, 10, 8)}</Row>
              )}
            </div>
          )}
        </Section>

        {/* ---- tabs ---- */}
        {!isComplaint && (
          <>
            <div className="flex shrink-0 gap-px border-b border-hair px-3 pt-1">
              {[
                { key: 'why', label: 'Why' },
                { key: 'osint', label: 'OSINT' },
              ].map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className={cn(
                    'relative px-2.5 py-1.5 text-[11.5px] transition-colors',
                    tab === t.key ? 'text-txt' : 'text-faint hover:text-dim'
                  )}
                >
                  {t.label}
                  {tab === t.key && (
                    <span className="absolute inset-x-1 -bottom-px h-[2px] rounded-full bg-blue" />
                  )}
                </button>
              ))}
            </div>

            {tab === 'why' && <WhyPanel nodeId={node.id} />}
            {tab === 'osint' && (
              <Section title="Open sources">
                {node.pg_id ? (
                  <OsintPanel entityId={node.pg_id} />
                ) : (
                  <p className="text-[11px] text-faint">This node has no database record to enrich.</p>
                )}
              </Section>
            )}
          </>
        )}
      </div>

      {/* ---- actions ---- */}
      <footer className="flex shrink-0 gap-1.5 border-t border-hair p-2">
        <button
          type="button"
          onClick={() => onExpand?.(node.id)}
          className="flex h-7 flex-1 items-center justify-center gap-1.5 rounded-[3px] border border-hair text-[11.5px] text-dim transition-colors hover:border-faint hover:text-txt"
        >
          <Share2 className="size-3" strokeWidth={1.75} />
          Expand
        </button>
        <button
          type="button"
          onClick={() => onFocus?.(node.id)}
          className="flex h-7 flex-1 items-center justify-center gap-1.5 rounded-[3px] border border-hair text-[11.5px] text-dim transition-colors hover:border-faint hover:text-txt"
        >
          <Scan className="size-3" strokeWidth={1.75} />
          Centre
        </button>
      </footer>
    </aside>
  );
}
