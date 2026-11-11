# Changelog

All notable changes to this project are documented here, generated automatically from the [Conventional Commits](https://www.conventionalcommits.org/) by [semantic-release](https://github.com/semantic-release/semantic-release).

## [3.18.1](https://github.com/maxgfr/ultraprospect/compare/v3.18.0...v3.18.1) (2026-11-11)


### Bug Fixes

* **engine:** update shared engines and maintenance tool ([6a20273](https://github.com/maxgfr/ultraprospect/commit/6a202731af9a5eb279d28ad6985e727baeecf17c))

# [3.18.0](https://github.com/maxgfr/ultraprospect/compare/v3.17.2...v3.18.0) (2026-11-11)


### Bug Fixes

* **ats:** count each posting once, not each job title once ([1b43d3b](https://github.com/maxgfr/ultraprospect/commit/1b43d3b10a73d0d5129fb9272d894bb957634519))
* **awards:** confirm a winner against the register of its own country ([404ffc0](https://github.com/maxgfr/ultraprospect/commit/404ffc0ae3c0aef6b018d54555baa4851ceb02f3))
* **brreg:** ask only about a well-formed organisation number ([fcce1a5](https://github.com/maxgfr/ultraprospect/commit/fcce1a57ac42c87e365691d2362303b6b8e740f8))
* **check:** hold a fenced block and a heading with a figure to a citation ([3fd32a0](https://github.com/maxgfr/ultraprospect/commit/3fd32a04f53793ffe175dbf1b94aad93f3ba1b8c))
* **check:** let a document's title and a section number carry a figure ([fbc3c06](https://github.com/maxgfr/ultraprospect/commit/fbc3c069c769cd1856b6e5568e506e2d22359de4))
* **cli:** run main when this module is the entry point, whatever the file is called ([13dab27](https://github.com/maxgfr/ultraprospect/commit/13dab2785d025b3cfeb18ba09853c5fe043aafa4))
* **confirm:** count a register that did not answer as not asked, not as not found ([4254f93](https://github.com/maxgfr/ultraprospect/commit/4254f931747cab70c5c0d071f5217a744236e4b1))
* **confirm:** keep an identifier whose authority named another company out of the attested count ([ee9dc71](https://github.com/maxgfr/ultraprospect/commit/ee9dc71da884b9142a1de2a5b1db84c6eda0a643))
* **confirm:** read a number only off a site proven to be this company's, and read a town as a town ([e4fb22e](https://github.com/maxgfr/ultraprospect/commit/e4fb22e906a00cc5373843c7ff10a116db1ce927))
* **confirm:** refuse to attach by name a record filed in another town ([577f01a](https://github.com/maxgfr/ultraprospect/commit/577f01a5d39c757282af2d52051937ce5a38ef1e))
* **edgar:** compare a company name in the same form on both sides ([86e2ba3](https://github.com/maxgfr/ultraprospect/commit/86e2ba3da0ba3b1781dd7c230b8c98f83635caac))
* **edgar:** fetch the ticker index once for concurrent first lookups ([3c7b87d](https://github.com/maxgfr/ultraprospect/commit/3c7b87d9fcb4a29631fb4cfcbbc4d3015b219ddf))
* **edgar:** return a company with two tickers once ([3e72307](https://github.com/maxgfr/ultraprospect/commit/3e72307bf9e890be39206e6cfcb3765d945e50a2))
* **geocode:** take the commune code of the candidate that was picked ([dd7d60f](https://github.com/maxgfr/ultraprospect/commit/dd7d60f3ebce0ff3b6cc40efaacbcb2f30797028))
* **ingest:** refuse a second ingest of a connector while one is running ([5dac196](https://github.com/maxgfr/ultraprospect/commit/5dac196948c9c25bdd43288dcbd51a2ca9c31e8d))
* **ingest:** take over a stale ingest lock by rename, not by deleting the path ([28cb83e](https://github.com/maxgfr/ultraprospect/commit/28cb83ea201f69b6cc235ee79f1e69ea8bb46c01))
* **ingest:** try the next candidate URL after a download cut off midway ([6412889](https://github.com/maxgfr/ultraprospect/commit/6412889c0e8f5d2350f04d2e09cbb28bf05f90a2))
* **krs:** read stanPozycji as a state code and say when an entity was struck off ([6aca1d9](https://github.com/maxgfr/ultraprospect/commit/6aca1d926a2b8c2d475b08e9ed828d0bf3d0791a))
* **legal-notice:** read a VAT prefix written apart from its digits ([e8e2109](https://github.com/maxgfr/ultraprospect/commit/e8e21091ffd12380177f4e9c1acb96554dba3f8d))
* **legal-notice:** stop a VAT number at the end of the number the page wrote ([c2c2aef](https://github.com/maxgfr/ultraprospect/commit/c2c2aef6e8baf16d349f8c3ccec13f97c99c46d5))
* **manifest:** count the dossiers on disk when check or render runs ([96bb7bb](https://github.com/maxgfr/ultraprospect/commit/96bb7bba411c1bef963b905da2fcbdbf752d0191))
* **manifest:** keep withWebsite as the sites on record, and count the proved ones apart ([039ca3e](https://github.com/maxgfr/ultraprospect/commit/039ca3e6f47380927c25211b7a247265eb9ff171))
* **markdown:** escape every outside value in the reports, not only table cells ([49d11b9](https://github.com/maxgfr/ultraprospect/commit/49d11b9b1480f581e2433a62ce566e3f5a486a57))
* **markdown:** keep the report's own emphasis, and leave an underscore inside a word alone ([5d07086](https://github.com/maxgfr/ultraprospect/commit/5d07086ee5836e58f17cb14629c2734bb81e4aca))
* **match:** fold an adjudication against its worklist, score and all ([aae721e](https://github.com/maxgfr/ultraprospect/commit/aae721e9bb25e1d332d398aa95a0bfe0a2d35468))
* **match:** let match --apply merge a pair that confirm sent to adjudication ([8ce35cb](https://github.com/maxgfr/ultraprospect/commit/8ce35cb699e9abc3bfea999a5c973be9eb724be1))
* **match:** widen the east-west candidate range with the latitude ([5f608b9](https://github.com/maxgfr/ultraprospect/commit/5f608b99c6b231a2ba65ac7f61bdc97da8cad6a7))
* **net:** fetch only public http(s) hosts, and report a refusal as one ([cf53bed](https://github.com/maxgfr/ultraprospect/commit/cf53bedbbc0c91b57943d3d27982a06cf7e97b7d))
* **net:** vet redirects on every fetch path, and refuse what the guard could not check ([e598d54](https://github.com/maxgfr/ultraprospect/commit/e598d54d9764cb4fc40f8277abb08759d5fd98f2))
* **oeffentlichevergabe:** reuse a cached daily export only once its day has settled ([817c032](https://github.com/maxgfr/ultraprospect/commit/817c0326b98b34e89e668f587df3b821dbf6a92d))
* **offeneregister:** refuse a register number the named court did not file ([9ca1b19](https://github.com/maxgfr/ultraprospect/commit/9ca1b1933821e45d178abb86c5955f3174e5c018))
* **overpass:** read a client timeout as a heavy query, not as a network outage ([1fe9f0e](https://github.com/maxgfr/ultraprospect/commit/1fe9f0e83b5502fec588c559f5692191527670c6))
* **overpass:** retry a boundary query refused for capacity, and say when the box was swept instead ([840a032](https://github.com/maxgfr/ultraprospect/commit/840a032a23c383df1571d8c3cc015b81a5beaf72))
* **overpass:** stop at a network outage instead of splitting the area to depth 3 ([811df10](https://github.com/maxgfr/ultraprospect/commit/811df10a9a6a63c1455395164bd9546a43138f94))
* **people:** do not read a partner company under a "Partner" caption as a person ([4fcd8b6](https://github.com/maxgfr/ultraprospect/commit/4fcd8b6619c9df0f36907c7696ea7e90e76e7bf4))
* **people:** read a collective label only where it introduces names ([84ab8ad](https://github.com/maxgfr/ultraprospect/commit/84ab8ad5138127b54e6c1810d3af8a6b0964a6ae))
* **people:** read a German board listed under Geschäftsführung ([4c7c18e](https://github.com/maxgfr/ultraprospect/commit/4c7c18e062df7d0c75ebc216e0b8ef5ae791b922))
* **privacy:** make --no-people at scan hold for every later stage ([e8e1550](https://github.com/maxgfr/ultraprospect/commit/e8e1550bcfb72bcd6303a9b4d301114d7a43406d))
* **registry:** read a 200 that is not JSON as no answer, and correct the csvRaw description ([5e3807c](https://github.com/maxgfr/ultraprospect/commit/5e3807c3102ac7b1e56acf6429a758e2019c247c))
* **render:** let --min-score and --min-fit cut every deliverable, and say so ([d82af56](https://github.com/maxgfr/ultraprospect/commit/d82af5639a6fbb0d53e4b030240eb829cea3e7df))
* **resolve:** name the registration number a refused page lacks in the run's own terms ([1c86b8a](https://github.com/maxgfr/ultraprospect/commit/1c86b8a470d769e53e1e99d05344a32367dc6c4e))
* **resolve:** read the legal notice when the home page does not corroborate ([cdcea03](https://github.com/maxgfr/ultraprospect/commit/cdcea03af7ffdc049d1c5d9c1c54db6a855683aa))
* **run:** create no directory when writing is off ([4bcdc3a](https://github.com/maxgfr/ultraprospect/commit/4bcdc3ad06cb44b979354d9bce83d5b5515c069e))
* **sirene:** sweep a box as the disc that covers it, trimmed back to the box ([8e52c93](https://github.com/maxgfr/ultraprospect/commit/8e52c93df2e1db46ba1841398be56c02ee659996))
* **snapshot:** close a shard a capped lookup stops reading ([aee16e8](https://github.com/maxgfr/ultraprospect/commit/aee16e83448bd6c0b2a851ab89fbf274b4672ef3))
* **ted:** bound the paging by the rows read, not only by the rows kept ([8801198](https://github.com/maxgfr/ultraprospect/commit/8801198d4a7a130674dc3411b7f19dc4b7a04a37))
* **tenders-watch:** join two runs on procedure ids, not on publication numbers ([87b12da](https://github.com/maxgfr/ultraprospect/commit/87b12dac65c0364b146cebee2c091f34ddb249e5))
* **tenders:** keep the look-alike pairs nobody has judged yet ([f5d3318](https://github.com/maxgfr/ultraprospect/commit/f5d3318c297d3c544f740030437a0654e9085efb))
* **tenders:** read nn/nn/yyyy in the order the notice's own market writes it ([72d739e](https://github.com/maxgfr/ultraprospect/commit/72d739e67679d32c413150abed5cccdb227f1854))
* **tenders:** recognise a bid directory where the path separator is a backslash ([e4cd96d](https://github.com/maxgfr/ultraprospect/commit/e4cd96d497af176eb15c6dfed5ef7ff78f769713))


### Features

* **confirm:** aim the pass at a list of place ids with --only ([ed582f4](https://github.com/maxgfr/ultraprospect/commit/ed582f4c7d4a1ef29e24689bca1faf925b9ea5b0))
* **legal-notice:** read a Norwegian organisation number off a company's site ([17c25c5](https://github.com/maxgfr/ultraprospect/commit/17c25c5d4cfb6c97d1b8bcbcd94042b7ee573cba))
* **render:** add --csv-raw to write CSV cells without the formula guard ([aef04ac](https://github.com/maxgfr/ultraprospect/commit/aef04ac028c40bd569f3f6050815d35748aa53f7))
* **render:** let --csv-raw reach TENDERS.csv as well ([fd93bfd](https://github.com/maxgfr/ultraprospect/commit/fd93bfd2fef10705d24ab83916ed5b94b95dd2b2))


### Performance Improvements

* **match:** prepare each name once instead of once per candidate pair ([513b08d](https://github.com/maxgfr/ultraprospect/commit/513b08d05b8bc872184349b1444919d8e9de2690))
* **oeffentlichevergabe:** read a past day's export back from the cache ([3762ac7](https://github.com/maxgfr/ultraprospect/commit/3762ac77fc72b8cc99ba880450355653337c5a55))
* **tenders:** ask the tender sources a few at a time ([a5e19c7](https://github.com/maxgfr/ultraprospect/commit/a5e19c760fbc629d58eff393b2e70303e04ca438))

## [3.17.2](https://github.com/maxgfr/ultraprospect/compare/v3.17.1...v3.17.2) (2026-11-11)


### Bug Fixes

* **engine:** update shared engines and maintenance tool ([a493e84](https://github.com/maxgfr/ultraprospect/commit/a493e8415545c9328e89e42ff47bc5c2b544d7a3))

## [3.17.1](https://github.com/maxgfr/ultraprospect/compare/v3.17.0...v3.17.1) (2026-11-10)


### Bug Fixes

* **cli:** refuse a numeric flag that is not a number instead of guessing one ([b689106](https://github.com/maxgfr/ultraprospect/commit/b689106490d855d19dc09961690380d78f88d3f9))
* **companies-house:** do not answer a name made of legal forms with the first companies in town ([92c2170](https://github.com/maxgfr/ultraprospect/commit/92c2170a9da026885f92f0c3d688485b708dafe9))
* **confirm:** keep attributions and counts across passes, and do not attach a dissolved company by name ([5720842](https://github.com/maxgfr/ultraprospect/commit/57208421f78d123229b60a5b5fce6845a1289917))
* **confirm:** send a Greek VAT number to the authority that serves Greece ([2f31505](https://github.com/maxgfr/ultraprospect/commit/2f31505753cf8a4569c7cefbce6b028b04521d5d))
* **csv:** defuse cells a spreadsheet would execute as a formula ([52bc5df](https://github.com/maxgfr/ultraprospect/commit/52bc5dfbc4a6df2d4c20103e99ca1650ca86a1f2))
* **enrich:** spend the legal fetch on the notice, and try each guessed path until one answers ([cfc84d2](https://github.com/maxgfr/ultraprospect/commit/cfc84d25e587b220a1f650eb846a6d22ef0a40e4))
* **enrich:** survive a malformed mailto and a pathological token on a fetched page ([dd66e3a](https://github.com/maxgfr/ultraprospect/commit/dd66e3ae07a106bc2f0d99b8c21cdb5edbeca7a3))
* **html:** print a link that is not a web, mail or phone link as text ([d58b2da](https://github.com/maxgfr/ultraprospect/commit/d58b2dac6a327b10cb742b9a898daf3d5d8ade62))
* **ingest:** a failed or limited ingest can no longer pass as a complete index ([130f6fd](https://github.com/maxgfr/ultraprospect/commit/130f6fd93a79b756fdbf65ab9f1e9c0d76b85518))
* **ingest:** decode a register export across chunk boundaries instead of per chunk ([6fef4f2](https://github.com/maxgfr/ultraprospect/commit/6fef4f215c403c43993a5c962c0a663b2c404946))
* **krs:** file a Polish activity under its NACE section letter ([c7d6097](https://github.com/maxgfr/ultraprospect/commit/c7d609759d4c32835978c8050ff23d02d4b35131))
* **legal-notice:** do not read an ordinary lowercase word as a VAT prefix ([f2710f6](https://github.com/maxgfr/ultraprospect/commit/f2710f6b9504a15dd83895d196269ca24d60e732))
* **match:** fold an adjudication as one record onto one unmatched place, and say it was adjudicated ([8d9632d](https://github.com/maxgfr/ultraprospect/commit/8d9632d9ad9ffef130dcf9478627482a00deedd6))
* **mcp:** give scan, enrich and watch the arguments and refusals the CLI has ([7ff2897](https://github.com/maxgfr/ultraprospect/commit/7ff28972c8e710a40edad764fa9091af35771252))
* **overpass:** read the runtime-error remark of a 200 answer as a failed query ([672039c](https://github.com/maxgfr/ultraprospect/commit/672039cdd5849f0177d6d1f1a1149a1fedd5c3ce))
* **people:** read a role label as a word, not as letters inside a longer one ([fdd87d3](https://github.com/maxgfr/ultraprospect/commit/fdd87d3d13debb218d8a2f56addc51a91706fc1f))
* **privacy:** make --no-people hold for the raw register lane and every deliverable ([5b18e85](https://github.com/maxgfr/ultraprospect/commit/5b18e85c67e4b53c93e30abab343ebb3f18eeee9))
* **report:** describe every filter that narrowed a run ([e2cdda3](https://github.com/maxgfr/ultraprospect/commit/e2cdda34b47d73a4e5642b829edfe1303c508501))
* **resolve:** corroborate a company name word by word, not as a substring of the page ([e58b9bb](https://github.com/maxgfr/ultraprospect/commit/e58b9bb0ce23d9f97be5d53fc68f533ebc885803))
* **resolve:** match a listed host as a host, not as letters inside another one ([04df77d](https://github.com/maxgfr/ultraprospect/commit/04df77d99d5c0aedc97dbe15a0985745ab03a5bb))
* **resolve:** try the domain that carries the company's name before a directory that lists it ([7d04a49](https://github.com/maxgfr/ultraprospect/commit/7d04a49718b9983a1446e06f63091cfc2f202a45))
* **scan:** do not replay an unsweepable territory as a register sweep that found nothing ([771c0fb](https://github.com/maxgfr/ultraprospect/commit/771c0fbc45f08eaa494d554673d386056b6f609f))
* **score:** refuse a fit level nobody defined, in --min-fit and in a verdict file ([892b015](https://github.com/maxgfr/ultraprospect/commit/892b01547c00af01f5c85f72b56fcc474cc560fd))
* **signals:** do not read a short term out of the longer words that begin with it ([89e3748](https://github.com/maxgfr/ultraprospect/commit/89e37482fd5a66f42813f34a4e018a0c8d53cdc1))
* **sirene:** keep the caller's activity codes when a capped section is split by division ([d806016](https://github.com/maxgfr/ultraprospect/commit/d80601682d61e573bcdecdf700c1748584e9f502))
* **sirene:** report a results page that fails after the first as truncation ([a80061f](https://github.com/maxgfr/ultraprospect/commit/a80061f435efd76b1216461772dc0706bc219279))
* **tenders:** four ways a run lost or misstated a notice without saying so ([9e53902](https://github.com/maxgfr/ultraprospect/commit/9e539029b2a23d0810a9cb72931b1f8ab129abbc))
* **tenders:** read a deadline in its own timezone instead of comparing its day with UTC's ([6d8e29d](https://github.com/maxgfr/ultraprospect/commit/6d8e29d7098a94e5801b7bef513014ce7ac2ebce))
* **watch:** join two runs on any key a place shares, not on its register key alone ([ff8c182](https://github.com/maxgfr/ultraprospect/commit/ff8c182689765f0216f61295e3fa39fc3c1ce8e3))
* **zip:** stop trusting the sizes an archive states about itself ([0236960](https://github.com/maxgfr/ultraprospect/commit/02369604e4a1865df2072ddbbe627660b3715b05))


### Performance Improvements

* **check:** fold each page once, however many values cite it ([92b56d4](https://github.com/maxgfr/ultraprospect/commit/92b56d41bb24f3e36cb7afe4585d435574a6cc18))
* **confirm:** ask about each identifier once, and only authorities that can answer ([45d7a9a](https://github.com/maxgfr/ultraprospect/commit/45d7a9a7e326525c3254d5c8c2a062e68220493b))
* **snapshot:** tell another town's line apart without parsing it ([090d579](https://github.com/maxgfr/ultraprospect/commit/090d5796bccb66a32b8b6d75b8273036e345ebdb))

# [3.17.0](https://github.com/maxgfr/ultraprospect/compare/v3.16.5...v3.17.0) (2026-11-02)


### Bug Fixes

* **tenders:** name the qualifier's allowed decision and fit words in its contract ([08f4b2d](https://github.com/maxgfr/ultraprospect/commit/08f4b2d1c61eb3aca1b6f723841b88cadc14e240))
* **tenders:** what live runs across ten markets showed ([6e054d4](https://github.com/maxgfr/ultraprospect/commit/6e054d4555f09affcca92608103415e4853ea799))


### Features

* **tenders:** find, qualify and answer public calls for tenders across countries ([944bbec](https://github.com/maxgfr/ultraprospect/commit/944bbec9664366732f7066f4acdd53011eb6596e))

## [3.16.5](https://github.com/maxgfr/ultraprospect/compare/v3.16.4...v3.16.5) (2026-10-30)


### Bug Fixes

* **engine:** update shared engines and maintenance tool ([58675fa](https://github.com/maxgfr/ultraprospect/commit/58675fabf98e7f548905a6a461377b67a7fba3b2))

## [3.16.4](https://github.com/maxgfr/ultraprospect/compare/v3.16.3...v3.16.4) (2026-10-27)


### Bug Fixes

* **engine:** update shared engines and maintenance tool ([10ab135](https://github.com/maxgfr/ultraprospect/commit/10ab1358e6d1bfa7bd5c483eb54b0acfe2346623))

## [3.16.3](https://github.com/maxgfr/ultraprospect/compare/v3.16.2...v3.16.3) (2026-10-25)


### Bug Fixes

* **engine:** update shared engines and maintenance tool ([2bb9750](https://github.com/maxgfr/ultraprospect/commit/2bb975042c3f001adeeb9ebba4e62b985f92f368))

## [3.16.2](https://github.com/maxgfr/ultraprospect/compare/v3.16.1...v3.16.2) (2026-10-24)


### Bug Fixes

* **cli:** stop advising --category when Overpass, not the area, failed ([3eefeb7](https://github.com/maxgfr/ultraprospect/commit/3eefeb7bddeff179a65e7192fe8f751d35297df1))
* **fr-sirene:** name a practitioner, not the trade on their sign ([45d1b84](https://github.com/maxgfr/ultraprospect/commit/45d1b84491d5f9809ae65943800a4c6f03d8c51b))
* **geocode:** do not call a place ambiguous against its own namesake parent ([0067fc1](https://github.com/maxgfr/ultraprospect/commit/0067fc1e9983d69ba6f05fe2659c1d23f2e2a0cb))

## [3.16.1](https://github.com/maxgfr/ultraprospect/compare/v3.16.0...v3.16.1) (2026-10-20)


### Bug Fixes

* **engine:** repin webindex engine to v1.34.1 ([#20](https://github.com/maxgfr/ultraprospect/issues/20)) ([6619b67](https://github.com/maxgfr/ultraprospect/commit/6619b672d8e5939cb566058b4dab1d87d9c5b387))

# [3.16.0](https://github.com/maxgfr/ultraprospect/compare/v3.15.2...v3.16.0) (2026-10-20)


### Features

* make orchestration and install agent-neutral ([#18](https://github.com/maxgfr/ultraprospect/issues/18)) ([9303c72](https://github.com/maxgfr/ultraprospect/commit/9303c722ee24c231b6776067607e3630625cc7f8))

## [3.15.2](https://github.com/maxgfr/ultraprospect/compare/v3.15.1...v3.15.2) (2026-10-12)


### Bug Fixes

* **engine:** update shared engines and maintenance tool ([5b11104](https://github.com/maxgfr/ultraprospect/commit/5b1110442dd52d63ed48d4744ba2d02add8e1fca))

## [3.15.1](https://github.com/maxgfr/ultraprospect/compare/v3.15.0...v3.15.1) (2026-10-09)


### Bug Fixes

* **engine:** update shared engines and maintenance tool ([1630dc3](https://github.com/maxgfr/ultraprospect/commit/1630dc373ea0fb210ab705962456b0580f0e3556))

# [3.15.0](https://github.com/maxgfr/ultraprospect/compare/v3.14.11...v3.15.0) (2026-10-08)


### Features

* **skill:** let the agent invoke ultraprospect on request ([ad7bb2c](https://github.com/maxgfr/ultraprospect/commit/ad7bb2cef0cfa97bdacd0cf5cf689f9a259b829a))

## [3.14.11](https://github.com/maxgfr/ultraprospect/compare/v3.14.10...v3.14.11) (2026-10-03)


### Bug Fixes

* **engine:** update shared engines and maintenance tool ([9e617cf](https://github.com/maxgfr/ultraprospect/commit/9e617cf67b1362cf6aaf7ba8a27f3b0453ab2555))

## [3.14.10](https://github.com/maxgfr/ultraprospect/compare/v3.14.9...v3.14.10) (2026-10-02)


### Bug Fixes

* **engine:** update shared engines and maintenance tool ([cb75793](https://github.com/maxgfr/ultraprospect/commit/cb7579362cd121929048e42f3a2a85a9a9831aa2))

## [3.14.9](https://github.com/maxgfr/ultraprospect/compare/v3.14.8...v3.14.9) (2026-09-30)


### Bug Fixes

* **engine:** repin webindex v1.26.1 ([e98d675](https://github.com/maxgfr/ultraprospect/commit/e98d675edb88e4385de63827d74d5d6484844e3d))

## [3.14.8](https://github.com/maxgfr/ultraprospect/compare/v3.14.7...v3.14.8) (2026-09-13)


### Bug Fixes

* **engine:** update shared engines and maintenance tool ([540a830](https://github.com/maxgfr/ultraprospect/commit/540a8300f4edcf3c86090aabbe80dc8e0f1f13e7))

## [3.14.7](https://github.com/maxgfr/ultraprospect/compare/v3.14.6...v3.14.7) (2026-09-10)


### Bug Fixes

* **engine:** update shared engines and maintenance tool ([020697f](https://github.com/maxgfr/ultraprospect/commit/020697f63c184d24930cf4a821fb258d262783ec))

## [3.14.6](https://github.com/maxgfr/ultraprospect/compare/v3.14.5...v3.14.6) (2026-09-09)


### Bug Fixes

* **skills:** preserve manual invocation across agent hosts ([b3c9bac](https://github.com/maxgfr/ultraprospect/commit/b3c9bac81db9e5a96415269759aa49990aece737))

## [3.14.5](https://github.com/maxgfr/ultraprospect/compare/v3.14.4...v3.14.5) (2026-09-09)


### Bug Fixes

* reject corrupt recorded fixture lanes ([367cf91](https://github.com/maxgfr/ultraprospect/commit/367cf912d9eb683b67b9b329170aead4df1c770d))

## [3.14.4](https://github.com/maxgfr/ultraprospect/compare/v3.14.3...v3.14.4) (2026-09-09)


### Bug Fixes

* réépingler webindex après harmonisation du chemin d’orchestration ([ca70143](https://github.com/maxgfr/ultraprospect/commit/ca7014322f136230fedd0bd364b3e4dd7acdb668))

## [3.14.3](https://github.com/maxgfr/ultraprospect/compare/v3.14.2...v3.14.3) (2026-09-08)


### Bug Fixes

* **engine:** update shared engines and maintenance tool ([d7588bb](https://github.com/maxgfr/ultraprospect/commit/d7588bbaeb33863ae09b5617bfb0d191ca890e9c))

## [3.14.2](https://github.com/maxgfr/ultraprospect/compare/v3.14.1...v3.14.2) (2026-09-08)


### Bug Fixes

* **engine:** separate workflow maintenance from automatic repins ([7d8b924](https://github.com/maxgfr/ultraprospect/commit/7d8b924fd9ebbdd7a2b21f7f42ebc631f58d5960))

## [3.14.1](https://github.com/maxgfr/ultraprospect/compare/v3.14.0...v3.14.1) (2026-09-08)


### Bug Fixes

* **engine:** unify pins, repins and shared engine adapters ([e4b9fb4](https://github.com/maxgfr/ultraprospect/commit/e4b9fb4b7b440d0b41ff435430a498ce2d16b848))
* **engine:** unify pins, repins and shared engine adapters ([6337e2e](https://github.com/maxgfr/ultraprospect/commit/6337e2ebc241ea69418270cf6047d2af63024fcb))

# [3.14.0](https://github.com/maxgfr/ultraprospect/compare/v3.13.1...v3.14.0) (2026-09-08)


### Features

* **engine:** re-pin vendored engines ([5b2f30d](https://github.com/maxgfr/ultraprospect/commit/5b2f30d292a0a6e699ae9b7636cc3e5a3a5169ed))

## [3.13.1](https://github.com/maxgfr/ultraprospect/compare/v3.13.0...v3.13.1) (2026-09-07)


### Bug Fixes

* accept dossier labels and canonicalize feedback replay ([62a87a9](https://github.com/maxgfr/ultraprospect/commit/62a87a92128e071fc6de7edece0623dfc57874ac))

# [3.13.0](https://github.com/maxgfr/ultraprospect/compare/v3.12.0...v3.13.0) (2026-09-07)


### Features

* harden verification, add workflows and require explicit skill invocation ([0469ea4](https://github.com/maxgfr/ultraprospect/commit/0469ea4dc70512a67c3cd891a5c24e1a4e8f3826))

# [3.12.0](https://github.com/maxgfr/ultraprospect/compare/v3.11.0...v3.12.0) (2026-09-04)


### Features

* **engine:** re-pin vendored engines ([25a00ce](https://github.com/maxgfr/ultraprospect/commit/25a00ce5ca87f464c63245afbe9a08c36f24c38b))

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
