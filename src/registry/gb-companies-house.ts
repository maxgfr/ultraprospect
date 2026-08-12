// The United Kingdom — Companies House.
//
// The SECOND register in this tool that can be enumerated over a territory, and
// the first one that took an open-data file rather than an API to get there.
//
// TWO ROUTES, AND THE KEYLESS ONE IS THE PRIMARY.
//
//   * THE FREE COMPANY DATA PRODUCT. A monthly snapshot of every live company on
//     the register — 470 MB of zipped CSV at download.companieshouse.gov.uk, no
//     key, no registration, Open Government Licence v3.0. `ingest --country gb`
//     fetches and indexes it once; after that `sweep`, `lookup` and `verifyId`
//     are local reads. This is what lets a British run keep the tool's promise
//     that it works without credentials.
//
//   * THE REST API, when somebody has a key. Free (an email address, no payment)
//     and a day fresher than the snapshot, which is its only advantage and a real
//     one for `verifyId`. Never required. Authentication is HTTP Basic with the
//     key as the USERNAME and an empty password — unusual enough to state:
//     `Authorization: Basic base64(key + ":")`.
//
// WHAT THE SWEEP IS, EXACTLY. The snapshot files each company under its
// registered office's POST TOWN and postcode. That is a locality, not a bounding
// box, so it cannot be aligned with the OSM lane's geometry, and the coverage
// reason says so in words instead of letting "sweep" imply otherwise. It is still
// an enumeration — every company the register holds for that post town — which is
// categorically more than the per-company confirmation available elsewhere.
//
// And the shape of a UK registered office is worth knowing before trusting an
// address from here: it is very often the company's accountant rather than its
// premises. That is why the postcode is never used to NARROW a lookup, and why a
// swept record's address never overwrites what a mapper saw at the door.
import { awaitHostSlot, backOffHost, httpJson } from "../engine.js";
import { naceSection } from "../classification/nace.js";
import { politeUa } from "../net.js";
import { hasSnapshot, snapshotByLocality, snapshotById, snapshotMeta, type SnapshotSource } from "../snapshot.js";
import { nameSimilarity, normalizeName, shortLabel } from "../util.js";
import type { GeoTarget, PostalAddress } from "../types.js";
import type {
  Availability,
  CanaryCheck,
  ConnectorContext,
  LegalId,
  LookupQuery,
  RegistryConnector,
  RegistryFilters,
  RegistryRecord,
  SweepResult,
} from "./types.js";

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
 * UK SIC 2007 is NACE-derived, so its first two digits ARE the NACE division —
 * EXCEPT at the top of the range, where the UK added codes of its own.
 *
 * The codes are five digits with no separator: "62012" is division 62, NACE
 * section J. That is why `--section J` means the same thing in Manchester as in
 * Lyon, while the full codes do not compare below the division.
 *
 * The exception was found by sweeping a real town. `99999` is not an activity at
 * all — it is "Dormant company", a UK administrative code — but division 99 DOES
 * exist in NACE, so mapping it through produced section U, "activities of
 * extraterritorial organisations and bodies". Fourteen dormant shells in Hebden
 * Bridge were filed as extraterritorial organisations, and `--section U` would
 * have returned them. `98000` ("residents property management") is the same kind
 * of code.
 *
 * So they resolve to NO section. The code is kept — dormancy is a real and useful
 * fact — but it is recorded as what it is rather than translated into a
 * classification the UK never meant by it. An unclassified row is honest; a
 * confidently wrong one is the failure this tool exists to refuse.
 */
const ADMINISTRATIVE_SIC: Record<string, string> = {
  "99999": "dormant company",
  "98000": "residents property management",
};

export function sectionOfSic(code: string | undefined): { code?: string; section?: string; administrative?: string } {
  if (!code) return {};
  const administrative = ADMINISTRATIVE_SIC[code];
  if (administrative) return { code, administrative };
  return { code, section: naceSection(code) };
}

function sectionOf(sicCodes: unknown): { code?: string; section?: string; administrative?: string } {
  const first = Array.isArray(sicCodes) ? sicCodes.find((c) => typeof c === "string") : undefined;
  return typeof first === "string" ? sectionOfSic(first) : {};
}

export function toRecord(company: any): RegistryRecord | undefined {
  const number = company?.company_number;
  if (!number) return undefined;
  const previous: string[] = (company?.previous_company_names ?? []).map((p: any) => p?.name).filter(Boolean);
  const { code, section, administrative } = sectionOf(company?.sic_codes);
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
    national: {
      companyNumber: String(number).toUpperCase(),
      companyStatus: status ?? undefined,
      sicCodes: company?.sic_codes ?? undefined,
      administrativeSic: administrative,
    },
  };
}

// ---------------------------------------------------------------------------
// The keyless route: the Free Company Data Product.
// ---------------------------------------------------------------------------

const SNAPSHOT_BASE = "https://download.companieshouse.gov.uk";

/**
 * The URL of a month's snapshot, `back` months before `now`.
 *
 * The file is always dated the 1st, and Companies House publishes it "within 5
 * working days of the previous month end" — so on the 3rd of a month the current
 * file does not exist yet and the previous one is the correct answer. Hence a
 * candidate list rather than a single URL: `ingest` walks it and takes the first
 * that answers, which makes a run on the 2nd behave the same as one on the 20th.
 */
function snapshotUrl(now: Date, back: number): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
  const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
  return `${SNAPSHOT_BASE}/BasicCompanyDataAsOneFile-${month}.zip`;
}

/**
 * The SIC field carries the code AND its label in one string.
 *
 * "62012 - Business and domestic software development". Splitting matters because
 * `naceSection` needs the digits: handed the whole string it resolves nothing, and
 * every British row would arrive with no section while looking populated.
 */
function sicOf(text: string | undefined): { code?: string; section?: string; administrative?: string } {
  return sectionOfSic(text?.trim().match(/^(\d{4,5})/)?.[1]);
}

/** Companies House writes "Active", "Dissolved", "Liquidation"… in the CSV. */
function statusOf(raw: string | undefined): "active" | "ceased" | "unknown" {
  const s = raw?.trim().toLowerCase();
  if (!s) return "unknown";
  return s === "active" ? "active" : "ceased";
}

export const companiesHouseSnapshot: SnapshotSource = {
  format: "csv.zip",
  // Three candidates: this month, and the two before it. Two is enough for the
  // publication lag; the third covers a month the product was late.
  urls: (now) => [0, 1, 2].map((back) => snapshotUrl(now, back)),
  licence: "UK company data: Companies House, Open Government Licence v3.0",
  approxBytes: 493_000_000,
  // MEASURED on a full ingest: 5 695 465 records, 4138 MB. The first estimate here
  // was 1.8 GB, reasoned from "one identifier per record and no officers" — and it
  // was wrong by more than a factor of two, which made the sentence printed before
  // the download a promise the command did not keep. Estimates in this file are
  // measured or they are not written.
  approxDiskBytes: 4_200_000_000,

  parse(row: Record<string, string>) {
    const number = row.CompanyNumber?.trim();
    const name = row.CompanyName?.trim();
    if (!number || !name) return undefined;

    const { code, section, administrative } = sicOf(row["SICCode.SicText_1"]);
    const previous = [1, 2, 3, 4, 5].map((n) => row[`PreviousName_${n}.CompanyName`]?.trim()).filter((x): x is string => Boolean(x));
    const postTown = row["RegAddress.PostTown"]?.trim();
    const street = [row["RegAddress.AddressLine1"], row["RegAddress.AddressLine2"]]
      .map((s) => s?.trim())
      .filter(Boolean)
      .join(", ");

    const address: PostalAddress = {
      raw: [street, postTown, row["RegAddress.PostCode"]?.trim()].filter(Boolean).join(", ") || undefined,
      libelleVoie: row["RegAddress.AddressLine1"]?.trim() || undefined,
      codePostal: row["RegAddress.PostCode"]?.trim() || undefined,
      commune: postTown || undefined,
      pays: row["RegAddress.Country"]?.trim() || "United Kingdom",
    };

    const record: RegistryRecord = {
      connectorId: CONNECTOR_ID,
      id: number.toUpperCase(),
      names: [name, ...previous],
      legalName: name,
      officers: [],
      address,
      countryCode: "gb",
      activityCode: code,
      section,
      activityScheme: "nace",
      legalForm: row.CompanyCategory?.trim() || undefined,
      status: statusOf(row.CompanyStatus),
      dateCreated: row.IncorporationDate?.trim() || undefined,
      dateClosed: row.DissolutionDate?.trim() || undefined,
      sourceUrl: `https://find-and-update.company-information.service.gov.uk/company/${number}`,
      national: {
        companyNumber: number.toUpperCase(),
        companyStatus: row.CompanyStatus?.trim() || undefined,
        sicCodes: code ? [code] : undefined,
        // "dormant company" is not an activity, and a prospect list is usually
        // better without one. Recorded so it can be filtered rather than silently
        // dropped or silently mistranslated.
        administrativeSic: administrative,
      },
    };
    return { record, localities: postTown ? [postTown] : [], ids: [number] };
  },
};

/** Does a record pass the run's register filters? Shared by sweep and lookup. */
function passesFilters(rec: RegistryRecord, filters: RegistryFilters): boolean {
  if (!filters.includeCeased && rec.status === "ceased") return false;
  if (filters.sections?.length && (!rec.section || !filters.sections.includes(rec.section))) return false;
  if (filters.activityCodes?.length && (!rec.activityCode || !filters.activityCodes.some((c) => rec.activityCode?.startsWith(c)))) return false;
  return true;
}

export const gbCompaniesHouse: RegistryConnector = {
  id: CONNECTOR_ID,
  countries: ["gb"],
  label: "United Kingdom — Companies House (keyless monthly snapshot; a free key adds a live API)",
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

  snapshot: companiesHouseSnapshot,

  availability(ctx: ConnectorContext): Availability {
    // Either route is enough, and the keyless one is listed first because it is
    // the one that keeps this tool's promise. An absent key stopped being a reason
    // to skip the United Kingdom the day the snapshot landed.
    if (hasSnapshot(CONNECTOR_ID)) return { available: true };
    if (keyFrom(ctx)) return { available: true };
    return {
      available: false,
      reason: "no Companies House snapshot has been ingested and no key was supplied",
      how: "run `ultraprospect ingest --country gb` for the keyless monthly snapshot (470 MB, no registration), or supply a key for the live API",
    };
  },

  /**
   * Enumerate the companies the register holds for a territory's post town.
   *
   * A sweep, and the coverage says exactly what kind. Only France's register can
   * be enumerated by a bounding box; here the unit is the registered office's post
   * town, which does not coincide with the OSM lane's geometry. Both facts belong
   * in the manifest, so both are in `reason` — the alternative is a "whole
   * territory" label sitting on a slightly different territory, which is the one
   * failure this tool exists to refuse.
   */
  async sweep(target: GeoTarget, filters: RegistryFilters, ctx: ConnectorContext): Promise<SweepResult> {
    const notes: string[] = [];
    const town = shortLabel(target.label || target.query);
    const meta = snapshotMeta(CONNECTOR_ID);
    if (!meta) {
      return {
        records: [],
        notes: ["companies-house: no snapshot ingested, so the register lane could not be swept. Run `ultraprospect ingest --country gb`."],
        coverage: {
          lane: "registry",
          connectorId: CONNECTOR_ID,
          requested: 0,
          returned: 0,
          truncated: true,
          reason: "no Companies House snapshot in the cache; run `ingest --country gb` (470 MB, keyless) to enumerate the United Kingdom",
        },
      };
    }

    const max = filters.maxResults ?? 3000;
    const all = await snapshotByLocality(CONNECTOR_ID, town, (r) => passesFilters(r, filters), max + 1);
    const truncated = all.length > max;
    const records = truncated ? all.slice(0, max) : all;
    ctx.onProgress?.(records.length, town);

    return {
      records,
      notes,
      coverage: {
        lane: "registry",
        mode: "sweep",
        connectorId: CONNECTOR_ID,
        requested: max,
        returned: records.length,
        truncated,
        // Both halves of the truth, in the order a reader needs them.
        reason: truncated
          ? `enumerated from the ${meta.lastModified ? `${meta.lastModified.slice(0, 16)} ` : ""}Companies House snapshot by POST TOWN "${town}", and stopped at --max-results ${max}. A post town is not a bounding box, so this lane's shape does not coincide with the OSM lane's.`
          : `enumerated from the Companies House monthly snapshot by POST TOWN "${town}" — every company the register files there. A post town is not a bounding box, so this lane's shape does not coincide with the OSM lane's, and a company registered at an accountant's address in another town is absent from it.`,
      },
    };
  },

  async lookup(query: LookupQuery, ctx: ConnectorContext): Promise<RegistryRecord[]> {
    const name = query.names.find((n) => n?.trim());
    if (!name) return [];
    const limit = Math.min(20, query.limit ?? 5);

    // The snapshot first: keyless, and already local. Only the register's own
    // post town is searched, for the same reason the API is given a `location`.
    if (hasSnapshot(CONNECTOR_ID) && query.locality) {
      const needle = normalizeName(name);
      const hits = await snapshotByLocality(
        CONNECTOR_ID,
        query.locality,
        (r) => r.status !== "ceased" && r.names.some((n) => nameSimilarity(n, name) >= 0.6 || normalizeName(n).includes(needle)),
        limit,
      );
      if (hits.length) return hits;
    }

    const key = keyFrom(ctx);
    if (!key) return [];

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

    // The snapshot answers this keylessly and exactly — a company number is a
    // primary key, so there is no scoring to do and nothing to be uncertain about.
    if (hasSnapshot(CONNECTOR_ID)) {
      const hit = (await snapshotById(CONNECTOR_ID, padded))[0];
      if (hit) return hit;
    }

    const key = keyFrom(ctx);
    if (!key) return undefined;
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
    const checks: CanaryCheck[] = [];

    // THE SNAPSHOT PATH IS THE PRIMARY ONE, so it is probed first and without a
    // key. It is also the more fragile of the two: the URL encodes a date, so a
    // change in the file's naming or publication cadence turns `ingest` into a
    // 404 with no other symptom — the same silent-drift risk the API canary
    // exists for, on the route that actually runs.
    //
    // The candidate list is walked exactly as `ingest` walks it, so this fails
    // only when EVERY candidate is gone rather than when the current month is
    // merely not published yet.
    const candidates = companiesHouseSnapshot.urls(new Date());
    let served: { url: string; length: number } | undefined;
    for (const url of candidates) {
      const res = await fetch(url, { method: "HEAD", headers: { "user-agent": politeUa() } }).catch(() => undefined);
      if (res?.ok) {
        served = { url, length: Number(res.headers.get("content-length") ?? 0) };
        break;
      }
    }
    checks.push({
      name: "the Free Company Data Product is still published under a dated monthly URL",
      ok: Boolean(served),
      detail: served
        ? `${served.url} (${Math.round(served.length / 1e6)} MB)`
        : `none of ${candidates.length} candidate months answered — the naming or the cadence changed`,
    });
    if (served && served.length > 0) {
      // A snapshot that suddenly halves is a different product, not a smaller
      // month. Generous bounds: this is drift detection, not a size assertion.
      checks.push({
        name: "the snapshot is still roughly half a gigabyte",
        ok: served.length > 200e6 && served.length < 1.5e9,
        detail: `${Math.round(served.length / 1e6)} MB`,
      });
    }

    const key = keyFrom(ctx);
    if (!key) {
      // Not a failure. The canary's job is to notice upstream drift, and an
      // absent key means we learn nothing either way about the API — reporting
      // it as red is how a canary teaches people to ignore it. The snapshot
      // checks above ran regardless, which is the point of doing them first.
      checks.push({
        name: "companies-house API: skipped, no key supplied",
        ok: true,
        inconclusive: true,
        detail: HOW_TO_GET_A_KEY,
      });
      return checks;
    }
    // 00000006 is one of the oldest live registrations and is not going away.
    const res = await get("/company/00000006", key);
    const rec = toRecord(res.data);
    checks.push(
      { name: "Companies House still authenticates a key as the Basic username", ok: res.status !== 401, detail: `HTTP ${res.status}` },
      { name: "Companies House still returns company_name and registered_office_address", ok: Boolean(rec?.legalName && rec?.address.codePostal) },
      { name: "Companies House sic_codes still resolve to a NACE section", ok: Boolean(rec?.section || !res.data?.sic_codes?.length) },
    );
    return checks;
  },

  async probe(ctx: ConnectorContext): Promise<{ ok: boolean; detail: string }> {
    const key = keyFrom(ctx);
    if (!key) return { ok: false, detail: `no key — ${HOW_TO_GET_A_KEY}` };
    const res = await get("/company/00000006", key);
    return { ok: res.ok, detail: res.ok ? `resolved ${res.data?.company_name}` : `HTTP ${res.status}` };
  },
};
