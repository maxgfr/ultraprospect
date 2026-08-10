// The French register lane, over `recherche-entreprises.api.gouv.fr`.
//
// No key, no quota form, 7 requests a second, and it carries what OSM never
// will: SIREN/SIRET, the NAF activity code, the employee band, the directors,
// and filed revenue. For a French territory it is the difference between a list
// of shopfronts and a list of companies.
//
// TWO UNDOCUMENTED BEHAVIOURS SHAPE THIS WHOLE FILE. Both were measured against
// the live API, not read in a spec:
//
//   1. `total_results` IS CLAMPED AT 10 000. Asking for every legal unit in
//      Vincennes reports exactly 10 000; summing the same query across the 21
//      NAF sections reports 37 717. So the field is a floor, never a count, and
//      any code that treats 10 000 as "the total" silently loses two thirds of
//      a town. Here, `>= HARD_CAP` means "at least this many" and forces a split.
//   2. `/near_point` IGNORES FILTERS IT DOES NOT IMPLEMENT rather than
//      rejecting them. `etat_administratif=A` changes nothing there — the count
//      comes back identical. Anything that endpoint does not support is
//      therefore applied client-side, and never assumed to have taken effect.
//
// The pagination cap is separate and documented: `page * per_page <= 10 000`
// with `per_page <= 25`, so one query can never yield more than 10 000 rows
// however patiently it is walked.
import { awaitHostSlot, httpJson, mapLimit } from "./engine.js";
import { politeUa } from "./net.js";
import { NAF_SECTIONS, divisionsOfSection } from "./naf.js";
import type { Dirigeant, LaneCoverage, PostalAddress, SireneRecord } from "./types.js";
import { firstText } from "./util.js";

const BASE = "https://recherche-entreprises.api.gouv.fr";

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
  records: SireneRecord[];
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
function latestFinances(raw: any): SireneRecord["finances"] {
  if (!raw || typeof raw !== "object") return undefined;
  const years = Object.keys(raw).filter((y) => /^\d{4}$/.test(y));
  if (years.length === 0) return undefined;
  const year = years.sort().at(-1)!;
  const entry = raw[year] ?? {};
  return { annee: year, ca: entry.ca ?? undefined, resultatNet: entry.resultat_net ?? undefined };
}

/**
 * One legal unit becomes one record per establishment near the target.
 *
 * The register's unit is the company; this tool's unit is the place. A chain
 * with four branches on the same high street is four prospects with four
 * addresses, and collapsing it to the head office would put the whole thing at
 * a registered address in another département.
 */
export function expandRecord(entity: any): SireneRecord[] {
  const base = {
    siren: String(entity?.siren ?? ""),
    nomComplet: entity?.nom_complet ?? undefined,
    nomRaisonSociale: entity?.nom_raison_sociale ?? undefined,
    sigle: entity?.sigle ?? undefined,
    section: entity?.section_activite_principale ?? undefined,
    categorieEntreprise: entity?.categorie_entreprise ?? undefined,
    natureJuridique: entity?.nature_juridique ?? undefined,
    dateCreation: entity?.date_creation ?? undefined,
    nombreEtablissements: entity?.nombre_etablissements ?? undefined,
    dirigeants: mapDirigeants(entity?.dirigeants),
    finances: latestFinances(entity?.finances),
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
      return {
        ...base,
        siret: e.siret ?? undefined,
        enseignes: (e.liste_enseignes ?? []).filter(Boolean),
        nafCode: e.activite_principale ?? entity?.activite_principale ?? undefined,
        effectifTranche: e.tranche_effectif_salarie ?? entity?.tranche_effectif_salarie ?? undefined,
        effectifAnnee: e.annee_tranche_effectif_salarie ?? undefined,
        dateFermeture: e.date_fermeture ?? undefined,
        etatAdministratif: e.etat_administratif ?? entity?.etat_administratif ?? undefined,
        estSiege: Boolean(e.est_siege),
        address,
        lat: Number.isFinite(lat) ? lat : undefined,
        lon: Number.isFinite(lon) ? lon : undefined,
      } satisfies SireneRecord;
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
function applyClientFilters(records: SireneRecord[], query: SireneQuery, endpoint: string): SireneRecord[] {
  let out = records;
  if (query.etatAdministratif) out = out.filter((r) => r.etatAdministratif === query.etatAdministratif);
  if (endpoint === "near_point" && query.tranchesEffectif?.length) {
    const wanted = new Set(query.tranchesEffectif);
    out = out.filter((r) => r.effectifTranche && wanted.has(r.effectifTranche));
  }
  return out;
}

/** Walk one partition to exhaustion (or to the pagination cap). */
async function drain(
  query: SireneQuery,
  budget: { left: number },
  label: string,
  opts: SireneOptions,
): Promise<{ records: SireneRecord[]; total: number; error?: string }> {
  const first = await fetchPage(query, 1);
  if (first.error) return { records: [], total: 0, error: first.error };

  const endpoint = endpointFor(query);
  const collected: SireneRecord[] = [];
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
 * The ladder is: whole query -> per NAF section -> per NAF division inside the
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
  const bySiret = new Map<string, SireneRecord>();
  let partitions = 0;
  let truncated = false;
  let truncReason: string | undefined;

  const absorb = (records: SireneRecord[]) => {
    for (const r of records) {
      // Establishments are unique by SIRET; a legal unit with no SIRET (rare,
      // and only in the siege fallback) is keyed by SIREN so it is not dropped.
      const key = r.siret ?? `siren:${r.siren}`;
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
        opts.onNote?.(`sirene: ${label} reports >= ${HARD_CAP} (the API clamps the count) — splitting by NAF section`);
        notes.push(`sirene: ${label} is at or above the ${HARD_CAP} cap; split into ${NAF_SECTIONS.length} NAF sections`);
        for (const section of part.sections?.length ? part.sections : NAF_SECTIONS) {
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
      lane: "sirene",
      requested: maxResults,
      returned: records.length,
      truncated,
      reason: truncReason,
      partitions: Math.max(1, partitions),
    },
  };
}
