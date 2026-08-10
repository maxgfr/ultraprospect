// What a company register connector is, and — more importantly — what it admits
// it cannot do.
//
// The naive shape for this is `interface Register { search(area) }`, and it is
// wrong, because it would make every country look like France. Measured against
// the live services, exactly one register in this tool can enumerate the
// companies inside a territory without an API key: the French one. Everywhere
// else the register can confirm a company you already found, and nothing more.
//
// So capability is DECLARED, per connector, and the pipeline reads it:
//
//   sweep     enumerate every company in a bounded area.        FR only.
//   lookup    find a company by name + locality.                most connectors.
//   verifyId  confirm an identifier read off the company's      the strongest
//             own site, and return the filed identity.          signal there is.
//
// A connector that declares no `sweep` is not broken and must never be reported
// as unavailable: `scan` says the territory was covered by OSM alone, and
// `confirm` does the register work one company at a time, afterwards. The
// manifest carries which of the two happened. Blurring them would let a run over
// Berlin read exactly like a run over Vincennes, which is the single most
// expensive lie this tool could tell.
import type { GeoTarget, LaneCoverage, PostalAddress, Dirigeant } from "../types.js";
import type { ActivityScheme } from "../classification/index.js";

/** How a register lane covered its territory. The manifest must never blur these. */
export type RegistryMode = "sweep" | "confirm";

/**
 * One establishment or legal unit, as some register filed it.
 *
 * The generalisation of what used to be `SireneRecord`. The fields here are the
 * ones every register in scope actually publishes; anything national keeps its
 * own vocabulary under `national` rather than being flattened into a lowest
 * common denominator that means something slightly different in each country.
 */
export interface RegistryRecord {
  /** Which connector produced this. Part of the place id, so it must be stable. */
  connectorId: string;
  /** The LEGAL UNIT's identifier: SIREN, company number, organisasjonsnummer, CIK… */
  id: string;
  /**
   * The ESTABLISHMENT's identifier, where the register has that concept at all.
   *
   * France files establishments (SIRET) and this tool's unit is the place, so a
   * chain with four branches on one high street is four prospects. Most other
   * registers file only the legal unit; there, this is absent and one record is
   * one company.
   */
  establishmentId?: string;
  /** Every name the register knows it by, best-for-matching first: trading names, then legal name, then acronym. */
  names: string[];
  /** The filed legal name, on its own. What a report should print as the company's identity. */
  legalName?: string;
  /**
   * Trading names / brands / enseignes, kept apart from the legal name.
   *
   * A separate signal, not a synonym: a franchise is mapped in OSM as
   * `brand=Carrefour` while the register files it under a holding company
   * nobody has heard of. Collapsing the two into one name list would make the
   * matcher unable to say WHICH signal carried a merge, and that explanation is
   * what makes a surprising pair re-judgeable.
   */
  tradingNames?: string[];
  /**
   * THIS RECORD's activity — the establishment's, where the register has
   * establishments at all.
   *
   * Kept distinct from `parent.activityCode` because they differ more often
   * than you would expect, and the difference is real rather than a data flaw:
   * Orange is a telecom operator (NACE J) and its Vincennes establishment is a
   * phone shop (NACE G). Both are true, and a prospect list about the shop
   * should say shop.
   */
  activityCode?: string;
  /** The section/division letter, resolved through the connector's scheme. */
  section?: string;
  /** Which vocabulary `activityCode` and `section` are in. Never assume. */
  activityScheme?: ActivityScheme;
  /** The register's own headcount band code, when it publishes bands rather than a number. */
  sizeBand?: string;
  /** Year the band refers to. A 2019 band on a 2026 run is a fact about 2019. */
  sizeBandYear?: string;
  /** Exact headcount, for the registers that publish one (Brreg does; France does not). */
  employees?: number;
  /**
   * The LEGAL UNIT's activity and size, carried alongside the establishment's.
   *
   * Load-bearing rather than decorative: EVERY register filter matches on
   * these, never on the establishment's. Filtering `--section J,M` and
   * displaying only the establishment's retail code makes the tool look broken
   * when it is being accurate; showing both is what makes the row explicable.
   */
  parent?: {
    activityCode?: string;
    section?: string;
    sizeBand?: string;
    sizeBandYear?: string;
    employees?: number;
  };
  /** The register's own legal-form wording: "SAS", "GmbH", "Private limited company". */
  legalForm?: string;
  /** Latest filed accounts, where the register publishes them. */
  finances?: { year?: string; revenue?: number; netIncome?: number; currency?: string };
  /** How many establishments the legal unit has in total, where published. */
  establishmentCount?: number;
  /** Directors and officers, where published. Stripped wholesale by `--no-people`. */
  officers: Dirigeant[];
  address: PostalAddress;
  lat?: number;
  lon?: number;
  /** ISO-3166-1 alpha-2, lowercased. */
  countryCode?: string;
  /** Normalised to these three. A register that says nothing says "unknown", never "active". */
  status?: "active" | "ceased" | "unknown";
  dateCreated?: string;
  dateClosed?: string;
  /** True when this establishment is the registered head office. */
  isHeadOffice?: boolean;
  /**
   * A URL a human can open to see this record on the register's own site.
   *
   * Not decorative: `check` re-resolves citations, and a register fact whose
   * only provenance is "the API said so" cannot be re-read six weeks later.
   */
  sourceUrl?: string;
  /** Fields that exist in one country and nowhere else. Never invent a shared meaning. */
  national?: Record<string, unknown>;
}

/** A legal identifier read off a company's own site, before anyone has confirmed it. */
export interface LegalId {
  /** "vat" | "siren" | "siret" | "company-number" | "hrb" | "lei" | "cik" … */
  kind: string;
  value: string;
  /** ISO-3166-1 alpha-2, lowercased. Decides which authority is asked. */
  countryCode: string;
  /** Page id (`P4`) the value was read from. Carried so `check` can re-read it. */
  from?: string;
  /** Free text the register needs but the identifier does not carry — a German registry court, say. */
  context?: string;
}

/** Filters a sweep may apply. Only the French connector implements any of these today. */
export interface RegistryFilters {
  /** Activity codes in the connector's own scheme. */
  activityCodes?: string[];
  /** Section letters in the connector's own scheme. */
  sections?: string[];
  /** The register's own headcount band codes. */
  sizeBands?: string[];
  /** Include companies the register marks as ceased. Off by default. */
  includeCeased?: boolean;
  /** Stop after this many records and declare the lane partial. */
  maxResults?: number;
}

export interface LookupQuery {
  /** Every name worth trying, best first. */
  names: string[];
  countryCode: string;
  /** Narrows a common name to one town. Almost always the difference between 1 hit and 400. */
  locality?: string;
  postcode?: string;
  lat?: number;
  lon?: number;
  /** Cap on records returned. Connectors must honour it; a lookup is per-company and runs N times. */
  limit?: number;
}

export interface SweepResult {
  records: RegistryRecord[];
  coverage: LaneCoverage;
  notes: string[];
}

/**
 * One assertion about an upstream's response shape, for the weekly canary.
 *
 * `inconclusive` exists because of the Overpass lesson already learnt in
 * `evals/run.mjs`: an upstream being busy is not drift, and reporting it as
 * drift is how a canary teaches people to ignore it.
 */
export interface CanaryCheck {
  name: string;
  ok: boolean;
  detail?: string;
  inconclusive?: boolean;
}

/** Why a connector cannot run right now. Never a throw: a missing key is a configuration fact, not a failure. */
export interface ConnectorUnavailable {
  available: false;
  reason: string;
  /** What the user would have to do. Printed verbatim, so it must be actionable. */
  how?: string;
}

export interface ConnectorAvailable {
  available: true;
}

export type Availability = ConnectorAvailable | ConnectorUnavailable;

export interface ConnectorContext {
  /** Keys supplied by flag or environment, by connector id. */
  keys?: Record<string, string | undefined>;
  onNote?: (note: string) => void;
  onProgress?: (done: number, label: string) => void;
}

export interface RegistryConnector {
  /** Stable, lowercase, hyphenated. Appears in place ids and in `--registry`, so renaming one is a breaking change. */
  id: string;
  /** ISO-3166-1 alpha-2 codes this connector serves, lowercased. `["*"]` means worldwide. */
  countries: readonly string[];
  /** One line, for `doctor` and the report. */
  label: string;
  /** The attribution that must travel with the data. Joins `manifest.licences` only if the connector ran. */
  licence: string;
  /** Which activity vocabulary this connector's codes are in. */
  activityScheme: ActivityScheme;
  /**
   * The namespace `place.category` uses for this connector's codes: "naf", "sic".
   *
   * DECLARED, never derived from the connector id. Two NACE countries write
   * NACE differently — "62.01Z" is NAF and "62012" is UK SIC — so the namespace
   * is finer than the scheme, and it is what stops a table comparing codes that
   * only agree down to the division.
   */
  activityPrefix: string;
  /** Documentation a human can read when a record looks wrong. */
  docsUrl: string;
  /**
   * The register's own headcount bands, smallest first.
   *
   * Present only for registers that publish bands (France does; Norway files an
   * exact number in `RegistryRecord.employees`). Nothing downstream may assume
   * every record has a band, and a band code is only ever interpreted through
   * the connector that issued it — "12" means 20-49 in France and nothing
   * anywhere else.
   *
   * ORDER IS LOAD-BEARING and this must stay an array. Half of France's codes
   * ("11", "12", "21"…) are canonical array indices as far as JavaScript is
   * concerned, so an object literal reorders them silently.
   */
  sizeBands?: ReadonlyArray<{ code: string; floor: number; label: string }>;
  /**
   * Set when the connector needs a credential.
   *
   * Its presence is not a failure mode — `availability()` returns unavailable
   * with `how`, the run continues, and the manifest records that this
   * connector was skipped for want of a key rather than pretending the
   * territory has no register.
   */
  needsKey?: { flag: string; env: string; how: string };

  /** Can this connector run, given the context? Cheap, synchronous, no network. */
  availability(ctx: ConnectorContext): Availability;

  /** Enumerate every company in a territory. Absent means the register cannot be swept. */
  sweep?(target: GeoTarget, filters: RegistryFilters, ctx: ConnectorContext): Promise<SweepResult>;

  /** Find a company by name and locality. */
  lookup?(query: LookupQuery, ctx: ConnectorContext): Promise<RegistryRecord[]>;

  /** Confirm an identifier read off a company's own site, and return what the register filed under it. */
  verifyId?(id: LegalId, ctx: ConnectorContext): Promise<RegistryRecord | undefined>;

  /** Does the upstream still speak the shape we parse? Run weekly, never in the unit suite. */
  canary(ctx: ConnectorContext): Promise<CanaryCheck[]>;

  /** Is the upstream up? Called by `doctor`, only for the country in play. */
  probe(ctx: ConnectorContext): Promise<{ ok: boolean; detail: string }>;
}

/** The best name to show for a record: the trading name if there is one, else the legal one. */
export function displayName(rec: RegistryRecord): string {
  return rec.names.find((n) => n?.trim()) ?? rec.id;
}

/**
 * The stable id a place gets when a register record is its origin.
 *
 * Prefixed by connector rather than by country: two connectors can serve the
 * same country (VIES and Companies House both cover GB) and their identifier
 * spaces do not overlap, so the connector is what makes the id unambiguous.
 */
export function recordKey(rec: RegistryRecord): string {
  return `${rec.connectorId}:${rec.establishmentId ?? rec.id}`;
}
