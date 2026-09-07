# User feedback

Use this branch for actual user decisions, not model inference about fit. Feedback is CLI-only,
local and separate from `score`, `watch` and raw evidence. It sends no outreach and connects to
no external CRM.

1. Run `feedback --run <dir>`. Its JSON contains empty `entries` and current `subjects`, each
   with a `source` object (`placeId`, stable `identity`, SHA-256 snapshot `digest`), name, website
   and sourced contacts. Select the subject the user actually reviewed.
2. Copy its whole `source` unchanged into a new entry. Record a unique event `id`, the user's
   `kind`, nonempty `reason`, `by` attribution and ISO timestamp `at`. Do not invent their view.
3. Import with `feedback --run <dir> --apply <file>` (or `--apply -` for JSON on stdin).
   The whole import is validated before one write to `FEEDBACK.json`. Unknown or stale identities,
   unsupported kinds, missing attribution, foreign contact/site provenance, duplicate IDs within
   an import and conflicting reused IDs fail. An unchanged event can be reimported idempotently
   while its source snapshot is still current.
4. Run `render --run <dir>` again. Inspect CSV, JSON, HTML and report: quarantined rows must be
   absent; the ledger and raw `places.json` remain. Existing exports are unchanged until rendered.

```json
{
  "schemaVersion": 1,
  "entries": [{
    "id": "review-2026-09-07-001",
    "source": {"placeId": "COPY_FROM_SUBJECT", "identity": "COPY_FROM_SUBJECT", "digest": "COPY_FROM_SUBJECT"},
    "kind": "exclude",
    "reason": "Already served by our team",
    "by": "Territory owner",
    "at": "2026-09-07T12:00:00Z"
  }]
}
```

| Kind | Required subject | Effect on later renders |
|---|---|---|
| `wrong-company` | None | Quarantine the company row |
| `wrong-site` | `field: "website"`, exact current URL as `value`, one website evidence item as `from`; no `lane` | Quarantine the company row, not an invented replacement URL |
| `wrong-contact` | Contact collection name (`emails`, `phones`, `socials`, `people`) as `field`, exact `value`, `from` and `lane` copied from that contact | Quarantine the company row, not an invented replacement contact |
| `exclude` | None | Exclude the company row |
| `useful` | None | Record feedback only; no score mutation |

Exclusions persist across repeated renders and later enrichment of the same run, including an
OSM row gaining a stronger registry identity. `useful` never cancels earlier negative feedback.
The ledger deliberately has no automatic unexclude or fact-repair operation. Retain the reason
and resolve the underlying source separately; do not delete raw evidence to make a correction
appear proven. A new run is independent unless its feedback is explicitly imported and revalidated.

`FEEDBACK.json` is an audit artifact, not a filtered prospect list: it retains excluded identifiers
and the user's supplied subject/reason. Raw dossiers and pages likewise remain on disk; exclude
them from a distribution if that distribution is intended to contain only selected prospects.
