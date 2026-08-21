#!/usr/bin/env node
// Two suites, answering two different questions.
//
//   --suite offline   Does the PIPELINE still work? Replays a recorded sweep
//                     through the committed bundle and asserts the invariants
//                     that matter downstream. Deterministic, no network, runs
//                     in CI on every push.
//
//   --suite network   Do the UPSTREAMS still speak the shape we parse? Five
//                     public APIs, none of them ours, all free to change a
//                     field name without telling anyone. These are canaries,
//                     not gates: they are opt-in, and a red run means "go look
//                     at the API", not "the code is broken".
//
// Keeping them apart is the point. A network assertion inside the unit gate
// turns every Overpass outage into a failed build, and after the third false
// alarm nobody reads the gate any more.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const engine = join(root, "scripts", "ultraprospect.mjs");
const suite = process.argv.includes("--suite") ? process.argv[process.argv.indexOf("--suite") + 1] : "offline";

let failures = 0;
let checks = 0;

function check(name, condition, detail = "") {
  checks++;
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function run(args) {
  return execFileSync(process.execPath, [engine, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function offline() {
  console.log("eval: offline pipeline (recorded sweep, no network)\n");
  const fixture = join(root, "assets", "fixtures", "vincennes");
  if (!existsSync(fixture)) {
    console.error(`eval: missing fixture ${fixture}`);
    process.exit(1);
  }

  const out = mkdtempSync(join(tmpdir(), "ultraprospect-eval-"));
  const stdout = run(["scan", "--fixture", fixture, "--out", out, "--json"]);
  const result = JSON.parse(stdout);
  const runDir = result.run;

  check("scan produced a run directory", existsSync(runDir), runDir);
  check("manifest.json exists", existsSync(join(runDir, "manifest.json")));
  check("places.json exists", existsSync(join(runDir, "places.json")));
  check("MATCH.todo.json exists", existsSync(join(runDir, "MATCH.todo.json")));

  const manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));
  const places = JSON.parse(readFileSync(join(runDir, "places.json"), "utf8"));
  const todo = JSON.parse(readFileSync(join(runDir, "MATCH.todo.json"), "utf8"));

  check("the replayed run is not marked truncated", manifest.truncated === false);
  check("the manifest carries the upstream attributions", manifest.licences?.some((l) => l.includes("ODbL")), "ODbL attribution must travel with OSM data");
  check("every lane reported its coverage", manifest.lanes?.length === 2);

  // Fusion invariants — the ones a downstream consumer would be wrong without.
  check("fusion produced fewer entities than the two lanes summed", places.length < manifest.counts.osm + manifest.counts.registry, `${places.length} places`);
  check("at least one pair matched across both lanes", manifest.counts.merged > 0, `${manifest.counts.merged} merged`);
  check("place ids are unique", new Set(places.map((p) => p.id)).size === places.length);
  check(
    "every merged place carries both lane records",
    places.filter((p) => p.sources.length > 1).every((p) => p.osm && p.registry),
    "a place claiming two sources must hold both",
  );
  check(
    "no place claims a source it has no record for",
    places.every((p) => (!p.sources.includes("registry") || p.registry) && (!p.sources.includes("osm") || p.osm)),
  );
  check(
    "no register record was merged into two different places",
    (() => {
      const keys = places.filter((p) => p.registry).map((p) => `${p.registry.connectorId}:${p.registry.establishmentId ?? p.registry.id}`);
      return new Set(keys).size === keys.length;
    })(),
  );
  check(
    "an OSM website is recorded as declared, never as corroborated",
    places.filter((p) => p.website).every((p) => p.website.confidence === "declared"),
    "only `resolve` may upgrade a website's confidence",
  );

  // The adjudication file is the matcher's refusal to guess. It must be usable.
  check("undecided pairs are sorted strongest first", todo.pairs.every((p, i, a) => i === 0 || a[i - 1].score >= p.score));
  check(
    "every undecided pair names the register name that actually scored",
    todo.pairs.filter((p) => p.parts.name > 0).every((p) => typeof p.matchedName === "string" && p.matchedName.length > 0),
    "showing the legal name instead makes a correct pair look wrong",
  );

  // Determinism: the same fixture must produce the same fusion, twice.
  const second = JSON.parse(run(["scan", "--fixture", fixture, "--out", out, "--json"]));
  const placesAgain = JSON.parse(readFileSync(join(second.run, "places.json"), "utf8"));
  check("a replayed sweep is deterministic", JSON.stringify(places.map((p) => p.id)) === JSON.stringify(placesAgain.map((p) => p.id)));
}

async function network() {
  console.log("eval: network canaries (live upstreams — a red run means go look at the API)\n");
  // From the BUILT BUNDLE, so the canary probes the client this skill actually
  // ships rather than a second implementation that could drift from it.
  const bundle = await import(join(root, "scripts", "ultraprospect.mjs"));
  const ua = typeof bundle.politeUa === "function" ? bundle.politeUa() : "ultraprospect-eval (+https://github.com/maxgfr/ultraprospect)";
  const get = async (url) => {
    const res = await fetch(url, { headers: { "user-agent": ua } });
    return { status: res.status, body: await res.text() };
  };

  // ---- The upstreams that are not register connectors ------------------------
  // Geocoding, OSM and the job boards belong to no country's register, so they
  // stay written out here.
  const nominatim = await get("https://nominatim.openstreetmap.org/search?q=Vincennes&format=jsonv2&limit=1&addressdetails=1");
  const nomJson = JSON.parse(nominatim.body);
  check("nominatim still returns boundingbox + osm_type", Boolean(nomJson[0]?.boundingbox && nomJson[0]?.osm_type));
  check("nominatim still returns address.country_code", Boolean(nomJson[0]?.address?.country_code));

  const ban = await get("https://api-adresse.data.gouv.fr/search/?q=8+bd+du+port+Amiens&limit=1");
  check("BAN still returns properties.citycode", Boolean(JSON.parse(ban.body)?.features?.[0]?.properties?.citycode));

  // ---- The register connectors, driven by the connector table itself --------
  //
  // NOT a hand-written list. `CONNECTORS` is the single source of truth for
  // which register serves which country, and five things read it: the sweep
  // lane, `confirm`, `doctor`, `manifest.licences` and this. Adding a country
  // adds its canary, with nothing to remember — the same principle
  // engine-repin.yml already states about `sync-engine.mjs --list`: "the
  // automation cannot drift from the list it is supposed to be watching."
  //
  // Each connector asserts the shape ITS OWN parser depends on, including the
  // two undocumented French behaviours the whole anti-cap split ladder rests
  // on: the 10 000 clamp on total_results, and /near_point silently ignoring
  // filters it does not implement.
  const connectors = bundle.CONNECTORS ?? [];
  if (connectors.length === 0) {
    check("the connector table reached the eval", false, "the bundle exported no CONNECTORS — every register canary was skipped");
  }
  // Credentials come from the environment, read off each connector's own
  // `needsKey` declaration rather than a list written here — the same rule the
  // connector table already imposes on everything else that reads it. Without
  // this the canary passed `{}`, so a connector behind a key reported
  // INCONCLUSIVE even in a workflow that had been given the key.
  const keys = Object.fromEntries(connectors.filter((c) => c.needsKey?.env).map((c) => [c.id, process.env[c.needsKey.env]]));
  for (const connector of connectors) {
    let results;
    try {
      results = await connector.canary({ keys, onNote: () => {} });
    } catch (e) {
      check(`${connector.id} canary ran`, false, `threw: ${e?.message ?? e}`);
      continue;
    }
    for (const result of results) {
      // A connector that cannot be probed right now — no key, an upstream
      // between deployments — is INCONCLUSIVE, never red. The Overpass lesson
      // below is the same one: a canary that goes red for somebody else's
      // afternoon is a canary people learn to ignore.
      if (result.inconclusive) {
        console.log(`  --    ${connector.id}: ${result.name}${result.detail ? ` — ${result.detail}` : ""}`);
        continue;
      }
      check(`${connector.id}: ${result.name}`, result.ok, result.detail);
    }
  }

  // What this canary is actually asking: does an identifying User-Agent still
  // get served? The reference instance answers 406 to a browser string, and if
  // that policy ever flipped the whole net.ts rationale would be stale.
  //
  // A 504 does not answer that question either way — it is the instance being
  // busy, which it is most afternoons. Reporting it as drift means opening an
  // issue for somebody else's load, and after the second one nobody reads the
  // canary. So mirrors are tried until one gives a DEFINITIVE answer, and an
  // all-busy round is reported as inconclusive rather than as failure.
  const OVERPASS_PING = "[out:json][timeout:25];node[amenity=cafe](48.8550,2.3300,48.8680,2.3550);out count;";
  const mirrors = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
  let verdict;
  for (const mirror of mirrors) {
    let res;
    try {
      res = await get(`${mirror}?data=${encodeURIComponent(OVERPASS_PING)}`);
    } catch {
      continue;
    }
    if (res.status === 200 && res.body.trimStart().startsWith("{")) {
      verdict = { ok: true, detail: `${new URL(mirror).host} served an identifying User-Agent` };
      break;
    }
    if (res.status === 406 || res.status === 403) {
      verdict = { ok: false, detail: `${new URL(mirror).host} REFUSED an identifying User-Agent (HTTP ${res.status}) — the policy changed` };
      break;
    }
    // 504, 502, a timeout: busy. Try the next one.
  }
  if (verdict) check(`overpass ${verdict.ok ? "still serves" : "now REFUSES"} an identifying User-Agent`, verdict.ok, verdict.detail);
  else console.log("  --    overpass: every mirror was busy — inconclusive, not drift");

  // ---- The ATS boards --------------------------------------------------------
  //
  // The fifth upstream, and until now the only one nothing probed. It decides
  // whether `isHiring` is a finding or an absence: a board that changed shape
  // makes every company look like it is not hiring, which is precisely the
  // failure the skill promises not to make.
  const greenhouse = await get("https://boards-api.greenhouse.io/v1/boards/gitlab/jobs");
  const ghJson = JSON.parse(greenhouse.body || "{}");
  check(
    "greenhouse still returns jobs[] with title and absolute_url",
    Array.isArray(ghJson?.jobs) && ghJson.jobs.length > 0 && Boolean(ghJson.jobs[0]?.title),
    "if this drifts, every company on Greenhouse reads as not hiring",
  );

  const lever = await get("https://api.lever.co/v0/postings/leverdemo?mode=json");
  const leverJson = JSON.parse(lever.body || "[]");
  check(
    "lever still returns an array of postings with text and hostedUrl",
    Array.isArray(leverJson) && leverJson.length > 0 && Boolean(leverJson[0]?.text),
    "if this drifts, every company on Lever reads as not hiring",
  );

  // Personio is the ATS most German SMEs run, and the only upstream here that
  // answers XML. Two things are asserted, because the parser depends on both:
  // the <position> envelope, and the fact that <name> occurs INSIDE
  // <jobDescriptions> as well as as the title. If Personio ever flattened that
  // nesting, every German opening would ship titled after a description block.
  const personio = await get("https://personio-sog.jobs.personio.de/xml");
  const positions = [...(personio.body || "").matchAll(/<position>([\s\S]*?)<\/position>/gi)];
  check(
    "personio still serves <position> blocks with <name> and <createdAt>",
    positions.length > 0 && /<name>/.test(positions[0][1]) && /<createdAt>/.test(positions[0][1]),
    "if this drifts, every company on Personio reads as not hiring — that is most of German SME hiring",
  );
  check(
    "personio still nests a second <name> inside <jobDescriptions>",
    /<jobDescriptions>[\s\S]*?<name>/i.test(positions[0]?.[1] ?? ""),
    "the parser strips <jobDescriptions> before reading the title BECAUSE of this nesting; if it is gone the strip is dead code, not a bug",
  );

  const smart = await get("https://api.smartrecruiters.com/v1/companies/smartrecruiters/postings?limit=1");
  const smartJson = JSON.parse(smart.body || "{}");
  check(
    "smartrecruiters still returns content[] with name and releasedDate",
    Array.isArray(smartJson?.content) && smartJson.content.length > 0 && Boolean(smartJson.content[0]?.name),
    "if this drifts, every company on SmartRecruiters reads as not hiring",
  );
}

if (suite === "offline") await offline();
else if (suite === "network") await network();
else {
  console.error(`eval: unknown suite "${suite}" — expected offline or network`);
  process.exit(2);
}

console.log(`\neval: ${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
