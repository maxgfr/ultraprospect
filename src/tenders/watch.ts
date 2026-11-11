// Veille: what changed between two tenders runs over the same query.
//
// Compares runs on disk and never re-fetches, like the territory `watch`.
// Keyed on the notice id, the ids of the copies merged into it, and its eForms
// procedure UUIDs, so a notice that moved from the TED copy to the national
// copy between runs is not reported as new. NOT on a raw publication number:
// TED's "722908-2026" and Find a Tender's "103248-2026" share a shape and name
// different notices (see dedupe.ts), and keying on them let a new Find a
// Tender notice match last run's TED notice and be reported "changed".
import { mdInline as md } from "../markdown.js";
import { procedureUuids } from "./dedupe.js";
import type { TenderManifest } from "./run.js";
import type { Tender } from "./types.js";
import { dayOf } from "./util.js";

function watchKeys(t: Tender): string[] {
  const merged = Array.isArray(t.national?.alsoPublishedAs) ? (t.national.alsoPublishedAs as unknown[]).map(String) : [];
  return [t.id, ...merged, ...procedureUuids(t)];
}

export interface TenderDelta {
  appeared: Tender[];
  /** Calls whose deadline moved, or whose status changed (cancelled, awarded). */
  changed: { before: Tender; after: Tender; what: string[] }[];
  /** Open calls whose deadline falls within `soonDays`. */
  closingSoon: Tender[];
  /** Notices in the earlier run that this one did not return. Not "withdrawn": not returned. */
  notReturned: Tender[];
}

export function diffTenderRuns(before: readonly Tender[], after: readonly Tender[], opts: { soonDays?: number; now?: Date } = {}): TenderDelta {
  const now = opts.now ?? new Date();
  const soon = new Date(now.getTime() + (opts.soonDays ?? 14) * 86_400_000).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  const index = new Map<string, Tender>();
  for (const t of before) for (const k of watchKeys(t)) index.set(k, t);
  const matched = new Set<string>();
  const delta: TenderDelta = { appeared: [], changed: [], closingSoon: [], notReturned: [] };
  for (const t of after) {
    const prev = watchKeys(t)
      .map((k) => index.get(k))
      .find(Boolean);
    if (!prev) delta.appeared.push(t);
    else {
      matched.add(prev.id);
      const what: string[] = [];
      if (dayOf(prev.deadline) !== dayOf(t.deadline)) what.push(`deadline ${prev.deadline ?? "none"} → ${t.deadline ?? "none"}`);
      if (prev.status !== t.status) what.push(`status ${prev.status} → ${t.status}`);
      if (what.length) delta.changed.push({ before: prev, after: t, what });
    }
    const d = dayOf(t.deadline);
    if (t.kind === "call" && d && d >= today && d <= soon) delta.closingSoon.push(t);
  }
  for (const t of before) if (!matched.has(t.id)) delta.notReturned.push(t);
  delta.closingSoon.sort((a, b) => String(a.deadline).localeCompare(String(b.deadline)));
  return delta;
}

export function tenderDeltaMarkdown(d: TenderDelta, before: TenderManifest, after: TenderManifest): string {
  const line = (t: Tender) =>
    `- ${t.deadline ? `**${md(t.deadline)}** · ` : ""}${md(t.title)} — ${md(t.buyer.name || "?")} (${md(t.connectorId)})${t.sourceUrl ? ` ${md(t.sourceUrl)}` : ""}`;
  const out = [`# Tenders watch — ${md(after.slug)}`, "", `Between ${before.builtAt} and ${after.builtAt}.`, ""];
  if (before.truncated || after.truncated) out.push("> ⚠ One of the two runs is TRUNCATED: a notice missing from it may simply not have been read.", "");
  out.push(`## New (${d.appeared.length})`, "", ...d.appeared.map(line), "");
  out.push(`## Closing within two weeks (${d.closingSoon.length})`, "", ...d.closingSoon.map(line), "");
  out.push(`## Changed (${d.changed.length})`, "", ...d.changed.map((c) => `${line(c.after)} — ${md(c.what.join("; "))}`), "");
  out.push(
    `## Not returned this time (${d.notReturned.length})`,
    "",
    "Not returned is not withdrawn: a query window that moved, or a source that stopped short, drops notices too.",
    "",
    ...d.notReturned.slice(0, 100).map(line),
    "",
  );
  return out.join("\n");
}
