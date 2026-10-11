# Retiring the YouTube-caption sources — the written plan (2026-10-11)

Paul's rule (2026-08-24, reaffirmed 2026-10-11): the 243 sources extracted from
YouTube auto-captions are to be replaced by Deepgram transcripts of the same
episodes, and their claims retired **by removing members, never by deleting
claims**. This is the plan that has to exist before any of that data is touched.
It is written for the agent that runs Phase B; every number was verified on
2026-10-11.

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

## 2. Why "remove the members" is not enough on its own

Three things the retirement has to handle that the earlier notes did not:

1. **Mixed claims (1,318 today).** A claim with members from a caption source
   AND a good source had its canonical rewritten by enrich-merge to carry every
   member's detail, including the caption member's, and caption transcripts
   carry transcription errors. After the caption member is removed the text can
   assert something no surviving source says. Those claims must be re-derived
   from survivors.
2. **Vectors.** A claim's vector is refreshed only on enrich rewrites; many
   mixed claims still carry their first member's vector, which may be the
   caption member's. Re-seed from the surviving canonical.
3. **The existing re-extraction path already does a lossy retirement.** A fresh
   `extract_source` run deletes the source's `raw_insights`, which cascades its
   `claim_members` away, then `reconcile_claim_membership()` retires memberless
   claims and recounts the rest. It does **not** re-derive mixed claims and it
   keeps no record of which members went. For the 121 linked rows that is the
   path a Deepgram re-extraction would take today.

## 3. The retirement procedure (one script, `scripts/retireSourceClaims.ts`)

Run per caption source `S`, only after its Deepgram twin `D` is extracted and
fully consolidated (0 unconsolidated insights for `D`, no running jobs). Dry-run
by default; `--apply` writes. Backed up before apply (JSON of every row it will
change, in `scratchpad/`).

1. **Log, then remove.** Copy every `claim_members` row whose `raw_insight_id`
   belongs to `S` into `claim_members_retired` (new table, migration 031:
   same columns plus `source_id`, `retired_at`, `reason`), then delete them.
   The raw insights themselves are immutable and stay.
2. **Retire the emptied claims.** Any claim left with no members →
   `status = 'retired'`, `member_count = 0`, `source_count = 0` (the same rule
   `reconcile_claim_membership()` applies). Their `claim_topics` stay; readers
   filter on status.
3. **Re-derive the mixed claims.** For each claim that lost some but not all
   members: set `canonical_statement` and `context_note` back to the oldest
   surviving member's statement/context (the new seed), recompute aggregates,
   then run `enrichClaimCanonical()` so the survivors' detail is folded back in
   under the fidelity guard, then refresh the vector from the new canonical.
   `enriched_at` is re-stamped by that call.
4. **Close the reviews.** `merge_reviews` rows (`pending`) where either claim
   is now retired → `status = 'rejected'`, `decided_by = 'retired-source'`,
   `decided_at = now()`. Never deleted, so the history stays readable.
5. **Mark the source.** `S.processing_status = 'superseded'` (migration 031
   widens the CHECK, which today allows only pending / processing / succeeded /
   failed) and `S.transcript_quality = 'low'`. The row stays so the catalogue
   can show the episode once with its two transcripts.
6. **Verify, in SQL, before moving on:** no active claim has a member from `S`;
   no active claim has `member_count = 0`; every re-derived claim has a vector
   row; the counts of retired / re-derived / closed match the dry run.

Order of operations for a linked row (the 121): run the retirement script **on
the caption extraction first**, then attach the Deepgram transcript, then
extract. Add a guard in `extractSource`: a fresh run on a source that still has
`claim_members` throws unless `ALLOW_MEMBERED_REEXTRACT=1`, so nobody can skip
step 1 by accident.

## 4. Order of transcription (what to spend the credit on first)

1. The twins of the **98 extracted, unlinked** caption rows: these replace bad
   content already in the library (about 216 h).
2. The **4 extracted, linked** caption rows (8 h).
3. The remaining pending feed episodes, newest first (the current scripts'
   order).

The 20 caption rows that already have a Deepgram twin are retired first of all,
once the script exists, because nothing has to be transcribed for them.

## 5. What this does to the library

Today: 31,574 active claims, 16,850 caption-only, 1,318 mixed. After the full
redo roughly 16,850 claims retire and are replaced by the Deepgram extractions'
claims, which merge into the good-transcript corpus at the new gate. The 213
pending merge reviews shrink by the 117 that touch caption-era claims. Topic
counts and the admin dashboard recompute from status, nothing else.

## 6. Still to decide

- Whether the 4 un-numbered caption videos (AMA previews) are retired without
  replacement or kept. Recommendation: retire; the AMA full episodes are in the
  feed.
- Whether the catalogue should hide superseded rows by default. Recommendation:
  show them collapsed under the episode, with "superseded" on the pill.
