// Galaxy v6: local re-layout on hover/select. The active course's full
// transitive closure (both directions) gets its own live tree layout, laid
// out fresh around the active course's anchor point, animated in with a
// simple per-frame lerp. Everything outside the closure stays put at its
// global position. Releasing (hover off / click empty space) eases the
// closure back to its normal global position via the same lerp, since the
// "target" position just falls back to the global formula once nothing's
// active.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CATALOG, type Course } from './catalog';
import { TIERS, MAX_TIER, UNDERGRAD_MAX_TIER, levelOf } from './tiers';
import { POSITIONS } from './positions';
import { DEPT_COLOR, deptOf } from './colors';
import type { Expr } from './parse';
import { exprLines } from './format';

const VW = 1600, VH = 900, PAD = 70;   // fixed virtual canvas
const MAX_ZOOM_MULT = 8;
const DRAG_THRESHOLD = 4;              // px of movement before a click becomes a pan
const DIM_FLOOR = 0.02;                // fully unrelated nodes/edges
const ROW = 80;                        // local layout: world units per hop, vertically
const SLOT = 46;                       // local layout: max world units per leaf slot, horizontally
const LERP = 0.16;                     // per-frame easing toward target position
const MAX_SPAN = VW - 2 * PAD;         // a fan can never be wider than the usable canvas
const MAX_VSPAN = VH - 2 * PAD;        // ...or taller, for very deep chains
const ROW_CAP = 2 * ROW;               // ceiling on stretched row spacing
const BOX_PAD = 14;                    // padding around a group's leaves, world units
const BOX_PAD_STEP = 10;               // extra padding per level of nesting inside it
const COREQ_GAP = 56;                  // spacing between direct coreq partners, world units

function allRefs(e: Expr | null): string[] {
  if (!e) return [];
  if (e.kind === 'course') return [e.id];
  if (e.kind === 'condition') return [];
  return e.of.flatMap(allRefs);
}

// refs marked with * (may be taken concurrently) -- used to find direct
// corequisite partners so the local focus layout can place them beside
// the active course instead of hanging them in the ordinary before/after fan
function concurrentRefs(e: Expr | null): string[] {
  if (!e) return [];
  if (e.kind === 'course') return e.concurrent ? [e.id] : [];
  if (e.kind === 'condition') return [];
  return e.of.flatMap(concurrentRefs);
}

// depth 1 (direct neighbor) = full opacity, depth 2 = half, depth 3+ = flat quarter
function depthOpacity(depth: number): number {
  if (depth <= 1) return 1;
  //if (depth === 2) return 1 0.5;
  return .3 //0.25;
}

// BFS outward from `start`, tracking hop-distance and the tree's parent ->
// children structure (used both for edge highlighting and for local layout).
function bfsTree(start: string, adj: Map<string, string[]>) {
  const dist = new Map<string, number>([[start, 0]]);
  const children = new Map<string, string[]>();
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of adj.get(cur) ?? []) {
      if (dist.has(next)) continue;
      dist.set(next, dist.get(cur)! + 1);
      children.set(cur, [...(children.get(cur) ?? []), next]);
      queue.push(next);
    }
  }
  return { dist, children };
}


// classic tree x-layout: leaves get sequential slots, each parent centers
// over the span of its children. Returns relative x (in slot units).
function treeLayout(root: string, children: Map<string, string[]>) {
  const relX = new Map<string, number>();
  let leaf = 0;
  function visit(id: string) {
    const kids = children.get(id) ?? [];
    if (kids.length === 0) { relX.set(id, leaf); leaf++; return; }
    for (const k of kids) visit(k);
    const xs = kids.map((k) => relX.get(k)!);
    relX.set(id, (Math.min(...xs) + Math.max(...xs)) / 2);
  }
  visit(root);
  return { relX, rootX: relX.get(root)!, leafCount: Math.max(leaf, 1) };
}

// Places a whole BFS-tree fan around an anchor point, then, if the fan would
// spill past the canvas edge, slides the ENTIRE fan inward as one rigid
// group (never clamps individual nodes) so relative spacing is preserved and
// distinct nodes can never collapse onto the same boundary point.
function placeFan(
  anchor: Pos, tree: { dist: Map<string, number>; children: Map<string, string[]> },
  root: string, verticalSign: 1 | -1,
): Map<string, Pos> {
  const layout = treeLayout(root, tree.children);
  const slot = Math.min(SLOT, MAX_SPAN / (layout.leafCount - 1 || 1));
  const maxDist = Math.max(1, ...tree.dist.values());
  // stretch to fill whatever room actually exists from the anchor to the
  // screen edge in this direction, rather than a flat per-hop constant, so a
  // shallow fan spreads out to use the space instead of clumping near ROW.
  // Capped: without a ceiling, a tree with very few hops (e.g. one lone
  // dependent) divides nearly the whole remaining screen by 1 and shoots
  // that single node all the way to the edge, a long disconnected-looking
  // line with nothing in between. ROW_CAP keeps shallow trees comfortable.
  const available = verticalSign === 1 ? (VH - PAD - anchor.y) : (anchor.y - PAD);
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

  const xs = [...raw.values()].map((p) => p.x);
  const ys = [...raw.values()].map((p) => p.y);
  const shiftX = Math.min(0, VW - PAD - Math.max(...xs)) || Math.max(0, PAD - Math.min(...xs));
  const shiftY = Math.min(0, VH - PAD - Math.max(...ys)) || Math.max(0, PAD - Math.min(...ys));
  if (shiftX !== 0 || shiftY !== 0) {
    for (const [id, p] of raw) raw.set(id, { x: p.x + shiftX, y: p.y + shiftY });
  }
  return raw;
}

// Boxes for the active course's own DIRECT prerequisite expression only
// (no recursion into other courses' prereqs -- that stays the flat fan).
// Rule: draw a box only where one is needed to disambiguate --
//   - operator is OR: always needs a box (dashed)
//   - operator is AND but sits directly inside an OR: needs a box (solid)
//   - otherwise: no box, just bare edges (this is why most courses need none)
// A box's own padding grows with how many box levels are nested inside it,
// so nested boxes never touch their parent's border.
interface BoxInstr { x0: number; y0: number; y1: number; x1: number; dashed: boolean }

function collectBoxes(
  expr: Expr, parentIsOr: boolean, posOf: (id: string) => Pos | undefined, boxes: BoxInstr[],
): { leaves: string[]; innerLevels: number } {
  if (expr.kind === 'course') return { leaves: [expr.id], innerLevels: 0 };
  if (expr.kind === 'condition') return { leaves: [], innerLevels: 0 };

  const leaves: string[] = [];
  let innerMax = 0;
  for (const child of expr.of) {
    const res = collectBoxes(child, expr.kind === 'or', posOf, boxes);
    leaves.push(...res.leaves);
    innerMax = Math.max(innerMax, res.innerLevels);
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
  return { leaves, innerLevels: needsBox && points.length >= 2 ? innerMax + 1 : innerMax };
}

interface Camera { x: number; y: number; scale: number }
type Pos = { x: number; y: number };

export default function Galaxy() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [mouse, setMouse] = useState({ x: 0, y: 0 });
  const [query, setQuery] = useState('');
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [showGrad, setShowGrad] = useState(false);
  const effectiveMaxTier = showGrad ? MAX_TIER : UNDERGRAD_MAX_TIER;
  const [camera, setCamera] = useState<Camera | null>(null);

  const visible = useMemo(
    () => (showGrad ? CATALOG : CATALOG.filter((c) => levelOf(c.id) !== 'grad')),
    [showGrad],
  );

  // Immediate-relatives count (direct prereqs + direct unlocks), measured
  // against the full grad-toggled graph -- deliberately NOT the
  // relatives-filtered set below, since filtering by a count that the
  // filter itself changes would be circular. Slider at 1 (rightmost,
  // default) shows everything; sliding left progressively hides the most
  // connected hub courses first, until only fully isolated (0-relative)
  // courses remain at the far left.
  const { degreeOf, maxDegree } = useMemo(() => {
    const byId = new Map(visible.map((c) => [c.id, c]));
    const prereqCount = new Map<string, number>();
    const unlockCount = new Map<string, number>(visible.map((c) => [c.id, 0]));
    for (const c of visible) {
      const refs = [...new Set(allRefs(c.prereq))].filter((r) => byId.has(r));
      prereqCount.set(c.id, refs.length);
      for (const r of refs) unlockCount.set(r, (unlockCount.get(r) ?? 0) + 1);
    }
    const degreeOf = new Map<string, number>();
    let maxDegree = 1;
    for (const c of visible) {
      const d = (prereqCount.get(c.id) ?? 0) + (unlockCount.get(c.id) ?? 0);
      degreeOf.set(c.id, d);
      if (d > maxDegree) maxDegree = d;
    }
    return { degreeOf, maxDegree };
  }, [visible]);

  const [relFilter, setRelFilter] = useState(1); // 0..1; 1 = show everything
  const filteredVisible = useMemo(() => {
    if (relFilter >= 1) return visible;
    const threshold = Math.round(relFilter * maxDegree);
    return visible.filter((c) => (degreeOf.get(c.id) ?? 0) <= threshold);
  }, [visible, relFilter, degreeOf, maxDegree]);

  const visibleIds = useMemo(() => new Set(filteredVisible.map((c) => c.id)), [filteredVisible]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return new Set(filteredVisible
      .filter((c) => c.id.toLowerCase().includes(q)
        || String(c.title ?? '').toLowerCase().includes(q))
      .map((c) => c.id));
  }, [query, filteredVisible]);

  const { byId, prereqsOf, dependentsOf, coreqOf, recommendedEdge, recommendedIds } = useMemo(() => {
    const byId = new Map(filteredVisible.map((c) => [c.id, c]));
    // prereqsOf/dependentsOf now carry BOTH real prereqs and recommended
    // refs together -- recommended courses need to sit inside the same
    // tree/BFS layout as everything else (positioned via placeFan, subject
    // to the same tree-only-edges rule, same distance falloff), or they
    // fall back to wherever their raw global position is and the dashed
    // lines shoot across the whole canvas to reach them. recommendedEdge
    // tags which specific (from, to) pairs came from `recommended` rather
    // than `prereq`, purely so the draw pass can render them dashed --
    // it's a styling flag, not a separate graph.
    // tiers.ts / positions.ts / impact.ts / the AND-OR boxes all read only
    // c.prereq directly, never this merged view, so a recommendation still
    // can't affect tier depth, the relatives count, or gate logic.
    const prereqsOf = new Map<string, string[]>();
    const dependentsOf = new Map<string, string[]>(filteredVisible.map((c) => [c.id, []]));
    const recommendedEdge = new Set<string>();
    const recommendedIds = new Map<string, string[]>(); // for the tooltip's own list
    // one-directional: coreqOf.get(X) = courses X's OWN prereq (or
    // recommended) expression stars. Belongs entirely to X -- if X allows Y
    // concurrently, that's X's own flexibility, not a partnership.
    const coreqOf = new Map<string, Set<string>>(filteredVisible.map((c) => [c.id, new Set()]));
    for (const c of filteredVisible) {
      const prereqRefs = [...new Set(allRefs(c.prereq))].filter((r) => byId.has(r));
      const recRefs = [...new Set(allRefs(c.recommended))]
        .filter((r) => byId.has(r) && r !== c.id && !prereqRefs.includes(r));
      prereqsOf.set(c.id, [...prereqRefs, ...recRefs]);
      for (const r of prereqRefs) dependentsOf.get(r)!.push(c.id);
      for (const r of recRefs) {
        dependentsOf.get(r)!.push(c.id);
        recommendedEdge.add(`${r}>${c.id}`);
      }
      recommendedIds.set(c.id, recRefs);
      for (const r of concurrentRefs(c.prereq)) if (byId.has(r)) coreqOf.get(c.id)!.add(r);
      for (const r of concurrentRefs(c.recommended)) if (byId.has(r)) coreqOf.get(c.id)!.add(r);
    }
    return { byId, prereqsOf, dependentsOf, coreqOf, recommendedEdge, recommendedIds };
  }, [filteredVisible]);

  // x is renormalized to whichever courses are actually visible, not the
  // full catalog -- otherwise hiding grad courses leaves the undergrad
  // layout compressed into whatever sliver of [0,1] it originally occupied
  // alongside grad, with dead space on both sides instead of filling the view.
  const globalWorldOf = (id: string, maxTier: number, xMin: number, xRange: number): Pos => ({
    x: PAD + ((POSITIONS.get(id)! - xMin) / xRange) * (VW - 2 * PAD),
    y: VH - PAD - ((TIERS.get(id) ?? 0) / Math.max(maxTier, 1)) * (VH - 2 * PAD),
  });
  const xRangeOf = (courses: Course[]): [number, number] => {
    const xs = courses.map((c) => POSITIONS.get(c.id)!);
    const lo = Math.min(...xs), hi = Math.max(...xs);
    return [lo, Math.max(hi - lo, 0.001)];
  };

  const fitScale = (w: number, h: number) => Math.min(w / VW, h / VH) * 0.96;

  function clampCamera(cam: Camera, w: number, h: number): Camera {
    const fit = fitScale(w, h);
    const scale = Math.min(Math.max(cam.scale, fit), fit * MAX_ZOOM_MULT);
    const contentW = VW * scale, contentH = VH * scale;
    const clampAxis = (t: number, content: number, viewport: number) => {
      if (content <= viewport) return (viewport - content) / 2;
      return Math.min(0, Math.max(viewport - content, t));
    };
    return { scale, x: clampAxis(cam.x, contentW, w), y: clampAxis(cam.y, contentH, h) };
  }

  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => {
    setCamera((prev) => {
      const fit = fitScale(size.w, size.h);
      const base = prev ?? { x: (size.w - VW * fit) / 2, y: (size.h - VH * fit) / 2, scale: fit };
      return clampCamera(base, size.w, size.h);
    });
  }, [size]);
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    const fit = fitScale(size.w, size.h);
    setCamera({ x: (size.w - VW * fit) / 2, y: (size.h - VH * fit) / 2, scale: fit });
  }, [showGrad]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelected(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (selected && !visibleIds.has(selected)) setSelected(null);
    if (hovered && !visibleIds.has(hovered)) setHovered(null);
  }, [visibleIds]);

  // latest-value cache the render loop reads from, so the loop itself only
  // needs to start once (no restart-on-every-state-change churn)
  const stateRef = useRef({
    camera, size, hovered, selected, visible: filteredVisible, fullVisible: visible,
    byId, prereqsOf, dependentsOf, matches, effectiveMaxTier, coreqOf, recommendedEdge,
  });
  stateRef.current = {
    camera, size, hovered, selected, visible: filteredVisible, fullVisible: visible,
    byId, prereqsOf, dependentsOf, matches, effectiveMaxTier, coreqOf, recommendedEdge,
  };

  // animated position of every node; eases toward whatever target() returns
  const animPos = useRef<Map<string, Pos>>(new Map());
  const lastCanvasSize = useRef({ w: 0, h: 0 });
  const litRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let raf = 0;
    function tick() {
      const s = stateRef.current;
      raf = requestAnimationFrame(tick);
      if (!s.camera) return;
      const canvas = ref.current;
      if (!canvas) return;

      if (lastCanvasSize.current.w !== s.size.w || lastCanvasSize.current.h !== s.size.h) {
        const dpr = window.devicePixelRatio || 1;
        canvas.width = s.size.w * dpr; canvas.height = s.size.h * dpr;
        canvas.style.width = `${s.size.w}px`; canvas.style.height = `${s.size.h}px`;
        lastCanvasSize.current = { w: s.size.w, h: s.size.h };
      }
      const ctx = canvas.getContext('2d')!;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const [xMin, xRange] = xRangeOf(s.fullVisible);
      const active = s.selected ?? s.hovered;
      let down: ReturnType<typeof bfsTree> | null = null;
      let up: ReturnType<typeof bfsTree> | null = null;
      const lit = new Set<string>();
      const localTarget = new Map<string, Pos>();
      if (active) {
        down = bfsTree(active, s.prereqsOf);
        up = bfsTree(active, s.dependentsOf);
        for (const id of down.dist.keys()) lit.add(id);
        for (const id of up.dist.keys()) lit.add(id);

        const anchor = globalWorldOf(active, s.effectiveMaxTier, xMin, xRange);
        localTarget.set(active, anchor);

        for (const [id, p] of placeFan(anchor, down, active, 1)) localTarget.set(id, p);
        for (const [id, p] of placeFan(anchor, up, active, -1)) localTarget.set(id, p);

        // direct coreqs render parallel: same row as the active course,
        // fanning out beside it instead of hanging in the before/after tree.
        // The partner's own subtree gets an INDEPENDENT layout rooted at its
        // new position -- not a rigid drag of its old one, which would land
        // a deep subtree's descendants on top of active's OTHER, unrelated
        // branches (spacing was computed assuming the partner stayed one
        // row below active, not beside it). BUT: a coreq partner often
        // shares most of its own foundation with active's own tree (e.g. a
        // partner two courses share nearly the same prereq chain) -- for
        // any node already placed by active's own down/up fan, that
        // placement wins and is left untouched, so shared requirements stay
        // correctly attributed to active rather than getting silently
        // re-centered around the partner. Only nodes genuinely exclusive to
        // the partner's own subtree get this fresh layout.
        const partners = [...(s.coreqOf.get(active) ?? [])].sort();
        partners.forEach((id, i) => {
          const side = i % 2 === 0 ? 1 : -1;
          const rank = Math.ceil((i + 1) / 2);
          const newPos = { x: anchor.x + side * rank * COREQ_GAP, y: anchor.y };
          localTarget.set(id, newPos);
          const partnerDown = bfsTree(id, s.prereqsOf);
          const partnerUp = bfsTree(id, s.dependentsOf);
          for (const [sid, p] of placeFan(newPos, partnerDown, id, 1)) {
            if (sid !== active && !localTarget.has(sid)) { localTarget.set(sid, p); lit.add(sid); }
          }
          for (const [sid, p] of placeFan(newPos, partnerUp, id, -1)) {
            if (sid !== active && !localTarget.has(sid)) { localTarget.set(sid, p); lit.add(sid); }
          }
        });
      }
      litRef.current = lit;

      const targetOf = (id: string): Pos =>
        (active && localTarget.has(id)) ? localTarget.get(id)! : globalWorldOf(id, s.effectiveMaxTier, xMin, xRange);

      for (const c of s.visible) {
        const t = targetOf(c.id);
        const cur = animPos.current.get(c.id) ?? t;
        animPos.current.set(c.id, {
          x: cur.x + (t.x - cur.x) * LERP,
          y: cur.y + (t.y - cur.y) * LERP,
        });
      }
      const posOf = (id: string): Pos => animPos.current.get(id) ?? globalWorldOf(id, s.effectiveMaxTier, xMin, xRange);

      // Unified relevance test: while searching, a node counts only if it
      // also matches the query -- including while focused, where it must be
      // BOTH in the lit (focused) set AND match the search, so typing while
      // pinned narrows within that context instead of being ignored.
      const passesFilter = (id: string) => {
        if (active !== null) {
          return id === active || (lit.has(id) && (s.matches === null || s.matches.has(id)));
        }
        if (s.matches !== null) return s.matches.has(id);
        return true;
      };
      const dimmed = (id: string) => !passesFilter(id);
      const nodeOpacity = (id: string) => {
        if (!passesFilter(id)) return DIM_FLOOR;
        if (active === null) return 1;
        if (id === active) return 1;
        if (down!.dist.has(id)) return depthOpacity(down!.dist.get(id)!);
        if (up!.dist.has(id)) return depthOpacity(up!.dist.get(id)!);
        return DIM_FLOOR;
      };

      ctx.fillStyle = '#0b0b10';
      ctx.fillRect(0, 0, s.size.w, s.size.h);

      ctx.save();
      ctx.translate(s.camera.x, s.camera.y);
      ctx.scale(s.camera.scale, s.camera.scale);

      ctx.lineWidth = 1 / s.camera.scale;
      for (const c of s.visible) {
        const to = posOf(c.id);
        for (const r of s.prereqsOf.get(c.id) ?? []) {
          const from = posOf(r);
          // While focused, only actual TREE edges render. Two sibling
          // courses can genuinely share a prereq (e.g. CS 109 and CS 112
          // both require the same MATH options) -- the BFS tree only picks
          // one of them as that prereq's parent, but the OTHER real edge
          // still exists in prereqsOf and would otherwise fall through to
          // default gray styling (both endpoints are individually lit, just
          // via different paths), reading as a stray unexplained line. Only
          // drawing tree-membership edges shows one clean path per node.
          let stroke = '#8a8a96', alpha = active === null ? 0.16 : 0;
          if (active !== null && down!.children.get(c.id)?.includes(r)) {
            stroke = '#6fb2e0'; alpha = depthOpacity(down!.dist.get(r)!);
          } else if (active !== null && up!.children.get(r)?.includes(c.id)) {
            stroke = '#e0a15a'; alpha = depthOpacity(up!.dist.get(c.id)!);
          }
          if (!passesFilter(c.id) || !passesFilter(r)) alpha = active !== null ? 0 : DIM_FLOOR;
          // recommended (advisory) edges get the SAME color/positioning as
          // any other connection -- dashed is the only identifier that
          // distinguishes "you may want this" from "you must have this"
          const isRecommended = s.recommendedEdge.has(`${r}>${c.id}`);
          ctx.setLineDash(isRecommended ? [5, 4] : []);
          ctx.strokeStyle = stroke;
          ctx.globalAlpha = alpha;
          ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
        }
      }
      ctx.setLineDash([]);

      // AND/OR boxes for the active course's own direct prereq expression
      if (active) {
        const activeCourse = s.byId.get(active);
        if (activeCourse?.prereq && activeCourse.prereq.kind !== 'course'
            && activeCourse.prereq.kind !== 'condition') {
          const boxes: BoxInstr[] = [];
          collectBoxes(activeCourse.prereq, false, (id) => animPos.current.get(id), boxes);
          ctx.lineWidth = 1.2 / s.camera.scale;
          ctx.strokeStyle = '#9a9aa4';
          ctx.globalAlpha = 0.85;
          for (const b of boxes) {
            ctx.setLineDash(b.dashed ? [6, 5] : []);
            const rx = Math.min(10, (b.x1 - b.x0) / 4, (b.y1 - b.y0) / 4);
            ctx.beginPath();
            ctx.roundRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, rx);
            ctx.stroke();
          }
          ctx.setLineDash([]);
        }
      }

      for (const c of s.visible) {
        const p = posOf(c.id);
        ctx.globalAlpha = nodeOpacity(c.id);
        ctx.fillStyle = DEPT_COLOR[deptOf(c.id)];
        const r = (c.id === s.selected ? 7 : c.id === s.hovered ? 6 : 4) / Math.sqrt(s.camera.scale);
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      }

      ctx.font = `${10 / s.camera.scale}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      const wantsLabel = active !== null
        ? s.visible.filter((c) => lit.has(c.id))
        : s.matches ? s.visible.filter((c) => s.matches!.has(c.id)) : [];
      // row key: when active, group by side+hop-distance (matches the new
      // visual bands); otherwise fall back to the global tier as before
      const rowKeyOf = (id: string): string => {
        if (active && lit.has(id)) {
          if (id === active) return 'active';
          if (down!.dist.has(id)) return `d${down!.dist.get(id)}`;
          return `u${up!.dist.get(id)}`;
        }
        return `t${TIERS.get(id) ?? 0}`;
      };
      const byRow = new Map<string, typeof wantsLabel>();
      for (const c of wantsLabel) byRow.set(rowKeyOf(c.id), [...(byRow.get(rowKeyOf(c.id)) ?? []), c]);
      const gap = 6 / s.camera.scale;
      const laneHeight = 13 / s.camera.scale;
      const maxLanes = 4;
      for (const row of byRow.values()) {
        row.sort((a, b) => posOf(a.id).x - posOf(b.id).x);
        const laneLastRight = new Array(maxLanes).fill(-Infinity);
        for (const c of row) {
          const p = posOf(c.id);
          const w = ctx.measureText(c.id).width;
          let lane = c.id === active ? 0 : -1;
          if (lane === -1) {
            for (let i = 0; i < maxLanes; i++) {
              if (p.x - w / 2 >= laneLastRight[i] + gap) { lane = i; break; }
            }
          }
          if (lane === -1) continue;
          laneLastRight[lane] = Math.max(laneLastRight[lane], p.x + w / 2);

          const r = (c.id === s.selected ? 7 : c.id === s.hovered ? 6 : 4) / Math.sqrt(s.camera.scale);
          const ty = p.y - r - 4 / s.camera.scale - lane * laneHeight;
          ctx.globalAlpha = nodeOpacity(c.id);
          if (lane > 0) {
            ctx.strokeStyle = '#4a4a54';
            ctx.lineWidth = 1 / s.camera.scale;
            ctx.beginPath(); ctx.moveTo(p.x, p.y - r); ctx.lineTo(p.x, ty + 3 / s.camera.scale); ctx.stroke();
          }
          ctx.fillStyle = '#e6e6ee';
          ctx.fillText(c.id, p.x, ty);
        }
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toWorld = (sx: number, sy: number, cam: Camera) => ({
    x: (sx - cam.x) / cam.scale,
    y: (sy - cam.y) / cam.scale,
  });

  // `restrict`: hovering while a course is pinned can only land on the
  // pinned course's related (lit) set, not the dimmed rest of the graph.
  // Clicking stays unrestricted there so you can still re-pin elsewhere or
  // click empty space to release the pin. A search query is a separate,
  // stronger restriction that applies to BOTH hover and click regardless of
  // pin state -- you can only interact with courses currently on screen as
  // matches, combined (AND) with the pin restriction when both are active.
  const pickAt = (sx: number, sy: number, restrict: boolean): string | null => {
    if (!camera) return null;
    const w = toWorld(sx, sy, camera);
    const threshold = 12 / camera.scale;
    const limitedToLit = restrict && selected !== null;
    const [xMin, xRange] = xRangeOf(visible);
    let best: string | null = null, bestD = threshold;
    for (const c of filteredVisible) {
      if (limitedToLit && !litRef.current.has(c.id)) continue;
      if (matches !== null && !matches.has(c.id)) continue;
      const p = animPos.current.get(c.id) ?? globalWorldOf(c.id, effectiveMaxTier, xMin, xRange);
      const d = Math.hypot(p.x - w.x, p.y - w.y);
      if (d < bestD) { bestD = d; best = c.id; }
    }
    return best;
  };

  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const onDown = (ev: React.MouseEvent) => {
    drag.current = { x: ev.clientX, y: ev.clientY, moved: false };
  };
  const onMove = (ev: React.MouseEvent) => {
    setMouse({ x: ev.clientX, y: ev.clientY });
    if (drag.current && camera) {
      const dx = ev.clientX - drag.current.x, dy = ev.clientY - drag.current.y;
      if (Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) drag.current.moved = true;
      if (drag.current.moved) {
        setCamera(clampCamera({ ...camera, x: camera.x + dx, y: camera.y + dy }, size.w, size.h));
        drag.current = { x: ev.clientX, y: ev.clientY, moved: true };
        setHovered(null);
        return;
      }
    }
    const rect = ref.current!.getBoundingClientRect();
    setHovered(pickAt(ev.clientX - rect.left, ev.clientY - rect.top, true));
  };
  const onUp = (ev: React.MouseEvent) => {
    if (drag.current && !drag.current.moved) {
      const rect = ref.current!.getBoundingClientRect();
      setSelected(pickAt(ev.clientX - rect.left, ev.clientY - rect.top, false));
    }
    drag.current = null;
  };
  const onWheel = (ev: React.WheelEvent) => {
    if (!camera) return;
    ev.preventDefault();
    const rect = ref.current!.getBoundingClientRect();
    const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
    const before = toWorld(sx, sy, camera);
    const factor = Math.exp(-ev.deltaY * 0.0016);
    const fit = fitScale(size.w, size.h);
    const newScale = Math.min(Math.max(camera.scale * factor, fit), fit * MAX_ZOOM_MULT);
    const next = { scale: newScale, x: sx - before.x * newScale, y: sy - before.y * newScale };
    setCamera(clampCamera(next, size.w, size.h));
  };

  // tooltip content follows the live hover even while a course is pinned;
  // only the graph's layout/highlighting stays locked to the pinned course
  // (that's `active` inside the render loop, computed as selected ?? hovered)
  const course: Course | undefined =
    (hovered ?? selected) ? byId.get((hovered ?? selected)!) : undefined;

  const tooltipRef = useRef<HTMLDivElement>(null);
  const [tipPos, setTipPos] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    if (!course || !tooltipRef.current) return;
    const rect = tooltipRef.current.getBoundingClientRect();
    let left = mouse.x + 14;
    let top = mouse.y + 14;
    if (left + rect.width > window.innerWidth - 8) left = mouse.x - 14 - rect.width;
    if (top + rect.height > window.innerHeight - 8) top = mouse.y - 14 - rect.height;
    left = Math.max(8, left);
    top = Math.max(8, top);
    setTipPos({ left, top });
  }, [course, mouse]);

  return (
    <div style={{ position: 'relative' }}>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="search courses..."
        style={{
          position: 'fixed', top: 14, left: 14, zIndex: 10,
          background: '#16161e', border: '1px solid #34343e', borderRadius: 8,
          padding: '7px 12px', color: '#e6e6ee', fontSize: 13, width: 220,
          outline: 'none', fontFamily: 'system-ui, sans-serif',
        }}
      />
      <label style={{
        position: 'fixed', top: 56, left: 14, zIndex: 10,
        background: '#16161e', border: '1px solid #34343e', borderRadius: 8,
        padding: '6px 12px', color: '#e6e6ee', fontSize: 12.5,
        fontFamily: 'system-ui, sans-serif', display: 'flex', alignItems: 'center',
        gap: 6, cursor: 'pointer', userSelect: 'none',
      }}>
        <input type="checkbox" checked={showGrad} onChange={(e) => setShowGrad(e.target.checked)} />
        show graduate (500+) courses
      </label>
      <div style={{
        position: 'fixed', top: 98, left: 14, zIndex: 10,
        background: '#16161e', border: '1px solid #34343e', borderRadius: 8,
        padding: '8px 12px', color: '#e6e6ee', fontSize: 12,
        fontFamily: 'system-ui, sans-serif', width: 220,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span>immediate relatives</span>
          <span style={{ color: '#8a8a94' }}>
            {relFilter >= 1 ? 'all' : `\u2264 ${Math.round(relFilter * maxDegree)}`}
          </span>
        </div>
        <input
          type="range" min={0} max={1} step={0.01} value={relFilter}
          onChange={(e) => setRelFilter(parseFloat(e.target.value))}
          style={{ width: '100%' }}
        />
      </div>
      <div style={{
        position: 'fixed', bottom: 14, left: 14, zIndex: 10, color: '#8a8a94',
        fontSize: 11, fontFamily: 'system-ui, sans-serif', pointerEvents: 'none',
      }}>
        blue = requires (any depth) · amber = unlocks (any depth) · dashed = recommended · fainter = farther away
      </div>
      <canvas
        ref={ref}
        onMouseDown={onDown}
        onMouseMove={onMove}
        onMouseUp={onUp}
        onMouseLeave={() => { setHovered(null); drag.current = null; }}
        onWheel={onWheel}
        style={{ display: 'block', background: '#0b0b10', cursor: 'grab' }}
      />
      {course && (
        <div ref={tooltipRef} style={{
          position: 'fixed', left: tipPos.left, top: tipPos.top,
          background: 'rgba(22,22,30,0.5)', border: '1px solid #34343e', borderRadius: 8,
          padding: '8px 12px', color: '#e6e6ee', fontFamily: 'system-ui, sans-serif',
          fontSize: 12, pointerEvents: 'none', maxWidth: 320, backdropFilter: 'blur(3px)',
        }}>
          <div style={{ fontWeight: 700 }}>{course.id}</div>
          {Object.entries(course)
            .filter(([k, v]) => k !== 'id' && k !== 'prereq'
              && (typeof v === 'string' || typeof v === 'number'))
            .map(([k, v]) => (
              <div key={k} style={{ color: '#a8a8b4', marginTop: 2 }}>
                {k === 'title' ? String(v) : `${k}: ${v}`}
              </div>
            ))}
          {course.prereq && (
            <div style={{ marginTop: 6 }}>
              <div style={{ color: '#7f7f8a', fontSize: 10, textTransform: 'uppercase' }}>Requires</div>
              {exprLines(course.prereq).map((line, i) => (
                <div key={i} style={{ marginTop: 1 }}>{line}</div>
              ))}
            </div>
          )}
          {(coreqOf.get(course.id)?.size ?? 0) > 0 && (
            <div style={{ marginTop: 6 }}>
              <div style={{ color: '#7f7f8a', fontSize: 10, textTransform: 'uppercase' }}>Corequisites</div>
              <div style={{ color: '#a8a8b4' }}>
                {[...(coreqOf.get(course.id) ?? [])].sort().join(', ')}
              </div>
            </div>
          )}
          {(recommendedIds.get(course.id) ?? []).length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div style={{ color: '#7f7f8a', fontSize: 10, textTransform: 'uppercase' }}>Recommended</div>
              <div style={{ color: '#a8a8b4' }}>
                {(recommendedIds.get(course.id) ?? []).join(', ')}
              </div>
            </div>
          )}
          {(dependentsOf.get(course.id) ?? []).length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div style={{ color: '#7f7f8a', fontSize: 10, textTransform: 'uppercase' }}>Unlocks</div>
              <div style={{ color: '#a8a8b4' }}>
                {(dependentsOf.get(course.id) ?? []).slice(0, 10).join(', ')}
                {(dependentsOf.get(course.id) ?? []).length > 10 &&
                  ` +${(dependentsOf.get(course.id) ?? []).length - 10} more`}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}