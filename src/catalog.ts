// Loads and merges every per-department catalog file, then parses each
// course's prereq and recommended strings into trees. Everything downstream
// imports from here, never from the JSON directly.
//
// Department files live at ./data/catalog-<DEPT>.json, shape { courses: [...] }.
// import.meta.glob picks up however many exist at build time -- adding or
// removing a department is just adding or removing a file, no code change.
//
// `recommended` uses the identical grammar as `prereq` (&, |, parens,
// :GRADE) but lives in its own field entirely, never merged into prereq.
// A recommendation is advisory, not a requirement: it must never affect
// tier depth, the immediate-relatives count, or the AND/OR boxes, all of
// which only ever read `prereq`. Keeping it a separate field is what makes
// that automatic -- nothing has to remember to exclude it.
import { parseExpr, type Expr } from './parse';

export interface Course {
  id: string;
  title: string;
  prereq: Expr | null;
  recommended: Expr | null;
  [extra: string]: unknown;
}

interface DomainFile {
  courses: { id: string; title: string; prereq: string | null; recommended?: string | null }[];
}

function loadDomainFiles(): Record<string, DomainFile> {
  // Vite statically rewrites this EXACT call at build time -- it must be
  // written directly, as a literal import.meta.glob(...) call, not assigned
  // through a variable or accessed as a property first, or its scanner
  // never finds it and import.meta.glob stays undefined in the real bundle.
  try {
    const modules = import.meta.glob('./data/catalog-*.json', { eager: true }) as
      Record<string, { default: DomainFile }>;
    if (Object.keys(modules).length > 0) {
      return Object.fromEntries(Object.entries(modules).map(([path, mod]) => [path, mod.default]));
    }
  } catch {
    // not running under Vite (e.g. a quick tsx sanity check) -- fall through
  }
  const { readdirSync, readFileSync } = require('fs');
  const { join, dirname } = require('path');
  const dataDir = join(dirname(new URL(import.meta.url).pathname), 'data');
  const out: Record<string, DomainFile> = {};
  for (const f of readdirSync(dataDir)) {
    if (f.startsWith('catalog-') && f.endsWith('.json')) {
      out[`./data/${f}`] = JSON.parse(readFileSync(join(dataDir, f), 'utf8'));
    }
  }
  return out;
}

const modules = loadDomainFiles();

const raw = Object.entries(modules).flatMap(([path, mod]) => {
  const courses = mod.courses ?? [];
  return courses.map((c) => ({ ...c, __source: path }));
});

// guard against the same course id appearing in two department files
const seen = new Map<string, string>();
for (const c of raw) {
  if (seen.has(c.id) && seen.get(c.id) !== c.__source) {
    console.warn(`duplicate course id "${c.id}" in both ${seen.get(c.id)} and ${c.__source}`);
  }
  seen.set(c.id, c.__source);
}

export const CATALOG: Course[] = raw.map(({ __source, ...c }) => ({
  ...c,
  prereq: c.prereq ? parseExpr(c.prereq) : null,
  recommended: c.recommended ? parseExpr(c.recommended) : null,
}));

export const DOMAIN_FILES = Object.keys(modules);