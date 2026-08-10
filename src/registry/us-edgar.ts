// The United States — SEC EDGAR, and an honest account of what it is not.
//
// THERE IS NO US COMPANY REGISTER. Registration is a state matter, fifty
// Secretaries of State keep fifty databases, and none of them offers a free
// national API. EDGAR is the only keyless federal source of company identity.
//
// AND IT IS NARROWER THAN "SEC FILERS", which is what the obvious description
// would say. The only stable keyless name->CIK route is `company_tickers.json`,
// and that file lists companies with a LISTED TICKER — 10 398 of them, measured.
// Whole Foods Market is not in it: it still files, but it has had no ticker
// since the Amazon acquisition. So the honest claim is "listed companies", and
// `usEdgarCoverageNote()` is what the report prints.
//
// `cgi-bin/browse-edgar?output=atom` was tried as a wider route and rejected: it
// covers every filer, but it leaks Perl internals into the feed
// (`title="ARRAY(0x55c4522ab770)"`), times out on some queries and answers an
// empty feed for others. A source that is wrong in ways a parser cannot detect
// is worse here than a source that is narrow and says so.
//
// TWO MEASURED FACTS ABOUT ACCESS, both non-obvious:
//
//   1. EDGAR REJECTS THE POLITE USER-AGENT THIS TOOL USES EVERYWHERE ELSE.
//      `ultraprospect/2.0 (+https://github.com/...)` answers HTTP 403 "Your
//      Request Originates from an Undeclared Automated Tool". What it accepts is
//      a bare `name email` string. So this is the one connector that does not
//      call `politeUa()`, and the reason is written down here rather than
//      discovered again in six months.
//   2. It requires `Accept-Encoding: gzip, deflate`.
//
// Activity codes are 1987 US SIC, not NAICS: that is what EDGAR files under, and
// crosswalking on the way in would invent precision the data does not have.
import { awaitHostSlot, httpJson } from "../engine.js";
import { usSicDivision } from "../classification/us-sic.js";
import type { PostalAddress } from "../types.js";
import type { Availability, CanaryCheck, LegalId, LookupQuery, RegistryConnector, RegistryRecord } from "./types.js";

const DATA = "https://data.sec.gov";
const WWW = "https://www.sec.gov";
const CONNECTOR_ID = "us-edgar";
/** The SEC asks for no more than 10 requests a second. We take two. */
const REQUEST_DELAY_MS = 500;

/**
 * The User-Agent EDGAR accepts.
 *
 * Measured: a UA carrying a URL in parentheses is refused with 403 and the
 * message "Your Request Originates from an Undeclared Automated Tool". A bare
 * `<tool> <contact email>` is served. The SEC's own guidance asks for a
 * declared identity and a contact address, and this is the shape it enforces.
 */
function secUa(): string {
  return process.env.ULTRAPROSPECT_SEC_CONTACT ? `ultraprospect ${process.env.ULTRAPROSPECT_SEC_CONTACT}` : "ultraprospect contact@ultraprospect.invalid";
}

async function get(url: string): Promise<any> {
  await awaitHostSlot(url, REQUEST_DELAY_MS);
  const res = await httpJson("GET", url, undefined, {
    timeoutMs: 30_000,
    retries: 1,
    userAgent: secUa(),
    headers: { "accept-encoding": "gzip, deflate" },
  });
  return res.ok ? res.data : undefined;
}

/** cik -> {name, ticker}, from the bulk file. Cached for the process; it is ~200 KB and changes daily. */
let tickerIndex: Array<{ cik: string; name: string; ticker: string }> | undefined;

export async function companyIndex(): Promise<Array<{ cik: string; name: string; ticker: string }>> {
  if (tickerIndex) return tickerIndex;
  const data = await get(`${WWW}/files/company_tickers.json`);
  if (!data || typeof data !== "object") return [];
  tickerIndex = Object.values(data as Record<string, any>)
    .map((e) => ({ cik: String(e?.cik_str ?? "").padStart(10, "0"), name: String(e?.title ?? ""), ticker: String(e?.ticker ?? "") }))
    .filter((e) => e.cik && e.name);
  return tickerIndex;
}

/** Exposed for the tests: the module-level cache must not leak between cases. */
export function resetCompanyIndex(): void {
  tickerIndex = undefined;
}

function addressOf(raw: any): PostalAddress {
  if (!raw) return {};
  const street = [raw?.street1, raw?.street2].filter(Boolean).join(", ");
  return {
    raw: [street, raw?.city, raw?.stateOrCountry, raw?.zipCode].filter(Boolean).join(", ") || undefined,
    libelleVoie: raw?.street1 ?? undefined,
    codePostal: raw?.zipCode ?? undefined,
    commune: raw?.city ?? undefined,
    pays: raw?.stateOrCountry ?? "US",
  };
}

export function toRecord(submissions: any): RegistryRecord | undefined {
  const cik = submissions?.cik;
  if (!cik) return undefined;
  const sic = submissions?.sic ? String(submissions.sic) : undefined;
  const formerNames: string[] = (submissions?.formerNames ?? []).map((f: any) => f?.name).filter(Boolean);
  // `business` is where the company operates; `mailing` is often an agent's
  // office, and a prospect list about an agent's office is about the agent.
  const address = addressOf(submissions?.addresses?.business ?? submissions?.addresses?.mailing);
  return {
    connectorId: CONNECTOR_ID,
    id: String(cik).padStart(10, "0"),
    names: [submissions?.name, ...formerNames].filter(Boolean),
    legalName: submissions?.name ?? undefined,
    officers: [],
    address,
    countryCode: "us",
    activityCode: sic,
    section: sic ? usSicDivision(sic) : undefined,
    // Deliberately not "nace": EDGAR's letters mean different things. See
    // src/classification/us-sic.ts.
    activityScheme: "us-sic",
    legalForm: submissions?.entityType ?? undefined,
    status: "unknown",
    sourceUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${String(cik).padStart(10, "0")}`,
    national: {
      cik: String(cik).padStart(10, "0"),
      tickers: submissions?.tickers ?? undefined,
      sicDescription: submissions?.sicDescription ?? undefined,
      ein: undefined,
      stateOfIncorporation: submissions?.stateOfIncorporation ?? undefined,
    },
  };
}

/** What the report must say about a US run, so an empty result is not read as an empty economy. */
export function usEdgarCoverageNote(): string {
  return "us-edgar: the United States has no national company register. This connector reaches EDGAR's listed companies only — about 10 400 with a traded ticker. A company absent from it is not absent from the economy, and nothing here says it is.";
}

export const usEdgar: RegistryConnector = {
  id: CONNECTOR_ID,
  countries: ["us"],
  label: "United States — SEC EDGAR, listed companies only (~10 400). There is no national US company register.",
  licence: "US filer data: SEC EDGAR, public domain",
  activityScheme: "us-sic",
  activityPrefix: "sic",
  docsUrl: "https://www.sec.gov/search-filings/edgar-application-programming-interfaces",

  availability(): Availability {
    return { available: true };
  },

  async lookup(query: LookupQuery, ctx): Promise<RegistryRecord[]> {
    const name = query.names.find((n) => n?.trim());
    if (!name) return [];
    const index = await companyIndex();
    if (index.length === 0) return [];

    // Substring match on the bulk index rather than EDGAR's full-text search:
    // full-text searches FILING CONTENTS, so "Whole Foods" returns every company
    // that ever mentioned Whole Foods in a filing. That is a different question,
    // and answering it here would attach a supplier's record to a shop.
    const needle = name
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .trim();
    if (needle.length < 3) return [];
    const hits = index.filter((e) => e.name.toLowerCase().includes(needle)).slice(0, Math.min(10, query.limit ?? 5));
    if (hits.length === 0) return [];
    ctx?.onNote?.(usEdgarCoverageNote());

    const out: RegistryRecord[] = [];
    for (const hit of hits) {
      const rec = toRecord(await get(`${DATA}/submissions/CIK${hit.cik}.json`));
      if (rec) out.push(rec);
    }
    return out;
  },

  async verifyId(id: LegalId): Promise<RegistryRecord | undefined> {
    if (id.kind !== "cik") return undefined;
    const cik = id.value.replace(/\D/g, "").padStart(10, "0");
    if (cik === "0000000000") return undefined;
    return toRecord(await get(`${DATA}/submissions/CIK${cik}.json`));
  },

  async canary(): Promise<CanaryCheck[]> {
    const checks: CanaryCheck[] = [];
    const submissions = await get(`${DATA}/submissions/CIK0000320193.json`);
    checks.push({
      name: "EDGAR still serves a bare `name email` User-Agent",
      ok: Boolean(submissions?.cik),
      detail: "a UA carrying a URL is answered 403 'Undeclared Automated Tool' — this connector must not use politeUa()",
    });
    checks.push({ name: "EDGAR submissions still carry sic and sicDescription", ok: Boolean(submissions?.sic && submissions?.sicDescription) });
    checks.push({ name: "EDGAR submissions still carry addresses.business", ok: Boolean(submissions?.addresses?.business?.city) });

    resetCompanyIndex();
    const index = await companyIndex();
    checks.push({
      name: "EDGAR company_tickers.json still maps cik_str + title",
      ok: index.length > 1000,
      detail: `${index.length} companies indexed — this is the only name->CIK route without a key`,
    });
    return checks;
  },

  async probe(): Promise<{ ok: boolean; detail: string }> {
    const submissions = await get(`${DATA}/submissions/CIK0000320193.json`);
    return { ok: Boolean(submissions?.cik), detail: submissions?.name ? `resolved ${submissions.name}` : "no answer (check the User-Agent)" };
  },
};
