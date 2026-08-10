// Ranking, in two halves that must not be confused.
//
// The engine's half is arithmetic over things it measured: does the site work,
// how recently was it touched, how many roles are open, how big is the company,
// what does the register say it does. Every term is a fact with a page or an
// open-data record behind it, and the weights are visible in `score.parts` so a
// ranking can be argued with rather than believed.
//
// The agent's half is FIT — whether this company is the one the user is looking
// for. That is not arithmetic. It reads the dossier, decides, and folds a
// verdict back in with `score --apply`. The engine will not attempt it, because
// a model asked to turn "agencies that are growing" into a number will produce
// one, and it will look exactly like a measurement.
//
// So: the engine gives counts, the agent gives verdicts, and the CSV carries
// both in separate columns.
import { EFFECTIF_FLOOR } from "./sirene.js";
import type { FitVerdict, Place, Score } from "./types.js";

/** How many days of silence before a site stops looking maintained. */
const FRESH_DAYS = 180;

export interface ScoreWeights {
  hasSite: number;
  siteWorks: number;
  fresh: number;
  depth: number;
  hiring: number;
  perRole: number;
  size: number;
  revenue: number;
  registered: number;
  contactable: number;
  ecommerce: number;
  pricing: number;
}

/**
 * Defaults tuned for cold prospecting rather than for market research.
 *
 * Hiring and freshness dominate because they answer the only question a
 * prospecting list is really asking: is this company spending money right now.
 * Size matters less than it looks — a fifty-person company with a dead website
 * is a worse prospect than a six-person one that just posted three roles.
 */
export const DEFAULT_WEIGHTS: ScoreWeights = {
  hasSite: 10,
  siteWorks: 5,
  fresh: 15,
  depth: 5,
  hiring: 15,
  perRole: 2,
  size: 12,
  revenue: 8,
  registered: 8,
  contactable: 10,
  ecommerce: 4,
  pricing: 4,
};

function daysSince(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  return (Date.now() - t) / 86_400_000;
}

/**
 * The measured half of the score.
 *
 * Deliberately NOT normalised to 100: the parts are additive and readable, and
 * a place missing a whole category should look thin rather than be rescaled
 * into looking average.
 */
export function scoreOf(place: Place, weights: ScoreWeights = DEFAULT_WEIGHTS): Score {
  const parts: Record<string, number> = {};
  const s = place.signals;

  if (place.website?.confidence === "corroborated") parts.hasSite = weights.hasSite;
  if (s?.siteReachable) parts.siteWorks = weights.siteWorks;

  const age = daysSince(s?.lastContentAt);
  // Absence of a lastmod is NOT staleness — plenty of generators omit it — so a
  // site with no date scores zero here rather than being penalised as dormant.
  if (age !== undefined && age <= FRESH_DAYS) parts.fresh = Math.round(weights.fresh * (1 - age / FRESH_DAYS));

  if (s?.pageCount) parts.depth = Math.min(weights.depth, s.pageCount);

  if (s?.isHiring) {
    parts.hiring = weights.hiring;
    parts.openRoles = Math.min(weights.perRole * 5, weights.perRole * (s.openRoles ?? 0));
  }

  const band = place.sirene?.effectifTranche;
  const floor = band ? EFFECTIF_FLOOR[band] : undefined;
  // -1 is the register's "undetermined". Unknown headcount scores nothing; it
  // does not score as zero employees.
  if (floor !== undefined && floor >= 0) {
    parts.size = Math.round(weights.size * Math.min(1, Math.log10(Math.max(1, floor) + 1) / 3));
  }

  const ca = place.sirene?.finances?.ca;
  if (typeof ca === "number" && ca > 0) parts.revenue = Math.round(weights.revenue * Math.min(1, Math.log10(ca) / 8));

  if (place.sirene?.siren) parts.registered = weights.registered;

  const contactable = place.contacts.emails.length > 0 || place.contacts.phones.length > 0;
  if (contactable) parts.contactable = weights.contactable;

  if (s?.hasEcommerce) parts.ecommerce = weights.ecommerce;
  if (s?.hasPricingPage) parts.pricing = weights.pricing;

  const total = Object.values(parts).reduce((n, v) => n + v, 0);
  return { total, parts, fit: place.score?.fit, why: place.score?.why, angle: place.score?.angle };
}

export function scoreAll(places: Place[], weights?: ScoreWeights): void {
  for (const place of places) place.score = scoreOf(place, weights);
}

export interface ApplyFitResult {
  applied: number;
  unknown: string[];
}

/**
 * Fold the agent's ICP verdicts onto the places.
 *
 * The verdict never changes `total` — the measured score stays measured, and
 * `fit` sits beside it. Overwriting the number with a judgement would destroy
 * the only column in the file that nobody had to be trusted for.
 */
export function applyFit(places: Place[], verdicts: readonly FitVerdict[]): ApplyFitResult {
  const byId = new Map(places.map((p) => [p.id, p]));
  const unknown: string[] = [];
  let applied = 0;
  for (const v of verdicts) {
    const place = byId.get(v.id);
    if (!place) {
      unknown.push(v.id);
      continue;
    }
    place.score = { ...(place.score ?? scoreOf(place)), fit: v.fit, why: v.why, angle: v.angle };
    applied++;
  }
  return { applied, unknown };
}

/**
 * Rank order: the agent's verdict first when there is one, then the measurement.
 *
 * An explicit `no` sits BELOW an unjudged place (-1), not above it. A company
 * somebody read and rejected should not outrank one nobody has looked at yet —
 * otherwise working through the list actively promotes the rejects, and the
 * highest-scoring rows become the ones already ruled out.
 */
const FIT_RANK: Record<string, number> = { strong: 3, possible: 2, weak: 1, no: -2 };
/** A place with no verdict yet: better than a rejection, worse than a maybe. */
const UNJUDGED = -1;

export function ranked(places: readonly Place[]): Place[] {
  return [...places].sort((a, b) => {
    const fa = a.score?.fit ? FIT_RANK[a.score.fit]! : UNJUDGED;
    const fb = b.score?.fit ? FIT_RANK[b.score.fit]! : UNJUDGED;
    if (fa !== fb) return fb - fa;
    return (b.score?.total ?? 0) - (a.score?.total ?? 0);
  });
}
