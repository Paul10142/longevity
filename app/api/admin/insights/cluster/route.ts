/**
 * Clustering API Routes
 * 
 * POST /api/admin/insights/cluster
 * - Auto-triggered after source processing
 * - Manual trigger for specific source/run
 * - Catch-up job for unclustered insights
 */

import { NextRequest, NextResponse } from 'next/server'
import { buildMergeClustersForNewInsights } from '@/lib/clustering'

/**
 * POST /api/admin/insights/cluster
 * 
 * Body options:
 * - { sourceId: string } - Cluster insights from a specific source
 * - { runId: string } - Cluster insights from a specific processing run
 * - { limit?: number } - Batch size (default 500)
 * - {} - Catch-up: cluster any unclustered insights
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}))
    const { sourceId, runId, limit } = body

    console.log('[Cluster API] Received request', { sourceId, runId, limit })

    const result = await buildMergeClustersForNewInsights({
      sourceId,
      runId,
      limit: limit ? Math.min(Math.max(1, limit), 1000) : undefined // Cap at 1000
    })

    return NextResponse.json({
      success: true,
      message: `Processed ${result.processed} insights, created ${result.clustersCreated} clusters`,
      result
    })
  } catch (error) {
    console.error('Error in clustering API:', error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
        details: error instanceof Error ? error.stack : undefined
      },
      { status: 500 }
    )
  }
}
