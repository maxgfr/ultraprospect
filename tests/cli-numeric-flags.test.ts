// A flag that takes a number, given something that is not one.
//
// The parser used to be forgiving, and on a flag that hid the mistake:
// `--max-results 1e4` was read as 1, so the register lane declared itself
// partial after a single row, and `--limit abc` quietly became the default.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { parseBbox } from "../src/util.js";

const fixture = join(import.meta.dirname, "..", "assets", "fixtures", "vincennes");

describe("numeric flags", () => {
  it.each([
    ["--max-results", "1e4"],
    ["--max-results", "abc"],
    ["--min-employees", "10.5"],
  ])("refuses %s %s instead of guessing a number out of it", async (flag, value) => {
    await expect(main(["scan", "--fixture", fixture, flag, value])).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining(flag),
    });
  });

  it("refuses a point that is not on the planet", async () => {
    await expect(main(["scan", "--lat", "95", "--long", "2.35", "--radius", "500m"])).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe("parseBbox", () => {
  it("accepts a box and returns it as south, north, west, east", () => {
    expect(parseBbox("48.8,2.3,48.9,2.4")).toEqual([48.8, 48.9, 2.3, 2.4]);
  });

  it("refuses coordinates outside the valid ranges", () => {
    expect(parseBbox("100,0,101,1")).toBeUndefined();
    expect(parseBbox("48.8,-190,48.9,2.4")).toBeUndefined();
  });
});
