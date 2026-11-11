// TED paging stops on a read budget, not only when the limit is reached: a
// post-filter that drops nearly every row must not page through all of TED.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const notice = JSON.parse(readFileSync(join(__dirname, "fixtures", "tenders", "ted-cn.json"), "utf8")).notices[0];
let calls = 0;

vi.mock("../src/engine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine.js")>()),
  awaitHostSlot: async () => {},
  httpJson: async (_method: string, _url: string, body: { limit: number }) => {
    calls += 1;
    // A hard stop so the test ends even when the connector has no budget.
    const more = calls < 500;
    return {
      ok: true,
      status: 200,
      data: { totalNoticeCount: 250_000, notices: Array.from({ length: body.limit }, () => notice), iterationNextToken: more ? `t${calls}` : undefined },
    };
  },
}));

const { euTed } = await import("../src/tenders/eu-ted.js");

describe("TED paging", () => {
  it("stops after reading ten times the limit when the filters keep nothing, and says so", async () => {
    calls = 0;
    // The fixture is an IT-services notice (CPV 72000000): a works CPV keeps none.
    const out = await euTed.search({ countries: ["fr"], cpv: ["45000000"], keywords: [], kinds: ["call"], limit: 5 });
    expect(out.tenders).toHaveLength(0);
    expect(calls).toBe(10);
    expect(out.truncated).toBe(true);
    expect(out.reason).toMatch(/stopped after reading 50 notice\(s\)/);
  });
});
