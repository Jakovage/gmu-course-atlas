// Tiers: vertical layer per course. Undergrad (<500) and graduate (500+) are
// two independent bands: grad tier = undergrad's tallest tier + 1 + the
// course's own depth within grad-only chains. So every graduate course sits
// strictly above every undergraduate course, regardless of whether it has
// undergrad prereqs (those are satisfied by the band alone) or none at all
// (it still lands at the base of the grad band, not the base of the world).
// Cross-band references still draw as edges; they just don't affect height.
import { CATALOG } from './catalog';
import type { Expr } from './parse';

export function levelOf(id: string): 'grad' | 'undergrad' {
  const m = id.match(/(\d{3})/);
  return m && parseInt(m[1], 10) >= 500 ? 'grad' : 'undergrad';
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
  const undergrad = CATALOG.filter((c) => levelOf(c.id) === 'undergrad');
  const grad = CATALOG.filter((c) => levelOf(c.id) === 'grad');

  const underDepth = computeBandDepth(undergrad);
  const gradDepth = computeBandDepth(grad);

  const underMax = underDepth.size ? Math.max(...underDepth.values()) : 0;
  const gradBase = underMax + 1;

  const tiers = new Map<string, number>();
  for (const c of undergrad) tiers.set(c.id, underDepth.get(c.id) ?? 0);
  for (const c of grad) tiers.set(c.id, gradBase + (gradDepth.get(c.id) ?? 0));

  // mutual-star pull-up, same band only (crossing bands would violate the
  // grad-always-above rule, and a grad/undergrad concurrent pair isn't
  // expected in real data anyway)
  const stars = new Map(CATALOG.map((c) => [c.id, new Set(concurrentRefs(c.prereq))]));
  for (const c of CATALOG) {
    for (const q of stars.get(c.id)!) {
      if (stars.get(q)?.has(c.id) && levelOf(c.id) === levelOf(q)) {
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