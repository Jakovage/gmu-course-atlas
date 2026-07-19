// Renders an expression tree as human-readable requirement text.
import type { Expr } from './parse';

// A concurrent-eligible leaf gets the same * used in the data grammar
// itself, right on the course name -- compact, and it reads in context
// (this specific option, inside this specific group) rather than needing a
// separate "Corequisites" list repeating the same names with no indication
// of which branch of the requirement they belong to.
function leafText(e: Expr & { kind: 'course' }): string {
  let s = e.id + (e.concurrent ? '*' : '');
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