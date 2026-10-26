-- 035_ask_backend.sql
--
-- "Ask the Library" can now be answered on Paul's Claude subscription instead of
-- the Anthropic API (docs/ask-the-library-design.md §5.1, LLM_BACKEND=claude-code
-- when he runs the app on his Mac). The log needs to say which one wrote each
-- answer, so /admin/ask can tell the two apart and cost reports stay honest:
-- a subscription answer is recorded at $0 and has no token counts.
--
-- STRICTLY ADDITIVE: one defaulted column; every existing row reads 'api'.
-- Safe to apply while an extraction run is live.

alter table public.ask_answers
  add column if not exists backend text not null default 'api'
  check (backend in ('api', 'claude-code'));

comment on column public.ask_answers.backend is
  'Which backend wrote the answer: api (Anthropic API, billed per token) or claude-code (local claude CLI on a developer subscription, $0, no token counts).';

notify pgrst, 'reload schema';
