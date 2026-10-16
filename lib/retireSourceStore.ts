/**
 * Supabase implementation of RetireStore (lib/retireSource.ts). Every write is
 * idempotent; every query is the one scripts/retireSourceClaims.ts always ran.
 */
import type { ClaimState, InsightRow, MemberRow, RetireStore, SourceState, Survivor } from './retireSource'

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

export async function createSupabaseRetireStore(): Promise<RetireStore> {
  const { supabaseAdmin: db } = await import('./supabaseServer')
  if (!db) throw new Error('Supabase not configured')
  const { selectAllPaged } = await import('./pagination')
  const { recomputeAggregates, enrichClaimCanonical } = await import('./consolidation')
  const { generateEmbedding, insightEmbeddingText } = await import('./embeddings')

  const fail = (what: string, error: { message: string } | null) => { if (error) throw new Error(`${what}: ${error.message}`) }

  return {
    async countMembersOf(insightIds) {
      let n = 0
      for (const ids of chunk(insightIds, 200)) {
        const { count, error } = await db.from('claim_members').select('raw_insight_id', { count: 'exact', head: true }).in('raw_insight_id', ids)
        fail('claim_members count', error)
        n += count ?? 0
      }
      return n
    },

    async claimStates(claimIds) {
      const out: ClaimState[] = []
      for (const ids of chunk(claimIds, 100)) {
        const { data, error } = await db.from('claims').select('id, status, member_count, source_count').in('id', ids)
        fail('claims', error)
        const { data: vecs, error: e2 } = await db.from('claim_embeddings').select('claim_id').in('claim_id', ids)
        fail('claim_embeddings', e2)
        const withVector = new Set(((vecs ?? []) as { claim_id: string }[]).map(v => v.claim_id))
        const memberCounts = new Map<string, number>()
        const members = await selectAllPaged<{ claim_id: string; raw_insight_id: string }>((from, to) =>
          db.from('claim_members').select('claim_id, raw_insight_id').in('claim_id', ids).order('raw_insight_id').range(from, to)
        )
        for (const m of members) memberCounts.set(m.claim_id, (memberCounts.get(m.claim_id) ?? 0) + 1)
        for (const c of (data ?? []) as { id: string; status: string; member_count: number; source_count: number }[]) {
          out.push({ ...c, hasVector: withVector.has(c.id), members: memberCounts.get(c.id) ?? 0 })
        }
      }
      return out
    },

    async survivors(claimId, exceptSourceId) {
      const { data, error } = await db
        .from('claim_members')
        .select('raw_insight_id, raw_insights(source_id, statement, context_note, created_at)')
        .eq('claim_id', claimId)
      fail(`members of ${claimId}`, error)
      type Row = { raw_insight_id: string; raw_insights: { source_id: string; statement: string; context_note: string | null; created_at: string } | null }
      return ((data ?? []) as unknown as Row[])
        .filter(r => r.raw_insights && r.raw_insights.source_id !== exceptSourceId)
        .map(r => ({ raw_insight_id: r.raw_insight_id, ...(r.raw_insights as NonNullable<Row['raw_insights']>) }) as Survivor)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
    },

    async pendingReviewIds(reviewIds) {
      const out: string[] = []
      for (const ids of chunk(reviewIds, 100)) {
        const { data, error } = await db.from('merge_reviews').select('id').in('id', ids).eq('status', 'pending')
        fail('merge_reviews', error)
        out.push(...((data ?? []) as { id: string }[]).map(r => r.id))
      }
      return out
    },

    async pendingReviewsTouching(claimIds) {
      const out: string[] = []
      for (const ids of chunk(claimIds, 100)) {
        const { data, error } = await db.from('merge_reviews').select('id')
          .eq('status', 'pending').or(`claim_id.in.(${ids.join(',')}),candidate_claim_id.in.(${ids.join(',')})`)
        fail('merge_reviews', error)
        out.push(...((data ?? []) as { id: string }[]).map(r => r.id))
      }
      return out
    },

    async sourceState(sourceId): Promise<SourceState> {
      const { data, error } = await db.from('sources')
        .select('id, transcript_origin, processing_status, processing_error, last_processed_at').eq('id', sourceId).maybeSingle()
      fail('sources', error)
      const { count: insights, error: e1 } = await db.from('raw_insights').select('id', { count: 'exact', head: true }).eq('source_id', sourceId)
      fail('raw_insights count', e1)
      const { count: chunks, error: e2 } = await db.from('chunks').select('id', { count: 'exact', head: true }).eq('source_id', sourceId)
      fail('chunks count', e2)
      if (!data) return { exists: false, origin: null, insights: insights ?? 0, chunks: chunks ?? 0, cleared: false }
      const row = data as { transcript_origin: string; processing_status: string; processing_error: string | null; last_processed_at: string | null }
      const { count: withText, error: e3 } = await db.from('sources').select('id', { count: 'exact', head: true })
        .eq('id', sourceId).or('transcript.not.is.null,timed_transcript.not.is.null')
      fail('sources transcript', e3)
      const cleared = (withText ?? 0) === 0 && row.processing_status === 'pending' && row.processing_error == null && row.last_processed_at == null
      return { exists: true, origin: row.transcript_origin, insights: insights ?? 0, chunks: chunks ?? 0, cleared }
    },

    async existingInsightIds(insightIds) {
      const out: string[] = []
      for (const ids of chunk(insightIds, 200)) {
        const { data, error } = await db.from('raw_insights').select('id').in('id', ids)
        fail('raw_insights', error)
        out.push(...((data ?? []) as { id: string }[]).map(r => r.id))
      }
      return out
    },

    async membersOf(insightIds) {
      const out: { claim_id: string; raw_insight_id: string }[] = []
      for (const ids of chunk(insightIds, 200)) {
        const { data, error } = await db.from('claim_members').select('claim_id, raw_insight_id').in('raw_insight_id', ids)
        fail('claim_members', error)
        out.push(...((data ?? []) as { claim_id: string; raw_insight_id: string }[]))
      }
      return out
    },

    async listInsights(sourceId) {
      return selectAllPaged<InsightRow>((from, to) =>
        db.from('raw_insights').select('id, statement, context_note, direct_quote, chunk_id, created_at').eq('source_id', sourceId).order('id').range(from, to)
      )
    },

    async membersFull(insightIds) {
      const out: MemberRow[] = []
      for (const ids of chunk(insightIds, 200)) {
        const { data, error } = await db.from('claim_members').select('claim_id, raw_insight_id, matched_by, match_confidence').in('raw_insight_id', ids)
        fail('claim_members', error)
        out.push(...((data ?? []) as MemberRow[]))
      }
      return out
    },

    async claimsSnapshot(claimIds) {
      const out: unknown[] = []
      for (const ids of chunk(claimIds, 100)) {
        const { data } = await db.from('claims').select('id, status, canonical_statement, context_note, member_count, source_count, enriched_at').in('id', ids)
        out.push(...(data ?? []))
      }
      return out
    },

    // ---- writes ----
    async deleteMembersOf(insightIds) {
      const { error } = await db.from('claim_members').delete().in('raw_insight_id', insightIds)
      fail('unhook', error)
    },

    async retireClaims(claimIds) {
      const { error } = await db.from('claims').update({ status: 'retired', member_count: 0, source_count: 0 }).in('id', claimIds)
      fail('retire', error)
      const { error: e2 } = await db.from('claim_embeddings').delete().in('claim_id', claimIds)
      fail('retire vectors', e2)
    },

    async rederiveClaim(claimId, seed) {
      const { error } = await db.from('claims')
        .update({ canonical_statement: seed.statement, context_note: seed.context_note, needs_tagging: true })
        .eq('id', claimId)
      fail(`reseed ${claimId}`, error)
      await recomputeAggregates(claimId)
      const result = await enrichClaimCanonical(claimId)
      if (!result.changed) {
        // enrich only refreshes the vector when it rewrote the text; the seed
        // reset changed the text too, so refresh it here.
        const vector = await generateEmbedding(insightEmbeddingText({ statement: result.canonical, context_note: seed.context_note }))
        const { error: e3 } = await db.from('claim_embeddings')
          .upsert({ claim_id: claimId, embedding: vector, updated_at: new Date().toISOString() }, { onConflict: 'claim_id' })
        fail(`re-embed ${claimId}`, e3)
      }
    },

    async closeReviews(reviewIds) {
      // Only still-pending rows: a review closed earlier keeps its original decided_at.
      const { error } = await db.from('merge_reviews')
        .update({ status: 'rejected', decided_by: 'retired-source', decided_at: new Date().toISOString() })
        .in('id', reviewIds).eq('status', 'pending')
      fail('close reviews', error)
    },

    async deleteInsightsOf(sourceId) {
      const { error } = await db.from('raw_insights').delete().eq('source_id', sourceId)
      fail('delete insights', error)
    },
    async deleteChunksOf(sourceId) {
      const { error } = await db.from('chunks').delete().eq('source_id', sourceId)
      fail('delete chunks', error)
    },
    async deleteSourceRow(sourceId) {
      const { error } = await db.from('sources').delete().eq('id', sourceId)
      fail('delete source row', error)
    },
    async clearSourceRow(sourceId) {
      const { error } = await db.from('sources')
        .update({ transcript: null, timed_transcript: null, processing_status: 'pending', processing_error: null, last_processed_at: null })
        .eq('id', sourceId)
      fail('clear source row', error)
    },
  }
}
