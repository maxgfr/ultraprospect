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
  check("fusion produced fewer entities than the two lanes summed", places.length < manifest.counts.osm + manifest.counts.sirene, `${places.length} places`);
  check("at least one pair matched across both lanes", manifest.counts.merged > 0, `${manifest.counts.merged} merged`);
  check("place ids are unique", new Set(places.map((p) => p.id)).size === places.length);
  check(
    "every merged place carries both lane records",
    places.filter((p) => p.sources.length > 1).every((p) => p.osm && p.sirene),
    "a place claiming two sources must hold both",
  );
  check(
    "no place claims a source it has no record for",
    places.every((p) => (!p.sources.includes("sirene") || p.sirene) && (!p.sources.includes("osm") || p.osm)),
  );
  check(
    "no register record was merged into two different places",
    (() => {
      const sirets = places.filter((p) => p.sirene?.siret).map((p) => p.sirene.siret);
      return new Set(sirets).size === sirets.length;
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
  const { politeUa } = await import(join(root, "scripts", "ultraprospect.mjs")).catch(() => ({ politeUa: undefined }));
  const ua = typeof politeUa === "function" ? politeUa() : "ultraprospect-eval (+https://github.com/maxgfr/ultraprospect)";
  const get = async (url) => {
    const res = await fetch(url, { headers: { "user-agent": ua } });
    return { status: res.status, body: await res.text() };
  };

  const nominatim = await get("https://nominatim.openstreetmap.org/search?q=Vincennes&format=jsonv2&limit=1&addressdetails=1");
  const nomJson = JSON.parse(nominatim.body);
  check("nominatim still returns boundingbox + osm_type", Boolean(nomJson[0]?.boundingbox && nomJson[0]?.osm_type));
  check("nominatim still returns address.country_code", Boolean(nomJson[0]?.address?.country_code));

  const ban = await get("https://api-adresse.data.gouv.fr/search/?q=8+bd+du+port+Amiens&limit=1");
  check("BAN still returns properties.citycode", Boolean(JSON.parse(ban.body)?.features?.[0]?.properties?.citycode));

  const sirene = await get("https://recherche-entreprises.api.gouv.fr/search?q=doctolib&per_page=1");
  const sirJson = JSON.parse(sirene.body);
  check("register still returns results[].siege", Boolean(sirJson?.results?.[0]?.siege));
  check("register still returns matching_etablissements", Array.isArray(sirJson?.results?.[0]?.matching_etablissements));
  check("register still keys finances by year", Object.keys(sirJson?.results?.[0]?.finances ?? {}).every((k) => /^\d{4}$/.test(k)));

  // The two undocumented behaviours the SIRENE lane is built around. If either
  // ever changes, the splitter is doing unnecessary work — or worse, the wrong
  // work — and this is the only thing that would say so.
  const capped = await get("https://recherche-entreprises.api.gouv.fr/search?code_commune=94080&per_page=1");
  check(
    "register still CLAMPS total_results at 10 000",
    JSON.parse(capped.body)?.total_results === 10000,
    "if this changed, the NAF split ladder can trust the count again",
  );

  const withFilter = await get("https://recherche-entreprises.api.gouv.fr/near_point?lat=48.8566&long=2.3522&radius=0.3&etat_administratif=A&per_page=1");
  const without = await get("https://recherche-entreprises.api.gouv.fr/near_point?lat=48.8566&long=2.3522&radius=0.3&per_page=1");
  check(
    "/near_point still IGNORES etat_administratif",
    JSON.parse(withFilter.body)?.total_results === JSON.parse(without.body)?.total_results,
    "if it now honours it, the client-side filter is redundant",
  );

  const overpass = await get(
    `https://overpass-api.de/api/interpreter?data=${encodeURIComponent("[out:json][timeout:25];node[amenity=cafe](48.8550,2.3300,48.8680,2.3550);out count;")}`,
  );
  check("overpass-api.de answers an identifying User-Agent", overpass.status === 200 && overpass.body.trimStart().startsWith("{"), `HTTP ${overpass.status}`);
}

if (suite === "offline") await offline();
else if (suite === "network") await network();
else {
  console.error(`eval: unknown suite "${suite}" — expected offline or network`);
  process.exit(2);
}

console.log(`\neval: ${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
