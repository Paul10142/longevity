-- 008: One active topic per name within a sibling set.
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
-- Scoped per sibling set, NOT globally by name. A global rule looks tempting
-- but is wrong: "Hormones" legitimately belongs under both Risks and
-- Endocrinology, and "Medications" under Medications & Supplements. What must
-- never happen is two identically-named children of the SAME parent.
--
-- parent_id is COALESCEd to the nil UUID because NULLs compare as distinct in
-- a unique index — without it, top-level rows would be exempt and the very bug
-- this migration exists to prevent (two `Risks` roots) would still slip
-- through.
--
-- Scoped to active topics so archived/merged rows may keep a name that has
-- since been reused.

CREATE UNIQUE INDEX IF NOT EXISTS topics_active_name_per_parent_idx
  ON topics (lower(name), COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status = 'active';

COMMENT ON INDEX topics_active_name_per_parent_idx IS
  'A name identifies one active topic among its siblings. Guards the curated spine against duplicate roots from concurrent seeding, while allowing the same name under different branches.';

-- An earlier revision of this migration briefly created a global
-- lower(name) unique index. It is redundant with the per-parent index above
-- and too strict (it forbids the legitimate cross-branch names described
-- above), so drop it if a database still carries it.
DROP INDEX IF EXISTS topics_active_name_uniq;
