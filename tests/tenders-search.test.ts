// Tender sources are asked a few at a time, and folded back in connector
// order whichever answered first.
import { describe, expect, it } from "vitest";
import { runTenderSearch } from "../src/tenders/search.js";
import type { SearchOutcome, Tender, TenderConnector, TenderQuery } from "../src/tenders/types.js";

const q: TenderQuery = { countries: [], cpv: [], keywords: [], kinds: ["call"], limit: 10 };

function notice(id: string, connectorId: string): Tender {
  return {
    id,
    connectorId,
    noticeId: id,
    country: "fr",
    kind: "call",
    status: "open",
    title: id,
    buyer: { name: "Ville de Test" },
    cpv: [],
    nature: "services",
    lots: [],
    documentsAccess: "unknown",
    places: [],
    criteria: [],
    awards: [],
    coverage: "all",
    // One procedure published by both sources: the first connector's copy is kept.
    aliases: ["0c4f7a52-9d1e-4b8a-a3f0-6e2b1c9d8e7f"],
  };
}

let inFlight = 0;
let peak = 0;

function source(id: string, delayMs: number): TenderConnector {
  return {
    id,
    countries: ["fr"],
    label: id,
    licence: id,
    docsUrl: "",
    coverage: "all",
    kinds: ["call"],
    availability: () => ({ available: true }),
    async search(): Promise<SearchOutcome> {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, delayMs));
      inFlight -= 1;
      return { tenders: [notice(`${id}:1`, id)], truncated: false, notes: [`${id} answered`] };
    },
    canary: async () => [],
    probe: async () => ({ ok: true, detail: "" }),
  };
}

describe("runTenderSearch", () => {
  it("asks unrelated sources at once and keeps the result in connector order", async () => {
    peak = 0;
    const res = await runTenderSearch(q, [source("slow", 40), source("fast", 1)]);
    expect(peak).toBe(2);
    expect(res.lanes.map((l) => l.connectorId)).toEqual(["slow", "fast"]);
    expect(res.notes.slice(0, 2)).toEqual(["slow answered", "fast answered"]);
    expect(Object.keys(res.raw)).toEqual(["slow", "fast"]);
    expect(res.tenders.map((t) => t.id)).toEqual(["slow:1"]);
  });
});
