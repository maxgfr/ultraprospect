// `scan` — turn a resolved place into a list of companies.
//
// Runs the lanes, fuses them, and writes the run. The interesting decisions are
// all about honesty rather than about retrieval:
//
//   * Each lane reports its own coverage, and a truncation anywhere sets
//     `manifest.truncated`. Every renderer leads with that flag. A prospect file
//     that quietly covers 40% of a town is worse than no file, because nobody
//     downstream can tell.
//   * The register lane only runs where the register applies. Outside France it
//     is not "unavailable", it is not applicable, and the manifest says which.
//   * Fusion never invents. A pair the matcher is unsure about produces two
//     entities plus a to-do, not one entity and a shrug.
import { poiCategory, poiWebsite } from "./overpass.js";
import { fetchOsmPois } from "./overpass.js";
import { buildMatchTodo, matchLanes } from "./match.js";
import { EFFECTIF_BANDS, fetchSirene } from "./sirene.js";
import type { GeoTarget, LaneCoverage, MatchCandidate, OsmPoi, Place, RunManifest, SireneRecord } from "./types.js";
import { emptyManifest, writeJson, writePlaces, writeRunManifest } from "./run.js";
import { loadFixture } from "./fixture.js";
import { firstText } from "./util.js";

export interface ScanFilters {
  /** OSM catalogue groups to keep. Empty means every group. */
  osmGroups?: string[];
  /** Full NAF codes. */
  naf?: string[];
  /** NAF section letters. */
  sections?: string[];
  /** INSEE employee-band codes to keep. */
  effectif?: string[];
  /** Minimum headcount; expanded into the band list that satisfies it. */
  minEffectif?: number;
  /** Include companies the register marks as ceased. Off by default. */
  includeCeased?: boolean;
  /** Skip the OSM lane. */
  noOsm?: boolean;
  /** Skip the register lane. */
  noSirene?: boolean;
  /** Cap on register rows before the lane declares itself partial. */
  maxResults?: number;
  /** Pin the Overpass endpoint instead of rotating the built-in mirrors. */
  overpass?: string;
  /** Replay a recorded sweep instead of calling the live lanes. */
  fixture?: string;
  /** Keep no named individuals in the run at all. */
  noPeople?: boolean;
}

export interface ScanOptions extends ScanFilters {
  onNote?: (note: string) => void;
}

export interface ScanOutcome {
  places: Place[];
  manifest: RunManifest;
  osm: OsmPoi[];
  sirene: SireneRecord[];
  /** Pairs the matcher scored into the middle band and refused to decide. */
  undecided: MatchCandidate[];
  notes: string[];
}

/**
 * Expand `--min-effectif 10` into every INSEE band that satisfies it.
 *
 * "NN" (undetermined) is excluded: a company whose headcount the register does
 * not know is not evidence of a company with at least ten people. Including it
 * would silently reinstate most of the micro-entrepreneurs the filter exists to
 * remove.
 */
export function bandsAtLeast(minHeadcount: number): string[] {
  return EFFECTIF_BANDS.filter((b) => b.floor >= 0 && b.floor >= minHeadcount).map((b) => b.code);
}

function placeFromPoi(poi: OsmPoi): Place {
  const website = poiWebsite(poi);
  return {
    id: `osm:${poi.id}`,
    name: poi.name ?? poiCategory(poi) ?? poi.id,
    sources: ["osm"],
    osm: poi,
    address: {
      numero: poi.tags["addr:housenumber"],
      libelleVoie: poi.tags["addr:street"],
      codePostal: poi.tags["addr:postcode"],
      commune: poi.tags["addr:city"],
    },
    lat: poi.lat,
    lon: poi.lon,
    category: poiCategory(poi),
    // A website tagged in OSM is DECLARED by a mapper, not corroborated by us.
    // `resolve` upgrades it to "corroborated" only after fetching the page and
    // finding the company on it.
    website: website ? { url: website, confidence: "declared", evidence: ["osm"] } : undefined,
    contacts: { emails: [], phones: [], socials: [], people: [] },
    jobs: [],
    pages: [],
  };
}

function placeFromRecord(rec: SireneRecord): Place {
  return {
    id: `sirene:${rec.siret ?? rec.siren}`,
    name: firstText(rec.enseignes[0], rec.nomComplet, rec.nomRaisonSociale, rec.sigle) ?? rec.siren,
    sources: ["sirene"],
    sirene: rec,
    address: rec.address,
    lat: rec.lat,
    lon: rec.lon,
    category: rec.nafCode ? `naf=${rec.nafCode}` : undefined,
    contacts: { emails: [], phones: [], socials: [], people: [] },
    jobs: [],
    pages: [],
  };
}

function mergeInto(poiPlace: Place, rec: SireneRecord, confidence: number, by: string): void {
  poiPlace.sirene = rec;
  poiPlace.sources = [...new Set([...poiPlace.sources, "sirene" as const])];
  poiPlace.matchConfidence = Number(confidence.toFixed(3));
  poiPlace.matchedBy = by;
  // OSM's address is what is written on the street; the register's is what was
  // filed. Prefer the filed one for the parts OSM leaves blank, keep OSM's where
  // both exist — a mapper standing in front of the door is rarely wrong about
  // the house number.
  poiPlace.address = {
    ...rec.address,
    ...Object.fromEntries(Object.entries(poiPlace.address).filter(([, v]) => v !== undefined && v !== "")),
  };
}

export async function runScan(target: GeoTarget, opts: ScanOptions = {}): Promise<ScanOutcome> {
  const notes: string[] = [];
  const note = (n: string) => {
    notes.push(n);
    opts.onNote?.(n);
  };
  const lanes: LaneCoverage[] = [];
  const timings: Record<string, number> = {};

  const effectifBands = opts.effectif?.length ? opts.effectif : opts.minEffectif ? bandsAtLeast(opts.minEffectif) : undefined;

  // ---- Replay ---------------------------------------------------------------
  // A recorded sweep short-circuits both lanes. Everything after this point —
  // fusion, coverage accounting, the manifest — runs exactly as it does live.
  const replay = opts.fixture ? loadFixture(opts.fixture) : undefined;
  if (replay) {
    note(`fixture: replaying a recorded sweep from ${opts.fixture}`);
    lanes.push({ lane: "osm", requested: 0, returned: replay.osm.length, truncated: false, reason: "replayed from a fixture", partitions: 1 });
    lanes.push({ lane: "sirene", requested: 0, returned: replay.sirene.length, truncated: false, reason: "replayed from a fixture", partitions: 1 });
  }

  // ---- OSM lane -----------------------------------------------------------
  let pois: OsmPoi[] = replay?.osm ?? [];
  if (!replay && !opts.noOsm) {
    const t0 = Date.now();
    const osm = await fetchOsmPois(target, { groups: opts.osmGroups, mirrors: opts.overpass ? [opts.overpass] : undefined, onNote: note });
    timings.osm = Date.now() - t0;
    pois = osm.pois;
    for (const n of osm.notes) notes.push(n);
    lanes.push({
      lane: "osm",
      requested: 0,
      returned: pois.length,
      truncated: osm.incomplete,
      reason: osm.incomplete ? "at least one Overpass tile could not be fetched after the split budget ran out" : undefined,
      partitions: osm.partitions,
    });
    if (osm.mirrorsUsed.length) notes.push(`overpass: answered by ${osm.mirrorsUsed.join(", ")}`);
  } else if (!replay) {
    lanes.push({ lane: "osm", requested: 0, returned: 0, truncated: false, reason: "skipped (--no-osm)" });
  }

  // ---- Register lane ------------------------------------------------------
  let records: SireneRecord[] = replay?.sirene ?? [];
  const registerApplies = target.countryCode === "fr";
  if (!replay && !opts.noSirene && registerApplies) {
    const t0 = Date.now();
    const result = await fetchSirene(
      {
        // A commune code searches the real boundary; a radius is the fallback
        // when the geocoder gave us a point rather than an administrative area.
        codeCommune: target.codeCommune && !target.radiusM ? [target.codeCommune] : undefined,
        point: target.radiusM || !target.codeCommune ? { lat: target.lat, lon: target.lon, radiusKm: (target.radiusM ?? 1000) / 1000 } : undefined,
        sections: opts.sections,
        activitePrincipale: opts.naf,
        tranchesEffectif: effectifBands,
        etatAdministratif: opts.includeCeased ? undefined : "A",
      },
      { maxResults: opts.maxResults, onNote: note },
    );
    timings.sirene = Date.now() - t0;
    records = result.records;
    for (const n of result.notes) notes.push(n);
    lanes.push(result.coverage);
  } else if (!replay) {
    lanes.push({
      lane: "sirene",
      requested: 0,
      returned: 0,
      truncated: false,
      // Not applicable is not the same as failed, and the manifest must not blur
      // them: one is a property of the territory, the other of the run.
      reason: opts.noSirene ? "skipped (--no-sirene)" : `not applicable outside France (country=${target.countryCode ?? "unknown"})`,
    });
  }

  // ---- Fusion -------------------------------------------------------------
  const t0 = Date.now();
  const { merged, undecided } = matchLanes(pois, records);
  timings.match = Date.now() - t0;

  const places: Place[] = [];
  const poiPlaces = new Map<string, Place>();
  for (const poi of pois) {
    const p = placeFromPoi(poi);
    poiPlaces.set(poi.id, p);
    places.push(p);
  }
  const claimed = new Set<string>();
  for (const rec of records) {
    const key = rec.siret ?? `siren:${rec.siren}`;
    const decision = merged.get(key);
    const host = decision ? poiPlaces.get(decision.osmId) : undefined;
    if (host && decision) {
      mergeInto(host, rec, decision.score, decision.by);
      claimed.add(key);
    } else {
      places.push(placeFromRecord(rec));
    }
  }

  // ---- Personal data --------------------------------------------------------
  // Stripping happens HERE, before anything is written, rather than at render
  // time. A run that never held the names cannot leak them through a stray
  // artifact, a cached page or someone reading places.json directly — and
  // `--no-people` is chosen precisely by people who do not want to have to
  // reason about which of five outputs remembered to filter.
  if (opts.noPeople) {
    let stripped = 0;
    for (const p of places) {
      if (p.sirene?.dirigeants.length) {
        stripped += p.sirene.dirigeants.length;
        p.sirene = { ...p.sirene, dirigeants: [] };
      }
      p.contacts.people = [];
    }
    note(`--no-people: removed ${stripped} named individual(s); the run holds organisation data only`);
  }

  const manifest = emptyManifest(target.label || target.query);
  manifest.target = target;
  manifest.filters = {
    osmGroups: opts.osmGroups ?? "all",
    naf: opts.naf ?? null,
    sections: opts.sections ?? null,
    effectif: effectifBands ?? null,
    includeCeased: Boolean(opts.includeCeased),
    maxResults: opts.maxResults ?? null,
  };
  manifest.lanes = lanes;
  manifest.timings = timings;
  manifest.counts = {
    ...manifest.counts,
    osm: pois.length,
    sirene: records.length,
    places: places.length,
    merged: claimed.size,
    undecided: undecided.length,
    withWebsite: places.filter((p) => p.website?.url).length,
  };
  manifest.truncated = lanes.some((l) => l.truncated);
  manifest.notes = notes;

  return { places, manifest, osm: pois, sirene: records, undecided, notes };
}

/** Persist a scan outcome, raw lanes included. */
export function writeScan(runDir: string, outcome: ScanOutcome): void {
  writeJson(runDir, "osm.json", outcome.osm);
  writeJson(runDir, "sirene.json", outcome.sirene);
  writePlaces(runDir, outcome.places);
  writeJson(runDir, "MATCH.todo.json", buildMatchTodo(outcome.undecided));
  writeRunManifest(runDir, outcome.manifest);
}

export { buildMatchTodo };
