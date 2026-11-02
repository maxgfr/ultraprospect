// The web lane: tenders where no open API reaches.
//
// Spain's PLACSP answered nothing to a keyless request (measured, timeout);
// Italy, the Netherlands, Switzerland, India, most of Africa and Latin America
// publish on portals with no open API at all. For those, and for every country
// whose only API source is TED (above-threshold), the national market is
// visible only the way a person sees it: by searching.
//
// Same division of labour as `resolve`, and for the same reason. The engine
// writes the queries — in the market's own language, with its own procurement
// vocabulary — the agent runs its own web search (or the keyless engines run
// it with `--engine-search`), and the hits come back through `--web-results`.
// The engine then fetches every candidate and keeps it ONLY if the page itself
// corroborates a call for tenders: a procurement term of that market, and one
// of the user's terms. A search snippet is never a notice.
//
// What the lane never does is invent the facts a bidder plans on. A deadline is
// read off the page only when a deadline LABEL sits right before a date
// ("Date limite de réception des offres : 23/11/2026"); otherwise it is absent,
// the status is "unknown", and the report says to open the notice.
import { createHash } from "node:crypto";
import { search } from "../engine.js";
import { fetchPage, type PageStore } from "../pages.js";
import type { Tender } from "./types.js";
import { statusFromDeadline } from "./util.js";

export interface WebMarket {
  /** BCP-47 tag the engines answer in. */
  lang: string;
  /** How that market says "call for tenders". Matched on the page, accent-folded. */
  terms: string[];
  /** Labels that introduce a submission deadline on a notice page. */
  deadlineLabels: string[];
  /**
   * Portals worth naming in a query. Search HINTS only — nothing is trusted
   * because of its host; corroboration reads the page.
   */
  portals: string[];
}

export const WEB_MARKETS: Record<string, WebMarket> = {
  es: {
    lang: "es-ES",
    terms: ["licitación", "licitacion", "pliego", "contratación pública", "anuncio de licitación"],
    deadlineLabels: ["plazo de presentación", "fecha límite", "fin de plazo"],
    portals: ["contrataciondelestado.es"],
  },
  it: {
    lang: "it-IT",
    terms: ["bando di gara", "gara d'appalto", "avviso", "procedura aperta", "appalto"],
    deadlineLabels: ["termine ricezione offerte", "scadenza", "termine di presentazione"],
    portals: ["anticorruzione.it", "acquistinretepa.it"],
  },
  pt: {
    lang: "pt-PT",
    terms: ["concurso público", "anúncio de procedimento", "caderno de encargos"],
    deadlineLabels: ["prazo para apresentação", "data limite"],
    portals: ["base.gov.pt", "dre.pt"],
  },
  nl: {
    lang: "nl-NL",
    terms: ["aanbesteding", "openbare procedure", "inschrijving"],
    deadlineLabels: ["sluitingsdatum", "uiterste datum", "termijn voor ontvangst"],
    portals: ["tenderned.nl"],
  },
  be: {
    lang: "fr-BE",
    terms: ["marché public", "appel d'offres", "overheidsopdracht", "aanbesteding"],
    deadlineLabels: ["date limite", "uiterste datum"],
    portals: ["publicprocurement.be"],
  },
  ch: {
    lang: "de-CH",
    terms: ["Ausschreibung", "appel d'offres", "bando", "öffentliche Beschaffung"],
    deadlineLabels: ["Eingabetermin", "Frist", "délai de remise"],
    portals: ["simap.ch"],
  },
  at: {
    lang: "de-AT",
    terms: ["Ausschreibung", "Vergabeverfahren", "Bekanntmachung"],
    deadlineLabels: ["Angebotsfrist", "Ende der Angebotsfrist", "Schlusstermin"],
    portals: ["auftrag.at", "usp.gv.at"],
  },
  de: {
    lang: "de-DE",
    terms: ["Ausschreibung", "Vergabe", "Bekanntmachung", "Auftragsbekanntmachung"],
    deadlineLabels: ["Angebotsfrist", "Ablauf der Angebotsfrist", "Schlusstermin"],
    portals: ["service.bund.de", "evergabe-online.de"],
  },
  pl: {
    lang: "pl-PL",
    terms: ["przetarg", "ogłoszenie o zamówieniu", "zamówienie publiczne"],
    deadlineLabels: ["termin składania ofert"],
    portals: ["ezamowienia.gov.pl"],
  },
  se: {
    lang: "sv-SE",
    terms: ["upphandling", "anbud", "förfrågningsunderlag"],
    deadlineLabels: ["sista anbudsdag", "sista dag för anbud"],
    portals: ["upphandlingsmyndigheten.se"],
  },
  dk: { lang: "da-DK", terms: ["udbud", "udbudsbekendtgørelse"], deadlineLabels: ["tilbudsfrist", "frist for modtagelse af tilbud"], portals: ["udbud.dk"] },
  fi: {
    lang: "fi-FI",
    terms: ["hankintailmoitus", "tarjouspyyntö", "kilpailutus"],
    deadlineLabels: ["tarjousten määräaika", "määräaika"],
    portals: ["hankintailmoitukset.fi"],
  },
  no: { lang: "nb-NO", terms: ["anbudskonkurranse", "kunngjøring", "anskaffelse"], deadlineLabels: ["tilbudsfrist"], portals: ["doffin.no"] },
  ie: {
    lang: "en-IE",
    terms: ["tender", "request for tender", "contract notice"],
    deadlineLabels: ["deadline", "closing date", "time limit for receipt"],
    portals: ["etenders.gov.ie"],
  },
  gb: {
    lang: "en-GB",
    terms: ["tender", "invitation to tender", "contract notice"],
    deadlineLabels: ["deadline", "closing date", "tender submission deadline"],
    portals: ["find-tender.service.gov.uk", "contractsfinder.service.gov.uk"],
  },
  fr: {
    lang: "fr-FR",
    terms: ["appel d'offres", "avis de marché", "marché public", "consultation", "DCE"],
    deadlineLabels: ["date limite de réception des offres", "date limite de remise des offres", "date limite"],
    portals: ["marches-publics.gouv.fr", "boamp.fr"],
  },
  lu: { lang: "fr-LU", terms: ["avis de marché", "marché public", "appel d'offres"], deadlineLabels: ["date limite"], portals: ["pmp.b2g.etat.lu"] },
  ca: {
    lang: "en-CA",
    terms: ["tender", "request for proposal", "appel d'offres"],
    deadlineLabels: ["closing date", "date de clôture"],
    portals: ["canadabuys.canada.ca", "merx.com"],
  },
  us: {
    lang: "en-US",
    terms: ["request for proposal", "RFP", "solicitation", "invitation for bid"],
    deadlineLabels: ["response date", "due date", "closing date", "proposals due"],
    portals: ["sam.gov", "bidnetdirect.com"],
  },
  au: {
    lang: "en-AU",
    terms: ["approach to market", "request for tender", "tender"],
    deadlineLabels: ["close date", "closing time"],
    portals: ["tenders.gov.au"],
  },
  nz: { lang: "en-NZ", terms: ["tender", "request for proposal", "RFx"], deadlineLabels: ["closing date", "deadline"], portals: ["gets.govt.nz"] },
  in: {
    lang: "en-IN",
    terms: ["tender", "e-tender", "NIT", "bid document"],
    deadlineLabels: ["bid submission end date", "last date", "closing date"],
    portals: ["eprocure.gov.in", "gem.gov.in"],
  },
  sg: { lang: "en-SG", terms: ["tender", "quotation", "invitation to quote"], deadlineLabels: ["closing date"], portals: ["gebiz.gov.sg"] },
  za: { lang: "en-ZA", terms: ["tender", "bid", "request for bid"], deadlineLabels: ["closing date", "closing time"], portals: ["etenders.gov.za"] },
  ma: {
    lang: "fr-MA",
    terms: ["appel d'offres", "avis d'appel d'offres", "marché public"],
    deadlineLabels: ["date limite", "date d'ouverture des plis"],
    portals: ["marchespublics.gov.ma"],
  },
  tn: { lang: "fr-TN", terms: ["appel d'offres", "consultation"], deadlineLabels: ["date limite"], portals: ["tuneps.tn"] },
  sn: {
    lang: "fr-SN",
    terms: ["appel d'offres", "avis d'appel d'offres", "DAO"],
    deadlineLabels: ["date limite de dépôt", "date limite"],
    portals: ["marchespublics.sn"],
  },
  ci: { lang: "fr-CI", terms: ["appel d'offres", "avis d'appel d'offres"], deadlineLabels: ["date limite"], portals: ["marchespublics.ci"] },
  mx: {
    lang: "es-MX",
    terms: ["licitación pública", "convocatoria", "contratación"],
    deadlineLabels: ["presentación y apertura de proposiciones", "fecha límite"],
    portals: ["comprasmx.buengobierno.gob.mx"],
  },
  cl: { lang: "es-CL", terms: ["licitación", "mercado público"], deadlineLabels: ["fecha de cierre"], portals: ["mercadopublico.cl"] },
  ar: { lang: "es-AR", terms: ["licitación", "contratación"], deadlineLabels: ["fecha de apertura"], portals: ["comprar.gob.ar"] },
  pe: {
    lang: "es-PE",
    terms: ["licitación", "convocatoria", "procedimiento de selección"],
    deadlineLabels: ["presentación de ofertas"],
    portals: ["seace.gob.pe"],
  },
  br: { lang: "pt-BR", terms: ["licitação", "edital", "pregão"], deadlineLabels: ["encerramento", "data limite"], portals: ["pncp.gov.br", "gov.br/compras"] },
  co: {
    lang: "es-CO",
    terms: ["licitación", "proceso de contratación", "pliego de condiciones"],
    deadlineLabels: ["presentación de ofertas", "fecha de cierre"],
    portals: ["secop.gov.co"],
  },
};

const DEFAULT_MARKET: WebMarket = {
  lang: "en",
  terms: ["tender", "call for tenders", "request for proposal", "procurement notice"],
  deadlineLabels: ["deadline", "closing date"],
  portals: [],
};

export function marketFor(country: string): WebMarket {
  return WEB_MARKETS[country] ?? DEFAULT_MARKET;
}

export interface WebTodoItem {
  country: string;
  lang: string;
  /** The user's terms this item searches for, in this market's language. */
  terms: string[];
  queries: string[];
}

export interface WebTodo {
  version: 1;
  generatedAt: string;
  items: WebTodoItem[];
  why: string;
}

/**
 * The queries for each country: the user's own terms crossed with the
 * market's procurement vocabulary, once open, once on each portal.
 *
 * `termsFor` is the user's (or the profile's) terms for a language: the engine
 * ships no translation, exactly as `enrich --terms` ships none. A country with
 * no terms in its language gets the ones given in any language, and the item
 * says so — searching Italian portals for an English word is a weak search,
 * and the agent is told to translate.
 */
export function buildWebTodo(countries: readonly string[], termsFor: (lang: string) => string[], perCountry = 6, now = new Date()): WebTodo {
  const items: WebTodoItem[] = [];
  const year = now.getUTCFullYear();
  for (const country of countries) {
    const m = marketFor(country);
    const primary = m.lang.slice(0, 2);
    const terms = termsFor(primary);
    if (!terms.length) continue;
    const queries: string[] = [];
    for (const term of terms) {
      queries.push(`"${term}" ${m.terms[0]} ${year}`);
      for (const portal of m.portals) queries.push(`site:${portal} "${term}"`);
      if (m.terms[1]) queries.push(`"${term}" ${m.terms[1]}`);
    }
    items.push({ country, lang: m.lang, terms, queries: [...new Set(queries)].slice(0, perCountry) });
  }
  return {
    version: 1,
    generatedAt: now.toISOString(),
    items,
    why: "These countries have no open API this tool reads, or only an above-threshold one. Their national market is visible by search alone.",
  };
}

export interface WebHit {
  url: string;
  title?: string;
  snippet?: string;
  country?: string;
  query?: string;
}

/** Pool hits from the keyless engines — the fallback, weaker than the agent's own search. */
export async function engineSearchWeb(todo: WebTodo, onNote?: (n: string) => void): Promise<WebHit[]> {
  const hits: WebHit[] = [];
  for (const item of todo.items) {
    for (const query of item.queries) {
      const res = await search(query, { lang: item.lang, limit: 10, timeoutMs: 20_000 });
      for (const n of res.notes) onNote?.(`${item.country}: ${n}`);
      for (const h of res.hits) hits.push({ url: h.url, title: h.title, snippet: h.snippet, country: item.country, query });
    }
  }
  return hits;
}

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

/**
 * Read a deadline off a notice page — only where a deadline label introduces it.
 * Returns the date as written, normalised to ISO, plus the evidence string.
 */
export function readLabelledDeadline(text: string, labels: readonly string[]): { deadline?: string; evidence?: string } {
  const t = text.replace(/\s+/g, " ");
  const ft = fold(t);
  for (const label of [...labels, ...DEFAULT_MARKET.deadlineLabels]) {
    let from = 0;
    const fl = fold(label);
    for (;;) {
      const at = ft.indexOf(fl, from);
      if (at < 0) break;
      from = at + fl.length;
      const window = t.slice(at + label.length, at + label.length + 80);
      const iso = window.match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
      const dmy = window.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})(?:\D{1,8}(\d{1,2})[:h](\d{2}))?/);
      const m = iso
        ? { y: iso[1], mo: iso[2], d: iso[3], h: iso[4], mi: iso[5] }
        : dmy
          ? { y: dmy[3], mo: dmy[2]!.padStart(2, "0"), d: dmy[1]!.padStart(2, "0"), h: dmy[4], mi: dmy[5] }
          : undefined;
      if (!m) continue;
      const day = `${m.y}-${m.mo}-${m.d}`;
      if (Number(m.mo) < 1 || Number(m.mo) > 12 || Number(m.d) < 1 || Number(m.d) > 31) continue;
      return { deadline: m.h ? `${day}T${m.h.padStart(2, "0")}:${m.mi}` : day, evidence: t.slice(at, at + label.length + 40).trim() };
    }
  }
  return {};
}

export interface WebFoldOutcome {
  tenders: Tender[];
  fetched: number;
  rejected: { url: string; why: string }[];
  unreadable: { url: string; why: string }[];
}

export function webTenderId(url: string): string {
  return `web:${createHash("sha256").update(url).digest("hex").slice(0, 16)}`;
}

/**
 * Fetch every hit and keep the ones whose page corroborates a call for tenders.
 *
 * Two independent things must be ON THE PAGE: a procurement term of that
 * market, and one of the user's terms. A page with only the first is somebody
 * else's tender; with only the second it is a product page. Both is a lead the
 * agent then reads — the deadline, buyer and requirements come from the page,
 * through `tender` and the packet, never from the search snippet.
 */
export async function foldWebHits(
  runDir: string,
  hits: readonly WebHit[],
  todo: WebTodo | undefined,
  store: PageStore,
  known: ReadonlySet<string>,
  opts: { limit?: number; onProgress?: (line: string) => void } = {},
): Promise<WebFoldOutcome> {
  const out: Tender[] = [];
  const rejected: WebFoldOutcome["rejected"] = [];
  const unreadable: WebFoldOutcome["unreadable"] = [];
  const seen = new Set<string>();
  let fetched = 0;
  for (const hit of hits) {
    if (opts.limit && out.length >= opts.limit) break;
    let url: string;
    try {
      url = new URL(hit.url).toString();
    } catch {
      rejected.push({ url: hit.url, why: "not a URL" });
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    const id = webTenderId(url);
    if (known.has(id)) continue;
    const country = (hit.country ?? todo?.items.find((i) => i.queries.includes(hit.query ?? ""))?.country ?? "").toLowerCase();
    const market = marketFor(country);
    const item = todo?.items.find((i) => i.country === country);
    const userTerms = item?.terms ?? [];
    const res = await fetchPage(runDir, id, url, "notice", store);
    fetched += 1;
    if (!res.ok) {
      unreadable.push({ url, why: res.reason === "refused" ? `HTTP ${(res as any).status}` : res.reason });
      continue;
    }
    const text = res.page.text;
    const ft = fold(text);
    // The market's OWN procurement vocabulary. Measured on an Italian pass: the
    // English "tender" alone corroborated an ANAC guidelines PDF — a page ABOUT
    // procurement, not a call. English terms count only for an English market.
    const procurement = market.terms.filter((t) => ft.includes(fold(t)));
    const mine = userTerms.filter((t) => ft.includes(fold(t)));
    if (!procurement.length || (userTerms.length && !mine.length)) {
      rejected.push({ url, why: !procurement.length ? "no procurement term of this market on the page" : "none of your terms on the page" });
      continue;
    }
    const { deadline, evidence } = readLabelledDeadline(text, market.deadlineLabels);
    // A labelled deadline already behind us is an old call, not a lead.
    if (deadline && statusFromDeadline("call", deadline) === "closed") {
      rejected.push({ url, why: `closed: the page gives a deadline of ${deadline} ("${evidence}")` });
      continue;
    }
    const t: Tender = {
      id,
      connectorId: "web",
      noticeId: url,
      country: country || "ww",
      kind: "call",
      status: statusFromDeadline("call", deadline),
      title: (res.page.title ?? hit.title ?? url).slice(0, 300),
      description: hit.snippet,
      language: market.lang.slice(0, 2),
      buyer: { name: "" },
      cpv: [],
      nature: "unknown",
      lots: [],
      deadline,
      documentsAccess: "unknown",
      places: [],
      criteria: [],
      awards: [],
      sourceUrl: res.page.record.url,
      coverage: "web",
      aliases: [url],
      pages: [res.page.record],
      web: { query: hit.query, hitUrl: hit.url, corroboratedBy: [...procurement.slice(0, 3), ...mine.slice(0, 3)] },
      national: { deadlineEvidence: evidence },
    };
    out.push(t);
    opts.onProgress?.(`  web: kept ${url}${deadline ? ` (deadline ${deadline})` : " (no labelled deadline — open it)"}`);
  }
  return { tenders: out, fetched, rejected, unreadable };
}
