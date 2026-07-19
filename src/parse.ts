// Parses the prereq grammar into an expression tree.
//   leaf:   "CS 211:C"  "CHEM 313*"  "MATH 115*:B-"  "?Aleks >= 80"
//   groups: "(A & B & C)"  "(A | B)"  nested arbitrarily
// One operator per parenthesized group; * = may be taken concurrently.

export type Expr =
  | { kind: 'course'; id: string; minGrade?: string; concurrent?: boolean }
  | { kind: 'condition'; text: string }
  | { kind: 'and'; of: Expr[] }
  | { kind: 'or'; of: Expr[] };

export function parseExpr(s: string): Expr {
  let i = 0;

  function ws() { while (i < s.length && s[i] === ' ') i++; }

  function leaf(tok: string): Expr {
    if (tok.startsWith('?')) return { kind: 'condition', text: tok.slice(1) };
    const m = tok.match(/^(.*?)(\*)?(?::([A-D][+-]?))?$/)!;
    const e: Expr = { kind: 'course', id: m[1] };
    if (m[3]) e.minGrade = m[3];
    if (m[2]) e.concurrent = true;
    return e;
  }

  function expr(): Expr {
    ws();
    if (s[i] !== '(') {
      const start = i;
      while (i < s.length && !'&|()'.includes(s[i])) i++;
      return leaf(s.slice(start, i).trim());
    }
    i++; // consume (
    const children: Expr[] = [expr()];
    let op: '&' | '|' | null = null;
    ws();
    while (s[i] !== ')') {
      const seen = s[i] as '&' | '|';
      if (seen !== '&' && seen !== '|') throw new Error(`expected & or | at ${i} in "${s}"`);
      if (op === null) op = seen;
      else if (op !== seen) throw new Error(`mixed operators in one group at ${i} in "${s}"`);
      i++; // consume operator
      children.push(expr());
      ws();
    }
    i++; // consume )
    if (children.length === 1) return children[0];
    return op === '|' ? { kind: 'or', of: children } : { kind: 'and', of: children };
  }

  const out = expr();
  ws();
  if (i !== s.length) throw new Error(`trailing input at ${i} in "${s}"`);
  return out;
}