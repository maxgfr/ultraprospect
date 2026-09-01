import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests write runs into /tmp/ultraprospect and read static fixtures —
    // never collect tests from those trees.
    // `.claude/worktrees/**` holds full checkouts of this same repo, so without
    // it the suite collects every test three times over — and the copies share
    // one ULTRAPROSPECT_CACHE_DIR, so the snapshot and connector tests collide
    // with each other and fail for reasons that have nothing to do with the
    // code under review.
    exclude: [...configDefaults.exclude, "**/.ultraprospect/**", "tests/fixtures/**", "**/.claude/**"],
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
      // The absolute numbers are modest and honestly so. A large part of this
      // tree is network I/O against public services nobody here controls — the
      // Overpass fetch loop, each register's pagination, `doctor`'s probes —
      // and asserting the RESPONSE shapes against mocks would prove the mock
      // rather than the code. Those live shapes are the weekly canary's job,
      // one per connector.
      //
      // What IS unit-tested is everything where a bug would be silent: the
      // split ladder, the matcher, the name model, every connector's mapper
      // (against captured real responses), the identifier arithmetic in front
      // of each request, and `confirm`'s decision to attach a register identity
      // or refuse one.
      //
      // Raised from 48/46/56/47 when the multi-country work landed, then from
      // 51/48/57/51 when the open-data work did: a bzip2 decoder, a zip reader and
      // a snapshot index are all pure logic with no live service in the way, so
      // they are testable to a standard the network lanes are not, and the ratchet
      // should hold them to it. Raise these again when real coverage climbs; never
      // lower them to make a red run pass — adding untested code is exactly the
      // thing this ratchet exists to make visible.
      thresholds: {
        statements: 57,
        branches: 50,
        functions: 62,
        lines: 58,
      },
    },
  },
});
