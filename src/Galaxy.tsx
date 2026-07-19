// Galaxy v2: hover shows a tooltip and lights up the course's neighborhood
// (its prereqs + everything it unlocks); everything else dims.
// The tooltip renders every primitive field on the course object, so new
// data fields appear automatically without touching this file.
import { useEffect, useMemo, useRef, useState } from 'react';
import { CATALOG, type Course } from './catalog';
import { TIERS, MAX_TIER } from './tiers';
import { POSITIONS } from './positions';
import { DEPT_COLOR, deptOf } from './colors';
import type { Expr } from './parse';
import { exprLines } from './format';

const PAD = 60;

function allRefs(e: Expr | null): string[] {
  if (!e) return [];
  if (e.kind === 'course') return [e.id];
  if (e.kind === 'condition') return [];
  return e.of.flatMap(allRefs);
}

export default function Galaxy() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [mouse, setMouse] = useState({ x: 0, y: 0 });

  const [query, setQuery] = useState('');

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null; // null = no active search
    return new Set(CATALOG
      .filter((c) => c.id.toLowerCase().includes(q)
        || String(c.title ?? '').toLowerCase().includes(q))
      .map((c) => c.id));
  }, [query]);

  // adjacency, computed once: prereqs of each course, and its dependents
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

  const px = (id: string, W: number, H: number) => ({
    x: PAD + POSITIONS.get(id)! * (W - 2 * PAD),
    y: H - PAD - ((TIERS.get(id) ?? 0) / Math.max(MAX_TIER, 1)) * (H - 2 * PAD),
  });

  useEffect(() => {
    const canvas = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    const W = window.innerWidth, H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);

    const lit = new Set<string>();
    if (hovered) {
      lit.add(hovered);
      for (const r of prereqsOf.get(hovered) ?? []) lit.add(r);
      for (const d of dependentsOf.get(hovered) ?? []) lit.add(d);
    }
    const dimmed = (id: string) => {
      if (hovered !== null) return !lit.has(id);      // hover wins while active
      if (matches !== null) return !matches.has(id);  // otherwise search dims
      return false;
    };

    ctx.fillStyle = '#0b0b10';
    ctx.fillRect(0, 0, W, H);

    ctx.lineWidth = 1;
    for (const c of CATALOG) {
      const to = px(c.id, W, H);
      for (const r of prereqsOf.get(c.id) ?? []) {
        const from = px(r, W, H);
        const touchesHover = hovered !== null && (c.id === hovered || r === hovered);
        ctx.strokeStyle = touchesHover ? '#d8d8e2' : '#8a8a96';
        ctx.globalAlpha = hovered === null ? 0.18 : touchesHover ? 0.7 : 0.03;
        ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
      }
    }

    for (const c of CATALOG) {
      const p = px(c.id, W, H);
      ctx.globalAlpha = dimmed(c.id) ? 0.10 : 1;
      ctx.fillStyle = DEPT_COLOR[deptOf(c.id)];
      ctx.beginPath();
      ctx.arc(p.x, p.y, c.id === hovered ? 6 : 4, 0, Math.PI * 2);
      ctx.fill();
      if ((hovered !== null && lit.has(c.id)) || (hovered === null && matches?.has(c.id))) {
        ctx.fillStyle = '#e6e6ee';
        ctx.font = '10px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(c.id, p.x, p.y - 9);
      }
    }
    ctx.globalAlpha = 1;
  }, [hovered, byId, prereqsOf, dependentsOf, matches]);

  const onMove = (ev: React.MouseEvent) => {
    const rect = ref.current!.getBoundingClientRect();
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    const W = window.innerWidth, H = window.innerHeight;
    let best: string | null = null, bestD = 12;
    for (const c of CATALOG) {
      const p = px(c.id, W, H);
      const d = Math.hypot(p.x - mx, p.y - my);
      if (d < bestD) { bestD = d; best = c.id; }
    }
    setHovered(best);
    setMouse({ x: ev.clientX, y: ev.clientY });
  };

  const course: Course | undefined = hovered ? byId.get(hovered) : undefined;

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
      <canvas ref={ref} onMouseMove={onMove} onMouseLeave={() => setHovered(null)}
        style={{ display: 'block', background: '#0b0b10' }} />
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