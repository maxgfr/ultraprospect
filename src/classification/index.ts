// Which activity vocabulary a country speaks, and how to read a code in it.
//
// `src/render.ts` already models the hard part of this: the register files a
// company under an activity code and OSM tags a shopfront by feature key, and a
// table listing "shop 460 / G 128" side by side reads as one ranking of one
// thing when it is neither. Going multi-country adds a third and a fourth
// vocabulary, so the rule gets stated once, here:
//
//   A SECTION IS NEVER CARRIED WITHOUT ITS SCHEME.
//
// NACE and US SIC both label their top level A, B, C… and they disagree about
// what those letters mean. `place.category` was already namespaced
// (`"naf=62.01Z"`), which is the seam this module formalises.

import { NACE_SECTION_LABELS, NACE_SECTIONS, naceSection } from "./nace.js";
import { US_SIC_LABELS, US_SIC_SECTIONS, usSicDivision } from "./us-sic.js";

/** The vocabularies in play. `none` is honest, not a failure: some registers publish no activity code at all. */
export type ActivityScheme = "nace" | "us-sic" | "none";

export interface ActivityVocabulary {
  scheme: ActivityScheme;
  /** How the scheme names its top level, for help text and error messages. */
  sectionTerm: string;
  /** Every valid section value, in nomenclature order. Empty for `none`. */
  sections: readonly string[];
  /** The section a full code belongs to, or undefined if the code is malformed. */
  sectionOf(code: string): string | undefined;
  /** Plain words for a section, or the raw value when the scheme has no label for it. */
  label(section: string): string;
}

const NACE_VOCABULARY: ActivityVocabulary = {
  scheme: "nace",
  sectionTerm: "NACE section letter",
  sections: NACE_SECTIONS,
  sectionOf: naceSection,
  label: (s) => NACE_SECTION_LABELS[s] ?? s,
};

const US_SIC_VOCABULARY: ActivityVocabulary = {
  scheme: "us-sic",
  sectionTerm: "US SIC division letter",
  sections: US_SIC_SECTIONS,
  sectionOf: usSicDivision,
  label: (s) => US_SIC_LABELS[s] ?? s,
};

const NO_VOCABULARY: ActivityVocabulary = {
  scheme: "none",
  sectionTerm: "activity section",
  sections: [],
  sectionOf: () => undefined,
  label: (s) => s,
};

export const VOCABULARIES: Record<ActivityScheme, ActivityVocabulary> = {
  nace: NACE_VOCABULARY,
  "us-sic": US_SIC_VOCABULARY,
  none: NO_VOCABULARY,
};

/** The vocabulary a scheme name denotes. Unknown names get `none` rather than a throw. */
export function vocabularyOf(scheme: ActivityScheme | undefined): ActivityVocabulary {
  return VOCABULARIES[scheme ?? "none"] ?? NO_VOCABULARY;
}

/**
 * Read a namespaced category back into its parts.
 *
 * `"naf=62.01Z"` -> `{ prefix: "naf", code: "62.01Z" }`, `"shop=bakery"` ->
 * `{ prefix: "shop", code: "bakery" }`. An unprefixed string is not a code in
 * any scheme, so it comes back with no prefix rather than being guessed at.
 */
export function splitCategory(category: string | undefined): { prefix?: string; code?: string } {
  if (!category) return {};
  const at = category.indexOf("=");
  if (at < 0) return { code: category };
  return { prefix: category.slice(0, at), code: category.slice(at + 1) };
}

/**
 * Validate `--section` values against the vocabulary that will actually receive them.
 *
 * Returns the values that are valid plus the ones that are not, rather than
 * throwing on the first bad one: a user who typed `--section J,Zz,M` should be
 * told about `Zz` and still get J and M, and a user who aimed a NACE letter at a
 * US run should be told THAT rather than handed an empty result set.
 */
export function partitionSections(sections: readonly string[], vocabulary: ActivityVocabulary): { valid: string[]; unknown: string[] } {
  if (vocabulary.scheme === "none") return { valid: [], unknown: [...sections] };
  const allowed = new Set(vocabulary.sections);
  const valid: string[] = [];
  const unknown: string[] = [];
  for (const raw of sections) {
    const s = raw.trim().toUpperCase();
    if (!s) continue;
    if (allowed.has(s)) valid.push(s);
    else unknown.push(raw);
  }
  return { valid, unknown };
}

export { NACE_SECTIONS, NACE_SECTION_LABELS, naceSection } from "./nace.js";
export { US_SIC_SECTIONS, US_SIC_LABELS, usSicDivision } from "./us-sic.js";
