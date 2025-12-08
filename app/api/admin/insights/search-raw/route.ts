/**
 * Search Raw Insights API Route
 * 
 * GET /api/admin/insights/search-raw?q=query&excludeUniqueId=uuid
 * 
 * Searches for raw insights that are not yet merged into a unique insight
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseServer'

export async function GET(request: NextRequest) {
  try {
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: 'Supabase not configured' },
        { status: 500 }
      )
    }

    const searchParams = request.nextUrl.searchParams
    const query = searchParams.get('q') || ''
    const excludeUniqueId = searchParams.get('excludeUniqueId')

    if (!query || query.trim().length === 0) {
      return NextResponse.json({ results: [] })
    }

    // Search for raw insights that match the query and are not merged
    let searchQuery = supabaseAdmin
      .from('insights')
      .select(`
        id,
        statement,
        confidence,
        source_id,
        sources!source_id(title)
      `)
      .is('unique_insight_id', null)
      .is('deleted_at', null)
      .ilike('statement', `%${query}%`)
      .limit(20)

    // If excludeUniqueId is provided, also exclude raw insights already linked to that unique
    if (excludeUniqueId) {
      // This is already handled by unique_insight_id IS NULL, but we could add more logic here
    }

    const { data: insights, error } = await searchQuery

    if (error) {
      return NextResponse.json(
        { error: `Search failed: ${error.message}` },
        { status: 500 }
      )
    }

    const results = (insights || []).map((insight: any) => ({
      id: insight.id,
      statement: insight.statement,
      sourceTitle: insight.sources?.title || 'Unknown Source',
      confidence: insight.confidence
    }))

    return NextResponse.json({ results })
  } catch (error) {
    console.error('Error in search-raw API:', error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}
