-- 007: Curated taxonomy spine + gated topic creation.
--
-- Problem this solves: tagging could mint topics as a silent side effect
-- (lib/taxonomy.ts ensureTopic), including *top-level* ones when the model
-- named a parent that didn't exist. That is why the tree grew to 24 roots.
--
-- New model:
--   - A curated spine of top-level branches, created by a human and protected.
--   - Tagging may auto-create a CHILD under an existing approved topic.
--   - Anything that would create a new top-level branch becomes a proposal
--     for human approval instead (mirrors merge_reviews for claims).

-- ------------------------------------------------------------
-- 1. Protect the curated spine
-- ------------------------------------------------------------

-- `is_spine` marks a branch as part of the curated structure. The pipeline may
-- file claims into these and add children beneath them, but must never rename,
-- re-parent, merge, or archive them.
ALTER TABLE topics ADD COLUMN IF NOT EXISTS is_spine boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS topics_spine_idx ON topics (is_spine) WHERE is_spine;

COMMENT ON COLUMN topics.is_spine IS
  'Curated structural branch. AI may file claims into it and add children, but never rename/re-parent/merge/archive it.';

-- ------------------------------------------------------------
-- 2. Topic proposals (the approval queue)
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS topic_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  -- Suggested parent by name; null means the model wanted a new top-level
  -- branch, which always requires approval.
  proposed_parent_name text,
  proposed_parent_id uuid REFERENCES topics(id) ON DELETE SET NULL,
  rationale text,
  -- Claims that triggered/support this proposal. Lets the reviewer see the
  -- evidence, and lets several claims coalesce into one approval prompt.
  claim_ids uuid[] NOT NULL DEFAULT '{}',
  claim_count integer NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
  -- Set when approved and the topic is actually created.
  created_topic_id uuid REFERENCES topics(id) ON DELETE SET NULL,
  decided_at timestamptz,
  decided_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One open proposal per name: repeat suggestions accumulate claims onto the
-- existing row rather than spawning duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS topic_proposals_pending_name_idx
  ON topic_proposals (lower(name)) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS topic_proposals_status_idx
  ON topic_proposals (status, claim_count DESC);

COMMENT ON TABLE topic_proposals IS
  'Pending new-topic suggestions awaiting human approval. Tagging never creates a top-level branch directly.';

-- ------------------------------------------------------------
-- 3. Holding state for claims with no good home
-- ------------------------------------------------------------

-- A claim whose subject has no reasonable existing topic is filed under its
-- best available parent and flagged, rather than forcing a new branch.
ALTER TABLE claims ADD COLUMN IF NOT EXISTS topic_fit text
  CHECK (topic_fit IN ('good', 'approximate', 'unfiled'));

CREATE INDEX IF NOT EXISTS claims_topic_fit_idx
  ON claims (topic_fit) WHERE topic_fit IS DISTINCT FROM 'good';

COMMENT ON COLUMN claims.topic_fit IS
  'How well the assigned topic actually fits: good = confident, approximate = filed under a broader parent, unfiled = no home yet.';
