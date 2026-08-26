/**
 * Money Flow Analysis (docs/PROJECT.md §E.6).
 *
 * Traces the laundering chain: victim account → mule accounts → intermediate
 * wallets → exchange → cash-out. §E.6's claim is that this "explains visually
 * what a spreadsheet cannot", and the thing it explains is LEAKAGE — each hop
 * takes a cut, so the amount arriving at the far end is visibly narrower than
 * the amount that left the victim. A table of five rows hides that; a ribbon
 * that thins as it crosses the screen states it without a caption.
 *
 * Rendered as hand-written SVG rather than with d3-sankey. The API already
 * returns the chain ordered by hop, so the layout is a linear ladder, not a
 * general flow network — d3-sankey's iterative node-positioning solves a
 * problem this data does not have, and would add 30 kB to compute an ordering
 * we were handed.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { Coins, Search } from 'lucide-react';

import { money as moneyApi, complaints as complaintsApi } from '@/api';
import { useApi } from '@/hooks/useApi';
import { Empty, Failed, Loading, Panel } from '@/components/ui/Bits';
import { elide, entityLabel, inr, num, scamLabel } from '@/utils/format';
import { cn } from '@/lib/utils';

/** Role determines colour: victim money, money in transit, money gone. */
const ROLE_COLOUR = {
  VICTIM: '#8b9bb4',
  INTERMEDIARY: '#5b93ff',
  TERMINAL: '#ff4757',
};

const RAIL_LABEL = {
  UPI: 'UPI', IMPS: 'IMPS', NEFT: 'NEFT', RTGS: 'RTGS', CRYPTO: 'Crypto', CASH: 'Cash',
};

/**
 * The ladder.
 *
 * Ribbon HEIGHT is proportional to the amount carried, on a shared scale across
 * every hop — that is the entire visual argument, so it must not be normalised
 * per-hop or the leakage disappears.
 */
function Sankey({ nodes, links, height = 380 }) {
  const geometry = useMemo(() => {
    if (!nodes?.length || !links?.length) return null;

    const hops = Math.max(...nodes.map((n) => n.hop)) + 1;
    const width = 1000;
    const padX = 130;
    const colWidth = hops > 1 ? (width - padX * 2) / (hops - 1) : 0;
    const maxValue = Math.max(...links.map((l) => l.value), 1);

    /**
     * The ribbon ceiling is deliberately modest.
     *
     * At 42% of the panel height a two-hop chain rendered as two slabs that
     * filled the frame and swallowed their own labels — and because consecutive
     * hops differ by only the commission taken (6% here), both maxed out and
     * the thinning that IS the visual argument became a ten-pixel difference
     * nobody could see. Capping lower leaves clear space above and below every
     * ribbon for the amount and the rail, and lets the taper read.
     */
    const maxRibbon = Math.min(height * 0.2, 78);

    // Nodes sharing a hop are stacked; most chains have one per hop.
    const byHop = new Map();
    for (const n of nodes) {
      if (!byHop.has(n.hop)) byHop.set(n.hop, []);
      byHop.get(n.hop).push(n);
    }

    const placed = new Map();
    for (const [hop, group] of byHop) {
      const slot = height / (group.length + 1);
      group.forEach((n, i) => {
        placed.set(n.id, { ...n, x: padX + hop * colWidth, y: slot * (i + 1) });
      });
    }

    const ribbons = links.map((l) => {
      const from = placed.get(l.source);
      const to = placed.get(l.target);
      if (!from || !to) return null;
      const thickness = Math.max(3, (l.value / maxValue) * maxRibbon);
      return { ...l, from, to, thickness };
    }).filter(Boolean);

    return { width, height, nodes: [...placed.values()], ribbons };
  }, [nodes, links, height]);

  if (!geometry) return null;

  return (
    <svg
      viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      className="w-full"
      style={{ height }}
      role="img"
      aria-label="Money flow from victim to cash-out"
    >
      <defs>
        {geometry.ribbons.map((r, i) => (
          <linearGradient key={i} id={`flow-${i}`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={ROLE_COLOUR[r.from.role] ?? '#5b93ff'} stopOpacity="0.5" />
            <stop offset="100%" stopColor={ROLE_COLOUR[r.to.role] ?? '#5b93ff'} stopOpacity="0.5" />
          </linearGradient>
        ))}
      </defs>

      {/* ---- ribbons ---- */}
      {geometry.ribbons.map((r, i) => {
        const midX = (r.from.x + r.to.x) / 2;
        // A cubic with horizontal control points: the flow leaves and arrives
        // level, so thickness reads as quantity rather than as slope.
        const d = `M ${r.from.x} ${r.from.y - r.thickness / 2}
                   C ${midX} ${r.from.y - r.thickness / 2}, ${midX} ${r.to.y - r.thickness / 2}, ${r.to.x} ${r.to.y - r.thickness / 2}
                   L ${r.to.x} ${r.to.y + r.thickness / 2}
                   C ${midX} ${r.to.y + r.thickness / 2}, ${midX} ${r.from.y + r.thickness / 2}, ${r.from.x} ${r.from.y + r.thickness / 2} Z`;
        return (
          <g key={i}>
            <path d={d} fill={`url(#flow-${i})`} />
            {/* Amount above the ribbon, rail below it. Both were previously
                drawn INSIDE the band, where the fill rendered over them. */}
            <text
              x={midX}
              y={(r.from.y + r.to.y) / 2 - r.thickness / 2 - 10}
              textAnchor="middle"
              className="fill-txt"
              style={{ fontSize: 14, fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}
            >
              {inr(r.value)}
            </text>
            <text
              x={midX}
              y={(r.from.y + r.to.y) / 2 + r.thickness / 2 + 15}
              textAnchor="middle"
              className="fill-faint"
              style={{ fontSize: 10.5, fontFamily: 'Inter, sans-serif', letterSpacing: '0.05em' }}
            >
              {RAIL_LABEL[r.rail] ?? r.rail}
            </text>
          </g>
        );
      })}

      {/* ---- nodes ---- */}
      {geometry.nodes.map((n) => {
        const colour = ROLE_COLOUR[n.role] ?? '#5b93ff';
        return (
          <g key={n.id}>
            {/* A gate the money passes through. Drawn taller than the widest
                ribbon so it stays visible rather than being buried by the flow
                crossing it, and after the ribbons so it sits on top. */}
            <rect
              x={n.x - 4}
              y={n.y - 52}
              width={8}
              height={104}
              rx={2}
              fill={colour}
              opacity={0.95}
            />
            <text
              x={n.x}
              y={n.y - 62}
              textAnchor="middle"
              className="fill-txt"
              style={{ fontSize: 12.5, fontFamily: 'Inter, sans-serif', fontWeight: 600 }}
            >
              {n.label?.length > 22 ? elide(n.label, 12, 8) : n.label}
            </text>
            <text
              x={n.x}
              y={n.y + 68}
              textAnchor="middle"
              style={{ fontSize: 9.5, fontFamily: 'Inter, sans-serif', fill: colour, letterSpacing: '0.08em' }}
            >
              {n.role}
            </text>
            <text
              x={n.x}
              y={n.y + 81}
              textAnchor="middle"
              className="fill-faint"
              style={{ fontSize: 9.5, fontFamily: 'Inter, sans-serif' }}
            >
              {entityLabel(n.type)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/**
 * The complaint picker — only complaints that actually have a trail.
 *
 * That sentence used to be a comment above a list of every complaint in the
 * database. Most of the corpus is unclustered noise with no transactions at
 * all, so roughly half of what this panel offered led to an empty trace, and
 * the only way to find that out was to click one. `transaction_count` now comes
 * back with the list, so the filter is real: a complaint with no hops has
 * nothing to trace and does not belong on a page about tracing.
 *
 * Deepest chains sort first. On a page whose subject is layering, the six-hop
 * ladder is more informative than a single transfer, and burying it under
 * whichever complaint happens to be newest serves nobody.
 */
function TrailPicker({ selectedId, onSelect, onDefault }) {
  const [query, setQuery] = useState('');
  const { data, loading } = useApi(() => complaintsApi.list({ limit: 200 }), []);

  const traceable = useMemo(
    () => (data?.complaints ?? [])
      .filter((c) => (c.transaction_count ?? 0) > 0)
      .sort((a, b) => (b.transaction_count ?? 0) - (a.transaction_count ?? 0)
        || b.amount_inr - a.amount_inr),
    [data]
  );

  const filtered = useMemo(() => {
    if (!query.trim()) return traceable;
    const q = query.trim().toLowerCase();
    return traceable.filter(
      (c) => c.complaint_ref.toLowerCase().includes(q) || c.victim_name.toLowerCase().includes(q)
    );
  }, [traceable, query]);

  /**
   * Open on the deepest trail rather than on an empty panel.
   *
   * Arriving at a page called Money Flow and being told to go and find some
   * money is a wasted screen — the investigator already chose this page, which
   * is the choice that matters. The picker is the only thing that knows which
   * complaints have a trail, so the default is raised from here once the list
   * lands, and only when nothing is selected already (a link carrying
   * ?complaint= must always win).
   */
  useEffect(() => {
    if (selectedId || !traceable.length) return;
    onDefault?.(traceable[0].id);
  }, [selectedId, traceable, onDefault]);

  return (
    <Panel
      title="Complaints"
      subtitle={data ? `${num(traceable.length)} with a money trail` : undefined}
      flush
      className="w-[268px] shrink-0"
    >
      <div className="border-b border-hair p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-faint" strokeWidth={1.75} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Reference or victim…"
            className="h-[26px] w-full rounded-[3px] border border-hair bg-panel pr-2 pl-[26px] text-[11.5px] text-txt outline-none transition-colors placeholder:text-faint focus:border-blue"
          />
        </div>
      </div>

      <div className="max-h-[calc(100dvh-190px)] overflow-y-auto">
        {loading ? (
          <Loading label="Loading" />
        ) : (
          filtered.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onSelect(c.id)}
              className={cn(
                'row-hover flex w-full flex-col gap-0.5 border-b border-hair px-3 py-2 text-left last:border-b-0',
                String(selectedId) === String(c.id) && 'bg-raise'
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="mn text-[11.5px] text-txt">{c.complaint_ref}</span>
                <span className="mn text-[11px] text-dim">{inr(c.amount_inr, { compact: true })}</span>
              </div>
              <span className="truncate text-[10.5px] text-faint">
                {scamLabel(c.scam_category)} · {c.state ?? '—'}
                {c.transaction_count > 1 && ` · ${c.transaction_count} hops`}
              </span>
            </button>
          ))
        )}
      </div>
    </Panel>
  );
}

export default function MoneyFlow() {
  const [params, setParams] = useSearchParams();
  const complaintId = params.get('complaint');

  const { data, error, loading } = useApi(
    () => moneyApi.trace(complaintId),
    [complaintId],
    { enabled: Boolean(complaintId) }
  );

  const select = (id) => setParams({ complaint: String(id) });

  /**
   * `replace` so the automatic first choice does not become a history entry —
   * otherwise Back from the first complaint you pick returns you to the same
   * page rather than to where you came from.
   */
  const selectDefault = useCallback(
    (id) => setParams({ complaint: String(id) }, { replace: true }),
    [setParams]
  );
  const summary = data?.summary;
  const recoverable = summary ? summary.total_inr - summary.leakage_inr : 0;

  return (
    <div className="flex h-full min-h-0 gap-3 p-3">
      <TrailPicker selectedId={complaintId} onSelect={select} onDefault={selectDefault} />

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {!complaintId ? (
          <Panel className="flex-1">
            <Empty
              icon={Coins}
              title="Select a complaint"
              hint="Pick a complaint to trace where its money went — from the victim's account through the mule chain to cash-out."
              className="my-auto"
            />
          </Panel>
        ) : loading ? (
          <Panel className="flex-1"><Loading label="Tracing the chain" className="my-auto" /></Panel>
        ) : error ? (
          <Panel className="flex-1"><Failed error={error} /></Panel>
        ) : !data?.links?.length ? (
          <Panel className="flex-1">
            <Empty
              icon={Coins}
              title="No money trail recorded"
              hint="This complaint has no transaction records attached. Trails come from bank and exchange returns, which are not available for every filing."
              className="my-auto"
            />
          </Panel>
        ) : (
          <>
            {/* ---- the numbers that frame the picture ---- */}
            <div className="glass grid grid-cols-2 divide-x divide-hair lg:grid-cols-4">
              {[
                { label: 'Victim paid', value: inr(summary.total_inr), tone: 'text-txt' },
                { label: 'Hops traced', value: num(summary.hops), tone: 'text-txt' },
                {
                  label: 'Lost to commission',
                  value: inr(summary.leakage_inr),
                  tone: 'text-amber',
                  hint: `${((summary.leakage_inr / summary.total_inr) * 100).toFixed(1)}% taken en route`,
                },
                {
                  label: 'Reached cash-out',
                  value: inr(recoverable),
                  tone: 'text-danger',
                  hint: summary.terminal_label,
                },
              ].map((cell) => (
                <div key={cell.label} className="flex flex-col gap-1.5 p-3">
                  <span className="lbl">{cell.label}</span>
                  <span className={cn('mn text-[19px] leading-none font-semibold tracking-tight', cell.tone)}>
                    {cell.value}
                  </span>
                  {cell.hint && <span className="truncate text-[10px] text-faint">{cell.hint}</span>}
                </div>
              ))}
            </div>

            <Panel
              title="Laundering chain"
              subtitle="ribbon thickness is the amount carried"
              className="min-h-0 flex-1"
              right={
                <Link
                  to={`/complaints/${complaintId}`}
                  className="text-[10.5px] text-dim transition-colors hover:text-txt"
                >
                  Open complaint
                </Link>
              }
            >
              <div className="flex h-full flex-col justify-center overflow-x-auto">
                <Sankey nodes={data.nodes} links={data.links} />
              </div>
            </Panel>

            {/* ---- the ledger behind the picture ---- */}
            <Panel title="Transactions" flush>
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-hair">
                    {['Hop', 'From', 'To', 'Rail', 'Amount', 'Reference'].map((h) => (
                      <th key={h} className="lbl px-3 py-1.5 font-semibold">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.links.map((l, i) => {
                    const from = data.nodes.find((n) => n.id === l.source);
                    const to = data.nodes.find((n) => n.id === l.target);
                    return (
                      <tr key={i} className="row-hover border-b border-hair last:border-b-0">
                        <td className="mn px-3 py-2 text-[11px] text-faint">{l.hop}</td>
                        <td className="px-3 py-2 text-[11.5px] text-dim">{from?.label ?? '—'}</td>
                        <td className="px-3 py-2 text-[11.5px] text-txt">{to?.label ?? '—'}</td>
                        <td className="px-3 py-2 text-[11px] text-dim">{RAIL_LABEL[l.rail] ?? l.rail}</td>
                        <td className="mn px-3 py-2 text-[11.5px] text-txt">{inr(l.value)}</td>
                        <td className="mn px-3 py-2 text-[10.5px] text-faint">{l.reference ?? '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Panel>
          </>
        )}
      </div>
    </div>
  );
}
