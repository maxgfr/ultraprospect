// `doctor` — is every upstream this run needs reachable right now?
//
// This skill depends entirely on public services it does not own, several of
// them volunteer-run. When a run comes back thin the first question is always
// whether the data was missing or the service was down, and answering it after
// the fact is impossible. So `doctor` asks each of them the cheapest question
// it will answer, and reports latency next to reachability — a mirror that
// takes 40 seconds is technically up and practically unusable.
//
// The register probes come from `CONNECTORS` and are NARROWED TO THE COUNTRY
// asked about. Probing all nine for a run over Lyon would ask a row of public
// services about nothing, on exactly the day someone is running `doctor`
// because something is already slow.
import { EXIT_FAILURE, EXIT_OK, cacheDir, httpGet, httpJson } from "./engine.js";
import { CONNECTORS } from "./registry/index.js";
import { politeUa } from "./net.js";
import { OVERPASS_MIRRORS } from "./overpass.js";
import { VERSION } from "./version.js";

export interface DoctorProbe {
  name: string;
  target: string;
  ok: boolean;
  ms: number;
  detail: string;
  /** False when the run can still proceed without this one. */
  required: boolean;
  /** True when nothing was asked — a connector with no key, typically. Not a failure. */
  skipped?: boolean;
}

async function timed(fn: () => Promise<{ ok: boolean; detail: string }>): Promise<{ ok: boolean; detail: string; ms: number }> {
  const t0 = Date.now();
  try {
    const r = await fn();
    return { ...r, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, detail: (e as Error).message, ms: Date.now() - t0 };
  }
}

/**
 * A COUNTING query over central Paris — a place with a known, large answer.
 *
 * Two things are being tested at once, and the second is the one that matters:
 *
 *   1. Is the instance answering at all? A HEAD or a bare GET would only prove
 *      the web server is up; these instances fail by accepting the connection
 *      and then timing out inside the query engine, which is the failure a real
 *      run trips over.
 *   2. Does it hold the WHOLE PLANET? Several public endpoints serve a regional
 *      extract and answer an out-of-region query with 200 and zero elements.
 *      A probe that only checks "did I get JSON" grades those as healthy, and
 *      the run then reports an empty territory. Central Paris has hundreds of
 *      mapped cafés; an instance that finds none of them is a regional extract,
 *      and this probe says so in those words.
 *
 * `out count` keeps it to a few hundred bytes whatever the answer.
 */
const OVERPASS_PING = "[out:json][timeout:25];node[amenity=cafe](48.8550,2.3300,48.8680,2.3550);out count;";

/** Central Paris has hundreds. Anything below this is not a planet instance. */
const PLANET_FLOOR = 50;

/** Slow-but-alive instances queue for ~25 s even on a trivial query. */
const OVERPASS_PROBE_TIMEOUT_MS = 45_000;

async function probeOverpass(url: string): Promise<DoctorProbe> {
  const r = await timed(async () => {
    const res = await httpGet(`${url}?data=${encodeURIComponent(OVERPASS_PING)}`, { timeoutMs: OVERPASS_PROBE_TIMEOUT_MS, userAgent: politeUa(), retries: 0 });
    const body = res.body ?? "";
    if (!body.trimStart().startsWith("{")) {
      const m = /<strong[^>]*>Error<\/strong>:\s*([^<]+)/i.exec(body);
      return { ok: false, detail: (m?.[1] ?? `HTTP ${res.status}`).replace(/\s+/g, " ").trim().slice(0, 90) };
    }
    const count = Number.parseInt(JSON.parse(body)?.elements?.[0]?.tags?.nodes ?? "0", 10);
    if (!Number.isFinite(count) || count < PLANET_FLOOR) {
      return { ok: false, detail: `regional extract, not planet-wide (${count} cafés in central Paris) — excluded` };
    }
    return { ok: true, detail: `planet data (${count} cafés in central Paris)` };
  });
  return { name: "overpass", target: new URL(url).host, required: false, ...r };
}

/**
 * @param countryCode Narrows the register probes to the country in play.
 *   Omitted, every connector is probed — then the question really is "which of
 *   these is up".
 */
export async function probeAll(countryCode?: string): Promise<DoctorProbe[]> {
  const probes: DoctorProbe[] = [];

  probes.push({
    name: "node",
    target: process.version,
    ok: Number.parseInt(process.versions.node.split(".")[0]!, 10) >= 18,
    ms: 0,
    detail: Number.parseInt(process.versions.node.split(".")[0]!, 10) >= 18 ? "supported" : "ultraprospect needs Node 18 or newer",
    required: true,
  });

  const nominatim = await timed(async () => {
    const res = await httpJson("GET", "https://nominatim.openstreetmap.org/search?q=paris&format=jsonv2&limit=1", undefined, {
      timeoutMs: 20_000,
      userAgent: politeUa(),
    });
    return { ok: res.ok && Array.isArray(res.data) && res.data.length > 0, detail: res.ok ? "geocodes" : `HTTP ${res.status}` };
  });
  probes.push({ name: "nominatim", target: "nominatim.openstreetmap.org", required: true, ...nominatim });

  const ban = await timed(async () => {
    const res = await httpJson("GET", "https://api-adresse.data.gouv.fr/search/?q=paris&limit=1", undefined, { timeoutMs: 15_000, userAgent: politeUa() });
    return { ok: res.ok && Array.isArray(res.data?.features), detail: res.ok ? "geocodes French addresses" : `HTTP ${res.status}` };
  });
  probes.push({ name: "ban", target: "api-adresse.data.gouv.fr", required: false, ...ban });

  // ---- The register connectors ----------------------------------------------
  //
  // Driven by the connector table, and NARROWED TO THE COUNTRY IN PLAY. Probing
  // all of them for a run over Lyon would ask nine public services about
  // nothing, which is discourteous and slow on exactly the day someone is
  // running `doctor` because something is already slow. Without a country the
  // whole table is probed, because then the question really is "which of these
  // is up".
  const applicable = countryCode ? CONNECTORS.filter((c) => c.countries.includes("*") || c.countries.includes(countryCode.toLowerCase())) : CONNECTORS;
  for (const connector of applicable) {
    const availability = connector.availability({});
    if (!availability.available) {
      // Not a failure. A connector needing a key it was not given is a fact
      // about this invocation, and `doctor` says what to do about it.
      probes.push({
        name: connector.id,
        target: new URL(connector.docsUrl).host,
        required: false,
        ok: true,
        skipped: true,
        detail: `${availability.reason}. ${availability.how ?? ""}`.trim(),
        ms: 0,
      });
      continue;
    }
    const probe = await timed(async () => {
      const result = await connector.probe({});
      return { ok: result.ok, detail: result.detail };
    });
    probes.push({ name: connector.id, target: new URL(connector.docsUrl).host, required: false, ...probe });
  }

  // Mirrors are probed in parallel: they are independent, and doing it serially
  // turns a diagnostic into a two-minute wait on exactly the bad day it is for.
  probes.push(...(await Promise.all(OVERPASS_MIRRORS.map(probeOverpass))));

  return probes;
}

export interface DoctorIo {
  json: boolean;
  out: (line: string) => void;
  say: (line: string) => void;
}

export async function runDoctor(io: DoctorIo, countryCode?: string): Promise<number> {
  const probes = await probeAll(countryCode);
  const overpass = probes.filter((p) => p.name === "overpass");
  const liveMirrors = overpass.filter((p) => p.ok).length;
  // Every required probe, plus at least one Overpass mirror — losing all of
  // them costs the worldwide lane entirely, so it is a hard failure even though
  // no single mirror is.
  const healthy = probes.filter((p) => p.required).every((p) => p.ok) && liveMirrors > 0;

  if (io.json) {
    io.out(JSON.stringify({ version: VERSION, cacheDir: cacheDir(), healthy, liveOverpassMirrors: liveMirrors, probes }, null, 2));
    return healthy ? EXIT_OK : EXIT_FAILURE;
  }

  io.out(`ultraprospect ${VERSION}`);
  io.out(`cache: ${cacheDir()}`);
  io.out("");
  for (const p of probes) {
    const mark = p.skipped ? "--  " : p.ok ? "ok  " : p.required ? "FAIL" : "down";
    const ms = p.ms ? `${String(p.ms).padStart(5)} ms` : "        ";
    io.out(`  ${mark}  ${p.name.padEnd(20)} ${ms}  ${p.target.padEnd(38)} ${p.detail}`);
  }
  io.out("");
  io.out(`  ${liveMirrors}/${overpass.length} Overpass mirrors answering`);
  if (countryCode) io.out(`  register connectors shown are the ones serving ${countryCode}; omit --country to probe them all`);

  if (!healthy) {
    io.say("");
    io.say("ultraprospect: an upstream this skill cannot work without is unreachable.");
    io.say("next: re-run `ultraprospect doctor` in a few minutes, or check your network");
    return EXIT_FAILURE;
  }
  if (liveMirrors < overpass.length) {
    io.say("");
    io.say(`note: ${overpass.length - liveMirrors} Overpass mirror(s) are down; runs will rotate onto the ones that answer.`);
  }
  return EXIT_OK;
}
