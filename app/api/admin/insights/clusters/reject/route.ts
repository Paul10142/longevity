/**
 * Reject Cluster API Route
 * 
 * POST /api/admin/insights/clusters/reject
 * 
 * Marks a cluster as rejected (insights remain unmerged)
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
    const { clusterId, status } = body

    if (!clusterId) {
      return NextResponse.json(
        { error: 'clusterId is required' },
        { status: 400 }
      )
    }

    // Mark cluster as rejected (or approved if status provided)
    const newStatus = status || 'rejected'
    const { error: clusterError } = await supabaseAdmin
      .from('merge_clusters')
      .update({ status: newStatus })
      .eq('id', clusterId)

    if (clusterError) {
      return NextResponse.json(
        { error: `Failed to reject cluster: ${clusterError.message}` },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      message: 'Cluster rejected'
    })
  } catch (error) {
    console.error('Error in reject cluster API:', error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
        details: error instanceof Error ? error.stack : undefined
      },
      { status: 500 }
    )
  }
}
