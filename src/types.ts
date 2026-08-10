// The domain model.
//
// One rule shapes every type here: a fact carries its provenance. `Place.name`
// knows which lane produced it; every contact knows the page it was read from.
// That is not bookkeeping for its own sake — `check` re-resolves those pointers
// and fails the run when one does not hold, which is the only reason a prospect
// file produced by a language model can be trusted at all.

/** Which upstream produced a fact. */
export type Lane = "osm" | "sirene" | "google" | "web" | "agent";

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
  /** ISO-3166-1 alpha-2, lowercased. Decides whether the SIRENE lane runs at all. */
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

/** A French establishment, as `recherche-entreprises` returns it. */
export interface SireneRecord {
  siren: string;
  siret?: string;
  nomComplet?: string;
  nomRaisonSociale?: string;
  sigle?: string;
  enseignes: string[];
  nafCode?: string;
  section?: string;
  categorieEntreprise?: string;
  natureJuridique?: string;
  effectifTranche?: string;
  effectifAnnee?: string;
  dateCreation?: string;
  dateFermeture?: string;
  etatAdministratif?: string;
  estSiege?: boolean;
  nombreEtablissements?: number;
  dirigeants: Dirigeant[];
  finances?: { annee?: string; ca?: number; resultatNet?: number };
  address: PostalAddress;
  lat?: number;
  lon?: number;
}

export interface PostalAddress {
  raw?: string;
  numero?: string;
  typeVoie?: string;
  libelleVoie?: string;
  codePostal?: string;
  /** INSEE code, not the postcode. */
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
  /** SIREN or VAT number found on the site itself — corroborates the register match. */
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
  /** 0-1. How sure the fusion is, when more than one lane contributed. */
  matchConfidence?: number;
  osm?: OsmPoi;
  sirene?: SireneRecord;
  google?: GooglePlace;
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

export interface GooglePlace {
  placeId: string;
  displayName?: string;
  rating?: number;
  userRatingCount?: number;
  types: string[];
  websiteUri?: string;
  nationalPhoneNumber?: string;
}

/** A pair the matcher scored but would not decide alone. */
export interface MatchCandidate {
  osmId: string;
  siret?: string;
  siren?: string;
  sireneName?: string;
  /** The register name that actually produced the score — an enseigne, often. */
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
    sirene: number;
    google: number;
    places: number;
    merged: number;
    undecided: number;
    withWebsite: number;
    enrichedTier1: number;
    enrichedTier2: number;
    dossiers: number;
  };
  truncated: boolean;
  notes: string[];
  /** Upstream attributions. ODbL requires this to travel with the data. */
  licences: string[];
  timings: Record<string, number>;
}
