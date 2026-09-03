// The OSM lane against a canned Overpass response.
//
// `--radius 800m` cannot be sent to Overpass as a radius: the query is a
// bounding SQUARE, and its corners are 41% further out than the disc the user
// asked for. The register lane next door queries a real circle. So the lane
// trims its own result set, and this pins that it does — and that the count it
// dropped is reported rather than swallowed.
//
// The engine module is mocked: `tests/setup.ts` forbids live network, and
// Overpass is a volunteer-run service that a unit suite has no business
// calling.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bboxAround } from "../src/util.js";
import type { GeoTarget } from "../src/types.js";

const CENTRE = { lat: 48.8479, lon: 2.4372 };
const RADIUS_M = 800;
const EARTH_R = 6371008.8;

/** A point exactly `m` metres due north of the centre. */
function north(m: number): { lat: number; lon: number } {
  return { lat: CENTRE.lat + (m / EARTH_R) * (180 / Math.PI), lon: CENTRE.lon };
}

const box = bboxAround(CENTRE.lat, CENTRE.lon, RADIUS_M);
const cornerPoint = { lat: box[1], lon: box[3] };

/** One node well inside the disc, one out at the bounding square's corner. */
const ELEMENTS = [
  { type: "node", id: 1, ...north(RADIUS_M * 0.4), tags: { name: "Inside", shop: "bakery" } },
  { type: "node", id: 2, ...cornerPoint, tags: { name: "Corner", shop: "bakery" } },
];

const requested: string[] = [];

vi.mock("../src/engine.js", () => ({
  awaitHostSlot: async () => 0,
  httpGet: async (url: string) => {
    requested.push(url);
    return { ok: true, status: 200, body: JSON.stringify({ elements: ELEMENTS }) };
  },
  // overpass.ts pulls in signals.ts, which reads these off the engine.
  extractJsonLd: () => [],
  htmlToText: (html: string) => html,
}));

const { fetchOsmPois } = await import("../src/overpass.js");

function target(extra: Partial<GeoTarget> = {}): GeoTarget {
  return {
    query: `${CENTRE.lat},${CENTRE.lon}`,
    label: `${CENTRE.lat},${CENTRE.lon} within ${RADIUS_M} m`,
    lat: CENTRE.lat,
    lon: CENTRE.lon,
    bbox: box,
    source: "nominatim",
    ...extra,
  };
}

beforeEach(() => {
  requested.length = 0;
});

describe("fetchOsmPois trims a point search to the circle the user asked for", () => {
  it("drops the POI that sits in the bounding square but outside the radius", async () => {
    const result = await fetchOsmPois(target({ radiusM: RADIUS_M }));
    expect(result.pois.map((p) => p.name)).toEqual(["Inside"]);
    expect(result.outsideRadius).toBe(1);
  });

  it("says so in a note, naming the radius, rather than quietly shrinking the list", async () => {
    const result = await fetchOsmPois(target({ radiusM: RADIUS_M }));
    const note = result.notes.find((n) => n.includes("outside"));
    expect(note).toBeDefined();
    expect(note).toContain("800");
    expect(note).toContain("1");
  });

  it("keeps everything, and says nothing, when the target is an area", async () => {
    const result = await fetchOsmPois(target({ osmType: "relation", osmId: 108346 }));
    expect(result.pois.map((p) => p.name)).toEqual(["Inside", "Corner"]);
    expect(result.outsideRadius).toBe(0);
    expect(result.notes.filter((n) => n.includes("outside"))).toEqual([]);
  });

  it("still queries the bounding box, because Overpass has no circle", async () => {
    await fetchOsmPois(target({ radiusM: RADIUS_M }));
    expect(requested).toHaveLength(1);
    expect(decodeURIComponent(requested[0] ?? "")).toContain(`(${box[0]},${box[2]},${box[1]},${box[3]})`);
  });
});
