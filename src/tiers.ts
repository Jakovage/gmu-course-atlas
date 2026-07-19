// Tier = length of the longest chain of ordering prerequisites below a course.
// Starred (concurrent) refs impose no ordering, so they don't push depth.
// Mutual-star pairs share a row: each member gets the cluster's max depth.
import { CATALOG, type Course } from './catalog';
import type { Expr } from './parse';

// course refs that require strict before-ness (stars excluded)
function orderingRefs(e: Expr | null): string[] {
  if (!e) return [];
  if (e.kind === 'course') return e.concurrent ? [] : [e.id];
  if (e.kind === 'condition') return [];
  return e.of.flatMap(orderingRefs);
}

// course refs marked concurrent (for the shared-row rule)
function concurrentRefs(e: Expr | null): string[] {
  if (!e) return [];
  if (e.kind === 'course') return e.concurrent ? [e.id] : [];
  if (e.kind === 'condition') return [];
  return e.of.flatMap(concurrentRefs);
}

const byId = new Map(CATALOG.map((c) => [c.id, c]));
const memo = new Map<string, number>();
const visiting = new Set<string>();

function depth(id: string): number {
  const course = byId.get(id);
  if (!course) return 0;            // dangling ref: sits at the bottom
  if (memo.has(id)) return memo.get(id)!;
  if (visiting.has(id)) return 0;   // cycle guard (validation's job to report)
  visiting.add(id);
  const deps = orderingRefs(course.prereq).filter((r) => byId.has(r));
  const d = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(depth));
  visiting.delete(id);
  memo.set(id, d);
  return d;
}

export const TIERS: Map<string, number> = (() => {
  for (const c of CATALOG) depth(c.id);

  // shared-row rule: mutual stars pull both members to the deeper row
  const stars = new Map(CATALOG.map((c) => [c.id, new Set(concurrentRefs(c.prereq))]));
  for (const c of CATALOG) {
    for (const q of stars.get(c.id)!) {
      if (stars.get(q)?.has(c.id)) {
        const m = Math.max(memo.get(c.id) ?? 0, memo.get(q) ?? 0);
        memo.set(c.id, m);
        memo.set(q, m);
      }
    }
  }
  return memo;
})();

export const MAX_TIER = Math.max(...TIERS.values());