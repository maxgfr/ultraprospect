# Privacy, licensing and what you may hand over

This tool produces a file about real businesses and, often, real people. Two
distinct obligations attach to that, and they are not interchangeable: one comes
from the data's licence, the other from data-protection law.

## Attribution is a licence condition, not a courtesy

**OpenStreetMap data is ODbL.** Any deliverable derived from it must carry the
attribution. The manifest hands you the exact strings in `licences[]`; put them
in the footer of whatever you produce — the CSV's companion README, the report,
the HTML page. Stripping them is a licence breach, not a formatting choice.

**Register data carries its own licence, per connector** — France's is Licence
Ouverte 2.0, Norway's is NLOD 2.0, the UK's is OGL v3.0, GLEIF's is CC0, and
Germany's is **CC-BY 4.0, where attribution is a CONDITION of the licence rather
than a courtesy**: reuse without crediting OpenCorporates is simply not licensed.
The manifest lists ONLY the connectors that actually answered, so a German run
does not claim France's. Each requires attributing the source and the date of the
extract. `manifest.builtAt` is that date — except for a snapshot record, where the
date that matters is the record's own `asOf`.

```
Places and tags: © OpenStreetMap contributors, ODbL
French company data: base Sirene / RNE via recherche-entreprises.api.gouv.fr, Licence Ouverte 2.0
UK company data: Companies House, Open Government Licence v3.0
German company data: OffeneRegister.de / OpenCorporates, CC-BY 4.0
```

**A confirm run owes SEVERAL register attributions, not one.** It asks every
applicable authority about each company, so a German run typically owes VIES,
GLEIF and OffeneRegister at once. `manifest.licences` already assembles them; take
the list rather than the first entry.

## Company data and personal data are not the same thing

A registration number, an activity code, a headcount band and a `contact@`
address are data about an
organisation. A director's name and date of birth, an employee listed on a team
page, and `firstname.lastname@company.com` are data about **a person**, and
collecting them makes whoever holds the file a data controller under the GDPR.

The engine does not decide this for you. It records provenance for every
personal field so that the decision stays available:

- Register directors are published open data, and arrive marked as such.
- Anything read off a web page carries the page id it came from.

What that leaves you responsible for, if the file contains people:

- **Purpose and basis.** B2B prospecting can rest on legitimate interest when
  the message concerns the person's professional role. That is a judgement about
  *your* use, not something a tool can assert on your behalf.
- **Information and opt-out.** The people in the file have a right to know they
  are in it and to object. A first contact that does not offer that is the part
  that gets complained about.
- **Retention.** A prospect file is not a permanent record. Decide how long, and
  actually delete.

`--no-people` removes named individuals — register directors included — at scan
time, before anything is written. Not at render time: a run that never held the
names cannot leak them through a cached page, a stray artifact, or someone
reading `places.json` directly. Reaching for it is usually the cheaper choice.

### The German export is the largest single source of personal data here

`de-offeneregister` carries **officers** — directors, Geschäftsführer, Prokuristen
— for a large share of its 5.3 million records. That is the connector's whole
value (VIES answers `"---"` for a German holder and this names one) and it is also
several million living people's names, so two things follow that do not follow for
the other registers:

- **`--no-people` matters more here than anywhere else.** It strips officers
  wholesale, and a deliverable that is going to be shared, stored or sent to a
  CRM should usually be produced with it.
- **Every one of those names is dated.** The export stopped in 2019, so a person
  named as a director is a person who was one THEN. Writing it in the present
  tense is a claim about someone's current role that this run cannot support —
  `check` fails a write-up that omits the date, and `PRIVACY.md` names the source.

## The rule the engine will not bend

**A contact that was not observed is never written.** Every email, phone number
and person must appear verbatim in a page that was fetched and stored, or in an
open-data record. In particular:

- No address is ever derived from a pattern. `prenom.nom@domaine` inferred from
  a company's naming convention is a fabrication, and a plausible fabrication is
  worse than a blank field — it will be sent to, and it will bounce off someone
  who never existed or reach someone who did not consent.
- No name is ever inferred from a role ("the manager of X is probably…").
- No phone number is ever completed or corrected.

This is enforced mechanically rather than left to good intentions: the check
gate re-resolves every contact against its source page and fails the run when
one does not appear there. If you find yourself wanting to fill a gap, the
answer is to leave it empty and say the site does not publish it.

## Before you hand the file over

- Does it lead with the truncation warning, if `manifest.truncated` is true?
- Do the attributions travel with it?
- Does every personal field trace to a page or an open-data record?
- Is `--no-people` the better answer for this use?
