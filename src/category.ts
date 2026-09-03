// One targeting vocabulary for two lanes.
//
// The problem this solves is measured, not theoretical. `--osm-groups` reaches
// only the OSM lane and only at the grain of a whole catalogue group;
// `--section`/`--activity` reach only the register lane. So "I want cafés" had
// no expression: `--osm-groups amenity` returns schools, banks and EV chargers
// alongside the five cafés, and `--section I` narrows the register while
// leaving OSM sweeping the whole town. One intent, two half-filters, and the
// mismatch is invisible in the output.
//
// The fix is not a preset catalogue of verticals — those go stale, privilege
// whichever markets the author knew, and turn one person's curation into what
// looks like a measurement. It is a GRAMMAR, and it deliberately reuses the
// namespacing `place.category` already prints:
//
//   amenity=cafe      an OSM tag          ->  OSM lane
//   shop              a whole OSM key     ->  OSM lane
//   naf=56.30Z        a register code     ->  register lane
//   nace=I            a register section  ->  register lane
//
// So the vocabulary you type is the vocabulary the run prints back at you, and
// there is nothing extra to learn or to keep up to date.

import { NACE_SECTIONS } from "./classification/nace.js";
import { CONNECTORS } from "./registry/index.js";
import type { RegistryConnector, RegistryFilters } from "./registry/types.js";

/**
 * The scheme prefixes that mean "this is a register code", not an OSM key.
 *
 * Read off the connectors, which each DECLARE their own `activityPrefix` —
 * `naf` in France, `sic-uk` in the UK, `pkd` in Poland, `tol` in Finland. A
 * hardcoded list here was wrong the moment it was written: it guessed `sic`
 * where the UK connector actually emits `sic-uk`, so `--category sic-uk=56302`
 * — the exact string `places.json` prints back — was parsed as an OSM key and
 * silently aimed at Overpass.
 *
 * Deriving it is what makes the round-trip claim true rather than aspirational,
 * and it stays true as connectors are added.
 *
 * `nace` rides along because it is the one CROSS-country vocabulary: sections
 * A-U mean the same thing in every European register, and no single connector
 * owns the prefix.
 *
 * Connectors declaring `activityScheme: "none"` are EXCLUDED. They have no
 * activity vocabulary, so their prefix names no code anyone could filter on —
 * and `vat` and `lei` are plausible OSM keys, which a blanket list would have
 * quietly stolen from the OSM half of the grammar.
 */
const REGISTER_SCHEMES = new Set<string>([...CONNECTORS.filter((c) => c.activityScheme !== "none").map((c) => c.activityPrefix.toLowerCase()), "nace"]);

/**
 * What an OSM key or value may contain.
 *
 * These strings are interpolated into an Overpass query, so the charset is a
 * whitelist rather than an escape: OSM keys and values are drawn from
 * `[a-z0-9_:.-]` in practice, and anything else is far likelier to be a typo —
 * or a quote someone is trying to break the query with — than a real tag.
 */
const SAFE_OSM_TOKEN = /^[A-Za-z0-9_:.-]+$/;

export interface CategorySelection {
  /** Compiled Overpass tag filters, one per key, ready for `extraFilters`. */
  osmFilters: string[];
  /** The OSM terms as typed, for the manifest. */
  osmTerms: string[];
  /** Register activity codes, scheme stripped. */
  activityCodes: string[];
  /** Register section letters, scheme stripped. */
  sections: string[];
  /** Terms that are not valid in any vocabulary, as typed. */
  unknown: string[];
}

export interface CategoryParse extends CategorySelection {
  /** True when at least one term aimed at the OSM lane. */
  targetsOsm: boolean;
  /** True when at least one term aimed at the register lane. */
  targetsRegistry: boolean;
}

/**
 * Compile one key's values into a single Overpass filter.
 *
 * Values are collapsed into one alternation rather than emitted as one
 * sub-query each: Overpass charges per statement, so `amenity=cafe` plus
 * `amenity=restaurant` as two `nwr` lines is two passes over the same area for
 * no benefit.
 *
 * An empty value set means the key itself was asked for — `shop` and `shop=*`
 * both mean "every shop".
 */
export function compileOsmFilter(key: string, values: readonly string[]): string {
  if (!values.length) return `["${key}"]`;
  // One value is an EXACT match, which needs no regex and cannot mis-match.
  if (values.length === 1) return `["${key}"="${values[0]}"]`;
  // Several values become an alternation, and there the charset bites: `.` is
  // legal in an OSM value and is a wildcard in a regex, so an unescaped
  // `a.b` would also match `aXb`. Exactness is the whole promise of the flag.
  return `["${key}"~"^(${values.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$"]`;
}

/**
 * Parse a `--category` list into the two lanes' own vocabularies.
 *
 * Never throws and never guesses: a term it cannot place comes back in
 * `unknown` with its original spelling, so the caller can report it and still
 * honour the terms that were valid. That is the same discipline
 * `partitionSections` already applies to `--section`.
 */
export function parseCategories(specs: readonly string[]): CategoryParse {
  const byKey = new Map<string, Set<string>>();
  const bareKeys = new Set<string>();
  const osmTerms: string[] = [];
  const activityCodes: string[] = [];
  const sections: string[] = [];
  const unknown: string[] = [];

  for (const raw of specs) {
    const spec = raw.trim();
    if (!spec) continue;

    const at = spec.indexOf("=");
    const key = (at < 0 ? spec : spec.slice(0, at)).trim();
    const value = at < 0 ? "" : spec.slice(at + 1).trim();

    if (REGISTER_SCHEMES.has(key.toLowerCase())) {
      const code = value.toUpperCase();
      if (!code) {
        unknown.push(raw);
        continue;
      }
      // A bare section letter and a full activity code go to different
      // parameters of the same connector call, and only the vocabulary can say
      // which is which. NACE sections are single letters; every real activity
      // code is longer.
      if (code.length === 1 && NACE_SECTIONS.includes(code)) sections.push(code);
      else activityCodes.push(code);
      continue;
    }

    if (!SAFE_OSM_TOKEN.test(key) || (value && value !== "*" && !SAFE_OSM_TOKEN.test(value))) {
      unknown.push(raw);
      continue;
    }

    osmTerms.push(spec);
    const set = byKey.get(key) ?? new Set<string>();
    // `*` is the explicit spelling of "the whole key". Recording it as a value
    // would compile to a literal `="*"` filter, which matches nothing.
    if (value && value !== "*") set.add(value);
    else bareKeys.add(key);
    byKey.set(key, set);
  }

  const osmFilters: string[] = [];
  for (const [key, values] of byKey) {
    // A key asked for both bare and with values means the whole key: the
    // broader ask wins, because narrowing it would silently drop the bare term.
    osmFilters.push(compileOsmFilter(key, bareKeys.has(key) ? [] : [...values].sort()));
  }

  return {
    osmFilters,
    osmTerms,
    activityCodes,
    sections,
    unknown,
    targetsOsm: osmFilters.length > 0,
    targetsRegistry: activityCodes.length > 0 || sections.length > 0,
  };
}

/** What the run knows about its lanes when the gate is applied. */
export interface LaneReality {
  /** The OSM lane will actually sweep. */
  osmWillRun: boolean;
  /**
   * A connector will sweep this territory AND will honour an activity filter.
   *
   * Both halves matter. Estonia's register enumerates but ignores
   * `sections`/`activityCodes` outright — its export carries no activity code —
   * so demanding a register term there asks for a filter the connector drops on
   * the floor, and the run reports a narrowed territory it never narrowed.
   */
  registryCanBeAimed: boolean;
  /** `--category-lane`, or "both" when unset. */
  aim: "osm" | "registry" | "both";
}

/**
 * Does this targeting leave a lane sweeping the whole territory?
 *
 * Returns the refusal to make, or undefined when the aim is coherent. Pure, and
 * separated from `runScan` so the matrix can be tested without five live
 * services in the loop — the gate has more cases than the run does.
 *
 * It reads the lanes that will ACTUALLY RUN, never the flags that were typed.
 * Two failures live in that difference:
 *
 *   * Everywhere but France, the UK and Estonia, no register can be enumerated
 *     at all. Demanding a register code there would refuse
 *     `--category amenity=cafe` in Germany and send the user hunting for a code
 *     that would never have reached a connector — the flag would be unusable in
 *     most of the world.
 *   * `--no-registry` already closes that lane, so requiring it to be aimed is
 *     asking for a filter on a lane that is not running.
 */
export function laneGateRefusal(category: CategoryParse, reality: LaneReality): string | undefined {
  const { aim, osmWillRun, registryCanBeAimed } = reality;

  // Naming a lane that is not running is a contradiction, not an excuse: the
  // run would sweep the OTHER lane wide open while reporting that the asymmetry
  // was intended.
  if (aim === "registry" && !registryCanBeAimed) {
    return "--category-lane registry names a lane this run cannot aim (no register here can be enumerated by activity, or --no-registry was given), so it excuses nothing and the OSM lane would sweep unfiltered. Drop it, or aim the lane that is actually running.";
  }
  if (aim === "osm" && !osmWillRun) {
    return "--category-lane osm names a lane this run will not sweep (--no-osm was given), so it excuses nothing and the register lane would sweep unfiltered. Drop it, or aim the lane that is actually running.";
  }

  const open: string[] = [];
  if (osmWillRun && (aim === "both" || aim === "osm") && !category.targetsOsm) open.push("osm");
  if (registryCanBeAimed && (aim === "both" || aim === "registry") && !category.targetsRegistry) open.push("registry");
  if (!open.length) return undefined;

  const bothOpen = open.length > 1;
  const hint = bothOpen
    ? "add an OSM tag (amenity=cafe) and a register code (naf=56.30Z)"
    : open[0] === "osm"
      ? "add an OSM tag such as amenity=cafe, or --no-osm"
      : "add a register code such as naf=56.30Z or nace=I, or --no-registry";
  // `--category-lane` names the lane you DO mean to aim, not the one left open
  // — so the suggestion is the other lane. Naming the open one sends the user
  // round the same refusal a second time.
  const aimed = open[0] === "osm" ? "registry" : "osm";
  const excuse = bothOpen ? "" : `, or say the asymmetry is deliberate with --category-lane ${aimed}`;
  return `--category left the ${open.join(" and ")} lane sweeping the whole territory unfiltered, which is the mismatch --category exists to prevent. Either ${hint}${excuse}.`;
}

/** Refuse legal-form filters that a territory's sweep connector would ignore. */
export function legalFormGateRefusal(
  filters: Pick<RegistryFilters, "legalForms" | "excludeLegalForms">,
  connector: Pick<RegistryConnector, "id" | "sweep" | "sweepFiltersLegalForm"> | undefined,
): string | undefined {
  if (!filters.legalForms?.length && !filters.excludeLegalForms?.length) return undefined;
  if (!connector?.sweep || connector.sweepFiltersLegalForm) return undefined;
  return `${connector.id} enumerates this territory but cannot narrow a sweep by legal form, so --legal-form / --exclude-legal-form would be accepted and ignored. Drop those filters or choose a connector that declares legal-form filtering.`;
}

/** Refuse size filters that a territory's sweep connector would ignore. */
export function sizeGateRefusal(
  filters: Pick<RegistryFilters, "sizeBands"> & { minEmployees?: number },
  connector: Pick<RegistryConnector, "id" | "sweep" | "sweepFiltersSize"> | undefined,
): string | undefined {
  if (!filters.sizeBands?.length && filters.minEmployees === undefined) return undefined;
  if (!connector?.sweep || connector.sweepFiltersSize) return undefined;
  return `${connector.id} enumerates this territory but cannot narrow a sweep by company size, so --min-employees / --size-band would be accepted and ignored. Drop those filters or choose a connector that declares size filtering.`;
}
