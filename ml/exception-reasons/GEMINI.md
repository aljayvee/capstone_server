# A second opinion on exception reasons

Measured 2026-09-25T16:37:35.373Z by `scripts/exception-reasons/secondOpinion.ts`. The network
(README.md) picks a reason from the errand's figures; the second opinion is a large model reading the
same figures and the rider's note, choosing among the same filled-in reasons or saying none fits
(`ml/sugo_category/gemma.py`, `POST /advise`). The two are pooled; a reason is suggested at
0.75 or above, as before.

Two weights on the model's answer: one where the network read the rider's note through its word
lists (or there was none), one where there is a note none of them catches, which the network cannot
read at all. Both are chosen on the validation rows by right + rightly silent - 2 x wrong: a wrong
suggestion is the costly outcome, because a busy dispatcher accepts what is in the box.

## gemini-3.8-flash

At the shipped weights: 0 where the network read the note (or there is none), 0.8 where it could not. This model's own best pair on validation: 0 and 0.8.

### Generated rows, test split (96 rows)

| | Right suggestion | Wrong suggestion | Silent, a reason fits | Rightly silent |
|---|---|---|---|---|
| Network alone | 81 | 3 | 12 | 0 |
| Network + gemini-3.8-flash | 80 | 3 | 13 | 0 |

gemini-3.8-flash alone named the right reason (or rightly said none fits) on 67 of 96 (70%).

### Notes the word lists miss, and cases no reason fits (test half) (12 rows)

| | Right suggestion | Wrong suggestion | Silent, a reason fits | Rightly silent |
|---|---|---|---|---|
| Network alone | 4 | 4 | 3 | 1 |
| Network + gemini-3.8-flash | 9 | 0 | 1 | 2 |

gemini-3.8-flash alone named the right reason (or rightly said none fits) on 11 of 12 (92%).

### Production's labelled exceptions (3 rows)

| | Right suggestion | Wrong suggestion | Silent, a reason fits | Rightly silent |
|---|---|---|---|---|
| Network alone | 1 | 1 | 1 | 0 |
| Network + gemini-3.8-flash | 1 | 1 | 1 | 0 |

gemini-3.8-flash alone named the right reason (or rightly said none fits) on 1 of 3 (33%).

### Validation rows (chose the weights) (109 rows)

| | Right suggestion | Wrong suggestion | Silent, a reason fits | Rightly silent |
|---|---|---|---|---|
| Network alone | 79 | 9 | 20 | 1 |
| Network + gemini-3.8-flash | 84 | 4 | 18 | 3 |

gemini-3.8-flash alone named the right reason (or rightly said none fits) on 76 of 109 (70%).

### Validation utility at every pair of weights

| Read note \ unread note | 0 | 0.5 | 0.6 | 0.7 | 0.8 | 0.9 |
|---|---|---|---|---|---|---|
| 0 | 62 | 74 | 74 | 76 | 79 | 79 |
| 0.3 | 44 | 56 | 56 | 58 | 61 | 61 |
| 0.4 | 43 | 55 | 55 | 57 | 60 | 60 |
| 0.5 | 38 | 50 | 50 | 52 | 55 | 55 |
| 0.6 | 38 | 50 | 50 | 52 | 55 | 55 |
| 0.7 | 34 | 46 | 46 | 48 | 51 | 51 |

### The hard and real rows one by one, at the shipped weights

| Row | Label | Rider's note | Note unread | Network | Model | Suggested |
|---|---|---|---|---|---|---|
| hard-validation-192 | CASH_NO_EXACT_CHANGE | wala sinsilyo si customer | yes | CASH_RIDER_TO_REMIT 0.82 | CASH_NO_EXACT_CHANGE 0.95 | CASH_NO_EXACT_CHANGE |
| hard-test-193 | CASH_NO_EXACT_CHANGE | wala sila baryang gamay, gin-round off ko na lang | yes | CASH_RIDER_TO_REMIT 0.51 | CASH_NO_EXACT_CHANGE 0.95 | CASH_NO_EXACT_CHANGE |
| hard-validation-194 | CASH_NO_EXACT_CHANGE | puro 1000 ang kwarta ni ate, wala gamay | yes | CASH_RIDER_TO_REMIT 0.63 | CASH_NO_EXACT_CHANGE 0.95 | CASH_NO_EXACT_CHANGE |
| hard-test-195 | CASH_NO_EXACT_CHANGE | no coins daw, kulang 20 | yes | CASH_RIDER_TO_REMIT 0.76 | CASH_NO_EXACT_CHANGE 0.95 | CASH_NO_EXACT_CHANGE |
| hard-validation-196 | CASH_PAID_BY_TRANSFER | gin-send na lang niya sa e-wallet ang kulang | yes | CASH_RIDER_TO_REMIT 0.64 | CASH_PAID_BY_TRANSFER 0.98 | CASH_PAID_BY_TRANSFER |
| hard-test-197 | CASH_PAID_BY_TRANSFER | nagpadala siya sa GoTyme ang kulang | yes | CASH_RIDER_TO_REMIT 0.81 | CASH_PAID_BY_TRANSFER 0.95 | CASH_PAID_BY_TRANSFER |
| hard-validation-198 | CASH_PAID_BY_TRANSFER | ipadala daw sa app, na-send na | yes | CASH_RIDER_TO_REMIT 0.79 | CASH_PAID_BY_TRANSFER 0.95 | CASH_PAID_BY_TRANSFER |
| hard-test-199 | CASH_PAID_BY_TRANSFER | binayad thru QR ang kulang | yes | CASH_RIDER_TO_REMIT 0.91 | CASH_PAID_BY_TRANSFER 0.95 | CASH_PAID_BY_TRANSFER |
| hard-validation-200 | CASH_RIDER_TO_REMIT | ako na bahala, remit ko ugma ang kulang | yes | CASH_RIDER_TO_REMIT 0.88 | CASH_RIDER_TO_REMIT 0.95 | CASH_RIDER_TO_REMIT |
| hard-test-201 | CASH_RIDER_TO_REMIT | nahulog ko ang kwarta sa dalan, bayaran ko | yes | CASH_RIDER_TO_REMIT 0.76 | CASH_RIDER_TO_REMIT 0.95 | CASH_RIDER_TO_REMIT |
| hard-validation-202 | CASH_RIDER_TO_REMIT | akon sala, ibawas na lang sa sweldo ko | yes | CASH_RIDER_TO_REMIT 0.55 | CASH_RIDER_TO_REMIT 0.98 | CASH_RIDER_TO_REMIT |
| hard-test-203 | CASH_RIDER_TO_REMIT | kulang akon dala, ihatag ko bukas sa office | yes | CASH_RIDER_TO_REMIT 0.91 | CASH_RIDER_TO_REMIT 0.98 | CASH_RIDER_TO_REMIT |
| hard-validation-204 | CASH_OVER_TIP | para sa imo na lang daw ang sobra | yes | CASH_RIDER_TO_REMIT 0.82 | NONE 0.85 | nothing |
| hard-test-205 | CASH_OVER_TIP | sa akin na daw ang sobra, pang-merienda | yes | CASH_OVER_TO_RETURN 0.66 | CASH_OVER_TIP 0.95 | CASH_OVER_TIP |
| hard-validation-206 | CASH_OVER_TIP | ginhatag sa akon ang sobra ni sir | yes | CASH_OVER_TO_RETURN 0.51 | CASH_OVER_TIP 0.95 | CASH_OVER_TIP |
| hard-test-207 | CASH_OVER_TIP | sobra, pero ayaw na daw kuhaon, salamat daw | yes | CASH_OVER_TO_RETURN 0.68 | CASH_OVER_TIP 0.95 | CASH_OVER_TIP |
| hard-validation-208 | CASH_OVER_TO_RETURN | iuli ko ang sobra sa customer mamaya | yes | CASH_OVER_TO_RETURN 0.98 | CASH_OVER_TO_RETURN 0.98 | CASH_OVER_TO_RETURN |
| hard-test-209 | CASH_OVER_TO_RETURN | sobra ang bayad, isauli ko bukas | yes | CASH_OVER_TO_RETURN 0.98 | CASH_OVER_TO_RETURN 0.98 | CASH_OVER_TO_RETURN |
| hard-validation-210 | CASH_OVER_TO_RETURN | nasobrahan ang bayad niya, ihatid ko ang sobra | yes | CASH_OVER_TO_RETURN 0.99 | CASH_OVER_TO_RETURN 0.98 | CASH_OVER_TO_RETURN |
| hard-test-211 | CASH_OVER_TO_RETURN | dapat 500 lang, 600 ang gin-hatag, balik ko ang 100 | yes | CASH_OVER_TO_RETURN 0.98 | NONE 0.88 | nothing |
| hard-validation-212 | NONE | may nabuong itlog, gin-bawasan ang bayad | yes | CASH_RIDER_TO_REMIT 0.77 | NONE 0.95 | nothing |
| hard-test-213 | NONE | gin-refund sang tindahan ang isa ka item direkta sa customer | yes | CASH_RIDER_TO_REMIT 0.74 | NONE 0.95 | nothing |
| hard-validation-214 | NONE | ginbayaran man niya ang utang sa previous order | yes | CASH_OVER_TO_RETURN 0.96 | NONE 0.95 | nothing |
| hard-test-215 | NONE | ayaw magbayad sang delivery fee kay late daw kami | yes | CASH_RIDER_TO_REMIT 0.78 | NONE 0.95 | nothing |
| hard-validation-216 | NONE | nag-discount ang tindahan pero wala na-update ang total | yes | CASH_RIDER_TO_REMIT 0.44 | NONE 0.95 | nothing |
| real-real-217 | UNVERIFIED_SMALL_SHOP | (none) | no | UNVERIFIED_SMALL_SHOP 0.85 | UNVERIFIED_PAID_IN_FULL 0.85 | UNVERIFIED_SMALL_SHOP |
| real-real-218 | NONE | (none) | no | CASH_OVER_TO_RETURN 0.88 | CASH_OVER_TO_RETURN 0.85 | CASH_OVER_TO_RETURN |
| real-real-219 | UNVERIFIED_PAID_IN_FULL | (none) | no | UNVERIFIED_RECEIPT_LOST 0.57 | UNVERIFIED_PAID_IN_FULL 0.85 | nothing |

One question: median 1998 ms, 90th percentile 3508 ms.

## gemma-4-26b-a4b-it

At the shipped weights: 0 where the network read the note (or there is none), 0.8 where it could not. This model's own best pair on validation: 0 and 0.7.

### Generated rows, test split (96 rows)

| | Right suggestion | Wrong suggestion | Silent, a reason fits | Rightly silent |
|---|---|---|---|---|
| Network alone | 81 | 3 | 12 | 0 |
| Network + gemma-4-26b-a4b-it | 81 | 3 | 12 | 0 |

gemma-4-26b-a4b-it alone named the right reason (or rightly said none fits) on 46 of 96 (48%).

### Notes the word lists miss, and cases no reason fits (test half) (12 rows)

| | Right suggestion | Wrong suggestion | Silent, a reason fits | Rightly silent |
|---|---|---|---|---|
| Network alone | 4 | 4 | 3 | 1 |
| Network + gemma-4-26b-a4b-it | 9 | 2 | 1 | 0 |

gemma-4-26b-a4b-it alone named the right reason (or rightly said none fits) on 10 of 12 (83%).

### Production's labelled exceptions (3 rows)

| | Right suggestion | Wrong suggestion | Silent, a reason fits | Rightly silent |
|---|---|---|---|---|
| Network alone | 1 | 1 | 1 | 0 |
| Network + gemma-4-26b-a4b-it | 1 | 1 | 1 | 0 |

gemma-4-26b-a4b-it alone named the right reason (or rightly said none fits) on 1 of 3 (33%).

### Validation rows (chose the weights) (109 rows)

| | Right suggestion | Wrong suggestion | Silent, a reason fits | Rightly silent |
|---|---|---|---|---|
| Network alone | 79 | 9 | 20 | 1 |
| Network + gemma-4-26b-a4b-it | 84 | 7 | 17 | 1 |

gemma-4-26b-a4b-it alone named the right reason (or rightly said none fits) on 48 of 109 (44%).

### Validation utility at every pair of weights

| Read note \ unread note | 0 | 0.5 | 0.6 | 0.7 | 0.8 | 0.9 |
|---|---|---|---|---|---|---|
| 0 | 62 | 70 | 70 | 72 | 71 | 69 |
| 0.3 | 28 | 36 | 36 | 38 | 37 | 35 |
| 0.4 | 26 | 34 | 34 | 36 | 35 | 33 |
| 0.5 | 25 | 33 | 33 | 35 | 34 | 32 |
| 0.6 | 24 | 32 | 32 | 34 | 33 | 31 |
| 0.7 | 23 | 31 | 31 | 33 | 32 | 30 |

### The hard and real rows one by one, at the shipped weights

| Row | Label | Rider's note | Note unread | Network | Model | Suggested |
|---|---|---|---|---|---|---|
| hard-validation-192 | CASH_NO_EXACT_CHANGE | wala sinsilyo si customer | yes | CASH_RIDER_TO_REMIT 0.82 | CASH_NO_EXACT_CHANGE 0.95 | CASH_NO_EXACT_CHANGE |
| hard-test-193 | CASH_NO_EXACT_CHANGE | wala sila baryang gamay, gin-round off ko na lang | yes | CASH_RIDER_TO_REMIT 0.51 | CASH_NO_EXACT_CHANGE 0.95 | CASH_NO_EXACT_CHANGE |
| hard-validation-194 | CASH_NO_EXACT_CHANGE | puro 1000 ang kwarta ni ate, wala gamay | yes | CASH_RIDER_TO_REMIT 0.63 | CASH_RIDER_TO_REMIT 0.9 | CASH_RIDER_TO_REMIT |
| hard-test-195 | CASH_NO_EXACT_CHANGE | no coins daw, kulang 20 | yes | CASH_RIDER_TO_REMIT 0.76 | CASH_NO_EXACT_CHANGE 0.85 | nothing |
| hard-validation-196 | CASH_PAID_BY_TRANSFER | gin-send na lang niya sa e-wallet ang kulang | yes | CASH_RIDER_TO_REMIT 0.64 | CASH_PAID_BY_TRANSFER 0.95 | CASH_PAID_BY_TRANSFER |
| hard-test-197 | CASH_PAID_BY_TRANSFER | nagpadala siya sa GoTyme ang kulang | yes | CASH_RIDER_TO_REMIT 0.81 | CASH_PAID_BY_TRANSFER 0.95 | CASH_PAID_BY_TRANSFER |
| hard-validation-198 | CASH_PAID_BY_TRANSFER | ipadala daw sa app, na-send na | yes | CASH_RIDER_TO_REMIT 0.79 | CASH_PAID_BY_TRANSFER 0.9 | CASH_PAID_BY_TRANSFER |
| hard-test-199 | CASH_PAID_BY_TRANSFER | binayad thru QR ang kulang | yes | CASH_RIDER_TO_REMIT 0.91 | CASH_PAID_BY_TRANSFER 0.95 | CASH_PAID_BY_TRANSFER |
| hard-validation-200 | CASH_RIDER_TO_REMIT | ako na bahala, remit ko ugma ang kulang | yes | CASH_RIDER_TO_REMIT 0.88 | CASH_RIDER_TO_REMIT 0.95 | CASH_RIDER_TO_REMIT |
| hard-test-201 | CASH_RIDER_TO_REMIT | nahulog ko ang kwarta sa dalan, bayaran ko | yes | CASH_RIDER_TO_REMIT 0.76 | CASH_RIDER_TO_REMIT 0.95 | CASH_RIDER_TO_REMIT |
| hard-validation-202 | CASH_RIDER_TO_REMIT | akon sala, ibawas na lang sa sweldo ko | yes | CASH_RIDER_TO_REMIT 0.55 | CASH_RIDER_TO_REMIT 0.95 | CASH_RIDER_TO_REMIT |
| hard-test-203 | CASH_RIDER_TO_REMIT | kulang akon dala, ihatag ko bukas sa office | yes | CASH_RIDER_TO_REMIT 0.91 | CASH_RIDER_TO_REMIT 0.95 | CASH_RIDER_TO_REMIT |
| hard-validation-204 | CASH_OVER_TIP | para sa imo na lang daw ang sobra | yes | CASH_RIDER_TO_REMIT 0.82 | CASH_OVER_TIP 0.9 | nothing |
| hard-test-205 | CASH_OVER_TIP | sa akin na daw ang sobra, pang-merienda | yes | CASH_OVER_TO_RETURN 0.66 | CASH_OVER_TIP 0.95 | CASH_OVER_TIP |
| hard-validation-206 | CASH_OVER_TIP | ginhatag sa akon ang sobra ni sir | yes | CASH_OVER_TO_RETURN 0.51 | CASH_OVER_TIP 0.9 | CASH_OVER_TIP |
| hard-test-207 | CASH_OVER_TIP | sobra, pero ayaw na daw kuhaon, salamat daw | yes | CASH_OVER_TO_RETURN 0.68 | CASH_OVER_TIP 0.95 | CASH_OVER_TIP |
| hard-validation-208 | CASH_OVER_TO_RETURN | iuli ko ang sobra sa customer mamaya | yes | CASH_OVER_TO_RETURN 0.98 | CASH_OVER_TO_RETURN 0.95 | CASH_OVER_TO_RETURN |
| hard-test-209 | CASH_OVER_TO_RETURN | sobra ang bayad, isauli ko bukas | yes | CASH_OVER_TO_RETURN 0.98 | CASH_OVER_TO_RETURN 0.95 | CASH_OVER_TO_RETURN |
| hard-validation-210 | CASH_OVER_TO_RETURN | nasobrahan ang bayad niya, ihatid ko ang sobra | yes | CASH_OVER_TO_RETURN 0.99 | CASH_OVER_TO_RETURN 0.95 | CASH_OVER_TO_RETURN |
| hard-test-211 | CASH_OVER_TO_RETURN | dapat 500 lang, 600 ang gin-hatag, balik ko ang 100 | yes | CASH_OVER_TO_RETURN 0.98 | CASH_OVER_TO_RETURN 0.9 | CASH_OVER_TO_RETURN |
| hard-validation-212 | NONE | may nabuong itlog, gin-bawasan ang bayad | yes | CASH_RIDER_TO_REMIT 0.77 | CASH_RIDER_TO_REMIT 0.9 | CASH_RIDER_TO_REMIT |
| hard-test-213 | NONE | gin-refund sang tindahan ang isa ka item direkta sa customer | yes | CASH_RIDER_TO_REMIT 0.74 | CASH_RIDER_TO_REMIT 0.9 | CASH_RIDER_TO_REMIT |
| hard-validation-214 | NONE | ginbayaran man niya ang utang sa previous order | yes | CASH_OVER_TO_RETURN 0.96 | CASH_OVER_TIP 0.9 | nothing |
| hard-test-215 | NONE | ayaw magbayad sang delivery fee kay late daw kami | yes | CASH_RIDER_TO_REMIT 0.78 | CASH_RIDER_TO_REMIT 0.9 | CASH_RIDER_TO_REMIT |
| hard-validation-216 | NONE | nag-discount ang tindahan pero wala na-update ang total | yes | CASH_RIDER_TO_REMIT 0.44 | CASH_PAID_BY_TRANSFER 0.9 | CASH_PAID_BY_TRANSFER |
| real-real-217 | UNVERIFIED_SMALL_SHOP | (none) | no | UNVERIFIED_SMALL_SHOP 0.85 | UNVERIFIED_SMALL_SHOP 0.9 | UNVERIFIED_SMALL_SHOP |
| real-real-218 | NONE | (none) | no | CASH_OVER_TO_RETURN 0.88 | CASH_OVER_TO_RETURN 0.9 | CASH_OVER_TO_RETURN |
| real-real-219 | UNVERIFIED_PAID_IN_FULL | (none) | no | UNVERIFIED_RECEIPT_LOST 0.57 | UNVERIFIED_SMALL_SHOP 0.8 | nothing |

One question: median 1622 ms, 90th percentile 1799 ms.
