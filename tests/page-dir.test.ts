// One place decides where a place's files live.
//
// `pages/<slug>/` and `dossiers/<slug>.md` are found by `dossier`, `check` and
// `confirm` from the place id, and the id-to-slug rule was pasted into each of
// them beside the `pageDirFor` that `pages.ts` writes with. Five copies of one
// regex agree only until someone edits four of them. Page directories now come
// from `pageDirFor` and dossier names from `dossierPathFor`, and the readers
// hold no copy of their own.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCheck } from "../src/check.js";
import { buildDossierPacket, dossierPathFor } from "../src/dossier.js";
import { pageDirFor } from "../src/pages.js";
import type { Place, RunManifest } from "../src/types.js";

const ODD = "fr-sirene:302 474/648";

const place: Place = {
  id: ODD,
  name: "Acme",
  sources: ["registry"],
  address: {},
  contacts: { emails: [], phones: [], socials: [], people: [] },
  jobs: [],
  pages: ["P1"],
};

const manifest = {
  version: 1,
  tool: "ultraprospect",
  toolVersion: "0.0.0",
  builtAt: "",
  slug: "t",
  target: { query: "", label: "", lat: 0, lon: 0, bbox: [0, 0, 0, 0], source: "nominatim" },
  filters: {},
  lanes: [],
  counts: {
    osm: 0,
    registry: 0,
    byConnector: {},
    places: 1,
    merged: 0,
    undecided: 0,
    withWebsite: 0,
    enrichedTier1: 0,
    enrichedTier2: 0,
    confirmed: 0,
    dossiers: 0,
  },
  truncated: false,
  notes: [],
  licences: [],
  timings: {},
} as unknown as RunManifest;

describe("page and dossier paths", () => {
  it("are found by the packet and the gate where pageDirFor and dossierPathFor put them", () => {
    const runDir = mkdtempSync(join(tmpdir(), "ultraprospect-pagedir-"));
    mkdirSync(join(runDir, pageDirFor(ODD)), { recursive: true });
    writeFileSync(join(runDir, pageDirFor(ODD), "P1.md"), "# P1 — Acme\n\n---\n\nAcme bakes bread in Vincennes.\n");
    mkdirSync(join(runDir, "dossiers"), { recursive: true });
    writeFileSync(join(runDir, dossierPathFor(place)), "# Acme\n\nAcme bakes bread in Vincennes. [P1]\n");

    expect(buildDossierPacket(runDir, place, manifest).markdown).toContain("Acme bakes bread in Vincennes.");
    const report = runCheck({ runDir, places: [place], manifest });
    expect(report.errors).toEqual([]);
    expect(report.counts.dossiers).toBe(1);
    expect(report.counts.citations).toBe(1);
  });

  it.each(["check.ts", "dossier.ts", "confirm.ts"])("src/%s reads page directories through pageDirFor, not a copy of its rule", (file) => {
    const source = readFileSync(join(import.meta.dirname, "..", "src", file), "utf8");
    // The only copy left in these files is dossierPathFor's own, in dossier.ts.
    const copies = source.split("replace(/[^a-zA-Z0-9._-]/g").length - 1;
    expect(copies).toBe(file === "dossier.ts" ? 1 : 0);
    if (file !== "dossier.ts") expect(source).toContain("pageDirFor(");
  });
});
