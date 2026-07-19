// Tiers: vertical layer per course. Five strictly-ordered bands, by catalog
// level: 100s, 200s, 300s, 400s, grad (500+). Each band's own courses get
// their tier from real prereq-chain depth WITHIN that band (same technique
// as before), then the whole band is shifted to sit directly above the
// previous band's tallest point. So a 300-level course whose only tracked
// prereqs happen to be outside the loaded catalog (computed depth 0) still
// floors at the 300-level band rather than sinking to the world floor next
// to genuine intro courses -- but a 300-level course with a real, deep
// in-band chain can still climb higher than that floor, same as always.
// Cross-band references still draw as edges; they just don't affect height.
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

export const TIERS: Map<string, number> = (() => {
  const bands: (typeof CATALOG)[] = [[], [], [], [], []];
  for (const c of CATALOG) bands[bandOf(c.id)].push(c);

  const tiers = new Map<string, number>();
  let base = 0;
  for (const bandCourses of bands) {
    const localDepth = computeBandDepth(bandCourses);
    let localMax = 0;
    for (const c of bandCourses) {
      const d = localDepth.get(c.id) ?? 0;
      tiers.set(c.id, base + d);
      localMax = Math.max(localMax, d);
    }
    base += localMax + 1; // next band starts strictly above this one
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
