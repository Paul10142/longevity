-- 008: One active topic per name.
--
-- Problem this solves: seedSpine (and any ensureTopic-style path) reads the
-- existing topics once, then inserts what's missing. Two runs overlapping in
-- time both read "absent" and both insert, and because slug collisions are
-- resolved by appending -2 the duplicate inserts *succeed silently*. That is
-- exactly what happened on 2026-07-22: a concurrent re-run of the spine seed
-- created 17 duplicate topics, including two `Risks` and two
-- `Medications & Supplements` ROOTS, splitting the curated spine in half.
--
-- The duplicates carried no claims and no articles, so they were re-parented
-- onto their survivor and deleted. This index makes the failure mode
-- impossible rather than merely unlikely: the second concurrent insert now
-- raises a unique violation instead of quietly forking the tree.
--
-- Scoped to active topics so archived/merged rows may keep a name that has
-- since been reused.

CREATE UNIQUE INDEX IF NOT EXISTS topics_active_name_uniq
  ON topics (lower(name)) WHERE status = 'active';

COMMENT ON INDEX topics_active_name_uniq IS
  'A topic name identifies one active topic. Guards the curated spine against duplicate roots from concurrent seeding.';
