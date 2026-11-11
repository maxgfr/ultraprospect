// us-edgar's name lookup against the bulk ticker index.
//
// The engine is mocked and answers by URL: `company_tickers.json` with a few
// real rows, each submissions file with the company it names. Nothing here
// reaches the network.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];

/** Real rows of company_tickers.json, including Alphabet's two tickers on one CIK. */
const TICKERS = {
  0: { cik_str: 200406, ticker: "JNJ", title: "Johnson & Johnson" },
  1: { cik_str: 732717, ticker: "T", title: "AT&T INC." },
  2: { cik_str: 1652044, ticker: "GOOGL", title: "Alphabet Inc." },
  3: { cik_str: 1652044, ticker: "GOOG", title: "Alphabet Inc." },
};

vi.mock("../src/engine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine.js")>()),
  awaitHostSlot: async () => 0,
  httpJson: async (_method: string, url: string) => {
    calls.push(url);
    // Yield once, so two lookups started together are both in flight before
    // the index answers — the race a cached RESULT does not cover.
    await new Promise((r) => setTimeout(r, 1));
    if (url.endsWith("/files/company_tickers.json")) return { ok: true, status: 200, data: TICKERS };
    const cik = url.match(/CIK(\d+)\.json$/)?.[1];
    const row = Object.values(TICKERS).find((t) => String(t.cik_str).padStart(10, "0") === cik);
    return row ? { ok: true, status: 200, data: { cik, name: row.title } } : { ok: false, status: 404, data: undefined };
  },
}));

const { usEdgar, resetCompanyIndex } = await import("../src/registry/us-edgar.js");

beforeEach(() => {
  calls.length = 0;
  resetCompanyIndex();
});

describe("us-edgar lookup", () => {
  it("finds a company whose name has an ampersand in it", async () => {
    // The query became "johnson   johnson" — punctuation turned into spaces that
    // were never collapsed — and was compared with the raw lowercase title.
    const jnj = await usEdgar.lookup!({ names: ["Johnson & Johnson"], countryCode: "us" }, {});
    expect(jnj.map((r) => r.legalName)).toEqual(["Johnson & Johnson"]);
    const att = await usEdgar.lookup!({ names: ["AT&T"], countryCode: "us" }, {});
    expect(att.map((r) => r.legalName)).toEqual(["AT&T INC."]);
  });

  it("returns a company with two tickers once, and fetches it once", async () => {
    const hits = await usEdgar.lookup!({ names: ["Alphabet"], countryCode: "us" }, {});
    expect(hits.map((r) => r.id)).toEqual(["0001652044"]);
    expect(calls.filter((u) => u.includes("/submissions/")).length).toBe(1);
  });
});
