// A query that dies partway is still a 200.
//
// Overpass reports a timeout or an exhausted memory budget INSIDE a successful
// JSON answer: the elements it had gathered so far, plus a `remark`. A lane that
// reads only `elements` files half a city as a complete partition, which is the
// one failure this tool exists to refuse — so the remark has to be read as the
// error it is, and the area split or declared incomplete.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeoTarget } from "../src/types.js";

const TIMED_OUT = 'runtime error: Query timed out in "query" at line 3 after 91 seconds.';

const requested: string[] = [];
let respond: (url: string) => unknown = () => ({ elements: [] });

vi.mock("../src/engine.js", () => ({
  awaitHostSlot: async () => 0,
  httpGet: async (url: string) => {
    requested.push(url);
    return { ok: true, status: 200, body: JSON.stringify(respond(url)) };
  },
  extractJsonLd: () => [],
  htmlToText: (html: string) => html,
}));

const { fetchOsmPois, overpassRemark } = await import("../src/overpass.js");

const node = (id: number, lat: number, lon: number) => ({ type: "node", id, lat, lon, tags: { name: `Office ${id}`, office: "company" } });

const target: GeoTarget = {
  query: "Somewhere dense",
  label: "Somewhere dense",
  lat: 53.55,
  lon: 10.0,
  bbox: [53.5, 53.6, 9.9, 10.1],
  source: "nominatim",
};

beforeEach(() => {
  requested.length = 0;
});

describe("overpassRemark", () => {
  it("reads a runtime error out of an otherwise valid answer", () => {
    expect(overpassRemark({ elements: [], remark: TIMED_OUT })).toContain("Query timed out");
  });

  it("ignores an answer with no remark, and a remark that is not an error", () => {
    expect(overpassRemark({ elements: [] })).toBeUndefined();
    expect(overpassRemark({ elements: [], remark: "some informational note" })).toBeUndefined();
    expect(overpassRemark(null)).toBeUndefined();
  });
});

describe("fetchOsmPois does not file a half-answered query as a whole partition", () => {
  it("splits the area when the answer carries a timeout remark, and keeps the quadrants' results", async () => {
    let call = 0;
    respond = () => {
      call++;
      // The whole box dies partway and hands back what it had; each quadrant then fits.
      if (call === 1) return { elements: [node(1, 53.51, 9.91)], remark: TIMED_OUT };
      return { elements: [node(call, 53.5 + call / 100, 9.9 + call / 100)] };
    };
    const result = await fetchOsmPois(target, { mirrors: ["https://overpass.example/api"] });
    expect(requested.length).toBe(5);
    expect(result.incomplete).toBe(false);
    expect(result.partitions).toBe(4);
    // The partial answer's own element is NOT trusted; only the quadrants' are.
    expect(result.pois.map((p) => p.osmId).sort()).toEqual([2, 3, 4, 5]);
    expect(result.notes.some((n) => n.includes("splitting"))).toBe(true);
  });

  it("declares the lane incomplete when every tile keeps timing out", async () => {
    respond = () => ({ elements: [node(1, 53.51, 9.91)], remark: TIMED_OUT });
    const result = await fetchOsmPois(target, { mirrors: ["https://overpass.example/api"], maxSplitDepth: 1 });
    expect(result.incomplete).toBe(true);
    expect(result.pois).toEqual([]);
  });
});
