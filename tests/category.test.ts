import { describe, expect, it } from "vitest";
import { compileOsmFilter, laneGateRefusal, legalFormGateRefusal, parseCategories } from "../src/category.js";
import { OSM_TAG_GROUPS, buildQuery } from "../src/overpass.js";
import { CONNECTORS } from "../src/registry/index.js";

describe("parseCategories — the OSM half", () => {
  it("sends an exact tag to the OSM lane and nowhere else", () => {
    const c = parseCategories(["amenity=cafe"]);
    expect(c.osmFilters).toEqual(['["amenity"="cafe"]']);
    expect(c.targetsOsm).toBe(true);
    expect(c.targetsRegistry).toBe(false);
  });

  it("collapses several values of one key into a single alternation", () => {
    const c = parseCategories(["amenity=cafe", "amenity=restaurant"]);
    expect(c.osmFilters).toEqual(['["amenity"~"^(cafe|restaurant)$"]']);
  });

  it("keeps different keys as separate filters", () => {
    const c = parseCategories(["amenity=cafe", "shop=bakery"]);
    expect(c.osmFilters).toEqual(expect.arrayContaining(['["amenity"="cafe"]', '["shop"="bakery"]']));
    expect(c.osmFilters).toHaveLength(2);
  });

  it("treats a bare key and key=* as the whole key", () => {
    expect(parseCategories(["shop"]).osmFilters).toEqual(['["shop"]']);
    expect(parseCategories(["shop=*"]).osmFilters).toEqual(['["shop"]']);
  });

  it("lets the broader ask win when a key is named both bare and with values", () => {
    // Narrowing to the values would silently drop the bare term the user typed.
    expect(parseCategories(["shop", "shop=bakery"]).osmFilters).toEqual(['["shop"]']);
  });

  it("escapes regex metacharacters in an alternation, so a dot is a dot", () => {
    // `.` is legal in an OSM value and a wildcard in a regex: unescaped,
    // `a.b` would also match `aXb`, and exactness is the whole promise here.
    const filter = compileOsmFilter("k", ["a.b", "c"]);
    expect(filter).toBe('["k"~"^(a\\.b|c)$"]');
    expect(filter).not.toContain("(a.b|");
  });
});

describe("parseCategories — the register half", () => {
  it("routes a full activity code to activityCodes", () => {
    const c = parseCategories(["naf=56.30Z"]);
    expect(c.activityCodes).toEqual(["56.30Z"]);
    expect(c.sections).toEqual([]);
    expect(c.targetsRegistry).toBe(true);
    expect(c.targetsOsm).toBe(false);
  });

  it("routes a bare NACE letter to sections", () => {
    const c = parseCategories(["nace=I"]);
    expect(c.sections).toEqual(["I"]);
    expect(c.activityCodes).toEqual([]);
  });

  it("accepts every scheme prefix a connector with an activity vocabulary declares", () => {
    // The prefixes are derived from the connectors rather than hardcoded, so
    // the grammar round-trips whatever `place.category` prints. A hardcoded
    // list guessed `sic` where the UK connector emits `sic-uk`, and that term
    // was silently parsed as an OSM key and aimed at Overpass.
    for (const c of CONNECTORS.filter((x) => x.activityScheme !== "none")) {
      const parsed = parseCategories([`${c.activityPrefix}=12345`]);
      expect(parsed.targetsRegistry, `${c.activityPrefix} should reach the register lane`).toBe(true);
      expect(parsed.osmFilters, `${c.activityPrefix} must not become an OSM filter`).toEqual([]);
    }
  });

  it("does NOT steal the prefix of a connector with no activity vocabulary", () => {
    // `vat` and `lei` name no code anyone could filter a sweep on, and both are
    // plausible OSM keys. Claiming them for the register lane would take them
    // out of the OSM half of the grammar for nothing.
    for (const c of CONNECTORS.filter((x) => x.activityScheme === "none")) {
      const parsed = parseCategories([`${c.activityPrefix}=yes`]);
      expect(parsed.targetsRegistry, `${c.activityPrefix} must not reach the register lane`).toBe(false);
    }
  });

  it("routes the UK's own prefix to the register, not to Overpass", () => {
    const c = parseCategories(["sic-uk=56302"]);
    expect(c.activityCodes).toEqual(["56302"]);
    expect(c.osmFilters).toEqual([]);
  });
});

describe("parseCategories — refusing to guess", () => {
  it("reports a term with an unsafe character instead of interpolating it", () => {
    const c = parseCategories(['amenity="]; out; //']);
    expect(c.unknown).toHaveLength(1);
    expect(c.osmFilters).toEqual([]);
  });

  it("reports a scheme with no code", () => {
    expect(parseCategories(["naf="]).unknown).toEqual(["naf="]);
  });

  it("keeps the valid terms when one is bad", () => {
    const c = parseCategories(["amenity=cafe", "amenity=<script>"]);
    expect(c.osmFilters).toEqual(['["amenity"="cafe"]']);
    expect(c.unknown).toEqual(["amenity=<script>"]);
  });
});

describe("buildQuery with explicit filters", () => {
  const bbox: [number, number, number, number] = [48.84, 48.85, 2.41, 2.45];

  it("REPLACES the catalogue rather than adding to it", () => {
    // Unioning the nine groups back in would hand `--category amenity=cafe`
    // the whole town — the exact failure the flag exists to remove.
    const q = buildQuery(undefined, bbox, { extraFilters: ['["amenity"="cafe"]'] });
    expect(q).toContain('["amenity"="cafe"]');
    expect(q).not.toContain('["shop"]');
    expect(q).not.toContain("funeral_directors");
  });

  it("still sweeps all nine catalogue groups, including industrial, when no filter is supplied", () => {
    const q = buildQuery(undefined, bbox);
    expect(Object.keys(OSM_TAG_GROUPS)).toHaveLength(9);
    expect(OSM_TAG_GROUPS).toHaveProperty("industrial");
    expect(q).toContain('["shop"]');
    expect(q).toContain('["office"]');
    expect(q).toContain('["industrial"]');
  });

  it("binds an explicit filter to the administrative area like any other", () => {
    const q = buildQuery(3_600_108_346, bbox, { extraFilters: ['["amenity"="cafe"]'] });
    expect(q).toContain("area(3600108346)");
    expect(q).toContain('nwr["amenity"="cafe"](area.searchArea);');
  });
});

describe("laneGateRefusal — the fail-closed matrix", () => {
  const osmOnly = parseCategories(["amenity=cafe"]);
  const regOnly = parseCategories(["naf=56.30Z"]);
  const both = parseCategories(["amenity=cafe", "naf=56.30Z"]);
  const FR = { osmWillRun: true, registryCanBeAimed: true, aim: "both" } as const;

  it("passes when both lanes are aimed", () => {
    expect(laneGateRefusal(both, FR)).toBeUndefined();
  });

  it("refuses an OSM-only aim where the register CAN be swept", () => {
    expect(laneGateRefusal(osmOnly, FR)).toMatch(/registry lane sweeping/);
  });

  it("refuses a register-only aim where OSM runs", () => {
    expect(laneGateRefusal(regOnly, FR)).toMatch(/osm lane sweeping/);
  });

  it("suggests the lane that IS aimed, not the open one", () => {
    // Naming the open lane sends the user round the same refusal a second time.
    expect(laneGateRefusal(osmOnly, FR)).toContain("--category-lane osm");
    expect(laneGateRefusal(regOnly, FR)).toContain("--category-lane registry");
  });

  it("ALLOWS an OSM-only aim where no register can be enumerated", () => {
    // Germany, and most of the world. Demanding a register code here would make
    // --category unusable outside France, the UK and Estonia.
    const DE = { osmWillRun: true, registryCanBeAimed: false, aim: "both" } as const;
    expect(laneGateRefusal(osmOnly, DE)).toBeUndefined();
  });

  it("ALLOWS a register-only aim under --no-osm", () => {
    expect(laneGateRefusal(regOnly, { osmWillRun: false, registryCanBeAimed: true, aim: "both" })).toBeUndefined();
  });

  it("honours --category-lane osm as an excuse for the register lane", () => {
    expect(laneGateRefusal(osmOnly, { ...FR, aim: "osm" })).toBeUndefined();
  });

  it("refuses --category-lane registry when no register will sweep", () => {
    // The contradiction that used to slip through: the excuse names a lane that
    // is not running, so it excuses nothing and OSM sweeps the whole town.
    expect(laneGateRefusal(regOnly, { osmWillRun: true, registryCanBeAimed: false, aim: "registry" })).toMatch(
      /names a lane this run cannot aim|will not sweep/,
    );
  });

  it("refuses --category-lane osm when --no-osm was given", () => {
    expect(laneGateRefusal(regOnly, { osmWillRun: false, registryCanBeAimed: true, aim: "osm" })).toMatch(/names a lane this run cannot aim|will not sweep/);
  });

  it("says nothing when neither lane runs", () => {
    expect(laneGateRefusal(osmOnly, { osmWillRun: false, registryCanBeAimed: false, aim: "both" })).toBeUndefined();
  });
});

describe("legalFormGateRefusal", () => {
  const incapable = { id: "other-register", sweep: async () => ({ records: [], notes: [], coverage: {} as never }) } as any;
  const capable = { ...incapable, sweepFiltersLegalForm: true } as any;

  it("refuses include or exclude filters when the sweep connector cannot honour them", () => {
    expect(legalFormGateRefusal({ legalForms: ["9110"] }, incapable)).toMatch(/other-register.*legal form/i);
    expect(legalFormGateRefusal({ excludeLegalForms: ["9220"] }, incapable)).toMatch(/other-register.*legal form/i);
  });

  it("is silent when no legal-form filter was requested", () => {
    expect(legalFormGateRefusal({}, incapable)).toBeUndefined();
  });

  it("is silent when the sweep connector declares support", () => {
    expect(legalFormGateRefusal({ legalForms: ["5710"] }, capable)).toBeUndefined();
    expect(legalFormGateRefusal({ excludeLegalForms: ["9110"] }, capable)).toBeUndefined();
  });
});
