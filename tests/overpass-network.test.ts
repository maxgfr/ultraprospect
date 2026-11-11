// A network that is down is not an area that is too big.
//
// The engine answers a request that got no response at all — DNS, a refused or
// reset connection, the client timeout — with status 0 and no body. The lane
// read that as "this mirror is busy", read "every mirror busy" as "the area is
// too big", and quartered the area to depth 3: 85 tiles, each one trying every
// mirror against a 105 s client timeout, to learn that the machine is offline.
// When nothing answered at all the lane now stops at once and says the network
// is the reason; a capacity failure from a server that did answer still splits.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeoTarget } from "../src/types.js";

const MIRRORS = ["https://a.example/api", "https://b.example/api", "https://c.example/api"];

const requested: string[] = [];
let respond: (url: string) => { ok: boolean; status: number; body: string; error?: string } = () => ({ ok: true, status: 200, body: '{"elements":[]}' });

vi.mock("../src/engine.js", () => ({
  awaitHostSlot: async () => 0,
  httpGet: async (url: string) => {
    requested.push(url);
    return respond(url);
  },
  extractJsonLd: () => [],
  htmlToText: (html: string) => html,
}));

const { fetchOsmPois } = await import("../src/overpass.js");

const OFFLINE = { ok: false, status: 0, body: "", error: "ENOTFOUND: getaddrinfo ENOTFOUND a.example" };

const box: GeoTarget = {
  query: "Somewhere",
  label: "Somewhere",
  lat: 53.55,
  lon: 10.0,
  bbox: [53.5, 53.6, 9.9, 10.1],
  source: "nominatim",
};

beforeEach(() => {
  requested.length = 0;
});

describe("fetchOsmPois with no network", () => {
  it("does not split when no mirror answered at all, and names the network as the reason", async () => {
    respond = () => OFFLINE;
    const result = await fetchOsmPois(box, { mirrors: MIRRORS });
    // One query, every mirror tried once — not 85 tiles of it.
    expect(requested.length).toBe(MIRRORS.length);
    expect(result.incomplete).toBe(true);
    expect(result.pois).toEqual([]);
    expect(result.reason).toMatch(/network/);
    expect(result.reason).not.toMatch(/split budget/);
    expect(result.notes.some((n) => n.includes("splitting"))).toBe(false);
    // The engine's own error string survives instead of a bare "HTTP 0".
    expect(result.notes.some((n) => n.includes("ENOTFOUND"))).toBe(true);
  });

  it("still splits an area whose every mirror timed out on it, because a timeout is a heavy query, not an outage", async () => {
    // The root box is too heavy for the client timeout; its quadrants answer.
    let call = 0;
    respond = () => {
      call++;
      if (call <= MIRRORS.length) return { ok: false, status: 0, body: "", error: "request timed out after 105000 ms" };
      return { ok: true, status: 200, body: '{"elements":[]}' };
    };
    const result = await fetchOsmPois(box, { mirrors: MIRRORS });
    expect(result.reason ?? "").not.toMatch(/network/);
    expect(result.notes.some((n) => n.includes("splitting"))).toBe(true);
    expect(result.incomplete).toBe(false);
  });

  it("does not fall back from the boundary to the bounding box either", async () => {
    respond = () => OFFLINE;
    const result = await fetchOsmPois({ ...box, osmType: "relation", osmId: 123 }, { mirrors: MIRRORS });
    expect(requested.length).toBe(MIRRORS.length);
    expect(result.incomplete).toBe(true);
    expect(result.notes.some((n) => n.includes("fell back"))).toBe(false);
  });

  it("still splits when one mirror answered with a capacity failure and the rest were unreachable", async () => {
    respond = (url) => (url.startsWith(MIRRORS[0]!) ? { ok: false, status: 504, body: "" } : OFFLINE);
    const result = await fetchOsmPois(box, { mirrors: MIRRORS, maxSplitDepth: 1 });
    // The root query, then four quadrants, each across every mirror.
    expect(requested.length).toBe(MIRRORS.length * 5);
    expect(result.notes.some((n) => n.includes("splitting"))).toBe(true);
    expect(result.incomplete).toBe(true);
    expect(result.reason).toMatch(/split budget/);
  });
});

describe("a boundary query refused for capacity", () => {
  const territory = { ...box, osmType: "relation" as const, osmId: 62782 };
  const BUSY = { ok: false, status: 504, body: "" };
  const OK = { ok: true, status: 200, body: '{"elements":[{"type":"node","id":1,"lat":53.55,"lon":10,"tags":{"name":"Kontor","office":"company"}}]}' };

  it("is retried once, and keeps the boundary when the second try is answered", async () => {
    let call = 0;
    respond = () => (++call <= MIRRORS.length ? BUSY : OK);
    const result = await fetchOsmPois(territory, { mirrors: MIRRORS, areaRetryDelayMs: 0 });
    expect(result.pois).toHaveLength(1);
    expect(result.notes.some((n) => n.includes("retrying it once"))).toBe(true);
    expect(result.notes.some((n) => n.includes("fell back"))).toBe(false);
    expect(requested.every((u) => decodeURIComponent(u).includes("area("))).toBe(true);
  });

  it("falls back to the bounding box only after the retry is refused too", async () => {
    let call = 0;
    respond = () => (++call <= MIRRORS.length * 2 ? BUSY : OK);
    const result = await fetchOsmPois(territory, { mirrors: MIRRORS, areaRetryDelayMs: 0 });
    expect(result.notes.some((n) => n.includes("fell back"))).toBe(true);
  });
});

describe("a sweep of the bounding box in place of the boundary", () => {
  it("is flagged on the result, for the coverage table to say", async () => {
    respond = (url) => (decodeURIComponent(url).includes("area(") ? { ok: false, status: 504, body: "" } : { ok: true, status: 200, body: '{"elements":[]}' });
    const result = await fetchOsmPois({ ...box, osmType: "relation", osmId: 62782 }, { mirrors: MIRRORS, areaRetryDelayMs: 0 });
    expect(result.boundaryFallback).toBe(true);
    expect(result.incomplete).toBe(false);
  });
});
