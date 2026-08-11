// Test-suite guard rails.
//
// Two things are pinned here, and the second is the one that matters.
//
// 1. The fetch cache goes to a throwaway directory. The engine's cache is on by
//    default and the suite must never read or write the developer's real one.
//
// 2. NETWORK IS FORBIDDEN. Every upstream this skill uses is a live public
//    service — two of them volunteer-run — so a unit test that quietly reaches
//    Overpass measures today's weather, fails on a plane, and adds load to
//    someone else's server on every CI run. `global.fetch` is replaced with a
//    function that throws a message naming the offending URL, so an accidental
//    live call fails loudly and locally instead of flaking six months later.
//    Tests that need a response mock the engine module; the network suite lives
//    in evals/, which is opt-in and run separately.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll } from "vitest";
import { brandEngine } from "../src/engine.js";

const scratch = mkdtempSync(join(tmpdir(), "ultraprospect-test-"));
process.env.ULTRAPROSPECT_CACHE_DIR = join(scratch, "cache");
process.env.ULTRAPROSPECT_POLITE_DELAY_MS = "0";

// Brand the engine, or the two environment variables above are decoration.
//
// The engine reads its settings under a configurable prefix, and until
// `brandEngine()` runs that prefix is `WEBINDEX_`. So the suite believed it had
// pinned the cache to a throwaway directory and had actually pinned nothing: any
// test that wrote through the engine's cache went to the shared default, outside
// the scratch tree and outside anything the suite cleans up. It surfaced the day
// a test ingested a register snapshot and the files landed in `<tmpdir>/webindex`.
//
// Branding here also makes the unit suite resolve the same env vars, cache root
// and User-Agent that the CLI does, which is the point of a test harness.
brandEngine();

beforeAll(() => {
  global.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : (input?.url ?? String(input));
    throw new Error(
      `network access from the unit suite: ${url}\n` +
        "  Unit tests must not call live services. Mock ./engine.js, or move the test to evals/ (pnpm run eval:network).",
    );
  }) as typeof fetch;
});

export { scratch };
