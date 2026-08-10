// Fusing the two discovery lanes into one entity per company.
//
// OSM sees shopfronts; a register sees legal units at postal addresses. The
// same bakery is a `shop=bakery` node with an awning and a filed establishment
// at the building — and the whole value of the join is that neither half is a
// prospect on its own.
//
// This file is deliberately connector-agnostic. It scores an OSM POI against a
// `RegistryRecord`, whichever register produced it, which is what lets the same
// identity-dominant rules adjudicate a French sweep and a German confirmation
// without a second set of thresholds nobody would keep in sync.
//
// The scoring is deliberately IDENTITY-DOMINANT. Proximity alone means nothing:
// a Paris office block holds fifty registered companies inside twenty metres,
// so distance can only ever confirm a name, never substitute for one. A pair
// with no name, brand or street-address agreement is not a match at any
// distance, and the code says so as a hard gate rather than as a low weight.
//
// And where the evidence is real but thin, the matcher DOES NOT DECIDE. Pairs in
// the middle band go to MATCH.todo.json for the agent to adjudicate. A wrong
// merge is invisible downstream — it produces one plausible company with
// someone else's SIREN — so the cost of guessing is much higher here than the
// cost of asking.
import type { MatchCandidate, MatchTodo, OsmPoi, Place, PostalAddress } from "./types.js";
import type { RegistryRecord } from "./registry/types.js";
import { recordKey } from "./registry/types.js";
import { bestNameMatch, foldAccents, haversineM, nameSimilarity } from "./util.js";

/** Beyond this, two records are not the same shopfront whatever they are called. */
export const MAX_DISTANCE_M = 150;
/** At or above: merge. */
export const MERGE_HIGH = 0.72;
/** Below: two distinct entities. Between the two: the agent decides. */
export const MERGE_LOW = 0.4;
/** Below this identity agreement, proximity cannot rescue the pair. */
const MIN_IDENTITY = 0.25;

/** Grid cell for the candidate index. ~0.002° is roughly 220 m of latitude. */
const CELL = 0.002;

function cellKey(lat: number, lon: number): string {
  return `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;
}

/** Every register record within one grid cell of a point, plus its neighbours. */
function buildIndex(records: readonly RegistryRecord[]): Map<string, RegistryRecord[]> {
  const index = new Map<string, RegistryRecord[]>();
  for (const r of records) {
    if (typeof r.lat !== "number" || typeof r.lon !== "number") continue;
    const key = cellKey(r.lat, r.lon);
    const bucket = index.get(key);
    if (bucket) bucket.push(r);
    else index.set(key, [r]);
  }
  return index;
}

function nearby(index: Map<string, RegistryRecord[]>, lat: number, lon: number): RegistryRecord[] {
  const out: RegistryRecord[] = [];
  const baseLat = Math.floor(lat / CELL);
  const baseLon = Math.floor(lon / CELL);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const bucket = index.get(`${baseLat + dy}:${baseLon + dx}`);
      if (bucket) out.push(...bucket);
    }
  }
  return out;
}

/** Every name the register knows this establishment by. */
function registerNames(r: RegistryRecord): string[] {
  return r.names.filter((n) => Boolean(n?.trim()));
}

/** The street address an OSM POI declares, when the mapper filled it in. */
function poiAddress(poi: OsmPoi): PostalAddress {
  return {
    numero: poi.tags["addr:housenumber"],
    libelleVoie: poi.tags["addr:street"],
    codePostal: poi.tags["addr:postcode"],
    commune: poi.tags["addr:city"],
  };
}

/** Street names agree when their significant words do, type word aside. */
function sameStreet(a: string | undefined, b: string | undefined, bType?: string): boolean {
  if (!a || !b) return false;
  const norm = (s: string) =>
    foldAccents(s)
      .toLowerCase()
      .replace(/^(rue|avenue|av|boulevard|bd|quai|place|pl|impasse|allee|chemin|route|rte|cours|square|passage)\s+/i, "")
      .replace(/\bde\s+la\b|\bdes\b|\bdu\b|\bde\b|\ble\b|\bla\b|\bl\b/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const na = norm(a);
  const nb = norm(bType ? `${bType} ${b}` : b);
  return na.length > 2 && na === nb;
}

export interface PairScore {
  score: number;
  parts: { distance: number; name: number; enseigne: number; address: number };
  distanceM: number;
  /** Which of the register's names produced `parts.name`. */
  matchedName?: string;
}

/**
 * Score one OSM POI against one register establishment.
 *
 * Returns score 0 when the pair fails the identity gate — which is the common
 * case, and the reason a dense area does not collapse into nonsense.
 */
export function scorePair(poi: OsmPoi, rec: RegistryRecord): PairScore {
  const distanceM = typeof rec.lat === "number" && typeof rec.lon === "number" ? haversineM(poi.lat, poi.lon, rec.lat, rec.lon) : Number.POSITIVE_INFINITY;
  const zero: PairScore = { score: 0, parts: { distance: 0, name: 0, enseigne: 0, address: 0 }, distanceM };
  if (!Number.isFinite(distanceM) || distanceM > MAX_DISTANCE_M) return zero;

  const poiName = poi.name ?? "";
  // Which of the register's names actually matched is carried out of here, not
  // just how well. The adjudication file used to print `nomComplet` whatever
  // scored — so "Crèche Jean Burgeat <-> COMMUNE DE VINCENNES" appeared as an
  // obvious no, when the 0.67 had come from the enseigne "CRECHE BURGEAT" and
  // the pair was an obvious yes. The agent was being shown the wrong evidence.
  const best = poiName ? bestNameMatch(poiName, registerNames(rec)) : { name: undefined, score: 0 };
  const nameScore = best.score;
  // The brand tag is a separate signal from the name: a franchise is mapped as
  // `brand=Carrefour` with `name=Carrefour City Vincennes`, and the register
  // files it under an enseigne rather than a denomination.
  const brand = poi.tags.brand ?? poi.tags.operator ?? "";
  const trading = rec.tradingNames ?? [];
  const enseigneScore = brand && trading.length ? Math.max(0, ...trading.map((e: string) => nameSimilarity(brand, e))) : 0;

  const pa = poiAddress(poi);
  const numberAgrees = Boolean(
    pa.numero && rec.address.numero && pa.numero.replace(/\s/g, "").toLowerCase() === rec.address.numero.replace(/\s/g, "").toLowerCase(),
  );
  const streetAgrees = sameStreet(pa.libelleVoie, rec.address.libelleVoie, rec.address.typeVoie);
  const addressScore = numberAgrees && streetAgrees ? 1 : streetAgrees ? 0.6 : 0;

  // An exact street address CONFIRMS a name; it does not replace one.
  //
  // This started as "a full address is near-proof of identity", and a real
  // Vincennes run showed what that buys: seven pairs auto-merged on an address
  // with no name agreement whatever — "Aux Papilles" ↔ "BRUNO ENCAOUA" and
  // "Synotis" ↔ "SYNALTIC" (both right, a trade name and a stale one), and
  // "Société Générale" ↔ "PAREX AUDIT S.A.S" (plainly wrong, one bank branch
  // and one audit firm in the same building). They are the same shape. The
  // matcher cannot tell them apart, and neither could any rule available here.
  //
  // Occupancy was tried as the discriminator — an address one company occupies
  // versus one several share — and abandoned: it can only be counted over the
  // records this run FETCHED, and any `--section`/`--min-employees` filter makes
  // every address look like a sole occupancy. A signal that is wrong precisely
  // when a filter is used is worse than no signal.
  //
  // So address-only lands in the undecided band, which is what the band is for:
  // real evidence, too thin to decide, adjudicated rather than guessed. With
  // even weak name support (>= 0.4) the two signals agree and it merges.
  const nameSupported = nameScore >= 0.4 || enseigneScore >= 0.4;
  const addressIdentity = addressScore === 1 ? (nameSupported ? 0.9 : 0.6) : addressScore * 0.5;
  const identity = Math.max(nameScore, enseigneScore, addressIdentity);
  if (identity < MIN_IDENTITY) return zero;

  const proximity = 1 - Math.min(1, distanceM / MAX_DISTANCE_M);
  const score = 0.8 * identity + 0.2 * proximity;
  return { score, parts: { distance: proximity, name: nameScore, enseigne: enseigneScore, address: addressScore }, distanceM, matchedName: best.name };
}

/** A merge the matcher made on its own, with the score it made it on. */
export interface MergeDecision {
  osmId: string;
  /** The pair's score, 0.72-1. Carried through so a row can be re-judged later. */
  score: number;
  /** Which signal carried it — name, enseigne or address. */
  by: "name" | "enseigne" | "address";
}

export interface MatchOutcome {
  /** `recordKey(rec)` -> the merge, for pairs confident enough. */
  merged: Map<string, MergeDecision>;
  /** Pairs in the middle band, for the agent. */
  undecided: MatchCandidate[];
}

function toCandidate(poi: OsmPoi, rec: RegistryRecord, scored: PairScore): MatchCandidate {
  return {
    osmId: poi.id,
    connectorId: rec.connectorId,
    registryId: rec.establishmentId ?? rec.id,
    legalId: rec.establishmentId ? rec.id : undefined,
    registryName: rec.legalName ?? rec.names[0],
    // The name the score came from, which is often NOT nomComplet.
    matchedName: scored.matchedName,
    osmName: poi.name,
    score: Number(scored.score.toFixed(4)),
    parts: {
      distance: Number(scored.parts.distance.toFixed(4)),
      name: Number(scored.parts.name.toFixed(4)),
      enseigne: Number(scored.parts.enseigne.toFixed(4)),
      address: Number(scored.parts.address.toFixed(4)),
    },
    distanceM: Math.round(scored.distanceM),
  };
}

/**
 * Pair the two lanes, one-to-one, best pairs first.
 *
 * Greedy on a descending score list rather than a global optimum: the
 * assignment problem here is tiny per neighbourhood and the scores are
 * well-separated, so the optimal matching and the greedy one agree except in
 * cases that belong in the undecided band anyway.
 */
export function matchLanes(pois: readonly OsmPoi[], records: readonly RegistryRecord[]): MatchOutcome {
  const index = buildIndex(records);
  const scored: { poi: OsmPoi; rec: RegistryRecord; s: PairScore }[] = [];

  for (const poi of pois) {
    for (const rec of nearby(index, poi.lat, poi.lon)) {
      const s = scorePair(poi, rec);
      if (s.score >= MERGE_LOW) scored.push({ poi, rec, s });
    }
  }
  scored.sort((a, b) => b.s.score - a.s.score);

  const merged = new Map<string, MergeDecision>();
  const usedPoi = new Set<string>();
  const usedRec = new Set<string>();
  const undecided: MatchCandidate[] = [];

  for (const { poi, rec, s } of scored) {
    const key = recordKey(rec);
    if (usedPoi.has(poi.id) || usedRec.has(key)) continue;
    if (s.score >= MERGE_HIGH) {
      // The score is recorded, never flattened to 1. A merge at 0.74 carried by
      // a street number alone and a merge at 0.98 on an exact name are both
      // "merged", and only one of them is worth re-reading when a row looks
      // wrong: Synotis(OSM) was merged with SYNALTIC(register) on the address,
      // with a name similarity of 0.21. Correct — the shopfront name is stale —
      // but a confidence of 1 would have hidden that entirely.
      const by = s.parts.address >= 1 && s.parts.name < 0.5 && s.parts.enseigne < 0.5 ? "address" : s.parts.enseigne > s.parts.name ? "enseigne" : "name";
      merged.set(key, { osmId: poi.id, score: Number(s.score.toFixed(3)), by });
      usedPoi.add(poi.id);
      usedRec.add(key);
    } else {
      undecided.push(toCandidate(poi, rec, s));
    }
  }

  return { merged, undecided };
}

export function buildMatchTodo(undecided: readonly MatchCandidate[]): MatchTodo {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    // Strongest first: the agent works down a list that gets easier to reject,
    // and can stop when the evidence thins out.
    pairs: [...undecided].sort((a, b) => b.score - a.score),
  };
}

/** An adjudication the agent hands back: merge this pair, or keep them apart. */
export interface MatchVerdict {
  osmId: string;
  /**
   * The register side of the pair, copied from `MATCH.todo.json`.
   *
   * Either the bare identifier (`"12345678900012"`) or the fully-qualified key
   * (`"fr-sirene:12345678900012"`). Both are accepted because the todo file
   * shows both, and rejecting the one the agent happened to copy would turn a
   * correct adjudication into an "unknown pair" line nobody can act on.
   */
  registryId?: string;
  connectorId?: string;
  merge: boolean;
  why?: string;
}

/** Resolve whatever the agent copied back into the key `applyVerdicts` indexes on. */
export function verdictKey(v: MatchVerdict, known: ReadonlySet<string>): string | undefined {
  const raw = v.registryId?.trim();
  if (!raw) return undefined;
  if (known.has(raw)) return raw;
  if (v.connectorId) {
    const qualified = `${v.connectorId}:${raw}`;
    if (known.has(qualified)) return qualified;
  }
  // The agent gave a bare id and no connector. Unambiguous only if exactly one
  // connector in this run carries it; two matches is a real ambiguity and must
  // not be resolved by picking the first.
  const suffixed = [...known].filter((k) => k.endsWith(`:${raw}`));
  return suffixed.length === 1 ? suffixed[0] : undefined;
}

/**
 * Fold the agent's verdicts into an existing place list.
 *
 * Only merges are acted on — a "keep apart" verdict is already the state of the
 * world, and recording it as a change would make the run non-idempotent.
 */
export function applyVerdicts(places: Place[], verdicts: readonly MatchVerdict[]): { merged: number; skipped: number; unknown: string[] } {
  const byOsm = new Map<string, Place>();
  const byRecord = new Map<string, Place>();
  for (const p of places) {
    if (p.osm) byOsm.set(p.osm.id, p);
    if (p.registry) byRecord.set(recordKey(p.registry), p);
  }
  const known = new Set(byRecord.keys());

  let mergedCount = 0;
  let skipped = 0;
  const unknown: string[] = [];

  for (const v of verdicts) {
    if (!v.merge) {
      skipped++;
      continue;
    }
    const key = verdictKey(v, known);
    const osmPlace = byOsm.get(v.osmId);
    const recPlace = key ? byRecord.get(key) : undefined;
    if (!osmPlace || !recPlace || osmPlace === recPlace) {
      unknown.push(`${v.osmId} <-> ${key ?? v.registryId ?? "?"}`);
      continue;
    }
    // Keep the OSM entity as the survivor: it carries the physical identity
    // (name on the door, coordinates, category) the rest of the run keys on.
    osmPlace.registry = recPlace.registry;
    osmPlace.registryEvidence = recPlace.registryEvidence ?? { mode: "sweep", how: "agent-adjudicated" };
    osmPlace.sources = [...new Set([...osmPlace.sources, "registry" as const])];
    osmPlace.matchConfidence = 1;
    osmPlace.address = { ...recPlace.address, ...osmPlace.address };
    recPlace.id = "";
    mergedCount++;
  }

  // Dropping the absorbed entries in place keeps the caller's array identity,
  // which matters because it is the same array the run writes back out.
  for (let i = places.length - 1; i >= 0; i--) if (places[i]!.id === "") places.splice(i, 1);

  return { merged: mergedCount, skipped, unknown };
}
