-- 015 — Recency weighting in claim scoring (Paul's 2026-07-28 request).
-- ------------------------------------------------------------------------
-- "A more recent source should carry more weight — knowledge updates over
--  time, so a newer claim should outrank an older one when they compete."
--
-- Scope of THIS migration: the always-on recency signal only. It adds a bounded
-- recency bonus to the `topic_claims()` composite score, so within a topic the
-- newer of two similar claims surfaces first. It does NOT do conflict-scoped
-- "prefer the newer of two CONTRADICTING claims" — that needs the contradiction
-- path (adjudicator flag + `claim_links.kind='contradicts'` + a pairwise
-- tiebreak), which is designed in ARCHITECTURE.md and gated on Paul approving a
-- corpus re-consolidation. See the design note in BACKLOG.md.
--
-- Why bounded (0..8): the score's other terms are importance (≤30),
-- actionability (5..15), evidence (0..15), corroboration (≤10). An 8-point cap
-- makes recency a meaningful tiebreak among comparable claims but keeps it from
-- overriding a genuinely stronger/older claim (a well-corroborated RCT still
-- beats a fresh expert aside). Decay ≈1.5 pts/yr → 0 at ~5.3y. Tunable here.
--
-- "Same author" boost is intentionally NOT added to this global score: the whole
-- corpus is one author (Peter Attia), so an author-match term would add a
-- constant to every claim and change no ordering. Same-author-on-conflict is
-- part of the gated contradiction proposal, where it actually discriminates.
--
-- A claim's recency = the MAX source date across its member insights
-- (claim_members → raw_insights → sources.date). Claims with no dated source get
-- 0 (neutral). Correlated subquery: evaluated per claim in a topic subtree
-- (hundreds of rows), not corpus-wide, so cost is bounded.
--
-- Reversible: re-apply the pre-015 body (003 + 006 search_path) to revert.
-- Additive: no rows change; inert until synthesis reads the new ordering. The
-- public Evidence tab (which also calls topic_claims) will list newer claims
-- slightly higher — the only reader-visible effect today.

CREATE OR REPLACE FUNCTION public.topic_claims(
  p_topic_id uuid,
  p_audience text DEFAULT NULL::text,
  p_limit integer DEFAULT 250,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(
  id uuid, canonical_statement text, context_note text, best_evidence_type text,
  max_importance integer, actionability text, primary_audience text, insight_type text,
  qualifiers jsonb, member_count integer, source_count integer, score numeric
)
LANGUAGE sql STABLE
SET search_path TO 'public', 'extensions'
AS $function$
  WITH RECURSIVE tree AS (
    SELECT id FROM topics WHERE id = p_topic_id AND status = 'active'
    UNION
    SELECT t.id FROM topics t JOIN tree ON t.parent_id = tree.id WHERE t.status = 'active'
  ),
  topic_claim_ids AS (
    SELECT DISTINCT ct.claim_id FROM claim_topics ct JOIN tree ON ct.topic_id = tree.id
  )
  SELECT c.id, c.canonical_statement, c.context_note, c.best_evidence_type,
         c.max_importance, c.actionability, c.primary_audience, c.insight_type,
         c.qualifiers, c.member_count, c.source_count,
         (COALESCE(c.max_importance, 2) * 10
          + CASE c.actionability WHEN 'High' THEN 15 WHEN 'Low' THEN 5 ELSE 10 END
          + CASE c.best_evidence_type
              WHEN 'MetaAnalysis' THEN 15 WHEN 'RCT' THEN 12 WHEN 'Cohort' THEN 9
              WHEN 'CaseSeries' THEN 6 WHEN 'ExpertOpinion' THEN 0 ELSE 3 END
          + LEAST(c.source_count, 5) * 2
          -- recency bonus: 0..8, decaying ~1.5 pts/yr from the claim's newest source
          + COALESCE((
              SELECT GREATEST(0, 8.0 - (EXTRACT(EPOCH FROM (now() - MAX(s.date)::timestamptz)) / 31557600.0) * 1.5)
              FROM claim_members cm
              JOIN raw_insights ri ON ri.id = cm.raw_insight_id
              JOIN sources s ON s.id = ri.source_id
              WHERE cm.claim_id = c.id AND s.date IS NOT NULL
            ), 0)
         )::numeric AS score
  FROM claims c
  JOIN topic_claim_ids tci ON tci.claim_id = c.id
  WHERE c.status = 'active'
    AND (p_audience IS NULL OR c.primary_audience = 'Both'
         OR c.primary_audience = CASE WHEN p_audience = 'patient' THEN 'Patient' ELSE 'Clinician' END)
  ORDER BY score DESC, c.source_count DESC
  LIMIT p_limit OFFSET p_offset;
$function$;
