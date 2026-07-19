// Tiers: vertical layer per course. Five strictly-ordered bands, by catalog
// level: 100s, 200s, 300s, 400s, grad (500+). Each band's own courses get
// their tier from real prereq-chain depth WITHIN that band, then the whole
// band is shifted to sit directly above the previous band's tallest point.
// So a 300-level course whose only tracked prereqs happen to be outside the
// loaded catalog (computed depth 0) still floors at the 300-level band
// rather than sinking to the world floor next to genuine intro courses --
// but a 300-level course with a real, deep in-band chain can still climb
// higher than that floor, same as always. Cross-band references still draw
// as edges; they just don't affect height.
//
// Within a band, courses with zero prereqs AND zero unlocks (truly isolated
// -- nothing points to them, nothing points from them, almost certainly just
// missing data) would otherwise all pile onto that band's bottom layer.
// A course with zero prereqs but real unlocks is different: it's a genuine
// foundational course (something actually depends on it) and correctly
// belongs at the bottom, untouched. Isolated courses instead get spread
// across whatever layers the band's real chains already established, using
// the course number's own tens digit as a deterministic bucket -- same
// course, same digit, same layer, every time; no randomness, no new
// dimension invented, just better use of the structure that's already there.
import { CATALOG } from './catalog';
import type { Expr } from './parse';

export function levelOf(id: string): 'grad' | 'undergrad' {
  const m = id.match(/(\d{3})/);
  return m && parseInt(m[1], 10) >= 500 ? 'grad' : 'undergrad';
}

// which of the five bands a course belongs to, in increasing order
function bandOf(id: string): number {
  const m = id.match(/(\d{3})/);
  const n = m ? parseInt(m[1], 10) : 100;
  if (n >= 500) return 4;
  if (n >= 400) return 3;
  if (n >= 300) return 2;
  if (n >= 200) return 1;
  return 0;
}

function courseNumberOf(id: string): number {
  const m = id.match(/(\d{3})/);
  return m ? parseInt(m[1], 10) : 0;
}

function orderingRefs(e: Expr | null): string[] {
  if (!e) return [];
  if (e.kind === 'course') return e.concurrent ? [] : [e.id];
  if (e.kind === 'condition') return [];
  return e.of.flatMap(orderingRefs);
}
function concurrentRefs(e: Expr | null): string[] {
  if (!e) return [];
  if (e.kind === 'course') return e.concurrent ? [e.id] : [];
  if (e.kind === 'condition') return [];
  return e.of.flatMap(concurrentRefs);
}

// depth within a restricted set: refs outside the set contribute 0
function computeBandDepth(courses: typeof CATALOG): Map<string, number> {
  const byId = new Map(courses.map((c) => [c.id, c]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  function depth(id: string): number {
    const course = byId.get(id);
    if (!course) return 0;
    if (memo.has(id)) return memo.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const deps = orderingRefs(course.prereq).filter((r) => byId.has(r));
    const d = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(depth));
    visiting.delete(id);
    memo.set(id, d);
    return d;
  }
  for (const c of courses) depth(c.id);
  return memo;
}

// catalog-wide (not band-scoped): does ANYTHING reference this course, in
// either direction? Used only to tell a genuine foundational root (zero
// prereqs, but real unlocks) apart from a truly isolated course.
const hasAnyRelative: Map<string, boolean> = (() => {
  const known = new Set(CATALOG.map((c) => c.id));
  const has = new Map(CATALOG.map((c) => [c.id, false]));
  for (const c of CATALOG) {
    const refs = orderingRefs(c.prereq).filter((r) => known.has(r));
    if (refs.length > 0) has.set(c.id, true);
    for (const r of refs) has.set(r, true);
  }
  return has;
})();

export const TIERS: Map<string, number> = (() => {
  const bands: (typeof CATALOG)[] = [[], [], [], [], []];
  for (const c of CATALOG) bands[bandOf(c.id)].push(c);

  const tiers = new Map<string, number>();
  let base = 0;
  for (const bandCourses of bands) {
    const localDepth = computeBandDepth(bandCourses);
    let localMax = 0;
    for (const c of bandCourses) localMax = Math.max(localMax, localDepth.get(c.id) ?? 0);
    const numLayers = localMax + 1;

    // Isolated courses are bucketed by RANK (evenly split count per layer),
    // not by raw number range -- a level's isolated courses often cluster
    // in part of the number range rather than spreading uniformly across
    // it (e.g. real 400-level data clusters low: a range-based split gave
    // 95/26/28 across three layers, badly lopsided). Sorting by course
    // number and cutting into equal-size chunks guarantees an even count
    // per layer regardless of how the numbers themselves are clustered.
    const isolatedIds = bandCourses
      .filter((c) => (localDepth.get(c.id) ?? 0) === 0 && !hasAnyRelative.get(c.id))
      .map((c) => c.id)
      .sort((a, b) => courseNumberOf(a) - courseNumberOf(b) || (a < b ? -1 : 1));
    const perLayer = Math.max(1, Math.ceil(isolatedIds.length / numLayers));
    const isolatedLayer = new Map<string, number>();
    isolatedIds.forEach((id, i) => {
      isolatedLayer.set(id, Math.min(numLayers - 1, Math.floor(i / perLayer)));
    });

    for (const c of bandCourses) {
      const d = localDepth.get(c.id) ?? 0;
      const isolated = d === 0 && !hasAnyRelative.get(c.id);
      const layer = isolated ? isolatedLayer.get(c.id)! : d;
      tiers.set(c.id, base + layer);
    }
    base += numLayers; // next band starts strictly above this one
  }

  // mutual-star pull-up, same band only (crossing bands would violate the
  // strict level ordering, and a cross-level concurrent pair isn't expected
  // in real data anyway)
  const stars = new Map(CATALOG.map((c) => [c.id, new Set(concurrentRefs(c.prereq))]));
  for (const c of CATALOG) {
    for (const q of stars.get(c.id)!) {
      if (stars.get(q)?.has(c.id) && bandOf(c.id) === bandOf(q)) {
        const m = Math.max(tiers.get(c.id) ?? 0, tiers.get(q) ?? 0);
        tiers.set(c.id, m); tiers.set(q, m);
      }
    }
  }
  return tiers;
})();

export const MAX_TIER = Math.max(...TIERS.values());
export const UNDERGRAD_MAX_TIER: number = (() => {
  const vals = CATALOG.filter((c) => levelOf(c.id) === 'undergrad').map((c) => TIERS.get(c.id) ?? 0);
  return vals.length ? Math.max(...vals) : 0;
})();