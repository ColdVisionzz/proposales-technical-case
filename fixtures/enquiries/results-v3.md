# Eval results

Prompt v3, today fixed at 2026-11-04, 19 samples, run 2026-10-20T14:45:53.312Z.

## openai/gpt-5.4-nano

| Field | Pass rate |
| --- | --- |
| startDate | 94% (15/16) |
| endDate | 100% (3/3) |
| guests | 100% (16/16) |
| products | 92% (12/13) |
| language | 100% (15/15) |
| outcome | 84% (16/19) |

Samples fully correct: 84% (16/19). Quotes not found in the email: 1. Average 3.2 s and 2130 tokens per sample.

| Sample | Result | Detail |
| --- | --- | --- |
| about-guests | pass |  |
| av-only | pass |  |
| clean | FAIL | why flagged_draft: products: "Lunch": quantity 48 was worked out by the model, check it; products: "Dinner": quantity 24 was worked out by the model, check it; products: "AV package": the model was only fairly sure (0.6) |
| conflicting-dates | FAIL | why flagged_draft: endDate: The model was only fairly sure about this (0.7) |
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
| relative-date | FAIL | why flagged_draft: startDate: The model was only fairly sure about this (0.75); startDate: Short notice: the event starts in 2 day(s); endDate: The model was only fairly sure about this (0.7) |
| swedish | pass |  |
| vague | pass |  |
| wedding-rooms | pass |  |
