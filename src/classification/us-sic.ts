// US SIC (1987) — the activity vocabulary the American connector actually speaks.
//
// NAICS is the modern US scheme and the obvious thing to reach for. It is the
// wrong one HERE: the only keyless US company source in this tool is SEC EDGAR,
// and EDGAR files every registrant under a 1987 SIC code (`sic`,
// `sicDescription`). Shipping a NAICS table would mean crosswalking every row on
// the way in, and the SIC->NAICS crosswalk is many-to-many. Speak what the
// upstream speaks.
//
// A WARNING THAT IS THE WHOLE REASON THIS FILE IS SEPARATE: US SIC divisions are
// ALSO letters A-K, and they mean entirely different things from NACE's A-U.
// NACE "D" is electricity and gas; SIC "D" is all of manufacturing. A run that
// let `--section D` cross the Atlantic unchanged would return a different
// economy and look completely normal doing it. So a section is never stored or
// compared without its scheme, and `classificationFor()` refuses to hand a
// NACE letter to a NAICS/SIC country.

/** Division letter -> inclusive range of 2-digit SIC major groups. */
export const US_SIC_DIVISIONS: ReadonlyArray<readonly [string, number, number]> = [
  ["A", 1, 9],
  ["B", 10, 14],
  ["C", 15, 17],
  ["D", 20, 39],
  ["E", 40, 49],
  ["F", 50, 51],
  ["G", 52, 59],
  ["H", 60, 67],
  ["I", 70, 89],
  ["J", 91, 97],
  ["K", 99, 99],
];

/** All division letters, in nomenclature order. */
export const US_SIC_SECTIONS: readonly string[] = US_SIC_DIVISIONS.map(([s]) => s);

/** What each SIC division letter means. Deliberately worded so it can never be mistaken for a NACE label. */
export const US_SIC_LABELS: Record<string, string> = {
  A: "Agriculture, forestry, fishing (US SIC)",
  B: "Mining (US SIC)",
  C: "Construction (US SIC)",
  D: "Manufacturing (US SIC)",
  E: "Transport, utilities, communications (US SIC)",
  F: "Wholesale trade (US SIC)",
  G: "Retail trade (US SIC)",
  H: "Finance, insurance, real estate (US SIC)",
  I: "Services (US SIC)",
  J: "Public administration (US SIC)",
  K: "Nonclassifiable (US SIC)",
};

/** The division a 4-digit SIC code belongs to, or undefined if malformed. */
export function usSicDivision(code: string): string | undefined {
  const group = Number.parseInt(code.padStart(4, "0").slice(0, 2), 10);
  if (!Number.isFinite(group)) return undefined;
  return US_SIC_DIVISIONS.find(([, lo, hi]) => group >= lo && group <= hi)?.[0];
}
