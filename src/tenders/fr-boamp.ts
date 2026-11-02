// France — BOAMP, the Bulletin officiel des annonces des marchés publics,
// published by DILA as open data on Opendatasoft. Keyless.
//
// Measured on 2026-11-02:
//
// - 1 722 757 notices; `nature` splits them APPEL_OFFRE 1.17M, ATTRIBUTION
//   469k, RECTIFICATIF 72k, plus a long tail (ANNULATION, PRE-INFORMATION…).
// - `famille` says which regime published it: JOUE (844k) are the European
//   notices — the SAME contracts TED carries, so `tenders` de-duplicates them —
//   FNS and MAPA are national, below the EU thresholds, and exist nowhere else.
//   That is why a French run with BOAMP is "all thresholds" and without it is
//   not.
// - There is NO CPV column. The CPV lives inside `donnees`, the eForms notice
//   serialised as JSON, which `readEforms` walks. So a CPV filter cannot be
//   sent upstream; it is applied after the fact, and the lane reports how many
//   notices it had to read to apply it.
// - Opendatasoft refuses `offset + limit > 10000` with a 400, verbatim:
//   "Invalid value for sum of offset + limit API parameter: 10001 was found
//   but <= 10000 is expected." A query wider than that is split by publication
//   date, or reported truncated.
// - Attribution notices carry `titulaire`: the winners' names, a list, with no
//   identifier. Names alone are a lead, not an identity.
import { awaitHostSlot, httpJson } from "../engine.js";
import { politeUa } from "../net.js";
import type { NoticeKind, SearchOutcome, Tender, TenderConnector, TenderQuery } from "./types.js";
import { dayOf, keepByQuery, natureOf, readEforms, statusFromDeadline } from "./util.js";

const BASE = "https://boamp-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/boamp/records";
const CONNECTOR_ID = "fr-boamp";
const PAGE = 100;
/** Opendatasoft's measured ceiling on offset + limit. */
export const ODS_WINDOW = 10_000;

const NATURE_FOR: Record<NoticeKind, string[]> = {
  call: ["APPEL_OFFRE"],
  award: ["ATTRIBUTION"],
  prior: ["PRE-INFORMATION"],
  modification: ["RECTIFICATIF", "MODIFICATION"],
  cancellation: ["ANNULATION"],
};

export function kindOfNature(nature: string | undefined): NoticeKind {
  switch (nature) {
    case "ATTRIBUTION":
    case "INTENTION_CONCLURE":
    case "EX_ANTE_VOLONTAIRE":
      return "award";
    case "PRE-INFORMATION":
    case "PERIODIQUE":
      return "prior";
    case "RECTIFICATIF":
    case "MODIFICATION":
      return "modification";
    case "ANNULATION":
      return "cancellation";
    default:
      return "call";
  }
}

/** The ODSQL `where` clause for a query. Exported for tests. */
export function boampWhere(q: TenderQuery): string {
  const parts: string[] = [];
  const natures = [...new Set(q.kinds.flatMap((k) => NATURE_FOR[k] ?? []))];
  if (natures.length) parts.push(`nature IN (${natures.map((n) => `"${n}"`).join(", ")})`);
  if (q.publishedFrom) parts.push(`dateparution >= date'${q.publishedFrom}'`);
  if (q.publishedTo) parts.push(`dateparution <= date'${q.publishedTo}'`);
  if (q.deadlineAfter && q.kinds.length === 1 && q.kinds[0] === "call") parts.push(`datelimitereponse >= date'${q.deadlineAfter}'`);
  // Keywords go upstream whenever there are any. The notices BOAMP holds WITH
  // a CPV are the JOUE ones — the same procedures TED returns, CPV and all — so
  // what BOAMP adds is the national notices, which carry no CPV and can only be
  // found by their words. Measured on 2026-11-02: a 7-day CPV-only pass read
  // 300 of 1 480 calls to keep 5.
  if (q.keywords.length) parts.push(`(${q.keywords.map((k) => `search(objet, "${k.replace(/"/g, "")}")`).join(" OR ")})`);
  return parts.join(" AND ");
}

function parseDonnees(raw: unknown): unknown {
  if (typeof raw !== "string" || !raw.startsWith("{")) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function toTender(r: any, now = new Date()): Tender | undefined {
  const idweb = r?.idweb;
  if (!idweb) return undefined;
  const kind = kindOfNature(r.nature);
  const eforms = readEforms(parseDonnees(r.donnees));
  const deadline: string | undefined = r.datelimitereponse ?? eforms.deadline ?? undefined;
  const titulaires: string[] = Array.isArray(r.titulaire) ? [...new Set(r.titulaire as string[])] : [];
  const european = r.famille === "JOUE";
  return {
    id: `${CONNECTOR_ID}:${idweb}`,
    connectorId: CONNECTOR_ID,
    noticeId: String(idweb),
    country: "fr",
    kind,
    status: statusFromDeadline(kind, deadline, now),
    title: r.objet ?? String(idweb),
    language: "fr",
    buyer: { name: r.nomacheteur ?? "", country: "fr" },
    cpv: eforms.cpv,
    nature: natureOf(r.type_marche),
    procedure: r.procedure_libelle ?? r.type_procedure ?? undefined,
    value: eforms.estimated,
    lots: [],
    publishedAt: dayOf(r.dateparution),
    deadline,
    documentsUrl: eforms.documents[0],
    documentsAccess: "unknown",
    places: (r.code_departement ?? []).map((d: string) => `FR-${d}`),
    criteria: eforms.criteria,
    awards: titulaires.map((name) => ({ supplier: { name, country: "fr" }, durationMonths: kind === "award" ? eforms.durationMonths : undefined })),
    sourceUrl: r.url_avis ?? `https://www.boamp.fr/pages/avis/?q=idweb:${idweb}`,
    // A JOUE notice is above the EU thresholds; FNS and MAPA are below them.
    coverage: "all",
    aliases: [String(idweb), ...(r.contractfolderid ? [String(r.contractfolderid)] : [])],
    national: {
      famille: r.famille,
      famille_libelle: r.famille_libelle,
      european,
      descripteurs: r.descripteur_libelle ?? [],
      annonce_lie: r.annonce_lie ?? undefined,
      contractfolderid: r.contractfolderid ?? undefined,
      code_departement: r.code_departement ?? [],
      durationMonths: eforms.durationMonths,
      // Measured: most national (FNS, MAPA) notices carry no eForms payload and
      // so no CPV at all. A CPV filter cannot judge them; keywords must, and
      // without keywords they are dropped rather than waved through.
      ...(eforms.cpv.length ? {} : { noCpvScheme: true }),
    },
  };
}

async function page(where: string, offset: number, limit: number): Promise<{ ok: boolean; data?: any; error?: string }> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset), order_by: "dateparution desc" });
  if (where) params.set("where", where);
  const url = `${BASE}?${params.toString()}`;
  await awaitHostSlot(url, 300);
  const res = await httpJson("GET", url, undefined, { timeoutMs: 30_000, retries: 1, userAgent: politeUa(), maxBytes: 16 * 1024 * 1024 });
  return { ok: res.ok, data: res.data, error: res.error ?? (res.data?.message as string | undefined) };
}

export const frBoamp: TenderConnector = {
  id: CONNECTOR_ID,
  countries: ["fr"],
  label: "France — BOAMP (DILA) via Opendatasoft",
  licence: "BOAMP: DILA, Licence Ouverte / Open Licence 2.0",
  docsUrl: "https://boamp-datadila.opendatasoft.com/explore/dataset/boamp/api/",
  coverage: "all",
  kinds: ["call", "award", "prior", "modification", "cancellation"],

  availability() {
    return { available: true };
  },

  async search(q: TenderQuery): Promise<SearchOutcome> {
    if (q.countries.length && !q.countries.includes("fr")) return { tenders: [], truncated: false };
    const where = boampWhere(q);
    const out: Tender[] = [];
    let total: number | undefined;
    let read = 0;
    // With a CPV filter and no keywords, the filter can only be applied after
    // reading — so read further than --limit, up to a bounded multiple.
    const budget = q.cpv.length && !q.keywords.length ? Math.min(ODS_WINDOW, q.limit * 10) : Math.min(ODS_WINDOW, q.limit * 2);
    while (read < budget && out.length < q.limit) {
      const res = await page(where, read, Math.min(PAGE, budget - read));
      if (!res.ok) return { tenders: out, total, truncated: true, reason: `BOAMP refused the query: ${res.error ?? "no answer"}` };
      total = typeof res.data?.total_count === "number" ? res.data.total_count : total;
      const rows: any[] = Array.isArray(res.data?.results) ? res.data.results : [];
      read += rows.length;
      for (const r of rows) {
        const t = toTender(r);
        if (t && keepByQuery(t, q)) out.push(t);
        if (out.length >= q.limit) break;
      }
      if (rows.length === 0) break;
    }
    // Rows exist that were never read: the lane is partial, whichever limit stopped it.
    const truncated = total !== undefined && read < total;
    const filteredAfter = q.cpv.length > 0 && !q.keywords.length;
    return {
      tenders: out,
      total,
      truncated,
      reason: truncated
        ? `BOAMP holds ${total} notices for this query; ${read} were read${filteredAfter ? " and filtered by CPV after reading (BOAMP publishes no CPV column)" : ""}${read >= ODS_WINDOW ? `, the Opendatasoft ceiling of ${ODS_WINDOW}` : ""}`
        : undefined,
      notes: filteredAfter ? [`BOAMP: CPV filter applied client-side over ${read} notice(s) — narrow with --keywords or --since to read fewer.`] : [],
    };
  },

  async canary() {
    const res = await page(`nature IN ("ATTRIBUTION")`, 0, 5);
    const rows: any[] = res.data?.results ?? [];
    const withDonnees = rows.filter((r) => typeof r.donnees === "string" && r.donnees.startsWith("{"));
    const tenders = rows.map((r) => toTender(r)).filter(Boolean) as Tender[];
    return [
      { name: "BOAMP Opendatasoft still answers keyless", ok: res.ok && rows.length > 0, detail: res.error },
      { name: "BOAMP still reports total_count", ok: typeof res.data?.total_count === "number" },
      { name: "BOAMP still ships the eForms notice in `donnees`", ok: withDonnees.length > 0, detail: "the CPV and the document URLs live there" },
      { name: "BOAMP attributions still list `titulaire`", ok: rows.some((r) => Array.isArray(r.titulaire)) },
      { name: "BOAMP `famille` still tells JOUE from national", ok: tenders.some((t) => typeof t.national?.famille === "string") },
    ];
  },

  async probe() {
    const res = await page("", 0, 1);
    return { ok: res.ok, detail: res.ok ? `BOAMP answered (${res.data?.total_count ?? "?"} notices)` : (res.error ?? "no answer") };
  },
};
