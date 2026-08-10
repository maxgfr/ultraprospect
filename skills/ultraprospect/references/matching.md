# Fusing the two lanes

OSM sees shopfronts. The register sees legal units at postal addresses. The same
bakery is a `shop=bakery` node with an awning *and* a SIRET filed at the
building, and the whole value of the join is that neither half is a prospect alone —
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
third French company is a SAS and every second German one a GmbH, so they carry
no identifying signal but dominate
a token overlap. A name that is *only* boilerplate normalises to the empty
string and scores zero — two companies called "SARL" are not the same company.

**Enseigne.** The OSM `brand`/`operator` tag against the register's enseigne
list. A separate signal from the name: a franchise is mapped as
`brand=Carrefour` with `name=Carrefour City Vincennes`, and the register files
it under an enseigne rather than a denomination.

**Address.** `addr:housenumber` + `addr:street` against the register's parsed
address. An exact match **confirms a name; it does not replace one.**

That distinction was bought with a real run. Treating a full address as
near-proof auto-merged eight Vincennes pairs on the address alone, and they were
indistinguishable from each other:

| Pair | Verdict |
|---|---|
| Aux Papilles ↔ BRUNO ENCAOUA | right — a trade name over the owner's |
| Synotis ↔ SYNALTIC | right — the shopfront name is stale |
| **Société Générale ↔ PAREX AUDIT S.A.S** | **wrong — a bank branch and an audit firm in one building** |

Nothing in the data separates them. Occupancy was tried as the discriminator —
one company at that doorway versus several — and abandoned, because it can only
be counted over the records a run actually fetched, so any `--section` or
`--min-employees` filter makes every address look like a sole occupancy. A signal
that is wrong exactly when a filter is used is worse than no signal.

So an address with **no** name agreement scores 0.6 identity and lands in the
undecided band. With even weak name support (≥ 0.4) the two signals agree and it
merges. Street-only agreement, without the number, scores 0.3.

## Three outcomes, on purpose

| Score | Outcome |
|---|---|
| ≥ 0.72 | Merged. One entity, `sources: ["osm","sirene"]`. |
| 0.40 – 0.72 | **Undecided.** Written to `MATCH.todo.json` for you. |
| < 0.40 | Two distinct entities. |

A merge records the score it was made on and which signal carried it —
`matchConfidence: 0.851`, `matchedBy: "name"` — never a flat 1. A pair merged at
0.74 and one merged at 0.99 are both "merged", and only one of them is worth
re-reading when a row looks wrong.

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
somebody else's registration number, and nothing downstream will ever flag it.
