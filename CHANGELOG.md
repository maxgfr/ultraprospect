# Changelog

All notable changes to this project are documented here, generated automatically from the [Conventional Commits](https://www.conventionalcommits.org/) by [semantic-release](https://github.com/semantic-release/semantic-release).

# [3.11.0](https://github.com/maxgfr/ultraprospect/compare/v3.10.0...v3.11.0) (2026-09-03)


### Features

* **match:** join OSM ref:FR:SIRET / ref:FR:SIREN to the register before scoring ([fb73141](https://github.com/maxgfr/ultraprospect/commit/fb7314143156fafab1c2b5da8ed297e912db8c23))
* **overpass:** industrial catalogue group, commercial leisure and tourism, no ATMs ([83b747d](https://github.com/maxgfr/ultraprospect/commit/83b747dededeae8cd11a39974d639a0e83223dd0))
* **scan:** carry OSM-declared contacts with an osm:<id> source the gate re-reads ([cecd33d](https://github.com/maxgfr/ultraprospect/commit/cecd33d27eb6a7afeb1278cfc09e9d1d32e34c81))
* **scan:** say when fusion could not run and when a filter reached one lane ([9bc65f8](https://github.com/maxgfr/ultraprospect/commit/9bc65f8350c5a62da26b0e2b42e7a939a150c234))
* **scan:** trim the OSM lane to the --radius circle ([a8040d5](https://github.com/maxgfr/ultraprospect/commit/a8040d52512db4e7236bd18e422e06c1d11493b1))
* **sirene:** --legal-form / --exclude-legal-form, and public bodies by filed legal form ([373b3c1](https://github.com/maxgfr/ultraprospect/commit/373b3c15e1bda38cbcd140dd6438f80eb21384a6))
* **sirene:** spread --max-results across NACE sections and record sectionTotals ([5e57386](https://github.com/maxgfr/ultraprospect/commit/5e573868abdf8bbbeb5295508f68ccb4ca4b7711))

# [3.10.0](https://github.com/maxgfr/ultraprospect/compare/v3.9.0...v3.10.0) (2026-09-03)


### Features

* **engine:** re-pin vendored engines ([59eabcd](https://github.com/maxgfr/ultraprospect/commit/59eabcdd3c9cbe458a3b135de99b2d2996d28c9d))

# [3.9.0](https://github.com/maxgfr/ultraprospect/compare/v3.8.0...v3.9.0) (2026-09-02)


### Features

* **engine:** re-pin vendored engines ([50fb472](https://github.com/maxgfr/ultraprospect/commit/50fb472aa93c3ae8aeeca548c6c1853fd25797a6))

# [3.8.0](https://github.com/maxgfr/ultraprospect/compare/v3.7.0...v3.8.0) (2026-09-01)


### Bug Fixes

* **test:** do not collect the suite from .claude/worktrees ([e759b7e](https://github.com/maxgfr/ultraprospect/commit/e759b7eeeca9656e53539e207e73e5e599c4607a))


### Features

* **resolve,sirene:** evidence-first query angles, social-only presence, honest truncation ([47eb5e7](https://github.com/maxgfr/ultraprospect/commit/47eb5e7a8736fd8702057bd91e57a094c2a112e4))
* **resolve,sirene:** search on evidence rather than hope, and name what a truncation actually cost ([82858f7](https://github.com/maxgfr/ultraprospect/commit/82858f77ca45b62e4de1954fbe9619edfdc4ac88))
* **scan,resolve:** aim both lanes with one --category, and stop spending searches on rows that cannot buy ([5b6a44b](https://github.com/maxgfr/ultraprospect/commit/5b6a44b14ec18da1a56a49059d946dc570aeee72))
* **scan,resolve:** cross-lane --category targeting and search-budget skips ([041b9de](https://github.com/maxgfr/ultraprospect/commit/041b9de6248b6c005d39373c6f98fd9f28084920))

# [3.7.0](https://github.com/maxgfr/ultraprospect/compare/v3.6.0...v3.7.0) (2026-08-31)


### Features

* **engine:** re-pin vendored engines ([10046bb](https://github.com/maxgfr/ultraprospect/commit/10046bb801186dc26c436d308b343e739b947f30))

# [3.6.0](https://github.com/maxgfr/ultraprospect/compare/v3.5.1...v3.6.0) (2026-08-26)


### Features

* **engine:** re-pin vendored engines ([4a9bdff](https://github.com/maxgfr/ultraprospect/commit/4a9bdffbb4e12510039e538421f9a317529672e8))

## [3.5.1](https://github.com/maxgfr/ultraprospect/compare/v3.5.0...v3.5.1) (2026-08-25)


### Bug Fixes

* make ultraprospect compatible with Codex ([2507141](https://github.com/maxgfr/ultraprospect/commit/250714174c11e5d2250c3b8c597da52f9d4dfc0d))

# [3.5.0](https://github.com/maxgfr/ultraprospect/compare/v3.4.0...v3.5.0) (2026-08-23)


### Bug Fixes

* **excerpts:** collect the legal identifier's page too ([0a1d802](https://github.com/maxgfr/ultraprospect/commit/0a1d802b6409463be650537c37f122d82c80b6c4))
* **html:** a citation you cannot open is not a source ([1a1ecaa](https://github.com/maxgfr/ultraprospect/commit/1a1ecaae486404ad4f61b2017355ade40b5f98b1))
* **html:** source the last three places that printed a bare page id ([bb33372](https://github.com/maxgfr/ultraprospect/commit/bb33372cc4b21c8c72c87644277301e2852f8ed1))
* **people:** a department is not a person, and a link wrapper is not a name ([876ff3e](https://github.com/maxgfr/ultraprospect/commit/876ff3e42259cae765ae08e2b6c7f2dbf4784bbf))
* **registry:** a sourceUrl opens THAT record, or the connector emits none ([988ed40](https://github.com/maxgfr/ultraprospect/commit/988ed40ad1278a143ccb1b1f9e16bb09e6109fb2))


### Features

* **people:** fill the field that has always been read and never written ([10ea6cc](https://github.com/maxgfr/ultraprospect/commit/10ea6ccec94410f19cf1242c14d4905fb4fa602c))

# [3.4.0](https://github.com/maxgfr/ultraprospect/compare/v3.3.1...v3.4.0) (2026-08-23)


### Bug Fixes

* **html:** the page bound its script to the Coverage table, so nothing responded ([056704c](https://github.com/maxgfr/ultraprospect/commit/056704c2cd7de636778decc9b01157552bd5ebd8))


### Features

* **html:** pool every opening into one list instead of a count per company ([a180bda](https://github.com/maxgfr/ultraprospect/commit/a180bda27c0e8ad32096ab4c09d0f32ae32e226c))

## [3.3.1](https://github.com/maxgfr/ultraprospect/compare/v3.3.0...v3.3.1) (2026-08-23)


### Bug Fixes

* **ats:** personio serves two feeds, and /xml is not the one every board has ([0207e07](https://github.com/maxgfr/ultraprospect/commit/0207e07cff8d2164dd2e4152745587d94293d544))
* **html:** map points drawn below the visibility threshold, in both themes ([512f24a](https://github.com/maxgfr/ultraprospect/commit/512f24af15aaaa717c964bc1bd270e4959e68630)), closes [#6b7688](https://github.com/maxgfr/ultraprospect/issues/6b7688) [#79839a](https://github.com/maxgfr/ultraprospect/issues/79839a)

# [3.3.0](https://github.com/maxgfr/ultraprospect/compare/v3.2.0...v3.3.0) (2026-08-23)


### Bug Fixes

* **cli:** --help says --phase takes resolve, which it has always accepted ([c98fe42](https://github.com/maxgfr/ultraprospect/commit/c98fe42bed7f9b682d298cc374273bf71df6c709))


### Features

* **orchestrate:** send each fan-out phase to the model its failure mode deserves ([2e9c4d4](https://github.com/maxgfr/ultraprospect/commit/2e9c4d4ee5ef1268bb0a867a937ef24e718742f9))
* **resolve:** --only, because --limit is a prefix and not a choice ([668fb64](https://github.com/maxgfr/ultraprospect/commit/668fb643d126a6e199a1f362256f180d5d005f78))

# [3.2.0](https://github.com/maxgfr/ultraprospect/compare/v3.1.2...v3.2.0) (2026-08-22)


### Features

* **html:** answer the question the run was asked, and carry the evidence ([7dedf8a](https://github.com/maxgfr/ultraprospect/commit/7dedf8a30652cb255c245045ed88e4d6da5e4b3c))
* **render:** show the run, instead of a summary of it ([536a4f8](https://github.com/maxgfr/ultraprospect/commit/536a4f8262376883ab1525db3db8ae059482419d))

## [3.1.2](https://github.com/maxgfr/ultraprospect/compare/v3.1.1...v3.1.2) (2026-08-21)


### Bug Fixes

* **resolve:** a shared doorway is not evidence, and a substring is not a name ([84fbca4](https://github.com/maxgfr/ultraprospect/commit/84fbca498a7ea8178334fb6b9f75c95ed003ff94))

## [3.1.1](https://github.com/maxgfr/ultraprospect/compare/v3.1.0...v3.1.1) (2026-08-21)


### Bug Fixes

* **resolve:** a host that turned us away is not a site we could not read ([ab1de47](https://github.com/maxgfr/ultraprospect/commit/ab1de47f5570b71143d0fece454bc8277f382e37))
* **resolve:** repeat what the search cascade says, instead of an empty result ([3854c7a](https://github.com/maxgfr/ultraprospect/commit/3854c7ad15fa60a4b9b5a51b1f3e8b644a0c098a))

# [3.1.0](https://github.com/maxgfr/ultraprospect/compare/v3.0.1...v3.1.0) (2026-08-21)


### Bug Fixes

* **check:** re-read a legal identifier the way the page writes it ([94439b9](https://github.com/maxgfr/ultraprospect/commit/94439b9c838242149c9fe46c9922486779e86645))
* **signals:** a contractor term only counts on the page where it means hiring ([eeeaf9f](https://github.com/maxgfr/ultraprospect/commit/eeeaf9f9bc17effc0c9f507511859895fdbd03dc))
* **signals:** an evergreen posting is not a role nobody could fill ([b1e0cdd](https://github.com/maxgfr/ultraprospect/commit/b1e0cddaa2ebb3265874c4e167eb813ed15f7cdf))
* **tests:** the legal-id fixture was missing its status field ([7e2d1fa](https://github.com/maxgfr/ultraprospect/commit/7e2d1faa47d93a547342ceb36e9abfa6178ba1ae))


### Features

* **ats,signals:** read the German boards, and measure who buys contract work ([181dcc3](https://github.com/maxgfr/ultraprospect/commit/181dcc3e4b3b8b5bd8a3e8fd2e3b6a4f65392363))
* **render:** the page is usable at the size a real run produces ([18b2c40](https://github.com/maxgfr/ultraprospect/commit/18b2c408575802af11c31e593ea9f680e00d605b))
* **signals:** make the contractor signal multilingual, and stop encoding one brief ([56a43ad](https://github.com/maxgfr/ultraprospect/commit/56a43adf650ff4feb3a88147a49e760e58c49ac0))

## [3.0.1](https://github.com/maxgfr/ultraprospect/compare/v3.0.0...v3.0.1) (2026-08-14)


### Bug Fixes

* **ingest:** the gate could not see the index it had just written ([296af48](https://github.com/maxgfr/ultraprospect/commit/296af489cde4ed9c561ac01f26c5df9b13ed4ff0))

# [3.0.0](https://github.com/maxgfr/ultraprospect/compare/v2.0.0...v3.0.0) (2026-08-12)


* feat(ingest,registry,mcp)!: keyless open registers for the UK and Germany ([501354d](https://github.com/maxgfr/ultraprospect/commit/501354d763f909bc9255fc609c3a0ec8a9c7d71c))


### Bug Fixes

* **doctor,confirm,registry:** a diagnostic that uses the key it was handed ([c58de60](https://github.com/maxgfr/ultraprospect/commit/c58de606b7c98540e7ffce42efb1a8525f8ea8bc))
* **gb:** two SIC codes are not activities, and a cache can outlive its mapper ([9e77595](https://github.com/maxgfr/ultraprospect/commit/9e77595817c1efa993bc7044ab59091622c412a8))
* **render,watch:** derive the coverage sentence, never claim a sweep ([8dd3103](https://github.com/maxgfr/ultraprospect/commit/8dd310382cd0dcd592892c18d925e201e7a1a9ba))
* **run:** a confirm run owes every answering register's attribution ([9ff71d2](https://github.com/maxgfr/ultraprospect/commit/9ff71d2b05f545bf5ae1c2a0b30745171fa6f418))
* **skill:** bring the description back under the frontmatter cap ([0964001](https://github.com/maxgfr/ultraprospect/commit/0964001fd681c6510379a400c63c0617b30ceaa3))
* **snapshot:** stamp the on-disk layout, not only the tool version ([e9ab374](https://github.com/maxgfr/ultraprospect/commit/e9ab3745bb4999e1a733fc8f7f8738b75f1078db))


### Features

* **check,render,csv:** a dated record is a fact about its date ([115a9ae](https://github.com/maxgfr/ultraprospect/commit/115a9ae309d2f9d42094534d294dd1899c52233c))
* **ci,ingest:** prove today's file still works, and say when a cache is behind ([b466e5f](https://github.com/maxgfr/ultraprospect/commit/b466e5ff558b205f33d39d9a5c186352ab8bcfb7))
* **ee:** Estonia — the freshest register here, and the fussiest file ([78970ed](https://github.com/maxgfr/ultraprospect/commit/78970edb9aa58ee1f86a2254d135323837b80c1e))
* **evals:** a canary on the route that actually runs ([a8e5b68](https://github.com/maxgfr/ultraprospect/commit/a8e5b68de75dbaea5fe23b70fca76ed511c295e9))


### BREAKING CHANGES

* `gb-companies-house` declares `sweep`, so a UK run's register
lane reports `mode: "sweep"` where it previously reported none. Anything reading
`mode` to decide whether a territory was enumerated must also read the lane's
`reason`, which names the shape that was enumerated.

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
