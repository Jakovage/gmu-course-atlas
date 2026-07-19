// Renders an expression tree as human-readable requirement text.
import type { Expr } from './parse';

// concurrent-ok is no longer noted inline here: the parallel placement and
// the dedicated Corequisites tooltip section already show it, so repeating
// it as a parenthetical on every starred leaf was redundant.
function leafText(e: Expr & { kind: 'course' }): string {
  let s = e.id;
  if (e.minGrade) s += ` (min ${e.minGrade})`;
  return s;
}

// one expression -> one line, parenthesizing only nested groups
export function exprText(e: Expr): string {
  switch (e.kind) {
    case 'course': return leafText(e);
    case 'condition': return e.text;
    case 'and': return e.of.map((c) => group(c)).join(' and ');
    case 'or': return e.of.map((c) => group(c)).join(' or ');
  }
}
function group(e: Expr): string {
  const t = exprText(e);
  return e.kind === 'and' || e.kind === 'or' ? `(${t})` : t;
}

// top level split into lines: an AND root becomes one line per requirement
export function exprLines(e: Expr | null): string[] {
  if (!e) return [];
  if (e.kind === 'and') return e.of.map((c) => exprText(c));
  return [exprText(e)];
}