// Tender sources outside Europe, each speaking its own dialect.
//
// Measured on 2026-11-02 — what answered, and how:
//
//   ca-canadabuys   One CSV of every OPEN federal tender, 6 MB, bilingual
//                   columns ("title-titre-eng"), notice URL included. Keyless.
//                   Classified in GSIN and UNSPSC, never CPV.
//   us-sam          SAM.gov opportunities. Needs a key (free, from SAM.gov
//                   account settings): with none the endpoint answers 404, not
//                   401. Without the key the lane says so and stops.
//   us-usaspending  Federal AWARDS, keyless. `time_period` filters on ACTION
//                   date: an award started in 2014 and modified in 2026 comes
//                   back for a 2026 window. Read `Start Date`, not the window.
//   br-pncp         Brazil's Portal Nacional de Contratações Públicas. Open
//                   calls under /contratacoes/proposta (deadline ≥ a date),
//                   contracts under /contratos. Suppliers by CNPJ. Keyless.
//   ua-prozorro     Ukraine's Prozorro. The list endpoint returns ids only;
//                   each tender is one more request. CPV (as DK021). Keyless.
//   co-secop        Colombia's SECOP II on datos.gov.co (Socrata). Classified
//                   in UNSPSC ("V1.80111500"). Keyless.
//   ww-worldbank    World Bank-financed procurement notices, every borrowing
//                   country: 424 976 notices. Keyless. Coverage "funded": the
//                   notices of one funder's projects, never a country census.
import { Readable } from "node:stream";
import { awaitHostSlot, httpGet, httpJson } from "../engine.js";
import { politeUa } from "../net.js";
import { csvRecords } from "../snapshot.js";
import type { Tender, TenderConnector } from "./types.js";
import { dayFromDmy, dayOf, iso2, keepByQuery, money, natureOf, statusFromDeadline, plainText, today } from "./util.js";

async function getJson(url: string, headers?: Record<string, string>): Promise<{ ok: boolean; data?: any; error?: string; status?: number }> {
  await awaitHostSlot(url, 400);
  const res = await httpJson("GET", url, undefined, { timeoutMs: 45_000, retries: 1, userAgent: politeUa(), headers, maxBytes: 24 * 1024 * 1024 });
  return { ok: res.ok, data: res.data, error: res.error, status: res.status };
}

const base = (t: Partial<Tender> & Pick<Tender, "id" | "connectorId" | "noticeId" | "country" | "kind" | "title" | "coverage">): Tender => ({
  status: statusFromDeadline(t.kind, t.deadline),
  buyer: { name: "" },
  cpv: [],
  nature: "unknown",
  lots: [],
  documentsAccess: "unknown",
  places: [],
  criteria: [],
  awards: [],
  aliases: [t.noticeId],
  ...t,
});

// ── Canada — CanadaBuys open tenders CSV ─────────────────────────────────────
const CA_CSV = "https://canadabuys.canada.ca/opendata/pub/openTenderNotice-ouvertAvisAppelOffres.csv";
/**
 * CanadaBuys sits behind a WAF that answers the identifying User-Agent with a
 * 403 HTML page (measured 2026-11-02) and serves the same file to an ordinary
 * client. So this one host gets the engine's default browser User-Agent — the
 * rule pages.ts already applies to company sites — and nothing else changes.
 */
const caGet = (opts: { timeoutMs: number; retries: number; maxBytes: number }) => httpGet(CA_CSV, opts);

export function caRowToTender(row: Record<string, string>): Tender | undefined {
  const ref = row["referenceNumber-numeroReference"] || row["solicitationNumber-numeroSollicitation"];
  if (!ref) return undefined;
  const title = row["title-titre-eng"] || row["title-titre-fra"] || ref;
  const deadline = row["tenderClosingDate-appelOffresDateCloture"] || undefined;
  return base({
    id: `ca-canadabuys:${ref}`,
    connectorId: "ca-canadabuys",
    noticeId: ref,
    country: "ca",
    kind: "call",
    title,
    description: row["tenderDescription-descriptionAppelOffres-eng"] || row["tenderDescription-descriptionAppelOffres-fra"] || undefined,
    language: row["title-titre-eng"] ? "en" : "fr",
    buyer: {
      name: row["contractingEntityName-nomEntitContractante-eng"] || "",
      country: "ca",
      city: row["contractingEntityAddressCity-entiteContractanteAdresseVille-eng"] || undefined,
    },
    nature: natureOf(row["procurementCategory-categorieApprovisionnement"]),
    procedure: row["procurementMethod-methodeApprovisionnement-eng"] || undefined,
    publishedAt: dayOf(row["publicationDate-datePublication"]),
    deadline,
    documentsUrl: row["attachment-piecesJointes-eng"]?.split(/[,\s]+/).find((u) => /^https?:\/\//.test(u)) || undefined,
    places: (row["regionsOfDelivery-regionsLivraison-eng"] || "")
      .split(/[,*]/)
      .map((s) => s.trim())
      .filter(Boolean),
    sourceUrl: row["noticeURL-URLavis-eng"] || row["noticeURL-URLavis-fra"] || undefined,
    coverage: "all",
    national: { gsin: row["gsin-nibs"] || undefined, unspsc: row.unspsc || undefined, noticeType: row["noticeType-avisType-eng"], noCpvScheme: true },
  });
}

export async function parseCanadaCsv(text: string): Promise<Tender[]> {
  const out: Tender[] = [];
  let header: string[] | undefined;
  for await (const cells of csvRecords(Readable.from([text.replace(/^﻿/, "")]))) {
    if (!header) {
      header = cells;
      continue;
    }
    const row: Record<string, string> = {};
    header.forEach((h, i) => {
      row[h] = cells[i] ?? "";
    });
    const t = caRowToTender(row);
    if (t) out.push(t);
  }
  return out;
}

export const caCanadabuys: TenderConnector = {
  id: "ca-canadabuys",
  countries: ["ca"],
  label: "Canada — CanadaBuys open tender notices (CSV)",
  licence: "CanadaBuys: Open Government Licence – Canada",
  docsUrl: "https://open.canada.ca/data/en/dataset/6abd20d4-7a1c-4b38-baa2-9525d0bb2fd2",
  coverage: "all",
  kinds: ["call"],
  availability: () => ({ available: true }),
  async search(q) {
    if (q.countries.length && !q.countries.includes("ca")) return { tenders: [], truncated: false };
    if (!q.kinds.includes("call"))
      return { tenders: [], truncated: false, notes: ["CanadaBuys: only the open-tender file is read; award history is a separate file not wired here."] };
    await awaitHostSlot(CA_CSV, 500);
    const res = await caGet({ timeoutMs: 90_000, retries: 1, maxBytes: 64 * 1024 * 1024 });
    if (!res.ok) return { tenders: [], truncated: true, reason: `CanadaBuys CSV unreachable: ${res.error ?? `HTTP ${res.status}`}` };
    const all = await parseCanadaCsv(res.body);
    const kept = all.filter((t) => keepByQuery(t, q));
    return {
      tenders: kept.slice(0, q.limit),
      total: all.length,
      truncated: res.truncated === true || kept.length > q.limit,
      reason: res.truncated ? "the CSV exceeded the download cap" : kept.length > q.limit ? `${kept.length} matched; kept --limit ${q.limit}` : undefined,
      notes: q.cpv.length ? ["CanadaBuys classifies in GSIN/UNSPSC, not CPV: the CPV filter cannot apply, --keywords carry the filter."] : [],
    };
  },
  async canary() {
    await awaitHostSlot(CA_CSV, 500);
    const res = await caGet({ timeoutMs: 90_000, retries: 0, maxBytes: 64 * 1024 * 1024 });
    const all = res.ok ? await parseCanadaCsv(res.body) : [];
    return [
      { name: "CanadaBuys open-tender CSV still downloads keyless", ok: res.ok && all.length > 0, detail: res.error },
      { name: "CanadaBuys rows still carry a closing date", ok: all.some((t) => Boolean(t.deadline)) },
      { name: "CanadaBuys rows still carry their notice URL", ok: all.some((t) => Boolean(t.sourceUrl)) },
    ];
  },
  async probe() {
    const res = await caGet({ timeoutMs: 30_000, retries: 0, maxBytes: 4096 });
    return { ok: res.ok || res.truncated === true, detail: res.ok || res.truncated ? "CanadaBuys CSV reachable" : (res.error ?? `HTTP ${res.status}`) };
  },
};

// ── United States — SAM.gov opportunities (key) ──────────────────────────────
const SAM = "https://api.sam.gov/prod/opportunities/v2/search";
export const SAM_KEY_ENV = "ULTRAPROSPECT_SAM_API_KEY";
const mdy = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;

export function samToTender(o: any): Tender | undefined {
  const id = o?.noticeId;
  if (!id) return undefined;
  const kind = /award/i.test(o?.type ?? "") ? "award" : /presol|sources sought|special notice/i.test(o?.type ?? "") ? "prior" : "call";
  return base({
    id: `us-sam:${id}`,
    connectorId: "us-sam",
    noticeId: String(id),
    country: "us",
    kind,
    title: o.title ?? String(id),
    description: typeof o.description === "string" && !o.description.startsWith("http") ? o.description : undefined,
    language: "en",
    buyer: { name: o.fullParentPathName ?? o.department ?? "", country: "us", city: o.officeAddress?.city },
    procedure: o.typeOfSetAsideDescription ?? o.type ?? undefined,
    publishedAt: dayOf(o.postedDate),
    deadline: o.responseDeadLine ?? undefined,
    documentsUrl: Array.isArray(o.resourceLinks) ? o.resourceLinks[0] : undefined,
    sourceUrl: o.uiLink ?? `https://sam.gov/opp/${id}/view`,
    coverage: "all",
    awards: o.award?.awardee?.name
      ? [
          {
            supplier: { name: o.award.awardee.name, legalId: o.award.awardee.ueiSAM ? `UEI ${o.award.awardee.ueiSAM}` : undefined, country: "us" },
            value: money(o.award.amount, "USD", false),
            date: dayOf(o.award.date),
          },
        ]
      : [],
    national: { naics: o.naicsCode, psc: o.classificationCode, setAside: o.typeOfSetAside, solicitationNumber: o.solicitationNumber, noCpvScheme: true },
  });
}

export const usSam: TenderConnector = {
  id: "us-sam",
  countries: ["us"],
  label: "United States — SAM.gov contract opportunities",
  licence: "SAM.gov: U.S. Government work, public domain",
  docsUrl: "https://open.gsa.gov/api/get-opportunities-public-api/",
  coverage: "all",
  kinds: ["call", "award", "prior"],
  needsKey: true,
  availability(env = process.env) {
    return env[SAM_KEY_ENV]
      ? { available: true }
      : { available: false, reason: `SAM.gov needs a free API key: create one in your SAM.gov account settings, then export ${SAM_KEY_ENV}.` };
  },
  async search(q) {
    if (q.countries.length && !q.countries.includes("us")) return { tenders: [], truncated: false };
    const key = process.env[SAM_KEY_ENV];
    if (!key) return { tenders: [], truncated: true, reason: this.availability().reason };
    const from = q.publishedFrom ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const to = q.publishedTo ?? today();
    const out: Tender[] = [];
    let offset = 0;
    let total: number | undefined;
    while (out.length < q.limit) {
      const p = new URLSearchParams({ api_key: key, postedFrom: mdy(from), postedTo: mdy(to), limit: "100", offset: String(offset) });
      if (q.keywords.length) p.set("title", q.keywords[0]!);
      const res = await getJson(`${SAM}?${p}`);
      if (!res.ok) return { tenders: out, total, truncated: true, reason: `SAM.gov refused: ${res.error ?? `HTTP ${res.status}`}` };
      total = Number(res.data?.totalRecords) || total;
      const rows: any[] = res.data?.opportunitiesData ?? [];
      for (const o of rows) {
        const t = samToTender(o);
        if (t && keepByQuery(t, q)) out.push(t);
      }
      offset += rows.length;
      if (rows.length === 0 || (total !== undefined && offset >= total)) break;
    }
    const truncated = total !== undefined && offset < total;
    return { tenders: out.slice(0, q.limit), total, truncated, reason: truncated ? `SAM.gov reports ${total}; read ${offset}` : undefined };
  },
  async canary() {
    if (!process.env[SAM_KEY_ENV]) return [{ name: "SAM.gov (needs a key)", ok: true, inconclusive: true, detail: `set ${SAM_KEY_ENV} to probe` }];
    const r = await this.search({ countries: ["us"], cpv: [], keywords: [], kinds: ["call"], limit: 3 });
    return [{ name: "SAM.gov still answers with opportunitiesData", ok: r.tenders.length > 0, detail: r.reason }];
  },
  async probe() {
    if (!process.env[SAM_KEY_ENV]) return { ok: false, detail: `skipped: no ${SAM_KEY_ENV}` };
    const r = await this.search({ countries: ["us"], cpv: [], keywords: [], kinds: ["call"], limit: 1 });
    return { ok: r.tenders.length > 0, detail: r.reason ?? "SAM.gov answered" };
  },
};

// ── United States — USAspending awards (keyless) ─────────────────────────────
const USA = "https://api.usaspending.gov/api/v2/search/spending_by_award/";
const USA_FIELDS = [
  "Award ID",
  "Recipient Name",
  "Recipient UEI",
  "Award Amount",
  "Awarding Agency",
  "Start Date",
  "End Date",
  "Description",
  "NAICS",
  "PSC",
  "generated_internal_id",
];

export function usaToTender(r: any): Tender | undefined {
  const id = r?.["Award ID"];
  if (!id) return undefined;
  const start = dayOf(r["Start Date"]);
  const end = dayOf(r["End Date"]);
  const months = start && end ? Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / (30.44 * 86_400_000))) : undefined;
  return base({
    id: `us-usaspending:${id}`,
    connectorId: "us-usaspending",
    noticeId: String(id),
    country: "us",
    kind: "award",
    title: (r.Description ?? String(id)).slice(0, 300),
    description: r.Description ?? undefined,
    language: "en",
    buyer: { name: r["Awarding Agency"] ?? "", country: "us" },
    value: money(r["Award Amount"], "USD", false),
    publishedAt: start,
    sourceUrl: r.generated_internal_id ? `https://www.usaspending.gov/award/${r.generated_internal_id}` : undefined,
    coverage: "all",
    awards: [
      {
        supplier: { name: r["Recipient Name"] ?? "", legalId: r["Recipient UEI"] ? `UEI ${r["Recipient UEI"]}` : undefined, country: "us" },
        value: money(r["Award Amount"], "USD", false),
        date: start,
        endDate: end,
        durationMonths: months,
      },
    ],
    national: { naics: r.NAICS?.code, psc: r.PSC?.code, noCpvScheme: true },
  });
}

export const usUsaspending: TenderConnector = {
  id: "us-usaspending",
  countries: ["us"],
  label: "United States — USAspending.gov federal contract awards",
  licence: "USAspending.gov: U.S. Government work, public domain",
  docsUrl: "https://api.usaspending.gov/docs/endpoints",
  coverage: "all",
  kinds: ["award"],
  availability: () => ({ available: true }),
  async search(q) {
    if (q.countries.length && !q.countries.includes("us")) return { tenders: [], truncated: false };
    if (!q.kinds.includes("award")) return { tenders: [], truncated: false };
    const from = q.publishedFrom ?? new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
    const out: Tender[] = [];
    let page = 1;
    let more = true;
    while (more && out.length < q.limit && page <= 20) {
      await awaitHostSlot(USA, 400);
      const res = await httpJson(
        "POST",
        USA,
        {
          filters: {
            award_type_codes: ["A", "B", "C", "D"],
            time_period: [{ start_date: from, end_date: q.publishedTo ?? today() }],
            ...(q.keywords.length ? { keywords: q.keywords } : {}),
          },
          fields: USA_FIELDS,
          limit: 100,
          page,
          sort: "Award Amount",
          order: "desc",
        },
        { timeoutMs: 60_000, retries: 1, userAgent: politeUa(), headers: { "content-type": "application/json" } },
      );
      if (!res.ok) return { tenders: out, truncated: true, reason: `USAspending refused: ${res.error ?? `HTTP ${res.status}`}` };
      const data = res.data as any;
      for (const r of data?.results ?? []) {
        const t = usaToTender(r);
        // `time_period` matches ACTION dates; keep only awards that STARTED in the window.
        if (t && (!t.publishedAt || t.publishedAt >= from) && keepByQuery(t, q)) out.push(t);
      }
      more = Boolean(data?.page_metadata?.hasNext);
      page += 1;
    }
    return { tenders: out.slice(0, q.limit), truncated: more, reason: more ? `more awards exist past page ${page - 1}` : undefined };
  },
  async canary() {
    const r = await this.search({
      countries: ["us"],
      cpv: [],
      keywords: ["software"],
      kinds: ["award"],
      limit: 5,
      publishedFrom: new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10),
    });
    return [
      { name: "USAspending still answers spending_by_award keyless", ok: r.tenders.length > 0 || !r.reason, detail: r.reason },
      {
        name: "USAspending awards still carry a recipient UEI",
        ok: r.tenders.some((t) => t.awards[0]?.supplier.legalId?.startsWith("UEI")),
        inconclusive: r.tenders.length === 0,
      },
    ];
  },
  async probe() {
    const r = await this.search({ countries: ["us"], cpv: [], keywords: ["software"], kinds: ["award"], limit: 1 });
    return { ok: !r.reason || r.tenders.length > 0, detail: r.reason ?? "USAspending answered" };
  },
};

// ── Brazil — PNCP ────────────────────────────────────────────────────────────
const PNCP = "https://pncp.gov.br/api/consulta/v1";
const ymd = (iso: string) => iso.replace(/-/g, "");

export function pncpCallToTender(r: any): Tender | undefined {
  const id = r?.numeroControlePNCP;
  if (!id) return undefined;
  const [cnpj, , seqYear] = String(id).split("-");
  const [seq, year] = (seqYear ?? "").split("/");
  return base({
    id: `br-pncp:${id}`,
    connectorId: "br-pncp",
    noticeId: String(id),
    country: "br",
    kind: "call",
    title: (r.objetoCompra ?? String(id)).slice(0, 500),
    description: r.informacaoComplementar ?? undefined,
    language: "pt",
    buyer: {
      name: r.orgaoEntidade?.razaoSocial ?? "",
      legalId: r.orgaoEntidade?.cnpj ? `CNPJ ${r.orgaoEntidade.cnpj}` : undefined,
      country: "br",
      city: r.unidadeOrgao?.municipioNome,
    },
    procedure: r.modalidadeNome ?? undefined,
    value: money(r.valorTotalEstimado, "BRL", true),
    publishedAt: dayOf(r.dataPublicacaoPncp),
    deadline: r.dataEncerramentoProposta ?? undefined,
    documentsUrl: r.linkSistemaOrigem ?? undefined,
    places: [r.unidadeOrgao?.ufSigla].filter(Boolean),
    sourceUrl: cnpj && seq && year ? `https://pncp.gov.br/app/editais/${cnpj}/${year}/${Number(seq)}` : undefined,
    coverage: "all",
    national: { modalidade: r.modalidadeNome, amparoLegal: r.amparoLegal?.nome, noCpvScheme: true },
  });
}

export function pncpContractToTender(r: any): Tender | undefined {
  const id = r?.numeroControlePNCP ?? r?.numeroControlePncpCompra;
  if (!id) return undefined;
  const start = dayOf(r.dataVigenciaInicio);
  const end = dayOf(r.dataVigenciaFim);
  const months = start && end ? Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / (30.44 * 86_400_000))) : undefined;
  return base({
    id: `br-pncp:${id}`,
    connectorId: "br-pncp",
    noticeId: String(id),
    country: "br",
    kind: "award",
    title: (r.objetoContrato ?? String(id)).slice(0, 500),
    language: "pt",
    buyer: { name: r.orgaoEntidade?.razaoSocial ?? "", legalId: r.orgaoEntidade?.cnpj ? `CNPJ ${r.orgaoEntidade.cnpj}` : undefined, country: "br" },
    value: money(r.valorGlobal ?? r.valorInicial, "BRL", false),
    publishedAt: dayOf(r.dataPublicacaoPncp),
    coverage: "all",
    awards: r.nomeRazaoSocialFornecedor
      ? [
          {
            supplier: { name: r.nomeRazaoSocialFornecedor, legalId: r.niFornecedor ? `CNPJ ${r.niFornecedor}` : undefined, country: "br" },
            value: money(r.valorGlobal ?? r.valorInicial, "BRL", false),
            date: dayOf(r.dataAssinatura),
            endDate: end,
            durationMonths: months,
          },
        ]
      : [],
    national: { noCpvScheme: true },
  });
}

export const brPncp: TenderConnector = {
  id: "br-pncp",
  countries: ["br"],
  label: "Brazil — PNCP (Portal Nacional de Contratações Públicas)",
  licence: "PNCP: dados abertos, Governo Federal do Brasil",
  docsUrl: "https://pncp.gov.br/api/consulta/swagger-ui/index.html",
  coverage: "all",
  kinds: ["call", "award"],
  unverified: true,
  availability: () => ({ available: true }),
  async search(q) {
    if (q.countries.length && !q.countries.includes("br")) return { tenders: [], truncated: false };
    const out: Tender[] = [];
    let truncated = false;
    const reasons: string[] = [];
    if (q.kinds.includes("call")) {
      const until = q.deadlineAfter ? q.deadlineAfter : today();
      let page = 1;
      let pages = 1;
      while (page <= pages && out.length < q.limit && page <= 50) {
        // biome-ignore lint/complexity/useMathMinMax: these are ISO date strings, which Math.max would turn into NaN.
        const res = await getJson(`${PNCP}/contratacoes/proposta?dataFinal=${ymd(until > today() ? until : today())}&pagina=${page}&tamanhoPagina=50`);
        if (!res.ok) {
          truncated = true;
          reasons.push(`PNCP calls refused: ${res.error ?? `HTTP ${res.status}`}`);
          break;
        }
        pages = Number(res.data?.totalPaginas) || 1;
        for (const r of res.data?.data ?? []) {
          const t = pncpCallToTender(r);
          if (t && keepByQuery(t, { ...q, deadlineAfter: undefined }) && out.length < q.limit) out.push(t);
        }
        page += 1;
      }
      if (page <= pages) {
        truncated = true;
        reasons.push(`PNCP: ${pages} pages of open calls; read ${page - 1}`);
      }
    }
    if (q.kinds.includes("award")) {
      const from = q.publishedFrom ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
      const to = q.publishedTo ?? today();
      let page = 1;
      let pages = 1;
      while (page <= pages && out.length < q.limit && page <= 50) {
        const res = await getJson(`${PNCP}/contratos?dataInicial=${ymd(from)}&dataFinal=${ymd(to)}&pagina=${page}&tamanhoPagina=50`);
        if (!res.ok) {
          truncated = true;
          reasons.push(`PNCP contracts refused: ${res.error ?? `HTTP ${res.status}`}`);
          break;
        }
        pages = Number(res.data?.totalPaginas) || 1;
        for (const r of res.data?.data ?? []) {
          const t = pncpContractToTender(r);
          if (t && keepByQuery(t, q) && out.length < q.limit) out.push(t);
        }
        page += 1;
      }
      if (page <= pages) {
        truncated = true;
        reasons.push(`PNCP: ${pages} pages of contracts; read ${page - 1}`);
      }
    }
    return { tenders: out, truncated, reason: reasons.join("; ") || undefined };
  },
  async canary() {
    const res = await getJson(`${PNCP}/contratacoes/proposta?dataFinal=${ymd(today())}&pagina=1&tamanhoPagina=10`);
    const ts = (res.data?.data ?? []).map(pncpCallToTender).filter(Boolean) as Tender[];
    return [
      { name: "PNCP still answers /contratacoes/proposta keyless", ok: res.ok && ts.length > 0, detail: res.error },
      { name: "PNCP calls still carry dataEncerramentoProposta", ok: ts.some((t) => Boolean(t.deadline)) },
      { name: "PNCP still reports totalPaginas", ok: typeof res.data?.totalPaginas === "number" },
    ];
  },
  async probe() {
    const res = await getJson(`${PNCP}/contratacoes/proposta?dataFinal=${ymd(today())}&pagina=1&tamanhoPagina=10`);
    return { ok: res.ok, detail: res.ok ? `PNCP answered (${res.data?.totalRegistros ?? "?"} open calls)` : (res.error ?? `HTTP ${res.status}`) };
  },
};

// ── Ukraine — Prozorro ───────────────────────────────────────────────────────
const PROZORRO = "https://public-api.prozorro.gov.ua/api/2.5/tenders";

export function prozorroToTender(d: any): Tender | undefined {
  const id = d?.tenderID ?? d?.id;
  if (!id) return undefined;
  const status = String(d.status ?? "");
  const kind = status === "complete" ? "award" : status === "cancelled" ? "cancellation" : "call";
  const cpv = [...new Set((d.items ?? []).map((i: any) => String(i?.classification?.id ?? "").match(/\d{8}/)?.[0]).filter(Boolean))] as string[];
  const awards = (d.awards ?? [])
    .filter((a: any) => a?.status === "active")
    .flatMap((a: any) =>
      (a.suppliers ?? []).map((s: any) => ({
        supplier: {
          name: s?.name ?? s?.identifier?.legalName ?? "",
          legalId: s?.identifier?.id ? `${s.identifier.scheme ?? ""} ${s.identifier.id}`.trim() : undefined,
          country: iso2(s?.address?.countryName) ?? "ua",
        },
        value: money(a?.value?.amount, a?.value?.currency, false),
        date: dayOf(a?.date),
      })),
    );
  return base({
    id: `ua-prozorro:${id}`,
    connectorId: "ua-prozorro",
    noticeId: String(id),
    country: "ua",
    kind,
    status:
      kind === "award"
        ? "awarded"
        : kind === "cancellation"
          ? "cancelled"
          : status.startsWith("active.tendering")
            ? "open"
            : statusFromDeadline("call", d.tenderPeriod?.endDate),
    title: d.title ?? String(id),
    description: d.description ?? undefined,
    language: "uk",
    buyer: {
      name: d.procuringEntity?.name ?? "",
      legalId: d.procuringEntity?.identifier?.id ? `EDRPOU ${d.procuringEntity.identifier.id}` : undefined,
      country: "ua",
      city: d.procuringEntity?.address?.locality,
    },
    cpv,
    nature: natureOf(d.mainProcurementCategory),
    procedure: d.procurementMethodType ?? undefined,
    value: money(d.value?.amount, d.value?.currency, true),
    publishedAt: dayOf(d.date ?? d.dateCreated),
    deadline: d.tenderPeriod?.endDate ?? undefined,
    sourceUrl: d.tenderID ? `https://prozorro.gov.ua/tender/${d.tenderID}` : undefined,
    coverage: "all",
    awards,
    national: { status, procurementMethodType: d.procurementMethodType },
  });
}

export const uaProzorro: TenderConnector = {
  id: "ua-prozorro",
  countries: ["ua"],
  label: "Ukraine — Prozorro public API",
  licence: "Prozorro: open data, Ministry of Economy of Ukraine",
  docsUrl: "https://prozorro-api-docs.readthedocs.io/",
  coverage: "all",
  kinds: ["call", "award"],
  unverified: true,
  availability: () => ({ available: true }),
  async search(q) {
    if (q.countries.length && !q.countries.includes("ua")) return { tenders: [], truncated: false };
    const out: Tender[] = [];
    let url: string | undefined = `${PROZORRO}?descending=1&limit=100`;
    let read = 0;
    const budget = Math.min(2000, q.limit * 8);
    while (url && read < budget && out.length < q.limit) {
      const res = await getJson(url);
      if (!res.ok) return { tenders: out, truncated: true, reason: `Prozorro refused: ${res.error ?? `HTTP ${res.status}`}` };
      const ids: string[] = (res.data?.data ?? []).map((x: any) => x?.id).filter(Boolean);
      for (const id of ids) {
        if (read >= budget || out.length >= q.limit) break;
        read += 1;
        const one = await getJson(`${PROZORRO}/${id}`);
        const t = one.ok ? prozorroToTender(one.data?.data) : undefined;
        // No early stop on the creation date: the list is ordered by MODIFICATION
        // date, so an old tender modified today sits among new ones. Stopping at
        // the first old one ended a live Ukrainian pass after a handful of reads,
        // and reported nothing missing.
        if (t && keepByQuery(t, q)) out.push(t);
      }
      url = res.data?.next_page?.uri;
      if (!ids.length) url = undefined;
    }
    // Pages remain: the lane is partial, whichever budget stopped it.
    const truncated = Boolean(url);
    return {
      tenders: out,
      truncated,
      reason: truncated ? `Prozorro lists ids only; ${read} tenders were opened one by one before the budget ran out` : undefined,
    };
  },
  async canary() {
    const list = await getJson(`${PROZORRO}?descending=1&limit=3`);
    const id = list.data?.data?.[0]?.id;
    const one = id ? await getJson(`${PROZORRO}/${id}`) : undefined;
    const t = one?.ok ? prozorroToTender(one.data?.data) : undefined;
    return [
      { name: "Prozorro still lists tenders keyless", ok: list.ok && Boolean(id), detail: list.error },
      { name: "Prozorro tenders still open by id with a tenderID", ok: Boolean(t?.noticeId?.startsWith("UA-")) },
    ];
  },
  async probe() {
    const list = await getJson(`${PROZORRO}?limit=1`);
    return { ok: list.ok, detail: list.ok ? "Prozorro answered" : (list.error ?? `HTTP ${list.status}`) };
  },
};

// ── Colombia — SECOP II ──────────────────────────────────────────────────────
const SECOP = "https://www.datos.gov.co/resource/p6dx-8zbt.json";

export function secopToTender(r: any): Tender | undefined {
  const id = r?.id_del_proceso;
  if (!id) return undefined;
  const awarded = r.adjudicado === "Si" || r.adjudicado === "Sí";
  const kind = awarded ? "award" : "call";
  return base({
    id: `co-secop:${id}`,
    connectorId: "co-secop",
    noticeId: String(id),
    country: "co",
    kind,
    status: awarded ? "awarded" : /abierto|presentaci/i.test(`${r.estado_de_apertura_del_proceso ?? ""} ${r.fase ?? ""}`) ? "open" : "unknown",
    title: (r.nombre_del_procedimiento ?? String(id)).slice(0, 500),
    description: r.descripci_n_del_procedimiento ?? undefined,
    language: "es",
    buyer: { name: r.entidad ?? "", legalId: r.nit_entidad ? `NIT ${r.nit_entidad}` : undefined, country: "co", city: r.ciudad_entidad },
    nature: natureOf(r.tipo_de_contrato),
    procedure: r.modalidad_de_contratacion ?? undefined,
    value: money(r.precio_base, "COP", true),
    publishedAt: dayOf(r.fecha_de_publicacion_del),
    sourceUrl: r.urlproceso?.url ?? undefined,
    places: [r.departamento_entidad].filter(Boolean),
    coverage: "all",
    awards:
      awarded && r.nombre_del_proveedor && r.nombre_del_proveedor !== "No Definido"
        ? [
            {
              supplier: {
                name: r.nombre_del_proveedor,
                legalId: r.nit_del_proveedor_adjudicado ? `NIT ${r.nit_del_proveedor_adjudicado}` : undefined,
                country: "co",
              },
              value: money(r.valor_total_adjudicacion, "COP", false),
            },
          ]
        : [],
    national: { unspsc: r.codigo_principal_de_categoria, fase: r.fase, noCpvScheme: true },
  });
}

export const coSecop: TenderConnector = {
  id: "co-secop",
  countries: ["co"],
  label: "Colombia — SECOP II processes (datos.gov.co)",
  licence: "SECOP II: Colombia Compra Eficiente, datos abiertos",
  docsUrl: "https://www.datos.gov.co/Gastos-Gubernamentales/SECOP-II-Procesos-de-Contrataci-n/p6dx-8zbt",
  coverage: "all",
  kinds: ["call", "award"],
  unverified: true,
  availability: () => ({ available: true }),
  async search(q) {
    if (q.countries.length && !q.countries.includes("co")) return { tenders: [], truncated: false };
    const where: string[] = [];
    if (q.publishedFrom) where.push(`fecha_de_publicacion_del >= '${q.publishedFrom}T00:00:00'`);
    if (q.kinds.length === 1 && q.kinds[0] === "award") where.push(`adjudicado = 'Si'`);
    if (q.kinds.length === 1 && q.kinds[0] === "call") where.push(`estado_de_apertura_del_proceso = 'Abierto'`);
    const p = new URLSearchParams({ $limit: String(Math.min(1000, q.limit * 5)), $order: "fecha_de_publicacion_del DESC" });
    if (where.length) p.set("$where", where.join(" AND "));
    if (q.keywords.length) p.set("$q", q.keywords.join(" "));
    const res = await getJson(`${SECOP}?${p}`);
    if (!res.ok) return { tenders: [], truncated: true, reason: `SECOP refused: ${res.error ?? `HTTP ${res.status}`}` };
    const rows: any[] = Array.isArray(res.data) ? res.data : [];
    const kept = rows.map(secopToTender).filter((t): t is Tender => Boolean(t) && keepByQuery(t as Tender, q));
    const truncated = rows.length >= Math.min(1000, q.limit * 5);
    return { tenders: kept.slice(0, q.limit), truncated, reason: truncated ? `SECOP answered a full page of ${rows.length}; more exist` : undefined };
  },
  async canary() {
    const res = await getJson(`${SECOP}?$limit=3`);
    const ts = (Array.isArray(res.data) ? res.data : []).map(secopToTender).filter(Boolean) as Tender[];
    return [
      { name: "SECOP II still answers on Socrata keyless", ok: res.ok && ts.length > 0, detail: res.error },
      { name: "SECOP II processes still link to their page", ok: ts.some((t) => Boolean(t.sourceUrl)) },
    ];
  },
  async probe() {
    const res = await getJson(`${SECOP}?$limit=1`);
    return { ok: res.ok, detail: res.ok ? "SECOP II answered" : (res.error ?? `HTTP ${res.status}`) };
  },
};

// ── Worldwide — World Bank procurement notices ───────────────────────────────
const WB = "https://search.worldbank.org/api/v2/procnotices";

export function worldBankToTender(n: any): Tender | undefined {
  const id = n?.id;
  if (!id) return undefined;
  const type = String(n.notice_type ?? "");
  const kind = /award/i.test(type) ? "award" : /general procurement notice/i.test(type) ? "prior" : "call";
  const deadline = n.submission_deadline_date
    ? `${dayOf(n.submission_deadline_date)}${n.submission_deadline_time ? `T${n.submission_deadline_time}` : ""}`
    : undefined;
  return base({
    id: `ww-worldbank:${id}`,
    connectorId: "ww-worldbank",
    noticeId: String(id),
    country: countryFromName(n.project_ctry_name) ?? "ww",
    kind,
    title: (n.bid_description ?? n.project_name ?? String(id)).slice(0, 500),
    description: plainText(n.notice_text)?.slice(0, 4000),
    language: (n.notice_lang_name ?? "").toLowerCase().startsWith("fr") ? "fr" : (n.notice_lang_name ?? "").toLowerCase().startsWith("span") ? "es" : "en",
    buyer: { name: n.contact_organization ?? "", country: countryFromName(n.contact_ctry_name) },
    nature: /^CS/.test(n.procurement_group ?? "")
      ? "services"
      : /^GO/.test(n.procurement_group ?? "")
        ? "supplies"
        : /^CW/.test(n.procurement_group ?? "")
          ? "works"
          : "unknown",
    procedure: n.procurement_method_name ?? undefined,
    publishedAt: dayFromDmy(n.noticedate),
    deadline,
    sourceUrl: `https://projects.worldbank.org/en/projects-operations/procurement-detail/${id}`,
    coverage: "funded",
    national: {
      project: n.project_id,
      projectName: n.project_name,
      noticeType: type,
      country: n.project_ctry_name,
      bidReference: n.bid_reference_no,
      noCpvScheme: true,
    },
  });
}

const COUNTRY_NAMES: Record<string, string> = {
  zambia: "zm",
  kenya: "ke",
  nigeria: "ng",
  ghana: "gh",
  ethiopia: "et",
  tanzania: "tz",
  uganda: "ug",
  senegal: "sn",
  "cote d'ivoire": "ci",
  "côte d'ivoire": "ci",
  morocco: "ma",
  tunisia: "tn",
  egypt: "eg",
  "arab republic of egypt": "eg",
  india: "in",
  bangladesh: "bd",
  pakistan: "pk",
  indonesia: "id",
  philippines: "ph",
  vietnam: "vn",
  "viet nam": "vn",
  brazil: "br",
  mexico: "mx",
  colombia: "co",
  peru: "pe",
  argentina: "ar",
  ukraine: "ua",
  turkey: "tr",
  türkiye: "tr",
  madagascar: "mg",
  cameroon: "cm",
  benin: "bj",
  "burkina faso": "bf",
  mali: "ml",
  niger: "ne",
  chad: "td",
  rwanda: "rw",
  mozambique: "mz",
  malawi: "mw",
  "congo, democratic republic of": "cd",
  "democratic republic of the congo": "cd",
};
function countryFromName(name: string | undefined): string | undefined {
  return name ? COUNTRY_NAMES[name.trim().toLowerCase()] : undefined;
}

export const wwWorldBank: TenderConnector = {
  id: "ww-worldbank",
  countries: ["*"],
  label: "Worldwide — World Bank procurement notices",
  licence: "World Bank: CC BY 4.0",
  docsUrl: "https://documents.worldbank.org/en/publication/documents-reports/api",
  coverage: "funded",
  kinds: ["call", "award", "prior"],
  availability: () => ({ available: true }),
  async search(q) {
    // One pass per named country, filtered UPSTREAM: measured, `project_ctry_code=KE`
    // narrows 425 019 notices to Kenya's 7 250. Filtering the newest page of the
    // whole world after the fact found nothing for Kenya and reported nothing missing.
    const countries = q.countries.filter((c) => c !== "*");
    const passes: (string | undefined)[] = countries.length ? countries : [undefined];
    const out: Tender[] = [];
    let total = 0;
    let read = 0;
    let partial = false;
    for (const cc of passes) {
      let offset = 0;
      let passTotal: number | undefined;
      const budget = Math.min(1000, q.limit * 5);
      let older = false;
      while (offset < budget && out.length < q.limit && !older) {
        const p = new URLSearchParams({ format: "json", rows: "100", os: String(offset), srt: "noticedate", order: "desc" });
        if (q.keywords.length) p.set("qterm", q.keywords.join(" "));
        if (cc) p.set("project_ctry_code", cc.toUpperCase());
        const res = await getJson(`${WB}?${p}`);
        if (!res.ok) return { tenders: out, total, truncated: true, reason: `World Bank refused: ${res.error ?? `HTTP ${res.status}`}` };
        passTotal = Number(res.data?.total) || 0;
        const rows: any[] = res.data?.procnotices ?? [];
        offset += rows.length;
        for (const n of rows) {
          const t = worldBankToTender(n);
          if (!t) continue;
          // The country was asked for by code, so it is known even where the name table is not.
          if (cc) t.country = cc;
          if (q.publishedFrom && t.publishedAt && t.publishedAt < q.publishedFrom) {
            older = true;
            continue;
          }
          if (keepByQuery(t, { ...q, countries: [] }) && out.length < q.limit) out.push(t);
        }
        if (rows.length === 0) break;
      }
      total += passTotal ?? 0;
      read += offset;
      // Notices remain unread only if the window was not exhausted by date.
      if (!older && passTotal !== undefined && offset < passTotal) partial = true;
    }
    return { tenders: out, total, truncated: partial, reason: partial ? `World Bank holds ${total} for this query; read ${read}, newest first` : undefined };
  },
  async canary() {
    const res = await getJson(`${WB}?format=json&rows=3`);
    const ts = (res.data?.procnotices ?? []).map(worldBankToTender).filter(Boolean) as Tender[];
    return [
      { name: "World Bank procnotices still answers keyless", ok: res.ok && ts.length > 0, detail: res.error },
      { name: "World Bank notices still carry a submission deadline", ok: ts.some((t) => Boolean(t.deadline)), inconclusive: ts.length === 0 },
    ];
  },
  async probe() {
    const res = await getJson(`${WB}?format=json&rows=1`);
    return { ok: res.ok, detail: res.ok ? `World Bank answered (${res.data?.total ?? "?"} notices)` : (res.error ?? `HTTP ${res.status}`) };
  },
};
