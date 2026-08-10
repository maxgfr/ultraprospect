// The domain model.
//
// One rule shapes every type here: a fact carries its provenance. `Place.name`
// knows which lane produced it; every contact knows the page it was read from.
// That is not bookkeeping for its own sake — `check` re-resolves those pointers
// and fails the run when one does not hold, which is the only reason a prospect
// file produced by a language model can be trusted at all.

import type { RegistryMode, RegistryRecord } from "./registry/types.js";

/**
 * Which upstream produced a fact.
 *
 * `registry` rather than `sirene`: the French register is one connector among
 * several now, and a lane named after one country's service made every
 * downstream consumer read as if France were the only place with companies.
 * Which connector answered is on the record and on the lane, not in the enum.
 */
export type Lane = "osm" | "registry" | "web" | "agent";

/** A resolved geographic target: what `where` returns and `scan` searches. */
export interface GeoTarget {
  /** The string the user typed, kept verbatim for the manifest and the report. */
  query: string;
  /** Human-readable resolution, e.g. "Vincennes, Val-de-Marne, France". */
  label: string;
  lat: number;
  lon: number;
  /** [south, north, west, east] in degrees. */
  bbox: [number, number, number, number];
  /** ISO-3166-1 alpha-2, lowercased. Decides which register connectors apply at all. */
  countryCode?: string;
  /** OSM relation/way id, when the geocoder resolved an administrative area. */
  osmType?: "node" | "way" | "relation";
  osmId?: number;
  /** INSEE commune code (France only) — the SIRENE lane's most precise filter. */
  codeCommune?: string;
  postcode?: string;
  /** Which geocoder answered. */
  source: "ban" | "nominatim";
  /** Search radius in metres, when the target is a point rather than an area. */
  radiusM?: number;
}

/** A candidate the geocoder could not disambiguate. `where` prints these and exits 2. */
export interface GeoCandidate {
  label: string;
  lat: number;
  lon: number;
  kind: string;
  source: "ban" | "nominatim";
}

/** A raw OpenStreetMap point of interest, before matching. */
export interface OsmPoi {
  id: string;
  osmType: "node" | "way" | "relation";
  osmId: number;
  name?: string;
  lat: number;
  lon: number;
  tags: Record<string, string>;
}

/** A director or elected officer, as the register publishes them. */
export interface Dirigeant {
  nom?: string;
  prenoms?: string;
  qualite?: string;
  dateNaissance?: string;
  /** Legal persons appear as directors too — a holding company, typically. */
  denomination?: string;
  siren?: string;
}

/**
 * A postal address, in the shape the French register parses into.
 *
 * The field names stayed French deliberately. They are not a lowest common
 * denominator — `codeCommune` is an INSEE code and has no equivalent in
 * Norway — and renaming them to `street`/`city` would have implied a
 * cross-country meaning the values do not have. A connector fills the parts its
 * register actually publishes and leaves the rest alone; `raw` is always safe.
 */
export interface PostalAddress {
  raw?: string;
  numero?: string;
  typeVoie?: string;
  libelleVoie?: string;
  codePostal?: string;
  /** INSEE code, not the postcode. France only. */
  codeCommune?: string;
  commune?: string;
  pays?: string;
}

/** A datum that knows where it came from. Contacts are never stored bare. */
export interface SourcedValue {
  value: string;
  /** Page id (`P3`) for a web fact, or the lane name for an open-data one. */
  from: string;
  lane: Lane;
  /** Free-text context: the surrounding line, a role, a label. */
  note?: string;
}

/** A named human found on a page or in the register. */
export interface PersonRecord extends SourcedValue {
  role?: string;
  email?: string;
  /** Set when the person came from the register rather than a scraped page. */
  registry?: boolean;
}

/** One fetched page of a company's site. */
export interface PageRecord {
  id: string;
  url: string;
  role: PageRole;
  title?: string;
  fetchedAt: string;
  extractor?: string;
  status?: number;
  chars: number;
  /** Relative path of the extract inside the run dir. */
  extract: string;
}

export type PageRole = "home" | "about" | "services" | "products" | "pricing" | "careers" | "team" | "contact" | "news" | "cases" | "legal" | "other";

/** A job opening, from an ATS API or a careers page. */
export interface JobPosting {
  title: string;
  url?: string;
  location?: string;
  department?: string;
  employmentType?: string;
  postedAt?: string;
  /** Which ATS served it, or "site" when read off the page. */
  via: string;
}

/** Deterministic signals. The engine counts; it does not conclude. */
export interface Signals {
  hasWebsite: boolean;
  siteReachable?: boolean;
  pageCount: number;
  /** Newest `lastmod` in the sitemap, ISO date. Absence is not staleness. */
  lastContentAt?: string;
  sitemapUrls?: number;
  isHiring?: boolean;
  openRoles: number;
  atsProviders: string[];
  cms?: string;
  analytics: string[];
  techStack: string[];
  hasPricingPage: boolean;
  hasEcommerce: boolean;
  languages: string[];
  socialProfiles: string[];
  /** A registration or VAT number found on the site itself — corroborates the register match. */
  legalIdOnSite?: string;
}

/** The agent's ICP judgement, folded in by `score --apply`. */
export interface FitVerdict {
  id: string;
  fit: "strong" | "possible" | "weak" | "no";
  why: string;
  angle?: string;
}

export interface Score {
  total: number;
  parts: Record<string, number>;
  fit?: FitVerdict["fit"];
  why?: string;
  angle?: string;
}

/** The fused entity. One company, however many lanes saw it. */
export interface Place {
  id: string;
  name: string;
  /** Which lanes contributed. Order is discovery order, not precedence. */
  sources: Lane[];
  /** 0-1. The pair's actual score, never rounded up to certainty. */
  matchConfidence?: number;
  /** Which signal carried the merge: the name, a brand, or the street address. */
  matchedBy?: string;
  osm?: OsmPoi;
  /**
   * What a company register filed about this place, whichever register answered.
   *
   * In France it arrives from the territory sweep; everywhere else `confirm`
   * puts it here one company at a time, after the legal identity was read off
   * the company's own site. `registryEvidence` says which of the two happened,
   * because a swept record and a confirmed one are not equally strong.
   */
  registry?: RegistryRecord;
  /**
   * Legal identifiers this company published on its own site, and what an
   * authority said about each.
   *
   * Separate from `registry` because the two are different claims. A German
   * Impressum's VAT number can be confirmed LIVE by VIES while Germany
   * declines to say who holds it — that is a real, useful, citable fact, and it
   * is not an identity. Folding it into `registry` would let a validity check
   * masquerade as a register record; dropping it would throw away the only
   * thing an authority was willing to confirm.
   */
  legalIds?: Array<{
    /** "vat" | "hrb" | "siren" | "company-number" | "nif" … */
    kind: string;
    value: string;
    /** Page id (`P4`) it was read from, so `check` can re-read it. */
    from?: string;
    /**
     * verified — an authority confirmed it AND named the holder.
     * attested — an authority confirmed the identifier is live but disclosed no
     *   identity. Germany and Spain answer this way through VIES.
     * unverified — read off the page; no authority was able to answer.
     */
    status: "verified" | "attested" | "unverified";
    /** Which connector answered, when one did. */
    authority?: string;
    /** Free text: the German registry court, the reason nothing was disclosed. */
    note?: string;
  }>;
  /** How the register record got attached, and what backs it. */
  registryEvidence?: {
    mode: RegistryMode;
    /** "verified-id" | "name-lookup" | "sweep-match". */
    how: string;
    /** Page id the legal identifier was read from, when there was one. */
    from?: string;
    /** The identifier that was confirmed, e.g. "DE811907980". */
    legalId?: string;
  };
  address: PostalAddress;
  lat?: number;
  lon?: number;
  category?: string;
  website?: {
    url: string;
    confidence: "declared" | "corroborated" | "unverified";
    /** Page ids or lane names that back the claim. */
    evidence: string[];
  };
  contacts: {
    emails: SourcedValue[];
    phones: SourcedValue[];
    socials: SourcedValue[];
    people: PersonRecord[];
  };
  jobs: JobPosting[];
  signals?: Signals;
  score?: Score;
  pages: string[];
  /** Near-misses the matcher refused to merge, kept for audit. */
  matchCandidates?: MatchCandidate[];
}

/** A pair the matcher scored but would not decide alone. */
export interface MatchCandidate {
  osmId: string;
  /** Which register produced the candidate. Two connectors can cover one country. */
  connectorId: string;
  /** The establishment identifier where the register has one, else the legal-unit id. */
  registryId: string;
  /** The legal-unit identifier, when it differs from `registryId`. */
  legalId?: string;
  registryName?: string;
  /** The register name that actually produced the score — a trading name, often. */
  matchedName?: string;
  osmName?: string;
  score: number;
  parts: { distance: number; name: number; enseigne: number; address: number };
  distanceM: number;
}

export interface MatchTodo {
  version: 1;
  generatedAt: string;
  /** Every pair in the undecided band, for the agent to adjudicate. */
  pairs: MatchCandidate[];
}

/** How a lane's coverage ended: complete, or capped and saying so. */
export interface LaneCoverage {
  lane: Lane;
  /**
   * For a register lane: was the territory ENUMERATED, or were companies
   * confirmed one at a time?
   *
   * The most important field in this interface. A sweep answers "every company
   * filed here"; a confirm answers "the companies OSM found, checked against
   * the register". A reader who cannot tell them apart will read a Berlin run as
   * if it were a Vincennes run, and every downstream number will look complete.
   */
  mode?: RegistryMode;
  /** Which connector produced this coverage. Absent for the OSM lane. */
  connectorId?: string;
  requested: number;
  returned: number;
  /** True when an upstream limit stopped us short of everything that exists. */
  truncated: boolean;
  /** Human-readable reason, printed at the top of the report when truncated. */
  reason?: string;
  /** How the lane was split to stay under a cap. */
  partitions?: number;
}

export interface RunManifest {
  version: 1;
  tool: string;
  toolVersion: string;
  builtAt: string;
  slug: string;
  target: GeoTarget;
  filters: Record<string, unknown>;
  lanes: LaneCoverage[];
  counts: {
    osm: number;
    /** Register records, from every connector that ran. */
    registry: number;
    /** The same total, split by connector id, so a multi-connector run is legible. */
    byConnector: Record<string, number>;
    places: number;
    merged: number;
    undecided: number;
    withWebsite: number;
    enrichedTier1: number;
    enrichedTier2: number;
    /** Places a register confirmed after the fact, outside a sweep. */
    confirmed: number;
    dossiers: number;
  };
  truncated: boolean;
  notes: string[];
  /** Upstream attributions. ODbL requires this to travel with the data. */
  licences: string[];
  timings: Record<string, number>;
}
