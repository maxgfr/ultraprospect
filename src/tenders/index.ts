// The tender sources, and which of them answer for a country.
//
// Order matters, exactly as for registers: national portals first, because
// they are the only census below the EU thresholds; TED next; worldwide
// funders last. De-duplication keeps the FIRST copy of a notice it sees, so
// the order is also which copy survives — the national one, in the buyer's own
// language and with the national identifiers.
import { euTed } from "./eu-ted.js";
import { frBoamp } from "./fr-boamp.js";
import { auAustender, deOeffentlichevergabe, gbContractsFinder, gbFts } from "./ocds-sources.js";
import type { TenderConnector, TenderCoverage } from "./types.js";
import { brPncp, caCanadabuys, coSecop, uaProzorro, usSam, usUsaspending, wwWorldBank } from "./world-sources.js";

export const TENDER_CONNECTORS: readonly TenderConnector[] = [
  frBoamp,
  deOeffentlichevergabe,
  gbFts,
  gbContractsFinder,
  caCanadabuys,
  usSam,
  usUsaspending,
  auAustender,
  brPncp,
  uaProzorro,
  coSecop,
  euTed,
  wwWorldBank,
];

export function tenderConnectorById(id: string): TenderConnector | undefined {
  return TENDER_CONNECTORS.find((c) => c.id === id);
}

export function servesCountry(c: TenderConnector, country: string): boolean {
  return c.countries.includes("*") || c.countries.includes(country);
}

/**
 * The connectors for a set of countries, and — the part that matters — what
 * the run will NOT see because of it.
 *
 * `gaps` names every country whose only source is above-threshold (TED alone)
 * or which no source serves at all. Those are the countries where the web lane
 * (`tenders --queries`) is not an optimisation but the only way to see the
 * national market, and the report says so by name.
 */
export function tenderConnectorsFor(
  countries: readonly string[],
  opts: { only?: readonly string[]; includeWorldwide?: boolean } = {},
): { connectors: TenderConnector[]; gaps: { country: string; coverage: TenderCoverage | "none" }[] } {
  const pool = TENDER_CONNECTORS.filter((c) => !opts.only?.length || opts.only.includes(c.id));
  const connectors = new Set<TenderConnector>();
  const gaps: { country: string; coverage: TenderCoverage | "none" }[] = [];
  for (const country of countries) {
    const serving = pool.filter((c) => !c.countries.includes("*") && servesCountry(c, country));
    for (const c of serving) connectors.add(c);
    const coverages = new Set(serving.map((c) => c.coverage));
    if (serving.length === 0) gaps.push({ country, coverage: "none" });
    else if (!coverages.has("all") && !(coverages.has("above-threshold") && coverages.has("below-threshold")))
      gaps.push({ country, coverage: "above-threshold" });
  }
  if (countries.length === 0) for (const c of pool) if (!c.countries.includes("*")) connectors.add(c);
  if (opts.includeWorldwide || countries.length === 0 || gaps.some((g) => g.coverage === "none")) {
    for (const c of pool) if (c.countries.includes("*")) connectors.add(c);
  }
  return { connectors: TENDER_CONNECTORS.filter((c) => connectors.has(c)), gaps };
}

export {
  euTed,
  frBoamp,
  gbFts,
  gbContractsFinder,
  auAustender,
  deOeffentlichevergabe,
  caCanadabuys,
  usSam,
  usUsaspending,
  brPncp,
  uaProzorro,
  coSecop,
  wwWorldBank,
};
