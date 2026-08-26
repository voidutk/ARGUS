/**
 * Criminal Network Explorer — the project's centrepiece (docs/PROJECT.md §E.3),
 * and Scenes 3 and 4 of the demo.
 *
 * The page owns the graph DATA; GraphCanvas owns the Cytoscape instance. That
 * split matters: expansion merges new nodes into the existing set here, so the
 * canvas receives a superset and grows the picture rather than replacing it.
 * Positions survive, and the investigator keeps their bearings.
 *
 * §F applies as everywhere else — if intel-service cannot answer, Express
 * serves the same shapes from Postgres and the banner says so. The canvas
 * cannot tell the difference, which is the point.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Crosshair, Focus, Layers, Maximize2, Minus, Plus, TriangleAlert,
} from 'lucide-react';

import { graph as graphApi } from '@/api';
import { useApi } from '@/hooks/useApi';
import GraphCanvas from '@/components/graph/GraphCanvas';
import DetailRail from '@/components/graph/DetailRail';
import { Dot, Failed, Loading } from '@/components/ui/Bits';
import { clusterColour, ENTITY_TYPES, num } from '@/utils/format';
import { cn } from '@/lib/utils';

const FILTERABLE = ['PHONE', 'UPI', 'BANK_ACCOUNT', 'WALLET', 'EMAIL', 'IP', 'DEVICE', 'TELEGRAM', 'PERSON', 'COMPLAINT'];

/** A small canvas control button. */
function CanvasButton({ onClick, title, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="flex size-7 items-center justify-center rounded-[3px] border border-hair bg-panel/90 text-dim backdrop-blur transition-colors hover:border-faint hover:text-txt"
    >
      {children}
    </button>
  );
}

export default function NetworkExplorer() {
  const { data, error, loading, refetch } = useApi(() => graphApi.overview(150), []);

  // Nodes added by expansion, merged over the base overview.
  const [extra, setExtra] = useState({ nodes: [], edges: [] });
  const [selectedId, setSelectedId] = useState(null);
  const [hiddenTypes, setHiddenTypes] = useState(() => new Set());
  const [expanding, setExpanding] = useState(false);
  const controls = useRef(null);

  /**
   * Base + expanded, de-duplicated by id.
   *
   * Expansion returns nodes already on screen alongside the new ones, so
   * without this the same node would be added twice and Cytoscape would throw.
   */
  const merged = useMemo(() => {
    const nodeById = new Map();
    const edgeById = new Map();
    for (const n of [...(data?.nodes ?? []), ...extra.nodes]) nodeById.set(n.id, n);
    for (const e of [...(data?.edges ?? []), ...extra.edges]) edgeById.set(e.id, e);
    return { nodes: [...nodeById.values()], edges: [...edgeById.values()] };
  }, [data, extra]);

  const selectedNode = useMemo(
    () => merged.nodes.find((n) => n.id === selectedId) ?? null,
    [merged.nodes, selectedId]
  );

  const visibleCount = useMemo(
    () => merged.nodes.filter((n) => !hiddenTypes.has(n.type)).length,
    [merged.nodes, hiddenTypes]
  );

  const handleExpand = useCallback(async (nodeId) => {
    setExpanding(true);
    try {
      const result = await graphApi.neighbors(nodeId, { depth: 1, limit: 40 });
      setExtra((prev) => ({
        nodes: [...prev.nodes, ...(result.nodes ?? [])],
        edges: [...prev.edges, ...(result.edges ?? [])],
      }));
      setSelectedId(nodeId);
    } catch {
      // An expansion that fails leaves the graph exactly as it was, which is a
      // perfectly good outcome — no error card is warranted for a double-click.
    } finally {
      setExpanding(false);
    }
  }, []);

  const toggleType = useCallback((type) => {
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type); else next.add(type);
      return next;
    });
  }, []);

  const masterminds = data?.stats?.masterminds ?? [];

  if (loading && !data) {
    return <div className="p-4"><Loading label="Building the network" /></div>;
  }
  if (error && !data) {
    return <div className="p-4"><Failed error={error} onRetry={refetch} /></div>;
  }

  /**
   * Only a genuine outage gets a banner.
   *
   * The graph is served from Postgres in two quite different situations, and
   * conflating them made the page shout "Live analysis unavailable" while every
   * service was healthy. `delegated` means intel-service answered and said this
   * computation lives in Express — by design, nothing wrong. Absent that, the
   * fallback really is degradation and §F requires it be visible.
   */
  const degraded = data?.source === 'postgres-fallback' && !data?.delegated;

  return (
    <div className="flex h-full min-h-0">
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* ---- toolbar ---- */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-hair bg-deep px-3 py-2">
          <div className="flex items-center gap-1.5">
            <Layers className="size-3.5 text-faint" strokeWidth={1.75} />
            <span className="mn text-[11px] text-dim">
              {num(visibleCount)}
              <span className="text-faint"> / {num(data?.stats?.total_nodes)} nodes</span>
            </span>
            <span className="mn text-[11px] text-faint">· {num(merged.edges.length)} links</span>
          </div>

          <div className="h-3.5 w-px bg-hair" />

          {/* Coordinator shortcuts — Scene 4 is one click from anywhere. */}
          <div className="flex items-center gap-1.5">
            <span className="lbl">Coordinators</span>
            {masterminds.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => { setSelectedId(m.id); controls.current?.focus(m.id); }}
                className={cn(
                  'flex h-[22px] items-center gap-1.5 rounded-[2px] border px-1.5 text-[11px] transition-colors',
                  selectedId === m.id
                    ? 'border-txt/40 bg-txt/[0.08] text-txt'
                    : 'border-hair text-dim hover:border-faint hover:text-txt'
                )}
              >
                <Dot colour={clusterColour(m.cluster)} size={5} />
                {m.label}
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            {FILTERABLE.filter((t) => merged.nodes.some((n) => n.type === t)).map((type) => {
              const hidden = hiddenTypes.has(type);
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => toggleType(type)}
                  title={`${hidden ? 'Show' : 'Hide'} ${ENTITY_TYPES[type]?.label ?? type}`}
                  className={cn(
                    'chip cursor-pointer transition-opacity',
                    hidden && 'opacity-35'
                  )}
                >
                  {ENTITY_TYPES[type]?.label ?? type}
                </button>
              );
            })}
          </div>
        </div>

        {/* ---- degradation banner (§F) — a real outage only ---- */}
        {degraded && (
          <div className="flex shrink-0 items-center gap-2 border-b border-amber/25 bg-amber/[0.06] px-3 py-1.5">
            <TriangleAlert className="size-3 shrink-0 text-amber" strokeWidth={2} />
            <p className="truncate text-[11px] text-dim">
              Live analysis unavailable — showing the last known picture.
              {data?.degraded_reason && <span className="text-faint"> {data.degraded_reason}</span>}
            </p>
          </div>
        )}

        {/* ---- canvas ---- */}
        <div className="relative min-h-0 flex-1">
          <GraphCanvas
            nodes={merged.nodes}
            edges={merged.edges}
            hiddenTypes={hiddenTypes}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onExpand={handleExpand}
            onReady={(api) => { controls.current = api; }}
          />

          <div className="absolute top-3 right-3 flex flex-col gap-1.5">
            <CanvasButton onClick={() => controls.current?.zoomBy(1.35)} title="Zoom in">
              <Plus className="size-3.5" strokeWidth={2} />
            </CanvasButton>
            <CanvasButton onClick={() => controls.current?.zoomBy(0.74)} title="Zoom out">
              <Minus className="size-3.5" strokeWidth={2} />
            </CanvasButton>
            <CanvasButton onClick={() => controls.current?.fit()} title="Fit to view">
              <Maximize2 className="size-3" strokeWidth={2} />
            </CanvasButton>
            <CanvasButton onClick={() => controls.current?.relayout()} title="Re-run layout">
              <Focus className="size-3.5" strokeWidth={2} />
            </CanvasButton>
          </div>

          {/* ---- legend ---- */}
          <div className="pointer-events-none absolute bottom-3 left-3 flex flex-col gap-1.5 rounded-[3px] border border-hair bg-panel/85 px-2.5 py-2 backdrop-blur">
            <span className="lbl">Networks</span>
            {(data?.stats?.masterminds ?? []).map((m) => (
              <span key={m.cluster} className="flex items-center gap-1.5">
                <Dot colour={clusterColour(m.cluster)} size={6} />
                <span className="mn text-[10px] text-dim">{m.cluster}</span>
              </span>
            ))}
            <div className="rule my-0.5" />
            <span className="flex items-center gap-1.5">
              <span className="size-[7px] rounded-full border-[1.5px] border-txt" />
              <span className="text-[10px] text-faint">coordinator</span>
            </span>
            <span className="text-[9.5px] leading-tight text-faint">
              size = influence
              <br />
              double-click to expand
            </span>
          </div>

          {expanding && (
            <div className="absolute top-3 left-3 flex items-center gap-2 rounded-[3px] border border-hair bg-panel/90 px-2.5 py-1.5 backdrop-blur">
              <Crosshair className="size-3 animate-pulse text-bluehi" strokeWidth={2} />
              <span className="text-[11px] text-dim">Expanding…</span>
            </div>
          )}
        </div>
      </div>

      <DetailRail
        node={selectedNode}
        onClose={() => setSelectedId(null)}
        onExpand={handleExpand}
        onFocus={(id) => controls.current?.focus(id)}
      />
    </div>
  );
}
