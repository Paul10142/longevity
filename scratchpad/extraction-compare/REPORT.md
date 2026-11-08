# Extraction comparison (same 8 episodes, same chunks, same judge)

Judge: claude-opus-5-5. Flag rate = ADDED_DETAIL + DROPPED_QUALIFIER + UNRESOLVED_REFERENCE over judged insights. Cost = the CLI's own list-price figure per call (includes its fixed overhead; the subscription is not billed per call).

## All 8 episodes

| Variant | Insights kept | vs stored | Faithful kept | Flag rate (kept) | Kinds (kept) | Flag rate before gate | Time / episode (serial) | Cost / episode (extract + judge) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Stored (haiku-4-5, old prompt)** | 1258 | 100% | 835 | 33.5% | AD 260 / DQ 161 / UR 0 | n/a | n/a | n/a |
| haiku (claude-haiku-4-5, new prompt + gate) | 1649 | 131.1% | 1276 | 22.4% | AD 214 / DQ 148 / UR 8 | 22.1% | 89.3 min | $7.85 ($3.74 + $4.12) |
| sonnet (claude-sonnet-5-5, new prompt + gate) | 1398 | 111.1% | 1241 | 11.2% | AD 105 / DQ 33 / UR 19 | 11.0% | 16.0 min | $4.52 ($1.52 + $3.01) |
| opus (claude-opus-5-5, new prompt + gate) | 1550 | 123.2% | 1412 | 8.9% | AD 83 / DQ 38 / UR 17 | 8.6% | 16.5 min | $6.03 ($2.72 + $3.31) |

Gate behaviour (first pass):

| Variant | Insights from model | Gate rejected | Of rejected: judged flawed | Of rejected: judged faithful | Passed but judged flawed | Repair rounds | Insights rescued by repair | Rejections by rule |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| haiku | 1696 | 309 (18.2%) | 73 | 234 | 302 | 200 | 262 | hedge_dropped 167, number_not_in_chunk 52, quote_not_in_chunk 117 |
| sonnet | 1403 | 55 (3.9%) | 7 | 48 | 148 | 47 | 50 | hedge_dropped 24, number_not_in_chunk 30, quote_not_in_chunk 7 |
| opus | 1553 | 69 (4.4%) | 8 | 61 | 126 | 61 | 66 | hedge_dropped 41, number_not_in_chunk 34, quote_not_in_chunk 1 |

### Per episode

| Episode | Chunks | Stored insights | Stored flag rate | haiku kept / flag rate / min | sonnet kept / flag rate / min | opus kept / flag rate / min |
| --- | --- | --- | --- | --- | --- | --- |
| #254 - AMA #47: Cold therapy: pros, cons, and it | 28 | 73 | 35.6% | 99 / 19.2% / 47.0 | 99 / 5.1% / 10.1 | 112 / 3.6% / 10.7 |
| #75 - David Light: Zantac recall due to cancer c | 40 | 101 | 32.7% | 137 / 25.5% / 67.5 | 128 / 10.9% / 13.3 | 146 / 15.1% / 13.6 |
| #262 - AMA #49: Heart rate recovery, strength tr | 38 | 146 | 28.8% | 178 / 23.6% / 80.1 | 163 / 6.7% / 13.8 | 180 / 5.6% / 14.7 |
| #09 – David Sabatini, M.D., Ph.D.: rapamycin and | 34 | 91 | 28.6% | 134 / 20.1% / 57.7 | 113 / 22.1% / 11.2 | 123 / 15.4% / 11.1 |
| #303 - A breakthrough in Alzheimer’s disease: th | 47 | 130 | 30.8% | 198 / 21.2% / 84.6 | 164 / 7.9% / 14.6 | 174 / 6.9% / 15.0 |
| #68–Marty Makary, MD: US healthcare system—why i | 79 | 223 | 41.7% | 277 / 31.4% / 149.4 | 225 / 17.3% / 22.8 | 226 / 8.8% / 21.9 |
| #334 - Cardiovascular disease, the number one ki | 56 | 245 | 33.5% | 301 / 15.6% / 107.3 | 254 / 5.5% / 18.5 | 300 / 4.7% / 22.8 |
| #296 ‒ Foot health: preventing and treating comm | 60 | 249 | 31.7% | 325 / 21.8% / 120.7 | 252 / 14.3% / 23.5 | 289 / 12.8% / 22.5 |

## Gold set (40 insights Paul labelled; stored row = Paul's labels, 5 of 40 ADDED_DETAIL)

| Variant | Insights kept | vs stored | Faithful kept | Flag rate (kept) | Kinds (kept) | Flag rate before gate | Time / episode (serial) | Cost / episode (extract + judge) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Stored (haiku-4-5, old prompt)** | 40 | 100% | 35 | 12.5% | AD 5 / DQ 0 / UR 0 | n/a | n/a | n/a |
| haiku (claude-haiku-4-5, new prompt + gate) | 154 | n/a (the 40 are a sample of these chunks) | 135 | 11.7% | AD 7 / DQ 11 / UR 0 | 10.8% | 54.6 min | $5.03 ($2.30 + $2.73) |
| sonnet (claude-sonnet-5-5, new prompt + gate) | 111 | n/a (the 40 are a sample of these chunks) | 103 | 7.2% | AD 0 / DQ 5 / UR 3 | 7.1% | 10.0 min | $2.85 ($1.19 + $1.66) |
| opus (claude-opus-5-5, new prompt + gate) | 135 | n/a (the 40 are a sample of these chunks) | 125 | 7.4% | AD 0 / DQ 8 / UR 2 | 7.4% | 11.8 min | $4.01 ($1.95 + $2.06) |

Gate behaviour (first pass):

| Variant | Insights from model | Gate rejected | Of rejected: judged flawed | Of rejected: judged faithful | Passed but judged flawed | Repair rounds | Insights rescued by repair | Rejections by rule |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| haiku | 157 | 20 (12.7%) | 0 | 20 | 17 | 13 | 17 | quote_not_in_chunk 6, hedge_dropped 13, number_not_in_chunk 4 |
| sonnet | 112 | 3 (2.7%) | 0 | 3 | 8 | 3 | 2 | number_not_in_chunk 2, hedge_dropped 1 |
| opus | 135 | 6 (4.4%) | 0 | 6 | 10 | 7 | 6 | hedge_dropped 5, number_not_in_chunk 1 |

