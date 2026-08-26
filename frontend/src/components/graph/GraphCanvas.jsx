/**
 * The Cytoscape canvas.
 *
 * Cytoscape owns a mutable instance that React must not try to re-render. So
 * this component mounts it ONCE and then drives it imperatively through an
 * effect per concern — elements, selection, filters. Re-creating the instance
 * when data changes would throw away node positions and re-run the layout,
 * which on a 150-node graph is a half-second of everything jumping about, and
 * it would happen on every filter toggle.
 *
 * The payload arrives Cytoscape-ready from the API and is NOT reshaped
 * (docs/API.md is explicit). The only thing added is the visual encoding —
 * size, colour, edge width — which is presentation and belongs here.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';

import { stylesheet, layoutOptions, incrementalLayoutOptions, nodeSize, nodeColour } from './graphStyle';

cytoscape.use(fcose);

/** Edge thickness from link strength, compressed so a weight of 6 is not a slab. */
const edgeWidth = (weight) => 0.6 + Math.min(6, Math.max(1, Number(weight) || 1)) * 0.42;

/**
 * Decide where each neighbour's label sits, and drop the ones that will not fit.
 *
 * Capping the label count was necessary and not sufficient. Ten names still
 * collided, because every one of them was drawn at the same fixed offset below
 * its node — and a coordinator's neighbours sit in a ring, so the ones at the
 * same height overlapped every time ("ICICI Bank mule B" landing on top of
 * "Punjab National Bank mule A"). Cytoscape ships no label-collision solver, so
 * this is it.
 *
 * Two ideas do the work. Labels are pushed RADIALLY OUTWARD from the selected
 * node — a neighbour to the left gets a left-aligned label, one above gets its
 * label above — which turns a star topology's own geometry into the thing that
 * separates the text. Then each placement is checked against the ones already
 * taken, most-influential first, and a label with nowhere to go is not drawn at
 * all. A missing name costs one hover; an unreadable pile costs the whole view.
 *
 * Boxes are computed in model coordinates. Cytoscape scales label glyphs with
 * zoom exactly as it scales positions, so the two stay in the same units and
 * the result holds at any zoom level.
 */
function placeLabels(centre, neighbours) {
  const FONT = 11;
  const CHAR_W = FONT * 0.55;   // Inter 500, averaged over mixed-case text
  const LINE_H = FONT * 1.25;
  const GAP = 4;
  const MAX_W = 120;            // matches 'text-max-width' in graphStyle

  const cx = centre.position('x');
  const cy = centre.position('y');

  const boxFor = (n, place) => {
    const w = Math.min(MAX_W, String(n.data('label') ?? '').length * CHAR_W) + 6;
    const r = nodeSize(n.data('influence')) / 2;
    const x = n.position('x');
    const y = n.position('y');
    if (place === 'top') return { x: x - w / 2, y: y - r - GAP - LINE_H, w, h: LINE_H };
    if (place === 'bottom') return { x: x - w / 2, y: y + r + GAP, w, h: LINE_H };
    if (place === 'left') return { x: x - r - GAP - w, y: y - LINE_H / 2, w, h: LINE_H };
    return { x: x + r + GAP, y: y - LINE_H / 2, w, h: LINE_H };
  };

  const overlaps = (a, b) =>
    !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);

  // The selected node keeps its own label below itself, and claims that space
  // first — it is the one name that must never be dropped.
  centre.style({ 'text-valign': 'bottom', 'text-halign': 'center', 'text-margin-x': 0, 'text-margin-y': 5 });
  const taken = [boxFor(centre, 'bottom')];

  for (const n of neighbours) {
    const dx = n.position('x') - cx;
    const dy = n.position('y') - cy;

    // Try outward first, then the perpendicular directions, then back inward.
    const outward = Math.abs(dx) > Math.abs(dy)
      ? (dx >= 0 ? ['right', 'top', 'bottom', 'left'] : ['left', 'top', 'bottom', 'right'])
      : (dy >= 0 ? ['bottom', 'right', 'left', 'top'] : ['top', 'right', 'left', 'bottom']);

    const choice = outward.find((place) => !taken.some((t) => overlaps(boxFor(n, place), t)));
    if (!choice) continue;   // no room — hover still names it

    taken.push(boxFor(n, choice));
    n.style({
      'text-valign': choice === 'top' ? 'top' : choice === 'bottom' ? 'bottom' : 'center',
      'text-halign': choice === 'left' ? 'left' : choice === 'right' ? 'right' : 'center',
      'text-margin-x': choice === 'left' ? -GAP : choice === 'right' ? GAP : 0,
      'text-margin-y': choice === 'top' ? -GAP : choice === 'bottom' ? GAP : 0,
      'text-max-width': MAX_W,
    });
    n.addClass('labelled');
  }
}

/** API payload → Cytoscape elements, with the visual encoding attached. */
function toElements(nodes = [], edges = []) {
  const present = new Set(nodes.map((n) => n.id));
  return [
    ...nodes.map((n) => ({
      group: 'nodes',
      data: {
        ...n,
        size: nodeSize(n.influence),
        colour: nodeColour(n),
      },
    })),
    // An edge whose endpoint was filtered out would make Cytoscape throw, so
    // dangling edges are dropped rather than trusted.
    ...edges
      .filter((e) => present.has(e.source) && present.has(e.target))
      .map((e) => ({
        group: 'edges',
        data: { ...e, width: edgeWidth(e.weight) },
      })),
  ];
}

export default function GraphCanvas({
  nodes,
  edges,
  hiddenTypes,
  selectedId,
  onSelect,
  onExpand,
  onReady,
}) {
  const containerRef = useRef(null);
  const cyRef = useRef(null);
  // Handlers live in a ref so the mount effect can stay dependency-free — a
  // re-mount on every parent render would destroy the graph continuously.
  const handlers = useRef({ onSelect, onExpand });
  handlers.current = { onSelect, onExpand };

  const elements = useMemo(() => toElements(nodes, edges), [nodes, edges]);

  // ---- mount once --------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current) return undefined;

    const cy = cytoscape({
      container: containerRef.current,
      style: stylesheet,
      elements: [],
      minZoom: 0.12,
      maxZoom: 3.2,
      wheelSensitivity: 0.22,
      boxSelectionEnabled: false,
      // Cytoscape's own selection styling fights ours; we drive it explicitly.
      autounselectify: false,
      pixelRatio: window.devicePixelRatio > 1 ? 2 : 1,
    });
    cyRef.current = cy;

    cy.on('tap', 'node', (event) => handlers.current.onSelect?.(event.target.id()));
    cy.on('dbltap', 'node', (event) => handlers.current.onExpand?.(event.target.id()));
    // A tap on empty canvas clears the selection — the standard gesture, and
    // without it the only way out of focus mode is to find another node.
    cy.on('tap', (event) => {
      if (event.target === cy) handlers.current.onSelect?.(null);
    });

    onReady?.({
      fit: () => cy.animate({ fit: { padding: 42 }, duration: 300 }),
      zoomBy: (factor) =>
        cy.animate({ zoom: { level: cy.zoom() * factor, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }, duration: 160 }),
      relayout: () => cy.layout(layoutOptions).run(),
      focus: (id) => {
        const node = cy.getElementById(id);
        if (node.nonempty()) cy.animate({ center: { eles: node }, zoom: 1.5 }, { duration: 380 });
      },
      png: () => cy.png({ full: true, scale: 2, bg: '#080b12' }),
    });

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once, on purpose
  }, []);

  // ---- elements ----------------------------------------------------------
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    const incoming = new Set(elements.map((el) => el.data.id));
    const existing = new Set(cy.elements().map((el) => el.id()));
    const isFirstPaint = existing.size === 0;

    cy.batch(() => {
      // Remove what is gone, add what is new, leave the rest ALONE — that is
      // what preserves positions across an expansion so the picture grows
      // rather than reshuffling.
      cy.elements().forEach((el) => { if (!incoming.has(el.id())) el.remove(); });
      const added = elements.filter((el) => !existing.has(el.data.id));
      if (added.length) cy.add(added);
    });

    if (isFirstPaint) {
      cy.layout(layoutOptions).run();
    } else if (elements.length !== existing.size) {
      cy.layout(incrementalLayoutOptions).run();
    }
  }, [elements]);

  // ---- type filters ------------------------------------------------------
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.nodes().forEach((node) => {
        const hidden = hiddenTypes.has(node.data('type'));
        node.style('display', hidden ? 'none' : 'element');
      });
    });
  }, [hiddenTypes]);

  // ---- selection ---------------------------------------------------------
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.batch(() => {
      cy.elements().removeClass('faded highlighted labelled');

      // Label placement writes inline styles per node. Those override the
      // stylesheet and survive a class change, so a node labelled to the LEFT
      // for one selection would keep pointing left under the next one. Clearing
      // them here means each selection starts from the stylesheet defaults.
      cy.nodes().removeStyle('text-valign text-halign text-margin-x text-margin-y text-max-width');

      if (!selectedId) {
        // Nothing selected: label only the coordinators, so the page always
        // answers "who runs this" without the investigator clicking anything.
        cy.nodes('[?is_mastermind]').addClass('labelled');
        cy.$(':selected').unselect();
        return;
      }

      const node = cy.getElementById(selectedId);
      if (node.empty()) return;

      const neighbourhood = node.closedNeighborhood();
      cy.elements().difference(neighbourhood).addClass('faded');
      neighbourhood.addClass('highlighted');

      /**
       * Label the selected node and its strongest neighbours only.
       *
       * Labelling the whole neighbourhood is what it looked like it should do,
       * and on a 25-degree coordinator it produced a pile of overlapping text —
       * "Caller A — Ritu Mehta" sitting on top of "HDFC Bank mule A" — which is
       * strictly worse than no labels at all. Cytoscape has no label-collision
       * solver, so the fix is to ask for fewer.
       *
       * Ten is roughly what fits around one node without collisions at this
       * zoom, and taking them by influence means the ones that survive are the
       * ones worth reading.
       */
      const LABEL_CAP = 9;

      // Materialised to a plain array before sorting and slicing. Cytoscape
      // collections expose their own `sort`/`slice`, and chaining them here
      // silently left every neighbour labelled — the overlap this cap exists to
      // prevent. An array does exactly what it says.
      node.addClass('labelled');
      const candidates = neighbourhood
        .nodes()
        .toArray()
        .filter((n) => n.id() !== selectedId)
        .sort((a, b) => (b.data('influence') ?? 0) - (a.data('influence') ?? 0))
        .slice(0, LABEL_CAP);

      placeLabels(node, candidates);

      cy.$(':selected').unselect();
      node.select();
    });
  }, [selectedId, elements]);

  const onKeyDown = useCallback((event) => {
    if (event.key === 'Escape') handlers.current.onSelect?.(null);
  }, []);

  return (
    <div
      ref={containerRef}
      onKeyDown={onKeyDown}
      tabIndex={-1}
      className="size-full bg-void outline-none"
    />
  );
}
