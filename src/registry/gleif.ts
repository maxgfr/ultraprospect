// Worldwide — GLEIF, the Global LEI Index.
//
// Keyless, no registration, no quota form, and the only company-identity source
// in this tool that answers about every country. It is also the answer to the
// German problem: an LEI record carries `entity.registeredAs`, which for a
// German entity is its Handelsregister number —
//
//   Zalando SE -> lei 529900YRFFGH5AXU4S86, registeredAs "HRB 158855",
//                 legalAddress Valeska-Gert-Straße 5, 10243 Berlin, status ACTIVE
//
// — so an HRB number read off an Impressum can be turned into a filed identity
// with no key, for any entity that holds an LEI.
//
// WHAT IT DOES NOT COVER, said plainly because the coverage shape decides
// whether a run is worth anything: an LEI is obtained by entities that trade in
// financial markets, and there are roughly 2.7 million of them worldwide against
// tens of millions of companies. A high street of independent shops will match
// almost none of them. This connector is strong for larger companies and
// near-useless for local retail, and the report has to be able to say which.
import { awaitHostSlot, httpJson } from "../engine.js";
import { politeUa } from "../net.js";
import type { PostalAddress } from "../types.js";
import type { Availability, CanaryCheck, ConnectorContext, LegalId, LookupQuery, RegistryConnector, RegistryRecord } from "./types.js";

const BASE = "https://api.gleif.org/api/v1";
const CONNECTOR_ID = "gleif";
const REQUEST_DELAY_MS = 400;

async function get(path: string): Promise<any> {
  const url = `${BASE}${path}`;
  await awaitHostSlot(url, REQUEST_DELAY_MS);
  const res = await httpJson("GET", url, undefined, {
    timeoutMs: 25_000,
    retries: 1,
    userAgent: politeUa(),
    // GLEIF speaks JSON:API and answers `application/vnd.api+json`.
    headers: { accept: "application/vnd.api+json" },
  });
  return res.ok ? res.data : undefined;
}

function addressOf(raw: any): PostalAddress {
  const lines: string[] = (raw?.addressLines ?? []).filter(Boolean);
  return {
    raw: [lines.join(", "), raw?.postalCode, raw?.city].filter(Boolean).join(" ") || undefined,
    libelleVoie: lines[0],
    codePostal: raw?.postalCode ?? undefined,
    commune: raw?.city ?? undefined,
    pays: raw?.country ?? undefined,
  };
}

export function toRecord(entry: any): RegistryRecord | undefined {
  const a = entry?.attributes;
  const lei = a?.lei;
  if (!lei) return undefined;
  const legalName = a?.entity?.legalName?.name;
  const otherNames: string[] = (a?.entity?.otherNames ?? []).map((n: any) => n?.name).filter(Boolean);
  const country = (a?.entity?.legalAddress?.country ?? "").toLowerCase() || undefined;
  return {
    connectorId: CONNECTOR_ID,
    id: lei,
    names: [...otherNames, legalName].filter(Boolean),
    legalName,
    tradingNames: otherNames,
    officers: [],
    address: addressOf(a?.entity?.legalAddress ?? a?.entity?.headquartersAddress),
    countryCode: country,
    legalForm: a?.entity?.legalForm?.id ?? undefined,
    // ACTIVE / INACTIVE is the ENTITY's status. A lapsed LEI registration
    // (`registration.status`) says the entity stopped paying for its LEI, which
    // is not the same as the company having closed — conflating them would
    // report live companies as ceased.
    status: a?.entity?.status === "ACTIVE" ? "active" : a?.entity?.status === "INACTIVE" ? "ceased" : "unknown",
    activityScheme: "none",
    sourceUrl: `https://search.gleif.org/#/record/${lei}`,
    national: {
      lei,
      // The national register's own number for this entity — "HRB 158855" in
      // Germany, a SIREN in France, a company number in the UK.
      registeredAs: a?.entity?.registeredAs ?? undefined,
      registrationAuthority: a?.entity?.registeredAt?.id ?? undefined,
      leiRegistrationStatus: a?.registration?.status ?? undefined,
    },
  };
}

/** The register number GLEIF holds for an entity, normalised for comparison. */
function registeredAs(rec: RegistryRecord): string | undefined {
  const value = rec.national?.registeredAs;
  return typeof value === "string" ? value.replace(/[\s.]/g, "").toUpperCase() : undefined;
}

/**
 * Named `queryRecords` rather than `search`: the vendored engine already exports
 * a `search`, and `pnpm run verify:engine` refuses any module that declares a
 * name the engine owns. Re-exporting is fine; a second implementation is the
 * regression that gate exists to catch.
 */
async function queryRecords(params: Record<string, string>, limit: number): Promise<RegistryRecord[]> {
  const qs = new URLSearchParams({ ...params, "page[size]": String(Math.min(50, Math.max(1, limit))) });
  const data = await get(`/lei-records?${qs.toString()}`);
  return (data?.data ?? []).map(toRecord).filter((r: RegistryRecord | undefined): r is RegistryRecord => Boolean(r));
}

export const gleif: RegistryConnector = {
  id: CONNECTOR_ID,
  countries: ["*"],
  label: "Worldwide — Global LEI Index (GLEIF). Covers entities that hold an LEI, not every company.",
  licence: "Legal entity data: Global LEI Index, GLEIF, CC0 1.0",
  activityScheme: "none",
  activityPrefix: "lei",
  docsUrl: "https://www.gleif.org/en/lei-data/gleif-api",

  availability(): Availability {
    return { available: true };
  },

  async lookup(query: LookupQuery): Promise<RegistryRecord[]> {
    const name = query.names.find((n) => n?.trim());
    if (!name) return [];
    const country = query.countryCode?.toUpperCase();
    // Exact legal name first: it is precise and cheap. `fulltext` is the fallback
    // because it also matches an entity that merely MENTIONS the name, which is a
    // candidate rather than an answer — the caller scores it either way.
    const filters: Record<string, string> = { "filter[entity.legalName]": name };
    if (country) filters["filter[entity.legalAddress.country]"] = country;
    const exact = await queryRecords(filters, query.limit ?? 5);
    if (exact.length) return exact;

    const loose: Record<string, string> = { "filter[fulltext]": name };
    if (country) loose["filter[entity.legalAddress.country]"] = country;
    return queryRecords(loose, query.limit ?? 5);
  },

  async verifyId(id: LegalId): Promise<RegistryRecord | undefined> {
    if (id.kind === "lei") {
      const data = await get(`/lei-records/${encodeURIComponent(id.value.toUpperCase())}`);
      return toRecord(data?.data);
    }
    // A national register number — a German HRB, most usefully. GLEIF indexes it
    // as `entity.registeredAs`, but the filter is not exposed, so the entity is
    // found by full text and the number is then checked EXACTLY. A fuzzy hit
    // whose registeredAs does not match is somebody else's company.
    const wanted = id.value.replace(/[\s.]/g, "").toUpperCase();
    if (!wanted) return undefined;
    const params: Record<string, string> = { "filter[fulltext]": id.value };
    if (id.countryCode) params["filter[entity.legalAddress.country]"] = id.countryCode.toUpperCase();
    const hits = await queryRecords(params, 10);
    return hits.find((rec) => registeredAs(rec) === wanted);
  },

  async canary(): Promise<CanaryCheck[]> {
    const checks: CanaryCheck[] = [];

    const byName = await queryRecords({ "filter[entity.legalName]": "Zalando SE", "filter[entity.legalAddress.country]": "DE" }, 2);
    const first = byName[0];
    checks.push({ name: "GLEIF still answers an exact legalName + country filter", ok: Boolean(first?.id) });
    checks.push({
      name: "GLEIF still returns entity.legalAddress with country and postalCode",
      ok: Boolean(first?.address.pays && first?.address.codePostal),
    });
    // The German path depends entirely on this field. Without it an HRB number
    // read off an Impressum can be confirmed by nothing at all.
    checks.push({
      name: "GLEIF still returns entity.registeredAs (the national register number)",
      ok: Boolean(registeredAs(first ?? ({} as RegistryRecord))?.startsWith("HRB")),
      detail: `registeredAs = ${String(first?.national?.registeredAs ?? "absent")} — the only keyless route from a German HRB number to a filed identity`,
    });

    return checks;
  },

  async probe(): Promise<{ ok: boolean; detail: string }> {
    const hits = await queryRecords({ "filter[entity.legalName]": "Zalando SE" }, 1);
    return { ok: hits.length > 0, detail: hits.length ? `${hits.length} record(s)` : "no answer" };
  },
};

/** Exposed so `confirm` can report the coverage caveat rather than implying a full register. */
export function gleifCoverageNote(): string {
  return "gleif: an LEI is held by entities that trade in financial markets — roughly 2.7 million worldwide. A street of independent shops will match almost none of them.";
}

