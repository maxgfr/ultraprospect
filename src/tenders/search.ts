// Ask every source that serves the query, keep what each said, account for the rest.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeArtifact } from "../engine.js";
import { dedupeTenders, type DuplicatePair } from "./dedupe.js";
import type { SearchOutcome, Tender, TenderConnector, TenderLane, TenderQuery } from "./types.js";

export interface TenderSearchResult {
  tenders: Tender[];
  lanes: TenderLane[];
  raw: Record<string, SearchOutcome>;
  merged: { kept: string; dropped: string; key: string }[];
  pairs: DuplicatePair[];
  notes: string[];
  found: number;
}

export interface SearchRunOptions {
  /** Replay `raw/<connector>.json` from this directory instead of calling the sources. */
  fixture?: string;
  onProgress?: (line: string) => void;
}

function laneOf(c: TenderConnector, q: TenderQuery, out: SearchOutcome | undefined, error?: string): TenderLane {
  return {
    lane: "tenders",
    connectorId: c.id,
    coverage: c.coverage,
    kinds: c.kinds.filter((k) => q.kinds.includes(k)),
    requested: q.limit,
    returned: out?.tenders.length ?? 0,
    truncated: error ? true : (out?.truncated ?? false),
    reason: error ?? out?.reason,
    total: out?.total,
  };
}

export async function runTenderSearch(q: TenderQuery, connectors: readonly TenderConnector[], opts: SearchRunOptions = {}): Promise<TenderSearchResult> {
  const raw: Record<string, SearchOutcome> = {};
  const lanes: TenderLane[] = [];
  const notes: string[] = [];
  for (const c of connectors) {
    const askable = c.kinds.some((k) => q.kinds.includes(k));
    if (!askable) continue;
    const avail = c.availability();
    if (!avail.available) {
      lanes.push({ ...laneOf(c, q, undefined), truncated: true, reason: `not run: ${avail.reason}` });
      notes.push(`${c.id}: ${avail.reason}`);
      continue;
    }
    let out: SearchOutcome | undefined;
    let error: string | undefined;
    try {
      if (opts.fixture) {
        const file = join(opts.fixture, "raw", `${c.id}.json`);
        out = existsSync(file)
          ? (JSON.parse(readFileSync(file, "utf8")) as SearchOutcome)
          : { tenders: [], truncated: false, notes: [`${c.id}: no fixture recorded`] };
      } else {
        opts.onProgress?.(`  ${c.id}: asking…`);
        out = await c.search(q);
      }
    } catch (e) {
      error = `${c.id} failed: ${(e as Error).message}`;
    }
    if (out) raw[c.id] = out;
    for (const n of out?.notes ?? []) notes.push(n);
    const lane = laneOf(c, q, out, error);
    lanes.push(lane);
    opts.onProgress?.(`  ${c.id}: ${out?.tenders.length ?? 0} notice(s)${lane.truncated ? ` — PARTIAL: ${lane.reason}` : ""}`);
  }
  const all = Object.values(raw).flatMap((r) => r.tenders);
  const d = dedupeTenders(all);
  if (d.merged.length)
    notes.push(`${d.merged.length} notice(s) were the same procedure published twice (shared eForms procedure id); the national copy was kept.`);
  if (d.pairs.length) notes.push(`${d.pairs.length} look-alike pair(s) share no id: listed in TENDERS.todo.json, not merged.`);
  return { tenders: d.tenders, lanes, raw, merged: d.merged, pairs: d.pairs, notes, found: all.length };
}

/** Write the raw lanes as a replayable fixture. */
export function recordFixture(dir: string, raw: Record<string, SearchOutcome>, query: TenderQuery): void {
  mkdirSync(join(dir, "raw"), { recursive: true });
  for (const [id, out] of Object.entries(raw)) writeArtifact(join(dir, "raw", `${id}.json`), JSON.stringify(out, null, 2) + "\n");
  writeArtifact(join(dir, "query.json"), JSON.stringify(query, null, 2) + "\n");
}
