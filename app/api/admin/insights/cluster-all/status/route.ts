/**
 * Cluster All Job Status API Route
 * 
 * GET /api/admin/insights/cluster-all/status
 * 
 * Returns the status of the most recent cluster-all job
 */

import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseServer'

export async function GET() {
  try {
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: 'Supabase not configured' },
        { status: 500 }
      )
    }

    // Get the most recent job
    const { data: recentJob, error: jobError } = await supabaseAdmin
      .from('cluster_jobs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    // PGRST116 = no rows returned, which is fine - just means no jobs yet
    if (jobError && jobError.code !== 'PGRST116') {
      console.error('Error fetching cluster job status:', jobError)
      return NextResponse.json(
        { error: 'Failed to fetch job status', details: jobError.message },
        { status: 500 }
      )
    }

    // Get counts of insights that need processing
    const { count: missingEmbeddings, error: embeddingsError } = await supabaseAdmin
      .from('insights')
      .select('*', { count: 'exact', head: true })
      .is('embedding', null)
      .is('deleted_at', null)

    if (embeddingsError) {
      console.error('Error counting missing embeddings:', embeddingsError)
    }

    const { count: unclusteredInsights, error: clusteringError } = await supabaseAdmin
      .from('insights')
      .select('*', { count: 'exact', head: true })
      .is('unique_insight_id', null)
      .is('deleted_at', null)
      .not('embedding', 'is', null)

    if (clusteringError) {
      console.error('Error counting unclustered insights:', clusteringError)
    }

    return NextResponse.json({
      currentJob: recentJob || null,
      needsEmbeddings: (missingEmbeddings || 0) > 0,
      missingEmbeddingsCount: missingEmbeddings || 0,
      needsClustering: (unclusteredInsights || 0) > 0,
      unclusteredInsightsCount: unclusteredInsights || 0
    })
  } catch (error) {
    console.error('Error in cluster-all status API:', error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}
