import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseServer'

/**
 * Export raw insights with their source context for offline review.
 *
 * v2: `raw_insights` carries `source_id` directly, so this is a single query
 * plus a lookup for the claim each insight was consolidated into.
 *
 * Query params:
 * - format: 'json' | 'csv' (default: 'json')
 * - sourceId: filter to one source
 * - limit: max rows (default: 1000)
 * - includeChunks: include the chunk text each insight came from (default: false)
 */
export async function GET(request: NextRequest) {
  try {
    if (!supabaseAdmin) {
      return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 })
    }

    const searchParams = request.nextUrl.searchParams
    const format = searchParams.get('format') || 'json'
    const sourceId = searchParams.get('sourceId')
    const limit = Math.min(parseInt(searchParams.get('limit') || '1000', 10) || 1000, 10000)
    const includeChunks = searchParams.get('includeChunks') === 'true'

    let query = supabaseAdmin
      .from('raw_insights')
      .select(`
        id, source_id, chunk_id, locator, start_ms, end_ms,
        statement, context_note, direct_quote,
        evidence_type, confidence, importance, actionability,
        primary_audience, insight_type, qualifiers, created_at,
        sources ( id, title, type, authors, date )
      `)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (sourceId) query = query.eq('source_id', sourceId)

    const { data: rows, error } = await query
    if (error) throw new Error(`Failed to fetch raw insights: ${error.message}`)
    const insights = rows || []

    // Claim membership: which canonical claim each raw insight rolled up into.
    const claimByInsightId = new Map<string, { id: string; statement: string; sourceCount: number }>()
    if (insights.length > 0) {
      const { data: members } = await supabaseAdmin
        .from('claim_members')
        .select('raw_insight_id, claims ( id, canonical_statement, source_count )')
        .in('raw_insight_id', insights.map((i: any) => i.id))
      members?.forEach((m: any) => {
        if (m.claims?.id) {
          claimByInsightId.set(m.raw_insight_id, {
            id: m.claims.id,
            statement: m.claims.canonical_statement,
            sourceCount: m.claims.source_count,
          })
        }
      })
    }

    const chunkContentById = new Map<string, string>()
    if (includeChunks && insights.length > 0) {
      const chunkIds = Array.from(
        new Set(insights.map((i: any) => i.chunk_id).filter(Boolean))
      ) as string[]
      if (chunkIds.length > 0) {
        const { data: chunks } = await supabaseAdmin
          .from('chunks')
          .select('id, content')
          .in('id', chunkIds)
        chunks?.forEach((c: any) => chunkContentById.set(c.id, c.content))
      }
    }

    const exportData = insights.map((i: any) => {
      const claim = claimByInsightId.get(i.id) ?? null
      return {
        id: i.id,
        statement: i.statement,
        contextNote: i.context_note,
        directQuote: i.direct_quote,
        evidenceType: i.evidence_type,
        confidence: i.confidence,
        importance: i.importance,
        actionability: i.actionability,
        primaryAudience: i.primary_audience,
        insightType: i.insight_type,
        qualifiers: i.qualifiers,
        createdAt: i.created_at,
        source: {
          id: i.source_id,
          title: i.sources?.title ?? null,
          type: i.sources?.type ?? null,
          authors: i.sources?.authors ?? null,
          date: i.sources?.date ?? null,
          locator: i.locator,
          startMs: i.start_ms,
          endMs: i.end_ms,
        },
        claim,
        chunkContent: includeChunks && i.chunk_id ? chunkContentById.get(i.chunk_id) ?? null : undefined,
      }
    })

    if (format === 'csv') {
      const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
      const headers = [
        'ID', 'Statement', 'Context Note', 'Direct Quote',
        'Evidence Type', 'Confidence', 'Importance', 'Actionability',
        'Primary Audience', 'Insight Type',
        'Population', 'Dose', 'Duration', 'Outcome', 'Effect Size', 'Caveats',
        'Source Title', 'Source Type', 'Locator',
        'Claim ID', 'Claim Source Count', 'Created At',
      ]
      const rowsCsv = exportData.map((item: any) => [
        q(item.id), q(item.statement), q(item.contextNote), q(item.directQuote),
        q(item.evidenceType), q(item.confidence), q(item.importance), q(item.actionability),
        q(item.primaryAudience), q(item.insightType),
        q(item.qualifiers?.population), q(item.qualifiers?.dose), q(item.qualifiers?.duration),
        q(item.qualifiers?.outcome), q(item.qualifiers?.effect_size), q(item.qualifiers?.caveats),
        q(item.source.title), q(item.source.type), q(item.source.locator),
        q(item.claim?.id), q(item.claim?.sourceCount), q(item.createdAt),
      ])

      const csv = [headers.map(q).join(','), ...rowsCsv.map((r: string[]) => r.join(','))].join('\n')

      return new NextResponse(csv, {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="insights-export-${new Date().toISOString().split('T')[0]}.csv"`,
        },
      })
    }

    return NextResponse.json(
      { count: exportData.length, exportedAt: new Date().toISOString(), insights: exportData },
      {
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="insights-export-${new Date().toISOString().split('T')[0]}.json"`,
        },
      }
    )
  } catch (error) {
    console.error('Export error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to export insights' },
      { status: 500 }
    )
  }
}
