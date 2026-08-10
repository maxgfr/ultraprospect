// Czechia — ARES, the Ministry of Finance's register of economic subjects.
//
// Keyless, no registration, and it answers a name search by POST rather than by
// query string — the one connector here that does, which is why it does not
// share the GET helper the others use.
//
// Activity codes are CZ-NACE and arrive as a RAGGED array: "29100", "471",
// "24", "00" all appear in one record, because CZ-NACE is published at whatever
// level the subject registered. The first entry is the principal activity. "00"
// is a placeholder and resolves to no section, so the section is taken from the
// first code that actually resolves rather than from the first code full stop.
import { awaitHostSlot, httpJson } from "../engine.js";
import { naceSection } from "../classification/nace.js";
import { politeUa } from "../net.js";
import type { PostalAddress } from "../types.js";
import type { Availability, CanaryCheck, LegalId, LookupQuery, RegistryConnector, RegistryRecord } from "./types.js";

const BASE = "https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty";
const CONNECTOR_ID = "cz-ares";
const REQUEST_DELAY_MS = 400;

async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  const url = `${BASE}${path}`;
  await awaitHostSlot(url, REQUEST_DELAY_MS);
  const res = await httpJson(method, url, body, { timeoutMs: 25_000, retries: 1, userAgent: politeUa() });
  return res.ok ? res.data : undefined;
}

function addressOf(raw: any): PostalAddress {
  if (!raw) return {};
  const psc = raw?.psc != null ? String(raw.psc) : undefined;
  return {
    raw: raw?.textovaAdresa ?? undefined,
    libelleVoie: raw?.nazevUlice ?? raw?.nazevCastiObce ?? undefined,
    numero: raw?.cisloDomovni != null ? String(raw.cisloDomovni) : undefined,
    codePostal: psc,
    commune: raw?.nazevObce ?? undefined,
    // The state's own municipality code, the closest thing Czechia has to an
    // INSEE code.
    codeCommune: raw?.kodObce != null ? String(raw.kodObce) : undefined,
    pays: raw?.nazevStatu ?? "Česká republika",
  };
}

/** The first CZ-NACE code that resolves to a section. "00" and other placeholders do not. */
function principalActivity(codes: unknown): { code?: string; section?: string } {
  if (!Array.isArray(codes)) return {};
  for (const raw of codes) {
    const code = typeof raw === "string" ? raw : undefined;
    if (!code) continue;
    const section = naceSection(code);
    if (section) return { code, section };
  }
  return { code: typeof codes[0] === "string" ? codes[0] : undefined };
}

export function toRecord(subject: any): RegistryRecord | undefined {
  const ico = subject?.ico;
  if (!ico) return undefined;
  const { code, section } = principalActivity(subject?.czNace2008);
  const registrations = subject?.seznamRegistraci ?? {};
  // "AKTIVNI" / "ZANIKLY" / "NEEXISTUJICI", per source register. The commercial
  // register (Vr) is the authoritative one for a company; the economic-subject
  // register (Res) covers sole traders too.
  const live = registrations.stavZdrojeVr === "AKTIVNI" || registrations.stavZdrojeRes === "AKTIVNI";
  const dead = registrations.stavZdrojeVr === "ZANIKLY" || registrations.stavZdrojeRes === "ZANIKLY";
  return {
    connectorId: CONNECTOR_ID,
    id: String(ico),
    names: [subject?.obchodniJmeno].filter(Boolean),
    legalName: subject?.obchodniJmeno ?? undefined,
    officers: [],
    address: addressOf(subject?.sidlo),
    countryCode: "cz",
    activityCode: code,
    section,
    activityScheme: "nace",
    legalForm: subject?.pravniForma ?? undefined,
    dateCreated: subject?.datumVzniku ?? undefined,
    dateClosed: subject?.datumZaniku ?? undefined,
    status: dead ? "ceased" : live ? "active" : "unknown",
    sourceUrl: `https://ares.gov.cz/ekonomicke-subjekty/${ico}`,
    national: { ico: String(ico), dic: subject?.dic ?? undefined, czNace2008: subject?.czNace2008 ?? undefined },
  };
}

export const czAres: RegistryConnector = {
  id: CONNECTOR_ID,
  countries: ["cz"],
  label: "Czechia — ARES (Ministry of Finance register of economic subjects)",
  licence: "Czech company data: ARES, Ministerstvo financí ČR, open data",
  activityScheme: "nace",
  activityPrefix: "cz-nace",
  docsUrl: "https://ares.gov.cz/stranky/vyvojar-info",

  availability(): Availability {
    return { available: true };
  },

  async lookup(query: LookupQuery): Promise<RegistryRecord[]> {
    const name = query.names.find((n) => n?.trim());
    if (!name) return [];
    const limit = Math.min(20, query.limit ?? 5);
    const body: Record<string, unknown> = { obchodniJmeno: name, start: 0, pocet: limit };
    if (query.locality) body.sidlo = { nazevObce: query.locality };
    const data = await call("POST", "/vyhledat", body);
    return (data?.ekonomickeSubjekty ?? []).map(toRecord).filter((r: RegistryRecord | undefined): r is RegistryRecord => Boolean(r));
  },

  async verifyId(id: LegalId): Promise<RegistryRecord | undefined> {
    // The IČO is eight digits and is also the body of the Czech VAT number
    // ("CZ00177041"). ARES pads short IČO with leading zeros.
    const digits = id.value.replace(/\D/g, "");
    if (!digits || digits.length > 8) return undefined;
    if (id.kind !== "vat" && id.kind !== "ico" && id.kind !== "company-number") return undefined;
    return toRecord(await call("GET", `/${digits.padStart(8, "0")}`));
  },

  async canary(): Promise<CanaryCheck[]> {
    const one = await call("GET", "/00177041");
    const found = await call("POST", "/vyhledat", { obchodniJmeno: "Škoda Auto", start: 0, pocet: 2 });
    const rec = toRecord(one);
    return [
      { name: "ARES still answers a GET by IČO", ok: Boolean(one?.ico) },
      {
        name: "ARES still answers a POST name search with ekonomickeSubjekty[]",
        ok: Array.isArray(found?.ekonomickeSubjekty) && found.ekonomickeSubjekty.length > 0,
      },
      { name: "ARES still returns sidlo with nazevObce and psc", ok: Boolean(one?.sidlo?.nazevObce && one?.sidlo?.psc) },
      {
        name: "ARES czNace2008 still resolves to a NACE section",
        ok: Boolean(rec?.section),
        detail: "the array is ragged — 5-digit, 3-digit and placeholder codes in one record",
      },
    ];
  },

  async probe(): Promise<{ ok: boolean; detail: string }> {
    const rec = toRecord(await call("GET", "/00177041"));
    return { ok: Boolean(rec), detail: rec ? `resolved ${rec.legalName}` : "no answer" };
  },
};
