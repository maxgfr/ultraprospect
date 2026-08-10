// Turning "Vincennes", "rue de Rivoli, Paris" or "8 bd du Port, Amiens" into a
// search area.
//
// Two geocoders, with distinct jobs rather than one as the other's fallback:
//
//   Nominatim (OSM)  resolves ANYWHERE, and is the only one that returns the
//                    administrative RELATION id — which is what lets the
//                    Overpass lane search a commune's real boundary instead of
//                    a rectangle that spills into the next town.
//   BAN (data.gouv)  covers France only, but returns the INSEE `citycode`,
//                    which is the SIRENE lane's most precise filter. Postcodes
//                    are not commune codes: 75015 is an arrondissement, 80021
//                    is Amiens, and the register indexes on the latter.
//
// So Nominatim always runs, and BAN runs afterwards to enrich a French hit.
// They are not redundant; each supplies a key the other cannot.
//
// Nominatim's usage policy is one request per second with a User-Agent that
// identifies the client. We call it once per run and let the engine's per-host
// token bucket hold the floor, because a skill that gets a volunteer service
// blocked for everyone is worse than a skill that is slow.
import { awaitHostSlot, httpJson } from "./engine.js";
import { politeUa } from "./net.js";
import type { GeoCandidate, GeoTarget } from "./types.js";
import { firstText, haversineM } from "./util.js";

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const BAN = "https://api-adresse.data.gouv.fr/search/";

/** Nominatim asks for >=1s between requests. Its own policy, not a tuning knob. */
const NOMINATIM_DELAY_MS = 1100;

export interface GeocodeOptions {
  /** ISO-3166-1 alpha-2 hint, e.g. "fr". Narrows Nominatim, nothing more. */
  country?: string;
  /** Preferred response language for labels. */
  lang?: string;
  /** Take the Nth candidate (1-based) instead of refusing an ambiguous query. */
  pick?: number;
  /** Radius in metres, when the caller wants a point search rather than an area. */
  radiusM?: number;
}

/**
 * Either a resolved target, or the candidates we refused to choose between.
 *
 * Refusing is the point. "Saint-Denis" is a Paris suburb, a Réunion prefecture
 * and a dozen villages; silently picking the most "important" one would produce
 * a complete, plausible, wrong prospect file — the single worst output this tool
 * can emit, because nothing downstream would look off.
 */
export type GeocodeResult = { ok: true; target: GeoTarget } | { ok: false; candidates: GeoCandidate[]; reason: string };

interface NominatimHit {
  display_name?: string;
  lat?: string;
  lon?: string;
  boundingbox?: [string, string, string, string];
  osm_type?: string;
  osm_id?: number;
  type?: string;
  addresstype?: string;
  importance?: number;
  address?: { country_code?: string; postcode?: string };
}

/** Two hits this far apart are different places, not two spellings of one. */
const DISTINCT_PLACE_M = 10_000;
/** Importance within this ratio of the top hit is "just as plausible". */
const AMBIGUITY_RATIO = 0.85;

export async function resolveWhere(query: string, opts: GeocodeOptions = {}): Promise<GeocodeResult> {
  const q = query.trim();
  if (!q) return { ok: false, candidates: [], reason: "empty query" };

  const hits = await nominatimSearch(q, opts);
  if (hits.length === 0) {
    return { ok: false, candidates: [], reason: `no geocoder result for "${q}"` };
  }

  const picked = opts.pick ? hits[opts.pick - 1] : hits[0];
  if (!picked) {
    return { ok: false, candidates: hits.map(toCandidate), reason: `--pick ${opts.pick} is out of range (${hits.length} candidates)` };
  }

  if (!opts.pick) {
    const rival = hits.slice(1).find((h) => isRival(hits[0]!, h));
    if (rival) {
      return {
        ok: false,
        candidates: hits.map(toCandidate),
        reason: `"${q}" is ambiguous — several distinct places match with comparable confidence`,
      };
    }
  }

  const target = await toTarget(q, picked, opts);
  return { ok: true, target };
}

function isRival(top: NominatimHit, other: NominatimHit): boolean {
  const ti = top.importance ?? 0;
  const oi = other.importance ?? 0;
  if (ti > 0 && oi / ti < AMBIGUITY_RATIO) return false;
  const [tLat, tLon] = [Number(top.lat), Number(top.lon)];
  const [oLat, oLon] = [Number(other.lat), Number(other.lon)];
  if (![tLat, tLon, oLat, oLon].every(Number.isFinite)) return false;
  return haversineM(tLat, tLon, oLat, oLon) > DISTINCT_PLACE_M;
}

function toCandidate(h: NominatimHit): GeoCandidate {
  return {
    label: h.display_name ?? "(unnamed)",
    lat: Number(h.lat),
    lon: Number(h.lon),
    kind: firstText(h.addresstype, h.type) ?? "place",
    source: "nominatim",
  };
}

async function nominatimSearch(q: string, opts: GeocodeOptions): Promise<NominatimHit[]> {
  const url = new URL(NOMINATIM);
  url.searchParams.set("q", q);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "5");
  url.searchParams.set("addressdetails", "1");
  if (opts.country) url.searchParams.set("countrycodes", opts.country.toLowerCase());
  if (opts.lang) url.searchParams.set("accept-language", opts.lang);

  await awaitHostSlot(url.href, NOMINATIM_DELAY_MS);
  const res = await httpJson("GET", url.href, undefined, { timeoutMs: 20_000, acceptLanguage: opts.lang, userAgent: politeUa() });
  if (!res.ok || !Array.isArray(res.data)) return [];
  return res.data as NominatimHit[];
}

async function toTarget(query: string, hit: NominatimHit, opts: GeocodeOptions): Promise<GeoTarget> {
  const lat = Number(hit.lat);
  const lon = Number(hit.lon);
  // Nominatim's boundingbox is [minLat, maxLat, minLon, maxLon] as strings.
  const bb = hit.boundingbox?.map(Number) ?? [];
  const bbox: [number, number, number, number] =
    bb.length === 4 && bb.every(Number.isFinite) ? [bb[0]!, bb[1]!, bb[2]!, bb[3]!] : [lat - 0.01, lat + 0.01, lon - 0.015, lon + 0.015];

  const countryCode = hit.address?.country_code?.toLowerCase();
  const target: GeoTarget = {
    query,
    label: hit.display_name ?? query,
    lat,
    lon,
    bbox,
    countryCode,
    osmType: hit.osm_type === "relation" || hit.osm_type === "way" || hit.osm_type === "node" ? hit.osm_type : undefined,
    osmId: typeof hit.osm_id === "number" ? hit.osm_id : undefined,
    postcode: hit.address?.postcode,
    source: "nominatim",
    radiusM: opts.radiusM,
  };

  if (countryCode === "fr") {
    const insee = await banCityCode(query);
    if (insee) {
      target.codeCommune = insee.citycode;
      target.postcode ??= insee.postcode;
    }
  }
  return target;
}

/**
 * The INSEE commune code for a French query, via the Base Adresse Nationale.
 *
 * Best-effort: a missing citycode costs the SIRENE lane its sharpest filter but
 * never blocks the run — it falls back to a radius search around the centroid.
 */
async function banCityCode(query: string): Promise<{ citycode?: string; postcode?: string } | undefined> {
  const url = new URL(BAN);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "1");
  await awaitHostSlot(url.href);
  const res = await httpJson("GET", url.href, undefined, { timeoutMs: 15_000, userAgent: politeUa() });
  const props = res.ok ? res.data?.features?.[0]?.properties : undefined;
  if (!props) return undefined;
  return { citycode: props.citycode, postcode: props.postcode };
}
