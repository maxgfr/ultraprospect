// What a public tender is, here, and what a tender source admits it cannot see.
//
// The registry half of this tool learned the expensive lesson first: a list is
// only as honest as its account of what it did NOT cover. Procurement has the
// same trap in a different shape. Above the EU thresholds every member state
// publishes to TED, so TED alone makes every European country look covered —
// and below those thresholds, where most contracts a small firm can win live,
// TED knows nothing. A run over Italy answered by TED alone is "the Italian
// contracts large enough for Brussels", and it must say so.
//
// So coverage is DECLARED per connector, as with registers:
//
//   all             the national portal: every threshold the law publishes.
//   above-threshold only contracts above the EU (or GPA) thresholds.
//   below-threshold only contracts below them (UK Contracts Finder).
//   funded          notices of one funder's projects, worldwide (World Bank).
//   web             found by search and corroborated against the page itself —
//                   coverage is whatever the search reached, never a census.
//
// A tender source also answers different QUESTIONS. Some publish open calls,
// some only awards, some both. `kinds` says which, and `awards` (who won what)
// is never inferred from a source that only publishes calls.
import type { LaneCoverage, PageRecord } from "../types.js";

export type TenderCoverage = "all" | "above-threshold" | "below-threshold" | "funded" | "web";

/** What a notice announces. A call is biddable; an award is history. */
export type NoticeKind = "call" | "award" | "prior" | "modification" | "cancellation";

export type TenderStatus = "open" | "closed" | "awarded" | "cancelled" | "unknown";

/** What the contract buys. The three words procurement law itself uses. */
export type ContractNature = "works" | "supplies" | "services" | "mixed" | "unknown";

/** Whether the procurement documents (the DCE) can be read without an account. */
export type DocumentsAccess = "open" | "registration" | "unknown";

export interface Money {
  amount: number;
  currency: string;
  /** True when the buyer published an ESTIMATE, not a contracted value. */
  estimated: boolean;
}

export interface TenderParty {
  name: string;
  /** Whatever identifier the notice publishes: SIRET, company number, CNPJ, VAT… */
  legalId?: string;
  /** ISO 3166-1 alpha-2, lower case. */
  country?: string;
  city?: string;
}

export interface TenderAward {
  supplier: TenderParty;
  value?: Money;
  /** When the contract was awarded or concluded, as published. */
  date?: string;
  /** The contract's duration in months, ONLY when the notice states one. */
  durationMonths?: number;
  /** The contract's end date, when the notice states one. */
  endDate?: string;
  /** "sme" | "large" … as the source says, when it says. */
  size?: string;
}

export interface TenderLot {
  id?: string;
  title?: string;
  value?: Money;
  cpv?: string[];
}

/**
 * One notice, from one source, normalised just enough to compare across
 * countries — and no further. Anything only one source has goes under
 * `national`, in that source's own words.
 */
export interface Tender {
  /** `<connectorId>:<noticeId>`. Stable across runs: `watch` keys on it. */
  id: string;
  connectorId: string;
  /** The notice id as the source prints it. */
  noticeId: string;
  /** ISO 3166-1 alpha-2, lower case: the BUYER's country. */
  country: string;
  kind: NoticeKind;
  status: TenderStatus;
  title: string;
  description?: string;
  /** BCP-47-ish language of title/description, as the source declares it. */
  language?: string;
  buyer: TenderParty;
  /** CPV codes as published, 8 digits, no check digit. */
  cpv: string[];
  nature: ContractNature;
  procedure?: string;
  value?: Money;
  lots: TenderLot[];
  /** ISO date or datetime, as published. */
  publishedAt?: string;
  /**
   * The submission deadline AS PUBLISHED, offset included when the source gives
   * one. Never computed, never defaulted: a deadline this tool made up is the
   * single most expensive thing it could hand a bidder.
   */
  deadline?: string;
  /** Where to read or download the procurement documents. */
  documentsUrl?: string;
  documentsAccess: DocumentsAccess;
  /** Where a bid is submitted, when the notice says. */
  submissionUrl?: string;
  /** Place of performance: NUTS codes in Europe, regions elsewhere. */
  places: string[];
  /** Award criteria as published (name + weight when given). */
  criteria: { name: string; weight?: string }[];
  awards: TenderAward[];
  /**
   * A URL a human can open that shows THIS notice. Absent when the source has
   * no per-notice page — never a search page or a homepage.
   */
  sourceUrl?: string;
  /** Set when the record came from a dated bulk export rather than a live query. */
  asOf?: string;
  /** Coverage of the source that produced it. Travels with the record. */
  coverage: TenderCoverage;
  /** Other ids this notice is known by (a TED number on a national notice…). */
  aliases: string[];
  national?: Record<string, unknown>;
  /** Set by `tender` (and the web lane): the stored pages — notice, documents — cited as [P#]. */
  pages?: PageRecord[];
  /** Set by `tender`: why documents could not be read, when they could not. */
  documentsNote?: string;
  /** Set by `tenders --apply`: the agent's qualification. */
  verdict?: TenderVerdict;
  /** Set when this notice was found by web search, not by an API. */
  web?: { query?: string; hitUrl: string; corroboratedBy: string[] };
}

export type BidDecision = "go" | "maybe" | "no-go";
export type TenderFit = "strong" | "possible" | "weak" | "no";

/** The agent's judgement on one notice, folded back by `tenders --apply`. */
export interface TenderVerdict {
  id: string;
  decision: BidDecision;
  fit: TenderFit;
  why: string;
  /** What would stop the bid: a certification, a turnover floor, a site visit… */
  blockers?: string[];
  /** Page ids or profile references the verdict rests on: ["P3", "R2"]. */
  cites?: string[];
  at?: string;
}

export interface TenderQuery {
  /** ISO alpha-2, lower case. Empty means "whatever the connector covers". */
  countries: string[];
  /** CPV prefixes: "72" matches every 72xxxxxx code. */
  cpv: string[];
  /** Free-text terms, already in the market's own language. */
  keywords: string[];
  /** ISO date, inclusive. */
  publishedFrom?: string;
  publishedTo?: string;
  /** Which notices to ask for. */
  kinds: NoticeKind[];
  /** Only calls whose deadline is on or after this ISO date. */
  deadlineAfter?: string;
  minValue?: number;
  /**
   * How CPV and keywords combine when both are given. "any" (the default) keeps
   * a notice matching EITHER — a buyer that filed the wrong CPV but wrote the
   * right words is still a lead, and qualification is where precision belongs.
   */
  match?: "any" | "all";
  /** Per connector. */
  limit: number;
}

export interface SearchOutcome {
  tenders: Tender[];
  /** What the source said exists, when it says. */
  total?: number;
  truncated: boolean;
  reason?: string;
  notes?: string[];
}

export interface TenderAvailability {
  available: boolean;
  reason?: string;
}

export interface TenderCanaryCheck {
  name: string;
  ok: boolean;
  detail?: string;
  inconclusive?: boolean;
}

/**
 * A tender source. Capability is declared, exactly as for registers: a
 * connector that publishes no awards has no `awards`, and is never reported as
 * having found none.
 */
export interface TenderConnector {
  id: string;
  /** ISO alpha-2 lower case, or ["*"] for a worldwide source. */
  countries: string[];
  label: string;
  licence: string;
  docsUrl: string;
  coverage: TenderCoverage;
  /** What `search` can return. */
  kinds: NoticeKind[];
  /** True when a key is required; `availability` explains where to get one. */
  needsKey?: boolean;
  /** Set until the mapper has been checked against a live answer of this shape. */
  unverified?: boolean;
  availability(env?: Record<string, string | undefined>): TenderAvailability;
  search(q: TenderQuery): Promise<SearchOutcome>;
  canary(): Promise<TenderCanaryCheck[]>;
  probe(): Promise<{ ok: boolean; detail: string }>;
}

/** A tender lane in the manifest. Same interface as every other lane. */
export type TenderLane = LaneCoverage & {
  lane: "tenders";
  coverage?: TenderCoverage;
  kinds?: NoticeKind[];
  /** What the source said exists for this query, when it says. */
  total?: number;
};
