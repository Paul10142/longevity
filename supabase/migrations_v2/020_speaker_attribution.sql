-- 020: speaker attribution on raw insights.
--
-- The extraction prompt deliberately keeps speaker names OUT of the insight
-- statement (statements must stand alone), which meant nothing recorded WHO
-- said each thing — an insight from a guest-expert interview was
-- indistinguishable from the host's own commentary. For a physician-facing
-- product built on expert provenance, that attribution is first-class data.
--
-- `speaker` is MODEL-INFERRED from conversational context: YouTube transcripts
-- carry no speaker labels, so the extractor attributes from cues (interviewer
-- vs expert answers, names used in dialogue, the episode's participant list).
-- NULL means "could not tell confidently" — the prompt instructs null over
-- guessing. Existing rows stay NULL until the backfill pass re-reads their
-- stored chunks.

alter table raw_insights add column if not exists speaker text;

comment on column raw_insights.speaker is
  'Who stated this insight, model-inferred from conversational context (transcripts are unlabeled). NULL = could not attribute confidently. Added 2026-08-14; rows before then await backfill.';
