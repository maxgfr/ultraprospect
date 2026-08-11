// The United Kingdom — Companies House.
//
// The only register in this tool that comes close to France's for a territory,
// and the only one here behind a credential. The key is free — an email address
// at developer.company-information.service.gov.uk, no payment, no approval — but
// it is still a key, and this tool's promise is that it works without one. So:
//
//   * Without a key the connector reports itself UNAVAILABLE, with the steps to
//     get one, and the run continues. It never throws, and it never lets an
//     absent key read as an empty register.
//   * With a key it does what no other non-French connector can: search by
//     company name AND filter by locality and SIC through `/advanced-search`,
//     which is a partial territory sweep. Partial because it takes a locality
//     string rather than a radius or a bounding box, so it cannot be aligned
//     with the OSM lane's geometry — hence `sweep` is deliberately NOT declared.
//     Claiming a sweep whose shape does not match the requested area would put a
//     "whole territory" label on a different territory.
//
// Authentication is HTTP Basic with the key as the username and an empty
// password, which is unusual enough to be worth stating: `Authorization: Basic
// base64(key + ":")`.
import { awaitHostSlot, backOffHost, httpJson } from "../engine.js";
import { naceSection } from "../classification/nace.js";
import { politeUa } from "../net.js";
import type { PostalAddress } from "../types.js";
import type { Availability, CanaryCheck, ConnectorContext, LegalId, LookupQuery, RegistryConnector, RegistryRecord } from "./types.js";

const BASE = "https://api.company-information.service.gov.uk";
const CONNECTOR_ID = "gb-companies-house";
/** 600 requests per five minutes is the published ceiling. We pace well under it. */
const REQUEST_DELAY_MS = 600;
/**
 * How long every OTHER queued request for this host waits after a 429.
 *
 * `awaitHostSlot` paces us under the ceiling; it cannot know we have already
 * crossed it. Without this, hitting the limit on company 40 of 200 means hitting
 * it again on 41, 42 and 43 — and because a failed lookup used to read as "no
 * such company", the run would have reported a hundred real businesses as
 * unregistered. Thirty seconds is well inside the five-minute window the quota
 * resets on.
 */
const RATE_LIMIT_BACKOFF_MS = 30_000;

/** Thrown when the register could not be asked, as opposed to answering nothing. */
class RateLimited extends Error {}

const HOW_TO_GET_A_KEY =
  "Register at https://developer.company-information.service.gov.uk (email only, free, no payment), create an application, then pass --companies-house-key or set ULTRAPROSPECT_COMPANIES_HOUSE_KEY.";

function keyFrom(ctx: ConnectorContext): string | undefined {
  const key = ctx.keys?.[CONNECTOR_ID] ?? process.env.ULTRAPROSPECT_COMPANIES_HOUSE_KEY;
  return key?.trim() || undefined;
}

async function get(path: string, key: string): Promise<{ ok: boolean; status: number; data: any }> {
  const url = `${BASE}${path}`;
  await awaitHostSlot(url, REQUEST_DELAY_MS);
  const res = await httpJson("GET", url, undefined, {
    timeoutMs: 25_000,
    retries: 1,
    userAgent: politeUa(),
    // The key is the Basic username and the password is empty. Not a bearer
    // token, whatever the word "key" suggests.
    headers: { authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}` },
  });
  // A 429 is not an answer about a company. Push the whole host's next departure
  // out so the rest of this run's queue waits rather than spending the next
  // forty requests discovering the same limit.
  if (res.status === 429) backOffHost(url, RATE_LIMIT_BACKOFF_MS);
  return { ok: res.ok, status: res.status, data: res.data };
}

function addressOf(raw: any): PostalAddress {
  if (!raw) return {};
  const street = [raw?.premises, raw?.address_line_1, raw?.address_line_2].filter(Boolean).join(" ");
  return {
    raw: [street, raw?.locality, raw?.postal_code].filter(Boolean).join(", ") || undefined,
    libelleVoie: raw?.address_line_1 ?? undefined,
    numero: raw?.premises ?? undefined,
    codePostal: raw?.postal_code ?? undefined,
    commune: raw?.locality ?? undefined,
    pays: raw?.country ?? "United Kingdom",
  };
}

/**
 * UK SIC 2007 is NACE-derived, so its first two digits ARE the NACE division.
 *
 * The codes are five digits with no separator: "62012" is division 62,
 * NACE section J. That is why `--section J` means the same thing in Manchester
 * as in Lyon, while the full codes do not compare below the division.
 */
function sectionOf(sicCodes: unknown): { code?: string; section?: string } {
  const first = Array.isArray(sicCodes) ? sicCodes.find((c) => typeof c === "string") : undefined;
  if (typeof first !== "string") return {};
  return { code: first, section: naceSection(first) };
}

export function toRecord(company: any): RegistryRecord | undefined {
  const number = company?.company_number;
  if (!number) return undefined;
  const previous: string[] = (company?.previous_company_names ?? []).map((p: any) => p?.name).filter(Boolean);
  const { code, section } = sectionOf(company?.sic_codes);
  const status = company?.company_status;
  return {
    connectorId: CONNECTOR_ID,
    id: String(number).toUpperCase(),
    names: [company?.company_name, ...previous].filter(Boolean),
    legalName: company?.company_name ?? undefined,
    officers: [],
    address: addressOf(company?.registered_office_address),
    countryCode: "gb",
    activityCode: code,
    section,
    activityScheme: "nace",
    // The company profile resource calls this `type`; every SEARCH resource
    // calls it `company_type`. `lookup` goes through /advanced-search first, so
    // reading only `type` dropped the legal form on the primary path and kept it
    // on the fallback — silently, and on every hit.
    legalForm: company?.type ?? company?.company_type ?? undefined,
    dateCreated: company?.date_of_creation ?? undefined,
    dateClosed: company?.date_of_cessation ?? undefined,
    // "active" is the only status that means trading. "dissolved", "liquidation"
    // and "administration" are all not-active and must not be flattened to it.
    status: status === "active" ? "active" : status ? "ceased" : "unknown",
    sourceUrl: `https://find-and-update.company-information.service.gov.uk/company/${number}`,
    national: { companyNumber: String(number).toUpperCase(), companyStatus: status ?? undefined, sicCodes: company?.sic_codes ?? undefined },
  };
}

export const gbCompaniesHouse: RegistryConnector = {
  id: CONNECTOR_ID,
  countries: ["gb"],
  label: "United Kingdom — Companies House (free key required)",
  licence: "UK company data: Companies House, Open Government Licence v3.0",
  activityScheme: "nace",
  activityPrefix: "sic-uk",
  docsUrl: "https://developer-specs.company-information.service.gov.uk/",
  needsKey: { flag: "--companies-house-key", env: "ULTRAPROSPECT_COMPANIES_HOUSE_KEY", how: HOW_TO_GET_A_KEY },
  unverified: {
    // Worded from what is actually known, and it is less than nothing but far
    // less than a working path. A deliberately invalid key was sent once: the
    // host resolved and answered HTTP 401, which proves the URL and that the
    // Basic-auth header is PARSED. It proves nothing about a valid key, and
    // nothing at all about the response bodies this file maps — no 200 from
    // Companies House has ever reached this code.
    why: "no successful response from Companies House has ever reached this code. An invalid key draws a 401, so the host and the Basic-auth scheme (key as username, empty password) are confirmed to that extent; every field `toRecord` reads is still mapped from the specification rather than from an observed body. It is the only connector here behind a credential, and its canary has reported inconclusive on every scheduled run for want of a key.",
    how: "supply a key and run `pnpm run eval:network`; three assertions are already written and waiting. The keyless snapshot route needs no key and is the one exercised by default.",
  },

  availability(ctx: ConnectorContext): Availability {
    if (keyFrom(ctx)) return { available: true };
    return { available: false, reason: "no Companies House key was supplied", how: HOW_TO_GET_A_KEY };
  },

  async lookup(query: LookupQuery, ctx: ConnectorContext): Promise<RegistryRecord[]> {
    const key = keyFrom(ctx);
    const name = query.names.find((n) => n?.trim());
    if (!key || !name) return [];
    const limit = Math.min(20, query.limit ?? 5);

    // Advanced search first: it takes a locality, which is what turns a common
    // name into one company. It answers `items` with the company already
    // expanded, so no second request per hit.
    //
    // `company_status=active` is not a convenience. Without it a dissolved shell
    // sharing a trading name scores exactly as well as the business standing at
    // the address, and `confirm` attaches on name agreement — so a live shop
    // would acquire a dead company's registration and read as dissolved
    // downstream forever. `fr-sirene` pins `etatAdministratif: "A"` for the same
    // reason. A company that really has ceased is `watch`'s finding to make from
    // a swept register, never a name lookup's.
    //
    // `query.postcode` is deliberately NOT sent. A UK registered office is very
    // often the company's accountant, not its premises, so narrowing on the
    // postcode OSM saw at the door would discard correct matches — the opposite
    // of the mistake it looks like it prevents.
    const params = new URLSearchParams({ company_name_includes: name, size: String(limit), company_status: "active" });
    if (query.locality) params.set("location", query.locality);
    const advanced = await get(`/advanced-search/companies?${params.toString()}`, key);
    if (advanced.ok && Array.isArray(advanced.data?.items) && advanced.data.items.length) {
      return advanced.data.items.map(toRecord).filter((r: RegistryRecord | undefined): r is RegistryRecord => Boolean(r));
    }
    if (advanced.status === 401 || advanced.status === 403) {
      ctx.onNote?.(`companies-house: the key was rejected (HTTP ${advanced.status}). ${HOW_TO_GET_A_KEY}`);
      return [];
    }
    // Rate limited: the register was NOT asked about this company. Throwing says
    // so; returning [] would have it recorded as having no register entry.
    if (advanced.status === 429) {
      ctx.onNote?.(
        "companies-house: rate limited (600 requests per 5 minutes). Backing off; the places not asked about are counted apart from the ones not found.",
      );
      throw new RateLimited("companies-house rate limit");
    }

    // Plain search returns a thinner item — enough to identify, not enough to
    // fill a record — so each hit is fetched by number.
    const basic = await get(`/search/companies?q=${encodeURIComponent(name)}&items_per_page=${limit}`, key);
    if (basic.status === 429) throw new RateLimited("companies-house rate limit");
    const numbers: string[] = (basic.data?.items ?? [])
      .map((i: any) => i?.company_number)
      .filter(Boolean)
      .slice(0, limit);
    const out: RegistryRecord[] = [];
    for (const number of numbers) {
      const one = await get(`/company/${encodeURIComponent(number)}`, key);
      const rec = toRecord(one.data);
      if (rec) out.push(rec);
    }
    return out;
  },

  async verifyId(id: LegalId, ctx: ConnectorContext): Promise<RegistryRecord | undefined> {
    const key = keyFrom(ctx);
    if (!key) return undefined;
    // Company numbers only. A UK VAT number is NOT the company number and cannot
    // be derived from it, so there is nothing to attempt — the two clauses this
    // replaces admitted `vat` and then rejected it one line later, which read as
    // an unfinished thought rather than a decision.
    if (id.kind !== "company-number") return undefined;
    // Eight characters: eight digits, or a two-letter prefix and six digits for
    // Scotland (SC), Northern Ireland (NI) and the others. Anchored on the total
    // length, so a prefix glued to eight digits is rejected rather than padded.
    const number = id.value.replace(/\s+/g, "").toUpperCase();
    if (!/^(\d{6,8}|[A-Z]{2}\d{6})$/.test(number)) return undefined;
    const padded = /^\d+$/.test(number) ? number.padStart(8, "0") : number;
    const res = await get(`/company/${encodeURIComponent(padded)}`, key);
    if (res.status === 401 || res.status === 403) {
      ctx.onNote?.(`companies-house: the key was rejected (HTTP ${res.status}). ${HOW_TO_GET_A_KEY}`);
      return undefined;
    }
    // Not an answer about this number. `undefined` here would be indistinguishable
    // from "no such company", which is the one thing it must not be.
    if (res.status === 429) throw new RateLimited("companies-house rate limit");
    return toRecord(res.data);
  },

  async canary(ctx: ConnectorContext): Promise<CanaryCheck[]> {
    const key = keyFrom(ctx);
    if (!key) {
      // Not a failure. The canary's job is to notice upstream drift, and an
      // absent key means we learn nothing either way — reporting it as red is
      // how a canary teaches people to ignore it.
      return [
        {
          name: "companies-house: skipped, no key supplied",
          ok: true,
          inconclusive: true,
          detail: HOW_TO_GET_A_KEY,
        },
      ];
    }
    // 00000006 is one of the oldest live registrations and is not going away.
    const res = await get("/company/00000006", key);
    const rec = toRecord(res.data);
    return [
      { name: "Companies House still authenticates a key as the Basic username", ok: res.status !== 401, detail: `HTTP ${res.status}` },
      { name: "Companies House still returns company_name and registered_office_address", ok: Boolean(rec?.legalName && rec?.address.codePostal) },
      { name: "Companies House sic_codes still resolve to a NACE section", ok: Boolean(rec?.section || !res.data?.sic_codes?.length) },
    ];
  },

  async probe(ctx: ConnectorContext): Promise<{ ok: boolean; detail: string }> {
    const key = keyFrom(ctx);
    if (!key) return { ok: false, detail: `no key — ${HOW_TO_GET_A_KEY}` };
    const res = await get("/company/00000006", key);
    return { ok: res.ok, detail: res.ok ? `resolved ${res.data?.company_name}` : `HTTP ${res.status}` };
  },
};
