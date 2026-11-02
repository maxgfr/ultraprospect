// One contract, several notices: telling copies apart from neighbours.
//
// Above the EU thresholds a French procedure is published on TED AND on
// BOAMP; a German one on TED AND on the Bekanntmachungsservice. Listing both
// doubles the pipeline and halves the reader's trust in it.
//
// The join is EXACT where it can be. Measured: TED's `procedure-identifier`,
// BOAMP's `contractfolderid` and the German export's `tender.id` are the same
// eForms ContractFolderID — a UUID — so two notices sharing one are one
// procedure, and the national copy is kept (it comes first in connector order,
// in the buyer's language, with national identifiers).
//
// Only UUIDs join. Publication numbers do not: TED's "722908-2026" and Find a
// Tender's "103248-2026" have the same shape and mean different things.
//
// Where no UUID is shared, the same rule as the register matcher applies:
// similarity can PROPOSE a pair but never merge one. Same buyer, near-identical
// title and the same deadline day go to `TENDERS.todo.json` for the agent.
import { nameSimilarity } from "../util.js";
import type { Tender } from "./types.js";
import { dayOf, statusFromDeadline } from "./util.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DuplicatePair {
  keep: string;
  drop: string;
  score: number;
  why: string;
}

export interface DedupeOutcome {
  tenders: Tender[];
  /** Notices merged by an exact shared procedure id. */
  merged: { kept: string; dropped: string; key: string }[];
  /** Pairs that look alike but share no id: for the agent, never auto-merged. */
  pairs: DuplicatePair[];
}

function joinKeys(t: Tender): string[] {
  return t.aliases.filter((a) => UUID.test(a)).map((a) => `${t.kind}|${a.toLowerCase()}`);
}

export function dedupeTenders(input: readonly Tender[]): DedupeOutcome {
  const byKey = new Map<string, Tender>();
  const out: Tender[] = [];
  const merged: DedupeOutcome["merged"] = [];
  const seenIds = new Set<string>();
  for (const t of input) {
    if (seenIds.has(t.id)) continue;
    seenIds.add(t.id);
    const keys = joinKeys(t);
    const hit = keys.map((k) => byKey.get(k)).find(Boolean);
    if (hit && hit.connectorId !== t.connectorId) {
      // Keep the first copy, but carry what only the other one had.
      hit.aliases = [...new Set([...hit.aliases, ...t.aliases, t.id])];
      if (!hit.cpv.length && t.cpv.length) hit.cpv = t.cpv;
      if (!hit.value && t.value) hit.value = t.value;
      if (!hit.deadline && t.deadline) {
        hit.deadline = t.deadline;
        hit.status = statusFromDeadline(hit.kind, hit.deadline);
      }
      if (!hit.documentsUrl && t.documentsUrl) hit.documentsUrl = t.documentsUrl;
      if (!hit.criteria.length && t.criteria.length) hit.criteria = t.criteria;
      if (!hit.places.length && t.places.length) hit.places = t.places;
      for (const a of t.awards) if (a.supplier.legalId && !hit.awards.some((x) => x.supplier.legalId === a.supplier.legalId)) hit.awards.push(a);
      // An award known only by name on one side gains an identifier from the other.
      for (const a of hit.awards) {
        if (a.supplier.legalId) continue;
        const twin = t.awards.find((x) => x.supplier.legalId && nameSimilarity(x.supplier.name, a.supplier.name) >= 0.85);
        if (twin)
          Object.assign(a, {
            supplier: { ...a.supplier, legalId: twin.supplier.legalId },
            durationMonths: a.durationMonths ?? twin.durationMonths,
            date: a.date ?? twin.date,
          });
      }
      hit.national = { ...hit.national, alsoPublishedAs: [...(((hit.national?.alsoPublishedAs as string[]) ?? []) as string[]), t.id] };
      merged.push({ kept: hit.id, dropped: t.id, key: keys.find((k) => byKey.get(k) === hit)!.split("|")[1]! });
      for (const k of keys) byKey.set(k, hit);
      continue;
    }
    for (const k of keys) byKey.set(k, t);
    out.push(t);
  }

  // Look-alikes across sources that share no id.
  const pairs: DuplicatePair[] = [];
  const calls = out.filter((t) => t.kind === "call");
  for (let i = 0; i < calls.length; i++) {
    for (let j = i + 1; j < calls.length; j++) {
      const a = calls[i]!;
      const b = calls[j]!;
      if (a.connectorId === b.connectorId || a.country !== b.country) continue;
      const da = dayOf(a.deadline);
      if (!da || da !== dayOf(b.deadline)) continue;
      const buyer = nameSimilarity(a.buyer.name, b.buyer.name);
      if (buyer < 0.6) continue;
      const title = nameSimilarity(a.title, b.title);
      const score = Math.round((0.5 * buyer + 0.5 * title) * 100) / 100;
      if (score >= 0.55)
        pairs.push({
          keep: a.id,
          drop: b.id,
          score,
          why: `same deadline ${da}; buyer ${Math.round(buyer * 100)}% alike, title ${Math.round(title * 100)}% alike; no shared procedure id`,
        });
    }
  }
  return { tenders: out, merged, pairs };
}
