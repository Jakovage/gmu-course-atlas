import { useEffect, useMemo, useRef, useState } from 'react';
import { CATALOG, type Course } from './catalog';
import { TIERS, MAX_TIER } from './tiers';
import { POSITIONS } from './positions';
import { DEPT_COLOR, deptOf } from './colors';
import type { Expr } from './parse';
import { exprLines } from './format';
import {
  buildLogicOverlay,
  type LogicOverlay,
  type Point,
} from './logicOverlay';

const PAD = 60;
const MIN_ZOOM = 0.45;
const MAX_ZOOM = 4;
const DRAG_THRESHOLD = 4;

type RenderMode = 'connectivity' | 'inspect' | 'global';
type Camera = { x: number; y: number; scale: number };
type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
};

function allRefs(e: Expr | null): string[] {
  if (!e) return [];
  if (e.kind === 'course') return [e.id];
  if (e.kind === 'condition') return [];
  return e.of.flatMap(allRefs);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function drawLogicOverlay(
  ctx: CanvasRenderingContext2D,
  overlay: LogicOverlay,
  color: string,
  alpha: number,
  showTerminalLabels: boolean,
) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.globalAlpha = alpha;

  for (const edge of overlay.edges) {
    ctx.setLineDash(edge.operator === 'or' ? [7, 5] : []);
    ctx.lineWidth = edge.operator === 'neutral' ? 1.4 : 1.7;
    ctx.beginPath();
    ctx.moveTo(edge.from.x, edge.from.y);
    ctx.lineTo(edge.to.x, edge.to.y);
    ctx.stroke();
  }

  ctx.setLineDash([]);
  for (const junction of overlay.junctions) {
    // This is only a routing point, not a graph/course node.
    ctx.beginPath();
    ctx.arc(junction.point.x, junction.point.y, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const terminal of overlay.terminals) {
    ctx.lineWidth = 1.2;
    if (terminal.kind === 'condition') {
      ctx.fillRect(terminal.point.x - 2.5, terminal.point.y - 2.5, 5, 5);
    } else {
      ctx.beginPath();
      ctx.arc(terminal.point.x, terminal.point.y, 3.2, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (showTerminalLabels) {
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(terminal.label, terminal.point.x, terminal.point.y - 8);
    }
  }

  ctx.restore();
}

export default function Galaxy() {
  const ref = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [mouse, setMouse] = useState({ x: 0, y: 0 });
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<RenderMode>('connectivity');
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 1 });
  const [isPanning, setIsPanning] = useState(false);
  const [viewport, setViewport] = useState({
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  });

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return new Set(CATALOG
      .filter((c) => c.id.toLowerCase().includes(q)
        || String(c.title ?? '').toLowerCase().includes(q))
      .map((c) => c.id));
  }, [query]);

  // Flat adjacency remains useful for connectivity mode, search, and hover.
  const { byId, prereqsOf, dependentsOf } = useMemo(() => {
    const known = new Set(CATALOG.map((c) => c.id));
    const byId = new Map(CATALOG.map((c) => [c.id, c]));
    const prereqsOf = new Map<string, string[]>();
    const dependentsOf = new Map<string, string[]>(CATALOG.map((c) => [c.id, []]));

    for (const c of CATALOG) {
      const refs = [...new Set(allRefs(c.prereq))].filter((r) => known.has(r));
      prereqsOf.set(c.id, refs);
      for (const r of refs) dependentsOf.get(r)!.push(c.id);
    }

    return { byId, prereqsOf, dependentsOf };
  }, []);

  // These are world coordinates. Camera translation/scale is applied only at
  // draw time, so the underlying graph layout never changes while panning.
  const worldPoint = (id: string, W: number, H: number): Point => ({
    x: PAD + POSITIONS.get(id)! * (W - 2 * PAD),
    y: H - PAD - ((TIERS.get(id) ?? 0) / Math.max(MAX_TIER, 1)) * (H - 2 * PAD),
  });

  const screenPoint = (point: Point): Point => ({
    x: camera.x + point.x * camera.scale,
    y: camera.y + point.y * camera.scale,
  });

  useEffect(() => {
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const previousBodyOverflow = document.body.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';

    const onResize = () => setViewport({
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    });

    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      document.documentElement.style.overflow = previousHtmlOverflow;
      document.body.style.overflow = previousBodyOverflow;
    };
  }, []);

  useEffect(() => {
    const canvas = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    const W = viewport.width;
    const H = viewport.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;

    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const active = selected ?? hovered;
    const lit = new Set<string>();
    if (active) {
      lit.add(active);
      for (const r of prereqsOf.get(active) ?? []) lit.add(r);
      for (const d of dependentsOf.get(active) ?? []) lit.add(d);
    }

    const dimmed = (id: string) => {
      if (active !== null) return !lit.has(id);
      if (matches !== null) return !matches.has(id);
      return false;
    };

    ctx.fillStyle = '#0b0b10';
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.translate(camera.x, camera.y);
    ctx.scale(camera.scale, camera.scale);

    // Connectivity mode draws the existing flattened graph. Inspect mode keeps
    // that graph dimly in the background, except for the selected course's
    // direct prerequisite edges, which are replaced by the exact logic overlay.
    if (mode !== 'global') {
      ctx.lineWidth = 1;
      for (const c of CATALOG) {
        if (mode === 'inspect' && selected === c.id && c.prereq) continue;

        const to = worldPoint(c.id, W, H);
        for (const r of prereqsOf.get(c.id) ?? []) {
          const from = worldPoint(r, W, H);
          const touchesActive = active !== null && (c.id === active || r === active);
          ctx.strokeStyle = touchesActive ? '#d8d8e2' : '#8a8a96';

          if (mode === 'inspect') {
            ctx.globalAlpha = selected
              ? (touchesActive ? 0.12 : 0.018)
              : 0.10;
          } else {
            ctx.globalAlpha = active === null ? 0.18 : touchesActive ? 0.7 : 0.03;
          }

          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(from.x, from.y);
          ctx.lineTo(to.x, to.y);
          ctx.stroke();
        }
      }
    }

    const coursePoint = (id: string): Point | undefined =>
      byId.has(id) ? worldPoint(id, W, H) : undefined;

    if (mode === 'global') {
      // Every course's full prerequisite AST is routed through virtual
      // junctions. This is intentionally dense: it exists so the visual result
      // can be compared directly with the cleaner inspection-only mode.
      for (const c of CATALOG) {
        if (!c.prereq) continue;
        const overlay = buildLogicOverlay({
          targetCourseId: c.id,
          expr: c.prereq,
          target: worldPoint(c.id, W, H),
          coursePoint,
          width: W,
          height: H,
        });
        const isActiveTree = active === c.id;
        drawLogicOverlay(
          ctx,
          overlay,
          isActiveTree ? '#f2f2f7' : DEPT_COLOR[deptOf(c.id)],
          active === null ? 0.14 : isActiveTree ? 0.9 : 0.025,
          isActiveTree,
        );
      }
    }

    if (mode === 'inspect' && selected) {
      const selectedCourse = byId.get(selected);
      if (selectedCourse?.prereq) {
        const overlay = buildLogicOverlay({
          targetCourseId: selectedCourse.id,
          expr: selectedCourse.prereq,
          target: worldPoint(selectedCourse.id, W, H),
          coursePoint,
          width: W,
          height: H,
        });
        drawLogicOverlay(ctx, overlay, '#f2f2f7', 0.95, true);
      }
    }

    ctx.setLineDash([]);
    for (const c of CATALOG) {
      const p = worldPoint(c.id, W, H);
      ctx.globalAlpha = dimmed(c.id) ? 0.10 : 1;
      ctx.fillStyle = DEPT_COLOR[deptOf(c.id)];
      ctx.beginPath();
      ctx.arc(
        p.x,
        p.y,
        c.id === selected ? 7 : c.id === hovered ? 6 : 4,
        0,
        Math.PI * 2,
      );
      ctx.fill();

      const showLabel = (active !== null && lit.has(c.id))
        || (active === null && matches?.has(c.id));
      if (showLabel) {
        ctx.fillStyle = '#e6e6ee';
        ctx.font = '10px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(c.id, p.x, p.y - 9);
      }
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }, [
    hovered,
    selected,
    mode,
    camera,
    viewport,
    byId,
    prereqsOf,
    dependentsOf,
    matches,
  ]);

  const nearestCourse = (mx: number, my: number): string | null => {
    const W = viewport.width;
    const H = viewport.height;
    let best: string | null = null;
    let bestD = 12;

    for (const c of CATALOG) {
      const p = screenPoint(worldPoint(c.id, W, H));
      const d = Math.hypot(p.x - mx, p.y - my);
      if (d < bestD) {
        bestD = d;
        best = c.id;
      }
    }

    return best;
  };

  const canvasCoordinates = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = ref.current!.getBoundingClientRect();
    return {
      x: ev.clientX - rect.left,
      y: ev.clientY - rect.top,
    };
  };

  const onPointerDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    if (ev.button !== 0) return;

    const { x, y } = canvasCoordinates(ev);
    dragRef.current = {
      pointerId: ev.pointerId,
      startX: x,
      startY: y,
      lastX: x,
      lastY: y,
      moved: false,
    };
    ev.currentTarget.setPointerCapture(ev.pointerId);
    setIsPanning(true);
    ev.preventDefault();
  };

  const onPointerMove = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = canvasCoordinates(ev);
    setMouse({ x: ev.clientX, y: ev.clientY });

    const drag = dragRef.current;
    if (drag?.pointerId === ev.pointerId) {
      const totalDistance = Math.hypot(x - drag.startX, y - drag.startY);
      if (totalDistance >= DRAG_THRESHOLD) drag.moved = true;

      if (drag.moved) {
        const dx = x - drag.lastX;
        const dy = y - drag.lastY;
        setCamera((current) => ({
          ...current,
          x: current.x + dx,
          y: current.y + dy,
        }));
        setHovered(null);
      }

      drag.lastX = x;
      drag.lastY = y;
      return;
    }

    setHovered(nearestCourse(x, y));
  };

  const finishPointer = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== ev.pointerId) return;

    const { x, y } = canvasCoordinates(ev);
    if (!drag.moved) {
      const hit = nearestCourse(x, y);
      setSelected((current) => hit === current ? null : hit);
    }

    if (ev.currentTarget.hasPointerCapture(ev.pointerId)) {
      ev.currentTarget.releasePointerCapture(ev.pointerId);
    }
    dragRef.current = null;
    setIsPanning(false);
  };

  const onWheel = (ev: React.WheelEvent<HTMLCanvasElement>) => {
    ev.preventDefault();

    const rect = ref.current!.getBoundingClientRect();
    const mouseX = ev.clientX - rect.left;
    const mouseY = ev.clientY - rect.top;
    const zoomFactor = Math.exp(-ev.deltaY * 0.0015);

    setCamera((current) => {
      const nextScale = clamp(
        current.scale * zoomFactor,
        MIN_ZOOM,
        MAX_ZOOM,
      );

      if (nextScale === current.scale) return current;

      // Preserve the world coordinate currently beneath the pointer.
      const worldX = (mouseX - current.x) / current.scale;
      const worldY = (mouseY - current.y) / current.scale;

      return {
        scale: nextScale,
        x: mouseX - worldX * nextScale,
        y: mouseY - worldY * nextScale,
      };
    });
  };

  const resetView = () => setCamera({ x: 0, y: 0, scale: 1 });

  const course: Course | undefined = hovered ? byId.get(hovered) : undefined;

  const buttonStyle = (value: RenderMode): React.CSSProperties => ({
    background: mode === value ? '#34343e' : '#16161e',
    border: '1px solid #34343e',
    borderRadius: 6,
    padding: '6px 9px',
    color: '#e6e6ee',
    fontSize: 11,
    cursor: 'pointer',
  });

  const plainButtonStyle: React.CSSProperties = {
    background: '#16161e',
    border: '1px solid #34343e',
    borderRadius: 6,
    padding: '6px 9px',
    color: '#e6e6ee',
    fontSize: 11,
    cursor: 'pointer',
  };

  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden' }}>
      <div style={{
        position: 'fixed',
        top: 14,
        left: 14,
        zIndex: 10,
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        fontFamily: 'system-ui, sans-serif',
      }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search courses..."
          style={{
            background: '#16161e',
            border: '1px solid #34343e',
            borderRadius: 8,
            padding: '7px 12px',
            color: '#e6e6ee',
            fontSize: 13,
            width: 220,
            outline: 'none',
            fontFamily: 'system-ui, sans-serif',
          }}
        />
        <button style={buttonStyle('connectivity')} onClick={() => setMode('connectivity')}>
          Connectivity
        </button>
        <button style={buttonStyle('inspect')} onClick={() => setMode('inspect')}>
          Inspect Logic
        </button>
        <button style={buttonStyle('global')} onClick={() => setMode('global')}>
          Global Logic
        </button>
        <button style={plainButtonStyle} onClick={resetView}>
          Reset View
        </button>
      </div>

      <div style={{
        position: 'fixed',
        top: 52,
        left: 250,
        zIndex: 10,
        color: '#9999a6',
        font: '11px system-ui, sans-serif',
        pointerEvents: 'none',
      }}>
        Solid = AND · Dashed = OR · Drag to pan · Wheel to zoom · {Math.round(camera.scale * 100)}%
      </div>

      <canvas
        ref={ref}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={finishPointer}
        onPointerLeave={() => {
          if (!dragRef.current) setHovered(null);
        }}
        onWheel={onWheel}
        style={{
          display: 'block',
          background: '#0b0b10',
          cursor: isPanning ? 'grabbing' : 'grab',
          touchAction: 'none',
        }}
      />

      {course && !isPanning && (
        <div style={{
          position: 'fixed',
          left: mouse.x + 14,
          top: mouse.y + 14,
          background: '#16161e',
          border: '1px solid #34343e',
          borderRadius: 8,
          padding: '8px 12px',
          color: '#e6e6ee',
          fontFamily: 'system-ui, sans-serif',
          fontSize: 12,
          pointerEvents: 'none',
          maxWidth: 320,
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
              <div style={{ color: '#7f7f8a', fontSize: 10, textTransform: 'uppercase' }}>
                Requires
              </div>
              {exprLines(course.prereq).map((line, i) => (
                <div key={i} style={{ marginTop: 1 }}>{line}</div>
              ))}
            </div>
          )}
          {(dependentsOf.get(course.id) ?? []).length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div style={{ color: '#7f7f8a', fontSize: 10, textTransform: 'uppercase' }}>
                Unlocks
              </div>
              <div style={{ color: '#a8a8b4' }}>
                {(dependentsOf.get(course.id) ?? []).slice(0, 10).join(', ')}
                {(dependentsOf.get(course.id) ?? []).length > 10
                  && ` +${(dependentsOf.get(course.id) ?? []).length - 10} more`}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}