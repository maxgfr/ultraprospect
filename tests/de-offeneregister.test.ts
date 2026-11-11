// The court comparison in de-offeneregister's `verifyId`, on records the
// fixture export does not carry.
//
// The snapshot layer is faked so a record can be filed with NO court at all —
// a shape the real export allows (the court comes from a free-text field that
// does not always parse) and one that matched every court by containment.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegistryRecord } from "../src/registry/types.js";
import { rec } from "./factories.js";

let hits: RegistryRecord[] = [];

vi.mock("../src/snapshot.js", () => ({
  hasSnapshot: () => true,
  snapshotById: async () => hits,
  snapshotByLocality: async () => [],
  snapshotMeta: () => undefined,
}));

const { deOffeneRegister } = await import("../src/registry/de-offeneregister.js");

beforeEach(() => {
  hits = [];
});

describe("de-offeneregister — a record filed with no court", () => {
  it("does not match whatever court the Impressum names", async () => {
    // normalizeName("") is "", and "köln".includes("") is true: the courtless
    // record was attached as the company filed at Cologne.
    hits = [rec({ id: "HRB 4711", legalName: "Ohne Gericht GmbH", national: { registerNumber: "HRB 4711" } })];
    const notes: string[] = [];
    const got = await deOffeneRegister.verifyId!({ kind: "hrb", value: "HRB 4711", countryCode: "de", context: "Köln" }, { onNote: (n) => notes.push(n) });
    expect(got).toBeUndefined();
    expect(notes.join(" ")).toContain("no named court");
  });

  it("still picks the one record whose court matches beside a courtless one", async () => {
    hits = [
      rec({ id: "HRB 4711", legalName: "Ohne Gericht GmbH", national: { registerNumber: "HRB 4711" } }),
      rec({ id: "Köln HRB 4711", legalName: "Kölner Handel GmbH", national: { registerNumber: "HRB 4711", registerCourt: "Köln" } }),
    ];
    const got = await deOffeneRegister.verifyId!({ kind: "hrb", value: "HRB 4711", countryCode: "de", context: "Amtsgericht Köln" }, {});
    expect(got?.legalName).toBe("Kölner Handel GmbH");
  });
});
