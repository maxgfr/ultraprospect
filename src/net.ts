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
import { VERSION } from "./version.js";

export const CONTACT_URL = "https://github.com/maxgfr/ultraprospect";

/** The identifying User-Agent for OSM, Nominatim and data.gouv endpoints. */
export function politeUa(): string {
  return `ultraprospect/${VERSION} (+${CONTACT_URL})`;
}

/**
 * Request options every community-infrastructure call shares.
 *
 * `accept` is left to the caller: Overpass is content to negotiate, but some
 * instances behind a CDN answer 406 to an over-specific Accept, and the payload
 * is unambiguous anyway.
 */
export function politeRequest(timeoutMs: number): { userAgent: string; timeoutMs: number } {
  return { userAgent: politeUa(), timeoutMs };
}
