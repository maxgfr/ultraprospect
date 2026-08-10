import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests write runs into /tmp/ultraprospect and read static fixtures —
    // never collect tests from those trees.
    exclude: [...configDefaults.exclude, "**/.ultraprospect/**", "tests/fixtures/**"],
    // Pins ULTRAPROSPECT_CACHE_DIR to a throwaway dir and forbids real network
    // from the unit suite — every upstream in this skill is a live public API,
    // and a test that quietly reaches Overpass measures the weather, not the code.
    setupFiles: ["tests/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // The vendored webindex bundle is not this repo's code — it is a pinned
      // artifact with its own suite and its own ratchet in its own repository,
      // and its bytes are verified against a sha256 rather than edited here.
      exclude: ["src/vendor/**"],
      reporter: ["text-summary", "text"],
      // A RATCHET, not an aspiration: set a couple of points below the measured
      // baseline so coverage cannot silently regress. Raise them when real
      // coverage climbs; never lower them to make a red run pass.
      //
      // The absolute numbers are modest and honestly so. Roughly half this tree
      // is network I/O against five public services — the Overpass fetch loop,
      // the register's pagination, `doctor`'s probes — and unit-testing that
      // would mean asserting against mocks of somebody else's API, which proves
      // the mock rather than the code. Those paths are covered by the offline
      // pipeline eval (a recorded sweep through the real bundle) and by the
      // weekly upstream canaries. What IS unit-tested is everything where a bug
      // would be silent: the split ladder, the matcher, the name model.
      thresholds: {
        statements: 49,
        branches: 47,
        functions: 55,
        lines: 48,
      },
    },
  },
});
