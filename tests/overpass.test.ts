import { describe, expect, it } from "vitest";
import {
  OSM_TAG_GROUPS,
  OVERPASS_MIRRORS,
  areaIdFor,
  buildQuery,
  isInstanceBusy,
  isQueryTooBig,
  overpassError,
  poiCategory,
  poiWebsite,
} from "../src/overpass.js";
import { NACE_SECTIONS, naceSection } from "../src/classification/nace.js";
import { NAF_CODES, divisionsOfSection } from "../src/classification/naf-codes.js";
import type { OsmPoi } from "../src/types.js";

describe("areaIdFor", () => {
  it("offsets a relation id into Overpass's area space", () => {
    expect(areaIdFor({ osmType: "relation", osmId: 108346 })).toBe(3_600_108_346);
  });

  it("refuses a way or a node — only relations are administrative areas", () => {
    expect(areaIdFor({ osmType: "way", osmId: 1 })).toBeUndefined();
    expect(areaIdFor({ osmType: "node", osmId: 1 })).toBeUndefined();
    expect(areaIdFor({})).toBeUndefined();
  });
});

describe("buildQuery", () => {
  it("binds every filter to the administrative area when there is one", () => {
    const q = buildQuery(3_600_108_346, [0, 1, 0, 1], { groups: ["shop"] });
    expect(q).toContain("area(3600108346)->.searchArea;");
    expect(q).toContain('nwr["shop"](area.searchArea);');
    expect(q).not.toContain("(0,0,1,1)");
  });

  it("falls back to a bounding box when there is no area", () => {
    const q = buildQuery(undefined, [48.84, 48.85, 2.43, 2.44], { groups: ["shop"] });
    expect(q).toContain('nwr["shop"](48.84,2.43,48.85,2.44);');
  });

  it("asks for centres, so ways and relations come back with coordinates", () => {
    // Without `center`, a supermarket mapped as a building has no lat/lon and
    // silently disappears from the run.
    expect(buildQuery(undefined, [0, 1, 0, 1])).toContain("out center tags;");
  });

  it("includes every catalogue group by default", () => {
    const q = buildQuery(undefined, [0, 1, 0, 1]);
    for (const key of Object.keys(OSM_TAG_GROUPS)) expect(q).toContain(OSM_TAG_GROUPS[key]!.slice(0, 12));
  });

  it("ignores an unknown group name rather than emitting a broken query", () => {
    const q = buildQuery(undefined, [0, 1, 0, 1], { groups: ["shop", "nonsense"] });
    expect(q).toContain('nwr["shop"]');
    expect(q).not.toContain("undefined");
  });
});

describe("overpassError", () => {
  it("sees no error in a JSON body", () => {
    expect(overpassError('{"elements":[]}')).toBeUndefined();
  });

  it("extracts the message from Overpass's HTML error page", () => {
    const html = '<html><body><p><strong style="color:#FF0000">Error</strong>: runtime error: Query timed out in "query" at line 3</p></body></html>';
    expect(overpassError(html)).toContain("Query timed out");
  });
});

describe("the two failure kinds, which look alike and want opposite responses", () => {
  it("classifies a saturated instance as busy — rotate, do not split", () => {
    const busy = "runtime error: open64: 0 Success /osm3s_osm_base Dispatcher_Client::request_read_and_idx::timeout";
    expect(isInstanceBusy(busy)).toBe(true);
    expect(isQueryTooBig(busy)).toBe(false);
  });

  it("classifies a genuine overrun as too big — split, do not rotate", () => {
    expect(isQueryTooBig('runtime error: Query timed out in "query" at line 3 after 90 seconds')).toBe(true);
    expect(isQueryTooBig("runtime error: Query run out of memory in some sense")).toBe(true);
  });

  it("treats transport failures as busy", () => {
    expect(isInstanceBusy("HTTP 504")).toBe(true);
    expect(isInstanceBusy("HTTP 0")).toBe(true);
    expect(isInstanceBusy("fetch failed")).toBe(true);
  });
});

describe("the mirror list", () => {
  it("holds only verified full-planet instances", () => {
    // Membership rule, not a description: a regional extract answers an
    // out-of-region query with 200 and zero elements, which reads downstream as
    // "this town has no businesses". osm.ch and osm.jp were measured and
    // excluded on exactly that basis and must not come back.
    const hosts = OVERPASS_MIRRORS.map((m) => new URL(m).host);
    expect(hosts).not.toContain("overpass.osm.ch");
    expect(hosts).not.toContain("overpass.osm.jp");
    expect(hosts).toContain("overpass-api.de");
    expect(OVERPASS_MIRRORS.length).toBeGreaterThanOrEqual(3);
  });
});

describe("poi helpers", () => {
  const base: OsmPoi = { id: "n1", osmType: "node", osmId: 1, lat: 0, lon: 0, tags: {} };

  it("labels a category from the most specific key", () => {
    expect(poiCategory({ ...base, tags: { shop: "bakery" } })).toBe("shop=bakery");
    expect(poiCategory({ ...base, tags: { office: "yes" } })).toBe("office");
    expect(poiCategory(base)).toBeUndefined();
  });

  it("reads a website from either tag spelling", () => {
    expect(poiWebsite({ ...base, tags: { website: "https://a.example" } })).toBe("https://a.example");
    expect(poiWebsite({ ...base, tags: { "contact:website": "b.example" } })).toBe("https://b.example");
  });

  it("takes only the first of a semicolon-separated list", () => {
    expect(poiWebsite({ ...base, tags: { website: "https://a.example;https://b.example" } })).toBe("https://a.example");
  });

  it("returns nothing when there is no website tag", () => {
    expect(poiWebsite(base)).toBeUndefined();
  });
});

describe("the NAF catalogue, generated from the register's own validation error", () => {
  it("covers every section with at least one code", () => {
    for (const section of NACE_SECTIONS) {
      expect(divisionsOfSection(section).length, `section ${section} has no divisions`).toBeGreaterThan(0);
    }
  });

  it("assigns every code to exactly one section", () => {
    // A code outside every section range would be silently dropped from the
    // split ladder, so part of the economy would stop being searchable.
    for (const code of NAF_CODES) expect(naceSection(code), `no section for ${code}`).toBeDefined();
  });

  it("holds the full nomenclature, not a sample", () => {
    expect(NAF_CODES.length).toBeGreaterThan(700);
  });

  it("groups a section into its divisions", () => {
    // Section J (information and communication) spans divisions 58-63.
    const divisions = divisionsOfSection("J");
    expect(divisions.flat()).toContain("62.01Z");
    for (const group of divisions) {
      const prefixes = new Set(group.map((c) => c.slice(0, 2)));
      expect(prefixes.size).toBe(1);
    }
  });

  it("rejects a malformed code", () => {
    expect(naceSection("nope")).toBeUndefined();
  });
});
