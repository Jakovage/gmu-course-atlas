import type { Course } from './catalog';
import type { Expr } from './parse';

export const VW = 1600;
export const VH = 900;
export const PAD = 70;
export const MAX_ZOOM_MULT = 8;
export const DRAG_THRESHOLD = 4;
export const DIM_FLOOR = 0.02;
export const LERP = 0.16;

const ROW = 80;
const SLOT = 46;
const MAX_SPAN = VW - 2 * PAD;
const ROW_CAP = 2 * ROW;
const BOX_PAD = 14;
const BOX_PAD_STEP = 10;
const COREQ_GAP = 56;
const COREQ_NODE_CLEARANCE_X = 44;
const COREQ_BAND_HEIGHT = 38;
const FOCUS_VIEW_PAD = PAD + 18;
const COREQ_FAN_MAX_SPAN = MAX_SPAN * 0.42;

export interface Pos {
  x: number;
  y: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  recommended: boolean;
}

export interface GraphTree {
  dist: Map<string, number>;
  children: Map<string, string[]>;
}

export interface BoxInstr {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  dashed: boolean;
}

export interface FocusLayout {
  active: string;
  down: GraphTree;
  up: GraphTree;
  lit: Set<string>;
  targets: Map<string, Pos>;
  edges: GraphEdge[];
}

export interface FocusLayoutInput {
  active: string;
  byId: Map<string, Course>;
  prereqsOf: Map<string, string[]>;
  dependentsOf: Map<string, string[]>;
  coreqOf: Map<string, Set<string>>;
  recommendedEdge: Set<string>;
  globalPositions: Map<string, Pos>;
}

export function allRefs(e: Expr | null): string[] {
  if (!e) return [];
  if (e.kind === 'course') return [e.id];
  if (e.kind === 'condition') return [];
  return e.of.flatMap(allRefs);
}

export function concurrentRefs(e: Expr | null): string[] {
  if (!e) return [];
  if (e.kind === 'course') return e.concurrent ? [e.id] : [];
  if (e.kind === 'condition') return [];
  return e.of.flatMap(concurrentRefs);
}

export function depthOpacity(depth: number): number {
  if (depth <= 1) return 1;
  return 0.3;
}

export function bfsTree(
  start: string,
  adj: Map<string, string[]>,
  blocked: ReadonlySet<string> = new Set(),
): GraphTree {
  const dist = new Map<string, number>([[start, 0]]);
  const children = new Map<string, string[]>();
  const queue = [start];
  let head = 0;

  while (head < queue.length) {
    const cur = queue[head++];
    for (const next of adj.get(cur) ?? []) {
      if (next !== start && blocked.has(next)) continue;
      if (dist.has(next)) continue;
      dist.set(next, dist.get(cur)! + 1);
      const list = children.get(cur);
      if (list) list.push(next);
      else children.set(cur, [next]);
      queue.push(next);
    }
  }

  return { dist, children };
}

function treeLayout(root: string, children: Map<string, string[]>) {
  const relX = new Map<string, number>();
  let leaf = 0;

  function visit(id: string): void {
    const kids = children.get(id) ?? [];
    if (kids.length === 0) {
      relX.set(id, leaf++);
      return;
    }
    for (const kid of kids) visit(kid);
    const xs = kids.map((kid) => relX.get(kid)!);
    relX.set(id, (Math.min(...xs) + Math.max(...xs)) / 2);
  }

  visit(root);
  return {
    relX,
    rootX: relX.get(root)!,
    leafCount: Math.max(leaf, 1),
  };
}

function placeFan(
  anchor: Pos,
  tree: GraphTree,
  root: string,
  verticalSign: 1 | -1,
  options: { maxSpan?: number; clampToCanvas?: boolean } = {},
): Map<string, Pos> {
  const layout = treeLayout(root, tree.children);
  const maxSpan = options.maxSpan ?? MAX_SPAN;
  const slot = Math.min(SLOT, maxSpan / (layout.leafCount - 1 || 1));
  const maxDist = Math.max(1, ...tree.dist.values());
  const available = verticalSign === 1 ? VH - PAD - anchor.y : anchor.y - PAD;
  const rowScale = Math.min(ROW_CAP, Math.max(24, available / maxDist));

  const raw = new Map<string, Pos>();
  for (const [id, rx] of layout.relX) {
    if (id === root) continue;
    raw.set(id, {
      x: anchor.x + (rx - layout.rootX) * slot,
      y: anchor.y + verticalSign * tree.dist.get(id)! * rowScale,
    });
  }
  if (raw.size === 0 || options.clampToCanvas === false) return raw;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of raw.values()) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }

  const shiftX = Math.min(0, VW - PAD - maxX) || Math.max(0, PAD - minX);
  const shiftY = Math.min(0, VH - PAD - maxY) || Math.max(0, PAD - minY);
  if (shiftX !== 0 || shiftY !== 0) {
    for (const p of raw.values()) {
      p.x += shiftX;
      p.y += shiftY;
    }
  }
  return raw;
}

export function buildFocusLayout(input: FocusLayoutInput): FocusLayout {
  const {
    active,
    byId,
    prereqsOf,
    dependentsOf,
    coreqOf,
    recommendedEdge,
    globalPositions,
  } = input;

  const down = bfsTree(active, prereqsOf);
  const up = bfsTree(active, dependentsOf);
  const lit = new Set<string>();
  for (const id of down.dist.keys()) lit.add(id);
  for (const id of up.dist.keys()) lit.add(id);

  const edges: GraphEdge[] = [];
  const seenEdges = new Set<string>();
  const addEdge = (from: string, to: string) => {
    const key = `${from}>${to}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push({ from, to, recommended: recommendedEdge.has(key) });
  };

  for (const [to, refs] of down.children) {
    for (const from of refs) addEdge(from, to);
  }
  for (const [from, dependents] of up.children) {
    for (const to of dependents) addEdge(from, to);
  }

  const anchor = globalPositions.get(active);
  if (!anchor) {
    return { active, down, up, lit, targets: new Map(), edges };
  }

  const targets = new Map<string, Pos>([[active, { ...anchor }]]);
  for (const [id, p] of placeFan(anchor, down, active, 1)) targets.set(id, p);
  for (const [id, p] of placeFan(anchor, up, active, -1)) targets.set(id, p);

  const activeCourse = byId.get(active);
  const seenPartner = new Set<string>();

  // Treat a declared concurrent relationship as reciprocal for focused
  // placement only. The underlying prerequisite/recommended edge keeps its
  // original direction; this set only decides which direct relatives sit
  // beside the active course.
  const directCoreqPartners = new Set<string>(coreqOf.get(active) ?? []);
  for (const [owner, refs] of coreqOf) {
    if (owner !== active && refs.has(active) && byId.has(owner)) {
      directCoreqPartners.add(owner);
    }
  }

  function concurrentGroups(e: Expr | null): string[][] {
    if (!e) return [];
    if (e.kind === 'course') {
      if (!e.concurrent || !directCoreqPartners.has(e.id) || seenPartner.has(e.id)) return [];
      seenPartner.add(e.id);
      return [[e.id]];
    }
    if (e.kind === 'condition') return [];
    if (e.kind === 'and') return e.of.flatMap(concurrentGroups);

    const leaves = concurrentRefs(e).filter((id) => {
      if (!directCoreqPartners.has(id) || seenPartner.has(id)) return false;
      seenPartner.add(id);
      return true;
    });
    return leaves.length ? [leaves] : [];
  }

  const groups = [
    ...concurrentGroups(activeCourse?.prereq ?? null),
    ...concurrentGroups(activeCourse?.recommended ?? null),
  ];

  // Any reciprocal declaration not encountered in the active course's own
  // expression still belongs beside it. This also guarantees recommended
  // corequisites are treated identically to required corequisites.
  for (const id of [...directCoreqPartners].sort()) {
    if (id === active || seenPartner.has(id) || !byId.has(id)) continue;
    seenPartner.add(id);
    groups.push([id]);
  }

  function buildGroupCandidate(
    group: string[],
    side: 1 | -1,
    startingRank: number,
  ): Map<string, Pos> {
    const candidate = new Map<string, Pos>();

    group.forEach((id, index) => {
      const newPos = {
        x: anchor.x + side * (startingRank + index + 1) * COREQ_GAP,
        y: anchor.y,
      };
      candidate.set(id, newPos);

      // A corequisite's private fan must not walk back through the focused
      // course (or another parallel corequisite). Doing so recreates the
      // active course's entire closure inside the partner fan and produces
      // the long, crossing bundles seen around large prerequisite trees.
      const blockedRoots = new Set<string>([active, ...directCoreqPartners]);
      blockedRoots.delete(id);
      const partnerDown = bfsTree(id, prereqsOf, blockedRoots);
      const partnerUp = bfsTree(id, dependentsOf, blockedRoots);

      // Keep genuinely shared nodes in the active tree, but let this parallel
      // root reclaim nodes that are reachable only through it. Previously
      // every node already present in `targets` was left untouched, which
      // meant a corequisite moved sideways while its entire private ancestry
      // remained centered above the active course—the crossing bundles shown
      // in the screenshots. Blocking this partner from the active searches
      // tells us which nodes still belong to the main tree without it.
      const reachableWithoutPartner = new Set<string>();
      for (const sid of bfsTree(active, prereqsOf, new Set([id])).dist.keys()) {
        reachableWithoutPartner.add(sid);
      }
      for (const sid of bfsTree(active, dependentsOf, new Set([id])).dist.keys()) {
        reachableWithoutPartner.add(sid);
      }
      const belongsToPartner = (sid: string) => (
        sid !== active
        && !reachableWithoutPartner.has(sid)
      );

      const partnerFanOptions = {
        maxSpan: COREQ_FAN_MAX_SPAN,
        clampToCanvas: false,
      };
      for (const [sid, p] of placeFan(newPos, partnerDown, id, 1, partnerFanOptions)) {
        if (belongsToPartner(sid) && !candidate.has(sid)) {
          candidate.set(sid, p);
        }
      }
      for (const [sid, p] of placeFan(newPos, partnerUp, id, -1, partnerFanOptions)) {
        if (belongsToPartner(sid) && !candidate.has(sid)) {
          candidate.set(sid, p);
        }
      }
    });

    return candidate;
  }

  function separateCandidate(
    candidate: Map<string, Pos>,
    side: 1 | -1,
  ): { positions: Map<string, Pos>; score: number } {
    const existing = [...targets.entries()]
      .filter(([id]) => !candidate.has(id))
      .map(([, p]) => p);

    type Envelope = { minX: number; maxX: number };
    const envelopeByBand = (points: Iterable<Pos>) => {
      const bands = new Map<number, Envelope>();
      for (const p of points) {
        const band = Math.round(p.y / COREQ_BAND_HEIGHT);
        const current = bands.get(band);
        if (current) {
          current.minX = Math.min(current.minX, p.x);
          current.maxX = Math.max(current.maxX, p.x);
        } else {
          bands.set(band, { minX: p.x, maxX: p.x });
        }
      }
      return bands;
    };

    const existingBands = envelopeByBand(existing);
    const candidateBands = envelopeByBand(candidate.values());
    let shift = 0;

    // Compare the complete horizontal envelope of each nearby row, not just
    // individual node pairs. This reserves a clean lane for the entire
    // corequisite bundle—including a tall parent/grandparent tree—so its
    // branches cannot thread through the already placed focused tree.
    for (const [band, candidateEnvelope] of candidateBands) {
      for (let nearby = band - 1; nearby <= band + 1; nearby++) {
        const existingEnvelope = existingBands.get(nearby);
        if (!existingEnvelope) continue;
        if (side === 1) {
          shift = Math.max(
            shift,
            existingEnvelope.maxX + COREQ_NODE_CLEARANCE_X - candidateEnvelope.minX,
          );
        } else {
          shift = Math.min(
            shift,
            existingEnvelope.minX - COREQ_NODE_CLEARANCE_X - candidateEnvelope.maxX,
          );
        }
      }
    }

    const shifted = new Map<string, Pos>();
    let minX = Infinity;
    let maxX = -Infinity;
    for (const [id, p] of candidate) {
      const next = { x: p.x + shift, y: p.y };
      shifted.set(id, next);
      minX = Math.min(minX, next.x);
      maxX = Math.max(maxX, next.x);
    }

    const overflow = Math.max(0, FOCUS_VIEW_PAD - minX)
      + Math.max(0, maxX - (VW - FOCUS_VIEW_PAD));
    return { positions: shifted, score: Math.abs(shift) + overflow * 12 };
  }

  let preferredSide: 1 | -1 = 1;
  const rankOnSide = { 1: 0, [-1]: 0 } as Record<1 | -1, number>;

  for (const group of groups) {
    const preferred = separateCandidate(
      buildGroupCandidate(group, preferredSide, rankOnSide[preferredSide]),
      preferredSide,
    );
    const alternateSide: 1 | -1 = preferredSide === 1 ? -1 : 1;
    const alternate = separateCandidate(
      buildGroupCandidate(group, alternateSide, rankOnSide[alternateSide]),
      alternateSide,
    );

    const chosenSide = alternate.score + 4 < preferred.score ? alternateSide : preferredSide;
    const chosen = chosenSide === preferredSide ? preferred : alternate;

    for (const [id, p] of chosen.positions) {
      targets.set(id, p);
      lit.add(id);
    }
    rankOnSide[chosenSide] += group.length;
    preferredSide = chosenSide === 1 ? -1 : 1;
  }

  // Last-resort viewport fit. Keep the focused course fixed, but fit each
  // direction independently. A wide or downward corequisite bundle must not
  // shrink the otherwise well-fitting dependent tree above the focused node.
  //
  // Previously one shared scale was applied to x and y in every direction.
  // One corequisite branch touching an edge therefore compressed the entire
  // closure, wasting large amounts of usable vertical space.
  if (targets.size > 1) {
    const minXBound = Math.min(FOCUS_VIEW_PAD, anchor.x);
    const maxXBound = Math.max(VW - FOCUS_VIEW_PAD, anchor.x);
    const minYBound = Math.min(FOCUS_VIEW_PAD, anchor.y);
    const maxYBound = Math.max(VH - FOCUS_VIEW_PAD, anchor.y);

    const MIN_DIRECTION_SCALE = 0.65;
    let leftScale = 1;
    let rightScale = 1;
    let upScale = 1;
    let downScale = 1;

    const ratio = (available: number, distance: number): number => {
      if (distance <= 0) return 1;
      return Math.max(
        MIN_DIRECTION_SCALE,
        Math.min(1, Math.max(0, available) / distance),
      );
    };

    for (const [id, p] of targets) {
      if (id === active) continue;

      const dx = p.x - anchor.x;
      const dy = p.y - anchor.y;

      if (dx > 0) {
        rightScale = Math.min(rightScale, ratio(maxXBound - anchor.x, dx));
      } else if (dx < 0) {
        leftScale = Math.min(leftScale, ratio(anchor.x - minXBound, -dx));
      }

      if (dy > 0) {
        downScale = Math.min(downScale, ratio(maxYBound - anchor.y, dy));
      } else if (dy < 0) {
        upScale = Math.min(upScale, ratio(anchor.y - minYBound, -dy));
      }
    }

    for (const [id, p] of targets) {
      if (id === active) continue;

      const dx = p.x - anchor.x;
      const dy = p.y - anchor.y;
      const xScale = dx < 0 ? leftScale : rightScale;
      const yScale = dy < 0 ? upScale : downScale;

      p.x = anchor.x + dx * xScale;
      p.y = anchor.y + dy * yScale;
    }

    targets.set(active, { ...anchor });
  }

  return { active, down, up, lit, targets, edges };
}

export function collectBoxes(
  expr: Expr,
  parentIsOr: boolean,
  posOf: (id: string) => Pos | undefined,
  boxes: BoxInstr[],
): { leaves: string[]; innerLevels: number } {
  if (expr.kind === 'course') return { leaves: [expr.id], innerLevels: 0 };
  if (expr.kind === 'condition') return { leaves: [], innerLevels: 0 };

  const leaves: string[] = [];
  let innerMax = 0;
  for (const child of expr.of) {
    const result = collectBoxes(child, expr.kind === 'or', posOf, boxes);
    leaves.push(...result.leaves);
    innerMax = Math.max(innerMax, result.innerLevels);
  }

  const needsBox = expr.kind === 'or' || parentIsOr;
  const points = leaves.map(posOf).filter((p): p is Pos => p !== undefined);
  if (needsBox && points.length >= 2) {
    const pad = BOX_PAD + innerMax * BOX_PAD_STEP;
    boxes.push({
      x0: Math.min(...points.map((p) => p.x)) - pad,
      x1: Math.max(...points.map((p) => p.x)) + pad,
      y0: Math.min(...points.map((p) => p.y)) - pad,
      y1: Math.max(...points.map((p) => p.y)) + pad,
      dashed: expr.kind === 'or',
    });
  }

  return {
    leaves,
    innerLevels: needsBox && points.length >= 2 ? innerMax + 1 : innerMax,
  };
}

export function xRangeOf(courses: Course[], positions: Map<string, number>): [number, number] {
  const xs = courses
    .map((course) => positions.get(course.id))
    .filter((x): x is number => x !== undefined);
  if (xs.length === 0) return [0, 1];
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  return [lo, Math.max(hi - lo, 0.001)];
}

export function globalWorldOf(
  id: string,
  maxTier: number,
  xMin: number,
  xRange: number,
  positions: Map<string, number>,
  tiers: Map<string, number>,
): Pos {
  const normalizedX = positions.get(id) ?? xMin;
  return {
    x: PAD + ((normalizedX - xMin) / xRange) * (VW - 2 * PAD),
    y: VH - PAD - ((tiers.get(id) ?? 0) / Math.max(maxTier, 1)) * (VH - 2 * PAD),
  };
}