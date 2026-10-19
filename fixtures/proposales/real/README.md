# Recorded Proposales responses

These files are what the live Proposales API actually returned, saved by `npm run probe` on 2026-10-19 against a free test account. They are not hand-written. Where one disagrees with `../synthetic/` (written from the OpenAPI file before access existed), **this folder wins** and the synthetic file was corrected.

## What was changed after recording

Only personal and account data, so the folder can live in a public repo:

- The API key and the account's inbox token are replaced with `REDACTED` by the probe. (This account has no inbox token.)
- The account owner's name, email and the company name are replaced with `Example Owner`, `owner@hotel.example.com` and `Example Hotel`. The probe now does this itself (`scrub` in `scripts/probe-lib.ts`). The first run predates that, so those three values and a user id in `get-proposal*.json` were replaced by hand.

Everything else is untouched: ids, timestamps, urls, prices and field order are as received. The product ids (`190929` and up) belong to the test account's seeded catalog.

## Files

| File | What it is |
| --- | --- |
| `companies.200.json` | `GET /v3/companies`. Note `inbox_token` and `timezone` are null, and `website_url` is `""`, which breaks the spec |
| `content.200.json` | `GET /v3/content`, the five seeded products |
| `create-*.request.json` | Requests the probe sent. `create-proposal` uses variation ids as `content_id`, `create-proposal-productids` uses product ids |
| `create-*.200.json` | `POST /v3/proposals` answers. The "duplicate" file is the same request sent twice: it made a second draft |
| `get-proposal*.200.json` | `GET /v3/proposals/{uuid}` read-back. Variation ids gave 2 blocks, product ids gave **0 blocks** with no error |
| `search-*.200.json` | `GET /v3/proposal-search` by `data.enquiry_key` and by recipient email. Both found a fresh draft within 0.2 s |
| `error.400.json`, `error.401.json` | Error shapes for an invalid body and a bad key |

`tests/proposales-fixtures.test.ts` checks these files against the OpenAPI schemas. The generated `probe-report.md` is not committed (see `.gitignore`).

## Refreshing

Run `npm run probe`. It creates a few `[PROBE]` drafts in the account; delete them in the Proposales UI afterwards. If the seeded products change, re-run it so the ids here match.
