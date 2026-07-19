// Galaxy v4: pure connectivity (no logic overlay). Pan/zoom with clamped
// bounds: can't zoom out past fitting the whole graph, can't zoom in past a
// fixed ceiling, can't pan the content off-screen. Active course's edges are
// colored by direction: blue = this is one of its prereqs, amber = this is
// something it unlocks. Click pins the active course; Escape/empty-click
// unpins. Drag pans; click-without-drag selects.
import { useEffect, useMemo, useRef, useState } from 'react';
import { CATALOG, type Course } from './catalog';
import { TIERS, MAX_TIER } from './tiers';
import { POSITIONS } from './positions';
import { DEPT_COLOR, deptOf } from './colors';
import type { Expr } from './parse';
import { exprLines } from './format';

const VW = 1600, VH = 900, PAD = 70;   // fixed virtual canvas
const MAX_ZOOM_MULT = 8;
const DRAG_THRESHOLD = 4;              // px of movement before a click becomes a pan

function allRefs(e: Expr | null): string[] {
  if (!e) return [];
  if (e.kind === 'course') return [e.id];
  if (e.kind === 'condition') return [];
  return e.of.flatMap(allRefs);
}

interface Camera { x: number; y: number; scale: number }

export default function Galaxy() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [mouse, setMouse] = useState({ x: 0, y: 0 });
  const [query, setQuery] = useState('');
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [camera, setCamera] = useState<Camera | null>(null); // set once fit scale is known

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return new Set(CATALOG
      .filter((c) => c.id.toLowerCase().includes(q)
        || String(c.title ?? '').toLowerCase().includes(q))
      .map((c) => c.id));
  }, [query]);

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

  // world-space (virtual canvas) position, independent of window size or camera
  const worldOf = (id: string) => ({
    x: PAD + POSITIONS.get(id)! * (VW - 2 * PAD),
    y: VH - PAD - ((TIERS.get(id) ?? 0) / Math.max(MAX_TIER, 1)) * (VH - 2 * PAD),
  });

  const fitScale = (w: number, h: number) => Math.min(w / VW, h / VH) * 0.96;

  // clamp a candidate camera so the virtual canvas can never be zoomed out
  // past "whole graph fits" or panned so far that content leaves the screen
  function clampCamera(cam: Camera, w: number, h: number): Camera {
    const fit = fitScale(w, h);
    const scale = Math.min(Math.max(cam.scale, fit), fit * MAX_ZOOM_MULT);
    const contentW = VW * scale, contentH = VH * scale;
    const clampAxis = (t: number, content: number, viewport: number) => {
      if (content <= viewport) return (viewport - content) / 2; // center, no pan
      return Math.min(0, Math.max(viewport - content, t));      // standard clamp
    };
    return {
      scale,
      x: clampAxis(cam.x, contentW, w),
      y: clampAxis(cam.y, contentH, h),
    };
  }

  // init camera once, and refit/reclamp on resize
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelected(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!camera) return;
    const canvas = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    const { w: W, h: H } = size;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);

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

    ctx.lineWidth = 1 / camera.scale;
    for (const c of CATALOG) {
      const to = worldOf(c.id);
      for (const r of prereqsOf.get(c.id) ?? []) {
        const from = worldOf(r);
        let stroke = '#8a8a96', alpha = active === null ? 0.16 : 0.03;
        if (active !== null) {
          if (c.id === active) { stroke = '#6fb2e0'; alpha = 0.85; }        // r is a prereq of active
          else if (r === active) { stroke = '#e0a15a'; alpha = 0.85; }     // c is unlocked by active
        }
        ctx.strokeStyle = stroke;
        ctx.globalAlpha = alpha;
        ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
      }
    }

    for (const c of CATALOG) {
      const p = worldOf(c.id);
      ctx.globalAlpha = dimmed(c.id) ? 0.10 : 1;
      ctx.fillStyle = DEPT_COLOR[deptOf(c.id)];
      const r = (c.id === selected ? 7 : c.id === hovered ? 6 : 4) / Math.sqrt(camera.scale);
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      if ((active !== null && lit.has(c.id)) || (active === null && matches?.has(c.id))) {
        ctx.fillStyle = '#e6e6ee';
        ctx.font = `${10 / camera.scale}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(c.id, p.x, p.y - r - 4 / camera.scale);
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }, [hovered, selected, camera, size, byId, prereqsOf, dependentsOf, matches]);

  const toWorld = (sx: number, sy: number) => ({
    x: (sx - camera!.x) / camera!.scale,
    y: (sy - camera!.y) / camera!.scale,
  });

  const pickAt = (sx: number, sy: number): string | null => {
    if (!camera) return null;
    const w = toWorld(sx, sy);
    const threshold = 12 / camera.scale;
    let best: string | null = null, bestD = threshold;
    for (const c of CATALOG) {
      const p = worldOf(c.id);
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
        setCamera(clampCamera(
          { ...camera, x: camera.x + dx, y: camera.y + dy }, size.w, size.h,
        ));
        drag.current = { x: ev.clientX, y: ev.clientY, moved: true };
        setHovered(null);
        return;
      }
    }
    const rect = ref.current!.getBoundingClientRect();
    setHovered(pickAt(ev.clientX - rect.left, ev.clientY - rect.top));
  };
  const onUp = (ev: React.MouseEvent) => {
    if (drag.current && !drag.current.moved) {
      const rect = ref.current!.getBoundingClientRect();
      setSelected(pickAt(ev.clientX - rect.left, ev.clientY - rect.top));
    }
    drag.current = null;
  };
  const onWheel = (ev: React.WheelEvent) => {
    if (!camera) return;
    ev.preventDefault();
    const rect = ref.current!.getBoundingClientRect();
    const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
    const before = toWorld(sx, sy);
    const factor = Math.exp(-ev.deltaY * 0.0016);
    const fit = fitScale(size.w, size.h);
    const newScale = Math.min(Math.max(camera.scale * factor, fit), fit * MAX_ZOOM_MULT);
    // keep the world point under the cursor fixed on screen
    const next = { scale: newScale, x: sx - before.x * newScale, y: sy - before.y * newScale };
    setCamera(clampCamera(next, size.w, size.h));
  };

  const course: Course | undefined =
    (selected ?? hovered) ? byId.get((selected ?? hovered)!) : undefined;

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
      <div style={{
        position: 'fixed', bottom: 14, left: 14, zIndex: 10, color: '#8a8a94',
        fontSize: 11, fontFamily: 'system-ui, sans-serif', pointerEvents: 'none',
      }}>
        blue = prerequisite of selection · amber = unlocked by selection
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
        <div style={{
          position: 'fixed', left: mouse.x + 14, top: mouse.y + 14,
          background: '#16161e', border: '1px solid #34343e', borderRadius: 8,
          padding: '8px 12px', color: '#e6e6ee', fontFamily: 'system-ui, sans-serif',
          fontSize: 12, pointerEvents: 'none', maxWidth: 320,
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