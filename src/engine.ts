// The vendored webindex engine, re-exported under one path.
//
// Every module in this tree imports retrieval, caching, politeness, run-dir,
// artifact, CLI and MCP mechanics from HERE — never from src/vendor/ directly,
// and never by re-implementing them. `pnpm run verify:engine` enforces that as
// a prohibition: no module under src/ may DECLARE a name the engine already
// exports. Re-exporting is fine; declaring a second implementation is the
// regression it exists to catch.
//
// The bundle is pinned by tag + sha256 in src/vendor/webindex.meta.json and
// re-hashed by `node scripts/sync-engine.mjs --check`. tsup inlines it, so the
// skill still ships as a single file.
export * from "./vendor/webindex-engine.mjs";

import { configure } from "./vendor/webindex-engine.mjs";
import { VERSION } from "./version.js";

/**
 * Re-brand the engine as ultraprospect.
 *
 * This has to run before the first engine call, and exactly once. It re-prefixes
 * every environment variable the engine reads (`WEBINDEX_CACHE_DIR` becomes
 * `ULTRAPROSPECT_CACHE_DIR`), points the cache at our own root, and puts a real
 * version in the polite User-Agent.
 *
 * The version matters more here than in a general-purpose fetcher: this skill
 * talks to Nominatim, Overpass and data.gouv.fr, all of which are volunteer- or
 * state-run and all of which ask clients to identify themselves. A maintainer
 * reading their logs to decide whether to throttle us must be able to tell one
 * release from another, and to reach a human.
 */
export function brandEngine(): void {
  configure({
    name: "ultraprospect",
    envPrefix: "ULTRAPROSPECT",
    cli: "ultraprospect",
    version: VERSION,
  });
}
