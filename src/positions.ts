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

  // A component is "orphaned" if every one of its members belongs to the
  // same department -- meaning it has no real edge to anything outside a
  // same-department bubble (a lone singleton, or a same-dept-only pair like
  // two courses that reference only each other). Such components never got
  // a meaningful pull from the physics loop above and can land anywhere.
  // A component that includes a genuine cross-department edge, by contrast,
  // IS meaningfully anchored (that's legitimate graph structure, not noise)
  // and is left exactly where the physics loop put it.
  const parent = new Map<string, string>(ids.map((id) => [id, id]));
  function find(a: string): string {
    while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a)!)!); a = parent.get(a)!; }
    return a;
  }
  function union(a: string, b: string) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  for (const [a, list] of neighbors) for (const b of list) union(a, b);

  const components = new Map<string, string[]>();
  for (const id of ids) {
    const root = find(id);
    components.set(root, [...(components.get(root) ?? []), id]);
  }

  function isSameDeptOnly(members: string[]): boolean {
    const d0 = deptOf(members[0]);
    return members.every((id) => deptOf(id) === d0);
  }

  // Primary reference per department: centroid of members that sit in a
  // genuinely cross-department-connected component -- the most trustworthy
  // signal, since it reflects real inter-department structure.
  const refSum = new Map<string, number>();
  const refCount = new Map<string, number>();
  for (const members of components.values()) {
    if (isSameDeptOnly(members)) continue;
    for (const id of members) {
      const d = deptOf(id);
      refSum.set(d, (refSum.get(d) ?? 0) + x.get(id)!);
      refCount.set(d, (refCount.get(d) ?? 0) + 1);
    }
  }
  const deptRef = new Map<string, number>();
  for (const [d, count] of refCount) if (count > 0) deptRef.set(d, refSum.get(d)! / count);

  // Fallback: a department may be entirely self-contained (every edge it has
  // is to its own courses, never another department -- ASTR's intro courses
  // are like this: ASTR 210/328/402 etc. form a real, densely-connected
  // cluster, but it never references outside ASTR). Such a cluster is still
  // a genuine, non-noise anchor -- unlike a field of same-department
  // singletons all tied at size 1 with nothing to distinguish one from
  // another. So: if a department has no cross-department reference, use its
  // own largest same-department component as the anchor, provided that
  // component has more than one member (a real cluster, not another orphan).
  const sameDeptComponentsByDept = new Map<string, string[][]>();
  for (const members of components.values()) {
    if (!isSameDeptOnly(members)) continue;
    const d = deptOf(members[0]);
    sameDeptComponentsByDept.set(d, [...(sameDeptComponentsByDept.get(d) ?? []), members]);
  }
  const fallbackAnchor = new Map<string, string[]>(); // dept -> its own anchor component
  for (const [d, comps] of sameDeptComponentsByDept) {
    if (deptRef.has(d)) continue;
    const largest = comps.reduce((a, b) => (b.length > a.length ? b : a));
    if (largest.length > 1) {
      deptRef.set(d, largest.reduce((s, id) => s + x.get(id)!, 0) / largest.length);
      fallbackAnchor.set(d, largest);
    }
  }

  // shift every orphaned component (as one rigid group, preserving its own
  // internal spacing) onto its department's reference centroid -- except a
  // component that IS itself the fallback anchor, which stays put
  for (const members of components.values()) {
    if (!isSameDeptOnly(members)) continue;
    const d = deptOf(members[0]);
    if (fallbackAnchor.get(d) === members) continue;
    const ref = deptRef.get(d);
    if (ref === undefined) continue; // no reference available at all for this dept; leave as-is
    const ownCentroid = members.reduce((s, id) => s + x.get(id)!, 0) / members.length;
    const shift = ref - ownCentroid;
    for (const id of members) x.set(id, x.get(id)! + shift);
  }

  // The orphan-reconciliation shift above can land multiple singletons from
  // the same department (often also the same tier -- several intro courses
  // with no prereqs, say) on the EXACT same point, since each is shifted
  // independently onto the identical department reference. One more
  // overlap pass nudges anything that now coincides within a tier apart --
  // unlike the loop above, this one does NOT re-center each row to 0.5,
  // so departments keep the regional position the reconciliation just gave
  // them instead of being dragged back toward the middle.
  for (const members of byTier.values()) {
    members.sort((a, b) => (x.get(a)! - x.get(b)!) || (a < b ? -1 : 1));
    for (let i = 1; i < members.length; i++) {
      const prev = x.get(members[i - 1])!, cur = x.get(members[i])!;
      if (cur < prev + minGap) x.set(members[i], prev + minGap);
    }
  }

  // final normalize into [0.03, 0.97]
  const lo = Math.min(...x.values()), hi = Math.max(...x.values());
  for (const id of ids)
    x.set(id, 0.03 + ((x.get(id)! - lo) / (hi - lo || 1)) * 0.94);
  return x;
})();