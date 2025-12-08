/**
 * Merge API Route
 * 
 * POST /api/admin/insights/merge
 * 
 * Creates a unique insight from selected raw insights in a cluster
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
    const { clusterId, selectedRawIds, canonicalRawId } = body

    if (!clusterId || !selectedRawIds || !Array.isArray(selectedRawIds) || selectedRawIds.length === 0) {
      return NextResponse.json(
        { error: 'clusterId, selectedRawIds (array), and canonicalRawId are required' },
        { status: 400 }
      )
    }

    if (!canonicalRawId) {
      return NextResponse.json(
        { error: 'canonicalRawId is required' },
        { status: 400 }
      )
    }

    // Verify canonical is in selected list
    if (!selectedRawIds.includes(canonicalRawId)) {
      return NextResponse.json(
        { error: 'canonicalRawId must be in selectedRawIds' },
        { status: 400 }
      )
    }

    // Fetch canonical raw insight
    const { data: canonicalRaw, error: canonicalError } = await supabaseAdmin
      .from('insights')
      .select('id, statement, source_id')
      .eq('id', canonicalRawId)
      .single()

    if (canonicalError || !canonicalRaw) {
      return NextResponse.json(
        { error: `Canonical insight not found: ${canonicalError?.message}` },
        { status: 404 }
      )
    }

    // Create unique_insights row
    const { data: uniqueInsert, error: uniqueError } = await supabaseAdmin
      .from('unique_insights')
      .insert({
        canonical_statement: canonicalRaw.statement,
        canonical_raw_id: canonicalRaw.id,
        canonical_source_id: canonicalRaw.source_id
      })
      .select('id')
      .single()

    if (uniqueError || !uniqueInsert) {
      return NextResponse.json(
        { error: `Failed to create unique insight: ${uniqueError?.message}` },
        { status: 500 }
      )
    }

    const uniqueId = uniqueInsert.id

    // Update selected raw insights to map to this unique insight
    const { error: updateError } = await supabaseAdmin
      .from('insights')
      .update({ unique_insight_id: uniqueId })
      .in('id', selectedRawIds)

    if (updateError) {
      // Try to clean up the unique insight
      await supabaseAdmin
        .from('unique_insights')
        .delete()
        .eq('id', uniqueId)

      return NextResponse.json(
        { error: `Failed to update raw insights: ${updateError.message}` },
        { status: 500 }
      )
    }

    // Mark cluster as approved
    const { error: clusterError } = await supabaseAdmin
      .from('merge_clusters')
      .update({ status: 'approved' })
      .eq('id', clusterId)

    if (clusterError) {
      console.error('Failed to mark cluster as approved:', clusterError)
      // Don't fail the request - the merge succeeded
    }

    // Update cluster members' is_selected based on what was actually merged
    // Mark unselected members as not selected
    const { data: allMembers } = await supabaseAdmin
      .from('merge_cluster_members')
      .select('raw_insight_id')
      .eq('cluster_id', clusterId)

    const unselectedIds = (allMembers || [])
      .map((m: any) => m.raw_insight_id)
      .filter((id: string) => !selectedRawIds.includes(id))

    if (unselectedIds.length > 0) {
      const { error: membersError } = await supabaseAdmin
        .from('merge_cluster_members')
        .update({ is_selected: false })
        .eq('cluster_id', clusterId)
        .in('raw_insight_id', unselectedIds)

      if (membersError) {
        console.error('Failed to update cluster members:', membersError)
        // Don't fail the request
      }
    }

    return NextResponse.json({
      success: true,
      uniqueInsightId: uniqueId,
      message: `Created unique insight from ${selectedRawIds.length} raw insights`
    })
  } catch (error) {
    console.error('Error in merge API:', error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
        details: error instanceof Error ? error.stack : undefined
      },
      { status: 500 }
    )
  }
}
