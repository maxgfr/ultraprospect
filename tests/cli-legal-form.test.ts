import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

const fixture = join(import.meta.dirname, "..", "assets", "fixtures", "vincennes");

describe("scan legal-form arguments", () => {
  it("refuses a code included and excluded by the same run", async () => {
    await expect(main(["scan", "--fixture", fixture, "--legal-form", "5710,9110", "--exclude-legal-form", "9110,9220"])).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringMatching(/9110.*both|both.*9110/i),
    });
  });
});
