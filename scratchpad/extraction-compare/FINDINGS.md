# Extraction comparison: how to read REPORT.md (2026-11-08)

Same 8 episodes, same 442 stored chunks, same judge (Opus 5.5), new v2 prompt + gate + one repair round on each model.
Rates are judge flags (ADDED_DETAIL + DROPPED_QUALIFIER + UNRESOLVED_REFERENCE) over judged insights. The stored row is the old
extraction (Haiku 4.5, old prompt) re-judged at insight level: 33.5%, in line with the 35% claim-level sample.

| Variant | Insights kept (vs 1,258 stored) | Faithful kept (stored 835) | Flag rate | Added detail / Dropped qualifier |
| --- | --- | --- | --- | --- |
| Stored: Haiku 4.5, old prompt | 1,258 | 835 | 33.5% | 260 / 161 |
| Haiku 4.5, new prompt + gate | 1,649 (131%) | 1,276 | 22.4% | 214 / 148 |
| Sonnet 5.5, new prompt + gate | 1,398 (111%) | 1,241 | 11.2% | 105 / 33 |
| Opus 5.5, new prompt + gate | 1,550 (123%) | 1,412 | 8.9% | 83 / 38 |

Gold set (Paul's 40 labels, 31 chunks): stored 12.5% (5 of 40); Haiku 11.7%, Sonnet 7.2%, Opus 7.4% on the re-extraction.

## What the numbers say
- The model matters more than the prompt. The new prompt alone on Haiku lowers the rate from 33.5% to 22.4%; Sonnet and Opus take it to 11% and 9%.
- No useful content is lost: every variant keeps at least as many insights as before (111% to 131%) and keeps far more faithful ones (Opus 1,412 vs 835).
- Dropped qualifiers fall most (161 to 33 to 38 for Sonnet/Opus). Added detail falls by about two thirds (260 to 83 on Opus).
- Per episode, Opus has the lowest flag rate on 7 of 8 episodes (Sonnet is lower only on the David Light episode). Sabatini (15.4%), David Light (15.1%) and the foot-health episode (12.8%) stay highest on Opus.

## The gate: honest limits
- The gate alone does not move the judge's flag rate: before the gate Opus is 8.6% and after gate + repair 8.9% (Haiku 22.1% / 22.4%, Sonnet 11.0% / 11.2%).
- Of the insights the gate rejected on the first pass, the judge called most faithful (Opus 61 of 69, Sonnet 48 of 55, Haiku 234 of 309). The gate's hedge rule is stricter than the judge's, on purpose (Paul's guidance: a hedge stays), so it counts as a cost, not a catch, by the judge's measure.
- The repair round gives almost all of them back: The repair call returned 66 corrected insights that passed for Opus's 69 rejections, 50 for Sonnet's 55, and 262 for Haiku's 309. The net cost is about 4% extra calls on Sonnet/Opus and 12% on Haiku.
- The gate misses most of what the judge flags (Opus 126 flagged insights passed it). Invented mechanisms and narrowed scope cannot be checked mechanically; the prompt and the model carry those.
- What the gate does give: quote verification (Haiku returned 117 quotes that are not in the chunk; Sonnet 7; Opus 1), a number check (Opus 34 insights with a figure not in the text) and a hedge check to Paul's standard.
- On Paul's 40 labels (no model call): the gate catches 2 of the 5 flawed ones and wrongly rejects 4 of the 35 faithful ones.

## Caveats on time and cost
- Time and cost come from the Claude command-line tool's own report. Per-call cost is dominated by the tool's fixed overhead (about 26k tokens of its own setup on every call), so Haiku is not cheaper per call in this setup and the dollar figures are not API prices.
- Haiku ran first while the Mac was heavily loaded by other sessions (load average about 10), so its minutes are inflated. Sonnet and Opus ran under lighter load: both took about 16 minutes of serial time per episode.
- Not measured: Opus with a capped reasoning effort, or Sonnet with the old prompt.
