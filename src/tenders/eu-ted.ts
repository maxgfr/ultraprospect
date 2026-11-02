// TED — Tenders Electronic Daily, the EU's official journal of procurement.
//
// Measured on 2026-11-02 against api.ted.europa.eu/v3, anonymous:
//
// - The search endpoint needs NO key. POST an "expert query" and a field list.
// - `classification-cpv IN (72000000)` is HIERARCHICAL: it returned 72250000
//   and 72310000 notices. So a CPV prefix is sent as its padded division code.
// - `FT~(term)` is a full-text match across every language version.
// - Contract award notices (`can-*`) carry the winners' own identifiers —
//   "609801535", "938 703 626 00011" for French buyers: SIREN and SIRET — plus
//   `duration-period-value-lot` and `contract-conclusion-date`. That is the
//   whole basis of the renewal forecast in `awards`.
// - Pagination is by iteration token (`paginationMode: ITERATION`), and
//   `totalNoticeCount` is reported; a page is at most 250 notices.
// - `procedure-identifier` is the eForms ContractFolderID: the same UUID BOAMP
//   publishes as `contractfolderid` and the German export as `tender.id`.
// - An unknown field name is answered with a 400 listing all 1 830 supported
//   fields, not ignored. Asking for one is therefore safe to discover with.
//
// What TED is NOT: the national market. Member states publish to TED above the
// EU thresholds (≈ €140k for central-government services, €5.5M for works).
// Below them, TED holds what a buyer volunteered. The lane says "above-threshold"
// and the report repeats it; a national connector, where one exists, carries
// the rest.
import { awaitHostSlot, httpJson } from "../engine.js";
import { politeUa } from "../net.js";
import type { NoticeKind, SearchOutcome, Tender, TenderAward, TenderConnector, TenderQuery } from "./types.js";
import {
  COUNTRY_LANG,
  EU27,
  ISO3,
  allLang,
  cpvDigits,
  cpvFull,
  dayOf,
  durationMonths,
  iso2,
  keepByQuery,
  lang2,
  money,
  natureOf,
  pickLang,
  statusFromDeadline,
} from "./util.js";

const URL_SEARCH = "https://api.ted.europa.eu/v3/notices/search";
const CONNECTOR_ID = "eu-ted";
const PAGE = 100;

export const TED_FIELDS = [
  "publication-number",
  "procedure-identifier",
  "notice-identifier",
  "notice-type",
  "notice-title",
  "publication-date",
  "buyer-name",
  "buyer-country",
  "buyer-city",
  "organisation-identifier-buyer",
  "classification-cpv",
  "contract-nature",
  "procedure-type",
  "description-lot",
  "title-lot",
  "estimated-value-lot",
  "estimated-value-cur-lot",
  "deadline-receipt-tender-date-lot",
  "deadline-receipt-tender-time-lot",
  "document-url-lot",
  "submission-url-lot",
  "place-of-performance",
  "award-criterion-name-lot",
  "award-criterion-number-weight-lot",
  "winner-name",
  "winner-identifier",
  "winner-country",
  "winner-size",
  "contract-conclusion-date",
  "duration-period-value-lot",
  "duration-period-unit-lot",
  "total-value",
  "total-value-cur",
];

/** eForms notice-type codes, grouped into the kinds this tool reasons about. */
export function kindOfNoticeType(t: string | undefined): NoticeKind {
  const s = (t ?? "").toLowerCase();
  if (s.startsWith("can") || s === "veat") return "award";
  if (s.startsWith("cn") || s === "qu-sy" || s === "subco") return "call";
  if (s.startsWith("pin")) return "prior";
  if (s.startsWith("corr") || s.startsWith("mod")) return "modification";
  return "call";
}

const TYPES_FOR: Record<NoticeKind, string[]> = {
  call: ["cn-standard", "cn-social", "cn-desg", "subco", "qu-sy"],
  award: ["can-standard", "can-social", "can-desg", "can-tran", "can-modif", "veat"],
  prior: ["pin-only", "pin-buyer", "pin-rtl", "pin-tran", "pin-cfc-standard", "pin-cfc-social"],
  modification: ["corr", "can-modif"],
  cancellation: [],
};

/** Build TED's expert query from a TenderQuery. Exported for tests. */
export function tedQuery(q: TenderQuery): string {
  const parts: string[] = [];
  const countries = q.countries.map((c) => ISO3[c]).filter(Boolean);
  if (countries.length) parts.push(`buyer-country IN (${countries.join(" ")})`);
  const cpv = q.cpv.length ? `classification-cpv IN (${[...new Set(q.cpv.map(cpvFull))].join(" ")})` : undefined;
  const ft = q.keywords.length ? `FT~(${q.keywords.map((k) => `"${k.replace(/"/g, "")}"`).join(" OR ")})` : undefined;
  if (cpv && ft) parts.push((q.match ?? "any") === "all" ? `${cpv} AND ${ft}` : `(${cpv} OR ${ft})`);
  else if (cpv ?? ft) parts.push((cpv ?? ft)!);
  const types = [...new Set(q.kinds.flatMap((k) => TYPES_FOR[k] ?? []))];
  if (types.length) parts.push(`notice-type IN (${types.join(" ")})`);
  if (q.publishedFrom) parts.push(`publication-date>=${q.publishedFrom.replace(/-/g, "")}`);
  if (q.publishedTo) parts.push(`publication-date<=${q.publishedTo.replace(/-/g, "")}`);
  // Newest first. Measured: TED's default order is OLDEST first, so a two-year
  // awards window capped at --limit read the oldest notices of the window —
  // and an unbounded query read 2016, before eForms, where no winner carries an
  // identifier at all.
  return `${parts.join(" AND ") || "publication-date>=20000101"} SORT BY publication-date DESC`;
}

/**
 * A winner identifier that is a registration number, not a platform's internal
 * reference. Measured on TED: "1819914-1-0-1", "1896386-1-2-1" — lot/tender
 * bookkeeping that would otherwise pass for a company identity.
 */
export function isRegistrationId(raw: string | undefined): boolean {
  const v = (raw ?? "").trim();
  if (!v || !/\d{5,}/.test(v.replace(/\s/g, ""))) return false;
  return !/^\d+(-\d+){2,}$/.test(v);
}

function firstArr(v: unknown): string | undefined {
  const s = Array.isArray(v) ? (v.find((x) => typeof x === "string") as string | undefined) : typeof v === "string" ? v : undefined;
  // Measured: TED serves document URLs with their ampersands HTML-escaped ("&amp;type=DCE").
  return s?.replace(/&amp;/g, "&");
}

export function toTender(n: any, now = new Date()): Tender | undefined {
  const noticeId = n?.["publication-number"];
  if (!noticeId) return undefined;
  const country = iso2(firstArr(n["buyer-country"])) ?? "eu";
  const prefer = [COUNTRY_LANG[country] ?? "eng", "eng"];
  const title = pickLang(n["notice-title"], prefer);
  const buyerName = pickLang(n["buyer-name"], prefer).text ?? "";
  const kind = kindOfNoticeType(n["notice-type"]);
  const cpv = [...new Set(((n["classification-cpv"] ?? []) as unknown[]).map(cpvDigits).filter((c): c is string => Boolean(c)))];
  const deadlineDay = firstArr(n["deadline-receipt-tender-date-lot"]);
  const deadlineTime = firstArr(n["deadline-receipt-tender-time-lot"]);
  const deadline = deadlineDay ? (deadlineTime ? `${dayOf(deadlineDay)}T${deadlineTime}` : deadlineDay) : undefined;
  const lotTitles = allLang(n["title-lot"]);
  const lotDescriptions = allLang(n["description-lot"]);
  const estValues: unknown[] = Array.isArray(n["estimated-value-lot"]) ? n["estimated-value-lot"] : n["estimated-value-lot"] ? [n["estimated-value-lot"]] : [];
  const estCur = n["estimated-value-cur-lot"];
  const lots =
    Math.max(lotTitles.length, estValues.length) > 1
      ? Array.from({ length: Math.max(lotTitles.length, estValues.length) }, (_, i) => ({
          id: `LOT-${String(i + 1).padStart(4, "0")}`,
          title: lotTitles[i],
          value: money(estValues[i], Array.isArray(estCur) ? estCur[i] : estCur, true),
        }))
      : [];
  const estimatedTotal = estValues.reduce<number>((s, v) => s + (Number(v) || 0), 0);
  const value =
    kind === "award"
      ? money(n["total-value"], n["total-value-cur"], false)
      : estimatedTotal > 0
        ? money(estimatedTotal, Array.isArray(estCur) ? estCur[0] : estCur, true)
        : undefined;

  const winners = allLang(n["winner-name"]);
  const winnerIds: string[] = Array.isArray(n["winner-identifier"]) ? n["winner-identifier"] : [];
  const winnerCountries: string[] = Array.isArray(n["winner-country"]) ? n["winner-country"] : [];
  const sizes: string[] = Array.isArray(n["winner-size"]) ? n["winner-size"] : [];
  const conclusion = firstArr(n["contract-conclusion-date"]);
  const months = durationMonths(firstArr(n["duration-period-value-lot"]), firstArr(n["duration-period-unit-lot"]));
  const awards: TenderAward[] = winners.map((name, i) => ({
    supplier: { name, legalId: isRegistrationId(winnerIds[i]) ? winnerIds[i]!.trim() : undefined, country: iso2(winnerCountries[i]) },
    date: dayOf(Array.isArray(n["contract-conclusion-date"]) ? n["contract-conclusion-date"][i] : conclusion),
    durationMonths: months,
    size: sizes[i],
  }));

  const criteriaNames = allLang(n["award-criterion-name-lot"]);
  const weights: string[] = Array.isArray(n["award-criterion-number-weight-lot"]) ? n["award-criterion-number-weight-lot"] : [];
  const criteria = [...new Map(criteriaNames.map((name, i) => [name.toLowerCase(), { name, weight: weights[i] }])).values()];
  const buyerIds: string[] = Array.isArray(n["organisation-identifier-buyer"]) ? n["organisation-identifier-buyer"] : [];

  return {
    id: `${CONNECTOR_ID}:${noticeId}`,
    connectorId: CONNECTOR_ID,
    noticeId: String(noticeId),
    country,
    kind,
    status: statusFromDeadline(kind, deadline, now),
    title: title.text ?? lotTitles[0] ?? String(noticeId),
    description: lotDescriptions.join("\n\n") || undefined,
    language: lang2(title.lang),
    buyer: {
      name: buyerName,
      // TED's buyer identifier list sometimes leads with a country name; keep
      // the first one that looks like an identifier.
      legalId: buyerIds.find((x) => /\d{5,}/.test(x)),
      country,
      city: pickLang(n["buyer-city"]).text,
    },
    cpv,
    nature: natureOf(n["contract-nature"]),
    procedure: n["procedure-type"] ?? undefined,
    value,
    lots,
    publishedAt: dayOf(n["publication-date"]),
    deadline,
    documentsUrl: firstArr(n["document-url-lot"]),
    // Known only once `tender --documents` has tried to read them.
    documentsAccess: "unknown",
    submissionUrl: firstArr(n["submission-url-lot"]),
    places: [...new Set(((n["place-of-performance"] ?? []) as string[]).filter((p) => /^[A-Z]{2}[0-9A-Z]{1,3}$/.test(p)))],
    criteria,
    awards,
    sourceUrl: `https://ted.europa.eu/en/notice/-/detail/${noticeId}`,
    coverage: "above-threshold",
    // The eForms procedure id is the SAME UUID a national portal files the
    // procedure under (BOAMP contractfolderid, the German tender.id): the exact
    // key that lets a TED copy and a national copy be recognised as one.
    aliases: [String(noticeId), n["procedure-identifier"], n["notice-identifier"]].filter((x): x is string => typeof x === "string" && x.length > 0),
    national: {
      noticeType: n["notice-type"],
      xml: n.links?.xml?.MUL,
      // The notice's full text. Measured: TED's /detail/ page renders in the
      // browser and serves only its menu to a fetch; the PDF is the notice.
      noticeDocument: n.links?.pdf?.[(COUNTRY_LANG[country] ?? "eng").toUpperCase()] ?? n.links?.pdf?.ENG,
    },
  };
}

async function post(body: unknown): Promise<{ ok: boolean; data?: any; error?: string; status?: number }> {
  await awaitHostSlot(URL_SEARCH, 300);
  const res = await httpJson("POST", URL_SEARCH, body, {
    timeoutMs: 30_000,
    retries: 1,
    userAgent: politeUa(),
    headers: { "content-type": "application/json" },
  });
  return { ok: res.ok, data: res.data, error: res.error, status: res.status };
}

export const euTed: TenderConnector = {
  id: CONNECTOR_ID,
  countries: [...EU27, "no", "is", "li", "ch", "mk", "rs", "me", "al", "md", "ua", "ge"],
  label: "EU — TED (Tenders Electronic Daily) API v3",
  licence: "TED notices: © European Union, reuse authorised (Commission Decision 2011/833/EU)",
  docsUrl: "https://docs.ted.europa.eu/api/latest/search.html",
  coverage: "above-threshold",
  kinds: ["call", "award", "prior", "modification"],

  availability() {
    return { available: true };
  },

  async search(q: TenderQuery): Promise<SearchOutcome> {
    // Countries TED does not cover must not widen into "every country".
    if (q.countries.length && !q.countries.some((c) => ISO3[c])) return { tenders: [], truncated: false };
    const query = tedQuery(q);
    const out: Tender[] = [];
    let token: string | undefined;
    let total: number | undefined;
    const notes: string[] = [];
    while (out.length < q.limit) {
      const res = await post({
        query,
        fields: TED_FIELDS,
        limit: Math.min(PAGE, q.limit - out.length),
        paginationMode: "ITERATION",
        ...(token ? { iterationNextToken: token } : {}),
      });
      if (!res.ok) {
        const message = typeof res.data?.message === "string" ? res.data.message.slice(0, 200) : (res.error ?? `HTTP ${res.status}`);
        return { tenders: out, total, truncated: true, reason: `TED refused the query: ${message}`, notes };
      }
      total = typeof res.data?.totalNoticeCount === "number" ? res.data.totalNoticeCount : total;
      if (res.data?.timedOut) notes.push("TED reported timedOut on a page: its answer for that page may be partial.");
      const page: any[] = Array.isArray(res.data?.notices) ? res.data.notices : [];
      for (const n of page) {
        const t = toTender(n);
        if (t && keepByQuery(t, q)) out.push(t);
      }
      token = res.data?.iterationNextToken ?? undefined;
      if (!token || page.length === 0) break;
    }
    const truncated = total !== undefined && total > out.length && Boolean(token);
    return {
      tenders: out,
      total,
      truncated,
      reason: truncated ? `TED reports ${total} notices for this query; the lane stopped at --limit ${q.limit}` : undefined,
      notes,
    };
  },

  async canary() {
    const res = await post({
      query: `classification-cpv IN (72000000) AND notice-type IN (can-standard) AND buyer-country IN (FRA) AND publication-date>=${new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10).replace(/-/g, "")} SORT BY publication-date DESC`,
      fields: TED_FIELDS,
      limit: 10,
      paginationMode: "ITERATION",
    });
    const notices: any[] = res.data?.notices ?? [];
    const t = notices.map((n) => toTender(n)).filter(Boolean) as Tender[];
    return [
      { name: "TED v3 still answers an anonymous expert query", ok: res.ok && notices.length > 0, detail: res.error },
      { name: "TED still reports totalNoticeCount", ok: typeof res.data?.totalNoticeCount === "number" },
      { name: "TED still pages by iterationNextToken", ok: typeof res.data?.iterationNextToken === "string" },
      {
        name: "TED still honours SORT BY publication-date DESC",
        ok: notices.length > 1 && String(notices[0]?.["publication-date"]) >= String(notices.at(-1)?.["publication-date"]),
        detail: "without it, a capped window reads its OLDEST notices",
      },
      {
        name: "TED award notices still name winners with identifiers",
        ok: t.some((x) => x.awards.some((a) => a.supplier.name && a.supplier.legalId)),
        detail: "the renewal forecast and the register link both rest on this",
      },
    ];
  },

  async probe() {
    const res = await post({ query: "publication-date>=20260101", fields: ["publication-number"], limit: 1 });
    return { ok: res.ok, detail: res.ok ? `TED answered (${res.data?.totalNoticeCount ?? "?"} notices since 2026)` : (res.error ?? `HTTP ${res.status}`) };
  },
};
