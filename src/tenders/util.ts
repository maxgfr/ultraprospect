// Small, pure helpers shared by the tender connectors. No network here.
import { htmlToText } from "../engine.js";
import { foldAccents } from "../util.js";
import type { ContractNature, Money, Tender, TenderQuery } from "./types.js";

/**
 * ISO 3166-1 alpha-2 → alpha-3, for the countries TED and the eForms notices
 * speak about. TED's expert query takes alpha-3 (`buyer-country IN (FRA)`),
 * every other surface of this tool speaks alpha-2.
 */
export const ISO3: Record<string, string> = {
  at: "AUT",
  be: "BEL",
  bg: "BGR",
  hr: "HRV",
  cy: "CYP",
  cz: "CZE",
  dk: "DNK",
  ee: "EST",
  fi: "FIN",
  fr: "FRA",
  de: "DEU",
  gr: "GRC",
  hu: "HUN",
  ie: "IRL",
  it: "ITA",
  lv: "LVA",
  lt: "LTU",
  lu: "LUX",
  mt: "MLT",
  nl: "NLD",
  pl: "POL",
  pt: "PRT",
  ro: "ROU",
  sk: "SVK",
  si: "SVN",
  es: "ESP",
  se: "SWE",
  // EEA and others that publish to TED.
  no: "NOR",
  is: "ISL",
  li: "LIE",
  ch: "CHE",
  mk: "MKD",
  rs: "SRB",
  me: "MNE",
  al: "ALB",
  md: "MDA",
  ua: "UKR",
  ge: "GEO",
  tr: "TUR",
  ba: "BIH",
  xk: "XKX",
  gb: "GBR",
};

const ISO2_BY_3: Record<string, string> = Object.fromEntries(Object.entries(ISO3).map(([k, v]) => [v, k]));

export function iso2(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const c = code.trim();
  if (c.length === 2) return c.toLowerCase();
  return ISO2_BY_3[c.toUpperCase()];
}

/** The 27 member states: the countries for which TED is the above-threshold census. */
export const EU27 = [
  "at",
  "be",
  "bg",
  "hr",
  "cy",
  "cz",
  "dk",
  "ee",
  "fi",
  "fr",
  "de",
  "gr",
  "hu",
  "ie",
  "it",
  "lv",
  "lt",
  "lu",
  "mt",
  "nl",
  "pl",
  "pt",
  "ro",
  "sk",
  "si",
  "es",
  "se",
];

/** Normalise a CPV code to its 8 digits ("72000000-5" → "72000000"). */
export function cpvDigits(code: unknown): string | undefined {
  const m = String(code ?? "").match(/\d{8}/);
  return m?.[0];
}

/** A CPV prefix as the user typed it: "72", "722", "72000000" → digits only, trailing zeros trimmed past 2. */
export function cpvPrefix(raw: string): string {
  const d = raw.replace(/\D/g, "");
  if (d.length <= 2) return d;
  return d.replace(/0+$/, "").padEnd(2, "0");
}

export function matchesCpv(codes: readonly string[], prefixes: readonly string[]): boolean {
  if (prefixes.length === 0) return true;
  return codes.some((c) => prefixes.some((p) => c.startsWith(cpvPrefix(p))));
}

/** A CPV prefix as the full 8-digit code TED's hierarchical `IN` wants: "72" → "72000000". */
export function cpvFull(prefix: string): string {
  return cpvPrefix(prefix).padEnd(8, "0").slice(0, 8);
}

/**
 * Parse `--since`: "30d", "6m", "3y", "2w", or an ISO date. Returns an ISO date
 * (YYYY-MM-DD). Undefined when it cannot be read — callers refuse, never guess.
 */
export function sinceToDate(raw: string | undefined, now = new Date()): string | undefined {
  if (!raw) return undefined;
  const iso = raw.match(/^\d{4}-\d{2}-\d{2}$/);
  if (iso) return raw;
  const m = raw.trim().match(/^(\d+)\s*([dwmy])$/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  switch (m[2]!.toLowerCase()) {
    case "d":
      d.setUTCDate(d.getUTCDate() - n);
      break;
    case "w":
      d.setUTCDate(d.getUTCDate() - 7 * n);
      break;
    case "m":
      d.setUTCMonth(d.getUTCMonth() - n);
      break;
    case "y":
      d.setUTCFullYear(d.getUTCFullYear() - n);
      break;
  }
  return d.toISOString().slice(0, 10);
}

export function today(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** "2026-11-23+02:00" or "2026-11-23T12:00:00Z" → "2026-11-23". */
export function dayOf(value: string | undefined): string | undefined {
  const m = value?.match(/\d{4}-\d{2}-\d{2}/);
  return m?.[0];
}

/** "31-Oct-2026" (World Bank) → "2026-10-31". */
export function dayFromDmy(value: string | undefined): string | undefined {
  const m = value?.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return dayOf(value);
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const mo = months.indexOf(m[2]!.toLowerCase()) + 1;
  if (mo <= 0) return undefined;
  return `${m[3]}-${String(mo).padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
}

/**
 * Whether a published deadline is already behind us.
 *
 * Read IN THE DEADLINE'S OWN TERMS, which means in its own timezone when it
 * names one:
 *
 *   a time and an offset   "2026-11-23T23:00:00-08:00" is an instant, and is
 *                          compared as one;
 *   a day and an offset    "2026-11-23+02:00" is open all of the 23rd THERE,
 *                          so it passes when the 24th begins at that offset;
 *   neither                only a day is known, and it is compared with today's.
 *
 * Both sides used to be reduced to a day, but only the deadline in its own
 * terms: "today" was UTC's. A US notice due at 23:00 Pacific was closed at
 * 16:00 Pacific — the web lane then rejected it and a "go" verdict was refused
 * — and an Australian one stayed open for eleven hours after it had shut.
 *
 * Undefined means "unknown", never "open" — a call with no published deadline
 * is not a call you can plan on.
 */
export function deadlinePassed(deadline: string | undefined, now = new Date()): boolean | undefined {
  const day = dayOf(deadline);
  if (!day) return undefined;
  const m = deadline!.match(/(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?\s*(Z|[+-]\d{2}:?\d{2})?/);
  const time = m?.[2];
  const offset = m?.[3] ? (m[3] === "Z" ? "Z" : m[3].replace(/^([+-]\d{2}):?(\d{2})$/, "$1:$2")) : undefined;
  if (offset) {
    const instant = Date.parse(`${day}T${time ? (time.length === 5 ? `${time}:00` : time) : "00:00:00"}${offset}`);
    if (Number.isFinite(instant)) return time ? instant < now.getTime() : instant + 24 * 3600 * 1000 <= now.getTime();
  }
  return day < today(now);
}

export function toNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string") return undefined;
  const cleaned = v
    .replace(/[\s ]/g, "")
    .replace(/,(?=\d{1,2}$)/, ".")
    .replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) && cleaned !== "" ? n : undefined;
}

export function money(amount: unknown, currency: unknown, estimated: boolean): Money | undefined {
  const n = toNumber(amount);
  if (n === undefined || n <= 0) return undefined;
  const cur = Array.isArray(currency) ? currency[0] : currency;
  return { amount: n, currency: typeof cur === "string" && cur ? cur.toUpperCase() : "EUR", estimated };
}

export function natureOf(raw: unknown): ContractNature {
  const s = String(Array.isArray(raw) ? raw[0] : (raw ?? "")).toLowerCase();
  if (/work|travaux|bau|obras|lavori|works/.test(s)) return "works";
  if (/suppl|goods|fourniture|liefer|bienes|forniture|supplies/.test(s)) return "supplies";
  if (/servic|prestation|dienst|servicios|servizi|consult/.test(s)) return "services";
  if (/mix/.test(s)) return "mixed";
  return "unknown";
}

/** Durations as notices publish them → months. Undefined rather than a guess. */
export function durationMonths(value: unknown, unit: unknown): number | undefined {
  const n = toNumber(Array.isArray(value) ? value[0] : value);
  if (n === undefined || n <= 0) return undefined;
  const u = String(Array.isArray(unit) ? unit[0] : (unit ?? "")).toUpperCase();
  if (u.startsWith("Y") || u === "ANN" || u === "ANNEE") return n * 12;
  if (u.startsWith("MON") || u === "MOIS" || u === "MO") return n;
  if (u.startsWith("W")) return Math.round((n * 7) / 30.44);
  if (u.startsWith("D") || u.startsWith("JOUR") || u.includes("DÍA") || u.includes("DIA")) return Math.round(n / 30.44);
  return undefined;
}

/** First value of a TED multilingual field: {fra: ["…"]} → "…", preferring `langs`. */
export function pickLang(field: unknown, langs: readonly string[] = []): { text?: string; lang?: string } {
  if (!field) return {};
  if (typeof field === "string") return { text: field };
  if (Array.isArray(field)) return { text: field.find((x) => typeof x === "string") };
  if (typeof field !== "object") return {};
  const obj = field as Record<string, unknown>;
  const order = [...langs, ...Object.keys(obj)];
  for (const lang of order) {
    const v = obj[lang];
    const text = Array.isArray(v) ? v.find((x) => typeof x === "string") : typeof v === "string" ? v : undefined;
    if (text) return { text, lang };
  }
  return {};
}

export function allLang(field: unknown): string[] {
  if (!field || typeof field !== "object") return typeof field === "string" ? [field] : [];
  if (Array.isArray(field)) return field.filter((x): x is string => typeof x === "string");
  const first = Object.values(field as Record<string, unknown>)[0];
  return Array.isArray(first) ? first.filter((x): x is string => typeof x === "string") : typeof first === "string" ? [first] : [];
}

/** ISO 639-2/B (TED) → 639-1 for the languages a buyer is likely to write in. */
const LANG3: Record<string, string> = {
  fra: "fr",
  deu: "de",
  eng: "en",
  spa: "es",
  ita: "it",
  nld: "nl",
  pol: "pl",
  por: "pt",
  ces: "cs",
  slk: "sk",
  slv: "sl",
  hrv: "hr",
  hun: "hu",
  ron: "ro",
  bul: "bg",
  ell: "el",
  est: "et",
  lav: "lv",
  lit: "lt",
  fin: "fi",
  swe: "sv",
  dan: "da",
  mlt: "mt",
  gle: "ga",
  nor: "no",
  isl: "is",
};
export function lang2(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return code.length === 2 ? code.toLowerCase() : LANG3[code.toLowerCase()];
}

/** The buyer's own language for a country — the language its notices are written in. */
export const COUNTRY_LANG: Record<string, string> = {
  fr: "fra",
  de: "deu",
  at: "deu",
  be: "fra",
  lu: "fra",
  ch: "fra",
  it: "ita",
  es: "spa",
  pt: "por",
  nl: "nld",
  pl: "pol",
  cz: "ces",
  sk: "slk",
  si: "slv",
  hr: "hrv",
  hu: "hun",
  ro: "ron",
  bg: "bul",
  gr: "ell",
  cy: "ell",
  ee: "est",
  lv: "lav",
  lt: "lit",
  fi: "fin",
  se: "swe",
  dk: "dan",
  mt: "eng",
  ie: "eng",
  no: "nor",
  is: "isl",
};

/** A notice body some sources send as HTML, as text — through the engine's own reader. */
export function plainText(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const text = /<[a-z][\s\S]*>/i.test(html) ? htmlToText(html) : html;
  return text.trim() || undefined;
}

/**
 * Walk an eForms (UBL) notice rendered as JSON — the shape BOAMP ships in its
 * `donnees` field — and pull out the handful of things worth comparing.
 *
 * Read by key name, not by path: the same element sits at different depths in
 * a contract notice, a contract award notice and a prior information notice,
 * and following one path would read one of the three.
 */
export function readEforms(root: unknown): {
  cpv: string[];
  documents: string[];
  estimated?: Money;
  durationMonths?: number;
  deadline?: string;
  criteria: { name: string; weight?: string }[];
} {
  const cpv = new Set<string>();
  const documents = new Set<string>();
  let estimated: Money | undefined;
  let duration: number | undefined;
  let deadline: string | undefined;
  const criteria: { name: string; weight?: string }[] = [];

  const text = (v: any): string | undefined => (typeof v === "string" ? v : typeof v?.["#text"] === "string" ? v["#text"] : undefined);

  const visit = (node: any, key?: string): void => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, key);
      return;
    }
    if (typeof node !== "object") return;
    if (key === "cbc:ItemClassificationCode" && node["@listName"] === "cpv") {
      const c = cpvDigits(node["#text"]);
      if (c) cpv.add(c);
    }
    if (key === "cbc:EstimatedOverallContractAmount" && !estimated) estimated = money(node["#text"], node["@currencyID"], true);
    if (key === "cbc:DurationMeasure" && duration === undefined) duration = durationMonths(node["#text"], node["@unitCode"]);
    if (key === "cac:TenderSubmissionDeadlinePeriod" && !deadline) {
      const day = text(node["cbc:EndDate"]);
      const time = text(node["cbc:EndTime"]);
      if (day) deadline = time ? `${dayOf(day)}T${time}` : day;
    }
    if (key === "cac:ExternalReference") {
      const uri = text(node["cbc:URI"]);
      if (uri && /^https?:\/\//.test(uri)) documents.add(uri);
    }
    if (key === "cac:SubordinateAwardingCriterion") {
      const name = text(node["cbc:Name"]) ?? text(node["cbc:Description"]);
      const weight = findText(node, "efbc:ParameterNumeric");
      if (name) criteria.push({ name: name.slice(0, 200), weight });
    }
    for (const [k, v] of Object.entries(node)) visit(v, k);
  };

  visit(root);
  return { cpv: [...cpv], documents: [...documents], estimated, durationMonths: duration, deadline, criteria };
}

function findText(node: any, key: string): string | undefined {
  if (!node || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const n of node) {
      const t = findText(n, key);
      if (t) return t;
    }
    return undefined;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === key) return typeof v === "string" ? v : typeof (v as any)?.["#text"] === "string" ? (v as any)["#text"] : String(v);
    const t = findText(v, key);
    if (t) return t;
  }
  return undefined;
}

/**
 * Post-filter what a source returned against the query.
 *
 * Several upstreams accept a filter and do not apply it, or cannot express one
 * at all (a daily export takes no CPV). Applying every filter here, on every
 * connector, means a result never depends on which parameters an upstream
 * happened to honour — the same lesson `/near_point` taught the register lane.
 */
export function keepByQuery(t: Tender, q: TenderQuery): boolean {
  if (q.countries.length && !q.countries.includes(t.country)) return false;
  if (q.kinds.length && !q.kinds.includes(t.kind)) return false;
  const cpvHit = !q.cpv.length ? undefined : t.cpv.length ? matchesCpv(t.cpv, q.cpv) : t.national?.noCpvScheme && q.keywords.length ? undefined : false;
  const kwHit = !q.keywords.length ? undefined : keywordHit(t, q.keywords);
  // A source with no CPV scheme (CanadaBuys, SAM, PNCP…) cannot answer a CPV
  // filter: keywords carry it there, and with no keywords nothing can be shown
  // to match — so nothing is kept, rather than the whole country.
  const tests = [cpvHit, kwHit].filter((x): x is boolean => x !== undefined);
  if (tests.length) {
    const ok = (q.match ?? "any") === "all" ? tests.every(Boolean) : tests.some(Boolean);
    if (!ok) return false;
  }
  const pub = dayOf(t.publishedAt);
  if (q.publishedFrom && pub && pub < q.publishedFrom) return false;
  if (q.publishedTo && pub && pub > q.publishedTo) return false;
  if (q.deadlineAfter && t.kind === "call") {
    const d = dayOf(t.deadline);
    if (d && d < q.deadlineAfter) return false;
  }
  if (q.minValue && t.value && t.value.amount < q.minValue) return false;
  return true;
}

function keywordHit(t: Tender, keywords: readonly string[]): boolean {
  const fold = (s: string) => foldAccents(s.toLowerCase());
  const hay = fold(`${t.title}\n${t.description ?? ""}\n${t.lots.map((l) => l.title ?? "").join("\n")}`);
  return keywords.some((k) => hay.includes(fold(k)));
}

export function statusFromDeadline(kind: Tender["kind"], deadline: string | undefined, now = new Date()): Tender["status"] {
  if (kind === "award") return "awarded";
  if (kind === "cancellation") return "cancelled";
  if (kind !== "call") return "unknown";
  const passed = deadlinePassed(deadline, now);
  return passed === undefined ? "unknown" : passed ? "closed" : "open";
}
