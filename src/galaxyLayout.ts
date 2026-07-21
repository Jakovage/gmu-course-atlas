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

export function bfsTree(start: string, adj: Map<string, string[]>): GraphTree {
  const dist = new Map<string, number>([[start, 0]]);
  const children = new Map<string, string[]>();
  const queue = [start];
  let head = 0;

  while (head < queue.length) {
    const cur = queue[head++];
    for (const next of adj.get(cur) ?? []) {
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
): Map<string, Pos> {
  const layout = treeLayout(root, tree.children);
  const slot = Math.min(SLOT, MAX_SPAN / (layout.leafCount - 1 || 1));
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
  if (raw.size === 0) return raw;

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

  function concurrentGroups(e: Expr | null): string[][] {
    if (!e) return [];
    if (e.kind === 'course') {
      if (!e.concurrent || !coreqOf.get(active)?.has(e.id) || seenPartner.has(e.id)) return [];
      seenPartner.add(e.id);
      return [[e.id]];
    }
    if (e.kind === 'condition') return [];
    if (e.kind === 'and') return e.of.flatMap(concurrentGroups);

    const leaves = concurrentRefs(e).filter((id) => {
      if (!coreqOf.get(active)?.has(id) || seenPartner.has(id)) return false;
      seenPartner.add(id);
      return true;
    });
    return leaves.length ? [leaves] : [];
  }

  const groups = [
    ...concurrentGroups(activeCourse?.prereq ?? null),
    ...concurrentGroups(activeCourse?.recommended ?? null),
  ];

  let side: 1 | -1 = 1;
  const rankOnSide = { 1: 0, [-1]: 0 } as Record<1 | -1, number>;

  for (const group of groups) {
    for (const id of group) {
      rankOnSide[side]++;
      const newPos = {
        x: anchor.x + side * rankOnSide[side] * COREQ_GAP,
        y: anchor.y,
      };
      targets.set(id, newPos);
      lit.add(id);

      const partnerDown = bfsTree(id, prereqsOf);
      const partnerUp = bfsTree(id, dependentsOf);
      for (const [sid, p] of placeFan(newPos, partnerDown, id, 1)) {
        if (sid !== active && !targets.has(sid)) {
          targets.set(sid, p);
          lit.add(sid);
        }
      }
      for (const [sid, p] of placeFan(newPos, partnerUp, id, -1)) {
        if (sid !== active && !targets.has(sid)) {
          targets.set(sid, p);
          lit.add(sid);
        }
      }
    }
    side = side === 1 ? -1 : 1;
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