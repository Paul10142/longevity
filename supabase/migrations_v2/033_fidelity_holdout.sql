-- 033: fidelity_holdout — fact pairs each overnight run sets aside for Paul to label.
-- NOT YET APPLIED to the live DB. Apply it before the first run that uses --holdout (the run logs and carries on if the table is missing).
--
-- Paul, 2026-10-14 (option a): the faithfulness judge runs as the last step of every overnight
-- run, and a small sample (default 5) of the facts it judged is filed here for labelling at
-- /admin/fidelity, so the judge keeps being measured against human labels. Rulings go in
-- fidelity_labels (pair_id = 'holdout:<claim id>') exactly like the 40 original pairs.
-- Written by scripts/flagClaims.ts (fidelity --holdout N); read by /api/admin/fidelity.
create table if not exists fidelity_holdout (
  pair_id text primary key,                      -- 'holdout:<claim id>'
  claim_id uuid not null references claims(id) on delete cascade,
  source_title text not null default '',
  statement text not null,
  context_note text,
  direct_quote text,
  quote_verified boolean not null default false,
  chunk_text text not null,
  judge_verdict text not null,
  judge_offending text not null default '',
  judge_reasoning text not null default '',
  batch text not null,                           -- the run that set it aside, e.g. 2026-10-23T05:10:00Z
  created_at timestamptz not null default now()
);
create index if not exists fidelity_holdout_created_idx on fidelity_holdout (created_at desc);
comment on table fidelity_holdout is 'Judged fact pairs held out per overnight run for Paul to label at /admin/fidelity (labels live in fidelity_labels).';

-- Same posture as every other table (027): server-side secret key only.
alter table fidelity_holdout enable row level security;
revoke all on public.fidelity_holdout from anon, authenticated;
