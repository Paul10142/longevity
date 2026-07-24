-- 014_flag_rules_extend.sql
--
-- Two more claim-flag rules (spec §7.2 gains a fifth; plus a manual lane).
--
-- STRICTLY ADDITIVE — widens two CHECKs, migrates nothing.
--
--   extraction_fidelity — a MEMBER INSIGHT of this claim asserts something its
--     source chunk does not support (spec §6.2). Measured at 15% on a 40-insight
--     sample 2026-07-24 and it is the highest-severity failure found: not a
--     dedup error but invented substance upstream of consolidation, which no
--     existing rule catches — merge_fidelity is numeric-only, and standalone
--     can't fire because an invented assertion reads perfectly clearly. Judged
--     per member insight against its chunk (~1 LLM call each).
--
--   manual — Paul (or a reviewer) flags a claim by hand, for anything the
--     automated rules miss. The review lane the "manual flag system" needs.
alter table claim_flags drop constraint if exists claim_flags_rule_check;
alter table claim_flags add constraint claim_flags_rule_check check (
  rule in ('standalone', 'merge_fidelity', 'contradiction', 'orphan_topic',
           'extraction_fidelity', 'manual')
);

-- A manual flag resolves through the same verbs, plus 'reworded' for the case
-- where a reviewer fixes the canonical text in place.
alter table claim_flags drop constraint if exists claim_flags_resolution_check;
alter table claim_flags add constraint claim_flags_resolution_check check (
  resolution in ('approved', 'edited', 'split', 'narrowed', 'archived',
                 'false_positive', 'reworded')
);

comment on constraint claim_flags_rule_check on claim_flags is
  'The five auto rules (§7.2, + extraction_fidelity from §6.2) plus a manual review lane.';
