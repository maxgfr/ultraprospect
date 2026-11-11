// A contract's winner is checked against the register of ITS country, not the
// buyer's: a German company that wins a French contract is in Germany's.
import { describe, expect, it, vi } from "vitest";
import type { Tender } from "../src/tenders/types.js";

const asked: { country: string; id: unknown }[] = [];

vi.mock("../src/registry/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/registry/index.js")>()),
  connectorsFor: (country: string) => ({
    confirm: [
      {
        id: `fake-${country}`,
        verifyId: async (id: unknown) => {
          asked.push({ country, id });
          return undefined;
        },
      },
    ],
  }),
}));

const { analyseAwards } = await import("../src/tenders/awards.js");
const { confirmSuppliers } = await import("../src/tenders/commands.js");

function award(id: string, supplier: { name: string; legalId: string; country?: string }): Tender {
  return {
    id,
    connectorId: "eu-ted",
    noticeId: id,
    country: "fr",
    kind: "award",
    status: "awarded",
    title: "Maintenance",
    buyer: { name: "Ville de Test", country: "fr" },
    cpv: [],
    nature: "services",
    lots: [],
    documentsAccess: "unknown",
    places: [],
    criteria: [],
    awards: [{ supplier }],
    coverage: "above-threshold",
    aliases: [],
  };
}

describe("a supplier's country", () => {
  it("sends a foreign winner of a French contract to its own register", async () => {
    asked.length = 0;
    const a = analyseAwards([award("t1", { name: "Beispiel GmbH", legalId: "DE123456789", country: "de" })]);
    expect(a.suppliers[0]!.country).toBe("de");
    const ids = await confirmSuppliers(a);
    expect(asked.map((x) => x.country)).toEqual(["de"]);
    expect(asked[0]!.id).toMatchObject({ kind: "vat", value: "DE123456789", countryCode: "de" });
    expect(ids[0]!.refused).toBe("no register confirmed this identifier");
  });

  it("falls back to the buyer's market when no notice says where the supplier is", async () => {
    asked.length = 0;
    await confirmSuppliers(analyseAwards([award("t1", { name: "Exemple SAS", legalId: "12345678900011" })]));
    expect(asked.map((x) => x.country)).toEqual(["fr"]);
  });

  it("reads fourteen digits as a SIRET only for a French supplier", () => {
    const foreign = analyseAwards([
      award("t1", { name: "Uno", legalId: "12345678901234", country: "it" }),
      award("t2", { name: "Due", legalId: "12345678909999", country: "it" }),
    ]);
    expect(foreign.suppliers).toHaveLength(2);
    const french = analyseAwards([
      award("t1", { name: "Site A", legalId: "12345678901234", country: "fr" }),
      award("t2", { name: "Site B", legalId: "12345678909999", country: "fr" }),
    ]);
    expect(french.suppliers).toHaveLength(1);
  });
});
