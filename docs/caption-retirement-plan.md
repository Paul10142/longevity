# Retiring the YouTube-caption sources — the written plan (2026-10-11)

Paul's rule, restated 2026-10-11 evening: the 243 sources extracted from
YouTube auto-captions are **replaced** by Deepgram transcripts of the same
episodes. Caption-derived information is known to be inaccurate, so once an
episode has its Deepgram version the caption version is **deleted** — its
facts, its text chunks, its transcript — not kept in an excluded state that
every reader has to filter correctly. The only caption-era things that survive
are empty retired claim shells (other tables point at their ids) and one frozen
benchmark snapshot. This is the plan that has to exist before any of that data
is touched. It is written for the agent that runs Phase B; every number was
verified on 2026-10-11.

## 1. What is actually there

| Set | Rows | What happens to the audio |
|---|---|---|
| Caption rows linked to a feed episode (`external_id` set) | 121 (117 pending, 4 extracted) | Deepgram transcript lands on **this same row** (`attachTranscripts.ts` matches on `external_id`); `transcript_origin` flips to `deepgram` |
| Caption rows not linked, with a pending feed row for the same episode number | 102 (98 extracted) | Transcript lands on the **feed row**; the caption row becomes a superseded duplicate |
| Caption rows not linked, with a Deepgram row already present | 20 (9 extracted twice) | Nothing to transcribe; retire the caption row's claims now |
| Caption rows with no episode number in the title | 4 (3 AMA previews, one early-format episode) | Decide per row; likely retire without replacement |

So "the 107 to redo" is really: transcribe the 329 remaining feed episodes
(208 pending feed rows + 121 linked caption rows), and retire the caption claims
of every episode once its Deepgram twin is extracted and consolidated. There is
no YouTube-audio download path to build.

Budget: 329 episodes ≈ 490–590 h ≈ $165–200 at the measured $0.34/h; ~$141 of
credit remains, so the run stops roughly 50–70 episodes short until Paul tops up
(his decision 2026-10-11: top up later, when it runs out).

## 2. Why a plain delete is not enough on its own

Three things the replacement has to handle that the earlier notes did not:

1. **Mixed claims (1,318 today).** A claim with members from a caption source
   AND a good source had its canonical rewritten by enrich-merge to carry every
   member's detail, including the caption member's, and caption transcripts
   carry transcription errors. Deleting the caption member alone leaves text
   that asserts something no surviving source says. Those claims must be
   re-derived from survivors. (782 Deepgram facts sit in such claims today, on
   the nine episodes already held twice.)
2. **Vectors.** A claim's vector is refreshed only on enrich rewrites; many
   mixed claims still carry their first member's vector, which may be the
   caption member's. Re-seed from the re-derived canonical.
3. **The existing re-extraction path already does a lossy version of this.** A
   fresh `extract_source` run deletes the source's `raw_insights`, which
   cascades its `claim_members` away, then `reconcile_claim_membership()` retires
   memberless claims and recounts the rest. It does **not** re-derive mixed
   claims. For the 121 linked rows that is the path a Deepgram re-extraction
   would take today, so the guard in §3 matters.

## 3. The replacement procedure (one script, `scripts/retireSourceClaims.ts`)

Run per caption source `S`. Dry-run by default; `--apply` writes. Before apply
it writes a JSON backup of every row it will change or delete to
`scratchpad/backups/`, as the review-queue scripts already do.

0. **Once, before the first run: freeze the benchmark.** Export the nine
   double-held episodes' caption facts (statement, context, quote, embedding,
   claim membership) to `eval/twin-benchmark-20261011.json`, and teach
   `scripts/evalTwinRecall.ts` to read that file when the live rows are gone.
   Recall must stay measurable after the captions are deleted.
1. **Unhook.** Delete every `claim_members` row whose `raw_insight_id` belongs
   to `S` (the backup holds the list).
2. **Retire the emptied claims.** Any claim left with no members →
   `status = 'retired'`, `member_count = 0`, `source_count = 0` (the same rule
   `reconcile_claim_membership()` applies). The shell stays because
   `merge_reviews`, `claim_links`, `claim_topics` and the old articles point at
   its id; with no members it is invisible to the library.
3. **Re-derive the mixed claims.** For each claim that lost some but not all
   members: set `canonical_statement` and `context_note` back to the oldest
   surviving member's statement/context (the new seed), recompute aggregates,
   run `enrichClaimCanonical()` so the survivors' detail is folded back in under
   the fidelity guard, and refresh the vector from the new canonical.
4. **Close the reviews.** `merge_reviews` rows (`pending`) where either claim
   is now retired → `status = 'rejected'`, `decided_by = 'retired-source'`,
   `decided_at = now()`. Never deleted, so the history stays readable.
5. **Delete the caption version.** `S`'s `raw_insights` and `chunks` rows go.
   Then, by row type: a **duplicate row** (no feed link, a feed row exists for
   the same episode) is deleted outright; a **linked row** keeps its id and feed
   fields but has `transcript` and `timed_transcript` cleared and
   `processing_status = 'pending'`, so the Deepgram transcript lands on a clean
   row. Nothing else references chunks or insights once the members are gone.
6. **Verify, in SQL, before moving on:** no active claim has a member from `S`
   (or from a deleted row); no active claim has `member_count = 0`; every
   re-derived claim has a vector row; no `raw_insights` remain for `S`; the
   counts of retired / re-derived / closed / deleted match the dry run.

**Order per episode:** retire and delete the caption version **first**, then
transcribe, attach and extract the Deepgram version. Deepgram facts then seed
fresh claims or merge into good-transcript claims; nothing is ever seeded by
caption text again. For the nine episodes already held twice, step 3 is what
repairs the claims that were seeded by captions and later gained Deepgram
members.

Add a guard in `extractSource`: a fresh run on a source that still has
`claim_members` throws unless `ALLOW_MEMBERED_REEXTRACT=1`, so nobody can skip
steps 1–5 by accident. Migration 031 then only has to drop `claims.embedding`;
no `superseded` status and no retired-members table are needed.

## 4. Order of transcription (what to spend the credit on first)

1. The twins of the **98 extracted, unlinked** caption rows: these replace bad
   content already in the library (about 216 h).
2. The **4 extracted, linked** caption rows (8 h).
3. The remaining pending feed episodes, newest first (the current scripts'
   order).

The 20 caption rows that already have a Deepgram twin are retired first of all,
once the script exists, because nothing has to be transcribed for them.

## 5. What this does to the library

Today: 31,574 active claims, 16,850 caption-only, 1,318 mixed; 19,887 caption
facts (132 MB) and 39 MB of caption transcripts. After the full redo roughly
16,850 claims retire to empty shells and are replaced by the Deepgram
extractions' claims, which merge into the good-transcript corpus at the new
gate; the caption facts and transcripts are gone. The 213 pending merge reviews
shrink by the 117 that touch caption-era claims. Topic counts and the admin
dashboard recompute from status, nothing else.

## 6. Still to decide

- Whether the 4 un-numbered caption videos (AMA previews) are deleted without
  replacement or kept. Recommendation: delete; the AMA full episodes are in the
  feed.
