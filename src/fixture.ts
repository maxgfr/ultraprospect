// Replaying a recorded sweep instead of calling five live services.
//
// Every upstream this skill uses is public infrastructure that changes hourly
// and goes down weekly. That makes a live end-to-end test useless as a gate: it
// fails on a plane, it fails when Overpass is busy, and its failures say
// nothing about the code. So the discovery lanes can be fed from a recorded
// run — the real bytes those APIs actually returned, committed under
// assets/fixtures/ — and everything downstream of retrieval (fusion, scoring,
// gating, rendering) is then exercised deterministically and offline.
//
// This is the fixture side of the same coin as evals/: the unit suite proves
// the parts, the fixture proves the pipeline, and the network suite (opt-in)
// proves the upstreams still speak the shape we recorded.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readJsonSafe, writeArtifact } from "./engine.js";
import type { GeoTarget, OsmPoi } from "./types.js";
import type { RegistryRecord } from "./registry/types.js";

export interface Fixture {
  target: GeoTarget;
  osm: OsmPoi[];
  registry: RegistryRecord[];
  /** Which connector recorded the register side. Read off the records themselves. */
  connectorId?: string;
}

/**
 * Load a recorded sweep.
 *
 * Throws rather than degrading: a fixture run that silently falls back to an
 * empty lane would turn a broken gate into a green one.
 */
export function loadFixture(dir: string): Fixture {
  const target = readJsonSafe(join(dir, "target.json")) as GeoTarget | undefined;
  if (!target) throw new Error(`${join(dir, "target.json")} is missing — a fixture needs the geocoded target it was recorded for`);
  for (const file of ["osm.json", "registry.json"]) {
    if (!existsSync(join(dir, file))) throw new Error(`${join(dir, file)} is missing — record it with \`ultraprospect scan --record <dir>\``);
  }
  const registry = (readJsonSafe(join(dir, "registry.json")) as RegistryRecord[]) ?? [];
  return {
    target,
    osm: (readJsonSafe(join(dir, "osm.json")) as OsmPoi[]) ?? [],
    registry,
    connectorId: registry[0]?.connectorId,
  };
}

/**
 * Write this run's raw lane output as a fixture someone else can replay.
 *
 * Deliberately records the LANE output rather than HTTP bodies. What must stay
 * stable for the pipeline tests is the shape this code turns responses into;
 * recording raw Overpass JSON would also pin the tag catalogue and the query
 * builder, so any catalogue edit would look like a regression.
 */
export function recordFixture(dir: string, outcome: { osm: OsmPoi[]; registry: RegistryRecord[] }, target: GeoTarget): void {
  mkdirSync(dir, { recursive: true });
  writeArtifact(join(dir, "target.json"), JSON.stringify(target, null, 2) + "\n");
  writeArtifact(join(dir, "osm.json"), JSON.stringify(outcome.osm, null, 2) + "\n");
  writeArtifact(join(dir, "registry.json"), JSON.stringify(outcome.registry, null, 2) + "\n");
}
