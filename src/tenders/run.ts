// A tenders run on disk.
//
//   <out>/runs/tenders-<slug>-<id>/
//     manifest.json        kind "tenders": the query, one lane per source, gaps
//     tenders.json         every notice kept, de-duplicated — the run's one source of truth
//     raw/<connector>.json what each source returned, before de-duplication
//     TENDERS.todo.json    the qualification worklist, plus look-alike pairs
//     WEB.todo.json        the web lane's queries, for countries with no API
//     pages/<tender>/P#.md the notice and its documents, cited as [P#]
//     bids/<tender>/RESPONSE.md, COMPLIANCE.md   the agent's draft
//     profile.json         the bidder's profile, copied in so the gate can re-read it
//     awards.json, AWARDS.md   from `awards`
//
// Same root as territory runs on purpose: `--run .ultraprospect` keeps working,
// and the newest run of the right KIND is taken.
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { readJsonSafe, readManifest, runId, slugify, writeArtifact } from "../engine.js";
import { emptyManifest } from "../run.js";
import type { RunManifest } from "../types.js";
import { tenderConnectorById } from "./index.js";
import type { Tender, TenderLane } from "./types.js";

export interface TenderManifest extends RunManifest {
  kind: "tenders";
  query: Record<string, unknown>;
  tenderCounts: {
    found: number;
    kept: number;
    mergedDuplicates: number;
    pairs: number;
    open: number;
    awards: number;
    web: number;
    withPages: number;
    judged: number;
    bids: number;
  };
  /** Countries whose national market this run could not see, by name. */
  gaps: { country: string; coverage: string }[];
}

export function isTenderManifest(m: RunManifest | undefined): m is TenderManifest {
  return (m as TenderManifest | undefined)?.kind === "tenders";
}

export function newTenderRun(outRoot: string, label: string): { dir: string; slug: string } {
  const slug = slugify(`tenders-${label}`).slice(0, 60) || "tenders";
  const dir = join(resolve(outRoot), "runs", `${slug}-${runId()}`);
  return { dir, slug };
}

export function emptyTenderManifest(label: string, query: Record<string, unknown>): TenderManifest {
  const base = emptyManifest(label);
  return {
    ...base,
    slug: label,
    kind: "tenders",
    query,
    licences: [],
    tenderCounts: { found: 0, kept: 0, mergedDuplicates: 0, pairs: 0, open: 0, awards: 0, web: 0, withPages: 0, judged: 0, bids: 0 },
    gaps: [],
  };
}

/**
 * `--run` for a tender command: the directory itself, or the newest TENDERS run
 * under a root. A territory run handed to a tender command is refused by name.
 */
export function resolveTenderRun(pathOrRoot: string): string {
  const p = resolve(pathOrRoot);
  if (existsSync(join(p, "manifest.json"))) {
    if (!isTenderManifest(readManifest<RunManifest>(p)))
      throw new Error(`${p} is a territory run, not a tenders run — start one with \`ultraprospect tenders\``);
    return p;
  }
  const runsDir = existsSync(join(p, "runs")) ? join(p, "runs") : p;
  if (!existsSync(runsDir)) throw new Error(`no run directory at ${p}`);
  // Newest by the manifest's own build time: the directory name leads with a
  // slug, so sorting names would pick by alphabet, not by age.
  const candidates = readdirSync(runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, m: readManifest<RunManifest>(join(runsDir, e.name)) }))
    .filter((c) => isTenderManifest(c.m))
    .sort((a, b) => String(a.m!.builtAt).localeCompare(String(b.m!.builtAt)) || a.name.localeCompare(b.name));
  const newest = candidates.at(-1);
  if (!newest) throw new Error(`no tenders run under ${runsDir} — start one with \`ultraprospect tenders\``);
  return join(runsDir, newest.name);
}

export function requireTenderManifest(runDir: string): TenderManifest {
  const m = readManifest<RunManifest>(runDir);
  if (!isTenderManifest(m)) throw new Error(`${join(runDir, "manifest.json")} is missing or not a tenders run`);
  return m;
}

export function readTenders(runDir: string): Tender[] {
  const t = readJsonSafe(join(runDir, "tenders.json")) as Tender[] | undefined;
  if (!t) throw new Error(`${join(runDir, "tenders.json")} is missing — run \`ultraprospect tenders\` first`);
  return t;
}

export function writeTenders(runDir: string, tenders: readonly Tender[]): void {
  writeArtifact(join(runDir, "tenders.json"), JSON.stringify(tenders, null, 2) + "\n");
}

/** Attributions owed: only for sources that actually returned something. */
export function tenderLicences(lanes: readonly TenderLane[]): string[] {
  const out: string[] = [];
  for (const lane of lanes) {
    if (lane.returned <= 0 || !lane.connectorId) continue;
    const licence =
      lane.connectorId === "web"
        ? "Web lane: notices read from their publishers' own pages; each [P#] names its URL"
        : tenderConnectorById(lane.connectorId)?.licence;
    if (licence && !out.includes(licence)) out.push(licence);
  }
  return out;
}

export function recount(manifest: TenderManifest, tenders: readonly Tender[]): void {
  const c = manifest.tenderCounts;
  c.kept = tenders.length;
  c.open = tenders.filter((t) => t.kind === "call" && t.status === "open").length;
  c.awards = tenders.filter((t) => t.kind === "award").length;
  c.web = tenders.filter((t) => t.web).length;
  c.withPages = tenders.filter((t) => (t.pages?.length ?? 0) > 0).length;
  c.judged = tenders.filter((t) => t.verdict).length;
  manifest.counts.places = tenders.length;
}
