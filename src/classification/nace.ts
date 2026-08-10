// NACE rev.2 — the activity vocabulary shared across the European connectors.
//
// This file used to be the bottom half of a generated `src/naf.ts`, which
// misrepresented what it is. The section letters A-U and the 2-digit divisions
// inside them are NOT French: they are NACE rev.2, the EU statistical
// nomenclature, and every national scheme in scope here is derived from it —
// NAF (FR) adds a 5th character, WZ (DE) adds a 5th digit, CNAE (ES) and UK SIC
// 2007 renumber the 4th level. All four agree on the section and the division.
//
// That is what makes `--section J,M` mean the same thing in Lyon, Berlin,
// Madrid and Manchester. The national CODE lists differ and stay in their own
// connectors; the STRUCTURE lives here, once.
//
// NAICS (US) is the one scheme with no NACE lineage — numeric sectors, no
// letters — and it gets its own file rather than a lossy crosswalk. A
// crosswalk exists on paper, is many-to-many, and would let `--section J` quietly
// return a different economy on either side of the Atlantic.

/** Section letter -> inclusive range of 2-digit NACE divisions. */
export const NACE_SECTION_DIVISIONS: ReadonlyArray<readonly [string, number, number]> = [
  ["A", 1, 3],
  ["B", 5, 9],
  ["C", 10, 33],
  ["D", 35, 35],
  ["E", 36, 39],
  ["F", 41, 43],
  ["G", 45, 47],
  ["H", 49, 53],
  ["I", 55, 56],
  ["J", 58, 63],
  ["K", 64, 66],
  ["L", 68, 68],
  ["M", 69, 75],
  ["N", 77, 82],
  ["O", 84, 84],
  ["P", 85, 85],
  ["Q", 86, 88],
  ["R", 90, 93],
  ["S", 94, 96],
  ["T", 97, 98],
  ["U", 99, 99],
];

/** All section letters, in nomenclature order. */
export const NACE_SECTIONS: readonly string[] = NACE_SECTION_DIVISIONS.map(([s]) => s);

/**
 * What each section letter means, in plain words.
 *
 * Hand-written, because no register serves it: the APIs return the code and
 * assume you own the nomenclature. These words are the nomenclature's own
 * definitions, in English so that one report can mix four countries.
 */
export const NACE_SECTION_LABELS: Record<string, string> = {
  A: "Agriculture, forestry, fishing",
  B: "Mining and quarrying",
  C: "Manufacturing",
  D: "Electricity and gas",
  E: "Water, waste, remediation",
  F: "Construction",
  G: "Trade and vehicle repair",
  H: "Transport and storage",
  I: "Hospitality and food service",
  J: "Information and communication",
  K: "Finance and insurance",
  L: "Real estate",
  M: "Professional, scientific, technical",
  N: "Administrative and support services",
  O: "Public administration",
  P: "Education",
  Q: "Health and social work",
  R: "Arts, entertainment, recreation",
  S: "Other services",
  T: "Household employers",
  U: "Extraterritorial bodies",
};

/**
 * The section a NACE-derived code belongs to, or undefined if malformed.
 *
 * Reads the leading two digits and nothing else, which is exactly why it works
 * for all four national schemes: "62.01Z" (NAF), "62.01-0" (WZ), "6201" (CNAE)
 * and "62012" (SIC) all start with the division that decides the section.
 */
export function naceSection(code: string): string | undefined {
  const div = Number.parseInt(code.slice(0, 2), 10);
  if (!Number.isFinite(div)) return undefined;
  return NACE_SECTION_DIVISIONS.find(([, lo, hi]) => div >= lo && div <= hi)?.[0];
}
