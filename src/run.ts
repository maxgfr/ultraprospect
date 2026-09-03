// The run directory: where a territory sweep lives on disk.
//
// Layout (everything relative to <out>/runs/<slug>-<id>/):
//
//   manifest.json     what was asked, what each lane returned, what was capped
//   osm.json          raw OSM lane output, never overwritten by later stages
//   registry.json     raw register lane output, likewise
//   places.json       the fused entities — the ONLY input the rest of the run reads
//   MATCH.todo.json   pairs the matcher refused to decide alone
//   pages/<slug>/     one markdown extract per fetched page, cited as [P#]
//   dossiers/<slug>.md  the agent's write-up
//
// Raw lane output is kept beside the fused result on purpose. When a match
// looks wrong six weeks later, the question is always "what did the upstream
// actually say", and re-running the sweep answers a different question because
// the upstreams have moved.
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { readJsonSafe, readManifest, runId, slugify, writeArtifact, writeManifest } from "./engine.js";
import { connectorById } from "./registry/index.js";
import { shortLabel } from "./util.js";
import type { LaneCoverage, Place, RunManifest } from "./types.js";
import { VERSION } from "./version.js";

/** Default root, relative to the working directory. Overridden by `--out`. */
export const DEFAULT_OUT = ".ultraprospect";

export interface RunPaths {
  root: string;
  dir: string;
  slug: string;
  id: string;
}

// `shortLabel` lives in util.ts — a pure string function, and one the register
// connectors need. Importing it from here made registry/index -> gb-companies-house
// -> run -> registry/index a cycle, which left CONNECTORS half-undefined at module
// init: every connector read as `undefined` and the table's own tests crashed
// before asserting anything. Re-exported so the existing call sites are unchanged.
export { shortLabel } from "./util.js";

export function newRun(outRoot: string, label: string): RunPaths {
  const slug = slugify(shortLabel(label)) || "run";
  const id = runId();
  const root = resolve(outRoot);
  const dir = join(root, "runs", `${slug}-${id}`);
  mkdirSync(dir, { recursive: true });
  return { root, dir, slug, id };
}

/**
 * Resolve `--run` to a run directory.
 *
 * Accepts the directory itself, or an `--out` root whose newest run is taken.
 * The convenience matters: every command after `scan` needs the run, and making
 * a human paste a timestamped path each time is how a wrong path gets pasted.
 */
export function resolveRun(pathOrRoot: string): string {
  const p = resolve(pathOrRoot);
  if (existsSync(join(p, "manifest.json"))) return p;
  const runsDir = existsSync(join(p, "runs")) ? join(p, "runs") : p;
  if (!existsSync(runsDir)) throw new Error(`no run directory at ${p}`);
  const candidates = readdirSync(runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(runsDir, e.name, "manifest.json")))
    .map((e) => e.name)
    .sort();
  const newest = candidates.at(-1);
  if (!newest) throw new Error(`no run with a manifest.json under ${runsDir}`);
  return join(runsDir, newest);
}

/**
 * The run's manifest, or a clear failure.
 *
 * Delegates the read to the engine's `readManifest` — which is tolerant by
 * design — and turns "not there" into a message naming the directory. Every
 * command after `scan` needs this file, and "cannot read property lanes of
 * undefined" is a worse thing to hand someone who pasted the wrong path.
 */
export function requireManifest(runDir: string): RunManifest {
  const m = readManifest<RunManifest>(runDir);
  if (!m) throw new Error(`${join(runDir, "manifest.json")} is missing or unreadable — is this a run directory?`);
  return m;
}

/**
 * Persist the manifest through the engine's writer.
 *
 * Not a plain write: `writeManifest` is atomic (this is the file most likely to
 * be read while it is written — an MCP server and a CLI both reach for it) and
 * it honours the no-write gate, so a `--stdout` run leaves the disk untouched.
 */
export function writeRunManifest(runDir: string, manifest: RunManifest): void {
  writeManifest(runDir, manifest);
}

export function readPlaces(runDir: string): Place[] {
  const places = readJsonSafe(join(runDir, "places.json")) as Place[] | undefined;
  if (!places) throw new Error(`${join(runDir, "places.json")} is missing — run \`ultraprospect scan\` first`);
  return places;
}

export function writePlaces(runDir: string, places: readonly Place[]): void {
  writeArtifact(join(runDir, "places.json"), JSON.stringify(places, null, 2) + "\n");
}

export function writeJson(runDir: string, file: string, value: unknown): void {
  writeArtifact(join(runDir, file), JSON.stringify(value, null, 2) + "\n");
}

/** Per-place page directory. One slug per company, stable across re-runs. */
export function pagesDir(runDir: string, placeId: string): string {
  return join(runDir, "pages", placeId);
}

export function readPageText(runDir: string, extractRelPath: string): string | undefined {
  const p = join(runDir, extractRelPath);
  if (!existsSync(p)) return undefined;
  return readFileSync(p, "utf8");
}

/**
 * The attributions that always apply, whatever the territory.
 *
 * OSM and the geocoders run on every run. Register attributions are NOT here:
 * they are per-connector and only travel when that connector actually answered,
 * which is what `licencesFor` assembles. Listing France's Licence Ouverte on a
 * German run would be a false claim about the provenance of the data.
 */
export const LICENCES = [
  "Places and tags: © OpenStreetMap contributors, ODbL (https://www.openstreetmap.org/copyright)",
  "Geocoding: Nominatim (ODbL) and Base Adresse Nationale (Licence Ouverte 2.0)",
];

/**
 * The attributions this run actually owes, given which connectors returned data.
 *
 * `connectorId` ON A CONFIRM LANE IS A LIST. `confirm` asks several authorities
 * about each company and records every one that answered, joined with commas
 * ("eu-vies,gleif"). Reading that as a single id resolved nothing, so a confirm
 * run that used more than one connector shipped with NO register attribution at
 * all — silently, and precisely on the runs where it matters: a German confirm
 * always uses more than one, and OffeneRegister is CC-BY 4.0, where attribution
 * is a licence CONDITION rather than a courtesy.
 *
 * A single-connector lane resolved fine, which is why this survived: the broken
 * case and the working case look identical in the manifest apart from a comma.
 */
export function licencesFor(lanes: readonly LaneCoverage[]): string[] {
  const out = [...LICENCES];
  for (const lane of lanes) {
    if (lane.lane !== "registry" || !lane.connectorId || lane.returned <= 0) continue;
    for (const id of lane.connectorId.split(",")) {
      const licence = connectorById(id.trim())?.licence;
      if (licence && !out.includes(licence)) out.push(licence);
    }
  }
  return out;
}

export function emptyManifest(label: string): RunManifest {
  // The slug is the short place name, not the geocoder's full administrative
  // chain — it titles the report and the page.
  const slug = shortLabel(label);
  return {
    version: 1,
    tool: "ultraprospect",
    toolVersion: VERSION,
    builtAt: new Date().toISOString(),
    slug,
    target: { query: "", label: "", lat: 0, lon: 0, bbox: [0, 0, 0, 0], source: "nominatim" },
    filters: {},
    lanes: [],
    counts: {
      osm: 0,
      registry: 0,
      registryWithCoordinates: 0,
      byConnector: {},
      places: 0,
      merged: 0,
      mergedByIdentifier: 0,
      undecided: 0,
      withWebsite: 0,
      enrichedTier1: 0,
      enrichedTier2: 0,
      confirmed: 0,
      dossiers: 0,
    },
    truncated: false,
    notes: [],
    licences: LICENCES,
    timings: {},
  };
}
