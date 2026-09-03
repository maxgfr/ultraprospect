// Which rows are not worth a search, and why — each answer citable.
//
// `resolve` costs one web search per place, and the search is the scarcest
// thing in the pipeline: it is the step the agent runs by hand, and every other
// stage grows from its result. On the reference sweep of a 20 000-person town,
// 295 places produced 295 searches — and roughly a fifth of them could never
// have produced a prospect:
//
//   42  carry a `brand` / `brand:wikidata`  (Franprix, LCL, BNP Paribas, CIC…)
//   24  have no name at all — the row is literally `amenity=restaurant`
//    9  carry `operator:type=public`        (écoles, a collège, a crèche)
//    6  are `shop=vacant` or `disused:*`
//
// 76 distinct rows of 420, five of them under two reasons at once: 104 searches
// that were never going to find a prospect.
//
// The rule these follow is what makes them safe: EVERY TEST BELOW READS A FIELD
// SOMEBODY ASSERTED. None of them guesses from a name, and none encodes an
// opinion about an industry. `brand:wikidata` on a Franprix is a mapper saying
// "this is an outlet of that chain"; a legal form is what the legal unit filed,
// interpreted only by its own connector. So a skip is always explainable in one
// sentence that points at the data.
//
// And nothing here deletes: skipping is a decision about where to spend
// searches, recorded per row and reversible, never a row removed from
// `places.json`.

import type { Place } from "./types.js";
import { connectorById } from "./registry/index.js";

/** The reasons a place can be skipped. Each maps to an asserted source field. */
export const SKIP_REASONS = ["chain", "unnamed", "public", "vacant"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export const SKIP_REASON_LABELS: Record<SkipReason, string> = {
  chain: "an outlet of a brand the mapper named (`brand` / `brand:wikidata`)",
  unnamed: "no name on the row — nothing to search for",
  public: "a public body (`operator:type=public|government` or a filed public legal form)",
  vacant: "an empty or disused unit (`shop=vacant`, `disused:*`, `abandoned:*`)",
};

const PUBLIC_OPERATORS = new Set(["public", "government"]);

/**
 * Has this place no name of its own?
 *
 * `placeFromPoi` falls back to the category and then to the raw OSM id when a
 * node carries no `name`, so an unnamed row reads as `"amenity=restaurant"` or
 * `"n248494308"`. Both are unsearchable — a query for "amenity=restaurant"
 * finds the OSM wiki — and neither is a business anybody can be sold to.
 */
function isUnnamed(place: Place): boolean {
  // A fused row can carry no OSM name and still be perfectly searchable,
  // because `queriesFor` also searches the names the REGISTER knows it by —
  // and, where there is one, its registration number, which is the
  // highest-precision query in the whole lane. Judging on the synthesised
  // display name alone would skip exactly the rows the register just enriched.
  if (place.registry?.legalName?.trim() || place.registry?.tradingNames?.some((n) => n.trim())) return false;
  if (place.registry?.id || place.registry?.establishmentId) return false;

  const name = place.name?.trim();
  if (!name) return true;
  if (place.category && name === place.category) return true;
  return Boolean(place.osm) && name === place.osm?.id;
}

/**
 * Every reason this place would be skipped, in the order they are reported.
 *
 * Returns all of them rather than the first: a row can be both a chain and
 * unnamed, and a count that attributed it to only one reason would not add up
 * against the ones the user can see in the data.
 */
export function skipReasonsFor(place: Place): SkipReason[] {
  const reasons: SkipReason[] = [];
  const tags = place.osm?.tags ?? {};

  // `brand` is the chain assertion. `operator:wikidata` is NOT: it identifies
  // whoever runs the place, which for a museum, a clinic or a one-site company
  // is the business itself — skipping on it drops exactly the independent
  // operators this flag exists to keep.
  if (tags.brand || tags["brand:wikidata"]) reasons.push("chain");
  if (isUnnamed(place)) reasons.push("unnamed");

  const operatorType = tags["operator:type"]?.toLowerCase();
  const registry = place.registry;
  const filedPublic = Boolean(registry?.legalForm && connectorById(registry.connectorId)?.legalFormIsPublic?.(registry.legalForm));
  if ((operatorType && PUBLIC_OPERATORS.has(operatorType)) || filedPublic) reasons.push("public");

  const vacant =
    tags.shop === "vacant" ||
    tags.office === "vacant" ||
    tags.disused === "yes" ||
    // `disused:` and `abandoned:` prefix a feature that is GONE. `was:` does
    // not: a restaurant that used to be a bakery keeps `was:shop=bakery` while
    // trading perfectly well, so counting it as vacant skips a live business.
    Object.keys(tags).some((k) => k.startsWith("disused:") || k.startsWith("abandoned:"));
  if (vacant) reasons.push("vacant");

  return reasons;
}

export interface SkipOutcome {
  /** The places that survived. */
  kept: Place[];
  /** Place id -> the reasons it was skipped, for the todo file. */
  skipped: Map<string, SkipReason[]>;
  /** How many places each reason accounted for. A place can appear under several. */
  counts: Record<string, number>;
}

/**
 * Partition places by the skip reasons the caller asked for.
 *
 * An unknown reason is ignored here rather than thrown on — the CLI validates
 * the list and reports the typo, and this function's job is the partition.
 */
export function partitionSkipped(places: readonly Place[], reasons: readonly string[]): SkipOutcome {
  const wanted = new Set(reasons);
  const kept: Place[] = [];
  const skipped = new Map<string, SkipReason[]>();
  const counts: Record<string, number> = {};

  for (const place of places) {
    const hits = skipReasonsFor(place).filter((r) => wanted.has(r));
    if (!hits.length) {
      kept.push(place);
      continue;
    }
    skipped.set(place.id, hits);
    for (const r of hits) counts[r] = (counts[r] ?? 0) + 1;
  }

  return { kept, skipped, counts };
}

/**
 * One line the run can print and the report can quote.
 *
 * `limited` says a `--limit` was in force. It changes what the number MEANS:
 * without a limit the skipped rows are searches not run, but a limit takes a
 * prefix of whatever survives, so skipping refills the window from further down
 * the list instead of shortening it. Same count, opposite consequence, and only
 * the caller knows which applies.
 */
export function describeSkips(outcome: SkipOutcome, limited = false): string | undefined {
  const total = outcome.skipped.size;
  if (!total) return undefined;
  if (limited) {
    const parts = SKIP_REASONS.filter((r) => outcome.counts[r]).map((r) => `${outcome.counts[r]} ${r}`);
    return `passed over ${total} place(s) — ${parts.join(", ")}. --limit still takes its full count, so these were replaced rather than saved.`;
  }
  const parts = SKIP_REASONS.filter((r) => outcome.counts[r]).map((r) => `${outcome.counts[r]} ${r}`);
  // The per-reason counts can sum to more than the total, because a row can be
  // both a chain and unnamed. Saying so is the difference between a reader
  // reconciling the line and a reader deciding one of the numbers is wrong.
  const sum = SKIP_REASONS.reduce((n, r) => n + (outcome.counts[r] ?? 0), 0);
  const overlap = sum > total ? ` (${sum - total} counted under more than one reason)` : "";
  return `skipped ${total} place(s) before searching — ${parts.join(", ")}${overlap}`;
}
