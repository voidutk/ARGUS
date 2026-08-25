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
      neighbourhood.nodes().addClass('labelled');

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
