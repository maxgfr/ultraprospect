// The public-host guard every fetched URL goes through.
//
// Most URLs this tool fetches were typed by nobody who runs it: a search hit, a
// link on a page, an OSM `website` tag, a buyer's documents field. None of them
// may reach the machine's own network or a cloud metadata endpoint.
import { afterEach, describe, expect, it, vi } from "vitest";
import { hopGuard, privateAddressReason, privateHostsAllowed, publicUrlRefusal } from "../src/net.js";

const resolvesTo =
  (...addresses: string[]) =>
  async () =>
    addresses;
const NOWHERE = async () => [];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("privateAddressReason", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "[::1]",
  ])("calls %s private", (address) => {
    expect(privateAddressReason(address)).toBeDefined();
  });

  it.each(["8.8.8.8", "172.32.0.1", "100.128.0.1", "2a00:1450:4001:80b::200e", "93.184.216.34"])("calls %s public", (address) => {
    expect(privateAddressReason(address)).toBeUndefined();
  });

  it("says nothing about a string that is not an address", () => {
    expect(privateAddressReason("beispiel.example")).toBeUndefined();
  });
});

describe("publicUrlRefusal", () => {
  it("refuses anything but http and https", async () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com/", "javascript:alert(1)"]) {
      expect(await publicUrlRefusal(url, NOWHERE), url).toBeDefined();
    }
  });

  it("refuses the names that mean this machine or its network", async () => {
    for (const url of ["http://localhost:8080/admin", "http://api.localhost/", "http://printer.local/", "http://db.internal/"]) {
      expect(await publicUrlRefusal(url, NOWHERE), url).toBeDefined();
    }
  });

  it("refuses a literal private address, the metadata endpoint included", async () => {
    expect(await publicUrlRefusal("http://169.254.169.254/latest/meta-data/", NOWHERE)).toContain("link-local");
    expect(await publicUrlRefusal("http://[::1]:3000/", NOWHERE)).toBeDefined();
    expect(await publicUrlRefusal("http://10.0.0.5/dce.zip", NOWHERE)).toBeDefined();
  });

  it("refuses a public-looking name that resolves to a private address", async () => {
    expect(await publicUrlRefusal("https://innocent.example/", resolvesTo("93.184.216.34", "127.0.0.1"))).toBeDefined();
  });

  it("lets through a public name, and a name that does not resolve at all", async () => {
    expect(await publicUrlRefusal("https://www.amprion.net/Impressum.html", resolvesTo("93.184.216.34"))).toBeUndefined();
    expect(await publicUrlRefusal("https://beispiel.example/", NOWHERE)).toBeUndefined();
  });

  it("does not wait forever on a resolver that never answers", async () => {
    vi.useFakeTimers();
    try {
      const pending = publicUrlRefusal("https://slow.example/", () => new Promise<string[]>(() => {}));
      await vi.advanceTimersByTimeAsync(6_000);
      expect(await pending).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the opt-out", () => {
  it("is read from the environment and lifts only the host rules", async () => {
    expect(privateHostsAllowed({})).toBe(false);
    expect(privateHostsAllowed({ ULTRAPROSPECT_ALLOW_PRIVATE_HOSTS: "1" })).toBe(true);
    vi.stubEnv("ULTRAPROSPECT_ALLOW_PRIVATE_HOSTS", "1");
    expect(hopGuard("http://localhost/").authorizeUrl).toBeUndefined();
  });
});

describe("hopGuard", () => {
  it("names a refused redirect as a redirect", async () => {
    const guard = hopGuard("https://public.example/");
    expect(await guard.authorizeUrl!("https://public.example/")).toBe(true);
    expect(await guard.authorizeUrl!("http://169.254.169.254/")).toBe(false);
    expect(guard.refusal()).toContain("redirects to http://169.254.169.254/");
  });
});
