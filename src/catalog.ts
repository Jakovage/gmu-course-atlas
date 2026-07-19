// Loads the raw catalog and parses every prereq string into a tree.
// Everything downstream imports from here, never from the JSON directly.
import raw from './data/catalog.json';
import { parseExpr, type Expr } from './parse';

export interface Course {
  id: string;
  title: string;
  prereq: Expr | null;
  [extra: string]: unknown;   // future fields flow through untouched
}

export const CATALOG: Course[] = raw.courses.map((c) => ({
  ...c,                        // carry every field the data has
  prereq: c.prereq ? parseExpr(c.prereq) : null,
}));