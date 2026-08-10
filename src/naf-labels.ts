// What each NAF section letter means, in plain words.
//
// Hand-written, and in its OWN file rather than in src/naf.ts — which is
// generated from the register's validation error and overwritten wholesale on
// every refresh. These labels lived there once and vanished the first time the
// catalogue was regenerated; a generated file has one owner, and it is not us.
//
// The codes come from the API. The words come from the nomenclature's
// definition, which the API does not serve.
export const NAF_SECTION_LABELS: Record<string, string> = {
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
