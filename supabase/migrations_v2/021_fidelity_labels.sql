-- 021: fidelity_labels — Paul's gold rulings for the extraction-fidelity judge.
-- (Applied to the live DB 2026-08-14 via MCP.)
--
-- Replaces the static worksheet's localStorage so labels survive across
-- devices/browsers and future labeling rounds accumulate in one place.
-- Read/written by /admin/fidelity via /api/admin/fidelity; the export shape
-- matches eval/extraction-goldset.json (evalExtraction.ts `score`).
create table if not exists fidelity_labels (
  pair_id text primary key,
  label text not null check (label in ('FAITHFUL','ADDED_DETAIL','DROPPED_QUALIFIER','UNRESOLVED_REFERENCE')),
  labeled_by text not null default 'paul',
  rationale text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table fidelity_labels is 'Human gold labels for extraction-fidelity pairs (certifies the LLM judge; see /admin/fidelity).';
