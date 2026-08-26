-- Which show a source came from.
--
-- Everything in the library today is The Drive, so nothing has needed to say so.
-- FoundMyFitness and Huberman Lab are next, and a catalogue that cannot group by
-- show is not a catalogue — the product owner needs to see, per show, how many
-- episodes exist and how many have actually been ingested.
--
-- Deriving this from the `external_id` prefix would work today ('attia-0405')
-- but not for the 125 rows ingested from YouTube before feed ids existed, and it
-- silently couples a display concern to an identifier format. A column is
-- cheaper to reason about and survives a change of id scheme.
--
-- Nullable on purpose: a one-off article or a manually added source belongs to
-- no show, and forcing one would invent a fact.

alter table sources add column if not exists series text;

comment on column sources.series is
  'Podcast/show this source belongs to (e.g. ''The Drive''). Null for standalone articles and manual sources.';

-- Backfill. Every existing row is The Drive: the 425 feed rows carry an
-- attia- prefix, and the pre-feed YouTube rows are the same podcast ingested a
-- different way.
update sources
   set series = 'The Drive'
 where series is null
   and (external_id like 'attia-%' or type in ('podcast', 'video'));

create index if not exists sources_series_idx on sources (series);
