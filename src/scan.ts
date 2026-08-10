// `scan` — turn a resolved place into a list of companies.
//
// Runs the lanes, fuses them, and writes the run. The interesting decisions are
// all about honesty rather than about retrieval:
//
//   * Each lane reports its own coverage, and a truncation anywhere sets
//     `manifest.truncated`. Every renderer leads with that flag. A prospect file
//     that quietly covers 40% of a town is worse than no file, because nobody
//     downstream can tell.
//   * The register lane runs whatever register the country actually has. Exactly
//     one of them — France's — can enumerate a territory without a key, so
//     everywhere else this stage covers the ground with OSM alone and `confirm`
//     does the register work per company afterwards. The manifest records WHICH
//     of the two happened; a reader who cannot tell a swept territory from a
//     confirmed one will read every number here as complete.
//   * Fusion never invents. A pair the matcher is unsure about produces two
//     entities plus a to-do, not one entity and a shrug.
import { poiCategory, poiWebsite } from "./overpass.js";
import { fetchOsmPois } from "./overpass.js";
import { buildMatchTodo, matchLanes } from "./match.js";
import { bandsAtLeast } from "./registry/fr-sirene.js";
import { connectorById, connectorsFor, noSweepReason, unknownConnectorIds } from "./registry/index.js";
import { recordKey } from "./registry/types.js";
import type { ConnectorContext, RegistryRecord } from "./registry/types.js";
import type { GeoTarget, LaneCoverage, MatchCandidate, OsmPoi, Place, RunManifest } from "./types.js";
import { emptyManifest, licencesFor, writeJson, writePlaces, writeRunManifest } from "./run.js";
import { loadFixture } from "./fixture.js";
import { firstText } from "./util.js";

export interface ScanFilters {
  /** OSM catalogue groups to keep. Empty means every group. */
  osmGroups?: string[];
  /** Activity codes in the register's own scheme: NAF in France, SIC in the UK. */
  activityCodes?: string[];
  /** Section letters, in the country's own vocabulary. NACE A-U in Europe. */
  sections?: string[];
  /** The register's own headcount band codes to keep. */
  sizeBands?: string[];
  /** Minimum headcount; expanded into the band list that satisfies it. */
  minEmployees?: number;
  /** Include companies the register marks as ceased. Off by default. */
  includeCeased?: boolean;
  /** Skip the OSM lane. */
  noOsm?: boolean;
  /** Skip the register lane entirely. */
  noRegistry?: boolean;
  /** Restrict the register lane to these connector ids. */
  registryIds?: string[];
  /** Cap on register rows before the lane declares itself partial. */
  maxResults?: number;
  /** Pin the Overpass endpoint instead of rotating the built-in mirrors. */
  overpass?: string;
  /** Replay a recorded sweep instead of calling the live lanes. */
  fixture?: string;
  /** Keep no named individuals in the run at all. */
  noPeople?: boolean;
  /** Credentials for the connectors that need one, by connector id. */
  keys?: Record<string, string | undefined>;
}

export interface ScanOptions extends ScanFilters {
  onNote?: (note: string) => void;
}

export interface ScanOutcome {
  places: Place[];
  manifest: RunManifest;
  osm: OsmPoi[];
  registry: RegistryRecord[];
  /** Pairs the matcher scored into the middle band and refused to decide. */
  undecided: MatchCandidate[];
  notes: string[];
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

function placeFromRecord(rec: RegistryRecord): Place {
  return {
    id: recordKey(rec),
    name: firstText(...rec.names) ?? rec.id,
    sources: ["registry"],
    registry: rec,
    registryEvidence: { mode: "sweep", how: "sweep-match" },
    address: rec.address,
    lat: rec.lat,
    lon: rec.lon,
    // Namespaced by scheme, not by country: "naf=62.01Z" and "sic=62012" are
    // both activity codes and neither is comparable with "shop=bakery".
    category: rec.activityCode ? `${activityPrefix(rec)}=${rec.activityCode}` : undefined,
    contacts: { emails: [], phones: [], socials: [], people: [] },
    jobs: [],
    pages: [],
  };
}

/**
 * The namespace a record's activity code lives in: "naf=62.01Z", "sic=62012".
 *
 * Read off the connector, which declares it. Deriving it from the connector id
 * was tried and produced `sirene=62.01Z` — a namespace named after a service
 * rather than after a nomenclature, which is exactly the confusion the prefix
 * exists to prevent.
 */
function activityPrefix(rec: RegistryRecord): string {
  return connectorById(rec.connectorId)?.activityPrefix ?? "activity";
}

function mergeInto(poiPlace: Place, rec: RegistryRecord, confidence: number, by: string): void {
  poiPlace.registry = rec;
  poiPlace.registryEvidence = { mode: "sweep", how: "sweep-match" };
  poiPlace.sources = [...new Set([...poiPlace.sources, "registry" as const])];
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

  // `--min-employees` is expressed in people; a register that files bands needs
  // it expressed in bands. Only the French connector publishes bands today, so
  // only it needs the translation — a connector that files an exact headcount
  // filters on the number directly.
  const sizeBands = opts.sizeBands?.length ? opts.sizeBands : opts.minEmployees ? bandsAtLeast(opts.minEmployees) : undefined;
  const ctx: ConnectorContext = { keys: opts.keys, onNote: note };

  // ---- Replay ---------------------------------------------------------------
  // A recorded sweep short-circuits both lanes. Everything after this point —
  // fusion, coverage accounting, the manifest — runs exactly as it does live.
  const replay = opts.fixture ? loadFixture(opts.fixture) : undefined;
  if (replay) {
    note(`fixture: replaying a recorded sweep from ${opts.fixture}`);
    lanes.push({ lane: "osm", requested: 0, returned: replay.osm.length, truncated: false, reason: "replayed from a fixture", partitions: 1 });
    lanes.push({
      lane: "registry",
      mode: "sweep",
      connectorId: replay.connectorId,
      requested: 0,
      returned: replay.registry.length,
      truncated: false,
      reason: "replayed from a fixture",
      partitions: 1,
    });
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
  //
  // Only a connector that declares `sweep` can run here, and today exactly one
  // does. Everywhere else this is not a failure and not an absence of data: it
  // is a different shape of answer, delivered later by `confirm`. The coverage
  // entry says so in words a report can print verbatim.
  let records: RegistryRecord[] = replay?.registry ?? [];
  let sweepConnectorId = replay?.connectorId;
  const selection = connectorsFor(target.countryCode, { only: opts.registryIds, ctx });
  const bogus = unknownConnectorIds(opts.registryIds);
  if (bogus.length) note(`--registry: no connector is called ${bogus.join(", ")} — run \`doctor\` for the list`);
  for (const { connector, availability } of selection.unavailable) {
    if (availability.available) continue;
    note(`registry: ${connector.id} covers this country but cannot run — ${availability.reason}${availability.how ? `. ${availability.how}` : ""}`);
  }

  if (!replay && !opts.noRegistry && selection.sweep?.sweep) {
    const connector = selection.sweep;
    const t0 = Date.now();
    const result = await connector.sweep!(
      target,
      {
        sections: opts.sections,
        activityCodes: opts.activityCodes,
        sizeBands,
        includeCeased: opts.includeCeased,
        maxResults: opts.maxResults,
      },
      ctx,
    );
    timings.registry = Date.now() - t0;
    records = result.records;
    sweepConnectorId = connector.id;
    for (const n of result.notes) notes.push(n);
    lanes.push(result.coverage);
  } else if (!replay) {
    lanes.push({
      lane: "registry",
      connectorId: selection.sweep?.id,
      requested: 0,
      returned: 0,
      truncated: false,
      // Skipped, not-sweepable and not-covered are three different facts and the
      // manifest must not blur them: one is a property of the run, one of the
      // world's open data, one of the territory.
      reason: opts.noRegistry ? "skipped (--no-registry)" : noSweepReason(target.countryCode, selection),
    });
    if (!opts.noRegistry && selection.confirm.length) {
      note(
        `registry: ${target.countryCode ?? "this country"} has no sweepable register — run \`confirm\` after \`enrich --tier 1\` to check each company against ${selection.confirm.map((c) => c.id).join(", ")}`,
      );
    }
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
    const key = recordKey(rec);
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
      if (p.registry?.officers.length) {
        stripped += p.registry.officers.length;
        p.registry = { ...p.registry, officers: [] };
      }
      p.contacts.people = [];
    }
    note(`--no-people: removed ${stripped} named individual(s); the run holds organisation data only`);
  }

  const manifest = emptyManifest(target.label || target.query);
  manifest.target = target;
  manifest.filters = {
    osmGroups: opts.osmGroups ?? "all",
    activityCodes: opts.activityCodes ?? null,
    sections: opts.sections ?? null,
    sizeBands: sizeBands ?? null,
    includeCeased: Boolean(opts.includeCeased),
    maxResults: opts.maxResults ?? null,
    registryIds: opts.registryIds ?? null,
  };
  manifest.lanes = lanes;
  manifest.timings = timings;
  manifest.counts = {
    ...manifest.counts,
    osm: pois.length,
    registry: records.length,
    byConnector: sweepConnectorId && records.length ? { [sweepConnectorId]: records.length } : {},
    places: places.length,
    merged: claimed.size,
    undecided: undecided.length,
    withWebsite: places.filter((p) => p.website?.url).length,
  };
  manifest.licences = licencesFor(lanes);
  manifest.truncated = lanes.some((l) => l.truncated);
  manifest.notes = notes;

  return { places, manifest, osm: pois, registry: records, undecided, notes };
}

/** Persist a scan outcome, raw lanes included. */
export function writeScan(runDir: string, outcome: ScanOutcome): void {
  writeJson(runDir, "osm.json", outcome.osm);
  writeJson(runDir, "registry.json", outcome.registry);
  writePlaces(runDir, outcome.places);
  writeJson(runDir, "MATCH.todo.json", buildMatchTodo(outcome.undecided));
  writeRunManifest(runDir, outcome.manifest);
}

export { buildMatchTodo };
