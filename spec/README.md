# Spec snapshots

Committed inputs for the generators (`scripts/generate.mjs` and `python/scripts/generate.py`). Nothing here is fetched at build or test time.

| File | What it is | Source |
|---|---|---|
| `manifest.json` | Full `/v1/manifest` response (33 routes: params, examples, outputs, output JSON Schema) | `GET https://api.duoleads.com/v1/manifest` (free, unpaid), fetched 2026-10-09, manifest version 1.0.0, sha256 `eab01fdbcac20b6068493b95647251baa27af7db279126a22ae5804ba7a73d89` |
| `keywords.json` | Tool name and keyword-first summary per route | Copy of the findability keyword inventory, fetched 2026-10-09 |
| `methods.json` | Method naming: which namespace and method each route gets in the TypeScript and Python clients | Hand-written for this package |
| `fixtures/iban-402-challenge.json` | One real unpaid `402 Payment Required` challenge for `/v1/id/iban` | `GET https://api.duoleads.com/v1/id/iban?iban=NL91 ABNA 0417 1643 00`, no payment made |

To refresh the snapshot, fetch `/v1/manifest` again, review the diff, then run `npm run generate` and `python3 python/scripts/generate.py`. CI checks that the committed generated files match the snapshots.
