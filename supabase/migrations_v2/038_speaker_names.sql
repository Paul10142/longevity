-- 038_speaker_names.sql
--
-- STATUS: NOT APPLIED. Apply via the Supabase SQL Editor (LifestyleAcademy project).
--
-- Who each unnamed voice of an episode is, as decided by a person on /admin/speakers.
--
-- Diarization (Deepgram) numbers the voices of an episode but never says who they are.
-- With one guest and one other voice the attach step names the guest on its own. With a
-- third voice it does not guess: the review page shows each unnamed voice (`Speaker 2`,
-- `Speaker 3`, ...), the first thing it says and a link to the original, and Paul clicks
-- the right name. That answer lives here, and ONLY here: the transcript itself is never
-- edited by the page. scripts/attachTranscripts.ts reads this column when it re-attaches the
-- episode and writes the names into a fresh transcript, after checking each answer's `check`
-- against the voice that now carries that label.
--
-- Shape (label = the `Speaker N` label the stored transcript carries):
--   {
--     "Speaker 2": { "name": "Rhonda Patrick", "check": "welcome to another episode of the" },
--     "Speaker 3": { "name": "Ronald Krauss",   "check": "thanks so much for having me" },
--     "Speaker 4": { "name": null,              "check": "this episode is brought to you" }
--   }
--   name   a bare name from the row's `authors` (or the show's host label); null = "not a
--          guest" (an ad, a clip, a producer), so that voice stays `Speaker N`
--   check  fingerprint of the first thing that voice says (lowercase letters and digits, the
--          first 60 characters); a re-attach whose file no longer matches ignores the mapping
--
-- STRICTLY ADDITIVE: one nullable column, nothing existing is altered, no default, no backfill.
-- Null means nobody has reviewed the episode. The code tolerates the column being absent
-- (the page then says migration 038 is not applied and saving is off).

alter table sources
  add column if not exists speaker_names jsonb;

comment on column sources.speaker_names is
  'Reviewed speaker names, keyed by transcript label: {"Speaker 2": {"name": "Rhonda Patrick" | null, "check": "<fingerprint of the first utterance>"}}. Written only by /admin/speakers; read by scripts/attachTranscripts.ts at re-attach. null = not reviewed.';
