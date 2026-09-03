import { describe, expect, it } from "vitest";
import {
  OSM_CONTACT_KEYS,
  OSM_TAG_GROUPS,
  OVERPASS_MIRRORS,
  areaIdFor,
  buildQuery,
  isInstanceBusy,
  isQueryTooBig,
  overpassError,
  poiCategory,
  poiContacts,
  poiWebsite,
  withinRadius,
} from "../src/overpass.js";
import { NACE_SECTIONS, naceSection } from "../src/classification/nace.js";
import { NAF_CODES, divisionsOfSection } from "../src/classification/naf-codes.js";
import type { OsmPoi } from "../src/types.js";
import { bboxAround, haversineM } from "../src/util.js";

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
  it("builds the industrial group from works and all industrial tags", () => {
    const q = buildQuery(undefined, [0, 1, 0, 1], { groups: ["industrial"] });
    expect(q).toContain('nwr["man_made"="works"]');
    expect(q).toContain('nwr["industrial"]');
  });

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
    for (const filters of Object.values(OSM_TAG_GROUPS)) {
      for (const filter of filters) expect(q).toContain(filter);
    }
  });

  it("excludes ATMs from the default business catalogue", () => {
    expect(buildQuery(undefined, [0, 1, 0, 1])).not.toContain("atm");
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

  it("labels industrial categories from either OSM industrial key", () => {
    expect(poiCategory({ ...base, tags: { man_made: "works" } })).toBe("man_made=works");
    expect(poiCategory({ ...base, tags: { industrial: "factory" } })).toBe("industrial=factory");
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

describe("poiContacts", () => {
  const base: OsmPoi = { id: "n248494308", osmType: "node", osmId: 248494308, lat: 0, lon: 0, tags: {} };

  it("publishes the exact contact-tag catalogue", () => {
    expect(OSM_CONTACT_KEYS).toEqual({
      emails: ["email", "contact:email"],
      phones: ["phone", "contact:phone", "contact:mobile", "mobile", "contact:whatsapp"],
      socials: ["contact:facebook", "contact:instagram", "contact:linkedin", "contact:twitter", "contact:youtube", "contact:tiktok"],
    });
  });

  it.each(OSM_CONTACT_KEYS.emails)("reads and lowercases the %s tag", (key) => {
    expect(poiContacts({ ...base, tags: { [key]: "Hello@Example.COM" } }).emails).toEqual([
      { value: "hello@example.com", from: "osm:n248494308", lane: "osm", note: `declared in OSM tag ${key}` },
    ]);
  });

  it.each(OSM_CONTACT_KEYS.phones)("reads and normalises the %s tag like a fetched tel: link", (key) => {
    expect(poiContacts({ ...base, tags: { [key]: "+33 (0)1 43.28-30.07" } }).phones).toEqual([
      { value: "+330143283007", from: "osm:n248494308", lane: "osm", note: `declared in OSM tag ${key}` },
    ]);
  });

  it.each(OSM_CONTACT_KEYS.socials)("keeps the %s tag verbatim", (key) => {
    expect(poiContacts({ ...base, tags: { [key]: "les-officiers" } }).socials).toEqual([
      { value: "les-officiers", from: "osm:n248494308", lane: "osm", note: `declared in OSM tag ${key}` },
    ]);
  });

  it("splits semicolon-separated values and uses the OSM feature type in the source", () => {
    const way: OsmPoi = {
      ...base,
      id: "w42",
      osmType: "way",
      osmId: 42,
      tags: {
        email: "ONE@example.com; two@example.com",
        phone: "+33 1 43 28 30 07; +33 1 48 08 55 16",
        "contact:instagram": "https://instagram.com/one;@two",
      },
    };
    const contacts = poiContacts(way);
    expect(contacts.emails.map((item) => [item.value, item.from])).toEqual([
      ["one@example.com", "osm:w42"],
      ["two@example.com", "osm:w42"],
    ]);
    expect(contacts.phones.map((item) => [item.value, item.from])).toEqual([
      ["+33143283007", "osm:w42"],
      ["+33148085516", "osm:w42"],
    ]);
    expect(contacts.socials.map((item) => [item.value, item.from])).toEqual([
      ["https://instagram.com/one", "osm:w42"],
      ["@two", "osm:w42"],
    ]);
  });

  it("returns empty contact lists for absent and empty tags", () => {
    expect(poiContacts({ ...base, tags: { phone: " ; ", email: "", "contact:facebook": "  " } })).toEqual({
      emails: [],
      phones: [],
      socials: [],
    });
  });

  it("does not turn a WhatsApp URL into a malformed phone number", () => {
    expect(poiContacts({ ...base, tags: { "contact:whatsapp": "https://wa.me/33143283007" } }).phones).toEqual([]);
  });
});

describe("withinRadius — the square the query used is not the disc the user asked for", () => {
  // Overpass has no circle: `--radius 800m` is served by the bounding SQUARE
  // around the point, whose corners sit at 800·√2 ≈ 1131 m out. SIRENE's
  // `/near_point` is a real disc. Left alone the two lanes cover different
  // territories while the manifest calls both of them "radius".
  const target = { lat: 48.8479, lon: 2.4372, radiusM: 800 };
  const EARTH_R = 6371008.8;

  /** A point exactly `m` metres due north — the haversine of a pure latitude step. */
  function north(m: number): { lat: number; lon: number } {
    return { lat: target.lat + (m / EARTH_R) * (180 / Math.PI), lon: target.lon };
  }

  function at(id: string, point: { lat: number; lon: number }): OsmPoi {
    return { id, osmType: "node", osmId: Number(id.slice(1)), lat: point.lat, lon: point.lon, tags: {} };
  }

  const box = bboxAround(target.lat, target.lon, target.radiusM);
  const inside = at("n1", north(target.radiusM * 0.7));
  const edge = at("n2", north(target.radiusM));
  const corner = at("n3", { lat: box[1], lon: box[3] });

  it("keeps a POI well inside the disc", () => {
    expect(withinRadius([inside], target).kept.map((p) => p.id)).toEqual(["n1"]);
  });

  it("drops the POI at the square's corner, which is r·√2 from the centre", () => {
    expect(haversineM(target.lat, target.lon, corner.lat, corner.lon)).toBeGreaterThan(target.radiusM * 1.4);
    expect(withinRadius([corner], target).kept).toEqual([]);
  });

  it("keeps a POI exactly on the edge — the boundary is inclusive", () => {
    expect(haversineM(target.lat, target.lon, edge.lat, edge.lon)).toBeCloseTo(target.radiusM, 6);
    expect(withinRadius([edge], target).kept.map((p) => p.id)).toEqual(["n2"]);
  });

  it("counts what it dropped", () => {
    const result = withinRadius([inside, edge, corner], target);
    expect(result.kept.map((p) => p.id)).toEqual(["n1", "n2"]);
    expect(result.dropped).toBe(1);
  });

  it("drops nothing when the target is an area rather than a point", () => {
    const result = withinRadius([inside, edge, corner], { lat: target.lat, lon: target.lon });
    expect(result.kept).toHaveLength(3);
    expect(result.dropped).toBe(0);
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
