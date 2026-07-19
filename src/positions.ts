// Horizontal positions via barycenter sweeps (deterministic, no tuning).
// Repeat: every node moves toward the mean x of its edge-neighbors, then
// each tier resolves overlaps left-to-right with a minimum gap. y is tiers'.
import { CATALOG } from './catalog';
import { TIERS } from './tiers';
import { DEPT_ORDER, deptOf } from './colors';
import type { Expr } from './parse';

function allRefs(e: Expr | null): string[] {
  if (!e) return [];
  if (e.kind === 'course') return [e.id];
  if (e.kind === 'condition') return [];
  return e.of.flatMap(allRefs);
}

export const POSITIONS: Map<string, number> = (() => {
  const known = new Set(CATALOG.map((c) => c.id));
  const deptIdx = new Map(DEPT_ORDER.map((d, i) => [d, i]));

  const ids = CATALOG.map((c) => c.id).sort((a, b) => {
    const da = deptIdx.get(deptOf(a))!, db = deptIdx.get(deptOf(b))!;
    return da !== db ? da - db : a < b ? -1 : 1;
  });
  const x = new Map(ids.map((id, i) => [id, (i + 0.5) / ids.length]));

  const neighbors = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const c of CATALOG)
    for (const r of new Set(allRefs(c.prereq)))
      if (known.has(r)) {
        neighbors.get(c.id)!.push(r);
        neighbors.get(r)!.push(c.id);
      }

  const byTier = new Map<number, string[]>();
  for (const id of ids) {
    const t = TIERS.get(id) ?? 0;
    byTier.set(t, [...(byTier.get(t) ?? []), id]);
  }
  const maxRow = Math.max(...[...byTier.values()].map((m) => m.length));
  const minGap = 1 / (maxRow + 1);

  for (let it = 0; it < 60; it++) {
    // pull toward neighbor average
    for (const id of ids) {
      const ns = neighbors.get(id)!;
      if (ns.length === 0) continue;
      const mean = ns.reduce((s, n) => s + x.get(n)!, 0) / ns.length;
      x.set(id, 0.5 * x.get(id)! + 0.5 * mean);
    }
    // resolve overlaps within each tier, preserving order
    for (const members of byTier.values()) {
      members.sort((a, b) => (x.get(a)! - x.get(b)!) || (a < b ? -1 : 1));
      for (let i = 1; i < members.length; i++) {
        const prev = x.get(members[i - 1])!, cur = x.get(members[i])!;
        if (cur < prev + minGap) x.set(members[i], prev + minGap);
      }
      // re-center the row so it doesn't drift right
      const mean = members.reduce((s, m) => s + x.get(m)!, 0) / members.length;
      const shift = 0.5 - mean;
      for (const m of members) x.set(m, x.get(m)! + shift);
    }
  }

  // final normalize into [0.03, 0.97]
  const lo = Math.min(...x.values()), hi = Math.max(...x.values());
  for (const id of ids)
    x.set(id, 0.03 + ((x.get(id)! - lo) / (hi - lo || 1)) * 0.94);
  return x;
})();