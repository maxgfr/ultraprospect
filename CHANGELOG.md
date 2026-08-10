# Changelog

All notable changes to this project are documented here, generated automatically from the [Conventional Commits](https://www.conventionalcommits.org/) by [semantic-release](https://github.com/semantic-release/semantic-release).

# [2.0.0](https://github.com/maxgfr/ultraprospect/compare/v1.4.4...v2.0.0) (2026-08-10)


* feat!: connectors with declared capabilities, in place of one line of France ([258ef8a](https://github.com/maxgfr/ultraprospect/commit/258ef8a83f40673918fb7acec15f0f01832289a7))


### Features

* **confirm:** the register identity a company is legally required to publish ([ed05dda](https://github.com/maxgfr/ultraprospect/commit/ed05ddafc0dd4dba0d617b88c243d33d3aa62a7d))
* **evals,doctor:** canaries that come from the connector table, not from a list ([0f6f910](https://github.com/maxgfr/ultraprospect/commit/0f6f910d07dcd31a401f93b653502afc4f99e35d))
* **registry:** eight connectors, and what each of them cannot do ([6facdd8](https://github.com/maxgfr/ultraprospect/commit/6facdd8ad615cf452d2177932fa73bf5486fac15))
* **resolve:** search the territory's language, and pool every angle ([b4672d7](https://github.com/maxgfr/ultraprospect/commit/b4672d7f90e8ef90cf35b51e8a1e1bb9e99d331e))


### BREAKING CHANGES

* `Lane` is now "osm" | "registry" | "web" | "agent";
`Place.sirene` is `Place.registry` (a `RegistryRecord`); `sirene.json` is
`registry.json`; `counts.sirene` is `counts.registry` plus `counts.byConnector`.
Flags: `--no-sirene` -> `--no-registry`, `--naf` -> `--activity`, `--effectif` ->
`--size-band`, `--min-effectif` -> `--min-employees`. Match verdicts take
`{osmId, registryId, connectorId?}` instead of `{osmId, siret|siren}`. Place ids
from the register are `<connectorId>:<establishmentId>`. CSV columns are renamed
and `revenue_eur` is now `revenue` + `revenue_currency`.

## [1.4.4](https://github.com/maxgfr/ultraprospect/compare/v1.4.3...v1.4.4) (2026-08-10)


### Bug Fixes

* **evals:** a canary that could not fail, and one that cried wolf ([9c17501](https://github.com/maxgfr/ultraprospect/commit/9c175017fc8fbab4aa37e7400205c47169a4c547))

## [1.4.3](https://github.com/maxgfr/ultraprospect/compare/v1.4.2...v1.4.3) (2026-08-10)


### Bug Fixes

* **ci:** green the red job, and make the WebSearch lane the main path ([1a32f0c](https://github.com/maxgfr/ultraprospect/commit/1a32f0c198dbec5eaaf0ab8b5949e26697f1cc68))

## [1.4.2](https://github.com/maxgfr/ultraprospect/compare/v1.4.1...v1.4.2) (2026-08-10)


### Bug Fixes

* three more defects, found by writing a real dossier end to end ([71f3c19](https://github.com/maxgfr/ultraprospect/commit/71f3c191eae770b1701e20c8a44cfe5c2338ae68))

## [1.4.1](https://github.com/maxgfr/ultraprospect/compare/v1.4.0...v1.4.1) (2026-08-10)


### Bug Fixes

* four defects found by running it on real territories ([c3f74c8](https://github.com/maxgfr/ultraprospect/commit/c3f74c866dd3fc25c2d7f46d1d4dd681b65d4377))

# [1.4.0](https://github.com/maxgfr/ultraprospect/compare/v1.3.0...v1.4.0) (2026-08-10)


### Features

* **orchestrate,mcp:** fan the judgement out, and serve the whole loop over MCP ([19a2bf3](https://github.com/maxgfr/ultraprospect/commit/19a2bf3bc4c57b26da7639dbde22dcd532a25abc))

# [1.3.0](https://github.com/maxgfr/ultraprospect/compare/v1.2.0...v1.3.0) (2026-08-10)


### Features

* **render:** the deliverables, and what changed since last time ([835af04](https://github.com/maxgfr/ultraprospect/commit/835af0447c6fbf7c5144e5637b3aebcefce03178))

# [1.2.0](https://github.com/maxgfr/ultraprospect/compare/v1.1.0...v1.2.0) (2026-08-10)


### Features

* **gate:** rank, write up, and refuse to ship what cannot be re-read ([cae9f34](https://github.com/maxgfr/ultraprospect/commit/cae9f348ee7ee9460cc75e83d79054f28afb4ad3))

# [1.1.0](https://github.com/maxgfr/ultraprospect/compare/v1.0.0...v1.1.0) (2026-08-10)


### Features

* **enrich:** read each company's site in two tiers, and its openings without a browser ([e309a85](https://github.com/maxgfr/ultraprospect/commit/e309a8500aabee18956253e112c6d1f5f2edfbad)), closes [services#web](https://github.com/services/issues/web)
* **resolve:** find each company's website and prove it is theirs ([7e8c526](https://github.com/maxgfr/ultraprospect/commit/7e8c5260beff83abb5821a14b9cf40dc7cf81214))

# 1.0.0 (2026-08-10)


### Features

* discover and fuse every company in a place, from OSM and the French register ([80ee2ed](https://github.com/maxgfr/ultraprospect/commit/80ee2ed2721edbab38ccad0eca631a1cc2829f06))
