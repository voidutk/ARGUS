/**
 * Geo Intelligence (docs/PROJECT.md §E.5).
 *
 * WHY THIS IS A PROPORTIONAL-SYMBOL MAP AND NOT A CHOROPLETH
 * ----------------------------------------------------------
 * §E.5 and the Dashboard both describe a "state choropleth", which needs India
 * state polygons. That is a deliberate departure, for a reason that is not
 * technical:
 *
 * India's boundaries are legally and politically constrained. Jammu & Kashmir,
 * Ladakh, Aksai Chin and Arunachal Pradesh are disputed, and maps published in
 * India are required to depict the official boundary. Public TopoJSON files —
 * including the Natural Earth derivatives everyone reaches for first — render
 * those regions to a different convention. This tool is built for MHA, CERT-In
 * and state cyber cells; putting a map with the wrong northern border in front
 * of that audience is a credibility problem and a legal one, and it is not
 * fixed by a disclaimer.
 *
 * So this map draws NO political boundaries at all. Symbols are placed at the
 * real mean coordinates the API computes from the complaints themselves, sized
 * by volume, with interstate routes as arcs. Every claim it makes is one the
 * data supports, and it asserts nothing about where a border runs.
 *
 * If an officially-approved boundary file is supplied, a choropleth becomes a
 * contained change: swap the symbol layer for filled paths and keep everything
 * else. The state-name reconciliation it would need already exists, in
 * backend/src/services/stateNames.js.
 */

import { useMemo, useState } from 'react';
import { geoMercator } from 'd3-geo';
import { MapPin, Route } from 'lucide-react';

import { geo as geoApi, reference as referenceApi } from '@/api';
import { useApi } from '@/hooks/useApi';
import { Empty, Failed, Loading, Panel, Provenance } from '@/components/ui/Bits';
import { clusterColour, inr, num, provenanceOf, scamLabel, severityColour } from '@/utils/format';
import { cn } from '@/lib/utils';

const WIDTH = 760;
const HEIGHT = 820;

/**
 * A Mercator fitted to mainland India plus the island territories.
 *
 * The extent is declared as coordinates rather than derived from a boundary
 * file, which is the point — the projection needs to know WHERE to look, not
 * what shape the country is.
 */
const projection = geoMercator()
  .center([82.5, 22.5])
  .scale(1150)
  .translate([WIDTH / 2, HEIGHT / 2]);

/** Radius from a count, area-proportional so it reads as quantity. */
const radiusFor = (value, max) => 5 + Math.sqrt(Math.max(0, value) / Math.max(max, 1)) * 30;

function ArcPath({ from, to, colour, weight }) {
  const [x1, y1] = projection(from) ?? [];
  const [x2, y2] = projection(to) ?? [];
  if ([x1, y1, x2, y2].some((v) => v === undefined || Number.isNaN(v))) return null;

  // A quadratic bowed perpendicular to the chord — the standard flight-path
  // idiom, and it keeps two-way routes from drawing on top of each other.
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const bow = 0.18;
  const cx = mx - dy * bow;
  const cy = my + dx * bow;

  return (
    <path
      d={`M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`}
      fill="none"
      stroke={colour}
      strokeWidth={Math.min(2.4, 0.5 + weight * 0.22)}
      strokeOpacity={0.42}
      strokeLinecap="round"
    />
  );
}

export default function GeoIntelligence() {
  const [layer, setLayer] = useState('SYNTHETIC');
  const [year, setYear] = useState(2014);
  const [metric, setMetric] = useState('CHEATING');
  const [showRoutes, setShowRoutes] = useState(true);
  const [hovered, setHovered] = useState(null);

  const synthetic = useApi(() => geoApi.states(), []);
  const routes = useApi(() => geoApi.routes(), []);
  const official = useApi(
    () => referenceApi.states({ metric, year }),
    [metric, year],
    { enabled: layer === 'NCRB' }
  );
  const meta = useApi(() => referenceApi.meta(), []);

  const active = layer === 'NCRB' ? official : synthetic;

  /**
   * The NCRB layer has no coordinates of its own — it is an aggregate table,
   * not a point set. Positions are borrowed from our own complaint centroids,
   * so only states we have complaints for can be plotted. That is stated in the
   * UI rather than silently dropping two-thirds of the rows.
   */
  const points = useMemo(() => {
    const coords = new Map(
      (synthetic.data?.states ?? [])
        .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon))
        .map((s) => [s.state, [s.lon, s.lat]])
    );

    if (layer === 'SYNTHETIC') {
      const max = synthetic.data?.max_complaints ?? 1;
      return (synthetic.data?.states ?? [])
        .filter((s) => coords.has(s.state))
        .map((s) => ({
          state: s.state,
          coord: coords.get(s.state),
          value: s.complaint_count,
          max,
          risk: s.risk_level,
          detail: `${num(s.complaint_count)} complaints · ${inr(s.total_amount_inr, { compact: true })}`,
          sub: scamLabel(s.dominant_category),
        }));
    }

    const max = official.data?.max_value ?? 1;
    return (official.data?.states ?? [])
      .filter((s) => coords.has(s.state))
      .map((s) => ({
        state: s.state,
        coord: coords.get(s.state),
        value: s.value,
        max,
        risk: s.risk_level,
        detail: `${num(s.value)} recorded cases`,
        sub: `${s.districts} districts`,
      }));
  }, [layer, synthetic.data, official.data]);

  /**
   * Which symbols get a label.
   *
   * Sizing alone is not a good enough gate: the northern plain packs Delhi,
   * Haryana, Punjab, Rajasthan and Uttar Pradesh into a few hundred pixels, and
   * labelling every sizeable bubble there produced a stack of overlapping text.
   * The top eight by volume are the ones worth naming unprompted; everything
   * else names itself on hover.
   */
  const labelled = useMemo(() => {
    const top = [...points].sort((a, b) => b.value - a.value).slice(0, 8);
    return new Set(top.map((p) => p.state));
  }, [points]);

  const plottedCount = points.length;
  const totalRows = (layer === 'NCRB' ? official.data?.states : synthetic.data?.states)?.length ?? 0;

  const loading = active.loading && !active.data;
  const error = active.error;

  return (
    <div className="flex h-full min-h-0 gap-3 p-3">
      {/* ---- map ---- */}
      <Panel
        title="India — cybercrime geography"
        subtitle={layer === 'NCRB' ? `${metric.toLowerCase().replace(/_/g, ' ')}, ${year}` : 'complaint density'}
        className="flex min-w-0 flex-1 flex-col"
        right={
          <div className="flex items-center gap-1.5">
            <Provenance of={provenanceOf(active.data)} />
            <button
              type="button"
              onClick={() => setShowRoutes((v) => !v)}
              className={cn('chip cursor-pointer', showRoutes && 'border-blue text-txt')}
              title="Interstate routes, inferred from cluster activity"
            >
              <Route className="size-2.5" strokeWidth={2} /> Routes
            </button>
          </div>
        }
      >
        {loading ? (
          <Loading label="Loading the map" className="my-auto" />
        ) : error ? (
          <Failed error={error} className="my-auto" />
        ) : (
          <div className="flex h-full flex-col">
            <div className="min-h-0 flex-1 overflow-hidden">
              <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="size-full" role="img" aria-label="Cybercrime activity across India">
                <defs>
                  <radialGradient id="bubble-glow">
                    <stop offset="40%" stopOpacity="0.35" stopColor="currentColor" />
                    <stop offset="100%" stopOpacity="0" stopColor="currentColor" />
                  </radialGradient>
                </defs>

                {/*
                  A graticule for orientation. No coastline and no borders —
                  see the header comment. Meridians and parallels are facts of
                  the coordinate system, not claims about territory.
                */}
                <g stroke="#1a2333" strokeWidth="0.6" fill="none">
                  {[70, 75, 80, 85, 90, 95].map((lon) => {
                    const top = projection([lon, 37]);
                    const bottom = projection([lon, 6]);
                    return top && bottom ? (
                      <line key={`m${lon}`} x1={top[0]} y1={top[1]} x2={bottom[0]} y2={bottom[1]} />
                    ) : null;
                  })}
                  {[10, 15, 20, 25, 30, 35].map((lat) => {
                    const left = projection([68, lat]);
                    const right = projection([98, lat]);
                    return left && right ? (
                      <line key={`p${lat}`} x1={left[0]} y1={left[1]} x2={right[0]} y2={right[1]} />
                    ) : null;
                  })}
                </g>

                {/* ---- interstate routes ---- */}
                {showRoutes && layer === 'SYNTHETIC' && (
                  <g>
                    {(routes.data?.routes ?? []).slice(0, 40).map((r, i) => (
                      <ArcPath
                        key={i}
                        from={[r.from_lon, r.from_lat]}
                        to={[r.to_lon, r.to_lat]}
                        colour={clusterColour(r.cluster_key)}
                        weight={r.count}
                      />
                    ))}
                  </g>
                )}

                {/* ---- symbols ---- */}
                {points.map((p) => {
                  const [x, y] = projection(p.coord) ?? [];
                  if (x === undefined) return null;
                  const r = radiusFor(p.value, p.max);
                  const colour = severityColour(p.risk);
                  const isHovered = hovered === p.state;
                  return (
                    <g
                      key={p.state}
                      onMouseEnter={() => setHovered(p.state)}
                      onMouseLeave={() => setHovered(null)}
                      style={{ cursor: 'pointer' }}
                    >
                      <circle cx={x} cy={y} r={r * 1.9} fill="url(#bubble-glow)" style={{ color: colour }} />
                      <circle
                        cx={x}
                        cy={y}
                        r={r}
                        fill={colour}
                        fillOpacity={isHovered ? 0.4 : 0.22}
                        stroke={colour}
                        strokeWidth={isHovered ? 2 : 1.2}
                      />
                      {(isHovered || labelled.has(p.state)) && (
                        <>
                          <text
                            x={x}
                            y={y - r - 6}
                            textAnchor="middle"
                            className="fill-txt"
                            style={{ fontSize: 12, fontFamily: 'Inter, sans-serif', fontWeight: 600, paintOrder: 'stroke', stroke: '#080b12', strokeWidth: 3 }}
                          >
                            {p.state}
                          </text>
                          <text
                            x={x}
                            y={y + 4}
                            textAnchor="middle"
                            style={{ fontSize: 11, fontFamily: 'JetBrains Mono, monospace', fontWeight: 600, fill: '#e6edf7', paintOrder: 'stroke', stroke: '#080b12', strokeWidth: 3 }}
                          >
                            {num(p.value)}
                          </text>
                        </>
                      )}
                    </g>
                  );
                })}
              </svg>
            </div>

            {/* The honest footnote about what is and is not drawn. */}
            <p className="shrink-0 border-t border-hair pt-2 text-[10px] leading-relaxed text-faint">
              Symbols are placed at the mean coordinates of complaints in each state and sized by
              volume. No political boundaries are drawn — India&apos;s borders are subject to official
              depiction requirements, and this map makes no claim about them.
              {layer === 'NCRB' && plottedCount < totalRows && (
                <> Showing {plottedCount} of {totalRows} states: NCRB is an aggregate table with no
                coordinates, so only states present in our own corpus can be positioned.</>
              )}
            </p>
          </div>
        )}
      </Panel>

      {/* ---- side ---- */}
      <div className="flex w-[330px] shrink-0 flex-col gap-3">
        <Panel title="Layer">
          <div className="flex flex-col gap-2">
            <div className="flex gap-1">
              {[
                { key: 'SYNTHETIC', label: 'Our complaints' },
                { key: 'NCRB', label: 'NCRB official' },
              ].map((l) => (
                <button
                  key={l.key}
                  type="button"
                  onClick={() => setLayer(l.key)}
                  className={cn(
                    'flex-1 rounded-[3px] border px-2 py-1.5 text-[11.5px] transition-colors',
                    layer === l.key ? 'border-blue bg-blue/10 text-txt' : 'border-hair text-dim hover:border-faint hover:text-txt'
                  )}
                >
                  {l.label}
                </button>
              ))}
            </div>

            {layer === 'NCRB' && (
              <div className="flex gap-1.5">
                <select
                  value={metric}
                  onChange={(e) => setMetric(e.target.value)}
                  className="h-[26px] flex-1 rounded-[3px] border border-hair bg-panel px-1.5 text-[11.5px] text-txt outline-none focus:border-blue"
                >
                  {(meta.data?.metrics ?? []).map((m) => (
                    <option key={m.metric} value={m.metric}>{scamLabel(m.metric)}</option>
                  ))}
                </select>
                <select
                  value={year}
                  onChange={(e) => setYear(Number(e.target.value))}
                  className="mn h-[26px] w-[80px] rounded-[3px] border border-hair bg-panel px-1.5 text-[11.5px] text-txt outline-none focus:border-blue"
                >
                  {(meta.data?.years ?? []).map((y) => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </select>
              </div>
            )}

            <p className="text-[10px] leading-relaxed text-faint">
              {layer === 'NCRB'
                ? meta.data?.source_note ?? 'Official National Crime Records Bureau statistics.'
                : 'Complaints in this platform, generated for demonstration. Counts, amounts and routes are computed from the corpus.'}
            </p>
          </div>
        </Panel>

        <Panel
          title={layer === 'NCRB' ? 'By state — NCRB' : 'By state'}
          subtitle={`${num(plottedCount)} plotted`}
          flush
          className="min-h-0 flex-1"
        >
          <div className="h-full overflow-y-auto">
            {!points.length ? (
              <Empty icon={MapPin} title="No geography to show" />
            ) : (
              [...points].sort((a, b) => b.value - a.value).map((p) => (
                <div
                  key={p.state}
                  onMouseEnter={() => setHovered(p.state)}
                  onMouseLeave={() => setHovered(null)}
                  className={cn(
                    'row-hover flex items-center gap-2.5 border-b border-hair px-3 py-2 last:border-b-0',
                    hovered === p.state && 'bg-raise'
                  )}
                >
                  <span className="size-1.5 shrink-0 rounded-full" style={{ background: severityColour(p.risk) }} />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[12px] text-txt">{p.state}</span>
                    <span className="truncate text-[10px] text-faint">{p.sub}</span>
                  </div>
                  <span className="mn shrink-0 text-[12px] font-semibold text-txt">{num(p.value)}</span>
                </div>
              ))
            )}
          </div>
        </Panel>

        {layer === 'SYNTHETIC' && (
          <Panel title="Interstate routes" subtitle={`${num(routes.data?.routes?.length ?? 0)}`} flush>
            <div className="max-h-[190px] overflow-y-auto">
              {(routes.data?.routes ?? []).slice(0, 20).map((r, i) => (
                <div key={i} className="flex items-center gap-2 border-b border-hair px-3 py-1.5 last:border-b-0">
                  <span className="mn shrink-0 text-[9.5px]" style={{ color: clusterColour(r.cluster_key) }}>
                    {r.cluster_key}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-dim">
                    {r.from_state} <span className="text-faint">→</span> {r.to_state}
                  </span>
                  <span className="mn shrink-0 text-[10.5px] text-faint">{r.count}</span>
                </div>
              ))}
            </div>
            <p className="border-t border-hair px-3 py-1.5 text-[9.5px] leading-relaxed text-faint">
              A cluster active in two states implies movement between them. Derived from cluster
              membership, never from a victim&apos;s own location.
            </p>
          </Panel>
        )}
      </div>
    </div>
  );
}
