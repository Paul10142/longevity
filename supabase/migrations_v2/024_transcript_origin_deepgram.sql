-- Allow 'deepgram' as a transcript origin.
--
-- The existing set ('manual', 'fireflies', 'whisper', 'other') predates the
-- move off YouTube auto-captions. Every YouTube-captioned source is filed as
-- 'other', so without a distinct value the two would be indistinguishable —
-- and they are not remotely equivalent: 'other' means unpunctuated,
-- unattributed machine captions, while 'deepgram' means diarised,
-- punctuated, medical-model output with per-utterance speaker labels.
--
-- That distinction is load-bearing, not cosmetic. Speaker coverage is the
-- constraint on the whole corroboration feature (28% of insights carry a
-- speaker under the old captions), so knowing which transcript a claim came
-- from is how we tell trustworthy attribution from inferred attribution.

alter table sources drop constraint if exists sources_transcript_origin_check;

alter table sources add constraint sources_transcript_origin_check
  check (transcript_origin = any (array[
    'manual'::text,
    'fireflies'::text,
    'whisper'::text,
    'deepgram'::text,
    'other'::text
  ]));

comment on column sources.transcript_origin is
  'How the transcript was produced. ''deepgram'' carries per-utterance speaker labels and punctuation; ''other'' is YouTube auto-captions with neither.';
