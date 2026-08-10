// The connector table, and the only place that decides which register runs where.
//
// Before this file the answer lived in one line of `scan.ts`:
//
//     const registerApplies = target.countryCode === "fr";
//
// which was accurate and unextendable. Now a country's register support is a row
// in `CONNECTORS`, and FIVE separate things read that same row: the sweep lane,
// the confirm pass, `doctor`'s probes, `manifest.licences`, and the weekly
// canary. That is the point. The alternative — a list here, a switch in doctor,
// a hardcoded count in the eval workflow — is the drift `engine-repin.yml`
// already warns about: "the automation cannot drift from the list it is supposed
// to be watching."
//
// Adding a country is one import and one array entry.
import { czAres } from "./cz-ares.js";
import { euVies } from "./eu-vies.js";
import { fiPrh } from "./fi-prh.js";
import { frSirene } from "./fr-sirene.js";
import { gbCompaniesHouse } from "./gb-companies-house.js";
import { gleif } from "./gleif.js";
import { noBrreg } from "./no-brreg.js";
import { plKrs } from "./pl-krs.js";
import { usEdgar } from "./us-edgar.js";
import type { Availability, ConnectorContext, RegistryConnector, RegistryRecord } from "./types.js";

/**
 * Every connector, in the order they should be TRIED.
 *
 * Order is behaviour, not presentation: `connectorsFor` returns `confirm` in
 * this order and `confirm` takes the first answer. National registers come
 * first because they are authoritative for their own country and hold the whole
 * economy; the cross-border authorities come last because each knows strictly
 * less. VIES says a VAT number is live and, for about half the member states,
 * nothing else. GLEIF knows every country and only the ~2.7 million entities
 * that hold an LEI.
 *
 * Adding a country is one import and one entry. Nothing else in the tree needs
 * to hear about it: the sweep lane, `confirm`, `doctor`, `manifest.licences`
 * and the weekly canary all read this array.
 */
export const CONNECTORS: readonly RegistryConnector[] = [
  // National registers, authoritative for their own country.
  frSirene,
  gbCompaniesHouse,
  noBrreg,
  fiPrh,
  czAres,
  plKrs,
  usEdgar,
  // Cross-border authorities. Broad reach, narrow answers.
  euVies,
  gleif,
];

export function connectorById(id: string): RegistryConnector | undefined {
  return CONNECTORS.find((c) => c.id === id);
}

/** Does this connector serve this country? `["*"]` means everywhere. */
export function servesCountry(connector: RegistryConnector, countryCode: string | undefined): boolean {
  if (connector.countries.includes("*")) return true;
  if (!countryCode) return false;
  return connector.countries.includes(countryCode.toLowerCase());
}

export interface ConnectorSelection {
  /** The one connector that can enumerate this territory, if any. */
  sweep?: RegistryConnector;
  /** Connectors that can confirm a company found by another lane, best first. */
  confirm: RegistryConnector[];
  /** Connectors that serve the country but cannot run — no key, typically. Never silently dropped. */
  unavailable: Array<{ connector: RegistryConnector; availability: Availability }>;
}

export interface SelectOptions {
  /** Restrict to these connector ids. An id that serves no country here is reported, not ignored. */
  only?: string[];
  ctx?: ConnectorContext;
}

/**
 * Which connectors apply to a country, split by what they can actually do.
 *
 * A connector that declares no `sweep` is NOT a degraded sweep connector. It is
 * a different kind of answer, and the caller has to treat it as one — which is
 * why they come back in separate fields rather than as one list the caller has
 * to introspect.
 */
export function connectorsFor(countryCode: string | undefined, opts: SelectOptions = {}): ConnectorSelection {
  const ctx = opts.ctx ?? {};
  const only = opts.only?.length ? new Set(opts.only.map((s) => s.trim().toLowerCase()).filter(Boolean)) : undefined;

  const selection: ConnectorSelection = { confirm: [], unavailable: [] };
  for (const connector of CONNECTORS) {
    if (only && !only.has(connector.id)) continue;
    if (!servesCountry(connector, countryCode)) continue;

    const availability = connector.availability(ctx);
    if (!availability.available) {
      selection.unavailable.push({ connector, availability });
      continue;
    }
    if (connector.sweep && !selection.sweep) selection.sweep = connector;
    if (connector.lookup || connector.verifyId) selection.confirm.push(connector);
  }
  return selection;
}

/** Connector ids named in `--registry` that match no connector at all. A typo must not read as "no register here". */
export function unknownConnectorIds(only: readonly string[] | undefined): string[] {
  if (!only?.length) return [];
  const known = new Set(CONNECTORS.map((c) => c.id));
  return only.map((s) => s.trim().toLowerCase()).filter((s) => s && !known.has(s));
}

/**
 * The sentence the manifest and the report use when a country has no sweep.
 *
 * Deliberately not "unavailable" and not an error. Outside France no public
 * register can be swept without a key; that is a property of the world, and
 * saying it plainly is the difference between an honest run and one that reads
 * like a failure.
 */
export function noSweepReason(countryCode: string | undefined, selection: ConnectorSelection): string {
  const where = countryCode ? `country=${countryCode}` : "country unknown";
  if (selection.confirm.length) {
    const names = selection.confirm.map((c) => c.id).join(", ");
    return `no register can be swept for ${where}; OSM covered the territory and ${names} can confirm each company (run \`confirm\`)`;
  }
  if (selection.unavailable.length) {
    const blocked = selection.unavailable
      .map(({ connector, availability }) => `${connector.id} (${availability.available ? "" : availability.reason})`)
      .join(", ");
    return `no register ran for ${where}: ${blocked}`;
  }
  return `no register connector covers ${where}; the territory is OSM-only and the list is not a register extract`;
}

/**
 * The register's own words for a headcount band.
 *
 * A band code is meaningless without the connector that issued it: "12" is
 * 20-49 employees in France and nothing at all in Norway. So the lookup goes
 * through the connector, and an unknown code comes back as itself rather than
 * as a confident mistranslation.
 */
export function sizeBandLabel(record: Pick<RegistryRecord, "connectorId">, band: string | undefined): string | undefined {
  if (!band) return undefined;
  const bands = connectorById(record.connectorId)?.sizeBands;
  return bands?.find((b) => b.code === band)?.label ?? band;
}

/**
 * The smallest headcount a record is consistent with, or undefined when unknown.
 *
 * An exact number beats a band, and a band that means "undetermined" is not
 * evidence of zero employees — it is evidence of nothing, and must not let a
 * `--min-employees` filter through.
 */
export function employeeFloor(record: Pick<RegistryRecord, "connectorId" | "employees" | "sizeBand" | "parent">): number | undefined {
  if (typeof record.employees === "number") return record.employees;
  const bands = connectorById(record.connectorId)?.sizeBands;
  if (!bands) return undefined;
  const code = record.parent?.sizeBand ?? record.sizeBand;
  const floor = bands.find((b) => b.code === code)?.floor;
  return typeof floor === "number" && floor >= 0 ? floor : undefined;
}

export * from "./types.js";
export { czAres } from "./cz-ares.js";
export { euVies } from "./eu-vies.js";
export { fiPrh } from "./fi-prh.js";
export { frSirene } from "./fr-sirene.js";
export { gbCompaniesHouse } from "./gb-companies-house.js";
export { gleif } from "./gleif.js";
export { noBrreg } from "./no-brreg.js";
export { plKrs } from "./pl-krs.js";
export { usEdgar } from "./us-edgar.js";
