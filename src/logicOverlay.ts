import type { Expr } from './parse';

export type Point = { x: number; y: number };
export type LogicOperator = 'and' | 'or' | 'neutral';

export interface LogicEdge {
  from: Point;
  to: Point;
  operator: LogicOperator;
}

export interface LogicJunction {
  id: string;
  point: Point;
  operator: 'and' | 'or';
}

export interface LogicTerminal {
  id: string;
  point: Point;
  kind: 'condition' | 'dangling';
  label: string;
}

export interface LogicOverlay {
  targetCourseId: string;
  edges: LogicEdge[];
  junctions: LogicJunction[];
  terminals: LogicTerminal[];
}

interface BuildOptions {
  targetCourseId: string;
  expr: Expr;
  target: Point;
  coursePoint: (id: string) => Point | undefined;
  width: number;
  height: number;
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function maxInternalDepth(expr: Expr): number {
  if (expr.kind === 'course' || expr.kind === 'condition') return -1;
  return 1 + Math.max(-1, ...expr.of.map(maxInternalDepth));
}

function fallbackTerminalPoint(
  target: Point,
  key: string,
  width: number,
  height: number,
): Point {
  const h = hash(key);
  const horizontal = ((h % 1000) / 999 - 0.5) * 240;
  const vertical = 85 + ((Math.floor(h / 1000) % 1000) / 999) * 90;
  return {
    x: clamp(target.x + horizontal, 24, width - 24),
    y: clamp(target.y + vertical, 24, height - 24),
  };
}

/**
 * Converts one prerequisite AST into an edge-routing overlay.
 *
 * Every internal AND/OR expression becomes a virtual junction. The operator is
 * carried by the branches entering that junction:
 *   - children -> AND junction: solid
 *   - children -> OR junction: dashed
 *
 * The final root-junction -> course segment is neutral because the root's
 * operator has already been expressed by its incoming branches.
 */
export function buildLogicOverlay(options: BuildOptions): LogicOverlay {
  const {
    targetCourseId,
    expr,
    target,
    coursePoint,
    width,
    height,
  } = options;

  const edges: LogicEdge[] = [];
  const junctions: LogicJunction[] = [];
  const terminals: LogicTerminal[] = [];
  const deepestInternal = Math.max(0, maxInternalDepth(expr));

  function visit(node: Expr, depth: number, path: string): Point {
    if (node.kind === 'course') {
      const known = coursePoint(node.id);
      if (known) return known;

      const point = fallbackTerminalPoint(
        target,
        `${targetCourseId}:${path}:${node.id}`,
        width,
        height,
      );
      terminals.push({
        id: `${targetCourseId}:${path}`,
        point,
        kind: 'dangling',
        label: node.id,
      });
      return point;
    }

    if (node.kind === 'condition') {
      const point = fallbackTerminalPoint(
        target,
        `${targetCourseId}:${path}:${node.text}`,
        width,
        height,
      );
      terminals.push({
        id: `${targetCourseId}:${path}`,
        point,
        kind: 'condition',
        label: node.text,
      });
      return point;
    }

    const childPoints = node.of.map((child, index) =>
      visit(child, depth + 1, `${path}.${index}`));

    const centroid = {
      x: childPoints.reduce((sum, p) => sum + p.x, 0) / childPoints.length,
      y: childPoints.reduce((sum, p) => sum + p.y, 0) / childPoints.length,
    };

    // Root junctions sit closest to the target. Deeper junctions remain nearer
    // their leaves. This preserves the existing course positions while making
    // the expression converge toward the inspected/target course.
    const depthRatio = deepestInternal === 0 ? 0 : depth / deepestInternal;
    const towardTarget = 0.72 - 0.32 * depthRatio;
    const jitter = ((hash(`${targetCourseId}:${path}`) % 101) - 50) * 0.06;
    const point = {
      x: clamp(
        centroid.x + (target.x - centroid.x) * towardTarget + jitter,
        18,
        width - 18,
      ),
      y: clamp(
        centroid.y + (target.y - centroid.y) * towardTarget,
        18,
        height - 18,
      ),
    };

    junctions.push({
      id: `${targetCourseId}:${path}`,
      point,
      operator: node.kind,
    });

    for (const childPoint of childPoints) {
      edges.push({
        from: childPoint,
        to: point,
        operator: node.kind,
      });
    }

    return point;
  }

  const rootPoint = visit(expr, 0, 'root');
  edges.push({ from: rootPoint, to: target, operator: 'neutral' });

  return { targetCourseId, edges, junctions, terminals };
}
