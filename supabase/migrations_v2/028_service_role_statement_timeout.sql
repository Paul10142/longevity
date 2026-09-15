-- 028_service_role_statement_timeout.sql
-- Stops the admin pages failing as the corpus grows.
--
-- admin_source_list() (migration 019) takes ~6.0-7.1s at 567 sources against
-- the 8s statement_timeout that service_role was inheriting from
-- `authenticator`. It has already returned `57014 canceling statement due to
-- statement timeout` once in testing. Commit 9fd9ecc introduced that function
-- to fix exactly this failure at 249 sources; the corpus has since more than
-- doubled and is back at the cliff edge.
--
-- This raises the ceiling for the server-side role only. anon (3s) and
-- authenticated (8s) have their own explicit, tighter settings and are
-- deliberately left alone, so nothing internet-facing gets a longer window to
-- hold a connection.
alter role service_role set statement_timeout = '30s';

-- PostgREST caches role settings; without this the change only takes effect on
-- new connections.
notify pgrst, 'reload config';

-- VERIFIED AFTER APPLYING (2026-09-15), via a temporary _timeout_probe()
-- function called over REST and then dropped:
--   * service_role sees effective statement_timeout = 30s (PostgREST does
--     apply per-role settings on role switch, which is worth knowing -- the
--     setting would be inert if it did not).
--   * anon still 3s, authenticated still 8s, authenticator still 8s.
--   * admin_source_list() over REST: 7.09s / 5.98s / 7.09s, all HTTP 200.
--   * migration 027's lockdown still holds: anon gets 42501 on
--     fidelity_labels and rpc/stale_topics.
--
-- THIS IS HEADROOM, NOT A FIX. The query is still O(transcript bytes): it
-- regexp-splits all 19 MB of transcripts on every call to compute word counts.
-- At the current growth rate it will reach 30s too. The real fix is to
-- materialise word_count on `sources` at ingest so the RPC becomes a plain
-- scan and join -- tracked separately.
