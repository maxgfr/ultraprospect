// What counts as a register's answer.
import { describe, expect, it } from "vitest";
import { RegisterUnreachable, registerAnswer } from "../src/registry/upstream.js";

describe("registerAnswer", () => {
  it("returns the data of a JSON answer, and nothing for 404 or 410", () => {
    expect(registerAnswer("x", { ok: true, status: 200, data: { a: 1 } })).toEqual({ a: 1 });
    expect(registerAnswer("x", { ok: false, status: 404, data: undefined })).toBeUndefined();
    expect(registerAnswer("x", { ok: true, status: 204, data: "" })).toBe("");
  });

  it("reads a 200 carrying a maintenance page as no answer, not as an empty register", () => {
    expect(() => registerAnswer("x", { ok: true, status: 200, data: "<html><body>Wartungsarbeiten</body></html>" })).toThrow(RegisterUnreachable);
  });

  it("reads a server error as no answer", () => {
    expect(() => registerAnswer("x", { ok: false, status: 503, data: undefined })).toThrow(/HTTP 503/);
  });
});
