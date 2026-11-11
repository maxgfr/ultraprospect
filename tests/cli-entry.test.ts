// A renamed bundle must still run.
//
// The entry guard recognised the CLI by its file name, so a copy of the bundle
// saved under any other name imported cleanly and did nothing: exit 0, no
// output. The guard now also asks whether the script node was started with IS
// this module, by real path — and must keep answering false to a module that
// merely imports it, which is how the skill-bundle drift gate and these tests
// read the flag tables.
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isProcessEntry } from "../src/cli.js";

describe("isProcessEntry", () => {
  const dir = mkdtempSync(join(tmpdir(), "ultraprospect-entry-"));
  const bundle = join(dir, "prospect-tool.mjs");
  const other = join(dir, "verify.mjs");
  writeFileSync(bundle, "");
  writeFileSync(other, "");
  const url = pathToFileURL(bundle).href;

  it("recognises the module under a name that is not `ultraprospect`", () => {
    expect(isProcessEntry(bundle, url)).toBe(true);
  });

  it("follows a symlink to it, the way a global npm bin runs it", () => {
    const link = join(dir, "pt");
    symlinkSync(bundle, link);
    expect(isProcessEntry(link, url)).toBe(true);
  });

  it("answers false to a script that only imports the module, and to no script at all", () => {
    expect(isProcessEntry(other, url)).toBe(false);
    expect(isProcessEntry(undefined, url)).toBe(false);
    expect(isProcessEntry(join(dir, "missing.mjs"), url)).toBe(false);
    // The test runner is the entry here, and importing src/cli.ts ran nothing.
    expect(isProcessEntry(process.argv[1], pathToFileURL(join(import.meta.dirname, "..", "src", "cli.ts")).href)).toBe(false);
  });
});
