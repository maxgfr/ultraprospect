// One derivation, two renderings.
//
// The report and the page answer the same questions about a run — how many
// companies carry a website we proved, how many are hiring, how many the
// register could name — and until now each counted them itself. Two counting
// loops over the same array will agree right up until one of them is changed,
// and the failure mode is a page and a report that disagree about a territory
// with no way for a reader to tell which is wrong.
//
// So every aggregate lives here, is computed once per run, and is handed to
// both renderers. Nothing in this file decides anything: it counts what is on
// the places, keeps the three-valued facts three-valued (hiring is yes, no, or
// we-could-not-look), and never fills a gap with a zero.
import { vocabularyOf } from "./classification/index.js";
import { connectorById } from "./registry/index.js";
import type { Place, RunManifest } from "./types.js";

/**
 * Group by activity, saying which taxonomy each row comes from.
 *
 * Several vocabularies are in play and they are NOT comparable. A register files
 * a company under a section letter, OSM tags a shopfront by feature key (shop,
 * amenity, office) — and the section letters themselves disagree across
 * countries: NACE "D" is electricity and gas, US SIC "D" is manufacturing. A
 * table listing "shop 460 / D 128" side by side reads as one ranking of one
 * thing, and it is neither. So every label names its own scheme.
 */
export function activityLabel(place: Place): string {
  const rec = place.registry;
  const section = rec?.section;
  if (section && rec) {
    const vocabulary = vocabularyOf(rec.activityScheme);
    const scheme = vocabulary.scheme === "none" ? rec.connectorId : vocabulary.scheme.toUpperCase();
    return `${vocabulary.label(section)} (${scheme} ${section})`;
  }
  // A register can file a company under a code that is NOT an activity — the UK's
  // "dormant company" and "residents property management" are administrative. Those
  // resolve to no section on purpose, and saying what the register actually said
  // beats falling through to "unclassified": a row of dormant shells is a finding
  // about a town, and one worth seeing before calling any of them.
  const administrative = rec?.national?.administrativeSic;
  if (typeof administrative === "string" && administrative) return `${administrative} (${rec!.connectorId}, not an activity code)`;

  const key = place.category?.split("=")[0];
  return key ? `${key} (OSM tag)` : "unclassified";
}

function distribution(places: readonly Place[]): { bySection: [string, number][]; byBand: [string, number][] } {
  const bySection = new Map<string, number>();
  for (const p of places) {
    const key = activityLabel(p);
    bySection.set(key, (bySection.get(key) ?? 0) + 1);
  }
  // Bands are walked in each connector's own ordered array, never in key order —
  // France's codes are canonical integer keys and an object literal reorders
  // them silently. A run can hold records from more than one connector, and
  // their band vocabularies do not line up, so each is counted on its own terms.
  const byBand: [string, number][] = [];
  const connectorIds = [...new Set(places.map((p) => p.registry?.connectorId).filter((id): id is string => Boolean(id)))];
  for (const id of connectorIds) {
    const bands = connectorById(id)?.sizeBands;
    if (!bands) continue;
    const scoped = places.filter((p) => p.registry?.connectorId === id);
    for (const band of bands) {
      const n = scoped.filter((p) => p.registry?.sizeBand === band.code).length;
      if (n > 0) byBand.push([connectorIds.length > 1 ? `${band.label} (${id})` : band.label, n]);
    }
  }
  return { bySection: [...bySection.entries()].sort((a, b) => b[1] - a[1]), byBand };
}

/**
 * What this run actually DID to the territory, in one sentence, derived.
 *
 * The header used to read `Swept <date>` unconditionally — eight lines above a
 * coverage table reporting `This is NOT a sweep`, on every run outside France.
 * The document contradicted itself about the one thing the whole architecture
 * exists to keep straight, and the word it chose was the one four documents
 * forbid.
 *
 * So the sentence is DERIVED from `manifest.lanes` and there is no longer a code
 * path that can claim a sweep the run did not perform. Two properties matter:
 *
 *   * The question is whether ANY register lane swept, never what the first one
 *     happened to say. A French run that also ran `confirm` carries both lanes
 *     (cli.ts keeps the `sweep` one and appends the `confirm` one), and reading
 *     `lanes[0]` would answer differently depending on which arrived first.
 *   * OSM sweeps worldwide, so its half is a sweep in every mode. Only the
 *     REGISTER half changes shape, and only that half is hedged.
 */
export function coverage(manifest: RunManifest): { sentence: string; short: string } {
  const date = manifest.builtAt.slice(0, 10);
  const version = `ultraprospect ${manifest.toolVersion}`;
  const registry = manifest.lanes.filter((l) => l.lane === "registry");
  const osm = manifest.lanes.find((l) => l.lane === "osm");
  const osmRan = Boolean(osm) && osm?.reason !== "skipped (--no-osm)";

  if (registry.some((l) => l.mode === "sweep")) {
    // The register was asked for every company in the area. France, and only
    // where a keyless enumeration exists.
    return { sentence: `Swept ${date} with ${version}.`, short: `swept ${date}` };
  }
  if (registry.some((l) => l.mode === "confirm")) {
    return {
      sentence: `OpenStreetMap swept ${date}; the register confirmed company by company, so a company nobody has mapped is not in this list. ${version}.`,
      short: `OSM swept ${date}, register confirmed company by company`,
    };
  }
  if (osmRan) {
    return {
      sentence: `OpenStreetMap swept ${date}; no register lane covered this territory. ${version}.`,
      short: `OSM swept ${date}, no register lane`,
    };
  }
  return { sentence: `Built ${date} with ${version}.`, short: `built ${date}` };
}

/** A deduplicated run note, with how many times the run emitted it. */
export interface NoteLine {
  text: string;
  count: number;
}

/** Score bands, coarse enough to read at a glance and fine enough to act on. */
const SCORE_BANDS: { label: string; min: number; max: number }[] = [
  { label: "70+", min: 70, max: Number.POSITIVE_INFINITY },
  { label: "50–69", min: 50, max: 69 },
  { label: "30–49", min: 30, max: 49 },
  { label: "1–29", min: 1, max: 29 },
  { label: "0", min: 0, max: 0 },
];

/** How the register attached a record, in words rather than in the enum's. */
const EVIDENCE_LABELS: Record<string, string> = {
  "verified-id": "by a published registration number",
  "name-lookup": "by a name lookup",
  "sweep-match": "by enumerating the territory",
};

export interface RunSummary {
  total: number;
  /** `declared` is a URL a mapper typed into OSM that nobody has checked. */
  websites: { corroborated: number; declared: number; unverified: number; none: number };
  /** Three-valued on purpose: an unreadable job board is not an absence of hiring. */
  hiring: { yes: number; no: number; unknown: number; roles: number; matchedRoles: number; ats: [string, number][] };
  contact: { emails: number; phones: number; both: number; any: number };
  registry: {
    withRecord: number;
    byConnector: [string, number][];
    byEvidence: [string, number][];
    /** Records out of a bulk snapshot: true on their date, not evidence about today. */
    dated: { count: number; years: string[] };
    headOffices: number;
    ceased: number;
    withOfficers: number;
    officers: number;
  };
  /** `attested` — an authority confirmed the number is live but named nobody. */
  legalIds: { verified: number; attested: number; unverified: number; total: number };
  site: {
    withCms: number;
    withLastContent: number;
    pricing: number;
    ecommerce: number;
    /** How many places we looked at a site for at all — the denominator above. */
    enriched: number;
    pagesRead: number;
    withPages: number;
    topTech: [string, number][];
  };
  scores: { bands: [string, number][]; zero: number; max: number };
  fit: { judged: number; byVerdict: [string, number][] };
  bySection: [string, number][];
  byBand: [string, number][];
  /** What the run was asked to look for, in sentences. Empty when nothing narrowed it. */
  filters: string[];
  /** The question the run was given, and how many companies answer it. */
  brief: Brief;
  notes: { lines: NoteLine[]; distinct: number; emitted: number };
}

/**
 * The question this run was given.
 *
 * `--term` and `--role` are the caller's brief: the lexicon whose verbatim
 * appearance on a company's own site is the finding, and the role titles that
 * make an opening one they asked about. Both were carried on every place, used
 * by the score, written to the CSV — and stated nowhere a reader would see, so
 * a page full of "term matches 12" never said what was being matched.
 *
 * Read off the places rather than off the manifest because that is where the
 * engine records them, beside the counts they produced.
 */
export interface Brief {
  terms: string[];
  roles: string[];
  /** True when the run was given either half. A run with no brief states none. */
  asked: boolean;
  /** Companies whose own site used one of the terms, verbatim. */
  termHits: number;
  /** Companies with at least one opening matching a role term. */
  roleHits: number;
}

function briefOf(places: readonly Place[]): Brief {
  const terms = places.find((p) => p.signals?.termLexicon?.length)?.signals?.termLexicon ?? [];
  const roles = places.find((p) => p.signals?.roleFilter?.length)?.signals?.roleFilter ?? [];
  return {
    terms,
    roles,
    asked: terms.length > 0 || roles.length > 0,
    termHits: places.filter((p) => (p.signals?.termMentions?.length ?? 0) > 0).length,
    roleHits: places.filter((p) => (p.signals?.matchedRoles ?? 0) > 0).length,
  };
}

function tally<T>(items: readonly T[], key: (item: T) => string | undefined): [string, number][] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    if (!k) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * What the run was NARROWED to, said out loud.
 *
 * `manifest.filters` decides which companies could have been found at all, and
 * it was rendered nowhere. A Hamburg run filtered to `office` tags produces an
 * activity table that is 99% "office", which reads as a broken taxonomy rather
 * than as the filter the caller asked for. Only narrowing is reported — a run
 * that looked at everything says nothing, because a list of defaults trains a
 * reader to skip the section that matters.
 */
export function describeFilters(filters: Record<string, unknown>): string[] {
  const out: string[] = [];
  const list = (v: unknown): string[] | undefined => (Array.isArray(v) && v.length ? v.map(String) : undefined);

  const groups = list(filters.osmGroups);
  if (groups) out.push(`OSM \`${groups.join("`, `")}\` tags only`);
  const codes = list(filters.activityCodes);
  if (codes) out.push(`register activity codes ${codes.join(", ")}`);
  const sections = list(filters.sections);
  if (sections) out.push(`register sections ${sections.join(", ")}`);
  const bands = list(filters.sizeBands);
  if (bands) out.push(`headcount bands ${bands.join(", ")}`);
  const ids = list(filters.registryIds);
  if (ids) out.push(`${ids.length} explicit register identifier(s)`);
  if (typeof filters.maxResults === "number" && filters.maxResults > 0) out.push(`capped at ${filters.maxResults} results`);
  // Stated only when ceased companies WERE kept: excluding them is the default,
  // and a default reported as a finding is noise.
  if (filters.includeCeased === true) out.push("ceased companies included");
  return out;
}

/**
 * Run notes, deduplicated and put in an order worth reading.
 *
 * The report used to print `notes.slice(-25)` — the last 25 of 1 447 on a real
 * run — which is how a Hamburg report came out as twenty-five near-identical
 * VIES lines while every lane summary (`confirm:`, `match:`, `enrich:`) had been
 * pushed out of the window. Repetition is information, so it is counted rather
 * than hidden, and the lane summaries lead because they describe the run rather
 * than one company in it.
 */
export function foldNotes(notes: readonly string[], cap = 25): { lines: NoteLine[]; distinct: number; emitted: number } {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const note of notes) {
    if (!counts.has(note)) order.push(note);
    counts.set(note, (counts.get(note) ?? 0) + 1);
  }
  const isSummary = (t: string) => /^(scan|confirm|match|resolve|enrich|score|dossier|check|render):/.test(t);
  const summaries = order.filter(isSummary).map((text) => ({ text, count: counts.get(text)! }));
  const rest = order
    .filter((t) => !isSummary(t))
    .map((text) => ({ text, count: counts.get(text)! }))
    .sort((a, b) => b.count - a.count);
  return { lines: [...summaries, ...rest].slice(0, cap), distinct: order.length, emitted: notes.length };
}

export function summarise(places: readonly Place[], manifest: RunManifest): RunSummary {
  const { bySection, byBand } = distribution(places);
  const withSignals = places.filter((p) => p.signals);
  const registered = places.filter((p) => p.registry);
  const dated = registered.filter((p) => p.registry!.asOf);
  const legalIds = places.flatMap((p) => p.legalIds ?? []);
  const scored = places.map((p) => p.score?.total ?? 0);

  return {
    total: places.length,
    websites: {
      corroborated: places.filter((p) => p.website?.confidence === "corroborated").length,
      declared: places.filter((p) => p.website?.confidence === "declared").length,
      unverified: places.filter((p) => p.website?.confidence === "unverified").length,
      none: places.filter((p) => !p.website).length,
    },
    hiring: {
      yes: withSignals.filter((p) => p.signals!.isHiring === true).length,
      no: withSignals.filter((p) => p.signals!.isHiring === false).length,
      unknown: withSignals.filter((p) => p.signals!.isHiring === undefined).length,
      roles: places.reduce((n, p) => n + (p.signals?.isHiring === true ? (p.signals.openRoles ?? 0) : 0), 0),
      matchedRoles: places.reduce((n, p) => n + (p.signals?.matchedRoles ?? 0), 0),
      ats: tally(
        places.flatMap((p) => p.signals?.atsProviders ?? []),
        (a) => a,
      ),
    },
    contact: {
      emails: places.filter((p) => p.contacts.emails.length > 0).length,
      phones: places.filter((p) => p.contacts.phones.length > 0).length,
      both: places.filter((p) => p.contacts.emails.length > 0 && p.contacts.phones.length > 0).length,
      any: places.filter((p) => p.contacts.emails.length > 0 || p.contacts.phones.length > 0).length,
    },
    registry: {
      withRecord: registered.length,
      byConnector: tally(registered, (p) => p.registry!.connectorId),
      byEvidence: tally(places, (p) => (p.registryEvidence ? (EVIDENCE_LABELS[p.registryEvidence.how] ?? p.registryEvidence.how) : undefined)),
      dated: { count: dated.length, years: [...new Set(dated.map((p) => p.registry!.asOf!.slice(0, 4)))].sort() },
      headOffices: registered.filter((p) => p.registry!.isHeadOffice).length,
      ceased: registered.filter((p) => p.registry!.status === "ceased").length,
      withOfficers: registered.filter((p) => p.registry!.officers.length > 0).length,
      officers: registered.reduce((n, p) => n + p.registry!.officers.length, 0),
    },
    legalIds: {
      verified: legalIds.filter((x) => x.status === "verified").length,
      attested: legalIds.filter((x) => x.status === "attested").length,
      unverified: legalIds.filter((x) => x.status === "unverified").length,
      total: legalIds.length,
    },
    site: {
      withCms: withSignals.filter((p) => p.signals!.cms).length,
      withLastContent: withSignals.filter((p) => p.signals!.lastContentAt).length,
      pricing: withSignals.filter((p) => p.signals!.hasPricingPage).length,
      ecommerce: withSignals.filter((p) => p.signals!.hasEcommerce).length,
      enriched: withSignals.length,
      pagesRead: places.reduce((n, p) => n + p.pages.length, 0),
      withPages: places.filter((p) => p.pages.length > 0).length,
      topTech: tally(
        places.flatMap((p) => [...(p.signals?.techStack ?? []), ...(p.signals?.cms ? [p.signals.cms] : [])]),
        (t) => t,
      ).slice(0, 10),
    },
    scores: {
      bands: SCORE_BANDS.map((b) => [b.label, scored.filter((n) => n >= b.min && n <= b.max).length] as [string, number]),
      zero: scored.filter((n) => n === 0).length,
      max: scored.length ? Math.max(...scored) : 0,
    },
    fit: {
      judged: places.filter((p) => p.score?.fit).length,
      byVerdict: tally(places, (p) => p.score?.fit),
    },
    bySection,
    byBand,
    filters: describeFilters(manifest.filters ?? {}),
    brief: briefOf(places),
    notes: foldNotes(manifest.notes ?? []),
  };
}
