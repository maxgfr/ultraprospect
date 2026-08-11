// What each connector ASKS, and what it refuses to ask.
//
// The mappers are covered in connectors.test.ts; this is the other half — the
// identifier arithmetic and the guards in front of each request. They are easy
// to get wrong and impossible to notice: a connector that quietly converts a VAT
// number into the wrong company number returns a real record for a real
// company, just not the one that was asked about.
//
// The engine is mocked so the request itself can be inspected. Nothing here
// reaches the network; the live shapes are the weekly canary's job.
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Every request the connectors made, in order. */
const calls: Array<{ method: string; url: string; body?: unknown; headers?: Record<string, string> }> = [];
/** What the fake upstream answers next. Set per test. */
let answer: { ok: boolean; status: number; data: unknown } = { ok: true, status: 200, data: {} };
/** Hosts pushed back by a Retry-After-shaped signal, so a 429 is observable. */
const backOffs: Array<{ url: string; ms: number }> = [];

vi.mock("../src/engine.js", () => ({
  awaitHostSlot: async () => 0,
  backOffHost: (url: string, ms: number) => {
    backOffs.push({ url, ms });
  },
  mapLimit: async (items: readonly unknown[], _l: number, fn: (i: any, n: number) => Promise<unknown>) => {
    const out = [];
    for (const [i, item] of items.entries()) out.push(await fn(item, i));
    return out;
  },
  httpJson: async (method: string, url: string, body?: unknown, opts?: { headers?: Record<string, string> }) => {
    calls.push({ method, url, body, headers: opts?.headers });
    return answer;
  },
}));

const { czAres } = await import("../src/registry/cz-ares.js");
const { euVies } = await import("../src/registry/eu-vies.js");
const { fiPrh } = await import("../src/registry/fi-prh.js");
const { gbCompaniesHouse } = await import("../src/registry/gb-companies-house.js");
const { gleif } = await import("../src/registry/gleif.js");
const { noBrreg } = await import("../src/registry/no-brreg.js");
const { plKrs } = await import("../src/registry/pl-krs.js");
const { usEdgar, resetCompanyIndex } = await import("../src/registry/us-edgar.js");

const ctx = { keys: {} as Record<string, string | undefined> };

beforeEach(() => {
  calls.length = 0;
  backOffs.length = 0;
  answer = { ok: true, status: 200, data: {} };
  resetCompanyIndex();
  delete process.env.ULTRAPROSPECT_COMPANIES_HOUSE_KEY;
});

describe("eu-vies", () => {
  it("files Greece under EL, which is what the API accepts", async () => {
    answer = { ok: true, status: 200, data: { isValid: true, userError: "VALID", name: "X", address: "S\n10001 ATHINA" } };
    await euVies.verifyId!({ kind: "vat", value: "EL030440244", countryCode: "gr" }, ctx);
    expect(calls[0]!.url).toContain("/ms/EL/vat/030440244");
  });

  it("strips the country prefix and separators before asking", async () => {
    answer = { ok: true, status: 200, data: { isValid: true, userError: "VALID", name: "X", address: "" } };
    await euVies.verifyId!({ kind: "vat", value: "DE 811.907-980", countryCode: "de" }, ctx);
    expect(calls[0]!.url).toContain("/ms/DE/vat/811907980");
  });

  it("does not ask about an identifier that is not a VAT number", async () => {
    expect(await euVies.verifyId!({ kind: "hrb", value: "HRB 158855", countryCode: "de" }, ctx)).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe("fi-prh", () => {
  it("turns a Finnish VAT number back into the hyphenated business ID", async () => {
    // FI01120389 and 0112038-9 are the same registration written two ways, and
    // the API only answers to the second.
    answer = { ok: true, status: 200, data: { companies: [] } };
    await fiPrh.verifyId!({ kind: "vat", value: "FI01120389", countryCode: "fi" }, ctx);
    expect(decodeURIComponent(calls[0]!.url)).toContain("businessId=0112038-9");
  });

  it("refuses a VAT number of the wrong length rather than mangling it", async () => {
    expect(await fiPrh.verifyId!({ kind: "vat", value: "FI0112038", countryCode: "fi" }, ctx)).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("narrows a name lookup by postcode when there is one, else by locality", async () => {
    answer = { ok: true, status: 200, data: { companies: [] } };
    await fiPrh.lookup!({ names: ["Nokia"], countryCode: "fi", postcode: "02610" }, ctx);
    expect(calls[0]!.url).toContain("postCode=02610");
    calls.length = 0;
    await fiPrh.lookup!({ names: ["Nokia"], countryCode: "fi", locality: "Espoo" }, ctx);
    expect(calls[0]!.url).toContain("location=Espoo");
  });
});

describe("cz-ares", () => {
  it("pads a short IČO to the eight digits the path expects", async () => {
    answer = { ok: true, status: 200, data: {} };
    await czAres.verifyId!({ kind: "vat", value: "CZ177041", countryCode: "cz" }, ctx);
    expect(calls[0]!.url).toMatch(/\/00177041$/);
  });

  it("refuses an identifier too long to be an IČO", async () => {
    expect(await czAres.verifyId!({ kind: "vat", value: "CZ001770410000", countryCode: "cz" }, ctx)).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("searches by POST, with the locality in the body", async () => {
    answer = { ok: true, status: 200, data: { ekonomickeSubjekty: [] } };
    await czAres.lookup!({ names: ["Škoda"], countryCode: "cz", locality: "Mladá Boleslav" }, ctx);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toMatchObject({ obchodniJmeno: "Škoda", sidlo: { nazevObce: "Mladá Boleslav" } });
  });
});

describe("no-brreg", () => {
  it("takes the nine-digit organisation number out of a Norwegian VAT number", async () => {
    answer = { ok: true, status: 200, data: {} };
    await noBrreg.verifyId!({ kind: "vat", value: "NO 923 609 016 MVA", countryCode: "no" }, ctx);
    expect(calls[0]!.url).toMatch(/\/enheter\/923609016$/);
  });

  it("refuses an identifier kind it has no business answering", async () => {
    expect(await noBrreg.verifyId!({ kind: "hrb", value: "923609016", countryCode: "no" }, ctx)).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe("pl-krs", () => {
  it("pads a KRS number and tries the entrepreneurs' register before the associations'", async () => {
    answer = { ok: true, status: 200, data: {} };
    await plKrs.verifyId!({ kind: "krs", value: "41581", countryCode: "pl" }, ctx);
    expect(calls[0]!.url).toContain("/OdpisAktualny/0000041581?rejestr=P");
    // Nothing came back from P, so S is tried. A KRS number is unique across
    // both, so the wrong one simply 404s.
    expect(calls[1]!.url).toContain("rejestr=S");
  });
});

describe("us-edgar", () => {
  it("sends the bare `name email` User-Agent EDGAR demands, not the polite one", async () => {
    // Measured: a UA carrying a URL is answered 403 "Undeclared Automated
    // Tool". This is the one connector that must not use politeUa().
    answer = { ok: true, status: 200, data: { cik: "0000320193", name: "Apple Inc." } };
    await usEdgar.verifyId!({ kind: "cik", value: "320193", countryCode: "us" }, ctx);
    expect(calls[0]!.url).toContain("/submissions/CIK0000320193.json");
    expect(calls[0]!.headers?.["accept-encoding"]).toContain("gzip");
  });

  it("refuses CIK zero rather than asking about it", async () => {
    expect(await usEdgar.verifyId!({ kind: "cik", value: "0", countryCode: "us" }, ctx)).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("matches names against the bulk index and stops on a needle too short to mean anything", async () => {
    answer = { ok: true, status: 200, data: { 0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } } };
    expect(await usEdgar.lookup!({ names: ["Ap"], countryCode: "us" }, ctx)).toEqual([]);
  });
});

describe("gleif", () => {
  it("asks for an exact legal name first, and falls back to full text", async () => {
    answer = { ok: true, status: 200, data: { data: [] } };
    await gleif.lookup!({ names: ["Zalando SE"], countryCode: "de" }, ctx);
    // URLSearchParams encodes the space as "+", which decodeURIComponent does
    // not undo — compare on the encoded form rather than pretending otherwise.
    const first = decodeURIComponent(calls[0]!.url).replace(/\+/g, " ");
    expect(first).toContain("filter[entity.legalName]=Zalando SE");
    expect(first).toContain("filter[entity.legalAddress.country]=DE");
    expect(decodeURIComponent(calls[1]!.url).replace(/\+/g, " ")).toContain("filter[fulltext]=Zalando SE");
  });

  it("speaks JSON:API, which is what the service answers", async () => {
    answer = { ok: true, status: 200, data: { data: [] } };
    await gleif.lookup!({ names: ["X"], countryCode: "de" }, ctx);
    expect(calls[0]!.headers?.accept).toContain("vnd.api+json");
  });

  it("rejects a fuzzy hit whose register number is not the one asked about", async () => {
    // German register numbers repeat across courts, so an entity found by full
    // text is a candidate until its `registeredAs` matches exactly.
    answer = {
      ok: true,
      status: 200,
      data: {
        data: [
          {
            attributes: {
              lei: "X",
              entity: { legalName: { name: "Someone Else" }, legalAddress: { country: "DE" }, registeredAs: "HRB 999999", status: "ACTIVE" },
            },
          },
        ],
      },
    };
    expect(await gleif.verifyId!({ kind: "hrb", value: "HRB 158855", countryCode: "de" }, ctx)).toBeUndefined();
  });
});

describe("gb-companies-house", () => {
  it("asks nothing at all without a key", async () => {
    expect(await gbCompaniesHouse.lookup!({ names: ["Tesco"], countryCode: "gb" }, ctx)).toEqual([]);
    expect(await gbCompaniesHouse.verifyId!({ kind: "company-number", value: "00445790", countryCode: "gb" }, { keys: {} })).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("sends the key as the Basic username with an empty password", async () => {
    // Not a bearer token, whatever the word "key" suggests.
    answer = { ok: true, status: 200, data: { items: [] } };
    await gbCompaniesHouse.lookup!({ names: ["Tesco"], countryCode: "gb", locality: "Welwyn" }, { keys: { "gb-companies-house": "secret" } });
    expect(calls[0]!.headers?.authorization).toBe(`Basic ${Buffer.from("secret:").toString("base64")}`);
    expect(decodeURIComponent(calls[0]!.url)).toContain("location=Welwyn");
  });

  it("will not convert a VAT number into a company number", async () => {
    // They are different registrations. Treating one as the other returns a
    // real record for the wrong company.
    const keyed = { keys: { "gb-companies-house": "secret" } };
    expect(await gbCompaniesHouse.verifyId!({ kind: "vat", value: "GB123456789", countryCode: "gb" }, keyed)).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("pads a numeric company number to eight digits and leaves a prefixed one alone", async () => {
    answer = { ok: true, status: 200, data: { company_number: "00445790", company_name: "TESCO PLC" } };
    const keyed = { keys: { "gb-companies-house": "secret" } };
    await gbCompaniesHouse.verifyId!({ kind: "company-number", value: "445790", countryCode: "gb" }, keyed);
    expect(calls[0]!.url).toContain("/company/00445790");
    calls.length = 0;
    await gbCompaniesHouse.verifyId!({ kind: "company-number", value: "SC123456", countryCode: "gb" }, keyed);
    expect(calls[0]!.url).toContain("/company/SC123456");
  });

  it("rejects a prefix glued to eight digits rather than padding it into a real number", async () => {
    // The old pattern anchored the digits but not the total length, so
    // "SC12345678" passed and was requested as a company that is not that one.
    const keyed = { keys: { "gb-companies-house": "secret" } };
    expect(await gbCompaniesHouse.verifyId!({ kind: "company-number", value: "SC12345678", countryCode: "gb" }, keyed)).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("asks only about companies that are still active", async () => {
    // A dissolved shell sharing a trading name scores as well as the business at
    // the address, and `confirm` attaches on name agreement — so the live shop
    // would acquire a dead company's registration and read as dissolved forever.
    answer = { ok: true, status: 200, data: { items: [] } };
    await gbCompaniesHouse.lookup!({ names: ["Tesco"], countryCode: "gb", locality: "Welwyn" }, { keys: { "gb-companies-house": "secret" } });
    expect(decodeURIComponent(calls[0]!.url)).toContain("company_status=active");
  });

  it("does not send the postcode, because a UK registered office is often the accountant's", async () => {
    // Narrowing on the postcode OSM saw at the door would discard correct
    // matches — the opposite of the mistake it looks like it prevents.
    answer = { ok: true, status: 200, data: { items: [] } };
    await gbCompaniesHouse.lookup!(
      { names: ["Tesco"], countryCode: "gb", locality: "Welwyn", postcode: "AL7 1GA" },
      { keys: { "gb-companies-house": "secret" } },
    );
    expect(decodeURIComponent(calls[0]!.url)).not.toContain("AL7");
  });

  it("THROWS on a rate limit instead of answering that the company does not exist", async () => {
    // 600 requests per five minutes, and a confirm run is one request per
    // company. Returning [] made every throttled company read as unregistered.
    answer = { ok: false, status: 429, data: {} };
    const keyed = { keys: { "gb-companies-house": "secret" } };
    await expect(gbCompaniesHouse.lookup!({ names: ["Tesco"], countryCode: "gb" }, keyed)).rejects.toThrow(/rate limit/i);
    await expect(gbCompaniesHouse.verifyId!({ kind: "company-number", value: "00445790", countryCode: "gb" }, keyed)).rejects.toThrow(/rate limit/i);
    // And the whole host waits, not just the request that discovered the limit —
    // otherwise the next forty requests each rediscover it.
    expect(backOffs.length).toBeGreaterThan(0);
    expect(backOffs[0]!.url).toContain("api.company-information.service.gov.uk");
    expect(backOffs[0]!.ms).toBeGreaterThan(0);
  });
});
