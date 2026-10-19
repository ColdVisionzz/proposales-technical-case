# Synthetic fixtures

These files are **not observed API behaviour**. They were written by hand from the OpenAPI file (`../openapi.json`, API version 2026.09.02, downloaded from https://docs.proposales.com/openapi.json). Every field name and type comes from that file. Values (ids, names, timestamps, URLs) are made up.

They exist so the pipeline can be built and tested before API access exists. Once `npm run probe` runs, real responses are saved under `../real/`. Where a real response and a synthetic one disagree, **the real one wins** and the synthetic one is fixed or deleted.

`tests/proposales-fixtures.test.ts` checks every file here against its schema in the OpenAPI file, so a fixture cannot drift from the spec. That only proves the fixtures match the spec, not that the live API behaves like the spec.

| File | Schema it must match |
| --- | --- |
| `companies.200.json` | `GET /v3/companies` 200 response |
| `content.200.json` | `GET /v3/content` 200 response |
| `create-proposal.request.json` | `CreateProposalRequest` |
| `create-proposal.200.json` | `POST /v3/proposals` 200 response |
| `search-by-data.200.json` | `GET /v3/proposal-search` 200 response (filtered by a `data` property) |
| `search-by-recipient.200.json` | `GET /v3/proposal-search` 200 response (filtered by `recipient_email`) |
| `error.400.json` | `ErrorResponse` |
| `error.401.json` | `ErrorResponse` |
| `error.500.json` | `ErrorResponse` |
| `error.429.json` | `ErrorResponse`. **Assumption:** the spec documents no 429 response. The shape is guessed from the other error bodies. Replace it with a real one if the probe ever sees a 429 |

## Aligned with the real API (2026-10-19)

After the first probe run (`../real/`), these synthetic values were changed to match what Proposales really returns:

- Timestamps (`created_at`, `updated_at`) are **milliseconds**, not seconds.
- Draft `url` is `https://secure.proposales.com/proposals/<uuid>/edit`.
- `version` is `null` on a fresh draft.
- `GET /v3/companies` on a new account: `inbox_token` null, `timezone` null, `registration_number` and `website_url` are `""`. The last two break the spec (`timezone` must be a string, `website_url` a URI), so `tests/proposales-fixtures.test.ts` forgives exactly those fields.
- Error bodies: `error.issues[]` carry `expected` and `received`, and there is no `code`. A 401 says `Unauthorized`.

Not mirrored in the fake: sending a `product_id` as `content_id` is accepted but yields a draft with **zero blocks**. Only `variation_id` works.

## What the spec does not tell us

- Search lag and whether `data` is searchable: answered by the probe (found after 0.2 s, by `data.enquiry_key` and by recipient email).
- Error `message` and `code` texts are examples. Only the shape is specified.
