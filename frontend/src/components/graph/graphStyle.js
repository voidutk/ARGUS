/**
 * The Cytoscape stylesheet.
 *
 * §E.3 fixes the encoding and it is not negotiable, because an investigator
 * reads structure from it before reading a single label:
 *
 *   node SIZE      = influence score
 *   node COLOUR    = cluster (the same colour it has on every other page, §K)
 *   edge THICKNESS = link strength
 *
 * Everything else here exists to keep 150 nodes legible. The temptation with a
 * force-directed graph is to make every node glow — the result is a light show
 * where nothing is distinguishable. The rules below go the other way: the
 * canvas is near-black, nodes are flat fills with a hairline ring, edges are
 * thin and low-opacity, and BRIGHTNESS IS RESERVED for the two things that
 * carry meaning — the coordinator, and whatever the investigator has selected.
 */

import { clusterColour } from '@/utils/format';

/** Unclustered nodes. Deliberately grey: no cluster is not a cluster. */
const UNCLUSTERED = '#3d4759';
const COMPLAINT = '#2a3446';

/**
 * Node diameter from influence.
 *
 * Square-rooted rather than linear. Influence spans 0–100 and a linear map
 * makes a score of 20 nearly invisible next to a 100; area-proportional sizing
 * keeps the low end readable while still making the coordinator unmistakable.
 */
export function nodeSize(influence) {
  const n = Math.max(0, Math.min(100, Number(influence) || 0));
  return 12 + Math.sqrt(n / 100) * 30;
}

export function nodeColour(node) {
  if (node.type === 'COMPLAINT') return COMPLAINT;
  return node.cluster ? clusterColour(node.cluster) : UNCLUSTERED;
}

export const stylesheet = [
  // ---- nodes -------------------------------------------------------------
  {
    selector: 'node',
    style: {
      'background-color': 'data(colour)',
      'background-opacity': 0.9,
      width: 'data(size)',
      height: 'data(size)',
      // A ring in the canvas colour, so overlapping nodes read as separate
      // objects instead of merging into a blob at high density.
      'border-width': 1.5,
      'border-color': '#080b12',
      'border-opacity': 1,
      label: 'data(label)',
      color: '#c2cfe0',
      'font-size': 11,
      'font-family': 'Inter, system-ui, sans-serif',
      'font-weight': 500,
      'text-valign': 'bottom',
      'text-margin-y': 5,
      'text-max-width': 120,
      'text-wrap': 'ellipsis',
      // A dark halo behind the glyphs. Labels sit over edges and neighbouring
      // nodes; without it they are unreadable exactly where the graph is
      // densest, which is where the names matter most.
      'text-outline-color': '#080b12',
      'text-outline-width': 2.5,
      'text-outline-opacity': 0.92,
      // Labels are drawn but hidden by default — see the `.labelled` class.
      // Rendering 150 labels at once is unreadable; rendering none loses the
      // investigator. Only the nodes that matter get one.
      'text-opacity': 0,
      'overlay-opacity': 0,
      'transition-property': 'background-opacity, border-color, border-width, text-opacity',
      'transition-duration': '120ms',
    },
  },

  // Complaints are square. Shape carries the entity/event distinction so it
  // survives when colour is doing cluster duty.
  {
    selector: 'node[type = "COMPLAINT"]',
    style: {
      shape: 'round-rectangle',
      'background-opacity': 0.95,
      // Lifted off the canvas. At #2a3446 on a #080b12 ground these read as
      // holes punched in the background rather than as objects, and complaints
      // are ~30% of the opening view — a third of the picture looked like a gap.
      'background-color': '#39455c',
      'border-color': '#4a5875',
      'border-width': 1,
      color: '#8b9bb4',
    },
  },

  { selector: 'node[type = "PERSON"]', style: { shape: 'ellipse' } },
  { selector: 'node[type = "WALLET"]', style: { shape: 'diamond' } },
  { selector: 'node[type = "BANK_ACCOUNT"]', style: { shape: 'round-tag' } },
  { selector: 'node[type = "TELEGRAM"]', style: { shape: 'round-triangle' } },
  { selector: 'node[type = "IP"], node[type = "DEVICE"]', style: { shape: 'round-hexagon' } },

  // Nodes whose label is shown: the coordinators, the selected node, and
  // anything the investigator has expanded.
  {
    selector: 'node.labelled',
    style: { 'text-opacity': 1, color: '#c2cfe0' },
  },

  /**
   * Flagged entities.
   *
   * Deliberately understated: 62% of the entities in the opening view carry
   * this flag, and a marker that fires on two nodes in three is decoration, not
   * a signal — it made the whole graph read as uniformly alarming while telling
   * an investigator nothing about where to look. Size (influence) and colour
   * (cluster) are the encodings that actually discriminate here; risk gets its
   * proper explanation in the detail rail, where there is room to say WHY.
   *
   * Declared BEFORE the coordinator rule below so a flagged coordinator — which
   * all of them are — still gets its white ring. Later rules win in Cytoscape,
   * and with these two swapped the single most important mark on the page was
   * being overwritten by the least discriminating one.
   */
  {
    selector: 'node[?is_flagged]',
    style: { 'border-color': '#6e3644', 'border-width': 1.5 },
  },

  /**
   * The coordinator (§T scene 4).
   *
   * A white ring rather than a brighter fill — the fill is already carrying
   * cluster identity, and overloading it would break the one encoding the whole
   * page depends on. White is used nowhere else, so it reads instantly.
   */
  {
    selector: 'node[?is_mastermind]',
    style: {
      'border-width': 3,
      'border-color': '#ffffff',
      'text-opacity': 1,
      color: '#ffffff',
      'font-size': 13,
      'font-weight': 700,
      'text-margin-y': 7,
      'z-index': 20,
    },
  },

  // ---- edges -------------------------------------------------------------
  {
    selector: 'edge',
    style: {
      width: 'data(width)',
      'line-color': '#232f45',
      'curve-style': 'straight',
      opacity: 0.55,
      'overlay-opacity': 0,
      'transition-property': 'line-color, opacity, width',
      'transition-duration': '120ms',
    },
  },

  // Money movement is the one edge type with its own colour: it is the only
  // relationship that answers "where did the money go", which is a different
  // question from "who knows whom" and gets asked separately.
  {
    selector: 'edge[type = "TRANSFERRED_TO"]',
    style: { 'line-color': '#3a5a7d', 'target-arrow-shape': 'triangle', 'target-arrow-color': '#3a5a7d', 'arrow-scale': 0.7 },
  },
  {
    selector: 'edge[type = "REPORTED_IN"]',
    style: { 'line-style': 'dashed', 'line-dash-pattern': [3, 3], opacity: 0.32 },
  },

  // ---- interaction -------------------------------------------------------
  //
  // Selection works by DIMMING the rest rather than brightening the target.
  // Brightening one node in a dense graph barely registers; removing the
  // context around it isolates the answer immediately.
  {
    selector: '.faded',
    style: { 'background-opacity': 0.12, opacity: 0.06, 'text-opacity': 0 },
  },
  /**
   * A node in the selected neighbourhood.
   *
   * Controls EMPHASIS ONLY — deliberately no `text-opacity`. It used to set it,
   * which quietly overrode the label cap in GraphCanvas: every neighbour of a
   * 25-degree coordinator got a label, and the result was a pile of overlapping
   * text that was worse than no labels at all. Two classes, two jobs:
   * `highlighted` says "in scope", `labelled` says "worth naming".
   */
  {
    selector: 'node.highlighted',
    style: {
      'border-color': '#5b93ff',
      'border-width': 2.5,
      'z-index': 30,
    },
  },
  {
    selector: 'edge.highlighted',
    style: { 'line-color': '#5b93ff', opacity: 0.95, width: 2, 'z-index': 30 },
  },
  {
    selector: 'node:selected',
    style: {
      'border-color': '#5b93ff',
      'border-width': 3,
      'text-opacity': 1,
      color: '#e6edf7',
      'font-weight': 600,
      'z-index': 40,
    },
  },
];

/**
 * fCOSE layout settings.
 *
 * `randomize: true` is doing the opposite of what the name suggests, and
 * getting it wrong collapsed the whole graph into a diagonal line.
 *
 * In fCoSE the flag selects the INITIAL placement, not the final result:
 *   true  → spectral placement (an eigendecomposition of the graph Laplacian)
 *   false → keep whatever positions the nodes already have
 *
 * Freshly added nodes have no meaningful positions — Cytoscape stacks them at
 * the origin — so `false` hands the force simulation a degenerate starting
 * state with no gradient to resolve, and it settles into a chain.
 *
 * Spectral placement is itself deterministic for a given graph, so `true`
 * delivers BOTH a proper force-directed spread and the stable shape a rehearsed
 * demo needs. A network that rearranges itself between rehearsal and stage is
 * one nobody can narrate.
 */
export const layoutOptions = {
  name: 'fcose',
  quality: 'proof',
  randomize: true,
  animate: true,
  animationDuration: 620,
  animationEasing: 'ease-out',
  fit: true,
  padding: 42,
  nodeDimensionsIncludeLabels: false,
  uniformNodeDimensions: false,
  packComponents: true,
  // Repulsion tuned for ~150 nodes: enough to stop clumping, not so much that
  // the clusters fly apart and lose their visual grouping.
  nodeRepulsion: 8_500,
  idealEdgeLength: 62,
  edgeElasticity: 0.42,
  gravity: 0.32,
  gravityRange: 3.2,
  numIter: 2_500,
  tile: true,
};

/**
 * Re-layout after an expansion.
 *
 * `randomize: false` HERE is correct, and for the same reason it was wrong
 * above: by this point the existing nodes hold real positions worth keeping.
 * Re-running spectral placement would rearrange the entire graph around the
 * handful of nodes just added, and the investigator would lose the picture they
 * were reading. Keeping positions means expansion grows the graph outward
 * instead of redrawing it.
 *
 * `fit: false` for the same reason — the viewport stays where they left it.
 */
export const incrementalLayoutOptions = {
  ...layoutOptions,
  quality: 'default',
  randomize: false,
  animationDuration: 420,
  fit: false,
  numIter: 900,
};
