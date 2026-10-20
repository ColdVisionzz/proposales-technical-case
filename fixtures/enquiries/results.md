# Eval results

Prompt v4, today fixed at 2026-11-04, 19 samples, run 2026-10-20T14:51:08.806Z.

## openai/gpt-5.4-nano

| Field | Pass rate |
| --- | --- |
| startDate | 94% (15/16) |
| endDate | 100% (3/3) |
| guests | 100% (16/16) |
| products | 92% (12/13) |
| language | 100% (15/15) |
| outcome | 95% (18/19) |

Samples fully correct: 89% (17/19). Quotes not found in the email: 0. Average 2.9 s and 2232 tokens per sample.

| Sample | Result | Detail |
| --- | --- | --- |
| about-guests | pass |  |
| av-only | pass |  |
| clean | pass |  |
| conflicting-dates | pass |  |
| dinner-share | pass |  |
| forwarded-thread | pass |  |
| german | pass |  |
| guest-typo | pass |  |
| newsletter | pass |  |
| no-dates | pass |  |
| no-year | pass |  |
| non-enquiry | pass |  |
| out-of-office | pass |  |
| past-date | pass |  |
| prompt-injection | pass |  |
| relative-date | FAIL | why flagged_draft: startDate: Short notice: the event starts in 2 day(s) |
| swedish | pass |  |
| vague | pass |  |
| wedding-rooms | FAIL | products: expected [3003,3004], got [3004] |
