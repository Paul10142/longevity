import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseServer'

/**
 * Export insights with full context for review
 * 
 * Query params:
 * - format: 'json' | 'csv' (default: 'json')
 * - sourceId: filter by specific source
 * - limit: max number of insights (default: 1000)
 * - includeChunks: include chunk content (default: false)
 */
export async function GET(request: NextRequest) {
  try {
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: 'Supabase not configured' },
        { status: 500 }
      )
    }

    const searchParams = request.nextUrl.searchParams
    const format = searchParams.get('format') || 'json'
    const sourceId = searchParams.get('sourceId')
    const limit = parseInt(searchParams.get('limit') || '1000')
    const includeChunks = searchParams.get('includeChunks') === 'true'

    // Build query - fetch insights with their sources and chunks
    let insights: any[] = []
    let error: any = null

    if (sourceId) {
      // Query from insight_sources when filtering by source
      const { data, error: queryError } = await supabaseAdmin
        .from('insight_sources')
        .select(`
          source_id,
          locator,
          start_ms,
          end_ms,
          insights (
            id,
            statement,
            context_note,
            evidence_type,
            qualifiers,
            confidence,
            importance,
            actionability,
            primary_audience,
            insight_type,
            has_direct_quote,
            direct_quote,
            tone,
            created_at,
            insight_sources (
              source_id,
              locator,
              start_ms,
              end_ms,
              sources (
                id,
                title,
                type,
                authors,
                date
              )
            )
          )
        `)
        .eq('source_id', sourceId)
        .is('insights.deleted_at', null)
        .limit(limit)

      // Transform the data structure
      insights = (data || []).map((item: any) => ({
        ...item.insights,
        insight_sources: item.insights?.insight_sources || [{
          source_id: item.source_id,
          locator: item.locator,
          start_ms: item.start_ms,
          end_ms: item.end_ms,
          sources: null // Will be populated from insight_sources
        }]
      }))
      
      // Sort by created_at in JavaScript (since we can't order by nested field in Supabase query)
      insights.sort((a: any, b: any) => {
        const aDate = a?.created_at ? new Date(a.created_at).getTime() : 0
        const bDate = b?.created_at ? new Date(b.created_at).getTime() : 0
        return bDate - aDate // Descending order (newest first)
      })
      
      error = queryError
    } else {
      // Query all insights
      const { data, error: queryError } = await supabaseAdmin
        .from('insights')
        .select(`
          id,
          statement,
          context_note,
          evidence_type,
          qualifiers,
          confidence,
          importance,
          actionability,
          primary_audience,
          insight_type,
          has_direct_quote,
          direct_quote,
          tone,
          created_at,
          insight_sources (
            source_id,
            locator,
            start_ms,
            end_ms,
            sources (
              id,
              title,
              type,
              authors,
              date
            )
          )
        `)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(limit)

      insights = data || []
      error = queryError
    }

    if (error) {
      throw new Error(`Failed to fetch insights: ${error.message}`)
    }

    // If chunks are requested, fetch them
    let chunksMap: Record<string, any> = {}
    if (includeChunks && insights) {
      const locators = new Set<string>()
      insights.forEach((insight: any) => {
        insight.insight_sources?.forEach((link: any) => {
          if (link.locator) {
            locators.add(link.locator)
          }
        })
      })

      if (locators.size > 0) {
        const { data: chunks } = await supabaseAdmin
          .from('chunks')
          .select('locator, content, source_id')
          .in('locator', Array.from(locators))

        chunks?.forEach((chunk: any) => {
          const key = `${chunk.source_id}-${chunk.locator}`
          chunksMap[key] = chunk.content
        })
      }
    }

    // Transform data for export
    const exportData = insights?.map((insight: any) => {
      const sources = insight.insight_sources?.map((link: any) => ({
        sourceId: link.source_id,
        sourceTitle: link.sources?.title,
        sourceType: link.sources?.type,
        locator: link.locator,
        startMs: link.start_ms,
        endMs: link.end_ms,
        chunkContent: includeChunks 
          ? chunksMap[`${link.source_id}-${link.locator}`] 
          : undefined
      })) || []

      return {
        id: insight.id,
        statement: insight.statement,
        contextNote: insight.context_note,
        evidenceType: insight.evidence_type,
        confidence: insight.confidence,
        importance: insight.importance,
        actionability: insight.actionability,
        primaryAudience: insight.primary_audience,
        insightType: insight.insight_type,
        hasDirectQuote: insight.has_direct_quote,
        directQuote: insight.direct_quote,
        tone: insight.tone,
        qualifiers: insight.qualifiers,
        createdAt: insight.created_at,
        sources: sources,
        sourceCount: sources.length,
        firstSource: sources[0]?.sourceTitle || 'Unknown'
      }
    }) || []

    if (format === 'csv') {
      // Convert to CSV
      const headers = [
        'ID',
        'Statement',
        'Context Note',
        'Evidence Type',
        'Confidence',
        'Importance',
        'Actionability',
        'Primary Audience',
        'Insight Type',
        'Direct Quote',
        'Tone',
        'Population',
        'Dose',
        'Duration',
        'Outcome',
        'Effect Size',
        'Caveats',
        'Source Title',
        'Source Type',
        'Locator',
        'Created At'
      ]

      const rows = exportData.map((item: any) => [
        item.id,
        `"${(item.statement || '').replace(/"/g, '""')}"`,
        `"${(item.contextNote || '').replace(/"/g, '""')}"`,
        item.evidenceType,
        item.confidence,
        item.importance,
        item.actionability,
        item.primaryAudience,
        item.insightType,
        `"${(item.directQuote || '').replace(/"/g, '""')}"`,
        item.tone,
        `"${(item.qualifiers?.population || '').replace(/"/g, '""')}"`,
        `"${(item.qualifiers?.dose || '').replace(/"/g, '""')}"`,
        `"${(item.qualifiers?.duration || '').replace(/"/g, '""')}"`,
        `"${(item.qualifiers?.outcome || '').replace(/"/g, '""')}"`,
        `"${(item.qualifiers?.effect_size || '').replace(/"/g, '""')}"`,
        `"${(item.qualifiers?.caveats || '').replace(/"/g, '""')}"`,
        `"${(item.firstSource || '').replace(/"/g, '""')}"`,
        item.sources[0]?.sourceType || '',
        item.sources[0]?.locator || '',
        item.createdAt
      ])

      const csv = [
        headers.join(','),
        ...rows.map((row: any[]) => row.join(','))
      ].join('\n')

      return new NextResponse(csv, {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="insights-export-${new Date().toISOString().split('T')[0]}.csv"`
        }
      })
    }

    // Return JSON
    return NextResponse.json({
      count: exportData.length,
      exportedAt: new Date().toISOString(),
      insights: exportData
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="insights-export-${new Date().toISOString().split('T')[0]}.json"`
      }
    })

  } catch (error) {
    console.error('Export error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to export insights' },
      { status: 500 }
    )
  }
}

