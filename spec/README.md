# Spec snapshots

Committed inputs for the generators (`scripts/generate.mjs` and `python/scripts/generate.py`). Nothing here is fetched at build or test time.

| File | What it is | Source |
|---|---|---|
| `manifest.json` | Full `/v1/manifest` response (33 routes: params, examples, outputs, output JSON Schema) | `GET https://api.duoleads.com/v1/manifest` (free, unpaid), fetched 2026-10-09, manifest version 1.0.0, sha256 `eab01fdbcac20b6068493b95647251baa27af7db279126a22ae5804ba7a73d89` |
| `keywords.json` | Tool name and keyword-first summary per route | Copy of the findability keyword inventory, fetched 2026-10-09 |
| `methods.json` | Method naming: which namespace and method each route gets in the TypeScript and Python clients | Hand-written for this package |
| `derivs.json` | Route catalogue of https://derivs.duoleads.com (10 routes: path, MCP tool, price in atomic USDC, description, query schema, response JSON Schema, a real output example) | Exported from the service repository's `src/derivs/catalog.ts`, `schemas.ts` and `output-examples.json` on 2026-10-15; also published as https://derivs.duoleads.com/openapi.json |
| `derivs-methods.json` | Method naming and numeric parameters for the derivs client | Hand-written for this package |
| `keywords-openapi.json` | Published OpenAPI of https://keywords.duoleads.com (44 routes: method, MCP tool, price, parameters, answer schemas). Input of `src/seo-generated.ts` | `GET https://keywords.duoleads.com/openapi.json` (free), fetched 2026-11-08, service version 1.2.0 |
| `social-openapi.json` | Published OpenAPI of https://social.duoleads.com (26 routes). Input of `src/social-generated.ts` | `GET https://social.duoleads.com/openapi.json` (free), fetched 2026-11-08, service version 1.1.0 |
| `derivs-openapi.json` | Published OpenAPI of https://derivs.duoleads.com (10 routes). Input of `src/derivs-generated.ts` since 0.3.0 (`derivs.json` stays for the Python generator and is cross-checked against it) | `GET https://derivs.duoleads.com/openapi.json` (free), fetched 2026-11-08, service version 1.1.0 |
| `route-tables.json` | The route tables of the READMEs (written by `scripts/generate.mjs`, inserted by `scripts/readme-tables.mjs`) | Generated |
| `fixtures/live-402-amounts.json` | The amount of every keyword, social and derivs route's real unpaid 402 challenge: the independent price check of `test/v030.test.ts` | One unpaid request per route, 2026-11-08, no payment made |
| `fixtures/iban-402-challenge.json` | One real unpaid `402 Payment Required` challenge for `/v1/id/iban` | `GET https://api.duoleads.com/v1/id/iban?iban=NL91 ABNA 0417 1643 00`, no payment made |

To refresh the keyword, social and derivs snapshots, run `node scripts/refresh-specs.mjs`, review the diff, then `npm run generate`. To refresh the main snapshot, fetch `/v1/manifest` again, review the diff, then run `npm run generate` and `python3 python/scripts/generate.py`. CI checks that the committed generated files match the snapshots.
