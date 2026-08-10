// Finland — PRH / YTJ open data, keyless.
//
// Names arrive as a HISTORY rather than as a field: one array holding every name
// the company has ever had, each with a `type` and, when it has been superseded,
// an `endDate`. Reading it naively attaches a name the company dropped in 2001.
//
//   type "1" — the registered legal name
//   type "2" — a parallel trade name (auxiliary company name)
//   type "3" — an auxiliary trade name (the sign over a particular business)
//
// Current names are the ones with no `endDate`. Expired ones are still worth
// keeping for MATCHING — a shopfront often carries the old name for years — but
// they must never be reported as the company's name, which is why they go to the
// tail of `names` and never to `legalName`.
import { awaitHostSlot, httpJson } from "../engine.js";
import { naceSection } from "../classification/nace.js";
import { politeUa } from "../net.js";
import type { PostalAddress } from "../types.js";
import type { Availability, CanaryCheck, LegalId, LookupQuery, RegistryConnector, RegistryRecord } from "./types.js";

const BASE = "https://avoindata.prh.fi/opendata-ytj-api/v3";
const CONNECTOR_ID = "fi-prh";
const REQUEST_DELAY_MS = 400;

async function get(path: string): Promise<any> {
  const url = `${BASE}${path}`;
  await awaitHostSlot(url, REQUEST_DELAY_MS);
  const res = await httpJson("GET", url, undefined, { timeoutMs: 25_000, retries: 1, userAgent: politeUa() });
  return res.ok ? res.data : undefined;
}

/**
 * The English description, when the API serves one field in three languages.
 *
 * languageCode is "1" Finnish, "2" Swedish, "3" English.
 */
function pickText(list: any[] | undefined, language = "3"): string | undefined {
  if (!Array.isArray(list) || list.length === 0) return undefined;
  return list.find((d) => d?.languageCode === language)?.description ?? list[0]?.description ?? undefined;
}

/** A city name, which PRH serves as a per-language list under its own key rather than as `description`. */
function pickCity(list: any[] | undefined): string | undefined {
  if (!Array.isArray(list) || list.length === 0) return undefined;
  // Finnish first: "ESPOO" is what a Finnish address is written with, "ESBO" is
  // the Swedish exonym for the same place and will not match an OSM `addr:city`.
  return list.find((o) => o?.languageCode === "1")?.city ?? list[0]?.city ?? undefined;
}

function addressOf(list: any[] | undefined): PostalAddress {
  // `type` is a NUMBER here, not a string: 1 is the street address, 2 the postal
  // one (usually a PO box). A prospector wants the door.
  const street = list?.find((a) => a?.type === 1);
  const postal = list?.find((a) => a?.type === 2);
  const a = street ?? postal ?? list?.[0];
  if (!a) return {};
  const line = [a?.street, a?.buildingNumber].filter(Boolean).join(" ");
  const city = pickCity(a?.postOffices);
  return {
    raw: [line, a?.postCode, city].filter(Boolean).join(" ") || undefined,
    libelleVoie: a?.street || undefined,
    numero: a?.buildingNumber || undefined,
    codePostal: a?.postCode ?? undefined,
    commune: city,
    codeCommune: a?.postOffices?.[0]?.municipalityCode ?? undefined,
    pays: "Finland",
  };
}

export function toRecord(company: any): RegistryRecord | undefined {
  const id = company?.businessId?.value;
  if (!id) return undefined;
  const all: any[] = company?.names ?? [];
  const current = all.filter((n) => n?.name && !n.endDate);
  const expired = all.filter((n) => n?.name && n.endDate).map((n) => n.name);
  const legalName = current.find((n) => n.type === "1")?.name ?? current[0]?.name;
  const tradingNames = current.filter((n) => n.type === "2" || n.type === "3").map((n) => n.name);

  const activityCode = company?.mainBusinessLine?.type ?? undefined;
  // MEASURED, over 73 records: `status` is "2" for live companies AND for
  // dissolved ones — it means "registered in YTJ", not "trading". Reading it as
  // liveness reported Nokia as ceased. The discriminators are `endDate`, which
  // is only set once a company has ended, and `tradeRegisterStatus`, which is
  // "1" for every live registration in the sample and "4" for every ended one.
  // Anything else is genuinely unknown and says so.
  const status: RegistryRecord["status"] = company?.endDate ? "ceased" : company?.tradeRegisterStatus === "1" ? "active" : "unknown";
  return {
    connectorId: CONNECTOR_ID,
    id: String(id),
    // Current names first, expired ones last: the matcher takes the best score
    // over the whole list, so an old shopfront name still matches without ever
    // being printed as the company's identity.
    names: [...tradingNames, legalName, ...expired].filter((n): n is string => Boolean(n)),
    legalName,
    tradingNames,
    officers: [],
    address: addressOf(company?.addresses),
    countryCode: "fi",
    activityCode,
    section: activityCode ? naceSection(activityCode) : undefined,
    activityScheme: "nace",
    legalForm: pickText(company?.companyForms?.[0]?.descriptions) ?? company?.companyForms?.[0]?.type ?? undefined,
    dateCreated: company?.registrationDate ?? company?.businessId?.registrationDate ?? undefined,
    dateClosed: company?.endDate ?? undefined,
    status,
    sourceUrl: `https://tietopalvelu.ytj.fi/yritys/${id}`,
    national: { businessId: id, euId: company?.euId?.value ?? undefined },
  };
}

export const fiPrh: RegistryConnector = {
  id: CONNECTOR_ID,
  countries: ["fi"],
  label: "Finland — PRH / YTJ open data",
  licence: "Finnish company data: PRH / YTJ open data, CC BY 4.0",
  activityScheme: "nace",
  activityPrefix: "tol",
  docsUrl: "https://avoindata.prh.fi/ytj_en.html",

  availability(): Availability {
    return { available: true };
  },

  async lookup(query: LookupQuery): Promise<RegistryRecord[]> {
    const name = query.names.find((n) => n?.trim());
    if (!name) return [];
    const params = new URLSearchParams({ name });
    if (query.postcode) params.set("postCode", query.postcode);
    else if (query.locality) params.set("location", query.locality);
    const data = await get(`/companies?${params.toString()}`);
    const limit = query.limit ?? 5;
    return (data?.companies ?? [])
      .slice(0, limit)
      .map(toRecord)
      .filter((r: RegistryRecord | undefined): r is RegistryRecord => Boolean(r));
  },

  async verifyId(id: LegalId): Promise<RegistryRecord | undefined> {
    // A Finnish business ID is 7 digits, a hyphen and a check digit; the VAT
    // number is the same digits with an FI prefix and no hyphen.
    let businessId: string | undefined;
    if (id.kind === "vat") {
      const digits = id.value.replace(/\D/g, "");
      if (digits.length === 8) businessId = `${digits.slice(0, 7)}-${digits.slice(7)}`;
    } else if (/^\d{7}-\d$/.test(id.value.trim())) {
      businessId = id.value.trim();
    }
    if (!businessId) return undefined;
    const data = await get(`/companies?businessId=${encodeURIComponent(businessId)}`);
    return toRecord(data?.companies?.[0]);
  },

  async canary(): Promise<CanaryCheck[]> {
    const data = await get("/companies?businessId=0112038-9");
    const company = data?.companies?.[0];
    const rec = toRecord(company);
    return [
      { name: "PRH still answers a businessId lookup with companies[]", ok: Boolean(company?.businessId?.value) },
      {
        name: "PRH status is still NOT a liveness flag (a live company still reports status 2)",
        ok: company?.status === "2" && !company?.endDate,
        detail: "if status ever became a liveness flag, tradeRegisterStatus is no longer needed",
      },
      {
        name: "PRH still returns addresses[].postOffices[].city with a numeric type",
        ok: typeof company?.addresses?.[0]?.type === "number" && Boolean(company?.addresses?.[0]?.postOffices?.[0]?.city),
      },
      {
        name: "PRH still returns names[] as a history with type and endDate",
        ok: Array.isArray(company?.names) && company.names.some((n: any) => n?.type) && company.names.some((n: any) => n?.endDate),
        detail: "reading this array without honouring endDate attaches a name the company dropped decades ago",
      },
      { name: "PRH still resolves a current legal name (type 1, no endDate)", ok: Boolean(rec?.legalName) },
    ];
  },

  async probe(): Promise<{ ok: boolean; detail: string }> {
    const data = await get("/companies?businessId=0112038-9");
    const rec = toRecord(data?.companies?.[0]);
    return { ok: Boolean(rec), detail: rec ? `resolved ${rec.legalName}` : "no answer" };
  },
};
