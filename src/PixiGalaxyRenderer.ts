// PIXI GALAXY RENDERER — rounded OR boxes + nearest-node hit testing
// + universal same-level arches + side-entry joined chevron arrows (v5)
import {
  Application,
  Circle,
  Container,
  FederatedPointerEvent,
  Graphics,
  GraphicsContext,
  Rectangle,
  Text,
  Ticker,
} from 'pixi.js';
import type { Course } from './catalog';
import { DEPT_COLOR, deptOf, pairColor } from './colors';
import {
  buildFocusLayout,
  collectBoxes,
  depthOpacity,
  DIM_FLOOR,
  DRAG_THRESHOLD,
  LERP,
  MAX_ZOOM_MULT,
  VH,
  VW,
  type FocusLayout,
  type GraphEdge,
  type Pos,
} from './galaxyLayout';

export interface GalaxySceneData {
  courses: Course[];
  byId: Map<string, Course>;
  prereqsOf: Map<string, string[]>;
  dependentsOf: Map<string, string[]>;
  coreqOf: Map<string, Set<string>>;
  recommendedEdge: Set<string>;
  graphEdges: GraphEdge[];
  globalPositions: Map<string, Pos>;
  matches: Set<string> | null;
  selected: string | null;
  hovered: string | null;
}

export interface GalaxyRendererCallbacks {
  onHover: (id: string | null, clientX: number, clientY: number) => void;
  onSelect: (id: string | null, clientX: number, clientY: number) => void;
  onPointerMove: (clientX: number, clientY: number) => void;
}

interface NodeRecord {
  course: Course;
  view: Graphics;
  target: Pos;
}

interface EdgeRecord {
  edge: GraphEdge;
  view: Graphics;
}

interface HighlightRecord {
  edge: GraphEdge;
  view: Graphics;
  color: number;
  alpha: number;
}

interface LabelRecord {
  id: string;
  text: Text;
  leader: Graphics;
  lane: number;
}

type CourseGraphic = Graphics & { courseId?: string };

function colorNumber(source: string): number {
  if (source.startsWith('#')) return Number.parseInt(source.slice(1), 16);

  const hsl = source.match(
    /^hsl\(\s*(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%\s*\)$/i,
  );
  if (!hsl) return 0x8a8a94;

  let h = Number(hsl[1]) % 360;
  if (h < 0) h += 360;
  const s = Number(hsl[2]) / 100;
  const l = Number(hsl[3]) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;

  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g] = [c, x];
  else if (h < 120) [r, g] = [x, c];
  else if (h < 180) [g, b] = [c, x];
  else if (h < 240) [g, b] = [x, c];
  else if (h < 300) [r, b] = [x, c];
  else [r, b] = [c, x];

  return (
    (Math.round((r + m) * 255) << 16)
    | (Math.round((g + m) * 255) << 8)
    | Math.round((b + m) * 255)
  );
}

interface EdgeCurve {
  from: Pos;
  c1: Pos;
  c2: Pos;
  to: Pos;
  arched: boolean;
}

function makeEdgeCurve(from: Pos, to: Pos, arched: boolean): EdgeCurve {
  if (arched) {
    const distance = Math.abs(to.x - from.x);
    const archDepth = Math.max(20, Math.min(80, distance * 0.25));
    const undersideY = Math.max(from.y, to.y) + archDepth;
    const horizontalDirection = Math.sign(to.x - from.x) || 1;

    // Wide, shallow arches enter more from the side; short, tight arches
    // enter more from underneath. This keeps the arrow aligned with the
    // visible sweep of the edge instead of forcing every arrow straight up.
    const sideAmount = Math.max(
      0.48,
      Math.min(0.82, distance / (distance + archDepth * 2.2)),
    );
    const riseAmount = Math.sqrt(1 - sideAmount * sideAmount);
    const entry = {
      x: horizontalDirection * sideAmount,
      y: -riseAmount,
    };

    // Stop at the destination node's lower-side boundary rather than its
    // center. The final control point is placed back along the same entry
    // vector, so the curve and arrow share one natural arrival direction.
    const nodeRadius = 4;
    const endpoint = {
      x: to.x - entry.x * nodeRadius,
      y: to.y - entry.y * nodeRadius,
    };
    const entryHandle = Math.max(
      14,
      Math.min(48, distance * 0.18 + archDepth * 0.35),
    );

    return {
      from,
      c1: { x: from.x, y: undersideY },
      c2: {
        x: endpoint.x - entry.x * entryHandle,
        y: endpoint.y - entry.y * entryHandle,
      },
      to: endpoint,
      arched: true,
    };
  }

  const midY = (from.y + to.y) / 2;
  return {
    from,
    c1: { x: from.x, y: midY },
    c2: { x: to.x, y: midY },
    to,
    arched: false,
  };
}

function bezierPoint(curve: EdgeCurve, t: number): Pos {
  const mt = 1 - t;
  return {
    x: mt ** 3 * curve.from.x
      + 3 * mt ** 2 * t * curve.c1.x
      + 3 * mt * t ** 2 * curve.c2.x
      + t ** 3 * curve.to.x,
    y: mt ** 3 * curve.from.y
      + 3 * mt ** 2 * t * curve.c1.y
      + 3 * mt * t ** 2 * curve.c2.y
      + t ** 3 * curve.to.y,
  };
}

function bezierTangent(curve: EdgeCurve, t: number): Pos {
  const mt = 1 - t;
  return {
    x: 3 * mt ** 2 * (curve.c1.x - curve.from.x)
      + 6 * mt * t * (curve.c2.x - curve.c1.x)
      + 3 * t ** 2 * (curve.to.x - curve.c2.x),
    y: 3 * mt ** 2 * (curve.c1.y - curve.from.y)
      + 6 * mt * t * (curve.c2.y - curve.c1.y)
      + 3 * t ** 2 * (curve.to.y - curve.c2.y),
  };
}

function drawDashedCurve(
  graphics: Graphics,
  curve: EdgeCurve,
  color: number,
): void {
  const samples = 64;
  const dash = 5;
  const gap = 4;
  const period = dash + gap;
  const points: Pos[] = [curve.from];
  const cumulative: number[] = [0];

  for (let i = 1; i <= samples; i++) {
    const point = bezierPoint(curve, i / samples);
    const previous = points[points.length - 1];
    points.push(point);
    cumulative.push(
      cumulative[cumulative.length - 1]
        + Math.hypot(point.x - previous.x, point.y - previous.y),
    );
  }

  // Phase the dash pattern backward from the endpoint so the final visible
  // dash always reaches the arrow's notch instead of ending in a gap.
  const total = cumulative[cumulative.length - 1];
  graphics.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    const distanceFromEnd = total - cumulative[i];
    if (distanceFromEnd % period < dash) {
      graphics.lineTo(points[i].x, points[i].y);
    } else {
      graphics.moveTo(points[i].x, points[i].y);
    }
  }
  graphics.stroke({ color, pixelLine: true });
}

interface ArcArrowGeometry {
  tip: Pos;
  upperBack: Pos;
  notch: Pos;
  lowerBack: Pos;
}

function arcArrowGeometry(curve: EdgeCurve): ArcArrowGeometry {
  const tip = curve.to;
  const tangent = bezierTangent(curve, 1);
  const magnitude = Math.hypot(tangent.x, tangent.y) || 1;
  const ux = tangent.x / magnitude;
  const uy = tangent.y / magnitude;
  const nx = -uy;
  const ny = ux;

  // Half the previous arrow size.
  const length = 5;
  const halfSpan = 2.75;
  const notchDepth = length * 0.46;
  const backX = tip.x - ux * length;
  const backY = tip.y - uy * length;

  return {
    tip,
    upperBack: {
      x: backX + nx * halfSpan,
      y: backY + ny * halfSpan,
    },
    notch: {
      x: tip.x - ux * notchDepth,
      y: tip.y - uy * notchDepth,
    },
    lowerBack: {
      x: backX - nx * halfSpan,
      y: backY - ny * halfSpan,
    },
  };
}

function drawArcArrow(
  graphics: Graphics,
  arrow: ArcArrowGeometry,
  color: number,
): void {
  graphics
    .moveTo(arrow.tip.x, arrow.tip.y)
    .lineTo(arrow.upperBack.x, arrow.upperBack.y)
    .lineTo(arrow.notch.x, arrow.notch.y)
    .lineTo(arrow.lowerBack.x, arrow.lowerBack.y)
    .closePath()
    .fill(color);
}

function drawEdgeCurve(
  graphics: Graphics,
  from: Pos,
  to: Pos,
  color: number,
  recommended: boolean,
  arched: boolean,
): void {
  const curve = makeEdgeCurve(from, to, arched);
  const arrow = curve.arched ? arcArrowGeometry(curve) : null;

  // End the visible edge exactly at the chevron notch. The line no longer
  // continues beneath the translucent arrow, eliminating the darker overlap
  // that made the edge and arrow look like separate intersecting objects.
  const visibleCurve: EdgeCurve = arrow
    ? { ...curve, to: arrow.notch }
    : curve;

  if (recommended) {
    drawDashedCurve(graphics, visibleCurve, color);
  } else {
    graphics
      .moveTo(visibleCurve.from.x, visibleCurve.from.y)
      .bezierCurveTo(
        visibleCurve.c1.x,
        visibleCurve.c1.y,
        visibleCurve.c2.x,
        visibleCurve.c2.y,
        visibleCurve.to.x,
        visibleCurve.to.y,
      )
      .stroke({ color, pixelLine: true });
  }

  if (arrow) drawArcArrow(graphics, arrow, color);
}

function drawDashedPolyline(
  graphics: Graphics,
  points: Pos[],
  color: number,
  dash = 6,
  gap = 5,
): void {
  if (points.length < 2) return;
  const period = dash + gap;
  let travelled = 0;
  let previous = points[0];
  graphics.moveTo(previous.x, previous.y);

  for (let i = 1; i < points.length; i++) {
    const end = points[i];
    const dx = end.x - previous.x;
    const dy = end.y - previous.y;
    const length = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(length / 3));

    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      const point = { x: previous.x + dx * t, y: previous.y + dy * t };
      travelled += length / steps;
      if (travelled % period < dash) graphics.lineTo(point.x, point.y);
      else graphics.moveTo(point.x, point.y);
    }
    previous = end;
  }
  graphics.stroke({ color, pixelLine: true });
}


function roundedRectPolyline(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
): Pos[] {
  const width = Math.max(0, x1 - x0);
  const height = Math.max(0, y1 - y0);
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  if (r === 0) {
    return [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
      { x: x0, y: y0 },
    ];
  }

  const points: Pos[] = [{ x: x0 + r, y: y0 }, { x: x1 - r, y: y0 }];
  const arcSegments = 16;
  const appendArc = (cx: number, cy: number, start: number, end: number) => {
    for (let i = 1; i <= arcSegments; i++) {
      const angle = start + (end - start) * (i / arcSegments);
      points.push({ x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
    }
  };

  appendArc(x1 - r, y0 + r, -Math.PI / 2, 0);
  points.push({ x: x1, y: y1 - r });
  appendArc(x1 - r, y1 - r, 0, Math.PI / 2);
  points.push({ x: x0 + r, y: y1 });
  appendArc(x0 + r, y1 - r, Math.PI / 2, Math.PI);
  points.push({ x: x0, y: y0 + r });
  appendArc(x0 + r, y0 + r, Math.PI, Math.PI * 1.5);
  points.push({ ...points[0] });
  return points;
}

export class PixiGalaxyRenderer {
  private readonly host: HTMLDivElement;
  private readonly callbacks: GalaxyRendererCallbacks;
  private readonly app = new Application();

  private readonly world = new Container();
  private readonly baseEdgeLayer = new Container();
  private readonly highlightEdgeLayer = new Container();
  private readonly boxLayer = new Container();
  private readonly nodeLayer = new Container();
  private readonly leaderLayer = new Container();
  private readonly labelLayer = new Container();

  private readonly nodeContext = new GraphicsContext()
    .circle(0, 0, 4)
    .fill(0xffffff);

  private readonly nodes = new Map<string, NodeRecord>();
  private readonly edges = new Map<string, EdgeRecord>();
  private readonly edgesByNode = new Map<string, Set<string>>();
  private readonly highlights: HighlightRecord[] = [];
  private readonly labels = new Map<string, LabelRecord>();
  private readonly moving = new Set<string>();

  private data: GalaxySceneData | null = null;
  private focus: FocusLayout | null = null;
  private active: string | null = null;
  private hoveredOnCanvas: string | null = null;

  private camera = { x: 0, y: 0, scale: 1 };
  private drag: {
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    moved: boolean;
  } | null = null;

  private renderFrame = 0;
  private destroyed = false;

  private constructor(host: HTMLDivElement, callbacks: GalaxyRendererCallbacks) {
    this.host = host;
    this.callbacks = callbacks;
  }

  static async create(
    host: HTMLDivElement,
    callbacks: GalaxyRendererCallbacks,
  ): Promise<PixiGalaxyRenderer> {
    const renderer = new PixiGalaxyRenderer(host, callbacks);
    await renderer.initialize();
    return renderer;
  }

  private async initialize(): Promise<void> {
    await this.app.init({
      width: Math.max(1, this.host.clientWidth || window.innerWidth),
      height: Math.max(1, this.host.clientHeight || window.innerHeight),
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      antialias: true,
      background: '#0b0b10',
      preference: 'webgl',
      autoStart: false,
    });

    const canvas = this.app.canvas as HTMLCanvasElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.cursor = 'grab';
    canvas.style.touchAction = 'none';
    this.host.appendChild(canvas);

    this.baseEdgeLayer.eventMode = 'none';
    this.highlightEdgeLayer.eventMode = 'none';
    this.boxLayer.eventMode = 'none';
    this.leaderLayer.eventMode = 'none';
    this.labelLayer.eventMode = 'none';
    this.baseEdgeLayer.interactiveChildren = false;
    this.highlightEdgeLayer.interactiveChildren = false;
    this.boxLayer.interactiveChildren = false;
    this.leaderLayer.interactiveChildren = false;
    this.labelLayer.interactiveChildren = false;

    this.world.addChild(
      this.baseEdgeLayer,
      this.highlightEdgeLayer,
      this.boxLayer,
      this.nodeLayer,
      this.leaderLayer,
      this.labelLayer,
    );
    this.app.stage.addChild(this.world);
    this.app.stage.eventMode = 'static';
    this.updateStageHitArea();

    this.app.stage.on('pointerdown', this.handlePointerDown);
    this.app.stage.on('pointermove', this.handlePointerMove);
    this.app.stage.on('pointerup', this.handlePointerUp);
    this.app.stage.on('pointerupoutside', this.handlePointerUp);
    canvas.addEventListener('wheel', this.handleWheel, { passive: false });
    window.addEventListener('resize', this.handleResize);

    this.app.ticker.add(this.tick);
    this.resetCamera();
    this.requestRender();
  }

  setScene(data: GalaxySceneData): void {
    if (this.destroyed) return;

    const graphChanged = !this.data
      || this.data.courses !== data.courses
      || this.data.graphEdges !== data.graphEdges
      || this.data.globalPositions !== data.globalPositions;
    const previousActive = this.active;
    const previousSelected = this.data?.selected ?? null;
    const previousHovered = this.data?.hovered ?? null;
    const previousMatches = this.data?.matches ?? null;

    this.data = data;
    this.active = data.selected ?? data.hovered;

    if (graphChanged) this.rebuildGraph();

    if (graphChanged || previousActive !== this.active) {
      this.applyFocus();
    } else {
      if (previousMatches !== data.matches) {
        this.refreshBaseEdgeOpacity();
        this.rebuildLabels();
      }
      if (previousSelected !== data.selected || previousHovered !== data.hovered) {
        this.refreshNodeScales();
      }
      this.refreshNodeOpacity();
      this.refreshInteractivity();
      this.updateLabelPositions();
      this.requestRender();
    }
  }

  resetCamera(): void {
    if (this.destroyed) return;
    const width = this.app.screen.width || this.host.clientWidth || window.innerWidth;
    const height = this.app.screen.height || this.host.clientHeight || window.innerHeight;
    const fit = this.fitScale(width, height);
    this.camera = {
      scale: fit,
      x: (width - VW * fit) / 2,
      y: (height - VH * fit) / 2,
    };
    this.applyCamera();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.renderFrame);

    const canvas = this.app.canvas as HTMLCanvasElement;
    canvas.removeEventListener('wheel', this.handleWheel);
    window.removeEventListener('resize', this.handleResize);
    this.app.stage.off('pointerdown', this.handlePointerDown);
    this.app.stage.off('pointermove', this.handlePointerMove);
    this.app.stage.off('pointerup', this.handlePointerUp);
    this.app.stage.off('pointerupoutside', this.handlePointerUp);
    this.app.ticker.remove(this.tick);
    this.app.destroy(true);
    this.nodeContext.destroy();
  }

  private rebuildGraph(): void {
    if (!this.data) return;

    const oldPositions = new Map<string, Pos>();
    for (const [id, node] of this.nodes) {
      oldPositions.set(id, { x: node.view.x, y: node.view.y });
    }

    this.clearContainer(this.baseEdgeLayer);
    this.clearContainer(this.highlightEdgeLayer);
    this.clearContainer(this.boxLayer);
    this.clearContainer(this.nodeLayer);
    this.clearContainer(this.leaderLayer);
    this.clearContainer(this.labelLayer);
    this.nodes.clear();
    this.edges.clear();
    this.edgesByNode.clear();
    this.highlights.length = 0;
    this.labels.clear();
    this.moving.clear();
    this.focus = null;

    for (const course of this.data.courses) {
      const global = this.data.globalPositions.get(course.id);
      if (!global) continue;
      const start = oldPositions.get(course.id) ?? global;
      const view = new Graphics(this.nodeContext) as CourseGraphic;
      view.courseId = course.id;
      view.tint = colorNumber(DEPT_COLOR[deptOf(course.id)] ?? '#8a8a94');
      view.position.set(start.x, start.y);
      view.eventMode = 'none';
      this.nodeLayer.addChild(view);
      this.nodes.set(course.id, {
        course,
        view,
        target: { ...global },
      });
      if (Math.abs(start.x - global.x) > 0.02 || Math.abs(start.y - global.y) > 0.02) {
        this.moving.add(course.id);
      }
    }

    for (const edge of this.data.graphEdges) {
      if (!this.nodes.has(edge.from) || !this.nodes.has(edge.to)) continue;
      const key = this.edgeKey(edge);
      const view = new Graphics();
      view.eventMode = 'none';
      this.baseEdgeLayer.addChild(view);
      const record = { edge, view };
      this.edges.set(key, record);
      this.addEdgeAdjacency(edge.from, key);
      this.addEdgeAdjacency(edge.to, key);
      this.redrawBaseEdge(record);
    }

    this.refreshBaseEdgeOpacity();
  }

  private applyFocus(): void {
    if (!this.data) return;

    const previouslyAffected = this.focus?.lit ?? new Set<string>();
    const nextFocus = this.active
      ? buildFocusLayout({
          active: this.active,
          byId: this.data.byId,
          prereqsOf: this.data.prereqsOf,
          dependentsOf: this.data.dependentsOf,
          coreqOf: this.data.coreqOf,
          recommendedEdge: this.data.recommendedEdge,
          globalPositions: this.data.globalPositions,
        })
      : null;

    const affected = new Set<string>(previouslyAffected);
    if (nextFocus) {
      for (const id of nextFocus.lit) affected.add(id);
      for (const id of nextFocus.targets.keys()) affected.add(id);
    }

    this.focus = nextFocus;
    for (const id of affected) {
      const node = this.nodes.get(id);
      const global = this.data.globalPositions.get(id);
      if (!node || !global) continue;
      const target = nextFocus?.targets.get(id) ?? global;
      node.target = { ...target };
      if (Math.abs(node.view.x - target.x) > 0.02 || Math.abs(node.view.y - target.y) > 0.02) {
        this.moving.add(id);
      }
    }

    this.baseEdgeLayer.visible = !nextFocus;
    this.rebuildHighlights();
    this.refreshBaseEdgeOpacity();
    this.refreshNodeOpacity();
    this.refreshNodeScales();
    this.refreshInteractivity();
    this.rebuildLabels();
    this.updateBoxes();

    if (this.moving.size > 0) this.app.start();
    else this.requestRender();
  }

  private rebuildHighlights(): void {
    this.clearContainer(this.highlightEdgeLayer);
    this.highlights.length = 0;
    if (!this.focus) return;

    for (const edge of this.focus.edges) {
      let color = 0xe0a15a;
      let alpha = 1;
      if (this.focus.down.children.get(edge.to)?.includes(edge.from)) {
        color = 0x6fb2e0;
        alpha = depthOpacity(this.focus.down.dist.get(edge.from) ?? 1);
      } else if (this.focus.up.children.get(edge.from)?.includes(edge.to)) {
        color = 0xe0a15a;
        alpha = depthOpacity(this.focus.up.dist.get(edge.to) ?? 1);
      }

      const view = new Graphics();
      view.alpha = alpha;
      view.eventMode = 'none';
      this.highlightEdgeLayer.addChild(view);
      const record = { edge, view, color, alpha };
      this.highlights.push(record);
      this.redrawHighlight(record);
    }
  }

  private refreshNodeOpacity(): void {
    if (!this.data) return;
    for (const [id, node] of this.nodes) {
      node.view.alpha = this.nodeOpacity(id);
    }
    for (const label of this.labels.values()) {
      const alpha = this.nodeOpacity(label.id);
      label.text.alpha = alpha;
      label.leader.alpha = alpha;
    }
  }

  private refreshNodeScales(): void {
    if (!this.data) return;
    const worldScale = Math.max(this.camera.scale, 0.0001);

    for (const [id, node] of this.nodes) {
      const ratio = id === this.data.selected ? 7 / 4 : id === this.data.hovered ? 6 / 4 : 1;
      const localScale = ratio / Math.sqrt(worldScale);
      node.view.scale.set(localScale);
      node.view.hitArea = new Circle(0, 0, 12 / (localScale * worldScale));
    }
  }

  private refreshInteractivity(): void {
    if (!this.data) return;
    // Pointer selection is resolved manually by nearest screen-space
    // node center. Keeping node display objects non-interactive avoids Pixi's
    // display-order hit resolution when several enlarged hit circles overlap.
    for (const node of this.nodes.values()) node.view.eventMode = 'none';

    if (this.hoveredOnCanvas && !this.isInteractive(this.hoveredOnCanvas)) {
      this.hoveredOnCanvas = null;
      const point = this.lastClientPoint();
      this.callbacks.onHover(null, point.x, point.y);
    }
  }

  private refreshBaseEdgeOpacity(): void {
    if (!this.data) return;
    for (const record of this.edges.values()) {
      const { edge, view } = record;
      const matches = this.data.matches;
      const passes = !matches || (matches.has(edge.from) && matches.has(edge.to));
      view.alpha = passes ? (edge.recommended ? 0.045 : 0.09) : DIM_FLOOR;
    }
  }

  private rebuildLabels(): void {
    this.clearContainer(this.leaderLayer);
    this.clearContainer(this.labelLayer);
    this.labels.clear();
    if (!this.data) return;

    const ids = this.focus
      ? [...this.focus.lit]
      : this.data.matches
        ? [...this.data.matches]
        : [];

    for (const id of ids) {
      if (!this.nodes.has(id)) continue;
      const text = new Text({
        text: id,
        style: {
          fontFamily: 'system-ui, sans-serif',
          fontSize: 10,
          fill: 0xe6e6ee,
        },
        resolution: Math.min(window.devicePixelRatio || 1, 2),
      });
      text.anchor.set(0.5, 1);
      text.eventMode = 'none';
      const leader = new Graphics();
      leader.eventMode = 'none';
      this.leaderLayer.addChild(leader);
      this.labelLayer.addChild(text);
      this.labels.set(id, { id, text, leader, lane: 0 });
    }

    this.recomputeLabelLanes();
    this.updateLabelPositions();
  }

  private recomputeLabelLanes(): void {
    if (!this.data) return;
    const rows = new Map<string, LabelRecord[]>();

    for (const label of this.labels.values()) {
      let rowKey = 'global';
      if (this.focus) {
        if (label.id === this.focus.active) rowKey = 'active';
        else if (this.focus.down.dist.has(label.id)) rowKey = `d${this.focus.down.dist.get(label.id)}`;
        else if (this.focus.up.dist.has(label.id)) rowKey = `u${this.focus.up.dist.get(label.id)}`;
        else rowKey = 'other';
      }
      const row = rows.get(rowKey);
      if (row) row.push(label);
      else rows.set(rowKey, [label]);
    }

    const gap = 6;
    const maxLanes = 4;
    for (const row of rows.values()) {
      row.sort((a, b) => {
        const ax = this.nodes.get(a.id)?.target.x ?? 0;
        const bx = this.nodes.get(b.id)?.target.x ?? 0;
        return ax - bx;
      });
      const laneLastRight = new Array(maxLanes).fill(-Infinity);

      for (const label of row) {
        const target = this.nodes.get(label.id)?.target;
        if (!target) continue;
        const screenX = this.camera.x + target.x * this.camera.scale;
        const width = label.text.width;
        let lane = label.id === this.active ? 0 : -1;
        if (lane === -1) {
          for (let i = 0; i < maxLanes; i++) {
            if (screenX - width / 2 >= laneLastRight[i] + gap) {
              lane = i;
              break;
            }
          }
        }
        label.lane = lane;
        if (lane >= 0) {
          laneLastRight[lane] = Math.max(laneLastRight[lane], screenX + width / 2);
          label.text.visible = true;
        } else {
          label.text.visible = false;
          label.leader.visible = false;
        }
      }
    }
  }

  private updateLabelPositions(): void {
    const scale = Math.max(this.camera.scale, 0.0001);
    for (const label of this.labels.values()) {
      if (!label.text.visible) continue;
      const node = this.nodes.get(label.id);
      if (!node) continue;

      const ratio = this.data && label.id === this.data.selected
        ? 7 / 4
        : this.data && label.id === this.data.hovered
          ? 6 / 4
          : 1;
      const radiusScreen = 4 * Math.sqrt(scale) * ratio;
      const offsetWorld = (radiusScreen + 4 + label.lane * 13) / scale;
      const labelY = node.view.y - offsetWorld;

      label.text.scale.set(1 / scale);
      label.text.position.set(node.view.x, labelY);
      label.text.alpha = this.nodeOpacity(label.id);

      label.leader.clear();
      label.leader.visible = label.lane > 0;
      if (label.lane > 0) {
        label.leader
          .moveTo(node.view.x, node.view.y - radiusScreen / scale)
          .lineTo(node.view.x, labelY + 3 / scale)
          .stroke({ color: 0x4a4a54, pixelLine: true });
        label.leader.alpha = this.nodeOpacity(label.id);
      }
    }
  }

  private updateBoxes(): void {
    this.boxLayer.removeChildren().forEach((child) => child.destroy());
    if (!this.focus || !this.data) return;
    const course = this.data.byId.get(this.focus.active);
    const expr = course?.prereq;
    if (!expr || expr.kind === 'course' || expr.kind === 'condition') return;

    const boxes: import('./galaxyLayout').BoxInstr[] = [];
    collectBoxes(
      expr,
      false,
      (id) => {
        const node = this.nodes.get(id);
        return node ? { x: node.view.x, y: node.view.y } : undefined;
      },
      boxes,
    );

    for (const box of boxes) {
      const graphics = new Graphics();
      graphics.alpha = 0.85;
      graphics.eventMode = 'none';
      const radius = Math.min(10, (box.x1 - box.x0) / 4, (box.y1 - box.y0) / 4);
      if (box.dashed) {
        drawDashedPolyline(
          graphics,
          roundedRectPolyline(box.x0, box.y0, box.x1, box.y1, radius),
          0x9a9aa4,
        );
      } else {
        graphics
          .roundRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0, radius)
          .stroke({ color: 0x9a9aa4, pixelLine: true });
      }
      this.boxLayer.addChild(graphics);
    }
  }

  private redrawBaseEdge(record: EdgeRecord): void {
    const fromNode = this.nodes.get(record.edge.from);
    const toNode = this.nodes.get(record.edge.to);
    if (!fromNode || !toNode) return;
    const from = { x: fromNode.view.x, y: fromNode.view.y };
    const to = { x: toNode.view.x, y: toNode.view.y };
    const color = colorNumber(pairColor(deptOf(record.edge.from), deptOf(record.edge.to)));
    // Decide from TARGET rows rather than current animated positions. This
    // makes every same-level relationship arc immediately and consistently,
    // including dashed recommended corequisites while nodes are still moving.
    const arched = Math.abs(fromNode.target.y - toNode.target.y) < 1;
    record.view.clear();
    drawEdgeCurve(record.view, from, to, color, record.edge.recommended, arched);
  }

  private redrawHighlight(record: HighlightRecord): void {
    const fromNode = this.nodes.get(record.edge.from);
    const toNode = this.nodes.get(record.edge.to);
    if (!fromNode || !toNode) return;
    const from = { x: fromNode.view.x, y: fromNode.view.y };
    const to = { x: toNode.view.x, y: toNode.view.y };
    const arched = Math.abs(fromNode.target.y - toNode.target.y) < 1;
    record.view.clear();
    record.view.alpha = record.alpha;
    drawEdgeCurve(
      record.view,
      from,
      to,
      record.color,
      record.edge.recommended,
      arched,
    );
  }

  private readonly tick = (ticker: Ticker): void => {
    if (this.moving.size === 0) {
      this.app.stop();
      return;
    }

    const amount = 1 - Math.pow(1 - LERP, Math.max(0.25, ticker.deltaTime));
    const dirtyEdges = new Set<string>();
    let moved = false;

    for (const id of [...this.moving]) {
      const node = this.nodes.get(id);
      if (!node) {
        this.moving.delete(id);
        continue;
      }

      const dx = node.target.x - node.view.x;
      const dy = node.target.y - node.view.y;
      if (Math.abs(dx) <= 0.02 && Math.abs(dy) <= 0.02) {
        node.view.position.set(node.target.x, node.target.y);
        this.moving.delete(id);
      } else {
        node.view.position.set(node.view.x + dx * amount, node.view.y + dy * amount);
        moved = true;
      }

      for (const edgeKey of this.edgesByNode.get(id) ?? []) dirtyEdges.add(edgeKey);
    }

    for (const key of dirtyEdges) {
      const record = this.edges.get(key);
      if (record) this.redrawBaseEdge(record);
    }
    if (this.focus && moved) {
      for (const record of this.highlights) this.redrawHighlight(record);
    }

    this.updateLabelPositions();
    if (this.focus) this.updateBoxes();

    if (this.moving.size === 0) {
      this.recomputeLabelLanes();
      this.updateLabelPositions();
      this.updateBoxes();
      this.app.stop();
      this.requestRender();
    }
  };

  private nodeOpacity(id: string): number {
    if (!this.data) return 1;
    if (!this.passesFilter(id)) return DIM_FLOOR;
    if (!this.focus) return 1;
    if (id === this.focus.active) return 1;
    if (this.focus.down.dist.has(id)) return depthOpacity(this.focus.down.dist.get(id)!);
    if (this.focus.up.dist.has(id)) return depthOpacity(this.focus.up.dist.get(id)!);
    return DIM_FLOOR;
  }

  private passesFilter(id: string): boolean {
    if (!this.data) return false;
    if (this.focus) {
      return id === this.focus.active
        || (this.focus.lit.has(id) && (!this.data.matches || this.data.matches.has(id)));
    }
    return !this.data.matches || this.data.matches.has(id);
  }

  private isInteractive(id: string): boolean {
    if (!this.data) return false;
    if (this.data.selected) {
      return Boolean(this.focus?.lit.has(id))
        && (!this.data.matches || this.data.matches.has(id));
    }
    return !this.data.matches || this.data.matches.has(id);
  }

  private addEdgeAdjacency(id: string, key: string): void {
    const set = this.edgesByNode.get(id);
    if (set) set.add(key);
    else this.edgesByNode.set(id, new Set([key]));
  }

  private edgeKey(edge: GraphEdge): string {
    return `${edge.from}>${edge.to}`;
  }

  private fitScale(width: number, height: number): number {
    return Math.min(width / VW, height / VH) * 0.96;
  }

  private clampCamera(camera: { x: number; y: number; scale: number }) {
    const width = this.app.screen.width;
    const height = this.app.screen.height;
    const fit = this.fitScale(width, height);
    const scale = Math.min(Math.max(camera.scale, fit), fit * MAX_ZOOM_MULT);
    const contentWidth = VW * scale;
    const contentHeight = VH * scale;
    const clampAxis = (value: number, content: number, viewport: number) => {
      if (content <= viewport) return (viewport - content) / 2;
      return Math.min(0, Math.max(viewport - content, value));
    };
    return {
      scale,
      x: clampAxis(camera.x, contentWidth, width),
      y: clampAxis(camera.y, contentHeight, height),
    };
  }

  private applyCamera(): void {
    this.camera = this.clampCamera(this.camera);
    this.world.position.set(this.camera.x, this.camera.y);
    this.world.scale.set(this.camera.scale);
    this.refreshNodeScales();
    this.recomputeLabelLanes();
    this.updateLabelPositions();
    this.requestRender();
  }

  private updateStageHitArea(): void {
    this.app.stage.hitArea = new Rectangle(0, 0, this.app.screen.width, this.app.screen.height);
  }

  private requestRender(): void {
    if (this.destroyed || this.app.ticker.started) return;
    if (this.renderFrame) return;
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = 0;
      if (!this.destroyed) this.app.renderer.render(this.app.stage);
    });
  }

  private clearContainer(container: Container): void {
    for (const child of container.removeChildren()) child.destroy();
  }

  private pickCourseAt(screenX: number, screenY: number): string | null {
    if (!this.data) return null;

    const worldX = (screenX - this.camera.x) / this.camera.scale;
    const worldY = (screenY - this.camera.y) / this.camera.scale;
    let bestId: string | null = null;
    let bestDistanceSq = Infinity;

    for (const [id, node] of this.nodes) {
      if (!this.isInteractive(id)) continue;

      const dx = (node.view.x - worldX) * this.camera.scale;
      const dy = (node.view.y - worldY) * this.camera.scale;
      const distanceSq = dx * dx + dy * dy;

      const ratio = id === this.data.selected ? 7 / 4 : id === this.data.hovered ? 6 / 4 : 1;
      const visualRadius = 4 * ratio * Math.sqrt(Math.max(this.camera.scale, 0.0001));
      // Keep the target forgiving, but always resolve overlap by the
      // smallest screen-space center distance rather than display order.
      const hitRadius = Math.max(10, visualRadius + 3);

      if (distanceSq <= hitRadius * hitRadius && distanceSq < bestDistanceSq) {
        bestDistanceSq = distanceSq;
        bestId = id;
      }
    }

    return bestId;
  }

  private clientPoint(event: FederatedPointerEvent): { x: number; y: number } {
    const rect = (this.app.canvas as HTMLCanvasElement).getBoundingClientRect();
    return { x: rect.left + event.global.x, y: rect.top + event.global.y };
  }

  private lastClientPoint(): { x: number; y: number } {
    const rect = (this.app.canvas as HTMLCanvasElement).getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  }

  private readonly handlePointerDown = (event: FederatedPointerEvent): void => {
    this.drag = {
      startX: event.global.x,
      startY: event.global.y,
      lastX: event.global.x,
      lastY: event.global.y,
      moved: false,
    };
    (this.app.canvas as HTMLCanvasElement).style.cursor = 'grabbing';
  };

  private readonly handlePointerMove = (event: FederatedPointerEvent): void => {
    const client = this.clientPoint(event);
    this.callbacks.onPointerMove(client.x, client.y);

    if (this.drag) {
      const total = Math.abs(event.global.x - this.drag.startX)
        + Math.abs(event.global.y - this.drag.startY);
      if (total > DRAG_THRESHOLD) this.drag.moved = true;

      if (this.drag.moved) {
        const dx = event.global.x - this.drag.lastX;
        const dy = event.global.y - this.drag.lastY;
        this.drag.lastX = event.global.x;
        this.drag.lastY = event.global.y;
        this.camera.x += dx;
        this.camera.y += dy;
        this.camera = this.clampCamera(this.camera);
        this.world.position.set(this.camera.x, this.camera.y);
        if (this.hoveredOnCanvas) {
          this.hoveredOnCanvas = null;
          this.callbacks.onHover(null, client.x, client.y);
        }
        this.requestRender();
        return;
      }
    }

    const id = this.pickCourseAt(event.global.x, event.global.y);
    if (id !== this.hoveredOnCanvas) {
      this.hoveredOnCanvas = id;
      this.callbacks.onHover(id, client.x, client.y);
      (this.app.canvas as HTMLCanvasElement).style.cursor = id ? 'pointer' : 'grab';
    }
  };

  private readonly handlePointerUp = (event: FederatedPointerEvent): void => {
    const client = this.clientPoint(event);
    const moved = this.drag?.moved ?? false;
    this.drag = null;

    if (!moved) {
      const id = this.pickCourseAt(event.global.x, event.global.y);
      this.callbacks.onSelect(id, client.x, client.y);
    }

    (this.app.canvas as HTMLCanvasElement).style.cursor = this.hoveredOnCanvas ? 'pointer' : 'grab';
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const rect = (this.app.canvas as HTMLCanvasElement).getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    const before = {
      x: (sx - this.camera.x) / this.camera.scale,
      y: (sy - this.camera.y) / this.camera.scale,
    };
    const factor = Math.exp(-event.deltaY * 0.0016);
    const fit = this.fitScale(this.app.screen.width, this.app.screen.height);
    const scale = Math.min(
      Math.max(this.camera.scale * factor, fit),
      fit * MAX_ZOOM_MULT,
    );
    this.camera = this.clampCamera({
      scale,
      x: sx - before.x * scale,
      y: sy - before.y * scale,
    });
    this.applyCamera();
  };

  private readonly handleResize = (): void => {
    const width = Math.max(1, this.host.clientWidth || window.innerWidth);
    const height = Math.max(1, this.host.clientHeight || window.innerHeight);
    this.app.renderer.resize(width, height);
    this.updateStageHitArea();
    this.camera = this.clampCamera(this.camera);
    this.applyCamera();
  };
}