// The bid gate on a machine whose path separator is a backslash.
//
// `bidDirFor` joins "bids" and the notice's directory name with `path.join`.
// On Windows that is "bids\<id>", and the gate used to recover the directory
// name by splitting on "/". This file gives relative joins the Windows
// separator, and leaves absolute ones alone so the temp directory still
// resolves on the machine running the suite.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { Tender } from "../src/tenders/types.js";

vi.mock("node:path", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:path")>();
  const join = (...parts: string[]) => (real.isAbsolute(parts[0] ?? "") ? real.join(...parts) : real.win32.join(...parts));
  const basename = (path: string, suffix?: string) => (real.isAbsolute(path) ? real.basename(path, suffix) : real.win32.basename(path, suffix));
  return { ...real, join, basename, default: { ...real, join, basename } };
});

const { bidDirFor } = await import("../src/tenders/bid.js");
const { runTenderCheck } = await import("../src/tenders/check.js");
const { emptyTenderManifest } = await import("../src/tenders/run.js");

const NOW = new Date("2026-11-02T10:00:00Z");

const tender: Tender = {
  id: "eu-ted:1-2026",
  connectorId: "eu-ted",
  noticeId: "1-2026",
  country: "fr",
  kind: "call",
  status: "open",
  title: "Développement d'une application web",
  buyer: { name: "Ville de Test", country: "fr" },
  cpv: ["72200000"],
  nature: "services",
  lots: [],
  deadline: "2026-12-01T12:00:00+01:00",
  documentsAccess: "unknown",
  places: [],
  criteria: [],
  awards: [],
  coverage: "above-threshold",
  aliases: ["1-2026"],
  pages: [{ id: "P1", url: "record:x", role: "notice", fetchedAt: NOW.toISOString(), chars: 10, extract: "pages/x/P1.md" }],
};

describe("the bid gate where path.join writes a backslash", () => {
  it("still recognises a notice's own bid directory", () => {
    expect(bidDirFor(tender)).toBe("bids\\eu-ted_1-2026");

    const dir = mkdtempSync(`${tmpdir()}/up-bid-win-`);
    mkdirSync(`${dir}/pages/x`, { recursive: true });
    writeFileSync(`${dir}/pages/x/P1.md`, "# P1\n\nThe notice.\n");
    mkdirSync(`${dir}/bids/eu-ted_1-2026`, { recursive: true });
    writeFileSync(`${dir}/bids/eu-ted_1-2026/RESPONSE.md`, "# Response\n\nThe buyer needs a web application for its residents [P1].\n");

    const report = runTenderCheck({ runDir: dir, tenders: [tender], manifest: emptyTenderManifest("t", {}), now: NOW });
    expect(report.errors.map((e) => e.rule)).not.toContain("bid-orphan");
    expect(report.counts.dossiers).toBe(1);
  });
});
