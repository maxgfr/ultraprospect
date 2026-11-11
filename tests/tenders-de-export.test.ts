// Germany's daily export: a past day's zip is read back from the cache, not
// downloaded again, and a window with no exportable day says so.
import { mkdtempSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cache = mkdtempSync(join(tmpdir(), "ultraprospect-de-"));
const downloaded: string[] = [];

/** A one-member stored zip. */
function zipOf(name: string, data: Buffer): Buffer {
  const fileName = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  const directory = Buffer.concat([central, fileName]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(local.length + fileName.length + data.length, 16);
  return Buffer.concat([local, fileName, data, directory, eocd]);
}

const release = JSON.parse(readFileSync(join(__dirname, "fixtures", "tenders", "de-release.json"), "utf8"));
const zip = zipOf("export.json", Buffer.from(JSON.stringify({ releases: [release] })));

vi.mock("../src/engine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine.js")>()),
  awaitHostSlot: async () => {},
  cacheDir: () => cache,
  httpGet: async (url: string) => {
    downloaded.push(new URL(url).searchParams.get("pubDay")!);
    return { ok: true, status: 200, bytes: zip };
  },
}));

const { deOeffentlichevergabe } = await import("../src/tenders/ocds-sources.js");

const dayAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const query = (from: string) => ({
  countries: ["de"],
  cpv: [],
  keywords: [],
  kinds: ["call" as const],
  limit: 1000,
  publishedFrom: from,
  publishedTo: dayAgo(0),
});

beforeEach(() => {
  downloaded.length = 0;
});

describe("the German daily export", () => {
  it("downloads a past day once, and only yesterday's again on the next run", async () => {
    await deOeffentlichevergabe.search(query(dayAgo(4)));
    expect(downloaded).toEqual([dayAgo(1), dayAgo(2), dayAgo(3), dayAgo(4)]);
    downloaded.length = 0;
    await deOeffentlichevergabe.search(query(dayAgo(4)));
    expect(downloaded).toEqual([dayAgo(1)]);
  });

  it("downloads again a day whose cached copy was fetched while it could still change", async () => {
    await deOeffentlichevergabe.search(query(dayAgo(3)));
    // Pretend the copy of three days ago was written the day after it, when it
    // was still "yesterday" and its export could yet be replaced.
    const stamp = new Date(Date.parse(`${dayAgo(3)}T00:00:00Z`) + 30 * 3_600_000);
    utimesSync(join(cache, "tenders", "de", `${dayAgo(3)}.zip`), stamp, stamp);
    downloaded.length = 0;
    await deOeffentlichevergabe.search(query(dayAgo(3)));
    expect(downloaded).toContain(dayAgo(3));
    expect(downloaded).not.toContain(dayAgo(2));
  });

  it("says why a window that starts after the newest export downloaded nothing", async () => {
    const out = await deOeffentlichevergabe.search(query(dayAgo(0)));
    expect(downloaded).toEqual([]);
    expect(out.tenders).toEqual([]);
    expect(out.notes?.join(" ")).toMatch(/nothing was downloaded/);
  });
});
