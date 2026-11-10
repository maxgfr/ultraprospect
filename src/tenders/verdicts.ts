// The qualification worklist, and folding the agent's answers back.
import type { DuplicatePair } from "./dedupe.js";
import { qualifySummary } from "./bid.js";
import type { BidDecision, Tender, TenderFit, TenderVerdict } from "./types.js";
import { deadlinePassed } from "./util.js";

export interface TendersTodo {
  version: 1;
  generatedAt: string;
  /** What the qualifier judges each notice against. */
  profilePath?: string;
  items: Record<string, unknown>[];
  /** Look-alikes across sources that share no id. Answer with {pair:[a,b], same}. */
  pairs: DuplicatePair[];
}

export function buildTendersTodo(tenders: readonly Tender[], pairs: readonly DuplicatePair[], profilePath?: string): TendersTodo {
  // Only notices someone can still act on: open calls, and calls whose status
  // is unknown (a web lead with no labelled deadline). History is for `awards`.
  const items = tenders
    .filter((t) => t.kind === "call" && t.status !== "closed" && t.status !== "cancelled" && !t.verdict)
    .sort((a, b) => String(a.deadline ?? "9999").localeCompare(String(b.deadline ?? "9999")))
    .map(qualifySummary);
  return { version: 1, generatedAt: new Date().toISOString(), profilePath, items, pairs: [...pairs] };
}

const DECISIONS: readonly BidDecision[] = ["go", "maybe", "no-go"];
const FITS: readonly TenderFit[] = ["strong", "possible", "weak", "no"];

export interface PairVerdict {
  pair: [string, string];
  same: boolean;
  why?: string;
}

export interface ApplyOutcome {
  applied: number;
  merged: number;
  unknown: string[];
  invalid: string[];
  /** go verdicts on notices whose deadline has passed — refused. */
  expired: string[];
}

/**
 * Fold verdicts in. Strict on shape, because a silently dropped verdict reads
 * later as a notice nobody judged: every id must exist, every decision and fit
 * must be one of the words, and a "go" on a closed call is refused by name.
 */
export function applyTenderVerdicts(tenders: Tender[], input: unknown, now = new Date()): { tenders: Tender[]; outcome: ApplyOutcome } {
  const list: unknown[] = Array.isArray(input) ? input : Array.isArray((input as any)?.verdicts) ? (input as any).verdicts : [];
  const byId = new Map(tenders.map((t) => [t.id, t]));
  const outcome: ApplyOutcome = { applied: 0, merged: 0, unknown: [], invalid: [], expired: [] };
  const drop = new Set<string>();
  for (const raw of list) {
    const v = raw as Partial<TenderVerdict> & Partial<PairVerdict>;
    if (Array.isArray(v.pair)) {
      const [a, b] = v.pair;
      if (!a || !b || !byId.has(a) || !byId.has(b)) {
        outcome.unknown.push(`${a}|${b}`);
        continue;
      }
      // A pair names two notices that are both still in the run. `[x, x]` used
      // to "merge" a notice into itself and then drop it, and `[a, b]` followed
      // by `[b, a]` dropped both — each time a call for tenders removed from
      // the run by a line that looked like housekeeping.
      if (a === b || drop.has(a) || drop.has(b)) {
        outcome.invalid.push(`${a}|${b}: ${a === b ? "a notice cannot be paired with itself" : "one of the two was already merged away by an earlier pair"}`);
        continue;
      }
      if (v.same === true) {
        const keep = byId.get(a)!;
        const gone = byId.get(b)!;
        keep.aliases = [...new Set([...keep.aliases, ...gone.aliases, gone.id])];
        keep.national = { ...keep.national, alsoPublishedAs: [...((keep.national?.alsoPublishedAs as string[]) ?? []), gone.id], mergedBecause: v.why };
        drop.add(b);
        outcome.merged += 1;
      }
      continue;
    }
    if (!v.id || !byId.has(v.id)) {
      outcome.unknown.push(String(v.id));
      continue;
    }
    if (!DECISIONS.includes(v.decision as BidDecision) || !FITS.includes(v.fit as TenderFit) || typeof v.why !== "string" || !v.why.trim()) {
      outcome.invalid.push(v.id);
      continue;
    }
    const t = byId.get(v.id)!;
    if (v.decision === "go" && deadlinePassed(t.deadline, now)) {
      outcome.expired.push(v.id);
      continue;
    }
    t.verdict = {
      id: v.id,
      decision: v.decision as BidDecision,
      fit: v.fit as TenderFit,
      why: v.why.trim(),
      blockers: Array.isArray(v.blockers) ? v.blockers.map(String) : undefined,
      cites: Array.isArray(v.cites) ? v.cites.map(String) : undefined,
      at: now.toISOString(),
    };
    outcome.applied += 1;
  }
  return { tenders: tenders.filter((t) => !drop.has(t.id)), outcome };
}

const FIT_RANK: Record<TenderFit, number> = { strong: 0, possible: 1, weak: 2, no: 3 };
const DECISION_RANK: Record<BidDecision, number> = { go: 0, maybe: 1, "no-go": 2 };

/** Order for the report: judged go first, then by deadline, history last. */
export function rankTenders(tenders: readonly Tender[]): Tender[] {
  return [...tenders].sort((a, b) => {
    const ka = a.kind === "call" ? 0 : 1;
    const kb = b.kind === "call" ? 0 : 1;
    if (ka !== kb) return ka - kb;
    const da = a.verdict ? DECISION_RANK[a.verdict.decision] : 1.5;
    const db = b.verdict ? DECISION_RANK[b.verdict.decision] : 1.5;
    if (da !== db) return da - db;
    const fa = a.verdict ? FIT_RANK[a.verdict.fit] : 1.5;
    const fb = b.verdict ? FIT_RANK[b.verdict.fit] : 1.5;
    if (fa !== fb) return fa - fb;
    return String(a.deadline ?? "9999").localeCompare(String(b.deadline ?? "9999"));
  });
}
