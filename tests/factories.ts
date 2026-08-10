// Fixtures shared across the suite.
//
// `RegistryRecord` has enough required fields that spelling one out inline made
// every test read as a data dump with one interesting line in it. These builders
// fill the boring parts so a test can say only what it is about — which is also
// what keeps a new field on the record from touching forty test files.
import type { RegistryRecord } from "../src/registry/types.js";

/**
 * A register record, French by default because that is the connector every
 * behaviour was measured against.
 *
 * `names` is derived from `legalName`/`tradingNames` unless a case sets it
 * explicitly, so a test about naming can change one and stay coherent.
 */
export function rec(over: Partial<RegistryRecord> = {}): RegistryRecord {
  const legalName = over.legalName ?? "NATURALIA FRANCE";
  const tradingNames = over.tradingNames ?? [];
  return {
    connectorId: "fr-sirene",
    id: "302474648",
    establishmentId: "30247464801175",
    names: over.names ?? [...tradingNames, legalName],
    legalName,
    tradingNames,
    activityScheme: "nace",
    officers: [],
    address: {},
    // A Vincennes doorstep. The matcher refuses any pair without coordinates, so
    // a record with none would make every scoring test measure the same zero.
    lat: 48.8475,
    lon: 2.4397,
    countryCode: "fr",
    status: "active",
    ...over,
  };
}
