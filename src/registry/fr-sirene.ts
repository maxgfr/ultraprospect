// France — `recherche-entreprises.api.gouv.fr` (Sirene / RNE).
//
// No key, no quota form, 7 requests a second, and it carries what OSM never
// will: SIREN/SIRET, the NAF activity code, the employee band, the directors,
// and filed revenue. For a French territory it is the difference between a list
// of shopfronts and a list of companies.
//
// IT IS ALSO THE ONLY CONNECTOR IN THIS TOOL THAT CAN SWEEP. Every other
// register here was measured and cannot enumerate the companies inside an area
// without a key, so the two-lanes-over-one-territory design that this file
// implements is a French privilege, not the shape of the world. That is why
// `sweep` is an optional method on the connector interface rather than the
// interface itself.
//
// TWO UNDOCUMENTED BEHAVIOURS SHAPE THIS WHOLE FILE. Both were measured against
// the live API, not read in a spec:
//
//   1. `total_results` IS CLAMPED AT 10 000. Asking for every legal unit in
//      Vincennes reports exactly 10 000; summing the same query across the 21
//      NACE sections reports 37 717. So the field is a floor, never a count, and
//      any code that treats 10 000 as "the total" silently loses two thirds of
//      a town. Here, `>= HARD_CAP` means "at least this many" and forces a split.
//   2. `/near_point` IGNORES FILTERS IT DOES NOT IMPLEMENT rather than
//      rejecting them. `etat_administratif=A` changes nothing there — the count
//      comes back identical. Anything that endpoint does not support is
//      therefore applied client-side, and never assumed to have taken effect.
//
// Both are asserted by `canary()` below, so the day either changes the weekly
// run opens an `upstream-drift` issue instead of the split ladder quietly doing
// unnecessary — or wrong — work.
//
// The pagination cap is separate and documented: `page * per_page <= 10 000`
// with `per_page <= 25`, so one query can never yield more than 10 000 rows
// however patiently it is walked.
import { awaitHostSlot, httpJson, mapLimit } from "../engine.js";
import { politeUa } from "../net.js";
import { NACE_SECTIONS, naceSection } from "../classification/nace.js";
import { divisionsOfSection } from "../classification/naf-codes.js";
import type { Dirigeant, GeoTarget, LaneCoverage, PostalAddress } from "../types.js";
import { firstText } from "../util.js";
import type {
  Availability,
  CanaryCheck,
  ConnectorContext,
  LegalId,
  LookupQuery,
  RegistryConnector,
  RegistryFilters,
  RegistryRecord,
  SweepResult,
} from "./types.js";

const BASE = "https://recherche-entreprises.api.gouv.fr";
const CONNECTOR_ID = "fr-sirene";

/** Server-side maximum. `page * per_page` may not exceed it, and `total_results` is clamped to it. */
export const HARD_CAP = 10_000;
/** Server-side maximum page size. */
export const PER_PAGE = 25;
/** 7 req/s is allowed; we take 5 and leave the margin to the service. */
const REQUEST_DELAY_MS = 200;
/** Concurrent page fetches. The delay above is what actually paces us. */
const PAGE_CONCURRENCY = 4;

/**
 * INSEE employee bands, smallest first.
 *
 * An ORDERED ARRAY, not an object, and deliberately so. Half these codes ("11",
 * "12", "21"…) are canonical array indices as far as JavaScript is concerned,
 * so an object literal reorders them silently: `Object.values` on the obvious
 * `{ "00": 0, "01": 1, …, "11": 10, … }` returns `[10, 20, 50, …, 0, 1, 3, 6]`.
 * Anything that walked the object expecting size order — the report's
 * distribution table, a band picker in a UI — would be quietly wrong, and would
 * look right in every spot check that happened to hit the numeric codes.
 *
 * These are French codes. A connector that publishes an exact headcount instead
 * fills `RegistryRecord.employees` and leaves the band alone; nothing downstream
 * may assume every record has a band.
 */
export const EFFECTIF_BANDS: ReadonlyArray<{ code: string; floor: number; label: string }> = [
  { code: "NN", floor: -1, label: "non déterminé" },
  { code: "00", floor: 0, label: "0 salarié" },
  { code: "01", floor: 1, label: "1 à 2" },
  { code: "02", floor: 3, label: "3 à 5" },
  { code: "03", floor: 6, label: "6 à 9" },
  { code: "11", floor: 10, label: "10 à 19" },
  { code: "12", floor: 20, label: "20 à 49" },
  { code: "21", floor: 50, label: "50 à 99" },
  { code: "22", floor: 100, label: "100 à 199" },
  { code: "31", floor: 200, label: "200 à 249" },
  { code: "32", floor: 250, label: "250 à 499" },
  { code: "41", floor: 500, label: "500 à 999" },
  { code: "42", floor: 1000, label: "1 000 à 1 999" },
  { code: "51", floor: 2000, label: "2 000 à 4 999" },
  { code: "52", floor: 5000, label: "5 000 à 9 999" },
  { code: "53", floor: 10000, label: "10 000 et plus" },
];

/** Lookup by code. Safe to index; unsafe to iterate — see EFFECTIF_BANDS. */
export const EFFECTIF_LABELS: Record<string, string> = Object.fromEntries(EFFECTIF_BANDS.map((b) => [b.code, b.label]));

/** Lower bound of each band. "NN" is -1: unknown is not "zero employees". */
export const EFFECTIF_FLOOR: Record<string, number> = Object.fromEntries(EFFECTIF_BANDS.map((b) => [b.code, b.floor]));

export interface SireneQuery {
  /** Point search. `radiusKm` is capped at 50 by the API. */
  point?: { lat: number; lon: number; radiusKm: number };
  /** Area search by INSEE commune code(s). Preferred when we have one: exact boundary, no spill. */
  codeCommune?: string[];
  /** Free-text, for the `/search` endpoint. */
  q?: string;
  /** Full NAF codes, e.g. "62.01Z". Prefixes are rejected by the API. */
  activitePrincipale?: string[];
  /** Section letters A-U. */
  sections?: string[];
  /** INSEE employee-band codes. */
  tranchesEffectif?: string[];
  /** "A" (active) or "C" (ceased). Applied client-side on the point endpoint. */
  etatAdministratif?: "A" | "C";
}

export interface SireneOptions {
  /**
   * Stop after this many establishments and say so.
   *
   * A whole commune runs to tens of thousands of legal units, most of them
   * dormant micro-entrepreneurs, and walking all of them costs ~1 500 requests.
   * The budget exists so a broad run degrades into a declared partial rather
   * than into a twenty-minute wait nobody asked for.
   */
  maxResults?: number;
  /** How deep the partition ladder may go: 0 none, 1 sections, 2 sections+divisions. */
  maxSplitDepth?: number;
  onNote?: (note: string) => void;
  onProgress?: (fetched: number, partition: string) => void;
}

export interface SireneResult {
  records: RegistryRecord[];
  coverage: LaneCoverage;
  notes: string[];
}

interface PageOutcome {
  results: any[];
  total: number;
  error?: string;
}

function endpointFor(query: SireneQuery): "search" | "near_point" {
  return query.point && !query.codeCommune?.length && !query.q ? "near_point" : "search";
}

export function buildUrl(query: SireneQuery, page: number, perPage: number): string {
  const endpoint = endpointFor(query);
  const url = new URL(`${BASE}/${endpoint}`);
  if (endpoint === "near_point" && query.point) {
    url.searchParams.set("lat", String(query.point.lat));
    url.searchParams.set("long", String(query.point.lon));
    // The API rejects anything above 50 km. Clamp rather than let it 400.
    url.searchParams.set("radius", String(Math.min(50, query.point.radiusKm)));
  } else {
    if (query.q) url.searchParams.set("q", query.q);
    if (query.codeCommune?.length) url.searchParams.set("code_commune", query.codeCommune.join(","));
    // Only `/search` implements this one; see the header note.
    if (query.etatAdministratif) url.searchParams.set("etat_administratif", query.etatAdministratif);
    if (query.tranchesEffectif?.length) url.searchParams.set("tranche_effectif_salarie", query.tranchesEffectif.join(","));
  }
  if (query.sections?.length) url.searchParams.set("section_activite_principale", query.sections.join(","));
  if (query.activitePrincipale?.length) url.searchParams.set("activite_principale", query.activitePrincipale.join(","));
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(perPage));
  // Establishments are the physical places this tool matches against OSM, so ask
  // for as many of them per legal unit as the API will give.
  url.searchParams.set("limite_matching_etablissements", "100");
  return url.href;
}

async function fetchPage(query: SireneQuery, page: number, perPage = PER_PAGE): Promise<PageOutcome> {
  const url = buildUrl(query, page, perPage);
  await awaitHostSlot(url, REQUEST_DELAY_MS);
  const res = await httpJson("GET", url, undefined, { timeoutMs: 30_000, retries: 2, userAgent: politeUa() });
  if (!res.ok) {
    const message = firstText(res.data?.erreur, res.data?.detail, res.error) ?? `HTTP ${res.status}`;
    return { results: [], total: 0, error: message };
  }
  return { results: res.data?.results ?? [], total: res.data?.total_results ?? 0 };
}

/** "54 QUAI CHARLES PASQUA 92300 LEVALLOIS-PERRET" -> its parts. */
export function parseRawAddress(raw: string | undefined | null): PostalAddress {
  const address: PostalAddress = { raw: raw ?? undefined };
  if (!raw) return address;
  const m = /^(?:(\d+[A-Z]?)\s+)?(.*?)\s+(\d{5})\s+(.+)$/.exec(raw.trim());
  if (!m) return address;
  address.numero = m[1];
  address.codePostal = m[3];
  address.commune = m[4];
  const street = (m[2] ?? "").trim();
  // The first token is the street TYPE only when it is one — "QUAI CHARLES
  // PASQUA" splits, "CHARLES DE GAULLE" must not lose its first name.
  const typeMatch =
    /^(RUE|AVENUE|AV|BOULEVARD|BD|QUAI|PLACE|PL|IMPASSE|ALLEE|ALLÉE|CHEMIN|ROUTE|RTE|COURS|SQUARE|PASSAGE|VILLA|SENTIER|ESPLANADE|PARVIS|ROND[- ]POINT|ZONE|ZA|ZI|ZAC|LIEU[- ]DIT|CITE|CITÉ|FAUBOURG|GALERIE|MAIL|PROMENADE|TRAVERSE|VOIE)\s+(.+)$/i.exec(
      street,
    );
  if (typeMatch) {
    address.typeVoie = typeMatch[1]?.toUpperCase();
    address.libelleVoie = typeMatch[2];
  } else {
    address.libelleVoie = street || undefined;
  }
  return address;
}

function mapDirigeants(raw: any[]): Dirigeant[] {
  return (raw ?? []).map((d) => ({
    nom: d?.nom ?? undefined,
    prenoms: d?.prenoms ?? undefined,
    qualite: d?.qualite ?? undefined,
    dateNaissance: d?.date_de_naissance ?? d?.annee_de_naissance ?? undefined,
    denomination: d?.denomination ?? undefined,
    siren: d?.siren ?? undefined,
  }));
}

/** Latest filed year in the `finances` map, which is keyed by year. */
function latestFinances(raw: any): RegistryRecord["finances"] {
  if (!raw || typeof raw !== "object") return undefined;
  const years = Object.keys(raw).filter((y) => /^\d{4}$/.test(y));
  if (years.length === 0) return undefined;
  const year = years.sort().at(-1)!;
  const entry = raw[year] ?? {};
  return { year, revenue: entry.ca ?? undefined, netIncome: entry.resultat_net ?? undefined, currency: "EUR" };
}

/**
 * The register's own words for a state, normalised.
 *
 * TWO VOCABULARIES, measured: a LEGAL UNIT is "A" (active) or "C" (cessée), an
 * ESTABLISHMENT is "A" or "F" (fermé). Mapping only A and C reported every
 * closed establishment as "unknown" — PEUGEOT SA's registered office comes back
 * "F" — which reads as "we did not look" rather than as "it is shut".
 */
function statusOf(raw: string | undefined): RegistryRecord["status"] {
  if (raw === "A") return "active";
  if (raw === "C" || raw === "F") return "ceased";
  return "unknown";
}

/**
 * One legal unit becomes one record per establishment near the target.
 *
 * The register's unit is the company; this tool's unit is the place. A chain
 * with four branches on the same high street is four prospects with four
 * addresses, and collapsing it to the head office would put the whole thing at
 * a registered address in another département.
 */
export function expandRecord(entity: any): RegistryRecord[] {
  const siren = String(entity?.siren ?? "");
  const base = {
    connectorId: CONNECTOR_ID,
    id: siren,
    countryCode: "fr",
    activityScheme: "nace" as const,
    legalForm: entity?.nature_juridique ?? undefined,
    establishmentCount: entity?.nombre_etablissements ?? undefined,
    dateCreated: entity?.date_creation ?? undefined,
    officers: mapDirigeants(entity?.dirigeants),
    finances: latestFinances(entity?.finances),
    // The legal unit's own activity and size. Every filter the API applies
    // matches on THESE, so a row has to be able to explain why it came back.
    parent: {
      activityCode: entity?.activite_principale ?? undefined,
      section: entity?.section_activite_principale ?? undefined,
      sizeBand: entity?.tranche_effectif_salarie ?? undefined,
      sizeBandYear: entity?.annee_tranche_effectif_salarie ?? undefined,
    },
    national: {
      nomComplet: entity?.nom_complet ?? undefined,
      nomRaisonSociale: entity?.nom_raison_sociale ?? undefined,
      sigle: entity?.sigle ?? undefined,
      categorieEntreprise: entity?.categorie_entreprise ?? undefined,
    } as Record<string, unknown>,
  };

  const establishments: any[] = entity?.matching_etablissements?.length ? entity.matching_etablissements : entity?.siege ? [entity.siege] : [];

  return establishments
    .filter((e) => e)
    .map((e) => {
      const siege = entity?.siege;
      // The siege object carries a parsed address; matching_etablissements only
      // carries the raw string. Prefer the parsed one when this IS the siege.
      const address: PostalAddress =
        siege && e.siret === siege.siret
          ? {
              raw: siege.adresse ?? undefined,
              numero: siege.numero_voie ?? undefined,
              typeVoie: siege.type_voie ?? undefined,
              libelleVoie: siege.libelle_voie ?? undefined,
              codePostal: siege.code_postal ?? undefined,
              codeCommune: siege.commune ?? undefined,
              commune: siege.libelle_commune ?? undefined,
              pays: siege.libelle_pays_etranger ?? "France",
            }
          : { ...parseRawAddress(e.adresse), codeCommune: e.commune ?? undefined, commune: e.libelle_commune ?? undefined, pays: "France" };

      const lat = Number.parseFloat(e.latitude);
      const lon = Number.parseFloat(e.longitude);
      const activityCode = e.activite_principale ?? entity?.activite_principale ?? undefined;
      // Trading names first: the sign over the door is what a prospector reads
      // and what OSM will have mapped. The legal name follows for matching.
      const tradingNames = ((e.liste_enseignes ?? []) as unknown[]).filter((n): n is string => Boolean(typeof n === "string" && n.trim()));
      const legalName = firstText(entity?.nom_complet, entity?.nom_raison_sociale);
      const names = [...tradingNames, entity?.nom_complet, entity?.nom_raison_sociale, entity?.sigle].filter((n): n is string => Boolean(n?.trim()));

      return {
        ...base,
        establishmentId: e.siret ?? undefined,
        names,
        legalName,
        tradingNames,
        activityCode,
        // Derived from THIS establishment's code, never inherited from the
        // legal unit's: pairing an establishment's 68.20B with the company's
        // section J produces a line that is impossible on its face and reads as
        // a bug rather than as two true things about two levels.
        section: naceSection(activityCode ?? "") ?? undefined,
        sizeBand: e.tranche_effectif_salarie ?? entity?.tranche_effectif_salarie ?? undefined,
        sizeBandYear: e.annee_tranche_effectif_salarie ?? undefined,
        dateClosed: e.date_fermeture ?? undefined,
        status: statusOf(e.etat_administratif ?? entity?.etat_administratif),
        isHeadOffice: Boolean(e.est_siege),
        address,
        lat: Number.isFinite(lat) ? lat : undefined,
        lon: Number.isFinite(lon) ? lon : undefined,
        sourceUrl: e.siret
          ? `https://annuaire-entreprises.data.gouv.fr/etablissement/${e.siret}`
          : `https://annuaire-entreprises.data.gouv.fr/entreprise/${siren}`,
      } satisfies RegistryRecord;
    });
}

/**
 * Filters the API cannot apply for us, re-applied here.
 *
 * TWO distinct reasons, and only one of them is about the endpoint:
 *
 *   1. `/near_point` silently drops filters it does not implement, so anything
 *      that endpoint ignores has to be re-applied client-side.
 *
 *   2. `etat_administratif` filters the LEGAL UNIT on either endpoint — never
 *      the establishment. An active company keeps its closed branches, and they
 *      come back inside `matching_etablissements` with their own
 *      `etat_administratif: "C"`. Left alone, a restaurant that shut in 2019
 *      appears in the run as an open one at a real address: the register is not
 *      wrong, the question was. So the establishment's OWN state is filtered
 *      here regardless of which endpoint answered.
 */
function applyClientFilters(records: RegistryRecord[], query: SireneQuery, endpoint: string): RegistryRecord[] {
  let out = records;
  if (query.etatAdministratif) {
    const wanted = statusOf(query.etatAdministratif);
    out = out.filter((r) => r.status === wanted);
  }
  if (endpoint === "near_point" && query.tranchesEffectif?.length) {
    const wanted = new Set(query.tranchesEffectif);
    out = out.filter((r) => r.sizeBand && wanted.has(r.sizeBand));
  }
  return out;
}

/** Walk one partition to exhaustion (or to the pagination cap). */
async function drain(
  query: SireneQuery,
  budget: { left: number },
  label: string,
  opts: SireneOptions,
): Promise<{ records: RegistryRecord[]; total: number; error?: string }> {
  const first = await fetchPage(query, 1);
  if (first.error) return { records: [], total: 0, error: first.error };

  const endpoint = endpointFor(query);
  const collected: RegistryRecord[] = [];
  const push = (entities: any[]) => {
    for (const e of entities) {
      for (const rec of applyClientFilters(expandRecord(e), query, endpoint)) {
        if (budget.left <= 0) return;
        collected.push(rec);
        budget.left--;
      }
    }
  };
  push(first.results);

  // The cap applies to page * per_page, not to total_results — walking past it
  // returns an empty page at best and a 400 at worst.
  const reachablePages = Math.floor(HARD_CAP / PER_PAGE);
  const lastPage = Math.min(reachablePages, Math.ceil(Math.min(first.total, HARD_CAP) / PER_PAGE));
  const pages: number[] = [];
  for (let p = 2; p <= lastPage; p++) pages.push(p);

  let stopped = false;
  await mapLimit(pages, PAGE_CONCURRENCY, async (page) => {
    if (stopped || budget.left <= 0) return;
    const outcome = await fetchPage(query, page);
    if (outcome.error) {
      stopped = true;
      return;
    }
    push(outcome.results);
    opts.onProgress?.(collected.length, label);
    if (budget.left <= 0) stopped = true;
  });

  return { records: collected, total: first.total };
}

/**
 * Fetch every establishment matching the query, splitting to get under the cap.
 *
 * The ladder is: whole query -> per NACE section -> per NAF division inside the
 * section. Each rung multiplies the reachable ceiling by the number of parts,
 * and section alone is usually enough (the largest section in a French commune
 * runs to a few thousand). A leaf that still reports `>= HARD_CAP` is recorded
 * as truncated with the reason, and the report says so at the top — a partial
 * list presented as a whole territory is the one failure this lane must not
 * have.
 */
export async function fetchSirene(query: SireneQuery, opts: SireneOptions = {}): Promise<SireneResult> {
  const maxResults = opts.maxResults ?? 3000;
  const maxDepth = opts.maxSplitDepth ?? 2;
  const budget = { left: maxResults };
  const notes: string[] = [];
  const bySiret = new Map<string, RegistryRecord>();
  let partitions = 0;
  let truncated = false;
  let truncReason: string | undefined;

  const absorb = (records: RegistryRecord[]) => {
    for (const r of records) {
      // Establishments are unique by SIRET; a legal unit with no SIRET (rare,
      // and only in the siege fallback) is keyed by SIREN so it is not dropped.
      const key = r.establishmentId ?? `siren:${r.id}`;
      if (!bySiret.has(key)) bySiret.set(key, r);
    }
  };

  async function walk(part: SireneQuery, label: string, depth: number): Promise<void> {
    if (budget.left <= 0) return;
    const probe = await fetchPage(part, 1, 1);
    if (probe.error) {
      notes.push(`sirene: ${label} failed — ${probe.error}`);
      opts.onNote?.(`sirene: ${label} failed (${probe.error})`);
      truncated = true;
      truncReason ??= probe.error;
      return;
    }

    if (probe.total >= HARD_CAP && depth < maxDepth) {
      if (depth === 0) {
        opts.onNote?.(`sirene: ${label} reports >= ${HARD_CAP} (the API clamps the count) — splitting by NACE section`);
        notes.push(`sirene: ${label} is at or above the ${HARD_CAP} cap; split into ${NACE_SECTIONS.length} NACE sections`);
        for (const section of part.sections?.length ? part.sections : NACE_SECTIONS) {
          await walk({ ...part, sections: [section] }, `${label} / section ${section}`, depth + 1);
        }
        return;
      }
      const section = part.sections?.[0];
      if (section) {
        const divisions = divisionsOfSection(section);
        opts.onNote?.(`sirene: ${label} still at the cap — splitting into ${divisions.length} NAF divisions`);
        notes.push(`sirene: ${label} is at or above the ${HARD_CAP} cap; split into ${divisions.length} NAF divisions`);
        for (const codes of divisions) {
          await walk({ ...part, activitePrincipale: codes }, `${label} / division ${codes[0]?.slice(0, 2)}`, depth + 1);
        }
        return;
      }
    }

    if (probe.total >= HARD_CAP) {
      truncated = true;
      truncReason ??= `a partition (${label}) still reports at least ${HARD_CAP} results after the split ladder ran out`;
      notes.push(`sirene: TRUNCATED at ${label} — at least ${HARD_CAP} results and no split left`);
      opts.onNote?.(`sirene: TRUNCATED — ${label} has at least ${HARD_CAP} results`);
    }

    partitions++;
    const { records, error } = await drain(part, budget, label, opts);
    if (error) {
      notes.push(`sirene: ${label} stopped early — ${error}`);
      truncated = true;
      truncReason ??= error;
    }
    absorb(records);
  }

  await walk(query, "query", 0);

  if (budget.left <= 0) {
    truncated = true;
    truncReason ??= `the --max-results budget of ${maxResults} was reached`;
    notes.push(`sirene: stopped at the --max-results budget of ${maxResults}; raise it or narrow the filters`);
    opts.onNote?.(`sirene: hit the --max-results budget of ${maxResults} — the lane is INCOMPLETE`);
  }

  const records = [...bySiret.values()];
  return {
    records,
    notes,
    coverage: {
      lane: "registry",
      mode: "sweep",
      connectorId: CONNECTOR_ID,
      requested: maxResults,
      returned: records.length,
      truncated,
      reason: truncReason,
      partitions: Math.max(1, partitions),
    },
  };
}

/** `--min-employees 10` expressed as every INSEE band that satisfies it. */
export function bandsAtLeast(minHeadcount: number): string[] {
  // "NN" (undetermined) is excluded: a company whose headcount the register does
  // not know is not evidence of a company with at least ten people. Including it
  // would silently reinstate most of the micro-entrepreneurs the filter exists
  // to remove.
  return EFFECTIF_BANDS.filter((b) => b.floor >= 0 && b.floor >= minHeadcount).map((b) => b.code);
}

async function get(url: string): Promise<{ ok: boolean; data: any; status: number }> {
  await awaitHostSlot(url, REQUEST_DELAY_MS);
  const res = await httpJson("GET", url, undefined, { timeoutMs: 30_000, retries: 1, userAgent: politeUa() });
  return { ok: res.ok, data: res.data, status: res.status };
}

export const frSirene: RegistryConnector = {
  id: CONNECTOR_ID,
  countries: ["fr"],
  label: "France — Sirene / RNE via recherche-entreprises.api.gouv.fr",
  licence: "French company data: base Sirene / RNE via recherche-entreprises.api.gouv.fr, Licence Ouverte 2.0",
  activityScheme: "nace",
  activityPrefix: "naf",
  docsUrl: "https://recherche-entreprises.api.gouv.fr/docs/",
  sizeBands: EFFECTIF_BANDS,

  availability(): Availability {
    return { available: true };
  },

  async sweep(target: GeoTarget, filters: RegistryFilters, ctx: ConnectorContext): Promise<SweepResult> {
    return fetchSirene(
      {
        // A commune code searches the real boundary; a radius is the fallback
        // when the geocoder gave us a point rather than an administrative area.
        codeCommune: target.codeCommune && !target.radiusM ? [target.codeCommune] : undefined,
        point: target.radiusM || !target.codeCommune ? { lat: target.lat, lon: target.lon, radiusKm: (target.radiusM ?? 1000) / 1000 } : undefined,
        sections: filters.sections,
        activitePrincipale: filters.activityCodes,
        tranchesEffectif: filters.sizeBands,
        etatAdministratif: filters.includeCeased ? undefined : "A",
      },
      { maxResults: filters.maxResults, onNote: ctx.onNote, onProgress: ctx.onProgress },
    );
  },

  async lookup(query: LookupQuery): Promise<RegistryRecord[]> {
    const name = query.names.find((n) => n?.trim());
    if (!name) return [];
    // Locality goes in the free-text query rather than in a filter: the API's
    // `q` already weights the address, and `code_commune` would need an INSEE
    // code we do not have when the caller only knows a town's name.
    const q = query.locality ? `${name} ${query.locality}` : name;
    const page = await fetchPage({ q, etatAdministratif: "A" }, 1, Math.min(25, query.limit ?? 5));
    if (page.error) return [];
    return page.results.flatMap((e: any) => expandRecord(e)).slice(0, query.limit ?? 5);
  },

  async verifyId(id: LegalId): Promise<RegistryRecord | undefined> {
    // SIREN identifies the legal unit, SIRET one of its establishments, and a
    // French VAT number embeds the SIREN in its last nine digits.
    const digits = id.value.replace(/\D+/g, "");
    let siren: string | undefined;
    if (id.kind === "siren" && digits.length === 9) siren = digits;
    else if (id.kind === "siret" && digits.length === 14) siren = digits.slice(0, 9);
    else if (id.kind === "vat" && digits.length === 11) siren = digits.slice(2);
    if (!siren) return undefined;

    const page = await fetchPage({ q: siren }, 1, 5);
    if (page.error) return undefined;
    const entity = page.results.find((e: any) => String(e?.siren) === siren);
    if (!entity) return undefined;
    const records = expandRecord(entity);
    if (id.kind === "siret") {
      const exact = records.find((r) => r.establishmentId === digits);
      if (exact) return exact;
    }
    return records.find((r) => r.isHeadOffice) ?? records[0];
  },

  async canary(): Promise<CanaryCheck[]> {
    const checks: CanaryCheck[] = [];

    const search = await get(`${BASE}/search?q=doctolib&per_page=1`);
    const first = search.data?.results?.[0];
    checks.push({ name: "register still returns results[].siege", ok: Boolean(first?.siege) });
    checks.push({ name: "register still returns matching_etablissements", ok: Array.isArray(first?.matching_etablissements) });
    checks.push({
      name: "register still keys finances by year",
      ok: Object.keys(first?.finances ?? {}).every((k) => /^\d{4}$/.test(k)),
    });

    // The two undocumented behaviours this connector is built around. If either
    // ever changes, the split ladder is doing unnecessary work — or worse, the
    // wrong work — and this is the only thing that would say so.
    const capped = await get(`${BASE}/search?code_commune=94080&per_page=1`);
    checks.push({
      name: "register still CLAMPS total_results at 10 000",
      ok: capped.data?.total_results === HARD_CAP,
      detail: "if this changed, the NAF split ladder can trust the count again",
    });

    const withFilter = await get(`${BASE}/near_point?lat=48.8566&long=2.3522&radius=0.3&etat_administratif=A&per_page=1`);
    const without = await get(`${BASE}/near_point?lat=48.8566&long=2.3522&radius=0.3&per_page=1`);
    checks.push({
      name: "/near_point still IGNORES etat_administratif",
      ok: withFilter.data?.total_results === without.data?.total_results,
      detail: "if it now honours it, the client-side filter is redundant",
    });

    // The activity catalogue is harvested from this endpoint's own rejection
    // message, so a change in its shape silently freezes the split ladder.
    const rejected = await get(`${BASE}/search?activite_principale=__invalid__&per_page=1`);
    const listed = [...String(rejected.data?.erreur ?? "").matchAll(/'(\d{2}\.\d{2}[A-Z])'/g)].length;
    checks.push({
      name: "register still lists the whole NAF catalogue in its rejection message",
      ok: listed >= 600,
      detail: `${listed} codes parsed out of the error; scripts/refresh-naf.mjs reads this`,
    });

    return checks;
  },

  async probe(): Promise<{ ok: boolean; detail: string }> {
    const res = await get(`${BASE}/search?q=test&per_page=1`);
    return {
      ok: res.ok && typeof res.data?.total_results === "number",
      detail: res.ok ? `HTTP ${res.status}, total_results present` : `HTTP ${res.status}`,
    };
  },
};
