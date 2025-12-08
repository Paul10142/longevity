/**
 * Merge Raw Insight Into Existing Unique Insight API Route
 * 
 * POST /api/admin/insights/merge-into-unique
 * 
 * Merges a raw insight into an existing unique insight
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseServer'

export async function POST(request: NextRequest) {
  try {
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: 'Supabase not configured' },
        { status: 500 }
      )
    }

    const body = await request.json()
    const { rawInsightId, uniqueInsightId } = body

    if (!rawInsightId || !uniqueInsightId) {
      return NextResponse.json(
        { error: 'rawInsightId and uniqueInsightId are required' },
        { status: 400 }
      )
    }

    // Verify raw insight exists and is not already merged
    const { data: rawInsight, error: rawError } = await supabaseAdmin
      .from('insights')
      .select('id, unique_insight_id')
      .eq('id', rawInsightId)
      .single()

    if (rawError || !rawInsight) {
      return NextResponse.json(
        { error: `Raw insight not found: ${rawError?.message}` },
        { status: 404 }
      )
    }

    if (rawInsight.unique_insight_id) {
      return NextResponse.json(
        { error: 'Raw insight is already merged into a unique insight' },
        { status: 400 }
      )
    }

    // Verify unique insight exists
    const { data: uniqueInsight, error: uniqueError } = await supabaseAdmin
      .from('unique_insights')
      .select('id')
      .eq('id', uniqueInsightId)
      .single()

    if (uniqueError || !uniqueInsight) {
      return NextResponse.json(
        { error: `Unique insight not found: ${uniqueError?.message}` },
        { status: 404 }
      )
    }

    // Link raw insight to unique insight
    const { error: updateError } = await supabaseAdmin
      .from('insights')
      .update({ unique_insight_id: uniqueInsightId })
      .eq('id', rawInsightId)

    if (updateError) {
      return NextResponse.json(
        { error: `Failed to merge raw insight: ${updateError.message}` },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      message: 'Raw insight merged into unique insight successfully'
    })
  } catch (error) {
    console.error('Error in merge-into-unique API:', error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
        details: error instanceof Error ? error.stack : undefined
      },
      { status: 500 }
    )
  }
}
