import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CATALOG, type Course } from './catalog';
import { TIERS, levelOf } from './tiers';
import { POSITIONS, computeXPositions } from './positions';
import { DEPT_COLOR, deptOf } from './colors';
import { exprLines } from './format';
import {
  allRefs,
  concurrentRefs,
  globalWorldOf,
  xRangeOf,
  type GraphEdge,
  type Pos,
} from './galaxyLayout';
import {
  PixiGalaxyRenderer,
  type GalaxySceneData,
} from './PixiGalaxyRenderer';

const LEFT_PANEL_WIDTH = 240;
const RIGHT_PANEL_WIDTH = 320;
const PANEL_GAP = 8;

const PANEL_STYLE: React.CSSProperties = {
  background: 'rgba(22,22,30,0.6)',
  backdropFilter: 'blur(4px)',
  border: '1px solid #34343e',
  borderRadius: 8,
};

function InfoDot({ text }: { text: string }) {
  const [show, setShow] = useState(false);
  return (
    <span
      style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <span style={{
        width: 13,
        height: 13,
        borderRadius: '50%',
        border: '1px solid #6a6a76',
        color: '#8a8a94',
        fontSize: 9,
        lineHeight: '12px',
        textAlign: 'center',
        cursor: 'default',
        userSelect: 'none',
      }}>i</span>
      {show && (
        <span style={{
          ...PANEL_STYLE,
          position: 'absolute',
          bottom: '150%',
          left: 0,
          background: 'rgba(22,22,30,0.9)',
          padding: '6px 8px',
          color: '#c8c8d2',
          fontSize: 11,
          width: 175,
          lineHeight: 1.4,
          pointerEvents: 'none',
          zIndex: 20,
        }}>{text}</span>
      )}
    </span>
  );
}

export default function Galaxy() {
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<PixiGalaxyRenderer | null>(null);
  const latestSceneRef = useRef<GalaxySceneData | null>(null);
  const leftControlsRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);

  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [mouse, setMouse] = useState({ x: 0, y: 0 });
  const [query, setQuery] = useState('');
  const [showGrad, setShowGrad] = useState(false);
  const [deptFilter, setDeptFilter] = useState<Set<string>>(new Set());
  const [relFilter, setRelFilter] = useState(1);
  const [searchSuspended, setSearchSuspended] = useState(false);

  const hoveredStateRef = useRef<string | null>(null);
  hoveredStateRef.current = hovered;

  const hoverTooltipOriginRef = useRef<{ left: number; top: number } | null>(null);
  const selectedTooltipOriginRef = useRef<{ left: number; top: number } | null>(null);

  const visible = useMemo(
    () => (showGrad ? CATALOG : CATALOG.filter((course) => levelOf(course.id) !== 'grad')),
    [showGrad],
  );

  const departments = useMemo(
    () => [...new Set(CATALOG.map((course) => deptOf(course.id)))].sort(),
    [],
  );

  const deptVisible = useMemo(() => {
    if (deptFilter.size === 0) return visible;

    const byId = new Map(visible.map((course) => [course.id, course]));
    const prereqsOfAll = new Map<string, string[]>();
    const dependentsOfAll = new Map<string, string[]>(visible.map((course) => [course.id, []]));

    for (const course of visible) {
      const refs = [...new Set(allRefs(course.prereq))].filter((id) => byId.has(id));
      prereqsOfAll.set(course.id, refs);
      for (const ref of refs) dependentsOfAll.get(ref)!.push(course.id);
    }

    const selectedDepartments = visible.filter((course) => deptFilter.has(deptOf(course.id)));
    const keep = new Set(selectedDepartments.map((course) => course.id));
    for (const course of selectedDepartments) {
      for (const ref of prereqsOfAll.get(course.id) ?? []) keep.add(ref);
      for (const ref of dependentsOfAll.get(course.id) ?? []) keep.add(ref);
    }
    return visible.filter((course) => keep.has(course.id));
  }, [visible, deptFilter]);

  const effectiveMaxTier = Math.max(
    0,
    ...deptVisible.map((course) => TIERS.get(course.id) ?? 0),
  );

  const { degreeOf, maxDegree } = useMemo(() => {
    const byId = new Map(deptVisible.map((course) => [course.id, course]));
    const prereqCount = new Map<string, number>();
    const unlockCount = new Map<string, number>(deptVisible.map((course) => [course.id, 0]));

    for (const course of deptVisible) {
      const refs = [...new Set(allRefs(course.prereq))].filter((id) => byId.has(id));
      prereqCount.set(course.id, refs.length);
      for (const ref of refs) unlockCount.set(ref, (unlockCount.get(ref) ?? 0) + 1);
    }

    const degree = new Map<string, number>();
    let maximum = 1;
    for (const course of deptVisible) {
      const count = (prereqCount.get(course.id) ?? 0) + (unlockCount.get(course.id) ?? 0);
      degree.set(course.id, count);
      maximum = Math.max(maximum, count);
    }
    return { degreeOf: degree, maxDegree: maximum };
  }, [deptVisible]);

  const filteredVisible = useMemo(() => {
    if (relFilter >= 1) return deptVisible;
    const threshold = Math.round(relFilter * maxDegree);
    return deptVisible.filter((course) => (degreeOf.get(course.id) ?? 0) <= threshold);
  }, [deptVisible, relFilter, degreeOf, maxDegree]);

  const visibleIds = useMemo(
    () => new Set(filteredVisible.map((course) => course.id)),
    [filteredVisible],
  );

  const matches = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return null;
    return new Set(
      filteredVisible
        .filter((course) => course.id.toLowerCase().includes(normalized)
          || String(course.title ?? '').toLowerCase().includes(normalized))
        .map((course) => course.id),
    );
  }, [query, filteredVisible]);

  const effectiveMatches = searchSuspended ? null : matches;

  const {
    byId,
    prereqsOf,
    dependentsOf,
    coreqOf,
    recommendedEdge,
  } = useMemo(() => {
    const byCourseId = new Map(filteredVisible.map((course) => [course.id, course]));
    const prereqs = new Map<string, string[]>();
    const dependents = new Map<string, string[]>(filteredVisible.map((course) => [course.id, []]));
    const recommendedEdges = new Set<string>();
    const corequisites = new Map<string, Set<string>>(
      filteredVisible.map((course) => [course.id, new Set()]),
    );

    for (const course of filteredVisible) {
      const prereqRefs = [...new Set(allRefs(course.prereq))]
        .filter((id) => byCourseId.has(id));
      const recRefs = [...new Set(allRefs(course.recommended))]
        .filter((id) => byCourseId.has(id) && id !== course.id && !prereqRefs.includes(id));

      prereqs.set(course.id, [...prereqRefs, ...recRefs]);
      for (const ref of prereqRefs) dependents.get(ref)!.push(course.id);
      for (const ref of recRefs) {
        dependents.get(ref)!.push(course.id);
        recommendedEdges.add(`${ref}>${course.id}`);
      }
      for (const ref of concurrentRefs(course.prereq)) {
        if (byCourseId.has(ref)) corequisites.get(course.id)!.add(ref);
      }
      for (const ref of concurrentRefs(course.recommended)) {
        if (byCourseId.has(ref)) corequisites.get(course.id)!.add(ref);
      }
    }

    return {
      byId: byCourseId,
      prereqsOf: prereqs,
      dependentsOf: dependents,
      coreqOf: corequisites,
      recommendedEdge: recommendedEdges,
    };
  }, [filteredVisible]);

  const graphEdges = useMemo<GraphEdge[]>(() => {
    const edges: GraphEdge[] = [];
    for (const course of filteredVisible) {
      for (const ref of prereqsOf.get(course.id) ?? []) {
        edges.push({
          from: ref,
          to: course.id,
          recommended: recommendedEdge.has(`${ref}>${course.id}`),
        });
      }
    }
    return edges;
  }, [filteredVisible, prereqsOf, recommendedEdge]);

  const localPositions = useMemo(
    () => (deptFilter.size > 0 ? computeXPositions(deptVisible) : null),
    [deptVisible, deptFilter],
  );
  const activePositions = localPositions ?? POSITIONS;

  const globalPositions = useMemo(() => {
    const [xMin, xRange] = xRangeOf(deptVisible, activePositions);
    const result = new Map<string, Pos>();
    for (const course of filteredVisible) {
      result.set(
        course.id,
        globalWorldOf(
          course.id,
          effectiveMaxTier,
          xMin,
          xRange,
          activePositions,
          TIERS,
        ),
      );
    }
    return result;
  }, [deptVisible, filteredVisible, activePositions, effectiveMaxTier]);

  const sceneData = useMemo<GalaxySceneData>(() => ({
    courses: filteredVisible,
    byId,
    prereqsOf,
    dependentsOf,
    coreqOf,
    recommendedEdge,
    graphEdges,
    globalPositions,
    matches: effectiveMatches,
    selected,
    hovered,
    showGlobalLabels: deptFilter.size > 0,
  }), [
    filteredVisible,
    byId,
    prereqsOf,
    dependentsOf,
    coreqOf,
    recommendedEdge,
    graphEdges,
    globalPositions,
    effectiveMatches,
    selected,
    hovered,
    deptFilter,
  ]);
  latestSceneRef.current = sceneData;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    let cancelled = false;
    let created: PixiGalaxyRenderer | null = null;

    void PixiGalaxyRenderer.create(host, {
      onHover: (id, clientX, clientY) => {
        setMouse({ x: clientX, y: clientY });
        setHovered(id);
      },
      onSelect: (id, clientX, clientY) => {
        setMouse({ x: clientX, y: clientY });
        if (id) {
          selectedTooltipOriginRef.current =
            hoveredStateRef.current === id && hoverTooltipOriginRef.current
              ? { ...hoverTooltipOriginRef.current }
              : { left: clientX, top: clientY };
        }
        setSelected(id);
        if (id) setSearchSuspended(true);
      },
      onPointerMove: (clientX, clientY) => {
        if (hoveredStateRef.current) setMouse({ x: clientX, y: clientY });
      },
    }).then((renderer) => {
      if (cancelled) {
        renderer.destroy();
        return;
      }
      created = renderer;
      rendererRef.current = renderer;
      if (latestSceneRef.current) renderer.setScene(latestSceneRef.current);
    });

    return () => {
      cancelled = true;
      created?.destroy();
      if (rendererRef.current === created) rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    rendererRef.current?.setScene(sceneData);
  }, [sceneData]);

  const firstLayoutReset = useRef(true);
  useEffect(() => {
    if (firstLayoutReset.current) {
      firstLayoutReset.current = false;
      return;
    }
    rendererRef.current?.resetCamera();
  }, [showGrad, deptFilter]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (selected && !visibleIds.has(selected)) setSelected(null);
    if (hovered && !visibleIds.has(hovered)) setHovered(null);
  }, [visibleIds, selected, hovered]);

  const selectedCourse = selected ? byId.get(selected) : undefined;
  const hoveredCourse = hovered && hovered !== selected ? byId.get(hovered) : undefined;

  const tooltipRef = useRef<HTMLDivElement>(null);
  const selectedTooltipRef = useRef<HTMLDivElement>(null);
  const [tipPos, setTipPos] = useState({ left: 0, top: 0 });
  const [displayedSelectedCourse, setDisplayedSelectedCourse] = useState<Course | null>(null);
  const [selectedPos, setSelectedPos] = useState<{
    left: number;
    top: number;
    animate: boolean;
    opacity: number;
  } | null>(null);
  const prevSelectedRef = useRef<string | null>(null);
  const selectedFadeTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (selectedFadeTimerRef.current !== null) {
      window.clearTimeout(selectedFadeTimerRef.current);
    }
  }, []);

  useLayoutEffect(() => {
    if (selectedFadeTimerRef.current !== null) {
      window.clearTimeout(selectedFadeTimerRef.current);
      selectedFadeTimerRef.current = null;
    }

    if (!selectedCourse) {
      prevSelectedRef.current = null;
      if (displayedSelectedCourse) {
        setSelectedPos((previous) => previous
          ? { ...previous, animate: true, opacity: 0 }
          : previous);
        selectedFadeTimerRef.current = window.setTimeout(() => {
          setDisplayedSelectedCourse(null);
          setSelectedPos(null);
          selectedFadeTimerRef.current = null;
        }, 180);
      }
      return;
    }

    if (prevSelectedRef.current === selected) return;
    prevSelectedRef.current = selected;
    setDisplayedSelectedCourse(selectedCourse);

    const origin = selectedTooltipOriginRef.current ?? { left: mouse.x, top: mouse.y };
    selectedTooltipOriginRef.current = null;
    setSelectedPos({ ...origin, animate: false, opacity: 1 });

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setSelectedPos({
          left: window.innerWidth - 14 - RIGHT_PANEL_WIDTH,
          top: 14,
          animate: true,
          opacity: 1,
        });
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // Continue receiving pointer coordinates while the cursor passes over an
  // HTML panel. The hover tooltip can then follow the free axis while its x
  // position remains clamped outside that panel.
  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      if (hoveredStateRef.current) {
        setMouse({ x: event.clientX, y: event.clientY });
      }
    };
    window.addEventListener('pointermove', onPointerMove);
    return () => window.removeEventListener('pointermove', onPointerMove);
  }, []);

  useLayoutEffect(() => {
    if (!hoveredCourse || !tooltipRef.current) {
      hoverTooltipOriginRef.current = null;
      return;
    }

    const rect = tooltipRef.current.getBoundingClientRect();
    let left = mouse.x + 14;
    let top = mouse.y + 14;

    if (left + rect.width > window.innerWidth - 8) {
      left = mouse.x - 14 - rect.width;
    }
    if (top + rect.height > window.innerHeight - 8) {
      top = mouse.y - 14 - rect.height;
    }

    const obstacles = [
      leftControlsRef.current?.getBoundingClientRect(),
      displayedSelectedCourse && selectedPos?.opacity !== 0
        ? selectedTooltipRef.current?.getBoundingClientRect()
        : undefined,
      legendRef.current?.getBoundingClientRect(),
    ].filter((value): value is DOMRect => Boolean(value));

    const overlaps = (aLeft: number, aTop: number, obstacle: DOMRect) => (
      aLeft < obstacle.right
      && aLeft + rect.width > obstacle.left
      && aTop < obstacle.bottom
      && aTop + rect.height > obstacle.top
    );

    // Two passes handle a tooltip displaced away from one panel and into
    // another. Left-side panels clamp it to their right edge; right-side
    // panels clamp it to their left edge. Its vertical position still follows
    // the cursor, which creates the requested "locked axis" behavior.
    for (let pass = 0; pass < 2; pass++) {
      for (const obstacle of obstacles) {
        const pointerInside = mouse.x >= obstacle.left && mouse.x <= obstacle.right
          && mouse.y >= obstacle.top && mouse.y <= obstacle.bottom;
        if (!pointerInside && !overlaps(left, top, obstacle)) continue;

        if ((obstacle.left + obstacle.right) / 2 < window.innerWidth / 2) {
          left = obstacle.right + PANEL_GAP;
        } else {
          left = obstacle.left - PANEL_GAP - rect.width;
        }
      }
    }

    left = Math.min(window.innerWidth - 8 - rect.width, Math.max(8, left));
    top = Math.min(window.innerHeight - 8 - rect.height, Math.max(8, top));

    hoverTooltipOriginRef.current = { left, top };
    setTipPos({ left, top });
  }, [hoveredCourse, mouse, displayedSelectedCourse, selectedPos]);

  const tooltipBody = (course: Course) => (
    <>
      <div style={{ fontWeight: 700 }}>{course.id}</div>
      {Object.entries(course)
        .filter(([key, value]) => key !== 'id' && key !== 'prereq'
          && (typeof value === 'string' || typeof value === 'number'))
        .map(([key, value]) => (
          <div key={key} style={{ color: '#a8a8b4', marginTop: 2 }}>
            {key === 'title' ? String(value) : `${key}: ${value}`}
          </div>
        ))}
      {course.prereq && (
        <div style={{ marginTop: 6 }}>
          <div style={{ color: '#7f7f8a', fontSize: 10, textTransform: 'uppercase' }}>Requires</div>
          {exprLines(course.prereq).map((line, index) => (
            <div key={index} style={{ marginTop: 1 }}>{line}</div>
          ))}
        </div>
      )}
      {course.recommended && (
        <div style={{ marginTop: 6 }}>
          <div style={{ color: '#7f7f8a', fontSize: 10, textTransform: 'uppercase' }}>Recommended</div>
          {exprLines(course.recommended).map((line, index) => (
            <div key={index} style={{ color: '#a8a8b4', marginTop: 1 }}>{line}</div>
          ))}
        </div>
      )}
      {(dependentsOf.get(course.id) ?? []).length > 0 && (
        <div style={{ marginTop: 6 }}>
          <div style={{ color: '#7f7f8a', fontSize: 10, textTransform: 'uppercase' }}>Unlocks</div>
          <div style={{ color: '#a8a8b4' }}>
            {(dependentsOf.get(course.id) ?? []).slice(0, 10).join(', ')}
            {(dependentsOf.get(course.id) ?? []).length > 10
              && ` +${(dependentsOf.get(course.id) ?? []).length - 10} more`}
          </div>
        </div>
      )}
    </>
  );

  const tooltipPanelStyle: React.CSSProperties = {
    background: 'rgba(22,22,30,0.5)',
    border: '1px solid #34343e',
    borderRadius: 8,
    padding: '8px 12px',
    color: '#e6e6ee',
    fontFamily: 'system-ui, sans-serif',
    fontSize: 12,
    pointerEvents: 'none',
    width: RIGHT_PANEL_WIDTH,
    maxWidth: 'calc(100vw - 28px)',
    boxSizing: 'border-box',
    backdropFilter: 'blur(3px)',
  };

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}>
      <div
        ref={hostRef}
        style={{ position: 'fixed', inset: 0, background: '#0b0b10' }}
      />

      <div
        ref={leftControlsRef}
        style={{
          position: 'fixed',
          top: 14,
          left: 14,
          zIndex: 10,
          width: LEFT_PANEL_WIDTH,
          maxHeight: 'calc(100vh - 28px)',
          display: 'flex',
          flexDirection: 'column',
          gap: PANEL_GAP,
        }}
      >
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSearchSuspended(false);
          }}
          placeholder="search courses..."
          style={{
            ...PANEL_STYLE,
            width: '100%',
            boxSizing: 'border-box',
            padding: '7px 12px',
            color: '#e6e6ee',
            fontSize: 13,
            outline: 'none',
            fontFamily: 'system-ui, sans-serif',
          }}
        />

        <div style={{
          ...PANEL_STYLE,
          width: '100%',
          boxSizing: 'border-box',
          minHeight: 80,
          maxHeight: '50vh',
          overflowY: 'auto',
          padding: '10px 12px',
          color: '#e6e6ee',
          fontSize: 12.5,
          fontFamily: 'system-ui, sans-serif',
        }}>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 6,
          }}>
            <span style={{ fontWeight: 600 }}>departments</span>
            {deptFilter.size > 0 && (
              <button
                onClick={() => setDeptFilter(new Set())}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#7f9fd1',
                  fontSize: 11,
                  cursor: 'pointer',
                  padding: 0,
                }}
              >clear</button>
            )}
          </div>
          {departments.map((department) => (
            <label
              key={department}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                padding: '3px 0',
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              <input
                type="checkbox"
                checked={deptFilter.has(department)}
                onChange={(event) => {
                  const next = new Set(deptFilter);
                  if (event.target.checked) next.add(department);
                  else next.delete(department);
                  setDeptFilter(next);
                }}
              />
              <span style={{
                width: 9,
                height: 9,
                borderRadius: '50%',
                flexShrink: 0,
                background: DEPT_COLOR[department] ?? '#8a8a94',
              }} />
              <span>{department}</span>
            </label>
          ))}
        </div>

        <div style={{
          ...PANEL_STYLE,
          width: '100%',
          boxSizing: 'border-box',
          padding: '8px 12px',
          color: '#e6e6ee',
          fontSize: 12,
          fontFamily: 'system-ui, sans-serif',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span>immediate relatives</span>
            <span style={{ color: '#8a8a94' }}>
              {relFilter >= 1 ? 'all' : `≤ ${Math.round(relFilter * maxDegree)}`}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={relFilter}
            onChange={(event) => setRelFilter(Number.parseFloat(event.target.value))}
            style={{ width: '100%' }}
          />
        </div>

        <label style={{
          ...PANEL_STYLE,
          width: '100%',
          boxSizing: 'border-box',
          padding: '6px 12px',
          color: '#e6e6ee',
          fontSize: 12.5,
          fontFamily: 'system-ui, sans-serif',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          cursor: 'pointer',
          userSelect: 'none',
        }}>
          <input
            type="checkbox"
            checked={showGrad}
            onChange={(event) => setShowGrad(event.target.checked)}
          />
          show graduate (500+) courses
        </label>
      </div>

      <div
        ref={legendRef}
        style={{
          ...PANEL_STYLE,
          position: 'fixed',
          right: 14,
          bottom: 14,
          zIndex: 10,
          width: RIGHT_PANEL_WIDTH,
          boxSizing: 'border-box',
          padding: '8px 10px',
          color: '#e6e6ee',
          fontSize: 11.5,
          fontFamily: 'system-ui, sans-serif',
          display: 'flex',
          flexDirection: 'column',
          gap: 5,
        }}
      >
        {[
          {
            swatch: <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#8a8a94', display: 'inline-block' }} />,
            label: 'Course',
            info: 'A single course. Color indicates department.',
          },
          {
            swatch: <span style={{ width: 20, height: 2, background: '#9a9aa4', display: 'inline-block' }} />,
            label: 'Relationship',
            info: 'A directional course relationship. Same-tier relationships arch and show an arrow toward the destination.',
          },
          {
            swatch: <span style={{ width: 20, borderTop: '2px dashed #9a9aa4', display: 'inline-block' }} />,
            label: 'Recommended',
            info: 'Advisory, not required -- suggested background before taking this course.',
          },
          {
            swatch: <span style={{ width: 16, height: 12, border: '1.5px dashed #9a9aa4', borderRadius: 3, display: 'inline-block' }} />,
            label: 'OR group',
            info: 'Only one course inside this dashed box is required.',
          },
          {
            swatch: <span style={{ width: 16, height: 12, border: '1.5px solid #9a9aa4', borderRadius: 3, display: 'inline-block' }} />,
            label: 'AND group',
            info: 'All courses inside this solid box are required together (shown nested inside an OR group).',
          },
        ].map((item, index) => (
          <div key={index} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ width: 20, display: 'flex', justifyContent: 'center' }}>{item.swatch}</span>
            <span style={{ minWidth: 84 }}>{item.label}</span>
            <InfoDot text={item.info} />
          </div>
        ))}
        <div style={{ color: '#8a8a94', fontSize: 10.5, marginTop: 1 }}>fainter = farther away</div>
      </div>

      {displayedSelectedCourse && selectedPos && (
        <div ref={selectedTooltipRef} style={{
          ...tooltipPanelStyle,
          position: 'fixed',
          left: selectedPos.left,
          top: selectedPos.top,
          zIndex: 11,
          opacity: selectedPos.opacity,
          maxHeight: 'calc(100vh - 230px)',
          overflowY: 'auto',
          transition: selectedPos.animate
            ? 'left 0.28s ease, top 0.28s ease, opacity 0.18s ease'
            : 'none',
          willChange: 'left, top, opacity',
        }}>
          {tooltipBody(displayedSelectedCourse)}
        </div>
      )}

      {hoveredCourse && (
        <div ref={tooltipRef} style={{
          ...tooltipPanelStyle,
          position: 'fixed',
          left: tipPos.left,
          top: tipPos.top,
          zIndex: 12,
          maxHeight: 'calc(100vh - 16px)',
          overflowY: 'auto',
        }}>
          {tooltipBody(hoveredCourse)}
        </div>
      )}
    </div>
  );
}