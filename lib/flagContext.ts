/**
 * Reads for the flagged-claim review screen: one flag in, everything a reviewer
 * needs to rule on it out. Read-only; the shaping is in lib/flagReview.ts.
 *
 * The judge (lib/extractionFidelity.ts) read ONE member insight of the claim
 * against its source chunk and stored that insight's statement in
 * `evidence.statement`. We find the member by that statement so the transcript we
 * show is the passage the judge actually read; if no member matches (the insight
 * was reworded since) we fall back to the claim's earliest member and say so.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { buildFlagContext, type FlagContext, type FlagContextInput } from './flagReview'

type MemberRow = NonNullable<FlagContextInput['member']> & { chunk_id: string | null; source_id: string }

export async function loadFlagContext(db: SupabaseClient, flagId: string): Promise<FlagContext | null> {
  const { data: flag, error: fErr } = await db
    .from('claim_flags')
    .select('id, claim_id, rule, detail, evidence, claims(canonical_statement)')
    .eq('id', flagId)
    .maybeSingle()
  if (fErr) throw new Error(fErr.message)
  if (!flag) return null
  const f = flag as unknown as {
    id: string; claim_id: string; rule: string; detail: string | null
    evidence: Record<string, unknown> | null
    claims: { canonical_statement: string } | null
  }

  const { data: links, error: mErr } = await db
    .from('claim_members')
    .select('raw_insights(id, statement, start_ms, direct_quote, quote_char_start, quote_char_end, speaker, chunk_id, source_id, created_at)')
    .eq('claim_id', f.claim_id)
  if (mErr) throw new Error(mErr.message)
  const members = ((links ?? []) as unknown as { raw_insights: (MemberRow & { created_at: string }) | null }[])
    .map(l => l.raw_insights)
    .filter((r): r is MemberRow & { created_at: string } => r !== null)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))

  const judgedText = typeof f.evidence?.statement === 'string' ? f.evidence.statement.trim() : null
  const matched = judgedText ? members.find(m => m.statement.trim() === judgedText) : undefined
  const member = matched ?? members[0] ?? null

  let source: FlagContextInput['source'] = null
  let chunk: FlagContextInput['chunk'] = null
  if (member) {
    const { data: src, error: sErr } = await db
      .from('sources')
      .select('id, title, date, series, episode_number, youtube_url, url, article_url, external_id, timed_transcript')
      .eq('id', member.source_id)
      .maybeSingle()
    if (sErr) throw new Error(sErr.message)
    source = (src as FlagContextInput['source']) ?? null

    if (member.chunk_id) {
      const { data: ch, error: cErr } = await db
        .from('chunks')
        .select('content, start_ms')
        .eq('id', member.chunk_id)
        .maybeSingle()
      if (cErr) throw new Error(cErr.message)
      chunk = (ch as FlagContextInput['chunk']) ?? null
    }
  }

  return buildFlagContext({
    flag: f,
    canonicalStatement: f.claims?.canonical_statement ?? '',
    member,
    memberMatched: Boolean(matched),
    memberCount: members.length,
    source,
    chunk,
  })
}
