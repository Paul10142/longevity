-- Feed metadata for podcast sources.
--
-- The RSS feed carries per-episode detail that has nowhere to live today:
--   * description  — 416 of 425 Attia episodes ship a TIMESTAMPED topic outline
--                    in <description>. That is a per-episode table of contents
--                    aligned to the same clock as the transcript, so it gives
--                    section boundaries for free AND a coverage check (a listed
--                    topic with no extracted claim in that time range is a gap
--                    we can detect rather than guess at).
--   * episode_number — what the show notes are filed under and what a human
--                    recognises. Recoverable from the title today only by regex.
--
-- All additive and nullable: existing YouTube-origin rows keep working untouched.

alter table sources add column if not exists description text;
alter table sources add column if not exists episode_number int;

-- `external_id` is the join key between a feed episode, its downloaded audio
-- file, and its finished transcript (`attia-0405`). Re-running the feed ingest
-- must update the existing row rather than insert a second one, so the uniqueness
-- has to be enforced by the database, not by the script remembering to check.
-- Partial, because pre-feed rows have a null external_id and several share it.
create unique index if not exists sources_external_id_key
  on sources (external_id)
  where external_id is not null;

comment on column sources.description is
  'Verbatim feed <description>. For podcast sources this usually contains the timestamped topic outline; used for section boundaries and extraction coverage checks, never as claim text.';
comment on column sources.episode_number is
  'Show episode number as published (e.g. 404). Null for specials and newsletter items that carry none.';
