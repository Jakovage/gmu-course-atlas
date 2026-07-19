// Department hues, derived from catalog structure. No hand-picked palette.
// 1. weight[dept A][dept B] = count of cross-department prereq references
// 2. order departments by the Fiedler vector of the graph Laplacian
//    (spectral seriation: heavily-linked departments end up adjacent)
// 3. space hues evenly around the wheel in that order
// Deterministic: fixed sign convention, alphabetical tie-breaks.
import { CATALOG } from './catalog';
import type { Expr } from './parse';

export const deptOf = (id: string) => id.split(' ')[0];

function allRefs(e: Expr | null): string[] {
  if (!e) return [];
  if (e.kind === 'course') return [e.id];
  if (e.kind === 'condition') return [];
  return e.of.flatMap(allRefs);
}

// Jacobi eigendecomposition for small symmetric matrices. Deterministic.
function jacobi(A: number[][]): { values: number[]; vectors: number[][] } {
  const n = A.length;
  const a = A.map((r) => [...r]);
  const V: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] ** 2;
    if (off < 1e-18) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(a[p][q]) < 1e-15) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s2 = t * c;
      for (let k = 0; k < n; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s2 * akq; a[k][q] = s2 * akp + c * akq;
      }
      for (let k = 0; k < n; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s2 * aqk; a[q][k] = s2 * apk + c * aqk;
      }
      for (let k = 0; k < n; k++) {
        const vkp = V[k][p], vkq = V[k][q];
        V[k][p] = c * vkp - s2 * vkq; V[k][q] = s2 * vkp + c * vkq;
      }
    }
  }
  return { values: a.map((r, i) => r[i]), vectors: V };
}

export const DEPT_ORDER: string[] = (() => {
  const depts = [...new Set(CATALOG.map((c) => deptOf(c.id)))].sort();
  if (depts.length <= 2) return depts;
  const idx = new Map(depts.map((d, i) => [d, i]));
  const n = depts.length;

  const W: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  for (const course of CATALOG) {
    const t = idx.get(deptOf(course.id))!;
    for (const r of allRefs(course.prereq)) {
      const s = idx.get(deptOf(r));
      if (s === undefined || s === t) continue;
      W[s][t] += 1; W[t][s] += 1;
    }
  }
  const L = W.map((row, i) => row.map((w, j) =>
    (i === j ? row.reduce((x, y) => x + y, 0) : -w)));

  const { values, vectors } = jacobi(L);
  const byValue = values.map((v, j) => [v, j] as const).sort((a, b) => a[0] - b[0]);
  const fiedlerCol = byValue[1][1];
  let f = depts.map((_, k) => vectors[k][fiedlerCol]);
  if (f[0] < 0) f = f.map((x) => -x);   // sign convention

  return depts
    .map((d, k) => ({ d, v: f[k] }))
    .sort((a, b) => (a.v !== b.v ? a.v - b.v : a.d < b.d ? -1 : 1))
    .map((x) => x.d);
})();

export const DEPT_COLOR: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  DEPT_ORDER.forEach((d, i) => {
    out[d] = `hsl(${Math.round((360 * i) / DEPT_ORDER.length)} 75% 62%)`;
  });
  return out;
})();