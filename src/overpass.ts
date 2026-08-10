// The OpenStreetMap lane: every business-like feature inside an area.
//
// This lane is what makes the skill work outside France. It is also the only
// lane that knows a shop's opening hours, its brand, and — for about a fifth of
// them — its website, which is the seed the whole enrichment stage grows from.
//
// Three things here are not incidental complexity:
//
//   1. MIRROR ROTATION. The main instance (overpass-api.de) returns 504s under
//      load often enough that a hardcoded endpoint is a broken tool on a bad
//      day. Every mirror is tried in order; the one that answers is recorded in
//      the manifest so a thin run can be explained later.
//   2. QUADRANT SPLITTING. A dense city centre exceeds the public instances'
//      memory and time limits. On a timeout the bbox is quartered and retried,
//      recursively. Four small queries that succeed beat one large one that 504s.
//   3. AREA over BBOX. When the geocoder gave us an administrative relation we
//      search the real boundary, not the rectangle around it. A bbox for
//      Vincennes includes slices of Paris, Saint-Mandé and Fontenay — a
//      prospect file for "Vincennes" containing Paris shops is wrong in a way
//      nobody downstream can detect.
//
// Data is ODbL. The attribution travels with it, in the manifest and in every
// rendered deliverable.
import { awaitHostSlot, httpGet } from "./engine.js";
import { politeUa } from "./net.js";
import type { GeoTarget, OsmPoi } from "./types.js";
import { bboxAround, bboxQuadrants } from "./util.js";

/**
 * Public Overpass instances, in the order they are tried.
 *
 * EVERY ENTRY IS A VERIFIED FULL-PLANET INSTANCE. That is a membership rule,
 * not a description, and the reason is a failure mode worth stating: several
 * public Overpass endpoints serve a REGIONAL EXTRACT while speaking the same
 * protocol. `overpass.osm.ch` answers a query over Vincennes with HTTP 200 and
 * an empty element list — indistinguishable, to any caller that only checks the
 * status code, from "this town has no businesses". A regional mirror in this
 * rotation would not produce an error; it would produce an empty territory.
 * Both osm.ch and osm.jp were measured and excluded on exactly that basis.
 *
 * Order: the reference instance first (freshest data), then two community
 * instances that queue but answer, then maps.mail.ru. The last one is fastest
 * in practice and is a long-standing public instance, but it is operated in a
 * jurisdiction some users would rather not send traffic to, so it sits behind
 * the others and `--overpass <url>` overrides the whole list.
 */
export const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
] as const;

/**
 * The tag catalogue: what counts as "a business" in OSM's vocabulary.
 *
 * OSM has no `business=yes`. Commercial activity is spread across a dozen keys
 * by category, so the catalogue is explicit rather than clever. Whole keys are
 * taken where the key itself means commerce (`shop`, `office`, `craft`,
 * `healthcare`); keys that mix commerce with street furniture (`amenity` also
 * covers benches and drinking fountains) are enumerated value by value.
 *
 * Erring towards inclusion: a false positive is a row the agent discards, a
 * false negative is a prospect nobody ever learns existed.
 */
export const OSM_TAG_GROUPS: Record<string, string> = {
  shop: '["shop"]',
  office: '["office"]',
  craft: '["craft"]',
  healthcare: '["healthcare"]',
  club: '["club"]',
  amenity:
    '["amenity"~"^(restaurant|cafe|bar|pub|fast_food|food_court|ice_cream|biergarten|bank|bureau_de_change|atm|pharmacy|clinic|doctors|dentist|veterinary|driving_school|language_school|prep_school|music_school|training|childcare|kindergarten|school|college|university|hospital|nursing_home|social_facility|funeral_directors|fuel|car_wash|car_rental|car_sharing|charging_station|cinema|theatre|nightclub|casino|marketplace|post_office|coworking_space|studio|internet_cafe|animal_boarding|animal_shelter|vehicle_inspection)$"]',
  tourism: '["tourism"~"^(hotel|motel|hostel|guest_house|apartment|chalet|camp_site|caravan_site|museum|gallery)$"]',
  leisure:
    '["leisure"~"^(fitness_centre|sports_centre|sports_hall|dance|escape_game|bowling_alley|amusement_arcade|adult_gaming_centre|horse_riding|golf_course|marina|hackerspace|trampoline_park)$"]',
};

export interface OverpassOptions {
  /** Restrict to these catalogue groups. Empty means all of them. */
  groups?: string[];
  /** Extra raw Overpass tag filters, e.g. `["brand"]`. Appended verbatim. */
  extraFilters?: string[];
  /** Server-side timeout, in seconds, written into the query header. */
  timeoutS?: number;
  /** Mirrors to try, in order. Defaults to OVERPASS_MIRRORS. */
  mirrors?: readonly string[];
  /** How many times a too-big area may be quartered. */
  maxSplitDepth?: number;
  /** Called with human-readable progress. */
  onNote?: (note: string) => void;
}

export interface OverpassResult {
  pois: OsmPoi[];
  /** Which mirror answered, per sub-query. */
  mirrorsUsed: string[];
  /** How many sub-queries the area was split into. 1 means no split was needed. */
  partitions: number;
  notes: string[];
  /** True when a leaf query still failed after the split budget ran out. */
  incomplete: boolean;
}

/** An Overpass `area` id is the OSM relation id offset by 3600000000. */
export function areaIdFor(target: Pick<GeoTarget, "osmType" | "osmId">): number | undefined {
  if (target.osmType !== "relation" || typeof target.osmId !== "number") return undefined;
  return 3_600_000_000 + target.osmId;
}

/** The scope clause every tag filter is bound to: a real boundary, or a box. */
function scopeClause(area: number | undefined, bbox: [number, number, number, number]): { header: string; suffix: string } {
  if (area !== undefined) return { header: `area(${area})->.searchArea;\n`, suffix: "(area.searchArea)" };
  const [s, n, w, e] = bbox;
  return { header: "", suffix: `(${s},${w},${n},${e})` };
}

export function buildQuery(area: number | undefined, bbox: [number, number, number, number], opts: OverpassOptions = {}): string {
  const groups = opts.groups?.length ? opts.groups : Object.keys(OSM_TAG_GROUPS);
  const filters = [...groups.map((g) => OSM_TAG_GROUPS[g]).filter((f): f is string => Boolean(f)), ...(opts.extraFilters ?? [])];
  const { header, suffix } = scopeClause(area, bbox);
  const body = filters.map((f) => `  nwr${f}${suffix};`).join("\n");
  // `out center tags` gives one representative coordinate for ways and
  // relations too, so a supermarket mapped as a building is a point like any
  // other downstream. Without `center`, every non-node comes back geometry-less.
  return `[out:json][timeout:${opts.timeoutS ?? 90}];\n${header}(\n${body}\n);\nout center tags;`;
}

/** Overpass reports failures as an HTML page with a 200 or a 5xx. Sniff both. */
export function overpassError(body: string): string | undefined {
  if (body.trimStart().startsWith("{")) return undefined;
  const m = /<strong[^>]*>Error<\/strong>:\s*([^<]+)/i.exec(body);
  return (m?.[1] ?? body.slice(0, 160)).replace(/\s+/g, " ").trim();
}

// Overpass failures come in two kinds that look alike and want OPPOSITE
// responses, and conflating them is why a first cut of this file declared a
// perfectly ordinary town "incomplete".
//
//   INSTANCE BUSY — `Dispatcher_Client::request_read_and_idx::timeout`,
//   `open64`, a 504, a connection that never answers. The QUERY is fine; this
//   particular server is saturated. The fix is another mirror. Splitting instead
//   turns one query into four, sends all four to the same overloaded host, and
//   reports a partial territory.
//
//   QUERY TOO BIG — `Query timed out in N seconds`, `out of memory`. Every
//   instance runs the same software with the same limits, so rotating spends
//   four timeouts to learn the same thing. The fix is a smaller area.
//
// Both strings contain the word "timeout", which is exactly the trap.

/** The server is saturated. Try somewhere else. Exported for the drift tests. */
export function isInstanceBusy(message: string): boolean {
  return /dispatcher|open64|too busy|rate.?limit|HTTP 50[234]|HTTP 429|HTTP 0\b|not JSON|fetch failed|aborted|socket|ETIMEDOUT|ECONNRESET/i.test(message);
}

/** The query asked for more than any instance will give. Ask for less. Exported for the drift tests. */
export function isQueryTooBig(message: string): boolean {
  return /query timed out|out of memory|too many results|memory limit/i.test(message);
}

async function runOnce(query: string, opts: OverpassOptions): Promise<{ json?: any; error?: string; mirror?: string; tooBig?: boolean }> {
  const mirrors = opts.mirrors ?? OVERPASS_MIRRORS;
  const failures: string[] = [];
  for (const mirror of mirrors) {
    await awaitHostSlot(mirror, 1000);
    let body: string;
    try {
      const res = await httpGet(`${mirror}?data=${encodeURIComponent(query)}`, {
        timeoutMs: (opts.timeoutS ?? 90) * 1000 + 15_000,
        // An identifying User-Agent is not optional here: the reference instance
        // answers 406 to a browser string. See src/net.ts.
        userAgent: politeUa(),
        // Well above the engine's HTML default: a dense arrondissement answers
        // with several megabytes of JSON, and a truncated body would parse as a
        // syntax error and be retried on every mirror in turn for nothing.
        maxBytes: 64 * 1024 * 1024,
        // Overpass is slow by nature and its failures are capacity failures;
        // retrying the same heavy query at the same instance just doubles the
        // load that caused it. Rotation and splitting are the recovery here.
        retries: 0,
      });
      body = res.body ?? "";
      if (!res.ok && !body) {
        failures.push(`${mirror}: HTTP ${res.status}`);
        continue;
      }
    } catch (e) {
      failures.push(`${mirror}: ${(e as Error).message}`);
      continue;
    }
    const err = overpassError(body);
    if (err) {
      failures.push(`${mirror}: ${err}`);
      // Too big for anyone: stop rotating, tell the caller to split.
      if (isQueryTooBig(err)) return { error: err, mirror, tooBig: true };
      // Busy: fall through to the next mirror.
      continue;
    }
    try {
      return { json: JSON.parse(body), mirror };
    } catch {
      failures.push(`${mirror}: response was not JSON`);
    }
  }
  const joined = failures.join(" | ");
  // Every mirror refused. If they all refused for capacity reasons the area is
  // probably too big after all, so let the caller split rather than give up —
  // splitting is cheap and a wrongly-declared truncation is not.
  return { error: joined, tooBig: failures.every((f) => isQueryTooBig(f) || isInstanceBusy(f)) };
}

function toPoi(el: any): OsmPoi | undefined {
  const tags = (el?.tags ?? {}) as Record<string, string>;
  const lat = el?.lat ?? el?.center?.lat;
  const lon = el?.lon ?? el?.center?.lon;
  if (typeof lat !== "number" || typeof lon !== "number") return undefined;
  const osmType = el?.type === "way" || el?.type === "relation" ? el.type : "node";
  return {
    id: `${osmType[0]}${el.id}`,
    osmType,
    osmId: el.id,
    name: tags.name ?? tags["name:fr"] ?? tags.brand ?? tags.operator,
    lat,
    lon,
    tags,
  };
}

/**
 * Fetch every business-like POI in the target area.
 *
 * Splits the area on capacity failures until it fits or the split budget runs
 * out. A leaf that still fails is reported through `incomplete` — never
 * swallowed, because a short list that claims to be a whole territory is the
 * failure mode this tool exists to avoid.
 */
export async function fetchOsmPois(target: GeoTarget, opts: OverpassOptions = {}): Promise<OverpassResult> {
  const maxDepth = opts.maxSplitDepth ?? 3;
  const notes: string[] = [];
  const mirrorsUsed = new Set<string>();
  const byId = new Map<string, OsmPoi>();
  let partitions = 0;
  let incomplete = false;

  const area = target.radiusM ? undefined : areaIdFor(target);
  const rootBbox = target.radiusM ? bboxAround(target.lat, target.lon, target.radiusM) : target.bbox;

  async function walk(bbox: [number, number, number, number], useArea: number | undefined, depth: number): Promise<void> {
    const query = buildQuery(useArea, bbox, opts);
    const { json, error, mirror, tooBig } = await runOnce(query, opts);
    if (mirror) mirrorsUsed.add(mirror);

    if (error) {
      // An `area` query cannot be quartered — the boundary is a single object.
      // Drop to the bounding box around it, then split that. This costs
      // precision (a bbox for Vincennes clips into Paris), so it is recorded as
      // a note: the run is complete but its edges are not the commune's.
      if (useArea !== undefined) {
        notes.push(`overpass: the administrative-area query failed (${error}); fell back to the bounding box, which extends past the commune boundary`);
        opts.onNote?.("overpass: area query failed, falling back to bbox (edges will overshoot the boundary)");
        return walk(bbox, undefined, depth);
      }
      if (tooBig && depth < maxDepth) {
        notes.push(`overpass: splitting a too-large area at depth ${depth} (${error})`);
        opts.onNote?.(`overpass: area too large, splitting into 4 (depth ${depth + 1})`);
        for (const q of bboxQuadrants(bbox)) await walk(q, undefined, depth + 1);
        return;
      }
      incomplete = true;
      notes.push(`overpass: gave up on a tile after depth ${depth} — ${error}`);
      opts.onNote?.("overpass: a tile could not be fetched; the OSM lane is INCOMPLETE");
      return;
    }

    partitions++;
    for (const el of json?.elements ?? []) {
      const poi = toPoi(el);
      // Deduplicate across tiles: quadrants share edges, and a way whose centre
      // sits on one is returned by both.
      if (poi && !byId.has(poi.id)) byId.set(poi.id, poi);
    }
  }

  await walk(rootBbox, area, 0);

  return {
    pois: [...byId.values()],
    mirrorsUsed: [...mirrorsUsed],
    partitions: Math.max(1, partitions),
    notes,
    incomplete,
  };
}

/** Best-effort category label for a POI, for the report and the CSV. */
export function poiCategory(poi: OsmPoi): string | undefined {
  for (const key of ["shop", "office", "craft", "healthcare", "amenity", "tourism", "leisure", "club"]) {
    const v = poi.tags[key];
    if (v && v !== "yes") return `${key}=${v}`;
    if (v === "yes") return key;
  }
  return undefined;
}

/** The website a POI declares, if any. OSM splits this over two tag spellings. */
export function poiWebsite(poi: OsmPoi): string | undefined {
  const raw = poi.tags.website ?? poi.tags["contact:website"] ?? poi.tags.url;
  if (!raw) return undefined;
  const first = raw.split(/[;\s]+/)[0];
  if (!first) return undefined;
  return /^https?:\/\//i.test(first) ? first : `https://${first}`;
}
