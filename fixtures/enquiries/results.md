# Eval results

Prompt v3, today fixed at 2026-11-04, 19 samples, run 2026-10-20T13:37:12.237Z.

## openai/gpt-5.4-nano

| Field | Pass rate |
| --- | --- |
| startDate | 94% (15/16) |
| endDate | 100% (3/3) |
| guests | 100% (16/16) |
| products | 100% (13/13) |
| language | 100% (15/15) |
| outcome | 84% (16/19) |

Samples fully correct: 79% (15/19). Quotes not found in the email: 1. Average 3.2 s and 2128 tokens per sample.

| Sample | Result | Detail |
| --- | --- | --- |
| about-guests | pass |  |
| av-only | pass |  |
| clean | FAIL | outcome: expected "draft", got "flagged_draft" |
| conflicting-dates | FAIL | outcome: expected "draft", got "flagged_draft" |
| dinner-share | pass |  |
| forwarded-thread | FAIL | outcome: expected "draft", got "flagged_draft" |
| german | pass |  |
| guest-typo | pass |  |
| newsletter | pass |  |
| no-dates | pass |  |
| no-year | pass |  |
| non-enquiry | pass |  |
| out-of-office | pass |  |
| past-date | pass |  |
| prompt-injection | pass |  |
| relative-date | FAIL | startDate: expected "2026-11-06", got "2026-11-13" |
| swedish | pass |  |
| vague | pass |  |
| wedding-rooms | pass |  |
