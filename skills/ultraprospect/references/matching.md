# Fusing the two lanes

OSM sees shopfronts. The register sees legal units at postal addresses. The same
bakery is a `shop=bakery` node with an awning *and* a SIRET filed at the
building, and the whole value of the French path is that the two get joined —
neither half is a prospect on its own.

## Why proximity cannot carry a match

A Paris office block holds fifty registered companies inside twenty metres. If
distance could substitute for identity, a dense area would collapse into
nonsense with every pair looking locally plausible. So the model is
**identity-dominant** and the distance term only ever confirms:

```
identity  = max(name, enseigne, address)
proximity = 1 - distance / 150 m
score     = 0.8 × identity + 0.2 × proximity        (0 if identity < 0.25)
```

Beyond **150 m** nothing matches at any name. Below an identity of **0.25** the
pair scores zero however close it is — a hard gate, not a low weight.

## The three identity signals

**Name.** Compared against every name the register holds: `nom_complet`,
`nom_raison_sociale`, `sigle`, and each `enseigne`. Three measures, best of:
token overlap, trigram overlap, and **containment**.

Containment matters more than it sounds. The most common shape of a real match
is a shopfront name inside a register name — "Marionnaud" in "MARIONNAUD
LAFAYETTE", "Crèche Burgeat" in "Crèche Jean Burgeat" — and both Jaccard
measures *punish* the extra tokens, so a certain match scores 0.5 and lands in
the undecided pile. Containment is guarded twice: a single shared token only
counts if it is at least six characters and is not a generic trade noun, because
`{creche} ⊆ {creche, burgeat}` would otherwise merge every nursery in town.

Names are also **split on parentheses** first. The register packs trade names
into the legal one — `"CREDIT LYONNAIS (LCL)"`, `"KID'HOME SERVICES (KLEEN'HOME
SERVICES)"` — and compared whole, the alternates are noise that drags every
measure down. Split out, each is a name the business actually goes by, and
usually the one on the sign OSM recorded.

Legal forms (`SARL`, `SAS`, `SASU`, …) are stripped before comparison: every
third French company is a SAS, so they carry no identifying signal but dominate
a token overlap. A name that is *only* boilerplate normalises to the empty
string and scores zero — two companies called "SARL" are not the same company.

**Enseigne.** The OSM `brand`/`operator` tag against the register's enseigne
list. A separate signal from the name: a franchise is mapped as
`brand=Carrefour` with `name=Carrefour City Vincennes`, and the register files
it under an enseigne rather than a denomination.

**Address.** `addr:housenumber` + `addr:street` against the register's parsed
address. A full match is near-proof of identity even when the names are
unrelated, which is exactly the case it exists for: a restaurant trading as "Les
Officiers" is registered as "AUX BARREZIENS". Street-only agreement scores 0.6.

## Three outcomes, on purpose

| Score | Outcome |
|---|---|
| ≥ 0.72 | Merged. One entity, `sources: ["osm","sirene"]`. |
| 0.40 – 0.72 | **Undecided.** Written to `MATCH.todo.json` for you. |
| < 0.40 | Two distinct entities. |

Assignment is one-to-one and greedy on a descending score list: one register
record cannot be two shopfronts, and one shopfront cannot be two companies.

## Adjudicating the middle band

Each pair carries what you need to decide it:

```json
{
  "osmId": "n123", "siret": "…", "score": 0.679, "distanceM": 1,
  "osmName": "École maternelle Franklin Roosevelt",
  "matchedName": "ECOLE MATERNELLE PUB F. ROOSEVELT",
  "sireneName": "COMMUNE DE VINCENNES",
  "parts": { "name": 0.6, "enseigne": 0, "address": 0, "distance": 0.99 }
}
```

`matchedName` is the register name that **actually produced the score**, and it
is usually not the legal one. Reading `sireneName` alone, that pair looks like an
obvious no; reading `matchedName`, it is an obvious yes. Judge on `matchedName`.

Answer with a JSON array and fold it back:

```bash
ultraprospect match --run <dir> --apply verdicts.json
```

```json
[{ "osmId": "n123", "siret": "21940080100136", "merge": true, "why": "same school, same address, enseigne matches" }]
```

Only merges change anything — a "keep apart" verdict is already the state of the
world, and recording it as a change would make the run non-idempotent. A verdict
naming a pair this run does not have is reported and exits 1: it almost always
means the file came from a different run.

**When you cannot tell, answer `false`.** Two rows are recoverable by anyone
looking at the list. One wrong merge produces a single plausible company holding
somebody else's SIREN, and nothing downstream will ever flag it.
