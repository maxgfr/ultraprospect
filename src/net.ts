// How this tool identifies itself, and to whom.
//
// webindex defaults to a browser User-Agent, which is the right call for
// fetching a company's marketing site: plenty of hosts serve a challenge page to
// anything that looks automated, and a prospect's website is not an API.
//
// It is the WRONG call for the community infrastructure this skill runs on, and
// not as a matter of etiquette:
//
//   * overpass-api.de answers a browser User-Agent with **HTTP 406**, on
//     purpose, to keep scrapers off a volunteer-funded service. Measured, not
//     assumed: the same query returns 200 with `curl/8` and 406 with a Chrome
//     string. A tool that spoofs a browser there is not being clever, it is
//     being refused.
//   * Nominatim's usage policy requires an identifying User-Agent and treats a
//     generic one as grounds for blocking — for everyone behind the address,
//     not just the offender.
//
// So requests to OSM and data.gouv infrastructure carry a real name, a real
// version and a link to the repository. If we become a problem for a maintainer,
// they can see who we are and reach us, instead of blocking a Chrome string that
// half the internet also sends.
import { lookup } from "node:dns/promises";
import { VERSION } from "./version.js";

export const CONTACT_URL = "https://github.com/maxgfr/ultraprospect";

/** The identifying User-Agent for OSM, Nominatim and data.gouv endpoints. */
export function politeUa(): string {
  return `ultraprospect/${VERSION} (+${CONTACT_URL})`;
}

// ---- Public hosts only ------------------------------------------------------
//
// Most URLs this tool fetches were typed by nobody who runs it. They come from
// a search hit, a link on somebody's page, a `website` tag anyone can edit in
// OSM, the "documents" field of a buyer's notice. Nothing stopped one of them
// from being `http://169.254.169.254/latest/meta-data/` or
// `http://localhost:8080/admin`, and the answer would have been stored as a
// page and quoted back. It matters most under `ultraprospect mcp`, where the
// tool runs beside whatever else is on the machine.
//
// The vendored engine has NO default guard. It offers a hook — `authorizeUrl`,
// asked before the first request and before every redirect — and leaves the
// policy to the caller. This is the policy:
//
//   * http and https only;
//   * never `localhost`, `*.localhost`, `*.local` or `*.internal`;
//   * never a literal address in loopback, RFC 1918, link-local (169.254/16,
//     which is where cloud metadata is served), carrier-grade NAT (100.64/10)
//     or 0.0.0.0/8, nor their IPv6 forms: `::`, `::1`, fc00::/7, fe80::/10 and
//     an IPv4 address mapped into IPv6;
//   * never a name that RESOLVES to one of those, which is how the first three
//     rules are otherwise walked around with one DNS record.
//
// A name that does not resolve is not refused: there is nothing to protect,
// and the fetch fails on its own with the engine's own account of why.
//
// What this does not close is a name that answers a public address to this
// check and a private one to the request that follows. Closing that means
// pinning the connection to the address that was checked, which only the
// engine's fetch path can do.

/** Turns a hostname into the addresses it answers with. Injectable: the unit suite must not touch DNS. */
export type HostResolver = (hostname: string) => Promise<string[]>;

const dnsResolver: HostResolver = async (hostname) => (await lookup(hostname, { all: true })).map((a) => a.address);

let hostResolver: HostResolver = dnsResolver;

/**
 * Replace the resolver the guard asks, or restore DNS with no argument.
 *
 * `tests/setup.ts` installs one that knows no host at all, so the unit suite
 * never sends a DNS query: its pages live on names like `beispiel.example`,
 * which resolve nowhere, and a name that does not resolve is let through.
 */
export function setHostResolver(next?: HostResolver): void {
  hostResolver = next ?? dnsResolver;
}

/** A resolver that never answers must not hold a fetch past the engine's own timeout. */
const RESOLVE_TIMEOUT_MS = 5_000;

/**
 * The opt-out, for testing against a server on your own machine or network:
 *
 *     ULTRAPROSPECT_ALLOW_PRIVATE_HOSTS=1 ultraprospect enrich …
 *
 * It lifts the host rules and nothing else — a URL still has to be http or
 * https. It is read from the environment on purpose: no flag, no MCP argument
 * and nothing in a fetched page can switch it on.
 */
export function privateHostsAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return /^(?:1|true|yes|on)$/i.test((env.ULTRAPROSPECT_ALLOW_PRIVATE_HOSTS ?? "").trim());
}

function ipv4Octets(text: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return undefined;
  const octets = m.slice(1).map(Number);
  return octets.every((n) => n <= 255) ? octets : undefined;
}

function privateV4(octets: readonly number[]): string | undefined {
  const [a, b] = octets as [number, number];
  if (a === 0) return "in 0.0.0.0/8, this machine's own network";
  if (a === 127) return "a loopback address";
  if (a === 10) return "a private address (10.0.0.0/8)";
  if (a === 172 && b >= 16 && b <= 31) return "a private address (172.16.0.0/12)";
  if (a === 192 && b === 168) return "a private address (192.168.0.0/16)";
  if (a === 169 && b === 254) return "a link-local address (169.254.0.0/16, where cloud metadata is served)";
  if (a === 100 && b >= 64 && b <= 127) return "a carrier-grade NAT address (100.64.0.0/10)";
  // Not private, but never a company's website either, and each one reaches
  // something other than the public web: the IETF protocol block, the
  // benchmarking range, the three documentation ranges, multicast, and the
  // reserved block that ends in the limited broadcast address.
  if (a === 192 && b === 0 && octets[2] === 0) return "an IETF protocol address (192.0.0.0/24)";
  if (a === 198 && (b === 18 || b === 19)) return "a benchmarking address (198.18.0.0/15)";
  if ((a === 192 && b === 0 && octets[2] === 2) || (a === 198 && b === 51 && octets[2] === 100) || (a === 203 && b === 0 && octets[2] === 113))
    return "a documentation address";
  if (a >= 224 && a <= 239) return "a multicast address (224.0.0.0/4)";
  if (a >= 240) return "a reserved address (240.0.0.0/4)";
  return undefined;
}

/** The eight 16-bit groups of an IPv6 address, brackets and zone id tolerated. */
function ipv6Groups(raw: string): number[] | undefined {
  let text = raw
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "")
    .toLowerCase();
  if (!text.includes(":")) return undefined;
  // A dotted tail (`::ffff:127.0.0.1`) is the last two groups written as IPv4.
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const o = ipv4Octets(dotted[2]!);
    if (!o) return undefined;
    text = `${dotted[1]}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN)));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const gap = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (gap < 0) return undefined;
  const groups = [...head, ...new Array<number>(gap).fill(0), ...tail];
  return groups.length === 8 && groups.every((g) => Number.isFinite(g)) ? groups : undefined;
}

function privateV6(groups: readonly number[]): string | undefined {
  const g = groups as number[];
  const leadingZeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (leadingZeros(7) && g[7] === 0) return "the unspecified address";
  if (leadingZeros(7) && g[7] === 1) return "a loopback address";
  if ((g[0]! & 0xfe00) === 0xfc00) return "a unique local address (fc00::/7)";
  if ((g[0]! & 0xffc0) === 0xfe80) return "a link-local address (fe80::/10)";
  if ((g[0]! & 0xffc0) === 0xfec0) return "a site-local address (fec0::/10)";
  if ((g[0]! & 0xff00) === 0xff00) return "a multicast address (ff00::/8)";
  // Tunnels and translators that carry an IPv4 address inside: a NAT64 prefix
  // (64:ff9b::/96, and the local-use 64:ff9b:1::/48), 6to4 (2002::/16, the
  // address in groups 1 and 2), SIIT (::ffff:0:a.b.c.d) and Teredo (2001::/32,
  // which obfuscates it). Each is a way to spell 169.254.169.254 that a check
  // on the IPv4 forms alone lets through.
  const v4In = (hi: number, lo: number) => privateV4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    if (g[2] === 1) return "a local-use NAT64 address (64:ff9b:1::/48)";
    const inner = v4In(g[6]!, g[7]!);
    if (inner) return `${inner}, written as NAT64`;
  }
  if (g[0] === 0x2002) {
    const inner = v4In(g[1]!, g[2]!);
    if (inner) return `${inner}, written as 6to4`;
  }
  if (leadingZeros(4) && g[4] === 0xffff && g[5] === 0) {
    const inner = v4In(g[6]!, g[7]!);
    if (inner) return `${inner}, written as SIIT`;
  }
  if (g[0] === 0x2001 && g[1] === 0) return "a Teredo tunnel address (2001::/32)";
  // IPv4 carried inside IPv6: `::ffff:a.b.c.d`, and the older `::a.b.c.d`.
  // `new URL` prints the first as `[::ffff:7f00:1]`, so it is read from the
  // groups, not from the spelling.
  if ((leadingZeros(5) && g[5] === 0xffff) || leadingZeros(6)) {
    const inner = privateV4([g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff]);
    if (inner) return `${inner}, written as IPv6`;
  }
  return undefined;
}

/** Whether a string is an IP address at all, of either family. */
function isIpLiteral(host: string): boolean {
  return ipv4Octets(host) !== undefined || ipv6Groups(host) !== undefined;
}

/**
 * Why an IP address is not a public one, or undefined when it is (or when the
 * string is not an address). Exported for the unit suite.
 */
export function privateAddressReason(address: string): string | undefined {
  const v4 = ipv4Octets(address);
  if (v4) return privateV4(v4);
  const v6 = ipv6Groups(address);
  return v6 ? privateV6(v6) : undefined;
}

/**
 * The addresses a name answers with — or why the guard could not find out.
 *
 * A name that DOES NOT EXIST (ENOTFOUND, ENODATA) is let through: there is
 * nothing behind it to protect, and the fetch fails on its own with the
 * engine's account of why. Anything else — a resolver that timed out, a
 * temporary failure (EAI_AGAIN), an error with no code — is a check that did
 * not happen, and is refused: reading it as "does not resolve" let a name
 * through unchecked whenever DNS stuttered, and the fetch that followed
 * resolved it afresh.
 */
async function resolved(hostname: string, resolve: HostResolver): Promise<{ addresses: string[] } | { failure: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ failure: string }>((done) => {
    timer = setTimeout(() => done({ failure: `resolving it took longer than ${RESOLVE_TIMEOUT_MS / 1000} s` }), RESOLVE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([resolve(hostname).then((addresses) => ({ addresses })), late]);
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === "ENOTFOUND" || code === "ENODATA") return { addresses: [] };
    return { failure: `resolving it failed (${code ?? (e as Error)?.message ?? "unknown error"})` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Why this URL must not be fetched, as a clause a note can print — or undefined
 * when it may be.
 *
 * Callers report the answer as a REFUSAL, in these words. It is this tool
 * declining to send a request, which says nothing about whether the host is up:
 * filing it under "unreachable" would put a decision of ours on a company's
 * record as a fact about its website.
 */
export async function publicUrlRefusal(url: string, resolve: HostResolver = hostResolver): Promise<string | undefined> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "it is not a URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return `its scheme (${parsed.protocol.replace(/:$/, "")}) is not http or https`;
  if (privateHostsAllowed()) return undefined;

  // `new URL` has already normalised the odd spellings of an IPv4 address
  // (`2130706433`, `0x7f.1`, `127.1`) into dotted form, so one reading suffices.
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return `${host} is this machine`;
  if (host.endsWith(".local") || host.endsWith(".internal")) return `${host} is a name on a private network`;
  const literal = privateAddressReason(host);
  if (literal) return `${host} is ${literal}`;
  if (isIpLiteral(host)) return undefined;

  const answer = await resolved(host, resolve);
  if ("failure" in answer) return `${host} could not be checked: ${answer.failure}`;
  for (const address of answer.addresses) {
    const why = privateAddressReason(address);
    if (why) return `${host} resolves to ${address}, ${why}`;
  }
  return undefined;
}

// One function object for the life of the process: the engine keeps a separate
// robots.txt cache per authorizer it is handed, keyed on its identity.
const authorizePublicUrl = async (url: string): Promise<boolean> => (await publicUrlRefusal(url)) === undefined;

/**
 * The guard in the shape the engine's `authorizeUrl` option takes: asked for
 * the first URL and for every redirect after it.
 *
 * Undefined once the operator has opted out, so the engine is handed no hook at
 * all and keeps the paths a hook turns off (its Firecrawl and browser rungs
 * fetch on their own, where no hop can be vetted).
 */
export function publicUrlAuthorizer(): ((url: string) => Promise<boolean>) | undefined {
  return privateHostsAllowed() ? undefined : authorizePublicUrl;
}

/**
 * The guard for ONE request, remembering what it refused.
 *
 * The engine answers a vetoed request with status 0 and an error string — the
 * same shape as a host that never answered. The caller has to be able to say
 * which of the two happened, so the hook it hands over keeps the reason, and
 * says when the refusal was a redirect rather than the URL that was asked for.
 */
export function hopGuard(url: string): { authorizeUrl: ((target: string) => Promise<boolean>) | undefined; refusal: () => string | undefined } {
  let refused: string | undefined;
  if (privateHostsAllowed()) return { authorizeUrl: undefined, refusal: () => undefined };
  return {
    authorizeUrl: async (target) => {
      const why = await publicUrlRefusal(target);
      if (why) refused = target === url ? why : `it redirects to ${target}, and ${why}`;
      return why === undefined;
    },
    refusal: () => refused,
  };
}
